import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { COMPILED_SESSION_NAMESPACE_IDENTITY_FORMAT, CompiledSessionSnapshotStore, type CompiledSessionSnapshot } from "../api/compiled-session-snapshot";
import { hydrateCompiledSession, handleRequest } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const owner: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "keeper", id: "keeper:compiled-namespace-gap" },
});
const player: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "player", id: "player:compiled-namespace-gap-p1" },
});

describe("compiled HTTP namespace authority after an indeterminate publication", () => {
  it("refuses a rejected store successor, then replaces stale g0 only with the reconciled exact g1", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-namespace-gap-"));
    const registry = new Map<string, GameSession>();
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
    const namespace = new SessionNamespaceCoordinator(join(root, "careers", ".runtime-session-namespace"));
    const host = createCompiledDurableTestHost();
    const id = "10000000-0000-4000-8000-000000000001";
    let recoveryFactoryCalls = 0;
    const runtime = (path: string, auth: CompilerRequestAuthenticator, init: RequestInit = {}) => handleRequest(
      new Request(`http://test${path}`, init),
      catalog,
      snapshots,
      { careerRoot: join(root, "careers") },
      {},
      {},
      auth,
      undefined,
      () => ({ status: "assigned" as const, principal: { role: "player" as const, id: "player:compiled-namespace-gap-p1" } }),
      undefined,
      undefined,
      {
        registry,
        sessionNamespace: namespace,
        compiledDurableHostCapability: host.capability,
        generateCompiledSessionId: () => id,
        createCompiledRecoverySession: ({ id: recoveryId, storage, runtimeDependencies }) => {
          recoveryFactoryCalls++;
          return new GameSession(
            recoveryId,
            "cosmic-horror",
            undefined,
            undefined,
            undefined,
            undefined,
            storage,
            undefined,
            "preferred",
            runtimeDependencies,
          );
        },
      },
    );
    const clearRegistry = () => {
      for (const session of registry.values()) session.close();
      registry.clear();
    };

    try {
      const fixture = await compiledModuleHttpFixture();
      const saved = saveTrustedFixtureBundle(catalog, fixture);

      const created = await runtime("/api/sessions/compiled", owner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
      });
      expect(created.status).toBe(201);
      expect((await created.json() as { sessionId: string }).sessionId).toBe(id);

      const g0 = snapshots.read(id);
      if (g0.status !== "ok") throw new Error(g0.message);
      const g0Snapshot = g0.value as CompiledSessionSnapshot;
      const actions = await runtime(`/api/sessions/${id}/compiled/actions?pcId=p1`, owner);
      expect(actions.status).toBe(200);
      const command = (await actions.json() as { actions: Array<{ command: string }> }).actions[0]?.command;
      if (!command) throw new Error("compiled fixture has no available action");

      // The store publishes g1, then the namespace callback loses the commit
      // acknowledgement.  Its g0 pointer remains the only committed authority.
      const originalPublishCommitted = namespace.publishCommitted.bind(namespace);
      const patchedNamespace = namespace as unknown as {
        publishCommitted: typeof namespace.publishCommitted;
      };
      patchedNamespace.publishCommitted = (input) => originalPublishCommitted({
        ...input,
        publish: (permit) => {
          input.publish(permit);
          throw new Error("test-only lost namespace commit acknowledgement");
        },
      });
      try {
        const action = await runtime(`/api/sessions/${id}/action`, owner, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: command, pcId: "p1", actionId: "namespace-gap", expectedGeneration: 0 }),
        });
        expect(action.status).toBe(503);
        expect(await action.json()).toMatchObject({ code: "compiled_persistence_indeterminate" });
      } finally {
        patchedNamespace.publishCommitted = originalPublishCommitted;
      }

      const g1 = snapshots.read(id);
      expect(g1).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(namespace.read(id)).toMatchObject({
        kind: "compiled",
        state: "committed",
        expectedIdentity: { generation: 0, hash: g0Snapshot.snapshotHash },
      });
      expect(registry.has(id)).toBe(false);

      // The direct gate confirms the intended authority boundary. The HTTP
      // calls below must use this same exact check, regardless of route kind.
      const explicit = hydrateCompiledSession(id, {
        catalog,
        snapshots,
        sessionNamespace: namespace,
        compiledDurableHostCapability: host.capability,
        createSession: (sessionId, runtimeDependencies) => new GameSession(
          sessionId,
          "cosmic-horror",
          undefined,
          undefined,
          undefined,
          undefined,
          { careerRoot: join(root, "recovered-careers") },
          undefined,
          "preferred",
          runtimeDependencies,
        ),
      });
      expect(explicit).toMatchObject({ status: "refused", code: "SNAPSHOT_CONFLICT" });

      // Treat a same-kind g1 object as an already-live stale registry entry.
      // The request path must still reject it by exact namespace identity.
      const staleLive = hydrateCompiledSession(id, {
        catalog,
        snapshots,
        compiledDurableHostCapability: host.capability,
        createSession: (sessionId, runtimeDependencies) => new GameSession(
          sessionId,
          "cosmic-horror",
          undefined,
          undefined,
          undefined,
          undefined,
          { careerRoot: join(root, "stale-live-careers") },
          undefined,
          "preferred",
          runtimeDependencies,
        ),
      });
      if (staleLive.status !== "ok") throw new Error(staleLive.message);
      registry.set(id, staleLive.session);
      expect((await runtime(`/api/sessions/${id}`, owner)).status).toBe(404);

      // Each request starts with no local entry. None may turn the uncommitted
      // g1 store pointer into a live registry authority or even construct it.
      clearRegistry();
      recoveryFactoryCalls = 0;
      expect((await runtime(`/api/sessions/${id}`, owner)).status).toBe(404);
      expect(registry.has(id)).toBe(false);
      expect(recoveryFactoryCalls).toBe(0);

      clearRegistry();
      recoveryFactoryCalls = 0;
      expect((await runtime(`/api/sessions/${id}/player-view`, player)).status).toBe(404);
      expect(registry.has(id)).toBe(false);
      expect(recoveryFactoryCalls).toBe(0);

      clearRegistry();
      recoveryFactoryCalls = 0;
      expect((await runtime(`/api/sessions/${id}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: "not-read", actionId: "namespace-gap-player", expectedGeneration: 0 }),
      })).status).toBe(404);
      expect(registry.has(id)).toBe(false);
      expect(recoveryFactoryCalls).toBe(0);

      // Once startup reconciliation has proved the durable successor, a stale
      // local g0 object must be replaced by that exact committed g1 object.
      // This is deliberately the inverse of the checks above: kind equality
      // alone is insufficient, but the exact successor remains recoverable.
      if (g1.status !== "ok") throw new Error(g1.message);
      const g1Snapshot = g1.value as CompiledSessionSnapshot;
      expect(namespace.reconcileObserved({
        sessionId: id,
        kind: "compiled",
        observedIdentity: {
          hash: g1Snapshot.snapshotHash,
          generation: g1Snapshot.generation,
          format: COMPILED_SESSION_NAMESPACE_IDENTITY_FORMAT,
        },
      })).toMatchObject({
        state: "committed",
        expectedIdentity: { hash: g1Snapshot.snapshotHash, generation: 1 },
      });
      const bundle = catalog.loadBundle(g0Snapshot.bundle.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const staleG0 = new GameSession(
        id,
        "cosmic-horror",
        undefined,
        undefined,
        undefined,
        undefined,
        { careerRoot: join(root, "stale-g0-careers") },
        undefined,
        "preferred",
        { compiledDurableHostCapability: host.capability },
      );
      expect(staleG0.restoreCompiledSession(g0Snapshot, bundle.value)).toMatchObject({ status: "loaded" });
      registry.set(id, staleG0);
      recoveryFactoryCalls = 0;
      expect((await runtime(`/api/sessions/${id}`, owner)).status).toBe(200);
      expect(registry.get(id)).not.toBe(staleG0);
      expect(registry.get(id)?.getCompiledGeneration()).toBe(1);
      expect(recoveryFactoryCalls).toBe(1);
    } finally {
      clearRegistry();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
