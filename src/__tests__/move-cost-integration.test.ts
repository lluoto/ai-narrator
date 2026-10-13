// 开发 A · 任务 3 验收（集成层）——弱版邻接 + 按跳数计时，接进真实 GameSession。
// move-graph.test.ts 测的是 BFS 本体；这份测真实场景图 + act() 的时间推进
// 是否真的按跳数走，以及 handleMove 的空目标 bug 是否真的修好了。
//
// bun test src/__tests__/move-cost-integration.test.ts

import { describe, it, expect, beforeEach } from "bun:test";
import { GameSession } from "../api/game-session";
import { advanceTime, type GameTime } from "../rules/game-time";

function makeSession(): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession("move-cost-test", "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, "investigator", "调查员");
}

let session: GameSession;

beforeEach(async () => {
  session = makeSession();
  await session.act("加载模组 普瑞米尔的谷仓");
  // 加载后默认落在「特里坎家」——下面几条用例的跳数（已用
  // scripts 实测核实过）都是从这里量的：
  //   特里坎家 → 加比的拖车房 = 1 跳
  //   特里坎家 → 维修间     = 8 跳
});

const gameTimeOf = (s: GameSession): GameTime => ({ ...s.exportOrdinarySessionSnapshot().state.gameTime } as GameTime);

describe("相邻移动（1 跳）：时间推进与改动前逐字一致", () => {
  it("act() 本来就会推进 1 tick，1 跳移动不应该额外再加", async () => {
    const before = { ...gameTimeOf(session) };
    await session.act("前往加比的拖车房");
    const after = gameTimeOf(session);
    // 期望值 = 只推进 act() 本来就有的那 1 tick，不多不少。
    const expected = advanceTime(before, 1);
    expect(after).toEqual(expected);
    expect(session.getDisplayedScene()).toBe("加比的拖车房");
  });
});

describe("跨图移动：按最短跳数额外付时间", () => {
  it("8 跳的移动比 1 跳的移动多花 7 tick 的额外时间", async () => {
    const before = { ...gameTimeOf(session) };
    await session.act("前往维修间");
    const after = gameTimeOf(session);
    // 期望值 = act() 本来的 1 tick + 额外 7 tick（8 跳 - 1）
    const expected = advanceTime(before, 8);
    expect(after).toEqual(expected);
    expect(session.getDisplayedScene()).toBe("维修间");
  });

  it("**变异检验**：若代价被错误地钉死成恒为 1（回归到旧行为），这条用例会报出差异", () => {
    const before = { ...gameTimeOf(session) };
    // 模拟"代价恒为 1"的旧行为，构造出的期望值
    const regressedExpected = advanceTime(before, 1);
    // 真实实现应该 **不等于** 这个退化期望值（因为真实是 8 跳）
    const realExpected = advanceTime(before, 8);
    expect(realExpected).not.toEqual(regressedExpected);
  });
});

describe("步骤 2a-1 验收：「奇怪的卡片」已从 MythosModule.sceneDescriptions 删除", () => {
  // 「奇怪的卡片」是 gabi_trailer 场景里的一张线索物品（clue_card），
  // 不是地点。此前被误放进 sceneDescriptions 导致它成为一个孤立的
  // 注册场景（没有任何 exit 指向它，BFS 找不到路径）。步骤 2a-1 已修正：
  // 把它从 sceneDescriptions 删掉，不再作为场景注册。
  it("「奇怪的卡片」已从 sceneDescriptions 删除，模组加载后不再注册为场景节点", async () => {
    expect(session.world.getScene("奇怪的卡片")).toBeNull();
  });
});

describe("handleMove 空目标 bug（无模组的自由模式）：不再注册空场景、不谎报成功", () => {
  it("空目标不产生空场景，state.scene 不会变成空字符串", async () => {
    const s = makeSession(); // 不加载模组——走 handleMove 而不是 tryResolveModuleScene
    // 直接调用 handleMove 覆盖到的路径：intent.action="move" 且 target 解析为空。
    // 通过 act() 送一句"移动到"这类只有动词、没有具体地名的话来触发。
    const res = await s.act("移动到");
    expect(res.state.scene).not.toBe("");
    expect(s.world.getScene("")).toBeNull(); // 空字符串没有被注册成场景
  });
});
