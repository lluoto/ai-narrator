import { describe, expect, it } from "bun:test";
import { NPCAgent } from "../agent/npc-agent";
import type { NPCPersonality } from "../agent/types";
import type { LLMLike } from "../llm/client";

const FABRICATED_PRIOR_REPLY = "我记得是十五天前那个周二晚上，他在书房看书，早上也没吃早餐。";

const PHOEBE: NPCPersonality = {
  name: "菲碧·特里坎",
  role: "银行职员",
  personality: "焦虑但克制",
  background: "儿子失踪半个多月。",
  goals: ["找回儿子"],
  speech_style: "直接、克制",
  knowledge: ["我已经半个多月没有他的消息了……"],
  secrets: ["等待警方电话"],
};

describe("NPCAgent memory provenance in prompts", () => {
  it("keeps dialogue, observations, events, and recent messages as non-factual continuity for respond and speakUp", async () => {
    const prompts: string[][] = [];
    const llm: LLMLike = {
      chat: async (messages) => {
        prompts.push(messages.map((message) => message.content));
        return FABRICATED_PRIOR_REPLY;
      },
    };
    const agent = new NPCAgent(PHOEBE, llm);

    await agent.respond("第一次询问儿子的去向。");
    agent.remember({
      timestamp: 1,
      type: "observation",
      content: "玩家说院子里有一辆黑车。",
      importance: 3,
    });
    agent.rememberEvent("玩家声称昨晚听见枪声。", 3);

    await agent.respond("第二次询问。", [{
      speaker: "玩家",
      content: "我听说加比周二去了农场。",
      type: "dialogue",
    }]);
    await agent.speakUp("玩家又看向你。");

    const secondPrompt = prompts[1] ?? [];
    const speakUpPrompt = prompts[2] ?? [];
    const profile = (prompts[0] ?? []).find((content) => content.includes("你的名字: 菲碧·特里坎"));
    const memoryForRespond = secondPrompt.find((content) => content.includes("对话记录（未核实说法"));
    const historyForRespond = secondPrompt.find((content) => content.includes("最近对话记录（未核实说法"));
    const memoryForSpeakUp = speakUpPrompt.find((content) => content.includes("对话记录（未核实说法"));

    expect(profile).toContain("你的身份: 银行职员");
    expect(profile).toContain("背景: 儿子失踪半个多月。");
    expect(profile).toContain("明示的身份、背景及“你知道的信息”均为已给定事实");
    expect(profile).toContain("不得据此推断未明确给出的精确日期、经历或事件");
    expect(memoryForRespond).toContain(`菲碧·特里坎说: "${FABRICATED_PRIOR_REPLY}"`);
    expect(memoryForRespond).toContain("经历记录（仅用于互动连续性；不能据此断定未给定的世界细节）");
    expect(historyForRespond).toContain("[玩家] 我听说加比周二去了农场。");
    expect(memoryForSpeakUp).toContain(`菲碧·特里坎说: "${FABRICATED_PRIOR_REPLY}"`);
    expect(memoryForSpeakUp).toContain("若精确日期、经历或事件并未明确给出，请自然地说不知道或记不清");
    // The test deliberately does not demand removal of the natural reply: this
    // presentation boundary is not a mechanical semantic claim validator.
    expect(agent.getRecentMemories()).toContainEqual(expect.objectContaining({
      type: "dialogue",
      content: `菲碧·特里坎说: "${FABRICATED_PRIOR_REPLY}"`,
    }));
  });
});
