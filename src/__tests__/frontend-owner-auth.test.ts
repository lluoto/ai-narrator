import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
// @ts-expect-error Browser transport deliberately has no declaration file.
import { clearOwnerBearer, ownerFetch, setOwnerBearer } from "../../frontend/src/owner-auth.js";
// @ts-expect-error Browser API module deliberately has no declaration file.
import { getArchetypes, listSessions, luckSpend, ordinaryActionPendingStorageKey, retryPendingOrdinaryAction } from "../../frontend/src/api.js";
// @ts-expect-error Browser API module deliberately has no declaration file.
import * as ownerApi from "../../frontend/src/api.js";
// @ts-expect-error Sealed browser player module deliberately has no declaration file.
import { getPlayerFacadeView } from "../../frontend/src/player-api.js";

const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const OWNER_TOKEN = "o".repeat(48);
const frontendRoot = join(import.meta.dir, "..", "..", "frontend", "src");
const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf7868f";

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  clearOwnerBearer();
  globalThis.fetch = originalFetch;
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else delete (globalThis as { location?: unknown }).location;
});

function useBrowserOrigin(origin = "https://owner.example") {
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin } });
}

describe("owner browser bearer transport", () => {
  it("keeps a valid bearer only in module memory and merges it with caller headers", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return json({ ok: true });
    }) as typeof fetch;

    setOwnerBearer(OWNER_TOKEN);
    await ownerFetch("/api/sessions", { headers: { "Content-Type": "application/json", "X-Trace": "keep" } });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/sessions");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Trace")).toBe("keep");
    expect(calls[0].init?.credentials).toBe("same-origin");
    expect(calls[0].init?.redirect).toBe("error");
  });

  it("sends no invented authorization when the in-memory bearer is absent and clear destroys it", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return json({ ok: true });
    }) as typeof fetch;

    await ownerFetch("/api/sessions");
    expect(new Headers(calls[0]?.headers).has("Authorization")).toBe(false);
    setOwnerBearer(OWNER_TOKEN);
    clearOwnerBearer();
    await ownerFetch("/api/sessions");
    expect(new Headers(calls[1]?.headers).has("Authorization")).toBe(false);
  });

  it("rejects malformed bearer values without trimming, echoing, or installing them", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return json({ ok: true });
    }) as typeof fetch;
    for (const value of ["a".repeat(31), ` ${OWNER_TOKEN}`, `${OWNER_TOKEN} `, `${OWNER_TOKEN.slice(0, 20)},${OWNER_TOKEN.slice(20)}`, "a".repeat(4097)]) {
      expect(() => setOwnerBearer(value)).toThrow("Invalid owner credential");
      try {
        setOwnerBearer(value);
      } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    }
    await ownerFetch("/api/sessions");
    expect(new Headers(calls[0]?.headers).has("Authorization")).toBe(false);
  });

  it("rejects cross-origin URLs and caller-supplied Authorization before fetch", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json({ ok: true }); }) as unknown as typeof fetch;
    setOwnerBearer(OWNER_TOKEN);

    await expect(ownerFetch("https://example.test/api/sessions")).rejects.toThrow("owner request must stay on this origin");
    await expect(ownerFetch("//example.test/api/sessions")).rejects.toThrow("owner request must stay on this origin");
    await expect(ownerFetch("/api/sessions", { headers: { Authorization: "Bearer caller-value" } })).rejects.toThrow("caller authorization is not allowed");
    const request = new Request("https://example.test/api/sessions", { headers: { Authorization: "Bearer caller-value" } });
    await expect(ownerFetch(request)).rejects.toThrow("owner request must stay on this origin");
    expect(calls).toBe(0);
  });

  it("rejects browser-normalized cross-origin backslash and whitespace URL forms before fetch", async () => {
    let calls = 0;
    useBrowserOrigin();
    globalThis.fetch = (async () => { calls += 1; return json({ ok: true }); }) as unknown as typeof fetch;
    setOwnerBearer(OWNER_TOKEN);

    for (const url of ["\\\\evil.example/path", "  //evil.example/path", "\t//evil.example/path"]) {
      await expect(ownerFetch(url)).rejects.toThrow("owner request must stay on this origin");
    }
    expect(calls).toBe(0);
  });

  it("allows only unambiguous root-relative URLs when no browser origin exists", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json({ ok: true }); }) as unknown as typeof fetch;
    setOwnerBearer(OWNER_TOKEN);

    for (const url of ["//evil.example/path", "\\\\evil.example/path", "  /api/sessions", "\t/api/sessions", "api/sessions"]) {
      await expect(ownerFetch(url)).rejects.toThrow("owner request must stay on this origin");
    }
    await ownerFetch("/api/sessions");
    expect(calls).toBe(1);
  });

  it("does not persist credentials in storage, cookies, or URL state", () => {
    const source = readFileSync(join(frontendRoot, "owner-auth.js"), "utf8");
    for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "location.hash", "location.search", "history."]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("owner browser API wiring", () => {
  it("uses the owner transport for every owner API surface while public and sealed player reads omit the bearer", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (String(url) === "/api/sessions") return json({ sessions: [] });
      if (String(url).includes("player-view")) return json({ generation: 0, actions: [] });
      return json({ archetypes: [] });
    }) as typeof fetch;
    setOwnerBearer(OWNER_TOKEN);

    await expect(listSessions()).resolves.toEqual([]);
    await getArchetypes();
    await getPlayerFacadeView("delivery-session");

    expect(calls[0]).toMatchObject({ url: "/api/sessions" });
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(calls[1].headers.has("Authorization")).toBe(false);
    expect(calls[2].headers.has("Authorization")).toBe(false);
  });

  it("does not turn 401, 403, or 503 owner session refusals into an empty list", async () => {
    setOwnerBearer(OWNER_TOKEN);
    for (const status of [401, 403, 503]) {
      globalThis.fetch = (async () => json({ error: { code: "OWNER_DENIED" } }, status)) as unknown as typeof fetch;
      await expect(listSessions()).rejects.toMatchObject({ status });
    }
  });

  it("sends the owner bearer on Luck POSTs and all pending-reconciliation reads", async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ url: string; headers: Headers; body?: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({
        url: target,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (target.endsWith("/history?limit=100")) return json({ messages: [] });
      if (target.endsWith("/luck-spend")) {
        return json({ pcId: "p1", amount: 3, previousLuck: 50, luck: 47, sessionKind: "ordinary", ordinaryGeneration: 1 });
      }
      return json({ sessionKind: "ordinary", ordinaryGeneration: 1, summary: { id: "owner-luck" } });
    }) as typeof fetch;
    setOwnerBearer(OWNER_TOKEN);

    await expect(luckSpend("owner-luck", 3, {
      expectedGeneration: 0,
      actionId: ACTION_ID,
      storage,
    })).resolves.toMatchObject({ luck: 47 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "/api/sessions/owner-luck/luck-spend",
      body: { amount: 3, actionId: ACTION_ID, expectedGeneration: 0 },
    });
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${OWNER_TOKEN}`);

    storage.values.set(ordinaryActionPendingStorageKey("owner-luck"), JSON.stringify({
      version: 1,
      kind: "luck_spend",
      sessionId: "owner-luck",
      amount: 3,
      actionId: ACTION_ID,
      expectedGeneration: 0,
    }));
    calls.length = 0;
    await expect(retryPendingOrdinaryAction("owner-luck", { storage })).resolves.toMatchObject({
      kind: "reconciled",
      pendingKind: "luck_spend",
    });
    expect(calls.map(call => call.url)).toEqual([
      "/api/sessions/owner-luck/luck-spend",
      "/api/sessions/owner-luck",
      "/api/sessions/owner-luck/history?limit=100",
    ]);
    for (const call of calls) expect(call.headers.get("Authorization")).toBe(`Bearer ${OWNER_TOKEN}`);
  });

  it("fails closed on a Luck 401 and retains the exact pending request", async () => {
    const storage = new MemoryStorage();
    globalThis.fetch = (async () => json({ code: "OWNER_DENIED" }, 401)) as unknown as typeof fetch;
    setOwnerBearer(OWNER_TOKEN);

    await expect(luckSpend("owner-luck", 3, {
      expectedGeneration: 0,
      actionId: ACTION_ID,
      storage,
    })).rejects.toMatchObject({ status: 401 });
    expect(JSON.parse(storage.values.get(ordinaryActionPendingStorageKey("owner-luck"))!)).toEqual({
      version: 1,
      kind: "luck_spend",
      sessionId: "owner-luck",
      amount: 3,
      actionId: ACTION_ID,
      expectedGeneration: 0,
    });
  });

  it("contains direct owner wrappers for remaining owner API surfaces, module editor, settings panel, and scripted owner path", () => {
    const api = readFileSync(join(frontendRoot, "api.js"), "utf8");
    for (const name of [
      "createSession", "sendAction", "executeOrdinaryAction", "resolveCompiledIntent", "executeCompiledAction",
      "getSession", "getCompiledActions", "listSessions", "getHistory", "getCharacter", "getSuggestions",
    ]) {
      const start = api.indexOf(`export async function ${name}`);
      const end = api.indexOf("export ", start + 1);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(api.slice(start, end < 0 ? undefined : end)).toContain("ownerFetch(");
    }
    expect(readFileSync(join(frontendRoot, "ModuleEditor.vue"), "utf8")).toContain("ownerFetch(");
    const settings = readFileSync(join(frontendRoot, "SettingsPanel.vue"), "utf8");
    expect(settings).toContain("ownerFetch('/api/config')");
    expect(settings).toContain("if (!res.ok)");
    expect(settings).toContain("Unable to load server settings.");
    const app = readFileSync(join(frontendRoot, "App.vue"), "utf8");
    expect(app).toContain("ownerFetch('/api/scripted'");
    expect(app).toContain("ownerFetch(`/api/scripted/${scriptedId.value}`)");
    expect(app).toContain("ownerFetch(`/api/scripted/${scriptedId.value}/decide`");
  });

  it("does not export or permit calls to retired direct-mutation owner wrappers", () => {
    const legacyApi = ownerApi as unknown as Record<string, () => unknown>;
    for (const name of ["getKPState", "kpAction", "saveCharacterSheet", "npcChat"]) {
      expect(Object.keys(ownerApi)).not.toContain(name);
      expect(legacyApi[name]).toBeUndefined();
      expect(() => legacyApi[name]()).toThrow(TypeError);
    }
  });
});

describe("owner credential gate", () => {
  it("sets a temporary password ref, verifies with listSessions, clears it, and returns to the gate on clear", () => {
    const app = readFileSync(join(frontendRoot, "App.vue"), "utf8");
    expect(app).toContain("const ownerCredential = ref('')");
    expect(app).toContain('type="password"');
    expect(app).toContain('autocomplete="new-password"');
    const setAt = app.indexOf("setOwnerBearer(ownerCredential.value)");
    const clearAt = app.indexOf("ownerCredential.value = ''", setAt);
    const verifyAt = app.indexOf("await listSessions()", setAt);
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(setAt);
    expect(verifyAt).toBeGreaterThan(clearAt);
    expect(app).toContain("clearOwnerBearer()");
    expect(app).toContain("ownerAuthenticated.value = false");
    expect(app).toContain("ownerAuthenticated.value = true");
    expect(app).toContain("ownerAuthError.value = 'Owner credential could not be verified.'");
  });
});
