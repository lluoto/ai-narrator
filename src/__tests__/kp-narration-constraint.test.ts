// 开发·意图与约束补漏 任务3，缺口 A——KP 自由叙事接入约束层。
//
// 背景：KPAgent.narrateOutcome 是自由跑团的主叙事路径（game-session.ts
// 里 `this.kp.narrateOutcome(...)`），此前完全没有过约束层检查。
// "冰箱里面空荡荡的，只有几层隔板和后壁"（否认模组已写明"储物柜里有
// 十几瓶氧气罐"的事实）就是从这里出来的，连检查都没经过——见
// analysis/sim/2026-08-31-barn-completion-attempt.md，todo-43。
//
// 用一个可控的假 LLM（实现 LLMLike）而不是 MockLLMClient——需要精确
// 控制"第一次答踩线、第二次答干净"这个序列，MockLLMClient 的模板池
// 不受控制。
//
// bun test src/__tests__/kp-narration-constraint.test.ts

import { describe, it, expect } from "bun:test";
import { KPAgent, KP_NARRATION_UNAVAILABLE_NOTICE } from "../agent/kp-agent";
import type { LLMLike, Message } from "../llm/client";
import type { KPDirective } from "../agent/types";

function directive(overrides: Partial<KPDirective> = {}): KPDirective {
  return {
    scene_description: "中控室",
    scene_elements: [],
    plot_nodes: [],
    current_phase: "exploration",
    style: "standard",
    ...overrides,
  };
}

/** 依次返回给定的一串回复，用完之后固定返回最后一条。 */
class ScriptedLLM implements LLMLike {
  calls: Message[][] = [];
  constructor(private replies: string[]) {}
  async chat(messages: Message[]): Promise<string> {
    this.calls.push(messages);
    const idx = Math.min(this.calls.length - 1, this.replies.length - 1);
    return this.replies[idx];
  }
}

class ThrowingLLM implements LLMLike {
  async chat(): Promise<string> {
    throw new Error("forced provider outage");
  }
}

const UNDISCOVERED_KEYS = ["冰箱与储物柜", "冰箱", "储物柜"];

