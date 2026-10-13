import { createHash } from "crypto";
import { Database, constants } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import {
  OrdinaryActionAdmissionCoordinator,
  type OrdinaryActionAdmissionConfig,
  type OrdinaryActionAdmissionOptions,
  type OrdinaryActionAdmissionResult,
} from "./ordinary-action-admission";

/** A distinct durable lease domain for one provider-backed compiled narration
 * candidate. It deliberately reuses the audited physical SQLite lease
 * primitive instead of sharing intent-classification admission. */
export const COMPILED_NARRATION_ADMISSION_SCHEMA_VERSION = "1.0.0";
export const COMPILED_NARRATION_ADMISSION_DOMAIN = "compiled-player-narration-admission";

export class CompiledNarrationAdmissionCoordinator {
  readonly root: string;
  readonly file: string;
  private readonly delegate: OrdinaryActionAdmissionCoordinator;

  constructor(root: string, config: OrdinaryActionAdmissionConfig = {}, options: Pick<OrdinaryActionAdmissionOptions, "connectionFactory" | "pathOps"> = {}) {
    this.delegate = new OrdinaryActionAdmissionCoordinator(root, config, {
      ...options,
      fileName: ".compiled-narration-admission.sqlite",
      schemaVersion: COMPILED_NARRATION_ADMISSION_SCHEMA_VERSION,
      coordinatorDomain: COMPILED_NARRATION_ADMISSION_DOMAIN,
      contentionAsBusy: false,
      busyTimeoutMs: 1_000,
    });
    this.root = this.delegate.root;
    this.file = this.delegate.file;
  }

  private digest(values: readonly string[]): string {
    const hash = createHash("sha256");
    for (const value of values) {
      hash.update(`${value.length}:${value}|`);
    }
    return hash.digest("hex");
  }

  private binding(input: { sessionId: string; expectedGeneration: number; actionId: string; requestHash: string }) {
    return {
      sessionId: this.digest(["compiled-narration-admission-v1", input.sessionId, String(input.expectedGeneration)]),
      expectedGeneration: input.expectedGeneration,
      actionId: this.digest(["compiled-narration-admission-action-v1", input.actionId]),
      requestHash: input.requestHash,
    };
  }

