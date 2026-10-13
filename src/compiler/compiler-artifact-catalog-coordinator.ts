import { Database, constants } from "bun:sqlite";
import { lstatSync } from "fs";
import { join } from "path";

export const COMPILER_ARTIFACT_CATALOG_COORDINATOR_SCHEMA_VERSION = "1.0.0";
export const COMPILER_ARTIFACT_CATALOG_SQLITE_OPEN_FLAGS = constants.SQLITE_OPEN_READWRITE
  | constants.SQLITE_OPEN_CREATE
  | constants.SQLITE_OPEN_NOFOLLOW
  | constants.SQLITE_OPEN_FULLMUTEX
  | constants.SQLITE_OPEN_EXRESCODE;

export type CatalogCoordinatorFailureCode = "CATALOG_BUSY" | "CATALOG_POLICY_MISMATCH" | "CATALOG_STORAGE_FAILED";

export class CatalogCoordinatorFailure extends Error {
  constructor(readonly code: CatalogCoordinatorFailureCode, message: string) { super(message); }
}

interface StoredPolicy { schema_version: string; max_entries: number; max_bytes: number; }

export interface CatalogCoordinatorConnection {
  run(sql: string, bindings?: readonly (string | number)[]): void;
  policy(): StoredPolicy | undefined;
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown;
  close(throwOnError: true): void;
}

export interface CatalogCoordinatorPathOps { kind(path: string): "missing" | "regular" | "unsafe"; }
export interface CatalogCoordinatorOptions {
  connectionFactory?: (file: string, flags: number) => CatalogCoordinatorConnection;
  pathOps?: CatalogCoordinatorPathOps;
}
export interface CatalogPublicationFinish { rollbackFailure?: CatalogCoordinatorFailure; closeFailure?: CatalogCoordinatorFailure; }
export interface CompilerArtifactCatalogCoordinatorLike {
  initializePolicy(): void;
  beginPublication(): void;
  finishPublication(): CatalogPublicationFinish;
}

function asCoordinatorFailure(error: unknown): CatalogCoordinatorFailure {
  if (error instanceof CatalogCoordinatorFailure) return error;
  const record = error as { code?: string } | undefined;
  const message = error instanceof Error ? error.message : "catalog SQLite coordination failed";
  if (record?.code === "SQLITE_BUSY" || record?.code === "SQLITE_LOCKED" || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(message)) {
    return new CatalogCoordinatorFailure("CATALOG_BUSY", "catalog publication is busy");
  }
  return new CatalogCoordinatorFailure("CATALOG_STORAGE_FAILED", message);
}

const nodePathOps: CatalogCoordinatorPathOps = {
  kind(path) {
    try {
      const stat = lstatSync(path);
      // Leaf-only rejection: deployment ACLs and ancestor TOCTOU remain
      // operational controls, not guarantees this code claims to solve.
      return stat.isFile() && !stat.isSymbolicLink() ? "regular" : "unsafe";
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "missing";
      throw error;
    }
  },
};

class BunCatalogCoordinatorConnection implements CatalogCoordinatorConnection {
  constructor(private readonly database: Database) {}
  run(sql: string, bindings: readonly (string | number)[] = []): void {
    if (bindings.length) this.database.run(sql, [...bindings]); else this.database.run(sql);
  }
  policy(): StoredPolicy | undefined {
    return this.database.query<StoredPolicy, []>("SELECT schema_version, max_entries, max_bytes FROM catalog_policy WHERE singleton = 1").get() ?? undefined;
  }
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown {
    const row = this.database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : undefined;
  }
  close(throwOnError: true): void { this.database.close(throwOnError); }
}

function bunConnectionFactory(file: string, flags: number): CatalogCoordinatorConnection {
  return new BunCatalogCoordinatorConnection(new Database(file, flags));
}

/** SQLite supplies the OS lock; catalog JSON remains the artifact source of truth. */
export class CompilerArtifactCatalogCoordinator implements CompilerArtifactCatalogCoordinatorLike {
  private connection: CatalogCoordinatorConnection | undefined;
  private transactionOpen = false;
  readonly file: string;
  private readonly pathOps: CatalogCoordinatorPathOps;
  private readonly connectionFactory: (file: string, flags: number) => CatalogCoordinatorConnection;

