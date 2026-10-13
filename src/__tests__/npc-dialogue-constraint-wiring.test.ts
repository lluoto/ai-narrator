import { afterEach, describe, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { isolatedProviderSeamIt } from "./helpers/provider-seam-child";

const CFG = {
  apiKey: "sk-dialogue-constraint-wiring",
  baseUrl: "http://npc-dialogue-constraint.invalid/v1",
  model: "fixture",
  maxTokens: 128,
  temperature: 0,
};

const FABRICATED_LINE = "\u540d\u5355\u4ec0\u4e48\u7684\u65e9\u8ba9\u8001\u677f\u9501\u8fdb\u62bd\u5c49\u4e86\uff0c\u54ea\u8f6e\u5f97\u5230\u4f60\u7ffb\u3002";
const CLEAN_LINE = "\u6211\u4e0d\u6e05\u695a\u5ba2\u4eba\u7684\u4e8b\uff0c\u95ee\u4e86\u4e5f\u767d\u95ee\u3002";
const UNSUPPORTED_PHOEBE_LINE = "我记得是十五天前那个周二晚上；我加班到很晚，他后来在书房看书，早上也没吃早餐。";

function installFabricatedDialogueFetch(): () => number {
  let repairRequests = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
    const repairing = body.messages?.some((message) => message.content?.includes("\u4e0a\u4e00\u53e5\u56de\u7b54\u63d0\u5230\u4e86")) ?? false;
    if (repairing) repairRequests++;
    return new Response(JSON.stringify({
      choices: [{ message: { content: repairing ? CLEAN_LINE : FABRICATED_LINE } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return () => repairRequests;
}

function installPhoebePromptCapture(captured: Array<Array<{ role?: string; content?: string }>>): void {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role?: string; content?: string }> };
    captured.push(body.messages ?? []);
    return new Response(JSON.stringify({
      choices: [{ message: { content: UNSUPPORTED_PHOEBE_LINE } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

function factualKnowledgeLine(messages: Array<{ role?: string; content?: string }>): string | undefined {
  const profile = messages.find((message) => message.role === "system" && message.content?.includes("你的名字: 菲碧·特里坎"))?.content;
  return profile?.split("\n").find((line) => line.startsWith("你知道的信息: "));
}

async function barnBouncerSession(id: string): Promise<GameSession> {
  const session = new GameSession(id, "cosmic-horror", CFG, "investigator", "Ada");
  await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3");
  expect((await session.act("\u524d\u5f80 \u7ef4\u68ee\u9152\u5427")).error).toBeUndefined();
  expect(session.registry.has("\u9152\u5427\u4fdd\u9556")).toBe(true);
  return session;
}

async function expectCanonicalBouncerRepair(session: GameSession, repairRequests: () => number): Promise<void> {
  const result = await session.act("\u8ddf\u9152\u5427\u4fdd\u9556\u8bf4\u8bdd");
  const dialogue = result.events.find((event) => event.speaker === "\u9152\u5427\u4fdd\u9556" && event.type === "dialogue");
  expect(dialogue?.content).toBe(CLEAN_LINE);
  expect(dialogue?.content).not.toContain("\u8001\u677f");
  expect(repairRequests()).toBe(1);
  expect(session.registry.has("\u8001\u677f")).toBe(false);
  expect(session.getState().npcs.map((npc) => npc.name)).not.toContain("\u8001\u677f");
}

const providerSeamIt = isolatedProviderSeamIt("src/__tests__/npc-dialogue-constraint-wiring.test.ts");

describe("handleTalk passes actual scene safety context without exposing NPC agents", () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.LLM_API_KEY;

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = savedKey;
  });

  providerSeamIt("uses the current scene context to regenerate a fabricated character reply through the real module talk path", async () => {
    process.env.LLM_API_KEY = "sk-dialogue-constraint-wiring";
    const repairRequests = installFabricatedDialogueFetch();

    const session = new GameSession(`npc-dialogue-wiring-${crypto.randomUUID()}`, "cosmic-horror", CFG, "investigator", "Ada");
    try {
      await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3");
      expect((await session.act("\u524d\u5f80 \u7ef4\u68ee\u9152\u5427")).error).toBeUndefined();
      expect(session.registry.has("\u9152\u5427\u4fdd\u9556")).toBe(true);

      const result = await session.act("\u8ddf\u9152\u5427\u4fdd\u9556\u8bf4\u8bdd");
      const dialogue = result.events.find((event) => event.speaker === "\u9152\u5427\u4fdd\u9556" && event.type === "dialogue");
      expect(dialogue?.content).toBe(CLEAN_LINE);
      expect(dialogue?.content).not.toContain("\u8001\u677f");
      expect(repairRequests()).toBe(1);
    } finally {
      session.close();
    }
  });

  providerSeamIt("injects only the matched Barn Phoebe canonical knowledge into the actual runtime NPC prompt", async () => {
    process.env.LLM_API_KEY = "sk-dialogue-constraint-wiring";
    const captured: Array<Array<{ role?: string; content?: string }>> = [];
    installPhoebePromptCapture(captured);
    const session = new GameSession(`npc-dialogue-canonical-facts-${crypto.randomUUID()}`, "cosmic-horror", CFG, "investigator", "Ada");
    try {
      expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
      expect(session.registry.has("菲碧·特里坎")).toBe(true);

      const result = await session.act("跟菲碧·特里坎说话");
      expect(result.events.find((event) => event.speaker === "菲碧·特里坎" && event.type === "dialogue")?.content).toBe(UNSUPPORTED_PHOEBE_LINE);

      const facts = captured
        .map((messages) => factualKnowledgeLine(messages))
        .find((line): line is string => line !== undefined);
      expect(facts).toContain("我已经半个多月没有他的消息了……");
      expect(facts).toContain("加比比较叛逆，喜欢出去玩，十五岁就搬到外面拖车住了");
      // Other NPC facts and both categories of Phoebe secret must not become
      // Phoebe's factual claim scope merely because this is a module runtime.
      expect(facts).not.toContain("我最后一次见到加比，是在半个月前的晚上");
      expect(facts).not.toContain("平时没有看报纸");
      expect(facts).not.toContain("平时忙于工作");
    } finally {
      session.close();
    }
  });

  providerSeamIt("does not let an own empty noun helper skip the real bouncer repair", async () => {
    process.env.LLM_API_KEY = "sk-dialogue-constraint-wiring";
    const repairRequests = installFabricatedDialogueFetch();
    const session = await barnBouncerSession(`npc-dialogue-own-nouns-${crypto.randomUUID()}`);
    try {
      Object.defineProperty(session, "sceneFabricableCharacterNouns", {
        configurable: true,
        value: () => [],
      });
      await expectCanonicalBouncerRepair(session, repairRequests);
    } finally {
      session.close();
    }
  });

  providerSeamIt("does not let a throwing own noun helper turn a real NPC talk into a generic non-response", async () => {
    process.env.LLM_API_KEY = "sk-dialogue-constraint-wiring";
    const repairRequests = installFabricatedDialogueFetch();
    const session = await barnBouncerSession(`npc-dialogue-throwing-nouns-${crypto.randomUUID()}`);
    try {
      Object.defineProperty(session, "sceneFabricableCharacterNouns", {
        configurable: true,
        value: () => { throw new Error("forged noun helper"); },
      });
      await expectCanonicalBouncerRepair(session, repairRequests);
    } finally {
      session.close();
    }
  });

  providerSeamIt("does not let a temporary prototype noun helper shadow contaminate real module talks", async () => {
    process.env.LLM_API_KEY = "sk-dialogue-constraint-wiring";
    const repairRequests = installFabricatedDialogueFetch();
    const original = Object.getOwnPropertyDescriptor(GameSession.prototype, "sceneFabricableCharacterNouns");
    let session: GameSession | undefined;
    try {
      Object.defineProperty(GameSession.prototype, "sceneFabricableCharacterNouns", {
        configurable: true,
        writable: true,
        value: () => [],
      });
      session = await barnBouncerSession(`npc-dialogue-prototype-nouns-${crypto.randomUUID()}`);
      await expectCanonicalBouncerRepair(session, repairRequests);
    } finally {
      if (original) Object.defineProperty(GameSession.prototype, "sceneFabricableCharacterNouns", original);
      else Reflect.deleteProperty(GameSession.prototype, "sceneFabricableCharacterNouns");
      session?.close();
    }
  });
});
