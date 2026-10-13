/**
 * Small, opt-in player-facing narration probe for the two current module paths.
 *
 * Offline is deliberately useful only for wiring and transcript inspection: it
 * marks every sample non-real. The current-Fuzu benchmark uses a local fake
 * LLMLike only to exercise the server's HTTP player-action/receipt path; it is
 * not an external provider request. Live mode is a separate source-disclosure
 * decision. It requires the exact hashes used by the existing two-document
 * acceptance harness before any source-backed prompt can reach a provider.
 * Its 180-second admission budget covers live request work, not synchronous
 * local PDF preparation or the diagnostic process wall clock.
 *
 *   bun scripts/diag/probe-two-module-narrative.ts --offline
 *   bun scripts/diag/probe-two-module-narrative.ts --live \
 *     --allow-upload-sha256 <fuzu-pdf-sha256> \
 *     --allow-upload-sha256 <barn-pdf-sha256>
 *
 * Reports are saved under a newly-created operating-system temp directory; no
 * session state or report is written into the project data directories.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../../src/api/game-session";
import { CompiledNarrationAdmissionCoordinator } from "../../src/api/compiled-narration-admission";
import { CompiledNarrationLedger } from "../../src/api/compiled-narration-ledger";
import { CompiledSessionSnapshotStore, validateCompiledSessionSnapshot } from "../../src/api/compiled-session-snapshot";
import { handleRequest } from "../../src/api/server";
import { KP_NARRATION_UNAVAILABLE_NOTICE } from "../../src/agent/kp-agent";
import {
  buildTrustedPresentationReviewCandidatePage,
  buildTrustedPresentationReviewSlotPage,
  projectTrustedResolvedCompilerArtifact,
  type CompilerModuleDataProjection,
  type TrustedPresentationBinding,
  type TrustedPresentationTextBinding,
  TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE,
  TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE,
} from "../../src/compiler/compiler-module-data-projection";
import { type ResolvedCompilerArtifactPayload } from "../../src/compiler/compiler-artifact";
import { loadConfig, type LLMConfig } from "../../src/config";
import { isUsableLlmApiKey, llmDisabledByOverride } from "../../src/llm/enabled";
import { DEGRADATION_NOTICE } from "../../src/llm/fallback";
import { extractMessageContent, LLMClient, type LLMLike } from "../../src/llm/client";
import type { CompilerRequestAuthenticator } from "../../src/api/compiled-module-http";
import type { CurrentFuzuResolvedBenchmarkContext } from "../fuzu-current-schema-acceptance";
import { BARN_OF_PREMIER } from "../../src/module/barn-of-premier";
import { sha256 } from "../../src/ingest/document-ir";
import { REAL_MODEL_DOCUMENTS, uploadsAreAuthorized } from "../real-model-two-module-acceptance";

export const TWO_MODULE_NARRATIVE_SCHEMA_VERSION = "1.0.0";
export const TWO_MODULE_NARRATIVE_LIMITS = Object.freeze({
  maxProviderRequests: 8,
  maxActionsPerModule: 3,
  maxTokens: 600,
  maxAttempts: 1,
  globalDeadlineMs: 180_000,
});

export type TwoModuleNarrativeMode = "offline" | "live";
export type TwoModuleNarrativeFocus = "npc";
export type TwoModuleNarrativeArgs =
  | { ok: true; mode: TwoModuleNarrativeMode; focus?: TwoModuleNarrativeFocus; allowedDocumentHashes: string[] }
  | { ok: false; code: "usage_invalid" | "upload_authorization_required" };

export interface PlayerFacingSample {
  step: "opening" | "look" | "npc" | "action";
  status: "ready" | "fallback" | "error" | "unsupported";
  provenance: "provider" | "mock" | "template" | "fallback" | "mechanics" | "provider_unobservable" | "unsupported";
  text: string;
  errorCode?: string;
  leakFlags: string[];
  /** SHA-256 of the raw, trimmed final NPC dialogue before report sanitization. */
  dialogueHash?: string;
  /** Hashes only, never provider body text, associated with this action window. */
  observedProviderContentHashes?: string[];
  matchingProviderContentHash?: string;
  /**
   * Compiled narration has a different receipt domain from ordinary NPC
   * dialogue.  These are hashes of the raw chat JSON and its parsed exact
   * player turn respectively; neither is the provider body.
   */
  narrationReceipt?: {
    rawResponseHash: string;
    textHash: string;
    replayedAfterRestart: boolean;
  };
}

export interface NarrativeModuleReport {
  module: "barn" | "fuzu";
  source: {
    id: string;
    version: string;
    kind: "runtime_module_data" | "compiled_artifact";
    artifactHash?: string;
    /** Fresh local-PDF benchmark compilation; never autonomous-model evidence. */
    currentPdfBenchmark?: {
      provenance: "current_pdf_benchmark_hints";
      documentHash: string;
      sourceGraphIdentity?: string;
      mechanicsHash?: string;
      reachableEndingCount?: number;
    };
    /** Present only after the public GameSession state confirms the loaded module. */
    verifiedActive?: { moduleId: string; entryScene: string; observedVia: "public_kp_state" };
  };
  runtime: "ordinary_game_session" | "compiled_game_session";
  contextualNarration: "supported" | "unsupported";
  status: "sampled" | "unavailable" | "refused";
  code?: string;
  samples: PlayerFacingSample[];
  quality: "not_real_model" | "provider_opening_observed" | "provider_npc_observed" | "provider_compiled_narration_observed" | "incomplete";
}

export interface TwoModuleNarrativeReport {
  schemaVersion: typeof TWO_MODULE_NARRATIVE_SCHEMA_VERSION;
  mode: TwoModuleNarrativeMode;
  model: {
    requested: "offline_mock" | "live_provider";
    availability: "offline" | "ready" | "model_disabled" | "model_unavailable" | "upload_authorization_required" | "document_unavailable";
    modelFingerprint?: string;
    maxTokens: number;
    maxAttempts: number;
  };
  budget: {
    maxProviderRequests: number;
    observedProviderRequests: number;
    maxActionsPerModule: number;
    maxTokens: number;
    maxAttempts: number;
    globalDeadlineMs: number;
    deadlineReached: boolean;
    requestBudgetReached: boolean;
    providerFailureCodes: string[];
  };
  comparison: "incomplete_compiled_contextual_narration_unsupported" | "incomplete_current_pdf_benchmark_hints";
  modules: NarrativeModuleReport[];
}

type UnknownRecord = Record<string, unknown>;

const OFFLINE_CONFIG: LLMConfig = Object.freeze({
  apiKey: "sk-placeholder-two-module-probe",
  baseUrl: "http://offline.invalid",
  model: "offline-two-module-probe",
  maxTokens: TWO_MODULE_NARRATIVE_LIMITS.maxTokens,
  temperature: 0,
});

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function publicCode(value: unknown, fallback = "session_failed"): string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(value) ? value : fallback;
}

type PlayerActionLike = {
  narrative?: unknown;
  events?: unknown;
  error?: { code?: unknown };
};

export interface NpcProviderContentReceipt {
  /** Monotonic wrapper dispatch ordinal, not receipt completion order. */
  requestIndex: number;
  contentHash: string;
}

/** Do not print provider-shaped strings even if a model unexpectedly emits one. */
export function sanitizePlayerText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_KEY]")
    .replace(/https?:\/\/[^\s)）]+/g, "[REDACTED_URL]")
    .slice(0, 4_000);
}

function leakFlags(text: string): string[] {
  const flags: string[] = [];
  if (/(?:\bKP\b|守秘人|模组|剧本)/i.test(text)) flags.push("meta_language");
  if (/(?:灭火器|莫洛托夫|鸡尾酒).{0,16}(?:KP|允许|检定)/.test(text)) flags.push("potential_kp_mechanics_leak");
  return flags;
}

/** Preserve a non-empty player-visible result even if the response also carries an error. */
export function sampleFromActionResponse(
  step: Extract<PlayerFacingSample["step"], "look" | "npc" | "action">,
  response: { narrative?: unknown; events?: unknown; error?: { code?: unknown } },
  provenance: PlayerFacingSample["provenance"],
): PlayerFacingSample {
  const eventText = Array.isArray(response.events)
    ? response.events
      .filter(isRecord)
      .map((event) => asNonEmptyText(event.content))
      .filter((text): text is string => text !== null)
      .join("\n")
    : "";
  const text = sanitizePlayerText(asNonEmptyText(response.narrative) ?? eventText);
  // Empty output is not a successful narrative sample.  Keep an explicit
  // refusal code rather than letting a blank transcript look green.
  const errorCode = response.error
    ? publicCode(response.error.code, "action_refused")
    : text ? undefined : "empty_player_output";
  return {
    step,
    status: errorCode ? "error" : "ready",
    provenance,
    text,
    ...(errorCode ? { errorCode } : {}),
    leakFlags: leakFlags(text),
  };
}

/** Opening fallback is explicitly not evidence of a real-provider success. */
export function openingSample(
  opening: unknown,
  status: "ready" | "fallback",
  provider: "provider" | "mock",
): PlayerFacingSample {
  const text = sanitizePlayerText(opening);
  return {
    step: "opening",
    status,
    provenance: status === "fallback" ? "fallback" : provider,
    text,
    ...(status === "fallback" ? { errorCode: "provider_fallback" } : {}),
    leakFlags: leakFlags(text),
  };
}

function finalNpcDialogue(response: PlayerActionLike): string | null {
  if (!Array.isArray(response.events)) return null;
  for (let index = response.events.length - 1; index >= 0; index--) {
    const event = response.events[index];
    if (!isRecord(event) || event.type !== "dialogue") continue;
    const dialogue = asNonEmptyText(event.content);
    if (dialogue) return dialogue;
  }
  return null;
}

