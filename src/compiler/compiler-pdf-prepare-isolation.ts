import { randomBytes } from "crypto";
import { join } from "path";
import {
  verifyPreparedCompilerArtifactEnvelope,
  type CompilerArtifactEnvelope,
  type PreparedCompilerArtifactIdentity,
} from "./compiler-artifact";
import type { DocumentIR } from "../ingest/document-ir";
import { sha256 } from "../ingest/document-ir";

/** Server-owned limits for public, untrusted PDF preparation. */
export const PDF_PREPARE_LIMITS = Object.freeze({
  maxRawPdfBytes: 8 * 1024 * 1024,
  maxModuleIdUtf8Bytes: 256,
  maxPages: 256,
  maxPageTextUtf8Bytes: 512 * 1024,
  maxTotalTextUtf8Bytes: 8 * 1024 * 1024,
  maxBlocks: 20_000,
  maxStatements: 20_000,
  maxCandidates: 8_192,
  maxQuestions: 8_192,
  maxArtifactUtf8Bytes: 16 * 1024 * 1024,
  extractDeadlineMs: 10_000,
  prepareDeadlineMs: 15_000,
  maxConcurrent: 1,
  maxQueue: 4,
  maxParserMessageUtf8Bytes: 24 * 1024 * 1024,
  maxValidatorMessageUtf8Bytes: 17 * 1024 * 1024,
  maxStderrUtf8Bytes: 64 * 1024,
});

export type PdfPrepareLimitKind =
  | "raw_pdf_bytes"
  | "module_id_utf8"
  | "pages"
  | "page_text_utf8"
  | "total_text_utf8"
  | "blocks"
  | "statements"
  | "candidates"
  | "questions"
  | "artifact_utf8"
  | "document_ipc_utf8"
  | "extract_deadline"
  | "prepare_deadline"
  | "ipc_input_utf8";

export type PdfPrepareWorkerReply =
  | { status: "document"; document: DocumentIR }
  | { status: "prepared"; nonce: string; artifact: CompilerArtifactEnvelope }
  | { status: "limit"; limitKind: PdfPrepareLimitKind }
  | { status: "text_unavailable" }
  | { status: "invalid" };

export interface PdfPrepareValidatorInput {
  moduleId: string;
  nonce: string;
  expectedDocumentHash: string;
  document: DocumentIR;
}

/** Runtime-private capability; TypeScript casts cannot manufacture a receipt. */
export type PrevalidatedPreparedReceipt = object;
const receiptArtifacts = new WeakMap<object, string>();

/** Catalogs may consume a receipt, but no exported function can mint one. */
export function consumePrevalidatedPreparedReceipt(receipt: unknown): CompilerArtifactEnvelope | undefined {
  if (!receipt || typeof receipt !== "object") return undefined;
  const serialized = receiptArtifacts.get(receipt);
  if (!serialized) return undefined;
  receiptArtifacts.delete(receipt);
  try { return JSON.parse(serialized) as CompilerArtifactEnvelope; } catch { return undefined; }
}

function mintPrevalidatedPreparedReceipt(artifact: CompilerArtifactEnvelope): PrevalidatedPreparedReceipt {
  const receipt = Object.freeze({});
  // The public result also exposes the artifact for the API facade.  Keep an
  // immutable canonical serialization behind the capability so user-land
  // cannot mutate a checked object between validation and catalog publication.
  receiptArtifacts.set(receipt, JSON.stringify(artifact));
  return receipt;
}

export type IsolatedPdfPrepareResult =
  | { status: "prepared"; receipt: PrevalidatedPreparedReceipt; artifact: CompilerArtifactEnvelope; identity: PreparedCompilerArtifactIdentity }
  | { status: "refused"; code: "PREPARE_RESOURCE_LIMIT_EXCEEDED"; limitKind: PdfPrepareLimitKind }
  | { status: "refused"; code: "PDF_TEXT_UNAVAILABLE" }
  | { status: "refused"; code: "PREPARE_PDF_INVALID" }
  | { status: "unavailable"; code: "PREPARE_ISOLATION_UNAVAILABLE" }
  | { status: "busy"; retryAfterSeconds: number };

