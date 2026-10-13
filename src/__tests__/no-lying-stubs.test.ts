// 桩可以「没做」，但不能**报告一件没发生的事**。
//
// 起因是量了一遍 27 个 handler：哪些认了命令、回了话，却什么状态都没改。
// 挑出三个，都在对玩家撒谎：
//
//   handleSell   —— **从不查背包**，一律回「你的背包中没有 X」，哪怕你拿着
//   handleReload —— 说「弹药已补满」，而这一侧**根本没有弹药状态**
//   handleBuy    —— 「当前商店可能没有此物品」，而商店压根不存在
//
// 区别很实在：「没做商店」玩家能理解；「骗他说他没有这东西」
// 会让他以为自己记错了，或者以为背包丢了东西。

import { describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 256, temperature: 0.7,
};

async function fresh() {
  const s = new GameSession(`stub-${Math.random()}`, "cosmic-horror", CFG);
  await s.act("创建角色 investigator 甲");
  return s;
}

function textOf(res: { events: { content: unknown }[] }): string {
  return res.events.map((e) => String(e.content)).join("\n");
}

describe("出售", () => {
  test("**错误行为的红线**：背包里有的东西，不能说没有", async () => {
    const s = await fresh();
    expect(s.setPlayerInventory(s.activePlayerId, ["手电筒", "绳索"])).toBe(true);

    const out = textOf(await s.act("出售 手电筒"));
    expect(out).not.toContain("背包中没有");
    expect(out).toContain("手电筒");
  });

  test("**正确**：背包里确实没有时，照实说，并把背包列出来", async () => {
    const s = await fresh();
    const out = textOf(await s.act("出售 火箭筒"));
    expect(out).toContain("没有");
  });

  test("**干扰输入**：不给物品名时要问，而不是当成「没有」", async () => {
    const s = await fresh();
    const out = textOf(await s.act("出售"));
    expect(out).toContain("什么");
  });
});

describe("装填", () => {
  test("**错误行为的红线**：这一侧没有弹药状态，就不能说「弹药已补满」", async () => {
    // 弹药系统只在 CLI（src/index.ts 的 cocAmmo）里。走服务器这条路
    // 一格弹药都不记，开枪不消耗。报一个假数字比不报更糟 ——
    // 玩家会据此决定要不要省子弹。
    const s = await fresh();
    const out = textOf(await s.act("装填 手枪"));
    expect(out).not.toContain("弹药已补满");
  });
});

describe("购买", () => {
  test("**错误行为的红线**：不能把「没做商店」说成「这家店碰巧没货」", async () => {
    // 原文是「当前商店可能没有此物品」—— 玩家会去别处找一家，而哪儿都没有。
    const s = await fresh();
    const out = textOf(await s.act("购买 手电筒"));
    expect(out).not.toContain("当前商店可能没有");
  });
});
