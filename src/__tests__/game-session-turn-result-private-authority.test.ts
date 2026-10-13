import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { newStatus } from "../rules/status-effects";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};

const sessions: GameSession[] = [];
const originalRandom = Math.random;

afterEach(() => {
  Math.random = originalRandom;
  while (sessions.length > 0) sessions.pop()!.close();
});

function fresh(label: string): GameSession {
  const session = new GameSession(
    `turn-result-private-${label}-${crypto.randomUUID()}`,
    "cosmic-horror",
    CFG,
    "investigator",
    "Ada",
  );
  sessions.push(session);
  return session;
}

function shadow(session: GameSession, name: string, value: unknown): void {
  expect(Reflect.set(session as unknown as Record<string, unknown>, name, value)).toBe(true);
}

async function sessionWithMonster(label: string, name: string): Promise<GameSession> {
  const id = `turn-result-${label}-${crypto.randomUUID()}`;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Ada");
  const target = new GameSession(id, "cosmic-horror", CFG);
  try {
    restoreSignedOrdinaryWorld(target, CFG, (world) => {
      const scene = world.getCurrentState().scene;
      world.upsertEntity({
        id: `${label}-monster`, name, type: "monster",
        hp: 30, maxHp: 30, ac: 0, status: [], position: scene, scene_id: scene,
      });
    }, source);
  } finally {
    source.close();
  }
  sessions.push(target);
  return target;
}

describe("GameSession turn and result authority", () => {
  test("same-name result shadows cannot forge the portable narrative, dice, or roll history", async () => {
    const session = await sessionWithMonster("snapshot-results", "骰子靶");
    Math.random = () => 0;
    expect((await session.act("攻击 骰子靶")).dice).toHaveLength(1);
    expect((await session.act("调查")).error).toBeUndefined();

    const before = session.exportOrdinarySessionSnapshot().state;
    expect(before.lastDiceRoll).not.toBeNull();
    expect(before.lastRolls.length).toBeGreaterThan(0);
    shadow(session, "lastNarrative", "FORGED NARRATIVE");
    shadow(session, "lastDiceRoll", { expr: "999d999", total: 999_999 });
    shadow(session, "lastRolls", [{ skill: "forged", roll: 1, target: 100, success: true }]);

    const after = session.exportOrdinarySessionSnapshot().state;
    expect(after.lastNarrative).toBe(before.lastNarrative);
    expect(after.lastDiceRoll).toEqual(before.lastDiceRoll);
    expect(after.lastRolls).toEqual(before.lastRolls);
  });

  test("a game-time shadow cannot redirect the next real action clock", async () => {
    const attacked = fresh("clock-attacked");
    const control = fresh("clock-control");
    Object.defineProperty(attacked, "gameTime", {
      value: { day: 999, period: "night", ticks: 0 }, configurable: true, writable: true,
    });

    const [attackedResponse, controlResponse] = await Promise.all([
      attacked.act("/help"),
      control.act("/help"),
    ]);
    expect(attackedResponse.state.gameTime).toEqual(controlResponse.state.gameTime);
  });

  test("a difficulty shadow cannot rewrite the public rule-transition source value", () => {
    const session = fresh("difficulty");
    expect(session.setDifficulty("hard")).toMatchObject({ ok: true });
    shadow(session, "activeDifficulty", null);

    expect(session.setDifficulty("easy")).toMatchObject({
      ok: true,
      value: { changes: [{ variable: "difficulty", from: "hard", to: "easy" }] },
    });
  });

  test("a forged pushed-roll shadow cannot manufacture a pushed retry", async () => {
    const session = fresh("pushed-roll");
    shadow(session, "_lastPushedRoll", { skill: "spot_hidden", roll: 99, target: 100 });
    Math.random = () => 0;

    const response = await session.act("推动");
    expect(response.events.some((event) => event.content.includes("没有待推动的检定"))).toBe(true);
    expect(session.skillGrowthMarks).toEqual([]);
  });

  test("an accessor shadow cannot replace the real pre-tick status target for a skill action", async () => {
    const session = fresh("acting-statuses");
    expect(session.updateActiveCharacter({ skillValues: { spot_hidden: 60 } })).toMatchObject({ status: "updated" });
    Object.defineProperty(session, "_actingStatusesBeforeTick", {
      configurable: true,
      get: () => [newStatus("abdominal_impaled")],
      set: () => undefined,
    });
    Math.random = () => 0.5; // d100=51: succeeds at 60, fails at forged 40.

    const response = await session.act("调查");
    expect(response.narrative).toContain("成功");
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    expect(session.exportOrdinarySessionSnapshot().state.lastRolls.at(-1)).toMatchObject({
      skill: "investigation", roll: 51, target: 60, success: true,
    });
  });

  test("an accessor shadow cannot redirect module turn messages or leave snapshot export blocked", async () => {
    const session = fresh("turn-messages");
    const redirected: Array<{ content: string }> = [];
    Object.defineProperty(session, "_turnMessages", {
      configurable: true,
      get: () => redirected,
      set: () => undefined,
    });

    const response = await session.act("加载模组 普瑞米尔的谷仓");
    expect(response.events.some((event) => event.content.includes("在 1921 年某日"))).toBe(true);
    expect(redirected).toEqual([]);
    expect(() => session.exportOrdinarySessionSnapshot()).not.toThrow();
  });

  test("clearing a sighting shadow cannot repeat a real mythos SAN sighting", async () => {
    const session = await sessionWithMonster("mythos", "修格斯");
    const first = await session.act("看看四周");
    expect(first.events.some((event) => event.content.includes("目击【修格斯】"))).toBe(true);
    const sanAfterFirst = session.sanity.state.currentSAN;
    shadow(session, "sightedMythos", new Set());

    const second = await session.act("看看四周");
    expect(second.events.some((event) => event.content.includes("目击【修格斯】"))).toBe(false);
    expect(session.sanity.state.currentSAN).toBe(sanAfterFirst);
  });
});
