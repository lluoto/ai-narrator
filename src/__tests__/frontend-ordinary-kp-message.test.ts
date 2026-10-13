import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
// @ts-ignore The owner browser client is deliberately plain JavaScript.
import { ordinaryActionPendingStorageKey, ordinaryKpMessage, pendingOrdinaryActionKind, retryPendingOrdinaryAction } from "../../frontend/src/api.js";
// @ts-ignore Owner credentials are kept only in browser-module memory.
import { clearOwnerBearer, setOwnerBearer } from "../../frontend/src/owner-auth.js";
// @ts-ignore UI gate is browser-neutral JavaScript.
import { ordinaryPendingKindFromDurableStorage } from "../../frontend/src/ordinary-party-member-create-controller.js";

const originalFetch = globalThis.fetch;
const SESSION_ID = "ordinary-kp-browser";
const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf7868f";
const OWNER_TOKEN = "k".repeat(48);
const BACKEND_CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const backendAuth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "frontend-kp-owner" } });

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function pending(actionId = ACTION_ID) {
  return {
    version: 1, kind: "kp_message", sessionId: SESSION_ID,
    speaker: "Keeper", content: "The bell rings.", type: "narration",
    actionId, expectedGeneration: 0,
  };
}

function receipt() {
  return {
    message: { speaker: "Keeper", content: "The bell rings.", type: "narration", timestamp: 1234 },
    summary: {
      id: SESSION_ID, round: 1, ruleset: "cosmic-horror", scene: "opening",
      playerName: "Ada", archetype: "detective", messageCount: 1, npcCount: 0, createdAt: 0,
    },
    sessionKind: "ordinary", ordinaryGeneration: 1,
  };
}

type OrdinarySummaryFixture = Omit<ReturnType<typeof receipt>["summary"], "archetype"> & { archetype: string | null };

function authoritativeSession({ generation = 1, summary = receipt().summary, id = SESSION_ID }: {
  generation?: number; summary?: OrdinarySummaryFixture; id?: string;
} = {}) {
  return {
    summary: { ...summary, id },
    state: { round: generation, scene: "opening", player: { hp: 10, maxHp: 10, luck: 50 } },
    sanity: { currentSAN: 50, maxSAN: 99 },
    history: [],
    sessionKind: "ordinary", ordinaryGeneration: generation, dead: false, terminal: null,
  };
}

function authority(target: string) {
  if (target.endsWith("/history?limit=100")) return json({
    messages: [{ speaker: "Keeper", content: "The bell rings.", type: "narration" }], total: 1,
  });
  return json({
    ...authoritativeSession(),
  });
}

function backendRuntime() {
  const registry = new Map<string, GameSession>();
  const dependencies: SessionRuntimeDependencies = {
    registry,
    ordinaryIntentPolicy: "development_fallback",
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
      const session = new GameSession(id, ruleset, BACKEND_CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
      session.getOpeningScene = async () => "opening";
      return session;
    },
  };
  return { registry, dependencies };
}

