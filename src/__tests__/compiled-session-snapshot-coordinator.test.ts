import { describe, expect, it } from "bun:test";
import { constants } from "bun:sqlite";
import {
  COMPILED_SESSION_SNAPSHOT_COORDINATOR_SCHEMA_VERSION,
  COMPILED_SESSION_SNAPSHOT_SQLITE_OPEN_FLAGS,
  CompiledSessionSnapshotCoordinator,
  SnapshotCoordinatorFailure,
  type SnapshotCoordinatorConnection,
} from "../api/compiled-session-snapshot-coordinator";

interface FakeOptions {
  policy?: { schema_version: string; coordinator_domain: string; max_entries: number; max_bytes: number };
  failPolicy?: unknown;
  pragma?: Partial<Record<"journal_mode" | "synchronous" | "locking_mode" | "busy_timeout", unknown>>;
  failBegin?: unknown;
  failRollback?: unknown;
  failClose?: unknown;
}

function fakeConnection(options: FakeOptions = {}) {
  const calls: string[] = [];
  const bindings: Array<readonly (string | number)[]> = [];
  let closeCalls = 0;
  const connection: SnapshotCoordinatorConnection = {
    run(sql, values = []) {
      calls.push(sql);
      bindings.push(values);
      if (sql === "BEGIN IMMEDIATE" && options.failBegin) throw options.failBegin;
      if (sql === "ROLLBACK" && options.failRollback) throw options.failRollback;
    },
    policy: () => {
      if (options.failPolicy) throw options.failPolicy;
      return options.policy;
    },
    pragma(name) {
      return options.pragma?.[name] ?? ({ journal_mode: "delete", synchronous: 2, locking_mode: "normal", busy_timeout: 0 } as const)[name];
    },
    close() {
      closeCalls++;
      if (options.failClose) throw options.failClose;
    },
  };
  return { connection, calls, bindings, closeCalls: () => closeCalls };
}

