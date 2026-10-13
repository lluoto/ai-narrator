// 「接管 / 放手」这两条命令真的改了控制权没有。
//
// 接之前的状况：
//   · `控制/接管/手操 X` 只推一句「你接管了 X 的控制权」，**一个字段都不改**
//   · `自动/放手/AI X` 更彻底 —— 正则匹配出来了却连 if 分支都没有
//     （`autoMatch` 是 tsc 的 noUnusedLocals 报出来的）。
//     玩家能接管同伴，交不回去。
//
// 而控制系统本身是完整实现且有测试的：`setControl` / `getControl` /
// `transferControl` / `getPlayerControlled`，`companion-manager.ts` 里还在按
// `control !== "auto"` 决定同伴这一轮自不自己动。
// 实测这几个方法**只有测试在调用** —— 跟流血、跟追逐是同一个故事：
// 实现了、测了、没接上。

import { describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { ORDINARY_COMPANION_FIXTURE, restoreSignedOrdinaryCompanion } from "./helpers/ordinary-companion-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};

type Mgr = GameSession["companionManager"];

function session(): { s: GameSession; mgr: Mgr; id: string } {
  const s = new GameSession(`ctl-${Math.random()}`, "cosmic-horror", CFG);
  const id = "ally1";
  // `type` 是必填的 —— recruit 会拿它建世界实体，缺了 SQLite 直接 NOT NULL 报错
  restoreSignedOrdinaryCompanion(s, CFG, {
    ...ORDINARY_COMPANION_FIXTURE,
    id,
    name: "老李",
  });
  return { s, mgr: s.companionManager, id };
}

describe("接管与放手真的改控制权", () => {
  test("**正确**：招募之后默认是自主行动", () => {
    const { mgr, id } = session();
    expect(mgr.getControl(id)).toBe("auto");
  });

  test("**错误行为的红线**：「接管 老李」必须真的改掉 control，不能只印一句话", async () => {
    const { s, mgr, id } = session();
    await s.act("接管 老李");
    expect(mgr.getControl(id)).not.toBe("auto");
    expect(String(mgr.getControl(id)).startsWith("player:")).toBe(true);
  });

  test("**错误行为的红线**：「放手 老李」必须能交回去 —— 这条命令原先根本没有分支", async () => {
    const { s, mgr, id } = session();
    await s.act("接管 老李");
    expect(mgr.getControl(id)).not.toBe("auto");
    await s.act("放手 老李");
    expect(mgr.getControl(id)).toBe("auto");
  });

  test("**正确**：三个同义词都认（自动 / 放手 / AI）", async () => {
    for (const word of ["自动", "放手", "AI"]) {
      const { s, mgr, id } = session();
      await s.act("手操 老李");
      expect(mgr.getControl(id)).not.toBe("auto");
      await s.act(`${word} 老李`);
      expect(mgr.getControl(id)).toBe("auto");
    }
  });

  test("**干扰输入**：名字不在队里要说出来，不能照样回「你接管了」", async () => {
    // 原先无论这人在不在队里都回同一句 —— 打错名字与真的接管，
    // 在播报上完全一样。
    const { s, mgr, id } = session();
    const res = await s.act("接管 不存在的人");
    expect(res.events.some((e) => e.content.includes("没有"))).toBe(true);
    expect(mgr.getControl(id)).toBe("auto"); // 别人的控制权没被殃及
  });
});
