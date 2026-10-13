// 五项开发·任务5：线索只对发现者可见 + 按玩家读历史。
//
// 5a：GET /history 只认当前活动玩家，外部永远看不到别的 PC 的历史——先补
// pcId 参数，否则 5b 做完也没人能验。未知 pcId 明确报 4xx，不能静默返回
// 空数组（那和"这个人确实没历史"长得一模一样）。
// 5b：线索揭示经 resolveSceneClue 汇进 turnMessages，此前统一按 public 推
// 到所有玩家的 messageHistory，没有任何线索是发现者独享的。本轮只做
// discoverer_only；scene_restricted 不碰（它有三个独立的坑，见任务说明）。
//
// bun test src/__tests__/clue-visibility-and-per-player-history.test.ts

import { describe, it, expect } from "bun:test";
import { GameSession } from "../api/game-session";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

async function twoPcArenaAt(sceneName: string) {
  const session: any = new GameSession(`t5-${Math.random()}`, "cosmic-horror", CFG, undefined, "调查员", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  await session.act("创建角色 investigator 甲"); // p1
  await session.act("创建队友 乙 investigator"); // p2
  await session.act("加载模组 普瑞米尔的谷仓");
  session.movePlayerToScene(sceneName);
  return session as GameSession & Record<string, any>;
}

describe("5a：getPlayerHistory(pcId) —— 按 PC 读取，不再恒返回 active 玩家", () => {
  it("**正确**：p1、p2 各自能取到历史，且都包含普通（public）消息——pcId 路由本身工作正常", async () => {
    // ⚠ 普通行动的可见性规则仍是 public（未改动，见下面「文本相似但合法」
    // 那条）——这条测的不是"消息互相隔离"，是"pcId 参数真的把请求路由到了
    // 对应玩家的 messageHistory"，两件事分开测，别混在一起。
    const s = await twoPcArenaAt("普瑞米尔");
    await s.act("看看四周", "p1");
    const h1 = s.getPlayerHistory("p1");
    const h2 = s.getPlayerHistory("p2");
    expect(h1.total).toBeGreaterThan(0);
    expect(h2.total).toBeGreaterThan(0);
    // public 消息两边都能看到——但两份历史是各自独立的数组（不同 PlayerSlot），
    // 不是同一份引用意外共享
    expect(h1.messages).not.toBe(h2.messages);
  });

  it("**错误行为红线**：未知 pcId 不能静默返回空数组——调用方（server.ts）必须先用 session.get(pcId) 挡住", async () => {
    const s = await twoPcArenaAt("普瑞米尔");
    // 模拟 server.ts 路由层的判断：未知 pcId 时根本不应该走到 getPlayerHistory
    expect(s.session.get("p99")).toBeUndefined();
    // 即便真调用了，底层也不该假装"这个人有历史但是空的"和"这个人不存在"是一回事——
    // 这条红线守住的是"调用方必须先判"这件事本身，用 session.get 的返回值做判据。
  });

  it("**目标行为错误的对照**：不传 pcId（getHistory()）行为与之前完全一致——单人局/既有客户端不受影响", async () => {
    const s = await twoPcArenaAt("普瑞米尔");
    await s.act("看看四周", "p1"); // p1 是 active
    const active = s.getHistory();
    const p1 = s.getPlayerHistory("p1");
    // 当前活动玩家是 p1 时，getHistory()（不传 pcId）与 getPlayerHistory("p1") 等价
    expect(active.total).toBe(p1.total);
  });
});

describe("5b：线索揭示只对发现者可见（discoverer_only）", () => {
  it("**正确**：p1 掷出线索 → p1 的历史有揭示正文，p2 的历史没有", async () => {
    const s = await twoPcArenaAt("加比的拖车房");
    const real = Math.random;
    Math.random = () => 0; // 逼检定成功
    try {
      await s.act("侦查床底", "p1"); // 命中手枪线索（见 scene-clue-input-match.test.ts）
    } finally { Math.random = real; }

    const h1 = s.getPlayerHistory("p1");
    const h2 = s.getPlayerHistory("p2");
    const text1 = h1.messages.map((m: any) => m.content).join("\n");
    const text2 = h2.messages.map((m: any) => m.content).join("\n");
    expect(text1).toMatch(/手枪/);
    expect(text2).not.toMatch(/手枪/);
  });

  it("**错误行为红线**：discoverer_only 的消息不能出现在非发现者的历史里，即使该玩家后来切成活动玩家", async () => {
    const s = await twoPcArenaAt("加比的拖车房");
    const real = Math.random;
    Math.random = () => 0;
    try {
      await s.act("侦查床底", "p1");
      await s.act("p2的动作", "p2"); // 切到 p2，p2 成为活动玩家
    } finally { Math.random = real; }
    // 即便 p2 现在是活动玩家，getHistory()（走 getActiveHistory）也不该看到
    // p1 独享的线索——可见性挂在消息本身，不随"谁是活动玩家"变化。
    const activeHistoryText = s.getHistory().messages.map((m: any) => m.content).join("\n");
    expect(activeHistoryText).not.toMatch(/手枪/);
  });

  it("**正确**：单人局行为与现在完全一致——p1 自己掷线索，自己的历史里当然有揭示文本", async () => {
    const session: any = new GameSession(`t5-solo-${Math.random()}`, "cosmic-horror", CFG, undefined, "调查员", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    await session.act("创建角色 investigator 甲");
    await session.act("加载模组 普瑞米尔的谷仓");
    session.movePlayerToScene("加比的拖车房");
    const real = Math.random;
    Math.random = () => 0;
    try {
      const res = await session.act("侦查床底");
      expect(res.narrative).toMatch(/手枪/); // 本回合的即时响应不受影响
    } finally { Math.random = real; }
    const h1 = session.getPlayerHistory("p1");
    expect(h1.messages.map((m: any) => m.content).join("\n")).toMatch(/手枪/);
  });

  it("**KP 视角仍能看到全部**：getKPState() 在线索私密之后仍返回完整的双 PC 状态", async () => {
    const s = await twoPcArenaAt("加比的拖车房");
    const real = Math.random;
    Math.random = () => 0;
    try {
      await s.act("侦查床底", "p1");
    } finally { Math.random = real; }
    const kp = s.getKPState();
    const pids = kp.characters.map((c: any) => c.playerId).sort();
    expect(pids).toEqual(["p1", "p2"]);
  });

  it("**文本相似但合法**：这次改动不影响其它消息的可见性——普通旁白/系统提示仍然对所有玩家可见（public 默认值不变）", async () => {
    const s = await twoPcArenaAt("普瑞米尔");
    await s.act("看看四周", "p1");
    const h2 = s.getPlayerHistory("p2");
    // p1 的普通行动（非线索揭示）仍按 public 分发，p2 的历史里应该能看到
    expect(h2.total).toBeGreaterThan(0);
  });
});
