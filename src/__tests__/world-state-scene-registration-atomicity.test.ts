import { describe, expect, test } from "bun:test";
import { WorldStateManager } from "../state/world-state-manager";

describe("WorldStateManager.registerScene atomicity", () => {
  test("keeps a concurrent description change when re-registering without a description", () => {
    const world = new WorldStateManager();
    world.registerScene("ward", "Ward", "original description");
    world.getDatabase().exec(`
      CREATE TRIGGER preserve_concurrent_scene_description
      BEFORE UPDATE OF name ON scenes
      WHEN OLD.id = 'ward'
      BEGIN
        UPDATE scenes SET description = 'concurrent description' WHERE id = OLD.id;
      END;
    `);

    world.registerScene("ward", "Renamed ward");

    expect(world.getScene("ward")).toMatchObject({
      name: "Renamed ward",
      description: "concurrent description",
    });
    world.close();
  });

  test("inserts an unknown scene and preserves non-owned fields on an explicit description update", () => {
    const world = new WorldStateManager();

    world.registerScene("ward", "Ward");
    expect(world.getScene("ward")).toMatchObject({ name: "Ward", description: "" });

    world.getDatabase().run(
      "UPDATE scenes SET lighting=?, dangers=?, exits=?, is_active=1 WHERE id=?",
      ["fog", '["flooded floor"]', '[{"target":"hall","desc":"to the hall"}]', "ward"],
    );

    world.registerScene("ward", "Renamed ward", "replacement description");
    expect(world.getScene("ward")).toMatchObject({
      name: "Renamed ward",
      description: "replacement description",
      lighting: "fog",
      dangers: ["flooded floor"],
      exits: [{ target: "hall", desc: "to the hall" }],
    });
    expect(world.getDatabase().query("SELECT is_active FROM scenes WHERE id=?").get("ward")).toEqual({ is_active: 1 });
    world.close();
  });
});
