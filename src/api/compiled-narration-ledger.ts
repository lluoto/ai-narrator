import { Database, constants } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync, lstatSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import type { CompiledNarrationCandidate } from "./game-session";

/** Candidate/receipt evidence is intentionally distinct from the intent replay
 * store: it contains one mechanically exact private successor, not a prose
 * classification result. */
export const COMPILED_NARRATION_LEDGER_SCHEMA_VERSION = "1.0.0";
export const COMPILED_NARRATION_LEDGER_DOMAIN = "compiled-player-narration-ledger";
const FILE_NAME = ".compiled-narration-ledger.sqlite";
const MAX_CANDIDATE_BYTES = 1_024 * 1_024;
const MAX_RECEIPT_BYTES = 8_192;
const RETRY_AFTER_SECONDS = 60;
const OPEN_FLAGS = constants.SQLITE_OPEN_READWRITE
  | constants.SQLITE_OPEN_CREATE
  | constants.SQLITE_OPEN_NOFOLLOW
  | constants.SQLITE_OPEN_FULLMUTEX
  | constants.SQLITE_OPEN_EXRESCODE;

type StoredState = "prepared" | "dispatching" | "receipt" | "committed" | "quarantined";
type StoredRow = {
  session_id: unknown; action_id: unknown; expected_generation: unknown; candidate_hash: unknown;
  frame_hash: unknown; candidate_json: unknown; state: unknown; receipt_json: unknown;
  receipt_hash: unknown;
};

export type CompiledNarrationLedgerRead =
  | { status: "absent" }
  | { status: "ok"; value: { candidate: CompiledNarrationCandidate; state: StoredState; narration?: { schemaVersion: "1.0.0"; text: string } } }
  | { status: "refused"; code: "unavailable" | "corrupt"; retryAfterSeconds: number };

export type CompiledNarrationLedgerWrite =
  | { status: "stored" | "existing"; value: { candidate: CompiledNarrationCandidate; state: StoredState; narration?: { schemaVersion: "1.0.0"; text: string } } }
  | { status: "refused"; code: "unavailable" | "conflict" | "invalid"; retryAfterSeconds: number };

function validHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validNarration(value: unknown): value is { schemaVersion: "1.0.0"; text: string } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === "schemaVersion|text"
    && (value as { schemaVersion?: unknown }).schemaVersion === "1.0.0"
    && typeof (value as { text?: unknown }).text === "string"
    && !!(value as { text: string }).text
    && (value as { text: string }).text.trim() === (value as { text: string }).text
    && Array.from((value as { text: string }).text).length <= 2_000;
}

function receiptHash(value: { schemaVersion: "1.0.0"; text: string }): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function validCandidate(value: unknown): value is CompiledNarrationCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CompiledNarrationCandidate>;
  const commonKeys = [
    "schemaVersion", "sessionId", "bundleId", "actionId", "expectedGeneration", "nextGeneration",
    "predecessorSnapshotHash", "requestHash", "playerRequestHash", "candidateHash", "frame", "frameHash", "snapshot",
  ];
  const expectedKeys = candidate.schemaVersion === "1.0.0"
    ? commonKeys
    : candidate.schemaVersion === "2.0.0"
      ? [...commonKeys, "topicTokenHash", "topicBindingHash"]
      : [];
  if (!expectedKeys.length || Object.keys(candidate).length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.hasOwn(candidate, key))) return false;
  return (candidate.schemaVersion === "1.0.0" || candidate.schemaVersion === "2.0.0")
    && typeof candidate.sessionId === "string" && !!candidate.sessionId
    && typeof candidate.bundleId === "string" && !!candidate.bundleId
    && typeof candidate.actionId === "string" && !!candidate.actionId
    && typeof candidate.expectedGeneration === "number" && Number.isSafeInteger(candidate.expectedGeneration) && candidate.expectedGeneration >= 0
    && typeof candidate.nextGeneration === "number" && Number.isSafeInteger(candidate.nextGeneration) && candidate.nextGeneration === candidate.expectedGeneration + 1
    && validHash(candidate.predecessorSnapshotHash) && validHash(candidate.requestHash) && validHash(candidate.playerRequestHash)
    && validHash(candidate.candidateHash) && validHash(candidate.frameHash)
    && !!candidate.frame && typeof candidate.frame === "object"
    && !!candidate.snapshot && typeof candidate.snapshot === "object"
    && (candidate.schemaVersion === "1.0.0"
      || (validHash((candidate as { topicTokenHash?: unknown }).topicTokenHash)
        && validHash((candidate as { topicBindingHash?: unknown }).topicBindingHash)));
}

