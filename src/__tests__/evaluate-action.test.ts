import { describe, expect, it } from "bun:test";
import { evaluateAction, type EvaluateActionInput } from "../compiler/evaluate-action";
import { runEvaluateActionFixtures, type EvaluateActionFixtureCase } from "../compiler/evaluate-action-fixtures";
import { initialMechanicsState, mechanicsStateHash } from "../compiler/mechanics-execution";
import {
  compileMechanics,
  type MechanicsCandidateSpec,
  type MechanicsCompilationInput,
  type MechanicsSymbols,
} from "../compiler/mechanics-ir";
import { replayMechanicsWitness, type MechanicsWitness } from "../compiler/mechanics-reachability";
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
  clueIds: ["clue_report"],
  sceneIds: ["scene_entry"],
  itemIds: [],
  npcIds: [],
  connectionIds: [],
  encounterIds: [],
  endingIds: ["ending_done"],
  rewardIds: [],
  declaredStateKeys: ["phase"],
};

function compileFixture(specs: MechanicsCandidateSpec[]) {
  const document = createSyntheticDocumentIR(["Evaluate action fixture."], "evaluate-action-fixture");
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const statementId = graph.statements[0]!.id;
  const quote = graph.statements[0]!.text;
  const sourceBound = specs.map((spec) => {
    const next = structuredClone(spec);
    if (next.kind === "discovery_method" || next.kind === "connection_gate") {
      for (const provenance of next.actorEffectProvenance ?? []) provenance.source = { statementId, quote };
    }
    return next;
  });
  const candidates: FactInterpretationCandidate<MechanicsCandidateSpec>[] = sourceBound.map((value) => ({
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
      reason: "evaluate action fixture",
      rightsStatus: "user_provided",
      scope: { moduleId: "evaluate-action-fixture" },
    },
    interpretationStatus: "candidate",
  }));
  const reviewed = applyFactInterpretationReviews({ ...graph, interpretations: candidates }, candidates.map((candidate) => ({
    interpretationId: candidate.id,
    decision: "accept" as const,
    reason: "fixture acceptance",
    reviewerKind: "deterministic_rule" as const,
    policyId: "evaluate-action-fixture-v1",
    reviewEvidenceStatementIds: [statementId],
  })));
  const input: MechanicsCompilationInput = {
    moduleId: "evaluate-action-fixture",
    documentHash: null,
    sourceGraphSchemaVersion: "1.1.0",
    symbols,
    acceptedInterpretationIds: candidates.map((candidate) => candidate.id),
  };
  return compileMechanics(reviewed, input);
}

function fixture(includeActorEffect = true): EvaluateActionInput {
  const sanity = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 0 }, failLoss: { kind: "fixed", amount: 1 } } as const;
  const onSuccess = includeActorEffect ? [sanity, { kind: "discover_clue", clueId: "clue_report" } as const] : [{ kind: "discover_clue", clueId: "clue_report" } as const];
  return {
    mechanicsIR: compileFixture([
      { kind: "state_transition", id: "prepare", when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
      {
        kind: "discovery_method", id: "inspect", clueId: "clue_report", action: "observe", target: "scene", targetId: "scene_entry",
        onSuccess,
        ...(includeActorEffect ? {
          actorEffectProvenance: [{
            effectPath: "onSuccess[0]",
            eventSlot: { kind: "discovery", mechanismId: "inspect", outcome: "success", effectIndex: 0 },
            source: { statementId: "placeholder", quote: "placeholder" },
          }],
        } : {}),
      },
      { kind: "state_transition", id: "resolve", when: { kind: "all", predicates: [{ kind: "clue_found", clueId: "clue_report" }, { kind: "state_eq", stateKey: "phase", value: 1 }] }, effects: [{ kind: "set_state", stateKey: "phase", value: 2 }] },
      { kind: "ending_rule", id: "finish", priority: 1, when: { kind: "state_eq", stateKey: "phase", value: 2 }, effects: [{ kind: "end_game", endingId: "ending_done" }] },
    ]),
    analysisInput: {
      entrySceneId: "scene_entry",
      initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: { phase: 0 }, npcStates: {} },
      coreClueIds: ["clue_report"],
      connections: [],
      discoveryLocations: { inspect: "scene_entry" },
      maxStates: 20,
    },
    requestedAction: { mechanismId: "inspect", outcome: "success" },
  };
}

function deeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  return Object.isFrozen(value) && Reflect.ownKeys(value).every((key) => deeplyFrozen((value as Record<PropertyKey, unknown>)[key]));
}

