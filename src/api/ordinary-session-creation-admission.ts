import { createHash, randomBytes } from "crypto";
import { Database, constants } from "bun:sqlite";
import { lstatSync } from "fs";
import { join, resolve } from "path";

/** Durable admission for expensive ordinary-session creation only; never share an action/catalog domain. */
export const ORDINARY_SESSION_CREATION_ADMISSION_SCHEMA_VERSION = "1.0.0";
export const ORDINARY_SESSION_CREATION_ADMISSION_DOMAIN = "ordinary-session-creation-admission";
export const ORDINARY_SESSION_CREATION_ADMISSION_FILE_NAME = ".ordinary-session-creation-admission.sqlite";
export const ORDINARY_SESSION_CREATION_ADMISSION_SQLITE_OPEN_FLAGS = constants.SQLITE_OPEN_READWRITE
  | constants.SQLITE_OPEN_CREATE
  | constants.SQLITE_OPEN_NOFOLLOW
  | constants.SQLITE_OPEN_FULLMUTEX
  | constants.SQLITE_OPEN_EXRESCODE;

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_WHOLE_JOB_DEADLINE_MS = 300_000;
const DEFAULT_BUSY_TIMEOUT_MS = 25;
const STABLE_RETRY_AFTER_SECONDS = 60;

type SqlBinding = string | number;

export interface OrdinarySessionCreationAdmissionConfig {
  /** Host-owned runtime root; request data must never select it. */
  root: string;
  globalConcurrent: number;
  perPrincipalConcurrent: number;
  startsPerPrincipal: number;
  windowMs: number;
  maxTrackedPrincipals: number;
  leaseTtlMs?: number;
  wholeJobDeadlineMs?: number;
  busyTimeoutMs?: number;
  now?: () => number;
}

export type OrdinarySessionCreationAdmissionFailureCode =
  | "ORDINARY_CREATION_ADMISSION_BUSY"
  | "ORDINARY_CREATION_ADMISSION_RATE_LIMITED"
  | "ORDINARY_CREATION_ADMISSION_CAPACITY_EXHAUSTED"
  | "ORDINARY_CREATION_ADMISSION_POLICY_MISMATCH"
  | "ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE"
  | "ORDINARY_CREATION_ADMISSION_INDETERMINATE"
  | "ORDINARY_CREATION_ADMISSION_UNHEALTHY"
  | "ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED";

export type OrdinarySessionCreationAdmissionLeaseState =
  | { status: "active"; fence: string; expiresAt: number; deadlineAt: number }
  | { status: "refused"; code: OrdinarySessionCreationAdmissionFailureCode; retryAfterSeconds: number }
  | { status: "indeterminate"; code: "ORDINARY_CREATION_ADMISSION_INDETERMINATE"; retryAfterSeconds: number };

export type OrdinarySessionCreationAdmissionResult =
  | {
    status: "acquired";
    /** Opaque process-local capability; do not serialize or log it. */
    fence: string;
    expiresAt: number;
    deadlineAt: number;
    renewalIntervalMs: number;
    remainingDeadlineMs: () => number;
    checkActive: () => OrdinarySessionCreationAdmissionLeaseState;
    /** Refreshes physical occupancy but never moves the absolute deadline. */
    renew: () => OrdinarySessionCreationAdmissionLeaseState;
    /** Exact-owner acknowledgement. Starts remain durable rate-limit evidence. */
    release: () => boolean;
    /** Stops admission after an unknown/unabortable provider outcome. */
    quarantine: () => OrdinarySessionCreationAdmissionLeaseState;
  }
  | Extract<OrdinarySessionCreationAdmissionLeaseState, { status: "refused" | "indeterminate" }>;

