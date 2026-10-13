import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { compileMechanics, type MechanicsCandidateSpec, type MechanicsCompilationInput, type MechanicsSymbols } from "../compiler/mechanics-ir";
import { analyzeMechanicsReachability, mechanicsStateHash, replayMechanicsWitness, type MechanicsAnalysisInput } from "../compiler/mechanics-reachability";
import { applyMechanicsEffects, availableMechanicsPlayerActions, createMechanicsStateBudget, executeMechanicsAction, initialMechanicsState, matchesMechanicsPredicate, settleAutomaticMechanics, settleInitialMechanics } from "../compiler/mechanics-execution";
import { applyFactInterpretationReviews, buildSourceFactGraph, sourceStatementEvidenceRefId, type FactInterpretationCandidate } from "../compiler/source-fact-graph";
import { importPointsTo, scanImports } from "../diagnostics/source-scan";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";

const symbols: MechanicsSymbols = {
  clueIds: ["clue_parent", "clue_child"],
  sceneIds: ["scene_foyer", "scene_archive"],
  itemIds: [],
  npcIds: [],
  connectionIds: ["connection_archive"],
  encounterIds: [],
  endingIds: ["ending_escape", "ending_trapped"],
  rewardIds: [],
  declaredStateKeys: ["archive_open"],
};

function compileFixture(specs: MechanicsCandidateSpec[], overrideSymbols = symbols) {
  const document = createSyntheticDocumentIR(["合成机制来源。"], "mechanics-reachability-fixture");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const sourceGraph = buildSourceFactGraph(document, blocks);
  const statementId = sourceGraph.statements[0]!.id;
  const statementQuote = sourceGraph.statements[0]!.text;
  const sourcedSpecs = specs.map((value) => {
    const spec = structuredClone(value);
    if (spec.kind === "discovery_method" || spec.kind === "connection_gate") {
      for (const binding of spec.actorEffectProvenance ?? []) binding.source = { statementId, quote: statementQuote };
    }
    return spec;
  });
  const candidates: FactInterpretationCandidate<MechanicsCandidateSpec>[] = sourcedSpecs.map((value) => ({
    id: `accepted:${value.id}`,
    sourceStatementIds: [statementId],
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
      reason: "synthetic reachability mechanic",
      rightsStatus: "user_provided",
      scope: { moduleId: "mechanics-reachability-fixture" },
    },
    interpretationStatus: "candidate",
  }));
  const reviewed = applyFactInterpretationReviews({ ...sourceGraph, interpretations: candidates }, candidates.map((candidate) => ({
    interpretationId: candidate.id,
    decision: "accept" as const,
    reason: "synthetic deterministic policy",
    reviewerKind: "deterministic_rule" as const,
    policyId: "mechanics-reachability-fixture-v1",
    reviewEvidenceStatementIds: [statementId],
  })));
  const input: MechanicsCompilationInput = {
    moduleId: "mechanics-reachability-fixture",
    documentHash: null,
    sourceGraphSchemaVersion: "1.1.0",
    symbols: overrideSymbols,
    acceptedInterpretationIds: candidates.map((candidate) => candidate.id),
  };
  return compileMechanics(reviewed, input);
}

function fixture() {
  const specs: MechanicsCandidateSpec[] = [
    {
      kind: "discovery_method", id: "discover_parent", clueId: "clue_parent", action: "observe", target: "scene", targetId: "scene_foyer",
      onSuccess: [{ kind: "discover_clue", clueId: "clue_parent" }],
    },
    {
      kind: "discovery_method", id: "discover_child", clueId: "clue_child", action: "search", target: "scene", targetId: "scene_foyer",
      availability: { kind: "clue_found", clueId: "clue_parent" },
      check: { kind: "skill", skill: "library_use", difficulty: "hard" },
      onSuccess: [{ kind: "discover_clue", clueId: "clue_child" }],
      failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: "clue_child" }] },
    },
    {
      kind: "state_transition", id: "open_archive", when: { kind: "clue_found", clueId: "clue_child" },
      effects: [{ kind: "set_state", stateKey: "archive_open", value: true }, { kind: "unlock_connection", connectionId: "connection_archive" }],
    },
    {
      kind: "connection_gate", id: "traverse_archive", connectionId: "connection_archive",
      availability: { kind: "state_eq", stateKey: "archive_open", value: true },
    },
    {
      kind: "ending_rule", id: "ending_escape", priority: 10, when: { kind: "scene_visited", sceneId: "scene_archive" },
      effects: [{ kind: "end_game", endingId: "ending_escape" }],
    },
    {
      kind: "ending_rule", id: "ending_trapped", priority: 20, when: { kind: "scene_visited", sceneId: "scene_archive" },
      effects: [{ kind: "end_game", endingId: "ending_trapped" }],
    },
  ];
  const ir = compileFixture(specs);
  const input: MechanicsAnalysisInput = {
    entrySceneId: "scene_foyer",
    initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
    coreClueIds: ["clue_child"],
    connections: [{ id: "connection_archive", fromSceneId: "scene_foyer", toSceneId: "scene_archive" }],
    discoveryLocations: { discover_parent: "scene_foyer", discover_child: "scene_foyer" },
    maxStates: 100,
  };
  return { specs, ir, input };
}

