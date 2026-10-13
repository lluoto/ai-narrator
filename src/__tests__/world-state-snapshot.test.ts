import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldStateManager } from "../state/world-state-manager";
import {
  WORLD_STATE_SNAPSHOT_VERSION,
  validateWorldStateSnapshot,
  worldStateSnapshotHash,
  type WorldStateSnapshot,
} from "../state/world-state-snapshot";

// This is the pre-current-round-metadata snapshots definition. Migration tests
// must exercise the actual old store shape, not a reduced table that happens
// to satisfy only the one query under test.
const LEGACY_SNAPSHOTS_DDL = `
  CREATE TABLE snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    round        INTEGER NOT NULL,
    timestamp    INTEGER NOT NULL DEFAULT (unixepoch()),
    state_json   TEXT NOT NULL,
    context_text TEXT NOT NULL,
    event_count  INTEGER NOT NULL DEFAULT 0
  )
`;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resign(snapshot: WorldStateSnapshot): WorldStateSnapshot {
  const unsigned = { ...snapshot } as Record<string, unknown>;
  delete unsigned.hash;
  return { ...snapshot, hash: worldStateSnapshotHash(unsigned) };
}

function makeCompleteWorld(): WorldStateManager {
  const world = new WorldStateManager();
  world.registerScene("active", "Active scene", "still active");
  world.registerScene("inactive", "Inactive scene", "must survive");
  world.setActiveScene("active");
  world.upsertEntity({
    id: "investigator",
    name: "Ada",
    type: "pc",
    hp: 9,
    maxHp: 12,
    ac: 11,
    status: ["wounded"],
    position: "active",
    scene_id: "active",
    attributes: { strength: 55 },
  });
  world.upsertEntity({
    id: "dead-npc",
    name: "The deceased", type: "npc", hp: 3, maxHp: 3, ac: 10,
    status: ["alive"], position: "inactive", scene_id: "inactive",
  });
  world.killEntity("dead-npc");
  world.registerPlayer("investigator");
  world.setPlayerInventory("investigator", ["torch"]);
  world.setPlayerWeapons("investigator", ["knife"]);
  world.setPlayerArmor("investigator", ["coat"]);
  world.setPlayerSanity("investigator", {
    currentSAN: 42, maxSAN: 50, temporaryInsanity: false, indefiniteInsanity: false,
    indefiniteLevel: null, phobias: [], manias: [], sanLostThisRound: 1,
    nightmareStreak: 0, irreversibleChanges: [], therapyProgress: 0,
    daysInstitutionalized: 0, cthulhuMythos: 0, mythosLog: [],
  });
  world.addEffect({
    id: "persistent-effect", source: "investigator", target: "investigator",
    type: "buff", description: "Prepared", duration: 3, round_applied: 7,
  });
  world.setRelation("investigator", "dead-npc", "enemy", -3);
  world.recordClueDiscovery("investigator", "clue-1");
  world.recordSceneVisit("investigator", "inactive");
  world.incrementClueFail("clue-2");
  world.incrementClueFail("clue-2");
  world.logEvent({
    round: 7, timestamp: 1, event_type: "combat", actor: "investigator",
    target: "dead-npc", description: "A past event", result: { damage: 3 },
    causationId: "cause-1",
  });
  world.createSnapshot(7);

  const db = world.getDatabase();
  db.run("INSERT INTO inventory (entity_id, item_name, quantity, description, properties) VALUES (?, ?, ?, ?, ?)",
    ["investigator", "archive-key", 2, "keeps identity", '{"rare":true}']);
  db.run("UPDATE effects SET data=? WHERE id=?", ['{"origin":"snapshot-test"}', "persistent-effect"]);
  db.run("UPDATE scenes SET lighting=?, dangers=?, exits=? WHERE id=?", [
    "dark", '["fog"]', '[{"target":"inactive","desc":"A cold door"}]', "active",
  ]);
  return world;
}

