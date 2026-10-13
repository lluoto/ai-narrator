/**
 * Offline host composition for the internal two-document HTTP campaign.
 *
 * This file deliberately owns only a disposable catalog and its matching
 * automatic-admission domain. It is not a public server route; the explicit
 * live entry below constructs only the configured LLMClient behind a bounded
 * script-owned fetch admission.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { randomBytes, randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import type { ChatOptions, LLMLike, Message } from "../../src/llm/client";
import { LLMClient } from "../../src/llm/client";
import { loadConfig, type LLMConfig } from "../../src/config";
import { isUsableLlmApiKey, llmDisabledByOverride } from "../../src/llm/enabled";
import type {
  TrustedCompilerHintProposalProducer,
  CompilerHintProposalAdapterLimits,
} from "../../src/api/compiler-hint-proposal-adapter";
import type { TrustedCompilerHintProposalPolicy } from "../../src/compiler/compiler-hint-proposals";
import { CompilerArtifactCatalog } from "../../src/compiler/compiler-artifact-catalog";
import { restoreCompilerArtifact } from "../../src/compiler/compiler-artifact";
import {
  CompilerAutoAdmissionController,
  DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
} from "../../src/api/compiler-auto-admission";
import {
  handleCompiledModuleHttpRequest,
  type CompiledModuleHttpDependencies,
  type CompiledWorldModelBindingResolver,
  type MachinePresentationPublisher,
} from "../../src/api/compiled-module-http";
import { createServerMachinePresentationPublisher } from "../../src/api/compiler-machine-presentation-publisher";
import { createEnvironmentPlayerDelivery, type CompiledPlayerDelivery } from "../../src/api/player-delivery";
import { CompiledWorldModelBindingRegistry } from "../../src/world/compiled-world-model-binding-registry";
import { handleRequest, type SessionRuntimeDependencies } from "../../src/api/server";
import { CompiledSessionSnapshotStore, validateCompiledSessionSnapshot } from "../../src/api/compiled-session-snapshot";
import { SessionNamespaceCoordinator } from "../../src/api/session-namespace-coordinator";
import {
  CompiledSessionCreationAdmissionCoordinator,
  COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
} from "../../src/api/compiled-session-creation-admission";
import {
  BudgetedRedactingLLM,
  REAL_MODEL_DOCUMENTS,
  uploadsAreAuthorized,
} from "../real-model-two-module-acceptance";
import { sha256 } from "../../src/ingest/document-ir";
import {
  runTwoModuleHttpCampaign,
  type HttpCampaignDocument,
  type TwoModulePublishedArtifact,
  type TwoModuleHttpCampaignReport,
} from "../real-model-two-module-http-campaign";
import { GameSession } from "../../src/api/game-session";

/** One explicitly authorized live campaign may dispatch no more than this many fetches. */
export const LIVE_HTTP_CAMPAIGN_LIMITS = Object.freeze({
  maxExternalFetchDispatches: 8,
  maxTokens: 2_400,
  maxAttempts: 1,
  globalAdmissionDeadlineMs: 180_000,
  maxAutoResolveAttemptsPerModule: 2,
  // Two HTTP continuation attempts × one adapter round × two chunks = four
  // possible LLM dispatches per module. The global gate separately enforces 8.
  maxProposalRounds: 1,
  maxRequestsPerRound: 2,
  perCallTimeoutMs: 45_000,
});

/** Explicit, opt-in limits for a separately scheduled full-quality run. */
export const FULL_QUALITY_HTTP_CAMPAIGN_LIMITS = Object.freeze({
  maxExternalFetchDispatches: 200,
  maxReservedOutputTokens: 200_000,
  /** 200 exact pre-dispatch reservations cannot exceed the 200k run cap. */
  maxTokensPerDispatch: 1_000,
  maxAttempts: 1,
  defaultGlobalAdmissionDeadlineMs: 1_200_000,
  maxGlobalAdmissionDeadlineMs: 1_800_000,
});

export type FullQualityPreflightReason = "upload_not_authorized" | "world_not_configured" | "player_delivery_not_configured" | "full_quality_configuration_invalid" | "ready";

export interface FullQualityCampaignMode {
  readonly mode: "full_quality";
  /** Defaults to twenty minutes; an opt-in run may only tighten it. */
  readonly globalAdmissionDeadlineMs?: number;
  /** Host-only deployment capability; HTTP/campaign input cannot select it. */
  readonly playerDelivery?: CompiledPlayerDelivery;
}

export type TwoModuleHttpCampaignHostDocument = HttpCampaignDocument;

export interface OfflineTwoModuleHttpCampaignHostInput {
  /** Defaults to the existing two hash-gated local documents. */
  documents?: readonly TwoModuleHttpCampaignHostDocument[];
  allowedDocumentHashes: readonly string[];
  readDocument?: (document: TwoModuleHttpCampaignHostDocument) => Uint8Array | Promise<Uint8Array>;
  llm: LLMLike;
  llmBudget: { maxCalls: number; timeoutMs: number };
  policy: TrustedCompilerHintProposalPolicy;
  producer: TrustedCompilerHintProposalProducer;
  limits: CompilerHintProposalAdapterLimits;
  maxProposalRounds: number;
  maxAutoResolveAttemptsPerModule?: number;
  /** Test-only observation of the one host-owned admission authority. */
  observeAdmissionController?: (controller: CompilerAutoAdmissionController) => void;
  /** Test-only lifecycle observation; never receives a filesystem path. */
  observeCleanup?: (cleanup: "removed" | "cleanup_deferred") => void;
  /**
   * Test-only observation of the auto-resolve response's already-public
   * diagnostic coordinates. It never receives validator messages, source
   * prose, request bodies, credentials, or catalog identities.
   */
  observeAutoResolveResponse?: (observation: Readonly<{
    status: number;
    errorCode?: string;
    diagnostics: readonly Readonly<{
      code: string;
      stage?: string;
      questionId?: string;
      round?: number;
    }>[];
  }>) => void;
  /** Host-owned publisher; absent retains the existing draft-only workflow. */
  machinePublisher?: MachinePresentationPublisher;
  /**
   * Host-owned opt-in for the existing bounded server selector. It is never
   * derived from campaign HTTP input; an explicitly supplied publisher wins.
   */
  machinePublicationEnabled?: boolean;
  /** Trusted host authority for exact resolved-artifact world-model bindings. */
  resolveCompiledWorldModelBinding?: CompiledWorldModelBindingResolver;
  /** Opt-in host policy; legacy offline campaigns remain valid without a binding. */
  requirePublishedWorldModelBinding?: boolean;
  /** Script-private driver scheduling/context seam for the opt-in live runner. */
  interleaveAutoResolveAttempts?: boolean;
  /** Runs an already-authorized compiler attempt under immutable host context. */
  runAutoResolveAttempt?<T>(
    context: { module: HttpCampaignDocument["id"] },
    dispatch: () => Promise<T>,
  ): Promise<T>;
  /** Script-private full-quality player route; absent preserves offline/smoke consumption. */
  fullQualityPlayerRoute?: FullQualityPlayerRoute;
}

type FullQualityPlayerPhase = "player_intent" | "narration" | "followup";

/**
 * Host-private player-quality execution authority. It never crosses campaign
 * HTTP and every model-backed player request must enter through `runPhase`.
 */
interface FullQualityPlayerRoute {
  readonly delivery: CompiledPlayerDelivery;
  readonly llm: LLMLike;
  runPhase<T>(
    context: { module: HttpCampaignDocument["id"]; phase: FullQualityPlayerPhase },
    dispatch: () => Promise<T>,
  ): Promise<T>;
}

export interface OfflineTwoModuleHttpCampaignHostReport {
  campaign: TwoModuleHttpCampaignReport;
  host: {
    mode: "offline_injected";
    /** Calls made through the injected LLMLike; not a network-request count. */
    llmChatCalls: number;
    /** Requests were direct function calls to the internal handler, never fetch. */
    inProcessHttpNetworkRequests: 0;
    /** An injected LLMLike may have its own transport, which this host cannot observe. */
    externalNetworkRequests: "not_observed";
    admissionControllers: 0 | 1;
    /** Canonically loaded published bundles that also completed one durable action. */
    publishedBundleConsumptions: number;
    /** Durable structured-action receipts observed through the existing session route. */
    compiledActionWitnesses: number;
    /** Catalog-bound compiled sessions admitted with a verified world binding. This is not a provenance receipt. */
    publishedWorldModelBoundSessionCreations: number;
    /** Bound openings whose local-context receipt passed exact scope checks. */
    publishedWorldModelReceiptWitnesses: number;
    /** Sorted scope hashes only; no corpus path, work IDs, or source text. */
    publishedWorldModelScopeHashes: readonly string[];
    cleanup: "not_created" | "removed" | "cleanup_deferred";
  };
}

/**
 * Script-private live composition input. The caller supplies the already
 * loaded process configuration; this function never reads environment values
 * or probes an endpoint itself.
 */
export interface LiveTwoModuleHttpCampaignHostInput {
  documents?: readonly TwoModuleHttpCampaignHostDocument[];
  allowedDocumentHashes: readonly string[];
  readDocument?: OfflineTwoModuleHttpCampaignHostInput["readDocument"];
  config: LLMConfig;
  /** Test seam only; production uses Date.now. */
  now?: () => number;
  /** Test seam only; production schedules the fixed 180-second abort timer. */
  scheduleDeadline?: (callback: () => void, delayMs: number) => () => void;
  /**
   * Test-only probe after the gate is installed but before campaign work. Its
   * context runner exists solely to exercise the gate's trusted host context;
   * campaign/HTTP input cannot select a module or phase.
   */
  beforeLiveCampaignDispatch?: (probe: LiveAdmissionTestProbe | undefined) => void | Promise<void>;
  observeAdmissionController?: OfflineTwoModuleHttpCampaignHostInput["observeAdmissionController"];
  observeCleanup?: OfflineTwoModuleHttpCampaignHostInput["observeCleanup"];
  observeAutoResolveResponse?: OfflineTwoModuleHttpCampaignHostInput["observeAutoResolveResponse"];
  /** Explicitly opt the live host into the bounded default publisher. */
  machinePublicationEnabled?: boolean;
  /**
   * Host-owned fresh-PDF policy authority. This is a script-local dependency
   * seam; no campaign request or CLI body can supply a resolver or scope.
   */
  worldModelBindingRegistry?: CompiledWorldModelBindingRegistry;
  /**
   * Require a configured source-profile match for both exact authorized PDFs
   * before this live host builds an LLM client or permits a fetch dispatch.
   */
  requirePublishedWorldModelBinding?: boolean;
  /** A separate, explicit live-quality mode. Absent preserves the 8/180 smoke. */
  fullQuality?: FullQualityCampaignMode;
}

