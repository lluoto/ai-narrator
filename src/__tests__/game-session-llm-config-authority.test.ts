import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { LLMClient } from "../llm/client";

const ENV_KEYS = ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] as const;

function suppliedConfig() {
  return {
    apiKey: "sk-session-config-canonical",
    baseUrl: "https://canonical-config.invalid/v1",
    model: "canonical-intent-model",
    maxTokens: 17,
    temperature: 0.25,
  };
}

function completion(action: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ action }) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function mutateSuppliedConfig(config: ReturnType<typeof suppliedConfig>): void {
  config.apiKey = "sk-mutated-caller-key";
  config.baseUrl = "https://mutated-config.invalid/v1";
  config.model = "mutated-model";
  config.maxTokens = 9;
  config.temperature = 0.9;
}

describe("GameSession LLM configuration authority", () => {
  it("does not reflect its LLM config or API key through the session surface", () => {
    const supplied = suppliedConfig();
    const session = new GameSession("llm-config-authority-surface", "cosmic-horror", supplied);
    try {
      mutateSuppliedConfig(supplied);
      const observer = session as unknown as Record<string, unknown>;
      expect(observer.config).toBeUndefined();
      expect(Reflect.ownKeys(session)).not.toContain("config");
      expect(Reflect.ownKeys(Object.getPrototypeOf(session))).not.toContain("config");
      expect(Object.values(session)).not.toContain("sk-session-config-canonical");

      Object.defineProperty(session, "config", {
        configurable: true,
        value: { apiKey: "sk-public-shadow" },
      });
      expect(observer.config).toEqual({ apiKey: "sk-public-shadow" });
    } finally {
      session.close();
    }
  });

  it("keeps real intent requests on the construction-time config after caller alias mutation", async () => {
    const savedEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const savedFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const supplied = suppliedConfig();
    let session: GameSession | undefined;
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.LLM_API_KEY = "sk-environment-enables-intent";
    LLMClient.resetDefeat();
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return completion("help");
    }) as typeof fetch;

    try {
      session = new GameSession("llm-config-authority-provider", "cosmic-horror", supplied);
      mutateSuppliedConfig(supplied);
      Object.defineProperty(session, "config", {
        configurable: true,
        get: () => { throw new Error("public config shadow was used"); },
      });

      const response = await session.act("Describe the unfamiliar room in a useful way.");
      expect(response.state.round).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "https://canonical-config.invalid/v1/chat/completions",
        body: { model: "canonical-intent-model", max_tokens: 128, temperature: 0.1 },
      });
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer sk-session-config-canonical");
    } finally {
      if (session) {
        delete (session as unknown as Record<string, unknown>).config;
        session.close();
      }
      globalThis.fetch = savedFetch;
      LLMClient.resetDefeat();
      for (const key of ENV_KEYS) {
        const value = savedEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("does not publish a raw llm, and a same-name shadow cannot redirect session intent", async () => {
    const savedEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const savedFetch = globalThis.fetch;
    const requests: string[] = [];
    let session: GameSession | undefined;
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.LLM_API_KEY = "sk-environment-enables-intent";
    LLMClient.resetDefeat();
    globalThis.fetch = (async (input: unknown) => {
      requests.push(String(input));
      return completion("help");
    }) as typeof fetch;

    try {
      session = new GameSession("llm-config-authority-shadow", "cosmic-horror", suppliedConfig());
      expect(Reflect.ownKeys(session)).not.toContain("llm");
      expect((session as unknown as Record<string, unknown>).llm).toBeUndefined();
      Object.defineProperty(session, "llm", {
        configurable: true,
        value: { chat: async () => { throw new Error("public llm shadow was used"); } },
      });

      const response = await session.act("Describe the unfamiliar room in a useful way.");
      expect(response.state.round).toBe(1);
      expect(requests).toEqual(["https://canonical-config.invalid/v1/chat/completions"]);
    } finally {
      if (session) {
        delete (session as unknown as Record<string, unknown>).llm;
        session.close();
      }
      globalThis.fetch = savedFetch;
      LLMClient.resetDefeat();
      for (const key of ENV_KEYS) {
        const value = savedEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
