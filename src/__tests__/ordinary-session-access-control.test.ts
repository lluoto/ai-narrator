import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerPrincipalRole, CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import {
  createEnvironmentCompilerAuthenticator,
  createEnvironmentOrdinarySessionAccessOptions,
  handleRequest,
  ordinarySessionWebSocketRefusal,
  reconcileRuntimeSessionNamespace,
  type OrdinarySessionAccessOptions,
  type SessionRuntimeDependencies,
} from "../api/server";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotNodeFileOps } from "../api/compiled-session-snapshot";
import { CareerFileStore } from "../character/career-file";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";

const ownerId = "keeper:ordinary-owner-a";
const foreignId = "keeper:ordinary-owner-b";
const OFFLINE_LLM_CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function authenticated(role: CompilerPrincipalRole, id: string): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role, id } });
}

function refusal(status: "unauthenticated" | "unavailable"): CompilerRequestAuthenticator {
  return () => ({ status });
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
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

interface OrdinaryTestRuntime {
  registry: Map<string, GameSession>;
  dependencies: SessionRuntimeDependencies;
  factoryCalls: () => number;
  openingCalls: () => number;
  createdSessionIds: () => readonly string[];
}

function createOrdinaryTestRuntime(): OrdinaryTestRuntime {
  const registry = new Map<string, GameSession>();
  const createdSessionIds: string[] = [];
  let calls = 0; let openings = 0;
  const dependencies: SessionRuntimeDependencies = {
    registry,
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, runtimeDependencies }) => {
      calls++;
      createdSessionIds.push(id);
      const session = new GameSession(id, ruleset, OFFLINE_LLM_CONFIG, archetypeId, characterName, persona, storage, access, "development_fallback", runtimeDependencies);
      session.getOpeningScene = async () => { openings++; return "opening"; };
      return session;
    },
  };
  return { registry, dependencies, factoryCalls: () => calls, openingCalls: () => openings, createdSessionIds: () => createdSessionIds };
}

type OrdinaryRequest = (
  root: string,
  path: string,
  auth: CompilerRequestAuthenticator,
  init?: RequestInit,
  access?: OrdinarySessionAccessOptions,
) => Promise<Response>;

