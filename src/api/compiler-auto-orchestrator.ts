/**
 * Internal, transport-free composition of the prepared compiler and the
 * untrusted proposal adapter. This module deliberately owns no HTTP, PDF, or
 * network client: callers provide source bytes/pages and an LLMLike instance.
 */
import {
  requestCompilerHintProposals,
  type CompilerHintProposalAdapterDiagnostic,
  type CompilerHintProposalAdapterLimits,
  type CompilerHintProposalAdapterStatus,
  type TrustedCompilerHintProposalProducer,
} from "./compiler-hint-proposal-adapter";
import { applyModuleCompileHints, resolveDraftModule } from "../compiler/compile-hint-resolution";
import {
  prepareCompiler,
  resolveCompiler,
  type CompilerApiRefusal,
  type CompilerResolveResult,
  type CompilerSourceInput,
  type PreparedCompilerApiResult,
  type ResolvedCompilerApiResult,
} from "../compiler/compiler-api";
import { restoreCompilerArtifact } from "../compiler/compiler-artifact";
import {
  MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  validateModuleCompileHints,
  type CompilerQuestionQueue,
  type ModuleCompileHints,
} from "../compiler/compiler-question-queue";
import type { TrustedCompilerHintProposalPolicy } from "../compiler/compiler-hint-proposals";
import type { LLMLike } from "../llm/client";

export const AUTO_COMPILER_ORCHESTRATOR_SCHEMA_VERSION = "1.0.0";

const DEFAULT_MAX_PROPOSAL_ROUNDS = 2;
const MAX_PROPOSAL_ROUNDS = 4;

export interface AutoCompilerOrchestratorInput {
  /** Passed unchanged to prepareCompiler; this is not an HTTP/PDF transport API. */
  source: CompilerSourceInput;
  /** The only model capability used by this layer. */
  llm: LLMLike;
  /** Trusted caller-owned policy; proposals can never supply these fields. */
  policy: TrustedCompilerHintProposalPolicy;
  /** Trusted caller-owned provider/model labels; never credentials or URLs. */
  producer: TrustedCompilerHintProposalProducer;
  /** Optional caller-reviewed answers. They are validated before any model request. */
  explicitHints?: ModuleCompileHints;
  /** Bounded adapter request/output limits. Defaults remain inside the adapter. */
  proposalLimits?: Partial<CompilerHintProposalAdapterLimits>;
  /** Stops after bounded progress rounds; answered questions are never re-asked. */
  maxProposalRounds?: number;
  /** Cooperative whole-job cancellation; no later proposal round may start once aborted. */
  signal?: AbortSignal;
}

/**
 * Reuses the same deterministic resolution loop for an already restored
 * prepared artifact. HTTP callers obtain this value exclusively from the
 * catalog; the entry revalidates it before trusting its graph or queue.
 */
export interface PreparedAutoCompilerOrchestratorInput extends Omit<AutoCompilerOrchestratorInput, "source"> {
  prepared: PreparedCompilerApiResult;
}

export type AutoCompilerDiagnosticStage = "prepare" | "explicit_hints" | "proposal" | "merge" | "draft_snapshot" | "resolve" | "orchestrator";

export interface AutoCompilerDiagnostic {
  stage: AutoCompilerDiagnosticStage;
  code: string;
  message: string;
  round?: number;
  questionId?: string;
  proposalIndex?: number;
  chunkIndex?: number;
  adapterStage?: CompilerHintProposalAdapterDiagnostic["stage"];
}

export interface AutoCompilerProposalRound {
  round: number;
  queueHash: string;
  status: CompilerHintProposalAdapterStatus;
  askedQuestionIds: string[];
  acceptedQuestionIds: string[];
  callCount: number;
}

interface AutoCompilerPreparedState {
  prepared: PreparedCompilerApiResult;
  hints: ModuleCompileHints;
  queue: CompilerQuestionQueue;
  rounds: AutoCompilerProposalRound[];
  diagnostics: AutoCompilerDiagnostic[];
}

export interface AutoCompilerResolvedResult extends AutoCompilerPreparedState {
  status: "resolved";
  resolved: ResolvedCompilerApiResult;
}

/**
 * A compact, deterministic view of the same draft resolution used by the
 * compiler. It is intentionally diagnostic-only: it never promotes a draft
 * into a resolved artifact.
 */