describe("CompiledSessionSnapshotCoordinator", () => {
  it("uses its own hardened SQLite connection and verifies DELETE/FULL/NORMAL/busy=0", () => {
    const fake = fakeConnection();
    let capturedFile = "", capturedFlags = 0;
    const coordinator = new CompiledSessionSnapshotCoordinator("C:/snapshot-root", undefined, {
      pathOps: { kind: () => "missing" },
      connectionFactory(file, flags) { capturedFile = file; capturedFlags = flags; return fake.connection; },
    });
    coordinator.initializePolicy();
    expect(capturedFile).toMatch(/\.compiled-session-snapshot-write\.sqlite$/);
    expect(capturedFlags).toBe(COMPILED_SESSION_SNAPSHOT_SQLITE_OPEN_FLAGS);
    expect(capturedFlags & constants.SQLITE_OPEN_NOFOLLOW).toBe(constants.SQLITE_OPEN_NOFOLLOW);
    expect(capturedFlags & constants.SQLITE_OPEN_FULLMUTEX).toBe(constants.SQLITE_OPEN_FULLMUTEX);
    expect(capturedFlags & constants.SQLITE_OPEN_EXRESCODE).toBe(constants.SQLITE_OPEN_EXRESCODE);
    expect(fake.calls).toEqual(expect.arrayContaining([
      "PRAGMA journal_mode = DELETE", "PRAGMA synchronous = FULL", "PRAGMA locking_mode = NORMAL", "PRAGMA busy_timeout = 0", "BEGIN IMMEDIATE",
    ]));
    expect(fake.calls.some((call) => call.includes("snapshot_coordinator_policy"))).toBe(true);
    expect(coordinator.finishPublication()).toEqual({});
    expect(fake.closeCalls()).toBe(1);
  });

  it("fails closed before opening unsafe database and sidecar paths", () => {
    let opened = false;
    const coordinator = new CompiledSessionSnapshotCoordinator("C:/snapshot-root", undefined, {
      pathOps: { kind: (path) => path.endsWith("-wal") ? "unsafe" : "missing" },
      connectionFactory: () => { opened = true; throw new Error("must not open"); },
    });
    expect(() => coordinator.initializePolicy()).toThrow("regular non-link");
    expect(opened).toBe(false);
  });

  it("rejects policy/schema and pragma mismatches", () => {
    const policy = fakeConnection({ policy: { schema_version: "wrong", coordinator_domain: "compiled-session-snapshot-cas", max_entries: 4096, max_bytes: 512 * 1024 * 1024 } });
    const policyCoordinator = new CompiledSessionSnapshotCoordinator("C:/snapshot-root", COMPILED_SESSION_SNAPSHOT_COORDINATOR_SCHEMA_VERSION, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => policy.connection,
    });
    expect(() => policyCoordinator.initializePolicy()).toThrow("policy differs");
    policyCoordinator.finishPublication();

    const pragma = fakeConnection({ pragma: { journal_mode: "wal" } });
    const pragmaCoordinator = new CompiledSessionSnapshotCoordinator("C:/snapshot-root", undefined, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => pragma.connection,
    });
    expect(() => pragmaCoordinator.initializePolicy()).toThrow("durability or locking pragma");
    pragmaCoordinator.finishPublication();
  });

  it("persists quotas as coordinator policy and exposes a stable policy-mismatch failure", () => {
    const inserted = fakeConnection();
    const policy = { schemaVersion: COMPILED_SESSION_SNAPSHOT_COORDINATOR_SCHEMA_VERSION, maxEntries: 17, maxBytes: 4097 };
    const first = new CompiledSessionSnapshotCoordinator("C:/snapshot-root", undefined, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => inserted.connection,
    });
    first.initializePolicy(policy);
    expect(inserted.bindings.find((values) => values.includes(17))).toEqual(expect.arrayContaining([policy.schemaVersion, 17, 4097]));
    first.finishPublication();

    const stored = fakeConnection({ policy: {
      schema_version: policy.schemaVersion,
      coordinator_domain: "compiled-session-snapshot-cas",
      max_entries: policy.maxEntries,
      max_bytes: policy.maxBytes,
    } });
    const mismatch = new CompiledSessionSnapshotCoordinator("C:/snapshot-root", undefined, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => stored.connection,
    });
    let mismatchError: unknown;
    try { mismatch.initializePolicy({ ...policy, maxBytes: policy.maxBytes + 1 }); }
    catch (error) { mismatchError = error; }
    expect(mismatchError).toMatchObject({ code: "SNAPSHOT_POLICY_MISMATCH" });
    mismatch.finishPublication();

    const oldSchema = fakeConnection({ failPolicy: new Error("no such column: max_entries") });
    const legacy = new CompiledSessionSnapshotCoordinator("C:/snapshot-root", undefined, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => oldSchema.connection,
    });
    let legacyError: unknown;
    try { legacy.initializePolicy(policy); } catch (error) { legacyError = error; }
    expect(legacyError).toMatchObject({ code: "SNAPSHOT_POLICY_MISMATCH" });
    legacy.finishPublication();
  });

  it("maps SQLITE_BUSY and attempts close after rollback failure", () => {
    const busy = fakeConnection({ failBegin: Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" }) });
    const busyCoordinator = new CompiledSessionSnapshotCoordinator("C:/snapshot-root", undefined, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => busy.connection,
    });
    try { busyCoordinator.initializePolicy(); }
    catch (error) {
      expect(error).toBeInstanceOf(SnapshotCoordinatorFailure);
      expect(error).toMatchObject({ code: "SNAPSHOT_BUSY" });
    }
    busyCoordinator.finishPublication();
    expect(busy.closeCalls()).toBe(1);

    const rollback = fakeConnection({ failRollback: new Error("rollback failure") });
    const rollbackCoordinator = new CompiledSessionSnapshotCoordinator("C:/snapshot-root", undefined, {
      pathOps: { kind: () => "missing" }, connectionFactory: () => rollback.connection,
    });
    rollbackCoordinator.initializePolicy();
    rollbackCoordinator.beginPublication();
    const finish = rollbackCoordinator.finishPublication();
    expect(finish.rollbackFailure).toMatchObject({ code: "SNAPSHOT_STORAGE_FAILED" });
    expect(rollback.closeCalls()).toBe(1);
  });
});
