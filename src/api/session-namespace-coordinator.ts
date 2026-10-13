import { constants, Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { lstatSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * A root-wide, durable namespace for runtime session IDs.  It deliberately
 * stores only the fingerprint of the durable pointer a caller intends to
 * publish: snapshots, access bindings, and gameplay data stay outside it.
 */
// 1.1 adds the committed-current CAS.  An older writer must fail closed at
// policy initialization rather than treating a g1/g2 pointer as conflicting
// legacy evidence and quarantining a valid live session.
export const RUNTIME_SESSION_NAMESPACE_SCHEMA_VERSION = "1.1.0";
export const RUNTIME_SESSION_NAMESPACE_DOMAIN = "runtime-session-namespace";
/** Explicitly pins a namespace-required storage root to this writer epoch. */
export const RUNTIME_SESSION_NAMESPACE_ROOT_EPOCH = "runtime-session-required-1";
export const RUNTIME_SESSION_NAMESPACE_SQLITE_OPEN_FLAGS = constants.SQLITE_OPEN_READWRITE
  | constants.SQLITE_OPEN_CREATE
  | constants.SQLITE_OPEN_NOFOLLOW
  | constants.SQLITE_OPEN_FULLMUTEX
  | constants.SQLITE_OPEN_EXRESCODE;

export type RuntimeSessionKind = "ordinary" | "compiled";
export type RuntimeSessionNamespaceState = "reserved" | "prepared" | "committed" | "abandoned" | "quarantined";
export type SessionNamespaceFailureCode =
  | "SESSION_NAMESPACE_BUSY"
  | "SESSION_NAMESPACE_STORAGE_FAILED"
  | "SESSION_NAMESPACE_POLICY_MISMATCH"
  | "SESSION_NAMESPACE_CONFLICT"
  | "SESSION_NAMESPACE_FENCED"
  | "SESSION_NAMESPACE_LEASE_EXPIRED"
  | "SESSION_NAMESPACE_IDENTITY_MISMATCH";

export class SessionNamespaceFailure extends Error {
  constructor(readonly code: SessionNamespaceFailureCode, message: string) {
    super(message);
    this.name = "SessionNamespaceFailure";
  }
}

/** A durable pointer fingerprint; the coordinator never stores its contents. */
export interface DurableSessionIdentity {
  hash: string;
  generation: number;
  format: string;
}

/** A capability is returned only to the reserving process and is never readable from SQLite. */
export interface ReservationHandle {
  sessionId: string;
  kind: RuntimeSessionKind;
  token: string;
  fencingToken: number;
  leaseExpiresAtMs: number;
  /** Null until prepare freezes the to-be-published durable pointer. */
  expectedIdentity: DurableSessionIdentity | null;
}

export interface SessionNamespaceRecord {
  sessionId: string;
  kind: RuntimeSessionKind;
  state: RuntimeSessionNamespaceState;
  fencingToken: number;
  leaseExpiresAtMs: number | null;
  expectedIdentity: DurableSessionIdentity | null;
  createdAtMs: number;
  updatedAtMs: number;
  stateAtMs: number;
  reasonCode: string | null;
}

export interface ReserveSessionNamespaceInput {
  sessionId: string;
  kind: RuntimeSessionKind;
  /** Defaults to the coordinator lease. Kept small in tests via a clock seam. */
  leaseMs?: number;
}

export interface LeaseOperationInput {
  reservation: ReservationHandle;
  observedIdentity?: DurableSessionIdentity;
  expectedIdentity?: DurableSessionIdentity;
  leaseMs?: number;
  reasonCode?: string;
}

/** The subordinate store must synchronously classify its publish/readback. */
export type SessionNamespacePublicationObservation =
  | { status: "published"; observedIdentity: DurableSessionIdentity }
  /** Trusted subordinate classification only; never persisted or returned to a caller. */
  | { status: "not-published"; failureCode?: string }
  | { status: "indeterminate" };

export interface PublishPreparedSessionNamespaceInput {
  reservation: ReservationHandle;
  /**
   * Synchronous by contract. The coordinator holds BEGIN IMMEDIATE while this
   * runs, so subordinate publication must follow namespace -> store lock order.
   */
  publish: (permit: SessionNamespacePublicationPermit) => SessionNamespacePublicationObservation;
}

/**
 * Opaque, random, single-use store-publication capability.  The binding is
 * deliberately visible to the subordinate store so it can derive the same
 * expectation from its fully validated payload before its first write.  Only
 * `token` is a capability; the other fields are untrusted coordinates and
 * are checked again against coordinator-private issuance state on consume.
 */
export interface SessionNamespacePublicationPermit extends SessionNamespacePublicationPermitExpectation {
  token: string;
}
export interface SessionNamespacePublicationPermitExpectation {
  kind: RuntimeSessionKind;
  sessionId: string;
  fencingToken: number;
  previousIdentity: DurableSessionIdentity | null;
  nextIdentity: DurableSessionIdentity;
}
interface IssuedPermit extends SessionNamespacePublicationPermitExpectation { expiresAtMs: number; }

export type PublishPreparedSessionNamespaceResult =
  | { status: "committed"; record: SessionNamespaceRecord }
  | { status: "not-published"; reservation: ReservationHandle; failureCode?: string }
  | { status: "indeterminate"; reservation: ReservationHandle };

export interface SessionNamespaceListOptions {
  kind?: RuntimeSessionKind;
  state?: RuntimeSessionNamespaceState;
  afterSessionId?: string;
  limit?: number;
}

export interface SessionNamespaceList {
  records: SessionNamespaceRecord[];
  nextAfterSessionId: string | undefined;
}

export interface SessionNamespaceReconcileResult {
  expiredReservations: number;
}

interface ReconcileObservedSessionNamespaceBase {
  sessionId: string;
}

/** An ordinary durable observation always carries an explicit native predecessor field. */
export interface OrdinaryObservedSessionNamespaceInput extends ReconcileObservedSessionNamespaceBase {
  kind: "ordinary";
  observedIdentity: DurableSessionIdentity;
  /** `null` for g0; the exact 64-hex predecessor hash for gN (N > 0). */
  observedPredecessorHash: string | null;
  reasonCode?: never;
}

/** Compiled snapshots use their independent durable identity contract. */
export interface CompiledObservedSessionNamespaceInput extends ReconcileObservedSessionNamespaceBase {
  kind: "compiled";
  observedIdentity: DurableSessionIdentity;
  observedPredecessorHash?: never;
  reasonCode?: never;
}

/** A malformed/partial locator is reported as a bounded reason with no identity. */
export interface ReconcileObservedSessionNamespaceReasonInput extends ReconcileObservedSessionNamespaceBase {
  kind: RuntimeSessionKind;
  reasonCode: string;
  observedIdentity?: never;
  observedPredecessorHash?: never;
}

/**
 * Trusted startup repair input. A discriminated union keeps ordinary envelope
 * predecessor authority separate from compiled snapshots and reason-only
 * evidence before either reaches the coordinator transaction.
 */
export type ReconcileObservedSessionNamespaceInput =
  | OrdinaryObservedSessionNamespaceInput
  | CompiledObservedSessionNamespaceInput
  | ReconcileObservedSessionNamespaceReasonInput;

/** Startup-only legacy adoption has no predecessor field and cannot advance an existing ordinary pointer. */
export interface LegacyAdoptCommittedSessionNamespaceInput extends ReconcileObservedSessionNamespaceBase {
  kind: RuntimeSessionKind;
  observedIdentity: DurableSessionIdentity;
}

/** Factory for an ordinary g0 observation; runtime validation confirms generation zero. */
export function ordinaryGenerationZeroReconciliation(
  sessionId: string,
  observedIdentity: DurableSessionIdentity,
): OrdinaryObservedSessionNamespaceInput {
  return { sessionId, kind: "ordinary", observedIdentity, observedPredecessorHash: null };
}

/** Factory for an ordinary gN observation; runtime validation confirms gN and the hash shape. */
export function ordinarySuccessorReconciliation(
  sessionId: string,
  observedIdentity: DurableSessionIdentity,
  observedPredecessorHash: string,
): OrdinaryObservedSessionNamespaceInput {
  return { sessionId, kind: "ordinary", observedIdentity, observedPredecessorHash };
}

export function compiledIdentityReconciliation(
  sessionId: string,
  observedIdentity: DurableSessionIdentity,
): CompiledObservedSessionNamespaceInput {
  return { sessionId, kind: "compiled", observedIdentity };
}

export function reconciliationReason(
  sessionId: string,
  kind: RuntimeSessionKind,
  reasonCode: string,
): ReconcileObservedSessionNamespaceReasonInput {
  return { sessionId, kind, reasonCode };
}

/**
 * A post-g0 durable store publication must advance the coordinator's current
 * pointer atomically from the exact predecessor it read.  This is deliberately
 * not a reservation: committed IDs remain permanently owned by their kind.
 */
export interface AdvanceCommittedSessionNamespaceInput {
  sessionId: string;
  kind: RuntimeSessionKind;
  previousIdentity: DurableSessionIdentity;
  observedIdentity: DurableSessionIdentity;
}

export interface PublishCommittedSessionNamespaceInput {
  kind: RuntimeSessionKind;
  sessionId: string;
  previousIdentity: DurableSessionIdentity;
  nextIdentity: DurableSessionIdentity;
  publish: (permit: SessionNamespacePublicationPermit) => SessionNamespacePublicationObservation;
}

export interface SessionNamespacePathOps {
  kind(path: string): "missing" | "regular" | "unsafe";
  rootKind(path: string): "missing" | "directory" | "unsafe";
  createRoot(path: string): void;
}

export interface SessionNamespaceCoordinatorOptions {
  /** Persistent policy identity. A different process/domain fails closed. */
  domain?: string;
  schemaVersion?: string;
  /**
   * A durable root must be opened only by writers from the same epoch. This
   * stops an old binary from sharing a writable root after an upgrade.
   */
  rootEpoch?: string;
  /**
   * Explicit startup-only migration switch for a same-domain 1.0 root. The
   * caller must already hold its deployment-wide startup exclusivity; normal
   * request-path coordinators deliberately leave this false.
   */
  allowLegacyMigration?: boolean;
  fileName?: string;
  defaultLeaseMs?: number;
  now?: () => number;
  pathOps?: SessionNamespacePathOps;
  connectionFactory?: (file: string, flags: number) => Database;
}

interface StoredPolicy {
  schema_version: string;
  coordinator_domain: string;
  root_epoch: string;
}

interface StoredNamespaceRow {
  session_id: string;
  kind: RuntimeSessionKind;
  state: RuntimeSessionNamespaceState;
  reservation_token_hash: string | null;
  fencing_token: number;
  lease_expires_at_ms: number | null;
  expected_hash: string | null;
  expected_generation: number | null;
  expected_format: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  state_at_ms: number;
  reason_code: string | null;
}

type TransactionOutcome<T> = { value: T } | { failure: SessionNamespaceFailure };

const ACTIVE_STATES = new Set<RuntimeSessionNamespaceState>(["reserved", "prepared"]);
const TERMINAL_STATES = new Set<RuntimeSessionNamespaceState>(["committed", "abandoned", "quarantined"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FORMAT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{2,127}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface NormalizedReconcileObservedSessionNamespaceInput {
  sessionId: string;
  kind: RuntimeSessionKind;
  observedIdentity?: DurableSessionIdentity;
  observedPredecessorHash?: string | null;
  reasonCode?: string;
}

function invalidReconcileObservedInput(): never {
  throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "startup reconciliation input must be a closed own-data record");
}

/**
 * Startup inventory is an API boundary, not a convention between callers.
 * Copy only own data properties from an ordinary object before touching their
 * values so a missing binding, inherited value, or accessor cannot create a
 * successor proof. The resulting copy also prevents post-validation mutation.
 */
function closedOwnDataRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  let names: string[];
  let symbols: symbol[];
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return invalidReconcileObservedInput();
    }
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalidReconcileObservedInput();
  }
  if (symbols.length !== 0 || names.some((name) => !allowed.includes(name))) return invalidReconcileObservedInput();
  const copy: Record<string, unknown> = {};
  for (const name of names) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, name); } catch { return invalidReconcileObservedInput(); }
    if (!descriptor || !("value" in descriptor)) return invalidReconcileObservedInput();
    copy[name] = descriptor.value;
  }
  return copy;
}

