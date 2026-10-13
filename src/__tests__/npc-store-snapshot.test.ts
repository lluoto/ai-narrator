import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createNPCStoreSnapshot,
  NPCStore,
  NPC_STORE_SNAPSHOT_LIMITS,
  NPC_STORE_SNAPSHOT_VERSION,
  npcStoreSnapshotHash,
  type NPCStoreSnapshot,
} from "../db/index";
import type { MemoryEntry } from "../agent/types";

const dirs: string[] = [];

function fileStore() {
  const dir = mkdtempSync(join(tmpdir(), "npc-store-snapshot-"));
  dirs.push(dir);
  return new NPCStore(join(dir, "npc.db"));
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

function resign(snapshot: NPCStoreSnapshot): NPCStoreSnapshot {
  const { hash: _hash, ...payload } = snapshot;
  return { ...payload, hash: npcStoreSnapshotHash(payload) };
}

function seedCompleteStore(store: NPCStore): void {
  const db = store.raw;
  const insertPersonality = (values: Array<string | number>) => db.run(`
    INSERT INTO npc_personalities (
      id, name, role, personality, background, speech_style, goals, knowledge,
      secrets, attitudes, ruleset, traits, factions, initial_mood, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, values);
  insertPersonality([
    "npc-a", "Ada", "investigator", "methodical", "A complete history", "precise",
    JSON.stringify(["find the truth", ""]), JSON.stringify(["dock ledger"]),
    JSON.stringify(["the bell is broken"]), JSON.stringify({ "npc-empty": "guarded" }),
    "cosmic-horror", JSON.stringify({ courage: 7, stability: 4 }),
    JSON.stringify([{ name: "Harbor Watch", loyalty: 8 }]), "calm", 11, 22,
  ]);
  insertPersonality([
    "npc-empty", "", "", "", "", "", "[]", "[]", "[]", "{}", "", "{}", "[]", "neutral", 0, 0,
  ]);

  const summary: MemoryEntry = {
    timestamp: 33,
    type: "event",
    content: "The summary must survive.",
    importance: 10,
    scene_id: "",
    related_entities: [],
    is_summary: true,
  };
  store.addMemory("npc-a", summary);
  store.addMemory("npc-a", {
    timestamp: 34,
    type: "decision",
    content: "discarded to create a sequence hole",
    importance: 1,
    related_entities: ["npc-empty"],
  });
  db.run("DELETE FROM npc_memories WHERE content = ?", ["discarded to create a sequence hole"]);
  db.run(
    `INSERT INTO npc_relationships (npc_id, target_name, relationship, interaction_count, last_interaction)
     VALUES (?, ?, ?, ?, ?)`,
    ["npc-a", "npc-empty", -2.5, 6, 44],
  );
  db.run(
    `INSERT INTO npc_states (npc_id, mood, relationship, player_interaction_count, last_active)
     VALUES (?, ?, ?, ?, ?)`,
    ["npc-a", "calm", 1.5, 7, 55],
  );
}

describe("NPCStore portable SQLite snapshots", () => {
  it("uses a versioned domain for canonical integrity hashes", () => {
    expect(npcStoreSnapshotHash({ a: 1 })).toBe(
      "sha256:a70882dd5b780bbac55a34e487716edb5e9b422c5920377b03ab61d17e116ee4",
    );
    expect(npcStoreSnapshotHash({ b: 2, a: 1 })).toBe(npcStoreSnapshotHash({ a: 1, b: 2 }));
  });

  it("exports and restores a fresh store whose tables and memory sequence are all empty", () => {
    const source = fileStore();
    const exported = source.exportSnapshot();
    expect(exported.sequences).toEqual({ npc_memories: 0 });
    expect(exported.tables).toEqual({
      npc_personalities: [], npc_memories: [], npc_relationships: [], npc_states: [],
    });

    const restored = fileStore();
    restored.restoreSnapshot(exported);
    expect(restored.exportSnapshot()).toEqual(exported);

    source.close();
    restored.close();
  });

  it("exports and restores an empty in-memory SQLite store", () => {
    const source = new NPCStore(":memory:");
    const exported = source.exportSnapshot();
    const target = new NPCStore(":memory:");

    target.restoreSnapshot(exported);
    expect(target.exportSnapshot()).toEqual(exported);

    source.close();
    target.close();
  });

  it("accepts a table at its documented row bound even when it exceeds a JSON-column member bound", () => {
    const source = fileStore();
    seedCompleteStore(source);
    const { hash: _hash, ...payload } = source.exportSnapshot();
    const memory = payload.tables.npc_memories[0]!;
    const count = NPC_STORE_SNAPSHOT_LIMITS.maxJsonMembers + 1;
    payload.tables.npc_memories = Array.from({ length: count }, (_, index) => ({ ...memory, id: index + 1 }));
    payload.sequences.npc_memories = count;

    expect(createNPCStoreSnapshot(payload).tables.npc_memories).toHaveLength(count);

    source.close();
  });

  it("round-trips every NPC table, JSON value, empty field, state, relationship, summary, and canonical hash", () => {
    const source = fileStore();
    seedCompleteStore(source);

    const exported = source.exportSnapshot();
    expect(exported.version).toBe(NPC_STORE_SNAPSHOT_VERSION);
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
    expect(exported.tables.npc_personalities).toHaveLength(2);
    expect(exported.tables.npc_memories).toHaveLength(1);
    expect(exported.tables.npc_relationships).toHaveLength(1);
    expect(exported.tables.npc_states).toHaveLength(1);
    expect(exported.tables.npc_memories[0]).toMatchObject({
      id: 1,
      npc_id: "npc-a",
      scene_id: "",
      related_entities: [],
      is_summary: 1,
    });
    expect(exported.tables.npc_personalities.find((row) => row.id === "npc-empty")).toMatchObject({
      name: "", role: "", goals: [], attitudes: {}, ruleset: "", traits: {}, factions: [],
    });
    expect(exported.tables.npc_states[0]).toEqual({
      npc_id: "npc-a", mood: "calm", relationship: 1.5, player_interaction_count: 7, last_active: 55,
    });
    expect(exported.tables.npc_relationships[0]).toEqual({
      npc_id: "npc-a", target_name: "npc-empty", relationship: -2.5, interaction_count: 6, last_interaction: 44,
    });

    const expected = clone(exported);
    exported.tables.npc_personalities[0]!.goals.push("external mutation");
    expect(source.exportSnapshot()).toEqual(expected);

    const restored = fileStore();
    restored.restoreSnapshot(expected);
    expect(restored.exportSnapshot()).toEqual(expected);

    source.close();
    restored.close();
  });

  it("restores the AUTOINCREMENT high-water mark after a deleted memory id", () => {
    const source = fileStore();
    seedCompleteStore(source);
    const exported = source.exportSnapshot();
    expect(exported.sequences).toEqual({ npc_memories: 2 });

    const restored = fileStore();
    restored.restoreSnapshot(exported);
    restored.addMemory("npc-a", {
      timestamp: 66, type: "observation", content: "after restore", importance: 3,
    });
    expect(restored.raw.query("SELECT id FROM npc_memories WHERE content = ?").get("after restore")).toEqual({ id: 3 });

    source.close();
    restored.close();
  });

  it("rejects tampered, unknown, malformed JSON, duplicate, enum, and broken-FK snapshots before changing the target", () => {
    const source = fileStore();
    const target = fileStore();
    seedCompleteStore(source);
    seedCompleteStore(target);
    const valid = source.exportSnapshot();
    const before = target.exportSnapshot();

    const unknownKey = clone(valid) as NPCStoreSnapshot & { unexpected?: boolean };
    unknownKey.unexpected = true;

    const tampered = clone(valid);
    tampered.tables.npc_memories[0]!.content = "tampered without a new hash";

    const invalidJson = clone(valid);
    invalidJson.tables.npc_personalities[0]!.goals = { not: "a string array" } as never;

    const duplicate = clone(valid);
    duplicate.tables.npc_memories.push(clone(duplicate.tables.npc_memories[0]!));

    const illegalMood = clone(valid);
    illegalMood.tables.npc_states[0]!.mood = "curious" as never;

    const illegalRuleset = clone(valid);
    illegalRuleset.tables.npc_personalities[0]!.ruleset = "pathfinder" as never;

    const illegalMemoryType = clone(valid);
    illegalMemoryType.tables.npc_memories[0]!.type = "summary" as never;

    const unsafeTimestamp = clone(valid);
    unsafeTimestamp.tables.npc_memories[0]!.timestamp = Number.MAX_SAFE_INTEGER + 1;

    const outOfRangeImportance = clone(valid);
    outOfRangeImportance.tables.npc_memories[0]!.importance = 11;

    const outOfRangeRelationship = clone(valid);
    outOfRangeRelationship.tables.npc_relationships[0]!.relationship = -5.1;

    const tooManyEntities = clone(valid);
    tooManyEntities.tables.npc_memories[0]!.related_entities = Array.from(
      { length: NPC_STORE_SNAPSHOT_LIMITS.maxJsonMembers + 1 },
      () => "npc-empty",
    );

    const brokenForeignKey = clone(valid);
    brokenForeignKey.tables.npc_relationships[0]!.npc_id = "missing-npc";

    const cases: Array<[string, unknown]> = [
      ["unknown key", unknownKey],
      ["hash", tampered],
      ["JSON", resign(invalidJson)],
      ["duplicate", resign(duplicate)],
      ["mood enum", resign(illegalMood)],
      ["ruleset enum", resign(illegalRuleset)],
      ["memory type enum", resign(illegalMemoryType)],
      ["unsafe integer", unsafeTimestamp],
      ["importance range", resign(outOfRangeImportance)],
      ["relationship range", resign(outOfRangeRelationship)],
      ["JSON member bound", tooManyEntities],
      ["foreign key", resign(brokenForeignKey)],
    ];
    for (const [name, snapshot] of cases) {
      expect(() => target.restoreSnapshot(snapshot), name).toThrow();
      expect(target.exportSnapshot()).toEqual(before);
    }

    const { hash: _hash, ...payload } = valid;
    expect(createNPCStoreSnapshot(payload)).toEqual(valid);

    source.close();
    target.close();
  });

  it("rolls back all replacement writes when SQLite rejects an insertion partway through restore", () => {
    const source = fileStore();
    const target = fileStore();
    seedCompleteStore(source);
    seedCompleteStore(target);
    const before = target.exportSnapshot();
    target.raw.exec(`
      CREATE TRIGGER fail_npc_snapshot_restore
      BEFORE INSERT ON npc_states WHEN NEW.npc_id = 'npc-a'
      BEGIN SELECT RAISE(ABORT, 'injected NPC snapshot failure'); END;
    `);

    expect(() => target.restoreSnapshot(source.exportSnapshot())).toThrow("injected NPC snapshot failure");
    expect(target.exportSnapshot()).toEqual(before);

    source.close();
    target.close();
  });

  it("rejects accessors, hidden own properties, sparse arrays, and null-prototype JSON values before restore", () => {
    const source = fileStore();
    const target = fileStore();
    seedCompleteStore(source);
    seedCompleteStore(target);
    const valid = source.exportSnapshot();
    const before = target.exportSnapshot();

    const accessor = clone(valid);
    let accessorRead = false;
    Object.defineProperty(accessor.tables.npc_personalities[0]!, "name", {
      enumerable: true,
      get() {
        accessorRead = true;
        return "Ada";
      },
    });

    const hidden = clone(valid);
    Object.defineProperty(hidden.tables.npc_personalities[0]!.traits, "hidden", {
      value: undefined,
    });

    const sparse = clone(valid);
    sparse.tables.npc_memories[0]!.related_entities = new Array(1) as string[];

    const arrayAccessor = clone(valid);
    arrayAccessor.tables.npc_memories[0]!.related_entities = ["npc-empty"];
    const signedArrayAccessor = resign(arrayAccessor);
    Object.defineProperty(signedArrayAccessor.tables.npc_memories[0]!.related_entities, "0", {
      enumerable: true,
      get() {
        accessorRead = true;
        return "npc-empty";
      },
    });

    const nullPrototype = clone(valid);
    nullPrototype.tables.npc_personalities[0]!.traits = Object.assign(
      Object.create(null),
      nullPrototype.tables.npc_personalities[0]!.traits,
    ) as never;

    for (const [name, snapshot] of [
      ["accessor", accessor],
      ["hidden property", hidden],
      ["sparse array", sparse],
      ["array accessor", signedArrayAccessor],
      ["null prototype", nullPrototype],
    ] as const) {
      expect(() => target.restoreSnapshot(snapshot), name).toThrow();
      expect(target.exportSnapshot()).toEqual(before);
    }
    expect(accessorRead).toBeFalse();

    source.close();
    target.close();
  });
});
