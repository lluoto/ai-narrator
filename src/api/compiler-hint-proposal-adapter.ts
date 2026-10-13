/**
 * Internal boundary for asking an LLMLike implementation for compiler hint proposals.
 *
 * The model sees evidence and candidate domains only. It never supplies batch identity,
 * authority, review, rights, policy, producer provenance, or a resolved queue.
 */
import {
  COMPILER_HINT_PROPOSAL_BATCH_SCHEMA_VERSION,
  buildCompilerHintProposalRequestEnvelope,
  compileGroundedHintProposals,
  validateTrustedCompilerHintProposalPolicy,
  type AcceptedCompilerHintProposal,
  type CompilerHintProposalDiagnostic,
  type CompilerHintProposal,
  type CompilerHintProposalRequestEnvelope,
  type CompilerHintProposalRequestQuestion,
  type TrustedCompilerHintProposalPolicy,
} from "../compiler/compiler-hint-proposals";
import {
  MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  compilerHintClaimKeys,
  npcBindingLocationScene,
  parseCompilerHintValue,
  validateModuleCompileHints,
  type CompilerQuestion,
  type CompilerQuestionResolution,
  type CompilerQuestionQueue,
  type ModuleCompileHints,
  type ParsedCompilerHintValue,
} from "../compiler/compiler-question-queue";
import { validateSourceFactGraph, type SourceFactGraph } from "../compiler/source-fact-graph";
import { sha256 } from "../ingest/document-ir";
import type { ChatOptions, LLMLike, Message } from "../llm/client";
import { extractJson } from "../llm/json";

export const COMPILER_HINT_PROPOSAL_ADAPTER_SCHEMA_VERSION = "1.1.0";

/** Three questions keeps topology/ending responses within a bounded JSON budget. */
const DEFAULT_MAX_QUESTIONS_PER_REQUEST = 3;
const MAX_MAX_QUESTIONS_PER_REQUEST = 8;
/** Absolute backstop: question chunking alone must never make model use unbounded. */
const DEFAULT_MAX_REQUESTS_PER_ROUND = 3;
const MAX_MAX_REQUESTS_PER_ROUND = 8;
const DEFAULT_MAX_REQUEST_CHARS = 24_000;
/** Full model messages are bounded separately from the JSON-only envelope. */
const DEFAULT_MAX_PROMPT_CHARS = 48_000;
const MAX_MAX_PROMPT_CHARS = 512_000;
const DEFAULT_MAX_RESPONSE_TOKENS = 2_400;
const MIN_MAX_RESPONSE_TOKENS = 128;
const MAX_MAX_RESPONSE_TOKENS = 8_000;

/** Caller-owned labels for audit, intentionally excluding credentials and endpoint URLs. */
export interface TrustedCompilerHintProposalProducer {
  providerFingerprint: string;
  modelFingerprint: string;
}

export interface CompilerHintProposalAdapterLimits {
  /** Inclusive maximum number of questions passed in one chat request. */
  maxQuestionsPerRequest: number;
  /** Inclusive maximum number of LLMLike.chat calls for one adapter invocation. */
  maxRequestsPerRound: number;
  /** Inclusive maximum JSON characters in the request envelope, excluding prompt boilerplate. */
  maxRequestChars: number;
  /**
   * Inclusive maximum JavaScript UTF-16 code units across the exact system and
   * user message contents passed to LLMLike.chat, after prompt-only shaping.
   * This is deliberately String.length rather than UTF-8 bytes: the client
   * boundary receives JavaScript strings and no byte serialization occurs here.
   */
  maxPromptChars?: number;
  /** Bounded trusted output budget passed to LLMLike and committed into request identity. */
  maxResponseTokens: number;
}

export interface CompilerHintProposalAdapterInput {
  graph: SourceFactGraph;
  queue: CompilerQuestionQueue;
  llm: LLMLike;
  policy: TrustedCompilerHintProposalPolicy;
  producer: TrustedCompilerHintProposalProducer;
  limits?: Partial<CompilerHintProposalAdapterLimits>;
  /** Stops before another model chunk and forwards cooperative cancellation to LLMLike. */
  signal?: AbortSignal;
}

export type CompilerHintProposalAdapterStatus = "ok" | "partial" | "failed" | "no_eligible_questions";
export type CompilerHintProposalAdapterDiagnosticStage = "input" | "chunking" | "model" | "response" | "proposal" | "aggregate";

/**
 * Private, lossless model-view of a candidate.  Queue identity is never a
 * model input; the response is bound back to the trusted queue separately.
 * sourceStatementId remains the verifiable source reference for a label.
 */
interface ModelPromptCandidate {
  id: string;
  kind: "scene" | "clue" | "item" | "prose_npc_anchor" | "reward";
  label: string;
  sourceStatementId: string;
}

/** The exact JSON request sent to LLMLike, distinct from the public queue DTO. */
interface ModelPromptEnvelope {
  candidateCatalog: ModelPromptCandidate[];
  questions: CompilerHintProposalRequestQuestion[];
}

export interface CompilerHintProposalAdapterDiagnostic extends CompilerHintProposalDiagnostic {
  chunkIndex?: number;
  stage: CompilerHintProposalAdapterDiagnosticStage;
}

export interface AcceptedCompilerHintProposalAdapterResult extends AcceptedCompilerHintProposal {
  chunkIndex: number;
  proposalId: string;
}

export interface CompilerHintProposalAdapterCall {
  chunkIndex: number;
  questionIds: string[];
  requestHash: string;
  responseHash?: string;
  proposalId?: string;
  status: "accepted" | "rejected" | "failed";
}

export interface CompilerHintProposalAdapterResult {
  status: CompilerHintProposalAdapterStatus;
  hints: ModuleCompileHints;
  accepted: AcceptedCompilerHintProposalAdapterResult[];
  rejected: CompilerHintProposalAdapterDiagnostic[];
  unansweredQuestionIds: string[];
  callCount: number;
  calls: CompilerHintProposalAdapterCall[];
  requestHashes: string[];
  responseHashes: string[];
}

interface ChunkingResult {
  chunks: PromptChunk[];
  rejected: CompilerHintProposalAdapterDiagnostic[];
}

/** A single prepared message shape is used for chunking, hashing, and chat. */
interface PromptChunk {
  questions: CompilerHintProposalRequestQuestion[];
  envelopeChars: number;
  messages: Message[];
  promptChars: number;
}

