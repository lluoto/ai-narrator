// 开发·线索闸门 任务4验收——failback 阶梯（N=2），自由跑团路径。
//
// 背景：剧本杀路径（play/clue-check.ts）早有这套阶梯（连续失败达阈值→
// passive/failback 兜底），自由跑团一条都没有——InvestigationEngine 只有
// DifficultyProfile，是"两个运行时各持一半"的第三次（前两次：线索发现、
// 场景访问，见 docs/todo.json todo-03）。
//
// 已裁决 N=2：core 线索连续失败 2 次 → 灵感检定 → 再失败 → 无副作用重试
// → 再失败 → 直接给。"无副作用"精确定义：不烧运气（luck 不减，luckSpend
// =0）、不算孤注一掷（CoCEngine.skillCheck 的 pushed 传 false）、但时间
// 照常过（act() 本来就会推进的那 1 tick，不做例外）。
//
// 失败计数进真相源（WorldStateManager.incrementClueFail），不在 GameSession
// 再开一个内存 Map——线索发现与场景访问上一轮才迁进去，按同一个方向。
//
// bun test src/__tests__/clue-failback-ladder.test.ts

import { describe, it, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { InvestigationEngine } from "../investigation/investigation-engine";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 128, temperature: 0,
};

function makeSession(id: string): GameSession & Record<string, any> {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession(id, "cosmic-horror", CFG, "investigator", "甲") as any;
}

async function arenaAtTrailer(id: string) {
  const s = makeSession(id);
  await s.act("加载模组 普瑞米尔的谷仓");
  (s as any).movePlayerToScene("加比的拖车房");
  return s;
}

describe("clue_card 是 core 线索——阶梯只对 core 生效的前提", () => {
  it("isCoreClue(clue_card) 为 true", async () => {
    const s = await arenaAtTrailer(`ladder-core-check-${Math.random()}`);
    expect(s.investigation.isCoreClue("clue_card")).toBe(true);
  });
});

describe("连续失败 2 次进入阶梯，逐档可验", () => {
  it("failCount 0→1→2：正常检定，技能是 spot_hidden，未进阶梯", async () => {
    const s = await arenaAtTrailer(`ladder-normal-${Math.random()}`);
    const real = Math.random;
    Math.random = () => 0.99;
    try {
      await s.act("检查餐厅", "p1");
      expect(s.world.getClueFailCount("clue_card")).toBe(1);
      const res2 = await s.act("检查餐厅", "p1");
      expect(s.world.getClueFailCount("clue_card")).toBe(2);
      expect(res2.narrative).toContain("spot_hidden检定");
    } finally { Math.random = real; }
  });

  it("failCount=2 时：第 3 次检定改用灵感（智力），不是 spot_hidden", async () => {
    const s = await arenaAtTrailer(`ladder-idea-${Math.random()}`);
    const real = Math.random;
    Math.random = () => 0.99;
    try {
      await s.act("检查餐厅", "p1");
      await s.act("检查餐厅", "p1");
      const res3 = await s.act("检查餐厅", "p1");
      expect(res3.narrative).toContain("灵感检定");
      expect(res3.narrative).not.toContain("spot_hidden检定");
      expect(s.world.getClueFailCount("clue_card")).toBe(3);
    } finally { Math.random = real; }
  });

  it("failCount=3 时：第 4 次检定是「无副作用重试」，技能回到 spot_hidden", async () => {
    const s = await arenaAtTrailer(`ladder-retry-${Math.random()}`);
    const real = Math.random;
    Math.random = () => 0.99;
    try {
      await s.act("检查餐厅", "p1");
      await s.act("检查餐厅", "p1");
      await s.act("检查餐厅", "p1");
      const res4 = await s.act("检查餐厅", "p1");
      expect(res4.narrative).toContain("spot_hidden检定");
      expect(res4.narrative).toContain("换个思路，再试一次");
      expect(s.world.getClueFailCount("clue_card")).toBe(4);
    } finally { Math.random = real; }
  });

  it("failCount>=4 时：第 5 次直接给，不再掷骰，failCount 清零", async () => {
    const s = await arenaAtTrailer(`ladder-grant-${Math.random()}`);
    const real = Math.random;
    Math.random = () => 0.99;
    try {
      for (let i = 0; i < 4; i++) await s.act("检查餐厅", "p1");
      const res5 = await s.act("检查餐厅", "p1");
      expect(res5.narrative).not.toContain("🎲"); // 没有骰子播报，因为没掷骰
      expect(res5.narrative).toContain("屡次尝试后");
      expect(res5.narrative).toContain("卡片"); // 真的给了线索内容
      expect(s.world.getClueFailCount("clue_card")).toBe(0);
      expect(s.investigation.isDiscoveredBy("clue_card", "p1")).toBe(true);
    } finally { Math.random = real; }
  });
});

