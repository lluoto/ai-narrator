import { afterEach, describe, expect, test } from "bun:test";
import { WorldStateManager } from "../state/world-state-manager";

const worlds: WorldStateManager[] = [];

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.close();
});

function makeWorld(): WorldStateManager {
  const world = new WorldStateManager();
  worlds.push(world);
  world.upsertEntity({
    id: "target",
    name: "Target",
    type: "npc",
    hp: 1,
    maxHp: 1,
    ac: 10,
    status: [],
    position: "nowhere",
  });
  return world;
}

function addTimedEffect(world: WorldStateManager, duration: number) {
  world.addEffect({
    id: "timed-effect",
    source: "caster",
    target: "target",
    type: "buff",
    description: "Temporary ward",
    duration,
  });
}

function storedEffect(world: WorldStateManager) {
  return world.getDatabase()
    .query("SELECT * FROM effects WHERE id = ?")
    .get("timed-effect");
}

describe("WorldStateManager.tickEffects atomic truth-source transition", () => {
  test("rolls back duration and expiry visibility when SQLite rejects the deletion", () => {
    const world = makeWorld();
    addTimedEffect(world, 1);
    const beforeRow = storedEffect(world);
    const beforeActiveEffects = world.getActiveEffects();
    const beforeSnapshot = world.exportSnapshot();
    world.getDatabase().exec(`
      CREATE TRIGGER reject_effect_expiry
      BEFORE DELETE ON effects
      WHEN OLD.id = 'timed-effect'
      BEGIN
        SELECT RAISE(ABORT, 'effect deletion denied');
      END;
    `);

    expect(() => world.tickEffects()).toThrow("effect deletion denied");

    expect(storedEffect(world)).toEqual(beforeRow);
    expect(world.getActiveEffects()).toEqual(beforeActiveEffects);
    expect(world.exportSnapshot()).toEqual(beforeSnapshot);
  });

  test("returns and removes an effect that expires on this tick", () => {
    const world = makeWorld();
    addTimedEffect(world, 1);

    expect(world.tickEffects()).toEqual([{
      id: "timed-effect",
      source: "caster",
      target: "target",
      type: "buff",
      description: "Temporary ward",
      duration: 0,
    }]);
    expect(storedEffect(world)).toBeNull();
    expect(world.getActiveEffects()).toEqual([]);
    expect(world.exportSnapshot().tables.effects).toEqual([]);
  });

  test("decrements a still-active effect without reporting an expiry", () => {
    const world = makeWorld();
    addTimedEffect(world, 2);

    expect(world.tickEffects()).toEqual([]);
    expect(world.getActiveEffects()).toEqual([{
      id: "timed-effect",
      source: "caster",
      target: "target",
      type: "buff",
      description: "Temporary ward",
      duration: 1,
    }]);
    expect(storedEffect(world)).toMatchObject({ id: "timed-effect", duration: 1 });
  });
});