function closedIdentity(value: unknown): DurableSessionIdentity {
  const record = closedOwnDataRecord(value, ["hash", "generation", "format"]);
  if (!("hash" in record) || !("generation" in record) || !("format" in record)) return invalidReconcileObservedInput();
  return { hash: record.hash as string, generation: record.generation as number, format: record.format as string };
}

function normalizeReconcileObservedInput(
  raw: unknown,
  legacyOrdinaryAdoption: boolean,
): NormalizedReconcileObservedSessionNamespaceInput {
  const record = closedOwnDataRecord(raw, ["sessionId", "kind", "observedIdentity", "observedPredecessorHash", "reasonCode"]);
  if (!("sessionId" in record) || !("kind" in record)) return invalidReconcileObservedInput();
  const hasIdentity = "observedIdentity" in record;
  const hasReason = "reasonCode" in record;
  const hasPredecessor = "observedPredecessorHash" in record;
  if (hasIdentity === hasReason) {
    throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "startup reconciliation requires exactly one durable identity or conflict reason");
  }
  const observedIdentity = hasIdentity ? closedIdentity(record.observedIdentity) : undefined;
  const reasonCode = hasReason ? record.reasonCode : undefined;
  if (typeof record.sessionId !== "string" || (record.kind !== "ordinary" && record.kind !== "compiled")) {
    return invalidReconcileObservedInput();
  }
  if (hasReason && typeof reasonCode !== "string") return invalidReconcileObservedInput();
  if (hasPredecessor && !hasIdentity) {
    throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "startup predecessor binding requires an observed durable identity");
  }
  if (record.kind === "ordinary" && hasIdentity && !legacyOrdinaryAdoption) {
    if (!hasPredecessor) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "ordinary startup observation requires an explicit predecessor binding");
    }
    if (observedIdentity!.generation === 0) {
      if (record.observedPredecessorHash !== null) {
        throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "ordinary generation-zero startup observation requires a null predecessor binding");
      }
    } else if (typeof record.observedPredecessorHash !== "string" || !HASH_PATTERN.test(record.observedPredecessorHash)) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "ordinary startup predecessor binding is invalid");
    }
  } else if (hasPredecessor) {
    // Compiled snapshots and reason-only reports deliberately have no
    // ordinary envelope predecessor field. Legacy adoption is not a route to
    // advance an existing ordinary namespace record.
    throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "startup predecessor binding is not valid for this reconciliation input");
  }
  return {
    sessionId: record.sessionId,
    kind: record.kind,
    ...(observedIdentity ? { observedIdentity } : {}),
    ...(hasPredecessor ? { observedPredecessorHash: record.observedPredecessorHash as string | null } : {}),
    ...(hasReason ? { reasonCode: reasonCode as string } : {}),
  };
}

