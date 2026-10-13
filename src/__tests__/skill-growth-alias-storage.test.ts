import { expect, it } from "bun:test";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash, type OrdinarySnapshotJson } from "../api/ordinary-game-session-snapshot";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const FIXTURE_LLM = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 64, temperature: 0,
};
const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;

function freshSession(id: string): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: durableCareerHostCapability },
  );
}

/** Use a signed portable restore for tests whose growth/settlement path needs map ownership. */
function sessionWithPersistedSkills(id: string, skillValues: Record<string, number>): GameSession {
  const source = new GameSession(
    id, "cosmic-horror", undefined, "investigator", "别名成长测试员",
    undefined, undefined, undefined, "development_fallback",
  );
  const snapshot = source.exportOrdinarySessionSnapshot();
  const p1 = snapshot.state.characters.find((entry) => entry.pcId === "p1");
  if (!p1 || p1.sheet === null || Array.isArray(p1.sheet) || typeof p1.sheet !== "object") throw new Error("fixture requires p1 sheet");
  const sheet = p1.sheet as Record<string, OrdinarySnapshotJson>;
  if (sheet.skillValues === null || Array.isArray(sheet.skillValues) || typeof sheet.skillValues !== "object") throw new Error("fixture requires CoC skillValues");
  Object.assign(sheet.skillValues as Record<string, OrdinarySnapshotJson>, skillValues);
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const target = freshSession(id);
  target.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
  source.close();
  return target;
}

function activeSkill(session: GameSession, skill: string): number | undefined {
  return session.activeCharacter?.skillValues?.[skill];
}

async function durableAct(session: GameSession, input: string) {
  return runOrdinaryDurableActionTransaction(
    session,
    durableCareerHostCapability,
    async (act) => act(input),
  );
}

function fixedRandom(values: number[]): () => void {
  const original = Math.random;
  let index = 0;
  Math.random = () => {
    const value = values[index++];
    if (value === undefined) throw new Error(`unexpected Math.random call ${index}`);
    return value;
  };
  return () => { Math.random = original; };
}

async function succeedInvestigationAndLeaveGrowthMark(session: GameSession): Promise<void> {
  const checked = await session.act("调查");
  expect(checked.error).toBeUndefined();
  expect(session.exportOrdinarySessionSnapshot().state.lastRolls.at(-1)).toMatchObject({ skill: "investigation", roll: 1, target: 1, success: true });
  expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
}

