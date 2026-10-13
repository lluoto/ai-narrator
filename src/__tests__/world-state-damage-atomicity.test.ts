import { afterEach, describe, expect, test } from "bun:test";
import { WorldStateManager } from "../state/world-state-manager";

const worlds: WorldStateManager[] = [];

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.close();
});

function makeWorld(): WorldStateManager {
  const world = new WorldStateManager();
  worlds.push(world);
  world.registerScene("ward", "Ward", "A guarded room");
  expect(world.setActiveScene("ward")).toBe(true);
  world.upsertEntity({
    id: "victim",
    name: "Victim",
    type: "npc",
    hp: 5,
    maxHp: 5,
    ac: 10,
    status: ["guarding"],
    position: "ward",
    scene_id: "ward",
  });
  return world;
}

function storedVictim(world: WorldStateManager) {
  return world.getDatabase()
    .query("SELECT hp, alive, status FROM entities WHERE id = ?")
    .get("victim");
}

describe("WorldStateManager.applyDamage atomic truth-source transition", () => {
  test("rolls back HP when SQLite rejects the lethal alive/status transition", () => {
    const world = makeWorld();
    const beforeRow = storedVictim(world);
    const beforeAliveIds = world.getAllAliveEntities().map((entity) => entity.id);
    const beforeState = world.getCurrentState();
    world.getDatabase().exec(`
      CREATE TRIGGER reject_lethal_damage
      BEFORE UPDATE OF alive ON entities
      WHEN NEW.id = 'victim' AND NEW.alive = 0
      BEGIN
        SELECT RAISE(ABORT, 'kill denied');
      END;
    `);

    expect(() => world.applyDamage("victim", 5)).toThrow("kill denied");

    expect(storedVictim(world)).toEqual(beforeRow);
    expect(world.getAllAliveEntities().map((entity) => entity.id)).toEqual(beforeAliveIds);
    expect(world.getCurrentState()).toEqual(beforeState);
  });

  test("keeps the nonlethal and lethal return contracts while updating durable state", () => {
    const world = makeWorld();

    expect(world.applyDamage("victim", 2)).toEqual({ killed: false, remainingHp: 3 });
    expect(storedVictim(world)).toEqual({ hp: 3, alive: 1, status: '["guarding"]' });

    expect(world.applyDamage("victim", 3)).toEqual({ killed: true, remainingHp: 0 });
    expect(storedVictim(world)).toEqual({ hp: 0, alive: 0, status: '["dead"]' });
    expect(world.getAllAliveEntities().map((entity) => entity.id)).not.toContain("victim");
    expect(world.getCurrentState().entities.victim).toBeUndefined();
  });

  test("keeps the unknown-entity failure contract", () => {
    const world = makeWorld();

    expect(() => world.applyDamage("missing", 1)).toThrow("Entity not found: missing");
  });
});
