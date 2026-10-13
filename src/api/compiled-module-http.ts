import { resolveCompiler, type ResolvedCompilerApiResult } from "../compiler/compiler-api";
import { PDF_PREPARE_LIMITS, prepareUntrustedPdfCompilerArtifact } from "../compiler/compiler-pdf-prepare-isolation";
import type { CompilerArtifactEnvelope, ResolvedCompilerArtifactIdentity, ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import {
  buildTrustedPresentationReviewCandidatePage,
  buildTrustedPresentationReviewSlotPage,
  buildTrustedPresentationSelectionCandidatePage,
  buildTrustedPresentationSelectionSlotPage,
  projectTrustedResolvedCompilerArtifact,
  rehydrateTrustedPresentationSelections,
  trustedPresentationAudienceForFieldPath,
  trustedPresentationMachineCoverageIdentity,
  trustedPresentationMachineDecisionIdentity,
  TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE,
  TRUSTED_PRESENTATION_WORKBENCH_PLAN_SCHEMA_VERSION,
  TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE,
  type TrustedPresentationBinding,
  type TrustedPresentationAudience,
  type CompilerModuleDataProjection,
  type TrustedPresentationMachinePublication,
} from "../compiler/compiler-module-data-projection";
import type { ModuleCompileHints } from "../compiler/compiler-question-queue";
import { summarizeCompilerRuntimeQuality } from "../compiler/compiler-runtime-quality";
import { publicSourceFactDispositionAggregate } from "../compiler/source-fact-disposition";
import {
  orchestratePreparedAutoCompiler,
  type AutoCompilerDiagnostic,
  type AutoCompilerOrchestratorResult,
  type AutoCompilerProposalRound,
} from "./compiler-auto-orchestrator";
import type { CompilerHintProposalAdapterLimits, TrustedCompilerHintProposalProducer } from "./compiler-hint-proposal-adapter";
import type { TrustedCompilerHintProposalPolicy } from "../compiler/compiler-hint-proposals";
import type { LLMLike } from "../llm/client";
import {
  acknowledgeCompiledDurableSessionSnapshot,
  assertCompiledDurableHostCapability,
  createCompiledDurableSessionSnapshot,
  GameSession,
} from "./game-session";
import { validateCompiledModuleBundle, type ValidatedCompiledModuleBundle } from "./compiled-module-bundle";
import { CompilerArtifactCatalog, type AutoResolveMachinePublicationReservation, type BundleCatalogMetadata, type CatalogRefusalCode, type CatalogWriteIndeterminate, type CatalogWriteResult, type LoadedAutoResolveContinuation, type LoadedBundleCatalogEntry, type TrustedPresentationReviewMetadata } from "../compiler/compiler-artifact-catalog";
import { assertCompiledCthulhuWorldModelBindingArtifactIdentity, type CompiledCthulhuWorldModelBinding } from "../world/compiled-world-model-scope";
import { CharacterFactory } from "../character/character-factory";
import { COMPILED_SESSION_ACCESS_BINDING_SCHEMA_VERSION, CompiledSessionSnapshotPersistenceError, type CompiledSessionAccessBinding, type CompiledSessionSnapshot } from "./compiled-session-snapshot";
import type { CompiledPlayerDelivery, PlayerDeliveryInvitation } from "./player-delivery";
import { sha256 } from "../ingest/document-ir";
import { randomBytes } from "crypto";
import type { CompilerAutoAdmissionController, CompilerAutoAdmissionResult } from "./compiler-auto-admission";
import {
  SessionNamespaceFailure,
  type ReservationHandle,
  type SessionNamespaceCoordinator,
  type SessionNamespacePublicationObservation,
  type SessionNamespacePublicationPermit,
} from "./session-namespace-coordinator";
import {
  sharedPdfPrepareIngressAdmission,
  type PdfPrepareIngressAdmissionController,
} from "./compiler-pdf-ingress-admission";
import {
  sharedCompilerJsonIngressAdmission,
  type CompilerJsonIngressAdmissionController,
  type CompilerJsonIngressLease,
} from "./compiler-json-ingress-admission";
import {
  sharedCompiledSessionCreationIngressAdmission,
  type CompiledSessionCreationIngressAdmissionController,
  type CompiledSessionCreationIngressLease,
} from "./compiled-session-creation-ingress-admission";
import {
  type CompiledSessionCreationAdmissionCoordinator,
  type CompiledSessionCreationAdmissionResult,
} from "./compiled-session-creation-admission";

/** One mebibyte for compiler JSON and generic request bodies, enforced before and after decoding. */
export const COMPILER_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;
/** Eight mebibytes for authenticated original-PDF preparation only; callers cannot raise this cap. */
export const COMPILER_HTTP_PDF_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
/** Absolute server-owned wall-clock budget for consuming one compiler HTTP request body. */
export const COMPILER_HTTP_BODY_READ_DEADLINE_MS = 15_000;
const COMPILER_HTTP_BODY_READ_DEADLINE_MIN_MS = 10;
const COMPILER_HTTP_BODY_READ_DEADLINE_MAX_MS = 60_000;

type JsonRecord = Record<string, unknown>;
type ErrorStage = "auth" | "prepare" | "resolve" | "project" | "session" | "admission";
type SessionLike = GameSession;
type BodyReadRefusal = { kind: "refusal"; response: Response };
type BodyBytesResult = { kind: "bytes"; bytes: Uint8Array } | BodyReadRefusal;
type JsonBodyResult = { kind: "json"; body: JsonRecord } | BodyReadRefusal;
type BodyReaderReadResult = { done: false; value: Uint8Array } | { done: true; value?: undefined };
interface BodyReader {
  read(): Promise<BodyReaderReadResult>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/**
 * A failed/aborted read may leave `reader.cancel()` draining after the HTTP
 * response is ready. Keep that one reader-owned drain attached to its request
 * until the outer ingress owner transfers its lease.
 */
const bodyReaderDrains = new WeakMap<Request, Promise<void>>();

/** A compiler principal is resolved by the server host, never by request data. */
export type CompilerPrincipalRole = "operator" | "keeper" | "player";
export interface CompilerPrincipal {
  id: string;
  role: CompilerPrincipalRole;
}
export type CompilerAuthenticationResult =
  | { status: "authenticated"; principal: CompilerPrincipal }
  | { status: "unauthenticated" }
  | { status: "unavailable" };
export type CompilerRequestAuthenticator = (req: Request) => CompilerAuthenticationResult | Promise<CompilerAuthenticationResult>;

/**
 * Opaque, one-shot proof that this exact compiler HTTP request was already
 * authenticated by the server's cold-path guard. Its runtime authority is
 * private to this module; an object supplied through dependency injection is
 * never sufficient by itself.
 */
export type CompilerHttpRoutePreauthorization = object;

/**
 * A host-provided creation-time assignment. It deliberately receives only
 * the authenticated creator, never the request body, query, header, or a
 * caller-selected PC identifier.
 */
export type CompiledSessionPlayerAssignmentResult =
  | { status: "assigned"; principal: { id: string; role: "player" } }
  | { status: "unassigned" }
  | { status: "unavailable" };
export type CompiledSessionPlayerResolver = (creator: CompilerPrincipal) => CompiledSessionPlayerAssignmentResult | Promise<CompiledSessionPlayerAssignmentResult>;

/**
 * A server-owned publication decision for one already-validated resolved
 * artifact. HTTP inputs never participate in this capability or its scope.
 */
export type CompiledWorldModelBindingResolver = (
  identity: Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>,
) => CompiledCthulhuWorldModelBinding | undefined;

/** Internal-only identity for binding recovery to one exact durable publish. */
export interface CompiledSessionRecoverySnapshotIdentity {
  sessionId: string;
  bundleId: string;
  generation: number;
  snapshotHash: string;
}

export interface CompiledModuleHttpDependencies {
  /** The server-only capability installed in every compiled durable session it creates. */
  compiledDurableHostCapability?: object;
  /**
   * Host orchestration seam for the post-publish acknowledgement. Production
   * uses the canonical capability helper below; tests may inject a failure to
   * prove a durable generation-zero body is recovered rather than discarded.
   */
  acknowledgeCompiledSnapshot?(
    session: GameSession,
    snapshot: CompiledSessionSnapshot,
  ): void;
  createSession(id: string, archetype: string, characterName: string, persona: { personality?: string; backstory?: string; currentGoal?: string }): SessionLike;
  hasSession(id: string): boolean;
  registerSession(id: string, session: SessionLike): void;
  /** Removes only the exact request-local object, never a concurrent adopter. */
  unregisterSession?(id: string, expectedSession: SessionLike): void;
  /** Must consume `permit` before its first snapshot-root write and return exact readback evidence. */
  persistSession(id: string, session: SessionLike, bundleId: string, snapshot: CompiledSessionSnapshot, permit?: SessionNamespacePublicationPermit): SessionNamespacePublicationObservation | void;
  hasDurableSession?(id: string): boolean;
  rollbackSessionStorage?(id: string): void;
  /**
   * Re-validates and conditionally installs a durable compiled session after
   * a generation-zero publication may already have committed.  This is a
   * host-owned recovery path: implementations must not trust request input.
   */
  recoverPersistedSession?(
    id: string,
    expectedSession: SessionLike | undefined,
    principal: CompilerPrincipal,
    expectedSnapshot: CompiledSessionRecoverySnapshotIdentity,
  ): SessionLike | undefined;
  generateId(): string;
  /**
   * Host policy only: an absolute wall-clock body-read deadline. Request
   * headers, query data, and body data cannot change it. Invalid host values
   * fall back to the fixed production default.
   */
  bodyReadDeadlineMs?: number;
  /**
   * Process-local server ingress admission for untrusted PDF bodies. The
   * production default is the module-shared capability; this injection exists
   * only for a host-controlled test boundary.
   */
  pdfPrepareIngressAdmission?: PdfPrepareIngressAdmissionController;
  /**
   * Process-local ingress admission for public compiler JSON bodies. The
   * production default is the module-shared controller; injection is only a
   * host/test seam and must never be created by an individual request.
   */
  jsonIngressAdmission?: CompilerJsonIngressAdmissionController;
  /**
   * Process-local ingress admission for compiled durable-session creation.
   * Production uses the module-shared controller; injection is a host/test
   * seam and must not create controller state per request.
   */
  compiledSessionCreationIngressAdmission?: CompiledSessionCreationIngressAdmissionController;
  /**
   * Host-owned SQLite admission. This durable lease is required in addition
   * to the outer process-local ingress lease; there is intentionally no
   * request-time fallback coordinator.
   */
  compiledSessionCreationAdmission?: CompiledSessionCreationAdmissionCoordinator;
  /** Host-owned, cross-process runtime namespace. Request input cannot replace it. */
  sessionNamespace?: SessionNamespaceCoordinator;
  logError?(error: unknown): void;
  /**
   * Host-owned authentication seam. It must derive a principal from a trusted
   * server credential, not a body, query parameter, or caller-declared role.
   */
  authenticateCompilerRequest?: CompilerRequestAuthenticator;
  /**
   * Server-private one-shot authorization carried from the cold-path guard.
   * Supplying an unknown value is fail-closed and never falls back to another
   * authenticator invocation.
   */
  compilerHttpRoutePreauthorization?: CompilerHttpRoutePreauthorization;
  /** Optional host trust seam. Without it durable compiled sessions are owner-only. */
  resolveCompiledSessionPlayer?: CompiledSessionPlayerResolver;
  /** Optional browser p1 delivery capability. Missing/invalid deployment configuration is owner-only. */
  playerDelivery?: CompiledPlayerDelivery;
  /**
   * Host-owned, operator-gated recovery seam for a persisted reclaim
   * quarantine. It receives no request data and must clear only the exact
   * fence selected by the durable controller.
   */
  recoverAutoAdmissionReclaimQuarantine?: () => boolean;
  catalog?: CompilerArtifactCatalog;
  /**
   * Optional trusted publication capability. It receives only the exact
   * validated resolved artifact identity, never body-controlled scope data.
   */
  resolveCompiledWorldModelBinding?: CompiledWorldModelBindingResolver;
  /** Server-owned model capability and policy; never read from an HTTP body. */
  autoCompiler?: {
    llm: LLMLike;
    policy: TrustedCompilerHintProposalPolicy;
    producer: TrustedCompilerHintProposalProducer;
    limits: CompilerHintProposalAdapterLimits;
    maxProposalRounds: number;
    /** Shared, process-local server admission capability for model work. */
    admission: CompilerAutoAdmissionController;
    /**
     * Optional host-owned machine publisher. Request bodies never select this
     * service or its scope policy. Absence deliberately preserves draft-only
     * automatic mechanics resolution.
     */
    machinePublisher?: MachinePresentationPublisher;
  };
}

export interface MachinePresentationSelectionInput {
  readonly identity: Readonly<ResolvedCompilerArtifactIdentity>;
  readSlotPage(offset: number): ReturnType<typeof buildTrustedPresentationSelectionSlotPage>;
  readCandidatePage(fieldPath: string, offset: number): ReturnType<typeof buildTrustedPresentationSelectionCandidatePage>;
  readonly signal: AbortSignal;
}

/** Host-owned producer only. Its selections are untrusted until rehydrated. */
export interface MachinePresentationPublisher {
  readonly servicePrincipalId: string;
  readonly policyId: string;
  select(input: MachinePresentationSelectionInput): Promise<{
    selections: readonly unknown[];
    scopes: readonly unknown[];
    requestHash: string;
    responseHash: string;
  }>;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A recovery acknowledgement is valid only for a complete immutable identity.
 * Keep this deliberately stricter than a truthy snapshot object: mocks or
 * partially-built local state must never reach a durable recovery callback.
 */
function recoverySnapshotIdentity(snapshot: unknown): CompiledSessionRecoverySnapshotIdentity | undefined {
  if (!isRecord(snapshot) || !isRecord(snapshot.bundle)
    || typeof snapshot.sessionId !== "string" || !snapshot.sessionId
    || typeof snapshot.bundle.id !== "string" || !snapshot.bundle.id
    || typeof snapshot.generation !== "number" || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0
    || typeof snapshot.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.snapshotHash)) return undefined;
  return {
    sessionId: snapshot.sessionId,
    bundleId: snapshot.bundle.id,
    generation: snapshot.generation,
    snapshotHash: snapshot.snapshotHash,
  };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function refusal(stage: ErrorStage, code: string, message: string, status: number, causeCode?: string): Response {
  return json({ error: { stage, code, message, ...(causeCode ? { causeCode } : {}) } }, status);
}

function contentType(req: Request): string {
  return (req.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function bodyReadDeadlineMs(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= COMPILER_HTTP_BODY_READ_DEADLINE_MIN_MS
    && value <= COMPILER_HTTP_BODY_READ_DEADLINE_MAX_MS
    ? value
    : COMPILER_HTTP_BODY_READ_DEADLINE_MS;
}

function bodyReadRefusal(stage: ErrorStage, code: "CONTENT_LENGTH_INVALID" | "BODY_TOO_LARGE" | "REQUEST_BODY_INVALID" | "REQUEST_BODY_ABORTED" | "REQUEST_BODY_TIMEOUT"): BodyReadRefusal {
  const refusalByCode = {
    CONTENT_LENGTH_INVALID: ["Content-Length must be a non-negative integer", 400],
    BODY_TOO_LARGE: ["request body exceeds the compiler HTTP limit", 413],
    REQUEST_BODY_INVALID: ["request body could not be read", 400],
    REQUEST_BODY_ABORTED: ["request body read was aborted", 408],
    REQUEST_BODY_TIMEOUT: ["request body read timed out", 408],
  } as const;
  const [message, status] = refusalByCode[code];
  return { kind: "refusal", response: refusal(stage, code, message, status) };
}

/** Cheap header-only validation shared by pre-admission and body consumption. */
function bodyLengthRefusal(req: Request, stage: ErrorStage, maxBytes: number): BodyReadRefusal | undefined {
  const declared = req.headers.get("content-length");
  if (declared === null) return undefined;
  if (!/^\d+$/.test(declared)) return bodyReadRefusal(stage, "CONTENT_LENGTH_INVALID");
  if (BigInt(declared) > BigInt(maxBytes)) return bodyReadRefusal(stage, "BODY_TOO_LARGE");
  return undefined;
}

/**
 * The public JSON routes must establish their process-local budget before any
 * body reader is acquired. Keep this intentionally limited to header checks:
 * canonical JSON shape validation belongs to each route's existing parser.
 */
function admitCompilerJsonIngress(
  req: Request,
  principal: CompilerPrincipal,
  stage: "resolve" | "project",
  ingress: CompilerJsonIngressAdmissionController,
): CompilerJsonIngressLease | Response {
  if (contentType(req) !== "application/json") {
    return refusal(stage, "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/json", 415);
  }
  const headerRefusal = bodyLengthRefusal(req, stage, COMPILER_HTTP_BODY_LIMIT_BYTES);
  if (headerRefusal) return headerRefusal.response;
  // The exact authenticated server principal is the only bucket key. Request
  // headers, query values, body fields, and artifact/module identifiers do not
  // participate in admission.
  const admitted = ingress.acquire(compilerPrincipalFingerprint(principal));
  if (admitted.status === "busy") {
    return json(
      { error: { stage, code: "COMPILER_JSON_INGRESS_BUSY", message: "compiler JSON ingress is at capacity" } },
      429,
      { "Retry-After": String(admitted.retryAfterSeconds) },
    );
  }
  return admitted.lease;
}

/**
 * Admit compiled durable-session construction after the cheap, header-only
 * request checks. The exact server-authenticated creator is the only bucket
 * key; query values, headers, JSON fields, bundle IDs, archetypes, and
 * session IDs never affect capacity accounting.
 */
function admitCompiledSessionCreationIngress(
  req: Request,
  principal: CompilerPrincipal,
  ingress: CompiledSessionCreationIngressAdmissionController,
): CompiledSessionCreationIngressLease | Response {
  if (contentType(req) !== "application/json") {
    return refusal("session", "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/json", 415);
  }
  const headerRefusal = bodyLengthRefusal(req, "session", COMPILER_HTTP_BODY_LIMIT_BYTES);
  if (headerRefusal) return headerRefusal.response;
  const admitted = ingress.acquire(compilerPrincipalFingerprint(principal));
  if (admitted.status === "busy") {
    return json(
      { error: { stage: "session", code: "COMPILED_SESSION_CREATION_BUSY", message: "compiled session creation is at capacity" } },
      429,
      { "Retry-After": String(admitted.retryAfterSeconds) },
    );
  }
  return admitted.lease;
}

type HeldCompiledSessionCreationAdmission = Extract<CompiledSessionCreationAdmissionResult, { status: "acquired" }>;

/** Keep durable admission failures deliberately non-diagnostic at the HTTP boundary. */
function compiledSessionCreationAdmissionRefusal(
  result: Exclude<CompiledSessionCreationAdmissionResult, { status: "acquired" }>,
): Response {
  const limited = result.status === "refused"
    && (result.code === "COMPILED_SESSION_CREATION_ADMISSION_BUSY"
      || result.code === "COMPILED_SESSION_CREATION_ADMISSION_RATE_LIMITED");
  return json({ error: {
    stage: "admission",
    code: limited ? "COMPILED_SESSION_CREATION_BUSY" : "COMPILED_SESSION_CREATION_UNAVAILABLE",
    message: limited ? "compiled session creation is at capacity" : "compiled session creation is unavailable",
  } }, limited ? 429 : 503, { "Retry-After": String(result.retryAfterSeconds) });
}

/**
 * The durable fence covers the complete creation critical section. Resolver
 * implementations predate cancellation/timeout contracts, so this guard does
 * not pretend it can stop one: callers must await its real settlement, then
 * checkpoints prohibit body/catalog/publication work after loss. A lost or
 * expired lease is left quarantined for explicit operator recovery rather than
 * silently released by this process.
 */
function guardCompiledSessionCreationAdmission(admission: HeldCompiledSessionCreationAdmission): {
  checkpoint(): Response | undefined;
  finish(): void;
} {
  let failed = false;
  let stopped = false;
  let quarantined = false;
  const quarantine = () => {
    if (quarantined) return;
    quarantined = true;
    try { admission.quarantine(); } catch { /* the loss itself is authoritative */ }
  };
  const failClosed = () => {
    failed = true;
    // The work may include a resolver without a cancellation contract. Do not
    // make a physical slot available while that unknown outcome can still
    // settle; exact operator recovery is the only release authority.
    quarantine();
  };
  const renewalTimer = setInterval(() => {
    if (failed) return;
    try {
      if (admission.renew().status !== "active") failClosed();
    } catch { failClosed(); }
  }, admission.renewalIntervalMs);
  renewalTimer.unref?.();
  let deadlineDelay = 0;
  try { deadlineDelay = admission.remainingDeadlineMs(); }
  catch { failClosed(); }
  const deadlineTimer = setTimeout(failClosed, deadlineDelay);
  return {
    checkpoint: () => {
      try {
        if (failed || admission.remainingDeadlineMs() <= 0) {
          failClosed();
          return json({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_UNAVAILABLE", message: "compiled session creation is unavailable" } }, 503, { "Retry-After": "1" });
        }
        if (admission.checkActive().status !== "active") {
          failClosed();
          return json({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_UNAVAILABLE", message: "compiled session creation is unavailable" } }, 503, { "Retry-After": "1" });
        }
      } catch {
        failClosed();
        return json({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_UNAVAILABLE", message: "compiled session creation is unavailable" } }, 503, { "Retry-After": "1" });
      }
      return undefined;
    },
    finish: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(renewalTimer);
      clearTimeout(deadlineTimer);
      // Release failures are post-conditions only: a successful generation
      // zero publication must remain a 201. A failed/quarantined lease must
      // remain for the operator instead of being auto-reclaimed.
      if (failed || quarantined) return;
      try { admission.release(); } catch { /* fail closed durable state remains */ }
    },
  };
}

function releaseBodyReader(reader: BodyReader): void {
  try { reader.releaseLock(); } catch { /* a hostile stream must not delay the HTTP response */ }
}

function rememberBodyReaderDrain(req: Request, drain: Promise<void>): void {
  const prior = bodyReaderDrains.get(req);
  // There is normally one reader per Request. Compose defensively so a future
  // caller cannot make an earlier drain disappear before lease handoff.
  bodyReaderDrains.set(req, prior
    ? Promise.allSettled([prior, drain]).then(() => undefined)
    : drain);
}

function takeBodyReaderDrain(req: Request): Promise<void> | undefined {
  const drain = bodyReaderDrains.get(req);
  if (drain) bodyReaderDrains.delete(req);
  return drain;
}

/**
 * Never await an untrusted cancel implementation on the response path. The
 * returned drain lets the ingress owner retain capacity until cancellation
 * actually settles; releaseLock remains best-effort and immediate.
 */
function abandonBodyReader(reader: BodyReader): Promise<void> | undefined {
  let cancellation: unknown;
  try { cancellation = reader.cancel(); } catch { /* a broken reader still needs its lock released */ }
  releaseBodyReader(reader);
  if (!cancellation || typeof (cancellation as { then?: unknown }).then !== "function") return undefined;
  return Promise.resolve(cancellation).then(
    () => releaseBodyReader(reader),
    () => releaseBodyReader(reader),
  );
}

/**
 * Transfer a process-local ingress lease to the one shared body-reader drain
 * for this request. The response remains immediate; capacity returns only
 * after the drain settles. A broken release/logger must not orphan a slot.
 */
function handoffIngressLeaseToBodyReaderDrain(
  req: Request,
  release: () => void,
  logError?: (error: unknown) => void,
  retain?: (drain: Promise<void>) => void,
): boolean {
  const drain = takeBodyReaderDrain(req);
  if (!drain) return false;
  const safelyLog = (error: unknown) => {
    try { logError?.(error); } catch { /* logging cannot hold an ingress slot */ }
  };
  const safelyRelease = () => {
    try { release(); } catch (error) { safelyLog(error); }
  };
  if (retain) {
    try {
      retain(drain);
      return true;
    } catch (error) {
      safelyLog(error);
      safelyRelease();
      return true;
    }
  }
  try {
    void drain.then(
      () => safelyRelease(),
      (error) => {
        safelyLog(error);
        safelyRelease();
      },
    );
  } catch (error) {
    safelyLog(error);
    safelyRelease();
  }
  return true;
}

async function bodyBytes(
  req: Request,
  stage: ErrorStage,
  maxBytes = COMPILER_HTTP_BODY_LIMIT_BYTES,
  deadlineMs = COMPILER_HTTP_BODY_READ_DEADLINE_MS,
): Promise<BodyBytesResult> {
  const headerRefusal = bodyLengthRefusal(req, stage, maxBytes);
  if (headerRefusal) return headerRefusal;
  const requestBody = req.body;
  if (!requestBody) return { kind: "bytes", bytes: new Uint8Array() };
  let reader: BodyReader;
  try {
    reader = requestBody.getReader();
  } catch {
    return bodyReadRefusal(stage, "REQUEST_BODY_INVALID");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadlineAt = Date.now() + deadlineMs;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let abandoned = false;
  const abandon = () => {
    if (abandoned) return;
    abandoned = true;
    const drain = abandonBodyReader(reader);
    if (drain) rememberBodyReaderDrain(req, drain);
  };
  const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: "timeout" }), deadlineMs);
  });
  const aborted = req.signal.aborted
    ? Promise.resolve({ kind: "aborted" } as const)
    : new Promise<{ kind: "aborted" }>((resolve) => {
      const onAbort = () => resolve({ kind: "aborted" });
      req.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => req.signal.removeEventListener("abort", onAbort);
    });
  try {
    while (true) {
      const next = await Promise.race([
        reader.read().then(
          (value) => ({ kind: "read" as const, value }),
          () => ({ kind: "invalid" as const }),
        ),
        deadline,
        aborted,
      ]);
      if (req.signal.aborted || next.kind === "aborted") {
        abandon();
        return bodyReadRefusal(stage, "REQUEST_BODY_ABORTED");
      }
      if (Date.now() >= deadlineAt || next.kind === "timeout") {
        abandon();
        return bodyReadRefusal(stage, "REQUEST_BODY_TIMEOUT");
      }
      if (next.kind === "invalid") {
        abandon();
        return bodyReadRefusal(stage, "REQUEST_BODY_INVALID");
      }
      const { done, value } = next.value;
      if (done) break;
      const nextTotal = total + value.byteLength;
      if (nextTotal > maxBytes) {
        abandon();
        return bodyReadRefusal(stage, "BODY_TOO_LARGE");
      }
      chunks.push(value);
      total = nextTotal;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { kind: "bytes", bytes };
  } catch {
    abandon();
    return bodyReadRefusal(stage, "REQUEST_BODY_INVALID");
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    removeAbortListener?.();
    if (!abandoned) releaseBodyReader(reader);
  }
}

async function jsonBody(req: Request, stage: ErrorStage, deadlineMs: number): Promise<JsonBodyResult> {
  const result = await bodyBytes(req, stage, COMPILER_HTTP_BODY_LIMIT_BYTES, deadlineMs);
  if (result.kind === "refusal") return result;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes));
    return isRecord(value)
      ? { kind: "json", body: value }
      : { kind: "refusal", response: refusal(stage, "REQUEST_SHAPE_INVALID", "request body must be a JSON object", 400) };
  } catch {
    return { kind: "refusal", response: refusal(stage, "JSON_INVALID", "request body must be valid JSON", 400) };
  }
}

function hasOnlyKeys(body: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(body).every((key) => keys.includes(key));
}

function hasExactKeys(body: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(body).length === keys.length && hasOnlyKeys(body, keys);
}

function downstream(stage: ErrorStage, result: { code: string; message: string; artifactCode?: string; causeCode?: string }): Response {
  return refusal(stage, result.code, result.message, 422, result.causeCode ?? result.artifactCode);
}

function catalogFailure(stage: ErrorStage, result: { status: "refused"; code: CatalogRefusalCode; message: string }): Response {
  // Catalog diagnostics can contain server filesystem paths (for example when
  // a once-valid world-model root disappears). Keep those diagnostics inside
  // the catalog/logger boundary and expose only code-stable public messages.
  const message = result.code === "CATALOG_CORRUPT"
    ? "catalog data is unavailable"
    : result.code === "CATALOG_INCOMPATIBLE"
      ? "catalog data is incompatible with this runtime"
      : result.code === "CATALOG_STORAGE_FAILED"
        ? "catalog storage is unavailable"
        : result.message;
  if (result.code === "CATALOG_BUSY") return json({ error: { stage, code: result.code, message } }, 503, { "Retry-After": "1" });
  // A persisted-policy disagreement is deployment configuration, never a
  // client conflict. Keep it a server error even when reached through a POST.
  const status = result.code === "CATALOG_ID_INVALID" ? 400 : result.code === "CATALOG_NOT_FOUND" ? 404 : result.code === "CATALOG_CORRUPT" || result.code === "CATALOG_INCOMPATIBLE" ? 409 : result.code === "CATALOG_QUOTA_EXCEEDED" || result.code === "CATALOG_ID_COLLISION" ? 409 : 500;
  return refusal(stage, result.code, message, status);
}
function catalogIndeterminate(stage: ErrorStage, result: CatalogWriteIndeterminate): Response {
  return json({ error: { stage, code: result.code, message: result.message, recovery: result.recovery } }, 503, { "Retry-After": "1" });
}

type CompilerRoutePolicy = {
  /** Stable identifier retained in a one-shot cold-path authorization record. */
  id: "artifact-read" | "bundle-read" | "prepare" | "resolve" | "auto-resolve" | "auto-admission-recover" | "presentation-reviews" | "presentation-workbench" | "compiled-session-create";
  roles: readonly CompilerPrincipalRole[];
};

function compilerRoutePolicy(req: Request, pathname: string): CompilerRoutePolicy | null {
  if (req.method === "GET" && /^\/api\/compiler\/artifacts\/[^/]+$/.test(pathname)) return { id: "artifact-read", roles: ["operator"] };
  if (req.method === "GET" && /^\/api\/compiler\/bundles\/[^/]+$/.test(pathname)) return { id: "bundle-read", roles: ["operator", "keeper"] };
  if (req.method !== "POST") return null;
  if (pathname === "/api/compiler/prepare") return { id: "prepare", roles: ["operator"] };
  if (pathname === "/api/compiler/resolve") return { id: "resolve", roles: ["operator"] };
  if (pathname === "/api/compiler/auto-resolve") return { id: "auto-resolve", roles: ["operator"] };
  if (pathname === "/api/compiler/auto-admission/recover") return { id: "auto-admission-recover", roles: ["operator"] };
  if (pathname === "/api/compiler/presentation-reviews") return { id: "presentation-reviews", roles: ["operator"] };
  if (pathname === "/api/compiler/presentation-workbench") return { id: "presentation-workbench", roles: ["operator"] };
  if (pathname === "/api/sessions/compiled") return { id: "compiled-session-create", roles: ["operator", "keeper"] };
  return null;
}

function validPrincipal(value: unknown): value is CompilerPrincipal {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.trim().length > 0
    && ["operator", "keeper", "player"].includes(value.role as string);
}

/**
 * A durable session stores only this deterministic verifier, never a raw host
 * subject or credential. It is an authorization binding, not a bearer token.
 */
export function compilerPrincipalFingerprint(principal: CompilerPrincipal): string {
  return sha256(`compiled-session-owner-v1|${principal.role}|${principal.id.trim()}`);
}

export function compilerPlayerPrincipalFingerprint(principal: { id: string; role: "player" }): string {
  return sha256(`compiled-session-player-v1|${principal.role}|${principal.id}`);
}

export function createCompiledSessionAccessBinding(
  principal: CompilerPrincipal,
  player?: { id: string; role: "player" },
  playerDelivery?: PlayerDeliveryInvitation["binding"],
): CompiledSessionAccessBinding {
  if (principal.role !== "operator" && principal.role !== "keeper") {
    throw new Error("compiled session creators must be operator or keeper principals");
  }
  if (player && (!player.id || player.id.trim() !== player.id || player.role !== "player")) {
    throw new Error("compiled session player assignments must be canonical player principals");
  }
  if (playerDelivery && (playerDelivery.pcId !== "p1" || !/^[a-f0-9]{64}$/.test(playerDelivery.inviteDigest)
    || !Number.isSafeInteger(playerDelivery.expiresAt) || playerDelivery.expiresAt <= 0)) {
    throw new Error("compiled session player delivery bindings must be digest-only and valid");
  }
  return {
    schemaVersion: COMPILED_SESSION_ACCESS_BINDING_SCHEMA_VERSION,
    ownerRole: principal.role,
    ownerPrincipalFingerprint: compilerPrincipalFingerprint(principal),
    choiceHmacKey: randomBytes(32).toString("hex"),
    ...(player ? { playerGrant: { pcId: "p1" as const, role: "player" as const, principalFingerprint: compilerPlayerPrincipalFingerprint(player) } } : {}),
    ...(playerDelivery ? { playerDelivery: { ...playerDelivery } } : {}),
  };
}

/** Exact owner match; no request body, query value, or client-selected role participates. */
export function principalMatchesCompiledSessionAccess(
  principal: CompilerPrincipal,
  access: CompiledSessionAccessBinding,
): boolean {
  return principal.role === access.ownerRole
    && compilerPrincipalFingerprint(principal) === access.ownerPrincipalFingerprint;
}

/** Exact player-role and fingerprint match against an assigned p1 grant. */
export function principalMatchesCompiledSessionPlayerGrant(
  principal: CompilerPrincipal,
  access: CompiledSessionAccessBinding,
): boolean {
  return principal.role === "player"
    && access.playerGrant?.role === "player"
    && compilerPlayerPrincipalFingerprint({ id: principal.id, role: "player" }) === access.playerGrant.principalFingerprint;
}

/** Resolve the optional p1 grant before any creation body or catalog work. */
async function resolveCompiledSessionPlayerAssignment(
  creator: CompilerPrincipal,
  resolver: CompiledSessionPlayerResolver | undefined,
): Promise<{ id: string; role: "player" } | undefined | Response> {
  if (!resolver) return undefined;
  let result: unknown;
  try {
    result = await resolver({ id: creator.id, role: creator.role });
  } catch {
    return refusal("auth", "PLAYER_ASSIGNMENT_UNAVAILABLE", "compiled player assignment is unavailable", 503);
  }
  if (!isRecord(result)) return refusal("auth", "PLAYER_ASSIGNMENT_UNAVAILABLE", "compiled player assignment is unavailable", 503);
  if (result.status === "unassigned") {
    if (!hasExactKeys(result, ["status"])) return refusal("auth", "PLAYER_ASSIGNMENT_UNAVAILABLE", "compiled player assignment is unavailable", 503);
    return undefined;
  }
  if (result.status === "unavailable") {
    return refusal("auth", "PLAYER_ASSIGNMENT_UNAVAILABLE", "compiled player assignment is unavailable", 503);
  }
  if (!hasExactKeys(result, ["status", "principal"]) || result.status !== "assigned" || !isRecord(result.principal)
    || !hasExactKeys(result.principal, ["id", "role"])
    || result.principal.role !== "player" || typeof result.principal.id !== "string"
    || !result.principal.id || result.principal.id.trim() !== result.principal.id) {
    return refusal("auth", "PLAYER_ASSIGNMENT_UNAVAILABLE", "compiled player assignment is unavailable", 503);
  }
  return { id: result.principal.id, role: "player" };
}

/** Resolve a host-trusted principal without applying a route-specific role policy. */
export async function authenticateCompilerPrincipal(
  req: Request,
  authenticate?: CompilerRequestAuthenticator,
): Promise<CompilerPrincipal | Response> {
  if (!authenticate) {
    return refusal("auth", "AUTH_CAPABILITY_UNAVAILABLE", "compiler authentication is not configured", 503);
  }
  let authentication: unknown;
  try {
    authentication = await authenticate(req);
  } catch {
    return refusal("auth", "AUTH_CAPABILITY_UNAVAILABLE", "compiler authentication is unavailable", 503);
  }
  try {
    if (!isRecord(authentication)) return refusal("auth", "AUTH_CAPABILITY_UNAVAILABLE", "compiler authentication is unavailable", 503);
    if (authentication.status === "unavailable") return refusal("auth", "AUTH_CAPABILITY_UNAVAILABLE", "compiler authentication is unavailable", 503);
    if (authentication.status === "unauthenticated") return refusal("auth", "AUTHENTICATION_REQUIRED", "compiler authentication is required", 401);
    if (authentication.status !== "authenticated" || !validPrincipal(authentication.principal)) {
      return refusal("auth", "AUTH_CAPABILITY_UNAVAILABLE", "compiler authentication is unavailable", 503);
    }
    return { id: authentication.principal.id.trim(), role: authentication.principal.role };
  } catch {
    return refusal("auth", "AUTH_CAPABILITY_UNAVAILABLE", "compiler authentication is unavailable", 503);
  }
}

/** Authenticate and authorize before any compiler request body is consumed or catalog state is observed. */
async function authorizeCompilerRequest(
  req: Request,
  authenticate: CompilerRequestAuthenticator | undefined,
  policy: CompilerRoutePolicy,
): Promise<CompilerPrincipal | Response> {
  const principal = await authenticateCompilerPrincipal(req, authenticate);
  if (principal instanceof Response) return principal;
  try {
    if (!policy.roles.includes(principal.role)) {
      return refusal("auth", "AUTHORIZATION_REQUIRED", "authenticated principal is not permitted to access this compiler route", 403);
    }
    return principal;
  } catch {
    return refusal("auth", "AUTH_CAPABILITY_UNAVAILABLE", "compiler authentication is unavailable", 503);
  }
}

interface CompilerHttpRoutePreauthorizationRecord {
  request: Request;
  method: string;
  pathname: string;
  policyId: CompilerRoutePolicy["id"];
  principal: CompilerPrincipal;
  consumed: boolean;
}

const compilerHttpRoutePreauthorizationRecords = new WeakMap<object, CompilerHttpRoutePreauthorizationRecord>();

export type CompilerHttpRoutePreauthorizationResult =
  | { kind: "not-recognized" }
  | { kind: "refused"; response: Response }
  | { kind: "authorized"; preauthorization: CompilerHttpRoutePreauthorization };

function makeCompilerHttpRoutePreauthorization(
  req: Request,
  pathname: string,
  policy: CompilerRoutePolicy,
  principal: CompilerPrincipal,
): CompilerHttpRoutePreauthorization {
  // The capability has no properties a dependency injector can use to forge
  // it. The real authority remains in the module-private WeakMap below.
  const preauthorization = Object.freeze(Object.create(null)) as CompilerHttpRoutePreauthorization;
  compilerHttpRoutePreauthorizationRecords.set(preauthorization, {
    request: req,
    method: req.method,
    pathname,
    policyId: policy.id,
    principal: Object.freeze({ id: principal.id, role: principal.role }),
    consumed: false,
  });
  return preauthorization;
}

function consumeCompilerHttpRoutePreauthorization(
  candidate: unknown,
  req: Request,
  pathname: string,
  policy: CompilerRoutePolicy,
): CompilerPrincipal | Response {
  const record = candidate !== null && typeof candidate === "object"
    ? compilerHttpRoutePreauthorizationRecords.get(candidate)
    : undefined;
  if (!record || record.consumed) {
    return refusal("auth", "AUTHENTICATION_REQUIRED", "compiler authentication is required", 401);
  }
  // Consume before comparing so a capability passed to the wrong request can
  // never later be replayed against the original request.
  record.consumed = true;
  if (record.request !== req
    || record.method !== req.method
    || record.pathname !== pathname
    || record.policyId !== policy.id
    || !validPrincipal(record.principal)
    || !policy.roles.includes(record.principal.role)) {
    return refusal("auth", "AUTHENTICATION_REQUIRED", "compiler authentication is required", 401);
  }
  return record.principal;
}

/**
 * Authenticate recognized compiler/compiled routes before a server host
 * initializes durable session inventory. A successful result is an opaque,
 * single-use proof for the same request; the inner HTTP handler consumes it
 * instead of calling a stateful host authenticator a second time.
 */
export async function preauthorizeCompilerHttpRoute(
  req: Request,
  authenticate?: CompilerRequestAuthenticator,
): Promise<CompilerHttpRoutePreauthorizationResult> {
  const pathname = new URL(req.url).pathname;
  const policy = compilerRoutePolicy(req, pathname);
  if (!policy) return { kind: "not-recognized" };
  const authorized = await authorizeCompilerRequest(req, authenticate, policy);
  if (authorized instanceof Response) return { kind: "refused", response: authorized };
  return { kind: "authorized", preauthorization: makeCompilerHttpRoutePreauthorization(req, pathname, policy, authorized) };
}

async function prepare(
  req: Request,
  catalog: CompilerArtifactCatalog,
  principal: CompilerPrincipal,
  ingress: PdfPrepareIngressAdmissionController,
  deadlineMs: number,
  logError?: (error: unknown) => void,
): Promise<Response> {
  if (contentType(req) !== "application/pdf") return refusal("prepare", "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/pdf", 415);
  const moduleId = new URL(req.url).searchParams.get("moduleId")?.trim();
  if (!moduleId) return refusal("prepare", "MODULE_ID_REQUIRED", "moduleId is required", 400);
  if (new TextEncoder().encode(moduleId).byteLength > PDF_PREPARE_LIMITS.maxModuleIdUtf8Bytes) {
    return json({ error: { stage: "prepare", code: "PREPARE_RESOURCE_LIMIT_EXCEEDED", message: "PDF preparation exceeded a server resource limit", limitKind: "module_id_utf8" } }, 422);
  }
  const headerRefusal = bodyLengthRefusal(req, "prepare", COMPILER_HTTP_PDF_BODY_LIMIT_BYTES);
  if (headerRefusal) return headerRefusal.response;
  // This identity is derived exclusively from the host-authenticated
  // principal. Query parameters, headers, and the PDF cannot select a bucket.
  const admitted = ingress.acquire(compilerPrincipalFingerprint(principal));
  if (admitted.status === "busy") {
    return json({ error: { stage: "prepare", code: "PREPARE_INGRESS_BUSY", message: "PDF preparation ingress is at capacity" } }, 429, { "Retry-After": String(admitted.retryAfterSeconds) });
  }
  const safelyReleaseIngress = () => {
    try { admitted.lease.release(); } catch (error) {
      try { logError?.(error); } catch { /* logging cannot retain an ingress slot */ }
    }
  };
  try {
    const body = await bodyBytes(req, "prepare", COMPILER_HTTP_PDF_BODY_LIMIT_BYTES, deadlineMs);
    if (body.kind === "refusal") return body.response;
    if (body.bytes.length === 0) return refusal("prepare", "PDF_EMPTY", "PDF bytes must be non-empty", 400);
    // `prepareCompiler` remains the direct trusted/programmatic facade.  The
    // public PDF route must use the disposable untrusted-PDF boundary instead.
    const result = await prepareUntrustedPdfCompilerArtifact(moduleId, body.bytes, req.signal);
    if (result.status === "busy") return json({ error: { stage: "prepare", code: "PREPARE_ADMISSION_BUSY", message: "PDF preparation is at capacity" } }, 429, { "Retry-After": String(result.retryAfterSeconds) });
    if (result.status === "unavailable") return refusal("prepare", result.code, "PDF preparation isolation is unavailable", 503);
    if (result.status === "refused") {
      if (result.code === "PREPARE_RESOURCE_LIMIT_EXCEEDED") {
        return json({ error: { stage: "prepare", code: result.code, message: "PDF preparation exceeded a server resource limit", limitKind: result.limitKind } }, 422);
      }
      return refusal("prepare", result.code, result.code === "PDF_TEXT_UNAVAILABLE" ? "PDF has no usable text layer" : "PDF could not be prepared", 422);
    }
    const saved = catalog.savePrevalidatedPrepared(result.receipt);
    if (saved.status === "ok") return json({ status: "prepared", identity: result.identity, artifact: result.artifact, questions: result.artifact.payload.preparedQueue.questions, preparedArtifactId: saved.value.id }, 201);
    if (saved.status === "indeterminate") return catalogIndeterminate("prepare", saved);
    return catalogFailure("prepare", saved);
  } catch (error) {
    logError?.(error);
    return refusal("prepare", "PREPARE_INTERNAL", "compiler preparation failed", 500);
  } finally {
    if (!handoffIngressLeaseToBodyReaderDrain(req, safelyReleaseIngress, logError)) safelyReleaseIngress();
  }
}

function resolveCompiledWorldModelBinding(
  resolver: CompiledWorldModelBindingResolver | undefined,
  identity: { moduleId: string; artifactHash: string; documentHash: string | null },
  stage: "resolve" | "session",
  logError?: (error: unknown) => void,
): CompiledCthulhuWorldModelBinding | undefined | Response {
  if (!resolver) return undefined;
  try {
    const exactIdentity = Object.freeze({
      moduleId: identity.moduleId,
      artifactHash: identity.artifactHash,
      documentHash: identity.documentHash,
    });
    const binding = resolver(exactIdentity);
    if (binding === undefined) return undefined;
    // Reject a malformed or cross-artifact response before saveBundle can
    // create any durable catalog entry. Full binding/dataset validation stays
    // with the catalog's authoritative write boundary.
    assertCompiledCthulhuWorldModelBindingArtifactIdentity(binding, exactIdentity);
    return binding;
  } catch (error) {
    logError?.(error);
    return refusal(stage, "WORLD_MODEL_BINDING_RESOLUTION_FAILED", "trusted world-model binding resolution failed", 500);
  }
}

async function resolve(
  req: Request,
  catalog: CompilerArtifactCatalog,
  deadlineMs: number,
  worldModelBindingResolver?: CompiledWorldModelBindingResolver,
  logError?: (error: unknown) => void,
): Promise<Response> {
  if (contentType(req) !== "application/json") return refusal("resolve", "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/json", 415);
  const parsed = await jsonBody(req, "resolve", deadlineMs);
  if (parsed.kind === "refusal") return parsed.response;
  const body = parsed.body;
  const hasHints = "hints" in body;
  const hasContinuation = "autoContinuationId" in body;
  if (!hasOnlyKeys(body, ["preparedArtifactId", "preparedQueueHash", "hints", "autoContinuationId", "presentationReviewId"])
    || hasHints === hasContinuation
    || typeof body.preparedQueueHash !== "string"
    || (hasHints && !isRecord(body.hints))
    || (hasContinuation && typeof body.autoContinuationId !== "string")
    || typeof body.presentationReviewId !== "string"
    || typeof body.preparedArtifactId !== "string") {
    return refusal("resolve", "REQUEST_SHAPE_INVALID", "resolve requires catalog preparedArtifactId, preparedQueueHash, presentationReviewId, and exactly one hints or autoContinuationId", 400);
  }
  try {
    const prepared = catalog.loadPrepared(body.preparedArtifactId);
    if (prepared.status === "refused") return catalogFailure("resolve", prepared);
    let hints: ModuleCompileHints;
    if (hasContinuation) {
      const continuation = catalog.loadAutoResolveContinuation(body.autoContinuationId as string);
      if (continuation.status === "refused") return catalogFailure("resolve", continuation);
      if (!autoContinuationMatchesPrepared(continuation.value, body.preparedArtifactId, prepared.value, body.preparedQueueHash)) {
        return refusal("resolve", "AUTO_CONTINUATION_MISMATCH", "automatic continuation does not match the catalog-restored prepared artifact", 409);
      }
      hints = continuation.value.hints;
    } else {
      hints = body.hints as unknown as ModuleCompileHints;
    }
    const result = resolveCompiler(prepared.value.artifact, body.preparedQueueHash, hints);
    if (result.status === "refused") return downstream("resolve", result);
    const presentationReview = catalog.loadTrustedPresentationReview(body.presentationReviewId);
    if (presentationReview.status === "refused") return catalogFailure("project", presentationReview);
    if (presentationReview.value.preparedArtifactId !== body.preparedArtifactId
      || presentationReview.value.preparedArtifactHash !== prepared.value.artifactHash
      || presentationReview.value.preparedIdentity.moduleId !== prepared.value.identity.moduleId
      || presentationReview.value.preparedIdentity.documentHash !== prepared.value.identity.documentHash
      || presentationReview.value.preparedIdentity.sourceGraphIdentity !== prepared.value.identity.sourceGraphIdentity
      || presentationReview.value.preparedIdentity.preparedQueueHash !== body.preparedQueueHash
      || presentationReview.value.resolvedArtifactHash !== result.artifact.artifactHash
      || JSON.stringify(presentationReview.value.resolvedIdentity) !== JSON.stringify(result.identity)) {
      return refusal("project", "PRESENTATION_REVIEW_MISMATCH", "trusted presentation review does not match the resolved compiler artifact", 409);
    }
    const projection = projectTrustedResolvedCompilerArtifact(result.artifact.payload as ResolvedCompilerArtifactPayload, presentationReview.value.review);
    if (projection.status === "refused") return downstream("project", projection);
    const worldModelBinding = resolveCompiledWorldModelBinding(worldModelBindingResolver, {
      moduleId: result.identity.moduleId,
      artifactHash: result.artifact.artifactHash,
      documentHash: result.identity.documentHash,
    }, "resolve", logError);
    if (worldModelBinding instanceof Response) return worldModelBinding;
    const quality = summarizeCompilerRuntimeQuality(result.artifact.payload as ResolvedCompilerArtifactPayload);
    const saved = catalog.saveBundle(result.artifact, projection, worldModelBinding);
    if (saved.status === "ok") {
      return json({ status: "resolved", identity: result.identity, artifact: result.artifact, projection, bundleId: saved.value.id, quality });
    }
    if (saved.status === "indeterminate") return catalogIndeterminate("resolve", saved);
    return catalogFailure("resolve", saved);
  } catch (error) {
    logError?.(error);
    return refusal("resolve", "RESOLVE_INTERNAL", "compiler resolution failed", 500);
  }
}

/**
 * Operator-only minting of an identity-bound, exact-source presentation review.
 * The request can choose validated hints and exact bindings, but never a
 * reviewer identity, trust level, free-form presentation, or stored artifact.
 */
async function mintPresentationReview(
  req: Request,
  catalog: CompilerArtifactCatalog,
  principal: CompilerPrincipal,
  deadlineMs: number,
  logError?: (error: unknown) => void,
): Promise<Response> {
  if (contentType(req) !== "application/json") return refusal("project", "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/json", 415);
  const parsed = await jsonBody(req, "project", deadlineMs);
  if (parsed.kind === "refusal") return parsed.response;
  const body = parsed.body;
  const hasHints = "hints" in body;
  const hasContinuation = "autoContinuationId" in body;
  if (!hasOnlyKeys(body, ["preparedArtifactId", "preparedQueueHash", "hints", "autoContinuationId", "bindings"])
    || hasHints === hasContinuation
    || typeof body.preparedArtifactId !== "string"
    || typeof body.preparedQueueHash !== "string"
    || (hasHints && !isRecord(body.hints))
    || (hasContinuation && typeof body.autoContinuationId !== "string")
    || !Array.isArray(body.bindings)) {
    return refusal("project", "REQUEST_SHAPE_INVALID", "presentation review requires preparedArtifactId, preparedQueueHash, bindings, and exactly one hints or autoContinuationId", 400);
  }
  try {
    const prepared = catalog.loadPrepared(body.preparedArtifactId);
    if (prepared.status === "refused") return catalogFailure("project", prepared);
    let hints: ModuleCompileHints;
    if (hasContinuation) {
      const continuation = catalog.loadAutoResolveContinuation(body.autoContinuationId as string);
      if (continuation.status === "refused") return catalogFailure("project", continuation);
      if (!autoContinuationMatchesPrepared(continuation.value, body.preparedArtifactId, prepared.value, body.preparedQueueHash)) {
        return refusal("project", "AUTO_CONTINUATION_MISMATCH", "automatic continuation does not match the catalog-restored prepared artifact", 409);
      }
      hints = continuation.value.hints;
    } else {
      hints = body.hints as unknown as ModuleCompileHints;
    }
    const resolved = resolveCompiler(prepared.value.artifact, body.preparedQueueHash, hints);
    if (resolved.status === "refused") return downstream("project", resolved);
    const saved = catalog.saveTrustedPresentationReview(
      body.preparedArtifactId,
      prepared.value.artifact,
      resolved.artifact,
      principal.id,
      body.bindings as TrustedPresentationBinding[],
    );
    if (saved.status === "ok") {
      return json({
        status: "reviewed",
        presentationReviewId: saved.value.id,
        preparedArtifactId: saved.value.preparedArtifactId,
        preparedQueueHash: prepared.value.identity.preparedQueueHash,
        reviewHash: saved.value.reviewHash,
      }, 201);
    }
    if (saved.status === "indeterminate") return catalogIndeterminate("project", saved);
    return catalogFailure("project", saved);
  } catch (error) {
    logError?.(error);
    return refusal("project", "PRESENTATION_REVIEW_INTERNAL", "trusted presentation review could not be created", 500);
  }
}

/**
 * Read-only operator workbench. It resolves the catalog-restored draft using
 * the same hints/continuation checks as publication, then returns only the
 * authoritative selection contract—not a review, projection, or bundle.
 */
const PRESENTATION_WORKBENCH_CURSOR_SCHEMA_VERSION = "1";

interface PresentationWorkbenchCursorBase {
  cursorSchemaVersion: typeof PRESENTATION_WORKBENCH_CURSOR_SCHEMA_VERSION;
  workbenchSchemaVersion: typeof TRUSTED_PRESENTATION_WORKBENCH_PLAN_SCHEMA_VERSION;
  resolvedArtifactHash: string;
  resolvedIdentity: ResolvedCompilerArtifactIdentity;
  offset: number;
}

interface PresentationWorkbenchCandidateCursorPayload extends PresentationWorkbenchCursorBase {
  cursorKind: "candidate";
  fieldPath: string;
  sourceCandidateOrderHash: string;
}

interface PresentationWorkbenchSlotCursorPayload extends PresentationWorkbenchCursorBase {
  cursorKind: "slot";
  fieldPathOrderHash: string;
}

type PresentationWorkbenchCursorPayload = PresentationWorkbenchCandidateCursorPayload | PresentationWorkbenchSlotCursorPayload;

function cursorPayloadJson(payload: PresentationWorkbenchCursorPayload): string {
  if (payload.cursorKind === "slot") {
    return JSON.stringify({
      cursorSchemaVersion: payload.cursorSchemaVersion,
      workbenchSchemaVersion: payload.workbenchSchemaVersion,
      cursorKind: payload.cursorKind,
      resolvedArtifactHash: payload.resolvedArtifactHash,
      resolvedIdentity: payload.resolvedIdentity,
      offset: payload.offset,
      fieldPathOrderHash: payload.fieldPathOrderHash,
    });
  }
  return JSON.stringify({
    cursorSchemaVersion: payload.cursorSchemaVersion,
    workbenchSchemaVersion: payload.workbenchSchemaVersion,
    cursorKind: payload.cursorKind,
    resolvedArtifactHash: payload.resolvedArtifactHash,
    resolvedIdentity: payload.resolvedIdentity,
    fieldPath: payload.fieldPath,
    offset: payload.offset,
    sourceCandidateOrderHash: payload.sourceCandidateOrderHash,
  });
}

function validResolvedIdentity(value: unknown): value is ResolvedCompilerArtifactIdentity {
  return isRecord(value)
    && hasExactKeys(value, ["moduleId", "documentHash", "sourceGraphIdentity", "preparedQueueHash", "resolvedQueueHash", "mechanicsHash"])
    && typeof value.moduleId === "string" && value.moduleId.trim().length > 0
    && (typeof value.documentHash === "string" || value.documentHash === null)
    && typeof value.sourceGraphIdentity === "string"
    && typeof value.preparedQueueHash === "string"
    && typeof value.resolvedQueueHash === "string"
    && typeof value.mechanicsHash === "string";
}

function validPresentationWorkbenchCursorBase(value: unknown): value is JsonRecord & PresentationWorkbenchCursorBase {
  return isRecord(value)
    && value.cursorSchemaVersion === PRESENTATION_WORKBENCH_CURSOR_SCHEMA_VERSION
    && value.workbenchSchemaVersion === TRUSTED_PRESENTATION_WORKBENCH_PLAN_SCHEMA_VERSION
    && typeof value.resolvedArtifactHash === "string" && /^[a-f0-9]{64}$/.test(value.resolvedArtifactHash)
    && validResolvedIdentity(value.resolvedIdentity)
    && typeof value.offset === "number" && Number.isSafeInteger(value.offset) && value.offset > 0;
}

function validPresentationWorkbenchCursorPayload(value: unknown): value is PresentationWorkbenchCursorPayload {
  if (!validPresentationWorkbenchCursorBase(value) || typeof value.cursorKind !== "string") return false;
  if (value.cursorKind === "slot") {
    return hasExactKeys(value, ["cursorSchemaVersion", "workbenchSchemaVersion", "cursorKind", "resolvedArtifactHash", "resolvedIdentity", "offset", "fieldPathOrderHash"])
      && value.offset % TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE === 0
      && typeof value.fieldPathOrderHash === "string" && /^[a-f0-9]{64}$/.test(value.fieldPathOrderHash);
  }
  return value.cursorKind === "candidate"
    && hasExactKeys(value, ["cursorSchemaVersion", "workbenchSchemaVersion", "cursorKind", "resolvedArtifactHash", "resolvedIdentity", "fieldPath", "offset", "sourceCandidateOrderHash"])
    && value.offset % TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE === 0
    && typeof value.fieldPath === "string" && value.fieldPath.trim().length > 0
    && typeof value.sourceCandidateOrderHash === "string" && /^[a-f0-9]{64}$/.test(value.sourceCandidateOrderHash);
}

function encodePresentationWorkbenchCursor(payload: PresentationWorkbenchCursorPayload): string {
  const integrity = sha256(cursorPayloadJson(payload));
  return Buffer.from(JSON.stringify({ payload, integrity }), "utf8").toString("base64url");
}

function decodePresentationWorkbenchCursor(cursor: string): PresentationWorkbenchCursorPayload | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const encoded = Buffer.from(cursor, "base64url");
    if (encoded.toString("base64url") !== cursor) return null;
    const envelope: unknown = JSON.parse(encoded.toString("utf8"));
    if (!isRecord(envelope) || !hasExactKeys(envelope, ["payload", "integrity"])
      || typeof envelope.integrity !== "string" || !/^[a-f0-9]{64}$/.test(envelope.integrity)
      || !validPresentationWorkbenchCursorPayload(envelope.payload)) return null;
    return envelope.integrity === sha256(cursorPayloadJson(envelope.payload)) ? envelope.payload : null;
  } catch {
    return null;
  }
}

function sameResolvedIdentity(left: ResolvedCompilerArtifactIdentity, right: ResolvedCompilerArtifactIdentity): boolean {
  return left.moduleId === right.moduleId
    && left.documentHash === right.documentHash
    && left.sourceGraphIdentity === right.sourceGraphIdentity
    && left.preparedQueueHash === right.preparedQueueHash
    && left.resolvedQueueHash === right.resolvedQueueHash
    && left.mechanicsHash === right.mechanicsHash;
}

/** The review and catalog record must name the same prepared source root too. */
function samePreparedIdentity(
  left: Readonly<{ moduleId: string; documentHash: string | null; sourceGraphIdentity: string; preparedQueueHash: string }>,
  right: Readonly<{ moduleId: string; documentHash: string | null; sourceGraphIdentity: string; preparedQueueHash: string }>,
): boolean {
  return left.moduleId === right.moduleId
    && left.documentHash === right.documentHash
    && left.sourceGraphIdentity === right.sourceGraphIdentity
    && left.preparedQueueHash === right.preparedQueueHash;
}

async function presentationWorkbench(
  req: Request,
  catalog: CompilerArtifactCatalog,
  deadlineMs: number,
  logError?: (error: unknown) => void,
): Promise<Response> {
  if (contentType(req) !== "application/json") return refusal("project", "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/json", 415);
  const parsed = await jsonBody(req, "project", deadlineMs);
  if (parsed.kind === "refusal") return parsed.response;
  const body = parsed.body;
  const hasHints = "hints" in body;
  const hasContinuation = "autoContinuationId" in body;
  const hasFieldPath = "fieldPath" in body;
  const hasCursor = "cursor" in body;
  if (!hasOnlyKeys(body, ["preparedArtifactId", "preparedQueueHash", "hints", "autoContinuationId", "fieldPath", "cursor"])
    || hasHints === hasContinuation
    || typeof body.preparedArtifactId !== "string"
    || typeof body.preparedQueueHash !== "string"
    || (hasHints && !isRecord(body.hints))
    || (hasContinuation && typeof body.autoContinuationId !== "string")
    || (hasFieldPath && (typeof body.fieldPath !== "string" || !body.fieldPath.trim()))
    || (hasCursor && (typeof body.cursor !== "string" || !body.cursor.trim()))) {
    return refusal("project", "REQUEST_SHAPE_INVALID", "presentation workbench requires preparedArtifactId, preparedQueueHash, exactly one hints or autoContinuationId, and optional fieldPath or cursor", 400);
  }
  const cursor = hasCursor ? decodePresentationWorkbenchCursor(body.cursor as string) : undefined;
  if (hasCursor && !cursor) return refusal("project", "PRESENTATION_WORKBENCH_CURSOR_INVALID", "presentation workbench cursor is invalid", 400);
  try {
    const prepared = catalog.loadPrepared(body.preparedArtifactId);
    if (prepared.status === "refused") return catalogFailure("project", prepared);
    let hints: ModuleCompileHints;
    if (hasContinuation) {
      const continuation = catalog.loadAutoResolveContinuation(body.autoContinuationId as string);
      if (continuation.status === "refused") return catalogFailure("project", continuation);
      if (!autoContinuationMatchesPrepared(continuation.value, body.preparedArtifactId, prepared.value, body.preparedQueueHash)) {
        return refusal("project", "AUTO_CONTINUATION_MISMATCH", "automatic continuation does not match the catalog-restored prepared artifact", 409);
      }
      const validated = catalog.validateAutoResolveContinuationHints(continuation.value, prepared.value.artifact);
      if (validated.status === "refused") return catalogFailure("project", validated);
      hints = validated.value.hints;
    } else {
      hints = body.hints as unknown as ModuleCompileHints;
    }
    const resolved = resolveCompiler(prepared.value.artifact, body.preparedQueueHash, hints);
    if (resolved.status === "refused") return downstream("project", resolved);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const fieldPath = hasFieldPath ? body.fieldPath as string : undefined;
    if (cursor && (cursor.resolvedArtifactHash !== resolved.artifact.artifactHash
      || !sameResolvedIdentity(cursor.resolvedIdentity, resolved.identity))) {
      return refusal("project", "PRESENTATION_WORKBENCH_CURSOR_MISMATCH", "presentation workbench cursor does not match the canonical resolved artifact", 409);
    }
    if ((fieldPath && cursor?.cursorKind === "slot") || (!fieldPath && cursor?.cursorKind === "candidate")) {
      return refusal("project", "PRESENTATION_WORKBENCH_CURSOR_KIND_MISMATCH", "presentation workbench cursor cannot be used for this page mode", 409);
    }
    let candidatePage: { fieldPath: string; candidates: unknown[]; hasMore: boolean; nextCursor?: string } | undefined;
    let slotPage: { slots: unknown[]; hasMore: boolean; nextCursor?: string } | undefined;
    if (fieldPath) {
      const candidateCursor = cursor?.cursorKind === "candidate" ? cursor : undefined;
      if (candidateCursor && candidateCursor.fieldPath !== fieldPath) {
        return refusal("project", "PRESENTATION_WORKBENCH_CURSOR_MISMATCH", "presentation workbench cursor does not match the requested field", 409);
      }
      const page = buildTrustedPresentationReviewCandidatePage(payload, fieldPath, candidateCursor?.offset ?? 0);
      if (page.status === "refused") {
        return candidateCursor
          ? refusal("project", "PRESENTATION_WORKBENCH_CURSOR_MISMATCH", "presentation workbench cursor does not identify a current candidate page", 409)
          : refusal("project", "PRESENTATION_WORKBENCH_FIELD_UNKNOWN", "presentation workbench fieldPath is unknown", 400);
      }
      if (candidateCursor && candidateCursor.sourceCandidateOrderHash !== page.sourceCandidateOrderHash) {
        return refusal("project", "PRESENTATION_WORKBENCH_CURSOR_MISMATCH", "presentation workbench cursor does not match the current candidate order", 409);
      }
      const nextOffset = (candidateCursor?.offset ?? 0) + page.page.candidates.length;
      candidatePage = {
        ...page.page,
        ...(page.page.hasMore ? {
          nextCursor: encodePresentationWorkbenchCursor({
            cursorSchemaVersion: PRESENTATION_WORKBENCH_CURSOR_SCHEMA_VERSION,
            workbenchSchemaVersion: TRUSTED_PRESENTATION_WORKBENCH_PLAN_SCHEMA_VERSION,
            cursorKind: "candidate",
            resolvedArtifactHash: resolved.artifact.artifactHash,
            resolvedIdentity: resolved.identity,
            fieldPath,
            offset: nextOffset,
            sourceCandidateOrderHash: page.sourceCandidateOrderHash,
          }),
        } : {}),
      };
    } else {
      const slotCursor = cursor?.cursorKind === "slot" ? cursor : undefined;
      const page = buildTrustedPresentationReviewSlotPage(payload, slotCursor?.offset ?? 0);
      if (page.status === "refused") {
        return slotCursor
          ? refusal("project", "PRESENTATION_WORKBENCH_CURSOR_MISMATCH", "presentation workbench cursor does not identify a current slot page", 409)
          : downstream("project", page);
      }
      if (slotCursor && slotCursor.fieldPathOrderHash !== page.fieldPathOrderHash) {
        return refusal("project", "PRESENTATION_WORKBENCH_CURSOR_MISMATCH", "presentation workbench cursor does not match the current field order", 409);
      }
      const nextOffset = (slotCursor?.offset ?? 0) + page.page.slots.length;
      slotPage = {
        ...page.page,
        ...(page.page.hasMore ? {
          nextCursor: encodePresentationWorkbenchCursor({
            cursorSchemaVersion: PRESENTATION_WORKBENCH_CURSOR_SCHEMA_VERSION,
            workbenchSchemaVersion: TRUSTED_PRESENTATION_WORKBENCH_PLAN_SCHEMA_VERSION,
            cursorKind: "slot",
            resolvedArtifactHash: resolved.artifact.artifactHash,
            resolvedIdentity: resolved.identity,
            offset: nextOffset,
            fieldPathOrderHash: page.fieldPathOrderHash,
          }),
        } : {}),
      };
    }
    return json({
      status: "review_ready",
      workbenchSchemaVersion: TRUSTED_PRESENTATION_WORKBENCH_PLAN_SCHEMA_VERSION,
      preparedArtifactId: body.preparedArtifactId,
      preparedQueueHash: body.preparedQueueHash,
      resolvedArtifactHash: resolved.artifact.artifactHash,
      prepared: {
        artifactId: body.preparedArtifactId,
        artifactHash: prepared.value.artifactHash,
        identity: prepared.value.identity,
      },
      resolved: {
        artifactHash: resolved.artifact.artifactHash,
        identity: resolved.identity,
      },
      quality: summarizeCompilerRuntimeQuality(payload),
      ...(slotPage ? { slotPage } : {}),
      ...(candidatePage ? { candidatePage } : {}),
    });
  } catch (error) {
    logError?.(error);
    return refusal("project", "PRESENTATION_WORKBENCH_INTERNAL", "presentation workbench could not be prepared", 500);
  }
}

/**
 * Public automatic responses retain only stable diagnostic coordinates. Model
 * responses, source statements, and validator messages can contain private
 * source prose and must remain inside the trusted compiler boundary.
 */
function publicAutoDiagnostics(diagnostics: readonly AutoCompilerDiagnostic[]): Array<Omit<AutoCompilerDiagnostic, "message">> {
  return diagnostics.map(({ message: _message, ...diagnostic }) => diagnostic);
}

function publicProposalRounds(rounds: readonly AutoCompilerProposalRound[]): Array<{ round: number; queueHash: string; status: string; askedQuestionIds: string[]; acceptedQuestionIds: string[]; callCount: number }> {
  return rounds.map((round) => ({
    round: round.round,
    queueHash: round.queueHash,
    status: round.status,
    askedQuestionIds: [...round.askedQuestionIds],
    acceptedQuestionIds: [...round.acceptedQuestionIds],
    callCount: round.callCount,
  }));
}

function autoDraftResponse(
  preparedArtifactId: string,
  result: Extract<AutoCompilerOrchestratorResult, { status: "draft_only" }>,
  options: { continuationId?: string; resumed: boolean; progress: boolean },
): Response {
  return json({
    status: "draft_only",
    preparedArtifactId,
    ...(options.continuationId ? { continuationId: options.continuationId } : {}),
    resumed: options.resumed,
    progress: options.progress,
    rounds: publicProposalRounds(result.rounds),
    diagnostics: publicAutoDiagnostics(result.diagnostics),
    unansweredQuestionIds: result.unansweredQuestionIds,
    ...(result.resolutionSnapshot ? { resolutionSnapshot: result.resolutionSnapshot } : {}),
    ...(result.resolveRefusal ? {
      resolveRefusal: {
        stage: result.resolveRefusal.stage,
        code: result.resolveRefusal.code,
        ...(result.resolveRefusal.causeCode ? { causeCode: result.resolveRefusal.causeCode } : {}),
      },
    } : {}),
  });
}

function saveAutoContinuation(
  catalog: CompilerArtifactCatalog,
  preparedArtifactId: string,
  preparedArtifact: CompilerArtifactEnvelope,
  hints: ModuleCompileHints,
): { status: "ok"; continuationId?: string } | { status: "refused"; response: Response } {
  if (hints.resolutions.length === 0) return { status: "ok" };
  const saved = catalog.saveAutoResolveContinuation(preparedArtifactId, preparedArtifact, hints);
  if (saved.status === "ok") return { status: "ok", continuationId: saved.value.id };
  if (saved.status === "indeterminate") return { status: "refused", response: catalogIndeterminate("resolve", saved) };
  return { status: "refused", response: catalogFailure("resolve", saved) };
}

function autoContinuationMatchesPrepared(
  continuation: LoadedAutoResolveContinuation,
  preparedArtifactId: string,
  prepared: { artifactHash: string; identity: { moduleId: string; documentHash: string | null; sourceGraphIdentity: string; preparedQueueHash: string } },
  preparedQueueHash: string,
): boolean {
  return continuation.preparedArtifactId === preparedArtifactId
    && continuation.preparedArtifactHash === prepared.artifactHash
    && continuation.preparedIdentity.moduleId === prepared.identity.moduleId
    && continuation.preparedIdentity.documentHash === prepared.identity.documentHash
    && continuation.preparedIdentity.sourceGraphIdentity === prepared.identity.sourceGraphIdentity
    && continuation.preparedIdentity.preparedQueueHash === prepared.identity.preparedQueueHash
    && continuation.preparedIdentity.preparedQueueHash === preparedQueueHash;
}

/**
 * An admission COMMIT acknowledgement can fail after the catalog's synchronous
 * continuation publication completed.  Do not return a generic unavailable
 * error in that case: prove that the exact continuation ID is readable and
 * still belongs to this prepared artifact before returning it to the caller.
 */
function recoverFencedAutoContinuation(
  catalog: CompilerArtifactCatalog,
  continuationId: string,
  preparedArtifactId: string,
  prepared: { artifact: CompilerArtifactEnvelope; identity: { moduleId: string; documentHash: string | null; sourceGraphIdentity: string; preparedQueueHash: string } },
  preparedQueueHash: string,
): boolean {
  const recovered = catalog.loadAutoResolveContinuation(continuationId);
  if (recovered.status === "refused") return false;
  if (!autoContinuationMatchesPrepared(recovered.value, preparedArtifactId, { artifactHash: prepared.artifact.artifactHash, identity: prepared.identity }, preparedQueueHash)) return false;
  return catalog.validateAutoResolveContinuationHints(recovered.value, prepared.artifact).status === "ok";
}

/**
 * Progress accounting sits outside the orchestrator's validator, so request
 * hints must be treated as untrusted here.  Read only an optional list of
 * string question identities; malformed shapes remain an orchestrator
 * draft-only result rather than becoming an HTTP 500 or a continuation write.
 */
function safeHintQuestionIds(hints: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(hints) || !Array.isArray(hints.resolutions)) return ids;
  for (const resolution of hints.resolutions) {
    if (isRecord(resolution) && typeof resolution.questionId === "string") ids.add(resolution.questionId);
  }
  return ids;
}

function hasValidatedAutoProgress(before: unknown, after: unknown): boolean {
  const beforeIds = safeHintQuestionIds(before);
  for (const questionId of safeHintQuestionIds(after)) {
    if (!beforeIds.has(questionId)) return true;
  }
  return false;
}

function presentationDraftResponse(
  preparedArtifactId: string,
  continuationId: string,
  result: Extract<AutoCompilerOrchestratorResult, { status: "resolved" }>,
  options: { resumed: boolean; progress: boolean },
): Response {
  const payload = result.resolved.artifact.payload as ResolvedCompilerArtifactPayload;
  const readiness = payload.readiness;
  if (readiness.status !== "mechanically_closed") {
    return refusal("resolve", "AUTO_RESOLVE_UNCLOSED", "automatic resolution did not produce a mechanically closed draft", 422);
  }
  return json({
    status: "presentation_draft_only",
    preparedArtifactId,
    continuationId,
    resumed: options.resumed,
    progress: options.progress,
    mechanics: { readiness: readiness.status },
    // Keep the automatic/public boundary aggregate-only: raw source facts,
    // evidence identities, open question ids, and quotation text stay
    // operator-side in the canonical artifact.
    content: publicSourceFactDispositionAggregate(payload.resolvedSourceFactDispositionReport),
    presentation: { readiness: "visibility_unresolved" },
    rounds: publicProposalRounds(result.rounds),
    diagnostics: publicAutoDiagnostics(result.diagnostics),
  });
}

type MachinePublicationWork =
  | { status: "published"; response: Response }
  | { status: "refused"; response: Response };

async function machinePublicationRecoveryResponse(response: Response, continuationId: string | undefined): Promise<Response> {
  if (!continuationId) return response;
  try {
    const body = await response.clone().json();
    if (!isRecord(body) || !isRecord(body.error)) return response;
    const retryAfter = response.headers.get("Retry-After");
    return json(
      { ...body, autoContinuationId: continuationId, recovery: "retry this automatic continuation" },
      response.status,
      retryAfter ? { "Retry-After": retryAfter } : {},
    );
  } catch {
    return response;
  }
}

interface MachinePublicationCatalogWriter {
  saveReview(
    bindings: readonly TrustedPresentationBinding[],
    publication: TrustedPresentationMachinePublication,
  ): CatalogWriteResult<TrustedPresentationReviewMetadata> | Response;
  saveBundle(
    projection: CompilerModuleDataProjection,
    worldModelBinding: CompiledCthulhuWorldModelBinding | undefined,
  ): CatalogWriteResult<BundleCatalogMetadata> | Response;
}

function machinePublicationScopes(
  value: readonly unknown[],
  bindings: readonly TrustedPresentationBinding[],
): TrustedPresentationMachinePublication["scopes"] | undefined {
  if (value.length !== bindings.length) return undefined;
  const bindingPaths = new Set(bindings.map((binding) => binding.fieldPath));
  const scopes: TrustedPresentationMachinePublication["scopes"] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ["fieldPath", "audience"])
      || typeof raw.fieldPath !== "string"
      || (raw.audience !== "public_on_entry" && raw.audience !== "found_clue" && raw.audience !== "terminal_only" && raw.audience !== "private_context")
      || !bindingPaths.has(raw.fieldPath)
      || seen.has(raw.fieldPath)
      || trustedPresentationAudienceForFieldPath(raw.fieldPath) !== raw.audience) return undefined;
    seen.add(raw.fieldPath);
    scopes.push({ fieldPath: raw.fieldPath, audience: raw.audience as TrustedPresentationAudience });
  }
  return seen.size === bindingPaths.size ? scopes.sort((left, right) => left.fieldPath.localeCompare(right.fieldPath)) : undefined;
}