function decodeJson(value: unknown, maxBytes: number): unknown {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maxBytes) throw new Error("compiled narration ledger JSON is invalid");
  return JSON.parse(value) as unknown;
}

function isSqliteContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : "";
  return typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)/.test(code)
    || /SQLITE_(?:BUSY|LOCKED)|database(?:\s+is)?\s+(?:busy|locked)/i.test(message);
}

/** Small, exact-state ledger. It does not offer a generic replay API: every
 * transition is the narration candidate lifecycle and all malformed/unknown
 * evidence becomes a fail-closed refusal. */
export class CompiledNarrationLedger {
  readonly root: string;
  readonly file: string;

  constructor(root: string) {
    if (typeof root !== "string" || !root.trim()) throw new Error("compiled narration ledger requires a durable root");
    this.root = resolve(root);
    this.file = join(this.root, FILE_NAME);
  }

  read(sessionId: string, actionId: string): CompiledNarrationLedgerRead {
    try {
      return this.transaction((db) => {
        const row = db.query("SELECT session_id, action_id, expected_generation, candidate_hash, frame_hash, candidate_json, state, receipt_json, receipt_hash FROM compiled_narration_records WHERE session_id = ? AND action_id = ?").get(sessionId, actionId) as StoredRow | null;
        return row ? this.decode(row, sessionId, actionId) : { status: "absent" };
      });
    } catch (error) {
      return { status: "refused", code: isSqliteContention(error) ? "unavailable" : "unavailable", retryAfterSeconds: RETRY_AFTER_SECONDS };
    }
  }

  savePrepared(candidate: CompiledNarrationCandidate): CompiledNarrationLedgerWrite {
    if (!validCandidate(candidate)) return { status: "refused", code: "invalid", retryAfterSeconds: RETRY_AFTER_SECONDS };
    let candidateJson: string;
    try {
      candidateJson = JSON.stringify(candidate);
      if (new TextEncoder().encode(candidateJson).byteLength > MAX_CANDIDATE_BYTES) throw new Error("candidate too large");
    } catch { return { status: "refused", code: "invalid", retryAfterSeconds: RETRY_AFTER_SECONDS }; }
    try {
      return this.transaction((db) => {
        const existing = db.query("SELECT session_id, action_id, expected_generation, candidate_hash, frame_hash, candidate_json, state, receipt_json, receipt_hash FROM compiled_narration_records WHERE session_id = ? AND action_id = ?").get(candidate.sessionId, candidate.actionId) as StoredRow | null;
        if (existing) {
          const decoded = this.decode(existing, candidate.sessionId, candidate.actionId);
          if (decoded.status !== "ok" || decoded.value.candidate.candidateHash !== candidate.candidateHash) {
            return { status: "refused", code: "conflict", retryAfterSeconds: RETRY_AFTER_SECONDS };
          }
          return { status: "existing", value: decoded.value };
        }
        db.run(
          "INSERT INTO compiled_narration_records (session_id, action_id, expected_generation, candidate_hash, frame_hash, candidate_json, state, receipt_json, receipt_hash) VALUES (?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL)",
          [candidate.sessionId, candidate.actionId, candidate.expectedGeneration, candidate.candidateHash, candidate.frameHash, candidateJson],
        );
        return { status: "stored", value: { candidate: structuredClone(candidate), state: "prepared" } };
      });
    } catch (error) {
      return { status: "refused", code: "unavailable", retryAfterSeconds: isSqliteContention(error) ? 1 : RETRY_AFTER_SECONDS };
    }
  }

  markDispatching(candidate: CompiledNarrationCandidate): CompiledNarrationLedgerWrite {
    return this.transition(candidate, "prepared", "dispatching");
  }

