import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession, compiledMechanicsAction, type CompiledActionCommitResult } from "../api/game-session";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { cleanupExpiredSessions } from "../api/server";
import { createCompiledCthulhuWorldModelBinding } from "../world/compiled-world-model-scope";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost, type CompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const DATASET_ROOT = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";

function root(): string {
  return mkdtempSync(join(tmpdir(), "compiled-runtime-authority-"));
}

function methodIds(payload: any) {
  return {
    parent: payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id,
    entry: payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "entry_archive")!.id,
  };
}

async function durableSession(dir: string, id: string) {
  const fixture = await compiledModuleHttpFixture(`runtime-authority-${id}`);
  const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
  const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  const bundle = catalog.loadBundle(saved.value.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const host = createCompiledDurableTestHost();
  const session = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", host.runtimeDependencies);
  expect(session.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
  const snapshots = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots"), allowUncoordinatedTestWrites: true });
  const initial = host.snapshot(session);
  const stored = snapshots.save(initial);
  if (stored.status !== "ok") throw new Error(stored.message);
  host.acknowledge(session, initial);
  return { fixture, catalog, bundle: bundle.value, session, snapshots, host };
}

function restore(
  id: string,
  dir: string,
  snapshot: unknown,
  bundle: Awaited<ReturnType<typeof durableSession>>["bundle"],
  host = createCompiledDurableTestHost(),
): GameSession {
  const target = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", host.runtimeDependencies);
  expect(target.restoreCompiledSession(snapshot, bundle).status).toBe("loaded");
  return target;
}

function compiledMutationGuardView(session: GameSession, host: CompiledDurableTestHost) {
  return structuredClone({
    generation: session.getCompiledGeneration(),
    state: session.getState(),
    mechanics: session.getCompiledMechanicsState(),
    world: session.world.getCurrentState(),
    history: session.getPlayerHistory("p1"),
    snapshot: host.snapshot(session),
  });
}

async function nonPristineOrdinaryTarget(id: string): Promise<GameSession> {
  const session = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada");
  const response = await session.act("/help");
  if (response.state.round === 0) {
    session.close();
    throw new Error("non-pristine target fixture must consume a real ordinary round");
  }
  return session;
}

function ordinaryRestoreTargetView(session: GameSession) {
  return structuredClone({
    state: session.getState(),
    history: session.getPlayerHistory("p1"),
    terminal: session.getOrdinaryTerminal(),
    snapshot: session.exportOrdinarySessionSnapshot(),
  });
}

describe("GameSession compiled runtime authority", () => {
  it("ignores public compiledModule shadows for ordinary and loaded sessions", async () => {
    const ordinary = new GameSession("ordinary-compiled-shadow", "cosmic-horror", CONFIG, "investigator", "Ada");
    (ordinary as any).compiledModule = { state: { terminalLoss: true } };
    expect(ordinary.getCompiledGeneration()).toBeNull();
    expect(ordinary.exportOrdinarySessionSnapshot().session.id).toBe("ordinary-compiled-shadow");

    const dir = root();
    try {
      const built = await durableSession(dir, "loaded-compiled-shadow");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      Object.defineProperty(built.session, "compiledModule", { value: undefined, writable: true, configurable: true });
      expect(built.session.getCompiledGeneration()).toBe(0);
      expect(built.session.getCompiledAvailableActions().map((action) => action.mechanismId)).toEqual([ids.parent]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the canonical generation for observation and expected-generation adjudication", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "generation-shadow");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      (built.session as any).compiledGeneration = 41;
      Object.defineProperty(built.session, "compiledGeneration", { value: 73, writable: true, configurable: true });
      let persisted = 0;
      expect(built.session.getCompiledGeneration()).toBe(0);
      expect(built.host.commit(built.session, compiledMechanicsAction(ids.parent), "forged-generation", 73, () => { persisted += 1; }))
        .toEqual(expect.objectContaining({ status: "refused", code: "compiled_generation_conflict", generation: 0 }));
      expect(persisted).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps restored committed action IDs authoritative despite a replacement public idempotency map", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "idempotency-shadow");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      let snapshot: unknown;
      let persisted = 0;
      const first = built.host.commit(built.session, compiledMechanicsAction(ids.parent), "reused-action-id", 0, (candidate) => {
        persisted += 1;
        const stored = built.snapshots.save(candidate);
        if (stored.status !== "ok") throw new Error(stored.message);
        snapshot = candidate;
      });
      expect(first.status).toBe("committed");
      const restoredHost = createCompiledDurableTestHost();
      const restored = restore("idempotency-shadow", dir, snapshot, built.bundle, restoredHost);
      (restored as any).compiledIdempotency = new Map([["decoy", {}]]);
      (restored as any).compiledIdempotency.clear();
      Object.defineProperty(restored, "compiledIdempotency", { value: new Map(), writable: true, configurable: true });
      const replay = restoredHost.commit(restored, compiledMechanicsAction(ids.entry), "reused-action-id", 1, (candidate) => {
        persisted += 1;
        const stored = built.snapshots.save(candidate);
        if (stored.status !== "ok") throw new Error(stored.message);
      });
      expect(replay).toEqual(expect.objectContaining({ status: "refused", code: "compiled_idempotency_conflict", generation: 1 }));
      expect(persisted).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cannot clear fail-stop through a public shadow after a durable commit", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "fail-stop-shadow");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      let persisted = 0;
      expect(built.host.commit(built.session, compiledMechanicsAction(ids.parent), "first-commit", 0, (candidate) => {
        persisted += 1;
        const stored = built.snapshots.save(candidate);
        if (stored.status !== "ok") throw new Error(stored.message);
      }).status).toBe("committed");
      Object.defineProperty(built.session, "compiledFailStopped", { value: false, writable: true, configurable: true });
      expect(built.host.commit(built.session, compiledMechanicsAction(ids.parent), "stale-object", 0, () => { persisted += 1; }))
        .toEqual(expect.objectContaining({ status: "refused", code: "compiled_unavailable", generation: 0 }));
      expect(persisted).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a public installingCompiledState shadow bypass durable mutation blocking", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "installing-shadow");
      const before = built.session.getState();
      const target = built.fixture.projection.module.scenes.find((scene) => scene.id !== before.scene);
      if (!target) throw new Error("compiled fixture requires a second scene");
      (built.session as any).installingCompiledState = true;
      expect(Reflect.get(built.session, "setScene")).toBeUndefined();
      expect(built.session.getState()).toEqual(before);
      expect(built.session.getCompiledMechanicsState()?.state.currentSceneId).toBe(before.scene);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns only the trusted compiled world-model prompt receipt", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture("receipt-shadow");
      const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
      const binding = createCompiledCthulhuWorldModelBinding({
        moduleId: "receipt-shadow",
        artifactHash: fixture.resolved.artifact.artifactHash,
        datasetRoot: DATASET_ROOT,
        allowedWorkIds: ["the_call_of_cthulhu"],
        transferPolicy: "analogy_only",
      });
      const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection, binding);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const session = new GameSession("receipt-shadow", "cosmic-horror", CONFIG, "investigator", "Ada");
      expect(session.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
      await session.getOpeningScene();
      const receipt = session.getCompiledWorldModelPromptReceipt();
      expect(receipt).toEqual(expect.objectContaining({ scopeHash: binding.scopeHash }));
      Object.defineProperty(session, "compiledWorldModelPromptReceipt", {
        value: { scopeHash: "forged", provenance: [] }, writable: true, configurable: true,
      });
      expect(session.getCompiledWorldModelPromptReceipt()).toEqual(receipt);
      (session as any).compiledWorldModelPromptReceipt = null;
      expect(session.getCompiledWorldModelPromptReceipt()).toEqual(receipt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps compiled ordinary-write isolation after a false same-name guard shadow", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "compiled-mutation-guard-false-shadow");
      const before = compiledMutationGuardView(built.session, built.host);
      const target = built.fixture.projection.module.scenes.find((scene) => scene.id !== before.state.scene);
      if (!target) throw new Error("compiled fixture requires a second scene");
      const nextSan = built.session.getSanity().currentSAN > 0 ? built.session.getSanity().currentSAN - 1 : 1;
      const nextHp = before.state.player.hp > 1 ? before.state.player.hp - 1 : before.state.player.maxHp;
      Object.defineProperty(built.session, "compiledMutationBlocked", {
        configurable: true,
        value: () => false,
      });

      const outcomes = {
        party: built.session.addPartyMember("Bea", "investigator"),
        sent: built.session.sendMessage("KP", "forged compiled message"),
        san: built.session.setPlayerSan("p1", nextSan),
        hp: built.session.setPlayerHp("p1", nextHp),
        inventory: built.session.setPlayerInventory("p1", ["forged inventory"]),
        scene: Reflect.get(built.session, "setScene"),
        difficulty: built.session.setDifficulty("hard"),
        character: built.session.updateActiveCharacter({ hp: nextHp }),
      };
      built.session.addMessage("KP", "forged direct message");

      expect(outcomes.party).toEqual({ rejected: "compiled_mutation_unsupported" });
      expect(outcomes.sent).toBe(false);
      expect(outcomes.san).toMatchObject({ ok: false, error: { actionId: "compiled_mutation_unsupported" } });
      expect(outcomes.hp).toMatchObject({ ok: false, error: { actionId: "compiled_mutation_unsupported" } });
      expect(outcomes.inventory).toBe(false);
      expect(outcomes.scene).toBeUndefined();
      expect(outcomes.difficulty).toMatchObject({ ok: false, error: { actionId: "compiled_mutation_unsupported" } });
      expect(outcomes.character).toEqual({ status: "refused", code: "compiled_mutation_unsupported" });
      expect(compiledMutationGuardView(built.session, built.host)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps compiled ordinary-write refusals observable when a same-name guard accessor throws", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "compiled-mutation-guard-throwing-shadow");
      const before = compiledMutationGuardView(built.session, built.host);
      const target = built.fixture.projection.module.scenes.find((scene) => scene.id !== before.state.scene);
      if (!target) throw new Error("compiled fixture requires a second scene");
      Object.defineProperty(built.session, "compiledMutationBlocked", {
        configurable: true,
        get: () => { throw new Error("forged compiled mutation guard accessor"); },
      });

      expect(() => built.session.addPartyMember("Bea", "investigator")).not.toThrow();
      expect(() => built.session.addMessage("KP", "forged direct message")).not.toThrow();
      expect(() => built.session.sendMessage("KP", "forged sent message")).not.toThrow();
      expect(() => built.session.setPlayerSan("p1", 1)).not.toThrow();
      expect(Reflect.get(built.session, "setScene")).toBeUndefined();
      expect(built.session.addPartyMember("Bea", "investigator")).toEqual({ rejected: "compiled_mutation_unsupported" });
      expect(built.session.sendMessage("KP", "forged sent message")).toBe(false);
      expect(built.session.setPlayerSan("p1", 1)).toMatchObject({ ok: false, error: { actionId: "compiled_mutation_unsupported" } });
      expect(Reflect.get(built.session, "setScene")).toBeUndefined();
      expect(compiledMutationGuardView(built.session, built.host)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps durable compiled routing and cleanup canonical after a false public predicate shadow", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "durable-predicate-false-shadow");
      const before = compiledMutationGuardView(built.session, built.host);
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      expect(() => { (built.session as any).isDurableCompiledSession = () => false; }).toThrow(TypeError);
      expect(Reflect.set(built.session as any, "isDurableCompiledSession", () => false)).toBe(false);
      expect(() => Object.defineProperty(built.session, "isDurableCompiledSession", {
        configurable: true,
        value: () => false,
      })).toThrow(TypeError);
      expect(Object.getOwnPropertyDescriptor(built.session, "isDurableCompiledSession"))
        .toMatchObject({ configurable: false, writable: false, enumerable: false });

      const inventory = built.session.setPlayerInventory("p1", ["forged durable predicate inventory"]);
      const action = await built.session.act(compiledMechanicsAction(ids.parent), "p1");
      const registry = new Map([[built.session.id, built.session]]);
      const deleted: string[] = [];

      expect(inventory).toBe(false);
      expect(action.error?.code).toBe("compiled_action_contract_required");
      expect(built.session.isDurableCompiledSession()).toBe(true);
      expect(compiledMutationGuardView(built.session, built.host)).toEqual(before);
      expect(cleanupExpiredSessions(registry, {
        now: built.session.lastActiveAt + 11,
        timeoutMs: 10,
        deleteMetadata: (id) => deleted.push(id),
        isDurableCompiled: (session) => session instanceof GameSession && session.isDurableCompiledSession(),
      })).toEqual([built.session.id]);
      expect(deleted).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a throwing public durable predicate DoS compiled writes or actions", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "durable-predicate-throwing-shadow");
      const before = compiledMutationGuardView(built.session, built.host);
      expect(() => Object.defineProperty(built.session, "isDurableCompiledSession", {
        configurable: true,
        get: () => { throw new Error("forged durable predicate accessor"); },
      })).toThrow(TypeError);

      expect(() => built.session.setPlayerInventory("p1", ["forged durable predicate inventory"])).not.toThrow();
      expect(() => built.session.isDurableCompiledSession()).not.toThrow();
      expect(built.session.setPlayerInventory("p1", ["forged durable predicate inventory"])).toBe(false);
      expect(built.session.isDurableCompiledSession()).toBe(true);
      expect((await built.session.act("look", "p1")).error?.code).toBe("compiled_action_contract_required");
      expect(compiledMutationGuardView(built.session, built.host)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a true pristine-durable-load shadow install a compiled bundle onto a real non-pristine target", async () => {
    const dir = root();
    let target: GameSession | undefined;
    let built: Awaited<ReturnType<typeof durableSession>> | undefined;
    try {
      built = await durableSession(dir, "pristine-durable-load-source");
      target = await nonPristineOrdinaryTarget("pristine-durable-load-target");
      const before = ordinaryRestoreTargetView(target);
      Object.defineProperty(target, "isPristineDurableCompiledSession", { configurable: true, value: () => true });

      expect(target.loadDurableCompiledModule(built.bundle)).toEqual(expect.objectContaining({ status: "refused", code: "COMPILED_SESSION_CONFLICT" }));
      expect(ordinaryRestoreTargetView(target)).toEqual(before);
    } finally {
      target?.close();
      built?.session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a throwing pristine-durable-load shadow DoS the normal conflict refusal", async () => {
    const dir = root();
    let target: GameSession | undefined;
    let built: Awaited<ReturnType<typeof durableSession>> | undefined;
    try {
      built = await durableSession(dir, "pristine-durable-load-throw-source");
      target = await nonPristineOrdinaryTarget("pristine-durable-load-throw-target");
      const before = ordinaryRestoreTargetView(target);
      Object.defineProperty(target, "isPristineDurableCompiledSession", {
        configurable: true,
        get: () => { throw new Error("forged pristine durable-load predicate"); },
      });

      expect(() => target!.loadDurableCompiledModule(built!.bundle)).not.toThrow();
      expect(target.loadDurableCompiledModule(built.bundle)).toEqual(expect.objectContaining({ status: "refused", code: "COMPILED_SESSION_CONFLICT" }));
      expect(ordinaryRestoreTargetView(target)).toEqual(before);
    } finally {
      target?.close();
      built?.session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a true pristine-compiled-restore shadow overwrite a real non-pristine target", async () => {
    const dir = root();
    let target: GameSession | undefined;
    let built: Awaited<ReturnType<typeof durableSession>> | undefined;
    try {
      built = await durableSession(dir, "pristine-compiled-restore-target");
      target = await nonPristineOrdinaryTarget(built.session.id);
      const before = ordinaryRestoreTargetView(target);
      const snapshot = built.host.snapshot(built.session);
      Object.defineProperty(target, "isPristineCompiledRestoreTarget", { configurable: true, value: () => true });

      expect(target.restoreCompiledSession(snapshot, built.bundle)).toEqual(expect.objectContaining({ status: "refused", code: "COMPILED_SESSION_CONFLICT" }));
      expect(ordinaryRestoreTargetView(target)).toEqual(before);
    } finally {
      target?.close();
      built?.session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a throwing pristine-compiled-restore shadow DoS the normal conflict refusal", async () => {
    const dir = root();
    let target: GameSession | undefined;
    let built: Awaited<ReturnType<typeof durableSession>> | undefined;
    try {
      built = await durableSession(dir, "pristine-compiled-restore-throw-target");
      target = await nonPristineOrdinaryTarget(built.session.id);
      const before = ordinaryRestoreTargetView(target);
      const snapshot = built.host.snapshot(built.session);
      Object.defineProperty(target, "isPristineCompiledRestoreTarget", {
        configurable: true,
        get: () => { throw new Error("forged pristine compiled-restore predicate"); },
      });

      expect(() => target!.restoreCompiledSession(snapshot, built!.bundle)).not.toThrow();
      expect(target.restoreCompiledSession(snapshot, built.bundle)).toEqual(expect.objectContaining({ status: "refused", code: "COMPILED_SESSION_CONFLICT" }));
      expect(ordinaryRestoreTargetView(target)).toEqual(before);
    } finally {
      target?.close();
      built?.session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a true pristine-ordinary-restore shadow overwrite a real non-pristine target", async () => {
    const id = "pristine-ordinary-restore-target";
    const source = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada");
    let target: GameSession | undefined;
    try {
      const snapshot = source.exportOrdinarySessionSnapshot();
      target = await nonPristineOrdinaryTarget(id);
      const before = ordinaryRestoreTargetView(target);
      Object.defineProperty(target, "isPristineOrdinaryRestoreTarget", { configurable: true, value: () => true });

      expect(() => target!.restoreOrdinarySessionSnapshot(snapshot)).toThrow("ordinary snapshot restore requires a pristine GameSession target");
      expect(ordinaryRestoreTargetView(target)).toEqual(before);
    } finally {
      target?.close();
      source.close();
    }
  });

  it("does not let a throwing pristine-ordinary-restore shadow DoS the normal conflict refusal", async () => {
    const id = "pristine-ordinary-restore-throw-target";
    const source = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada");
    let target: GameSession | undefined;
    try {
      const snapshot = source.exportOrdinarySessionSnapshot();
      target = await nonPristineOrdinaryTarget(id);
      const before = ordinaryRestoreTargetView(target);
      Object.defineProperty(target, "isPristineOrdinaryRestoreTarget", {
        configurable: true,
        get: () => { throw new Error("forged pristine ordinary-restore predicate"); },
      });

      expect(() => target!.restoreOrdinarySessionSnapshot(snapshot)).toThrow("ordinary snapshot restore requires a pristine GameSession target");
      expect(ordinaryRestoreTargetView(target)).toEqual(before);
    } finally {
      target?.close();
      source.close();
    }
  });

  it("keeps pristine durable load and ordinary/compiled restore paths available", async () => {
    const dir = root();
    let source: GameSession | undefined;
    let loadTarget: GameSession | undefined;
    let ordinaryTarget: GameSession | undefined;
    let compiledTarget: GameSession | undefined;
    let built: Awaited<ReturnType<typeof durableSession>> | undefined;
    try {
      built = await durableSession(dir, "pristine-positive-compiled-source");
      loadTarget = new GameSession("pristine-positive-load", "cosmic-horror", CONFIG, "investigator", "Ada");
      expect(loadTarget.loadDurableCompiledModule(built.bundle)).toMatchObject({ status: "loaded" });

      compiledTarget = restore(built.session.id, dir, built.host.snapshot(built.session), built.bundle);
      expect(compiledTarget.getCompiledGeneration()).toBe(0);

      source = new GameSession("pristine-positive-ordinary", "cosmic-horror", CONFIG, "investigator", "Ada");
      ordinaryTarget = new GameSession(source.id, "cosmic-horror", CONFIG);
      ordinaryTarget.restoreOrdinarySessionSnapshot(source.exportOrdinarySessionSnapshot());
      expect(ordinaryTarget.getState()).toEqual(source.getState());
    } finally {
      compiledTarget?.close();
      ordinaryTarget?.close();
      loadTarget?.close();
      source?.close();
      built?.session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let an own getState projection forge a durable compiled commit response or its restored successor", async () => {
    const dir = root();
    let successor: GameSession | undefined;
    try {
      const built = await durableSession(dir, "compiled-response-state-fake");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const before = built.session.getState();
      let persisted: unknown;
      Object.defineProperty(built.session, "getState", {
        configurable: true,
        value: () => ({ ...before, gameTime: { ...before.gameTime, day: 99 } }),
      });

      const committed = built.host.commit(built.session, compiledMechanicsAction(ids.parent), "response-state-fake", 0, (candidate) => {
        const stored = built.snapshots.save(candidate);
        if (stored.status !== "ok") throw new Error(stored.message);
        persisted = candidate;
      });
      if (committed.status !== "committed") throw new Error("test setup did not commit");
      const action = committed.response.action as unknown as { state: { gameTime: { day: number } } };

      expect(action.state.gameTime.day).toBe(before.gameTime.day);
      expect(persisted).toBeDefined();
      successor = restore("compiled-response-state-fake", dir, persisted, built.bundle);
      expect(successor.getCompiledGeneration()).toBe(1);
      expect(successor.getState().gameTime.day).toBe(before.gameTime.day);
    } finally {
      successor?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a throwing own getState projection DoS a durable compiled commit", async () => {
    const dir = root();
    try {
      const built = await durableSession(dir, "compiled-response-state-throw");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      let persisted = 0;
      Object.defineProperty(built.session, "getState", {
        configurable: true,
        value: () => { throw new Error("forged compiled state projection"); },
      });

      let committed: CompiledActionCommitResult | undefined;
      expect(() => {
        committed = built.host.commit(built.session, compiledMechanicsAction(ids.parent), "response-state-throw", 0, (candidate) => {
          persisted += 1;
          const stored = built.snapshots.save(candidate);
          if (stored.status !== "ok") throw new Error(stored.message);
        });
      }).not.toThrow();
      expect(committed).toMatchObject({ status: "committed", generation: 1 });
      expect(persisted).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [label, projection] of [
    ["fake", (state: ReturnType<GameSession["getState"]>) => ({ ...state, gameTime: { ...state.gameTime, day: 99 } })],
    ["throwing", () => { throw new Error("forged compiled refusal state projection"); }],
  ] as const) {
    it(`does not let a ${label} own getState projection alter or DoS a direct durable-action refusal`, async () => {
      const dir = root();
      try {
        const built = await durableSession(dir, `compiled-refusal-state-${label}`);
        const before = built.session.getState();
        Object.defineProperty(built.session, "getState", {
          configurable: true,
          value: () => projection(before),
        });

        const refusal = await built.session.act("not-a-compiled-action", "p1");

        expect(refusal.error?.code).toBe("compiled_action_contract_required");
        expect(refusal.state.gameTime.day).toBe(before.gameTime.day);
        expect(refusal.state.round).toBe(before.round);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("does not let an own getSummary projection forge a durable compiled receipt or restored successor", async () => {
    const dir = root();
    let successor: GameSession | undefined;
    try {
      const built = await durableSession(dir, "compiled-summary-fake");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      const before = built.session.getSummary();
      const forged = {
        ...before,
        id: "forged-summary-id",
        ruleset: "forged-summary-ruleset",
        playerName: "Forged Summary Player",
        archetype: "forged-summary-archetype",
        createdAt: before.createdAt + 1,
      };
      let persisted: unknown;
      Object.defineProperty(built.session, "getSummary", { configurable: true, value: () => forged });

      const committed = built.host.commit(built.session, compiledMechanicsAction(ids.parent), "compiled-summary-fake", 0, (candidate) => {
        const stored = built.snapshots.save(candidate);
        if (stored.status !== "ok") throw new Error(stored.message);
        persisted = candidate;
      });
      if (committed.status !== "committed") throw new Error("test setup did not commit");
      const receipt = committed.response.summary as unknown as Pick<typeof before, "id" | "ruleset" | "playerName" | "archetype" | "createdAt">;

      expect(receipt).toEqual(expect.objectContaining({
        id: before.id,
        ruleset: before.ruleset,
        playerName: before.playerName,
        archetype: before.archetype,
        createdAt: before.createdAt,
      }));
      expect(persisted).toBeDefined();
      successor = restore("compiled-summary-fake", dir, persisted, built.bundle);
      expect(successor.getCompiledGeneration()).toBe(1);
      expect(successor.getSummary()).toEqual(expect.objectContaining({
        id: before.id,
        ruleset: before.ruleset,
        playerName: before.playerName,
        archetype: before.archetype,
        createdAt: before.createdAt,
      }));
    } finally {
      successor?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a throwing own getSummary projection DoS a durable compiled receipt or persistence", async () => {
    const dir = root();
    let successor: GameSession | undefined;
    try {
      const built = await durableSession(dir, "compiled-summary-throw");
      const ids = methodIds(built.fixture.resolved.artifact.payload);
      let persisted = 0;
      let snapshot: unknown;
      Object.defineProperty(built.session, "getSummary", {
        configurable: true,
        value: () => { throw new Error("forged compiled summary projection"); },
      });

      let committed: CompiledActionCommitResult | undefined;
      expect(() => {
        committed = built.host.commit(built.session, compiledMechanicsAction(ids.parent), "compiled-summary-throw", 0, (candidate) => {
          persisted += 1;
          const stored = built.snapshots.save(candidate);
          if (stored.status !== "ok") throw new Error(stored.message);
          snapshot = candidate;
        });
      }).not.toThrow();
      expect(committed).toMatchObject({ status: "committed", generation: 1 });
      expect(persisted).toBe(1);
      successor = restore("compiled-summary-throw", dir, snapshot, built.bundle);
      expect(successor.getCompiledGeneration()).toBe(1);
    } finally {
      successor?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [label, installDeadShadow] of [
    ["true", (session: GameSession) => Object.defineProperty(session, "dead", { configurable: true, value: true })],
    ["throwing", (session: GameSession) => Object.defineProperty(session, "dead", {
      configurable: true,
      get: () => { throw new Error("forged dead projection"); },
    })],
  ] as const) {
    it(`does not let a ${label} own dead projection forge or DoS a clean ordinary snapshot export`, () => {
      const source = new GameSession(`dead-ordinary-export-${label}`, "cosmic-horror", CONFIG, "investigator", "Ada");
      try {
        installDeadShadow(source);
        let snapshot: ReturnType<GameSession["exportOrdinarySessionSnapshot"]> | undefined;

        expect(() => { snapshot = source.exportOrdinarySessionSnapshot(); }).not.toThrow();
        expect(snapshot?.state.dead).toBe(false);
        expect(snapshot?.state.terminal).toBeNull();
      } finally {
        source.close();
      }
    });

    it(`does not let a ${label} own dead projection reject or DoS a clean ordinary restore target`, () => {
      const id = `dead-ordinary-restore-${label}`;
      const source = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada");
      const target = new GameSession(id, "cosmic-horror", CONFIG);
      try {
        const snapshot = source.exportOrdinarySessionSnapshot();
        installDeadShadow(target);

        expect(() => target.restoreOrdinarySessionSnapshot(snapshot)).not.toThrow();
        expect(target.getState()).toEqual(source.getState());
        expect(target.getOrdinaryTerminal()).toBeNull();
      } finally {
        target.close();
        source.close();
      }
    });

    it(`does not let a ${label} own dead projection reject or DoS a clean durable compiled load target`, async () => {
      const dir = root();
      let target: GameSession | undefined;
      try {
        const built = await durableSession(dir, `dead-durable-load-source-${label}`);
        target = new GameSession(`dead-durable-load-target-${label}`, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers-target") });
        installDeadShadow(target);
        let loaded: ReturnType<GameSession["loadDurableCompiledModule"]> | undefined;

        expect(() => { loaded = target!.loadDurableCompiledModule(built.bundle); }).not.toThrow();
        expect(loaded).toEqual(expect.objectContaining({ status: "loaded" }));
        expect(target.getCompiledGeneration()).toBe(0);
      } finally {
        target?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`does not let a ${label} own dead projection reject or DoS a clean compiled restore target`, async () => {
      const dir = root();
      let target: GameSession | undefined;
      try {
        const built = await durableSession(dir, `dead-compiled-restore-${label}`);
        target = new GameSession(built.session.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers-target") });
        const snapshot = built.host.snapshot(built.session);
        installDeadShadow(target);
        let restored: ReturnType<GameSession["restoreCompiledSession"]> | undefined;

        expect(() => { restored = target!.restoreCompiledSession(snapshot, built.bundle); }).not.toThrow();
        expect(restored).toEqual(expect.objectContaining({ status: "loaded" }));
        expect(target.getCompiledGeneration()).toBe(0);
      } finally {
        target?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("keeps real non-pristine targets closed to ordinary restore and durable/compiled installation despite a false dead shadow", async () => {
    const dir = root();
    let ordinaryTarget: GameSession | undefined;
    let durableTarget: GameSession | undefined;
    let compiledTarget: GameSession | undefined;
    let ordinarySource: GameSession | undefined;
    try {
      ordinarySource = new GameSession("dead-nonpristine-ordinary", "cosmic-horror", CONFIG, "investigator", "Ada");
      ordinaryTarget = await nonPristineOrdinaryTarget(ordinarySource.id);
      const ordinaryBefore = ordinaryRestoreTargetView(ordinaryTarget);
      Object.defineProperty(ordinaryTarget, "dead", { configurable: true, value: false });
      expect(() => ordinaryTarget!.restoreOrdinarySessionSnapshot(ordinarySource!.exportOrdinarySessionSnapshot()))
        .toThrow("ordinary snapshot restore requires a pristine GameSession target");
      expect(ordinaryRestoreTargetView(ordinaryTarget)).toEqual(ordinaryBefore);

      const durableBuilt = await durableSession(dir, "dead-nonpristine-durable");
      durableTarget = await nonPristineOrdinaryTarget("dead-nonpristine-durable-target");
      const durableBefore = ordinaryRestoreTargetView(durableTarget);
      Object.defineProperty(durableTarget, "dead", { configurable: true, value: false });
      expect(durableTarget.loadDurableCompiledModule(durableBuilt.bundle))
        .toEqual(expect.objectContaining({ status: "refused", code: "COMPILED_SESSION_CONFLICT" }));
      expect(ordinaryRestoreTargetView(durableTarget)).toEqual(durableBefore);

      const compiledBuilt = await durableSession(dir, "dead-nonpristine-compiled");
      compiledTarget = await nonPristineOrdinaryTarget(compiledBuilt.session.id);
      const compiledBefore = ordinaryRestoreTargetView(compiledTarget);
      Object.defineProperty(compiledTarget, "dead", { configurable: true, value: false });
      expect(compiledTarget.restoreCompiledSession(compiledBuilt.host.snapshot(compiledBuilt.session), compiledBuilt.bundle))
        .toEqual(expect.objectContaining({ status: "refused", code: "COMPILED_SESSION_CONFLICT" }));
      expect(ordinaryRestoreTargetView(compiledTarget)).toEqual(compiledBefore);
    } finally {
      compiledTarget?.close();
      durableTarget?.close();
      ordinaryTarget?.close();
      ordinarySource?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
