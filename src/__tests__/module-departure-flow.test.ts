// 开发 A · 任务 4/5 验收 —— 脱离判定 + 确认门 + 结局播报 + 终态。
//
// bun test src/__tests__/module-departure-flow.test.ts

import { describe, it, expect, beforeEach } from "bun:test";
import { GameSession } from "../api/game-session";
import { isExplicitLeaveIntent, isConfirmReply, MODULE_ENDING_SUPPORT } from "../play/module-departure";
import { END_NARRATIONS } from "../module/barn-of-premier";

function makeSession(): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession("departure-test", "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, undefined, "调查员", undefined, undefined, undefined, undefined, { careerEntryPersistence: "transient" });
}

void legacyMakeSession;
function legacyMakeSession(): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession("departure-test", "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, undefined, "调查员");
}

// ── 判据单测：显式离开意图 / 确认回复 ──────────────────────────

describe("isExplicitLeaveIntent —— 只认明确表达，不靠解析失败反推", () => {
  it("**应报**：明确表达离开/结束调查的句子", () => {
    expect(isExplicitLeaveIntent("我们决定离开这里")).toBe(true);
    expect(isExplicitLeaveIntent("结束这次调查，回家吧")).toBe(true);
    expect(isExplicitLeaveIntent("放弃调查，返回家乡")).toBe(true);
    expect(isExplicitLeaveIntent("任务结束，收工回家")).toBe(true);
  });

  it("**不应报**：本仓真实踩过的误判样本——纯调查句不该被当成离开", () => {
    // 实跑真事：这句话被 LLM 判成过"move"，intent.target 却是空字符串
    // （analysis/sim/2026-08-28-barn-long-input-abort.md）。就算被判成
    // move 且解析不出目标，这句话本身也绝不该被判定为"要离开"。
    expect(isExplicitLeaveIntent("陈岳查看餐桌、披萨盒和啤酒罐，找可能的留言或地址。")).toBe(false);
  });

  it("**不应报**：普通移动指令，即使目标解析失败", () => {
    expect(isExplicitLeaveIntent("前往一个含糊不清的地方")).toBe(false);
    expect(isExplicitLeaveIntent("走")).toBe(false);
    expect(isExplicitLeaveIntent("")).toBe(false);
  });
});

describe("isConfirmReply —— 只认清楚的肯定", () => {
  it("**应报**：常见肯定回复", () => {
    for (const s of ["确定", "确认", "是", "对", "走吧", "嗯", "好的", "好"]) {
      expect(isConfirmReply(s)).toBe(true);
    }
  });

  it("**不应报**：否定、含糊、或全新的一句话都按取消处理", () => {
    for (const s of ["不", "不要", "再等等", "我们再查一查", "不确定", "算了吧继续调查"]) {
      expect(isConfirmReply(s)).toBe(false);
    }
  });
});

// ── 集成：确认门的完整往返 ──────────────────────────────────

describe("确认门：显式离开 → 确认 → 进结局；不确认 → 留在原地、不消耗结局", () => {
  let session: GameSession;

  beforeEach(async () => {
    session = makeSession();
    await session.act("加载模组 普瑞米尔的谷仓");
  });

  it("显式离开请求会先问一句确认，不直接结束会话", async () => {
    const res = await session.act("我们决定离开这里，结束这次调查");
    expect(session.dead).toBe(false);
    const asked = res.events.some((e) => e.content.includes("确定要离开"));
    expect(asked).toBe(true);
  });

  it("确认后进入结局：会话置为终态（复用 dead，不造第三种终态）", async () => {
    await session.act("我们决定离开这里，结束这次调查");
    const res = await session.act("确定");
    expect(session.dead).toBe(false);
    expect(res).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
    expect(res.narrative.length).toBeGreaterThan(0);
  });

  it("不确认（含普通新行动）：留在原地，不消耗结局，会话继续", async () => {
    await session.act("我们决定离开这里，结束这次调查");
    const res = await session.act("我们再查一查");
    expect(session.dead).toBe(false);
    const cancelled = res.events.some((e) => e.content.includes("先留下"));
    expect(cancelled).toBe(true);
  });

  it(
    "**误判类输入不得触发结局**：纯调查句被判成移动、解析不出目标，" +
      "既不该问确认，也不该结束会话",
    async () => {
      const res = await session.act("陈岳查看餐桌、披萨盒和啤酒罐，找可能的留言或地址。");
      expect(session.dead).toBe(false);
      const asked = res.events.some((e) => e.content.includes("确定要离开"));
      expect(asked).toBe(false);
    },
  );

  it("模组内正常移动完全不受影响（既有行为的回归判据）", async () => {
    const res = await session.act("前往加比的拖车房");
    expect(session.dead).toBe(false);
    expect(session.getDisplayedScene()).toBe("加比的拖车房");
    const asked = res.events.some((e) => e.content.includes("确定要离开"));
    expect(asked).toBe(false);
  });
});

// ── 集成：结局判定与通用收场 ──────────────────────────────────

describe("确认离开后：谷仓早退 → Normal End 正文", () => {
  it("什么线索都没找到时早退，落到 Normal End（未受干涉的结果，不用另写文案）", async () => {
    const session = makeSession();
    await session.act("加载模组 普瑞米尔的谷仓");
    await session.act("我们决定离开这里，结束这次调查");
    const res = await session.act("确定");
    expect(session.dead).toBe(false);
    expect(res).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
    // Normal End 的文案来自 END_NARRATIONS，不是空播——narrative 有内容。
    expect(res.narrative.trim().length).toBeGreaterThan(0);
    expect(res.events.length).toBeGreaterThan(0);
  });
});

