import { describe, expect, it } from "bun:test";
import { CatalogCoordinatorFailure, COMPILER_ARTIFACT_CATALOG_SQLITE_OPEN_FLAGS, CompilerArtifactCatalogCoordinator, type CatalogCoordinatorConnection } from "../compiler/compiler-artifact-catalog-coordinator";

class FakeConnection implements CatalogCoordinatorConnection {
  readonly calls: string[] = [];
  closeCalls = 0;
  private rollbackCalls = 0;
  constructor(private readonly failures: { rollbackAt?: number; close?: boolean } = {}) {}
  run(sql: string): void {
    this.calls.push(sql);
    if (sql === "ROLLBACK" && ++this.rollbackCalls === this.failures.rollbackAt) throw new Error("injected rollback failure");
  }
  policy() { return { schema_version: "test", max_entries: 1, max_bytes: 2 }; }
  pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout"): unknown {
    return name === "journal_mode" ? "delete" : name === "synchronous" ? 2 : name === "locking_mode" ? "normal" : 0;
  }
  close(): void { this.closeCalls++; if (this.failures.close) throw new Error("injected close failure"); }
}

describe("compiler artifact catalog coordinator finalization", () => {
  it("attempts close even when rollback fails, and reports close failure separately", () => {
    const rollbackConnection = new FakeConnection({ rollbackAt: 2 });
    const rollback = new CompilerArtifactCatalogCoordinator("C:/coordinator-test", "test", 1, 2, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => rollbackConnection,
    });
    rollback.initializePolicy(); rollback.beginPublication();
    expect(rollback.finishPublication().rollbackFailure).toBeInstanceOf(CatalogCoordinatorFailure);
    expect(rollbackConnection.closeCalls).toBe(1);
    expect(rollbackConnection.calls).toEqual(expect.arrayContaining(["PRAGMA journal_mode = DELETE", "PRAGMA synchronous = FULL", "PRAGMA locking_mode = NORMAL", "PRAGMA busy_timeout = 0"]));

    const closeConnection = new FakeConnection({ close: true });
    const close = new CompilerArtifactCatalogCoordinator("C:/coordinator-test", "test", 1, 2, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => closeConnection,
    });
    close.initializePolicy(); close.beginPublication();
    expect(close.finishPublication().closeFailure).toBeInstanceOf(CatalogCoordinatorFailure);
    expect(closeConnection.closeCalls).toBe(1);
  });

  it("rejects an unsafe SQLite sidecar before a connection can open", () => {
    let opened = false;
    const coordinator = new CompilerArtifactCatalogCoordinator("C:/coordinator-test", "test", 1, 2, {
      pathOps: { kind: (path) => path.endsWith("-wal") ? "unsafe" : "missing" },
      connectionFactory: () => { opened = true; return new FakeConnection(); },
    });
    expect(() => coordinator.initializePolicy()).toThrow("regular non-link");
    expect(opened).toBe(false);
  });

  it("passes no-follow/full-mutex SQLite flags and repeats regular-file checks after open", () => {
    let opened = false;
    let flags: number | undefined;
    let databaseChecks = 0;
    const coordinator = new CompilerArtifactCatalogCoordinator("C:/coordinator-test", "test", 1, 2, {
      pathOps: {
        kind: (path) => {
          if (!path.endsWith(".catalog-write.sqlite")) return "missing";
          return ++databaseChecks === 1 ? "missing" : "unsafe";
        },
      },
      connectionFactory: (_file, openFlags) => {
        opened = true;
        flags = openFlags;
        return new FakeConnection();
      },
    });
    expect(() => coordinator.initializePolicy()).toThrow("regular non-link");
    expect(opened).toBe(true);
    expect(flags).toBe(COMPILER_ARTIFACT_CATALOG_SQLITE_OPEN_FLAGS);
  });

  it("fails closed when a durability or locking pragma cannot be read back", () => {
    const connection = new FakeConnection();
    connection.pragma = (name) => name === "busy_timeout" ? 1 : name === "journal_mode" ? "delete" : name === "synchronous" ? 2 : "normal";
    const coordinator = new CompilerArtifactCatalogCoordinator("C:/coordinator-test", "test", 1, 2, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => connection,
    });
    expect(() => coordinator.initializePolicy()).toThrow("could not be verified");
  });
});
