import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

type ShadowKind = "own" | "prototype";
type ShadowMode = "fake" | "throw";
type InstallMethod = "installRuntimeModulePackage" | "loadCompiledModuleInternal" | "installCompiledProjectionAtomically" | "installCompiledProjection";

const INSTALL_METHODS: readonly InstallMethod[] = [
  "installRuntimeModulePackage", "loadCompiledModuleInternal", "installCompiledProjectionAtomically", "installCompiledProjection",
];

function root(): string {
  return mkdtempSync(join(tmpdir(), "compiled-install-private-authority-"));
}

function installShadow(session: GameSession, methods: readonly InstallMethod[], kind: ShadowKind, mode: ShadowMode): { calls: () => number; restore: () => void } {
  const target = kind === "own" ? session : GameSession.prototype;
  const originals = methods.map((method) => [method, Object.getOwnPropertyDescriptor(target, method)] as const);
  let calls = 0;
  for (const method of methods) {
    Object.defineProperty(target, method, {
      configurable: true,
      value: () => {
        calls += 1;
        if (mode === "throw") throw new Error(`forged ${method} ${kind} install authority`);
        return { status: "loaded", compiled: { moduleId: "FORGED", generation: 99 } };
      },
    });
  }
  return {
    calls: () => calls,
    restore: () => {
      for (const [method, original] of originals) {
        if (original) Object.defineProperty(target, method, original);
        else Reflect.deleteProperty(target, method);
      }
    },
  };
}

function expectExactInitialMirror(session: GameSession, canonical: GameSession): void {
  const mechanics = session.getCompiledMechanicsState();
  const expectedMechanics = canonical.getCompiledMechanicsState();
  expect(mechanics).toEqual(expectedMechanics);
  expect(mechanics).toEqual(expect.objectContaining({ generation: 0 }));
  if (!mechanics) throw new Error("loaded compiled session needs mechanics state");
  const state = session.getState();
  const canonicalState = canonical.getState();
  // Character creation is intentionally per-session random.  The compiled
  // projection must nevertheless be exact, while this session's own p1 is
  // mirrored into the world at the mechanics-authoritative scene.
  expect({ scene: state.scene, round: state.round, bgm: state.bgm, npcs: state.npcs, monsters: state.monsters, inventory: state.inventory, sceneItems: state.sceneItems })
    .toEqual({ scene: canonicalState.scene, round: canonicalState.round, bgm: canonicalState.bgm, npcs: canonicalState.npcs, monsters: canonicalState.monsters, inventory: canonicalState.inventory, sceneItems: canonicalState.sceneItems });
  expect(session.world.getEntity("p1")).toEqual(expect.objectContaining({
    position: mechanics.state.currentSceneId,
    scene_id: mechanics.state.currentSceneId,
    hp: state.player.hp,
    maxHp: state.player.maxHp,
  }));
}