const nodePathOps: SessionNamespacePathOps = {
  kind(path) {
    try {
      const stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink() ? "regular" : "unsafe";
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "missing";
      throw error;
    }
  },
  rootKind(path) {
    try {
      const stat = lstatSync(path);
      return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe";
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "missing";
      throw error;
    }
  },
  createRoot(path) { mkdirSync(path, { recursive: true }); },
};

function databaseConnectionFactory(file: string, flags: number): Database {
  return new Database(file, flags);
}

function failureFrom(error: unknown): SessionNamespaceFailure {
  if (error instanceof SessionNamespaceFailure) return error;
  const record = error as { code?: string } | undefined;
  const message = error instanceof Error ? error.message : "runtime session namespace SQLite operation failed";
  if (/no such column|has no column|no such table|malformed database schema/i.test(message)) {
    return new SessionNamespaceFailure("SESSION_NAMESPACE_POLICY_MISMATCH", "session namespace SQLite schema is incompatible with the configured policy");
  }
  if (record?.code === "SQLITE_BUSY" || record?.code === "SQLITE_LOCKED" || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(message)) {
    return new SessionNamespaceFailure("SESSION_NAMESPACE_BUSY", "runtime session namespace is busy");
  }
  return new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", message);
}

function sameIdentity(left: DurableSessionIdentity, right: DurableSessionIdentity): boolean {
  return left.hash === right.hash && left.generation === right.generation && left.format === right.format;
}

function sameOptionalIdentity(left: DurableSessionIdentity | null, right: DurableSessionIdentity | null): boolean {
  return left === null || right === null ? left === right : sameIdentity(left, right);
}

function isThenable(value: unknown): boolean {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}

