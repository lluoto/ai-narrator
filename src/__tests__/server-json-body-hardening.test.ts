import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";

const CONFIG = { apiKey: "sk-json-body-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const OWNER = "keeper:json-body-test";

function keeper(): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role: "keeper", id: OWNER } });
}

function operator(): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role: "operator", id: "operator:json-body-test" } });
}

interface TestRuntime {
  registry: Map<string, GameSession>;
  dependencies: SessionRuntimeDependencies;
  factoryCalls: () => number;
}

function testRuntime(): TestRuntime {
  const registry = new Map<string, GameSession>();
  let calls = 0;
  return {
    registry,
    dependencies: {
      registry,
      ordinaryIntentPolicy: "development_fallback",
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        calls++;
        const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => "offline opening";
        return session;
      },
    },
    factoryCalls: () => calls,
  };
}

function request(root: string, runtime: TestRuntime, path: string, init: RequestInit, authenticator = keeper()): Promise<Response> {
  return handleRequest(
    new Request(`http://test${path}`, init),
    undefined,
    undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {},
    {},
    authenticator,
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    runtime.dependencies,
  );
}

function closeRuntime(runtime: TestRuntime): void {
  for (const session of runtime.registry.values()) session.close();
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("server JSON body hardening", () => {
  test("bounds declared, underreported, and undeclared general JSON before session construction or module update", async () => {
    const root = mkdtempSync(join(tmpdir(), "server-json-body-limit-"));
    const runtime = testRuntime();
    const text = JSON.stringify({ ignored: "x".repeat(1024 * 1024 + 1) });
    const bytes = new TextEncoder().encode(text);
    const moduleId = "json-body-limit-probe";
    const modulePath = join(process.cwd(), "data", "modules", `${moduleId}.json`);
    expect(existsSync(modulePath)).toBe(false);
    try {
      const requests: RequestInit[] = [
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) }, body: text },
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: text },
        { method: "POST", headers: { "Content-Type": "application/json" }, body: byteStream(bytes) },
      ];
      for (const init of requests) {
        const response = await request(root, runtime, "/api/sessions", init);
        expect(response.status).toBe(413);
        expect(runtime.factoryCalls()).toBe(0);
        expect(runtime.registry).toHaveLength(0);
      }
      const moduleResponse = await request(root, runtime, `/api/modules/${moduleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Content-Length": "1" },
        body: text,
      }, operator());
      expect(moduleResponse.status).toBe(413);
      expect(existsSync(modulePath)).toBe(false);
    } finally {
      closeRuntime(runtime);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a truly bodyless session create compatible but rejects malformed UTF-8 and JSON before construction", async () => {
    const root = mkdtempSync(join(tmpdir(), "server-json-body-invalid-"));
    const runtime = testRuntime();
    try {
      const bodyless = await request(root, runtime, "/api/sessions", { method: "POST" });
      expect(bodyless.status).toBe(201);
      const bodylessFactoryCalls = runtime.factoryCalls();
      expect(bodylessFactoryCalls).toBeGreaterThan(0);

      const explicitlyEmpty = await request(root, runtime, "/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "0" }, body: "",
      });
      expect(explicitlyEmpty.status).toBe(400);
      expect(runtime.factoryCalls()).toBe(bodylessFactoryCalls);

      const invalidUtf8 = await request(root, runtime, "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: byteStream(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d])),
      });
      expect(invalidUtf8.status).toBe(400);

      const invalidJson = await request(root, runtime, "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ definitely not JSON",
      });
      expect(invalidJson.status).toBe(400);
      expect(runtime.factoryCalls()).toBe(bodylessFactoryCalls);
      expect(runtime.registry).toHaveLength(1);
    } finally {
      closeRuntime(runtime);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed action input without invoking the action transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "server-json-body-action-"));
    const runtime = testRuntime();
    try {
      const created = await request(root, runtime, "/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archetype: "detective", characterName: "Ada" }),
      });
      expect(created.status).toBe(201);
      const { sessionId } = await created.json() as { sessionId: string };
      const session = runtime.registry.get(sessionId)!;
      const before = JSON.stringify({ round: session.round, state: session.getState(), history: session.getHistory() });

      const rejected = await request(root, runtime, `/api/sessions/${sessionId}/action`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: byteStream(new Uint8Array([0x7b, 0xc3])),
      });
      expect(rejected.status).toBe(400);
      expect(JSON.stringify({ round: session.round, state: session.getState(), history: session.getHistory() })).toBe(before);
    } finally {
      closeRuntime(runtime);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns 408 for an aborted non-cooperative body without waiting for cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "server-json-body-abort-"));
    const runtime = testRuntime();
    const abort = new AbortController();
    let cancelCalls = 0;
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => {
        cancelCalls++;
        return new Promise<void>(() => {});
      },
    });
    try {
      const pending = request(root, runtime, "/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: stalled, signal: abort.signal,
      });
      const timer = setTimeout(() => abort.abort(), 20);
      const response = await Promise.race([
        pending,
        new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("aborted body was not rejected promptly")), 250)),
      ]);
      clearTimeout(timer);
      expect(response.status).toBe(408);
      expect(runtime.factoryCalls()).toBe(0);
      expect(runtime.registry).toHaveLength(0);
      expect(cancelCalls).toBeGreaterThan(0);
    } finally {
      abort.abort();
      closeRuntime(runtime);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
