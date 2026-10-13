// todo-17 的一小段闭环：经济引擎已经为同一次推进的事件盖上 causationId，
// 但它必须穿过 GameSession 和 SQLite event_log，而不能只活在进程内数组里。

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { WorldStateManager } from "../state/world-state-manager";

const CFG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 64,
  temperature: 0,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

type LoggedEvent = {
  round: number;
  timestamp: number;
  event_type: string;
  description: string;
  causationId?: string;
};

describe("event_log causationId persistence", () => {
  test("logEvent writes and getRecentEvents reads causationId, while ordinary events remain compatible", () => {
    const world = new WorldStateManager(":memory:");
    try {
      world.logEvent({
        round: 7,
        timestamp: 123,
        event_type: "system",
        description: "带因果链的事件",
        causationId: "cause:direct:7",
      });
      world.logEvent({
        round: 8,
        timestamp: 456,
        event_type: "system",
        description: "既有普通事件",
      });

      const [caused, ordinary] = world.getRecentEvents(2);
      expect(caused).toMatchObject({
        round: 7,
        description: "带因果链的事件",
        causationId: "cause:direct:7",
      });
      // logEvent 以前就不把调用方传入的 timestamp 写进 INSERT；这次只加
      // causation_id，仍让 SQLite 的默认时间戳保持既有语义。
      expect(caused.timestamp).not.toBe(123);
      expect(ordinary).toMatchObject({ round: 8, description: "既有普通事件" });
      expect(ordinary).not.toHaveProperty("causationId");
    } finally {
      world.close();
    }
  });

  test("opening an existing event_log adds causation_id without discarding its old rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "event-causation-migration-"));
    const dbPath = join(directory, "world.sqlite");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(`
      CREATE TABLE event_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        round       INTEGER NOT NULL,
        timestamp   INTEGER NOT NULL DEFAULT (unixepoch()),
        event_type  TEXT NOT NULL,
        actor       TEXT DEFAULT NULL,
        target      TEXT DEFAULT NULL,
        description TEXT NOT NULL,
        result_json TEXT DEFAULT NULL
      );
      INSERT INTO event_log (round, event_type, description)
      VALUES (4, 'system', '旧事件必须保留');
    `);
    legacy.close();

    const world = new WorldStateManager(dbPath);
    try {
      const columns = world.getDatabase().query("PRAGMA table_info(event_log)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("causation_id");

      const [legacyEvent] = world.getRecentEvents();
      expect(legacyEvent).toMatchObject({ round: 4, description: "旧事件必须保留" });
      expect(legacyEvent).not.toHaveProperty("causationId");

      world.logEvent({
        round: 5,
        timestamp: 999,
        event_type: "system",
        description: "迁移后新事件",
        causationId: "cause:migrated:5",
      });
      expect(world.getRecentEvents(2)[1]).toMatchObject({ causationId: "cause:migrated:5" });
    } finally {
      world.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a real GameSession economy tick persists the engine batch causationId", async () => {
    const sessionId = `eco-causation-${Math.random()}`;
    const session = new GameSession(sessionId, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    await session.act("创建角色 investigator 因果见证者"); // round=1
    for (let i = 0; i < 9; i++) await session.act("观察"); // round=10，触发经济时钟

    expect(session.round).toBe(10);
    const economyEvents = (session.world.getRecentEvents(200) as LoggedEvent[])
      .filter((event) => event.description.startsWith("[经济] "));
    expect(economyEvents.length).toBeGreaterThan(0);
    expect(new Set(economyEvents.map((event) => event.causationId))).toEqual(
      new Set([`eco:${sessionId}:round:10`]),
    );
  }, 20_000);
});
