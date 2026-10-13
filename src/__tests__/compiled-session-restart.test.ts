import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession, compiledMechanicsAction } from "../api/game-session";
import {
  ordinaryGameSessionSnapshotHash,
  type OrdinaryGameSessionSnapshot,
  type OrdinarySnapshotJson,
} from "../api/ordinary-game-session-snapshot";
import {
  canonicalJson,
  CompiledSessionSnapshotStore as CompiledSessionSnapshotStoreImplementation,
  compiledSessionSnapshotHash,
  compiledSessionSnapshotNodeFileOps,
  validateCompiledSessionSnapshot,
  type CompiledSessionSnapshot,
  type CompiledSessionSnapshotStoreOptions,
} from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { mechanicsStateHash } from "../compiler/mechanics-execution";
import { sha256 } from "../ingest/document-ir";
import { cleanupExpiredSessions, hydrateCompiledSessions, partitionSessionListings, runAction } from "../api/server";
import { SanityEngine } from "../rules/coc-engine";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";
import { patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";
import { createCompiledDurableTestHost, type CompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const compiledDurableHosts = new WeakMap<GameSession, CompiledDurableTestHost>();

function hostFor(session: GameSession): CompiledDurableTestHost {
  const host = compiledDurableHosts.get(session);
  if (!host) throw new Error(`compiled durable host is missing for ${session.id}`);
  return host;
}

async function runDurableAction(
  session: GameSession,
  body: Record<string, unknown>,
  persistCompiledSnapshot?: (snapshot: CompiledSessionSnapshot) => void,
  installCompiledSnapshot?: (snapshot: CompiledSessionSnapshot) => GameSession,
) {
  return runAction(session, body, persistCompiledSnapshot, installCompiledSnapshot, undefined, undefined, hostFor(session).capability);
}

/** This file drives GameSession/store replay mechanics directly, outside HTTP.
 * Its raw store writes are an explicit standalone-store test seam, never a
 * production host configuration. */
class CompiledSessionSnapshotStore extends CompiledSessionSnapshotStoreImplementation {
  constructor(options: CompiledSessionSnapshotStoreOptions = {}) {
    super({ ...options, allowUncoordinatedTestWrites: true });
  }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "compiled-restart-"));
}

