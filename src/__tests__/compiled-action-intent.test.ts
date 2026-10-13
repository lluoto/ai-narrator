import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LLMLike, Message, ChatOptions } from "../llm/client";
import { LLMClient } from "../llm/client";
import { COMPILED_INTENT_LLM_TIMEOUT_MS, COMPILED_INTENT_MAX_OUTPUT_TOKENS, resolveCompiledActionIntent } from "../llm/compiled-action-intent";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { handleRequest } from "../api/server";
import { GameSession } from "../api/game-session";
import { PlayerSession } from "../session/player-session";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";

const catalog = [
  { mechanismId: "search_desk", kind: "discovery", label: "Search the desk", check: { kind: "skill", skill: "spot_hidden", difficulty: "regular" } },
  { mechanismId: "leave_room", kind: "traversal", label: "Go to another area" },
] as const;

const keeperAuthenticator = () => ({ status: "authenticated" as const, principal: { id: "keeper:compiled-action-intent", role: "keeper" as const } });

class FakeLLM implements LLMLike {
  calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];
  constructor(private readonly reply: string | Error) {}

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.calls.push({ messages, options });
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

describe("compiled action intent resolver", () => {
  it("selects exactly one current catalog ID with a bounded JSON-only model call", async () => {
    const llm = new FakeLLM('{"kind":"selected","mechanismId":"search_desk"}');
    await expect(resolveCompiledActionIntent({ input: "I search the desk", expectedGeneration: 7, catalog, llm })).resolves.toEqual({
      status: "selected", mechanismId: "search_desk",
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.options).toMatchObject({ temperature: 0, jsonMode: true, maxTokens: COMPILED_INTENT_MAX_OUTPUT_TOKENS, timeout: COMPILED_INTENT_LLM_TIMEOUT_MS, workload: "intent" });
    const prompt = llm.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("search_desk");
    expect(prompt).not.toContain("ending");
  });

  it("keeps compiled intent available when the same endpoint's default breaker is open", async () => {
    const previousFetch = globalThis.fetch;
    const config = {
      apiKey: "sk-compiled-intent-workload-test",
      baseUrl: "http://compiled-intent-workload.invalid/v1",
      model: "compiled-intent-workload-test-model",
      maxTokens: 128,
      temperature: 0,
    };
    let calls = 0;
    LLMClient.resetDefeat();
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("default workload unavailable");
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"kind":"selected","mechanismId":"search_desk"}' } }],
      }), { headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      await expect(new LLMClient(config).chat([{ role: "user", content: "default" }], { maxAttempts: 1 }))
        .rejects.toThrow("LLM");
      await expect(resolveCompiledActionIntent({
        input: "I search the desk",
        expectedGeneration: 0,
        catalog,
        llm: new LLMClient(config),
      })).resolves.toEqual({ status: "selected", mechanismId: "search_desk" });
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      LLMClient.resetDefeat();
    }
  });

  it("bounds compiled classification to one provider attempt and forwards cancellation", async () => {
    const previousFetch = globalThis.fetch;
    const config = {
      apiKey: "sk-compiled-intent-one-attempt-test",
      baseUrl: "http://compiled-intent-one-attempt.invalid/v1",
      model: "compiled-intent-one-attempt-model",
      maxTokens: 128,
      temperature: 0,
    };
    let attempts = 0;
    LLMClient.resetDefeat();
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response("provider unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const seen: ChatOptions[] = [];
    const observing: LLMLike = {
      async chat(_messages, options) {
        seen.push(options ?? {});
        return '{"kind":"no_match"}';
      },
    };
    try {
      await expect(resolveCompiledActionIntent({
        input: "I search the desk",
        expectedGeneration: 0,
        catalog,
        llm: new LLMClient(config),
        signal: controller.signal,
      })).resolves.toEqual({ status: "error", code: "model_error" });
      expect(attempts).toBe(1);
      await resolveCompiledActionIntent({
        input: "I search the desk",
        expectedGeneration: 0,
        catalog,
        llm: observing,
        signal: controller.signal,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ maxAttempts: 1, signal: controller.signal });
    } finally {
      globalThis.fetch = previousFetch;
      LLMClient.resetDefeat();
    }
  });

  it("preserves ambiguous and no-match as non-executing classifications", async () => {
    await expect(resolveCompiledActionIntent({
      input: "do either", expectedGeneration: 0, catalog,
      llm: new FakeLLM('{"kind":"ambiguous","mechanismIds":["search_desk","leave_room"]}'),
    })).resolves.toEqual({ status: "ambiguous", mechanismIds: ["search_desk", "leave_room"] });
    await expect(resolveCompiledActionIntent({
      input: "sing a song", expectedGeneration: 0, catalog,
      llm: new FakeLLM('{"kind":"no_match"}'),
    })).resolves.toEqual({ status: "no_match" });
  });

  it("fails closed for malformed, surplus, foreign, duplicate, and model-error outputs", async () => {
    for (const reply of [
      "not json",
      '{"kind":"selected","mechanismId":"search_desk","outcome":"invented"}',
      '{"kind":"selected","mechanismId":"foreign"}',
      '{"kind":"ambiguous","mechanismIds":["search_desk","search_desk"]}',
    ]) {
      await expect(resolveCompiledActionIntent({ input: "anything", expectedGeneration: 0, catalog, llm: new FakeLLM(reply) })).resolves.toMatchObject({ status: "invalid" });
    }
    await expect(resolveCompiledActionIntent({ input: "anything", expectedGeneration: 0, catalog, llm: new FakeLLM(new Error("offline")) })).resolves.toEqual({ status: "error", code: "model_error" });
  });
});

