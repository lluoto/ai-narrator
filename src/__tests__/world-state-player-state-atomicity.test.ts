import { afterEach, describe, expect, test } from "bun:test";
import { WorldStateManager } from "../state/world-state-manager";

const worlds: WorldStateManager[] = [];

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.close();
});

function makeWorld(): WorldStateManager {
  const world = new WorldStateManager();
  worlds.push(world);
  return world;
}

describe("WorldStateManager player-state writes are atomic", () => {
  test("rolls back auto-registration and preserves an existing player when SQLite rejects the update", () => {
    const world = makeWorld();
    world.setPlayerInventory("existing-player", ["old lantern"]);
    world.setPlayerWeapons("existing-player", ["old knife"]);
    world.setPlayerArmor("existing-player", ["old coat"]);
    const existingPlayer = world.getPlayerState("existing-player");
    const existingRow = world.getDatabase()
      .query("SELECT sanity, inventory, weapons, armor, updated_at FROM player_state WHERE entity_id = ?")
      .get("existing-player");
    const beforeState = world.getCurrentState();
    world.getDatabase().exec(`
      CREATE TRIGGER reject_new_player_inventory
      BEFORE UPDATE OF inventory ON player_state
      WHEN NEW.entity_id IN ('new-player', 'existing-player')
      BEGIN
        SELECT RAISE(ABORT, 'inventory update denied');
      END;
    `);

    expect(() => world.setPlayerInventory("new-player", ["lantern"])).toThrow("inventory update denied");

    expect(world.getDatabase().query("SELECT entity_id FROM player_state WHERE entity_id = ?").get("new-player")).toBeNull();
    expect(world.getPlayerState("new-player")).toBeNull();
    expect(world.getPlayerIds()).toEqual(["existing-player"]);

    expect(() => world.setPlayerInventory("existing-player", ["replacement"])).toThrow("inventory update denied");
    expect(world.getPlayerState("existing-player")).toEqual(existingPlayer);
    expect(world.getDatabase()
      .query("SELECT sanity, inventory, weapons, armor, updated_at FROM player_state WHERE entity_id = ?")
      .get("existing-player")).toEqual(existingRow);
    expect(world.getCurrentState()).toEqual(beforeState);
  });

  test("keeps auto-registration and durable inventory writes for a previously unknown player", () => {
    const world = makeWorld();
    const expectedPlayerState = {
      sanity: null,
      inventory: ["lantern"],
      weapons: [],
      armor: [],
    };

    world.setPlayerInventory("new-player", ["lantern"]);

    expect(world.getPlayerIds()).toEqual(["new-player"]);
    expect(world.getPlayerState("new-player")).toEqual(expectedPlayerState);
    expect(world.getCurrentState().players["new-player"]).toEqual(expectedPlayerState);
  });
});
