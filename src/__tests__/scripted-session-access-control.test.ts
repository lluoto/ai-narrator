import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerPrincipalRole, CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import {
  handleRequest,
  type OrdinarySessionAccessOptions,
  type SessionRuntimeDependencies,
} from "../api/server";
import { SCRIPTED_SESSION_MAX_ACTIVE, ScriptedSessionRegistry, type ScriptedSession } from "../api/scripted-session";

const OWNER = "keeper:scripted-owner-a";
const FOREIGN = "keeper:scripted-owner-b";
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const OWNER_PRINCIPAL = { role: "keeper" as const, id: OWNER };
// handleRequest reconciles the durable runtime namespace before dispatching
// every route. Keep this legacy in-memory route test out of the shared
// repository data root, whose unrelated session history can make a single
// auth assertion exceed Bun's default per-test deadline on Windows.
const SCRIPTED_TEST_STORAGE_ROOT = mkdtempSync(join(tmpdir(), "scripted-session-access-control-"));
const SCRIPTED_TEST_STORAGE = {
  careerRoot: join(SCRIPTED_TEST_STORAGE_ROOT, "careers"),
  sessionRoot: join(SCRIPTED_TEST_STORAGE_ROOT, "sessions"),
};
mkdirSync(SCRIPTED_TEST_STORAGE.careerRoot, { recursive: true });
mkdirSync(SCRIPTED_TEST_STORAGE.sessionRoot, { recursive: true });
afterAll(() => rmSync(SCRIPTED_TEST_STORAGE_ROOT, { recursive: true, force: true }));

function authenticated(role: CompilerPrincipalRole, id: string): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role, id } });
}

function refusal(status: "unauthenticated" | "unavailable"): CompilerRequestAuthenticator {
  return () => ({ status });
}

function unreadJsonBody(value: unknown): { body: ReadableStream<Uint8Array>; pulls: () => number } {
  let pulls = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }, { highWaterMark: 0 }),
    pulls: () => pulls,
  };
}

interface ControlledScriptedRuntime {
  registry: ScriptedSessionRegistry;
  pollCalls: () => number;
  submitCalls: () => number;
  startCalls: () => number;
}

function controlledScriptedRuntime(options: {
  ids?: string[];
  now?: () => number;
  maxActive?: number;
  idleTimeoutMs?: number;
} = {}): ControlledScriptedRuntime {
  let pollCalls = 0;
  let submitCalls = 0;
  let startCalls = 0;
  const ids = [...(options.ids ?? [UUID_A, UUID_B, UUID_C])];
  const registry = new ScriptedSessionRegistry({
    generateId: () => ids.shift() ?? UUID_C,
    now: options.now,
    maxActive: options.maxActive,
    idleTimeoutMs: options.idleTimeoutMs,
    createSession: (id) => ({
      id,
      start() { startCalls++; },
      poll() {
        pollCalls++;
        return { id, lines: ["private scripted line"], voiceKeys: [null], pending: null, finished: false, total: pollCalls };
      },
      submit() { submitCalls++; return { ok: true }; },
      get error() { return null; },
    }) as unknown as ScriptedSession,
  });
  return { registry, pollCalls: () => pollCalls, submitCalls: () => submitCalls, startCalls: () => startCalls };
}

function scriptedRequest(
  registry: ScriptedSessionRegistry,
  path: string,
  authenticator: CompilerRequestAuthenticator,
  init: RequestInit = {},
  access: OrdinarySessionAccessOptions = { mode: "required" },
): Promise<Response> {
  const runtime: SessionRuntimeDependencies = { scriptedSessions: registry };
  return handleRequest(
    new Request(`http://test${path}`, init),
    undefined,
    undefined,
    SCRIPTED_TEST_STORAGE,
    {},
    {},
    authenticator,
    undefined,
    undefined,
    undefined,
    access,
    runtime,
  );
}

async function createScripted(
  registry: ScriptedSessionRegistry,
  authenticator: CompilerRequestAuthenticator = authenticated("keeper", OWNER),
  access?: OrdinarySessionAccessOptions,
): Promise<string> {
  const response = await scriptedRequest(registry, "/api/scripted", authenticator, { method: "POST" }, access);
  expect(response.status).toBe(200);
  return (await response.json() as { id: string }).id;
}

