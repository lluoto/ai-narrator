import { afterEach, describe, expect, it } from "bun:test";
// @ts-expect-error Browser API module intentionally has no declaration file.
import { getPlayerFacadeView, playerFacadePendingStorageKey, playerFollowupPendingStorageKey, resolvePlayerFacadeIntent, retryPendingPlayerFacadeAction, retryPendingPlayerFollowup, sendPlayerFacadeAction, sendPlayerFollowup } from "../../frontend/src/player-api.js";

const originalFetch = globalThis.fetch;
const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf7868f";
const CHOICE_ID = `choice_${"q".repeat(43)}`;
const TOPIC_BOUND = "a".repeat(64);
const CONTACT_TOKEN = `contact_${"m".repeat(43)}`;
const PREVIOUS_ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf78690";
const OTHER_ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf78691";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe("player fa莽ade browser API", () => {
  it("uses only player-view and three-field player-actions, retaining opaque retry state after a lost response", async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (calls.length === 1) throw new TypeError("response lost after commit");
      return json({ result: { status: "duplicate" }, view: { generation: 1, actions: [] } });
    }) as typeof fetch;

    await expect(sendPlayerFacadeAction("delivery-session", {
      choiceId: CHOICE_ID,
      expectedGeneration: 0,
      actionId: ACTION_ID,
      storage,
    })).rejects.toThrow("player action failed");
    const pending = JSON.parse(storage.values.get(playerFacadePendingStorageKey("delivery-session"))!);
    expect(Object.keys(pending).sort()).toEqual(["actionId", "choiceId", "expectedGeneration", "sessionId", "version"]);
    expect(JSON.stringify(pending)).not.toContain("mechanismId");
    expect(JSON.stringify(pending)).not.toContain("pcId");
    expect(JSON.stringify(pending)).not.toContain("@compiled");
    await expect(retryPendingPlayerFacadeAction("delivery-session", { storage })).resolves.toEqual({
      kind: "executed", data: { result: { status: "duplicate" }, view: { generation: 1, actions: [] } }, retried: true,
    });
    expect(calls).toEqual([
      { url: "/api/sessions/delivery-session/player-actions", body: { choiceId: CHOICE_ID, actionId: ACTION_ID, expectedGeneration: 0 } },
      { url: "/api/sessions/delivery-session/player-actions", body: { choiceId: CHOICE_ID, actionId: ACTION_ID, expectedGeneration: 0 } },
    ]);
  });

  it("refreshes the authoritative view after a 409 instead of changing its action ID", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith("/player-actions")) return json({ error: { code: "PLAYER_ACTION_CONFLICT" } }, 409);
      return json({ generation: 1, actions: [{ choiceId: "choice_next", label: "Search" }] });
    }) as typeof fetch;
    await expect(sendPlayerFacadeAction("delivery-session", {
      choiceId: CHOICE_ID, expectedGeneration: 0, actionId: ACTION_ID, storage: new MemoryStorage(),
    })).resolves.toEqual({ kind: "conflict", view: { generation: 1, actions: [{ choiceId: "choice_next", label: "Search" }] } });
    expect(calls).toEqual([
      { url: "/api/sessions/delivery-session/player-actions", body: { choiceId: CHOICE_ID, actionId: ACTION_ID, expectedGeneration: 0 } },
      { url: "/api/sessions/delivery-session/player-view", body: undefined },
    ]);
  });

  it("reads a façade view without falling back to a generic session route", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("/api/sessions/delivery-session/player-view");
      return json({ generation: 0, actions: [] });
    }) as typeof fetch;
    await expect(getPlayerFacadeView("delivery-session")).resolves.toEqual({ generation: 0, actions: [] });
  });
  it("keeps v2 player prose request-scoped while a refresh performs only token receipt lookup", async () => {
    const storage = new MemoryStorage();
    const playerInput = "I search beneath the orchard for my missing father.";
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (calls.length === 1) throw new TypeError("response lost after v2 dispatch");
      return json({ error: { code: "PLAYER_ACTION_CONFLICT" } }, 409);
    }) as typeof fetch;

    await expect(sendPlayerFacadeAction("delivery-session", {
      choiceId: CHOICE_ID,
      expectedGeneration: 0,
      actionId: ACTION_ID,
      topicBound: TOPIC_BOUND,
      playerInput,
      storage,
    })).rejects.toThrow("player action failed");
    const pending = JSON.parse(storage.values.get(playerFacadePendingStorageKey("delivery-session"))!);
    expect(Object.keys(pending).sort()).toEqual(["actionId", "choiceId", "expectedGeneration", "requiresPlayerInput", "sessionId", "topicBound", "version"]);
    expect(JSON.stringify(pending)).not.toContain(playerInput);

    await expect(retryPendingPlayerFacadeAction("delivery-session", { storage })).resolves.toEqual({ kind: "topic-required" });
    expect(storage.values.get(playerFacadePendingStorageKey("delivery-session"))).not.toBeNull();
    expect(calls).toEqual([
      {
        url: "/api/sessions/delivery-session/player-actions",
        body: { choiceId: CHOICE_ID, actionId: ACTION_ID, expectedGeneration: 0, topicBound: TOPIC_BOUND, playerInput },
      },
      {
        url: "/api/sessions/delivery-session/player-actions",
        body: { choiceId: CHOICE_ID, actionId: ACTION_ID, expectedGeneration: 0, topicBound: TOPIC_BOUND },
      },
    ]);
  });

  it("never silently downgrades partial or malformed raw-topic context into a legacy action", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json({ result: { status: "committed" }, view: { generation: 1, actions: [] } });
    }) as typeof fetch;
    const cases = [
      { topicBound: TOPIC_BOUND },
      { playerInput: "I search beneath the orchard." },
      { topicBound: "not-a-topic-token", playerInput: "I search beneath the orchard." },
    ];
    for (const [index, context] of cases.entries()) {
      const storage = new MemoryStorage();
      await expect(sendPlayerFacadeAction(`delivery-session-${index}`, {
        choiceId: CHOICE_ID,
        expectedGeneration: 0,
        actionId: ACTION_ID,
        storage,
        ...context,
      })).rejects.toThrow("player action topic context is invalid");
      expect(storage.values.size).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });

  it("classifies player prose only through player-intents, then preserves the opaque player-actions retry path", async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (call.url.endsWith("/player-intents")) {
        return json({ status: "selected", action: { choiceId: CHOICE_ID, label: "Search here" }, generation: 0 });
      }
      if (calls.length === 2) throw new TypeError("response lost after commit");
      return json({ result: { status: "duplicate" }, view: { generation: 1, actions: [] } });
    }) as typeof fetch;

    await expect(resolvePlayerFacadeIntent("delivery-session", { input: "I search here", expectedGeneration: 0 })).resolves.toEqual({
      status: "selected", action: { choiceId: CHOICE_ID, label: "Search here" }, generation: 0,
    });
    await expect(sendPlayerFacadeAction("delivery-session", {
      choiceId: CHOICE_ID, expectedGeneration: 0, actionId: ACTION_ID, storage,
    })).rejects.toThrow("player action failed");
    await expect(retryPendingPlayerFacadeAction("delivery-session", { storage })).resolves.toMatchObject({ kind: "executed", retried: true });
    expect(calls).toEqual([
      { url: "/api/sessions/delivery-session/player-intents", body: { input: "I search here", expectedGeneration: 0 } },
      { url: "/api/sessions/delivery-session/player-actions", body: { choiceId: CHOICE_ID, actionId: ACTION_ID, expectedGeneration: 0 } },
      { url: "/api/sessions/delivery-session/player-actions", body: { choiceId: CHOICE_ID, actionId: ACTION_ID, expectedGeneration: 0 } },
    ]);
  });

  it("keeps follow-up prose out of storage and reconciles stale contact pending separately from actions", async () => {
    const storage = new MemoryStorage();
    const raw = "What did you personally see at the door?";
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (call.url.endsWith("/player-followups") && calls.filter((entry) => entry.url.endsWith("/player-followups")).length === 1) throw new TypeError("lost followup response");
      if (call.url.endsWith("/player-view")) return json({ generation: 1, presentation: { contacts: [] } });
      return json({ status: "delivered", followup: { text: "Mira does not know." }, view: { generation: 0, actions: [] } });
    }) as typeof fetch;

    await expect(sendPlayerFollowup("delivery-session", { contactToken: CONTACT_TOKEN, expectedGeneration: 0, actionId: ACTION_ID, playerInput: raw, storage })).rejects.toThrow("player followup failed");
    const pending = JSON.parse(storage.values.get(playerFollowupPendingStorageKey("delivery-session"))!);
    expect(Object.keys(pending).sort()).toEqual(["actionId", "contactToken", "expectedGeneration", "requiresPlayerInput", "sessionId", "version"]);
    expect(JSON.stringify(pending)).not.toContain(raw);
    await expect(retryPendingPlayerFollowup("delivery-session", { storage })).resolves.toEqual({ kind: "conflict", view: { generation: 1, presentation: { contacts: [] } } });
    expect(storage.values.get(playerFollowupPendingStorageKey("delivery-session"))).toBeUndefined();
    // A stale follow-up never occupies the ordinary action pending key.
    expect(storage.values.get(playerFacadePendingStorageKey("delivery-session"))).toBeUndefined();
    expect(calls).toEqual([
      { url: "/api/sessions/delivery-session/player-followups", body: { contactToken: CONTACT_TOKEN, actionId: ACTION_ID, expectedGeneration: 0, playerInput: raw } },
      { url: "/api/sessions/delivery-session/player-view", body: undefined },
    ]);
  });

  it("freezes the previous action alongside the original pending action ID until its receipt is confirmed", async () => {
    const storage = new MemoryStorage();
    const calls: unknown[] = [];
    const raw = "Where did that person go?";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) throw new TypeError("response lost");
      return json({ status: "replayed", followup: { text: "Toward the lighthouse." }, view: { generation: 3 } });
    }) as typeof fetch;
    await expect(sendPlayerFollowup("delivery-session", {
      contactToken: CONTACT_TOKEN, expectedGeneration: 3, actionId: ACTION_ID,
      previousActionId: PREVIOUS_ACTION_ID, playerInput: raw, storage,
    })).rejects.toThrow("player followup failed");
    const pending = JSON.parse(storage.values.get(playerFollowupPendingStorageKey("delivery-session"))!);
    expect(pending).toEqual({ version: 4, sessionId: "delivery-session", contactToken: CONTACT_TOKEN, actionId: ACTION_ID, expectedGeneration: 3, requiresPlayerInput: true, previousActionId: PREVIOUS_ACTION_ID });
    expect(JSON.stringify(pending)).not.toContain(raw);
    const result = await sendPlayerFollowup("delivery-session", {
      contactToken: CONTACT_TOKEN, expectedGeneration: 3, actionId: OTHER_ACTION_ID,
      previousActionId: OTHER_ACTION_ID, playerInput: raw, storage,
    });
    expect(result.kind).toBe("delivered");
    expect(result.actionId).toBe(ACTION_ID);
    expect(calls).toEqual([
      { contactToken: CONTACT_TOKEN, actionId: ACTION_ID, expectedGeneration: 3, playerInput: raw, previousActionId: PREVIOUS_ACTION_ID },
      { contactToken: CONTACT_TOKEN, actionId: ACTION_ID, expectedGeneration: 3, playerInput: raw, previousActionId: PREVIOUS_ACTION_ID },
    ]);
    expect(storage.values.size).toBe(0);
  });

  it("retries an existing v3 record without adding the new caller's previous action", async () => {
    const storage = new MemoryStorage();
    storage.setItem(playerFollowupPendingStorageKey("delivery-session"), JSON.stringify({
      version: 3, sessionId: "delivery-session", contactToken: CONTACT_TOKEN, actionId: ACTION_ID, expectedGeneration: 3, requiresPlayerInput: true,
    }));
    const calls: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return json({ status: "replayed", followup: { text: "Mira remembers the dock." }, view: { generation: 3 } });
    }) as typeof fetch;
    const result = await sendPlayerFollowup("delivery-session", { contactToken: CONTACT_TOKEN, expectedGeneration: 3, previousActionId: PREVIOUS_ACTION_ID, playerInput: "Same question again", storage });
    expect(result.actionId).toBe(ACTION_ID);
    expect(calls).toEqual([{ contactToken: CONTACT_TOKEN, actionId: ACTION_ID, expectedGeneration: 3, playerInput: "Same question again" }]);
    expect(storage.values.size).toBe(0);
  });

  it("retains an unknown successful-HTTP response as pending instead of promoting its action", async () => {
    const storage = new MemoryStorage();
    globalThis.fetch = Object.assign(async () => json({ status: "unknown", view: { generation: 3 } }), { preconnect: originalFetch.preconnect });
    await expect(sendPlayerFollowup("delivery-session", {
      contactToken: CONTACT_TOKEN, expectedGeneration: 3, actionId: ACTION_ID,
      previousActionId: PREVIOUS_ACTION_ID, playerInput: "Where did that person go?", storage,
    })).rejects.toThrow("player followup response is invalid");
    expect(JSON.parse(storage.values.get(playerFollowupPendingStorageKey("delivery-session"))!)).toMatchObject({ actionId: ACTION_ID, previousActionId: PREVIOUS_ACTION_ID });
  });

  it("discards malformed v3/v4 context records before any network attempt", async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(async () => { calls += 1; throw new Error("malformed pending reached fetch"); }, { preconnect: originalFetch.preconnect });
    const base = { sessionId: "delivery-session", contactToken: CONTACT_TOKEN, actionId: ACTION_ID, expectedGeneration: 3, requiresPlayerInput: true };
    const malformed = [
      { ...base, version: 3, previousActionId: PREVIOUS_ACTION_ID },
      { ...base, version: 4 },
      { ...base, version: 4, previousActionId: PREVIOUS_ACTION_ID, contextHash: "a".repeat(64) },
      { ...base, version: 4, previousActionId: null },
      { ...base, version: 4, previousActionId: ACTION_ID },
      { ...base, version: 4, previousActionId: "not-an-action-id" },
    ];
    for (const record of malformed) {
      const storage = new MemoryStorage();
      storage.setItem(playerFollowupPendingStorageKey("delivery-session"), JSON.stringify(record));
      expect(await retryPendingPlayerFollowup("delivery-session", { storage })).toBeNull();
      expect(storage.values.size).toBe(0);
    }
    expect(calls).toBe(0);
  });
});