/** Internal callers receive an explicit, validated complete-message budget. */
interface NormalizedCompilerHintProposalAdapterLimits extends CompilerHintProposalAdapterLimits {
  maxPromptChars: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("adapter canonical JSON cannot encode non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("adapter canonical JSON requires JSON values");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => {
    const nested = record[key];
    if (nested === undefined) throw new Error(`adapter canonical JSON contains undefined: ${key}`);
    return `${JSON.stringify(key)}:${canonicalJson(nested)}`;
  }).join(",")}}`;
}

function emptyHints(queue: CompilerQuestionQueue): ModuleCompileHints {
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [],
  };
}

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : fallback;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function limitsFor(limits: CompilerHintProposalAdapterInput["limits"]): NormalizedCompilerHintProposalAdapterLimits | CompilerHintProposalAdapterDiagnostic {
  const merged = {
    maxQuestionsPerRequest: limits?.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS_PER_REQUEST,
    maxRequestsPerRound: limits?.maxRequestsPerRound ?? DEFAULT_MAX_REQUESTS_PER_ROUND,
    maxRequestChars: limits?.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS,
    // `undefined` is the optional/omitted form. Do not use ?? here: an
    // explicitly supplied null is invalid rather than a request to default.
    maxPromptChars: limits?.maxPromptChars === undefined ? DEFAULT_MAX_PROMPT_CHARS : limits.maxPromptChars,
    maxResponseTokens: limits?.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS,
  };
  if (!Number.isInteger(merged.maxQuestionsPerRequest) || merged.maxQuestionsPerRequest < 1 || merged.maxQuestionsPerRequest > MAX_MAX_QUESTIONS_PER_REQUEST) {
    return { proposalIndex: -1, code: "invalid_limit", message: `maxQuestionsPerRequest must be an integer from 1 to ${MAX_MAX_QUESTIONS_PER_REQUEST}`, stage: "input" };
  }
  if (!Number.isInteger(merged.maxRequestsPerRound) || merged.maxRequestsPerRound < 1 || merged.maxRequestsPerRound > MAX_MAX_REQUESTS_PER_ROUND) {
    return { proposalIndex: -1, code: "invalid_limit", message: `maxRequestsPerRound must be an integer from 1 to ${MAX_MAX_REQUESTS_PER_ROUND}`, stage: "input" };
  }
  if (!Number.isInteger(merged.maxRequestChars) || merged.maxRequestChars < 1) {
    return { proposalIndex: -1, code: "invalid_limit", message: "maxRequestChars must be a positive integer", stage: "input" };
  }
  if (!Number.isInteger(merged.maxPromptChars) || merged.maxPromptChars < 1 || merged.maxPromptChars > MAX_MAX_PROMPT_CHARS) {
    return { proposalIndex: -1, code: "invalid_limit", message: `maxPromptChars must be an integer from 1 to ${MAX_MAX_PROMPT_CHARS}`, stage: "input" };
  }
  if (!Number.isInteger(merged.maxResponseTokens) || merged.maxResponseTokens < MIN_MAX_RESPONSE_TOKENS || merged.maxResponseTokens > MAX_MAX_RESPONSE_TOKENS) {
    return { proposalIndex: -1, code: "invalid_limit", message: `maxResponseTokens must be an integer from ${MIN_MAX_RESPONSE_TOKENS} to ${MAX_MAX_RESPONSE_TOKENS}`, stage: "input" };
  }
  return merged;
}

function chatOptionsFor(limits: NormalizedCompilerHintProposalAdapterLimits): ChatOptions {
  return { jsonMode: true, temperature: 0, maxTokens: limits.maxResponseTokens, maxAttempts: 1 };
}

function trustedProducerDiagnostic(producer: TrustedCompilerHintProposalProducer): CompilerHintProposalAdapterDiagnostic | null {
  if (!producer.providerFingerprint?.trim() || !producer.modelFingerprint?.trim()) {
    return { proposalIndex: -1, code: "invalid_trusted_producer", message: "providerFingerprint and modelFingerprint are required", stage: "input" };
  }
  return null;
}

function trustedPolicyDiagnostic(policy: TrustedCompilerHintProposalPolicy): CompilerHintProposalAdapterDiagnostic | null {
  try {
    validateTrustedCompilerHintProposalPolicy({ policyId: policy.policyId, rightsStatus: policy.rightsStatus, ...(policy.allowedSourceFactMechanicKinds ? { allowedSourceFactMechanicKinds: policy.allowedSourceFactMechanicKinds } : {}), ...(policy.allowSourceExactNpcEncounters === undefined ? {} : { allowSourceExactNpcEncounters: policy.allowSourceExactNpcEncounters }) });
    return null;
  } catch (error) {
    return { proposalIndex: -1, code: errorCode(error, "invalid_trusted_policy"), message: errorMessage(error, "trusted policy is invalid"), stage: "input" };
  }
}

/**
 * Narrative NPC anchors are scoped by a heading. Do not ask a model to bind an
 * anchor until the queue has already established that heading as a playable
 * scene; otherwise a perfectly grounded proposal could still be mechanically
 * invalid. Explicit caller hints remain subject to the resolver's existing
 * fail-closed validation.
 */
type NpcBindingProposalMode = "ineligible" | "static_or_none" | "none_only";

function npcBindingProposalMode(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  requestQuestion: CompilerHintProposalRequestQuestion,
): NpcBindingProposalMode {
  if (requestQuestion.kind !== "npc_binding") return "static_or_none";
  const queueQuestion = queue.questions.find((question) => question.id === requestQuestion.questionId);
  if (!queueQuestion) return "ineligible";
  let location: ReturnType<typeof npcBindingLocationScene>;
  try {
    location = npcBindingLocationScene(graph, queueQuestion);
  } catch {
    return "ineligible";
  }
  const sceneRole = queue.questions.find((question) => question.kind === "scene_role"
    && question.subjectCandidateId === location.sceneCandidateId
    && question.sourceStatementIds.length === 1
    && question.sourceStatementIds[0] === location.headingStatementId);
  if (!sceneRole || sceneRole.status !== "answered" || !sceneRole.resolution) return "ineligible";
  try {
    const parsed = parseCompilerHintValue(sceneRole, sceneRole.resolution.value, graph);
    if (parsed.kind !== "scene_role") return "ineligible";
    return parsed.role === "playable_scene" ? "static_or_none" : "none_only";
  } catch {
    return "ineligible";
  }
}

/**
 * A typed source-fact child is only meaningful after its owning scene has
 * independently become a playable scene. Parent activation alone is not an
 * authority to make a source fact mechanically actionable.
 */
function sourceFactMechanicProposalEligible(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  requestQuestion: CompilerHintProposalRequestQuestion,
): boolean {
  if (requestQuestion.kind !== "source_fact_mechanic") return true;
  const child = queue.questions.find((question) => question.id === requestQuestion.questionId);
  return !!child && sourceFactMechanicHasPlayableOwningScene(graph, queue, child);
}

function sourceFactMechanicHasPlayableOwningScene(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  child: CompilerQuestion,
): boolean {
  if (child.kind !== "source_fact_mechanic" || !child.owningSceneCandidateId) return false;
  const sceneRole = queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId);
  if (!sceneRole || sceneRole.status !== "answered" || !sceneRole.resolution) return false;
  try {
    const parsed = parseCompilerHintValue(sceneRole, sceneRole.resolution.value, graph);
    return parsed.kind === "scene_role" && parsed.role === "playable_scene";
  } catch {
    return false;
  }
}

/**
 * Preserve deterministic request identities without allowing opaque question
 * hashes to consume the complete bounded campaign before they establish the
 * prerequisites for mechanics closure.  Every rank is computed from the
 * already-validated queue and graph; it never changes a question's eligibility
 * or writes queue state.  Question ID remains the stable tie-breaker.
 */
function proposalQuestionRank(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  requestQuestion: CompilerHintProposalRequestQuestion,
  npcMode: NpcBindingProposalMode,
): number {
  const question = queue.questions.find((candidate) => candidate.id === requestQuestion.questionId);
  if (!question || question.status !== "open") return 5;
  if (question.severity === "publish_blocking") return question.kind === "scene_role" ? 0 : 1;
  if (question.kind === "source_fact_disposition") {
    const child = question.sourceFactChildQuestionId
      ? queue.questions.find((candidate) => candidate.id === question.sourceFactChildQuestionId)
      : undefined;
    // After a playable scene role is settled, its source-fact parent is the
    // only existing route that can activate the deferred typed child.  Before
    // that prerequisite it remains an ordinary warning rather than bypassing
    // the scene-role/publish-blocking queue.
    if (child && child.status === "deferred" && sourceFactMechanicHasPlayableOwningScene(graph, queue, child)) return 2;
  }
  if (question.kind === "source_fact_mechanic" || (question.kind === "npc_binding" && npcMode !== "ineligible")) return 3;
  return 4;
}

function compareEligibleQuestions(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  npcBindingModes: ReadonlyMap<string, NpcBindingProposalMode>,
  left: CompilerHintProposalRequestQuestion,
  right: CompilerHintProposalRequestQuestion,
): number {
  const leftRank = proposalQuestionRank(graph, queue, left, npcBindingModes.get(left.questionId) ?? "ineligible");
  const rightRank = proposalQuestionRank(graph, queue, right, npcBindingModes.get(right.questionId) ?? "ineligible");
  return leftRank - rightRank || left.questionId.localeCompare(right.questionId);
}

function envelopeFor(base: CompilerHintProposalRequestEnvelope, questions: CompilerHintProposalRequestQuestion[]): CompilerHintProposalRequestEnvelope {
  const candidateIds = new Set(questions.flatMap((question) => [
    ...(question.candidateDomains.candidateIds ?? []),
    ...(question.candidateDomains.subjectCandidateId ? [question.candidateDomains.subjectCandidateId] : []),
    ...(question.candidateDomains.allowedCandidateIds ?? []),
    ...(question.candidateDomains.allowedLocationCandidateIds ?? []),
    ...Object.values(question.candidateDomains.allowedMechanicsTargetIds ?? {}).flatMap((ids) => ids ?? []),
    ...Object.values(question.candidateDomains.allowedRewardPredicateIds ?? {}).flatMap((ids) => ids ?? []),
  ]));
  return {
    schemaVersion: base.schemaVersion,
    moduleId: base.moduleId,
    documentHash: base.documentHash,
    sourceGraphIdentity: base.sourceGraphIdentity,
    queueHash: base.queueHash,
    candidateCatalog: base.candidateCatalog.filter((candidate) => candidateIds.has(candidate.id)).map((candidate) => structuredClone(candidate)),
    questions: questions.map((question) => structuredClone(question)),
  };
}

function chunkQuestions(
  base: CompilerHintProposalRequestEnvelope,
  questions: CompilerHintProposalRequestQuestion[],
  limits: NormalizedCompilerHintProposalAdapterLimits,
  npcBindingModes: ReadonlyMap<string, NpcBindingProposalMode>,
): ChunkingResult {
  const chunks: PromptChunk[] = [];
  const rejected: CompilerHintProposalAdapterDiagnostic[] = [];
  let current: PromptChunk | undefined;
  for (const question of questions) {
    const onlyQuestion = promptChunkFor(base, [question], npcBindingModes);
    if (onlyQuestion.envelopeChars > limits.maxRequestChars) {
      rejected.push({
        proposalIndex: -1,
        questionId: question.questionId,
        code: "question_exceeds_request_limit",
        message: `question exceeds maxRequestChars (${limits.maxRequestChars})`,
        stage: "chunking",
      });
      continue;
    }
    if (onlyQuestion.promptChars > limits.maxPromptChars) {
      rejected.push({
        proposalIndex: -1,
        questionId: question.questionId,
        code: "question_exceeds_prompt_limit",
        message: `question exceeds maxPromptChars (${limits.maxPromptChars})`,
        stage: "chunking",
      });
      continue;
    }
    const candidate = current ? promptChunkFor(base, [...current.questions, question], npcBindingModes) : onlyQuestion;
    const exceedsCount = candidate.questions.length > limits.maxQuestionsPerRequest;
    const exceedsEnvelopeChars = candidate.envelopeChars > limits.maxRequestChars;
    const exceedsPromptChars = candidate.promptChars > limits.maxPromptChars;
    if ((exceedsCount || exceedsEnvelopeChars || exceedsPromptChars) && current) {
      chunks.push(current);
      current = onlyQuestion;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return { chunks, rejected };
}

/**
 * The queue describes the full human-review contract, including dialogue and
 * encounter extensions. The proposal adapter exposes only the policy-enabled,
 * source-exact NPC subset to the model.
 */
function modelRequestEnvelope(
  envelope: CompilerHintProposalRequestEnvelope,
  npcBindingModes: ReadonlyMap<string, NpcBindingProposalMode>,
): ModelPromptEnvelope {
  return {
    candidateCatalog: envelope.candidateCatalog.map(({ id, kind, label, sourceStatementId }) => ({
      id,
      kind,
      label,
      sourceStatementId,
    })),
    questions: envelope.questions.map((question) => {
      if (question.kind === "source_fact_mechanic") {
        const transitionEnabled = question.candidateDomains.allowedSourceFactMechanicKinds?.includes("scene_state_transition") === true;
        const proseFindingEnabled = question.candidateDomains.allowedSourceFactMechanicKinds?.includes("prose_fact_finding") === true
          && (question.candidateDomains.allowedProseFactFindingCandidates?.length ?? 0) > 0;
        const proseFindingPrompt = "This source-fact child has an explicitly enabled prose_fact_finding capability. Return exactly one of its offered value shapes: {findingCandidateIds:[exactly one candidateDomains.allowedProseFactFindingCandidates candidateId],sourceOnlyAtomIds:[every other candidateDomains.allowedSourceFactAtoms atomId exactly once]}. Do not combine that shape with declarations. citations must be []. The quote and check shown beside every ID are server-derived context only: do not return quote, skill, check, action, target, location, clueId, mechanismId, effect, failure, failback, or runtime AST; the compiler derives the single optional search/discover_clue.";
        return {
          ...question,
          prompt: proseFindingEnabled
            ? `${proseFindingPrompt}${transitionEnabled ? " If you instead use the separately enabled legacy declaration shape, use only declarations and its normal root-exact citations; never mix the two shapes." : ""}`
            : transitionEnabled
            ? "This is an activated source-fact child. Return one to four existing_clue_discovery or scene_state_transition declarations only. A transition has exactly declarationKey, kind, trigger:{kind:scene_enter}|{kind:clue_found,clueCandidateId}, discoverClueCandidateId, and evidence. trigger and output IDs must come from the closed same-heading clue domain; scene_enter evidence has declaration, trigger, discover atoms, while clue_found also has prerequisite. Every atom needs root-exact evidence. Do not provide mechanismId, interpretationId, stateKey, when, effects, spec, location, onSuccess, onFailure, failback, custom/talk, or any runtime AST: the compiler derives IDs, scope, guards, discover_clue, and the private state sentinel."
            : "This is an activated source-fact child. Return one to four existing_clue_discovery declarations only. Each declaration has exactly declarationKey, kind, clueCandidateId, action, target, targetId, optional check, optional availability, and evidence. kind must be existing_clue_discovery; action is observe|search|read|use_item|move; target and every predicate ID must come from this question's closed same-heading candidate domains. evidence must contain one root-exact entry for every declaration atom. Do not provide mechanismId, interpretationId, locationSceneCandidateId, spec, onSuccess, onFailure, failback, effects, scene_state_transition, custom/talk, or any unsupported runtime field; the compiler derives IDs, location, and discover_clue effects.",
        };
      }
      if (question.kind !== "npc_binding") return question;
      if (npcBindingModes.get(question.questionId) === "none_only") {
        return {
          ...question,
          prompt: "This anchor's heading is already answered as non-playable. You may only return presentNpcs: [] for this exact proseAnchorId. A non-empty presentNpcs array, NPC IDs, dialogue methods, encounters, or other runtime mechanics are forbidden.",
        };
      }
      const encounterProfiles = question.candidateDomains.allowedNpcEncounterProfiles;
      return {
        ...question,
        prompt: encounterProfiles?.length
          ? "This heading is already answered playable_scene. Bind only source-exact name quotes present in this ordinary paragraph. A bound NPC may declare dialogueMethods: [] or source-exact prose relationshipEvidence. It may additionally declare encounter with exactly maxHp, dodge, fight, and npcDamage {statementId,quote} selections from one allowedNpcEncounterProfiles heading; alternate profiles require their exact requiredNameQuote. Do not supply encounterId, autoStart, sceneId, combatantId, victoryEffects, effects, target, check, availability, failback, marked-clue dialogue, NPC IDs, or runtime AST. The compiler derives the encounter, auto-start, scene, combatant, and empty victory effects. A separate outer trigger citation must quote this anchor paragraph, include nameQuote, and state an immediate unconditional hostile attack; do not use conditional, defensive, ability, or friendly prose."
          : "This heading is already answered playable_scene. Bind only source-exact name quotes present in this ordinary paragraph. A bound NPC may declare dialogueMethods: [] or one or more prose methods shaped exactly as {relationshipEvidence:{statementId:<this anchor paragraph>,quote:<trimmed source substring distinct from nameQuote>}}. Do not supply mechanismId, check, availability, effects, failback, marked-clue dialogue, encounter, NPC IDs, scene IDs, or any runtime fields: the compiler derives the sole talk/discover_clue mechanism. An empty presentNpcs array explicitly declares no NPC binding.",
      };
    }),
  };
}

/**
 * Prompt-only examples used to format the parser-owned claim-key contract.
 * They are never sent as answers: each placeholder remains subject to the
 * question's closed candidate domains and the grounded parser.
 */
function proposalCitationContract(requestEnvelope: Pick<ModelPromptEnvelope, "questions">): string[] {
  const kinds = new Set(requestEnvelope.questions.map((question) => question.kind));
  const keys = (value: ParsedCompilerHintValue): string[] => compilerHintClaimKeys(value);
  const lines: string[] = [];
  if (kinds.has("scene_role")) lines.push(`- scene_role: cite exactly claimKey "${keys({ kind: "scene_role", role: "other" })[0]!}".`);
  if (kinds.has("entry_scene")) lines.push(`- entry_scene: cite exactly claimKey "${keys({ kind: "entry_scene", sceneId: "<selected_scene_candidate_id>" })[0]!}".`);
  if (kinds.has("core_clue")) lines.push(`- core_clue: cite exactly claimKey "${keys({ kind: "core_clue", clueId: "<subject_clue_candidate_id>", required: false })[0]!}".`);
  if (kinds.has("connection_topology")) {
    const empty = keys({ kind: "connection_topology", connections: [] })[0]!;
    const declared = keys({
      kind: "connection_topology",
      connections: [{
        fromSceneId: "<source_scene_candidate_id>",
        toSceneId: "<selected_scene_candidate_id>",
        connectionId: "<connectionId>",
        spec: { kind: "connection_gate", id: "<compiler_derived_mechanism_id>", connectionId: "<connectionId>" },
      }],
    })[0]!;
    lines.push(`- connection_topology: with connections:[] cite exactly claimKey "${empty}"; otherwise cite one claimKey "${declared}" for every declared connection. Declare each connectionId once as a new stable ID in this answer; replace <connectionId> in its claimKey with that exact declared value, never a candidate ID or this placeholder.`);
  }
  if (kinds.has("ending_rule")) {
    const key = keys({
      kind: "ending_rule",
      declarations: [{
        endingId: "<endingId>",
        spec: {
          kind: "ending_rule",
          id: "<compiler_derived_mechanism_id>",
          priority: 0,
          when: { kind: "scene_visited", sceneId: "<selected_scene_candidate_id>" },
          effects: [{ kind: "end_game", endingId: "<endingId>" }],
        },
      }],
    })[0]!;
    lines.push(`- ending_rule: cite one claimKey "${key}" for every declaration. Declare each endingId and its distinct spec.id once as new stable IDs in this answer; replace <endingId> in its claimKey with that exact declared endingId, never a candidate ID or this placeholder.`);
  }
  if (kinds.has("discovery_method")) {
    const key = keys({
      kind: "discovery_method",
      clueId: "<subject_clue_candidate_id>",
      locationSceneId: "<selected_scene_candidate_id>",
      spec: {
        kind: "discovery_method",
        id: "<spec.id>",
        clueId: "<subject_clue_candidate_id>",
        action: "search",
        target: "scene",
        targetId: "<selected_scene_candidate_id>",
        onSuccess: [{ kind: "discover_clue", clueId: "<subject_clue_candidate_id>" }],
      },
    })[0]!;
    lines.push(`- discovery_method: cite exactly claimKey "${key}". Declare spec.id once as a new stable ID in this answer; replace <spec.id> in its claimKey with that exact declared value, never a candidate ID or this placeholder.`);
  }
  if (kinds.has("source_fact_disposition")) {
    const key = keys({ kind: "source_fact_disposition", statementId: "<statementId>", disposition: "source_only" })[0]!;
    lines.push(`- source_fact_disposition: cite exactly claimKey "${key}" using that question's sole source statementId and its complete trimmed source quote.`);
  }
  return lines;
}

