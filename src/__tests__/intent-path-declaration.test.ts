// 五项开发·任务1（第二轮）：意图可观测性有个盲点。
//
// 起因：上一轮加了两处 log.warn（LLM 抛错 / 返回非法 JSON 时），但
// `_llmClient` 为 null 时 parseIntent() 连 try 都不进，两处 warn 都摸不到。
// 实跑 30 回合 [intent] 日志零条——"LLM 接上了且全对"与"LLM 根本没接、
// 全程 regex"在日志上完全一样，可观测性复制了它要消除的歧义。
//
// 修法：declareIntentPath() 在 GameSession 构造时打一条起手声明（一局一次，
// 不是每回合都打），从日志能唯一反推走的哪条路。
//
// ⚠ 这个文件动的是模块级单例 `_llmClient`（与 intent-llm-wiring.test.ts
// 同款警告），每条用例后必须还原。

import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { setIntentLLM, intentLLMConfigured } from "../llm/intent";
import { setNarratorLLM } from "../llm/narrator";
import { log } from "../log";
import { GameSession } from "../api/game-session";

const REAL_LOOKING = {
  apiKey: "sk-test-not-a-placeholder", baseUrl: "http://127.0.0.1:1",
  model: "m", maxTokens: 16, temperature: 0,
};
const PLACEHOLDER = { ...REAL_LOOKING, apiKey: "sk-placeholder" };

const ENV_KEYS = ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  setIntentLLM(null);
  setNarratorLLM(null);
});
afterEach(() => {
  setIntentLLM(null);
  setNarratorLLM(null);
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

/**
 * 只挑 declareIntentPath 打的那条声明——scope==="intent" 底下还有上一轮
 * 加的"LLM 调用失败/返回非法 JSON"两条 warn，那两条是每次解析失败都可能
 * 打的（与本任务的"一局一次起手声明"是不同的东西），必须用消息前缀分开，
 * 不能只按 scope 过滤。
 */
function intentCalls(spy: ReturnType<typeof spyOn>) {
  return spy.mock.calls.filter((c: any[]) => c[0] === "intent" && String(c[1]).startsWith("本局意图解析"));
}

describe("declareIntentPath —— 起手声明，从日志能唯一反推走的哪条路", () => {
  test("**正确**：LLM 已配置 → 恰好一条 info，明确指向 LLM 路，零条 warn", () => {
    enableLLM();
    const infoSpy = spyOn(log, "info");
    const warnSpy = spyOn(log, "warn");
    new GameSession(`dip1-${Math.random()}`, "cosmic-horror", REAL_LOOKING);
    const infoCalls = intentCalls(infoSpy);
    const warnCalls = intentCalls(warnSpy);
    infoSpy.mockRestore();
    warnSpy.mockRestore();

    // 会话用自己的 client；这里仍为 false 正是 CLI 全局状态没有被会话污染的证据。
    expect(intentLLMConfigured()).toBe(false);
    expect(infoCalls.length).toBe(1);
    expect(warnCalls.length).toBe(0);
    expect(infoCalls[0][1]).toContain("LLM");
  });

  test("**正确**：LLM_DISABLED=true → 恰好一条 warn，明确指向 regex 路且带上原因，零条 info", () => {
    enableLLM();
    process.env.LLM_DISABLED = "true";
    const infoSpy = spyOn(log, "info");
    const warnSpy = spyOn(log, "warn");
    new GameSession(`dip2-${Math.random()}`, "cosmic-horror", REAL_LOOKING);
    const infoCalls = intentCalls(infoSpy);
    const warnCalls = intentCalls(warnSpy);
    infoSpy.mockRestore();
    warnSpy.mockRestore();

    expect(intentLLMConfigured()).toBe(false);
    expect(warnCalls.length).toBe(1);
    expect(infoCalls.length).toBe(0);
    expect(warnCalls[0][1]).toContain("regex");
    expect(warnCalls[0][1]).toContain("llmEnabled");
  });

  test("**正确**：占位 key（llmEnabled 为真但接缝未配置）→ 恰好一条 warn，原因与「llmEnabled 为假」那种不同措辞", () => {
    enableLLM(); // llmEnabled() 为真（有看起来真实的 env key）
    const warnSpy = spyOn(log, "warn");
    new GameSession(`dip3-${Math.random()}`, "cosmic-horror", PLACEHOLDER); // 但这局自己传的是占位 key
    const warnCalls = intentCalls(warnSpy);
    warnSpy.mockRestore();

    expect(intentLLMConfigured()).toBe(false);
    expect(warnCalls.length).toBe(1);
    // 两种"没接上"的原因必须能从文本分开——不是同一句话
    expect(warnCalls[0][1]).not.toContain("llmEnabled() 为 false");
    expect(warnCalls[0][1]).toContain("接缝未配置");
  });

  test("**错误行为红线**：从日志能唯一反推走的哪条路——两种场景的 info/warn 组合不会混淆", () => {
    // 场景一：配置了
    enableLLM();
    const spy1info = spyOn(log, "info");
    const spy1warn = spyOn(log, "warn");
    new GameSession(`dip4a-${Math.random()}`, "cosmic-horror", REAL_LOOKING);
    const case1 = { info: intentCalls(spy1info).length, warn: intentCalls(spy1warn).length };
    spy1info.mockRestore(); spy1warn.mockRestore();
    setIntentLLM(null); // 还原，进入下一场景

    // 场景二：没配置
    process.env.LLM_DISABLED = "true";
    const spy2info = spyOn(log, "info");
    const spy2warn = spyOn(log, "warn");
    new GameSession(`dip4b-${Math.random()}`, "cosmic-horror", REAL_LOOKING);
    const case2 = { info: intentCalls(spy2info).length, warn: intentCalls(spy2warn).length };
    spy2info.mockRestore(); spy2warn.mockRestore();

    // 两种场景的 (info条数, warn条数) 组合必须不同，才谈得上"唯一反推"
    expect(case1).not.toEqual(case2);
    expect(case1).toEqual({ info: 1, warn: 0 });
    expect(case2).toEqual({ info: 0, warn: 1 });
  });

  test("**正确**：正常回合数不因此增加日志行——act() 跑多轮，声明只在构造时打一次", async () => {
    enableLLM();
    const session = new GameSession(`dip5-${Math.random()}`, "cosmic-horror", REAL_LOOKING);
    const warnSpy = spyOn(log, "warn");
    const infoSpy = spyOn(log, "info");
    await session.act("创建角色 investigator 甲");
    await session.act("看看四周");
    await session.act("看看四周");
    const totalIntentLogs = intentCalls(warnSpy).length + intentCalls(infoSpy).length;
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    // 构造已经打过一次（不在这个 spy 窗口内），三轮 act() 期间不应该再新增
    expect(totalIntentLogs).toBe(0);
  });
});