async function backendRequest(root: string, dependencies: SessionRuntimeDependencies, path: string, body?: unknown) {
  return handleRequest(new Request(`http://test${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, backendAuth,
  undefined, undefined, undefined, { mode: "required" }, dependencies);
}

afterEach(() => {
  clearOwnerBearer();
  globalThis.fetch = originalFetch;
});

describe("ordinary durable KP announcement browser queue", () => {
  it("persists the canonical closed request before its owner-authenticated POST, then replaces UI authority by GET", async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ url: string; method?: string; body?: unknown; authorization: string | null }> = [];
    setOwnerBearer(OWNER_TOKEN);
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({
        url: target, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (target.endsWith("/kp/send-message")) {
        expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey(SESSION_ID))!)).toEqual(pending());
        return json(receipt());
      }
      return authority(target);
    }) as typeof fetch;

    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: " Keeper ", content: " The bell rings. ", type: " narration ",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage })).resolves.toMatchObject({
      kind: "reconciled", pendingKind: "kp_message", receipt: receipt(),
      session: { ordinaryGeneration: 1 }, history: { messages: [{ content: "The bell rings." }] },
    });
    expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: `/api/sessions/${SESSION_ID}/kp/send-message`, method: "POST", body: {
        actionId: ACTION_ID, expectedGeneration: 0, message: "The bell rings.", speaker: "Keeper", type: "narration",
      } },
      { url: `/api/sessions/${SESSION_ID}`, method: undefined, body: undefined },
      { url: `/api/sessions/${SESSION_ID}/history?limit=100`, method: undefined, body: undefined },
    ]);
    for (const call of calls) expect(call.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(storage.values.has(ordinaryActionPendingStorageKey(SESSION_ID))).toBe(false);
  });

  it("keeps a lost or malformed acknowledgement and replays the exact pending request rather than minting a new announcement", async () => {
    const storage = new MemoryStorage();
    const postBodies: unknown[] = [];
    let posts = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/kp/send-message")) {
        postBodies.push(JSON.parse(String(init?.body)));
        posts += 1;
        if (posts === 1) throw new TypeError("acknowledgement lost");
        return json(receipt());
      }
      return authority(target);
    }) as typeof fetch;
    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: "Keeper", content: "The bell rings.", type: "narration",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage })).rejects.toThrow("acknowledgement lost");
    expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey(SESSION_ID))!)).toEqual(pending());

    await expect(retryPendingOrdinaryAction(SESSION_ID, { storage })).resolves.toMatchObject({
      kind: "reconciled", pendingKind: "kp_message", receipt: receipt(),
    });
    expect(postBodies).toEqual([
      { actionId: ACTION_ID, expectedGeneration: 0, message: "The bell rings.", speaker: "Keeper", type: "narration" },
      { actionId: ACTION_ID, expectedGeneration: 0, message: "The bell rings.", speaker: "Keeper", type: "narration" },
    ]);
    expect(storage.values.has(ordinaryActionPendingStorageKey(SESSION_ID))).toBe(false);

    const malformedStorage = new MemoryStorage();
    globalThis.fetch = (async () => json({ ...receipt(), message: { ...receipt().message, timestamp: "forged" } })) as unknown as typeof fetch;
    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: "Keeper", content: "The bell rings.", type: "narration",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage: malformedStorage })).rejects.toThrow("receipt");
    expect(JSON.parse(malformedStorage.values.get(ordinaryActionPendingStorageKey(SESSION_ID))!)).toEqual(pending());
  });

  it("canonicalizes omitted speaker/type into the closed durable record before POST", async () => {
    const storage = new MemoryStorage();
    const canonical = {
      ...receipt(),
      message: { speaker: "守秘人", content: "A default announcement.", type: "system", timestamp: 9 },
    };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/kp/send-message")) {
        expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey(SESSION_ID))!)).toEqual({
          version: 1, kind: "kp_message", sessionId: SESSION_ID,
          speaker: "守秘人", content: "A default announcement.", type: "system",
          actionId: ACTION_ID, expectedGeneration: 0,
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          actionId: ACTION_ID, expectedGeneration: 0, message: "A default announcement.", speaker: "守秘人", type: "system",
        });
        return json(canonical);
      }
      if (target.endsWith("/history?limit=100")) return json({ messages: [], total: 0 });
      return json(authoritativeSession({ summary: canonical.summary }));
    }) as typeof fetch;
    await expect(ordinaryKpMessage(SESSION_ID, { content: " A default announcement. " }, {
      expectedGeneration: 0, actionId: ACTION_ID, storage,
    })).resolves.toMatchObject({ kind: "reconciled", receipt: canonical });
  });

  it("coordinates another ordinary kind first and retires only documented pre-commit KP refusals", async () => {
    const storage = new MemoryStorage();
    storage.values.set(ordinaryActionPendingStorageKey(SESSION_ID), JSON.stringify({
      version: 1, kind: "luck_spend", sessionId: SESSION_ID, amount: 1,
      actionId: "018f14a2-c2be-7b73-b291-6e64eaf78690", expectedGeneration: 0,
    }));
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url); calls.push(target);
      if (target.endsWith("/luck-spend")) return json({ sessionKind: "ordinary", ordinaryGeneration: 1, luck: 49 });
      return authority(target);
    }) as typeof fetch;
    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: "Keeper", content: "The bell rings.", type: "narration",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage })).resolves.toMatchObject({
      kind: "reconciled", pendingKind: "luck_spend",
    });
    expect(calls.some(call => call.endsWith("/kp/send-message"))).toBe(false);

    for (const [code, status, retained] of [
      ["ordinary_kp_message_contract_required", 400, false],
      ["ordinary_kp_message_rejected", 409, false],
      ["ordinary_generation_conflict", 409, false],
      ["ordinary_registry_replaced", 409, true],
    ] as const) {
      const refusalStorage = new MemoryStorage();
      refusalStorage.values.set(ordinaryActionPendingStorageKey(SESSION_ID), JSON.stringify(pending()));
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).endsWith("/kp/send-message")) return json({ code, ordinaryGeneration: 0 }, status);
        return authority(String(url));
      }) as typeof fetch;
      const result = await retryPendingOrdinaryAction(SESSION_ID, { storage: refusalStorage });
      expect(result).toMatchObject({ kind: "reconciled", pendingKind: "kp_message", ...(retained ? { pendingRetained: true } : {}) });
      expect(refusalStorage.values.has(ordinaryActionPendingStorageKey(SESSION_ID))).toBe(retained);
    }
  });

  it("retains a KP request until its owner GET session/history prove the exact ordinary successor, while accepting nullable summary archetype", async () => {
    const poisonStorage = new MemoryStorage();
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/kp/send-message")) return json(receipt());
      if (target.endsWith("/history?limit=100")) return json({ messages: [], total: 0 });
      return json(authoritativeSession({ generation: 0 }));
    }) as typeof fetch;
    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: "Keeper", content: "The bell rings.", type: "narration",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage: poisonStorage })).rejects.toThrow("ordinary_kp_message_authority_unconfirmed");
    expect(JSON.parse(poisonStorage.values.get(ordinaryActionPendingStorageKey(SESSION_ID))!)).toEqual(pending());

    const nullableStorage = new MemoryStorage();
    const nullable = {
      ...receipt(),
      summary: { ...receipt().summary, archetype: null as string | null },
    };
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/kp/send-message")) return json(nullable);
      if (target.endsWith("/history?limit=100")) return json({ messages: [], total: 0 });
      return json(authoritativeSession({ summary: nullable.summary }));
    }) as typeof fetch;
    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: "Keeper", content: "The bell rings.", type: "narration",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage: nullableStorage })).resolves.toMatchObject({
      kind: "reconciled", pendingKind: "kp_message", receipt: { summary: { archetype: null } },
    });
  });

  it("accepts the exact ordinary GET session/history shape emitted by the real backend", async () => {
    const root = mkdtempSync(join(tmpdir(), "frontend-kp-authority-contract-"));
    const runtime = backendRuntime();
    const storage = new MemoryStorage();
    try {
      const created = await backendRequest(root, runtime.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      const input = { actionId: ACTION_ID, expectedGeneration: 0, message: "The bell rings.", speaker: "Keeper", type: "narration" };
      const committed = await backendRequest(root, runtime.dependencies, `/api/sessions/${id}/kp/send-message`, input);
      expect(committed.status).toBe(200);
      const committedReceipt = await committed.json();
      const authoritativeSession = await backendRequest(root, runtime.dependencies, `/api/sessions/${id}`);
      const authoritativeHistory = await backendRequest(root, runtime.dependencies, `/api/sessions/${id}/history?limit=100`);
      expect(authoritativeSession.status).toBe(200);
      expect(authoritativeHistory.status).toBe(200);
      const sessionBody = await authoritativeSession.json() as Record<string, unknown>;
      const historyBody = await authoritativeHistory.json() as Record<string, unknown>;
      expect(Object.keys(sessionBody).sort()).toEqual(["dead", "history", "ordinaryGeneration", "sanity", "sessionKind", "state", "summary", "terminal"]);
      expect(Object.keys(historyBody).sort()).toEqual(["messages", "total"]);

      globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        if (target.endsWith("/kp/send-message")) return json(committedReceipt);
        if (target.endsWith("/history?limit=100")) return json(historyBody);
        if (target.endsWith(`/api/sessions/${id}`)) return json(sessionBody);
        throw new Error(`unexpected frontend authority request ${target}`);
      }) as typeof fetch;
      await expect(ordinaryKpMessage(id, { speaker: "Keeper", content: "The bell rings.", type: "narration" }, {
        expectedGeneration: 0, actionId: ACTION_ID, storage,
      })).resolves.toMatchObject({ kind: "reconciled", pendingKind: "kp_message", session: sessionBody, history: historyBody });
    } finally {
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not POST when durable storage/input is invalid and never accepts a generation-only success", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json({}); }) as unknown as typeof fetch;
    const unavailable = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: "Keeper", content: "The bell rings.", type: "narration",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage: unavailable })).rejects.toThrow("persisted");
    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: "Keeper", content: " ", type: "narration",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage: new MemoryStorage() })).rejects.toThrow("message");
    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: "Keeper", content: "x".repeat(8001), type: "narration",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage: new MemoryStorage() })).rejects.toThrow("message");
    await expect(ordinaryKpMessage(SESSION_ID, {
      speaker: "Keeper", content: "The bell rings.", type: "narration", source: "forbidden",
    }, { expectedGeneration: 0, actionId: ACTION_ID, storage: new MemoryStorage() })).rejects.toThrow("message");
    expect(calls).toBe(0);
  });

  it("keeps character and KP records visibly blocking after reload without admitting unknown kinds", () => {
    expect(ordinaryPendingKindFromDurableStorage(() => "character_patch")).toBe("character_patch");
    expect(ordinaryPendingKindFromDurableStorage(() => "kp_message")).toBe("kp_message");
    expect(ordinaryPendingKindFromDurableStorage(() => "forged_operation")).toBeNull();
    const storage = new MemoryStorage();
    storage.values.set(ordinaryActionPendingStorageKey(SESSION_ID), JSON.stringify(pending()));
    expect(pendingOrdinaryActionKind(SESSION_ID, { storage })).toBe("kp_message");
  });

  it("has App coordinate the shared slot, then apply only reconciled owner session/history authority", async () => {
    const sfc = await Bun.file("frontend/src/App.vue").text();
    const match = /<script setup>\s*([\s\S]*?)<\/script>/.exec(sfc);
    if (!match) throw new Error("App script setup is required");
    const script = match[1]!.replace(/^import .*$/gm, "");
    const ref = <T>(value: T) => ({ value });
    const reactive = <T>(value: T) => value;
    const computed = <T>(getter: () => T) => ({ get value() { return getter(); } });
    const noop = () => {};
    class AudioStub { volume = 0; src = ""; play() { return Promise.resolve(); } pause() {} }
    const factory = new Function("deps", `
      const {
        ref, reactive, computed, watch, nextTick, Audio,
        retryPendingOrdinaryAction, pendingOrdinaryActionKind, ordinarySessionGeneration,
        ordinaryLuckFromAuthoritativeState, ordinaryPendingKindFromDurableStorage, ordinaryKpMessage
      } = deps;
      ${script}
      return { session, messages, ordinaryPendingKind, loading, error, submitOrdinaryKpMessage };
    `) as (deps: Record<string, unknown>) => Record<string, any>;
    const kpCalls: Array<{ sessionId: string; input: Record<string, unknown>; expectedGeneration: number }> = [];
    const ordinaryGeneration = (payload: any, kind?: string) => kind === "ordinary" && Number.isSafeInteger(payload?.ordinaryGeneration)
      ? payload.ordinaryGeneration : null;
    const app = factory({
      ref, reactive, computed, watch: noop, nextTick: async () => {}, Audio: AudioStub,
      retryPendingOrdinaryAction: async () => null,
      pendingOrdinaryActionKind: () => null,
      ordinarySessionGeneration: ordinaryGeneration,
      ordinaryLuckFromAuthoritativeState: (payload: any) => payload?.state?.player?.luck ?? null,
      ordinaryPendingKindFromDurableStorage: (read: () => unknown) => read(),
      ordinaryKpMessage: async (sessionId: string, input: Record<string, unknown>, options: { expectedGeneration: number }) => {
        kpCalls.push({ sessionId, input, expectedGeneration: options.expectedGeneration });
        return {
          kind: "reconciled", pendingKind: "kp_message", receipt: receipt(),
          session: { sessionKind: "ordinary", ordinaryGeneration: 4, summary: receipt().summary,
            state: { round: 4, scene: "tower", player: { hp: 9, maxHp: 10, luck: 48 } } },
          history: { messages: [{ speaker: "Keeper", content: "The bell rings.", type: "narration" }] },
        };
      },
    });
    Object.assign(app.session, {
      id: SESSION_ID, sessionKind: "ordinary", ordinaryGeneration: 3,
      ruleset: "cosmic-horror", terminal: null, dead: false,
    });
    await expect(app.submitOrdinaryKpMessage({ speaker: "Keeper", content: "The bell rings.", type: "narration" })).resolves.toEqual({ kind: "sent" });
    expect(kpCalls).toEqual([{ sessionId: SESSION_ID, input: { speaker: "Keeper", content: "The bell rings.", type: "narration" }, expectedGeneration: 3 }]);
    expect(app.session.ordinaryGeneration).toBe(4);
    expect(app.messages.value).toEqual([{ id: expect.any(Number), type: "narration", speaker: "Keeper", content: "The bell rings.", verbatim: false }]);
    expect(app.ordinaryPendingKind.value).toBeNull();
  });

  it("keeps the announcement form inert without an admissible ordinary session", async () => {
    const sfc = await Bun.file("frontend/src/KPDashboard.vue").text();
    const match = /<script setup>\s*([\s\S]*?)<\/script>/.exec(sfc);
    if (!match) throw new Error("KPDashboard script setup is required");
    const script = match[1]!.replace(/^import .*$/gm, "");
    const ref = <T>(value: T) => ({ value });
    const computed = <T>(getter: () => T) => ({ get value() { return getter(); } });
    const emitted: unknown[] = [];
    const factory = new Function("deps", `
      const { ref, computed, defineProps, defineEmits } = deps;
      ${script}
      return { msgText, sendOrdinaryMessage, ordinaryAnnouncementDisabled };
    `) as (deps: Record<string, unknown>) => Record<string, unknown>;
    const ordinary = factory({
      ref, computed,
      defineProps: () => ({ sessionId: SESSION_ID, sessionKind: "ordinary", ordinaryGeneration: 0, pendingKind: null, busy: false, terminal: { kind: "legacy_unknown" } }),
      defineEmits: () => (...args: unknown[]) => emitted.push(args),
    });
    (ordinary.msgText as { value: string }).value = "must stay inert";
    (ordinary.sendOrdinaryMessage as () => void)();
    expect((ordinary.ordinaryAnnouncementDisabled as { value: boolean }).value).toBe(true);
    expect(emitted).toEqual([]);
    expect(sfc).not.toMatch(/getKPState|kpAction|refresh\(|legacy-kp-dashboard/);
  });

  it("mounts the dashboard only for ordinary sessions and retires legacy controls", async () => {
    const [app, dashboard] = await Promise.all([
      Bun.file("frontend/src/App.vue").text(),
      Bun.file("frontend/src/KPDashboard.vue").text(),
    ]);
    expect(app).toContain('v-if="session.sessionKind === \'ordinary\'"');
    expect(app).toContain(':session-kind="session.sessionKind"');
    expect(app).toContain(":terminal=\"sessionTerminal ? session.terminal ?? { kind: 'legacy_unknown' } : null\"");
    expect(app).toContain('@ordinary-message="submitOrdinaryKpMessage"');
    expect(app).not.toMatch(/NpcChat|chatNpc|hasLegacyDirectMutations/);
    expect(dashboard).toContain('v-if="isOrdinary"');
    expect(dashboard).toContain('ordinary-kp-announcement');
    expect(dashboard).toContain('ordinary-kp-unavailable');
    expect(dashboard).not.toMatch(/setSan|setHp|applyDmg|setScene|setDiff|kpAction\(|getKPState|sendLegacyMsg/);
  });
});