async function intentSession(root: string) {
  const fixture = await compiledModuleHttpFixture();
  const catalogStore = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const saved = saveTrustedFixtureBundle(catalogStore, fixture);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Intent" }),
  }), catalogStore, snapshots, { careerRoot: join(root, "careers") }, {}, {}, keeperAuthenticator);
  if (response.status !== 201) throw new Error(await response.text());
  const created = await response.json() as { sessionId: string };
  return { ...created, catalogStore, snapshots, root, fixture };
}

async function postIntent(
  built: Awaited<ReturnType<typeof intentSession>>,
  body: unknown,
  options: { llm?: LLMLike; isLlmEnabled?: () => boolean } = {},
) {
  const response = await handleRequest(new Request(`http://test/api/sessions/${built.sessionId}/compiled/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), built.catalogStore, built.snapshots, { careerRoot: join(built.root, "careers") }, options, {}, keeperAuthenticator);
  return { status: response.status, body: await response.json() as any };
}

async function postStructuredAction(
  built: Awaited<ReturnType<typeof intentSession>>,
  mechanismId: string,
  actionId: string,
  expectedGeneration: number,
) {
  const response = await handleRequest(new Request(`http://test/api/sessions/${built.sessionId}/compiled/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mechanismId, pcId: "p1", actionId, expectedGeneration }),
  }), built.catalogStore, built.snapshots, { careerRoot: join(built.root, "careers") }, {}, {}, keeperAuthenticator);
  return { status: response.status, body: await response.json() as any };
}

async function publicCompiledView(built: Awaited<ReturnType<typeof intentSession>>) {
  const paths = [
    `/api/sessions/${built.sessionId}`,
    `/api/sessions/${built.sessionId}/state`,
    `/api/sessions/${built.sessionId}/history?pcId=p1`,
    `/api/sessions/${built.sessionId}/compiled/actions?pcId=p1`,
  ];
  return Promise.all(paths.map(async (path) => {
    const response = await handleRequest(new Request(`http://test${path}`), built.catalogStore, built.snapshots, { careerRoot: join(built.root, "careers") }, {}, {}, keeperAuthenticator);
    return { status: response.status, body: await response.json() };
  }));
}

