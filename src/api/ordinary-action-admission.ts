import { randomBytes } from "crypto";
import { Database, constants } from "bun:sqlite";
import { lstatSync } from "fs";
import { join, resolve } from "path";

export const ORDINARY_ACTION_ADMISSION_SCHEMA_VERSION = "1.0.0";
export const ORDINARY_ACTION_ADMISSION_DOMAIN = "ordinary-action-execution-admission";
/** The only server runtime file that may coordinate ordinary durable actions. */
export const ORDINARY_ACTION_ADMISSION_FILE_NAME = ".ordinary-action-admission.sqlite";
export const ORDINARY_ACTION_ADMISSION_SQLITE_OPEN_FLAGS = constants.SQLITE_OPEN_READWRITE
  | constants.SQLITE_OPEN_CREATE
  | constants.SQLITE_OPEN_NOFOLLOW
  | constants.SQLITE_OPEN_FULLMUTEX
  | constants.SQLITE_OPEN_EXRESCODE;

const DEFAULT_LEASE_TTL_MS = 60_000;
// Lets a fresh competing process observe the first committed lease instead of
// returning before SQLite has finished its short bootstrap transaction.
const DEFAULT_ORDINARY_ACTION_ADMISSION_BUSY_TIMEOUT_MS = 25;
const STABLE_QUARANTINE_RETRY_SECONDS = 60;
/** A transient pre-outcome SQLite BUSY COMMIT keeps its transaction active.
 * Retry the same COMMIT once; a persistent lock remains a normal refusal. */
const ORDINARY_ACTION_ADMISSION_COMMIT_BUSY_RETRY_ATTEMPTS = 1;

type SqlBinding = string | number;

export type OrdinaryActionAdmissionFailureCode =
  | "ORDINARY_ACTION_BUSY"
  | "ORDINARY_ACTION_QUARANTINED"
  | "ORDINARY_ACTION_LEASE_EXPIRED"
  | "ORDINARY_ACTION_POLICY_MISMATCH"
  | "ORDINARY_ACTION_STORAGE_UNAVAILABLE"
  | "ORDINARY_ACTION_INDETERMINATE";

export type OrdinaryActionAdmissionLeaseState =
  | { status: "active"; fence: string; expiresAt: number }
  | { status: "refused"; code: OrdinaryActionAdmissionFailureCode; retryAfterSeconds: number }
  | { status: "indeterminate"; code: "ORDINARY_ACTION_INDETERMINATE"; retryAfterSeconds: number };

export type OrdinaryActionAdmissionFenceResult<T> =
  | { status: "executed"; value: T }
  | { status: "indeterminate"; code: "ORDINARY_ACTION_INDETERMINATE"; retryAfterSeconds: number; value?: T }
  | Extract<OrdinaryActionAdmissionLeaseState, { status: "refused" }>;

export type OrdinaryActionAdmissionResult =
  | {
    status: "acquired";
    /** Cryptographically random capability. It must never cross the HTTP boundary. */
    fence: string;
    expiresAt: number;
    renewalIntervalMs: number;
    renew: () => OrdinaryActionAdmissionLeaseState;
    /** Holds the admission SQLite write lock across the synchronous publication. */
    withActiveFence: <T>(operation: () => T) => OrdinaryActionAdmissionFenceResult<T>;
    /** Stops new provider entrants without pretending an uncertain call settled. */
    quarantine: () => void;
    /** Removes only this exact process/fence/binding, including its quarantine. */
    release: () => void;
  }
  | Extract<OrdinaryActionAdmissionLeaseState, { status: "refused" | "indeterminate" }>;

export type OrdinaryActionAdmissionRecoveryResult =
  | { status: "recovered"; sessionId: string }
  | { status: "absent"; sessionId: string }
  | { status: "refused"; code: "ORDINARY_ACTION_BUSY" | "ORDINARY_ACTION_POLICY_MISMATCH" | "ORDINARY_ACTION_STORAGE_UNAVAILABLE"; retryAfterSeconds: number }
  | { status: "indeterminate"; code: "ORDINARY_ACTION_INDETERMINATE"; retryAfterSeconds: number };

/**
 * Ordinary action recovery has an additional, deliberately non-destructive
 * first phase. It persists quarantine for an expired active lease; only a
 * later operator transaction is permitted to delete that evidence.
 */
