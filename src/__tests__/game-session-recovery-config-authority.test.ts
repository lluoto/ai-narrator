import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCompiledSessionAccessBinding, type CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { CompiledSessionSnapshotStore as CompiledSessionSnapshotStoreImplementation, type CompiledSessionSnapshotStoreOptions } from "../api/compiled-session-snapshot";
import { GameSession } from "../api/game-session";
import { ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, OrdinarySessionSnapshotStore as OrdinarySessionSnapshotStoreImplementation, createOrdinarySessionEnvelope, type OrdinarySessionSnapshotStoreOptions } from "../api/ordinary-session-snapshot-store";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = {
  apiKey: "sk-recovery-host-config",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

class OrdinarySessionSnapshotStore extends OrdinarySessionSnapshotStoreImplementation {
  constructor(options: OrdinarySessionSnapshotStoreOptions = {}) {
    super({ ...options, allowUncoordinatedTestWrites: true });
  }
}

class CompiledSessionSnapshotStore extends CompiledSessionSnapshotStoreImplementation {
  constructor(options: CompiledSessionSnapshotStoreOptions = {}) {
    super({ ...options, allowUncoordinatedTestWrites: true });
  }
}

function installThrowingConfigShadow(session: GameSession): void {
  Object.defineProperty(session, "config", {
    configurable: true,
    get: () => { throw new Error("public config shadow was read during recovery"); },
  });
}

describe("GameSession recovery configuration authority", () => {
  it("uses the trusted ordinary recovery factory while source and recovered config shadows throw", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-config-authority-"));
    const id = "12345678-1234-4123-8123-123456789ab1";
    const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(storage.sessionRoot, "ordinary-snapshots") });
    const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-config-owner" });
    const registry = new Map<string, GameSession>();
    const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined, storage, access, "development_fallback");
    let hostFactoryCalls = 0;
    const authenticator: CompilerRequestAuthenticator = () => ({
      status: "authenticated",
      principal: { role: "keeper", id: "ordinary-config-owner" },
    });
    try {
      expect(snapshots.save(createOrdinarySessionEnvelope({
        kind: "ordinary-session-envelope",
        schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
        sessionId: id,
        generation: 0,
        previousEnvelopeHash: null,
        access,
        snapshot: source.exportOrdinarySessionSnapshot(),
        idempotency: [],
      }))).toMatchObject({ status: "ok" });
      expect((source as unknown as Record<string, unknown>).config).toBeUndefined();
      installThrowingConfigShadow(source);
      registry.set(id, source);
      const runtime: SessionRuntimeDependencies = {
        registry,
        ordinarySnapshots: snapshots,
        ordinaryIntentPolicy: "development_fallback",
        createOrdinaryRecoverySession: ({ id: recoveredId, access: recoveredAccess, storage: recoveredStorage, intentPolicy, runtimeDependencies }) => {
          hostFactoryCalls++;
          const target = new GameSession(recoveredId, "cosmic-horror", CONFIG, undefined, undefined, undefined, recoveredStorage, recoveredAccess, intentPolicy, runtimeDependencies);
          installThrowingConfigShadow(target);
          return target;
        },
      };
      const response = await handleRequest(new Request(`http://test/api/sessions/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "/help", actionId: "ordinary-config-recovery-0001", expectedGeneration: 0 }),
      }), undefined, undefined, storage, {}, {}, authenticator, undefined, undefined, undefined, { mode: "required" }, runtime);

      expect(response.status).toBe(200);
      expect(hostFactoryCalls).toBeGreaterThanOrEqual(2);
      expect(registry.get(id)).not.toBe(source);
      expect(registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
    } finally {
      for (const session of registry.values()) session.close();
      if (!registry.has(id)) source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the trusted compiled recovery factory while source and recovered config shadows throw", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-config-authority-"));
    const id = "12345678-1234-4123-8123-123456789ab2";
    const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "compiled-snapshots") });
    const registry = new Map<string, GameSession>();
    const access = createCompiledSessionAccessBinding({ role: "operator", id: "compiled-config-owner" });
    let source: GameSession | undefined;
    let hostFactoryCalls = 0;
    const compiledHost = createCompiledDurableTestHost();
    const authenticator: CompilerRequestAuthenticator = () => ({
      status: "authenticated",
      principal: { role: "operator", id: "compiled-config-owner" },
    });
    try {
      const fixture = await compiledModuleHttpFixture();
      const savedBundle = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
      if (savedBundle.status !== "ok") throw new Error(savedBundle.message);
      const bundle = catalog.loadBundle(savedBundle.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      source = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, storage, undefined, "preferred", compiledHost.runtimeDependencies);
      expect(source.loadDurableCompiledModule(bundle.value, access)).toMatchObject({ status: "loaded" });
      const initial = compiledHost.snapshot(source);
      expect(snapshots.save(initial)).toMatchObject({ status: "ok" });
      compiledHost.acknowledge(source, initial);
      expect((source as unknown as Record<string, unknown>).config).toBeUndefined();
      installThrowingConfigShadow(source);
      registry.set(id, source);
      const method = (fixture.resolved.artifact.payload as any).mechanicsIR.discoveryMethods.find((entry: { id: string }) => entry.id === "find_parent");
      if (!method) throw new Error("compiled fixture lacks find_parent");
      const runtime: SessionRuntimeDependencies = {
        registry,
        compiledDurableHostCapability: compiledHost.capability,
        createCompiledRecoverySession: ({ id: recoveredId, storage: recoveredStorage, runtimeDependencies }) => {
          hostFactoryCalls++;
          const target = new GameSession(recoveredId, "cosmic-horror", CONFIG, undefined, undefined, undefined, recoveredStorage, undefined, "preferred", runtimeDependencies);
          installThrowingConfigShadow(target);
          return target;
        },
      };
      const response = await handleRequest(new Request(`http://test/api/sessions/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: `@compiled ${method.id}`, pcId: "p1", actionId: "compiled-config-recovery-0001", expectedGeneration: 0 }),
      }), catalog, snapshots, storage, {}, {}, authenticator, undefined, undefined, undefined, undefined, runtime);

      expect(response.status).toBe(200);
      expect(hostFactoryCalls).toBe(1);
      expect(registry.get(id)).not.toBe(source);
      expect(registry.get(id)?.getCompiledGeneration()).toBe(1);
    } finally {
      for (const session of registry.values()) session.close();
      if (!registry.has(id)) source?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
