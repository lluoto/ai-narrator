// 「要不要掷重伤体质检定」只能有一条判据。
//
// 原先四个调用点两种写法：
//   traps 主伤害路径、combat 敌人命中 —— 只看伤势，HP 归零还会补掷一次
//   traps 挣脱大失败、traps 持续伤害   —— 还看 `pc.hp > 0`
// 同一条规则在同一局里两种口径，`scripts/diag/diag-wounds.ts` 只好把
// 「重伤但当场昏迷」那些单列出来不下结论 —— 判据被实现的不一致逼哑了。
//
// 规则本身很清楚：那一掷决定的是「会不会昏过去」，人已经躺下就没什么可决定的。

import { describe, test, expect, afterEach } from "bun:test";
import { needsMajorWoundCheck, calcSeverity } from "../combat/wound-effects";
import { runSceneTraps } from "../play/traps";
import { runCtx, type RunContext } from "../play/narration";
import { reduceWounds } from "../diagnostics/wounds";
import type { PlayEvent } from "../play/events";
import type { Cast, Cursor } from "../play/run-state";
import type { CoCGeneratedCharacter } from "../character/coc-character";
import type { ModuleData, Scene } from "../module/types";
import type { WorldState } from "../world/state";
import { createGameTime } from "../rules/game-time";

const realRandom = Math.random;
afterEach(() => { Math.random = realRandom; });

describe("needsMajorWoundCheck — 纯判据", () => {
  test("**正确**：重伤且人还有意识 → 要掷", () => {
    expect(needsMajorWoundCheck("deep", 5)).toBe(true);
    expect(needsMajorWoundCheck("grievous", 1)).toBe(true);
  });

  test("**错误行为的红线**：人已经昏迷 → 不掷", () => {
    expect(needsMajorWoundCheck("deep", 0)).toBe(false);
    expect(needsMajorWoundCheck("grievous", 0)).toBe(false);
  });

  test("**干扰**：伤势不够重时，人再精神也不掷", () => {
    expect(needsMajorWoundCheck("flesh", 12)).toBe(false);
    expect(needsMajorWoundCheck("scratch", 12)).toBe(false);
  });

  test("与 calcSeverity 的边界对得上：恰好半血要掷", () => {
    // CoC 7e 的 Major Wound 是「等于或大于」最大 HP 的一半
    expect(needsMajorWoundCheck(calcSeverity(6, 12), 6)).toBe(true);
    expect(needsMajorWoundCheck(calcSeverity(5, 12), 7)).toBe(false);
  });
});

// ── 接真实现：陷阱三条路径口径一致 ────────────────────────────

function pc(hp: number, maxHp = 12): CoCGeneratedCharacter {
  return {
    hp, maxHp,
    attributes: { constitution: 50, strength: 50, dexterity: 50, size: 60 },
    skillValues: { first_aid: 40, chemistry: 40, medicine: 40 },
  } as unknown as CoCGeneratedCharacter;
}

function cast(hp1: number, hp2: number): Cast {
  return {
    p0: { shortName: "甲" }, p1: { shortName: "乙" },
    c1: pc(hp1), c2: pc(hp2), san1: {} as never, san2: {} as never,
  };
}

const cursor = (): Cursor => ({
  rounds: 1, gameTime: createGameTime(), stepCounter: 1, triggeredTraps: new Set(),
  visitCount: new Map(), done: false, arrivedByPlayerChoice: false,
});

const SCENE = { id: "s1", name: "陷阱区" } as unknown as Scene;
const WORLD = {} as unknown as WorldState;

const moduleWith = (trap: Record<string, unknown>): ModuleData => ({
  items: [{ id: "t1", name: "捕兽夹", sceneId: "s1", description: "", type: "trap", trap }],
} as unknown as ModuleData);

async function runTraps(m: ModuleData, c: Cast): Promise<PlayEvent[]> {
  const events: PlayEvent[] = [];
  const ctx: RunContext = { lines: [], origins: [], wounds: new Map(), onEvent: (e) => events.push(e) };
  await runCtx.run(ctx, () => runSceneTraps(c, WORLD, cursor(), m, SCENE));
  return events;
}

const conChecks = (evts: PlayEvent[]) =>
  evts.filter((e) => e.type === "check" && e.ignoreWound);

describe("陷阱 — 重伤体质检定的口径", () => {
  test("**正确**：重伤但人还站着 → 掷一次", async () => {
    // 1d6 出 6，12 → 6，恰好半血 = deep，人还有 6 点
    Math.random = () => 0.999;
    const events = await runTraps(moduleWith({ damage: "1d6" }), cast(12, 12));
    const d = events.find((e) => e.type === "damage")!;
    expect(d.type === "damage" && d.severity).toBe("deep");
    expect(d.type === "damage" && d.to).toBe(6);
    expect(conChecks(events).length).toBe(1);
  });

  test("**错误行为的红线**：重伤且当场归零 → 一次都不掷", async () => {
    Math.random = () => 0.999;
    const events = await runTraps(moduleWith({ damage: "1d6" }), cast(12, 6));
    const d = events.find((e) => e.type === "damage")!;
    expect(d.type === "damage" && d.to).toBe(0);
    expect(conChecks(events).length).toBe(0);
    expect(reduceWounds(events).breaches).toEqual([]);
  });

  test("**干扰**：伤势不够重时本来就不掷", async () => {
    Math.random = () => 0; // 1d6 出 1
    const events = await runTraps(moduleWith({ damage: "1d6" }), cast(12, 12));
    expect(conChecks(events).length).toBe(0);
  });

  test("持续伤害那条路径同一口径（归零就不掷）", async () => {
    Math.random = () => 0.999;
    const events = await runTraps(
      moduleWith({ damage: "1d3", ongoing: { damage: "1d6", until: "冲洗干净" } }),
      cast(12, 4),
    );
    const dmgs = events.filter((e) => e.type === "damage");
    expect(dmgs.some((e) => e.type === "damage" && e.to === 0)).toBe(true);
    // 归零之后的那一跳伤害不再补掷体质
    expect(reduceWounds(events).breaches.filter((b) => b.kind === "con-while-down")).toEqual([]);
  });
});
