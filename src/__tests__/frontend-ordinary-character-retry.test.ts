import { afterEach, describe, expect, it } from "bun:test";
// @ts-ignore Browser client deliberately has no declaration file.
import { characterPatch, ordinaryActionPendingStorageKey, retryPendingOrdinaryAction } from "../../frontend/src/api.js";
// @ts-ignore Owner credential remains in browser-module memory.
import { clearOwnerBearer, setOwnerBearer } from "../../frontend/src/owner-auth.js";
// @ts-ignore The controller is a small browser-independent state gate.
import { ordinaryCharacterPatchOutcome } from "../../frontend/src/ordinary-character-patch-controller.js";

const originalFetch = globalThis.fetch;
const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf78693";
const NEXT_ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf78694";
const OWNER_TOKEN = "c".repeat(48);
const SESSION_ID = "ordinary-character-retry";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function characterPending(actionId = ACTION_ID) {
  return {
    version: 1, kind: "character_patch", sessionId: SESSION_ID,
    patch: { hp: 9, maxHp: 10, luck: 42, creditRating: 31, skills: { stealth: 55 }, inventory: ["flashlight"], weapons: ["revolver"], attributes: { dexterity: 61 } },
    actionId, expectedGeneration: 0,
  };
}

function textPending() {
  return { version: 1, sessionId: SESSION_ID, input: "look", actionId: ACTION_ID, expectedGeneration: 0 };
}

function authoritative(target: string) {
  if (target.endsWith("/history?limit=100")) return json({ messages: [{ content: "authority" }] });
  if (target.endsWith("/character")) return json({
    sessionKind: "ordinary", ordinaryGeneration: 1, pcId: "p1",
    character: { name: "Ada", archetype: "detective", hp: 9, maxHp: 10, luck: 42, creditRating: 31, skills: { stealth: 55 }, attributes: { dexterity: 61 } },
    inventory: ["flashlight"], weapons: ["revolver"], sanity: { currentSAN: 50, maxSAN: 99 },
    summary: { id: SESSION_ID, hp: 9 },
  });
  return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: SESSION_ID }, state: { player: { hp: 9, maxHp: 10, luck: 42 } } });
}

function characterPostReceipt({ hp = 9, skills = { stealth: 55 } } = {}) {
  return {
    sessionKind: "ordinary", ordinaryGeneration: 1, pcId: "p1",
    character: { name: "Ada", archetypeId: "detective", hp, maxHp: 10, luck: 42, creditRating: 31, skillValues: skills, attributes: { dexterity: 61 } },
    inventory: ["flashlight"], weapons: ["revolver"],
    summary: { id: SESSION_ID, round: 0, ruleset: "cosmic-horror", scene: "opening", playerName: "Ada", archetype: "detective", messageCount: 0, npcCount: 0, createdAt: 0 },
  };
}

afterEach(() => {
  clearOwnerBearer();
  globalThis.fetch = originalFetch;
});