describe("compiled action intent HTTP endpoint", () => {
  it("resolves a current public action without executing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-http-"));
    try {
      const built = await intentSession(root);
      const mechanismId = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id;
      const before = built.snapshots.read(built.sessionId);
      const publicBefore = await publicCompiledView(built);
      const response = await postIntent(built, { input: "I search here", pcId: "p1", expectedGeneration: 0 }, {
        llm: new FakeLLM(`{"kind":"selected","mechanismId":"${mechanismId}"}`),
        isLlmEnabled: () => true,
      });
      expect(response).toMatchObject({ status: 200, body: { status: "selected", mechanismId, generation: 0, action: { mechanismId } } });
      expect(built.snapshots.read(built.sessionId)).toEqual(before);
      // The externally observable round, state/world projection, history,
      // generation, and available action catalog must stay byte-for-byte the
      // same throughout resolution as well.
      expect(await publicCompiledView(built)).toEqual(publicBefore);
      // Resolution carries no execution authority. The existing durable action
      // endpoint remains the sole state/persistence path.
      expect(await postStructuredAction(built, mechanismId, "after-selection", 0)).toMatchObject({ status: 200, body: { generation: 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns no-match classifications and fails closed for bad model replies", async () => {
      const root = mkdtempSync(join(tmpdir(), "compiled-intent-results-"));
    try {
      const built = await intentSession(root);
      const enabled = () => true;
      const method = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((item: any) => item.id === "find_parent")!.id;
      expect(await postIntent(built, { input: "maybe", pcId: "p1", expectedGeneration: 0 }, {
        llm: new FakeLLM(`{"kind":"ambiguous","mechanismIds":["${method}","${method}_other"]}`), isLlmEnabled: enabled,
      })).toMatchObject({ status: 422, body: { code: "compiled_intent_invalid_response", generation: 0 } });
      expect(await postIntent(built, { input: "nothing", pcId: "p1", expectedGeneration: 0 }, {
        llm: new FakeLLM('{"kind":"no_match"}'), isLlmEnabled: enabled,
      })).toEqual({ status: 200, body: { status: "no_match", generation: 0 } });
      for (const [index, reply] of [
        "not json",
        `{"kind":"selected","mechanismId":"${method}","extra":true}`,
        '{"kind":"selected","mechanismId":"foreign"}',
      ].entries()) {
        expect(await postIntent(built, { input: `search-${index}`, pcId: "p1", expectedGeneration: 0 }, { llm: new FakeLLM(reply), isLlmEnabled: enabled }))
          .toMatchObject({ status: 422, body: { code: "compiled_intent_invalid_response", generation: 0 } });
      }
      expect(await postIntent(built, { input: "search-network", pcId: "p1", expectedGeneration: 0 }, { llm: new FakeLLM(new Error("network")), isLlmEnabled: enabled }))
        .toMatchObject({ status: 503, body: { code: "compiled_intent_model_unavailable", generation: 0 } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not call a model when disabled, stale, malformed, terminal, or outside request/catalog bounds", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-refusal-"));
    try {
      const built = await intentSession(root);
      const llm = new FakeLLM('{"kind":"no_match"}');
      expect(await postIntent(built, { input: "search", pcId: "p1", expectedGeneration: 0 }, { llm, isLlmEnabled: () => false }))
        .toMatchObject({ status: 503, body: { code: "compiled_intent_model_unavailable", generation: 0 } });
      expect(llm.calls).toHaveLength(0);
      expect(await postIntent(built, { input: "search", pcId: "p1", expectedGeneration: 1 }, { llm, isLlmEnabled: () => true }))
        .toMatchObject({ status: 409, body: { code: "compiled_generation_conflict", generation: 0 } });
      expect(await postIntent(built, { input: " x ", pcId: "p1", expectedGeneration: 0 }, { llm, isLlmEnabled: () => true }))
        .toMatchObject({ status: 400, body: { code: "compiled_intent_contract_required", generation: 0 } });
      expect(await postIntent(built, { input: "x".repeat(1001), pcId: "p1", expectedGeneration: 0 }, { llm, isLlmEnabled: () => true }))
        .toMatchObject({ status: 400, body: { code: "compiled_intent_contract_required", generation: 0 } });
      expect(await postIntent(built, { input: "x".repeat(8_192), pcId: "p1", expectedGeneration: 0 }, { llm, isLlmEnabled: () => true }))
        .toMatchObject({ status: 413, body: { code: "compiled_intent_contract_required", generation: 0 } });
      const lowDeclaredLength = await handleRequest(new Request(`http://test/api/sessions/${built.sessionId}/compiled/intents`, {
        method: "POST",
        // The bounded reader must count streamed bytes itself; a hostile
        // low Content-Length may not bypass the owner endpoint's limit.
        headers: { "Content-Type": "application/json", "Content-Length": "1" },
        body: JSON.stringify({ input: "x".repeat(8_192), pcId: "p1", expectedGeneration: 0 }),
      }), built.catalogStore, built.snapshots, { careerRoot: join(built.root, "careers") }, { llm, isLlmEnabled: () => true }, {}, keeperAuthenticator);
      expect(lowDeclaredLength.status).toBe(413);
      expect(await lowDeclaredLength.json()).toMatchObject({ code: "compiled_intent_contract_required", generation: 0 });
      expect(await postIntent(built, { input: "search", pcId: "p1", expectedGeneration: 0, extra: true }, { llm, isLlmEnabled: () => true }))
        .toMatchObject({ status: 400, body: { code: "compiled_intent_contract_required", generation: 0 } });
      expect(llm.calls).toHaveLength(0);

      const original = GameSession.prototype.getCompiledAvailableActions;
      GameSession.prototype.getCompiledAvailableActions = () => Array.from({ length: 33 }, (_, index) => ({ mechanismId: `m${index}`, kind: "discovery", label: "Search here", command: `@compiled m${index}` }));
      try {
        expect(await postIntent(built, { input: "search", pcId: "p1", expectedGeneration: 0 }, { llm, isLlmEnabled: () => true }))
          .toMatchObject({ status: 409, body: { code: "compiled_action_unavailable", generation: 0 } });
      } finally {
        GameSession.prototype.getCompiledAvailableActions = original;
      }
      expect(llm.calls).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects unknown PCs, non-p1 callers, noncompiled sessions, and an await-time generation change", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-concurrency-"));
    try {
      const built = await intentSession(root);
      const method = (built.fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((item: any) => item.id === "find_parent")!.id;
      const enabled = () => true;
      expect(await postIntent(built, { input: "search", pcId: "missing", expectedGeneration: 0 }, { llm: new FakeLLM('{"kind":"no_match"}'), isLlmEnabled: enabled }))
        .toMatchObject({ status: 404, body: { code: "unknown_pc", generation: 0 } });
      // Simulate a malformed/restored compiled session that contains p2; this
      // verifies the explicit single-PC guard separately from unknown-PC.
      const originalGet = PlayerSession.prototype.get;
      PlayerSession.prototype.get = function(name: string) {
        return originalGet.call(this, name === "p2" ? "p1" : name);
      };
      try {
        expect(await postIntent(built, { input: "search", pcId: "p2", expectedGeneration: 0 }, { llm: new FakeLLM('{"kind":"no_match"}'), isLlmEnabled: enabled }))
          .toMatchObject({ status: 409, body: { code: "compiled_single_pc_required", generation: 0 } });
      } finally {
        PlayerSession.prototype.get = originalGet;
      }

      const changing: LLMLike = {
        chat: async () => {
          expect(await postStructuredAction(built, method, "concurrent-action", 0)).toMatchObject({ status: 200, body: { generation: 1 } });
          return `{"kind":"selected","mechanismId":"${method}"}`;
        },
      };
      expect(await postIntent(built, { input: "search", pcId: "p1", expectedGeneration: 0 }, { llm: changing, isLlmEnabled: enabled }))
        .toMatchObject({ status: 409, body: { code: "compiled_generation_conflict", generation: 1 } });

      const originalOpening = GameSession.prototype.getOpeningScene;
      GameSession.prototype.getOpeningScene = async () => "";
      let sessionId: string;
      // This is a real ordinary HTTP create used only to prove that the
      // compiled-intent route refuses a noncompiled session.  Give it its
      // own production-shaped runtime domain rather than letting the suite
      // touch process-global default stores/namespace state.
      const ordinaryStorage = { careerRoot: join(root, "ordinary-careers"), sessionRoot: join(root, "ordinary-sessions") };
      const ordinaryRuntime = { registry: new Map<string, GameSession>() };
      try {
        const ordinary = await handleRequest(new Request("http://test/api/sessions", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archetype: "investigator", characterName: "Ordinary" }),
        }), undefined, undefined, ordinaryStorage, {}, {}, keeperAuthenticator, undefined, undefined, undefined, undefined, ordinaryRuntime);
        expect(ordinary.status).toBe(201);
        ({ sessionId } = await ordinary.json() as { sessionId: string });
      } finally {
        GameSession.prototype.getOpeningScene = originalOpening;
      }
      const response = await handleRequest(new Request(`http://test/api/sessions/${sessionId}/compiled/intents`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "search", pcId: "p1", expectedGeneration: 0 }),
      }), undefined, undefined, ordinaryStorage, { llm: new FakeLLM('{"kind":"no_match"}'), isLlmEnabled: enabled }, {}, keeperAuthenticator, undefined, undefined, undefined, undefined, ordinaryRuntime);
      expect(response.status).toBe(404);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
