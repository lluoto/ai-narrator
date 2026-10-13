import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PlayerAgent, playerLLMConfigured, setPlayerLLM } from "../agent/player-agent";
import { GameSession } from "../api/game-session";
import { LLMClient } from "../llm/client";
import { narratorLLMConfigured, setNarratorLLM } from "../llm/narrator";
import { runModule } from "../play-module";
import { BARN_OF_PREMIER, BARN_SUPPORT } from "../module/barn-of-premier";
import { runCombatEncounter } from "../play/combat";
import { runCtx, type RunContext } from "../play/narration";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const ENV_KEYS = ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "LLM_BASE_URL", "LLM_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;
const armedSessions: GameSession[] = [];

const FIRST = {
  apiKey: "sk-first-session-key",
  baseUrl: "https://first.narrator.example.invalid/v1",
  model: "first-narrator-model",
  maxTokens: 16,
  temperature: 0,
};
const SECOND = {
  apiKey: "sk-second-session-key",
  baseUrl: "https://second.narrator.example.invalid/v1",
  model: "second-narrator-model",
  maxTokens: 16,
  temperature: 0,
};

function enableLLM() {
  delete process.env.LLM_DISABLED;
  delete process.env.LLM_MODE;
  process.env.LLM_API_KEY = "sk-test-enables-the-gate";
}

function makeAgent(client?: ConstructorParameters<typeof PlayerAgent>[1]): PlayerAgent {
  return new PlayerAgent({
    name: "Agent under test",
    occupation: "journalist",
    personality: "careful",
    backstory: "none",
    currentGoal: "investigate",
    char: {},
  } as never, client);
}

function requestBody(init?: RequestInit): any {
  return JSON.parse(String(init?.body));
}