describe("WorldStateManager portable world snapshots", () => {
  it("domain-separates canonical portable snapshot hashes", () => {
    const rawJsonHash = `sha256:${createHash("sha256").update(JSON.stringify("world-state")).digest("hex")}`;

    expect(worldStateSnapshotHash("world-state")).not.toBe(rawJsonHash);
  });

  it("keeps the legacy createSnapshot(round) context writer compatible", () => {
    const world = new WorldStateManager();
    world.registerScene("legacy", "Legacy scene");
    world.setActiveScene("legacy");

    const context = world.createSnapshot(4);

    expect(context).toContain("第 4 轮");
    expect(world.getLatestContext()).toBe(context);
    expect(world.getDatabase().query("SELECT round FROM snapshots").get()).toEqual({ round: 4 });

    const portable = world.createSnapshot();
    expect(portable.currentRound).toBe(4);
    expect(portable.tables.snapshots).toHaveLength(1);

    world.close();
  });

  it("serializes the legacy state/event/context read with its snapshot insert", () => {
    const directory = mkdtempSync(join(tmpdir(), "world-state-legacy-snapshot-"));
    const dbPath = join(directory, "world.sqlite");
    const reader = new WorldStateManager(dbPath);
    const writer = new WorldStateManager(dbPath);
    const readerDb = reader.getDatabase() as unknown as {
      run(sql: string, bindings?: unknown): unknown;
    };
    const originalRun = readerDb.run.bind(readerDb);

    try {
      const journalMode = reader.getDatabase().query("PRAGMA journal_mode");
      try {
        expect(journalMode.get()).toEqual({ journal_mode: "wal" });
      } finally {
        journalMode.finalize();
      }
      reader.upsertEntity({
        id: "target", name: "Target", type: "npc", hp: 10, maxHp: 10, ac: 10,
        status: [], position: "unknown",
      });

      // This interception is intentionally at the historical INSERT boundary,
      // not a production seam. The old implementation had already committed
      // its read transaction when it reached this call, so the real second
      // connection could write here. The fixed immediate transaction must make
      // that write receive SQLITE_BUSY; after the transaction returns, retrying
      // the same real write must succeed without sleeps or timing guesses.
      let writerAttempted = false;
      let writerBlocked = false;
      let unexpectedWriterError: unknown;
      readerDb.run = (sql, bindings) => {
        if (!writerAttempted && /INSERT\s+INTO\s+snapshots/i.test(sql)) {
          writerAttempted = true;
          try {
            writer.applyDamage("target", 3);
            writer.logCombatEvent(12, "attacker", "target", "damage committed between reads", {
              hit: true, crit: false, roll: 1, bonuses: [], total: 1, damage: 3, damage_type: "test",
              result: "wound", intensity: 0, camera_hint: "", sfx_hint: "",
            });
          } catch (error) {
            const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
            writerBlocked = code === "SQLITE_BUSY" || (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message));
            if (!writerBlocked) unexpectedWriterError = error;
          }
        }
        return originalRun(sql, bindings);
      };

      reader.createSnapshot(12);

      expect(unexpectedWriterError).toBeUndefined();
      expect(writerAttempted).toBe(true);
      expect(writerBlocked).toBe(true);
      const snapshotStatement = reader.getDatabase().query(
        "SELECT state_json, context_text, event_count FROM snapshots WHERE round=?",
      );
      let snapshot: { state_json: string; context_text: string; event_count: number };
      try {
        snapshot = snapshotStatement.get(12) as { state_json: string; context_text: string; event_count: number };
      } finally {
        snapshotStatement.finalize();
      }
      const state = JSON.parse(snapshot.state_json) as { entities: Record<string, { hp: number }> };

      expect(state.entities.target?.hp).toBe(10);
      expect(snapshot.event_count).toBe(0);
      expect(snapshot.context_text).not.toContain("damage committed between reads");

      writer.applyDamage("target", 3);
      writer.logCombatEvent(12, "attacker", "target", "damage committed between reads", {
        hit: true, crit: false, roll: 1, bonuses: [], total: 1, damage: 3, damage_type: "test",
        result: "wound", intensity: 0, camera_hint: "", sfx_hint: "",
      });
      expect(writer.getEntity("target")?.hp).toBe(7);
      expect(writer.getRecentEvents()).toMatchObject([
        { description: "damage committed between reads", result: { damage: 3 } },
      ]);
    } finally {
      readerDb.run = originalRun;
      reader.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exports every persistent world table and restores a byte-stable canonical world", () => {
    const source = makeCompleteWorld();
    const exported = source.exportSnapshot();

    expect(exported.version).toBe(WORLD_STATE_SNAPSHOT_VERSION);
    expect(exported.currentRound).toBe(7);
    expect(exported.tables.entities.some((row) => row.id === "dead-npc" && row.alive === 0)).toBe(true);
    expect(exported.tables.scenes.some((row) => row.id === "inactive" && row.is_active === 0)).toBe(true);
    expect(exported.tables.event_log).toHaveLength(1);
    expect(exported.tables.relationships).toHaveLength(1);
    expect(exported.tables.clue_fail_counts[0]?.fail_count).toBe(2);
    expect(JSON.stringify(exported)).not.toContain("sk-placeholder");

    const restored = new WorldStateManager();
    restored.restoreSnapshot(exported);
    const replayed = restored.exportSnapshot();

    expect(replayed.hash).toBe(exported.hash);
    expect(replayed).toEqual(exported);
    expect(restored.getCurrentState().time).toBe("round_7");
    expect(restored.getDatabase().query("SELECT alive FROM entities WHERE id=?").get("dead-npc")).toEqual({ alive: 0 });
    expect(restored.getDatabase().query("SELECT id FROM inventory").get()).toEqual({ id: exported.tables.inventory[0]!.id });

    source.close();
    restored.close();
  });

  it("restores AUTOINCREMENT sequences so later writes do not reuse deleted ids", () => {
    const source = makeCompleteWorld();
    const sourceDb = source.getDatabase();
    sourceDb.run("INSERT INTO inventory (entity_id, item_name) VALUES (?, ?)", ["investigator", "discarded"]);
    sourceDb.run("DELETE FROM inventory WHERE item_name=?", ["discarded"]);
    source.setRelation("investigator", "discarded-relation", "neutral");
    sourceDb.run("DELETE FROM relationships WHERE entity_b=?", ["discarded-relation"]);
    source.logEvent({ round: 8, timestamp: 2, event_type: "system", description: "discarded" });
    sourceDb.run("DELETE FROM event_log WHERE description=?", ["discarded"]);
    source.createSnapshot(8);
    sourceDb.run("DELETE FROM snapshots WHERE round=?", [8]);

    const exported = source.exportSnapshot();
    expect(exported.sequences).toEqual({ inventory: 2, relationships: 2, snapshots: 2, event_log: 2 });
    expect(exported.currentRound).toBe(8);

    const restored = new WorldStateManager();
    restored.restoreSnapshot(exported);
    const restoredDb = restored.getDatabase();
    restoredDb.run("INSERT INTO inventory (entity_id, item_name) VALUES (?, ?)", ["investigator", "after-restore"]);
    restored.setRelation("investigator", "after-restore", "ally");
    restored.logEvent({ round: 9, timestamp: 3, event_type: "system", description: "after-restore" });
    restored.createSnapshot(9);

    expect(restoredDb.query("SELECT id FROM inventory WHERE item_name=?").get("after-restore")).toEqual({ id: 3 });
    expect(restoredDb.query("SELECT id FROM relationships WHERE entity_a=? OR entity_b=?").get("after-restore", "after-restore")).toEqual({ id: 3 });
    expect(restoredDb.query("SELECT id FROM event_log WHERE description=?").get("after-restore")).toEqual({ id: 3 });
    expect(restoredDb.query("SELECT id FROM snapshots WHERE round=?").get(9)).toEqual({ id: 3 });

    source.close();
    restored.close();
  });

  it("round-trips values permitted by SQLite, including empty and NUL-delimited keys", () => {
    const source = new WorldStateManager();
    source.registerScene("", "");
    expect(source.setActiveScene("")).toBe(true);
    source.upsertEntity({ id: "", name: "", type: "pc", hp: 1, maxHp: 1, ac: 1, status: [], position: "" });
    source.addEffect({ id: "", source: "", target: "", type: "debuff", description: "", duration: 1 });
    source.registerPlayer("");
    source.setPlayerInventory("", [""]);
    source.setRelation("", "", "");
    source.recordClueDiscovery("a\u0000b", "c");
    source.recordClueDiscovery("a", "b\u0000c");
    source.recordSceneVisit("a\u0000b", "c");
    source.recordSceneVisit("a", "b\u0000c");
    source.incrementClueFail("");
    source.logEvent({ round: 0, timestamp: 1, event_type: "system", description: "" });
    source.createSnapshot(0);
    source.getDatabase().run(
      "INSERT INTO inventory (entity_id, item_name, quantity, description, properties) VALUES (?, ?, ?, ?, ?)",
      ["", "", 1, "", "{}"],
    );

    const exported = source.exportSnapshot();
    expect(exported.tables.clue_discoveries).toHaveLength(2);
    expect(exported.tables.scene_visits).toHaveLength(2);

    const restored = new WorldStateManager();
    restored.restoreSnapshot(exported);
    expect(restored.exportSnapshot()).toEqual(exported);
    expect(restored.getActiveEffects()[0]?.type).toBe("debuff");

    source.close();
    restored.close();
  });

  it("rejects malformed, tampered, duplicate, illegal-enum, JSON, and foreign-key snapshots before changing state", () => {
    const source = makeCompleteWorld();
    const target = makeCompleteWorld();
    const valid = source.exportSnapshot();
    const before = target.exportSnapshot().hash;

    const badCases: Array<{ name: string; snapshot: unknown }> = [];
    const unknownKey = clone(valid) as WorldStateSnapshot & { unexpected?: boolean };
    unknownKey.unexpected = true;
    badCases.push({ name: "schema", snapshot: unknownKey });

    const tampered = clone(valid);
    tampered.currentRound = 99;
    badCases.push({ name: "hash", snapshot: tampered });

    const outOfBounds = clone(valid);
    outOfBounds.currentRound = -1;
    badCases.push({ name: "bounds", snapshot: resign(outOfBounds) });

    const invalidJson = clone(valid);
    invalidJson.tables.entities[0]!.status = { no: "array" } as never;
    badCases.push({ name: "json", snapshot: resign(invalidJson) });

    const duplicate = clone(valid);
    duplicate.tables.entities.push(clone(duplicate.tables.entities[0]!));
    badCases.push({ name: "duplicate", snapshot: resign(duplicate) });

    const illegalEnum = clone(valid);
    illegalEnum.tables.entities[0]!.type = "invalid" as never;
    badCases.push({ name: "enum", snapshot: resign(illegalEnum) });

    const brokenForeignKey = clone(valid);
    brokenForeignKey.tables.effects[0]!.target = "not-an-entity";
    badCases.push({ name: "foreign key", snapshot: resign(brokenForeignKey) });

    for (const bad of badCases) {
      expect(() => target.restoreSnapshot(bad.snapshot)).toThrow();
      expect(target.exportSnapshot().hash).toBe(before);
    }

    source.close();
    target.close();
  });

  it("rejects re-signed reverse relationship duplicates before any SQLite restore write", () => {
    const source = makeCompleteWorld();
    const target = makeCompleteWorld();
    try {
      const unorderedDuplicate = clone(source.exportSnapshot());
      const original = unorderedDuplicate.tables.relationships[0]!;
      unorderedDuplicate.tables.relationships.push({
        ...clone(original),
        id: original.id + 1,
        rowid: original.rowid + 1,
        entity_a: original.entity_b,
        entity_b: original.entity_a,
      });
      unorderedDuplicate.sequences.relationships = original.id + 1;
      const reSigned = resign(unorderedDuplicate);

      expect(() => validateWorldStateSnapshot(reSigned)).toThrow(
        "duplicate relationships.entity_a/entity_b",
      );
      const before = target.exportSnapshot().hash;
      expect(() => target.restoreSnapshot(reSigned)).toThrow(
        "duplicate relationships.entity_a/entity_b",
      );
      expect(target.exportSnapshot().hash).toBe(before);
    } finally {
      source.close();
      target.close();
    }
  });

  it("rejects sparse arrays, accessors, and hidden own properties before restore", () => {
    const source = makeCompleteWorld();
    const target = makeCompleteWorld();
    const valid = source.exportSnapshot();
    const before = target.exportSnapshot().hash;

    const sparse = clone(valid);
    sparse.tables.entities[0]!.status = new Array(1) as string[];

    const accessor = clone(valid);
    Object.defineProperty(accessor.tables.entities[0]!, "name", {
      configurable: true,
      enumerable: true,
      get: () => "Ada",
    });

    const hidden = clone(valid);
    Object.defineProperty(hidden.tables.entities[0]!, "hidden", {
      configurable: true,
      enumerable: false,
      value: true,
    });

    for (const invalid of [sparse, accessor, hidden]) {
      expect(() => target.restoreSnapshot(resign(invalid))).toThrow();
      expect(target.exportSnapshot().hash).toBe(before);
    }

    source.close();
    target.close();
  });

  it("keeps legacy createSnapshot(round) portable and commits its round only after SQLite succeeds", () => {
    const invalidRound = new WorldStateManager();
    expect(() => invalidRound.createSnapshot(-1)).toThrow();
    expect(invalidRound.getCurrentState().time).toBe("round_0");
    invalidRound.close();

    const world = new WorldStateManager();
    world.getDatabase().exec(`
      CREATE TRIGGER fail_legacy_snapshot
      BEFORE INSERT ON snapshots
      BEGIN SELECT RAISE(ABORT, 'injected legacy snapshot failure'); END;
    `);

    expect(() => world.createSnapshot(9)).toThrow("injected legacy snapshot failure");
    expect(world.getCurrentState().time).toBe("round_0");
    expect(world.createSnapshot()).toMatchObject({ currentRound: 0, tables: { snapshots: [] } });

    world.close();
  });

  it("initializes a missing durable round from the last valid legacy snapshot rowid", () => {
    const directory = mkdtempSync(join(tmpdir(), "world-state-legacy-round-"));
    const dbPath = join(directory, "world.sqlite");
    const legacy = new Database(dbPath);
    try {
      legacy.exec(LEGACY_SNAPSHOTS_DDL);
      legacy.run("INSERT INTO snapshots (round, state_json, context_text) VALUES (?, ?, ?)", [8, "{}", "first"]);
      legacy.run("INSERT INTO snapshots (round, state_json, context_text) VALUES (?, ?, ?)", [3, "{}", "last"]);
    } finally {
      legacy.close();
    }

    const world = new WorldStateManager(dbPath);
    try {
      expect(world.getCurrentState().time).toBe("round_3");
      const statement = world.getDatabase().query("SELECT current_round FROM world_state_metadata WHERE singleton=1");
      try {
        expect(statement.get()).toEqual({ current_round: 3 });
      } finally {
        statement.finalize();
      }
    } finally {
      world.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses malformed historical rounds in a legacy file before installing metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "world-state-malformed-legacy-round-"));
    const dbPath = join(directory, "world.sqlite");
    const legacy = new Database(dbPath);
    try {
      legacy.exec(LEGACY_SNAPSHOTS_DDL);
      legacy.run("INSERT INTO snapshots (round, state_json, context_text) VALUES (?, ?, ?)", [4, "{}", "valid"]);
      legacy.run("INSERT INTO snapshots (round, state_json, context_text) VALUES (?, ?, ?)", ["not-an-integer", "{}", "invalid"]);
    } finally {
      legacy.close();
    }

    try {
      expect(() => new WorldStateManager(dbPath)).toThrow("snapshots rowid 2 round");
      const check = new Database(dbPath);
      try {
        const statement = check.query("SELECT round, typeof(round) AS round_type FROM snapshots WHERE id=2");
        try {
          expect(statement.get()).toEqual({ round: "not-an-integer", round_type: "text" });
        } finally {
          statement.finalize();
        }
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses malformed historical rounds even when durable metadata already exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "world-state-malformed-current-round-"));
    const dbPath = join(directory, "world.sqlite");
    const world = new WorldStateManager(dbPath);
    try {
      world.createSnapshot(6);
      world.getDatabase().run(
        "INSERT INTO snapshots (round, state_json, context_text) VALUES (?, ?, ?)",
        ["not-an-integer", "{}", "invalid"],
      );
    } finally {
      world.close();
    }

    try {
      expect(() => new WorldStateManager(dbPath)).toThrow("snapshots rowid 2 round");
      const check = new Database(dbPath);
      try {
        const statement = check.query("SELECT round, typeof(round) AS round_type FROM snapshots WHERE id=2");
        try {
          expect(statement.get()).toEqual({ round: "not-an-integer", round_type: "text" });
        } finally {
          statement.finalize();
        }
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a weaker same-named durable round table without repairing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "world-state-weak-round-metadata-"));
    const dbPath = join(directory, "world.sqlite");
    const legacy = new Database(dbPath);
    try {
      legacy.exec("CREATE TABLE world_state_metadata (singleton INTEGER PRIMARY KEY, current_round INTEGER NOT NULL)");
      legacy.run("INSERT INTO world_state_metadata (singleton, current_round) VALUES (?, ?)", [1, 12]);
    } finally {
      legacy.close();
    }

    try {
      expect(() => new WorldStateManager(dbPath)).toThrow("does not have the required singleton/current_round definition");
      const check = new Database(dbPath);
      try {
        const statement = check.query("SELECT singleton, current_round FROM world_state_metadata");
        try {
          expect(statement.get()).toEqual({ singleton: 1, current_round: 12 });
        } finally {
          statement.finalize();
        }
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a partial snapshots table instead of accepting an unusable legacy store", () => {
    const directory = mkdtempSync(join(tmpdir(), "world-state-partial-snapshots-"));
    const dbPath = join(directory, "world.sqlite");
    const legacy = new Database(dbPath);
    try {
      legacy.exec("CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, round INTEGER NOT NULL)");
    } finally {
      legacy.close();
    }

    try {
      expect(() => new WorldStateManager(dbPath)).toThrow("snapshots does not have the required legacy definition");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("shares the durable current round across same-file managers while retaining append-order history", () => {
    const directory = mkdtempSync(join(tmpdir(), "world-state-current-round-"));
    const dbPath = join(directory, "world.sqlite");
    const first = new WorldStateManager(dbPath);
    const second = new WorldStateManager(dbPath);

    try {
      first.upsertEntity({
        id: "shared-target", name: "Shared target", type: "npc",
        hp: 3, maxHp: 3, ac: 10, status: [], position: "shared",
      });

      const roundEight = first.createSnapshot(8);
      expect(second.getCurrentState().time).toBe("round_8");
      second.addEffect({
        id: "uses-durable-round", source: "system", target: "shared-target",
        type: "buff", description: "Shared", duration: 1,
      });
      const effectRound = second.getDatabase().query("SELECT round_applied FROM effects WHERE id=?");
      try {
        expect(effectRound.get("uses-durable-round")).toEqual({ round_applied: 8 });
      } finally {
        effectRound.finalize();
      }

      const roundThree = second.createSnapshot(3);
      expect(first.getCurrentState().time).toBe("round_3");
      const metadataRound = first.getDatabase().query(
        "SELECT current_round FROM world_state_metadata WHERE singleton=1",
      );
      try {
        expect(metadataRound.get()).toEqual({ current_round: 3 });
      } finally {
        metadataRound.finalize();
      }
      expect(first.getLatestContext()).toBe(roundThree);
      expect(roundThree).not.toBe(roundEight);
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back all writes when SQLite rejects an insertion midway through restore", () => {
    const source = makeCompleteWorld();
    const target = makeCompleteWorld();
    const before = target.exportSnapshot();
    target.getDatabase().exec(`
      CREATE TRIGGER fail_world_snapshot_restore
      BEFORE INSERT ON scenes WHEN NEW.id = 'inactive'
      BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END;
    `);

    expect(() => target.restoreSnapshot(source.exportSnapshot())).toThrow("injected restore failure");
    expect(target.exportSnapshot()).toEqual(before);

    source.close();
    target.close();
  });
});
