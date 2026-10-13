import { describe, expect, it, spyOn } from "bun:test";
import { GameSession } from "../api/game-session";
import type { LLMClient } from "../llm/client";
import { log } from "../log";

const OFFLINE_CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://127.0.0.1:1",
  model: "test-model",
  maxTokens: 32,
  temperature: 0,
};

function fakeIntentClient(action: string): { client: Pick<LLMClient, "chat">; calls: () => number } {
  let callCount = 0;
  return {
    client: {
      async chat() {
        callCount++;
        return JSON.stringify({ action });
      },
    },
    calls: () => callCount,
  };
}

function requiredSession(id: string, runtimeDependencies?: Record<string, unknown>): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    OFFLINE_CONFIG,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "required",
    runtimeDependencies as any,
  );
}

describe("GameSession intent authority stays session-private", () => {
  it.each(["assignment", "defineProperty"])("a %s shadow cannot downgrade a required unavailable client into a stateful regex/model turn", async (attack) => {
    const session = requiredSession(`intent-private-required-${attack}-${crypto.randomUUID()}`);
    const attacker = fakeIntentClient("status");
    const before = session.getState();

    if (attack === "assignment") {
      (session as any).intentLLM = attacker.client;
      (session as any).intentPolicy = "preferred";
    } else {
      Object.defineProperty(session, "intentLLM", { value: attacker.client, writable: true, configurable: true });
      Object.defineProperty(session, "intentPolicy", { value: "preferred", writable: true, configurable: true });
    }

    const result = await session.act("opaque-private-intent-command");

    expect(result).toMatchObject({
      events: [],
      error: { code: "intent_model_unavailable", intentErrorCode: "intent_client_unavailable" },
    });
    expect(attacker.calls()).toBe(0);
    expect(result.state.round).toBe(before.round);
    expect(session.round).toBe(before.round);
    expect(session.getPlayerHistory("p1")).toEqual({ messages: [], total: 0 });
    expect(session.getState()).toEqual(before);
  });

  it.each(["assignment", "defineProperty"])("a %s shadow cannot replace the canonical injected session client", async (attack) => {
    const canonical = fakeIntentClient("status");
    const attacker = fakeIntentClient("help");
    const session = requiredSession(`intent-private-client-${attack}-${crypto.randomUUID()}`, {
      sessionIntentClient: canonical.client,
    });
    const trace = spyOn(log, "debug");
    try {
      if (attack === "assignment") {
        (session as any).intentLLM = attacker.client;
      } else {
        Object.defineProperty(session, "intentLLM", { value: attacker.client, writable: true, configurable: true });
      }

      const result = await session.act("opaque-private-intent-command");

      expect(result.error).toBeUndefined();
      expect(result.state.round).toBe(1);
      expect(result.narrative).toContain("HP:");
      expect(result.events.some((event) => event.content.includes("HP:"))).toBe(true);
      expect(session.getPlayerHistory("p1").total).toBeGreaterThan(0);
      expect(canonical.calls()).toBe(1);
      expect(attacker.calls()).toBe(0);
      const traces = trace.mock.calls
        .filter((call: unknown[]) => call[0] === "intent-trace")
        .map((call: unknown[]) => String(call[1]));
      expect(traces.some((line) => line.includes("provenance=model") && line.includes("action=status"))).toBe(true);
      expect(traces.some((line) => line.includes("route=intent action=status"))).toBe(true);
      expect(traces.some((line) => line.includes("action=help"))).toBe(false);
    } finally {
      trace.mockRestore();
    }
  });
});
