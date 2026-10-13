// 昏迷的人不再自己掷骰 —— CoC 7e：HP 归零即失去意识。
//
// 这四条是 `scripts/diag/diag-downed.ts` 改用结构化事件之后**报出来**的真违规
// （12 局 4 次）：
//     ➜ 欧内斯特 【力量（挣脱捕兽夹）】   ← 躺着的人在掰铁齿
//     ➜ 托马斯   【力量（挣脱捕兽夹）】
//     ➜ 亨利     【化学（判断急救方式）】 ← 施救的同伴自己也躺着
//     ➜ 亨利     【急救】
// 旧判据报「违规 0 次」：前两条的昏迷走的是「重伤体质检定失败」，
// 那条路径**没有 `HP n → 0` 的播报**，只认那一行的正则从头到尾看不见它们。
//
// 三种输入都要有：昏迷 → 不掷（正例）、未昏迷 → 照掷（反例，防「一刀切跳过」）、
// 同伴倒下 vs 同伴健在（干扰）。

import { describe, test, expect, afterEach } from "bun:test";
import { runSceneTraps } from "../play/traps";
import { runCtx, type RunContext } from "../play/narration";
import { reduceDowned } from "../diagnostics/downed";
import type { PlayEvent } from "../play/events";
import type { Cast, Cursor } from "../play/run-state";
import type { CoCGeneratedCharacter } from "../character/coc-character";
import type { ModuleData, Scene } from "../module/types";
import type { WorldState } from "../world/state";
import { createGameTime } from "../rules/game-time";

const realRandom = Math.random;
afterEach(() => { Math.random = realRandom; });

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
    c1: pc(hp1), c2: pc(hp2),
    san1: {} as never, san2: {} as never,
  };
}

function cursor(): Cursor {
  return {
    rounds: 1, gameTime: createGameTime(), stepCounter: 1, triggeredTraps: new Set(),
    visitCount: new Map(), done: false, arrivedByPlayerChoice: false,
  };
}

const SCENE = { id: "s1", name: "陷阱区" } as unknown as Scene;
// `runSceneTraps` 只在陷阱声明了 detectedByClue 时才碰 world，这里都不声明
const WORLD = {} as unknown as WorldState;

function moduleWith(trap: Record<string, unknown>): ModuleData {
  return {
    items: [{ id: "t1", name: "捕兽夹", sceneId: "s1", description: "", type: "trap", trap }],
  } as unknown as ModuleData;
}

async function runTraps(m: ModuleData, c: Cast): Promise<PlayEvent[]> {
  const events: PlayEvent[] = [];
  const ctx: RunContext = { lines: [], origins: [], wounds: new Map(), onEvent: (e) => events.push(e) };
  await runCtx.run(ctx, () => runSceneTraps(c, WORLD, cursor(), m, SCENE));
  return events;
}

const checksBy = (evts: PlayEvent[], who: string) =>
  evts.filter((e): e is Extract<PlayEvent, { type: "check" }> => e.type === "check" && e.actor === who);
const skills = (evts: PlayEvent[], who: string) => checksBy(evts, who).map((e) => e.skill);

// ── 挣脱检定 ─────────────────────────────────────────────────

const BEAR = { damage: "1d6", escape: { skill: "力量", difficulty: "hard", fumbleDamage: "1d3" } };

describe("挣脱检定 — 昏迷的人不挣扎", () => {
  test("**错误行为的红线**：重伤体质检定失败昏迷之后，不得再掷挣脱", async () => {
    // 全高骰：1d6 出 6（6/12 = 50% → deep），d100 出 100 → 体质检定失败 → 昏迷
    Math.random = () => 0.999;
    const c = cast(12, 12);
    const events = await runTraps(moduleWith(BEAR), c);

    expect(events.some((e) => e.type === "downed" && e.cause === "major-wound-con")).toBe(true);
    expect(skills(events, "乙").some((s) => s.includes("挣脱"))).toBe(false);
    // 判据侧也必须干净
    expect(reduceDowned(events).violations).toEqual([]);
  });

  test("**正确行为**：没昏迷时挣脱检定照掷（别把守卫做成一刀切跳过）", async () => {
    // 低骰：1d6 出 1（1/12 → scratch，不触发重伤检定），d100 出 1 → 后续都成功
    Math.random = () => 0;
    const c = cast(12, 12);
    const events = await runTraps(moduleWith(BEAR), c);

    expect(events.some((e) => e.type === "downed")).toBe(false);
    expect(skills(events, "乙").some((s) => s.includes("挣脱"))).toBe(true);
  });

  test("**干扰**：HP 直接被打到 0 时同样不掷挣脱（另一条昏迷路径）", async () => {
    Math.random = () => 0.999;
    const c = cast(12, 3); // 乙只剩 3 点，1d6 出 6 直接归零
    const events = await runTraps(moduleWith(BEAR), c);

    expect(events.some((e) => e.type === "downed" && e.cause === "hp-zero")).toBe(true);
    expect(skills(events, "乙").some((s) => s.includes("挣脱"))).toBe(false);
    expect(reduceDowned(events).violations).toEqual([]);
  });
});

// ── 持续伤害的同伴急救 ────────────────────────────────────────

const ACID = {
  damage: "1d3",
  ongoing: { damage: "1D3", until: "冲洗干净" },
  firstAid: "用清水冲洗",
};

describe("同伴急救 — 施救者自己躺着就没人能救", () => {
  test("**错误行为的红线**：同伴 HP 为 0 时不得由他掷急救", async () => {
    Math.random = () => 0;      // 低骰：伤害小，检定都成功
    const c = cast(0, 12);      // 甲已经倒下；乙踩中陷阱，甲是施救者
    const events = await runTraps(moduleWith(ACID), c);

    expect(skills(events, "甲")).toEqual([]);
  });

  test("**正确行为**：同伴健在时急救链路照跑", async () => {
    Math.random = () => 0;
    const c = cast(12, 12);
    const events = await runTraps(moduleWith(ACID), c);

    const bySelf = skills(events, "甲");
    expect(bySelf.some((s) => s.includes("判断急救方式"))).toBe(true);
    expect(bySelf).toContain("急救");
  });

  test("**干扰**：受害者昏迷但同伴健在 → 仍该由同伴施救，不算违规", async () => {
    Math.random = () => 0;
    const c = cast(12, 1); // 乙只剩 1 点，第一跳伤害就归零
    const events = await runTraps(moduleWith(ACID), c);

    expect(events.some((e) => e.type === "downed" && e.who === "乙")).toBe(true);
    // 甲没倒，急救该发生；判据把它算作「同伴代做」，不是违规
    expect(reduceDowned(events).violations).toEqual([]);
  });
});
