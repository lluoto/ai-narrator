import { GameSession } from "../api/game-session";
import { LLMClient } from "../llm/client";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const ENV_KEYS = [
  "LLM_DISABLED",
  "LLM_MODE",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_MAX_TOKENS",
  "LLM_TEMPERATURE",
] as const;

type EnvironmentKey = (typeof ENV_KEYS)[number];
export type OverrideScenario = "disabled-opening" | "template-opening" | "explicit-opening" | "registry";
export type OverrideProof = {
  fetchCalls: string[];
  opening?: string;
  registered?: boolean;
  dialogue?: boolean;
};

function providerCompletion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function withDefaultSessionEnvironment(
  override: Partial<Pick<Record<EnvironmentKey, string>, "LLM_DISABLED" | "LLM_MODE">>,
  run: (fetchCalls: string[]) => Promise<Omit<OverrideProof, "fetchCalls">>,
): Promise<OverrideProof> {
  const savedEnvironment = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<EnvironmentKey, string | undefined>;
  const savedFetch = globalThis.fetch;
  const fetchCalls: string[] = [];

  for (const key of ENV_KEYS) delete process.env[key];
  process.env.LLM_API_KEY = "sk-game-session-override-test";
  process.env.LLM_BASE_URL = "https://game-session-override.invalid/v1";
  process.env.LLM_MODEL = "override-test-model";
  Object.assign(process.env, override);
  LLMClient.resetDefeat();
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    return providerCompletion("provider opening scene");
  }) as typeof fetch;

  try {
    return { fetchCalls, ...await run(fetchCalls) };
  } finally {
    globalThis.fetch = savedFetch;
    LLMClient.resetDefeat();
    for (const key of ENV_KEYS) {
      const value = savedEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function runIsolatedOverrideScenario(scenario: OverrideScenario): Promise<OverrideProof> {
  switch (scenario) {
    case "disabled-opening":
      return withDefaultSessionEnvironment({ LLM_DISABLED: "true" }, async () => {
        const session = new GameSession("llm-disabled-opening", "cosmic-horror");
        try {
          await session.getOpeningScene();
          return {};
        } finally {
          session.close();
        }
      });
    case "template-opening":
      return withDefaultSessionEnvironment({ LLM_MODE: "template" }, async () => {
        const session = new GameSession("llm-template-opening", "cosmic-horror");
        try {
          await session.getOpeningScene();
          return {};
        } finally {
          session.close();
        }
      });
    case "explicit-opening":
      return withDefaultSessionEnvironment({}, async () => {
        const session = new GameSession("llm-explicit-opening", "cosmic-horror", {
          apiKey: "sk-explicit-session-config",
          baseUrl: "https://explicit-session-config.invalid/v1",
          model: "explicit-opening-model",
          maxTokens: 600,
          temperature: 0.7,
        });
        try {
          return { opening: await session.getOpeningScene() };
        } finally {
          session.close();
        }
      });
    case "registry":
      return withDefaultSessionEnvironment({ LLM_DISABLED: "true" }, async () => {
        const session = new GameSession("llm-disabled-registry", "cosmic-horror");
        try {
          await session.getOpeningScene();
          await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3");
          const registered = activateRegisteredGameSessionSceneForTest(session, "\u7279\u91cc\u574e\u5bb6")
            && session.registry.has("\u83f2\u78a7\u00b7\u7279\u91cc\u574e");
          const response = await session.act("\u8ddf\u83f2\u78a7\u8bf4\u8bdd");
          return {
            registered,
            dialogue: response.events.some((event) => event.speaker === "\u83f2\u78a7\u00b7\u7279\u91cc\u574e" && event.type === "dialogue"),
          };
        } finally {
          session.close();
        }
      });
  }
}

type WorkerScope = {
  postMessage(message: { status: "ok"; proof: OverrideProof } | { status: "error"; message: string }): void;
  addEventListener(type: "message", listener: (event: { data: OverrideScenario }) => void | Promise<void>): void;
};

const workerScope = globalThis as typeof globalThis & Partial<WorkerScope>;

if (typeof workerScope.postMessage === "function" && typeof workerScope.addEventListener === "function") {
  const scope = workerScope as typeof globalThis & WorkerScope;
  scope.addEventListener("message", async (event) => {
    try {
      scope.postMessage({ status: "ok", proof: await runIsolatedOverrideScenario(event.data) });
    } catch (error) {
      scope.postMessage({ status: "error", message: error instanceof Error ? error.message : "LLM override child failed" });
    }
  });
}
