/**
 * Opt-in quality probe for two locally supplied modules.
 *
 * This script has deliberately narrow authority.  It never creates a public
 * compiler endpoint, saves an artifact, prints a provider endpoint/key/prompt
 * or model reply, and it refuses to send any source-derived proposal envelope
 * unless the caller authorizes the SHA-256 of *each* local document.
 *
 * Safe modes:
 *   bun scripts/real-model-two-module-acceptance.ts --offline
 *   bun scripts/real-model-two-module-acceptance.ts --prepare
 *
 * A live run is an explicit source-upload decision, not an implication of
 * having an API key in the environment:
 *   bun scripts/real-model-two-module-acceptance.ts --live \
 *     --allow-upload-sha256 <fuzu-pdf-sha256> \
 *     --allow-upload-sha256 <barn-pdf-sha256>
 *
 * `--prepare` parses the PDFs locally and emits only hashes/counts. `--live`
 * sends bounded *proposal envelopes* derived from their source evidence to the
 * configured OpenAI-compatible provider; it never uploads either PDF file.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { orchestratePreparedAutoCompiler, type AutoCompilerOrchestratorResult } from "../src/api/compiler-auto-orchestrator";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../src/compiler/compiler-api";
import type { ResolvedCompilerArtifactPayload } from "../src/compiler/compiler-artifact";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type ModuleCompileHints } from "../src/compiler/compiler-question-queue";
import { replayMechanicsWitness } from "../src/compiler/mechanics-reachability";
import { sha256 } from "../src/ingest/document-ir";
import { LLMClient, LLMClientError, type ChatOptions, type LLMLike, type Message } from "../src/llm/client";
import { isUsableLlmApiKey, llmDisabledByOverride } from "../src/llm/enabled";
import { loadConfig } from "../src/config";

export const REAL_MODEL_TWO_MODULE_SCHEMA_VERSION = "1.0.0";
export const REAL_MODEL_MAX_MODULE_JOB_MS = 120_000;
export const REAL_MODEL_MAX_CALL_MS = 15_000;
export const REAL_MODEL_MAX_CALLS_PER_MODULE = 16;
export const REAL_MODEL_PROPOSAL_LIMITS = Object.freeze({
  maxQuestionsPerRequest: 3,
  maxRequestsPerRound: 8,
  maxRequestChars: 24_000,
  // This pilot's complete system+user request budget is explicit; the
  // envelope cap above remains a separate source-contract bound.
  maxPromptChars: 24_000,
  maxResponseTokens: 2_400,
});
export const REAL_MODEL_MAX_PROPOSAL_ROUNDS = 2;

export type RealModelAcceptanceMode = "offline" | "prepare" | "live";

export interface RealModelDocument {
  id: "fuzu" | "barn";
  moduleId: string;
  path: string;
}

/** The two paths are local inputs; reports expose only the stable IDs. */
export const REAL_MODEL_DOCUMENTS: readonly RealModelDocument[] = Object.freeze([
  {
    id: "fuzu",
    moduleId: "real-model-fuzu",
    path: resolve(import.meta.dir, "..", "..", "[kp进阶推荐模组]复足.pdf"),
  },
  {
    id: "barn",
    moduleId: "real-model-barn",
    path: resolve(import.meta.dir, "..", "..", "MikuFan-普瑞米尔的谷仓", "普瑞米尔的谷仓 ver1.03.pdf"),
  },
]);

export type RealModelAcceptanceArgs =
  | { ok: true; mode: RealModelAcceptanceMode; allowedDocumentHashes: string[] }
  | { ok: false; code: "usage_invalid" | "upload_authorization_required" };