describe("legacy scripted HTTP owner boundary", () => {
  it("authenticates create before starting a session, permits only owner roles, and fails closed for bad auth", async () => {
    const runtime = controlledScriptedRuntime();
    const unauthenticated = await scriptedRequest(runtime.registry, "/api/scripted", refusal("unauthenticated"), { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    expect(runtime.registry.size).toBe(0);
    expect(runtime.startCalls()).toBe(0);

    const unavailable = await scriptedRequest(runtime.registry, "/api/scripted", refusal("unavailable"), { method: "POST" });
    expect(unavailable.status).toBe(503);
    const throwing = await scriptedRequest(runtime.registry, "/api/scripted", (() => { throw new Error("auth down"); }) as CompilerRequestAuthenticator, { method: "POST" });
    expect(throwing.status).toBe(503);
    const malformed = await scriptedRequest(runtime.registry, "/api/scripted", (() => ({ status: "wrong" })) as unknown as CompilerRequestAuthenticator, { method: "POST" });
    expect(malformed.status).toBe(503);
    expect(runtime.registry.size).toBe(0);

    const player = await scriptedRequest(runtime.registry, "/api/scripted", authenticated("player", "player:scripted"), { method: "POST" });
    expect(player.status).toBe(403);
    expect(runtime.registry.size).toBe(0);

    const keeperResponse = await scriptedRequest(runtime.registry, "/api/scripted", authenticated("keeper", OWNER), { method: "POST" });
    expect(keeperResponse.status).toBe(200);
    expect(keeperResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(keeperResponse.headers.get("Pragma")).toBe("no-cache");
    const keeperId = (await keeperResponse.json() as { id: string }).id;
    const operatorId = await createScripted(runtime.registry, authenticated("operator", "operator:scripted"));
    expect(keeperId).toBe(UUID_A);
    expect(operatorId).toBe(UUID_B);
    expect(runtime.startCalls()).toBe(2);
    // The private digest binding is observable only by its authorization
    // effect; scripted snapshots and registry authorization expose no raw owner.
    expect(JSON.stringify(runtime.registry)).not.toContain(OWNER);
  });

  it("uses the ordinary development anonymous compatibility mode and closes it in production", async () => {
    const development: OrdinarySessionAccessOptions = { mode: "development_anonymous", environment: { NODE_ENV: "test" } };
    const runtime = controlledScriptedRuntime();
    const id = await createScripted(runtime.registry, refusal("unavailable"), development);
    expect((await scriptedRequest(runtime.registry, `/api/scripted/${id}`, refusal("unauthenticated"), {}, development)).status).toBe(200);

    const production = controlledScriptedRuntime();
    const blocked = await scriptedRequest(production.registry, "/api/scripted", refusal("unavailable"), { method: "POST" }, {
      mode: "development_anonymous", environment: { NODE_ENV: "production" },
    });
    expect(blocked.status).toBe(503);
    expect(production.startCalls()).toBe(0);
  });

  it("authenticates before locator lookup, makes foreign and unknown locators opaque, and never consumes rejected requests", async () => {
    const runtime = controlledScriptedRuntime();
    const id = await createScripted(runtime.registry);
    let lookups = 0;
    const getAuthorized = runtime.registry.getAuthorized.bind(runtime.registry);
    runtime.registry.getAuthorized = ((locator: string, principal) => { lookups++; return getAuthorized(locator, principal); }) as typeof runtime.registry.getAuthorized;

    const unauthenticated = await scriptedRequest(runtime.registry, `/api/scripted/${id}`, refusal("unauthenticated"));
    expect(unauthenticated.status).toBe(401);
    expect(lookups).toBe(0);
    const player = await scriptedRequest(runtime.registry, `/api/scripted/${id}`, authenticated("player", "player:scripted"));
    expect(player.status).toBe(403);
    expect(lookups).toBe(0);

    const foreignGet = await scriptedRequest(runtime.registry, `/api/scripted/${id}`, authenticated("keeper", FOREIGN));
    const unknownGet = await scriptedRequest(runtime.registry, "/api/scripted/not-a-scripted-session", authenticated("keeper", FOREIGN));
    expect(foreignGet.status).toBe(404);
    expect(unknownGet.status).toBe(404);
    expect(await foreignGet.text()).toBe(await unknownGet.text());
    expect(runtime.pollCalls()).toBe(0);

    const foreignBody = unreadJsonBody({ option: "continue" });
    const foreignDecide = await scriptedRequest(runtime.registry, `/api/scripted/${id}/decide`, authenticated("keeper", FOREIGN), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: foreignBody.body,
    });
    const unknownBody = unreadJsonBody({ option: "continue" });
    const unknownDecide = await scriptedRequest(runtime.registry, "/api/scripted/not-a-scripted-session/decide", authenticated("keeper", FOREIGN), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: unknownBody.body,
    });
    expect(foreignDecide.status).toBe(404);
    expect(await foreignDecide.text()).toBe(await unknownDecide.text());
    expect(foreignBody.pulls()).toBe(0);
    expect(unknownBody.pulls()).toBe(0);
    expect(runtime.submitCalls()).toBe(0);

    const ownerPoll = await scriptedRequest(runtime.registry, `/api/scripted/${id}`, authenticated("keeper", OWNER));
    expect(ownerPoll.status).toBe(200);
    expect(ownerPoll.headers.get("Cache-Control")).toBe("no-store");
    expect(ownerPoll.headers.get("Pragma")).toBe("no-cache");
    expect(runtime.pollCalls()).toBe(1);
    const ownerBody = unreadJsonBody({ option: "continue" });
    const ownerDecide = await scriptedRequest(runtime.registry, `/api/scripted/${id}/decide`, authenticated("keeper", OWNER), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: ownerBody.body,
    });
    expect(ownerDecide.status).toBe(200);
    expect(ownerDecide.headers.get("Cache-Control")).toBe("no-store");
    expect(ownerDecide.headers.get("Pragma")).toBe("no-cache");
    expect(ownerBody.pulls()).toBeGreaterThan(0);
    expect(runtime.submitCalls()).toBe(1);
  });

  it("uses CSPRNG UUID locators and safely refuses collision replay without replacing a session", () => {
    const owner = createOrdinarySessionAccessBinding(OWNER_PRINCIPAL);
    const registry = new ScriptedSessionRegistry();
    const first = registry.create(owner)!;
    const second = registry.create(owner)!;
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second.id).not.toBe(first.id);
    expect("lookup" in registry).toBe(false);

    const replayed = new ScriptedSessionRegistry({ generateId: () => UUID_A });
    const original = replayed.create(owner)!;
    expect(replayed.create(owner)).toBeUndefined();
    expect(replayed.size).toBe(1);
    expect(replayed.getAuthorized(UUID_A, OWNER_PRINCIPAL)).toBe(original);

    const collisionThenFresh = new ScriptedSessionRegistry({ generateId: (() => {
      const ids = [UUID_A, UUID_A, UUID_B];
      return () => ids.shift() ?? UUID_B;
    })() });
    const preserved = collisionThenFresh.create(owner)!;
    const fresh = collisionThenFresh.create(owner)!;
    expect(fresh.id).toBe(UUID_B);
    expect(collisionThenFresh.getAuthorized(UUID_A, OWNER_PRINCIPAL)).toBe(preserved);

    const failedStart = new ScriptedSessionRegistry({
      generateId: () => UUID_C,
      createSession: (id) => ({ id, start() { throw new Error("synchronous start failure"); } }) as unknown as ScriptedSession,
    });
    expect(failedStart.create(owner)).toBeUndefined();
    expect(failedStart.size).toBe(0);
    expect(failedStart.getAuthorized(UUID_C, OWNER_PRINCIPAL)).toBeUndefined();
  });

  it("has a fixed active cap, cleans only expired sessions before create, and refreshes idle time on authorized access", async () => {
    expect(() => new ScriptedSessionRegistry({ maxActive: 0 })).toThrow();
    expect(() => new ScriptedSessionRegistry({ maxActive: SCRIPTED_SESSION_MAX_ACTIVE + 1 })).toThrow();
    expect(() => new ScriptedSessionRegistry({ idleTimeoutMs: 0 })).toThrow();
    let now = 0;
    const runtime = controlledScriptedRuntime({ now: () => now, maxActive: 1, idleTimeoutMs: 100 });
    const owner = createOrdinarySessionAccessBinding(OWNER_PRINCIPAL);
    const original = runtime.registry.create(owner)!;
    const full = await scriptedRequest(runtime.registry, "/api/scripted", authenticated("keeper", OWNER), { method: "POST" });
    expect(full.status).toBe(503);
    expect(await full.json()).toEqual({
      error: { stage: "session", code: "SCRIPTED_SESSION_UNAVAILABLE", message: "scripted session capacity is unavailable" },
    });
    expect(full.headers.get("Cache-Control")).toBe("no-store");
    expect(runtime.registry.size).toBe(1);

    now = 90;
    expect((await scriptedRequest(runtime.registry, `/api/scripted/${original.id}`, authenticated("keeper", OWNER))).status).toBe(200);
    now = 150;
    const stillFull = await scriptedRequest(runtime.registry, "/api/scripted", authenticated("keeper", OWNER), { method: "POST" });
    expect(stillFull.status).toBe(503);
    expect(runtime.registry.size).toBe(1);

    now = 191;
    const replacement = runtime.registry.create(owner)!;
    expect(replacement.id).toBe(UUID_B);
    expect(runtime.registry.size).toBe(1);
    expect(runtime.registry.getAuthorized(original.id, OWNER_PRINCIPAL)).toBeUndefined();
    expect(runtime.registry.getAuthorized(replacement.id, OWNER_PRINCIPAL)).toBe(replacement);
  });
});
