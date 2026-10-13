import { afterEach, expect, it } from "bun:test";
// @ts-ignore The browser client is JavaScript and deliberately has no declaration file.
import { luckSpend, ordinaryActionPendingStorageKey, retryPendingOrdinaryAction, sendSessionAction } from "../../frontend/src/api.js";

const originalFetch = globalThis.fetch;
const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf7868f";

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function luckPending(sessionId = "ordinary-luck-retry", amount = 3, expectedGeneration = 0, actionId = ACTION_ID) {
  return { version: 1, kind: "luck_spend", sessionId, amount, actionId, expectedGeneration };
}

function textPending(sessionId = "ordinary-luck-retry", expectedGeneration = 0) {
  return { version: 1, sessionId, input: "look around", pcId: "p1", actionId: ACTION_ID, expectedGeneration };
}

afterEach(() => { globalThis.fetch = originalFetch; });

it("persists the exact durable Luck request before its first POST", async () => {
  const storage = new MemoryStorage();
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-luck-retry"))!)).toEqual({
      version: 1,
      kind: "luck_spend",
      sessionId: "ordinary-luck-retry",
      amount: 3,
      actionId: ACTION_ID,
      expectedGeneration: 0,
    });
    return json({ pcId: "p1", amount: 3, previousLuck: 50, luck: 47, sessionKind: "ordinary", ordinaryGeneration: 1 });
  }) as unknown as typeof fetch;

  await expect(luckSpend("ordinary-luck-retry", 3, {
    expectedGeneration: 0,
    actionId: ACTION_ID,
    storage,
  })).resolves.toMatchObject({ luck: 47 });
  expect(calls).toEqual([{
    url: "/api/sessions/ordinary-luck-retry/luck-spend",
    body: { amount: 3, actionId: ACTION_ID, expectedGeneration: 0 },
  }]);
  expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-luck-retry"))).toBe(false);
});

it("never POSTs a Luck spend when its durable record cannot be saved", async () => {
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls += 1; return json({}); }) as unknown as typeof fetch;
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => {},
  };

  await expect(luckSpend("ordinary-luck-retry", 3, {
    expectedGeneration: 0, actionId: ACTION_ID, storage,
  })).rejects.toThrow("persisted");
  expect(networkCalls).toBe(0);
});

it("retains a lost Luck response and replays its exact endpoint/body before authoritative reconciliation", async () => {
  const storage = new MemoryStorage();
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  let posts = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (target.endsWith("/luck-spend")) {
      posts += 1;
      if (posts === 1) throw new TypeError("acknowledgement lost");
      return json({ pcId: "p1", amount: 3, previousLuck: 50, luck: 47, sessionKind: "ordinary", ordinaryGeneration: 1 });
    }
    if (target.endsWith("/history?limit=100")) return json({ messages: [{ content: "Luck spent" }] });
    return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: "ordinary-luck-retry" } });
  }) as typeof fetch;

  await expect(luckSpend("ordinary-luck-retry", 3, {
    expectedGeneration: 0, actionId: ACTION_ID, storage,
  })).rejects.toThrow("acknowledgement lost");
  expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-luck-retry"))!)).toEqual(luckPending());

  await expect(retryPendingOrdinaryAction("ordinary-luck-retry", { storage })).resolves.toMatchObject({
    kind: "reconciled",
    pendingKind: "luck_spend",
    receipt: { luck: 47, ordinaryGeneration: 1 },
    session: { ordinaryGeneration: 1 },
    history: { messages: [{ content: "Luck spent" }] },
  });
  expect(calls.filter(call => call.url.endsWith("/luck-spend"))).toEqual([
    { url: "/api/sessions/ordinary-luck-retry/luck-spend", body: { amount: 3, actionId: ACTION_ID, expectedGeneration: 0 } },
    { url: "/api/sessions/ordinary-luck-retry/luck-spend", body: { amount: 3, actionId: ACTION_ID, expectedGeneration: 0 } },
  ]);
  expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-luck-retry"))).toBe(false);
});

