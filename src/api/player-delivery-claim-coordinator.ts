import { Database, constants } from "bun:sqlite";
import { lstatSync } from "fs";
import { join } from "path";

/** This lock has a separate identity from every snapshot/catalog coordinator. */
export const COMPILED_PLAYER_DELIVERY_CLAIM_COORDINATOR_SCHEMA_VERSION = "1.0.0";
export const COMPILED_PLAYER_DELIVERY_CLAIM_WRITER_PROTOCOL = "link-fsync-first-winner-v1";
export const COMPILED_PLAYER_DELIVERY_CLAIM_SQLITE_OPEN_FLAGS = constants.SQLITE_OPEN_READWRITE
  | constants.SQLITE_OPEN_CREATE
  | constants.SQLITE_OPEN_NOFOLLOW
  | constants.SQLITE_OPEN_FULLMUTEX
  | constants.SQLITE_OPEN_EXRESCODE;

export type PlayerDeliveryClaimCoordinatorFailureCode =
  | "CLAIM_COORDINATOR_BUSY"
  | "CLAIM_COORDINATOR_STORAGE_FAILED"
  | "CLAIM_COORDINATOR_POLICY_MISMATCH";

export class PlayerDeliveryClaimCoordinatorFailure extends Error {
  constructor(readonly code: PlayerDeliveryClaimCoordinatorFailureCode, message: string) {
    super(message);
    this.name = "PlayerDeliveryClaimCoordinatorFailure";
  }
}

export interface PlayerDeliveryClaimCoordinatorPolicy {
  schemaVersion: string;
  writerProtocol: string;
}

interface StoredPlayerDeliveryClaimCoordinatorPolicy {
  schema_version: string;
  coordinator_domain: string;
  writer_protocol: string;
}

type CoordinatorBinding = string | number;

export interface PlayerDeliveryClaimCoordinatorConnection {
  run(sql: string, bindings?: readonly CoordinatorBinding[]): void;
  policy(): StoredPlayerDeliveryClaimCoordinatorPolicy | undefined;
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown;
  close(throwOnError: true): void;
}

export interface PlayerDeliveryClaimCoordinatorPathOps {
  kind(path: string): "missing" | "regular" | "unsafe";
}

export interface PlayerDeliveryClaimCoordinatorOptions {
  connectionFactory?: (file: string, flags: number) => PlayerDeliveryClaimCoordinatorConnection;
  pathOps?: PlayerDeliveryClaimCoordinatorPathOps;
  domain?: string;
  fileName?: string;
}

/** Test seams may use this exact API, but production always uses the SQLite coordinator. */
export interface CompiledPlayerDeliveryClaimCoordinatorLike {
  initialize(): void;
  withExclusive<T>(callback: () => T): T;
}

const COORDINATOR_DOMAIN = "compiled-player-delivery-claim-publication";
const POLICY_TABLE = "compiled_player_delivery_claim_coordinator_policy";

function asCoordinatorFailure(error: unknown): PlayerDeliveryClaimCoordinatorFailure {
  if (error instanceof PlayerDeliveryClaimCoordinatorFailure) return error;
  const record = error as { code?: string } | undefined;
  const message = error instanceof Error ? error.message : "player delivery claim SQLite coordination failed";
  if (/no such column|has no column|no such table|malformed database schema/i.test(message)) {
    return new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_POLICY_MISMATCH", "player delivery claim coordinator policy schema is incompatible");
  }
  if (record?.code === "SQLITE_BUSY" || record?.code === "SQLITE_LOCKED" || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(message)) {
    return new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_BUSY", "player delivery claim publication is busy");
  }
  return new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_STORAGE_FAILED", message);
}

