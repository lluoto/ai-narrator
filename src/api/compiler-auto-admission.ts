import { createHash, randomBytes } from "crypto";
import { Database, constants } from "bun:sqlite";
import { lstatSync } from "fs";
import { join, resolve } from "path";

/** An independent durable coordination domain; it never shares catalog policy. */
export const COMPILER_AUTO_ADMISSION_SCHEMA_VERSION = "1.2.0";
export const COMPILER_AUTO_ADMISSION_SQLITE_OPEN_FLAGS = constants.SQLITE_OPEN_READWRITE
  | constants.SQLITE_OPEN_CREATE
  | constants.SQLITE_OPEN_NOFOLLOW
  | constants.SQLITE_OPEN_FULLMUTEX
  | constants.SQLITE_OPEN_EXRESCODE;

const COORDINATOR_DOMAIN = "compiler-auto-admission";
const DEFAULT_ROOT = join("data", "compiler-catalog");
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_WHOLE_JOB_DEADLINE_MS = 120_000;
const DEFAULT_HARD_DRAIN_MS = 30_000;
const STABLE_RETRY_AFTER_SECONDS = 60;

export interface CompilerAutoAdmissionConfig {
  /** The shared, trusted catalog root. Different roots are separate coordination domains. */
  root?: string;
  globalConcurrent: number;
  perPrincipalConcurrent: number;
  startsPerPrincipal: number;
  windowMs: number;
  maxTrackedPrincipals: number;
  /** A holder must renew before this interval elapses; expiry makes its fence stale. */
  leaseTtlMs?: number;
  /** An absolute job lifetime. Renewing can never move this deadline. */
  wholeJobDeadlineMs?: number;
  /**
   * Maximum post-deadline drain time for a model call that ignores abort.
   * Expiry moves the whole admission domain into a durable fail-closed health
   * state instead of silently opening a new model slot.
   */
  hardDrainMs?: number;
  now?: () => number;
}

export const DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG: Readonly<Omit<CompilerAutoAdmissionConfig, "now">> = {
  globalConcurrent: 2,
  perPrincipalConcurrent: 1,
  startsPerPrincipal: 4,
  windowMs: 60_000,
  maxTrackedPrincipals: 1_024,
  leaseTtlMs: DEFAULT_LEASE_TTL_MS,
  wholeJobDeadlineMs: DEFAULT_WHOLE_JOB_DEADLINE_MS,
  hardDrainMs: DEFAULT_HARD_DRAIN_MS,
};

export type CompilerAutoAdmissionFailureCode =
  | "AUTO_ADMISSION_BUSY"
  | "AUTO_ADMISSION_RATE_LIMITED"
  | "AUTO_ADMISSION_CAPACITY_EXHAUSTED"
  | "AUTO_ADMISSION_POLICY_MISMATCH"
  | "AUTO_ADMISSION_STORAGE_UNAVAILABLE"
  /** A COMMIT acknowledgement was unavailable; durable mutation may exist. */
  | "AUTO_ADMISSION_INDETERMINATE"
  /** An unabortable model drain exceeded its bounded ownership period. */
  | "AUTO_ADMISSION_UNHEALTHY";

export type CompilerAutoAdmissionResult =
  | {
    status: "acquired";
    /** Cryptographically random fencing identity; never put it in an HTTP response or log. */
    fence: string;
    expiresAt: number;
    deadlineAt: number;
    /** Bounded post-deadline drain before this coordination domain quarantines. */
    hardDrainMs: number;
    /** Liveness lease for a quarantined owner process; only expiry permits restart recovery. */
    quarantineHeartbeatTtlMs: number;
    /** Server-side scheduling hint; no caller-provided value controls renewal cadence. */
    renewalIntervalMs: number;
    /** Uses the controller clock, so transports can enforce the same absolute deadline. */
    remainingDeadlineMs: () => number;
    /** Confirms the exact durable lease immediately before an irreversible continuation write. */
    checkActive: () => CompilerAutoAdmissionLeaseState;
    /**
     * Refreshes physical occupancy; checkActive still refuses all publication
     * past deadlineAt. An exact token may recover its unclaimed physical row
     * after TTL, but never a row already reclaimed by another fence.
     */
    renew: () => CompilerAutoAdmissionLeaseState;
    /** Runs a synchronous publication under this exact admission fence (lock order: admission → catalog). */
    withActiveFence: <T>(operation: () => T) => CompilerAutoAdmissionFenceResult<T>;
    /** Fail closed globally when an unabortable timed-out job exceeds its drain bound. */
    quarantine: () => CompilerAutoAdmissionQuarantineState;
    /** Extends only this process-instance's quarantine guardian lease. */
    renewQuarantine: () => CompilerAutoAdmissionQuarantineState;
    /** Clears only a health quarantine written by this exact fence. */
    clearQuarantine: () => boolean;
    /** Deletes only the row whose fencing identity this holder owns. */
    release: () => boolean;
  }
  | { status: "refused"; code: CompilerAutoAdmissionFailureCode; retryAfterSeconds: number }
  | { status: "indeterminate"; code: "AUTO_ADMISSION_INDETERMINATE"; retryAfterSeconds: number };

export type CompilerAutoAdmissionLeaseState =
  | { status: "active"; fence: string; expiresAt: number; deadlineAt: number }
  | {
    status: "refused";
    code: "AUTO_ADMISSION_LEASE_EXPIRED" | CompilerAutoAdmissionFailureCode;
    retryAfterSeconds: number;
  };