export type OrdinaryActionAdmissionOperatorRecoveryResult = OrdinaryActionAdmissionRecoveryResult
  | { status: "quarantined"; sessionId: string };

export interface OrdinaryActionAdmissionConfig {
  leaseTtlMs?: number;
  now?: () => number;
}

interface AdmissionConnection {
  run(sql: string, bindings?: readonly SqlBinding[]): void;
  get<T>(sql: string, bindings?: readonly SqlBinding[]): T | undefined;
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown;
  close(throwOnError: true): void;
}

export interface OrdinaryActionAdmissionPathOps {
  kind(path: string): "missing" | "regular" | "directory" | "unsafe";
}

export interface OrdinaryActionAdmissionOptions {
  connectionFactory?: (file: string, flags: number) => AdmissionConnection;
  pathOps?: OrdinaryActionAdmissionPathOps;
  fileName?: string;
  schemaVersion?: string;
  /** Distinct durable coordination domains must never silently share policy. */
  coordinatorDomain?: string;
  /** Ordinary execution historically exposes initial SQLite contention as busy. */
  contentionAsBusy?: boolean;
  /** SQLite's bounded wait for an already-running admission transaction.
   * The ordinary default is deliberately short; callers can explicitly
   * request zero for immediate handling. */
  busyTimeoutMs?: number;
}

interface StoredPolicy {
  schema_version: string;
  coordinator_domain: string;
  lease_ttl_ms: number;
}

interface StoredLease {
  session_id: string;
  expected_generation: number;
  action_id: string;
  request_hash: string;
  fence: string;
  owner_instance: string;
  state: "active" | "quarantined";
  expires_at_ms: number;
}

interface LeaseBinding {
  sessionId: string;
  expectedGeneration: number;
  actionId: string;
  requestHash: string;
}

class OrdinaryActionAdmissionFailure extends Error {
  constructor(readonly code: Exclude<OrdinaryActionAdmissionFailureCode, "ORDINARY_ACTION_BUSY" | "ORDINARY_ACTION_QUARANTINED" | "ORDINARY_ACTION_LEASE_EXPIRED">, message: string) {
    super(message);
  }
}

const nodePathOps: OrdinaryActionAdmissionPathOps = {
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
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown {
    const row = this.database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : undefined;
  }
  close(throwOnError: true): void { this.database.close(throwOnError); }
}

function bunConnectionFactory(file: string, flags: number): AdmissionConnection {
  return new BunAdmissionConnection(new Database(file, flags));
}

function asFailure(error: unknown): OrdinaryActionAdmissionFailure {
  if (error instanceof OrdinaryActionAdmissionFailure) return error;
  const message = error instanceof Error ? error.message : "ordinary action admission SQLite coordination failed";
  if (/no such column|has no column|no such table|malformed database schema/i.test(message)) {
    return new OrdinaryActionAdmissionFailure("ORDINARY_ACTION_POLICY_MISMATCH", "ordinary action admission schema is incompatible");
  }
  if (isSqliteContention(error)) {
    return new OrdinaryActionAdmissionFailure("ORDINARY_ACTION_STORAGE_UNAVAILABLE", "ordinary action admission is temporarily busy");
  }
  return new OrdinaryActionAdmissionFailure("ORDINARY_ACTION_STORAGE_UNAVAILABLE", message);
}

function isSqliteContention(error: unknown): boolean {
  const record = error as { code?: string } | undefined;
  const message = error instanceof Error ? error.message : "";
  const code = record?.code;
  return (typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z0-9_]+)?$/.test(code))
    || /SQLITE_(?:BUSY|LOCKED)(?:_[A-Z0-9_]+)?|database(?:\s+(?:schema|table))? is locked|database is busy|admission is temporarily busy/i.test(message);
}

/** SQLite documents a failed BUSY COMMIT as still-active, so rollback is safe.
 * LOCKED and message-only errors do not carry that same outcome guarantee. */
function isRetryableSqliteCommitBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^SQLITE_BUSY(?:_[A-Z0-9_]+)?$/.test(code);
}

/**
 * Durable single-generation execution admission for ordinary actions.
 *
 * Lease expiry is deliberately not takeover authority. A contender that sees
 * an expired row converts that exact row to quarantine, because its former
 * process may still have an in-flight model request. Only the exact holder's
 * settle/release acknowledgement, or future authenticated operator recovery,
 * may clear it.
 */
