import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  COMPILED_INTENT_REPLAY_DOMAIN,
  COMPILED_INTENT_REPLAY_FILE_NAME,
  CompiledIntentReplayStore,
  type CompiledIntentReplayResult,
} from "../api/compiled-intent-replay";
import type { CompiledIntentReplayIdentity } from "../api/game-session";

const replayChild = join(import.meta.dir, "compiled-intent-replay-child.ts");

function opaque(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identity(seed: string, expectedGeneration = 0, catalog = "catalog-a", sessionSeed = seed): CompiledIntentReplayIdentity {
  return {
    sessionKey: opaque(`session:${sessionSeed}`),
    expectedGeneration,
    scopeKey: opaque(`scope:${seed}:${expectedGeneration}`),
    requestKey: opaque(`request:${seed}`),
    catalogKey: opaque(`catalog:${catalog}`),
    integrityKey: opaque(`integrity:${seed}:${expectedGeneration}:${catalog}`),
    mechanismKeys: [
      { mechanismId: "mechanism-in-memory-only", key: opaque(`mechanism:${seed}:one`) },
      { mechanismId: "other-mechanism-in-memory-only", key: opaque(`mechanism:${seed}:two`) },
    ],
  };
}

const noMatch: CompiledIntentReplayResult = { kind: "no_match", mechanismKeys: [] };

describe("compiled intent durable replay ledger", () => {
  it("reopens an exact opaque result without raw prose, labels, or mechanism IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-replay-private-"));
    const first = identity("open the red door");
    try {
      const store = new CompiledIntentReplayStore(root);
      expect(store.save(first, noMatch)).toEqual({ status: "stored", value: noMatch });
      expect(new CompiledIntentReplayStore(root).read(first)).toEqual({ status: "hit", value: noMatch });
      const database = new Database(join(root, COMPILED_INTENT_REPLAY_FILE_NAME));
      const rows = database.query<Record<string, unknown>, []>("SELECT * FROM compiled_intent_replay_records").all();
      const policy = database.query<Record<string, unknown>, []>("SELECT * FROM compiled_intent_replay_policy").get();
      database.close();
      const persisted = JSON.stringify({ rows, policy });
      for (const forbidden of ["open the red door", "mechanism-in-memory-only", "other-mechanism-in-memory-only", "Search here", "choice_"]) {
        expect(persisted).not.toContain(forbidden);
      }
      expect(persisted).not.toContain(first.integrityKey);
      expect(policy?.coordinator_domain).toBe(COMPILED_INTENT_REPLAY_DOMAIN);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("observes a completed opaque result written by an independent Bun process", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-replay-process-"));
    const first = identity("independent-process");
    try {
      const child = Bun.spawn([process.execPath, replayChild, root, JSON.stringify(first)], {
        cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({ status: "stored", value: noMatch });
      expect(new CompiledIntentReplayStore(root).read(first)).toEqual({ status: "hit", value: noMatch });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects result MAC tampering, copied result records, and an older schema", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-replay-integrity-"));
    const first = identity("integrity-request-one");
    try {
      const store = new CompiledIntentReplayStore(root);
      const selected: CompiledIntentReplayResult = { kind: "selected", mechanismKeys: [first.mechanismKeys[0]!.key] };
      expect(store.save(first, selected).status).toBe("stored");

      const database = new Database(store.file);
      try {
        database.query<Record<string, unknown>, []>("SELECT result_kind, mechanism_keys_json, result_mac FROM compiled_intent_replay_records").get();
        database.run("UPDATE compiled_intent_replay_records SET result_kind = 'no_match', mechanism_keys_json = '[]' WHERE scope_key = ? AND request_key = ?", [first.scopeKey, first.requestKey]);
      } finally { database.close(); }
      expect(store.read(first)).toMatchObject({ status: "refused" });
      const quarantined = new Database(store.file);
      try {
        expect(quarantined.query<{ state: string }, []>("SELECT state FROM compiled_intent_replay_records").get()?.state).toBe("quarantined");
      } finally { quarantined.close(); }

      const copiedRoot = mkdtempSync(join(tmpdir(), "compiled-intent-replay-integrity-copy-"));
      try {
        const copyStore = new CompiledIntentReplayStore(copiedRoot);
        expect(copyStore.save(first, selected).status).toBe("stored");
        const other = { ...first, requestKey: opaque("integrity-request-two"), integrityKey: opaque("integrity-key-two") };
        const source = new Database(copyStore.file);
        const sourceResult = source.query<Record<string, unknown>, []>("SELECT result_kind, mechanism_keys_json, result_mac FROM compiled_intent_replay_records").get();
        source.run("INSERT INTO compiled_intent_replay_records (session_key, expected_generation, scope_key, request_key, catalog_key, result_kind, mechanism_keys_json, result_mac, state, created_at_ms, quarantined_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', 0, NULL)", [other.sessionKey, other.expectedGeneration, other.scopeKey, other.requestKey, other.catalogKey, sourceResult!.result_kind as string, sourceResult!.mechanism_keys_json as string, sourceResult!.result_mac as string]);
        source.close();
        expect(copyStore.read(other)).toMatchObject({ status: "refused" });
        const copiedQuarantine = new Database(copyStore.file);
        try {
          expect(copiedQuarantine.query<{ state: string }, [string]>("SELECT state FROM compiled_intent_replay_records WHERE request_key = ?").get(other.requestKey)?.state).toBe("quarantined");
        } finally { copiedQuarantine.close(); }
      } finally { rmSync(copiedRoot, { recursive: true, force: true }); }

      const oldSchemaRoot = mkdtempSync(join(tmpdir(), "compiled-intent-replay-old-schema-"));
      try {
        const oldSchemaStore = new CompiledIntentReplayStore(oldSchemaRoot);
        expect(oldSchemaStore.save(first, noMatch).status).toBe("stored");
        const oldSchemaDatabase = new Database(oldSchemaStore.file);
        oldSchemaDatabase.run("UPDATE compiled_intent_replay_policy SET schema_version = '1.0.0'");
        oldSchemaDatabase.close();
        expect(new CompiledIntentReplayStore(oldSchemaRoot).read(first)).toMatchObject({ status: "refused", code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" });
      } finally { rmSync(oldSchemaRoot, { recursive: true, force: true }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed and quarantines catalog conflicts, corrupt values, oversized result lists, and different replay outcomes", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-replay-corrupt-"));
    const first = identity("same request");
    try {
      const store = new CompiledIntentReplayStore(root);
      expect(store.save(first, { kind: "selected", mechanismKeys: [first.mechanismKeys[0]!.key] }).status).toBe("stored");
      expect(store.save(first, { kind: "selected", mechanismKeys: [first.mechanismKeys[1]!.key] })).toMatchObject({
        status: "refused", code: "COMPILED_INTENT_REPLAY_CONFLICT",
      });
      expect(store.read(first)).toMatchObject({ status: "refused" });

      const catalogRoot = mkdtempSync(join(tmpdir(), "compiled-intent-replay-catalog-"));
      try {
        const catalogStore = new CompiledIntentReplayStore(catalogRoot);
        expect(catalogStore.save(first, noMatch).status).toBe("stored");
        expect(catalogStore.read(identity("same request", 0, "catalog-b"))).toMatchObject({
          status: "refused", code: "COMPILED_INTENT_REPLAY_CONFLICT",
        });
      } finally { rmSync(catalogRoot, { recursive: true, force: true }); }

      const malformedRoot = mkdtempSync(join(tmpdir(), "compiled-intent-replay-malformed-"));
      try {
        const malformed = new CompiledIntentReplayStore(malformedRoot);
        expect(malformed.save(first, noMatch).status).toBe("stored");
        const database = new Database(malformed.file);
        database.run("UPDATE compiled_intent_replay_records SET mechanism_keys_json = ?", [JSON.stringify(Array.from({ length: 33 }, (_, index) => opaque(`oversize:${index}`)))]);
        database.close();
        expect(malformed.read(first)).toMatchObject({ status: "refused", code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" });
      } finally { rmSync(malformedRoot, { recursive: true, force: true }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("projects a multi-byte oversized serialized result to NULL before JSON parsing", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-replay-oversized-text-"));
    const first = identity("oversized-text");
    const originalParse = JSON.parse;
    let parseCalls = 0;
    try {
      const store = new CompiledIntentReplayStore(root);
      expect(store.save(first, noMatch).status).toBe("stored");
      const database = new Database(store.file);
      // The JS character count stays inside the 2,145-character serialized
      // bound, while UTF-8 bytes exceed it. SQLite must therefore measure the
      // BLOB byte representation before returning the TEXT to JS.
      const oversizedUtf8Json = JSON.stringify(["界".repeat(800)]);
      expect(oversizedUtf8Json.length).toBeLessThanOrEqual(2_145);
      expect(Buffer.byteLength(oversizedUtf8Json, "utf8")).toBeGreaterThan(2_145);
      database.run("UPDATE compiled_intent_replay_records SET mechanism_keys_json = ?", [oversizedUtf8Json]);
      database.close();
      let projectedMechanismKeysJson: unknown = undefined;
      const reader = new CompiledIntentReplayStore(root, {}, {
        connectionFactory(file, flags) {
          const database = new Database(file, flags);
          return {
            run(sql: string, values: readonly (string | number)[] = []) {
              if (values.length) database.run(sql, [...values]); else database.run(sql);
            },
            get<T>(sql: string, values: readonly (string | number)[] = []) {
              const row = values.length ? database.query(sql).get(...values) as T | undefined : database.query(sql).get() as T | undefined;
              if (sql.includes("FROM compiled_intent_replay_records")) {
                projectedMechanismKeysJson = (row as Record<string, unknown> | undefined)?.mechanism_keys_json;
              }
              return row;
            },
            pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") {
              const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
              return row ? Object.values(row)[0] : undefined;
            },
            close(throwOnError: true) { database.close(throwOnError); },
          };
        },
      });
      JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
        parseCalls += 1;
        return originalParse(text, reviver);
      }) as typeof JSON.parse;
      expect(reader.read(first)).toMatchObject({ status: "refused", code: "COMPILED_INTENT_REPLAY_UNAVAILABLE" });
      expect(projectedMechanismKeysJson).toBeNull();
      expect(parseCalls).toBe(0);
    } finally {
      JSON.parse = originalParse;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never acknowledges a result whose SQLite commit outcome is indeterminate", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-replay-commit-uncertain-"));
    const first = identity("commit uncertain");
    let resultInsertCommitted = false;
    try {
      const uncertain = new CompiledIntentReplayStore(root, {}, {
        connectionFactory(file, flags) {
          const database = new Database(file, flags);
          let savingResult = false;
          return {
            run(sql: string, values: readonly (string | number)[] = []) {
              if (sql.startsWith("INSERT INTO compiled_intent_replay_records")) savingResult = true;
              if (sql === "COMMIT" && savingResult) {
                database.run(sql);
                resultInsertCommitted = true;
                throw new Error("injected unacknowledged commit");
              }
              if (values.length) database.run(sql, [...values]); else database.run(sql);
            },
            get<T>(sql: string, values: readonly (string | number)[] = []) {
              return values.length ? database.query(sql).get(...values) as T | undefined : database.query(sql).get() as T | undefined;
            },
            pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") {
              const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
              return row ? Object.values(row)[0] : undefined;
            },
            close(throwOnError: true) { database.close(throwOnError); },
          };
        },
      });
      expect(uncertain.save(first, noMatch)).toMatchObject({
        status: "refused", code: "COMPILED_INTENT_REPLAY_UNAVAILABLE",
      });
      expect(resultInsertCommitted).toBe(true);
      // The outcome may in fact have reached disk, but the writer does not
      // claim success; the HTTP seam quarantines its provider lease on this
      // refusal before another request can use the record.
      expect(new CompiledIntentReplayStore(root).read(first)).toMatchObject({ status: "hit", value: noMatch });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("never evicts an active generation for capacity, but clears only older same-session generations", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-replay-capacity-"));
    try {
      const store = new CompiledIntentReplayStore(root, { maxRecordsPerScope: 1 });
      const g0 = identity("first", 0);
      expect(store.save(g0, noMatch).status).toBe("stored");
      expect(store.read(g0)).toMatchObject({ status: "hit" });
      // The exact record still replays at capacity, but a second request in
      // this same immutable scope cannot displace it.
      expect(store.save(g0, noMatch)).toMatchObject({ status: "stored", value: noMatch });
      const sameScopeOtherRequest = { ...g0, requestKey: opaque("first-other-request"), integrityKey: opaque("first-other-integrity") };
      expect(store.hasCapacity(sameScopeOtherRequest)).toMatchObject({
        status: "refused", code: "COMPILED_INTENT_REPLAY_CAPACITY",
      });
      expect(store.save(sameScopeOtherRequest, noMatch)).toMatchObject({
        status: "refused", code: "COMPILED_INTENT_REPLAY_CAPACITY",
      });
      // A full unrelated scope cannot deny this session/generation/bundle.
      expect(store.save(identity("other-current", 0), noMatch)).toMatchObject({ status: "stored", value: noMatch });
      const g1 = identity("first-next", 1, "catalog-a", "first");
      expect(store.hasCapacity(g1)).toEqual({ status: "available" });
      expect(store.save(g1, noMatch).status).toBe("stored");
      expect(store.read(g0)).toEqual({ status: "absent" });
      expect(store.read(g1)).toMatchObject({ status: "hit" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