function isProviderFallback(response: PlayerActionLike): boolean {
  return typeof response.narrative === "string"
    && (response.narrative.includes(DEGRADATION_NOTICE) || response.narrative.includes(KP_NARRATION_UNAVAILABLE_NOTICE));
}

/**
 * Selects only receipts dispatched after `startExclusive` and no later than
 * `endInclusive`. Receipt completion is deliberately irrelevant: a late old
 * request must never be attributed to a later player action.
 */
export function npcProviderContentHashesForWindow(
  receipts: readonly NpcProviderContentReceipt[],
  startExclusive: number,
  endInclusive: number,
): string[] {
  if (!Number.isSafeInteger(startExclusive) || !Number.isSafeInteger(endInclusive) || endInclusive < startExclusive) return [];
  return receipts
    .filter((receipt) => Number.isSafeInteger(receipt.requestIndex)
      && receipt.requestIndex > startExclusive
      && receipt.requestIndex <= endInclusive
      && isSha256(receipt.contentHash))
    .sort((left, right) => left.requestIndex - right.requestIndex)
    .map((receipt) => receipt.contentHash);
}

/**
 * Focus mode intentionally reports only the terminal NPC dialogue event.
 * A host narrative, classification result, or other event cannot become
 * provider evidence merely because some fetch happened in the same process.
 */
export function focusedNpcSample(
  response: PlayerActionLike,
  mode: TwoModuleNarrativeMode,
  observedProviderContentHashes: readonly string[],
): PlayerFacingSample {
  const dialogue = finalNpcDialogue(response);
  const dialogueHash = dialogue ? sha256(new TextEncoder().encode(dialogue)) : undefined;
  const hashes = observedProviderContentHashes.filter(isSha256);
  const matchingProviderContentHash = !response.error && dialogueHash && hashes.includes(dialogueHash) ? dialogueHash : undefined;
  const fallback = isProviderFallback(response);
  const provenance: PlayerFacingSample["provenance"] = mode === "offline"
    ? "mock"
    : fallback
      ? "fallback"
      : matchingProviderContentHash
        ? "provider"
        : "provider_unobservable";
  const text = sanitizePlayerText(dialogue ?? "");
  const errorCode = response.error
    ? publicCode(response.error.code, "action_refused")
    : text ? undefined : "empty_player_output";
  return {
    step: "npc",
    status: errorCode ? "error" : provenance === "fallback" ? "fallback" : "ready",
    provenance,
    text,
    ...(errorCode ? { errorCode } : provenance === "fallback" ? { errorCode: "provider_fallback" } : {}),
    leakFlags: leakFlags(text),
    ...(dialogueHash ? { dialogueHash } : {}),
    ...(mode === "live" && hashes.length > 0 ? { observedProviderContentHashes: hashes } : {}),
    ...(matchingProviderContentHash ? { matchingProviderContentHash } : {}),
  };
}

export function parseTwoModuleNarrativeArgs(args: readonly string[]): TwoModuleNarrativeArgs {
  let mode: TwoModuleNarrativeMode | undefined;
  let focus: TwoModuleNarrativeFocus | undefined;
  const allowedDocumentHashes: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--offline" || token === "--live") {
      if (mode !== undefined) return { ok: false, code: "usage_invalid" };
      mode = token.slice(2) as TwoModuleNarrativeMode;
      continue;
    }
    if (token === "--focus") {
      const value = args[++index];
      if (focus !== undefined || value !== "npc") return { ok: false, code: "usage_invalid" };
      focus = value;
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
  if (!mode || (mode === "offline" && allowedDocumentHashes.length > 0)) return { ok: false, code: "usage_invalid" };
  if (mode === "live" && allowedDocumentHashes.length === 0) return { ok: false, code: "upload_authorization_required" };
  return { ok: true, mode, ...(focus ? { focus } : {}), allowedDocumentHashes };
}

function cappedLiveConfig(config: LLMConfig): LLMConfig {
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    // Bound every route that might omit its own maxTokens option.
    maxTokens: Math.max(1, Math.min(TWO_MODULE_NARRATIVE_LIMITS.maxTokens, Math.trunc(config.maxTokens) || TWO_MODULE_NARRATIVE_LIMITS.maxTokens)),
    temperature: Number.isFinite(config.temperature) ? config.temperature : 0.7,
  };
}

/** Kept pure so a missing key cannot accidentally be mistaken for a fallback success. */
export function liveModelAvailability(config: Pick<LLMConfig, "apiKey">, disabled: boolean): "ready" | "model_disabled" | "model_unavailable" {
  if (disabled) return "model_disabled";
  return isUsableLlmApiKey(config.apiKey) ? "ready" : "model_unavailable";
}

function documentHashes(): { ok: true; hashes: string[] } | { ok: false } {
  try {
    return { ok: true, hashes: REAL_MODEL_DOCUMENTS.map((document) => sha256(new Uint8Array(readFileSync(document.path)))) };
  } catch {
    return { ok: false };
  }
}

type CurrentFuzuCompiler = <T>(
  pdfPath: string,
  onResolved: (context: CurrentFuzuResolvedBenchmarkContext) => T | Promise<T>,
) => Promise<T>;

export interface TwoModuleNarrativeProbeDependencies {
  /**
   * Test seam for the current-PDF compiler. Production uses the internal
   * current-schema helper, while unit tests deliberately never spawn it.
   */
  compileCurrentFuzuAcceptance?: CurrentFuzuCompiler;
}

/**
 * Identity-pair guard shared by the fresh helper result and its negative
 * regression test. It validates in-memory current artifacts only; it never
 * reads the retired analysis artifacts.
 */
export function validateFuzuArtifactPair(
  resolved: unknown,
  projection: unknown,
): { ok: true; artifactHash: string } | { ok: false; code: "fuzu_module_mismatch" } {
  if (!isRecord(resolved) || !isRecord(projection) || !isRecord(resolved.payload) || !isRecord(projection.module)
    || !isRecord(projection.artifact) || !isRecord(resolved.payload.identity) || !isRecord(projection.artifact.identity)) {
    return { ok: false, code: "fuzu_module_mismatch" };
  }
  const artifactHash = asNonEmptyText(resolved.artifactHash);
  const projectionHash = asNonEmptyText(projection.artifact.artifactHash);
  const identity = resolved.payload.identity;
  const projectedIdentity = projection.artifact.identity;
  const keys = ["moduleId", "documentHash", "sourceGraphIdentity", "mechanicsHash"];
  if (resolved.stage !== "resolved" || projection.status !== "projected" || projection.module.id !== "fuzu"
    || identity.moduleId !== "fuzu" || projectedIdentity.moduleId !== "fuzu" || !artifactHash || artifactHash !== projectionHash
    || keys.some((key) => identity[key] !== projectedIdentity[key])) return { ok: false, code: "fuzu_module_mismatch" };
  return { ok: true, artifactHash };
}

type ValidCurrentFuzuCompilation = {
  payload: ResolvedCompilerArtifactPayload;
  projection: CompilerModuleDataProjection;
  artifactHash: string;
  documentHash: string;
  sourceGraphIdentity: string;
  mechanicsHash: string;
  reachableEndingCount: number;
};

/**
 * Accept only an in-memory result freshly built from the local Fuzu PDF by
 * the current-schema acceptance helper. Old checked-in/ignored artifacts are
 * intentionally not a fallback source for this diagnostic.
 */
export function validateCurrentFuzuCompilation(
  compiled: unknown,
  expectedDocumentHash: string,
): { ok: true; value: ValidCurrentFuzuCompilation } | { ok: false; code: "fuzu_current_compile_invalid" | "fuzu_module_mismatch" } {
  if (!isRecord(compiled) || !isRecord(compiled.aggregate) || !isRecord(compiled.artifact)
    || !isRecord(compiled.payload) || !isRecord(compiled.projection)
    || !isRecord(compiled.payload.identity) || !isRecord(compiled.projection.module)
    || !isRecord(compiled.projection.artifact) || !isRecord(compiled.projection.artifact.identity)
    || !isRecord(compiled.aggregate.resolution)) {
    return { ok: false, code: "fuzu_current_compile_invalid" };
  }
  const pair = validateFuzuArtifactPair(compiled.artifact, compiled.projection);
  if (!pair.ok) return pair;
  const artifactHash = pair.artifactHash;
  const aggregateArtifactHash = asNonEmptyText(compiled.aggregate.artifactHash);
  const aggregateDocumentHash = asNonEmptyText(compiled.aggregate.documentHash);
  const identity = compiled.payload.identity;
  const artifactIdentity = (compiled.artifact.payload as UnknownRecord).identity;
  const projectedIdentity = compiled.projection.artifact.identity;
  const sourceGraphIdentity = identity.sourceGraphIdentity;
  const mechanicsHash = identity.mechanicsHash;
  const keys = ["moduleId", "documentHash", "sourceGraphIdentity", "mechanicsHash"];
  const endings = compiled.aggregate.resolution.reachableEndings;
  if (!isRecord(artifactIdentity) || artifactHash !== aggregateArtifactHash
    || aggregateDocumentHash !== expectedDocumentHash || identity.documentHash !== expectedDocumentHash
    || keys.some((key) => identity[key] !== projectedIdentity[key] || identity[key] !== artifactIdentity[key])
    || !isSha256(artifactHash) || !isSha256(expectedDocumentHash)
    || !isSha256(sourceGraphIdentity) || !isSha256(mechanicsHash)
    || !Array.isArray(endings) || endings.some((ending) => typeof ending !== "string" || !ending.trim())) {
    return { ok: false, code: "fuzu_module_mismatch" };
  }
  return {
    ok: true,
    value: {
      payload: compiled.payload as unknown as ResolvedCompilerArtifactPayload,
      projection: compiled.projection as unknown as CompilerModuleDataProjection,
      artifactHash,
      documentHash: expectedDocumentHash,
      sourceGraphIdentity,
      mechanicsHash,
      reachableEndingCount: endings.length,
    },
  };
}

