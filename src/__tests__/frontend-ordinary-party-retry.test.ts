import { afterEach, describe, expect, it } from "bun:test";
// @ts-ignore Browser client deliberately has no declaration file.
import { luckSpend, ordinaryActionPendingStorageKey, partyMemberCreate, retryPendingOrdinaryAction, sendSessionAction } from "../../frontend/src/api.js";
// @ts-ignore Owner credential remains in browser-module memory.
import { clearOwnerBearer, setOwnerBearer } from "../../frontend/src/owner-auth.js";

const originalFetch = globalThis.fetch;
const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf7868f";
const NEXT_ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf78690";
const OWNER_TOKEN = "p".repeat(48);

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function partyPending(sessionId = "ordinary-party-retry", expectedGeneration = 0, actionId = ACTION_ID) {
  return {
    version: 1,
    kind: "party_member_create",
    sessionId,
    name: "Bea",
    archetype: "detective",
    meta: { personality: "careful" },
    actionId,
    expectedGeneration,
  };
}

function textPending(sessionId = "ordinary-party-retry") {
  return { version: 1, sessionId, input: "look around", pcId: "p1", actionId: ACTION_ID, expectedGeneration: 0 };
}

function luckPending(sessionId = "ordinary-party-retry") {
  return { version: 1, kind: "luck_spend", sessionId, amount: 3, actionId: ACTION_ID, expectedGeneration: 0 };
}

function authoritative(target: string) {
  if (target.endsWith("/history?limit=100")) return json({ messages: [{ content: "authoritative history" }] });
  return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: "ordinary-party-retry" }, state: { party: [{ pcId: "p1" }, { pcId: "p2", name: "Bea" }] } });
}

afterEach(() => {
  clearOwnerBearer();
  globalThis.fetch = originalFetch;
});

