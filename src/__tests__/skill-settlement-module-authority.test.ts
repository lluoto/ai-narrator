import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash, type OrdinarySnapshotJson } from "../api/ordinary-game-session-snapshot";

const OFFLINE_LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};
const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;

function durableFixtureSession(session: GameSession): GameSession {
  return new Proxy(session, {
    get(target, property) {
      if (property === "act") {
        return (input: string, pcId?: string) => runOrdinaryDurableActionTransaction(
          target,
          durableCareerHostCapability,
          async (act) => act(input, pcId),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createSession(id: string, careerRoot: string, withCharacter = true): GameSession {
  return durableFixtureSession(new GameSession(
    id,
    "cosmic-horror",
    OFFLINE_LLM,
    withCharacter ? "investigator" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined,
    { careerRoot },
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: durableCareerHostCapability },
  ));
}

/** Settlement uses characters and career snapshots, so seed its score through the durable envelope. */
function createSessionWithPersistedSkills(id: string, careerRoot: string, skills: Record<string, number>): GameSession {
  const source = createSession(id, careerRoot);
  const snapshot = source.exportOrdinarySessionSnapshot();
  const p1 = snapshot.state.characters.find((entry) => entry.pcId === "p1");
  if (!p1 || p1.sheet === null || Array.isArray(p1.sheet) || typeof p1.sheet !== "object") throw new Error("fixture requires p1 sheet");
  const sheet = p1.sheet as Record<string, OrdinarySnapshotJson>;
  if (sheet.skillValues === null || Array.isArray(sheet.skillValues) || typeof sheet.skillValues !== "object") throw new Error("fixture requires CoC skillValues");
  Object.assign(sheet.skillValues as Record<string, OrdinarySnapshotJson>, skills);
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const target = createSession(id, careerRoot, false);
  target.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
  source.close();
  return target;
}

test("a settlement request preserves marks and legal module-carried legacy growth until confirmed departure", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-settlement-authority-"));
  const id = `skill-settlement-authority-${crypto.randomUUID()}`;
  const source = createSession(id, join(root, "source"));
  const session = createSession(id, join(root, "restored"), false);
  const originalRandom = Math.random;
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const legacySnapshot = structuredClone(source.exportOrdinarySessionSnapshot());
    legacySnapshot.state.growthChangesByPC = [{ pcId: "p1", changes: ["legacy module growth"] }];
    const { snapshotHash: _discarded, ...unsigned } = legacySnapshot;
    session.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
    Math.random = () => 0;
    expect((await session.act("调查")).error).toBeUndefined();

    let randomCalls = 0;
    Math.random = () => {
      randomCalls += 1;
      return 0.99;
    };
    const result = await session.act("模组结算");

    expect(result.error).toBeUndefined();
    expect(result.narrative).toContain("确认离开");
    expect(result.events.some((event) => event.content.includes("模组完成"))).toBe(false);
    expect(randomCalls).toBe(0);
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    expect(session.exportOrdinarySessionSnapshot().state.growthChangesByPC).toEqual([
      { pcId: "p1", changes: ["legacy module growth"] },
    ]);
    expect(session.careerStore?.getEntries("Ada") ?? []).toEqual([]);
  } finally {
    Math.random = originalRandom;
    source.close();
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a no-mark settlement without a module reports the missing authority before the no-growth hint", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-settlement-no-module-hint-"));
  const session = createSession(`skill-settlement-no-module-hint-${crypto.randomUUID()}`, root);
  try {
    const result = await session.act("模组结算");

    expect(result.error).toBeUndefined();
    expect(result.narrative).toContain("没有可验证的已发布普通模组");
    expect(result.narrative).not.toContain("没有可结算的成长");
    expect(result.events.some((event) => event.content.includes("模组完成"))).toBe(false);
    expect(session.careerStore?.getEntries("Ada") ?? []).toEqual([]);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a module settlement request only opens the departure confirmation; confirmed departure is the sole growth and career commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-settlement-departure-only-"));
  const session = createSessionWithPersistedSkills(
    `skill-settlement-departure-only-${crypto.randomUUID()}`, root, { spot_hidden: 1 },
  );
  const originalRandom = Math.random;
  try {
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    Math.random = () => 0;
    expect((await session.act("调查")).error).toBeUndefined();

    let randomCalls = 0;
    Math.random = () => {
      randomCalls += 1;
      return randomCalls === 1 ? 0.5 : 0;
    };

    // `技能成长` reaches the same regex intent as `模组结算`; neither spelling
    // may apply a roll, clear a mark, emit completion, or end a session alone.
    const requested = await session.act("技能成长");
    expect(session.dead).toBe(false);
    expect(requested.narrative).toContain("确定要离开");
    expect(requested.events.some((event) => event.content.includes("模组完成"))).toBe(false);
    expect(randomCalls).toBe(0);
    expect(session.activeCharacter?.skillValues?.spot_hidden).toBe(1);
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    expect(session.careerStore?.getEntries("Ada") ?? []).toEqual([]);

    const committed = await session.act("确定");
    const entries = session.careerStore?.getEntries("Ada") ?? [];
    expect(session.dead).toBe(false);
    expect(session.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(randomCalls).toBe(2);
    expect(session.activeCharacter?.skillValues?.spot_hidden).toBe(2);
    expect(session.skillGrowthMarks).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.endingId).not.toBe("completed");
    expect(entries[0]?.skillChanges).toContain("spot_hidden→2");
    expect(committed.events.some((event) => event.content.includes("模组完成"))).toBe(false);
  } finally {
    Math.random = originalRandom;
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a public loaded-module shadow cannot suppress a real departure settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-settlement-shadow-module-"));
  const session = createSession(`skill-settlement-inconsistent-module-${crypto.randomUUID()}`, root);
  const originalRandom = Math.random;
  try {
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    Math.random = () => 0;
    expect((await session.act("调查")).error).toBeUndefined();
    Math.random = () => 0.99;
    Reflect.set(session, "_loadedModules", new Map());

    const requestedSettlement = await session.act("模组结算");
    expect(requestedSettlement.narrative).toContain("确定要离开");
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    const result = await session.act("确定");

    expect(result.error).toBeUndefined();
    expect(session.dead).toBe(false);
    expect(session.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(result.events.some((event) => event.content.includes("起点缺失"))).toBe(false);
    expect(session.careerStore?.getEntries("Ada") ?? []).toHaveLength(1);
  } finally {
    Math.random = originalRandom;
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
