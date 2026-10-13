import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { buildCompilerQuestionQueue, MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import {
  executeCompilerProcessSimulation,
  prepareCompilerProcessSimulation,
  replayMatchesCompilerProcessSimulation,
  resolveCompilerProcessSimulation,
  validateCompilerProcessSimulationLineage,
  type PreparedCompilerProcessSimulation,
  type ResolvedCompilerProcessSimulation,
} from "../diagnostics/compiler-process-simulation";

const INPUT = {
  moduleId: "compiler-process-simulation-fixture",
  sourceDescriptor: "compiler-process-simulation-fixture",
  rawPages: ["入口：\n普通叙述不能凭空绑定线索。\n▶父线索：一把刻有档案室标记的钥匙。\n档案室：\n▶子线索：一份需要检定才能读懂的档案。\n出口：\n▶出口说明：离开这里的旧车票。"],
};

function prepared(): PreparedCompilerProcessSimulation {
  const result = prepareCompilerProcessSimulation(INPUT);
  if ("status" in result) throw new Error(result.message);
  return result;
}

function mutablePrepared(value: PreparedCompilerProcessSimulation): PreparedCompilerProcessSimulation {
  return Object.assign({}, value, {
    identity: structuredClone(value.identity),
    graph: structuredClone(value.graph),
    draft: structuredClone(value.draft),
    queue: structuredClone(value.queue),
  });
}

function resolution(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
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
    reason: "explicit fixture declaration bound to this prepared queue evidence",
  };
}

function hints(prepared: PreparedCompilerProcessSimulation): ModuleCompileHints {
  const { draft, queue } = prepared;
  const scene = (name: string) => draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(name))!;
  const clue = (name: string) => draft.clueCandidates.find((candidate) => candidate.displayName === name)!;
  const entry = scene("入口");
  const archive = scene("档案室");
  const exit = scene("出口");
  const parent = clue("父线索");
  const child = clue("子线索");
  const topology = (sceneId: string) => queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === sceneId)!;
  const core = (clueId: string) => queue.questions.find((question) => question.kind === "core_clue" && question.subjectCandidateId === clueId)!;
  const discovery = (clueId: string) => queue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === clueId)!;
  const entryQuestion = queue.questions.find((question) => question.kind === "entry_scene")!;
  const endingQuestion = queue.questions.find((question) => question.kind === "ending_rule")!;
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => resolution(question, { shell: (question.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [] })),
      ...queue.questions.filter((question) => question.kind === "scene_role").map((question) => resolution(question, { role: "playable_scene" })),
      resolution(entryQuestion, { sceneCandidateId: entry.id }),
      resolution(topology(entry.id), { connections: [
        { toSceneCandidateId: archive.id, connectionId: "connection_entry_archive" },
        { toSceneCandidateId: exit.id, connectionId: "connection_entry_exit" },
      ] }),
      resolution(topology(archive.id), { connections: [
        { toSceneCandidateId: entry.id, connectionId: "connection_archive_entry" },
        { toSceneCandidateId: exit.id, connectionId: "connection_archive_exit", availability: { kind: "connection_unlocked", connectionId: "connection_archive_exit" } },
      ] }),
      resolution(topology(exit.id), { connections: [] }),
      resolution(core(parent.id), { clueCandidateId: parent.id, required: false }),
      resolution(core(child.id), { clueCandidateId: child.id, required: true }),
      resolution(discovery(parent.id), { clueCandidateId: parent.id, locationSceneCandidateId: entry.id, spec: {
        kind: "discovery_method", id: "discover_parent_explicit", clueId: parent.id, action: "search", target: "scene", targetId: entry.id,
        onSuccess: [{ kind: "discover_clue", clueId: parent.id }],
      } }),
      resolution(discovery(child.id), { clueCandidateId: child.id, locationSceneCandidateId: archive.id, spec: {
        kind: "discovery_method", id: "discover_child_checked", clueId: child.id, action: "read", target: "scene", targetId: archive.id,
        availability: { kind: "clue_found", clueId: parent.id }, check: { kind: "skill", skill: "library_use", difficulty: "hard" },
        onSuccess: [{ kind: "discover_clue", clueId: child.id }, { kind: "unlock_connection", connectionId: "connection_archive_exit" }],
        failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: child.id }, { kind: "unlock_connection", connectionId: "connection_archive_exit" }] },
      } }),
      resolution(endingQuestion, { declarations: [
        { endingId: "ending_clean_escape", spec: { kind: "ending_rule", id: "rule_clean_escape", priority: 10, when: { kind: "all", predicates: [{ kind: "clue_found", clueId: child.id }, { kind: "scene_visited", sceneId: exit.id }] }, effects: [{ kind: "end_game", endingId: "ending_clean_escape" }] } },
        { endingId: "ending_hasty_exit", spec: { kind: "ending_rule", id: "rule_hasty_exit", priority: 20, when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "not", predicate: { kind: "clue_found", clueId: child.id } }] }, effects: [{ kind: "end_game", endingId: "ending_hasty_exit" }] } },
      ] }),
    ],
  };
}

