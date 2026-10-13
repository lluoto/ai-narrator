import type { RightsStatus } from "./source-authority";
import {
  COMPILER_HINT_PROPOSAL_AUDIT_SCHEMA_VERSION,
  COMPILER_HINT_PROPOSAL_AUDIT_PROVENANCE_SCHEMA_VERSION,
  COMPILER_HINT_PROPOSAL_AUDIT_NPC_PROSE_DIALOGUE_SCHEMA_VERSION,
  COMPILER_HINT_PROPOSAL_AUDIT_NPC_ENCOUNTER_SCHEMA_VERSION,
  MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  allowedNpcEncounterProfiles,
  automaticNpcProseDialogueClaimKeys,
  compilerHintClaimKeys,
  npcBindingLocationScene,
  parseCompilerHintValue,
  validateAutomaticNpcProseDialogueCitationQuotes,
  validateAutomaticNpcProseDialogueProposalValue,
  validateItemBindingCitationQuote,
  validateNpcBindingCitationQuote,
  validateRewardBindingCitationQuote,
  validateClueFactFacetCitationQuotes,
  isExactClueFactAtomCitation,
  validateSourceFactDispositionCitationQuote,
  validateSourceFactMechanicCitationQuotes,
  validateCompilerQuestionQueue,
  validateModuleCompileHints,
  type CompilerHintCitation,
  type CompilerHintProposalProducerProvenance,
  type AllowedNpcEncounterProfile,
  type CompilerQuestion,
  type CompilerQuestionKind,
  type CompilerQuestionResolution,
  type CompilerQuestionQueue,
  type ModuleCompileHints,
} from "./compiler-question-queue";
import { validateSourceFactGraph, type SourceFactGraph } from "./source-fact-graph";

/** Existing untrusted model-response contract; candidate catalogs are not model output. */
export const COMPILER_HINT_PROPOSAL_BATCH_SCHEMA_VERSION = "1.0.0";
/**
 * 1.4.0 carries the queue contract that reserves both marked and prose NPC
 * dialogue clues for explicit human review.
 * It is deliberately separate from the unchanged proposal-batch response wire
 * contract, so callers cannot silently treat opaque-ID requests as equivalent.
 */
export const COMPILER_HINT_PROPOSAL_REQUEST_SCHEMA_VERSION = "1.9.0";
/** No-profile requests retain the prior bytes/identity contract. */
export const LEGACY_COMPILER_HINT_PROPOSAL_REQUEST_SCHEMA_VERSION = "1.8.0";

const SUPPORTED_KINDS = ["scene_role", "entry_scene", "connection_topology", "core_clue", "ending_rule", "discovery_method", "clue_fact_facets", "source_fact_disposition", "source_fact_mechanic", "npc_binding", "item_binding", "reward_binding"] as const;
const RIGHTS_STATUSES: readonly RightsStatus[] = ["unknown", "open_licensed", "project_owned", "user_provided"];

export type SupportedCompilerHintProposalKind = typeof SUPPORTED_KINDS[number];
export type AllowedSourceFactMechanicKind = "existing_clue_discovery" | "prose_fact_finding" | "scene_state_transition";
const DEFAULT_ALLOWED_SOURCE_FACT_MECHANIC_KINDS: readonly AllowedSourceFactMechanicKind[] = ["existing_clue_discovery"];

/** The complete untrusted payload for one candidate answer. It deliberately has no authority fields. */
export interface CompilerHintProposal {
  questionId: string;
  kind: CompilerQuestionKind;
  value: unknown;
  citations: CompilerHintCitation[];
}

/** A model/external-system response tied to exactly one queue snapshot. */
export interface CompilerHintProposalBatch {
  schemaVersion: typeof COMPILER_HINT_PROPOSAL_BATCH_SCHEMA_VERSION;
  moduleId: string;
  documentHash: string | null;
  sourceGraphIdentity: string;
  queueHash: string;
  proposalId: string;
  proposals: CompilerHintProposal[];
}

/** Trusted caller-controlled policy data; it is never read from the proposal batch. */
export interface TrustedCompilerHintProposalPolicy {
  policyId: string;
  rightsStatus: RightsStatus;
  /** Server-owned capability gate; source children default to discovery only. */
  allowedSourceFactMechanicKinds?: readonly AllowedSourceFactMechanicKind[];
  /** Explicit server-owned combat capability; omission deliberately remains deny-by-default. */
  allowSourceExactNpcEncounters?: true;
  /** Adapter-supplied provenance. It is optional to keep existing human/first-slice callers compatible. */
  producer?: CompilerHintProposalProducerProvenance;
}

export interface CompilerHintProposalDiagnostic {
  proposalIndex: number;
  questionId?: string;
  code: string;
  message: string;
}

export interface AcceptedCompilerHintProposal {
  proposalIndex: number;
  questionId: string;
  resolution: CompilerQuestionResolution;
}

export interface GroundedHintProposalResult {
  hints: ModuleCompileHints;
  accepted: AcceptedCompilerHintProposal[];
  rejected: CompilerHintProposalDiagnostic[];
}

