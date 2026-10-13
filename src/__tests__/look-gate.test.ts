// 开发·闸门放宽到 look 任务1验收。
//
// 背景：上一轮把 inventory 提示词改准后，实测（analysis/diag/probe-llm-intent.md，
// model ecnu-plus）容器输入的分类从 inventory 挪到了两档：
//   打开冰箱 / 拉一下拉杆 / 清点冰箱里的东西          → unknown → 闸门接住 → 线索解析 ✓
//   看看储物柜 / 陈岳打开冰箱与储物柜，逐一清点…      → look    → 叙事兜底，拿不到线索 ✗
// 对象名闸门原来只认 intent.action === "unknown"，够不着 look。
//
// 离线 bun test 走的是 regex 回落，这两条容器句子在 regex 下本来就是
// unknown（已被上一轮的闸门接住），不会触发这里要修的 look 路径——必须
// 必须用会话绑定的测试接缝注入一个可控 fake LLM，精确复现“这句话被判成
// look”这个只在 LLM 路径上出现的分类结果。CLI 全局 client 在同一句上被
// 刻意设为相反回答，防止测试静默退成 regex 或重新依赖全局状态。
//
// bun test src/__tests__/look-gate.test.ts

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { GameSession } from "../api/game-session";
import { setIntentLLM, type NormalSessionIntentClient } from "../llm/intent";

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

/** 按输入原文精确匹配，返回指定的 intent JSON——复现"LLM 把这句话判成了 X"。 */
function fakeIntentLLM(mapping: Record<string, Record<string, unknown>>) {
  return {
    chat: async (messages: { role: string; content: string }[]) => {
      const input = messages[messages.length - 1]?.content ?? "";
      const hit = mapping[input];
      return JSON.stringify(hit ?? { action: "unknown" });
    },
    chatStream: async function* () {},
  } as any;
}

/**
 * GameSession must use its own intent client. The CLI/global parser is given a
 * deliberately different answer for every supplied input so these tests cannot
 * pass by accidentally falling back to regex or reading the global singleton.
 */
function makeSessionWithIntentLLM(
  id: string,
  mapping: Record<string, Record<string, unknown>>,
): GameSession & Record<string, any> {
  const session = makeSession(id, fakeIntentLLM(mapping));
  const globalAnswers = Object.fromEntries(
    Object.keys(mapping).map((input) => [input, { action: "help" }]),
  );
  setIntentLLM(fakeIntentLLM(globalAnswers));
  return session;
}

beforeEach(() => {
  setIntentLLM(null);
});
afterEach(() => {
  setIntentLLM(null); // 模块级单例，还原，别影响别的测试文件
});

describe("look 被判成 look 时也能走到线索解析", () => {
  it("端到端：「看看储物柜」（LLM 判成 look）走到线索解析，发现 clue_control_supplies", async () => {
    const session = makeSessionWithIntentLLM(
      `look-gate-${Math.random()}`,
      { "看看储物柜": { action: "look" } },
    );
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("中控室");

    const real = Math.random;
    Math.random = () => 0; // 逼检定成功
    try {
      const res = await session.act("看看储物柜", "p1");
      expect(res.narrative).not.toContain("空荡荡");
      expect(session.investigation.isDiscoveredBy("clue_control_supplies", "p1")).toBe(true);
    } finally { Math.random = real; }
  });

  it("端到端：实跑原句「陈岳打开冰箱与储物柜，逐一清点里面的氧气罐、药品和袋装流食。」（LLM 判成 look）同样发现线索", async () => {
    const said = "陈岳打开冰箱与储物柜，逐一清点里面的氧气罐、药品和袋装流食。";
    const session = makeSessionWithIntentLLM(
      `look-gate-real-sentence-${Math.random()}`,
      { [said]: { action: "look" } },
    );
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("中控室");

    const real = Math.random;
    Math.random = () => 0;
    try {
      const res = await session.act(said, "p1");
      expect(res.narrative).not.toBe("你的背包是空的"); // 上一轮修的 inventory 误判不能借尸还魂
      expect(session.investigation.isDiscoveredBy("clue_control_supplies", "p1")).toBe(true);
    } finally { Math.random = real; }
  });
});

describe("真实场景名仍然按移动处理——场景解析赢在线索匹配之前", () => {
  it("「看看维森酒吧」（LLM 判成 look，target=维森酒吧）移动过去，不被拉去搜索", async () => {
    const session = makeSessionWithIntentLLM(
      `look-gate-scene-${Math.random()}`,
      { "看看维森酒吧": { action: "look", target: "维森酒吧" } },
    );
    await session.act("加载模组 普瑞米尔的谷仓");

    const res = await session.act("看看维森酒吧", "p1");
    expect(session.getDisplayedScene()).toBe("维森酒吧");
    expect(res.narrative).toContain("维森酒吧");
  });
});

describe("环顾四周这类纯 look 不能变味", () => {
  it("「环顾四周」（LLM 判成 look，无 target）不被闸门拦成\"没什么特别的\"", async () => {
    const session = makeSessionWithIntentLLM(
      `look-gate-generic-look-${Math.random()}`,
      { "环顾四周": { action: "look" } },
    );
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("中控室");

    const res = await session.act("环顾四周", "p1");
    // 闸门只在 resolve/ask 时拦截，deny 不算——不该冒出这句话。
    expect(res.narrative).not.toBe("这里没什么特别的");
    expect(session.investigation.isDiscoveredBy("clue_control_supplies", "p1")).toBe(false);
    expect(session.investigation.isDiscoveredBy("clue_control_lever", "p1")).toBe(false);
    expect(res.error).toBeUndefined();
  });
});

describe("对象无关的叙述不发现任何线索（回归，任务无关但验收明确要求）", () => {
  it("「陆川觉得很紧张」不触发任何线索发现", async () => {
    const session = makeSessionWithIntentLLM(
      `look-gate-unrelated-${Math.random()}`,
      { "陆川觉得很紧张": { action: "unknown" } },
    );
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("中控室");

    const res = await session.act("陆川觉得很紧张", "p1");
    expect(session.investigation.isDiscoveredBy("clue_control_supplies", "p1")).toBe(false);
    expect(session.investigation.isDiscoveredBy("clue_control_lever", "p1")).toBe(false);
    expect(res.error).toBeUndefined();
  });
});

describe("上一轮 unknown 三条输入的行为不受影响（回归）", () => {
  it.each([
    "打开冰箱",
    "拉一下拉杆",
    "清点冰箱里的东西",
  ])("「%s」（LLM 判成 unknown）依旧走到线索解析", async (said) => {
    const session = makeSessionWithIntentLLM(
      `look-gate-unknown-regression-${Math.random()}`,
      { [said]: { action: "unknown" } },
    );
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("中控室");

    const real = Math.random;
    Math.random = () => 0;
    try {
      await session.act(said, "p1");
      const supplies = session.investigation.isDiscoveredBy("clue_control_supplies", "p1");
      const lever = session.investigation.isDiscoveredBy("clue_control_lever", "p1");
      expect(supplies || lever).toBe(true);
    } finally { Math.random = real; }
  });
});
