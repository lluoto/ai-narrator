/**
 * Disposable worker for authenticated, untrusted PDF preparation.  It is not
 * an HTTP entry point.  The parent owns every limit and kills this process on
 * cancellation or expiry; this file never accepts limit overrides.
 */
import { createPreparedCompilerArtifact, restoreCompilerArtifact, serializeCompilerArtifact, type CompilerArtifactEnvelope } from "./compiler-artifact";
import { CompilerQuestionError, buildCompilerQuestionQueue } from "./compiler-question-queue";
import { compileDeterministicTemplates, type DraftModuleStructure } from "./deterministic-template-compiler";
import { buildPreparedSourceFactDispositionReport } from "./source-fact-disposition";
import { buildSourceFactGraph } from "./source-fact-graph";
import { cleanPagesWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { cleanPageText } from "../ingest/clean-text";
import { sha256, type DocumentIR } from "../ingest/document-ir";
import {
  PdfExtractionResourceLimitError,
  PdfTextUnavailableError,
  extractDocumentPagesBounded,
} from "../ingest/pdf-source";
import {
  PDF_PREPARE_LIMITS,
  type PdfPrepareLimitKind,
  type PdfPrepareWorkerReply,
  type PdfPrepareValidatorInput,
} from "./compiler-pdf-prepare-isolation";

const encoder = new TextEncoder();

class WorkerLimitError extends Error {
  constructor(readonly limitKind: PdfPrepareLimitKind) {
    super(limitKind);
    this.name = "WorkerLimitError";
  }
}

async function readStdinBounded(limit: number): Promise<Uint8Array> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new WorkerLimitError("ipc_input_utf8");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function reply(value: PdfPrepareWorkerReply, limit: number): Promise<void> {
  const encoded = encoder.encode(JSON.stringify(value));
  if (encoded.byteLength > limit) {
    // The parent will classify a killed/empty child as an isolation failure;
    // never spill a partial artifact or parser diagnostic to stderr.
    process.exitCode = 70;
    return;
  }
  await Bun.write(Bun.stdout, encoded);
}

function assertCount(count: number, limit: number, limitKind: PdfPrepareLimitKind): void {
  if (!Number.isSafeInteger(count) || count > limit) throw new WorkerLimitError(limitKind);
}

function candidateCount(draft: DraftModuleStructure): number {
  return draft.sceneCandidates.length
    + draft.clueCandidates.length
    + draft.clueFactAtoms.length
    + draft.sourceFactAtoms.length
    + draft.proseFactFindingCandidates.length
    + draft.itemCandidates.length
    + draft.rewardCandidates.length
    + draft.proseNpcAnchors.length
    + draft.interpretations.length;
}

function assertSourceLineBudget(document: DocumentIR): void {
  let lines = 0;
  for (const page of document.pages) {
    lines++;
    for (let index = 0; index < page.rawText.length; index++) {
      if (page.rawText[index] === "\n" && ++lines > PDF_PREPARE_LIMITS.maxBlocks) throw new WorkerLimitError("blocks");
    }
    if (lines > PDF_PREPARE_LIMITS.maxBlocks) throw new WorkerLimitError("blocks");
  }
}

function assertPotentialCandidateBudget(document: DocumentIR): void {
  let candidateBound = 0;
  for (const page of document.pages) {
    // Every physical line can become at least one structural candidate domain.
    if (++candidateBound > PDF_PREPARE_LIMITS.maxCandidates) throw new WorkerLimitError("candidates");
    for (let index = 0; index < page.rawText.length; index++) {
      if (page.rawText[index] === "\n" || ".!?;。！？；".includes(page.rawText[index]!)) {
        if (++candidateBound > PDF_PREPARE_LIMITS.maxCandidates) throw new WorkerLimitError("candidates");
      }
    }
  }
}

function buildPrepared(moduleId: string, document: DocumentIR): CompilerArtifactEnvelope {
  // Do this before cleanPagesWithTrace/splitTracedLines allocate one trace per
  // input line.  A newline bomb must not reach the block builder at all.
  assertSourceLineBudget(document);
  // Atom derivation is sentence-shaped.  Bound the raw potential before it
  // can allocate a million atom/candidate objects for one very long line.
  assertPotentialCandidateBudget(document);
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(cleanPagesWithTrace(document.pages)), { maxBlocks: PDF_PREPARE_LIMITS.maxBlocks });
  assertCount(blocks.length, PDF_PREPARE_LIMITS.maxBlocks, "blocks");
  // SourceFactGraph emits one whole statement plus optional marked-item name
  // and body statements.  Stop before it allocates those nested arrays.
  const potentialStatements = blocks.reduce((total, block) => total + 1 + Number(!!block.nameEvidence) + Number(!!block.bodyEvidence), 0);
  assertCount(potentialStatements, PDF_PREPARE_LIMITS.maxStatements, "statements");
  const graph = buildSourceFactGraph(document, blocks);
  assertCount(graph.statements.length, PDF_PREPARE_LIMITS.maxStatements, "statements");
  const draft = compileDeterministicTemplates(graph, { moduleId });
  assertCount(candidateCount(draft), PDF_PREPARE_LIMITS.maxCandidates, "candidates");
  let preparedQueue;
  try {
    preparedQueue = buildCompilerQuestionQueue(graph, draft, { maxQuestions: PDF_PREPARE_LIMITS.maxQuestions });
  } catch (error) {
    if (error instanceof CompilerQuestionError && error.code === "questions_limit_exceeded") throw new WorkerLimitError("questions");
    throw error;
  }
  assertCount(preparedQueue.questions.length, PDF_PREPARE_LIMITS.maxQuestions, "questions");
  const artifact = createPreparedCompilerArtifact({
    identity: {
      moduleId,
      documentHash: document.documentHash,
      sourceGraphIdentity: preparedQueue.sourceGraphIdentity,
      preparedQueueHash: preparedQueue.queueHash,
    },
    graph,
    draft,
    preparedQueue,
    sourceFactDispositionReport: buildPreparedSourceFactDispositionReport(graph, draft, preparedQueue),
  });
  if (encoder.encode(serializeCompilerArtifact(artifact)).byteLength > PDF_PREPARE_LIMITS.maxArtifactUtf8Bytes) {
    throw new WorkerLimitError("artifact_utf8");
  }
  // A parser process can never mint a receipt.  The validator must replay the
  // full restore/rebuild path and return that canonical result to its parent.
  const restored = restoreCompilerArtifact(artifact);
  if (restored.status !== "restored" || restored.stage !== "prepared") throw new Error("validator_restore_failed");
  const canonical = createPreparedCompilerArtifact(restored.payload);
  if (encoder.encode(serializeCompilerArtifact(canonical)).byteLength > PDF_PREPARE_LIMITS.maxArtifactUtf8Bytes) {
    throw new WorkerLimitError("artifact_utf8");
  }
  return canonical;
}