it("stores a successful investigation mark at its CoC key, preserves it on rest, and grows it on settlement", async () => {
  const realRandom = Math.random;
  let session: GameSession | undefined;
  let restoreRandom: (() => void) | undefined;
  try {
    session = sessionWithPersistedSkills("skill_growth_alias_rest", { spot_hidden: 1 });
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    restoreRandom = fixedRandom([0]);

    await succeedInvestigationAndLeaveGrowthMark(session);
    restoreRandom();
    restoreRandom = undefined;
    let restRolls = 0;
    Math.random = () => {
      restRolls += 1;
      throw new Error("rest must not roll alias growth marks");
    };
    const rested = await session.act("休息");

    expect(rested.error).toBeUndefined();
    expect(restRolls).toBe(0);
    expect(activeSkill(session, "spot_hidden")).toBe(1);
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    expect(Object.hasOwn(session.activeCharacter?.skillValues ?? {}, "investigation")).toBe(false);
    let settlementRandomCalls = 0;
    Math.random = (() => {
      const values = [0.5, 0];
      let index = 0;
      return () => {
        settlementRandomCalls += 1;
        return values[index++] ?? 0;
      };
    })();
    const entriesBeforeRequest = session.careerStore?.getEntries(session.activeCharacter!.name) ?? [];
    const requested = await session.act("模组结算");
    expect(requested.error).toBeUndefined();
    expect(requested.narrative).toContain("确认离开");
    expect(settlementRandomCalls).toBe(0);
    expect(session.dead).toBe(false);
    expect(activeSkill(session, "spot_hidden")).toBe(1);
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    expect(session.careerStore?.getEntries(session.activeCharacter!.name) ?? []).toEqual(entriesBeforeRequest);

    expect((await durableAct(session, "确定")).error).toBeUndefined();
    expect(activeSkill(session, "spot_hidden")).toBe(2);
    expect(session.skillGrowthMarks).toEqual([]);
    expect(session.dead).toBe(false);
    expect(session.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(settlementRandomCalls).toBe(2);
  } finally {
    restoreRandom?.();
    Math.random = realRandom;
    session?.close();
  }
});

it("stores a successful investigation mark at its CoC key and grows spot_hidden on module settlement", async () => {
  const realRandom = Math.random;
  let session: GameSession | undefined;
  let restoreRandom: (() => void) | undefined;
  try {
    session = sessionWithPersistedSkills("skill_growth_alias_settlement", { spot_hidden: 1 });
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    restoreRandom = fixedRandom([0]);

    await succeedInvestigationAndLeaveGrowthMark(session);
    restoreRandom();
    restoreRandom = undefined;
    let settlementRandomCalls = 0;
    Math.random = (() => {
      const values = [0.5, 0];
      let index = 0;
      return () => {
        settlementRandomCalls += 1;
        return values[index++] ?? 0;
      };
    })();
    const requested = await session.act("模组结算");

    expect(requested.error).toBeUndefined();
    expect(requested.narrative).toContain("确认离开");
    expect(settlementRandomCalls).toBe(0);
    expect(session.dead).toBe(false);
    expect(activeSkill(session, "spot_hidden")).toBe(1);
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    const settled = await durableAct(session, "确定");
    expect(settled.error).toBeUndefined();
    expect(activeSkill(session, "spot_hidden")).toBe(2);
    expect(Object.hasOwn(session.activeCharacter?.skillValues ?? {}, "investigation")).toBe(false);
    expect(session.skillGrowthMarks).toEqual([]);
    expect(session.dead).toBe(false);
    expect(session.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(settlementRandomCalls).toBe(2);
  } finally {
    restoreRandom?.();
    Math.random = realRandom;
    session?.close();
  }
});

it("does not leave an ordinary growth mark after a failed CoC skill check", async () => {
  let session: GameSession | undefined;
  let restoreRandom: (() => void) | undefined;
  try {
    session = sessionWithPersistedSkills("skill_growth_failure_no_mark", { spot_hidden: 1 });
    restoreRandom = fixedRandom([0.5]);

    const checked = await session.act("调查");

    expect(checked.error).toBeUndefined();
    expect(session.exportOrdinarySessionSnapshot().state.lastRolls.at(-1)).toMatchObject({ skill: "investigation", roll: 51, target: 1, success: false });
    expect(session.skillGrowthMarks).toEqual([]);
  } finally {
    restoreRandom?.();
    session?.close();
  }
});

it("marks a real successful scene-clue skill check, but not a forced failback grant", async () => {
  let session: GameSession | undefined;
  let restoreRandom: (() => void) | undefined;
  try {
    session = sessionWithPersistedSkills("skill_growth_scene_clue", { spot_hidden: 1 });
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    activateRegisteredGameSessionSceneForTest(session, "加比的拖车房");
    restoreRandom = fixedRandom([0]);

    expect((await session.act("检查餐厅")).error).toBeUndefined();
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);

    restoreRandom();
    restoreRandom = undefined;
    const marksBeforeFailback = session.skillGrowthMarks;
    const restored = freshSession(session.id);
    restoreSignedOrdinaryWorld(restored, FIXTURE_LLM, (world) => {
      for (let i = 0; i < 4; i++) world.incrementClueFail("clue_card");
    }, session);
    session.close();
    session = restored;
    expect((await session.act("检查餐厅")).error).toBeUndefined();
    expect(activeSkill(session, "spot_hidden")).toBe(1);
    expect(session.skillGrowthMarks).toEqual(marksBeforeFailback);
  } finally {
    restoreRandom?.();
    session?.close();
  }
});

it("marks a successful ordinary pushed retry, not the initial failure", async () => {
  let session: GameSession | undefined;
  let restoreRandom: (() => void) | undefined;
  try {
    session = sessionWithPersistedSkills("skill_growth_pushed_retry", { spot_hidden: 1 });
    restoreRandom = fixedRandom([0.5, 0]);

    expect((await session.act("调查")).error).toBeUndefined();
    expect(session.skillGrowthMarks).toEqual([]);
    expect((await session.act("推动")).error).toBeUndefined();
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
  } finally {
    restoreRandom?.();
    session?.close();
  }
});

it("keeps one mark for repeated successful uses through rest and clears it after a no-increase settlement check", async () => {
  const realRandom = Math.random;
  let session: GameSession | undefined;
  let restoreRandom: (() => void) | undefined;
  try {
    session = sessionWithPersistedSkills("skill_growth_success_dedup", { spot_hidden: 50 });
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    restoreRandom = fixedRandom([0, 0]);

    expect((await session.act("调查")).error).toBeUndefined();
    expect((await session.act("调查")).error).toBeUndefined();
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);

    restoreRandom();
    restoreRandom = undefined;
    let restRolls = 0;
    Math.random = () => {
      restRolls += 1;
      throw new Error("rest must not roll deduplicated growth marks");
    };
    expect((await session.act("休息")).error).toBeUndefined();
    expect(restRolls).toBe(0);
    expect(activeSkill(session, "spot_hidden")).toBe(50);
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    let settlementRandomCalls = 0;
    Math.random = () => {
      settlementRandomCalls += 1;
      return 0; // d100=1 <= 50: no increase.
    };
    const requested = await session.act("模组结算");
    expect(requested.error).toBeUndefined();
    expect(requested.narrative).toContain("确认离开");
    expect(settlementRandomCalls).toBe(0);
    expect(session.dead).toBe(false);
    expect(activeSkill(session, "spot_hidden")).toBe(50);
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);

    expect((await durableAct(session, "确定")).error).toBeUndefined();
    expect(activeSkill(session, "spot_hidden")).toBe(50);
    expect(session.skillGrowthMarks).toEqual([]);
    expect(session.dead).toBe(false);
    expect(session.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(settlementRandomCalls).toBe(1);
  } finally {
    restoreRandom?.();
    Math.random = realRandom;
    session?.close();
  }
});

