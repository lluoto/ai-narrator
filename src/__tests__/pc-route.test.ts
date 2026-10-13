// 以哪个 PC 身份行动：POST /api/sessions/:id/action 的 pcId 转发，以及
// act() 按 pcId（而不是角色显示名）路由。
//
// 背景：act(input, actingCharacterName?) 曾按角色**显示名**匹配（":1282-1288"），
// 命中后写 this.activePlayerId。但 web 路径 server.ts 的 action 端点从不传第二参
// （`session.act(input)`），于是 activePlayerId 在 web 上永远是 p1——多 PC 时
// 无法以别的 PC 身份行动。按名字匹配还有两个毛病：重名 PC 取第一个（find 语义），
// 且绕一圈才回到 pcId。改：第二参直接收 pcId（零生产调用方，直接换掉名字路径）。
//
// bun test src/__tests__/pc-route.test.ts

import { describe, it, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { runAction } from "../api/server";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};

/** Routing is a pure in-memory concern; Career persistence belongs to durable hosts. */
function memorySession(id: string, archetypeId?: string, characterName?: string): GameSession {
  return new GameSession(
    id, "cosmic-horror", CFG, archetypeId, characterName,
    undefined, undefined, undefined, undefined, { careerEntryPersistence: "transient" },
  );
}

function characterSnapshot(session: GameSession, pcId: string): any | undefined {
  const partyMember = session.getState().party.find((entry) => entry.pcId === pcId);
  if (partyMember) return partyMember;
  return pcId === session.activePlayerId ? session.activeCharacter ?? undefined : undefined;
}

describe("act 按 pcId 路由——行为正确", () => {
  it("**正确**：act(input, \"p2\") 后 getState().player 与消息归属都落在 p2，不再是 p1", async () => {
    const s: any = memorySession(`pr1-${Math.random()}`);
    await s.act("创建角色 investigator 甲"); // p1
    await s.act("创建队友 乙 investigator"); // p2
    expect(s.activePlayerId).toBe("p1");
    await s.act("顺时针查看房间一眼", "p2");
    expect(s.activePlayerId).toBe("p2"); // 路由生效，activePlayerId 切到 p2
    // getState().player 反映 p2（错误行为的红线：仍记在 p1 上就红）
    expect(s.getState().player.name).toBe(characterSnapshot(s, "p2")?.name);
    // 消息归属跟着变：getHistory 取的是 active（p2）的历史，应含 p2 的行动
    const hist = s.getHistory().messages;
    const actionMsg = hist.find((m: any) => m.type === "action");
    expect(actionMsg).toBeDefined();
    expect(actionMsg.content).toBe("顺时针查看房间一眼");
  });

  it("**目标行为错误的对照**：路由到 p2 行动后，消息的 speaker 记在 p2 头上（不是趴在 p1 的甲身上）；再以 p1 行动能切回来", async () => {
    // 用带 archetype 的构造，p1 的会话槽位 characterName 一开始就是真名"甲"——
    // 不然会撞上"无 archetype 建号后槽位名仍是兜底'调查员'"这个与本题无关的
    // 既有怪癖，分散本测试要量的事（路由让消息归属跟着 pcId 走）。
    const s: any = memorySession(`pr2-${Math.random()}`, "investigator", "甲");
    await s.act("创建队友 乙 investigator"); // p2 = 乙
    const name1 = characterSnapshot(s, "p1")?.name; // 甲
    const name2 = characterSnapshot(s, "p2")?.name; // 乙
    await s.act("p2的动作", "p2");
    // 消息归属的核心信号是 speaker：p2 的那条 action 该署 name2（乙）——配"加入的
    // 那个新成员自己"，不是趴在 p1 的甲头上。
    const action2 = s.getHistory().messages.find((m: any) => m.type === "action" && m.content === "p2的动作");
    expect(action2).toBeDefined();
    expect(action2.speaker).toBe(name2); // 记在乙头上
    expect(action2.speaker).not.toBe(name1); // 不能趴在甲头上
    expect(s.activePlayerId).toBe("p2");
    await s.act("p1的动作", "p1"); // 切回
    expect(s.activePlayerId).toBe("p1");
    expect(s.getState().player.name).toBe(name1);
    const action1 = s.getHistory().messages.find((m: any) => m.type === "action" && m.content === "p1的动作");
    expect(action1).toBeDefined();
    expect(action1.speaker).toBe(name1);
  });

  it("**文本相似但合法**：act(input, \"p1\") 传的是当前活跃 pcId 本身——不该报错也不该二次切换", async () => {
    const s: any = memorySession(`pr3-${Math.random()}`);
    await s.act("创建角色 investigator 甲"); // p1 是活跃
    const before = s.activePlayerId;
    const res = await s.act("原地观察", "p1"); // 传当前活跃 pcId
    expect(s.activePlayerId).toBe(before);
    expect(res.error).toBeUndefined();
    expect(res.state.player.name).toBe(characterSnapshot(s, "p1")?.name);
  });
});

