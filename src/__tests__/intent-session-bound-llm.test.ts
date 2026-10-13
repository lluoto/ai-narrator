import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { LLMClient } from "../llm/client";
import { setIntentLLM } from "../llm/intent";
import { setNarratorLLM } from "../llm/narrator";
import { log } from "../log";

const ENV_KEYS = ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;

const FIRST_CONFIG = {
  apiKey: "sk-session-first-test-key",
  baseUrl: "https://first.intent.example.invalid/v1",
  model: "first-intent-model",
  maxTokens: 16,
  temperature: 0,
};

const SECOND_CONFIG = {
  apiKey: "sk-session-second-test-key",
  baseUrl: "https://second.intent.example.invalid/v1",
  model: "second-intent-model",
  maxTokens: 16,
  temperature: 0,
};

function enableLLM(): void {
  delete process.env.LLM_DISABLED;
  delete process.env.LLM_MODE;
  process.env.LLM_API_KEY = "sk-env-allows-session-intent";
}

function readHeader(headers: unknown, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry?.[1] ?? null;
  }
  if (headers && typeof headers === "object") {
    const entry = Object.entries(headers as Record<string, unknown>)
      .find(([key]) => key.toLowerCase() === name.toLowerCase());
    return typeof entry?.[1] === "string" ? entry[1] : null;
  }
  return null;
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  savedFetch = globalThis.fetch;
  LLMClient.resetDefeat();
  setIntentLLM(null);
  setNarratorLLM(null);
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  LLMClient.resetDefeat();
  setIntentLLM(null);
  setNarratorLLM(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("普通 GameSession 的意图 LLM 必须绑定当前会话", () => {
  test("第二个会话的 act 只向自己的 endpoint、key 和 model 发意图请求", async () => {
    enableLLM();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action: "help" }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    new GameSession(`first-intent-${crypto.randomUUID()}`, "cosmic-horror", FIRST_CONFIG);
    const second = new GameSession(`second-intent-${crypto.randomUUID()}`, "cosmic-horror", SECOND_CONFIG);
    await second.act("用自然语言告诉我现在能做什么");

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.url).toBe(`${SECOND_CONFIG.baseUrl}/chat/completions`);
    expect(readHeader(request.init?.headers, "authorization")).toBe(`Bearer ${SECOND_CONFIG.apiKey}`);
    expect(JSON.parse(String(request.init?.body))).toMatchObject({ model: SECOND_CONFIG.model });
  });

  test("已有启用会话时，后建的 LLM_DISABLED 会话零 fetch、走 regex 并声明真实路径", async () => {
    enableLLM();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action: "help" }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    new GameSession(`enabled-intent-${crypto.randomUUID()}`, "cosmic-horror", FIRST_CONFIG);
    process.env.LLM_DISABLED = "true";
    const infoSpy = spyOn(log, "info");
    const warnSpy = spyOn(log, "warn");
    try {
      const disabled = new GameSession(`disabled-intent-${crypto.randomUUID()}`, "cosmic-horror", SECOND_CONFIG);
      await disabled.act("查看背包");

      const infoCalls = infoSpy.mock.calls.filter((call: any[]) => call[0] === "intent");
      const warnCalls = warnSpy.mock.calls.filter((call: any[]) => call[0] === "intent");
      expect(requests).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(1);
      expect(String(warnCalls[0][1])).toContain("regex");
      expect(String(warnCalls[0][1])).toContain("llmEnabled");
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("会话 LLM 的合法燃运意图会实际驱动攻击处理器扣除幸运", async () => {
    enableLLM();
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        action: "attack",
        target: "敌人",
        luckSpend: 3,
        calledShot: "头部",
      }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    const session = new GameSession(`luck-intent-${crypto.randomUUID()}`, "cosmic-horror", FIRST_CONFIG, "investigator", "Ada");
    expect(session.updateActiveCharacter({ luck: 10 })).toMatchObject({ status: "updated" });

    const result = await session.act("请用三点幸运瞄准攻击敌人");

    expect(session.activeCharacter.luck).toBe(7);
    expect(result.events.some((event) => event.content.includes("消耗 3 点幸运"))).toBe(true);
  });
});
