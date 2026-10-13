import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompiledAvailableAction, CompiledMechanicsSessionState } from "../api/game-session";
import { GameSession } from "../api/game-session";
import { createCompiledSessionAccessBinding } from "../api/compiled-module-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

type ShadowKind = "own" | "prototype";
type ShadowMode = "fake" | "throw";

function root(): string {
  return mkdtempSync(join(tmpdir(), "compiled-projection-private-authority-"));
}

function forgedState(): CompiledMechanicsSessionState {
  return {
    moduleId: "forged-module",
    artifactHash: "forged-artifact",
    mechanicsHash: "forged-mechanics",
    state: {
      currentSceneId: "forged-scene",
      foundClueIds: [],
      visitedSceneIds: [],
      ownedItemIds: [],
      stateValues: {},
      npcStates: {},
      unlockedConnectionIds: [],
      failureCounts: {},
      encounters: {},
      startedEncounterIds: [],
      rewardIds: [],
    },
    stateHash: "forged-state",
    trace: [],
    generation: 99,
  };
}

function forgedActions(canonical: CompiledAvailableAction[]): CompiledAvailableAction[] {
  const first = canonical[0];
  if (!first) throw new Error("fixture needs one available compiled action");
  return [
    {
      ...first,
      command: "@compiled forged_mechanism",
      label: "Forged player action",
      check: { kind: "skill", skill: "library_use", difficulty: "extreme" },
    },
    { mechanismId: "forged_mechanism", kind: "discovery", command: "@compiled forged_extra", label: "Forged extra action" },
  ];
}

function installShadow<T extends "getCompiledMechanicsState" | "getCompiledAvailableActions">(
  session: GameSession,
  method: T,
  kind: ShadowKind,
  mode: ShadowMode,
  fake: T extends "getCompiledMechanicsState" ? CompiledMechanicsSessionState : CompiledAvailableAction[],
): () => void {
  const target = kind === "own" ? session : GameSession.prototype;
  const original = Object.getOwnPropertyDescriptor(target, method);
  Object.defineProperty(target, method, {
    configurable: true,
    value: () => {
      if (mode === "throw") throw new Error(`forged ${method} ${kind} projection`);
      return fake;
    },
  });
  return () => {
    if (original) Object.defineProperty(target, method, original);
    else Reflect.deleteProperty(target, method);
  };
}

