import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldStateManager } from "../state/world-state-manager";
import {
  validateWorldStateSnapshot,
  worldStateSnapshotHash,
  type WorldStateSnapshot,
} from "../state/world-state-snapshot";

function temporaryDatabase(name: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), `aitrpg-${name}-`));
  return { directory, path: join(directory, "world.sqlite") };
}

function createLegacyScenesDatabase(
  path: string,
  rows: ReadonlyArray<readonly [id: string, isActive: number]>,
): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE scenes (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        lighting    TEXT DEFAULT 'normal',
        dangers     TEXT NOT NULL DEFAULT '[]',
        exits       TEXT NOT NULL DEFAULT '[]',
        is_active   INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insert = db.query(
      "INSERT INTO scenes (id, name, is_active) VALUES (?1, ?2, ?3)",
    );
    try {
      for (const [id, isActive] of rows) insert.run(id, id, isActive);
    } finally {
      insert.finalize();
    }
  } finally {
    db.close(true);
  }
}

function resign(snapshot: WorldStateSnapshot): WorldStateSnapshot {
  const unsigned = { ...snapshot } as Record<string, unknown>;
  delete unsigned.hash;
  return { ...snapshot, hash: worldStateSnapshotHash(unsigned) };
}

function withoutSceneProtections(world: WorldStateManager): void {
  world.getDatabase().exec(`
    DROP INDEX idx_scenes_single_active;
    DROP TRIGGER trg_scenes_is_active_bit_insert;
    DROP TRIGGER trg_scenes_is_active_bit_update;
  `);
}

const TAMPERED_ACTIVE_SCENE_PROTECTIONS = [
  ["non-unique active index", `
    CREATE INDEX idx_scenes_single_active
    ON scenes(is_active)
    WHERE is_active = 1;
  `],
  ["inert insert bit trigger", `
    CREATE TRIGGER trg_scenes_is_active_bit_insert
    BEFORE INSERT ON scenes
    FOR EACH ROW WHEN 0
    BEGIN SELECT RAISE(ABORT, 'never reached'); END;
  `],
  ["inert update bit trigger", `
    CREATE TRIGGER trg_scenes_is_active_bit_update
    BEFORE UPDATE OF is_active ON scenes
    FOR EACH ROW WHEN 0
    BEGIN SELECT RAISE(ABORT, 'never reached'); END;
  `],
] as const;

