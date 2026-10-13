import { describe, expect, it } from "bun:test";
import {
  compileMechanics,
  parseMechanicsCandidateSpec,
  validateMechanicsIR,
  type EncounterDefinitionSpec,
  type MechanicsCandidateSpec,
  type MechanicsCompilationInput,
  type MechanicsSymbols,
} from "../compiler/mechanics-ir";
import {
  analyzeMechanicsReachability,
  replayMechanicsWitness,
  type MechanicsAnalysisInput,
} from "../compiler/mechanics-reachability";
import {
  availableMechanicsPlayerActions,
  applyMechanicsEffects,
  executeMechanicsAction,
  initialMechanicsState,
  settleAutomaticMechanics,
  type MechanicsCombatOutcome,
} from "../compiler/mechanics-execution";
import { validateCompiledMechanicsSnapshotState } from "../api/compiled-session-snapshot";
import {
  applyFactInterpretationReviews,
  buildSourceFactGraph,
  sourceStatementEvidenceRefId,
  type FactInterpretationCandidate,
} from "../compiler/source-fact-graph";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";

const symbols: MechanicsSymbols = {
  clueIds: ["clue_wait"],
  sceneIds: ["scene_cell", "scene_exit"],
  itemIds: [],
  npcIds: ["npc_guard"],
  connectionIds: ["connection_exit"],
  encounterIds: ["encounter_guard"],
  endingIds: ["ending_free"],
  rewardIds: [],
  declaredStateKeys: ["guard_defeated"],
};

function compileFixture(specs: MechanicsCandidateSpec[], fixtureSymbols = symbols, sourceStatementIds?: string[]) {
  const document = createSyntheticDocumentIR(["Source-bound combat fixture."], "compiled-combat-core");
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const statementId = graph.statements[0]!.id;
  const candidates: FactInterpretationCandidate<MechanicsCandidateSpec>[] = specs.map((value) => ({
    id: `accepted:${value.id}`,
    sourceStatementIds: sourceStatementIds ?? [statementId],
    claim: {
      path: `mechanics.${value.kind}.${value.id}`,
      value,
      domain: "gameplay_mechanic",
      authority: "module_explicit",
      derivation: "explicit",
      status: "candidate",
      evidenceRefs: [sourceStatementEvidenceRefId(statementId)],
      sourceRef: null,
      confidence: null,
      reason: "source-bound combat fixture",
      rightsStatus: "user_provided",
      scope: { moduleId: "compiled-combat-core" },
    },
    interpretationStatus: "candidate",
  }));
  const reviewed = applyFactInterpretationReviews({ ...graph, interpretations: candidates }, candidates.map((candidate) => ({
    interpretationId: candidate.id,
    decision: "accept" as const,
    reason: "fixture acceptance",
    reviewerKind: "deterministic_rule" as const,
    policyId: "compiled-combat-core-v1",
    reviewEvidenceStatementIds: [statementId],
  })));
  const input: MechanicsCompilationInput = {
    moduleId: "compiled-combat-core",
    documentHash: null,
    sourceGraphSchemaVersion: "1.1.0",
    symbols: fixtureSymbols,
    acceptedInterpretationIds: candidates.map((candidate) => candidate.id),
  };
  return compileMechanics(reviewed, input);
}

function fixture() {
  const encounter: EncounterDefinitionSpec = {
    kind: "encounter_definition",
    id: "encounter_guard",
    encounterId: "encounter_guard",
    sceneId: "scene_cell",
    combatantId: "npc_guard",
    maxHp: 2,
    dodge: 20,
    fight: 40,
    npcDamage: { kind: "fixed", amount: 1 },
    victoryEffects: [{ kind: "set_state", stateKey: "guard_defeated", value: true }],
  };
  const ir = compileFixture([
    encounter,
    {
      kind: "discovery_method", id: "wait", clueId: "clue_wait", action: "observe", target: "scene", targetId: "scene_cell",
      onSuccess: [{ kind: "discover_clue", clueId: "clue_wait" }],
    },
    { kind: "connection_gate", id: "leave", connectionId: "connection_exit" },
    {
      kind: "state_transition", id: "start_guard", when: { kind: "state_eq", stateKey: "guard_defeated", value: false },
      effects: [{ kind: "start_encounter", encounterId: "encounter_guard" }],
    },
    {
      kind: "ending_rule", id: "free", priority: 1, when: { kind: "encounter_defeated", encounterId: "encounter_guard" },
      effects: [{ kind: "end_game", endingId: "ending_free" }],
    },
  ]);
  const input: MechanicsAnalysisInput = {
    entrySceneId: "scene_cell",
    initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { guard_defeated: false }, npcStates: {} },
    coreClueIds: [],
    connections: [{ id: "connection_exit", fromSceneId: "scene_cell", toSceneId: "scene_exit" }],
    discoveryLocations: { wait: "scene_cell" },
    maxStates: 20,
  };
  return { ir, input };
}

