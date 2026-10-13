import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

type ShadowedMethod = "actCompiled" | "prepareCompiledAction" | "applyPreparedCompiledAction";
type ShadowKind = "own" | "prototype";
type ShadowMode = "fake" | "throw";

const RUNTIME_CLOSURE = [
  "compiledFailure", "preparedCompiledActionResponse", "compiledSnapshotCharacter", "compiledState",
  "selectCompiledAction", "selectCompiledCombatAction", "evaluateCompiledCheck", "prepareCompiledSkillGrowth",
  "prepareTerminalRewardSettlement", "synchronizeCompiledMechanicsState", "persistedCompiledCharacterSheet",
] as const;
const DURABLE_CLOSURE = [...RUNTIME_CLOSURE, "preparedCompiledSummary", "makeCompiledSnapshot"] as const;

function root(): string {
  return mkdtempSync(join(tmpdir(), "compiled-action-private-authority-"));
}

async function compiledSession(id: string): Promise<{ session: GameSession; command: string }> {
  const fixture = await compiledModuleHttpFixture(`compiled-action-private-authority-${id}`);
  const session = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada");
  const loaded = session.loadCompiledModule(fixture.resolved.artifact.payload as any, fixture.projection);
  if (loaded.status === "refused") throw new Error(loaded.message);
  const command = session.getCompiledAvailableActions()[0]?.command;
  if (!command) throw new Error("fixture needs one available compiled action");
  return { session, command };
}