it("does not erase a concurrent replacement while cleaning a successful Luck receipt", async () => {
  const storage = new MemoryStorage();
  const replacement = luckPending("ordinary-luck-retry", 1, 1, "018f14a2-c2be-7b73-b291-6e64eaf78690");
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/luck-spend")) {
      storage.values.set(ordinaryActionPendingStorageKey("ordinary-luck-retry"), JSON.stringify(replacement));
      return json({ pcId: "p1", amount: 3, previousLuck: 50, luck: 47, sessionKind: "ordinary", ordinaryGeneration: 1 });
    }
    return json({});
  }) as typeof fetch;

  await expect(luckSpend("ordinary-luck-retry", 3, {
    expectedGeneration: 0, actionId: ACTION_ID, storage,
  })).resolves.toMatchObject({ luck: 47 });
  expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-luck-retry"))!)).toEqual(replacement);
});

it("serializes legacy text and structured Luck pending work through one ordinary dispatcher", async () => {
  const textStorage = new MemoryStorage();
  textStorage.values.set(ordinaryActionPendingStorageKey("ordinary-luck-retry"), JSON.stringify(textPending()));
  const textCalls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    textCalls.push(target);
    if (target.endsWith("/action")) return json({ sessionKind: "ordinary", ordinaryGeneration: 1, narrative: "look" });
    if (target.endsWith("/history?limit=100")) return json({ messages: [] });
    return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: "ordinary-luck-retry" } });
  }) as typeof fetch;
  await expect(luckSpend("ordinary-luck-retry", 3, {
    expectedGeneration: 0, actionId: "018f14a2-c2be-7b73-b291-6e64eaf78691", storage: textStorage,
  })).resolves.toMatchObject({ kind: "reconciled", pendingKind: "text_action" });
  expect(textCalls).toEqual([
    "/api/sessions/ordinary-luck-retry/action",
    "/api/sessions/ordinary-luck-retry",
    "/api/sessions/ordinary-luck-retry/history?limit=100",
  ]);

  const luckStorage = new MemoryStorage();
  luckStorage.values.set(ordinaryActionPendingStorageKey("ordinary-luck-retry"), JSON.stringify(luckPending()));
  const luckCalls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    luckCalls.push(target);
    if (target.endsWith("/luck-spend")) return json({ pcId: "p1", amount: 3, previousLuck: 50, luck: 47, sessionKind: "ordinary", ordinaryGeneration: 1 });
    if (target.endsWith("/history?limit=100")) return json({ messages: [] });
    return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: "ordinary-luck-retry" } });
  }) as typeof fetch;
  await expect(sendSessionAction("ordinary-luck-retry", "new text", {
    sessionKind: "ordinary", ordinaryGeneration: 0, pcId: "p1",
    actionId: "018f14a2-c2be-7b73-b291-6e64eaf78692", storage: luckStorage,
  })).resolves.toMatchObject({ kind: "reconciled" });
  expect(luckCalls).toEqual([
    "/api/sessions/ordinary-luck-retry/luck-spend",
    "/api/sessions/ordinary-luck-retry",
    "/api/sessions/ordinary-luck-retry/history?limit=100",
  ]);
});

it("fails closed for corrupt or unknown ordinary pending records without guessing an endpoint", async () => {
  for (const stored of [
    "not json",
    JSON.stringify({ ...luckPending(), kind: "party_member_create" }),
    JSON.stringify({ ...luckPending(), amount: 0 }),
    JSON.stringify({ ...luckPending(), extra: true }),
  ]) {
    const storage = new MemoryStorage();
    storage.values.set(ordinaryActionPendingStorageKey("ordinary-luck-retry"), stored);
    let networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls += 1; return json({}); }) as unknown as typeof fetch;
    await expect(retryPendingOrdinaryAction("ordinary-luck-retry", { storage })).resolves.toBeNull();
    expect(networkCalls).toBe(0);
    expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-luck-retry"))).toBe(false);
  }
});

