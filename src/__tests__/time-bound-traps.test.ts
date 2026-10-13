// 时间条件必须由游戏时钟驱动，而不是把“夜晚”留在陷阱说明里。
//
// 这组测试走真实 runSceneTraps → check() 链，并读结构化 check 事件：
// 不能用播报文本猜惩罚骰，也不靠只测一个纯 helper 伪装成运行时接线。

import { afterEach, describe, expect, test } from "bun:test";
import type { CoCGeneratedCharacter } from "../character/coc-character";
import type { ModuleData, Scene } from "../module/types";
import { BARN_OF_PREMIER } from "../module/barn-of-premier";
import { runCtx, type RunContext } from "../play/narration";
import type { PlayEvent } from "../play/events";
import type { Cast, Cursor } from "../play/run-state";
import { runSceneTraps } from "../play/traps";
import type { TimePeriod } from "../rules/game-time";
import type { WorldState } from "../world/state";

const realRandom = Math.random;
afterEach(() => { Math.random = realRandom; });

const SCENE = { id: "trap-scene", name: "陷阱区" } as unknown as Scene;
// 这些 fixture 没有 detectedByClue，运行时不会读取 WorldState。
const WORLD = {} as unknown as WorldState;

function investigator(): CoCGeneratedCharacter {
  return {
    hp: 12,
    maxHp: 12,
    attributes: { constitution: 50, strength: 50, dexterity: 50, size: 60 },
    skillValues: { spot_hidden: 50 },
  } as unknown as CoCGeneratedCharacter;
}

function cast(): Cast {
  return {
    p0: { shortName: "甲" },
    p1: { shortName: "乙" },
    c1: investigator(),
    c2: investigator(),
    san1: {} as never,
    san2: {} as never,
  };
}

function cursor(period: TimePeriod): Cursor {
  return {
    rounds: 1,
    stepCounter: 1,
    triggeredTraps: new Set(),
    visitCount: new Map(),
    done: false,
    arrivedByPlayerChoice: false,
    gameTime: { day: 1, period, ticks: 0 },
  };
}

function moduleWith(detect: Record<string, unknown>): ModuleData {
  return {
    items: [{
      id: "time-trap",
      name: "测试陷阱",
      sceneId: SCENE.id,
      description: "",
      type: "trap",
      trap: { detect },
    }],
  } as unknown as ModuleData;
}

async function detectionAt(period: TimePeriod, detect: Record<string, unknown>) {
  // 固定为常规成功：检定结论不重要，结构化事件里的环境惩罚才是判据。
  Math.random = () => 0;
  const events: PlayEvent[] = [];
  const ctx: RunContext = {
    lines: [],
    origins: [],
    wounds: new Map(),
    onEvent: (event) => events.push(event),
  };
  await runCtx.run(ctx, () => runSceneTraps(cast(), WORLD, cursor(period), moduleWith(detect), SCENE));
  const event = events.find((item): item is Extract<PlayEvent, { type: "check" }> =>
    item.type === "check" && item.skill.includes("发现测试陷阱"),
  );
  expect(event).toBeDefined();
  return event!;
}

describe("时间条件的陷阱发现惩罚", () => {
  test("谷仓外围的两条“夜晚”规则迁入结构化 nightPenaltyDice", () => {
    const detects = ["trap_bear", "trap_shotgun"].map((id) =>
      BARN_OF_PREMIER.items.find((item) => item.id === id)?.trap?.detect,
    );

    expect(detects).toHaveLength(2);
    for (const detect of detects) {
      expect(detect?.penaltyDice).toBeUndefined();
      expect(detect?.nightPenaltyDice).toBe(1);
    }
  });

  test("夜间额外惩罚在昼夜边界不同：afternoon=0，dusk=1", async () => {
    const detect = { skill: "侦查", difficulty: "regular", nightPenaltyDice: 1 };

    const day = await detectionAt("afternoon", detect);
    const night = await detectionAt("dusk", detect);

    expect(day.envPenalty).toBe(0);
    expect(day.totalPenalty).toBe(0);
    expect(night.envPenalty).toBe(1);
    expect(night.totalPenalty).toBe(1);
  });

  test("共享夜间边界完整覆盖 dusk/evening/night/late_night", async () => {
    const detect = { skill: "侦查", difficulty: "regular", nightPenaltyDice: 1 };

    for (const period of ["dusk", "evening", "night", "late_night"] as const) {
      expect((await detectionAt(period, detect)).envPenalty).toBe(1);
    }
    for (const period of ["dawn", "morning", "noon", "afternoon"] as const) {
      expect((await detectionAt(period, detect)).envPenalty).toBe(0);
    }
  });

  test("无条件 penaltyDice 在昼夜都生效", async () => {
    const detect = { skill: "侦查", difficulty: "regular", penaltyDice: 1 };

    expect((await detectionAt("afternoon", detect)).envPenalty).toBe(1);
    expect((await detectionAt("late_night", detect)).envPenalty).toBe(1);
  });

  test("没有条件字段时保持旧的零惩罚语义", async () => {
    const detect = { skill: "侦查", difficulty: "regular" };

    expect((await detectionAt("morning", detect)).envPenalty).toBe(0);
    expect((await detectionAt("night", detect)).envPenalty).toBe(0);
  });

  test("合并后的环境惩罚与 CoC 上限一致，不会超过两个", async () => {
    const detect = { skill: "侦查", difficulty: "regular", penaltyDice: 2, nightPenaltyDice: 1 };

    const day = await detectionAt("afternoon", detect);
    const night = await detectionAt("evening", detect);

    expect(day.envPenalty).toBe(2);
    expect(day.totalPenalty).toBe(2);
    expect(night.envPenalty).toBe(2);
    expect(night.totalPenalty).toBe(2);
  });
});