  saveReceipt(candidate: CompiledNarrationCandidate, narration: { schemaVersion: "1.0.0"; text: string }): CompiledNarrationLedgerWrite {
    if (!validNarration(narration)) return { status: "refused", code: "invalid", retryAfterSeconds: RETRY_AFTER_SECONDS };
    let receipt: string;
    try {
      receipt = JSON.stringify(narration);
      if (new TextEncoder().encode(receipt).byteLength > MAX_RECEIPT_BYTES) throw new Error("receipt too large");
    } catch { return { status: "refused", code: "invalid", retryAfterSeconds: RETRY_AFTER_SECONDS }; }
    try {
      return this.transaction((db) => {
        const row = this.row(db, candidate);
        if (!row) return { status: "refused", code: "conflict", retryAfterSeconds: RETRY_AFTER_SECONDS };
        const decoded = this.decode(row, candidate.sessionId, candidate.actionId);
        if (decoded.status !== "ok" || decoded.value.candidate.candidateHash !== candidate.candidateHash) return { status: "refused", code: "conflict", retryAfterSeconds: RETRY_AFTER_SECONDS };
        if (decoded.value.state === "receipt" || decoded.value.state === "committed") return { status: "existing", value: decoded.value };
        if (decoded.value.state !== "dispatching") return { status: "refused", code: "conflict", retryAfterSeconds: RETRY_AFTER_SECONDS };
        db.run("UPDATE compiled_narration_records SET state = 'receipt', receipt_json = ?, receipt_hash = ? WHERE session_id = ? AND action_id = ? AND candidate_hash = ? AND state = 'dispatching'", [receipt, receiptHash(narration), candidate.sessionId, candidate.actionId, candidate.candidateHash]);
        return { status: "stored", value: { candidate: decoded.value.candidate, state: "receipt", narration: structuredClone(narration) } };
      });
    } catch (error) {
      return { status: "refused", code: "unavailable", retryAfterSeconds: isSqliteContention(error) ? 1 : RETRY_AFTER_SECONDS };
    }
  }

  markCommitted(candidate: CompiledNarrationCandidate): CompiledNarrationLedgerWrite {
    return this.transition(candidate, "receipt", "committed");
  }

  quarantine(candidate: Pick<CompiledNarrationCandidate, "sessionId" | "actionId" | "candidateHash">): void {
    try {
      this.transaction((db) => {
        // A durable receipt proves the provider result. It must remain
        // consumable after a fence acknowledgement or publication outcome is
        // uncertain; only pre-receipt work may become quarantined.
        db.run("UPDATE compiled_narration_records SET state = 'quarantined' WHERE session_id = ? AND action_id = ? AND candidate_hash = ? AND state IN ('prepared', 'dispatching')", [candidate.sessionId, candidate.actionId, candidate.candidateHash]);
      });
    } catch { /* uncertain durable evidence remains fail-closed */ }
  }

  private transition(candidate: CompiledNarrationCandidate, from: StoredState, to: StoredState): CompiledNarrationLedgerWrite {
    try {
      return this.transaction((db) => {
        const row = this.row(db, candidate);
        if (!row) return { status: "refused", code: "conflict", retryAfterSeconds: RETRY_AFTER_SECONDS };
        const decoded = this.decode(row, candidate.sessionId, candidate.actionId);
        if (decoded.status !== "ok" || decoded.value.candidate.candidateHash !== candidate.candidateHash) return { status: "refused", code: "conflict", retryAfterSeconds: RETRY_AFTER_SECONDS };
        if (decoded.value.state === to) return { status: "existing", value: decoded.value };
        if (decoded.value.state !== from) return { status: "refused", code: "conflict", retryAfterSeconds: RETRY_AFTER_SECONDS };
        db.run("UPDATE compiled_narration_records SET state = ? WHERE session_id = ? AND action_id = ? AND candidate_hash = ? AND state = ?", [to, candidate.sessionId, candidate.actionId, candidate.candidateHash, from]);
        return { status: "stored", value: { ...decoded.value, state: to } };
      });
    } catch (error) {
      return { status: "refused", code: "unavailable", retryAfterSeconds: isSqliteContention(error) ? 1 : RETRY_AFTER_SECONDS };
    }
  }