export interface LiveTwoModuleHttpCampaignHostReport {
  campaign: TwoModuleHttpCampaignReport;
  host: Omit<OfflineTwoModuleHttpCampaignHostReport["host"], "mode" | "externalNetworkRequests"> & {
    mode: "live_llm_client";
    /** Exact fetch dispatches observed by this script-owned global gate. */
    externalNetworkRequests: number;
  };
  budget: {
    kind: "script_owned_external_fetch_admission";
    maxExternalFetchDispatches: number;
    observedExternalFetchDispatches: number;
    maxTokens: number;
    /** Full-quality mode owns a run-wide output reservation; smoke omits it. */
    maxReservedOutputTokens?: number;
    reservedOutputTokens?: number;
    maxAttempts: number;
    globalAdmissionDeadlineMs: number;
    globalDeadlineStarted: boolean;
    globalDeadlineReached: boolean;
    /** Existing handler-owned deadline may legitimately stop earlier. */
    handlerDeadlineRemainsExisting: true;
  };
  /** Only present for explicit full-quality mode; it exposes no configuration values. */
  preflightReason?: FullQualityPreflightReason;
}

const TEMPORARY_ROOT_PREFIX = "aitrpg-two-module-http-campaign-host-";
const CATALOG_MAX_ENTRIES = 32;
const CATALOG_MAX_BYTES = 16 * 1024 * 1024;
const CLEANUP_GRACE_MS = 100;

interface StagedDocuments {
  documents: readonly TwoModuleHttpCampaignHostDocument[];
  bytesByAlias: ReadonlyMap<TwoModuleHttpCampaignHostDocument["id"], Uint8Array>;
  hashes: readonly string[];
  readable: boolean;
}

/**
 * BudgetedRedactingLLM enforces the request deadline, but its timeout race
 * cannot tell the host whether an injected implementation is still settling.
 * Track that ownership locally so a normal handler completion drains before
 * temporary catalog removal. A 5xx/deadline remains deliberately deferred.
 */