/**
 * The request envelope remains the complete public batch contract.  These are
 * only the response shapes that an individual bounded model chunk can use;
 * including every unrelated DSL in every singleton chunk needlessly consumes
 * the same 24k message budget that protects the adapter boundary.
 */
function proposalValueContracts(requestEnvelope: Pick<ModelPromptEnvelope, "questions">): string[] {
  const kinds = new Set(requestEnvelope.questions.map((question) => question.kind));
  const contracts: string[] = [];
  if (kinds.has("scene_role")) contracts.push(`- scene_role: {"role":"playable_scene|rules_section|character_section|ending_section|other"}`);
  if (kinds.has("entry_scene")) contracts.push(`- entry_scene: {"sceneCandidateId":"a listed candidate id"}`);
  if (kinds.has("connection_topology")) contracts.push(`- connection_topology: {"connections":[{"toSceneCandidateId":"a listed candidate id","connectionId":"stable_identifier", optional "availability":Predicate, optional "onTraverse":Effect[]}]}`);
  if (kinds.has("core_clue")) contracts.push(`- core_clue: {"clueCandidateId":"the question subject id","required":true|false}`);
  if (kinds.has("ending_rule")) contracts.push(`- ending_rule: {"declarations":[{"endingId":"stable_identifier","spec":EndingRuleSpec}]}`);
  if (kinds.has("discovery_method")) contracts.push(`- discovery_method: {"clueCandidateId":"the question subject id","locationSceneCandidateId":"a listed location id","spec":DiscoveryMethodSpec}`);
  if (kinds.has("clue_fact_facets")) contracts.push(`- clue_fact_facets: {"shell":[{"atomId":"an allowedClueFactAtoms id","quote":"that atom's exact quote"}],"findings":[{"findingKey":"stable_identifier","atoms":[{"atomId":"an allowedClueFactAtoms id","quote":"that atom's exact quote"}],"methods":[{"declarationKey":"stable_identifier","action":"observe|search|read","target":"scene|clue","check":Check, optional "failback":{"maxFailures":positive integer}}]}],"sourceOnlyAtomIds":["allowedClueFactAtoms id"]}. Partition every offered atom exactly once into shell, one finding, or source-only. shell may be empty only for an all-gated shell identity; every finding has non-empty atoms and 1-4 methods. observe/search may target scene or clue; read may target clue only. Each finding method cites that finding's first atom. Do not provide clueId, mechanismId, targetId, location, availability, onSuccess, effects, Predicate, Effect, or any runtime AST: the compiler derives source scope, IDs, shell prerequisite, and discover effects.`);
  if (kinds.has("source_fact_disposition")) contracts.push(`- source_fact_disposition: {"statementId":"the sole source statement id","disposition":"source_only|mechanics_candidate"}; it declares only that whole paragraph, list item, or table row.`);
  if (kinds.has("item_binding")) contracts.push(`- item_binding: {"itemCandidateId":"the question subject id","itemType":"key|document|loot"|null, optional "itemNameEvidence":{"statementId":"an allowed item-name statement id","quote":"a trimmed source-exact substring"}}.`);
  if (kinds.has("reward_binding")) contracts.push(`- reward_binding: {"rewardCandidateId":"the question subject id","declaration":null|{"when":RewardPredicate,"settlement":RewardSettlement}}.`);
  return contracts;
}