describe("ordinary character browser retry queue", () => {
  it("persists a closed deep-copied patch before its owner-authenticated POST and confirms it with an authoritative character read", async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ url: string; body?: Record<string, unknown>; authorization: string | null }> = [];
    setOwnerBearer(OWNER_TOKEN);
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get("Authorization") });
      if (target.endsWith("/character") && init?.method === "POST") {
        expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey(SESSION_ID))!)).toEqual(characterPending());
        return json(characterPostReceipt());
      }
      return authoritative(target);
    }) as typeof fetch;
    const input = { ...characterPending().patch, skills: { stealth: 55 }, inventory: ["flashlight"], weapons: ["revolver"], attributes: { dexterity: 61 } };
    await expect(characterPatch(SESSION_ID, input, { expectedGeneration: 0, actionId: ACTION_ID, storage })).resolves.toMatchObject({
      kind: "reconciled", pendingKind: "character_patch", committed: true, character: { character: { hp: 9 } }, session: { ordinaryGeneration: 1 },
    });
    input.skills.stealth = 1;
    input.inventory.push("mutated");
    expect(calls.map(call => ({ url: call.url, body: call.body }))).toEqual([
      { url: `/api/sessions/${SESSION_ID}/character`, body: { ...characterPending().patch, actionId: ACTION_ID, expectedGeneration: 0 } },
      { url: `/api/sessions/${SESSION_ID}/character`, body: undefined },
      { url: `/api/sessions/${SESSION_ID}`, body: undefined },
      { url: `/api/sessions/${SESSION_ID}/history?limit=100`, body: undefined },
    ]);
    for (const call of calls) expect(call.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(storage.values.has(ordinaryActionPendingStorageKey(SESSION_ID))).toBe(false);
  });

  it("replays text/Luck/party work before character and restart-replays the exact character body", async () => {
    for (const pending of [
      textPending(),
      { version: 1, kind: "luck_spend", sessionId: SESSION_ID, amount: 3, actionId: ACTION_ID, expectedGeneration: 0 },
      { version: 1, kind: "party_member_create", sessionId: SESSION_ID, name: "Bea", archetype: "detective", actionId: ACTION_ID, expectedGeneration: 0 },
    ]) {
      const storage = new MemoryStorage();
      storage.values.set(ordinaryActionPendingStorageKey(SESSION_ID), JSON.stringify(pending));
      const calls: Array<{ target: string; method?: string }> = [];
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url); calls.push({ target, method: init?.method });
        if (init?.method === "POST") return json({ sessionKind: "ordinary", ordinaryGeneration: 1, luck: 47, pcId: "p2" });
        return authoritative(target);
      }) as typeof fetch;
      await expect(characterPatch(SESSION_ID, characterPending().patch, { expectedGeneration: 0, actionId: NEXT_ACTION_ID, storage })).resolves.toMatchObject({ kind: "reconciled" });
      expect(calls.some(call => call.target.endsWith("/character") && call.method === "POST")).toBe(false);
    }

    const storage = new MemoryStorage();
    const bodies: Record<string, unknown>[] = [];
    let posts = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/character") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body))); posts++;
        if (posts === 1) throw new TypeError("ack lost");
        return json(characterPostReceipt());
      }
      return authoritative(target);
    }) as typeof fetch;
    await expect(characterPatch(SESSION_ID, characterPending().patch, { expectedGeneration: 0, actionId: ACTION_ID, storage })).rejects.toThrow("ack lost");
    await expect(retryPendingOrdinaryAction(SESSION_ID, { storage })).resolves.toMatchObject({ kind: "reconciled", pendingKind: "character_patch" });
    expect(bodies).toEqual([
      { ...characterPending().patch, actionId: ACTION_ID, expectedGeneration: 0 },
      { ...characterPending().patch, actionId: ACTION_ID, expectedGeneration: 0 },
    ]);
  });

  it("fails closed before POST for storage/input errors and retains ambiguous failures but retires documented refusals after authority", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return json({}); }) as unknown as typeof fetch;
    const unavailable = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
    await expect(characterPatch(SESSION_ID, characterPending().patch, { expectedGeneration: 0, actionId: ACTION_ID, storage: unavailable })).rejects.toThrow("persisted");
    await expect(characterPatch(SESSION_ID, { ...characterPending().patch, pcId: "p2" }, { expectedGeneration: 0, actionId: ACTION_ID, storage: new MemoryStorage() })).rejects.toThrow("character");
    const accessorSkills: Record<string, unknown> = {};
    Object.defineProperty(accessorSkills, "stealth", { enumerable: true, get: () => 55 });
    const inheritedSkills = Object.assign(Object.create({ stealth: 55 }), {}) as Record<string, unknown>;
    const symbolicSkills: Record<string, unknown> = { stealth: 55 };
    Object.defineProperty(symbolicSkills, Symbol("side-channel"), { enumerable: true, value: "p2" });
    const tooManySkills = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`skill-${index}`, 50]));
    const dangerousTable = (key: string) => {
      const table: Record<string, unknown> = {};
      Object.defineProperty(table, key, { enumerable: true, configurable: true, value: 55 });
      return table;
    };
    for (const invalid of [
      { ...characterPending().patch, skills: accessorSkills },
      { ...characterPending().patch, skills: inheritedSkills },
      { ...characterPending().patch, skills: symbolicSkills },
      { ...characterPending().patch, skills: tooManySkills },
      { skills: dangerousTable("__proto__") },
      { skills: dangerousTable("constructor") },
      { attributes: dangerousTable("prototype") },
    ]) {
      await expect(characterPatch(SESSION_ID, invalid, { expectedGeneration: 0, actionId: ACTION_ID, storage: new MemoryStorage() })).rejects.toThrow("character")
    }
    expect(calls).toBe(0);

    for (const malformedReceipt of [
      { sessionKind: "ordinary", ordinaryGeneration: 1, pcId: "p1" },
      characterPostReceipt({ hp: 8 }),
    ]) {
      const storage = new MemoryStorage();
      globalThis.fetch = (async () => json(malformedReceipt)) as unknown as typeof fetch;
      await expect(characterPatch(SESSION_ID, characterPending().patch, { expectedGeneration: 0, actionId: ACTION_ID, storage })).rejects.toThrow("receipt");
      expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey(SESSION_ID))!)).toEqual(characterPending());
    }

    for (const failure of [
      () => Promise.reject(new TypeError("offline")),
      () => Promise.resolve(json({ code: "OWNER_DENIED" }, 401)),
      () => Promise.resolve(new Response("not json", { status: 200 })),
      () => Promise.resolve(json({ code: "ordinary_persistence_indeterminate" }, 503)),
    ]) {
      const storage = new MemoryStorage();
      globalThis.fetch = (async () => failure()) as unknown as typeof fetch;
      await expect(characterPatch(SESSION_ID, characterPending().patch, { expectedGeneration: 0, actionId: ACTION_ID, storage })).rejects.toThrow();
      expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey(SESSION_ID))!)).toEqual(characterPending());
    }

    const storage = new MemoryStorage();
    storage.values.set(ordinaryActionPendingStorageKey(SESSION_ID), JSON.stringify(characterPending()));
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return json({ code: "ordinary_character_contract_required" }, 400);
      return authoritative(String(url));
    }) as typeof fetch;
    const deterministicRefusal = await retryPendingOrdinaryAction(SESSION_ID, { storage });
    expect(deterministicRefusal).toMatchObject({ kind: "reconciled", pendingKind: "character_patch" });
    expect(storage.values.has(ordinaryActionPendingStorageKey(SESSION_ID))).toBe(false);
    expect(ordinaryCharacterPatchOutcome(deterministicRefusal)).toMatchObject({ kind: "character-not-committed" });
  });

  it("confirms a p1 receipt against a newer p2 authoritative sheet on first send and duplicate replay", async () => {
    const laterAuthority = (target: string) => {
      if (target.endsWith("/history?limit=100")) return json({ messages: [] });
      if (target.endsWith("/character")) return json({
        sessionKind: "ordinary", ordinaryGeneration: 2, pcId: "p2",
        character: { name: "Bea", archetype: "detective", hp: 8, maxHp: 10, luck: 40, creditRating: 20, skills: { stealth: 40 }, attributes: { dexterity: 60 } },
        inventory: ["map"], weapons: [], sanity: { currentSAN: 45, maxSAN: 99 },
        summary: { id: SESSION_ID, round: 2, ruleset: "cosmic-horror", scene: "later", playerName: "Bea", archetype: "detective", messageCount: 1, npcCount: 0, createdAt: 0 },
      });
      return json({ sessionKind: "ordinary", ordinaryGeneration: 2, summary: { id: SESSION_ID } });
    };
    const receive = async (storage: MemoryStorage, replay = false) => {
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return json(characterPostReceipt());
        return laterAuthority(String(url));
      }) as typeof fetch;
      const result = replay
        ? await retryPendingOrdinaryAction(SESSION_ID, { storage })
        : await characterPatch(SESSION_ID, characterPending().patch, { expectedGeneration: 0, actionId: ACTION_ID, storage });
      expect(result).toMatchObject({ kind: "reconciled", committed: true, committedGeneration: 1, character: { pcId: "p2", ordinaryGeneration: 2 } });
      expect(storage.values.has(ordinaryActionPendingStorageKey(SESSION_ID))).toBe(false);
    };
    await receive(new MemoryStorage());
    const replayStorage = new MemoryStorage();
    replayStorage.values.set(ordinaryActionPendingStorageKey(SESSION_ID), JSON.stringify(characterPending()));
    await receive(replayStorage, true);
  });
});