class DrainTrackingLLM implements LLMLike {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly upstream: LLMLike) {}

  chat(messages: Parameters<LLMLike["chat"]>[0], options?: Parameters<LLMLike["chat"]>[1]): Promise<string> {
    const pending = Promise.resolve(this.upstream.chat(messages, options));
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    return pending;
  }

  settle(): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.allSettled([...this.pending]);
  }

  async settleWithinGrace(): Promise<boolean> {
    const settled = this.settle().then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        settled,
        new Promise<false>((resolveGrace) => { timer = setTimeout(() => resolveGrace(false), CLEANUP_GRACE_MS); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function exactTwoModuleDocuments(documents: readonly TwoModuleHttpCampaignHostDocument[]): boolean {
  return documents.length === 2
    && new Set(documents.map((document) => document.id)).size === 2
    && new Set(documents.map((document) => document.moduleId)).size === 2
    && documents.every((document) => (document.id === "fuzu" || document.id === "barn") && document.moduleId.trim().length > 0);
}

async function stageDocuments(
  documents: readonly TwoModuleHttpCampaignHostDocument[],
  reader: NonNullable<OfflineTwoModuleHttpCampaignHostInput["readDocument"]>,
): Promise<StagedDocuments> {
  const bytesByAlias = new Map<TwoModuleHttpCampaignHostDocument["id"], Uint8Array>();
  const hashes: string[] = [];
  let readable = true;
  for (const document of documents) {
    try {
      const bytes = new Uint8Array(await reader(document));
      if (bytes.byteLength === 0 || bytesByAlias.has(document.id)) {
        readable = false;
        continue;
      }
      bytesByAlias.set(document.id, bytes);
      hashes.push(sha256(bytes));
    } catch {
      readable = false;
    }
  }
  return { documents, bytesByAlias, hashes, readable };
}

function stagedReader(staged: StagedDocuments): (document: HttpCampaignDocument) => Uint8Array {
  return (document) => {
    const bytes = staged.bytesByAlias.get(document.id);
    if (!bytes) throw new Error("offline_source_unavailable");
    return new Uint8Array(bytes);
  };
}

function canonicalOwnedTemporaryRoot(root: string): string | undefined {
  try {
    const temporaryParent = realpathSync(resolve(tmpdir()));
    const canonicalRoot = realpathSync(resolve(root));
    return dirname(canonicalRoot) === temporaryParent && basename(canonicalRoot).startsWith(TEMPORARY_ROOT_PREFIX)
      ? canonicalRoot
      : undefined;
  } catch {
    return undefined;
  }
}

function removeOwnedTemporaryRoot(root: string, expectedCanonicalRoot: string): boolean {
  const currentCanonicalRoot = canonicalOwnedTemporaryRoot(root);
  if (currentCanonicalRoot !== expectedCanonicalRoot) return false;
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function safelyObserveCleanup(input: OfflineTwoModuleHttpCampaignHostInput, cleanup: "removed" | "cleanup_deferred"): void {
  try { input.observeCleanup?.(cleanup); } catch { /* test-only observers cannot own cleanup */ }
}

async function safelyObserveAutoResolveResponse(input: OfflineTwoModuleHttpCampaignHostInput, response: Response): Promise<void> {
  if (!input.observeAutoResolveResponse) return;
  try {
    const body: unknown = await response.clone().json();
    const errorCode = isRecord(body) && isRecord(body.error) && typeof body.error.code === "string"
      ? body.error.code
      : undefined;
    const diagnostics = isRecord(body) && Array.isArray(body.diagnostics)
      ? body.diagnostics.flatMap((value) => {
        if (!isRecord(value) || typeof value.code !== "string") return [];
        return [{
          code: value.code,
          ...(typeof value.stage === "string" ? { stage: value.stage } : {}),
          ...(typeof value.questionId === "string" ? { questionId: value.questionId } : {}),
          ...(typeof value.round === "number" && Number.isSafeInteger(value.round) ? { round: value.round } : {}),
        }];
      })
      : [];
    input.observeAutoResolveResponse({ status: response.status, ...(errorCode ? { errorCode } : {}), diagnostics });
  } catch {
    // Test observers must not influence transport or consume the original body.
  }
}

function internalDependencies(
  catalog: CompilerArtifactCatalog,
  llm: LLMLike,
  input: OfflineTwoModuleHttpCampaignHostInput,
  admission: CompilerAutoAdmissionController,
): CompiledModuleHttpDependencies {
  const machinePublisher = input.machinePublisher
    ?? (input.machinePublicationEnabled === true ? createServerMachinePresentationPublisher(llm) : undefined);
  return {
    catalog,
    createSession: () => { throw new Error("offline_host_session_route_not_available"); },
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => undefined,
    generateId: () => "offline-two-module-http-campaign-host",
    authenticateCompilerRequest: () => ({
      status: "authenticated",
      principal: { id: "offline-two-module-http-campaign-host", role: "operator" },
    }),
    // Errors can include source/provider information. The host report relies
    // exclusively on the driver's stable public codes instead.
    logError: () => undefined,
    resolveCompiledWorldModelBinding: input.resolveCompiledWorldModelBinding,
    autoCompiler: {
      llm,
      policy: input.policy,
      producer: input.producer,
      limits: input.limits,
      maxProposalRounds: input.maxProposalRounds,
      admission,
      ...(machinePublisher ? { machinePublisher } : {}),
    },
  };
}

interface PublishedConsumptionStats {
  publishedBundleConsumptions: number;
  compiledActionWitnesses: number;
  publishedWorldModelBoundSessionCreations: number;
  publishedWorldModelReceiptWitnesses: number;
  publishedWorldModelScopeHashes: Set<string>;
}

/**
 * Test-only access to the same host consumer used by a campaign publication.
 * It is deliberately a script composition seam, not a compiler/server API.
 */
export async function consumePublishedBundleForQualityTest(input: {
  publication: TwoModulePublishedArtifact;
  catalog: CompilerArtifactCatalog;
  snapshots: CompiledSessionSnapshotStore;
  storage: { careerRoot: string; sessionRoot: string };
  sessionRuntime: SessionRuntimeDependencies;
  playerRoute?: FullQualityPlayerRoute;
}): Promise<{ consumed: boolean; phases: readonly FullQualityPlayerPhase[] }> {
  const stats: PublishedConsumptionStats = {
    publishedBundleConsumptions: 0,
    compiledActionWitnesses: 0,
    publishedWorldModelBoundSessionCreations: 0,
    publishedWorldModelReceiptWitnesses: 0,
    publishedWorldModelScopeHashes: new Set<string>(),
  };
  const phases: FullQualityPlayerPhase[] = [];
  const playerRoute = input.playerRoute && {
    ...input.playerRoute,
    runPhase: <T>(context: { module: HttpCampaignDocument["id"]; phase: FullQualityPlayerPhase }, dispatch: () => Promise<T>) => {
      phases.push(context.phase);
      return input.playerRoute!.runPhase(context, dispatch);
    },
  };
  return {
    consumed: await consumePublishedBundle(input.publication, {
      catalog: input.catalog,
      snapshots: input.snapshots,
      storage: input.storage,
      sessionRuntime: input.sessionRuntime,
      stats,
      requirePublishedWorldModelBinding: false,
      ...(playerRoute ? { playerRoute } : {}),
    }),
    phases,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Execute the bounded player-facing quality sample through the same facade a
 * claimed browser session uses. This stays script-private: its opaque cookie,
 * choice, topic token, and contact token never enter campaign state or a
 * report. A failed quality sample is deliberately not a substitute for the
 * normal structured consumption witness.
 */
async function runFullQualityPlayerRoute(input: {
  publication: TwoModulePublishedArtifact;
  sessionId: string;
  creation: Record<string, unknown>;
  initialSnapshotHash: string;
  catalog: CompilerArtifactCatalog;
  snapshots: CompiledSessionSnapshotStore;
  storage: { careerRoot: string; sessionRoot: string };
  sessionRuntime: SessionRuntimeDependencies;
  playerRoute: FullQualityPlayerRoute;
}): Promise<false | { generation: number; previousSnapshotHash: string }> {
  const origin = input.playerRoute.delivery.publicOrigin;
  const invitation = input.creation.playerInvitation;
  if (!origin || !isRecord(invitation) || typeof invitation.invite !== "string") return false;
  const authenticator = () => ({
    status: "authenticated" as const,
    principal: { id: "offline-two-module-host", role: "operator" as const },
  });
  const claim = await handleRequest(new Request(
    `${origin}/api/sessions/${encodeURIComponent(input.sessionId)}/player-invitations/claim`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ invite: invitation.invite, claimId: randomBytes(32).toString("base64url") }),
    },
  ), input.catalog, input.snapshots, input.storage, {}, {}, authenticator,
  undefined, undefined, input.playerRoute.delivery, undefined, input.sessionRuntime);
  if (claim.status !== 204) return false;
  const rawCookie = claim.headers.get("set-cookie");
  const cookie = rawCookie?.split(";", 1)[0];
  if (!cookie || !/^__Host-aitrpg-p1-[a-f0-9]{32}=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(cookie)) return false;

  const playerRuntime: SessionRuntimeDependencies = {
    ...input.sessionRuntime,
    compiledNarrationOptions: { llm: input.playerRoute.llm, isLlmEnabled: () => true },
    compiledFollowupOptions: { llm: input.playerRoute.llm, isLlmEnabled: () => true },
  };
  const navigationRuntime: SessionRuntimeDependencies = {
    ...input.sessionRuntime,
    compiledNarrationOptions: { isLlmEnabled: () => false },
  };
  const requestPlayer = (path: string, init?: RequestInit, compiledIntentOptions: Record<string, unknown> = {}, runtime = playerRuntime) => {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", cookie);
    if ((init?.method ?? "GET") !== "GET") headers.set("Origin", origin);
    return handleRequest(new Request(`${origin}${path}`, { ...init, headers }), input.catalog, input.snapshots, input.storage,
      compiledIntentOptions, {}, authenticator, undefined, undefined, input.playerRoute.delivery, undefined, runtime);
  };
  const base = `/api/sessions/${encodeURIComponent(input.sessionId)}`;
  const initial = await requestPlayer(`${base}/player-view`);
  if (initial.status !== 200) return false;
  const initialView: unknown = await initial.json();
  if (!isRecord(initialView) || !isSafeInteger(initialView.generation) || initialView.terminal === true) return false;

  const initialStored = input.snapshots.read(input.sessionId);
  if (initialStored.status !== "ok") return false;
  const initialDurable = validateCompiledSessionSnapshot(initialStored.value);
  if (initialDurable.status !== "ok" || initialDurable.value.snapshotHash !== input.initialSnapshotHash
    || initialDurable.value.bundle.id !== input.publication.bundleId
    || initialDurable.value.generation !== initialView.generation) return false;
  let currentView = initialView;
  let currentDurable = initialDurable.value;
  // The bounded quality sample can follow one publicly available route to a
  // contact. Multiple routes or eight steps without Talk require a broader
  // player plan and are consumer-refused, not guessed from private scene IDs.
  for (let step = 0; ; step++) {
    if (!Array.isArray(currentView.actions)) return false;
    if (currentView.actions.some((action) => isRecord(action) && action.label === "Talk")) break;
    if (step >= 8) return false;
    const traversals = currentView.actions.filter((action) => isRecord(action) && action.label === "Go to another area");
    if (traversals.length !== 1 || !isRecord(traversals[0]) || typeof traversals[0].choiceId !== "string") return false;
    // Navigation is a deterministic player action. It does not consume the
    // one model narration reserved for the subsequent source-bound Talk.
    const moved = await requestPlayer(`${base}/player-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choiceId: traversals[0].choiceId,
        actionId: `full-quality-navigation-${randomUUID()}`,
        expectedGeneration: currentDurable.generation,
      }),
    }, {}, navigationRuntime);
    if (moved.status !== 200) return false;
    const movement: unknown = await moved.json();
    if (!isRecord(movement) || !isRecord(movement.result) || movement.result.status !== "committed" || !isRecord(movement.view)
      || movement.view.generation !== currentDurable.generation + 1 || movement.view.terminal === true) return false;
    const nextStored = input.snapshots.read(input.sessionId);
    if (nextStored.status !== "ok") return false;
    const next = validateCompiledSessionSnapshot(nextStored.value);
    if (next.status !== "ok" || next.value.bundle.id !== input.publication.bundleId
      || next.value.generation !== movement.view.generation || next.value.previousSnapshotHash !== currentDurable.snapshotHash
      || next.value.state.currentSceneId === currentDurable.state.currentSceneId || next.value.stateHash === currentDurable.stateHash) return false;
    const traceDelta = next.value.trace.slice(currentDurable.trace.length);
    if (!traceDelta.length || traceDelta[0]?.beforeStateHash !== currentDurable.stateHash
      || traceDelta.at(-1)?.afterStateHash !== next.value.stateHash || !traceDelta.some((edge) => edge.outcome === "traverse")
      || !traceDelta.every((edge, index) => index === 0 || traceDelta[index - 1]?.afterStateHash === edge.beforeStateHash)) return false;
    currentView = movement.view;
    currentDurable = next.value;
  }

  const playerInput = "I ask the person here what they know.";
  const intent = await input.playerRoute.runPhase({ module: input.publication.module, phase: "player_intent" }, () =>
    requestPlayer(`${base}/player-intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: playerInput, expectedGeneration: currentDurable.generation }),
    }, { llm: input.playerRoute.llm, isLlmEnabled: () => true }),
  );
  if (intent.status !== 200) return false;
  const selected: unknown = await intent.json();
  if (!isRecord(selected) || selected.status !== "selected" || !isSafeInteger(selected.generation) || selected.generation !== currentDurable.generation
    || typeof selected.topicBound !== "string" || !/^[a-f0-9]{64}$/.test(selected.topicBound)
    || !isRecord(selected.action) || typeof selected.action.choiceId !== "string") return false;
  const selectedChoiceId = selected.action.choiceId;
  if (!Array.isArray(currentView.actions) || !currentView.actions.some((action) => isRecord(action)
    && action.label === "Talk" && action.choiceId === selectedChoiceId)) return false;
  const selectedGeneration = selected.generation;
  const selectedTopicBound = selected.topicBound;

  const action = await input.playerRoute.runPhase({ module: input.publication.module, phase: "narration" }, () =>
    requestPlayer(`${base}/player-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choiceId: selectedChoiceId,
        actionId: `full-quality-narration-${randomUUID()}`,
        expectedGeneration: selectedGeneration,
        topicBound: selectedTopicBound,
        playerInput,
      }),
    }),
  );
  if (action.status !== 200) return false;
  const actionResult: unknown = await action.json();
  if (!isRecord(actionResult) || !isRecord(actionResult.result) || actionResult.result.status !== "committed" || !isRecord(actionResult.view)
    || !isSafeInteger(actionResult.view.generation) || actionResult.view.generation !== currentDurable.generation + 1
    || actionResult.view.terminal === true || !isRecord(actionResult.view.presentation)
    || !Array.isArray(actionResult.view.presentation.contacts)) return false;
  const contact = actionResult.view.presentation.contacts.find((candidate) => isRecord(candidate)
    && typeof candidate.name === "string" && candidate.name.trim() === candidate.name && candidate.name.length > 0
    && typeof candidate.contactToken === "string" && /^contact_[A-Za-z0-9_-]{43}$/.test(candidate.contactToken));
  if (!isRecord(contact) || typeof contact.contactToken !== "string") return false;
  const expectedGeneration = actionResult.view.generation;
  const afterActionStored = input.snapshots.read(input.sessionId);
  if (afterActionStored.status !== "ok") return false;
  const afterAction = validateCompiledSessionSnapshot(afterActionStored.value);
  if (afterAction.status !== "ok" || afterAction.value.generation !== expectedGeneration
    || afterAction.value.bundle.id !== input.publication.bundleId || afterAction.value.previousSnapshotHash !== currentDurable.snapshotHash
    || afterAction.value.stateHash === currentDurable.stateHash) return false;
  const firstInput = "What can you tell me about the clue we just uncovered?";
  const firstActionId = `full-quality-followup-${randomUUID()}`;
  const first = await input.playerRoute.runPhase({ module: input.publication.module, phase: "followup" }, () =>
    requestPlayer(`${base}/player-followups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactToken: contact.contactToken, actionId: firstActionId, expectedGeneration, playerInput: firstInput }),
    }),
  );
  if (first.status !== 200) return false;
  const firstResult: unknown = await first.json();
  if (!isRecord(firstResult) || firstResult.status !== "delivered" || !isRecord(firstResult.followup)
    || typeof firstResult.followup.text !== "string" || !firstResult.followup.text.trim()
    || !isRecord(firstResult.view) || firstResult.view.terminal === true || firstResult.view.generation !== expectedGeneration) return false;
  const afterFirstFollowupStored = input.snapshots.read(input.sessionId);
  if (afterFirstFollowupStored.status !== "ok") return false;
  const afterFirstFollowup = validateCompiledSessionSnapshot(afterFirstFollowupStored.value);
  if (afterFirstFollowup.status !== "ok" || afterFirstFollowup.value.generation !== expectedGeneration
    || afterFirstFollowup.value.snapshotHash !== afterAction.value.snapshotHash
    || afterFirstFollowup.value.stateHash !== afterAction.value.stateHash) return false;
  const secondInput = "Could you explain what you just told me a little more?";
  if (secondInput.length > 1_000) return false;
  const second = await input.playerRoute.runPhase({ module: input.publication.module, phase: "followup" }, () =>
    requestPlayer(`${base}/player-followups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactToken: contact.contactToken, actionId: `full-quality-followup-${randomUUID()}`, expectedGeneration, playerInput: secondInput, previousActionId: firstActionId }),
    }),
  );
  if (second.status !== 200) return false;
  const secondResult: unknown = await second.json();
  if (!isRecord(secondResult) || secondResult.status !== "delivered" || !isRecord(secondResult.followup)
    || typeof secondResult.followup.text !== "string" || !secondResult.followup.text.trim()
    || !isRecord(secondResult.view) || secondResult.view.terminal === true || secondResult.view.generation !== expectedGeneration) return false;
  const afterFollowupsStored = input.snapshots.read(input.sessionId);
  if (afterFollowupsStored.status !== "ok") return false;
  const afterFollowups = validateCompiledSessionSnapshot(afterFollowupsStored.value);
  if (afterFollowups.status !== "ok" || afterFollowups.value.generation !== expectedGeneration
    || afterFollowups.value.snapshotHash !== afterAction.value.snapshotHash
    || afterFollowups.value.stateHash !== afterAction.value.stateHash) return false;
  return { generation: expectedGeneration, previousSnapshotHash: currentDurable.snapshotHash };
}

/**
 * This is deliberately a host-local bridge, not an additional server route or
 * registry.  A campaign handle is only a candidate: the catalog read below
 * replays canonical validation before the normal compiled-session route sees
 * its opaque bundle ID.
 */
async function consumePublishedBundle(
  publication: TwoModulePublishedArtifact,
  options: {
    catalog: CompilerArtifactCatalog;
    snapshots: CompiledSessionSnapshotStore;
    storage: { careerRoot: string; sessionRoot: string };
    sessionRuntime: SessionRuntimeDependencies;
    stats: PublishedConsumptionStats;
    requirePublishedWorldModelBinding: boolean;
    playerRoute?: FullQualityPlayerRoute;
  },
): Promise<boolean> {
  const loaded = options.catalog.loadBundle(publication.bundleId);
  if (loaded.status !== "ok") return false;
  const bundle = loaded.value;
  if (bundle.id !== publication.bundleId
    || bundle.artifactHash !== publication.identity.resolvedArtifactHash
    || bundle.artifact.artifactHash !== publication.identity.resolvedArtifactHash
    || bundle.identity.moduleId !== publication.identity.moduleId
    || bundle.identity.documentHash !== publication.identity.documentHash
    || bundle.identity.sourceGraphIdentity !== publication.identity.sourceGraphIdentity
    || bundle.identity.preparedQueueHash !== publication.identity.preparedQueueHash) return false;
  const worldModelBinding = bundle.worldModelBinding;
  if (worldModelBinding && (worldModelBinding.moduleId !== publication.identity.moduleId
    || worldModelBinding.artifactHash !== publication.identity.resolvedArtifactHash)) return false;
  if (options.requirePublishedWorldModelBinding && !worldModelBinding) return false;

  let sessionId: string | undefined;
  let worldModelReceiptScopeHash: string | undefined;
  try {
    const create = await handleRequest(new Request("http://offline-host/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: publication.bundleId, archetype: "investigator", characterName: "Offline verifier" }),
    }), options.catalog, options.snapshots, options.storage, {}, {}, () => ({
      status: "authenticated",
      principal: { id: "offline-two-module-host", role: "operator" },
    }), undefined, undefined, options.playerRoute?.delivery, undefined, options.sessionRuntime);
    if (create.status !== 201) return false;
    const created: unknown = await create.json();
    if (!isRecord(created) || typeof created.sessionId !== "string" || !created.sessionId.trim() || !isSafeInteger(created.generation)) return false;
    const activeSessionId = created.sessionId;
    sessionId = activeSessionId;
    const firstStored = options.snapshots.read(activeSessionId);
    if (firstStored.status !== "ok") return false;
    const firstDurable = validateCompiledSessionSnapshot(firstStored.value);
    if (firstDurable.status !== "ok" || firstDurable.value.bundle.id !== publication.bundleId || firstDurable.value.generation !== created.generation) return false;
    // The normal compiled-session route reloaded the exact catalog bundle and
    // GameSession revalidated its binding before this durable snapshot was
    // written. This is not a local corpus provenance/prompt receipt.
    if (worldModelBinding) options.stats.publishedWorldModelBoundSessionCreations++;
    if (options.requirePublishedWorldModelBinding && worldModelBinding) {
      const session = options.sessionRuntime.registry?.get(activeSessionId);
      if (!session) return false;
      // Construct the real GameSession opening context without permitting a
      // provider dispatch. The aborted signal is checked by the configured
      // client before transport; the receipt is created immediately after
      // the catalog-bound module supplies its scoped local reference.
      const openingAbort = new AbortController();
      openingAbort.abort();
      try { await session.getOpeningScene(openingAbort.signal); } catch { /* expected cancelled opening after local context assembly */ }
      const receipt = session.getCompiledWorldModelPromptReceipt();
      if (!receipt || receipt.scopeHash !== worldModelBinding.scopeHash || receipt.provenance.length === 0
        || !receipt.provenance.every((entry) => entry.scopeHash === worldModelBinding.scopeHash
          && worldModelBinding.allowedWorkIds.includes(entry.workId))) return false;
      worldModelReceiptScopeHash = receipt.scopeHash;
    }

    const requestSession = (request: Request) => handleRequest(request, options.catalog, options.snapshots, options.storage, {}, {}, () => ({
      status: "authenticated" as const,
      principal: { id: "offline-two-module-host", role: "operator" as const },
    }), undefined, undefined, undefined, undefined, options.sessionRuntime);
    const readAvailableActionIds = async (expectedGeneration: number, expectedStateHash: string): Promise<string[] | undefined> => {
      // A recovery retry must still refer to the exact catalog bundle that
      // was handed to this consumer, not an in-memory publication candidate.
      const reloaded = options.catalog.loadBundle(publication.bundleId);
      if (reloaded.status !== "ok" || reloaded.value.bundleHash !== bundle.bundleHash
        || reloaded.value.artifactHash !== publication.identity.resolvedArtifactHash) return undefined;
      const available = await requestSession(new Request(
        `http://offline-host/api/sessions/${encodeURIComponent(activeSessionId)}/compiled/actions?pcId=p1`,
      ));
      if (available.status !== 200) return undefined;
      const availability: unknown = await available.json();
      if (!isRecord(availability) || !isSafeInteger(availability.generation) || availability.generation !== expectedGeneration
        || !Array.isArray(availability.actions)
        || !isRecord(availability.compiled) || typeof availability.compiled.stateHash !== "string" || availability.compiled.stateHash !== expectedStateHash
        || !isRecord(availability.compiled.state) || typeof availability.compiled.state.currentSceneId !== "string") return undefined;
      const mechanisms = availability.actions.flatMap((action) => isRecord(action) && typeof action.mechanismId === "string" && action.mechanismId.trim()
        ? [action.mechanismId]
        : []);
      return mechanisms.length === availability.actions.length ? mechanisms : undefined;
    };
    const restoredArtifact = restoreCompilerArtifact(bundle.artifact);
    if (restoredArtifact.status === "refused" || restoredArtifact.stage !== "resolved") return false;
    const resolvedPayload = restoredArtifact.payload;
    const failbackLimitFor = (mechanismId: string): number | undefined => {
      const discovery = resolvedPayload.mechanicsIR.discoveryMethods.find((candidate) => candidate.id === mechanismId);
      const failback = discovery?.failback;
      if (!discovery || !failback || !Number.isSafeInteger(failback.maxFailures) || failback.maxFailures < 1 || failback.maxFailures > 10
        || !failback.effects.some((effect) => effect.kind === "discover_clue" && effect.clueId === discovery.clueId)) return undefined;
      return failback.maxFailures;
    };
    let durable = firstDurable.value;
    if (options.playerRoute) {
      const playerWitness = await runFullQualityPlayerRoute({
        publication,
        sessionId: activeSessionId,
        creation: created,
        initialSnapshotHash: firstDurable.value.snapshotHash,
        catalog: options.catalog,
        snapshots: options.snapshots,
        storage: options.storage,
        sessionRuntime: options.sessionRuntime,
        playerRoute: options.playerRoute,
      });
      if (!playerWitness) return false;
      const afterPlayer = options.snapshots.read(activeSessionId);
      if (afterPlayer.status !== "ok") return false;
      const validatedAfterPlayer = validateCompiledSessionSnapshot(afterPlayer.value);
      if (validatedAfterPlayer.status !== "ok" || validatedAfterPlayer.value.bundle.id !== publication.bundleId
        || validatedAfterPlayer.value.generation !== playerWitness.generation
        || validatedAfterPlayer.value.generation <= firstDurable.value.generation
        || validatedAfterPlayer.value.previousSnapshotHash !== playerWitness.previousSnapshotHash
        || validatedAfterPlayer.value.stateHash === firstDurable.value.stateHash) return false;
      durable = validatedAfterPlayer.value;
    }
    const initialActions = await readAvailableActionIds(durable.generation, durable.stateHash);
    const mechanismId = initialActions?.[0];
    if (!mechanismId) return false;
    let remainingFailbackSteps: number | undefined;
    // This host probes at most ten failed checks plus one deterministic
    // failback. That matches the bounded clue-facet contract it verifies;
    // a larger otherwise-valid IR is consumer-refused here, not declared an
    // invalid compiler mechanism. This is local HTTP consumption, not an
    // LLM/fetch allowance.
    for (let step = 0; step < 11; step++) {
      const before = durable;
      const beforeFailureCount = before.state.failureCounts[mechanismId] ?? 0;
      const beforeTraceLength = before.trace.length;
      const action = await requestSession(new Request(
        `http://offline-host/api/sessions/${encodeURIComponent(activeSessionId)}/compiled/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mechanismId,
            pcId: "p1",
            actionId: `offline-consume-${randomUUID()}`,
            expectedGeneration: before.generation,
          }),
        },
      ));
      if (action.status !== 200) return false;
      const committed: unknown = await action.json();
      if (!isRecord(committed) || !isSafeInteger(committed.generation) || committed.generation !== before.generation + 1) return false;
      const durableStored = options.snapshots.read(activeSessionId);
      if (durableStored.status !== "ok") return false;
      const next = validateCompiledSessionSnapshot(durableStored.value);
      if (next.status !== "ok" || next.value.bundle.id !== publication.bundleId
        || next.value.generation !== committed.generation || next.value.previousSnapshotHash !== before.snapshotHash
        || next.value.stateHash === before.stateHash) return false;
      const traceDelta = next.value.trace.slice(beforeTraceLength);
      const traceIsContinuous = traceDelta.length > 0
        && traceDelta[0]?.beforeStateHash === before.stateHash
        && traceDelta.at(-1)?.afterStateHash === next.value.stateHash
        && traceDelta.every((edge, index) => index === 0 || traceDelta[index - 1]?.afterStateHash === edge.beforeStateHash);
      const selectedAction = traceDelta.find((edge) => edge.mechanismId === mechanismId
        && ["success", "failure", "failback", "traverse", "attack"].includes(edge.outcome));
      const stateProgressed = next.value.state.currentSceneId !== before.state.currentSceneId
        || next.value.state.foundClueIds.join("\u0000") !== before.state.foundClueIds.join("\u0000")
        || next.value.state.terminalEndingId !== before.state.terminalEndingId;
      if (!traceIsContinuous || !selectedAction) return false;
      if (stateProgressed) {
        durable = next.value;
        break;
      }
      if (selectedAction.outcome !== "failure") return false;
      const maxFailures = failbackLimitFor(mechanismId);
      const afterFailureCount = next.value.state.failureCounts[mechanismId] ?? 0;
      if (!maxFailures || beforeFailureCount >= maxFailures || afterFailureCount !== beforeFailureCount + 1) return false;
      remainingFailbackSteps = maxFailures - afterFailureCount + 1;
      if (remainingFailbackSteps < 1 || remainingFailbackSteps > 10 || step + remainingFailbackSteps >= 11) return false;
      durable = next.value;
      const available = await readAvailableActionIds(durable.generation, durable.stateHash);
      if (!available?.includes(mechanismId)) return false;
    }
    const stateProgressed = durable.state.currentSceneId !== firstDurable.value.state.currentSceneId
      || durable.state.foundClueIds.join("\u0000") !== firstDurable.value.state.foundClueIds.join("\u0000")
      || durable.state.terminalEndingId !== firstDurable.value.state.terminalEndingId;
    if (!stateProgressed || remainingFailbackSteps !== undefined && durable.state.failureCounts[mechanismId] !== undefined && (durable.state.failureCounts[mechanismId] ?? 0) > 10) return false;
    options.stats.publishedBundleConsumptions++;
    options.stats.compiledActionWitnesses++;
    if (worldModelReceiptScopeHash) {
      options.stats.publishedWorldModelReceiptWitnesses++;
      options.stats.publishedWorldModelScopeHashes.add(worldModelReceiptScopeHash);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (sessionId) {
      const session = options.sessionRuntime.registry?.get(sessionId);
      session?.close();
      options.sessionRuntime.registry?.delete(sessionId);
    }
  }
}

/**
 * Run the existing two-module workflow against the actual internal HTTP
 * handler. It is an offline composition seam: no provider, endpoint, or
 * credential is built here. The injected LLMLike call count is observable;
 * any lower-layer network behavior remains deliberately unobserved.
 */
export async function runOfflineTwoModuleHttpCampaignHost(
  input: OfflineTwoModuleHttpCampaignHostInput,
): Promise<OfflineTwoModuleHttpCampaignHostReport> {
  const documents = input.documents ?? REAL_MODEL_DOCUMENTS;
  const reader = input.readDocument ?? ((document) => new Uint8Array(readFileSync(document.path)));
  const staged = await stageDocuments(documents, reader);
  const cachedReader = stagedReader(staged);
  const authorized = exactTwoModuleDocuments(documents)
    && staged.readable
    && staged.hashes.length === documents.length
    && uploadsAreAuthorized(staged.hashes, input.allowedDocumentHashes);

  // Do not create a directory, a durable lease, or a model wrapper before the
  // two exact local bytes have passed the existing per-document hash gate.
  if (!authorized) {
    const campaign = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: input.allowedDocumentHashes,
      readDocument: cachedReader,
      maxAutoResolveAttemptsPerModule: input.maxAutoResolveAttemptsPerModule,
      ...(input.interleaveAutoResolveAttempts === true ? { interleaveAutoResolveAttempts: true } : {}),
      ...(input.runAutoResolveAttempt ? { runAutoResolveAttempt: input.runAutoResolveAttempt } : {}),
      transport: async () => { throw new Error("unauthorized_host_transport"); },
    });
    return {
      campaign,
      host: {
        mode: "offline_injected",
        llmChatCalls: 0,
        inProcessHttpNetworkRequests: 0,
        externalNetworkRequests: "not_observed",
        admissionControllers: 0,
        publishedBundleConsumptions: 0,
        compiledActionWitnesses: 0,
        publishedWorldModelBoundSessionCreations: 0,
        publishedWorldModelReceiptWitnesses: 0,
        publishedWorldModelScopeHashes: [],
        cleanup: "not_created",
      },
    };
  }

  const root = mkdtempSync(join(tmpdir(), TEMPORARY_ROOT_PREFIX));
  const ownedCanonicalRoot = canonicalOwnedTemporaryRoot(root);
  if (!ownedCanonicalRoot) throw new Error("offline_host_temporary_root_unverified");
  let trackedLlm: DrainTrackingLLM | undefined;
  let deferredCleanupScheduled = false;
  let possibleHandlerBackgroundDrain = false;
  const scheduleDeferredCleanup = () => {
    if (!trackedLlm || deferredCleanupScheduled) return;
    deferredCleanupScheduled = true;
    // This retained, host-owned root is removed only after the exact injected
    // calls settle. No report includes its filesystem path.
    void trackedLlm.settle().then(() => {
      const removed = removeOwnedTemporaryRoot(root, ownedCanonicalRoot);
      if (removed) safelyObserveCleanup(input, "removed");
    });
  };
  try {
    const catalog = new CompilerArtifactCatalog({ root, maxEntries: CATALOG_MAX_ENTRIES, maxBytes: CATALOG_MAX_BYTES });
    // This exact controller, rooted alongside the disposable catalog, is
    // shared for both modules. It is never rebuilt from request data.
    // Both modules use one host principal. The normal four-start window stays
    // intact for legacy/smoke jobs; the explicit larger continuation budget
    // can admit eight turns for each of the two fixed modules.
    const requestedAttempts = input.maxAutoResolveAttemptsPerModule;
    const admission = new CompilerAutoAdmissionController({
      ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
      ...(requestedAttempts !== undefined && requestedAttempts > LIVE_HTTP_CAMPAIGN_LIMITS.maxAutoResolveAttemptsPerModule
        ? { startsPerPrincipal: requestedAttempts * 2 }
        : {}),
      root,
    });
    const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
    // The injected admission coordinator verifies this exact host-owned
    // namespace root instead of asking the route to create an implicit one.
    mkdirSync(storage.sessionRoot, { recursive: true });
    const snapshots = new CompiledSessionSnapshotStore({ root: join(storage.sessionRoot, "compiled-snapshots") });
    const sessionRuntime: SessionRuntimeDependencies = {
      registry: new Map<string, GameSession>(),
      sessionNamespace: new SessionNamespaceCoordinator(storage.sessionRoot),
      compiledSessionCreationAdmission: new CompiledSessionCreationAdmissionCoordinator({
        root: storage.sessionRoot,
        ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
      }),
      generateCompiledSessionId: () => randomUUID(),
      resolveCompiledWorldModelBinding: input.resolveCompiledWorldModelBinding,
      // Structured /compiled/actions remains deterministic; never construct
      // a default narration client while this offline host consumes a bundle.
      compiledNarrationOptions: { isLlmEnabled: () => false },
    };
    const consumptionStats: PublishedConsumptionStats = {
      publishedBundleConsumptions: 0,
      compiledActionWitnesses: 0,
      publishedWorldModelBoundSessionCreations: 0,
      publishedWorldModelReceiptWitnesses: 0,
      publishedWorldModelScopeHashes: new Set<string>(),
    };
    trackedLlm = new DrainTrackingLLM(input.llm);
    const fullQualityPlayerRoute = input.fullQualityPlayerRoute && {
      ...input.fullQualityPlayerRoute,
      // Keep player provider work under the same owned drain as compiler work.
      llm: trackedLlm,
    } satisfies FullQualityPlayerRoute;
    try { input.observeAdmissionController?.(admission); } catch { /* test-only observer */ }
    const boundedLlm = new BudgetedRedactingLLM(trackedLlm, input.llmBudget);
    const dependencies = internalDependencies(catalog, boundedLlm, input, admission);
    const campaign = await runTwoModuleHttpCampaign({
      documents,
      allowedDocumentHashes: input.allowedDocumentHashes,
      readDocument: cachedReader,
      maxAutoResolveAttemptsPerModule: input.maxAutoResolveAttemptsPerModule,
      ...(input.interleaveAutoResolveAttempts === true ? { interleaveAutoResolveAttempts: true } : {}),
      ...(input.runAutoResolveAttempt ? { runAutoResolveAttempt: input.runAutoResolveAttempt } : {}),
      consumePublished: (publication) => consumePublishedBundle(publication, {
        catalog,
        snapshots,
        storage,
        sessionRuntime,
        stats: consumptionStats,
        requirePublishedWorldModelBinding: input.requirePublishedWorldModelBinding === true,
        ...(fullQualityPlayerRoute ? { playerRoute: fullQualityPlayerRoute } : {}),
      }),
      transport: async (request) => {
        const isAutoResolve = new URL(request.url).pathname === "/api/compiler/auto-resolve";
        try {
          const response = await handleCompiledModuleHttpRequest(request, dependencies);
          if (!response) throw new Error("offline_handler_route_unrecognized");
          if (isAutoResolve) await safelyObserveAutoResolveResponse(input, response);
          // A 5xx auto response can leave an aborted provider drain under the
          // handler's own lease. Preserve this owned temp root instead of
          // removing catalog state that a live drain could still require.
        if (isAutoResolve && response.status >= 500) possibleHandlerBackgroundDrain = true;
        return response;
      } catch (error) {
        if (isAutoResolve) possibleHandlerBackgroundDrain = true;
        throw error;
        }
      },
    });
    let injectedLlmDrain = false;
    if (!possibleHandlerBackgroundDrain && !await trackedLlm.settleWithinGrace()) {
      injectedLlmDrain = true;
      scheduleDeferredCleanup();
    }
    const cleanup = possibleHandlerBackgroundDrain || injectedLlmDrain
      ? "cleanup_deferred"
      : (removeOwnedTemporaryRoot(root, ownedCanonicalRoot) ? "removed" : "cleanup_deferred");
    safelyObserveCleanup(input, cleanup);
    return {
      campaign,
      host: {
        mode: "offline_injected",
        llmChatCalls: boundedLlm.calls.length,
        inProcessHttpNetworkRequests: 0,
        externalNetworkRequests: "not_observed",
        admissionControllers: 1,
        publishedBundleConsumptions: consumptionStats.publishedBundleConsumptions,
        compiledActionWitnesses: consumptionStats.compiledActionWitnesses,
        publishedWorldModelBoundSessionCreations: consumptionStats.publishedWorldModelBoundSessionCreations,
        publishedWorldModelReceiptWitnesses: consumptionStats.publishedWorldModelReceiptWitnesses,
        publishedWorldModelScopeHashes: [...consumptionStats.publishedWorldModelScopeHashes].sort(),
        cleanup,
      },
    };
  } catch (error) {
    // An auto 5xx or transport exception can retain the handler's durable
    // admission/JSON-ingress drain beyond the LLM promise. There is no public
    // drain receipt here, so preserve the catalog rather than guessing it is
    // safe to delete. Normal post-handler exceptions can use the tracked
    // injected-call settlement path.
    if (possibleHandlerBackgroundDrain) {
      // No public handler-drain receipt exists. Preserve the root for an
      // operator rather than racing durable admission/JSON ingress cleanup.
    } else if (trackedLlm) scheduleDeferredCleanup();
    else {
      const removed = removeOwnedTemporaryRoot(root, ownedCanonicalRoot);
      if (removed) safelyObserveCleanup(input, "removed");
    }
    throw error;
  }
}

class LiveCampaignAdmissionError extends Error {
  constructor(readonly code: "external_fetch_budget_exhausted" | "external_fetch_deadline_reached" | "external_fetch_shape_refused") {
    super(code);
  }
}

type LiveAdmissionPolicy = Readonly<{
  mode: "smoke" | "full_quality";
  maxExternalFetchDispatches: number;
  maxTokensPerDispatch: number;
  maxReservedOutputTokens: number | null;
  maxAttempts: number;
  globalAdmissionDeadlineMs: number;
  maxProposalRounds: number;
  maxRequestsPerRound: number;
  maxAutoResolveAttemptsPerModule: number;
  perCallTimeoutMs: number;
}>;

type FullQualityAdmissionContext = Readonly<{
  module: HttpCampaignDocument["id"];
  phase: "compiler" | "player_intent" | "narration" | "followup";
}>;

interface LiveAdmissionTestProbe {
  /** Runs the supplied local test dispatch inside the same immutable ALS scope as a host phase. */
  run<T>(context: FullQualityAdmissionContext, dispatch: () => Promise<T>): Promise<T>;
  /** Snapshot is aggregate-only: it never exposes a URL, body, prompt, or scope. */
  snapshot(): Readonly<{ dispatches: number; reservedOutputTokens: number; deadlineStarted: boolean; deadlineReached: boolean }>;
}

const FULL_QUALITY_MODULE_RESERVATION = Object.freeze({
  maxExternalFetchDispatches: FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.maxExternalFetchDispatches / 2,
  maxReservedOutputTokens: FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.maxReservedOutputTokens / 2,
});

/**
 * Per-module phase slices reserve real capacity for the finite quality
 * sequence: one natural intent, one action narration, then two referential
 * follow-ups. The real adapters request 128 + 600 + 2*600 = 1,928 output
 * tokens. Compiler can therefore use no more than 96 of this module's 100
 * calls or 96k of its 100k token reservation. Only compiler is wired in this
 * patch; the other slices remain unavailable until their actual host routes
 * run under the same ALS context.
 */
const FULL_QUALITY_PHASE_RESERVATIONS = Object.freeze({
  compiler: Object.freeze({ maxExternalFetchDispatches: 96, maxReservedOutputTokens: 96_000 }),
  player_intent: Object.freeze({ maxExternalFetchDispatches: 1, maxReservedOutputTokens: 128 }),
  narration: Object.freeze({ maxExternalFetchDispatches: 1, maxReservedOutputTokens: 600 }),
  followup: Object.freeze({ maxExternalFetchDispatches: 2, maxReservedOutputTokens: 1_200 }),
});

function smokeAdmissionPolicy(): LiveAdmissionPolicy {
  return Object.freeze({
    mode: "smoke",
    maxExternalFetchDispatches: LIVE_HTTP_CAMPAIGN_LIMITS.maxExternalFetchDispatches,
    maxTokensPerDispatch: LIVE_HTTP_CAMPAIGN_LIMITS.maxTokens,
    maxReservedOutputTokens: null,
    maxAttempts: LIVE_HTTP_CAMPAIGN_LIMITS.maxAttempts,
    globalAdmissionDeadlineMs: LIVE_HTTP_CAMPAIGN_LIMITS.globalAdmissionDeadlineMs,
    maxProposalRounds: LIVE_HTTP_CAMPAIGN_LIMITS.maxProposalRounds,
    maxRequestsPerRound: LIVE_HTTP_CAMPAIGN_LIMITS.maxRequestsPerRound,
    maxAutoResolveAttemptsPerModule: LIVE_HTTP_CAMPAIGN_LIMITS.maxAutoResolveAttemptsPerModule,
    perCallTimeoutMs: LIVE_HTTP_CAMPAIGN_LIMITS.perCallTimeoutMs,
  });
}

function fullQualityAdmissionPolicy(globalAdmissionDeadlineMs: number): LiveAdmissionPolicy {
  return Object.freeze({
    mode: "full_quality",
    maxExternalFetchDispatches: FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.maxExternalFetchDispatches,
    maxTokensPerDispatch: FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.maxTokensPerDispatch,
    maxReservedOutputTokens: FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.maxReservedOutputTokens,
    maxAttempts: FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.maxAttempts,
    globalAdmissionDeadlineMs,
    // Keep each continuation small enough to preserve the existing queue
    // chunking semantics. Five continuations each allow two bounded rounds of
    // at most eight requests: 5 * (2 * 8) proposal calls plus one <=16-call
    // selector pass exactly fits the 96-call compiler phase reservation.
    // The campaign runner's established hard cap is eight continuations, so
    // this never expands its accepted attempt domain. Smoke stays smaller.
    maxProposalRounds: 2,
    maxRequestsPerRound: 8,
    maxAutoResolveAttemptsPerModule: 5,
    perCallTimeoutMs: LIVE_HTTP_CAMPAIGN_LIMITS.perCallTimeoutMs,
  });
}

function boundedLiveConfig(config: LLMConfig, maxTokens: number, baseUrl = config.baseUrl): LLMConfig {
  return {
    apiKey: config.apiKey,
    baseUrl,
    model: config.model,
    maxTokens,
    temperature: config.temperature,
  };
}

/** Canonicalize once, then give LLMClient and the admission gate the same URL. */
function configuredChatCompletionEndpoint(baseUrl: string): { baseUrl: string; chatCompletionUrl: string } | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const path = parsed.pathname.replace(/\/+$/, "");
    const normalizedBaseUrl = `${parsed.protocol}//${parsed.host}${path}`;
    return { baseUrl: normalizedBaseUrl, chatCompletionUrl: `${normalizedBaseUrl}/chat/completions` };
  } catch {
    return undefined;
  }
}

/**
 * Enforces the caller-facing LLM contract before LLMClient can select a
 * default/retry. The fetch admission below is still authoritative for actual
 * dispatches because a chat call can fail before (or race into) transport.
 */
class LiveCampaignLLM implements LLMLike {
  constructor(private readonly client: LLMClient, private readonly policy: LiveAdmissionPolicy) {}

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const requestedMaxTokens = typeof options.maxTokens === "number" && Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0
      ? options.maxTokens
      : this.policy.maxTokensPerDispatch;
    return this.client.chat(messages, {
      ...options,
      // A narrower caller budget (for example narration's 600) remains
      // authoritative. This wrapper only imposes the run's upper boundary.
      maxTokens: Math.min(requestedMaxTokens, this.policy.maxTokensPerDispatch),
      maxAttempts: this.policy.maxAttempts,
      timeout: Math.min(
        this.policy.perCallTimeoutMs,
        typeof options.timeout === "number" && Number.isFinite(options.timeout) && options.timeout > 0
          ? Math.trunc(options.timeout)
          : this.policy.perCallTimeoutMs,
      ),
    });
  }
}