/** Parse only the small, explicit CLI contract. No environment value is read here. */
export function parseRealModelAcceptanceArgs(args: readonly string[]): RealModelAcceptanceArgs {
  let mode: RealModelAcceptanceMode | undefined;
  const allowedDocumentHashes: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--offline" || token === "--prepare" || token === "--live") {
      const candidate = token.slice(2) as RealModelAcceptanceMode;
      if (mode !== undefined) return { ok: false, code: "usage_invalid" };
      mode = candidate;
      continue;
    }
    if (token === "--allow-upload-sha256") {
      const hash = args[++index];
      if (!hash || !/^[a-f0-9]{64}$/.test(hash) || allowedDocumentHashes.includes(hash)) {
        return { ok: false, code: "usage_invalid" };
      }
      allowedDocumentHashes.push(hash);
      continue;
    }
    return { ok: false, code: "usage_invalid" };
  }
  if (!mode) return { ok: false, code: "usage_invalid" };
  if (mode !== "live" && allowedDocumentHashes.length) return { ok: false, code: "usage_invalid" };
  if (mode === "live" && allowedDocumentHashes.length === 0) {
    return { ok: false, code: "upload_authorization_required" };
  }
  return { ok: true, mode, allowedDocumentHashes };
}

/** A live invocation is authorized only when every exact local PDF hash is named. */
export function uploadsAreAuthorized(documentHashes: readonly string[], allowedDocumentHashes: readonly string[]): boolean {
  return documentHashes.length === REAL_MODEL_DOCUMENTS.length
    && new Set(documentHashes).size === documentHashes.length
    && documentHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash) && allowedDocumentHashes.includes(hash));
}

export class RealModelAcceptanceError extends Error {
  constructor(readonly code: "model_call_budget_exhausted" | "model_call_timeout" | "model_job_cancelled") {
    super(code);
    this.name = "RealModelAcceptanceError";
  }
}

export interface SanitizedModelCall {
  latencyMs: number;
  requestHash: string;
  responseHash?: string;
  errorCode?: string;
}

function mergeSignals(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const abort = () => controller.abort();
  if (live.some((signal) => signal.aborted)) controller.abort();
  else for (const signal of live) signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => { for (const signal of live) signal.removeEventListener("abort", abort); },
  };
}

function publicModelErrorCode(error: unknown): string {
  if (error instanceof RealModelAcceptanceError) return error.code;
  if (error instanceof LLMClientError) return `provider_${error.code}`;
  return "provider_failure";
}

/** Hash request data before the call, but never retain it beyond this stack. */
function requestHash(messages: readonly Message[], options: ChatOptions, timeoutMs: number): string {
  const publicOptions = {
    temperature: options.temperature ?? null,
    maxTokens: options.maxTokens ?? null,
    maxAttempts: 1,
    jsonMode: options.jsonMode ?? false,
    timeout: timeoutMs,
    workload: options.workload ?? "default",
  };
  return sha256(new TextEncoder().encode(JSON.stringify({ messages, options: publicOptions })));
}

/**
 * The wrapper keeps proposal text entirely in-process. It records only output
 * hashes, latency, and a small typed failure code, while enforcing the live
 * runner's tighter timeout/retry/call budget even if a future adapter widens
 * its own options.
 */
export class BudgetedRedactingLLM implements LLMLike {
  readonly calls: SanitizedModelCall[] = [];

  constructor(
    private readonly upstream: LLMLike,
    private readonly budget: { maxCalls?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ) {}

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const maxCalls = this.budget.maxCalls ?? REAL_MODEL_MAX_CALLS_PER_MODULE;
    const timeoutMs = Math.min(options.timeout ?? REAL_MODEL_MAX_CALL_MS, this.budget.timeoutMs ?? REAL_MODEL_MAX_CALL_MS);
    if (this.budget.signal?.aborted || options.signal?.aborted) throw new RealModelAcceptanceError("model_job_cancelled");
    if (this.calls.length >= maxCalls) throw new RealModelAcceptanceError("model_call_budget_exhausted");

    const startedAt = Date.now();
    const fingerprint = requestHash(messages, options, timeoutMs);
    const localTimeout = new AbortController();
    const combined = mergeSignals([this.budget.signal, options.signal, localTimeout.signal]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        localTimeout.abort();
        reject(new RealModelAcceptanceError("model_call_timeout"));
      }, timeoutMs);
    });
    try {
      // `messages` intentionally never enter `calls`, errors, or stdout.
      const response = await Promise.race([
        this.upstream.chat(messages, {
          ...options,
          timeout: timeoutMs,
          maxAttempts: 1,
          signal: combined.signal,
        }),
        deadline,
      ]);
      this.calls.push({ latencyMs: Date.now() - startedAt, requestHash: fingerprint, responseHash: sha256(new TextEncoder().encode(response)) });
      return response;
    } catch (error) {
      this.calls.push({ latencyMs: Date.now() - startedAt, requestHash: fingerprint, errorCode: publicModelErrorCode(error) });
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      combined.dispose();
    }
  }
}