export interface CompilerHintProposalRequestQuestion {
  questionId: string;
  kind: CompilerQuestionKind;
  prompt: string;
  sourceStatements: Array<{ statementId: string; text: string }>;
  /** Present only for an activated typed source-fact child. All IDs are trusted queue scope, not model choices. */
  sourceFactScope?: {
    rootStatementId: string;
    parentQuestionId: string;
    owningHeadingStatementId: string;
    owningSceneCandidateId: string;
  };
  candidateDomains: {
    candidateIds?: string[];
    subjectCandidateId?: string;
    allowedCandidateIds?: string[];
    allowedLocationCandidateIds?: string[];
    allowedMechanicsTargetIds?: Record<string, string[]>;
    allowedItemNameEvidenceStatementIds?: string[];
    allowedRewardPredicateIds?: Partial<Record<"scene" | "clue" | "item", string[]>>;
    /** Closed, source-exact marked-clue body partition domain. */
    allowedClueFactAtoms?: Array<{ atomId: string; quote: string; statementId: string }>;
    /** Root atoms selectable only as a source-only partition remainder. */
    allowedSourceFactAtoms?: Array<{ atomId: string; quote: string; statementId: string }>;
    /** Server-derived check/finding choices; no caller quote or mechanics fields exist. */
    allowedProseFactFindingCandidates?: Array<{ candidateId: string; atomId: string; quote: string; check: unknown }>;
    allowedDispositions?: Array<"source_only" | "mechanics_candidate">;
    allowedSourceFactMechanicKinds?: AllowedSourceFactMechanicKind[];
    /** Closed source-exact direct-stat domain, emitted only under trusted combat capability. */
    allowedNpcEncounterProfiles?: AllowedNpcEncounterProfile[];
  };
  /** Empty means this question is intentionally not eligible for external proposal. */
  allowedKinds: SupportedCompilerHintProposalKind[];
}

/** A candidate ID decoded from trusted graph/queue structure, never model output. */
export interface CompilerHintProposalCandidate {
  id: string;
  kind: "scene" | "clue" | "item" | "prose_npc_anchor" | "reward";
  /** Verbatim heading, marked-item-name, or ordinary paragraph text. */
  label: string;
  sourceStatementId: string;
  evidenceRefId: string;
}

/** Deterministic model request material; no field in this envelope is an inferred answer. */
export interface CompilerHintProposalRequestEnvelope {
  schemaVersion: typeof LEGACY_COMPILER_HINT_PROPOSAL_REQUEST_SCHEMA_VERSION | typeof COMPILER_HINT_PROPOSAL_REQUEST_SCHEMA_VERSION;
  moduleId: string;
  documentHash: string | null;
  sourceGraphIdentity: string;
  queueHash: string;
  /** Contains an entry for every candidate ID referenced by `questions`. */
  candidateCatalog: CompilerHintProposalCandidate[];
  questions: CompilerHintProposalRequestQuestion[];
}

export class CompilerHintProposalError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CompilerHintProposalError";
  }
}

class ProposalValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProposalValidationError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProposalValidationError("invalid_proposal", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function batchRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompilerHintProposalError("invalid_batch", "proposal batch must be an object");
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[], code: string, label: string): void {
  for (const key of Object.keys(value)) {
    if (keys.includes(key)) continue;
    const forbidden = ["authority", "reviewerKind", "rightsStatus", "sourceStatementIds", "evidenceRefs", "source", "evidence", "derivation", "policyId", "reason", "audit"];
    throw new ProposalValidationError(forbidden.includes(key) ? "forbidden_proposal_field" : code, `${label} has undeclared field: ${key}`);
  }
}

function batchOnly(value: Record<string, unknown>): void {
  const fields = ["schemaVersion", "moduleId", "documentHash", "sourceGraphIdentity", "queueHash", "proposalId", "proposals"];
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new CompilerHintProposalError("invalid_batch", `proposal batch has undeclared field: ${key}`);
}

function requiredString(value: unknown, code: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProposalValidationError(code, `${label} must be a non-empty string`);
  return value;
}

function requiredBatchString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CompilerHintProposalError("invalid_batch", `${label} must be a non-empty string`);
  return value;
}

function isSupportedKind(kind: CompilerQuestionKind): kind is SupportedCompilerHintProposalKind {
  return (SUPPORTED_KINDS as readonly string[]).includes(kind);
}

function isGenericProseDiscovery(question: CompilerQuestion): boolean {
  return question.kind === "discovery_method" && (!question.subjectCandidateId || !question.allowedLocationCandidateIds?.length || !question.allowedMechanicsTargetIds);
}

/** Check capability before the restricted NPC shape parser reports incidental syntax details. */
function rawNpcBindingDeclaresEncounter(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const present = (value as Record<string, unknown>).presentNpcs;
  return Array.isArray(present) && present.some((npc) => !!npc && typeof npc === "object" && !Array.isArray(npc) && Object.hasOwn(npc, "encounter"));
}

/**
 * A positive automatic NPC binding creates a runtime action surface, so it is
 * only valid after the same heading has an explicit playable_scene answer.
 * Keep this in the grounded compiler as well as the adapter boundary: callers
 * may invoke compileGroundedHintProposals without the HTTP/LLM adapter.
 */
