import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotHash, validateCompiledSessionSnapshot, type CompiledSessionSnapshot } from "../api/compiled-session-snapshot";
import { GameSession } from "../api/game-session";
import { handleCompiledModuleHttpRequest } from "../api/compiled-module-http";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { CompiledSessionCreationAdmissionCoordinator, COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY } from "../api/compiled-session-creation-admission";
import { hydrateCompiledSession } from "../api/server";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";

function seededEntropy(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("compiled snapshot CoC Build bounds", () => {
  it("persists a seeded legal negative Build through real compiled HTTP creation and rejects values outside the CoC range", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-negative-build-"));
    let candidate: GameSession | undefined;
    let recoveredCandidate: GameSession | undefined;
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = saveTrustedFixtureBundle(catalog, fixture);
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
      const namespaceRoot = join(root, "namespace");
      mkdirSync(namespaceRoot, { recursive: true });
      const namespace = new SessionNamespaceCoordinator(namespaceRoot);
      const compiledSessionCreationAdmission = new CompiledSessionCreationAdmissionCoordinator({
        root: namespace.root,
        ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
      });
      const namespaceGate = { required: true, consume: namespace.consumePublicationPermit.bind(namespace) };
      const host = createCompiledDurableTestHost();
      let persisted: CompiledSessionSnapshot | undefined;
      const response = await handleCompiledModuleHttpRequest(new Request("https://example.test/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-keeper" },
        body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Build minus one" }),
      }), {
        createSession: (id, archetype, characterName, persona) => {
          candidate = new GameSession(id, "cosmic-horror", undefined, archetype, characterName, persona, { careerRoot: join(root, "careers") }, undefined, "preferred", {
            characterRandomUnit: seededEntropy(556),
            ...host.runtimeDependencies,
          });
          return candidate;
        },
        hasSession: () => false,
        registerSession: () => undefined,
        unregisterSession: (_id, session) => (session as GameSession).close(),
        persistSession: (_id, _session, _bundleId, snapshot, permit) => {
          persisted = snapshot;
          if (!permit) return { status: "indeterminate" as const };
          const stored = snapshots.save(snapshot, { permit }, namespaceGate);
          if (stored.status !== "ok") return { status: "not-published" as const, failureCode: stored.code };
          return { status: "published" as const, observedIdentity: { hash: snapshot.snapshotHash, generation: snapshot.generation, format: "compiled-session-snapshot-v1" } };
        },
        recoverPersistedSession: (id) => {
          const recovered = hydrateCompiledSession(id, {
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
          if (recovered.status !== "ok") return undefined;
          recoveredCandidate = recovered.session;
          return recoveredCandidate;
        },
        generateId: () => "11111111-1111-4111-8111-111111111111",
        catalog,
        authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: "keeper:negative-build", role: "keeper" } }),
        sessionNamespace: namespace,
        compiledSessionCreationAdmission,
        compiledDurableHostCapability: host.capability,
      });

      expect(response?.status).toBe(201);
      if (!persisted) throw new Error("expected persisted compiled snapshot");
      expect(host.snapshot(candidate!).snapshotHash).toBe(persisted.snapshotHash);
      expect(persisted.initialCharacter.sheet.build).toBe(-1);
      expect(persisted.character.sheet.build).toBe(-1);
      expect(validateCompiledSessionSnapshot(persisted)).toMatchObject({ status: "ok" });

      for (const legalBuild of [-2, 8]) {
        const rebounded = structuredClone(persisted) as CompiledSessionSnapshot;
        rebounded.initialCharacter.sheet.build = legalBuild;
        rebounded.character.sheet.build = legalBuild;
        rebounded.snapshotHash = compiledSessionSnapshotHash(rebounded);
        expect(validateCompiledSessionSnapshot(rebounded)).toMatchObject({ status: "ok" });
      }

      for (const outOfRangeBuild of [-3, 9]) {
        const corrupted = structuredClone(persisted) as CompiledSessionSnapshot;
        corrupted.initialCharacter.sheet.build = outOfRangeBuild;
        corrupted.character.sheet.build = outOfRangeBuild;
        corrupted.snapshotHash = compiledSessionSnapshotHash(corrupted);
        expect(validateCompiledSessionSnapshot(corrupted)).toMatchObject({ status: "refused", code: "SNAPSHOT_INCOMPATIBLE" });
      }
    } finally {
      recoveredCandidate?.close();
      candidate?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
