import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession } from "../api/game-session";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";
import {
  ordinaryGameSessionSnapshotHash,
  validateOrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";
import {
  ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  OrdinarySessionSnapshotStore,
  createOrdinarySessionEnvelope,
  ordinarySessionEnvelopeHash,
  validateOrdinarySessionEnvelope,
} from "../api/ordinary-session-snapshot-store";
import { OrdinaryActionAdmissionCoordinator } from "../api/ordinary-action-admission";
import { handleRequest, hydrateOrdinarySession, runOrdinaryActionTransaction } from "../api/server";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledIntentAdmissionCoordinator } from "../api/compiled-intent-admission";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";

const TEST_LLM = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" as const };
function makeSession(id = "ordinary-terminal-reason"): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession(id, "cosmic-horror", TEST_LLM, "detective", "调查员", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
}

function makeRestoreTarget(id: string): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession(id, "cosmic-horror", TEST_LLM, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
}

it("reports a confirmed ordinary module departure as a non-death terminal", async () => {
  const session = makeSession();
  try {
    await session.act("加载模组 普瑞米尔的谷仓");
    await session.act("我们决定离开这里，结束这次调查");
    const departure = await session.act("确定");

    expect(departure.dead).toBe(false);
    expect((departure as any).terminal).toMatchObject({ kind: "module_departure" });
    const roundAtDeparture = departure.state.round;
    const blocked = await session.act("observe");
    expect(blocked).toMatchObject({ dead: false, terminal: departure.terminal });
    expect(blocked.state.round).toBe(roundAtDeparture);
    expect(blocked.events).toHaveLength(1);
    expect(blocked.events[0]?.type).toBe("system");
    expect(blocked.events[0]?.content).toContain("\u8c03\u67e5\u5df2\u7ed3\u675f");
    expect(blocked.events[0]?.content).not.toContain("\u6b7b");
  } finally {
    session.close();
  }
});

it("seals ordinary terminal authority against runtime writes to the compatibility death view", async () => {
  const session = makeSession("ordinary-terminal-write-seal");
  try {
    // `dead` remains a compatibility *read*, but it must not become a second
    // mutable terminal authority.  In particular, a caller cannot turn a
    // live ordinary session into a guessed death.
    expect(() => { (session as any).dead = true; }).toThrow();
    expect(session.dead).toBe(false);
    expect(session.getOrdinaryTerminal()).toBeNull();

    await session.act("加载模组 普瑞米尔的谷仓");
    await session.act("我们决定离开这里，结束这次调查");
    const departure = await session.act("确定");
    expect(departure).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });

    // Nor can a caller erase an established non-death terminal by writing a
    // legacy boolean.  The discriminant is the sole ordinary authority.
    expect(() => { (session as any).dead = false; }).toThrow();
    expect(session.dead).toBe(false);
    expect(session.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
  } finally {
    session.close();
  }
});

it("marks an actual lethal NPC counterattack as death and keeps death wording", async () => {
  let session = makeSession("ordinary-terminal-real-death");
  const originalRandom = Math.random;
  try {
    const prepared = makeRestoreTarget(session.id);
    try {
      restoreSignedOrdinaryWorld(prepared, TEST_LLM, (world) => {
        const scene = world.getCurrentState().scene;
        world.upsertEntity({
          id: "terminal-death-monster", name: "terminal monster", type: "monster",
          hp: 200, maxHp: 200, ac: 0, status: [], position: scene, scene_id: scene,
        });
      }, session);
    } catch (error) {
      prepared.close();
      throw error;
    }
    session.close();
    session = prepared;
    expect(session.setPlayerHp("p1", 1)).toMatchObject({ ok: true });
    // This is the production combat route's known NPC critical-hit sequence;
    // one HP turns its real counterattack into a deterministic lethal hit.
    const values = [0, 0, 0.99, 0, 0, 0.99, 0, 0, 0, 0.99, 0.99];
    let index = 0;
    Math.random = () => values[index++] ?? 0.99;
    const death = await session.act("攻击 terminal monster");
    expect(death).toMatchObject({ dead: true, terminal: { kind: "death" } });
    const blocked = await session.act("observe");
    expect(blocked).toMatchObject({ dead: true, terminal: { kind: "death" } });
    expect(blocked.events[0]?.content).toContain("\u4f60\u5df2\u7ecf\u6b7b\u4e86");
  } finally {
    Math.random = originalRandom;
    session.close();
  }
});