describe("compiled install private authority", () => {
  for (const method of INSTALL_METHODS) {
    for (const kind of ["own", "prototype"] as const) {
      for (const mode of ["fake", "throw"] as const) {
        it(`keeps ${kind} ${mode} ${method} shadows out of loose compiled loads`, async () => {
          const fixture = await compiledModuleHttpFixture(`compiled-install-private-${method}-${kind}-${mode}`);
          const control = new GameSession(`compiled-install-control-${method}-${kind}-${mode}`, "cosmic-horror", CONFIG, "investigator", "Ada");
          const target = new GameSession(`compiled-install-target-${method}-${kind}-${mode}`, "cosmic-horror", CONFIG, "investigator", "Ada");
          let shadow: ReturnType<typeof installShadow> | undefined;
          try {
            const controlLoaded = control.loadCompiledModule(fixture.resolved.artifact.payload as any, fixture.projection);
            if (controlLoaded.status !== "loaded") throw new Error(controlLoaded.message);
            shadow = installShadow(target, [method], kind, mode);
            if (mode === "throw") {
              expect(() => (target as any)[method]()).toThrow(`forged ${method} ${kind} install authority`);
            } else {
              expect((target as any)[method]()).toEqual({ status: "loaded", compiled: { moduleId: "FORGED", generation: 99 } });
            }
            const callsBeforeCanonical = shadow.calls();
            const loaded = target.loadCompiledModule(fixture.resolved.artifact.payload as any, fixture.projection);
            expect(shadow.calls()).toBe(callsBeforeCanonical);
            expect(loaded).toEqual({ status: "loaded", compiled: controlLoaded.compiled });
            expectExactInitialMirror(target, control);
          } finally {
            shadow?.restore();
            target.close();
            control.close();
          }
        });
      }
    }
  }

  for (const kind of ["own", "prototype"] as const) {
    for (const mode of ["fake", "throw"] as const) {
      it(`keeps ${kind} ${mode} install shadows out of durable load, snapshot, and restore`, async () => {
        const dir = root();
        const fixture = await compiledModuleHttpFixture(`compiled-install-private-durable-${kind}-${mode}`);
        const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
        const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
        if (saved.status !== "ok") throw new Error(saved.message);
        const bundle = catalog.loadBundle(saved.value.id);
        if (bundle.status !== "ok") throw new Error(bundle.message);
        const sourceHost = createCompiledDurableTestHost();
        const targetHost = createCompiledDurableTestHost();
        const restoreHost = createCompiledDurableTestHost();
        const id = `compiled-install-durable-${kind}-${mode}`;
        const source = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "source-careers") }, undefined, "preferred", sourceHost.runtimeDependencies);
        const target = new GameSession(`target-${id}`, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "target-careers") }, undefined, "preferred", targetHost.runtimeDependencies);
        const restored = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "restore-careers") }, undefined, "preferred", restoreHost.runtimeDependencies);
        let targetShadow: ReturnType<typeof installShadow> | undefined;
        let restoreShadow: ReturnType<typeof installShadow> | undefined;
        try {
          const sourceLoaded = source.loadDurableCompiledModule(bundle.value);
          if (sourceLoaded.status !== "loaded") throw new Error(sourceLoaded.message);
          const snapshot = sourceHost.snapshot(source);
          targetShadow = installShadow(target, INSTALL_METHODS, kind, mode);
          for (const method of INSTALL_METHODS) {
            if (mode === "throw") expect(() => (target as any)[method]()).toThrow(`forged ${method} ${kind} install authority`);
            else expect((target as any)[method]()).toEqual({ status: "loaded", compiled: { moduleId: "FORGED", generation: 99 } });
          }
          const targetCallsBeforeCanonical = targetShadow.calls();
          expect(target.loadDurableCompiledModule(bundle.value)).toEqual({ status: "loaded", compiled: sourceLoaded.compiled });
          expect(targetShadow.calls()).toBe(targetCallsBeforeCanonical);
          expectExactInitialMirror(target, source);
          expect(targetHost.snapshot(target)).toEqual(expect.objectContaining({ generation: 0, sessionId: target.id }));

          restoreShadow = installShadow(restored, INSTALL_METHODS, kind, mode);
          for (const method of INSTALL_METHODS) {
            if (mode === "throw") expect(() => (restored as any)[method]()).toThrow(`forged ${method} ${kind} install authority`);
            else expect((restored as any)[method]()).toEqual({ status: "loaded", compiled: { moduleId: "FORGED", generation: 99 } });
          }
          const restoreCallsBeforeCanonical = restoreShadow.calls();
          expect(restored.restoreCompiledSession(snapshot, bundle.value)).toEqual({ status: "loaded", compiled: sourceLoaded.compiled });
          expect(restoreShadow.calls()).toBe(restoreCallsBeforeCanonical);
          expectExactInitialMirror(restored, source);
          expect(restoreHost.snapshot(restored)).toEqual(snapshot);
        } finally {
          restoreShadow?.restore();
          targetShadow?.restore();
          restored.close();
          target.close();
          source.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});
