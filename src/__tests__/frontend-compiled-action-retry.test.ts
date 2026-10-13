import { afterEach, describe, expect, it } from "bun:test";
import {
  compiledActionPendingStorageKey,
  retryPendingCompiledAction,
  sendSessionAction,
// @ts-expect-error The browser client is JavaScript and deliberately has no declaration file.
} from "../../frontend/src/api.js";

const originalFetch = globalThis.fetch;
const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf7868f";

class MemoryStorage {
  values = new Map<string, string>();
  calls: string[] = [];

  getItem(key: string) { this.calls.push(`get:${key}`); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.calls.push(`set:${key}`); this.values.set(key, value); }
  removeItem(key: string) { this.calls.push(`remove:${key}`); this.values.delete(key); }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function pending(sessionId = "compiled-retry", mechanismId = "search_desk", expectedGeneration = 0) {
  return {
    version: 1,
    sessionId,
    mechanismId,
    pcId: "p1",
    actionId: ACTION_ID,
    expectedGeneration,
  };
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe("compiled action browser retry queue", () => {
  it("persists the exact selected structured request before posting and clears it only after success", async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith("/compiled/intents")) return json({ status: "selected", mechanismId: "search_desk", generation: 0 });
      expect(JSON.parse(storage.values.get(compiledActionPendingStorageKey("compiled-retry"))!)).toEqual(pending());
      return json({ generation: 1, narrative: "done" });
    }) as typeof fetch;

    await expect(sendSessionAction("compiled-retry", "search the desk", {
      compiledGeneration: 0, pcId: "p1", storage, createActionId: () => ACTION_ID,
    })).resolves.toMatchObject({ kind: "executed", data: { generation: 1 } });

    expect(calls).toEqual([
      { url: "/api/sessions/compiled-retry/compiled/intents", body: { input: "search the desk", pcId: "p1", expectedGeneration: 0 } },
      { url: "/api/sessions/compiled-retry/compiled/actions", body: { mechanismId: "search_desk", pcId: "p1", actionId: ACTION_ID, expectedGeneration: 0 } },
    ]);
    expect(storage.values.get(compiledActionPendingStorageKey("compiled-retry"))).toBeUndefined();
    expect(storage.calls).toEqual([
      `get:${compiledActionPendingStorageKey("compiled-retry")}`,
      `set:${compiledActionPendingStorageKey("compiled-retry")}`,
      `remove:${compiledActionPendingStorageKey("compiled-retry")}`,
    ]);
  });

  it("creates a high-entropy action ID for a newly selected request", async () => {
    const storage = new MemoryStorage();
    let actionId = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/compiled/intents")) return json({ status: "selected", mechanismId: "search_desk", generation: 0 });
      actionId = JSON.parse(String(init?.body)).actionId;
      expect(JSON.parse(storage.values.get(compiledActionPendingStorageKey("compiled-retry"))!).actionId).toBe(actionId);
      return json({ generation: 1 });
    }) as typeof fetch;

    await sendSessionAction("compiled-retry", "search the desk", { compiledGeneration: 0, pcId: "p1", storage });
    expect(actionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("retains a selected request after a network or response-read failure", async () => {
    for (const failure of [
      () => Promise.reject(new TypeError("offline")),
      () => Promise.resolve(new Response("not json", { status: 200 })),
      () => Promise.resolve(json({ code: "unrecognized_server_failure" }, 500)),
    ]) {
      const storage = new MemoryStorage();
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).endsWith("/compiled/intents")) return json({ status: "selected", mechanismId: "search_desk", generation: 0 });
        return failure();
      }) as typeof fetch;

      await expect(sendSessionAction("compiled-retry", "search the desk", {
        compiledGeneration: 0, pcId: "p1", storage, createActionId: () => ACTION_ID,
      })).rejects.toThrow();
      expect(JSON.parse(storage.values.get(compiledActionPendingStorageKey("compiled-retry"))!)).toEqual(pending());
    }
  });

  it("restarts by validating and retrying the same pending ID before issuing zero new intent calls", async () => {
    const storage = new MemoryStorage();
    storage.values.set(compiledActionPendingStorageKey("compiled-retry"), JSON.stringify(pending()));
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).includes("?pcId=p1")) return json({ generation: 0, actions: [{ mechanismId: "search_desk" }] });
      return json({ generation: 1, narrative: "recovered" });
    }) as typeof fetch;

    await expect(sendSessionAction("compiled-retry", "a different new input", {
      compiledGeneration: 0, pcId: "p1", storage, createActionId: () => "018f14a2-c2be-7b73-b291-6e64eaf78690",
    })).resolves.toMatchObject({ kind: "executed", retried: true, data: { generation: 1 } });
    expect(calls).toEqual([
      { url: "/api/sessions/compiled-retry/compiled/actions?pcId=p1" },
      { url: "/api/sessions/compiled-retry/compiled/actions", body: { mechanismId: "search_desk", pcId: "p1", actionId: ACTION_ID, expectedGeneration: 0 } },
    ]);
    expect(storage.values.has(compiledActionPendingStorageKey("compiled-retry"))).toBe(false);
  });

  it("isolates pending requests by session", async () => {
    const storage = new MemoryStorage();
    storage.values.set(compiledActionPendingStorageKey("compiled-a"), JSON.stringify(pending("compiled-a")));
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith("/compiled/intents")) return json({ status: "selected", mechanismId: "read_note", generation: 0 });
      return json({ generation: 1 });
    }) as typeof fetch;

    await sendSessionAction("compiled-b", "read the note", {
      compiledGeneration: 0, pcId: "p1", storage, createActionId: () => "018f14a2-c2be-7b73-b291-6e64eaf78690",
    });
    expect(calls).toEqual([
      "/api/sessions/compiled-b/compiled/intents",
      "/api/sessions/compiled-b/compiled/actions",
    ]);
    expect(JSON.parse(storage.values.get(compiledActionPendingStorageKey("compiled-a"))!)).toEqual(pending("compiled-a"));
  });

  it("reconciles authoritative session state after a response-lost commit advances the catalog generation", async () => {
    const storage = new MemoryStorage();
    storage.values.set(compiledActionPendingStorageKey("compiled-retry"), JSON.stringify(pending()));
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("?pcId=p1")) return json({ generation: 1, actions: [{ mechanismId: "next_action" }] });
      return json({
        summary: { id: "compiled-retry", round: 2, scene: "library", playerName: "Ada", ruleset: "cosmic-horror" },
        state: { round: 2, scene: "library", bgm: "dread", player: { hp: 4, maxHp: 10 }, companions: [], npcs: [], monsters: [] },
        sanity: { currentSAN: 31, maxSAN: 50, temporaryInsanity: true, indefiniteInsanity: false },
        history: [{ speaker: "Keeper", content: "The desk has been searched.", type: "narration" }],
        generation: 1,
      });
    }) as typeof fetch;

    await expect(retryPendingCompiledAction("compiled-retry", { pcId: "p1", storage })).resolves.toEqual({
      kind: "reconciled",
      catalog: { generation: 1, actions: [{ mechanismId: "next_action" }] },
      session: {
        summary: { id: "compiled-retry", round: 2, scene: "library", playerName: "Ada", ruleset: "cosmic-horror" },
        state: { round: 2, scene: "library", bgm: "dread", player: { hp: 4, maxHp: 10 }, companions: [], npcs: [], monsters: [] },
        sanity: { currentSAN: 31, maxSAN: 50, temporaryInsanity: true, indefiniteInsanity: false },
        history: [{ speaker: "Keeper", content: "The desk has been searched.", type: "narration" }],
        generation: 1,
      },
    });
    expect(calls).toEqual([
      "/api/sessions/compiled-retry/compiled/actions?pcId=p1",
      "/api/sessions/compiled-retry",
    ]);
    expect(storage.values.has(compiledActionPendingStorageKey("compiled-retry"))).toBe(false);
  });

  it("does not touch retry storage for ordinary sessions", async () => {
    const storage = new MemoryStorage();
    globalThis.fetch = (async (_url: string | URL | Request) => json({ narrative: "ordinary" })) as typeof fetch;

    await expect(sendSessionAction("ordinary-retry", "look around", { compiledGeneration: null, storage })).resolves.toMatchObject({ kind: "ordinary" });
    expect(storage.calls).toEqual([]);
  });

  it("clears malformed, foreign, and version-mismatched entries without executing their mechanism", async () => {
    for (const stored of [
      "not-json",
      JSON.stringify({ ...pending(), sessionId: "other-session" }),
      JSON.stringify({ ...pending(), version: 99 }),
      JSON.stringify({ ...pending(), mechanismId: "inject_mechanism", actionId: "not-a-high-entropy-id" }),
    ]) {
      const storage = new MemoryStorage();
      storage.values.set(compiledActionPendingStorageKey("compiled-retry"), stored);
      const calls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        calls.push(String(url));
        return json({ generation: 0, actions: [{ mechanismId: "search_desk" }] });
      }) as typeof fetch;

      await expect(retryPendingCompiledAction("compiled-retry", { pcId: "p1", storage })).resolves.toBeNull();
      expect(calls).toEqual([]);
      expect(storage.values.has(compiledActionPendingStorageKey("compiled-retry"))).toBe(false);
    }
  });

  it("clears only terminal and server-guaranteed rollback refusals instead of retrying forever", async () => {
    for (const [code, status] of [["compiled_terminal", 409], ["compiled_persistence_failed", 500], ["compiled_execution_failed", 500]] as const) {
      const storage = new MemoryStorage();
      storage.values.set(compiledActionPendingStorageKey("compiled-retry"), JSON.stringify(pending()));
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes("?pcId=p1")) return json({ generation: 0, actions: [{ mechanismId: "search_desk" }] });
        return json({ code, generation: 0 }, status);
      }) as typeof fetch;

      await expect(retryPendingCompiledAction("compiled-retry", { pcId: "p1", storage })).rejects.toThrow(code);
      expect(storage.values.has(compiledActionPendingStorageKey("compiled-retry"))).toBe(false);
    }
  });

  it("reconciles instead of clearing blindly when compiled_unavailable may follow a committed snapshot", async () => {
    const storage = new MemoryStorage();
    storage.values.set(compiledActionPendingStorageKey("compiled-retry"), JSON.stringify(pending()));
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("?pcId=p1")) return json({ generation: 0, actions: [{ mechanismId: "search_desk" }] });
      if (String(url).endsWith("/compiled/actions")) return json({ code: "compiled_unavailable", generation: 0 }, 500);
      return json({
        summary: { id: "compiled-retry", round: 2, scene: "archive", playerName: "Ada", ruleset: "cosmic-horror" },
        state: { round: 2, scene: "archive", bgm: "dread", player: { hp: 3, maxHp: 10 }, companions: [], npcs: [], monsters: [] },
        sanity: { currentSAN: 29, maxSAN: 50, temporaryInsanity: true, indefiniteInsanity: false },
        history: [{ speaker: "Keeper", content: "The committed action was recovered.", type: "narration" }],
        generation: 1,
      });
    }) as typeof fetch;

    await expect(retryPendingCompiledAction("compiled-retry", { pcId: "p1", storage })).resolves.toMatchObject({
      kind: "reconciled",
      catalog: null,
      session: { summary: { round: 2, scene: "archive" }, state: { player: { hp: 3, maxHp: 10 } }, sanity: { currentSAN: 29 }, generation: 1 },
    });
    expect(calls).toEqual([
      "/api/sessions/compiled-retry/compiled/actions?pcId=p1",
      "/api/sessions/compiled-retry/compiled/actions",
      "/api/sessions/compiled-retry",
    ]);
    expect(storage.values.has(compiledActionPendingStorageKey("compiled-retry"))).toBe(false);
  });
});