/** Internal script-only input for the live harness; not a production API. */
export interface PreparedModule {
  document: RealModelDocument;
  documentHash: string;
  /** Exact locally-authorized bytes; never re-read after the hash gate. */
  pdfBytes: Uint8Array;
  prepared: PreparedCompilerApiResult;
}

export interface SanitizedModuleReport {
  module: "fuzu" | "barn";
  documentHash?: string;
  artifactHash?: string;
  status: "offline" | "prepared" | "draft_only" | "resolved" | "refused" | "not_authorized" | "document_unavailable" | "model_unavailable";
  code?: string;
  questions: { total: number; answered: number; open: number; deferred: number };
  accepted: number;
  model: { calls: number; latencyMs: number; requestHashes: string[]; responseHashes: string[]; errorCodes: string[] };
  diagnostics: SanitizedDiagnosticAggregate[];
  closed: boolean;
  witnesses: { declaredEndingWitnesses: number; replayedEndingWitnesses: number };
}

/** Public diagnostic summary: never carries a message, source-derived ID, or model output. */
export interface SanitizedDiagnosticAggregate {
  stage: "prepare" | "explicit_hints" | "proposal" | "merge" | "draft_snapshot" | "resolve" | "orchestrator" | "adapter_input" | "adapter_chunking" | "adapter_model" | "adapter_response" | "adapter_proposal" | "adapter_aggregate" | "other";
  code: string;
  count: number;
}

const PUBLIC_DIAGNOSTIC_STAGES = new Set<SanitizedDiagnosticAggregate["stage"]>([
  "prepare", "explicit_hints", "proposal", "merge", "draft_snapshot", "resolve", "orchestrator",
  "adapter_input", "adapter_chunking", "adapter_model", "adapter_response", "adapter_proposal", "adapter_aggregate", "other",
]);

const PUBLIC_ADAPTER_DIAGNOSTIC_STAGES = new Set([
  "input", "chunking", "model", "response", "proposal", "aggregate",
] as const);

/** Stable report codes only; new/internal codes collapse to `other` until reviewed. */
const PUBLIC_DIAGNOSTIC_CODES = new Set([
  "invalid_trusted_policy", "invalid_trusted_producer", "invalid_limit",
  "question_exceeds_request_limit", "question_exceeds_prompt_limit", "max_model_requests_reached", "operation_aborted", "llm_call_failed",
  "invalid_json", "invalid_response_root", "unexpected_root_field", "duplicate_question_proposal", "question_outside_chunk",
  "forbidden_proposal_field", "invalid_hint_value", "unknown_hint_reference", "missing_claim_citation", "unknown_claim_key", "invalid_citations",
  "source_fact_mechanic_kind_not_allowed", "prose_fact_finding_citations_forbidden", "npc_binding_requires_playable_scene", "proposal_compile_failed",
  "invalid_max_proposal_rounds", "prepared_artifact_required", "prepared_identity_mismatch", "explicit_hints_invalid",
  "proposal_round_no_progress", "proposal_merge_failed", "draft_snapshot_failed", "HINTS_INVALID",
  "RESOLVE_MODULE_IDENTITY_MISMATCH", "RESOLVE_UNANSWERED_QUESTIONS", "RESOLVE_INVALID_HINTS", "RESOLVE_MECHANICALLY_OPEN",
]);