function fuzuSourceInput(): { ok: true; path: string; documentHash: string } | { ok: false } {
  const document = REAL_MODEL_DOCUMENTS.find((candidate) => candidate.id === "fuzu");
  if (!document) return { ok: false };
  try {
    return { ok: true, path: document.path, documentHash: sha256(new Uint8Array(readFileSync(document.path))) };
  } catch {
    return { ok: false };
  }
}

const FUZU_BENCHMARK_OWNER: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "keeper", id: "keeper:fuzu-current-pdf-benchmark" },
});
const FUZU_BENCHMARK_PLAYER: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "player", id: "player:fuzu-current-pdf-benchmark" },
});

type FuzuNarrationReceipt = {
  rawResponseHash: string;
  textHash: string;
  text: string;
  providerCalls: number;
  generation: number;
  replayedAfterRestart: true;
};

type FuzuTrustedNarrationResult = {
  projection: CompilerModuleDataProjection;
  receipt: FuzuNarrationReceipt;
};

function exactNarrationText(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.text !== "string") return null;
    const text = parsed.text.trim();
    return text && text === parsed.text ? text : null;
  } catch {
    return null;
  }
}

class RecordingFuzuNarrator implements LLMLike {
  calls = 0;
  #rawResponseHash: string | undefined;
  #textHash: string | undefined;
  #text: string | undefined;

  constructor(private readonly delegate: LLMLike) {}

  async chat(messages: Parameters<LLMLike["chat"]>[0], options?: Parameters<LLMLike["chat"]>[1]): Promise<string> {
    const raw = await this.delegate.chat(messages, options);
    const text = exactNarrationText(raw);
    if (!text) throw new Error("fuzu_compiled_narration_response_invalid");
    this.calls++;
    this.#rawResponseHash = sha256(new TextEncoder().encode(raw));
    this.#textHash = sha256(new TextEncoder().encode(text));
    this.#text = text;
    return raw;
  }

