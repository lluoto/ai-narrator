import { afterEach, describe, expect, it } from "bun:test";
import { createHash, createHmac } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotHash, validateCompiledSessionSnapshot } from "../api/compiled-session-snapshot";
import { SnapshotCoordinatorFailure } from "../api/compiled-session-snapshot-coordinator";
import { GameSession } from "../api/game-session";
import { createEnvironmentCompilerAuthenticator, createEnvironmentPlayerDelivery, handleRequest, hydrateCompiledSession, hydrateCompiledSessions } from "../api/server";
import { CompiledPlayerDelivery, CompiledPlayerDeliveryClaimStore, compiledPlayerDeliveryClaimStoreNodeFileOps } from "../api/player-delivery";
import { handleCompiledModuleHttpRequest } from "../api/compiled-module-http";
import { SessionNamespaceCoordinator, type SessionNamespacePublicationPermit } from "../api/session-namespace-coordinator";
import { CompiledSessionCreationAdmissionCoordinator, COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY } from "../api/compiled-session-creation-admission";
import type { SessionNamespacePublicationGate } from "../api/session-namespace-publication";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const OPERATOR_TOKEN = "o".repeat(48);
const KEEPER_TOKEN = "k".repeat(48);
const DELIVERY_SECRET = "delivery_hmac_secret_".padEnd(48, "d");
const CLAIM_ID = "ccccccccccccccccccccccccccccccccccccccccccc";
const ACTION_ID = "018f14a2-c2be-7b73-b291-6e64eaf7868f";
const ownedSessionRegistries = new Set<Map<string, GameSession>>();

// The synchronous link hooks below model an in-process filesystem race. They
// intentionally recurse into another claimant while the outer callback is
// still executing, which cannot model a real SQLite mutex. Process-level
// contention is covered by the dedicated child-process test instead.
function noOpClaimTestCoordinator() {
  return {
    initialize(): void {},
    withExclusive<T>(callback: () => T): T { return callback(); },
  };
}

function createOwnedSessionRegistry(): Map<string, GameSession> {
  const registry = new Map<string, GameSession>();
  ownedSessionRegistries.add(registry);
  return registry;
}

function closeOwnedSessionRegistries(registries: Iterable<Map<string, GameSession>>): unknown[] {
  const closed = new Set<GameSession>();
  const failures: unknown[] = [];
  for (const registry of registries) {
    try {
      for (const session of registry.values()) {
        if (closed.has(session)) continue;
        closed.add(session);
        try {
          session.close();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      registry.clear();
    }
  }
  return failures;
}

function throwCloseFailures(failures: unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "failed to close test-owned GameSessions");
}

function clearOwnedSessionRegistry(registry: Map<string, GameSession>): void {
  throwCloseFailures(closeOwnedSessionRegistries([registry]));
}

afterEach(() => {
  try {
    throwCloseFailures(closeOwnedSessionRegistries(ownedSessionRegistries));
  } finally {
    ownedSessionRegistries.clear();
  }
});

function namespaceBridge(careerRoot: string): {
  namespace: SessionNamespaceCoordinator;
  gate: SessionNamespacePublicationGate;
  compiledSessionCreationAdmission: CompiledSessionCreationAdmissionCoordinator;
} {
  const namespace = new SessionNamespaceCoordinator(join(careerRoot, ".runtime-session-namespace"));
  mkdirSync(namespace.root, { recursive: true });
  return {
    namespace,
    gate: { required: true, consume: namespace.consumePublicationPermit.bind(namespace) },
    compiledSessionCreationAdmission: new CompiledSessionCreationAdmissionCoordinator({
      root: namespace.root,
      ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
    }),
  };
}

function publishSnapshot(
  snapshots: CompiledSessionSnapshotStore,
  snapshot: Parameters<CompiledSessionSnapshotStore["save"]>[0],
  permit: SessionNamespacePublicationPermit,
  gate: SessionNamespacePublicationGate,
) {
  const persisted = snapshots.save(snapshot, { permit }, gate);
  const readback = snapshots.read((snapshot as { sessionId: string }).sessionId);
  if (readback.status === "ok" && readback.value && typeof readback.value === "object") {
    const value = readback.value as { snapshotHash: string; generation: number };
    return { status: "published" as const, observedIdentity: { hash: value.snapshotHash, generation: value.generation, format: "compiled-session-snapshot-v1" } };
  }
  return persisted.status === "refused"
    ? { status: "not-published" as const, failureCode: persisted.code }
    : { status: "indeterminate" as const };
}

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie");
  if (!raw) throw new Error("expected an HttpOnly player cookie");
  return raw.split(";", 1)[0]!;
}