function isPublicationObservation(value: unknown): value is SessionNamespacePublicationObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.status === "indeterminate") return Object.keys(record).length === 1;
  if (record.status === "not-published") {
    const keys = Object.keys(record);
    return (keys.length === 1 || (keys.length === 2 && typeof record.failureCode === "string" && record.failureCode.length >= 2 && record.failureCode.length <= 128));
  }
  return record.status === "published" && Object.keys(record).length === 2 && !!record.observedIdentity;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameFingerprint(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Every mutation starts with BEGIN IMMEDIATE on a SQLite file shared by the
 * ordinary and compiled writers. Tombstones are permanent: expiry can reclaim
 * an active lease only by abandoning it, never by issuing the ID again.
 */
export class SessionNamespaceCoordinator {
  readonly root: string;
  readonly file: string;
  private readonly domain: string;
  private readonly schemaVersion: string;
  private readonly rootEpoch: string;
  private readonly allowLegacyMigration: boolean;
  private readonly defaultLeaseMs: number;
  private readonly now: () => number;
  private readonly pathOps: SessionNamespacePathOps;
  private readonly connectionFactory: (file: string, flags: number) => Database;
  private readonly permits = new Map<string, IssuedPermit>();

  constructor(root: string, options: SessionNamespaceCoordinatorOptions = {}) {
    this.domain = options.domain ?? RUNTIME_SESSION_NAMESPACE_DOMAIN;
    this.schemaVersion = options.schemaVersion ?? RUNTIME_SESSION_NAMESPACE_SCHEMA_VERSION;
    this.rootEpoch = options.rootEpoch ?? RUNTIME_SESSION_NAMESPACE_ROOT_EPOCH;
    this.allowLegacyMigration = options.allowLegacyMigration === true;
    this.defaultLeaseMs = options.defaultLeaseMs ?? 30_000;
    if (!DOMAIN_PATTERN.test(this.domain) || !FORMAT_PATTERN.test(this.schemaVersion) || !FORMAT_PATTERN.test(this.rootEpoch)) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace domain or schema version is invalid");
    }
    this.assertLeaseMs(this.defaultLeaseMs);
    const fileName = options.fileName ?? ".runtime-session-namespace.sqlite";
    if (!/^\.[A-Za-z0-9_-]{1,128}\.sqlite$/.test(fileName)) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace SQLite filename is invalid");
    }
    this.root = root;
    this.file = join(root, fileName);
    this.now = options.now ?? Date.now;
    this.pathOps = options.pathOps ?? nodePathOps;
    this.connectionFactory = options.connectionFactory ?? databaseConnectionFactory;
  }

  /** Establish (or verify) the root policy without reserving an ID. */
  initialize(): void {
    this.transaction(() => undefined);
  }

  reserve(input: ReserveSessionNamespaceInput): ReservationHandle {
    this.assertSessionId(input.sessionId);
    this.assertKind(input.kind);
    const leaseMs = input.leaseMs ?? this.defaultLeaseMs;
    this.assertLeaseMs(leaseMs);
    const now = this.clock();
    const token = randomBytes(32).toString("base64url");
    const outcome = this.transaction<TransactionOutcome<ReservationHandle>>((database) => {
      const existing = this.find(database, input.sessionId);
      if (existing) {
        if (this.expired(existing, now)) this.transitionTerminal(database, existing, "abandoned", "LEASE_EXPIRED", now);
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_CONFLICT", "a runtime session ID is permanently owned or tombstoned") };
      }
      const expires = this.addLease(now, leaseMs);
      database.run(
        `INSERT INTO session_namespace_entries (
          session_id, kind, state, reservation_token_hash, fencing_token, lease_expires_at_ms,
          expected_hash, expected_generation, expected_format, created_at_ms, updated_at_ms, state_at_ms, reason_code
        ) VALUES (?, ?, 'reserved', ?, 1, ?, NULL, NULL, NULL, ?, ?, ?, NULL)`,
        [input.sessionId, input.kind, tokenFingerprint(token), expires, now, now, now],
      );
      return {
        value: {
          sessionId: input.sessionId,
          kind: input.kind,
          token,
          fencingToken: 1,
          leaseExpiresAtMs: expires,
          expectedIdentity: null,
        },
      };
    });
    return this.unwrap(outcome);
  }

  /** Refreshes the lease and advances the fence; all earlier handles are stale. */
  renew(input: LeaseOperationInput): ReservationHandle {
    this.assertHandle(input.reservation);
    const leaseMs = input.leaseMs ?? this.defaultLeaseMs;
    this.assertLeaseMs(leaseMs);
    const now = this.clock();
    const replacementToken = randomBytes(32).toString("base64url");
    const outcome = this.transaction<TransactionOutcome<ReservationHandle>>((database) => {
      const row = this.requireRow(database, input.reservation.sessionId);
      const failure = this.activeOwnerFailure(database, row, input.reservation, now);
      if (failure) return { failure };
      const expires = this.addLease(now, leaseMs);
      const nextFence = row.fencing_token + 1;
      database.run(
        "UPDATE session_namespace_entries SET reservation_token_hash = ?, fencing_token = ?, lease_expires_at_ms = ?, updated_at_ms = ? WHERE session_id = ?",
        [tokenFingerprint(replacementToken), nextFence, expires, now, row.session_id],
      );
      return {
        value: this.handle(
          { ...row, reservation_token_hash: tokenFingerprint(replacementToken), fencing_token: nextFence, lease_expires_at_ms: expires, updated_at_ms: now },
          replacementToken,
        ),
      };
    });
    return this.unwrap(outcome);
  }

  /**
   * After staging creates g0, freeze its expected durable pointer before the
   * snapshot store is entered. No pointer is observed at this point.
   */
  prepare(input: Required<Pick<LeaseOperationInput, "reservation" | "expectedIdentity">>): ReservationHandle {
    this.assertHandle(input.reservation);
    this.assertIdentity(input.expectedIdentity);
    const now = this.clock();
    const replacementToken = randomBytes(32).toString("base64url");
    const outcome = this.transaction<TransactionOutcome<ReservationHandle>>((database) => {
      const row = this.requireRow(database, input.reservation.sessionId);
      const failure = this.activeOwnerFailure(database, row, input.reservation, now);
      if (failure) return { failure };
      const expected = this.identity(row);
      if (row.state === "prepared") {
        if (expected && sameIdentity(expected, input.expectedIdentity)) return { value: this.handle(row, input.reservation.token) };
        this.transitionTerminal(database, row, "quarantined", "PREPARED_IDENTITY_MISMATCH", now);
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_IDENTITY_MISMATCH", "a prepared reservation cannot change its durable identity") };
      }
      if (expected !== null) {
        throw new SessionNamespaceFailure("SESSION_NAMESPACE_POLICY_MISMATCH", "reserved namespace entry unexpectedly has a durable identity");
      }
      const nextFence = row.fencing_token + 1;
      database.run(
        "UPDATE session_namespace_entries SET state = 'prepared', reservation_token_hash = ?, fencing_token = ?, expected_hash = ?, expected_generation = ?, expected_format = ?, updated_at_ms = ?, state_at_ms = ? WHERE session_id = ?",
        [tokenFingerprint(replacementToken), nextFence, input.expectedIdentity.hash, input.expectedIdentity.generation, input.expectedIdentity.format, now, now, row.session_id],
      );
      return {
        value: this.handle(
          { ...row, state: "prepared", reservation_token_hash: tokenFingerprint(replacementToken), fencing_token: nextFence, expected_hash: input.expectedIdentity.hash, expected_generation: input.expectedIdentity.generation, expected_format: input.expectedIdentity.format, updated_at_ms: now, state_at_ms: now },
          replacementToken,
        ),
      };
    });
    return this.unwrap(outcome);
  }

  /** Commit only a prepared reservation whose caller still observes its exact durable pointer. */
  commit(input: Required<Pick<LeaseOperationInput, "reservation" | "observedIdentity">>): SessionNamespaceRecord {
    this.assertHandle(input.reservation);
    this.assertIdentity(input.observedIdentity);
    const now = this.clock();
    const outcome = this.transaction<TransactionOutcome<SessionNamespaceRecord>>((database) => {
      const row = this.requireRow(database, input.reservation.sessionId);
      const failure = this.activeOwnerFailure(database, row, input.reservation, now);
      if (failure) return { failure };
      if (row.state !== "prepared") {
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_CONFLICT", "only a prepared runtime session reservation may commit") };
      }
      const expected = this.identity(row);
      if (!expected) {
        throw new SessionNamespaceFailure("SESSION_NAMESPACE_POLICY_MISMATCH", "prepared namespace entry has no durable identity");
      }
      if (!sameIdentity(expected, input.observedIdentity)) {
        this.transitionTerminal(database, row, "quarantined", "DURABLE_IDENTITY_MISMATCH", now);
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_IDENTITY_MISMATCH", "observed durable identity differs from the prepared reservation") };
      }
      const terminal = this.terminalRecord(database, row, "committed", null, now);
      return { value: this.record(terminal) };
    });
    return this.unwrap(outcome);
  }

  /**
   * The publication fence. It validates the exact prepared capability and
   * retains the namespace BEGIN IMMEDIATE lock while the caller publishes to
   * (and reads back from) its subordinate snapshot store. A synchronous
   * callback is intentional: an async callback could escape the lock and
   * violate the required namespace -> store lock order.
   *
   * `not-published` and `indeterminate` retain the prepared row. The latter
   * is deliberately recoverable by reconcileObserved only when startup reads
   * the exact prepared identity; this covers a durable store success followed
   * by a process/SQLite commit/response uncertainty.
   */
  publishPrepared(input: PublishPreparedSessionNamespaceInput): PublishPreparedSessionNamespaceResult {
    this.assertHandle(input.reservation);
    if (typeof input.publish !== "function") {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "prepared publication callback must be a function");
    }
    const now = this.clock();
    const outcome = this.transaction<TransactionOutcome<PublishPreparedSessionNamespaceResult>>((database) => {
      const row = this.requireRow(database, input.reservation.sessionId);
      const failure = this.activeOwnerFailure(database, row, input.reservation, now);
      if (failure) return { failure };
      if (row.state !== "prepared") {
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_CONFLICT", "only a prepared runtime session reservation may publish") };
      }
      const expected = this.identity(row);
      if (!expected) {
        throw new SessionNamespaceFailure("SESSION_NAMESPACE_POLICY_MISMATCH", "prepared namespace entry has no durable identity");
      }
      // activeOwnerFailure checks this too, but spell it out at the fence so a
      // future refactor cannot accidentally permit a handle for another g0.
      if (!sameOptionalIdentity(expected, input.reservation.expectedIdentity)) {
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_FENCED", "prepared publication handle has a different durable identity") };
      }

      let observation: unknown;
      let permit: SessionNamespacePublicationPermit | undefined;
      try {
        permit = this.issuePermit({ kind: row.kind, sessionId: row.session_id, fencingToken: row.fencing_token, previousIdentity: null, nextIdentity: expected }, now);
        observation = input.publish(permit);
      } catch {
        return { value: { status: "indeterminate", reservation: this.handle(row, input.reservation.token) } };
      } finally {
        // A store must consume synchronously while the namespace transaction
        // is still held.  Leaving an unused permit live would turn an
        // accidentally deferred callback into a later out-of-fence write.
        if (permit) this.permits.delete(permit.token);
      }
      if (isThenable(observation)) {
        this.transitionTerminal(database, row, "quarantined", "ASYNC_PUBLICATION_CALLBACK", now);
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "prepared publication callback returned a promise") };
      }
      if (!isPublicationObservation(observation)) {
        this.transitionTerminal(database, row, "quarantined", "INVALID_PUBLICATION_OBSERVATION", now);
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "prepared publication callback returned an invalid observation") };
      }
      if (observation.status === "not-published") {
        return { value: { status: "not-published", reservation: this.handle(row, input.reservation.token), ...(observation.failureCode ? { failureCode: observation.failureCode } : {}) } };
      }
      if (observation.status === "indeterminate") {
        return { value: { status: "indeterminate", reservation: this.handle(row, input.reservation.token) } };
      }
      this.assertIdentity(observation.observedIdentity);
      if (!sameIdentity(expected, observation.observedIdentity)) {
        this.transitionTerminal(database, row, "quarantined", "DURABLE_IDENTITY_MISMATCH", now);
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_IDENTITY_MISMATCH", "subordinate store readback differs from prepared durable identity") };
      }
      return { value: { status: "committed", record: this.record(this.terminalRecord(database, row, "committed", null, now)) } };
    });
    return this.unwrap(outcome);
  }

  /**
   * Store-side verifier injection. It consumes a random capability exactly
   * once and checks every durable pointer coordinate; a forged/replayed token
   * has no entry in this coordinator instance.
   */
  consumePublicationPermit(permit: SessionNamespacePublicationPermit, expected: SessionNamespacePublicationPermitExpectation): void {
    if (!permit || typeof permit.token !== "string" || !TOKEN_PATTERN.test(permit.token)) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_FENCED", "session namespace publication permit is invalid");
    }
    const issued = this.permits.get(permit.token);
    this.permits.delete(permit.token);
    if (!issued || issued.expiresAtMs < this.clock()
      || issued.kind !== expected.kind || issued.sessionId !== expected.sessionId || issued.fencingToken !== expected.fencingToken
      || !sameOptionalIdentity(issued.previousIdentity, expected.previousIdentity) || !sameIdentity(issued.nextIdentity, expected.nextIdentity)) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_FENCED", "session namespace publication permit is stale, replayed, or bound to another durable identity");
    }
  }

  /** Publish a gN+1 store CAS/readback under the current namespace lock. */
  publishCommitted(input: PublishCommittedSessionNamespaceInput): SessionNamespaceRecord | { status: "indeterminate" } | { status: "not-published"; failureCode?: string } {
    this.assertKind(input.kind); this.assertSessionId(input.sessionId); this.assertIdentity(input.previousIdentity); this.assertIdentity(input.nextIdentity);
    if (input.nextIdentity.format !== input.previousIdentity.format || input.nextIdentity.generation !== input.previousIdentity.generation + 1) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_IDENTITY_MISMATCH", "committed publication must advance exactly one generation");
    }
    const now = this.clock();
    return this.transaction((database) => {
      const row = this.requireRow(database, input.sessionId);
      const current = this.identity(row);
      if (row.state !== "committed" || row.kind !== input.kind) throw new SessionNamespaceFailure("SESSION_NAMESPACE_CONFLICT", "namespace current kind is not publishable");
      if (current && sameIdentity(current, input.nextIdentity)) return this.record(row);
      if (!current || !sameIdentity(current, input.previousIdentity)) throw new SessionNamespaceFailure("SESSION_NAMESPACE_IDENTITY_MISMATCH", "namespace current identity is stale");
      let observed: unknown;
      let permit: SessionNamespacePublicationPermit | undefined;
      try {
        permit = this.issuePermit({ kind: row.kind, sessionId: row.session_id, fencingToken: row.fencing_token, previousIdentity: current, nextIdentity: input.nextIdentity }, now);
        observed = input.publish(permit);
      } catch { return { status: "indeterminate" as const }; }
      finally {
        if (permit) this.permits.delete(permit.token);
      }
      if (isThenable(observed) || !isPublicationObservation(observed) || observed.status === "indeterminate") return { status: "indeterminate" as const };
      if (observed.status === "not-published") return { status: "not-published" as const, ...(observed.failureCode ? { failureCode: observed.failureCode } : {}) };
      if (!sameIdentity(observed.observedIdentity, input.nextIdentity)) throw new SessionNamespaceFailure("SESSION_NAMESPACE_IDENTITY_MISMATCH", "subordinate successor readback mismatches namespace next identity");
      const nextFence = row.fencing_token + 1;
      database.run("UPDATE session_namespace_entries SET fencing_token = ?, expected_hash = ?, expected_generation = ?, expected_format = ?, updated_at_ms = ?, state_at_ms = ? WHERE session_id = ?", [nextFence, input.nextIdentity.hash, input.nextIdentity.generation, input.nextIdentity.format, now, now, row.session_id]);
      return this.record({ ...row, fencing_token: nextFence, expected_hash: input.nextIdentity.hash, expected_generation: input.nextIdentity.generation, expected_format: input.nextIdentity.format, updated_at_ms: now, state_at_ms: now });
    });
  }

  /** Owner-only permanent abandonment. This never deletes or frees a namespace row. */
  abandon(input: Required<Pick<LeaseOperationInput, "reservation">> & Pick<LeaseOperationInput, "reasonCode">): SessionNamespaceRecord {
    return this.finishActive(input.reservation, "abandoned", input.reasonCode ?? "OWNER_ABANDONED");
  }

  /** Alias for the owner-only abandonment protocol; release cannot reuse an ID. */
  release(input: Required<Pick<LeaseOperationInput, "reservation">> & Pick<LeaseOperationInput, "reasonCode">): SessionNamespaceRecord {
    return this.finishActive(input.reservation, "abandoned", input.reasonCode ?? "OWNER_RELEASED");
  }

  /** Owner-only quarantine for an externally detected durability violation. */
  quarantine(input: Required<Pick<LeaseOperationInput, "reservation" | "reasonCode">>): SessionNamespaceRecord {
    return this.finishActive(input.reservation, "quarantined", input.reasonCode);
  }

  /** Adopt exactly one valid legacy durable pointer as committed during startup. */
  adoptCommitted(input: LegacyAdoptCommittedSessionNamespaceInput): SessionNamespaceRecord {
    return this.reconcileObservedNormalized(normalizeReconcileObservedInput(input, true), true);
  }

  /**
   * Move a committed namespace pointer from gN to exactly gN+1 after the
   * subordinate store has completed its own CAS/readback.  It is idempotent
   * for a lost acknowledgement of the same successor, but a stale writer can
   * neither regress current identity nor quarantine the winning generation.
   */
  advanceCommitted(input: AdvanceCommittedSessionNamespaceInput): SessionNamespaceRecord {
    this.assertSessionId(input.sessionId);
    this.assertKind(input.kind);
    this.assertIdentity(input.previousIdentity);
    this.assertIdentity(input.observedIdentity);
    if (input.observedIdentity.format !== input.previousIdentity.format
      || input.observedIdentity.generation !== input.previousIdentity.generation + 1) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_IDENTITY_MISMATCH", "committed namespace successor must be the next generation of the exact current format");
    }
    const now = this.clock();
    const outcome = this.transaction<TransactionOutcome<SessionNamespaceRecord>>((database) => {
      const row = this.requireRow(database, input.sessionId);
      if (row.kind !== input.kind || row.state !== "committed") {
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_CONFLICT", "only the committed runtime kind may advance its current identity") };
      }
      const current = this.identity(row);
      if (!current) throw new SessionNamespaceFailure("SESSION_NAMESPACE_POLICY_MISMATCH", "committed namespace entry has no current identity");
      if (sameIdentity(current, input.observedIdentity)) return { value: this.record(row) };
      if (!sameIdentity(current, input.previousIdentity)) {
        return { failure: new SessionNamespaceFailure("SESSION_NAMESPACE_IDENTITY_MISMATCH", "durable successor predecessor is not the namespace current identity") };
      }
      const nextFence = row.fencing_token + 1;
      database.run(
        `UPDATE session_namespace_entries
         SET fencing_token = ?, expected_hash = ?, expected_generation = ?, expected_format = ?,
             updated_at_ms = ?, state_at_ms = ?, reason_code = NULL
         WHERE session_id = ? AND state = 'committed' AND kind = ?
           AND expected_hash = ? AND expected_generation = ? AND expected_format = ?`,
        [nextFence, input.observedIdentity.hash, input.observedIdentity.generation, input.observedIdentity.format,
          now, now, input.sessionId, input.kind,
          input.previousIdentity.hash, input.previousIdentity.generation, input.previousIdentity.format],
      );
      return {
        value: this.record({
          ...row,
          fencing_token: nextFence,
          expected_hash: input.observedIdentity.hash,
          expected_generation: input.observedIdentity.generation,
          expected_format: input.observedIdentity.format,
          updated_at_ms: now,
          state_at_ms: now,
          reason_code: null,
        }),
      };
    });
    return this.unwrap(outcome);
  }

  /**
   * Atomically adjudicate a startup observation. An absent namespace may be
   * adopted as committed (one valid pointer) or quarantined (conflict/corrupt
 * observation). An existing committed entry is idempotent for the exact
 * pointer, and may recover exactly one same-kind successor after a store CAS
 * succeeded but the namespace acknowledgement was lost.  A jump, rewrite, or
 * cross-kind observation remains a permanent quarantine.
   */
  reconcileObserved(input: ReconcileObservedSessionNamespaceInput): SessionNamespaceRecord {
    return this.reconcileObservedNormalized(normalizeReconcileObservedInput(input, false), false);
  }

  private reconcileObservedNormalized(
    input: NormalizedReconcileObservedSessionNamespaceInput,
    legacyOrdinaryAdoption: boolean,
  ): SessionNamespaceRecord {
    this.assertSessionId(input.sessionId);
    this.assertKind(input.kind);
    const hasIdentity = input.observedIdentity !== undefined;
    const hasReason = input.reasonCode !== undefined;
    if (hasIdentity === hasReason) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "startup reconciliation requires exactly one durable identity or conflict reason");
    }
    if (hasIdentity) this.assertIdentity(input.observedIdentity!);
    if (hasReason) this.assertReason(input.reasonCode!);
    const now = this.clock();
    const outcome = this.transaction<TransactionOutcome<SessionNamespaceRecord>>((database) => {
      const row = this.find(database, input.sessionId);
      if (!row) {
        if (hasIdentity) return { value: this.record(this.insertTerminal(database, input.sessionId, input.kind, "committed", input.observedIdentity!, null, now)) };
        return { value: this.record(this.insertTerminal(database, input.sessionId, input.kind, "quarantined", null, input.reasonCode!, now)) };
      }
      if (row.state === "committed") {
        const expected = this.identity(row);
        if (hasIdentity && row.kind === input.kind && expected && sameIdentity(expected, input.observedIdentity!)) {
          return { value: this.record(row) };
        }
        if (hasIdentity && row.kind === input.kind && expected
          && expected.format === input.observedIdentity!.format
          && input.observedIdentity!.generation === expected.generation + 1) {
          // Keep the predecessor proof in this same BEGIN IMMEDIATE
          // transaction. A caller-side read followed by reconcileObserved
          // would be a TOCTOU gap if another owner advanced the namespace
          // between those operations.
          if (input.kind === "ordinary" && legacyOrdinaryAdoption) {
            return { value: this.record(this.terminalRecord(database, row, "quarantined", "OBSERVED_COMMITTED_CONFLICT", now)) };
          }
          if (input.kind === "ordinary" && input.observedPredecessorHash !== expected.hash) {
            return { value: this.record(this.terminalRecord(database, row, "quarantined", "OBSERVED_PREDECESSOR_MISMATCH", now)) };
          }
          const next = input.observedIdentity!;
          const nextFence = row.fencing_token + 1;
          database.run(
            `UPDATE session_namespace_entries
             SET fencing_token = ?, expected_hash = ?, expected_generation = ?, expected_format = ?,
                 updated_at_ms = ?, state_at_ms = ?, reason_code = NULL
             WHERE session_id = ? AND state = 'committed' AND kind = ?
               AND expected_hash = ? AND expected_generation = ? AND expected_format = ?`,
            [nextFence, next.hash, next.generation, next.format, now, now,
              row.session_id, row.kind, expected.hash, expected.generation, expected.format],
          );
          return { value: this.record({ ...row, fencing_token: nextFence, expected_hash: next.hash, expected_generation: next.generation, expected_format: next.format, updated_at_ms: now, state_at_ms: now, reason_code: null }) };
        }
        return { value: this.record(this.terminalRecord(database, row, "quarantined", input.reasonCode ?? "OBSERVED_COMMITTED_CONFLICT", now)) };
      }
      if (row.state === "prepared") {
        const expected = this.identity(row);
        if (hasIdentity && row.kind === input.kind && expected && sameIdentity(expected, input.observedIdentity!)) {
          return { value: this.record(this.terminalRecord(database, row, "committed", null, now)) };
        }
        return { value: this.record(this.terminalRecord(database, row, "quarantined", input.reasonCode ?? "OBSERVED_PREPARED_CONFLICT", now)) };
      }
      if (row.state === "quarantined" && hasReason && row.kind === input.kind && row.reason_code === input.reasonCode) {
        return { value: this.record(row) };
      }
      // Preserve the original kind and expected fingerprint if any. A startup
      // observation is allowed to make a non-committed row safer, never to
      // make it reusable or reinterpret it as the other runtime kind.
      const reason = input.reasonCode ?? "OBSERVED_IDENTITY_MISMATCH";
      return { value: this.record(this.terminalRecord(database, row, "quarantined", reason, now)) };
    });
    return this.unwrap(outcome);
  }

  read(sessionId: string): SessionNamespaceRecord | undefined {
    this.assertSessionId(sessionId);
    return this.transaction((database) => {
      const row = this.find(database, sessionId);
      return row ? this.record(row) : undefined;
    });
  }

  list(options: SessionNamespaceListOptions = {}): SessionNamespaceList {
    if (options.kind !== undefined) this.assertKind(options.kind);
    if (options.state !== undefined) this.assertState(options.state);
    if (options.afterSessionId !== undefined) this.assertSessionId(options.afterSessionId);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace list limit must be between 1 and 1000");
    }
    return this.transaction((database) => {
      const clauses = ["session_id > ?"];
      const bindings: Array<string | number> = [options.afterSessionId ?? ""];
      if (options.kind) { clauses.push("kind = ?"); bindings.push(options.kind); }
      if (options.state) { clauses.push("state = ?"); bindings.push(options.state); }
      bindings.push(limit + 1);
      const rows = database.query<StoredNamespaceRow, Array<string | number>>(
        `SELECT session_id, kind, state, reservation_token_hash, fencing_token, lease_expires_at_ms,
          expected_hash, expected_generation, expected_format, created_at_ms, updated_at_ms, state_at_ms, reason_code
         FROM session_namespace_entries WHERE ${clauses.join(" AND ")} ORDER BY session_id ASC LIMIT ?`,
      ).all(...bindings);
      const page = rows.slice(0, limit).map((row) => this.record(row));
      return { records: page, nextAfterSessionId: rows.length > limit ? page.at(-1)?.sessionId : undefined };
    });
  }

  /**
   * Convert only expired pre-publication reservations to tombstones. Prepared
   * entries may already have published their exact pointer when a process
   * dies; reconcileObserved must get the chance to recover that evidence.
   */
  reconcile(): SessionNamespaceReconcileResult {
    const now = this.clock();
    return this.transaction((database) => {
      const rows = database.query<StoredNamespaceRow, [number]>(
        `SELECT session_id, kind, state, reservation_token_hash, fencing_token, lease_expires_at_ms,
          expected_hash, expected_generation, expected_format, created_at_ms, updated_at_ms, state_at_ms, reason_code
         FROM session_namespace_entries
         WHERE state = 'reserved' AND lease_expires_at_ms <= ?`,
      ).all(now);
      for (const row of rows) this.transitionTerminal(database, row, "abandoned", "LEASE_EXPIRED", now);
      return { expiredReservations: rows.length };
    });
  }

  private finishActive(reservation: ReservationHandle, state: "abandoned" | "quarantined", reasonCode: string): SessionNamespaceRecord {
    this.assertHandle(reservation);
    this.assertReason(reasonCode);
    const now = this.clock();
    const outcome = this.transaction<TransactionOutcome<SessionNamespaceRecord>>((database) => {
      const row = this.requireRow(database, reservation.sessionId);
      const failure = this.activeOwnerFailure(database, row, reservation, now);
      if (failure) return { failure };
      return { value: this.record(this.terminalRecord(database, row, state, reasonCode, now)) };
    });
    return this.unwrap(outcome);
  }

  private issuePermit(expectation: SessionNamespacePublicationPermitExpectation, now: number): SessionNamespacePublicationPermit {
    const token = randomBytes(32).toString("base64url");
    this.permits.set(token, { ...expectation, expiresAtMs: this.addLease(now, this.defaultLeaseMs) });
    return {
      token,
      kind: expectation.kind,
      sessionId: expectation.sessionId,
      fencingToken: expectation.fencingToken,
      previousIdentity: expectation.previousIdentity === null ? null : { ...expectation.previousIdentity },
      nextIdentity: { ...expectation.nextIdentity },
    };
  }

  private transaction<T>(operation: (database: Database) => T): T {
    let database: Database | undefined;
    let transactionOpen = false;
    let result: T | undefined;
    let failure: unknown;
    try {
      database = this.open();
      database.run("BEGIN IMMEDIATE");
      transactionOpen = true;
      this.initializePolicy(database);
      result = operation(database);
      database.run("COMMIT");
      transactionOpen = false;
    } catch (error) {
      failure = error;
      if (transactionOpen && database) {
        try { database.run("ROLLBACK"); } catch { /* close still releases the OS lock */ }
      }
    }
    try { database?.close(true); }
    catch (error) { if (!failure) failure = error; }
    if (failure) throw failureFrom(failure);
    return result as T;
  }

  private open(): Database {
    let database: Database | undefined;
    try {
      this.assertSafeRootAndFiles();
      database = this.connectionFactory(this.file, RUNTIME_SESSION_NAMESPACE_SQLITE_OPEN_FLAGS);
      this.configureConnection(database);
      this.assertSafeRootAndFiles();
      return database;
    } catch (error) {
      try { database?.close(false); } catch { /* original error is more useful */ }
      throw failureFrom(error);
    }
  }

  private initializePolicy(database: Database): void {
    database.run("CREATE TABLE IF NOT EXISTS session_namespace_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL, root_epoch TEXT NOT NULL DEFAULT '')");
    database.run(
      `CREATE TABLE IF NOT EXISTS session_namespace_entries (
        session_id TEXT PRIMARY KEY NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
        kind TEXT NOT NULL CHECK (kind IN ('ordinary', 'compiled')),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'prepared', 'committed', 'abandoned', 'quarantined')),
        reservation_token_hash TEXT NULL CHECK (reservation_token_hash IS NULL OR length(reservation_token_hash) = 64),
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        lease_expires_at_ms INTEGER NULL,
        expected_hash TEXT NULL CHECK (expected_hash IS NULL OR length(expected_hash) = 64),
        expected_generation INTEGER NULL CHECK (expected_generation IS NULL OR expected_generation >= 0),
        expected_format TEXT NULL CHECK (expected_format IS NULL OR length(expected_format) BETWEEN 1 AND 128),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        state_at_ms INTEGER NOT NULL CHECK (state_at_ms >= created_at_ms),
        reason_code TEXT NULL CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 2 AND 64),
        CHECK ((state IN ('reserved', 'prepared') AND reservation_token_hash IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
          OR (state IN ('committed', 'abandoned', 'quarantined') AND reservation_token_hash IS NULL AND lease_expires_at_ms IS NULL)),
        CHECK ((expected_hash IS NULL AND expected_generation IS NULL AND expected_format IS NULL)
          OR (expected_hash IS NOT NULL AND expected_generation IS NOT NULL AND expected_format IS NOT NULL)),
        CHECK (state != 'prepared' OR expected_hash IS NOT NULL),
        CHECK (state != 'committed' OR expected_hash IS NOT NULL)
      )`,
    );
    // CREATE TABLE IF NOT EXISTS does not validate an older table. Probe every
    // field the state machine relies on while still inside BEGIN IMMEDIATE, so
    // an incompatible shared file cannot be treated as a fresh namespace.
    database.query<StoredNamespaceRow, []>(
      `SELECT session_id, kind, state, reservation_token_hash, fencing_token, lease_expires_at_ms,
        expected_hash, expected_generation, expected_format, created_at_ms, updated_at_ms, state_at_ms, reason_code
       FROM session_namespace_entries LIMIT 0`,
    ).all();
    const policyColumns = database.query<{ name: string }, []>("PRAGMA table_info(session_namespace_policy)").all().map((row) => row.name);
    const hasRootEpoch = policyColumns.includes("root_epoch");
    if (!hasRootEpoch) {
      const legacy = database.query<Omit<StoredPolicy, "root_epoch">, []>("SELECT schema_version, coordinator_domain FROM session_namespace_policy WHERE singleton = 1").get();
      if (!legacy || legacy.coordinator_domain !== this.domain || legacy.schema_version !== "1.0.0" || !this.allowLegacyMigration) {
        throw new SessionNamespaceFailure("SESSION_NAMESPACE_POLICY_MISMATCH", "session namespace root requires an explicit exclusive 1.0-to-1.1 migration");
      }
      // This runs under the coordinator's BEGIN IMMEDIATE. Once committed, an
      // old 1.0 writer can only observe policy mismatch; it cannot continue to
      // write alongside the new required-root epoch.
      database.run("ALTER TABLE session_namespace_policy ADD COLUMN root_epoch TEXT NOT NULL DEFAULT ''");
      database.run("UPDATE session_namespace_policy SET schema_version = ?, root_epoch = ? WHERE singleton = 1", [this.schemaVersion, this.rootEpoch]);
      return;
    }
    const policy = database.query<StoredPolicy, []>("SELECT schema_version, coordinator_domain, root_epoch FROM session_namespace_policy WHERE singleton = 1").get();
    if (!policy) {
      database.run("INSERT INTO session_namespace_policy (singleton, schema_version, coordinator_domain, root_epoch) VALUES (1, ?, ?, ?)", [this.schemaVersion, this.domain, this.rootEpoch]);
      return;
    }
    if (policy.schema_version !== this.schemaVersion || policy.coordinator_domain !== this.domain || policy.root_epoch !== this.rootEpoch) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_POLICY_MISMATCH", "session namespace policy differs from this process configuration");
    }
  }

  private configureConnection(database: Database): void {
    database.run("PRAGMA journal_mode = DELETE");
    database.run("PRAGMA synchronous = FULL");
    database.run("PRAGMA locking_mode = NORMAL");
    database.run("PRAGMA busy_timeout = 0");
    const journal = String(this.pragma(database, "journal_mode") ?? "").toLowerCase();
    const synchronous = this.pragma(database, "synchronous");
    const locking = String(this.pragma(database, "locking_mode") ?? "").toLowerCase();
    const timeout = this.pragma(database, "busy_timeout");
    if (journal !== "delete" || !(synchronous === 2 || String(synchronous).toLowerCase() === "full") || locking !== "normal" || timeout !== 0) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace SQLite durability or lock pragmas could not be verified");
    }
  }

  private pragma(database: Database, name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown {
    const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : undefined;
  }

  private assertSafeRootAndFiles(): void {
    const kind = this.pathOps.rootKind(this.root);
    if (kind === "missing") this.pathOps.createRoot(this.root);
    if (this.pathOps.rootKind(this.root) !== "directory") {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace root must be a real directory, not a link");
    }
    for (const path of [this.file, `${this.file}-journal`, `${this.file}-wal`, `${this.file}-shm`]) {
      if (this.pathOps.kind(path) === "unsafe") {
        throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace SQLite file or sidecar is not a regular non-link file");
      }
    }
  }

  private find(database: Database, sessionId: string): StoredNamespaceRow | undefined {
    return database.query<StoredNamespaceRow, [string]>(
      `SELECT session_id, kind, state, reservation_token_hash, fencing_token, lease_expires_at_ms,
        expected_hash, expected_generation, expected_format, created_at_ms, updated_at_ms, state_at_ms, reason_code
       FROM session_namespace_entries WHERE session_id = ?`,
    ).get(sessionId) ?? undefined;
  }

  private requireRow(database: Database, sessionId: string): StoredNamespaceRow {
    const row = this.find(database, sessionId);
    if (!row) throw new SessionNamespaceFailure("SESSION_NAMESPACE_CONFLICT", "runtime session namespace entry does not exist");
    return row;
  }

  private activeOwnerFailure(database: Database, row: StoredNamespaceRow, reservation: ReservationHandle, now: number): SessionNamespaceFailure | undefined {
    if (!ACTIVE_STATES.has(row.state)) {
      return new SessionNamespaceFailure("SESSION_NAMESPACE_CONFLICT", "runtime session namespace entry is terminal");
    }
    if (row.kind !== reservation.kind || !sameOptionalIdentity(this.identity(row), reservation.expectedIdentity)
      || !row.reservation_token_hash || !sameFingerprint(row.reservation_token_hash, tokenFingerprint(reservation.token)) || row.fencing_token !== reservation.fencingToken) {
      return new SessionNamespaceFailure("SESSION_NAMESPACE_FENCED", "reservation capability or fencing token is stale");
    }
    if (this.expired(row, now)) {
      this.transitionTerminal(database, row, "abandoned", "LEASE_EXPIRED", now);
      return new SessionNamespaceFailure("SESSION_NAMESPACE_LEASE_EXPIRED", "runtime session reservation lease has expired");
    }
    return undefined;
  }

  /**
   * Persist an irreversible state transition. This intentionally has no
   * result: it is used only when the caller will return/throw independently.
   * SQLite failures still abort the surrounding BEGIN IMMEDIATE transaction.
   */
  private transitionTerminal(database: Database, row: StoredNamespaceRow, state: "committed" | "abandoned" | "quarantined", reasonCode: string | null, now: number): void {
    const nextFence = row.fencing_token + 1;
    database.run(
      `UPDATE session_namespace_entries
       SET state = ?, reservation_token_hash = NULL, fencing_token = ?, lease_expires_at_ms = NULL,
           updated_at_ms = ?, state_at_ms = ?, reason_code = ?
      WHERE session_id = ?`,
      [state, nextFence, now, now, reasonCode, row.session_id],
    );
  }

  /** Persist a terminal transition and return the matching authoritative row shape. */
  private terminalRecord(database: Database, row: StoredNamespaceRow, state: "committed" | "abandoned" | "quarantined", reasonCode: string | null, now: number): StoredNamespaceRow {
    this.transitionTerminal(database, row, state, reasonCode, now);
    const nextFence = row.fencing_token + 1;
    return {
      ...row,
      state,
      reservation_token_hash: null,
      fencing_token: nextFence,
      lease_expires_at_ms: null,
      updated_at_ms: now,
      state_at_ms: now,
      reason_code: reasonCode,
    };
  }

  private insertTerminal(
    database: Database,
    sessionId: string,
    kind: RuntimeSessionKind,
    state: "committed" | "quarantined",
    expectedIdentity: DurableSessionIdentity | null,
    reasonCode: string | null,
    now: number,
  ): StoredNamespaceRow {
    database.run(
      `INSERT INTO session_namespace_entries (
        session_id, kind, state, reservation_token_hash, fencing_token, lease_expires_at_ms,
        expected_hash, expected_generation, expected_format, created_at_ms, updated_at_ms, state_at_ms, reason_code
      ) VALUES (?, ?, ?, NULL, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, kind, state, expectedIdentity?.hash ?? null, expectedIdentity?.generation ?? null, expectedIdentity?.format ?? null, now, now, now, reasonCode],
    );
    return {
      session_id: sessionId,
      kind,
      state,
      reservation_token_hash: null,
      fencing_token: 1,
      lease_expires_at_ms: null,
      expected_hash: expectedIdentity?.hash ?? null,
      expected_generation: expectedIdentity?.generation ?? null,
      expected_format: expectedIdentity?.format ?? null,
      created_at_ms: now,
      updated_at_ms: now,
      state_at_ms: now,
      reason_code: reasonCode,
    };
  }

  private expired(row: StoredNamespaceRow, now: number): boolean {
    return ACTIVE_STATES.has(row.state) && row.lease_expires_at_ms !== null && row.lease_expires_at_ms <= now;
  }

  private identity(row: StoredNamespaceRow): DurableSessionIdentity | null {
    if (row.expected_hash === null && row.expected_generation === null && row.expected_format === null) return null;
    if (row.expected_hash === null || row.expected_generation === null || row.expected_format === null) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_POLICY_MISMATCH", "namespace durable identity fields are partially populated");
    }
    return { hash: row.expected_hash, generation: row.expected_generation, format: row.expected_format };
  }

  private handle(row: StoredNamespaceRow, token: string): ReservationHandle {
    if (row.lease_expires_at_ms === null) throw new SessionNamespaceFailure("SESSION_NAMESPACE_CONFLICT", "terminal namespace entries do not have reservation handles");
    return {
      sessionId: row.session_id,
      kind: row.kind,
      token,
      fencingToken: row.fencing_token,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      expectedIdentity: this.identity(row),
    };
  }

  private record(row: StoredNamespaceRow): SessionNamespaceRecord {
    return {
      sessionId: row.session_id,
      kind: row.kind,
      state: row.state,
      fencingToken: row.fencing_token,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      expectedIdentity: this.identity(row),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      stateAtMs: row.state_at_ms,
      reasonCode: row.reason_code,
    };
  }

  private unwrap<T>(outcome: TransactionOutcome<T>): T {
    if ("failure" in outcome) throw outcome.failure;
    return outcome.value;
  }

  private clock(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace clock returned an invalid timestamp");
    }
    return value;
  }

  private addLease(now: number, leaseMs: number): number {
    const expires = now + leaseMs;
    if (!Number.isSafeInteger(expires)) throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace lease overflows timestamp range");
    return expires;
  }

  private assertSessionId(value: string): void {
    if (!SESSION_ID_PATTERN.test(value)) throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace ID is invalid");
  }

  private assertKind(value: RuntimeSessionKind): void {
    if (value !== "ordinary" && value !== "compiled") throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "runtime session kind is invalid");
  }

  private assertState(value: RuntimeSessionNamespaceState): void {
    if (!ACTIVE_STATES.has(value) && !TERMINAL_STATES.has(value)) throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "runtime session state is invalid");
  }

  private assertIdentity(value: DurableSessionIdentity): void {
    if (!value || !HASH_PATTERN.test(value.hash) || !Number.isSafeInteger(value.generation) || value.generation < 0 || !FORMAT_PATTERN.test(value.format)) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "durable session identity is invalid");
    }
  }

  private assertHandle(value: ReservationHandle): void {
    if (!value || !TOKEN_PATTERN.test(value.token) || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_FENCED", "reservation capability is invalid");
    }
    this.assertSessionId(value.sessionId);
    this.assertKind(value.kind);
    if (value.expectedIdentity !== null) this.assertIdentity(value.expectedIdentity);
    if (!Number.isSafeInteger(value.leaseExpiresAtMs) || value.leaseExpiresAtMs < 0) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_FENCED", "reservation lease is invalid");
    }
  }

  private assertLeaseMs(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
      throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace lease must be between 1ms and 24h");
    }
  }

  private assertReason(value: string): void {
    if (!REASON_PATTERN.test(value)) throw new SessionNamespaceFailure("SESSION_NAMESPACE_STORAGE_FAILED", "session namespace reason code is invalid");
  }
}
