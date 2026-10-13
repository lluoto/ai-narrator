import { expect, test } from "bun:test";
// @ts-ignore Browser-neutral helper is intentionally JavaScript.
import { ordinaryPartyMemberCreateOutcome, ordinaryPartyMemberCreateRequest, ordinaryPartyMemberCreateVisible, ordinaryPendingKindFromDurableStorage, submitOrdinaryPartyMemberCreate } from "../../frontend/src/ordinary-party-member-create-controller.js";
// @ts-ignore Browser API intentionally has no declarations.
import { ordinaryActionPendingStorageKey, partyMemberCreate, pendingOrdinaryActionKind } from "../../frontend/src/api.js";

const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf7868f";

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

/**
 * Exercise the real `<script setup>` state transitions without a browser
 * renderer.  Vue's refs/watchers are deliberately tiny here: this test is
 * about which durable ordinary slot App.vue selects on a session transition,
 * not DOM rendering.
 */
async function loadOwnerAppSessionHarness(input: {
  createSession: () => Promise<Record<string, unknown>>;
  pendingKind: (sessionId: string) => string | null;
  retryPending: (sessionId: string) => Promise<unknown>;
}) {
  const sfc = await Bun.file("frontend/src/App.vue").text();
  const match = /<script setup>\s*([\s\S]*?)<\/script>/.exec(sfc);
  if (!match) throw new Error("App script setup is required");
  const script = match[1]!.replace(/^import .*$/gm, "");
  const ref = <T>(value: T) => ({ value });
  const reactive = <T>(value: T) => value;
  const computed = <T>(getter: () => T) => ({ get value() { return getter(); } });
  const noop = () => {};
  const nextTick = async () => {};
  class AudioStub {
    volume = 0;
    src = "";
    play() { return Promise.resolve(); }
    pause() {}
  }
  const factory = new Function(
    "deps",
    `const {
      ref, reactive, computed, watch, nextTick, Audio,
      createSession, sendSessionAction, retryPendingCompiledAction, retryPendingOrdinaryAction,
      pendingOrdinaryActionKind, compiledSessionGeneration, ordinarySessionGeneration,
      getArchetypes, getSuggestions, getCompiledActions, getHistory, listSessions, getSession,
      luckSpend, partyMemberCreate, ordinaryLuckFromAuthoritativeState, ordinaryLuckFromCreateResponse,
      ordinaryLuckSpendOutcome, ordinaryLuckSpendRequest, ordinaryLuckSpendVisible, submitOrdinaryLuckSpend,
      ordinaryPartyMemberCreateOutcome, ordinaryPartyMemberCreateRequest, ordinaryPartyMemberCreateVisible,
      ordinaryPendingKindFromDurableStorage, submitOrdinaryPartyMemberCreate,
      clearOwnerBearer, ownerFetch, setOwnerBearer
    } = deps;
    ${script}
    return { startGame, newGame, session, ordinaryPendingKind, loading, screen };`,
  ) as (deps: Record<string, unknown>) => {
    startGame: () => Promise<void>;
    newGame: () => void;
    session: Record<string, unknown>;
    ordinaryPendingKind: { value: string | null };
    loading: { value: boolean };
    screen: { value: string };
  };
  const ordinaryGeneration = (payload: any, kind?: string) => kind === "ordinary" && Number.isSafeInteger(payload?.ordinaryGeneration)
    ? payload.ordinaryGeneration : null;
  return factory({
    ref, reactive, computed, watch: noop, nextTick, Audio: AudioStub,
    createSession: input.createSession,
    sendSessionAction: async () => ({}), retryPendingCompiledAction: async () => null,
    retryPendingOrdinaryAction: input.retryPending,
    pendingOrdinaryActionKind: input.pendingKind,
    compiledSessionGeneration: () => null, ordinarySessionGeneration: ordinaryGeneration,
    getArchetypes: async () => ({ archetypes: [] }), getSuggestions: async () => [], getCompiledActions: async () => ({}),
    getHistory: async () => ({ messages: [] }), listSessions: async () => [], getSession: async () => ({}),
    luckSpend: async () => ({}), partyMemberCreate: async () => ({}),
    ordinaryLuckFromAuthoritativeState: () => null, ordinaryLuckFromCreateResponse: () => null,
    ordinaryLuckSpendOutcome: () => ({ kind: "invalid" }), ordinaryLuckSpendRequest: () => null,
    ordinaryLuckSpendVisible: () => false, submitOrdinaryLuckSpend: async () => ({ kind: "not-submitted" }),
    ordinaryPartyMemberCreateOutcome, ordinaryPartyMemberCreateRequest, ordinaryPartyMemberCreateVisible,
    ordinaryPendingKindFromDurableStorage, submitOrdinaryPartyMemberCreate,
    clearOwnerBearer: noop, ownerFetch: async () => new Response(), setOwnerBearer: noop,
  });
}

