import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession, compiledMechanicsAction } from "../api/game-session";
import type { CompiledSessionSnapshot } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog, type LoadedBundleCatalogEntry } from "../compiler/compiler-artifact-catalog";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import {
  MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  type CompilerQuestion,
  type CompilerQuestionResolution,
  type ModuleCompileHints,
} from "../compiler/compiler-question-queue";
import {
  projectResolvedCompilerArtifact,
  type CompilerModuleDataProjection,
  type ModuleDataPresentationMetadata,
} from "../compiler/compiler-module-data-projection";
import { createCompiledDurableTestHost, type CompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { allShellClueFactFacetResolutions, clueFactFacetRevelations } from "./helpers/clue-fact-facet-hints";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

/**
 * A player critical versus a failed NPC dodge. All-zero entropy would make
 * both rolls critical; under CoC's current dodge rule that equal success level
 * belongs to the defender, so it is deliberately not a defeating exchange.
 */
function combatRuntime() {
  const units = [0, 0.2];
  let index = 0;
  return { compiledCombatRandom: () => units[index++ % units.length]! };
}

type EncounterFixture = {
  resolvedArtifact: unknown;
  payload: ResolvedCompilerArtifactPayload;
  projection: CompilerModuleDataProjection;
  ids: {
    foyer: string;
    pit: string;
    staticNpc: string;
    encounterNpc: string;
    encounter: string;
    moveToEncounter: string;
  };
};

function answer(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
  return {
    questionId: question.id,
    kind: question.kind,
    value,
    sourceStatementIds: [...question.sourceStatementIds],
    evidenceRefs: [...question.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "reviewed encounter lifecycle fixture",
  };
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const facets = clueFactFacetRevelations(payload.clueFactFacetBindings);
  return {
    module: { title: "Encounter lifecycle", version: "1", ruleset: "cosmic-horror", era: "test", summary: "test", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: `scene:${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: `connection:${connection.id}` }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => [id, { findMethods: [], revelation: facets.get(id) ?? `revelation:${id}`, unlocks: [], importance: "core" as const }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((ending) => {
      const endingId = ending.effects.find((effect) => effect.kind === "end_game")!.endingId;
      return [endingId, { name: ending.id, description: `ending:${ending.id}`, conditions: ["test"] }];
    })),
  };
}

function lifecycleHints(prepared: PreparedCompilerApiResult, entryAtEncounter: boolean): ModuleCompileHints {
  const { draft, preparedQueue: queue, graph } = prepared.artifact.payload;
  const foyer = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Foyer"))!;
  const pit = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Pit"))!;
  const exit = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit"))!;
  const staticAnchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("Nia"))!;
  const encounterAnchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("Mira"))!;
  const stats = graph.statements.find((statement) => statement.id === encounterAnchor.paragraphStatementId)!;
  const question = (kind: CompilerQuestion["kind"], subject?: string) => queue.questions.find((candidate) => candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject))!;
  const topology = entryAtEncounter
    ? [
        answer(question("connection_topology", pit.id), { connections: [{ toSceneCandidateId: foyer.id, connectionId: "pit_foyer" }] }),
        answer(question("connection_topology", foyer.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "foyer_exit" }] }),
      ]
    : [
        answer(question("connection_topology", foyer.id), { connections: [{ toSceneCandidateId: pit.id, connectionId: "foyer_pit" }] }),
        answer(question("connection_topology", pit.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "pit_exit" }] }),
      ];
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...allShellClueFactFacetResolutions(queue.questions, answer),
      ...queue.questions.filter((candidate) => candidate.kind === "scene_role").map((candidate) => answer(candidate, { role: "playable_scene" })),
      answer(question("entry_scene"), { sceneCandidateId: entryAtEncounter ? pit.id : foyer.id }),
      ...topology,
      answer(question("connection_topology", exit.id), { connections: [] }),
      answer(question("ending_rule"), { declarations: [{ endingId: "leave", spec: { kind: "ending_rule", id: "rule_leave", priority: 1, when: { kind: "scene_visited", sceneId: exit.id }, effects: [{ kind: "end_game", endingId: "leave" }] } }] }),
      ...draft.clueCandidates.map((clue, index) => answer(question("discovery_method", clue.id), {
        clueCandidateId: clue.id,
        locationSceneCandidateId: clue.sceneCandidateId,
        spec: { kind: "discovery_method", id: `search_${index}`, clueId: clue.id, action: "search", target: "scene", targetId: clue.sceneCandidateId, onSuccess: [{ kind: "discover_clue", clueId: clue.id }] },
      })),
      answer(question("npc_binding", staticAnchor.id), {
        proseAnchorId: staticAnchor.id,
        presentNpcs: [{ nameQuote: "Nia", dialogueMethods: [] }],
      }),
      answer(question("npc_binding", encounterAnchor.id), {
        proseAnchorId: encounterAnchor.id,
        presentNpcs: [{
          nameQuote: "Mira",
          dialogueMethods: [],
          encounter: {
            maxHp: { statementId: stats.id, quote: "HP 1" },
            dodge: { statementId: stats.id, quote: "Dodge 0" },
            fight: { statementId: stats.id, quote: "Fight 0" },
            npcDamage: { statementId: stats.id, quote: "Damage 1" },
          },
        }],
      }),
    ],
  };
}

async function encounterFixture(entryAtEncounter = false): Promise<EncounterFixture> {
  const suffix = entryAtEncounter ? "entry" : "remote";
  const prepared = await prepareCompiler({
    kind: "synthetic_pages",
    moduleId: `encounter-lifecycle-${suffix}`,
    sourceDescriptor: `encounter-lifecycle-${suffix}`,
    pages: ["Foyer:\nClerk Nia waits at the desk.\n\u25b6 Welcome Note: It records the visitor.\nPit:\nCaptain Mira guards the gate. HP 1. Dodge 0. Fight 0. Damage 1.\n\u25b6 Gate Key: It opens the exit.\nExit:"],
  });
  if (prepared.status === "refused") throw new Error(prepared.message);
  const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, lifecycleHints(prepared, entryAtEncounter));
  if (resolved.status === "refused") throw new Error(resolved.message);
  const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
  const projected = projectResolvedCompilerArtifact(payload, presentation(payload));
  if (projected.status === "refused") throw new Error(projected.message);
  const foyer = payload.mechanicsIR.symbols.sceneIds.find((id) => projected.module.scenes.find((scene) => scene.id === id)?.name.startsWith("Foyer"))!;
  const pit = payload.mechanicsIR.symbols.sceneIds.find((id) => projected.module.scenes.find((scene) => scene.id === id)?.name.startsWith("Pit"))!;
  const definition = payload.mechanicsIR.encounterDefinitions[0]!;
  const staticNpc = projected.module.npcs.find((npc) => npc.name === "Nia")!;
  return {
    resolvedArtifact: resolved.artifact,
    payload,
    projection: projected,
    ids: {
      foyer,
      pit,
      staticNpc: staticNpc.id,
      encounterNpc: definition.combatantId,
      encounter: definition.encounterId,
      moveToEncounter: payload.mechanicsIR.connections.find((connection) => connection.connectionId === "foyer_pit")?.id ?? "",
    },
  };
}

function saveBundle(dir: string, fixture: EncounterFixture): LoadedBundleCatalogEntry {
  const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
  const saved = catalog.saveBundle(fixture.resolvedArtifact, fixture.projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  const loaded = catalog.loadBundle(saved.value.id);
  if (loaded.status !== "ok") throw new Error(loaded.message);
  return loaded.value;
}

interface DurableEncounterSession {
  readonly host: CompiledDurableTestHost;
  readonly session: GameSession;
}

function restore(snapshot: CompiledSessionSnapshot, bundle: LoadedBundleCatalogEntry, dir: string): DurableEncounterSession {
  const host = createCompiledDurableTestHost();
  const session = new GameSession(
    snapshot.sessionId, "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(dir, "careers") },
    undefined, "preferred", { ...combatRuntime(), ...host.runtimeDependencies },
  );
  const result = session.restoreCompiledSession(snapshot, bundle);
  if (result.status === "refused") throw new Error(result.message);
  return { host, session };
}

function expectPendingEncounter(session: GameSession, fixture: EncounterFixture): void {
  expect(session.getCompiledMechanicsState()?.state.encounters[fixture.ids.encounter]).toBeUndefined();
  const mirrored = session.world.getEntity(fixture.ids.encounterNpc);
  if (mirrored) {
    expect(mirrored.type).toBe("npc");
    expect(mirrored.status).not.toContain("hostile");
  }
  expect(session.world.getEntity(fixture.ids.staticNpc)).toMatchObject({ type: "npc", status: ["narrative_noncombat"] });
}

describe("compiled encounter projection lifecycle", () => {
  it("keeps a remote encounter pending, then mirrors active and defeated mechanics state across snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compiled-encounter-lifecycle-"));
    const processCrypto = globalThis.crypto;
    try {
      const fixture = await encounterFixture();
      const live = new GameSession("encounterlifecycle-live", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, undefined, undefined, "preferred", combatRuntime());
      expect(live.loadCompiledModule(fixture.payload, fixture.projection)).toMatchObject({ status: "loaded" });
      expectPendingEncounter(live, fixture);
      const liveMove = await live.act(compiledMechanicsAction(fixture.ids.moveToEncounter));
      expect(liveMove.compiled?.state.encounters[fixture.ids.encounter]).toEqual({ status: "active", currentHp: 1 });
      expect(live.world.getEntity(fixture.ids.encounterNpc)).toMatchObject({ type: "monster", hp: 1, maxHp: 1, status: ["hostile"], scene_id: fixture.ids.pit });
      expect(liveMove.state.monsters).toEqual([{ name: "Mira", hp: 1, maxHp: 1, status: ["hostile"] }]);

      const bundle = saveBundle(dir, fixture);
      const initialHost = createCompiledDurableTestHost();
      const initial = new GameSession(
        "encounterlifecycle", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") },
        undefined, "preferred", { ...combatRuntime(), ...initialHost.runtimeDependencies },
      );
      expect(initial.loadDurableCompiledModule(bundle)).toMatchObject({ status: "loaded" });
      expectPendingEncounter(initial, fixture);
      expect(initial.getCompiledAvailableActions().some((action) => action.kind === "combat")).toBe(false);

      const initialSnapshot = initialHost.snapshot(initial);
      initialHost.acknowledge(initial, initialSnapshot);
      let current = restore(initialSnapshot, bundle, dir);
      expectPendingEncounter(current.session, fixture);

      const moved = current.host.commit(current.session, compiledMechanicsAction(fixture.ids.moveToEncounter), "move-to-encounter", 0, () => undefined);
      expect(moved.status).toBe("committed");
      if (moved.status !== "committed" || !moved.snapshot) throw new Error(`move did not commit: ${moved.status}`);
      expect(moved.snapshot.state.encounters[fixture.ids.encounter]).toEqual({ status: "active", currentHp: 1 });
      current = restore(moved.snapshot, bundle, dir);
      expect(current.session.world.getEntity(fixture.ids.encounterNpc)).toMatchObject({ type: "monster", hp: 1, maxHp: 1, status: ["hostile"], scene_id: fixture.ids.pit });
      expect(current.session.world.getEntity(fixture.ids.staticNpc)).toMatchObject({ type: "npc", status: ["narrative_noncombat"] });

      const attacked = current.host.commit(current.session, `@compiled attack:${fixture.ids.encounter}`, "defeat-encounter", 1, () => undefined);
      expect(attacked.status).toBe("committed");
      if (attacked.status !== "committed" || !attacked.snapshot) throw new Error(`attack did not commit: ${attacked.status}`);
      expect(attacked.response.action.combatSettlement).toMatchObject({
        mechanismId: `attack:${fixture.ids.encounter}`,
        randomUnits: [0, 0.2],
        player: { roll: 1, defenseRoll: 21, hit: true, damage: 1 },
        enemy: null,
        outcome: { hit: true, damage: 1, enemyHit: false, actorDamage: 0, actorDefeated: false },
      });
      expect(attacked.snapshot.state.encounters[fixture.ids.encounter]).toEqual({ status: "defeated", currentHp: 0 });
      current = restore(attacked.snapshot, bundle, dir);
      expect(current.session.world.getEntity(fixture.ids.encounterNpc)).toMatchObject({ type: "monster", hp: 0, maxHp: 1, status: ["defeated"] });
      expect(current.session.getState().monsters).toEqual([{ name: "Mira", hp: 0, maxHp: 1, status: ["defeated"] }]);
      expect(current.session.world.getEntity(fixture.ids.staticNpc)).toMatchObject({ type: "npc", status: ["narrative_noncombat"] });
      expect(globalThis.crypto).toBe(processCrypto);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mirrors an entry-scene encounter as hostile after initial automatic settlement", async () => {
    const fixture = await encounterFixture(true);
    const session = new GameSession("entryencounter", "cosmic-horror", CONFIG, "investigator", "Ada");
    expect(session.loadCompiledModule(fixture.payload, fixture.projection)).toMatchObject({ status: "loaded" });
    expect(session.getCompiledMechanicsState()?.state.encounters[fixture.ids.encounter]).toEqual({ status: "active", currentHp: 1 });
    expect(session.world.getEntity(fixture.ids.encounterNpc)).toMatchObject({ type: "monster", hp: 1, maxHp: 1, status: ["hostile"] });
    expect(session.world.getEntity(fixture.ids.staticNpc)).toMatchObject({ type: "npc", status: ["narrative_noncombat"] });
  });

  it("rejects an invalid instance-scoped combat entropy unit without mutating encounter state", async () => {
    const fixture = await encounterFixture(true);
    let draws = 0;
    const session = new GameSession("invalidcombatentropy", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, undefined, undefined, "preferred", { compiledCombatRandom: () => { draws++; return 1; } });
    expect(session.loadCompiledModule(fixture.payload, fixture.projection)).toMatchObject({ status: "loaded" });
    const before = session.getCompiledMechanicsState();
    const refused = await session.act(`@compiled attack:${fixture.ids.encounter}`);
    expect(refused.error?.code).toBe("compiled_action_unavailable");
    expect(draws).toBe(1);
    expect(session.getCompiledMechanicsState()).toEqual(before);
    expect(session.world.getEntity(fixture.ids.encounterNpc)).toMatchObject({ type: "monster", hp: 1, status: ["hostile"] });
  });

  it("settles compiled combat with the constructor-selected entropy after a same-name runtime shadow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compiled-combat-runtime-shadow-"));
    const fixture = await encounterFixture(true);
    const bundle = saveBundle(dir, fixture);
    const host = createCompiledDurableTestHost();
    const session = new GameSession(
      "compiled-combat-runtime-shadow",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      undefined,
      undefined,
      "preferred",
      { ...combatRuntime(), ...host.runtimeDependencies },
    );
    try {
      expect(session.loadDurableCompiledModule(bundle)).toMatchObject({ status: "loaded" });
      host.acknowledge(session, host.snapshot(session));
      expect(Reflect.set(session as unknown as Record<string, unknown>, "compiledCombatRandom", () => 0.99)).toBe(true);

      const attacked = host.commit(
        session,
        `@compiled attack:${fixture.ids.encounter}`,
        "compiled-combat-runtime-shadow-action",
        session.getCompiledGeneration()!,
        () => undefined,
      );
      expect(attacked.status).toBe("committed");
      if (attacked.status !== "committed") throw new Error("compiled combat did not commit");
      expect(attacked.response.action.combatSettlement).toMatchObject({
        randomUnits: [0, 0.2],
        player: { roll: 1, defenseRoll: 21, hit: true, damage: 1 },
        outcome: { hit: true, damage: 1, enemyHit: false, actorDamage: 0, actorDefeated: false },
      });
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
