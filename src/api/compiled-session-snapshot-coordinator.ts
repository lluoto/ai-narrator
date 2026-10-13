import { Database, constants } from "bun:sqlite";
import { lstatSync } from "fs";
import { join } from "path";

/** Deliberately independent from the catalog coordinator and its policy DB. */
export const COMPILED_SESSION_SNAPSHOT_COORDINATOR_SCHEMA_VERSION = "1.1.0";
export const COMPILED_SESSION_SNAPSHOT_SQLITE_OPEN_FLAGS = constants.SQLITE_OPEN_READWRITE
  | constants.SQLITE_OPEN_CREATE
  | constants.SQLITE_OPEN_NOFOLLOW
  | constants.SQLITE_OPEN_FULLMUTEX
  | constants.SQLITE_OPEN_EXRESCODE;

export type SnapshotCoordinatorFailureCode = "SNAPSHOT_BUSY" | "SNAPSHOT_STORAGE_FAILED" | "SNAPSHOT_POLICY_MISMATCH" | "SNAPSHOT_QUOTA_EXCEEDED" | "SNAPSHOT_CORRUPT";

export class SnapshotCoordinatorFailure extends Error {
  constructor(readonly code: SnapshotCoordinatorFailureCode, message: string) { super(message); }
}

export interface SnapshotCoordinatorPolicy {
  schemaVersion: string;
  maxEntries: number;
  maxBytes: number;
}

interface StoredPolicy {
  schema_version: string;
  coordinator_domain: string;
  max_entries: number;
  max_bytes: number;
}

type SnapshotCoordinatorBinding = string | number;

export interface SnapshotCoordinatorConnection {
  run(sql: string, bindings?: readonly SnapshotCoordinatorBinding[]): void;
  policy(): StoredPolicy | undefined;
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown;
  close(throwOnError: true): void;
}

export interface SnapshotCoordinatorPathOps { kind(path: string): "missing" | "regular" | "unsafe"; }
export interface SnapshotCoordinatorOptions {
  connectionFactory?: (file: string, flags: number) => SnapshotCoordinatorConnection;
  pathOps?: SnapshotCoordinatorPathOps;
  /** A persistence format gets its own lock identity; callers must not share a CAS domain accidentally. */
  domain?: string;
  /** A format-specific filename keeps independent coordinators from sharing a SQLite policy file. */
  fileName?: string;
}
export interface SnapshotPublicationFinish { rollbackFailure?: SnapshotCoordinatorFailure; closeFailure?: SnapshotCoordinatorFailure; }
export interface CompiledSessionSnapshotCoordinatorLike {
  initializePolicy(policy?: SnapshotCoordinatorPolicy): void;
  beginPublication(): void;
  finishPublication(): SnapshotPublicationFinish;
}

const COORDINATOR_DOMAIN = "compiled-session-snapshot-cas";

function asCoordinatorFailure(error: unknown): SnapshotCoordinatorFailure {
  if (error instanceof SnapshotCoordinatorFailure) return error;
  const record = error as { code?: string } | undefined;
  const message = error instanceof Error ? error.message : "snapshot SQLite coordination failed";
  if (/no such column|has no column/i.test(message)) {
    return new SnapshotCoordinatorFailure("SNAPSHOT_POLICY_MISMATCH", "snapshot coordinator schema does not contain the required quota policy");
  }
  if (record?.code === "SQLITE_BUSY" || record?.code === "SQLITE_LOCKED" || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(message)) {
    return new SnapshotCoordinatorFailure("SNAPSHOT_BUSY", "snapshot publication is busy");
  }
  return new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", message);
}

const nodePathOps: SnapshotCoordinatorPathOps = {
  kind(path) {
    try {
      const stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink() ? "regular" : "unsafe";
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "missing";
      throw error;
    }
  },
};

class BunSnapshotCoordinatorConnection implements SnapshotCoordinatorConnection {
  constructor(private readonly database: Database) {}
  run(sql: string, bindings: readonly SnapshotCoordinatorBinding[] = []): void {
    if (bindings.length) this.database.run(sql, [...bindings]); else this.database.run(sql);
  }
  policy(): StoredPolicy | undefined {
    try {
      return this.database.query<StoredPolicy, []>("SELECT schema_version, coordinator_domain, max_entries, max_bytes FROM snapshot_coordinator_policy WHERE singleton = 1").get() ?? undefined;
    } catch (error) {
      if (/no such column|has no column/i.test(error instanceof Error ? error.message : "")) {
        throw new SnapshotCoordinatorFailure("SNAPSHOT_POLICY_MISMATCH", "snapshot coordinator schema does not contain the required quota policy");
      }
      throw error;
    }
  }
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown {
    const row = this.database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : undefined;
  }
  close(throwOnError: true): void { this.database.close(throwOnError); }
}

function bunConnectionFactory(file: string, flags: number): SnapshotCoordinatorConnection {
  return new BunSnapshotCoordinatorConnection(new Database(file, flags));
}

/**
 * SQLite only serializes the filesystem CAS protocol. It stores no snapshot
 * hash, header, or generation and therefore cannot be confused with catalog
 * identity or source-of-truth data.
 */