  receipt(): { rawResponseHash: string; textHash: string; text: string } | null {
    return this.#rawResponseHash && this.#textHash && this.#text
      ? { rawResponseHash: this.#rawResponseHash, textHash: this.#textHash, text: this.#text }
      : null;
  }
}

type FuzuBenchmarkBindingIdentity = {
  sourceCandidateCount: number;
  statementId: string;
  headingStatementId: string;
  evidenceRefId: string;
  quoteHash: string;
  /** Audit category only; it is not source prose or a runtime authority. */
  reason: "dialogue_relation" | "connection_condition" | "leave_trigger" | "ending_label" | "ending_outcome" | "scene_heading_no_prereveal";
};

/**
 * This is a current-PDF benchmark review, not a production review registry.
 * Every non-singleton selection was checked locally against its actual source
 * text and owning heading.  The stable identity intentionally stores no quote:
 * the candidate workbench supplies it afresh and the catalog validates it.
 */
const FUZU_BENCHMARK_MULTIPLE_CANDIDATE_BINDINGS: Readonly<Record<string, FuzuBenchmarkBindingIdentity>> = Object.freeze({
  "clues.prose_clue_5a6f7ecf0b43ea45d5b2cd61.findMethods.prose_talk_78baead8e75d9470f9424f07.description": { sourceCandidateCount: 2, statementId: "block_87ee29caf8dbfba1d816dfc4:statement:whole", headingStatementId: "block_8f057e49a416e88cc58d47ba:statement:whole", evidenceRefId: "statement:block_87ee29caf8dbfba1d816dfc4:statement:whole", quoteHash: "845510c673b5fd4ec098f0d9ac4ab15cab658e812aacf0c65d8085c54b9520d6", reason: "dialogue_relation" },
  "clues.prose_clue_5a6f7ecf0b43ea45d5b2cd61.revelation": { sourceCandidateCount: 2, statementId: "block_87ee29caf8dbfba1d816dfc4:statement:whole", headingStatementId: "block_8f057e49a416e88cc58d47ba:statement:whole", evidenceRefId: "statement:block_87ee29caf8dbfba1d816dfc4:statement:whole", quoteHash: "845510c673b5fd4ec098f0d9ac4ab15cab658e812aacf0c65d8085c54b9520d6", reason: "dialogue_relation" },
  "connections.doctor_to_courtyard.condition": { sourceCandidateCount: 2, statementId: "block_87ee29caf8dbfba1d816dfc4:statement:whole", headingStatementId: "block_8f057e49a416e88cc58d47ba:statement:whole", evidenceRefId: "statement:block_87ee29caf8dbfba1d816dfc4:statement:whole", quoteHash: "845510c673b5fd4ec098f0d9ac4ab15cab658e812aacf0c65d8085c54b9520d6", reason: "connection_condition" },
  "connections.film_to_night.condition": { sourceCandidateCount: 2, statementId: "block_479fda6358b784676742f5b9:statement:whole", headingStatementId: "block_54049972bf7e64bae9050680:statement:whole", evidenceRefId: "statement:block_479fda6358b784676742f5b9:statement:whole", quoteHash: "ac52123f850936976ceb2c701cbe41d510751527fa6cda28eb8b8dbd4463f8a1", reason: "connection_condition" },
  "connections.lauren_to_leave.condition": { sourceCandidateCount: 6, statementId: "block_d2b88bf156791be09fdfd238:statement:whole", headingStatementId: "block_ab423a82ba751de2928655ea:statement:whole", evidenceRefId: "statement:block_d2b88bf156791be09fdfd238:statement:whole", quoteHash: "d0bab7045abc6ab5fbb8ca3d90ee64439a31c4fe34c2a92fc653052e6e1ca8d4", reason: "leave_trigger" },
  "connections.leave_to_courtyard.condition": { sourceCandidateCount: 2, statementId: "block_00446f328437a3f5d00b78f0:statement:whole", headingStatementId: "block_9a25bf20f72c4eb8fbeafc4b:statement:whole", evidenceRefId: "statement:block_00446f328437a3f5d00b78f0:statement:whole", quoteHash: "a855dec53e82f1eaced86547f7c6c78f2cf44790aca9352def134465f2bdc3fc", reason: "connection_condition" },
  "connections.leave_to_doctor.condition": { sourceCandidateCount: 2, statementId: "block_00446f328437a3f5d00b78f0:statement:whole", headingStatementId: "block_9a25bf20f72c4eb8fbeafc4b:statement:whole", evidenceRefId: "statement:block_00446f328437a3f5d00b78f0:statement:whole", quoteHash: "a855dec53e82f1eaced86547f7c6c78f2cf44790aca9352def134465f2bdc3fc", reason: "connection_condition" },
  "connections.night_to_lauren.condition": { sourceCandidateCount: 2, statementId: "block_faa4c0ef1ccb742d0b97811d:statement:whole", headingStatementId: "block_1b32f5a91313dec4a7854ee7:statement:whole", evidenceRefId: "statement:block_faa4c0ef1ccb742d0b97811d:statement:whole", quoteHash: "7ed6fa8f31f2fadb5c53b82fdea29690de5dd7bd781af0ac4eb2bcce747a2542", reason: "connection_condition" },
  "endings.escape_with_dream_stone.conditions.0": { sourceCandidateCount: 2, statementId: "block_1a2f8aea83aeb408d7047fa7:statement:whole", headingStatementId: "block_0314c630ac8d9a556a4d0eee:statement:whole", evidenceRefId: "statement:block_1a2f8aea83aeb408d7047fa7:statement:whole", quoteHash: "1255a7a2dae5e7e02a0f6b74b5c1b03f9ee7d694000d965def5ab19394566219", reason: "ending_outcome" },
  "endings.escape_with_dream_stone.description": { sourceCandidateCount: 2, statementId: "block_1a2f8aea83aeb408d7047fa7:statement:whole", headingStatementId: "block_0314c630ac8d9a556a4d0eee:statement:whole", evidenceRefId: "statement:block_1a2f8aea83aeb408d7047fa7:statement:whole", quoteHash: "1255a7a2dae5e7e02a0f6b74b5c1b03f9ee7d694000d965def5ab19394566219", reason: "ending_outcome" },
  "endings.escape_with_dream_stone.name": { sourceCandidateCount: 2, statementId: "block_0314c630ac8d9a556a4d0eee:statement:whole", headingStatementId: "block_0314c630ac8d9a556a4d0eee:statement:whole", evidenceRefId: "statement:block_0314c630ac8d9a556a4d0eee:statement:whole", quoteHash: "7fc75ed74b81af81a983b948b2f5b5ca1d77929a54cef56d413f6f7af95cbc38", reason: "ending_label" },
  "endings.lost_without_dream_stone.conditions.0": { sourceCandidateCount: 2, statementId: "block_1a2f8aea83aeb408d7047fa7:statement:whole", headingStatementId: "block_0314c630ac8d9a556a4d0eee:statement:whole", evidenceRefId: "statement:block_1a2f8aea83aeb408d7047fa7:statement:whole", quoteHash: "1255a7a2dae5e7e02a0f6b74b5c1b03f9ee7d694000d965def5ab19394566219", reason: "ending_outcome" },
  "endings.lost_without_dream_stone.description": { sourceCandidateCount: 2, statementId: "block_1a2f8aea83aeb408d7047fa7:statement:whole", headingStatementId: "block_0314c630ac8d9a556a4d0eee:statement:whole", evidenceRefId: "statement:block_1a2f8aea83aeb408d7047fa7:statement:whole", quoteHash: "1255a7a2dae5e7e02a0f6b74b5c1b03f9ee7d694000d965def5ab19394566219", reason: "ending_outcome" },
  "endings.lost_without_dream_stone.name": { sourceCandidateCount: 2, statementId: "block_0314c630ac8d9a556a4d0eee:statement:whole", headingStatementId: "block_0314c630ac8d9a556a4d0eee:statement:whole", evidenceRefId: "statement:block_0314c630ac8d9a556a4d0eee:statement:whole", quoteHash: "7fc75ed74b81af81a983b948b2f5b5ca1d77929a54cef56d413f6f7af95cbc38", reason: "ending_label" },
  "scenes.draft_scene_083f7eaaf1ff94bbd6faca70.description": { sourceCandidateCount: 2, statementId: "block_9a25bf20f72c4eb8fbeafc4b:statement:whole", headingStatementId: "block_9a25bf20f72c4eb8fbeafc4b:statement:whole", evidenceRefId: "statement:block_9a25bf20f72c4eb8fbeafc4b:statement:whole", quoteHash: "e5d6d83913fd21b7b5f5958f684406ed19741b860fa3d6799fa7d866655dc6d1", reason: "scene_heading_no_prereveal" },
  "scenes.draft_scene_095419f1782d2159bc60e362.description": { sourceCandidateCount: 2, statementId: "block_54049972bf7e64bae9050680:statement:whole", headingStatementId: "block_54049972bf7e64bae9050680:statement:whole", evidenceRefId: "statement:block_54049972bf7e64bae9050680:statement:whole", quoteHash: "d2022aac003973049afde143dd593674e44707ebb762aaf8e8c0ebfb3e569f7a", reason: "scene_heading_no_prereveal" },
  "scenes.draft_scene_2cbf58f714a07400582bbc25.description": { sourceCandidateCount: 2, statementId: "block_1b32f5a91313dec4a7854ee7:statement:whole", headingStatementId: "block_1b32f5a91313dec4a7854ee7:statement:whole", evidenceRefId: "statement:block_1b32f5a91313dec4a7854ee7:statement:whole", quoteHash: "31abe234683d9e7feed4911c62011edc04abb97ea6ef604cf5e1c54b485d4c88", reason: "scene_heading_no_prereveal" },
  "scenes.draft_scene_5541f6b6de724a2e21e99cb1.description": { sourceCandidateCount: 2, statementId: "block_3772ed2dc3a9e7aa2a0f3f86:statement:whole", headingStatementId: "block_3772ed2dc3a9e7aa2a0f3f86:statement:whole", evidenceRefId: "statement:block_3772ed2dc3a9e7aa2a0f3f86:statement:whole", quoteHash: "0f0a162bbf84994ba41bf45e217db0b6fcc7982c8f1afafbc908ba5383efc8f0", reason: "scene_heading_no_prereveal" },
  "scenes.draft_scene_5c0d700157d71bbbc5585d71.description": { sourceCandidateCount: 12, statementId: "block_ab423a82ba751de2928655ea:statement:whole", headingStatementId: "block_ab423a82ba751de2928655ea:statement:whole", evidenceRefId: "statement:block_ab423a82ba751de2928655ea:statement:whole", quoteHash: "3a0a7503b501cf5c05f42955066522a8e1ecba9892797e6d59f4a47f1c57de9b", reason: "scene_heading_no_prereveal" },
  "scenes.draft_scene_b433990d0b1ac5fd8cb822b9.description": { sourceCandidateCount: 2, statementId: "block_8f057e49a416e88cc58d47ba:statement:whole", headingStatementId: "block_8f057e49a416e88cc58d47ba:statement:whole", evidenceRefId: "statement:block_8f057e49a416e88cc58d47ba:statement:whole", quoteHash: "3f523e81381341ab87d5b3c6656b0d745c7faca2a46a254bdb068c9bd28d2550", reason: "scene_heading_no_prereveal" },
});

function matchesFuzuBenchmarkIdentity(
  binding: TrustedPresentationTextBinding,
  identity: FuzuBenchmarkBindingIdentity,
): boolean {
  return binding.statementId === identity.statementId
    && binding.headingStatementId === identity.headingStatementId
    && binding.evidenceRefId === identity.evidenceRefId
    && sha256(new TextEncoder().encode(binding.quote)) === identity.quoteHash;
}

function sourceExactPresentationBindings(payload: ResolvedCompilerArtifactPayload): TrustedPresentationBinding[] {
  const bindings: TrustedPresentationBinding[] = [];
  for (let offset = 0; ; offset += TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE) {
    const slots = buildTrustedPresentationReviewSlotPage(payload, offset);
    if (slots.status !== "slot_paged") throw new Error("fuzu_presentation_slots_unavailable");
    for (const slot of slots.page.slots) {
      if (slot.fieldPath === "module.triggerWarnings"
        && slot.allowedBindingKinds.length === 1
        && slot.allowedBindingKinds[0] === "opaque_unavailable"
        && slot.opaqueBinding) {
        bindings.push(slot.opaqueBinding);
        continue;
      }
      if (slot.fieldPath.startsWith("module.")
        && slot.allowedBindingKinds.includes("opaque_unavailable")
        && slot.opaqueBinding) {
        // No current-PDF metadata field has a reviewed public rendering.  An
        // explicit opaque binding is the contract-supported disclosure, never
        // a source-candidate fallback.
        bindings.push(slot.opaqueBinding);
        continue;
      }
      if (!slot.allowedBindingKinds.includes("source_exact")) throw new Error("fuzu_presentation_slot_unavailable");
      const fixture = FUZU_BENCHMARK_MULTIPLE_CANDIDATE_BINDINGS[slot.fieldPath];
      if (slot.sourceCandidateCount !== 1 && (!fixture || fixture.sourceCandidateCount !== slot.sourceCandidateCount)) {
        throw new Error(`fuzu_presentation_slot_ambiguous:${slot.fieldPath}:${slot.sourceCandidateCount}`);
      }
      const candidates: TrustedPresentationTextBinding[] = [];
      for (let candidateOffset = 0; ; candidateOffset += TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE) {
        const page = buildTrustedPresentationReviewCandidatePage(payload, slot.fieldPath, candidateOffset);
        if (page.status !== "paged" || page.page.fieldPath !== slot.fieldPath) throw new Error("fuzu_presentation_candidate_unavailable");
        for (const candidate of page.page.candidates) {
          if (candidate.kind !== "source_exact" || candidate.binding.fieldPath !== slot.fieldPath || !candidate.binding.headingStatementId) {
            throw new Error("fuzu_presentation_candidate_invalid");
          }
          candidates.push(candidate.binding);
        }
        if (!page.page.hasMore) break;
      }
      if (candidates.length !== slot.sourceCandidateCount) throw new Error("fuzu_presentation_candidate_count_mismatch");
      const matches = fixture
        ? candidates.filter((candidate) => matchesFuzuBenchmarkIdentity(candidate, fixture))
        : candidates;
      if (matches.length !== 1) throw new Error("fuzu_presentation_fixture_mismatch");
      // Do not copy candidate `exactText`: the selected binding is validated
      // afresh by the catalog against both its source and owning heading.
      bindings.push(matches[0]!);
    }
    if (!slots.page.hasMore) return bindings;
  }
}

function fuzuLocalNarrator(): LLMLike {
  return {
    async chat() {
      // This proves only the HTTP/receipt chain, never natural-language model
      // quality or autonomous current-PDF compilation.
      return '{"text":"你继续谨慎地观察周围的动静。"}';
    },
  };
}

async function runTrustedFuzuHttpNarration(
  context: CurrentFuzuResolvedBenchmarkContext,
  narratorDelegate: LLMLike,
): Promise<FuzuTrustedNarrationResult> {
  const savedReview = context.catalog.saveTrustedPresentationReview(
    context.preparedArtifactId,
    context.preparedArtifact,
    context.resolvedArtifact,
    "benchmark:fuzu-current-pdf-source-exact",
    sourceExactPresentationBindings(context.payload),
  );
  if (savedReview.status !== "ok") {
    // Catalog refusal codes are a closed public enum; retain the code only,
    // never its message, because that message may carry projection context.
    const code = "code" in savedReview && typeof savedReview.code === "string" ? savedReview.code.toLowerCase() : "indeterminate";
    throw new Error(`fuzu_trusted_review_refused_${code}`);
  }
  const review = context.catalog.loadTrustedPresentationReview(savedReview.value.id);
  if (review.status !== "ok") throw new Error("fuzu_trusted_review_missing");
  const projection = projectTrustedResolvedCompilerArtifact(context.payload, review.value.review);
  if (projection.status !== "projected") throw new Error("fuzu_trusted_projection_refused");
  const bundle = context.catalog.saveBundle(context.resolvedArtifact, projection);
  if (bundle.status !== "ok") throw new Error("fuzu_trusted_bundle_refused");

  const runtimeRoot = join(context.catalog.root, "current-pdf-http-narration");
  const snapshots = new CompiledSessionSnapshotStore({ root: join(runtimeRoot, "snapshots") });
  const narrator = new RecordingFuzuNarrator(narratorDelegate);
  const liveRegistry = new Map<string, GameSession>();
  const restartRegistry = new Map<string, GameSession>();
  const runtime = {
    registry: liveRegistry,
    compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
    compiledNarrationAdmission: new CompiledNarrationAdmissionCoordinator(snapshots.root),
    compiledNarrationLedger: new CompiledNarrationLedger(snapshots.root),
  };
  const storage = { careerRoot: join(runtimeRoot, "careers"), sessionRoot: runtimeRoot };
  try {
  const create = await handleRequest(
    new Request("http://benchmark.invalid/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: bundle.value.id, archetype: "investigator", characterName: "调查员" }),
    }),
    context.catalog,
    snapshots,
    storage,
    {},
    {},
    FUZU_BENCHMARK_OWNER,
    undefined,
    () => ({ status: "assigned" as const, principal: { role: "player" as const, id: "player:fuzu-current-pdf-benchmark" } }),
    undefined,
    undefined,
    runtime,
  );
  if (create.status !== 201) throw new Error("fuzu_http_session_refused");
  const created = await create.json() as { sessionId?: unknown };
  if (typeof created.sessionId !== "string" || !created.sessionId) throw new Error("fuzu_http_session_missing");
  const base = `http://benchmark.invalid/api/sessions/${created.sessionId}`;
  const viewResponse = await handleRequest(new Request(`${base}/player-view`), context.catalog, snapshots, storage, {}, {}, FUZU_BENCHMARK_PLAYER, undefined, undefined, undefined, undefined, runtime);
  if (viewResponse.status !== 200) throw new Error("fuzu_http_player_view_refused");
  const view = await viewResponse.json() as { generation?: unknown; actions?: Array<{ choiceId?: unknown }> };
  const initialGeneration = view.generation;
  const choiceId = view.actions?.[0]?.choiceId;
  if (!Number.isSafeInteger(initialGeneration) || typeof choiceId !== "string" || !choiceId) throw new Error("fuzu_http_player_action_unavailable");
  const expectedGeneration = initialGeneration as number;
  const actionBody = { choiceId, actionId: "fuzu-current-pdf-narration-0001", expectedGeneration };
  const action = await handleRequest(new Request(`${base}/player-actions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(actionBody),
  }), context.catalog, snapshots, storage, {}, {}, FUZU_BENCHMARK_PLAYER, undefined, undefined, undefined, undefined, runtime);
  if (action.status !== 200) throw new Error("fuzu_http_narration_action_refused");
  const committed = await action.json() as { view?: { generation?: unknown; turn?: { text?: unknown; generation?: unknown } } };
  const receipt = narrator.receipt();
  const committedGeneration = committed.view?.generation;
  const committedText = committed.view?.turn?.text;
  if (!receipt || committedGeneration !== expectedGeneration + 1 || committed.view?.turn?.generation !== committedGeneration
    || committedText !== receipt.text || sha256(new TextEncoder().encode(committedText)) !== receipt.textHash) {
    throw new Error("fuzu_http_narration_receipt_mismatch");
  }
  const persisted = snapshots.read(created.sessionId);
  const snapshot = persisted.status === "ok" ? validateCompiledSessionSnapshot(persisted.value) : persisted;
  if (snapshot.status !== "ok" || snapshot.value.generation !== committedGeneration) throw new Error("fuzu_http_narration_snapshot_missing");
  const durableReceipt = runtime.compiledNarrationLedger.read(created.sessionId, actionBody.actionId);
  if (durableReceipt.status !== "ok" || durableReceipt.value.state !== "committed"
    || durableReceipt.value.candidate.actionId !== actionBody.actionId
    || durableReceipt.value.candidate.expectedGeneration !== expectedGeneration
    || durableReceipt.value.candidate.nextGeneration !== committedGeneration
    || durableReceipt.value.narration?.text !== receipt.text) {
    throw new Error("fuzu_http_narration_durable_receipt_mismatch");
  }

  const duplicate = await handleRequest(new Request(`${base}/player-actions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(actionBody),
  }), context.catalog, snapshots, storage, {}, {}, FUZU_BENCHMARK_PLAYER, undefined, undefined, undefined, undefined, runtime);
  const duplicateBody = duplicate.status === 200 ? await duplicate.json() as { view?: { generation?: unknown; turn?: { text?: unknown; generation?: unknown } } } : undefined;
  if (duplicate.status !== 200 || narrator.calls !== 1 || duplicateBody?.view?.generation !== committedGeneration
    || duplicateBody.view?.turn?.generation !== committedGeneration || duplicateBody.view?.turn?.text !== receipt.text) {
    throw new Error("fuzu_http_narration_duplicate_mismatch");
  }