function boundedFetchBody(init: RequestInit | undefined, maxTokensPerDispatch: number): { body: string; maxTokens: number } {
  const body = init?.body;
  if (typeof body !== "string") throw new LiveCampaignAdmissionError("external_fetch_shape_refused");
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const maxTokens = (parsed as { max_tokens?: unknown }).max_tokens;
    if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens)
      || maxTokens <= 0 || maxTokens > maxTokensPerDispatch) {
      throw new Error("invalid");
    }
    return { body, maxTokens };
  } catch {
    throw new LiveCampaignAdmissionError("external_fetch_shape_refused");
  }
}

/**
 * This process-local gate sits at the only fetch capability used by LLMClient
 * for this script invocation. It counts *dispatches* synchronously, before
 * the provider function receives a request; LLM call receipts alone are not a
 * reliable network budget because they are emitted after settlement.
 */
class LiveFetchAdmission {
  #dispatches = 0;
  #reservedOutputTokens = 0;
  #firstDispatchAt: number | undefined;
  #deadlineReached = false;
  #cancelDeadline: (() => void) | undefined;
  readonly #listenerReleases = new Set<() => void>();
  readonly #deadlineController = new AbortController();
  readonly #moduleReservations = new Map<HttpCampaignDocument["id"], { dispatches: number; reservedOutputTokens: number }>();
  readonly #phaseReservations = new Map<string, { dispatches: number; reservedOutputTokens: number }>();

