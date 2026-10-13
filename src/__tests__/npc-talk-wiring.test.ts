// P1 — 自由跑团的"和 NPC 说话"接线
// 背景见 game-session.ts 的 handleTalk() 注释：此前 case "talk" 是纯桩，
// 不管玩家说什么、跟谁说，永远回一句"你试图与周围的人交流…"。
// MythosModuleLoader 把模组 NPC 人格注册进会话私有 NPC Agent 系统；
// 自由跑团的 handleTalk 必须直接消费该私有 authority。
//
// bun test src/__tests__/npc-talk-wiring.test.ts

import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import { NPCAgent } from "../agent/npc-agent";
import { GameSession } from "../api/game-session";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

let session: GameSession;

beforeEach(() => {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const config = {
    apiKey: "sk-placeholder",
    baseUrl: "http://localhost:9999",
    model: "mock",
    maxTokens: 1024,
    temperature: 0.7,
  };
  const source = new GameSession("talk-wiring-test", "cosmic-horror", config, "investigator", "调查员");
  session = new GameSession(source.id, "cosmic-horror", config);
  restoreSignedOrdinaryWorld(session, config, (world) => {
    const position = world.getCurrentState().scene;
    world.upsertEntity({
      id: "ghost_1", name: "无名幽影", type: "npc",
      hp: 1, maxHp: 1, ac: 10, status: [], position, scene_id: position, faction: "unknown",
    });
  }, source);
  source.close();
});

afterEach(() => session.close());

describe("和 NPC 说话 — 找不到对象时分清三种情况", () => {
  it("没指定对象：不该是万金油回复，要列出在场的人（或说明没人）", async () => {
    const res = await session.act("跟人说话");
    const content = res.events.map((e) => e.content).join("\n");
    expect(content).not.toMatch(/你试图与周围的人交流/);
    expect(content).toMatch(/要跟谁说话|这里没有人可以交谈/);
  });

  it("这里没这个人（模组未加载，场上什么人都没有）", async () => {
    const res = await session.act("跟张三说话");
    const content = res.events.map((e) => e.content).join("\n");
    expect(content).toMatch(/这里没有「张三」/);
    expect(content).not.toMatch(/你试图与周围的人交流/);
  });

  it("这里没这个人，但报错要说清楚在场都有谁", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    expect(activateRegisteredGameSessionSceneForTest(session, "特里坎家")).toBe(true);
    const res = await session.act("跟不存在的人说话");
    const content = res.events.map((e) => e.content).join("\n");
    expect(content).toMatch(/这里没有「不存在的人」/);
    expect(content).toMatch(/在场的有/);
  });

  it("人在场，但没有注册人格数据：明说缺的是什么，不是万金油回复", async () => {
    const res = await session.act("跟无名幽影说话");
    const content = res.events.map((e) => e.content).join("\n");
    expect(content).toMatch(/无名幽影没有可用的人格数据/);
    expect(content).not.toMatch(/你试图与周围的人交流/);
  });
});