async function durableSession(
  dir: string,
  id = "compiledrestart",
  configureInitialCharacter?: (snapshot: OrdinaryGameSessionSnapshot) => void,
) {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
  const savedBundle = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
  if (savedBundle.status !== "ok") throw new Error(savedBundle.message);
  const bundle = catalog.loadBundle(savedBundle.value.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots") });
  let host = createCompiledDurableTestHost();
  let session = new GameSession(
    id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", host.runtimeDependencies,
  );
  compiledDurableHosts.set(session, host);
  if (configureInitialCharacter) {
    const snapshot = session.exportOrdinarySessionSnapshot();
    configureInitialCharacter(snapshot);
    const { snapshotHash: _discarded, ...unsigned } = snapshot;
    const replacementHost = createCompiledDurableTestHost();
    const replacement = new GameSession(
      id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", replacementHost.runtimeDependencies,
    );
    replacement.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
    session.close();
    session = replacement;
    host = replacementHost;
    compiledDurableHosts.set(session, host);
  }
  const loaded = session.loadDurableCompiledModule(bundle.value);
  if (loaded.status === "refused") throw new Error(loaded.message);
  const initial = host.snapshot(session);
  const saved = snapshots.save(initial);
  if (saved.status !== "ok") throw new Error(saved.message);
  host.acknowledge(session, initial);
  return { fixture, catalog, snapshots, session, host, bundleId: savedBundle.value.id, dir };
}

function snapshotRecord(value: OrdinarySnapshotJson, label: string): Record<string, OrdinarySnapshotJson> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be an object`);
  return value;
}

function setSnapshotP1Skill(snapshot: OrdinaryGameSessionSnapshot, skill: string, value: number): void {
  const p1 = snapshot.state.characters.find((entry) => entry.pcId === "p1");
  if (!p1) throw new Error("durable fixture requires p1");
  const sheet = snapshotRecord(p1.sheet, "p1 sheet");
  snapshotRecord(sheet.skillValues, "p1 skillValues")[skill] = value;
}

function methodIds(payload: any) {
  return {
    parent: payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id,
    child: payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_child")!.id,
    entry: payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "entry_archive")!.id,
    exit: payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "archive_exit")!.id,
  };
}

function restoreFresh(built: Awaited<ReturnType<typeof durableSession>>, snapshot?: unknown): GameSession {
  const loaded = built.catalog.loadBundle(built.bundleId);
  if (loaded.status !== "ok") throw new Error(loaded.message);
  const raw = snapshot === undefined ? built.snapshots.read(built.session.id) : { status: "ok" as const, value: snapshot };
  if (raw.status !== "ok") throw new Error(raw.message);
  const host = createCompiledDurableTestHost();
  const restored = new GameSession(
    built.session.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(built.dir, "careers") }, undefined, "preferred", host.runtimeDependencies,
  );
  compiledDurableHosts.set(restored, host);
  const result = restored.restoreCompiledSession(raw.value, loaded.value);
  if (result.status === "refused") throw new Error(result.message);
  return restored;
}

function commitAndRestore(
  current: GameSession,
  built: Awaited<ReturnType<typeof durableSession>>,
  input: string,
  actionId: string,
) {
  const committed = hostFor(current).commit(current, input, actionId, current.getCompiledGeneration()!, (snapshot) => {
    const saved = built.snapshots.save(snapshot);
    if (saved.status !== "ok") throw new Error(saved.message);
  });
  expect(committed.status).toBe("committed");
  if (committed.status !== "committed") throw new Error("compiled action did not commit");
  return { committed, current: restoreFresh(built, committed.snapshot) };
}

function rehash(snapshot: CompiledSessionSnapshot): CompiledSessionSnapshot {
  snapshot.snapshotHash = compiledSessionSnapshotHash(snapshot);
  return snapshot;
}

type FreshRestartProof = {
  ordering: string[];
  duplicate: { generation: number };
  continued: { generation: number; narrative: string; compiled: { stateHash: string; terminalEnding?: { id: string } } };
  history: number;
};

async function runFreshWorkerRestartProof(request: Record<string, unknown>): Promise<FreshRestartProof> {
  const worker = new Worker(new URL("./compiled-session-restart-child.ts", import.meta.url).href, { type: "module" });
  try {
    return await new Promise<FreshRestartProof>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error("fresh restart worker timed out"));
      }, 10_000);
      const finish = (value: FreshRestartProof | Error) => {
        clearTimeout(timeout);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      worker.onmessage = (event: MessageEvent<{ status: "ok"; proof: FreshRestartProof } | { status: "error"; message: string }>) => {
        if (event.data.status === "ok") finish(event.data.proof);
        else finish(new Error(event.data.message));
      };
      worker.onerror = (event: ErrorEvent) => finish(new Error(event.message || "fresh restart worker failed"));
      worker.postMessage(request);
    });
  } finally {
    worker.terminate();
  }
}

describe("restart-safe compiled sessions", () => {
  it("stores a hash-bound catalog reference and restores exact p1, SAN, history, state, trace, and generation", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir);
      const sanityFacade: Record<string, unknown> = built.session.sanity;
      const beforeSanity = built.session.getSanity();
      expect(Object.isFrozen(sanityFacade)).toBe(true);
      expect(Object.keys(sanityFacade)).toEqual(["state"]);
      expect(sanityFacade.applyLoss).toBeUndefined();
      expect(() => Object.assign(built.session, { sanity: new SanityEngine(beforeSanity.maxSAN) })).toThrow(TypeError);
      expect(built.session.getSanity()).toEqual(beforeSanity);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const committed = commitAndRestore(built.session, built, compiledMechanicsAction(ids.parent), "discover-parent");
      const current = committed.current;
      expect(current.getCompiledMechanicsState()).toEqual(committed.committed.response.action.compiled as any);
      expect(current.getCompiledMechanicsState()?.trace).toEqual(committed.committed.snapshot?.trace);
      expect(current.getPlayerHistory("p1").messages.map((message) => ({ speaker: message.speaker, content: message.content, type: message.type }))).toEqual(committed.committed.response.action.events as any);
      expect(current.getCharacterSummary()).toMatchObject({ name: "Ada" });
      expect(current.getSanity()).toEqual(built.session.getSanity());
      expect(current.getPlayerHistory("p1").total).toBe(2);
      expect(current.getCompiledGeneration()).toBe(1);
      const raw = built.snapshots.read(current.id);
      expect(raw.status).toBe("ok");
      if (raw.status === "ok") {
        const snapshot = raw.value as CompiledSessionSnapshot;
        expect(snapshot.bundle).toEqual(expect.objectContaining({ id: built.bundleId, bundleHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
        expect(JSON.stringify(snapshot)).not.toContain("projectionArtifactHash");
        expect(snapshot.previousSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a loaded catalog bundle whose declared bundle hash was forged before generation-zero installation", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
      const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const loaded = catalog.loadBundle(saved.value.id);
      if (loaded.status !== "ok") throw new Error(loaded.message);
      const forged = structuredClone(loaded.value);
      forged.bundleHash = "0".repeat(64);
      const host = createCompiledDurableTestHost();
      const session = new GameSession(
        "forged-catalog-bundle", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", host.runtimeDependencies,
      );

      expect(session.loadDurableCompiledModule(forged).status).toBe("refused");
      expect(session.getCompiledGeneration()).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("binds generation, round, contiguous idempotency records, and every stored response to replayed player edges", async () => {
    const dir = root();
    const originalRandom = Math.random;
    try {
      const built = await durableSession(dir);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      let current = built.session;
      Math.random = () => 0.99;
      for (const [index, id] of [ids.parent, ids.entry, ids.child, ids.child, ids.child, ids.exit].entries()) {
        current = commitAndRestore(current, built, compiledMechanicsAction(id), `step-${index}`).current;
      }
      const raw = built.snapshots.read(current.id);
      expect(raw.status).toBe("ok");
      if (raw.status === "ok") {
        const snapshot = raw.value as CompiledSessionSnapshot;
        expect(snapshot.generation).toBe(6);
        expect(snapshot.round).toBe(6);
        expect(snapshot.idempotency.map((record) => [record.expectedGeneration, record.generation])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]);
        expect(snapshot.idempotency.at(-1)?.response.action.compiled).toMatchObject({ generation: 6, terminalEnding: { id: "clean" } });
      }
      expect(current.getCompiledMechanicsState()?.state.terminalEndingId).toBe("clean");
    } finally {
      Math.random = originalRandom;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a rehashed duplicate idempotency actionId before restore can fold an earlier retry", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "duplicate-action-id-ledger");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const first = commitAndRestore(built.session, built, compiledMechanicsAction(ids.parent), "first-action-id");
      const second = commitAndRestore(first.current, built, compiledMechanicsAction(ids.entry), "descendant-action-id");
      const raw = built.snapshots.read(second.current.id);
      expect(raw.status).toBe("ok");
      if (raw.status !== "ok") return;

      const forged = structuredClone(raw.value as CompiledSessionSnapshot);
      expect(forged.idempotency).toHaveLength(2);
      const firstRecord = forged.idempotency[0]!;
      const descendantRecord = forged.idempotency[1]!;
      descendantRecord.actionId = firstRecord.actionId;
      descendantRecord.requestHash = sha256(canonicalJson({
        domain: "compiled-action-v1",
        input: descendantRecord.input,
        pcId: "p1",
        actionId: descendantRecord.actionId,
        expectedGeneration: descendantRecord.expectedGeneration,
      }));
      rehash(forged);
      expect(validateCompiledSessionSnapshot(forged).status).toBe("refused");

      const bundle = built.catalog.loadBundle(built.bundleId);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const targetHost = createCompiledDurableTestHost();
      const target = new GameSession(
        built.session.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", targetHost.runtimeDependencies,
      );
      compiledDurableHosts.set(target, targetHost);
      const before = {
        summary: target.getSummary(),
        character: target.getCharacterSummary(),
        state: target.getState(),
        world: target.world.exportSnapshot(),
        history: target.getPlayerHistory("p1"),
      };
      try {
        const restored = target.restoreCompiledSession(forged, bundle.value);
        // Before the uniqueness guard, this loads then `new Map(actionId)`
        // overwrites generation 1. Retrying that original request therefore
        // cannot return its persisted response.
        if (restored.status === "loaded") {
          expect(hostFor(target).commit(target, firstRecord.input, firstRecord.actionId, firstRecord.expectedGeneration, () => {
            throw new Error("a duplicate retry must not persist");
          })).toEqual({
            status: "duplicate",
            response: firstRecord.response,
            generation: firstRecord.generation,
          });
        }
        expect(restored.status).toBe("refused");
        expect(target.getCompiledGeneration()).toBeNull();
        expect(target.getSummary()).toEqual(before.summary);
        expect(target.getCharacterSummary()).toEqual(before.character);
        expect(target.getState()).toEqual(before.state);
        expect(target.world.exportSnapshot()).toEqual(before.world);
        expect(target.getPlayerHistory("p1")).toEqual(before.history);
      } finally {
        target.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a rehashed whitespace-padded idempotency actionId before restore", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "whitespace-action-id-ledger");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const committed = commitAndRestore(built.session, built, compiledMechanicsAction(ids.parent), "trimmed-action-id");
      const raw = built.snapshots.read(committed.current.id);
      expect(raw.status).toBe("ok");
      if (raw.status !== "ok") return;

      const forged = structuredClone(raw.value as CompiledSessionSnapshot);
      const record = forged.idempotency[0]!;
      record.actionId = ` \t${record.actionId}\n`;
      record.requestHash = sha256(canonicalJson({
        domain: "compiled-action-v1",
        input: record.input,
        pcId: "p1",
        actionId: record.actionId,
        expectedGeneration: record.expectedGeneration,
      }));
      rehash(forged);
      expect(validateCompiledSessionSnapshot(forged).status).toBe("refused");

      const bundle = built.catalog.loadBundle(built.bundleId);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const targetHost = createCompiledDurableTestHost();
      const target = new GameSession(
        built.session.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", targetHost.runtimeDependencies,
      );
      compiledDurableHosts.set(target, targetHost);
      const before = {
        summary: target.getSummary(),
        character: target.getCharacterSummary(),
        state: target.getState(),
        world: target.world.exportSnapshot(),
        history: target.getPlayerHistory("p1"),
      };
      try {
        expect(target.restoreCompiledSession(forged, bundle.value).status).toBe("refused");
        expect(target.getCompiledGeneration()).toBeNull();
        expect(target.getSummary()).toEqual(before.summary);
        expect(target.getCharacterSummary()).toEqual(before.character);
        expect(target.getState()).toEqual(before.state);
        expect(target.world.exportSnapshot()).toEqual(before.world);
        expect(target.getPlayerHistory("p1")).toEqual(before.history);
      } finally {
        target.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // This matrix restores 16 forged durable snapshots; 15s is a test scheduler budget, not a production latency SLO.
  it("rejects rehashed generation, round, ledger, response, character, SAN, and bundle forgeries before world writes", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      commitAndRestore(built.session, built, compiledMechanicsAction(ids.parent), "forgery");
      const raw = built.snapshots.read(built.session.id);
      expect(raw.status).toBe("ok");
      if (raw.status !== "ok") return;
      const cases: Array<(snapshot: CompiledSessionSnapshot) => void> = [
        (snapshot) => { snapshot.generation = 9; },
        (snapshot) => { snapshot.round = 0; },
        (snapshot) => { snapshot.idempotency[0]!.expectedGeneration = 4; },
        (snapshot) => { snapshot.trace[0]!.mechanismId = "forged-mechanism"; },
        (snapshot) => { (snapshot.idempotency[0]!.response as any).action = null; },
        (snapshot) => { (snapshot.idempotency[0]!.response.action as any).extra = true; },
        (snapshot) => { (snapshot.idempotency[0]!.response.summary as any).scene = "forged-scene"; },
        (snapshot) => { (snapshot.idempotency[0]!.response.summary as any).messageCount = 999; },
        (snapshot) => { (snapshot.idempotency[0]!.response.summary as any).npcCount = 1; },
        (snapshot) => { (snapshot.idempotency[0]!.response.action.state as any).player.hp = 1; },
        (snapshot) => { (snapshot.idempotency[0]!.response.action.state as any).gameTime.day = 99; },
        (snapshot) => { delete (snapshot.character.sheet.attributes as any).power; },
        (snapshot) => { (snapshot.character.sanity as any).currentSAN = 101; },
        (snapshot) => { (snapshot.character.sanity as any).mythosLog = [{ source: 1, gain: "x", maxSanLoss: null }]; },
        (snapshot) => { (snapshot.character.sheet as any).unsupported = true; },
        (snapshot) => { snapshot.bundle.bundleHash = "a".repeat(64); },
      ];
      for (const mutate of cases) {
        const forged = rehash(structuredClone(raw.value as CompiledSessionSnapshot));
        mutate(forged);
        rehash(forged);
        const targetHost = createCompiledDurableTestHost();
        const target = new GameSession(
          built.session.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", targetHost.runtimeDependencies,
        );
        const worldBefore = target.world.exportSnapshot();
        const bundle = built.catalog.loadBundle(built.bundleId);
        if (bundle.status !== "ok") throw new Error(bundle.message);
        expect(target.restoreCompiledSession(forged, bundle.value).status).toBe("refused");
        expect(target.world.exportSnapshot()).toEqual(worldBefore);
        target.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15_000);

  it("requires the durable action transaction and preserves p1 as the only mutating actor", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const before = built.session.getCompiledMechanicsState();
      expect((await built.session.act(compiledMechanicsAction(ids.parent), "p1")).error?.code).toBe("compiled_action_contract_required");
      expect(built.session.getCompiledMechanicsState()).toEqual(before);
      expect(built.session.addPartyMember("Beth", "investigator")).toEqual({ rejected: "compiled_mutation_unsupported" });
      expect(Reflect.get(built.session, "setScene")).toBeUndefined();
      expect(built.session.setPlayerSan("p1", 1)).toMatchObject({ ok: false });
      const transaction = await runDurableAction(built.session, { input: compiledMechanicsAction(ids.parent), pcId: "p1", actionId: "http-parent", expectedGeneration: 0 }, (snapshot) => {
        const saved = built.snapshots.save(snapshot);
        if (saved.status !== "ok") throw new Error(saved.message);
      }, (snapshot) => restoreFresh(built, snapshot));
      expect(transaction).toMatchObject({ status: 200, body: { generation: 1 } });
      const duplicate = await runDurableAction(transaction.session!, { input: compiledMechanicsAction(ids.parent), pcId: "p1", actionId: "http-parent", expectedGeneration: 0 }, undefined, (snapshot) => restoreFresh(built, snapshot));
      expect(duplicate).toEqual(expect.objectContaining({ status: 200, body: transaction.body }));
      const conflict = await runDurableAction(transaction.session!, { input: compiledMechanicsAction(ids.parent), pcId: "p1", actionId: "http-parent", expectedGeneration: 1 }, undefined, (snapshot) => restoreFresh(built, snapshot));
      expect(conflict).toMatchObject({ status: 409, body: { code: "compiled_idempotency_conflict", generation: 1 } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("persists the exact checked-action dice and line for HTTP retries before and after restart", async () => {
    const dir = root();
    const originalRandom = Math.random;
    try {
      const built = await durableSession(dir, "compiledrestart", (snapshot) => {
        // A compiled check reads its persisted p1 sheet. Seed this setup before
        // generation zero is snapshotted through the ordinary portable boundary;
        // the public activeCharacter view is deliberately not a compiled authority seam.
        setSnapshotP1Skill(snapshot, "library_use", 80);
      });
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      let current = commitAndRestore(built.session, built, compiledMechanicsAction(ids.parent), "checked-parent").current;
      current = commitAndRestore(current, built, compiledMechanicsAction(ids.entry), "checked-entry").current;
      Math.random = () => 0.99;
      const body = { input: compiledMechanicsAction(ids.child), pcId: "p1", actionId: "checked-failure", expectedGeneration: 2 };
      const first = await runDurableAction(current, body, (snapshot) => {
        const saved = built.snapshots.save(snapshot);
        if (saved.status !== "ok") throw new Error(saved.message);
      }, (snapshot) => restoreFresh(built, snapshot));
      expect(first).toMatchObject({
        status: 200,
        body: {
          generation: 3,
          dice: [{ expr: "d100", total: 100, detail: "library_use/hard" }],
          events: expect.arrayContaining([{ speaker: "系统", content: "🎲 library_use hard 检定 d100=100 (目标=80%) → 失败", type: "system" }]),
          compiled: { trace: expect.arrayContaining([expect.objectContaining({ mechanismId: ids.child, outcome: "failure" })]) },
        },
      });
      const duplicate = await runDurableAction(first.session!, body, undefined, (snapshot) => restoreFresh(built, snapshot));
      expect(duplicate).toEqual(expect.objectContaining({ status: 200, body: first.body }));
      const restarted = restoreFresh(built);
      const duplicateAfterRestart = await runDurableAction(restarted, body, undefined, (snapshot) => restoreFresh(built, snapshot));
      expect(duplicateAfterRestart).toEqual(expect.objectContaining({ status: 200, body: first.body }));

      const raw = built.snapshots.read(built.session.id);
      expect(raw.status).toBe("ok");
      if (raw.status !== "ok") return;
      const mutations: Array<(snapshot: CompiledSessionSnapshot) => void> = [
        (snapshot) => { ((snapshot.idempotency.at(-1)!.response.action as any).dice[0] as any).total = 1; },
        (snapshot) => { ((snapshot.idempotency.at(-1)!.response.action as any).events[1] as any).content = "🎲 library_use hard 检定 d100=100 (目标=81%) → 失败"; },
        (snapshot) => { ((snapshot.idempotency.at(-1)!.response.action as any).events[1] as any).content = "🎲 library_use hard 检定 d100=100 (目标=80%) → 成功"; },
      ];
      for (const mutate of mutations) {
        const forged = rehash(structuredClone(raw.value as CompiledSessionSnapshot));
        mutate(forged);
        rehash(forged);
        const targetHost = createCompiledDurableTestHost();
        const target = new GameSession(
          built.session.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", targetHost.runtimeDependencies,
        );
        const worldBefore = target.world.exportSnapshot();
        const bundle = built.catalog.loadBundle(built.bundleId);
        if (bundle.status !== "ok") throw new Error(bundle.message);
        expect(target.restoreCompiledSession(forged, bundle.value).status).toBe("refused");
        expect(target.world.exportSnapshot()).toEqual(worldBefore);
        target.close();
      }
    } finally {
      Math.random = originalRandom;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed after persistence until the server installs a fresh replay-validated object, then supports a retry", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const result = await runDurableAction(built.session, { input: compiledMechanicsAction(ids.parent), pcId: "p1", actionId: "install-failure", expectedGeneration: 0 }, (snapshot) => {
        const saved = built.snapshots.save(snapshot);
        if (saved.status !== "ok") throw new Error(saved.message);
      }, () => { throw new Error("setScene install failure"); });
      expect(result).toMatchObject({ status: 500, body: { code: "compiled_unavailable", generation: 1 } });
      expect((await built.session.act(compiledMechanicsAction(ids.parent))).error?.code).toBe("compiled_unavailable");
      const fresh = restoreFresh(built);
      const retry = await runDurableAction(fresh, { input: compiledMechanicsAction(ids.parent), pcId: "p1", actionId: "install-failure", expectedGeneration: 0 }, undefined, (snapshot) => restoreFresh(built, snapshot));
      expect(retry).toMatchObject({ status: 200, body: { generation: 1 } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails closed for post-persist scene, world, SAN, and history installation faults without exposing a split-generation object", async () => {
    const dir = root();
    try {
      for (const label of ["scene", "world", "san", "history"] as const) {
        const built = await durableSession(dir, `fault-${label}`);
        const ids = methodIds(built.fixture.resolved.artifact.payload);
        const result = await runDurableAction(built.session, { input: compiledMechanicsAction(ids.parent), pcId: "p1", actionId: `fault-${label}`, expectedGeneration: 0 }, (snapshot) => {
          const saved = built.snapshots.save(snapshot);
          if (saved.status !== "ok") throw new Error(saved.message);
        }, (snapshot) => {
          const replacementHost = createCompiledDurableTestHost();
          const replacement = new GameSession(
            snapshot.sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", replacementHost.runtimeDependencies,
          );
          compiledDurableHosts.set(replacement, replacementHost);
          const restoreFault = label === "scene"
            ? patchGameSessionWorldMethod(replacement, "setActiveScene", () => false)
            : label === "world"
              ? patchGameSessionWorldMethod(replacement, "upsertEntity", () => { throw new Error("world mirror failed"); })
              : label === "san"
                ? patchGameSessionWorldMethod(replacement, "setPlayerSanity", () => { throw new Error("SAN persistence failed"); })
                : (() => {
                  const original = (replacement.session as any).restoreSinglePlayer;
                  (replacement.session as any).restoreSinglePlayer = () => { throw new Error("history publication failed"); };
                  return () => { (replacement.session as any).restoreSinglePlayer = original; };
                })();
          try {
            const bundle = built.catalog.loadBundle(built.bundleId);
            if (bundle.status !== "ok") throw new Error(bundle.message);
            const restored = replacement.restoreCompiledSession(snapshot, bundle.value);
            if (restored.status === "refused") throw new Error(restored.message);
            return replacement;
          } finally {
            restoreFault();
          }
        });
        expect(result).toMatchObject({ status: 500, body: { code: "compiled_unavailable", generation: 1 } });
        expect(result.session).toBeUndefined();
        expect((await built.session.act(compiledMechanicsAction(ids.parent))).error?.code).toBe("compiled_unavailable");
        expect(restoreFresh(built).getCompiledGeneration()).toBe(1);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 10_000);

  it("rolls back a failed restore on the same target before allowing a retry", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "restore-atomicity");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const committed = built.host.commit(built.session, compiledMechanicsAction(ids.parent), "restore-atomicity-parent", 0, (snapshot) => {
        const saved = built.snapshots.save(snapshot);
        if (saved.status !== "ok") throw new Error(saved.message);
      });
      if (committed.status !== "committed") throw new Error("compiled action did not commit");

      const bundle = built.catalog.loadBundle(built.bundleId);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const targetHost = createCompiledDurableTestHost();
      const target = new GameSession(
        built.session.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", targetHost.runtimeDependencies,
      );
      const before = {
        summary: target.getSummary(),
        character: target.getCharacterSummary(),
        state: target.getState(),
        scenes: target.world.listScenes(),
        history: target.getPlayerHistory("p1"),
      };
      const restoreSetActiveScene = patchGameSessionWorldMethod(target, "setActiveScene", () => false);
      try {
        expect(target.restoreCompiledSession(committed.snapshot, bundle.value).status).toBe("refused");
        expect(target.getCompiledMechanicsState()).toBeNull();
        expect(target.getCompiledGeneration()).toBeNull();
        expect(target.getSummary()).toEqual(before.summary);
        expect(target.getCharacterSummary()).toEqual(before.character);
        expect(target.getState()).toEqual(before.state);
        expect(target.world.listScenes()).toEqual(before.scenes);
        expect(target.getPlayerHistory("p1")).toEqual(before.history);
      } finally {
        restoreSetActiveScene();
      }
      expect(target.restoreCompiledSession(committed.snapshot, bundle.value).status).toBe("loaded");
      expect(target.getCompiledGeneration()).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses monotonic immutable bodies and bounded headers without replacing a newer snapshot", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir);
      const initial = built.snapshots.read(built.session.id);
      expect(initial.status).toBe("ok");
      if (initial.status !== "ok") return;
      expect(built.snapshots.read(built.session.id)).toMatchObject({ status: "ok" });
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const committed = commitAndRestore(built.session, built, compiledMechanicsAction(ids.parent), "monotonic");
      expect(built.snapshots.save(initial.value)).toMatchObject({ status: "refused", code: "SNAPSHOT_CONFLICT" });
      const header = built.snapshots.listHeaders();
      expect(header).toHaveLength(1);
      expect(header[0]).toMatchObject({ status: "ok", value: { sessionId: built.session.id, generation: 1, fileName: `${built.session.id}.header.json` } });
      const current = built.snapshots.read(built.session.id);
      expect(current.status).toBe("ok");
      if (current.status === "ok") expect((current.value as CompiledSessionSnapshot).snapshotHash).toBe(committed.committed.snapshot!.snapshotHash);

      const capture = await durableSession(dir, "capture");
      const captured = capture.host.commit(capture.session, compiledMechanicsAction(ids.parent), "capture", 0, () => undefined);
      expect(captured).toMatchObject({ status: "committed" });
      if (captured.status !== "committed") return;
      const failingStore = new CompiledSessionSnapshotStore({
        root: capture.snapshots.root,
        fileOps: { ...compiledSessionSnapshotNodeFileOps, writeReplace: () => { throw new Error("header replacement failed"); } },
      });
      // A throwing replace may have published before reporting failure. It is
      // therefore recoverable ambiguity, never a normal refusal that would
      // invite an unsafe re-execution.
      expect(failingStore.save(captured.snapshot!)).toMatchObject({ status: "indeterminate", code: "SNAPSHOT_INDETERMINATE" });
      expect(capture.snapshots.read(capture.session.id)).toMatchObject({ status: "ok", value: expect.objectContaining({ generation: 0 }) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("hydrates entries independently, keeps unavailable sessions out of resumable memory, and expires compiled sessions from memory only", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "validrestart");
      writeFileSync(join(built.snapshots.root, "broken.header.json"), "{");
      const registry = new Map<string, GameSession>();
      const diagnostics = new Map<string, { id: string; code: string; message: string }>();
      const hydrationHost = createCompiledDurableTestHost();
      const hydrated = hydrateCompiledSessions({
        sessions: registry,
        diagnostics,
        catalog: built.catalog,
        snapshots: built.snapshots,
        compiledDurableHostCapability: hydrationHost.capability,
        createSession: (id, runtimeDependencies) => {
          const session = new GameSession(
            id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", runtimeDependencies,
          );
          compiledDurableHosts.set(session, hydrationHost);
          return session;
        },
      });
      expect(hydrated.hydrated).toEqual(["validrestart"]);
      expect(hydrated.unavailable).toContainEqual(expect.objectContaining({ id: "broken" }));
      expect(registry.has("broken")).toBe(false);
      const listed = partitionSessionListings(registry.values(), [{ id: "metadata-only", createdAt: 1, ruleset: "cosmic-horror", playerName: "Ada", scene: "entry", bundleId: "aaaaaaaaaaaaaaaaaaaaaaaa" }], diagnostics.values());
      expect(listed.sessions.map((session) => session.id)).toEqual(["validrestart"]);
      expect(listed.unavailable.map((entry) => entry.id)).toContain("metadata-only");
      expect(listed.unavailable.map((entry) => entry.id)).toContain("broken");

      const live = registry.get("validrestart")!;
      const cleanupNow = live.lastActiveAt + 11;
      const deleted: string[] = [];
      expect(cleanupExpiredSessions(registry, { now: cleanupNow, timeoutMs: 10, deleteMetadata: (id) => deleted.push(id), isDurableCompiled: (session) => session instanceof GameSession && session.isDurableCompiledSession() })).toEqual(["validrestart"]);
      expect(deleted).toEqual([]);
      expect(built.snapshots.read("validrestart")).toMatchObject({ status: "ok" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("isolates a closed durable entry so it cannot block a readable listing peer", async () => {
    const dir = root();
    try {
      const closed = await durableSession(dir, "closed-listing");
      const readable = new GameSession("readable-listing", "cosmic-horror", CONFIG);
      closed.session.close();

      const listed = partitionSessionListings([closed.session, readable], [], []);
      expect(listed.sessions.map((session) => session.id)).toEqual(["readable-listing"]);
      expect(listed.unavailable).toContainEqual({
        id: "closed-listing",
        code: "session_unavailable",
        message: "session is unavailable",
      });
      readable.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // This deliberately exercises two durable catalogs and repeated local
  // commit -> snapshot -> fresh-rehydration cycles. On Windows under the full
  // suite's concurrent file load, those bounded filesystem round trips can
  // exceed Bun's 5 s default without indicating a stalled replay.
  it("keeps state-limit and terminal replay behavior stable across a fresh rehydration", async () => {
    const dir = root();
    const uninterruptedDir = root();
    const originalRandom = Math.random;
    try {
      const built = await durableSession(dir);
      const uninterruptedBuilt = await durableSession(uninterruptedDir);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      Math.random = () => 0.99;
      let current = commitAndRestore(built.session, built, compiledMechanicsAction(ids.parent), "a").current;
      current = commitAndRestore(current, built, compiledMechanicsAction(ids.entry), "b").current;
      current = commitAndRestore(current, built, compiledMechanicsAction(ids.child), "c").current;
      const restarted = restoreFresh(built);
      let uninterrupted = commitAndRestore(uninterruptedBuilt.session, uninterruptedBuilt, compiledMechanicsAction(ids.parent), "a").current;
      uninterrupted = commitAndRestore(uninterrupted, uninterruptedBuilt, compiledMechanicsAction(ids.entry), "b").current;
      uninterrupted = commitAndRestore(uninterrupted, uninterruptedBuilt, compiledMechanicsAction(ids.child), "c").current;
      uninterrupted = commitAndRestore(uninterrupted, uninterruptedBuilt, compiledMechanicsAction(ids.child), "d").current;
      const resumed = commitAndRestore(restarted, built, compiledMechanicsAction(ids.child), "d").current;
      expect(resumed.getCompiledMechanicsState()).toEqual(uninterrupted.getCompiledMechanicsState());
      expect(resumed.getCompiledGeneration()).toBe(uninterrupted.getCompiledGeneration());
      expect(mechanicsStateHash(resumed.getCompiledMechanicsState()!.state)).toBe(mechanicsStateHash(uninterrupted.getCompiledMechanicsState()!.state));
    } finally {
      Math.random = originalRandom;
      rmSync(dir, { recursive: true, force: true });
      rmSync(uninterruptedDir, { recursive: true, force: true });
    }
  }, 10_000);

  it("proves a fresh Worker module can hydrate, retry the stored action, continue, and preserve terminal narration", async () => {
    const dir = root();
    const uninterruptedDir = root();
    const originalRandom = Math.random;
    try {
      const built = await durableSession(dir, "freshprocess");
      const baseline = await durableSession(uninterruptedDir, "uninterrupted");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      Math.random = () => 0.99;
      let processA = built.session;
      for (const [index, input] of [ids.parent, ids.entry, ids.child, ids.child, ids.child].entries()) {
        processA = commitAndRestore(processA, built, compiledMechanicsAction(input), `fresh-${index}`).current;
      }
      let uninterrupted = baseline.session;
      for (const [index, input] of [ids.parent, ids.entry, ids.child, ids.child, ids.child, ids.exit].entries()) {
        uninterrupted = commitAndRestore(uninterrupted, baseline, compiledMechanicsAction(input), `fresh-${index}`).current;
      }
      const proof = await runFreshWorkerRestartProof({
        root: dir,
        sessionId: "freshprocess",
        duplicateInput: compiledMechanicsAction(ids.child),
        duplicateActionId: "fresh-2",
        expectedGeneration: 2,
        nextInput: compiledMechanicsAction(ids.exit),
        nextActionId: "fresh-5",
        nextExpectedGeneration: 5,
      });
      expect(proof.ordering).toEqual(["header", "catalog", "body", "restore"]);
      const persisted = built.snapshots.read("freshprocess");
      expect(persisted.status).toBe("ok");
      if (persisted.status !== "ok") return;
      const checkedResponse = (persisted.value as CompiledSessionSnapshot).idempotency.find((record) => record.actionId === "fresh-2")!.response;
      expect(proof.duplicate as any).toEqual({ ...checkedResponse.action, summary: checkedResponse.summary, generation: checkedResponse.generation });
      expect((proof.duplicate as any).dice).toMatchObject([{ expr: "d100", total: expect.any(Number), detail: "library_use/hard" }]);
      expect(proof.duplicate.generation).toBe(3);
      expect(proof.continued).toMatchObject({ generation: 6, narrative: "ending:rule_clean", compiled: { stateHash: uninterrupted.getCompiledMechanicsState()!.stateHash, terminalEnding: { id: "clean" } } });
      expect(proof.history).toBeGreaterThan(0);
    } finally {
      Math.random = originalRandom;
      rmSync(dir, { recursive: true, force: true });
      rmSync(uninterruptedDir, { recursive: true, force: true });
    }
  }, 15_000);
});
