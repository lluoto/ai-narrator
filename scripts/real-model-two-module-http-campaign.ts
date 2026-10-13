/**
 * Internal, host-controlled workflow for the existing HTTP compiler routes.
 *
 * It intentionally does not construct an LLM client, a catalog, or an
 * orchestrator. Its only authority is to carry the two explicitly authorized
 * local documents through the normal `/prepare` and `/auto-resolve` contracts.
 * The injected transport remains responsible for authenticated delivery.
 */
import { readFileSync } from "fs";
import { REAL_MODEL_DOCUMENTS, uploadsAreAuthorized } from "./real-model-two-module-acceptance";
import { sha256 } from "../src/ingest/document-ir";
import { COMPILER_ARTIFACT_CATALOG_ID_PATTERN } from "../src/compiler/compiler-artifact-catalog";

const DEFAULT_MAX_AUTO_RESOLVE_ATTEMPTS_PER_MODULE = 4;
const HASH = /^[a-f0-9]{64}$/;
const PUBLIC_RESPONSE_CODES = new Set([
  "AUTO_ADMISSION_BUSY",
  "AUTO_ADMISSION_CAPACITY_EXHAUSTED",
  "AUTO_ADMISSION_DEADLINE_EXCEEDED",
  "AUTO_ADMISSION_INDETERMINATE",
  "AUTO_ADMISSION_LEASE_EXPIRED",
  "AUTO_ADMISSION_POLICY_MISMATCH",
  "AUTO_ADMISSION_RATE_LIMITED",
  "AUTO_ADMISSION_STORAGE_UNAVAILABLE",
  "AUTO_ADMISSION_UNHEALTHY",
  "AUTO_COMPILER_UNAVAILABLE",
  "AUTO_CONTINUATION_MISMATCH",
  "AUTO_RESOLVE_INTERNAL",
  "PDF_EMPTY",
  "PDF_TEXT_UNAVAILABLE",
  "PREPARE_ADMISSION_BUSY",
  "PREPARE_INGRESS_BUSY",
  "PREPARE_INTERNAL",
  "PREPARE_ISOLATION_UNAVAILABLE",
  "PREPARE_PDF_INVALID",
  "PREPARE_RESOURCE_LIMIT_EXCEEDED",
  "REQUEST_SHAPE_INVALID",
  "RESOLVE_QUEUE_HASH_MISMATCH",
]);

export interface HttpCampaignDocument {
  /** Stable report alias only; source paths and module IDs are never rendered. */
  id: "fuzu" | "barn";
  moduleId: string;
  path: string;
}

/** An already authenticated in-process handler or HTTP fetch adapter. */
export type HttpCampaignTransport = (request: Request) => Promise<Response>;

/**
 * Script-private scheduling context. It is supplied by the host immediately
 * around one internal auto-resolve dispatch; no report or HTTP body receives
 * it. The callback owns async-local propagation so an in-flight handler can
 * retain its immutable module scope while a later turn begins.
 */
export interface TwoModuleAutoResolveAttemptContext {
  readonly module: HttpCampaignDocument["id"];
}

/**
 * The only short-lived publication handle the campaign may give a host. The
 * host must load `bundleId` from its own catalog and verify this identity and
 * resolved hash before it creates any runtime/session state. Nothing returned
 * by the transport beyond these checked values crosses this boundary.
 */
export interface TwoModulePublishedArtifact {
  module: HttpCampaignDocument["id"];
  bundleId: string;
  identity: {
    moduleId: string;
    documentHash: string;
    sourceGraphIdentity: string;
    preparedQueueHash: string;
    preparedArtifactHash: string;
    resolvedArtifactHash: string;
  };
}

/**
 * Host-owned, ephemeral bundle consumer. `true` only means the host consumed
 * the checked bundle handle; it is not a claim that a session or playthrough
 * was accepted. The callback is deliberately not given raw projection,
 * quality, source, or provider fields from the HTTP response.
 */
export type TwoModulePublishedArtifactConsumer = (artifact: TwoModulePublishedArtifact) => boolean | Promise<boolean>;