describe("和 NPC 说话 — 真实对话应该走到 NPC Agent", () => {
  it("模组内联人格注册的 NPC 在场时，说话应产生一条来自该 NPC 的 dialogue 消息", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    expect(activateRegisteredGameSessionSceneForTest(session, "特里坎家")).toBe(true);

    // 菲碧·特里坎（premiers_barn.ts）带完整内联 personality，挂在"特里坎家"
    expect(session.registry.has("菲碧·特里坎")).toBe(true);

    const res = await session.act("跟菲碧说话");
    const dialogueEvent = res.events.find((e) => e.speaker === "菲碧·特里坎" && e.type === "dialogue");
    expect(dialogueEvent).toBeDefined();
    expect(dialogueEvent!.content.length).toBeGreaterThan(0);
    expect(res.narrative).toBe(dialogueEvent!.content);
  });

  it("persists a real talk memory even when the legacy public remember wrapper is patched", async () => {
    await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3");
    expect(activateRegisteredGameSessionSceneForTest(session, "\u7279\u91cc\u574e\u5bb6")).toBe(true);

    const npcName = "\u83f2\u78a7\u00b7\u7279\u91cc\u574e";
    const before = session.npcStore.countMemories(npcName);
    const prototype = NPCAgent.prototype;
    const rememberDescriptor = Object.getOwnPropertyDescriptor(prototype, "remember");
    const rememberDialogueDescriptor = Object.getOwnPropertyDescriptor(prototype, "rememberDialogue");
    expect(rememberDescriptor).toBeDefined();
    expect(rememberDialogueDescriptor).toBeDefined();
    let legacyWrapperCalls = 0;

    try {
      const legacyWrapper = () => {
        legacyWrapperCalls++;
        throw new Error("respond must not dispatch to a public memory wrapper");
      };
      Object.defineProperty(prototype, "remember", {
        ...rememberDescriptor,
        value: legacyWrapper,
      });
      Object.defineProperty(prototype, "rememberDialogue", {
        ...rememberDialogueDescriptor,
        value: legacyWrapper,
      });
      const res = await session.act("\u8ddf\u83f2\u78a7\u8bf4\u8bdd");
      const dialogueEvent = res.events.find((event) => event.speaker === npcName && event.type === "dialogue");
      expect(dialogueEvent?.content.length).toBeGreaterThan(0);
      expect(legacyWrapperCalls).toBe(0);
      expect(session.npcStore.countMemories(npcName)).toBe(before + 1);
      expect(session.npcStore.getRecentMemories(npcName, 1)[0]).toEqual(expect.objectContaining({
        type: "dialogue",
        content: `${npcName}\u8bf4: "${dialogueEvent!.content}"`,
      }));
      const runtimeAgent = session.exportOrdinarySessionSnapshot().agentRegistry.agents
        .find((agent) => agent.personality.name === npcName);
      expect(runtimeAgent?.memories).toContainEqual(expect.objectContaining({
        type: "dialogue",
        content: `${npcName}\u8bf4: "${dialogueEvent!.content}"`,
      }));
    } finally {
      try {
        Object.defineProperty(prototype, "rememberDialogue", rememberDialogueDescriptor!);
      } finally {
        Object.defineProperty(prototype, "remember", rememberDescriptor!);
      }
    }
  });

  it("连续问两次同一个 NPC，两次都应该拿到真实回复（不是桩文案）", async () => {
    // ⚠ 这条不验证「逐字不复读」——MockLLMClient 离线模式没有对话轮替记忆时
    //   会给同一句默认回复，Mock 造不出两次不同的差异，硬加 not.toBe 断言
    //   在离线测试环境下只会是一条假绿（Mock 本身就复读，断言测不出真实
    //   LLM 会不会复读）。逐字去重需要带真 LLM 的实跑验证，见 sim30 一类
    //   跑模拟脚本；这里只锁住「桩没有被绕过、respond() 真的被调用了」。
    await session.act("加载模组 普瑞米尔的谷仓");
    expect(activateRegisteredGameSessionSceneForTest(session, "特里坎家")).toBe(true);

    const res1 = await session.act("跟菲碧说话");
    const res2 = await session.act("跟菲碧说话");
    const c1 = res1.events.find((e) => e.speaker === "菲碧·特里坎")?.content;
    const c2 = res2.events.find((e) => e.speaker === "菲碧·特里坎")?.content;
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c1).not.toMatch(/你试图与周围的人交流/);
    expect(c2).not.toMatch(/你试图与周围的人交流/);
  });

  it("对话内容会计入 lastNarrative 与会话历史（供 /history 与语音层读取）", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    expect(activateRegisteredGameSessionSceneForTest(session, "特里坎家")).toBe(true);
    await session.act("跟菲碧说话");

    const history = session.getHistory(5);
    const found = history.messages.some((m) => m.speaker === "菲碧·特里坎" && m.type === "dialogue");
    expect(found).toBe(true);
  });
});