describe("ordinary party member browser retry queue", () => {
  it("persists a normalized closed party request before owner-authenticated POST and then renders only GET authority", async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ url: string; body?: Record<string, unknown>; authorization: string | null }> = [];
    setOwnerBearer(OWNER_TOKEN);
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({
        url: target,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (target.endsWith("/party")) {
        expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-party-retry"))!)).toEqual(partyPending());
        return json({ pcId: "p2", name: "Bea", archetype: "detective", sessionKind: "ordinary", ordinaryGeneration: 1 }, 201);
      }
      return authoritative(target);
    }) as typeof fetch;

    const input = { name: "Bea", archetype: "detective", meta: { personality: "careful" } };
    await expect(partyMemberCreate("ordinary-party-retry", input, {
      expectedGeneration: 0, actionId: ACTION_ID, storage,
    })).resolves.toMatchObject({
      kind: "reconciled", pendingKind: "party_member_create",
      session: { ordinaryGeneration: 1, state: { party: [{ pcId: "p1" }, { pcId: "p2", name: "Bea" }] } },
      history: { messages: [{ content: "authoritative history" }] },
    });
    input.meta.personality = "mutated after dispatch";

    expect(calls.map(call => ({ url: call.url, body: call.body }))).toEqual([
      { url: "/api/sessions/ordinary-party-retry/party", body: { name: "Bea", archetype: "detective", personality: "careful", actionId: ACTION_ID, expectedGeneration: 0 } },
      { url: "/api/sessions/ordinary-party-retry", body: undefined },
      { url: "/api/sessions/ordinary-party-retry/history?limit=100", body: undefined },
    ]);
    for (const call of calls) expect(call.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-party-retry"))).toBe(false);
  });

  it("retains a lost party acknowledgement and reload-replays the exact owner-authenticated request", async () => {
    const storage = new MemoryStorage();
    const bodies: Record<string, unknown>[] = [];
    let partyPosts = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/party")) {
        bodies.push(JSON.parse(String(init?.body)));
        partyPosts += 1;
        if (partyPosts === 1) throw new TypeError("acknowledgement lost");
        return json({ pcId: "p2", name: "Bea", archetype: "detective", sessionKind: "ordinary", ordinaryGeneration: 1 }, 201);
      }
      return authoritative(target);
    }) as typeof fetch;

    const input = { name: "Bea", archetype: "detective", meta: { personality: "careful" } };
    await expect(partyMemberCreate("ordinary-party-retry", input, {
      expectedGeneration: 0, actionId: ACTION_ID, storage,
    })).rejects.toThrow("acknowledgement lost");
    input.meta.personality = "mutated after persistence";
    expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-party-retry"))!)).toEqual(partyPending());

    await expect(retryPendingOrdinaryAction("ordinary-party-retry", { storage })).resolves.toMatchObject({
      kind: "reconciled", pendingKind: "party_member_create", receipt: { pcId: "p2" },
    });
    expect(bodies).toEqual([
      { name: "Bea", archetype: "detective", personality: "careful", actionId: ACTION_ID, expectedGeneration: 0 },
      { name: "Bea", archetype: "detective", personality: "careful", actionId: ACTION_ID, expectedGeneration: 0 },
    ]);
    expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-party-retry"))).toBe(false);
  });

  it("serializes text, Luck, and party through the one ordinary slot", async () => {
    for (const [pending, endpoint] of [[textPending(), "/action"], [luckPending(), "/luck-spend"]] as const) {
      const storage = new MemoryStorage();
      storage.values.set(ordinaryActionPendingStorageKey("ordinary-party-retry"), JSON.stringify(pending));
      const calls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        calls.push(target);
        if (target.endsWith(endpoint)) return json({ sessionKind: "ordinary", ordinaryGeneration: 1, luck: 47 });
        return authoritative(target);
      }) as typeof fetch;
      await expect(partyMemberCreate("ordinary-party-retry", { name: "Bea", archetype: "detective" }, {
        expectedGeneration: 0, actionId: NEXT_ACTION_ID, storage,
      })).resolves.toMatchObject({ kind: "reconciled", pendingKind: endpoint === "/action" ? "text_action" : "luck_spend" });
      expect(calls[0]).toBe(`/api/sessions/ordinary-party-retry${endpoint}`);
      expect(calls).not.toContain("/api/sessions/ordinary-party-retry/party");
    }

    for (const invoke of [
      (storage: MemoryStorage) => sendSessionAction("ordinary-party-retry", "new action", { sessionKind: "ordinary", ordinaryGeneration: 0, actionId: NEXT_ACTION_ID, storage }),
      (storage: MemoryStorage) => luckSpend("ordinary-party-retry", 1, { expectedGeneration: 0, actionId: NEXT_ACTION_ID, storage }),
    ]) {
      const storage = new MemoryStorage();
      storage.values.set(ordinaryActionPendingStorageKey("ordinary-party-retry"), JSON.stringify(partyPending()));
      const calls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        calls.push(target);
        if (target.endsWith("/party")) return json({ pcId: "p2", name: "Bea", archetype: "detective", sessionKind: "ordinary", ordinaryGeneration: 1 }, 201);
        return authoritative(target);
      }) as typeof fetch;
      await expect(invoke(storage)).resolves.toMatchObject({ pendingKind: "party_member_create" });
      expect(calls.filter(target => target.endsWith("/party"))).toHaveLength(1);
      expect(calls.some(target => target.endsWith("/action") || target.endsWith("/luck-spend"))).toBe(false);
    }
  });

  it("retains 401, transport, unreadable JSON, and 5xx party outcomes", async () => {
    for (const failure of [
      () => Promise.resolve(json({ code: "OWNER_DENIED" }, 401)),
      () => Promise.reject(new TypeError("offline")),
      () => Promise.resolve(new Response("not json", { status: 201 })),
      () => Promise.resolve(json({ code: "ordinary_persistence_indeterminate" }, 503)),
    ]) {
      const storage = new MemoryStorage();
      globalThis.fetch = (async () => failure()) as unknown as typeof fetch;
      await expect(partyMemberCreate("ordinary-party-retry", { name: "Bea", archetype: "detective", meta: { personality: "careful" } }, {
        expectedGeneration: 0, actionId: ACTION_ID, storage,
      })).rejects.toThrow();
      expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-party-retry"))!)).toEqual(partyPending());
    }
  });

  it("reconciles only documented party pre-commit refusals and retains indeterminate conflicts", async () => {
    for (const [code, status, retained] of [
      ["ordinary_party_contract_required", 400, false],
      ["ordinary_party_member_rejected", 400, false],
      ["ordinary_generation_conflict", 409, false],
      ["ordinary_registry_replaced", 409, true],
    ] as const) {
      const storage = new MemoryStorage();
      storage.values.set(ordinaryActionPendingStorageKey("ordinary-party-retry"), JSON.stringify(partyPending()));
      globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        if (target.endsWith("/party")) return json({ code, ordinaryGeneration: 0 }, status);
        return authoritative(target);
      }) as typeof fetch;
      await expect(retryPendingOrdinaryAction("ordinary-party-retry", { storage })).resolves.toMatchObject({
        kind: "reconciled", pendingKind: "party_member_create", ...(retained ? { pendingRetained: true } : {}),
      });
      expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-party-retry"))).toBe(retained);
    }
  });

  it("fails closed for non-plain caller input or malformed party records and never sends pcId", async () => {
    const storage = new MemoryStorage();
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json({}); }) as unknown as typeof fetch;
    const accessorInput = { archetype: "detective", meta: { personality: "careful" } } as Record<string, unknown>;
    Object.defineProperty(accessorInput, "name", { enumerable: true, get: () => "Bea" });
    await expect(partyMemberCreate("ordinary-party-retry", accessorInput, { expectedGeneration: 0, actionId: ACTION_ID, storage })).rejects.toThrow("party");
    await expect(partyMemberCreate("ordinary-party-retry", { name: "Bea", archetype: "detective", meta: { pcId: "p99" } }, { expectedGeneration: 0, actionId: ACTION_ID, storage })).rejects.toThrow("party");
    expect(calls).toBe(0);

    storage.values.set(ordinaryActionPendingStorageKey("ordinary-party-retry"), JSON.stringify({ ...partyPending(), pcId: "p99" }));
    await expect(retryPendingOrdinaryAction("ordinary-party-retry", { storage })).resolves.toBeNull();
    expect(calls).toBe(0);
    expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-party-retry"))).toBe(false);
  });

  it("canonicalizes an empty optional meta object by omitting it from storage and the HTTP body", async () => {
    const storage = new MemoryStorage();
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/party")) {
        body = JSON.parse(String(init?.body));
        expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-party-retry"))!)).toEqual({
          version: 1, kind: "party_member_create", sessionId: "ordinary-party-retry",
          name: "Bea", archetype: "detective", actionId: ACTION_ID, expectedGeneration: 0,
        });
        return json({ pcId: "p2", sessionKind: "ordinary", ordinaryGeneration: 1 }, 201);
      }
      return authoritative(target);
    }) as typeof fetch;
    await partyMemberCreate("ordinary-party-retry", { name: "Bea", archetype: "detective", meta: {} }, {
      expectedGeneration: 0, actionId: ACTION_ID, storage,
    });
    expect(body).toEqual({ name: "Bea", archetype: "detective", actionId: ACTION_ID, expectedGeneration: 0 });
  });
});