describe("KPAgent.narrateOutcome 接入约束层", () => {
  it("provider failure only returns an honest notice plus the supplied public outcome", async () => {
    const action = "把口袋里的钥匙插入锁芯并转动";
    const outcome = "检定结果：门锁仍然锁着。";
    for (const scene of ["普瑞米尔的谷仓入口", "曲径旅店大堂"]) {
      const result = await new KPAgent(directive({ scene_description: scene }), new ThrowingLLM())
        .narrateOutcome(action, outcome, []);
      expect(result).toBe(`${KP_NARRATION_UNAVAILABLE_NOTICE}\n\n${outcome}`);
      expect(result).not.toContain(action);
      expect(result).not.toMatch(/寒风|巷子|翻书|线索|攻击/);
    }
  });

  it("provider failure with no public outcome does not manufacture one", async () => {
    const result = await new KPAgent(directive(), new ThrowingLLM()).narrateOutcome("调查柜子", "   ", []);
    expect(result).toBe(KP_NARRATION_UNAVAILABLE_NOTICE);
  });

  it("a successful first response and the existing constraint fallback stay unchanged", async () => {
    const clean = new KPAgent(directive(), new ScriptedLLM(["这里仍需要仔细检查。"]));
    await expect(clean.narrateOutcome("观察", "判定结果", [])).resolves.toBe("这里仍需要仔细检查。");
    const constrained = new KPAgent(directive(), new ScriptedLLM([
      "冰箱里面空荡荡的，只有几层隔板和后壁。",
      "储物柜也是空的，什么都没有。",
    ]));
    const fallback = await constrained.narrateOutcome("打开冰箱与储物柜", "判定结果", [], { undiscoveredClueKeys: UNDISCOVERED_KEYS });
    expect(fallback).not.toContain(KP_NARRATION_UNAVAILABLE_NOTICE);
    expect(fallback).not.toContain("冰箱");
  });

  it("不传 constraintOpts 时行为不变（CLI 侧未改的调用点）——即使文本本身会踩线也不拦，因为没有 undiscoveredClueKeys 可比对", async () => {
    const llm = new ScriptedLLM(["冰箱里面空荡荡的，只有几层隔板和后壁。"]);
    const kp = new KPAgent(directive(), llm);
    const result = await kp.narrateOutcome("打开冰箱与储物柜", "判定结果", []);
    expect(result).toBe("冰箱里面空荡荡的，只有几层隔板和后壁。");
    expect(llm.calls.length).toBe(1); // 没有重生成
  });

  it("命中约束时重生成一次；重生成后的干净回答会被采用", async () => {
    const llm = new ScriptedLLM([
      "冰箱里面空荡荡的，只有几层隔板和后壁。", // 第一次：踩线
      "你打开了冰箱与储物柜，里面似乎还有些东西，需要仔细检查才能看清。", // 第二次：干净
    ]);
    const kp = new KPAgent(directive(), llm);
    const result = await kp.narrateOutcome(
      "打开冰箱与储物柜", "判定结果", [],
      { undiscoveredClueKeys: UNDISCOVERED_KEYS },
    );
    expect(result).toBe("你打开了冰箱与储物柜，里面似乎还有些东西，需要仔细检查才能看清。");
    expect(llm.calls.length).toBe(2); // 确实重生成了
    // 第二次调用带上了纠正指示
    const secondCallLastMsg = llm.calls[1][llm.calls[1].length - 1];
    expect(secondCallLastMsg.content).toContain("空的/没有/已经搜过");
  });

  it("重生成后仍然命中约束——退回不点名任何具体对象的安全兜底，绝不放行踩线的话", async () => {
    const llm = new ScriptedLLM([
      "冰箱里面空荡荡的，只有几层隔板和后壁。",
      "储物柜也是空的，什么都没有。", // 第二次依旧踩线（换了个说法但还是否认同一个对象）
    ]);
    const kp = new KPAgent(directive(), llm);
    const result = await kp.narrateOutcome(
      "打开冰箱与储物柜", "判定结果", [],
      { undiscoveredClueKeys: UNDISCOVERED_KEYS },
    );
    expect(result).not.toContain("空");
    expect(result).not.toContain("冰箱");
    expect(result).not.toContain("储物柜");
    expect(llm.calls.length).toBe(2); // 只重试一次，不无限重试
  });

  it("干净的第一次回答不触发任何重生成", async () => {
    const llm = new ScriptedLLM(["你打开了冰箱与储物柜，需要仔细检查才能看清里面有什么。"]);
    const kp = new KPAgent(directive(), llm);
    const result = await kp.narrateOutcome(
      "打开冰箱与储物柜", "判定结果", [],
      { undiscoveredClueKeys: UNDISCOVERED_KEYS },
    );
    expect(result).toBe("你打开了冰箱与储物柜，需要仔细检查才能看清里面有什么。");
    expect(llm.calls.length).toBe(1);
  });

  it("提到真实场景名（旅店）不该被误拦——即使传了 undiscoveredClueKeys", async () => {
    const llm = new ScriptedLLM(["你走进了旅店，大堂里弥漫着烟草的气味。"]);
    const kp = new KPAgent(directive(), llm);
    const result = await kp.narrateOutcome(
      "前往旅店", "判定结果", [],
      { undiscoveredClueKeys: ["旅店登记簿"] },
    );
    expect(result).toBe("你走进了旅店，大堂里弥漫着烟草的气味。");
    expect(llm.calls.length).toBe(1); // 没有被 dialogue_meta_location 误伤
  });

  it("引擎自己的通用失败播报形状（不点名具体对象）不会被拦——泛指的否认放行", async () => {
    const llm = new ScriptedLLM(["你仔细找了找，这里没什么特别的。"]);
    const kp = new KPAgent(directive(), llm);
    const result = await kp.narrateOutcome(
      "搜索", "判定结果", [],
      { undiscoveredClueKeys: UNDISCOVERED_KEYS },
    );
    expect(result).toBe("你仔细找了找，这里没什么特别的。");
    expect(llm.calls.length).toBe(1);
  });
});