function mechanicsDslGuidanceFor(requestEnvelope: Pick<ModelPromptEnvelope, "questions">): string {
  const kinds = new Set(requestEnvelope.questions.map((question) => question.kind));
  const needsPredicate = kinds.has("connection_topology") || kinds.has("ending_rule") || kinds.has("discovery_method") || kinds.has("reward_binding") || kinds.has("source_fact_mechanic");
  const needsEffect = kinds.has("connection_topology") || kinds.has("ending_rule") || kinds.has("discovery_method");
  const needsCheck = kinds.has("discovery_method") || kinds.has("clue_fact_facets") || kinds.has("source_fact_mechanic");
  const lines: string[] = [];
  if (needsPredicate || needsEffect || needsCheck || kinds.has("item_binding") || kinds.has("reward_binding")) {
    lines.push("Mechanics DSL: use only these exact object shapes; arrays named predicates/effects must be non-empty.");
  }
  if (needsPredicate) lines.push("- Predicate = {\"kind\":\"all\",\"predicates\":[Predicate,...]} | {\"kind\":\"any\",\"predicates\":[Predicate,...]} | {\"kind\":\"not\",\"predicate\":Predicate} | {\"kind\":\"clue_found\",\"clueId\":\"id\"} | {\"kind\":\"scene_visited\",\"sceneId\":\"id\"} | {\"kind\":\"item_owned\",\"itemId\":\"id\"} | {\"kind\":\"connection_unlocked\",\"connectionId\":\"id\"} | {\"kind\":\"state_eq\",\"stateKey\":\"id\",\"value\":string|number|boolean|null} | {\"kind\":\"npc_state\",\"npcId\":\"id\",\"state\":\"nonempty string\"}.");
  if (needsEffect) lines.push("- Effect = {\"kind\":\"discover_clue\",\"clueId\":\"id\"} | {\"kind\":\"acquire_item\",\"itemId\":\"id\"} | {\"kind\":\"set_state\",\"stateKey\":\"id\",\"value\":string|number|boolean|null} | {\"kind\":\"unlock_connection\",\"connectionId\":\"id\"} | {\"kind\":\"start_encounter\",\"encounterId\":\"id\"} | {\"kind\":\"end_game\",\"endingId\":\"id\"}. Do not propose sanity_check: source-bound SAN loss declarations require a human-reviewed hint in this release. Use ID fields only from the question's declared domain or a declaration in the same answer; end_game is only for ending effects.");
  if (needsCheck) lines.push("- Check = {\"kind\":\"none\"} | {\"kind\":\"skill\",\"skill\":\"nonempty string\",\"difficulty\":\"regular|hard|extreme\"} | {\"kind\":\"attribute\",\"attribute\":\"str|dex|pow|con|app|edu|int|siz\",\"difficulty\":\"regular|hard|extreme\"}.");
  if (kinds.has("item_binding")) lines.push("- Item binding has exactly two contracts. Runtime item: {\"itemCandidateId\":\"the question subject id\",\"itemType\":\"key|document|loot\",\"itemNameEvidence\":{\"statementId\":\"one candidateDomains.allowedItemNameEvidenceStatementIds id\",\"quote\":\"a trimmed source-exact substring of that statement\"}}. Its only citation claim key is item_binding:<itemCandidateId>, and its citation quote must exactly equal itemNameEvidence.quote. Source-only item: {\"itemCandidateId\":\"the question subject id\",\"itemType\":null}. Its only citation claim key is item_binding:none:<itemCandidateId>; it must not include itemNameEvidence. null creates no runtime item and its citation quote must exactly equal the marked item name. Choose exactly one of these two contracts; never infer a runtime itemType merely because the source is uncertain. Never invent an item ID or use weapon/trap.");
  if (kinds.has("reward_binding")) lines.push("- Reward binding = {\"rewardCandidateId\":\"the question subject id\",\"declaration\":null|{\"when\":RewardPredicate,\"settlement\":RewardSettlement}}. Its only citation claim key is reward_binding:<rewardCandidateId>, or reward_binding:none:<rewardCandidateId> when declaration is null. Never provide a reward ID: the compiler fixes it to the subject candidate. RewardPredicate is only clue_found, scene_visited, item_owned, all, any, and not. Every clue_found.clueId, scene_visited.sceneId, and item_owned.itemId, including nested all/any/not predicates, must come only from this reward question's candidateDomains.allowedRewardPredicateIds.clue, .scene, and .item respectively; never guess IDs or reuse another domain's ID. RewardSettlement only permits positive SAN {\"kind\":\"fixed\",\"amount\":N} or {\"kind\":\"dice\",\"count\":N,\"sides\":M}, positive fixed cthulhuMythos, and positive fixed reputation; skill growth and SAN loss are unsupported.");
  if (kinds.has("discovery_method")) lines.push("- discovery_method spec fields are exactly {\"kind\":\"discovery_method\",\"id\",\"clueId\",\"action\",\"target\",\"targetId\",\"onSuccess\", optional \"availability\",\"check\",\"onFailure\",\"failback\"}. action is observe|search|talk|read|use_item|move|custom; target is clue|item|npc|scene. onSuccess must include {\"kind\":\"discover_clue\",\"clueId\":\"the same clueId\"}; onFailure, if present, is a non-empty Effect array; failback, if present, is {\"maxFailures\":positive integer,\"effects\":non-empty Effect array}.");
  if (kinds.has("connection_topology")) lines.push("- A topology connection may have only toSceneCandidateId, connectionId, optional availability:Predicate, and optional onTraverse:non-empty Effect array.");
  if (kinds.has("ending_rule")) lines.push("- An ending declaration has spec {\"kind\":\"ending_rule\",\"id\",\"priority\":integer,\"when\":Predicate,\"effects\":non-empty Effect array}. spec.id must differ from its endingId, and effects must contain exactly one {\"kind\":\"end_game\",\"endingId\":\"that same endingId\"}.");
  return lines.join("\n");
}