export type CompilerAutoAdmissionFenceResult<T> =
  | { status: "executed"; value: T }
  /** The fenced callback returned, but admission COMMIT acknowledgement failed. */
  | { status: "indeterminate"; code: "AUTO_ADMISSION_INDETERMINATE"; retryAfterSeconds: number; value?: T }
  | Exclude<CompilerAutoAdmissionLeaseState, { status: "active" }>;

export type CompilerAutoAdmissionQuarantineState =
  | { status: "quarantined"; fence: string }
  | Exclude<CompilerAutoAdmissionLeaseState, { status: "active" }>;

type SqlBinding = string | number;

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
  hard_drain_ms: number;
}

interface StoredLease { lease_token: string; owner_instance: string; expires_at: number; deadline_at: number; }
interface StoredHealth { drain_fence: string; owner_instance: string; heartbeat_expires_at: number; recovery_required: number; }
interface CountRow { count: number; }
interface CapacityRow { available_at: number; }

interface AdmissionConnection {
  run(sql: string, bindings?: readonly SqlBinding[]): void;
  get<T>(sql: string, bindings?: readonly SqlBinding[]): T | undefined;
  all<T>(sql: string, bindings?: readonly SqlBinding[]): T[];
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown;
  close(throwOnError: true): void;
}

export interface CompilerAutoAdmissionPathOps { kind(path: string): "missing" | "regular" | "directory" | "unsafe"; }
export interface CompilerAutoAdmissionOptions {
  connectionFactory?: (file: string, flags: number) => AdmissionConnection;
  pathOps?: CompilerAutoAdmissionPathOps;
  fileName?: string;
  schemaVersion?: string;
}

export class CompilerAutoAdmissionFailure extends Error {
  constructor(readonly code: Exclude<CompilerAutoAdmissionFailureCode, "AUTO_ADMISSION_RATE_LIMITED" | "AUTO_ADMISSION_CAPACITY_EXHAUSTED">, message: string) { super(message); }
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isExactRootValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function configuredEnvironmentRoot(variable: "COMPILER_AUTO_ADMISSION_ROOT" | "COMPILER_CATALOG_ROOT"): string | undefined {
  const value = process.env[variable];
  if (value === undefined) return undefined;
  if (!isExactRootValue(value)) throw new Error("invalid compiler automatic admission root");
  return value;
}

function retryAfterSeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(Math.max(0, milliseconds) / 1_000));
}

function resourceFingerprint(preparedArtifactId: string): string {
  return createHash("sha256").update(`compiler-auto-resource-v1|${preparedArtifactId}`).digest("hex");
}

function policyIdentity(policy: Omit<StoredPolicy, "policy_identity">): string {
  return createHash("sha256").update([
    "compiler-auto-admission-policy-v1",
    policy.schema_version,
    policy.coordinator_domain,
    policy.global_concurrent,
    policy.per_principal_concurrent,
    policy.starts_per_principal,
    policy.window_ms,
    policy.max_tracked_principals,
    policy.lease_ttl_ms,
    policy.whole_job_deadline_ms,
    policy.hard_drain_ms,
  ].join("|")).digest("hex");
}

function asFailure(error: unknown): CompilerAutoAdmissionFailure {
  if (error instanceof CompilerAutoAdmissionFailure) return error;
  const record = error as { code?: string } | undefined;
  const message = error instanceof Error ? error.message : "automatic compiler admission SQLite coordination failed";
  if (/no such column|has no column|no such table|malformed database schema/i.test(message)) {
    return new CompilerAutoAdmissionFailure("AUTO_ADMISSION_POLICY_MISMATCH", "automatic compiler admission policy schema is incompatible");
  }
  if (record?.code === "SQLITE_BUSY" || record?.code === "SQLITE_LOCKED" || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(message)) {
    return new CompilerAutoAdmissionFailure("AUTO_ADMISSION_BUSY", "automatic compiler admission is busy");
  }
  return new CompilerAutoAdmissionFailure("AUTO_ADMISSION_STORAGE_UNAVAILABLE", message);
}

const nodePathOps: CompilerAutoAdmissionPathOps = {
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
  run(sql: string, bindings: readonly SqlBinding[] = []): void {
    if (bindings.length) this.database.run(sql, [...bindings]); else this.database.run(sql);
  }
  get<T>(sql: string, bindings: readonly SqlBinding[] = []): T | undefined {
    return bindings.length ? this.database.query(sql).get(...bindings) as T | undefined : this.database.query(sql).get() as T | undefined;
  }
  all<T>(sql: string, bindings: readonly SqlBinding[] = []): T[] {
    return bindings.length ? this.database.query(sql).all(...bindings) as T[] : this.database.query(sql).all() as T[];
  }
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown {
    const row = this.database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : undefined;
  }
  close(throwOnError: true): void { this.database.close(throwOnError); }
}

function bunConnectionFactory(file: string, flags: number): AdmissionConnection {
  return new BunAdmissionConnection(new Database(file, flags));
}

/**
 * SQLite-backed admission for automatic compiler work. The database retains
 * only SHA-256 principal/resource fingerprints and random lease fences; raw
 * principals, credentials, and prepared artifact IDs never enter this store.
 */
export class CompilerAutoAdmissionController {
  readonly root: string;
  readonly file: string;
  private readonly now: () => number;
  private readonly policy: StoredPolicy;
  private readonly pathOps: CompilerAutoAdmissionPathOps;
  private readonly connectionFactory: (file: string, flags: number) => AdmissionConnection;
  private readonly instanceToken = randomBytes(32).toString("hex");