  private row(db: Database, candidate: Pick<CompiledNarrationCandidate, "sessionId" | "actionId">): StoredRow | null {
    return db.query("SELECT session_id, action_id, expected_generation, candidate_hash, frame_hash, candidate_json, state, receipt_json, receipt_hash FROM compiled_narration_records WHERE session_id = ? AND action_id = ?").get(candidate.sessionId, candidate.actionId) as StoredRow | null;
  }

  private decode(row: StoredRow, sessionId: string, actionId: string): CompiledNarrationLedgerRead {
    try {
      if (row.session_id !== sessionId || row.action_id !== actionId || !Number.isSafeInteger(row.expected_generation)
        || !validHash(row.candidate_hash) || !validHash(row.frame_hash) || !["prepared", "dispatching", "receipt", "committed", "quarantined"].includes(row.state as string)) {
        return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
      }
      const candidate = decodeJson(row.candidate_json, MAX_CANDIDATE_BYTES);
      if (!validCandidate(candidate) || candidate.sessionId !== sessionId || candidate.actionId !== actionId
        || candidate.expectedGeneration !== row.expected_generation || candidate.candidateHash !== row.candidate_hash || candidate.frameHash !== row.frame_hash) {
        return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
      }
      const narration = row.receipt_json === null ? undefined : decodeJson(row.receipt_json, MAX_RECEIPT_BYTES);
      if ((row.state === "receipt" || row.state === "committed")
        && (!validNarration(narration) || !validHash(row.receipt_hash) || receiptHash(narration) !== row.receipt_hash)) {
        return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
      }
      if (!(row.state === "receipt" || row.state === "committed") && (narration !== undefined || row.receipt_hash !== null)) return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
      if (validNarration(narration)) return { status: "ok", value: { candidate, state: row.state as StoredState, narration } };
      return { status: "ok", value: { candidate, state: row.state as StoredState } };
    } catch {
      return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
    }
  }

  private transaction<T>(operation: (db: Database) => T): T {
    this.assertSafeRoot();
    const db = new Database(this.file, OPEN_FLAGS);
    let committed = false;
    try {
      db.run("PRAGMA journal_mode = DELETE");
      db.run("PRAGMA synchronous = FULL");
      db.run("PRAGMA locking_mode = NORMAL");
      db.run("PRAGMA busy_timeout = 1000");
      db.run("CREATE TABLE IF NOT EXISTS compiled_narration_ledger_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL)");
      const policy = db.query("SELECT schema_version, coordinator_domain FROM compiled_narration_ledger_policy WHERE singleton = 1").get() as { schema_version?: unknown; coordinator_domain?: unknown } | null;
      if (!policy) db.run("INSERT INTO compiled_narration_ledger_policy (singleton, schema_version, coordinator_domain) VALUES (1, ?, ?)", [COMPILED_NARRATION_LEDGER_SCHEMA_VERSION, COMPILED_NARRATION_LEDGER_DOMAIN]);
      else if (policy.schema_version !== COMPILED_NARRATION_LEDGER_SCHEMA_VERSION || policy.coordinator_domain !== COMPILED_NARRATION_LEDGER_DOMAIN) throw new Error("compiled narration ledger policy mismatch");
      db.run("CREATE TABLE IF NOT EXISTS compiled_narration_records (session_id TEXT NOT NULL, action_id TEXT NOT NULL, expected_generation INTEGER NOT NULL, candidate_hash TEXT NOT NULL, frame_hash TEXT NOT NULL, candidate_json TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT, receipt_hash TEXT, PRIMARY KEY (session_id, action_id))");
      db.run("BEGIN IMMEDIATE");
      const value = operation(db);
      db.run("COMMIT");
      committed = true;
      return value;
    } finally {
      if (!committed) try { db.run("ROLLBACK"); } catch { /* failed begin has nothing to roll back */ }
      db.close(true);
    }
  }

  private assertSafeRoot(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const root = lstatSync(this.root);
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("compiled narration ledger root is unsafe");
    if (existsSync(this.file)) {
      const file = lstatSync(this.file);
      if (file.isSymbolicLink() || !file.isFile()) throw new Error("compiled narration ledger file is unsafe");
    }
  }
}