export interface SanitizedAcceptanceReport {
  schemaVersion: typeof REAL_MODEL_TWO_MODULE_SCHEMA_VERSION;
  mode: RealModelAcceptanceMode;
  externalCalls: number;
  budgets: {
    maxModuleJobMs: number;
    maxCallMs: number;
    maxCallsPerModule: number;
    maxProposalRounds: number;
    maxQuestionsPerRequest: number;
    maxRequestsPerRound: number;
    maxRequestChars: number;
    maxPromptChars: number;
    maxResponseTokens: number;
  };
  modules: SanitizedModuleReport[];
  isolation: { comparedPairs: number; identityRefusals: number; uniqueModuleIds: number; uniqueDocumentHashes: number };
}

function blankModuleReport(module: SanitizedModuleReport["module"], status: SanitizedModuleReport["status"], code?: string): SanitizedModuleReport {
  return {
    module,
    status,
    ...(code ? { code } : {}),
    questions: { total: 0, answered: 0, open: 0, deferred: 0 },
    accepted: 0,
    model: { calls: 0, latencyMs: 0, requestHashes: [], responseHashes: [], errorCodes: [] },
    diagnostics: [],
    closed: false,
    witnesses: { declaredEndingWitnesses: 0, replayedEndingWitnesses: 0 },
  };
}

function sanitizedDiagnosticStage(diagnostic: Pick<AutoCompilerOrchestratorResult["diagnostics"][number], "stage" | "adapterStage">): SanitizedDiagnosticAggregate["stage"] {
  if (diagnostic.stage === "proposal" && diagnostic.adapterStage !== undefined) {
    return PUBLIC_ADAPTER_DIAGNOSTIC_STAGES.has(diagnostic.adapterStage)
      ? `adapter_${diagnostic.adapterStage}` as SanitizedDiagnosticAggregate["stage"]
      : "other";
  }
  return PUBLIC_DIAGNOSTIC_STAGES.has(diagnostic.stage as SanitizedDiagnosticAggregate["stage"])
    ? diagnostic.stage as SanitizedDiagnosticAggregate["stage"]
    : "other";
}

function aggregateDiagnostics(diagnostics: readonly Pick<AutoCompilerOrchestratorResult["diagnostics"][number], "stage" | "code" | "adapterStage">[]): SanitizedDiagnosticAggregate[] {
  const counts = new Map<string, SanitizedDiagnosticAggregate>();
  for (const diagnostic of diagnostics) {
    const stage = sanitizedDiagnosticStage(diagnostic);
    const code = PUBLIC_DIAGNOSTIC_CODES.has(diagnostic.code) ? diagnostic.code : "other";
    const key = `${stage}\u0000${code}`;
    const previous = counts.get(key);
    if (previous) previous.count++;
    else counts.set(key, { stage, code, count: 1 });
  }
  return [...counts.values()].sort((left, right) => left.stage.localeCompare(right.stage) || left.code.localeCompare(right.code));
}

function questionCounts(questions: readonly { status: string }[]) {
  return questions.reduce((counts, question) => {
    counts.total++;
    if (question.status === "answered") counts.answered++;
    else if (question.status === "open") counts.open++;
    else if (question.status === "deferred") counts.deferred++;
    return counts;
  }, { total: 0, answered: 0, open: 0, deferred: 0 });
}

function sanitizedModelSummary(llm: BudgetedRedactingLLM) {
  return {
    calls: llm.calls.length,
    latencyMs: llm.calls.reduce((total, call) => total + call.latencyMs, 0),
    requestHashes: llm.calls.map((call) => call.requestHash),
    responseHashes: llm.calls.flatMap((call) => call.responseHash ? [call.responseHash] : []),
    errorCodes: [...new Set(llm.calls.flatMap((call) => call.errorCode ? [call.errorCode] : []))].sort(),
  };
}

