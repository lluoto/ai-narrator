// 政经引擎的时钟接线：PoliticoEconomyEngine.advanceRound() 本身早就是对的
// 形状，缺的只是没人调它——生产代码零调用方。见 game-session.ts 的
// tickEconomy() 头注释：为什么挂在 this.round、为什么节流、为什么否掉
// 场景切换与显式 KP 动作两个候选。
//
// 三侧都要测：节流生效（不到点不推进）、到点推进、结算过的事件真的落进
// 世界的事件日志（不是只在经济引擎自己的内存账本里）。

import { describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

type S = {
  round: number;
  politicoEconomy: { round: number };
  world: { getRecentEvents: (n?: number) => Array<{ description: string; event_type: string }> };
  act: (input: string) => Promise<{ events: Array<{ content: string }> }>;
};

async function arena() {
  const s = new GameSession(`eco-clock-${Math.random()}`, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME) as unknown as S;
  await s.act("创建角色 investigator 甲"); // round=1
  return s;
}

describe("经济引擎时钟接线", () => {
  test("**错误行为的红线**：不到节流间隔（10 回合）经济时钟不推进", async () => {
    const s = await arena();
    expect(s.politicoEconomy.round).toBe(0);
    // 已经过了 1 回合（创建角色），再跑 8 回合，凑够 9 回合——还不到 10
    for (let i = 0; i < 8; i++) await s.act("环顾四周");
    expect(s.round).toBe(9);
    expect(s.politicoEconomy.round).toBe(0);
  }, 20_000);

  test("**正确**：第 10 个玩家回合，经济时钟推进一次", async () => {
    const s = await arena();
    for (let i = 0; i < 9; i++) await s.act("环顾四周"); // 凑到 round=10
    expect(s.round).toBe(10);
    expect(s.politicoEconomy.round).toBe(1);
  }, 20_000);

  test("**正确**：第 20 回合再推进一次，不是只触发一次就失效", async () => {
    const s = await arena();
    for (let i = 0; i < 19; i++) await s.act("环顾四周"); // round=20
    expect(s.round).toBe(20);
    expect(s.politicoEconomy.round).toBe(2);
  }, 20_000);

  test("**正确**：结算过的经济事件写进了世界的事件日志（真相源），不是只留在经济引擎自己的内存账本里", async () => {
    const s = await arena();
    for (let i = 0; i < 39; i++) await s.act("环顾四周"); // 跑够 4 个节流窗口，凑事件
    const recent = s.world.getRecentEvents(200);
    const economyLines = recent.filter((e) => e.description.startsWith("[经济]"));
    // 政经引擎的事件是概率性的（不是每个经济回合都出事），跑 4 轮足够大概率
    // 至少有一条——如果这条断言真的从没通过过，说明写回 SQLite 那一步没接上。
    expect(economyLines.length).toBeGreaterThan(0);
  }, 30_000);

  test("**干扰**：非经济类的普通回合不会被误记成经济事件", async () => {
    const s = await arena();
    for (let i = 0; i < 8; i++) await s.act("环顾四周"); // 只到 round=9，不触发经济时钟
    const recent = s.world.getRecentEvents(200);
    const economyLines = recent.filter((e) => e.description.startsWith("[经济]"));
    expect(economyLines.length).toBe(0);
  }, 20_000);
});
