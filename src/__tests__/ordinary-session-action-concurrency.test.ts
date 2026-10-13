import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ServerWebSocket } from "bun";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession, OrdinaryDurableMutationError } from "../api/game-session";
import { captureSanityCohort, isSanityCohortCurrent } from "../api/sanity-cohort-fence";
import {
  createOrdinarySessionEnvelope,
  nextOrdinarySessionArchive,
  ordinaryActionRequestHash,
  ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
  OrdinarySessionSnapshotStore,
  type OrdinaryPersistedActionRecord,
} from "../api/ordinary-session-snapshot-store";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import type { OrdinaryActionAdmissionCoordinator } from "../api/ordinary-action-admission";
import { createWsClient, removeWsClient, type WsConnectionData } from "../api/ws-handler";
import { LLMClient } from "../llm/client";
import { SanityEngine } from "../rules/coc-engine";
import { WorldStateManager } from "../state/world-state-manager";

const OWNER = "keeper:ordinary-action-concurrency";
const CONFIG = {
  apiKey: "sk-ordinary-action-concurrency-key",
  baseUrl: "http://ordinary-action-concurrency.invalid/v1",
  model: "ordinary-action-concurrency-model",
  maxTokens: 32,
  temperature: 0,
};

let savedFetch: typeof fetch;
const liveSockets: Array<ServerWebSocket<WsConnectionData>> = [];
const ENV_KEYS = ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

function completion(action: "help" | "status"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action }) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function movementCompletion(target: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "move", target }) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function clonedSanityEngine(source: SanityEngine): SanityEngine {
  const replacement = new SanityEngine(source.state.maxSAN);
  replacement.restoreState(structuredClone(source.state));
  return replacement;
}

function makeSanityCohortFixture() {
  const p1 = new SanityEngine(50);
  const p2 = new SanityEngine(60);
  // Insertion order deliberately differs from the stable pcId capture order.
  const sanityEngines = new Map<string, SanityEngine>([["p2", p2], ["p1", p1]]);
  const party = new Map<string, { pcId: string; san: SanityEngine }>([
    ["p1", { pcId: "p1", san: p1 }],
    ["p2", { pcId: "p2", san: p2 }],
  ]);
  return { sanityEngines, party, p1, p2 };
}

function sanityCohortCurrent(
  captured: ReturnType<typeof captureSanityCohort>,
  fixture: ReturnType<typeof makeSanityCohortFixture>,
  activeSanity = fixture.p1,
  activePlayerId = "p1",
): boolean {
  return isSanityCohortCurrent(captured, {
    sanityEngines: fixture.sanityEngines,
    party: fixture.party,
    activeSanity,
    activePlayerId,
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("deferred fake did not reach the expected phase");
}

function keeper(): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role: "keeper", id: OWNER } });
}

function jsonRequest(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function testRuntime(initialize?: (session: GameSession) => void): { registry: Map<string, GameSession>; dependencies: SessionRuntimeDependencies } {
  const registry = new Map<string, GameSession>();
  return {
    registry,
    dependencies: {
      registry,
      ordinaryIntentPolicy: "required",
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
        const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
        // Server recovery always omits the creation archetype. Test setup is
        // source state, not a mutation to replay into every pristine restore.
        if (archetypeId !== undefined) initialize?.(session);
        session.getOpeningScene = async () => "offline opening";
        return session;
      },
    },
  };
}

async function request(root: string, runtime: ReturnType<typeof testRuntime>, path: string, init: RequestInit): Promise<Response> {
  return handleRequest(
    new Request(`http://test${path}`, init),
    undefined, undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {}, {}, keeper(), undefined, undefined, undefined, { mode: "required" }, runtime.dependencies,
  );
}

async function createOrdinary(root: string, runtime: ReturnType<typeof testRuntime>): Promise<{ id: string; session: GameSession }> {
  const response = await request(root, runtime, "/api/sessions", jsonRequest({
    ruleset: "cosmic-horror", archetype: "investigator", characterName: "Ada",
  }));
  expect(response.status).toBe(201);
  const id = (await response.json() as { sessionId: string }).sessionId;
  return { id, session: runtime.registry.get(id)! };
}

async function preparePersistedRooms(
  root: string,
  runtime: ReturnType<typeof testRuntime>,
  id: string,
): Promise<GameSession> {
  globalThis.fetch = (async () => completion("help")) as unknown as typeof fetch;
  const module = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({
    input: "加载模组 普瑞米尔的谷仓",
    actionId: "ordinary-source-world-setup-module",
    expectedGeneration: 0,
  }));
  expect(module.status).toBe(200);

  let generation = 1;
  for (const room of ["维森酒吧", "加比的拖车房"]) {
    globalThis.fetch = (async () => movementCompletion(room)) as unknown as typeof fetch;
    const response = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({
      input: `前往 ${room}`,
      actionId: `ordinary-source-world-setup-${generation}`,
      expectedGeneration: generation,
    }));
    expect(response.status).toBe(200);
    generation += 1;
  }
  return runtime.registry.get(id)!;
}