const nodePathOps: PlayerDeliveryClaimCoordinatorPathOps = {
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

class BunPlayerDeliveryClaimCoordinatorConnection implements PlayerDeliveryClaimCoordinatorConnection {
  constructor(private readonly database: Database) {}

  run(sql: string, bindings: readonly CoordinatorBinding[] = []): void {
    if (bindings.length) this.database.run(sql, [...bindings]); else this.database.run(sql);
  }

  policy(): StoredPlayerDeliveryClaimCoordinatorPolicy | undefined {
    try {
      return this.database.query<StoredPlayerDeliveryClaimCoordinatorPolicy, []>(
        `SELECT schema_version, coordinator_domain, writer_protocol FROM ${POLICY_TABLE} WHERE singleton = 1`,
      ).get() ?? undefined;
    } catch (error) {
      if (/no such column|has no column|no such table/i.test(error instanceof Error ? error.message : "")) {
        throw new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_POLICY_MISMATCH", "player delivery claim coordinator policy schema is incompatible");
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

function bunConnectionFactory(file: string, flags: number): PlayerDeliveryClaimCoordinatorConnection {
  return new BunPlayerDeliveryClaimCoordinatorConnection(new Database(file, flags));
}

/**
 * A small, format-owned SQLite mutex for claim publication. The database
 * records only an immutable protocol policy; claim records remain files.
 */
export class CompiledPlayerDeliveryClaimCoordinator implements CompiledPlayerDeliveryClaimCoordinatorLike {
  readonly file: string;
  private readonly pathOps: PlayerDeliveryClaimCoordinatorPathOps;
  private readonly connectionFactory: (file: string, flags: number) => PlayerDeliveryClaimCoordinatorConnection;
  private readonly domain: string;
  private readonly policy: PlayerDeliveryClaimCoordinatorPolicy;

  constructor(
    root: string,
    schemaVersion = COMPILED_PLAYER_DELIVERY_CLAIM_COORDINATOR_SCHEMA_VERSION,
    options: PlayerDeliveryClaimCoordinatorOptions = {},
  ) {
    this.domain = options.domain ?? COORDINATOR_DOMAIN;
    if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(this.domain)) {
      throw new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_STORAGE_FAILED", "player delivery claim coordinator domain is invalid");
    }
    if (!/^\d+\.\d+\.\d+$/.test(schemaVersion)) {
      throw new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_STORAGE_FAILED", "player delivery claim coordinator schema version is invalid");
    }
    const fileName = options.fileName ?? ".compiled-player-delivery-claim-coordinator.sqlite";
    if (!/^\.[A-Za-z0-9_-]{1,128}\.sqlite$/.test(fileName)) {
      throw new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_STORAGE_FAILED", "player delivery claim coordinator filename is invalid");
    }
    this.file = join(root, fileName);
    this.pathOps = options.pathOps ?? nodePathOps;
    this.connectionFactory = options.connectionFactory ?? bunConnectionFactory;
    this.policy = { schemaVersion, writerProtocol: COMPILED_PLAYER_DELIVERY_CLAIM_WRITER_PROTOCOL };
  }

  initialize(): void {
    const connection = this.open();
    let transactionOpen = false;
    let failure: unknown;
    try {
      connection.run("BEGIN IMMEDIATE");
      transactionOpen = true;
      connection.run(`CREATE TABLE IF NOT EXISTS ${POLICY_TABLE} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version TEXT NOT NULL, coordinator_domain TEXT NOT NULL, writer_protocol TEXT NOT NULL)`);
      const stored = connection.policy();
      if (!stored) {
        connection.run(
          `INSERT INTO ${POLICY_TABLE} (singleton, schema_version, coordinator_domain, writer_protocol) VALUES (1, ?, ?, ?)`,
          [this.policy.schemaVersion, this.domain, this.policy.writerProtocol],
        );
      } else {
        this.assertPolicy(stored);
      }
      connection.run("COMMIT");
      transactionOpen = false;
    } catch (error) {
      failure = asCoordinatorFailure(error);
    }
    this.finish(connection, transactionOpen, failure);
  }

  withExclusive<T>(callback: () => T): T {
    const connection = this.open();
    let transactionOpen = false;
    let value: T | undefined;
    let failure: unknown;
    try {
      connection.run("BEGIN IMMEDIATE");
      transactionOpen = true;
      this.assertPolicy(connection.policy());
    } catch (error) {
      failure = asCoordinatorFailure(error);
    }
    if (!failure) {
      try {
        value = callback();
        if (value && typeof (value as unknown as { then?: unknown }).then === "function") {
          throw new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_STORAGE_FAILED", "player delivery claim exclusive callback must be synchronous");
        }
      } catch (error) {
        // Callback exceptions are application failures, not SQLite failures.
        failure = error;
      }
    }
    this.finish(connection, transactionOpen, failure);
    return value as T;
  }

  private open(): PlayerDeliveryClaimCoordinatorConnection {
    try {
      this.assertSafeDatabasePaths();
      const connection = this.connectionFactory(this.file, COMPILED_PLAYER_DELIVERY_CLAIM_SQLITE_OPEN_FLAGS);
      try {
        this.configureConnection(connection);
        this.assertSafeDatabasePaths();
        return connection;
      } catch (error) {
        try { connection.close(true); }
        catch (closeError) {
          const primary = asCoordinatorFailure(error);
          Object.defineProperty(primary, "cleanupFailures", { value: [asCoordinatorFailure(closeError)], enumerable: false });
          throw primary;
        }
        throw error;
      }
    } catch (error) {
      throw asCoordinatorFailure(error);
    }
  }

  private finish(connection: PlayerDeliveryClaimCoordinatorConnection, transactionOpen: boolean, failure: unknown): void {
    const cleanupFailures: unknown[] = [];
    if (transactionOpen) {
      try { connection.run("ROLLBACK"); }
      catch (error) { cleanupFailures.push(asCoordinatorFailure(error)); }
    }
    try { connection.close(true); }
    catch (error) { cleanupFailures.push(asCoordinatorFailure(error)); }
    if (failure) {
      if (cleanupFailures.length) Object.defineProperty(failure, "cleanupFailures", { value: cleanupFailures, enumerable: false });
      throw failure;
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "player delivery claim coordinator cleanup failed");
  }

  private assertPolicy(stored: StoredPlayerDeliveryClaimCoordinatorPolicy | undefined): void {
    if (!stored
      || stored.schema_version !== this.policy.schemaVersion
      || stored.coordinator_domain !== this.domain
      || stored.writer_protocol !== this.policy.writerProtocol) {
      throw new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_POLICY_MISMATCH", "player delivery claim coordinator policy differs from this process configuration");
    }
  }

  private assertSafeDatabasePaths(): void {
    for (const path of [this.file, `${this.file}-journal`, `${this.file}-wal`, `${this.file}-shm`]) {
      if (this.pathOps.kind(path) === "unsafe") {
        throw new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_STORAGE_FAILED", "player delivery claim coordinator SQLite file or sidecar is not a regular non-link file");
      }
    }
  }

  private configureConnection(connection: PlayerDeliveryClaimCoordinatorConnection): void {
    connection.run("PRAGMA journal_mode = DELETE");
    connection.run("PRAGMA synchronous = FULL");
    connection.run("PRAGMA locking_mode = NORMAL");
    connection.run("PRAGMA busy_timeout = 0");
    const journal = String(connection.pragma("journal_mode") ?? "").toLowerCase();
    const synchronous = connection.pragma("synchronous");
    const locking = String(connection.pragma("locking_mode") ?? "").toLowerCase();
    const timeout = connection.pragma("busy_timeout");
    if (journal !== "delete"
      || !(synchronous === 2 || String(synchronous).toLowerCase() === "full")
      || locking !== "normal"
      || timeout !== 0) {
      throw new PlayerDeliveryClaimCoordinatorFailure("CLAIM_COORDINATOR_STORAGE_FAILED", "player delivery claim coordinator SQLite durability or locking pragma could not be verified");
    }
  }
}