function machineReservationMatches(
  reservation: AutoResolveMachinePublicationReservation,
  publisher: MachinePresentationPublisher,
  resolved: ResolvedCompilerApiResult,
): boolean {
  return reservation.servicePrincipalId === publisher.servicePrincipalId
    && reservation.policyId === publisher.policyId
    && reservation.resolvedArtifactHash === resolved.artifact.artifactHash
    && sameResolvedIdentity(reservation.resolvedIdentity, resolved.identity);
}

function publishMachineResolved(
  catalog: CompilerArtifactCatalog,
  prepared: { id: string; artifact: CompilerArtifactEnvelope; artifactHash: string; identity: { moduleId: string; documentHash: string | null; sourceGraphIdentity: string; preparedQueueHash: string } },
  result: Extract<AutoCompilerOrchestratorResult, { status: "resolved" }>,
  publisher: MachinePresentationPublisher,
  reservation: AutoResolveMachinePublicationReservation,
  canSelect: boolean,
  worldModelBindingResolver: CompiledWorldModelBindingResolver | undefined,
  writer: MachinePublicationCatalogWriter,
  signal: AbortSignal,
  logError?: (error: unknown) => void,
): Promise<MachinePublicationWork> {
  return (async () => {
    if (!machineReservationMatches(reservation, publisher, result.resolved)) {
      return { status: "refused", response: refusal("resolve", "AUTO_PUBLICATION_RESERVATION_MISMATCH", "automatic publication reservation does not match the resolved artifact", 409) };
    }
    const loadedReview = catalog.loadTrustedPresentationReview(reservation.reviewId);
    let bindings: TrustedPresentationBinding[];
    if (loadedReview.status === "ok") {
      const review = loadedReview.value.review;
      if (review.preparedArtifactId !== prepared.id
        || review.preparedArtifactHash !== prepared.artifactHash
        || review.resolvedArtifactHash !== result.resolved.artifact.artifactHash
        || !sameResolvedIdentity(review.resolvedIdentity, result.resolved.identity)
        || review.reviewerPrincipalId !== publisher.servicePrincipalId
        || review.machinePublication?.servicePrincipalId !== publisher.servicePrincipalId
        || review.machinePublication.policyId !== publisher.policyId) {
        return { status: "refused", response: refusal("project", "AUTO_PUBLICATION_REVIEW_MISMATCH", "automatic publication review does not match the resolved artifact", 409) };
      }
      bindings = review.bindings;
    } else if (loadedReview.code !== "CATALOG_NOT_FOUND") {
      return { status: "refused", response: catalogFailure("project", loadedReview) };
    } else {
      if (!canSelect) {
        return { status: "refused", response: json(
          { error: { stage: "project", code: "AUTO_PUBLICATION_RECEIPT_MISSING", message: "automatic publication requires catalog recovery" } },
          503,
          { "Retry-After": "60" },
        ) };
      }
      let selected: Awaited<ReturnType<MachinePresentationPublisher["select"]>>;
      try {
        selected = await publisher.select({
          identity: Object.freeze(structuredClone(result.resolved.identity)),
          readSlotPage: (offset) => buildTrustedPresentationSelectionSlotPage(result.resolved.artifact.payload as ResolvedCompilerArtifactPayload, offset),
          readCandidatePage: (fieldPath, offset) => buildTrustedPresentationSelectionCandidatePage(result.resolved.artifact.payload as ResolvedCompilerArtifactPayload, fieldPath, offset),
          signal,
        });
      } catch {
        // The selector may contain untrusted source prompt text or provider
        // diagnostics. Never surface either through this publication route.
        try { logError?.(new Error("automatic presentation selection failed")); } catch { /* logging cannot widen publication */ }
        return { status: "refused", response: refusal("project", "AUTO_PUBLICATION_SELECTOR_UNAVAILABLE", "automatic presentation selection is unavailable", 503) };
      }
      if (!/^[a-f0-9]{64}$/.test(selected.requestHash) || !/^[a-f0-9]{64}$/.test(selected.responseHash)) {
        return { status: "refused", response: refusal("project", "AUTO_PUBLICATION_RESPONSE_INVALID", "automatic presentation response is invalid", 422) };
      }
      const rehydrated = rehydrateTrustedPresentationSelections(result.resolved.artifact.payload as ResolvedCompilerArtifactPayload, selected.selections);
      if (rehydrated.status === "refused") {
        return { status: "refused", response: refusal("project", "AUTO_PUBLICATION_SELECTION_INVALID", "automatic presentation selection is invalid", 422) };
      }
      const scopes = machinePublicationScopes(selected.scopes, rehydrated.bindings);
      if (!scopes) {
        return { status: "refused", response: refusal("project", "AUTO_PUBLICATION_SCOPE_INVALID", "automatic presentation scope is invalid", 422) };
      }
      bindings = rehydrated.bindings;
      const machinePublication: TrustedPresentationMachinePublication = {
        servicePrincipalId: publisher.servicePrincipalId,
        policyId: publisher.policyId,
        requestHash: selected.requestHash,
        responseHash: selected.responseHash,
        decisionHash: trustedPresentationMachineDecisionIdentity(bindings, scopes),
        coverageHash: trustedPresentationMachineCoverageIdentity(scopes),
        scopes,
      };
      const savedReview = writer.saveReview(
        bindings,
        machinePublication,
      );
      if (savedReview instanceof Response) return { status: "refused", response: savedReview };
      if (savedReview.status === "indeterminate") return { status: "refused", response: catalogIndeterminate("project", savedReview) };
      if (savedReview.status === "refused") return { status: "refused", response: catalogFailure("project", savedReview) };
    }
    const review = catalog.loadTrustedPresentationReview(reservation.reviewId);
    if (review.status === "refused") return { status: "refused", response: catalogFailure("project", review) };
    const projection = projectTrustedResolvedCompilerArtifact(result.resolved.artifact.payload as ResolvedCompilerArtifactPayload, review.value.review);
    if (projection.status === "refused") return { status: "refused", response: downstream("project", projection) };
    const worldModelBinding = resolveCompiledWorldModelBinding(worldModelBindingResolver, {
      moduleId: result.resolved.identity.moduleId,
      artifactHash: result.resolved.artifact.artifactHash,
      documentHash: result.resolved.identity.documentHash,
    }, "resolve", logError);
    if (worldModelBinding instanceof Response) return { status: "refused", response: worldModelBinding };
    const savedBundle = writer.saveBundle(projection, worldModelBinding);
    if (savedBundle instanceof Response) return { status: "refused", response: savedBundle };
    if (savedBundle.status === "indeterminate") return { status: "refused", response: catalogIndeterminate("resolve", savedBundle) };
    if (savedBundle.status === "refused") return { status: "refused", response: catalogFailure("resolve", savedBundle) };
    return {
      status: "published",
      response: json({
        status: "resolved",
        identity: result.resolved.identity,
        artifact: result.resolved.artifact,
        projection,
        bundleId: savedBundle.value.id,
        quality: summarizeCompilerRuntimeQuality(result.resolved.artifact.payload as ResolvedCompilerArtifactPayload),
      }),
    };
  })();
}

