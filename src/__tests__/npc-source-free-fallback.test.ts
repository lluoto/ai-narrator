import { describe, expect, it } from "bun:test";
import { NPCAgent } from "../agent/npc-agent";
import { DEFAULT_NPC_TRAITS } from "../agent/types";
import type { NPCMood, NPCPersonality } from "../agent/types";
import type { LLMLike } from "../llm/client";

const offlineLLM: LLMLike = {
  async chat(): Promise<string> {
    throw new Error("offline for fallback test");
  },
};

const RANDOM_SLOTS = [0, 0.24, 0.49, 0.74, 0.99];

function makeNPC(overrides: Partial<NPCPersonality> = {}): NPCPersonality {
  return {
    name: "林娜",
    role: "酒吧保镖",
    personality: "普通",
    background: "来源测试不应泄露这个背景",
    goals: ["来源测试不应泄露这个目标"],
    speech_style: "正常",
    knowledge: ["来源测试不应泄露这条知识"],
    secrets: ["来源测试不应泄露这个秘密"],
    traits: { ...DEFAULT_NPC_TRAITS },
    ...overrides,
  };
}

async function withRandom<T>(value: number, fn: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = () => value;
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

function expectSourceFree(text: string, role: string): void {
  expect(text.trim().length).toBeGreaterThan(0);
  // 离线模板没有模组上下文：不能伪造地点、威胁、线索或 NPC 职业自报。
  expect(text).not.toContain(role);
  expect(text).not.toMatch(/谷仓|那个声音|声音又来了|它们能听到|黑暗中|有什么东西|有人在看|闻到什么味道|发生过什么事|某个方向/);
}

describe("NPCAgent source-free offline fallbacks", () => {
  it("keeps every mood, trait, and random reply slot free of invented scene facts or role labels", async () => {
    const cases: Array<{
      initialMood: NPCMood;
      personality?: string;
      speech_style?: string;
      traits?: NPCPersonality["traits"];
      relationship?: number;
    }> = [
      { initialMood: "neutral" },
      { initialMood: "friendly" },
      { initialMood: "angry" },
      { initialMood: "fearful" },
      { initialMood: "suspicious" },
      { initialMood: "excited" },
      { initialMood: "sad" },
      { initialMood: "calm" },
      { initialMood: "neutral", personality: "紧张" },
      { initialMood: "neutral", personality: "沉默" },
      { initialMood: "neutral", personality: "热情" },
      { initialMood: "neutral", traits: { ...DEFAULT_NPC_TRAITS, courage: 3 } },
      { initialMood: "neutral", traits: { ...DEFAULT_NPC_TRAITS, friendliness: 7 } },
      { initialMood: "neutral", relationship: -2 },
      { initialMood: "neutral", relationship: 3 },
    ];

    for (const testCase of cases) {
      for (const random of RANDOM_SLOTS) {
        const agent = new NPCAgent(makeNPC(testCase), offlineLLM);
        if (testCase.relationship) agent.adjustRelationship(testCase.relationship);
        const reply = await withRandom(random, () => agent.respond("玩家提出了一个没有场景事实的问题。"));
        expectSourceFree(reply, "酒吧保镖");
      }
    }
  });

  it("keeps every proactive fallback branch and random slot source-free", async () => {
    const cases: Array<Pick<NPCPersonality, "initialMood" | "personality" | "speech_style" | "traits">> = [
      { initialMood: "neutral", personality: "普通", speech_style: "正常" },
      { initialMood: "friendly", personality: "普通", speech_style: "正常" },
      { initialMood: "angry", personality: "普通", speech_style: "正常" },
      { initialMood: "fearful", personality: "普通", speech_style: "正常" },
      { initialMood: "suspicious", personality: "普通", speech_style: "正常" },
      { initialMood: "excited", personality: "普通", speech_style: "正常" },
      { initialMood: "sad", personality: "普通", speech_style: "正常" },
      { initialMood: "calm", personality: "普通", speech_style: "正常" },
      { initialMood: "neutral", personality: "紧张", speech_style: "正常" },
      { initialMood: "neutral", personality: "沉默", speech_style: "正常" },
      { initialMood: "neutral", personality: "普通", speech_style: "正常", traits: { ...DEFAULT_NPC_TRAITS, courage: 3 } },
      { initialMood: "neutral", personality: "普通", speech_style: "正常", traits: { ...DEFAULT_NPC_TRAITS, friendliness: 7 } },
    ];

    for (const testCase of cases) {
      for (const random of RANDOM_SLOTS) {
        const agent = new NPCAgent(makeNPC(testCase), offlineLLM);
        const reply = await withRandom(random, () => agent.speakUp("无场景事实的调度信号"));
        expectSourceFree(reply, "酒吧保镖");
      }
    }
  });

  it("does not stutter or use a role label when the era guard returns a safe reply", async () => {
    const modernReply: LLMLike = { async chat() { return "我会用手机联系他。"; } };
    const agent = new NPCAgent(makeNPC(), modernReply);
    const reply = await withRandom(0.99, () => agent.respond("请联系他", [], { ruleset: "cosmic-horror" }));

    expect(reply).not.toContain("我我这个");
    expect(reply).not.toContain("酒吧保镖");
  });

  it("keeps the fabricated-character retry fallback neutral and source-free", async () => {
    let calls = 0;
    const stubbornLLM: LLMLike = {
      async chat(): Promise<string> {
        calls++;
        return "老板已经把名单锁进抽屉了。";
      },
    };

    for (const random of [0, 0.3, 0.6, 0.99]) {
      const agent = new NPCAgent(makeNPC(), stubbornLLM);
      const reply = await withRandom(random, () => agent.respond("名单的事", [], {
        sceneId: "weisen_bar",
        sceneFabricableCharacterNouns: ["老板"],
      }));
      expectSourceFree(reply, "酒吧保镖");
      expect(reply).not.toMatch(/谁经手|有人管|替人家|不归我管|老板|抽屉/);
    }
    expect(calls).toBe(8); // 每轮第一次生成 + 约束要求的一次重生成
  });
});