  const restartRuntime = {
    registry: restartRegistry,
    compiledNarrationOptions: { isLlmEnabled: () => false },
    compiledNarrationAdmission: new CompiledNarrationAdmissionCoordinator(snapshots.root),
    compiledNarrationLedger: new CompiledNarrationLedger(snapshots.root),
  };
  const reloadedViewResponse = await handleRequest(new Request(`${base}/player-view`), context.catalog, snapshots, storage, {}, {}, FUZU_BENCHMARK_PLAYER, undefined, undefined, undefined, undefined, restartRuntime);
  if (reloadedViewResponse.status !== 200) throw new Error("fuzu_http_restart_view_refused");
  const reloadedView = await reloadedViewResponse.json() as { generation?: unknown; turn?: { text?: unknown; generation?: unknown } };
  if (reloadedView.generation !== committedGeneration || reloadedView.turn?.generation !== committedGeneration || reloadedView.turn?.text !== receipt.text) {
    throw new Error("fuzu_http_restart_snapshot_mismatch");
  }
  const replay = await handleRequest(new Request(`${base}/player-actions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(actionBody),
  }), context.catalog, snapshots, storage, {}, {}, FUZU_BENCHMARK_PLAYER, undefined, undefined, undefined, undefined, restartRuntime);
  const replayBody = replay.status === 200 ? await replay.json() as { view?: { generation?: unknown; turn?: { text?: unknown; generation?: unknown } } } : undefined;
  if (replay.status !== 200 || narrator.calls !== 1 || replayBody?.view?.generation !== committedGeneration
    || replayBody.view?.turn?.generation !== committedGeneration || replayBody.view?.turn?.text !== receipt.text) {
    throw new Error("fuzu_http_narration_restart_replay_mismatch");
  }
  return {
    projection,
    receipt: {
      rawResponseHash: receipt.rawResponseHash,
      textHash: receipt.textHash,
      text: receipt.text,
      providerCalls: narrator.calls,
      generation: committedGeneration,
      replayedAfterRestart: true,
    },
  };
  } finally {
    for (const session of liveRegistry.values()) session.close();
    for (const session of restartRegistry.values()) session.close();
  }
}

async function defaultCurrentFuzuCompiler<T>(
  pdfPath: string,
  onResolved: (context: CurrentFuzuResolvedBenchmarkContext) => T | Promise<T>,
): Promise<T> {
  // The helper is intentionally internal to the current-schema acceptance
  // harness. A dynamic import keeps ordinary diagnostic unit tests from
  // importing/running its PDF pipeline at all.
  const harness = await import("../fuzu-current-schema-acceptance") as unknown as {
    compileCurrentFuzuAcceptance?: CurrentFuzuCompiler;
  };
  if (typeof harness.compileCurrentFuzuAcceptance !== "function") throw new Error("fuzu_current_compiler_unavailable");
  return harness.compileCurrentFuzuAcceptance(pdfPath, onResolved);
}

async function withoutConsoleOutput<T>(fn: () => Promise<T>): Promise<T> {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const suppress = () => undefined;
  console.log = suppress;
  console.warn = suppress;
  console.error = suppress;
  try {
    return await fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

class ProbeBudgetError extends Error {
  constructor(readonly code: "provider_request_budget_exhausted" | "global_deadline_reached") {
    super(code);
  }
}

/** Keep the hard output cap even when a current/future entry point passes a larger option. */
export function capProbeRequestBody(body: RequestInit["body"]): RequestInit["body"] {
  if (typeof body !== "string") return body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || typeof parsed.max_tokens !== "number" || !Number.isFinite(parsed.max_tokens)
      || parsed.max_tokens <= TWO_MODULE_NARRATIVE_LIMITS.maxTokens) return body;
    return JSON.stringify({ ...parsed, max_tokens: TWO_MODULE_NARRATIVE_LIMITS.maxTokens });
  } catch {
    // LLMClient already owns request-shape validation.  The probe must not
    // reinterpret malformed payloads or expose their text in an error.
    return body;
  }
}

const NPC_SYSTEM_PROMPT_PREAMBLE = "你是一个 TRPG 非玩家角色（NPC）。";
const NPC_SYSTEM_PROMPT_NAME_PREFIX = "你的名字:";
// This matches LLMClient's private 2 MiB non-streaming success-body ceiling.
// It is duplicated here rather than widening production exports for a diag-only
// observer, and a receipt breach aborts the original request fail-closed.
const MAX_NPC_RECEIPT_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Deliberately narrow: only the current NPCAgent system-prompt preamble plus
 * its non-empty role-name line is eligible for NPC evidence. Intent, KP, and
 * every other provider request remain unobserved for this diagnostic purpose.
 */
export function isNpcPurposeRequestBody(body: RequestInit["body"]): boolean {
  if (typeof body !== "string") return false;
  try {
    const payload: unknown = JSON.parse(body);
    if (!isRecord(payload) || !Array.isArray(payload.messages)) return false;
    return payload.messages.some((message) => {
      if (!isRecord(message) || message.role !== "system" || typeof message.content !== "string") return false;
      return message.content.startsWith(NPC_SYSTEM_PROMPT_PREAMBLE)
        && new RegExp(`(?:^|\\n)${NPC_SYSTEM_PROMPT_NAME_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\S`).test(message.content);
    });
  } catch {
    return false;
  }
}

interface ReceiptReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<unknown>;
}

interface ReceiptBody {
  getReader: () => ReceiptReader;
  cancel: () => Promise<unknown>;
}

interface ProviderReceiptResponse {
  ok: boolean;
  headers: { get: (name: string) => string | null };
  body: ReceiptBody | null;
}

function cancelReceiptReader(reader: ReceiptReader, abortRequest: () => void): void {
  abortRequest();
  // A Response clone is a tee branch. Do not await cancel: the original LLM
  // client may still be consuming its sibling and an awaited cancel can wait
  // on that sibling indefinitely.
  void reader.cancel().catch(() => undefined);
}

/**
 * Reads an already-cloned successful provider body under the same deadline as
 * the request. Only a bounded, parsed completion content hash survives; raw
 * request/response bytes never enter a report or error.
 */
export async function observeNpcProviderContent(
  response: ProviderReceiptResponse,
  signal: AbortSignal,
  abortRequest: () => void,
): Promise<string | null> {
  if (!response.ok || signal.aborted) {
    if (signal.aborted) abortRequest();
    return null;
  }
  const body = response.body;
  if (!body) return null;
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_NPC_RECEIPT_BODY_BYTES) {
    abortRequest();
    void body.cancel().catch(() => undefined);
    return null;
  }

  const reader = body.getReader();
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new Error("npc_receipt_aborted"));
  });
  const abort = () => {
    cancelReceiptReader(reader, abortRequest);
    rejectAbort();
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        cancelReceiptReader(reader, abortRequest);
        return null;
      }
      byteLength += next.value.byteLength;
      if (byteLength > MAX_NPC_RECEIPT_BODY_BYTES) {
        cancelReceiptReader(reader, abortRequest);
        return null;
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const content = extractMessageContent(JSON.parse(new TextDecoder().decode(bytes))).trim();
    return content ? sha256(new TextEncoder().encode(content)) : null;
  } catch {
    // `abort` has already cancelled the tee branch and original request. Other
    // clone parsing failures are non-evidence; they can never become success.
    return null;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

interface LiveFetchBudget {
  signal: AbortSignal;
  observed: () => number;
  npcProviderContentHashesBetween: (startExclusive: number, endInclusive: number) => Promise<string[]>;
  deadlineReached: () => boolean;
  requestBudgetReached: () => boolean;
  providerFailureCodes: () => string[];
}

/**
 * Existing KP action narration has no AbortSignal parameter.  This short-lived
 * fetch wrapper merges the probe deadline into LLMClient's own controller, so
 * the deadline reaches the real request instead of merely racing an orphan.
 */
async function withLiveFetchBudget<T>(
  fn: (budget: LiveFetchBudget) => Promise<T>,
  observeNpcReceipts = false,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  let deadlineReached = false;
  let requestBudgetReached = false;
  const providerFailureCodes = new Set<string>();
  const npcReceipts: NpcProviderContentReceipt[] = [];
  const npcReceiptTasks = new Map<number, Promise<void>>();
  const timer = setTimeout(() => {
    deadlineReached = true;
    providerFailureCodes.add("global_deadline_reached");
    controller.abort();
  }, TWO_MODULE_NARRATIVE_LIMITS.globalDeadlineMs);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (controller.signal.aborted) return Promise.reject(new ProbeBudgetError("global_deadline_reached"));
    if (calls >= TWO_MODULE_NARRATIVE_LIMITS.maxProviderRequests) {
      requestBudgetReached = true;
      providerFailureCodes.add("provider_request_budget_exhausted");
      return Promise.reject(new ProbeBudgetError("provider_request_budget_exhausted"));
    }
    const requestIndex = ++calls;
    const requestController = new AbortController();
    const abort = () => requestController.abort();
    const requestSignal = input instanceof Request ? input.signal : undefined;
    const upstream = init?.signal ?? requestSignal;
    if (controller.signal.aborted || upstream?.aborted) requestController.abort();
    else {
      controller.signal.addEventListener("abort", abort, { once: true });
      upstream?.addEventListener("abort", abort, { once: true });
    }
    const boundedBody = capProbeRequestBody(init?.body);
    const npcPurpose = observeNpcReceipts && isNpcPurposeRequestBody(boundedBody);
    let request: Promise<Response>;
    try {
      request = originalFetch(input, { ...init, ...(boundedBody !== init?.body ? { body: boundedBody } : {}), signal: requestController.signal });
    } catch (error) {
      if (!controller.signal.aborted && !upstream?.aborted) providerFailureCodes.add("provider_transport_failed");
      return Promise.reject(error).finally(() => {
        controller.signal.removeEventListener("abort", abort);
        upstream?.removeEventListener("abort", abort);
      });
    }
    let receiptTask: Promise<void> | undefined;
    if (npcPurpose) {
      // Attach to the original fetch promise before handing its Response to
      // LLMClient, ensuring clone() happens before the client locks its body.
      receiptTask = request.then(async (response) => {
        const contentHash = await observeNpcProviderContent(response.clone(), controller.signal, () => requestController.abort());
        if (contentHash) npcReceipts.push({ requestIndex, contentHash });
      }).catch(() => undefined);
      npcReceiptTasks.set(requestIndex, receiptTask);
      void receiptTask.finally(() => {
        controller.signal.removeEventListener("abort", abort);
        upstream?.removeEventListener("abort", abort);
      });
    }
    return request.catch((error) => {
      if (!controller.signal.aborted && !upstream?.aborted) providerFailureCodes.add("provider_transport_failed");
      throw error;
    }).finally(() => {
      if (!receiptTask) {
        controller.signal.removeEventListener("abort", abort);
        upstream?.removeEventListener("abort", abort);
      }
    });
  }) as typeof fetch;
  try {
    return await fn({
      signal: controller.signal,
      observed: () => calls,
      npcProviderContentHashesBetween: async (startExclusive, endInclusive) => {
        const tasks = [...npcReceiptTasks.entries()]
          .filter(([requestIndex]) => requestIndex > startExclusive && requestIndex <= endInclusive)
          .map(([, task]) => task);
        await Promise.all(tasks);
        return npcProviderContentHashesForWindow(npcReceipts, startExclusive, endInclusive);
      },
      deadlineReached: () => deadlineReached,
      requestBudgetReached: () => requestBudgetReached,
      providerFailureCodes: () => [...providerFailureCodes].sort(),
    });
  } finally {
    clearTimeout(timer);
    if (observeNpcReceipts) controller.abort();
    globalThis.fetch = originalFetch;
  }
}

function barnUnavailable(code: string): NarrativeModuleReport {
  return {
    module: "barn",
    source: { id: BARN_OF_PREMIER.id, version: BARN_OF_PREMIER.version, kind: "runtime_module_data" },
    runtime: "ordinary_game_session",
    contextualNarration: "supported",
    status: "unavailable",
    code,
    samples: [],
    quality: "not_real_model",
  };
}

function expectedBarnEntryScene(): string | null {
  const entrySceneId = BARN_OF_PREMIER.runtime?.entrySceneId ?? BARN_OF_PREMIER.scenes[0]?.id;
  if (!entrySceneId) return null;
  return BARN_OF_PREMIER.scenes.find((scene) => scene.id === entrySceneId)?.name ?? entrySceneId;
}

function verifiedBarnSource(session: GameSession): NarrativeModuleReport["source"] | null {
  // getKPState is the current public GameSession observation surface. Do not
  // inspect the session's private registered-module fields: a load response
  // can be a non-error message even when installation did not become active.
  const kpState = session.getKPState() as { module?: { id?: unknown }; scene?: unknown };
  const activeModuleId = asNonEmptyText(kpState.module?.id);
  const activeScene = asNonEmptyText(kpState.scene);
  const expectedScene = expectedBarnEntryScene();
  if (activeModuleId !== BARN_OF_PREMIER.id || !expectedScene || activeScene !== expectedScene) return null;
  return {
    id: BARN_OF_PREMIER.id,
    version: BARN_OF_PREMIER.version,
    kind: "runtime_module_data",
    verifiedActive: { moduleId: activeModuleId, entryScene: activeScene, observedVia: "public_kp_state" },
  };
}

async function sampleBarn(
  config: LLMConfig,
  mode: TwoModuleNarrativeMode,
  budget?: LiveFetchBudget,
  focus?: TwoModuleNarrativeFocus,
): Promise<NarrativeModuleReport> {
  const session = new GameSession(
    `two-module-narrative-barn-${crypto.randomUUID()}`,
    "cosmic-horror",
    config,
    "investigator",
    "诊断调查员",
    undefined,
    undefined,
    undefined,
    "preferred",
    { careerEntryPersistence: "transient" },
  );
  const samples: PlayerFacingSample[] = [];
  const provider = mode === "live" ? "provider" : "mock";
  try {
    const loaded = await session.act("加载模组 普瑞米尔的谷仓");
    if (loaded.error) return { ...barnUnavailable(publicCode(loaded.error.code, "barn_load_failed")), status: "refused", samples: [sampleFromActionResponse("action", loaded, "template")] };
    const source = verifiedBarnSource(session);
    // handleLoadModule intentionally translates loader failures into player
    // messages. Sampling must therefore require the active public identity,
    // rather than treating a lack of response.error as a successful Barn load.
    if (!source) return { ...barnUnavailable("barn_module_not_active"), status: "refused", samples };
    if (focus === "npc") {
      // Focus mode deliberately spends its fixed request/deadline budget on
      // two ordinary GameSession dialogue actions, not an opening/KP look.
      // Each receipt window uses dispatch ordinal boundaries, never settle
      // order, so a late earlier provider request cannot earn later evidence.
      const focusedInputs = [
        "与菲碧·特里坎交谈，询问她最后一次见到儿子是什么时候？",
        "继续追问菲碧·特里坎：确切是几月几日、几点钟？",
      ];
      for (const input of focusedInputs) {
        const startExclusive = budget?.observed() ?? 0;
        try {
          const response = await session.act(input);
          const endInclusive = budget?.observed() ?? startExclusive;
          const hashes = mode === "live" && budget
            ? await budget.npcProviderContentHashesBetween(startExclusive, endInclusive)
            : [];
          samples.push(focusedNpcSample(response, mode, hashes));
        } catch {
          samples.push({
            step: "npc",
            status: "error",
            provenance: mode === "offline" ? "mock" : "provider_unobservable",
            text: "",
            errorCode: "session_action_failed",
            leakFlags: [],
          });
        }
      }
      return {
        module: "barn",
        source,
        runtime: "ordinary_game_session",
        contextualNarration: "supported",
        status: "sampled",
        samples,
        quality: mode === "live" && samples.some((sample) => sample.provenance === "provider")
          ? "provider_npc_observed"
          : "not_real_model",
      };
    }

    let openingStatus: "ready" | "fallback" = "fallback";
    let providerOpeningObserved = false;
    const opening = await session.getOpeningScene(budget?.signal, (result) => {
      openingStatus = result.status;
      providerOpeningObserved = result.status === "ready";
    });
    samples.push(openingSample(opening, openingStatus, provider));

    // These inputs deliberately stay at the entry scene and name no clue/item.
    // They exercise the public GameSession/KP/NPC route without force-granting
    // discoveries or selecting hidden mechanics.
    const actions: Array<[Extract<PlayerFacingSample["step"], "look" | "npc" | "action">, string]> = [
      ["look", "环顾四周"],
      ["npc", "和菲碧·特里坎交谈，询问她最后一次见到加比是什么时候"],
      ["action", "停下来仔细倾听院里的动静"],
    ];
    for (const [step, input] of actions) {
      try {
        const response = await session.act(input);
        const provenance = mode === "offline"
          ? "mock"
          : response.narrative.includes(DEGRADATION_NOTICE) || response.narrative.includes(KP_NARRATION_UNAVAILABLE_NOTICE)
            ? "fallback" : "provider_unobservable";
        const sample = sampleFromActionResponse(step, response, provenance);
        if (provenance === "fallback" && !sample.errorCode) {
          samples.push({ ...sample, status: "fallback", errorCode: "provider_fallback" });
        } else samples.push(sample);
      } catch {
        samples.push({ step, status: "error", provenance: mode === "offline" ? "mock" : "provider_unobservable", text: "", errorCode: "session_action_failed", leakFlags: [] });
        break;
      }
    }
    providerOpeningObserved &&= mode === "live";
    return {
      module: "barn",
      source,
      runtime: "ordinary_game_session",
      contextualNarration: "supported",
      status: "sampled",
      samples,
      quality: providerOpeningObserved ? "provider_opening_observed" : "not_real_model",
    };
  } catch {
    return { ...barnUnavailable("barn_session_failed"), status: "refused", samples };
  } finally {
    session.close();
  }
}

type ValidCurrentFuzuNarration = {
  artifactHash: string;
  documentHash: string;
  sourceGraphIdentity: string;
  mechanicsHash: string;
  receipt: FuzuNarrationReceipt;
};

function validateCurrentFuzuNarration(
  value: unknown,
  expectedDocumentHash: string,
): { ok: true; value: ValidCurrentFuzuNarration } | { ok: false; code: "fuzu_current_compile_invalid" | "fuzu_module_mismatch" | "fuzu_http_receipt_invalid" } {
  if (!isRecord(value) || !isRecord(value.artifact) || !isRecord(value.payload) || !isRecord(value.projection) || !isRecord(value.receipt)
    || !isRecord(value.payload.identity) || !isRecord(value.receipt)) return { ok: false, code: "fuzu_current_compile_invalid" };
  const pair = validateFuzuArtifactPair(value.artifact, value.projection);
  if (!pair.ok) return pair;
  const identity = value.payload.identity;
  const documentHash = asNonEmptyText(identity.documentHash);
  const sourceGraphIdentity = asNonEmptyText(identity.sourceGraphIdentity);
  const mechanicsHash = asNonEmptyText(identity.mechanicsHash);
  const rawResponseHash = asNonEmptyText(value.receipt.rawResponseHash);
  const textHash = asNonEmptyText(value.receipt.textHash);
  const generation = value.receipt.generation;
  if (documentHash !== expectedDocumentHash || !isSha256(pair.artifactHash) || !isSha256(documentHash)
    || !isSha256(sourceGraphIdentity) || !isSha256(mechanicsHash)) return { ok: false, code: "fuzu_module_mismatch" };
  if (!isSha256(rawResponseHash) || !isSha256(textHash) || rawResponseHash === textHash
    || value.receipt.providerCalls !== 1 || generation !== 1 || value.receipt.replayedAfterRestart !== true) {
    return { ok: false, code: "fuzu_http_receipt_invalid" };
  }
  return { ok: true, value: { artifactHash: pair.artifactHash, documentHash, sourceGraphIdentity, mechanicsHash, receipt: value.receipt as unknown as FuzuNarrationReceipt } };
}

/**
 * The current-PDF benchmark must not put an exception message in a player or
 * diagnostic report: prepare errors can contain response bodies, and callback
 * failures can carry source-bearing assertion detail.  Keep only an explicit
 * phase/code allow-list so a refusal remains actionable without exposing that
 * material.
 */
function fuzuBenchmarkFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("EPERM")) return "fuzu_current_environment_unavailable";
  if (message.includes("PREPARE_ISOLATION_UNAVAILABLE")) return "fuzu_current_prepare_isolation_unavailable";
  if (message.startsWith("internal HTTP prepare status")) return "fuzu_current_prepare_failed";
  const callbackCode = /\b(fuzu_(?:presentation|trusted|http|compiled_narration)_[a-z_]+)\b/.exec(message)?.[1];
  if (callbackCode) return callbackCode;
  return "fuzu_current_compile_failed";
}

async function sampleFuzu(
  compileCurrentFuzuAcceptance: CurrentFuzuCompiler,
  mode: TwoModuleNarrativeMode,
  config: LLMConfig,
): Promise<NarrativeModuleReport> {
  const input = fuzuSourceInput();
  const source: NarrativeModuleReport["source"] = {
    id: "fuzu",
    version: "unknown",
    kind: "compiled_artifact",
    ...(input.ok
      ? { currentPdfBenchmark: { provenance: "current_pdf_benchmark_hints", documentHash: input.documentHash } }
      : {}),
  };
  if (!input.ok) {
    return { module: "fuzu", source, runtime: "compiled_game_session", contextualNarration: "unsupported", status: "unavailable", code: "fuzu_current_source_unavailable", samples: [], quality: "incomplete" };
  }
  let compiled: unknown;
  try {
    const narrator = mode === "offline" ? fuzuLocalNarrator() : new LLMClient(config);
    // The callback runs while the fresh current-PDF catalog is still owned by
    // the internal acceptance helper.  It uses no old artifacts or direct
    // GameSession command path; all player operations remain HTTP façade
    // requests over the source-exact trusted bundle.
    compiled = await withoutConsoleOutput(() => compileCurrentFuzuAcceptance(input.path, async (context) => {
      const narrated = await runTrustedFuzuHttpNarration(context, narrator);
      return {
        artifact: context.resolvedArtifact,
        payload: context.payload,
        projection: narrated.projection,
        receipt: narrated.receipt,
      };
    }));
  } catch (error) {
    return { module: "fuzu", source, runtime: "compiled_game_session", contextualNarration: "unsupported", status: "refused", code: fuzuBenchmarkFailureCode(error), samples: [], quality: "incomplete" };
  }
  const valid = validateCurrentFuzuNarration(compiled, input.documentHash);
  if (!valid.ok) return { module: "fuzu", source, runtime: "compiled_game_session", contextualNarration: "unsupported", status: "refused", code: valid.code, samples: [], quality: "incomplete" };
  source.artifactHash = valid.value.artifactHash;
  source.currentPdfBenchmark = {
    provenance: "current_pdf_benchmark_hints",
    documentHash: valid.value.documentHash,
    sourceGraphIdentity: valid.value.sourceGraphIdentity,
    mechanicsHash: valid.value.mechanicsHash,
    // This is still a benchmark built with explicit/deterministic hints. It
    // has no claim to be a fresh autonomous two-module publication.
  };
  const receipt = valid.value.receipt;
  return {
    module: "fuzu",
    source,
    runtime: "compiled_game_session",
    contextualNarration: "supported",
    status: "sampled",
    samples: [{
      step: "action",
      status: "ready",
      provenance: mode === "offline" ? "mock" : "provider",
      text: sanitizePlayerText(receipt.text),
      leakFlags: leakFlags(receipt.text),
      narrationReceipt: {
        rawResponseHash: receipt.rawResponseHash,
        textHash: receipt.textHash,
        replayedAfterRestart: receipt.replayedAfterRestart,
      },
    }],
    quality: mode === "offline" ? "not_real_model" : "provider_compiled_narration_observed",
  };
}

function unavailableReport(mode: TwoModuleNarrativeMode, availability: TwoModuleNarrativeReport["model"]["availability"], code: string): TwoModuleNarrativeReport {
  return {
    schemaVersion: TWO_MODULE_NARRATIVE_SCHEMA_VERSION,
    mode,
    model: { requested: mode === "live" ? "live_provider" : "offline_mock", availability, maxTokens: TWO_MODULE_NARRATIVE_LIMITS.maxTokens, maxAttempts: TWO_MODULE_NARRATIVE_LIMITS.maxAttempts },
    budget: { ...TWO_MODULE_NARRATIVE_LIMITS, observedProviderRequests: 0, deadlineReached: false, requestBudgetReached: false, providerFailureCodes: [] },
    comparison: "incomplete_compiled_contextual_narration_unsupported",
    modules: [barnUnavailable(code), {
      module: "fuzu",
      source: { id: "fuzu", version: "unknown", kind: "compiled_artifact" },
      runtime: "compiled_game_session",
      contextualNarration: "unsupported",
      status: "unavailable",
      code,
      samples: [],
      quality: "incomplete",
    }],
  };
}

/** This is the only runner entry point; offline never calls loadConfig or fetch. */
export async function runTwoModuleNarrativeProbe(
  command: Extract<TwoModuleNarrativeArgs, { ok: true }>,
  dependencies: TwoModuleNarrativeProbeDependencies = {},
): Promise<TwoModuleNarrativeReport> {
  const compileFuzu = dependencies.compileCurrentFuzuAcceptance ?? defaultCurrentFuzuCompiler;
  if (command.mode === "offline") {
    const [barn, fuzu] = await Promise.all([sampleBarn(OFFLINE_CONFIG, "offline", undefined, command.focus), sampleFuzu(compileFuzu, "offline", OFFLINE_CONFIG)]);
    return {
      schemaVersion: TWO_MODULE_NARRATIVE_SCHEMA_VERSION,
      mode: "offline",
      model: { requested: "offline_mock", availability: "offline", modelFingerprint: "model-offline", maxTokens: TWO_MODULE_NARRATIVE_LIMITS.maxTokens, maxAttempts: TWO_MODULE_NARRATIVE_LIMITS.maxAttempts },
      budget: { ...TWO_MODULE_NARRATIVE_LIMITS, observedProviderRequests: 0, deadlineReached: false, requestBudgetReached: false, providerFailureCodes: [] },
      comparison: "incomplete_current_pdf_benchmark_hints",
      modules: [barn, fuzu],
    };
  }

  const documents = documentHashes();
  if (!documents.ok) return unavailableReport("live", "document_unavailable", "document_unavailable");
  if (!uploadsAreAuthorized(documents.hashes, command.allowedDocumentHashes)) {
    return unavailableReport("live", "upload_authorization_required", "upload_authorization_required");
  }
  const disabled = llmDisabledByOverride();
  if (disabled) return unavailableReport("live", "model_disabled", "model_disabled");
  const config = cappedLiveConfig(loadConfig());
  const availability = liveModelAvailability(config, false);
  if (availability !== "ready") return unavailableReport("live", availability, availability);

  return withLiveFetchBudget(async (budget) => {
    const [barn, fuzu] = await Promise.all([sampleBarn(config, "live", budget, command.focus), sampleFuzu(compileFuzu, "live", config)]);
    return {
      schemaVersion: TWO_MODULE_NARRATIVE_SCHEMA_VERSION,
      mode: "live",
      model: {
        requested: "live_provider",
        availability: "ready",
        modelFingerprint: `model-${sha256(new TextEncoder().encode(config.model))}`,
        maxTokens: config.maxTokens,
        maxAttempts: TWO_MODULE_NARRATIVE_LIMITS.maxAttempts,
      },
      budget: {
        ...TWO_MODULE_NARRATIVE_LIMITS,
        observedProviderRequests: budget.observed(),
        deadlineReached: budget.deadlineReached(),
        requestBudgetReached: budget.requestBudgetReached(),
        providerFailureCodes: budget.providerFailureCodes(),
      },
      comparison: "incomplete_current_pdf_benchmark_hints",
      modules: [barn, fuzu],
    };
  }, command.focus === "npc");
}

function safeSample(sample: PlayerFacingSample) {
  return {
    step: sample.step,
    status: sample.status,
    provenance: sample.provenance,
    text: sanitizePlayerText(sample.text),
    ...(sample.errorCode ? { errorCode: publicCode(sample.errorCode) } : {}),
    leakFlags: sample.leakFlags.filter((flag) => /^[a-z_]{1,80}$/.test(flag)),
    ...(isSha256(sample.dialogueHash) ? { dialogueHash: sample.dialogueHash } : {}),
    ...(Array.isArray(sample.observedProviderContentHashes)
      ? { observedProviderContentHashes: sample.observedProviderContentHashes.filter(isSha256).slice(0, TWO_MODULE_NARRATIVE_LIMITS.maxProviderRequests) }
      : {}),
    ...(isSha256(sample.matchingProviderContentHash) ? { matchingProviderContentHash: sample.matchingProviderContentHash } : {}),
    ...(sample.narrationReceipt
      && isSha256(sample.narrationReceipt.rawResponseHash)
      && isSha256(sample.narrationReceipt.textHash)
      && sample.narrationReceipt.rawResponseHash !== sample.narrationReceipt.textHash
      ? {
          narrationReceipt: {
            rawResponseHash: sample.narrationReceipt.rawResponseHash,
            textHash: sample.narrationReceipt.textHash,
            replayedAfterRestart: sample.narrationReceipt.replayedAfterRestart === true,
          },
        }
      : {}),
  };
}

/** Whitelist report fields; never stringify a caught error, config object, or provider response. */
export function renderSanitizedTwoModuleNarrativeReport(report: TwoModuleNarrativeReport): string {
  return JSON.stringify({
    schemaVersion: TWO_MODULE_NARRATIVE_SCHEMA_VERSION,
    mode: report.mode === "live" ? "live" : "offline",
    model: {
      requested: report.model.requested,
      availability: report.model.availability,
      ...(report.model.modelFingerprint && /^model-[a-f0-9-]{1,80}$/.test(report.model.modelFingerprint) ? { modelFingerprint: report.model.modelFingerprint } : {}),
      maxTokens: report.model.maxTokens,
      maxAttempts: report.model.maxAttempts,
    },
    budget: report.budget,
    comparison: report.comparison,
    modules: report.modules.map((module) => ({
      module: module.module,
      source: {
        id: module.source.id === "premiers_barn" || module.source.id === "fuzu" ? module.source.id : "redacted",
        // Fuzu's acceptance projection intentionally binds presentation text
        // directly to the PDF. It is not a safe version field for this
        // player-facing evidence report, so emit a fixed provenance label.
        version: module.source.id === "premiers_barn" && module.source.version === BARN_OF_PREMIER.version
          ? BARN_OF_PREMIER.version
          : module.source.id === "fuzu" && module.source.currentPdfBenchmark
            ? "current_pdf_benchmark_hints"
            : "unknown",
        kind: module.source.kind,
        ...(module.source.artifactHash && /^[a-f0-9]{64}$/.test(module.source.artifactHash) ? { artifactHash: module.source.artifactHash } : {}),
        ...(module.source.currentPdfBenchmark
          && /^[a-f0-9]{64}$/.test(module.source.currentPdfBenchmark.documentHash)
          ? {
              currentPdfBenchmark: {
                provenance: "current_pdf_benchmark_hints",
                documentHash: module.source.currentPdfBenchmark.documentHash,
                ...(module.source.currentPdfBenchmark.sourceGraphIdentity && /^[a-f0-9]{64}$/.test(module.source.currentPdfBenchmark.sourceGraphIdentity)
                  ? { sourceGraphIdentity: module.source.currentPdfBenchmark.sourceGraphIdentity } : {}),
                ...(module.source.currentPdfBenchmark.mechanicsHash && /^[a-f0-9]{64}$/.test(module.source.currentPdfBenchmark.mechanicsHash)
                  ? { mechanicsHash: module.source.currentPdfBenchmark.mechanicsHash } : {}),
                ...(typeof module.source.currentPdfBenchmark.reachableEndingCount === "number"
                  && Number.isSafeInteger(module.source.currentPdfBenchmark.reachableEndingCount)
                  && module.source.currentPdfBenchmark.reachableEndingCount >= 0
                  && module.source.currentPdfBenchmark.reachableEndingCount <= 1000
                  ? { reachableEndingCount: module.source.currentPdfBenchmark.reachableEndingCount } : {}),
              },
            }
          : {}),
        ...(module.source.verifiedActive
          && module.source.verifiedActive.moduleId === "premiers_barn"
          && module.source.verifiedActive.observedVia === "public_kp_state"
          ? {
              verifiedActive: {
                moduleId: module.source.verifiedActive.moduleId,
                entryScene: sanitizePlayerText(module.source.verifiedActive.entryScene).slice(0, 200),
                observedVia: "public_kp_state",
              },
            }
          : {}),
      },
      runtime: module.runtime,
      contextualNarration: module.contextualNarration,
      status: module.status,
      ...(module.code ? { code: publicCode(module.code) } : {}),
      samples: module.samples.map(safeSample),
      quality: module.quality,
    })),
  });
}

function saveTempReport(report: TwoModuleNarrativeReport): string {
  const directory = mkdtempSync(join(tmpdir(), "aitrpg-two-module-narrative-"));
  const path = join(directory, "report.json");
  writeFileSync(path, `${renderSanitizedTwoModuleNarrativeReport(report)}\n`, "utf8");
  return path;
}

async function main(): Promise<void> {
  const parsed = parseTwoModuleNarrativeArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.code}\n`);
    process.exitCode = 2;
    return;
  }
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    const report = await runTwoModuleNarrativeProbe(parsed);
    const path = saveTempReport(report);
    console.log = originalLog;
    console.warn = originalWarn;
    process.stdout.write(`${path}\n`);
  } catch {
    // Do not expose an exception: it may contain provider transport details.
    const report = unavailableReport(parsed.mode, "model_unavailable", "runner_failed");
    const path = saveTempReport(report);
    console.log = originalLog;
    console.warn = originalWarn;
    process.stdout.write(`${path}\n`);
    process.exitCode = 1;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

if (import.meta.main) void main();