describe("Mechanics reachability", () => {
  it("keeps selected SAN actor effects branch-bound at their original effect index and never lets pure mechanics ignore them", () => {
    const sanity = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 0 }, failLoss: { kind: "fixed", amount: 1 } } as const;
    const ir = compileFixture([
      { kind: "discovery_method", id: "probe", clueId: "clue_parent", action: "observe", target: "scene", targetId: "scene_foyer", check: { kind: "skill", skill: "spot_hidden", difficulty: "regular" }, onSuccess: [sanity, { kind: "discover_clue", clueId: "clue_parent" }], onFailure: [sanity], failback: { maxFailures: 1, effects: [sanity, { kind: "discover_clue", clueId: "clue_parent" }] }, actorEffectProvenance: [
        { effectPath: "onSuccess[0]", eventSlot: { kind: "discovery", mechanismId: "probe", outcome: "success", effectIndex: 0 }, source: { statementId: "synthetic", quote: "synthetic SAN" } },
        { effectPath: "onFailure[0]", eventSlot: { kind: "discovery", mechanismId: "probe", outcome: "failure", effectIndex: 0 }, source: { statementId: "synthetic", quote: "synthetic SAN" } },
        { effectPath: "failback.effects[0]", eventSlot: { kind: "discovery", mechanismId: "probe", outcome: "failback", effectIndex: 0 }, source: { statementId: "synthetic", quote: "synthetic SAN" } },
      ] },
      { kind: "connection_gate", id: "walk", connectionId: "connection_archive", onTraverse: [sanity], actorEffectProvenance: [{ effectPath: "onTraverse[0]", eventSlot: { kind: "connection", connectionId: "connection_archive", outcome: "traverse", effectIndex: 0 }, source: { statementId: "synthetic", quote: "synthetic SAN" } }] },
    ]);
    const input: MechanicsAnalysisInput = { entrySceneId: "scene_foyer", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} }, coreClueIds: [], connections: [{ id: "connection_archive", fromSceneId: "scene_foyer", toSceneId: "scene_archive" }], discoveryLocations: { probe: "scene_foyer" }, maxStates: 100 };
    const initial = initialMechanicsState(input);
    expect(() => applyMechanicsEffects(initial, [sanity])).toThrow("must be settled");
    const success = executeMechanicsAction(ir, input, initial, { mechanismId: "probe", outcome: "success" });
    const failure = executeMechanicsAction(ir, input, initial, { mechanismId: "probe", outcome: "failure" });
    const failback = executeMechanicsAction(ir, input, failure.state, { mechanismId: "probe", outcome: "failback" });
    const traverse = executeMechanicsAction(ir, input, initial, { mechanismId: "walk", outcome: "traverse" });
    expect([success, failure, failback, traverse].map((entry) => entry.actorEffects[0] && [entry.edge.outcome, entry.actorEffects[0].outcome, entry.actorEffects[0].effectIndex])).toEqual([
      ["success", "success", 0], ["failure", "failure", 0], ["failback", "failback", 0], ["traverse", "traverse", 0],
    ]);
  });

  it("applies acquire_item idempotently through the shared state transition path", () => {
    const initial = {
      currentSceneId: "scene_foyer", foundClueIds: [], visitedSceneIds: ["scene_foyer"], ownedItemIds: [], stateValues: {}, npcStates: {},
      unlockedConnectionIds: [], failureCounts: {}, encounters: {}, startedEncounterIds: [], rewardIds: [],
    };
    const acquired = applyMechanicsEffects(initial, [{ kind: "acquire_item", itemId: "item_key" }, { kind: "acquire_item", itemId: "item_key" }]);
    expect(acquired.ownedItemIds).toEqual(["item_key"]);
    expect(matchesMechanicsPredicate({ kind: "item_owned", itemId: "item_key" }, acquired)).toBe(true);
    expect(applyMechanicsEffects(acquired, [{ kind: "acquire_item", itemId: "item_key" }])).toEqual(acquired);
  });

  it("requires terminal-first and automatic settlement before a direct player action", () => {
    const ir = compileFixture([
      { kind: "discovery_method", id: "find", clueId: "clue_parent", action: "search", target: "scene", targetId: "scene_foyer", onSuccess: [{ kind: "discover_clue", clueId: "clue_parent" }] },
      { kind: "state_transition", id: "settle", when: { kind: "state_eq", stateKey: "archive_open", value: false }, effects: [{ kind: "set_state", stateKey: "archive_open", value: true }] },
    ]);
    const input: MechanicsAnalysisInput = { entrySceneId: "scene_foyer", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { archive_open: false }, npcStates: {} }, coreClueIds: [], connections: [], discoveryLocations: { find: "scene_foyer" }, maxStates: 10 };
    const initial = initialMechanicsState(input);
    expect(availableMechanicsPlayerActions(ir, input, initial).map((action) => action.mechanismId)).toContain("find");
    expect(() => executeMechanicsAction(ir, input, initial, { mechanismId: "find", outcome: "success" })).toThrow(expect.objectContaining({ code: "action_before_settlement" }));
    const settled = settleAutomaticMechanics(ir, initial).state;
    expect(executeMechanicsAction(ir, input, settled, { mechanismId: "find", outcome: "success" }).state.foundClueIds).toEqual(["clue_parent"]);

    const terminal = compileFixture([
      { kind: "discovery_method", id: "late", clueId: "clue_parent", action: "search", target: "scene", targetId: "scene_foyer", onSuccess: [{ kind: "discover_clue", clueId: "clue_parent" }] },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "state_eq", stateKey: "archive_open", value: false }, effects: [{ kind: "end_game", endingId: "ending_escape" }] },
    ]);
    const terminalInput = { ...input, discoveryLocations: { late: "scene_foyer" } };
    expect(availableMechanicsPlayerActions(terminal, terminalInput, initial).map((action) => action.mechanismId)).toContain("late");
    expect(() => executeMechanicsAction(terminal, terminalInput, initial, { mechanismId: "late", outcome: "success" })).toThrow(expect.objectContaining({ code: "action_before_settlement" }));
    const terminalState = settleAutomaticMechanics(terminal, initial).state;
    expect(() => executeMechanicsAction(terminal, terminalInput, terminalState, { mechanismId: "late", outcome: "success" })).toThrow(expect.objectContaining({ code: "action_after_terminal" }));
  });

  it("settles an initial automatic chain through terminal source-bound reward evaluation", () => {
    // This is a shared-core MechanicsIR fixture.  It does not claim that the
    // current hints/resolver contract can source this particular chain.
    const terminalSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: [],
      sceneIds: ["entry"],
      connectionIds: [],
      endingIds: ["ending_done"],
      rewardIds: ["reward_entry"],
      declaredStateKeys: ["phase"],
    };
    const ir = compileFixture([
      { kind: "state_transition", id: "arm_terminal", when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "ending_rule", id: "finish_after_transition", priority: 1, when: { kind: "state_eq", stateKey: "phase", value: 1 }, effects: [{ kind: "end_game", endingId: "ending_done" }] },
      { kind: "reward_definition", id: "reward_entry", when: { kind: "scene_visited", sceneId: "entry" }, settlement: { san: { kind: "fixed", amount: 1 } } },
    ], terminalSymbols);
    const input: MechanicsAnalysisInput = {
      entrySceneId: "entry",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} },
      coreClueIds: [],
      connections: [],
      discoveryLocations: {},
      maxStates: 8,
    };

    const settled = settleInitialMechanics(ir, input);
    expect(settled.steps.map((step) => [step.mechanismId, step.outcome])).toEqual([
      ["arm_terminal", "transition"],
      ["finish_after_transition", "ending"],
    ]);
    expect(settled.state).toMatchObject({
      stateValues: { phase: 1 },
      terminalEndingId: "ending_done",
      rewardIds: ["reward_entry"],
    });

    const report = analyzeMechanicsReachability(ir, input);
    const witness = report.endingWitnesses.ending_done!;
    expect(witness.steps).toEqual(settled.steps);
    expect(replayMechanicsWitness(ir, input, witness)).toMatchObject({
      terminalEndingId: "ending_done",
      rewardIds: ["reward_entry"],
    });
  });

  it("encapsulates state budgets and action provenance from caller mutation", () => {
    const { ir, input } = fixture();
    const budget = createMechanicsStateBudget(2);
    const state = initialMechanicsState(input);
    expect(Object.isFrozen(budget)).toBe(true);
    expect(budget).not.toHaveProperty("hashes");
    budget.observe(state);
    budget.observe(state);
    expect(budget.count).toBe(1);
    const next = { ...state, stateValues: { ...state.stateValues, archive_open: true } };
    budget.observe(next);
    expect(budget.count).toBe(2);
    expect(() => budget.observe({ ...next, stateValues: { ...next.stateValues, archive_open: false } })).toThrow(expect.objectContaining({ code: "state_limit_exceeded" }));

    const action = availableMechanicsPlayerActions(ir, input, state).find((candidate) => candidate.mechanismId === "discover_parent")!;
    action.sourceInterpretationIds.push("caller-mutation");
    expect(ir.discoveryMethods.find((candidate) => candidate.id === "discover_parent")!.sourceInterpretationIds).not.toContain("caller-mutation");
  });

  it("rejects invalid state-budget bounds at the shared-core constructor", () => {
    for (const maxStates of [NaN, Infinity, 0, -1, 1.5]) {
      expect(() => createMechanicsStateBudget(maxStates)).toThrow(expect.objectContaining({ code: "invalid_max_states" }));
    }
    expect(createMechanicsStateBudget(1).count).toBe(0);
  });

  it("produces shortest witnesses from entry through core, transition, traverse, and selected ending", () => {
    const { ir, input } = fixture();
    const report = analyzeMechanicsReachability(ir, input);
    expect(report.analysisScope).toBe("closed_world");
    expect(report.unreachableCoreClueIds).toEqual([]);
    expect(report.selectedTerminalEndingIds).toEqual(["ending_escape"]);
    expect(report.unreachableEndingIds).toEqual(["ending_trapped"]);
    expect(report.coreClueWitnesses.clue_child?.steps.map((step) => step.mechanismId)).toEqual(["discover_parent", "discover_child"]);
    expect(report.endingWitnesses.ending_escape?.steps.map((step) => step.mechanismId)).toEqual(["discover_parent", "discover_child", "open_archive", "traverse_archive", "ending_escape"]);
  });

  it("bounds independent pure findings by control state while retaining complete replay hashes", () => {
    const observationClues = Array.from({ length: 7 }, (_, index) => `observation_${index + 1}`);
    const observationSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: observationClues,
      sceneIds: ["entry", "exit"],
      connectionIds: ["leave"],
      endingIds: ["done"],
      declaredStateKeys: [],
    };
    const ir = compileFixture([
      ...observationClues.map((clueId): MechanicsCandidateSpec => ({
        kind: "discovery_method", id: `observe_${clueId}`, clueId, action: "search", target: "scene", targetId: "entry",
        check: { kind: "attribute", attribute: "edu", difficulty: "regular" }, onSuccess: [{ kind: "discover_clue", clueId }],
      })),
      { kind: "connection_gate", id: "leave", connectionId: "leave" },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "scene_visited", sceneId: "exit" }, effects: [{ kind: "end_game", endingId: "done" }] },
    ], observationSymbols);
    const input: MechanicsAnalysisInput = {
      entrySceneId: "entry",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: [],
      connections: [{ id: "leave", fromSceneId: "entry", toSceneId: "exit" }],
      discoveryLocations: Object.fromEntries(observationClues.map((clueId) => [`observe_${clueId}`, "entry"])),
      maxStates: 3,
    };

    const report = analyzeMechanicsReachability(ir, input);
    expect(report.reachableStateCount).toBe(3);
    expect(report.reachableClueIds).toEqual(observationClues);
    const pureEdge = report.edges.find((edge) => edge.mechanismId === "observe_observation_1" && edge.outcome === "success")!;
    const executed = executeMechanicsAction(ir, input, initialMechanicsState(input), { mechanismId: "observe_observation_1", outcome: "success" });
    expect(pureEdge).toEqual(executed.edge);
    const pureWitness = {
      startSceneId: "entry",
      steps: [pureEdge],
      final: { kind: "clue" as const, id: "observation_1", stateHash: pureEdge.afterStateHash },
    };
    expect(replayMechanicsWitness(ir, input, pureWitness).foundClueIds).toEqual(["observation_1"]);
    expect(replayMechanicsWitness(ir, input, report.endingWitnesses.done!).terminalEndingId).toBe("done");
  });

  it("retains core and predicate-referenced clues, including a post-discovery trap", () => {
    const guardSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: ["core_observation", "trap"],
      sceneIds: ["entry", "exit"],
      connectionIds: ["leave"],
      endingIds: ["done"],
      declaredStateKeys: [],
    };
    const core = compileFixture([{
      kind: "discovery_method", id: "observe_core", clueId: "core_observation", action: "observe", target: "scene", targetId: "entry",
      onSuccess: [{ kind: "discover_clue", clueId: "core_observation" }],
    }], guardSymbols);
    const coreInput: MechanicsAnalysisInput = {
      entrySceneId: "entry",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: ["core_observation"], connections: [], discoveryLocations: { observe_core: "entry" }, maxStates: 2,
    };
    const coreReport = analyzeMechanicsReachability(core, coreInput);
    expect(coreReport.reachableStateCount).toBe(2);
    expect(replayMechanicsWitness(core, coreInput, coreReport.coreClueWitnesses.core_observation!).foundClueIds).toEqual(["core_observation"]);

    const trap = compileFixture([
      { kind: "discovery_method", id: "observe_trap", clueId: "trap", action: "observe", target: "scene", targetId: "entry", onSuccess: [{ kind: "discover_clue", clueId: "trap" }] },
      { kind: "connection_gate", id: "leave", connectionId: "leave", availability: { kind: "not", predicate: { kind: "clue_found", clueId: "trap" } } },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "scene_visited", sceneId: "exit" }, effects: [{ kind: "end_game", endingId: "done" }] },
    ], guardSymbols);
    const trapInput: MechanicsAnalysisInput = {
      entrySceneId: "entry",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: [], connections: [{ id: "leave", fromSceneId: "entry", toSceneId: "exit" }], discoveryLocations: { observe_trap: "entry" }, maxStates: 4,
    };
    const trapReport = analyzeMechanicsReachability(trap, trapInput);
    expect(trapReport.reachableStateCount).toBe(4);
    const deadlock = trapReport.deadlockWitnesses.find((witness) => witness.steps.map((step) => step.mechanismId).join(",") === "observe_trap")!;
    expect(deadlock.final.stateHash).toBe(mechanicsStateHash({
      ...initialMechanicsState(trapInput), foundClueIds: ["trap"],
    }));
    expect(replayMechanicsWitness(trap, trapInput, deadlock).foundClueIds).toEqual(["trap"]);
  });

  it("retains clues referenced only by terminal rewards and explores their real full-state continuation", () => {
    const rewardSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: ["reward_observation"],
      sceneIds: ["entry", "exit"],
      connectionIds: ["leave"],
      endingIds: ["done"],
      rewardIds: ["reward_after_observation"],
      declaredStateKeys: [],
    };
    const ir = compileFixture([
      { kind: "discovery_method", id: "observe_reward", clueId: "reward_observation", action: "observe", target: "scene", targetId: "entry", onSuccess: [{ kind: "discover_clue", clueId: "reward_observation" }] },
      { kind: "connection_gate", id: "leave", connectionId: "leave" },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "scene_visited", sceneId: "exit" }, effects: [{ kind: "end_game", endingId: "done" }] },
      { kind: "reward_definition", id: "reward_after_observation", when: { kind: "clue_found", clueId: "reward_observation" }, settlement: { san: { kind: "fixed", amount: 1 } } },
    ], rewardSymbols);
    const input: MechanicsAnalysisInput = {
      entrySceneId: "entry",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: [], connections: [{ id: "leave", fromSceneId: "entry", toSceneId: "exit" }], discoveryLocations: { observe_reward: "entry" }, maxStates: 6,
    };
    const report = analyzeMechanicsReachability(ir, input);
    expect(report.reachableStateCount).toBe(6);
    const observe = report.edges.find((edge) => edge.mechanismId === "observe_reward" && edge.outcome === "success")!;
    const leave = report.edges.find((edge) => edge.mechanismId === "leave" && edge.beforeStateHash === observe.afterStateHash)!;
    const finish = report.edges.find((edge) => edge.mechanismId === "finish" && edge.beforeStateHash === leave.afterStateHash)!;
    expect(replayMechanicsWitness(ir, input, {
      startSceneId: "entry", steps: [observe, leave, finish], final: { kind: "ending", id: "done", stateHash: finish.afterStateHash },
    }).rewardIds).toEqual(["reward_after_observation"]);
  });

  it("does not collapse a clue when any one of its methods has failure, failback, or actor side effects", () => {
    const guardSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: ["guarded"], sceneIds: ["entry"], connectionIds: [], endingIds: [], declaredStateKeys: ["phase"],
    };
    const baseInput: MechanicsAnalysisInput = {
      entrySceneId: "entry",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} },
      coreClueIds: [], connections: [], discoveryLocations: {}, maxStates: 4,
    };
    const mixedMethods = compileFixture([
      { kind: "discovery_method", id: "pure_way", clueId: "guarded", action: "observe", target: "scene", targetId: "entry", onSuccess: [{ kind: "discover_clue", clueId: "guarded" }] },
      { kind: "discovery_method", id: "risky_way", clueId: "guarded", action: "search", target: "scene", targetId: "entry", check: { kind: "skill", skill: "library_use", difficulty: "regular" }, onSuccess: [{ kind: "discover_clue", clueId: "guarded" }], onFailure: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
    ], guardSymbols);
    const mixedInput = { ...baseInput, discoveryLocations: { pure_way: "entry", risky_way: "entry" }, maxStates: 4 };
    expect(analyzeMechanicsReachability(mixedMethods, mixedInput).reachableStateCount).toBe(4);

    const failback = compileFixture([{
      kind: "discovery_method", id: "bounded_way", clueId: "guarded", action: "search", target: "scene", targetId: "entry", check: { kind: "skill", skill: "library_use", difficulty: "regular" },
      onSuccess: [{ kind: "discover_clue", clueId: "guarded" }], failback: { maxFailures: 1, effects: [{ kind: "discover_clue", clueId: "guarded" }] },
    }], guardSymbols);
    const failbackInput = { ...baseInput, discoveryLocations: { bounded_way: "entry" } };
    expect(analyzeMechanicsReachability(failback, failbackInput).reachableStateCount).toBe(4);

    const sanity = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 0 }, failLoss: { kind: "fixed", amount: 1 } } as const;
    const actorEffect = compileFixture([{
      kind: "discovery_method", id: "costly_observation", clueId: "guarded", action: "observe", target: "scene", targetId: "entry",
      onSuccess: [{ kind: "discover_clue", clueId: "guarded" }, sanity],
      actorEffectProvenance: [{ effectPath: "onSuccess[1]", eventSlot: { kind: "discovery", mechanismId: "costly_observation", outcome: "success", effectIndex: 1 }, source: { statementId: "synthetic", quote: "synthetic SAN" } }],
    }], guardSymbols);
    const actorInput = { ...baseInput, discoveryLocations: { costly_observation: "entry" }, maxStates: 2 };
    expect(analyzeMechanicsReachability(actorEffect, actorInput).reachableStateCount).toBe(2);

    // Even an idempotent write is a declared secondary success effect; its
    // clue must not acquire the pure-observation equivalence exemption.
    const stateEffect = compileFixture([{
      kind: "discovery_method", id: "stateful_observation", clueId: "guarded", action: "observe", target: "scene", targetId: "entry",
      onSuccess: [{ kind: "discover_clue", clueId: "guarded" }, { kind: "set_state", stateKey: "phase", value: 0 }],
    }], guardSymbols);
    const stateInput = { ...baseInput, discoveryLocations: { stateful_observation: "entry" }, maxStates: 2 };
    expect(analyzeMechanicsReachability(stateEffect, stateInput).reachableStateCount).toBe(2);
  });

  it("retains externally discovered clues and keeps automatic cycle detection on complete hashes", () => {
    const externalSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: ["externally_found"], sceneIds: ["entry"], connectionIds: ["loop"], endingIds: [], declaredStateKeys: ["phase"],
    };
    const connection = compileFixture([
      { kind: "discovery_method", id: "observe_external", clueId: "externally_found", action: "observe", target: "scene", targetId: "entry", onSuccess: [{ kind: "discover_clue", clueId: "externally_found" }] },
      { kind: "connection_gate", id: "loop", connectionId: "loop", onTraverse: [{ kind: "discover_clue", clueId: "externally_found" }] },
    ], externalSymbols);
    const connectionInput: MechanicsAnalysisInput = {
      entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} }, coreClueIds: [],
      connections: [{ id: "loop", fromSceneId: "entry", toSceneId: "entry" }], discoveryLocations: { observe_external: "entry" }, maxStates: 2,
    };
    const connectionReport = analyzeMechanicsReachability(connection, connectionInput);
    expect(connectionReport.reachableStateCount).toBe(2);
    expect(connectionReport.edges.some((edge) => edge.mechanismId === "loop" && edge.afterStateHash.includes("externally_found"))).toBe(true);

    const transition = compileFixture([
      { kind: "discovery_method", id: "observe_external", clueId: "externally_found", action: "observe", target: "scene", targetId: "entry", onSuccess: [{ kind: "discover_clue", clueId: "externally_found" }] },
      { kind: "state_transition", id: "automatic_observation", when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "discover_clue", clueId: "externally_found" }] },
    ], externalSymbols);
    const transitionInput = { ...connectionInput, connections: [], maxStates: 2 };
    const transitionReport = analyzeMechanicsReachability(transition, transitionInput);
    expect(transitionReport.reachableStateCount).toBe(2);
    expect(transitionReport.edges.map((edge) => edge.mechanismId)).toEqual(["automatic_observation"]);
    const initial = initialMechanicsState(transitionInput);
    const settled = settleAutomaticMechanics(transition, initial);
    expect(settled.steps[0]?.afterStateHash).toBe(mechanicsStateHash(settled.state));
    expect(settled.state.foundClueIds).toEqual(["externally_found"]);
  });

  it("does not allow child discovery at the entry before its parent availability", () => {
    const { ir, input } = fixture();
    const report = analyzeMechanicsReachability(ir, input);
    const initialHash = mechanicsStateHash({
      currentSceneId: "scene_foyer", foundClueIds: [], visitedSceneIds: ["scene_foyer"], ownedItemIds: [], stateValues: {}, npcStates: {},
      unlockedConnectionIds: [], failureCounts: {}, encounters: {}, startedEncounterIds: [], rewardIds: [],
    });
    expect(report.edges.some((edge) => edge.mechanismId === "discover_child" && edge.beforeStateHash === initialHash)).toBe(false);
  });

  it("records a bounded failure path whose failback discovers the core clue", () => {
    const { ir, input } = fixture();
    const report = analyzeMechanicsReachability(ir, input);
    const witness = report.failbackWitnesses.discover_child!;
    expect(witness.steps.slice(-3).map((step) => step.outcome)).toEqual(["failure", "failure", "failback"]);
    expect(witness.final).toMatchObject({ kind: "clue", id: "clue_child" });
  });

  it("reports an unbounded checked-core policy risk without claiming it is itself a deadlock", () => {
    const { specs, input } = fixture();
    const noFailback = specs.map((spec) => spec.kind === "discovery_method" && spec.id === "discover_child" ? { ...spec, failback: undefined } : spec) as MechanicsCandidateSpec[];
    const report = analyzeMechanicsReachability(compileFixture(noFailback), input);
    expect(report.failurePolicyRiskMethodIds).toEqual(["discover_child"]);
    expect(report.issues.some((issue) => issue.code === "core_clue_failure_policy_risk" && issue.id === "discover_child")).toBe(true);
    expect(report.edges.some((edge) => edge.mechanismId === "discover_child" && edge.outcome === "failure")).toBe(false);
    expect(report.issues.some((issue) => issue.code === "unreachable_ending" && issue.id === "ending_trapped")).toBe(true);
    const noChild = specs.filter((spec) => !(spec.kind === "discovery_method" && spec.id === "discover_child"));
    const unreachable = analyzeMechanicsReachability(compileFixture(noChild), { ...input, discoveryLocations: { discover_parent: "scene_foyer" } });
    expect(unreachable.unreachableCoreClueIds).toEqual(["clue_child"]);
  });

  it("does not let an unreachable alternative hide a reachable checked-core failure policy risk", () => {
    const alternativeSymbols: MechanicsSymbols = { ...symbols, clueIds: ["clue_child"], sceneIds: ["scene_foyer", "scene_archive"], connectionIds: [], endingIds: [] };
    const ir = compileFixture([
      {
        kind: "discovery_method", id: "checked_core", clueId: "clue_child", action: "search", target: "scene", targetId: "scene_foyer",
        check: { kind: "skill", skill: "library_use", difficulty: "regular" }, onSuccess: [{ kind: "discover_clue", clueId: "clue_child" }],
      },
      {
        kind: "discovery_method", id: "unreachable_fallback", clueId: "clue_child", action: "observe", target: "scene", targetId: "scene_archive",
        onSuccess: [{ kind: "discover_clue", clueId: "clue_child" }],
      },
    ], alternativeSymbols);
    const report = analyzeMechanicsReachability(ir, {
      entrySceneId: "scene_foyer", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: ["clue_child"], connections: [], discoveryLocations: { checked_core: "scene_foyer", unreachable_fallback: "scene_archive" }, maxStates: 20,
    });
    expect(report.failurePolicyRiskMethodIds).toEqual(["checked_core"]);
  });

  it("keeps a checked core failure-policy risk when its only deterministic fallback was left behind", () => {
    const branchSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: ["clue_core"],
      sceneIds: ["scene_entry", "scene_one_way"],
      connectionIds: ["leave_entry"],
      endingIds: ["ending_success"],
      declaredStateKeys: [],
    };
    const ir = compileFixture([
      {
        kind: "discovery_method", id: "entry_observe", clueId: "clue_core", action: "observe", target: "scene", targetId: "scene_entry",
        onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }],
      },
      {
        kind: "discovery_method", id: "checked_at_one_way", clueId: "clue_core", action: "search", target: "scene", targetId: "scene_one_way",
        check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }],
      },
      { kind: "connection_gate", id: "leave_entry_gate", connectionId: "leave_entry" },
      {
        kind: "ending_rule", id: "success_ending", priority: 1, when: { kind: "clue_found", clueId: "clue_core" },
        effects: [{ kind: "end_game", endingId: "ending_success" }],
      },
    ], branchSymbols);
    const report = analyzeMechanicsReachability(ir, {
      entrySceneId: "scene_entry",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: ["clue_core"],
      connections: [{ id: "leave_entry", fromSceneId: "scene_entry", toSceneId: "scene_one_way" }],
      discoveryLocations: { entry_observe: "scene_entry", checked_at_one_way: "scene_one_way" },
      maxStates: 40,
    });
    expect(report.reachableEndingIds).toEqual(["ending_success"]);
    expect(report.deadlockWitnesses).toEqual([]);
    expect(report.failurePolicyRiskMethodIds).toEqual(["checked_at_one_way"]);
  });

  it("does not let a mutually exclusive branch's fallback clear this branch's failure policy risk", () => {
    const branchSymbols: MechanicsSymbols = { ...symbols, clueIds: ["clue_core"], sceneIds: ["scene_start", "scene_checked", "scene_fallback"], connectionIds: ["a_to_checked", "z_to_fallback"], endingIds: ["ending_success"], declaredStateKeys: [] };
    const ir = compileFixture([
      { kind: "connection_gate", id: "a_to_checked", connectionId: "a_to_checked" },
      { kind: "connection_gate", id: "z_to_fallback", connectionId: "z_to_fallback" },
      { kind: "discovery_method", id: "checked_branch_method", clueId: "clue_core", action: "search", target: "scene", targetId: "scene_checked", check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }] },
      { kind: "discovery_method", id: "other_branch_observe", clueId: "clue_core", action: "observe", target: "scene", targetId: "scene_fallback", onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }] },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "clue_found", clueId: "clue_core" }, effects: [{ kind: "end_game", endingId: "ending_success" }] },
    ], branchSymbols);
    const report = analyzeMechanicsReachability(ir, {
      entrySceneId: "scene_start", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} }, coreClueIds: ["clue_core"],
      connections: [{ id: "a_to_checked", fromSceneId: "scene_start", toSceneId: "scene_checked" }, { id: "z_to_fallback", fromSceneId: "scene_start", toSceneId: "scene_fallback" }], discoveryLocations: { checked_branch_method: "scene_checked", other_branch_observe: "scene_fallback" }, maxStates: 50,
    });
    expect(report.reachableEndingIds).toEqual(["ending_success"]);
    expect(report.deadlockWitnesses).toEqual([]);
    expect(report.failurePolicyRiskMethodIds).toEqual(["checked_branch_method"]);
  });

  it("clears the policy risk only when the concrete post-failure state can reach a bounded fallback", () => {
    const recoverySymbols: MechanicsSymbols = { ...symbols, clueIds: ["clue_core"], sceneIds: ["scene_entry", "scene_checked"], connectionIds: ["to_checked", "back_to_entry"], endingIds: [], declaredStateKeys: ["fallback_open"] };
    const reachableFallback = compileFixture([
      { kind: "connection_gate", id: "to_checked", connectionId: "to_checked" },
      { kind: "connection_gate", id: "back_to_entry", connectionId: "back_to_entry" },
      { kind: "discovery_method", id: "checked_method", clueId: "clue_core", action: "search", target: "scene", targetId: "scene_checked", check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }] },
      { kind: "discovery_method", id: "entry_fallback", clueId: "clue_core", action: "observe", target: "scene", targetId: "scene_entry", onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }] },
    ], recoverySymbols);
    const shared: MechanicsAnalysisInput = { entrySceneId: "scene_entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} }, coreClueIds: ["clue_core"], connections: [{ id: "to_checked", fromSceneId: "scene_entry", toSceneId: "scene_checked" }, { id: "back_to_entry", fromSceneId: "scene_checked", toSceneId: "scene_entry" }], discoveryLocations: { checked_method: "scene_checked", entry_fallback: "scene_entry" }, maxStates: 50 };
    expect(analyzeMechanicsReachability(reachableFallback, shared).failurePolicyRiskMethodIds).toEqual([]);

    const failureEnablesFallback = compileFixture([
      { kind: "discovery_method", id: "checked_method", clueId: "clue_core", action: "search", target: "scene", targetId: "scene_entry", check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }], onFailure: [{ kind: "set_state", stateKey: "fallback_open", value: true }] },
      { kind: "discovery_method", id: "failure_enabled_observe", clueId: "clue_core", action: "observe", target: "scene", targetId: "scene_entry", availability: { kind: "state_eq", stateKey: "fallback_open", value: true }, onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }] },
    ], { ...recoverySymbols, sceneIds: ["scene_entry"], connectionIds: [] });
    expect(analyzeMechanicsReachability(failureEnablesFallback, { ...shared, entrySceneId: "scene_entry", connections: [], discoveryLocations: { checked_method: "scene_entry", failure_enabled_observe: "scene_entry" } }).failurePolicyRiskMethodIds).toEqual([]);
  });

  it("uses reported-step length, including automatic batches, when choosing a core-clue witness", () => {
    const routeSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: ["clue_core"],
      sceneIds: ["scene_start", "scene_long", "scene_short"],
      connectionIds: ["a_to_long", "z_to_short"],
      endingIds: [],
      declaredStateKeys: ["long_route", "phase_one", "phase_two"],
    };
    const ir = compileFixture([
      { kind: "connection_gate", id: "a_to_long", connectionId: "a_to_long", onTraverse: [{ kind: "set_state", stateKey: "long_route", value: true }] },
      { kind: "connection_gate", id: "z_to_short", connectionId: "z_to_short" },
      { kind: "state_transition", id: "long_auto_one", when: { kind: "all", predicates: [{ kind: "state_eq", stateKey: "long_route", value: true }, { kind: "not", predicate: { kind: "state_eq", stateKey: "phase_one", value: true } }] }, effects: [{ kind: "set_state", stateKey: "phase_one", value: true }] },
      { kind: "state_transition", id: "long_auto_two", when: { kind: "all", predicates: [{ kind: "state_eq", stateKey: "phase_one", value: true }, { kind: "not", predicate: { kind: "state_eq", stateKey: "phase_two", value: true } }] }, effects: [{ kind: "set_state", stateKey: "phase_two", value: true }] },
      { kind: "discovery_method", id: "long_discovery", clueId: "clue_core", action: "search", target: "scene", targetId: "scene_long", availability: { kind: "state_eq", stateKey: "phase_two", value: true }, onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }] },
      { kind: "discovery_method", id: "short_discovery", clueId: "clue_core", action: "search", target: "scene", targetId: "scene_short", onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }] },
    ], routeSymbols);
    const report = analyzeMechanicsReachability(ir, {
      entrySceneId: "scene_start",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: ["clue_core"],
      connections: [{ id: "a_to_long", fromSceneId: "scene_start", toSceneId: "scene_long" }, { id: "z_to_short", fromSceneId: "scene_start", toSceneId: "scene_short" }],
      discoveryLocations: { long_discovery: "scene_long", short_discovery: "scene_short" },
      maxStates: 80,
    });
    expect(report.coreClueWitnesses.clue_core?.steps.map((step) => step.mechanismId)).toEqual(["z_to_short", "short_discovery"]);
    expect(report.coreClueWitnesses.clue_core?.steps).toHaveLength(2);
  });

  it("replaces a first-recorded longer stable route and propagates the shorter route to later witnesses", () => {
    const routeSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: ["clue_core"],
      sceneIds: ["scene_entry", "scene_work"],
      connectionIds: ["a_route", "z_route"],
      endingIds: [],
      declaredStateKeys: ["route"],
    };
    const ir = compileFixture([
      { kind: "connection_gate", id: "a_route_gate", connectionId: "a_route", onTraverse: [{ kind: "set_state", stateKey: "route", value: "long" }] },
      { kind: "connection_gate", id: "z_route_gate", connectionId: "z_route", onTraverse: [{ kind: "set_state", stateKey: "route", value: "complete" }] },
      { kind: "state_transition", id: "long_to_complete", when: { kind: "state_eq", stateKey: "route", value: "long" }, effects: [{ kind: "set_state", stateKey: "route", value: "complete" }] },
      { kind: "discovery_method", id: "final_core", clueId: "clue_core", action: "search", target: "scene", targetId: "scene_work", availability: { kind: "state_eq", stateKey: "route", value: "complete" }, onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }] },
    ], routeSymbols);
    const input: MechanicsAnalysisInput = {
      entrySceneId: "scene_entry",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: ["clue_core"],
      connections: [
        { id: "a_route", fromSceneId: "scene_entry", toSceneId: "scene_work" },
        { id: "z_route", fromSceneId: "scene_entry", toSceneId: "scene_work" },
      ],
      discoveryLocations: { final_core: "scene_work" },
      maxStates: 40,
    };
    const witness = analyzeMechanicsReachability(ir, input).coreClueWitnesses.clue_core!;
    expect(witness.steps.map((step) => step.mechanismId)).toEqual(["z_route_gate", "final_core"]);
    expect(replayMechanicsWitness(ir, input, witness).foundClueIds).toEqual(["clue_core"]);
  });

  it("requires a bounded recovery strategy across every checked outcome", () => {
    const recoverySymbols: MechanicsSymbols = { ...symbols, clueIds: ["core"], sceneIds: ["entry"], connectionIds: [], endingIds: ["done"], declaredStateKeys: ["phase"] };
    const ir = compileFixture([
      { kind: "discovery_method", id: "risky", clueId: "core", action: "search", target: "scene", targetId: "entry", availability: { kind: "state_eq", stateKey: "phase", value: 0 }, check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "core" }], onFailure: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "discovery_method", id: "bounded", clueId: "core", action: "observe", target: "scene", targetId: "entry", availability: { kind: "state_eq", stateKey: "phase", value: 1 }, check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "core" }], onFailure: [{ kind: "set_state", stateKey: "phase", value: 2 }], failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: "core" }] } },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "state_eq", stateKey: "phase", value: 2 }, effects: [{ kind: "end_game", endingId: "done" }] },
    ], recoverySymbols);
    const input: MechanicsAnalysisInput = {
      entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} }, coreClueIds: ["core"],
      connections: [], discoveryLocations: { risky: "entry", bounded: "entry" }, maxStates: 100,
    };
    const report = analyzeMechanicsReachability(ir, input);
    expect(report.endingWitnesses.done?.steps.map((step) => `${step.mechanismId}:${step.outcome}`)).toEqual(["risky:failure", "bounded:failure", "finish:ending"]);
    expect(report.failbackWitnesses.bounded).toBeUndefined();
    expect(report.failurePolicyRiskMethodIds).toEqual(["risky"]);
  });

  it("charges initial, action, automatic, and terminal normalized states against the state budget", () => {
    const chainSymbols: MechanicsSymbols = { ...symbols, clueIds: [], sceneIds: ["entry"], connectionIds: [], endingIds: [], declaredStateKeys: ["phase"] };
    const automaticChain = compileFixture([
      { kind: "state_transition", id: "one", when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "state_transition", id: "two", when: { kind: "state_eq", stateKey: "phase", value: 1 }, effects: [{ kind: "set_state", stateKey: "phase", value: 2 }] },
      { kind: "state_transition", id: "three", when: { kind: "state_eq", stateKey: "phase", value: 2 }, effects: [{ kind: "set_state", stateKey: "phase", value: 3 }] },
    ], chainSymbols);
    const chainInput: MechanicsAnalysisInput = { entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} }, coreClueIds: [], connections: [], discoveryLocations: {}, maxStates: 1 };
    expect(() => analyzeMechanicsReachability(automaticChain, chainInput)).toThrow("state limit");

    const fullSymbols: MechanicsSymbols = { ...chainSymbols, clueIds: ["core"], endingIds: ["done"] };
    const actionThenTerminal = compileFixture([
      { kind: "discovery_method", id: "advance", clueId: "core", action: "search", target: "scene", targetId: "entry", onSuccess: [{ kind: "discover_clue", clueId: "core" }, { kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "state_transition", id: "automatic", when: { kind: "state_eq", stateKey: "phase", value: 1 }, effects: [{ kind: "set_state", stateKey: "phase", value: 2 }] },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "state_eq", stateKey: "phase", value: 2 }, effects: [{ kind: "end_game", endingId: "done" }] },
    ], fullSymbols);
    const fullInput: MechanicsAnalysisInput = { ...chainInput, coreClueIds: ["core"], discoveryLocations: { advance: "entry" }, maxStates: 4 };
    expect(analyzeMechanicsReachability(actionThenTerminal, fullInput).reachableStateCount).toBe(4);
    expect(() => analyzeMechanicsReachability(actionThenTerminal, { ...fullInput, maxStates: 3 })).toThrow("state limit");
  });

  it("rejects replayed player actions after an initial terminal ending", () => {
    const terminalSymbols: MechanicsSymbols = { ...symbols, clueIds: ["core"], sceneIds: ["entry"], connectionIds: [], endingIds: ["done"], declaredStateKeys: ["phase"] };
    const ir = compileFixture([
      { kind: "discovery_method", id: "late", clueId: "core", action: "observe", target: "scene", targetId: "entry", onSuccess: [{ kind: "discover_clue", clueId: "core" }] },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "end_game", endingId: "done" }] },
    ], terminalSymbols);
    const input: MechanicsAnalysisInput = { entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} }, coreClueIds: ["core"], connections: [], discoveryLocations: { late: "entry" }, maxStates: 20 };
    const report = analyzeMechanicsReachability(ir, input);
    const tampered = structuredClone(report.endingWitnesses.done!);
    const terminalState = { currentSceneId: "entry", foundClueIds: [], visitedSceneIds: ["entry"], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {}, unlockedConnectionIds: [], failureCounts: {}, encounters: {}, startedEncounterIds: [], rewardIds: [], terminalEndingId: "done" };
    const afterLateAction = { ...terminalState, foundClueIds: ["core"] };
    tampered.steps.push({ mechanismId: "late", mechanismIds: ["late"], outcome: "success", beforeStateHash: mechanicsStateHash(terminalState), afterStateHash: mechanicsStateHash(afterLateAction), sourceInterpretationIds: ["accepted:late"], summary: "clue:core" });
    tampered.final = { kind: "clue", id: "core", stateHash: mechanicsStateHash(afterLateAction) };
    expect(() => replayMechanicsWitness(ir, input, tampered)).toThrow("continues after terminal");
  });

  it("records the earliest initial and automatic core-goal prefixes", () => {
    const prefixSymbols: MechanicsSymbols = { ...symbols, clueIds: ["core"], sceneIds: ["entry"], connectionIds: [], endingIds: [], declaredStateKeys: ["phase"] };
    const automaticCore = compileFixture([
      { kind: "state_transition", id: "find", when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "discover_clue", clueId: "core" }, { kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "state_transition", id: "tail", when: { kind: "state_eq", stateKey: "phase", value: 1 }, effects: [{ kind: "set_state", stateKey: "phase", value: 2 }] },
    ], prefixSymbols);
    const input: MechanicsAnalysisInput = { entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} }, coreClueIds: ["core"], connections: [], discoveryLocations: {}, maxStates: 20 };
    const automaticWitness = analyzeMechanicsReachability(automaticCore, input).coreClueWitnesses.core!;
    expect(automaticWitness.steps.map((step) => step.mechanismId)).toEqual(["find"]);
    expect(replayMechanicsWitness(automaticCore, input, automaticWitness).stateValues.phase).toBe(1);

    const initialCore = compileFixture([
      { kind: "state_transition", id: "tail", when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
    ], prefixSymbols);
    const initiallyFoundInput: MechanicsAnalysisInput = { ...input, initialState: { ...input.initialState, foundClueIds: ["core"] } };
    const initialWitness = analyzeMechanicsReachability(initialCore, initiallyFoundInput).coreClueWitnesses.core!;
    expect(initialWitness.steps).toHaveLength(0);
    expect(replayMechanicsWitness(initialCore, initiallyFoundInput, initialWitness).stateValues.phase).toBe(0);
  });

  it("keeps executable failure deadlock traces when another route is shorter", () => {
    const causalSymbols: MechanicsSymbols = { ...symbols, clueIds: ["core"], sceneIds: ["entry"], connectionIds: ["shortcut"], endingIds: ["done"], declaredStateKeys: ["phase"] };
    const ir = compileFixture([
      { kind: "discovery_method", id: "risky", clueId: "core", action: "search", target: "scene", targetId: "entry", availability: { kind: "state_eq", stateKey: "phase", value: 0 }, check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "core" }], onFailure: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "state_transition", id: "lock", when: { kind: "state_eq", stateKey: "phase", value: 1 }, effects: [{ kind: "set_state", stateKey: "phase", value: 2 }] },
      { kind: "connection_gate", id: "shortcut", connectionId: "shortcut", availability: { kind: "state_eq", stateKey: "phase", value: 0 }, onTraverse: [{ kind: "set_state", stateKey: "phase", value: 2 }] },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "clue_found", clueId: "core" }, effects: [{ kind: "end_game", endingId: "done" }] },
    ], causalSymbols);
    const input: MechanicsAnalysisInput = { entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} }, coreClueIds: ["core"], connections: [{ id: "shortcut", fromSceneId: "entry", toSceneId: "entry" }], discoveryLocations: { risky: "entry" }, maxStates: 40 };
    const report = analyzeMechanicsReachability(ir, input);
    expect(report.deadlockWitnesses[0]?.steps.map((step) => step.mechanismId)).toEqual(["shortcut"]);
    const failureWitness = report.failureDeadlockWitnesses.risky!;
    expect(failureWitness.steps.map((step) => step.mechanismId)).toEqual(["risky", "lock"]);
    expect(replayMechanicsWitness(ir, input, failureWitness).stateValues.phase).toBe(2);
  });

  it("replays declared witnesses from the analysis input and rejects tampered mechanisms, outcomes, and hashes", () => {
    const replaySymbols: MechanicsSymbols = { ...symbols, clueIds: ["clue_core"], sceneIds: ["scene_start"], connectionIds: [], endingIds: ["ending_done"], declaredStateKeys: ["first", "second"] };
    const ir = compileFixture([
      { kind: "discovery_method", id: "find_core", clueId: "clue_core", action: "observe", target: "scene", targetId: "scene_start", onSuccess: [{ kind: "discover_clue", clueId: "clue_core" }] },
      { kind: "state_transition", id: "set_first", when: { kind: "clue_found", clueId: "clue_core" }, effects: [{ kind: "set_state", stateKey: "first", value: true }] },
      { kind: "state_transition", id: "set_second", when: { kind: "clue_found", clueId: "clue_core" }, effects: [{ kind: "set_state", stateKey: "second", value: true }] },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "all", predicates: [{ kind: "state_eq", stateKey: "first", value: true }, { kind: "state_eq", stateKey: "second", value: true }] }, effects: [{ kind: "end_game", endingId: "ending_done" }] },
    ], replaySymbols);
    const input: MechanicsAnalysisInput = { entrySceneId: "scene_start", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} }, coreClueIds: ["clue_core"], connections: [], discoveryLocations: { find_core: "scene_start" }, maxStates: 30 };
    const report = analyzeMechanicsReachability(ir, input);
    const clueWitness = report.coreClueWitnesses.clue_core!;
    const endingWitness = report.endingWitnesses.ending_done!;
    expect(replayMechanicsWitness(ir, input, clueWitness).foundClueIds).toEqual(["clue_core"]);
    expect(replayMechanicsWitness(ir, input, endingWitness).terminalEndingId).toBe("ending_done");
    const afterTerminal = structuredClone(endingWitness);
    const terminalHash = endingWitness.final.stateHash;
    afterTerminal.steps.push({
      mechanismId: "find_core",
      mechanismIds: ["find_core"],
      outcome: "success",
      beforeStateHash: terminalHash,
      afterStateHash: terminalHash,
      sourceInterpretationIds: ["accepted:find_core"],
      summary: "no state change",
    });
    afterTerminal.final = { kind: "clue", id: "clue_core", stateHash: terminalHash };
    expect(() => replayMechanicsWitness(ir, input, afterTerminal)).toThrow("continues after terminal");
    const batch = endingWitness.steps.find((step) => step.outcome === "transition")!;
    expect(batch.mechanismIds).toEqual(["set_first", "set_second"]);
    const badMechanism = structuredClone(endingWitness); badMechanism.steps[1]!.mechanismId = "made_up";
    expect(() => replayMechanicsWitness(ir, input, badMechanism)).toThrow("mechanism");
    const badOutcome = structuredClone(endingWitness); badOutcome.steps[1]!.outcome = "success";
    expect(() => replayMechanicsWitness(ir, input, badOutcome)).toThrow("optional action");
    const badHash = structuredClone(endingWitness); badHash.steps[0]!.afterStateHash = "tampered";
    expect(() => replayMechanicsWitness(ir, input, badHash)).toThrow("hash");
  });

  it("reports closed-world deadlocks and ignores no-change failure edges", () => {
    const deadlockSymbols: MechanicsSymbols = { ...symbols, clueIds: [], connectionIds: [], endingIds: ["ending_never"] };
    const deadlock = compileFixture([{
      kind: "ending_rule", id: "ending_never", priority: 1, when: { kind: "state_eq", stateKey: "archive_open", value: true },
      effects: [{ kind: "end_game", endingId: "ending_never" }],
    }], deadlockSymbols);
    const report = analyzeMechanicsReachability(deadlock, {
      entrySceneId: "scene_foyer",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: [], connections: [], discoveryLocations: {}, maxStates: 10,
    });
    expect(report.deadlockWitnesses).toHaveLength(1);
    expect(report.deadlockWitnesses[0]?.final.kind).toBe("deadlock");
  });

  it("fails closed for state limits, missing locations, bad connection targets, and duplicate ending priority", () => {
    const { specs, ir, input } = fixture();
    expect(() => analyzeMechanicsReachability(ir, { ...input, maxStates: 1 })).toThrow("state limit");
    expect(() => analyzeMechanicsReachability(ir, { ...input, discoveryLocations: { discover_parent: "scene_foyer" } })).toThrow("location is missing");
    expect(() => analyzeMechanicsReachability(ir, { ...input, connections: [{ id: "connection_archive", fromSceneId: "scene_foyer", toSceneId: "missing" }] })).toThrow("unknown connection target scene");
    const duplicatePriority = specs.map((spec) => spec.kind === "ending_rule" && spec.id === "ending_trapped" ? { ...spec, priority: 10 } : spec) as MechanicsCandidateSpec[];
    expect(() => compileFixture(duplicatePriority)).toThrow("duplicate ending priority");
  });

  it("uses the declared unlock effect as the only gate for an explicitly locked connection", () => {
    const unlockSymbols: MechanicsSymbols = {
      ...symbols,
      clueIds: ["clue_key"],
      sceneIds: ["scene_start", "scene_exit"],
      connectionIds: ["connection_exit"],
      endingIds: ["ending_escaped"],
      declaredStateKeys: [],
    };
    const ir = compileFixture([
      {
        kind: "discovery_method", id: "find_key", clueId: "clue_key", action: "search", target: "scene", targetId: "scene_start",
        onSuccess: [{ kind: "discover_clue", clueId: "clue_key" }, { kind: "unlock_connection", connectionId: "connection_exit" }],
      },
      {
        kind: "connection_gate", id: "leave_start", connectionId: "connection_exit",
        availability: { kind: "connection_unlocked", connectionId: "connection_exit" },
      },
      {
        kind: "ending_rule", id: "rule_escape", priority: 1, when: { kind: "scene_visited", sceneId: "scene_exit" },
        effects: [{ kind: "end_game", endingId: "ending_escaped" }],
      },
    ], unlockSymbols);
    const report = analyzeMechanicsReachability(ir, {
      entrySceneId: "scene_start",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: ["clue_key"],
      connections: [{ id: "connection_exit", fromSceneId: "scene_start", toSceneId: "scene_exit" }],
      discoveryLocations: { find_key: "scene_start" },
      maxStates: 20,
    });
    expect(report.edges.some((edge) => edge.mechanismId === "leave_start" && edge.beforeStateHash === mechanicsStateHash({
      currentSceneId: "scene_start", foundClueIds: [], visitedSceneIds: ["scene_start"], ownedItemIds: [], stateValues: {}, npcStates: {},
      unlockedConnectionIds: [], failureCounts: {}, encounters: {}, startedEncounterIds: [], rewardIds: [],
    }))).toBe(false);
    expect(report.endingWitnesses.ending_escaped?.steps.map((edge) => edge.mechanismId)).toEqual(["find_key", "leave_start", "rule_escape"]);
  });

  it("does not retry a discovered clue through the successful method or another method", () => {
    const retrySymbols: MechanicsSymbols = { ...symbols, clueIds: ["clue_parent"], sceneIds: ["scene_foyer"], connectionIds: [], endingIds: [] };
    const ir = compileFixture([
      {
        kind: "discovery_method", id: "discover_once", clueId: "clue_parent", action: "search", target: "scene", targetId: "scene_foyer",
        onSuccess: [{ kind: "discover_clue", clueId: "clue_parent" }],
      },
      {
        kind: "discovery_method", id: "discover_other_way", clueId: "clue_parent", action: "read", target: "scene", targetId: "scene_foyer",
        check: { kind: "skill", skill: "library_use", difficulty: "regular" },
        onSuccess: [{ kind: "discover_clue", clueId: "clue_parent" }],
        onFailure: [{ kind: "set_state", stateKey: "archive_open", value: true }],
      },
    ], retrySymbols);
    const report = analyzeMechanicsReachability(ir, {
      entrySceneId: "scene_foyer",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
      coreClueIds: [], connections: [], discoveryLocations: { discover_once: "scene_foyer", discover_other_way: "scene_foyer" }, maxStates: 20,
    });
    const success = report.edges.find((edge) => edge.mechanismId === "discover_once" && edge.outcome === "success")!;
    expect(report.edges.some((edge) => ["discover_once", "discover_other_way"].includes(edge.mechanismId) && edge.beforeStateHash === success.afterStateHash)).toBe(false);
  });

  it("fails closed for conflicting or cyclic automatic transitions instead of selecting an array-order winner", () => {
    const automaticSymbols: MechanicsSymbols = { ...symbols, clueIds: [], connectionIds: [], endingIds: [], declaredStateKeys: ["archive_open"] };
    const conflict = compileFixture([
      { kind: "state_transition", id: "set_open", when: { kind: "not", predicate: { kind: "state_eq", stateKey: "archive_open", value: true } }, effects: [{ kind: "set_state", stateKey: "archive_open", value: true }] },
      { kind: "state_transition", id: "set_closed", when: { kind: "not", predicate: { kind: "state_eq", stateKey: "archive_open", value: true } }, effects: [{ kind: "set_state", stateKey: "archive_open", value: false }] },
    ], automaticSymbols);
    const input: MechanicsAnalysisInput = { entrySceneId: "scene_foyer", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} }, coreClueIds: [], connections: [], discoveryLocations: {}, maxStates: 20 };
    expect(() => analyzeMechanicsReachability(conflict, input)).toThrow("automatic transitions disagree");
    const cycle = compileFixture([
      { kind: "state_transition", id: "open", when: { kind: "not", predicate: { kind: "state_eq", stateKey: "archive_open", value: true } }, effects: [{ kind: "set_state", stateKey: "archive_open", value: true }] },
      { kind: "state_transition", id: "close", when: { kind: "state_eq", stateKey: "archive_open", value: true }, effects: [{ kind: "set_state", stateKey: "archive_open", value: false }] },
    ], automaticSymbols);
    expect(() => analyzeMechanicsReachability(cycle, input)).toThrow("closed state cycle");
    const terminalFirstSymbols: MechanicsSymbols = { ...automaticSymbols, endingIds: ["ending_now"] };
    const terminalFirst = compileFixture([
      { kind: "state_transition", id: "would_conflict_a", when: { kind: "not", predicate: { kind: "state_eq", stateKey: "archive_open", value: true } }, effects: [{ kind: "set_state", stateKey: "archive_open", value: true }] },
      { kind: "state_transition", id: "would_conflict_b", when: { kind: "not", predicate: { kind: "state_eq", stateKey: "archive_open", value: true } }, effects: [{ kind: "set_state", stateKey: "archive_open", value: false }] },
      { kind: "ending_rule", id: "terminal_first", priority: 1, when: { kind: "not", predicate: { kind: "state_eq", stateKey: "archive_open", value: true } }, effects: [{ kind: "end_game", endingId: "ending_now" }] },
    ], terminalFirstSymbols);
    expect(analyzeMechanicsReachability(terminalFirst, input).selectedTerminalEndingIds).toEqual(["ending_now"]);
  });

  it("reports a player-choice loop with no terminal recovery, but not a loop with an exit", () => {
    const loopSymbols: MechanicsSymbols = { ...symbols, clueIds: [], sceneIds: ["scene_foyer", "scene_archive"], connectionIds: ["to_archive", "to_foyer"], endingIds: ["ending_exit"] };
    const loopSpecs: MechanicsCandidateSpec[] = [
      { kind: "connection_gate", id: "go_archive", connectionId: "to_archive" },
      { kind: "connection_gate", id: "go_foyer", connectionId: "to_foyer" },
    ];
    const input: MechanicsAnalysisInput = { entrySceneId: "scene_foyer", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} }, coreClueIds: [], connections: [{ id: "to_archive", fromSceneId: "scene_foyer", toSceneId: "scene_archive" }, { id: "to_foyer", fromSceneId: "scene_archive", toSceneId: "scene_foyer" }], discoveryLocations: {}, maxStates: 20 };
    expect(analyzeMechanicsReachability(compileFixture(loopSpecs, loopSymbols), input).deadlockWitnesses.length).toBeGreaterThan(0);
    const withExit = [...loopSpecs, { kind: "ending_rule", id: "rule_exit", priority: 1, when: { kind: "scene_visited", sceneId: "scene_archive" }, effects: [{ kind: "end_game", endingId: "ending_exit" }] } as MechanicsCandidateSpec];
    expect(analyzeMechanicsReachability(compileFixture(withExit, loopSymbols), input).deadlockWitnesses).toEqual([]);
  });

  it("handles prototype-named method IDs with own failure counters and witnesses", () => {
    const prototypeSymbols: MechanicsSymbols = { ...symbols, clueIds: ["core"], sceneIds: ["entry"], connectionIds: [], endingIds: [], declaredStateKeys: ["phase"] };
    const bounded = compileFixture([{
      kind: "discovery_method", id: "constructor", clueId: "core", action: "search", target: "scene", targetId: "entry",
      check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "core" }],
      failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: "core" }] },
    }], prototypeSymbols);
    const boundedReport = analyzeMechanicsReachability(bounded, { entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} }, coreClueIds: ["core"], connections: [], discoveryLocations: { constructor: "entry" }, maxStates: 20 });
    expect(boundedReport.failbackWitnesses["constructor"]?.steps.slice(-3).map((step) => step.outcome)).toEqual(["failure", "failure", "failback"]);
    const deadlock = compileFixture([{
      kind: "discovery_method", id: "toString", clueId: "core", action: "search", target: "scene", targetId: "entry",
      check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "core" }], onFailure: [{ kind: "set_state", stateKey: "phase", value: 1 }],
    }], prototypeSymbols);
    const report = analyzeMechanicsReachability(deadlock, { entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} }, coreClueIds: ["core"], connections: [], discoveryLocations: { toString: "entry" }, maxStates: 20 });
    expect(Object.hasOwn(report.failureDeadlockWitnesses, "toString")).toBe(true);
    expect(JSON.parse(JSON.stringify(report.failureDeadlockWitnesses))).toHaveProperty("toString");
    const proto = compileFixture([{
      kind: "discovery_method", id: "__proto__", clueId: "core", action: "search", target: "scene", targetId: "entry",
      check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: "core" }],
      failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: "core" }] },
    }], prototypeSymbols);
    const protoInput: MechanicsAnalysisInput = { entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} }, coreClueIds: ["core"], connections: [], discoveryLocations: Object.fromEntries([["__proto__", "entry"]]), maxStates: 20 };
    const protoReport = analyzeMechanicsReachability(proto, protoInput);
    expect(Object.hasOwn(protoReport.failbackWitnesses, "__proto__")).toBe(true);
    const protoWitness = protoReport.failbackWitnesses["__proto__"]!;
    expect(protoWitness.steps.slice(-3).map((step) => step.outcome)).toEqual(["failure", "failure", "failback"]);
    const protoState = replayMechanicsWitness(proto, protoInput, protoWitness);
    expect(Object.hasOwn(protoState.failureCounts, "__proto__")).toBe(true);
    expect(protoState.failureCounts["__proto__"]).toBe(2);
    const restoredWitnesses = JSON.parse(JSON.stringify(protoReport.failbackWitnesses));
    expect(Object.hasOwn(restoredWitnesses, "__proto__")).toBe(true);
    expect(restoredWitnesses["__proto__"]).toEqual(protoWitness);
    expect(replayMechanicsWitness(proto, protoInput, restoredWitnesses["__proto__"])).toEqual(protoState);
  });

  it("charges replay only for its actual normalized witness states", () => {
    const budgetSymbols: MechanicsSymbols = { ...symbols, clueIds: ["core"], sceneIds: ["entry"], connectionIds: [], endingIds: ["done"], declaredStateKeys: ["phase"] };
    const ir = compileFixture([
      { kind: "state_transition", id: "one", when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "state_transition", id: "two", when: { kind: "state_eq", stateKey: "phase", value: 1 }, effects: [{ kind: "set_state", stateKey: "phase", value: 2 }] },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "state_eq", stateKey: "phase", value: 2 }, effects: [{ kind: "end_game", endingId: "done" }] },
    ], budgetSymbols);
    const input: MechanicsAnalysisInput = { entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} }, coreClueIds: [], connections: [], discoveryLocations: {}, maxStates: 4 };
    const witness = analyzeMechanicsReachability(ir, input).endingWitnesses.done!;
    expect(witness.steps.map((step) => step.mechanismId)).toEqual(["one", "two", "finish"]);
    expect(() => replayMechanicsWitness(ir, { ...input, maxStates: 3 }, witness)).toThrow("state limit");
    expect(replayMechanicsWitness(ir, input, witness).terminalEndingId).toBe("done");
    const initialCoreInput = { ...input, initialState: { ...input.initialState, foundClueIds: ["core"] }, coreClueIds: ["core"] };
    const initialCore = analyzeMechanicsReachability(ir, initialCoreInput);
    expect(initialCore.coreClueWitnesses["core"]?.steps).toEqual([]);
    expect(replayMechanicsWitness(ir, { ...initialCoreInput, maxStates: 1 }, initialCore.coreClueWitnesses["core"]!).foundClueIds).toEqual(["core"]);
  });

  it("charges the player-action state in an action, automatic, and ending replay", () => {
    const actionSymbols: MechanicsSymbols = { ...symbols, clueIds: ["core"], sceneIds: ["entry"], connectionIds: [], endingIds: ["done"], declaredStateKeys: ["phase"] };
    const ir = compileFixture([
      { kind: "discovery_method", id: "advance", clueId: "core", action: "search", target: "scene", targetId: "entry", onSuccess: [{ kind: "discover_clue", clueId: "core" }, { kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "state_transition", id: "automatic", when: { kind: "state_eq", stateKey: "phase", value: 1 }, effects: [{ kind: "set_state", stateKey: "phase", value: 2 }] },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "state_eq", stateKey: "phase", value: 2 }, effects: [{ kind: "end_game", endingId: "done" }] },
    ], actionSymbols);
    const input: MechanicsAnalysisInput = { entrySceneId: "entry", initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} }, coreClueIds: ["core"], connections: [], discoveryLocations: { advance: "entry" }, maxStates: 4 };
    const report = analyzeMechanicsReachability(ir, input);
    const witness = report.endingWitnesses.done!;
    expect(witness.steps.map((step) => step.mechanismId)).toEqual(["advance", "automatic", "finish"]);
    expect(new Set(witness.steps.flatMap((step) => [step.beforeStateHash, step.afterStateHash])).size).toBe(4);
    expect(() => replayMechanicsWitness(ir, { ...input, maxStates: 3 }, witness)).toThrow(expect.objectContaining({ code: "state_limit_exceeded" }));
    expect(replayMechanicsWitness(ir, input, witness).terminalEndingId).toBe("done");
    const coreWitness = report.coreClueWitnesses.core!;
    expect(coreWitness.steps.map((step) => step.mechanismId)).toEqual(["advance"]);
    expect(replayMechanicsWitness(ir, { ...input, maxStates: 2 }, coreWitness).stateValues.phase).toBe(1);
  });

  it("deduplicates revisited replay states and starts a fresh budget per invocation", () => {
    const loopSymbols: MechanicsSymbols = { ...symbols, clueIds: ["core"], sceneIds: ["entry"], connectionIds: ["loop_one", "loop_zero"], endingIds: [], declaredStateKeys: ["phase"] };
    const ir = compileFixture([
      { kind: "connection_gate", id: "to_one", connectionId: "loop_one", availability: { kind: "state_eq", stateKey: "phase", value: 0 }, onTraverse: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "connection_gate", id: "to_zero", connectionId: "loop_zero", availability: { kind: "state_eq", stateKey: "phase", value: 1 }, onTraverse: [{ kind: "set_state", stateKey: "phase", value: 0 }] },
    ], loopSymbols);
    const input: MechanicsAnalysisInput = { entrySceneId: "entry", initialState: { foundClueIds: ["core"], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} }, coreClueIds: ["core"], connections: [{ id: "loop_one", fromSceneId: "entry", toSceneId: "entry" }, { id: "loop_zero", fromSceneId: "entry", toSceneId: "entry" }], discoveryLocations: {}, maxStates: 2 };
    const witness = structuredClone(analyzeMechanicsReachability(ir, { ...input, maxStates: 20 }).coreClueWitnesses.core!);
    expect(witness.steps).toHaveLength(0);
    let state = replayMechanicsWitness(ir, { ...input, maxStates: 1 }, witness);
    for (let index = 0; index < 4; index++) {
      const phase = state.stateValues.phase === 0 ? 1 : 0;
      const gate = ir.connections.find((gate) => gate.id === (phase === 1 ? "to_one" : "to_zero"))!;
      const next = { ...state, stateValues: { ...state.stateValues, phase } };
      witness.steps.push({ mechanismId: gate.id, mechanismIds: [gate.id], outcome: "traverse", beforeStateHash: mechanicsStateHash(state), afterStateHash: mechanicsStateHash(next), sourceInterpretationIds: [...gate.sourceInterpretationIds], summary: `state:phase=${phase}` });
      state = next;
    }
    witness.final.stateHash = mechanicsStateHash(state);
    expect(new Set(witness.steps.flatMap((step) => [step.beforeStateHash, step.afterStateHash])).size).toBe(2);
    expect(() => replayMechanicsWitness(ir, { ...input, maxStates: 1 }, witness)).toThrow(expect.objectContaining({ code: "state_limit_exceeded" }));
    expect(replayMechanicsWitness(ir, input, witness)).toEqual(state);
    expect(replayMechanicsWitness(ir, input, witness)).toEqual(state);
  });

  it("does not import world-model, runtime, dataset, or ModuleData loaders", () => {
    const imports = scanImports(readFileSync("src/compiler/mechanics-reachability.ts", "utf8"));
    for (const forbidden of ["world-model-loader", "cthulhu-dataset", "game-session", "module-data-runtime-loader", "mythos-module"]) {
      expect(imports.some((entry) => importPointsTo(entry.path, forbidden))).toBe(false);
    }
  });
});
