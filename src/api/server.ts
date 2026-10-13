// AI Narrator HTTP Server — Bun.serve()
// 管理 GameSession 实例，暴露 REST 接口供前端调用 //
// 运行: bun run src/api/server.ts

import { GameSession, ORDINARY_OPENING_FALLBACK, acknowledgeOrdinaryDurableIdentity, appendOrdinaryHostAnnouncement, assertCompiledDurableHostCapability, assertOrdinaryDurableHostCapability, bindCompiledDurableNarrationTopic, commitCompiledDurableAction, commitCompiledDurableNarration, compiledMechanicsAction, compiledPlayerNarrationPublicRequestHash, compiledPlayerNarrationTopicTokenHash, compiledPlayerNarrationV2RequestHash, deriveCompiledIntentReplayIdentity, matchCompiledDurableNarrationTopic, prepareCompiledDurableNarration, readCompiledDurableSessionAccessBinding, readCompiledDurableSessionIdentity, resolveCompiledDurablePlayerChoice, resolveCompiledDurablePlayerFollowupContacts, runOrdinaryDurableActionTransaction, validateCompiledDurableNarrationCandidate, validateCompiledDurableNarrationReceipt, validateCompiledDurableNarrationText, type ActionResponse, type CompiledAvailableAction, type CompiledNarrationCandidate, type CompiledPlayerFollowupContact, type CompiledPlayerNarrationTopicRequest, type SessionSummary } from "./game-session";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "fs";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { join, resolve } from "path";
import type { RulesetId } from "../rules/rules-engine";
import { loadConfig } from "../config";
import {
  deleteSessionFile,
  listSessionMetadataLocators,
  listStoredSessions,
  sessionMetaExists,
} from "./session-store";
import {
  createOrdinarySessionAccessBinding,
  isOrdinarySessionAccessBinding,
  principalMatchesOrdinarySessionAccess,
  sameOrdinarySessionAccessBinding,
} from "./session-access";
import type { MessageType } from "../agent/types";
import { createOrdinarySessionWebSocketHandler, openAdmittedOrdinarySessionWebSocket, closeAdmittedOrdinarySessionWebSocket, closeAllWsClients, broadcastToSession, broadcastPerConnection, listSessionPlayerIds, wsStats, isWsRole, type WsRole, type WsConnectionData } from "./ws-handler";
import { bindShutdownSignals, createServerShutdownController } from "./server-shutdown";
import {
  bindOrdinarySessionWebSocketAdmission,
  OrdinarySessionWebSocketAdmissionController,
  type OrdinarySessionWebSocketAdmissionBinding,
} from "./ordinary-session-websocket-admission";
import { deleteModuleFile, isSafeModuleId, listSavedModules, loadModuleFile, parseMythosModule, saveModuleFile } from "./module-editor";
import { CharacterFactory } from "../character/character-factory";
import { COC_ATTRIBUTES, SKILL_NAME_MAP } from "../character/coc-character";
import {
  CareerFileStore,
  CareerProjectionPredecessorConflict,
  CareerRootLockRecoveryRequired,
  careerPortableProjectionHash,
  type CareerOrdinaryProjectionCommit,
  type CareerPortableProjectionIdentity,
} from "../character/career-file";
import { defaultScriptedSessionRegistry, type ScriptedSessionRegistry } from "./scripted-session";
import { worldModelStatus } from "./world-model-status";
import {
  authenticateCompilerPrincipal,
  handleCompiledModuleHttpRequest,
  preauthorizeCompilerHttpRoute,
  principalMatchesCompiledSessionAccess,
  principalMatchesCompiledSessionPlayerGrant,
  type CompilerPrincipal,
  type CompilerRequestAuthenticator,
  type CompiledSessionRecoverySnapshotIdentity,
  type CompiledSessionPlayerResolver,
  type CompiledWorldModelBindingResolver,
  type MachinePresentationPublisher,
} from "./compiled-module-http";
import { handleSourceResearchHttpRequest } from "./source-research-http";
import { handleSlotResearchHttpRequest } from "./slot-research-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { COMPILED_SESSION_NAMESPACE_IDENTITY_FORMAT, CompiledSessionSnapshotPersistenceError, CompiledSessionSnapshotStore, isCompiledSessionAccessBinding, validateCompiledSessionSnapshot, type CompiledSessionSnapshot } from "./compiled-session-snapshot";
import {
  OrdinarySessionSnapshotStore,
  ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  ORDINARY_SESSION_IDEMPOTENCY_LIMIT,
  ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
  createOrdinarySessionEnvelope,
  nextOrdinarySessionArchive,
  ordinaryActionRequestHash,
  ordinaryOperationRequestHash,
  validateOrdinarySessionEnvelope,
  type OrdinaryDurableOperation,
  type OrdinarySessionEnvelope,
  type OrdinarySessionSnapshotRefusalCode,
  type OrdinaryPersistedOperationRecord,
} from "./ordinary-session-snapshot-store";
import { createOrdinaryGameSessionSnapshot, ordinarySnapshotWireMatchesCurrentState, validateOrdinaryGameSessionSnapshot } from "./ordinary-game-session-snapshot";
import {
  compiledIdentityReconciliation,
  ordinaryGenerationZeroReconciliation,
  ordinarySuccessorReconciliation,
  reconciliationReason,
  SessionNamespaceCoordinator,
  SessionNamespaceFailure,
  type DurableSessionIdentity,
  type ReservationHandle,
} from "./session-namespace-coordinator";
import type { SessionNamespacePublicationGate } from "./session-namespace-publication";
import { LLMClient, type LLMLike } from "../llm/client";
import { isUsableLlmApiKey, llmEnabled } from "../llm/enabled";
import type { NormalSessionIntentClient, NormalSessionIntentPolicy } from "../llm/intent";
import { COMPILED_INTENT_LLM_TIMEOUT_MS, resolveCompiledActionIntent, validateCompiledActionIntentInput, validateCompiledActionIntentRequest, type CompiledActionIntentResolution } from "../llm/compiled-action-intent";
import { narrateCompiledPlayerCandidate, narrateCompiledPlayerFollowup, type CompiledPlayerFollowupPreviousTurn } from "../llm/compiled-player-narration";
import type { CompilerHintProposalAdapterLimits } from "./compiler-hint-proposal-adapter";
import { createBoundedCompilerAutoLlm, createServerMachinePresentationPublisher } from "./compiler-machine-presentation-publisher";
import { log } from "../log";
import { createEnvironmentPlayerDelivery, type CompiledPlayerDelivery, type CompiledPlayerFollowupBinding } from "./player-delivery";
import { CompilerAutoAdmissionController, DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG } from "./compiler-auto-admission";
import {
  OrdinaryActionAdmissionCoordinator,
  ORDINARY_ACTION_ADMISSION_FILE_NAME,
  type OrdinaryActionAdmissionFailureCode,
  type OrdinaryActionAdmissionResult,
} from "./ordinary-action-admission";
import {
  OrdinarySessionCreationAdmissionCoordinator,
  ORDINARY_SESSION_CREATION_ADMISSION_FILE_NAME,
  type OrdinarySessionCreationAdmissionResult,
} from "./ordinary-session-creation-admission";
import {
  CompiledSessionCreationAdmissionCoordinator,
  COMPILED_SESSION_CREATION_ADMISSION_FILE_NAME,
  COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
} from "./compiled-session-creation-admission";
import {
  CompiledIntentAdmissionCoordinator,
  type CompiledIntentAdmissionResult,
} from "./compiled-intent-admission";
import { CompiledNarrationAdmissionCoordinator, CompiledPlayerFollowupAdmissionCoordinator } from "./compiled-narration-admission";
import { CompiledNarrationLedger, CompiledPlayerFollowupLedger, type CompiledPlayerFollowupRecord } from "./compiled-narration-ledger";
import {
  COMPILED_INTENT_REPLAY_FILE_NAME,
  CompiledIntentReplayStore,
  type CompiledIntentReplayResult,
} from "./compiled-intent-replay";
import { serveStaticFile, type StaticDeliveryMethod } from "./static-delivery";
import {
  isDevelopmentOrTestEnvironment,
  resolveServerRuntimeConfig,
  type ServerRuntimeConfig,
} from "./server-runtime-config";
import {
  CompiledWorldModelBindingRegistry,
  disabledCompiledWorldModelBindingPolicyStatus,
  type CompiledWorldModelBindingPolicyStatus,
} from "../world/compiled-world-model-binding-registry";
export { createEnvironmentPlayerDelivery } from "./player-delivery";

// Keep the browser write contract on the same storage vocabulary that creates
// ordinary CoC sheets. A parser must reject an unknown key here rather than
// letting a later snapshot validator turn a client mistake into a 500.
const ORDINARY_CHARACTER_SKILL_KEYS = new Set(Object.values(SKILL_NAME_MAP));
const ORDINARY_CHARACTER_ATTRIBUTE_KEYS = new Set(COC_ATTRIBUTES);
const ORDINARY_CHARACTER_RESERVED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// ============================================================
// 会话存储
// ============================================================

const sessions = new Map<string, GameSession>();
const compiledSessionDiagnostics = new Map<string, { id: string; code: string; message: string }>();
const defaultCompiledSessionSnapshots = new CompiledSessionSnapshotStore();
const defaultOrdinarySessionSnapshots = new OrdinarySessionSnapshotStore();
const defaultCompilerCatalog = new CompilerArtifactCatalog();
// This process-owned object is never exported, persisted, or reflected from a
// GameSession. It is the sole authority that can consume the cross-module
// ordinary host-announcement seam for a server-created session.
const serverOrdinaryDurableHostCapability = Object.freeze(Object.create(null)) as object;
// Distinct from ordinary durability: this capability may read compiled access
// secrets and execute the durable compiled commit transaction.
const serverCompiledDurableHostCapability = Object.freeze(Object.create(null)) as object;
// A completed inventory belongs to one coordinator and the exact durable
// domain it observed. This is process-private host state, never request data.
const reconciledRuntimeSessionNamespaces = new WeakSet<SessionNamespaceCoordinator>();
interface RuntimeSessionInventoryDomain {
  ordinarySnapshotRoot: string;
  compiledSnapshotRoot: string;
  metadataRoot: string;
  careerRoot: string;
}
const reconciledRuntimeSessionInventoryDomains = new WeakMap<SessionNamespaceCoordinator, RuntimeSessionInventoryDomain>();
// One controller per server process: this is intentionally not distributed
// coordination and must not be recreated for each handleRequest invocation.
let defaultCompilerAutoAdmission: CompilerAutoAdmissionController | undefined;
function getDefaultCompilerAutoAdmission(): CompilerAutoAdmissionController {
  defaultCompilerAutoAdmission ??= new CompilerAutoAdmissionController(DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG);
  return defaultCompilerAutoAdmission;
}
const ORDINARY_SESSION_CREATION_DEFAULT_POLICY = Object.freeze({
  globalConcurrent: 2,
  perPrincipalConcurrent: 1,
  startsPerPrincipal: 4,
  windowMs: 60_000,
  maxTrackedPrincipals: 1_024,
  leaseTtlMs: 60_000,
  wholeJobDeadlineMs: 300_000,
  busyTimeoutMs: 25,
});
const defaultOrdinarySessionCreationAdmissions = new Map<string, OrdinarySessionCreationAdmissionCoordinator>();
const defaultCompiledSessionCreationAdmissions = new Map<string, CompiledSessionCreationAdmissionCoordinator>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟无操作自动清理
const ORDINARY_SESSION_ID_ATTEMPTS = 4;
function generateId(): string {
  // A session ID remains a public locator, never authorization. Use a CSPRNG
  // nevertheless so it cannot become an easy enumeration oracle.
  return randomUUID();
}

/** Server sessions use GameSession's private in-memory NPC store; request data cannot select it. */
function createServerGameSession(
  id: string,
  ruleset: RulesetId = "cosmic-horror",
  llmConfig?: ConstructorParameters<typeof GameSession>[2],
  archetypeId?: ConstructorParameters<typeof GameSession>[3],
  characterName?: ConstructorParameters<typeof GameSession>[4],
  persona?: ConstructorParameters<typeof GameSession>[5],
  storage?: ConstructorParameters<typeof GameSession>[6],
  ordinarySessionAccess?: ConstructorParameters<typeof GameSession>[7],
  intentPolicy?: ConstructorParameters<typeof GameSession>[8],
  sessionIntentClient?: NormalSessionIntentClient,
  runtimeDependencies: ConstructorParameters<typeof GameSession>[9] = {},
): GameSession {
  return new GameSession(
    id,
    ruleset,
    llmConfig,
    archetypeId,
    characterName,
    persona,
    storage,
    ordinarySessionAccess,
    intentPolicy,
    {
      ...runtimeDependencies,
      // Test/bootstrap hosts may supply a process-private capability for an
      // isolated runtime namespace. HTTP never controls this argument; the
      // production default remains the server-minted module capability.
      ordinaryDurableHostCapability: runtimeDependencies.ordinaryDurableHostCapability ?? serverOrdinaryDurableHostCapability,
      compiledDurableHostCapability: runtimeDependencies.compiledDurableHostCapability ?? serverCompiledDurableHostCapability,
      ...(sessionIntentClient === undefined ? {} : { sessionIntentClient }),
    },
  );
}

function isServerGeneratedSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/**
 * A public ID is chosen by the server, then durably reserved before any
 * constructor.  Inventory makes durable collisions visible to reserve; keep
 * sampling only on that typed collision so a normal CSPRNG collision does not
 * turn into a spurious 503.  A fixed/replayed generator produces the same ID
 * on every bounded attempt and is still refused without construction.
 */
function reserveOrdinarySessionId(
  registry: ReadonlyMap<string, GameSession>,
  nextId: () => string,
  namespace: SessionNamespaceCoordinator,
  leaseMs: number,
): { status: "reserved"; id: string; reservation: ReservationHandle } | { status: "unavailable"; failure?: SessionNamespaceFailure } {
  for (let attempt = 0; attempt < ORDINARY_SESSION_ID_ATTEMPTS; attempt++) {
    const id = nextId();
    if (!isServerGeneratedSessionId(id) || registry.has(id)) continue;
    try {
      return { status: "reserved", id, reservation: namespace.reserve({ sessionId: id, kind: "ordinary", leaseMs }) };
    } catch (error) {
      // Only a permanent collision is eligible for another fresh server ID.
      // Busy/policy/storage failures must be visible to the host as typed
      // fail-closed infrastructure responses rather than spun through as if
      // they were random UUID clashes.
      if (error instanceof SessionNamespaceFailure && error.code === "SESSION_NAMESPACE_CONFLICT") continue;
      return { status: "unavailable", failure: error instanceof SessionNamespaceFailure ? error : undefined };
    }
  }
  return { status: "unavailable", failure: new SessionNamespaceFailure("SESSION_NAMESPACE_CONFLICT", "server-generated ordinary session IDs are unavailable") };
}

function runtimeSessionNamespaceRoot(storage: { sessionRoot?: string; careerRoot?: string }): string {
  // Both durable kinds must derive this from the same host-owned root.  A
  // request never supplies this path; an upgraded/old writer mismatch is
  // rejected by the coordinator's root epoch before either store opens.
  return resolve(storage.sessionRoot ?? (storage.careerRoot ? join(storage.careerRoot, ".runtime-session-namespace") : join(process.cwd(), "data", "runtime-session-namespace")));
}

/** Match the existing durable-path comparison policy: normalize syntax on all
 * platforms and treat Windows' case-insensitive filesystem identity as one
 * path. This deliberately does not realpath a coordinator file: a symlink is
 * not an alternate admissible lock domain. */
function sameRuntimeFilesystemPath(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  let normalizedLeft: string; let normalizedRight: string;
  try {
    normalizedLeft = resolve(left);
    normalizedRight = resolve(right);
  } catch {
    return false;
  }
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** A coordinator's file, rather than merely its advertised root, is the
 * durable coordination domain. A same-root alternate filename would otherwise
 * let two workers both acquire the same session/generation/action lock. */
function hasExactOrdinaryActionAdmissionDomain(
  coordinator: Pick<OrdinaryActionAdmissionCoordinator, "file">,
  namespace: Pick<SessionNamespaceCoordinator, "root">,
): boolean {
  return sameRuntimeFilesystemPath(coordinator.file, join(namespace.root, ORDINARY_ACTION_ADMISSION_FILE_NAME));
}

function defaultOrdinarySessionCreationAdmission(root: string): OrdinarySessionCreationAdmissionCoordinator {
  const existing = defaultOrdinarySessionCreationAdmissions.get(root);
  if (existing) return existing;
  const coordinator = new OrdinarySessionCreationAdmissionCoordinator({ root, ...ORDINARY_SESSION_CREATION_DEFAULT_POLICY });
  defaultOrdinarySessionCreationAdmissions.set(root, coordinator);
  return coordinator;
}

function hasExactOrdinarySessionCreationAdmissionDomain(
  coordinator: Pick<OrdinarySessionCreationAdmissionCoordinator, "file">,
  namespace: Pick<SessionNamespaceCoordinator, "root">,
): boolean {
  return sameRuntimeFilesystemPath(coordinator.file, join(namespace.root, ORDINARY_SESSION_CREATION_ADMISSION_FILE_NAME));
}

function defaultCompiledSessionCreationAdmission(root: string): CompiledSessionCreationAdmissionCoordinator {
  const existing = defaultCompiledSessionCreationAdmissions.get(root);
  if (existing) return existing;
  const coordinator = new CompiledSessionCreationAdmissionCoordinator({ root, ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY });
  defaultCompiledSessionCreationAdmissions.set(root, coordinator);
  return coordinator;
}

/** The file identity, not a mutable advertised root, is the compiled creation lock domain. */
function hasExactCompiledSessionCreationAdmissionDomain(
  coordinator: Pick<CompiledSessionCreationAdmissionCoordinator, "file">,
  namespace: Pick<SessionNamespaceCoordinator, "root">,
): boolean {
  return sameRuntimeFilesystemPath(coordinator.file, join(namespace.root, COMPILED_SESSION_CREATION_ADMISSION_FILE_NAME));
}

function ordinarySessionCreationAdmissionResponse(
  result: Exclude<OrdinarySessionCreationAdmissionResult, { status: "acquired" }>,
): Response {
  const limited = result.status === "refused"
    && (result.code === "ORDINARY_CREATION_ADMISSION_BUSY" || result.code === "ORDINARY_CREATION_ADMISSION_RATE_LIMITED");
  return respondJson({ error: {
    stage: "admission",
    code: limited ? "ORDINARY_SESSION_CREATION_LIMITED" : "ORDINARY_SESSION_CREATION_UNAVAILABLE",
    message: limited ? "ordinary session creation is temporarily limited" : "ordinary session creation is unavailable",
  } }, limited ? 429 : 503, { "Retry-After": String(result.retryAfterSeconds) });
}

type HeldOrdinarySessionCreationAdmission = Extract<OrdinarySessionCreationAdmissionResult, { status: "acquired" }>;

/** Lease loss aborts provider work but never permits an early slot release: callers await settlement. */
function guardOrdinarySessionCreationAdmission(admission: HeldOrdinarySessionCreationAdmission, requestSignal: AbortSignal) {
  const controller = new AbortController();
  let failed = false;
  let stopped = false;
  const fail = () => { failed = true; controller.abort(); };
  const renewTimer = setInterval(() => {
    if (failed) return;
    try { if (admission.renew().status !== "active") fail(); }
    catch { fail(); }
  }, admission.renewalIntervalMs);
  renewTimer.unref?.();
  const deadlineTimer = setTimeout(fail, admission.remainingDeadlineMs());
  const combined = combineAbortSignals([requestSignal, controller.signal]);
  return {
    signal: combined.signal,
    failed: () => failed,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(renewTimer);
      clearTimeout(deadlineTimer);
      combined.dispose();
    },
  };
}

function releaseOrdinarySessionCreationAdmission(admission: HeldOrdinarySessionCreationAdmission): void {
  try { admission.release(); } catch { /* post-condition only; never reverse a durable publication */ }
}

function ordinaryActionAdmissionDomainMismatchResponse(): Response {
  return respondJson({
    error: {
      stage: "persistence",
      code: "ORDINARY_ACTION_ADMISSION_DOMAIN_MISMATCH",
      message: "ordinary action admission is unavailable",
    },
  }, 503, { "Retry-After": "1" });
}

function hasExactCompiledIntentAdmissionDomain(
  coordinator: Pick<CompiledIntentAdmissionCoordinator, "file">,
  namespace: Pick<SessionNamespaceCoordinator, "root">,
): boolean {
  return sameRuntimeFilesystemPath(coordinator.file, join(namespace.root, ".compiled-intent-admission.sqlite"));
}

/** Intent replay is a distinct local SQLite domain, never an admission alias. */
function hasExactCompiledIntentReplayDomain(
  store: Pick<CompiledIntentReplayStore, "file">,
  namespace: Pick<SessionNamespaceCoordinator, "root">,
): boolean {
  return sameRuntimeFilesystemPath(store.file, join(namespace.root, COMPILED_INTENT_REPLAY_FILE_NAME));
}

/** Retains the established compiled failure code while avoiding an anonymous
 * global configuration oracle. */
function compiledIntentAdmissionDomainMismatchResponse(): Response {
  return respondJson({
    error: {
      stage: "persistence",
      code: "COMPILED_INTENT_ADMISSION_ROOT_MISMATCH",
      message: "compiled intent admission is unavailable",
    },
  }, 503, { "Retry-After": "1" });
}

function runtimeSessionInventoryDomain(
  ordinarySnapshots: OrdinarySessionSnapshotStore,
  compiledSnapshots: CompiledSessionSnapshotStore,
  storage: { careerRoot?: string; sessionRoot?: string },
): RuntimeSessionInventoryDomain {
  return {
    ordinarySnapshotRoot: resolve(ordinarySnapshots.root),
    compiledSnapshotRoot: resolve(compiledSnapshots.root),
    metadataRoot: resolve(storage.sessionRoot
      ?? (storage.careerRoot ? resolve(storage.careerRoot, "..", "sessions") : join(process.cwd(), "data", "sessions"))),
    careerRoot: resolve(storage.careerRoot ?? join(process.cwd(), "data", "careers")),
  };
}

function sameRuntimeSessionInventoryDomain(
  left: RuntimeSessionInventoryDomain,
  right: RuntimeSessionInventoryDomain,
): boolean {
  return left.ordinarySnapshotRoot === right.ordinarySnapshotRoot
    && left.compiledSnapshotRoot === right.compiledSnapshotRoot
    && left.metadataRoot === right.metadataRoot
    && left.careerRoot === right.careerRoot;
}

function hasReconciledRuntimeSessionNamespace(
  namespace: SessionNamespaceCoordinator,
  inventoryDomain: RuntimeSessionInventoryDomain,
): boolean {
  const completedDomain = reconciledRuntimeSessionInventoryDomains.get(namespace);
  return reconciledRuntimeSessionNamespaces.has(namespace)
    && completedDomain !== undefined
    && sameRuntimeSessionInventoryDomain(completedDomain, inventoryDomain);
}

function namespaceGate(namespace: SessionNamespaceCoordinator): SessionNamespacePublicationGate {
  return { required: true, consume: namespace.consumePublicationPermit.bind(namespace) };
}

function ordinaryNamespaceIdentity(envelope: Pick<OrdinarySessionEnvelope, "envelopeHash" | "generation">): DurableSessionIdentity {
  return { hash: envelope.envelopeHash, generation: envelope.generation, format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT };
}

function compiledNamespaceIdentity(snapshot: Pick<CompiledSessionSnapshot, "snapshotHash" | "generation">): DurableSessionIdentity {
  return { hash: snapshot.snapshotHash, generation: snapshot.generation, format: COMPILED_SESSION_NAMESPACE_IDENTITY_FORMAT };
}

/** Startup hydration is allowed to construct only the namespace's exact current pointer. */
function namespaceHasCommittedIdentity(
  namespace: SessionNamespaceCoordinator,
  sessionId: string,
  kind: "ordinary" | "compiled",
  identity: DurableSessionIdentity,
): boolean {
  const record = namespace.read(sessionId);
  return record?.state === "committed"
    && record.kind === kind
    && record.expectedIdentity !== null
    && record.expectedIdentity.hash === identity.hash
    && record.expectedIdentity.generation === identity.generation
    && record.expectedIdentity.format === identity.format;
}

/**
 * Startup/request bootstrap intentionally performs no GameSession construction.
 * It converts every discoverable durable locator into namespace evidence, so a
 * mixed, malformed, metadata-only, or career-only ID is permanently gated
 * before the runtime can touch a model or career projection.
 */
export interface RuntimeSessionInventoryFileOps {
  exists(path: string): boolean;
  readdir(path: string): string[];
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
}

const nodeRuntimeSessionInventoryFileOps: RuntimeSessionInventoryFileOps = {
  exists: existsSync,
  readdir: readdirSync,
  lstat: lstatSync,
};

export function reconcileRuntimeSessionNamespace(
  namespace: SessionNamespaceCoordinator,
  ordinarySnapshots: OrdinarySessionSnapshotStore,
  compiledSnapshots: CompiledSessionSnapshotStore,
  storage: { careerRoot?: string; sessionRoot?: string },
  inventoryOps: RuntimeSessionInventoryFileOps = nodeRuntimeSessionInventoryFileOps,
): void {
  const inventoryDomain = runtimeSessionInventoryDomain(ordinarySnapshots, compiledSnapshots, storage);
  // An explicit re-run is always real work. If it fails part way through, the
  // coordinator is no longer eligible for request-time skipping.
  reconciledRuntimeSessionNamespaces.delete(namespace);
  reconciledRuntimeSessionInventoryDomains.delete(namespace);
  namespace.initialize();
  namespace.reconcile();
  const observed = new Set<string>();
  // A session ID may have evidence in both durable stores.  Keep the legacy
  // broad "observed" set for metadata/career-only projection checks, but
  // track the authoritative store kind separately: suppressing the second
  // store would silently adopt one half of an ordinary-vs-compiled collision.
  const observedKinds = new Map<string, Set<"ordinary" | "compiled">>();
  const reconcile = (
    sessionId: string,
    kind: "ordinary" | "compiled",
    identity: DurableSessionIdentity | undefined,
    reason: string | undefined,
    observedPredecessorHash?: string | null,
  ) => {
    if (!isServerGeneratedSessionId(sessionId)) return;
    if (identity) {
      if (kind === "compiled") namespace.reconcileObserved(compiledIdentityReconciliation(sessionId, identity));
      else if (identity.generation === 0) {
        if (observedPredecessorHash !== null) throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "ordinary generation-zero startup observation has an invalid predecessor binding");
        namespace.reconcileObserved(ordinaryGenerationZeroReconciliation(sessionId, identity));
      } else {
        if (typeof observedPredecessorHash !== "string") throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "ordinary startup observation is missing its predecessor binding");
        namespace.reconcileObserved(ordinarySuccessorReconciliation(sessionId, identity, observedPredecessorHash));
      }
    } else namespace.reconcileObserved(reconciliationReason(sessionId, kind, reason ?? "NAMESPACE_LOCATOR_INVALID"));
    observed.add(sessionId);
    const kinds = observedKinds.get(sessionId) ?? new Set<"ordinary" | "compiled">();
    kinds.add(kind); observedKinds.set(sessionId, kinds);
  };
  for (const header of ordinarySnapshots.listHeaders()) {
    if (header.status !== "ok") { if (header.sessionId) reconcile(header.sessionId, "ordinary", undefined, "ORDINARY_LOCATOR_INVALID"); continue; }
    const value = ordinarySnapshots.read(header.value.sessionId);
    if (value.status === "ok") {
      const envelope = value.value;
      // A store pointer can become durable inside the namespace publication
      // callback just before the SQLite commit/acknowledgement. Pass its
      // native predecessor binding to the coordinator; it compares that
      // value to N under the same transaction that adopts E, with no
      // server-side read/reconcile TOCTOU interval.
      reconcile(
        envelope.sessionId,
        "ordinary",
        ordinaryNamespaceIdentity(envelope),
        undefined,
        envelope.generation === 0 ? null : envelope.previousEnvelopeHash,
      );
    }
    else reconcile(header.value.sessionId, "ordinary", undefined, "ORDINARY_LOCATOR_INVALID");
  }
  for (const header of compiledSnapshots.listHeaders()) {
    if (header.status !== "ok") { if (header.sessionId) reconcile(header.sessionId, "compiled", undefined, "COMPILED_LOCATOR_INVALID"); continue; }
    const value = compiledSnapshots.read(header.value.sessionId);
    if (value.status === "ok" && value.value && typeof value.value === "object") {
      const snapshot = value.value as CompiledSessionSnapshot;
      reconcile(snapshot.sessionId, "compiled", compiledNamespaceIdentity(snapshot), undefined);
    } else reconcile(header.value.sessionId, "compiled", undefined, "COMPILED_LOCATOR_INVALID");
  }
  // Headerless immutable bodies/receipts are never an adoption candidate.
  // They prove a crashed/partial write claimed the public ID, so retain a
  // durable quarantine instead of letting an allocator or other kind reuse it.
  for (const sessionId of ordinarySnapshots.listOccupiedSessionIds()) {
    if (!observedKinds.get(sessionId)?.has("ordinary")) reconcile(sessionId, "ordinary", undefined, "ORDINARY_PARTIAL");
  }
  for (const sessionId of compiledSnapshots.listOccupiedSessionIds()) {
    if (!observedKinds.get(sessionId)?.has("compiled")) reconcile(sessionId, "compiled", undefined, "COMPILED_PARTIAL");
  }
  // Legacy metadata and career projections are no longer an authority.  They
  // are still durable collision evidence, so quarantine them rather than
  // treating a partially written legacy create as an allocatable hole.
  // Hosts that inject only a career root (the compiled lifecycle and older
  // embedders do this) own the sibling `sessions` directory as well.  Falling
  // back to this process's unrelated working-directory metadata would both
  // leak collision evidence across tenants and turn each request bootstrap
  // into an unbounded scan of the host application's global legacy store.
  const { metadataRoot, careerRoot } = inventoryDomain;
  for (const locator of listSessionMetadataLocators(metadataRoot)) {
    if (!isServerGeneratedSessionId(locator.id)) continue;
    // An unsafe leaf or invalid JSON is evidence even if a snapshot with the
    // same ID exists: legacy metadata is outside the immutable-store trust
    // boundary and must not be silently ignored into an adoptable hybrid.
    if (locator.kind !== "regular" || locator.metadata !== "valid") {
      reconcile(locator.id, "ordinary", undefined, "METADATA_LOCATOR_INVALID");
      continue;
    }
    if (!observed.has(locator.id)) reconcile(locator.id, "ordinary", undefined, "METADATA_ONLY");
  }
  if (inventoryOps.exists(careerRoot)) {
    const root = inventoryOps.lstat(careerRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("career root must be a real directory for namespace inventory");
    }
    for (const name of inventoryOps.readdir(careerRoot)) {
      if (!isServerGeneratedSessionId(name)) continue;
      const entry = inventoryOps.lstat(join(careerRoot, name));
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        reconcile(name, "ordinary", undefined, "CAREER_LOCATOR_INVALID");
        continue;
      }
      if (!observed.has(name)) reconcile(name, "ordinary", undefined, "CAREER_ONLY");
    }
  }
  // A fake inventory seam may intentionally hide files for an isolated test;
  // it must never attest that production requests can skip their real scan.
  // Only the default Node filesystem pass marks this coordinator/domain ready.
  if (inventoryOps === nodeRuntimeSessionInventoryFileOps) {
    reconciledRuntimeSessionInventoryDomains.set(namespace, inventoryDomain);
    reconciledRuntimeSessionNamespaces.add(namespace);
  }
}

/** Expiry evicts every durable session from memory only; its restart envelope is retained. */
export function cleanupExpiredSessions(
  sessionMap: Map<string, Pick<GameSession, "lastActiveAt"> & { hasActiveActionTransactions?: boolean; close?: () => void }>,
  options: { now?: number; timeoutMs?: number; deleteMetadata: (id: string) => void; isDurableCompiled?: (session: Pick<GameSession, "lastActiveAt">) => boolean; isDurableOrdinary?: (session: Pick<GameSession, "lastActiveAt">) => boolean; logError?: (error: unknown) => void },
): string[] {
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? SESSION_TIMEOUT_MS;
  const removed: string[] = [];
  for (const [id, session] of sessionMap) {
    // A durable ordinary transaction stages its action on a candidate, so the
    // registry source's timestamp cannot reflect the candidate's activity.
    // Its FIFO still owns source installation until the transaction settles.
    if (session.hasActiveActionTransactions) continue;
    if (now - session.lastActiveAt <= timeoutMs) continue;
    try {
      if (options.isDurableCompiled?.(session) || options.isDurableOrdinary?.(session)) {
        sessionMap.delete(id);
        try { session.close?.(); } catch (error) { options.logError?.(error); }
        removed.push(id);
        continue;
      }
      options.deleteMetadata(id);
      sessionMap.delete(id);
      try { session.close?.(); } catch (error) { options.logError?.(error); }
      removed.push(id);
    } catch (error) {
      options.logError?.(error);
    }
  }
  return removed;
}

/**
 * Cleanup may run after an earlier fail-stop has closed an ordinary durable
 * object. Its immutable durable identity remains diagnostic metadata, while
 * normal runtime accessors are deliberately unavailable after close.
 */
export function isDurableOrdinarySessionForCleanup(
  session: Pick<GameSession, "getOrdinaryDurableIdentity">,
): boolean {
  // The identity is explicitly retained after close for retirement and
  // fencing diagnostics. Runtime access/generation bindings are unavailable
  // by design once a session has fail-stopped.
  return session.getOrdinaryDurableIdentity() !== null;
}

export interface CompiledSessionHydrationOptions {
  sessions?: Map<string, GameSession>;
  diagnostics?: Map<string, { id: string; code: string; message: string }>;
  catalog?: CompilerArtifactCatalog;
  snapshots?: CompiledSessionSnapshotStore;
  /** Required by production bootstrap; omitted only by isolated store tests. */
  sessionNamespace?: SessionNamespaceCoordinator;
  /** Exact server/test capability installed in every compiled restore target. */
  compiledDurableHostCapability?: object;
  createSession?: (
    id: string,
    runtimeDependencies: { compiledDurableHostCapability: object },
  ) => GameSession;
}

export type CompiledSessionHydrationResult =
  | { status: "ok"; session: GameSession; identity: CompiledSessionRecoverySnapshotIdentity }
  | { status: "refused"; code: string; message: string };

/**
 * Reconstruct one compiled session from the durable authority without
 * registering it.  Startup hydration, request-time recovery, and creation
 * recovery deliberately share this verifier so they cannot disagree about
 * what is safe to install.
 */
export function hydrateCompiledSession(sessionId: string, options: CompiledSessionHydrationOptions = {}): CompiledSessionHydrationResult {
  const catalog = options.catalog ?? defaultCompilerCatalog;
  const snapshots = options.snapshots ?? defaultCompiledSessionSnapshots;
  const durableHostCapability = options.compiledDurableHostCapability ?? serverCompiledDurableHostCapability;
  const createSession = options.createSession
    ?? ((id: string, runtimeDependencies: { compiledDurableHostCapability: object }) => createServerGameSession(
      id,
      "cosmic-horror",
      loadConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { compiledDurableHostCapability: runtimeDependencies.compiledDurableHostCapability },
    ));
  try {
    const header = snapshots.readHeader(sessionId);
    if (header.status === "refused") return header;
    if (options.sessionNamespace && !namespaceHasCommittedIdentity(
      options.sessionNamespace,
      header.value.sessionId,
      "compiled",
      compiledNamespaceIdentity(header.value),
    )) {
      return { status: "refused", code: "SNAPSHOT_CONFLICT", message: "compiled snapshot is not the committed runtime namespace identity" };
    }
    const bundle = catalog.loadBundle(header.value.bundleId);
    if (bundle.status === "refused") return bundle;
    const raw = snapshots.read(header.value.sessionId);
    if (raw.status === "refused") return raw;
    const checked = GameSession.validateCompiledSessionRestore(raw.value, bundle.value, header.value.sessionId);
    if (checked.status === "refused") return checked;
    if (checked.snapshot.bundle.id !== header.value.bundleId || checked.snapshot.snapshotHash !== header.value.snapshotHash || checked.snapshot.generation !== header.value.generation) {
      return { status: "refused", code: "SNAPSHOT_CORRUPT", message: "snapshot header and body identities do not agree" };
    }
    const session = createSession(checked.snapshot.sessionId, { compiledDurableHostCapability: durableHostCapability });
    assertCompiledDurableHostCapability(session, durableHostCapability);
    const restored = session.restoreCompiledSession(checked.snapshot, bundle.value);
    if (restored.status === "refused") {
      session.close();
      return restored;
    }
    return {
      status: "ok",
      session,
      identity: {
        sessionId: checked.snapshot.sessionId,
        bundleId: checked.snapshot.bundle.id,
        generation: checked.snapshot.generation,
        snapshotHash: checked.snapshot.snapshotHash,
      },
    };
  } catch (error) {
    return { status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: error instanceof Error ? error.message : "compiled session hydration failed" };
  }
}

function sameCompiledSessionRecoveryIdentity(
  left: CompiledSessionRecoverySnapshotIdentity,
  right: CompiledSessionRecoverySnapshotIdentity,
): boolean {
  return left.sessionId === right.sessionId
    && left.bundleId === right.bundleId
    && left.generation === right.generation
    && left.snapshotHash === right.snapshotHash;
}

/** A registry object is reusable only when its own immutable snapshot is exact. */
function sessionMatchesCompiledSessionRecoveryIdentity(
  session: GameSession,
  expected: CompiledSessionRecoverySnapshotIdentity,
  durableHostCapability: object = serverCompiledDurableHostCapability,
): boolean {
  try {
    const snapshot = readCompiledDurableSessionIdentity(session, durableHostCapability);
    if (!snapshot) return false;
    return sameCompiledSessionRecoveryIdentity({
      sessionId: snapshot.sessionId,
      bundleId: snapshot.bundleId,
      generation: snapshot.generation,
      snapshotHash: snapshot.snapshotHash,
    }, expected);
  } catch {
    return false;
  }
}

/** A live compiled object is usable only while its immutable body is still the
 * exact pointer committed in the shared namespace.  A matching kind alone
 * cannot authorize a post-publication store successor. */
function sessionMatchesCommittedCompiledNamespace(
  session: GameSession,
  namespace: SessionNamespaceCoordinator,
  durableHostCapability: object = serverCompiledDurableHostCapability,
): boolean {
  try {
    const snapshot = readCompiledDurableSessionIdentity(session, durableHostCapability);
    if (!snapshot) return false;
    return namespaceHasCommittedIdentity(
      namespace,
      snapshot.sessionId,
      "compiled",
      compiledNamespaceIdentity(snapshot),
    );
  } catch {
    return false;
  }
}

/** Injectable startup loader. It catalog-validates before decoding state and never constructs invalid sessions. */
export function hydrateCompiledSessions(options: CompiledSessionHydrationOptions = {}): { hydrated: string[]; unavailable: Array<{ id: string; code: string; message: string }> } {
  const registry = options.sessions ?? sessions;
  const diagnostics = options.diagnostics ?? compiledSessionDiagnostics;
  const catalog = options.catalog ?? defaultCompilerCatalog;
  const snapshots = options.snapshots ?? defaultCompiledSessionSnapshots;
  const durableHostCapability = options.compiledDurableHostCapability ?? serverCompiledDurableHostCapability;
  const createSession = options.createSession
    ?? ((id: string, runtimeDependencies: { compiledDurableHostCapability: object }) => createServerGameSession(
      id,
      "cosmic-horror",
      loadConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { compiledDurableHostCapability: runtimeDependencies.compiledDurableHostCapability },
    ));
  const hydrated: string[] = [];
  const unavailable: Array<{ id: string; code: string; message: string }> = [];
  const reject = (id: string, code: string, message: string) => {
    const entry = { id, code, message };
    diagnostics.set(id, entry);
    unavailable.push(entry);
  };

  for (const [index, header] of snapshots.listHeaders().entries()) {
    if (header.status === "refused") {
      reject(header.sessionId ?? `unavailable-${index}`, header.code, header.message);
      continue;
    }
    // The registry is the startup quarantine boundary across durable formats.
    // Do this before a restore can open a career database: a same-ID ordinary
    // envelope must never cause a compiled winner's career side effects (and
    // vice versa).
    if (registry.has(header.value.sessionId)) {
      reject(header.value.sessionId, "SNAPSHOT_CORRUPT", "duplicate compiled session ID during hydration");
      continue;
    }
    const restored = hydrateCompiledSession(header.value.sessionId, {
      catalog,
      snapshots,
      sessionNamespace: options.sessionNamespace,
      compiledDurableHostCapability: durableHostCapability,
      createSession,
    });
    if (restored.status === "refused") {
      reject(header.value.sessionId, restored.code, restored.message);
      continue;
    }
    registry.set(header.value.sessionId, restored.session);
    diagnostics.delete(header.value.sessionId);
    hydrated.push(header.value.sessionId);
  }
  return { hydrated, unavailable };
}

export interface OrdinarySessionHydrationOptions {
  snapshots?: OrdinarySessionSnapshotStore;
  /** Required by production bootstrap; omitted only by isolated store tests. */
  sessionNamespace?: SessionNamespaceCoordinator;
  storage?: { careerRoot?: string; sessionRoot?: string };
  createSession?: (
    id: string,
    access: NonNullable<ConstructorParameters<typeof GameSession>[7]>,
    runtimeDependencies: { ordinaryDurableHostCapability: object },
  ) => GameSession;
  intentPolicy?: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">;
  /** Trusted host-only intent capability; durable envelopes never contain it. */
  sessionIntentClient?: NormalSessionIntentClient;
}

/** Trusted host wiring for an ordinary restore target; never request-selected. */
export type OrdinaryPristineSessionFactory = (input: {
  id: string;
  access: NonNullable<ConstructorParameters<typeof GameSession>[7]>;
  storage: { careerRoot?: string; sessionRoot?: string };
  intentPolicy: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">;
  /** Trusted host-only intent capability; never derived from a snapshot or request. */
  sessionIntentClient?: NormalSessionIntentClient;
  /** Server-minted opaque authority supplied only to a staging/recovery constructor. */
  runtimeDependencies: { ordinaryDurableHostCapability: object };
}) => GameSession;

export type OrdinarySessionHydrationResult =
  | { status: "ok"; session: GameSession; envelope: OrdinarySessionEnvelope }
  | { status: "refused"; code: string; message: string };

/** Match GameSession's private per-session Career root derivation exactly. */
function ordinaryCareerSessionDirectory(
  sessionId: string,
  storage: { careerRoot?: string; sessionRoot?: string } | undefined,
): string {
  const root = storage?.careerRoot ?? process.env.__CAREER_DIR ?? join("data", "careers");
  return join(root, sessionId);
}

/** Typed recovery causes can cross the fail-stopped GameSession restore wrapper. */
function hasCareerRootLockRecoveryRequired(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if (current instanceof CareerRootLockRecoveryRequired) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Restore an already-validated envelope without reading it again.  Keeping
 * this separate from the public read+hydrate wrapper is important for host
 * routes: authorization must be decided from the one durable read before a
 * constructor can touch a career directory.
 */
function restoreOrdinarySessionEnvelope(
  envelope: OrdinarySessionEnvelope,
  options: OrdinarySessionHydrationOptions = {},
  durableHostCapability: object = serverOrdinaryDurableHostCapability,
): OrdinarySessionHydrationResult {
  // This shared path is also used by action-side recovery, not just the
  // public hydrate wrapper. A snapshot pointer that outran its namespace CAS
  // is not ordinary authority and must never reach the Career installer.
  if (options.sessionNamespace && !namespaceHasCommittedIdentity(
    options.sessionNamespace,
    envelope.sessionId,
    "ordinary",
    ordinaryNamespaceIdentity(envelope),
  )) {
    return { status: "refused", code: "ORDINARY_SNAPSHOT_CONFLICT", message: "ordinary snapshot is not the committed runtime namespace identity" };
  }
  const access = envelope.access;
  let session: GameSession | undefined;
  try {
    session = options.createSession
      ? options.createSession(envelope.sessionId, access, { ordinaryDurableHostCapability: durableHostCapability })
      : createServerGameSession(envelope.sessionId, "cosmic-horror", undefined, undefined, undefined, undefined, options.storage, access, options.intentPolicy, options.sessionIntentClient);
    // This is host/test wiring, not a trusted restored state.  Restoration below
    // still proves the exact immutable envelope identity and pristine target.
    if (!(session instanceof GameSession)) throw new Error("ordinary session factory returned an invalid restore target");
    // Verify only; this cannot bind a caller-selected capability after the
    // constructor returned. A dropped/wrong factory dependency must fail
    // before snapshot restore touches a target-local Career root.
    assertOrdinaryDurableHostCapability(session, durableHostCapability);
    session.restoreOrdinarySessionSnapshot(
      envelope.snapshot,
      (projection) => {
        // `envelope` came from the authenticated current pointer (or startup
        // full audit), so this exact tuple decides whether root-local pending
        // commit evidence is authority. Direct GameSession restore deliberately
        // retains its own exact-replacement contract and never receives this.
        new CareerFileStore(ordinaryCareerSessionDirectory(envelope.sessionId, options.storage))
          .reconcileOrdinaryProjection({
            sessionId: envelope.sessionId,
            ...(envelope.generation === 0 ? {} : {
              predecessorGeneration: envelope.generation - 1,
              predecessorEnvelopeHash: envelope.previousEnvelopeHash!,
            }),
            generation: envelope.generation,
            envelopeHash: envelope.envelopeHash,
          }, projection);
      },
    );
    // A restored object is valid only for this exact immutable envelope.  This
    // avoids re-exporting a potentially huge snapshot (or probing an in-flight
    // FIFO action) on every ordinary HTTP read.
    acknowledgeOrdinaryDurableIdentity(session, durableHostCapability, {
      generation: envelope.generation,
      envelopeHash: envelope.envelopeHash,
      snapshotHash: envelope.snapshot.snapshotHash,
    });
    return { status: "ok", session, envelope };
  }
  catch (error) {
    try { session?.close(); } catch { /* invalid recovery target is never published */ }
    if (hasCareerRootLockRecoveryRequired(error)) {
      // A file-backed fence has no owner PID/lease proof. Never turn a crash
      // into a concurrent writer by age-based cleanup; the operator must
      // establish that the owner exited before removing that exact lock.
      return {
        status: "refused",
        code: "ORDINARY_CAREER_ROOT_LOCK_RECOVERY_REQUIRED",
        message: "ordinary Career root is fenced after an interrupted owner; verify the owner exited before exact operator lock recovery (automatic expiry is disabled)",
      };
    }
    return { status: "refused", code: "ORDINARY_SNAPSHOT_CORRUPT", message: error instanceof Error ? error.message : "ordinary session restore failed" };
  }
}

/** The ordinary envelope is the only recovery authority; legacy listing metadata is never read here. */
export function hydrateOrdinarySession(sessionId: string, options: OrdinarySessionHydrationOptions = {}): OrdinarySessionHydrationResult {
  const snapshots = options.snapshots ?? defaultOrdinarySessionSnapshots;
  try {
    const envelope = snapshots.read(sessionId);
    if (envelope.status !== "ok") return envelope;
    if (options.sessionNamespace && !namespaceHasCommittedIdentity(
      options.sessionNamespace,
      envelope.value.sessionId,
      "ordinary",
      ordinaryNamespaceIdentity(envelope.value),
    )) {
      return { status: "refused", code: "ORDINARY_SNAPSHOT_CONFLICT", message: "ordinary snapshot is not the committed runtime namespace identity" };
    }
    return restoreOrdinarySessionEnvelope(envelope.value, options);
  } catch (error) {
    return { status: "refused", code: "ORDINARY_SNAPSHOT_STORAGE_FAILED", message: error instanceof Error ? error.message : "ordinary session hydration failed" };
  }
}

/** Startup hydration is deliberately an opt-in seam for the normal server bootstrap and tests. */
export function hydrateOrdinarySessions(options: OrdinarySessionHydrationOptions & { sessions?: Map<string, GameSession> } = {}): { hydrated: string[]; unavailable: Array<{ id: string; code: string; message: string }> } {
  const registry = options.sessions ?? sessions;
  const snapshots = options.snapshots ?? defaultOrdinarySessionSnapshots;
  const hydrated: string[] = []; const unavailable: Array<{ id: string; code: string; message: string }> = [];
  for (const header of snapshots.listHeaders()) {
    if (header.status !== "ok") { unavailable.push({ id: header.sessionId ?? "unavailable", code: header.code, message: header.message }); continue; }
    // Never construct/restore before checking the common live quarantine.
    // A compiled session is hydrated first at bootstrap, so this blocks an
    // ordinary same-ID envelope before it can touch that career root.
    if (registry.has(header.value.sessionId)) {
      unavailable.push({ id: header.value.sessionId, code: "ORDINARY_SNAPSHOT_CONFLICT", message: "duplicate ordinary session ID during hydration" });
      continue;
    }
    // Startup is the explicit full-integrity boundary. Normal request/action
    // reads use the store's audited successor cache and stay logarithmic.
    const audited = snapshots.audit(header.value.sessionId);
    const namespaceAllowed = audited.status === "ok" && (!options.sessionNamespace || namespaceHasCommittedIdentity(
      options.sessionNamespace,
      audited.value.sessionId,
      "ordinary",
      ordinaryNamespaceIdentity(audited.value),
    ));
    const restored = audited.status === "ok"
      ? (namespaceAllowed
        ? restoreOrdinarySessionEnvelope(audited.value, options)
        : { status: "refused" as const, code: "ORDINARY_SNAPSHOT_CONFLICT", message: "ordinary snapshot is not the committed runtime namespace identity" })
      : audited;
    if (restored.status !== "ok") { unavailable.push({ id: header.value.sessionId, code: restored.code, message: restored.message }); continue; }
    // A concurrent startup owner may have installed while the durable object
    // was restoring. Do not replace it; the temporary session is discarded.
    if (registry.has(header.value.sessionId)) { restored.session.close(); unavailable.push({ id: header.value.sessionId, code: "ORDINARY_SNAPSHOT_CONFLICT", message: "duplicate ordinary session ID during hydration" }); continue; }
    registry.set(header.value.sessionId, restored.session); hydrated.push(header.value.sessionId);
  }
  return { hydrated, unavailable };
}

type StoredSessionSummary = { id: string; createdAt: number; ruleset: string; playerName: string; scene: string; bundleId?: string; ordinaryGeneration?: number };
type CompiledSessionDiagnostic = { id: string; code: string; message: string };
const CLOSED_SESSION_READ_ERROR = "closed GameSession cannot read session state";

/** Only the lifecycle's stable closed-read refusal is an isolatable row state.
 * Any other reader exception remains a programming/runtime failure. */
function isClosedSessionReadRefusal(error: unknown): boolean {
  return error instanceof Error && error.message === CLOSED_SESSION_READ_ERROR;
}

/** Normal listings contain executable sessions only; durable failures are diagnostics, never resumable rows. */
export function partitionSessionListings(
  liveSessions: Iterable<GameSession>,
  storedSessions: Iterable<StoredSessionSummary>,
  diagnostics: Iterable<CompiledSessionDiagnostic>,
): { sessions: Array<SessionSummary & { resumable?: boolean }>; unavailable: CompiledSessionDiagnostic[] } {
  const sessions: Array<SessionSummary & { resumable?: boolean; sessionKind?: "ordinary"; ordinaryGeneration?: number }> = [];
  const unavailable: CompiledSessionDiagnostic[] = [];
  for (const session of liveSessions) {
    // `isDurableCompiledSession` and the ordinary durable identity are both
    // diagnostic metadata permitted after close. Do not blanket-catch a
    // reader error: a non-lifecycle defect in a live session must still fail.
    const knownDurable = session.isDurableCompiledSession() || session.getOrdinaryDurableIdentity() !== null;
    let compiledGeneration: number | null;
    try {
      compiledGeneration = session.getCompiledGeneration();
    } catch (error) {
      if (!knownDurable || !isClosedSessionReadRefusal(error)) throw error;
      unavailable.push({ id: session.id, code: "session_unavailable", message: "session is unavailable" });
      continue;
    }
    const identity = compiledGeneration === null ? session.getOrdinaryDurableIdentity() : null;
    sessions.push({
      ...session.getSummary(),
      ...(compiledGeneration !== null ? { resumable: true } : {}),
      ...(identity ? { sessionKind: "ordinary" as const, ordinaryGeneration: identity.generation } : {}),
    });
  }
  for (const stored of storedSessions) {
    if (sessions.some((session) => session.id === stored.id)) continue;
    if (stored.bundleId) {
      unavailable.push({ id: stored.id, code: "compiled_metadata_only", message: "compiled session has metadata but no validated snapshot" });
      continue;
    }
    sessions.push({ id: stored.id, round: 0, ruleset: stored.ruleset, scene: stored.scene, playerName: stored.playerName, archetype: null, messageCount: 0, npcCount: 0, createdAt: stored.createdAt,
      ...(stored.ordinaryGeneration === undefined ? {} : { sessionKind: "ordinary" as const, ordinaryGeneration: stored.ordinaryGeneration }) });
  }
  for (const diagnostic of diagnostics) {
    if (!sessions.some((session) => session.id === diagnostic.id)) {
      const index = unavailable.findIndex((entry) => entry.id === diagnostic.id);
      if (index >= 0) unavailable[index] = diagnostic;
      else unavailable.push(diagnostic);
    }
  }
  return { sessions, unavailable };
}

function runtimeAuthRefusal(code: string, message: string, status: number): Response {
  return respondJson({ error: { stage: "auth", code, message } }, status);
}

/** Player-facade locator failures intentionally collapse to one cookie-shaped
 * refusal. The pre-auth snapshot read below is bounded and self-validating,
 * but does not prove that the caller may observe a runtime namespace entry. */
function playerFacadeAuthenticationRequiredResponse(): Response {
  return runtimeAuthRefusal("PLAYER_AUTH_REQUIRED", "player authentication is required", 401);
}

/** A bearer was authenticated but its snapshot-bound access grant rejected it. */
function playerFacadeAccessDeniedResponse(): Response {
  return runtimeAuthRefusal("COMPILED_SESSION_ACCESS_DENIED", "authenticated principal is not permitted to access this compiled session", 403);
}

interface PreauthenticatedCompiledPlayerFacade {
  identity: CompiledSessionRecoverySnapshotIdentity;
  access: NonNullable<CompiledSessionSnapshot["access"]>;
  credential: "delivery-cookie" | "bearer";
  principal?: CompilerPrincipal;
}

interface PreauthenticatedCompiledSnapshotAccess {
  identity: CompiledSessionRecoverySnapshotIdentity;
  access: NonNullable<CompiledSessionSnapshot["access"]>;
}

interface PreauthenticatedPlayerInvitationClaim extends PreauthenticatedCompiledSnapshotAccess {
  invite: string;
  claimId: string;
}

function playerInvitationUnavailableResponse(): Response {
  return respondJson({ error: { code: "PLAYER_INVITATION_UNAVAILABLE" } }, 404);
}

/**
 * The immutable snapshot is the only pre-hydration authority for public
 * player credentials. Both cookie facades and invitation claims share this
 * full header/body/hash/access validation; a header alone is never enough.
 */
function readPreauthenticatedCompiledSnapshotAccess(
  sessionId: string,
  snapshots: CompiledSessionSnapshotStore,
): PreauthenticatedCompiledSnapshotAccess | null {
  const header = snapshots.readHeader(sessionId);
  if (header.status !== "ok") return null;
  const raw = snapshots.read(sessionId);
  if (raw.status !== "ok") return null;
  const checked = validateCompiledSessionSnapshot(raw.value);
  if (checked.status !== "ok") return null;
  const snapshot = checked.value;
  if (snapshot.sessionId !== sessionId
    || snapshot.sessionId !== header.value.sessionId
    || snapshot.snapshotHash !== header.value.snapshotHash
    || snapshot.generation !== header.value.generation
    || snapshot.bundle.id !== header.value.bundleId
    || !isCompiledSessionAccessBinding(snapshot.access)) return null;
  return {
    identity: {
      sessionId: snapshot.sessionId,
      bundleId: snapshot.bundle.id,
      generation: snapshot.generation,
      snapshotHash: snapshot.snapshotHash,
    },
    access: snapshot.access,
  };
}

/**
 * Authenticate the snapshot-backed player facade before namespace reconciliation. This
 * deliberately permits only a bounded header/body read and the snapshot's
 * full structural/hash validator: catalog, factories, registry, careers, and
 * request prose remain unreachable until after this returns successfully.
 */
async function preauthenticateCompiledPlayerFacadeRequest(
  req: Request,
  sessionId: string,
  snapshots: CompiledSessionSnapshotStore,
  playerDelivery: CompiledPlayerDelivery,
  authenticator: CompilerRequestAuthenticator | undefined,
): Promise<PreauthenticatedCompiledPlayerFacade | Response> {
  const snapshot = readPreauthenticatedCompiledSnapshotAccess(sessionId, snapshots);
  if (!snapshot) return playerFacadeAuthenticationRequiredResponse();
  const { identity, access } = snapshot;
  if (access.playerDelivery) {
    // Before a delivery credential is proven, provider availability is itself
    // a locator oracle. Do not attempt cookie verification while unavailable;
    // known, unknown, corrupt, missing-cookie, and bad-cookie locators share
    // the same opaque authentication refusal.
    if (!playerDelivery.available) return playerFacadeAuthenticationRequiredResponse();
    const publicOrigin = playerDelivery.publicOrigin;
    if (!publicOrigin || (req.method === "POST" && !isSameOriginRequest(req, publicOrigin))
      || !playerDelivery.authenticate(sessionId, access.playerDelivery, req.headers.get("cookie"))) {
      return playerFacadeAuthenticationRequiredResponse();
    }
    return { identity, access, credential: "delivery-cookie" };
  }
  const principal = await authenticateCompilerPrincipal(req, authenticator);
  if (principal instanceof Response) {
    return principal.status === 503 ? principal : playerFacadeAuthenticationRequiredResponse();
  }
  if (!principalMatchesCompiledSessionAccess(principal, access)
    && !principalMatchesCompiledSessionPlayerGrant(principal, access)) {
    return playerFacadeAccessDeniedResponse();
  }
  return { identity, access, credential: "bearer", principal };
}

/**
 * Validate the public invite against the immutable grant before namespace or
 * catalog work. This is deliberately pure: the claim store remains untouched
 * until the corresponding durable session has been recovered and rechecked.
 */
function preauthenticatePlayerInvitationClaim(
  req: Request,
  sessionId: string,
  invite: string,
  claimId: string,
  snapshots: CompiledSessionSnapshotStore,
  playerDelivery: CompiledPlayerDelivery,
): PreauthenticatedPlayerInvitationClaim | Response {
  const snapshot = readPreauthenticatedCompiledSnapshotAccess(sessionId, snapshots);
  if (!snapshot || !snapshot.access.playerDelivery || !playerDelivery.available) return playerInvitationUnavailableResponse();
  const publicOrigin = playerDelivery.publicOrigin;
  if (!publicOrigin || !isSameOriginRequest(req, publicOrigin)
    || !playerDelivery.validatesClaim(sessionId, snapshot.access.playerDelivery, invite, claimId)) {
    return playerInvitationUnavailableResponse();
  }
  return { ...snapshot, invite, claimId };
}

/** Re-check an already authenticated credential against a hydrated winner. */
function preauthenticatedCompiledPlayerFacadeMatchesAccess(
  preauthenticated: PreauthenticatedCompiledPlayerFacade,
  req: Request,
  sessionId: string,
  access: unknown,
  playerDelivery: CompiledPlayerDelivery,
): boolean {
  if (!isCompiledSessionAccessBinding(access)) return false;
  if (preauthenticated.credential === "delivery-cookie") {
    const publicOrigin = playerDelivery.publicOrigin;
    return !!access.playerDelivery && playerDelivery.available && !!publicOrigin
      && (req.method !== "POST" || isSameOriginRequest(req, publicOrigin))
      && playerDelivery.authenticate(sessionId, access.playerDelivery, req.headers.get("cookie"));
  }
  return !!preauthenticated.principal
    && (principalMatchesCompiledSessionAccess(preauthenticated.principal, access)
      || principalMatchesCompiledSessionPlayerGrant(preauthenticated.principal, access));
}

function preauthenticatedCompiledPlayerFacadeAccessRefusal(
  preauthenticated: PreauthenticatedCompiledPlayerFacade,
): Response {
  return preauthenticated.credential === "bearer"
    ? playerFacadeAccessDeniedResponse()
    : playerFacadeAuthenticationRequiredResponse();
}

export type OrdinarySessionAccessMode = "required" | "development_anonymous";

/**
 * Ordinary runtime auth reuses the server-hosted principal resolver. The only
 * compatibility escape hatch is explicit and may never operate in production.
 */
export interface OrdinarySessionAccessOptions {
  mode?: OrdinarySessionAccessMode;
  environment?: { NODE_ENV?: string };
}

export interface OrdinarySessionAuthenticationEnvironment {
  ORDINARY_SESSION_AUTH_MODE?: string;
  NODE_ENV?: string;
}

export interface OrdinarySessionIntentEnvironment {
  ORDINARY_SESSION_INTENT_POLICY?: string;
  NODE_ENV?: string;
}

/** The HTTP parser policy is host configuration, never request data. */
export function createEnvironmentOrdinaryIntentPolicy(
  env: OrdinarySessionIntentEnvironment = process.env as OrdinarySessionIntentEnvironment,
): Extract<NormalSessionIntentPolicy, "required" | "development_fallback"> {
  return env.ORDINARY_SESSION_INTENT_POLICY === "development_fallback" && isDevelopmentOrTestEnvironment(env.NODE_ENV)
    ? "development_fallback"
    : "required";
}

const DEVELOPMENT_ANONYMOUS_PRINCIPAL: CompilerPrincipal = {
  id: "ordinary-session-development-anonymous",
  role: "operator",
};

export function createEnvironmentOrdinarySessionAccessOptions(
  env: OrdinarySessionAuthenticationEnvironment = process.env as OrdinarySessionAuthenticationEnvironment,
): OrdinarySessionAccessOptions {
  return {
    mode: env.ORDINARY_SESSION_AUTH_MODE === "development_anonymous" ? "development_anonymous" : "required",
    environment: env,
  };
}

function ordinarySessionAccessMode(options: OrdinarySessionAccessOptions): OrdinarySessionAccessMode | "unavailable" {
  if (options.mode !== "development_anonymous") return "required";
  const nodeEnv = options.environment === undefined ? process.env.NODE_ENV : options.environment.NODE_ENV;
  return isDevelopmentOrTestEnvironment(nodeEnv)
    ? "development_anonymous"
    : "unavailable";
}

/** Authenticate before ordinary bodies, constructors, lists, or session state are observed. */
async function authenticateOrdinarySessionPrincipal(
  req: Request,
  authenticator: CompilerRequestAuthenticator | undefined,
  options: OrdinarySessionAccessOptions,
): Promise<CompilerPrincipal | Response> {
  const mode = ordinarySessionAccessMode(options);
  if (mode === "unavailable") {
    return runtimeAuthRefusal("ORDINARY_SESSION_AUTH_UNAVAILABLE", "development_anonymous mode is prohibited in production", 503);
  }
  if (mode === "development_anonymous") return { ...DEVELOPMENT_ANONYMOUS_PRINCIPAL };
  return authenticateCompilerPrincipal(req, authenticator);
}

/** Creation is restricted to owner-capable principals; players never acquire owner sessions. */
async function authorizeOrdinarySessionCreation(
  req: Request,
  authenticator: CompilerRequestAuthenticator | undefined,
  options: OrdinarySessionAccessOptions,
): Promise<CompilerPrincipal | Response> {
  const principal = await authenticateOrdinarySessionPrincipal(req, authenticator, options);
  if (principal instanceof Response) return principal;
  if (principal.role !== "operator" && principal.role !== "keeper") {
    return runtimeAuthRefusal("ORDINARY_SESSION_OWNER_REQUIRED", "ordinary session creation requires an operator or keeper principal", 403);
  }
  return principal;
}

interface OperatorAuthorizationRefusal {
  code: string;
  message: string;
}

/** Shared operator gate for server-owned configuration and global authoring state. */
async function authorizeOperatorRequest(
  req: Request,
  authenticator: CompilerRequestAuthenticator | undefined,
  refusal: OperatorAuthorizationRefusal,
): Promise<true | Response> {
  const principal = await authenticateCompilerPrincipal(req, authenticator);
  if (principal instanceof Response) return principal;
  if (principal.role !== "operator") {
    return runtimeAuthRefusal(refusal.code, refusal.message, 403);
  }
  return true;
}

/** Module authoring changes global server content, so every legacy editor route is operator-only. */
async function authorizeModuleEditorRequest(
  req: Request,
  authenticator: CompilerRequestAuthenticator | undefined,
): Promise<true | Response> {
  return authorizeOperatorRequest(req, authenticator, {
    code: "MODULE_EDITOR_OPERATOR_REQUIRED",
    message: "module editor access requires an operator principal",
  });
}

interface HostOwnedSessionRuntimeAuthentication {
  ordinary: CompilerPrincipal | Response;
  compiled: CompilerPrincipal | Response;
}

/**
 * Resolve a host owner credential before reading the session locator. Required
 * mode deliberately shares one authenticator result across ordinary and
 * compiled authorization; the explicit development compatibility mode only
 * relaxes ordinary sessions after that credential has been resolved.
 */
async function authenticateHostOwnedSessionRuntimeRequest(
  req: Request,
  authenticator: CompilerRequestAuthenticator | undefined,
  ordinarySessionAccess: OrdinarySessionAccessOptions,
): Promise<HostOwnedSessionRuntimeAuthentication> {
  const mode = ordinarySessionAccessMode(ordinarySessionAccess);
  if (mode === "unavailable") {
    const refusal = runtimeAuthRefusal("ORDINARY_SESSION_AUTH_UNAVAILABLE", "development_anonymous mode is prohibited in production", 503);
    return { ordinary: refusal, compiled: refusal };
  }
  const compilerPrincipal = await authenticateCompilerPrincipal(req, authenticator);
  if (mode === "development_anonymous") {
    return { ordinary: { ...DEVELOPMENT_ANONYMOUS_PRINCIPAL }, compiled: compilerPrincipal };
  }
  return { ordinary: compilerPrincipal, compiled: compilerPrincipal };
}

/**
 * Host-owner session routes resolve their caller before looking up the session
 * locator, then authorize that same principal against the appropriate durable
 * binding. Player facade and invitation cookie surfaces remain separate.
 */
function authorizeCompiledSessionRuntimePrincipal(
  principal: CompilerPrincipal | Response,
  session: GameSession,
  allowAssignedPlayer = false,
  opaqueForeign = false,
  durableHostCapability: object = serverCompiledDurableHostCapability,
): CompilerPrincipal | Response {
  if (principal instanceof Response) return principal;
  const access: unknown = readCompiledDurableSessionAccessBinding(session, durableHostCapability);
  if (!isCompiledSessionAccessBinding(access)) {
    return runtimeAuthRefusal("COMPILED_SESSION_ACCESS_UNAVAILABLE", "compiled session access binding is unavailable", 503);
  }
  if (!principalMatchesCompiledSessionAccess(principal, access)
    && !(allowAssignedPlayer && principalMatchesCompiledSessionPlayerGrant(principal, access))) {
    if (opaqueForeign) return opaqueSessionNotFoundResponse();
    return runtimeAuthRefusal("COMPILED_SESSION_ACCESS_DENIED", "authenticated principal is not permitted to access this compiled session", 403);
  }
  return principal;
}

async function authorizeCompiledSessionRuntimeRequest(
  req: Request,
  session: GameSession,
  authenticator: CompilerRequestAuthenticator | undefined,
  allowAssignedPlayer = false,
  durableHostCapability: object = serverCompiledDurableHostCapability,
): Promise<CompilerPrincipal | Response> {
  return authorizeCompiledSessionRuntimePrincipal(
    await authenticateCompilerPrincipal(req, authenticator),
    session,
    allowAssignedPlayer,
    false,
    durableHostCapability,
  );
}

type AuthoritativeOrdinaryLive =
  | { status: "ok"; session: GameSession; envelope: OrdinarySessionEnvelope }
  | { status: "refused" }
  // This state is reachable only after the durable envelope authenticated the
  // caller as its exact owner. It must not be collapsed into an opaque miss:
  // the owner can retry a failed pristine replacement without learning any
  // storage or restoration diagnostic.
  | { status: "unavailable" };

/**
 * The one authority gate for ordinary live objects.  It reads exactly one
 * envelope, checks its owner binding before constructing anything, then
 * compares the live immutable snapshot to that envelope.  A different
 * process advancing the envelope can therefore never produce a response
 * that combines a new generation with an old in-memory state.
 */
function ensureAuthoritativeOrdinaryLive(
  sessionId: string,
  source: GameSession,
  principal: CompilerPrincipal | Response,
  registry: Map<string, GameSession>,
  snapshots: OrdinarySessionSnapshotStore,
  sessionNamespace: SessionNamespaceCoordinator,
  storage: { careerRoot?: string; sessionRoot?: string },
  intentPolicy: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">,
  createPristineSession?: OrdinaryPristineSessionFactory,
): AuthoritativeOrdinaryLive {
  if (principal instanceof Response) return { status: "refused" };
  const durable = snapshots.read(sessionId);
  // Do not even inspect a live binding (nor construct a replacement) before
  // the durable binding has authenticated this caller.
  if (durable.status !== "ok" || !principalMatchesOrdinarySessionAccess(principal, durable.value.access)) {
    return { status: "refused" };
  }
  // A committed namespace kind alone is not enough: its exact identity is
  // the cross-store authority. Do this before even reading the live object's
  // binding so snapshot gN+1 cannot replace a namespace-authorized gN.
  if (!namespaceHasCommittedIdentity(
    sessionNamespace,
    durable.value.sessionId,
    "ordinary",
    ordinaryNamespaceIdentity(durable.value),
  )) {
    return { status: "unavailable" };
  }
  let matches = false;
  try {
    const liveAccess = source.getOrdinarySessionAccessBinding();
    const identity = source.getOrdinaryDurableIdentity();
    matches = isOrdinarySessionAccessBinding(liveAccess)
      && sameOrdinarySessionAccessBinding(liveAccess, durable.value.access)
      && identity !== null
      && identity.generation === durable.value.generation
      && identity.envelopeHash === durable.value.envelopeHash
      && identity.snapshotHash === durable.value.snapshot.snapshotHash;
  } catch {
    matches = false;
  }
  if (matches) return { status: "ok", session: source, envelope: durable.value };

  const replacement = restoreOrdinarySessionEnvelope(durable.value, {
    sessionNamespace,
    storage,
    intentPolicy,
    createSession: (id, access, runtimeDependencies) => {
      const target = createPristineSession
        ? createPristineSession({ id, access, storage, intentPolicy, runtimeDependencies })
        : createServerGameSession(id, "cosmic-horror", loadConfig(), undefined, undefined, undefined, storage, access, intentPolicy, undefined, runtimeDependencies);
      if (!(target instanceof GameSession)) throw new Error("ordinary live recovery factory returned an invalid pristine target");
      return target;
    },
  });
  if (replacement.status !== "ok") return { status: "unavailable" };
  // A different async request may have adopted a candidate while we restored.
  // Never overwrite it: close our candidate and let that request become the
  // sole installer.
  if (registry.get(sessionId) !== source) {
    // This candidate was never published. Close precisely this one discarded
    // replacement; a close fault cannot turn an authenticated retryable race
    // into a misleading absence response.
    try { replacement.session.close(); } catch { /* candidate is unreachable */ }
    return { status: "unavailable" };
  }
  registry.set(sessionId, replacement.session);
  try { source.close(); } catch { /* stale instance is no longer reachable */ }
  return replacement;
}

/** Authenticate before enumerating any ordinary or compiled live/stored metadata. */
async function visibleSessionListings(
  req: Request,
  authenticator: CompilerRequestAuthenticator,
  ordinarySessionAccess: OrdinarySessionAccessOptions,
  storage: { careerRoot?: string; sessionRoot?: string },
  registry: Map<string, GameSession>,
  ordinarySnapshots: OrdinarySessionSnapshotStore,
  sessionNamespace: SessionNamespaceCoordinator,
  intentPolicy: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">,
  diagnostics: ReadonlyMap<string, CompiledSessionDiagnostic> = compiledSessionDiagnostics,
  createPristineSession?: OrdinaryPristineSessionFactory,
): Promise<ReturnType<typeof partitionSessionListings> | Response> {
  const principal = await authenticateOrdinarySessionPrincipal(req, authenticator, ordinarySessionAccess);
  if (principal instanceof Response) return principal;
  const live: GameSession[] = [];
  for (const session of [...registry.values()]) {
    // These two diagnostics remain valid after close.  They select recovery
    // policy without reading state from a possibly fail-stopped cohort.
    const kind = session.isDurableCompiledSession()
      ? "compiled"
      : session.getOrdinaryDurableIdentity() !== null
        ? "ordinary"
        : "legacy";
    if (kind === "compiled") {
      try {
        // A compiled source must be live before its private access binding may
        // be consulted. A closed source cannot safely become an anonymous row;
        // evict it and let an authenticated runtime route recover the durable
        // snapshot on demand.
        session.getCompiledGeneration();
      } catch (error) {
        if (!isClosedSessionReadRefusal(error)) throw error;
        if (registry.get(session.id) === session) registry.delete(session.id);
        continue;
      }
      const access: unknown = readCompiledDurableSessionAccessBinding(session, serverCompiledDurableHostCapability);
      if (isCompiledSessionAccessBinding(access) && principalMatchesCompiledSessionAccess(principal, access)) live.push(session);
      continue;
    }
    const authoritative = ensureAuthoritativeOrdinaryLive(session.id, session, principal, registry, ordinarySnapshots, sessionNamespace, storage, intentPolicy, createPristineSession);
    if (authoritative.status === "ok") live.push(authoritative.session);
  }
  const stored = ordinarySnapshots.listHeaders().flatMap((header) => {
    if (header.status !== "ok") return [];
    const durable = ordinarySnapshots.read(header.value.sessionId);
    if (durable.status !== "ok" || !principalMatchesOrdinarySessionAccess(principal, durable.value.access)) return [];
    const summary = durable.value.snapshot.session;
    return [{ id: summary.id, createdAt: summary.createdAt, ruleset: summary.ruleset, playerName: "unknown", scene: "unknown", ordinaryGeneration: durable.value.generation }];
  });
  // Durable compiled diagnostics are intentionally omitted: no safe owner
  // binding is available after a failed hydrate, and ordinary rows without a
  // valid binding must not be upgraded to anonymous visibility.
  return { ...partitionSessionListings(live, stored, diagnostics.values()), unavailable: [] };
}

/** The legacy query-role WebSocket protocol is never an authorization path for a compiled session. */
export function compiledSessionWebSocketRefusal(
  sessionId: string,
  registry: ReadonlyMap<string, Pick<GameSession, "getCompiledGeneration">> = sessions,
  snapshots: Pick<CompiledSessionSnapshotStore, "isOccupied"> = defaultCompiledSessionSnapshots,
  diagnostics: ReadonlyMap<string, CompiledSessionDiagnostic> = compiledSessionDiagnostics,
): Response | null {
  const live = registry.get(sessionId);
  // A durable compiled session must never fall through to the legacy query
  // role protocol merely because it was evicted from memory or failed
  // hydration. `isOccupied` intentionally includes partial/corrupt files.
  if ((live && live.getCompiledGeneration() !== null) || snapshots.isOccupied(sessionId) || diagnostics.has(sessionId)) {
    return new Response("compiled session WebSocket access is unavailable", { status: 403 });
  }
  return null;
}

/**
 * The query role/playerId protocol has no trustworthy owner credential. In
 * required mode ordinary sessions therefore refuse the upgrade rather than
 * treating those caller-selected values as authorization. Explicit local dev
 * compatibility keeps the legacy protocol only outside production.
 */
export function ordinarySessionWebSocketRefusal(
  _sessionId: string,
  _registry: ReadonlyMap<string, Pick<GameSession, "getCompiledGeneration">> = sessions,
  access: OrdinarySessionAccessOptions = createEnvironmentOrdinarySessionAccessOptions(),
  _hasStoredMetadata: (id: string) => boolean = sessionMetaExists,
): Response | null {
  if (ordinarySessionAccessMode(access) === "development_anonymous") return null;
  // This protocol only has caller-controlled query role/playerId values. In
  // required or unavailable mode it is therefore closed for every locator,
  // including unknown IDs, rather than becoming an upgrade oracle.
  return new Response("ordinary session WebSocket access is unavailable", { status: 403 });
}

/**
 * Server-owned seams for the ordinary owner WebSocket handshake. The helper
 * intentionally receives no live GameSession registry: a WebSocket upgrade is
 * admitted from the authenticated durable envelope and namespace pointer only.
 */
export interface OrdinarySessionWebSocketUpgradeDependencies {
  compilerAuthenticator?: CompilerRequestAuthenticator;
  ordinarySessionAccess?: OrdinarySessionAccessOptions;
  ordinarySnapshots?: Pick<OrdinarySessionSnapshotStore, "read">;
  sessionNamespace?: Pick<SessionNamespaceCoordinator, "read">;
  /** Development-only guard that preserves the compiled legacy WS closure. */
  compiledLegacyRefusal?: (sessionId: string) => Response | null;
}

export interface AuthorizedOrdinarySessionWebSocketUpgrade {
  readonly data: WsConnectionData;
  readonly admissionBinding: OrdinarySessionWebSocketAdmissionBinding;
}

const DEVELOPMENT_ANONYMOUS_WEBSOCKET_PRINCIPAL = "ordinary-session-development-anonymous";

export function ordinaryWebSocketPrincipalKey(principal: Pick<CompilerPrincipal, "role" | "id">): string {
  // Encoding the trusted authenticator's role/id pair prevents query/header
  // declarations from selecting a principal bucket or colliding by delimiter.
  return JSON.stringify([principal.role, principal.id]);
}

function opaqueOrdinaryWebSocketNotFound(): Response {
  // Keep every authenticated ordinary refusal (foreign, missing, corrupt,
  // wrong-kind, and stale pointer) on exactly one non-enumerating surface.
  return new Response("ordinary session was not found", { status: 404 });
}

function namespaceMatchesOrdinaryEnvelope(
  record: ReturnType<SessionNamespaceCoordinator["read"]> | undefined,
  envelope: OrdinarySessionEnvelope,
): boolean {
  const identity = ordinaryNamespaceIdentity(envelope);
  return record?.state === "committed"
    && record.kind === "ordinary"
    && record.expectedIdentity !== null
    && record.expectedIdentity.hash === identity.hash
    && record.expectedIdentity.generation === identity.generation
    && record.expectedIdentity.format === identity.format;
}

/**
 * Authorize the ordinary host-owner WebSocket replacement before Bun observes
 * any session locator or runtime state. This deliberately does not mint an
 * ordinary player credential: the only authenticated real-time channel here
 * is the owner-controlled KP channel.
 */
export async function authorizeOrdinarySessionWebSocketUpgrade(
  req: Request,
  dependencies: OrdinarySessionWebSocketUpgradeDependencies = {},
): Promise<WsConnectionData | Response> {
  const authorized = await authorizeOrdinarySessionWebSocketAdmission(req, dependencies);
  return authorized instanceof Response ? authorized : authorized.data;
}

/**
 * Same durable authorization boundary as the legacy data-only helper, with a
 * server-derived principal bucket retained solely for admission accounting.
 */
export async function authorizeOrdinarySessionWebSocketAdmission(
  req: Request,
  dependencies: OrdinarySessionWebSocketUpgradeDependencies = {},
): Promise<AuthorizedOrdinarySessionWebSocketUpgrade | Response> {
  const access = dependencies.ordinarySessionAccess ?? createEnvironmentOrdinarySessionAccessOptions();
  const mode = ordinarySessionAccessMode(access);
  if (mode === "unavailable") {
    return runtimeAuthRefusal("ORDINARY_SESSION_AUTH_UNAVAILABLE", "development_anonymous mode is prohibited in production", 503);
  }

  if (mode === "development_anonymous") {
    // The old local-only protocol remains intentionally narrow. It is not an
    // authorization decision and it cannot fall through to compiled sessions.
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session") || "";
    const compiledRefusal = dependencies.compiledLegacyRefusal?.(sessionId)
      ?? compiledSessionWebSocketRefusal(sessionId);
    if (compiledRefusal) return compiledRefusal;
    const rawRole = url.searchParams.get("role");
    const role: WsRole = isWsRole(rawRole) ? rawRole : "observer";
    const playerId = url.searchParams.get("playerId") || undefined;
    return {
      data: { sessionId, role, ...(playerId ? { playerId } : {}) },
      admissionBinding: { sessionId, principalKey: DEVELOPMENT_ANONYMOUS_WEBSOCKET_PRINCIPAL },
    };
  }

  // Required mode authenticates before parsing `session`, opening either
  // durable store, or consulting any live registry. Query role/playerId are
  // intentionally not read on this path.
  const principal = await authenticateCompilerPrincipal(req, dependencies.compilerAuthenticator);
  if (principal instanceof Response) return principal;
  if (principal.role !== "operator" && principal.role !== "keeper") return opaqueOrdinaryWebSocketNotFound();

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session") || "";
  if (!isServerGeneratedSessionId(sessionId)) return opaqueOrdinaryWebSocketNotFound();
  if (!dependencies.ordinarySnapshots || !dependencies.sessionNamespace) {
    return runtimeAuthRefusal("ORDINARY_SESSION_WS_AUTH_UNAVAILABLE", "ordinary session WebSocket authorization is unavailable", 503);
  }

  let record: ReturnType<SessionNamespaceCoordinator["read"]> | undefined;
  try {
    record = dependencies.sessionNamespace.read(sessionId);
  } catch {
    // Namespace availability is host-wide infrastructure, not per-session
    // evidence, so it can be reported without becoming a locator oracle.
    return runtimeAuthRefusal("ORDINARY_SESSION_WS_AUTH_UNAVAILABLE", "ordinary session WebSocket authorization is unavailable", 503);
  }
  if (record?.state !== "committed" || record.kind !== "ordinary" || record.expectedIdentity === null) {
    return opaqueOrdinaryWebSocketNotFound();
  }

  let durable: ReturnType<OrdinarySessionSnapshotStore["read"]>;
  try {
    durable = dependencies.ordinarySnapshots.read(sessionId);
  } catch {
    return opaqueOrdinaryWebSocketNotFound();
  }
  // A malformed/missing/corrupt envelope is deliberately opaque even to a
  // foreign authenticated principal. Do not inspect a metadata projection or
  // live binding as a fallback, and do not construct a recovery GameSession.
  if (durable.status !== "ok" || !namespaceMatchesOrdinaryEnvelope(record, durable.value)) {
    return opaqueOrdinaryWebSocketNotFound();
  }
  if (!principalMatchesOrdinarySessionAccess(principal, durable.value.access)) {
    return opaqueOrdinaryWebSocketNotFound();
  }
  return {
    data: { sessionId, role: "kp" },
    admissionBinding: { sessionId, principalKey: ordinaryWebSocketPrincipalKey(principal) },
  };
}

export interface OrdinarySessionWebSocketUpgradeServer {
  upgrade(req: Request, options: { data: WsConnectionData }): boolean;
}

export interface OrdinarySessionWebSocketAdmissionUpgradeDependencies {
  admission: OrdinarySessionWebSocketAdmissionController;
  authorization?: (req: Request) => Promise<AuthorizedOrdinarySessionWebSocketUpgrade | Response>;
  authorizationDependencies?: OrdinarySessionWebSocketUpgradeDependencies;
}

function websocketCapacityResponse(): Response {
  return Response.json(
    { error: { code: "WEBSOCKET_CAPACITY_EXCEEDED" } },
    { status: 429, headers: { "Retry-After": "1" } },
  );
}

function websocketDrainingResponse(): Response {
  return Response.json(
    { error: { code: "SERVER_DRAINING" } },
    { status: 503, headers: { "Retry-After": "1" } },
  );
}

/**
 * Production upgrade seam: durable authorization precedes reservation, and a
 * reservation is released if Bun declines or throws during upgrade.
 */
export async function admitOrdinarySessionWebSocketUpgrade(
  req: Request,
  server: OrdinarySessionWebSocketUpgradeServer,
  dependencies: OrdinarySessionWebSocketAdmissionUpgradeDependencies,
): Promise<Response | undefined> {
  const authorized = await (dependencies.authorization
    ? dependencies.authorization(req)
    : authorizeOrdinarySessionWebSocketAdmission(req, dependencies.authorizationDependencies));
  if (authorized instanceof Response) return authorized;

  const reservation = dependencies.admission.reserve(authorized.admissionBinding);
  if (reservation.status !== "reserved") {
    return reservation.status === "capacity-exceeded" ? websocketCapacityResponse() : websocketDrainingResponse();
  }
  const data = bindOrdinarySessionWebSocketAdmission(authorized.data, {
    lease: reservation.lease,
    binding: authorized.admissionBinding,
  });
  try {
    if (server.upgrade(req, { data })) return undefined;
  } catch {
    void dependencies.admission.releaseLease(reservation.lease);
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  void dependencies.admission.releaseLease(reservation.lease);
  return new Response("WebSocket upgrade failed", { status: 400 });
}

// ============================================================
// CORS 头 // ============================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
// This is the outer host ceiling. Endpoint readers remain stricter (for
// example, JSON and player actions) and must not inherit a wider allowance.
// It is server-owned so clients, request headers, and environment cannot
// negotiate the amount of memory Bun accepts before application routing.
const SERVER_HOST_RESOURCE_POLICY = Object.freeze({
  maxRequestBodySize: 8 * 1024 * 1024,
  // Do not let Bun's NODE_ENV-derived default render contextual error pages
  // with implementation details when a production host handler throws.
  development: false,
});
const PLAYER_JSON_MAX_BYTES = 8 * 1024;
const GENERAL_JSON_MAX_BYTES = 1024 * 1024;
const JSON_BODY_READ_DEADLINE_MS = 5_000;

function corsHeaders(): Record<string, string> {
  return { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withPlayerNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  // Player delivery is deliberately same-origin cookie transport.  Do not
  // advertise a credentialed cross-origin surface merely because the wider
  // operator API supports permissive non-cookie CORS.
  headers.delete("Access-Control-Allow-Origin");
  headers.delete("Access-Control-Allow-Methods");
  headers.delete("Access-Control-Allow-Headers");
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Durable-recovery outcomes must never become a cached locator oracle. */
function withRecoveryNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isSameOriginRequest(req: Request, publicOrigin: string): boolean {
  try {
    return req.headers.get("origin") === publicOrigin;
  } catch {
    return false;
  }
}

/** Explicit deployment inputs for the compiler control plane. Tokens are never logged or returned. */
export interface CompilerAuthenticationEnvironment {
  COMPILER_OPERATOR_BEARER_TOKEN?: string;
  COMPILER_KEEPER_BEARER_TOKEN?: string;
}

function deploymentBearerToken(value: string | undefined): string | undefined {
  // Bearer credentials must be unambiguous printable non-whitespace values and
  // at least 32 characters long; deployments should generate them randomly.
  return value !== undefined && /^[!-~]{32,}$/.test(value) && !value.includes(",") ? value : undefined;
}

function constantTimeTokenEquals(candidate: string, configured: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const configuredHash = createHash("sha256").update(configured).digest();
  return timingSafeEqual(candidateHash, configuredHash);
}

/**
 * Default deployable compiler authenticator. A production host can inject a
 * stronger identity provider through handleRequest; no request header can pick
 * a role. Missing or malformed deployment configuration fails closed.
 */
export function createEnvironmentCompilerAuthenticator(
  env: CompilerAuthenticationEnvironment = process.env as CompilerAuthenticationEnvironment,
): CompilerRequestAuthenticator {
  const rawOperator = env.COMPILER_OPERATOR_BEARER_TOKEN;
  const rawKeeper = env.COMPILER_KEEPER_BEARER_TOKEN;
  const operatorToken = deploymentBearerToken(rawOperator);
  const keeperToken = deploymentBearerToken(rawKeeper);
  const unavailable = !operatorToken
    || !keeperToken
    || (operatorToken !== undefined && operatorToken === keeperToken);
  return (req) => {
    if (unavailable) return { status: "unavailable" };
    const match = /^Bearer ([^,\s]+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!match) return { status: "unauthenticated" };
    const token = match[1]!;
    if (operatorToken && constantTimeTokenEquals(token, operatorToken)) {
      return { status: "authenticated", principal: { id: "operator:environment", role: "operator" } };
    }
    if (keeperToken && constantTimeTokenEquals(token, keeperToken)) {
      return { status: "authenticated", principal: { id: "keeper:environment", role: "keeper" } };
    }
    return { status: "unauthenticated" };
  };
}

// ============================================================
// 路由处理
// ============================================================

function parseUrl(pathname: string): { segments: string[]; query: URLSearchParams } {
  const [path, qs] = pathname.split("?");
  return {
    segments: path.split("/").filter(Boolean),
    query: new URLSearchParams(qs ?? ""),
  };
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Injection seam for intent classification; production leaves this undefined. */
export interface CompiledIntentHandlerOptions {
  llm?: LLMLike;
  isLlmEnabled?: () => boolean;
}

/** Trusted host seam for the optional provider-backed compiled player turn.
 * A missing/disabled provider deliberately retains the pre-existing
 * mechanics-only action route; it never substitutes generated-looking text. */
export interface CompiledNarrationHandlerOptions {
  llm?: LLMLike;
  isLlmEnabled?: () => boolean;
}

/** Injection seam for catalog-backed automatic compilation; production is opt-in through llmEnabled(). */
export interface CompilerAutoHandlerOptions {
  llm?: LLMLike;
  isLlmEnabled?: () => boolean;
  /** Test hosts may inject a shared controller; production uses the module singleton. */
  admission?: CompilerAutoAdmissionController;
  /**
   * Server-owned publication service. It is never selected by HTTP data; an
   * absent service preserves the established draft-only auto-resolve mode.
   */
  machinePublisher?: MachinePresentationPublisher;
  /**
   * Test hosts with an injected LLMLike remain draft-only unless they opt into
   * the same server-owned default publisher. Production (no injected model)
   * enables it whenever automatic compilation itself is enabled.
   */
  machinePublicationEnabled?: boolean;
}

/**
 * Server-owned observation seam for the operator-only configuration view.
 * Request data can never provide this dependency; the main host uses defaults.
 */
export interface ConfigViewDependencies {
  loadConfig?: () => ReturnType<typeof loadConfig>;
  worldModelStatus?: () => ReturnType<typeof worldModelStatus>;
  sessionCount?: () => number;
  /** Main passes its one startup-validated snapshot; direct tests parse only after auth. */
  runtimeConfig?: ServerRuntimeConfig;
  /** Main passes a startup-only status; direct handlers never parse policy environment. */
  compiledWorldModelBindingPolicy?: CompiledWorldModelBindingPolicyStatus;
}

/**
 * The request handler's live-session seams. Production retains the module
 * registry and normal GameSession factory; tests can isolate both without
 * changing process-wide configuration.
 */
export interface SessionRuntimeDependencies {
  registry?: Map<string, GameSession>;
  /** Host/test seam for the deliberately process-local legacy scripted registry. */
  scriptedSessions?: ScriptedSessionRegistry;
  /** Durable authority for ordinary HTTP create/action only. */
  ordinarySnapshots?: OrdinarySessionSnapshotStore;
  /** Trusted server/test seam; ordinary request bodies cannot select this. */
  ordinaryIntentPolicy?: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">;
  /** Main snapshots NODE_ENV together with its validated runtime config. */
  runtimeNodeEnv?: string | undefined;
  /** Trusted server/test seam inherited by every ordinary candidate and recovery target. */
  ordinarySessionIntentClient?: NormalSessionIntentClient;
  /** Test seam; production always uses the server-owned CSPRNG generator. */
  generateSessionId?: () => string;
  /** Test seam; production always uses the server-owned CSPRNG generator. */
  generateCompiledSessionId?: () => string;
  /** Server/test-private compiled host authority; never selected by requests. */
  compiledDurableHostCapability?: object;
  /** Trusted server/test publication capability; request data cannot select a world-model scope. */
  resolveCompiledWorldModelBinding?: CompiledWorldModelBindingResolver;
  createOrdinarySession?: (input: {
    id: string;
    ruleset: RulesetId;
    archetypeId?: string;
    characterName?: string;
    persona: ConstructorParameters<typeof GameSession>[5];
    storage: { careerRoot?: string; sessionRoot?: string };
    access: NonNullable<ConstructorParameters<typeof GameSession>[7]>;
    intentPolicy: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">;
    sessionIntentClient?: NormalSessionIntentClient;
    /** Server-private capability inherited by source, staging, and recovery sessions. */
    runtimeDependencies: { ordinaryDurableHostCapability: object };
  }) => GameSession;
  /** Recovery factory is trusted test/host wiring; request data never selects it. */
  createOrdinaryRecoverySession?: (input: {
    id: string;
    access: NonNullable<ConstructorParameters<typeof GameSession>[7]>;
    storage: { careerRoot?: string; sessionRoot?: string };
    intentPolicy: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">;
    sessionIntentClient?: NormalSessionIntentClient;
    /** Server-private capability inherited by source, staging, and recovery sessions. */
    runtimeDependencies: { ordinaryDurableHostCapability: object };
  }) => GameSession;
  /** Trusted host recovery seam; request and compiled-module data cannot select it. */
  createCompiledRecoverySession?: (input: {
    id: string;
    storage: { careerRoot?: string; sessionRoot?: string };
    /** Server-private capability inherited by every compiled restore target. */
    runtimeDependencies: { compiledDurableHostCapability: object };
  }) => GameSession;
  /** Shared runtime namespace. Hosts may inject it for one process/root. */
  sessionNamespace?: SessionNamespaceCoordinator;
  /** Durable cross-process admission for ordinary action model execution. */
  ordinaryActionAdmission?: OrdinaryActionAdmissionCoordinator;
  /** Durable cross-process creation admission; request data cannot choose it. */
  ordinarySessionCreationAdmission?: OrdinarySessionCreationAdmissionCoordinator;
  /**
   * Durable cross-process compiled creation admission. This is intentionally
   * not the ordinary coordinator and is derived only from the runtime
   * namespace root.
   */
  compiledSessionCreationAdmission?: CompiledSessionCreationAdmissionCoordinator;
  /** Durable cross-process admission shared by both compiled intent routes. */
  compiledIntentAdmission?: CompiledIntentAdmissionCoordinator;
  /** Durable success replay ledger shared by both compiled intent routes. */
  compiledIntentReplay?: CompiledIntentReplayStore;
  /** Host-only model configuration for committed compiled player narration. */
  compiledNarrationOptions?: CompiledNarrationHandlerOptions;
  /** Separate provider lease domain; request data never selects its root or policy. */
  compiledNarrationAdmission?: CompiledNarrationAdmissionCoordinator;
  /** Separate exact-candidate/receipt evidence, never an intent replay cache. */
  compiledNarrationLedger?: CompiledNarrationLedger;
  /** Host-only bounded LLM configuration for same-generation NPC follow-ups. */
  compiledFollowupOptions?: CompiledNarrationHandlerOptions;
  /** Independent durable tombstones; unlike narration they do not imply g+1. */
  compiledFollowupAdmission?: CompiledPlayerFollowupAdmissionCoordinator;
  compiledFollowupLedger?: CompiledPlayerFollowupLedger;
  /** Explicit startup-only migration seam; request bodies never select it. */
  allowSessionNamespaceLegacyMigration?: boolean;
}

const SERVER_AUTO_COMPILER_LIMITS: CompilerHintProposalAdapterLimits = {
  maxQuestionsPerRequest: 3,
  maxRequestsPerRound: 8,
  maxRequestChars: 24_000,
  maxResponseTokens: 2_400,
};
const SERVER_AUTO_COMPILER_MAX_ROUNDS = 2;

/** Immutable server-owned authority for the automatic compiler entrypoint. */
export const SERVER_AUTO_COMPILER_POLICY = Object.freeze({
  policyId: "server-auto-compiler-user-provided-v1",
  rightsStatus: "user_provided" as const,
  allowSourceExactNpcEncounters: true as const,
  allowedSourceFactMechanicKinds: Object.freeze(["existing_clue_discovery", "prose_fact_finding"] as const),
});

/** All automatic-compile trust inputs are server-owned; HTTP bodies never reach this seam. */
function configuredAutoCompiler(options: CompilerAutoHandlerOptions) {
  if (!(options.isLlmEnabled ?? llmEnabled)()) return undefined;
  const config = options.llm ? undefined : loadConfig();
  const bounded = createBoundedCompilerAutoLlm(options.llm ?? new LLMClient(config!));
  const machinePublisher = options.machinePublisher
    ?? ((options.machinePublicationEnabled ?? !options.llm)
      ? createServerMachinePresentationPublisher(bounded.llm)
      : undefined);
  return {
    // One request-scoped counter wraps both mechanics proposals and the
    // default selector. Its cap is 32 dispatches: mechanics retain their
    // existing 2×8 allowance and selection may use up to 16 further calls.
    llm: bounded.llm,
    // Combat and source-fact mechanics are explicit server capabilities. HTTP
    // request bodies never influence this trusted policy object.
    policy: SERVER_AUTO_COMPILER_POLICY,
    producer: {
      providerFingerprint: "server-configured-llm",
      modelFingerprint: config ? `model:${config.model}` : "injected-server-llm",
    },
    limits: SERVER_AUTO_COMPILER_LIMITS,
    maxProposalRounds: SERVER_AUTO_COMPILER_MAX_ROUNDS,
    admission: options.admission ?? getDefaultCompilerAutoAdmission(),
    ...(machinePublisher ? { machinePublisher } : {}),
  };
}

export async function handleRequest(
  req: Request,
  compilerCatalog?: CompilerArtifactCatalog,
  compiledSnapshots?: CompiledSessionSnapshotStore,
  storage: { careerRoot?: string; sessionRoot?: string } = {},
  compiledIntentOptions: CompiledIntentHandlerOptions = {},
  compilerAutoOptions: CompilerAutoHandlerOptions = {},
  compilerAuthenticator?: CompilerRequestAuthenticator,
  runtimeDiagnostics: ReadonlyMap<string, CompiledSessionDiagnostic> = compiledSessionDiagnostics,
  compiledPlayerResolver?: CompiledSessionPlayerResolver,
  playerDelivery?: CompiledPlayerDelivery,
  ordinarySessionAccess?: OrdinarySessionAccessOptions,
  sessionRuntime: SessionRuntimeDependencies = {},
  configView: ConfigViewDependencies = {},
): Promise<Response> {
  const url = new URL(req.url);
  const { segments, query } = parseUrl(url.pathname + url.search);
  const method = req.method;

  // Keep these isolated read-only facades ahead of every runtime bootstrap
  // dependency. Their handlers own their artifact reads and must not open or
  // inspect session, career, namespace, database, or authorization state.
  if (method === "OPTIONS" && segments[0] === "api") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const sourceResearchResponse = handleSourceResearchHttpRequest(req);
  if (sourceResearchResponse) return withCors(sourceResearchResponse);
  const slotResearchResponse = handleSlotResearchHttpRequest(req);
  if (slotResearchResponse) return withCors(slotResearchResponse);

  // Delay runtime defaults until the read-only facades above have declined the
  // request. Some of these dependencies can initialize durable host state.
  compiledSnapshots ??= defaultCompiledSessionSnapshots;
  compilerAuthenticator ??= createEnvironmentCompilerAuthenticator();
  playerDelivery ??= createEnvironmentPlayerDelivery();
  ordinarySessionAccess ??= createEnvironmentOrdinarySessionAccessOptions();
  const compiledDurableHostCapability = sessionRuntime.compiledDurableHostCapability ?? serverCompiledDurableHostCapability;
  const staticMethod: StaticDeliveryMethod | null = method === "GET" || method === "HEAD" ? method : null;

  // Configuration includes provider topology, process settings, session
  // inventory, and world-model locations. Handle it before any compiler route
  // setup can materialize a configured LLM client or observe runtime state.
  if (method === "GET" && segments[0] === "api" && segments[1] === "config" && segments.length === 2) {
    const authorized = await authorizeOperatorRequest(req, compilerAuthenticator, {
      code: "CONFIG_OPERATOR_REQUIRED",
      message: "configuration access requires an operator principal",
    });
    if (authorized instanceof Response) return authorized;
    let runtimeConfig: ServerRuntimeConfig;
    try {
      runtimeConfig = configView.runtimeConfig ?? resolveServerRuntimeConfig();
    } catch {
      return respondJson({
        error: {
          stage: "config",
          code: "SERVER_RUNTIME_CONFIG_INVALID",
          message: "server runtime configuration is invalid",
        },
      }, 503, { "Retry-After": "1" });
    }
    const config = (configView.loadConfig ?? loadConfig)();
    const sessionCount = (configView.sessionCount ?? (() => (sessionRuntime.registry ?? sessions).size))();
    return respondJson({
      llm: { baseUrl: config.baseUrl, model: config.model, maxTokens: config.maxTokens, temperature: config.temperature, hasKey: isUsableLlmApiKey(config.apiKey) },
      server: {
        port: runtimeConfig.port,
        // Do not label an omitted/empty NODE_ENV as development: neither
        // value enables development-only runtime escape hatches.
        env: runtimeConfig.nodeEnv === undefined ? "unset" : runtimeConfig.nodeEnv,
        sessionTimeoutMinutes: runtimeConfig.sessionTimeoutMinutes,
        ordinarySessionWebSocketAdmission: runtimeConfig.ordinarySessionWebSocketAdmission,
        ordinarySessionCreationAdmission: runtimeConfig.ordinarySessionCreationAdmission,
        compiledWorldModelBindingPolicy: configView.compiledWorldModelBindingPolicy ?? disabledCompiledWorldModelBindingPolicyStatus(),
      },
      sessionCount,
      // This is an inspection only; the status function must not load a model.
      ...(configView.worldModelStatus ?? worldModelStatus)(),
    }, 200, { "Cache-Control": "no-store" });
  }

  // Compiler routes, including compiled-session creation, establish their
  // credential and role policy before cold request handling can construct
  // coordinators or reconcile durable inventory. The returned capability is
  // one-shot and bound to this Request; it avoids a second authenticator call
  // when the compiled boundary is reached below.
  const compilerRoutePreauthentication = await preauthorizeCompilerHttpRoute(req, compilerAuthenticator);
  if (compilerRoutePreauthentication.kind === "refused") return withCors(compilerRoutePreauthentication.response);

  const isOrdinaryActionAdmissionRecoveryRoute = method === "POST" && segments.length === 5
    && segments[0] === "api" && segments[1] === "sessions"
    && segments[3] === "action-admission" && segments[4] === "recover";
  const isCompiledIntentAdmissionRecoveryRoute = method === "POST" && segments.length === 5
    && segments[0] === "api" && segments[1] === "sessions"
    && segments[3] === "compiled-intent-admission" && segments[4] === "recover";
  const isOrdinarySessionCreationAdmissionRecoveryRoute = method === "POST" && segments.length === 4
    && segments[0] === "api" && segments[1] === "sessions"
    && segments[2] === "creation-admission" && segments[3] === "recover";
  const isCompiledSessionCreationAdmissionRecoveryRoute = method === "POST" && segments.length === 4
    && segments[0] === "api" && segments[1] === "sessions"
    && segments[2] === "compiled-creation-admission" && segments[3] === "recover";
  if (isOrdinaryActionAdmissionRecoveryRoute || isCompiledIntentAdmissionRecoveryRoute || isOrdinarySessionCreationAdmissionRecoveryRoute || isCompiledSessionCreationAdmissionRecoveryRoute) {
    // Operational recovery authenticates before *any* namespace inventory,
    // locator/store access, registry lookup, or body consumption. The request
    // can carry no fence, generation, owner, or replacement identity.
    const principal = await authenticateCompilerPrincipal(req, compilerAuthenticator);
    if (principal instanceof Response) return principal;
    if (principal.role !== "operator") {
      return runtimeAuthRefusal(
        isCompiledIntentAdmissionRecoveryRoute ? "COMPILED_INTENT_ADMISSION_RECOVERY_FORBIDDEN"
          : isCompiledSessionCreationAdmissionRecoveryRoute ? "COMPILED_SESSION_CREATION_ADMISSION_RECOVERY_FORBIDDEN"
            : isOrdinarySessionCreationAdmissionRecoveryRoute ? "ORDINARY_SESSION_CREATION_ADMISSION_RECOVERY_FORBIDDEN"
            : "ORDINARY_ACTION_RECOVERY_FORBIDDEN",
        "operator authorization is required",
        403,
      );
    }
    if (url.search || req.body !== null) return respondJson({
      code: isCompiledIntentAdmissionRecoveryRoute ? "compiled_intent_admission_recovery_body_forbidden"
        : isCompiledSessionCreationAdmissionRecoveryRoute ? "compiled_session_creation_admission_recovery_body_or_query_forbidden"
        : isOrdinarySessionCreationAdmissionRecoveryRoute ? "ordinary_session_creation_admission_recovery_body_forbidden"
          : "ordinary_action_recovery_body_forbidden",
    }, 400);
  }
  // These host-owned routes can reach a cross-process coordinator.
  // Authenticate before rejecting injected host configuration, so a caller
  // without a session credential cannot use a configuration fault as a
  // locator-independent oracle. Keeping this before reconciliation also means
  // a mismatched coordinator cannot cause inventory, snapshot, or body work.
  const isOrdinaryActionAdmissionDependentHostRoute = method === "POST"
    && segments[0] === "api" && segments[1] === "sessions"
    && (
      // `/action` is the legacy ordinary/compiled write surface. Its kind is
      // unknowable without reading the namespace, so an ordinary coordinator
      // mismatch deliberately fail-closes this ambiguous write route.
      (segments.length === 4 && ["action", "character", "party", "luck-spend"].includes(segments[3] ?? ""))
      || (segments.length === 5 && segments[3] === "kp" && segments[4] === "send-message")
    );
  const isCompiledIntentAdmissionDependentHostRoute = method === "POST"
    && segments[0] === "api" && segments[1] === "sessions"
    && segments.length === 5 && segments[3] === "compiled" && segments[4] === "intents";
  const isPlayerIntentRoute = method === "POST"
    && segments[0] === "api" && segments[1] === "sessions"
    && segments.length === 4 && segments[3] === "player-intents";
  const isPlayerFollowupRoute = method === "POST"
    && segments[0] === "api" && segments[1] === "sessions"
    && segments.length === 4 && segments[3] === "player-followups";
  const isPlayerInvitationClaimRoute = method === "POST"
    && segments[0] === "api" && segments[1] === "sessions"
    && segments.length === 5 && segments[3] === "player-invitations" && segments[4] === "claim";
  const isSnapshotPreauthenticatedPlayerFacadeRoute = isPlayerIntentRoute || isPlayerFollowupRoute
    || (method === "GET" && segments[0] === "api" && segments[1] === "sessions"
      && segments.length === 4 && segments[3] === "player-view")
    || (method === "POST" && segments[0] === "api" && segments[1] === "sessions"
      && segments.length === 4 && segments[3] === "player-actions");
  const isSnapshotPreauthenticatedPlayerRoute = isSnapshotPreauthenticatedPlayerFacadeRoute
    || isPlayerInvitationClaimRoute;
  let preauthenticatedHostRuntimeRequest: HostOwnedSessionRuntimeAuthentication | undefined;
  if (isOrdinaryActionAdmissionDependentHostRoute || isCompiledIntentAdmissionDependentHostRoute) {
    preauthenticatedHostRuntimeRequest = await authenticateHostOwnedSessionRuntimeRequest(req, compilerAuthenticator, ordinarySessionAccess);
    const preauthentication = isCompiledIntentAdmissionDependentHostRoute
      ? preauthenticatedHostRuntimeRequest.compiled
      : preauthenticatedHostRuntimeRequest.ordinary;
    if (preauthentication instanceof Response) return preauthentication;
  }
  // A caller that supplies a session root expects both durable kinds to stay
  // inside that one namespace domain.  Do not let the process-global compiled
  // default leak unrelated fixture/production evidence into this root.
  if (storage.sessionRoot && compiledSnapshots === defaultCompiledSessionSnapshots) {
    compiledSnapshots = new CompiledSessionSnapshotStore({ root: join(storage.sessionRoot, "compiled-snapshots") });
  }
  const registry = sessionRuntime.registry ?? sessions;
  const ordinarySnapshots = sessionRuntime.ordinarySnapshots ?? (storage.sessionRoot
    ? new OrdinarySessionSnapshotStore({ root: join(storage.sessionRoot, "ordinary-snapshots") })
    : defaultOrdinarySessionSnapshots);
  const nextOrdinarySessionId = sessionRuntime.generateSessionId ?? generateId;
  const ordinaryIntentPolicy = sessionRuntime.ordinaryIntentPolicy === "development_fallback"
    ? createEnvironmentOrdinaryIntentPolicy({
      ORDINARY_SESSION_INTENT_POLICY: "development_fallback",
      NODE_ENV: sessionRuntime.runtimeNodeEnv ?? Reflect.get(process.env, "NODE_ENV"),
    })
    : sessionRuntime.ordinaryIntentPolicy ?? createEnvironmentOrdinaryIntentPolicy();
  const ordinarySessionIntentClient = sessionRuntime.ordinarySessionIntentClient;
  const createOrdinarySession = (input: {
    id: string;
    ruleset: RulesetId;
    archetypeId?: string;
    characterName?: string;
    persona: ConstructorParameters<typeof GameSession>[5];
    storage: { careerRoot?: string; sessionRoot?: string };
    access: NonNullable<ConstructorParameters<typeof GameSession>[7]>;
    intentPolicy: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">;
    sessionIntentClient?: NormalSessionIntentClient;
    runtimeDependencies: { ordinaryDurableHostCapability: object };
  }): GameSession => {
    const session = sessionRuntime.createOrdinarySession
      ? sessionRuntime.createOrdinarySession(input)
      : createServerGameSession(
        input.id,
        input.ruleset,
        undefined,
        input.archetypeId,
        input.characterName,
        input.persona,
        input.storage,
        input.access,
        input.intentPolicy,
        input.sessionIntentClient,
        input.runtimeDependencies,
      );
    if (!(session instanceof GameSession)) throw new Error("ordinary session factory returned an invalid target");
    assertOrdinaryDurableHostCapability(session, input.runtimeDependencies.ordinaryDurableHostCapability);
    return session;
  };
  // The recovery constructor is host wiring and never request-selected. It is
  // also the one pristine constructor used by an ordinary action transaction:
  // candidates receive a staging career root, while authoritative replacements
  // receive the real runtime storage and still restore/validate the envelope.
  const createOrdinaryRecoverySession = (input: {
    id: string;
    access: NonNullable<ConstructorParameters<typeof GameSession>[7]>;
    storage: { careerRoot?: string; sessionRoot?: string };
    intentPolicy: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">;
    sessionIntentClient?: NormalSessionIntentClient;
    runtimeDependencies: { ordinaryDurableHostCapability: object };
  }) => {
    const trustedInput = {
      ...input,
      sessionIntentClient: input.sessionIntentClient ?? ordinarySessionIntentClient,
      runtimeDependencies: input.runtimeDependencies,
    };
    const session = sessionRuntime.createOrdinaryRecoverySession
      ? sessionRuntime.createOrdinaryRecoverySession(trustedInput)
      : createOrdinarySession({
        id: trustedInput.id,
        ruleset: "cosmic-horror",
        archetypeId: undefined,
        characterName: undefined,
        persona: {},
        storage: trustedInput.storage,
        access: trustedInput.access,
        intentPolicy: trustedInput.intentPolicy,
        sessionIntentClient: trustedInput.sessionIntentClient,
        runtimeDependencies: trustedInput.runtimeDependencies,
      });
    if (!(session instanceof GameSession)) throw new Error("ordinary recovery factory returned an invalid target");
    assertOrdinaryDurableHostCapability(session, trustedInput.runtimeDependencies.ordinaryDurableHostCapability);
    return session;
  };
  // Compiled snapshots contain only portable mechanics state. Constructor
  // configuration is host authority and is deliberately never recovered from
  // a prior GameSession observation or from request/module JSON.
  const createCompiledRecoverySession = (input: {
    id: string;
    storage: { careerRoot?: string; sessionRoot?: string };
  }): GameSession => {
    const runtimeDependencies = { compiledDurableHostCapability };
    const session = sessionRuntime.createCompiledRecoverySession
      ? sessionRuntime.createCompiledRecoverySession({ ...input, runtimeDependencies })
      : createServerGameSession(
        input.id,
        "cosmic-horror",
        loadConfig(),
        undefined,
        undefined,
        undefined,
        input.storage,
        undefined,
        undefined,
        undefined,
        runtimeDependencies,
      );
    assertCompiledDurableHostCapability(session, runtimeDependencies.compiledDurableHostCapability);
    return session;
  };

  const runtimeNamespace = sessionRuntime.sessionNamespace ?? new SessionNamespaceCoordinator(
    runtimeSessionNamespaceRoot(storage),
    { allowLegacyMigration: sessionRuntime.allowSessionNamespaceLegacyMigration === true },
  );
  const ordinaryActionAdmission = sessionRuntime.ordinaryActionAdmission
    ?? new OrdinaryActionAdmissionCoordinator(runtimeSessionNamespaceRoot(storage));
  const injectedOrdinarySessionCreationAdmission = sessionRuntime.ordinarySessionCreationAdmission;
  const ordinarySessionCreationAdmission = injectedOrdinarySessionCreationAdmission
    ?? defaultOrdinarySessionCreationAdmission(runtimeSessionNamespaceRoot(storage));
  const injectedCompiledSessionCreationAdmission = sessionRuntime.compiledSessionCreationAdmission;
  // Direct trusted hosts may use a same-root default for creation. Recovery
  // never does: it requires an explicit operator-owned injected instance.
  const compiledSessionCreationAdmission = injectedCompiledSessionCreationAdmission
    ?? defaultCompiledSessionCreationAdmission(runtimeSessionNamespaceRoot(storage));
  const compiledIntentAdmission = sessionRuntime.compiledIntentAdmission
    ?? new CompiledIntentAdmissionCoordinator(runtimeSessionNamespaceRoot(storage));
  // Unlike the lease coordinator, the result ledger is relevant to only the
  // two classified-intent routes. Defer even its construction until their
  // credential/domain gates succeed; unauthenticated requests must not get an
  // observable ledger dependency.
  let compiledIntentReplay = sessionRuntime.compiledIntentReplay;
  const compiledIntentReplayForRoute = (): CompiledIntentReplayStore => {
    if (!compiledIntentReplay) {
      compiledIntentReplay = new CompiledIntentReplayStore(runtimeSessionNamespaceRoot(storage));
    }
    return compiledIntentReplay;
  };
  const ordinaryActionAdmissionDomainMatches = hasExactOrdinaryActionAdmissionDomain(ordinaryActionAdmission, runtimeNamespace);
  const ordinarySessionCreationAdmissionDomainMatches = hasExactOrdinarySessionCreationAdmissionDomain(ordinarySessionCreationAdmission, runtimeNamespace);
  const compiledSessionCreationAdmissionDomainMatches = hasExactCompiledSessionCreationAdmissionDomain(compiledSessionCreationAdmission, runtimeNamespace);
  const compiledIntentAdmissionDomainMatches = hasExactCompiledIntentAdmissionDomain(compiledIntentAdmission, runtimeNamespace);
  const compiledIntentReplayDomainMatches = () => hasExactCompiledIntentReplayDomain(compiledIntentReplayForRoute(), runtimeNamespace);
  // The player facade has an independent credential protocol. It must prove a
  // complete immutable snapshot before the process scans or writes namespace
  // inventory; a header alone is not an authority or an authentication grant.
  let preauthenticatedPlayerFacade: PreauthenticatedCompiledPlayerFacade | undefined;
  let preauthenticatedPlayerInvitationClaim: PreauthenticatedPlayerInvitationClaim | undefined;
  if (isSnapshotPreauthenticatedPlayerFacadeRoute) {
    const preauthenticated = await preauthenticateCompiledPlayerFacadeRequest(
      req,
      segments[2] ?? "",
      compiledSnapshots,
      playerDelivery,
      compilerAuthenticator,
    );
    if (preauthenticated instanceof Response) return withPlayerNoStore(preauthenticated);
    preauthenticatedPlayerFacade = preauthenticated;
  }
  if (isPlayerInvitationClaimRoute) {
    const parsed = await parsePlayerInvitationClaim(req);
    if (parsed.status !== "ok") {
      return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INVITATION_UNAVAILABLE" } }, jsonBodyFailureStatus(parsed)));
    }
    const preauthenticated = preauthenticatePlayerInvitationClaim(
      req,
      segments[2] ?? "",
      parsed.value.invite,
      parsed.value.claimId,
      compiledSnapshots,
      playerDelivery,
    );
    if (preauthenticated instanceof Response) return withPlayerNoStore(preauthenticated);
    preauthenticatedPlayerInvitationClaim = preauthenticated;
  }
  const preauthenticatedPlayerSnapshotIdentity = preauthenticatedPlayerFacade?.identity
    ?? preauthenticatedPlayerInvitationClaim?.identity;
  // Recovery authentication/body opacity is established above. Ordinary
  // durable routes authenticated just above, so both paths can fail closed
  // before reconciliation, locator lookup, request consumption, or writes.
  if ((isOrdinaryActionAdmissionRecoveryRoute || isOrdinaryActionAdmissionDependentHostRoute)
    && !ordinaryActionAdmissionDomainMatches) return ordinaryActionAdmissionDomainMismatchResponse();
  if (isOrdinarySessionCreationAdmissionRecoveryRoute) {
    // This is a host-operation recovery control plane: unlike POST create it
    // must never silently materialize a fallback coordinator. Main injects
    // exactly one initialized process coordinator; direct callers must supply
    // the same explicit authority.
    if (!injectedOrdinarySessionCreationAdmission || !ordinarySessionCreationAdmissionDomainMatches) {
      return respondJson({ code: "ordinary_session_creation_admission_recovery_unavailable" }, 503, { "Retry-After": "1" });
    }
    const recovered = injectedOrdinarySessionCreationAdmission.recoverExpiredForOperator();
    if (recovered.status === "recovered") {
      return respondJson({
        status: "recovered",
        code: "ordinary_session_creation_admission_recovered",
        providerOutcome: "unknown",
      });
    }
    if (recovered.status === "absent") {
      return respondJson({ status: "absent", code: "ordinary_session_creation_admission_absent" });
    }
    return respondJson({ code: "ordinary_session_creation_admission_recovery_unavailable" }, 503, {
      "Retry-After": String(recovered.retryAfterSeconds),
    });
  }
  if (isCompiledSessionCreationAdmissionRecoveryRoute) {
    // Do not turn an operator recovery request into a construction of the
    // direct-handler fallback. Only main's explicitly injected coordinator is
    // authorized to clear an exact persisted quarantine.
    if (!injectedCompiledSessionCreationAdmission || !compiledSessionCreationAdmissionDomainMatches) {
      return respondJson({ code: "compiled_session_creation_admission_recovery_unavailable" }, 503, { "Retry-After": "1" });
    }
    const recovered = injectedCompiledSessionCreationAdmission.recoverExpiredForOperator();
    if (recovered.status === "recovered") {
      return respondJson({
        status: "recovered",
        code: "compiled_session_creation_admission_recovered",
        providerOutcome: "unknown",
      });
    }
    if (recovered.status === "absent") {
      return respondJson({ status: "absent", code: "compiled_session_creation_admission_absent" });
    }
    return respondJson({ code: "compiled_session_creation_admission_recovery_unavailable" }, 503, {
      "Retry-After": String(recovered.retryAfterSeconds),
    });
  }
  // This check is deliberately before namespace inventory, resolver, body,
  // catalog, or storage observation. A wrong durable lock domain cannot fall
  // back to the process-local ingress admission.
  const isCompiledSessionCreationRoute = method === "POST" && segments.length === 3
    && segments[0] === "api" && segments[1] === "sessions" && segments[2] === "compiled";
  if (isCompiledSessionCreationRoute) {
    if (!compiledSessionCreationAdmissionDomainMatches) {
      return respondJson({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_UNAVAILABLE", message: "compiled session creation is unavailable" } }, 503, { "Retry-After": "1" });
    }
    // Direct trusted hosts may not yet have asked the namespace coordinator
    // to create its root. This creates only the host-selected directory; the
    // admission coordinator immediately lstat-verifies it and all SQLite
    // sidecars, so a link/file never becomes an acceptable lock domain.
    if (!injectedCompiledSessionCreationAdmission) {
      try { mkdirSync(runtimeNamespace.root, { recursive: true }); }
      catch {
        return respondJson({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_UNAVAILABLE", message: "compiled session creation is unavailable" } }, 503, { "Retry-After": "1" });
      }
    }
    try { compiledSessionCreationAdmission.initialize(); }
    catch {
      return respondJson({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_UNAVAILABLE", message: "compiled session creation is unavailable" } }, 503, { "Retry-After": "1" });
    }
  }
  // Recovery only repairs the admission coordinator. It never reads the replay
  // ledger, so an injected ledger from a different root must not turn a valid
  // operator recovery into an unrelated dependency failure.
  if (isCompiledIntentAdmissionRecoveryRoute && !compiledIntentAdmissionDomainMatches) {
    return compiledIntentAdmissionDomainMismatchResponse();
  }
  if (isCompiledIntentAdmissionDependentHostRoute
    && (!compiledIntentAdmissionDomainMatches || !compiledIntentReplayDomainMatches())) {
    return compiledIntentAdmissionDomainMismatchResponse();
  }
  if (isPlayerIntentRoute && (!compiledIntentAdmissionDomainMatches || !compiledIntentReplayDomainMatches())) {
    return withPlayerNoStore(compiledIntentAdmissionDomainMismatchResponse());
  }
  const runtimeNamespaceGate = namespaceGate(runtimeNamespace);
  const runtimeInventoryDomain = runtimeSessionInventoryDomain(ordinarySnapshots, compiledSnapshots, storage);
  if (!hasReconciledRuntimeSessionNamespace(runtimeNamespace, runtimeInventoryDomain)) {
    try {
      // Direct handlers still bootstrap lazily. A completed production startup
      // with the same coordinator/domain skips this full durable inventory.
      reconcileRuntimeSessionNamespace(runtimeNamespace, ordinarySnapshots, compiledSnapshots, storage);
    } catch (error) {
      log.error("session-namespace", "runtime namespace bootstrap failed", error);
      return respondJson({ error: { stage: "persistence", code: "SESSION_NAMESPACE_UNAVAILABLE", message: "runtime session namespace is unavailable" } }, 503, { "Retry-After": "1" });
    }
  }
  const compiledCreationStagingRoots = new WeakMap<object, string>();

  const catalog = compilerCatalog ?? defaultCompilerCatalog;
  const compiledResponse = await handleCompiledModuleHttpRequest(req, {
    compiledDurableHostCapability,
    createSession: (id, archetype, characterName, persona) => {
      const root = join(storage.careerRoot ?? join(process.cwd(), "data", "careers"), ".compiled-create-staging", randomUUID());
      const staged = createServerGameSession(id, "cosmic-horror", undefined, archetype, characterName, persona, {
        careerRoot: join(root, "careers"),
      }, undefined, undefined, undefined, { compiledDurableHostCapability });
      compiledCreationStagingRoots.set(staged, root);
      return staged;
    },
    hasSession: (id) => registry.has(id),
    unregisterSession: (id, expectedSession) => {
      if (registry.get(id) === expectedSession) registry.delete(id);
      (expectedSession as GameSession).close();
      const stagingRoot = compiledCreationStagingRoots.get(expectedSession as object);
      if (stagingRoot) {
        compiledCreationStagingRoots.delete(expectedSession as object);
        try { if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* staging is never authority */ }
      }
    },
    registerSession: (id, session) => registry.set(id, session as GameSession),
    persistSession: (_id, _session, _bundleId, snapshot, permit) => {
      const saved = compiledSnapshots.save(snapshot, permit ? { permit } : undefined, permit ? runtimeNamespaceGate : undefined);
      const exactReadback = () => {
        const reread = compiledSnapshots.read(snapshot.sessionId);
        if (reread.status === "ok" && reread.value && typeof reread.value === "object") {
          const observed = reread.value as CompiledSessionSnapshot;
          if (observed.snapshotHash === snapshot.snapshotHash && observed.generation === snapshot.generation) {
            return { status: "published" as const, observedIdentity: compiledNamespaceIdentity(observed) };
          }
        }
        return undefined;
      };
      if (saved.status === "ok") return exactReadback() ?? { status: "indeterminate" as const };
      if (saved.status === "indeterminate") return exactReadback() ?? { status: "indeterminate" as const };
      // Keep the subordinate store's typed refusal intact. The coordinator
      // keeps this in-process classification while leaving the prepared row
      // terminally releasable; no storage detail leaves this boundary.
      return { status: "not-published" as const, failureCode: saved.code };
    },
    recoverPersistedSession: (id, _expectedSession, principal, expectedSnapshot) => {
      // Never let a process-local registration outrank a possibly committed
      // create. Re-open authority first and bind it to the exact snapshot this
      // request attempted; owner equality alone cannot distinguish Mallory's
      // same-owner in-memory state from Ada's published body.
      const recovered = hydrateCompiledSession(id, {
        catalog,
        snapshots: compiledSnapshots,
        sessionNamespace: runtimeNamespace,
        compiledDurableHostCapability,
        createSession: (sessionId, _runtimeDependencies) => createCompiledRecoverySession({ id: sessionId, storage }),
      });
      if (recovered.status === "refused") throw new Error(`${recovered.code}: ${recovered.message}`);
      if (!sameCompiledSessionRecoveryIdentity(recovered.identity, expectedSnapshot)) {
        recovered.session.close();
        throw new Error("durable compiled session recovery does not match the attempted snapshot");
      }
      const authorized = authorizeCompiledSessionRuntimePrincipal(principal, recovered.session, false, true, compiledDurableHostCapability);
      if (authorized instanceof Response) {
        recovered.session.close();
        throw new Error("durable compiled session recovery is not authorized");
      }
      const adopted = registry.get(id);
      if (adopted && sessionMatchesCompiledSessionRecoveryIdentity(adopted, recovered.identity, compiledDurableHostCapability)) {
        const adoptedAuthorized = authorizeCompiledSessionRuntimePrincipal(principal, adopted, false, true, compiledDurableHostCapability);
        recovered.session.close();
        if (adoptedAuthorized instanceof Response) throw new Error("durable compiled session recovery is not authorized");
        return adopted;
      }
      // A stale or fabricated same-owner entry is not a recovery winner. The
      // validated durable body is the only state allowed to replace it.
      adopted?.close();
      registry.set(id, recovered.session);
      compiledSessionDiagnostics.delete(id);
      return recovered.session;
    },
    hasDurableSession: (id) => compiledSnapshots.isOccupied(id) || ordinarySnapshots.isOccupied(id) || sessionMetaExists(id, storage.sessionRoot) || existsSync(join(storage.careerRoot ?? join(process.cwd(), "data", "careers"), id)),
    rollbackSessionStorage: (id) => {
      // A compiled contender must never tear down a career projection owned by
      // an ordinary envelope. The durable ordinary root is authoritative even
      // when its memory/legacy metadata projection has been evicted.
      if (ordinarySnapshots.isOccupied(id)) return;
      deleteSessionFile(id, storage.sessionRoot);
      const careerDir = join(storage.careerRoot ?? join(process.cwd(), "data", "careers"), id);
      if (existsSync(careerDir)) rmSync(careerDir, { recursive: true });
    },
    generateId: sessionRuntime.generateCompiledSessionId ?? generateId,
    sessionNamespace: runtimeNamespace,
    compiledSessionCreationAdmission,
    logError: (error) => log.error("compiler-http", "compiled module lifecycle failed", error),
    catalog,
    resolveCompiledWorldModelBinding: sessionRuntime.resolveCompiledWorldModelBinding,
    autoCompiler: configuredAutoCompiler(compilerAutoOptions),
    // This remains available while automatic compilation is disabled: an
    // operator may need to clear a crash-reclaimed physical slot before a
    // later re-enable. The route itself authenticates as operator before this
    // host-owned callback is invoked and supplies no caller identity/fence.
    recoverAutoAdmissionReclaimQuarantine: () => (compilerAutoOptions.admission ?? getDefaultCompilerAutoAdmission()).recoverReclaimQuarantineForOperator(),
    authenticateCompilerRequest: compilerAuthenticator,
    ...(compilerRoutePreauthentication.kind === "authorized"
      ? { compilerHttpRoutePreauthorization: compilerRoutePreauthentication.preauthorization }
      : {}),
    resolveCompiledSessionPlayer: compiledPlayerResolver,
    playerDelivery,
  });
  if (compiledResponse) return withCors(compiledResponse);

  // GET / → 前端构建产物；没有构建产物时回落到内置测试页
  if (method === "GET" && segments.length === 0) {
    const index = await serveStatic("/index.html");
    return index ?? serveTestPage();
  }

  // GET /api → 健康检查
  if (method === "GET" && segments[0] === "api" && segments.length === 1) {
    return respondJson({
      status: "ok",
      activeSessions: registry.size,
      version: "0.1.0",
      endpoints: [
        "POST /api/sessions — 创建游戏会话",
        "POST /api/compiler/prepare?moduleId=:id — 准备 PDF 编译产物",
        "POST /api/compiler/resolve — 解析并投影编译产物",
        "POST /api/compiler/auto-resolve — 从已保存 prepared artifact 自动解析 mechanics；需人工 presentation 接管才能发布",
        "POST /api/compiler/presentation-workbench — operator 只读获取 exact-source presentation 候选",
        "POST /api/compiler/presentation-reviews — 以已认证 operator 身份保存 exact-source presentation review",
        "GET /api/source-research?workId=<single> — 查询只读审核来源收据",
        "GET /api/slot-research?workId=<single> — 查询只读审核槽位研究收据",
        "POST /api/sessions/compiled — 创建编译模组会话",
        "GET /api/sessions — 列出会话",
        "GET /api/sessions/:id — 会话摘要",
        "POST /api/sessions/:id/action — 执行玩家行动",
        "GET /api/sessions/:id/compiled/actions?pcId=p1 — 当前编译动作",
        "POST /api/sessions/:id/compiled/actions — 执行已选编译动作",
        "POST /api/sessions/:id/compiled/intents — 解析编译动作意图",
        "GET /api/sessions/:id/history — 对话历史",
        "GET /api/sessions/:id/state — 世界状态",
      ],
    });
  }

  //   }

  // GET /api/archetypesGET /api/archetypes — 可用职业模板
  if (method === "GET" && segments[0] === "api" && segments[1] === "archetypes" && segments.length === 2) {
    const rulesetFilter = query.get("ruleset") || undefined;
    return respondJson({
      archetypes: CharacterFactory.listArchetypes(rulesetFilter),
    });
  }

  // ── 模组编辑器 ──

  // GET /api/modules — 列出所有模块
  if (method === "GET" && segments[0] === "api" && segments[1] === "modules" && segments.length === 2) {
    const authorized = await authorizeModuleEditorRequest(req, compilerAuthenticator);
    if (authorized instanceof Response) return authorized;
    try {
      return respondJson({ modules: listSavedModules() });
    } catch {
      return respondJson({ error: { stage: "module", code: "MODULE_STORAGE_UNAVAILABLE", message: "module storage is unavailable" } }, 503);
    }
  }

  // GET /api/modules/:id — 获取单个模组
  if (method === "GET" && segments[0] === "api" && segments[1] === "modules" && segments.length === 3) {
    const authorized = await authorizeModuleEditorRequest(req, compilerAuthenticator);
    if (authorized instanceof Response) return authorized;
    if (!isSafeModuleId(segments[2])) return respondError("module not found", 404);
    let mod;
    try { mod = loadModuleFile(segments[2]); }
    catch { return respondJson({ error: { stage: "module", code: "MODULE_STORAGE_UNAVAILABLE", message: "module storage is unavailable" } }, 503); }
    if (!mod) return respondError("模组不存在", 404);
    return respondJson({ module: mod });
  }

  // POST /api/modules — 新建或保存模块
  if (method === "POST" && segments[0] === "api" && segments[1] === "modules" && segments.length === 2) {
    const authorized = await authorizeModuleEditorRequest(req, compilerAuthenticator);
    if (authorized instanceof Response) return authorized;
    const parsedBody = await readJsonRecord(req, GENERAL_JSON_MAX_BYTES);
    if (parsedBody.status !== "ok") return respondJson({ error: { stage: "request", code: "JSON_BODY_INVALID", message: "request body is invalid" } }, jsonBodyFailureStatus(parsedBody));
    const body = parsedBody.value;
    const parsed = parseMythosModule(body);
    if (!parsed.ok) return respondError(parsed.error, 400);
    try { saveModuleFile(parsed.module); }
    catch { return respondJson({ error: { stage: "module", code: "MODULE_STORAGE_UNAVAILABLE", message: "module storage is unavailable" } }, 503); }
    return respondJson({ success: true });
  }

  // PUT /api/modules/:id — 更新模组
  if (method === "PUT" && segments[0] === "api" && segments[1] === "modules" && segments.length === 3) {
    const authorized = await authorizeModuleEditorRequest(req, compilerAuthenticator);
    if (authorized instanceof Response) return authorized;
    if (!isSafeModuleId(segments[2])) return respondError("module not found", 404);
    const parsedBody = await readJsonRecord(req, GENERAL_JSON_MAX_BYTES);
    if (parsedBody.status !== "ok") return respondJson({ error: { stage: "request", code: "JSON_BODY_INVALID", message: "request body is invalid" } }, jsonBodyFailureStatus(parsedBody));
    const body = parsedBody.value;
    let existing;
    try { existing = loadModuleFile(segments[2]); }
    catch { return respondJson({ error: { stage: "module", code: "MODULE_STORAGE_UNAVAILABLE", message: "module storage is unavailable" } }, 503); }
    if (!existing) return respondError("模组不存在", 404);
    // 合并后再解析：局部更新也不能把文档改成非法形状。
    const parsed = parseMythosModule({ ...existing, ...body, id: segments[2] });
    if (!parsed.ok) return respondError(parsed.error, 400);
    try { saveModuleFile(parsed.module); }
    catch { return respondJson({ error: { stage: "module", code: "MODULE_STORAGE_UNAVAILABLE", message: "module storage is unavailable" } }, 503); }
    return respondJson({ success: true });
  }

  // DELETE /api/modules/:id — 删除模组
  if (method === "DELETE" && segments[0] === "api" && segments[1] === "modules" && segments.length === 3) {
    const authorized = await authorizeModuleEditorRequest(req, compilerAuthenticator);
    if (authorized instanceof Response) return authorized;
    if (!isSafeModuleId(segments[2])) return respondError("module not found", 404);
    try { deleteModuleFile(segments[2]); }
    catch { return respondJson({ error: { stage: "module", code: "MODULE_STORAGE_UNAVAILABLE", message: "module storage is unavailable" } }, 503); }
    return respondJson({ success: true });
  }

  // ── 会话管理 ──

  // POST /api/sessions — 创建新会话
  if (method === "POST" && segments[0] === "api" && segments[1] === "sessions" && segments.length === 2) {
    // This must stay before body consumption, session construction, and the
    // opening-model call. The body cannot declare an owner or role.
    const principal = await authorizeOrdinarySessionCreation(req, compilerAuthenticator, ordinarySessionAccess);
    if (principal instanceof Response) return principal;
    const access = createOrdinarySessionAccessBinding(principal);
    let ruleset: RulesetId = "cosmic-horror";
    let archetypeId: string | undefined;
    let characterName: string | undefined;
    // Only a genuinely absent body retains the historical default-create
    // contract. A supplied malformed document is rejected before allocation.
    const parsedBody = await readJsonRecord(req, GENERAL_JSON_MAX_BYTES);
    if (parsedBody.status !== "ok" && parsedBody.status !== "bodyless") {
      return respondJson({ error: { stage: "request", code: "JSON_BODY_INVALID", message: "request body is invalid" } }, jsonBodyFailureStatus(parsedBody));
    }
    const body: JsonRecord = parsedBody.status === "ok" ? parsedBody.value : {};
    const requestedRuleset = bodyString(body, "ruleset");
    if (requestedRuleset === "dnd5e" || requestedRuleset === "grail") {
      // This durable increment has one portable ordinary snapshot contract.
      // Reject before allocating an ID, constructing a career projection, or
      // making the opening-model call; a late persistence 503 would misstate
      // a deterministic unsupported request as transient infrastructure.
      return respondJson({ error: { stage: "contract", code: "ORDINARY_RULESET_UNSUPPORTED", message: "durable ordinary sessions currently require cosmic-horror" } }, 422);
    }
    archetypeId = bodyString(body, "archetype") ?? archetypeId;
    characterName = bodyString(body, "characterName") ?? characterName;
    if (archetypeId !== undefined && !CharacterFactory.listArchetypes(ruleset).some((archetype) => archetype.id === archetypeId)) {
      // Validate against the construction registry before a durable request can
      // reserve an ID, create a staged career tree, or invoke opening LLMs.
      return respondJson({
        error: {
          stage: "contract",
          code: "ORDINARY_ARCHETYPE_UNKNOWN",
          message: "requested cosmic-horror archetype is unavailable",
        },
      }, 422);
    }
    // p1 的扮演元数据（personality/backstory/currentGoal）——HTTP 字段为兜底链最
    // 优先一层，其余层（模组/推导/LLM）在 GameSession 构造里补。
    const persona = {
      ...(bodyString(body, "personality") === undefined ? {} : { personality: bodyString(body, "personality") }),
      ...(bodyString(body, "backstory") === undefined ? {} : { backstory: bodyString(body, "backstory") }),
      ...(bodyString(body, "currentGoal") === undefined ? {} : { currentGoal: bodyString(body, "currentGoal") }),
    };
    // Admission happens only after caller and body contract validation, but
    // before IDs, namespace rows, staging directories, constructors, or LLMs.
    if (!hasExactOrdinarySessionCreationAdmissionDomain(ordinarySessionCreationAdmission, runtimeNamespace)) {
      return respondJson({ error: { stage: "admission", code: "ORDINARY_SESSION_CREATION_UNAVAILABLE", message: "ordinary session creation is unavailable" } }, 503, { "Retry-After": "1" });
    }
    try { ordinarySessionCreationAdmission.initialize(); }
    catch {
      return respondJson({ error: { stage: "admission", code: "ORDINARY_SESSION_CREATION_UNAVAILABLE", message: "ordinary session creation is unavailable" } }, 503, { "Retry-After": "1" });
    }
    const creationAdmission = ordinarySessionCreationAdmission.acquire({ principalFingerprint: access.ownerPrincipalFingerprint });
    if (creationAdmission.status !== "acquired") return ordinarySessionCreationAdmissionResponse(creationAdmission);
    const creationAdmissionGuard = guardOrdinarySessionCreationAdmission(creationAdmission, req.signal);
    let creationAdmissionReleased = false;
    const releaseCreationAdmission = () => {
      if (creationAdmissionReleased) return;
      creationAdmissionReleased = true;
      creationAdmissionGuard.stop();
      releaseOrdinarySessionCreationAdmission(creationAdmission);
    };
    // Every exit after acquire—including an unexpected staging or recovery
    // failure—must settle the independent lease.  Explicit releases below
    // preserve their local ordering; this idempotent finalizer covers throws.
    try {
    // Reserve before the factory: a loser must not construct a career or
    // start its opening model call merely because an ID looked free locally.
    const allocation = reserveOrdinarySessionId(registry, nextOrdinarySessionId, runtimeNamespace, ordinarySessionCreationAdmission.wholeJobDeadlineMs);
    if (allocation.status !== "reserved") {
      releaseCreationAdmission();
      const code = allocation.failure?.code ?? "SESSION_NAMESPACE_STORAGE_FAILED";
      return respondJson({ error: { stage: "persistence", code, message: "ordinary session namespace is unavailable" } }, 503, { "Retry-After": "1" });
    }
    const { id, reservation } = allocation;
    const creationStagingRoot = join(storage.careerRoot ?? join(process.cwd(), "data", "careers"), ".ordinary-create-staging", randomUUID());
    const stagingStorage = { careerRoot: join(creationStagingRoot, "careers"), sessionRoot: join(creationStagingRoot, "sessions") };
    let session: GameSession;
    try {
      session = createOrdinarySession({
        id, ruleset, archetypeId, characterName, persona, storage: stagingStorage, access, intentPolicy: ordinaryIntentPolicy,
        sessionIntentClient: ordinarySessionIntentClient,
        runtimeDependencies: { ordinaryDurableHostCapability: serverOrdinaryDurableHostCapability },
      });
    } catch (error) {
      releaseCreationAdmission();
      try { runtimeNamespace.release({ reservation, reasonCode: "CREATE_CONSTRUCTION_FAILED" }); } catch { /* tombstone best effort; never construct again */ }
      try { if (existsSync(creationStagingRoot)) rmSync(creationStagingRoot, { recursive: true, force: true }); } catch { /* staging is non-authoritative */ }
      log.error("ordinary-session", "ordinary session staging construction failed", error);
      return respondJson({ error: { stage: "persistence", code: "ORDINARY_SESSION_PERSISTENCE_UNAVAILABLE", message: "ordinary session persistence is unavailable" } }, 503, { "Retry-After": "1" });
    }
    // A staging object is never authority after an exit path. Its own cleanup
    // failure must not turn a durable g0 commit into a rejected request or
    // strand the independent creation-admission lease.
    const closeStagingSession = () => {
      try { session.close(); }
      catch { log.error("ordinary-session", "ordinary session staging cleanup failed"); }
    };

    // 生成开场描述
    // A cancelled client cannot own a generation-zero publication. This runs
    // before `prepare`, while the reservation and staging tree are still ours.
    const abortOrdinarySessionCreation = (): Response => {
      releaseCreationAdmission();
      try { runtimeNamespace.release({ reservation, reasonCode: "CREATE_REQUEST_ABORTED" }); }
      catch { /* preserve uncertain namespace evidence rather than touching another owner */ }
      closeStagingSession();
      try { if (existsSync(creationStagingRoot)) rmSync(creationStagingRoot, { recursive: true, force: true }); }
      catch { /* staging is never authority */ }
      return respondJson({
        error: {
          stage: "request",
          code: "REQUEST_ABORTED",
          message: "request was aborted before ordinary session creation completed",
        },
      }, 408);
    };

    if (req.signal.aborted) return abortOrdinarySessionCreation();

    let opening = "";
    let openingStatus: "ready" | "fallback" = "ready";
    let openingCode: "ORDINARY_OPENING_UNAVAILABLE" | undefined;
    try {
      opening = await session.getOpeningScene(creationAdmissionGuard.signal, (result) => {
        if (result.status !== "fallback") return;
        openingStatus = "fallback";
        openingCode = "ORDINARY_OPENING_UNAVAILABLE";
      });
    } catch {
      if (req.signal.aborted) return abortOrdinarySessionCreation();
      if (creationAdmissionGuard.failed()) {
        releaseCreationAdmission();
        try { runtimeNamespace.release({ reservation, reasonCode: "CREATE_ADMISSION_EXPIRED" }); } catch { /* preserve unknown terminal state */ }
        closeStagingSession();
        try { if (existsSync(creationStagingRoot)) rmSync(creationStagingRoot, { recursive: true, force: true }); } catch { /* staging only */ }
        return respondJson({ error: { stage: "admission", code: "ORDINARY_SESSION_CREATION_UNAVAILABLE", message: "ordinary session creation is unavailable" } }, 503, { "Retry-After": "1" });
      }
      opening = ORDINARY_OPENING_FALLBACK;
      openingStatus = "fallback";
      openingCode = "ORDINARY_OPENING_UNAVAILABLE";
    }

    // The provider may settle concurrently with a disconnect. Recheck before
    // preparing or publishing any durable ordinary-session state.
    if (req.signal.aborted) return abortOrdinarySessionCreation();
    creationAdmissionGuard.stop();
    if (creationAdmissionGuard.failed() || creationAdmission.checkActive().status !== "active") {
      releaseCreationAdmission();
      try { runtimeNamespace.release({ reservation, reasonCode: "CREATE_ADMISSION_EXPIRED" }); } catch { /* preserve unknown terminal state */ }
      closeStagingSession();
      try { if (existsSync(creationStagingRoot)) rmSync(creationStagingRoot, { recursive: true, force: true }); } catch { /* staging only */ }
      return respondJson({ error: { stage: "admission", code: "ORDINARY_SESSION_CREATION_UNAVAILABLE", message: "ordinary session creation is unavailable" } }, 503, { "Retry-After": "1" });
    }

    // The generation-zero envelope is the authority. Listing metadata is not
    // written here: a separately mutable JSON summary must never outrank the
    // owner-bound portable snapshot.
    let createdEnvelope: OrdinarySessionEnvelope;
    let publicationIndeterminate = false;
    let publicationPreparedReleased = false;
    let publicationFailureCode: OrdinarySessionSnapshotRefusalCode | undefined;
    try {
      // The store re-validates this wire before it writes. Adopt that exact
      // normalized envelope now, before preparing a Career intent, so the
      // staged projection and restart target cannot differ by wire-only
      // normalization performed at the ordinary persistence boundary.
      const envelope = validateOrdinarySessionEnvelope(createOrdinarySessionEnvelope({
        kind: "ordinary-session-envelope",
        schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
        sessionId: id,
        generation: 0,
        previousEnvelopeHash: null,
        access,
        snapshot: session.exportOrdinarySessionSnapshot(),
        idempotency: [],
      }));
      createdEnvelope = envelope;
      const prepared = runtimeNamespace.prepare({ reservation, expectedIdentity: ordinaryNamespaceIdentity(envelope) });
      const published = runtimeNamespace.publishPrepared({
        reservation: prepared,
        publish: (permit) => {
          const persisted = ordinarySnapshots.save(envelope, { permit }, runtimeNamespaceGate);
          if (persisted.status !== "ok") {
            const recovered = persisted.status === "indeterminate" ? ordinarySnapshots.read(id) : undefined;
            if (recovered?.status === "ok" && recovered.value.envelopeHash === envelope.envelopeHash && recovered.value.generation === 0) {
              return { status: "published", observedIdentity: ordinaryNamespaceIdentity(recovered.value) };
            }
            if (persisted.status === "refused") publicationFailureCode = persisted.code;
            return persisted.status === "indeterminate"
              ? { status: "indeterminate" as const }
              : { status: "not-published" as const, ...(persisted.status === "refused" ? { failureCode: persisted.code } : {}) };
          }
          const readback = ordinarySnapshots.read(id);
          return readback.status === "ok"
            ? { status: "published", observedIdentity: ordinaryNamespaceIdentity(readback.value) }
            : { status: "indeterminate" };
        },
      });
      if (published.status !== "committed") {
        publicationIndeterminate = published.status === "indeterminate";
        // `prepare` advances the fence.  A classified no-write outcome is
        // the one safe case to terminally abandon it, and must use the
        // returned prepared handle rather than the now-stale reservation.
        // Throw/indeterminate remain durable crash-window evidence for
        // inventory reconciliation and must not be released here or below.
        if (published.status === "not-published") {
          publicationFailureCode ??= ordinaryPublicationFailureCode(published.failureCode);
          publicationPreparedReleased = true;
          try { runtimeNamespace.release({ reservation: published.reservation, reasonCode: "CREATE_PUBLICATION_NOT_PUBLISHED" }); }
          catch { /* preserve prepared evidence if the terminal write itself is uncertain */ }
        }
        throw new Error("ordinary namespace publication did not commit");
      }
    } catch (error) {
      releaseCreationAdmission();
      if (!publicationFailureCode) publicationFailureCode = ordinaryNamespaceFailureCode(error);
      log.error("ordinary-session", "ordinary session generation-zero persistence failed", error);
      // Prepared+indeterminate is durable crash-window evidence.  Retain it
      // for inventory/reconcile; otherwise terminate only our own capability.
      if (!publicationIndeterminate && !publicationPreparedReleased) {
        try { runtimeNamespace.release({ reservation, reasonCode: "CREATE_PUBLICATION_FAILED" }); } catch { /* never erase another owner */ }
      }
      closeStagingSession();
      try { if (existsSync(creationStagingRoot)) rmSync(creationStagingRoot, { recursive: true, force: true }); } catch { /* staging is non-authoritative */ }
      const status = publicationFailureCode === "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED" ? 507
        : publicationFailureCode === "ORDINARY_SNAPSHOT_CONFLICT" || publicationFailureCode === "ORDINARY_SNAPSHOT_NAMESPACE_FENCED" ? 409
          : publicationIndeterminate || publicationFailureCode === "ORDINARY_SNAPSHOT_BUSY" ? 503 : 500;
      return respondJson({
        error: {
          stage: "persistence",
          code: "ORDINARY_SESSION_PERSISTENCE_UNAVAILABLE",
          message: "ordinary session persistence is unavailable",
        },
      }, status, status === 503 ? { "Retry-After": "1" } : {});
    }

    // A live ordinary session is not reachable until its owner binding and
    // summary have committed durably. This prevents an unaddressable orphan if
    // metadata persistence fails.
    closeStagingSession();
    try { if (existsSync(creationStagingRoot)) rmSync(creationStagingRoot, { recursive: true, force: true }); } catch { /* stale staging files are not authority */ }
    const committed = restoreOrdinarySessionEnvelope(createdEnvelope, {
      storage,
      intentPolicy: ordinaryIntentPolicy,
      createSession: (sessionId, committedAccess, runtimeDependencies) => createOrdinaryRecoverySession({
        id: sessionId, access: committedAccess, storage, intentPolicy: ordinaryIntentPolicy,
        sessionIntentClient: ordinarySessionIntentClient,
        runtimeDependencies,
      }),
    });
    if (committed.status !== "ok") {
      releaseCreationAdmission();
      log.error("ordinary-session", "ordinary session committed snapshot could not be rehydrated", committed.message);
      return respondJson({ error: { stage: "persistence", code: "ORDINARY_SESSION_PERSISTENCE_UNAVAILABLE", message: "ordinary session committed but could not be rehydrated" } }, 503, { "Retry-After": "1" });
    }
    registry.set(id, committed.session);
    releaseCreationAdmission();
    const character = committed.session.getCharacterSummary();
    broadcastToSession(id, "session-created", {
      sessionId: id,
      ruleset,
      characterName: characterName ?? "调查员",
    });
    return respondJson({
      sessionId: id,
      sessionKind: "ordinary",
      ordinaryGeneration: 0,
      ruleset,
      archetype: archetypeId ?? null,
      characterName: characterName ?? "调查员",
      character,
      opening,
      openingStatus,
      ...(openingCode ? { openingCode } : {}),
      summary: committed.session.getSummary(),
    }, 201);
    } finally {
      releaseCreationAdmission();
    }
  }

  // GET /api/sessions — 列表
  if (method === "GET" && segments[0] === "api" && segments[1] === "sessions" && segments.length === 2) {
    const listed = await visibleSessionListings(req, compilerAuthenticator, ordinarySessionAccess, storage, registry, ordinarySnapshots, runtimeNamespace, ordinaryIntentPolicy, runtimeDiagnostics, createOrdinaryRecoverySession);
    return listed instanceof Response ? listed : respondJson(listed);
  }

  // 需要 :id 的路由
  if (segments.length >= 3 && segments[0] === "api" && segments[1] === "sessions") {
    const sessionId = segments[2];
    if (isCompiledIntentAdmissionRecoveryRoute) {
      // The operator supplied only a locator. Namespace + snapshot header are
      // the authoritative generation source; this route never constructs or
      // consults a process-local session object before deciding its fence.
      let recoveryNamespace;
      try { recoveryNamespace = isServerGeneratedSessionId(sessionId) ? runtimeNamespace.read(sessionId) : undefined; }
      catch { return respondJson({ code: "compiled_intent_admission_unavailable" }, 503, { "Retry-After": "1" }); }
      if (!recoveryNamespace || recoveryNamespace.state !== "committed" || recoveryNamespace.kind !== "compiled") {
        return opaqueSessionNotFoundResponse();
      }
      const header = compiledSnapshots.readHeader(sessionId);
      const identity = recoveryNamespace.expectedIdentity;
      if (header.status !== "ok" || !identity
        || identity.format !== COMPILED_SESSION_NAMESPACE_IDENTITY_FORMAT
        || identity.hash !== header.value.snapshotHash
        || identity.generation !== header.value.generation) {
        return respondJson({ code: "compiled_intent_admission_unavailable" }, 503, { "Retry-After": "1" });
      }
      const recovered = compiledIntentAdmission.recoverQuarantinedForOperator({ sessionId, currentGeneration: header.value.generation });
      if (recovered.status === "recovered" || recovered.status === "absent") {
        return respondJson({ status: recovered.status, code: "compiled_intent_admission_recovered", generation: header.value.generation });
      }
      return respondJson({
        code: recovered.code === "ORDINARY_ACTION_BUSY" ? "compiled_intent_busy" : "compiled_intent_admission_unavailable",
        generation: header.value.generation,
      }, 503, { "Retry-After": String(recovered.retryAfterSeconds) });
    }
    if (isOrdinaryActionAdmissionRecoveryRoute) {
      let recoveryNamespace;
      try { recoveryNamespace = isServerGeneratedSessionId(sessionId) ? runtimeNamespace.read(sessionId) : undefined; }
      catch { return respondJson({ code: "ordinary_action_admission_unavailable" }, 503, { "Retry-After": "1" }); }
      if (!recoveryNamespace || recoveryNamespace.state !== "committed" || recoveryNamespace.kind !== "ordinary") {
        return opaqueSessionNotFoundResponse();
      }
      const durable = ordinarySnapshots.read(sessionId);
      if (durable.status !== "ok") return respondJson({ code: "ordinary_action_admission_unavailable" }, 503, { "Retry-After": "1" });
      const recovered = ordinaryActionAdmission.recoverOrdinaryForOperator({ sessionId, currentGeneration: durable.value.generation });
      if (recovered.status === "quarantined") {
        // Quarantine is durable crash-window evidence, not a retry promise.
        // A later, separate operator call can acknowledge and remove it.
        return respondJson({
          status: "quarantined",
          code: "ordinary_action_admission_quarantined",
          ordinaryGeneration: durable.value.generation,
        }, 202);
      }
      if (recovered.status === "recovered" || recovered.status === "absent") {
        return respondJson({ status: recovered.status, code: "ordinary_action_admission_recovered" });
      }
      return respondJson({
        code: recovered.code === "ORDINARY_ACTION_BUSY" ? "ordinary_action_busy" : "ordinary_action_admission_unavailable",
        ordinaryGeneration: durable.value.generation,
      }, 503, { "Retry-After": String(recovered.retryAfterSeconds) });
    }
    const isPlayerFacadeRoute = (method === "GET" && segments.length === 4 && segments[3] === "player-view")
      || (method === "POST" && segments.length === 4 && ["player-actions", "player-intents", "player-followups"].includes(segments[3] ?? ""));
    // Host-owner routes authenticate before `sessions.get`: otherwise an
    // anonymous caller can distinguish an existing locator from a miss. The
    // cookie-only player facade/invitation paths intentionally keep their
    // independent credential protocol.
    const hostAuthentication = isPlayerFacadeRoute || isPlayerInvitationClaimRoute
      ? null
      : preauthenticatedHostRuntimeRequest
        ?? await authenticateHostOwnedSessionRuntimeRequest(req, compilerAuthenticator, ordinarySessionAccess);
    if (hostAuthentication?.ordinary instanceof Response) return hostAuthentication.ordinary;
    // Namespace state is the first locator gate.  It prevents unknown,
    // reserved, abandoned, quarantined, and wrong-kind durable evidence from
    // reaching either hydration constructor or a request body side effect.
    let namespaceRecord;
    try { namespaceRecord = isServerGeneratedSessionId(sessionId) ? runtimeNamespace.read(sessionId) : undefined; }
    catch { return opaqueSessionNotFoundResponse(); }
    if (!namespaceRecord || namespaceRecord.state !== "committed") {
      const notFound = opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId));
      return isPlayerFacadeRoute || isPlayerInvitationClaimRoute ? withPlayerNoStore(notFound) : withRecoveryNoStore(notFound);
    }
    // Authentication established only a bounded snapshot claim. Re-read the
    // namespace after its inventory reconciliation and require that exact
    // durable identity before catalog/factory hydration can begin.
    if (isSnapshotPreauthenticatedPlayerRoute && (!preauthenticatedPlayerSnapshotIdentity
      || !namespaceHasCommittedIdentity(
        runtimeNamespace,
        sessionId,
        "compiled",
        compiledNamespaceIdentity({
          snapshotHash: preauthenticatedPlayerSnapshotIdentity.snapshotHash,
          generation: preauthenticatedPlayerSnapshotIdentity.generation,
        }),
      ))) {
      return withPlayerNoStore(opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId)));
    }
    let session = registry.get(sessionId);
    let ordinaryEnvelopeForResponse: OrdinarySessionEnvelope | undefined;
    let recoveredSession: GameSession | undefined;
    let attemptedDurableRecovery = false;
    if ((!session || isPlayerIntentRoute || isPlayerFollowupRoute
      || (session.getCompiledGeneration() !== null
        && !sessionMatchesCommittedCompiledNamespace(session, runtimeNamespace, compiledDurableHostCapability)))
      && namespaceRecord.kind === "compiled") {
      // A durable generation-zero commit can outlive a failed local
      // acknowledgement/registration. Recover with the same full validator as
      // startup before declaring the opaque miss. Host callers are authorized
      // before installation so a foreign principal cannot use a locator to
      // populate or probe the registry.
      attemptedDurableRecovery = true;
      const recovered = hydrateCompiledSession(sessionId, {
        catalog,
        snapshots: compiledSnapshots,
        sessionNamespace: runtimeNamespace,
        compiledDurableHostCapability,
        createSession: (id, _runtimeDependencies) => createCompiledRecoverySession({ id, storage }),
      });
      if (recovered.status === "ok") {
        if (isSnapshotPreauthenticatedPlayerRoute && (!preauthenticatedPlayerSnapshotIdentity
          || !sameCompiledSessionRecoveryIdentity(recovered.identity, preauthenticatedPlayerSnapshotIdentity)
          || !namespaceHasCommittedIdentity(runtimeNamespace, sessionId, "compiled", compiledNamespaceIdentity(recovered.identity)))) {
          recovered.session.close();
          return withPlayerNoStore(opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId)));
        }
        recoveredSession = recovered.session;
        session = recovered.session;
        if (!isPlayerFacadeRoute && !isPlayerInvitationClaimRoute) {
          const authorized = authorizeCompiledSessionRuntimePrincipal(hostAuthentication!.compiled, recovered.session, false, true, compiledDurableHostCapability);
          if (authorized instanceof Response) return withRecoveryNoStore(authorized);
        }
      } else if (isPlayerIntentRoute || isPlayerFollowupRoute) {
        return withPlayerNoStore(opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId)));
      }
    }

    if (!session && namespaceRecord.kind === "ordinary") {
      // Ordinary recovery has an independent envelope/root/domain. A failed
      // compiled lookup is never evidence that an ordinary locator is absent.
      attemptedDurableRecovery = true;
      const durable = ordinarySnapshots.read(sessionId);
      // Authenticate and compare the envelope binding before constructor or
      // restore: foreign locators cannot trigger career writes or registry work.
      if (durable.status === "ok" && hostAuthentication && !(hostAuthentication.ordinary instanceof Response)
        && principalMatchesOrdinarySessionAccess(hostAuthentication.ordinary, durable.value.access)) {
        const recovered = hydrateOrdinarySession(sessionId, { snapshots: ordinarySnapshots, sessionNamespace: runtimeNamespace, storage, intentPolicy: ordinaryIntentPolicy,
          createSession: (id, access, runtimeDependencies) => createOrdinaryRecoverySession({
            id, access, storage, intentPolicy: ordinaryIntentPolicy,
            sessionIntentClient: ordinarySessionIntentClient,
            runtimeDependencies,
          }) });
        if (recovered.status === "ok") {
          const adopted = registry.get(sessionId);
          if (adopted) { recovered.session.close(); session = adopted; }
          else { registry.set(sessionId, recovered.session); session = recovered.session; }
        }
      }
    }

    if (!session) {
      const notFound = opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId));
      return isPlayerFacadeRoute || isPlayerInvitationClaimRoute
        ? withPlayerNoStore(notFound)
        : attemptedDurableRecovery ? withRecoveryNoStore(notFound) : notFound;
    }
    if ((namespaceRecord.kind === "compiled") !== (session.getCompiledGeneration() !== null)) {
      // A stale process-local entry can never overrule the cross-process
      // namespace kind.  Do not close/delete it here: it may be another
      // process's diagnostic object; simply keep this request opaque.
      const notFound = opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId));
      return isPlayerFacadeRoute || isPlayerInvitationClaimRoute ? withPlayerNoStore(notFound) : withRecoveryNoStore(notFound);
    }
    if (session.getCompiledGeneration() !== null
      && !sessionMatchesCommittedCompiledNamespace(session, runtimeNamespace, compiledDurableHostCapability)) {
      // A live registry entry can be a recovered post-store candidate from an
      // indeterminate publication.  Its kind is still compiled, but only the
      // namespace's exact hash/generation/format may authorize its use.
      const notFound = opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId));
      return isPlayerFacadeRoute || isPlayerInvitationClaimRoute ? withPlayerNoStore(notFound) : withRecoveryNoStore(notFound);
    }
    // Do not make a locator hit observable through mutable process state. A
    // recovered candidate becomes live only after the route's credential
    // check succeeds. Invitation claims install only after the claim itself
    // has succeeded, so an invalid invite cannot populate the registry.
    const installRecoveredSession = (): GameSession | undefined => {
      if (!recoveredSession) {
        return session && sessionMatchesCommittedCompiledNamespace(session, runtimeNamespace, compiledDurableHostCapability)
          ? session
          : undefined;
      }
      const candidate = recoveredSession;
      if (!sessionMatchesCommittedCompiledNamespace(candidate, runtimeNamespace, compiledDurableHostCapability)) {
        candidate.close();
        recoveredSession = undefined;
        return undefined;
      }
      const adopted = registry.get(sessionId);
      if (!adopted) {
        // Re-read immediately before publishing the process-local pointer.
        // Hydration may have yielded while another host advanced the namespace.
        if (!sessionMatchesCommittedCompiledNamespace(candidate, runtimeNamespace, compiledDurableHostCapability)) {
          candidate.close();
          recoveredSession = undefined;
          return undefined;
        }
        registry.set(sessionId, candidate);
        compiledSessionDiagnostics.delete(sessionId);
        recoveredSession = undefined;
        return candidate;
      }
      if (!sessionMatchesCommittedCompiledNamespace(adopted, runtimeNamespace, compiledDurableHostCapability)) {
        // The shared namespace has moved past a process-local object.  The
        // candidate was restored only after proving the exact committed
        // snapshot identity, so replace the stale local pointer rather than
        // making a valid durable session look absent.
        if (!sessionMatchesCommittedCompiledNamespace(candidate, runtimeNamespace, compiledDurableHostCapability)) {
          candidate.close();
          recoveredSession = undefined;
          return undefined;
        }
        registry.set(sessionId, candidate);
        adopted.close();
        compiledSessionDiagnostics.delete(sessionId);
        recoveredSession = undefined;
        return candidate;
      }
      if (isSnapshotPreauthenticatedPlayerRoute && preauthenticatedPlayerSnapshotIdentity
        && !sessionMatchesCompiledSessionRecoveryIdentity(adopted, preauthenticatedPlayerSnapshotIdentity, compiledDurableHostCapability)) {
        if (!sessionMatchesCommittedCompiledNamespace(candidate, runtimeNamespace, compiledDurableHostCapability)) {
          candidate.close();
          recoveredSession = undefined;
          return undefined;
        }
        adopted.close();
        registry.set(sessionId, candidate);
        compiledSessionDiagnostics.delete(sessionId);
        recoveredSession = undefined;
        return candidate;
      }
      candidate.close();
      recoveredSession = undefined;
      return adopted;
    };
    if (session.getCompiledGeneration() !== null) {
      let access = readCompiledDurableSessionAccessBinding(session, compiledDurableHostCapability);
      if (isPlayerInvitationClaimRoute) {
        const claim = preauthenticatedPlayerInvitationClaim;
        if (!claim) return withPlayerNoStore(playerInvitationUnavailableResponse());
        // The body and immutable snapshot were already checked before any
        // namespace/catalog/recovery work. Re-read the selected live winner
        // before the sole mutable claim-store operation.
        const adopted = registry.get(sessionId);
        if (adopted && adopted !== session) {
          if (adopted.getCompiledGeneration() === null) return withPlayerNoStore(playerInvitationUnavailableResponse());
          session = adopted;
          access = readCompiledDurableSessionAccessBinding(session, compiledDurableHostCapability);
        }
        const publicOrigin = playerDelivery.publicOrigin;
        if (!sessionMatchesCompiledSessionRecoveryIdentity(session, claim.identity, compiledDurableHostCapability)
          || !access?.playerDelivery || !playerDelivery.available || !publicOrigin || !isSameOriginRequest(req, publicOrigin)
          || !playerDelivery.validatesClaim(sessionId, access.playerDelivery, claim.invite, claim.claimId)) {
          recoveredSession?.close();
          recoveredSession = undefined;
          return withPlayerNoStore(playerInvitationUnavailableResponse());
        }
        const cookie = playerDelivery.claim(sessionId, access.playerDelivery, claim.invite, claim.claimId);
        if (!cookie) return withPlayerNoStore(playerInvitationUnavailableResponse());
        const installed = installRecoveredSession();
        if (!installed) return withPlayerNoStore(opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId)));
        session = installed;
        const headers = new Headers();
        headers.set("Cache-Control", "no-store");
        headers.set("Pragma", "no-cache");
        headers.set("Set-Cookie", playerDelivery.setCookie(cookie));
        return new Response(null, { status: 204, headers });
      }
      if (isSnapshotPreauthenticatedPlayerFacadeRoute) {
        if (!preauthenticatedCompiledPlayerFacadeMatchesAccess(preauthenticatedPlayerFacade!, req, sessionId, access, playerDelivery)) {
          recoveredSession?.close();
          recoveredSession = undefined;
          return withPlayerNoStore(preauthenticatedCompiledPlayerFacadeAccessRefusal(preauthenticatedPlayerFacade!));
        }
      } else if (isPlayerFacadeRoute && access?.playerDelivery) {
        if (!playerDelivery.available) {
          recoveredSession?.close();
          recoveredSession = undefined;
          return withPlayerNoStore(runtimeAuthRefusal("PLAYER_DELIVERY_UNAVAILABLE", "compiled player delivery is unavailable", 503));
        }
        const publicOrigin = playerDelivery.publicOrigin;
        if (!publicOrigin || (method === "POST" && !isSameOriginRequest(req, publicOrigin))
          || !playerDelivery.authenticate(sessionId, access.playerDelivery, req.headers.get("cookie"))) {
          recoveredSession?.close();
          recoveredSession = undefined;
          return withPlayerNoStore(runtimeAuthRefusal("PLAYER_AUTH_REQUIRED", "player authentication is required", 401));
        }
      } else {
        const authorized = isPlayerFacadeRoute
          ? await authorizeCompiledSessionRuntimeRequest(req, session, compilerAuthenticator, true, compiledDurableHostCapability)
          : authorizeCompiledSessionRuntimePrincipal(hostAuthentication!.compiled, session, false, true, compiledDurableHostCapability);
        if (authorized instanceof Response) return isPlayerFacadeRoute ? withPlayerNoStore(authorized) : authorized;
      }
      const installed = installRecoveredSession();
      if (!installed) {
        const notFound = opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId));
        return isPlayerFacadeRoute ? withPlayerNoStore(notFound) : withRecoveryNoStore(notFound);
      }
      if (!sessionMatchesCommittedCompiledNamespace(installed, runtimeNamespace, compiledDurableHostCapability)) {
        const notFound = opaqueSessionNotFoundResponse(runtimeDiagnostics.get(sessionId));
        return isPlayerFacadeRoute ? withPlayerNoStore(notFound) : withRecoveryNoStore(notFound);
      }
      if (installed !== session) {
        // An async compiler-auth request may have yielded to an adopter. Use
        // the registered winner only after re-validating its own immutable
        // access binding, never the stale local candidate's binding.
        const installedAccess = readCompiledDurableSessionAccessBinding(installed, compiledDurableHostCapability);
        if (isSnapshotPreauthenticatedPlayerFacadeRoute) {
          if (!preauthenticatedCompiledPlayerFacadeMatchesAccess(preauthenticatedPlayerFacade!, req, sessionId, installedAccess, playerDelivery)) {
            return withPlayerNoStore(preauthenticatedCompiledPlayerFacadeAccessRefusal(preauthenticatedPlayerFacade!));
          }
        } else if (isPlayerFacadeRoute && installedAccess?.playerDelivery) {
          const publicOrigin = playerDelivery.publicOrigin;
          if (!playerDelivery.available || !publicOrigin || (method === "POST" && !isSameOriginRequest(req, publicOrigin))
            || !playerDelivery.authenticate(sessionId, installedAccess.playerDelivery, req.headers.get("cookie"))) {
            return withPlayerNoStore(runtimeAuthRefusal("PLAYER_AUTH_REQUIRED", "player authentication is required", 401));
          }
        } else {
          const authorized = isPlayerFacadeRoute
            ? await authorizeCompiledSessionRuntimeRequest(req, installed, compilerAuthenticator, true, compiledDurableHostCapability)
            : authorizeCompiledSessionRuntimePrincipal(hostAuthentication!.compiled, installed, false, true, compiledDurableHostCapability);
          if (authorized instanceof Response) return isPlayerFacadeRoute ? withPlayerNoStore(authorized) : authorized;
        }
        session = installed;
      }
    } else {
      // Every ordinary runtime route is checked before a body, model, history,
      // state, lastActiveAt, or any action side effect is observed.
      if (!hostAuthentication) return opaqueSessionNotFoundResponse();
      const authoritative = ensureAuthoritativeOrdinaryLive(sessionId, session, hostAuthentication.ordinary, registry, ordinarySnapshots, runtimeNamespace, storage, ordinaryIntentPolicy, createOrdinaryRecoverySession);
      if (authoritative.status === "unavailable") {
        return withRecoveryNoStore(respondJson({ error: { code: "ordinary_recovery_unavailable" } }, 503, { "Retry-After": "1" }));
      }
      if (authoritative.status !== "ok") return withRecoveryNoStore(opaqueSessionNotFoundResponse());
      session = authoritative.session;
      ordinaryEnvelopeForResponse = authoritative.envelope;
    }
    // `/character` is an exact durable-operation route. A suffix is never a
    // legacy mutation alias, and must be rejected before reading its body.
    if (method === "POST" && segments[3] === "character" && segments.length !== 4) {
      return respondError("not found", 404);
    }
    const isOrdinaryKpMessageRoute = method === "POST" && segments.length === 5
      && segments[3] === "kp" && segments[4] === "send-message";
    const isOrdinaryLegacyKpMutation = method === "POST" && segments.length === 5
      && segments[3] === "kp" && ["set-san", "set-hp", "apply-damage", "set-scene", "set-difficulty"].includes(segments[4] ?? "");
    if (session.getCompiledGeneration() !== null && method !== "GET" && ["kp", "character", "party", "npc-chat", "luck-spend"].includes(segments[3] ?? "")) {
      return respondJson({ code: "compiled_mutation_unsupported", generation: session.getCompiledGeneration() }, 409);
    }
    // Only this exact host announcement has a signed ordinary operation
    // receipt. Legacy KP mutations remain refused without consuming their
    // body; unknown/suffixed KP paths are not aliases and fail as 404 first.
    if (session.getCompiledGeneration() === null && method === "POST" && segments[3] === "kp" && !isOrdinaryKpMessageRoute) {
      if (segments.length === 4 || isOrdinaryLegacyKpMutation) {
        return respondJson({ code: "ordinary_mutation_not_durable" }, 409);
      }
      return respondError("not found", 404);
    }
    if (session.getCompiledGeneration() === null && method !== "GET" && segments[3] === "npc-chat") {
      return respondJson({ code: "ordinary_mutation_not_durable" }, 409);
    }
    // A normal action updates liveness only after its required intent prepare
    // step succeeds inside GameSession.act(). Rejected input must be inert.
    // Ordinary non-action routes are read-only until their own durable commit
    // protocol exists; otherwise lastActiveAt would silently diverge from the envelope.

    // The façade is the sole player-capable compiled REST surface. It uses a
    // separately filtered projection and keeps its three-field write contract
    // outside the legacy runtime/action codecs.
    if (method === "GET" && segments.length === 4 && segments[3] === "player-view") {
      if (session.getCompiledGeneration() === null) return respondError("会话不是编译模组会话", 404);
      try {
        return withPlayerNoStore(respondJson(playerFacadeViewWithFollowupContacts(session, compiledDurableHostCapability, playerDelivery)));
      } catch {
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_VIEW_UNAVAILABLE" } }, 500));
      }
    }

    // Same-generation NPC follow-up: no mechanics, snapshot, turn, or
    // generation mutation. A separate durable fence prevents provider replay
    // without holding the ordinary session-wide action admission lease.
    if (method === "POST" && segments.length === 4 && segments[3] === "player-followups") {
      const generation = session.getCompiledGeneration();
      if (generation === null) return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_UNAVAILABLE" } }, 404));
      const body = await readBoundedPlayerJsonRecord(req);
      if (body.status !== "ok") return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_CONTRACT_REQUIRED" }, generation }, jsonBodyFailureStatus(body)));
      const request = parseCompiledPlayerFollowupRequest(body.value);
      if (!request) return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_CONTRACT_REQUIRED" }, generation }, 400));
      // A concurrent durable action may close or replace this session while
      // the bounded follow-up call is pending. Conflict construction must not
      // reopen that stale object merely to report a generation.
      const conflict = () => withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_CONFLICT" } }, 409));
      if (!playerDelivery.available || request.expectedGeneration !== generation) return conflict();
      let contact: CompiledPlayerFollowupContact | undefined;
      try {
        contact = resolveCompiledDurablePlayerFollowupContacts(session, compiledDurableHostCapability).find((candidate) =>
          candidate.generation === request.expectedGeneration && playerDelivery.validatesCompiledPlayerFollowupContact({
            sessionId: candidate.sessionId, bundleId: candidate.bundleId, expectedGeneration: candidate.generation,
            sceneId: candidate.sceneId, npcId: candidate.npcId, clueIds: candidate.clueIds,
            factsHash: followupFactsHash(candidate), contactToken: request.contactToken,
          }));
      } catch { return conflict(); }
      if (!contact) return conflict();
      const ledger = sessionRuntime.compiledFollowupLedger ?? new CompiledPlayerFollowupLedger(compiledSnapshots.root);
      const admission = sessionRuntime.compiledFollowupAdmission ?? new CompiledPlayerFollowupAdmissionCoordinator(compiledSnapshots.root);
      const existing = ledger.read(session.id, request.actionId);
      if (existing.status === "refused") return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_UNAVAILABLE" }, generation }, 503, { "Retry-After": "1" }));
      let preparedAlreadyStored = false;
      if (existing.status === "ok") {
        const record = existing.value.record;
        if (record.schemaVersion === "1.0.0" ? request.previousActionId !== undefined
          : record.playerInput !== request.playerInput || record.previousActionId !== (request.previousActionId ?? null)) return conflict();
        const originalContext = followupRecordContext(record);
        const originalBinding = followupBinding(contact, request.contactToken, request.actionId, request.playerInput, originalContext);
        const originalPreparedMac = playerDelivery.signCompiledPlayerFollowupPrepared(originalBinding);
        if (!originalPreparedMac || !sameFollowupRecordBase(record, followupRecord(originalBinding, request.playerInput, originalContext, originalPreparedMac))) return conflict();
        if (existing.value.state === "settled" && existing.value.narration && existing.value.receiptMac) {
          // A settled current receipt authenticates its original context hash.
          // Its predecessor need not still exist for a zero-provider replay.
          if (!trustedFollowupReceipt(originalBinding, record, existing.value.narration, existing.value.receiptMac, playerDelivery, admission, true)) return conflict();
          return withPlayerNoStore(respondJson({ status: "replayed", followup: existing.value.narration, view: playerFacadeViewWithFollowupContacts(session, compiledDurableHostCapability, playerDelivery) }));
        }
        if (existing.value.state === "prepared") {
          // Prepared means no admission anchor was ever created. Only this
          // exact raw request can resume it; an anchor of any state is an
          // unknown dispatch boundary and must never be retried.
          const anchored = admission.read(session.id, request.actionId);
          if (anchored.status === "absent") preparedAlreadyStored = true;
          else {
            ledger.quarantine(session.id, request.actionId);
            if (anchored.status === "ok") admission.quarantine(session.id, request.actionId);
            return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_QUARANTINED" }, generation }, 503, { "Retry-After": "1" }));
          }
        } else {
          // `dispatching` can represent an external call whose result was lost;
          // do not retry it. An independent admission row is the trusted anchor
          // even if this receipt ledger has been replaced or rolled back.
          ledger.quarantine(session.id, request.actionId);
          admission.quarantine(session.id, request.actionId);
          return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_QUARANTINED" }, generation }, 503, { "Retry-After": "1" }));
        }
      }
      // A settled exact receipt above remains replayable, but a terminal
      // session must never begin or resume a new same-generation follow-up.
      // Read the canonical façade state only after the receipt branch so a
      // terminal cannot turn an already committed answer into a re-dispatch.
      try {
        if (session.getCompiledPlayerFacadeView().terminal) return conflict();
      } catch { return conflict(); }
      let previousTurn: CompiledPlayerFollowupPreviousTurn | undefined;
      if (request.previousActionId) {
        // The client supplies only an untrusted locator. Restore at most one
        // settled exchange, then recompute its request and scope from the live
        // contact before trusting any prose or hash in the ledger.
        const previous = ledger.read(session.id, request.previousActionId);
        if (previous.status !== "ok" || previous.value.state !== "settled" || previous.value.record.schemaVersion !== "2.0.0"
          || !previous.value.narration || !previous.value.receiptMac) return conflict();
        const previousRecord = previous.value.record;
        const previousBinding = followupBinding(contact, request.contactToken, previousRecord.actionId, previousRecord.playerInput, followupRecordContext(previousRecord));
        if (!trustedFollowupReceipt(previousBinding, previousRecord, previous.value.narration, previous.value.receiptMac, playerDelivery, admission, false)) return conflict();
        previousTurn = { playerQuestion: previousRecord.playerInput, contactReply: previous.value.narration.text };
      }
      const context: FollowupRequestContext = existing.status === "ok" && existing.value.record.schemaVersion === "1.0.0"
        ? { schemaVersion: "1.0.0" }
        : { schemaVersion: "2.0.0", previousActionId: request.previousActionId ?? null, contextHash: followupContextHash(request.previousActionId ?? null, previousTurn) };
      const binding = followupBinding(contact, request.contactToken, request.actionId, request.playerInput, context);
      const preparedMac = playerDelivery.signCompiledPlayerFollowupPrepared(binding);
      if (!preparedMac || !playerDelivery.verifyCompiledPlayerFollowupPrepared(binding, preparedMac)) return conflict();
      const prepared = followupRecord(binding, request.playerInput, context, preparedMac);
      if (preparedAlreadyStored && existing.status === "ok" && !sameFollowupRecordBase(existing.value.record, prepared)) return conflict();
      if (!preparedAlreadyStored) {
        const saved = ledger.savePrepared(prepared);
        if (saved.status !== "ok" || !sameFollowupRecord(saved.value.record, prepared) || saved.value.state !== "prepared") return conflict();
      }
      const llm = configuredCompiledNarrationLlm(sessionRuntime.compiledFollowupOptions ?? {});
      if (!llm || req.signal.aborted) return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_UNAVAILABLE" }, generation }, 503, { "Retry-After": "1" }));
      const dispatchMac = playerDelivery.signCompiledPlayerFollowupDispatch(binding, preparedMac);
      if (!dispatchMac || !playerDelivery.verifyCompiledPlayerFollowupDispatch(binding, preparedMac, dispatchMac)) return conflict();
      const dispatch: CompiledPlayerFollowupRecord = { ...prepared, dispatchMac };
      const acquired = admission.begin({ sessionId: session.id, actionId: request.actionId, expectedGeneration: generation, requestHash: binding.playerRequestHash, dispatchMac });
      if (acquired !== "acquired") {
        ledger.quarantine(session.id, request.actionId);
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_QUARANTINED" }, generation }, 503, { "Retry-After": "1" }));
      }
      const dispatching = ledger.markDispatching(dispatch);
      if (dispatching.status !== "ok" || dispatching.value.state !== "dispatching" || !sameFollowupRecord(dispatching.value.record, dispatch)) {
        admission.quarantine(session.id, request.actionId);
        ledger.quarantine(session.id, request.actionId);
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_QUARANTINED" }, generation }, 503, { "Retry-After": "1" }));
      }
      const narrated = await narrateCompiledPlayerFollowup({ contactName: contact.name, releasedFacts: contact.facts, playerInput: request.playerInput, previousTurn, llm, signal: req.signal });
      if (narrated.status !== "accepted") {
        ledger.quarantine(session.id, request.actionId);
        admission.quarantine(session.id, request.actionId);
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_UNAVAILABLE" }, generation }, 503, { "Retry-After": "1" }));
      }
      // The model cannot mutate state, but another action may have replaced
      // the live durable snapshot while it was running. Never present an old
      // scene/contact answer as current; keep the dispatch tombstone fenced.
      const current = registry.get(session.id);
      const persisted = compiledSnapshots.read(session.id);
      let stillCurrent = current === session && current.getCompiledGeneration() === generation;
      if (stillCurrent) {
        try {
          const identity = readCompiledDurableSessionIdentity(session, compiledDurableHostCapability);
          const snapshot = persisted.status === "ok" ? validateCompiledSessionSnapshot(persisted.value) : undefined;
          stillCurrent = !!snapshot && snapshot.status === "ok" && !!identity
            && identity.generation === generation
            && snapshot.value.snapshotHash === identity.snapshotHash
            && snapshot.value.generation === identity.generation
            && resolveCompiledDurablePlayerFollowupContacts(session, compiledDurableHostCapability).some((candidate) =>
              candidate.npcId === contact.npcId && JSON.stringify(candidate.clueIds) === JSON.stringify(contact.clueIds)
              && candidate.generation === generation
              && playerDelivery.validatesCompiledPlayerFollowupContact({
                sessionId: candidate.sessionId, bundleId: candidate.bundleId, expectedGeneration: candidate.generation,
                sceneId: candidate.sceneId, npcId: candidate.npcId, clueIds: candidate.clueIds,
                factsHash: followupFactsHash(candidate), contactToken: request.contactToken,
              }));
        } catch { stillCurrent = false; }
      }
      if (!stillCurrent) {
        ledger.quarantine(session.id, request.actionId);
        admission.quarantine(session.id, request.actionId);
        return conflict();
      }
      const textHash = sha256Hex(narrated.narration.text);
      const receiptMac = playerDelivery.signCompiledPlayerFollowupReceipt(binding, dispatchMac, textHash);
      if (!receiptMac || !playerDelivery.verifyCompiledPlayerFollowupReceipt(binding, dispatchMac, textHash, receiptMac)) {
        ledger.quarantine(session.id, request.actionId); admission.quarantine(session.id, request.actionId); return conflict();
      }
      const settled = ledger.settle(dispatch, narrated.narration, receiptMac);
      if (settled.status !== "ok" || settled.value.state !== "settled") return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_UNAVAILABLE" }, generation }, 503, { "Retry-After": "1" }));
      const anchored = admission.settle({ sessionId: session.id, actionId: request.actionId, expectedGeneration: generation, requestHash: binding.playerRequestHash, dispatchMac, receiptHash: textHash, receiptMac });
      if (anchored !== "settled" && anchored !== "existing") return withPlayerNoStore(respondJson({ error: { code: "PLAYER_FOLLOWUP_UNAVAILABLE" }, generation }, 503, { "Retry-After": "1" }));
      return withPlayerNoStore(respondJson({ status: "delivered", followup: narrated.narration, view: playerFacadeViewWithFollowupContacts(session, compiledDurableHostCapability, playerDelivery) }));
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "player-actions") {
      if (session.getCompiledGeneration() === null) return respondError("会话不是编译模组会话", 404);
      const body = await readBoundedPlayerJsonRecord(req);
      if (body.status !== "ok") return withPlayerNoStore(respondJson({ error: { code: "PLAYER_ACTION_CONTRACT_REQUIRED" }, generation: session.getCompiledGeneration() }, jsonBodyFailureStatus(body)));
      const request = body.status === "ok" ? parseCompiledPlayerFacadeActionRequest(body.value) : null;
      if (!request) return withPlayerNoStore(respondJson({ error: { code: "PLAYER_ACTION_CONTRACT_REQUIRED" }, generation: session.getCompiledGeneration() }, 400));
      const narrationLlm = configuredCompiledNarrationLlm(sessionRuntime.compiledNarrationOptions ?? {});
      const narrationLedger = sessionRuntime.compiledNarrationLedger ?? new CompiledNarrationLedger(compiledSnapshots.root);
      const narrationAdmission = sessionRuntime.compiledNarrationAdmission ?? new CompiledNarrationAdmissionCoordinator(compiledSnapshots.root);
      const conflict = () => withPlayerNoStore(respondJson({ error: { code: "PLAYER_ACTION_CONFLICT" }, generation: session.getCompiledGeneration() }, 409));
      let input: string | null = null;
      let playerRequestHash: string;
      let playerTopic: CompiledPlayerNarrationTopicRequest | undefined;
      // A committed provider turn is an exact receipt, not a fresh choice.
      // The previous opaque choice is intentionally generation-bound and no
      // longer resolvable at g+1, so consult only the private candidate ledger
      // for the exact action-id retry before attempting normal choice lookup.
      const priorNarration = narrationLedger.read(session.id, request.actionId);
      const completedPrior = priorNarration.status === "ok"
        && (priorNarration.value.state === "receipt" || priorNarration.value.state === "committed");
      if (request.schema === "v1") {
        playerRequestHash = compiledPlayerNarrationPublicRequestHash(request.choiceId, request.actionId, request.expectedGeneration);
        if (completedPrior && priorNarration.value.candidate.expectedGeneration === request.expectedGeneration) {
          if (priorNarration.value.candidate.playerRequestHash !== playerRequestHash) return conflict();
          input = priorNarration.value.candidate.snapshot.idempotency.at(-1)?.input ?? null;
        } else {
          try {
            input = resolveCompiledDurablePlayerChoice(session, compiledDurableHostCapability, request.choiceId, request.expectedGeneration);
          } catch {
            return withPlayerNoStore(respondJson({ error: { code: "PLAYER_ACTION_UNAVAILABLE" }, generation: session.getCompiledGeneration() }, 409));
          }
        }
      } else if (request.schema === "v2_token") {
        // A token-only v2 request can consume only an already durable receipt.
        // In particular it must not revive a prepared/dispatching candidate or
        // recompute old catalog authority after the successor is live.
        if (!completedPrior) return conflict();
        // A receipt that exists before its successor snapshot commits has no
        // trusted live idempotency anchor. Require an explicit raw-prose
        // re-entry there; token-only retry is intentionally not a recovery
        // path for that same-generation crash window.
        if (session.getCompiledGeneration() === request.expectedGeneration) return conflict();
        const candidate = priorNarration.value.candidate;
        const record = candidate.snapshot.idempotency.at(-1);
        if (candidate.schemaVersion !== "2.0.0"
          || candidate.actionId !== request.actionId
          || candidate.expectedGeneration !== request.expectedGeneration
          || candidate.nextGeneration !== request.expectedGeneration + 1
          || !record || record.actionId !== request.actionId || record.expectedGeneration !== request.expectedGeneration) return conflict();
        if (!priorNarration.value.narration || !validateCompiledDurableNarrationReceipt(
          session,
          compiledDurableHostCapability,
          candidate,
          priorNarration.value.narration,
        )) return conflict();
        const topicTokenHash = compiledPlayerNarrationTopicTokenHash(request.topicBound);
        const basePublicRequestHash = compiledPlayerNarrationPublicRequestHash(request.choiceId, request.actionId, request.expectedGeneration);
        const expectedPlayerRequestHash = compiledPlayerNarrationV2RequestHash(basePublicRequestHash, topicTokenHash, candidate.topicBindingHash);
        if (!sameOpaquePlayerHash(candidate.topicTokenHash, topicTokenHash)
          || !sameOpaquePlayerHash(candidate.playerRequestHash, expectedPlayerRequestHash)) return conflict();
        playerRequestHash = expectedPlayerRequestHash;
        input = record.input;
      } else {
        playerTopic = {
          choiceId: request.choiceId,
          topicBound: request.topicBound,
          playerInput: request.playerInput,
        };
        if (completedPrior) {
          const candidate = priorNarration.value.candidate;
          const record = candidate.snapshot.idempotency.at(-1);
          // Once a successor is live, candidate JSON is merely an untrusted
          // ledger row. Establish its current-snapshot anchor before using it
          // to derive a raw-prose HMAC or read its action input.
          if (session.getCompiledGeneration() !== request.expectedGeneration
            && (!priorNarration.value.narration || !validateCompiledDurableNarrationReceipt(
              session,
              compiledDurableHostCapability,
              candidate,
              priorNarration.value.narration,
            ))) return conflict();
          const binding = matchCompiledDurableNarrationTopic(
            session,
            compiledDurableHostCapability,
            candidate,
            playerTopic,
          );
          if (!binding || candidate.actionId !== request.actionId
            || candidate.expectedGeneration !== request.expectedGeneration
            || candidate.nextGeneration !== request.expectedGeneration + 1
            || !record || record.actionId !== request.actionId || record.expectedGeneration !== request.expectedGeneration) return conflict();
          playerRequestHash = binding.playerRequestHash;
          input = record.input;
        } else {
          // A fresh v2 request must prove that this exact raw question was
          // classified into this exact opaque choice.  Replay read validates
          // the stored result MAC; neither a topic token nor raw prose can
          // substitute for the mechanical selection.
          let catalogActions: CompiledAvailableAction[];
          let identity: ReturnType<typeof deriveCompiledIntentReplayIdentity>;
          try {
            catalogActions = session.getCompiledAvailableActions();
            identity = deriveCompiledIntentReplayIdentity(
              session,
              compiledDurableHostCapability,
              request.playerInput,
              request.expectedGeneration,
              catalogActions,
            );
          } catch {
            return conflict();
          }
          if (!sameOpaquePlayerHash(identity.requestKey, request.topicBound)) return conflict();
          const replay = compiledIntentReplayForRoute().read(identity);
          if (replay.status !== "hit") return conflict();
          const resolution = replayResolution(replay.value, identity);
          const mechanismIds = resolution?.status === "selected"
            ? [resolution.mechanismId]
            : resolution?.status === "ambiguous" ? resolution.mechanismIds : [];
          if (mechanismIds.length === 0) return conflict();
          try {
            input = resolveCompiledDurablePlayerChoice(session, compiledDurableHostCapability, request.choiceId, request.expectedGeneration);
          } catch {
            return conflict();
          }
          if (!input || !mechanismIds.some((mechanismId) => compiledMechanicsAction(mechanismId) === input)) return conflict();
          const binding = bindCompiledDurableNarrationTopic(
            session,
            compiledDurableHostCapability,
            input,
            request.actionId,
            request.expectedGeneration,
            playerTopic,
          );
          if (!binding) return conflict();
          playerRequestHash = binding.playerRequestHash;
        }
      }
      if (!input) return withPlayerNoStore(respondJson({ error: { code: "PLAYER_ACTION_UNAVAILABLE" }, generation: session.getCompiledGeneration() }, 409));
      const narration = request.schema !== "v1" || narrationLlm || completedPrior
        ? {
          llm: narrationLlm ?? undefined,
          signal: req.signal,
          playerRequestHash,
          ...(playerTopic ? { playerTopic } : {}),
          admission: narrationAdmission,
          ledger: narrationLedger,
        }
        : undefined;
      const result = await runCompiledActionTransaction(session, {
        input,
        pcId: "p1",
        actionId: request.actionId,
        expectedGeneration: request.expectedGeneration,
      }, { catalog, snapshots: compiledSnapshots, sessionRegistry: registry, diagnostics: compiledSessionDiagnostics, storage, compiledDurableHostCapability, createRecoverySession: createCompiledRecoverySession, sessionNamespace: runtimeNamespace, namespacePublicationGate: runtimeNamespaceGate, ...(narration ? { narration } : {}) });
      if (result.status !== 200) {
        const code = result.status === 409 ? "PLAYER_ACTION_CONFLICT" : result.status === 400 ? "PLAYER_ACTION_REJECTED" : "PLAYER_ACTION_UNAVAILABLE";
        return withPlayerNoStore(respondJson({ error: { code }, generation: result.body.generation }, result.status, result.headers));
      }
      const liveSession = result.session ?? session;
      try {
        return withPlayerNoStore(respondJson({
          result: { status: liveSession === session ? "duplicate" : "committed" },
          view: playerFacadeViewWithFollowupContacts(liveSession, compiledDurableHostCapability, playerDelivery),
        }));
      } catch {
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_VIEW_UNAVAILABLE" } }, 500));
      }
    }

    // Natural-language intent remains strictly classification-only. The chosen
    // opaque façade action is submitted separately through player-actions.
    if (method === "POST" && segments.length === 4 && segments[3] === "player-intents") {
      // Cookie/session authentication above may need the durable locator.
      // Once it succeeds, reject before consuming player prose.
      if (!compiledIntentAdmissionDomainMatches || !compiledIntentReplayDomainMatches()) {
        return withPlayerNoStore(compiledIntentAdmissionDomainMismatchResponse());
      }
      const generation = session.getCompiledGeneration();
      if (generation === null) return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_UNAVAILABLE" } }, 404));
      const body = await readBoundedPlayerJsonRecord(req);
      if (body.status !== "ok") return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_CONTRACT_REQUIRED" }, generation }, jsonBodyFailureStatus(body)));
      const request = body.status === "ok" ? parseCompiledPlayerFacadeIntentRequest(body.value) : null;
      if (!request) return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_CONTRACT_REQUIRED" }, generation }, 400));
      if (request.expectedGeneration !== generation) {
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_CONFLICT" }, generation }, 409));
      }

      let catalogActions: CompiledAvailableAction[];
      try {
        catalogActions = session.getCompiledAvailableActions();
      } catch {
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_UNAVAILABLE" }, generation }, 409));
      }
      const validation = validateCompiledActionIntentRequest({
        input: request.input,
        expectedGeneration: request.expectedGeneration,
        catalog: catalogActions,
      });
      if (validation !== "ok") {
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_UNAVAILABLE" }, generation }, 409));
      }
      const llm = configuredCompiledIntentLlm(compiledIntentOptions);
      if (!llm) return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_MODEL_UNAVAILABLE" }, generation }, 503));
      if (req.signal.aborted) return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_MODEL_UNAVAILABLE" }, generation }, 503));
      const outcome = await resolveCompiledIntentWithReplay({
        sessionId, source: session, expectedGeneration: request.expectedGeneration, playerInput: request.input,
        catalog: catalogActions, llm, signal: req.signal, registry, namespace: runtimeNamespace,
        snapshots: compiledSnapshots, durableHostCapability: compiledDurableHostCapability,
        admission: compiledIntentAdmission, replay: compiledIntentReplayForRoute(),
      });
      if (outcome.status === "admission_refused") {
        const refused = compiledIntentAdmissionRefusal(outcome.admission, outcome.generation, true);
        return withPlayerNoStore(respondJson(refused.body, refused.status, refused.headers));
      }
      if (outcome.status === "conflict") return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_CONFLICT" }, generation: outcome.generation }, 409));
      if (outcome.status === "unavailable") return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_MODEL_UNAVAILABLE" }, generation: outcome.generation }, 503, { "Retry-After": "1" }));
      if (outcome.status === "invalid") return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_INVALID_RESPONSE" }, generation: outcome.generation }, 422));
      const { resolution, session: current, generation: currentGeneration } = outcome;
      if (resolution.status === "no_match") return withPlayerNoStore(respondJson({ status: "no_match", generation: currentGeneration }));
      const mechanismIds = resolution.status === "selected" ? [resolution.mechanismId] : resolution.mechanismIds;
      let actions: Array<ReturnType<GameSession["getCurrentCompiledPlayerFacadeActionForMechanism"]>>;
      let topicBound: string;
      try {
        actions = mechanismIds.map((mechanismId) => current.getCurrentCompiledPlayerFacadeActionForMechanism(mechanismId, request.expectedGeneration));
        // This opaque replay request key binds the raw question to this exact
        // current session/bundle/generation/catalog. It is the only v2 topic
        // proof returned to the browser; no replay identity or mechanism ID
        // crosses the player facade.
        topicBound = deriveCompiledIntentReplayIdentity(
          current,
          compiledDurableHostCapability,
          request.input,
          request.expectedGeneration,
          current.getCompiledAvailableActions(),
        ).requestKey;
      } catch {
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_UNAVAILABLE" }, generation: currentGeneration }, 409));
      }
      if (actions.some((action) => action === null)) {
        return withPlayerNoStore(respondJson({ error: { code: "PLAYER_INTENT_CONFLICT" }, generation: currentGeneration }, 409));
      }
      if (resolution.status === "selected") return withPlayerNoStore(respondJson({ status: "selected", action: actions[0], topicBound, generation: currentGeneration }));
      return withPlayerNoStore(respondJson({ status: "ambiguous", actions, topicBound, generation: currentGeneration }));
    }

    // GET /api/sessions/:id
    if (method === "GET" && segments.length === 3) {
      return respondJson({
        summary: session.getSummary(),
        state: session.getState(),
        sanity: session.getSanity(),
        history: session.getHistory().messages.slice(-10),
        ...(session.getCompiledGeneration() !== null
          ? { generation: session.getCompiledGeneration() }
          : { sessionKind: "ordinary", ordinaryGeneration: ordinaryEnvelopeForResponse!.generation, dead: session.dead, terminal: session.getOrdinaryTerminal() }),
      });
    }

    // GET /api/sessions/:id/history
    // ?pcId= 按指定 PC 读取——每个 PC 只看得到发给自己的消息（含
    // discoverer_only 的线索揭示，只有发现者自己看得到）。不传 pcId 时
    // 行为不变（取当前活动玩家的历史，兼容既有客户端）。
    if (method === "GET" && segments[3] === "history") {
      const limit = parseInt(query.get("limit") || "50");
      const pcId = query.get("pcId");
      if (pcId) {
        // 未知 pcId 要明确报错，不能悄悄返回空数组——那和"这个人确实没有
        // 历史"从外部长得一模一样，是本仓反复吃亏的"静默失效"。
        if (!session.session.get(pcId)) return respondError(`未知 pcId: ${pcId}`, 404);
        const history = session.getPlayerHistory(pcId);
        return respondJson({
          messages: history.messages.slice(-limit),
          total: history.total,
        });
      }
      const history = session.getHistory();
      return respondJson({
        messages: history.messages.slice(-limit),
        total: history.total,
      });
    }

    // GET /api/sessions/:id/state
    if (method === "GET" && segments[3] === "state") {
      return respondJson({
        state: session.getState(),
        sanity: session.getSanity(),
        summary: session.getSummary(),
        ...(session.getCompiledGeneration() !== null
          ? { generation: session.getCompiledGeneration() }
          : { sessionKind: "ordinary", ordinaryGeneration: ordinaryEnvelopeForResponse!.generation, dead: session.dead, terminal: session.getOrdinaryTerminal() }),
      });
    }

    // GET /api/sessions/:id/suggestions — 当前可选行动
    if (method === "GET" && segments[3] === "suggestions") {
      const result = runSuggestions(session, query.get("pcId"));
      return respondJson(result.body, result.status);
    }

    // GET /api/sessions/:id/compiled/actions?pcId=p1 — structured executable mechanisms
    if (method === "GET" && segments[3] === "compiled" && segments[4] === "actions" && segments.length === 5) {
      const pcId = query.get("pcId");
      if (!pcId?.trim()) return respondJson({ code: "compiled_single_pc_required", generation: session.getCompiledGeneration() }, 400);
      if (!session.session.get(pcId)) return respondJson({ code: "unknown_pc", targetId: pcId, generation: session.getCompiledGeneration() }, 404);
      if (pcId !== "p1") return respondJson({ code: "compiled_single_pc_required", generation: session.getCompiledGeneration() }, 409);
      if (session.getCompiledGeneration() === null) return respondError("会话不是编译模组会话", 404);
      try {
        return respondJson({
          generation: session.getCompiledGeneration(),
          actions: session.getCompiledAvailableActions(),
          compiled: session.getCompiledMechanicsState(),
        });
      } catch {
        return respondJson({ code: "compiled_action_discovery_failed", generation: session.getCompiledGeneration() }, 500);
      }
    }

    // POST /api/sessions/:id/compiled/intents classifies a player request only.
    // It never executes or persists the selected action; that remains the
    // durable /compiled/actions transaction's responsibility.
    if (method === "POST" && segments[3] === "compiled" && segments[4] === "intents" && segments.length === 5) {
      // Host authentication and ownership are resolved above; do not consume
      // the classification body when its coordinator is in another domain.
      if (!compiledIntentAdmissionDomainMatches || !compiledIntentReplayDomainMatches()) {
        return compiledIntentAdmissionDomainMismatchResponse();
      }
      const boundedBody = await readJsonRecord(req, PLAYER_JSON_MAX_BYTES);
      if (boundedBody.status !== "ok") {
        return respondJson({ code: "compiled_intent_contract_required", generation: session.getCompiledGeneration() }, jsonBodyFailureStatus(boundedBody));
      }
      const request = boundedBody.status === "ok" ? parseCompiledIntentRequest(boundedBody.value) : null;
      const generation = session.getCompiledGeneration();
      if (!request) return respondJson({ code: "compiled_intent_contract_required", generation }, 400);
      if (generation === null) return respondError("会话不是编译模组会话", 404);
      if (!session.session.get(request.pcId)) return respondJson({ code: "unknown_pc", targetId: request.pcId, generation }, 404);
      if (request.pcId !== "p1") return respondJson({ code: "compiled_single_pc_required", generation }, 409);
      if (request.expectedGeneration !== generation) return respondJson({ code: "compiled_generation_conflict", generation }, 409);

      let catalogActions: CompiledAvailableAction[];
      try {
        catalogActions = session.getCompiledAvailableActions();
      } catch {
        return respondJson({ code: "compiled_action_discovery_failed", generation }, 500);
      }
      const validation = validateCompiledActionIntentRequest({
        input: request.input,
        expectedGeneration: request.expectedGeneration,
        catalog: catalogActions,
      });
      if (validation === "input_invalid") return respondJson({ code: "compiled_intent_contract_required", generation }, 400);
      // Empty terminal catalogs and catalogs outside the prompt limit are both
      // non-executable states. Do not ask the model to make something up.
      if (validation === "catalog_invalid") return respondJson({ code: "compiled_action_unavailable", generation }, 409);

      const llm = configuredCompiledIntentLlm(compiledIntentOptions);
      if (!llm) return respondJson({ code: "compiled_intent_model_unavailable", generation }, 503);
      if (req.signal.aborted) return respondJson({ code: "compiled_intent_model_unavailable", generation }, 503);
      const outcome = await resolveCompiledIntentWithReplay({
        sessionId, source: session, expectedGeneration: request.expectedGeneration, playerInput: request.input,
        catalog: catalogActions, llm, signal: req.signal, registry, namespace: runtimeNamespace,
        snapshots: compiledSnapshots, durableHostCapability: compiledDurableHostCapability,
        admission: compiledIntentAdmission, replay: compiledIntentReplayForRoute(),
      });
      if (outcome.status === "admission_refused") {
        const refused = compiledIntentAdmissionRefusal(outcome.admission, outcome.generation, false);
        return respondJson(refused.body, refused.status, refused.headers);
      }
      if (outcome.status === "conflict") return respondJson({ code: "compiled_generation_conflict", generation: outcome.generation }, 409);
      if (outcome.status === "unavailable") return respondJson({ code: "compiled_intent_model_unavailable", generation: outcome.generation }, 503, { "Retry-After": "1" });
      if (outcome.status === "invalid") return respondJson({ code: "compiled_intent_invalid_response", generation: outcome.generation }, 422);
      const { resolution, session: current, generation: currentGeneration } = outcome;
      if (resolution.status === "ambiguous") return respondJson({ status: "ambiguous", mechanismIds: resolution.mechanismIds, generation: currentGeneration });
      if (resolution.status === "no_match") return respondJson({ status: "no_match", generation: currentGeneration });
      const action = current.getCompiledAvailableActions().find((candidate) => candidate.mechanismId === resolution.mechanismId);
      if (!action) return respondJson({ code: "compiled_action_unavailable", generation: currentGeneration }, 409);
      return respondJson({ status: "selected", mechanismId: resolution.mechanismId, action, generation: currentGeneration });
    }

    // GET /api/sessions/:id/character — 角色属性
    if (method === "GET" && segments.length === 4 && segments[3] === "character") {
      // Compiled callers retain the historical minimal read shape. The
      // ordinary editor payload is envelope-scoped and must never be inferred
      // from a compiled in-memory character observation.
      if (!ordinaryEnvelopeForResponse) {
        return respondJson({
          character: session.getCharacterSummary(),
          sanity: session.getSanity(),
        });
      }
      try {
        // The sealed GameSession projection reads its private active cohort
        // and world player_state directly. It is intentionally not composed
        // from shadowable public getters or a broad snapshot export.
        return respondJson({
          sessionKind: "ordinary",
          ordinaryGeneration: ordinaryEnvelopeForResponse.generation,
          ...session.getOrdinaryCharacterEditorProjection(),
        });
      } catch {
        // The caller has already been authenticated against this envelope;
        // keep an internal cohort/projection fault retryable without leaking
        // a partial character or treating this GET as a durable mutation.
        return respondJson({ code: "ordinary_character_projection_unavailable" }, 503, { "Retry-After": "1" });
      }
    }

    // ── KP 面板路由 ──

    // GET /api/sessions/:id/kp — KP 完整状态
    if (method === "GET" && segments[3] === "kp" && segments.length === 4) {
      return respondJson({ kp: session.getKPState() });
    }

    // POST /api/sessions/:id/kp/:action — KP 操作
    // The only durable ordinary KP mutation. It uses the same candidate →
    // archive → namespace CAS → hydrate/install transaction as the other
    // signed ordinary operations; legacy KP routes remain blocked above.
    if (isOrdinaryKpMessageRoute) {
      const parsedBody = await readBoundedPlayerJsonRecord(req);
      if (parsedBody.status !== "ok") return respondJson({ code: "ordinary_kp_message_contract_required" }, jsonBodyFailureStatus(parsedBody));
      const request = parseOrdinaryKpMessageRequest(parsedBody.value);
      if (!request) return respondJson({ code: "ordinary_kp_message_contract_required" }, 400);
      const durable = await runOrdinaryKpMessageTransaction(session, request, {
        snapshots: ordinarySnapshots, sessionRegistry: registry, storage, intentPolicy: ordinaryIntentPolicy,
        sessionIntentClient: ordinarySessionIntentClient,
        ordinaryDurableHostCapability: serverOrdinaryDurableHostCapability,
        sessionNamespace: runtimeNamespace, namespacePublicationGate: runtimeNamespaceGate,
        actionAdmission: ordinaryActionAdmission,
        createPristineSession: createOrdinaryRecoverySession,
      });
      return respondJson(durable.body, durable.status, durable.headers);
    }

    // POST /api/sessions/:id/character — 更新角色属性
    if (method === "POST" && segments.length === 4 && segments[3] === "character") {
      const parsedBody = await readBoundedPlayerJsonRecord(req);
      if (parsedBody.status !== "ok") return respondJson({ code: "ordinary_character_contract_required" }, jsonBodyFailureStatus(parsedBody));
      const durableRequest = parseOrdinaryCharacterPatchRequest(parsedBody.value);
      if (!durableRequest) return respondJson({ code: "ordinary_character_contract_required" }, 400);
      const durable = await runOrdinaryCharacterPatchTransaction(session, durableRequest, {
        snapshots: ordinarySnapshots, sessionRegistry: registry, storage, intentPolicy: ordinaryIntentPolicy,
        sessionIntentClient: ordinarySessionIntentClient,
        ordinaryDurableHostCapability: serverOrdinaryDurableHostCapability,
        sessionNamespace: runtimeNamespace, namespacePublicationGate: runtimeNamespaceGate,
        actionAdmission: ordinaryActionAdmission,
        createPristineSession: createOrdinaryRecoverySession,
      });
      return respondJson(durable.body, durable.status, durable.headers);
    }

    // POST /api/sessions/:id/action — 核心：玩家输入
    if (method === "POST" && segments[3] === "action") {
      const parsedBody = await readJsonRecord(req, PLAYER_JSON_MAX_BYTES);
      if (parsedBody.status !== "ok") {
        return respondJson(
          { code: parsedBody.status === "too_large" ? "action_request_too_large" : "action_request_invalid" },
          jsonBodyFailureStatus(parsedBody),
        );
      }
      const body = parsedBody.value;
      // 广播前先拍一次"现在连着的每个玩家历史有多长"——act() 会把这
      // 回合的消息按可见性 push 进各自的 messageHistory，之后用这份
      // 快照切出"这一回合新增了什么"（见 broadcastActionResult）。
      // 必须在 runAction 之前拍，等它跑完历史已经变长，就切不出新增段了。
      if (session.getCompiledGeneration() !== null) {
        const priorCounts = new Map<string, number>();
        for (const pid of listSessionPlayerIds(sessionId)) {
          if (session.session.get(pid)) priorCounts.set(pid, session.getPlayerHistory(pid).total);
        }
      const result = await runCompiledActionTransaction(session, body, { catalog, snapshots: compiledSnapshots, sessionRegistry: registry, diagnostics: compiledSessionDiagnostics, storage, compiledDurableHostCapability, createRecoverySession: createCompiledRecoverySession, sessionNamespace: runtimeNamespace, namespacePublicationGate: runtimeNamespaceGate });
        if (result.status !== 200) return respondJson(result.body, result.status, result.headers);
        const ar = result.body as unknown as ActionResponse;
        const liveSession = result.session ?? session;
        broadcastActionResult(sessionId, liveSession, priorCounts, ar);
        return respondJson(result.body);
      }

      const priorCounts = new Map<string, number>();
      for (const pid of listSessionPlayerIds(sessionId)) {
        if (session.session.get(pid)) priorCounts.set(pid, session.getPlayerHistory(pid).total);
      }
      const result = await runOrdinaryActionTransaction(session, body, {
        snapshots: ordinarySnapshots, sessionRegistry: registry, storage, intentPolicy: ordinaryIntentPolicy,
        sessionIntentClient: ordinarySessionIntentClient,
        ordinaryDurableHostCapability: serverOrdinaryDurableHostCapability,
        sessionNamespace: runtimeNamespace, namespacePublicationGate: runtimeNamespaceGate,
        actionAdmission: ordinaryActionAdmission,
        createPristineSession: createOrdinaryRecoverySession,
      });
      if (result.status !== 200) return respondJson(result.body, result.status, result.headers);
      const ar = result.body as unknown as ActionResponse;
      const liveSession = result.session ?? session;
      if (result.headers?.["X-Ordinary-Action-Disposition"] !== "duplicate") broadcastActionResult(sessionId, liveSession, priorCounts, ar);
      return respondJson(result.body, 200, result.headers);
    }

    // POST /api/sessions/:id/compiled/actions — structured compiled action execution.
    if (method === "POST" && segments[3] === "compiled" && segments[4] === "actions" && segments.length === 5) {
      const parsedBody = await readJsonRecord(req, PLAYER_JSON_MAX_BYTES);
      if (parsedBody.status !== "ok") {
        return respondJson({ code: "compiled_action_contract_required", generation: session.getCompiledGeneration() }, jsonBodyFailureStatus(parsedBody));
      }
      const body = parsedBody.value;
      const request = parseCompiledActionRequest(body);
      if (!request) return respondJson({ code: "compiled_action_contract_required", generation: session.getCompiledGeneration() }, 400);
      if (session.getCompiledGeneration() === null) return respondError("会话不是编译模组会话", 404);
      if (!session.session.get(request.pcId)) return respondJson({ code: "unknown_pc", targetId: request.pcId, generation: session.getCompiledGeneration() }, 404);
      if (request.pcId !== "p1") return respondJson({ code: "compiled_single_pc_required", generation: session.getCompiledGeneration() }, 409);
      let input: string;
      try {
        input = compiledMechanicsAction(request.mechanismId);
      } catch {
        return respondJson({ code: "compiled_action_required", generation: session.getCompiledGeneration() }, 400);
      }
      const result = await runCompiledActionTransaction(session, { input, pcId: request.pcId, actionId: request.actionId, expectedGeneration: request.expectedGeneration }, { catalog, snapshots: compiledSnapshots, sessionRegistry: registry, diagnostics: compiledSessionDiagnostics, storage, compiledDurableHostCapability, createRecoverySession: createCompiledRecoverySession, sessionNamespace: runtimeNamespace, namespacePublicationGate: runtimeNamespaceGate });
      return respondJson(result.body, result.status, result.headers);
    }

    // POST /api/sessions/:id/party — 为队伍新增一个 PC
    // 单一入口 addPartyMember（其内部必须走到 createPartyMember，见 game-session
    // 注释）；body 里的 personality/backstory/currentGoal 走兜底链解析后挂到
    // PartyMember.meta（HTTP 字段最优先）。
    if (method === "POST" && segments.length === 4 && segments[3] === "party") {
      const parsedBody = await readJsonRecord(req, GENERAL_JSON_MAX_BYTES);
      if (parsedBody.status !== "ok") return respondJson({ code: "ordinary_party_contract_required" }, jsonBodyFailureStatus(parsedBody));
      const request = parseOrdinaryPartyMemberCreateRequest(parsedBody.value);
      if (!request) return respondJson({ code: "ordinary_party_contract_required" }, 400);
      const durable = await runOrdinaryPartyMemberCreateTransaction(session, request, {
        snapshots: ordinarySnapshots, sessionRegistry: registry, storage, intentPolicy: ordinaryIntentPolicy,
        sessionIntentClient: ordinarySessionIntentClient,
        ordinaryDurableHostCapability: serverOrdinaryDurableHostCapability,
        sessionNamespace: runtimeNamespace, namespacePublicationGate: runtimeNamespaceGate,
        actionAdmission: ordinaryActionAdmission,
        createPristineSession: createOrdinaryRecoverySession,
      });
      return respondJson(durable.body, durable.status, durable.headers);
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "luck-spend") {
      const parsedBody = await readJsonRecord(req, PLAYER_JSON_MAX_BYTES);
      if (parsedBody.status !== "ok") return respondJson({ code: "ordinary_luck_spend_contract_required" }, jsonBodyFailureStatus(parsedBody));
      const request = parseOrdinaryLuckSpendRequest(parsedBody.value);
      if (!request) return respondJson({ code: "ordinary_luck_spend_contract_required" }, 400);
      const durable = await runOrdinaryLuckSpendTransaction(session, request, {
        snapshots: ordinarySnapshots, sessionRegistry: registry, storage, intentPolicy: ordinaryIntentPolicy,
        sessionIntentClient: ordinarySessionIntentClient,
        ordinaryDurableHostCapability: serverOrdinaryDurableHostCapability,
        sessionNamespace: runtimeNamespace, namespacePublicationGate: runtimeNamespaceGate,
        actionAdmission: ordinaryActionAdmission,
        createPristineSession: createOrdinaryRecoverySession,
      });
      return respondJson(durable.body, durable.status, durable.headers);
    }

    // GET /api/sessions/:id/export/:format — 战报导出
    if (method === "GET" && segments[3] === "export" && segments.length === 5) {
      const format = segments[4];
      const history = session.getHistory();
      const summary = session.getSummary();

      if (format === "json") {
        return respondJson({
          session: summary,
          exportedAt: new Date().toISOString(),
          messageCount: history.total,
          messages: history.messages,
        });
      }

      if (format === "markdown") {
        const lines: string[] = [
          `# AI Narrator 游戏记录`,
          ``,
          `**会话ID:** ${summary.id}`,
          `**规则:** ${summary.ruleset}`,
          `**角色:** ${summary.playerName}`,
          `**场景:** ${summary.scene}`,
          `**回合:** ${summary.round}`,
          `**导出时间:** ${new Date().toLocaleString("zh-CN")}`,
          ``,
          `---`,
          ``,
        ];
        for (const msg of history.messages) {
          const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString("zh-CN") : "";
          const speaker = msg.speaker ?? "系统";
          const tag = msg.type === "narration" ? "*旁白*" : msg.type === "action" ? `**${speaker}**` : `_${speaker}_`;
          lines.push(`${ts ? `\`${ts}\` ` : ""}${tag}: ${msg.content}`);
          lines.push("");
        }
        return new Response(lines.join("\n"), {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      }

      return respondError("不支持的导出格式，支持 json, markdown", 400);
    }

  }

  // ── 剧本杀会话 ──
  // 与自由跑团（/api/sessions）并列的一套路由，不共享任何状态：
  // 那边是 KP 即兴生成，这边是线索门禁 + 多结局，两套规则混在一起只会互相污染。
  if (segments[0] === "api" && segments[1] === "scripted") {
    const scriptedSessions = sessionRuntime.scriptedSessions ?? defaultScriptedSessionRegistry;
    // POST /api/scripted — 开一局
    if (method === "POST" && segments.length === 2) {
      // Reuse the ordinary owner authenticator before starting the module or
      // touching the scripted registry. Players cannot create owner-bound runs.
      const principal = await authorizeOrdinarySessionCreation(req, compilerAuthenticator, ordinarySessionAccess);
      if (principal instanceof Response) return principal;
      const s = scriptedSessions.create(createOrdinarySessionAccessBinding(principal));
      if (!s) return respondJson({
        error: { stage: "session", code: "SCRIPTED_SESSION_UNAVAILABLE", message: "scripted session capacity is unavailable" },
      }, 503, { "Cache-Control": "no-store", Pragma: "no-cache" });
      return respondJson({ id: s.id }, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
    }

    const isPoll = method === "GET" && segments.length === 3;
    const isDecide = method === "POST" && segments.length === 4 && segments[3] === "decide";
    if (!isPoll && !isDecide) return respondError("未找到路由", 404);

    // Authentication precedes every locator/map observation, expiry cleanup,
    // poll cursor change, decision submission, and decision body read.
    // Scripted runs are an owner-only legacy surface. Reuse the ordinary owner
    // gate for reads and decisions as well, so a player refusal happens before
    // any locator observation just like a failed authentication does.
    const principal = await authorizeOrdinarySessionCreation(req, compilerAuthenticator, ordinarySessionAccess);
    if (principal instanceof Response) return principal;
    const scripted = scriptedSessions.getAuthorized(segments[2]!, principal);
    // Foreign and unknown locators deliberately share one opaque response.
    if (!scripted) return withRecoveryNoStore(opaqueSessionNotFoundResponse());

    // GET /api/scripted/:id — 拉增量播报与当前岔口
    if (isPoll) {
      const snap = scripted.poll();
      return respondJson(scripted.error ? { ...snap, error: scripted.error } : snap, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
    }

    // POST /api/scripted/:id/decide — 提交选择
    if (isDecide) {
      const body = await readRequiredJsonRecord(req);
      if (body instanceof Response) return body;
      const option = (bodyString(body, "option") ?? "").trim();
      if (!option) return respondError("option 不能为空", 400);
      const r = scripted.submit(option);
      if (!r.ok) return respondError(r.error, 400);
      return respondJson({ ok: true }, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
    }

    return respondError("未找到路由", 404);
  }

  // API 都没匹配上，再看是不是前端资源。
  // 放在最后：API 路由优先，静态文件不会遮住接口。
  if (staticMethod && segments[0] !== "api") {
    const asset = await serveStatic(url.pathname, staticMethod);
    if (asset) return asset;
    // 带扩展名的路径没命中就是真的没有，不要回 index.html —— 否则前端拿到的是
    // 一份 HTML 却按 js/mp3 去解析，报出来的错和真实原因毫无关系。
    // 这一点在预制语音那边已经踩过：vite dev 对缺失的 .mp3 回 200 + HTML。
    if (!/\.[a-zA-Z0-9]+$/.test(url.pathname)) {
      const index = await serveStatic("/index.html", staticMethod);
      if (index) return index;
    }
  }

  return respondError("未找到路由", 404);
}

// ============================================================
// 前端静态资源
// ============================================================

const FRONTEND_DIR = process.env.FRONTEND_DIR
  ?? new URL("../../frontend/dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * 从构建产物目录取文件。没有就返回 null，由调用方决定怎么办。
 *
 * 缓存分两档：带内容哈希的文件名（vite 产出的 index-XXXX.js）可以长期 immutable，
 * 因为改了内容文件名就变；index.html 必须 no-cache，否则用户会一直拿到旧的
 * 那份、里面引用着已经不存在的旧资源名。
 */
async function serveStatic(pathname: string, method: StaticDeliveryMethod = "GET"): Promise<Response | null> {
  // The shared delivery boundary validates URL segments, canonicalizes the
  // candidate, and rejects links that escape the deployment-trusted build root.
  return serveStaticFile(FRONTEND_DIR, pathname, method);
}

// ============================================================
// 请求体解析 — 边界处一次性把 unknown 收成可安全读取的形状
// ============================================================

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Server JSON is fail-closed: only a record is accepted, never a fallback object. */
type JsonBodyReadResult =
  | { status: "ok"; value: JsonRecord }
  | { status: "bodyless" }
  | { status: "invalid" }
  | { status: "too_large" }
  | { status: "timeout" }
  | { status: "aborted" };
type JsonBodyFailure = Exclude<JsonBodyReadResult, { status: "ok" }>;
type ParsedPlayerInvitationClaim =
  | { status: "ok"; value: { invite: string; claimId: string } }
  | JsonBodyFailure;

type JsonBodyReadValue =
  | { done: true; value?: undefined }
  | { done: false; value: Uint8Array };
interface JsonBodyReader {
  read(): Promise<JsonBodyReadValue>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}
type JsonReadOutcome =
  | { kind: "read"; value: JsonBodyReadValue }
  | { kind: "read_error" }
  | { kind: "timeout" }
  | { kind: "aborted" };

/** Never wait for an untrusted stream's cancellation implementation. */
function abandonJsonBody(req: Request, reader?: JsonBodyReader): void {
  try {
    if (reader) {
      void reader.cancel()
        .catch(() => {})
        .finally(() => { try { reader.releaseLock(); } catch { /* best effort */ } });
      return;
    }
    if (req.body) void req.body.cancel().catch(() => {});
  } catch { /* cancellation must not delay the refusal */ }
}

/**
 * This is the sole JSON reader for server-owned HTTP routes. It verifies a
 * declared length before allocating, enforces observed bytes while streaming,
 * and makes the one absolute deadline race every individual `reader.read`.
 */
async function readJsonRecord(req: Request, maxBytes: number): Promise<JsonBodyReadResult> {
  if (req.signal.aborted) {
    abandonJsonBody(req);
    return { status: "aborted" };
  }
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      abandonJsonBody(req);
      return { status: "invalid" };
    }
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      abandonJsonBody(req);
      return { status: "too_large" };
    }
  }
  if (!req.body) return { status: "bodyless" };

  let reader: JsonBodyReader;
  try {
    reader = req.body.getReader();
  } catch {
    return { status: "invalid" };
  }
  const deadlineAt = Date.now() + JSON_BODY_READ_DEADLINE_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = new Promise<JsonReadOutcome>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: "timeout" }), JSON_BODY_READ_DEADLINE_MS);
  });
  const aborted = new Promise<JsonReadOutcome>((resolve) => {
    abortListener = () => resolve({ kind: "aborted" });
    req.signal.addEventListener("abort", abortListener, { once: true });
    if (req.signal.aborted) abortListener();
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (Date.now() >= deadlineAt) {
        abandonJsonBody(req, reader);
        return { status: "timeout" };
      }
      const read: Promise<JsonReadOutcome> = reader.read().then(
        (value): JsonReadOutcome => ({ kind: "read", value }),
        (): JsonReadOutcome => ({ kind: "read_error" }),
      );
      const next = await Promise.race([read, deadline, aborted]);
      if (next.kind === "timeout") {
        abandonJsonBody(req, reader);
        return { status: "timeout" };
      }
      if (next.kind === "aborted") {
        abandonJsonBody(req, reader);
        return { status: "aborted" };
      }
      if (next.kind === "read_error") return { status: req.signal.aborted ? "aborted" : "invalid" };
      if (next.value.done) break;
      const chunk = next.value.value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        abandonJsonBody(req, reader);
        return { status: "too_large" };
      }
      chunks.push(chunk);
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (abortListener) req.signal.removeEventListener("abort", abortListener);
    try { reader.releaseLock(); }
    catch {
      // A hostile cancel must not delay this response. Retry release after the
      // read/cancel state transition, still without awaiting either promise.
      queueMicrotask(() => { try { reader.releaseLock(); } catch { /* best effort */ } });
    }
  }
  // `req.body === null` is the historical bodyless-create contract. An
  // explicit zero-byte stream is a malformed JSON document, not that route.
  if (bytes === 0) return { status: "invalid" };
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    return isJsonRecord(value) ? { status: "ok", value } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

function readBoundedPlayerJsonRecord(req: Request): Promise<JsonBodyReadResult> {
  return readJsonRecord(req, PLAYER_JSON_MAX_BYTES);
}

function jsonBodyFailureStatus(result: JsonBodyFailure): 400 | 408 | 413 {
  if (result.status === "too_large") return 413;
  if (result.status === "timeout" || result.status === "aborted") return 408;
  return 400;
}

async function readRequiredJsonRecord(req: Request, maxBytes = GENERAL_JSON_MAX_BYTES): Promise<JsonRecord | Response> {
  const result = await readJsonRecord(req, maxBytes);
  return result.status === "ok"
    ? result.value
    : respondJson({ error: { stage: "request", code: "JSON_BODY_INVALID", message: "request body is invalid" } }, jsonBodyFailureStatus(result));
}

/** Claim input is deliberately stricter than legacy JSON endpoints. */
async function parsePlayerInvitationClaim(req: Request): Promise<ParsedPlayerInvitationClaim> {
  if ((req.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/json") {
    abandonJsonBody(req);
    return { status: "invalid" };
  }
  const raw = await readBoundedPlayerJsonRecord(req);
  if (raw.status !== "ok") return raw;
  const value = raw.value;
  if (Object.keys(value).length !== 2 || typeof value.invite !== "string" || typeof value.claimId !== "string"
    || !Object.hasOwn(value, "invite") || !Object.hasOwn(value, "claimId")) return { status: "invalid" };
  return { status: "ok", value: { invite: value.invite, claimId: value.claimId } };
}

function bodyString(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function parseCompiledActionRequest(body: JsonRecord): { mechanismId: string; pcId: string; actionId: string; expectedGeneration: number } | null {
  if (!Object.keys(body).every((key) => ["mechanismId", "pcId", "actionId", "expectedGeneration"].includes(key))) return null;
  const mechanismId = bodyString(body, "mechanismId");
  const pcId = bodyString(body, "pcId");
  const actionId = bodyString(body, "actionId");
  const expectedGeneration = body.expectedGeneration;
  if (!mechanismId || mechanismId.trim() !== mechanismId || !pcId || pcId.trim() !== pcId || !actionId || actionId.trim() !== actionId || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) return null;
  return { mechanismId, pcId, actionId, expectedGeneration: expectedGeneration as number };
}

/** The p1 façade accepts no PC selector, command text, or mechanism identifier. */
type CompiledPlayerFacadeActionRequest =
  | { schema: "v1"; choiceId: string; actionId: string; expectedGeneration: number }
  | { schema: "v2_token"; choiceId: string; actionId: string; expectedGeneration: number; topicBound: string }
  | { schema: "v2_input"; choiceId: string; actionId: string; expectedGeneration: number; topicBound: string; playerInput: string };

function parseCompiledPlayerFacadeActionRequest(body: JsonRecord): CompiledPlayerFacadeActionRequest | null {
  const keys = Object.keys(body);
  const v1 = keys.length === 3 && keys.every((key) => ["choiceId", "actionId", "expectedGeneration"].includes(key));
  const v2Token = keys.length === 4 && keys.every((key) => ["choiceId", "actionId", "expectedGeneration", "topicBound"].includes(key));
  const v2Input = keys.length === 5 && keys.every((key) => ["choiceId", "actionId", "expectedGeneration", "topicBound", "playerInput"].includes(key));
  if (!v1 && !v2Token && !v2Input) return null;
  const choiceId = bodyString(body, "choiceId");
  const actionId = bodyString(body, "actionId");
  const expectedGeneration = body.expectedGeneration;
  if (!choiceId || choiceId.trim() !== choiceId || !actionId || actionId.trim() !== actionId
    || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) return null;
  if (v1) return { schema: "v1", choiceId, actionId, expectedGeneration: expectedGeneration as number };
  const topicBound = bodyString(body, "topicBound");
  if (!topicBound || !/^[a-f0-9]{64}$/.test(topicBound)) return null;
  if (v2Token) return { schema: "v2_token", choiceId, actionId, expectedGeneration: expectedGeneration as number, topicBound };
  const playerInput = bodyString(body, "playerInput");
  // Reuse intent classification's bounded, exact-string grammar. The HMAC
  // binds the received value; this path never trims or normalizes it.
  if (typeof playerInput !== "string" || !validateCompiledActionIntentInput(playerInput, expectedGeneration)) return null;
  return { schema: "v2_input", choiceId, actionId, expectedGeneration: expectedGeneration as number, topicBound, playerInput };
}

function sameOpaquePlayerHash(left: string, right: string): boolean {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right)
    && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/** Player intent accepts prose and a generation only; opaque choices are output-only. */
function parseCompiledPlayerFacadeIntentRequest(body: JsonRecord): { input: string; expectedGeneration: number } | null {
  if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "input") || !Object.hasOwn(body, "expectedGeneration")) return null;
  const input = bodyString(body, "input");
  const expectedGeneration = body.expectedGeneration;
  if (typeof input !== "string" || !validateCompiledActionIntentInput(input, expectedGeneration)) return null;
  return { input, expectedGeneration: expectedGeneration as number };
}

type CompiledPlayerFollowupRequest = {
  contactToken: string;
  actionId: string;
  expectedGeneration: number;
  playerInput: string;
  previousActionId?: string;
};

type FollowupRequestContext =
  | { schemaVersion: "1.0.0" }
  | { schemaVersion: "2.0.0"; previousActionId: string | null; contextHash: string };

function parseCompiledPlayerFollowupRequest(body: JsonRecord): CompiledPlayerFollowupRequest | null {
  const keys = Object.keys(body);
  if ((keys.length !== 4 && keys.length !== 5) || !keys.every((key) => ["contactToken", "actionId", "expectedGeneration", "playerInput", "previousActionId"].includes(key))) return null;
  const contactToken = bodyString(body, "contactToken");
  const actionId = bodyString(body, "actionId");
  const expectedGeneration = body.expectedGeneration;
  const playerInput = bodyString(body, "playerInput");
  const previousActionId = body.previousActionId;
  if (!contactToken || !/^contact_[A-Za-z0-9_-]{43}$/.test(contactToken)
    || !actionId || !/^[A-Za-z0-9_-]{1,128}$/.test(actionId)
    || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0
    || typeof playerInput !== "string" || !validateCompiledActionIntentInput(playerInput, expectedGeneration)
    || (Object.hasOwn(body, "previousActionId") && (typeof previousActionId !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(previousActionId) || previousActionId === actionId))) return null;
  return { contactToken, actionId, expectedGeneration: expectedGeneration as number, playerInput,
    ...(typeof previousActionId === "string" ? { previousActionId } : {}),
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function followupFactsHash(contact: CompiledPlayerFollowupContact): string {
  return sha256Hex(JSON.stringify({ domain: "compiled-player-followup-facts-v1", facts: [...contact.facts] }));
}

function followupFrameHash(contact: CompiledPlayerFollowupContact, factsHash: string): string {
  return sha256Hex(JSON.stringify({
    domain: "compiled-player-followup-frame-v1", sessionId: contact.sessionId, bundleId: contact.bundleId,
    generation: contact.generation, sceneId: contact.sceneId, npcId: contact.npcId, clueIds: [...contact.clueIds], factsHash,
  }));
}

function followupContextHash(previousActionId: string | null, previousTurn?: CompiledPlayerFollowupPreviousTurn): string {
  return sha256Hex(JSON.stringify({ domain: "compiled-player-followup-context-v1", previousTurn: previousTurn
    ? { actionId: previousActionId, playerQuestion: previousTurn.playerQuestion, contactReply: previousTurn.contactReply }
    : null,
  }));
}

function followupRecordContext(record: CompiledPlayerFollowupRecord): FollowupRequestContext {
  return record.schemaVersion === "1.0.0" ? { schemaVersion: "1.0.0" }
    : { schemaVersion: "2.0.0", previousActionId: record.previousActionId, contextHash: record.contextHash };
}

function followupBinding(contact: CompiledPlayerFollowupContact, contactToken: string, actionId: string, playerInput: string, context: FollowupRequestContext): CompiledPlayerFollowupBinding {
  const factsHash = followupFactsHash(contact);
  const frameHash = followupFrameHash(contact, factsHash);
  return {
    sessionId: contact.sessionId, bundleId: contact.bundleId, expectedGeneration: contact.generation,
    sceneId: contact.sceneId, npcId: contact.npcId, clueIds: [...contact.clueIds], factsHash, contactToken, actionId,
    playerRequestHash: sha256Hex(JSON.stringify(context.schemaVersion === "1.0.0"
      ? { domain: "compiled-player-followup-request-v1", contactToken, actionId, generation: contact.generation, input: playerInput }
      : { domain: "compiled-player-followup-request-v2", contactToken, actionId, generation: contact.generation, input: playerInput, previousActionId: context.previousActionId, contextHash: context.contextHash })),
    frameHash,
  };
}

function followupRecord(binding: CompiledPlayerFollowupBinding, playerInput: string, context: FollowupRequestContext, preparedMac: string): CompiledPlayerFollowupRecord {
  const base = {
    sessionId: binding.sessionId, bundleId: binding.bundleId, actionId: binding.actionId,
    expectedGeneration: binding.expectedGeneration, sceneId: binding.sceneId, npcId: binding.npcId, clueIds: [...binding.clueIds],
    contactTokenHash: sha256Hex(binding.contactToken), factsHash: binding.factsHash, playerRequestHash: binding.playerRequestHash,
    frameHash: binding.frameHash, preparedMac,
  };
  return context.schemaVersion === "1.0.0" ? { schemaVersion: "1.0.0", ...base }
    : { schemaVersion: "2.0.0", ...base, playerInput, previousActionId: context.previousActionId, contextHash: context.contextHash };
}

/** Authenticate a receipt against independently recomputed live-contact scope
 * and request identity. Predecessors require an already settled anchor; only
 * exact current replay may close the known post-receipt crash window. */
function trustedFollowupReceipt(
  binding: CompiledPlayerFollowupBinding,
  record: CompiledPlayerFollowupRecord,
  narration: { schemaVersion: "1.0.0"; text: string },
  receiptMac: string,
  delivery: CompiledPlayerDelivery,
  admission: CompiledPlayerFollowupAdmissionCoordinator,
  recoverAdmission: boolean,
): boolean {
  const dispatchMac = record.dispatchMac;
  if (!dispatchMac || record.sessionId !== binding.sessionId || record.bundleId !== binding.bundleId
    || record.actionId !== binding.actionId || record.expectedGeneration !== binding.expectedGeneration
    || record.sceneId !== binding.sceneId || record.npcId !== binding.npcId
    || JSON.stringify(record.clueIds) !== JSON.stringify(binding.clueIds)
    || record.contactTokenHash !== sha256Hex(binding.contactToken) || record.factsHash !== binding.factsHash
    || record.frameHash !== binding.frameHash || record.playerRequestHash !== binding.playerRequestHash
    || !delivery.verifyCompiledPlayerFollowupPrepared(binding, record.preparedMac)
    || !delivery.verifyCompiledPlayerFollowupDispatch(binding, record.preparedMac, dispatchMac)) return false;
  const textHash = sha256Hex(narration.text);
  if (!delivery.verifyCompiledPlayerFollowupReceipt(binding, dispatchMac, textHash, receiptMac)) return false;
  let anchored = admission.read(binding.sessionId, binding.actionId);
  if (anchored.status !== "ok" || anchored.value.expectedGeneration !== binding.expectedGeneration
    || anchored.value.requestHash !== binding.playerRequestHash || anchored.value.dispatchMac !== dispatchMac) return false;
  if (recoverAdmission && anchored.value.state === "dispatching") {
    const recovered = admission.settle({ sessionId: binding.sessionId, actionId: binding.actionId, expectedGeneration: binding.expectedGeneration,
      requestHash: binding.playerRequestHash, dispatchMac, receiptHash: textHash, receiptMac });
    if (recovered !== "settled" && recovered !== "existing") return false;
    anchored = admission.read(binding.sessionId, binding.actionId);
  }
  return anchored.status === "ok" && anchored.value.state === "settled"
    && anchored.value.receiptHash === textHash && anchored.value.receiptMac === receiptMac;
}

function sameFollowupRecord(left: CompiledPlayerFollowupRecord, right: CompiledPlayerFollowupRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameFollowupRecordBase(left: CompiledPlayerFollowupRecord, right: CompiledPlayerFollowupRecord): boolean {
  const { dispatchMac: _leftDispatch, ...leftBase } = left;
  const { dispatchMac: _rightDispatch, ...rightBase } = right;
  return JSON.stringify(leftBase) === JSON.stringify(rightBase);
}

/** Catalog equality is keyed by mechanism ID; no façade mapping relies on position. */
function sameCompiledAvailableActionCatalog(left: readonly CompiledAvailableAction[], right: readonly CompiledAvailableAction[]): boolean {
  if (left.length !== right.length) return false;
  const rightByMechanism = new Map(right.map((action) => [action.mechanismId, action]));
  if (rightByMechanism.size !== right.length) return false;
  return left.every((action) => {
    const current = rightByMechanism.get(action.mechanismId);
    return !!current && current.kind === action.kind && current.command === action.command && current.label === action.label
      && JSON.stringify(current.check) === JSON.stringify(action.check);
  });
}

function parseCompiledIntentRequest(body: JsonRecord): { input: string; pcId: string; expectedGeneration: number } | null {
  if (!Object.keys(body).every((key) => ["input", "pcId", "expectedGeneration"].includes(key)) || Object.keys(body).length !== 3) return null;
  const input = bodyString(body, "input");
  const pcId = bodyString(body, "pcId");
  const expectedGeneration = body.expectedGeneration;
  if (!input || input.trim() !== input || !pcId || pcId.trim() !== pcId || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) return null;
  return { input, pcId, expectedGeneration: expectedGeneration as number };
}

/** Server-owned so hydrated compiled sessions do not need a live session LLM. */
function configuredCompiledIntentLlm(options: CompiledIntentHandlerOptions): LLMLike | null {
  if (!(options.isLlmEnabled ?? llmEnabled)()) return null;
  return options.llm ?? new LLMClient(loadConfig());
}

/** Production narration is opt-in through the same enabled configuration as
 * other live LLM work. Offline compiled mechanics retain their exact existing
 * semantics rather than pretending a deterministic string is model prose. */
function configuredCompiledNarrationLlm(options: CompiledNarrationHandlerOptions): LLMLike | null {
  if (!(options.isLlmEnabled ?? llmEnabled)()) return null;
  return options.llm ?? new LLMClient(loadConfig());
}

/** Add delivery-secret opaque contact tokens without teaching GameSession's
 * public projection about durable identifiers. A disabled delivery capability
 * retains the legacy names-only façade. */
function playerFacadeViewWithFollowupContacts(
  session: GameSession,
  capability: object,
  delivery: CompiledPlayerDelivery,
) {
  const view = session.getCompiledPlayerFacadeView();
  if (!delivery.available || !view.presentation?.contacts?.length) return view;
  const contacts = resolveCompiledDurablePlayerFollowupContacts(session, capability);
  const tokens = contacts.map((contact) => delivery.issueCompiledPlayerFollowupContact({
    sessionId: contact.sessionId, bundleId: contact.bundleId, expectedGeneration: contact.generation,
    sceneId: contact.sceneId, npcId: contact.npcId, clueIds: contact.clueIds, factsHash: followupFactsHash(contact),
  }));
  if (tokens.some((token) => !token) || contacts.length !== view.presentation.contacts.length) return view;
  return {
    ...view,
    presentation: {
      ...view.presentation,
      contacts: contacts.map((contact, index) => ({ name: contact.name, contactToken: tokens[index]! })),
    },
  };
}

type HeldCompiledIntentAdmission = Extract<CompiledIntentAdmissionResult, { status: "acquired" }>;
type CompiledIntentAdmissionRefusal = Exclude<CompiledIntentAdmissionResult, { status: "acquired" }>;

/**
 * The provider deadline is shorter than the durable lease, but renew while a
 * custom host LLM is in flight as well. A failed renewal is not a harmless
 * observability event: returning a classification after losing its fence
 * would make the durable cost boundary unverifiable, so callers fail closed.
 */
function renewCompiledIntentAdmission(admission: HeldCompiledIntentAdmission, onFailure: () => void) {
  let failure: Exclude<ReturnType<typeof admission.renew>, { status: "active" }> | undefined;
  const timer = setInterval(() => {
    if (failure) return;
    const renewed = admission.renew();
    if (renewed.status !== "active") {
      failure = renewed;
      onFailure();
    }
  }, admission.renewalIntervalMs);
  timer.unref?.();
  return {
    failure: () => failure,
    stop: () => clearInterval(timer),
  };
}

function combineAbortSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const live = signals.filter((signal) => !signal.aborted);
  if (live.length !== signals.length) controller.abort();
  else for (const signal of live) signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => { for (const signal of live) signal.removeEventListener("abort", abort); },
  };
}

type CompiledIntentDurableState =
  | { status: "current"; generation: number }
  | { status: "conflict"; generation: number | null }
  | { status: "unavailable"; generation: number | null };

/**
 * The in-process registry is a cache, not cross-process authority. Every
 * model boundary checks the committed namespace pointer and immutable snapshot
 * header so another Bun process's action cannot be answered as a stale intent.
 */
function compiledIntentDurableState(
  sessionId: string,
  expectedGeneration: number,
  namespace: SessionNamespaceCoordinator,
  snapshots: CompiledSessionSnapshotStore,
): CompiledIntentDurableState {
  let record;
  try { record = namespace.read(sessionId); }
  catch { return { status: "unavailable", generation: null }; }
  if (!record || record.state !== "committed" || record.kind !== "compiled" || !record.expectedIdentity
    || record.expectedIdentity.format !== COMPILED_SESSION_NAMESPACE_IDENTITY_FORMAT) {
    return { status: "unavailable", generation: null };
  }
  const header = snapshots.readHeader(sessionId);
  if (header.status !== "ok"
    || header.value.snapshotHash !== record.expectedIdentity.hash
    || header.value.generation !== record.expectedIdentity.generation) {
    return { status: "unavailable", generation: record.expectedIdentity.generation };
  }
  return header.value.generation === expectedGeneration
    ? { status: "current", generation: header.value.generation }
    : { status: "conflict", generation: header.value.generation };
}

/**
 * A non-cooperating injected provider is not a reason to erase its lease. On
 * the hard deadline the holder is isolated: callers receive a safe failure,
 * while the durable row remains until normal settle or authenticated recovery.
 */
async function awaitCompiledIntentResolution<T>(work: Promise<T>, onDrain: () => void): Promise<{ status: "resolved"; value: T } | { status: "draining" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = new Promise<{ status: "draining" }>((resolve) => {
    timer = setTimeout(() => {
      onDrain();
      resolve({ status: "draining" });
    }, COMPILED_INTENT_LLM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      work.then((value) => ({ status: "resolved" as const, value })),
      drained,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A normal competing holder is the only 429 outcome. Storage/schema/policy,
 * expiry quarantine, and commit uncertainty are all fail-closed 503s. No
 * raw prose, admission key, mechanism identifier, or storage detail escapes.
 */
function compiledIntentAdmissionRefusal(
  result: CompiledIntentAdmissionRefusal,
  generation: number | null,
  playerFacade: boolean,
): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  const busy = result.status === "refused" && result.code === "ORDINARY_ACTION_BUSY";
  const status = busy ? 429 : 503;
  return {
    status,
    body: playerFacade
      ? { error: { code: busy ? "PLAYER_INTENT_BUSY" : "PLAYER_INTENT_ADMISSION_UNAVAILABLE" }, generation }
      : { code: busy ? "compiled_intent_busy" : "compiled_intent_admission_unavailable", generation },
    headers: { "Retry-After": String(result.retryAfterSeconds) },
  };
}

type CompiledIntentReplayResolution = Exclude<CompiledActionIntentResolution, { status: "invalid" | "error" }>;
type CompiledIntentResolutionAttempt =
  | { status: "resolved"; resolution: CompiledIntentReplayResolution; session: GameSession; generation: number }
  | { status: "invalid"; generation: number }
  | { status: "conflict"; generation: number | null }
  | { status: "unavailable"; generation: number | null }
  | { status: "admission_refused"; generation: number | null; admission: CompiledIntentAdmissionRefusal };

function sameCompiledIntentReplayIdentity(
  left: ReturnType<typeof deriveCompiledIntentReplayIdentity>,
  right: ReturnType<typeof deriveCompiledIntentReplayIdentity>,
): boolean {
  return left.sessionKey === right.sessionKey
    && left.expectedGeneration === right.expectedGeneration
    && left.scopeKey === right.scopeKey
    && left.requestKey === right.requestKey
    && left.catalogKey === right.catalogKey
    && left.integrityKey === right.integrityKey
    && left.mechanismKeys.length === right.mechanismKeys.length
    && left.mechanismKeys.every((entry, index) => entry.mechanismId === right.mechanismKeys[index]?.mechanismId && entry.key === right.mechanismKeys[index]?.key);
}

function replayResolution(
  result: CompiledIntentReplayResult,
  identity: ReturnType<typeof deriveCompiledIntentReplayIdentity>,
): CompiledIntentReplayResolution | null {
  const mechanismByKey = new Map(identity.mechanismKeys.map((entry) => [entry.key, entry.mechanismId]));
  const ids = result.mechanismKeys.map((key) => mechanismByKey.get(key));
  if (ids.some((id) => id === undefined)) return null;
  if (result.kind === "no_match") return ids.length === 0 ? { status: "no_match" } : null;
  if (result.kind === "selected") return ids.length === 1 ? { status: "selected", mechanismId: ids[0]! } : null;
  return ids.length >= 2 && new Set(ids).size === ids.length ? { status: "ambiguous", mechanismIds: ids as string[] } : null;
}

function replayResult(
  resolution: CompiledIntentReplayResolution,
  identity: ReturnType<typeof deriveCompiledIntentReplayIdentity>,
): CompiledIntentReplayResult | null {
  const keyByMechanism = new Map(identity.mechanismKeys.map((entry) => [entry.mechanismId, entry.key]));
  if (resolution.status === "no_match") return { kind: "no_match", mechanismKeys: [] };
  const ids = resolution.status === "selected" ? [resolution.mechanismId] : resolution.mechanismIds;
  const keys = ids.map((id) => keyByMechanism.get(id));
  if (keys.some((key) => key === undefined)) return null;
  return resolution.status === "selected"
    ? { kind: "selected", mechanismKeys: keys as string[] }
    : { kind: "ambiguous", mechanismKeys: keys as string[] };
}

/**
 * Shared owner/player compiled-intent transaction.  The two HTTP facades
 * choose only their final response projection; lookup, provider work, durable
 * rechecks, replay save, lease fencing, and quarantine remain one sequence.
 */
async function resolveCompiledIntentWithReplay(input: {
  sessionId: string;
  source: GameSession;
  expectedGeneration: number;
  playerInput: string;
  catalog: readonly CompiledAvailableAction[];
  llm: LLMLike;
  signal: AbortSignal;
  registry: Map<string, GameSession>;
  namespace: SessionNamespaceCoordinator;
  snapshots: CompiledSessionSnapshotStore;
  durableHostCapability: object;
  admission: CompiledIntentAdmissionCoordinator;
  replay: CompiledIntentReplayStore;
}): Promise<CompiledIntentResolutionAttempt> {
  const current = (): { status: "ok"; session: GameSession; generation: number; catalog: CompiledAvailableAction[] } | { status: "conflict" | "unavailable"; generation: number | null } => {
    const live = input.registry.get(input.sessionId);
    const generation = live?.getCompiledGeneration() ?? null;
    if (!live || generation === null || generation !== input.expectedGeneration) return { status: "conflict", generation };
    const durable = compiledIntentDurableState(input.sessionId, input.expectedGeneration, input.namespace, input.snapshots);
    if (durable.status !== "current") return { status: durable.status, generation: durable.generation };
    let catalog: CompiledAvailableAction[];
    try { catalog = live.getCompiledAvailableActions(); }
    catch { return { status: "unavailable", generation }; }
    if (!sameCompiledAvailableActionCatalog(input.catalog, catalog)) return { status: "conflict", generation };
    return { status: "ok", session: live, generation, catalog };
  };
  const identityFor = (session: GameSession, catalog: readonly CompiledAvailableAction[]) => {
    return deriveCompiledIntentReplayIdentity(session, input.durableHostCapability, input.playerInput, input.expectedGeneration, catalog);
  };
  const before = current();
  if (before.status !== "ok") return before.status === "conflict"
    ? { status: "conflict", generation: before.generation }
    : { status: "unavailable", generation: before.generation };
  if (before.session !== input.source) return { status: "conflict", generation: before.generation };
  let initialIdentity: ReturnType<typeof deriveCompiledIntentReplayIdentity>;
  try { initialIdentity = identityFor(input.source, input.catalog); }
  catch { return { status: "unavailable", generation: input.source.getCompiledGeneration() }; }

  // Lookup precedes lease acquisition. A hit cannot touch the provider, and a
  // miss races through the existing durable admission exactly as before.
  const replay = input.replay.read(initialIdentity);
  if (replay.status === "hit") {
    const resolution = replayResolution(replay.value, initialIdentity);
    const after = current();
    if (!resolution || after.status !== "ok") {
      // A malformed/tampered record or a source/catalog ABA cannot become a
      // fresh model call. Preserve evidence, then fail closed.
      input.replay.quarantineReplayResult(initialIdentity);
      return after.status === "conflict"
        ? { status: "conflict", generation: after.generation }
        : { status: "unavailable", generation: after.generation };
    }
    try {
      if (!sameCompiledIntentReplayIdentity(initialIdentity, identityFor(after.session, after.catalog))) {
        input.replay.quarantineReplayResult(initialIdentity);
        return { status: "unavailable", generation: after.generation };
      }
    } catch {
      input.replay.quarantineReplayResult(initialIdentity);
      return { status: "unavailable", generation: after.generation };
    }
    return { status: "resolved", resolution, session: after.session, generation: after.generation };
  }
  if (replay.status === "refused") return { status: "unavailable", generation: input.source.getCompiledGeneration() };

  const admission = input.admission.acquire({
    sessionId: input.sessionId,
    expectedGeneration: input.expectedGeneration,
    input: input.playerInput,
  });
  if (admission.status !== "acquired") {
    return { status: "admission_refused", generation: input.source.getCompiledGeneration(), admission };
  }
  const leaseAbort = new AbortController();
  const combinedSignal = combineAbortSignals([input.signal, leaseAbort.signal]);
  let releaseAdmission = true;
  const retainAdmission = () => {
    if (!releaseAdmission) return;
    releaseAdmission = false;
    leaseAbort.abort();
    admission.quarantine();
  };
  const onRequestAbort = () => retainAdmission();
  input.signal.addEventListener("abort", onRequestAbort, { once: true });
  if (input.signal.aborted) retainAdmission();
  const renewal = renewCompiledIntentAdmission(admission, retainAdmission);
  try {
    // A process can miss a record, lose the CPU while another process saves
    // and releases it, then acquire this now-free lease. Re-read *after*
    // acquiring and before provider work to linearize that window: the holder
    // either sees the completed result or becomes the sole provider seam.
    const replayAfterAcquire = input.replay.read(initialIdentity);
    if (replayAfterAcquire.status === "hit") {
      const resolution = replayResolution(replayAfterAcquire.value, initialIdentity);
      const after = current();
      if (!resolution || after.status !== "ok") {
        input.replay.quarantineReplayResult(initialIdentity);
        retainAdmission();
        return after.status === "conflict"
          ? { status: "conflict", generation: after.generation }
          : { status: "unavailable", generation: after.generation };
      }
      try {
        if (!sameCompiledIntentReplayIdentity(initialIdentity, identityFor(after.session, after.catalog))) {
          input.replay.quarantineReplayResult(initialIdentity);
          retainAdmission();
          return { status: "unavailable", generation: after.generation };
        }
      } catch {
        input.replay.quarantineReplayResult(initialIdentity);
        retainAdmission();
        return { status: "unavailable", generation: after.generation };
      }
      return { status: "resolved", resolution, session: after.session, generation: after.generation };
    }
    if (replayAfterAcquire.status === "refused") {
      // There is no provider outcome yet, but the completed-result authority
      // is uncertain. Do not turn that uncertainty into a fresh provider call.
      retainAdmission();
      return { status: "unavailable", generation: input.source.getCompiledGeneration() };
    }
    // Capacity is scoped to this immutable session/generation/bundle identity.
    // No provider has run yet, so a full or unavailable ledger simply returns
    // 503 and lets finally release the lease normally; save repeats this guard
    // under its insert transaction as a defensive fence.
    const capacity = input.replay.hasCapacity(initialIdentity);
    if (capacity.status === "refused") {
      return { status: "unavailable", generation: input.source.getCompiledGeneration() };
    }
    const classified = await awaitCompiledIntentResolution(resolveCompiledActionIntent({
      input: input.playerInput,
      expectedGeneration: input.expectedGeneration,
      catalog: input.catalog,
      llm: input.llm,
      signal: combinedSignal.signal,
    }), retainAdmission);
    if (classified.status === "draining") return { status: "unavailable", generation: input.source.getCompiledGeneration() };
    const resolution = classified.value;
    const renewalFailure = renewal.failure();
    if (renewalFailure) {
      retainAdmission();
      return { status: "admission_refused", generation: input.source.getCompiledGeneration(), admission: renewalFailure };
    }
    if (!releaseAdmission || resolution.status === "error") {
      retainAdmission();
      return { status: "unavailable", generation: input.source.getCompiledGeneration() };
    }
    const after = current();
    if (after.status !== "ok") return after.status === "conflict"
      ? { status: "conflict", generation: after.generation }
      : { status: "unavailable", generation: after.generation };
    if (resolution.status === "invalid") return { status: "invalid", generation: after.generation };
    let finalIdentity: ReturnType<typeof deriveCompiledIntentReplayIdentity>;
    try { finalIdentity = identityFor(after.session, after.catalog); }
    catch {
      retainAdmission();
      return { status: "unavailable", generation: after.generation };
    }
    if (!sameCompiledIntentReplayIdentity(initialIdentity, finalIdentity)) {
      retainAdmission();
      return { status: "unavailable", generation: after.generation };
    }
    const durableResult = replayResult(resolution, finalIdentity);
    if (!durableResult) {
      retainAdmission();
      return { status: "unavailable", generation: after.generation };
    }
    // The immutable result must commit before release. Any refusal or unknown
    // acknowledgement leaves the active provider lease quarantined, so a
    // second request cannot repeat a provider call after uncertain work.
    const saved = input.replay.save(finalIdentity, durableResult);
    if (saved.status !== "stored") {
      retainAdmission();
      return { status: "unavailable", generation: after.generation };
    }
    return { status: "resolved", resolution, session: after.session, generation: after.generation };
  } finally {
    renewal.stop();
    combinedSignal.dispose();
    input.signal.removeEventListener("abort", onRequestAbort);
    if (releaseAdmission) admission.release();
  }
}

/** 数字字段兼容字符串写法（前端表单常传字符串），与原先的 parseInt 行为保持一致。 */
// ============================================================
// 响应辅助
// ============================================================

function respondJson(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers(corsHeaders());
  for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers,
  });
}

function respondError(message: string, status = 400): Response {
  return respondJson({ error: message }, status);
}

/** A hydration diagnostic is operational-only; every caller receives the same opaque miss. */
export function opaqueSessionNotFoundResponse(_diagnostic?: CompiledSessionDiagnostic): Response {
  return respondError("会话不存在或已过期", 404);
}

/**
 * 执行一次 action 的**核心**（body 解析 + 可选 pcId 路由 + 结构化拒绝），
 * 抽取成纯逻辑而不是让 HTTP 端点内联：这样 POST /api/sessions/:id/action
 * 的"pcId 是否真的被转发给 act()"是可单测的（改回 `session.act(input)`
 * 不传第二参，本函数的测试就会变红），而端点本身只负责它自己的职责——
 * 持久化元数据、广播、附 summary。
 *
 * pcId「以哪个 PC 身份行动」是可选字段：缺省（未传）时沿用
 * activePlayerId，与 kp/set-san 的 `bodyString(...,"playerId") ||
 * session.activePlayerId` 同一约定，保持既有客户端不破。未知 pcId 由
 * act() 内部在改动任何状态**前**结构化校验并置 result.error（activePlayerId
 * 因此不会"先切过去再发现切不了"），这里把它翻成结构化 4xx——不能折成 200
 * 里一条系统消息，那又是"报告了一件没发生的事"。
 */
export async function runAction(
  session: GameSession,
  body: JsonRecord,
  persistCompiledSnapshot?: (snapshot: CompiledSessionSnapshot) => void,
  installCompiledSnapshot?: (snapshot: CompiledSessionSnapshot) => GameSession,
  executeOrdinaryAction?: (input: string, actingPcId?: string) => Promise<ActionResponse>,
  recoverCompiledPersistence?: () => GameSession | undefined,
  compiledDurableHostCapability?: object,
): Promise<{ status: number; body: Record<string, unknown>; headers?: Record<string, string>; session?: GameSession }> {
  const rawInput = bodyString(body, "input");
  const input = (rawInput ?? "").trim();
  // A direct-action fault fail-stops and closes the session before callers can
  // retry.  Keep that lifecycle detail inside GameSession: the HTTP boundary
  // must still return its established generic failure rather than leaking a
  // closed-reader exception while classifying the retry.
  let generation: number | null;
  try {
    generation = session.getCompiledGeneration();
  } catch {
    return {
      status: 500,
      body: { code: session.isDurableCompiledSession() ? "compiled_unavailable" : "ordinary_execution_failed" },
    };
  }
  if (generation === null && rawInput !== undefined && Array.from(rawInput).length > 1000) {
    return { status: 422, body: { code: "action_input_too_long" } };
  }
  const actingPcId = (bodyString(body, "pcId") ?? "").trim() || undefined;
  if (generation !== null) {
    if (!Object.keys(body).every((key) => ["input", "pcId", "actionId", "expectedGeneration"].includes(key))) {
      return { status: 400, body: { code: "compiled_action_contract_required", generation } };
    }
    if (!actingPcId) return { status: 400, body: { code: "compiled_single_pc_required", generation } };
    if (!session.session.get(actingPcId)) return { status: 404, body: { code: "unknown_pc", targetId: actingPcId, generation } };
    if (actingPcId !== "p1") return { status: 409, body: { code: "compiled_single_pc_required", generation } };
    const actionId = (bodyString(body, "actionId") ?? "").trim();
    const expectedGeneration = body.expectedGeneration;
    if (!actionId || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) {
      return { status: 400, body: { code: "compiled_action_contract_required", generation } };
    }
    if (!input) return { status: 400, body: { code: "compiled_action_required", generation } };
    if (compiledDurableHostCapability === undefined) {
      return { status: 500, body: { code: "compiled_unavailable", generation } };
    }
    let committed: ReturnType<typeof commitCompiledDurableAction>;
    try {
      committed = commitCompiledDurableAction(session, compiledDurableHostCapability, input, actionId, expectedGeneration as number, persistCompiledSnapshot ?? (() => { throw new Error("compiled snapshot persistence is unavailable"); }));
    } catch {
      return { status: 500, body: { code: "compiled_unavailable", generation } };
    }
    if (committed.status === "refused") {
      const persistenceRecovery = committed.code === "compiled_generation_conflict" || committed.code === "compiled_persistence_busy" || committed.code === "compiled_persistence_indeterminate";
      let authoritativeSession: GameSession | undefined;
      if (persistenceRecovery && recoverCompiledPersistence) {
        try { authoritativeSession = recoverCompiledPersistence(); }
        catch {
          return { status: 503, body: { code: "compiled_unavailable", generation: committed.generation }, headers: { "Retry-After": "1" } };
        }
      }
      const authoritativeGeneration = authoritativeSession?.getCompiledGeneration() ?? committed.generation;
      const status = committed.code === "compiled_persistence_busy" || committed.code === "compiled_persistence_indeterminate" ? 503
        : committed.code === "compiled_persistence_quota" ? 507
          : committed.code === "compiled_persistence_failed" || committed.code === "compiled_execution_failed" || committed.code === "compiled_unavailable" ? 500
        : committed.code === "compiled_action_required" || committed.code === "compiled_action_contract_required" ? 400
          : 409;
      return {
        status,
        body: {
          code: committed.code,
          generation: authoritativeGeneration,
          ...(committed.code === "compiled_persistence_quota" ? { message: "compiled snapshot capacity is unavailable" } : {}),
          ...(committed.code === "compiled_terminal" ? { compiled: session.getCompiledMechanicsState() } : {}),
        },
        ...(status === 503 ? { headers: { "Retry-After": "1" } } : {}),
        ...(authoritativeSession ? { session: authoritativeSession } : {}),
      };
    }
    if (committed.status === "committed") {
      if (!committed.snapshot || !installCompiledSnapshot) return { status: 500, body: { code: "compiled_unavailable", generation: committed.generation } };
      try {
        const replacement = installCompiledSnapshot(committed.snapshot);
        return { status: 200, body: { ...committed.response.action, summary: committed.response.summary, generation: committed.response.generation }, session: replacement };
      } catch {
        return { status: 500, body: { code: "compiled_unavailable", generation: committed.generation } };
      }
    }
    return { status: 200, body: { ...committed.response.action, summary: committed.response.summary, generation: committed.response.generation }, session };
  }
  if (!input) return { status: 400, body: { error: "请输入行动" } };
  let result: ActionResponse;
  try {
    result = await (executeOrdinaryAction ?? ((actionInput, pcId) => session.act(actionInput, pcId)))(input, actingPcId);
  } catch {
    // Ordinary action exceptions can include storage/backend details. Keep the
    // direct HTTP contract stable and let the durable transaction add its
    // authoritative generation below.
    return { status: 500, body: { code: "ordinary_execution_failed" } };
  }
  if (result.error) {
    if (result.error.code === "intent_model_unavailable") {
      return { status: 503, body: { code: "intent_model_unavailable" } };
    }
    if (result.error.code === "intent_model_invalid") {
      return { status: 422, body: { code: "intent_model_invalid" } };
    }
    if (result.error.code === "ordinary_action_unsupported") {
      return { status: 422, body: { code: "ordinary_action_unsupported" } };
    }
    if (result.error.code === "ordinary_durable_transaction_required"
      || result.error.code === "ordinary_career_rebase_unsupported") {
      return { status: 422, body: { code: result.error.code } };
    }
    return { status: 404, body: { code: result.error.code, targetId: result.error.targetId } };
  }
  return { status: 200, body: { ...result, summary: session.getSummary() } };
}

interface CompiledActionTransactionOptions {
  catalog: CompilerArtifactCatalog;
  snapshots: CompiledSessionSnapshotStore;
  sessionRegistry: Map<string, GameSession>;
  diagnostics: Map<string, { id: string; code: string; message: string }>;
  storage: { careerRoot?: string };
  /** Unforgeable host capability installed in source and recovery sessions. */
  compiledDurableHostCapability: object;
  /** Trusted host recovery seam; durable state never carries constructor configuration. */
  createRecoverySession?: (input: { id: string; storage: { careerRoot?: string; sessionRoot?: string } }) => GameSession;
  sessionNamespace?: SessionNamespaceCoordinator;
  namespacePublicationGate?: SessionNamespacePublicationGate;
  /** Present only when this request is allowed to obtain provider prose. */
  narration?: {
    /** Undefined is permitted only for consuming an already-durable receipt. */
    llm?: LLMLike;
    signal?: AbortSignal;
    /** Hash of the public opaque choice/action/generation request. */
    playerRequestHash?: string;
    /** Raw player prose remains request-scoped and reaches only the model prompt. */
    playerTopic?: CompiledPlayerNarrationTopicRequest;
    admission: CompiledNarrationAdmissionCoordinator;
    ledger: CompiledNarrationLedger;
  };
}

export interface OrdinaryActionTransactionOptions {
  snapshots: OrdinarySessionSnapshotStore;
  sessionRegistry: Map<string, GameSession>;
  storage: { careerRoot?: string; sessionRoot?: string };
  intentPolicy: Extract<NormalSessionIntentPolicy, "required" | "development_fallback">;
  /** Trusted host-only capability inherited by staging and recovery sessions. */
  sessionIntentClient?: NormalSessionIntentClient;
  /** Unforgeable server-local capability for all durable ordinary host work. */
  ordinaryDurableHostCapability?: object;
  /** Trusted host recovery seam. Request JSON cannot select this constructor. */
  createPristineSession?: OrdinaryPristineSessionFactory;
  /** Current-identity CAS and same-instance permit verifier for gN. */
  sessionNamespace?: SessionNamespaceCoordinator;
  namespacePublicationGate?: SessionNamespacePublicationGate;
  /** Required execution-before-model fence for one ordinary generation. */
  actionAdmission: OrdinaryActionAdmissionCoordinator;
}

/** Only locally-known store classifications may traverse the coordinator
 * callback. The namespace persists none of these and HTTP returns none of
 * their messages, but preserving the code keeps capacity/conflict/busy
 * response semantics from being downgraded to an ambiguous 503. */
function ordinaryPublicationFailureCode(value: unknown): OrdinarySessionSnapshotRefusalCode | undefined {
  switch (value) {
    case "ORDINARY_SNAPSHOT_NOT_FOUND":
    case "ORDINARY_SNAPSHOT_CORRUPT":
    case "ORDINARY_SNAPSHOT_INCOMPATIBLE":
    case "ORDINARY_SNAPSHOT_STORAGE_FAILED":
    case "ORDINARY_SNAPSHOT_CONFLICT":
    case "ORDINARY_SNAPSHOT_BUSY":
    case "ORDINARY_SNAPSHOT_POLICY_MISMATCH":
    case "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED":
    case "ORDINARY_SNAPSHOT_NAMESPACE_FENCED":
      return value;
    default:
      return undefined;
  }
}

/** Namespace errors carry no public storage detail. Preserve only their
 * stable class so ordinary HTTP can distinguish retryable busy from safe
 * conflict/policy/storage responses. */
function ordinaryNamespaceFailureCode(error: unknown): OrdinarySessionSnapshotRefusalCode | undefined {
  if (!(error instanceof SessionNamespaceFailure)) return undefined;
  switch (error.code) {
    case "SESSION_NAMESPACE_BUSY": return "ORDINARY_SNAPSHOT_BUSY";
    case "SESSION_NAMESPACE_POLICY_MISMATCH": return "ORDINARY_SNAPSHOT_POLICY_MISMATCH";
    case "SESSION_NAMESPACE_CONFLICT":
    case "SESSION_NAMESPACE_FENCED":
    case "SESSION_NAMESPACE_IDENTITY_MISMATCH": return "ORDINARY_SNAPSHOT_CONFLICT";
    default: return "ORDINARY_SNAPSHOT_STORAGE_FAILED";
  }
}

function ordinaryDuplicateHeaders(receiptGeneration: number, currentGeneration: number): Record<string, string> {
  return {
    "X-Ordinary-Action-Disposition": "duplicate",
    "X-Ordinary-Current-Generation": String(currentGeneration),
    // The body is an immutable historical receipt. A later durable action
    // means callers must reconcile current state before applying it as live.
    ...(receiptGeneration === currentGeneration ? {} : { "X-Ordinary-Reconcile-Required": "true" }),
  };
}

function ordinaryActionAdmissionRefusal(
  result: Exclude<OrdinaryActionAdmissionResult, { status: "acquired" }>,
  ordinaryGeneration: number,
): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  const code: OrdinaryActionAdmissionFailureCode = result.code;
  return {
    status: 503,
    body: {
      code: code === "ORDINARY_ACTION_BUSY"
        ? "ordinary_action_busy"
        : code === "ORDINARY_ACTION_QUARANTINED" || code === "ORDINARY_ACTION_LEASE_EXPIRED"
          ? "ordinary_action_quarantined"
          : "ordinary_action_admission_unavailable",
      ordinaryGeneration,
    },
    headers: { "Retry-After": String(result.retryAfterSeconds) },
  };
}

function parseOrdinaryActionRequest(body: JsonRecord):
  | { input: string; pcId: string | null; actionId: string; expectedGeneration: number }
  | null {
  if (!Object.keys(body).every((key) => ["input", "pcId", "actionId", "expectedGeneration"].includes(key))) return null;
  if (typeof body.input !== "string" || !body.input.trim() || Array.from(body.input).length > 1000
    || typeof body.actionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,191}$/.test(body.actionId)
    || !Number.isSafeInteger(body.expectedGeneration) || (body.expectedGeneration as number) < 0) return null;
  if (body.pcId !== undefined && (typeof body.pcId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.pcId))) return null;
  return { input: body.input, pcId: typeof body.pcId === "string" ? body.pcId : null, actionId: body.actionId, expectedGeneration: body.expectedGeneration as number };
}

function parseOrdinaryPartyMemberCreateRequest(body: JsonRecord):
  | { actionId: string; expectedGeneration: number; operation: Extract<OrdinaryDurableOperation, { kind: "party_member_create" }> }
  | null {
  const allowed = ["name", "archetype", "personality", "backstory", "currentGoal", "actionId", "expectedGeneration"];
  if (Object.getPrototypeOf(body) !== Object.prototype || Object.getOwnPropertySymbols(body).length
    || !Object.keys(body).every((key) => allowed.includes(key))
    || !Object.hasOwn(body, "name") || !Object.hasOwn(body, "archetype") || !Object.hasOwn(body, "actionId") || !Object.hasOwn(body, "expectedGeneration")) return null;
  const descriptors = Object.getOwnPropertyDescriptors(body);
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) return null;
  const name = body.name;
  const archetype = body.archetype;
  const actionId = body.actionId;
  const expectedGeneration = body.expectedGeneration;
  if (typeof name !== "string" || name.trim() !== name || !name || Array.from(name).length > 128
    || typeof archetype !== "string" || archetype.trim() !== archetype || !archetype || Array.from(archetype).length > 128
    || typeof actionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,191}$/.test(actionId)
    || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) return null;
  const meta: Extract<OrdinaryDurableOperation, { kind: "party_member_create" }>["meta"] = {};
  for (const key of ["personality", "backstory", "currentGoal"] as const) {
    const value = body[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.trim() !== value || !value || Array.from(value).length > 4_000) return null;
      meta[key] = value;
    }
  }
  return { actionId, expectedGeneration: expectedGeneration as number, operation: { kind: "party_member_create", name, archetype, meta } };
}

function parseOrdinaryLuckSpendRequest(body: JsonRecord):
  | { actionId: string; expectedGeneration: number; operation: Extract<OrdinaryDurableOperation, { kind: "luck_spend" }> }
  | null {
  const allowed = ["amount", "actionId", "expectedGeneration"];
  if (Object.getPrototypeOf(body) !== Object.prototype || Object.getOwnPropertySymbols(body).length
    || !Object.keys(body).every((key) => allowed.includes(key))
    || !Object.hasOwn(body, "amount") || !Object.hasOwn(body, "actionId") || !Object.hasOwn(body, "expectedGeneration")) return null;
  const descriptors = Object.getOwnPropertyDescriptors(body);
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) return null;
  const amount = body.amount;
  const actionId = body.actionId;
  const expectedGeneration = body.expectedGeneration;
  if (!Number.isSafeInteger(amount) || (amount as number) <= 0
    || typeof actionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,191}$/.test(actionId)
    || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) return null;
  return { actionId, expectedGeneration: expectedGeneration as number, operation: { kind: "luck_spend", amount: amount as number } };
}

/** The one durable ordinary KP write is deliberately closed: host messages
 * cannot select a source, target, PC, visibility, or arbitrary message kind. */
export function parseOrdinaryKpMessageRequest(body: JsonRecord):
  | { actionId: string; expectedGeneration: number; operation: Extract<OrdinaryDurableOperation, { kind: "kp_message" }> }
  | null {
  const allowed = ["actionId", "expectedGeneration", "message", "speaker", "type"];
  if (Object.getPrototypeOf(body) !== Object.prototype || Object.getOwnPropertySymbols(body).length
    || !Object.keys(body).every((key) => allowed.includes(key))
    || !Object.hasOwn(body, "actionId") || !Object.hasOwn(body, "expectedGeneration") || !Object.hasOwn(body, "message")) return null;
  const descriptors = Object.getOwnPropertyDescriptors(body);
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) return null;
  const actionId = body.actionId;
  const expectedGeneration = body.expectedGeneration;
  const message = body.message;
  if (typeof actionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,191}$/.test(actionId)
    || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0
    || typeof message !== "string") return null;
  const content = message.trim();
  if (!content || Array.from(content).length > 8_000) return null;
  const rawSpeaker = body.speaker;
  let speaker: string;
  if (Object.hasOwn(body, "speaker")) {
    if (typeof rawSpeaker !== "string") return null;
    speaker = rawSpeaker.trim();
  } else speaker = "守秘人";
  if (!speaker || Array.from(speaker).length > 128) return null;
  const rawType = body.type;
  let type: string;
  if (Object.hasOwn(body, "type")) {
    if (typeof rawType !== "string") return null;
    type = rawType.trim();
  } else type = "system";
  if (type !== "system" && type !== "narration") return null;
  return {
    actionId,
    expectedGeneration: expectedGeneration as number,
    operation: { kind: "kp_message", speaker, content, type },
  };
}

/** Character body parsing is closed at both levels before it becomes an
 * authenticated operation. JSON parsing alone is not sufficient for direct
 * server callers/tests that can present accessors or prototype-bearing data. */
export function parseOrdinaryCharacterPatchRequest(body: JsonRecord):
  | { actionId: string; expectedGeneration: number; operation: Extract<OrdinaryDurableOperation, { kind: "character_patch" }> }
  | null {
  const allowed = ["actionId", "expectedGeneration", "hp", "maxHp", "skills", "inventory", "weapons", "luck", "creditRating", "attributes"];
  const closedRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) return null;
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, (descriptor as PropertyDescriptor & { value: unknown }).value]));
  };
  const root = closedRecord(body);
  if (!root || !Object.keys(root).every((key) => allowed.includes(key))
    || !Object.hasOwn(root, "actionId") || !Object.hasOwn(root, "expectedGeneration")) return null;
  const actionId = root.actionId;
  const expectedGeneration = root.expectedGeneration;
  if (typeof actionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,191}$/.test(actionId)
    || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) return null;
  const patch: Extract<OrdinaryDurableOperation, { kind: "character_patch" }> ["patch"] = {};
  for (const key of ["hp", "maxHp", "luck", "creditRating"] as const) {
    if (Object.hasOwn(root, key)) {
      const value = root[key];
      const [minimum, maximum] = key === "hp" ? [0, 999]
        : key === "maxHp" ? [1, 999]
        : [0, 99];
      if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return null;
      patch[key] = root[key] as number;
    }
  }
  if (patch.hp !== undefined && patch.maxHp !== undefined && patch.hp > patch.maxHp) return null;
  for (const key of ["skills", "attributes"] as const) {
    if (!Object.hasOwn(root, key)) continue;
    const source = closedRecord(root[key]);
    if (!source || Object.keys(source).length > 256) return null;
    const normalized: Record<string, number> = {};
    for (const [name, value] of Object.entries(source)) {
      const allowedNames = key === "skills" ? ORDINARY_CHARACTER_SKILL_KEYS : ORDINARY_CHARACTER_ATTRIBUTE_KEYS;
      const minimum = key === "skills" ? 0 : 1;
      if (!name || ORDINARY_CHARACTER_RESERVED_RECORD_KEYS.has(name) || Array.from(name).length > 128
        || !allowedNames.has(name) || !Number.isSafeInteger(value)
        || (value as number) < minimum || (value as number) > 100) return null;
      Object.defineProperty(normalized, name, { value, enumerable: true, configurable: true, writable: true });
    }
    patch[key] = normalized;
  }
  for (const key of ["inventory", "weapons"] as const) {
    if (!Object.hasOwn(root, key)) continue;
    const source = root[key];
    if (!Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype || Object.getOwnPropertySymbols(source).length || source.length > 4096) return null;
    const descriptors = Object.getOwnPropertyDescriptors(source);
    const ownNames = Object.getOwnPropertyNames(source);
    // JSON arrays cannot carry named, hidden, or accessor side channels. This
    // parser is also an exported trusted-boundary seam, so enforce that fact
    // for direct callers rather than relying on JSON.parse to erase them.
    if (ownNames.length !== source.length + 1 || !Object.hasOwn(descriptors, "length")) return null;
    const normalized: string[] = [];
    for (let index = 0; index < source.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || Array.from(descriptor.value).length > 512) return null;
      normalized.push(descriptor.value);
    }
    patch[key] = normalized;
  }
  if (Object.keys(patch).length === 0) return null;
  return { actionId, expectedGeneration: expectedGeneration as number, operation: { kind: "character_patch", patch } };
}

type OrdinaryDurableTransactionResult = { status: number; body: Record<string, unknown>; headers?: Record<string, string>; session?: GameSession };
type OrdinaryOperationRequest = { actionId: string; expectedGeneration: number; operation: OrdinaryDurableOperation; requestHash: string };
type OrdinaryOperationDerivation =
  | { status: 200 | 201; response: Record<string, unknown>; record: OrdinaryPersistedOperationRecord }
  | { status: number; body: Record<string, unknown>; headers?: Record<string, string> };
type OrdinaryOperationDeriver = (candidate: GameSession, generation: number, request: OrdinaryOperationRequest) => Promise<OrdinaryOperationDerivation>;

/**
 * Derive in an isolated career staging root, publish via envelope CAS, then
 * rehydrate a real-root replacement. The live source never receives `act()`.
 */
export async function runOrdinaryActionTransaction(
  source: GameSession,
  body: JsonRecord,
  options: OrdinaryActionTransactionOptions,
): Promise<OrdinaryDurableTransactionResult> {
  // Preserve the established input-limit status even though durable ordinary
  // actions also require an idempotency contract.  Contract validation must
  // not turn a too-large Unicode input into an ambiguous 400.
  if (typeof body.input === "string" && Array.from(body.input).length > 1000) {
    return { status: 422, body: { code: "action_input_too_long" } };
  }
  const request = parseOrdinaryActionRequest(body);
  if (!request) return { status: 400, body: { code: "ordinary_action_contract_required" } };
  const operation: OrdinaryDurableOperation = { kind: "text_action", input: request.input, pcId: request.pcId };
  return runOrdinaryOperationTransaction(source, {
    actionId: request.actionId,
    expectedGeneration: request.expectedGeneration,
    operation,
    // Text keeps its established request-hash domain so an exact retry can
    // replay an authenticated 1.4 receipt after this executor upgrade.
    requestHash: ordinaryActionRequestHash(source.id, request.actionId, request.input, request.pcId, request.expectedGeneration),
  }, options, async (candidate, generation, durableRequest) => {
    const acted = await runAction(
      candidate,
      { input: request.input, ...(request.pcId === null ? {} : { pcId: request.pcId }) },
      undefined,
      undefined,
      (input, pcId) => runOrdinaryDurableActionTransaction(
        candidate,
        options.ordinaryDurableHostCapability!,
        async (act) => act(input, pcId),
      ),
    );
    if (acted.status !== 200) {
      if (acted.status === 500 && acted.body.code === "ordinary_execution_failed") {
        return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: generation - 1 } };
      }
      return acted;
    }
    const response = JSON.parse(JSON.stringify({ ...acted.body, summary: candidate.getSummary(), sessionKind: "ordinary", ordinaryGeneration: generation })) as Record<string, unknown>;
    return {
      status: 200,
      response,
      record: {
        actionId: durableRequest.actionId,
        requestHash: durableRequest.requestHash,
        input: request.input,
        pcId: request.pcId,
        operation,
        expectedGeneration: durableRequest.expectedGeneration,
        generation,
        status: 200,
        response: response as unknown as import("./ordinary-game-session-snapshot").OrdinarySnapshotJson,
      },
    };
  });
}

/** Execute an already validated structured operation through the same durable core as text actions. */
export async function runOrdinaryPartyMemberCreateTransaction(
  source: GameSession,
  request: { actionId: string; expectedGeneration: number; operation: Extract<OrdinaryDurableOperation, { kind: "party_member_create" }> },
  options: OrdinaryActionTransactionOptions,
): Promise<OrdinaryDurableTransactionResult> {
  const durableRequest: OrdinaryOperationRequest = {
    ...request,
    requestHash: ordinaryOperationRequestHash(source.id, request.actionId, request.operation, request.expectedGeneration),
  };
  return runOrdinaryOperationTransaction(source, durableRequest, options, async (candidate, generation, operationRequest) => {
    const operation = operationRequest.operation;
    if (operation.kind !== "party_member_create") return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: generation - 1 } };
    let created: ReturnType<GameSession["addPartyMember"]>;
    try {
      created = candidate.addPartyMember(operation.name, operation.archetype, operation.meta);
    } catch {
      // Character construction failures are request-level business refusal;
      // the candidate is discarded by the shared transaction finally block.
      return { status: 400, body: { code: "ordinary_party_member_rejected", ordinaryGeneration: generation - 1 } };
    }
    if ("rejected" in created) return {
      status: 400,
      body: {
        code: "ordinary_party_member_rejected",
        ...(created.reason ? { reason: created.reason } : {}),
        ordinaryGeneration: generation - 1,
      },
    };
    const member = created.member;
    const response = JSON.parse(JSON.stringify({
      pcId: member.pcId,
      name: operation.name,
      archetype: operation.archetype,
      meta: member.meta ?? {},
      ...(created.warning ? { warning: created.warning } : {}),
      summary: candidate.getSummary(),
      sessionKind: "ordinary",
      ordinaryGeneration: generation,
    })) as Record<string, unknown>;
    return {
      status: 201,
      response,
      record: {
        actionId: operationRequest.actionId,
        requestHash: operationRequest.requestHash,
        input: "",
        pcId: null,
        operation,
        expectedGeneration: operationRequest.expectedGeneration,
        generation,
        status: 201,
        response: response as unknown as import("./ordinary-game-session-snapshot").OrdinarySnapshotJson,
      },
    };
  });
}

/** Spend Luck through the same isolated derive → CAS → hydrate runner as every ordinary durable operation. */
export async function runOrdinaryLuckSpendTransaction(
  source: GameSession,
  request: { actionId: string; expectedGeneration: number; operation: Extract<OrdinaryDurableOperation, { kind: "luck_spend" }> },
  options: OrdinaryActionTransactionOptions,
): Promise<OrdinaryDurableTransactionResult> {
  const durableRequest: OrdinaryOperationRequest = {
    ...request,
    requestHash: ordinaryOperationRequestHash(source.id, request.actionId, request.operation, request.expectedGeneration),
  };
  return runOrdinaryOperationTransaction(source, durableRequest, options, async (candidate, generation, operationRequest) => {
    const operation = operationRequest.operation;
    if (operation.kind !== "luck_spend" || !Number.isSafeInteger(operation.amount) || operation.amount <= 0) {
      return { status: 400, body: { code: "ordinary_luck_spend_rejected", ordinaryGeneration: generation - 1 } };
    }
    const before = candidate.exportOrdinarySessionSnapshot();
    const pcId = before.state.activePlayerId;
    const active = before.state.characters.find((entry) => entry.pcId === pcId);
    const sheet = active?.sheet;
    const previousLuckRaw = sheet !== null && typeof sheet === "object" && !Array.isArray(sheet) ? (sheet as Record<string, unknown>).luck : undefined;
    if (typeof previousLuckRaw !== "number" || !Number.isSafeInteger(previousLuckRaw) || previousLuckRaw < 0 || previousLuckRaw > 99) {
      return { status: 400, body: { code: "ordinary_luck_spend_rejected", ordinaryGeneration: generation - 1 } };
    }
    const previousLuck = previousLuckRaw;
    const spent = candidate.spendActiveCharacterLuck(operation.amount);
    if (spent.status === "refused") return { status: 400, body: { code: "ordinary_luck_spend_rejected", ordinaryGeneration: generation - 1 } };
    const luck = spent.character.luck;
    if (!Number.isSafeInteger(luck) || luck < 0 || luck > 99 || previousLuck - operation.amount !== luck) {
      return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: generation - 1 } };
    }
    const response = JSON.parse(JSON.stringify({
      pcId,
      amount: operation.amount,
      previousLuck,
      luck,
      summary: candidate.getSummary(),
      sessionKind: "ordinary",
      ordinaryGeneration: generation,
    })) as Record<string, unknown>;
    return {
      status: 200,
      response,
      record: {
        actionId: operationRequest.actionId,
        requestHash: operationRequest.requestHash,
        input: "",
        pcId: null,
        operation,
        expectedGeneration: operationRequest.expectedGeneration,
        generation,
        status: 200,
        response: response as unknown as import("./ordinary-game-session-snapshot").OrdinarySnapshotJson,
      },
    };
  });
}

/** Shared candidate → CAS → hydrate/install runner for all ordinary durable operations. */
/** Update the active ordinary PC only through the isolated candidate → signed
 * envelope → hydrate/install path shared with every other durable operation. */
/** Publish a host-owner announcement only through the ordinary durable
 * transaction. The private host seam keeps public sendMessage/addMessage
 * shadows outside the authoritative candidate execution path. */
export async function runOrdinaryKpMessageTransaction(
  source: GameSession,
  request: { actionId: string; expectedGeneration: number; operation: Extract<OrdinaryDurableOperation, { kind: "kp_message" }> },
  options: OrdinaryActionTransactionOptions,
): Promise<OrdinaryDurableTransactionResult> {
  const durableRequest: OrdinaryOperationRequest = {
    ...request,
    requestHash: ordinaryOperationRequestHash(source.id, request.actionId, request.operation, request.expectedGeneration),
  };
  return runOrdinaryOperationTransaction(source, durableRequest, options, async (candidate, generation, operationRequest) => {
    const operation = operationRequest.operation;
    if (operation.kind !== "kp_message") {
      return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: generation - 1 } };
    }
    let message;
    try {
      message = appendOrdinaryHostAnnouncement(
        candidate,
        options.ordinaryDurableHostCapability,
        operation.speaker,
        operation.content,
        operation.type,
      );
    } catch {
      return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: generation - 1 } };
    }
    if (message === null) {
      return { status: 409, body: { code: "ordinary_kp_message_rejected", ordinaryGeneration: generation - 1 } };
    }
    const response = JSON.parse(JSON.stringify({
      message,
      summary: candidate.getSummary(),
      sessionKind: "ordinary",
      ordinaryGeneration: generation,
    })) as Record<string, unknown>;
    return {
      status: 200,
      response,
      record: {
        actionId: operationRequest.actionId,
        requestHash: operationRequest.requestHash,
        input: "",
        pcId: null,
        operation,
        expectedGeneration: operationRequest.expectedGeneration,
        generation,
        status: 200,
        response: response as unknown as import("./ordinary-game-session-snapshot").OrdinarySnapshotJson,
      },
    };
  });
}

export async function runOrdinaryCharacterPatchTransaction(
  source: GameSession,
  request: { actionId: string; expectedGeneration: number; operation: Extract<OrdinaryDurableOperation, { kind: "character_patch" }> },
  options: OrdinaryActionTransactionOptions,
): Promise<OrdinaryDurableTransactionResult> {
  const durableRequest: OrdinaryOperationRequest = {
    ...request,
    requestHash: ordinaryOperationRequestHash(source.id, request.actionId, request.operation, request.expectedGeneration),
  };
  return runOrdinaryOperationTransaction(source, durableRequest, options, async (candidate, generation, operationRequest) => {
    const operation = operationRequest.operation;
    if (operation.kind !== "character_patch" || Object.keys(operation.patch).length === 0) {
      return { status: 400, body: { code: "ordinary_character_patch_rejected", ordinaryGeneration: generation - 1 } };
    }
    let pcId: string;
    try {
      // The candidate snapshot is the sole target selector. It is derived from
      // the durable predecessor, never from request data or a public view.
      pcId = candidate.exportOrdinarySessionSnapshot().state.activePlayerId;
    } catch {
      return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: generation - 1 } };
    }
    const patch = operation.patch;
    const updated = candidate.updateActiveCharacter({
      ...(patch.hp === undefined ? {} : { hp: patch.hp }),
      ...(patch.maxHp === undefined ? {} : { maxHp: patch.maxHp }),
      ...(patch.skills === undefined ? {} : { skillValues: patch.skills }),
      ...(patch.luck === undefined ? {} : { luck: patch.luck }),
      ...(patch.creditRating === undefined ? {} : { creditRating: patch.creditRating }),
      ...(patch.attributes === undefined ? {} : { attributes: patch.attributes }),
    });
    if (updated.status === "refused") {
      return { status: 400, body: { code: "ordinary_character_patch_rejected", ordinaryGeneration: generation - 1 } };
    }
    if (patch.inventory !== undefined && !candidate.setPlayerInventory(pcId, patch.inventory)) {
      return { status: 409, body: { code: "ordinary_character_patch_rejected", ordinaryGeneration: generation - 1 } };
    }
    if (patch.weapons !== undefined && !candidate.setPlayerWeapons(pcId, patch.weapons)) {
      return { status: 409, body: { code: "ordinary_character_patch_rejected", ordinaryGeneration: generation - 1 } };
    }
    let after;
    try { after = candidate.exportOrdinarySessionSnapshot(); }
    catch { return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: generation - 1 } }; }
    const active = after.state.characters.find((entry) => entry.pcId === pcId);
    const world = after.world.tables.player_state.find((entry) => entry.entity_id === pcId);
    if (!active) return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: generation - 1 } };
    const response = JSON.parse(JSON.stringify({
      pcId,
      character: active.sheet,
      inventory: world?.inventory ?? [],
      weapons: world?.weapons ?? [],
      summary: candidate.getSummary(),
      sessionKind: "ordinary",
      ordinaryGeneration: generation,
    })) as Record<string, unknown>;
    return {
      status: 200,
      response,
      record: {
        actionId: operationRequest.actionId,
        requestHash: operationRequest.requestHash,
        input: "",
        pcId: null,
        operation,
        expectedGeneration: operationRequest.expectedGeneration,
        generation,
        status: 200,
        response: response as unknown as import("./ordinary-game-session-snapshot").OrdinarySnapshotJson,
      },
    };
  });
}

async function runOrdinaryOperationTransaction(
  source: GameSession,
  request: OrdinaryOperationRequest,
  options: OrdinaryActionTransactionOptions,
  derive: OrdinaryOperationDeriver,
): Promise<OrdinaryDurableTransactionResult> {
  const durableHostCapability = options.ordinaryDurableHostCapability;
  if (durableHostCapability === undefined) {
    throw new Error("ordinary durable transaction requires the durable host capability");
  }
  return runOrdinaryDurableActionTransaction(source, durableHostCapability, async (_unusedAct, snapshotBeforeAction, lifecycle, sourceState) => {
    const durable = options.snapshots.read(source.id);
    if (durable.status !== "ok") return { status: 503, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
    // Every non-authoritative target (staging candidate and real-root recovery)
    // comes through the same trusted seam. The factory supplies dependencies,
    // never state: snapshot restoration remains the only state authority.
    const createPristineSession = (
      id: string,
      access: NonNullable<ConstructorParameters<typeof GameSession>[7]>,
      storage: { careerRoot?: string; sessionRoot?: string },
      runtimeDependencies: { ordinaryDurableHostCapability: object },
    ): GameSession => {
      const target = options.createPristineSession
        ? options.createPristineSession({
          id, access, storage, intentPolicy: options.intentPolicy, sessionIntentClient: options.sessionIntentClient,
          runtimeDependencies,
        })
        : createServerGameSession(id, "cosmic-horror", loadConfig(), undefined, undefined, undefined, storage, access, options.intentPolicy, options.sessionIntentClient, runtimeDependencies);
      if (!(target instanceof GameSession)) throw new Error("ordinary action factory returned an invalid pristine target");
      assertOrdinaryDurableHostCapability(target, runtimeDependencies.ordinaryDurableHostCapability);
      return target;
    };
    const restoreAuthoritative = (envelope: OrdinarySessionEnvelope): OrdinarySessionHydrationResult => restoreOrdinarySessionEnvelope(envelope, {
      sessionNamespace: options.sessionNamespace,
      storage: options.storage,
      intentPolicy: options.intentPolicy,
      createSession: (id, access, runtimeDependencies) => createPristineSession(id, access, options.storage, runtimeDependencies),
    }, options.ordinaryDurableHostCapability);
    // A close is a retirement fence for this exact source instance, not an
    // ordinary snapshot revision or a general ABA guard. Candidate work may
    // already have reached a model provider, so discard it and restore only
    // the still-authoritative durable predecessor; never execute it again.
    const recoverLatestAuthority = (): number => {
      const stale = options.sessionRegistry.get(source.id);
      if (stale === source) {
        options.sessionRegistry.delete(source.id);
        try { stale.close(); } catch { /* retired source is already unusable */ }
      }
      // The candidate can have awaited while another process committed a
      // successor. Read the pointer again after eviction: the stale gN value
      // captured on entry must never be reinstalled over that authority.
      const authority = options.snapshots.read(source.id);
      if (authority.status === "ok") {
        const recovered = restoreAuthoritative(authority.value);
        if (recovered.status === "ok" && !options.sessionRegistry.has(source.id)) {
          options.sessionRegistry.set(source.id, recovered.session);
        } else if (recovered.status === "ok") {
          recovered.session.close();
        }
        return authority.value.generation;
      }
      return durable.value.generation;
    };
    const recoverRetiredSource = () => {
      recoverLatestAuthority();
      return { status: 503 as const, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
    };
    // A source business write is neither a lifecycle retirement nor an
    // ordinary durable generation. It makes the live object non-authoritative,
    // so evict it and recover from the latest pointer before the client
    // reconciles; never publish or replay the staged candidate.
    const sourceStateChanged = () => ({
      status: 503 as const,
      body: { code: "ordinary_source_state_changed", ordinaryGeneration: recoverLatestAuthority() },
      headers: { "Retry-After": "1" },
    });
    // Capture happened after FIFO acquisition. A source closed before entry
    // while it still is the live registry value cannot provide a predecessor
    // snapshot or become a live registry value. A queued request whose old
    // source was already replaced instead reaches the established replay
    // branch below without deriving another candidate.
    if (!lifecycle.isCurrent() && options.sessionRegistry.get(source.id) === source) return recoverRetiredSource();
    const requestHash = request.requestHash;
    // The envelope's hot window is only an acceleration structure. Once an
    // action rolls out of it, the pointer-bound archive remains the durable
    // authority for both exact retries and action-ID conflicts.
    const duplicateResult = (session: GameSession | undefined, authority = durable.value) => {
      const hot = authority.idempotency.find((entry) => entry.actionId === request.actionId);
      const found = hot ? { status: "ok" as const, value: hot } : options.snapshots.findActionReceipt(source.id, request.actionId);
      if (found.status !== "ok") return { status: 503, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
      if (found.value === null) return undefined;
      if (found.value.requestHash !== requestHash) return { status: 409, body: { code: "ordinary_action_id_conflict", ordinaryGeneration: authority.generation } };
      return {
        status: found.value.status,
        body: structuredClone(found.value.response) as unknown as Record<string, unknown>,
        headers: ordinaryDuplicateHeaders(found.value.generation, authority.generation),
        session,
      };
    };
    const sourceIdentity = source.getOrdinaryDurableIdentity();
    // A request can enter the source FIFO while another process (or an older
    // queued request) replaces the registry object.  Do not try to export the
    // old source: it may have been closed, and it is no longer the durable
    // predecessor. Recover/replay from the one authoritative read instead.
    if (options.sessionRegistry.get(source.id) !== source
      || sourceIdentity === null
      || sourceIdentity.generation !== durable.value.generation
      || sourceIdentity.envelopeHash !== durable.value.envelopeHash
      || sourceIdentity.snapshotHash !== durable.value.snapshot.snapshotHash) {
      const stale = options.sessionRegistry.get(source.id);
      if (stale === source) { options.sessionRegistry.delete(source.id); stale.close(); }
      const recovered = restoreAuthoritative(durable.value);
      if (recovered.status !== "ok") {
        return { status: 503, body: { code: "ordinary_unavailable", ordinaryGeneration: durable.value.generation }, headers: { "Retry-After": "1" } };
      }
      if (recovered.status === "ok" && !options.sessionRegistry.has(source.id)) options.sessionRegistry.set(source.id, recovered.session);
      else if (recovered.status === "ok") recovered.session.close();
      const replay = duplicateResult(options.sessionRegistry.get(source.id));
      if (replay) return replay;
      return { status: 409, body: { code: "ordinary_generation_conflict", ordinaryGeneration: durable.value.generation } };
    }
    // Capture the managed Career pointer before exporting the FIFO
    // predecessor.  The prepare-time identity comparison below then catches
    // both ordinary drift and A -> B -> A content ABA that happened after
    // this capture; capturing afterwards would lose that interval.
    const realCareerStore = new CareerFileStore(ordinaryCareerSessionDirectory(source.id, options.storage));
    let careerPredecessor: CareerPortableProjectionIdentity;
    try {
      careerPredecessor = realCareerStore.capturePortableProjectionIdentity();
    } catch {
      return sourceStateChanged();
    }
    let preSnapshot;
    try { preSnapshot = snapshotBeforeAction(); }
    catch {
      return { status: 503, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
    }
    if (!ordinarySnapshotWireMatchesCurrentState(durable.value.snapshot, preSnapshot) || options.sessionRegistry.get(source.id) !== source) {
      const stale = options.sessionRegistry.get(source.id);
      if (stale === source) { options.sessionRegistry.delete(source.id); stale.close(); }
      const recovered = restoreAuthoritative(durable.value);
      if (recovered.status !== "ok") {
        return { status: 503, body: { code: "ordinary_unavailable", ordinaryGeneration: durable.value.generation }, headers: { "Retry-After": "1" } };
      }
      if (recovered.status === "ok" && !options.sessionRegistry.has(source.id)) options.sessionRegistry.set(source.id, recovered.session);
      else if (recovered.status === "ok") recovered.session.close();
      const replay = duplicateResult(options.sessionRegistry.get(source.id));
      if (replay) return replay;
      return { status: 409, body: { code: "ordinary_generation_conflict", ordinaryGeneration: durable.value.generation } };
    }
    // Exact duplicate precedes stale-generation checking: a lost response is
    // replayable even after another process installed the same durable result.
    const duplicate = duplicateResult(source);
    if (duplicate) return duplicate;
    if (request.expectedGeneration !== durable.value.generation) return { status: 409, body: { code: "ordinary_generation_conflict", ordinaryGeneration: durable.value.generation } };

    const admission = options.actionAdmission.acquire({
      sessionId: source.id,
      expectedGeneration: request.expectedGeneration,
      actionId: request.actionId,
      requestHash,
    });
    if (admission.status !== "acquired") return ordinaryActionAdmissionRefusal(admission, durable.value.generation);
    let renewalFailure: Exclude<ReturnType<typeof admission.renew>, { status: "active" }> | undefined;
    const renewalTimer = setInterval(() => {
      if (renewalFailure) return;
      const renewed = admission.renew();
      if (renewed.status !== "active") renewalFailure = renewed;
    }, admission.renewalIntervalMs);
    renewalTimer.unref?.();

    const stagingRoot = join(options.storage.careerRoot ?? join(process.cwd(), "data", "careers"), ".ordinary-action-staging", randomUUID());
    let candidate: GameSession | undefined;
    let durableCommit = false;
    let intendedEnvelope: OrdinarySessionEnvelope | undefined;
    // A successfully prepared opaque token pins both Career identities. Keep
    // a separate attempted bit because a control write may report after the
    // exact journal reached disk, in which case no token may be returned.
    let preparedCareerCommit: CareerOrdinaryProjectionCommit | undefined;
    let careerPreparationAttempted = false;
    try {
      // The SQLite lease serializes live holders, not an already-captured
      // predecessor pointer. A different process can publish gN+1 and release
      // gN between the read above and this successful acquire. Re-read while
      // holding the lease before creating a candidate or reaching a provider:
      // an old candidate must never derive from a retired durable authority.
      let postAcquireAuthority: ReturnType<OrdinarySessionSnapshotStore["read"]>;
      try {
        postAcquireAuthority = options.snapshots.read(source.id);
      } catch {
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) {
          options.sessionRegistry.delete(source.id);
          try { stale.close(); } catch { /* unavailable authority is fail-stopped */ }
        }
        return { status: 503, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
      }
      if (postAcquireAuthority.status !== "ok") {
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) {
          options.sessionRegistry.delete(source.id);
          try { stale.close(); } catch { /* unavailable authority is fail-stopped */ }
        }
        return { status: 503, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
      }
      let currentNamespaceMatches = true;
      try {
        currentNamespaceMatches = !options.sessionNamespace
          || namespaceHasCommittedIdentity(options.sessionNamespace, source.id, "ordinary", ordinaryNamespaceIdentity(postAcquireAuthority.value));
      } catch {
        currentNamespaceMatches = false;
      }
      if (!currentNamespaceMatches) {
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) {
          options.sessionRegistry.delete(source.id);
          try { stale.close(); } catch { /* unavailable authority is fail-stopped */ }
        }
        return { status: 503, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
      }
      const authorityUnchanged = postAcquireAuthority.value.generation === durable.value.generation
        && postAcquireAuthority.value.envelopeHash === durable.value.envelopeHash
        && postAcquireAuthority.value.snapshot.snapshotHash === durable.value.snapshot.snapshotHash;
      if (!authorityUnchanged) {
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) {
          options.sessionRegistry.delete(source.id);
          try { stale.close(); } catch { /* retired predecessor is never authority */ }
        }
        let recovered: OrdinarySessionHydrationResult;
        try {
          recovered = restoreAuthoritative(postAcquireAuthority.value);
        } catch {
          return { status: 503, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
        }
        if (recovered.status !== "ok") {
          return { status: 503, body: { code: "ordinary_unavailable", ordinaryGeneration: postAcquireAuthority.value.generation }, headers: { "Retry-After": "1" } };
        }
        if (!options.sessionRegistry.has(source.id)) options.sessionRegistry.set(source.id, recovered.session);
        else recovered.session.close();
        let replay: ReturnType<typeof duplicateResult>;
        try {
          replay = duplicateResult(options.sessionRegistry.get(source.id), postAcquireAuthority.value);
        } catch {
          return { status: 503, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
        }
        if (replay) return replay;
        return { status: 409, body: { code: "ordinary_generation_conflict", ordinaryGeneration: postAcquireAuthority.value.generation } };
      }
      // The source snapshot carries portable Career content, but its hash is
      // not a CAS version: a separate writer can make A -> B -> A. Capture
      // the real managed pointer identity under the Career root fence after
      // the FIFO predecessor is fixed, then require its canonical content to
      // be exactly that predecessor snapshot before any candidate work runs.
      if (preSnapshot.career.mode !== "complete") return sourceStateChanged();
       if (careerPredecessor.projectionHash !== careerPortableProjectionHash(preSnapshot.career.projection)) {
        return sourceStateChanged();
      }
      candidate = createPristineSession(source.id, durable.value.access, { careerRoot: stagingRoot }, {
        ordinaryDurableHostCapability: durableHostCapability,
      });
      candidate.restoreOrdinarySessionSnapshot(preSnapshot);
      const derived = await derive(candidate, durable.value.generation + 1, request);
      if (!lifecycle.isCurrent()) return recoverRetiredSource();
      // Candidate execution can await an injected intent provider. The source
      // remains live for synchronous KP/business writes during that interval,
      // so a successor derived from preSnapshot must fail closed on observable
      // net state drift and the source-owned non-portable ABA revisions that
      // GameSession captures at the same FIFO boundary.
      if (!sourceState.isPreActionSnapshotCurrent()) return sourceStateChanged();
      if (!("response" in derived)) {
        // A durable candidate is discarded on this normalized execution
        // failure path. Add the authoritative generation without exposing an
        // internal exception; structured action rejections retain their
        // established status/code mappings.
        if (derived.status === 500 && derived.body.code === "ordinary_execution_failed") {
          return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: durable.value.generation } };
        }
        return derived;
      }
      if (renewalFailure) return ordinaryActionAdmissionRefusal(renewalFailure, durable.value.generation);
      // The deriver returns the exact JSON wire representation. Its typed
      // record, including operation kind and HTTP status, is what archive and
      // replay authenticate.
        const response = derived.response;
        const candidateSnapshot = candidate.exportOrdinarySessionSnapshot();
        const predecessorLastActiveAt = durable.value.snapshot.session.lastActiveAt;
        if (!Number.isSafeInteger(predecessorLastActiveAt) || predecessorLastActiveAt >= Number.MAX_SAFE_INTEGER) {
          return { status: 503, body: { code: "ordinary_unavailable", ordinaryGeneration: durable.value.generation }, headers: { "Retry-After": "1" } };
        }
        // Idle cleanup is operational rather than gameplay business state, but
        // it is still snapshot authority. Advance it in the same signed
        // candidate successor—not through legacy session metadata—so the
        // rehydrated replacement cannot be immediately TTL-evicted.
        const { snapshotHash: _candidateSnapshotHash, ...candidateUnsigned } = candidateSnapshot;
        const snapshot = createOrdinaryGameSessionSnapshot({
          ...candidateUnsigned,
          session: {
            ...candidateUnsigned.session,
            lastActiveAt: Math.max(Date.now(), predecessorLastActiveAt + 1),
          },
        });
        if (snapshot.career.mode !== "complete" || careerPredecessor === undefined) {
          return { status: 503, body: { code: "ordinary_unavailable", ordinaryGeneration: durable.value.generation }, headers: { "Retry-After": "1" } };
        }
        const record = derived.record;
      const archive = nextOrdinarySessionArchive(source.id, durable.value.archive, record, snapshot);
      let replayDirectory: ReturnType<OrdinarySessionSnapshotStore["prepareOrdinaryReplayDirectory"]>;
      try {
        // This derivation reads immutable predecessor AVL nodes. Another
        // process can publish and retire that predecessor after candidate.act
        // but before this line. That is a normal CAS race, never a 500: drop
        // the stale source and recover only from the newly authoritative
        // pointer. We do not retry candidate.act (it may have model effects).
        replayDirectory = options.snapshots.prepareOrdinaryReplayDirectory(source.id, durable.value.replayDirectory, record, archive.headHash!);
      } catch {
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) {
          options.sessionRegistry.delete(source.id);
          try { stale.close(); } catch { /* fail-stopped predecessor */ }
        }
        try { candidate.close(); } catch { /* staging candidate is never authority */ }
        candidate = undefined;
        const authority = options.snapshots.read(source.id);
        if (authority.status !== "ok") return { status: 503, body: { code: "ordinary_persistence_unavailable", ordinaryGeneration: durable.value.generation }, headers: { "Retry-After": "1" } };
        const replay = options.snapshots.findActionReceipt(source.id, request.actionId);
        const recovered = restoreAuthoritative(authority.value);
        if (recovered.status !== "ok") {
          return { status: 503, body: { code: "ordinary_unavailable", ordinaryGeneration: authority.value.generation }, headers: { "Retry-After": "1" } };
        }
        if (recovered.status === "ok" && !options.sessionRegistry.has(source.id)) options.sessionRegistry.set(source.id, recovered.session);
        else if (recovered.status === "ok") recovered.session.close();
        if (replay.status === "ok" && replay.value) {
          if (replay.value.requestHash === requestHash) return {
            status: replay.value.status, body: structuredClone(replay.value.response) as Record<string, unknown>,
            headers: ordinaryDuplicateHeaders(replay.value.generation, authority.value.generation), session: options.sessionRegistry.get(source.id),
          };
          return { status: 409, body: { code: "ordinary_action_id_conflict", ordinaryGeneration: authority.value.generation } };
        }
        return { status: 409, body: { code: "ordinary_generation_conflict", ordinaryGeneration: authority.value.generation } };
      }
      const envelope = createOrdinarySessionEnvelope({
        kind: "ordinary-session-envelope",
        schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
        sessionId: source.id,
        generation: durable.value.generation + 1,
        previousEnvelopeHash: durable.value.envelopeHash,
        access: durable.value.access,
        snapshot,
        idempotency: [...durable.value.idempotency, record].slice(-ORDINARY_SESSION_IDEMPOTENCY_LIMIT),
        archive,
        replayDirectory,
      });
      intendedEnvelope = envelope;
      // The envelope keeps its original wire nested snapshot for signed
      // replay, while a live GameSession restores the validated current
      // projection (including legacy wire migration/normalization). Bind the
      // pre-staged Career successor to that exact canonical restore target,
      // while the journal separately pins the immutable envelope hash.
      const canonicalEnvelopeSnapshot = validateOrdinaryGameSessionSnapshot(envelope.snapshot);
      if (canonicalEnvelopeSnapshot.career.mode !== "complete") throw new Error("ordinary successor envelope lost its complete Career projection");
      const envelopeCareerSuccessorProjection = canonicalEnvelopeSnapshot.career.projection;
      let saved: ReturnType<OrdinarySessionSnapshotStore["save"]> = {
        status: "refused", code: "ORDINARY_SNAPSHOT_STORAGE_FAILED", message: "ordinary namespace publication did not enter the store", sessionId: source.id,
      };
      const publishEnvelope = (): ReturnType<OrdinarySessionSnapshotStore["save"]> => {
        if (options.sessionNamespace) {
          let published: ReturnType<SessionNamespaceCoordinator["publishCommitted"]> | undefined;
          try {
            published = options.sessionNamespace.publishCommitted({
              kind: "ordinary",
              sessionId: source.id,
              previousIdentity: ordinaryNamespaceIdentity(durable.value),
              nextIdentity: ordinaryNamespaceIdentity(envelope),
              publish: (permit) => {
                saved = options.snapshots.save(envelope, { permit }, options.namespacePublicationGate);
                const readback = options.snapshots.read(source.id);
                // A store can report an ambiguous close/sync only after its
                // pointer is durable.  The namespace needs the exact readback,
                // not the transport classification, to decide whether its CAS may
                // advance; the HTTP path still returns the original 503 below.
                if (readback.status === "ok" && readback.value.envelopeHash === envelope.envelopeHash && readback.value.generation === envelope.generation) {
                  return { status: "published" as const, observedIdentity: ordinaryNamespaceIdentity(readback.value) };
                }
                if (saved.status === "indeterminate") return { status: "indeterminate" as const };
                if (saved.status === "refused") return { status: "not-published" as const, failureCode: saved.code };
                return readback.status === "ok"
                  ? { status: "published" as const, observedIdentity: ordinaryNamespaceIdentity(readback.value) }
                  : { status: "indeterminate" as const };
              },
            });
          } catch (error) {
            const namespaceCode = error instanceof SessionNamespaceFailure ? error.code : undefined;
            const code: OrdinarySessionSnapshotRefusalCode = namespaceCode === "SESSION_NAMESPACE_BUSY"
              ? "ORDINARY_SNAPSHOT_BUSY"
              : namespaceCode === "SESSION_NAMESPACE_POLICY_MISMATCH"
                ? "ORDINARY_SNAPSHOT_POLICY_MISMATCH"
                : namespaceCode === "SESSION_NAMESPACE_CONFLICT" || namespaceCode === "SESSION_NAMESPACE_FENCED" || namespaceCode === "SESSION_NAMESPACE_IDENTITY_MISMATCH"
                  ? "ORDINARY_SNAPSHOT_CONFLICT"
                  : "ORDINARY_SNAPSHOT_STORAGE_FAILED";
            saved = { status: "refused", code, message: "ordinary namespace successor publication was unavailable", sessionId: source.id };
          }
          if (published && "status" in published) {
            if (published.status === "not-published") {
              const code = ordinaryPublicationFailureCode(published.failureCode) ?? "ORDINARY_SNAPSHOT_STORAGE_FAILED";
              saved = { status: "refused", code, message: "ordinary namespace successor publication was refused", sessionId: source.id };
            } else {
              saved = { status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE", message: "ordinary namespace successor publication is indeterminate", sessionId: source.id };
            }
          }
        } else {
          saved = options.snapshots.save(envelope);
        }
        return saved;
      };
      let lifecycleRetiredBeforePublication = false;
      let sourceStateChangedBeforePublication = false;
      const careerCommitInput = {
        sessionId: source.id,
        predecessorGeneration: durable.value.generation,
        predecessorEnvelopeHash: durable.value.envelopeHash,
        generation: envelope.generation,
        envelopeHash: envelope.envelopeHash,
        predecessor: careerPredecessor,
      };
      const namespaceAllows = (candidate: OrdinarySessionEnvelope): boolean => !options.sessionNamespace
        || namespaceHasCommittedIdentity(options.sessionNamespace, candidate.sessionId, "ordinary", ordinaryNamespaceIdentity(candidate));
      const currentEnvelopeAuthority = (): "successor" | "predecessor" | undefined => {
        const observed = options.snapshots.read(source.id);
        if (observed.status !== "ok" || !namespaceAllows(observed.value)) return undefined;
        if (observed.value.envelopeHash === envelope.envelopeHash && observed.value.generation === envelope.generation) return "successor";
        if (observed.value.envelopeHash === durable.value.envelopeHash && observed.value.generation === durable.value.generation) return "predecessor";
        return undefined;
      };
      const evictAndRecoverPredecessor = (): void => {
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) {
          options.sessionRegistry.delete(source.id);
          try { stale.close(); } catch { /* fail-stopped source is not authority */ }
        }
        const authority = options.snapshots.read(source.id);
        if (authority.status !== "ok" || !namespaceAllows(authority.value)
          || authority.value.envelopeHash !== durable.value.envelopeHash
          || authority.value.generation !== durable.value.generation) return;
        const recovered = restoreAuthoritative(authority.value);
        if (recovered.status === "ok" && !options.sessionRegistry.has(source.id)) options.sessionRegistry.set(source.id, recovered.session);
        else if (recovered.status === "ok") recovered.session.close();
      };
      // The durable intent is prepared under a short Career-root lock before
      // entering the ordinary publication fence.  Do not hold that root lock
      // across snapshot/namespace CAS: a process kill must leave a recoverable
      // journal rather than a permanently stale lock.
      try {
        careerPreparationAttempted = true;
        preparedCareerCommit = realCareerStore.prepareOrdinaryProjectionCommit(careerCommitInput, envelopeCareerSuccessorProjection);
      } catch (error) {
        if (error instanceof CareerProjectionPredecessorConflict) {
          // A third Career pointer before ordinary CAS makes the live source a
          // split-brain object.  Evict it even though gN remains durable;
          // predecessor-aware hydration may restore it only if Career still
          // matches, and never overwrites the third projection.
          evictAndRecoverPredecessor();
          return { status: 409, body: { code: "ordinary_career_projection_conflict", ordinaryGeneration: durable.value.generation } };
        }
        throw error;
      }
      const exactCareerCommit = preparedCareerCommit;
      if (!exactCareerCommit) throw new Error("Career ordinary commit preparation did not return its exact identity token");
      const fencedPublication = admission.withActiveFence(() => {
        // This is intentionally inside the synchronous admission/publication
        // gate. Once current, no await exists before the store write, so an
        // external close or source-state drift cannot publish a successor for
        // a retired or semantically changed source.
        if (!lifecycle.isCurrent()) {
          lifecycleRetiredBeforePublication = true;
          return saved;
        }
        if (!sourceState.isPreActionSnapshotCurrent()) {
          sourceStateChangedBeforePublication = true;
          return saved;
        }
        return publishEnvelope();
      });
      const publicationAuthority = currentEnvelopeAuthority();
      if (publicationAuthority === "successor") {
        // Exact snapshot *and* namespace authority is the commit fact.  An
        // admission/store transport may report refused or indeterminate only
        // after its callback has made that pointer durable, so never let its
        // later status rewrite this as a generation-N refusal.
        durableCommit = true;
        // If this throws, the outer catch proves successor authority and
        // returns post-commit 503/reconcile rather than a false 409.
        realCareerStore.resolveOrdinaryProjectionCommit(exactCareerCommit, "successor");
      } else if (publicationAuthority === "predecessor") {
        try {
          realCareerStore.resolveOrdinaryProjectionCommit(exactCareerCommit, "predecessor");
        } catch (error) {
          if (error instanceof CareerProjectionPredecessorConflict) {
            evictAndRecoverPredecessor();
            return { status: 409, body: { code: "ordinary_career_projection_conflict", ordinaryGeneration: durable.value.generation } };
          }
          throw error;
        }
      } else {
        // Snapshot/namespace authority is indeterminate or belongs to a third
        // envelope. Keep the exact journal fenced and stop serving source gN.
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) { options.sessionRegistry.delete(source.id); try { stale.close(); } catch { /* fail stopped */ } }
        return { status: 503, body: { code: "ordinary_post_commit_recovery_required", ordinaryGeneration: durable.value.generation }, headers: { "Retry-After": "1" } };
      }
      const publicationReportedSuccess = fencedPublication.status === "executed"
        && fencedPublication.value.status === "ok";
      if (publicationAuthority === "successor" && !publicationReportedSuccess) {
        // The predecessor fence has already resolved to the signed successor,
        // but transport settlement is not trustworthy enough to return the
        // operation response. Rehydrate only from the exact successor and ask
        // the caller to reconcile/replay its receipt at gN+1.
        try { candidate.close(); } catch { /* candidate is non-authoritative */ }
        candidate = undefined;
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) { options.sessionRegistry.delete(source.id); try { stale.close(); } catch { /* fail-stopped */ } }
        const authority = options.snapshots.read(source.id);
        if (authority.status === "ok" && !options.sessionRegistry.has(source.id)) {
          const recovered = restoreAuthoritative(authority.value);
          if (recovered.status === "ok") options.sessionRegistry.set(source.id, recovered.session);
        }
        return { status: 503, body: { code: "ordinary_post_commit_recovery_required", ordinaryGeneration: envelope.generation }, headers: { "Retry-After": "1" } };
      }
      if (lifecycleRetiredBeforePublication) return recoverRetiredSource();
      if (sourceStateChangedBeforePublication) return sourceStateChanged();
      if (fencedPublication.status === "refused") {
        return ordinaryActionAdmissionRefusal(fencedPublication, durable.value.generation);
      }
      if (fencedPublication.status === "indeterminate" && fencedPublication.value === undefined) {
        return ordinaryActionAdmissionRefusal(fencedPublication, durable.value.generation);
      }
      saved = fencedPublication.value!;
      if (saved.status !== "ok") {
        // The store may have published the pointer before reporting an
        // indeterminate sync/close failure. Fail-stop and re-read *before*
        // candidate cleanup: cleanup itself is allowed to fail and is never a
        // reason to keep a potentially stale predecessor live.
        try { candidate.close(); } catch { /* candidate is non-authoritative */ }
        candidate = undefined;
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) { options.sessionRegistry.delete(source.id); try { stale.close(); } catch { /* fail-stopped */ } }
        const authority = options.snapshots.read(source.id);
        const recovered = authority.status === "ok" ? restoreAuthoritative(authority.value) : authority;
        if (recovered.status === "ok" && !options.sessionRegistry.has(source.id)) options.sessionRegistry.set(source.id, recovered.session);
        else if (recovered.status === "ok") recovered.session.close();
        const refused = saved.status === "refused" ? saved : undefined;
        const status = refused?.code === "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED" ? 507
          : refused?.code === "ORDINARY_SNAPSHOT_CONFLICT" || refused?.code === "ORDINARY_SNAPSHOT_NAMESPACE_FENCED" ? 409
            : saved.status === "indeterminate" || refused?.code === "ORDINARY_SNAPSHOT_BUSY" ? 503 : 500;
        return { status, body: { code: saved.status === "indeterminate" ? "ordinary_persistence_indeterminate" : "ordinary_persistence_unavailable", ordinaryGeneration: durable.value.generation }, ...(status === 503 ? { headers: { "Retry-After": "1" } } : {}) };
      }
      durableCommit = true;
      candidate.close(); candidate = undefined;
      try { if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* stale staging files are non-authoritative */ }
      const replacement = hydrateOrdinarySession(source.id, {
        snapshots: options.snapshots,
        sessionNamespace: options.sessionNamespace,
        storage: options.storage,
        intentPolicy: options.intentPolicy,
        createSession: (id, access, runtimeDependencies) => createPristineSession(id, access, options.storage, runtimeDependencies),
      });
      if (replacement.status !== "ok") {
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) { options.sessionRegistry.delete(source.id); stale.close(); }
        return { status: 503, body: { code: "ordinary_unavailable" }, headers: { "Retry-After": "1" } };
      }
      if (options.sessionRegistry.get(source.id) !== source) {
        replacement.session.close();
        return { status: 409, body: { code: "ordinary_registry_replaced", ordinaryGeneration: durable.value.generation + 1 } };
      }
      options.sessionRegistry.set(source.id, replacement.session); source.close();
      return { status: derived.status, body: response, headers: { "X-Ordinary-Action-Disposition": "committed" }, session: replacement.session };
    } catch (error) {
      log.error("ordinary-session", "ordinary action derive/persist failed", error);
      // Career installation is deliberately after the ordinary pointer write
      // but remains under its own root fence. A thrown Career publication can
      // therefore occur after `save()` made this envelope authoritative. Do
      // not report that state as a failed pre-commit: prove the pointer, then
      // run the same predecessor-aware recovery path below.
      if (!durableCommit && intendedEnvelope !== undefined) {
        const authority = options.snapshots.read(source.id);
        durableCommit = authority.status === "ok"
          && authority.value.envelopeHash === intendedEnvelope.envelopeHash
          && authority.value.generation === intendedEnvelope.generation
          && (!options.sessionNamespace || namespaceHasCommittedIdentity(
            options.sessionNamespace,
            authority.value.sessionId,
            "ordinary",
            ordinaryNamespaceIdentity(authority.value),
          ));
      }
      if (durableCommit) {
        // `save() === ok` is the commit point. A close/rehydrate/install
        // exception after it may not leave the predecessor reachable. Drop
        // only that exact stale source, then rebuild from the authoritative
        // pointer before asking the client to retry/reconcile.
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) {
          options.sessionRegistry.delete(source.id);
          try { stale.close(); } catch { /* eviction remains authoritative */ }
        }
        const authority = options.snapshots.read(source.id);
        if (authority.status === "ok" && !options.sessionRegistry.has(source.id)) {
          const recovered = restoreAuthoritative(authority.value);
          if (recovered.status === "ok") options.sessionRegistry.set(source.id, recovered.session);
        }
        return { status: 503, body: { code: "ordinary_post_commit_recovery_required", ordinaryGeneration: durable.value.generation + 1 }, headers: { "Retry-After": "1" } };
      }
      if (preparedCareerCommit !== undefined) {
        // Preparation can have persisted the writer fence even though the
        // ordinary CAS callback subsequently threw. Only the exact current
        // snapshot+namespace predecessor may cancel it. Anything else is
        // deliberately fail-stopped with the journal retained for recovery.
        const authority = options.snapshots.read(source.id);
        const predecessorIsAuthoritative = authority.status === "ok"
          && authority.value.envelopeHash === preparedCareerCommit.predecessorEnvelopeHash
          && authority.value.generation === preparedCareerCommit.predecessorGeneration
          && (!options.sessionNamespace || namespaceHasCommittedIdentity(
            options.sessionNamespace,
            authority.value.sessionId,
            "ordinary",
            ordinaryNamespaceIdentity(authority.value),
          ));
        let cancelled = false;
        if (predecessorIsAuthoritative) {
          try {
            realCareerStore.resolveOrdinaryProjectionCommit(preparedCareerCommit, "predecessor");
            cancelled = true;
          } catch {
            // A third Career root or a damaged intent stays fenced. It must
            // not be hidden by restoring the source object from gN.
          }
        }
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) {
          options.sessionRegistry.delete(source.id);
          try { stale.close(); } catch { /* fail stopped */ }
        }
        if (cancelled && authority.status === "ok" && !options.sessionRegistry.has(source.id)) {
          const recovered = restoreAuthoritative(authority.value);
          if (recovered.status === "ok") {
            if (!options.sessionRegistry.has(source.id)) options.sessionRegistry.set(source.id, recovered.session);
            else recovered.session.close();
          }
        }
        return {
          status: 503,
          body: {
            code: cancelled ? "ordinary_persistence_unavailable" : "ordinary_persistence_indeterminate",
            ordinaryGeneration: durable.value.generation,
          },
          headers: { "Retry-After": "1" },
        };
      }
      if (careerPreparationAttempted) {
        // A prepare call that did not return its exact token may have left an
        // fsync-ambiguous journal. No ordinary CAS was proven, but the exact
        // predecessor envelope can still safely adjudicate that unknown
        // staged successor through the journal's own predecessor identity.
        // Do not manufacture a token from untrusted marker data.
        const authority = options.snapshots.read(source.id);
        const predecessorIsAuthoritative = authority.status === "ok"
          && authority.value.envelopeHash === durable.value.envelopeHash
          && authority.value.generation === durable.value.generation
          && (!options.sessionNamespace || namespaceHasCommittedIdentity(
            options.sessionNamespace,
            authority.value.sessionId,
            "ordinary",
            ordinaryNamespaceIdentity(authority.value),
          ));
        let cancelled = false;
        if (predecessorIsAuthoritative && preSnapshot.career.mode === "complete") {
          try {
            realCareerStore.reconcileOrdinaryProjection({
              sessionId: source.id,
              generation: durable.value.generation,
              envelopeHash: durable.value.envelopeHash,
            }, preSnapshot.career.projection);
            cancelled = true;
          } catch {
            // Missing/damaged/third-root evidence stays fail-closed.
          }
        }
        const stale = options.sessionRegistry.get(source.id);
        if (stale === source) {
          options.sessionRegistry.delete(source.id);
          try { stale.close(); } catch { /* fail stopped */ }
        }
        if (cancelled && authority.status === "ok" && !options.sessionRegistry.has(source.id)) {
          const recovered = restoreAuthoritative(authority.value);
          if (recovered.status === "ok") {
            if (!options.sessionRegistry.has(source.id)) options.sessionRegistry.set(source.id, recovered.session);
            else recovered.session.close();
          }
        }
        return {
          status: 503,
          body: { code: cancelled ? "ordinary_persistence_unavailable" : "ordinary_persistence_indeterminate", ordinaryGeneration: durable.value.generation },
          headers: { "Retry-After": "1" },
        };
      }
      return { status: 500, body: { code: "ordinary_execution_or_persistence_failed", ordinaryGeneration: durable.value.generation } };
    } finally {
      clearInterval(renewalTimer);
      admission.release();
      try { candidate?.close(); } catch { /* a candidate is never authority */ }
      try { if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* staging is never authority */ }
    }
  });
}

/** Shared durable commit/install transaction for the structured and text-codec routes. */
export async function runCompiledActionTransaction(
  session: GameSession,
  body: JsonRecord,
  options: CompiledActionTransactionOptions,
): Promise<{ status: number; body: Record<string, unknown>; headers?: Record<string, string>; session?: GameSession }> {
  const createRecoverySession = (id: string): GameSession => {
    const session = options.createRecoverySession
    ? options.createRecoverySession({ id, storage: options.storage })
    : createServerGameSession(
      id,
      "cosmic-horror",
      loadConfig(),
      undefined,
      undefined,
      undefined,
      options.storage,
      undefined,
      undefined,
      undefined,
      { compiledDurableHostCapability: options.compiledDurableHostCapability },
    );
    assertCompiledDurableHostCapability(session, options.compiledDurableHostCapability);
    return session;
  };
  assertCompiledDurableHostCapability(session, options.compiledDurableHostCapability);
  const persistSnapshot = (snapshot: CompiledSessionSnapshot): void => {
    let saved: ReturnType<CompiledSessionSnapshotStore["save"]> = {
      status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: "compiled namespace publication did not enter the store", sessionId: snapshot.sessionId,
    };
    if (options.sessionNamespace) {
      if (snapshot.generation < 1 || snapshot.previousSnapshotHash === null) {
        throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_CONFLICT", "compiled successor lacks an exact predecessor identity");
      }
      let published: ReturnType<SessionNamespaceCoordinator["publishCommitted"]>;
      try {
        published = options.sessionNamespace.publishCommitted({
          kind: "compiled",
          sessionId: snapshot.sessionId,
          previousIdentity: {
            hash: snapshot.previousSnapshotHash,
            generation: snapshot.generation - 1,
            format: COMPILED_SESSION_NAMESPACE_IDENTITY_FORMAT,
          },
          nextIdentity: compiledNamespaceIdentity(snapshot),
          publish: (permit) => {
            saved = options.snapshots.save(snapshot, { permit }, options.namespacePublicationGate);
            const readback = options.snapshots.read(snapshot.sessionId);
            if (readback.status === "ok" && readback.value && typeof readback.value === "object") {
              const observed = readback.value as CompiledSessionSnapshot;
              if (observed.snapshotHash === snapshot.snapshotHash && observed.generation === snapshot.generation) {
                return { status: "published" as const, observedIdentity: compiledNamespaceIdentity(observed) };
              }
            }
            return saved.status === "indeterminate"
              ? { status: "indeterminate" as const }
              : { status: "not-published" as const, ...(saved.status === "refused" ? { failureCode: saved.code } : {}) };
          },
        });
      } catch (error) {
        if (error instanceof SessionNamespaceFailure
          && (error.code === "SESSION_NAMESPACE_CONFLICT" || error.code === "SESSION_NAMESPACE_IDENTITY_MISMATCH" || error.code === "SESSION_NAMESPACE_FENCED")) {
          throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_CONFLICT", "compiled namespace successor is stale or fenced");
        }
        throw error;
      }
      if ("status" in published) {
        if (published.status === "not-published" && published.failureCode) {
          throw new CompiledSessionSnapshotPersistenceError(published.failureCode as CompiledSessionSnapshotPersistenceError["code"], "compiled snapshot publication was refused");
        }
        throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_INDETERMINATE", "compiled namespace successor publication is indeterminate");
      }
    } else {
      saved = options.snapshots.save(snapshot);
    }
    if (saved.status !== "ok") throw new CompiledSessionSnapshotPersistenceError(saved.code, saved.message);
  };
  const installSnapshot = (snapshot: CompiledSessionSnapshot): GameSession => {
    const restore = (authoritativeSnapshot: CompiledSessionSnapshot) => {
      if (options.sessionNamespace && !namespaceHasCommittedIdentity(
        options.sessionNamespace,
        authoritativeSnapshot.sessionId,
        "compiled",
        compiledNamespaceIdentity(authoritativeSnapshot),
      )) {
        throw new Error("compiled snapshot is not the committed runtime namespace identity");
      }
      const bundle = options.catalog.loadBundle(authoritativeSnapshot.bundle.id);
      if (bundle.status === "refused") throw new Error(bundle.message);
      const replacement = createRecoverySession(authoritativeSnapshot.sessionId);
      const restored = replacement.restoreCompiledSession(authoritativeSnapshot, bundle.value);
      if (restored.status === "refused") {
        replacement.close();
        throw new Error(restored.message);
      }
      const previous = options.sessionRegistry.get(authoritativeSnapshot.sessionId);
      options.sessionRegistry.set(authoritativeSnapshot.sessionId, replacement);
      if (previous && previous !== replacement) previous.close();
      options.diagnostics.delete(authoritativeSnapshot.sessionId);
      return replacement;
    };
    try {
      return restore(snapshot);
    } catch (firstError) {
      // The persisted generation is authoritative. Remove the fail-stopped old object,
      // then make one clean-object recovery attempt before reporting unavailability.
      const stale = options.sessionRegistry.get(snapshot.sessionId);
      options.sessionRegistry.delete(snapshot.sessionId);
      stale?.close();
      try {
        return restore(snapshot);
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : "compiled session could not be rehydrated";
        options.diagnostics.set(snapshot.sessionId, { id: snapshot.sessionId, code: "compiled_unavailable", message });
        throw firstError;
      }
    }
  };
  const recoverCompiledPersistence = (): GameSession | undefined => {
    // A conflict, busy result, or ambiguous post-publish failure leaves the
    // old GameSession stale. Drop it first, then rebuild only from the header
    // which is authoritative on disk; no candidate snapshot/hash crosses the
    // HTTP boundary.
    const stale = options.sessionRegistry.get(session.id);
    options.sessionRegistry.delete(session.id);
    stale?.close();
    const raw = options.snapshots.read(session.id);
    if (raw.status !== "ok") throw new Error(raw.message);
    const authoritative = raw.value as CompiledSessionSnapshot;
    if (options.sessionNamespace && !namespaceHasCommittedIdentity(
      options.sessionNamespace,
      authoritative.sessionId,
      "compiled",
      compiledNamespaceIdentity(authoritative),
    )) {
      // The store may have reached gN+1 after a lost namespace acknowledgement.
      // It is not an installable recovery target until the namespace agrees.
      return undefined;
    }
    const bundle = options.catalog.loadBundle(authoritative.bundle.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);
    const replacement = createRecoverySession(authoritative.sessionId);
    const restored = replacement.restoreCompiledSession(authoritative, bundle.value);
    if (restored.status !== "loaded") {
      replacement.close();
      throw new Error(restored.message);
    }
    options.sessionRegistry.set(authoritative.sessionId, replacement);
    options.diagnostics.delete(authoritative.sessionId);
    return replacement;
  };
  if (options.narration) {
    return runCompiledNarratedActionTransaction(session, body, options, {
      persistSnapshot,
      installSnapshot,
      recoverCompiledPersistence,
    });
  }
  return runAction(
    session,
    body,
    persistSnapshot,
    installSnapshot,
    undefined,
    recoverCompiledPersistence,
    options.compiledDurableHostCapability,
  );
}

type CompiledNarrationPersistence = {
  persistSnapshot: (snapshot: CompiledSessionSnapshot) => void;
  installSnapshot: (snapshot: CompiledSessionSnapshot) => GameSession;
  recoverCompiledPersistence: () => GameSession | undefined;
};

function narrationRequestFromBody(
  session: GameSession,
  body: JsonRecord,
): { status: "ok"; input: string; actionId: string; expectedGeneration: number; generation: number }
  | { status: "refused"; response: { status: number; body: Record<string, unknown> } } {
  let generation: number | null;
  try { generation = session.getCompiledGeneration(); }
  catch { return { status: "refused", response: { status: 503, body: { code: "compiled_unavailable" } } }; }
  if (generation === null || !Object.keys(body).every((key) => ["input", "pcId", "actionId", "expectedGeneration"].includes(key))) {
    return { status: "refused", response: { status: 400, body: { code: "compiled_action_contract_required", generation } } };
  }
  const input = (bodyString(body, "input") ?? "").trim();
  const pcId = (bodyString(body, "pcId") ?? "").trim();
  const actionId = (bodyString(body, "actionId") ?? "").trim();
  const expectedGeneration = body.expectedGeneration;
  if (pcId !== "p1") return { status: "refused", response: { status: 409, body: { code: "compiled_single_pc_required", generation } } };
  if (!input) return { status: "refused", response: { status: 400, body: { code: "compiled_action_required", generation } } };
  if (!actionId || !Number.isSafeInteger(expectedGeneration) || (expectedGeneration as number) < 0) {
    return { status: "refused", response: { status: 400, body: { code: "compiled_action_contract_required", generation } } };
  }
  return { status: "ok", input, actionId, expectedGeneration: expectedGeneration as number, generation };
}

function candidateMatchesNarrationRequest(
  candidate: CompiledNarrationCandidate,
  request: { input: string; actionId: string; expectedGeneration: number },
  playerRequestHash?: string,
  playerTopic?: CompiledPlayerNarrationTopicRequest,
): boolean {
  const record = candidate.snapshot.idempotency.at(-1);
  return candidate.actionId === request.actionId
    && candidate.expectedGeneration === request.expectedGeneration
    && candidate.nextGeneration === request.expectedGeneration + 1
    && record?.actionId === request.actionId
    && record.input === request.input
    && record.expectedGeneration === request.expectedGeneration
    && (playerRequestHash === undefined || candidate.playerRequestHash === playerRequestHash)
    && (playerTopic === undefined || (candidate.schemaVersion === "2.0.0"
      && sameOpaquePlayerHash(candidate.topicTokenHash, compiledPlayerNarrationTopicTokenHash(playerTopic.topicBound))));
}

function compiledNarrationAdmissionRequestHash(request: { input: string; actionId: string; expectedGeneration: number }): string {
  return createHash("sha256").update(JSON.stringify({
    domain: "compiled-player-narration-admission-request-v1",
    input: request.input,
    actionId: request.actionId,
    expectedGeneration: request.expectedGeneration,
  }), "utf8").digest("hex");
}

function narratedActionBody(response: ActionResponse | { action: Record<string, unknown>; summary: Record<string, unknown>; generation: number }): Record<string, unknown> {
  const persisted = response as { action?: Record<string, unknown>; summary?: Record<string, unknown>; generation?: number };
  return { ...(persisted.action ?? {}), summary: persisted.summary ?? {}, generation: persisted.generation };
}

/**
 * Provider narration is a receipt attached to a precomputed mechanics
 * successor. It deliberately does not reuse the intent-replay store: a
 * `dispatching` row may hide an unobservable provider result and is therefore
 * quarantined, whereas a durable `receipt` is safe to consume exactly once by
 * the normal snapshot CAS without making another provider call.
 */
async function runCompiledNarratedActionTransaction(
  session: GameSession,
  body: JsonRecord,
  options: CompiledActionTransactionOptions,
  persistence: CompiledNarrationPersistence,
): Promise<{ status: number; body: Record<string, unknown>; headers?: Record<string, string>; session?: GameSession }> {
  const narration = options.narration;
  if (!narration) return { status: 503, body: { code: "compiled_narration_unavailable" }, headers: { "Retry-After": "1" } };
  const parsed = narrationRequestFromBody(session, body);
  if (parsed.status === "refused") return parsed.response;
  const request = parsed;
  const unavailable = (code: string, status = 503) => ({ status, body: { code, generation: request.generation }, ...(status === 503 ? { headers: { "Retry-After": "1" } } : {}) });
  const installCommitted = (candidate: CompiledNarrationCandidate, text: { schemaVersion: "1.0.0"; text: string }, fenced?: { withActiveFence: <T>(operation: () => T) => { status: string; value?: T } }) => {
    let committed: ReturnType<typeof commitCompiledDurableNarration> | undefined;
    const invoke = () => commitCompiledDurableNarration(session, options.compiledDurableHostCapability, candidate, text, persistence.persistSnapshot);
    if (fenced) {
      const outcome = fenced.withActiveFence(invoke);
      if (outcome.status !== "executed" || !outcome.value) return { status: "unavailable" as const };
      committed = outcome.value;
    } else {
      committed = invoke();
    }
    if (committed.status === "refused") return { status: "refused" as const, code: committed.code, generation: committed.generation };
    if (committed.status === "duplicate") return { status: "duplicate" as const, response: committed.response, session };
    if (!committed.snapshot) return { status: "unavailable" as const };
    try {
      return { status: "committed" as const, response: committed.response, session: persistence.installSnapshot(committed.snapshot) };
    } catch {
      // Snapshot publication is authoritative even if the live install lost a
      // race. This is a known durable receipt, not an unknown provider call:
      // preserve it and make one read-back recovery attempt before returning
      // an unavailable result.
      try {
        const recovered = persistence.recoverCompiledPersistence();
        if (recovered) return { status: "committed" as const, response: committed.response, session: recovered };
      } catch { /* receipt remains recoverable on a later exact retry */ }
      return { status: "published" as const, response: committed.response };
    }
  };

  let existing = narration.ledger.read(session.id, request.actionId);
  if (existing.status === "refused") return unavailable("compiled_narration_unavailable");
  if (existing.status === "ok") {
    if (!candidateMatchesNarrationRequest(existing.value.candidate, request, narration.playerRequestHash, narration.playerTopic)) return unavailable("compiled_idempotency_conflict", 409);
    if (existing.value.state === "receipt" || existing.value.state === "committed") {
      const receipt = existing.value.narration;
      if (!receipt) return unavailable("compiled_narration_unavailable");
      // Receipt recovery intentionally does not acquire/take over a provider
      // lease. No provider call is possible here, and the existing namespace
      // + predecessor CAS decides the sole publication.
      const consumed = installCommitted(existing.value.candidate, receipt);
      if (consumed.status === "committed" || consumed.status === "duplicate") {
        narration.ledger.markCommitted(existing.value.candidate);
        return { status: 200, body: narratedActionBody(consumed.response), session: consumed.session };
      }
      if (consumed.status === "published") return unavailable("compiled_narration_unavailable");
      return unavailable(consumed.status === "refused" ? consumed.code : "compiled_narration_unavailable");
    }
    // `prepared` has proof no provider dispatch began; `dispatching` and an
    // explicit quarantine have no such proof and may never be redelivered.
    if (existing.value.state !== "prepared") return unavailable("compiled_narration_unavailable");
  }

  const admissionRequestHash = compiledNarrationAdmissionRequestHash(request);
  let lease = narration.admission.acquire({ sessionId: session.id, expectedGeneration: request.expectedGeneration, actionId: request.actionId, requestHash: admissionRequestHash });
  if (lease.status !== "acquired" && existing.status === "ok" && existing.value.state === "prepared"
    && validateCompiledDurableNarrationCandidate(session, options.compiledDurableHostCapability, existing.value.candidate)
    && narration.admission.recoverPrepared({
      sessionId: session.id,
      expectedGeneration: request.expectedGeneration,
      actionId: request.actionId,
      requestHash: admissionRequestHash,
    })) {
    lease = narration.admission.acquire({ sessionId: session.id, expectedGeneration: request.expectedGeneration, actionId: request.actionId, requestHash: admissionRequestHash });
  }
  if (lease.status !== "acquired") return unavailable("compiled_narration_unavailable");
  let retainLease = false;
  let leaseLost = false;
  const abort = new AbortController();
  const abortRequest = () => abort.abort();
  narration.signal?.addEventListener("abort", abortRequest, { once: true });
  const renewal = setInterval(() => {
    const renewed = lease.renew();
    if (renewed.status !== "active") {
      leaseLost = true;
      abort.abort();
    }
  }, lease.renewalIntervalMs);
  try {
    // Re-read after admission closes the miss-to-lease race without granting a
    // contender any right to resend a possibly-dispatched provider request.
    existing = narration.ledger.read(session.id, request.actionId);
    if (existing.status === "refused") return unavailable("compiled_narration_unavailable");
    let candidate: CompiledNarrationCandidate;
    if (existing.status === "ok") {
      if (!candidateMatchesNarrationRequest(existing.value.candidate, request, narration.playerRequestHash, narration.playerTopic) || existing.value.state !== "prepared") {
        return unavailable("compiled_narration_unavailable");
      }
      candidate = existing.value.candidate;
    } else {
      const prepared = prepareCompiledDurableNarration(
        session,
        options.compiledDurableHostCapability,
        request.input,
        request.actionId,
        request.expectedGeneration,
        narration.playerRequestHash,
        narration.playerTopic,
      );
      if (prepared.status === "duplicate") return { status: 200, body: narratedActionBody(prepared.response), session };
      if (prepared.status === "refused") return unavailable(prepared.code, prepared.code === "compiled_action_contract_required" ? 400 : 409);
      candidate = prepared.candidate;
      const saved = narration.ledger.savePrepared(candidate);
      if (saved.status === "refused") {
        retainLease = true;
        lease.quarantine();
        return unavailable("compiled_narration_unavailable");
      }
      if (!candidateMatchesNarrationRequest(saved.value.candidate, request, narration.playerRequestHash, narration.playerTopic)) {
        retainLease = true;
        lease.quarantine();
        return unavailable("compiled_idempotency_conflict", 409);
      }
      candidate = saved.value.candidate;
    }
    if (!validateCompiledDurableNarrationCandidate(session, options.compiledDurableHostCapability, candidate)) {
      retainLease = true;
      narration.ledger.quarantine(candidate);
      lease.quarantine();
      return unavailable("compiled_narration_unavailable");
    }
    if (narration.signal?.aborted || leaseLost || session.getCompiledGeneration() !== request.expectedGeneration) {
      retainLease = true;
      narration.ledger.quarantine(candidate);
      lease.quarantine();
      return unavailable("compiled_narration_unavailable");
    }
    // The durable transition that authorizes a provider call is itself fence
    // checked. A stalled renewal timer can never leave an expired worker free
    // to mark dispatching and call the model.
    const dispatch = lease.withActiveFence(() => narration.ledger.markDispatching(candidate));
    if (dispatch.status !== "executed" || !dispatch.value || dispatch.value.status === "refused") {
      retainLease = true;
      narration.ledger.quarantine(candidate);
      lease.quarantine();
      return unavailable("compiled_narration_unavailable");
    }
    if (!narration.llm) {
      // A disabled/reconfigured model may consume a durable receipt above,
      // but it can never begin a new provider-backed turn.
      retainLease = true;
      narration.ledger.quarantine(candidate);
      lease.quarantine();
      return unavailable("compiled_narration_unavailable");
    }
    const generated = await narrateCompiledPlayerCandidate({
      candidate,
      llm: narration.llm,
      signal: abort.signal,
      ...(narration.playerTopic ? { playerInput: narration.playerTopic.playerInput } : {}),
    });
    if (generated.status !== "accepted" || narration.signal?.aborted || leaseLost || session.getCompiledGeneration() !== request.expectedGeneration) {
      retainLease = true;
      narration.ledger.quarantine(candidate);
      lease.quarantine();
      return unavailable(generated.status === "invalid" ? "compiled_narration_invalid" : "compiled_narration_unavailable", generated.status === "invalid" ? 422 : 503);
    }
    // Parsing proves only the narrow JSON wire.  The durable host now
    // re-derives candidate visibility/era from its private trusted bundle
    // before a provider sentence may become a receipt or snapshot.
    if (!validateCompiledDurableNarrationText(session, options.compiledDurableHostCapability, candidate, generated.narration)) {
      retainLease = true;
      narration.ledger.quarantine(candidate);
      lease.quarantine();
      return unavailable("compiled_narration_invalid", 422);
    }
    // The receipt is persisted only while the generation lease's fence is
    // active. Once this succeeds, crash recovery may consume it without any
    // provider takeover.
    const receiptWrite = lease.withActiveFence(() => narration.ledger.saveReceipt(candidate, generated.narration));
    if (receiptWrite.status !== "executed" || !receiptWrite.value || receiptWrite.value.status === "refused") {
      retainLease = true;
      narration.ledger.quarantine(candidate);
      lease.quarantine();
      return unavailable("compiled_narration_unavailable");
    }
    const committed = installCommitted(candidate, generated.narration, lease);
    if (committed.status === "committed" || committed.status === "duplicate") {
      narration.ledger.markCommitted(candidate);
      return { status: 200, body: narratedActionBody(committed.response), session: committed.session };
    }
    // The provider result and matching receipt are durable. Do not downgrade
    // that recoverable state to `quarantined` merely because live installation
    // failed after the snapshot CAS; a retry consumes the same receipt.
    if (committed.status === "published") return unavailable("compiled_narration_unavailable");
    // A durable receipt makes every post-receipt CAS/fence/storage failure a
    // recoverable publication problem, not an unknown provider outcome. Keep
    // the receipt for the exact same-candidate retry; only the lease remains
    // quarantined until its ordinary recovery policy permits release.
    retainLease = true;
    lease.quarantine();
    return unavailable(committed.status === "refused" ? committed.code : "compiled_narration_unavailable");
  } catch {
    retainLease = true;
    try { lease.quarantine(); } catch { /* uncertainty must retain the durable fence */ }
    return unavailable("compiled_narration_unavailable");
  } finally {
    clearInterval(renewal);
    narration.signal?.removeEventListener("abort", abortRequest);
    if (!retainLease) lease.release();
  }
}

/**
 * 广播一次 action 的结果——按连接分别算该发什么，不是发一份 msg 给
 * session 里所有连接（那正是 todo-25 的漏洞：存储层按玩家过滤，
 * 推送层原先不过滤）。
 *
 * KP/observer 连接：与改动前行为一致，收完整的 ar（KP 本来就该知道
 * 一切，`PlayerSession.push` 的注释里写的是同一条纪律——KP 记录全局
 * 日志）。
 *
 * player 连接：只发"这一回合里，这个 pcId 的 messageHistory 新增了
 * 什么"——直接读 `session.getPlayerHistory(pcId)`，这正是 GET
 * /history?pcId= 已经在用、且被 clue-visibility-and-per-player-history
 * .test.ts 验证过的同一条存储层过滤路径，不重新判定一次可见性。
 * `priorCounts` 是调用方在 `session.act()` 之前拍的快照（此后这个
 * pcId 的历史只会变长，slice 那一段就是这一回合新增的）；没有新增
 * 内容（比如这回合的可见结果只发给了另一个 pcId）时返回 undefined，
 * 这个连接本轮完全不收到东西，不是收一个空 narrative。
 *
 * playerId 未知/连接没声明 playerId：fail-closed，不发——不能因为
 * "不知道该给他看哪部分"就干脆给他看全部。
 */
export function broadcastActionResult(
  sessionId: string,
  session: GameSession,
  priorCounts: Map<string, number>,
  ar: ActionResponse,
): void {
  // Current ordinary ActionResponse values carry terminal explicitly, with
  // `null` meaning the session remains live.  Preserve that discriminant for
  // every receiver without deriving a value from mutable live state: an old
  // response that lacks the field remains old, and compiled responses never
  // acquire ordinary terminal metadata.
  const ordinaryTerminal = session.getCompiledGeneration() === null && ar.terminal !== undefined
    ? { terminal: ar.terminal }
    : {};
  broadcastPerConnection(sessionId, "action-result", (client) => {
    if (client.role === "kp" || client.role === "observer") {
      return { narrative: ar.narrative, events: ar.events, state: ar.state, dead: ar.dead, sanity: ar.sanity, dice: ar.dice, ...ordinaryTerminal };
    }
    // role === "player"
    if (!client.playerId || !session.session.get(client.playerId)) return undefined;
    const before = priorCounts.get(client.playerId) ?? 0;
    const fresh = session.getPlayerHistory(client.playerId).messages.slice(before);
    if (fresh.length === 0) return undefined;
    return {
      narrative: fresh.map((m: any) => m.content as string).join("\n"),
      events: fresh.map((m: any) => ({
        speaker: m.speaker as string,
        content: m.content as string,
        type: m.type as MessageType,
        ...(m.verbatim ? { verbatim: true as const } : {}),
      })),
      state: ar.state, dead: ar.dead, sanity: ar.sanity, dice: ar.dice, ...ordinaryTerminal,
    };
  });
}

/**
 * GET /suggestions 的核心（可直接单测，无需真的绑 HTTP 端口）。
 *
 * `pcId` 可选：不传保持旧行为，getSuggestions() 读取 activePlayerId；传了则
 * 只为读取该 PC 私密的未发现线索状态，不切换会话活跃 PC。未知值不能静默
 * 回空 suggestions——那和“这个 PC 在空场景里确实没有建议”对外完全一样，
 * 与 /history?pcId= 同口径明确 404。
 */
export function runSuggestions(
  session: GameSession,
  rawPcId: string | null,
): { status: number; body: Record<string, unknown> } {
  const pcId = rawPcId?.trim() || undefined;
  if (pcId && !session.session.get(pcId)) {
    return { status: 404, body: { error: `未知 pcId: ${pcId}` } };
  }
  return { status: 200, body: { suggestions: session.getSuggestions(pcId) } };
}

// ============================================================
// 测试页 // ============================================================

function serveTestPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Narrator — 测试客户端</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; min-height: 100vh; display: flex; flex-direction: column; }
  #app { max-width: 800px; margin: 0 auto; width: 100%; padding: 16px; flex: 1; display: flex; flex-direction: column; }
  h1 { font-size: 20px; color: #b8b8d0; text-align: center; padding: 16px 0; border-bottom: 1px solid #2a2a4a; margin-bottom: 16px; }
  #narrative { flex: 1; background: #16213e; border-radius: 8px; padding: 16px; overflow-y: auto; min-height: 300px; line-height: 1.7; white-space: pre-wrap; font-size: 15px; margin-bottom: 12px; border: 1px solid #2a2a4a; }
  #narrative .msg-narration { color: #c8d6e5; margin-bottom: 8px; }
  #narrative .msg-dialogue { color: #7bed9f; margin-bottom: 4px; }
  #narrative .msg-system { color: #ff6b6b; font-size: 13px; margin-bottom: 4px; }
  #narrative .msg-action { color: #ffd93d; margin-bottom: 4px; }
  #narrative .speaker { font-weight: 600; }
  #narrative .timestamp { color: #576574; font-size: 11px; margin-left: 8px; }
  #status-bar { display: flex; gap: 16px; padding: 8px 12px; background: #0f3460; border-radius: 8px; font-size: 13px; margin-bottom: 12px; flex-wrap: wrap; }
  #status-bar .stat { display: flex; align-items: center; gap: 4px; }
  #status-bar .label { color: #8899aa; }
  #status-bar .value { color: #e0e0e0; font-weight: 600; }
  #status-bar .danger { color: #ff6b6b; }
  #input-area { display: flex; gap: 8px; }
  #input { flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid #2a2a4a; background: #16213e; color: #e0e0e0; font-size: 15px; outline: none; }
  #input:focus { border-color: #4a6fa5; }
  #send { padding: 10px 24px; border-radius: 8px; border: none; background: #4a6fa5; color: #fff; font-size: 15px; cursor: pointer; }
  #send:hover { background: #5a7fb5; }
  #send:disabled { opacity: 0.5; cursor: not-allowed; }
  #new-game { padding: 8px 16px; border-radius: 8px; border: 1px solid #2a2a4a; background: transparent; color: #8899aa; font-size: 13px; cursor: pointer; }
  #new-game:hover { background: #2a2a4a; color: #e0e0e0; }
  .error-msg { color: #ff6b6b; padding: 8px; background: #2a1a1a; border-radius: 4px; margin-bottom: 8px; }
  .loading { text-align: center; padding: 20px; color: #576574; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2a2a4a; border-radius: 3px; }
</style>
</head>
<body>
<div id="app">
  <h1>🎲 AI Narrator — 调查员终端</h1>
  <div id="status-bar">
    <span class="stat"><span class="label">会话:</span><span class="value" id="session-id">—</span></span>
    <span class="stat"><span class="label">回合:</span><span class="value" id="round">0</span></span>
    <span class="stat"><span class="label">场景:</span><span class="value" id="scene">—</span></span>
    <span class="stat"><span class="label">HP:</span><span class="value" id="hp">—</span></span>
    <span class="stat"><span class="label">SAN:</span><span class="value" id="san">—</span></span>
    <span id="insanity-badge" style="display:none;color:#ff6b6b;font-weight:700;">🧠 疯狂</span>
    <button id="new-game">新游戏</button>
  </div>
  <div id="narrative">
    <div class="loading">点击"新游戏"开始</div>
  </div>
  <div id="input-area">
    <input id="input" type="text" placeholder="输入你的行动..." autocomplete="off">
    <button id="send" disabled>发送</button>
  </div>
</div>
<script>
let sessionId = null;
const narrative = document.getElementById('narrative');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const newGameBtn = document.getElementById('new-game');

function $(id) { return document.getElementById(id); }

function appendMessage(speaker, content, type) {
  const div = document.createElement('div');
  div.className = 'msg-' + type;
  const ts = new Date().toLocaleTimeString();
  if (type === 'system') {
    div.innerHTML = '<span class="speaker">⚔</span> ' + escapeHtml(content) + '<span class="timestamp">' + ts + '</span>';
  } else {
    div.innerHTML = '<span class="speaker">' + escapeHtml(speaker) + '</span> ' + escapeHtml(content) + '<span class="timestamp">' + ts + '</span>';
  }
  narrative.appendChild(div);
  narrative.scrollTop = narrative.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updateStatus(state, sanity, summary) {
  if (summary) {
    $('session-id').textContent = summary.id || '—';
    $('round').textContent = summary.round || 0;
  }
  if (state) {
    $('scene').textContent = state.scene || '—';
    if (state.player) {
      $('hp').textContent = state.player.hp + '/' + state.player.maxHp;
    }
  }
  if (sanity) {
    $('san').textContent = sanity.currentSAN + '/' + sanity.maxSAN;
    const badge = $('insanity-badge');
    badge.style.display = (sanity.temporaryInsanity || sanity.indefiniteInsanity) ? 'inline' : 'none';
    badge.textContent = sanity.temporaryInsanity ? '🧠 临时疯狂' : sanity.indefiniteInsanity ? '🧠 永久疯狂' : '';
  }
}

async function createSession() {
  const res = await fetch('/api/sessions', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ruleset:'cosmic-horror'}) });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  sessionId = data.sessionId;
  narrative.innerHTML = '';
  if (data.opening) {
    appendMessage('KP', data.opening, 'narration');
  }
  updateStatus(null, null, data.summary);
  input.disabled = false;
  input.focus();
  return data;
}

async function sendAction(inputText) {
  sendBtn.disabled = true;
  input.value = '';
  appendMessage('🎲', inputText, 'action');

  try {
    const res = await fetch('/api/sessions/' + sessionId + '/action', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({input: inputText}),
    });
    if (!res.ok) {
      const err = await res.json();
      appendMessage('系统', err.error || '请求失败', 'system');
      return;
    }
    const data = await res.json();
    // 显示 KP/旁白叙事
    if (data.narrative) {
      appendMessage('KP', data.narrative, 'narration');
    }
    // 显示其他事件
    if (data.events) {
      for (const e of data.events) {
        if (e.speaker !== 'KP' && e.speaker !== '旁白') {
          appendMessage(e.speaker, e.content, e.type);
        }
      }
    }
    updateStatus(data.state, data.sanity, data.summary);
  } catch (err) {
    appendMessage('系统', '连接错误: ' + err.message, 'system');
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

// 事件绑定
sendBtn.addEventListener('click', () => {
  const text = input.value.trim();
  if (text && sessionId) sendAction(text);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !sendBtn.disabled) sendBtn.click();
});

newGameBtn.addEventListener('click', async () => {
  newGameBtn.disabled = true;
  narrative.innerHTML = '<div class="loading">创建新游戏...</div>';
  input.disabled = true;
  try {
    await createSession();
    sendBtn.disabled = false;
  } catch (err) {
    narrative.innerHTML = '<div class="error-msg">创建失败: ' + err.message + '</div>';
  } finally {
    newGameBtn.disabled = false;
  }
});

// 自动创建
window.addEventListener('load', async () => {
  try {
    await createSession();
    sendBtn.disabled = false;
  } catch (err) {
    narrative.innerHTML = '<div class="error-msg">无法连接服务器 ' + err.message + '</div>';
  }
});
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ============================================================
// 启动
// ============================================================

// 只在被直接运行时启动服务器（bun run src/api/server.ts）。被测试 import
// 进来取 runAction 等纯逻辑时，绝不能在这里把 3099 端口绑起来、也不该去
// 扫持久化的 session 文件。
if (import.meta.main) {
const runtimeConfig = resolveServerRuntimeConfig();
// This immutable policy is loaded before runtime storage, inventory, timers,
// listener creation, or provider setup. A broken pair must never leave an
// unbound server listening with an operator-visible configuration mismatch.
const serverCompiledWorldModelBindingRegistry = new CompiledWorldModelBindingRegistry();
// This exact process singleton is also injected into configured auto-compile
// and operator recovery routes below. Initialize it before any other runtime
// storage can make the server appear healthy while its durable policy is not.
const serverCompilerAutoAdmission = getDefaultCompilerAutoAdmission();
const runtimeEnvironment = {
  NODE_ENV: runtimeConfig.nodeEnv,
  ORDINARY_SESSION_AUTH_MODE: process.env.ORDINARY_SESSION_AUTH_MODE,
  ORDINARY_SESSION_INTENT_POLICY: process.env.ORDINARY_SESSION_INTENT_POLICY,
};
const serverOrdinaryWebSocketAdmission = new OrdinarySessionWebSocketAdmissionController(
  runtimeConfig.ordinarySessionWebSocketAdmission,
);
const startupNamespaceRoot = runtimeSessionNamespaceRoot({});
const serverOrdinarySessionCreationAdmission = new OrdinarySessionCreationAdmissionCoordinator({
  root: startupNamespaceRoot,
  ...runtimeConfig.ordinarySessionCreationAdmission,
  maxTrackedPrincipals: 1_024,
  leaseTtlMs: 60_000,
  wholeJobDeadlineMs: 300_000,
  busyTimeoutMs: 25,
});
const serverCompiledSessionCreationAdmission = new CompiledSessionCreationAdmissionCoordinator({
  root: startupNamespaceRoot,
  ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
});
// A delivery configuration is process-owned: startup validates its separate
// mutable claim domain once, then every request receives this exact instance.
const serverPlayerDelivery = createEnvironmentPlayerDelivery();
// Inventory is a process-start barrier, not a lazy request concern.  No
// hydration constructor (and therefore no career/model side effect) may run
// until every durable locator has been adjudicated in the shared namespace.
const startupNamespace = new SessionNamespaceCoordinator(startupNamespaceRoot);
try {
  // No-op when delivery is unavailable. An explicitly effective deployment
  // capability, however, must prove its root and writer policy before any
  // listener can be created.
  serverPlayerDelivery.initialize();
  // Main owns this admission root only. Its controller immediately rechecks
  // directory/file/sidecar safety and durable policy identity before startup
  // may continue to session namespace inventory or listener creation.
  mkdirSync(serverCompilerAutoAdmission.root, { recursive: true });
  serverCompilerAutoAdmission.initialize();
  // This is the one host-owned path main is allowed to create. The durable
  // coordinator still lstat-validates it (and its SQLite files) immediately
  // afterwards, so a pre-existing regular file or symlink remains fail-closed.
  mkdirSync(startupNamespaceRoot, { recursive: true });
  serverOrdinarySessionCreationAdmission.initialize();
  serverCompiledSessionCreationAdmission.initialize();
  reconcileRuntimeSessionNamespace(startupNamespace, defaultOrdinarySessionSnapshots, defaultCompiledSessionSnapshots, {});
} catch (error) {
  log.error("startup", "durable startup coordination failed; player delivery, runtime namespace inventory, automatic compiler, or creation admission initialization refused listening", error);
  throw error;
}

const hydration = hydrateCompiledSessions({ sessionNamespace: startupNamespace });
if (hydration.hydrated.length || hydration.unavailable.length) {
  console.log(`  Hydrated ${hydration.hydrated.length} compiled session(s); ${hydration.unavailable.length} unavailable`);
}
  const ordinaryHydration = hydrateOrdinarySessions({ sessionNamespace: startupNamespace });
  if (ordinaryHydration.hydrated.length || ordinaryHydration.unavailable.length) {
    console.log(`  Hydrated ${ordinaryHydration.hydrated.length} ordinary session(s); ${ordinaryHydration.unavailable.length} unavailable`);
  }

  // HTTP host-owner routes and ordinary owner WS upgrades share these exact
  // server-owned authentication/configuration capabilities for this process.
  const serverCompilerAuthenticator = createEnvironmentCompilerAuthenticator();
  const serverOrdinarySessionAccess = createEnvironmentOrdinarySessionAccessOptions(runtimeEnvironment);
  const serverOrdinaryIntentPolicy = createEnvironmentOrdinaryIntentPolicy(runtimeEnvironment);

const cleanupTimer = setInterval(() => {
const cleaned = cleanupExpiredSessions(sessions, {
    timeoutMs: runtimeConfig.sessionTimeoutMs,
    deleteMetadata: deleteSessionFile,
    isDurableCompiled: (session) => session instanceof GameSession && session.isDurableCompiledSession(),
    isDurableOrdinary: (session) => session instanceof GameSession && isDurableOrdinarySessionForCleanup(session),
    logError: (error) => log.error("cleanup", "failed to remove expired session metadata", error),
  });
  if (cleaned.length > 0) log.info("cleanup", `清理了 ${cleaned.length} 个过期会话`);
}, CLEANUP_INTERVAL_MS);

let shutdownController: ReturnType<typeof createServerShutdownController> | undefined;
const liveServer = Bun.serve<WsConnectionData, never>({
  port: runtimeConfig.port,
  hostname: "0.0.0.0",
  ...SERVER_HOST_RESOURCE_POLICY,
  async fetch(req, server) {
    if (!shutdownController) {
      return Response.json({ error: { code: "SERVER_DRAINING" } }, { status: 503, headers: { "Retry-After": "1" } });
    }
    return shutdownController.trackRequest(async () => {
    // WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return admitOrdinarySessionWebSocketUpgrade(req, server, {
        admission: serverOrdinaryWebSocketAdmission,
        authorizationDependencies: {
          compilerAuthenticator: serverCompilerAuthenticator,
          ordinarySessionAccess: serverOrdinarySessionAccess,
          ordinarySnapshots: defaultOrdinarySessionSnapshots,
          sessionNamespace: startupNamespace,
          compiledLegacyRefusal: (sessionId) => compiledSessionWebSocketRefusal(
            sessionId,
            sessions,
            defaultCompiledSessionSnapshots,
            compiledSessionDiagnostics,
          ),
        },
      });
    }
    return handleRequest(
      req,
      undefined,
      undefined,
      {},
      {},
      { admission: serverCompilerAutoAdmission },
      serverCompilerAuthenticator,
      undefined,
      undefined,
      serverPlayerDelivery,
      serverOrdinarySessionAccess,
      {
        sessionNamespace: startupNamespace,
        ordinarySessionCreationAdmission: serverOrdinarySessionCreationAdmission,
        compiledSessionCreationAdmission: serverCompiledSessionCreationAdmission,
        resolveCompiledWorldModelBinding: serverCompiledWorldModelBindingRegistry.resolve,
        ordinaryIntentPolicy: serverOrdinaryIntentPolicy,
        runtimeNodeEnv: runtimeConfig.nodeEnv,
      },
      { runtimeConfig, compiledWorldModelBindingPolicy: serverCompiledWorldModelBindingRegistry.status },
    );
    });
  },
  websocket: createOrdinarySessionWebSocketHandler({
    open(ws) {
      if (openAdmittedOrdinarySessionWebSocket(ws, serverOrdinaryWebSocketAdmission)) {
        console.log(`  🔗 WS 连接: ${ws.data.role} → ${ws.data.sessionId.slice(-8)} (共 ${wsStats().total} 连接)`);
      }
    },
    close(ws) {
      closeAdmittedOrdinarySessionWebSocket(ws, serverOrdinaryWebSocketAdmission);
    },
  }),
});

shutdownController = createServerShutdownController({
  listener: liveServer,
  sessions,
  clearCleanupTimer: () => clearInterval(cleanupTimer),
  beginWebSocketAdmissionDrain: () => serverOrdinaryWebSocketAdmission.beginDraining(),
  closeWebSockets: closeAllWsClients,
  onGraceTimeout: () => log.error("shutdown", "graceful shutdown timed out; leaving live sessions for crash-like recovery"),
  onSessionCloseError: (error) => log.error("shutdown", "failed to close session during graceful shutdown", error),
});
bindShutdownSignals(shutdownController);

// 启动时加载已持久化的 session 摘要
const stored = listStoredSessions();
if (stored.length > 0) {
  console.log(`  Loaded ${stored.length} stored session(s) from disk`);
}

console.log(`\n  🎲 AI Narrator Server`);
console.log(`  ─────────────────`);
console.log(`  API:  http://localhost:${runtimeConfig.port}/api`);
console.log(`  GUI:  http://localhost:${runtimeConfig.port}/`);
console.log(`  Port: ${runtimeConfig.port}`);
console.log(`  CORS: *\n`);

}
