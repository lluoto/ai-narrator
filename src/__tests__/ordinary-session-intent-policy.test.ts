import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import {
  createEnvironmentOrdinaryIntentPolicy,
  handleRequest,
  type SessionRuntimeDependencies,
} from "../api/server";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { LLMClient } from "../llm/client";
import { llmEnabled } from "../llm/enabled";
import { parseOrdinaryLocalCommand } from "../llm/ordinary-local-command";
import { restoreSignedOrdinaryCompanion } from "./helpers/ordinary-companion-fixture";
import {
  NORMAL_SESSION_INTENT_MAX_TOKENS,
  NORMAL_SESSION_INTENT_TIMEOUT_MS,
  type NormalSessionIntentClient,
} from "../llm/intent";

const OWNER = "keeper:ordinary-intent-owner";
const ENV_KEYS = [
  "LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
  "ORDINARY_SESSION_INTENT_POLICY", "NODE_ENV",
] as const;
const savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;

const API_CONFIG = {
  apiKey: "sk-ordinary-intent-test-key",
  baseUrl: "http://ordinary-intent-fake.invalid/v1",
  model: "ordinary-intent-test-model",
  maxTokens: 32,
  temperature: 0,
};
const PLACEHOLDER_CONFIG = { ...API_CONFIG, apiKey: "sk-placeholder" };

function keeper(): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role: "keeper", id: OWNER } });
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function completion(content: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

interface TestRuntime {
  registry: Map<string, GameSession>;
  dependencies: SessionRuntimeDependencies;
}

function testRuntime(
  config: typeof API_CONFIG,
  ordinaryIntentPolicy?: "required" | "development_fallback",
  ordinarySessionIntentClient?: NormalSessionIntentClient,
): TestRuntime {
  const registry = new Map<string, GameSession>();
  const dependencies: SessionRuntimeDependencies = {
    registry,
    ...(ordinaryIntentPolicy ? { ordinaryIntentPolicy } : {}),
    ...(ordinarySessionIntentClient ? { ordinarySessionIntentClient } : {}),
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, sessionIntentClient, runtimeDependencies }) => {
      const session = new GameSession(
        id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy,
        { ...runtimeDependencies, ...(sessionIntentClient ? { sessionIntentClient } : {}) },
      );
      // Creation must not exercise a live narrator in this intent-contract suite.
      session.getOpeningScene = async () => "offline test opening";
      return session;
    },
  };
  return { registry, dependencies };
}