it("never marks Credit Rating, Cthulhu Mythos, or attributes as ordinary growth skills", async () => {
  let session: GameSession | undefined;
  let restoreRandom: (() => void) | undefined;
  try {
    session = sessionWithPersistedSkills("skill_growth_ineligible_keys", {
      spot_hidden: 1, credit_rating: 100, cthulhu_mythos: 100,
    });
    restoreRandom = fixedRandom([0, 0, 0]);
    const check = (session as any).handleSkillCheck.bind(session) as (
      intent: { action: "skill_check"; skill: string }, input: string, msg: (line: string) => number,
    ) => boolean;

    expect(check({ action: "skill_check", skill: "credit_rating" }, "", () => 0)).toBe(true);
    expect(check({ action: "skill_check", skill: "cthulhu_mythos" }, "", () => 0)).toBe(true);
    expect(check({ action: "skill_check", skill: "strength" }, "", () => 0)).toBe(true);
    expect(session.exportOrdinarySessionSnapshot().state.lastRolls.slice(-3).every((roll: { success: boolean }) => roll.success)).toBe(true);
    expect(session.skillGrowthMarks).toEqual([]);
  } finally {
    restoreRandom?.();
    session?.close();
  }
});

it("round-trips a successful ordinary mark with its p1 owner", async () => {
  let source: GameSession | undefined;
  let restored: GameSession | undefined;
  let restoreRandom: (() => void) | undefined;
  try {
    source = sessionWithPersistedSkills("skill_growth_success_snapshot_owner", { spot_hidden: 1 });
    restoreRandom = fixedRandom([0]);
    expect((await source.act("调查")).error).toBeUndefined();
    const snapshot = JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot()));
    expect(snapshot.state.skillGrowthMarksByPC).toEqual([{ pcId: "p1", skills: ["spot_hidden"] }]);

    restoreRandom();
    restoreRandom = undefined;
    restored = freshSession("skill_growth_success_snapshot_owner");
    restored.restoreOrdinarySessionSnapshot(snapshot);
    expect(restored.skillGrowthMarks).toEqual(["spot_hidden"]);
  } finally {
    restoreRandom?.();
    source?.close();
    restored?.close();
  }
});

it("maps a legacy investigation growth mark restored from an ordinary snapshot to spot_hidden", async () => {
  const realRandom = Math.random;
  let source: GameSession | undefined;
  let restored: GameSession | undefined;
  let restoreRandom: (() => void) | undefined;
  try {
    source = sessionWithPersistedSkills("skill_growth_alias_snapshot", { spot_hidden: 1 });
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    // Earlier snapshots persisted the raw intent key.  Exporting and restoring it
    // exercises that accepted wire form without relaxing snapshot validation.
    const snapshot = JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot()));
    snapshot.state.skillGrowthMarksByPC = [{ pcId: "p1", skills: ["investigation"] }];
    const { snapshotHash: _discarded, ...unsigned } = snapshot;

    restored = freshSession("skill_growth_alias_snapshot");
    restored.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
    if (!restored.activeCharacter?.skillValues) throw new Error("restored fixture must retain its CoC character");
    expect(restored.skillGrowthMarks).toEqual(["investigation"]);

    let restRolls = 0;
    Math.random = () => {
      restRolls += 1;
      throw new Error("rest must not roll restored legacy growth marks");
    };
    const rested = await restored.act("休息");

    expect(rested.error).toBeUndefined();
    expect(restRolls).toBe(0);
    expect(restored.skillGrowthMarks).toEqual(["investigation"]);
    expect(activeSkill(restored, "spot_hidden")).toBe(1);
    let settlementRandomCalls = 0;
    Math.random = (() => {
      const values = [0.5, 0];
      let index = 0;
      return () => {
        settlementRandomCalls += 1;
        return values[index++] ?? 0;
      };
    })();
    const requested = await restored.act("模组结算");
    expect(requested.error).toBeUndefined();
    expect(requested.narrative).toContain("确认离开");
    expect(settlementRandomCalls).toBe(0);
    expect(restored.dead).toBe(false);
    expect(activeSkill(restored, "spot_hidden")).toBe(1);
    expect(restored.skillGrowthMarks).toEqual(["investigation"]);

    expect((await durableAct(restored, "确定")).error).toBeUndefined();
    expect(activeSkill(restored, "spot_hidden")).toBe(2);
    expect(restored.skillGrowthMarks).toEqual([]);
    expect(Object.hasOwn(restored.activeCharacter?.skillValues ?? {}, "investigation")).toBe(false);
    expect(restored.dead).toBe(false);
    expect(restored.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(settlementRandomCalls).toBe(2);
  } finally {
    restoreRandom?.();
    Math.random = realRandom;
    source?.close();
    restored?.close();
  }
});