  constructor(
    private readonly upstream: typeof fetch,
    private readonly now: () => number,
    private readonly scheduleDeadline: (callback: () => void, delayMs: number) => () => void,
    private readonly policy: LiveAdmissionPolicy,
    private readonly expectedChatCompletionUrl: string | undefined,
    private readonly fullQualityContext?: AsyncLocalStorage<FullQualityAdmissionContext>,
  ) {}

  get dispatches(): number { return this.#dispatches; }
  get reservedOutputTokens(): number { return this.#reservedOutputTokens; }
  get deadlineStarted(): boolean { return this.#firstDispatchAt !== undefined; }
  get deadlineReached(): boolean { return this.#deadlineReached; }

  readonly fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    // This script admits only LLMClient's explicit string-body POST. Rejecting
    // every other global fetch shape avoids accidentally granting an unrelated
    // network path a share of the provider budget.
    if (typeof input !== "string" || input !== this.expectedChatCompletionUrl || init?.method !== "POST") {
      throw new LiveCampaignAdmissionError("external_fetch_shape_refused");
    }
    const { body, maxTokens } = boundedFetchBody(init, this.policy.maxTokensPerDispatch);
    if (init.signal?.aborted) throw new LiveCampaignAdmissionError("external_fetch_shape_refused");
    if (this.#deadlineController.signal.aborted) {
      throw new LiveCampaignAdmissionError("external_fetch_deadline_reached");
    }
    const scope = this.fullQualityContext?.getStore();
    let moduleReservation: { dispatches: number; reservedOutputTokens: number } | undefined;
    let phaseReservation: { dispatches: number; reservedOutputTokens: number } | undefined;
    let phaseKey: string | undefined;
    if (this.policy.mode === "full_quality") {
      if (!scope || (scope.module !== "fuzu" && scope.module !== "barn")) {
        throw new LiveCampaignAdmissionError("external_fetch_shape_refused");
      }
      moduleReservation = this.#moduleReservations.get(scope.module) ?? { dispatches: 0, reservedOutputTokens: 0 };
      const phaseLimit = FULL_QUALITY_PHASE_RESERVATIONS[scope.phase];
      phaseKey = `${scope.module}\u0000${scope.phase}`;
      phaseReservation = this.#phaseReservations.get(phaseKey) ?? { dispatches: 0, reservedOutputTokens: 0 };
      if (moduleReservation.dispatches >= FULL_QUALITY_MODULE_RESERVATION.maxExternalFetchDispatches
        || moduleReservation.reservedOutputTokens + maxTokens > FULL_QUALITY_MODULE_RESERVATION.maxReservedOutputTokens
        || phaseReservation.dispatches >= phaseLimit.maxExternalFetchDispatches
        || phaseReservation.reservedOutputTokens + maxTokens > phaseLimit.maxReservedOutputTokens
        || this.#reservedOutputTokens + maxTokens > this.policy.maxReservedOutputTokens!) {
        throw new LiveCampaignAdmissionError("external_fetch_budget_exhausted");
      }
    }
    if (this.#dispatches >= this.policy.maxExternalFetchDispatches) {
      throw new LiveCampaignAdmissionError("external_fetch_budget_exhausted");
    }
    const now = this.now();
    if (this.#firstDispatchAt === undefined) {
      this.#firstDispatchAt = now;
      this.#cancelDeadline = this.scheduleDeadline(() => {
        this.#deadlineReached = true;
        this.#deadlineController.abort();
      }, this.policy.globalAdmissionDeadlineMs);
    } else if (now - this.#firstDispatchAt >= this.policy.globalAdmissionDeadlineMs) {
      this.#deadlineReached = true;
      this.#deadlineController.abort();
      throw new LiveCampaignAdmissionError("external_fetch_deadline_reached");
    }
    if (this.policy.mode === "full_quality") {
      // Reservations are irreversible: transport errors, timeouts, unknown
      // usage, and late response bodies never create a refund path.
      moduleReservation!.dispatches++;
      moduleReservation!.reservedOutputTokens += maxTokens;
      this.#moduleReservations.set(scope!.module, moduleReservation!);
      phaseReservation!.dispatches++;
      phaseReservation!.reservedOutputTokens += maxTokens;
      this.#phaseReservations.set(phaseKey!, phaseReservation!);
      this.#reservedOutputTokens += maxTokens;
    }
    this.#dispatches++;

    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    this.#deadlineController.signal.addEventListener("abort", abort, { once: true });
    const releaseListeners = () => {
      init.signal?.removeEventListener("abort", abort);
      this.#deadlineController.signal.removeEventListener("abort", abort);
      this.#listenerReleases.delete(releaseListeners);
    };
    this.#listenerReleases.add(releaseListeners);
    let responseReceived = false;
    try {
      const response = await this.upstream(input, {
        ...init,
        body,
        redirect: "error",
        signal: controller.signal,
      });
      responseReceived = true;
      // Keep both abort edges connected after headers arrive. LLMClient parses
      // the body later; disconnecting here would let an over-deadline body
      // continue even though the 45-second/global controllers were aborted.
      return response;
    } finally {
      if (!responseReceived) releaseListeners();
    }
  }) as unknown as typeof globalThis.fetch;