function fakeHostIntentClient(action: string): { client: NormalSessionIntentClient; calls: () => number } {
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

async function request(
  root: string,
  runtime: TestRuntime,
  path: string,
  init: RequestInit,
): Promise<Response> {
  // The durable HTTP contract requires a caller retry token and predecessor
  // generation. Older intent tests are about parser behavior, so provide a
  // deterministic test transport token without weakening their assertions.
  if (path.endsWith("/action") && typeof init.body === "string") {
    try {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      if (typeof parsed.input === "string" && parsed.actionId === undefined && parsed.expectedGeneration === undefined) {
        const id = path.split("/")[3] ?? "unknown";
        const generation = runtime.registry.get(id)?.getOrdinaryDurableIdentity()?.generation ?? 0;
        init = { ...init, body: JSON.stringify({ ...parsed, actionId: `ordinary-intent-${generation.toString().padStart(8, "0")}`, expectedGeneration: generation }) };
      }
    } catch { /* raw/invalid transport cases retain their original body */ }
  }
  return handleRequest(
    new Request(`http://test${path}`, init),
    undefined,
    undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {},
    {},
    keeper(),
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    runtime.dependencies,
  );
}

async function createOrdinary(root: string, runtime: TestRuntime): Promise<{ id: string; session: GameSession }> {
  const response = await request(root, runtime, "/api/sessions", jsonRequest({
    ruleset: "cosmic-horror",
    archetype: "investigator",
    characterName: "Ada",
    // A caller must not be able to weaken the server-owned parser policy.
    intentPolicy: "development_fallback",
  }));
  expect(response.status).toBe(201);
  const body = await response.json() as { sessionId: string };
  const session = runtime.registry.get(body.sessionId);
  expect(session).toBeDefined();
  return { id: body.sessionId, session: session! };
}

function stateDigest(session: GameSession): string {
  return JSON.stringify({
    round: session.round,
    lastActiveAt: session.lastActiveAt,
    state: session.getState(),
    world: session.world.getCurrentState(),
    history: session.getPlayerHistory("p1"),
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedFetch = globalThis.fetch;
  LLMClient.resetDefeat();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  LLMClient.resetDefeat();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("ordinary HTTP session intent contract", () => {
  test("keeps the host-only session intent client through staged actions and durable recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-host-client-"));
    const hostIntent = fakeHostIntentClient("help");
    const runtime = testRuntime(PLACEHOLDER_CONFIG, undefined, hostIntent.client);
    try {
      const { id, session: generationZero } = await createOrdinary(root, runtime);

      const first = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "opaque host intent one" }));
      expect(first.status).toBe(200);
      expect(JSON.stringify(await first.json())).toContain("操作指南");
      expect(hostIntent.calls()).toBe(1);
      expect(runtime.registry.get(id)).not.toBe(generationZero);
      expect(runtime.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });

      const second = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "opaque host intent two" }));
      expect(second.status).toBe(200);
      expect(JSON.stringify(await second.json())).toContain("操作指南");
      expect(hostIntent.calls()).toBe(2);
      expect(runtime.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 2 });
    } finally {
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults to API-required, ignores body policy, and uses the session's explicit config without an environment key", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-required-"));
    const runtime = testRuntime(API_CONFIG);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const timeouts: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timeouts.push(Number(args[1]));
      return originalSetTimeout(...args);
    }) as typeof setTimeout;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return completion({ action: "help" });
    }) as unknown as typeof fetch;
    try {
      const { id } = await createOrdinary(root, runtime);
      requests.length = 0;
      timeouts.length = 0;

      const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "请告诉我能做什么" }));
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`${API_CONFIG.baseUrl}/chat/completions`);
      expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
        model: API_CONFIG.model,
        max_tokens: NORMAL_SESSION_INTENT_MAX_TOKENS,
      });
      expect(timeouts).toContain(NORMAL_SESSION_INTENT_TIMEOUT_MS);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed with 503 for no client, disabled, transport failure, timeout, and an open intent breaker", async () => {
    const cases: Array<{
      name: string;
      config: typeof API_CONFIG;
      disabled?: boolean;
      fetch?: () => Promise<Response>;
      expectedFetches: number;
      repeat?: boolean;
    }> = [
      { name: "no client", config: PLACEHOLDER_CONFIG, expectedFetches: 0 },
      { name: "disabled", config: API_CONFIG, disabled: true, expectedFetches: 0 },
      {
        name: "transport", config: API_CONFIG, expectedFetches: 1,
        fetch: async () => { throw new TypeError("unavailable transport"); },
      },
      {
        name: "timeout", config: API_CONFIG, expectedFetches: 1,
        fetch: async () => {
          const error = new Error("intent timeout");
          error.name = "AbortError";
          throw error;
        },
      },
      {
        name: "breaker", config: API_CONFIG, expectedFetches: 1, repeat: true,
        fetch: async () => { throw new TypeError("trip the intent breaker"); },
      },
    ];

    for (const scenario of cases) {
      const root = mkdtempSync(join(tmpdir(), `ordinary-intent-${scenario.name}-`));
      const runtime = testRuntime(scenario.config);
      let calls = 0;
      if (scenario.disabled) process.env.LLM_DISABLED = "true";
      if (scenario.fetch) {
        globalThis.fetch = (async () => {
          calls++;
          return scenario.fetch!();
        }) as unknown as typeof fetch;
      }
      try {
        const { id, session } = await createOrdinary(root, runtime);
        calls = 0;
        const before = stateDigest(session);
        const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "攻击哥布林" }));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "intent_model_unavailable" });
        expect(calls).toBe(scenario.expectedFetches);
        expect(stateDigest(session)).toBe(before);

        if (scenario.repeat) {
          const repeat = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "攻击哥布林" }));
          expect(repeat.status).toBe(503);
          expect(calls).toBe(scenario.expectedFetches);
          expect(stateDigest(session)).toBe(before);
        }
      } finally {
        delete process.env.LLM_DISABLED;
        globalThis.fetch = savedFetch;
        LLMClient.resetDefeat();
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 10_000);

  test("executes the model-selected handler instead of a different regex interpretation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-model-handler-"));
    const runtime = testRuntime(API_CONFIG);
    const seenInputs: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      seenInputs.push(payload.messages.at(-1)!.content);
      return completion({ action: "help" });
    }) as unknown as typeof fetch;
    try {
      const { id } = await createOrdinary(root, runtime);
      const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "攻击哥布林" }));
      const body = await response.json() as { narrative: string; events: Array<{ content: string }> };
      expect(response.status).toBe(200);
      expect(seenInputs).toEqual(["攻击哥布林"]);
      expect(body.narrative).toContain("操作指南");
      expect(body.events.map((event) => event.content).join("\n")).toContain("操作指南");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns stable 422 for a non-JSON or invalid model reply without regex execution or model text exposure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-invalid-"));
    const runtime = testRuntime(API_CONFIG);
    const rawReply = "untrusted model prose, never return this to the caller";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return completion(rawReply);
    }) as unknown as typeof fetch;
    try {
      const { id, session } = await createOrdinary(root, runtime);
      calls = 0;
      const before = stateDigest(session);
      const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "攻击哥布林" }));
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body).toEqual({ code: "intent_model_invalid" });
      expect(JSON.stringify(body)).not.toContain(rawReply);
      expect(calls).toBe(1);
      expect(stateDigest(session)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the model JSON violates the strict ActionIntent allowlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-strict-invalid-"));
    const runtime = testRuntime(API_CONFIG);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return completion({ action: "execute_anything" });
    }) as unknown as typeof fetch;
    try {
      const { id, session } = await createOrdinary(root, runtime);
      calls = 0;
      const before = stateDigest(session);
      const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "look around" }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ code: "intent_model_invalid" });
      expect(calls).toBe(1);
      expect(stateDigest(session)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps a malformed 200 provider JSON body to 422 without state changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-malformed-provider-json-"));
    const runtime = testRuntime(API_CONFIG);
    const rawProviderBody = "{not valid provider json; do not expose}";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(rawProviderBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const { id, session } = await createOrdinary(root, runtime);
      calls = 0;
      const before = stateDigest(session);
      const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "攻击哥布林" }));
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body).toEqual({ code: "intent_model_invalid" });
      expect(JSON.stringify(body)).not.toContain(rawProviderBody);
      expect(calls).toBe(1);
      expect(stateDigest(session)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats an empty OpenAI-compatible completion as an invalid model reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-empty-completion-"));
    const runtime = testRuntime(API_CONFIG);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return completion(undefined);
    }) as unknown as typeof fetch;
    try {
      const { id, session } = await createOrdinary(root, runtime);
      calls = 0;
      const before = stateDigest(session);
      const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "look around" }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ code: "intent_model_invalid" });
      expect(calls).toBe(1);
      expect(stateDigest(session)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not call an API for prefixed, unresolved, or blank placeholder keys", async () => {
    const keys = ["sk-placeholder-prefixed", "sk-your-key-here", "${OPENAI_API_KEY}", "   \t  "];
    for (const apiKey of keys) {
      const root = mkdtempSync(join(tmpdir(), "ordinary-intent-placeholder-key-"));
      const runtime = testRuntime({ ...API_CONFIG, apiKey });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        throw new Error("placeholder keys must never reach fetch");
      }) as unknown as typeof fetch;
      try {
        const { id, session } = await createOrdinary(root, runtime);
        const before = stateDigest(session);
        const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "look around" }));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "intent_model_unavailable" });
        expect(calls).toBe(0);
        expect(stateDigest(session)).toBe(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("does not treat placeholder environment keys as enabled at any precedence position", () => {
    const placeholders = ["sk-placeholder-prefixed", "sk-your-key-here", "${OPENAI_API_KEY}", "  \t "];
    const envNames = ["LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] as const;
    for (const placeholder of placeholders) {
      for (const envName of envNames) {
        for (const name of envNames) delete process.env[name];
        process.env[envName] = placeholder;
        expect(llmEnabled()).toBe(false);
      }
    }
  });

  test("executes only recognized slash and teammate commands locally in required no-client sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-local-commands-"));
    const runtime = testRuntime(PLACEHOLDER_CONFIG);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("recognized local commands must not reach fetch");
    }) as unknown as typeof fetch;
    const ordinaryFactory = runtime.dependencies.createOrdinarySession!;
    runtime.dependencies.createOrdinarySession = (input) => {
      const source = ordinaryFactory(input);
      const target = new GameSession(
        input.id, input.ruleset, PLACEHOLDER_CONFIG, undefined, undefined,
        input.persona, input.storage, input.access, input.intentPolicy,
        input.runtimeDependencies,
      );
      try {
        restoreSignedOrdinaryCompanion(target, PLACEHOLDER_CONFIG, undefined, source);
        target.getOpeningScene = async () => "offline test opening";
        return target;
      } finally {
        source.close();
      }
    };
    try {
      const { id } = await createOrdinary(root, runtime);
      const slash = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "/help" }));
      expect(slash.status).toBe(200);
      expect(JSON.stringify(await slash.json())).toContain("命令: /roll");

      // A committed ordinary action derives then installs a fresh live object;
      // test the current durable-backed object rather than a closed predecessor.
      let inner = runtime.registry.get(id)!;
      const knownCompanion = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "接管 老李" }));
      expect(knownCompanion.status).toBe(200);
      inner = runtime.registry.get(id)!;
      expect(String(inner.companionManager.getControl("ordinary-known-companion"))).toStartWith("player:");

      const unknownCompanionBefore = stateDigest(runtime.registry.get(id)!);
      const unknownCompanion = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "邀请 Alice" }));
      expect(unknownCompanion.status).toBe(503);
      expect(await unknownCompanion.json()).toEqual({ code: "intent_model_unavailable" });
      expect(stateDigest(runtime.registry.get(id)!)).toBe(unknownCompanionBefore);

      const recruit = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "创建队友 Grace investigator" }));
      expect(recruit.status).toBe(200);
      const body = await recruit.json() as { state?: { party?: Array<{ name: string }> } };
      expect(body.state?.party?.some((member) => member.name === "Grace")).toBe(true);

      const malformed = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "创建队友 Grace" }));
      expect(malformed.status).toBe(503);
      expect(await malformed.json()).toEqual({ code: "intent_model_unavailable" });
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // Four requests deliberately exercise create, reload, durable commit, and
    // registry replacement. This is a test-process scheduling budget, not an
    // allowance for a production action to block for fifteen seconds.
  }, 15_000);

  test("requires a full deterministic command grammar before bypassing required intent", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-command-grammar-"));
    const runtime = testRuntime(PLACEHOLDER_CONFIG);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("no-client failures must not fetch");
    }) as unknown as typeof fetch;
    try {
      const { id } = await createOrdinary(root, runtime);
      const unknownModule = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "加载模组 missing_module" }));
      expect(unknownModule.status).toBe(503);
      expect(await unknownModule.json()).toEqual({ code: "intent_model_unavailable" });

      const listing = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "加载模组" }));
      expect(listing.status).toBe(200);
      expect(JSON.stringify(await listing.json())).toContain("可用模组: 普瑞米尔的谷仓, 阿卡姆档案检查, 印斯茅斯的阴影");

      const knownModule = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "加载模组 阿卡姆档案检查" }));
      expect(knownModule.status).toBe(200);
      expect(JSON.stringify(await knownModule.json())).toContain("密斯卡托尼克");

      for (const input of [
        "/help 然后攻击",
        "使用模块化武器攻击",
        "加载模组后攻击",
        "加载模组 X，然后攻击",
        "创建队友 Grace investigator 然后攻击",
        "加载模组 X and attack",
        "加载模组 X & attack",
        "加载模组 X or attack",
        "加载模组 X | attack",
        "加载模组 X plus attack",
        "加载模组 X 之后攻击",
        "加载模组 X 同时攻击",
        "加载模组 X 再攻击",
        "邀请 Alice and attack",
        "邀请 Alice or attack",
        "控制 Bob then flee",
        "加载模组 克苏鲁，1920",
        "加载模组 The Last Door!",
      ]) {
        const before = stateDigest(runtime.registry.get(id)!);
        const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input }));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "intent_model_unavailable" });
        expect(stateDigest(runtime.registry.get(id)!)).toBe(before);
      }
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // This test serially creates an ordinary session, lists and loads a module,
    // then runs every rejected grammar form through the durable HTTP boundary.
    // The budget is local to that deliberate multi-request workload.
  }, 15_000);

  test("preserves punctuation in a module title for session-catalog matching", () => {
    expect(parseOrdinaryLocalCommand("加载模组 克苏鲁，1920")).toEqual({ kind: "load_module", moduleName: "克苏鲁，1920" });
    expect(parseOrdinaryLocalCommand("加载模组 The Last Door!")).toEqual({ kind: "load_module", moduleName: "The Last Door!" });
  });

  test("rejects 1001 Unicode code points before fetch or action mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-length-"));
    const runtime = testRuntime(API_CONFIG);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return completion({ action: "help" });
    }) as unknown as typeof fetch;
    try {
      const { id, session } = await createOrdinary(root, runtime);
      calls = 0;
      const before = stateDigest(session);
      const input = "😀".repeat(1001);
      const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ code: "action_input_too_long" });
      expect(calls).toBe(0);
      expect(stateDigest(session)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds ordinary action JSON before model calls, state mutation, or metadata writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-body-limit-"));
    const runtime = testRuntime(API_CONFIG);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return completion({ action: "help" });
    }) as unknown as typeof fetch;
    try {
      const { id, session } = await createOrdinary(root, runtime);
      const before = stateDigest(session);
      const ordinarySnapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      const durableBefore = JSON.stringify(ordinarySnapshots.read(id));
      const raw = JSON.stringify({ input: "x".repeat(9_000) });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(raw));
          controller.close();
        },
      });
      const requests: RequestInit[] = [
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(raw.length) }, body: raw },
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "16" }, body: raw },
        { method: "POST", headers: { "Content-Type": "application/json" }, body: stream },
      ];
      for (const init of requests) {
        const response = await request(root, runtime, `/api/sessions/${id}/action`, init);
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({ code: "action_request_too_large" });
      }
      expect(calls).toBe(0);
      expect(stateDigest(session)).toBe(before);
      expect(JSON.stringify(ordinarySnapshots.read(id))).toBe(durableBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("permits regex only through an exact development or test development_fallback server policy", async () => {
    expect(createEnvironmentOrdinaryIntentPolicy({})).toBe("required");
    expect(createEnvironmentOrdinaryIntentPolicy({ ORDINARY_SESSION_INTENT_POLICY: "fallback", NODE_ENV: "development" })).toBe("required");
    expect(createEnvironmentOrdinaryIntentPolicy({ ORDINARY_SESSION_INTENT_POLICY: "development_fallback", NODE_ENV: "production" })).toBe("required");
    expect(createEnvironmentOrdinaryIntentPolicy({ ORDINARY_SESSION_INTENT_POLICY: "development_fallback", NODE_ENV: "development" })).toBe("development_fallback");

    const productionRoot = mkdtempSync(join(tmpdir(), "ordinary-intent-production-required-"));
    const productionRuntime = testRuntime(PLACEHOLDER_CONFIG, "development_fallback");
    process.env.NODE_ENV = "production";
    try {
      const { id } = await createOrdinary(productionRoot, productionRuntime);
      const response = await request(productionRoot, productionRuntime, `/api/sessions/${id}/action`, jsonRequest({ input: "look around" }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "intent_model_unavailable" });
    } finally {
      delete process.env.NODE_ENV;
      rmSync(productionRoot, { recursive: true, force: true });
    }

    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-development-fallback-"));
    const runtime = testRuntime(PLACEHOLDER_CONFIG, "development_fallback");
    let calls = 0;
    process.env.NODE_ENV = "development";
    globalThis.fetch = (async () => { calls++; return completion({ action: "attack" }); }) as unknown as typeof fetch;
    try {
      const { id } = await createOrdinary(root, runtime);
      const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "查看背包" }));
      expect(response.status).toBe(200);
      expect(calls).toBe(0);
    } finally {
      delete process.env.NODE_ENV;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a narration breaker does not suppress an API-required intent request on the same endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-intent-workload-breaker-"));
    const runtime = testRuntime(API_CONFIG);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1 || calls === 3) throw new TypeError("non-intent transport failure");
      return completion({ action: "help" });
    }) as unknown as typeof fetch;
    try {
      await expect(new LLMClient(API_CONFIG).chat([{ role: "user", content: "narrate" }], { workload: "narration" }))
        .rejects.toThrow("连接失败");
      const { id } = await createOrdinary(root, runtime);
      const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "帮助" }));
      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      await expect(new LLMClient(API_CONFIG).chat([{ role: "user", content: "default workload" }]))
        .rejects.toThrow("连接失败");
      const afterDefaultFailure = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "帮助" }));
      expect(afterDefaultFailure.status).toBe(200);
      expect(calls).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
