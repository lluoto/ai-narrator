import {
  createPreparedCompilerArtifact,
  createResolvedCompilerArtifact,
  resolvePreparedCompilerArtifact,
  restoreCompilerArtifact,
  type CompilerArtifactEnvelope,
  type CompilerArtifactRefusal,
  type PreparedCompilerArtifactIdentity,
  type ResolvedCompilerArtifactIdentity,
} from "./compiler-artifact";
import { CompilerQuestionError, buildCompilerQuestionQueue, type CompilerQuestion, type ModuleCompileHints } from "./compiler-question-queue";
import { compileDeterministicTemplates } from "./deterministic-template-compiler";
import { buildSourceFactGraph, type SourceFactGraph } from "./source-fact-graph";
import { buildPreparedSourceFactDispositionReport } from "./source-fact-disposition";
import { cleanPagesWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR, type DocumentIR } from "../ingest/document-ir";
import { buildDocumentIR, PdfTextUnavailableError } from "../ingest/pdf-source";

export type CompilerSourceInput =
  | { kind: "synthetic_pages"; moduleId: string; sourceDescriptor: string; pages: string[] }
  | { kind: "pdf_bytes"; moduleId: string; pdfBytes: Uint8Array };

export type CompilerApiRefusalCode =
  | "PREPARE_INVALID_INPUT"
  | "PREPARE_PDF_INVALID"
  | "PDF_TEXT_UNAVAILABLE"
  | "PREPARE_FAILED"
  | "RESOLVE_ARTIFACT_INVALID"
  | "RESOLVE_PREPARED_ARTIFACT_REQUIRED"
  | "RESOLVE_QUEUE_HASH_MISMATCH"
  | "RESOLVE_MODULE_IDENTITY_MISMATCH"
  | "RESOLVE_DOCUMENT_IDENTITY_MISMATCH"
  | "RESOLVE_GRAPH_IDENTITY_MISMATCH"
  | "RESOLVE_HINTS_INVALID"
  | "RESOLVE_NOT_PUBLISHABLE"
  | "RESOLVE_FAILED";

export interface CompilerApiRefusal {
  status: "refused";
  stage: "prepare" | "resolve";
  code: CompilerApiRefusalCode;
  message: string;
  artifactCode?: CompilerArtifactRefusal["code"];
  causeCode?: string;
}

export interface PreparedCompilerApiResult {
  status: "prepared";
  identity: PreparedCompilerArtifactIdentity;
  artifact: CompilerArtifactEnvelope;
  questions: CompilerQuestion[];
}

export interface ResolvedCompilerApiResult {
  status: "resolved";
  identity: ResolvedCompilerArtifactIdentity;
  artifact: CompilerArtifactEnvelope;
}

export type CompilerPrepareResult = PreparedCompilerApiResult | CompilerApiRefusal;
export type CompilerResolveResult = ResolvedCompilerApiResult | CompilerApiRefusal;

export interface CompilerResolveInput {
  preparedArtifact: CompilerArtifactEnvelope;
  preparedQueueHash: string;
  hints: ModuleCompileHints;
}

function refusal(stage: CompilerApiRefusal["stage"], code: CompilerApiRefusalCode, error: unknown, artifactCode?: CompilerArtifactRefusal["code"]): CompilerApiRefusal {
  const candidate = error as { code?: unknown };
  return {
    status: "refused",
    stage,
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(artifactCode ? { artifactCode } : {}),
    ...(typeof candidate?.code === "string" ? { causeCode: candidate.code } : {}),
  };
}

function prepareFromDocument(moduleId: string, document: DocumentIR): PreparedCompilerApiResult {
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(cleanPagesWithTrace(document.pages)));
  const graph: SourceFactGraph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId });
  const preparedQueue = buildCompilerQuestionQueue(graph, draft);
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
  const payload = artifact.payload;
  return { status: "prepared", identity: payload.identity, artifact, questions: payload.preparedQueue.questions };
}