async function durableSession(dir: string, id: string) {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
  const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  const bundle = catalog.loadBundle(saved.value.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const session = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") });
  const loaded = session.loadDurableCompiledModule(bundle.value, createCompiledSessionAccessBinding(
    { id: "keeper:compiled-projection-private-authority", role: "keeper" },
    { id: "player:compiled-projection-private-authority", role: "player" },
  ));
  if (loaded.status === "refused") throw new Error(loaded.message);
  return { session };
}

describe("compiled projection private authority", () => {
  it("seals durable compiled projections after close", async () => {
    const dir = root();
    let built: Awaited<ReturnType<typeof durableSession>> | undefined;
    try {
      built = await durableSession(dir, `compiled-closed-projections-${crypto.randomUUID()}`);
      const session = built.session;
      const action = session.getCompiledAvailableActions()[0];
      const generation = session.getCompiledGeneration();
      expect(action).toBeDefined();
      expect(generation).not.toBeNull();

      session.close();

      for (const read of [
        () => session.getCompiledMechanicsState(),
        () => session.getCompiledGeneration(),
        () => session.getCompiledAvailableActions(),
        () => session.getCompiledPlayerFacadeView(),
        () => session.getCurrentCompiledPlayerFacadeActionForMechanism(action!.mechanismId, generation!),
        () => session.getCompiledWorldModelPromptReceipt(),
        () => session.getSuggestions(),
      ]) expect(read).toThrow("closed GameSession cannot read session state");
    } finally {
      built?.session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const kind of ["own", "prototype"] as const) {
    for (const mode of ["fake", "throw"] as const) {
      it(`keeps ${kind} ${mode} mechanics-state shadows out of compiled load results`, async () => {
        const fixture = await compiledModuleHttpFixture();
        const control = new GameSession(`compiled-state-control-${kind}-${mode}`, "cosmic-horror", CONFIG, "investigator", "Ada");
        const target = new GameSession(`compiled-state-target-${kind}-${mode}`, "cosmic-horror", CONFIG, "investigator", "Ada");
        let restore = () => {};
        try {
          const controlLoad = control.loadCompiledModule(fixture.resolved.artifact.payload as any, fixture.projection);
          if (controlLoad.status === "refused") throw new Error(controlLoad.message);
          const canonical = controlLoad.compiled;
          const forged = forgedState();
          restore = installShadow(target, "getCompiledMechanicsState", kind, mode, forged);

          if (mode === "fake") expect(target.getCompiledMechanicsState()).toBe(forged);
          else expect(() => target.getCompiledMechanicsState()).toThrow(`forged getCompiledMechanicsState ${kind} projection`);

          let loaded: ReturnType<GameSession["loadCompiledModule"]> | undefined;
          expect(() => { loaded = target.loadCompiledModule(fixture.resolved.artifact.payload as any, fixture.projection); }).not.toThrow();
          expect(loaded).toEqual({ status: "loaded", compiled: canonical });
        } finally {
          restore();
          target.close();
          control.close();
        }
      });

      it(`keeps ${kind} ${mode} mechanics-state shadows out of durable compiled refusals`, async () => {
        const dir = root();
        let built: Awaited<ReturnType<typeof durableSession>> | undefined;
        let restore = () => {};
        try {
          built = await durableSession(dir, `compiled-refusal-${kind}-${mode}`);
          const canonical = built.session.getCompiledMechanicsState();
          expect(canonical).not.toBeNull();
          const forged = forgedState();
          restore = installShadow(built.session, "getCompiledMechanicsState", kind, mode, forged);

          if (mode === "fake") expect(built.session.getCompiledMechanicsState()).toBe(forged);
          else expect(() => built!.session.getCompiledMechanicsState()).toThrow(`forged getCompiledMechanicsState ${kind} projection`);

          const refusal = await built.session.act("ordinary action is refused for a durable compiled session", "p1");
          expect(refusal).toMatchObject({ error: { code: "compiled_action_contract_required" }, compiled: canonical });
        } finally {
          restore();
          built?.session.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  for (const kind of ["own", "prototype"] as const) {
    for (const mode of ["fake", "throw"] as const) {
      it(`keeps ${kind} ${mode} available-action shadows out of all compiled player projections`, async () => {
        const dir = root();
        let built: Awaited<ReturnType<typeof durableSession>> | undefined;
        let restore = () => {};
        try {
          built = await durableSession(dir, `compiled-actions-${kind}-${mode}`);
          const canonicalActions = built.session.getCompiledAvailableActions();
          expect(canonicalActions).not.toHaveLength(0);
          const mechanismId = canonicalActions[0]!.mechanismId;
          const generation = built.session.getCompiledGeneration();
          if (generation === null) throw new Error("fixture has no compiled generation");
          const canonicalFacade = built.session.getCompiledPlayerFacadeView();
          const canonicalCurrent = built.session.getCurrentCompiledPlayerFacadeActionForMechanism(mechanismId, generation);
          const canonicalSuggestions = built.session.getSuggestions("p1");
          const forged = forgedActions(canonicalActions);
          restore = installShadow(built.session, "getCompiledAvailableActions", kind, mode, forged);

          if (mode === "fake") expect(built.session.getCompiledAvailableActions()).toBe(forged);
          else expect(() => built!.session.getCompiledAvailableActions()).toThrow(`forged getCompiledAvailableActions ${kind} projection`);

          expect(built.session.getCompiledPlayerFacadeView()).toEqual(canonicalFacade);
          expect(built.session.getCurrentCompiledPlayerFacadeActionForMechanism(mechanismId, generation)).toEqual(canonicalCurrent);
          expect(built.session.getSuggestions("p1")).toEqual(canonicalSuggestions);
        } finally {
          restore();
          built?.session.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});