describe("evaluateAction", () => {
  it("is deterministic, settles before and after the action, and returns an immutable replay trace", () => {
    const input = fixture();
    const result = evaluateAction(input);
    const again = evaluateAction(input);

    expect(again).toEqual(result);
    expect(result.trace.map((edge) => `${edge.mechanismId}:${edge.outcome}`)).toEqual([
      "prepare:transition",
      "inspect:success",
      "resolve:transition",
      "finish:ending",
    ]);
    expect(result.finalState).toMatchObject({
      foundClueIds: ["clue_report"],
      stateValues: { phase: 2 },
      terminalEndingId: "ending_done",
    });
    expect(result.beforeStateHash).toBe(mechanicsStateHash(initialMechanicsState(input.analysisInput)));
    expect(result.afterStateHash).toBe(mechanicsStateHash(result.finalState));
    expect(result.trace[0]!.beforeStateHash).toBe(result.beforeStateHash);
    for (const [index, edge] of result.trace.entries()) {
      expect(edge.afterStateHash).toBe(index === result.trace.length - 1 ? result.afterStateHash : result.trace[index + 1]!.beforeStateHash);
    }

    const witness: MechanicsWitness = {
      startSceneId: input.analysisInput.entrySceneId,
      steps: structuredClone([...result.trace]),
      final: { kind: "ending", id: "ending_done", stateHash: result.afterStateHash },
    };
    expect(replayMechanicsWitness(input.mechanicsIR, input.analysisInput, witness)).toEqual(result.finalState);
    expect(deeplyFrozen(result)).toBe(true);
    expect(() => { (result.finalState.stateValues as Record<string, unknown>).phase = 99; }).toThrow(TypeError);
    (input.requestedAction as { mechanismId: string }).mechanismId = "changed-after-evaluation";
    expect(result.requestedAction.mechanismId).toBe("inspect");
  });

  it("reports selected actor effects without applying them to MechanicsState", () => {
    const withActorEffect = evaluateAction(fixture(true));
    const withoutActorEffect = evaluateAction(fixture(false));

    expect(withActorEffect.unresolvedActorEffects).toHaveLength(1);
    expect(withActorEffect.unresolvedActorEffects[0]).toMatchObject({
      outcome: "success",
      effectIndex: 0,
      effect: { kind: "sanity_check", failLoss: { kind: "fixed", amount: 1 } },
    });
    expect(withoutActorEffect.unresolvedActorEffects).toEqual([]);
    expect(withActorEffect.finalState).toEqual(withoutActorEffect.finalState);
    expect(withActorEffect.afterStateHash).toBe(withoutActorEffect.afterStateHash);
  });

  it("rejects non-exact requests and propagates automatic-settlement core errors", () => {
    const input = fixture();
    expect(() => evaluateAction({ ...input, unexpected: true })).toThrow("input has unexpected fields");
    expect(() => evaluateAction({ ...input, requestedAction: { ...input.requestedAction, unexpected: true } })).toThrow("requestedAction has unexpected fields");

    const conflicting = compileFixture([
      { kind: "state_transition", id: "set_one", when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "set_state", stateKey: "phase", value: 1 }] },
      { kind: "state_transition", id: "set_two", when: { kind: "state_eq", stateKey: "phase", value: 0 }, effects: [{ kind: "set_state", stateKey: "phase", value: 2 }] },
    ]);
    expect(() => evaluateAction({
      mechanicsIR: conflicting,
      analysisInput: { ...input.analysisInput, discoveryLocations: {}, coreClueIds: [] },
      requestedAction: input.requestedAction,
    })).toThrow(expect.objectContaining({ code: "automatic_transition_conflict" }));
  });
});

describe("evaluate action fixtures", () => {
  const expectedAfterStateHash = mechanicsStateHash({
    currentSceneId: "scene_entry",
    foundClueIds: ["clue_report"],
    visitedSceneIds: ["scene_entry"],
    ownedItemIds: [],
    stateValues: { phase: 2 },
    npcStates: {},
    unlockedConnectionIds: [],
    failureCounts: {},
    encounters: {},
    startedEncounterIds: [],
    rewardIds: [],
    terminalEndingId: "ending_done",
  });

  function validFixture(): EvaluateActionFixtureCase {
    return {
      id: "inspect_success",
      requestedAction: { mechanismId: "inspect", outcome: "success" },
      expected: {
        afterStateHash: expectedAfterStateHash,
        trace: [
          { mechanismId: "prepare", outcome: "transition" },
          { mechanismId: "inspect", outcome: "success" },
          { mechanismId: "resolve", outcome: "transition" },
          { mechanismId: "finish", outcome: "ending" },
        ],
      },
    };
  }

  it("runs explicit fixtures deterministically and returns a frozen replay-verified report", () => {
    const input = fixture();
    const fixtures = [validFixture()] as const;
    const first = runEvaluateActionFixtures(input.mechanicsIR, input.analysisInput, fixtures);
    const second = runEvaluateActionFixtures(input.mechanicsIR, input.analysisInput, fixtures);

    expect(first).toEqual(second);
    expect(first.inspect_success).toMatchObject({
      beforeStateHash: mechanicsStateHash(initialMechanicsState(input.analysisInput)),
      afterStateHash: expectedAfterStateHash,
      finalState: { terminalEndingId: "ending_done" },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.inspect_success)).toBe(true);
  });

  it("rejects fixture mismatches, empty lists, duplicate IDs, and unknown fields", () => {
    const input = fixture();
    const valid = validFixture();
    const mismatch = { ...valid, expected: { ...valid.expected, afterStateHash: "forged" } };

    expect(() => runEvaluateActionFixtures(input.mechanicsIR, input.analysisInput, [mismatch] as unknown as readonly [EvaluateActionFixtureCase])).toThrow("afterStateHash does not match the explicit expectation");
    expect(() => runEvaluateActionFixtures(input.mechanicsIR, input.analysisInput, [] as unknown as readonly [EvaluateActionFixtureCase])).toThrow("fixtures must be a non-empty array");
    expect(() => runEvaluateActionFixtures(input.mechanicsIR, input.analysisInput, [valid, { ...valid }] as unknown as readonly [EvaluateActionFixtureCase, EvaluateActionFixtureCase])).toThrow("duplicate fixture ID");
    expect(() => runEvaluateActionFixtures(input.mechanicsIR, input.analysisInput, [{ ...valid, unexpected: true }] as unknown as readonly [EvaluateActionFixtureCase])).toThrow("fixtures[0] has unexpected fields");
  });
});