const ready = {
  sessionKind: "ordinary",
  ordinaryGeneration: 7,
  loading: false,
  terminal: null,
  pendingKind: null,
  name: "Bea",
  archetype: "detective",
};

test("ordinary party UI admits only a current authoritative session without optimistic PC identity", async () => {
  expect(ordinaryPartyMemberCreateVisible(ready)).toBe(true);
  expect(ordinaryPartyMemberCreateVisible({ ...ready, sessionKind: "compiled" })).toBe(false);
  expect(ordinaryPartyMemberCreateVisible({ ...ready, sessionKind: "unknown" })).toBe(false);
  expect(ordinaryPartyMemberCreateRequest(ready)).toEqual({ name: "Bea", archetype: "detective", expectedGeneration: 7 });
  expect(ordinaryPartyMemberCreateRequest({ ...ready, meta: { personality: "careful" } })).toEqual({
    name: "Bea", archetype: "detective", meta: { personality: "careful" }, expectedGeneration: 7,
  });
  expect(ordinaryPartyMemberCreateRequest({ ...ready, meta: {} })).toEqual({ name: "Bea", archetype: "detective", expectedGeneration: 7 });
  const calls: unknown[] = [];
  await expect(submitOrdinaryPartyMemberCreate(ready, async (request: unknown) => {
    calls.push(request);
    return { pcId: "p2", ordinaryGeneration: 8 };
  })).resolves.toMatchObject({ kind: "submitted", request: { name: "Bea", archetype: "detective", expectedGeneration: 7 } });
  expect(calls).toEqual([{ name: "Bea", archetype: "detective", expectedGeneration: 7 }]);
  expect(JSON.stringify(calls[0])).not.toContain("pcId");

  for (const invalid of [
    { ...ready, sessionKind: "compiled" }, { ...ready, sessionKind: "unknown" },
    { ...ready, ordinaryGeneration: null }, { ...ready, loading: true },
    { ...ready, terminal: { kind: "death" } }, { ...ready, pendingKind: "party_member_create" },
    { ...ready, pendingKind: "text_action" }, { ...ready, name: " Bea" },
    { ...ready, archetype: "" }, { ...ready, name: "x".repeat(129) },
    { ...ready, meta: { pcId: "p99" } },
  ]) {
    await expect(submitOrdinaryPartyMemberCreate(invalid, async (request: unknown) => {
      calls.push(request);
      return {};
    })).resolves.toEqual({ kind: "not-submitted" });
  }
  expect(calls).toHaveLength(1);
});

test("party UI distinguishes shared queue recovery from a confirmed party receipt", () => {
  expect(ordinaryPartyMemberCreateOutcome({ kind: "reconciled", pendingKind: "party_member_create", receipt: { pcId: "p2" } })).toEqual({ kind: "party-reconciled" });
  expect(ordinaryPartyMemberCreateOutcome({ kind: "reconciled", pendingKind: "party_member_create" })).toEqual({ kind: "party-not-confirmed" });
  expect(ordinaryPartyMemberCreateOutcome({ kind: "reconciled", pendingKind: "party_member_create", pendingRetained: true })).toEqual({ kind: "party-pending" });
  expect(ordinaryPartyMemberCreateOutcome({ kind: "reconciled", pendingKind: "luck_spend" })).toEqual({ kind: "other-reconciled", pendingKind: "luck_spend" });
  expect(ordinaryPartyMemberCreateOutcome({ kind: "reconciled", pendingKind: "text_action", pendingRetained: true })).toEqual({ kind: "other-pending", pendingKind: "text_action" });
});

