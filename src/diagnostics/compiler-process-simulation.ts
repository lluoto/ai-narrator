import { CompilerQuestionError, buildCompilerQuestionQueue, validateCompilerQuestionQueue, validateModuleCompileHints, type CompilerQuestionQueue, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { resolveDraftModule, type ResolvedDraftModule } from "../compiler/compile-hint-resolution";
import { compileDeterministicTemplates, type DraftModuleStructure } from "../compiler/deterministic-template-compiler";
import { executeMechanicsAction, mechanicsStateHash, settleAutomaticMechanics, settleInitialMechanics, validateMechanicsAnalysisInput, createMechanicsStateBudget, type MechanicsAnalysisInput, type MechanicsReachabilityEdge, type MechanicsState } from "../compiler/mechanics-execution";
import { MechanicsCompilationError, validateMechanicsIR, sourceFactGraphIdentity, type MechanicsIR } from "../compiler/mechanics-ir";
import { MechanicsReachabilityError, replayMechanicsWitness, type MechanicsReachabilityReport, type MechanicsWitness } from "../compiler/mechanics-reachability";
import { buildSourceFactGraph, validateSourceFactGraph, type SourceFactGraph } from "../compiler/source-fact-graph";
import { cleanPagesWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";

export type CompilerSimulationRefusalCode =
  | "PREPARE_INVALID_INPUT"
  | "PREPARE_FAILED"
  | "QUESTIONS_IDENTITY_MISMATCH"
  | "QUESTIONS_HASH_MISMATCH"
  | "QUESTIONS_INVALID"
  | "HINTS_QUEUE_HASH_MISMATCH"
  | "HINTS_IDENTITY_MISMATCH"
  | "HINTS_INVALID"
  | "RESOLVE_FAILED"
  | "RESOLVE_NOT_MECHANICALLY_CLOSED"
  | "RESOLVE_BUNDLE_INCOMPLETE"
  | "RESOLVE_IDENTITY_MISMATCH"
  | "EXECUTE_SCRIPT_IDENTITY_MISMATCH"
  | "EXECUTE_BUNDLE_IDENTITY_MISMATCH"
  | "EXECUTE_ACTION_UNAVAILABLE"
  | "EXECUTE_AFTER_TERMINAL"
  | "EXECUTE_NOT_TERMINAL"
  | "EXECUTE_ENDING_MISMATCH"
  | "EXECUTE_REPLAY_MISMATCH"
  | "EXECUTE_FAILED";

export interface CompilerSimulationRefusal {
  status: "refused";
  stage: "prepare" | "questions" | "hints" | "resolve" | "execute";
  code: CompilerSimulationRefusalCode;
  message: string;
  causeCode?: string;
  blockingCodes?: string[];
}

export interface PreparedProcessIdentity {
  moduleId: string;
  documentHash: string | null;
  sourceGraphIdentity: string;
  preparedQueueHash: string;
}

export interface PreparedCompilerProcessSimulation {
  identity: PreparedProcessIdentity;
  graph: SourceFactGraph;
  draft: DraftModuleStructure;
  queue: CompilerQuestionQueue;
}

export interface ResolvedProcessIdentity extends PreparedProcessIdentity {
  resolvedQueueHash: string;
  mechanicsHash: string;
}

export interface ResolvedCompilerProcessSimulation {
  identity: ResolvedProcessIdentity;
  graph: SourceFactGraph;
  draft: DraftModuleStructure;
  hints: ModuleCompileHints;
  preparedQueue: CompilerQuestionQueue;
  resolvedQueue: CompilerQuestionQueue;
  mechanicsIR: MechanicsIR;
  analysisInput: MechanicsAnalysisInput;
  reachabilityReport: MechanicsReachabilityReport;
}

export interface CompilerProcessSimulationInput {
  moduleId: string;
  sourceDescriptor: string;
  rawPages: string[];
}

export interface CompilerProcessHintEnvelope {
  preparedQueueHash: string;
  hints: ModuleCompileHints;
}

export interface PrescribedMechanicsAction {
  mechanismId: string;
  outcome: "success" | "failure" | "failback" | "traverse";
}

export interface PrescribedCompilerProcessScript {
  identity: ResolvedProcessIdentity;
  expectedEndingId: string;
  actions: PrescribedMechanicsAction[];
}

export interface SimulatedCompilerProcess {
  status: "simulated";
  identity: ResolvedProcessIdentity;
  requestedActions: PrescribedMechanicsAction[];
  trace: MechanicsReachabilityEdge[];
  finalState: MechanicsState;
  finalStateHash: string;
  terminalEndingId: string;
  replayVerified: true;
}

interface ResolutionLineage {
  identity: ResolvedProcessIdentity;
  graph: SourceFactGraph;
  draft: DraftModuleStructure;
  hints: ModuleCompileHints;
  preparedQueue: CompilerQuestionQueue;
  resolvedQueue: CompilerQuestionQueue;
  mechanicsIR: MechanicsIR;
  analysisInput: MechanicsAnalysisInput;
  reachabilityReport: MechanicsReachabilityReport;
}

interface PreparedLineage {
  identity: PreparedProcessIdentity;
  graph: SourceFactGraph;
  draft: DraftModuleStructure;
  queue: CompilerQuestionQueue;
}
const preparedLineages = new WeakMap<PreparedCompilerProcessSimulation, PreparedLineage>();
const resolvedLineages = new WeakMap<ResolvedCompilerProcessSimulation, ResolutionLineage>();

function refusal(stage: CompilerSimulationRefusal["stage"], code: CompilerSimulationRefusalCode, error: unknown, blockingCodes?: string[]): CompilerSimulationRefusal {
  const message = error instanceof Error ? error.message : String(error);
  const candidate = error as { code?: unknown };
  return {
    status: "refused",
    stage,
    code,
    message,
    ...(typeof candidate?.code === "string" ? { causeCode: candidate.code } : {}),
    ...(blockingCodes?.length ? { blockingCodes: [...new Set(blockingCodes)].sort() } : {}),
  };
}

function clone<T>(value: T): T { return structuredClone(value); }

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function sameSnapshot(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function bindPrepared(prepared: PreparedCompilerProcessSimulation): PreparedCompilerProcessSimulation {
  const lineage = freeze(clone(prepared));
  preparedLineages.set(prepared, lineage);
  return freeze(prepared);
}

function sameIdentity(left: PreparedProcessIdentity, right: PreparedProcessIdentity): boolean {
  return left.moduleId === right.moduleId && left.documentHash === right.documentHash && left.sourceGraphIdentity === right.sourceGraphIdentity && left.preparedQueueHash === right.preparedQueueHash;
}

function knownCompilerError(error: unknown): boolean {
  if (error instanceof CompilerQuestionError || error instanceof MechanicsCompilationError || error instanceof MechanicsReachabilityError) return true;
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError) return false;
  // SourceFactGraph, DocumentIR, and the draft/queue contract predate dedicated
  // error classes. Match their documented caller-data failures, not generic bugs.
  return error instanceof Error && /^(evidence (page missing|document hash mismatch|span out of bounds|exactText mismatch|text hash mismatch):|duplicate DocumentBlock id:|DocumentBlock parent missing:|marked item parser disagrees with block parser$|document pages and traces length mismatch:|unsupported graph schema:|duplicate SourceStatement id:|SourceStatement is not source_exact\/uninterpreted:|SourceStatement parent missing:|duplicate SourceRelation id:|SourceRelation endpoint missing:|duplicate interpretation id:|interpretation has no source statements:|interpretation source statement missing:|interpretation evidence does not reference statement:|accepted interpretation has non-accepted claim:|accepted interpretation lacks review audit:|accepted interpretation has non-accept review:|review (interpretation mismatch:|reason is required:|evidence is required:|evidence duplicates a statement:|evidence is outside interpretation sources:|policyId is required:|interpretation missing:)|accept review lacks reviewerKind:|conflicting interpretation reviews:|draft_queue_(module|identity|semantic)_mismatch$)/.test(error.message);
}

function expectedRefusal(stage: CompilerSimulationRefusal["stage"], code: CompilerSimulationRefusalCode, error: unknown, blockingCodes?: string[]): CompilerSimulationRefusal {
  if (!knownCompilerError(error)) throw error;
  return refusal(stage, code, error, blockingCodes);
}

function questionsRefusal(error: unknown): CompilerSimulationRefusal {
  if (error instanceof CompilerQuestionError && error.code === "identity_mismatch") return refusal("questions", "QUESTIONS_IDENTITY_MISMATCH", error);
  if (error instanceof CompilerQuestionError && error.code === "hash_mismatch") return refusal("questions", "QUESTIONS_HASH_MISMATCH", error);
  return expectedRefusal("questions", "QUESTIONS_INVALID", error);
}

function validatePrepared(prepared: PreparedCompilerProcessSimulation): CompilerSimulationRefusal | undefined {
  try {
    validateSourceFactGraph(prepared.graph);
    const graphIdentity = sourceFactGraphIdentity(prepared.graph);
    if (prepared.identity.preparedQueueHash !== prepared.queue.queueHash) return refusal("questions", "QUESTIONS_HASH_MISMATCH", "prepared queue hash does not match queue");
    if (prepared.identity.moduleId !== prepared.draft.moduleId || prepared.identity.documentHash !== prepared.graph.documentIdentity.documentHash || prepared.identity.sourceGraphIdentity !== graphIdentity || prepared.draft.sourceGraphIdentity !== graphIdentity || prepared.draft.documentHash !== prepared.identity.documentHash) {
      return refusal("questions", "QUESTIONS_IDENTITY_MISMATCH", "prepared graph, draft, or identity does not agree");
    }
    validateCompilerQuestionQueue(prepared.graph, prepared.queue);
    const regenerated = buildCompilerQuestionQueue(prepared.graph, prepared.draft);
    if (regenerated.queueHash !== prepared.queue.queueHash || prepared.draft.readiness.questionQueueHash !== prepared.queue.queueHash) return refusal("questions", "QUESTIONS_HASH_MISMATCH", "prepared queue differs from the deterministic queue");
    return undefined;
  } catch (error) {
    return questionsRefusal(error);
  }
}

export function prepareCompilerProcessSimulation(input: CompilerProcessSimulationInput): PreparedCompilerProcessSimulation | CompilerSimulationRefusal {
  if (!input.moduleId.trim() || !input.sourceDescriptor.trim() || input.rawPages.length === 0 || input.rawPages.every((page) => !page.trim())) {
    return refusal("prepare", "PREPARE_INVALID_INPUT", "moduleId, sourceDescriptor, and at least one non-blank page are required");
  }
  try {
    const document = createSyntheticDocumentIR([...input.rawPages], input.sourceDescriptor);
    const blocks = buildDocumentBlocks(document, joinPagesWithTrace(cleanPagesWithTrace(document.pages)));
    const graph = buildSourceFactGraph(document, blocks);
    const draft = compileDeterministicTemplates(graph, { moduleId: input.moduleId });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const identity: PreparedProcessIdentity = {
      moduleId: input.moduleId,
      documentHash: document.documentHash,
      sourceGraphIdentity: sourceFactGraphIdentity(graph),
      preparedQueueHash: queue.queueHash,
    };
    const prepared = { identity, graph, draft, queue };
    const invalid = validatePrepared(prepared);
    return invalid ?? bindPrepared(prepared);
  } catch (error) {
    return expectedRefusal("prepare", "PREPARE_FAILED", error);
  }
}

function validateResolvedBundle(bundle: ResolvedCompilerProcessSimulation): CompilerSimulationRefusal | undefined {
  try {
    validateSourceFactGraph(bundle.graph);
    validateCompilerQuestionQueue(bundle.graph, bundle.preparedQueue);
    validateCompilerQuestionQueue(bundle.graph, bundle.resolvedQueue);
    validateMechanicsIR(bundle.mechanicsIR);
    validateMechanicsAnalysisInput(bundle.mechanicsIR, bundle.analysisInput);
    const graphIdentity = sourceFactGraphIdentity(bundle.graph);
    if (bundle.identity.moduleId !== bundle.preparedQueue.moduleId || bundle.identity.moduleId !== bundle.resolvedQueue.moduleId || bundle.identity.moduleId !== bundle.mechanicsIR.moduleId || bundle.identity.documentHash !== bundle.graph.documentIdentity.documentHash || bundle.identity.documentHash !== bundle.preparedQueue.documentHash || bundle.identity.documentHash !== bundle.resolvedQueue.documentHash || bundle.identity.documentHash !== bundle.mechanicsIR.documentHash || bundle.identity.sourceGraphIdentity !== graphIdentity || bundle.identity.sourceGraphIdentity !== bundle.preparedQueue.sourceGraphIdentity || bundle.identity.sourceGraphIdentity !== bundle.resolvedQueue.sourceGraphIdentity || bundle.identity.sourceGraphIdentity !== bundle.mechanicsIR.sourceGraphIdentity || bundle.identity.preparedQueueHash !== bundle.preparedQueue.queueHash || bundle.identity.resolvedQueueHash !== bundle.resolvedQueue.queueHash || bundle.identity.mechanicsHash !== bundle.mechanicsIR.mechanicsHash) {
      return refusal("execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH", "resolved bundle identity does not agree");
    }
    validateModuleCompileHints(bundle.preparedQueue, bundle.hints, bundle.graph);
    const regenerated = resolveDraftModule(bundle.graph, bundle.draft, bundle.preparedQueue, bundle.hints);
    const complete = regenerated.readiness.status === "mechanically_closed" && regenerated.mechanicsIR && regenerated.analysisInput && regenerated.reachabilityReport;
    const lineageMatches = complete &&
      JSON.stringify(regenerated.resolvedQueue) === JSON.stringify(bundle.resolvedQueue) &&
      JSON.stringify(regenerated.mechanicsIR) === JSON.stringify(bundle.mechanicsIR) &&
      JSON.stringify(regenerated.analysisInput) === JSON.stringify(bundle.analysisInput) &&
      JSON.stringify(regenerated.reachabilityReport) === JSON.stringify(bundle.reachabilityReport);
    if (!lineageMatches || bundle.reachabilityReport.analysisScope !== "closed_world" || bundle.reachabilityReport.selectedTerminalEndingIds.length === 0 || bundle.reachabilityReport.unreachableCoreClueIds.length || bundle.reachabilityReport.unreachableEndingIds.length || bundle.reachabilityReport.deadlockWitnesses.length || bundle.reachabilityReport.failurePolicyRiskMethodIds.length) {
      return refusal("execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH", "resolved report is not a closed-world terminal report");
    }
    return undefined;
  } catch (error) {
    return expectedRefusal("execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH", error);
  }
}

/** Test-facing diagnostics seam: validates candidate lineage without executing it. */
export function validateCompilerProcessSimulationLineage(
  bound: ResolvedCompilerProcessSimulation,
  candidate: ResolvedCompilerProcessSimulation = bound,
): CompilerSimulationRefusal | undefined {
  if (!resolvedLineages.has(bound)) return refusal("execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH", "resolved bundle is not bound to an in-memory process");
  return validateResolvedBundle(candidate);
}

export function resolveCompilerProcessSimulation(prepared: PreparedCompilerProcessSimulation, envelope: CompilerProcessHintEnvelope): ResolvedCompilerProcessSimulation | CompilerSimulationRefusal {
  const invalidPrepared = validatePrepared(prepared);
  if (invalidPrepared) return invalidPrepared;
  const preparedLineage = preparedLineages.get(prepared);
  if (!preparedLineage) return refusal("questions", "QUESTIONS_IDENTITY_MISMATCH", "prepared snapshot is not bound to this process");
  if (!sameSnapshot(prepared, preparedLineage)) return refusal("questions", "QUESTIONS_IDENTITY_MISMATCH", "prepared graph, draft, or queue no longer matches its in-memory process");
  const preparedCopy = clone(preparedLineage);
  if (envelope.preparedQueueHash !== preparedCopy.identity.preparedQueueHash) return refusal("hints", "HINTS_QUEUE_HASH_MISMATCH", "hint envelope does not name the prepared queue");
  if (envelope.hints.moduleId !== preparedCopy.identity.moduleId || envelope.hints.documentHash !== preparedCopy.identity.documentHash || envelope.hints.sourceGraphIdentity !== preparedCopy.identity.sourceGraphIdentity) {
    return refusal("hints", "HINTS_IDENTITY_MISMATCH", "hint identity does not match prepared process");
  }
  try {
    validateModuleCompileHints(preparedCopy.queue, envelope.hints, preparedCopy.graph);
  } catch (error) {
    return expectedRefusal("hints", "HINTS_INVALID", error);
  }
  let resolved: ResolvedDraftModule;
  try {
    resolved = resolveDraftModule(preparedCopy.graph, preparedCopy.draft, preparedCopy.queue, clone(envelope.hints));
  } catch (error) {
    return expectedRefusal("resolve", "RESOLVE_FAILED", error);
  }
  if (resolved.readiness.status !== "mechanically_closed") return refusal("resolve", "RESOLVE_NOT_MECHANICALLY_CLOSED", "resolved process is not mechanically closed", resolved.readiness.blockingCodes);
  if (!resolved.mechanicsIR || !resolved.analysisInput || !resolved.reachabilityReport) return refusal("resolve", "RESOLVE_BUNDLE_INCOMPLETE", "mechanically closed result lacks executable bundle");
  if (resolved.resolvedQueue.queueHash !== resolved.readiness.questionQueueHash || resolved.resolvedQueue.moduleId !== preparedCopy.identity.moduleId || resolved.resolvedQueue.documentHash !== preparedCopy.identity.documentHash || resolved.resolvedQueue.sourceGraphIdentity !== preparedCopy.identity.sourceGraphIdentity) {
    return refusal("resolve", "RESOLVE_IDENTITY_MISMATCH", "resolved queue identity does not agree");
  }
  const identity: ResolvedProcessIdentity = {
    ...preparedCopy.identity,
    resolvedQueueHash: resolved.resolvedQueue.queueHash,
    mechanicsHash: resolved.mechanicsIR.mechanicsHash,
  };
  const bundle = {
    identity,
    graph: preparedCopy.graph,
    draft: preparedCopy.draft,
    hints: clone(envelope.hints),
    preparedQueue: preparedCopy.queue,
    resolvedQueue: resolved.resolvedQueue,
    mechanicsIR: resolved.mechanicsIR,
    analysisInput: resolved.analysisInput,
    reachabilityReport: resolved.reachabilityReport,
  };
  try {
    validateMechanicsIR(bundle.mechanicsIR);
    validateMechanicsAnalysisInput(bundle.mechanicsIR, bundle.analysisInput);
  } catch (error) {
    return expectedRefusal("resolve", "RESOLVE_IDENTITY_MISMATCH", error);
  }
  if (bundle.reachabilityReport.analysisScope !== "closed_world" || bundle.reachabilityReport.selectedTerminalEndingIds.length === 0 || bundle.reachabilityReport.unreachableCoreClueIds.length || bundle.reachabilityReport.unreachableEndingIds.length || bundle.reachabilityReport.deadlockWitnesses.length || bundle.reachabilityReport.failurePolicyRiskMethodIds.length) return refusal("resolve", "RESOLVE_BUNDLE_INCOMPLETE", "closed-world terminal report is incomplete");
  const resolvedLineage = freeze(clone(bundle));
  resolvedLineages.set(bundle, resolvedLineage);
  return freeze(bundle);
}

function sameResolvedIdentity(left: ResolvedProcessIdentity, right: ResolvedProcessIdentity): boolean {
  return sameIdentity(left, right) && left.resolvedQueueHash === right.resolvedQueueHash && left.mechanicsHash === right.mechanicsHash;
}

function edgesChain(edges: readonly MechanicsReachabilityEdge[]): boolean {
  return edges.every((edge, index) => index === 0 || edge.beforeStateHash === edges[index - 1]!.afterStateHash);
}

/** Pure postcondition for the JSON-round-tripped witness replay. */
export function replayMatchesCompilerProcessSimulation(
  replayedState: MechanicsState,
  simulatedFinalState: MechanicsState,
  simulatedFinalHash: string,
  witnessFinalHash: string,
): boolean {
  return JSON.stringify(replayedState) === JSON.stringify(simulatedFinalState) &&
    mechanicsStateHash(replayedState) === simulatedFinalHash &&
    witnessFinalHash === simulatedFinalHash;
}

export function executeCompilerProcessSimulation(bundle: ResolvedCompilerProcessSimulation, script: PrescribedCompilerProcessScript): SimulatedCompilerProcess | CompilerSimulationRefusal {
  const lineage = resolvedLineages.get(bundle);
  if (!lineage || !sameSnapshot(bundle.identity, lineage.identity) || !sameSnapshot(bundle.graph, lineage.graph) || !sameSnapshot(bundle.draft, lineage.draft) || !sameSnapshot(bundle.hints, lineage.hints) || !sameSnapshot(bundle.preparedQueue, lineage.preparedQueue) || !sameSnapshot(bundle.resolvedQueue, lineage.resolvedQueue) || !sameSnapshot(bundle.mechanicsIR, lineage.mechanicsIR) || !sameSnapshot(bundle.analysisInput, lineage.analysisInput) || !sameSnapshot(bundle.reachabilityReport, lineage.reachabilityReport)) {
    return refusal("execute", "EXECUTE_BUNDLE_IDENTITY_MISMATCH", "resolved bundle no longer matches its in-memory resolve lineage");
  }
  if (!sameResolvedIdentity(lineage.identity, script.identity)) return refusal("execute", "EXECUTE_SCRIPT_IDENTITY_MISMATCH", "script identity does not match resolved process");
  const resolved = clone(lineage);
  const invalidBundle = validateCompilerProcessSimulationLineage(bundle, resolved);
  if (invalidBundle) return invalidBundle;
  try {
    const executionBudget = createMechanicsStateBudget(resolved.analysisInput.maxStates);
    const initialSettlement = settleInitialMechanics(resolved.mechanicsIR, resolved.analysisInput, executionBudget);
    let state = initialSettlement.state;
    const executionTrace = [...initialSettlement.steps];
    for (const requested of script.actions) {
      if (state.terminalEndingId) return refusal("execute", "EXECUTE_AFTER_TERMINAL", "script continues after terminal ending");
      let executed;
      try {
        executed = executeMechanicsAction(resolved.mechanicsIR, resolved.analysisInput, state, requested);
      } catch (error) {
        return expectedRefusal("execute", "EXECUTE_ACTION_UNAVAILABLE", error);
      }
      executionTrace.push(executed.edge);
      executionBudget.observe(executed.state);
      const settlement = settleAutomaticMechanics(resolved.mechanicsIR, executed.state, executionBudget);
      executionTrace.push(...settlement.steps);
      state = settlement.state;
    }
    if (!state.terminalEndingId) return refusal("execute", "EXECUTE_NOT_TERMINAL", "prescribed script ended before a terminal ending");
    if (state.terminalEndingId !== script.expectedEndingId) return refusal("execute", "EXECUTE_ENDING_MISMATCH", "expected ending did not match terminal result");
    if (!edgesChain(executionTrace)) return refusal("execute", "EXECUTE_REPLAY_MISMATCH", "simulation trace has non-adjacent state hashes");
    const finalStateHash = mechanicsStateHash(state);
    const witness: MechanicsWitness = JSON.parse(JSON.stringify({
      startSceneId: resolved.analysisInput.entrySceneId,
      steps: executionTrace,
      final: { kind: "ending", id: state.terminalEndingId, stateHash: finalStateHash },
    }));
    let replayed: MechanicsState;
    try {
      replayed = replayMechanicsWitness(resolved.mechanicsIR, resolved.analysisInput, witness);
    } catch (error) {
      return expectedRefusal("execute", "EXECUTE_REPLAY_MISMATCH", error);
    }
    if (!replayMatchesCompilerProcessSimulation(replayed, state, finalStateHash, witness.final.stateHash)) return refusal("execute", "EXECUTE_REPLAY_MISMATCH", "replay final state differs from simulation");
    return { status: "simulated", identity: clone(resolved.identity), requestedActions: clone(script.actions), trace: executionTrace, finalState: clone(state), finalStateHash, terminalEndingId: state.terminalEndingId, replayVerified: true };
  } catch (error) {
    return expectedRefusal("execute", "EXECUTE_FAILED", error);
  }
}