it("clears only documented pre-commit Luck refusals after reconciliation and retains indeterminate failures", async () => {
  for (const [code, status] of [
    ["ordinary_luck_spend_contract_required", 400],
    ["ordinary_luck_spend_rejected", 400],
    ["ordinary_action_id_conflict", 409],
    ["ordinary_generation_conflict", 409],
    ["ordinary_live_state_stale", 409],
  ] as const) {
    const deterministicStorage = new MemoryStorage();
    deterministicStorage.values.set(ordinaryActionPendingStorageKey("ordinary-luck-retry"), JSON.stringify(luckPending()));
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/luck-spend")) return json({ code, ordinaryGeneration: 0 }, status);
      if (target.endsWith("/history?limit=100")) return json({ messages: [] });
      return json({ sessionKind: "ordinary", ordinaryGeneration: 0, summary: { id: "ordinary-luck-retry" } });
    }) as typeof fetch;
    await expect(retryPendingOrdinaryAction("ordinary-luck-retry", { storage: deterministicStorage })).resolves.toMatchObject({ kind: "reconciled" });
    expect(deterministicStorage.values.has(ordinaryActionPendingStorageKey("ordinary-luck-retry"))).toBe(false);
  }

  const storage = new MemoryStorage();
  storage.values.set(ordinaryActionPendingStorageKey("ordinary-luck-retry"), JSON.stringify(luckPending()));
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/luck-spend")) return json({ code: "ordinary_registry_replaced", ordinaryGeneration: 1 }, 409);
    if (target.endsWith("/history?limit=100")) return json({ messages: [] });
    return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: "ordinary-luck-retry" } });
  }) as typeof fetch;
  await expect(retryPendingOrdinaryAction("ordinary-luck-retry", { storage })).resolves.toMatchObject({ kind: "reconciled", pendingKind: "luck_spend", pendingRetained: true });
  expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("ordinary-luck-retry"))!)).toEqual(luckPending());

  for (const failure of [
    () => Promise.reject(new TypeError("offline")),
    () => Promise.resolve(new Response("not json", { status: 200 })),
    () => Promise.resolve(json({ code: "ordinary_persistence_indeterminate", ordinaryGeneration: 0 }, 503)),
  ]) {
    const failingStorage = new MemoryStorage();
    globalThis.fetch = (async () => failure()) as unknown as typeof fetch;
    await expect(luckSpend("ordinary-luck-retry", 3, {
      expectedGeneration: 0, actionId: ACTION_ID, storage: failingStorage,
    })).rejects.toThrow();
    expect(JSON.parse(failingStorage.values.get(ordinaryActionPendingStorageKey("ordinary-luck-retry"))!)).toEqual(luckPending());
  }
});

it("rejects invalid new Luck requests before POSTing", async () => {
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls += 1; return json({}); }) as unknown as typeof fetch;
  const storage = new MemoryStorage();
  await expect(luckSpend("ordinary-luck-retry", 0, { expectedGeneration: 0, actionId: ACTION_ID, storage })).rejects.toThrow("amount");
  await expect(luckSpend("ordinary-luck-retry", 1.5, { expectedGeneration: 0, actionId: ACTION_ID, storage })).rejects.toThrow("amount");
  await expect(luckSpend("ordinary-luck-retry", 1, { expectedGeneration: -1, actionId: ACTION_ID, storage })).rejects.toThrow("generation");
  await expect(luckSpend("ordinary-luck-retry", 1, { expectedGeneration: 0.5, actionId: ACTION_ID, storage })).rejects.toThrow("generation");
  await expect(luckSpend("ordinary-luck-retry", 1, { expectedGeneration: 0, actionId: "not-a-uuid", storage })).rejects.toThrow("actionId");
  await expect(luckSpend("ordinary/luck-retry", 1, { expectedGeneration: 0, actionId: ACTION_ID, storage })).rejects.toThrow("session ID");
  expect(networkCalls).toBe(0);
});