function automaticNpcBindingHasPlayableScene(graph: SourceFactGraph, queue: CompilerQuestionQueue, question: CompilerQuestion): boolean {
  if (question.kind !== "npc_binding") return false;
  let location: ReturnType<typeof npcBindingLocationScene>;
  try {
    location = npcBindingLocationScene(graph, question);
  } catch {
    return false;
  }
  const sceneRole = queue.questions.find((candidate) => candidate.kind === "scene_role"
    && candidate.subjectCandidateId === location.sceneCandidateId
    && candidate.sourceStatementIds.length === 1
    && candidate.sourceStatementIds[0] === location.headingStatementId);
  if (!sceneRole || sceneRole.status !== "answered" || !sceneRole.resolution) return false;
  try {
    const parsed = parseCompilerHintValue(sceneRole, sceneRole.resolution.value, graph);
    return parsed.kind === "scene_role" && parsed.role === "playable_scene";
  } catch {
    return false;
  }
}

/** A source child may be open after parent replay, but never requestable until its exact owner is playable. */
function sourceFactMechanicHasPlayableScene(graph: SourceFactGraph, queue: CompilerQuestionQueue, question: CompilerQuestion): boolean {
  if (question.kind !== "source_fact_mechanic" || !question.owningSceneCandidateId) return false;
  const sceneRole = queue.questions.find((candidate) => candidate.kind === "scene_role" && candidate.subjectCandidateId === question.owningSceneCandidateId);
  if (!sceneRole || sceneRole.status !== "answered" || !sceneRole.resolution) return false;
  try {
    const parsed = parseCompilerHintValue(sceneRole, sceneRole.resolution.value, graph);
    return parsed.kind === "scene_role" && parsed.role === "playable_scene";
  } catch {
    return false;
  }
}

function cloneCitation(citation: CompilerHintCitation): CompilerHintCitation {
  return { claimKey: citation.claimKey, statementId: citation.statementId, quote: citation.quote };
}

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : fallback;
}

function candidateIds(question: CompilerQuestion): string[] {
  return [
    ...(question.candidateIds ?? []),
    ...(question.subjectCandidateId ? [question.subjectCandidateId] : []),
    ...(question.allowedCandidateIds ?? []),
    ...(question.allowedLocationCandidateIds ?? []),
    ...Object.values(question.allowedMechanicsTargetIds ?? {}).flatMap((ids) => ids ?? []),
    ...Object.values(question.allowedRewardPredicateIds ?? {}).flatMap((ids) => ids ?? []),
  ];
}

function candidateKindForQuestion(question: CompilerQuestion, candidateId: string): "scene" | "clue" | "item" | "prose_npc_anchor" | "reward" | undefined {
  const is = (ids: readonly string[] | undefined) => ids?.includes(candidateId) ?? false;
  switch (question.kind) {
    case "scene_role":
    case "entry_scene":
    case "connection_topology":
      return "scene";
    case "core_clue":
    case "clue_fact_facets":
      return "clue";
    case "item_binding":
      return "item";
    case "reward_binding":
      if (candidateId === question.subjectCandidateId || is(question.candidateIds) || is(question.allowedCandidateIds)) return "reward";
      if (is(question.allowedRewardPredicateIds?.scene)) return "scene";
      if (is(question.allowedRewardPredicateIds?.clue)) return "clue";
      if (is(question.allowedRewardPredicateIds?.item)) return "item";
      return undefined;
    case "discovery_method":
      if (candidateId === question.subjectCandidateId || is(question.candidateIds)) return "clue";
      if (is(question.allowedLocationCandidateIds)) return "scene";
      if (is(question.allowedMechanicsTargetIds?.scene)) return "scene";
      if (is(question.allowedMechanicsTargetIds?.clue)) return "clue";
      if (is(question.allowedMechanicsTargetIds?.item)) return "item";
      return undefined;
    case "ending_rule":
      return undefined;
    case "npc_binding":
      return "prose_npc_anchor";
    case "source_fact_disposition":
      return undefined;
    case "source_fact_mechanic":
      if (candidateId === question.owningSceneCandidateId || is(question.allowedMechanicsTargetIds?.scene)) return "scene";
      if (is(question.allowedMechanicsTargetIds?.clue)) return "clue";
      if (is(question.allowedMechanicsTargetIds?.item)) return "item";
      return undefined;
    default:
      return undefined;
  }
}

function addCandidate(
  candidates: Map<string, CompilerHintProposalCandidate>,
  candidate: CompilerHintProposalCandidate,
): void {
  const existing = candidates.get(candidate.id);
  if (!existing) {
    candidates.set(candidate.id, candidate);
    return;
  }
  if (existing.kind !== candidate.kind || existing.label !== candidate.label || existing.sourceStatementId !== candidate.sourceStatementId || existing.evidenceRefId !== candidate.evidenceRefId) {
    throw new CompilerHintProposalError("candidate_catalog_conflict", `candidate ${candidate.id} has conflicting trusted source labels`);
  }
}

/**
 * Derive IDs only from the deterministic question queue, then attach labels
 * only from source-exact graph statements. This intentionally rejects a queue
 * that tries to use a valid ID in a foreign candidate domain.
 */