describe("WorldStateManager durable single-active-scene invariant", () => {
  test("database rejects raw duplicate active scenes and non-bit active values while allowing zero or one", () => {
      const world = new WorldStateManager();
    try {
      const db = world.getDatabase();

      const scenesSql = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenes'").get() as { sql: string };
      expect(scenesSql.sql).toMatch(/CONSTRAINT\s+chk_scenes_is_active_bit\s+CHECK\s*\(is_active IN \(0, 1\)\)/);
      expect(db.query("SELECT COUNT(*) AS count FROM scenes WHERE is_active=1").get()).toEqual({ count: 0 });
      db.run("INSERT INTO scenes (id, name, is_active) VALUES ('first', 'First', 1)");
      db.run("INSERT INTO scenes (id, name, is_active) VALUES ('second', 'Second', 0)");
      expect(db.query("SELECT COUNT(*) AS count FROM scenes WHERE is_active=1").get()).toEqual({ count: 1 });

      expect(() => db.run("INSERT INTO scenes (id, name, is_active) VALUES ('third', 'Third', 1)")).toThrow();
      expect(() => db.run("UPDATE scenes SET is_active=2 WHERE id=?", ["second"])).toThrow();
      expect(() => db.run("UPDATE scenes SET is_active=-1 WHERE id=?", ["second"])).toThrow();

      db.run("UPDATE scenes SET is_active=0 WHERE id=?", ["first"]);
      expect(db.query("SELECT COUNT(*) AS count FROM scenes WHERE is_active=1").get()).toEqual({ count: 0 });
    } finally {
      world.close();
    }
  });

  test("fails closed opening legacy corrupt scenes without changing them and closes the failed handle", () => {
    for (const [name, rows] of [
      ["multiple", [["first", 1], ["second", 1]]],
      ["illegal", [["first", 2], ["second", -1]]],
    ] as const) {
      const fixture = temporaryDatabase(`legacy-active-${name}`);
      createLegacyScenesDatabase(fixture.path, rows);
      try {
        expect(() => new WorldStateManager(fixture.path)).toThrow("Cannot enforce scenes.is_active invariant");

        const legacy = new Database(fixture.path);
        try {
          expect(legacy.query("SELECT id, is_active FROM scenes ORDER BY id").all()).toEqual(
            rows.map(([id, isActive]) => ({ id, is_active: isActive })),
          );
        } finally {
          legacy.close(true);
        }
      } finally {
        // On Windows this proves the failed constructor did not retain a lock.
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  test("fails closed when a second SQLite connection commits an illegal legacy bit after preflight", () => {
    const fixture = temporaryDatabase("legacy-active-preflight-race");
    createLegacyScenesDatabase(fixture.path, [["first", 0], ["second", 0]]);
    const writer = new Database(fixture.path);
    const databasePrototype = Database.prototype as unknown as { query: (sql: string) => any };
    const originalQuery = databasePrototype.query;
    let injected = false;
    let world: WorldStateManager | undefined;

    // The old startup path performed both data scans before its first DDL
    // transaction. Interleave a genuine second connection immediately after
    // the plural-active scan has observed the valid legacy rows.
    databasePrototype.query = function (this: Database, sql: string): any {
      const statement = originalQuery.call(this, sql);
      if (!sql.includes("FROM scenes") || !sql.includes("WHERE is_active = 1") || !sql.includes("LIMIT 2")) {
        return statement;
      }
      return {
        all: (...args: any[]) => {
          const rows = statement.all(...args);
          if (!injected) {
            writer.run("UPDATE scenes SET is_active=2 WHERE id='second'");
            injected = true;
          }
          return rows;
        },
        finalize: () => statement.finalize(),
      };
    };

    try {
      expect(() => {
        world = new WorldStateManager(fixture.path);
      }).toThrow();
      expect(injected).toBe(true);
      expect(writer.query("SELECT id, is_active FROM scenes ORDER BY id").all()).toEqual([
        { id: "first", is_active: 0 },
        { id: "second", is_active: 2 },
      ]);
      databasePrototype.query = originalQuery;
      expect(() => new WorldStateManager(fixture.path)).toThrow("Cannot enforce scenes.is_active invariant");
    } finally {
      databasePrototype.query = originalQuery;
      world?.close();
      writer.close(true);
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  for (const [name, tamperedDdl] of TAMPERED_ACTIVE_SCENE_PROTECTIONS) {
    test(`fails closed on a legacy database with a same-named ${name}`, () => {
      const fixture = temporaryDatabase(`legacy-active-tampered-${name}`);
      createLegacyScenesDatabase(fixture.path, [["inactive", 0], ["active", 1]]);
      const setup = new Database(fixture.path);
      try {
        setup.exec(tamperedDdl);
      } finally {
        setup.close(true);
      }

      let unexpectedlyOpened: WorldStateManager | undefined;
      try {
        expect(() => {
          unexpectedlyOpened = new WorldStateManager(fixture.path);
        }).toThrow("Cannot validate scenes.is_active durable protections");

        const legacy = new Database(fixture.path);
        try {
          expect(legacy.query("SELECT id, is_active FROM scenes ORDER BY id").all()).toEqual([
            { id: "active", is_active: 1 },
            { id: "inactive", is_active: 0 },
          ]);
        } finally {
          legacy.close(true);
        }
      } finally {
        // If construction ever incorrectly succeeds, keep this red test from
        // retaining its handle while exercising the Windows cleanup contract.
        unexpectedlyOpened?.close();
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    });
  }

  test("upgrades valid zero- and one-active legacy scenes with stable named guards while preserving rows", () => {
    for (const [name, rows, expectedScene] of [
      ["zero", [["first", 0], ["second", 0]], "unknown"],
      ["one", [["inactive", 0], ["active", 1]], "active"],
    ] as const) {
      const fixture = temporaryDatabase(`legacy-active-valid-${name}`);
      createLegacyScenesDatabase(fixture.path, rows);

      let world: WorldStateManager | undefined;
      try {
        world = new WorldStateManager(fixture.path);
        const db = world.getDatabase();
        expect(db.query("SELECT id, is_active FROM scenes ORDER BY id").all()).toEqual(
          rows.map(([id, isActive]) => ({ id, is_active: isActive })).sort((left, right) => left.id.localeCompare(right.id)),
        );
        expect(world.getCurrentState().scene).toBe(expectedScene);
        expect(db.query("PRAGMA index_list(scenes)").all()).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "idx_scenes_single_active", unique: 1 })]),
        );
        expect(db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='scenes' ORDER BY name").all()).toEqual([
          { name: "trg_scenes_is_active_bit_insert" },
          { name: "trg_scenes_is_active_bit_update" },
        ]);
        // This table predates the new-table CHECK. These direct raw writes
        // therefore prove that both durable legacy triggers enforce the bit.
        expect(() => db.run("INSERT INTO scenes (id, name, is_active) VALUES ('illegal-insert', 'Illegal', 2)")).toThrow();
        expect(() => db.run("UPDATE scenes SET is_active=-1 WHERE id=?", [rows[0][0]])).toThrow();
      } finally {
        world?.close();
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  test("validates the whole snapshot active-scene set before restore SQL", () => {
    const source = new WorldStateManager();
    const target = new WorldStateManager();
    try {
      source.registerScene("first", "First");
      source.registerScene("second", "Second");
      expect(source.setActiveScene("first")).toBe(true);
      const invalid = source.exportSnapshot();
      invalid.tables.scenes.find((scene) => scene.id === "second")!.is_active = 1;
      const reSigned = resign(invalid);

      target.getDatabase().exec(`
        CREATE TRIGGER reject_restore_delete
        BEFORE DELETE ON scenes
        BEGIN SELECT RAISE(ABORT, 'restore SQL executed'); END;
      `);
      expect(() => validateWorldStateSnapshot(reSigned)).toThrow("multiple active scenes");
      expect(() => target.restoreSnapshot(reSigned)).toThrow("multiple active scenes");

      const illegalBit = source.exportSnapshot();
      illegalBit.tables.scenes[0]!.is_active = 2 as 0 | 1;
      expect(() => validateWorldStateSnapshot(resign(illegalBit))).toThrow("is_active must be 0 or 1");
    } finally {
      source.close();
      target.close();
    }
  });

  test("active-scene readers, snapshot exports, and setActiveScene fail closed when protections were explicitly removed", () => {
    const fixture = temporaryDatabase("active-reader-corruption");
    createLegacyScenesDatabase(fixture.path, [["first", 0], ["second", 0]]);

    let world: WorldStateManager | undefined;
    try {
      world = new WorldStateManager(fixture.path);
      const db = world.getDatabase();
      withoutSceneProtections(world);
      db.run("UPDATE scenes SET is_active=1 WHERE id='first'");
      db.run("UPDATE scenes SET is_active=1 WHERE id='second'");
      const before = db.query("SELECT id, is_active FROM scenes ORDER BY id").all();

      expect(() => world!.getCurrentState()).toThrow("multiple active scenes");
      expect(() => world!.exportSnapshot()).toThrow("multiple active scenes");
      expect(() => world!.createSnapshot()).toThrow("multiple active scenes");
      expect(() => world!.setActiveScene("first")).toThrow("multiple active scenes");
      expect(db.query("SELECT id, is_active FROM scenes ORDER BY id").all()).toEqual(before);

      db.run("UPDATE scenes SET is_active=0");
      db.run("UPDATE scenes SET is_active=2 WHERE id='first'");
      expect(() => world!.getCurrentState()).toThrow("is_active must be 0 or 1");
      expect(() => world!.exportSnapshot()).toThrow("is_active must be 0 or 1");
      expect(() => world!.setActiveScene("second")).toThrow("is_active must be 0 or 1");
    } finally {
      world?.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