describe("「无副作用」三条断言：不烧运气、不算孤注一掷、时间照常过", () => {
  it("整个阶梯走完，character.luck 一次都没变", async () => {
    const s = await arenaAtTrailer(`ladder-noluck-${Math.random()}`);
    const luckBefore = s.activeCharacter.luck;
    const real = Math.random;
    Math.random = () => 0.99;
    try {
      for (let i = 0; i < 5; i++) await s.act("检查餐厅", "p1");
    } finally { Math.random = real; }
    expect(s.activeCharacter.luck).toBe(luckBefore);
  });

  it("独立引擎的无推骰检定返回 pushed=false、luckSpent=0", () => {
    // GameSession 的 failback 顺序由上面的真实 act() 路径覆盖；这里保留
    // InvestigationEngine 自己的 CoC 结果契约，不借公共 Session 读视图执行机制。
    const engine = new InvestigationEngine();
    const r = engine.investigateCoC("ritual_site", { occult: 1 }, "p1");
    expect(r.pushed).toBe(false);
    expect(r.luckSpent).toBe(0);
  });

  it("每次尝试游戏时间照常推进（不因为进入阶梯就例外跳过 advanceTime）", async () => {
    const s = await arenaAtTrailer(`ladder-time-${Math.random()}`);
    const real = Math.random;
    Math.random = () => 0.99;
    try {
      const before = s.getState().gameTime;
      const roundBefore = s.round;
      await s.act("检查餐厅", "p1"); // failCount 0→1，正常检定
      await s.act("检查餐厅", "p1"); // failCount 1→2
      await s.act("检查餐厅", "p1"); // failCount 2→3，灵感档
      await s.act("检查餐厅", "p1"); // failCount 3→4，重试档
      const afterFive = (await s.act("检查餐厅", "p1")).state.gameTime; // failCount>=4，直接给
      // 5 次 act() 都推进了时间（每回合固定 1 tick），不因为某一档是
      // "免费"重试或"直接给"就跳过——用总回合数间接验证（round 每次 act 都 +1）。
      expect(s.round).toBe(roundBefore + 5);
      expect(afterFive).not.toEqual(before); // 时间确实往前走了，不是原地不动
    } finally { Math.random = real; }
  });
});

describe("回归：剧本杀路径（module-loop.test.ts 覆盖的场景）行为完全不变", () => {
  it("非 core 线索不受阶梯影响，失败次数不累加", async () => {
    const s = await arenaAtTrailer(`ladder-noncore-${Math.random()}`);
    // clue_pistol_in_bag 是 color（氛围向），不是 core
    expect(s.investigation.isCoreClue("clue_pistol_in_bag")).toBe(false);
    const real = Math.random;
    Math.random = () => 0.99;
    try {
      await s.act("检查床底", "p1");
      await s.act("检查床底", "p1");
      await s.act("检查床底", "p1");
    } finally { Math.random = real; }
    expect(s.world.getClueFailCount("clue_pistol_in_bag")).toBe(0);
  });
});
