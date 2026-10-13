import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPILER_HTTP_BODY_LIMIT_BYTES,
  compilerPrincipalFingerprint,
  handleCompiledModuleHttpRequest,
  type CompiledModuleHttpDependencies,
} from "../api/compiled-module-http";
import {
  COMPILED_SESSION_CREATION_INGRESS_LIMITS,
  CompiledSessionCreationIngressAdmission,
} from "../api/compiled-session-creation-ingress-admission";
import { CompiledSessionCreationAdmissionCoordinator } from "../api/compiled-session-creation-admission";

const durableRoots = new Set<string>();
afterEach(() => {
  for (const root of durableRoots) rmSync(root, { recursive: true, force: true });
  durableRoots.clear();
});

function durableAdmission(): CompiledSessionCreationAdmissionCoordinator {
  const root = mkdtempSync(join(tmpdir(), "compiled-creation-ingress-durable-"));
  durableRoots.add(root);
  return new CompiledSessionCreationAdmissionCoordinator({
    root,
    globalConcurrent: 2,
    perPrincipalConcurrent: 1,
    startsPerPrincipal: 4,
    windowMs: 60_000,
    maxTrackedPrincipals: 1_024,
    leaseTtlMs: 60_000,
    wholeJobDeadlineMs: 300_000,
    busyTimeoutMs: 25,
  });
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function eventually(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

async function responseWithin(pending: Promise<Response | null>, timeoutMs = 300): Promise<Response | null> {
  const timeout = Symbol("request did not settle");
  const result = await Promise.race([pending, Bun.sleep(timeoutMs).then(() => timeout)]);
  expect(result).not.toBe(timeout);
  return result as Response | null;
}

/**
 * Bun may prefetch an underlying stream while constructing a Request. Count
 * getReader, which is the first body operation controlled by this handler.
 */
function readerTrackedRequest(request: Request): { request: Request; readerCalls(): number } {
  let readerCalls = 0;
  return {
    request: new Proxy(request, {
      get(target, property) {
        if (property !== "body") return Reflect.get(target, property, target);
        const body = target.body;
        if (!body) return null;
        return new Proxy(body, {
          get(stream, streamProperty) {
            if (streamProperty !== "getReader") return Reflect.get(stream, streamProperty, stream);
            return () => {
              readerCalls++;
              return stream.getReader();
            };
          },
        });
      },
    }) as Request,
    readerCalls: () => readerCalls,
  };
}

function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
  });
}

function cancellableStalledBody(onCancel: () => Promise<void>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: onCancel,
  });
}