/** The model sees this compact contract, not the full human-review NPC DSL. */
function proposalUserContent(requestEnvelope: ModelPromptEnvelope): string {
  // Scene classification precedes runtime declarations. Keep its evidence and
  // parser-owned citation contract, without spending the prompt budget on DSLs
  // that this chunk cannot use. Mixed/other chunks retain their full contract.
  if (requestEnvelope.questions.length > 0 && requestEnvelope.questions.every((question) => question.kind === "scene_role")) {
    return `Return exactly {"proposals":[{"questionId":"...","kind":"scene_role","value":{"role":"playable_scene|rules_section|character_section|ending_section|other"},"citations":[{"claimKey":"scene_role","statementId":"...","quote":"exact source substring"}]}]} and no other root fields.

Only answer questions in REQUEST ENVELOPE. Do not output authority, reviewerKind, rightsStatus, resolution, audit, module/document/queue identity, proposalId, or metadata. Value accepts only role. Citations are mandatory and source-exact.
${proposalCitationContract(requestEnvelope).join("\n")}
Omit a question instead of guessing source facts or IDs. Do not declare runtime mechanics.

REQUEST ENVELOPE:
${canonicalJson(requestEnvelope)}`;
  }
  const kinds = new Set(requestEnvelope.questions.map((question) => question.kind));
  const transitionEnabled = kinds.has("source_fact_mechanic") && requestEnvelope.questions.some((question) => question.kind === "source_fact_mechanic"
    && question.candidateDomains.allowedSourceFactMechanicKinds?.includes("scene_state_transition"));
  const proseFindingEnabled = kinds.has("source_fact_mechanic") && requestEnvelope.questions.some((question) => question.kind === "source_fact_mechanic"
    && question.candidateDomains.allowedSourceFactMechanicKinds?.includes("prose_fact_finding")
    && question.candidateDomains.allowedProseFactFindingCandidates?.length);
  const npcEncounterEnabled = kinds.has("npc_binding") && requestEnvelope.questions.some((question) => question.kind === "npc_binding"
    && question.candidateDomains.allowedNpcEncounterProfiles?.length);
  const sourceFactMechanicContract = !kinds.has("source_fact_mechanic")
    ? ""
    : proseFindingEnabled
    ? "- source_fact_mechanic: each question prompt states whether its explicitly trusted prose_fact_finding subset is available. For that subset, return exactly {findingCandidateIds:[one candidateDomains.allowedProseFactFindingCandidates candidate ID],sourceOnlyAtomIds:[each remaining candidateDomains.allowedSourceFactAtoms atom ID exactly once]}; citations must be []. This ID-only partition is mutually exclusive with declarations. The candidate quote/check and atom quote in the request are server-derived display context, never response fields. Do not provide quote, skill, check, action, target, location, clueId, mechanismId, effect, failure, failback, or runtime AST. If the question separately allows legacy declarations, follow only that question's legacy shape and root-exact citation requirements instead."
    : transitionEnabled
    ? "- source_fact_mechanic: return 1-4 declarations with unique declarationKey. existing_clue_discovery uses the closed discovery shape in the question prompt. scene_state_transition uses exactly {declarationKey,kind:\"scene_state_transition\",trigger:{kind:\"scene_enter\"}|{kind:\"clue_found\",clueCandidateId:\"a candidateDomains.allowedMechanicsTargetIds.clue id\"},discoverClueCandidateId:\"a candidateDomains.allowedMechanicsTargetIds.clue id\",evidence:[{claimKey:\"source_fact_mechanic:<sourceFactScope.rootStatementId>:<declarationKey>:declaration|trigger|discover (and prerequisite only for clue_found)\",statementId:\"sourceFactScope.rootStatementId\",quote:\"the complete trimmed root statement\"}]}. Every outer citation and matching inner evidence entry must be identical and root-exact. Do not provide mechanismId, interpretationId, stateKey, when, effects, spec, location, onSuccess, onFailure, failback, custom/talk, or any runtime AST; the compiler derives all runtime fields."
    : "- source_fact_mechanic: {\"declarations\":[{\"declarationKey\":\"stable_identifier\",\"kind\":\"existing_clue_discovery\",\"clueCandidateId\":\"a candidateDomains.allowedMechanicsTargetIds.clue id\",\"action\":\"observe|search|read|use_item|move\",\"target\":\"scene|clue|item\",\"targetId\":\"an ID in the matching closed target domain\", optional \"check\":Check, optional \"availability\":Predicate,\"evidence\":[{\"claimKey\":\"source_fact_mechanic:<sourceFactScope.rootStatementId>:<declarationKey>:declaration|action|target|check|availability|discover\",\"statementId\":\"sourceFactScope.rootStatementId\",\"quote\":\"the complete trimmed root statement\"}]}]}. Return 1-4 declarations with unique declarationKey. Every outer citation and matching inner evidence entry must use the same claimKey, root statementId, and complete trimmed root quote. Do not provide mechanismId, interpretationId, locationSceneCandidateId, spec, onSuccess, onFailure, failback, effects, custom/talk, or scene_state_transition; compiler derives the location, IDs, and discover_clue effect.";
  const npcBindingContract = !kinds.has("npc_binding")
    ? ""
    : npcEncounterEnabled
    ? "- npc_binding: {\"proseAnchorId\":\"the question subject id\",\"presentNpcs\":[{\"nameQuote\":\"a trimmed verbatim name substring from the anchor paragraph\",\"dialogueMethods\":[]|[{\"relationshipEvidence\":{\"statementId\":\"the same anchor paragraph id\",\"quote\":\"a trimmed relationship substring distinct from nameQuote\"}}], optional \"encounter\":{\"maxHp\":{\"statementId\":\"an exact candidateDomains.allowedNpcEncounterProfiles statCandidates.maxHp id\",\"quote\":\"its exact quote\"},\"dodge\":{\"statementId\":\"an allowed dodge id\",\"quote\":\"its exact quote\"},\"fight\":{\"statementId\":\"an allowed fight id\",\"quote\":\"its exact quote\"},\"npcDamage\":{\"statementId\":\"an allowed npcDamage id\",\"quote\":\"its exact quote\"}}}]}. An encounter selects all four slots from one listed profile; if it has requiredNameQuote, nameQuote must equal it exactly. No encounterId, autoStart, sceneId, combatantId, victoryEffects, effects, target, check, availability, failback, marked-item dialogue, NPC ID, or runtime AST. The compiler derives IDs, scene, combatant, immediate auto-start, and empty victoryEffects."
    : "- npc_binding: {\"proseAnchorId\":\"the question subject id\",\"presentNpcs\":[{\"nameQuote\":\"a trimmed verbatim name substring from the anchor paragraph\",\"dialogueMethods\":[{\"relationshipEvidence\":{\"statementId\":\"the same anchor paragraph id\",\"quote\":\"a trimmed verbatim relationship substring distinct from nameQuote\"}}]}]}. dialogueMethods may instead be []. This is the only automatic dialogue shape: no mechanismId, check, availability, effects, failback, marked-item dialogue, encounter, NPC ID, or scene ID.";
  const ordinaryCitations = proposalCitationContract(requestEnvelope).join("\n");
  const valueContracts = proposalValueContracts(requestEnvelope).join("\n");
  const mechanicsDsl = mechanicsDslGuidanceFor(requestEnvelope);
  const evidenceBoundaries = [
    kinds.has("clue_fact_facets")
      ? "For clue_fact_facets, use clue_fact_shell:<shell clue id>:<atomId>, clue_fact_finding:<findingKey>:<atomId>, clue_fact_method:<findingKey>:<declarationKey>, and clue_fact_source_only:<shell clue id>:<atomId>; every citation uses the atom's exact statementId and quote, and a method cites its finding's first atom."
      : "",
    kinds.has("source_fact_mechanic")
      ? "For legacy source_fact_mechanic declarations, the outer citations and declaration evidence must be a one-for-one identical set keyed by every declaration atom; each quotes its complete trimmed root statement, never its heading or a partial/foreign quote."
      : "",
    kinds.has("npc_binding")
      ? `For npc_binding use npc_binding:none:<proseAnchorId> when presentNpcs is empty. A static NPC uses npc_binding:<proseAnchorId>:<index> exactly quoting nameQuote. A prose dialogue NPC must use npc_binding:<proseAnchorId>:<index>:name exactly quoting nameQuote and npc_binding:<proseAnchorId>:<index>:relationship:<methodIndex> exactly quoting relationshipEvidence.quote. ${npcEncounterEnabled ? "An automatic encounter uses the :name, :encounter:trigger, :encounter:maxHp, :encounter:dodge, :encounter:fight, and :encounter:npcDamage claims. Its trigger must exactly quote the anchor paragraph, include nameQuote, and say that NPC immediately attacks, ambushes, charges, becomes hostile, or tries to kill; never cite a conditional, delayed, defensive, capability, negated, or another NPC's attack sentence." : "A name citation never substitutes for a relationship citation."}`
      : "",
  ].filter(Boolean).join(" ");
  return `Return exactly {"proposals":[{"questionId":"...","kind":"...","value":{},"citations":[{"claimKey":"...","statementId":"...","quote":"exact source substring"}]}]} and no other root fields.

Only answer questions in REQUEST ENVELOPE. Do not output authority, reviewerKind, rightsStatus, policyId, derivation, reason, audit, module/document/queue identity, proposalId, or metadata.

Value shapes (the validator accepts no undeclared fields):
  ${valueContracts}
  ${sourceFactMechanicContract}
  ${npcBindingContract}
  ${mechanicsDsl}
  Citations are mandatory and source-exact except for a prose_fact_finding ID partition, whose citations must be [].
  ${ordinaryCitations}
  ${evidenceBoundaries}
  Omit a question instead of guessing source facts, candidate IDs, or an ID shape outside its stated contract.

REQUEST ENVELOPE:
${canonicalJson(requestEnvelope)}`;
}