async function extract(): Promise<PdfPrepareWorkerReply> {
  const bytes = await readStdinBounded(PDF_PREPARE_LIMITS.maxRawPdfBytes);
  const pages = await extractDocumentPagesBounded(bytes, {
    maxPages: PDF_PREPARE_LIMITS.maxPages,
    maxPageTextUtf8Bytes: PDF_PREPARE_LIMITS.maxPageTextUtf8Bytes,
    maxTotalTextUtf8Bytes: PDF_PREPARE_LIMITS.maxTotalTextUtf8Bytes,
  });
  if (!pages.some((page) => cleanPageText(page.rawText).trim() !== "")) throw new PdfTextUnavailableError();
  const reply: PdfPrepareWorkerReply = {
    status: "document",
    document: {
      schemaVersion: "1.0.0",
      documentHash: pages[0]!.documentHash,
      hashSource: "pdf_bytes_sha256",
      pages,
    },
  };
  // JSON escaping can expand control-heavy text far beyond its UTF-8 source
  // budget.  Report that explicitly before stdout ever crosses its hard cap.
  if (encoder.encode(JSON.stringify(reply)).byteLength > PDF_PREPARE_LIMITS.maxParserMessageUtf8Bytes) {
    throw new WorkerLimitError("document_ipc_utf8");
  }
  return reply;
}

