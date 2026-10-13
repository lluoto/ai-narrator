import { describe, expect, test, jest } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession, acknowledgeOrdinaryDurableIdentity } from "../api/game-session";
import { cleanupExpiredSessions, handleRequest, hydrateOrdinarySessions, isDurableOrdinarySessionForCleanup, reconcileRuntimeSessionNamespace, type SessionRuntimeDependencies } from "../api/server";
import { ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT, OrdinarySessionSnapshotStore as OrdinarySessionSnapshotStoreImplementation, createOrdinarySessionEnvelope, nextOrdinarySessionArchive, ordinaryActionRequestHash, type OrdinaryPersistedActionRecord, type OrdinarySessionSnapshotStoreOptions } from "../api/ordinary-session-snapshot-store";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotNodeFileOps } from "../api/compiled-session-snapshot";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { CareerFileStore } from "../character/career-file";
import { StoryGenerator } from "../rules/story-generator";

// This durable integration file stages real archives, namespace rows, and
// filesystem snapshots. Keep a bounded per-file policy for direct Bun runs;
// individual tests do not need competing timeout declarations.
jest.setTimeout(20_000);

/** Direct durable fixtures are deliberately standalone; HTTP tests use server gates. */
class OrdinarySessionSnapshotStore extends OrdinarySessionSnapshotStoreImplementation {
  constructor(options: OrdinarySessionSnapshotStoreOptions = {}) {
    super({ ...options, allowUncoordinatedTestWrites: true });
  }
}

const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const durableHostCapability = Object.freeze(Object.create(null)) as object;
const auth: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "ordinary-http-owner" } });

function runtime(): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  return { registry, dependencies: {
    registry, ordinaryIntentPolicy: "development_fallback",
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, sessionIntentClient, runtimeDependencies }) => {
      const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, {
        ...runtimeDependencies,
        ...(sessionIntentClient ? { sessionIntentClient } : {}),
      });
      session.getOpeningScene = async () => "opening";
      return session;
    },
  } };
}