  acquire(input: { sessionId: string; expectedGeneration: number; actionId: string; requestHash: string }): OrdinaryActionAdmissionResult {
    if (typeof input.sessionId !== "string" || !input.sessionId || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0
      || typeof input.actionId !== "string" || !input.actionId || !/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error("compiled narration admission binding is invalid");
    return this.delegate.acquire(this.binding(input));
  }

  /** Exact prepared-only recovery: the caller must have independently
   * validated the candidate and supply the same action/request binding. */
  recoverPrepared(input: { sessionId: string; expectedGeneration: number; actionId: string; requestHash: string }): boolean {
    if (typeof input.sessionId !== "string" || !input.sessionId || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0
      || typeof input.actionId !== "string" || !input.actionId || !/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error("compiled narration admission binding is invalid");
    const result = this.delegate.recoverQuarantinedExact(this.binding(input));
    return result.status === "recovered" || result.status === "absent";
  }

}

/**
 * A per-follow-up durable dispatch tombstone.  Unlike the ordinary lease it
 * is never deleted on success, so a same-generation `(session, actionId)`
 * cannot silently re-dispatch after a crash while another actionId remains
 * independent.
 */
export const COMPILED_PLAYER_FOLLOWUP_ADMISSION_SCHEMA_VERSION = "1.0.0";
export const COMPILED_PLAYER_FOLLOWUP_ADMISSION_DOMAIN = "compiled-player-followup-admission";
type FollowupAdmissionState = "dispatching" | "settled" | "quarantined";
export interface CompiledPlayerFollowupAdmissionRecord {
  sessionId: string;
  actionId: string;
  expectedGeneration: number;
  requestHash: string;
  dispatchMac: string;
  receiptHash?: string;
  receiptMac?: string;
}

export class CompiledPlayerFollowupAdmissionCoordinator {
  readonly root: string;
  readonly file: string;
  constructor(root: string) {
    this.root = resolve(root);
    this.file = join(this.root, ".compiled-player-followup-admission.sqlite");
  }

  read(sessionId: string, actionId: string): { status: "absent" } | { status: "ok"; value: CompiledPlayerFollowupAdmissionRecord & { state: FollowupAdmissionState } } | { status: "refused" } {
    try { return this.transaction((db) => this.readIn(db, sessionId, actionId) ?? { status: "absent" }); }
    catch { return { status: "refused" }; }
  }

  begin(input: CompiledPlayerFollowupAdmissionRecord): "acquired" | "existing" | "refused" {
    if (!validAdmission(input) || input.receiptHash !== undefined || input.receiptMac !== undefined) return "refused";
    try {
      return this.transaction((db) => {
        const existing = this.readIn(db, input.sessionId, input.actionId);
        if (existing) return existing.status === "ok" && sameAdmission(existing.value, input) ? "existing" : "refused";
        db.run("INSERT INTO compiled_player_followup_admission_records (session_id, action_id, expected_generation, request_hash, dispatch_mac, state, receipt_hash, receipt_mac) VALUES (?, ?, ?, ?, ?, 'dispatching', NULL, NULL)", [input.sessionId, input.actionId, input.expectedGeneration, input.requestHash, input.dispatchMac]);
        return "acquired";
      });
    } catch { return "refused"; }
  }

  settle(input: CompiledPlayerFollowupAdmissionRecord): "settled" | "existing" | "refused" {
    if (!validAdmission(input) || !input.receiptHash || !input.receiptMac) return "refused";
    try {
      return this.transaction((db) => {
        const existing = this.readIn(db, input.sessionId, input.actionId);
        if (!existing || existing.status !== "ok" || !sameAdmission(existing.value, input, false)) return "refused";
        if (existing.value.state === "settled") return existing.value.receiptHash === input.receiptHash && existing.value.receiptMac === input.receiptMac ? "existing" : "refused";
        if (existing.value.state !== "dispatching") return "refused";
        db.run("UPDATE compiled_player_followup_admission_records SET state = 'settled', receipt_hash = ?, receipt_mac = ? WHERE session_id = ? AND action_id = ? AND state = 'dispatching'", [input.receiptHash!, input.receiptMac!, input.sessionId, input.actionId]);
        return "settled";
      });
    } catch { return "refused"; }
  }

  quarantine(sessionId: string, actionId: string): void {
    try { this.transaction((db) => { db.run("UPDATE compiled_player_followup_admission_records SET state = 'quarantined' WHERE session_id = ? AND action_id = ? AND state = 'dispatching'", [sessionId, actionId]); }); } catch { /* unknown provider outcome remains fenced */ }
  }

  private readIn(db: Database, sessionId: string, actionId: string): { status: "ok"; value: CompiledPlayerFollowupAdmissionRecord & { state: FollowupAdmissionState } } | { status: "refused" } | undefined {
    const row = db.query("SELECT session_id, action_id, expected_generation, request_hash, dispatch_mac, state, receipt_hash, receipt_mac FROM compiled_player_followup_admission_records WHERE session_id = ? AND action_id = ?").get(sessionId, actionId) as Record<string, unknown> | null;
    if (!row) return undefined;
    const value: CompiledPlayerFollowupAdmissionRecord & { state: FollowupAdmissionState } = {
      sessionId: row.session_id as string, actionId: row.action_id as string, expectedGeneration: row.expected_generation as number,
      requestHash: row.request_hash as string, dispatchMac: row.dispatch_mac as string, state: row.state as FollowupAdmissionState,
      ...(row.receipt_hash === null ? {} : { receiptHash: row.receipt_hash as string }),
      ...(row.receipt_mac === null ? {} : { receiptMac: row.receipt_mac as string }),
    };
    return validAdmission(value) && ["dispatching", "settled", "quarantined"].includes(value.state)
      && ((value.state === "settled") === (!!value.receiptHash && !!value.receiptMac))
      ? { status: "ok", value } : { status: "refused" };
  }

  private transaction<T>(operation: (db: Database) => T): T {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const root = lstatSync(this.root); if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("unsafe followup admission root");
    if (existsSync(this.file)) { const file = lstatSync(this.file); if (file.isSymbolicLink() || !file.isFile()) throw new Error("unsafe followup admission file"); }
    const db = new Database(this.file, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW | constants.SQLITE_OPEN_FULLMUTEX | constants.SQLITE_OPEN_EXRESCODE);
    let transactionOpen = false;
    try {
      db.run("PRAGMA journal_mode = DELETE"); db.run("PRAGMA synchronous = FULL"); db.run("PRAGMA busy_timeout = 1000");
      db.run("CREATE TABLE IF NOT EXISTS compiled_player_followup_admission_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL)");
      const policy = db.query("SELECT schema_version, coordinator_domain FROM compiled_player_followup_admission_policy WHERE singleton = 1").get() as { schema_version?: unknown; coordinator_domain?: unknown } | null;
      if (!policy) db.run("INSERT INTO compiled_player_followup_admission_policy (singleton, schema_version, coordinator_domain) VALUES (1, ?, ?)", [COMPILED_PLAYER_FOLLOWUP_ADMISSION_SCHEMA_VERSION, COMPILED_PLAYER_FOLLOWUP_ADMISSION_DOMAIN]);
      else if (policy.schema_version !== COMPILED_PLAYER_FOLLOWUP_ADMISSION_SCHEMA_VERSION || policy.coordinator_domain !== COMPILED_PLAYER_FOLLOWUP_ADMISSION_DOMAIN) throw new Error("followup admission policy mismatch");
      db.run("CREATE TABLE IF NOT EXISTS compiled_player_followup_admission_records (session_id TEXT NOT NULL, action_id TEXT NOT NULL, expected_generation INTEGER NOT NULL, request_hash TEXT NOT NULL, dispatch_mac TEXT NOT NULL, state TEXT NOT NULL, receipt_hash TEXT, receipt_mac TEXT, PRIMARY KEY (session_id, action_id))");
      db.run("BEGIN IMMEDIATE"); transactionOpen = true;
      const result = operation(db);
      db.run("COMMIT"); transactionOpen = false;
      return result;
    } finally {
      try {
        // If BEGIN succeeded but commit did not, a failed rollback is a
        // durability failure, not an ignorable cleanup detail.
        if (transactionOpen) db.run("ROLLBACK");
      } finally {
        db.close(true);
      }
    }
  }
}

function validAdmission(value: CompiledPlayerFollowupAdmissionRecord): boolean {
  return typeof value.sessionId === "string" && !!value.sessionId && typeof value.actionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.actionId)
    && Number.isSafeInteger(value.expectedGeneration) && value.expectedGeneration >= 0
    && /^[a-f0-9]{64}$/.test(value.requestHash) && /^[A-Za-z0-9_-]{43}$/.test(value.dispatchMac)
    && (value.receiptHash === undefined || /^[a-f0-9]{64}$/.test(value.receiptHash))
    && (value.receiptMac === undefined || /^[A-Za-z0-9_-]{43}$/.test(value.receiptMac));
}
function sameAdmission(left: CompiledPlayerFollowupAdmissionRecord, right: CompiledPlayerFollowupAdmissionRecord, includeReceipt = true): boolean {
  return left.sessionId === right.sessionId && left.actionId === right.actionId && left.expectedGeneration === right.expectedGeneration
    && left.requestHash === right.requestHash && left.dispatchMac === right.dispatchMac
    && (!includeReceipt || (left.receiptHash === right.receiptHash && left.receiptMac === right.receiptMac));
}