function autoAdmissionRefusal(result: Extract<CompilerAutoAdmissionResult, { status: "refused" }>): Response {
  const unavailable = result.code === "AUTO_ADMISSION_POLICY_MISMATCH"
    || result.code === "AUTO_ADMISSION_STORAGE_UNAVAILABLE"
    || result.code === "AUTO_ADMISSION_UNHEALTHY";
  const message = result.code === "AUTO_ADMISSION_RATE_LIMITED"
    ? "automatic compiler resolution rate limit exceeded"
    : unavailable
      ? "automatic compiler admission is unavailable"
      : "automatic compiler resolution is currently busy";
  return json(
    { error: { stage: "resolve", code: result.code, message } },
    unavailable ? 503 : 429,
    { "Retry-After": String(result.retryAfterSeconds) },
  );
}

function autoAdmissionIndeterminateRefusal(retryAfterSeconds = 60): Response {
  return json(
    { error: { stage: "resolve", code: "AUTO_ADMISSION_INDETERMINATE", message: "automatic compiler continuation outcome requires recovery", recovery: "retry the catalog lookup before starting another automatic resolution" } },
    503,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

function autoAdmissionLeaseRefusal(result: { code: string; retryAfterSeconds: number }): Response {
  if (result.code === "AUTO_ADMISSION_INDETERMINATE") return autoAdmissionIndeterminateRefusal(result.retryAfterSeconds);
  if (result.code === "AUTO_ADMISSION_LEASE_EXPIRED") {
    return json(
      { error: { stage: "resolve", code: result.code, message: "automatic compiler admission lease expired" } },
      503,
      { "Retry-After": String(result.retryAfterSeconds) },
    );
  }
  return autoAdmissionRefusal({
    status: "refused",
    code: result.code as Extract<CompilerAutoAdmissionResult, { status: "refused" }>["code"],
    retryAfterSeconds: result.retryAfterSeconds,
  });
}

function autoAdmissionDeadlineRefusal(): Response {
  return json(
    { error: { stage: "resolve", code: "AUTO_ADMISSION_DEADLINE_EXCEEDED", message: "automatic compiler resolution deadline exceeded" } },
    503,
    { "Retry-After": "1" },
  );
}

/**
 * An explicit, bodyless operator operation for a crash-reclaimed physical
 * model slot. This is deliberately separate from auto-resolve: a caller may
 * not smuggle identity, a fence, or a recovery request through compilation
 * input. Authentication/role authorization is completed by the route policy
 * before this function is reachable.
 */
function recoverAutoAdmissionReclaimQuarantine(req: Request, dependencies: CompiledModuleHttpDependencies, hasQuery: boolean): Response {
  // No caller-chosen identity or fence participates. Reject an advertised
  // payload rather than accepting a future accidental control parameter; do
  // not read the body, so rejected callers cannot cause body work.
  const contentLength = req.headers.get("content-length");
  if (hasQuery || req.body !== null || (contentLength !== null && contentLength !== "0")) {
    return refusal("admission", "REQUEST_SHAPE_INVALID", "automatic admission recovery accepts no request parameters or body", 400);
  }
  if (!dependencies.recoverAutoAdmissionReclaimQuarantine) {
    return json(
      { error: { stage: "admission", code: "AUTO_ADMISSION_RECOVERY_UNAVAILABLE", message: "automatic compiler admission recovery is unavailable" } },
      503,
      { "Retry-After": "60" },
    );
  }
  try {
    return json({ stage: "admission", status: "ok", recovered: dependencies.recoverAutoAdmissionReclaimQuarantine() });
  } catch (error) {
    dependencies.logError?.(error);
    return json(
      { error: { stage: "admission", code: "AUTO_ADMISSION_RECOVERY_UNAVAILABLE", message: "automatic compiler admission recovery is unavailable" } },
      503,
      { "Retry-After": "60" },
    );
  }
}

/**
 * Catalog-only public automatic resolution. The catalog load replays artifact
 * validation before an untrusted model sees the prepared graph. It resolves
 * mechanics only; no caller-provided presentation can turn model work into a
 * public projection or durable bundle.
 */
async function autoResolve(
  req: Request,
  catalog: CompilerArtifactCatalog,
  autoCompiler: CompiledModuleHttpDependencies["autoCompiler"],
  principal: CompilerPrincipal,
  deadlineMs: number,
  worldModelBindingResolver?: CompiledWorldModelBindingResolver,
  logError?: (error: unknown) => void,
  /** Transfers the JSON ingress lease only when provider work continues after this HTTP result. */
  retainJsonIngressUntil?: (settlement: Promise<unknown>) => void,
): Promise<Response> {
  if (contentType(req) !== "application/json") return refusal("resolve", "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/json", 415);
  const parsed = await jsonBody(req, "resolve", deadlineMs);
  if (parsed.kind === "refusal") return parsed.response;
  const body = parsed.body;
  const hasExplicitHints = Object.prototype.hasOwnProperty.call(body, "explicitHints");
  const hasContinuation = Object.prototype.hasOwnProperty.call(body, "autoContinuationId");
  if (!hasOnlyKeys(body, ["preparedArtifactId", "preparedQueueHash", "explicitHints", "autoContinuationId"])
    || typeof body.preparedArtifactId !== "string"
    || typeof body.preparedQueueHash !== "string"
    || (hasExplicitHints && hasContinuation)
    || (hasExplicitHints && !isRecord(body.explicitHints))
    || (hasContinuation && typeof body.autoContinuationId !== "string")) {
    return refusal("resolve", "REQUEST_SHAPE_INVALID", "auto-resolve requires preparedArtifactId, preparedQueueHash, and at most one of explicitHints or autoContinuationId", 400);
  }
  // Disabled is a fail-closed capability state. In particular, do not load,
  // resolve, project, or persist merely because a caller supplied a valid ID.
  if (!autoCompiler) return refusal("resolve", "AUTO_COMPILER_UNAVAILABLE", "automatic compiler resolution is unavailable", 503);
  const prepared = catalog.loadPrepared(body.preparedArtifactId);
  if (prepared.status === "refused") return catalogFailure("resolve", prepared);
  if (body.preparedQueueHash !== prepared.value.identity.preparedQueueHash) {
    return refusal("resolve", "RESOLVE_QUEUE_HASH_MISMATCH", "preparedQueueHash does not match the catalog-restored artifact", 409);
  }
  let continuationId: string | undefined;
  let continuationHints: ModuleCompileHints | undefined;
  let loadedContinuation: LoadedAutoResolveContinuation | undefined;
  if (hasContinuation) {
    const continuation = catalog.loadAutoResolveContinuation(body.autoContinuationId as string);
    if (continuation.status === "refused") return catalogFailure("resolve", continuation);
    if (!autoContinuationMatchesPrepared(continuation.value, body.preparedArtifactId, prepared.value, body.preparedQueueHash)) {
      return refusal("resolve", "AUTO_CONTINUATION_MISMATCH", "automatic continuation does not match the catalog-restored prepared artifact", 409);
    }
    const validated = catalog.validateAutoResolveContinuationHints(continuation.value, prepared.value.artifact);
    if (validated.status === "refused") return catalogFailure("resolve", validated);
    continuationId = continuation.value.id;
    continuationHints = continuation.value.hints;
    loadedContinuation = continuation.value;
  }
  // A first request can contain operator-reviewed answers.  They are the
  // current automatic round's baseline, not evidence that the model made
  // progress.  Keep the same baseline for orchestration and for the durable
  // continuation decision below.
  const priorHints = continuationHints ?? (hasExplicitHints ? body.explicitHints as ModuleCompileHints : undefined);
  // This happens only after the request has passed every validation and
  // catalog-replay boundary. A rejected request therefore cannot spend a
  // model start, while the lease covers both orchestration and continuation
  // persistence below.
  const admission = autoCompiler.admission.acquire({
    principalFingerprint: compilerPrincipalFingerprint(principal),
    preparedArtifactId: body.preparedArtifactId,
  });
  if (admission.status === "refused") return autoAdmissionRefusal(admission);
  if (admission.status === "indeterminate") return autoAdmissionIndeterminateRefusal(admission.retryAfterSeconds);
  const cancellation = new AbortController();
  let renewalFailure: Response | undefined;
  let signalLeaseLoss: (() => void) | undefined;
  const leaseLoss = new Promise<{ kind: "lease_lost" }>((resolve) => {
    signalLeaseLoss = () => resolve({ kind: "lease_lost" });
  });
  let deadlineDrain = false;
  let quarantined = false;
  let hardDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let quarantineGuardianTimer: ReturnType<typeof setInterval> | undefined;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  const clearRenewalTimer = () => {
    if (renewalTimer !== undefined) {
      clearInterval(renewalTimer);
      renewalTimer = undefined;
    }
  };
  const clearDrainTimers = () => {
    clearRenewalTimer();
    if (hardDrainTimer !== undefined) {
      clearTimeout(hardDrainTimer);
      hardDrainTimer = undefined;
    }
    if (quarantineGuardianTimer !== undefined) {
      clearInterval(quarantineGuardianTimer);
      quarantineGuardianTimer = undefined;
    }
  };
  const quarantineTimedOutDrain = () => {
    if (quarantined) return;
    const state = admission.quarantine();
    if (state.status !== "quarantined") {
      renewalFailure = autoAdmissionLeaseRefusal(state);
      return;
    }
    quarantined = true;
    clearRenewalTimer();
    // This is a process-liveness guardian, not an admission slot renewal.
    // A restart can reclaim only after this heartbeat expires; a live stuck
    // owner therefore cannot be silently cleared by another process.
    const heartbeatEveryMs = Math.max(1, Math.floor(admission.quarantineHeartbeatTtlMs / 2));
    quarantineGuardianTimer = setInterval(() => {
      const renewed = admission.renewQuarantine();
      if (renewed.status !== "quarantined" && quarantineGuardianTimer !== undefined) {
        clearInterval(quarantineGuardianTimer);
        quarantineGuardianTimer = undefined;
      }
    }, heartbeatEveryMs);
  };
  const settleDeadlineDrain = () => {
    clearDrainTimers();
    if (quarantined) admission.clearQuarantine();
    admission.release();
  };
  renewalTimer = setInterval(() => {
    const renewed = admission.renew();
    if (renewed.status === "refused") {
      renewalFailure = autoAdmissionLeaseRefusal(renewed);
      if (renewed.code === "AUTO_ADMISSION_LEASE_EXPIRED") {
        // A replacement fence may already have started work. Stop this
        // owner immediately rather than letting an in-flight model request
        // run until the unrelated whole-job deadline.
        signalLeaseLoss?.();
        cancellation.abort();
        return;
      }
      if (deadlineDrain) quarantineTimedOutDrain();
    }
  }, admission.renewalIntervalMs);
  const admissionCheckpoint = (): Response | undefined => {
    if (renewalFailure) return renewalFailure;
    if (admission.remainingDeadlineMs() <= 0) return autoAdmissionDeadlineRefusal();
    const active = admission.checkActive();
    if (active.status === "active") return undefined;
    if (active.code === "AUTO_ADMISSION_LEASE_EXPIRED") {
      cancellation.abort();
      // A different process may have created reclaim quarantine before this
      // synchronous checkpoint. Join that exact old-fence health row so the
      // normal finally path clears it only after all local work is settled.
      quarantineTimedOutDrain();
    }
    return autoAdmissionLeaseRefusal(active);
  };
  let releaseAdmissionInFinally = true;
  try {
    const initialCheckpoint = admissionCheckpoint();
    if (initialCheckpoint) return initialCheckpoint;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const mechanicalOrchestration = orchestratePreparedAutoCompiler({
      prepared: {
        status: "prepared",
        identity: structuredClone(prepared.value.identity),
        artifact: structuredClone(prepared.value.artifact),
        questions: structuredClone(prepared.value.artifact.payload.preparedQueue.questions),
      },
      llm: autoCompiler.llm,
      policy: autoCompiler.policy,
      producer: autoCompiler.producer,
      proposalLimits: autoCompiler.limits,
      maxProposalRounds: autoCompiler.maxProposalRounds,
      signal: cancellation.signal,
      ...(priorHints ? { explicitHints: priorHints } : {}),
    });
    const orchestration = mechanicalOrchestration.then(async (result) => {
      if (result.status !== "resolved"
        || (result.resolved.artifact.payload as ResolvedCompilerArtifactPayload).readiness.status !== "mechanically_closed"
        || !autoCompiler.machinePublisher) return { kind: "result" as const, result };
      const baseHints = priorHints ?? {
        schemaVersion: result.hints.schemaVersion,
        moduleId: result.hints.moduleId,
        documentHash: result.hints.documentHash,
        sourceGraphIdentity: result.hints.sourceGraphIdentity,
        resolutions: [],
      };
      const progress = hasValidatedAutoProgress(baseHints, result.hints);
      // An older mechanics-only continuation remains draft-only on a closed
      // replay. A machine reservation, however, is a durable host-owned
      // publication recovery record and must continue through this full work.
      if (!progress && continuationId && !loadedContinuation?.machinePublication) return { kind: "result" as const, result };
      let reservation = progress ? undefined : loadedContinuation?.machinePublication;
      let machineContinuationId = progress ? undefined : continuationId;
      let canSelect = reservation === undefined;
      if (reservation === undefined) {
        const reservationWrite = admission.withActiveFence(() => catalog.saveAutoResolveContinuation(
          body.preparedArtifactId as string,
          prepared.value.artifact,
          result.hints,
          {
            servicePrincipalId: autoCompiler.machinePublisher!.servicePrincipalId,
            policyId: autoCompiler.machinePublisher!.policyId,
            resolvedArtifactHash: result.resolved.artifact.artifactHash,
            resolvedIdentity: result.resolved.identity,
          },
        ));
        if (reservationWrite.status === "indeterminate") {
          return { kind: "result" as const, result, machine: { status: "refused" as const, response: autoAdmissionIndeterminateRefusal(reservationWrite.retryAfterSeconds) } };
        }
        if (reservationWrite.status !== "executed") {
          return { kind: "result" as const, result, machine: { status: "refused" as const, response: autoAdmissionLeaseRefusal(reservationWrite) } };
        }
        const saved = reservationWrite.value;
        if (saved.status === "indeterminate") return { kind: "result" as const, result, machine: { status: "refused" as const, response: catalogIndeterminate("resolve", saved) } };
        if (saved.status === "refused") return { kind: "result" as const, result, machine: { status: "refused" as const, response: catalogFailure("resolve", saved) } };
        reservation = saved.value.machinePublication;
        machineContinuationId = saved.value.id;
        canSelect = true;
        if (!reservation) return { kind: "result" as const, result, machine: { status: "refused" as const, response: refusal("resolve", "AUTO_PUBLICATION_RESERVATION_UNAVAILABLE", "automatic publication reservation is unavailable", 500) } };
      }
      const beforePublication = admissionCheckpoint();
      if (beforePublication) return { kind: "result" as const, result, machine: { status: "refused" as const, response: beforePublication } };
      const machine = await publishMachineResolved(
        catalog,
        {
          id: body.preparedArtifactId as string,
          artifact: prepared.value.artifact,
          artifactHash: prepared.value.artifactHash,
          identity: prepared.value.identity,
        },
        result,
        autoCompiler.machinePublisher,
        reservation,
        canSelect,
        worldModelBindingResolver,
        {
          saveReview: (bindings, machinePublication) => {
            const fenced = admission.withActiveFence(() => catalog.saveTrustedPresentationReview(
              body.preparedArtifactId as string,
              prepared.value.artifact,
              result.resolved.artifact,
              autoCompiler.machinePublisher!.servicePrincipalId,
              bindings,
              { reservedId: reservation!.reviewId, machinePublication },
            ));
            if (fenced.status === "indeterminate") return autoAdmissionIndeterminateRefusal(fenced.retryAfterSeconds);
            if (fenced.status !== "executed") return autoAdmissionLeaseRefusal(fenced);
            return fenced.value;
          },
          saveBundle: (projection, worldModelBinding) => {
            const fenced = admission.withActiveFence(() => catalog.saveBundle(result.resolved.artifact, projection, worldModelBinding, reservation!.bundleId));
            if (fenced.status === "indeterminate") return autoAdmissionIndeterminateRefusal(fenced.retryAfterSeconds);
            if (fenced.status !== "executed") return autoAdmissionLeaseRefusal(fenced);
            return fenced.value;
          },
        },
        cancellation.signal,
        logError,
      );
      return {
        kind: "result" as const,
        result,
        machine: machine.status === "refused"
          ? { ...machine, response: await machinePublicationRecoveryResponse(machine.response, machineContinuationId) }
          : machine,
      };
    });
    // Deadline and fence-loss paths may return an HTTP refusal while an
    // arbitrary provider is still running. Settle the durable admission and
    // the process-local JSON lease from this one observed promise, rather than
    // releasing either merely because the response has been produced.
    const safelyLogBackgroundDrainError = (error: unknown) => {
      try { logError?.(error); } catch { /* logging must not reject the observed drain promise */ }
    };
    const retainBackgroundDrain = () => {
      const drain = orchestration.then(
        () => {
          try { settleDeadlineDrain(); } catch (error) { safelyLogBackgroundDrainError(error); }
        },
        () => {
          try { settleDeadlineDrain(); } catch (error) { safelyLogBackgroundDrainError(error); }
        },
      );
      try {
        retainJsonIngressUntil?.(drain);
      } catch (error) {
        // The normal durable drain remains attached above even if a future
        // caller supplies a broken handoff hook. The outer HTTP wrapper still
        // owns its lease when the transfer callback itself fails.
        safelyLogBackgroundDrainError(error);
      }
    };
    const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), admission.remainingDeadlineMs());
    });
    let outcome: ({ kind: "result"; result: AutoCompilerOrchestratorResult; machine?: MachinePublicationWork } | { kind: "deadline" } | { kind: "lease_lost" });
    try { outcome = await Promise.race([orchestration, deadline, leaseLoss]); }
    finally { if (deadlineTimer !== undefined) clearTimeout(deadlineTimer); }
    if (outcome.kind === "lease_lost") {
      // Fencing is already lost, so the old owner cannot renew, release, or
      // publish. Its still-live model call must nevertheless hold the domain
      // fail-closed until it settles. `quarantine` deliberately accepts this
      // exact stale fence only for the health gate; it never touches a newer
      // lease.
      deadlineDrain = true;
      releaseAdmissionInFinally = false;
      quarantineTimedOutDrain();
      retainBackgroundDrain();
      return renewalFailure ?? autoAdmissionDeadlineRefusal();
    }
    if (outcome.kind === "deadline") {
      // Abort is cooperative: the real client aborts fetch and the
      // orchestrator checks it before every later proposal round.  An
      // arbitrary test/host LLMLike may ignore it, so retain the physical slot
      // until settlement and finally quarantine the whole domain on a bounded
      // hard-drain instead of oversubscribing real model work.
      cancellation.abort();
      releaseAdmissionInFinally = false;
      // Timer ordering can deliver this deadline before a due heartbeat. Take
      // an exact-fence drain renewal synchronously before exposing HTTP 503;
      // otherwise a stale physical TTL could be reclaimed in the response
      // microtask while the unabortable model call is still running.
      const drainLease = admission.renew();
      deadlineDrain = true;
      if (drainLease.status !== "active") {
        quarantineTimedOutDrain();
        retainBackgroundDrain();
        return autoAdmissionLeaseRefusal(drainLease);
      }
      hardDrainTimer = setTimeout(quarantineTimedOutDrain, admission.hardDrainMs);
      retainBackgroundDrain();
      return autoAdmissionDeadlineRefusal();
    }
    const result = outcome.result;
    // A fenced durable bundle may complete during the same synchronous write
    // that crosses the wall clock. Preserve that already-published result;
    // uncommitted selection/refusal paths remain subject to the checkpoint.
    if (outcome.machine?.status === "published") return outcome.machine.response;
    const afterOrchestration = admissionCheckpoint();
    if (afterOrchestration) return afterOrchestration;
    if (outcome.machine) return outcome.machine.response;
    if (result.status === "draft_only") {
      const baseHints = priorHints ?? { schemaVersion: result.hints.schemaVersion, moduleId: result.hints.moduleId, documentHash: result.hints.documentHash, sourceGraphIdentity: result.hints.sourceGraphIdentity, resolutions: [] };
      const progress = hasValidatedAutoProgress(baseHints, result.hints);
      if (!progress && continuationId) return autoDraftResponse(body.preparedArtifactId, result, { continuationId, resumed: true, progress: false });
      const fencedSave = admission.withActiveFence<ReturnType<typeof saveAutoContinuation>>(() => progress ? saveAutoContinuation(catalog, body.preparedArtifactId as string, prepared.value.artifact, result.hints) : { status: "ok" as const });
      if (fencedSave.status === "indeterminate") {
        const saved = fencedSave.value;
        if (!saved) return autoAdmissionIndeterminateRefusal(fencedSave.retryAfterSeconds);
        if (saved.status === "refused") return saved.response;
        if (saved.continuationId && !recoverFencedAutoContinuation(catalog, saved.continuationId, body.preparedArtifactId, prepared.value, body.preparedQueueHash)) {
          return autoAdmissionIndeterminateRefusal(fencedSave.retryAfterSeconds);
        }
        return autoDraftResponse(body.preparedArtifactId, result, { continuationId: saved.continuationId, resumed: !!continuationId, progress });
      }
      if (fencedSave.status !== "executed") return autoAdmissionLeaseRefusal(fencedSave);
      const saved = fencedSave.value;
      // `withActiveFence` validates owner, TTL, and deadline before entering
      // this synchronous catalog critical section. Once it has started, the
      // catalog write cannot be rolled back across its independent durable
      // boundary, so return its real result even if wall time passes the
      // deadline during fsync rather than orphaning a hidden continuation.
      if (saved.status === "refused") return saved.response;
      return autoDraftResponse(body.preparedArtifactId, result, { continuationId: saved.continuationId, resumed: !!continuationId, progress });
    }
    if (result.status === "refused") {
      return json({
        status: "refused",
        preparedArtifactId: body.preparedArtifactId,
        diagnostics: publicAutoDiagnostics(result.diagnostics),
        ...(result.refusal ? { refusal: { stage: result.refusal.stage, code: result.refusal.code } } : {}),
      }, 422);
    }
    const baseHints = priorHints ?? { schemaVersion: result.hints.schemaVersion, moduleId: result.hints.moduleId, documentHash: result.hints.documentHash, sourceGraphIdentity: result.hints.sourceGraphIdentity, resolutions: [] };
    const progress = hasValidatedAutoProgress(baseHints, result.hints);
    if (!progress && continuationId) return presentationDraftResponse(body.preparedArtifactId, continuationId, result, { resumed: true, progress: false });
    const fencedContinuation = admission.withActiveFence<ReturnType<typeof saveAutoContinuation>>(() => progress ? saveAutoContinuation(catalog, body.preparedArtifactId as string, prepared.value.artifact, result.hints) : { status: "ok" as const });
    if (fencedContinuation.status === "indeterminate") {
      const continuation = fencedContinuation.value;
      if (!continuation) return autoAdmissionIndeterminateRefusal(fencedContinuation.retryAfterSeconds);
      if (continuation.status === "refused") return continuation.response;
      if (continuation.continuationId && !recoverFencedAutoContinuation(catalog, continuation.continuationId, body.preparedArtifactId, prepared.value, body.preparedQueueHash)) {
        return autoAdmissionIndeterminateRefusal(fencedContinuation.retryAfterSeconds);
      }
      return continuation.continuationId
        ? presentationDraftResponse(body.preparedArtifactId, continuation.continuationId, result, { resumed: !!continuationId, progress })
        : refusal("resolve", "AUTO_CONTINUATION_UNAVAILABLE", "validated automatic hints could not be retained for manual presentation", 500);
    }
    if (fencedContinuation.status !== "executed") return autoAdmissionLeaseRefusal(fencedContinuation);
    const continuation = fencedContinuation.value;
    // See the draft-only branch: the fenced synchronous publication has an
    // atomic-start deadline contract and must report its true outcome.
    return continuation.status === "refused"
      ? continuation.response
      : continuation.continuationId
        ? presentationDraftResponse(body.preparedArtifactId, continuation.continuationId, result, { resumed: !!continuationId, progress })
        : refusal("resolve", "AUTO_CONTINUATION_UNAVAILABLE", "validated automatic hints could not be retained for manual presentation", 500);
  } catch (error) {
    logError?.(error);
    return refusal("resolve", "AUTO_RESOLVE_INTERNAL", "automatic compiler resolution failed", 500);
  } finally {
    if (releaseAdmissionInFinally) {
      clearDrainTimers();
      if (quarantined) admission.clearQuarantine();
      admission.release();
    }
  }
}