  dispose(): void {
    this.#cancelDeadline?.();
    this.#deadlineController.abort();
    for (const release of [...this.#listenerReleases]) release();
  }
}

async function runUnauthorizedLiveCampaign(
  documents: readonly TwoModuleHttpCampaignHostDocument[],
  allowedDocumentHashes: readonly string[],
  reader: (document: HttpCampaignDocument) => Uint8Array,
): Promise<TwoModuleHttpCampaignReport> {
  return runTwoModuleHttpCampaign({
    documents,
    allowedDocumentHashes,
    readDocument: reader,
    maxAutoResolveAttemptsPerModule: LIVE_HTTP_CAMPAIGN_LIMITS.maxAutoResolveAttemptsPerModule,
    transport: async () => { throw new LiveCampaignAdmissionError("external_fetch_shape_refused"); },
  });
}

function liveBudgetReport(policy: LiveAdmissionPolicy, values: {
  dispatches?: number;
  reservedOutputTokens?: number;
  deadlineStarted?: boolean;
  deadlineReached?: boolean;
} = {}): LiveTwoModuleHttpCampaignHostReport["budget"] {
  return {
    kind: "script_owned_external_fetch_admission",
    maxExternalFetchDispatches: policy.maxExternalFetchDispatches,
    observedExternalFetchDispatches: values.dispatches ?? 0,
    maxTokens: policy.maxTokensPerDispatch,
    ...(policy.maxReservedOutputTokens === null ? {} : {
      maxReservedOutputTokens: policy.maxReservedOutputTokens,
      reservedOutputTokens: values.reservedOutputTokens ?? 0,
    }),
    maxAttempts: policy.maxAttempts,
    globalAdmissionDeadlineMs: policy.globalAdmissionDeadlineMs,
    globalDeadlineStarted: values.deadlineStarted ?? false,
    globalDeadlineReached: values.deadlineReached ?? false,
    handlerDeadlineRemainsExisting: true,
  };
}

async function refusedLiveReport(
  documents: readonly TwoModuleHttpCampaignHostDocument[],
  allowedDocumentHashes: readonly string[],
  reader: (document: HttpCampaignDocument) => Uint8Array,
  policy: LiveAdmissionPolicy,
  forcePolicyRefusal = false,
  preflightReason?: Exclude<FullQualityPreflightReason, "ready">,
): Promise<LiveTwoModuleHttpCampaignHostReport> {
  // Reuse the driver's existing fail-closed no-transport branch. A source
  // profile preflight is host authorization, not an HTTP request failure;
  // passing no authorized hashes keeps the public report free of policy
  // details and guarantees the handler/model are never constructed.
  const campaign = await runUnauthorizedLiveCampaign(documents, forcePolicyRefusal ? [] : allowedDocumentHashes, reader);
  return {
    campaign,
    host: {
      mode: "live_llm_client",
      llmChatCalls: 0,
      inProcessHttpNetworkRequests: 0,
      externalNetworkRequests: 0,
      admissionControllers: 0,
      publishedBundleConsumptions: 0,
      compiledActionWitnesses: 0,
      publishedWorldModelBoundSessionCreations: 0,
      publishedWorldModelReceiptWitnesses: 0,
      publishedWorldModelScopeHashes: [],
      cleanup: "not_created",
    },
    budget: liveBudgetReport(policy),
    ...(preflightReason ? { preflightReason } : {}),
  };
}

function fullQualityDeadline(mode: FullQualityCampaignMode): number | undefined {
  const requested = mode.globalAdmissionDeadlineMs ?? FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.defaultGlobalAdmissionDeadlineMs;
  return Number.isSafeInteger(requested) && requested > 0
    && requested <= FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.maxGlobalAdmissionDeadlineMs
    ? requested
    : undefined;
}

/**
 * The live composition is deliberately separate from the offline injection
 * seam: callers must opt into an existing LLMClient configuration and the
 * script will install its bounded fetch admission before the first dispatch.
 */
export async function runLiveTwoModuleHttpCampaignHost(
  input: LiveTwoModuleHttpCampaignHostInput,
): Promise<LiveTwoModuleHttpCampaignHostReport> {
  const fullQuality = input.fullQuality;
  const fullQualityDeadlineMs = fullQuality ? fullQualityDeadline(fullQuality) : undefined;
  const policy = fullQuality
    ? fullQualityAdmissionPolicy(fullQualityDeadlineMs ?? FULL_QUALITY_HTTP_CAMPAIGN_LIMITS.defaultGlobalAdmissionDeadlineMs)
    : smokeAdmissionPolicy();
  const documents = input.documents ?? REAL_MODEL_DOCUMENTS;
  const reader = input.readDocument ?? ((document) => new Uint8Array(readFileSync(document.path)));
  const staged = await stageDocuments(documents, reader);
  const cachedReader = stagedReader(staged);
  const authorized = exactTwoModuleDocuments(documents)
    && staged.readable
    && staged.hashes.length === documents.length
    && uploadsAreAuthorized(staged.hashes, input.allowedDocumentHashes);
  if (!authorized) {
    return refusedLiveReport(documents, input.allowedDocumentHashes, cachedReader, policy, false,
      fullQuality ? "upload_not_authorized" : undefined);
  }
  if (fullQuality && fullQualityDeadlineMs === undefined) {
    return refusedLiveReport(documents, input.allowedDocumentHashes, cachedReader, policy, true, "full_quality_configuration_invalid");
  }

  // An explicitly injected, host-owned registry is meaningful even in
  // optional mode: it can persist a normal binding while legacy consumers do
  // not require one. We construct from process configuration only for the
  // explicit require gate, so default live operation never probes world
  // policy/configuration.
  let worldModelBindingRegistry = input.worldModelBindingRegistry;
  const requiresPublishedWorldModelBinding = input.requirePublishedWorldModelBinding === true || fullQuality !== undefined;
  if (requiresPublishedWorldModelBinding) {
    try {
      worldModelBindingRegistry ??= new CompiledWorldModelBindingRegistry();
    } catch {
      // A partial/bad environment is not a reason to let a fresh PDF reach
      // the model. Keep policy configuration details out of the report.
      return refusedLiveReport(documents, input.allowedDocumentHashes, cachedReader, policy, true,
        fullQuality ? "world_not_configured" : undefined);
    }
    const coversAuthorizedSources = worldModelBindingRegistry.status.enabled
      && documents.every((document) => {
        const bytes = staged.bytesByAlias.get(document.id);
        return bytes !== undefined
          && worldModelBindingRegistry?.hasSourceProfile(document.moduleId, sha256(bytes)) === true;
      });
    // Source profiles are the only fresh-artifact authority that can be
    // checked before mechanics creates the resolved artifact hash. Exact
    // legacy rules remain validated at actual publication time.
    if (!coversAuthorizedSources) {
      return refusedLiveReport(documents, input.allowedDocumentHashes, cachedReader, policy, true,
        fullQuality ? "world_not_configured" : undefined);
    }
  }

  const playerDelivery = fullQuality ? (fullQuality.playerDelivery ?? createEnvironmentPlayerDelivery()) : undefined;
  if (fullQuality && (!playerDelivery?.available || !playerDelivery.publicOrigin)) {
    return refusedLiveReport(documents, input.allowedDocumentHashes, cachedReader, policy, true, "player_delivery_not_configured");
  }

  const endpoint = configuredChatCompletionEndpoint(input.config.baseUrl);
  if (fullQuality && !endpoint) {
    return refusedLiveReport(documents, input.allowedDocumentHashes, cachedReader, policy, true, "full_quality_configuration_invalid");
  }

  const originalFetch = globalThis.fetch;
  const scheduleDeadline = input.scheduleDeadline ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  const fullQualityContext = fullQuality ? new AsyncLocalStorage<FullQualityAdmissionContext>() : undefined;
  const gate = new LiveFetchAdmission(
    originalFetch,
    input.now ?? Date.now,
    scheduleDeadline,
    policy,
    endpoint?.chatCompletionUrl,
    fullQualityContext,
  );
  globalThis.fetch = gate.fetch;
  try {
    const testProbe: LiveAdmissionTestProbe | undefined = fullQualityContext
      ? Object.freeze({
        run: <T>(context: FullQualityAdmissionContext, dispatch: () => Promise<T>) =>
          fullQualityContext.run(Object.freeze({ module: context.module, phase: context.phase }), dispatch),
        snapshot: () => Object.freeze({
          dispatches: gate.dispatches,
          reservedOutputTokens: gate.reservedOutputTokens,
          deadlineStarted: gate.deadlineStarted,
          deadlineReached: gate.deadlineReached,
        }),
    })
      : undefined;
    await input.beforeLiveCampaignDispatch?.(testProbe);
    const liveLlm = new LiveCampaignLLM(new LLMClient(boundedLiveConfig(
      input.config,
      policy.maxTokensPerDispatch,
      endpoint?.baseUrl ?? input.config.baseUrl,
    )), policy);
    const fullQualityPlayerRoute = fullQualityContext && playerDelivery
      ? {
        delivery: playerDelivery,
        llm: liveLlm,
        runPhase: <T>(context: { module: HttpCampaignDocument["id"]; phase: FullQualityPlayerPhase }, dispatch: () => Promise<T>) =>
          fullQualityContext.run(Object.freeze({ module: context.module, phase: context.phase }), dispatch),
      } satisfies FullQualityPlayerRoute
      : undefined;
    const offline = await runOfflineTwoModuleHttpCampaignHost({
      documents,
      allowedDocumentHashes: input.allowedDocumentHashes,
      readDocument: cachedReader,
      llm: liveLlm,
      llmBudget: {
        maxCalls: policy.maxExternalFetchDispatches,
        timeoutMs: policy.perCallTimeoutMs,
      },
      policy: {
        policyId: "live-two-module-http-campaign-v1",
        rightsStatus: "user_provided",
        allowSourceExactNpcEncounters: true,
        allowedSourceFactMechanicKinds: ["existing_clue_discovery", "prose_fact_finding"],
      },
      producer: { providerFingerprint: "live-redacted-v1", modelFingerprint: "configured-redacted-v1" },
      limits: {
        maxQuestionsPerRequest: 3,
        maxRequestsPerRound: policy.maxRequestsPerRound,
        maxRequestChars: 24_000,
        maxPromptChars: 24_000,
        maxResponseTokens: policy.maxTokensPerDispatch,
      },
      maxProposalRounds: policy.maxProposalRounds,
      maxAutoResolveAttemptsPerModule: policy.maxAutoResolveAttemptsPerModule,
      ...(fullQualityContext ? {
        interleaveAutoResolveAttempts: true,
        runAutoResolveAttempt: <T>({ module }: { module: HttpCampaignDocument["id"] }, dispatch: () => Promise<T>) =>
          fullQualityContext.run(Object.freeze({ module, phase: "compiler" }), dispatch),
      } : {}),
      ...(fullQualityPlayerRoute ? { fullQualityPlayerRoute } : {}),
      observeAdmissionController: input.observeAdmissionController,
      observeCleanup: input.observeCleanup,
      observeAutoResolveResponse: input.observeAutoResolveResponse,
      ...(input.machinePublicationEnabled === true ? { machinePublicationEnabled: true } : {}),
      ...(worldModelBindingRegistry ? { resolveCompiledWorldModelBinding: worldModelBindingRegistry.resolve } : {}),
      ...(requiresPublishedWorldModelBinding ? { requirePublishedWorldModelBinding: true } : {}),
    });
    return {
      campaign: offline.campaign,
      host: {
        ...offline.host,
        mode: "live_llm_client",
        externalNetworkRequests: gate.dispatches,
      },
      budget: liveBudgetReport(policy, {
        dispatches: gate.dispatches,
        reservedOutputTokens: gate.reservedOutputTokens,
        deadlineStarted: gate.deadlineStarted,
        deadlineReached: gate.deadlineReached,
      }),
      ...(fullQuality ? { preflightReason: "ready" as const } : {}),
    };
  } finally {
    gate.dispose();
    if (globalThis.fetch === gate.fetch) globalThis.fetch = originalFetch;
  }
}

class OfflineInvalidProposalLLM implements LLMLike {
  async chat(_messages: Message[], _options?: ChatOptions): Promise<string> {
    // The actual compiler adapter must reject this shape and leave a draft;
    // it is intentionally not a narrative/model-quality stand-in.
    return "{}";
  }
}

type HostCliArgs = {
  mode: "offline" | "live";
  allowedDocumentHashes: readonly string[];
  machinePublicationEnabled: boolean;
  requirePublishedWorldModelBinding: boolean;
};

function parseHostArgs(args: readonly string[]): HostCliArgs | undefined {
  const mode = args[0] === "--offline" || args[0] === "--live" ? args[0].slice(2) as HostCliArgs["mode"] : undefined;
  if (!mode) return undefined;
  const hashes: string[] = [];
  let machinePublicationEnabled = false;
  let requirePublishedWorldModelBinding = false;
  for (let index = 1; index < args.length; index++) {
    if (args[index] === "--machine-publication" && !machinePublicationEnabled) {
      machinePublicationEnabled = true;
      continue;
    }
    if (args[index] === "--require-world-model" && !requirePublishedWorldModelBinding) {
      requirePublishedWorldModelBinding = true;
      continue;
    }
    if (args[index] !== "--allow-upload-sha256") return undefined;
    const hash = args[++index];
    if (!hash || !/^[a-f0-9]{64}$/.test(hash) || hashes.includes(hash)) return undefined;
    hashes.push(hash);
  }
  if (hashes.length !== REAL_MODEL_DOCUMENTS.length) return undefined;
  // These are live-host publication policy capabilities. Offline invalid-LLM
  // diagnostics must not silently accept and ignore an authorization switch.
  if (mode === "offline" && (machinePublicationEnabled || requirePublishedWorldModelBinding)) return undefined;
  return { mode, allowedDocumentHashes: hashes, machinePublicationEnabled, requirePublishedWorldModelBinding };
}

function renderLiveReport(report: LiveTwoModuleHttpCampaignHostReport): string {
  return JSON.stringify({
    schemaVersion: "1.1.0",
    mode: report.host.mode,
    budget: report.budget,
    host: {
      mode: report.host.mode,
      llmChatCalls: report.host.llmChatCalls,
      inProcessHttpNetworkRequests: report.host.inProcessHttpNetworkRequests,
      externalNetworkRequests: report.host.externalNetworkRequests,
      admissionControllers: report.host.admissionControllers,
      publishedBundleConsumptions: report.host.publishedBundleConsumptions,
      compiledActionWitnesses: report.host.compiledActionWitnesses,
      publishedWorldModelBoundSessionCreations: report.host.publishedWorldModelBoundSessionCreations,
      publishedWorldModelReceiptWitnesses: report.host.publishedWorldModelReceiptWitnesses,
      publishedWorldModelScopeHashes: report.host.publishedWorldModelScopeHashes,
      cleanup: report.host.cleanup,
    },
    campaign: {
      schemaVersion: report.campaign.schemaVersion,
      autoResolveAttemptBudget: report.campaign.autoResolveAttemptBudget,
      modules: report.campaign.modules.map((module) => ({
        module: module.module,
        status: module.status,
        autoResolveAttempts: module.autoResolveAttempts,
        reportedProposalCalls: module.reportedProposalCalls,
        timing: module.timing,
        ...(module.code ? { code: module.code } : {}),
        ...(module.identity ? { identity: module.identity } : {}),
      })),
    },
  });
}

interface HostCliDependencies {
  readonly isLiveDisabled?: () => boolean;
  readonly readConfig?: () => LLMConfig;
  readonly hasUsableApiKey?: (apiKey: string | undefined) => boolean;
  readonly runLive?: (input: LiveTwoModuleHttpCampaignHostInput) => Promise<LiveTwoModuleHttpCampaignHostReport>;
  readonly writeStdout?: (line: string) => void;
  readonly writeStderr?: (line: string) => void;
}

/** Script-local CLI seam: tests can prove live mode preserves its fetch transport. */
export async function runHostCli(args: readonly string[], dependencies: HostCliDependencies = {}): Promise<number> {
  const parsed = parseHostArgs(args);
  const writeStdout = dependencies.writeStdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeStderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (!parsed) {
    writeStderr("usage_invalid");
    return 2;
  }
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  let fetchDispatchAttempts = 0;
  const offlineFetchGuard = (() => {
    fetchDispatchAttempts++;
    throw new Error("offline_fetch_forbidden");
  }) as unknown as typeof fetch;
  if (parsed.mode === "offline") globalThis.fetch = offlineFetchGuard;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    const isLiveDisabled = dependencies.isLiveDisabled ?? llmDisabledByOverride;
    const readConfig = dependencies.readConfig ?? loadConfig;
    const hasUsableApiKey = dependencies.hasUsableApiKey ?? isUsableLlmApiKey;
    const runLive = dependencies.runLive ?? runLiveTwoModuleHttpCampaignHost;
    if (parsed.mode === "live" && isLiveDisabled()) throw new Error("live_model_disabled");
    const config = parsed.mode === "live" ? readConfig() : undefined;
    if (config && !hasUsableApiKey(config.apiKey)) throw new Error("live_model_unavailable");
    if (parsed.mode === "offline") {
      const report = await runOfflineTwoModuleHttpCampaignHost({
        allowedDocumentHashes: parsed.allowedDocumentHashes,
        llm: new OfflineInvalidProposalLLM(),
        llmBudget: { maxCalls: 8, timeoutMs: 1_000 },
        policy: {
          policyId: "offline-two-module-http-host-v1",
          rightsStatus: "user_provided",
          allowSourceExactNpcEncounters: true,
          allowedSourceFactMechanicKinds: ["existing_clue_discovery", "prose_fact_finding"],
        },
        producer: { providerFingerprint: "offline-injected", modelFingerprint: "invalid-proposal" },
        limits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 2, maxRequestChars: 24_000, maxPromptChars: 24_000, maxResponseTokens: 128 },
        maxProposalRounds: 1,
      });
      writeStdout(JSON.stringify({ ...report, offlineFetchDispatchAttempts: fetchDispatchAttempts }));
    } else {
      const report = await runLive({
        allowedDocumentHashes: parsed.allowedDocumentHashes,
        config: config!,
        ...(parsed.machinePublicationEnabled ? { machinePublicationEnabled: true } : {}),
        ...(parsed.requirePublishedWorldModelBinding ? { requirePublishedWorldModelBinding: true } : {}),
      });
      writeStdout(renderLiveReport(report));
    }
    return 0;
  } catch {
    writeStdout(JSON.stringify({
      schemaVersion: "1.1.0",
      status: parsed.mode === "live" ? "live_host_failed" : "offline_host_failed",
      ...(parsed.mode === "offline" ? { offlineFetchDispatchAttempts: fetchDispatchAttempts } : {}),
    }));
    return 1;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    if (parsed.mode === "offline" && globalThis.fetch === offlineFetchGuard) globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runHostCli(process.argv.slice(2));
}

if (import.meta.main) void main();
