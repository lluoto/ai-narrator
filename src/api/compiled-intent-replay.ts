import { Database, constants } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "crypto";
import { lstatSync } from "fs";
import { join, resolve } from "path";
import type { CompiledIntentReplayIdentity } from "./game-session";

/**
 * This ledger is deliberately a different durable domain from the short-lived
 * compiled-intent admission lease.  Admission prevents concurrent provider
 * calls; this ledger makes a completed, public classification replayable
 * after that lease has been released or a process has restarted.
 */
export const COMPILED_INTENT_REPLAY_SCHEMA_VERSION = "2.0.0";
export const COMPILED_INTENT_REPLAY_DOMAIN = "compiled-intent-classification-replay";
export const COMPILED_INTENT_REPLAY_FILE_NAME = ".compiled-intent-replay.sqlite";
export const COMPILED_INTENT_REPLAY_PRODUCTION_POLICY = Object.freeze({
  maxRecordsPerScope: 64,
  busyTimeoutMs: 1_000,
});

const REPLAY_OPEN_FLAGS = constants.SQLITE_OPEN_READWRITE
  | constants.SQLITE_OPEN_CREATE
  | constants.SQLITE_OPEN_NOFOLLOW
  | constants.SQLITE_OPEN_FULLMUTEX
  | constants.SQLITE_OPEN_EXRESCODE;
const RETRY_AFTER_SECONDS = 60;
const MAX_REPLAY_MECHANISM_KEYS = 32;
const REPLAY_MECHANISM_KEY_HEX_LENGTH = 64;
// `JSON.stringify` uses no whitespace.  The largest legitimate payload is
// ["<64 hex>", ...] with 32 keys: brackets + quotes + keys + commas.  Reject
// longer UTF-8 TEXT before JSON.parse so a corrupt local SQLite row cannot
// amplify memory consumption in native-to-JS transfer or the JSON decoder.
const MAX_REPLAY_MECHANISM_KEYS_JSON_LENGTH = 2
  + (MAX_REPLAY_MECHANISM_KEYS * (REPLAY_MECHANISM_KEY_HEX_LENGTH + 2))
  + (MAX_REPLAY_MECHANISM_KEYS - 1);

type SqlBinding = string | number;
type ReplayKind = "selected" | "ambiguous" | "no_match";

export type CompiledIntentReplayResult = Readonly<{
  kind: ReplayKind;
  mechanismKeys: readonly string[];
}>;