class CompiledSessionCreationAdmissionCheckpoint extends Error {
  constructor(readonly response: Response) {
    super("compiled session creation admission checkpoint failed");
  }
}

/**
 * A durable compiled session may name only a catalog bundle whose presentation
 * was produced by a persisted, exact-source review.  `loadBundle` already
 * replays the bundle/projection contract; this adds the missing catalogue
 * witness so a structurally plausible copied review cannot become publication
 * authority merely by appearing inside a bundle JSON file.
 */
function verifyCatalogBackedTrustedPresentationReview(
  catalog: CompilerArtifactCatalog,
  bundle: LoadedBundleCatalogEntry,
  validated: ValidatedCompiledModuleBundle,
): Response | undefined {
  const review = bundle.projection.presentationReview;
  if (!review) {
    return refusal("session", "TRUSTED_PRESENTATION_REVIEW_REQUIRED", "compiled session bundle requires a trusted presentation review", 422);
  }
  const persisted = catalog.loadTrustedPresentationReview(review.id);
  if (persisted.status === "refused") {
    return refusal("session", "TRUSTED_PRESENTATION_REVIEW_UNAVAILABLE", "compiled session bundle trusted presentation review is unavailable", 422);
  }
  if (review.id !== persisted.value.id
    || review.reviewHash !== persisted.value.reviewHash
    || review.preparedArtifactId !== persisted.value.preparedArtifactId
    || review.preparedArtifactHash !== persisted.value.preparedArtifactHash
    || !samePreparedIdentity(review.preparedIdentity, persisted.value.preparedIdentity)
    || review.resolvedArtifactHash !== bundle.artifactHash
    || !sameResolvedIdentity(review.resolvedIdentity, bundle.identity)
    || persisted.value.resolvedArtifactHash !== bundle.artifactHash
    || !sameResolvedIdentity(persisted.value.resolvedIdentity, bundle.identity)) {
    return refusal("session", "TRUSTED_PRESENTATION_REVIEW_MISMATCH", "compiled session bundle trusted presentation review does not match its artifact", 422);
  }
  // Replay the existing review/projection validator from the durable review
  // witness. No local review grammar or permissive metadata path is added.
  const replayed = projectTrustedResolvedCompilerArtifact(validated.payload, persisted.value.review);
  if (replayed.status !== "projected") {
    return refusal("session", "TRUSTED_PRESENTATION_REVIEW_MISMATCH", "compiled session bundle trusted presentation review is invalid", 422);
  }
  return undefined;
}