  constructor(config: Readonly<CompilerAutoAdmissionConfig> = DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG, options: CompilerAutoAdmissionOptions = {}) {
    const leaseTtlMs = config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const wholeJobDeadlineMs = config.wholeJobDeadlineMs ?? DEFAULT_WHOLE_JOB_DEADLINE_MS;
    const hardDrainMs = config.hardDrainMs ?? DEFAULT_HARD_DRAIN_MS;
    if (!validPositiveInteger(config.globalConcurrent)
      || !validPositiveInteger(config.perPrincipalConcurrent)
      || !validPositiveInteger(config.startsPerPrincipal)
      || !validPositiveInteger(config.windowMs)
      || !validPositiveInteger(config.maxTrackedPrincipals)
      || !validPositiveInteger(leaseTtlMs)
      || !validPositiveInteger(wholeJobDeadlineMs)
      || !validPositiveInteger(hardDrainMs)
      || config.perPrincipalConcurrent > config.globalConcurrent
      || (config.now !== undefined && typeof config.now !== "function")
      || (config.root !== undefined && !isExactRootValue(config.root))) {
      throw new Error("invalid compiler automatic admission configuration");
    }
    const schemaVersion = options.schemaVersion ?? COMPILER_AUTO_ADMISSION_SCHEMA_VERSION;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/.test(schemaVersion)) throw new Error("invalid compiler automatic admission schema version");
    const fileName = options.fileName ?? ".compiler-auto-admission.sqlite";
    if (!/^\.[A-Za-z0-9_-]{1,128}\.sqlite$/.test(fileName)) throw new Error("invalid compiler automatic admission filename");
    const autoAdmissionRoot = config.root === undefined
      ? configuredEnvironmentRoot("COMPILER_AUTO_ADMISSION_ROOT")
      : undefined;
    const catalogRoot = config.root === undefined && autoAdmissionRoot === undefined
      ? configuredEnvironmentRoot("COMPILER_CATALOG_ROOT")
      : undefined;
    this.root = resolve(config.root ?? autoAdmissionRoot ?? catalogRoot ?? DEFAULT_ROOT);
    this.file = join(this.root, fileName);
    this.now = config.now ?? Date.now;
    const unsignedPolicy: Omit<StoredPolicy, "policy_identity"> = {
      schema_version: schemaVersion,
      coordinator_domain: COORDINATOR_DOMAIN,
      global_concurrent: config.globalConcurrent,
      per_principal_concurrent: config.perPrincipalConcurrent,
      starts_per_principal: config.startsPerPrincipal,
      window_ms: config.windowMs,
      max_tracked_principals: config.maxTrackedPrincipals,
      lease_ttl_ms: leaseTtlMs,
      whole_job_deadline_ms: wholeJobDeadlineMs,
      hard_drain_ms: hardDrainMs,
    };
    this.policy = { ...unsignedPolicy, policy_identity: policyIdentity(unsignedPolicy) };
    this.pathOps = options.pathOps ?? nodePathOps;
    this.connectionFactory = options.connectionFactory ?? bunConnectionFactory;
  }

  /**
   * Establishes and verifies the durable policy without acquiring work,
   * recording a start, or observing/recovering health state. Hosts use this
   * as an explicit startup barrier before they begin listening.
   */
  initialize(): void {
    try {
      this.transaction((connection) => {
        this.probeAuxiliarySchema(connection);
      });
    } catch (error) {
      throw asFailure(error);
    }
  }

  acquire(input: { principalFingerprint: string; preparedArtifactId: string }): CompilerAutoAdmissionResult {
    if (!/^[a-f0-9]{64}$/.test(input.principalFingerprint)) {
      throw new Error("compiler automatic admission requires a SHA-256 principal fingerprint");
    }
    if (typeof input.preparedArtifactId !== "string" || input.preparedArtifactId.length === 0) {
      throw new Error("compiler automatic admission requires a prepared artifact id");
    }
    const now = this.currentTime();
    const resource = resourceFingerprint(input.preparedArtifactId);
    try {
      return this.transaction((connection) => {
        const health = connection.get<StoredHealth>("SELECT drain_fence, owner_instance, heartbeat_expires_at, recovery_required FROM compiler_auto_admission_health WHERE singleton = 1");
        if (health) {
          if (health.recovery_required === 1) return this.refused("AUTO_ADMISSION_UNHEALTHY", STABLE_RETRY_AFTER_SECONDS);
          if (health.heartbeat_expires_at > now) return this.refused("AUTO_ADMISSION_UNHEALTHY", retryAfterSeconds(health.heartbeat_expires_at - now));
          // Restart recovery is safe only after the quarantining process's
          // guardian lease has expired. A live stuck caller renews it.
          connection.run("DELETE FROM compiler_auto_admission_health WHERE singleton = 1 AND drain_fence = ? AND owner_instance = ? AND heartbeat_expires_at <= ?", [health.drain_fence, health.owner_instance, now]);
        }
        const expired = connection.get<StoredLease>("SELECT lease_token, owner_instance, expires_at, deadline_at FROM compiler_auto_admission_leases WHERE expires_at <= ? ORDER BY expires_at ASC, lease_token ASC LIMIT 1", [now]);
        if (expired) {
          // Never replace a merely expired physical slot in the same acquire.
          // Its old worker may still own an in-flight provider request. Persist
          // a fence-owned quarantine and require its settle acknowledgement or
          // an explicitly authorized operator recovery.
          this.installReclaimQuarantine(connection, expired, now);
          return this.refused("AUTO_ADMISSION_UNHEALTHY", STABLE_RETRY_AFTER_SECONDS);
        }
        this.reclaimExpired(connection, now);
        if ((connection.get<CountRow>("SELECT COUNT(*) AS count FROM compiler_auto_admission_leases")?.count ?? 0) >= this.policy.global_concurrent) {
          return this.refused("AUTO_ADMISSION_BUSY", 1);
        }
        if (connection.get<StoredLease>("SELECT lease_token, expires_at, deadline_at FROM compiler_auto_admission_leases WHERE resource_hash = ? LIMIT 1", [resource])) {
          return this.refused("AUTO_ADMISSION_BUSY", 1);
        }
        if ((connection.get<CountRow>("SELECT COUNT(*) AS count FROM compiler_auto_admission_leases WHERE principal_fingerprint = ?", [input.principalFingerprint])?.count ?? 0) >= this.policy.per_principal_concurrent) {
          return this.refused("AUTO_ADMISSION_BUSY", 1);
        }
        const starts = connection.get<CountRow>("SELECT COUNT(*) AS count FROM compiler_auto_admission_starts WHERE principal_fingerprint = ?", [input.principalFingerprint])?.count ?? 0;
        if (starts >= this.policy.starts_per_principal) {
          const first = connection.get<{ started_at: number }>("SELECT started_at FROM compiler_auto_admission_starts WHERE principal_fingerprint = ? ORDER BY started_at ASC, start_token ASC LIMIT 1", [input.principalFingerprint]);
          return this.refused("AUTO_ADMISSION_RATE_LIMITED", retryAfterSeconds((first?.started_at ?? now) + this.policy.window_ms - now));
        }
        if (!this.principalIsTracked(connection, input.principalFingerprint)
          && (connection.get<CountRow>("SELECT COUNT(*) AS count FROM (SELECT principal_fingerprint FROM compiler_auto_admission_starts UNION SELECT principal_fingerprint FROM compiler_auto_admission_leases)")?.count ?? 0) >= this.policy.max_tracked_principals) {
          return this.refused("AUTO_ADMISSION_CAPACITY_EXHAUSTED", this.capacityRetryAfter(connection, now));
        }
        const fence = randomBytes(32).toString("hex");
        const deadlineAt = now + this.policy.whole_job_deadline_ms;
        // Physical occupancy survives until TTL expiry, independently of the
        // logical deadline. A timed-out but still-running job therefore keeps
        // its admission slot until it settles or its process stops renewing.
        const expiresAt = now + this.policy.lease_ttl_ms;
        connection.run("INSERT INTO compiler_auto_admission_leases (lease_token, owner_instance, principal_fingerprint, resource_hash, acquired_at, expires_at, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [fence, this.instanceToken, input.principalFingerprint, resource, now, expiresAt, deadlineAt]);
        connection.run("INSERT INTO compiler_auto_admission_starts (start_token, principal_fingerprint, started_at) VALUES (?, ?, ?)", [fence, input.principalFingerprint, now]);
        return {
          status: "acquired" as const,
          fence,
          expiresAt,
          deadlineAt,
          hardDrainMs: this.policy.hard_drain_ms,
          quarantineHeartbeatTtlMs: Math.max(this.policy.lease_ttl_ms, this.policy.hard_drain_ms),
          renewalIntervalMs: Math.max(1, Math.floor((expiresAt - now) / 2)),
          remainingDeadlineMs: () => Math.max(0, deadlineAt - this.currentTime()),
          checkActive: () => this.checkActive(fence),
          renew: () => this.renew(fence),
          withActiveFence: <T>(operation: () => T) => this.withActiveFence(fence, operation),
          quarantine: () => this.quarantine(fence),
          renewQuarantine: () => this.renewQuarantine(fence),
          clearQuarantine: () => this.clearQuarantine(fence),
          release: () => this.release(fence),
        };
      });
    } catch (error) {
      const failure = asFailure(error);
      if (failure.code === "AUTO_ADMISSION_INDETERMINATE") return { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_RETRY_AFTER_SECONDS };
      return this.refused(failure.code, failure.code === "AUTO_ADMISSION_BUSY" ? 1 : STABLE_RETRY_AFTER_SECONDS);
    }
  }

  /**
   * Trusted operator recovery seam for a reclaim quarantine whose former
   * worker cannot send a provider-cancel acknowledgement. Callers must place
   * their own authenticated/operator authorization in front of this method.
   * It is deliberately not invoked from expiry or startup paths.
   */
  recoverReclaimQuarantineForOperator(): boolean {
    // A storage/policy failure is operationally distinct from the benign
    // no-quarantine case. Surface it to the authenticated host boundary so it
    // can fail closed instead of falsely acknowledging recovery.
    return this.transaction((connection) => {
      const health = connection.get<StoredHealth>("SELECT drain_fence, owner_instance, heartbeat_expires_at, recovery_required FROM compiler_auto_admission_health WHERE singleton = 1");
      if (!health || health.recovery_required !== 1) return false;
      // The health row is the sole authority for deletion. The exact
      // fence+instance predicates make this unable to remove a replacement or
      // any unrelated live lease, even when an operator acts after a restart.
      connection.run("DELETE FROM compiler_auto_admission_health WHERE singleton = 1 AND drain_fence = ? AND owner_instance = ? AND recovery_required = 1", [health.drain_fence, health.owner_instance]);
      connection.run("DELETE FROM compiler_auto_admission_leases WHERE lease_token = ? AND owner_instance = ?", [health.drain_fence, health.owner_instance]);
      return true;
    });
  }

  private checkActive(fence: string): CompilerAutoAdmissionLeaseState {
    const now = this.currentTime();
    try {
      return this.transaction((connection) => {
        this.reclaimExpired(connection, now);
        const lease = connection.get<StoredLease>("SELECT lease_token, expires_at, deadline_at FROM compiler_auto_admission_leases WHERE lease_token = ?", [fence]);
        if (!lease || lease.expires_at <= now || lease.deadline_at <= now) return { status: "refused", code: "AUTO_ADMISSION_LEASE_EXPIRED", retryAfterSeconds: 1 };
        return { status: "active", fence, expiresAt: lease.expires_at, deadlineAt: lease.deadline_at };
      });
    } catch (error) {
      const failure = asFailure(error);
      return { status: "refused", code: failure.code, retryAfterSeconds: failure.code === "AUTO_ADMISSION_BUSY" ? 1 : STABLE_RETRY_AFTER_SECONDS };
    }
  }

  private renew(fence: string): CompilerAutoAdmissionLeaseState {
    const now = this.currentTime();
    try {
      return this.transaction((connection) => {
        const health = connection.get<StoredHealth>("SELECT drain_fence, owner_instance, heartbeat_expires_at, recovery_required FROM compiler_auto_admission_health WHERE singleton = 1");
        if (health && health.drain_fence === fence && health.owner_instance === this.instanceToken) {
          return { status: "refused", code: "AUTO_ADMISSION_LEASE_EXPIRED", retryAfterSeconds: 1 };
        }
        const lease = connection.get<StoredLease>("SELECT lease_token, expires_at, deadline_at FROM compiler_auto_admission_leases WHERE lease_token = ?", [fence]);
        if (!lease) {
          this.reclaimExpired(connection, now);
          return { status: "refused", code: "AUTO_ADMISSION_LEASE_EXPIRED", retryAfterSeconds: 1 };
        }
        if (lease.expires_at <= now) return { status: "refused", code: "AUTO_ADMISSION_LEASE_EXPIRED", retryAfterSeconds: 1 };
        // BEGIN IMMEDIATE prevents a live exact fence from racing a different
        // holder. Never garbage-collect another expired holder here: expiry is
        // not proof that its provider call has stopped. Only acquire may turn
        // it into a persistent reclaim quarantine.
        connection.run("DELETE FROM compiler_auto_admission_starts WHERE started_at <= ?", [now - this.policy.window_ms]);
        const expiresAt = now + this.policy.lease_ttl_ms;
        connection.run("UPDATE compiler_auto_admission_leases SET expires_at = ? WHERE lease_token = ?", [expiresAt, fence]);
        return { status: "active", fence, expiresAt, deadlineAt: lease.deadline_at };
      });
    } catch (error) {
      const failure = asFailure(error);
      return { status: "refused", code: failure.code, retryAfterSeconds: failure.code === "AUTO_ADMISSION_BUSY" ? 1 : STABLE_RETRY_AFTER_SECONDS };
    }
  }

  private release(fence: string): boolean {
    const now = this.currentTime();
    try {
      return this.transaction((connection) => {
        this.reclaimExpired(connection, now);
        const health = connection.get<StoredHealth>("SELECT drain_fence, owner_instance, heartbeat_expires_at, recovery_required FROM compiler_auto_admission_health WHERE singleton = 1");
        // An exact former holder's release is its provider-settle
        // acknowledgement. It is the one automatic way to clear a permanent
        // reclaim quarantine; a stranger's stale release cannot do so.
        if (health?.drain_fence === fence && health.owner_instance === this.instanceToken) {
          connection.run("DELETE FROM compiler_auto_admission_health WHERE singleton = 1 AND drain_fence = ? AND owner_instance = ?", [fence, this.instanceToken]);
          connection.run("DELETE FROM compiler_auto_admission_leases WHERE lease_token = ? AND owner_instance = ?", [fence, this.instanceToken]);
          return true;
        }
        const owned = connection.get<StoredLease>("SELECT lease_token, owner_instance, expires_at, deadline_at FROM compiler_auto_admission_leases WHERE lease_token = ?", [fence]);
        if (!owned || owned.owner_instance !== this.instanceToken) return false;
        connection.run("DELETE FROM compiler_auto_admission_leases WHERE lease_token = ? AND owner_instance = ?", [fence, this.instanceToken]);
        return true;
      });
    } catch {
      // Finally-block callers must never turn a cleanup problem into a second
      // response. A later TTL reclaim is the safe recovery path.
      return false;
    }
  }

  private quarantine(fence: string): CompilerAutoAdmissionQuarantineState {
    const now = this.currentTime();
    try {
      return this.transaction((connection) => {
        // Do not delete other expired holders here. They could still have an
        // unabortable physical provider call, so another acquire must first
        // persist their reclaim quarantine.
        connection.run("DELETE FROM compiler_auto_admission_starts WHERE started_at <= ?", [now - this.policy.window_ms]);
        const owned = connection.get<StoredLease>("SELECT lease_token, expires_at, deadline_at FROM compiler_auto_admission_leases WHERE lease_token = ?", [fence]);
        const health = connection.get<StoredHealth>("SELECT drain_fence, owner_instance, heartbeat_expires_at, recovery_required FROM compiler_auto_admission_health WHERE singleton = 1");
        if (health && health.recovery_required === 0 && health.heartbeat_expires_at <= now) {
          connection.run("DELETE FROM compiler_auto_admission_health WHERE singleton = 1 AND drain_fence = ? AND owner_instance = ? AND heartbeat_expires_at <= ?", [health.drain_fence, health.owner_instance, now]);
        }
        if (health && (health.recovery_required === 1 || health.heartbeat_expires_at > now) && (health.drain_fence !== fence || health.owner_instance !== this.instanceToken)) {
          return { status: "refused", code: "AUTO_ADMISSION_UNHEALTHY", retryAfterSeconds: STABLE_RETRY_AFTER_SECONDS };
        }
        const heartbeatExpiresAt = now + Math.max(this.policy.lease_ttl_ms, this.policy.hard_drain_ms);
        connection.run("INSERT INTO compiler_auto_admission_health (singleton, drain_fence, owner_instance, heartbeat_expires_at, quarantined_at, recovery_required) VALUES (1, ?, ?, ?, ?, 0) ON CONFLICT(singleton) DO UPDATE SET heartbeat_expires_at = excluded.heartbeat_expires_at, quarantined_at = excluded.quarantined_at", [fence, this.instanceToken, heartbeatExpiresAt, now]);
        // A worker that has already lost its fence must never publish or
        // release a replacement lease. It may still report its own live model
        // call as unhealthy, though: installing a fail-closed health gate is
        // the only safe action left when a previously trusted owner notices a
        // reclaim race. The exact fence remains the health-row owner, and it
        // cannot delete any replacement lease.
        if (owned) connection.run("DELETE FROM compiler_auto_admission_leases WHERE lease_token = ?", [fence]);
        return { status: "quarantined", fence };
      });
    } catch (error) {
      const failure = asFailure(error);
      return { status: "refused", code: failure.code, retryAfterSeconds: failure.code === "AUTO_ADMISSION_BUSY" ? 1 : STABLE_RETRY_AFTER_SECONDS };
    }
  }

  private renewQuarantine(fence: string): CompilerAutoAdmissionQuarantineState {
    const now = this.currentTime();
    try {
      return this.transaction((connection) => {
        const health = connection.get<StoredHealth>("SELECT drain_fence, owner_instance, heartbeat_expires_at FROM compiler_auto_admission_health WHERE singleton = 1");
        if (!health || health.heartbeat_expires_at <= now || health.drain_fence !== fence || health.owner_instance !== this.instanceToken) {
          return { status: "refused", code: "AUTO_ADMISSION_LEASE_EXPIRED", retryAfterSeconds: 1 };
        }
        const heartbeatExpiresAt = now + Math.max(this.policy.lease_ttl_ms, this.policy.hard_drain_ms);
        connection.run("UPDATE compiler_auto_admission_health SET heartbeat_expires_at = ? WHERE singleton = 1 AND drain_fence = ? AND owner_instance = ?", [heartbeatExpiresAt, fence, this.instanceToken]);
        return { status: "quarantined", fence };
      });
    } catch (error) {
      const failure = asFailure(error);
      return { status: "refused", code: failure.code, retryAfterSeconds: failure.code === "AUTO_ADMISSION_BUSY" ? 1 : STABLE_RETRY_AFTER_SECONDS };
    }
  }

  private clearQuarantine(fence: string): boolean {
    const now = this.currentTime();
    try {
      return this.transaction((connection) => {
        this.reclaimExpired(connection, now);
        const health = connection.get<StoredHealth>("SELECT drain_fence, owner_instance, heartbeat_expires_at, recovery_required FROM compiler_auto_admission_health WHERE singleton = 1");
        if (!health || health.drain_fence !== fence || health.owner_instance !== this.instanceToken) return false;
        connection.run("DELETE FROM compiler_auto_admission_health WHERE singleton = 1 AND drain_fence = ? AND owner_instance = ?", [fence, this.instanceToken]);
        connection.run("DELETE FROM compiler_auto_admission_leases WHERE lease_token = ? AND owner_instance = ?", [fence, this.instanceToken]);
        return true;
      });
    } catch {
      return false;
    }
  }

  private withActiveFence<T>(fence: string, operation: () => T): CompilerAutoAdmissionFenceResult<T> {
    const now = this.currentTime();
    let completed = false;
    let operationValue: T | undefined;
    try {
      return this.transaction((connection) => {
        // Do not silently reclaim other expired holders while publishing.
        // Their physical provider work is unknown until its exact owner
        // settles or an authenticated operator performs recovery.
        connection.run("DELETE FROM compiler_auto_admission_starts WHERE started_at <= ?", [now - this.policy.window_ms]);
        const lease = connection.get<StoredLease>("SELECT lease_token, expires_at, deadline_at FROM compiler_auto_admission_leases WHERE lease_token = ?", [fence]);
        if (!lease || lease.expires_at <= now || lease.deadline_at <= now) {
          if (lease && lease.expires_at <= now) connection.run("DELETE FROM compiler_auto_admission_leases WHERE lease_token = ?", [fence]);
          return { status: "refused", code: "AUTO_ADMISSION_LEASE_EXPIRED", retryAfterSeconds: 1 };
        }
        // The admission transaction stays open across the synchronous catalog
        // publication. A second process cannot reclaim this fence in the gap
        // between authorization and catalog save; all such paths lock A → C.
        connection.run("UPDATE compiler_auto_admission_leases SET expires_at = ? WHERE lease_token = ?", [now + this.policy.lease_ttl_ms, fence]);
        const value = operation();
        operationValue = value;
        completed = true;
        // Catalog publication is synchronous. Refresh once more before the A
        // transaction commits so a long synchronous fsync cannot immediately
        // expose the just-published continuation to a TTL reclaim.
        const completedAt = this.currentTime();
        connection.run("UPDATE compiler_auto_admission_leases SET expires_at = ? WHERE lease_token = ?", [completedAt + this.policy.lease_ttl_ms, fence]);
        return { status: "executed", value };
      });
    } catch (error) {
      const failure = asFailure(error);
      if (failure.code === "AUTO_ADMISSION_INDETERMINATE") {
        return {
          status: "indeterminate",
          code: failure.code,
          retryAfterSeconds: STABLE_RETRY_AFTER_SECONDS,
          ...(completed ? { value: operationValue as T } : {}),
        };
      }
      return { status: "refused", code: failure.code, retryAfterSeconds: failure.code === "AUTO_ADMISSION_BUSY" ? 1 : STABLE_RETRY_AFTER_SECONDS };
    }
  }

  private refused(code: CompilerAutoAdmissionFailureCode, retryAfterSecondsValue: number): Extract<CompilerAutoAdmissionResult, { status: "refused" }> {
    return { status: "refused", code, retryAfterSeconds: retryAfterSecondsValue };
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("compiler automatic admission clock returned an invalid time");
    return value;
  }

  private transaction<T>(body: (connection: AdmissionConnection) => T): T {
    const connection = this.open();
    let begun = false;
    let committed = false;
    let failure: unknown;
    try {
      connection.run("BEGIN IMMEDIATE");
      begun = true;
      this.initializePolicy(connection);
      const result = body(connection);
      try {
        connection.run("COMMIT");
        committed = true;
        begun = false;
      } catch {
        // SQLite may have committed even if the acknowledgement path failed.
        // No caller may classify this as an ordinary pre-commit storage error.
        throw new CompilerAutoAdmissionFailure("AUTO_ADMISSION_INDETERMINATE", "automatic compiler admission commit outcome is indeterminate");
      }
      return result;
    } catch (error) {
      failure = error;
      if (begun) {
        try { connection.run("ROLLBACK"); } catch { /* close still releases the OS lock */ }
      }
      throw error;
    } finally {
      try {
        connection.close(true);
      } catch (closeError) {
        // Once COMMIT acknowledged, a local close failure cannot undo durable
        // state. Preserve the committed result rather than falsely returning
        // an unavailable admission after a lease/continuation already exists.
        if (!committed && failure === undefined) throw asFailure(closeError);
      }
    }
  }

  private initializePolicy(connection: AdmissionConnection): void {
    connection.run("CREATE TABLE IF NOT EXISTS compiler_auto_admission_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL, policy_identity TEXT NOT NULL, global_concurrent INTEGER NOT NULL, per_principal_concurrent INTEGER NOT NULL, starts_per_principal INTEGER NOT NULL, window_ms INTEGER NOT NULL, max_tracked_principals INTEGER NOT NULL, lease_ttl_ms INTEGER NOT NULL, whole_job_deadline_ms INTEGER NOT NULL, hard_drain_ms INTEGER NOT NULL)");
    connection.run("CREATE TABLE IF NOT EXISTS compiler_auto_admission_leases (lease_token TEXT PRIMARY KEY, owner_instance TEXT NOT NULL, principal_fingerprint TEXT NOT NULL, resource_hash TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL)");
    connection.run("CREATE TABLE IF NOT EXISTS compiler_auto_admission_health (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), drain_fence TEXT NOT NULL, owner_instance TEXT NOT NULL, heartbeat_expires_at INTEGER NOT NULL, quarantined_at INTEGER NOT NULL, recovery_required INTEGER NOT NULL CHECK (recovery_required IN (0, 1)))");
    connection.run("CREATE INDEX IF NOT EXISTS compiler_auto_admission_leases_resource ON compiler_auto_admission_leases(resource_hash)");
    connection.run("CREATE INDEX IF NOT EXISTS compiler_auto_admission_leases_principal ON compiler_auto_admission_leases(principal_fingerprint)");
    connection.run("CREATE TABLE IF NOT EXISTS compiler_auto_admission_starts (start_token TEXT PRIMARY KEY, principal_fingerprint TEXT NOT NULL, started_at INTEGER NOT NULL)");
    connection.run("CREATE INDEX IF NOT EXISTS compiler_auto_admission_starts_principal ON compiler_auto_admission_starts(principal_fingerprint, started_at)");
    const stored = connection.get<StoredPolicy>("SELECT schema_version, coordinator_domain, policy_identity, global_concurrent, per_principal_concurrent, starts_per_principal, window_ms, max_tracked_principals, lease_ttl_ms, whole_job_deadline_ms, hard_drain_ms FROM compiler_auto_admission_policy WHERE singleton = 1");
    if (!stored) {
      connection.run("INSERT INTO compiler_auto_admission_policy (singleton, schema_version, coordinator_domain, policy_identity, global_concurrent, per_principal_concurrent, starts_per_principal, window_ms, max_tracked_principals, lease_ttl_ms, whole_job_deadline_ms, hard_drain_ms) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [this.policy.schema_version, this.policy.coordinator_domain, this.policy.policy_identity, this.policy.global_concurrent, this.policy.per_principal_concurrent, this.policy.starts_per_principal, this.policy.window_ms, this.policy.max_tracked_principals, this.policy.lease_ttl_ms, this.policy.whole_job_deadline_ms, this.policy.hard_drain_ms]);
      return;
    }
    if (stored.schema_version !== this.policy.schema_version
      || stored.coordinator_domain !== this.policy.coordinator_domain
      || stored.policy_identity !== this.policy.policy_identity
      || stored.global_concurrent !== this.policy.global_concurrent
      || stored.per_principal_concurrent !== this.policy.per_principal_concurrent
      || stored.starts_per_principal !== this.policy.starts_per_principal
      || stored.window_ms !== this.policy.window_ms
      || stored.max_tracked_principals !== this.policy.max_tracked_principals
      || stored.lease_ttl_ms !== this.policy.lease_ttl_ms
      || stored.whole_job_deadline_ms !== this.policy.whole_job_deadline_ms
      || stored.hard_drain_ms !== this.policy.hard_drain_ms) {
      throw new CompilerAutoAdmissionFailure("AUTO_ADMISSION_POLICY_MISMATCH", "automatic compiler admission policy differs from this process configuration");
    }
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` validates neither old columns nor side-table
   * shape. Prepare the exact auxiliary reads used by live admission while the
   * startup transaction still holds the same durable policy barrier. `WHERE
   * 0` deliberately makes this a no-observation, no-mutation schema probe.
   */
  private probeAuxiliarySchema(connection: AdmissionConnection): void {
    connection.get<StoredLease>("SELECT lease_token, owner_instance, principal_fingerprint, resource_hash, acquired_at, expires_at, deadline_at FROM compiler_auto_admission_leases WHERE 0");
    connection.get<StoredHealth>("SELECT drain_fence, owner_instance, heartbeat_expires_at, quarantined_at, recovery_required FROM compiler_auto_admission_health WHERE 0");
    connection.get<{ start_token: string; principal_fingerprint: string; started_at: number }>("SELECT start_token, principal_fingerprint, started_at FROM compiler_auto_admission_starts WHERE 0");
  }

  private installReclaimQuarantine(connection: AdmissionConnection, expired: StoredLease, now: number): void {
    const health = connection.get<StoredHealth>("SELECT drain_fence, owner_instance, heartbeat_expires_at, recovery_required FROM compiler_auto_admission_health WHERE singleton = 1");
    if (health) return;
    // Do not delete the expired lease here. Its owner may still be alive and
    // will observe this exact persistent fence on the next heartbeat, abort
    // its transport, and clear the row only once the provider call settles.
    connection.run("INSERT INTO compiler_auto_admission_health (singleton, drain_fence, owner_instance, heartbeat_expires_at, quarantined_at, recovery_required) VALUES (1, ?, ?, ?, ?, 1)", [expired.lease_token, expired.owner_instance, now, now]);
  }

  private reclaimExpired(connection: AdmissionConnection, now: number): void {
    // Lease expiry is not ownership evidence: deleting it would let another
    // process start model work while the original process still has a live
    // provider request. `acquire` converts it into reclaim quarantine first.
    connection.run("DELETE FROM compiler_auto_admission_starts WHERE started_at <= ?", [now - this.policy.window_ms]);
  }

  private principalIsTracked(connection: AdmissionConnection, principalFingerprint: string): boolean {
    return !!connection.get<{ principal_fingerprint: string }>("SELECT principal_fingerprint FROM (SELECT principal_fingerprint FROM compiler_auto_admission_starts UNION SELECT principal_fingerprint FROM compiler_auto_admission_leases) WHERE principal_fingerprint = ? LIMIT 1", [principalFingerprint]);
  }

  private capacityRetryAfter(connection: AdmissionConnection, now: number): number {
    const rows = connection.all<CapacityRow>("SELECT MAX(available_at) AS available_at FROM (SELECT principal_fingerprint, started_at + ? AS available_at FROM compiler_auto_admission_starts UNION ALL SELECT principal_fingerprint, expires_at AS available_at FROM compiler_auto_admission_leases) GROUP BY principal_fingerprint", [this.policy.window_ms]);
    const earliest = rows.map((row) => row.available_at).filter((value) => Number.isSafeInteger(value)).reduce<number | undefined>((minimum, value) => minimum === undefined ? value : Math.min(minimum, value), undefined);
    return earliest === undefined ? 1 : retryAfterSeconds(earliest - now);
  }

  private open(): AdmissionConnection {
    let connection: AdmissionConnection | undefined;
    try {
      this.assertSafeDatabasePaths();
      connection = this.connectionFactory(this.file, COMPILER_AUTO_ADMISSION_SQLITE_OPEN_FLAGS);
      this.configureConnection(connection);
      this.assertSafeDatabasePaths();
      return connection;
    } catch (error) {
      if (connection) {
        try { connection.close(true); } catch { /* original open failure is authoritative */ }
      }
      throw asFailure(error);
    }
  }

  private assertSafeDatabasePaths(): void {
    if (this.pathOps.kind(this.root) !== "directory") throw new CompilerAutoAdmissionFailure("AUTO_ADMISSION_STORAGE_UNAVAILABLE", "automatic compiler admission root is not a real directory");
    for (const path of [this.file, `${this.file}-journal`, `${this.file}-wal`, `${this.file}-shm`]) {
      const kind = this.pathOps.kind(path);
      if (kind !== "missing" && kind !== "regular") throw new CompilerAutoAdmissionFailure("AUTO_ADMISSION_STORAGE_UNAVAILABLE", "automatic compiler admission SQLite file or sidecar is not a regular non-link file");
    }
  }

  private configureConnection(connection: AdmissionConnection): void {
    connection.run("PRAGMA journal_mode = DELETE");
    connection.run("PRAGMA synchronous = FULL");
    connection.run("PRAGMA locking_mode = NORMAL");
    connection.run("PRAGMA busy_timeout = 0");
    const journal = String(connection.pragma("journal_mode") ?? "").toLowerCase();
    const synchronous = connection.pragma("synchronous");
    const locking = String(connection.pragma("locking_mode") ?? "").toLowerCase();
    const timeout = connection.pragma("busy_timeout");
    if (journal !== "delete" || !(synchronous === 2 || String(synchronous).toLowerCase() === "full") || locking !== "normal" || timeout !== 0) {
      throw new CompilerAutoAdmissionFailure("AUTO_ADMISSION_STORAGE_UNAVAILABLE", "automatic compiler admission SQLite durability or locking pragma could not be verified");
    }
  }
}
