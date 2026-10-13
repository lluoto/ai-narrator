import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { OrdinarySessionCreationAdmissionCoordinator } from "../api/ordinary-session-creation-admission";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { ordinarySessionOwnerFingerprint } from "../api/session-access";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";

const roots = new Set<string>();
const SESSION_ID = "12345678-1234-4123-8123-123456789abc";
const config = { apiKey: "test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 16, temperature: 0 };
const auth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "creation-admission-owner" } });

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string { const value = mkdtempSync(join(tmpdir(), "ordinary-creation-http-")); roots.add(value); return value; }

function coordinator(sessionRoot: string): OrdinarySessionCreationAdmissionCoordinator {
  return new OrdinarySessionCreationAdmissionCoordinator({
    root: sessionRoot, globalConcurrent: 2, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000,
    maxTrackedPrincipals: 1_024, leaseTtlMs: 60_000, wholeJobDeadlineMs: 300_000, busyTimeoutMs: 25,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function create(workspace: string, dependencies: SessionRuntimeDependencies, authenticator = auth, signal?: AbortSignal, body: Record<string, unknown> = { archetype: "detective", characterName: "Ada" }, requestOverride?: Request): Promise<Response> {
  const request = requestOverride ?? new Request("http://creation-admission.test/api/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), ...(signal ? { signal } : {}),
  });
  return handleRequest(request, undefined, undefined, { careerRoot: join(workspace, "careers"), sessionRoot: join(workspace, "sessions") }, {}, {}, authenticator,
  undefined, undefined, undefined, { mode: "required" }, dependencies);
}

describe("ordinary session creation HTTP admission", () => {
  test("refuses a pre-held global slot before ID generation, construction, or opening", async () => {
    const workspace = root();
    const held = coordinator(join(workspace, "sessions"));
    // Session namespace construction in the handler creates the host root; do
    // that explicitly for this independent durable holder.
    mkdirSync(join(workspace, "sessions"));
    held.initialize();
    const lease = held.acquire({ principalFingerprint: "a".repeat(64) });
    const other = held.acquire({ principalFingerprint: "b".repeat(64) });
    if (lease.status !== "acquired" || other.status !== "acquired") throw new Error("expected pre-held creation leases");
    let ids = 0; let factories = 0; let openings = 0;
    const registry = new Map<string, GameSession>();
    const response = await create(workspace, {
      registry,
      ordinaryIntentPolicy: "development_fallback",
      generateSessionId: () => { ids++; return SESSION_ID; },
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        factories++;
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => { openings++; return "opening"; };
        return session;
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toMatchObject({ error: { code: "ORDINARY_SESSION_CREATION_LIMITED" } });
    expect({ ids, factories, openings, registry: registry.size }).toEqual({ ids: 0, factories: 0, openings: 0, registry: 0 });
    expect(lease.release()).toBe(true);
    expect(other.release()).toBe(true);
  });

  test("uses the authenticated owner fingerprint rather than body persona fields, while another principal remains eligible", async () => {
    const workspace = root();
    const admission = coordinator(join(workspace, "sessions"));
    mkdirSync(join(workspace, "sessions"));
    admission.initialize();
    const held = admission.acquire({ principalFingerprint: ordinarySessionOwnerFingerprint({ role: "keeper", id: "creation-admission-owner" }) });
    if (held.status !== "acquired") throw new Error("expected same-principal holder");
    let factories = 0;
    const dependencies: SessionRuntimeDependencies = {
      registry: new Map(), ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: admission,
      generateSessionId: () => SESSION_ID,
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        factories++;
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => "opening";
        return session;
      },
    };
    const same = await create(workspace, dependencies, auth, undefined, { archetype: "detective", characterName: "Ada", personality: "different body role", backstory: "not an admission key" });
    expect(same.status).toBe(429);
    expect(factories).toBe(0);
    const otherAuth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "operator", id: "another-owner" } });
    const other = await create(workspace, dependencies, otherAuth);
    expect(other.status).toBe(201);
    // Ordinary g0 construction plus authoritative rehydration each use the
    // trusted factory; the rejected same-principal request added none.
    expect(factories).toBe(2);
    expect(held.release()).toBe(true);
    for (const session of dependencies.registry!.values()) session.close();
  });

  test("fails closed on an injected admission domain mismatch before ID generation or construction", async () => {
    const workspace = root();
    mkdirSync(join(workspace, "sessions"));
    const wrong = new OrdinarySessionCreationAdmissionCoordinator({
      root: join(workspace, "sessions"), globalConcurrent: 2, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000,
      maxTrackedPrincipals: 1_024, leaseTtlMs: 60_000, wholeJobDeadlineMs: 300_000, busyTimeoutMs: 25,
    }, { fileName: ".wrong-admission.sqlite" });
    let ids = 0; let factories = 0;
    const response = await create(workspace, {
      registry: new Map(), ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: wrong,
      generateSessionId: () => { ids++; return SESSION_ID; },
      createOrdinarySession: () => { factories++; throw new Error("must not construct"); },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "ORDINARY_SESSION_CREATION_UNAVAILABLE" } });
    expect({ ids, factories }).toEqual({ ids: 0, factories: 0 });
  });

  test("keeps an ignored-abort opening lease until the provider settles, then returns 408 without publication", async () => {
    const workspace = root();
    mkdirSync(join(workspace, "sessions"));
    const admission = new OrdinarySessionCreationAdmissionCoordinator({
      root: join(workspace, "sessions"), globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000,
      maxTrackedPrincipals: 1_024, leaseTtlMs: 60_000, wholeJobDeadlineMs: 300_000, busyTimeoutMs: 25,
    });
    const opening = deferred<string>();
    const entered = deferred<void>();
    const registry = new Map<string, GameSession>();
    let serial = 0; let openingCalls = 0;
    const dependencies: SessionRuntimeDependencies = {
      registry, ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: admission,
      generateSessionId: () => serial++ === 0 ? SESSION_ID : "12345678-1234-4123-8123-123456789abd",
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => {
          openingCalls++;
          if (openingCalls !== 1) return "later opening";
          entered.resolve();
          return opening.promise;
        };
        return session;
      },
    };
    const controller = new AbortController();
    const first = create(workspace, dependencies, auth, controller.signal);
    await entered.promise;
    controller.abort();
    const competingAuth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "operator", id: "competing-owner" } });
    const competing = await create(workspace, dependencies, competingAuth);
    expect(competing.status).toBe(429);
    opening.resolve("ignored abort opening");
    const response = await first;
    expect(response.status).toBe(408);
    expect(registry.size).toBe(0);
    const afterSettlement = await create(workspace, dependencies, competingAuth);
    expect(afterSettlement.status).toBe(201);
    for (const session of registry.values()) session.close();
  });

  test("fails closed after renewal loss aborts a cooperative opening and releases the durable slot", async () => {
    const workspace = root();
    const sessionRoot = join(workspace, "sessions");
    mkdirSync(sessionRoot);
    const admission = new OrdinarySessionCreationAdmissionCoordinator({
      root: sessionRoot, globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000,
      maxTrackedPrincipals: 1_024, leaseTtlMs: 60_000, wholeJobDeadlineMs: 300_000, busyTimeoutMs: 25,
    });
    const originalAcquire = admission.acquire.bind(admission);
    let renewCalls = 0;
    admission.acquire = (input) => {
      const lease = originalAcquire(input);
      return lease.status === "acquired" ? {
        ...lease,
        renewalIntervalMs: 1,
        renew: () => {
          renewCalls++;
          return { status: "refused" as const, code: "ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED" as const, retryAfterSeconds: 1 };
        },
      } : lease;
    };
    const registry = new Map<string, GameSession>();
    const response = await create(workspace, {
      registry, ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: admission,
      generateSessionId: () => SESSION_ID,
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async (signal) => new Promise<string>((resolve, reject) => {
          if (!signal) throw new Error("expected opening abort signal");
          const fallback = setTimeout(() => resolve("unexpected after ignored renewal"), 15);
          signal.addEventListener("abort", () => {
            clearTimeout(fallback);
            reject(new Error("renewal-loss-provider-secret"));
          }, { once: true });
        });
        return session;
      },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "ORDINARY_SESSION_CREATION_UNAVAILABLE" } });
    expect(renewCalls).toBeGreaterThan(0);
    expect(registry.size).toBe(0);
    const next = originalAcquire({ principalFingerprint: "b".repeat(64) });
    expect(next.status).toBe("acquired");
    if (next.status === "acquired") next.release();
  });

  test("fails closed at the creation whole-job deadline after a cooperative opening settles", async () => {
    const workspace = root();
    const sessionRoot = join(workspace, "sessions");
    mkdirSync(sessionRoot);
    const admission = new OrdinarySessionCreationAdmissionCoordinator({
      root: sessionRoot, globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000,
      maxTrackedPrincipals: 1_024, leaseTtlMs: 60_000, wholeJobDeadlineMs: 15, busyTimeoutMs: 25,
    });
    // The timer must independently abort the provider: this seam prevents the
    // later pre-publication fence check from masking a missing deadline timer.
    const originalAcquire = admission.acquire.bind(admission);
    admission.acquire = (input) => {
      const lease = originalAcquire(input);
      return lease.status === "acquired" ? {
        ...lease,
        checkActive: () => ({ status: "active" as const, fence: lease.fence, expiresAt: lease.expiresAt, deadlineAt: lease.deadlineAt }),
      } : lease;
    };
    const registry = new Map<string, GameSession>();
    const response = await create(workspace, {
      registry, ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: admission,
      generateSessionId: () => SESSION_ID,
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async (signal) => new Promise<string>((resolve, reject) => {
          if (!signal) throw new Error("expected opening abort signal");
          const fallback = setTimeout(() => resolve("unexpected after ignored deadline"), 30);
          signal.addEventListener("abort", () => {
            clearTimeout(fallback);
            reject(new Error("deadline-provider-secret"));
          }, { once: true });
        });
        return session;
      },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("deadline-provider-secret");
    expect(registry.size).toBe(0);
    const next = admission.acquire({ principalFingerprint: "b".repeat(64) });
    expect(next.status).toBe("acquired");
    if (next.status === "acquired") next.release();
  });

  test("stops renewal and detaches the combined request listener after a successful opening", async () => {
    const workspace = root();
    const sessionRoot = join(workspace, "sessions");
    mkdirSync(sessionRoot);
    const admission = coordinator(sessionRoot);
    const originalAcquire = admission.acquire.bind(admission);
    let renewCalls = 0;
    admission.acquire = (input) => {
      const lease = originalAcquire(input);
      return lease.status === "acquired" ? {
        ...lease,
        renewalIntervalMs: 2,
        renew: () => { renewCalls++; return lease.renew(); },
      } : lease;
    };
    const request = new Request("http://creation-admission.test/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archetype: "detective", characterName: "Ada" }),
    });
    const signal = request.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    let combinedRequestListeners = 0;
    Object.defineProperties(signal, {
      addEventListener: { configurable: true, value: (...args: Parameters<typeof add>) => {
        if (args[0] === "abort") combinedRequestListeners++;
        return add(...args);
      } },
      removeEventListener: { configurable: true, value: (...args: Parameters<typeof remove>) => {
        if (args[0] === "abort") combinedRequestListeners--;
        return remove(...args);
      } },
    });
    const registry = new Map<string, GameSession>();
    const response = await create(workspace, {
      registry, ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: admission,
      generateSessionId: () => SESSION_ID,
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => { await Bun.sleep(15); return "opening"; };
        return session;
      },
    }, auth, undefined, { archetype: "detective", characterName: "Ada" }, request);
    expect(response.status).toBe(201);
    expect(renewCalls).toBeGreaterThan(0);
    expect(combinedRequestListeners).toBe(0);
    const renewsAtCompletion = renewCalls;
    await Bun.sleep(15);
    expect(renewCalls).toBe(renewsAtCompletion);
    expect(combinedRequestListeners).toBe(0);
    for (const session of registry.values()) session.close();
  });

  test("does not deny an already committed g0 when admission release reports false", async () => {
    const workspace = root();
    mkdirSync(join(workspace, "sessions"));
    const admission = coordinator(join(workspace, "sessions"));
    const originalAcquire = admission.acquire.bind(admission);
    admission.acquire = (input) => {
      const acquired = originalAcquire(input);
      return acquired.status === "acquired" ? { ...acquired, release: () => false } : acquired;
    };
    const registry = new Map<string, GameSession>();
    const response = await create(workspace, {
      registry, ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: admission,
      generateSessionId: () => SESSION_ID,
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => "opening";
        return session;
      },
    });
    expect(response.status).toBe(201);
    expect(registry.has(SESSION_ID)).toBe(true);
    for (const session of registry.values()) session.close();
  });

  test("contains a post-commit staging close failure, restores the authoritative envelope, and releases creation admission", async () => {
    const workspace = root();
    const sessionRoot = join(workspace, "sessions");
    mkdirSync(sessionRoot);
    const admission = new OrdinarySessionCreationAdmissionCoordinator({
      root: sessionRoot, globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000,
      maxTrackedPrincipals: 1_024, leaseTtlMs: 60_000, wholeJobDeadlineMs: 300_000, busyTimeoutMs: 25,
    });
    const registry = new Map<string, GameSession>();
    let serial = 0;
    let closeCalls = 0;
    const dependencies: SessionRuntimeDependencies = {
      registry, ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: admission,
      generateSessionId: () => serial++ === 0 ? SESSION_ID : "12345678-1234-4123-8123-123456789abd",
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => "opening";
        if (storage.careerRoot?.includes(".ordinary-create-staging")) {
          session.close = () => { closeCalls++; throw new Error("probe-close-secret"); };
        }
        return session;
      },
    };
    let first: Response | undefined;
    let thrown: unknown;
    try { first = await create(workspace, dependencies); } catch (error) { thrown = error; }
    expect(thrown).toBeUndefined();
    expect(first?.status).toBe(201);
    expect(await first?.json()).toMatchObject({ sessionId: SESSION_ID, opening: "opening" });
    expect(closeCalls).toBe(1);
    expect(registry.has(SESSION_ID)).toBe(true);

    const otherAuth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "operator", id: "post-commit-close-other" } });
    const second = await create(workspace, dependencies, otherAuth);
    expect(second.status).toBe(201);
    for (const session of registry.values()) session.close();
  });

  test("uses the creation admission deadline for the namespace lease when opening crosses thirty seconds", async () => {
    const workspace = root();
    const sessionRoot = join(workspace, "sessions");
    mkdirSync(sessionRoot);
    let now = 1_000;
    const admission = new OrdinarySessionCreationAdmissionCoordinator({
      root: sessionRoot, globalConcurrent: 2, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000,
      maxTrackedPrincipals: 1_024, leaseTtlMs: 60_000, wholeJobDeadlineMs: 300_000, busyTimeoutMs: 25, now: () => now,
    });
    const registry = new Map<string, GameSession>();
    const response = await create(workspace, {
      registry, ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: admission,
      sessionNamespace: new SessionNamespaceCoordinator(sessionRoot, { now: () => now }),
      generateSessionId: () => SESSION_ID,
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => {
          now += 31_000;
          return "opening after the old namespace default";
        };
        return session;
      },
    });
    expect(response.status).toBe(201);
    expect(registry.has(SESSION_ID)).toBe(true);
    for (const session of registry.values()) session.close();
  });

  test("does not publish a completed opening after its admission fence is no longer active", async () => {
    const workspace = root();
    mkdirSync(join(workspace, "sessions"));
    const admission = coordinator(join(workspace, "sessions"));
    const originalAcquire = admission.acquire.bind(admission);
    admission.acquire = (input) => {
      const acquired = originalAcquire(input);
      return acquired.status === "acquired" ? {
        ...acquired,
        checkActive: () => ({ status: "refused" as const, code: "ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED" as const, retryAfterSeconds: 1 }),
      } : acquired;
    };
    const registry = new Map<string, GameSession>();
    const response = await create(workspace, {
      registry, ordinaryIntentPolicy: "development_fallback", ordinarySessionCreationAdmission: admission,
      generateSessionId: () => SESSION_ID,
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        session.getOpeningScene = async () => "opening";
        return session;
      },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "ORDINARY_SESSION_CREATION_UNAVAILABLE" } });
    expect(registry.size).toBe(0);
  });
});
