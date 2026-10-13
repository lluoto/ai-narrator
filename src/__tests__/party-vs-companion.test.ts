// 「加入了队伍」和「队伍里没有他」不能同时成立。
//
// 实测出来的矛盾，只隔一个回合：
//
//     > 创建队友 乙 investigator    👤 乙(investigator) 加入了队伍
//     > 接管 乙                     队伍里没有「乙」。
//
// 因为有**两套并行的「队伍」**：
//   · `创建队友` 加进 `this.characters` —— 第二个**玩家角色**
//   · 邀请/告别/接管/自动 操作 `CompanionManager` —— NPC 同伴
// 两者互不相通，而报错只说「没有」，不说是哪一种没有。
//
// 另一个量出来的事实：`CompanionManager.recruit()` **生产代码里零调用方**，
// 实际对局中同伴名册永远是空的。所以这四条指令目前只可能走到「找不到」这一支。
// 那更说明这句话必须说清楚 —— 它是玩家唯一会看到的反馈。

import { describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" as const };

const textOf = (r: { events: { content: unknown }[] }) =>
  r.events.map((e) => String(e.content)).join("\n");

async function withTeammate() {
  const s = new GameSession(`pt-${Math.random()}`, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  await s.act("创建角色 investigator 甲");
  const joined = textOf(await s.act("创建队友 乙 investigator"));
  return { s, joined };
}

describe("两套「队伍」不能互相打脸", () => {
  test("**前置**：创建队友确实播报了「加入了队伍」", async () => {
    // 先确认矛盾的前一半成立，否则后面测的是别的东西。
    const { joined } = await withTeammate();
    expect(joined).toContain("加入了队伍");
  });

  test("**错误行为的红线**：刚加入队伍的人，不能被告知「队伍里没有他」", async () => {
    const { s } = await withTeammate();
    for (const cmd of ["接管 乙", "邀请 乙", "告别 乙", "自动 乙"]) {
      const out = textOf(await s.act(cmd));
      expect(out).not.toContain("队伍里没有");
    }
  }, 20_000);

  test("**正确**：要说清是「不是 NPC 同伴」，而不是「不存在」", async () => {
    const { s } = await withTeammate();
    const out = textOf(await s.act("接管 乙"));
    expect(out).toContain("玩家角色");
    expect(out).toContain("NPC 同伴");
  });

  test("**干扰输入**：真的不存在的名字，仍然说「队伍里没有」", async () => {
    // 不能为了消除矛盾就把两种情况混成一句话 —— 那是另一种不说实话。
    const { s } = await withTeammate();
    const out = textOf(await s.act("接管 查无此人"));
    expect(out).toContain("队伍里没有");
    expect(out).not.toContain("玩家角色");
  });
});