export class CompiledSessionSnapshotCoordinator implements CompiledSessionSnapshotCoordinatorLike {
  private connection: SnapshotCoordinatorConnection | undefined;
  private transactionOpen = false;
  readonly file: string;
  private readonly pathOps: SnapshotCoordinatorPathOps;
  private readonly connectionFactory: (file: string, flags: number) => SnapshotCoordinatorConnection;
  private readonly domain: string;

  constructor(root: string, private readonly schemaVersion = COMPILED_SESSION_SNAPSHOT_COORDINATOR_SCHEMA_VERSION, options: SnapshotCoordinatorOptions = {}) {
    this.domain = options.domain ?? COORDINATOR_DOMAIN;
    if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(this.domain)) {
      throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot coordinator domain is invalid");
    }
    const fileName = options.fileName ?? ".compiled-session-snapshot-write.sqlite";
    if (!/^\.[A-Za-z0-9_-]{1,128}\.sqlite$/.test(fileName)) {
      throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot coordinator filename is invalid");
    }
    this.file = join(root, fileName);
    this.pathOps = options.pathOps ?? nodePathOps;
    this.connectionFactory = options.connectionFactory ?? bunConnectionFactory;
  }

  initializePolicy(policy: SnapshotCoordinatorPolicy = { schemaVersion: this.schemaVersion, maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }): void {
    if (!Number.isSafeInteger(policy.maxEntries) || policy.maxEntries < 0 || !Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 0) {
      throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot quota policy is invalid");
    }
    const connection = this.open();
    try {
      connection.run("BEGIN IMMEDIATE"); this.transactionOpen = true;
      connection.run("CREATE TABLE IF NOT EXISTS snapshot_coordinator_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL, max_entries INTEGER NOT NULL, max_bytes INTEGER NOT NULL)");
      const stored = connection.policy();
      if (!stored) {
        connection.run("INSERT INTO snapshot_coordinator_policy (singleton, schema_version, coordinator_domain, max_entries, max_bytes) VALUES (1, ?, ?, ?, ?)", [policy.schemaVersion, this.domain, policy.maxEntries, policy.maxBytes]);
        this.endTransaction("COMMIT");
        return;
      }
      if (stored.schema_version !== policy.schemaVersion || stored.coordinator_domain !== this.domain || stored.max_entries !== policy.maxEntries || stored.max_bytes !== policy.maxBytes) {
        throw new SnapshotCoordinatorFailure("SNAPSHOT_POLICY_MISMATCH", "snapshot coordinator policy differs from this process configuration");
      }
      this.endTransaction("ROLLBACK");
    } catch (error) {
      this.abortInitializationTransaction();
      throw asCoordinatorFailure(error);
    }
  }

  beginPublication(): void {
    try { this.open().run("BEGIN IMMEDIATE"); this.transactionOpen = true; }
    catch (error) { throw asCoordinatorFailure(error); }
  }

  finishPublication(): SnapshotPublicationFinish {
    const outcome: SnapshotPublicationFinish = {};
    const connection = this.connection;
    if (!connection) return outcome;
    if (this.transactionOpen) {
      try { this.endTransaction("ROLLBACK"); }
      catch (error) { outcome.rollbackFailure = asCoordinatorFailure(error); }
    }
    try { connection.close(true); this.connection = undefined; this.transactionOpen = false; }
    catch (error) { outcome.closeFailure = asCoordinatorFailure(error); }
    return outcome;
  }

  private open(): SnapshotCoordinatorConnection {
    if (this.connection) return this.connection;
    try {
      this.assertSafeDatabasePaths();
      const connection = this.connectionFactory(this.file, COMPILED_SESSION_SNAPSHOT_SQLITE_OPEN_FLAGS);
      this.connection = connection;
      this.configureConnection(connection);
      this.assertSafeDatabasePaths();
      return connection;
    } catch (error) { throw asCoordinatorFailure(error); }
  }

  private assertSafeDatabasePaths(): void {
    for (const path of [this.file, `${this.file}-journal`, `${this.file}-wal`, `${this.file}-shm`]) {
      if (this.pathOps.kind(path) === "unsafe") throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot SQLite file or sidecar is not a regular non-link file");
    }
  }

  private configureConnection(connection: SnapshotCoordinatorConnection): void {
    connection.run("PRAGMA journal_mode = DELETE");
    connection.run("PRAGMA synchronous = FULL");
    connection.run("PRAGMA locking_mode = NORMAL");
    connection.run("PRAGMA busy_timeout = 0");
    const journal = String(connection.pragma("journal_mode") ?? "").toLowerCase();
    const synchronous = connection.pragma("synchronous");
    const locking = String(connection.pragma("locking_mode") ?? "").toLowerCase();
    const timeout = connection.pragma("busy_timeout");
    if (journal !== "delete" || !(synchronous === 2 || String(synchronous).toLowerCase() === "full") || locking !== "normal" || timeout !== 0) {
      throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot SQLite durability or locking pragma could not be verified");
    }
  }

  private endTransaction(statement: "COMMIT" | "ROLLBACK"): void {
    if (!this.transactionOpen) return;
    this.open().run(statement);
    this.transactionOpen = false;
  }

  private abortInitializationTransaction(): void {
    if (!this.transactionOpen) return;
    try { this.open().run("ROLLBACK"); } catch { /* close still releases the lock */ }
    this.transactionOpen = false;
  }
}
