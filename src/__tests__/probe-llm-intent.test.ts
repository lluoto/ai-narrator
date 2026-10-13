import { describe, expect, it } from "bun:test";
import type { LLMConfig } from "../config";
import { LLMClient } from "../llm/client";
import {
  createRequiredProbeSession,
  runResultCase,
  type ResultCase,
} from "../../scripts/diag/probe-llm-intent";

const ENV_KEYS = ["LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "LLM_DISABLED", "LLM_MODE"] as const;

function completion(action: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action }) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("probe-llm-intent diagnostic session wiring", () => {
  it("does not construct result simulations with the placeholder/offline session config", async () => {
    const source = await Bun.file(new URL("../../scripts/diag/probe-llm-intent.ts", import.meta.url)).text();

    // This static contract prevents reintroducing a private fake endpoint.
    // The factory test below verifies the import-safe diagnostic forwards the
    // config that main() already loaded for its server-side model client.
    expect(source).not.toContain("const SESSION_CFG");
    expect(source).toContain("const disabled = llmDisabledByOverride();");
  });

  it("uses the diagnostic's loaded config internally and refuses natural language when its model client is unavailable", async () => {
    const config: LLMConfig = {
      // The placeholder is deliberately unusable, so this test cannot make a
      // network request even when the developer has an ECNU API configured.
      apiKey: "sk-placeholder",
      baseUrl: "https://ecnu.example.test/v1",
      model: "ecnu-intent-test",
      maxTokens: 77,
      temperature: 0.25,
    };
    const session = createRequiredProbeSession("probe-config-forwarding", config);

    const response = await session.act("我想仔细检查房间里的血迹");
    expect(response.error).toEqual({
      code: "intent_model_unavailable",
      intentErrorCode: "intent_client_unavailable",
    });
    expect(response.state.round).toBe(0);
  });

  it("runs the result simulation through its configured API client instead of a regex fallback", async () => {
    const config: LLMConfig = {
      apiKey: "sk-probe-test-key",
      baseUrl: "https://ecnu-probe.invalid/v1",
      model: "ecnu-probe-model",
      maxTokens: 77,
      temperature: 0.25,
    };
    const resultCase: ResultCase = {
      kind: "result",
      input: "打开冰箱",
      wantClueId: "clue_control_supplies",
    };
    const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const savedFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    for (const key of ENV_KEYS) delete process.env[key];
    LLMClient.resetDefeat();
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return completion("unknown");
    }) as typeof fetch;

    try {
      const result = await runResultCase(resultCase, config, new LLMClient(config));
      expect(result).toEqual({
        got: "action=unknown, discovered=true",
        ok: true,
      });
    } finally {
      globalThis.fetch = savedFetch;
      LLMClient.resetDefeat();
      for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(requests).toHaveLength(2);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://ecnu-probe.invalid/v1/chat/completions",
      "https://ecnu-probe.invalid/v1/chat/completions",
    ]);
    for (const { body } of requests) expect(body.model).toBe(config.model);
  });
});