export interface AutoCompilerDraftResolutionSnapshot {
  readiness: {
    status: "draft_only" | "mechanically_closed";
    blockingCodes: string[];
    openQuestionIds: string[];
    publishBlockingQuestionIds: string[];
    generatedMechanicIds: string[];
  };
  analysis?: {
    unreachableCoreClueIds: string[];
    unreachableEndingIds: string[];
    deadlockIds: string[];
    failurePolicyRiskMethodIds: string[];
  };
}

/** Prepared material and only validated answers; this is never a publishable artifact. */
export interface AutoCompilerDraftOnlyResult extends AutoCompilerPreparedState {
  status: "draft_only";
  resolveRefusal?: CompilerApiRefusal;
  /** Present only after validated hints could be analysed against the prepared draft. */
  resolutionSnapshot?: AutoCompilerDraftResolutionSnapshot;
  unansweredQuestionIds: string[];
}

export interface AutoCompilerRefusedResult {
  status: "refused";
  diagnostics: AutoCompilerDiagnostic[];
  refusal?: CompilerApiRefusal;
}

export type AutoCompilerOrchestratorResult = AutoCompilerResolvedResult | AutoCompilerDraftOnlyResult | AutoCompilerRefusedResult;

function emptyHints(queue: CompilerQuestionQueue): ModuleCompileHints {
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [],
  };
}