async function createdDeliverySession(root: string, suppliedDelivery?: ReturnType<typeof createEnvironmentPlayerDelivery>) {
  const registry = createOwnedSessionRegistry();
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const saved = saveTrustedFixtureBundle(catalog, fixture);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const authenticator = createEnvironmentCompilerAuthenticator({
    COMPILER_OPERATOR_BEARER_TOKEN: OPERATOR_TOKEN,
    COMPILER_KEEPER_BEARER_TOKEN: KEEPER_TOKEN,
  });
  const delivery = suppliedDelivery ?? createEnvironmentPlayerDelivery({
    COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
    COMPILER_PLAYER_DELIVERY_ROOT: join(root, "delivery"),
    COMPILER_PUBLIC_ORIGIN: "https://example.test",
  });
  const create = await handleRequest(
    new Request("https://example.test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEEPER_TOKEN}` },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }),
    catalog,
    snapshots,
    { careerRoot: join(root, "careers") },
    {},
    {},
    authenticator,
    undefined,
    undefined,
    delivery,
    {},
    { registry },
  );
  expect(create.status).toBe(201);
  const created = await create.json() as { sessionId: string; playerInvitation?: { invite: string; expiresAt: number } };
  return {
    root, catalog, snapshots, authenticator, delivery, registry, created,
    creationHeaders: { cacheControl: create.headers.get("cache-control"), referrerPolicy: create.headers.get("referrer-policy") },
  };
}

async function request(
  built: Awaited<ReturnType<typeof createdDeliverySession>>,
  path: string,
  init: RequestInit = {},
  requestOrigin = "https://example.test",
) {
  return handleRequest(
    new Request(`${requestOrigin}${path}`, init),
    built.catalog,
    built.snapshots,
    { careerRoot: join(built.root, "careers") },
    {},
    {},
    built.authenticator,
    undefined,
    undefined,
    built.delivery,
    {},
    { registry: built.registry },
  );
}

async function assertFreshProcessPlayerDelivery(root: string, sessionId: string, cookie: string): Promise<{ generation: number }> {
  const child = Bun.spawn([process.execPath, "src/__tests__/compiled-player-delivery-restart-child.ts", root, sessionId, cookie], {
    cwd: process.cwd(),
    // This plain Bun child does not run the test preload, and default spawn
    // does not inherit its JavaScript env edits. The auth/restart witness is
    // deliberately offline; provider receipt recovery has its own tests.
    env: { ...process.env, LLM_DISABLED: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`fresh player delivery process failed: ${stderr || stdout}`);
  const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("fresh player delivery process emitted no result");
  return JSON.parse(line) as { generation: number };
}

describe("compiled player delivery with default deployment authentication", () => {
  it("validates an invitation claim against its immutable delivery grant before namespace or recovery work", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-invitation-preauth-"));
    try {
      const built = await createdDeliverySession(root);
      if (!built.created.playerInvitation) throw new Error("expected player invitation");
      clearOwnedSessionRegistry(built.registry);

      const touches = { namespace: 0, catalog: 0, registry: 0, factory: 0 };
      const namespace = new SessionNamespaceCoordinator(join(root, "careers", ".runtime-session-namespace"));
      const observedNamespace = new Proxy(namespace, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => { touches.namespace++; return Reflect.apply(value, target, args); };
        },
      }) as unknown as SessionNamespaceCoordinator;
      const catalog = new Proxy(built.catalog, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => { touches.catalog++; return Reflect.apply(value, target, args); };
        },
      }) as unknown as CompilerArtifactCatalog;
      const registry = createOwnedSessionRegistry();
      for (const method of ["get", "set", "has", "delete"] as const) {
        const original = registry[method].bind(registry);
        (registry as any)[method] = (...args: unknown[]) => {
          touches.registry++;
          return (original as any)(...args);
        };
      }

      const rejected = await handleRequest(new Request(`https://example.test/api/sessions/${built.created.sessionId}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: JSON.stringify({ invite: "x".repeat(43), claimId: CLAIM_ID }),
      }), catalog, built.snapshots, { careerRoot: join(root, "careers") }, {}, {}, built.authenticator,
      undefined, undefined, built.delivery, undefined, {
        registry,
        sessionNamespace: observedNamespace,
        createCompiledRecoverySession: (() => {
          touches.factory++;
          throw new Error("invalid invitation must be refused before hydration");
        }) as any,
      });

      expect(rejected.status).toBe(404);
      expect(rejected.headers.get("cache-control")).toBe("no-store");
      expect(touches).toEqual({ namespace: 0, catalog: 0, registry: 0, factory: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not hydrate or leave a stale claim when a preauthenticated invitation loses its durable generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-invitation-generation-race-"));
    try {
      const built = await createdDeliverySession(root);
      const { sessionId, playerInvitation } = built.created;
      if (!playerInvitation) throw new Error("expected player invitation");
      const stored = built.snapshots.read(sessionId);
      if (stored.status !== "ok") throw new Error(stored.message);
      const checkedStored = validateCompiledSessionSnapshot(stored.value);
      if (checkedStored.status !== "ok") throw new Error(checkedStored.message);
      const original = checkedStored.value;
      const successor = structuredClone(original) as any;
      successor.generation += 1;
      successor.previousSnapshotHash = original.snapshotHash;
      successor.snapshotHash = compiledSessionSnapshotHash(successor);
      expect(validateCompiledSessionSnapshot(successor)).toMatchObject({ status: "ok" });

      const namespace = new SessionNamespaceCoordinator(join(root, "careers", ".runtime-session-namespace"));
      let advanceResult: unknown;
      const advanceToSuccessor = () => (advanceResult = namespace.publishCommitted({
        kind: "compiled",
        sessionId,
        previousIdentity: { hash: original.snapshotHash, generation: original.generation, format: "compiled-session-snapshot-v1" },
        nextIdentity: { hash: successor.snapshotHash, generation: successor.generation, format: "compiled-session-snapshot-v1" },
        publish: (permit) => publishSnapshot(built.snapshots, successor, permit, {
          required: true,
          consume: namespace.consumePublicationPermit.bind(namespace),
        }),
      }));

      // First, let an independent durable writer install B exactly after the
      // A invite has passed pure validation but before request-time hydration.
      // The request must see the pointer mismatch before touching the factory
      // or its mutable delivery acknowledgement.
      clearOwnedSessionRegistry(built.registry);
      let switchedBeforeHydration = false;
      let hydrationFactoryCalls = 0;
      const namespaceSwitchingBeforeHydration = new Proxy(namespace, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (property === "read" && !switchedBeforeHydration) {
              switchedBeforeHydration = true;
              advanceToSuccessor();
            }
            return Reflect.apply(value, target, args);
          };
        },
      }) as unknown as SessionNamespaceCoordinator;
      const rejectedBeforeHydration = await handleRequest(new Request(`https://example.test/api/sessions/${sessionId}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: JSON.stringify({ invite: playerInvitation.invite, claimId: CLAIM_ID }),
      }), built.catalog, built.snapshots, { careerRoot: join(root, "careers") }, {}, {}, built.authenticator,
      undefined, undefined, built.delivery, undefined, {
        registry: built.registry,
        sessionNamespace: namespaceSwitchingBeforeHydration,
        createCompiledRecoverySession: (() => {
          hydrationFactoryCalls += 1;
          throw new Error("a stale invitation must not hydrate");
        }) as any,
      });
      expect(switchedBeforeHydration).toBe(true);
      expect(advanceResult).toMatchObject({ state: "committed", expectedIdentity: { hash: successor.snapshotHash, generation: successor.generation } });
      expect(rejectedBeforeHydration.status).toBe(404);
      expect(rejectedBeforeHydration.headers.get("cache-control")).toBe("no-store");
      expect(rejectedBeforeHydration.headers.get("set-cookie")).toBeNull();
      expect(hydrationFactoryCalls).toBe(0);
      expect(built.registry.has(sessionId)).toBe(false);
      expect(existsSync(join(root, "delivery"))).toBe(false);

    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an immutable invitation retry-safe if generation B wins at the claim boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-invitation-claim-race-"));
    try {
      const built = await createdDeliverySession(root);
      const { sessionId, playerInvitation } = built.created;
      if (!playerInvitation) throw new Error("expected player invitation");
      const stored = built.snapshots.read(sessionId);
      if (stored.status !== "ok") throw new Error(stored.message);
      const checkedStored = validateCompiledSessionSnapshot(stored.value);
      if (checkedStored.status !== "ok") throw new Error(checkedStored.message);
      const original = checkedStored.value;
      const successor = structuredClone(original) as any;
      successor.generation += 1;
      successor.previousSnapshotHash = original.snapshotHash;
      successor.snapshotHash = compiledSessionSnapshotHash(successor);
      expect(validateCompiledSessionSnapshot(successor)).toMatchObject({ status: "ok" });

      const namespace = new SessionNamespaceCoordinator(join(root, "careers", ".runtime-session-namespace"));
      let advancedAtClaim = false;
      const advanceAtClaim = () => {
        if (advancedAtClaim) return;
        advancedAtClaim = true;
        const published = namespace.publishCommitted({
          kind: "compiled",
          sessionId,
          previousIdentity: { hash: original.snapshotHash, generation: original.generation, format: "compiled-session-snapshot-v1" },
          nextIdentity: { hash: successor.snapshotHash, generation: successor.generation, format: "compiled-session-snapshot-v1" },
          publish: (permit) => publishSnapshot(built.snapshots, successor, permit, {
            required: true,
            consume: namespace.consumePublicationPermit.bind(namespace),
          }),
        });
        expect(published).toMatchObject({ state: "committed", expectedIdentity: { hash: successor.snapshotHash, generation: successor.generation } });
      };
      const racingDelivery = new Proxy(built.delivery, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (property === "claim") advanceAtClaim();
            return Reflect.apply(value, target, args);
          };
        },
      }) as unknown as CompiledPlayerDelivery;

      clearOwnedSessionRegistry(built.registry);
      const staleClaim = await handleRequest(new Request(`https://example.test/api/sessions/${sessionId}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: JSON.stringify({ invite: playerInvitation.invite, claimId: CLAIM_ID }),
      }), built.catalog, built.snapshots, { careerRoot: join(root, "careers") }, {}, {}, built.authenticator,
      undefined, undefined, racingDelivery, undefined, {
        registry: built.registry,
        sessionNamespace: namespace,
      });

      expect(advancedAtClaim).toBe(true);
      expect(staleClaim.status).toBe(404);
      expect(staleClaim.headers.get("cache-control")).toBe("no-store");
      expect(staleClaim.headers.get("set-cookie")).toBeNull();
      expect(built.registry.has(sessionId)).toBe(false);
      // A successor may never rotate durable access. The same invited player
      // can therefore retry safely against B; it is not an old grant being
      // replayed into a different principal identity.
      if (!original.access?.playerDelivery) throw new Error("expected delivery grant");
      expect(built.delivery.claim(sessionId, original.access.playerDelivery, playerInvitation.invite, CLAIM_ID)).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a possibly committed create in-process, and keeps a no-store invitation usable for lazy durable recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-session-create-recovery-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = saveTrustedFixtureBundle(catalog, fixture);
      const delivery = createEnvironmentPlayerDelivery({
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
        COMPILER_PLAYER_DELIVERY_ROOT: join(root, "delivery"),
        COMPILER_PUBLIC_ORIGIN: "https://example.test",
      });
      const ownerToken = "owner-token";
      const foreignToken = "foreign-token";
      const authenticator = (req: Request) => {
        const bearer = req.headers.get("Authorization");
        if (bearer === `Bearer ${ownerToken}`) return { status: "authenticated" as const, principal: { id: "owner", role: "keeper" as const } };
        if (bearer === `Bearer ${foreignToken}`) return { status: "authenticated" as const, principal: { id: "foreign", role: "keeper" as const } };
        return { status: "unauthenticated" as const };
      };
      const closeFailure = new CompiledSessionSnapshotStore({
        root: join(root, "immediate-snapshots"),
        coordinatorFactory: () => ({
          initializePolicy: () => undefined,
          beginPublication: () => undefined,
          finishPublication: () => ({ closeFailure: new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "forced post-publication close failure") }),
        }),
      });
      const immediateRegistry = createOwnedSessionRegistry();
      const immediate = await handleRequest(new Request("https://example.test/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
      }), catalog, closeFailure, { careerRoot: join(root, "immediate-careers") }, {}, {}, authenticator, undefined, undefined, delivery, {}, { registry: immediateRegistry });
      expect(immediate.status).toBe(201);
      const immediateBody = await immediate.json() as { sessionId: string; playerInvitation?: { invite: string } };
      expect(immediateBody.playerInvitation?.invite).toEqual(expect.any(String));
      expect(immediateRegistry.has(immediateBody.sessionId)).toBe(true);

      const lazyRegistry = createOwnedSessionRegistry();
      const lazySnapshots = new CompiledSessionSnapshotStore({
        root: join(root, "lazy-snapshots"),
        coordinatorFactory: () => ({
          initializePolicy: () => undefined,
          beginPublication: () => undefined,
          finishPublication: () => ({ closeFailure: new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "forced post-publication close failure") }),
        }),
      });
      // Server request gates accept only server-generated UUID locators; the
      // direct HTTP seam must use the same public-ID contract as production.
      const lazyId = "12345678-1234-4123-8123-123456789ab1";
      const lazyCareerRoot = join(root, "lazy-careers");
      const lazyNamespace = namespaceBridge(lazyCareerRoot);
      const lazyHost = createCompiledDurableTestHost();
      const deferred = await handleCompiledModuleHttpRequest(new Request("https://example.test/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Bea" }),
      }), {
        compiledDurableHostCapability: lazyHost.capability,
        createSession: (id, archetype, characterName, persona) => new GameSession(id, "cosmic-horror", undefined, archetype, characterName, persona, { careerRoot: lazyCareerRoot }, undefined, "preferred", lazyHost.runtimeDependencies),
        hasSession: (id) => lazyRegistry.has(id),
        registerSession: (id, session) => lazyRegistry.set(id, session as GameSession),
        unregisterSession: (id, expectedSession) => { if (lazyRegistry.get(id) === expectedSession) lazyRegistry.delete(id); },
        persistSession: (_id, _session, _bundleId, snapshot, permit) => permit
          ? publishSnapshot(lazySnapshots, snapshot, permit, lazyNamespace.gate)
          : { status: "indeterminate" as const },
        recoverPersistedSession: () => undefined,
        generateId: () => lazyId,
        catalog,
        authenticateCompilerRequest: authenticator,
        playerDelivery: delivery,
        sessionNamespace: lazyNamespace.namespace,
        compiledSessionCreationAdmission: lazyNamespace.compiledSessionCreationAdmission,
      });
      if (!deferred) throw new Error("expected compiled create response");
      expect(deferred.status).toBe(503);
      expect(deferred.headers.get("Retry-After")).toBe("1");
      expect(deferred.headers.get("Cache-Control")).toBe("no-store");
      const deferredBody = await deferred.json() as { error: { recovery?: { sessionId: string; generation: number } }; playerInvitation?: { invite: string } };
      expect(deferredBody.error.recovery).toEqual({ sessionId: lazyId, generation: 0 });
      if (!deferredBody.playerInvitation) throw new Error("expected retained invitation for durable recovery");
      expect(lazyRegistry.has(lazyId)).toBe(false);
      expect(lazyNamespace.namespace.read(lazyId)).toMatchObject({ kind: "compiled", state: "committed", expectedIdentity: { generation: 0, format: "compiled-session-snapshot-v1" } });

      const foreign = await handleRequest(new Request(`https://example.test/api/sessions/${lazyId}`, {
        headers: { Authorization: `Bearer ${foreignToken}` },
      }), catalog, lazySnapshots, { careerRoot: join(root, "lazy-careers") }, {}, {}, authenticator, undefined, undefined, delivery, {}, { registry: lazyRegistry });
      expect(foreign.status).toBe(404);
      expect(foreign.headers.get("Cache-Control")).toBe("no-store");
      expect(lazyRegistry.has(lazyId)).toBe(false);

      const anonymousFacade = await handleRequest(new Request(`https://example.test/api/sessions/${lazyId}/player-view`), catalog, lazySnapshots, { careerRoot: join(root, "lazy-careers") }, {}, {}, authenticator, undefined, undefined, delivery, {}, { registry: lazyRegistry });
      expect(anonymousFacade.status).toBe(401);
      expect(lazyRegistry.has(lazyId)).toBe(false);
      const invalidClaim = await handleRequest(new Request(`https://example.test/api/sessions/${lazyId}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: JSON.stringify({ invite: "x".repeat(43), claimId: CLAIM_ID }),
      }), catalog, lazySnapshots, { careerRoot: join(root, "lazy-careers") }, {}, {}, authenticator, undefined, undefined, delivery, {}, { registry: lazyRegistry });
      expect(invalidClaim.status).toBe(404);
      expect(lazyRegistry.has(lazyId)).toBe(false);

      const owner = await handleRequest(new Request(`https://example.test/api/sessions/${lazyId}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }), catalog, lazySnapshots, { careerRoot: join(root, "lazy-careers") }, {}, {}, authenticator, undefined, undefined, delivery, {}, { registry: lazyRegistry });
      expect(owner.status).toBe(200);
      expect(lazyRegistry.has(lazyId)).toBe(true);

      clearOwnedSessionRegistry(lazyRegistry);
      let releaseClaimBody: (() => void) | undefined;
      const claimBodyReady = new Promise<void>((resolve) => { releaseClaimBody = resolve; });
      const delayedClaimBody = new ReadableStream<Uint8Array>({
        async start(controller) {
          await claimBodyReady;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ invite: deferredBody.playerInvitation!.invite, claimId: CLAIM_ID })));
          controller.close();
        },
      });
      const claimedPromise = handleRequest(new Request(`https://example.test/api/sessions/${lazyId}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: delayedClaimBody,
        duplex: "half",
      }), catalog, lazySnapshots, { careerRoot: join(root, "lazy-careers") }, {}, {}, authenticator, undefined, undefined, delivery, {}, { registry: lazyRegistry });
      await Promise.resolve();
      const adopter = await handleRequest(new Request(`https://example.test/api/sessions/${lazyId}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }), catalog, lazySnapshots, { careerRoot: join(root, "lazy-careers") }, {}, {}, authenticator, undefined, undefined, delivery, {}, { registry: lazyRegistry });
      expect(adopter.status).toBe(200);
      const winner = lazyRegistry.get(lazyId);
      expect(winner).toBeDefined();
      releaseClaimBody?.();
      const claimed = await claimedPromise;
      expect(claimed.status).toBe(204);
      expect(lazyRegistry.has(lazyId)).toBe(true);
      expect(lazyRegistry.get(lazyId)).toBe(winner);

      const raceSnapshots = new CompiledSessionSnapshotStore({ root: join(root, "race-snapshots") });
      const raceId = "12345678-1234-4123-8123-123456789ab2";
      const raceCareerRoot = join(root, "race-careers");
      const raceStagingCareerRoot = join(root, "race-staging-careers");
      const raceNamespace = namespaceBridge(raceCareerRoot);
      const raceHost = createCompiledDurableTestHost();
      const seeded = await handleCompiledModuleHttpRequest(new Request("https://example.test/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Cy" }),
      }), {
        // The direct HTTP seam still follows the production lifecycle: the
        // candidate owns only a private staging root and recovery constructs
        // the authoritative real-root winner from the committed snapshot.
        compiledDurableHostCapability: raceHost.capability,
        createSession: (id, archetype, characterName, persona) => new GameSession(id, "cosmic-horror", undefined, archetype, characterName, persona, { careerRoot: raceStagingCareerRoot }, undefined, "preferred", raceHost.runtimeDependencies),
        hasSession: () => false,
        registerSession: () => undefined,
        unregisterSession: (_id, session) => (session as GameSession).close(),
        persistSession: (_id, _session, _bundleId, snapshot, permit) => permit
          ? publishSnapshot(raceSnapshots, snapshot, permit, raceNamespace.gate)
          : { status: "indeterminate" as const },
        recoverPersistedSession: (id) => {
          const recovered = hydrateCompiledSession(id, {
            catalog,
            snapshots: raceSnapshots,
            sessionNamespace: raceNamespace.namespace,
            compiledDurableHostCapability: raceHost.capability,
            createSession: (sessionId, runtimeDependencies) => new GameSession(sessionId, "cosmic-horror", undefined, undefined, undefined, undefined, { careerRoot: raceCareerRoot }, undefined, "preferred", runtimeDependencies),
          });
          return recovered.status === "ok" ? recovered.session : undefined;
        },
        generateId: () => raceId,
        catalog,
        authenticateCompilerRequest: authenticator,
        sessionNamespace: raceNamespace.namespace,
        compiledSessionCreationAdmission: raceNamespace.compiledSessionCreationAdmission,
      });
      expect(seeded?.status).toBe(201);
      const raceRegistry = createOwnedSessionRegistry();
      let releaseFacadeAuthentication: (() => void) | undefined;
      const facadeAuthenticationReady = new Promise<void>((resolve) => { releaseFacadeAuthentication = resolve; });
      const racingAuthenticator = async (req: Request) => {
        if (new URL(req.url).pathname.endsWith("/player-view")) await facadeAuthenticationReady;
        return authenticator(req);
      };
      const facadePromise = handleRequest(new Request(`https://example.test/api/sessions/${raceId}/player-view`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }), catalog, raceSnapshots, { careerRoot: join(root, "race-careers") }, {}, {}, racingAuthenticator, undefined, undefined, delivery, {}, { registry: raceRegistry });
      await Promise.resolve();
      const raceAdopter = await handleRequest(new Request(`https://example.test/api/sessions/${raceId}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }), catalog, raceSnapshots, { careerRoot: join(root, "race-careers") }, {}, {}, racingAuthenticator, undefined, undefined, delivery, {}, { registry: raceRegistry });
      expect(raceAdopter.status).toBe(200);
      const raceWinner = raceRegistry.get(raceId);
      if (!raceWinner) throw new Error("expected interleaved durable adopter");
      (raceWinner as unknown as { getCompiledPlayerFacadeView(): unknown }).getCompiledPlayerFacadeView = () => ({ source: "registry-winner" });
      releaseFacadeAuthentication?.();
      const facade = await facadePromise;
      expect(facade.status).toBe(200);
      expect(await facade.json()).toEqual({ source: "registry-winner" });
      expect(raceRegistry.get(raceId)).toBe(raceWinner);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("issues an owner-only invitation then binds a retry-safe cookie to exactly one compiled session", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-delivery-"));
    try {
      const built = await createdDeliverySession(root);
      const { sessionId, playerInvitation } = built.created;
      expect(playerInvitation?.invite).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (!playerInvitation) throw new Error("expected player invitation");
      const base = `/api/sessions/${sessionId}`;
      const createdText = JSON.stringify(built.created);
      expect(createdText).toContain(playerInvitation.invite);
      // The one response allowed to carry the raw invite must never be stored
      // by a browser cache or forwarded as a referrer.
      expect(built.creationHeaders).toEqual({ cacheControl: "no-store", referrerPolicy: "no-referrer" });

      const unknownPlayerRoute = await request(built, "/api/sessions/no-such-player-session/player-view");
      expect(unknownPlayerRoute.status).toBe(401);
      expect(unknownPlayerRoute.headers.get("cache-control")).toBe("no-store");
      expect(unknownPlayerRoute.headers.get("access-control-allow-origin")).toBeNull();
      expect((await request(built, `${base}/player-view`)).status).toBe(401);
      const badClaim = await request(built, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: JSON.stringify({ invite: "x".repeat(43), claimId: CLAIM_ID }),
      });
      expect(badClaim.status).toBe(404);
      expect(badClaim.headers.get("access-control-allow-origin")).toBeNull();
      const crossOriginClaim = await request(built, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://attacker.test" },
        body: JSON.stringify({ invite: playerInvitation.invite, claimId: CLAIM_ID }),
      });
      expect(crossOriginClaim.status).toBe(404);
      expect(crossOriginClaim.headers.get("cache-control")).toBe("no-store");
      let nonJsonClaimCancelled = false;
      const nonJsonClaim = await request(built, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Origin: "https://example.test" },
        body: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode("untrusted body")); },
          cancel() { nonJsonClaimCancelled = true; },
        }),
      });
      expect(nonJsonClaim.status).toBe(400);
      expect(nonJsonClaim.headers.get("cache-control")).toBe("no-store");
      expect(nonJsonClaimCancelled).toBe(true);
      const declaredOversizeClaimBody = JSON.stringify({ invite: playerInvitation.invite, claimId: CLAIM_ID, padding: "x".repeat(9_000) });
      const declaredOversizeClaim = await request(built, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(declaredOversizeClaimBody).byteLength), Origin: "https://example.test" },
        body: declaredOversizeClaimBody,
      });
      expect(declaredOversizeClaim.status).toBe(413);
      expect(declaredOversizeClaim.headers.get("cache-control")).toBe("no-store");
      const unknownLengthOversizeClaim = await request(built, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ invite: playerInvitation.invite, claimId: CLAIM_ID, padding: "x".repeat(9_000) })));
            controller.close();
          },
        }),
      });
      expect(unknownLengthOversizeClaim.status).toBe(413);
      expect(unknownLengthOversizeClaim.headers.get("cache-control")).toBe("no-store");
      let liedLengthClaimCancelled = false;
      const liedLengthClaim = await request(built, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "1", Origin: "https://example.test" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ invite: playerInvitation.invite, claimId: CLAIM_ID, padding: "x".repeat(9_000) })));
          },
          cancel() { liedLengthClaimCancelled = true; },
        }),
      });
      expect(liedLengthClaim.status).toBe(413);
      expect(liedLengthClaim.headers.get("cache-control")).toBe("no-store");
      expect(liedLengthClaim.headers.get("access-control-allow-origin")).toBeNull();
      expect(liedLengthClaimCancelled).toBe(true);
      const claim = await request(built, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: JSON.stringify({ invite: playerInvitation.invite, claimId: CLAIM_ID }),
      });
      expect(claim.status).toBe(204);
      expect(claim.headers.get("cache-control")).toBe("no-store");
      expect(claim.headers.get("access-control-allow-origin")).toBeNull();
      expect(claim.headers.get("set-cookie")).toContain("HttpOnly");
      expect(claim.headers.get("set-cookie")).toContain("Secure");
      expect(claim.headers.get("set-cookie")).toContain("SameSite=Strict");
      const cookie = cookieFrom(claim);

      const replay = await request(built, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: JSON.stringify({ invite: playerInvitation.invite, claimId: CLAIM_ID }),
      });
      expect(replay.status).toBe(204);
      expect(cookieFrom(replay)).toBe(cookie);
      expect((await request(built, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: JSON.stringify({ invite: playerInvitation.invite, claimId: "ddddddddddddddddddddddddddddddddddddddddddd" }),
      })).status).toBe(404);

      const view = await request(built, `${base}/player-view`, { headers: { Cookie: cookie } });
      expect(view.status).toBe(200);
      expect(view.headers.get("cache-control")).toBe("no-store");
      expect(view.headers.get("access-control-allow-origin")).toBeNull();
      const payload = await view.json() as any;
      expect(payload.actions.length).toBeGreaterThan(0);
      const unknownLengthOversizeAction = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ choiceId: payload.actions[0].choiceId, actionId: "018f14a2-c2be-7b73-b291-6e64eaf78690", expectedGeneration: payload.generation, padding: "x".repeat(9_000) })));
          controller.close();
        },
      });
      const oversizedAction = await request(built, `${base}/player-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: cookie },
        body: unknownLengthOversizeAction,
      });
      expect(oversizedAction.status).toBe(413);
      expect(oversizedAction.headers.get("cache-control")).toBe("no-store");
      const declaredOversizeActionBody = JSON.stringify({ choiceId: payload.actions[0].choiceId, actionId: "018f14a2-c2be-7b73-b291-6e64eaf78689", expectedGeneration: payload.generation, padding: "x".repeat(9_000) });
      const declaredOversizeAction = await request(built, `${base}/player-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(declaredOversizeActionBody).byteLength), Origin: "https://example.test", Cookie: cookie },
        body: declaredOversizeActionBody,
      });
      expect(declaredOversizeAction.status).toBe(413);
      expect(declaredOversizeAction.headers.get("cache-control")).toBe("no-store");
      let liedLengthActionCancelled = false;
      const liedLengthAction = await request(built, `${base}/player-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "1", Origin: "https://example.test", Cookie: cookie },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ choiceId: payload.actions[0].choiceId, actionId: "018f14a2-c2be-7b73-b291-6e64eaf78688", expectedGeneration: payload.generation, padding: "x".repeat(9_000) })));
          },
          cancel() { liedLengthActionCancelled = true; },
        }),
      });
      expect(liedLengthAction.status).toBe(413);
      expect(liedLengthAction.headers.get("cache-control")).toBe("no-store");
      expect(liedLengthAction.headers.get("access-control-allow-origin")).toBeNull();
      expect(liedLengthActionCancelled).toBe(true);
      const staleAction = await request(built, `${base}/player-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: cookie },
        body: JSON.stringify({ choiceId: payload.actions[0].choiceId, actionId: "018f14a2-c2be-7b73-b291-6e64eaf78691", expectedGeneration: payload.generation + 1 }),
      });
      expect(staleAction.status).toBe(409);
      expect(staleAction.headers.get("cache-control")).toBe("no-store");
      const action = await request(built, `${base}/player-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: cookie },
        body: JSON.stringify({ choiceId: payload.actions[0].choiceId, actionId: ACTION_ID, expectedGeneration: payload.generation }),
      });
      expect(action.status).toBe(200);
      expect(action.headers.get("cache-control")).toBe("no-store");
      expect(action.headers.get("access-control-allow-origin")).toBeNull();
      const acted = await action.json() as any;
      expect(acted.view.generation).toBe(1);
      const retry = await request(built, `${base}/player-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: cookie },
        body: JSON.stringify({ choiceId: payload.actions[0].choiceId, actionId: ACTION_ID, expectedGeneration: payload.generation }),
      });
      expect(retry.status).toBe(200);
      expect((await retry.json() as any).result.status).toBe("duplicate");

      expect((await request(built, `${base}/state`, { headers: { Cookie: cookie } })).status).toBe(401);
      expect((await request(built, `${base}/player-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ choiceId: payload.actions[0].choiceId, actionId: "018f14a2-c2be-7b73-b291-6e64eaf78690", expectedGeneration: payload.generation }),
      })).status).toBe(401);

      // A new Bun process owns a fresh default registry, hydrates it, then
      // goes back through the actual cookie façade routes before committing.
      expect(await assertFreshProcessPlayerDelivery(root, sessionId, cookie)).toMatchObject({
        generation: 2,
        hydration: { hydrated: [sessionId], unavailable: [] },
      });

      // The parent still holds its pre-child g0 object. A valid facade read
      // must replace that stale local object with the exact committed g1
      // namespace, rather than treating any compiled session as sufficient.
      const rehydrated = await request(built, `${base}/player-view`, { headers: { Cookie: cookie } });
      expect(rehydrated.status).toBe(200);
      expect((await rehydrated.json() as { generation: number }).generation).toBe(2);
      expect(built.registry.get(sessionId)?.getCompiledGeneration()).toBe(2);

      const foreign = await createdDeliverySession(root);
      expect((await request(foreign, `/api/sessions/${foreign.created.sessionId}/player-view`, { headers: { Cookie: cookie } })).status).toBe(401);
      // The sidecar only stores one-way digest state. Altering that state must
      // make the snapshot/sidecar pair fail closed through HTTP authentication.
      const sidecarPath = join(root, "delivery", readdirSync(join(root, "delivery")).find((name) => name.endsWith(".claim.json"))!);
      const alteredSidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
      alteredSidecar.claimIdDigest = "a".repeat(64);
      writeFileSync(sidecarPath, `${JSON.stringify(alteredSidecar)}\n`);
      const mismatched = await request(built, `${base}/player-view`, { headers: { Cookie: cookie } });
      expect(mismatched.status).toBe(401);
      expect(mismatched.headers.get("cache-control")).toBe("no-store");
      const snapshotFiles = readdirSync(join(root, "snapshots")).map((name) => readFileSync(join(root, "snapshots", name), "utf8")).join("\n");
      const deliveryFiles = readdirSync(join(root, "delivery")).map((name) => readFileSync(join(root, "delivery", name), "utf8")).join("\n");
      for (const forbidden of [playerInvitation.invite, CLAIM_ID, cookie, DELIVERY_SECRET, KEEPER_TOKEN]) {
        expect(snapshotFiles).not.toContain(forbidden);
        expect(deliveryFiles).not.toContain(forbidden);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed for expiry and invalid deployment delivery configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-delivery-expiry-"));
    try {
      let now = 1_000_000;
      const delivery = createEnvironmentPlayerDelivery({
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
        COMPILER_PLAYER_DELIVERY_INVITE_TTL_SECONDS: "60",
        COMPILER_PLAYER_DELIVERY_COOKIE_TTL_SECONDS: "60",
        COMPILER_PLAYER_DELIVERY_ROOT: join(root, "delivery"),
        COMPILER_PUBLIC_ORIGIN: "https://example.test",
      }, { now: () => now });
      const built = await createdDeliverySession(root, delivery);
      if (!built.created.playerInvitation) throw new Error("expected player invitation");
      now += 60_001;
      expect((await request(built, `/api/sessions/${built.created.sessionId}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://example.test" },
        body: JSON.stringify({ invite: built.created.playerInvitation.invite, claimId: CLAIM_ID }),
      })).status).toBe(404);

      const unavailableSecret = createEnvironmentPlayerDelivery({
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: "short",
        COMPILER_PLAYER_DELIVERY_INVITE_TTL_SECONDS: "60",
        COMPILER_PLAYER_DELIVERY_ROOT: join(root, "invalid-delivery"),
        COMPILER_PUBLIC_ORIGIN: "https://example.test",
      });
      const unavailableTtl = createEnvironmentPlayerDelivery({
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
        COMPILER_PLAYER_DELIVERY_INVITE_TTL_SECONDS: "59",
        COMPILER_PLAYER_DELIVERY_ROOT: join(root, "invalid-ttl-delivery"),
        COMPILER_PUBLIC_ORIGIN: "https://example.test",
      });
      const unavailablePublicOrigin = createEnvironmentPlayerDelivery({
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
        COMPILER_PUBLIC_ORIGIN: "https://play.example/not-an-origin",
        COMPILER_PLAYER_DELIVERY_ROOT: join(root, "invalid-origin-delivery"),
      });
      const missingPublicOrigin = createEnvironmentPlayerDelivery({
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
        COMPILER_PLAYER_DELIVERY_ROOT: join(root, "missing-origin-delivery"),
      });
      expect(unavailableSecret.available).toBe(false);
      expect(unavailableTtl.available).toBe(false);
      expect(unavailablePublicOrigin.available).toBe(false);
      expect(missingPublicOrigin.available).toBe(false);
      for (const invalidOrigin of ["http://play.example", "https://play.example/path", "https://play.example?query=1", "https://user@play.example", "not a url"]) {
        expect(createEnvironmentPlayerDelivery({
          COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
          COMPILER_PUBLIC_ORIGIN: invalidOrigin,
          COMPILER_PLAYER_DELIVERY_ROOT: join(root, `invalid-origin-${invalidOrigin.length}`),
        }).available).toBe(false);
      }
      const normalizedDefaultPort = createEnvironmentPlayerDelivery({
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
        COMPILER_PUBLIC_ORIGIN: "https://play.example:443",
        COMPILER_PLAYER_DELIVERY_ROOT: join(root, "normalized-origin-delivery"),
      });
      expect(normalizedDefaultPort.available).toBe(true);
      expect(normalizedDefaultPort.publicOrigin).toBe("https://play.example");
      expect(new CompiledPlayerDelivery({ secret: DELIVERY_SECRET, publicOrigin: "http://injected.example" }).available).toBe(false);
      expect(new CompiledPlayerDelivery({ secret: DELIVERY_SECRET, publicOrigin: "https://injected.example/path" }).available).toBe(false);
      const ownerOnly = await createdDeliverySession(root, unavailableTtl);
      expect(ownerOnly.created.playerInvitation).toBeUndefined();
      expect(ownerOnly.creationHeaders.cacheControl).not.toBe("no-store");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("uses only an explicit public origin for a TLS proxy and ignores forwarded headers", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-delivery-origin-"));
    try {
      const proxiedDelivery = createEnvironmentPlayerDelivery({
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
        COMPILER_PUBLIC_ORIGIN: "https://play.example",
        COMPILER_PLAYER_DELIVERY_ROOT: join(root, "delivery"),
      });
      const proxied = await createdDeliverySession(root, proxiedDelivery);
      if (!proxied.created.playerInvitation) throw new Error("expected proxied invitation");
      const base = `/api/sessions/${proxied.created.sessionId}`;
      const badOrigin = await request(proxied, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://attacker.example", "X-Forwarded-Host": "play.example", "X-Forwarded-Proto": "https" },
        body: JSON.stringify({ invite: proxied.created.playerInvitation.invite, claimId: CLAIM_ID }),
      }, "http://internal.test");
      expect(badOrigin.status).toBe(404);
      const goodOrigin = await request(proxied, `${base}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://play.example" },
        body: JSON.stringify({ invite: proxied.created.playerInvitation.invite, claimId: CLAIM_ID }),
      }, "http://internal.test");
      expect(goodOrigin.status).toBe(204);

      const directDelivery = createEnvironmentPlayerDelivery({
        COMPILER_PLAYER_DELIVERY_HMAC_SECRET: DELIVERY_SECRET,
        COMPILER_PLAYER_DELIVERY_ROOT: join(root, "direct-delivery"),
        COMPILER_PUBLIC_ORIGIN: "https://example.test",
      });
      const direct = await createdDeliverySession(root, directDelivery);
      if (!direct.created.playerInvitation) throw new Error("expected direct invitation");
      expect((await request(direct, `/api/sessions/${direct.created.sessionId}/player-invitations/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://play.example", "X-Forwarded-Host": "play.example", "X-Forwarded-Proto": "https" },
        body: JSON.stringify({ invite: direct.created.playerInvitation.invite, claimId: CLAIM_ID }),
      }, "http://internal.test")).status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("accepts explicit legacy durable schemas but refuses delivery data under the old contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-delivery-schema-"));
    try {
      const built = await createdDeliverySession(root);
      const stored = built.snapshots.read(built.created.sessionId);
      if (stored.status !== "ok") throw new Error(stored.message);
      const legacy = structuredClone(stored.value) as any;
      legacy.schemaVersion = "2.9.0";
      legacy.components.snapshot = "2.9.0";
      legacy.components.gameSession = "2.9.0";
      legacy.access.schemaVersion = "2.0.0";
      delete legacy.access.playerDelivery;
      legacy.snapshotHash = compiledSessionSnapshotHash(legacy);
      expect(validateCompiledSessionSnapshot(legacy)).toMatchObject({ status: "ok" });

      const invalidLegacyDelivery = structuredClone(legacy) as any;
      invalidLegacyDelivery.access.playerDelivery = { pcId: "p1", inviteDigest: "a".repeat(64), expiresAt: 1 };
      invalidLegacyDelivery.snapshotHash = compiledSessionSnapshotHash(invalidLegacyDelivery);
      expect(validateCompiledSessionSnapshot(invalidLegacyDelivery)).toMatchObject({ status: "refused" });

      // Legacy-schema parsing/hydration is a direct store fixture, not a host
      // publication path; make its standalone write capability explicit.
      const legacySnapshots = new CompiledSessionSnapshotStore({ root: join(root, "legacy-snapshots"), allowUncoordinatedTestWrites: true });
      expect(legacySnapshots.save(legacy)).toMatchObject({ status: "ok" });
      const restoredSessions = createOwnedSessionRegistry();
      const host = createCompiledDurableTestHost();
      expect(hydrateCompiledSessions({
        sessions: restoredSessions,
        catalog: built.catalog,
        snapshots: legacySnapshots,
        compiledDurableHostCapability: host.capability,
        createSession: (id, runtimeDependencies) => new GameSession(id, "cosmic-horror", undefined, undefined, undefined, undefined, { careerRoot: join(root, "legacy-careers") }, undefined, "preferred", runtimeDependencies),
      })).toEqual({ hydrated: [built.created.sessionId], unavailable: [] });
      const restored = restoredSessions.get(built.created.sessionId);
      expect(restored ? host.access(restored)?.playerDelivery : undefined).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("atomically publishes digest-only claims, survives a failed write, and resolves first-writer link races", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-delivery-atomic-"));
    try {
      const claimRoot = join(root, "delivery");
      const failingStore = new CompiledPlayerDeliveryClaimStore(claimRoot, {
        coordinatorFactory: noOpClaimTestCoordinator,
        ops: {
          ...compiledPlayerDeliveryClaimStoreNodeFileOps,
          write: () => { throw new Error("simulated interrupted claim write"); },
        },
      });
      const failedDelivery = new CompiledPlayerDelivery({ secret: DELIVERY_SECRET, claims: failingStore, publicOrigin: "https://example.test" });
      const failedInvitation = failedDelivery.issue("atomic-session");
      if (!failedInvitation) throw new Error("expected atomic invitation");
      expect(failedDelivery.claim("atomic-session", failedInvitation.binding, failedInvitation.invite, CLAIM_ID)).toBeNull();
      expect(readdirSync(claimRoot)).toEqual([]);

      let sameInvitation: ReturnType<CompiledPlayerDelivery["issue"]> = null;
      let sameWinner: CompiledPlayerDelivery;
      const sameWinnerState: { result: ReturnType<CompiledPlayerDelivery["claim"]> } = { result: null };
      let sameRaceInjected = false;
      let sameDirectorySyncs = 0;
      const sameRacer = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        publicOrigin: "https://example.test",
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot, {
          coordinatorFactory: noOpClaimTestCoordinator,
          ops: {
            ...compiledPlayerDeliveryClaimStoreNodeFileOps,
            link: (temporary, final) => {
              if (!sameRaceInjected) {
                sameRaceInjected = true;
                if (!sameInvitation) throw new Error("expected same-claim race invitation");
                sameWinnerState.result = sameWinner.claim("atomic-session", sameInvitation.binding, sameInvitation.invite, CLAIM_ID);
              }
              compiledPlayerDeliveryClaimStoreNodeFileOps.link(temporary, final);
            },
            syncDirectory: (path) => { sameDirectorySyncs += 1; compiledPlayerDeliveryClaimStoreNodeFileOps.syncDirectory(path); },
          },
        }),
      });
      sameWinner = new CompiledPlayerDelivery({ secret: DELIVERY_SECRET, claims: new CompiledPlayerDeliveryClaimStore(claimRoot, { coordinatorFactory: noOpClaimTestCoordinator }), publicOrigin: "https://example.test" });
      sameInvitation = sameRacer.issue("atomic-session");
      const invitation = sameInvitation;
      if (!invitation) throw new Error("expected atomic invitation");
      const replayed = sameRacer.claim("atomic-session", invitation.binding, invitation.invite, CLAIM_ID);
      expect(sameRaceInjected).toBe(true);
      expect(sameDirectorySyncs).toBe(1);
      expect(sameWinnerState.result?.cookieValue).toBeDefined();
      expect(replayed?.cookieValue).toBe(sameWinnerState.result?.cookieValue);

      let conflictInvitation: ReturnType<CompiledPlayerDelivery["issue"]> = null;
      let conflictWinner: CompiledPlayerDelivery;
      const conflictWinnerState: { result: ReturnType<CompiledPlayerDelivery["claim"]> } = { result: null };
      const conflictRacer = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        publicOrigin: "https://example.test",
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot, {
          coordinatorFactory: noOpClaimTestCoordinator,
          ops: {
            ...compiledPlayerDeliveryClaimStoreNodeFileOps,
            link: (temporary, final) => {
              if (!conflictWinnerState.result) {
                if (!conflictInvitation) throw new Error("expected conflicting race invitation");
                conflictWinnerState.result = conflictWinner.claim("conflict-session", conflictInvitation.binding, conflictInvitation.invite, "d".repeat(43));
              }
              compiledPlayerDeliveryClaimStoreNodeFileOps.link(temporary, final);
            },
          },
        }),
      });
      conflictWinner = new CompiledPlayerDelivery({ secret: DELIVERY_SECRET, claims: new CompiledPlayerDeliveryClaimStore(claimRoot, { coordinatorFactory: noOpClaimTestCoordinator }), publicOrigin: "https://example.test" });
      conflictInvitation = conflictRacer.issue("conflict-session");
      if (!conflictInvitation) throw new Error("expected conflicting race invitation");
      expect(conflictRacer.claim("conflict-session", conflictInvitation.binding, conflictInvitation.invite, CLAIM_ID)).toBeNull();
      expect(conflictWinnerState.result?.cookieValue).toBeDefined();

      let directorySyncs = 0;
      const syncProbe = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        publicOrigin: "https://example.test",
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot, {
          coordinatorFactory: noOpClaimTestCoordinator,
          ops: {
            ...compiledPlayerDeliveryClaimStoreNodeFileOps,
            syncDirectory: (path) => { directorySyncs += 1; compiledPlayerDeliveryClaimStoreNodeFileOps.syncDirectory(path); },
          },
        }),
      });
      const syncInvitation = syncProbe.issue("sync-session");
      if (!syncInvitation) throw new Error("expected sync probe invitation");
      expect(syncProbe.claim("sync-session", syncInvitation.binding, syncInvitation.invite, CLAIM_ID)?.cookieValue).toBeDefined();
      expect(directorySyncs).toBe(1);

      let failedDirectorySyncs = 0;
      const syncFailure = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        publicOrigin: "https://example.test",
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot, {
          coordinatorFactory: noOpClaimTestCoordinator,
          ops: {
            ...compiledPlayerDeliveryClaimStoreNodeFileOps,
            syncDirectory: () => { failedDirectorySyncs += 1; throw new Error("simulated directory sync failure"); },
          },
        }),
      });
      const syncFailureInvitation = syncFailure.issue("sync-failure-session");
      if (!syncFailureInvitation) throw new Error("expected sync failure invitation");
      // The hard-link may already be visible, but no cookie is handed out
      // until its directory metadata is durable. A retry can safely recover
      // that exact published claim with a healthy process.
      expect(syncFailure.claim("sync-failure-session", syncFailureInvitation.binding, syncFailureInvitation.invite, CLAIM_ID)).toBeNull();
      expect(failedDirectorySyncs).toBe(1);
      let recoveredDirectorySyncs = 0;
      const recoveredAfterSyncFailure = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        publicOrigin: "https://example.test",
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot, {
          coordinatorFactory: noOpClaimTestCoordinator,
          ops: {
            ...compiledPlayerDeliveryClaimStoreNodeFileOps,
            syncDirectory: (path) => {
              recoveredDirectorySyncs += 1;
              compiledPlayerDeliveryClaimStoreNodeFileOps.syncDirectory(path);
            },
          },
        }),
      });
      expect(recoveredAfterSyncFailure.claim("sync-failure-session", syncFailureInvitation.binding, syncFailureInvitation.invite, CLAIM_ID)?.cookieValue).toBeDefined();
      expect(recoveredDirectorySyncs).toBe(1);
      expect(recoveredAfterSyncFailure.claim("sync-failure-session", syncFailureInvitation.binding, syncFailureInvitation.invite, "d".repeat(43))).toBeNull();

      let replacementObserved = false;
      let replacementDirectorySyncs = 0;
      const replacementProbe = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        publicOrigin: "https://example.test",
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot, {
          coordinatorFactory: noOpClaimTestCoordinator,
          ops: {
            ...compiledPlayerDeliveryClaimStoreNodeFileOps,
            link: (temporary, final) => {
              const original = JSON.parse(readFileSync(temporary, "utf8")) as Record<string, unknown>;
              const replacement = { ...original, claimIdDigest: "f".repeat(64) };
              const displaced = `${temporary}.displaced`;
              renameSync(temporary, displaced);
              writeFileSync(temporary, `${JSON.stringify(replacement)}\n`, "utf8");
              compiledPlayerDeliveryClaimStoreNodeFileOps.link(temporary, final);
              replacementObserved = true;
            },
            syncDirectory: (path) => {
              replacementDirectorySyncs += 1;
              compiledPlayerDeliveryClaimStoreNodeFileOps.syncDirectory(path);
            },
          },
        }),
      });
      const replacementInvitation = replacementProbe.issue("path-replacement-session");
      if (!replacementInvitation) throw new Error("expected replacement probe invitation");
      // A post-close pathname substitution used to make link publish bytes
      // unrelated to the fsync'ed descriptor and still hand out a cookie.
      expect(replacementProbe.claim("path-replacement-session", replacementInvitation.binding, replacementInvitation.invite, CLAIM_ID)).toBeNull();
      expect(replacementObserved).toBe(true);
      expect(replacementDirectorySyncs).toBe(0);
      expect(JSON.parse(readFileSync(join(claimRoot, "path-replacement-session.claim.json"), "utf8"))).toMatchObject({ claimIdDigest: "f".repeat(64) });

      const claimPath = join(claimRoot, "atomic-session.claim.json");
      writeFileSync(claimPath, "x".repeat(4_097));
      expect(new CompiledPlayerDeliveryClaimStore(claimRoot).read("atomic-session")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists the verified grant expiry in v2 claims while retaining v1 first-winner compatibility", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-delivery-claim-v2-"));
    const claimRoot = join(root, "delivery");
    let now = 1_700_000_000_000;
    try {
      const issuer = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        inviteTtlSeconds: 600,
        cookieTtlSeconds: 60,
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot),
        now: () => now,
        publicOrigin: "https://example.test",
      });
      const claimant = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        // The process accepting the claim has a newer, shorter invite TTL.
        // The persisted fact must still be the immutable grant's expiry.
        inviteTtlSeconds: 60,
        cookieTtlSeconds: 120,
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot),
        now: () => now,
        publicOrigin: "https://example.test",
      });
      const sessionId = "claim-v2-session";
      const invitation = issuer.issue(sessionId);
      if (!invitation) throw new Error("expected a v2 invitation");

      const firstV2Claim = claimant.claim(sessionId, invitation.binding, invitation.invite, CLAIM_ID);
      if (!firstV2Claim) throw new Error("expected the first v2 claim");
      const persisted = JSON.parse(readFileSync(join(claimRoot, `${sessionId}.claim.json`), "utf8")) as Record<string, unknown>;
      expect(persisted).toEqual({
        schemaVersion: "2.0.0",
        sessionId,
        inviteDigest: invitation.binding.inviteDigest,
        claimIdDigest: createHash("sha256").update(`compiled-player-claim-v1|${CLAIM_ID}`, "utf8").digest("hex"),
        cookieExpiresAt: now + 120_000,
        // This catches a mutation that reconstructs this value from the
        // claimant's current config instead of the verified grant.
        inviteExpiresAt: invitation.binding.expiresAt,
      });
      expect(Math.max(persisted.cookieExpiresAt as number, persisted.inviteExpiresAt as number)).toBe(invitation.binding.expiresAt);
      now += 5_000;
      // A new cookie candidate must not extend the first winner. Its different
      // cookie expiry is intentionally irrelevant to replay equality.
      expect(claimant.claim(sessionId, invitation.binding, invitation.invite, CLAIM_ID)).toMatchObject({ maxAgeSeconds: 115 });
      expect((JSON.parse(readFileSync(join(claimRoot, `${sessionId}.claim.json`), "utf8")) as { cookieExpiresAt: number }).cookieExpiresAt).toBe(1_700_000_120_000);
      const differentGrantExpiry = { ...invitation.binding, expiresAt: invitation.binding.expiresAt + 1 };
      // A v2 record is bound to its exact immutable grant, even with matching
      // invite and claim digests.
      expect(claimant.claim(sessionId, differentGrantExpiry, invitation.invite, CLAIM_ID)).toBeNull();
      expect(claimant.authenticate(sessionId, invitation.binding, `${firstV2Claim.cookieName}=${firstV2Claim.cookieValue}`)).toBe(true);
      expect(claimant.authenticate(sessionId, differentGrantExpiry, `${firstV2Claim.cookieName}=${firstV2Claim.cookieValue}`)).toBe(false);

      const inviteFirstDelivery = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        inviteTtlSeconds: 60,
        cookieTtlSeconds: 120,
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot),
        now: () => now,
        publicOrigin: "https://example.test",
      });
      const inviteFirstSessionId = "invite-first-session";
      const inviteFirstInvitation = inviteFirstDelivery.issue(inviteFirstSessionId);
      if (!inviteFirstInvitation) throw new Error("expected an invite-first invitation");
      const inviteFirstClaim = inviteFirstDelivery.claim(inviteFirstSessionId, inviteFirstInvitation.binding, inviteFirstInvitation.invite, CLAIM_ID);
      if (!inviteFirstClaim) throw new Error("expected an invite-first claim");
      const inviteFirstPath = join(claimRoot, `${inviteFirstSessionId}.claim.json`);
      const inviteFirstBeforeExpiry = readFileSync(inviteFirstPath, "utf8");
      now = inviteFirstInvitation.binding.expiresAt;
      // Authentication remains bounded by the cookie, not a later invite
      // expiry; a claim operation itself must still refuse the expired grant.
      expect(inviteFirstDelivery.authenticate(inviteFirstSessionId, inviteFirstInvitation.binding, `${inviteFirstClaim.cookieName}=${inviteFirstClaim.cookieValue}`)).toBe(true);
      expect(inviteFirstDelivery.claim(inviteFirstSessionId, inviteFirstInvitation.binding, inviteFirstInvitation.invite, CLAIM_ID)).toBeNull();
      expect(inviteFirstDelivery.claim(inviteFirstSessionId, inviteFirstInvitation.binding, inviteFirstInvitation.invite, "e".repeat(43))).toBeNull();
      expect(readFileSync(inviteFirstPath, "utf8")).toBe(inviteFirstBeforeExpiry);

      const cookieFirstDelivery = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        inviteTtlSeconds: 120,
        cookieTtlSeconds: 60,
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot),
        now: () => now,
        publicOrigin: "https://example.test",
      });
      const cookieFirstSessionId = "cookie-first-session";
      const cookieFirstIssuedAt = now;
      const cookieFirstInvitation = cookieFirstDelivery.issue(cookieFirstSessionId);
      if (!cookieFirstInvitation) throw new Error("expected a cookie-first invitation");
      const cookieFirstClaim = cookieFirstDelivery.claim(cookieFirstSessionId, cookieFirstInvitation.binding, cookieFirstInvitation.invite, CLAIM_ID);
      if (!cookieFirstClaim) throw new Error("expected a cookie-first claim");
      const cookieFirstPath = join(claimRoot, `${cookieFirstSessionId}.claim.json`);
      const cookieFirstBeforeExpiry = readFileSync(cookieFirstPath, "utf8");
      now = cookieFirstIssuedAt + 60_000;
      expect(cookieFirstDelivery.authenticate(cookieFirstSessionId, cookieFirstInvitation.binding, `${cookieFirstClaim.cookieName}=${cookieFirstClaim.cookieValue}`)).toBe(false);
      // The still-valid invite makes replay reach the first-winner record, but
      // that replay cannot extend an expired authoritative cookie expiry.
      expect(cookieFirstDelivery.claim(cookieFirstSessionId, cookieFirstInvitation.binding, cookieFirstInvitation.invite, CLAIM_ID)).toBeNull();
      expect(cookieFirstDelivery.claim(cookieFirstSessionId, cookieFirstInvitation.binding, cookieFirstInvitation.invite, "f".repeat(43))).toBeNull();
      expect(readFileSync(cookieFirstPath, "utf8")).toBe(cookieFirstBeforeExpiry);

      const legacySessionId = "claim-v1-session";
      const legacyClaimId = "d".repeat(43);
      const legacyInvitation = issuer.issue(legacySessionId);
      if (!legacyInvitation) throw new Error("expected a v1 compatibility invitation");
      mkdirSync(claimRoot, { recursive: true });
      const legacy = {
        schemaVersion: "1.0.0",
        sessionId: legacySessionId,
        inviteDigest: legacyInvitation.binding.inviteDigest,
        claimIdDigest: createHash("sha256").update(`compiled-player-claim-v1|${legacyClaimId}`, "utf8").digest("hex"),
        cookieExpiresAt: now + 900_000,
      };
      const legacyPath = join(claimRoot, `${legacySessionId}.claim.json`);
      writeFileSync(legacyPath, `${JSON.stringify(legacy)}\n`);
      const legacyCookieName = `__Host-aitrpg-p1-${createHash("sha256").update(`compiled-player-cookie-name-v1|${legacySessionId}`, "utf8").digest("hex").slice(0, 32)}`;
      const legacySignature = createHmac("sha256", DELIVERY_SECRET)
        .update(JSON.stringify({ domain: "compiled-player-cookie-v1", sessionId: legacySessionId, inviteDigest: legacyInvitation.binding.inviteDigest, claimId: legacyClaimId }))
        .digest("base64url");
      expect(claimant.authenticate(legacySessionId, legacyInvitation.binding, `${legacyCookieName}=${legacyClaimId}.${legacySignature}`)).toBe(true);
      // A v2 candidate is an equal replay of the v1 winner, but never upgrades
      // it into a reclaim-safe record. A distinct claim remains refused.
      expect(claimant.claim(legacySessionId, legacyInvitation.binding, legacyInvitation.invite, legacyClaimId)).not.toBeNull();
      expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toEqual(legacy);
      expect(claimant.claim(legacySessionId, legacyInvitation.binding, legacyInvitation.invite, CLAIM_ID)).toBeNull();
      const storedLegacy = new CompiledPlayerDeliveryClaimStore(claimRoot).read(legacySessionId);
      expect(storedLegacy && "inviteExpiresAt" in storedLegacy).toBe(false);

      const invalidSessionId = "invalid-v2-session";
      const validV2 = {
        schemaVersion: "2.0.0",
        sessionId: invalidSessionId,
        inviteDigest: "a".repeat(64),
        claimIdDigest: "b".repeat(64),
        cookieExpiresAt: now + 1,
        inviteExpiresAt: now + 2,
      };
      for (const invalid of [
        { ...validV2, extra: true },
        { ...validV2, schemaVersion: "1.0.0" },
        { ...validV2, schemaVersion: "3.0.0" },
        {
          schemaVersion: "2.0.0",
          sessionId: invalidSessionId,
          inviteDigest: "a".repeat(64),
          claimIdDigest: "b".repeat(64),
          cookieExpiresAt: now + 1,
        },
        { ...validV2, cookieExpiresAt: 0 },
        { ...validV2, cookieExpiresAt: -1 },
        { ...validV2, cookieExpiresAt: now + 0.5 },
        { ...validV2, cookieExpiresAt: Number.MAX_SAFE_INTEGER + 1 },
        { ...validV2, inviteExpiresAt: 0 },
        { ...validV2, inviteExpiresAt: -1 },
        { ...validV2, inviteExpiresAt: now + 0.5 },
        { ...validV2, inviteExpiresAt: Number.MAX_SAFE_INTEGER + 1 },
      ]) {
        writeFileSync(join(claimRoot, `${invalidSessionId}.claim.json`), `${JSON.stringify(invalid)}\n`);
        expect(new CompiledPlayerDeliveryClaimStore(claimRoot).read(invalidSessionId)).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards fail-closed delivery configuration through Compose while retaining TTL overrides", () => {
    const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
    for (const required of [
      "COMPILER_OPERATOR_BEARER_TOKEN=${COMPILER_OPERATOR_BEARER_TOKEN}",
      "COMPILER_KEEPER_BEARER_TOKEN=${COMPILER_KEEPER_BEARER_TOKEN}",
      "COMPILER_PLAYER_DELIVERY_HMAC_SECRET=${COMPILER_PLAYER_DELIVERY_HMAC_SECRET}",
      "COMPILER_PUBLIC_ORIGIN=${COMPILER_PUBLIC_ORIGIN}",
      "COMPILER_PLAYER_DELIVERY_ROOT=/app/data/compiled-player-delivery",
      "COMPILER_PLAYER_DELIVERY_INVITE_TTL_SECONDS=${COMPILER_PLAYER_DELIVERY_INVITE_TTL_SECONDS:-900}",
      "COMPILER_PLAYER_DELIVERY_COOKIE_TTL_SECONDS=${COMPILER_PLAYER_DELIVERY_COOKIE_TTL_SECONDS:-604800}",
    ]) expect(compose).toContain(required);
  });
});