test("a pre-persist party failure re-enables the controller from the real slot, while an ambiguous persisted failure remains pending", async () => {
  const unavailableStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => {},
  };
  await expect(partyMemberCreate("ordinary-party-ui", { name: "Bea", archetype: "detective" }, {
    expectedGeneration: 7, actionId: ACTION_ID, storage: unavailableStorage,
  })).rejects.toThrow("persisted");
  const noDurablePending = ordinaryPendingKindFromDurableStorage(
    () => pendingOrdinaryActionKind("ordinary-party-ui", { storage: unavailableStorage }),
  );
  expect(noDurablePending).toBeNull();
  expect(ordinaryPartyMemberCreateRequest({ ...ready, pendingKind: noDurablePending })).toEqual({
    name: "Bea", archetype: "detective", expectedGeneration: 7,
  });

  const storage = new MemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
  try {
    await expect(partyMemberCreate("ordinary-party-ui", { name: "Bea", archetype: "detective" }, {
      expectedGeneration: 7, actionId: ACTION_ID, storage,
    })).rejects.toThrow("offline");
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(storage.values.has(ordinaryActionPendingStorageKey("ordinary-party-ui"))).toBe(true);
  const durablePending = ordinaryPendingKindFromDurableStorage(
    () => pendingOrdinaryActionKind("ordinary-party-ui", { storage }),
  );
  expect(durablePending).toBe("party_member_create");
  expect(ordinaryPartyMemberCreateRequest({ ...ready, pendingKind: durablePending })).toBeNull();
});

test("new-game transition drops an old ordinary pending indicator but coordinates the new session's own durable slot", async () => {
  const retried: string[] = [];
  const freshSession = {
    sessionId: "ordinary-new-session",
    sessionKind: "ordinary",
    ordinaryGeneration: 0,
    characterName: "Fresh",
    summary: { id: "ordinary-new-session", round: 1, scene: "opening", ruleset: "cosmic-horror", playerName: "Fresh", archetype: "detective" },
    character: { hp: 10, maxHp: 10, attributes: { power: 50 } },
    opening: "opening",
  };
  const app = await loadOwnerAppSessionHarness({
    createSession: async () => freshSession,
    pendingKind: (sessionId) => sessionId === "ordinary-new-session" ? "party_member_create" : null,
    retryPending: async (sessionId) => {
      retried.push(sessionId);
      return sessionId === "ordinary-new-session"
        ? {
          kind: "reconciled",
          pendingKind: "party_member_create",
          pendingRetained: true,
          session: {
            sessionKind: "ordinary", ordinaryGeneration: 0,
            summary: freshSession.summary,
            state: { party: [{ pcId: "p1", name: "Fresh" }] },
          },
          history: { messages: [] },
        }
        : null;
    },
  });

  // Simulates a prior session's text/Luck/party request still reflected by the
  // in-memory indicator when the owner exits it for a new game.
  for (const oldPending of ["text_action", "luck_spend", "party_member_create"] as const) {
    app.ordinaryPendingKind.value = oldPending;
    app.newGame();
    await app.startGame();
    expect(app.session.id).toBe("ordinary-new-session");
    expect(app.ordinaryPendingKind.value).toBe("party_member_create");
  }
  expect(retried).toEqual(["ordinary-new-session", "ordinary-new-session", "ordinary-new-session"]);
});

test("Owner App wires the party form only through the durable controller", async () => {
  const app = await Bun.file("frontend/src/App.vue").text();
  const playerApp = await Bun.file("frontend/src/PlayerApp.vue").text();
  expect(app).toContain("submitOrdinaryPartyMemberCreate(");
  expect(app).toContain("ordinaryPartyMemberCreateVisibleForSession");
  expect(app).toContain('@submit.prevent="submitPartyMemberCreate"');
  expect(app).toContain('for="ordinary-party-member-name"');
  expect(app).toContain("resyncOrdinaryPendingKind()");
  const partySubmit = app.slice(app.indexOf("async function submitPartyMemberCreate"), app.indexOf("async function resumeSession"));
  const luckSubmit = app.slice(app.indexOf("async function submitLuckSpend"), app.indexOf("async function submitPartyMemberCreate"));
  expect(partySubmit).toContain("resyncOrdinaryPendingAfterFailure()");
  expect(luckSubmit).toContain("resyncOrdinaryPendingAfterFailure()");
  expect(app).not.toContain("partyMemberCreate(session.id, { name: partyMemberName.value, archetype: partyMemberArchetype.value, pcId");
  expect(playerApp).not.toContain("ordinary-party-member-name");
  expect(playerApp).not.toContain("partyMemberCreate(");
});