function validatorInput(value: unknown): PdfPrepareValidatorInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PdfPrepareValidatorInput>;
  if (typeof candidate.moduleId !== "string" || !candidate.moduleId.trim() || typeof candidate.nonce !== "string" || !candidate.nonce
    || typeof candidate.expectedDocumentHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.expectedDocumentHash)
    || !candidate.document || typeof candidate.document !== "object") return undefined;
  return candidate as PdfPrepareValidatorInput;
}

/** Bind validator work to raw bytes independently hashed by the parent. */
function validateParserDocument(document: DocumentIR, expectedDocumentHash: string): void {
  if (document.documentHash !== expectedDocumentHash || document.hashSource !== "pdf_bytes_sha256" || !Array.isArray(document.pages)
    || document.pages.length === 0 || document.pages.length > PDF_PREPARE_LIMITS.maxPages) throw new Error("parser_document_identity_mismatch");
  let totalBytes = 0;
  for (const [index, page] of document.pages.entries()) {
    if (!page || page.pageNumber !== index + 1 || typeof page.rawText !== "string"
      || page.rawTextHash !== sha256(page.rawText) || page.documentHash !== expectedDocumentHash || page.hashSource !== "pdf_bytes_sha256") {
      throw new Error("parser_document_page_mismatch");
    }
    const pageBytes = encoder.encode(page.rawText).byteLength;
    if (pageBytes > PDF_PREPARE_LIMITS.maxPageTextUtf8Bytes) throw new WorkerLimitError("page_text_utf8");
    totalBytes += pageBytes;
    if (totalBytes > PDF_PREPARE_LIMITS.maxTotalTextUtf8Bytes) throw new WorkerLimitError("total_text_utf8");
  }
}

async function validate(): Promise<PdfPrepareWorkerReply> {
  const body = await readStdinBounded(PDF_PREPARE_LIMITS.maxParserMessageUtf8Bytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(body)); } catch { return { status: "invalid" }; }
  const input = validatorInput(value);
  if (!input) return { status: "invalid" };
  validateParserDocument(input.document, input.expectedDocumentHash);
  const artifact = buildPrepared(input.moduleId, input.document);
  const reply: PdfPrepareWorkerReply = { status: "prepared", nonce: input.nonce, artifact };
  if (encoder.encode(JSON.stringify(reply)).byteLength > PDF_PREPARE_LIMITS.maxValidatorMessageUtf8Bytes) {
    throw new WorkerLimitError("artifact_utf8");
  }
  return reply;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  try {
    if (mode === "extract") return await reply(await extract(), PDF_PREPARE_LIMITS.maxParserMessageUtf8Bytes);
    if (mode === "validate") return await reply(await validate(), PDF_PREPARE_LIMITS.maxValidatorMessageUtf8Bytes);
    process.exitCode = 64;
  } catch (error) {
    if (error instanceof PdfExtractionResourceLimitError) return await reply({ status: "limit", limitKind: error.limitKind }, PDF_PREPARE_LIMITS.maxParserMessageUtf8Bytes);
    if (error instanceof WorkerLimitError) return await reply({ status: "limit", limitKind: error.limitKind }, PDF_PREPARE_LIMITS.maxValidatorMessageUtf8Bytes);
    if (error instanceof PdfTextUnavailableError) return await reply({ status: "text_unavailable" }, PDF_PREPARE_LIMITS.maxParserMessageUtf8Bytes);
    return await reply({ status: "invalid" }, PDF_PREPARE_LIMITS.maxValidatorMessageUtf8Bytes);
  }
}

void main();