export type OrdinarySessionCreationAdmissionRecoveryResult =
  | { status: "recovered"; providerOutcome: "unknown" }
  | { status: "absent" }
  | { status: "refused"; code: "ORDINARY_CREATION_ADMISSION_POLICY_MISMATCH" | "ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE"; retryAfterSeconds: number }
  | { status: "indeterminate"; code: "ORDINARY_CREATION_ADMISSION_INDETERMINATE"; retryAfterSeconds: number };

interface AdmissionConnection {
  run(sql: string, bindings?: readonly SqlBinding[]): void;
  get<T>(sql: string, bindings?: readonly SqlBinding[]): T | undefined;
  all<T>(sql: string, bindings?: readonly SqlBinding[]): T[];
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown;
  close(throwOnError: true): void;
}

export interface OrdinarySessionCreationAdmissionPathOps {
  kind(path: string): "missing" | "regular" | "directory" | "unsafe";
}

export interface OrdinarySessionCreationAdmissionOptions {
  connectionFactory?: (file: string, flags: number) => AdmissionConnection;
  pathOps?: OrdinarySessionCreationAdmissionPathOps;
  fileName?: string;
  schemaVersion?: string;
}

interface StoredPolicy {
  schema_version: string;
  coordinator_domain: string;
  policy_identity: string;
  global_concurrent: number;
  per_principal_concurrent: number;
  starts_per_principal: number;
  window_ms: number;
  max_tracked_principals: number;
  lease_ttl_ms: number;
  whole_job_deadline_ms: number;
  busy_timeout_ms: number;
}
interface StoredLease {
  fence: string;
  owner_instance: string;
  principal_fingerprint: string;
  state: "active" | "quarantined";
  expires_at_ms: number;
  deadline_at_ms: number;
}
interface StoredHealth { fence: string; owner_instance: string; quarantined_at_ms: number; }
interface CountRow { count: number; }

class OrdinarySessionCreationAdmissionFailure extends Error {
  constructor(readonly code: Exclude<OrdinarySessionCreationAdmissionFailureCode, "ORDINARY_CREATION_ADMISSION_BUSY" | "ORDINARY_CREATION_ADMISSION_RATE_LIMITED" | "ORDINARY_CREATION_ADMISSION_CAPACITY_EXHAUSTED" | "ORDINARY_CREATION_ADMISSION_UNHEALTHY" | "ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED">, message: string) {
    super(message);
  }
}

const nodePathOps: OrdinarySessionCreationAdmissionPathOps = {
  kind(path) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return "unsafe";
      if (stat.isFile()) return "regular";
      if (stat.isDirectory()) return "directory";
      return "unsafe";
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "missing";
      throw error;
    }
  },
};

class BunAdmissionConnection implements AdmissionConnection {
  constructor(private readonly database: Database) {}
  run(sql: string, bindings: readonly SqlBinding[] = []): void { if (bindings.length) this.database.run(sql, [...bindings]); else this.database.run(sql); }
  get<T>(sql: string, bindings: readonly SqlBinding[] = []): T | undefined { return bindings.length ? this.database.query(sql).get(...bindings) as T | undefined : this.database.query(sql).get() as T | undefined; }
  all<T>(sql: string, bindings: readonly SqlBinding[] = []): T[] { return bindings.length ? this.database.query(sql).all(...bindings) as T[] : this.database.query(sql).all() as T[]; }
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown { const row = this.database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get(); return row ? Object.values(row)[0] : undefined; }
  close(throwOnError: true): void { this.database.close(throwOnError); }
}