describe("角色名是 Career 绑定身份", () => {
  it("**正确**：跨 pcId 同名被拒绝，不同名仍按 pcId 正确路由", async () => {
    const s: any = memorySession(`pr4-${Math.random()}`);
    const first = s.addPartyMember("一件东西", "investigator"); // p2
    expect(first).not.toHaveProperty("rejected");
    // Rebuilding the same PC retains its Career-bound name: the uniqueness
    // guard is strictly across pcIds, not a prohibition on replacement.
    const rebuild = await s.act("创建角色 investigator 一件东西", "p2");
    expect(rebuild.error).toBeUndefined();
    expect(characterSnapshot(s, "p2")?.name).toBe("一件东西");
    const beforeDuplicate = s.getState();
    expect(s.addPartyMember("一件东西", "investigator")).toEqual({
      rejected: expect.any(String),
      reason: "duplicate_character_name",
    });
    expect(s.getState()).toEqual(beforeDuplicate);

    const distinct = s.addPartyMember("另一件东西", "investigator"); // p3
    expect(distinct).not.toHaveProperty("rejected");
    const party = s.getState().party as Array<{ pcId: string; name: string }>;
    expect(party.filter((member) => member.pcId === "p2" || member.pcId === "p3")).toHaveLength(2);
    await s.act("p3的那句", "p3");
    expect(s.activePlayerId).toBe("p3");
    expect(s.getState().player.hp).toBe(s.activeCharacter.hp);
  });
});

describe("未知 pcId → 结构化拒绝，activePlayerId 不变", () => {
  it("**错误行为的红线**：传了不存在的 pcId，act() 置 error 且任何状态都不能被改动（activePlayerId 不能先切过去再拒）", async () => {
    const s: any = memorySession(`pr5-${Math.random()}`);
    await s.act("创建角色 investigator 甲"); // p1 活跃
    const beforeId = s.activePlayerId;
    const beforeRound = s.round;
    const res = await s.act("原地观察", "p9"); // p9 不存在
    expect(res.error).toEqual({ code: "unknown_target", targetId: "p9" });
    expect(s.activePlayerId).toBe(beforeId); // 没被切换
    expect(s.round).toBe(beforeRound); // round 也没推进——拒绝发生在任何状态改动前
    // 不兜底、不折成系统消息：error 字段之外不应把"拒绝"编成一条正常叙事
    expect(res.events.filter((e: any) => e.type === "narration").length).toBe(0);
  });

  it("**目标行为错误的对照**：空壳 p1（还没有角色卡）在创建角色前，也不能以它行动——没卡可行动就该拒", async () => {
    const s: any = memorySession(`pr6-${Math.random()}`); // 无 archetype，走空壳分支
    expect(characterSnapshot(s, "p1")).toBeUndefined(); // 空壳没有角色卡
    const res = await s.act("原地观察", "p1");
    expect(res.error).toEqual({ code: "unknown_target", targetId: "p1" });
  });
});

describe("getState() 暴露队伍（pcId + 名字 + control）", () => {
  it("**正确**：party 里的每个成员都会出现在 state.party，带 pcId/name/control", async () => {
    const s: any = memorySession(`pr7-${Math.random()}`);
    await s.act("创建角色 investigator 甲"); // p1
    await s.act("创建队友 乙 investigator"); // p2
    const st = s.getState();
    const pcIds = st.party.map((m: any) => m.pcId).sort();
    expect(pcIds).toEqual(["p1", "p2"]);
    const p2m = st.party.find((m: any) => m.pcId === "p2");
    expect(p2m.name).toBe(characterSnapshot(s, "p2")?.name);
    expect(["auto", "player:"].some((p) => String(p2m.control).startsWith(p))).toBe(true);
  });
});

describe("server runAction：action 端点把 pcId 转发给 act()", () => {
  it("**正确**：runAction 解析 body.pcId 并路由到对应 PC", async () => {
    const s: any = memorySession(`pr8-${Math.random()}`);
    await s.act("创建角色 investigator 甲"); // p1
    await s.act("创建队友 乙 investigator"); // p2
    const r = await runAction(s, { input: "p2的行动", pcId: "p2" });
    expect(r.status).toBe(200);
    expect(s.activePlayerId).toBe("p2");
    const state: any = (r.body as any).state;
    expect(state.player.name).toBe(characterSnapshot(s, "p2")?.name);
    const actionMsgs = ((r.body as any).events as any[]).filter((e: any) => e.type === "action");
    expect(actionMsgs.some((e: any) => e.content === "p2的行动")).toBe(true);
  });

  it("**错误行为的红线**：未知 pcId 走 runAction 得到结构化 404，activePlayerId 不变", async () => {
    const s: any = memorySession(`pr9-${Math.random()}`);
    await s.act("创建角色 investigator 甲");
    const beforeId = s.activePlayerId;
    const r = await runAction(s, { input: "原地观察", pcId: "p99" });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ code: "unknown_target", targetId: "p99" });
    expect(s.activePlayerId).toBe(beforeId);
  });

  it("**目标行为错误的对照**：不传 pcId 时沿用 activePlayerId（既有客户端不破），行为与直接 act 一致", async () => {
    const s: any = memorySession(`prA-${Math.random()}`);
    await s.act("创建角色 investigator 甲");
    const r = await runAction(s, { input: "低头看地板" });
    expect(r.status).toBe(200);
    expect(s.activePlayerId).toBe("p1");
    expect((r.body as any).state.player.name).toBe(characterSnapshot(s, "p1")?.name);
  });

  it("**文本相似但合法**：pcId 传了空白串等价于不传", async () => {
    const s: any = memorySession(`prB-${Math.random()}`);
    await s.act("创建角色 investigator 甲");
    const r = await runAction(s, { input: "看天", pcId: "   " });
    expect(r.status).toBe(200);
    expect(s.activePlayerId).toBe("p1");
  });
});
