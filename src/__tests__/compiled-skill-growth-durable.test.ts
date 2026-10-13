import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession, compiledMechanicsAction } from "../api/game-session";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotHash, validateCompiledSessionSnapshot, type CompiledSessionSnapshot } from "../api/compiled-session-snapshot";
import { ordinaryGameSessionSnapshotHash } from "../api/ordinary-game-session-snapshot";
import { resolveCompiler } from "../compiler/compiler-api";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { projectResolvedCompilerArtifact } from "../compiler/compiler-module-data-projection";
import { compiledModuleHttpFixture, hints } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost, type CompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

function root(): string {
  return mkdtempSync(join(tmpdir(), "compiled-skill-growth-"));
}

async function durableFixture(dir: string, configureInitialCharacter?: (snapshot: any) => void, fixtureOverride?: any, sessionId = "compiled-skill-growth") {
  const host = createCompiledDurableTestHost();
  const fixture = fixtureOverride ?? await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
  const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  const bundle = catalog.loadBundle(saved.value.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots"), allowUncoordinatedTestWrites: true });
  let session = new GameSession(sessionId, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", host.runtimeDependencies);
  if (configureInitialCharacter) {
    const ordinary = session.exportOrdinarySessionSnapshot();
    configureInitialCharacter(ordinary);
    const { snapshotHash: _discarded, ...unsigned } = ordinary;
    const restored = new GameSession(sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", host.runtimeDependencies);
    restored.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
    session.close();
    session = restored;
  }
  if (session.loadDurableCompiledModule(bundle.value).status !== "loaded") throw new Error("durable compiled fixture did not load");
  const initial = host.snapshot(session);
  if (snapshots.save(initial).status !== "ok") throw new Error("initial snapshot did not save");
  host.acknowledge(session, initial);
  const payload = fixture.resolved.artifact.payload as any;
  return {
    host, session, snapshots, bundle,
    ids: {
      parent: payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.id,
      entry: payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "entry_archive")!.id,
      child: payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_child")!.id,
      exit: payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "archive_exit")!.id,
    },
  };
}

/** A compiler-resolved ending that fires in the same checked discovery action, never a hand-edited IR. */
async function directTerminalCompiledFixture() {
  const fixture = await compiledModuleHttpFixture("compiled-skill-growth-direct-terminal");
  const terminalHints = hints(fixture.prepared);
  const child = (terminalHints.resolutions as any[]).find((entry) => entry.kind === "discovery_method" && entry.value?.spec?.id === "find_child");
  const ending = (terminalHints.resolutions as any[]).find((entry) => entry.kind === "ending_rule");
  if (!child || !ending) throw new Error("fixture lacks checked child or ending question");
  const clean = ending.value.declarations.find((entry: any) => entry.endingId === "clean");
  if (!clean) throw new Error("fixture lacks clean ending declaration");
  clean.spec.when = { kind: "clue_found", clueId: child.value.spec.clueId };
  const resolved = resolveCompiler(fixture.prepared.artifact, fixture.prepared.identity.preparedQueueHash, terminalHints);
  if (resolved.status !== "resolved") throw new Error(resolved.message);
  const payload: any = resolved.artifact.payload;
  const revelations = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    if (binding.shellAtoms.length || binding.findings.length) revelations.set(binding.clueId, binding.shellAtoms.map((atom: any) => atom.quote).join("\n") || payload.draft.clueCandidates.find((candidate: any) => candidate.id === binding.clueId).displayName);
    for (const finding of binding.findings) revelations.set(finding.clueId, finding.atoms.map((atom: any) => atom.quote).join("\n"));
  }
  const projection = projectResolvedCompilerArtifact(payload, {
    module: { title: "Direct terminal fixture", version: "1", ruleset: "cosmic-horror", era: "test", summary: "caller supplied", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id: string) => [id, { description: `scene:${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection: any) => [connection.id, { condition: `connection:${connection.id}` }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id: string) => [id, { findMethods: [], revelation: revelations.get(id) ?? `revelation:${id}`, unlocks: [], importance: "core" }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((entry: any) => [entry.effects.find((effect: any) => effect.kind === "end_game").endingId, { name: `ending:${entry.id}`, description: `ending:${entry.id}`, conditions: ["declared"] }])),
  });
  if (projection.status !== "projected") throw new Error(projection.message);
  return { prepared: fixture.prepared, resolved, projection };
}

// The direct-terminal artifact is immutable compiler output shared by the
// two skill outcomes below. Build it once as suite setup so the test's own
// 5s budget measures durable persistence/replay, not fixture compilation.
let directTerminalFixture: Awaited<ReturnType<typeof directTerminalCompiledFixture>> | undefined;
beforeAll(async () => {
  directTerminalFixture = await directTerminalCompiledFixture();
});

function commit(host: CompiledDurableTestHost, current: GameSession, snapshots: CompiledSessionSnapshotStore, mechanismId: string, actionId: string) {
  let persistenceMessage = "";
  const result = host.commit(current, compiledMechanicsAction(mechanismId), actionId, current.getCompiledGeneration()!, (snapshot) => {
    const saved = snapshots.save(snapshot);
    if (saved.status !== "ok") { persistenceMessage = saved.message; throw new Error(saved.message); }
  });
  if (result.status !== "committed") throw new Error(`compiled action was not committed: ${JSON.stringify(result)} ${persistenceMessage}`);
  expect(result.status).toBe("committed");
  return result;
}

function restore(host: CompiledDurableTestHost, snapshot: unknown, bundle: any, dir: string): GameSession {
  const restored = new GameSession((snapshot as any)?.sessionId ?? "compiled-skill-growth", "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "restored-careers") }, undefined, "preferred", host.runtimeDependencies);
  const result = restored.restoreCompiledSession(snapshot, bundle);
  if (result.status !== "loaded") throw new Error(result.message);
  return restored;
}

describe("compiled checked-skill durable growth", () => {
  it("accepts a receipt-free 3.1 chain only when its character frame has exact continuity", async () => {
    const dir = root();
    try {
      const built = await durableFixture(dir);
      const parent = commit(built.host, built.session, built.snapshots, built.ids.parent, "legacy-parent");
      const legacy = structuredClone(parent.snapshot!) as any;
      legacy.schemaVersion = "3.1.0";
      legacy.components = { snapshot: "3.1.0", mechanics: legacy.components.mechanics, gameSession: "3.1.0" };
      for (const record of legacy.idempotency) {
        record.response.schemaVersion = "1.3.0";
        delete record.response.action.skillGrowthReceipt;
      }
      legacy.snapshotHash = compiledSessionSnapshotHash(legacy);
      expect(restore(built.host, legacy, built.bundle.value, dir).getCompiledGeneration()).toBe(1);

      const schemaMismatches: Array<{ name: string; snapshot: any }> = [
        {
          name: "3.1-with-1.4-receipt",
          snapshot: (() => {
            const value = structuredClone(parent.snapshot!);
            value.schemaVersion = "3.1.0";
            value.components = { snapshot: "3.1.0", mechanics: value.components.mechanics, gameSession: "3.1.0" };
            return value;
          })(),
        },
        {
          name: "2.9-with-1.4-receipt",
          snapshot: (() => {
            const value = structuredClone(parent.snapshot!);
            value.schemaVersion = "2.9.0";
            value.components = { snapshot: "2.9.0", mechanics: value.components.mechanics, gameSession: "2.9.0" };
            return value;
          })(),
        },
        {
          name: "3.2-with-1.3-without-receipt",
          snapshot: (() => {
            const value = structuredClone(parent.snapshot!);
            for (const record of value.idempotency) {
              record.response.schemaVersion = "1.3.0";
              delete record.response.action.skillGrowthReceipt;
            }
            return value;
          })(),
        },
      ];
      for (const { name, snapshot } of schemaMismatches) {
        snapshot.snapshotHash = compiledSessionSnapshotHash(snapshot);
        const rejected = new GameSession("compiled-skill-growth", "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, name) });
        const before = rejected.world.exportSnapshot();
        expect(rejected.restoreCompiledSession(snapshot, built.bundle.value).status).toBe("refused");
        expect(rejected.world.exportSnapshot()).toEqual(before);
        rejected.close();
      }

      const forged = structuredClone(legacy);
      forged.idempotency[0].characterBefore.sheet.skillValues.library_use += 1;
      forged.snapshotHash = compiledSessionSnapshotHash(forged);
      const rejected = new GameSession("compiled-skill-growth", "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "legacy-forged") });
      const before = rejected.world.exportSnapshot();
      expect(rejected.restoreCompiledSession(forged, built.bundle.value).status).toBe("refused");
      expect(rejected.world.exportSnapshot()).toEqual(before);
      rejected.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps five exact snapshot-version branches and restricts narration topic anchors to 3.4", async () => {
    const dir = root();
    try {
      const built = await durableFixture(dir);
      const parent = commit(built.host, built.session, built.snapshots, built.ids.parent, "version-mapping-parent");
      const current = structuredClone(parent.snapshot!) as any;
      const asHistorical = (schemaVersion: "3.3.0" | "3.2.0" | "3.1.0" | "2.9.0", responseVersion: "1.5.0" | "1.4.0" | "1.3.0") => {
        const value = structuredClone(current) as any;
        value.schemaVersion = schemaVersion;
        value.components = { snapshot: schemaVersion, mechanics: value.components.mechanics, gameSession: schemaVersion };
        for (const record of value.idempotency) {
          record.response.schemaVersion = responseVersion;
          if (responseVersion === "1.3.0") delete record.response.action.skillGrowthReceipt;
        }
        value.snapshotHash = compiledSessionSnapshotHash(value);
        return value;
      };
      const historical = [
        current,
        asHistorical("3.3.0", "1.5.0"),
        asHistorical("3.2.0", "1.4.0"),
        asHistorical("3.1.0", "1.3.0"),
        asHistorical("2.9.0", "1.3.0"),
      ];
      for (const snapshot of historical) {
        const checked = validateCompiledSessionSnapshot(snapshot);
        expect(checked).toMatchObject({ status: "ok" });
        if (checked.status === "ok") {
          expect(checked.value.schemaVersion).toBe(snapshot.schemaVersion);
          expect(checked.value.snapshotHash).toBe(snapshot.snapshotHash);
        }
      }

      // A persisted 3.3 value remains itself during hydration. Only the new
      // successor is 3.4; no reader relabels or rehashes the historical body.
      const v33Built = await durableFixture(join(dir, "v33-source"), undefined, undefined, "compiled-skill-growth-v33");
      const v33Store = v33Built.snapshots;
      let persistedV33: any;
      const v33Commit = v33Built.host.commit(
        v33Built.session,
        compiledMechanicsAction(v33Built.ids.parent),
        "v33-historical-parent",
        v33Built.session.getCompiledGeneration()!,
        (snapshot) => {
          persistedV33 = structuredClone(snapshot) as any;
          persistedV33.schemaVersion = "3.3.0";
          persistedV33.components = { snapshot: "3.3.0", mechanics: persistedV33.components.mechanics, gameSession: "3.3.0" };
          persistedV33.snapshotHash = compiledSessionSnapshotHash(persistedV33);
          expect(v33Store.save(persistedV33)).toMatchObject({ status: "ok" });
        },
      );
      expect(v33Commit.status).toBe("committed");
      expect(validateCompiledSessionSnapshot(persistedV33)).toMatchObject({ status: "ok" });
      const restoredV33 = restore(v33Built.host, persistedV33, v33Built.bundle.value, join(dir, "v33-hydrate"));
      expect(restoredV33.getCompiledGeneration()).toBe(1);
      const successor = commit(v33Built.host, restoredV33, v33Store, v33Built.ids.entry, "v33-to-v34-successor");
      expect(successor.snapshot?.schemaVersion).toBe("3.4.0");
      const restartedV34 = restore(v33Built.host, successor.snapshot!, v33Built.bundle.value, join(dir, "v34-restart"));
      expect(restartedV34.getCompiledGeneration()).toBe(2);
      v33Built.session.close();
      restoredV33.close();
      restartedV34.close();

      const validAnchor = {
        schemaVersion: "1.0.0",
        predecessorSnapshotHash: current.previousSnapshotHash,
        topicTokenHash: "a".repeat(64),
        topicBindingHash: "b".repeat(64),
        playerRequestHash: "c".repeat(64),
      };
      const oldAnchor = asHistorical("3.3.0", "1.5.0");
      oldAnchor.idempotency[0].narrationTopic = structuredClone(validAnchor);
      oldAnchor.snapshotHash = compiledSessionSnapshotHash(oldAnchor);
      expect(validateCompiledSessionSnapshot(oldAnchor)).toMatchObject({ status: "refused" });

      const malformedCurrent = structuredClone(current) as any;
      malformedCurrent.idempotency[0].narrationTopic = { ...validAnchor, topicTokenHash: "not-a-hash" };
      malformedCurrent.snapshotHash = compiledSessionSnapshotHash(malformedCurrent);
      expect(validateCompiledSessionSnapshot(malformedCurrent)).toMatchObject({ status: "refused" });

      const rawLeakingCurrent = structuredClone(current) as any;
      rawLeakingCurrent.idempotency[0].narrationTopic = { ...validAnchor, playerInput: "must not persist" };
      rawLeakingCurrent.snapshotHash = compiledSessionSnapshotHash(rawLeakingCurrent);
      expect(validateCompiledSessionSnapshot(rawLeakingCurrent)).toMatchObject({ status: "refused" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not mark failed checks or their failback replay", async () => {
    const dir = root();
    const originalRandom = Math.random;
    try {
      const built = await durableFixture(dir);
      let current = built.session;
      const parent = commit(built.host, current, built.snapshots, built.ids.parent, "failed-parent");
      current = restore(built.host, parent.snapshot!, built.bundle.value, dir);
      const entry = commit(built.host, current, built.snapshots, built.ids.entry, "failed-entry");
      current = restore(built.host, entry.snapshot!, built.bundle.value, dir);
      Math.random = () => 0.99;
      const failure = commit(built.host, current, built.snapshots, built.ids.child, "failed-check");
      expect((failure.response.action as any).skillGrowthReceipt).toMatchObject({
        successfulSkills: [], pendingBefore: [], pendingAfter: [], settlements: [],
      });
      current = restore(built.host, failure.snapshot!, built.bundle.value, dir);
      const secondFailure = commit(built.host, current, built.snapshots, built.ids.child, "failed-check-again");
      expect((secondFailure.response.action as any).skillGrowthReceipt).toMatchObject({
        successfulSkills: [], pendingBefore: [], pendingAfter: [], settlements: [],
      });
      current = restore(built.host, secondFailure.snapshot!, built.bundle.value, dir);
      const failback = commit(built.host, current, built.snapshots, built.ids.child, "check-failback");
      expect((failback.response.action as any).compiled.trace.at(-1)).toMatchObject({
        mechanismId: built.ids.child, outcome: "failback",
      });
      expect((failback.response.action as any).skillGrowthReceipt).toMatchObject({
        successfulSkills: [], pendingBefore: [], pendingAfter: [], settlements: [],
      });
    } finally {
      Math.random = originalRandom;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists and restores a terminal no-growth receipt for a valid 100% CoC skill", async () => {
    const dir = root();
    const originalRandom = Math.random;
    try {
      const built = await durableFixture(dir, (snapshot) => {
        const p1 = snapshot.state.characters.find((entry: any) => entry.pcId === "p1");
        if (!p1) throw new Error("ordinary fixture lacks p1");
        p1.sheet.skillValues.library_use = 100;
      });
      let current = built.session;
      const parent = commit(built.host, current, built.snapshots, built.ids.parent, "hundred-parent");
      current = restore(built.host, parent.snapshot!, built.bundle.value, dir);
      const entry = commit(built.host, current, built.snapshots, built.ids.entry, "hundred-entry");
      current = restore(built.host, entry.snapshot!, built.bundle.value, dir);
      Math.random = () => 0;
      const checked = commit(built.host, current, built.snapshots, built.ids.child, "hundred-check");
      current = restore(built.host, checked.snapshot!, built.bundle.value, dir);
      const terminal = commit(built.host, current, built.snapshots, built.ids.exit, "hundred-terminal");
      const settlement = (terminal.response.action as any).skillGrowthReceipt.settlements[0];
      expect(settlement).toMatchObject({ skill: "library_use", currentSkill: 100, increased: false, increase: 0, newValue: 100 });
      expect(restore(built.host, terminal.snapshot!, built.bundle.value, dir).activeCharacter?.skillValues.library_use).toBe(100);
    } finally {
      Math.random = originalRandom;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("folds the current successful mark before same-action terminal settlement", async () => {
    const originalRandom = Math.random;
    const direct = directTerminalFixture;
    if (!direct) throw new Error("direct terminal compiler fixture was not prepared");
    try {
      const outcomes: Array<{ skill: number; sessionId: string; increased: boolean }> = [
        { skill: 10, sessionId: "compiled-growth-increase", increased: true },
        { skill: 100, sessionId: "compiled-growth-no-increase", increased: false },
      ];
      for (const expected of outcomes) {
        const dir = root();
        try {
          const built = await durableFixture(dir, (snapshot) => {
            const p1 = snapshot.state.characters.find((entry: any) => entry.pcId === "p1");
            if (!p1) throw new Error("ordinary fixture lacks p1");
            p1.sheet.skillValues.library_use = expected.skill;
          }, direct, expected.sessionId);
          let current = built.session;
          const parent = commit(built.host, current, built.snapshots, built.ids.parent, `${expected.sessionId}-parent`);
          current = restore(built.host, parent.snapshot!, built.bundle.value, dir);
          const entry = commit(built.host, current, built.snapshots, built.ids.entry, `${expected.sessionId}-entry`);
          current = restore(built.host, entry.snapshot!, built.bundle.value, dir);
          Math.random = () => 0;
          const terminal = commit(built.host, current, built.snapshots, built.ids.child, `${expected.sessionId}-checked-terminal`);
          const receipt = (terminal.response.action as any).skillGrowthReceipt;
          expect(receipt).toMatchObject({
            mechanismId: built.ids.child,
            successfulSkills: ["library_use"],
            pendingBefore: [], pendingAfter: [], terminalEndingId: "clean",
          });
          expect(receipt.settlements).toHaveLength(1);
          expect(receipt.settlements[0]).toMatchObject({ skill: "library_use", currentSkill: expected.skill, increased: expected.increased });
          expect(((terminal.snapshot?.character.sheet.skillValues ?? {}) as Record<string, unknown>).library_use).toBe(receipt.settlements[0].newValue);
          expect(restore(built.host, terminal.snapshot!, built.bundle.value, dir).activeCharacter?.skillValues.library_use).toBe(receipt.settlements[0].newValue);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    } finally { Math.random = originalRandom; }
  });

  it("records a successful checked discovery as a canonical pending CoC skill mark", async () => {
    const dir = root();
    const originalRandom = Math.random;
    try {
      const built = await durableFixture(dir);
      let current = built.session;
      const parent = commit(built.host, current, built.snapshots, built.ids.parent, "parent");
      expect((parent.response.action as any).skillGrowthReceipt).toMatchObject({ successfulSkills: [], pendingBefore: [], pendingAfter: [], settlements: [] });
      current = restore(built.host, parent.snapshot!, built.bundle.value, dir);
      const entry = commit(built.host, current, built.snapshots, built.ids.entry, "entry");
      expect((entry.response.action as any).skillGrowthReceipt).toMatchObject({ successfulSkills: [], pendingBefore: [], pendingAfter: [], settlements: [] });
      current = restore(built.host, entry.snapshot!, built.bundle.value, dir);
      Math.random = () => 0;
      const checked = commit(built.host, current, built.snapshots, built.ids.child, "checked-success");
      const receipt = (checked.response.action as any).skillGrowthReceipt;
      expect(receipt).toMatchObject({
        generation: 3,
        mechanismId: built.ids.child,
        successfulSkills: ["library_use"],
        pendingBefore: [],
        pendingAfter: ["library_use"],
        terminalEndingId: null,
        settlements: [],
      });
      expect((checked.snapshot?.character.sheet.skillValues as Record<string, unknown>)?.library_use).toBe((checked.snapshot?.initialCharacter.sheet.skillValues as Record<string, unknown>)?.library_use);
      const restarted = restore(built.host, checked.snapshot!, built.bundle.value, dir);
      const terminal = commit(built.host, restarted, built.snapshots, built.ids.exit, "terminal");
      const terminalReceipt = (terminal.response.action as any).skillGrowthReceipt;
      expect(terminalReceipt).toMatchObject({
        generation: 4,
        pendingBefore: ["library_use"],
        pendingAfter: [],
        terminalEndingId: expect.any(String),
      });
      expect(terminalReceipt.settlements).toHaveLength(1);
      expect(terminalReceipt.settlements[0]).toMatchObject({ skill: "library_use", storageKey: "library_use" });
      const settlement = terminalReceipt.settlements[0];
      expect(settlement.newValue).toBe(settlement.increased ? Math.min(99, settlement.currentSkill + settlement.increase) : settlement.currentSkill);
      expect((terminal.snapshot?.character.sheet.skillValues as Record<string, unknown>)?.library_use).toBe(settlement.newValue);
      const replay = restore(built.host, terminal.snapshot!, built.bundle.value, dir);
      const duplicate = built.host.commit(replay, compiledMechanicsAction(built.ids.exit), "terminal", 3, () => { throw new Error("duplicate must not persist"); });
      expect(duplicate).toMatchObject({ status: "duplicate", generation: 4 });
      if (duplicate.status === "duplicate") expect(duplicate.response).toEqual(terminal.response);

      const tamper: Array<(snapshot: any) => void> = [
        (snapshot) => { snapshot.idempotency[2].response.action.skillGrowthReceipt.successfulSkills = []; },
        (snapshot) => { snapshot.idempotency[3].response.action.skillGrowthReceipt.settlements[0].roll = 1; },
        (snapshot) => { snapshot.idempotency[3].response.action.skillGrowthReceipt.beforeStateHash = "forged"; },
        (snapshot) => { snapshot.idempotency[3].characterBefore.sheet.skillValues.library_use += 1; },
        (snapshot) => { snapshot.character.sheet.skillValues.library_use = Math.max(0, snapshot.character.sheet.skillValues.library_use - 1); },
      ];
      for (const [index, mutate] of tamper.entries()) {
        const forged = structuredClone(terminal.snapshot!) as CompiledSessionSnapshot;
        mutate(forged);
        forged.snapshotHash = compiledSessionSnapshotHash(forged);
        const rejected = new GameSession("compiled-skill-growth", "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, `forged-${index}`) });
        const before = rejected.world.exportSnapshot();
        expect(rejected.restoreCompiledSession(forged, built.bundle.value).status).toBe("refused");
        expect(rejected.world.exportSnapshot()).toEqual(before);
        rejected.close();
      }
    } finally {
      Math.random = originalRandom;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