function codeFor(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : fallback;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function roundsFor(value: number | undefined): number | undefined {
  const rounds = value ?? DEFAULT_MAX_PROPOSAL_ROUNDS;
  return Number.isInteger(rounds) && rounds >= 1 && rounds <= MAX_PROPOSAL_ROUNDS ? rounds : undefined;
}

function proposalDiagnostics(round: number, rejected: CompilerHintProposalAdapterDiagnostic[]): AutoCompilerDiagnostic[] {
  return rejected.map((diagnostic) => ({
    stage: "proposal",
    code: diagnostic.code,
    message: diagnostic.message,
    round,
    ...(diagnostic.questionId ? { questionId: diagnostic.questionId } : {}),
    ...(diagnostic.proposalIndex >= 0 ? { proposalIndex: diagnostic.proposalIndex } : {}),
    ...(diagnostic.chunkIndex === undefined ? {} : { chunkIndex: diagnostic.chunkIndex }),
    adapterStage: diagnostic.stage,
  }));
}

/**
 * Merge only a disjoint, validator-approved hint set. The current working queue
 * remains the authority for "already answered", so a model result cannot replace
 * a caller answer even if it happens to name the same question.
 */
function mergeHints(
  graph: PreparedCompilerApiResult["artifact"]["payload"]["graph"],
  originalQueue: CompilerQuestionQueue,
  workingQueue: CompilerQuestionQueue,
  existing: ModuleCompileHints,
  incoming: ModuleCompileHints,
): { hints: ModuleCompileHints; queue: CompilerQuestionQueue } {
  validateModuleCompileHints(workingQueue, incoming, graph);
  const existingIds = new Set(existing.resolutions.map((resolution) => resolution.questionId));
  for (const resolution of incoming.resolutions) {
    if (existingIds.has(resolution.questionId) || workingQueue.questions.find((question) => question.id === resolution.questionId)?.status === "answered") {
      throw new Error(`conflicting_resolution: answer already exists for ${resolution.questionId}`);
    }
  }
  const hints: ModuleCompileHints = { ...emptyHints(originalQueue), resolutions: [...existing.resolutions, ...incoming.resolutions].map((resolution) => structuredClone(resolution)) };
  validateModuleCompileHints(originalQueue, hints, graph);
  return { hints, queue: incoming.resolutions.length ? applyModuleCompileHints(graph, workingQueue, incoming) : workingQueue };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function resolutionSnapshot(
  prepared: PreparedCompilerApiResult,
  originalQueue: CompilerQuestionQueue,
  hints: ModuleCompileHints,
  expectedQueueHash: string,
): AutoCompilerDraftResolutionSnapshot {
  const resolvedDraft = resolveDraftModule(prepared.artifact.payload.graph, prepared.artifact.payload.draft, originalQueue, hints);
  if (resolvedDraft.resolvedQueue.queueHash !== expectedQueueHash) {
    throw new Error("draft_snapshot_queue_mismatch");
  }
  const { readiness, reachabilityReport } = resolvedDraft;
  return {
    readiness: {
      status: readiness.status,
      blockingCodes: uniqueSorted(readiness.blockingCodes),
      openQuestionIds: uniqueSorted(readiness.openQuestionIds),
      publishBlockingQuestionIds: uniqueSorted(readiness.publishBlockingQuestionIds),
      generatedMechanicIds: uniqueSorted(readiness.generatedMechanicIds),
    },
    ...(reachabilityReport ? {
      analysis: {
        unreachableCoreClueIds: uniqueSorted(reachabilityReport.unreachableCoreClueIds),
        unreachableEndingIds: uniqueSorted(reachabilityReport.unreachableEndingIds),
        deadlockIds: uniqueSorted(reachabilityReport.deadlockWitnesses.map((witness) => witness.final.id)),
        failurePolicyRiskMethodIds: uniqueSorted(reachabilityReport.failurePolicyRiskMethodIds),
      },
    } : {}),
  };
}

function draftOnly(
  state: AutoCompilerPreparedState,
  resolveRefusal?: CompilerApiRefusal,
  snapshot?: AutoCompilerDraftResolutionSnapshot,
): AutoCompilerDraftOnlyResult {
  return {
    status: "draft_only",
    ...state,
    ...(resolveRefusal ? { resolveRefusal } : {}),
    ...(snapshot ? { resolutionSnapshot: snapshot } : {}),
    unansweredQuestionIds: state.queue.questions.filter((question) => question.status === "open").map((question) => question.id).sort(),
  };
}

/**
 * Prepare source, optionally apply caller-owned explicit hints, ask an injected
 * LLMLike for untrusted proposals in bounded rounds, then resolve through the
 * existing artifact API. Partial, invalid, or unanswerable work returns a
 * structured draft_only result instead of a synthetic "closed" artifact.
 */
function invalidRounds(): AutoCompilerRefusedResult {
  return { status: "refused", diagnostics: [{ stage: "orchestrator", code: "invalid_max_proposal_rounds", message: `maxProposalRounds must be an integer from 1 to ${MAX_PROPOSAL_ROUNDS}` }] };
}

function restoredPreparedResult(candidate: PreparedCompilerApiResult): PreparedCompilerApiResult | AutoCompilerRefusedResult {
  const restored = restoreCompilerArtifact(candidate.artifact);
  if (restored.status === "refused" || restored.stage !== "prepared") {
    return {
      status: "refused",
      diagnostics: [{
        stage: "prepare",
        code: restored.status === "refused" ? restored.code : "prepared_artifact_required",
        message: restored.status === "refused" ? "prepared artifact could not be restored" : "prepared artifact is required",
      }],
    };
  }
  const identity = restored.payload.identity;
  if (candidate.identity.moduleId !== identity.moduleId
    || candidate.identity.documentHash !== identity.documentHash
    || candidate.identity.sourceGraphIdentity !== identity.sourceGraphIdentity
    || candidate.identity.preparedQueueHash !== identity.preparedQueueHash) {
    return { status: "refused", diagnostics: [{ stage: "prepare", code: "prepared_identity_mismatch", message: "prepared artifact identity does not match its restored contents" }] };
  }
  return {
    status: "prepared",
    identity,
    artifact: structuredClone(candidate.artifact),
    questions: structuredClone(restored.payload.preparedQueue.questions),
  };
}

/** Existing source entry point; preparation remains its only source-specific responsibility. */
export async function orchestrateAutoCompiler(input: AutoCompilerOrchestratorInput): Promise<AutoCompilerOrchestratorResult> {
  const maxRounds = roundsFor(input.maxProposalRounds);
  if (!maxRounds) return invalidRounds();
  const prepared = await prepareCompiler(input.source);
  if (prepared.status === "refused") {
    return { status: "refused", refusal: prepared, diagnostics: [{ stage: "prepare", code: prepared.code, message: prepared.message }] };
  }
  return runPreparedAutoCompiler(input, prepared, maxRounds);
}

/**
 * Prepared-artifact entry point for storage-backed callers. It deliberately
 * shares resolver, queue, proposal, and draft diagnostics with the source
 * entry point instead of duplicating any compiler DSL behavior.
 */
export async function orchestratePreparedAutoCompiler(input: PreparedAutoCompilerOrchestratorInput): Promise<AutoCompilerOrchestratorResult> {
  const maxRounds = roundsFor(input.maxProposalRounds);
  if (!maxRounds) return invalidRounds();
  const prepared = restoredPreparedResult(input.prepared);
  if (prepared.status === "refused") return prepared;
  return runPreparedAutoCompiler(input, prepared, maxRounds);
}

async function runPreparedAutoCompiler(
  input: Omit<AutoCompilerOrchestratorInput, "source">,
  prepared: PreparedCompilerApiResult,
  maxRounds: number,
): Promise<AutoCompilerOrchestratorResult> {
  const graph = prepared.artifact.payload.graph;
  const originalQueue = prepared.artifact.payload.preparedQueue;
  let hints = emptyHints(originalQueue);
  let queue = originalQueue;
  const rounds: AutoCompilerProposalRound[] = [];
  const diagnostics: AutoCompilerDiagnostic[] = [];

  const aborted = (round?: number): AutoCompilerOrchestratorResult => {
    diagnostics.push({ stage: "orchestrator", code: "operation_aborted", message: "automatic compiler operation was cancelled", ...(round === undefined ? {} : { round }) });
    return draftOnly({ prepared, hints, queue, rounds, diagnostics });
  };

  if (input.signal?.aborted) return aborted();

  if (input.explicitHints) {
    try {
      const alreadyAnswered = originalQueue.questions.find((question) => question.status === "answered" && input.explicitHints!.resolutions.some((resolution) => resolution.questionId === question.id));
      if (alreadyAnswered) throw new Error(`conflicting_resolution: caller cannot replace an answered question: ${alreadyAnswered.id}`);
      const merged = mergeHints(graph, originalQueue, queue, hints, input.explicitHints);
      hints = merged.hints;
      queue = merged.queue;
    } catch (error) {
      diagnostics.push({ stage: "explicit_hints", code: codeFor(error, "explicit_hints_invalid"), message: messageFor(error, "explicit hints are invalid") });
      return draftOnly({ prepared, hints, queue, rounds, diagnostics });
    }
  }

  for (let round = 1; round <= maxRounds; round++) {
    if (input.signal?.aborted) return aborted(round);
    const proposalResult = await requestCompilerHintProposals({
      graph,
      queue,
      llm: input.llm,
      policy: input.policy,
      producer: input.producer,
      ...(input.proposalLimits ? { limits: input.proposalLimits } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (input.signal?.aborted) return aborted(round);
    rounds.push({
      round,
      queueHash: queue.queueHash,
      status: proposalResult.status,
      askedQuestionIds: proposalResult.calls.flatMap((call) => call.questionIds).sort(),
      acceptedQuestionIds: proposalResult.accepted.map((accepted) => accepted.questionId).sort(),
      callCount: proposalResult.callCount,
    });
    diagnostics.push(...proposalDiagnostics(round, proposalResult.rejected));
    if (proposalResult.accepted.length === 0) {
      if (proposalResult.status !== "no_eligible_questions") {
        diagnostics.push({ stage: "orchestrator", code: "proposal_round_no_progress", message: "proposal round produced no validated answers", round });
      }
      break;
    }
    try {
      const merged = mergeHints(graph, originalQueue, queue, hints, proposalResult.hints);
      hints = merged.hints;
      queue = merged.queue;
    } catch (error) {
      diagnostics.push({ stage: "merge", code: codeFor(error, "proposal_merge_failed"), message: messageFor(error, "validated proposal hints could not be merged"), round });
      return draftOnly({ prepared, hints, queue, rounds, diagnostics });
    }
  }

  let snapshot: AutoCompilerDraftResolutionSnapshot | undefined;
  try {
    snapshot = resolutionSnapshot(prepared, originalQueue, hints, queue.queueHash);
  } catch (error) {
    diagnostics.push({ stage: "draft_snapshot", code: codeFor(error, "draft_snapshot_failed"), message: messageFor(error, "validated hints could not be analysed for draft diagnostics") });
    return draftOnly({ prepared, hints, queue, rounds, diagnostics });
  }

  const resolveResult: CompilerResolveResult = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
  if (resolveResult.status === "resolved") {
    return { status: "resolved", prepared, hints, queue, rounds, diagnostics, resolved: resolveResult };
  }
  diagnostics.push({ stage: "resolve", code: resolveResult.code, message: resolveResult.message });
  return draftOnly({ prepared, hints, queue, rounds, diagnostics }, resolveResult, snapshot);
}
