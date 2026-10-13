import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KPAgent } from "../agent/kp-agent";
import { NPCAgent } from "../agent/npc-agent";
import type { NPCPersonality, KPDirective } from "../agent/types";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { LLMClient } from "../llm/client";
import { generateNarrativeWithLLM } from "../llm/narrator";

const ENV_KEYS = ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] as const;
const originalEnvironment = new Map<string, string | undefined>();
let originalFetch: typeof fetch;

function client(name: string): LLMClient {
  return new LLMClient({
    apiKey: "sk-ordinary-durable-single-attempt",
    baseUrl: `http://ordinary-durable-single-attempt-${name}.test/v1`,
    model: "ordinary-durable-single-attempt",
    maxTokens: 64,
    temperature: 0,
  });
}

function directive(): KPDirective {
  return {
    scene_description: "A quiet room",
    scene_elements: [],
    plot_nodes: [],
    current_phase: "exploration",
    style: "standard",
  };
}

const NPC: NPCPersonality = {
  name: "Witness",
  role: "witness",
  personality: "careful",
  background: "saw the scene",
  goals: ["stay safe"],
  speech_style: "brief",
  knowledge: ["nothing certain"],
  secrets: [],
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  for (const key of ENV_KEYS) originalEnvironment.set(key, process.env[key]);
  delete process.env.LLM_DISABLED;
  delete process.env.LLM_MODE;
  process.env.LLM_API_KEY = "sk-ordinary-durable-single-attempt";
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  LLMClient.resetDefeat();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  LLMClient.resetDefeat();
  for (const key of ENV_KEYS) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvironment.clear();
});

function recordFailures(kind: "http" | "timeout"): Array<{ method: string | undefined; url: string }> {
  const posts: Array<{ method: string | undefined; url: string }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    posts.push({ method: init?.method, url: String(url) });
    if (kind === "timeout") throw new DOMException("simulated timeout", "AbortError");
    return new Response("temporary provider failure", { status: 500 });
  }) as typeof fetch;
  return posts;
}

describe("ordinary durable action provider attempt budget", () => {
  it("fails closed before an ordinary durable candidate mutates when its real intent client gets HTTP 500", async () => {
    const posts = recordFailures("http");
    const capability = {};
    const config = {
      apiKey: "sk-ordinary-durable-single-attempt",
      baseUrl: "http://ordinary-durable-single-attempt-intent.test/v1",
      model: "ordinary-durable-single-attempt",
      maxTokens: 64,
      temperature: 0,
    };
    const session = new GameSession(
      `ordinary-durable-single-attempt-intent-${crypto.randomUUID()}`,
      "cosmic-horror",
      config,
      "investigator",
      "Ada",
      undefined,
      undefined,
      undefined,
      "required",
      {
        ordinaryDurableHostCapability: capability,
        sessionIntentClient: client("intent"),
      },
    );
    try {
      const before = session.getState();
      const historyBefore = session.getHistory().total;
      const result = await runOrdinaryDurableActionTransaction(session, capability, async (act) =>
        act("Describe the room"),
      );

      expect(posts).toHaveLength(1);
      expect(posts[0]).toEqual({ method: "POST", url: "http://ordinary-durable-single-attempt-intent.test/v1/chat/completions" });
      expect(result.error).toEqual({ code: "intent_model_unavailable", intentErrorCode: "intent_http_error" });
      expect(session.round).toBe(before.round);
      expect(session.getState().gameTime).toEqual(before.gameTime);
      expect(session.getHistory().total).toBe(historyBefore);
    } finally {
      session.close();
    }
  });

  it("does not implicitly retry the KP narration provider call after a temporary HTTP failure", async () => {
    const posts = recordFailures("http");
    const kp = new KPAgent(directive(), client("kp"));

    const narration = await kp.narrateOutcome("inspect", "nothing changes");

    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe("POST");
    expect(narration.length).toBeGreaterThan(0);
  });

  it("does not implicitly retry the NPC dialogue provider call after a transport timeout", async () => {
    const posts = recordFailures("timeout");
    const npc = new NPCAgent(NPC, client("npc"));

    const reply = await npc.respond("What did you see?");

    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe("POST");
    expect(reply.length).toBeGreaterThan(0);
    expect(npc.getRecentMemories()).toEqual([]);
  });

  it("does not implicitly retry combat narration after a transport timeout", async () => {
    const posts = recordFailures("timeout");

    const narration = await generateNarrativeWithLLM(
      client("combat"), "Ada", "Cultist", "fist",
      { hit: true, crit: false, damage: 2, result: "wound" }, 10,
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe("POST");
    expect(narration.length).toBeGreaterThan(0);
  });
});