type AdmissionResult = { status: "admitted"; release(): void } | { status: "busy" } | { status: "expired" } | { status: "aborted" };
interface Waiter { resolve(value: AdmissionResult): void; signal?: AbortSignal; deadline: number; timer: ReturnType<typeof setTimeout>; }

/** A bounded local queue protects the disposable-process budget. */
class PdfPrepareAdmission {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  acquire(signal: AbortSignal | undefined, deadline: number): Promise<AdmissionResult> {
    if (signal?.aborted) return Promise.resolve({ status: "aborted" });
    if (Date.now() >= deadline) return Promise.resolve({ status: "expired" });
    if (this.active < PDF_PREPARE_LIMITS.maxConcurrent) {
      this.active++;
      return Promise.resolve({ status: "admitted", release: () => this.release() });
    }
    if (this.waiters.length >= PDF_PREPARE_LIMITS.maxQueue) return Promise.resolve({ status: "busy" });
    return new Promise<AdmissionResult>((resolve) => {
      const waiter: Waiter = {
        resolve,
        signal,
        deadline,
        timer: setTimeout(() => this.remove(waiter, { status: "expired" }), Math.max(1, deadline - Date.now())),
      };
      signal?.addEventListener("abort", () => this.remove(waiter, { status: "aborted" }), { once: true });
      this.waiters.push(waiter);
    });
  }

  private remove(waiter: Waiter, result: AdmissionResult): void {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  private release(): void {
    this.active--;
    for (;;) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      if (waiter.signal?.aborted) { waiter.resolve({ status: "aborted" }); continue; }
      if (Date.now() >= waiter.deadline) { waiter.resolve({ status: "expired" }); continue; }
      this.active++;
      waiter.resolve({ status: "admitted", release: () => this.release() });
      return;
    }
  }
}

const admission = new PdfPrepareAdmission();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const workerPath = join(import.meta.dir, "compiler-pdf-prepare-worker.ts");

type ChildTermination = "abort" | "deadline" | "output" | undefined;
type ChildRun = { status: "ok"; stdout: Uint8Array } | { status: "terminated"; reason: Exclude<ChildTermination, undefined> } | { status: "unavailable" };

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, onOverflow: () => void): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { onOverflow(); throw new Error("child_output_limit"); }
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

async function runWorker(mode: "extract" | "validate", input: Uint8Array, outputLimit: number, deadline: number, requestSignal?: AbortSignal): Promise<ChildRun> {
  if (requestSignal?.aborted) return { status: "terminated", reason: "abort" };
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { status: "terminated", reason: "deadline" };
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let termination: ChildTermination;
  const terminate = (reason: Exclude<ChildTermination, undefined>): void => {
    termination ??= reason;
    if (child?.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* process already exited */ }
    }
  };
  const timeout = setTimeout(() => terminate("deadline"), remaining);
  const abort = () => terminate("abort");
  requestSignal?.addEventListener("abort", abort, { once: true });
  try {
    child = Bun.spawn([process.execPath, workerPath, mode], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: remaining,
      killSignal: "SIGKILL",
      windowsHide: true,
      // This is a secondary Bun guard only. readBounded below is the actual
      // asynchronous stream limit and explicitly kills/drains the child.
      maxBuffer: outputLimit + PDF_PREPARE_LIMITS.maxStderrUtf8Bytes,
    });
  } catch {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abort);
    return { status: "unavailable" };
  }
  const killForOutput = () => {
    terminate("output");
  };
  const awaitStopped = async (): Promise<void> => {
    if (child && child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* process already exited */ }
    }
    await child?.exited.catch(() => undefined);
  };
  try {
    if (!child) return { status: "unavailable" };
    child.stdin.write(input);
    await child.stdin.flush();
    child.stdin.end();
    const stdoutTask = readBounded(child.stdout, outputLimit, killForOutput);
    const stderrTask = readBounded(child.stderr, PDF_PREPARE_LIMITS.maxStderrUtf8Bytes, killForOutput);
    const exitedTask = child.exited;
    const settled = await Promise.allSettled([stdoutTask, stderrTask, exitedTask]);
    // Output overflow may reject before the OS reports process termination.
    // Do not release the sole admission slot until the process is dead and
    // both pipes have drained/closed.
    if (settled.some((entry) => entry.status === "rejected")) await awaitStopped();
    await Promise.allSettled([stdoutTask, stderrTask, exitedTask]);
    if (termination) return { status: "terminated", reason: termination };
    if (child.exitCode !== 0) return { status: "unavailable" };
    const stdout = settled[0];
    if (!stdout || stdout.status !== "fulfilled") return { status: "unavailable" };
    return { status: "ok", stdout: stdout.value };
  } catch {
    await awaitStopped();
    if (!termination) return { status: "unavailable" };
    return { status: "terminated", reason: termination };
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abort);
    await awaitStopped();
  }
}