function replayResolvedWitnesses(payload: ResolvedCompilerArtifactPayload): { declaredEndingWitnesses: number; replayedEndingWitnesses: number; code?: string } {
  const witnesses = Object.values(payload.reachabilityReport.endingWitnesses);
  let replayedEndingWitnesses = 0;
  try {
    for (const witness of witnesses) {
      const state = replayMechanicsWitness(payload.mechanicsIR, payload.analysisInput, witness);
      if (state.terminalEndingId !== witness.final.id) return { declaredEndingWitnesses: witnesses.length, replayedEndingWitnesses, code: "witness_terminal_mismatch" };
      replayedEndingWitnesses++;
    }
    return { declaredEndingWitnesses: witnesses.length, replayedEndingWitnesses };
  } catch {
    return { declaredEndingWitnesses: witnesses.length, replayedEndingWitnesses, code: "witness_replay_failed" };
  }
}

function emptyHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: prepared.identity.moduleId,
    documentHash: prepared.identity.documentHash,
    sourceGraphIdentity: prepared.identity.sourceGraphIdentity,
    resolutions: [],
  };
}

/**
 * Prove both directions reject an otherwise structurally valid hint envelope
 * from the other document. This shares the real resolver identity checks; it
 * never creates a second isolation implementation.
 */
export function assertPreparedModuleIdentityIsolation(left: PreparedCompilerApiResult, right: PreparedCompilerApiResult): number {
  if (left.identity.moduleId === right.identity.moduleId
    || left.identity.sourceGraphIdentity === right.identity.sourceGraphIdentity
    // Synthetic-page fixtures intentionally have null documentHash. A null is
    // not a document identity and must not make two otherwise independent
    // module scopes look equal; real PDF runs below still require exact hashes.
    || (left.identity.documentHash !== null && right.identity.documentHash !== null
      && left.identity.documentHash === right.identity.documentHash)) {
    throw new Error("module_identity_not_distinct");
  }
  const leftIntoRight = resolveCompiler(right.artifact, right.identity.preparedQueueHash, emptyHints(left));
  const rightIntoLeft = resolveCompiler(left.artifact, left.identity.preparedQueueHash, emptyHints(right));
  if (leftIntoRight.status !== "refused" || leftIntoRight.code !== "RESOLVE_MODULE_IDENTITY_MISMATCH"
    || rightIntoLeft.status !== "refused" || rightIntoLeft.code !== "RESOLVE_MODULE_IDENTITY_MISMATCH") {
    throw new Error("cross_module_identity_not_refused");
  }
  return 2;
}

function preparedReport(module: PreparedModule): SanitizedModuleReport {
  return {
    ...blankModuleReport(module.document.id, "prepared"),
    documentHash: module.documentHash,
    artifactHash: module.prepared.artifact.artifactHash,
    questions: questionCounts(module.prepared.questions),
  };
}

async function prepareLocalDocument(document: RealModelDocument): Promise<PreparedModule | SanitizedModuleReport> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(document.path));
  } catch {
    return blankModuleReport(document.id, "document_unavailable", "document_unavailable");
  }
  const documentHash = sha256(bytes);
  const prepared = await prepareCompiler({ kind: "pdf_bytes", moduleId: document.moduleId, pdfBytes: bytes });
  if (prepared.status === "refused") {
    return {
      ...blankModuleReport(document.id, "refused", prepared.code),
      documentHash,
    };
  }
  return { document, documentHash, pdfBytes: bytes, prepared };
}

function isPreparedModule(value: PreparedModule | SanitizedModuleReport): value is PreparedModule {
  return "prepared" in value;
}