function proposalPrompt(requestEnvelope: ModelPromptEnvelope): Message[] {
  const kinds = new Set(requestEnvelope.questions.map((question) => question.kind));
  const npcEncounterEnabled = requestEnvelope.questions.some((question) => question.kind === "npc_binding"
    && question.candidateDomains.allowedNpcEncounterProfiles?.length);
  const ordinaryDeclarationBoundary = [
    requestEnvelope.questions.some((question) => question.kind === "connection_topology")
      ? "For connection_topology, connectionId is a source-cited unique declaration label scoped to that connection."
      : "",
    requestEnvelope.questions.some((question) => question.kind === "ending_rule")
      ? "For ending_rule, endingId is a source-cited unique declaration label and spec.id is a source-cited unique mechanism declaration retained in the accepted mechanics IR; publication remains validator-controlled."
      : "",
    requestEnvelope.questions.some((question) => question.kind === "discovery_method")
      ? "For discovery_method, spec.id is a source-cited unique mechanism declaration retained in the accepted mechanics IR; publication remains validator-controlled."
      : "",
  ].filter(Boolean).join(" ");
  const hasAutomaticServerDerivedSubset = kinds.has("npc_binding") || kinds.has("clue_fact_facets") || kinds.has("source_fact_mechanic");
  const automaticServerDerivedBoundary = hasAutomaticServerDerivedSubset
    ? " In automatic npc_binding, clue_fact_facets, and source_fact_mechanic subsets, do not submit server-derived runtime IDs; use only the request-specific source evidence and declaration fields."
    : "";
  const systemContent = [
    "You propose evidence-grounded compiler hints. You are not an authority and cannot resolve, publish, review, or change policy.",
    kinds.has("npc_binding")
      ? npcEncounterEnabled
        ? "Only an already-playable heading may receive an automatic NPC binding. Only the request's closed allowedNpcEncounterProfiles permit an automatic encounter. It must be a source-exact direct-stat selection and separately prove an immediate unconditional hostile anchor fact; the compiler derives all runtime mechanics and empty victory effects."
        : "Only an already-playable heading may receive an automatic NPC binding. The automatic NPC subset permits source-exact nameQuote and source-exact prose relationshipEvidence only; the compiler derives all runtime fields."
      : "",
    kinds.has("clue_fact_facets")
      ? "clue_fact_facets may partition only their closed source-exact atom domain and may choose only the compact finding-method fields described in the request; IDs, availability, effects, and runtime AST remain compiler-derived."
      : "",
    hasAutomaticServerDerivedSubset
      ? "Outside a request's explicit automatic shape, marked-item dialogue, item acquisition, state writes, SAN, combat, and encounters require human review and must never be proposed."
      : "",
    automaticServerDerivedBoundary,
    ordinaryDeclarationBoundary,
  ].filter(Boolean).join(" ");
  return [
    {
      role: "system",
      content: systemContent,
    },
    {
      role: "user",
      content: proposalUserContent(requestEnvelope),
    },
  ];
}

