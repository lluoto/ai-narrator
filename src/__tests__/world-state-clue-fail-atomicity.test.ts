import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorldStateManager } from "../state/world-state-manager";

function withSharedWorlds(run: (first: WorldStateManager, second: WorldStateManager) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "aitrpg-clue-fail-"));
  const dbPath = join(directory, "world.sqlite");
  const first = new WorldStateManager(dbPath);
  const second = new WorldStateManager(dbPath);
  try {
    run(first, second);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("WorldStateManager.incrementClueFail atomic returned count", () => {
  test("returns the durable count for first insertion and consecutive increments", () => {
    const world = new WorldStateManager();
    try {
      expect(world.incrementClueFail("archive")).toBe(1);
      expect(world.incrementClueFail("archive")).toBe(2);
      expect(world.incrementClueFail("archive")).toBe(3);
      expect(world.getClueFailCount("archive")).toBe(3);
    } finally {
      world.close();
    }
  });

  test("returns its own increment rather than a later interleaved durable count", () => {
    withSharedWorlds((first, second) => {
      const firstDb = first.getDatabase();
      const originalRun = firstDb.run.bind(firstDb);
      const originalQuery = firstDb.query.bind(firstDb);
      let interleaved = false;
      let secondResult: number | undefined;
      const interleaveSecondIncrement = () => {
        if (interleaved) return;
        interleaved = true;
        secondResult = second.incrementClueFail("archive");
      };

      // Old code calls run(UPSERT) and then query(SELECT). The run hook places
      // the second connection exactly between them. The RETURNING implementation
      // instead reaches the query hook; its wrapped get performs the same second
      // increment only after SQLite has produced the first statement's row.
      (firstDb as unknown as { run: typeof firstDb.run }).run = ((...args: Parameters<typeof firstDb.run>) => {
        const result = originalRun(...args);
        interleaveSecondIncrement();
        return result;
      }) as typeof firstDb.run;
      (firstDb as unknown as { query: typeof firstDb.query }).query = ((sql: string) => {
        const statement = originalQuery(sql);
        if (!sql.includes("RETURNING fail_count")) return statement;
        return {
          get: (...args: Parameters<typeof statement.get>) => {
            const result = statement.get(...args);
            interleaveSecondIncrement();
            return result;
          },
        } as typeof statement;
      }) as typeof firstDb.query;

      expect(first.incrementClueFail("archive")).toBe(1);
      expect(secondResult).toBe(2);
      expect(interleaved).toBe(true);
      expect(first.getClueFailCount("archive")).toBe(2);
    });
  });
});