/** Internal script-only seam for the bounded live harness. */
export async function runLiveModule(module: PreparedModule, client: LLMLike, modelFingerprint: string): Promise<SanitizedModuleReport> {
  const job = new AbortController();
  const jobTimer = setTimeout(() => job.abort(), REAL_MODEL_MAX_MODULE_JOB_MS);
  const llm = new BudgetedRedactingLLM(client, { signal: job.signal });
  try {
    const result = await orchestratePreparedAutoCompiler({
      // This exact prepared artifact came from the hash-authorized bytes above.
      // Re-preparing parser-owned bytes would risk a detached buffer and create
      // a second, unnecessary source-processing path.
      prepared: module.prepared,
      llm,
      policy: {
        policyId: "real-model-two-module-quality-v1",
        rightsStatus: "user_provided",
        allowSourceExactNpcEncounters: true,
        allowedSourceFactMechanicKinds: ["existing_clue_discovery", "prose_fact_finding"],
      },
      // The source artifact is never published by this diagnostic. A hash of
      // the configured model is sufficient local provenance without printing
      // a provider name, endpoint, or model identifier.
      producer: {
        providerFingerprint: "real-provider-redacted-v1",
        modelFingerprint,
      },
      proposalLimits: REAL_MODEL_PROPOSAL_LIMITS,
      maxProposalRounds: REAL_MODEL_MAX_PROPOSAL_ROUNDS,
      signal: job.signal,
    });
    return reportAutoResult(module, result, llm);
  } catch (error) {
    return {
      ...blankModuleReport(module.document.id, "refused", publicModelErrorCode(error)),
      documentHash: module.documentHash,
      artifactHash: module.prepared.artifact.artifactHash,
      questions: questionCounts(module.prepared.questions),
      model: sanitizedModelSummary(llm),
    };
  } finally {
    clearTimeout(jobTimer);
  }
}

function reportAutoResult(module: PreparedModule, result: AutoCompilerOrchestratorResult, llm: BudgetedRedactingLLM): SanitizedModuleReport {
  if (result.status === "refused") {
    return {
      ...blankModuleReport(module.document.id, "refused", result.refusal?.code ?? result.diagnostics[0]?.code ?? "orchestrator_refused"),
      documentHash: module.documentHash,
      artifactHash: module.prepared.artifact.artifactHash,
      questions: questionCounts(module.prepared.questions),
      model: sanitizedModelSummary(llm),
      diagnostics: aggregateDiagnostics(result.diagnostics),
    };
  }
  const base = {
    documentHash: module.documentHash,
    artifactHash: module.prepared.artifact.artifactHash,
    questions: questionCounts(result.queue.questions),
    accepted: result.hints.resolutions.length,
    model: sanitizedModelSummary(llm),
    diagnostics: aggregateDiagnostics(result.diagnostics),
  };
  if (result.status === "draft_only") {
    return {
      ...blankModuleReport(module.document.id, "draft_only", result.resolveRefusal?.code ?? result.diagnostics.at(-1)?.code),
      ...base,
      closed: false,
    };
  }
  const payload = result.resolved.artifact.payload as ResolvedCompilerArtifactPayload;
  const witnesses = replayResolvedWitnesses(payload);
  return {
    ...blankModuleReport(module.document.id, "resolved", witnesses.code),
    ...base,
    artifactHash: result.resolved.artifact.artifactHash,
    closed: true,
    witnesses: {
      declaredEndingWitnesses: witnesses.declaredEndingWitnesses,
      replayedEndingWitnesses: witnesses.replayedEndingWitnesses,
    },
  };
}

function baseReport(mode: RealModelAcceptanceMode, modules: SanitizedModuleReport[], isolation: SanitizedAcceptanceReport["isolation"]): SanitizedAcceptanceReport {
  return {
    schemaVersion: REAL_MODEL_TWO_MODULE_SCHEMA_VERSION,
    mode,
    externalCalls: modules.reduce((total, module) => total + module.model.calls, 0),
    budgets: {
      maxModuleJobMs: REAL_MODEL_MAX_MODULE_JOB_MS,
      maxCallMs: REAL_MODEL_MAX_CALL_MS,
      maxCallsPerModule: REAL_MODEL_MAX_CALLS_PER_MODULE,
      maxProposalRounds: REAL_MODEL_MAX_PROPOSAL_ROUNDS,
      ...REAL_MODEL_PROPOSAL_LIMITS,
    },
    modules,
    isolation,
  };
}