it("does not project ordinary terminal metadata onto a real compiled session", async () => {
  const session = makeSession("ordinary-terminal-compiled-boundary");
  try {
    const fixture = await compiledModuleHttpFixture("ordinary-terminal-compiled-boundary");
    expect(session.loadCompiledModule(fixture.resolved.artifact.payload as any, fixture.projection).status).toBe("loaded");
    expect(session.getOrdinaryTerminal()).toBeNull();
    expect(session.dead).toBe(false);
  } finally {
    session.close();
  }
});

it("migrates a verified v1.3 dead flag to fail-closed legacy_unknown without guessing death", async () => {
  // v1.3 only accepted the historical complete Career wire shape. This
  // migration fixture therefore remains a durable legacy snapshot, while
  // current in-memory terminal flows above use transient snapshots.
  const source = new GameSession("ordinary-terminal-v13-source", "cosmic-horror", TEST_LLM, "detective", "调查员");
  const restored = new GameSession("ordinary-terminal-v13-source", "cosmic-horror", TEST_LLM);
  try {
    // A verified historical wire had only this ambiguous boolean. Construct
    // that old signed shape directly; a current session must not be mutated
    // through the removed public write channel to arrange the migration.
    const wire: any = structuredClone(source.exportOrdinarySessionSnapshot());
    wire.schemaVersion = "1.3.0";
    wire.components.snapshot = "1.3.0";
    wire.state.dead = true;
    delete wire.state.terminal;
    const { snapshotHash: _discarded, ...unsigned } = wire;
    wire.snapshotHash = ordinaryGameSessionSnapshotHash(unsigned);

    const migrated = validateOrdinaryGameSessionSnapshot(wire);
    expect(migrated).toMatchObject({ schemaVersion: "1.4.0", state: { dead: false, terminal: { kind: "legacy_unknown" } } });
    expect(migrated.state.woundsTreatedByPC).toEqual(wire.state.woundsTreatedByPC);
    restored.restoreOrdinarySessionSnapshot(wire);
    const blocked = await restored.act("观察");
    expect(blocked).toMatchObject({ dead: false, terminal: { kind: "legacy_unknown" } });
    expect(blocked.events.map((event) => event.content).join("\n")).not.toContain("你已经死了");
  } finally {
    source.close();
    restored.close();
  }
});

it("round-trips departure terminal identity and rejects terminal tampering", async () => {
  const source = makeSession("ordinary-terminal-snapshot");
  const restored = makeRestoreTarget("ordinary-terminal-snapshot");
  try {
    await source.act("加载模组 普瑞米尔的谷仓");
    await source.act("我们决定离开这里，结束这次调查");
    const departure = await source.act("确定");
    if (departure.terminal?.kind !== "module_departure") throw new Error("expected departure terminal");
    const terminal = departure.terminal;
    const snapshot = source.exportOrdinarySessionSnapshot();
    expect(snapshot.state).toMatchObject({ dead: false, terminal });

    restored.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.getOrdinaryTerminal()).toEqual(terminal);
    await expect(restored.act("观察")).resolves.toMatchObject({ dead: false, terminal: departure.terminal });

    const tamperedIdentity: any = structuredClone(snapshot);
    tamperedIdentity.state.terminal.endingId = "forged-ending";
    expect(() => validateOrdinaryGameSessionSnapshot(tamperedIdentity)).toThrow("snapshotHash");

    const tamperedReason: any = structuredClone(snapshot);
    tamperedReason.state.terminal = { kind: "death" };
    const { snapshotHash: _discarded, ...unsigned } = tamperedReason;
    tamperedReason.snapshotHash = ordinaryGameSessionSnapshotHash(unsigned);
    expect(() => validateOrdinaryGameSessionSnapshot(tamperedReason)).toThrow("death terminal");
  } finally {
    source.close();
    restored.close();
  }
});