function buildCandidateCatalog(graph: SourceFactGraph, queue: CompilerQuestionQueue): CompilerHintProposalCandidate[] {
  const statements = new Map(graph.statements.map((statement) => [statement.id, statement]));
  const candidates = new Map<string, CompilerHintProposalCandidate>();
  for (const question of queue.questions) {
    if (question.kind === "scene_role" && question.subjectCandidateId) {
      const statement = question.sourceStatementIds.map((id) => statements.get(id)).find((candidate) => candidate?.kind === "heading");
      if (!statement) throw new CompilerHintProposalError("candidate_catalog_missing_source", `scene candidate lacks a source-exact heading: ${question.subjectCandidateId}`);
      addCandidate(candidates, {
        id: question.subjectCandidateId,
        kind: "scene",
        label: statement.text,
        sourceStatementId: statement.id,
        evidenceRefId: statement.evidenceRefId,
      });
    }
    if (question.kind === "core_clue" && question.subjectCandidateId) {
      const markedItem = question.sourceStatementIds.map((id) => statements.get(id)).find((candidate) => candidate?.kind === "marked_item");
      const nameRelation = markedItem && graph.relations.find((relation) => relation.kind === "marked_item_name" && relation.from === markedItem.id);
      const name = nameRelation && statements.get(nameRelation.to);
      if (!name || name.kind !== "marked_item_name") throw new CompilerHintProposalError("candidate_catalog_missing_source", `clue candidate lacks a source-exact marked-item name: ${question.subjectCandidateId}`);
      addCandidate(candidates, {
        id: question.subjectCandidateId,
        kind: "clue",
        label: name.text,
        sourceStatementId: name.id,
        evidenceRefId: name.evidenceRefId,
      });
    }
    if (question.kind === "item_binding" && question.subjectCandidateId) {
      const name = question.sourceStatementIds.map((id) => statements.get(id)).find((candidate) => candidate?.kind === "marked_item_name");
      if (!name) throw new CompilerHintProposalError("candidate_catalog_missing_source", `item candidate lacks a source-exact marked-item name: ${question.subjectCandidateId}`);
      addCandidate(candidates, {
        id: question.subjectCandidateId,
        kind: "item",
        label: name.text,
        sourceStatementId: name.id,
        evidenceRefId: name.evidenceRefId,
      });
    }
    if (question.kind === "npc_binding" && question.subjectCandidateId) {
      const paragraph = question.subjectStatementId ? statements.get(question.subjectStatementId) : undefined;
      if (!paragraph || paragraph.kind !== "paragraph" || !question.sourceStatementIds.includes(paragraph.id)) {
        throw new CompilerHintProposalError("candidate_catalog_missing_source", `prose NPC anchor lacks its canonical source paragraph: ${question.subjectCandidateId}`);
      }
      addCandidate(candidates, {
        id: question.subjectCandidateId,
        kind: "prose_npc_anchor",
        label: paragraph.text,
        sourceStatementId: paragraph.id,
        evidenceRefId: paragraph.evidenceRefId,
      });
    }
    if (question.kind === "reward_binding" && question.subjectCandidateId) {
      const row = question.sourceStatementIds.map((id) => statements.get(id)).find((candidate) => candidate?.kind === "table_row");
      if (!row) throw new CompilerHintProposalError("candidate_catalog_missing_source", `reward candidate lacks a source-exact table row: ${question.subjectCandidateId}`);
      addCandidate(candidates, {
        id: question.subjectCandidateId,
        kind: "reward",
        label: row.text,
        sourceStatementId: row.id,
        evidenceRefId: row.evidenceRefId,
      });
    }
  }
  for (const question of queue.questions) {
    for (const candidateId of candidateIds(question)) {
      const candidate = candidates.get(candidateId);
      if (!candidate) throw new CompilerHintProposalError("unknown_candidate_catalog_entry", `candidate ID has no trusted source catalog entry: ${candidateId}`);
      const expectedKind = candidateKindForQuestion(question, candidateId);
      if (expectedKind && candidate.kind !== expectedKind) {
        throw new CompilerHintProposalError("foreign_candidate_domain", `candidate ${candidateId} is not a ${expectedKind} for ${question.kind}`);
      }
    }
  }
  return [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Validate trusted caller policy before any untrusted proposal is considered. */
export function validateTrustedCompilerHintProposalPolicy(policy: TrustedCompilerHintProposalPolicy): void {
  if (!policy.policyId?.trim()) throw new CompilerHintProposalError("invalid_trusted_policy", "policyId is required");
  if (!RIGHTS_STATUSES.includes(policy.rightsStatus)) throw new CompilerHintProposalError("invalid_trusted_policy", "rightsStatus is not allowed");
  if (policy.allowedSourceFactMechanicKinds !== undefined) {
    if (!Array.isArray(policy.allowedSourceFactMechanicKinds) || policy.allowedSourceFactMechanicKinds.length === 0
    || policy.allowedSourceFactMechanicKinds.some((kind) => !(["existing_clue_discovery", "prose_fact_finding", "scene_state_transition"] as string[]).includes(kind))
      || new Set(policy.allowedSourceFactMechanicKinds).size !== policy.allowedSourceFactMechanicKinds.length) {
      throw new CompilerHintProposalError("invalid_trusted_policy", "allowedSourceFactMechanicKinds must be a unique non-empty server-owned capability list");
    }
  }
  if (policy.allowSourceExactNpcEncounters !== undefined && policy.allowSourceExactNpcEncounters !== true) {
    throw new CompilerHintProposalError("invalid_trusted_policy", "allowSourceExactNpcEncounters must be the literal server-owned true capability");
  }
  if (!policy.producer) return;
  const producer = policy.producer;
  if (!producer.providerFingerprint?.trim() || !producer.modelFingerprint?.trim()) throw new CompilerHintProposalError("invalid_trusted_policy", "producer fingerprints are required");
  if (!/^[a-f0-9]{64}$/.test(producer.requestHash) || !/^[a-f0-9]{64}$/.test(producer.responseHash)) throw new CompilerHintProposalError("invalid_trusted_policy", "producer request and response hashes must be sha256 hex");
}

function allowedSourceFactMechanicKinds(policy?: TrustedCompilerHintProposalPolicy): AllowedSourceFactMechanicKind[] {
  return [...(policy?.allowedSourceFactMechanicKinds ?? DEFAULT_ALLOWED_SOURCE_FACT_MECHANIC_KINDS)].sort();
}

function npcEncounterProfilesForRequest(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  policy?: TrustedCompilerHintProposalPolicy,
): AllowedNpcEncounterProfile[] | undefined {
  if (question.kind !== "npc_binding" || policy?.allowSourceExactNpcEncounters !== true) return undefined;
  const profiles = allowedNpcEncounterProfiles(graph, question);
  return profiles.length ? profiles : undefined;
}

/**
 * The prepared queue's human-review prompt can describe every compiler
 * capability. An external proposal envelope must instead describe only the
 * server-owned subset enabled by its trusted policy.
 */
function sourceFactMechanicProposalPrompt(allowedKinds: readonly AllowedSourceFactMechanicKind[]): string {
  const existingEnabled = allowedKinds.includes("existing_clue_discovery");
  const proseFindingEnabled = allowedKinds.includes("prose_fact_finding");
  const transitionEnabled = allowedKinds.includes("scene_state_transition");
  const declarations = [
    "External proposal contract for this source-fact child: use exactly one mutually exclusive value shape described below.",
    `Only these declaration kinds are enabled by trusted policy: ${allowedKinds.join(", ")}.`,
    existingEnabled
      ? "Legacy declarations shape: return one to four declarations with unique declarationKey. existing_clue_discovery has exactly declarationKey, kind, clueCandidateId, action, target, targetId, optional check, optional availability, and evidence; action is observe|search|read|use_item|move and every target or predicate ID must be in the closed same-heading domains."
      : "existing_clue_discovery is not enabled by trusted policy.",
    proseFindingEnabled
      ? "When allowedProseFactFindingCandidates is present, prose_fact_finding has exactly findingCandidateIds:[one offered candidate ID] and sourceOnlyAtomIds:[the remaining offered root atom IDs]. This shape is mutually exclusive with declarations and citations must be []. Do not submit quote, skill, check, action, target, location, clueId, mechanismId, effect, failure, failback, or AST; the server derives all of them."
      : "prose_fact_finding is not enabled by trusted policy.",
    transitionEnabled
      ? "scene_state_transition has exactly declarationKey, kind, trigger:{kind:scene_enter}|{kind:clue_found,clueCandidateId}, discoverClueCandidateId, and evidence. Trigger and output IDs must be in the closed same-heading clue domain. scene_enter evidence has declaration, trigger, and discover; clue_found additionally has prerequisite."
      : "scene_state_transition is not enabled by trusted policy.",
    "Every declaration evidence atom must root-exactly quote the complete trimmed root statement; heading evidence is scope only. Do not provide mechanismId, interpretationId, stateKey, location, when, effects, spec, onSuccess, onFailure, failback, custom/talk, or any runtime AST: the compiler derives runtime IDs, scope, guards, effects, and state.",
  ];
  return declarations.join(" ");
}

function validateBatchIdentity(queue: CompilerQuestionQueue, batch: CompilerHintProposalBatch): Record<string, unknown> {
  const input = batchRecord(batch);
  batchOnly(input);
  if (input.schemaVersion !== COMPILER_HINT_PROPOSAL_BATCH_SCHEMA_VERSION) throw new CompilerHintProposalError("schema_mismatch", "unsupported proposal batch schema");
  if (input.moduleId !== queue.moduleId || input.documentHash !== queue.documentHash || input.sourceGraphIdentity !== queue.sourceGraphIdentity || input.queueHash !== queue.queueHash) {
    throw new CompilerHintProposalError("identity_mismatch", "proposal batch does not match compiler question queue identity");
  }
  requiredBatchString(input.proposalId, "proposalId");
  if (!Array.isArray(input.proposals)) throw new CompilerHintProposalError("invalid_batch", "proposals must be an array");
  const proposedQuestionIds = new Set<string>();
  for (const value of input.proposals) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const questionId = (value as Record<string, unknown>).questionId;
    if (typeof questionId !== "string" || !questionId) continue;
    if (proposedQuestionIds.has(questionId)) throw new CompilerHintProposalError("duplicate_question_proposal", `multiple proposals for question: ${questionId}`);
    proposedQuestionIds.add(questionId);
    const question = queue.questions.find((candidate) => candidate.id === questionId);
    if (question?.status === "answered") throw new CompilerHintProposalError("conflicting_resolution", `proposal conflicts with an answered question: ${questionId}`);
  }
  return input;
}

function validateCitations(graph: SourceFactGraph, question: CompilerQuestion, value: unknown, expectedClaimKeys: string[]): CompilerHintCitation[] {
  if (!Array.isArray(value)) throw new ProposalValidationError("invalid_citations", "citations must be an array");
  const expected = new Set(expectedClaimKeys);
  const citedClaimKeys = new Set<string>();
  const statements = new Map(graph.statements.map((statement) => [statement.id, statement]));
  const citations: CompilerHintCitation[] = [];
  for (const rawCitation of value) {
    const citation = record(rawCitation, "citation");
    only(citation, ["claimKey", "statementId", "quote"], "invalid_citation", "citation");
    const claimKey = requiredString(citation.claimKey, "invalid_citation", "citation claimKey");
    if (!expected.has(claimKey)) throw new ProposalValidationError("unknown_claim_key", `citation claimKey is not declared by this proposal: ${claimKey}`);
    if (citedClaimKeys.has(claimKey)) throw new ProposalValidationError("duplicate_claim_key", `citation duplicates claimKey: ${claimKey}`);
    const statementId = requiredString(citation.statementId, "invalid_citation", "citation statementId");
    if (!question.sourceStatementIds.includes(statementId)) throw new ProposalValidationError("foreign_statement", `citation statement is outside question evidence: ${statementId}`);
    const quote = typeof citation.quote === "string" ? citation.quote : "";
    if (!quote.trim()) throw new ProposalValidationError("empty_quote", "citation quote must be non-empty");
    const statement = statements.get(statementId);
    if (!statement || (!statement.text.includes(quote) && !isExactClueFactAtomCitation(question, statementId, quote))) {
      throw new ProposalValidationError("hallucinated_quote", `citation quote is not verbatim source text: ${statementId}`);
    }
    citedClaimKeys.add(claimKey);
    citations.push({ claimKey, statementId, quote });
  }
  if (citedClaimKeys.size !== expected.size || expectedClaimKeys.some((claimKey) => !citedClaimKeys.has(claimKey))) {
    throw new ProposalValidationError("missing_claim_citation", "every declared claim requires one exact citation");
  }
  return citations;
}

function compileOneProposal(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  batch: CompilerHintProposalBatch,
  policy: TrustedCompilerHintProposalPolicy,
  rawProposal: unknown,
): CompilerQuestionResolution {
  const proposal = record(rawProposal, "proposal");
  only(proposal, ["questionId", "kind", "value", "citations"], "invalid_proposal", "proposal");
  const questionId = requiredString(proposal.questionId, "invalid_proposal", "proposal questionId");
  const question = queue.questions.find((candidate) => candidate.id === questionId);
  if (!question) throw new ProposalValidationError("unknown_question", `proposal references unknown question: ${questionId}`);
  const kind = requiredString(proposal.kind, "invalid_proposal", "proposal kind");
  if (kind !== question.kind) throw new ProposalValidationError("kind_mismatch", `proposal kind does not match question: ${questionId}`);
  if (question.status !== "open") throw new ProposalValidationError("question_not_open", `proposal cannot answer ${question.status} question: ${questionId}`);
  if (!isSupportedKind(question.kind)) throw new ProposalValidationError("unsupported_hint_kind", `unsupported_hint_kind: ${question.kind}`);
  if (isGenericProseDiscovery(question)) throw new ProposalValidationError("unsupported_generic_prose_discovery", `generic prose discovery has no clue/domain contract: ${questionId}`);
  if (question.kind === "source_fact_mechanic" && !sourceFactMechanicHasPlayableScene(graph, queue, question)) {
    throw new ProposalValidationError("source_fact_mechanic_requires_playable_scene", "source fact mechanic proposals require an answered playable owning scene");
  }
  if (question.kind === "npc_binding" && rawNpcBindingDeclaresEncounter(proposal.value) && policy.allowSourceExactNpcEncounters !== true) {
    throw new ProposalValidationError("automatic_npc_encounter_not_allowed", "automatic NPC encounters require the explicit trusted source-exact combat capability");
  }
  if (question.kind === "npc_binding") validateAutomaticNpcProseDialogueProposalValue(proposal.value);
  const parsed = parseCompilerHintValue(question, proposal.value, graph);
  const automaticNpcEncounter = parsed.kind === "npc_binding" && parsed.presentNpcs.some((npc) => npc.encounter !== undefined);
  if (automaticNpcEncounter && policy.allowSourceExactNpcEncounters !== true) {
    throw new ProposalValidationError("automatic_npc_encounter_not_allowed", "automatic NPC encounters require the explicit trusted source-exact combat capability");
  }
  if (automaticNpcEncounter && !policy.producer) {
    throw new ProposalValidationError("automatic_npc_encounter_requires_producer", "automatic NPC encounters require trusted producer provenance");
  }
  if (parsed.kind === "source_fact_mechanic") {
    const allowedKinds = new Set(allowedSourceFactMechanicKinds(policy));
    if (parsed.declarations.some((declaration) => !allowedKinds.has(declaration.kind))) {
      throw new ProposalValidationError("source_fact_mechanic_kind_not_allowed", "source fact mechanic declaration kind is not enabled by trusted policy");
    }
  }
  const automaticProseDialogue = parsed.kind === "npc_binding" && parsed.presentNpcs.some((npc) => npc.dialogueMethods.some((method) => method.kind === "prose"));
  if (parsed.kind === "npc_binding" && parsed.presentNpcs.length > 0 && !automaticNpcBindingHasPlayableScene(graph, queue, question)) {
    throw new ProposalValidationError("npc_binding_requires_playable_scene", "automatic non-empty NPC bindings require an answered playable scene role");
  }
  const automaticNpcAudit = automaticProseDialogue || automaticNpcEncounter;
  const automaticProseFactFinding = parsed.kind === "source_fact_mechanic" && parsed.declarations.some((declaration) => declaration.kind === "prose_fact_finding");
  let citations: CompilerHintCitation[];
  if (automaticProseFactFinding) {
    if (!Array.isArray(proposal.citations) || proposal.citations.length !== 0) {
      throw new ProposalValidationError("prose_fact_finding_citations_forbidden", "prose finding proposals select IDs only and must not submit citations or quotes");
    }
    citations = parsed.declarations.flatMap((declaration) => declaration.evidence.map((evidence) => ({ ...evidence })));
  } else {
    citations = validateCitations(graph, question, proposal.citations, automaticNpcAudit ? automaticNpcProseDialogueClaimKeys(parsed) : compilerHintClaimKeys(parsed));
  }
  if (automaticNpcAudit) validateAutomaticNpcProseDialogueCitationQuotes(graph, question, parsed, citations);
  else validateNpcBindingCitationQuote(graph, question, parsed, citations);
  validateItemBindingCitationQuote(graph, question, parsed, citations);
  validateRewardBindingCitationQuote(graph, question, parsed, citations);
  validateSourceFactDispositionCitationQuote(graph, question, parsed, citations);
  validateSourceFactMechanicCitationQuotes(graph, question, parsed, citations);
  validateClueFactFacetCitationQuotes(graph, question, parsed, citations);
  return {
    questionId: question.id,
    kind: question.kind,
    value: structuredClone(proposal.value),
    sourceStatementIds: [...question.sourceStatementIds],
    evidenceRefs: [...question.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "approved_policy",
    policyId: policy.policyId,
    rightsStatus: policy.rightsStatus,
    reason: `grounded proposal ${batch.proposalId} accepted by policy ${policy.policyId}`,
    audit: {
      kind: "compiler_hint_proposal",
      schemaVersion: automaticNpcEncounter
        ? COMPILER_HINT_PROPOSAL_AUDIT_NPC_ENCOUNTER_SCHEMA_VERSION
        : automaticProseDialogue
          ? COMPILER_HINT_PROPOSAL_AUDIT_NPC_PROSE_DIALOGUE_SCHEMA_VERSION
        : policy.producer ? COMPILER_HINT_PROPOSAL_AUDIT_PROVENANCE_SCHEMA_VERSION : COMPILER_HINT_PROPOSAL_AUDIT_SCHEMA_VERSION,
      proposalId: batch.proposalId,
      policyId: policy.policyId,
      citations: citations.map(cloneCitation),
      ...(policy.producer ? { producer: { ...policy.producer } } : {}),
    },
  };
}

/**
 * Convert untrusted, source-quoted proposals into validated partial ModuleCompileHints.
 * Batch identity and duplicate-question failures throw; ordinary proposal failures are
 * returned as diagnostics so valid independent proposals remain usable.
 */
export function compileGroundedHintProposals(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  batch: CompilerHintProposalBatch,
  policy: TrustedCompilerHintProposalPolicy,
): GroundedHintProposalResult {
  validateSourceFactGraph(graph);
  validateCompilerQuestionQueue(graph, queue);
  // Proposal parsing uses candidate IDs. Refuse a queue with foreign or opaque
  // domains before accepting even an otherwise valid proposal.
  buildCandidateCatalog(graph, queue);
  validateTrustedCompilerHintProposalPolicy(policy);
  const input = validateBatchIdentity(queue, batch);
  const proposals = input.proposals as unknown[];
  const accepted: AcceptedCompilerHintProposal[] = [];
  const rejected: CompilerHintProposalDiagnostic[] = [];
  for (const [proposalIndex, proposal] of proposals.entries()) {
    const questionId = proposal && typeof proposal === "object" && !Array.isArray(proposal) && typeof (proposal as Record<string, unknown>).questionId === "string"
      ? (proposal as Record<string, unknown>).questionId as string
      : undefined;
    try {
      const resolution = compileOneProposal(graph, queue, batch, policy, proposal);
      accepted.push({ proposalIndex, questionId: resolution.questionId, resolution });
    } catch (error) {
      rejected.push({ proposalIndex, ...(questionId ? { questionId } : {}), code: errorCode(error, "invalid_proposal"), message: error instanceof Error ? error.message : "proposal validation failed" });
    }
  }
  const hints: ModuleCompileHints = {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: accepted.map((entry) => structuredClone(entry.resolution)),
  };
  validateModuleCompileHints(queue, hints, graph);
  return { hints, accepted, rejected };
}

function requestQuestion(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  question: CompilerQuestion,
  policy?: TrustedCompilerHintProposalPolicy,
): CompilerHintProposalRequestQuestion {
  const sourceFactMechanicKinds = question.kind === "source_fact_mechanic" ? allowedSourceFactMechanicKinds(policy) : undefined;
  // This domain carries source text and a server-derived check solely so an
  // explicitly trusted proposer can tell opaque IDs apart.  It is not a
  // capability the requester can switch on by placing fields in its response.
  const proseFactFindingEnabled = sourceFactMechanicKinds?.includes("prose_fact_finding") === true;
  const npcEncounterProfiles = npcEncounterProfilesForRequest(graph, question, policy);
  const statements = new Map(graph.statements.map((statement) => [statement.id, statement]));
  const sourceStatements = question.sourceStatementIds.map((statementId) => {
    const statement = statements.get(statementId);
    if (!statement) throw new CompilerHintProposalError("missing_statement", `question source statement is missing: ${statementId}`);
    return { statementId, text: statement.text };
  });
  const allowed = question.status === "open"
    && isSupportedKind(question.kind)
    && !isGenericProseDiscovery(question)
    && (question.kind !== "source_fact_mechanic" || sourceFactMechanicHasPlayableScene(graph, queue, question))
    ? [question.kind] : [];
  return {
    questionId: question.id,
    kind: question.kind,
    prompt: sourceFactMechanicKinds ? sourceFactMechanicProposalPrompt(sourceFactMechanicKinds) : question.prompt,
    sourceStatements,
    ...(question.kind === "source_fact_mechanic" ? {
      sourceFactScope: {
        rootStatementId: question.subjectStatementId!,
        parentQuestionId: question.sourceFactParentQuestionId!,
        owningHeadingStatementId: question.owningHeadingStatementId!,
        owningSceneCandidateId: question.owningSceneCandidateId!,
      },
    } : {}),
    candidateDomains: {
      ...(question.candidateIds ? { candidateIds: [...question.candidateIds] } : {}),
      ...(question.subjectCandidateId ? { subjectCandidateId: question.subjectCandidateId } : {}),
      ...(question.allowedCandidateIds ? { allowedCandidateIds: [...question.allowedCandidateIds] } : {}),
      ...(question.allowedLocationCandidateIds ? { allowedLocationCandidateIds: [...question.allowedLocationCandidateIds] } : {}),
      ...(question.allowedMechanicsTargetIds ? { allowedMechanicsTargetIds: Object.fromEntries(Object.entries(question.allowedMechanicsTargetIds).map(([target, ids]) => [target, [...ids!]])) } : {}),
      ...(question.allowedItemNameEvidenceStatementIds ? { allowedItemNameEvidenceStatementIds: [...question.allowedItemNameEvidenceStatementIds] } : {}),
      ...(question.allowedRewardPredicateIds ? { allowedRewardPredicateIds: Object.fromEntries(Object.entries(question.allowedRewardPredicateIds).map(([target, ids]) => [target, [...ids!]])) } : {}),
      ...(question.allowedClueFactAtoms ? {
        allowedClueFactAtoms: question.allowedClueFactAtoms.map((atom) => ({ atomId: atom.id, quote: atom.quote, statementId: atom.bodyStatementId })),
      } : {}),
      ...(proseFactFindingEnabled && question.allowedSourceFactAtoms ? {
        allowedSourceFactAtoms: question.allowedSourceFactAtoms.map((atom) => ({ atomId: atom.id, quote: atom.quote, statementId: atom.statementId })),
      } : {}),
      ...(proseFactFindingEnabled && question.allowedProseFactFindingCandidates ? {
        allowedProseFactFindingCandidates: question.allowedProseFactFindingCandidates.map((candidate) => ({ candidateId: candidate.id, atomId: candidate.atomId, quote: candidate.quote, check: structuredClone(candidate.check) })),
      } : {}),
      ...(question.allowedDispositions ? { allowedDispositions: [...question.allowedDispositions] } : {}),
      ...(sourceFactMechanicKinds ? { allowedSourceFactMechanicKinds: sourceFactMechanicKinds } : {}),
      ...(npcEncounterProfiles ? {
        allowedNpcEncounterProfiles: npcEncounterProfiles.map((profile) => ({
          headingStatementId: profile.headingStatementId,
          ...(profile.requiredNameQuote === undefined ? {} : { requiredNameQuote: profile.requiredNameQuote }),
          statCandidates: Object.fromEntries(Object.entries(profile.statCandidates).map(([label, candidates]) => [label, candidates.map((candidate) => ({ ...candidate }))])) as AllowedNpcEncounterProfile["statCandidates"],
        })),
      } : {}),
    },
    allowedKinds: allowed,
  };
}

/** Build a deterministic external-request envelope without inferring or filling any answer. */
export function buildCompilerHintProposalRequestEnvelope(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  policy?: TrustedCompilerHintProposalPolicy,
): CompilerHintProposalRequestEnvelope {
  validateSourceFactGraph(graph);
  validateCompilerQuestionQueue(graph, queue);
  if (policy) validateTrustedCompilerHintProposalPolicy(policy);
  const questions = queue.questions.map((question) => requestQuestion(graph, queue, question, policy));
  return {
    schemaVersion: questions.some((question) => question.candidateDomains.allowedNpcEncounterProfiles?.length
      || question.candidateDomains.allowedProseFactFindingCandidates?.length)
      ? COMPILER_HINT_PROPOSAL_REQUEST_SCHEMA_VERSION
      : LEGACY_COMPILER_HINT_PROPOSAL_REQUEST_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    queueHash: queue.queueHash,
    candidateCatalog: buildCandidateCatalog(graph, queue),
    questions,
  };
}