/** Separate same-generation NPC follow-up evidence. Version 2 retains one
 * accepted question for bounded continuity; it remains untrusted player prose,
 * authenticated by the request hash rather than added to module facts. The
 * physical schema stays compatible with version 1 rows and their exact replay. */
export const COMPILED_PLAYER_FOLLOWUP_LEDGER_SCHEMA_VERSION = "1.0.0";
export const COMPILED_PLAYER_FOLLOWUP_LEDGER_DOMAIN = "compiled-player-followup-ledger";
const FOLLOWUP_FILE_NAME = ".compiled-player-followup-ledger.sqlite";
type FollowupState = "prepared" | "dispatching" | "settled" | "quarantined";

interface CompiledPlayerFollowupRecordBase {
  sessionId: string;
  bundleId: string;
  actionId: string;
  expectedGeneration: number;
  sceneId: string;
  npcId: string;
  clueIds: readonly string[];
  contactTokenHash: string;
  factsHash: string;
  playerRequestHash: string;
  frameHash: string;
  preparedMac: string;
  dispatchMac?: string;
}

export type CompiledPlayerFollowupRecord = CompiledPlayerFollowupRecordBase & (
  | { schemaVersion: "1.0.0" }
  | {
      schemaVersion: "2.0.0";
      playerInput: string;
      previousActionId: string | null;
      contextHash: string;
    }
);

export type CompiledPlayerFollowupLedgerRead =
  | { status: "absent" }
  | { status: "ok"; value: { record: CompiledPlayerFollowupRecord; state: FollowupState; narration?: { schemaVersion: "1.0.0"; text: string }; receiptMac?: string } }
  | { status: "refused"; code: "unavailable" | "corrupt"; retryAfterSeconds: number };

function validFollowupRecord(value: unknown): value is CompiledPlayerFollowupRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const base = ["schemaVersion", "sessionId", "bundleId", "actionId", "expectedGeneration", "sceneId", "npcId", "clueIds", "contactTokenHash", "factsHash", "playerRequestHash", "frameHash", "preparedMac"];
  if (record.schemaVersion === "2.0.0") base.push("playerInput", "previousActionId", "contextHash");
  else if (record.schemaVersion !== "1.0.0") return false;
  const keys = Object.keys(record).sort();
  const expected = (record.dispatchMac === undefined ? base : [...base, "dispatchMac"]).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    && (record.schemaVersion === "1.0.0" || (typeof record.playerInput === "string"
      && !!record.playerInput && record.playerInput.trim() === record.playerInput && record.playerInput.length <= 1_000
      && (record.previousActionId === null || (typeof record.previousActionId === "string"
        && /^[A-Za-z0-9_-]{1,128}$/.test(record.previousActionId) && record.previousActionId !== record.actionId))
      && validHash(record.contextHash)))
    && typeof record.sessionId === "string" && !!record.sessionId
    && typeof record.bundleId === "string" && !!record.bundleId
    && typeof record.actionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(record.actionId)
    && Number.isSafeInteger(record.expectedGeneration) && (record.expectedGeneration as number) >= 0
    && [record.sceneId, record.npcId].every((entry) => typeof entry === "string" && !!entry && entry.length <= 160)
    && Array.isArray(record.clueIds) && record.clueIds.length > 0 && record.clueIds.length <= 64
    && record.clueIds.every((clueId) => typeof clueId === "string" && !!clueId && clueId.length <= 160)
    && record.clueIds.every((clueId, index, values) => index === 0 || values[index - 1]!.localeCompare(clueId) < 0)
    && [record.contactTokenHash, record.factsHash, record.playerRequestHash, record.frameHash].every(validHash)
    && typeof record.preparedMac === "string" && /^[A-Za-z0-9_-]{43}$/.test(record.preparedMac)
    && (record.dispatchMac === undefined || (typeof record.dispatchMac === "string" && /^[A-Za-z0-9_-]{43}$/.test(record.dispatchMac)));
}

export class CompiledPlayerFollowupLedger {
  readonly root: string;
  readonly file: string;

