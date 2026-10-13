import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorldStateManager } from "../state/world-state-manager";

function withSharedWorlds(run: (first: WorldStateManager, second: WorldStateManager) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "aitrpg-scene-environment-"));
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

describe("WorldStateManager.setSceneEnvironment atomic partial writes", () => {
  test("keeps a concurrent durable dangers update while changing only lighting", () => {
    withSharedWorlds((first, second) => {
      first.registerScene("ward", "Ward", "A guarded room");
      first.setSceneEnvironment("ward", "dim", ["wet floor"]);

      const firstDb = first.getDatabase();
      const originalRun = firstDb.run.bind(firstDb);
      let interleaved = false;
      (firstDb as unknown as { run: typeof firstDb.run }).run = ((...args: Parameters<typeof firstDb.run>) => {
        if (!interleaved) {
          interleaved = true;
          // Schedule a real write through another connection at the exact
          // read/write boundary. The hook does not forge a row or a result.
          second.setSceneEnvironment("ward", undefined, ["toxic fog"]);
        }
        return originalRun(...args);
      }) as typeof firstDb.run;

      first.setSceneEnvironment("ward", "bright");

      expect(interleaved).toBe(true);
      expect(first.getScene("ward")).toMatchObject({
        lighting: "bright",
        dangers: ["toxic fog"],
      });
    });
  });

  test("writes explicit empty values, preserves omitted values, and rejects an unknown scene", () => {
    const world = new WorldStateManager();
    try {
      world.registerScene("ward", "Ward", "A guarded room");
      world.setSceneEnvironment("ward", "dim", ["wet floor"]);

      world.setSceneEnvironment("ward", "", []);
      expect(world.getScene("ward")).toMatchObject({ lighting: "", dangers: [] });

      world.setSceneEnvironment("ward", undefined, undefined);
      expect(world.getScene("ward")).toMatchObject({ lighting: "", dangers: [] });

      expect(() => world.setSceneEnvironment("missing", "bright", ["toxic fog"]))
        .toThrow("cannot set environment for an unknown scene: missing");
    } finally {
      world.close();
    }
  });
});