async function request(root: string, dependencies: SessionRuntimeDependencies, path: string, body?: unknown): Promise<Response> {
  return handleRequest(new Request(`http://test${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, dependencies);
}

describe("ordinary durable HTTP create/action", () => {
  test("a prototype zero-HP gate no-op cannot make a persisted HP-zero staging candidate publish a real turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-zero-hp-gate-"));
    const current = runtime();
    const id = "12345678-1234-4123-8123-123456789ac7";
    const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-http-owner" });
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    current.dependencies.ordinarySnapshots = snapshots;
    const descriptor = Object.getOwnPropertyDescriptor(GameSession.prototype, "zeroHpActionBlockMessage");
    let source: GameSession | undefined;
    try {
      source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined, { careerRoot: join(root, "careers") }, access, "development_fallback");
      expect(source.setPlayerHp("p1", 0)).toMatchObject({ ok: true });
      const seed = source.exportOrdinarySessionSnapshot();
      expect(seed.state.characters.find((entry) => entry.pcId === "p1")?.sheet).toMatchObject({ hp: 0 });
      expect(snapshots.save(createOrdinarySessionEnvelope({
        kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
        sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot: seed, idempotency: [],
      }))).toMatchObject({ status: "ok" });
      source.close(); source = undefined;

      Object.defineProperty(GameSession.prototype, "zeroHpActionBlockMessage", {
        configurable: true, writable: true, value: () => undefined,
      });
      expect((await request(root, current.dependencies, `/api/sessions/${id}`)).status).toBe(200);
      expect(current.registry.get(id)?.getState().player.hp).toBe(0);

      const actionId = "ordinary-zero-hp-gate-0001";
      const blocked = await request(root, current.dependencies, `/api/sessions/${id}/action`, {
        input: "/help", actionId, expectedGeneration: 0,
      });
      const body = await blocked.json() as {
        ordinaryGeneration: number;
        state: { round: number; player: { hp: number } };
        events: Array<{ type: string; content: string }>;
      };

      // The established ordinary HTTP contract persists a no-error blocked
      // response as g1.  The authority condition is that it remains a block,
      // not that this slice silently changes that transport contract to 4xx.
      expect(blocked.status).toBe(200);
      expect(body.ordinaryGeneration).toBe(1);
      expect(body.state).toMatchObject({ round: 0, player: { hp: 0 } });
      expect(body.events.some((event) => event.type === "action")).toBe(false);
      expect(body.events.some((event) => event.content.includes("HP归零") && event.content.includes("无法行动"))).toBe(true);
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1, snapshot: { state: { round: 0 } } } });
      expect(snapshots.findActionReceipt(id, actionId)).toMatchObject({
        status: "ok", value: { generation: 1, response: { state: { round: 0 } } },
      });
      expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
      expect(current.registry.get(id)?.getState()).toMatchObject({ round: 0, player: { hp: 0 } });
    } finally {
      if (descriptor) Object.defineProperty(GameSession.prototype, "zeroHpActionBlockMessage", descriptor);
      else Reflect.deleteProperty(GameSession.prototype, "zeroHpActionBlockMessage");
      source?.close();
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a closed retained ordinary source is recovered before its owner listing is projected", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-closed-listing-"));
    const current = runtime();
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      const source = current.registry.get(id);
      expect(source).toBeInstanceOf(GameSession);
      source!.close(); // trusted host seam: simulate a retained fail-stopped source

      const listed = await request(root, current.dependencies, "/api/sessions");
      expect(listed.status).toBe(200);
      expect((await listed.json() as { sessions: Array<{ id: string }> }).sessions.map((entry) => entry.id)).toContain(id);
      expect(current.registry.get(id)).toBeInstanceOf(GameSession);
      expect(current.registry.get(id)).not.toBe(source);
      expect(() => source!.getState()).toThrow("closed GameSession cannot read session state");
    } finally {
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleanup evicts a closed durable ordinary source without deleting its authoritative envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-closed-cleanup-"));
    const current = runtime();
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      const source = current.registry.get(id)!;
      const cleanupAt = source.lastActiveAt + 11;
      source.close(); // trusted host seam: source is already fail-stopped
      const deleted: string[] = [];
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });

      expect(cleanupExpiredSessions(current.registry, {
        now: cleanupAt,
        timeoutMs: 10,
        deleteMetadata: (sessionId) => deleted.push(sessionId),
        isDurableOrdinary: (candidate) => candidate instanceof GameSession && isDurableOrdinarySessionForCleanup(candidate),
      })).toEqual([id]);
      expect(current.registry.has(id)).toBe(false);
      expect(deleted).toEqual([]);
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { sessionId: id, generation: 0 } });
    } finally {
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a prototype setDifficulty shadow cannot corrupt a durable /diff candidate or its exact replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-difficulty-command-"));
    const current = runtime();
    const descriptor = Object.getOwnPropertyDescriptor(GameSession.prototype, "setDifficulty");
    if (!descriptor) throw new Error("fixture requires the public setDifficulty wrapper");
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      Object.defineProperty(GameSession.prototype, "setDifficulty", {
        configurable: true,
        writable: true,
        value: () => ({ ok: true, value: { changes: [] } }),
      });

      const action = { input: "/diff hard", actionId: "ordinary-difficulty-command-0001", expectedGeneration: 0 };
      const committed = await request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      const body = await committed.json() as {
        ordinaryGeneration: number;
        events: Array<{ content: string }>;
        state: { round: number };
      };
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });

      expect(committed.status).toBe(200);
      expect(body.ordinaryGeneration).toBe(1);
      expect(body.state.round).toBe(1);
      expect(body.events.some((event) => event.content.includes("难度设为 hard"))).toBe(true);
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1, snapshot: { state: { activeDifficulty: "hard", round: 1 } } } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({
        status: "ok",
        value: {
          input: "/diff hard",
          generation: 1,
          response: { ordinaryGeneration: 1, events: expect.arrayContaining([expect.objectContaining({ content: "难度设为 hard" })]) },
        },
      });
      expect(current.registry.get(id)?.exportOrdinarySessionSnapshot().state.activeDifficulty).toBe("hard");

      const duplicate = await request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      expect(duplicate.status).toBe(200);
      expect(duplicate.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
      expect(await duplicate.json()).toEqual(body);
    } finally {
      Object.defineProperty(GameSession.prototype, "setDifficulty", descriptor);
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a g0 interactive module install failure cannot publish a receipt or successor envelope and a fresh runtime remains at g0", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-module-install-fail-"));
    const first = runtime();
    const originalMove = (GameSession.prototype as any).movePlayerToScene;
    let poisoned = true;
    (GameSession.prototype as any).movePlayerToScene = function (...args: unknown[]) {
      if (poisoned) return false;
      return originalMove.apply(this, args);
    };
    try {
      const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      const actionId = "ordinary-module-install-fail-0001";
      const failed = await request(root, first.dependencies, `/api/sessions/${id}/action`, {
        input: "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3", actionId, expectedGeneration: 0,
      });
      expect([500, 503]).toContain(failed.status);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
      expect(snapshots.findActionReceipt(id, actionId)).toEqual({ status: "ok", value: null });
      expect(first.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });

      poisoned = false;
      const restarted = runtime();
      expect((await request(root, restarted.dependencies, `/api/sessions/${id}`)).status).toBe(200);
      expect(restarted.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
      for (const session of restarted.registry.values()) session.close();
    } finally {
      poisoned = false;
      (GameSession.prototype as any).movePlayerToScene = originalMove;
      for (const session of first.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("publishes ordinary g0 and g1 through the durable namespace before a fresh runtime hydrates", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-successor-")); const first = runtime();
    try {
      const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      const namespace = new SessionNamespaceCoordinator(join(root, "sessions"));
      expect(namespace.read(id)).toMatchObject({ kind: "ordinary", state: "committed", expectedIdentity: { generation: 0, format: "ordinary-session-envelope-v1" } });
      expect((await request(root, first.dependencies, `/api/sessions/${id}/action`, { input: "/help", actionId: "ordinary-namespace-action-0001", expectedGeneration: 0 })).status).toBe(200);
      // A fresh coordinator/runtime has no process-local permit or registry
      // state. It must observe the g1 CAS, then hydrate only from the committed
      // envelope rather than treating the valid successor as a conflict.
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id))
        .toMatchObject({ kind: "ordinary", state: "committed", expectedIdentity: { generation: 1, format: "ordinary-session-envelope-v1" } });
      const restarted = runtime();
      expect((await request(root, restarted.dependencies, `/api/sessions/${id}`)).status).toBe(200);
      expect(restarted.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
      for (const session of restarted.registry.values()) session.close();
    } finally { for (const session of first.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("startup inventory quarantines metadata-only IDs and the request gate constructs neither recovery nor career", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-metadata-")); const current = runtime();
    const id = "12345678-1234-4123-8123-123456789abc"; let recoveryConstructs = 0;
    current.dependencies.createOrdinaryRecoverySession = ({ id: recoveredId, access, storage, intentPolicy }) => {
      recoveryConstructs++;
      return new GameSession(recoveredId, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, access, intentPolicy);
    };
    try {
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(join(root, "sessions", `${id}.json`), "{}", "utf8");
      const response = await request(root, current.dependencies, `/api/sessions/${id}`);
      expect(response.status).toBe(404); expect(recoveryConstructs).toBe(0); expect(current.registry).toHaveLength(0);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id))
        .toMatchObject({ state: "quarantined", reasonCode: "METADATA_ONLY" });
      expect(existsSync(join(root, "careers", id))).toBe(false);
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("startup inventory quarantines a UUID-named malformed metadata locator before allocation can construct", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-malformed-metadata-")); const current = runtime();
    const id = "12345678-1234-4123-8123-123456789abf"; let factoryCalls = 0;
    const create = current.dependencies.createOrdinarySession!;
    current.dependencies.generateSessionId = () => id;
    current.dependencies.createOrdinarySession = (input) => { factoryCalls++; return create(input); };
    try {
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(join(root, "sessions", `${id}.json`), "{ definitely not JSON", "utf8");
      const response = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(response.status).toBe(503); expect(factoryCalls).toBe(0); expect(current.registry).toHaveLength(0);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id))
        .toMatchObject({ kind: "ordinary", state: "quarantined", reasonCode: "METADATA_LOCATOR_INVALID" });
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a careerRoot-only host inventories malformed UUID metadata from its sibling sessions root before factory construction", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-career-only-metadata-")); const current = runtime();
    const id = "12345678-1234-4123-8123-123456789ac2"; let factoryCalls = 0;
    const create = current.dependencies.createOrdinarySession!;
    current.dependencies.generateSessionId = () => id;
    current.dependencies.createOrdinarySession = (input) => { factoryCalls++; return create(input); };
    try {
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(join(root, "sessions", `${id}.json`), "{ malformed sibling metadata", "utf8");
      const response = await handleRequest(new Request("http://test/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archetype: "detective", characterName: "Ada" }),
      }), undefined, undefined, { careerRoot: join(root, "careers") }, {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, current.dependencies);
      expect(response.status).toBe(503); expect(factoryCalls).toBe(0); expect(current.registry).toHaveLength(0);
      expect(new SessionNamespaceCoordinator(join(root, "careers", ".runtime-session-namespace")).read(id))
        .toMatchObject({ kind: "ordinary", state: "quarantined", reasonCode: "METADATA_LOCATOR_INVALID" });
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("startup inventory quarantines a UUID-named career regular file before allocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-career-locators-")); const current = runtime();
    const regularId = "12345678-1234-4123-8123-123456789ac0";
    let factoryCalls = 0; const create = current.dependencies.createOrdinarySession!;
    current.dependencies.createOrdinarySession = (input) => { factoryCalls++; return create(input); };
    try {
      mkdirSync(join(root, "careers"), { recursive: true });
      writeFileSync(join(root, "careers", regularId), "not a career directory", "utf8");
      current.dependencies.generateSessionId = () => regularId;
      const response = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(response.status).toBe(503);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(regularId))
        .toMatchObject({ kind: "ordinary", state: "quarantined", reasonCode: "CAREER_LOCATOR_INVALID" });
      expect(factoryCalls).toBe(0); expect(current.registry).toHaveLength(0);
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("career inventory treats a UUID-named symlink as collision evidence through the lstat seam", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-career-symlink-seam-"));
    const careerRoot = join(root, "virtual-careers"); const id = "12345678-1234-4123-8123-123456789ac1";
    const ordinary = new OrdinarySessionSnapshotStore({ root: join(root, "ordinary") });
    const compiled = new CompiledSessionSnapshotStore({ root: join(root, "compiled"), allowUncoordinatedTestWrites: true });
    try {
      reconcileRuntimeSessionNamespace(
        new SessionNamespaceCoordinator(join(root, "sessions")), ordinary, compiled, { sessionRoot: join(root, "metadata"), careerRoot },
        {
          exists: (path) => path === careerRoot,
          readdir: (path) => { if (path !== careerRoot) throw new Error("unexpected readdir"); return [id]; },
          lstat: (path) => path === careerRoot
            ? { isDirectory: () => true, isSymbolicLink: () => false }
            : { isDirectory: () => false, isSymbolicLink: () => true },
        },
      );
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id))
        .toMatchObject({ kind: "ordinary", state: "quarantined", reasonCode: "CAREER_LOCATOR_INVALID" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("career inventory fails bootstrap when enumeration or lstat cannot be trusted", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-career-lstat-failure-"));
    const careerRoot = join(root, "virtual-careers");
    try {
      expect(() => reconcileRuntimeSessionNamespace(
        new SessionNamespaceCoordinator(join(root, "sessions")),
        new OrdinarySessionSnapshotStore({ root: join(root, "ordinary") }),
        new CompiledSessionSnapshotStore({ root: join(root, "compiled"), allowUncoordinatedTestWrites: true }),
        { sessionRoot: join(root, "metadata"), careerRoot },
        {
          exists: () => true,
          readdir: () => { throw new Error("simulated career enumeration failure"); },
          lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
        },
      )).toThrow("simulated career enumeration failure");
      expect(() => reconcileRuntimeSessionNamespace(
        new SessionNamespaceCoordinator(join(root, "sessions-lstat")),
        new OrdinarySessionSnapshotStore({ root: join(root, "ordinary-lstat") }),
        new CompiledSessionSnapshotStore({ root: join(root, "compiled-lstat"), allowUncoordinatedTestWrites: true }),
        { sessionRoot: join(root, "metadata-lstat"), careerRoot },
        {
          exists: () => true,
          readdir: () => [],
          lstat: () => { throw new Error("simulated career lstat failure"); },
        },
      )).toThrow("simulated career lstat failure");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("startup inventory quarantines a body-only ordinary partial before recovery construction", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-partial-")); const current = runtime();
    const id = "12345678-1234-4123-8123-123456789abc"; let recoveryConstructs = 0;
    current.dependencies.createOrdinaryRecoverySession = ({ id: recoveredId, access, storage, intentPolicy }) => {
      recoveryConstructs++;
      return new GameSession(recoveredId, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, access, intentPolicy);
    };
    try {
      const snapshotRoot = join(root, "sessions", "ordinary-snapshots"); mkdirSync(snapshotRoot, { recursive: true });
      writeFileSync(join(snapshotRoot, `${id}.${"0".repeat(64)}.ordinary-envelope.json`), "{}", "utf8");
      expect((await request(root, current.dependencies, `/api/sessions/${id}`)).status).toBe(404);
      expect(recoveryConstructs).toBe(0);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id))
        .toMatchObject({ state: "quarantined", reasonCode: "ORDINARY_PARTIAL" });
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("startup inventory quarantines a body-only compiled partial before any recovery construction", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-compiled-partial-")); const current = runtime();
    const id = "12345678-1234-4123-8123-123456789abc"; let recoveryConstructs = 0;
    current.dependencies.createOrdinaryRecoverySession = ({ id: recoveredId, access, storage, intentPolicy }) => {
      recoveryConstructs++;
      return new GameSession(recoveredId, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, access, intentPolicy);
    };
    try {
      const snapshotRoot = join(root, "sessions", "compiled-snapshots"); mkdirSync(snapshotRoot, { recursive: true });
      // The immutable body name is deliberately valid while its JSON is not:
      // startup must quarantine this collision evidence without constructing
      // either an ordinary recovery or a compiled model/session.
      writeFileSync(join(snapshotRoot, `${id}.${"0".repeat(64)}.json`), "{}", "utf8");
      expect((await request(root, current.dependencies, `/api/sessions/${id}`)).status).toBe(404);
      expect(recoveryConstructs).toBe(0); expect(current.registry).toHaveLength(0);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id))
        .toMatchObject({ state: "quarantined", reasonCode: "COMPILED_PARTIAL" });
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("startup keeps same-ID ordinary plus compiled evidence permanently quarantined across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-namespace-cross-kind-"));
    const id = "12345678-1234-4123-8123-123456789abc";
    const ordinary = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-http-owner" });
    const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined, undefined, access, "development_fallback");
    const first = runtime(); const restarted = runtime(); let recoveryConstructs = 0;
    for (const current of [first, restarted]) {
      current.dependencies.ordinarySnapshots = ordinary;
      current.dependencies.createOrdinaryRecoverySession = ({ id: recoveredId, access: recoveredAccess, storage, intentPolicy }) => {
        recoveryConstructs++;
        return new GameSession(recoveredId, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, recoveredAccess, intentPolicy);
      };
    }
    try {
      expect(ordinary.save(createOrdinarySessionEnvelope({ kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot: source.exportOrdinarySessionSnapshot(), idempotency: [] })).status).toBe("ok");
      const compiledRoot = join(root, "sessions", "compiled-snapshots"); mkdirSync(compiledRoot, { recursive: true });
      writeFileSync(join(compiledRoot, `${id}.${"0".repeat(64)}.json`), "{}", "utf8");
      for (const current of [first, restarted]) {
        expect((await request(root, current.dependencies, `/api/sessions/${id}`)).status).toBe(404);
        expect(current.registry).toHaveLength(0);
        expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id))
          .toMatchObject({ kind: "ordinary", state: "quarantined", reasonCode: "COMPILED_PARTIAL" });
      }
      expect(recoveryConstructs).toBe(0);
    } finally {
      source.close(); for (const current of [first, restarted]) for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-portable ordinary ruleset before allocation, construction, model, or storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-ruleset-gate-")); const current = runtime();
    const originalFactory = current.dependencies.createOrdinarySession!; let constructs = 0; let generated = 0;
    current.dependencies.createOrdinarySession = (input) => { constructs++; return originalFactory(input); };
    current.dependencies.generateSessionId = () => { generated++; return "12345678-1234-4123-8123-123456789abc"; };
    try {
      const response = await request(root, current.dependencies, "/api/sessions", { ruleset: "dnd5e", archetype: "detective", characterName: "Ada" });
      expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: { code: "ORDINARY_RULESET_UNSUPPORTED" } });
      expect(constructs).toBe(0); expect(generated).toBe(0); expect(current.registry).toHaveLength(0); expect(existsSync(join(root, "sessions", "ordinary-snapshots"))).toBe(false);
    } finally { for (const s of current.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects an explicit unknown cosmic-horror archetype before reservation, construction, opening, or career writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-archetype-gate-"));
    const current = runtime();
    const id = "12345678-1234-4123-8123-123456789abd";
    const originalFactory = current.dependencies.createOrdinarySession!;
    let factoryCalls = 0;
    let openingCalls = 0;
    let generated = 0;
    current.dependencies.generateSessionId = () => { generated++; return id; };
    current.dependencies.createOrdinarySession = (input) => {
      factoryCalls++;
      const session = originalFactory(input);
      session.getOpeningScene = async () => { openingCalls++; return "opening"; };
      return session;
    };
    try {
      const rejected = await request(root, current.dependencies, "/api/sessions", {
        ruleset: "cosmic-horror", archetype: "not-a-coc-occupation", characterName: "Ada",
      });
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ error: { stage: "contract", code: "ORDINARY_ARCHETYPE_UNKNOWN" } });
      expect(generated).toBe(0);
      expect(factoryCalls).toBe(0);
      expect(openingCalls).toBe(0);
      expect(current.registry).toHaveLength(0);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id)).toBeUndefined();
      expect(existsSync(join(root, "careers", id))).toBe(false);

      const bodyless = await handleRequest(new Request("http://test/api/sessions", { method: "POST" }),
        undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
        {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, current.dependencies);
      expect(bodyless.status).toBe(201);
      expect(await bodyless.json()).toMatchObject({ archetype: null, character: null });
    } finally {
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("releases an ordinary construction reservation and staging root when the trusted factory throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-construction-failure-"));
    const current = runtime();
    const id = "12345678-1234-4123-8123-123456789abe";
    let stagedCareerRoot: string | undefined;
    current.dependencies.generateSessionId = () => id;
    current.dependencies.createOrdinarySession = (input) => {
      stagedCareerRoot = input.storage.careerRoot;
      throw new Error("forced trusted factory construction failure");
    };
    try {
      const response = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "ORDINARY_SESSION_PERSISTENCE_UNAVAILABLE" } });
      expect(current.registry).toHaveLength(0);
      expect(stagedCareerRoot).toBeDefined();
      expect(existsSync(stagedCareerRoot!)).toBe(false);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id))
        .toMatchObject({ kind: "ordinary", state: "abandoned", reasonCode: "CREATE_CONSTRUCTION_FAILED" });
      expect(existsSync(join(root, "sessions", "ordinary-snapshots", `${id}.json`))).toBe(false);
    } finally {
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("foreign request-time recovery constructs nothing and does not populate the registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-foreign-recovery-"));
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-http-owner" });
    const source = new GameSession("12345678-1234-4123-8123-123456789abc", "cosmic-horror", CONFIG, "detective", "Ada", undefined, undefined, access, "development_fallback");
    const registry = new Map<string, GameSession>(); let recoveryConstructs = 0;
    try {
      expect(snapshots.save(createOrdinarySessionEnvelope({ kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: source.id, generation: 0, previousEnvelopeHash: null, access, snapshot: source.exportOrdinarySessionSnapshot(), idempotency: [] })).status).toBe("ok");
      const foreign: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "foreign-owner" } });
      const response = await handleRequest(new Request(`http://test/api/sessions/${source.id}`), undefined, undefined,
        { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, foreign, undefined, undefined, undefined, { mode: "required" }, {
          registry, ordinarySnapshots: snapshots,
          createOrdinaryRecoverySession: ({ id, access: recoveredAccess, storage, intentPolicy, runtimeDependencies }) => {
            recoveryConstructs++;
            return new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, recoveredAccess, intentPolicy, runtimeDependencies);
          },
      });
      expect(response.status).toBe(404); expect(recoveryConstructs).toBe(0); expect(registry).toHaveLength(0);
      // This envelope predates the namespace file. A single complete valid
      // legacy store is adopted once, even though this foreign principal is
      // never allowed to turn it into a recovery constructor side effect.
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(source.id))
        .toMatchObject({ kind: "ordinary", state: "committed", expectedIdentity: { generation: 0, format: "ordinary-session-envelope-v1" } });
    } finally { source.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("an unknown locator on a fresh ordinary root is opaque and constructs nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-fresh-unknown-")); const current = runtime(); let recoveryConstructs = 0;
    current.dependencies.createOrdinaryRecoverySession = ({ id, access, storage, intentPolicy, runtimeDependencies }) => {
      recoveryConstructs++;
      return new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, access, intentPolicy, runtimeDependencies);
    };
    try {
      const response = await request(root, current.dependencies, "/api/sessions/ordinary-fresh-unknown");
      expect(response.status).toBe(404); expect(recoveryConstructs).toBe(0); expect(current.registry).toHaveLength(0);
      expect(existsSync(join(root, "sessions", "ordinary-snapshots"))).toBe(false);
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("request namespace gate hides unknown, quarantined, and wrong-kind locators before a stale registry can construct", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-request-namespace-gate-")); const current = runtime();
    const ids = ["12345678-1234-4123-8123-123456789abc", "12345678-1234-4123-8123-123456789abd", "12345678-1234-4123-8123-123456789abe"] as const;
    let recoveryConstructs = 0;
    current.dependencies.createOrdinaryRecoverySession = ({ id, access, storage, intentPolicy }) => {
      recoveryConstructs++;
      return new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, access, intentPolicy);
    };
    for (const id of ids) current.registry.set(id, new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined, undefined, undefined, "development_fallback"));
    try {
      const namespace = new SessionNamespaceCoordinator(join(root, "sessions"));
      namespace.adoptCommitted({ sessionId: ids[0], kind: "compiled", observedIdentity: { hash: "a".repeat(64), generation: 0, format: "compiled-session-snapshot-v1" } });
      namespace.reconcileObserved({ sessionId: ids[1], kind: "ordinary", reasonCode: "TEST_QUARANTINE" });
      for (const id of ids) expect((await request(root, current.dependencies, `/api/sessions/${id}`)).status).toBe(404);
      expect(recoveryConstructs).toBe(0); expect(current.registry).toHaveLength(3);
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("startup hydration and TTL cleanup retain the authoritative ordinary envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-startup-"));
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "ordinary") });
    const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-startup-owner" });
    const source = new GameSession("ordinary-startup", "cosmic-horror", CONFIG, "detective", "Ada", undefined, undefined, access, "development_fallback");
    const registry = new Map<string, GameSession>();
    try {
      expect(snapshots.save(createOrdinarySessionEnvelope({ kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: source.id, generation: 0, previousEnvelopeHash: null, access, snapshot: source.exportOrdinarySessionSnapshot(), idempotency: [] })).status).toBe("ok");
      const hydrated = hydrateOrdinarySessions({ snapshots, sessions: registry, storage: { careerRoot: join(root, "careers") }, intentPolicy: "development_fallback",
        createSession: (id, recoveredAccess, runtimeDependencies) => new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(root, "careers") }, recoveredAccess, "development_fallback", runtimeDependencies) });
      expect(hydrated.hydrated).toEqual([source.id]);
      const live = registry.get(source.id)!;
      expect(cleanupExpiredSessions(registry, { now: live.lastActiveAt + 2, timeoutMs: 1, deleteMetadata: () => { throw new Error("durable ordinary must not delete metadata"); }, isDurableOrdinary: () => true })).toEqual([source.id]);
      expect(registry).toHaveLength(0); expect(snapshots.read(source.id)).toMatchObject({ status: "ok", value: { generation: 0 } });
    } finally { source.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a post-commit real-root Career projection write failure leaves the prior complete projection readable and never publishes its target", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-career-root-publication-"));
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "ordinary") });
    const id = "ordinary-career-root-publication";
    const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-startup-owner" });
    const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined,
      { careerRoot: join(root, "source-careers") }, access, "development_fallback");
    const registry = new Map<string, GameSession>();
    const realCareerDirectory = join(root, "careers", id);
    const originalAtomicWrite = (CareerFileStore.prototype as unknown as {
      atomicWrite(characterName: string, data: unknown): void;
    }).atomicWrite;
    let failBea = true;
    try {
      const added = source.addPartyMember("Bea", "detective");
      if ("rejected" in added) throw new Error(added.rejected);
      const sourceSnapshot = source.exportOrdinarySessionSnapshot();
      const sourceProjection = sourceSnapshot.career.mode === "complete"
        ? sourceSnapshot.career.projection
        : (() => { throw new Error("fixture requires a complete Career projection"); })();
      expect(sourceProjection.records.map((record) => record.characterName)).toEqual(["Ada", "Bea"]);

      const oldStore = new CareerFileStore(realCareerDirectory);
      // Generation-zero recovery may initialize an empty root, but the new
      // predecessor protocol deliberately refuses a nonempty third root.
      // Keep this atomic-stage failure fixture empty; the separate third-root
      // tests cover that fail-closed boundary.
      const oldProjection = oldStore.exportPortableProjection();

      expect(snapshots.save(createOrdinarySessionEnvelope({
        kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
        sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot: sourceSnapshot, idempotency: [],
      })).status).toBe("ok");

      (CareerFileStore.prototype as unknown as { atomicWrite(characterName: string, data: unknown): void }).atomicWrite = function (
        this: CareerFileStore,
        characterName: string,
        data: unknown,
      ): void {
        if (failBea && characterName === "Bea") throw new Error("simulated second Career leaf failure");
        return originalAtomicWrite.call(this, characterName, data);
      };

      const failed = hydrateOrdinarySessions({
        snapshots, sessions: registry, storage: { careerRoot: join(root, "careers") }, intentPolicy: "development_fallback",
        createSession: (sessionId, recoveredAccess, runtimeDependencies) => new GameSession(
          sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined,
          { careerRoot: join(root, "careers") }, recoveredAccess, "development_fallback", runtimeDependencies,
        ),
      });
      expect(failed.hydrated).toEqual([]);
      expect(failed.unavailable).toMatchObject([{ id, code: "ORDINARY_SNAPSHOT_CORRUPT" }]);
      expect(registry.has(id)).toBe(false);

      // A fresh, conforming reader must never observe a partially staged
      // Ada/Bea projection while the durable envelope waits for a retry.
      expect(new CareerFileStore(realCareerDirectory).exportPortableProjection()).toEqual(oldProjection);

      failBea = false;
      (CareerFileStore.prototype as unknown as { atomicWrite(characterName: string, data: unknown): void }).atomicWrite = originalAtomicWrite;
      const retried = hydrateOrdinarySessions({
        snapshots, sessions: registry, storage: { careerRoot: join(root, "careers") }, intentPolicy: "development_fallback",
        createSession: (sessionId, recoveredAccess, runtimeDependencies) => new GameSession(
          sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined,
          { careerRoot: join(root, "careers") }, recoveredAccess, "development_fallback", runtimeDependencies,
        ),
      });
      expect(retried.hydrated).toEqual([id]);
      expect(new CareerFileStore(realCareerDirectory).exportPortableProjection()).toEqual(sourceProjection);
    } finally {
      failBea = false;
      (CareerFileStore.prototype as unknown as { atomicWrite(characterName: string, data: unknown): void }).atomicWrite = originalAtomicWrite;
      source.close();
      for (const session of registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("startup same-ID quarantine rejects an ordinary envelope before factory or career restore", () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-startup-quarantine-"));
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "ordinary") });
    const id = "12345678-1234-4123-8123-123456789abc";
    const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-startup-owner" });
    const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined, undefined, access, "development_fallback");
    const winner = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Winner", undefined, undefined, undefined, "development_fallback");
    const registry = new Map([[id, winner]]); let factoryCalls = 0;
    try {
      expect(snapshots.save(createOrdinarySessionEnvelope({ kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot: source.exportOrdinarySessionSnapshot(), idempotency: [] })).status).toBe("ok");
      const result = hydrateOrdinarySessions({ snapshots, sessions: registry, storage: { careerRoot: join(root, "careers") }, intentPolicy: "development_fallback",
        createSession: (sessionId, recoveredAccess) => {
          factoryCalls++;
          return new GameSession(sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(root, "careers") }, recoveredAccess, "development_fallback");
        },
      });
      expect(result.hydrated).toEqual([]); expect(result.unavailable).toMatchObject([{ id, code: "ORDINARY_SNAPSHOT_CONFLICT" }]);
      expect(factoryCalls).toBe(0); expect(registry.get(id)).toBe(winner); expect(existsSync(join(root, "careers", id))).toBe(false);
    } finally { source.close(); winner.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("the predecessor snapshot capability is one-shot and unavailable after act starts", async () => {
    const session = new GameSession("ordinary-capability", "cosmic-horror", CONFIG, "detective", "Ada", undefined, undefined, undefined, "development_fallback", { ordinaryDurableHostCapability: durableHostCapability });
    try {
      await session.runExclusiveActionTransaction(async (act, snapshotBeforeAction) => {
        expect(snapshotBeforeAction().snapshotHash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(() => acknowledgeOrdinaryDurableIdentity(session, durableHostCapability, { generation: 0, envelopeHash: "sha256:bad", snapshotHash: "sha256:bad" })).toThrow("invalid ordinary durable identity");
        await act("/help");
        expect(() => snapshotBeforeAction()).toThrow("ordinary pre-commit snapshot requires the exact exclusive action boundary");
      });
    } finally { session.close(); }
  });

  test("remaining non-durable ordinary mutators reject before consuming their body", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-mutator-gate-")); const current = runtime();
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      const summaryBefore = current.registry.get(id)!.getSummary();
      for (const endpoint of ["kp", "npc-chat"]) {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('{"name":"Bea","archetype":"detective"}')); controller.close(); } }, { highWaterMark: 0 });
        const response = await handleRequest(new Request(`http://test/api/sessions/${id}/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body }), undefined, undefined,
          { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, auth, undefined, undefined, undefined, { mode: "required" }, current.dependencies);
        expect(response.status).toBe(409); expect(pulls).toBe(0); expect(current.registry.get(id)?.getSummary()).toEqual(summaryBefore);
      }
    } finally { for (const s of current.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("post-pointer-write indeterminate create reopens generation zero instead of rolling it back", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-create-indeterminate-")); const current = runtime(); let throwAfterPublish = true;
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots"), fileOps: {
      ...compiledSessionSnapshotNodeFileOps,
      writeReplace(path, value) {
        compiledSessionSnapshotNodeFileOps.writeReplace(path, value);
        // The usage marker is intentionally replaced before artifacts. Keep
        // this seam at the authoritative header so it still models the
        // post-pointer fault named by this test.
        if (throwAfterPublish && path.endsWith(".ordinary-current.json")) { throwAfterPublish = false; throw new Error("simulated post-publish sync fault"); }
      },
    } });
    current.dependencies.ordinarySnapshots = snapshots;
    try {
      const response = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(response.status).toBe(201);
      const body = await response.json() as { sessionId: string; ordinaryGeneration: number };
      expect(body.ordinaryGeneration).toBe(0); expect(snapshots.read(body.sessionId)).toMatchObject({ status: "ok", value: { generation: 0 } }); expect(current.registry.has(body.sessionId)).toBe(true);
    } finally { for (const s of current.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("abandons a prepared ordinary g0 only after the store classifies it not-published", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-g0-classified-refusal-")); const current = runtime();
    const id = "12345678-1234-4123-8123-123456789abd";
    current.dependencies.generateSessionId = () => id;
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots"), fileOps: {
      ...compiledSessionSnapshotNodeFileOps,
      writeNew() { throw new Error("simulated pre-publication ordinary storage refusal"); },
    } });
    current.dependencies.ordinarySnapshots = snapshots;
    try {
      const response = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(response.status).toBe(500);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id))
        .toMatchObject({ kind: "ordinary", state: "abandoned", reasonCode: "CREATE_PUBLICATION_NOT_PUBLISHED" });
      expect(current.registry.has(id)).toBe(false);
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("retains an indeterminate ordinary g0 prepared row until exact inventory evidence can commit it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-g0-indeterminate-reconcile-")); const current = runtime();
    const id = "12345678-1234-4123-8123-123456789abe";
    current.dependencies.generateSessionId = () => id;
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const actualSave = snapshots.save.bind(snapshots); const actualRead = snapshots.read.bind(snapshots); let hideReadback = false;
    snapshots.save = ((...args: Parameters<OrdinarySessionSnapshotStore["save"]>) => {
      const saved = actualSave(...args);
      if (saved.status === "ok") { hideReadback = true; return { status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE", message: "simulated lost store acknowledgement", sessionId: id } as const; }
      return saved;
    }) as OrdinarySessionSnapshotStore["save"];
    snapshots.read = ((sessionId: string) => hideReadback && sessionId === id
      ? { status: "refused", code: "ORDINARY_SNAPSHOT_STORAGE_FAILED", message: "simulated unavailable readback", sessionId }
      : actualRead(sessionId)) as OrdinarySessionSnapshotStore["read"];
    current.dependencies.ordinarySnapshots = snapshots;
    try {
      const uncertain = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(uncertain.status).toBe(503);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id)).toMatchObject({ kind: "ordinary", state: "prepared" });
      hideReadback = false;
      const restarted = runtime();
      expect((await request(root, restarted.dependencies, `/api/sessions/${id}`)).status).toBe(200);
      expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id)).toMatchObject({ kind: "ordinary", state: "committed", expectedIdentity: { generation: 0 } });
      for (const session of restarted.registry.values()) session.close();
    } finally { for (const session of current.registry.values()) session.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("commits generation zero before visibility, persists an action, and resumes after process restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-durable-"));
    const first = runtime();
    try {
      const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const createBody = await created.json() as { sessionId: string; sessionKind: string; ordinaryGeneration: number };
      expect(createBody.sessionKind).toBe("ordinary"); expect(createBody.ordinaryGeneration).toBe(0);
      const actionId = "ordinary-http-action-0001";
      const action = await request(root, first.dependencies, `/api/sessions/${createBody.sessionId}/action`, { input: "/help", actionId, expectedGeneration: 0 });
      expect(action.status).toBe(200);
      const actionBody = await action.json() as { ordinaryGeneration: number; state: { round: number } };
      expect(actionBody.ordinaryGeneration).toBe(1); expect(actionBody.state.round).toBe(1);
      const restarted = runtime();
      const resumed = await request(root, restarted.dependencies, `/api/sessions/${createBody.sessionId}`);
      expect(resumed.status).toBe(200);
      expect(restarted.registry.get(createBody.sessionId)?.round).toBe(1);
      const next = await request(root, restarted.dependencies, `/api/sessions/${createBody.sessionId}/action`, { input: "/status", actionId: "ordinary-http-action-0002", expectedGeneration: 1 });
      expect(next.status).toBe(200);
      expect((await next.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(2);
    } finally { for (const s of first.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("replays an exact action receipt, rejects reused IDs and stale generations without another turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-idempotency-")); const current = runtime();
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      const body = { input: "/help", actionId: "ordinary-http-action-0011", expectedGeneration: 0 };
      const first = await request(root, current.dependencies, `/api/sessions/${id}/action`, body);
      const firstBody = await first.json();
      const repeat = await request(root, current.dependencies, `/api/sessions/${id}/action`, body);
      expect(repeat.status).toBe(200); expect(await repeat.json()).toEqual(firstBody);
      expect(current.registry.get(id)?.round).toBe(1);
      expect((await request(root, current.dependencies, `/api/sessions/${id}/action`, { ...body, input: "/status" })).status).toBe(409);
      expect((await request(root, current.dependencies, `/api/sessions/${id}/action`, { input: "/status", actionId: "ordinary-http-action-0012", expectedGeneration: 0 })).status).toBe(409);
      expect(current.registry.get(id)?.round).toBe(1);
      expect((await request(root, current.dependencies, `/api/sessions/${id}/action`, { input: "/status", actionId: "ordinary-http-action-0013", expectedGeneration: 1 })).status).toBe(200);
      const oldReceipt = await request(root, current.dependencies, `/api/sessions/${id}/action`, body);
      expect(oldReceipt.status).toBe(200); expect(oldReceipt.headers.get("X-Ordinary-Current-Generation")).toBe("2"); expect(oldReceipt.headers.get("X-Ordinary-Reconcile-Required")).toBe("true");
      expect((await oldReceipt.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(1);
    } finally { for (const s of current.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a post-publish action fault evicts the source and reopens the authoritative receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-action-indeterminate-")); const current = runtime(); let failCurrent = false;
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots"), fileOps: {
      ...compiledSessionSnapshotNodeFileOps,
      writeReplace(path, value) {
        compiledSessionSnapshotNodeFileOps.writeReplace(path, value);
        if (failCurrent && path.endsWith(".ordinary-current.json")) { failCurrent = false; throw new Error("simulated post-publish action fault"); }
      },
    } });
    current.dependencies.ordinarySnapshots = snapshots;
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      const action = { input: "/help", actionId: "ordinary-http-action-indeterminate-1", expectedGeneration: 0 };
      failCurrent = true;
      const uncertain = await request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      expect(uncertain.status).toBe(503);
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
      const replay = await request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      expect(replay.status).toBe(200); expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
      expect((await replay.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(1);
    } finally { for (const s of current.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("an indeterminate publish plus candidate-close fault still fail-stops and reopens the authoritative receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-action-double-fault-")); const current = runtime(); let failCurrent = false; let failClose = false;
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots"), fileOps: {
      ...compiledSessionSnapshotNodeFileOps,
      writeReplace(path, value) {
        compiledSessionSnapshotNodeFileOps.writeReplace(path, value);
        if (failCurrent && path.endsWith(".ordinary-current.json")) { failCurrent = false; throw new Error("simulated post-publish sync fault"); }
      },
    } });
    const originalClose = GameSession.prototype.close;
    (GameSession.prototype as unknown as { close: () => void }).close = function (this: GameSession) {
      if (failClose) { failClose = false; throw new Error("simulated candidate close fault"); }
      return originalClose.call(this);
    };
    current.dependencies.ordinarySnapshots = snapshots;
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      const action = { input: "/help", actionId: "ordinary-http-double-fault-1", expectedGeneration: 0 };
      failCurrent = true; failClose = true;
      const uncertain = await request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      expect(uncertain.status).toBe(503); expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
      const replay = await request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      expect(replay.status).toBe(200); expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    } finally { (GameSession.prototype as unknown as { close: GameSession["close"] }).close = originalClose; for (const s of current.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a post-save candidate-close failure evicts generation-zero live state and recovers from the envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-post-save-close-")); const current = runtime();
    const originalClose = GameSession.prototype.close; let throwOnce = false;
    (GameSession.prototype as unknown as { close: () => void }).close = function (this: GameSession) {
      if (throwOnce) { throwOnce = false; throw new Error("simulated candidate close failure"); }
      return originalClose.call(this);
    };
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      const action = { input: "/help", actionId: "ordinary-http-post-save-close-1", expectedGeneration: 0 };
      throwOnce = true;
      const failedAck = await request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      expect(failedAck.status).toBe(503);
      expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
      const replay = await request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      expect(replay.status).toBe(200); expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    } finally { (GameSession.prototype as unknown as { close: GameSession["close"] }).close = originalClose; for (const s of current.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("an external generation advance rehydrates stale GET and action sources", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-external-stale-")); const first = runtime(); const second = runtime();
    try {
      const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      expect((await request(root, first.dependencies, `/api/sessions/${id}/action`, { input: "/help", actionId: "ordinary-http-external-1", expectedGeneration: 0 })).status).toBe(200);
      expect((await request(root, second.dependencies, `/api/sessions/${id}/action`, { input: "/status", actionId: "ordinary-http-external-2", expectedGeneration: 1 })).status).toBe(200);
      const fresh = await request(root, first.dependencies, `/api/sessions/${id}`);
      expect(fresh.status).toBe(200);
      const body = await fresh.json() as { ordinaryGeneration: number; state: { round: number } };
      expect(body.ordinaryGeneration).toBe(2); expect(body.state.round).toBe(2);
      expect(first.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 2 });
    } finally { for (const s of first.registry.values()) s.close(); for (const s of second.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a predecessor-directory retirement race recovers authority instead of returning 500", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-directory-race-")); const first = runtime(); const second = runtime();
    const firstStore = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const secondStore = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const namespace = new SessionNamespaceCoordinator(join(root, "sessions"));
    first.dependencies.ordinarySnapshots = firstStore; second.dependencies.ordinarySnapshots = secondStore;
    first.dependencies.sessionNamespace = namespace; second.dependencies.sessionNamespace = namespace;
    try {
      const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      expect((await request(root, first.dependencies, `/api/sessions/${id}/action`, { input: "/help", actionId: "ordinary-race-first-0001", expectedGeneration: 0 })).status).toBe(200);
      const predecessor = firstStore.read(id); expect(predecessor.status).toBe("ok");
      if (predecessor.status !== "ok") throw new Error("missing race predecessor");
      const external = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, undefined, predecessor.value.access, "development_fallback");
      external.restoreOrdinarySessionSnapshot(predecessor.value.snapshot);
      const acted = await external.act("/status"); const snapshot = external.exportOrdinarySessionSnapshot();
      const record: OrdinaryPersistedActionRecord = {
        actionId: "ordinary-race-external-0002", input: "/status", pcId: null, expectedGeneration: 1, generation: 2, status: 200,
        requestHash: ordinaryActionRequestHash(id, "ordinary-race-external-0002", "/status", null, 1),
        response: JSON.parse(JSON.stringify({ ...acted, summary: external.getSummary(), sessionKind: "ordinary", ordinaryGeneration: 2 })),
      };
      const archive = nextOrdinarySessionArchive(id, predecessor.value.archive, record, snapshot);
      const envelope = createOrdinarySessionEnvelope({
        kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId: id, generation: 2,
        previousEnvelopeHash: predecessor.value.envelopeHash, access: predecessor.value.access, snapshot,
        idempotency: [...predecessor.value.idempotency, record].slice(-128), archive,
        replayDirectory: secondStore.prepareOrdinaryReplayDirectory(id, predecessor.value.replayDirectory, record, archive.headHash!),
      });
      external.close();
      const prepare = firstStore.prepareOrdinaryReplayDirectory.bind(firstStore); let raced = false;
      firstStore.prepareOrdinaryReplayDirectory = (...args) => {
        if (!raced) {
          raced = true;
          const published = namespace.publishCommitted({
            kind: "ordinary",
            sessionId: id,
            previousIdentity: {
              hash: predecessor.value.envelopeHash,
              generation: predecessor.value.generation,
              format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
            },
            nextIdentity: {
              hash: envelope.envelopeHash,
              generation: envelope.generation,
              format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
            },
            publish: (permit) => {
              const saved = secondStore.save(envelope, { permit }, {
                required: true,
                consume: namespace.consumePublicationPermit.bind(namespace),
              });
              expect(saved).toMatchObject({ status: "ok" });
              return {
                status: "published" as const,
                observedIdentity: {
                  hash: envelope.envelopeHash,
                  generation: envelope.generation,
                  format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
                },
              };
            },
          });
          expect(published).toMatchObject({ state: "committed", expectedIdentity: { generation: 2 } });
        }
        return prepare(...args);
      };
      const racedRequest = await request(root, first.dependencies, `/api/sessions/${id}/action`, { input: "/status", actionId: "ordinary-race-target-0002", expectedGeneration: 1 });
      expect(racedRequest.status).toBe(409);
      expect(await racedRequest.json()).toMatchObject({ code: "ordinary_generation_conflict", ordinaryGeneration: 2 });
      expect(first.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 2 });
      expect((await request(root, first.dependencies, `/api/sessions/${id}/action`, { input: "/status", actionId: "ordinary-race-after-0003", expectedGeneration: 2 })).status).toBe(200);
    } finally { for (const s of first.registry.values()) s.close(); for (const s of second.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a generated runtime module survives an ordinary action and fresh process restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-generated-runtime-")); const first = runtime(); const restarted = runtime();
    try {
      const created = await request(root, first.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      const generated = await request(root, first.dependencies, `/api/sessions/${id}/action`, {
        input: "\u751f\u6210\u6545\u4e8b", actionId: "ordinary-http-generated-runtime-1", expectedGeneration: 0,
      });
      expect(generated.status).toBe(200);
      expect(first.dependencies.registry?.get(id)?.exportOrdinarySessionSnapshot().module.package).not.toBeNull();
      const resumed = await request(root, restarted.dependencies, `/api/sessions/${id}/action`, {
        input: "/help", actionId: "ordinary-http-generated-runtime-2", expectedGeneration: 1,
      });
      expect(resumed.status).toBe(200); expect((await resumed.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(2);
      expect(restarted.registry.get(id)?.exportOrdinarySessionSnapshot().module.package).not.toBeNull();
    } finally { for (const s of first.registry.values()) s.close(); for (const s of restarted.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a durable ordinary action keeps the trusted runtime factory for later staged actions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-runtime-dependencies-"));
    const registry = new Map<string, GameSession>();
    const sentinelTitle = "SENTINEL HOST STORY";
    let factoryCalls = 0;
    let generatorCalls = 0;
    const storyGenerator = {
      generate: () => {
        generatorCalls++;
        return { ...new StoryGenerator().generate({ subgenre: "lovecraft", length: "short", theme: "abandoned_house" }), title: sentinelTitle };
      },
    };
    const createPristine: NonNullable<SessionRuntimeDependencies["createOrdinarySession"]> = ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
      factoryCalls++;
      const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, { ...runtimeDependencies, storyGenerator });
      session.getOpeningScene = async () => "opening";
      return session;
    };
    const dependencies: SessionRuntimeDependencies = {
      registry,
      ordinaryIntentPolicy: "development_fallback",
      createOrdinarySession: createPristine,
      createOrdinaryRecoverySession: ({ id, access, storage, intentPolicy, runtimeDependencies }) => createPristine({
        id, ruleset: "cosmic-horror", archetypeId: undefined, characterName: undefined, persona: {}, storage, access, intentPolicy, runtimeDependencies,
      }),
    };
    try {
      const created = await request(root, dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;

      const unrelated = await request(root, dependencies, `/api/sessions/${id}/action`, {
        input: "/help", actionId: "ordinary-runtime-dependencies-0001", expectedGeneration: 0,
      });
      expect(unrelated.status).toBe(200);
      // The unrelated durable action stages and then rehydrates a pristine
      // replacement. Do not inspect its private runtime seam; the next staged
      // action below proves that this replacement still came from the trusted
      // factory by exercising the injected generator's observable output.
      const factoryCallsAfterUnrelatedAction = factoryCalls;

      const generated = await request(root, dependencies, `/api/sessions/${id}/action`, {
        input: "\u751f\u6210\u6545\u4e8b", actionId: "ordinary-runtime-dependencies-0002", expectedGeneration: 1,
      });
      expect(generated.status).toBe(200);
      const body = await generated.json() as Record<string, unknown>;
      expect(JSON.stringify(body)).toContain(sentinelTitle);
      expect(generatorCalls).toBe(1);
      expect(registry.get(id)?.exportOrdinarySessionSnapshot().module.package).toMatchObject({ module: { title: sentinelTitle } });
      expect(factoryCalls).toBeGreaterThan(factoryCallsAfterUnrelatedAction);

      const beforeRejectedBody = factoryCalls;
      const rejected = await request(root, dependencies, `/api/sessions/${id}/action`, {
        input: "/help", actionId: "ordinary-runtime-dependencies-0003", expectedGeneration: 2, factory: "request-selected",
      });
      expect(rejected.status).toBe(400);
      expect(factoryCalls).toBe(beforeRejectedBody);
    } finally {
      for (const session of registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a throwing or non-pristine trusted ordinary factory fails before publishing a successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-invalid-runtime-factory-"));
    const current = runtime();
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      const source = current.registry.get(id);
      if (!source) throw new Error("ordinary source was not installed");
      const sourceAccess = source.getOrdinarySessionAccessBinding();
      if (!sourceAccess) throw new Error("ordinary source access was not installed");

      current.dependencies.createOrdinaryRecoverySession = () => {
        throw new Error("host recovery construction failed");
      };
      const throwing = await request(root, current.dependencies, `/api/sessions/${id}/action`, {
        input: "/help", actionId: "ordinary-invalid-runtime-factory-0001", expectedGeneration: 0,
      });
      expect(throwing.status).toBe(500);

      current.dependencies.createOrdinaryRecoverySession = ({ storage, intentPolicy }) => new GameSession(
        `${id}-wrong-target`, "cosmic-horror", CONFIG, undefined, undefined, undefined, storage, sourceAccess, intentPolicy,
      );
      const invalid = await request(root, current.dependencies, `/api/sessions/${id}/action`, {
        input: "/help", actionId: "ordinary-invalid-runtime-factory-0002", expectedGeneration: 0,
      });
      expect(invalid.status).toBe(500);

      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
      expect(snapshots.findActionReceipt(id, "ordinary-invalid-runtime-factory-0001")).toEqual({ status: "ok", value: null });
      expect(snapshots.findActionReceipt(id, "ordinary-invalid-runtime-factory-0002")).toEqual({ status: "ok", value: null });
      expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
    } finally {
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a factory that drops or substitutes durable host authority cannot publish ordinary generation zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-host-capability-create-"));
    const current = runtime();
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    current.dependencies.ordinarySnapshots = snapshots;
    const wrongCapability = Object.freeze(Object.create(null)) as object;
    try {
      for (const [id, suppliedCapability] of [
        ["12345678-1234-4123-8123-123456789bc1", undefined],
        ["12345678-1234-4123-8123-123456789bc2", wrongCapability],
      ] as const) {
        current.dependencies.generateSessionId = () => id;
        current.dependencies.createOrdinarySession = ({
          id: targetId, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy,
        }) => {
          const target = new GameSession(
            targetId, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy,
            suppliedCapability === undefined ? undefined : { ordinaryDurableHostCapability: suppliedCapability },
          );
          target.getOpeningScene = async () => "opening";
          return target;
        };

        const response = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
        expect(response.status).toBe(503);
        expect(current.registry.has(id)).toBe(false);
        expect(snapshots.read(id).status).not.toBe("ok");
        expect(new SessionNamespaceCoordinator(join(root, "sessions")).read(id)).not.toMatchObject({ state: "committed" });
        expect(existsSync(join(root, "careers", id))).toBe(false);
      }
    } finally {
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dropped-capability text-action candidate cannot derive or publish a successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-host-capability-action-"));
    const current = runtime();
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      const source = current.registry.get(id);
      if (!source) throw new Error("ordinary capability fixture source was not installed");
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      const before = snapshots.read(id);
      if (before.status !== "ok") throw new Error(before.message);
      const namespace = new SessionNamespaceCoordinator(join(root, "sessions"));
      const namespaceBefore = namespace.read(id);
      const sourceBefore = source.exportOrdinarySessionSnapshot();
      const historyBefore = source.getHistory();

      current.dependencies.createOrdinarySession = ({
        id: targetId, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy,
      }) => {
        const target = new GameSession(targetId, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy);
        target.getOpeningScene = async () => "opening";
        return target;
      };
      const response = await request(root, current.dependencies, `/api/sessions/${id}/action`, {
        input: "/help", actionId: "ordinary-host-capability-drop-action-0001", expectedGeneration: 0,
      });
      const after = snapshots.read(id);

      // This must be checked before the response: without the early factory
      // assertion, candidate.act() reaches CAS and leaves a real g1 orphan
      // even though final hydration responds unavailable.
      expect(after).toMatchObject({
        status: "ok",
        value: {
          generation: before.value.generation,
          envelopeHash: before.value.envelopeHash,
          snapshot: { snapshotHash: before.value.snapshot.snapshotHash },
        },
      });
      expect(snapshots.findActionReceipt(id, "ordinary-host-capability-drop-action-0001")).toEqual({ status: "ok", value: null });
      expect(namespace.read(id)).toEqual(namespaceBefore);
      expect(current.registry.get(id)).toBe(source);
      expect(source.exportOrdinarySessionSnapshot()).toEqual(sourceBefore);
      expect(source.getHistory()).toEqual(historyBefore);
      expect(response.status).toBe(500);
    } finally {
      for (const session of current.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a deferred action leaves GET stable and queues an exact duplicate without a stale-source 404", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-fifo-")); const current = runtime();
    let block = true; let startedResolve!: () => void; const started = new Promise<void>((resolve) => { startedResolve = resolve; }); let release!: () => void; const released = new Promise<void>((resolve) => { release = resolve; });
    current.dependencies.ordinarySessionIntentClient = {
      async chat() {
        if (block) { block = false; startedResolve(); await released; }
        return JSON.stringify({ action: "help" });
      },
    };
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      const action = { input: "inspect the deferred boundary", actionId: "ordinary-http-fifo-1", expectedGeneration: 0 };
      const first = request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      await started;
      const state = await request(root, current.dependencies, `/api/sessions/${id}`);
      expect(state.status).toBe(200); expect((await state.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(0);
      const second = request(root, current.dependencies, `/api/sessions/${id}/action`, action);
      release();
      expect((await first).status).toBe(200);
      const duplicate = await second;
      expect(duplicate.status).toBe(200); expect(duplicate.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
    } finally { release?.(); for (const s of current.registry.values()) s.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("TTL cleanup keeps an expired ordinary source registered while its staged durable action is in flight", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-http-ttl-inflight-")); const current = runtime();
    const originalClose = GameSession.prototype.close;
    let block = true; let startedResolve!: () => void; const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let released = false; let releaseAction!: () => void; const release = new Promise<void>((resolve) => { releaseAction = () => { if (!released) { released = true; resolve(); } }; });
    let source: GameSession | undefined; let sourceCloseCalls = 0; let pending: Promise<Response> | undefined;
    current.dependencies.ordinarySessionIntentClient = {
      async chat() {
        if (block) { block = false; startedResolve(); await release; }
        return JSON.stringify({ action: "help" });
      },
    };
    (GameSession.prototype as unknown as { close: GameSession["close"] }).close = function (this: GameSession) {
      if (this === source) sourceCloseCalls++;
      return originalClose.call(this);
    };
    try {
      const created = await request(root, current.dependencies, "/api/sessions", { archetype: "detective", characterName: "Ada" });
      const id = (await created.json() as { sessionId: string }).sessionId;
      source = current.registry.get(id); expect(source).toBeDefined();
      const action = { input: "inspect the ttl boundary", actionId: "ordinary-http-ttl-inflight-1", expectedGeneration: 0 };
      const requestInFlight = request(root, current.dependencies, `/api/sessions/${id}/action`, action); pending = requestInFlight;
      await started;
      const cleanupNow = source!.lastActiveAt + 10;
      expect(cleanupExpiredSessions(current.registry, {
        now: cleanupNow, timeoutMs: 1,
        deleteMetadata: () => { throw new Error("durable ordinary must not delete metadata"); },
        isDurableOrdinary: () => true,
      })).toEqual([]);
      expect(current.registry.get(id)).toBe(source); expect(sourceCloseCalls).toBe(0);
      releaseAction();
      const committed = await requestInFlight;
      expect(committed.status).toBe(200); expect(committed.headers.get("X-Ordinary-Action-Disposition")).toBe("committed");
      expect((await committed.json() as { ordinaryGeneration: number }).ordinaryGeneration).toBe(1);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(current.registry.get(id)).not.toBe(source);
      expect(current.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
    } finally {
      releaseAction?.();
      await pending?.catch(() => undefined);
      (GameSession.prototype as unknown as { close: GameSession["close"] }).close = originalClose;
      for (const s of current.registry.values()) s.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