async function createSession(
  req: Request,
  dependencies: CompiledModuleHttpDependencies,
  principal: CompilerPrincipal,
  deadlineMs: number,
  admissionCheckpoint?: () => Response | undefined,
): Promise<Response> {
  const checkpoint = (): Response | undefined => admissionCheckpoint?.();
  const checkpointOrThrow = () => {
    const response = checkpoint();
    if (response) throw new CompiledSessionCreationAdmissionCheckpoint(response);
  };
  const initialAdmission = checkpoint();
  if (initialAdmission) return initialAdmission;
  // Assignment is a server trust decision, not a request field. Resolve it
  // before even looking at the creation body or catalog so unavailable or
  // malformed host capability cannot degrade into an owner-only session.
  const player = await resolveCompiledSessionPlayerAssignment(principal, dependencies.resolveCompiledSessionPlayer);
  if (player instanceof Response) return player;
  const afterResolverAdmission = checkpoint();
  if (afterResolverAdmission) return afterResolverAdmission;
  const durableHostCapability = dependencies.compiledDurableHostCapability;
  if (durableHostCapability === undefined || durableHostCapability === null || typeof durableHostCapability !== "object") {
    return refusal("session", "COMPILED_DURABLE_HOST_UNAVAILABLE", "compiled durable host capability is unavailable", 503);
  }
  if (contentType(req) !== "application/json") return refusal("session", "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/json", 415);
  const parsed = await jsonBody(req, "session", deadlineMs);
  if (parsed.kind === "refusal") return parsed.response;
  const afterBodyAdmission = checkpoint();
  if (afterBodyAdmission) return afterBodyAdmission;
  const body = parsed.body;
  if (!hasOnlyKeys(body, ["bundleId", "archetype", "characterName", "personality", "backstory", "currentGoal"])
    || typeof body.bundleId !== "string"
    || typeof body.archetype !== "string" || !body.archetype.trim()
    || typeof body.characterName !== "string" || !body.characterName.trim()
    || ["personality", "backstory", "currentGoal"].some((key) => body[key] !== undefined && typeof body[key] !== "string")) {
    return refusal("session", "REQUEST_SHAPE_INVALID", "compiled session requires a published bundleId, archetype, and characterName", 400);
  }
  const archetype = body.archetype.trim();
  const characterName = body.characterName.trim();
  if (!CharacterFactory.listArchetypes("cosmic-horror").some((candidate) => candidate.id === archetype)) return refusal("session", "ARCHETYPE_UNKNOWN", "compiled session archetype is not available for cosmic-horror", 422);
  const catalog = dependencies.catalog ?? defaultCatalog;
  const beforeCatalogAdmission = checkpoint();
  if (beforeCatalogAdmission) return beforeCatalogAdmission;
  const stored = catalog.loadBundle(body.bundleId);
  if (stored.status === "refused") return catalogFailure("session", stored);
  const validatedStoredBundle = validateCompiledModuleBundle(stored.value.artifact, stored.value.projection);
  if (validatedStoredBundle.status === "refused") return downstream("session", validatedStoredBundle);
  const trustedPresentation = verifyCatalogBackedTrustedPresentationReview(catalog, stored.value, validatedStoredBundle);
  if (trustedPresentation) return trustedPresentation;
  const afterCatalogAdmission = checkpoint();
  if (afterCatalogAdmission) return afterCatalogAdmission;
  let id = "";
  let reservation: ReservationHandle | undefined;
  let namespaceConflict = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const beforeNamespaceAdmission = checkpoint();
    if (beforeNamespaceAdmission) return beforeNamespaceAdmission;
    const candidate = dependencies.generateId();
    if (dependencies.hasSession(candidate) || dependencies.hasDurableSession?.(candidate)) continue;
    try {
      reservation = dependencies.sessionNamespace?.reserve({ sessionId: candidate, kind: "compiled" });
      id = candidate;
      break;
    } catch (error) {
      // A conflicting locator may be retried with a fresh CSPRNG candidate;
      // SQLite busy/policy/fencing is an infrastructure outcome, never a
      // hidden retry loop that could duplicate private construction.
      if (error instanceof SessionNamespaceFailure && error.code === "SESSION_NAMESPACE_CONFLICT") {
        namespaceConflict = true;
        continue;
      }
      return json({ error: { stage: "session", code: error instanceof SessionNamespaceFailure ? error.code : "SESSION_NAMESPACE_STORAGE_FAILED", message: "runtime session namespace is unavailable" } }, 503, { "Retry-After": "1" });
    }
  }
  if (!id) {
    return namespaceConflict
      ? json({ error: { stage: "session", code: "SESSION_NAMESPACE_CONFLICT", message: "runtime session ID is already reserved or committed" } }, 409, { "Cache-Control": "no-store" })
      : refusal("session", "SESSION_ID_COLLISION", "could not allocate a session ID", 409);
  }
  let snapshotAttempt: CompiledSessionSnapshot | undefined;
  let snapshotCommitted = false;
  let admissionLostAfterCommit = false;
  let namespacePublicationIndeterminate = false;
  let namespacePreparedReleased = false;
  let createdSession: SessionLike | undefined;
  let invitation: PlayerDeliveryInvitation | null = null;
  let loadedCompiled: unknown;
  const creationResponse = (session: SessionLike) => json({
    sessionId: id,
    bundleId: stored.value.id,
    generation: session.getCompiledGeneration(),
    character: session.getCharacterSummary(),
    summary: session.getSummary(),
    compiled: loadedCompiled,
    ...(invitation ? { playerInvitation: { invite: invitation.invite, expiresAt: invitation.binding.expiresAt, playPath: `/play/${id}` } } : {}),
  }, 201, invitation ? { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } : {});
  const recoveryRequired = (code: string, message: string) => json({
    error: {
      stage: "session",
      code,
      message,
      recovery: { sessionId: id, generation: 0 },
    },
    ...(invitation ? { playerInvitation: { invite: invitation.invite, expiresAt: invitation.binding.expiresAt, playPath: `/play/${id}` } } : {}),
  }, 503, { "Retry-After": "1", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  try {
    const beforeConstructionAdmission = checkpoint();
    if (beforeConstructionAdmission) return beforeConstructionAdmission;
    // This creates the sole p1 browser grant server-side. The raw invitation
    // exists only until the authenticated creator receives this 201 response;
    // the snapshot holds its verifier, never the secret itself.
    invitation = dependencies.playerDelivery?.issue(id) ?? null;
    const session = createdSession = dependencies.createSession(id, archetype, characterName, { personality: body.personality as string | undefined, backstory: body.backstory as string | undefined, currentGoal: body.currentGoal as string | undefined });
    assertCompiledDurableHostCapability(session, durableHostCapability);
    checkpointOrThrow();
    const loaded = session.loadDurableCompiledModule(stored.value, createCompiledSessionAccessBinding(principal, player, invitation?.binding));
    if (loaded.status === "refused") {
      dependencies.unregisterSession?.(id, session);
      createdSession = undefined;
      dependencies.rollbackSessionStorage?.(id);
      return refusal("session", loaded.code, loaded.message, loaded.code === "COMPILED_SESSION_CONFLICT" ? 409 : 422);
    }
    loadedCompiled = loaded.compiled;
    // Durable snapshot publication precedes registration and the 201 acknowledgement.
    checkpointOrThrow();
    const snapshot = createCompiledDurableSessionSnapshot(session, durableHostCapability);
    snapshotAttempt = snapshot;
    if (reservation && dependencies.sessionNamespace) {
      checkpointOrThrow();
      const prepared = dependencies.sessionNamespace.prepare({
        reservation,
        expectedIdentity: { hash: snapshot.snapshotHash, generation: snapshot.generation, format: "compiled-session-snapshot-v1" },
      });
      const publication = dependencies.sessionNamespace.publishPrepared({
        reservation: prepared,
        publish: (permit) => {
          const beforePersistAdmission = checkpoint();
          if (beforePersistAdmission) throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_INDETERMINATE", "compiled session creation admission was lost before persistence");
          const persisted = dependencies.persistSession(id, session, stored.value.id, snapshot, permit);
          // A namespace-enabled host must return an exact store observation.
          // Treat an older/void dependency as indeterminate rather than
          // acknowledging a durable record we cannot prove.
          return persisted ?? { status: "indeterminate" };
        },
      });
      if (publication.status !== "committed") {
        if (publication.status === "not-published") {
          // `prepare` has replaced the original reservation fence. A known
          // no-write refusal is terminally abandonable only through this
          // returned handle; an indeterminate/throw remains reconcileable.
          namespacePreparedReleased = true;
          try { dependencies.sessionNamespace.release({ reservation: publication.reservation, reasonCode: "CREATE_PUBLICATION_NOT_PUBLISHED" }); }
          catch { /* retain the prepared crash window if terminal release is uncertain */ }
          throw new CompiledSessionSnapshotPersistenceError(
            (publication.failureCode ?? "SNAPSHOT_STORAGE_FAILED") as CompiledSessionSnapshotPersistenceError["code"],
            "compiled snapshot publication was refused",
          );
        }
        namespacePublicationIndeterminate = publication.status === "indeterminate";
        throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_INDETERMINATE", "compiled namespace publication did not commit");
      }
    } else {
      checkpointOrThrow();
      dependencies.persistSession(id, session, stored.value.id, snapshot);
    }
    // A successful durable generation-zero save is the commit point. Neither
    // acknowledgement nor registry installation is permitted to erase a
    // restartable public snapshot afterwards.
    snapshotCommitted = true;
    const afterPublicationAdmission = checkpoint();
    if (afterPublicationAdmission) {
      // The snapshot is a real commit even though the lease was lost just
      // after it. Do not claim it never happened; the catch below follows the
      // exact recovery/readback path before returning any response.
      admissionLostAfterCommit = true;
      throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_INDETERMINATE", "compiled session creation admission was lost after persistence");
    }
    if (reservation && dependencies.sessionNamespace) {
      const expected = recoverySnapshotIdentity(snapshot);
      const installed = expected ? dependencies.recoverPersistedSession?.(id, session, principal, expected) : undefined;
      if (!installed) throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_INDETERMINATE", "compiled namespace commit could not rebuild the real-root session");
      // The host recovery installs a clean real-root object.  The private
      // staging source must never be registered or survive as a winner.
      dependencies.unregisterSession?.(id, session);
      createdSession = undefined;
      return creationResponse(installed);
    }
    if (dependencies.acknowledgeCompiledSnapshot) {
      const beforeAcknowledgeAdmission = checkpoint();
      if (beforeAcknowledgeAdmission) throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_INDETERMINATE", "compiled session creation admission was lost before acknowledgement");
      dependencies.acknowledgeCompiledSnapshot(session, snapshot);
    } else {
      const beforeAcknowledgeAdmission = checkpoint();
      if (beforeAcknowledgeAdmission) throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_INDETERMINATE", "compiled session creation admission was lost before acknowledgement");
      acknowledgeCompiledDurableSessionSnapshot(session, durableHostCapability, snapshot);
    }
    const beforeRegistryAdmission = checkpoint();
    if (beforeRegistryAdmission) throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_INDETERMINATE", "compiled session creation admission was lost before registry installation");
    dependencies.registerSession(id, session);
    return creationResponse(session);
  } catch (error) {
    if (createdSession) dependencies.unregisterSession?.(id, createdSession);
    if (error instanceof CompiledSessionCreationAdmissionCheckpoint && !snapshotCommitted) {
      try { dependencies.rollbackSessionStorage?.(id); } catch (rollbackError) { dependencies.logError?.(rollbackError); }
      return error.response;
    }
    if (error instanceof CompiledSessionCreationAdmissionCheckpoint) admissionLostAfterCommit = true;
    if (error instanceof CompiledSessionSnapshotPersistenceError) {
      dependencies.logError?.(error);
      if (error.code === "SNAPSHOT_CONFLICT") return refusal("session", error.code, error.message, 409);
      if (error.code === "SNAPSHOT_BUSY") return json({ error: { stage: "session", code: error.code, message: error.message } }, 503, { "Retry-After": "1" });
      if (error.code === "SNAPSHOT_QUOTA_EXCEEDED") return json({ error: { stage: "session", code: error.code, message: "compiled snapshot capacity is unavailable" } }, 507);
      if (error.code === "SNAPSHOT_POLICY_MISMATCH") return json({ error: { stage: "session", code: error.code, message: "compiled snapshot policy is unavailable" } }, 500);
    }
    const recoveryEligible = (error instanceof CompiledSessionSnapshotPersistenceError && error.code === "SNAPSHOT_INDETERMINATE") || snapshotCommitted;
    if (recoveryEligible) {
      dependencies.logError?.(error);
      const expectedSnapshot = recoverySnapshotIdentity(snapshotAttempt);
      if (!expectedSnapshot) {
        return recoveryRequired(
          error instanceof CompiledSessionSnapshotPersistenceError ? error.code : "SESSION_CREATION_RECOVERY_REQUIRED",
          error instanceof CompiledSessionSnapshotPersistenceError ? error.message : "compiled session is durable but local installation did not complete",
        );
      }
      try {
        const recovered = dependencies.recoverPersistedSession?.(id, createdSession, principal, expectedSnapshot);
        if (recovered) {
          if (admissionLostAfterCommit) {
            return recoveryRequired("COMPILED_SESSION_CREATION_ADMISSION_LOST", "compiled session was persisted after creation admission was lost");
          }
          return creationResponse(recovered);
        }
      } catch (recoveryError) {
        dependencies.logError?.(recoveryError);
      }
      return recoveryRequired(
        error instanceof CompiledSessionSnapshotPersistenceError ? error.code : "SESSION_CREATION_RECOVERY_REQUIRED",
        error instanceof CompiledSessionSnapshotPersistenceError ? error.message : "compiled session is durable but local installation did not complete",
      );
    }
    // Before the durable save commit point, this remains private local
    // construction state and may be cleaned up normally.  Typed storage
    // failures arrive here only after save has classified them as pre-commit.
    try { dependencies.rollbackSessionStorage?.(id); } catch (rollbackError) { dependencies.logError?.(rollbackError); }
    dependencies.logError?.(error);
    return refusal("session", "SESSION_INTERNAL", "compiled session could not be created", 500);
  } finally {
    if (reservation && dependencies.sessionNamespace && !snapshotCommitted && !namespacePublicationIndeterminate && !namespacePreparedReleased) {
      try { dependencies.sessionNamespace.release({ reservation, reasonCode: "CREATE_PUBLICATION_FAILED" }); }
      catch { /* terminal tombstone best effort; it must never affect another owner */ }
    }
  }
}

/** Route core with injected mutable server dependencies; it never starts a server or owns session state. */
export async function handleCompiledModuleHttpRequest(req: Request, dependencies: CompiledModuleHttpDependencies): Promise<Response | null> {
  const url = new URL(req.url);
  const catalog = dependencies.catalog ?? defaultCatalog;
  const deadlineMs = bodyReadDeadlineMs(dependencies.bodyReadDeadlineMs);
  const policy = compilerRoutePolicy(req, url.pathname);
  if (!policy) return null;
  // A server that has already paid the cold-path authentication cost must
  // carry its private one-shot proof. Any supplied but unknown proof is a
  // refusal, never a reason to invoke a potentially stateful authenticator.
  const principal = "compilerHttpRoutePreauthorization" in dependencies
    ? consumeCompilerHttpRoutePreauthorization(dependencies.compilerHttpRoutePreauthorization, req, url.pathname, policy)
    : await authorizeCompilerRequest(req, dependencies.authenticateCompilerRequest, policy);
  if (principal instanceof Response) return principal;
  if (req.method === "GET" && /^\/api\/compiler\/(artifacts|bundles)\/[^/]+$/.test(url.pathname)) {
    const [, , , kind, id] = url.pathname.split("/");
    const loaded = kind === "artifacts" ? catalog.loadPrepared(id!) : catalog.loadBundle(id!);
    if (loaded.status === "refused") return catalogFailure("resolve", loaded);
    if (kind === "bundles") {
      // The binding is a server-owned runtime capability. Operators and
      // keepers may inspect a bundle, but never receive its dataset root or
      // other binding material through this metadata route.
      const { worldModelBinding: _worldModelBinding, ...publicBundle } = loaded.value as LoadedBundleCatalogEntry;
      return json({ stage: "bundle", ...publicBundle });
    }
    return json({ stage: "prepared", ...loaded.value });
  }
  if (url.pathname === "/api/compiler/prepare") {
    return prepare(req, catalog, principal, dependencies.pdfPrepareIngressAdmission ?? sharedPdfPrepareIngressAdmission, deadlineMs, dependencies.logError);
  }
  const jsonIngressStage = url.pathname === "/api/compiler/resolve" || url.pathname === "/api/compiler/auto-resolve"
    ? "resolve" as const
    : url.pathname === "/api/compiler/presentation-workbench" || url.pathname === "/api/compiler/presentation-reviews"
      ? "project" as const
      : undefined;
  if (jsonIngressStage) {
    const lease = admitCompilerJsonIngress(
      req,
      principal,
      jsonIngressStage,
      dependencies.jsonIngressAdmission ?? sharedCompilerJsonIngressAdmission,
    );
    if (lease instanceof Response) return lease;
    const retainedJsonIngressSettlements: Promise<unknown>[] = [];
    let jsonIngressHandoffClosed = false;
    const safelyLogJsonIngressError = (error: unknown) => {
      try { dependencies.logError?.(error); } catch { /* a logger must not orphan an ingress lease */ }
    };
    const safelyReleaseJsonIngress = () => {
      try { lease.release(); } catch (error) { safelyLogJsonIngressError(error); }
    };
    const retainJsonIngressUntil = (settlement: Promise<unknown>) => {
      if (jsonIngressHandoffClosed) {
        // `autoResolve` retains synchronously today. Do not let an accidental
        // future late callback throw or release a completed lease twice.
        safelyLogJsonIngressError(new Error("compiler JSON ingress retention arrived after request finalization"));
        return;
      }
      try {
        retainedJsonIngressSettlements.push(Promise.resolve(settlement));
      } catch (error) {
        // A future broken handoff hook cannot prevent the outer finally from
        // releasing this process-local slot.
        safelyLogJsonIngressError(error);
      }
    };
    try {
      if (url.pathname === "/api/compiler/resolve") {
        return await resolve(req, catalog, deadlineMs, dependencies.resolveCompiledWorldModelBinding, dependencies.logError);
      }
      if (url.pathname === "/api/compiler/auto-resolve") {
        // The durable automatic admission remains independent. This outer
        // lease spans its body parse, model/provider work, and persistence.
        return await autoResolve(req, catalog, dependencies.autoCompiler, principal, deadlineMs, dependencies.resolveCompiledWorldModelBinding, dependencies.logError, retainJsonIngressUntil);
      }
      if (url.pathname === "/api/compiler/presentation-workbench") {
        return await presentationWorkbench(req, catalog, deadlineMs, dependencies.logError);
      }
      return await mintPresentationReview(req, catalog, principal, deadlineMs, dependencies.logError);
    } finally {
      handoffIngressLeaseToBodyReaderDrain(
        req,
        safelyReleaseJsonIngress,
        dependencies.logError,
        (bodyDrain) => retainedJsonIngressSettlements.push(bodyDrain),
      );
      jsonIngressHandoffClosed = true;
      if (retainedJsonIngressSettlements.length === 0) {
        safelyReleaseJsonIngress();
      } else {
        // Collect body cancellation and any auto-resolve provider drain in
        // one handoff, so neither can reopen JSON ingress capacity early.
        try {
          void Promise.allSettled(retainedJsonIngressSettlements).then(
            () => safelyReleaseJsonIngress(),
            (error) => {
              safelyLogJsonIngressError(error);
              safelyReleaseJsonIngress();
            },
          );
        } catch (error) {
          safelyLogJsonIngressError(error);
          safelyReleaseJsonIngress();
        }
      }
    }
  }
  if (url.pathname === "/api/compiler/auto-admission/recover") return recoverAutoAdmissionReclaimQuarantine(req, dependencies, !!url.search);
  if (url.pathname === "/api/sessions/compiled") {
    const lease = admitCompiledSessionCreationIngress(
      req,
      principal,
      dependencies.compiledSessionCreationIngressAdmission ?? sharedCompiledSessionCreationIngressAdmission,
    );
    if (lease instanceof Response) return lease;
    const safelyReleaseCompiledCreationIngress = () => {
      try { lease.release(); } catch (error) {
        try { dependencies.logError?.(error); } catch { /* logging cannot retain an ingress slot */ }
      }
    };
    let durableAdmission: CompiledSessionCreationAdmissionResult;
    try {
      const coordinator = dependencies.compiledSessionCreationAdmission;
      if (!coordinator) {
        safelyReleaseCompiledCreationIngress();
        return json({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_UNAVAILABLE", message: "compiled session creation is unavailable" } }, 503, { "Retry-After": "1" });
      }
      durableAdmission = coordinator.acquire({ principalFingerprint: compilerPrincipalFingerprint(principal) });
    } catch (error) {
      try { dependencies.logError?.(error); } catch { /* no secondary observable fault */ }
      safelyReleaseCompiledCreationIngress();
      return json({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_UNAVAILABLE", message: "compiled session creation is unavailable" } }, 503, { "Retry-After": "1" });
    }
    if (durableAdmission.status !== "acquired") {
      safelyReleaseCompiledCreationIngress();
      return compiledSessionCreationAdmissionRefusal(durableAdmission);
    }
    const durableGuard = guardCompiledSessionCreationAdmission(durableAdmission);
    const finishCreationLeases = () => {
      // The durable release is exact-owner/fence aware and never turns an
      // already committed 201 into an error. Process-local release follows
      // even when durable recovery is intentionally quarantined.
      durableGuard.finish();
      safelyReleaseCompiledCreationIngress();
    };
    try {
      // Keep the in-process slot over every creation phase, including host
      // player assignment, body parsing, durable publication, recovery, and
      // registry installation. The durable SQLite lease covers that same
      // span. `await` is intentional: releasing around a bare returned
      // Promise would reopen capacity while it still mutates.
      const initial = durableGuard.checkpoint();
      if (initial) return initial;
      return await createSession(req, dependencies, principal, deadlineMs, durableGuard.checkpoint);
    } finally {
      // The controller lease itself is idempotent. A hostile host injection
      // must not replace a completed response with a release fault. If body
      // cancellation is still draining, retain *both* leases until its real
      // settlement; a resolver without cancellation is already awaited by
      // createSession before this finally runs.
      if (!handoffIngressLeaseToBodyReaderDrain(req, finishCreationLeases, dependencies.logError)) {
        finishCreationLeases();
      }
    }
  }
  return null;
}

const defaultCatalog = new CompilerArtifactCatalog();