async function durableCompiledSession(dir: string, id: string): Promise<{ session: GameSession; command: string; host: ReturnType<typeof createCompiledDurableTestHost> }> {
  const fixture = await compiledModuleHttpFixture(`compiled-action-private-authority-durable-${id}`);
  const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
  const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  const bundle = catalog.loadBundle(saved.value.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const host = createCompiledDurableTestHost();
  const session = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", host.runtimeDependencies);
  const loaded = session.loadDurableCompiledModule(bundle.value);
  if (loaded.status === "refused") throw new Error(loaded.message);
  const initial = host.snapshot(session);
  host.acknowledge(session, initial);
  const command = session.getCompiledAvailableActions()[0]?.command;
  if (!command) throw new Error("fixture needs one available durable compiled action");
  return { session, command, host };
}

function installActionShadow(session: GameSession, method: ShadowedMethod, kind: ShadowKind, mode: ShadowMode): { calls: () => number; restore: () => void } {
  const target = kind === "own" ? session : GameSession.prototype;
  const original = Object.getOwnPropertyDescriptor(target, method);
  let calls = 0;
  Object.defineProperty(target, method, {
    configurable: true,
    value: function (this: GameSession, ...args: unknown[]) {
      calls += 1;
      if (mode === "throw") throw new Error(`forged ${method} ${kind} action authority`);
      if (method === "actCompiled") return { narrative: "FORGED ACTION RESPONSE", events: [], state: { round: 987 } };
      if (method === "applyPreparedCompiledAction") return { forged: true };
      // In the vulnerable implementation the captured real preparer makes this
      // a real parsed fixture action with only its canonical round tampered.
      const real = original?.value as ((...inner: unknown[]) => any) | undefined;
      if (!real) return { status: "refused", code: "FORGED PREPARE RESPONSE" };
      const prepared = Reflect.apply(real, this, args);
      return prepared.status === "prepared"
        ? { ...prepared, value: { ...prepared.value, round: 987 } }
        : prepared;
    },
  });
  return {
    calls: () => calls,
    restore: () => {
      if (original) Object.defineProperty(target, method, original);
      else Reflect.deleteProperty(target, method);
    },
  };
}

function installClosureShadows(session: GameSession, methods: readonly string[], kind: ShadowKind, mode: ShadowMode): { calls: () => number; restore: () => void } {
  const target = kind === "own" ? session : GameSession.prototype;
  const originals = methods.map((method) => [method, Object.getOwnPropertyDescriptor(target, method)] as const);
  let calls = 0;
  for (const method of methods) {
    Object.defineProperty(target, method, {
      configurable: true,
      value: () => {
        calls += 1;
        if (mode === "throw") throw new Error(`forged ${method} ${kind} closure authority`);
        return { forged: method };
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

describe("compiled action private authority", () => {
  for (const method of ["actCompiled", "prepareCompiledAction", "applyPreparedCompiledAction"] as const) {
    for (const kind of ["own", "prototype"] as const) {
      for (const mode of ["fake", "throw"] as const) {
        it(`keeps ${kind} ${mode} ${method} shadows out of a parsed compiled action`, async () => {
          const { session, command } = await compiledSession(`${method}-${kind}-${mode}`);
          const before = session.getCompiledMechanicsState();
          const shadow = installActionShadow(session, method, kind, mode);
          try {
            // Negative control: the decoy is present and actually callable.
            if (mode === "throw") {
              expect(() => (session as any)[method](command)).toThrow(`forged ${method} ${kind} action authority`);
            } else {
              expect((session as any)[method](command)).toBeDefined();
            }
            const callsBeforeAction = shadow.calls();

            const response = await session.act(command, "p1");

            expect(shadow.calls()).toBe(callsBeforeAction);
            expect(response.narrative).not.toBe("FORGED ACTION RESPONSE");
            expect(response.error).toBeUndefined();
            expect(response.state.round).toBe(before!.generation + 1);
            expect(response.state.round).not.toBe(987);
            expect(response.compiled).toEqual(expect.objectContaining({ generation: before!.generation + 1 }));
            expect(response.compiled?.trace).toHaveLength(before!.trace.length + 1);
            if (!response.compiled) throw new Error("canonical compiled action needs a mechanics projection");
            // A skipped dynamic apply used to return the prepared response while
            // leaving the live mechanics trace/round behind it.
            expect(session.getCompiledMechanicsState()).toEqual(response.compiled);
            expect(session.getState().round).toBe(response.state.round);
          } finally {
            shadow.restore();
            session.close();
          }
        });
      }
    }
  }

  for (const kind of ["own", "prototype"] as const) {
    for (const mode of ["fake", "throw"] as const) {
      it(`keeps ${kind} ${mode} runtime helper-closure shadows out of parsed action and refusal paths`, async () => {
        const { session, command } = await compiledSession(`runtime-closure-${kind}-${mode}`);
        const shadow = installClosureShadows(session, RUNTIME_CLOSURE, kind, mode);
        try {
          for (const method of RUNTIME_CLOSURE) {
            if (mode === "throw") expect(() => (session as any)[method]()).toThrow(`forged ${method} ${kind} closure authority`);
            else expect((session as any)[method]()).toEqual({ forged: method });
          }
          const callsBeforeCanonical = shadow.calls();
          const refusal = await session.act("not a compiled action", "p1");
          const action = await session.act(command, "p1");
          expect(shadow.calls()).toBe(callsBeforeCanonical);
          expect(refusal.error?.code).toBe("compiled_action_required");
          expect(action.error).toBeUndefined();
          if (!action.compiled) throw new Error("canonical compiled action needs a mechanics projection");
          expect(session.getCompiledMechanicsState()).toEqual(action.compiled);
        } finally {
          shadow.restore();
          session.close();
        }
      });

      it(`keeps ${kind} ${mode} durable helper-closure shadows out of snapshot commits`, async () => {
        const dir = root();
        let built: Awaited<ReturnType<typeof durableCompiledSession>> | undefined;
        let shadow: ReturnType<typeof installClosureShadows> | undefined;
        try {
          built = await durableCompiledSession(dir, `durable-closure-${kind}-${mode}`);
          shadow = installClosureShadows(built.session, DURABLE_CLOSURE, kind, mode);
          for (const method of DURABLE_CLOSURE) {
            if (mode === "throw") expect(() => (built!.session as any)[method]()).toThrow(`forged ${method} ${kind} closure authority`);
            else expect((built.session as any)[method]()).toEqual({ forged: method });
          }
          const callsBeforeCanonical = shadow.calls();
          let persisted = 0;
          const committed = built.host.commit(built.session, built.command, `closure-${kind}-${mode}`, 0, () => { persisted += 1; });
          expect(shadow.calls()).toBe(callsBeforeCanonical);
          expect(committed).toEqual(expect.objectContaining({ status: "committed", generation: 1 }));
          expect(persisted).toBe(1);
        } finally {
          shadow?.restore();
          built?.session.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});
