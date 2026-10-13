import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldStateManager } from "../state/world-state-manager";

function storedRelation(world: WorldStateManager, a: string, b: string) {
  return world.getDatabase()
    .query("SELECT entity_a, entity_b, relation, attitude FROM relationships WHERE entity_a=?1 AND entity_b=?2")
    .get(a, b);
}

function withSharedWorlds(run: (first: WorldStateManager, second: WorldStateManager) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "aitrpg-relationship-"));
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

function createLegacyRelationshipsDatabase(
  dbPath: string,
  rows: ReadonlyArray<readonly [entityA: string, entityB: string, relation: string, attitude: number]>,
): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE relationships (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_a    TEXT NOT NULL,
        entity_b    TEXT NOT NULL,
        relation    TEXT NOT NULL,
        attitude    INTEGER NOT NULL DEFAULT 0,
        note        TEXT DEFAULT '',
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(entity_a, entity_b)
      );
    `);
    const insert = db.query(
      "INSERT INTO relationships (entity_a, entity_b, relation, attitude) VALUES (?1, ?2, ?3, ?4)",
    );
    try {
      for (const [entityA, entityB, relation, attitude] of rows) {
        insert.run(entityA, entityB, relation, attitude);
      }
    } finally {
      insert.finalize();
    }
  } finally {
    db.close(true);
  }
}

const TAMPERED_UNORDERED_RELATIONSHIP_INDEXES = [
  ["non-unique expression index", `
    CREATE INDEX idx_relationships_unordered_pair
    ON relationships (
      CASE WHEN entity_a <= entity_b THEN entity_a ELSE entity_b END,
      CASE WHEN entity_a <= entity_b THEN entity_b ELSE entity_a END
    );
  `],
  ["unique directional-column index", `
    CREATE UNIQUE INDEX idx_relationships_unordered_pair
    ON relationships (entity_a, entity_b);
  `],
] as const;

describe("WorldStateManager.modifyAttitude atomic truth-source transition", () => {
  for (const [name, tamperedDdl] of TAMPERED_UNORDERED_RELATIONSHIP_INDEXES) {
    test(`fails closed on a legacy relationship database with a same-named ${name}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "aitrpg-legacy-relationship-tampered-"));
      const dbPath = join(directory, "world.sqlite");
      createLegacyRelationshipsDatabase(dbPath, [["keeper", "investigator", "neutral", 0]]);
      const setup = new Database(dbPath);
      try {
        setup.exec(tamperedDdl);
      } finally {
        setup.close(true);
      }

      let unexpectedlyOpened: WorldStateManager | undefined;
      try {
        expect(() => {
          unexpectedlyOpened = new WorldStateManager(dbPath);
        }).toThrow("Cannot validate unordered relationship durable protection");

        const legacy = new Database(dbPath);
        try {
          expect(legacy.query(
            "SELECT entity_a, entity_b, relation, attitude FROM relationships ORDER BY id",
          ).all()).toEqual([
            { entity_a: "keeper", entity_b: "investigator", relation: "neutral", attitude: 0 },
          ]);
        } finally {
          legacy.close(true);
        }
      } finally {
        unexpectedlyOpened?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("setRelation treats reverse callers as one persistent pair without replacing its row", () => {
    const world = new WorldStateManager();
    try {
      world.setRelation("keeper", "investigator", "ally", 1);
      const first = world.getDatabase().query(
        "SELECT id, entity_a, entity_b, relation, attitude FROM relationships",
      ).get() as { id: number; entity_a: string; entity_b: string; relation: string; attitude: number };

      world.setRelation("investigator", "keeper", "hostile", -4);

      expect(world.getDatabase().query(
        "SELECT id, entity_a, entity_b, relation, attitude FROM relationships",
      ).all()).toEqual([{
        id: first.id,
        entity_a: "investigator",
        entity_b: "keeper",
        relation: "hostile",
        attitude: -4,
      }]);
    } finally {
      world.close();
    }
  });

  test("database rejects raw reverse relationships while permitting self-pairs", () => {
    const world = new WorldStateManager();
    try {
      const db = world.getDatabase();
      db.run("INSERT INTO relationships (entity_a, entity_b, relation, attitude) VALUES (?1, ?2, ?3, ?4)", [
        "investigator", "keeper", "ally", 1,
      ]);
      expect(() => db.run(
        "INSERT INTO relationships (entity_a, entity_b, relation, attitude) VALUES (?1, ?2, ?3, ?4)",
        ["keeper", "investigator", "hostile", -1],
      )).toThrow();
      expect(db.query("PRAGMA index_list(relationships)").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "idx_relationships_unordered_pair", unique: 1 })]),
      );
      db.run("INSERT INTO relationships (entity_a, entity_b, relation, attitude) VALUES (?1, ?2, ?3, ?4)", [
        "self", "self", "neutral", 0,
      ]);
      expect(db.query("SELECT entity_a, entity_b FROM relationships WHERE entity_a='self'").all()).toEqual([
        { entity_a: "self", entity_b: "self" },
      ]);
    } finally {
      world.close();
    }
  });

  test("fails closed opening an old database with reverse duplicate relationships without changing either row", () => {
    const directory = mkdtempSync(join(tmpdir(), "aitrpg-legacy-relationship-conflict-"));
    const dbPath = join(directory, "world.sqlite");
    createLegacyRelationshipsDatabase(dbPath, [
      ["investigator", "keeper", "ally", 1],
      ["keeper", "investigator", "hostile", -1],
    ]);

    try {
      expect(() => new WorldStateManager(dbPath)).toThrow("Cannot enforce unordered relationship uniqueness");

      const legacy = new Database(dbPath);
      try {
        const rows = legacy.query(
          "SELECT entity_a, entity_b, relation, attitude FROM relationships ORDER BY id",
        );
        try {
          expect(rows.all()).toEqual([
            { entity_a: "investigator", entity_b: "keeper", relation: "ally", attitude: 1 },
            { entity_a: "keeper", entity_b: "investigator", relation: "hostile", attitude: -1 },
          ]);
        } finally {
          rows.finalize();
        }
      } finally {
        legacy.close(true);
      }
    } finally {
      // A failed WorldStateManager construction must close its opened handle or
      // Windows cannot remove this directory.
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("opens a non-conflicting reverse-oriented old relationship and preserves its direction on update", () => {
    const directory = mkdtempSync(join(tmpdir(), "aitrpg-legacy-relationship-single-"));
    const dbPath = join(directory, "world.sqlite");
    createLegacyRelationshipsDatabase(dbPath, [["keeper", "investigator", "neutral", 0]]);

    let world: WorldStateManager | undefined;
    try {
      world = new WorldStateManager(dbPath);
      const before = world.getDatabase().query("SELECT id FROM relationships").get() as { id: number };
      expect(world.getDatabase().query("PRAGMA index_list(relationships)").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "idx_relationships_unordered_pair", unique: 1 })]),
      );

      world.setRelation("investigator", "keeper", "ally", 2);

      expect(world.getDatabase().query(
        "SELECT id, entity_a, entity_b, relation, attitude FROM relationships",
      ).all()).toEqual([{
        id: before.id,
        entity_a: "keeper",
        entity_b: "investigator",
        relation: "ally",
        attitude: 2,
      }]);
    } finally {
      world?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("derives the durable relation from the new attitude when crossing a sign boundary", () => {
    const world = new WorldStateManager();
    try {
      world.setRelation("investigator", "keeper", "hostile", -2);

      const crossedPositive = world.modifyAttitude("investigator", "keeper", 3);
      expect(storedRelation(world, "investigator", "keeper")).toEqual({
        entity_a: "investigator", entity_b: "keeper", relation: "ally", attitude: 1,
      });
      expect(world.getAttitude("investigator", "keeper")).toBe(1);
      expect(crossedPositive).toEqual({ relation: "ally", attitude: 1 });

      const crossedNegative = world.modifyAttitude("investigator", "keeper", -2);
      expect(storedRelation(world, "investigator", "keeper")).toEqual({
        entity_a: "investigator", entity_b: "keeper", relation: "hostile", attitude: -1,
      });
      expect(world.getAttitude("investigator", "keeper")).toBe(-1);
      expect(crossedNegative).toEqual({ relation: "hostile", attitude: -1 });
    } finally {
      world.close();
    }
  });

  test("does not lose an intervening same-pair increment from another SQLite connection", () => {
    withSharedWorlds((first, second) => {
      first.setRelation("investigator", "keeper", "neutral", 0);

      const firstDb = first.getDatabase();
      const originalQuery = firstDb.query.bind(firstDb);
      let interleaved = false;
      let secondResult: { relation: string; attitude: number } | undefined;
      const interleaveSecondIncrement = () => {
        if (interleaved) return;
        interleaved = true;
        secondResult = second.modifyAttitude("investigator", "keeper", 1);
      };

      // The old implementation obtains the attitude with this SELECT, then
      // writes its cached value. Interleave a real public mutation after that
      // read. The atomic implementation reaches the RETURNING statement;
      // interleaving after SQLite has produced its row preserves both changes.
      (firstDb as unknown as { query: typeof firstDb.query }).query = ((sql: string) => {
        const statement = originalQuery(sql);
        if (!sql.includes("SELECT attitude FROM relationships") && !sql.includes("RETURNING relation, attitude")) {
          return statement;
        }
        return {
          get: (...args: Parameters<typeof statement.get>) => {
            const result = statement.get(...args);
            interleaveSecondIncrement();
            return result;
          },
          all: (...args: Parameters<typeof statement.all>) => {
            const result = statement.all(...args);
            interleaveSecondIncrement();
            return result;
          },
        } as typeof statement;
      }) as typeof firstDb.query;

      const firstResult = first.modifyAttitude("investigator", "keeper", 1);
      expect(interleaved).toBe(true);
      expect(storedRelation(first, "investigator", "keeper")).toEqual({
        entity_a: "investigator", entity_b: "keeper", relation: "ally", attitude: 2,
      });
      expect(first.getAttitude("investigator", "keeper")).toBe(2);
      expect(second.getAttitude("investigator", "keeper")).toBe(2);
      expect(firstResult).toEqual({ relation: "ally", attitude: 1 });
      expect(secondResult).toEqual({ relation: "ally", attitude: 2 });
    });
  });

  test("merges opposite first creates after both connections preselect an absent pair", () => {
    withSharedWorlds((first, second) => {
      const a = "investigator";
      const b = "keeper";
      const firstDb = first.getDatabase();
      const originalQuery = firstDb.query.bind(firstDb);
      let interleaved = false;
      let secondResult: { relation: string; attitude: number } | undefined;

      // Keep the first call suspended after its matching-pair SELECT has
      // observed no row. The reverse call then independently observes/creates
      // the pair before the first call reaches its write.
      (firstDb as unknown as { query: typeof firstDb.query }).query = ((sql: string) => {
        const statement = originalQuery(sql);
        if (!sql.includes("SELECT entity_a, entity_b FROM relationships")) {
          return statement;
        }
        return {
          all: (...args: Parameters<typeof statement.all>) => {
            const rows = statement.all(...args);
            if (!interleaved) {
              expect(rows).toEqual([]);
              interleaved = true;
              secondResult = second.modifyAttitude(b, a, 1);
            }
            return rows;
          },
        } as typeof statement;
      }) as typeof firstDb.query;

      const firstResult = first.modifyAttitude(a, b, 1);
      expect(interleaved).toBe(true);
      expect(first.getDatabase()
        .query("SELECT entity_a, entity_b, relation, attitude FROM relationships ORDER BY entity_a, entity_b")
        .all())
        .toEqual([
          { entity_a: a, entity_b: b, relation: "ally", attitude: 2 },
        ]);
      expect(first.getAttitude(a, b)).toBe(2);
      expect(second.getAttitude(a, b)).toBe(2);
      expect(firstResult).toEqual({ relation: "ally", attitude: 2 });
      expect(secondResult).toEqual({ relation: "ally", attitude: 1 });
    });
  });

  test("fails closed when callers have created conflicting directional rows", () => {
    const world = new WorldStateManager();
    try {
      world.setRelation("investigator", "keeper", "ally", 1);
      world.getDatabase().exec("DROP INDEX idx_relationships_unordered_pair");
      world.getDatabase().run(
        "INSERT INTO relationships (entity_a, entity_b, relation, attitude) VALUES (?1, ?2, ?3, ?4)",
        ["keeper", "investigator", "hostile", -1],
      );

      expect(() => world.modifyAttitude("investigator", "keeper", 1)).toThrow(
        "multiple directional relationships exist",
      );
      expect(world.getDatabase()
        .query("SELECT entity_a, entity_b, relation, attitude FROM relationships ORDER BY entity_a, entity_b")
        .all())
        .toEqual([
          { entity_a: "investigator", entity_b: "keeper", relation: "ally", attitude: 1 },
          { entity_a: "keeper", entity_b: "investigator", relation: "hostile", attitude: -1 },
        ]);
    } finally {
      world.close();
    }
  });

  test("reads a single directional relationship symmetrically and rejects directional conflicts", () => {
    const world = new WorldStateManager();
    try {
      expect(world.getAttitude("investigator", "keeper")).toBe(0);
      world.setRelation("investigator", "keeper", "ally", 1);
      expect(world.getAttitude("keeper", "investigator")).toBe(1);
      world.getDatabase().exec("DROP INDEX idx_relationships_unordered_pair");
      world.getDatabase().run(
        "INSERT INTO relationships (entity_a, entity_b, relation, attitude) VALUES (?1, ?2, ?3, ?4)",
        ["keeper", "investigator", "hostile", -1],
      );

      expect(() => world.getAttitude("investigator", "keeper")).toThrow(
        "multiple directional relationships exist",
      );
      expect(() => world.getAttitude("keeper", "investigator")).toThrow(
        "multiple directional relationships exist",
      );
    } finally {
      world.close();
    }
  });
});