function isNarrationRequest(init?: RequestInit): boolean {
  return String(requestBody(init).messages?.[0]?.content).includes("战斗叙事生成器");
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

async function armedSession(config: typeof FIRST): Promise<GameSession> {
  const source = new GameSession(
    `narrator-${crypto.randomUUID()}`, "cosmic-horror", config, "investigator", "测试员",
  );
  const session = new GameSession(source.id, "cosmic-horror", config);
  try {
    restoreSignedOrdinaryWorld(session, config, (world) => {
      const scene = world.getCurrentState().scene;
      world.upsertEntity({
        id: "narrator-target", name: "叙事目标", type: "monster", hp: 200, maxHp: 200,
        ac: 0, status: [], position: scene, scene_id: scene,
      });
    }, source);
  } finally {
    source.close();
  }
  expect(session.activeCharacter?.name).toBe("测试员");
  armedSessions.push(session);
  return session;
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  savedFetch = globalThis.fetch;
  LLMClient.resetDefeat();
  setNarratorLLM(null);
  setPlayerLLM(null);
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  LLMClient.resetDefeat();
  setNarratorLLM(null);
  setPlayerLLM(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (armedSessions.length) armedSessions.pop()!.close();
});

describe("runtime LLM clients are isolated from legacy globals", () => {
  test("a second GameSession sends its combat narration to its own endpoint, key, and model", async () => {
    enableLLM();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const body = requestBody(init);
      const system = body.messages?.[0]?.content ?? "";
      const inputText = body.messages?.at(-1)?.content ?? "";
      const content = system.includes("意图解析器")
        ? JSON.stringify(inputText.includes("创建角色")
          ? { action: "create_character" }
          : { action: "attack", target: "叙事目标" })
        : system.includes("战斗叙事生成器")
          ? `combat narration from ${String(input)}`
          : "other run text";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    new GameSession(`first-${crypto.randomUUID()}`, "cosmic-horror", FIRST);
    const second = await armedSession(SECOND);
    requests.length = 0;
    await second.act("攻击 叙事目标");

    const narrations = requests.filter(({ init }) => isNarrationRequest(init));
    expect(narrations.length).toBeGreaterThan(0);
    for (const narration of narrations) {
      expect(narration.url).toBe(`${SECOND.baseUrl}/chat/completions`);
      expect(header(narration.init, "authorization")).toBe(`Bearer ${SECOND.apiKey}`);
      expect(requestBody(narration.init)).toMatchObject({ model: SECOND.model });
    }
  });

  test("a disabled session never borrows an enabled session narrator and stays offline", async () => {
    enableLLM();
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "unexpected global narration" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    new GameSession(`enabled-${crypto.randomUUID()}`, "cosmic-horror", FIRST);
    process.env.LLM_DISABLED = "true";
    const disabled = await armedSession(SECOND);
    await disabled.act("攻击 叙事目标");

    expect(fetches).toBe(0);
  });

  test("a same-name runtime shadow cannot forge combat narration selected by the session's canonical client", async () => {
    enableLLM();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const body = requestBody(init);
      const system = body.messages?.[0]?.content ?? "";
      const content = system.includes("\u610f\u56fe\u89e3\u6790\u5668")
        ? JSON.stringify({ action: "attack", target: "\u53d9\u4e8b\u76ee\u6807" })
        : system.includes("\u6218\u6597\u53d9\u4e8b\u751f\u6210\u5668")
          ? "CANONICAL COMBAT NARRATION"
          : "other response";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const session = await armedSession(SECOND);
    let forgedCalls = 0;
    Object.defineProperty(session, "narrativeLLM", {
      configurable: true,
      value: {
        chat: async () => {
          forgedCalls++;
          return "FORGED COMBAT NARRATION";
        },
      },
    });
    requests.length = 0;

    const response = await session.act("\u653b\u51fb \u53d9\u4e8b\u76ee\u6807");
    expect(forgedCalls).toBe(0);
    expect(response.events.some((event) => event.content.includes("FORGED COMBAT NARRATION"))).toBe(false);
    expect(response.events.some((event) => event.content.includes("CANONICAL COMBAT NARRATION"))).toBe(true);
    expect(requests.filter(({ init }) => isNarrationRequest(init)).length).toBeGreaterThan(0);
  });

  test("PlayerAgent explicit clients beat the legacy global and explicit null is offline", async () => {
    enableLLM();
    setPlayerLLM({
      chat: async () => JSON.stringify({ action: "GLOBAL", intent: "other" }),
    } as never);
    const first = makeAgent({
      chat: async () => JSON.stringify({ action: "FIRST", intent: "other" }),
    } as never);
    const second = makeAgent({
      chat: async () => JSON.stringify({ action: "SECOND", intent: "other" }),
    } as never);
    const offline = makeAgent(null);

    expect((await first.decideViaLLM("scene", [], [])).action).toBe("FIRST");
    expect((await second.decideViaLLM("scene", [], [])).action).toBe("SECOND");
    expect((await offline.decideViaLLM("scene", [], [])).action).not.toBe("GLOBAL");
  });

  test("GameSession construction leaves both legacy narrator and player globals untouched", () => {
    enableLLM();
    new GameSession(`no-global-${crypto.randomUUID()}`, "cosmic-horror", FIRST);
    expect(narratorLLMConfigured()).toBe(false);
    expect(playerLLMConfigured()).toBe(false);
  });

  test("a play-module run gives its own client to its built-in PlayerAgent instead of the legacy global", async () => {
    enableLLM();
    let runAgentCalls = 0;
    let globalAgentCalls = 0;
    setPlayerLLM({
      chat: async () => {
        globalAgentCalls++;
        return JSON.stringify({ action: "GLOBAL", intent: "other" });
      },
    } as never);
    const runClient = {
      chat: async (messages: Array<{ content: string }>) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("调查员角色")) {
          runAgentCalls++;
          return JSON.stringify({ action: "观察周围", intent: "observe" });
        }
        return "run-owned response";
      },
    } as never;

    await runModule(BARN_OF_PREMIER, BARN_SUPPORT, { llmClient: runClient });

    expect(runAgentCalls).toBeGreaterThan(0);
    expect(globalAgentCalls).toBe(0);
  }, 20_000);

  test("two runs from one ModuleData source keep runtime NPC LLM expansions private", async () => {
    enableLLM();
    const module = structuredClone(BARN_OF_PREMIER);
    const npc = module.npcs.find((candidate) => candidate.id === "adrian_estrum");
    if (!npc) throw new Error("fixture NPC is missing");
    delete npc.llmExpanded;
    const sourceNpcBefore = structuredClone(npc);

    const runUntilFirstDecision = async (client: unknown): Promise<void> => {
      let stopped = false;
      try {
        await runModule(module, BARN_SUPPORT, {
          llmClient: client as never,
          decide: async () => { throw new Error("__stop_after_runtime_npc_expansion__"); },
        });
      } catch (error) {
        stopped = error instanceof Error && error.message === "__stop_after_runtime_npc_expansion__";
      }
      expect(stopped).toBe(true);
    };
    const responseFor = (firstEncounter: string) => JSON.stringify({
      firstEncounter,
      knowledgeReveals: ["我最近心里很不安。", "这件事让我彻夜难眠。", "我不愿再提起那些往事。"],
      revisitEncounter: "你们又来了。",
    });

    let firstRunAdrianCalls = 0;
    await runUntilFirstDecision({
      chat: async (messages: unknown[]) => {
        if (String((messages[1] as { content?: unknown } | undefined)?.content ?? "").includes("NPC 名: 艾德里安·埃斯特鲁姆")) {
          firstRunAdrianCalls++;
        }
        return responseFor("甲局生成的台词。");
      },
    });

    let secondRunAdrianCalls = 0;
    await runUntilFirstDecision({
      chat: async (messages: unknown[]) => {
        if (String((messages[1] as { content?: unknown } | undefined)?.content ?? "").includes("NPC 名: 艾德里安·埃斯特鲁姆")) {
          secondRunAdrianCalls++;
        }
        return responseFor("乙局生成的台词。");
      },
    });

    expect(firstRunAdrianCalls).toBe(1);
    expect(secondRunAdrianCalls).toBe(1);
    expect(npc).toEqual(sourceNpcBefore);
    expect(npc.llmExpanded).toBeUndefined();
  }, 20_000);

  test("an explicit null play run stays offline even when legacy globals are configured", async () => {
    enableLLM();
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("explicit null must not fetch");
    }) as unknown as typeof fetch;
    setPlayerLLM({ chat: async () => JSON.stringify({ action: "GLOBAL", intent: "other" }) } as never);
    setNarratorLLM({ chat: async () => "GLOBAL NARRATOR" } as never);

    let stopped = false;
    try {
      await runModule(BARN_OF_PREMIER, BARN_SUPPORT, {
        llmClient: null,
        decide: async () => { throw new Error("__stop_after_first_decision__"); },
      });
    } catch (err) {
      stopped = err instanceof Error && err.message === "__stop_after_first_decision__";
    }

    expect(stopped).toBe(true);
    expect(fetches).toBe(0);
  }, 20_000);

  test("LLM_DISABLED fail-closes an explicit play-run client for every consumer", async () => {
    enableLLM();
    process.env.LLM_DISABLED = "true";
    let clientCalls = 0;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("LLM_DISABLED must not fetch");
    }) as unknown as typeof fetch;
    const explicitClient = {
      chat: async () => {
        clientCalls++;
        return "this explicit client must stay unused";
      },
    } as never;

    let stopped = false;
    try {
      await runModule(BARN_OF_PREMIER, BARN_SUPPORT, {
        llmClient: explicitClient,
        decide: async () => { throw new Error("__stop_after_first_decision__"); },
      });
    } catch (err) {
      stopped = err instanceof Error && err.message === "__stop_after_first_decision__";
    }

    expect(stopped).toBe(true);
    expect(clientCalls).toBe(0);
    expect(fetches).toBe(0);
  }, 20_000);

  test("a DeepSeek-only environment builds the default run client from loadConfig without an empty key", async () => {
    delete process.env.LLM_DISABLED;
    delete process.env.LLM_MODE;
    delete process.env.LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.DEEPSEEK_API_KEY = "deepseek-run-key";
    process.env.LLM_BASE_URL = "https://deepseek.example.invalid/v1";
    process.env.LLM_MODEL = "deepseek-run-model";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      throw new Error("intercepted DeepSeek request");
    }) as unknown as typeof fetch;

    let stopped = false;
    try {
      await runModule(BARN_OF_PREMIER, BARN_SUPPORT, {
        decide: async () => { throw new Error("__stop_after_first_decision__"); },
      });
    } catch (err) {
      stopped = err instanceof Error && err.message === "__stop_after_first_decision__";
    }

    expect(stopped).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://deepseek.example.invalid/v1/chat/completions");
    expect(header(requests[0]?.init, "authorization")).toBe("Bearer deepseek-run-key");
    expect(requestBody(requests[0]?.init)).toMatchObject({ model: "deepseek-run-model" });
  }, 20_000);

  test("play combat narration reads the active RunContext client, never the legacy narrator", async () => {
    enableLLM();
    const realRandom = Math.random;
    let runCalls = 0;
    let legacyCalls = 0;
    Math.random = () => 0;
    setNarratorLLM({
      chat: async () => {
        legacyCalls++;
        return "LEGACY NARRATION";
      },
    } as never);
    const ctx: RunContext = {
      llmClient: {
        chat: async () => {
          runCalls++;
          return "RUN CONTEXT NARRATION";
        },
      } as never,
      lines: [],
      origins: [],
      wounds: new Map(),
    };
    const cast = {
      p0: { shortName: "A" }, p1: { shortName: "B" },
      c1: { hp: 12, maxHp: 12, attributes: { constitution: 60, dexterity: 50 }, skillValues: { fighting: 50, firearms_pistol: 10, dodge: 30 } },
      c2: { hp: 12, maxHp: 12, attributes: { constitution: 60, dexterity: 50 }, skillValues: { fighting: 50, firearms_pistol: 10, dodge: 30 } },
      san1: { state: { currentSAN: 50, maxSAN: 50 }, sanityCheck: () => ({ passed: true, sanLoss: 0, roll: 50 }) },
      san2: { state: { currentSAN: 50, maxSAN: 50 }, sanityCheck: () => ({ passed: true, sanLoss: 0, roll: 50 }) },
    } as never;
    const world = { isClueFound: (id: string) => id === "need", discoverClue: () => {} } as never;
    const module = { npcs: [{ id: "mi_go", description: "每回合攻击1次。格斗 55%（1d6伤害）闪避 5%\nHP11" }] } as never;
    const scene = { id: "run-context-combat", name: "combat" } as never;
    const support = {
      bossNpcIdPattern: /^mi_go$/,
      encounters: [{
        sceneId: "run-context-combat", requiredClue: "need", excludedClue: "never",
        enemyName: "enemy", encounterLines: [], victoryLines: [], defeatLines: [],
      }],
    } as never;

    try {
      await runCtx.run(ctx, () => runCombatEncounter(cast, world, module, scene, support));
    } finally {
      Math.random = realRandom;
    }

    expect(runCalls).toBeGreaterThan(0);
    expect(legacyCalls).toBe(0);
    expect(ctx.lines.some((line) => line.includes("RUN CONTEXT NARRATION"))).toBe(true);
  });
});