function brokenReaderRequest(principalHint = "broken"): Request {
  const request = new Request(`http://test/api/sessions/compiled?principal=${principalHint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return new Proxy(request, {
    get(target, property) {
      if (property !== "body") return Reflect.get(target, property, target);
      return { getReader: () => { throw new Error("reader is broken"); } };
    },
  }) as Request;
}

function request(
  body: string | ReadableStream<Uint8Array> | null,
  options: { query?: string; header?: string; contentType?: string; contentLength?: string; signal?: AbortSignal } = {},
): Request {
  return new Request(`http://test/api/sessions/compiled${options.query ? `?${options.query}` : ""}`, {
    method: "POST",
    headers: {
      "Content-Type": options.contentType ?? "application/json",
      "X-Attacker-Selected": options.header ?? "untrusted-header",
      ...(options.contentLength === undefined ? {} : { "Content-Length": options.contentLength }),
    },
    body,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

function dependencies(
  ingress: CompiledSessionCreationIngressAdmission | undefined,
  principalId: string,
  options: {
    resolvePlayer?: CompiledModuleHttpDependencies["resolveCompiledSessionPlayer"];
    durableCapability?: object | undefined;
    durableAdmission?: CompiledSessionCreationAdmissionCoordinator;
    catalog?: NonNullable<CompiledModuleHttpDependencies["catalog"]>;
    onCreateSession?: () => void;
    onPersistSession?: () => void;
  } = {},
): CompiledModuleHttpDependencies {
  return {
    ...(options.durableCapability === undefined ? {} : { compiledDurableHostCapability: options.durableCapability }),
    createSession: () => {
      options.onCreateSession?.();
      throw new Error("invalid admission-test body must not construct a session");
    },
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => {
      options.onPersistSession?.();
    },
    generateId: () => "compiled-ingress-test",
    compiledSessionCreationAdmission: options.durableAdmission ?? durableAdmission(),
    ...(ingress ? { compiledSessionCreationIngressAdmission: ingress } : {}),
    ...(options.catalog ? { catalog: options.catalog } : {}),
    authenticateCompilerRequest: () => ({
      status: "authenticated" as const,
      principal: { id: principalId, role: "operator" as const },
    }),
    ...(options.resolvePlayer ? { resolveCompiledSessionPlayer: options.resolvePlayer } : {}),
  };
}

const unassignedPlayer = () => ({ status: "unassigned" as const });
const hostCapability = Object.freeze(Object.create(null)) as object;

describe("compiled session creation ingress admission", () => {
  it("uses fixed production limits and idempotently clears zero-count principals", () => {
    expect(COMPILED_SESSION_CREATION_INGRESS_LIMITS).toEqual({ globalLimit: 2, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    for (const limits of [
      { globalLimit: 0, perPrincipalLimit: 1, retryAfterSeconds: 1 },
      { globalLimit: 1, perPrincipalLimit: 0, retryAfterSeconds: 1 },
      { globalLimit: 1, perPrincipalLimit: 2, retryAfterSeconds: 1 },
      { globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 0 },
    ]) expect(() => new CompiledSessionCreationIngressAdmission(limits)).toThrow();

    const ingress = new CompiledSessionCreationIngressAdmission();
    const first = ingress.acquire("principal-a");
    expect(first.status).toBe("admitted");
    expect(ingress.acquire("principal-a")).toMatchObject({ status: "busy", retryAfterSeconds: 1 });
    if (first.status === "admitted") {
      first.lease.release();
      first.lease.release();
    }
    expect(ingress.acquire("principal-a").status).toBe("admitted");
  });

  it("uses only the authenticated principal bucket and rejects a busy creator before resolver or getReader", async () => {
    const ingress = new CompiledSessionCreationIngressAdmission({ globalLimit: 2, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const playerGate = deferred<{ status: "unassigned" }>();
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls++;
      return await playerGate.promise;
    };
    const first = readerTrackedRequest(request("{}", { query: "bundleId=trusted-a", header: "first" }));
    const firstPending = handleCompiledModuleHttpRequest(
      first.request,
      dependencies(ingress, "trusted-host-principal", { resolvePlayer: resolver, durableCapability: hostCapability }),
    );
    try {
      await eventually(() => resolverCalls === 1);
      const second = readerTrackedRequest(request(JSON.stringify({ bundleId: "attacker-selected-bundle", archetype: "investigator", characterName: "Eve" }), {
        query: "bundleId=attacker-query&tenant=attacker",
        header: "attacker-header",
      }));
      const busy = await responseWithin(handleCompiledModuleHttpRequest(
        second.request,
        dependencies(ingress, "trusted-host-principal", { resolvePlayer: resolver, durableCapability: hostCapability }),
      ));
      expect(busy?.status).toBe(429);
      expect(busy?.headers.get("Retry-After")).toBe("1");
      expect(await busy?.json()).toEqual({ error: { stage: "session", code: "COMPILED_SESSION_CREATION_BUSY", message: "compiled session creation is at capacity" } });
      expect(resolverCalls).toBe(1);
      expect(second.readerCalls()).toBe(0);
    } finally {
      playerGate.resolve({ status: "unassigned" });
      expect((await firstPending)?.status).toBe(400);
    }
  });

  it("enforces the global bound across distinct authenticated principals", async () => {
    const ingress = new CompiledSessionCreationIngressAdmission({ globalLimit: 2, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const playerGate = deferred<{ status: "unassigned" }>();
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls++;
      return await playerGate.promise;
    };
    const first = readerTrackedRequest(request("{}", { query: "one" }));
    const second = readerTrackedRequest(request("{}", { query: "two" }));
    const firstPending = handleCompiledModuleHttpRequest(first.request, dependencies(ingress, "trusted-a", { resolvePlayer: resolver, durableCapability: hostCapability }));
    const secondPending = handleCompiledModuleHttpRequest(second.request, dependencies(ingress, "trusted-b", { resolvePlayer: resolver, durableCapability: hostCapability }));
    try {
      await eventually(() => resolverCalls === 2);
      const third = readerTrackedRequest(request("{}", { query: "attacker-third", header: "attacker-third" }));
      const busy = await responseWithin(handleCompiledModuleHttpRequest(
        third.request,
        dependencies(ingress, "trusted-c", { resolvePlayer: resolver, durableCapability: hostCapability }),
      ));
      expect(busy?.status).toBe(429);
      expect(await busy?.json()).toMatchObject({ error: { stage: "session", code: "COMPILED_SESSION_CREATION_BUSY" } });
      expect(resolverCalls).toBe(2);
      expect(third.readerCalls()).toBe(0);
    } finally {
      playerGate.resolve({ status: "unassigned" });
      await Promise.all([firstPending, secondPending]);
    }
  });

  it("releases slots after resolver, body, reader, and host-capability terminal paths", async () => {
    const ingress = new CompiledSessionCreationIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    let resolverCalls = 0;
    const unavailable = await responseWithin(handleCompiledModuleHttpRequest(
      request("{}"),
      dependencies(ingress, "trusted-reuse", {
        durableCapability: hostCapability,
        resolvePlayer: async () => { resolverCalls++; return { status: "unavailable" }; },
      }),
    ));
    expect(unavailable?.status).toBe(503);

    const abort = new AbortController();
    const abortedRequest = readerTrackedRequest(request(stalledBody(), { signal: abort.signal }));
    const abortedPending = handleCompiledModuleHttpRequest(
      abortedRequest.request,
      dependencies(ingress, "trusted-reuse", { durableCapability: hostCapability, resolvePlayer: async () => { resolverCalls++; return { status: "unassigned" }; } }),
    );
    await eventually(() => abortedRequest.readerCalls() > 0);
    abort.abort();
    expect((await abortedPending)?.status).toBe(408);

    const broken = await responseWithin(handleCompiledModuleHttpRequest(
      brokenReaderRequest(),
      dependencies(ingress, "trusted-reuse", { durableCapability: hostCapability, resolvePlayer: async () => { resolverCalls++; return { status: "unassigned" }; } }),
    ));
    expect(broken?.status).toBe(400);

    const missingCapability = await responseWithin(handleCompiledModuleHttpRequest(
      request("{}"),
      dependencies(ingress, "trusted-reuse", { resolvePlayer: async () => { resolverCalls++; return { status: "unassigned" }; } }),
    ));
    expect(missingCapability?.status).toBe(503);

    const reusable = readerTrackedRequest(request("{}"));
    const reused = await responseWithin(handleCompiledModuleHttpRequest(
      reusable.request,
      dependencies(ingress, "trusted-reuse", { durableCapability: hostCapability, resolvePlayer: async () => { resolverCalls++; return { status: "unassigned" }; } }),
    ));
    expect(reused?.status).toBe(400);
    expect(reusable.readerCalls()).toBeGreaterThan(0);
    expect(resolverCalls).toBe(5);
  });

  it("keeps content-type and declared-length refusals ahead of a full capacity", async () => {
    const ingress = new CompiledSessionCreationIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const held = ingress.acquire("host-held-outside-request");
    if (held.status !== "admitted") throw new Error("test failed to reserve admission slot");
    let resolverCalls = 0;
    const options = { durableCapability: hostCapability, resolvePlayer: async () => { resolverCalls++; return { status: "unassigned" as const }; } };
    try {
      const wrongType = readerTrackedRequest(request(stalledBody(), { contentType: "text/plain" }));
      const invalidLength = readerTrackedRequest(request(stalledBody(), { contentLength: "NaN" }));
      const oversized = readerTrackedRequest(request(stalledBody(), { contentLength: String(COMPILER_HTTP_BODY_LIMIT_BYTES + 1) }));
      expect((await responseWithin(handleCompiledModuleHttpRequest(wrongType.request, dependencies(ingress, "trusted-other", options))))?.status).toBe(415);
      expect((await responseWithin(handleCompiledModuleHttpRequest(invalidLength.request, dependencies(ingress, "trusted-other", options))))?.status).toBe(400);
      expect((await responseWithin(handleCompiledModuleHttpRequest(oversized.request, dependencies(ingress, "trusted-other", options))))?.status).toBe(413);
      expect(resolverCalls).toBe(0);
      expect(wrongType.readerCalls()).toBe(0);
      expect(invalidLength.readerCalls()).toBe(0);
      expect(oversized.readerCalls()).toBe(0);
    } finally {
      held.lease.release();
    }
  });

  it("uses one module-shared production fallback and frees it after creation ends", async () => {
    const playerGate = deferred<{ status: "unassigned" }>();
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls++;
      return await playerGate.promise;
    };
    const first = readerTrackedRequest(request("{}", { query: "first" }));
    const second = readerTrackedRequest(request("{}", { query: "second" }));
    const firstPending = handleCompiledModuleHttpRequest(first.request, dependencies(undefined, "fallback-a", { durableCapability: hostCapability, resolvePlayer: resolver }));
    const secondPending = handleCompiledModuleHttpRequest(second.request, dependencies(undefined, "fallback-b", { durableCapability: hostCapability, resolvePlayer: resolver }));
    try {
      await eventually(() => resolverCalls === 2);
      const third = readerTrackedRequest(request("{}", { query: "attacker-third", header: "attacker-third" }));
      const busy = await responseWithin(handleCompiledModuleHttpRequest(
        third.request,
        dependencies(undefined, "fallback-c", { durableCapability: hostCapability, resolvePlayer: resolver }),
      ));
      expect(busy?.status).toBe(429);
      expect(third.readerCalls()).toBe(0);
      expect(resolverCalls).toBe(2);
    } finally {
      playerGate.resolve({ status: "unassigned" });
      await Promise.all([firstPending, secondPending]);
    }

    const reusable = readerTrackedRequest(request("{}"));
    const reused = await responseWithin(handleCompiledModuleHttpRequest(
      reusable.request,
      dependencies(undefined, "fallback-a", { durableCapability: hostCapability, resolvePlayer: unassignedPlayer }),
    ));
    expect(reused?.status).toBe(400);
    expect(reusable.readerCalls()).toBeGreaterThan(0);
  });

  it("does not fall back to process-local admission when durable admission is missing", async () => {
    let resolverCalls = 0;
    const tracked = readerTrackedRequest(request("{}"));
    const missing = dependencies(undefined, "trusted-no-durable", {
      durableCapability: hostCapability,
      resolvePlayer: async () => { resolverCalls++; return { status: "unassigned" as const }; },
    });
    delete (missing as { compiledSessionCreationAdmission?: unknown }).compiledSessionCreationAdmission;
    const response = await responseWithin(handleCompiledModuleHttpRequest(tracked.request, missing));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: { code: "COMPILED_SESSION_CREATION_UNAVAILABLE" } });
    expect(resolverCalls).toBe(0);
    expect(tracked.readerCalls()).toBe(0);
  });

  it("maps durable busy to the public busy contract before resolver or body work", async () => {
    const durable = durableAdmission();
    const fingerprint = compilerPrincipalFingerprint({ id: "trusted-durable-busy", role: "operator" });
    const held = durable.acquire({ principalFingerprint: fingerprint });
    if (held.status !== "acquired") throw new Error("expected durable held lease");
    let resolverCalls = 0;
    const tracked = readerTrackedRequest(request("{}", { query: "attacker-selected-bucket" }));
    try {
      const bound = dependencies(undefined, "trusted-durable-busy", {
        durableCapability: hostCapability,
        resolvePlayer: async () => { resolverCalls++; return { status: "unassigned" as const }; },
      });
      bound.compiledSessionCreationAdmission = durable;
      const response = await responseWithin(handleCompiledModuleHttpRequest(tracked.request, bound));
      expect(response?.status).toBe(429);
      expect(response?.headers.get("Retry-After")).toBe("1");
      expect(await response?.json()).toMatchObject({ error: { code: "COMPILED_SESSION_CREATION_BUSY" } });
      expect(resolverCalls).toBe(0);
      expect(tracked.readerCalls()).toBe(0);
    } finally { held.release(); }
  });

  it("holds a shared durable lease across the real resolver lifecycle, then releases it only after settlement", async () => {
    const durable = durableAdmission();
    const resolverGate = deferred<{ status: "unassigned" }>();
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls++;
      return await resolverGate.promise;
    };
    const first = readerTrackedRequest(request("{}"));
    const firstPending = handleCompiledModuleHttpRequest(
      first.request,
      dependencies(new CompiledSessionCreationIngressAdmission({ globalLimit: 2, perPrincipalLimit: 1, retryAfterSeconds: 1 }), "shared-durable-principal", {
        durableAdmission: durable,
        durableCapability: hostCapability,
        resolvePlayer: resolver,
      }),
    );
    try {
      await eventually(() => resolverCalls === 1);
      const blocked = readerTrackedRequest(request(JSON.stringify({ bundleId: "attacker-bundle", archetype: "investigator", characterName: "Eve" })));
      const busy = await responseWithin(handleCompiledModuleHttpRequest(
        blocked.request,
        dependencies(new CompiledSessionCreationIngressAdmission({ globalLimit: 2, perPrincipalLimit: 1, retryAfterSeconds: 1 }), "shared-durable-principal", {
          durableAdmission: durable,
          durableCapability: hostCapability,
          resolvePlayer: resolver,
        }),
      ));
      expect(busy?.status).toBe(429);
      expect(await busy?.json()).toMatchObject({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_BUSY" } });
      expect(resolverCalls).toBe(1);
      expect(blocked.readerCalls()).toBe(0);
    } finally {
      resolverGate.resolve({ status: "unassigned" });
    }
    expect((await firstPending)?.status).toBe(400);

    const later = readerTrackedRequest(request("{}"));
    const afterSettlement = await responseWithin(handleCompiledModuleHttpRequest(
      later.request,
      dependencies(new CompiledSessionCreationIngressAdmission({ globalLimit: 2, perPrincipalLimit: 1, retryAfterSeconds: 1 }), "shared-durable-principal", {
        durableAdmission: durable,
        durableCapability: hostCapability,
        resolvePlayer: resolver,
      }),
    ));
    expect(afterSettlement?.status).toBe(400);
    expect(resolverCalls).toBe(2);
    expect(later.readerCalls()).toBeGreaterThan(0);
  });

  it("quarantines an admission lost after player resolution before body, catalog, construction, or publication", async () => {
    let activeChecks = 0;
    let quarantineCalls = 0;
    let catalogTouches = 0;
    let constructed = 0;
    let published = 0;
    const durable = {
      acquire: () => ({
        status: "acquired" as const,
        fence: "f".repeat(64),
        expiresAt: 60_000,
        deadlineAt: 60_000,
        renewalIntervalMs: 60_000,
        remainingDeadlineMs: () => 60_000,
        checkActive: () => {
          activeChecks++;
          return activeChecks === 1
            ? { status: "active" as const, fence: "f".repeat(64), expiresAt: 60_000, deadlineAt: 60_000 }
            : { status: "refused" as const, code: "COMPILED_SESSION_CREATION_ADMISSION_LEASE_EXPIRED" as const, retryAfterSeconds: 1 };
        },
        renew: () => ({ status: "active" as const, fence: "f".repeat(64), expiresAt: 60_000, deadlineAt: 60_000 }),
        release: () => true,
        quarantine: () => {
          quarantineCalls++;
          return { status: "refused" as const, code: "COMPILED_SESSION_CREATION_ADMISSION_UNHEALTHY" as const, retryAfterSeconds: 60 };
        },
      }),
    } as unknown as CompiledSessionCreationAdmissionCoordinator;
    const catalog = new Proxy({}, {
      get() {
        catalogTouches++;
        throw new Error("catalog must not be observed after durable admission loss");
      },
    }) as NonNullable<CompiledModuleHttpDependencies["catalog"]>;
    const tracked = readerTrackedRequest(request(JSON.stringify({ bundleId: "trusted-bundle", archetype: "investigator", characterName: "Eve" })));
    const response = await responseWithin(handleCompiledModuleHttpRequest(
      tracked.request,
      dependencies(new CompiledSessionCreationIngressAdmission({ globalLimit: 2, perPrincipalLimit: 1, retryAfterSeconds: 1 }), "lost-after-resolver", {
        durableAdmission: durable,
        durableCapability: hostCapability,
        resolvePlayer: async () => ({ status: "unassigned" }),
        catalog,
        onCreateSession: () => { constructed++; },
        onPersistSession: () => { published++; },
      }),
    ));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: { stage: "admission", code: "COMPILED_SESSION_CREATION_UNAVAILABLE" } });
    expect(activeChecks).toBe(2);
    expect(quarantineCalls).toBe(1);
    expect(tracked.readerCalls()).toBe(0);
    expect(catalogTouches).toBe(0);
    expect(constructed).toBe(0);
    expect(published).toBe(0);
  });

  it("retains both creation leases until a pending body cancel drain really settles", async () => {
    const ingress = new CompiledSessionCreationIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 1 });
    const durable = durableAdmission();
    const cancelGate = deferred<void>();
    let cancelCalls = 0;
    let resolverCalls = 0;
    const abort = new AbortController();
    const first = readerTrackedRequest(request(cancellableStalledBody(async () => {
      cancelCalls++;
      await cancelGate.promise;
    }), { signal: abort.signal }));
    const resolver = async () => {
      resolverCalls++;
      return { status: "unassigned" as const };
    };
    const firstPending = handleCompiledModuleHttpRequest(first.request, dependencies(ingress, "draining-principal", {
      durableAdmission: durable,
      durableCapability: hostCapability,
      resolvePlayer: resolver,
    }));
    await eventually(() => first.readerCalls() > 0);
    abort.abort();
    const timedOut = await responseWithin(firstPending);
    expect(timedOut?.status).toBe(408);
    await eventually(() => cancelCalls === 1);

    const locallyBlocked = readerTrackedRequest(request("{}"));
    const localBusy = await responseWithin(handleCompiledModuleHttpRequest(locallyBlocked.request, dependencies(ingress, "draining-principal", {
      durableAdmission: durable,
      durableCapability: hostCapability,
      resolvePlayer: resolver,
    })));
    expect(localBusy?.status).toBe(429);
    expect(locallyBlocked.readerCalls()).toBe(0);

    const durablyBlocked = readerTrackedRequest(request("{}"));
    const durableBusy = await responseWithin(handleCompiledModuleHttpRequest(durablyBlocked.request, dependencies(
      new CompiledSessionCreationIngressAdmission({ globalLimit: 1, perPrincipalLimit: 1, retryAfterSeconds: 1 }),
      "draining-principal",
      { durableAdmission: durable, durableCapability: hostCapability, resolvePlayer: resolver },
    )));
    expect(durableBusy?.status).toBe(429);
    expect(durablyBlocked.readerCalls()).toBe(0);
    expect(resolverCalls).toBe(1);

    cancelGate.resolve(undefined);
    let settled: Response | null | undefined;
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const later = readerTrackedRequest(request("{}"));
      settled = await handleCompiledModuleHttpRequest(later.request, dependencies(ingress, "draining-principal", {
        durableAdmission: durable,
        durableCapability: hostCapability,
        resolvePlayer: resolver,
      }));
      if (settled?.status !== 429) {
        expect(settled?.status).toBe(400);
        expect(later.readerCalls()).toBeGreaterThan(0);
        break;
      }
      await Bun.sleep(5);
    }
    expect(settled?.status).toBe(400);
    expect(resolverCalls).toBe(2);
  });
});