/** The complete-message cap uses the exact JavaScript strings passed to chat. */
function promptCharsFor(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

/**
 * Build the only message shape the adapter may hash or send. Chunk sizing must
 * use this exact shaped prompt so NPC/source-fact guidance cannot bypass the
 * complete-message budget after an envelope-only preflight.
 */
function promptChunkFor(
  base: CompilerHintProposalRequestEnvelope,
  questions: CompilerHintProposalRequestQuestion[],
  npcBindingModes: ReadonlyMap<string, NpcBindingProposalMode>,
): PromptChunk {
  const envelope = envelopeFor(base, questions);
  const modelEnvelope = modelRequestEnvelope(envelope, npcBindingModes);
  const messages = proposalPrompt(modelEnvelope);
  return {
    questions,
    envelopeChars: canonicalJson(modelEnvelope).length,
    messages,
    promptChars: promptCharsFor(messages),
  };
}

/**
 * A non-playable heading may be explicitly closed as source-only, but an
 * automatic runtime NPC would make that heading playable by implication.
 * Enforce this after the shared grounded parser, before the adapter exposes an
 * accepted answer to orchestration.
 */
function npcBindingAcceptedBoundaryDiagnostic(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  resolution: CompilerQuestionResolution,
  mode: NpcBindingProposalMode,
): CompilerHintProposalAdapterDiagnostic | undefined {
  if (mode !== "none_only") return undefined;
  try {
    const parsed = parseCompilerHintValue(question, resolution.value, graph);
    if (parsed.kind === "npc_binding" && parsed.presentNpcs.length === 0) return undefined;
  } catch {
    // The shared compiler should already have parsed this value, but fail
    // closed at this adapter boundary if that invariant ever changes.
  }
  return {
    proposalIndex: -1,
    questionId: question.id,
    code: "npc_binding_requires_playable_scene",
    message: "automatic non-empty NPC bindings require an answered playable scene role",
    stage: "proposal",
  };
}

function validateResponseRoot(value: unknown, expectedQuestionIds: ReadonlySet<string>): { proposals: unknown[] } | CompilerHintProposalAdapterDiagnostic {
  const root = record(value);
  if (!root) return { proposalIndex: -1, code: "invalid_response_root", message: "model response must contain a JSON object root", stage: "response" };
  for (const key of Object.keys(root)) {
    if (key !== "proposals") return { proposalIndex: -1, code: "unexpected_root_field", message: `model response has undeclared root field: ${key}`, stage: "response" };
  }
  if (!Array.isArray(root.proposals)) return { proposalIndex: -1, code: "invalid_response_root", message: "model response root proposals must be an array", stage: "response" };
  const seen = new Set<string>();
  for (const proposal of root.proposals) {
    const proposalRecord = record(proposal);
    const questionId = proposalRecord?.questionId;
    if (typeof questionId !== "string" || !questionId) continue;
    if (seen.has(questionId)) return { proposalIndex: -1, questionId, code: "duplicate_question_proposal", message: `model response has duplicate question proposal: ${questionId}`, stage: "response" };
    seen.add(questionId);
    if (!expectedQuestionIds.has(questionId)) return { proposalIndex: -1, questionId, code: "question_outside_chunk", message: `model response answered a question outside this request chunk: ${questionId}`, stage: "response" };
  }
  return { proposals: root.proposals };
}

function proposalIdFor(
  queue: CompilerQuestionQueue,
  questionIds: string[],
  requestHash: string,
  responseHash: string,
  producer: TrustedCompilerHintProposalProducer,
): string {
  const identity = canonicalJson({
    domain: "compiler-hint-proposal-adapter-v1",
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    queueHash: queue.queueHash,
    questionIds: [...questionIds].sort(),
    requestHash,
    responseHash,
    producer: { modelFingerprint: producer.modelFingerprint, providerFingerprint: producer.providerFingerprint },
  });
  return `proposal_${sha256(identity).slice(0, 32)}`;
}

function result(
  status: CompilerHintProposalAdapterStatus,
  hints: ModuleCompileHints,
  accepted: AcceptedCompilerHintProposalAdapterResult[],
  rejected: CompilerHintProposalAdapterDiagnostic[],
  eligibleQuestionIds: string[],
  calls: CompilerHintProposalAdapterCall[],
): CompilerHintProposalAdapterResult {
  const acceptedQuestionIds = new Set(accepted.map((entry) => entry.questionId));
  return {
    status,
    hints,
    accepted,
    rejected,
    unansweredQuestionIds: eligibleQuestionIds.filter((questionId) => !acceptedQuestionIds.has(questionId)).sort(),
    callCount: calls.length,
    calls,
    requestHashes: calls.map((call) => call.requestHash),
    responseHashes: calls.flatMap((call) => call.responseHash ? [call.responseHash] : []),
  };
}

/**
 * Ask an LLMLike implementation for bounded, untrusted proposals and compile only
 * validated grounded answers into partial hints. This function never applies hints,
 * publishes artifacts, or exposes an HTTP/PDF endpoint.
 */
export async function requestCompilerHintProposals(input: CompilerHintProposalAdapterInput): Promise<CompilerHintProposalAdapterResult> {
  validateSourceFactGraph(input.graph);
  const initialHints = emptyHints(input.queue);
  const policyFailure = trustedPolicyDiagnostic(input.policy);
  if (policyFailure) return result("failed", initialHints, [], [policyFailure], [], []);
  const producerFailure = trustedProducerDiagnostic(input.producer);
  if (producerFailure) return result("failed", initialHints, [], [producerFailure], [], []);
  const base = buildCompilerHintProposalRequestEnvelope(input.graph, input.queue, input.policy);
  const limits = limitsFor(input.limits);
  if ("stage" in limits) return result("failed", initialHints, [], [limits], [], []);
  const npcBindingModes = new Map(base.questions.map((question) => [question.questionId, npcBindingProposalMode(input.graph, input.queue, question)]));
  const eligible = base.questions
    .filter((question) => question.allowedKinds.length > 0
      && npcBindingModes.get(question.questionId) !== "ineligible"
      && sourceFactMechanicProposalEligible(input.graph, input.queue, question))
    .sort((left, right) => compareEligibleQuestions(input.graph, input.queue, npcBindingModes, left, right));
  const eligibleQuestionIds = eligible.map((question) => question.questionId);
  if (!eligible.length) return result("no_eligible_questions", initialHints, [], [], [], []);

  const chunked = chunkQuestions(base, eligible, limits, npcBindingModes);
  const chatOptions = chatOptionsFor(limits);
  const rejected = [...chunked.rejected];
  const accepted: AcceptedCompilerHintProposalAdapterResult[] = [];
  const calls: CompilerHintProposalAdapterCall[] = [];
  for (const [chunkIndex, chunk] of chunked.chunks.entries()) {
    if (input.signal?.aborted) {
      rejected.push({ proposalIndex: -1, chunkIndex, code: "operation_aborted", message: "automatic compiler operation was cancelled before another model request", stage: "model" });
      break;
    }
    if (calls.length >= limits.maxRequestsPerRound) {
      for (const questionId of chunk.questions.map((question) => question.questionId).sort()) {
        rejected.push({
          proposalIndex: -1,
          questionId,
          chunkIndex,
          code: "max_model_requests_reached",
          message: "trusted maxRequestsPerRound prevented this question from being sent to the model",
          stage: "chunking",
        });
      }
      continue;
    }
    // Defence in depth: only the pre-sized immutable message shape reaches
    // chat, and it is rechecked immediately before the capability boundary.
    if (promptCharsFor(chunk.messages) > limits.maxPromptChars) {
      for (const question of chunk.questions) {
        rejected.push({
          proposalIndex: -1,
          questionId: question.questionId,
          chunkIndex,
          code: "question_exceeds_prompt_limit",
          message: `question exceeds maxPromptChars (${limits.maxPromptChars})`,
          stage: "chunking",
        });
      }
      continue;
    }
    const questionIds = chunk.questions.map((question) => question.questionId).sort();
    const messages = chunk.messages;
    const requestHash = sha256(canonicalJson({ domain: "compiler-hint-proposal-request-v1", messages, options: chatOptions }));
    let rawResponse: string;
    try {
      rawResponse = await input.llm.chat(messages, { ...chatOptions, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
      calls.push({ chunkIndex, questionIds, requestHash, status: "failed" });
      rejected.push({ proposalIndex: -1, chunkIndex, code: input.signal?.aborted ? "operation_aborted" : "llm_call_failed", message: input.signal?.aborted ? "automatic compiler operation was cancelled" : errorMessage(error, "LLMLike.chat failed"), stage: "model" });
      if (input.signal?.aborted) break;
      continue;
    }
    if (input.signal?.aborted) {
      calls.push({ chunkIndex, questionIds, requestHash, status: "failed" });
      rejected.push({ proposalIndex: -1, chunkIndex, code: "operation_aborted", message: "automatic compiler operation was cancelled before processing a model response", stage: "model" });
      break;
    }
    const responseHash = sha256(rawResponse);
    const decoded = extractJson(rawResponse);
    if (decoded === null) {
      calls.push({ chunkIndex, questionIds, requestHash, responseHash, status: "failed" });
      rejected.push({ proposalIndex: -1, chunkIndex, code: "invalid_json", message: "LLMLike response did not contain valid JSON", stage: "response" });
      continue;
    }
    const validatedResponse = validateResponseRoot(decoded, new Set(questionIds));
    if ("stage" in validatedResponse) {
      calls.push({ chunkIndex, questionIds, requestHash, responseHash, status: "failed" });
      rejected.push({ ...validatedResponse, chunkIndex });
      continue;
    }
    const proposalId = proposalIdFor(input.queue, questionIds, requestHash, responseHash, input.producer);
    try {
      const compiled = compileGroundedHintProposals(input.graph, input.queue, {
        schemaVersion: COMPILER_HINT_PROPOSAL_BATCH_SCHEMA_VERSION,
        moduleId: input.queue.moduleId,
        documentHash: input.queue.documentHash,
        sourceGraphIdentity: input.queue.sourceGraphIdentity,
        queueHash: input.queue.queueHash,
        proposalId,
        proposals: validatedResponse.proposals as CompilerHintProposal[],
      }, {
        ...input.policy,
        producer: {
          providerFingerprint: input.producer.providerFingerprint,
          modelFingerprint: input.producer.modelFingerprint,
          requestHash,
          responseHash,
        },
      });
      const boundaryRejected: CompilerHintProposalAdapterDiagnostic[] = [];
      const boundaryAccepted = compiled.accepted.filter((entry) => {
        const question = input.queue.questions.find((candidate) => candidate.id === entry.questionId);
        if (!question) return false;
        const diagnostic = npcBindingAcceptedBoundaryDiagnostic(input.graph, question, entry.resolution, npcBindingModes.get(entry.questionId) ?? "ineligible");
        if (!diagnostic) return true;
        boundaryRejected.push({ ...diagnostic, proposalIndex: entry.proposalIndex, chunkIndex });
        return false;
      });
      accepted.push(...boundaryAccepted.map((entry) => ({ ...entry, chunkIndex, proposalId })));
      rejected.push(
        ...compiled.rejected.map((diagnostic) => ({ ...diagnostic, chunkIndex, stage: "proposal" as const })),
        ...boundaryRejected,
      );
      calls.push({ chunkIndex, questionIds, requestHash, responseHash, proposalId, status: compiled.rejected.length || boundaryRejected.length ? "rejected" : "accepted" });
    } catch (error) {
      calls.push({ chunkIndex, questionIds, requestHash, responseHash, proposalId, status: "failed" });
      rejected.push({ proposalIndex: -1, chunkIndex, code: errorCode(error, "proposal_compile_failed"), message: errorMessage(error, "proposal compiler failed"), stage: "proposal" });
    }
  }

  accepted.sort((left, right) => left.questionId.localeCompare(right.questionId) || left.proposalId.localeCompare(right.proposalId) || left.proposalIndex - right.proposalIndex);
  const duplicateAccepted = accepted.find((entry, index) => index > 0 && accepted[index - 1]!.questionId === entry.questionId);
  if (duplicateAccepted) {
    const failure: CompilerHintProposalAdapterDiagnostic = {
      proposalIndex: duplicateAccepted.proposalIndex,
      questionId: duplicateAccepted.questionId,
      code: "duplicate_question_proposal",
      message: `multiple chunks accepted the same question: ${duplicateAccepted.questionId}`,
      stage: "aggregate",
    };
    return result("failed", initialHints, [], [...rejected, failure], eligibleQuestionIds, calls);
  }
  const hints: ModuleCompileHints = { ...initialHints, resolutions: accepted.map((entry) => structuredClone(entry.resolution)) };
  try {
    validateModuleCompileHints(input.queue, hints, input.graph);
  } catch (error) {
    return result("failed", initialHints, [], [...rejected, {
      proposalIndex: -1,
      code: errorCode(error, "aggregate_validation_failed"),
      message: errorMessage(error, "aggregate hint validation failed"),
      stage: "aggregate",
    }], eligibleQuestionIds, calls);
  }
  const status: CompilerHintProposalAdapterStatus = rejected.length
    ? accepted.length ? "partial" : "failed"
    : accepted.length === eligibleQuestionIds.length ? "ok" : "partial";
  return result(status, hints, accepted, rejected, eligibleQuestionIds, calls);
}