// This receipt path writes durable state, reopens it, and replays it across a
// restart. Keep its direct-run allowance local; the rest of this file is fast.
it("persists, replays, restarts, and fail-closes an ordinary departure receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-terminal-receipt-"));
  const id = "ordinary-terminal-durable";
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-terminal-owner" });
  const source = new GameSession(id, "cosmic-horror", undefined, "detective", "Ada", undefined,
    { careerRoot: join(root, "careers") }, access, "development_fallback");
  const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
  const registry = new Map<string, GameSession>();
  const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
  try {
    const initial = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 0, previousEnvelopeHash: null, access,
      snapshot: source.exportOrdinarySessionSnapshot(), idempotency: [],
    });
    expect(snapshots.save(initial)).toMatchObject({ status: "ok" });
    source.close();
    let hydratedHostCapability: object | undefined;
    const hydrated = hydrateOrdinarySession(id, {
      snapshots,
      storage,
      intentPolicy: "development_fallback",
      createSession: (sessionId, recoveredAccess, runtimeDependencies) => {
        hydratedHostCapability = runtimeDependencies.ordinaryDurableHostCapability;
        return new GameSession(sessionId, "cosmic-horror", undefined, undefined, undefined, undefined, storage, recoveredAccess, "development_fallback", runtimeDependencies);
      },
    });
    if (hydrated.status !== "ok") throw new Error(hydrated.message);
    registry.set(id, hydrated.session);
    const options = {
      snapshots, sessionRegistry: registry, storage, intentPolicy: "development_fallback" as const,
      ordinaryDurableHostCapability: hydratedHostCapability!,
      createPristineSession: ({ id: targetId, access: targetAccess, storage: targetStorage, runtimeDependencies }: {
        id: string;
        access: NonNullable<ConstructorParameters<typeof GameSession>[7]>;
        storage: { careerRoot?: string; sessionRoot?: string };
        runtimeDependencies: { ordinaryDurableHostCapability: object };
      }) => new GameSession(targetId, "cosmic-horror", undefined, undefined, undefined, undefined, targetStorage, targetAccess, "development_fallback", runtimeDependencies),
      actionAdmission: new OrdinaryActionAdmissionCoordinator(snapshots.root),
    };
    const commit = async (input: string, actionId: string, expectedGeneration: number) => {
      const live = registry.get(id);
      if (!live) throw new Error("durable test lost its live ordinary session");
      return runOrdinaryActionTransaction(live, { input, actionId, expectedGeneration }, options);
    };

    expect((await commit("加载模组 普瑞米尔的谷仓", "terminal-action-0001", 0)).status).toBe(200);
    expect((await commit("我们决定离开这里，结束这次调查", "terminal-action-0002", 1)).status).toBe(200);
    const departure = await commit("确定", "terminal-action-0003", 2);
    expect(departure).toMatchObject({ status: 200, body: { dead: false, terminal: { kind: "module_departure" }, ordinaryGeneration: 3 } });

    const receipt = snapshots.findActionReceipt(id, "terminal-action-0003");
    expect(receipt).toMatchObject({ status: "ok", value: { response: { dead: false, terminal: { kind: "module_departure" } } } });
    const restarted = hydrateOrdinarySession(id, { snapshots, storage, intentPolicy: "development_fallback" });
    expect(restarted).toMatchObject({ status: "ok" });
    if (restarted.status !== "ok") throw new Error("durable terminal restart failed");
    expect(restarted.session.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    const replay = await runOrdinaryActionTransaction(restarted.session, {
      input: "确定", actionId: "terminal-action-0003", expectedGeneration: 2,
    }, options);
    expect(replay).toMatchObject({ status: 200, body: { dead: false, terminal: { kind: "module_departure" }, ordinaryGeneration: 3 } });
    restarted.session.close();

    const envelope = snapshots.read(id);
    expect(envelope.status).toBe("ok");
    if (envelope.status !== "ok" || !envelope.value.archive.headHash) throw new Error("missing durable terminal receipt");
    expect(envelope.value.archive.headHash).toEqual(expect.any(String));

    const rehashedResponseMismatch: any = structuredClone(envelope.value);
    rehashedResponseMismatch.idempotency.at(-1).response.terminal.endingName = "forged-ending";
    const { envelopeHash: _oldEnvelopeHash, ...unsignedEnvelope } = rehashedResponseMismatch;
    rehashedResponseMismatch.envelopeHash = ordinarySessionEnvelopeHash(unsignedEnvelope);
    expect(() => validateOrdinarySessionEnvelope(rehashedResponseMismatch))
      .toThrow("terminal does not match its snapshot");

    const receiptPath = join(snapshots.root, `${id}.${envelope.value.archive.headHash}.ordinary-action-receipt.json`);
    const tampered = JSON.parse(readFileSync(receiptPath, "utf8"));
    tampered.record.response.terminal.endingName = "forged-ending";
    writeFileSync(receiptPath, `${JSON.stringify(tampered)}\n`, "utf8");
    expect(snapshots.read(id)).toMatchObject({ status: "refused", code: "ORDINARY_SNAPSHOT_CORRUPT" });
  } finally {
    try { registry.get(id)?.close(); } catch { /* test cleanup */ }
    try { source.close(); } catch { /* may already be replaced */ }
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it("returns ordinary terminal state from both authoritative GET views after refresh hydration", async () => {
  const root = mkdtempSync(join(tmpdir(), "ordinary-terminal-authoritative-"));
  const id = "12345678-1234-4123-8123-123456789abc";
  const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
  const registry = new Map<string, GameSession>();
  const ordinarySnapshots = new OrdinarySessionSnapshotStore({ root: join(root, "ordinary-snapshots") });
  const namespace = new SessionNamespaceCoordinator(storage.sessionRoot);
  const runtime = {
    registry,
    ordinarySnapshots,
    ordinaryIntentPolicy: "development_fallback" as const,
    generateSessionId: () => id,
    sessionNamespace: namespace,
    ordinaryActionAdmission: new OrdinaryActionAdmissionCoordinator(namespace.root),
    compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(namespace.root),
  };
  const access = { mode: "development_anonymous" as const, environment: { NODE_ENV: "test" } };
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const compiledSnapshots = new CompiledSessionSnapshotStore({ root: join(root, "compiled-snapshots") });
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(new Request(`http://test${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }), catalog, compiledSnapshots, storage, {}, {}, undefined, undefined, undefined, undefined, access, runtime);
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const created = await request("/api/sessions", "POST", { archetype: "detective", characterName: "Ada" });
    expect(created).toMatchObject({ status: 201, body: { sessionId: id, ordinaryGeneration: 0 } });
    const act = (input: string, actionId: string, expectedGeneration: number) =>
      request(`/api/sessions/${id}/action`, "POST", { input, actionId, expectedGeneration });
    expect((await act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3", "authoritative-action-0001", 0)).status).toBe(200);
    expect((await act("\u6211\u4eec\u51b3\u5b9a\u79bb\u5f00\u8fd9\u91cc\uff0c\u7ed3\u675f\u8fd9\u6b21\u8c03\u67e5", "authoritative-action-0002", 1)).status).toBe(200);
    expect(await act("\u786e\u5b9a", "authoritative-action-0003", 2)).toMatchObject({
      status: 200, body: { dead: false, terminal: { kind: "module_departure" }, ordinaryGeneration: 3 },
    });

    for (const session of registry.values()) session.close();
    registry.clear();
    const summary = await request(`/api/sessions/${id}`);
    const state = await request(`/api/sessions/${id}/state`);
    for (const result of [summary, state]) {
      expect(result).toMatchObject({
        status: 200,
        body: { sessionKind: "ordinary", ordinaryGeneration: 3, dead: false, terminal: { kind: "module_departure" } },
      });
    }
  } finally {
    for (const session of registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it("ordinary owner UI renders structured terminal branches and disables input for every terminal", () => {
  const app = readFileSync(join(import.meta.dir, "..", "..", "frontend", "src", "App.vue"), "utf8");
  expect(app).toContain("session.terminal?.kind === 'module_departure'");
  expect(app).toContain("session.terminal?.kind === 'legacy_unknown'");
  expect(app).toContain("applyTerminalState(current, declaredKind)");
  expect(app).toContain("v-if=\"sessionTerminal\"");
  const ordinaryInputDisabled = "loading || sessionTerminal || ordinaryPendingKind";
  expect(app).toContain(`class="input-area__pc-select" :disabled="${ordinaryInputDisabled}"`);
  expect(app).toContain(`class="input-area__field" :disabled="${ordinaryInputDisabled}"`);
  expect(app).toContain(`class="suggestion-bar__chip" :disabled="${ordinaryInputDisabled}"`);
  expect(app).toContain("sessionTerminal ? '旅程已结束……'");
});
