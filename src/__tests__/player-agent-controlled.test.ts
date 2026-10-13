import { expect, test } from "bun:test";
import { PlayerAgent } from "../agent/player-agent";
import type { LLMLike, Message, ChatOptions } from "../llm/client";

function controlled(llm: LLMLike | null, enabled = true): PlayerAgent {
  const persona = {
    name: "Ada", occupation: "记者", personality: "谨慎而好奇",
    backstory: "她以公开证据为基础采访。", currentGoal: "问清可见线索的来源。", char: {},
  } as ConstructorParameters<typeof PlayerAgent>[0];
  return new PlayerAgent(persona, llm, { isLlmEnabled: () => enabled });
}

test("controlled player decisions use an instance-only exact action contract without recording a proposal", async () => {
  let seen: Message[] = [];
  let options: ChatOptions | undefined;
  const agent = controlled({ async chat(messages, opts) {
    seen = messages; options = opts;
    return JSON.stringify({ action: "我向在场的人问路。" });
  } });
  const signal = new AbortController().signal;
  expect(await agent.decideControlled("公开观察：码头有一名可交谈的人。", { signal, timeoutMs: 1_200 })).toEqual({ status: "decided", action: "我向在场的人问路。" });
  expect(options).toMatchObject({ maxAttempts: 1, maxTokens: 300, timeout: 1_200, jsonMode: true, signal });
  expect(seen[0]?.content).toContain('{"action"');
  expect(seen[1]?.content).toContain("谨慎而好奇");
  expect(seen[1]?.content).not.toContain('"intent"');
  expect(seen[1]?.content).not.toContain("你可以调查的线索");
  expect(agent.getHistory()).toEqual([]);
  expect(agent.getConfirmedHistory()).toEqual([]);
});

test("controlled refusal never consults a legacy global or emits a fallback action", async () => {
  let calls = 0;
  const llm: LLMLike = { async chat() { calls++; throw new Error("private provider detail"); } };
  expect(await controlled(llm, false).decideControlled("公开码头")).toEqual({ status: "refused", code: "disabled" });
  expect(await controlled(null).decideControlled("公开码头")).toEqual({ status: "refused", code: "disabled" });
  const failing = controlled(llm);
  expect(await failing.decideControlled("公开码头")).toEqual({ status: "refused", code: "model_error" });
  expect(calls).toBe(1);
  expect(failing.getConfirmedHistory()).toEqual([]);
});

test("controlled output rejects thoughts, malformed JSON, raw mechanics commands, and overlong actions", async () => {
  for (const response of [
    "我想先问路", JSON.stringify({ action: "我问路。", thoughts: "private reasoning" }),
    JSON.stringify({ action: "@compiled hidden-mechanism" }), JSON.stringify({ action: "问".repeat(1_001) }),
  ]) {
    const agent = controlled({ chat: async () => response });
    expect(await agent.decideControlled("公开码头")).toEqual({ status: "refused", code: "model_invalid" });
    expect(agent.getConfirmedHistory()).toEqual([]);
  }
});

test("controlled cancellation is checked both before dispatch and after a late reply", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  expect(await controlled({ async chat() { calls++; return '{"action":"我问路。"}'; } }).decideControlled("码头", { signal: controller.signal })).toEqual({ status: "refused", code: "aborted" });
  expect(calls).toBe(0);
  const late = new AbortController();
  const agent = controlled({ async chat() { late.abort(); return '{"action":"我问路。"}'; } });
  expect(await agent.decideControlled("码头", { signal: late.signal })).toEqual({ status: "refused", code: "aborted" });
  expect(agent.getConfirmedHistory()).toEqual([]);
});

test("controlled memory stores actual confirmed public results and exposes only detached recent turns", async () => {
  const prompts: string[] = [];
  const agent = controlled({ async chat(messages) { prompts.push(messages[1]!.content); return '{"action":"我询问刚才提到的石头。"}'; } });
  for (let i = 0; i < 4; i++) expect(agent.recordConfirmedTurn(`已提交行动${i}`, `公开结果${i}：新线索已发表。`)).toBeTrue();
  const exposed = agent.getConfirmedHistory();
  exposed[0]!.result = "forged exposed memory";
  await agent.decideControlled("当前公开观察");
  expect(prompts[0]).toContain("公开结果3：新线索已发表。");
  expect(prompts[0]).not.toContain("公开结果0：");
  expect(prompts[0]).not.toContain("forged exposed memory");
  expect(agent.getHistory()).toEqual([]);
});

test("controlled persona is captured, throwing enable policy fails closed, and current legal observation wins the fixed input budget", async () => {
  const persona = { name: "CapturedAda", occupation: "记者", personality: "谨慎", backstory: "公开证据。", currentGoal: "原始目标", char: {} } as ConstructorParameters<typeof PlayerAgent>[0];
  const prompts: string[] = [];
  const llm: LLMLike = { async chat(messages) { prompts.push(messages[1]!.content); return '{"action":"我询问消息。"}'; } };
  const agent = new PlayerAgent(persona, llm, { isLlmEnabled: () => true });
  persona.currentGoal = "MUTATED_PERSONA_GOAL";
  for (let i = 0; i < 3; i++) agent.recordConfirmedTurn(`行动${i}`, `完整公开结果${i}：${"旧".repeat(5_000)}`);
  const observation = `CURRENT_LEGAL_OBSERVATION ${"公开".repeat(7_500)}`;
  expect(await agent.decideControlled(observation)).toEqual({ status: "decided", action: "我询问消息。" });
  expect(prompts[0]).toContain(observation);
  expect(prompts[0]).toContain("原始目标");
  expect(prompts[0]).not.toContain("MUTATED_PERSONA_GOAL");
  expect(prompts[0]).toContain("完整公开结果2：");
  expect(prompts[0]).not.toContain("完整公开结果0：");
  expect(prompts[0]!.length).toBeLessThanOrEqual(24_000);
  const refused = new PlayerAgent(persona, llm, { isLlmEnabled() { throw new Error("PRIVATE_ENABLE_POLICY"); } });
  expect(await refused.decideControlled("码头")).toEqual({ status: "refused", code: "disabled" });
});
