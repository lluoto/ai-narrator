// PlayerAgent 的决策 LLM 要走 LLMClient 接缝，不再在 agent 里裸 fetch。
//
// 起因：decideViaLLM 原先直接读 `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL` 并裸
// fetch —— 绕开 `llmEnabled()` 这个唯一判据（`LLM_DISABLED=true` 拦不住它），
// 每次调用还各写一套 OpenAI 协议与硬编码的 temperature/max_tokens。
// 现在统一走模块级单例接缝（与 intent/narrator 同一套模式），GameSession 与
// play-module 在「只在还没设过时设」的守卫下注册。
//
// ⚠ 这个文件动模块级单例（_playerLLM），每条用例后必须还原。

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  PlayerAgent,
  setPlayerLLM,
  playerLLMConfigured,
  type PlayerDecision,
} from "../agent/player-agent";
import { GameSession } from "../api/game-session";

function agent(): PlayerAgent {
  const pc = {
    name: "测试员",
    occupation: "记者",
    personality: "谨慎",
    backstory: "无",
    currentGoal: "查明真相",
    char: {},
  } as unknown as ConstructorParameters<typeof PlayerAgent>[0];
  return new PlayerAgent(pc);
}

const REAL_LOOKING = {
  // 像真 key（不以 sk-placeholder 开头）→ GameSession 会建真的 LLMClient。
  apiKey: "sk-test-not-a-placeholder", baseUrl: "http://127.0.0.1:1",
  model: "m", maxTokens: 16, temperature: 0,
};
const PLACEHOLDER = { ...REAL_LOOKING, apiKey: "sk-placeholder" };

const ENV_KEYS = ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  setPlayerLLM(null);
});
afterEach(() => {
  setPlayerLLM(null); // 还原单例，别影响别的测试文件
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function enableLLM() {
  delete process.env.LLM_DISABLED;
  delete process.env.LLM_MODE;
  process.env.LLM_API_KEY = "sk-test-not-a-placeholder";
}

describe("GameSession 要接上玩家决策的 LLM 接缝", () => {
  test("GameSession does not create PlayerAgent instances or mutate the legacy player global", () => {
    enableLLM();
    new GameSession(`w-${Math.random()}`, "cosmic-horror", REAL_LOOKING);
    expect(playerLLMConfigured()).toBe(false);
  });

  test("**正确**：LLM_DISABLED=true 时不接 —— 离线开关必须拦得住", () => {
    enableLLM();
    process.env.LLM_DISABLED = "true";
    new GameSession(`w-${Math.random()}`, "cosmic-horror", REAL_LOOKING);
    expect(playerLLMConfigured()).toBe(false);
  });

  test("**干扰输入**：占位 key 走 MockLLMClient，不该接进去", () => {
    enableLLM();
    new GameSession(`w-${Math.random()}`, "cosmic-horror", PLACEHOLDER);
    expect(playerLLMConfigured()).toBe(false);
  });

  test("**错误行为的红线**：已经设过就不许再覆盖", async () => {
    enableLLM();
    // 设一个可辨识的 sentinel：若 GameSession 用真 LLMClient 覆盖它，
    // decideViaLLM 会打向 baseUrl 127.0.0.1:1（必然失败 → fallback），
    // 而不是返回 sentinel 的决策 —— 于是断言能真正抓到「被顶掉」。
    setPlayerLLM({
      chat: async () => `{"action":"我就地休整","intent":"other"}`,
    } as never);
    new GameSession(`w-${Math.random()}`, "cosmic-horror", REAL_LOOKING);
    const d = await agent().decideViaLLM("你站在门口。", ["门缝里透出光"], []);
    // 仍是 sentinel 的决策，说明没被会话覆盖
    expect(d.intent).toBe("other");
    expect(d.action).toBe("我就地休整");
  });
});

describe("decideViaLLM 走接缝，且失败不抛、回落 fallback", () => {
  test("**无 key / llmEnabled=false 时不抛错，降级为 fallback 决策**", async () => {
    delete process.env.LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const d = await agent().decideViaLLM("你站在门口。", ["门缝里透出光"], []);
    expect(d).toBeDefined();
    expect(d.intent).toBe("investigate"); // 有线索 → fallback 走调查
  });

  test("**接了接缝后，走的是接缝的 chat 而非裸 fetch**", async () => {
    enableLLM();
    let called: { temperature?: number; maxTokens?: number } | null = null;
    setPlayerLLM({
      chat: async (_msgs: any, opts: any) => {
        called = opts ?? {};
        return `{"action":"我凑近查看门缝","intent":"investigate"}`;
      },
    } as never);
    const d = await agent().decideViaLLM("你站在门口。", ["门缝里透出光"], []);
    expect(d.intent).toBe("investigate");
    expect(called).not.toBeNull();
  });

  test("**接缝默认 temperature/max_tokens，且可用 opts 覆盖**", async () => {
    enableLLM();
    const seen: any[] = [];
    setPlayerLLM({
      chat: async (_msgs: any, opts: any) => {
        seen.push(opts);
        return `{"action":"我开火","intent":"combat"}`;
      },
    } as never);
    await agent().decideViaLLM("危险。", [], [], { temperature: 0.1, maxTokens: 50 });
    expect(seen[0].temperature).toBe(0.1);
    expect(seen[0].maxTokens).toBe(50);
    // 不传 opts 时用默认（0.8 / 200）
    await agent().decideViaLLM("危险。", [], []);
    expect(seen[1].temperature).toBe(0.8);
    expect(seen[1].maxTokens).toBe(200);
  });

  test("**接缝抛错不冒泡，回落 fallback 且标记降级**", async () => {
    enableLLM();
    setPlayerLLM({
      chat: async () => { throw new Error("boom"); },
    } as never);
    const a = agent();
    const d: PlayerDecision = await a.decideViaLLM("你站在门口。", ["门缝里透出光"], []);
    expect(d).toBeDefined();
    expect(a.llmAvailable).toBe(false);
    expect(a.downgradeReason).toContain("boom");
  });

  test("**接缝返回空串，回落 fallback**", async () => {
    enableLLM();
    setPlayerLLM({ chat: async () => "" } as never);
    const a = agent();
    const d = await a.decideViaLLM("你站在门口。", ["门缝里透出光"], []);
    expect(d).toBeDefined();
    expect(a.llmAvailable).toBe(false);
  });
});