  constructor(root: string, private readonly schemaVersion: string, private readonly maxEntries: number, private readonly maxBytes: number, options: CatalogCoordinatorOptions = {}) {
    this.file = join(root, ".catalog-write.sqlite");
    this.pathOps = options.pathOps ?? nodePathOps;
    this.connectionFactory = options.connectionFactory ?? bunConnectionFactory;
  }

  initializePolicy(): void {
    const connection = this.open();
    try {
      connection.run("BEGIN IMMEDIATE"); this.transactionOpen = true;
      connection.run("CREATE TABLE IF NOT EXISTS catalog_policy (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, max_entries INTEGER NOT NULL, max_bytes INTEGER NOT NULL)");
      const stored = connection.policy();
      if (!stored) {
        connection.run("INSERT INTO catalog_policy (singleton, schema_version, max_entries, max_bytes) VALUES (1, ?, ?, ?)", [this.schemaVersion, this.maxEntries, this.maxBytes]);
        this.endTransaction("COMMIT");
        return;
      }
      if (stored.schema_version !== this.schemaVersion || stored.max_entries !== this.maxEntries || stored.max_bytes !== this.maxBytes) {
        throw new CatalogCoordinatorFailure("CATALOG_POLICY_MISMATCH", "catalog root policy differs from this process configuration");
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

  finishPublication(): CatalogPublicationFinish {
    const outcome: CatalogPublicationFinish = {};
    const connection = this.connection;
    if (!connection) return outcome;
    if (this.transactionOpen) {
      try { this.endTransaction("ROLLBACK"); }
      catch (error) { outcome.rollbackFailure = asCoordinatorFailure(error); }
    }
    // Always attempt close after a rollback failure. A successful close releases
    // the OS lock for this write-free publication transaction.
    try { connection.close(true); this.connection = undefined; this.transactionOpen = false; }
    catch (error) { outcome.closeFailure = asCoordinatorFailure(error); }
    return outcome;
  }

  private open(): CatalogCoordinatorConnection {
    if (this.connection) return this.connection;
    try {
      this.assertSafeDatabasePaths();
      const connection = this.connectionFactory(this.file, COMPILER_ARTIFACT_CATALOG_SQLITE_OPEN_FLAGS);
      this.connection = connection;
      this.configureConnection(connection);
      this.assertSafeDatabasePaths();
      return connection;
    } catch (error) { throw asCoordinatorFailure(error); }
  }

  private assertSafeDatabasePaths(): void {
    for (const path of [this.file, `${this.file}-journal`, `${this.file}-wal`, `${this.file}-shm`]) {
      if (this.pathOps.kind(path) === "unsafe") throw new CatalogCoordinatorFailure("CATALOG_STORAGE_FAILED", "catalog SQLite file or sidecar is not a regular non-link file");
    }
  }

  private configureConnection(connection: CatalogCoordinatorConnection): void {
    connection.run("PRAGMA journal_mode = DELETE");
    connection.run("PRAGMA synchronous = FULL");
    connection.run("PRAGMA locking_mode = NORMAL");
    connection.run("PRAGMA busy_timeout = 0");
    const journal = String(connection.pragma("journal_mode") ?? "").toLowerCase();
    const synchronous = connection.pragma("synchronous");
    const locking = String(connection.pragma("locking_mode") ?? "").toLowerCase();
    const timeout = connection.pragma("busy_timeout");
    if (journal !== "delete" || !(synchronous === 2 || String(synchronous).toLowerCase() === "full") || locking !== "normal" || timeout !== 0) {
      throw new CatalogCoordinatorFailure("CATALOG_STORAGE_FAILED", "catalog SQLite durability or locking pragma could not be verified");
    }
  }

  private endTransaction(statement: "COMMIT" | "ROLLBACK"): void {
    if (!this.transactionOpen) return;
    this.open().run(statement);
    this.transactionOpen = false;
  }

  private abortInitializationTransaction(): void {
    if (!this.transactionOpen) return;
    try { this.open().run("ROLLBACK"); } catch { /* finishPublication still closes the handle */ }
    this.transactionOpen = false;
  }
}