function connectionFactory(file: string, flags: number): AdmissionConnection { return new BunAdmissionConnection(new Database(file, flags)); }
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function retryAfter(milliseconds: number): number { return Math.max(1, Math.ceil(Math.max(0, milliseconds) / 1_000)); }
function policyIdentity(policy: Omit<StoredPolicy, "policy_identity">): string {
  return createHash("sha256").update([
    "ordinary-session-creation-admission-policy-v1", policy.schema_version, policy.coordinator_domain,
    policy.global_concurrent, policy.per_principal_concurrent, policy.starts_per_principal, policy.window_ms,
    policy.max_tracked_principals, policy.lease_ttl_ms, policy.whole_job_deadline_ms, policy.busy_timeout_ms,
  ].join("|")).digest("hex");
}
function principalKey(fingerprint: string): string {
  return createHash("sha256").update(`ordinary-session-creation-admission-principal-v1|${fingerprint}`).digest("hex");
}
function asFailure(error: unknown): OrdinarySessionCreationAdmissionFailure {
  if (error instanceof OrdinarySessionCreationAdmissionFailure) return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : "ordinary session creation admission SQLite coordination failed";
  if (/no such column|has no column|no such table|malformed database schema/i.test(message)) return new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_POLICY_MISMATCH", "ordinary session creation admission schema is incompatible");
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /SQLITE_BUSY|SQLITE_LOCKED|database is busy|database is locked/i.test(message)) return new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE", "ordinary session creation admission is busy");
  return new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE", message);
}

/**
 * Process-shared durable start admission. It accepts only an already-derived
 * principal fingerprint: raw identities, request bodies, and session IDs are
 * intentionally absent from this storage contract.
 */
export class OrdinarySessionCreationAdmissionCoordinator {
  readonly root: string;
  readonly file: string;
  /** Durable policy authority consumed by the namespace reservation lease. */
  readonly wholeJobDeadlineMs: number;
  private readonly now: () => number;
  private readonly policy: StoredPolicy;
  private readonly pathOps: OrdinarySessionCreationAdmissionPathOps;
  private readonly openConnection: (file: string, flags: number) => AdmissionConnection;
  private readonly instanceToken = randomBytes(32).toString("hex");