function requestFor(runtime: OrdinaryTestRuntime): OrdinaryRequest {
  return (root, path, auth, init = {}, access: OrdinarySessionAccessOptions = { mode: "required" }) => handleRequest(
      new Request(`http://test${path}`, init),
      undefined,
      undefined,
      { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
      {},
      {},
      auth,
      undefined,
      undefined,
      undefined,
      access,
      runtime.dependencies,
    );
}

async function createOrdinary(request: OrdinaryRequest, root: string, auth = authenticated("keeper", ownerId), access?: OrdinarySessionAccessOptions): Promise<{ sessionId: string; response: unknown }> {
  const response = await request(root, "/api/sessions", auth, jsonRequest("POST", {
    ruleset: "cosmic-horror",
    archetype: "investigator",
    characterName: "Ada",
    // Caller-selected authority is data, never an ownership input.
    owner: foreignId,
    role: "player",
  }), access);
  expect(response.status).toBe(201);
  const body = await response.json() as { sessionId: string };
  return { sessionId: body.sessionId, response: body };
}

describe("ordinary session owner access", () => {
  it("uses an explicitly reconciled namespace before auth without re-running inventory or reading the body", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-reconciled-runtime-"));
    const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
    const namespace = new SessionNamespaceCoordinator(storage.sessionRoot);
    const ordinarySnapshots = new OrdinarySessionSnapshotStore({ root: join(storage.sessionRoot, "ordinary-snapshots") });
    const compiledSnapshots = new CompiledSessionSnapshotStore({ root: join(storage.sessionRoot, "compiled-snapshots") });
    try {
      reconcileRuntimeSessionNamespace(namespace, ordinarySnapshots, compiledSnapshots, storage);
      let inventoryCalls = 0;
      ordinarySnapshots.listHeaders = (() => {
        inventoryCalls++;
        throw new Error("request unexpectedly ran ordinary inventory");
      }) as typeof ordinarySnapshots.listHeaders;
      const body = unreadJsonBody({ archetype: "investigator", characterName: "Unavailable" });

      const response = await handleRequest(
        new Request("http://test/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body.body,
        }),
        undefined,
        compiledSnapshots,
        storage,
        {},
        {},
        refusal("unavailable"),
        undefined,
        undefined,
        undefined,
        { mode: "required" },
        { registry: new Map(), ordinarySnapshots, sessionNamespace: namespace },
      );

      expect(response.status).toBe(503);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("AUTH_CAPABILITY_UNAVAILABLE");
      expect(body.pulls()).toBe(0);
      expect(inventoryCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let an injected inventory seam make a namespace ready for production requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-inventory-seam-"));
    const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
    const namespace = new SessionNamespaceCoordinator(storage.sessionRoot);
    const ordinarySnapshots = new OrdinarySessionSnapshotStore({ root: join(storage.sessionRoot, "ordinary-snapshots") });
    const compiledSnapshots = new CompiledSessionSnapshotStore({ root: join(storage.sessionRoot, "compiled-snapshots") });
    const hiddenCareerId = "12345678-1234-4123-8123-123456789ac0";
    try {
      mkdirSync(join(storage.careerRoot, hiddenCareerId), { recursive: true });
      reconcileRuntimeSessionNamespace(namespace, ordinarySnapshots, compiledSnapshots, storage, {
        exists: () => false,
        readdir: () => [],
        lstat: () => ({ isDirectory: () => false, isSymbolicLink: () => false }),
      });
      expect(namespace.read(hiddenCareerId)).toBeUndefined();

      const response = await handleRequest(
        new Request("http://test/api"),
        undefined,
        compiledSnapshots,
        storage,
        {},
        {},
        refusal("unavailable"),
        undefined,
        undefined,
        undefined,
        { mode: "required" },
        { registry: new Map(), ordinarySnapshots, sessionNamespace: namespace },
      );

      expect(response.status).toBe(200);
      expect(namespace.read(hiddenCareerId)).toMatchObject({ state: "quarantined", reasonCode: "CAREER_ONLY" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an exact explicit development_anonymous environment value", () => {
    for (const environment of [
      {},
      { ORDINARY_SESSION_AUTH_MODE: "anonymous" },
      { ORDINARY_SESSION_AUTH_MODE: "DEVELOPMENT_ANONYMOUS" },
      { ORDINARY_SESSION_AUTH_MODE: " development_anonymous" },
      { ORDINARY_SESSION_AUTH_MODE: "development_anonymous " },
    ]) {
      const options = createEnvironmentOrdinarySessionAccessOptions(environment);
      expect(options.mode).toBe("required");
    }
    const environment = { ORDINARY_SESSION_AUTH_MODE: "development_anonymous", NODE_ENV: "test" };
    expect(createEnvironmentOrdinarySessionAccessOptions(environment)).toEqual({
      mode: "development_anonymous",
      environment,
    });
  });

  it("authenticates creation before body, construction, and opening work; players cannot create owners", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-create-access-"));
    const runtime = createOrdinaryTestRuntime();
    const request = requestFor(runtime);
    try {
      const playerBody = unreadJsonBody({ archetype: "investigator", characterName: "Player" });
      const player = await request(root, "/api/sessions", authenticated("player", "player:ordinary"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: playerBody.body,
      });
      expect(player.status).toBe(403);
      expect(playerBody.pulls()).toBe(0);

      const unavailableBody = unreadJsonBody({ archetype: "investigator", characterName: "Unavailable" });
      const unavailable = await request(root, "/api/sessions", refusal("unavailable"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: unavailableBody.body,
      });
      expect(unavailable.status).toBe(503);
      expect(unavailableBody.pulls()).toBe(0);

      const environmentAuth = createEnvironmentCompilerAuthenticator({
        COMPILER_OPERATOR_BEARER_TOKEN: "o".repeat(32),
        COMPILER_KEEPER_BEARER_TOKEN: "k".repeat(32),
      });
      const wrongBearerBody = unreadJsonBody({ archetype: "investigator", characterName: "Wrong bearer" });
      const wrongBearer = await request(root, "/api/sessions", environmentAuth, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${"x".repeat(32)}` },
        body: wrongBearerBody.body,
      });
      expect(wrongBearer.status).toBe(401);
      expect(wrongBearerBody.pulls()).toBe(0);
      expect(runtime.factoryCalls()).toBe(0);

      const created = await createOrdinary(request, root);
      // g0 is deliberately two-stage: an isolated staging constructor and a
      // committed-envelope rehydrate.  The opening work is staging-only.
      expect(runtime.factoryCalls()).toBe(2);
      expect(runtime.openingCalls()).toBe(1);
      expect(runtime.createdSessionIds()).toEqual([created.sessionId, created.sessionId]);
      expect(runtime.registry.has(created.sessionId)).toBe(true);
      expect(JSON.stringify(created.response)).not.toContain(ownerId);
      const careerProjection = new CareerFileStore(join(root, "careers", created.sessionId)).exportPortableProjection();
      expect(careerProjection.records).toEqual([
        expect.objectContaining({ characterName: "Ada", base: expect.objectContaining({ characterName: "Ada" }), entries: [] }),
      ]);
      const stored = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") }).read(created.sessionId);
      expect(stored).toMatchObject({ status: "ok" });
      const envelope = (stored as Extract<typeof stored, { status: "ok" }>).value;
      expect(JSON.stringify(envelope)).not.toContain(ownerId);
      expect(envelope.access).toEqual({
        schemaVersion: "1.0.0",
        ownerRole: "keeper",
        ownerPrincipalFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not publish a live ordinary session when durable metadata cannot commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-persist-access-"));
    const runtime = createOrdinaryTestRuntime();
    const request = requestFor(runtime);
    try {
      runtime.dependencies.ordinarySnapshots = new OrdinarySessionSnapshotStore({
        root: join(root, "sessions", "ordinary-snapshots"),
        fileOps: { ...compiledSessionSnapshotNodeFileOps, writeNew: () => { throw new Error("forced ordinary snapshot write failure"); } },
      });
      const response = await handleRequest(
        new Request("http://test/api/sessions", jsonRequest("POST", {
          ruleset: "cosmic-horror", archetype: "investigator", characterName: "Uncommitted",
        })),
        undefined,
        undefined,
        { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
        {},
        {},
        authenticated("keeper", ownerId),
        undefined,
        undefined,
        undefined,
        { mode: "required" },
        runtime.dependencies,
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: {
          stage: "persistence",
          code: "ORDINARY_SESSION_PERSISTENCE_UNAVAILABLE",
          message: "ordinary session persistence is unavailable",
        },
      });
      expect(runtime.factoryCalls()).toBe(1);
      expect(runtime.registry).toHaveLength(0);
      const failedSessionId = runtime.createdSessionIds()[0]!;
      expect(existsSync(join(root, "careers", failedSessionId))).toBe(false);
      const listed = await request(root, "/api/sessions", authenticated("keeper", ownerId));
      expect(listed.status).toBe(200);
      expect((await listed.json() as { sessions: unknown[] }).sessions).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries only fresh server-generated IDs before constructing an ordinary session", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-id-collision-"));
    const runtime = createOrdinaryTestRuntime();
    const request = requestFor(runtime);
    const registryId = "11111111-1111-4111-8111-111111111111";
    const metadataId = "22222222-2222-4222-8222-222222222222";
    const careerId = "33333333-3333-4333-8333-333333333333";
    const freshId = "44444444-4444-4444-8444-444444444444";
    try {
      runtime.registry.set(registryId, {} as GameSession);
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(join(root, "sessions", `${metadataId}.json`), "{}", "utf8");
      mkdirSync(join(root, "careers", careerId), { recursive: true });
      writeFileSync(join(root, "careers", careerId, "sentinel"), "keep", "utf8");
      const candidates = [registryId, metadataId, careerId, freshId];
      runtime.dependencies.generateSessionId = () => candidates.shift() ?? freshId;

      const created = await createOrdinary(request, root);
      expect(created.sessionId).toBe(freshId);
      expect(runtime.factoryCalls()).toBe(2);
      expect(runtime.openingCalls()).toBe(1);
      expect(runtime.createdSessionIds()).toEqual([freshId, freshId]);
      expect(readFileSync(join(root, "careers", careerId, "sentinel"), "utf8")).toBe("keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes ordinary GET/action owner-only, opaque to foreign identities, and leaves rejected actions unread", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-runtime-access-"));
    const runtime = createOrdinaryTestRuntime();
    const request = requestFor(runtime);
    try {
      const { sessionId } = await createOrdinary(request, root);
      const base = `/api/sessions/${sessionId}`;
      const owner = authenticated("keeper", ownerId);
      const foreign = authenticated("keeper", foreignId);
      const foreignOperator = authenticated("operator", "operator:ordinary-owner-b");
      const player = authenticated("player", "player:ordinary-owner-b");

      expect((await request(root, base, owner)).status).toBe(200);
      const anonymousExisting = await request(root, base, refusal("unauthenticated"));
      const anonymousUnknown = await request(root, "/api/sessions/ordinary-unknown-session", refusal("unauthenticated"));
      expect(anonymousExisting.status).toBe(anonymousUnknown.status);
      expect(await anonymousExisting.text()).toBe(await anonymousUnknown.text());
      const unavailableExisting = await request(root, base, refusal("unavailable"));
      const unavailableUnknown = await request(root, "/api/sessions/ordinary-unknown-session", refusal("unavailable"));
      expect(unavailableExisting.status).toBe(unavailableUnknown.status);
      expect(await unavailableExisting.text()).toBe(await unavailableUnknown.text());

      const foreignGet = await request(root, base, foreign);
      const unknownGet = await request(root, "/api/sessions/ordinary-unknown-session", foreign);
      expect(foreignGet.status).toBe(404);
      expect(unknownGet.status).toBe(404);
      expect(await foreignGet.text()).toBe(await unknownGet.text());
      for (const attacker of [foreignOperator, player]) {
        expect((await request(root, base, attacker)).status).toBe(404);
      }

      const before = await (await request(root, base, owner)).json();
      const ordinarySnapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      const durableBefore = JSON.stringify(ordinarySnapshots.read(sessionId));
      const anonymousBody = unreadJsonBody({ input: "search the archive" });
      const anonymousAction = await request(root, `${base}/action`, refusal("unauthenticated"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: anonymousBody.body,
      });
      expect(anonymousAction.status).toBe(401);
      expect(anonymousBody.pulls()).toBe(0);
      const foreignBody = unreadJsonBody({ input: "search the archive" });
      const foreignAction = await request(root, `${base}/action`, foreign, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: foreignBody.body,
      });
      expect(foreignAction.status).toBe(404);
      expect(foreignBody.pulls()).toBe(0);
      expect(await (await request(root, base, owner)).json()).toEqual(before);
      expect(JSON.stringify(ordinarySnapshots.read(sessionId))).toBe(durableBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an owner-validated stale recovery outage without making foreign locators observable", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-recovery-unavailable-"));
    const primary = createOrdinaryTestRuntime();
    const advancing = createOrdinaryTestRuntime();
    const request = requestFor(primary);
    const advance = requestFor(advancing);
    try {
      const owner = authenticated("keeper", ownerId);
      const foreign = authenticated("keeper", foreignId);
      const { sessionId } = await createOrdinary(request, root, owner);
      const base = `/api/sessions/${sessionId}`;

      // Advance the shared durable envelope from a separate runtime, leaving
      // the primary process's generation-zero object deliberately stale.
      expect((await advance(root, `${base}/action`, owner, jsonRequest("POST", {
        input: "/help", actionId: "ordinary-recovery-unavailable-advance-1", expectedGeneration: 0,
      }))).status).toBe(200);

      let recoveryConstructs = 0;
      primary.dependencies.createOrdinaryRecoverySession = () => {
        recoveryConstructs++;
        throw new Error("simulated trusted recovery factory failure");
      };

      // A foreign durable locator and an unknown locator remain identical and
      // cannot invoke the trusted replacement factory.
      const foreignResponse = await request(root, base, foreign);
      const unknownResponse = await request(root, "/api/sessions/ordinary-unknown-session", foreign);
      expect(foreignResponse.status).toBe(404);
      expect(unknownResponse.status).toBe(404);
      expect(await foreignResponse.text()).toBe(await unknownResponse.text());
      expect(recoveryConstructs).toBe(0);

      // Authentication still rejects before the stale live source can enter
      // the replacement factory.
      expect((await request(root, base, refusal("unavailable"))).status).toBe(503);
      expect(recoveryConstructs).toBe(0);

      const unavailable = await request(root, base, owner);
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("Retry-After")).toBe("1");
      expect(unavailable.headers.get("Cache-Control")).toBe("no-store");
      expect(unavailable.headers.get("Pragma")).toBe("no-cache");
      expect(await unavailable.json()).toEqual({ error: { code: "ordinary_recovery_unavailable" } });
      expect(recoveryConstructs).toBe(1);

      const actionBody = unreadJsonBody({
        input: "/help", actionId: "ordinary-recovery-unavailable-owner-action-1", expectedGeneration: 1,
      });
      const actionUnavailable = await request(root, `${base}/action`, owner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: actionBody.body,
      });
      expect(actionUnavailable.status).toBe(503);
      expect(actionUnavailable.headers.get("Retry-After")).toBe("1");
      expect(actionUnavailable.headers.get("Cache-Control")).toBe("no-store");
      expect(actionUnavailable.headers.get("Pragma")).toBe("no-cache");
      expect(await actionUnavailable.json()).toEqual({ error: { code: "ordinary_recovery_unavailable" } });
      // Authority recovery fails before the body/action/model path; this retry
      // only attempts the trusted replacement factory once more.
      expect(actionBody.pulls()).toBe(0);
      expect(recoveryConstructs).toBe(2);
    } finally {
      for (const session of primary.registry.values()) session.close();
      for (const session of advancing.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a stale replacement registry race as retryable and closes its discarded candidate once", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-recovery-registry-race-"));
    const primary = createOrdinaryTestRuntime();
    const advancing = createOrdinaryTestRuntime();
    const request = requestFor(primary);
    const advance = requestFor(advancing);
    let staleSource: GameSession | undefined;
    try {
      const owner = authenticated("keeper", ownerId);
      const { sessionId } = await createOrdinary(request, root, owner);
      const base = `/api/sessions/${sessionId}`;
      staleSource = primary.registry.get(sessionId);
      expect(staleSource).toBeInstanceOf(GameSession);
      expect((await advance(root, `${base}/action`, owner, jsonRequest("POST", {
        input: "/help", actionId: "ordinary-recovery-registry-race-advance-1", expectedGeneration: 0,
      }))).status).toBe(200);

      let discardedCandidateCloses = 0;
      let winner: GameSession | undefined;
      primary.dependencies.createOrdinaryRecoverySession = ({ id, access, storage, intentPolicy, runtimeDependencies }) => {
        const candidate = new GameSession(id, "cosmic-horror", OFFLINE_LLM_CONFIG, undefined, undefined, undefined, storage, access, intentPolicy, runtimeDependencies);
        const close = candidate.close.bind(candidate);
        candidate.close = () => { discardedCandidateCloses++; close(); };
        winner = new GameSession(id, "cosmic-horror", OFFLINE_LLM_CONFIG, undefined, undefined, undefined, storage, access, intentPolicy, runtimeDependencies);
        primary.registry.set(id, winner);
        return candidate;
      };

      const unavailable = await request(root, base, owner);
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("Retry-After")).toBe("1");
      expect(await unavailable.json()).toEqual({ error: { code: "ordinary_recovery_unavailable" } });
      expect(discardedCandidateCloses).toBe(1);
      expect(primary.registry.get(sessionId)).toBe(winner);
    } finally {
      staleSource?.close();
      for (const session of primary.registry.values()) session.close();
      for (const session of advancing.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses envelope access as the only authority; stale or tampered listing metadata cannot grant or revoke access", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-durable-access-"));
    const runtime = createOrdinaryTestRuntime();
    const request = requestFor(runtime);
    try {
      const owner = authenticated("keeper", ownerId);
      const foreign = authenticated("keeper", foreignId);
      const { sessionId } = await createOrdinary(request, root, owner);
      const ordinaryRoot = join(root, "sessions", "ordinary-snapshots");
      const ordinarySnapshots = new OrdinarySessionSnapshotStore({ root: ordinaryRoot });
      expect(ordinarySnapshots.read(sessionId)).toMatchObject({ status: "ok", value: { access: { ownerRole: "keeper" } } });
      // Metadata is a lossy projection only. A forged row neither appears as a
      // durable session nor participates in authorization.
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(join(root, "sessions", "restart-owner-row.json"), JSON.stringify({ ordinarySessionAccess: { ownerRole: "keeper", ownerPrincipalFingerprint: "0".repeat(64) } }), "utf8");
      const ownerList = await (await request(root, "/api/sessions", owner)).json() as { sessions: Array<{ id: string }> };
      const foreignList = await (await request(root, "/api/sessions", foreign)).json() as { sessions: Array<{ id: string }> };
      expect(ownerList.sessions.map((entry) => entry.id)).toEqual(expect.arrayContaining([sessionId]));
      expect(ownerList.sessions.map((entry) => entry.id)).not.toContain("restart-owner-row");
      expect(foreignList.sessions.map((entry) => entry.id)).not.toContain(sessionId);
      expect(foreignList.sessions.map((entry) => entry.id)).not.toContain("restart-owner-row");
      writeFileSync(join(root, "sessions", `${sessionId}.json`), JSON.stringify({ ordinarySessionAccess: { schemaVersion: "0.0.0", ownerPrincipalFingerprint: "0".repeat(64) } }), "utf8");
      expect((await request(root, `/api/sessions/${sessionId}`, owner)).status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("permits anonymous compatibility only by explicit non-production configuration and closes ordinary WS in required mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-session-dev-access-"));
    const runtime = createOrdinaryTestRuntime();
    const request = requestFor(runtime);
    try {
      const development: OrdinarySessionAccessOptions = {
        mode: "development_anonymous",
        environment: { NODE_ENV: "test" },
      };
      const { sessionId } = await createOrdinary(request, root, refusal("unavailable"), development);
      expect((await request(root, `/api/sessions/${sessionId}`, refusal("unauthenticated"), {}, development)).status).toBe(200);

      const productionBody = unreadJsonBody({ archetype: "investigator", characterName: "Production" });
      const prohibited = await request(root, "/api/sessions", refusal("unavailable"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: productionBody.body,
      }, { mode: "development_anonymous", environment: { NODE_ENV: "production" } });
      expect(prohibited.status).toBe(503);
      expect(productionBody.pulls()).toBe(0);

      const ordinary = new Map([[sessionId, { getCompiledGeneration: () => null }]]);
      expect(ordinarySessionWebSocketRefusal(sessionId, ordinary, { mode: "required" })?.status).toBe(403);
      expect(ordinarySessionWebSocketRefusal("ordinary-unknown-session", ordinary, { mode: "required" })?.status).toBe(403);
      expect(ordinarySessionWebSocketRefusal("ordinary-unknown-session", ordinary, {
        mode: "development_anonymous",
        environment: { NODE_ENV: "production" },
      })?.status).toBe(403);
      expect(ordinarySessionWebSocketRefusal(sessionId, ordinary, development)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats environment bearer tokens as single service-account principals, not per-person identities", () => {
    const operatorToken = "o".repeat(32);
    const keeperToken = "k".repeat(32);
    const authenticate = createEnvironmentCompilerAuthenticator({
      COMPILER_OPERATOR_BEARER_TOKEN: operatorToken,
      COMPILER_KEEPER_BEARER_TOKEN: keeperToken,
    });
    expect(authenticate(new Request("http://test", { headers: { Authorization: `Bearer ${operatorToken}` } }))).toEqual({
      status: "authenticated",
      principal: { id: "operator:environment", role: "operator" },
    });
    expect(authenticate(new Request("http://test", { headers: { Authorization: `Bearer ${keeperToken}` } }))).toEqual({
      status: "authenticated",
      principal: { id: "keeper:environment", role: "keeper" },
    });
  });
});