type PdfPrepareWorkerRunner = (
  mode: "extract" | "validate",
  input: Uint8Array,
  outputLimit: number,
  deadline: number,
  requestSignal: AbortSignal | undefined,
  fallback: typeof runWorker,
) => Promise<ChildRun>;
let workerRunner: PdfPrepareWorkerRunner = (mode, input, outputLimit, deadline, requestSignal, fallback) => fallback(mode, input, outputLimit, deadline, requestSignal);

/**
 * Test-only fault seam.  It is intentionally absent from HTTP dependencies
 * and accepts no request-controlled value; production always retains the
 * concrete subprocess runner above.
 */
export function __replacePdfPrepareWorkerForTest(runner: PdfPrepareWorkerRunner): () => void {
  const previous = workerRunner;
  workerRunner = runner;
  return () => { workerRunner = previous; };
}

function parseWorkerReply(bytes: Uint8Array): PdfPrepareWorkerReply | undefined {
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const exact = (...keys: string[]) => Object.keys(record).length === keys.length && keys.every((key) => key in record);
  const limitKinds: readonly PdfPrepareLimitKind[] = [
    "raw_pdf_bytes", "module_id_utf8", "pages", "page_text_utf8", "total_text_utf8", "blocks", "statements", "candidates", "questions",
    "artifact_utf8", "document_ipc_utf8", "extract_deadline", "prepare_deadline", "ipc_input_utf8",
  ];
  if (record.status === "document" && exact("status", "document") && record.document && typeof record.document === "object") return value as PdfPrepareWorkerReply;
  if (record.status === "prepared" && exact("status", "nonce", "artifact") && typeof record.nonce === "string" && record.nonce.length > 0 && record.artifact && typeof record.artifact === "object") return value as PdfPrepareWorkerReply;
  if (record.status === "limit" && exact("status", "limitKind") && typeof record.limitKind === "string" && limitKinds.includes(record.limitKind as PdfPrepareLimitKind)) return value as PdfPrepareWorkerReply;
  if ((record.status === "text_unavailable" || record.status === "invalid") && exact("status")) return value as PdfPrepareWorkerReply;
  return undefined;
}

function resource(limitKind: PdfPrepareLimitKind): IsolatedPdfPrepareResult {
  return { status: "refused", code: "PREPARE_RESOURCE_LIMIT_EXCEEDED", limitKind };
}

function fromTermination(reason: Exclude<ChildTermination, undefined>, phase: "extract" | "prepare"): IsolatedPdfPrepareResult {
  if (reason === "deadline") return resource(phase === "extract" ? "extract_deadline" : "prepare_deadline");
  // A client disconnect is intentionally not presented as parser content.
  return { status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE" };
}

function exactPreparedIdentity(value: unknown, moduleId: string): value is PreparedCompilerArtifactIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4
    && typeof record.moduleId === "string" && record.moduleId === moduleId
    && (typeof record.documentHash === "string" || record.documentHash === null)
    && typeof record.sourceGraphIdentity === "string" && !!record.sourceGraphIdentity
    && typeof record.preparedQueueHash === "string" && /^[a-f0-9]{64}$/.test(record.preparedQueueHash);
}

