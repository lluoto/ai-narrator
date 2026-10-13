import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acknowledgeCompiledDurableSessionSnapshot,
  commitCompiledDurableAction,
  createCompiledDurableSessionSnapshot,
  GameSession,
} from "../api/game-session";
import { createCompiledSessionAccessBinding } from "../api/compiled-module-http";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { handleRequest } from "../api/server";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

async function durableSessionHarness(root: string, capability: object) {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  const bundle = catalog.loadBundle(saved.value.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const session = new GameSession(
    "compiled-durable-host-authority",
    "cosmic-horror",
    CONFIG,
    "investigator",
    "Ada",
    undefined,
    { careerRoot: join(root, "careers") },
    undefined,
    "preferred",
    { compiledDurableHostCapability: capability },
  );
  const loaded = session.loadDurableCompiledModule(bundle.value, createCompiledSessionAccessBinding(
    { id: "keeper:compiled-durable-host-authority", role: "keeper" },
    { id: "player:compiled-durable-host-authority", role: "player" },
  ));
  if (loaded.status === "refused") throw new Error(loaded.message);
  return { session, bundle: bundle.value };
}

async function durableSession(root: string, capability: object): Promise<GameSession> {
  return (await durableSessionHarness(root, capability)).session;
}

describe("compiled durable host authority", () => {
  it("does not expose durable access secrets or a public snapshot write path", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-durable-host-authority-"));
    const capability = Object.freeze(Object.create(null)) as object;
    let session: GameSession | undefined;
    try {
      session = await durableSession(root, capability);
      const publicSession = session as unknown as Record<string, unknown>;

      expect(publicSession.getCompiledSessionAccessBinding).toBeUndefined();
      expect(publicSession.createCompiledSessionSnapshot).toBeUndefined();
      expect(publicSession.acknowledgeCompiledSnapshot).toBeUndefined();
      expect(publicSession.commitCompiledAction).toBeUndefined();
      const serializablePublicReturns = JSON.stringify([
        session.getSummary(),
        session.getCompiledMechanicsState(),
        session.getCompiledPlayerFacadeView(),
        session.getCompiledAvailableActions(),
      ]);
      expect(serializablePublicReturns).not.toContain("choiceHmacKey");
      expect(serializablePublicReturns).not.toContain("inviteDigest");
    } finally {
      session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects absent or wrong host capability without changing the live durable predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-durable-host-authority-"));
    const host = createCompiledDurableTestHost();
    let session: GameSession | undefined;
    try {
      session = await durableSession(root, host.capability);
      const initial = host.snapshot(session);
      host.acknowledge(session, initial);
      const before = {
        generation: session.getCompiledGeneration(),
        mechanics: session.getCompiledMechanicsState(),
        actions: session.getCompiledAvailableActions(),
      };
      const wrong = Object.freeze(Object.create(null)) as object;

      expect(() => createCompiledDurableSessionSnapshot(session!, wrong)).toThrow("compiled durable host capability is required");
      expect(() => acknowledgeCompiledDurableSessionSnapshot(session!, wrong, initial)).toThrow("compiled durable host capability is required");
      expect(() => commitCompiledDurableAction(session!, wrong, "@compiled forged", "forged", 0, () => undefined)).toThrow("compiled durable host capability is required");
      expect(session.getCompiledGeneration()).toBe(before.generation);
      expect(session.getCompiledMechanicsState()).toEqual(before.mechanics);
      expect(session.getCompiledAvailableActions()).toEqual(before.actions);
    } finally {
      session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not acknowledge a forged hash as a durable predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-durable-host-authority-"));
    const host = createCompiledDurableTestHost();
    let session: GameSession | undefined;
    try {
      session = await durableSession(root, host.capability);
      const initial = host.snapshot(session);
      const forged = { ...initial, snapshotHash: "f".repeat(64) };
      expect(() => host.acknowledge(session!, forged)).toThrow("published snapshot is not the live durable session snapshot");
      const canonical = host.snapshot(session);
      expect(canonical.previousSnapshotHash).toBeNull();
      host.acknowledge(session, canonical);
      const choice = session.getCompiledAvailableActions()[0];
      if (!choice) throw new Error("durable fixture must offer an initial action");
      const successor = host.commit(session, choice.command, "forged-predecessor-proof", 0, () => undefined);
      expect(successor).toMatchObject({ status: "committed", generation: 1 });
      if (successor.status !== "committed" || !successor.snapshot) throw new Error("durable successor was not prepared");
      expect(successor.snapshot.previousSnapshotHash).toBe(canonical.snapshotHash);
      expect(successor.snapshot.previousSnapshotHash).not.toBe(forged.snapshotHash);
    } finally {
      session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps public direct act inert for a durable compiled session", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-durable-host-authority-"));
    const host = createCompiledDurableTestHost();
    let session: GameSession | undefined;
    try {
      session = await durableSession(root, host.capability);
      const initial = host.snapshot(session);
      host.acknowledge(session, initial);
      const before = host.snapshot(session);
      const action = session.getCompiledAvailableActions()[0];
      if (!action) throw new Error("durable fixture must offer an initial action");
      const result = await session.act(action.command);
      expect(result.error?.code).toBe("compiled_action_contract_required");
      expect(host.snapshot(session)).toEqual(before);
    } finally {
      session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps canonical choice resolution and persisted secrets stable across a trusted g0 to g1 restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-durable-host-authority-"));
    const sourceHost = createCompiledDurableTestHost();
    let source: GameSession | undefined;
    let restored: GameSession | undefined;
    let successor: GameSession | undefined;
    try {
      const built = await durableSessionHarness(root, sourceHost.capability);
      source = built.session;
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
      const initial = sourceHost.snapshot(source);
      expect(snapshots.save(initial)).toMatchObject({ status: "ok", value: { generation: 0 } });
      sourceHost.acknowledge(source, initial);
      expect(JSON.stringify(initial)).toContain("choiceHmacKey");

      const g0Choice = source.getCompiledPlayerFacadeView().actions[0];
      if (!g0Choice) throw new Error("durable fixture must expose an initial player choice");
      const g0Input = sourceHost.resolvePlayerChoice(source, g0Choice.choiceId, 0);
      expect(g0Input).toBe(source.getCompiledAvailableActions()[0]?.command);

      const restoredHost = createCompiledDurableTestHost();
      restored = new GameSession(
        source.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(root, "restored-careers") },
        undefined, "preferred", restoredHost.runtimeDependencies,
      );
      expect(restored.restoreCompiledSession(initial, built.bundle).status).toBe("loaded");
      const restoredChoice = restored.getCompiledPlayerFacadeView().actions[0];
      expect(restoredChoice?.choiceId).toBe(g0Choice.choiceId);
      expect(restoredHost.resolvePlayerChoice(restored, g0Choice.choiceId, 0)).toBe(g0Input);

      const committed = restoredHost.commit(restored, g0Input!, "g0-to-g1", 0, (snapshot) => {
        const saved = snapshots.save(snapshot);
        if (saved.status !== "ok") throw new Error(saved.message);
      });
      expect(committed).toMatchObject({ status: "committed", generation: 1 });
      if (committed.status !== "committed" || !committed.snapshot) throw new Error("trusted host did not commit g1");
      expect(committed.snapshot.previousSnapshotHash).toBe(initial.snapshotHash);
      const persistedG1 = snapshots.read(source.id);
      if (persistedG1.status !== "ok") throw new Error(persistedG1.message);
      expect(persistedG1.value).toMatchObject({ generation: 1, snapshotHash: committed.snapshot.snapshotHash });

      const successorHost = createCompiledDurableTestHost();
      successor = new GameSession(
        source.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(root, "successor-careers") },
        undefined, "preferred", successorHost.runtimeDependencies,
      );
      expect(successor.restoreCompiledSession(persistedG1.value, built.bundle).status).toBe("loaded");
      expect(successor.getCompiledGeneration()).toBe(1);
      const g1Choice = successor.getCompiledPlayerFacadeView().actions[0];
      if (g1Choice) expect(successorHost.resolvePlayerChoice(successor, g1Choice.choiceId, 1)).toBeTruthy();
      expect(sourceHost.access(source)?.choiceHmacKey).toBe(successorHost.access(successor)?.choiceHmacKey);
    } finally {
      source?.close();
      restored?.close();
      successor?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes server player authentication and choice selection immune to own-shadowed public accessors", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-durable-host-authority-"));
    const registry = new Map<string, GameSession>();
    const host = createCompiledDurableTestHost();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = saveTrustedFixtureBundle(catalog, fixture);
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
      const authenticate = (request: Request) => request.headers.get("authorization") === "Bearer keeper"
        ? { status: "authenticated" as const, principal: { id: "keeper:shadow", role: "keeper" as const } }
        : request.headers.get("authorization") === "Bearer player"
          ? { status: "authenticated" as const, principal: { id: "player:shadow", role: "player" as const } }
          : { status: "unauthenticated" as const };
      const runtime = { registry, compiledDurableHostCapability: host.capability };
      const created = await handleRequest(new Request("http://test/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer keeper" },
        body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
      }), catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, authenticate, undefined,
      () => ({ status: "assigned" as const, principal: { id: "player:shadow", role: "player" as const } }), undefined, undefined, runtime);
      expect(created.status).toBe(201);
      const { sessionId } = await created.json() as { sessionId: string };
      const session = registry.get(sessionId);
      if (!session) throw new Error("server did not register created compiled session");
      Object.defineProperty(session, "getCompiledSessionAccessBinding", { value: () => { throw new Error("shadowed access"); } });
      Object.defineProperty(session, "getCompiledPlayerFacadeActionInput", { value: () => { throw new Error("shadowed choice"); } });

      const viewResponse = await handleRequest(new Request(`http://test/api/sessions/${sessionId}/player-view`, {
        headers: { Authorization: "Bearer player" },
      }), catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, authenticate, undefined, undefined, undefined, undefined, runtime);
      expect(viewResponse.status).toBe(200);
      const view = await viewResponse.json() as { generation: number; actions: Array<{ choiceId: string }> };
      const choice = view.actions[0];
      if (!choice) throw new Error("server fixture must expose a player choice");

      const actionResponse = await handleRequest(new Request(`http://test/api/sessions/${sessionId}/player-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer player" },
        body: JSON.stringify({ choiceId: choice.choiceId, actionId: "own-shadow-proof", expectedGeneration: view.generation }),
      }), catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, authenticate, undefined, undefined, undefined, undefined, runtime);
      expect(actionResponse.status).toBe(200);
      expect(await actionResponse.json()).toMatchObject({ result: { status: "committed" }, view: { generation: 1 } });
    } finally {
      for (const session of registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
