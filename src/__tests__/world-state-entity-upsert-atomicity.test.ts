import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorldStateManager } from "../state/world-state-manager";

const worlds: WorldStateManager[] = [];

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.close();
});

function world(path?: string): WorldStateManager {
  const value = new WorldStateManager(path);
  worlds.push(value);
  return value;
}

function withSharedWorlds(run: (first: WorldStateManager, second: WorldStateManager) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "aitrpg-entity-upsert-"));
  const first = new WorldStateManager(join(directory, "world.sqlite"));
  const second = new WorldStateManager(join(directory, "world.sqlite"));
  try {
    run(first, second);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("WorldStateManager.upsertEntity atomic partial writes", () => {
  test("keeps a concurrent durable damage while updating the owned identity fields", () => {
    withSharedWorlds((first, second) => {
      first.upsertEntity({
        id: "target",
        name: "Target",
        type: "npc",
        hp: 10,
        maxHp: 10,
        ac: 12,
        status: ["guarding"],
        position: "ward",
        faction: "watch",
        attributes: { power: 60 },
        scene_id: "ward",
      });

      const firstDb = first.getDatabase();
      const originalRun = firstDb.run.bind(firstDb);
      let interleaved = false;
      let secondDamage: { killed: boolean; remainingHp: number } | undefined;
      (firstDb as unknown as { run: typeof firstDb.run }).run = ((...args: Parameters<typeof firstDb.run>) => {
        if (!interleaved) {
          interleaved = true;
          secondDamage = second.applyDamage("target", 3);
        }
        return originalRun(...args);
      }) as typeof firstDb.run;

      // The hook schedules a real second connection just before A's durable
      // statement. In the old read-then-UPDATE form, A has already cached its
      // fallback values; the single UPSERT form has no such cached snapshot.
      // It never forges a row, statement result, or SQLite error.
      first.upsertEntity({ id: "target", name: "Renamed target", type: "npc" });

      expect(interleaved).toBe(true);
      expect(secondDamage).toEqual({ killed: false, remainingHp: 7 });
      expect(first.getEntity("target")).toEqual({
        id: "target",
        name: "Renamed target",
        type: "npc",
        hp: 7,
        maxHp: 10,
        ac: 12,
        status: ["guarding"],
        position: "ward",
        faction: "watch",
        attributes: { power: 60 },
        scene_id: "ward",
      });
    });
  });

  test("keeps insert defaults, explicit falsy values, and omitted-field preservation", () => {
    const value = world();
    value.upsertEntity({ id: "new", name: "New", type: "npc" });
    expect(value.getEntity("new")).toEqual({
      id: "new",
      name: "New",
      type: "npc",
      hp: 0,
      maxHp: 1,
      ac: 10,
      status: [],
      position: "unknown",
      attributes: {},
    });

    value.upsertEntity({
      id: "new",
      name: "Configured",
      type: "npc",
      hp: 5,
      maxHp: 8,
      ac: 11,
      status: ["guarding"],
      position: "ward",
      faction: "watch",
      attributes: { power: 60 },
      scene_id: "ward",
    });
    value.upsertEntity({
      id: "new",
      name: "Explicit empty values",
      type: "npc",
      hp: 0,
      maxHp: 0,
      ac: 0,
      status: [],
      position: "",
      faction: "",
      attributes: {},
      scene_id: "",
    });
    value.upsertEntity({ id: "new", name: "Identity only", type: "npc" });

    expect(value.getEntity("new")).toEqual({
      id: "new",
      name: "Identity only",
      type: "npc",
      hp: 0,
      maxHp: 0,
      ac: 0,
      status: [],
      position: "",
      faction: "",
      attributes: {},
      scene_id: "",
    });
  });
});