/**
 * Run untrusted parser and full artifact validation outside the HTTP process.
 * Every process, every stream, and every queue position is bounded by the
 * server-owned constants above; request data cannot alter them.
 */
export async function prepareUntrustedPdfCompilerArtifact(moduleId: string, pdfBytes: Uint8Array, signal?: AbortSignal): Promise<IsolatedPdfPrepareResult> {
  const deadline = Date.now() + PDF_PREPARE_LIMITS.prepareDeadlineMs;
  if (pdfBytes.byteLength > PDF_PREPARE_LIMITS.maxRawPdfBytes) return resource("raw_pdf_bytes");
  if (!moduleId.trim()) return { status: "refused", code: "PREPARE_PDF_INVALID" };
  if (encoder.encode(moduleId).byteLength > PDF_PREPARE_LIMITS.maxModuleIdUtf8Bytes) return resource("module_id_utf8");
  // Hash before transferring bytes to the parser process.  Some pdf-parse
  // paths detach their input buffer; validator binding must never depend on
  // the parser's post-transfer view of it.
  const expectedDocumentHash = sha256(pdfBytes);
  const admitted = await admission.acquire(signal, deadline);
  if (admitted.status === "busy") return { status: "busy", retryAfterSeconds: 1 };
  if (admitted.status === "expired") return resource("prepare_deadline");
  if (admitted.status === "aborted") return { status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE" };
  try {
    const extractDeadline = Math.min(deadline, Date.now() + PDF_PREPARE_LIMITS.extractDeadlineMs);
    const extracted = await workerRunner("extract", pdfBytes, PDF_PREPARE_LIMITS.maxParserMessageUtf8Bytes, extractDeadline, signal, runWorker);
    if (extracted.status === "terminated") return fromTermination(extracted.reason, "extract");
    if (extracted.status === "unavailable") return { status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE" };
    const extractionReply = parseWorkerReply(extracted.stdout);
    if (!extractionReply) return { status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE" };
    if (extractionReply.status === "limit") return resource(extractionReply.limitKind);
    if (extractionReply.status === "text_unavailable") return { status: "refused", code: "PDF_TEXT_UNAVAILABLE" };
    if (extractionReply.status !== "document") return { status: "refused", code: "PREPARE_PDF_INVALID" };
    const nonce = randomBytes(32).toString("base64url");
    const validatorInput = encoder.encode(JSON.stringify({
      moduleId,
      nonce,
      expectedDocumentHash,
      document: extractionReply.document,
    } satisfies PdfPrepareValidatorInput));
    if (validatorInput.byteLength > PDF_PREPARE_LIMITS.maxParserMessageUtf8Bytes) return resource("ipc_input_utf8");
    const validated = await workerRunner("validate", validatorInput, PDF_PREPARE_LIMITS.maxValidatorMessageUtf8Bytes, deadline, signal, runWorker);
    if (validated.status === "terminated") return fromTermination(validated.reason, "prepare");
    if (validated.status === "unavailable") return { status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE" };
    const validatorReply = parseWorkerReply(validated.stdout);
    if (!validatorReply) return { status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE" };
    if (validatorReply.status === "limit") return resource(validatorReply.limitKind);
    if (validatorReply.status !== "prepared" || validatorReply.nonce !== nonce) return { status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE" };
    // This is deliberately a bounded envelope/hash/identity check only.  The
    // full restore/rebuild happened in the validator child, not on the server.
    const verified = verifyPreparedCompilerArtifactEnvelope(validatorReply.artifact);
    if (verified.status === "refused" || !exactPreparedIdentity(verified.identity, moduleId)) return { status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE" };
    return {
      status: "prepared",
      receipt: mintPrevalidatedPreparedReceipt(validatorReply.artifact),
      artifact: validatorReply.artifact,
      identity: verified.identity,
    };
  } finally {
    admitted.release();
  }
}