function resolved(): ResolvedCompilerProcessSimulation {
  const preparedValue = prepared();
  const result = resolveCompilerProcessSimulation(preparedValue, { preparedQueueHash: preparedValue.identity.preparedQueueHash, hints: hints(preparedValue) });
  if ("status" in result) throw new Error(result.message);
  return result;
}

function assertRefusal(result: unknown, stage: string, code: string): void {
  expect(result).toMatchObject({ status: "refused", stage, code });
  expect(result).not.toHaveProperty("identity");
  expect(result).not.toHaveProperty("requestedActions");
  expect(result).not.toHaveProperty("trace");
  expect(result).not.toHaveProperty("finalState");
  expect(result).not.toHaveProperty("finalStateHash");
  expect(result).not.toHaveProperty("terminalEndingId");
  expect(result).not.toHaveProperty("replayVerified");
}

describe("compiler process simulation", () => {
  it("prepares an immutable, deterministic graph/draft/question snapshot", () => {
    const left = prepared();
    const right = prepared();
    expect(left.identity).toEqual(right.identity);
    expect(left.queue.queueHash).toBe(left.identity.preparedQueueHash);
    expect(buildCompilerQuestionQueue(left.graph, left.draft).queueHash).toBe(left.queue.queueHash);
    expect(Object.isFrozen(left)).toBe(true);
    const detached = structuredClone(left);
    assertRefusal(resolveCompilerProcessSimulation(detached, { preparedQueueHash: detached.identity.preparedQueueHash, hints: hints(detached) }), "questions", "QUESTIONS_IDENTITY_MISMATCH");
  });

  it("executes the prescribed direct clean script and appends terminal-first ending selection", () => {
    const bundle = resolved();
    const result = executeCompilerProcessSimulation(bundle, {
      identity: bundle.identity,
      expectedEndingId: "ending_clean_escape",
      actions: [
        { mechanismId: "discover_parent_explicit", outcome: "success" },
        { mechanismId: "hint_connection_connection_entry_archive", outcome: "traverse" },
        { mechanismId: "discover_child_checked", outcome: "success" },
        { mechanismId: "hint_connection_connection_archive_exit", outcome: "traverse" },
      ],
    });
    if (result.status === "refused") throw new Error(result.message);
    expect(result.trace.map((step) => `${step.mechanismId}:${step.outcome}`)).toEqual([
      "discover_parent_explicit:success",
      "hint_connection_connection_entry_archive:traverse",
      "discover_child_checked:success",
      "hint_connection_connection_archive_exit:traverse",
      "rule_clean_escape:ending",
    ]);
    expect(result.finalState.foundClueIds).toHaveLength(2);
    expect(result.finalState.unlockedConnectionIds).toEqual(["connection_archive_exit"]);
    expect(result.replayVerified).toBe(true);
    const againBundle = resolved();
    const again = executeCompilerProcessSimulation(againBundle, {
      identity: againBundle.identity,
      expectedEndingId: "ending_clean_escape",
      actions: [
        { mechanismId: "discover_parent_explicit", outcome: "success" },
        { mechanismId: "hint_connection_connection_entry_archive", outcome: "traverse" },
        { mechanismId: "discover_child_checked", outcome: "success" },
        { mechanismId: "hint_connection_connection_archive_exit", outcome: "traverse" },
      ],
    });
    if (again.status === "refused") throw new Error(again.message);
    expect(again.identity).toEqual(result.identity);
    expect(again.trace).toEqual(result.trace);
    expect(again.finalState).toEqual(result.finalState);
    expect(again.finalStateHash).toBe(result.finalStateHash);
    expect(again.terminalEndingId).toBe(result.terminalEndingId);
  });

  it("requires replayed state and both hashes to match before reporting simulation success", () => {
    const bundle = resolved();
    const result = executeCompilerProcessSimulation(bundle, {
      identity: bundle.identity,
      expectedEndingId: "ending_hasty_exit",
      actions: [{ mechanismId: "hint_connection_connection_entry_exit", outcome: "traverse" }],
    });
    if (result.status === "refused") throw new Error(result.message);
    expect(replayMatchesCompilerProcessSimulation(result.finalState, result.finalState, result.finalStateHash, result.finalStateHash)).toBe(true);
    expect(replayMatchesCompilerProcessSimulation({ ...result.finalState, foundClueIds: ["changed"] }, result.finalState, result.finalStateHash, result.finalStateHash)).toBe(false);
    expect(replayMatchesCompilerProcessSimulation(result.finalState, result.finalState, "changed", result.finalStateHash)).toBe(false);
    expect(replayMatchesCompilerProcessSimulation(result.finalState, result.finalState, result.finalStateHash, "changed")).toBe(false);
    const source = readFileSync("src/diagnostics/compiler-process-simulation.ts", "utf8");
    expect(source).toContain("if (!replayMatchesCompilerProcessSimulation(replayed, state, finalStateHash, witness.final.stateHash))");
  });

  it("executes caller-prescribed bounded failback rather than the analyzer shortest witness", () => {
    const bundle = resolved();
    const result = executeCompilerProcessSimulation(bundle, {
      identity: bundle.identity,
      expectedEndingId: "ending_clean_escape",
      actions: [
        { mechanismId: "discover_parent_explicit", outcome: "success" },
        { mechanismId: "hint_connection_connection_entry_archive", outcome: "traverse" },
        { mechanismId: "discover_child_checked", outcome: "failure" },
        { mechanismId: "discover_child_checked", outcome: "failure" },
        { mechanismId: "discover_child_checked", outcome: "failback" },
        { mechanismId: "hint_connection_connection_archive_exit", outcome: "traverse" },
      ],
    });
    if (result.status === "refused") throw new Error(result.message);
    expect(result.trace.map((step) => `${step.mechanismId}:${step.outcome}`)).toContain("discover_child_checked:failback");
    expect(result.trace.filter((step) => step.mechanismId === "discover_child_checked").map((step) => step.outcome)).toEqual(["failure", "failure", "failback"]);
    expect(result.trace).not.toEqual(bundle.reachabilityReport.endingWitnesses.ending_clean_escape?.steps);
    expect(result.terminalEndingId).toBe("ending_clean_escape");
    expect(result.replayVerified).toBe(true);
  });

  it("selects hasty ending then refuses a script action after terminal", () => {
    const bundle = resolved();
    const hasty = executeCompilerProcessSimulation(bundle, {
      identity: bundle.identity,
      expectedEndingId: "ending_hasty_exit",
      actions: [{ mechanismId: "hint_connection_connection_entry_exit", outcome: "traverse" }],
    });
    if (hasty.status === "refused") throw new Error(hasty.message);
    expect(hasty.terminalEndingId).toBe("ending_hasty_exit");
    const afterTerminal = executeCompilerProcessSimulation(bundle, {
      identity: bundle.identity,
      expectedEndingId: "ending_hasty_exit",
      actions: [
        { mechanismId: "hint_connection_connection_entry_exit", outcome: "traverse" },
        { mechanismId: "discover_parent_explicit", outcome: "success" },
      ],
    });
    assertRefusal(afterTerminal, "execute", "EXECUTE_AFTER_TERMINAL");
  });

  it("refuses malformed prepare, question, hint, and resolved bundle boundaries", () => {
    assertRefusal(prepareCompilerProcessSimulation({ ...INPUT, rawPages: ["   "] }), "prepare", "PREPARE_INVALID_INPUT");
    assertRefusal(prepareCompilerProcessSimulation({ ...INPUT, rawPages: [] }), "prepare", "PREPARE_INVALID_INPUT");
    assertRefusal(prepareCompilerProcessSimulation({ ...INPUT, moduleId: "" }), "prepare", "PREPARE_INVALID_INPUT");
    assertRefusal(prepareCompilerProcessSimulation({ ...INPUT, sourceDescriptor: "" }), "prepare", "PREPARE_INVALID_INPUT");
    const queueTampered = mutablePrepared(prepared());
    queueTampered.identity.preparedQueueHash = "tampered";
    assertRefusal(resolveCompilerProcessSimulation(queueTampered, { preparedQueueHash: "tampered", hints: hints(prepared()) }), "questions", "QUESTIONS_HASH_MISMATCH");
    const queueIdentity = mutablePrepared(prepared());
    queueIdentity.queue.documentHash = "foreign-document";
    assertRefusal(resolveCompilerProcessSimulation(queueIdentity, { preparedQueueHash: queueIdentity.identity.preparedQueueHash, hints: hints(queueIdentity) }), "questions", "QUESTIONS_IDENTITY_MISMATCH");
    const forgedQueue = mutablePrepared(prepared());
    forgedQueue.queue.queueHash = "forged";
    forgedQueue.identity.preparedQueueHash = "forged";
    assertRefusal(resolveCompilerProcessSimulation(forgedQueue, { preparedQueueHash: "forged", hints: hints(forgedQueue) }), "questions", "QUESTIONS_HASH_MISMATCH");
    const graphTampered = mutablePrepared(prepared());
    graphTampered.draft.moduleId = "foreign";
    assertRefusal(resolveCompilerProcessSimulation(graphTampered, { preparedQueueHash: graphTampered.identity.preparedQueueHash, hints: hints(graphTampered) }), "questions", "QUESTIONS_IDENTITY_MISMATCH");
    const malformedGraph = mutablePrepared(prepared());
    malformedGraph.graph.schemaVersion = "unsupported" as never;
    assertRefusal(resolveCompilerProcessSimulation(malformedGraph, { preparedQueueHash: malformedGraph.identity.preparedQueueHash, hints: hints(malformedGraph) }), "questions", "QUESTIONS_INVALID");
    const evidenceCorrupted = mutablePrepared(prepared());
    evidenceCorrupted.graph.statements[0]!.evidence.spans[0]!.exactText = "corrupted";
    assertRefusal(resolveCompilerProcessSimulation(evidenceCorrupted, { preparedQueueHash: evidenceCorrupted.identity.preparedQueueHash, hints: hints(evidenceCorrupted) }), "questions", "QUESTIONS_INVALID");
    const matchingTypeError = mutablePrepared(prepared());
    Object.defineProperty(matchingTypeError.graph, "schemaVersion", { get: () => { throw new TypeError("evidence page missing: p1"); } });
    expect(() => resolveCompilerProcessSimulation(matchingTypeError, { preparedQueueHash: matchingTypeError.identity.preparedQueueHash, hints: hints(matchingTypeError) })).toThrow(TypeError);
    const clean = prepared();
    assertRefusal(resolveCompilerProcessSimulation(clean, { preparedQueueHash: "other", hints: hints(clean) }), "hints", "HINTS_QUEUE_HASH_MISMATCH");
    const foreignHints = hints(clean);
    foreignHints.moduleId = "foreign";
    assertRefusal(resolveCompilerProcessSimulation(clean, { preparedQueueHash: clean.identity.preparedQueueHash, hints: foreignHints }), "hints", "HINTS_IDENTITY_MISMATCH");
    const descriptorChanged = prepareCompilerProcessSimulation({ ...INPUT, sourceDescriptor: "changed-descriptor" });
    if ("status" in descriptorChanged) throw new Error(descriptorChanged.message);
    assertRefusal(resolveCompilerProcessSimulation(descriptorChanged, { preparedQueueHash: descriptorChanged.identity.preparedQueueHash, hints: hints(clean) }), "hints", "HINTS_IDENTITY_MISMATCH");
    const pagesChanged = prepareCompilerProcessSimulation({ ...INPUT, rawPages: [`${INPUT.rawPages[0]}\n变更`] });
    if ("status" in pagesChanged) throw new Error(pagesChanged.message);
    assertRefusal(resolveCompilerProcessSimulation(pagesChanged, { preparedQueueHash: pagesChanged.identity.preparedQueueHash, hints: hints(clean) }), "hints", "HINTS_IDENTITY_MISMATCH");
    const invalidHints = hints(clean);
    invalidHints.resolutions[0]!.evidenceRefs = [];
    const invalidEvidence = resolveCompilerProcessSimulation(clean, { preparedQueueHash: clean.identity.preparedQueueHash, hints: invalidHints });
    assertRefusal(invalidEvidence, "hints", "HINTS_INVALID");
    expect((invalidEvidence as { causeCode?: string }).causeCode).toBe("evidence_mismatch");
    const invalidDeclaration = hints(clean);
    const topology = invalidDeclaration.resolutions.find((entry) => entry.kind === "connection_topology")!;
    (topology.value as { connections: Array<{ connectionId: string }> }).connections[0]!.connectionId = "not valid spaces";
    assertRefusal(resolveCompilerProcessSimulation(clean, { preparedQueueHash: clean.identity.preparedQueueHash, hints: invalidDeclaration }), "hints", "HINTS_INVALID");
    const invalidKind = hints(clean);
    invalidKind.resolutions[0]!.kind = "state_key" as never;
    assertRefusal(resolveCompilerProcessSimulation(clean, { preparedQueueHash: clean.identity.preparedQueueHash, hints: invalidKind }), "hints", "HINTS_INVALID");
    const invalidReference = hints(clean);
    const core = invalidReference.resolutions.find((entry) => entry.kind === "core_clue")!;
    (core.value as { clueCandidateId: string }).clueCandidateId = "foreign_clue";
    assertRefusal(resolveCompilerProcessSimulation(clean, { preparedQueueHash: clean.identity.preparedQueueHash, hints: invalidReference }), "hints", "HINTS_INVALID");
    const missingEntry = hints(clean);
    missingEntry.resolutions = missingEntry.resolutions.filter((entry) => entry.kind !== "entry_scene");
    assertRefusal(resolveCompilerProcessSimulation(clean, { preparedQueueHash: clean.identity.preparedQueueHash, hints: missingEntry }), "resolve", "RESOLVE_NOT_MECHANICALLY_CLOSED");
    const invalidReview = mutablePrepared(prepared());
    invalidReview.draft.interpretations[0]!.review!.reason = "";
    assertRefusal(resolveCompilerProcessSimulation(invalidReview, { preparedQueueHash: invalidReview.identity.preparedQueueHash, hints: hints(invalidReview) }), "questions", "QUESTIONS_IDENTITY_MISMATCH");
  });

  it("binds every execution component to the original graph/draft/queue/hints resolve", () => {
    const bundle = resolved();
    const execute = (candidate: ResolvedCompilerProcessSimulation) => executeCompilerProcessSimulation(candidate, {
      identity: candidate.identity,
      expectedEndingId: "ending_clean_escape",
      actions: [],
    });
    const injectedClue = structuredClone(bundle);
    injectedClue.analysisInput.initialState.foundClueIds = [injectedClue.mechanicsIR.symbols.clueIds[0]!];
    assertRefusal(execute(injectedClue), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const changedEntry = structuredClone(bundle);
    changedEntry.analysisInput.entrySceneId = changedEntry.mechanicsIR.symbols.sceneIds[1]!;
    assertRefusal(execute(changedEntry), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const changedConnection = structuredClone(bundle);
    changedConnection.analysisInput.connections[0]!.toSceneId = changedConnection.mechanicsIR.symbols.sceneIds[2]!;
    assertRefusal(execute(changedConnection), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const changedLocation = structuredClone(bundle);
    changedLocation.analysisInput.discoveryLocations.discover_parent_explicit = changedLocation.mechanicsIR.symbols.sceneIds[1]!;
    assertRefusal(execute(changedLocation), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const changedHints = structuredClone(bundle);
    changedHints.hints.resolutions[0]!.reason = "changed after resolution";
    assertRefusal(execute(changedHints), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const emptyEvidence = structuredClone(bundle);
    emptyEvidence.reachabilityReport.edges = [];
    emptyEvidence.reachabilityReport.endingWitnesses = {};
    assertRefusal(execute(emptyEvidence), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const impossibleCount = structuredClone(bundle);
    impossibleCount.reachabilityReport.reachableStateCount = 0;
    assertRefusal(execute(impossibleCount), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const corruptedEvidence = structuredClone(bundle);
    corruptedEvidence.graph.statements[0]!.evidence.spans[0]!.exactText = "corrupted";
    assertRefusal(execute(corruptedEvidence), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const otherPrepared = prepareCompilerProcessSimulation({ ...INPUT, sourceDescriptor: "independent-process" });
    if ("status" in otherPrepared) throw new Error(otherPrepared.message);
    const mixed = structuredClone(bundle);
    mixed.preparedQueue = otherPrepared.queue;
    assertRefusal(execute(mixed), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
  });

  it("validates regenerated analysis input and complete report through the authenticated lineage seam", () => {
    const bundle = resolved();
    expect(validateCompilerProcessSimulationLineage(bundle)).toBeUndefined();
    const changedInput = structuredClone(bundle);
    changedInput.analysisInput.initialState.foundClueIds = [changedInput.mechanicsIR.symbols.clueIds[0]!];
    assertRefusal(validateCompilerProcessSimulationLineage(bundle, changedInput), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const inputOnly = structuredClone(bundle);
    inputOnly.analysisInput.maxStates += 1;
    assertRefusal(validateCompilerProcessSimulationLineage(bundle, inputOnly), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const changedReport = structuredClone(bundle);
    changedReport.reachabilityReport.edges = [];
    changedReport.reachabilityReport.endingWitnesses = {};
    changedReport.reachabilityReport.reachableStateCount = 0;
    assertRefusal(validateCompilerProcessSimulationLineage(bundle, changedReport), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    assertRefusal(validateCompilerProcessSimulationLineage(structuredClone(bundle)), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
  });

  it("settles an initially-terminal valid process before an empty prescribed script", () => {
    const preparedValue = prepared();
    const initialHints = hints(preparedValue);
    for (const core of initialHints.resolutions.filter((entry) => entry.kind === "core_clue")) (core.value as { required: boolean }).required = false;
    const ending = initialHints.resolutions.find((entry) => entry.kind === "ending_rule")!;
    const entrySceneId = preparedValue.draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith("入口"))!.id;
    ending.value = { declarations: [{ endingId: "ending_initial", spec: { kind: "ending_rule", id: "rule_initial", priority: 1, when: { kind: "scene_visited", sceneId: entrySceneId }, effects: [{ kind: "end_game", endingId: "ending_initial" }] } }] };
    const initialBundle = resolveCompilerProcessSimulation(preparedValue, { preparedQueueHash: preparedValue.identity.preparedQueueHash, hints: initialHints });
    if ("status" in initialBundle) throw new Error(initialBundle.message);
    const result = executeCompilerProcessSimulation(initialBundle, { identity: initialBundle.identity, expectedEndingId: "ending_initial", actions: [] });
    if (result.status === "refused") throw new Error(result.message);
    expect(result.trace.map((step) => `${step.mechanismId}:${step.outcome}`)).toEqual(["rule_initial:ending"]);
    expect(result.terminalEndingId).toBe("ending_initial");
  });

  it("refuses stale identities, unavailable actions, incomplete scripts, and wrong endings", () => {
    const bundle = resolved();
    const staleIdentity = { ...bundle.identity, mechanicsHash: "stale" };
    assertRefusal(executeCompilerProcessSimulation(bundle, { identity: staleIdentity, expectedEndingId: "ending_clean_escape", actions: [] }), "execute", "EXECUTE_SCRIPT_IDENTITY_MISMATCH");
    const otherPrepared = prepareCompilerProcessSimulation({ ...INPUT, sourceDescriptor: "separate-script-process" });
    if ("status" in otherPrepared) throw new Error(otherPrepared.message);
    const otherResolved = resolveCompilerProcessSimulation(otherPrepared, { preparedQueueHash: otherPrepared.identity.preparedQueueHash, hints: hints(otherPrepared) });
    if ("status" in otherResolved) throw new Error(otherResolved.message);
    assertRefusal(executeCompilerProcessSimulation(bundle, { identity: otherResolved.identity, expectedEndingId: "ending_clean_escape", actions: [] }), "execute", "EXECUTE_SCRIPT_IDENTITY_MISMATCH");
    const badBundle = structuredClone(bundle);
    badBundle.mechanicsIR.mechanicsHash = "tampered";
    assertRefusal(executeCompilerProcessSimulation(badBundle, { identity: badBundle.identity, expectedEndingId: "ending_clean_escape", actions: [] }), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const badQueue = structuredClone(bundle);
    badQueue.resolvedQueue.queueHash = "tampered";
    assertRefusal(executeCompilerProcessSimulation(badQueue, { identity: badQueue.identity, expectedEndingId: "ending_clean_escape", actions: [] }), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    const badReport = structuredClone(bundle);
    badReport.reachabilityReport.selectedTerminalEndingIds = [];
    assertRefusal(executeCompilerProcessSimulation(badReport, { identity: badReport.identity, expectedEndingId: "ending_clean_escape", actions: [] }), "execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH");
    assertRefusal(executeCompilerProcessSimulation(bundle, { identity: bundle.identity, expectedEndingId: "ending_clean_escape", actions: [
      { mechanismId: "discover_parent_explicit", outcome: "success" },
      { mechanismId: "hint_connection_connection_entry_archive", outcome: "traverse" },
      { mechanismId: "hint_connection_connection_archive_exit", outcome: "traverse" },
    ] }), "execute", "EXECUTE_ACTION_UNAVAILABLE");
    assertRefusal(executeCompilerProcessSimulation(bundle, { identity: bundle.identity, expectedEndingId: "ending_clean_escape", actions: [{ mechanismId: "discover_parent_explicit", outcome: "success" }] }), "execute", "EXECUTE_NOT_TERMINAL");
    const wrongEnding = executeCompilerProcessSimulation(bundle, { identity: bundle.identity, expectedEndingId: "ending_hasty_exit", actions: [
      { mechanismId: "discover_parent_explicit", outcome: "success" },
      { mechanismId: "hint_connection_connection_entry_archive", outcome: "traverse" },
      { mechanismId: "discover_child_checked", outcome: "success" },
      { mechanismId: "hint_connection_connection_archive_exit", outcome: "traverse" },
    ] });
    assertRefusal(wrongEnding, "execute", "EXECUTE_ENDING_MISMATCH");
    expect((wrongEnding as { message: string }).message).not.toContain("ending_clean_escape");
  });

  it("refuses failback before its declared two failures", () => {
    const bundle = resolved();
    assertRefusal(executeCompilerProcessSimulation(bundle, {
      identity: bundle.identity,
      expectedEndingId: "ending_clean_escape",
      actions: [
        { mechanismId: "discover_parent_explicit", outcome: "success" },
        { mechanismId: "hint_connection_connection_entry_archive", outcome: "traverse" },
        { mechanismId: "discover_child_checked", outcome: "failback" },
      ],
    }), "execute", "EXECUTE_ACTION_UNAVAILABLE");
  });

  it("keeps the diagnostics harness on the shared execution core without a second interpreter", () => {
    const source = readFileSync("src/diagnostics/compiler-process-simulation.ts", "utf8");
    expect(source).toContain('from "../compiler/mechanics-execution"');
    expect(source).not.toMatch(/\bPredicate\b|\bEffect\b/);
    expect(source).not.toMatch(/\bswitch\s*\(/);
    expect(source).not.toContain("endingWitnesses");
    expect(source).not.toContain("coreClueWitnesses");
    expect(source).not.toContain("failbackWitnesses");
    expect(source).toContain("JSON.parse(JSON.stringify({");
    expect(source).toContain("replayMechanicsWitness(resolved.mechanicsIR, resolved.analysisInput, witness)");
    expect(source).toContain("executionBudget.observe(executed.state)");
  });
});