  constructor(config: Readonly<OrdinarySessionCreationAdmissionConfig>, options: OrdinarySessionCreationAdmissionOptions = {}) {
    const leaseTtlMs = config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const wholeJobDeadlineMs = config.wholeJobDeadlineMs ?? DEFAULT_WHOLE_JOB_DEADLINE_MS;
    const busyTimeoutMs = config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (typeof config.root !== "string" || !config.root.trim()
      || !positive(config.globalConcurrent) || !positive(config.perPrincipalConcurrent) || !positive(config.startsPerPrincipal)
      || !positive(config.windowMs) || !positive(config.maxTrackedPrincipals) || !positive(leaseTtlMs)
      || !positive(wholeJobDeadlineMs) || !positive(busyTimeoutMs)
      || busyTimeoutMs > 60_000 || config.perPrincipalConcurrent > config.globalConcurrent
      || (config.now !== undefined && typeof config.now !== "function")) {
      throw new Error("invalid ordinary session creation admission configuration");
    }
    const schemaVersion = options.schemaVersion ?? ORDINARY_SESSION_CREATION_ADMISSION_SCHEMA_VERSION;
    const fileName = options.fileName ?? ORDINARY_SESSION_CREATION_ADMISSION_FILE_NAME;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/.test(schemaVersion) || !/^\.[A-Za-z0-9_-]{1,128}\.sqlite$/.test(fileName)) {
      throw new Error("invalid ordinary session creation admission schema or filename");
    }
    this.root = resolve(config.root);
    this.file = join(this.root, fileName);
    this.wholeJobDeadlineMs = wholeJobDeadlineMs;
    this.now = config.now ?? Date.now;
    const unsigned: Omit<StoredPolicy, "policy_identity"> = {
      schema_version: schemaVersion, coordinator_domain: ORDINARY_SESSION_CREATION_ADMISSION_DOMAIN,
      global_concurrent: config.globalConcurrent, per_principal_concurrent: config.perPrincipalConcurrent,
      starts_per_principal: config.startsPerPrincipal, window_ms: config.windowMs, max_tracked_principals: config.maxTrackedPrincipals,
      lease_ttl_ms: leaseTtlMs, whole_job_deadline_ms: wholeJobDeadlineMs, busy_timeout_ms: busyTimeoutMs,
    };
    this.policy = { ...unsigned, policy_identity: policyIdentity(unsigned) };
    this.pathOps = options.pathOps ?? nodePathOps;
    this.openConnection = options.connectionFactory ?? connectionFactory;
  }

  /**
   * Verifies storage, SQLite settings, schema, and the durable policy before
   * request handling begins. It never creates a lease or start record.
   */
  initialize(): void {
    this.transaction(() => undefined);
  }

  acquire(input: { principalFingerprint: string }): OrdinarySessionCreationAdmissionResult {
    if (!/^[a-f0-9]{64}$/.test(input.principalFingerprint)) throw new Error("ordinary session creation admission requires a SHA-256 principal fingerprint");
    const now = this.clock();
    const principal = principalKey(input.principalFingerprint);
    try {
      return this.transaction((connection) => {
        if (connection.get<StoredHealth>("SELECT fence, owner_instance, quarantined_at_ms FROM ordinary_session_creation_admission_health WHERE singleton = 1")) {
          return this.refused("ORDINARY_CREATION_ADMISSION_UNHEALTHY", STABLE_RETRY_AFTER_SECONDS);
        }
        const expired = connection.get<StoredLease>("SELECT fence, owner_instance, principal_fingerprint, state, expires_at_ms, deadline_at_ms FROM ordinary_session_creation_admission_leases WHERE state = 'active' AND expires_at_ms <= ? ORDER BY expires_at_ms ASC, fence ASC LIMIT 1", [now]);
        if (expired) {
          this.quarantineExpired(connection, expired, now);
          return this.refused("ORDINARY_CREATION_ADMISSION_UNHEALTHY", STABLE_RETRY_AFTER_SECONDS);
        }
        if (connection.get<StoredLease>("SELECT fence, owner_instance, principal_fingerprint, state, expires_at_ms, deadline_at_ms FROM ordinary_session_creation_admission_leases WHERE state = 'quarantined' LIMIT 1")) {
          return this.refused("ORDINARY_CREATION_ADMISSION_UNHEALTHY", STABLE_RETRY_AFTER_SECONDS);
        }
        this.pruneStarts(connection, now);
        if ((connection.get<CountRow>("SELECT COUNT(*) AS count FROM ordinary_session_creation_admission_leases")?.count ?? 0) >= this.policy.global_concurrent) return this.refused("ORDINARY_CREATION_ADMISSION_BUSY", 1);
        if ((connection.get<CountRow>("SELECT COUNT(*) AS count FROM ordinary_session_creation_admission_leases WHERE principal_fingerprint = ?", [principal])?.count ?? 0) >= this.policy.per_principal_concurrent) return this.refused("ORDINARY_CREATION_ADMISSION_BUSY", 1);
        const starts = connection.get<CountRow>("SELECT COUNT(*) AS count FROM ordinary_session_creation_admission_starts WHERE principal_fingerprint = ?", [principal])?.count ?? 0;
        if (starts >= this.policy.starts_per_principal) {
          const oldest = connection.get<{ started_at_ms: number }>("SELECT started_at_ms FROM ordinary_session_creation_admission_starts WHERE principal_fingerprint = ? ORDER BY started_at_ms ASC, start_token ASC LIMIT 1", [principal]);
          const windowClosesAt = this.add(oldest?.started_at_ms ?? now, this.policy.window_ms);
          return this.refused("ORDINARY_CREATION_ADMISSION_RATE_LIMITED", retryAfter(windowClosesAt - now));
        }
        const known = !!connection.get<{ principal_fingerprint: string }>("SELECT principal_fingerprint FROM (SELECT principal_fingerprint FROM ordinary_session_creation_admission_starts UNION SELECT principal_fingerprint FROM ordinary_session_creation_admission_leases) WHERE principal_fingerprint = ? LIMIT 1", [principal]);
        if (!known && (connection.get<CountRow>("SELECT COUNT(*) AS count FROM (SELECT principal_fingerprint FROM ordinary_session_creation_admission_starts UNION SELECT principal_fingerprint FROM ordinary_session_creation_admission_leases)")?.count ?? 0) >= this.policy.max_tracked_principals) {
          return this.refused("ORDINARY_CREATION_ADMISSION_CAPACITY_EXHAUSTED", STABLE_RETRY_AFTER_SECONDS);
        }
        const fence = randomBytes(32).toString("hex");
        const expiresAt = this.add(now, this.policy.lease_ttl_ms);
        const deadlineAt = this.add(now, this.policy.whole_job_deadline_ms);
        connection.run("INSERT INTO ordinary_session_creation_admission_leases (fence, owner_instance, principal_fingerprint, state, acquired_at_ms, expires_at_ms, deadline_at_ms, quarantined_at_ms) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL)", [fence, this.instanceToken, principal, now, expiresAt, deadlineAt]);
        connection.run("INSERT INTO ordinary_session_creation_admission_starts (start_token, principal_fingerprint, started_at_ms) VALUES (?, ?, ?)", [fence, principal, now]);
        return {
          status: "acquired" as const, fence, expiresAt, deadlineAt,
          renewalIntervalMs: Math.max(1, Math.floor(this.policy.lease_ttl_ms / 2)),
          remainingDeadlineMs: () => Math.max(0, deadlineAt - this.clock()),
          checkActive: () => this.checkActive(fence), renew: () => this.renew(fence), release: () => this.release(fence), quarantine: () => this.quarantine(fence),
        };
      });
    } catch (error) { return this.resultFromFailure(error); }
  }

  /** Operator-only: removes a persisted quarantine while explicitly preserving unknown provider outcome semantics. */
  recoverExpiredForOperator(): OrdinarySessionCreationAdmissionRecoveryResult {
    try {
      return this.transaction((connection) => {
        const health = connection.get<StoredHealth>("SELECT fence, owner_instance, quarantined_at_ms FROM ordinary_session_creation_admission_health WHERE singleton = 1");
        if (!health) return { status: "absent" as const };
        connection.run("DELETE FROM ordinary_session_creation_admission_health WHERE singleton = 1 AND fence = ? AND owner_instance = ?", [health.fence, health.owner_instance]);
        connection.run("DELETE FROM ordinary_session_creation_admission_leases WHERE fence = ? AND owner_instance = ? AND state = 'quarantined'", [health.fence, health.owner_instance]);
        return { status: "recovered" as const, providerOutcome: "unknown" as const };
      });
    } catch (error) {
      const failure = asFailure(error);
      if (failure.code === "ORDINARY_CREATION_ADMISSION_INDETERMINATE") return { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_RETRY_AFTER_SECONDS };
      return { status: "refused", code: failure.code === "ORDINARY_CREATION_ADMISSION_POLICY_MISMATCH" ? failure.code : "ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE", retryAfterSeconds: STABLE_RETRY_AFTER_SECONDS };
    }
  }

  private checkActive(fence: string): OrdinarySessionCreationAdmissionLeaseState {
    return this.leaseState(fence, false);
  }
  private renew(fence: string): OrdinarySessionCreationAdmissionLeaseState {
    return this.leaseState(fence, true);
  }
  private leaseState(fence: string, renew: boolean): OrdinarySessionCreationAdmissionLeaseState {
    const now = this.clock();
    try {
      return this.transaction((connection) => {
        const lease = this.owned(connection, fence);
        if (!lease || lease.state !== "active") return this.refused("ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED", 1);
        if (lease.expires_at_ms <= now) {
          this.quarantineExpired(connection, lease, now);
          return this.refused("ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED", STABLE_RETRY_AFTER_SECONDS);
        }
        if (lease.deadline_at_ms <= now) return this.refused("ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED", 1);
        if (!renew) return { status: "active", fence, expiresAt: lease.expires_at_ms, deadlineAt: lease.deadline_at_ms };
        const expiresAt = this.add(now, this.policy.lease_ttl_ms);
        connection.run("UPDATE ordinary_session_creation_admission_leases SET expires_at_ms = ? WHERE fence = ? AND owner_instance = ? AND state = 'active'", [expiresAt, fence, this.instanceToken]);
        return { status: "active", fence, expiresAt, deadlineAt: lease.deadline_at_ms };
      });
    } catch (error) { return this.stateFromFailure(error); }
  }

  private release(fence: string): boolean {
    try {
      return this.transaction((connection) => {
        const health = connection.get<StoredHealth>("SELECT fence, owner_instance, quarantined_at_ms FROM ordinary_session_creation_admission_health WHERE singleton = 1");
        if (health?.fence === fence && health.owner_instance === this.instanceToken) {
          connection.run("DELETE FROM ordinary_session_creation_admission_health WHERE singleton = 1 AND fence = ? AND owner_instance = ?", [fence, this.instanceToken]);
          connection.run("DELETE FROM ordinary_session_creation_admission_leases WHERE fence = ? AND owner_instance = ?", [fence, this.instanceToken]);
          return true;
        }
        const lease = this.owned(connection, fence);
        if (!lease) return false;
        connection.run("DELETE FROM ordinary_session_creation_admission_leases WHERE fence = ? AND owner_instance = ?", [fence, this.instanceToken]);
        return true;
      });
    } catch { return false; }
  }

  private quarantine(fence: string): OrdinarySessionCreationAdmissionLeaseState {
    const now = this.clock();
    try {
      return this.transaction((connection) => {
        const lease = this.owned(connection, fence);
        if (!lease || lease.state !== "active") return this.refused("ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED", STABLE_RETRY_AFTER_SECONDS);
        this.quarantineExpired(connection, lease, now);
        return this.refused("ORDINARY_CREATION_ADMISSION_UNHEALTHY", STABLE_RETRY_AFTER_SECONDS);
      });
    } catch (error) { return this.stateFromFailure(error); }
  }

  private owned(connection: AdmissionConnection, fence: string): StoredLease | undefined {
    return connection.get<StoredLease>("SELECT fence, owner_instance, principal_fingerprint, state, expires_at_ms, deadline_at_ms FROM ordinary_session_creation_admission_leases WHERE fence = ? AND owner_instance = ?", [fence, this.instanceToken]);
  }
  private quarantineExpired(connection: AdmissionConnection, lease: StoredLease, now: number): void {
    // Health is a singleton recovery authority. A second failed lease must
    // remain active until the first authority is settled or recovered; marking
    // it quarantined without owning health would create an unrecoverable row.
    if (connection.get<StoredHealth>("SELECT fence, owner_instance, quarantined_at_ms FROM ordinary_session_creation_admission_health WHERE singleton = 1")) return;
    connection.run("UPDATE ordinary_session_creation_admission_leases SET state = 'quarantined', quarantined_at_ms = ? WHERE fence = ? AND owner_instance = ? AND state = 'active'", [now, lease.fence, lease.owner_instance]);
    connection.run("INSERT INTO ordinary_session_creation_admission_health (singleton, fence, owner_instance, quarantined_at_ms) VALUES (1, ?, ?, ?)", [lease.fence, lease.owner_instance, now]);
  }
  private pruneStarts(connection: AdmissionConnection, now: number): void { connection.run("DELETE FROM ordinary_session_creation_admission_starts WHERE started_at_ms <= ?", [now - this.policy.window_ms]); }
  private refused(code: Exclude<OrdinarySessionCreationAdmissionFailureCode, "ORDINARY_CREATION_ADMISSION_INDETERMINATE">, retryAfterSeconds: number): Extract<OrdinarySessionCreationAdmissionLeaseState, { status: "refused" }> { return { status: "refused", code, retryAfterSeconds }; }
  private resultFromFailure(error: unknown): Extract<OrdinarySessionCreationAdmissionResult, { status: "refused" | "indeterminate" }> {
    const failure = asFailure(error);
    if (failure.code === "ORDINARY_CREATION_ADMISSION_INDETERMINATE") return { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_RETRY_AFTER_SECONDS };
    return this.refused(failure.code, failure.code === "ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE" ? 1 : STABLE_RETRY_AFTER_SECONDS);
  }
  private stateFromFailure(error: unknown): OrdinarySessionCreationAdmissionLeaseState {
    const failure = asFailure(error);
    if (failure.code === "ORDINARY_CREATION_ADMISSION_INDETERMINATE") return { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_RETRY_AFTER_SECONDS };
    return this.refused(failure.code, failure.code === "ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE" ? 1 : STABLE_RETRY_AFTER_SECONDS);
  }
  private clock(): number { const now = this.now(); if (!Number.isSafeInteger(now) || now < 0) throw new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE", "ordinary session creation admission clock is invalid"); return now; }
  private add(now: number, duration: number): number { const value = now + duration; if (!Number.isSafeInteger(value)) throw new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE", "ordinary session creation admission timestamp overflows"); return value; }

  private transaction<T>(operation: (connection: AdmissionConnection) => T): T {
    let connection: AdmissionConnection | undefined; let begun = false; let committed = false; let failure: unknown;
    try {
      connection = this.open(); connection.run("BEGIN IMMEDIATE"); begun = true; this.initializePolicy(connection);
      const value = operation(connection);
      try { connection.run("COMMIT"); committed = true; begun = false; }
      catch { throw new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_INDETERMINATE", "ordinary session creation admission commit outcome is indeterminate"); }
      return value;
    } catch (error) {
      failure = error;
      if (begun && connection) { try { connection.run("ROLLBACK"); } catch { /* COMMIT acknowledgement may already be lost */ } }
      throw error;
    } finally {
      try { connection?.close(true); }
      catch (closeError) { if (!committed && failure === undefined) throw asFailure(closeError); }
    }
  }

  private initializePolicy(connection: AdmissionConnection): void {
    connection.run("CREATE TABLE IF NOT EXISTS ordinary_session_creation_admission_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL, policy_identity TEXT NOT NULL, global_concurrent INTEGER NOT NULL, per_principal_concurrent INTEGER NOT NULL, starts_per_principal INTEGER NOT NULL, window_ms INTEGER NOT NULL, max_tracked_principals INTEGER NOT NULL, lease_ttl_ms INTEGER NOT NULL, whole_job_deadline_ms INTEGER NOT NULL, busy_timeout_ms INTEGER NOT NULL)");
    connection.run("CREATE TABLE IF NOT EXISTS ordinary_session_creation_admission_leases (fence TEXT PRIMARY KEY, owner_instance TEXT NOT NULL, principal_fingerprint TEXT NOT NULL CHECK (length(principal_fingerprint) = 64), state TEXT NOT NULL CHECK (state IN ('active', 'quarantined')), acquired_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, deadline_at_ms INTEGER NOT NULL, quarantined_at_ms INTEGER NULL)");
    connection.run("CREATE TABLE IF NOT EXISTS ordinary_session_creation_admission_starts (start_token TEXT PRIMARY KEY, principal_fingerprint TEXT NOT NULL CHECK (length(principal_fingerprint) = 64), started_at_ms INTEGER NOT NULL)");
    connection.run("CREATE TABLE IF NOT EXISTS ordinary_session_creation_admission_health (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), fence TEXT NOT NULL, owner_instance TEXT NOT NULL, quarantined_at_ms INTEGER NOT NULL)");
    connection.run("CREATE INDEX IF NOT EXISTS ordinary_session_creation_admission_leases_principal ON ordinary_session_creation_admission_leases(principal_fingerprint)");
    connection.run("CREATE INDEX IF NOT EXISTS ordinary_session_creation_admission_starts_principal ON ordinary_session_creation_admission_starts(principal_fingerprint, started_at_ms)");
    const stored = connection.get<StoredPolicy>("SELECT schema_version, coordinator_domain, policy_identity, global_concurrent, per_principal_concurrent, starts_per_principal, window_ms, max_tracked_principals, lease_ttl_ms, whole_job_deadline_ms, busy_timeout_ms FROM ordinary_session_creation_admission_policy WHERE singleton = 1");
    if (!stored) {
      connection.run("INSERT INTO ordinary_session_creation_admission_policy (singleton, schema_version, coordinator_domain, policy_identity, global_concurrent, per_principal_concurrent, starts_per_principal, window_ms, max_tracked_principals, lease_ttl_ms, whole_job_deadline_ms, busy_timeout_ms) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [this.policy.schema_version, this.policy.coordinator_domain, this.policy.policy_identity, this.policy.global_concurrent, this.policy.per_principal_concurrent, this.policy.starts_per_principal, this.policy.window_ms, this.policy.max_tracked_principals, this.policy.lease_ttl_ms, this.policy.whole_job_deadline_ms, this.policy.busy_timeout_ms]);
      return;
    }
    if (stored.schema_version !== this.policy.schema_version || stored.coordinator_domain !== this.policy.coordinator_domain || stored.policy_identity !== this.policy.policy_identity
      || stored.global_concurrent !== this.policy.global_concurrent || stored.per_principal_concurrent !== this.policy.per_principal_concurrent || stored.starts_per_principal !== this.policy.starts_per_principal || stored.window_ms !== this.policy.window_ms || stored.max_tracked_principals !== this.policy.max_tracked_principals || stored.lease_ttl_ms !== this.policy.lease_ttl_ms || stored.whole_job_deadline_ms !== this.policy.whole_job_deadline_ms || stored.busy_timeout_ms !== this.policy.busy_timeout_ms) {
      throw new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_POLICY_MISMATCH", "ordinary session creation admission policy differs from this process configuration");
    }
  }

  private open(): AdmissionConnection {
    let connection: AdmissionConnection | undefined;
    try {
      this.assertSafePaths(); connection = this.openConnection(this.file, ORDINARY_SESSION_CREATION_ADMISSION_SQLITE_OPEN_FLAGS); this.configure(connection); this.assertSafePaths(); return connection;
    } catch (error) {
      try { connection?.close(true); } catch { /* original error is authoritative */ }
      throw asFailure(error);
    }
  }
  private assertSafePaths(): void {
    if (this.pathOps.kind(this.root) !== "directory") throw new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE", "ordinary session creation admission root is not a real directory");
    for (const path of [this.file, `${this.file}-journal`, `${this.file}-wal`, `${this.file}-shm`]) {
      const kind = this.pathOps.kind(path);
      if (kind !== "missing" && kind !== "regular") throw new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE", "ordinary session creation admission SQLite file or sidecar is not a regular non-link file");
    }
  }
  private configure(connection: AdmissionConnection): void {
    connection.run(`PRAGMA busy_timeout = ${this.policy.busy_timeout_ms}`);
    connection.run("PRAGMA journal_mode = DELETE"); connection.run("PRAGMA synchronous = FULL"); connection.run("PRAGMA locking_mode = NORMAL");
    const journal = String(connection.pragma("journal_mode") ?? "").toLowerCase();
    const synchronous = connection.pragma("synchronous"); const locking = String(connection.pragma("locking_mode") ?? "").toLowerCase(); const timeout = connection.pragma("busy_timeout");
    if (journal !== "delete" || !(synchronous === 2 || String(synchronous).toLowerCase() === "full") || locking !== "normal" || timeout !== this.policy.busy_timeout_ms) throw new OrdinarySessionCreationAdmissionFailure("ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE", "ordinary session creation admission SQLite pragmas could not be verified");
  }
}