export interface TwoModuleHttpCampaignInput {
  /** Defaults to the two local documents registered by the existing acceptance script. */
  documents?: readonly HttpCampaignDocument[];
  /** Per-invocation hash authorization; this function never persists it. */
  allowedDocumentHashes: readonly string[];
  transport: HttpCampaignTransport;
  /** Test seam; production defaults to a local byte read. */
  readDocument?: (document: HttpCampaignDocument) => Uint8Array | Promise<Uint8Array>;
  /** Test seam for phase timing. Values are used only as monotonic wall-clock samples. */
  now?: () => number;
  /** Bounds HTTP workflow attempts, not hidden provider retries. */
  maxAutoResolveAttemptsPerModule?: number;
  /** Explicit host-only fair scheduler; omission preserves legacy sequential turns. */
  interleaveAutoResolveAttempts?: boolean;
  /**
   * Host-owned async scope for exactly one auto-resolve transport dispatch.
   * It cannot alter the request body or the durable/public campaign report.
   */
  runAutoResolveAttempt?<T>(
    context: TwoModuleAutoResolveAttemptContext,
    dispatch: () => Promise<T>,
  ): Promise<T>;
  /**
   * Optional host-owned consumer for a complete, isolated pair of resolved
   * bundles. It receives each verified handle once and is never persisted by
   * this campaign runner.
   */
  consumePublished?: TwoModulePublishedArtifactConsumer;
}

export type TwoModuleHttpCampaignModuleStatus =
  | "mechanics_closed"
  | "stopped_no_progress"
  | "attempt_budget_exhausted"
  | "not_authorized"
  | "document_unavailable"
  | "configuration_refused"
  | "prepare_refused"
  | "stopped_prepare_failure"
  | "identity_refused"
  | "response_refused"
  | "published_unconsumed"
  | "published_consumed"
  | "published_consumer_refused"
  | "published_consumer_failed";

export interface TwoModuleHttpCampaignTiming {
  /** Local byte read plus SHA-256 calculation; it contains no HTTP/provider time. */
  localInputElapsedMs: number;
  /** Wall time of the existing `/prepare` transport request. */
  prepareElapsedMs: number;
  /** Wall time of `/auto-resolve` requests, including server validation CPU; never provider-only latency. */
  autoResolveElapsedMs: number;
}

export interface TwoModuleHttpCampaignModuleReport {
  module: HttpCampaignDocument["id"];
  status: TwoModuleHttpCampaignModuleStatus;
  /** Hash-only identity evidence. Opaque catalog/continuation IDs are intentionally omitted. */
  identity?: {
    documentHash: string;
    preparedArtifactHash: string;
    resolvedArtifactHash?: string;
    sourceGraphIdentity: string;
    preparedQueueHash: string;
  };
  autoResolveAttempts: number;
  /**
   * Sum of the server's public `rounds[].callCount`, not a lower-layer network
   * request count. `unobservable` includes malformed/missing public rounds and
   * failed/deadline calls whose provider drain may still be live.
   */
  reportedProposalCalls: number | "unobservable";
  timing: TwoModuleHttpCampaignTiming;
  /** Sanitized response/transport code only; never body, endpoint, model, or token. */
  code?: string;
}

export interface TwoModuleHttpCampaignReport {
  /** 1.1.0 separates prepared and resolved artifact-hash evidence. */
  schemaVersion: "1.1.0";
  /** The runner can bound HTTP attempts only; it cannot enforce provider retry budgets behind the server transport. */
  autoResolveAttemptBudget: {
    kind: "http_workflow_attempts_only";
    maxAutoResolveAttemptsPerModule: number;
  };
  modules: TwoModuleHttpCampaignModuleReport[];
}

interface LocalDocument {
  document: HttpCampaignDocument;
  bytes: Uint8Array;
  documentHash: string;
  localInputElapsedMs: number;
}

interface PreparedDocument extends LocalDocument {
  preparedArtifactId: string;
  preparedArtifactHash: string;
  sourceGraphIdentity: string;
  preparedQueueHash: string;
  prepareElapsedMs: number;
}

interface ResolvedPublicationCandidate extends TwoModulePublishedArtifact {}