function encounterDefinition(overrides: Partial<EncounterDefinitionSpec> = {}): EncounterDefinitionSpec {
  return {
    kind: "encounter_definition",
    id: "encounter_guard",
    encounterId: "encounter_guard",
    sceneId: "scene_cell",
    combatantId: "npc_guard",
    maxHp: 2,
    dodge: 20,
    fight: 40,
    npcDamage: { kind: "fixed", amount: 1 },
    victoryEffects: [{ kind: "set_state", stateKey: "guard_defeated", value: true }],
    ...overrides,
  };
}

describe("compiled combat core", () => {
  it("initializes a source-bound single enemy, gates ordinary actions, and never heals on a repeated start", () => {
    const { ir, input } = fixture();
    const started = settleAutomaticMechanics(ir, initialMechanicsState(input)).state;
    expect(started.encounters.encounter_guard).toEqual({ status: "active", currentHp: 2 });
    const choices = availableMechanicsPlayerActions(ir, input, started);
    expect(choices.map((action) => action.outcome)).toEqual(["attack", "attack", "attack", "attack", "attack", "attack"]);
    expect(choices.map((action) => action.mechanismId)).not.toContain("wait");
    expect(choices.map((action) => action.mechanismId)).not.toContain("leave");
    const wounded = executeMechanicsAction(ir, input, started, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: true, damage: 1, enemyHit: false, actorDamage: 0, actorDefeated: false },
    }).state;
    expect(() => executeMechanicsAction(ir, input, wounded, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: true, damage: 1, enemyHit: true, actorDamage: 1, actorDefeated: true },
    })).toThrow(expect.objectContaining({ code: "combat_result_invalid" }));
    expect(wounded.encounters.encounter_guard).toEqual({ status: "active", currentHp: 1 });
    expect(wounded.startedEncounterIds).toEqual(["encounter_guard"]);
    expect(applyMechanicsEffects(wounded, [{ kind: "start_encounter", encounterId: "encounter_guard" }], ir).encounters.encounter_guard).toEqual({ status: "active", currentHp: 1 });
  });

  it("validates miss/hit outcomes, closes on player defeat, and applies victory effects before the ending", () => {
    const { ir, input } = fixture();
    const started = settleAutomaticMechanics(ir, initialMechanicsState(input)).state;
    const miss = executeMechanicsAction(ir, input, started, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: false, damage: 0, enemyHit: false, actorDamage: 0, actorDefeated: false },
    }).state;
    expect(miss).toEqual(started);
    expect(() => executeMechanicsAction(ir, input, started, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "forged", hit: false, damage: 1, enemyHit: false, actorDamage: 0, actorDefeated: false } as unknown as MechanicsCombatOutcome,
    })).toThrow();
    expect(() => executeMechanicsAction(ir, input, started, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: true, damage: 2, enemyHit: true, actorDamage: 1, actorDefeated: true },
    })).toThrow(expect.objectContaining({ code: "combat_result_invalid" }));
    const loss = executeMechanicsAction(ir, input, started, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: false, damage: 0, enemyHit: true, actorDamage: 1, actorDefeated: true },
    }).state;
    expect(loss.terminalLoss).toEqual({ kind: "encounter_defeat", encounterId: "encounter_guard", combatantId: "npc_guard" });
    expect(availableMechanicsPlayerActions(ir, input, loss)).toEqual([]);
    expect(settleAutomaticMechanics(ir, loss).steps).toEqual([]);
    expect(validateCompiledMechanicsSnapshotState(loss)).toBe(true);
    expect(validateCompiledMechanicsSnapshotState({ ...loss, startedEncounterIds: [] })).toBe(false);
    const wounded = executeMechanicsAction(ir, input, started, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: true, damage: 1, enemyHit: false, actorDamage: 0, actorDefeated: false },
    }).state;
    const killed = executeMechanicsAction(ir, input, wounded, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: true, damage: 1, enemyHit: false, actorDamage: 0, actorDefeated: false },
    }).state;
    expect(killed.encounters.encounter_guard).toEqual({ status: "defeated", currentHp: 0 });
    expect(killed.stateValues.guard_defeated).toBe(true);
    expect(settleAutomaticMechanics(ir, killed).state.terminalEndingId).toBe("ending_free");
  });

  it("applies a nonlethal player hit before recording the enemy's terminal counterattack", () => {
    const { ir, input } = fixture();
    const started = settleAutomaticMechanics(ir, initialMechanicsState(input)).state;
    const exchange = executeMechanicsAction(ir, input, started, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: true, damage: 1, enemyHit: true, actorDamage: 1, actorDefeated: true },
    }).state;
    expect(exchange.encounters.encounter_guard).toEqual({ status: "active", currentHp: 1 });
    expect(exchange.terminalLoss).toEqual({ kind: "encounter_defeat", encounterId: "encounter_guard", combatantId: "npc_guard" });
  });

  it("records canonical encounter HP and defeat transitions in combat-edge summaries", () => {
    const { ir, input } = fixture();
    const started = settleAutomaticMechanics(ir, initialMechanicsState(input)).state;
    const wounded = executeMechanicsAction(ir, input, started, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: true, damage: 1, enemyHit: false, actorDamage: 0, actorDefeated: false },
    });
    expect(wounded.edge.summary).toContain("encounter:encounter_guard:hp=2->1");
    const killed = executeMechanicsAction(ir, input, wounded.state, {
      mechanismId: "attack:encounter_guard", outcome: "attack",
      combat: { kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: true, damage: 1, enemyHit: false, actorDamage: 0, actorDefeated: false },
    });
    expect(killed.edge.summary).toContain("encounter:encounter_guard:status=active->defeated");
  });

  it("fails closed for forged active-zero, multiple-active, and invalid-loss encounter states", () => {
    const { ir, input } = fixture();
    const started = settleAutomaticMechanics(ir, initialMechanicsState(input)).state;
    const activeZero = { ...started, encounters: { encounter_guard: { status: "active" as const, currentHp: 0 } } };
    const multipleActive = {
      ...started,
      encounters: {
        encounter_guard: { status: "active" as const, currentHp: 2 },
        forged_encounter: { status: "active" as const, currentHp: 1 },
      },
      startedEncounterIds: ["encounter_guard", "forged_encounter"],
    };
    const invalidLoss = { ...started, terminalLoss: { kind: "encounter_defeat" as const, encounterId: "forged_encounter", combatantId: "forged_npc" } };
    for (const forged of [activeZero, multipleActive, invalidLoss]) {
      expect(validateCompiledMechanicsSnapshotState(forged)).toBe(false);
      expect(() => availableMechanicsPlayerActions(ir, input, forged)).toThrow(expect.objectContaining({ code: "invalid_encounter_state" }));
    }
  });

  it("enumerates finite combat witnesses, records loss separately, and rejects forged replay payloads", () => {
    const { ir, input } = fixture();
    const report = analyzeMechanicsReachability(ir, input);
    const victory = report.endingWitnesses.ending_free!;
    expect(victory.steps.some((edge) => edge.outcome === "attack" && edge.combat?.hit)).toBe(true);
    expect(replayMechanicsWitness(ir, input, victory).terminalEndingId).toBe("ending_free");
    const loss = report.terminalLossWitnesses.encounter_guard!;
    expect(loss.final.kind).toBe("loss");
    expect(report.deadlockWitnesses).toEqual([]);
    expect(report.edges.some((edge) => edge.outcome === "attack" && edge.combat?.hit === false && edge.combat.actorDefeated === false)).toBe(false);
    const forged = structuredClone(victory);
    const attack = forged.steps.find((edge) => edge.outcome === "attack")!;
    attack.combat!.damage = 99;
    expect(() => replayMechanicsWitness(ir, input, forged)).toThrow();
    for (const mutate of [
      (combat: MechanicsCombatOutcome) => ({ ...combat, targetId: "forged" }),
      (combat: MechanicsCombatOutcome) => ({ ...combat, actorDefeated: true }),
      (_combat: MechanicsCombatOutcome) => ({ kind: "attack", encounterId: "encounter_guard", targetId: "npc_guard", hit: false, damage: 1, actorDefeated: false } as unknown as MechanicsCombatOutcome),
    ]) {
      const tampered = structuredClone(victory);
      const edge = tampered.steps.find((entry) => entry.outcome === "attack")!;
      edge.combat = mutate(edge.combat!);
      expect(() => replayMechanicsWitness(ir, input, tampered)).toThrow();
    }
    for (const field of ["beforeStateHash", "afterStateHash"] as const) {
      const tampered = structuredClone(victory);
      const edge = tampered.steps.find((entry) => entry.outcome === "attack")!;
      edge[field] = "forged";
      expect(() => replayMechanicsWitness(ir, input, tampered)).toThrow();
    }
    expect(() => analyzeMechanicsReachability(ir, { ...input, maxStates: 2 })).toThrow(expect.objectContaining({ code: "state_limit_exceeded" }));
  });

  it("fails closed for encounter catalogs, bounds, source provenance, and undeclared fields", () => {
    expect(() => compileFixture([encounterDefinition()], { ...symbols, encounterIds: [] })).toThrow("encounter");
    expect(() => compileFixture([encounterDefinition(), encounterDefinition()])).toThrow("duplicate");
    expect(() => compileFixture([encounterDefinition({ sceneId: "unknown_scene" })])).toThrow("unknown");
    expect(() => compileFixture([encounterDefinition({ combatantId: "unknown_npc" })])).toThrow("unknown");
    expect(() => parseMechanicsCandidateSpec({ ...encounterDefinition(), maxHp: 21 })).toThrow("maxHp");
    expect(() => parseMechanicsCandidateSpec({ ...encounterDefinition(), dodge: 101 })).toThrow("dodge");
    expect(() => parseMechanicsCandidateSpec({ ...encounterDefinition(), fight: -1 })).toThrow("fight");
    expect(() => parseMechanicsCandidateSpec({ ...encounterDefinition(), npcDamage: { kind: "dice", count: 3, sides: 10 } })).toThrow("combat dice");
    expect(() => parseMechanicsCandidateSpec({ ...encounterDefinition(), sourceInterpretationIds: ["forged"] })).toThrow("undeclared field");
    expect(() => compileFixture([encounterDefinition()], symbols, [])).toThrow();
    const forgedIR = compileFixture([encounterDefinition()]);
    Object.assign(forgedIR.encounterDefinitions[0]!, { unexpected: true });
    expect(() => validateMechanicsIR(forgedIR)).toThrow("undeclared field");
  });

  it("fails closed when a start is outside its scene or would create a second active enemy", () => {
    const close: EncounterDefinitionSpec = {
      ...encounterDefinition(), id: "encounter_close", encounterId: "encounter_close", combatantId: "npc_close",
    };
    const far: EncounterDefinitionSpec = {
      ...encounterDefinition(), id: "encounter_far", encounterId: "encounter_far", combatantId: "npc_far", sceneId: "scene_exit",
    };
    const variantSymbols: MechanicsSymbols = {
      ...symbols,
      npcIds: ["npc_guard", "npc_close", "npc_far"],
      encounterIds: ["encounter_guard", "encounter_close", "encounter_far"],
    };
    const ir = compileFixture([encounterDefinition(), close, far], variantSymbols);
    const state = initialMechanicsState(fixture().input);
    expect(() => applyMechanicsEffects(state, [{ kind: "start_encounter", encounterId: "encounter_far" }], ir)).toThrow(expect.objectContaining({ code: "encounter_scene_mismatch" }));
    const active = applyMechanicsEffects(state, [{ kind: "start_encounter", encounterId: "encounter_guard" }], ir);
    expect(() => applyMechanicsEffects(active, [{ kind: "start_encounter", encounterId: "encounter_close" }], ir)).toThrow(expect.objectContaining({ code: "multiple_active_encounters" }));
  });

  it("treats terminal loss as a hard stop even when an ending would otherwise match", () => {
    const ir = compileFixture([
      encounterDefinition(),
      { kind: "ending_rule", id: "premature", priority: 1, when: { kind: "scene_visited", sceneId: "scene_cell" }, effects: [{ kind: "end_game", endingId: "ending_free" }] },
    ]);
    const state = applyMechanicsEffects(initialMechanicsState(fixture().input), [{ kind: "start_encounter", encounterId: "encounter_guard" }], ir);
    const loss = { ...state, terminalLoss: { kind: "encounter_defeat" as const, encounterId: "encounter_guard", combatantId: "npc_guard" } };
    expect(settleAutomaticMechanics(ir, loss).steps).toEqual([]);
    expect(settleAutomaticMechanics(ir, loss).state.terminalEndingId).toBeUndefined();
    const transitionIR = compileFixture([
      encounterDefinition(),
      { kind: "state_transition", id: "premature_transition", when: { kind: "scene_visited", sceneId: "scene_cell" }, effects: [{ kind: "set_state", stateKey: "loss_transitioned", value: true }] },
    ], { ...symbols, declaredStateKeys: ["guard_defeated", "loss_transitioned"] });
    const transitionState = applyMechanicsEffects(initialMechanicsState(fixture().input), [{ kind: "start_encounter", encounterId: "encounter_guard" }], transitionIR);
    const transitionLoss = { ...transitionState, terminalLoss: { kind: "encounter_defeat" as const, encounterId: "encounter_guard", combatantId: "npc_guard" } };
    expect(settleAutomaticMechanics(transitionIR, transitionLoss).steps).toEqual([]);
    expect(settleAutomaticMechanics(transitionIR, transitionLoss).state.stateValues.loss_transitioned).toBeUndefined();
  });
});