/** Prepare synthetic pages or original PDF bytes into a durable prepared artifact. */
export async function prepareCompilerArtifact(input: CompilerSourceInput): Promise<CompilerPrepareResult> {
  if (!input.moduleId.trim()) return refusal("prepare", "PREPARE_INVALID_INPUT", "moduleId is required");
  try {
    if (input.kind === "synthetic_pages") {
      if (!input.sourceDescriptor.trim() || input.pages.length === 0 || input.pages.every((page) => !page.trim())) {
        return refusal("prepare", "PREPARE_INVALID_INPUT", "synthetic pages require a nonblank sourceDescriptor and at least one nonblank page");
      }
      return prepareFromDocument(input.moduleId, createSyntheticDocumentIR([...input.pages], input.sourceDescriptor));
    }
    if (input.pdfBytes.length === 0) return refusal("prepare", "PREPARE_PDF_INVALID", "PDF bytes must be non-empty");
    return prepareFromDocument(input.moduleId, await buildDocumentIR(input.pdfBytes));
  } catch (error) {
    if (input.kind === "pdf_bytes" && error instanceof PdfTextUnavailableError) {
      return refusal("prepare", "PDF_TEXT_UNAVAILABLE", error);
    }
    return refusal("prepare", input.kind === "pdf_bytes" ? "PREPARE_PDF_INVALID" : "PREPARE_FAILED", error);
  }
}

/** Resolve only a restored prepared artifact; caller hints never bypass artifact validation. */
export function resolveCompilerArtifact(input: CompilerResolveInput): CompilerResolveResult {
  const restored = restoreCompilerArtifact(input.preparedArtifact);
  if (restored.status === "refused") return refusal("resolve", "RESOLVE_ARTIFACT_INVALID", restored.message, restored.code);
  if (restored.stage !== "prepared") return refusal("resolve", "RESOLVE_PREPARED_ARTIFACT_REQUIRED", "resolve requires a prepared artifact");
  const prepared = restored.payload;
  if (input.preparedQueueHash !== prepared.identity.preparedQueueHash) return refusal("resolve", "RESOLVE_QUEUE_HASH_MISMATCH", "preparedQueueHash does not match the restored artifact");
  if (input.hints.moduleId !== prepared.identity.moduleId) return refusal("resolve", "RESOLVE_MODULE_IDENTITY_MISMATCH", "hint moduleId does not match the restored artifact");
  if (input.hints.documentHash !== prepared.identity.documentHash) return refusal("resolve", "RESOLVE_DOCUMENT_IDENTITY_MISMATCH", "hint documentHash does not match the restored artifact");
  if (input.hints.sourceGraphIdentity !== prepared.identity.sourceGraphIdentity) return refusal("resolve", "RESOLVE_GRAPH_IDENTITY_MISMATCH", "hint sourceGraphIdentity does not match the restored artifact");
  try {
    const payload = resolvePreparedCompilerArtifact(prepared, input.hints);
    const artifact = createResolvedCompilerArtifact(payload);
    return { status: "resolved", identity: payload.identity, artifact };
  } catch (error) {
    if (error instanceof CompilerQuestionError) return refusal("resolve", "RESOLVE_HINTS_INVALID", error);
    const candidate = error as { code?: unknown };
    if (candidate?.code === "RESOLVED_NOT_CLOSED") return refusal("resolve", "RESOLVE_NOT_PUBLISHABLE", error);
    return refusal("resolve", "RESOLVE_FAILED", error);
  }
}

/** Supported concise facade aliases; the artifact-named functions remain explicit exports. */
export const prepareCompiler = prepareCompilerArtifact;

export function resolveCompiler(preparedArtifact: CompilerArtifactEnvelope, preparedQueueHash: string, hints: ModuleCompileHints): CompilerResolveResult {
  return resolveCompilerArtifact({ preparedArtifact, preparedQueueHash, hints });
}