function fakeSocket() {
  const sent: Array<{ event: string; data: { events: Array<{ content: string }>; state: { round: number } } }> = [];
  const ws = { send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as ServerWebSocket<WsConnectionData>;
  return { ws, sent };
}

beforeEach(() => {
  savedFetch = globalThis.fetch;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  LLMClient.resetDefeat();
  while (liveSockets.length) removeWsClient(liveSockets.pop()!);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("ordinary action serialization", () => {
  test("serializes direct model actions so each response is built from its own turn", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? first.promise : second.promise)) as unknown as typeof fetch;
    const session = new GameSession("direct-action-queue", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, undefined, undefined, "required");

    const help = session.act("first concurrent action");
    await eventually(() => calls === 1);
    const status = session.act("second concurrent action");
    await Promise.resolve();
    expect(calls).toBe(1);

    first.resolve(completion("help"));
    await eventually(() => calls === 2);
    second.resolve(completion("status"));
    const [helpResult, statusResult] = await Promise.all([help, status]);

    expect(helpResult.narrative).toContain("操作指南");
    expect(statusResult.narrative).toContain("━━━");
    expect(helpResult.state.round).toBe(1);
    expect(statusResult.state.round).toBe(2);
    expect(session.round).toBe(2);
    expect(session.getPlayerHistory("p1").messages.filter((message) => message.type === "action")).toHaveLength(2);
  });

  test("serializes the complete HTTP action transaction, including history diff, metadata, and broadcast", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-queue-"));
    const runtime = testRuntime();
    const first = deferred<Response>();
    const second = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? first.promise : second.promise)) as unknown as typeof fetch;
    try {
      const { id } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);

      const help = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "first concurrent action", actionId: "ordinary-concurrency-action-1", expectedGeneration: 0 }));
      await eventually(() => calls === 1);
      first.resolve(completion("help"));
      const helpResponse = await help;
      const status = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({ input: "second concurrent action", actionId: "ordinary-concurrency-action-2", expectedGeneration: 1 }));
      await eventually(() => calls === 2);
      second.resolve(completion("status"));
      const statusResponse = await status;
      const [helpBody, statusBody] = await Promise.all([helpResponse.json(), statusResponse.json()]) as Array<{ narrative: string; state: { round: number } }>;

      expect(helpResponse.status).toBe(200);
      expect(statusResponse.status).toBe(200);
      expect(helpBody.narrative).toContain("操作指南");
      expect(statusBody.narrative).toContain("━━━");
      expect(helpBody.state.round).toBe(1);
      expect(statusBody.state.round).toBe(2);
      expect(runtime.registry.get(id)?.round).toBe(2);
      expect(runtime.registry.get(id)?.getPlayerHistory("p1").messages.filter((message) => message.type === "action")).toHaveLength(2);
      expect(socket.sent).toHaveLength(2);
      expect(socket.sent.map((message) => message.data.state.round)).toEqual([1, 2]);
      expect(socket.sent[0]!.data.events.some((event) => event.content === "first concurrent action")).toBe(true);
      expect(socket.sent[1]!.data.events.some((event) => event.content === "first concurrent action")).toBe(false);
      expect(socket.sent[1]!.data.events.some((event) => event.content === "second concurrent action")).toBe(true);
      expect(runtime.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaying an ordinary receipt never broadcasts a second action-result", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-replay-broadcast-"));
    const runtime = testRuntime();
    globalThis.fetch = (async () => completion("help")) as unknown as typeof fetch;
    try {
      const { id } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const action = { input: "first concurrent action", actionId: "ordinary-replay-broadcast-1", expectedGeneration: 0 };
      const committed = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      expect(committed.status).toBe(200); expect(socket.sent).toHaveLength(1);
      const replay = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      expect(replay.status).toBe(200); expect(replay.headers.get("X-Ordinary-Action-Disposition")).toBe("duplicate");
      expect(socket.sent).toHaveLength(1);
    } finally {
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retires a closed durable source instead of publishing its staged successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-closed-source-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const action = { input: "close source while staged", actionId: "ordinary-closed-source-1", expectedGeneration: 0 };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);
      expect(runtime.registry.get(id)).toBe(source);

      // This is an external retirement, not a registry replacement: the old
      // object intentionally remains the map value until the transaction
      // itself removes and restores it from the durable g0 authority.
      source.close();
      expect(runtime.registry.get(id)).toBe(source);
      pending.resolve(completion("help"));

      const failed = await inFlight;
      expect(failed.status).toBe(503);
      expect(failed.headers.get("Retry-After")).toBe("1");
      expect(await failed.json()).toMatchObject({ code: "ordinary_unavailable" });

      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toEqual({ status: "ok", value: null });
      expect(socket.sent).toHaveLength(0);
      expect(runtime.registry.get(id)).toBeDefined();
      expect(runtime.registry.get(id)).not.toBe(source);

      globalThis.fetch = (async () => completion("help")) as unknown as typeof fetch;
      const retried = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      expect(retried.status).toBe(200);
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
    } finally {
      // Never strand the request if an assertion fails before its release.
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a direct live business write while the staged successor remains valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-state-drift-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const action = { input: "wait while KP changes HP", actionId: "ordinary-source-state-drift-1", expectedGeneration: 0 };
      const authoritativeHp = source.getState().player.hp;
      const mutatedHp = authoritativeHp === 1 ? 2 : 1;
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      // The live predecessor is durable authority, so a public KP entrypoint
      // cannot create the drift that the source fence used to observe.
      expect(() => source.setPlayerHp("p1", mutatedHp)).toThrow(OrdinaryDurableMutationError);
      expect(source.getState().player.hp).toBe(authoritativeHp);
      pending.resolve(completion("help"));

      const committed = await inFlight;
      expect(committed.status).toBe(200);

      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
      expect(runtime.registry.get(id)).not.toBe(source);
      expect(runtime.registry.get(id)?.getState().player.hp).toBe(authoritativeHp);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a direct HP ABA attempt while the staged successor remains valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-state-aba-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const action = { input: "wait while KP makes and restores HP", actionId: "ordinary-source-state-aba-1", expectedGeneration: 0 };
      const originalHp = source.getState().player.hp;
      const alternateHp = originalHp === 1 ? 2 : 1;
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      // Both public attempts fail before either side of an ABA interval.
      expect(() => source.setPlayerHp("p1", alternateHp)).toThrow(OrdinaryDurableMutationError);
      expect(() => source.setPlayerHp("p1", originalHp)).toThrow(OrdinaryDurableMutationError);
      expect(source.getState().player.hp).toBe(originalHp);

      pending.resolve(completion("help"));
      const committed = await inFlight;
      expect(committed.status).toBe(200);

      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
      expect(runtime.registry.get(id)).not.toBe(source);
      expect(runtime.registry.get(id)?.getState().player.hp).toBe(originalHp);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not expose live NPC agents or their runtime restoration", async () => {
    const source = new GameSession(`registry-runtime-unreachable-${crypto.randomUUID()}`, "cosmic-horror", CONFIG);
    try {
      const facade = source.registry as unknown as Record<string, unknown>;
      for (const forbidden of ["get", "restoreSnapshot", "register", "unregister", "setDB"]) {
        expect(forbidden in facade).toBe(false);
      }
    } finally {
      source.close();
    }
  });

  test("keeps AgentRegistry database rebinding unreachable through the GameSession reader", async () => {
    const source = new GameSession(`registry-db-unreachable-${crypto.randomUUID()}`, "cosmic-horror", CONFIG);
    try {
      const facade = source.registry as unknown as Record<string, unknown>;
      expect("setDB" in facade).toBe(false);
      expect("semanticRevision" in facade).toBe(false);
      expect("stateReplacementRevision" in facade).toBe(false);
    } finally {
      source.close();
    }
  });

  test("keeps an own registry shadow out of the canonical snapshot path", async () => {
    const source = new GameSession(`registry-shadow-observation-${crypto.randomUUID()}`, "cosmic-horror", CONFIG);
    const facade = source.registry;
    const shadow = Object.freeze({
      get count(): never { throw new Error("shadow must not become authority"); },
      has(): never { throw new Error("shadow must not become authority"); },
      getAllNames(): never { throw new Error("shadow must not become authority"); },
    });
    try {
      Object.defineProperty(source, "registry", { value: shadow, configurable: true });
      expect(source.registry).toBe(shadow);
      expect(facade.count).toBe(0);
      expect(source.exportOrdinarySessionSnapshot().agentRegistry.agents).toEqual([]);
    } finally {
      source.close();
    }
  });

  test("does not expose canonical NPCStore mutation through the registry reader", async () => {
    const source = new GameSession(`registry-store-unreachable-${crypto.randomUUID()}`, "cosmic-horror", CONFIG);
    try {
      const publicRegistry = source.registry as unknown as Record<string, unknown>;
      const publicStore = source.npcStore as unknown as Record<string, unknown>;
      expect("db" in publicRegistry).toBe(false);
      for (const forbidden of ["raw", "restoreSnapshot", "savePersonality", "updateState"]) {
        expect(forbidden in publicStore).toBe(false);
      }
    } finally {
      source.close();
    }
  });

  test("does not expose NPCStore SQLite transaction authority", async () => {
    const source = new GameSession(`registry-store-transaction-unreachable-${crypto.randomUUID()}`, "cosmic-horror", CONFIG);
    try {
      const publicStore = source.npcStore as unknown as Record<string, unknown>;
      expect("raw" in publicStore).toBe(false);
      expect("close" in publicStore).toBe(false);
    } finally {
      source.close();
    }
  });

  test("a legacy public politico-economy raw path cannot form an undetected exact source ABA", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-politico-economy-public-aba-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const legacy = source.politicoEconomy as unknown as {
        exportSnapshot?: () => unknown;
        restoreSnapshot?: (snapshot: unknown) => void;
        advanceRound?: (causationId: string) => unknown;
      };
      const retainsRawAuthority = typeof legacy.exportSnapshot === "function"
        && typeof legacy.restoreSnapshot === "function"
        && typeof legacy.advanceRound === "function";
      const action = {
        input: "wait while the legacy public economy engine changes and restores",
        actionId: "ordinary-source-politico-economy-public-aba-1",
        expectedGeneration: 0,
      };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      if (retainsRawAuthority) {
        // This was the former public engine escape: the portable economy state
        // comes back byte-for-byte, so the ordinary snapshot hash alone sees no
        // interval. The repaired public reader has none of these operations.
        const before = legacy.exportSnapshot!();
        legacy.advanceRound!("legacy-public-politico-economy-aba");
        legacy.restoreSnapshot!(before);
        expect(legacy.exportSnapshot!()).toEqual(before);
      }
      pending.resolve(completion("help"));
      const response = await inFlight;

      if (retainsRawAuthority) {
        // Old behavior dynamically reproduced the source-fence blind spot: it
        // published 200 after a public mutate/restore interval rather than
        // rejecting the candidate.
        expect(response.status).toBe(503);
        const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
        expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
        expect(snapshots.findActionReceipt(id, action.actionId)).toEqual({ status: "ok", value: null });
        expect(socket.sent).toHaveLength(0);
        expect(runtime.registry.get(id)).not.toBe(source);
      } else {
        // The repaired surface cannot mutate the canonical engine, so the
        // ordinary action itself remains a normal successful request.
        expect(response.status).toBe(200);
        const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
        expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
        expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
        expect(socket.sent).toHaveLength(1);
      }
      expect(retainsRawAuthority).toBe(false);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a direct scene ABA attempt while the staged successor remains valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-world-aba-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id } = await createOrdinary(root, runtime);
      const source = await preparePersistedRooms(root, runtime, id);
      globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      expect(source.world.getCurrentState().scene).toBe("加比的拖车房");
      const action = { input: "wait while the controlled session scene changes and restores", actionId: "ordinary-source-world-aba-1", expectedGeneration: 3 };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      // No public writer exists to start an ABA interval outside the action transaction.
      expect(Reflect.get(source, "setScene")).toBeUndefined();
      expect(source.world.getCurrentState().scene).toBe("加比的拖车房");

      pending.resolve(completion("help"));
      const committed = await inFlight;

      expect(calls).toBe(1);
      expect(committed.status).toBe(200);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 4 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 4 } });
      expect(socket.sent).toHaveLength(1);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the ordinary canonical world reader while rejecting a direct scene write", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-world-reference-mask-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    const rejectedShadow = new WorldStateManager(":memory:");
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id } = await createOrdinary(root, runtime);
      const source = await preparePersistedRooms(root, runtime, id);
      globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
      const canonical = source.world;
      // The own non-configurable observation accessor cannot be replaced, so
      // a same-name object never becomes an authority transfer.
      expect(Reflect.defineProperty(source, "world", { value: rejectedShadow, configurable: true })).toBe(false);
      expect(source.world).toBe(canonical);

      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest({
        input: "wait while the canonical session crosses a scene ABA interval",
        actionId: "ordinary-source-world-reference-mask-aba-1",
        expectedGeneration: 3,
      }));
      await eventually(() => calls === 1);

      expect(Reflect.get(source, "setScene")).toBeUndefined();
      expect(canonical.getCurrentState().scene).toBe("加比的拖车房");
      pending.resolve(completion("help"));

      const committed = await inFlight;
      expect(committed.status).toBe(200);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 4 } });
      expect(snapshots.findActionReceipt(id, "ordinary-source-world-reference-mask-aba-1")).toMatchObject({ status: "ok", value: { generation: 4 } });
    } finally {
      pending.resolve(completion("help"));
      rejectedShadow.close();
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not expose PlayerSession restore authority through the GameSession facade", () => {
    const source = new GameSession(`ordinary-player-session-restore-facade-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const facade: any = source.session;
      expect(Object.isFrozen(facade)).toBe(true);
      expect(facade.restoreSnapshot).toBeUndefined();
      expect(facade.restoreSinglePlayer).toBeUndefined();
    } finally {
      source.close();
    }
  });

  test("keeps exported PlayerSession snapshots detached without changing facade revisions", () => {
    const source = new GameSession(`ordinary-player-session-snapshot-facade-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const before = source.session.exportSnapshot();
      const exported = source.session.exportSnapshot();
      const semanticRevision = source.session.semanticRevision;
      const revision = source.session.stateReplacementRevision;
      exported.players[0]!.knownSecrets.push("detached-public-snapshot-secret");
      exported.globalMessages.push({ speaker: "test", content: "detached", type: "system" });
      expect(source.session.exportSnapshot()).toEqual(before);
      expect(source.session.semanticRevision).toBe(semanticRevision);
      expect(source.session.stateReplacementRevision).toBe(revision);
    } finally {
      source.close();
    }
  });

  test("does not expose PlayerSession switch or leave authority through the GameSession facade", () => {
    const source = new GameSession(`ordinary-player-session-switch-facade-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const facade: any = source.session;
      expect(facade.switchActive).toBeUndefined();
      expect(facade.leave).toBeUndefined();
      expect(source.session.getActive()?.name).toBe("p1");
    } finally {
      source.close();
    }
  });

  test("does not expose PlayerSession discovery or push authority through the GameSession facade", () => {
    const source = new GameSession(`ordinary-player-session-push-facade-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const facade: any = source.session;
      expect(facade.discover).toBeUndefined();
      expect(facade.push).toBeUndefined();
      expect(facade.pushPerPlayer).toBeUndefined();
      expect(source.session.knowsSecret("p1", "absent")).toBe(false);
    } finally {
      source.close();
    }
  });

  test("public PlayerSlot views cannot create a hidden secret ABA during deferred ordinary HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-player-slot-alias-aba-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const before = source.session.exportSnapshot();
      const secret = "temporary-public-player-slot-secret";
      const action = {
        input: "wait while a public PlayerSlot view changes and restores a secret",
        actionId: "ordinary-source-player-slot-alias-aba-1",
        expectedGeneration: 0,
      };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      const view = source.session.get("p1")!;
      view.knownSecrets.add(secret);
      const sourceObservedTemporarySecret = source.session.knowsSecret("p1", secret);
      view.knownSecrets.delete(secret);
      expect(source.session.exportSnapshot()).toEqual(before);

      pending.resolve(completion("help"));
      const committed = await inFlight;
      expect(calls).toBe(1);
      expect(committed.status).toBe(200);
      // The old live slot makes this true while the model awaits even though
      // the final portable snapshot has returned to A. A detached view keeps
      // the source at A for the entire interval.
      expect(sourceObservedTemporarySecret).toBe(false);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects public active-character replacement before it can split ordinary authority", () => {
    const source = new GameSession(`ordinary-active-character-readonly-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
    try {
      const beforeSummary = source.getSummary();
      const beforeState = source.getState();
      const beforeSnapshot = source.exportOrdinarySessionSnapshot();
      const replacement = { ...source.activeCharacter!, name: "Rejected Ada" };

      // Object.assign performs the same ECMAScript [[Set]] as an external
      // property assignment without adding a test-only mutable TypeScript seam.
      expect(() => Object.assign(source, { activeCharacter: replacement })).toThrow(TypeError);
      expect(source.getSummary()).toEqual(beforeSummary);
      expect(source.getState()).toEqual(beforeState);
      expect(source.exportOrdinarySessionSnapshot()).toEqual(beforeSnapshot);
    } finally {
      source.close();
    }
  });

  test("keeps public active-character views detached and readonly during deferred ordinary HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-character-nested-aba-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const originalCharacter = source.activeCharacter!;
      const action = {
        input: "wait while the public character object changes and restores nested values",
        actionId: "ordinary-source-character-nested-aba-1",
        expectedGeneration: 0,
      };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      // The red regression used to make both of these A -> B -> A writes
      // visible to getSummary/source reads and then publish HTTP 200. The
      // public view is now deeply detached and frozen, so neither its top
      // level nor nested values can perturb the staged source.
      expect(Object.isFrozen(originalCharacter)).toBe(true);
      expect(Object.isFrozen(originalCharacter.skillValues)).toBe(true);
      expect(() => { originalCharacter.name = "Temporary Ada"; }).toThrow(TypeError);
      expect(() => { originalCharacter.skillValues.library_use = 1; }).toThrow(TypeError);
      expect(source.getSummary().playerName).toBe(originalCharacter.name);
      expect(source.activeCharacter?.skillValues?.library_use).toBe(originalCharacter.skillValues?.library_use);

      pending.resolve(completion("help"));
      const committed = await inFlight;

      expect(committed.status).toBe(200);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a public SAN assignment while the staged successor remains valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-sanity-assignment-aba-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const originalSanity = source.sanity;
      const action = {
        input: "wait while a public SAN assignment is rejected",
        actionId: "ordinary-source-sanity-assignment-aba-1",
        expectedGeneration: 0,
      };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      const replacementSanity = new SanityEngine(originalSanity.state.maxSAN);
      replacementSanity.restoreState(originalSanity.state);
      expect(() => Object.assign(source, { sanity: replacementSanity })).toThrow(TypeError);
      expect(source.sanity).toBe(originalSanity);

      pending.resolve(completion("help"));
      const committed = await inFlight;

      expect(calls).toBe(1);
      expect(committed.status).toBe(200);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a direct SAN ABA attempt while the staged successor remains valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-sanity-state-aba-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const original = source.sanity.state.currentSAN;
      const alternate = original === 0 ? 1 : original - 1;
      const action = {
        input: "wait while canonical SAN state changes and is restored",
        actionId: "ordinary-source-sanity-state-aba-1",
        expectedGeneration: 0,
      };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      expect(() => source.setPlayerSan("p1", alternate)).toThrow(OrdinaryDurableMutationError);
      expect(() => source.setPlayerSan("p1", original)).toThrow(OrdinaryDurableMutationError);
      expect(source.sanity.state.currentSAN).toBe(original);
      pending.resolve(completion("help"));

      const committed = await inFlight;
      expect(committed.status).toBe(200);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a staged successor valid after a same-value SAN setter and rejected readonly-view writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-sanity-state-noop-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const action = {
        input: "wait while a same-value SAN setter is called",
        actionId: "ordinary-source-sanity-state-noop-1",
        expectedGeneration: 0,
      };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      const current = source.sanity.state;
      expect(() => { (current as any).currentSAN = current.currentSAN === 0 ? 1 : current.currentSAN - 1; }).toThrow(TypeError);
      expect(() => { (current.phobias as any).push("blocked alias"); }).toThrow(TypeError);
      expect(() => source.setPlayerSan("p1", current.currentSAN)).toThrow(OrdinaryDurableMutationError);
      pending.resolve(completion("help"));

      const committed = await inFlight;
      expect(committed.status).toBe(200);
      // A durable ordinary action publishes a rehydrated successor and then
      // retires its source.  Read the committed cohort from that successor;
      // the retained source must not disclose its pre-publication view.
      const successor = runtime.registry.get(id);
      expect(successor).toBeDefined();
      expect(successor).not.toBe(source);
      expect(successor!.sanity.state).toEqual(current);
      expect(() => source.sanity.state).toThrow("closed GameSession cannot read session state");
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a direct inactive-PC SAN ABA attempt while the staged p1 successor remains valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-party-sanity-aba-"));
    const runtime = testRuntime((session) => {
      const added = session.addPartyMember("Bea", "investigator");
      if ("rejected" in added) throw new Error(`could not create p2: ${added.rejected}`);
    });
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      expect(source.activePlayerId).toBe("p1");
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const original = source.getState().party.find((member) => member.pcId === "p2")!.san;
      const alternate = original === 0 ? 1 : original - 1;
      const action = {
        input: "wait while inactive p2 SAN returns to its prior state",
        actionId: "ordinary-source-party-sanity-aba-1",
        expectedGeneration: 0,
      };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      expect(() => source.setPlayerSan("p2", alternate)).toThrow(OrdinaryDurableMutationError);
      expect(() => source.setPlayerSan("p2", original)).toThrow(OrdinaryDurableMutationError);
      expect(source.getState().party.find((member) => member.pcId === "p2")?.san).toBe(original);
      pending.resolve(completion("help"));

      const committed = await inFlight;
      expect(calls).toBe(1);
      expect(committed.status).toBe(200);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a staged p1 action valid after a same-value inactive p2 SAN setter", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-party-sanity-noop-"));
    const runtime = testRuntime((session) => {
      const added = session.addPartyMember("Bea", "investigator");
      if ("rejected" in added) throw new Error(`could not create p2: ${added.rejected}`);
    });
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      expect(source.activePlayerId).toBe("p1");
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const action = {
        input: "wait while a same-value inactive p2 SAN setter is called",
        actionId: "ordinary-source-party-sanity-noop-1",
        expectedGeneration: 0,
      };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      const original = source.getState().party.find((member) => member.pcId === "p2")!.san;
      expect(() => source.setPlayerSan("p2", original)).toThrow(OrdinaryDurableMutationError);
      pending.resolve(completion("help"));

      const committed = await inFlight;
      expect(calls).toBe(1);
      expect(committed.status).toBe(200);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SAN cohort helper captures stable pcId order and rejects cardinality changes", () => {
    const fixture = makeSanityCohortFixture();
    const captured = captureSanityCohort(fixture.sanityEngines);
    expect(captured.map((member) => member.pcId)).toEqual(["p1", "p2"]);

    fixture.sanityEngines.set("p3", new SanityEngine(50));
    expect(sanityCohortCurrent(captured, fixture)).toBe(false);
  });

  test("SAN cohort helper rejects a same-state inactive raw identity replacement even when party alias is aligned", () => {
    const fixture = makeSanityCohortFixture();
    const captured = captureSanityCohort(fixture.sanityEngines);
    const replacement = clonedSanityEngine(fixture.p2);
    fixture.sanityEngines.set("p2", replacement);
    fixture.party.set("p2", { pcId: "p2", san: replacement });

    expect(replacement.state).toEqual(fixture.p2.state);
    expect(sanityCohortCurrent(captured, fixture)).toBe(false);
  });

  test("SAN cohort helper rejects semantic ABA even after the raw state returns", () => {
    const fixture = makeSanityCohortFixture();
    const captured = captureSanityCohort(fixture.sanityEngines);
    const original = fixture.p2.state.currentSAN;
    const alternate = original === 0 ? 1 : original - 1;
    const revision = fixture.p2.semanticRevision;

    fixture.p2.restoreState({ ...fixture.p2.state, currentSAN: alternate });
    fixture.p2.restoreState({ ...fixture.p2.state, currentSAN: original });

    expect(fixture.p2.state.currentSAN).toBe(original);
    expect(fixture.p2.semanticRevision).toBeGreaterThan(revision);
    expect(sanityCohortCurrent(captured, fixture)).toBe(false);
  });

  test("SAN cohort helper rejects party raw aliases and party key/member pcId divergence", () => {
    const aliasFixture = makeSanityCohortFixture();
    const aliasCapture = captureSanityCohort(aliasFixture.sanityEngines);
    aliasFixture.party.set("p2", { pcId: "p2", san: clonedSanityEngine(aliasFixture.p2) });
    expect(sanityCohortCurrent(aliasCapture, aliasFixture)).toBe(false);

    const keyFixture = makeSanityCohortFixture();
    const keyCapture = captureSanityCohort(keyFixture.sanityEngines);
    keyFixture.party.set("p2", { pcId: "not-p2", san: keyFixture.p2 });
    expect(sanityCohortCurrent(keyCapture, keyFixture)).toBe(false);
  });

  test("SAN cohort helper rejects an active raw-to-map alias split", () => {
    const fixture = makeSanityCohortFixture();
    const replacement = clonedSanityEngine(fixture.p1);
    fixture.sanityEngines.set("p1", replacement);
    fixture.party.set("p1", { pcId: "p1", san: replacement });
    // Capture after the map and party are mutually aligned.  Only the active
    // raw alias remains stale, so this test isolates the final active guard.
    const captured = captureSanityCohort(fixture.sanityEngines);

    expect(sanityCohortCurrent(captured, fixture, fixture.p1)).toBe(false);
  });

  test("SAN cohort helper keeps an exact inactive SAN no-op current", () => {
    const fixture = makeSanityCohortFixture();
    const captured = captureSanityCohort(fixture.sanityEngines);
    const revision = fixture.p2.semanticRevision;
    fixture.p2.restoreState(structuredClone(fixture.p2.state));

    expect(fixture.p2.semanticRevision).toBe(revision);
    expect(sanityCohortCurrent(captured, fixture)).toBe(true);
  });

  test("rejects even a no-op direct live setter while the staged successor remains valid", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-state-noop-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    let restoreUpsertEntity: (() => void) | undefined;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const action = { input: "wait while KP repeats current HP", actionId: "ordinary-source-state-noop-1", expectedGeneration: 0 };
      const originalHp = source.getState().player.hp;
      const targetWorlds = new WeakSet<WorldStateManager>();
      // Capture the private raw manager through a real, harmless facade read.
      // The capture patch has no await boundary and is immediately restored;
      // unlike a marker entity, it cannot alter the durable source snapshot
      // that the concurrent action deliberately fences.
      const originalExportSnapshot = WorldStateManager.prototype.exportSnapshot;
      WorldStateManager.prototype.exportSnapshot = function captureTargetWorld(...args) {
        targetWorlds.add(this);
        return originalExportSnapshot.apply(this, args);
      };
      try {
        source.world.exportSnapshot();
      } finally {
        WorldStateManager.prototype.exportSnapshot = originalExportSnapshot;
      }
      const originalUpsertEntity = WorldStateManager.prototype.upsertEntity;
      let restoredUpsertEntity = false;
      restoreUpsertEntity = () => {
        if (restoredUpsertEntity) return;
        restoredUpsertEntity = true;
        WorldStateManager.prototype.upsertEntity = originalUpsertEntity;
      };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      // Durable-live policy rejects a direct setter before it can reach the
      // raw manager, even where the supplied value would be a semantic no-op.
      // Install the target-scoped fault only for this synchronous setter.  A
      // staged successor legitimately writes the same player before the
      // deferred model response, so letting the patch cross the async request
      // boundary would test the staging implementation instead of the no-op.
      // The captured raw identity selects only the source manager.
      WorldStateManager.prototype.upsertEntity = function guardedNoopUpsert(entity) {
        if (targetWorlds.has(this) && entity.id === "p1") {
          throw new Error("same-value HP must not write entity");
        }
        return originalUpsertEntity.call(this, entity);
      };
      try {
        expect(() => source.setPlayerHp("p1", originalHp)).toThrow(OrdinaryDurableMutationError);
      } finally {
        restoreUpsertEntity();
      }
      expect(source.getState().player.hp).toBe(originalHp);
      pending.resolve(completion("help"));

      const committed = await inFlight;
      expect(committed.status).toBe(200);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(socket.sent).toHaveLength(1);
    } finally {
      pending.resolve(completion("help"));
      restoreUpsertEntity?.();
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a source write injected at the synchronous pre-publication gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-source-state-fence-"));
    const runtime = testRuntime();
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const authoritativeHp = source.getState().player.hp;
      const mutatedHp = authoritativeHp === 1 ? 2 : 1;
      let fenced = 0;
      runtime.dependencies.ordinaryActionAdmission = {
        // Injected test coordinators must name the same durable file as the
        // runtime namespace; otherwise the server correctly fail-closes them
        // before this pre-publication seam can run.
        file: join(root, "sessions", ".ordinary-action-admission.sqlite"),
        acquire: () => ({
          status: "acquired" as const,
          fence: "test-fence",
          expiresAt: Date.now() + 60_000,
          renewalIntervalMs: 60_000,
          renew: () => ({ status: "active" as const, fence: "test-fence", expiresAt: Date.now() + 60_000 }),
          withActiveFence: <T>(operation: () => T) => {
            fenced++;
            // This runs after the post-await guard. It must remain a policy
            // rejection rather than poisoning the host transaction.
            expect(() => source.setPlayerHp("p1", mutatedHp)).toThrow(OrdinaryDurableMutationError);
            return { status: "executed" as const, value: operation() };
          },
          quarantine: () => undefined,
          release: () => undefined,
        }),
      } as unknown as OrdinaryActionAdmissionCoordinator;
      const action = { input: "/help", actionId: "ordinary-source-state-fence-1", expectedGeneration: 0 };

      const committed = await request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      expect(fenced).toBe(1);
      expect(committed.status).toBe(200);

      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(runtime.registry.get(id)).not.toBe(source);
      expect(runtime.registry.get(id)?.getState().player.hp).toBe(authoritativeHp);
    } finally {
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restores the latest authority when a retired source raced an external successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-action-retired-source-authority-"));
    const runtime = testRuntime();
    const pending = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return pending.promise; }) as unknown as typeof fetch;
    try {
      const { id, session: source } = await createOrdinary(root, runtime);
      const socket = fakeSocket();
      createWsClient(socket.ws, id, "player", "p1");
      liveSockets.push(socket.ws);
      const action = { input: "close after external successor", actionId: "ordinary-retired-source-1", expectedGeneration: 0 };
      const inFlight = request(root, runtime, `/api/sessions/${id}/action`, jsonRequest(action));
      await eventually(() => calls === 1);

      // Model a different process publishing g1 while this candidate awaits.
      // It writes through the same trusted envelope mechanics but cannot take
      // this process's in-memory source lifecycle lease.
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      const predecessor = snapshots.read(id);
      if (predecessor.status !== "ok") throw new Error("missing g0 predecessor");
      const external = new GameSession(
        id,
        "cosmic-horror",
        CONFIG,
        undefined,
        undefined,
        undefined,
        { careerRoot: join(root, "external-careers") },
        predecessor.value.access,
        "required",
      );
      try {
        // The staged request already owns `pending.promise`; changing future
        // calls lets this independent process derive its successor without
        // releasing that in-flight candidate.
        globalThis.fetch = (async () => completion("status")) as unknown as typeof fetch;
        external.restoreOrdinarySessionSnapshot(predecessor.value.snapshot);
        const acted = await external.act("/status");
        const snapshot = external.exportOrdinarySessionSnapshot();
        const record: OrdinaryPersistedActionRecord = {
          actionId: "ordinary-retired-external-1",
          requestHash: ordinaryActionRequestHash(id, "ordinary-retired-external-1", "/status", null, 0),
          input: "/status",
          pcId: null,
          expectedGeneration: 0,
          generation: 1,
          status: 200,
          response: JSON.parse(JSON.stringify({ ...acted, summary: external.getSummary(), sessionKind: "ordinary", ordinaryGeneration: 1 })),
        };
        const archive = nextOrdinarySessionArchive(id, predecessor.value.archive, record, snapshot);
        const envelope = createOrdinarySessionEnvelope({
          kind: "ordinary-session-envelope",
          schemaVersion: predecessor.value.schemaVersion,
          sessionId: id,
          generation: 1,
          previousEnvelopeHash: predecessor.value.envelopeHash,
          access: predecessor.value.access,
          snapshot,
          idempotency: [...predecessor.value.idempotency, record],
          archive,
          replayDirectory: snapshots.prepareOrdinaryReplayDirectory(id, predecessor.value.replayDirectory, record, archive.headHash!),
        });
        const namespace = new SessionNamespaceCoordinator(join(root, "sessions"));
        const previousIdentity = {
          hash: predecessor.value.envelopeHash,
          generation: predecessor.value.generation,
          format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
        };
        const nextIdentity = {
          hash: envelope.envelopeHash,
          generation: envelope.generation,
          format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
        };
        const published = namespace.publishCommitted({
          kind: "ordinary",
          sessionId: id,
          previousIdentity,
          nextIdentity,
          publish: (permit) => {
            const saved = snapshots.save(envelope, { permit }, {
              required: true,
              consume: namespace.consumePublicationPermit.bind(namespace),
            });
            return saved.status === "ok"
              ? { status: "published" as const, observedIdentity: nextIdentity }
              : saved.status === "indeterminate"
                ? { status: "indeterminate" as const }
                : { status: "not-published" as const, failureCode: saved.code };
          },
        });
        expect(published).toMatchObject({ state: "committed", expectedIdentity: nextIdentity });
      } finally {
        external.close();
      }

      source.close();
      pending.resolve(completion("help"));
      const failed = await inFlight;

      expect(failed.status).toBe(503);
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, action.actionId)).toEqual({ status: "ok", value: null });
      expect(runtime.registry.get(id)).not.toBe(source);
      expect(runtime.registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
      expect(socket.sent).toHaveLength(0);
    } finally {
      pending.resolve(completion("help"));
      for (const session of runtime.registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
