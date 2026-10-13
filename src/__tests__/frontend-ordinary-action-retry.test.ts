import { afterEach, describe, expect, it } from "bun:test";
// @ts-ignore The browser client is JavaScript and deliberately has no declaration file.
import { createSession, compiledSessionGeneration, ordinaryActionPendingStorageKey, retryPendingOrdinaryAction, sendSessionAction } from "../../frontend/src/api.js";

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

function pending(sessionId = "ordinary-retry", expectedGeneration = 0) {
  return {
    version: 1,
    sessionId,
    input: "look around",
    pcId: "p1",
    actionId: ACTION_ID,
    expectedGeneration,
  };
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe("ordinary action browser retry queue", () => {
  it("persists the four-field ordinary request before its first POST, including generation zero", async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-retry"))!)).toEqual(pending());
      return json({ sessionKind: "ordinary", ordinaryGeneration: 1, narrative: "done" });
    }) as unknown as typeof fetch;

    await expect(sendSessionAction("ordinary-retry", "look around", {
      sessionKind: "ordinary", ordinaryGeneration: 0, pcId: "p1", storage, createActionId: () => ACTION_ID,
    })).resolves.toEqual({ kind: "ordinary", data: { sessionKind: "ordinary", ordinaryGeneration: 1, narrative: "done" } });

    expect(calls).toEqual([{
      url: "/api/sessions/ordinary-retry/action",
      body: { input: "look around", pcId: "p1", actionId: ACTION_ID, expectedGeneration: 0 },
    }]);
    expect(storage.calls).toEqual([
      `get:${ordinaryActionPendingStorageKey("ordinary-retry")}`,
      `set:${ordinaryActionPendingStorageKey("ordinary-retry")}`,
      `get:${ordinaryActionPendingStorageKey("ordinary-retry")}`,
      `remove:${ordinaryActionPendingStorageKey("ordinary-retry")}`,
    ]);
  });

  it("never POSTs when durable storage rejects the request", async () => {
    let networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls += 1; return json({}); }) as unknown as typeof fetch;
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
      removeItem: () => {},
    };

    await expect(sendSessionAction("ordinary-retry", "look around", {
      sessionKind: "ordinary", ordinaryGeneration: 0, storage, createActionId: () => ACTION_ID,
    })).rejects.toThrow("persisted");
    expect(networkCalls).toBe(0);
  });

  it("keeps one exact durable request through lost responses and reload recovery", async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let postCount = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (target.endsWith("/action")) {
        postCount += 1;
        if (postCount === 1) throw new TypeError("response lost");
        return json({ sessionKind: "ordinary", ordinaryGeneration: 1, narrative: "receipt" });
      }
      if (target.endsWith("/history?limit=100")) return json({ messages: [{ speaker: "Keeper", content: "receipt" }] });
      return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: "ordinary-retry" }, history: [{ speaker: "Keeper", content: "receipt" }] });
    }) as typeof fetch;

    await expect(sendSessionAction("ordinary-retry", "look around", {
      sessionKind: "ordinary", ordinaryGeneration: 0, pcId: "p1", storage, createActionId: () => ACTION_ID,
    })).rejects.toThrow("response lost");
    await expect(retryPendingOrdinaryAction("ordinary-retry", { storage })).resolves.toMatchObject({
      kind: "reconciled",
      session: { sessionKind: "ordinary", ordinaryGeneration: 1 },
      history: { messages: [{ content: "receipt" }] },
    });

    expect(calls.filter(call => call.url.endsWith("/action"))).toEqual([
      { url: "/api/sessions/ordinary-retry/action", body: { input: "look around", pcId: "p1", actionId: ACTION_ID, expectedGeneration: 0 } },
      { url: "/api/sessions/ordinary-retry/action", body: { input: "look around", pcId: "p1", actionId: ACTION_ID, expectedGeneration: 0 } },
    ]);
    expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-retry"))).toBe(false);
  });

  it("retains indeterminate transport, invalid JSON, and 503 failures", async () => {
    for (const failure of [
      () => Promise.reject(new TypeError("offline")),
      () => Promise.resolve(new Response("not json", { status: 200 })),
      () => Promise.resolve(json({ code: "ordinary_persistence_indeterminate", ordinaryGeneration: 0 }, 503)),
    ]) {
      const storage = new MemoryStorage();
      globalThis.fetch = (async () => failure()) as unknown as typeof fetch;
      await expect(sendSessionAction("ordinary-retry", "look around", {
        sessionKind: "ordinary", ordinaryGeneration: 0, pcId: "p1", storage, createActionId: () => ACTION_ID,
      })).rejects.toThrow();
      expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-retry"))!)).toEqual(pending());
    }
  });

  it("uses only a pre-commit server-code whitelist for 400/409 cleanup and does not remove a concurrent replacement", async () => {
    const storage = new MemoryStorage();
    storage.values.set(ordinaryActionPendingStorageKey("ordinary-retry"), JSON.stringify(pending()));
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/action")) return json({ code: "ordinary_generation_conflict", ordinaryGeneration: 1 }, 409);
      if (String(url).endsWith("/history?limit=100")) return json({ messages: [] });
      return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: "ordinary-retry" } });
    }) as typeof fetch;
    await expect(retryPendingOrdinaryAction("ordinary-retry", { storage })).resolves.toMatchObject({ kind: "reconciled" });
    expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-retry"))).toBe(false);

    storage.values.set(ordinaryActionPendingStorageKey("ordinary-retry"), JSON.stringify(pending()));
    const indeterminateCalls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      indeterminateCalls.push(String(url));
      if (String(url).endsWith("/action")) return json({ code: "ordinary_registry_replaced", ordinaryGeneration: 1 }, 409);
      if (String(url).endsWith("/history?limit=100")) return json({ messages: [] });
      return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: "ordinary-retry" } });
    }) as typeof fetch;
    await expect(retryPendingOrdinaryAction("ordinary-retry", { storage })).resolves.toMatchObject({ kind: "reconciled", pendingRetained: true });
    expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-retry"))).toBe(true);
    expect(indeterminateCalls).toEqual([
      "/api/sessions/ordinary-retry/action",
      "/api/sessions/ordinary-retry",
      "/api/sessions/ordinary-retry/history?limit=100",
    ]);

    const replacement = { ...pending(), input: "new input", actionId: "018f14a2-c2be-7b73-b291-6e64eaf78690" };
    storage.values.set(ordinaryActionPendingStorageKey("ordinary-retry"), JSON.stringify(pending()));
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/action")) {
        storage.values.set(ordinaryActionPendingStorageKey("ordinary-retry"), JSON.stringify(replacement));
        return json({ sessionKind: "ordinary", ordinaryGeneration: 1 });
      }
      return json({ messages: [] });
    }) as typeof fetch;
    await retryPendingOrdinaryAction("ordinary-retry", { storage });
    expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-retry"))!)).toEqual(replacement);
  });

  it("fails closed for malformed or foreign records, without POSTing them", async () => {
    for (const stored of [
      "not json",
      JSON.stringify({ ...pending(), sessionId: "different-session" }),
      JSON.stringify({ ...pending(), version: 99 }),
      JSON.stringify({ ...pending(), actionId: "not-high-entropy" }),
    ]) {
      const storage = new MemoryStorage();
      storage.values.set(ordinaryActionPendingStorageKey("ordinary-retry"), stored);
      let networkCalls = 0;
      globalThis.fetch = (async () => { networkCalls += 1; return json({}); }) as unknown as typeof fetch;
      await expect(retryPendingOrdinaryAction("ordinary-retry", { storage })).resolves.toBeNull();
      expect(networkCalls).toBe(0);
      expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-retry"))).toBe(false);
    }
  });

  it("uses the higher authoritative GET generation instead of rendering an old receipt", async () => {
    const storage = new MemoryStorage();
    storage.values.set(ordinaryActionPendingStorageKey("ordinary-retry"), JSON.stringify(pending()));
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/action")) return json({ sessionKind: "ordinary", ordinaryGeneration: 1, narrative: "old receipt" });
      if (String(url).endsWith("/history?limit=100")) return json({ messages: [{ content: "newer history" }] });
      return json({ sessionKind: "ordinary", ordinaryGeneration: 2, summary: { id: "ordinary-retry" }, history: [{ content: "newer history" }] });
    }) as typeof fetch;

    await expect(retryPendingOrdinaryAction("ordinary-retry", { storage })).resolves.toMatchObject({
      kind: "reconciled",
      receipt: { ordinaryGeneration: 1 },
      session: { ordinaryGeneration: 2 },
      history: { messages: [{ content: "newer history" }] },
    });
  });

  it("never treats an ordinary generation zero response as compiled, and reconciles a recoverable create locator without a second create", async () => {
    expect(compiledSessionGeneration({ sessionKind: "ordinary", ordinaryGeneration: 0, generation: 0 }, "ordinary")).toBeNull();
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (init?.method === "POST") return json({ sessionId: "ordinary-created", sessionKind: "ordinary", ordinaryGeneration: 0 }, 503);
      return json({ sessionKind: "ordinary", ordinaryGeneration: 0, summary: { id: "ordinary-created", round: 1 } });
    }) as typeof fetch;

    await expect(createSession({ characterName: "Ada" })).resolves.toMatchObject({
      sessionId: "ordinary-created", sessionKind: "ordinary", ordinaryGeneration: 0,
    });
    expect(calls).toEqual([
      "POST /api/sessions",
      "GET /api/sessions/ordinary-created",
    ]);
  });
});