  constructor(root: string) {
    if (typeof root !== "string" || !root.trim()) throw new Error("compiled player followup ledger requires a durable root");
    this.root = resolve(root);
    this.file = join(this.root, FOLLOWUP_FILE_NAME);
  }

  read(sessionId: string, actionId: string): CompiledPlayerFollowupLedgerRead {
    try {
      return this.transaction((db) => {
        const row = db.query("SELECT record_json, state, receipt_json, receipt_mac FROM compiled_player_followup_records WHERE session_id = ? AND action_id = ?").get(sessionId, actionId) as { record_json?: unknown; state?: unknown; receipt_json?: unknown; receipt_mac?: unknown } | null;
        if (!row) return { status: "absent" };
        const record = decodeJson(row.record_json, 16_384);
        if (!validFollowupRecord(record) || record.sessionId !== sessionId || record.actionId !== actionId || !["prepared", "dispatching", "settled", "quarantined"].includes(row.state as string)) return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
        const narration = row.receipt_json === null ? undefined : decodeJson(row.receipt_json, MAX_RECEIPT_BYTES);
        if (row.state === "settled") {
          if (!validNarration(narration) || typeof row.receipt_mac !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(row.receipt_mac)) return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
          return { status: "ok", value: { record, state: "settled", narration, receiptMac: row.receipt_mac } };
        }
        if (narration !== undefined || row.receipt_mac !== null) return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
        return { status: "ok", value: { record, state: row.state as FollowupState } };
      });
    } catch { return { status: "refused", code: "unavailable", retryAfterSeconds: RETRY_AFTER_SECONDS }; }
  }

  savePrepared(record: CompiledPlayerFollowupRecord): CompiledPlayerFollowupLedgerRead {
    if (!validFollowupRecord(record) || record.dispatchMac !== undefined) return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
    return this.write(record, (db, existing) => {
      if (existing) return existing;
      db.run("INSERT INTO compiled_player_followup_records (session_id, action_id, record_json, state, receipt_json, receipt_mac) VALUES (?, ?, ?, 'prepared', NULL, NULL)", [record.sessionId, record.actionId, JSON.stringify(record)]);
      return { status: "ok", value: { record: structuredClone(record), state: "prepared" } };
    });
  }

