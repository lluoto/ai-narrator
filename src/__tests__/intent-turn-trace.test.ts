// 开发·每回合意图的可观测性验收。
//
// 背景：analysis/sim/2026-08-31-barn-true-end-abort.md 回合 17，卧室三次
// 自然动作都返回「这里没什么特别的」。离线 decideClueMatch() 对第一句却
// resolve clue_bedroom_diary；实跑 [intent] 回落=0，说明是 LLM 判成了什么
// 不可见，无法倒推。此前日志只知道「这一局走 LLM/regex」和「是否回落」，
// 不知道每一句 action、handler、clue decision、最终是否掉进 KP 叙事。
//
// trace 一律从 log.debug("intent-trace", ...) 发出：默认 info 阈值绝不写
// stdout；LOG_LEVEL=debug 时 debug/info 都进 stdout（server-out.log），而
// 回落 warn 进 stderr（server-err.log），两份文件不可混看。测试不去碰
// console 全局并发状态，而是直接检查 debug 调用的结构化消息与 log.debug
// 自身在默认阈值下的 sink 行为。
//
// bun test src/__tests__/intent-turn-trace.test.ts

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { GameSession } from "../api/game-session";
import { setIntentLLM, type NormalSessionIntentClient } from "../llm/intent";
import { log } from "../log";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 128, temperature: 0,
};

function makeSession(id: string, sessionIntentClient?: NormalSessionIntentClient): GameSession & Record<string, any> {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession(
    id,
    "cosmic-horror",
    CFG,
    "investigator",
    "甲",
    undefined,
    undefined,
    undefined,
    "preferred",
    sessionIntentClient ? { sessionIntentClient } : {},
  ) as any;
}

function traceMessages(spy: ReturnType<typeof spyOn>): string[] {
  return spy.mock.calls
    .filter((call: any[]) => call[0] === "intent-trace")
    .map((call: any[]) => String(call[1]));
}

function fakeIntentLLM(mapping: Record<string, Record<string, unknown>>) {
  return {
    chat: async (messages: { role: string; content: string }[]) => {
      const input = messages[messages.length - 1]?.content ?? "";
      return JSON.stringify(mapping[input] ?? { action: "unknown" });
    },
    chatStream: async function* () {},
  } as any;
}

beforeEach(() => setIntentLLM(null));
afterEach(() => setIntentLLM(null));

describe("每回合 intent-trace", () => {
  it("实跑两句原文（regex）：skill_check 能到线索匹配，read 只到 read handler，路径可直接读出", async () => {
    const session = makeSession(`trace-bedroom-${Math.random()}`);
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("艾德里安的卧室");

    const debugSpy = spyOn(log, "debug");
    await session.act("陆川翻开卧室书桌和床头柜里的纸张，寻找能解释农场地下室用途的日记或旧文件。", "p1");
    await session.act("林娜仔细阅读日记夹页和泛黄文件，确认里面是否写着维修间或培养缸的去向。", "p1");
    const lines = traceMessages(debugSpy);
    debugSpy.mockRestore();

    expect(lines.some((s) => s.includes("action=skill_check"))).toBe(true);
    expect(lines.some((s) => s.includes("route=handler name=skill_check start"))).toBe(true);
    expect(lines.some((s) => s.includes("clue-decision source=skill_check kind=resolve clueId=\"clue_bedroom_diary\""))).toBe(true);
    expect(lines.some((s) => s.includes("action=read"))).toBe(true);
    expect(lines.some((s) => s.includes("route=handler name=read handled=true"))).toBe(true);
    // read 路径没有经过 handleSkillCheck，不能伪造一条 clue decision。
    expect(lines.filter((s) => s.includes("clue-decision source=skill_check")).length).toBe(1);
  });

  it("手工构造 action:look：轨迹能看出 handler 未处理、随后进对象名闸门并命中线索", async () => {
    // CLI/global parser must not choose a GameSession's action. Give it a
    // deliberately different answer so this trace proves the session client won.
    setIntentLLM(fakeIntentLLM({ "看看储物柜": { action: "unknown" } }));
    const session = makeSession(
      `trace-look-${Math.random()}`,
      fakeIntentLLM({ "看看储物柜": { action: "look" } }),
    );
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("中控室");

    const debugSpy = spyOn(log, "debug");
    const real = Math.random;
    Math.random = () => 0;
    try {
      await session.act("看看储物柜", "p1");
    } finally { Math.random = real; }
    const lines = traceMessages(debugSpy);
    debugSpy.mockRestore();

    expect(lines.some((s) => s.includes("action=look"))).toBe(true);
    expect(lines.some((s) => s.includes("route=handler name=look handled=false"))).toBe(true);
    expect(lines.some((s) => s.includes("route=object-gate action=look allowDeny=false"))).toBe(true);
    expect(lines.some((s) => s.includes("clue-decision source=object-gate kind=resolve clueId=\"clue_control_supplies\""))).toBe(true);
    expect(lines.some((s) => s.includes("route=object-gate intercepted=true"))).toBe(true);
  });

  it("unknown 真的落到 KP 叙事时，轨迹给出最后分支但不记录 narrative 正文", async () => {
    const session = makeSession(`trace-narration-${Math.random()}`);
    const debugSpy = spyOn(log, "debug");
    await session.act("我对着空气哼了一段没人听过的调子");
    const lines = traceMessages(debugSpy);
    debugSpy.mockRestore();

    expect(lines.some((s) => s.includes("route=llm-narration action=unknown reason=unknown-fell-through"))).toBe(true);
    expect(lines.some((s) => s.includes("夜色笼罩") || s.includes("你采取了行动"))).toBe(false);
  });
});

it("successful intent traces record only action metadata, not the player input", async () => {
  const playerSecret = "PLAYER_PRIVATE_TRACE_4a8d";
  const session = makeSession(
    `trace-private-${Math.random()}`,
    fakeIntentLLM({ [playerSecret]: { action: "status" } }),
  );
  const debugSpy = spyOn(log, "debug");
  try {
    await session.act(playerSecret);
    const lines = traceMessages(debugSpy);
    expect(lines.some((line) => line.includes("route=intent action=status"))).toBe(true);
    expect(lines.some((line) => line.includes("inputLength="))).toBe(true);
    expect(lines.join("\n")).not.toContain(playerSecret);
  } finally {
    debugSpy.mockRestore();
  }
});

describe("debug 默认不写 stdout", () => {
  it("默认阈值下 intent-trace 的载体 log.debug 不调用 console.log", () => {
    const outSpy = spyOn(console, "log");
    log.debug("intent-trace", "round=999 pc=p1 sentinel");
    expect(outSpy).not.toHaveBeenCalled();
    outSpy.mockRestore();
  });
});