// Good End vs Normal End 判别（修A·任务3）。
//
// 自由跑团路径下只有这两个结局可达：True End 因场景 id 命名空间不对齐
// （todo-34）、Bad End 因 bad_lever_pulled 无生产者，都已记 todo。所以这条
// 是唯一能证明"结局是按状态选的、不是随便播一个"的判据——A轮只测了
// Normal End 一个分支，无法排除"永远播 Normal End"这种退化实现。
//
// clue id 命名空间已核对对齐（见 ending-namespace-truth-source.test.ts），
// Good End 只用 requiredClues/excludeClues，不碰有命名空间缺口的
// requiredScenes，这条测试写得出来。
//
// ⚠ 变异检验做过但没留在这里当断言：先试了"把 evaluateEndNarration 的
// priority 排序去掉"——对下面这个具体状态（只发现 clue_control_supplies）
// 不会变红，因为 END_NARRATIONS 数组的书写顺序恰好是 true→good→bad→
// normal，good 本来就排在 normal 前面，去不去 priority 排序对这一态没有
// 区别（priority 排序真正起作用的是 good/bad 谁赢，这份数据的书写顺序与
// priority 在 good-vs-normal 这个维度上从头到尾就没分歧过，end-narration-
// 32-states.test.ts 已经在测 good/bad 那个真正的分歧点，不必在这里重测
// 同一件事）。换成更贴合"这条到底在防什么"的插桩——把 evaluateEndNarration
// 硬编码成永远返回 Normal End（"随便播一个"的字面实现）——精确命中下面
// 这条测试；Copy-Item 还原后回归绿。
describe("确认离开后：Good End 与 Normal End 判别——按状态选，不是随便播一个", () => {
  const normalNarration = END_NARRATIONS.find((e) => e.id === "normal")!;
  const goodNarration = END_NARRATIONS.find((e) => e.id === "good")!;

  it("发现 clue_control_supplies 且未发现 clue_bedroom_old_doc → Good End", async () => {
    const session = makeSession();
    await session.act("加载模组 普瑞米尔的谷仓");
    // Reach the declared clue through the installed module rather than
    // fabricating it through GameSession's read-only world observation.
    expect((await session.act("前往 中控室")).error).toBeUndefined();
    const realRandom = Math.random;
    Math.random = () => 0;
    try {
      expect((await session.act("打开冰箱与储物柜")).error).toBeUndefined();
    } finally {
      Math.random = realRandom;
    }
    expect(session.investigation.isDiscoveredBy("clue_control_supplies", "p1")).toBe(true);
    // 未发现 clue_bedroom_old_doc（Good End 的 excludeClues）——不做任何事即可。

    await session.act("我们决定离开这里，结束这次调查");
    const res = await session.act("确定");

    expect(session.dead).toBe(false);
    expect(res).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
    expect(res.narrative).toBe(goodNarration.lines.join("\n"));
    // 判别的核心：Good End 与 Normal End 正文必须不同，否则测不出"按状态选"。
    expect(res.narrative).not.toBe(normalNarration.lines.join("\n"));
  });

  it("Normal End 与 Good End 正文互不相同（对照，钉住两条正文本身没有撞车）", () => {
    expect(normalNarration.lines.join("\n")).not.toBe(goodNarration.lines.join("\n"));
  });

});

describe("确认离开后：无 endings 数据的模组走通用收场，不报错不空播", () => {
  it("阿卡姆档案检查目前没有登记结局支持——走通用收场", async () => {
    expect(MODULE_ENDING_SUPPORT["arkham_miskatonic"]).toBeUndefined();
    const session = makeSession();
    await session.act("加载模组 阿卡姆档案检查");
    await session.act("我们决定离开这里，结束这次调查");
    const res = await session.act("确定");
    expect(session.dead).toBe(false);
    expect(res).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
    expect(res.narrative.trim().length).toBeGreaterThan(0);
    expect(res.events.length).toBeGreaterThan(0);
  });

  it(
    "**变异检验**：给阿卡姆临时登记一份结局支持，确认它改走结局分支而不是通用收场",
    async () => {
      const fakeEnding = {
        traumaticClues: {},
        evaluateEnding: () => ({ id: "fake_ending", priority: 0, condition: { requiredClues: [] }, lines: ["【测试用假结局】临时登记验证分支切换。"] }),
        endLabels: { fake_ending: "假结局" },
        encounters: [],
        hubSceneId: "",
      };
      MODULE_ENDING_SUPPORT["arkham_miskatonic"] = fakeEnding as any;
      try {
        const session = makeSession();
        await session.act("加载模组 阿卡姆档案检查");
        await session.act("我们决定离开这里，结束这次调查");
        const res = await session.act("确定");
        expect(session.dead).toBe(false);
        expect(res).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
        const gotFakeEnding = res.events.some((e) => e.content.includes("测试用假结局"));
        expect(gotFakeEnding).toBe(true);
      } finally {
        delete MODULE_ENDING_SUPPORT["arkham_miskatonic"]; // 还原登记表，不污染其它测试
      }
    },
  );
});