  markDispatching(record: CompiledPlayerFollowupRecord): CompiledPlayerFollowupLedgerRead {
    if (!validFollowupRecord(record) || !record.dispatchMac) return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
    return this.write(record, (db, existing) => {
      if (!existing || existing.status !== "ok" || existing.value.state !== "prepared" || existing.value.record.preparedMac !== record.preparedMac) return existing ?? { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
      db.run("UPDATE compiled_player_followup_records SET record_json = ?, state = 'dispatching' WHERE session_id = ? AND action_id = ? AND state = 'prepared'", [JSON.stringify(record), record.sessionId, record.actionId]);
      return { status: "ok", value: { record: structuredClone(record), state: "dispatching" } };
    });
  }

  settle(record: CompiledPlayerFollowupRecord, narration: { schemaVersion: "1.0.0"; text: string }, receiptMac: string): CompiledPlayerFollowupLedgerRead {
    if (!validFollowupRecord(record) || !record.dispatchMac || !validNarration(narration) || !/^[A-Za-z0-9_-]{43}$/.test(receiptMac)) return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
    return this.write(record, (db, existing) => {
      if (!existing || existing.status !== "ok") return existing ?? { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
      if (existing.value.state === "settled") return existing;
      if (existing.value.state !== "dispatching" || existing.value.record.dispatchMac !== record.dispatchMac) return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
      db.run("UPDATE compiled_player_followup_records SET state = 'settled', receipt_json = ?, receipt_mac = ? WHERE session_id = ? AND action_id = ? AND state = 'dispatching'", [JSON.stringify(narration), receiptMac, record.sessionId, record.actionId]);
      return { status: "ok", value: { record: structuredClone(record), state: "settled", narration: structuredClone(narration), receiptMac } };
    });
  }

  quarantine(sessionId: string, actionId: string): void {
    try { this.transaction((db) => { db.run("UPDATE compiled_player_followup_records SET state = 'quarantined' WHERE session_id = ? AND action_id = ? AND state = 'dispatching'", [sessionId, actionId]); }); } catch { /* durable uncertainty stays fail-closed */ }
  }

  private write(record: CompiledPlayerFollowupRecord, operation: (db: Database, existing: CompiledPlayerFollowupLedgerRead | undefined) => CompiledPlayerFollowupLedgerRead): CompiledPlayerFollowupLedgerRead {
    try { return this.transaction((db) => operation(db, this.readInTransaction(db, record.sessionId, record.actionId))); }
    catch { return { status: "refused", code: "unavailable", retryAfterSeconds: RETRY_AFTER_SECONDS }; }
  }

  private readInTransaction(db: Database, sessionId: string, actionId: string): CompiledPlayerFollowupLedgerRead | undefined {
    const row = db.query("SELECT record_json, state, receipt_json, receipt_mac FROM compiled_player_followup_records WHERE session_id = ? AND action_id = ?").get(sessionId, actionId) as { record_json?: unknown; state?: unknown; receipt_json?: unknown; receipt_mac?: unknown } | null;
    if (!row) return undefined;
    const record = decodeJson(row.record_json, 16_384);
    if (!validFollowupRecord(record) || record.sessionId !== sessionId || record.actionId !== actionId || !["prepared", "dispatching", "settled", "quarantined"].includes(row.state as string)) return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
    const narration = row.receipt_json === null ? undefined : decodeJson(row.receipt_json, MAX_RECEIPT_BYTES);
    if (row.state === "settled" && validNarration(narration) && typeof row.receipt_mac === "string") return { status: "ok", value: { record, state: "settled", narration, receiptMac: row.receipt_mac } };
    if (row.state !== "settled" && narration === undefined && row.receipt_mac === null) return { status: "ok", value: { record, state: row.state as FollowupState } };
    return { status: "refused", code: "corrupt", retryAfterSeconds: RETRY_AFTER_SECONDS };
  }

  private transaction<T>(operation: (db: Database) => T): T {
    this.assertSafeRoot();
    const db = new Database(this.file, OPEN_FLAGS);
    let transactionOpen = false;
    try {
      db.run("PRAGMA journal_mode = DELETE"); db.run("PRAGMA synchronous = FULL"); db.run("PRAGMA busy_timeout = 1000");
      db.run("CREATE TABLE IF NOT EXISTS compiled_player_followup_ledger_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL)");
      const policy = db.query("SELECT schema_version, coordinator_domain FROM compiled_player_followup_ledger_policy WHERE singleton = 1").get() as { schema_version?: unknown; coordinator_domain?: unknown } | null;
      if (!policy) db.run("INSERT INTO compiled_player_followup_ledger_policy (singleton, schema_version, coordinator_domain) VALUES (1, ?, ?)", [COMPILED_PLAYER_FOLLOWUP_LEDGER_SCHEMA_VERSION, COMPILED_PLAYER_FOLLOWUP_LEDGER_DOMAIN]);
      else if (policy.schema_version !== COMPILED_PLAYER_FOLLOWUP_LEDGER_SCHEMA_VERSION || policy.coordinator_domain !== COMPILED_PLAYER_FOLLOWUP_LEDGER_DOMAIN) throw new Error("compiled player followup ledger policy mismatch");
      db.run("CREATE TABLE IF NOT EXISTS compiled_player_followup_records (session_id TEXT NOT NULL, action_id TEXT NOT NULL, record_json TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT, receipt_mac TEXT, PRIMARY KEY (session_id, action_id))");
      db.run("BEGIN IMMEDIATE"); transactionOpen = true;
      const value = operation(db);
      db.run("COMMIT"); transactionOpen = false;
      return value;
    } finally {
      try {
        // Do not suppress rollback failure: this ledger is the mutable side
        // of a trusted admission fence, so uncertainty must fail closed.
        if (transactionOpen) db.run("ROLLBACK");
      } finally {
        db.close(true);
      }
    }
  }

  private assertSafeRoot(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const root = lstatSync(this.root);
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("compiled player followup ledger root is unsafe");
    if (existsSync(this.file)) { const file = lstatSync(this.file); if (file.isSymbolicLink() || !file.isFile()) throw new Error("compiled player followup ledger file is unsafe"); }
  }
}