/** Runs no model work in offline/prepare modes. This is the script's testable authority boundary. */
export async function runRealModelTwoModuleAcceptance(command: Extract<RealModelAcceptanceArgs, { ok: true }>): Promise<SanitizedAcceptanceReport> {
  if (command.mode === "offline") {
    return baseReport("offline", REAL_MODEL_DOCUMENTS.map((document) => blankModuleReport(document.id, "offline")), {
      comparedPairs: 0, identityRefusals: 0, uniqueModuleIds: 0, uniqueDocumentHashes: 0,
    });
  }

  if (command.mode === "live" && command.allowedDocumentHashes.length === 0) {
    return baseReport("live", REAL_MODEL_DOCUMENTS.map((document) => blankModuleReport(document.id, "not_authorized", "upload_authorization_required")), {
      comparedPairs: 0, identityRefusals: 0, uniqueModuleIds: 0, uniqueDocumentHashes: 0,
    });
  }

  const locallyPrepared = await Promise.all(REAL_MODEL_DOCUMENTS.map(prepareLocalDocument));
  const prepared = locallyPrepared.filter(isPreparedModule);
  const preparationReports = locallyPrepared.filter((entry): entry is SanitizedModuleReport => !isPreparedModule(entry));
  const isolation = prepared.length === REAL_MODEL_DOCUMENTS.length
    ? {
        comparedPairs: 1,
        identityRefusals: assertPreparedModuleIdentityIsolation(prepared[0]!.prepared, prepared[1]!.prepared),
        uniqueModuleIds: new Set(prepared.map((entry) => entry.prepared.identity.moduleId)).size,
        uniqueDocumentHashes: new Set(prepared.map((entry) => entry.documentHash)).size,
      }
    : { comparedPairs: 0, identityRefusals: 0, uniqueModuleIds: new Set(prepared.map((entry) => entry.prepared.identity.moduleId)).size, uniqueDocumentHashes: new Set(prepared.map((entry) => entry.documentHash)).size };

  if (command.mode === "prepare") {
    const reports = REAL_MODEL_DOCUMENTS.map((document) => {
      const current = prepared.find((entry) => entry.document.id === document.id);
      return current ? preparedReport(current) : preparationReports.find((entry) => entry.module === document.id)!;
    });
    return baseReport("prepare", reports, isolation);
  }

  const hashes = prepared.map((entry) => entry.documentHash);
  if (prepared.length !== REAL_MODEL_DOCUMENTS.length || !uploadsAreAuthorized(hashes, command.allowedDocumentHashes)) {
    const reports = REAL_MODEL_DOCUMENTS.map((document) => {
      const current = prepared.find((entry) => entry.document.id === document.id);
      return current
        ? { ...blankModuleReport(document.id, "not_authorized", "upload_authorization_required"), documentHash: current.documentHash, artifactHash: current.prepared.artifact.artifactHash, questions: questionCounts(current.prepared.questions) }
        : preparationReports.find((entry) => entry.module === document.id)!;
    });
    return baseReport("live", reports, isolation);
  }

  if (llmDisabledByOverride()) {
    return baseReport("live", prepared.map((entry) => ({
      ...preparedReport(entry),
      status: "model_unavailable" as const,
      code: "model_disabled",
    })), isolation);
  }
  const config = loadConfig();
  if (!isUsableLlmApiKey(config.apiKey)) {
    return baseReport("live", prepared.map((entry) => ({
      ...preparedReport(entry),
      status: "model_unavailable" as const,
      code: "model_unavailable",
    })), isolation);
  }

  // Sequential execution prevents the two source scopes from sharing either a
  // proposal request or a provider-admission budget.
  const modelFingerprint = `model-${sha256(new TextEncoder().encode(config.model))}`;
  const reports: SanitizedModuleReport[] = [];
  for (const entry of prepared) reports.push(await runLiveModule(entry, new LLMClient(config), modelFingerprint));
  return baseReport("live", reports, isolation);
}

function safeHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function safeStatus(value: unknown): SanitizedModuleReport["status"] {
  switch (value) {
    case "offline": case "prepared": case "draft_only": case "resolved":
    case "refused": case "not_authorized": case "document_unavailable": case "model_unavailable":
      return value;
    default:
      return "refused";
  }
}

/**
 * Whitelist every rendered field. In particular, this must never become
 * `JSON.stringify(report)`: report-adjacent exceptions and provider objects
 * can contain endpoints, source text, or opaque transport details.
 */
export function renderSanitizedAcceptanceReport(report: SanitizedAcceptanceReport): string {
  const modules = report.modules.map((module) => ({
    module: module.module === "fuzu" || module.module === "barn" ? module.module : "redacted",
    ...(safeHash(module.documentHash) ? { documentHash: safeHash(module.documentHash) } : {}),
    ...(safeHash(module.artifactHash) ? { artifactHash: safeHash(module.artifactHash) } : {}),
    status: safeStatus(module.status),
    ...(safeCode(module.code) ? { code: safeCode(module.code) } : {}),
    questions: {
      total: module.questions.total,
      answered: module.questions.answered,
      open: module.questions.open,
      deferred: module.questions.deferred,
    },
    accepted: module.accepted,
    model: {
      calls: module.model.calls,
      latencyMs: module.model.latencyMs,
      requestHashes: module.model.requestHashes.flatMap((hash) => safeHash(hash) ? [hash] : []),
      responseHashes: module.model.responseHashes.flatMap((hash) => safeHash(hash) ? [hash] : []),
      errorCodes: module.model.errorCodes.flatMap((code) => safeCode(code) ? [code] : []),
    },
    diagnostics: module.diagnostics.flatMap((diagnostic) => {
      const stage = PUBLIC_DIAGNOSTIC_STAGES.has(diagnostic.stage) ? diagnostic.stage : "other";
      const code = PUBLIC_DIAGNOSTIC_CODES.has(diagnostic.code) ? diagnostic.code : "other";
      return Number.isSafeInteger(diagnostic.count) && diagnostic.count > 0 && diagnostic.count <= 10_000
        ? [{ stage, code, count: diagnostic.count }]
        : [];
    }),
    closed: module.closed,
    witnesses: module.witnesses,
  }));
  return JSON.stringify({
    schemaVersion: REAL_MODEL_TWO_MODULE_SCHEMA_VERSION,
    mode: report.mode,
    externalCalls: report.externalCalls,
    budgets: report.budgets,
    modules,
    isolation: report.isolation,
  });
}

async function main(): Promise<void> {
  const parsed = parseRealModelAcceptanceArgs(process.argv.slice(2));
  if (!parsed.ok) {
    // Do not echo argv: a shell wrapper may have accidentally placed a secret
    // there. Codes are sufficient to explain the safe next action.
    process.stderr.write(`${parsed.code}\n`);
    process.exitCode = 2;
    return;
  }
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    const report = await runRealModelTwoModuleAcceptance(parsed);
    console.log = originalLog;
    console.warn = originalWarn;
    originalLog(renderSanitizedAcceptanceReport(report));
  } catch {
    console.log = originalLog;
    console.warn = originalWarn;
    // The thrown object could include source/provider text, so preserve only a
    // stable typed failure for the caller.
    originalLog(renderSanitizedAcceptanceReport(baseReport(parsed.mode, REAL_MODEL_DOCUMENTS.map((document) => blankModuleReport(document.id, "refused", "runner_failed")), {
      comparedPairs: 0, identityRefusals: 0, uniqueModuleIds: 0, uniqueDocumentHashes: 0,
    })));
    process.exitCode = 1;
  }
}

if (import.meta.main) void main();