interface ModuleProgress {
  report: TwoModuleHttpCampaignModuleReport;
  prepared?: PreparedDocument;
  published?: ResolvedPublicationCandidate;
  continuationId?: string;
}

function safeElapsed(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function emptyTiming(localInputElapsedMs = 0): TwoModuleHttpCampaignTiming {
  return { localInputElapsedMs, prepareElapsedMs: 0, autoResolveElapsedMs: 0 };
}

function initialReport(document: HttpCampaignDocument, status: TwoModuleHttpCampaignModuleStatus, localInputElapsedMs = 0, code?: string): TwoModuleHttpCampaignModuleReport {
  return {
    module: document.id,
    status,
    autoResolveAttempts: 0,
    reportedProposalCalls: 0,
    timing: emptyTiming(localInputElapsedMs),
    ...(code ? { code } : {}),
  };
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && PUBLIC_RESPONSE_CODES.has(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function responseCode(value: unknown, fallback: string): string {
  return isRecord(value) && isRecord(value.error) ? safeCode(value.error.code, fallback) : fallback;
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

function defaultReadDocument(document: HttpCampaignDocument): Uint8Array {
  return new Uint8Array(readFileSync(document.path));
}

function exactDocuments(value: readonly HttpCampaignDocument[]): value is readonly [HttpCampaignDocument, HttpCampaignDocument] {
  return value.length === 2
    && new Set(value.map((document) => document.id)).size === 2
    && new Set(value.map((document) => document.moduleId)).size === 2
    && value.every((document) => (document.id === "fuzu" || document.id === "barn") && document.moduleId.trim().length > 0);
}

function attemptLimit(value: number | undefined): number | undefined {
  if (value === undefined) return DEFAULT_MAX_AUTO_RESOLVE_ATTEMPTS_PER_MODULE;
  return Number.isSafeInteger(value) && value > 0 && value <= 8
    ? value
    : undefined;
}

function parsedPrepared(document: LocalDocument, value: unknown, prepareElapsedMs: number): PreparedDocument | undefined {
  if (!isRecord(value) || value.status !== "prepared" || !COMPILER_ARTIFACT_CATALOG_ID_PATTERN.test(String(value.preparedArtifactId ?? ""))
    || !isRecord(value.identity) || !isRecord(value.artifact)) return undefined;
  const identity = value.identity;
  const preparedArtifactId = value.preparedArtifactId;
  const preparedArtifactHash = value.artifact.artifactHash;
  if (typeof preparedArtifactId !== "string" || typeof preparedArtifactHash !== "string"
    || identity.moduleId !== document.document.moduleId
    || identity.documentHash !== document.documentHash
    || typeof identity.sourceGraphIdentity !== "string" || !HASH.test(identity.sourceGraphIdentity)
    || typeof identity.preparedQueueHash !== "string" || !HASH.test(identity.preparedQueueHash)
    || !HASH.test(preparedArtifactHash)) return undefined;
  return {
    ...document,
    preparedArtifactId,
    preparedArtifactHash,
    sourceGraphIdentity: identity.sourceGraphIdentity,
    preparedQueueHash: identity.preparedQueueHash,
    prepareElapsedMs,
  };
}

function identitiesAreIsolated(prepared: readonly PreparedDocument[]): boolean {
  if (prepared.length !== 2) return false;
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  // Mirror the compiler's actual module/document/graph identity axes; catalog
  // IDs are also required distinct because this workflow must not cross resume.
  return unique(prepared.map((entry) => entry.document.moduleId))
    && unique(prepared.map((entry) => entry.documentHash))
    && unique(prepared.map((entry) => entry.sourceGraphIdentity))
    && unique(prepared.map((entry) => entry.preparedArtifactHash))
    && unique(prepared.map((entry) => entry.preparedQueueHash))
    && unique(prepared.map((entry) => entry.preparedArtifactId));
}

function reportIdentity(prepared: PreparedDocument): NonNullable<TwoModuleHttpCampaignModuleReport["identity"]> {
  return {
    documentHash: prepared.documentHash,
    preparedArtifactHash: prepared.preparedArtifactHash,
    sourceGraphIdentity: prepared.sourceGraphIdentity,
    preparedQueueHash: prepared.preparedQueueHash,
  };
}

function reportedCalls(value: unknown): number | "unobservable" {
  if (!isRecord(value) || !Array.isArray(value.rounds)) return "unobservable";
  let total = 0;
  for (const round of value.rounds) {
    if (!isRecord(round) || typeof round.callCount !== "number" || !Number.isSafeInteger(round.callCount) || round.callCount < 0) return "unobservable";
    total += round.callCount;
    if (!Number.isSafeInteger(total)) return "unobservable";
  }
  return total;
}

function addReportedCalls(current: number | "unobservable", next: number | "unobservable"): number | "unobservable" {
  if (current === "unobservable" || next === "unobservable") return "unobservable";
  const sum = current + next;
  return Number.isSafeInteger(sum) ? sum : "unobservable";
}

interface DraftAutoResponse {
  status: "draft_only" | "presentation_draft_only";
  preparedArtifactId: string;
  continuationId?: string;
  progress: boolean;
  mechanics?: { readiness?: unknown };
}

interface ResolvedAutoResponse {
  status: "resolved";
  publication: ResolvedPublicationCandidate;
}

type PublicAutoResponse = DraftAutoResponse | ResolvedAutoResponse;

/**
 * Parses only the aggregate fields that bind an automatic result to the
 * prepared input. The campaign cannot authoritatively validate a catalog
 * bundle from an HTTP response; that mandatory canonical check belongs to the
 * host-owned `consumePublished` callback.
 */
function parsedAutoResponse(value: unknown, prepared: PreparedDocument): PublicAutoResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status === "resolved") {
    if (!isRecord(value.identity) || !isRecord(value.artifact)
      || !isRecord(value.projection) || !isRecord(value.quality)
      || typeof value.bundleId !== "string" || !COMPILER_ARTIFACT_CATALOG_ID_PATTERN.test(value.bundleId)
      || value.identity.moduleId !== prepared.document.moduleId
      || value.identity.documentHash !== prepared.documentHash
      || value.identity.sourceGraphIdentity !== prepared.sourceGraphIdentity
      || value.identity.preparedQueueHash !== prepared.preparedQueueHash
      || typeof value.artifact.artifactHash !== "string" || !HASH.test(value.artifact.artifactHash)) return undefined;
    return {
      status: "resolved",
      publication: {
        module: prepared.document.id,
        bundleId: value.bundleId,
        identity: {
          moduleId: prepared.document.moduleId,
          documentHash: prepared.documentHash,
          sourceGraphIdentity: prepared.sourceGraphIdentity,
          preparedQueueHash: prepared.preparedQueueHash,
          preparedArtifactHash: prepared.preparedArtifactHash,
          resolvedArtifactHash: value.artifact.artifactHash,
        },
      },
    };
  }
  if (!isRecord(value)
    || (value.status !== "draft_only" && value.status !== "presentation_draft_only")
    || value.preparedArtifactId !== prepared.preparedArtifactId
    || typeof value.progress !== "boolean") return undefined;
  if (value.continuationId !== undefined && (typeof value.continuationId !== "string" || !COMPILER_ARTIFACT_CATALOG_ID_PATTERN.test(value.continuationId))) return undefined;
  if (value.status === "draft_only" && value.progress && value.continuationId === undefined) return undefined;
  if (value.status === "presentation_draft_only"
    && (!isRecord(value.mechanics) || value.mechanics.readiness !== "mechanically_closed" || value.continuationId === undefined)) return undefined;
  return {
    status: value.status,
    preparedArtifactId: value.preparedArtifactId,
    progress: value.progress,
    ...(typeof value.continuationId === "string" ? { continuationId: value.continuationId } : {}),
    ...(isRecord(value.mechanics) ? { mechanics: { readiness: value.mechanics.readiness } } : {}),
  };
}

function withPreparedReport(progress: ModuleProgress, prepared: PreparedDocument): void {
  progress.prepared = prepared;
  progress.report.identity = reportIdentity(prepared);
  progress.report.timing.prepareElapsedMs = prepared.prepareElapsedMs;
}

function withPublishedReport(progress: ModuleProgress, publication: ResolvedPublicationCandidate): void {
  progress.published = publication;
  progress.report.identity = {
    ...reportIdentity(progress.prepared!),
    resolvedArtifactHash: publication.identity.resolvedArtifactHash,
  };
  // A syntactically bound HTTP result has not yet been loaded and checked by
  // the host catalog, and is intentionally not reported as a play/session
  // outcome. It may remain here permanently when no host consumer was given.
  progress.report.status = "published_unconsumed";
}

function publishedIdentitiesAreIsolated(published: readonly ResolvedPublicationCandidate[]): boolean {
  if (published.length !== 2) return false;
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  return unique(published.map((entry) => entry.module))
    && unique(published.map((entry) => entry.bundleId))
    && unique(published.map((entry) => entry.identity.moduleId))
    && unique(published.map((entry) => entry.identity.documentHash))
    && unique(published.map((entry) => entry.identity.sourceGraphIdentity))
    && unique(published.map((entry) => entry.identity.preparedQueueHash))
    && unique(published.map((entry) => entry.identity.preparedArtifactHash))
    && unique(published.map((entry) => entry.identity.resolvedArtifactHash));
}

async function consumePublishedPair(
  progress: readonly ModuleProgress[],
  consumePublished: TwoModulePublishedArtifactConsumer | undefined,
): Promise<void> {
  const published = progress.flatMap((entry) => entry.published ? [entry.published] : []);
  // Never hand a singleton to the host in a two-module campaign: the other
  // module may still be a draft or a malformed response, so campaign-level
  // isolation has not been demonstrated.
  if (published.length === 0 || published.length !== progress.length) return;
  if (!publishedIdentitiesAreIsolated(published)) {
    for (const entry of progress) {
      if (!entry.published) continue;
      entry.report.status = "identity_refused";
      entry.report.code = "published_identity_not_isolated";
    }
    return;
  }
  if (!consumePublished) return;
  for (const entry of progress) {
    const publication = entry.published!;
    try {
      if (await consumePublished(publication) === true) {
        // This states only that the host callback accepted its own catalog
        // verification. It never stands in for session or play validation.
        entry.report.status = "published_consumed";
      } else {
        entry.report.status = "published_consumer_refused";
        entry.report.code = "published_consumer_refused";
      }
    } catch {
      entry.report.status = "published_consumer_failed";
      entry.report.code = "published_consumer_failed";
    }
  }
}

/**
 * Drives only the public production HTTP workflow. It never asks the model
 * directly or sends benchmark hints. Resolved bundle handles can cross only to
 * a host-owned ephemeral consumer; opaque catalog/continuation identifiers
 * never appear in the report.
 */
export async function runTwoModuleHttpCampaign(input: TwoModuleHttpCampaignInput): Promise<TwoModuleHttpCampaignReport> {
  const documents = input.documents ?? REAL_MODEL_DOCUMENTS;
  const configuredAttemptLimit = attemptLimit(input.maxAutoResolveAttemptsPerModule);
  if (configuredAttemptLimit === undefined) {
    return {
      schemaVersion: "1.1.0",
      autoResolveAttemptBudget: { kind: "http_workflow_attempts_only", maxAutoResolveAttemptsPerModule: 0 },
      modules: exactDocuments(documents)
        ? documents.map((document) => initialReport(document, "configuration_refused", 0, "auto_attempt_budget_invalid"))
        : [],
    };
  }
  const maxAutoResolveAttemptsPerModule = configuredAttemptLimit;
  if (!exactDocuments(documents)) {
    return {
      schemaVersion: "1.1.0",
      autoResolveAttemptBudget: { kind: "http_workflow_attempts_only", maxAutoResolveAttemptsPerModule },
      modules: [],
    };
  }
  const now = input.now ?? Date.now;
  const reader = input.readDocument ?? defaultReadDocument;
  const progress: ModuleProgress[] = documents.map((document) => ({ report: initialReport(document, "document_unavailable") }));
  const local = new Map<HttpCampaignDocument["id"], LocalDocument>();

  for (const [index, document] of documents.entries()) {
    const started = now();
    try {
      const bytes = new Uint8Array(await reader(document));
      const documentHash = sha256(bytes);
      const localInputElapsedMs = safeElapsed(started, now());
      if (bytes.byteLength === 0) {
        progress[index]!.report = initialReport(document, "document_unavailable", localInputElapsedMs, "document_empty");
        continue;
      }
      local.set(document.id, { document, bytes, documentHash, localInputElapsedMs });
      progress[index]!.report = initialReport(document, "stopped_prepare_failure", localInputElapsedMs);
    } catch {
      progress[index]!.report = initialReport(document, "document_unavailable", safeElapsed(started, now()), "document_unavailable");
    }
  }

  const localDocuments = documents.flatMap((document) => {
    const loaded = local.get(document.id);
    return loaded ? [loaded] : [];
  });
  if (localDocuments.length !== documents.length) return campaignReport(progress, maxAutoResolveAttemptsPerModule);
  if (!uploadsAreAuthorized(localDocuments.map((entry) => entry.documentHash), input.allowedDocumentHashes)) {
    for (const entry of progress) {
      entry.report.status = "not_authorized";
      entry.report.code = "upload_authorization_required";
    }
    return campaignReport(progress, maxAutoResolveAttemptsPerModule);
  }

  for (const [index, document] of documents.entries()) {
    const loaded = local.get(document.id)!;
    const started = now();
    let response: Response;
    try {
      response = await input.transport(new Request(`http://internal.invalid/api/compiler/prepare?moduleId=${encodeURIComponent(document.moduleId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(loaded.bytes),
      }));
    } catch {
      progress[index]!.report = initialReport(document, "prepare_refused", loaded.localInputElapsedMs, "prepare_transport_failed");
      progress[index]!.report.timing.prepareElapsedMs = safeElapsed(started, now());
      continue;
    }
    const body = await responseJson(response);
    const elapsed = safeElapsed(started, now());
    if (!response.ok) {
      progress[index]!.report = initialReport(document, "prepare_refused", loaded.localInputElapsedMs, responseCode(body, `prepare_http_${response.status}`));
      progress[index]!.report.timing.prepareElapsedMs = elapsed;
      continue;
    }
    const prepared = parsedPrepared(loaded, body, elapsed);
    if (!prepared) {
      progress[index]!.report = initialReport(document, "prepare_refused", loaded.localInputElapsedMs, "prepare_response_invalid");
      progress[index]!.report.timing.prepareElapsedMs = elapsed;
      continue;
    }
    withPreparedReport(progress[index]!, prepared);
  }

  const prepared = progress.flatMap((entry) => entry.prepared ? [entry.prepared] : []);
  if (prepared.length !== documents.length) {
    for (const entry of progress) if (entry.prepared) entry.report.status = "stopped_prepare_failure";
    return campaignReport(progress, maxAutoResolveAttemptsPerModule);
  }
  if (!identitiesAreIsolated(prepared)) {
    for (const entry of progress) {
      entry.report.status = "identity_refused";
      entry.report.code = "prepared_identity_not_isolated";
    }
    return campaignReport(progress, maxAutoResolveAttemptsPerModule);
  }

  const continuationOwners = new Map<string, HttpCampaignDocument["id"]>();
  if (input.interleaveAutoResolveAttempts === true) {
    const pending = [...progress];
    while (pending.length > 0) {
      const entry = pending.shift()!;
      if (await advanceModule(entry, input.transport, now, maxAutoResolveAttemptsPerModule, continuationOwners, input.runAutoResolveAttempt)) {
        pending.push(entry);
      }
    }
  } else {
    for (const entry of progress) {
      while (await advanceModule(entry, input.transport, now, maxAutoResolveAttemptsPerModule, continuationOwners, input.runAutoResolveAttempt)) {
        // Legacy order deliberately completes this module before the next.
      }
    }
  }
  await consumePublishedPair(progress, input.consumePublished);
  return campaignReport(progress, maxAutoResolveAttemptsPerModule);
}

async function advanceModule(
  progress: ModuleProgress,
  transport: HttpCampaignTransport,
  now: () => number,
  maxAttempts: number,
  continuationOwners: Map<string, HttpCampaignDocument["id"]>,
  runAutoResolveAttempt: TwoModuleHttpCampaignInput["runAutoResolveAttempt"],
): Promise<boolean> {
  const prepared = progress.prepared!;
  if (progress.report.autoResolveAttempts >= maxAttempts) {
    progress.report.status = "attempt_budget_exhausted";
    progress.report.code = "auto_attempt_budget_exhausted";
    return false;
  }
  const body = progress.continuationId
    ? { preparedArtifactId: prepared.preparedArtifactId, preparedQueueHash: prepared.preparedQueueHash, autoContinuationId: progress.continuationId }
    : { preparedArtifactId: prepared.preparedArtifactId, preparedQueueHash: prepared.preparedQueueHash };
  const started = now();
  let response: Response;
  try {
    const dispatch = () => transport(new Request("http://internal.invalid/api/compiler/auto-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    response = runAutoResolveAttempt
      ? await runAutoResolveAttempt({ module: progress.report.module }, dispatch)
      : await dispatch();
  } catch {
    progress.report.timing.autoResolveElapsedMs += safeElapsed(started, now());
    progress.report.autoResolveAttempts++;
    progress.report.reportedProposalCalls = "unobservable";
    progress.report.status = "response_refused";
    progress.report.code = "auto_transport_failed";
    return false;
  }
  progress.report.autoResolveAttempts++;
  const raw = await responseJson(response);
  progress.report.timing.autoResolveElapsedMs += safeElapsed(started, now());
  progress.report.reportedProposalCalls = addReportedCalls(progress.report.reportedProposalCalls, reportedCalls(raw));
  if (!response.ok) {
    // A deadline/503 can still be draining a provider request. Its count is
    // deliberately unknown rather than reported as zero or safely complete.
    progress.report.reportedProposalCalls = "unobservable";
    progress.report.status = "response_refused";
    progress.report.code = responseCode(raw, `auto_http_${response.status}`);
    return false;
  }
  const parsed = parsedAutoResponse(raw, prepared);
  if (!parsed) {
    progress.report.status = "response_refused";
    progress.report.code = "auto_response_invalid";
    return false;
  }
  if (parsed.status === "resolved") {
    withPublishedReport(progress, parsed.publication);
    return false;
  }
  const nextContinuationId = parsed.continuationId;
  // A mechanically closed replay deliberately returns its existing token and
  // does not issue a new model call. It is valid only for the same module;
  // a foreign token is never allowed to cross the campaign's two scopes.
  if (parsed.status === "presentation_draft_only" && !parsed.progress) {
    if (!nextContinuationId || continuationOwners.get(nextContinuationId) !== progress.report.module) {
      progress.report.status = "response_refused";
      progress.report.code = "continuation_scope_invalid";
      return false;
    }
    progress.report.status = "mechanics_closed";
    return false;
  }
  // The current HTTP contract returns an old continuation on an unresolved
  // no-progress draft; consume neither it nor the transport again. This
  // prevents an infinite loop even when that round made a model request.
  if (!parsed.progress) {
    progress.report.status = "stopped_no_progress";
    return false;
  }
  if (!nextContinuationId || continuationOwners.has(nextContinuationId)) {
    progress.report.status = "response_refused";
    progress.report.code = "continuation_reused";
    return false;
  }
  continuationOwners.set(nextContinuationId, progress.report.module);
  if (parsed.status === "presentation_draft_only") {
    progress.report.status = "mechanics_closed";
    return false;
  }
  progress.continuationId = nextContinuationId;
  return true;
}

function campaignReport(progress: readonly ModuleProgress[], maxAutoResolveAttemptsPerModule: number): TwoModuleHttpCampaignReport {
  return {
    schemaVersion: "1.1.0",
    autoResolveAttemptBudget: { kind: "http_workflow_attempts_only", maxAutoResolveAttemptsPerModule },
    modules: progress.map((entry) => ({
      ...entry.report,
      timing: { ...entry.report.timing },
      ...(entry.report.identity ? { identity: { ...entry.report.identity } } : {}),
    })),
  };
}