export type CompiledIntentReplayReadResult =
  | { status: "absent" }
  | { status: "hit"; value: CompiledIntentReplayResult }
  | { status: "refused"; code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" | "COMPILED_INTENT_REPLAY_CONFLICT"; retryAfterSeconds: number };

export type CompiledIntentReplayWriteResult =
  | { status: "stored"; value: CompiledIntentReplayResult }
  | { status: "refused"; code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" | "COMPILED_INTENT_REPLAY_CONFLICT" | "COMPILED_INTENT_REPLAY_CAPACITY"; retryAfterSeconds: number };

export type CompiledIntentReplayCapacityResult =
  | { status: "available" }
  | { status: "refused"; code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" | "COMPILED_INTENT_REPLAY_CAPACITY"; retryAfterSeconds: number };

interface ReplayConnection {
  run(sql: string, bindings?: readonly SqlBinding[]): void;
  get<T>(sql: string, bindings?: readonly SqlBinding[]): T | undefined;
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown;
  close(throwOnError: true): void;
}

interface ReplayPathOps {
  kind(path: string): "missing" | "regular" | "directory" | "unsafe";
}

/** Test-only storage seams retain the fixed physical filename and policy domain. */
export interface CompiledIntentReplayOptions {
  connectionFactory?: (file: string, flags: number) => ReplayConnection;
  pathOps?: ReplayPathOps;
}

export interface CompiledIntentReplayConfig {
  /** Host/test policy only. Production uses the immutable exported policy. */
  maxRecordsPerScope?: number;
  now?: () => number;
}

interface StoredPolicy {
  schema_version: unknown;
  coordinator_domain: unknown;
  max_records_per_scope: unknown;
}

interface StoredReplayRow {
  session_key: unknown;
  expected_generation: unknown;
  scope_key: unknown;
  request_key: unknown;
  catalog_key: unknown;
  result_kind: unknown;
  mechanism_keys_json: unknown;
  result_mac: unknown;
  state: unknown;
}

class ReplayFailure extends Error {
  constructor(
    readonly code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" | "COMPILED_INTENT_REPLAY_CONFLICT" | "COMPILED_INTENT_REPLAY_CAPACITY",
    message: string,
  ) {
    super(message);
  }
}

const nodePathOps: ReplayPathOps = {
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

class BunReplayConnection implements ReplayConnection {
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

function bunConnectionFactory(file: string, flags: number): ReplayConnection {
  return new BunReplayConnection(new Database(file, flags));
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validResult(value: CompiledIntentReplayResult): boolean {
  if (value.mechanismKeys.length > MAX_REPLAY_MECHANISM_KEYS) return false;
  if (value.kind === "no_match") return value.mechanismKeys.length === 0;
  if (value.kind === "selected") return value.mechanismKeys.length === 1 && validHash(value.mechanismKeys[0]);
  return value.kind === "ambiguous"
    && value.mechanismKeys.length >= 2
    && value.mechanismKeys.every(validHash)
    && new Set(value.mechanismKeys).size === value.mechanismKeys.length;
}

function sameResult(left: CompiledIntentReplayResult, right: CompiledIntentReplayResult): boolean {
  return left.kind === right.kind && left.mechanismKeys.length === right.mechanismKeys.length
    && left.mechanismKeys.every((value, index) => value === right.mechanismKeys[index]);
}

function mapFailure(error: unknown): ReplayFailure {
  if (error instanceof ReplayFailure) return error;
  const message = error instanceof Error ? error.message : "compiled intent replay storage failed";
  if (/no such column|has no column|no such table|malformed database schema|database disk image is malformed/i.test(message)) {
    return new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", "compiled intent replay schema is unavailable");
  }
  return new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", message);
}

/**
 * Local durable success ledger for compiled natural-language classification.
 * Every stored identity is HMAC-derived by GameSession's host-only authority;
 * raw prose, labels, IDs, façade choices, and the HMAC key never enter SQLite.
 */
export class CompiledIntentReplayStore {
  readonly root: string;
  readonly file: string;
  private readonly maxRecordsPerScope: number;
  private readonly now: () => number;
  private readonly pathOps: ReplayPathOps;
  private readonly connectionFactory: (file: string, flags: number) => ReplayConnection;

  constructor(root: string, config: CompiledIntentReplayConfig = {}, options: CompiledIntentReplayOptions = {}) {
    if (typeof root !== "string" || !root.trim()) throw new Error("compiled intent replay requires a durable root");
    const maxRecordsPerScope = config.maxRecordsPerScope ?? COMPILED_INTENT_REPLAY_PRODUCTION_POLICY.maxRecordsPerScope;
    if (!Number.isSafeInteger(maxRecordsPerScope) || maxRecordsPerScope < 1 || maxRecordsPerScope > 1_000_000 || (config.now !== undefined && typeof config.now !== "function")) {
      throw new Error("compiled intent replay configuration is invalid");
    }
    this.root = resolve(root);
    this.file = join(this.root, COMPILED_INTENT_REPLAY_FILE_NAME);
    this.maxRecordsPerScope = maxRecordsPerScope;
    this.now = config.now ?? Date.now;
    this.pathOps = options.pathOps ?? nodePathOps;
    this.connectionFactory = options.connectionFactory ?? bunConnectionFactory;
  }

  read(identity: CompiledIntentReplayIdentity): CompiledIntentReplayReadResult {
    this.assertIdentity(identity);
    try {
      return this.transaction((connection) => {
        const row = this.find(connection, identity);
        if (!row) return { status: "absent" };
        const decoded = this.decode(row, identity);
        if (decoded.status === "ok") return { status: "hit", value: decoded.value };
        this.quarantineRow(connection, row, identity);
        return { status: "refused", code: decoded.code, retryAfterSeconds: RETRY_AFTER_SECONDS };
      });
    } catch (error) {
      const failure = mapFailure(error);
      return {
        status: "refused",
        code: failure.code === "COMPILED_INTENT_REPLAY_CAPACITY" ? "COMPILED_INTENT_REPLAY_UNAVAILABLE" : failure.code,
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      };
    }
  }

  /**
   * Provider admission already serializes a session generation. Before a
   * provider call, reserve no slot; merely prove this identity's immutable
   * scope still has capacity. A later save repeats the guard under the same
   * SQLite transaction as its insert.
   */
  hasCapacity(identity: CompiledIntentReplayIdentity): CompiledIntentReplayCapacityResult {
    this.assertIdentity(identity);
    try {
      return this.transaction((connection) => {
        this.clearOlderGenerations(connection, identity);
        const count = this.scopeCount(connection, identity);
        if (count >= this.maxRecordsPerScope) {
          return { status: "refused", code: "COMPILED_INTENT_REPLAY_CAPACITY", retryAfterSeconds: RETRY_AFTER_SECONDS };
        }
        return { status: "available" };
      });
    } catch (error) {
      const failure = mapFailure(error);
      return {
        status: "refused",
        code: failure.code === "COMPILED_INTENT_REPLAY_CAPACITY" ? "COMPILED_INTENT_REPLAY_UNAVAILABLE"
          : failure.code === "COMPILED_INTENT_REPLAY_UNAVAILABLE" ? failure.code
            : "COMPILED_INTENT_REPLAY_UNAVAILABLE",
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      };
    }
  }

  /**
   * Persist before the classification lease is released.  A generation
   * successor may trim only its own session's older generation records; the
   * active generation is never silently evicted to make capacity available.
   */
  save(identity: CompiledIntentReplayIdentity, result: CompiledIntentReplayResult): CompiledIntentReplayWriteResult {
    this.assertIdentity(identity);
    if (!validResult(result)) throw new Error("compiled intent replay result is invalid");
    const normalized = Object.freeze({ kind: result.kind, mechanismKeys: Object.freeze([...result.mechanismKeys]) });
    try {
      return this.transaction((connection) => {
        this.clearOlderGenerations(connection, identity);
        const existing = this.find(connection, identity);
        if (existing) {
          const decoded = this.decode(existing, identity);
          if (decoded.status !== "ok" || !sameResult(decoded.value, normalized)) {
            this.quarantineRow(connection, existing, identity);
            return { status: "refused", code: "COMPILED_INTENT_REPLAY_CONFLICT", retryAfterSeconds: RETRY_AFTER_SECONDS };
          }
          return { status: "stored", value: decoded.value };
        }
        if (this.scopeCount(connection, identity) >= this.maxRecordsPerScope) {
          return { status: "refused", code: "COMPILED_INTENT_REPLAY_CAPACITY", retryAfterSeconds: RETRY_AFTER_SECONDS };
        }
        const resultMac = this.resultMac(identity, normalized);
        connection.run(
          "INSERT INTO compiled_intent_replay_records (session_key, expected_generation, scope_key, request_key, catalog_key, result_kind, mechanism_keys_json, result_mac, state, created_at_ms, quarantined_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, NULL)",
          [identity.sessionKey, this.generationFor(identity), identity.scopeKey, identity.requestKey, identity.catalogKey, normalized.kind, JSON.stringify(normalized.mechanismKeys), resultMac, this.clock()],
        );
        if (!this.changedExactlyOnce(connection)) {
          throw new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", "compiled intent replay insert was not acknowledged");
        }
        return { status: "stored", value: normalized };
      });
    } catch (error) {
      const failure = mapFailure(error);
      return { status: "refused", code: failure.code, retryAfterSeconds: RETRY_AFTER_SECONDS };
    }
  }

  /** A corrupted/mismatched replay result cannot become another provider attempt. */
  quarantineReplayResult(identity: CompiledIntentReplayIdentity): boolean {
    this.assertIdentity(identity);
    try {
      return this.transaction((connection) => {
        const row = this.find(connection, identity);
        if (!row) return false;
        this.quarantineRow(connection, row, identity);
        return true;
      });
    } catch {
      return false;
    }
  }

  private decode(row: StoredReplayRow, identity: CompiledIntentReplayIdentity): { status: "ok"; value: CompiledIntentReplayResult } | { status: "invalid"; code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" | "COMPILED_INTENT_REPLAY_CONFLICT" } {
    if (!validHash(row.session_key) || !validGeneration(row.expected_generation) || !validHash(row.scope_key)
      || !validHash(row.request_key) || !validHash(row.catalog_key) || (row.state !== "available" && row.state !== "quarantined")) {
      return { status: "invalid", code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" };
    }
    if (row.session_key !== identity.sessionKey || row.expected_generation !== this.generationFor(identity)
      || row.scope_key !== identity.scopeKey || row.request_key !== identity.requestKey || row.catalog_key !== identity.catalogKey) {
      return { status: "invalid", code: "COMPILED_INTENT_REPLAY_CONFLICT" };
    }
    if (row.state !== "available" || (row.result_kind !== "selected" && row.result_kind !== "ambiguous" && row.result_kind !== "no_match")
      || typeof row.mechanism_keys_json !== "string"
      || row.mechanism_keys_json.length > MAX_REPLAY_MECHANISM_KEYS_JSON_LENGTH
      || !validHash(row.result_mac)) {
      return { status: "invalid", code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" };
    }
    let mechanismKeys: unknown;
    try { mechanismKeys = JSON.parse(row.mechanism_keys_json); } catch { return { status: "invalid", code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" }; }
    if (!Array.isArray(mechanismKeys) || !mechanismKeys.every(validHash)) return { status: "invalid", code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" };
    const value = Object.freeze({ kind: row.result_kind, mechanismKeys: Object.freeze([...mechanismKeys]) }) as CompiledIntentReplayResult;
    if (!validResult(value) || !this.matchesResultMac(identity, value, row.result_mac)) {
      return { status: "invalid", code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" };
    }
    return { status: "ok", value };
  }

  private find(connection: ReplayConnection, identity: CompiledIntentReplayIdentity): StoredReplayRow | undefined {
    return connection.get<StoredReplayRow>(
      `SELECT
        CASE WHEN typeof(session_key) = 'text' AND length(CAST(session_key AS BLOB)) <= 64 THEN session_key ELSE NULL END AS session_key,
        CASE WHEN typeof(expected_generation) = 'integer' THEN expected_generation ELSE NULL END AS expected_generation,
        CASE WHEN typeof(scope_key) = 'text' AND length(CAST(scope_key AS BLOB)) <= 64 THEN scope_key ELSE NULL END AS scope_key,
        CASE WHEN typeof(request_key) = 'text' AND length(CAST(request_key AS BLOB)) <= 64 THEN request_key ELSE NULL END AS request_key,
        CASE WHEN typeof(catalog_key) = 'text' AND length(CAST(catalog_key AS BLOB)) <= 64 THEN catalog_key ELSE NULL END AS catalog_key,
        CASE WHEN typeof(result_kind) = 'text' AND length(CAST(result_kind AS BLOB)) <= 9 THEN result_kind ELSE NULL END AS result_kind,
        CASE WHEN typeof(mechanism_keys_json) = 'text' AND length(CAST(mechanism_keys_json AS BLOB)) <= ${MAX_REPLAY_MECHANISM_KEYS_JSON_LENGTH} THEN mechanism_keys_json ELSE NULL END AS mechanism_keys_json,
        CASE WHEN typeof(result_mac) = 'text' AND length(CAST(result_mac AS BLOB)) <= 64 THEN result_mac ELSE NULL END AS result_mac,
        CASE WHEN typeof(state) = 'text' AND length(CAST(state AS BLOB)) <= 11 THEN state ELSE NULL END AS state
      FROM compiled_intent_replay_records WHERE scope_key = ? AND request_key = ?`,
      [identity.scopeKey, identity.requestKey],
    );
  }

  private clearOlderGenerations(connection: ReplayConnection, identity: CompiledIntentReplayIdentity): void {
    connection.run(
      "DELETE FROM compiled_intent_replay_records WHERE session_key = ? AND expected_generation < ?",
      [identity.sessionKey, this.generationFor(identity)],
    );
  }

  private scopeCount(connection: ReplayConnection, identity: CompiledIntentReplayIdentity): number {
    const count = connection.get<{ count: unknown }>("SELECT COUNT(*) AS count FROM compiled_intent_replay_records WHERE scope_key = ?", [identity.scopeKey])?.count;
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", "compiled intent replay scope count is invalid");
    }
    return count as number;
  }

  private resultMac(identity: CompiledIntentReplayIdentity, result: CompiledIntentReplayResult): string {
    return createHmac("sha256", Buffer.from(identity.integrityKey, "hex"))
      .update(JSON.stringify({
        domain: "compiled-intent-replay-result-v1",
        scopeKey: identity.scopeKey,
        requestKey: identity.requestKey,
        catalogKey: identity.catalogKey,
        expectedGeneration: identity.expectedGeneration,
        result: { kind: result.kind, mechanismKeys: result.mechanismKeys },
      }))
      .digest("hex");
  }

  private matchesResultMac(identity: CompiledIntentReplayIdentity, result: CompiledIntentReplayResult, storedMac: string): boolean {
    const expected = this.resultMac(identity, result);
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(storedMac, "hex"));
  }

  private quarantineRow(connection: ReplayConnection, row: StoredReplayRow, identity: CompiledIntentReplayIdentity): void {
    if (row.state === "quarantined") return;
    connection.run(
      "UPDATE compiled_intent_replay_records SET state = 'quarantined', quarantined_at_ms = ? WHERE scope_key = ? AND request_key = ? AND state = 'available'",
      [this.clock(), identity.scopeKey, identity.requestKey],
    );
    if (!this.changedExactlyOnce(connection)) {
      throw new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", "compiled intent replay quarantine was not acknowledged");
    }
  }

  private generationFor(identity: CompiledIntentReplayIdentity): number {
    if (!validGeneration(identity.expectedGeneration)) throw new Error("compiled intent replay generation is invalid");
    return identity.expectedGeneration;
  }

  private changedExactlyOnce(connection: ReplayConnection): boolean {
    return connection.get<{ changes: unknown }>("SELECT changes() AS changes")?.changes === 1;
  }

  private assertIdentity(identity: CompiledIntentReplayIdentity): void {
    if (!identity || !validHash(identity.sessionKey) || !validGeneration(identity.expectedGeneration) || !validHash(identity.scopeKey) || !validHash(identity.requestKey) || !validHash(identity.catalogKey) || !validHash(identity.integrityKey)
      || !Array.isArray(identity.mechanismKeys) || identity.mechanismKeys.length > MAX_REPLAY_MECHANISM_KEYS
      || identity.mechanismKeys.some((entry) => !entry || typeof entry.mechanismId !== "string" || !entry.mechanismId || !validHash(entry.key))
      || new Set(identity.mechanismKeys.map((entry) => entry.mechanismId)).size !== identity.mechanismKeys.length
      || new Set(identity.mechanismKeys.map((entry) => entry.key)).size !== identity.mechanismKeys.length) {
      throw new Error("compiled intent replay identity is invalid");
    }
  }

  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("compiled intent replay clock is invalid");
    return now;
  }

  private transaction<T>(body: (connection: ReplayConnection) => T): T {
    const connection = this.open();
    let begun = false;
    let committed = false;
    try {
      connection.run("BEGIN IMMEDIATE"); begun = true;
      this.initializePolicy(connection);
      const result = body(connection);
      try {
        connection.run("COMMIT"); committed = true; begun = false;
      } catch {
        // A successful provider followed by an unacknowledged result write is
        // unknowable. The caller must retain/quarantine its admission lease.
        throw new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", "compiled intent replay commit is indeterminate");
      }
      return result;
    } catch (error) {
      if (begun) { try { connection.run("ROLLBACK"); } catch { /* close still releases a SQLite transaction */ } }
      throw error;
    } finally {
      try { connection.close(true); }
      catch (closeError) { if (!committed) throw mapFailure(closeError); }
    }
  }

  private initializePolicy(connection: ReplayConnection): void {
    connection.run("CREATE TABLE IF NOT EXISTS compiled_intent_replay_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL, max_records_per_scope INTEGER NOT NULL)");
    connection.run("CREATE TABLE IF NOT EXISTS compiled_intent_replay_records (session_key TEXT NOT NULL, expected_generation INTEGER NOT NULL, scope_key TEXT NOT NULL, request_key TEXT NOT NULL, catalog_key TEXT NOT NULL, result_kind TEXT NOT NULL CHECK (result_kind IN ('selected', 'ambiguous', 'no_match')), mechanism_keys_json TEXT NOT NULL, result_mac TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('available', 'quarantined')), created_at_ms INTEGER NOT NULL, quarantined_at_ms INTEGER, PRIMARY KEY (scope_key, request_key))");
    connection.run("CREATE INDEX IF NOT EXISTS compiled_intent_replay_session_generation ON compiled_intent_replay_records (session_key, expected_generation)");
    const stored = connection.get<StoredPolicy>("SELECT schema_version, coordinator_domain, max_records_per_scope FROM compiled_intent_replay_policy WHERE singleton = 1");
    if (!stored) {
      connection.run("INSERT INTO compiled_intent_replay_policy (singleton, schema_version, coordinator_domain, max_records_per_scope) VALUES (1, ?, ?, ?)", [COMPILED_INTENT_REPLAY_SCHEMA_VERSION, COMPILED_INTENT_REPLAY_DOMAIN, this.maxRecordsPerScope]);
      return;
    }
    if (stored.schema_version !== COMPILED_INTENT_REPLAY_SCHEMA_VERSION || stored.coordinator_domain !== COMPILED_INTENT_REPLAY_DOMAIN || stored.max_records_per_scope !== this.maxRecordsPerScope) {
      throw new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", "compiled intent replay policy differs from this process configuration");
    }
  }

  private open(): ReplayConnection {
    let connection: ReplayConnection | undefined;
    try {
      this.assertSafePaths();
      connection = this.connectionFactory(this.file, REPLAY_OPEN_FLAGS);
      connection.run(`PRAGMA busy_timeout = ${COMPILED_INTENT_REPLAY_PRODUCTION_POLICY.busyTimeoutMs}`);
      connection.run("PRAGMA journal_mode = DELETE");
      connection.run("PRAGMA synchronous = FULL");
      connection.run("PRAGMA locking_mode = NORMAL");
      const journal = String(connection.pragma("journal_mode") ?? "").toLowerCase();
      const synchronous = connection.pragma("synchronous");
      const locking = String(connection.pragma("locking_mode") ?? "").toLowerCase();
      const timeout = connection.pragma("busy_timeout");
      if (journal !== "delete" || !(synchronous === 2 || String(synchronous).toLowerCase() === "full") || locking !== "normal" || timeout !== COMPILED_INTENT_REPLAY_PRODUCTION_POLICY.busyTimeoutMs) {
        throw new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", "compiled intent replay SQLite durability policy could not be verified");
      }
      this.assertSafePaths();
      return connection;
    } catch (error) {
      if (connection) { try { connection.close(true); } catch { /* original storage fault remains authoritative */ } }
      throw mapFailure(error);
    }
  }

  private assertSafePaths(): void {
    if (this.pathOps.kind(this.root) !== "directory") {
      throw new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", "compiled intent replay root is not a real directory");
    }
    for (const path of [this.file, `${this.file}-journal`, `${this.file}-wal`, `${this.file}-shm`]) {
      const kind = this.pathOps.kind(path);
      if (kind !== "missing" && kind !== "regular") {
        throw new ReplayFailure("COMPILED_INTENT_REPLAY_UNAVAILABLE", "compiled intent replay SQLite path is unsafe");
      }
    }
  }
}