export class OrdinaryActionAdmissionCoordinator {
  readonly root: string;
  readonly file: string;
  private readonly leaseTtlMs: number;
  private readonly now: () => number;
  private readonly schemaVersion: string;
  private readonly coordinatorDomain: string;
  private readonly contentionAsBusy: boolean;
  private readonly busyTimeoutMs: number;
  private readonly instanceToken = randomBytes(32).toString("hex");
  private readonly pathOps: OrdinaryActionAdmissionPathOps;
  private readonly connectionFactory: (file: string, flags: number) => AdmissionConnection;

  constructor(root: string, config: OrdinaryActionAdmissionConfig = {}, options: OrdinaryActionAdmissionOptions = {}) {
    if (typeof root !== "string" || !root.trim()) throw new Error("ordinary action admission requires a durable root");
    const leaseTtlMs = config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0 || (config.now !== undefined && typeof config.now !== "function")) {
      throw new Error("invalid ordinary action admission configuration");
    }
    const schemaVersion = options.schemaVersion ?? ORDINARY_ACTION_ADMISSION_SCHEMA_VERSION;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/.test(schemaVersion)) throw new Error("invalid ordinary action admission schema version");
    const coordinatorDomain = options.coordinatorDomain ?? ORDINARY_ACTION_ADMISSION_DOMAIN;
    if (!/^[a-z][a-z0-9-]{2,127}$/.test(coordinatorDomain)) throw new Error("invalid ordinary action admission coordinator domain");
    const fileName = options.fileName ?? ORDINARY_ACTION_ADMISSION_FILE_NAME;
    if (!/^\.[A-Za-z0-9_-]{1,128}\.sqlite$/.test(fileName)) throw new Error("invalid ordinary action admission SQLite filename");
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_ORDINARY_ACTION_ADMISSION_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
      throw new Error("invalid ordinary action admission SQLite busy timeout");
    }
    this.root = resolve(root);
    this.file = join(this.root, fileName);
    this.leaseTtlMs = leaseTtlMs;
    this.now = config.now ?? Date.now;
    this.schemaVersion = schemaVersion;
    this.coordinatorDomain = coordinatorDomain;
    this.contentionAsBusy = options.contentionAsBusy ?? true;
    this.busyTimeoutMs = busyTimeoutMs;
    this.pathOps = options.pathOps ?? nodePathOps;
    this.connectionFactory = options.connectionFactory ?? bunConnectionFactory;
  }

  acquire(input: LeaseBinding): OrdinaryActionAdmissionResult {
    this.assertBinding(input);
    const now = this.clock();
    const fence = randomBytes(32).toString("hex");
    try {
      return this.transaction((connection) => {
        const existing = this.find(connection, input.sessionId);
        if (existing) {
          if (existing.state === "active" && existing.expires_at_ms <= now) {
            connection.run(
              "UPDATE ordinary_action_admission_leases SET state = 'quarantined', quarantined_at_ms = ? WHERE session_id = ? AND fence = ? AND state = 'active'",
              [now, existing.session_id, existing.fence],
            );
            return this.refused("ORDINARY_ACTION_QUARANTINED", STABLE_QUARANTINE_RETRY_SECONDS);
          }
          if (existing.state === "quarantined") return this.refused("ORDINARY_ACTION_QUARANTINED", STABLE_QUARANTINE_RETRY_SECONDS);
          return this.refused("ORDINARY_ACTION_BUSY", 1);
        }
        const expiresAt = now + this.leaseTtlMs;
        connection.run(
          "INSERT INTO ordinary_action_admission_leases (session_id, expected_generation, action_id, request_hash, fence, owner_instance, state, acquired_at_ms, expires_at_ms, quarantined_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)",
          [input.sessionId, input.expectedGeneration, input.actionId, input.requestHash, fence, this.instanceToken, now, expiresAt],
        );
        return {
          status: "acquired" as const,
          fence,
          expiresAt,
          renewalIntervalMs: Math.max(1, Math.floor(this.leaseTtlMs / 2)),
          renew: () => this.renew(input, fence),
          withActiveFence: <T>(operation: () => T) => this.withActiveFence(input, fence, operation),
          quarantine: () => { this.quarantine(input, fence); },
          release: () => { this.release(input, fence); },
        };
      });
    } catch (error) {
      const failure = asFailure(error);
      // A contender that cannot obtain the initial write lock has not entered
      // the model/execution boundary. Ordinary execution retains its legacy
      // busy mapping; callers that must distinguish infrastructure uncertainty
      // (compiled intent) opt out. Renew/publication stays fail-closed below.
      if (failure.code === "ORDINARY_ACTION_STORAGE_UNAVAILABLE" && isSqliteContention(error)) {
        return this.refused(this.contentionAsBusy ? "ORDINARY_ACTION_BUSY" : "ORDINARY_ACTION_STORAGE_UNAVAILABLE", 1);
      }
      if (failure.code === "ORDINARY_ACTION_INDETERMINATE") {
        return { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
      }
      return this.refused(failure.code, failure.code === "ORDINARY_ACTION_STORAGE_UNAVAILABLE" ? 1 : STABLE_QUARANTINE_RETRY_SECONDS);
    }
  }

  /**
   * Explicit operator recovery after the old worker has been proven stopped.
   * The caller supplies only server-read durable generation; neither an HTTP
   * body nor an operator can select the fence/owner identity being removed.
   */
  recoverQuarantinedForOperator(input: { sessionId: string; currentGeneration: number }): OrdinaryActionAdmissionRecoveryResult {
    if (typeof input.sessionId !== "string" || !input.sessionId
      || !Number.isSafeInteger(input.currentGeneration) || input.currentGeneration < 0) {
      throw new Error("ordinary action admission recovery binding is invalid");
    }
    try {
      return this.transaction((connection) => {
        const row = this.find(connection, input.sessionId);
        if (!row) return { status: "absent" as const, sessionId: input.sessionId };
        // Expiry is never proof that a provider call has stopped. Recovery is
        // allowed to delete only a quarantine persisted by an earlier,
        // independent acquire/renew observation; it cannot create-and-delete
        // that quarantine in one operator request.
        if (row.state === "active") {
          return { status: "refused" as const, code: "ORDINARY_ACTION_BUSY" as const, retryAfterSeconds: 1 };
        }
        if (row.expected_generation > input.currentGeneration) {
          return { status: "refused" as const, code: "ORDINARY_ACTION_POLICY_MISMATCH" as const, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
        }
        // Fence is read from durable state and included in the DELETE CAS.
        // The operator cannot name it, and an active/replaced row cannot match.
        connection.run(
          "DELETE FROM ordinary_action_admission_leases WHERE session_id = ? AND fence = ? AND state = 'quarantined'",
          [row.session_id, row.fence],
        );
        return { status: "recovered" as const, sessionId: input.sessionId };
      });
    } catch (error) {
      const failure = asFailure(error);
      if (failure.code === "ORDINARY_ACTION_INDETERMINATE") {
        return { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
      }
      return {
        status: "refused",
        code: failure.code === "ORDINARY_ACTION_POLICY_MISMATCH" ? failure.code : "ORDINARY_ACTION_STORAGE_UNAVAILABLE",
        retryAfterSeconds: failure.code === "ORDINARY_ACTION_STORAGE_UNAVAILABLE" ? 1 : STABLE_QUARANTINE_RETRY_SECONDS,
      };
    }
  }

  /**
   * A narrow compare-and-delete recovery for a caller that has independent
   * durable proof that no external work was dispatched. Unlike the operator
   * generation helper, every original lease binding is rechecked; it can never
   * delete a different action/request's quarantine in the same generation.
   */
  recoverQuarantinedExact(input: LeaseBinding): OrdinaryActionAdmissionRecoveryResult {
    this.assertBinding(input);
    try {
      return this.transaction((connection) => {
        const row = this.find(connection, input.sessionId);
        if (!row) return { status: "absent" as const, sessionId: input.sessionId };
        if (row.state === "active") return { status: "refused" as const, code: "ORDINARY_ACTION_BUSY" as const, retryAfterSeconds: 1 };
        if (row.expected_generation !== input.expectedGeneration || row.action_id !== input.actionId || row.request_hash !== input.requestHash) {
          return { status: "refused" as const, code: "ORDINARY_ACTION_POLICY_MISMATCH" as const, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
        }
        connection.run(
          "DELETE FROM ordinary_action_admission_leases WHERE session_id = ? AND fence = ? AND state = 'quarantined' AND expected_generation = ? AND action_id = ? AND request_hash = ?",
          [row.session_id, row.fence, input.expectedGeneration, input.actionId, input.requestHash],
        );
        if (!this.changedExactlyOnce(connection)) {
          return { status: "indeterminate" as const, code: "ORDINARY_ACTION_INDETERMINATE" as const, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
        }
        return { status: "recovered" as const, sessionId: input.sessionId };
      });
    } catch (error) {
      const failure = asFailure(error);
      if (failure.code === "ORDINARY_ACTION_INDETERMINATE") {
        return { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
      }
      return {
        status: "refused",
        code: failure.code === "ORDINARY_ACTION_POLICY_MISMATCH" ? failure.code : "ORDINARY_ACTION_STORAGE_UNAVAILABLE",
        retryAfterSeconds: failure.code === "ORDINARY_ACTION_STORAGE_UNAVAILABLE" ? 1 : STABLE_QUARANTINE_RETRY_SECONDS,
      };
    }
  }

  /**
   * Ordinary-action-only operator recovery.  Unlike the shared compiled
   * recovery primitive above, it may turn an exact expired active lease into
   * durable quarantine.  It never deletes that quarantine in the same call.
   *
   * A row from an older durable generation remains eligible: a successful
   * publication can advance the snapshot before an acknowledgement failure
   * leaves its old admission row behind.  A future row is contradictory to
   * the server-read generation and is never modified.  This deliberately
   * matches the <= generation rule for persisted quarantine recovery and
   * avoids manufacturing an unrecoverable stale active row.
   */
  recoverOrdinaryForOperator(input: { sessionId: string; currentGeneration: number }): OrdinaryActionAdmissionOperatorRecoveryResult {
    if (typeof input.sessionId !== "string" || !input.sessionId
      || !Number.isSafeInteger(input.currentGeneration) || input.currentGeneration < 0) {
      throw new Error("ordinary action admission recovery binding is invalid");
    }
    try {
      return this.transaction((connection) => {
        const row = this.find(connection, input.sessionId);
        if (!row) return { status: "absent" as const, sessionId: input.sessionId };
        // Verify the server-read binding before any CAS. A lease cannot name a
        // generation which authoritative durable state has not reached.
        if (row.expected_generation > input.currentGeneration) {
          return { status: "refused" as const, code: "ORDINARY_ACTION_POLICY_MISMATCH" as const, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
        }
        if (row.state === "quarantined") {
          connection.run(
            "DELETE FROM ordinary_action_admission_leases WHERE session_id = ? AND expected_generation = ? AND action_id = ? AND request_hash = ? AND fence = ? AND owner_instance = ? AND state = 'quarantined'",
            [row.session_id, row.expected_generation, row.action_id, row.request_hash, row.fence, row.owner_instance],
          );
          if (!this.changedExactlyOnce(connection)) {
            return { status: "indeterminate" as const, code: "ORDINARY_ACTION_INDETERMINATE" as const, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
          }
          return { status: "recovered" as const, sessionId: input.sessionId };
        }
        const now = this.clock();
        if (row.expires_at_ms > now) {
          return { status: "refused" as const, code: "ORDINARY_ACTION_BUSY" as const, retryAfterSeconds: 1 };
        }
        // Every stored binding component and expiry predicate participates in
        // the CAS. BEGIN IMMEDIATE serializes this against owner renewal and
        // publication; checking changes() keeps a missed CAS fail-closed.
        connection.run(
          "UPDATE ordinary_action_admission_leases SET state = 'quarantined', quarantined_at_ms = ? WHERE session_id = ? AND expected_generation = ? AND action_id = ? AND request_hash = ? AND fence = ? AND owner_instance = ? AND state = 'active' AND expires_at_ms <= ?",
          [now, row.session_id, row.expected_generation, row.action_id, row.request_hash, row.fence, row.owner_instance, now],
        );
        if (!this.changedExactlyOnce(connection)) {
          return { status: "indeterminate" as const, code: "ORDINARY_ACTION_INDETERMINATE" as const, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
        }
        return { status: "quarantined" as const, sessionId: input.sessionId };
      });
    } catch (error) {
      const failure = asFailure(error);
      if (failure.code === "ORDINARY_ACTION_INDETERMINATE") {
        return { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS };
      }
      return {
        status: "refused",
        code: failure.code === "ORDINARY_ACTION_POLICY_MISMATCH" ? failure.code : "ORDINARY_ACTION_STORAGE_UNAVAILABLE",
        retryAfterSeconds: failure.code === "ORDINARY_ACTION_STORAGE_UNAVAILABLE" ? 1 : STABLE_QUARANTINE_RETRY_SECONDS,
      };
    }
  }

  private renew(binding: LeaseBinding, fence: string): OrdinaryActionAdmissionLeaseState {
    const now = this.clock();
    try {
      return this.transaction((connection) => {
        const row = this.find(connection, binding.sessionId);
        if (!this.owns(row, binding, fence)) return this.refused("ORDINARY_ACTION_QUARANTINED", STABLE_QUARANTINE_RETRY_SECONDS);
        if (row.state !== "active") return this.refused("ORDINARY_ACTION_QUARANTINED", STABLE_QUARANTINE_RETRY_SECONDS);
        if (row.expires_at_ms <= now) {
          connection.run(
            "UPDATE ordinary_action_admission_leases SET state = 'quarantined', quarantined_at_ms = ? WHERE session_id = ? AND fence = ? AND owner_instance = ?",
            [now, binding.sessionId, fence, this.instanceToken],
          );
          return this.refused("ORDINARY_ACTION_LEASE_EXPIRED", STABLE_QUARANTINE_RETRY_SECONDS);
        }
        const expiresAt = now + this.leaseTtlMs;
        connection.run(
          "UPDATE ordinary_action_admission_leases SET expires_at_ms = ? WHERE session_id = ? AND fence = ? AND owner_instance = ? AND state = 'active'",
          [expiresAt, binding.sessionId, fence, this.instanceToken],
        );
        return { status: "active", fence, expiresAt };
      });
    } catch (error) {
      const failure = asFailure(error);
      return failure.code === "ORDINARY_ACTION_INDETERMINATE"
        ? { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS }
        : this.refused(failure.code, failure.code === "ORDINARY_ACTION_STORAGE_UNAVAILABLE" ? 1 : STABLE_QUARANTINE_RETRY_SECONDS);
    }
  }

  private withActiveFence<T>(binding: LeaseBinding, fence: string, operation: () => T): OrdinaryActionAdmissionFenceResult<T> {
    const now = this.clock();
    let completed = false; let value: T | undefined;
    try {
      return this.transaction((connection) => {
        const row = this.find(connection, binding.sessionId);
        if (!this.owns(row, binding, fence) || row.state !== "active") {
          return this.refused("ORDINARY_ACTION_QUARANTINED", STABLE_QUARANTINE_RETRY_SECONDS);
        }
        if (row.expires_at_ms <= now) {
          connection.run(
            "UPDATE ordinary_action_admission_leases SET state = 'quarantined', quarantined_at_ms = ? WHERE session_id = ? AND fence = ? AND owner_instance = ?",
            [now, binding.sessionId, fence, this.instanceToken],
          );
          return this.refused("ORDINARY_ACTION_LEASE_EXPIRED", STABLE_QUARANTINE_RETRY_SECONDS);
        }
        // Keep this BEGIN IMMEDIATE transaction open through namespace and
        // snapshot publication. No process can turn TTL into a replacement
        // fence between this exact check and the irreversible write.
        connection.run(
          "UPDATE ordinary_action_admission_leases SET expires_at_ms = ? WHERE session_id = ? AND fence = ? AND owner_instance = ? AND state = 'active'",
          [now + this.leaseTtlMs, binding.sessionId, fence, this.instanceToken],
        );
        value = operation(); completed = true;
        return { status: "executed" as const, value };
      });
    } catch (error) {
      const failure = asFailure(error);
      if (failure.code === "ORDINARY_ACTION_INDETERMINATE") {
        return { status: "indeterminate", code: failure.code, retryAfterSeconds: STABLE_QUARANTINE_RETRY_SECONDS, ...(completed ? { value: value as T } : {}) };
      }
      return this.refused(failure.code, failure.code === "ORDINARY_ACTION_STORAGE_UNAVAILABLE" ? 1 : STABLE_QUARANTINE_RETRY_SECONDS);
    }
  }

  private release(binding: LeaseBinding, fence: string): void {
    try {
      this.transaction((connection) => {
        connection.run(
          "DELETE FROM ordinary_action_admission_leases WHERE session_id = ? AND expected_generation = ? AND action_id = ? AND request_hash = ? AND fence = ? AND owner_instance = ?",
          [binding.sessionId, binding.expectedGeneration, binding.actionId, binding.requestHash, fence, this.instanceToken],
        );
      });
    } catch {
      // Failure to acknowledge settlement must remain fail-closed. The exact
      // row survives and its expiry becomes quarantine, never takeover.
    }
  }

  /**
   * Exact-owner quarantine is the conservative boundary for an aborted or
   * otherwise indeterminate provider call.  Failure deliberately leaves the
   * active row in place: expiry then converts it to quarantine on observation,
   * never to an automatic replacement lease.
   */
  private quarantine(binding: LeaseBinding, fence: string): void {
    try {
      this.transaction((connection) => {
        const row = this.find(connection, binding.sessionId);
        if (!this.owns(row, binding, fence) || row.state !== "active") return;
        connection.run(
          "UPDATE ordinary_action_admission_leases SET state = 'quarantined', quarantined_at_ms = ? WHERE session_id = ? AND expected_generation = ? AND action_id = ? AND request_hash = ? AND fence = ? AND owner_instance = ? AND state = 'active'",
          [this.clock(), binding.sessionId, binding.expectedGeneration, binding.actionId, binding.requestHash, fence, this.instanceToken],
        );
      });
    } catch {
      // Keep the old active lease as the safe fallback.  Do not release it.
    }
  }

  private owns(row: StoredLease | undefined, binding: LeaseBinding, fence: string): row is StoredLease {
    return !!row
      && row.expected_generation === binding.expectedGeneration
      && row.action_id === binding.actionId
      && row.request_hash === binding.requestHash
      && row.fence === fence
      && row.owner_instance === this.instanceToken;
  }

  private find(connection: AdmissionConnection, sessionId: string): StoredLease | undefined {
    return connection.get<StoredLease>(
      "SELECT session_id, expected_generation, action_id, request_hash, fence, owner_instance, state, expires_at_ms FROM ordinary_action_admission_leases WHERE session_id = ?",
      [sessionId],
    );
  }

  private changedExactlyOnce(connection: AdmissionConnection): boolean {
    return connection.get<{ changes: unknown }>("SELECT changes() AS changes")?.changes === 1;
  }

  private refused(code: Exclude<OrdinaryActionAdmissionFailureCode, "ORDINARY_ACTION_INDETERMINATE">, retryAfterSecondsValue: number): Extract<OrdinaryActionAdmissionLeaseState, { status: "refused" }> {
    return { status: "refused", code, retryAfterSeconds: retryAfterSecondsValue };
  }

  private assertBinding(input: LeaseBinding): void {
    if (typeof input.sessionId !== "string" || !input.sessionId
      || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0
      || typeof input.actionId !== "string" || !input.actionId
      || !/^[a-f0-9]{64}$/.test(input.requestHash)) {
      throw new Error("ordinary action admission binding is invalid");
    }
  }

  private clock(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("ordinary action admission clock returned an invalid time");
    return value;
  }

  private transaction<T>(body: (connection: AdmissionConnection) => T): T {
    const connection = this.open(); let begun = false; let committed = false; let failure: unknown;
    try {
      connection.run("BEGIN IMMEDIATE"); begun = true;
      this.initializePolicy(connection);
      const result = body(connection);
      for (let attempt = 0; ; attempt++) {
        try {
          connection.run("COMMIT"); committed = true; begun = false;
          break;
        } catch (error) {
          // SQLite documents a BUSY COMMIT as still active, so retry the same
          // COMMIT once on the same connection. A persistent busy error falls
          // through to the outer rollback and ordinary contention mapping.
          // LOCKED and all other errors (including an acknowledgement fault
          // after the write) remain indeterminate and fail closed.
          if (isRetryableSqliteCommitBusy(error) && attempt < ORDINARY_ACTION_ADMISSION_COMMIT_BUSY_RETRY_ATTEMPTS) continue;
          if (isRetryableSqliteCommitBusy(error)) throw error;
          throw new OrdinaryActionAdmissionFailure("ORDINARY_ACTION_INDETERMINATE", "ordinary action admission commit outcome is indeterminate");
        }
      }
      return result;
    } catch (error) {
      failure = error;
      if (begun) { try { connection.run("ROLLBACK"); } catch { /* close still releases the lock */ } }
      throw error;
    } finally {
      try { connection.close(true); }
      catch (closeError) { if (!committed && failure === undefined) throw asFailure(closeError); }
    }
  }

  private initializePolicy(connection: AdmissionConnection): void {
    connection.run("CREATE TABLE IF NOT EXISTS ordinary_action_admission_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL, lease_ttl_ms INTEGER NOT NULL)");
    connection.run("CREATE TABLE IF NOT EXISTS ordinary_action_admission_leases (session_id TEXT PRIMARY KEY, expected_generation INTEGER NOT NULL, action_id TEXT NOT NULL, request_hash TEXT NOT NULL, fence TEXT NOT NULL UNIQUE, owner_instance TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'quarantined')), acquired_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, quarantined_at_ms INTEGER)");
    const stored = connection.get<StoredPolicy>("SELECT schema_version, coordinator_domain, lease_ttl_ms FROM ordinary_action_admission_policy WHERE singleton = 1");
    if (!stored) {
      connection.run("INSERT INTO ordinary_action_admission_policy (singleton, schema_version, coordinator_domain, lease_ttl_ms) VALUES (1, ?, ?, ?)", [this.schemaVersion, this.coordinatorDomain, this.leaseTtlMs]);
      return;
    }
    if (stored.schema_version !== this.schemaVersion || stored.coordinator_domain !== this.coordinatorDomain || stored.lease_ttl_ms !== this.leaseTtlMs) {
      throw new OrdinaryActionAdmissionFailure("ORDINARY_ACTION_POLICY_MISMATCH", "ordinary action admission policy differs from this process configuration");
    }
  }

  private open(): AdmissionConnection {
    let connection: AdmissionConnection | undefined;
    try {
      this.assertSafeDatabasePaths();
      connection = this.connectionFactory(this.file, ORDINARY_ACTION_ADMISSION_SQLITE_OPEN_FLAGS);
      this.configureConnection(connection);
      this.assertSafeDatabasePaths();
      return connection;
    } catch (error) {
      if (connection) { try { connection.close(true); } catch { /* original failure is authoritative */ } }
      throw asFailure(error);
    }
  }

  private assertSafeDatabasePaths(): void {
    if (this.pathOps.kind(this.root) !== "directory") throw new OrdinaryActionAdmissionFailure("ORDINARY_ACTION_STORAGE_UNAVAILABLE", "ordinary action admission root is not a real directory");
    for (const path of [this.file, `${this.file}-journal`, `${this.file}-wal`, `${this.file}-shm`]) {
      const kind = this.pathOps.kind(path);
      if (kind !== "missing" && kind !== "regular") throw new OrdinaryActionAdmissionFailure("ORDINARY_ACTION_STORAGE_UNAVAILABLE", "ordinary action admission SQLite file or sidecar is not a regular non-link file");
    }
  }

  private configureConnection(connection: AdmissionConnection): void {
    // Set the bounded contention policy before a durability pragma can itself
    // need a database lock. It covers first-schema/bootstrap handoff before
    // any transaction begins.
    connection.run(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    connection.run("PRAGMA journal_mode = DELETE");
    connection.run("PRAGMA synchronous = FULL");
    connection.run("PRAGMA locking_mode = NORMAL");
    const journal = String(connection.pragma("journal_mode") ?? "").toLowerCase();
    const synchronous = connection.pragma("synchronous");
    const locking = String(connection.pragma("locking_mode") ?? "").toLowerCase();
    const timeout = connection.pragma("busy_timeout");
    if (journal !== "delete" || !(synchronous === 2 || String(synchronous).toLowerCase() === "full") || locking !== "normal" || timeout !== this.busyTimeoutMs) {
      throw new OrdinaryActionAdmissionFailure("ORDINARY_ACTION_STORAGE_UNAVAILABLE", "ordinary action admission SQLite durability or locking pragma could not be verified");
    }
  }
}
