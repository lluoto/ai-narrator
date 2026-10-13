import { analyzeMechanicsReachability, type MechanicsAnalysisInput, type MechanicsReachabilityReport } from "./mechanics-reachability";
import { settleInitialMechanics } from "./mechanics-execution";
import { compileMechanics, type DiscoveryMethodSpec, type Effect, type MechanicsCandidateSpec, type MechanicsIR, type MechanicsSymbols, type Predicate, type RewardDefinitionSpec, type StateTransitionSpec } from "./mechanics-ir";
import { CompilerQuestionError, buildCompilerQuestionQueue, deriveNpcProseDialogueClueId, deriveSourceFactProseFindingClueId, npcEncounterEvidenceHeadingId, parseCompilerHintValue, replayModuleCompileHints, type CompilerQuestion, type CompilerQuestionQueue, type CompilerQuestionResolution, type ModuleCompileHints, type ParsedClueFactFindingMethod, type ParsedCompilerHintValue, type ParsedNpcEncounterBinding } from "./compiler-question-queue";
import { DRAFT_MODULE_STRUCTURE_SCHEMA_VERSION, compileDeterministicTemplates, type DraftModuleStructure, type DraftReadinessReport } from "./deterministic-template-compiler";
import { validateSourceFactGraph, type FactInterpretationCandidate, type SourceFactGraph } from "./source-fact-graph";
import { sha256 } from "../ingest/document-ir";

export { parseCompilerHintValue } from "./compiler-question-queue";

export interface ResolvedDraftModule {
  resolvedQueue: CompilerQuestionQueue;
  acceptedInterpretations: FactInterpretationCandidate<MechanicsCandidateSpec>[];
  mechanicsIR?: MechanicsIR;
  analysisInput?: MechanicsAnalysisInput;
  reachabilityReport?: MechanicsReachabilityReport;
  readiness: DraftReadinessReport;
  substitutedEnginePolicyInterpretationIds: string[];
  /** Reviewed prose NPC presence; its identity is a closed-world MechanicsIR symbol. */
  proseNpcBindings: ResolvedProseNpcBinding[];
  /** Human-reviewed relationship facts elevated into independent dialogue clue identities. */
  proseDialogueClues: ResolvedProseDialogueClue[];
  /** Runtime item identities permitted by explicit source-bound answers only. */
  itemBindings: ResolvedItemBinding[];
  /** Each table-row reward remains source evidence even when explicitly unbound. */
  rewardBindings: ResolvedRewardBinding[];
  /** Typed mechanics elevated from answered source-fact children only. */
  sourceFactMechanicBindings: ResolvedSourceFactMechanicBinding[];
  /** Source-exact shell/finding partitions for structural marked clues. */
  clueFactFacetBindings: ResolvedClueFactFacetBinding[];
}

export interface ResolvedClueFactAtomBinding {
  atomId: string;
  quote: string;
  evidence: import("../ingest/document-ir").EvidenceRef;
}

export interface ResolvedClueFactFindingMethod extends Pick<ParsedClueFactFindingMethod, "declarationKey" | "mechanismId" | "action" | "target" | "check" | "spec"> {
  failback?: { maxFailures: number };
}

export interface ResolvedClueFactFinding {
  findingKey: string;
  clueId: string;
  atoms: ResolvedClueFactAtomBinding[];
  methods: ResolvedClueFactFindingMethod[];
}

/** The original marked-clue ID remains the shell identity; children are derived findings. */
export interface ResolvedClueFactFacetBinding {
  questionId: string;
  clueId: string;
  markedItemStatementId: string;
  nameStatementId: string;
  bodyStatementId: string;
  headingStatementId: string;
  sceneCandidateId: string;
  shellAtoms: ResolvedClueFactAtomBinding[];
  findings: ResolvedClueFactFinding[];
  sourceOnlyAtomIds: string[];
}

export interface ResolvedProseNpcBinding {
  questionId: string;
  proseAnchorId: string;
  claimKey: string;
  npcId: string;
  nameQuote: string;
  paragraphStatementId: string;
  headingStatementId: string;
  sceneCandidateId: string;
  dialogueMethods: ResolvedNpcDialogueMethod[];
  /** Present only when the reviewed binding declares a source-evidenced encounter. */
  encounter?: ResolvedNpcEncounterBinding;
}

export interface ResolvedNpcEncounterBinding extends ParsedNpcEncounterBinding {
  /** Exact source evidence retained for projection and artifact re-resolution. */
  sourceStatementIds: string[];
  /** Automatic audit claim keys, retained only when approved policy selected this encounter. */
  auditClaimKeys?: {
    trigger: string;
    maxHp: string;
    dodge: string;
    fight: string;
    npcDamage: string;
  };
}

export interface ResolvedNpcDialogueMethod {
  kind: "marked_item" | "prose";
  /** Automatic audit claim key for this independently derived prose relationship fact. */
  claimKey?: string;
  mechanismId: string;
  clueId: string;
  /** Present only when the dialogue reveals an existing same-heading marked clue. */
  markedItemStatementId?: string;
  nameStatementId?: string;
  bodyStatementId?: string;
  /** Present only for an independently derived prose dialogue clue. */
  relationshipStatementId?: string;
  relationshipQuote?: string;
  spec: DiscoveryMethodSpec;
}

/**
 * A runtime clue derived from one source-exact NPC relationship fact.  This
 * deliberately does not impersonate a DraftModuleStructure marked-item clue.
 */
export interface ResolvedProseDialogueClue {
  questionId: string;
  claimKey: string;
  proseAnchorId: string;
  npcId: string;
  mechanismId: string;
  clueId: string;
  paragraphStatementId: string;
  headingStatementId: string;
  sceneCandidateId: string;
  relationshipStatementId: string;
  relationshipQuote: string;
}

export interface ResolvedItemBinding {
  questionId: string;
  itemCandidateId: string;
  /** The runtime MechanicsIR item symbol is the reviewed candidate identity. */
  itemId: string;
  claimKey: string;
  itemType: "key" | "document" | "loot";
  /** Exact source child and quote selected by the accepted positive item binding. */
  itemNameStatementId: string;
  itemNameQuote: string;
  markedItemStatementId: string;
  nameStatementId: string;
  bodyStatementId: string;
  headingStatementId: string;
  sceneCandidateId: string;
}

export interface ResolvedRewardBinding {
  questionId: string;
  rewardCandidateId: string;
  tableRowStatementId: string;
  headingStatementId: string;
  claimKey: string;
  declaration: null | Omit<RewardDefinitionSpec, "kind" | "id">;
}

interface ResolvedSourceFactMechanicBindingBase {
  questionId: string;
  parentQuestionId: string;
  statementId: string;
  headingStatementId: string;
  sceneCandidateId: string;
  declarationKey: string;
  mechanismId: string;
  interpretationId: string;
  evidence: Array<{ claimKey: string; statementId: string; quote: string }>;
}

export interface ResolvedExistingClueSourceFactMechanicBinding extends ResolvedSourceFactMechanicBindingBase {
  declarationKind: "existing_clue_discovery";
  clueId: string;
  spec: DiscoveryMethodSpec;
}

/** A source-root atom elevated into one compiler-owned optional clue. */
export interface ResolvedProseFactFindingSourceFactMechanicBinding extends ResolvedSourceFactMechanicBindingBase {
  declarationKind: "prose_fact_finding";
  candidateId: string;
  atomId: string;
  clueId: string;
  quote: string;
  check: import("./mechanics-ir").CheckSpec;
  sourceOnlyAtomIds: string[];
  spec: DiscoveryMethodSpec;
}

export interface ResolvedSceneStateTransitionSourceFactMechanicBinding extends ResolvedSourceFactMechanicBindingBase {
  declarationKind: "scene_state_transition";
  stateKey: string;
  trigger: { kind: "scene_enter" } | { kind: "clue_found"; clueId: string };
  discoverClueId: string;
  spec: StateTransitionSpec;
}

/** The persisted binding retains the exact typed source declaration shape. */
export type ResolvedSourceFactMechanicBinding = ResolvedExistingClueSourceFactMechanicBinding | ResolvedProseFactFindingSourceFactMechanicBinding | ResolvedSceneStateTransitionSourceFactMechanicBinding;

function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values)].sort(); }

/** First-slice prose findings have one canonical EDU check; compare fields,
 * not serialized object insertion order from restored JSON. */
function sameProseFactFindingCheck(
  left: import("./mechanics-ir").CheckSpec | undefined,
  right: import("./mechanics-ir").CheckSpec | undefined,
): boolean {
  return left?.kind === "attribute" && right?.kind === "attribute"
    && left.attribute === "edu" && right.attribute === "edu"
    && left.difficulty === "regular" && right.difficulty === "regular";
}

/** Preserve validated automatic audit atom identity into resolved bindings. */
function auditedNpcClaimKey(
  resolution: CompilerQuestionResolution,
  proseAnchorId: string,
  npcIndex: number,
  suffix: string,
): string | undefined {
  const claimKey = `npc_binding:${proseAnchorId}:${npcIndex}:${suffix}`;
  return resolution.audit?.citations.some((citation) => citation.claimKey === claimKey) ? claimKey : undefined;
}

function sameDraftItemCandidate(
  left: DraftModuleStructure["itemCandidates"][number],
  right: DraftModuleStructure["itemCandidates"][number],
): boolean {
  return left.id === right.id
    && left.markedItemStatementId === right.markedItemStatementId
    && left.nameStatementId === right.nameStatementId
    && left.bodyStatementId === right.bodyStatementId
    && left.sceneCandidateId === right.sceneCandidateId
    && left.displayName === right.displayName
    && left.status === right.status
    && JSON.stringify(left.evidence) === JSON.stringify(right.evidence);
}

/** Canonical draft comparison makes deleted, renamed, or rebased item candidates publish-blocking. */
function invalidDraftItemCandidateIds(draft: DraftModuleStructure, canonical: DraftModuleStructure): string[] {
  const canonicalById = new Map(canonical.itemCandidates.map((candidate) => [candidate.id, candidate]));
  const invalid = draft.itemCandidates
    .filter((candidate) => !canonicalById.has(candidate.id) || !sameDraftItemCandidate(candidate, canonicalById.get(candidate.id)!))
    .map((candidate) => `draft:${candidate.id}`);
  for (const candidate of canonical.itemCandidates) {
    const drafted = draft.itemCandidates.find((entry) => entry.id === candidate.id);
    if (!drafted || !sameDraftItemCandidate(drafted, candidate)) invalid.push(`canonical:${candidate.id}`);
  }
  return uniqueSorted(invalid);
}

function sameDraftRewardCandidate(
  left: DraftModuleStructure["rewardCandidates"][number],
  right: DraftModuleStructure["rewardCandidates"][number],
): boolean {
  return left.id === right.id && left.tableRowStatementId === right.tableRowStatementId
    && left.headingStatementId === right.headingStatementId && left.status === right.status
    && JSON.stringify(left.evidence) === JSON.stringify(right.evidence);
}

function invalidDraftRewardCandidateIds(draft: DraftModuleStructure, canonical: DraftModuleStructure): string[] {
  const canonicalById = new Map(canonical.rewardCandidates.map((candidate) => [candidate.id, candidate]));
  const invalid = draft.rewardCandidates
    .filter((candidate) => !canonicalById.has(candidate.id) || !sameDraftRewardCandidate(candidate, canonicalById.get(candidate.id)!))
    .map((candidate) => `draft:${candidate.id}`);
  for (const candidate of canonical.rewardCandidates) {
    const drafted = draft.rewardCandidates.find((entry) => entry.id === candidate.id);
    if (!drafted || !sameDraftRewardCandidate(drafted, candidate)) invalid.push(`canonical:${candidate.id}`);
  }
  return uniqueSorted(invalid);
}

/**
 * These domains are persisted prepared-artifact input, not a cache the
 * resolver may repair.  Keep their comparison independent of object key
 * insertion order while retaining every identity, quote, check, and exact
 * evidence field that a child queue can expose.
 */
function canonicalSourceFactDraftDomains(draft: DraftModuleStructure): string {
  return JSON.stringify({
    atoms: draft.sourceFactAtoms.map((atom) => ({
      id: atom.id,
      statementId: atom.statementId,
      quote: atom.quote,
      status: atom.status,
      evidence: {
        precision: atom.evidence.precision,
        spans: atom.evidence.spans.map((span) => ({
          documentHash: span.documentHash,
          pageNumber: span.pageNumber,
          rawStart: span.rawStart,
          rawEnd: span.rawEnd,
          exactText: span.exactText,
          textHash: span.textHash,
        })),
      },
    })).sort((left, right) => left.id.localeCompare(right.id)),
    candidates: draft.proseFactFindingCandidates.map((candidate) => ({
      id: candidate.id,
      statementId: candidate.statementId,
      atomId: candidate.atomId,
      quote: candidate.quote,
      check: {
        kind: candidate.check.kind,
        ...(candidate.check.kind === "attribute" ? { attribute: candidate.check.attribute, difficulty: candidate.check.difficulty } : {}),
      },
      status: candidate.status,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function itemIdsInPredicate(predicate: Predicate | undefined): string[] {
  if (!predicate) return [];
  switch (predicate.kind) {
    case "item_owned": return [predicate.itemId];
    case "all":
    case "any": return predicate.predicates.flatMap(itemIdsInPredicate);
    case "not": return itemIdsInPredicate(predicate.predicate);
    default: return [];
  }
}

function itemIdsInEffects(effects: readonly Effect[] | undefined): string[] {
  return (effects ?? []).flatMap((effect) => effect.kind === "acquire_item" ? [effect.itemId] : []);
}

/** All item references are checked against answered bindings before IR compilation. */
function collectItemReferences(spec: MechanicsCandidateSpec): string[] {
  switch (spec.kind) {
    case "discovery_method": return [
      ...(spec.target === "item" ? [spec.targetId] : []),
      ...itemIdsInPredicate(spec.availability),
      ...itemIdsInEffects(spec.onSuccess),
      ...itemIdsInEffects(spec.onFailure),
      ...itemIdsInEffects(spec.failback?.effects),
    ];
    case "connection_gate": return [...itemIdsInPredicate(spec.availability), ...itemIdsInEffects(spec.onTraverse)];
    case "state_transition": return [...itemIdsInPredicate(spec.when), ...itemIdsInEffects(spec.effects)];
    case "ending_rule": return [...itemIdsInPredicate(spec.when), ...itemIdsInEffects(spec.effects)];
    /** Encounter definitions are not synthesized from hints, but accepted source candidates pass through unchanged. */
    case "encounter_definition": return itemIdsInEffects(spec.victoryEffects);
    case "reward_definition": return itemIdsInPredicate(spec.when);
  }
}

export function applyModuleCompileHints(graph: SourceFactGraph, queue: CompilerQuestionQueue, hints: ModuleCompileHints): CompilerQuestionQueue {
  return replayModuleCompileHints(graph, queue, hints);
}

function interpretation(question: CompilerQuestion, resolution: CompilerQuestionResolution, spec: MechanicsCandidateSpec, suffix: string): FactInterpretationCandidate<MechanicsCandidateSpec> {
  const id = `hint:${question.id}:${suffix}`;
  return {
    id,
    sourceStatementIds: [...question.sourceStatementIds],
    claim: {
      path: `mechanics.${spec.kind}.${spec.id}`,
      value: spec,
      domain: "gameplay_mechanic",
      authority: resolution.authority,
      derivation: resolution.derivation,
      status: "accepted",
      evidenceRefs: [...question.evidenceRefs],
      sourceRef: null,
      confidence: null,
      reason: resolution.reason,
      rightsStatus: resolution.rightsStatus,
      scope: { moduleId: "" },
    },
    interpretationStatus: "accepted",
    review: {
      interpretationId: id,
      decision: "accept",
      reason: resolution.reason,
      reviewerKind: resolution.reviewerKind,
      ...(resolution.policyId ? { policyId: resolution.policyId } : {}),
      reviewEvidenceStatementIds: [...question.sourceStatementIds],
    },
  };
}

/**
 * Dialogue evidence is intentionally narrower than its question envelope:
 * one NPC paragraph and heading, plus the selected marked clue and its exact
 * name/body children.  Candidate alternatives never leak into an accepted
 * mechanics interpretation.
 */
function interpretationFromExactEvidence(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  resolution: CompilerQuestionResolution,
  spec: MechanicsCandidateSpec,
  suffix: string,
  sourceStatementIds: string[],
): FactInterpretationCandidate<MechanicsCandidateSpec> {
  const sourceIds = uniqueSorted(sourceStatementIds);
  if (!sourceIds.every((id) => question.sourceStatementIds.includes(id))) throw new CompilerQuestionError("invalid_npc_dialogue_evidence", "dialogue interpretation escapes its reviewed question evidence");
  const evidenceRefs = sourceIds.map((id) => {
    const statement = graph.statements.find((candidate) => candidate.id === id);
    if (!statement) throw new CompilerQuestionError("invalid_npc_dialogue_evidence", `dialogue interpretation references missing source statement: ${id}`);
    return statement.evidenceRefId;
  });
  const id = `hint:${question.id}:${suffix}`;
  return {
    id,
    sourceStatementIds: sourceIds,
    claim: {
      path: `mechanics.${spec.kind}.${spec.id}`,
      value: spec,
      domain: "gameplay_mechanic",
      authority: resolution.authority,
      derivation: resolution.derivation,
      status: "accepted",
      evidenceRefs,
      sourceRef: null,
      confidence: null,
      reason: resolution.reason,
      rightsStatus: resolution.rightsStatus,
      scope: { moduleId: "" },
    },
    interpretationStatus: "accepted",
    review: {
      interpretationId: id,
      decision: "accept",
      reason: resolution.reason,
      reviewerKind: resolution.reviewerKind,
      ...(resolution.policyId ? { policyId: resolution.policyId } : {}),
      reviewEvidenceStatementIds: sourceIds,
    },
  };
}

function withModuleScope(moduleId: string, candidate: FactInterpretationCandidate<MechanicsCandidateSpec>): FactInterpretationCandidate<MechanicsCandidateSpec> {
  return { ...candidate, sourceStatementIds: [...candidate.sourceStatementIds], claim: { ...candidate.claim, evidenceRefs: [...candidate.claim.evidenceRefs], scope: { moduleId } }, review: candidate.review && { ...candidate.review, reviewEvidenceStatementIds: [...candidate.review.reviewEvidenceStatementIds!] } };
}

function sourceFactMechanicInterpretation(
  graph: SourceFactGraph,
  moduleId: string,
  question: CompilerQuestion,
  resolution: CompilerQuestionResolution,
  binding: ResolvedSourceFactMechanicBinding,
): FactInterpretationCandidate<MechanicsCandidateSpec> {
  const sourceStatementIds = uniqueSorted([binding.statementId, binding.headingStatementId]);
  const root = graph.statements.find((statement) => statement.id === binding.statementId);
  const expectedQuote = binding.declarationKind === "prose_fact_finding" ? binding.quote : root?.text.trim();
  if (!root || sourceStatementIds.some((id) => !question.sourceStatementIds.includes(id))
    || binding.evidence.length === 0
    || binding.evidence.some((evidence) => evidence.statementId !== root.id || evidence.quote !== expectedQuote)) {
    throw new CompilerQuestionError("invalid_source_fact_evidence", `source fact mechanic interpretation lacks exact root evidence: ${binding.questionId}`);
  }
  if (binding.declarationKind === "prose_fact_finding") {
    const candidate = question.allowedProseFactFindingCandidates?.find((entry) => entry.id === binding.candidateId);
    const atom = question.allowedSourceFactAtoms?.find((entry) => entry.id === binding.atomId);
    const expectedClueId = candidate && deriveSourceFactProseFindingClueId(graph, question.id, candidate.id);
    if (!candidate || !atom || candidate.atomId !== atom.id || candidate.quote !== binding.quote
      || binding.clueId !== expectedClueId || !sameProseFactFindingCheck(candidate.check, binding.check)
      || binding.spec.id !== binding.mechanismId || binding.spec.clueId !== binding.clueId
      || binding.spec.action !== "search" || binding.spec.target !== "scene" || binding.spec.targetId !== binding.sceneCandidateId
      || !sameProseFactFindingCheck(binding.spec.check, binding.check)
      || binding.spec.onSuccess.length !== 1 || binding.spec.onSuccess[0]?.kind !== "discover_clue"
      || binding.spec.onSuccess[0]?.clueId !== binding.clueId || binding.spec.onFailure || binding.spec.failback
      || binding.evidence.length !== 1 || binding.evidence[0]?.claimKey !== `source_fact_mechanic:${root.id}:${binding.candidateId}:finding`
      || new Set(binding.sourceOnlyAtomIds).size !== binding.sourceOnlyAtomIds.length
      || [...binding.sourceOnlyAtomIds, binding.atomId].sort().join("|") !== question.allowedSourceFactAtoms!.map((entry) => entry.id).sort().join("|")) {
      throw new CompilerQuestionError("invalid_source_fact_evidence", `prose finding binding escapes its prepared atom domain: ${binding.questionId}`);
    }
  }
  const evidenceRefs = sourceStatementIds.map((id) => graph.statements.find((statement) => statement.id === id)?.evidenceRefId);
  if (evidenceRefs.some((id): id is undefined => id === undefined)) throw new CompilerQuestionError("invalid_source_fact_evidence", `source fact mechanic source is missing: ${binding.questionId}`);
  return {
    id: binding.interpretationId,
    sourceStatementIds,
    claim: {
      path: `mechanics.${binding.spec.kind}.${binding.mechanismId}`,
      value: structuredClone(binding.spec),
      domain: "gameplay_mechanic",
      authority: resolution.authority,
      derivation: resolution.derivation,
      status: "accepted",
      evidenceRefs: evidenceRefs as string[],
      sourceRef: null,
      confidence: null,
      reason: resolution.reason,
      rightsStatus: resolution.rightsStatus,
      scope: { moduleId },
    },
    interpretationStatus: "accepted",
    review: {
      interpretationId: binding.interpretationId,
      decision: "accept",
      reason: resolution.reason,
      reviewerKind: resolution.reviewerKind,
      ...(resolution.policyId ? { policyId: resolution.policyId } : {}),
      reviewEvidenceStatementIds: sourceStatementIds,
    },
  };
}


function mechanismIds(ir: MechanicsIR): string[] { return [...ir.discoveryMethods, ...ir.connections, ...ir.transitions, ...ir.endings, ...ir.encounterDefinitions].map((node) => node.id).sort(); }

function deriveReadiness(draft: DraftModuleStructure, queue: CompilerQuestionQueue, status: DraftReadinessReport["status"], generatedMechanicIds: string[], extraBlockingCodes: string[] = []): DraftReadinessReport {
  const open = queue.questions.filter((question) => question.status === "open").map((question) => question.id).sort();
  const publishBlocking = queue.questions.filter((question) => question.severity === "publish_blocking" && question.status !== "answered").map((question) => question.id).sort();
  const blockingCodes = queue.questions.filter((question) => question.severity === "publish_blocking" && question.status !== "answered").map((question) => question.blockingCode);
  return {
    status,
    blockingCodes: uniqueSorted([...blockingCodes, ...extraBlockingCodes]),
    unresolvedStatementIds: [...draft.readiness.unresolvedStatementIds].sort(),
    generatedMechanicIds: uniqueSorted(generatedMechanicIds),
    questionQueueHash: queue.queueHash,
    openQuestionIds: open,
    publishBlockingQuestionIds: publishBlocking,
  };
}

function assertDraftIdentity(graph: SourceFactGraph, draft: DraftModuleStructure, queue: CompilerQuestionQueue): void {
  if (draft.schemaVersion !== DRAFT_MODULE_STRUCTURE_SCHEMA_VERSION) {
    throw new CompilerQuestionError("schema_mismatch", "unsupported draft module structure schema");
  }
  if (!draft.moduleId.trim() || queue.moduleId !== draft.moduleId) throw new CompilerQuestionError("draft_queue_module_mismatch", "draft and queue module identities do not match");
  if (draft.documentHash !== graph.documentIdentity.documentHash || draft.sourceGraphIdentity !== queue.sourceGraphIdentity) throw new CompilerQuestionError("draft_queue_identity_mismatch", "draft and queue source identities do not match");
  const generated = buildCompilerQuestionQueue(graph, draft);
  if (queue.queueHash !== draft.readiness.questionQueueHash || queue.queueHash !== generated.queueHash) throw new CompilerQuestionError("draft_queue_semantic_mismatch", "draft and queue semantics do not match");
}

interface DefaultDiscoveryBinding { interpretationId: string; methodId: string; clueId: string; locationSceneId: string; }

/**
 * Default observation is located by the marked item's graph heading scope.
 * Its mechanics target is independently validated and never supplies location.
 */
function defaultDiscoveryBinding(graph: SourceFactGraph, draft: DraftModuleStructure, canonical: DraftModuleStructure, candidate: FactInterpretationCandidate<MechanicsCandidateSpec>): DefaultDiscoveryBinding | undefined {
  if (candidate.claim.authority !== "engine_policy") return undefined;
  const spec = candidate.claim.value;
  if (!spec || spec.kind !== "discovery_method") return undefined;
  const clue = draft.clueCandidates.find((entry) => entry.id === spec.clueId);
  if (!clue) return undefined;
  const scene = draft.sceneCandidates.find((entry) => entry.id === clue.sceneCandidateId);
  if (!scene || candidate.claim.scope.moduleId !== draft.moduleId || spec.target !== "scene" || spec.targetId !== scene.id) return undefined;
  const originalClue = canonical.clueCandidates.find((entry) => entry.markedItemStatementId === clue.markedItemStatementId);
  const originalScene = canonical.sceneCandidates.find((entry) => entry.id === scene.id);
  const originalPolicy = canonical.interpretations.find((entry) => entry.id === candidate.id);
  const originalSpec = originalPolicy?.claim.value;
  if (!originalSpec || originalSpec.kind !== "discovery_method" || !originalClue || originalClue.id !== clue.id || originalClue.nameStatementId !== clue.nameStatementId || originalClue.bodyStatementId !== clue.bodyStatementId || originalClue.sceneCandidateId !== scene.id || originalScene?.headingStatementId !== scene.headingStatementId || originalSpec.id !== spec.id || originalSpec.clueId !== clue.id) return undefined;
  const scoped = graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === scene.headingStatementId && relation.to === clue.markedItemStatementId);
  const heading = graph.statements.find((statement) => statement.id === scene.headingStatementId);
  const marked = graph.statements.find((statement) => statement.id === clue.markedItemStatementId);
  const children = [[clue.nameStatementId, "marked_item_name"], [clue.bodyStatementId, "marked_item_body"]] as const;
  if (heading?.kind !== "heading" || marked?.kind !== "marked_item" || marked.parentStatementId !== heading.id || !children.every(([id, kind]) => {
    const statement = graph.statements.find((statement) => statement.id === id);
    return statement?.kind === kind && statement.parentStatementId === marked.id && graph.relations.some((relation) => relation.kind === kind && relation.from === marked.id && relation.to === id);
  })) return undefined;
  const requiredStatements = [scene.headingStatementId, clue.markedItemStatementId, clue.bodyStatementId, clue.nameStatementId].filter((id): id is string => Boolean(id));
  const requiredEvidence = requiredStatements.map((id) => graph.statements.find((statement) => statement.id === id)?.evidenceRefId).filter((id): id is string => Boolean(id));
  if (!scoped || !requiredStatements.every((id) => candidate.sourceStatementIds.includes(id) && candidate.review?.reviewEvidenceStatementIds?.includes(id)) || !requiredEvidence.every((id) => candidate.claim.evidenceRefs.includes(id))) return undefined;
  return { interpretationId: candidate.id, methodId: spec.id, clueId: clue.id, locationSceneId: scene.id };
}

export function resolveDraftModule(graph: SourceFactGraph, draft: DraftModuleStructure, queue: CompilerQuestionQueue, hints: ModuleCompileHints): ResolvedDraftModule {
  validateSourceFactGraph(graph);
  assertDraftIdentity(graph, draft, queue);
  // Audit original candidates before replacement, without replacement-only symbols or claims.
  const draftGraph = { ...graph, interpretations: draft.interpretations };
  validateSourceFactGraph(draftGraph);
  const canonical = compileDeterministicTemplates(graph, { moduleId: draft.moduleId });
  if (canonicalSourceFactDraftDomains(draft) !== canonicalSourceFactDraftDomains(canonical)) {
    throw new CompilerQuestionError("draft_source_fact_domains_mismatch", "draft prose-fact atom or finding domains do not match canonical source derivation");
  }
  const invalidItemCandidateIds = invalidDraftItemCandidateIds(draft, canonical);
  const invalidRewardCandidateIds = invalidDraftRewardCandidateIds(draft, canonical);
  const originalSymbols: MechanicsSymbols = {
    clueIds: canonical.clueCandidates.map((clue) => clue.id), sceneIds: canonical.sceneCandidates.map((scene) => scene.id),
    itemIds: [], npcIds: [], connectionIds: [], encounterIds: [], endingIds: [], rewardIds: [], declaredStateKeys: [],
  };
  for (const candidate of draft.interpretations) {
    if (candidate.claim.authority === "engine_policy") compileMechanics({ ...draftGraph, interpretations: [candidate] }, {
      moduleId: draft.moduleId, documentHash: draft.documentHash, sourceGraphSchemaVersion: graph.schemaVersion,
      symbols: originalSymbols, acceptedInterpretationIds: [candidate.id], compilationMode: "compatible", allowedEnginePolicyIds: ["marked-item-observation-v1"],
    });
  }
  const resolvedQueue = applyModuleCompileHints(graph, queue, hints);
  const answered = resolvedQueue.questions
    .filter((question) => question.status === "answered" && question.resolution)
    .map((question) => ({ question, resolution: question.resolution!, value: parseCompilerHintValue(question, question.resolution!.value, graph) }));
  const playable = new Set(answered.filter((entry) => entry.value.kind === "scene_role" && entry.value.role === "playable_scene").map((entry) => entry.question.subjectCandidateId).filter((id): id is string => id !== undefined));
  const entry = answered.find((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "entry_scene" }> } => entry.value.kind === "entry_scene")?.value;
  const topology = answered.filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "connection_topology" }> } => entry.value.kind === "connection_topology").flatMap((entry) => entry.value.connections);
  const core = answered.filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "core_clue" }> } => entry.value.kind === "core_clue" && entry.value.required).map((entry) => entry.value.clueId);
  const endingDeclarations = answered.filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "ending_rule" }> } => entry.value.kind === "ending_rule").flatMap((entry) => entry.value.declarations.map((declaration) => ({ ...declaration, question: entry.question, resolution: entry.resolution })));
  const discoveries = answered.filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "discovery_method" }> } => entry.value.kind === "discovery_method");
  const clueFactFacetBindings: ResolvedClueFactFacetBinding[] = answered
    .filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "clue_fact_facets" }> } => entry.value.kind === "clue_fact_facets")
    .map((entry) => {
      const clue = draft.clueCandidates.find((candidate) => candidate.id === entry.value.clueId);
      const scene = clue && draft.sceneCandidates.find((candidate) => candidate.id === clue.sceneCandidateId);
      const offeredAtoms = entry.question.allowedClueFactAtoms;
      const offered = new Map(offeredAtoms?.map((atom) => [atom.id, atom]) ?? []);
      if (!clue || !scene || entry.question.owningHeadingStatementId !== scene.headingStatementId
        || entry.question.owningSceneCandidateId !== scene.id || !offered.size) {
        throw new CompilerQuestionError("invalid_clue_fact_partition", `clue fact binding lacks a canonical clue atom domain: ${entry.question.id}`);
      }
      const atomSourceOrder = new Map((offeredAtoms ?? []).map((atom, index) => [atom.id, index]));
      const bindAtoms = (atoms: Array<{ atomId: string; quote: string }>): ResolvedClueFactAtomBinding[] => atoms.map((atom) => {
        const offeredAtom = offered.get(atom.atomId);
        if (!offeredAtom || offeredAtom.quote !== atom.quote || offeredAtom.clueCandidateId !== clue.id || offeredAtom.bodyStatementId !== clue.bodyStatementId) {
          throw new CompilerQuestionError("invalid_clue_fact_partition", `clue fact binding escapes its prepared atom domain: ${entry.question.id}`);
        }
        return { atomId: offeredAtom.id, quote: offeredAtom.quote, evidence: structuredClone(offeredAtom.evidence) };
      }).sort((left, right) => atomSourceOrder.get(left.atomId)! - atomSourceOrder.get(right.atomId)!);
      return {
        questionId: entry.question.id,
        clueId: clue.id,
        markedItemStatementId: clue.markedItemStatementId,
        nameStatementId: clue.nameStatementId!,
        bodyStatementId: clue.bodyStatementId,
        headingStatementId: scene.headingStatementId,
        sceneCandidateId: scene.id,
        shellAtoms: bindAtoms(entry.value.shellAtoms),
        findings: entry.value.findings.map((finding) => ({
          findingKey: finding.findingKey,
          clueId: finding.clueId,
          atoms: bindAtoms(finding.atoms),
          methods: finding.methods.map((method) => ({
            declarationKey: method.declarationKey,
            mechanismId: method.mechanismId,
            action: method.action,
            target: method.target,
            check: structuredClone(method.check),
            ...(method.failback ? { failback: { ...method.failback } } : {}),
            spec: structuredClone(method.spec),
          })),
        })).sort((left, right) => left.clueId.localeCompare(right.clueId)),
        sourceOnlyAtomIds: [...entry.value.sourceOnlyAtomIds].sort(),
      };
    })
    .sort((left, right) => left.clueId.localeCompare(right.clueId));
  const proseNpcBindings: ResolvedProseNpcBinding[] = answered
    .filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "npc_binding" }> } => entry.value.kind === "npc_binding")
    .flatMap((entry) => {
      const anchor = draft.proseNpcAnchors.find((candidate) => candidate.id === entry.value.proseAnchorId);
      if (!anchor) throw new Error("npc_binding_anchor_missing");
      return entry.value.presentNpcs.map((npc, index) => {
        const nameClaimKey = auditedNpcClaimKey(entry.resolution, anchor.id, index, "name");
        const profileHeadingId = npc.encounter
          ? npcEncounterEvidenceHeadingId(graph, entry.question, npc.nameQuote, npc.encounter.statEvidence)
          : undefined;
        return {
          questionId: entry.question.id,
          proseAnchorId: anchor.id,
          claimKey: nameClaimKey ?? `npc_binding:${anchor.id}:${index}`,
          npcId: npc.npcId,
          nameQuote: npc.nameQuote,
          paragraphStatementId: anchor.paragraphStatementId,
          headingStatementId: anchor.headingStatementId,
          sceneCandidateId: anchor.sceneCandidateId,
          ...(npc.encounter ? {
            encounter: {
              ...structuredClone(npc.encounter),
              sourceStatementIds: uniqueSorted([
                anchor.headingStatementId,
                anchor.paragraphStatementId,
                profileHeadingId!,
                npc.encounter.statEvidence.maxHp.statementId,
                npc.encounter.statEvidence.dodge.statementId,
                npc.encounter.statEvidence.fight.statementId,
                npc.encounter.statEvidence.npcDamage.statementId,
                ...npc.encounter.victoryEffectEvidence.flatMap((effect) => effect.sourceStatementIds),
              ]),
              ...(auditedNpcClaimKey(entry.resolution, anchor.id, index, "encounter:trigger")
                && auditedNpcClaimKey(entry.resolution, anchor.id, index, "encounter:maxHp")
                && auditedNpcClaimKey(entry.resolution, anchor.id, index, "encounter:dodge")
                && auditedNpcClaimKey(entry.resolution, anchor.id, index, "encounter:fight")
                && auditedNpcClaimKey(entry.resolution, anchor.id, index, "encounter:npcDamage") ? {
                auditClaimKeys: {
                  trigger: `npc_binding:${anchor.id}:${index}:encounter:trigger`,
                  maxHp: `npc_binding:${anchor.id}:${index}:encounter:maxHp`,
                  dodge: `npc_binding:${anchor.id}:${index}:encounter:dodge`,
                  fight: `npc_binding:${anchor.id}:${index}:encounter:fight`,
                  npcDamage: `npc_binding:${anchor.id}:${index}:encounter:npcDamage`,
                },
              } : {}),
            },
          } : {}),
          dialogueMethods: npc.dialogueMethods.map((method, methodIndex) => {
          if (method.kind === "prose") {
            return {
              kind: "prose" as const,
              mechanismId: method.mechanismId,
              clueId: method.clueId,
              relationshipStatementId: method.relationshipEvidence.statementId,
              relationshipQuote: method.relationshipEvidence.quote,
              ...(auditedNpcClaimKey(entry.resolution, anchor.id, index, `relationship:${methodIndex}`)
                ? { claimKey: `npc_binding:${anchor.id}:${index}:relationship:${methodIndex}` }
                : {}),
              spec: structuredClone(method.spec),
            };
          }
          const clue = draft.clueCandidates.find((candidate) => candidate.id === method.clueId);
          if (!clue?.nameStatementId) throw new Error("npc_dialogue_clue_missing");
          return {
            kind: "marked_item" as const,
            mechanismId: method.mechanismId,
            clueId: method.clueId,
            markedItemStatementId: clue.markedItemStatementId,
            nameStatementId: clue.nameStatementId,
            bodyStatementId: clue.bodyStatementId,
            spec: structuredClone(method.spec),
          };
          }),
        };
      });
    })
    .sort((left, right) => left.npcId.localeCompare(right.npcId));
  const proseDialogueClues: ResolvedProseDialogueClue[] = proseNpcBindings.flatMap((binding) => binding.dialogueMethods
    .filter((method): method is ResolvedNpcDialogueMethod & Required<Pick<ResolvedNpcDialogueMethod, "relationshipStatementId" | "relationshipQuote">> => method.kind === "prose")
    .map((method) => ({
      questionId: binding.questionId,
      claimKey: method.claimKey ?? binding.claimKey,
      proseAnchorId: binding.proseAnchorId,
      npcId: binding.npcId,
      mechanismId: method.mechanismId,
      clueId: method.clueId,
      paragraphStatementId: binding.paragraphStatementId,
      headingStatementId: binding.headingStatementId,
      sceneCandidateId: binding.sceneCandidateId,
      relationshipStatementId: method.relationshipStatementId,
      relationshipQuote: method.relationshipQuote,
    })))
    .sort((left, right) => left.clueId.localeCompare(right.clueId));
  const itemBindings: ResolvedItemBinding[] = answered
    .filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "item_binding"; itemType: "key" | "document" | "loot" }> } => entry.value.kind === "item_binding" && entry.value.itemType !== null)
    .map((entry) => {
      const item = draft.itemCandidates.find((candidate) => candidate.id === entry.value.itemCandidateId);
      const scene = item && draft.sceneCandidates.find((candidate) => candidate.id === item.sceneCandidateId);
      const canonicalItem = item && canonical.itemCandidates.find((candidate) => candidate.id === item.id);
      if (!item || !scene || !canonicalItem
        || canonicalItem.markedItemStatementId !== item.markedItemStatementId
        || canonicalItem.nameStatementId !== item.nameStatementId
        || canonicalItem.bodyStatementId !== item.bodyStatementId
        || canonicalItem.sceneCandidateId !== item.sceneCandidateId) {
        throw new Error("item_binding_candidate_missing");
      }
      return {
        questionId: entry.question.id,
        itemCandidateId: item.id,
        itemId: item.id,
        claimKey: `item_binding:${item.id}`,
        itemType: entry.value.itemType,
        itemNameStatementId: entry.value.itemNameEvidence.statementId,
        itemNameQuote: entry.value.itemNameEvidence.quote,
        markedItemStatementId: item.markedItemStatementId,
        nameStatementId: item.nameStatementId,
        bodyStatementId: item.bodyStatementId,
        headingStatementId: scene.headingStatementId,
        sceneCandidateId: item.sceneCandidateId,
      };
    })
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  const rewardBindings: ResolvedRewardBinding[] = answered
    .filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "reward_binding" }> } => entry.value.kind === "reward_binding")
    .map((entry) => {
      const reward = draft.rewardCandidates.find((candidate) => candidate.id === entry.value.rewardCandidateId);
      const original = reward && canonical.rewardCandidates.find((candidate) => candidate.id === reward.id);
      if (!reward || !original || !sameDraftRewardCandidate(reward, original)) throw new Error("reward_binding_candidate_missing");
      return {
        questionId: entry.question.id,
        rewardCandidateId: reward.id,
        tableRowStatementId: reward.tableRowStatementId,
        headingStatementId: reward.headingStatementId,
        claimKey: entry.value.declaration === null ? `reward_binding:none:${reward.id}` : `reward_binding:${reward.id}`,
        declaration: entry.value.declaration === null ? null : structuredClone(entry.value.declaration),
      };
    })
    .sort((left, right) => left.rewardCandidateId.localeCompare(right.rewardCandidateId));
  const sourceFactMechanicBindings: ResolvedSourceFactMechanicBinding[] = answered
    .filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "source_fact_mechanic" }> } => entry.value.kind === "source_fact_mechanic")
    .flatMap((entry) => {
      const headingStatementId = entry.question.owningHeadingStatementId;
      const sceneCandidateId = entry.question.owningSceneCandidateId;
      const parentQuestionId = entry.question.sourceFactParentQuestionId;
      if (!headingStatementId || !sceneCandidateId || !parentQuestionId || entry.value.statementId !== entry.question.subjectStatementId) {
        throw new CompilerQuestionError("invalid_source_fact_mechanic", `source fact mechanic binding lacks prepared scope: ${entry.question.id}`);
      }
      return entry.value.declarations.map((declaration) => {
        const interpretationId = `source_interpretation_${sha256(`${draft.moduleId}|${entry.question.id}|${declaration.declarationKey}|${declaration.kind}`).slice(0, 24)}`;
        const base = {
          questionId: entry.question.id,
          parentQuestionId,
          statementId: entry.value.statementId,
          headingStatementId,
          sceneCandidateId,
          declarationKey: declaration.declarationKey,
          declarationKind: declaration.kind,
          mechanismId: declaration.mechanismId,
          interpretationId,
          evidence: declaration.evidence.map((evidence) => ({ ...evidence })),
        };
        if (declaration.kind === "existing_clue_discovery") {
          return { ...base, declarationKind: declaration.kind, clueId: declaration.clueId, spec: structuredClone(declaration.spec) } satisfies ResolvedExistingClueSourceFactMechanicBinding;
        }
        if (declaration.kind === "prose_fact_finding") {
          return {
            ...base,
            declarationKind: declaration.kind,
            candidateId: declaration.candidateId,
            atomId: declaration.atomId,
            clueId: declaration.clueId,
            quote: declaration.quote,
            check: structuredClone(declaration.check),
            sourceOnlyAtomIds: [...declaration.sourceOnlyAtomIds],
            spec: structuredClone(declaration.spec),
          } satisfies ResolvedProseFactFindingSourceFactMechanicBinding;
        }
        return {
          ...base,
          declarationKind: declaration.kind,
          stateKey: declaration.stateKey,
          trigger: structuredClone(declaration.trigger),
          discoverClueId: declaration.discoverClueId,
          spec: structuredClone(declaration.spec),
        } satisfies ResolvedSceneStateTransitionSourceFactMechanicBinding;
      });
    })
    .sort((left, right) => `${left.questionId}:${left.declarationKey}`.localeCompare(`${right.questionId}:${right.declarationKey}`));
  const blocking: string[] = [];
  if (invalidItemCandidateIds.length) blocking.push("invalid_draft_item_candidates");
  if (invalidRewardCandidateIds.length) blocking.push("invalid_draft_reward_candidates");
  if (!entry || !playable.has(entry.sceneId)) blocking.push("invalid_scene_resolution");
  if (discoveries.some((entry) => !playable.has(entry.value.locationSceneId))) blocking.push("invalid_scene_resolution");
  if (topology.some((item) => !playable.has(item.fromSceneId) || !playable.has(item.toSceneId))) blocking.push("invalid_scene_resolution");
  if (new Set(topology.map((item) => item.connectionId)).size !== topology.length) blocking.push("duplicate_connection_declaration");
  if (new Set(endingDeclarations.map((item) => item.endingId)).size !== endingDeclarations.length) blocking.push("duplicate_ending_declaration");
  if (new Set(proseNpcBindings.map((binding) => binding.npcId)).size !== proseNpcBindings.length) blocking.push("duplicate_npc_binding");
  if (new Set(itemBindings.map((binding) => binding.itemId)).size !== itemBindings.length) blocking.push("duplicate_item_binding");
  if (new Set(rewardBindings.map((binding) => binding.rewardCandidateId)).size !== rewardBindings.length) blocking.push("duplicate_reward_binding");
  if (new Set(sourceFactMechanicBindings.map((binding) => binding.mechanismId)).size !== sourceFactMechanicBindings.length
    || new Set(sourceFactMechanicBindings.map((binding) => binding.interpretationId)).size !== sourceFactMechanicBindings.length) {
    blocking.push("duplicate_source_fact_mechanic_binding");
  }
  if (sourceFactMechanicBindings.some((binding) => !playable.has(binding.sceneCandidateId))) blocking.push("invalid_source_fact_mechanic_scene");
  const facetQuestions = resolvedQueue.questions.filter((question) => question.kind === "clue_fact_facets");
  if (new Set(clueFactFacetBindings.map((binding) => binding.clueId)).size !== clueFactFacetBindings.length
    || clueFactFacetBindings.some((binding) => !facetQuestions.some((question) => question.id === binding.questionId && question.subjectCandidateId === binding.clueId))) {
    blocking.push("duplicate_or_invalid_clue_fact_facets");
  }
  // The marked name is a source-exact visible shell identity. A body may be
  // entirely gated while still exposing that name; only an all-source-only
  // body with no finding has no runtime clue fact at all.
  const visibleShellClueIds = new Set(clueFactFacetBindings
    .filter((binding) => binding.shellAtoms.length > 0 || binding.findings.length > 0)
    .map((binding) => binding.clueId));
  const findingClueIds = clueFactFacetBindings.flatMap((binding) => binding.findings.map((finding) => finding.clueId));
  const findingMethodIds = clueFactFacetBindings.flatMap((binding) => binding.findings.flatMap((finding) => finding.methods.map((method) => method.mechanismId)));
  if (new Set(findingClueIds).size !== findingClueIds.length || new Set(findingMethodIds).size !== findingMethodIds.length) {
    blocking.push("duplicate_clue_fact_finding_identity");
  }
  const proseFactFindingBindings = sourceFactMechanicBindings
    .filter((binding): binding is ResolvedProseFactFindingSourceFactMechanicBinding => binding.declarationKind === "prose_fact_finding");
  const proseFactFindingClueIds = proseFactFindingBindings.map((binding) => binding.clueId);
  if (new Set(proseFactFindingClueIds).size !== proseFactFindingClueIds.length
    || new Set(proseFactFindingBindings.map((binding) => binding.atomId)).size !== proseFactFindingBindings.length) {
    blocking.push("duplicate_prose_fact_finding_identity");
  }
  if (core.some((clueId) => !visibleShellClueIds.has(clueId))
    || discoveries.some((entry) => !visibleShellClueIds.has(entry.value.clueId))
    || sourceFactMechanicBindings.some((binding) => binding.declarationKind === "existing_clue_discovery" && !visibleShellClueIds.has(binding.clueId))) {
    blocking.push("inactive_clue_fact_shell_reference");
  }
  if (proseNpcBindings.some((binding) => {
    const drafted = draft.proseNpcAnchors.find((anchor) => anchor.id === binding.proseAnchorId);
    const original = canonical.proseNpcAnchors.find((anchor) => anchor.id === binding.proseAnchorId);
    return !drafted || !original
      || drafted.paragraphStatementId !== original.paragraphStatementId
      || drafted.headingStatementId !== original.headingStatementId
      || drafted.sceneCandidateId !== original.sceneCandidateId
      || binding.paragraphStatementId !== original.paragraphStatementId
      || binding.headingStatementId !== original.headingStatementId
      || binding.sceneCandidateId !== original.sceneCandidateId;
  })) blocking.push("invalid_npc_binding_anchor");
  if (proseNpcBindings.some((binding) => !playable.has(binding.sceneCandidateId))) blocking.push("invalid_npc_binding_scene");
  const invalidItemNameBinding = itemBindings.some((binding) => {
    const candidate = draft.itemCandidates.find((item) => item.id === binding.itemCandidateId);
    const selected = graph.statements.find((statement) => statement.id === binding.itemNameStatementId);
    const selectedIsCandidateChild = binding.itemNameStatementId === binding.nameStatementId || binding.itemNameStatementId === binding.bodyStatementId;
    return !candidate
      || candidate.id !== binding.itemId
      || candidate.markedItemStatementId !== binding.markedItemStatementId
      || candidate.nameStatementId !== binding.nameStatementId
      || candidate.bodyStatementId !== binding.bodyStatementId
      || candidate.sceneCandidateId !== binding.sceneCandidateId
      || !selected || !selectedIsCandidateChild
      || selected.parentStatementId !== binding.markedItemStatementId
      || (selected.kind !== "marked_item_name" && selected.kind !== "marked_item_body")
      || binding.itemNameQuote !== binding.itemNameQuote.trim()
      || binding.itemNameQuote.length < 2 || binding.itemNameQuote.length > 120
      || !selected.text.includes(binding.itemNameQuote);
  });
  if (invalidItemNameBinding) blocking.push("invalid_item_binding_name_evidence");
  const invalidNpcEncounterBinding = proseNpcBindings.some((binding) => {
    const encounter = binding.encounter;
    if (!encounter) return false;
    const question = resolvedQueue.questions.find((candidate) => candidate.id === binding.questionId);
    let profileHeadingId: string;
    try {
      if (!question) return true;
      profileHeadingId = npcEncounterEvidenceHeadingId(graph, question, binding.nameQuote, encounter.statEvidence);
    } catch {
      return true;
    }
    const sourceIds = uniqueSorted([
      binding.headingStatementId,
      binding.paragraphStatementId,
      profileHeadingId,
      encounter.statEvidence.maxHp.statementId,
      encounter.statEvidence.dodge.statementId,
      encounter.statEvidence.fight.statementId,
      encounter.statEvidence.npcDamage.statementId,
      ...encounter.victoryEffectEvidence.flatMap((effect) => effect.sourceStatementIds),
    ]);
    return encounter.sceneId !== binding.sceneCandidateId
      || encounter.combatantId !== binding.npcId
      || encounter.sourceStatementIds.join("|") !== sourceIds.join("|")
      || encounter.victoryEffectEvidence.length !== encounter.victoryEffects.length
      || !encounter.sourceStatementIds.every((id) => graph.statements.some((statement) => statement.id === id));
  });
  if (invalidNpcEncounterBinding) blocking.push("invalid_npc_encounter_binding");
  const encounterBindings = proseNpcBindings.flatMap((binding) => binding.encounter ? [{ binding, encounter: binding.encounter }] : []);
  if (new Set(encounterBindings.map((entry) => entry.encounter.encounterId)).size !== encounterBindings.length) blocking.push("duplicate_npc_encounter_binding");
  if (new Set(encounterBindings.map((entry) => entry.encounter.sceneId)).size !== encounterBindings.length) blocking.push("conflicting_npc_encounter_scene");
  const invalidNpcDialogueBinding = proseNpcBindings.some((binding) => binding.dialogueMethods.some((method) => {
    const scene = draft.sceneCandidates.find((candidate) => candidate.id === binding.sceneCandidateId);
    const paragraph = graph.statements.find((statement) => statement.id === binding.paragraphStatementId);
    const heading = graph.statements.find((statement) => statement.id === binding.headingStatementId);
    const discovers = method.spec.onSuccess.filter((effect) => effect.kind === "discover_clue");
    if (method.kind === "prose") {
      const expectedClueId = method.relationshipStatementId && method.relationshipQuote
        ? deriveNpcProseDialogueClueId(graph, binding.proseAnchorId, binding.npcId, { statementId: method.relationshipStatementId, quote: method.relationshipQuote })
        : undefined;
      return !scene || !paragraph || paragraph.kind !== "paragraph" || !heading || heading.kind !== "heading"
        || paragraph.parentStatementId !== heading.id
        || !graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === paragraph.id)
        || method.relationshipStatementId !== paragraph.id
        || !method.relationshipQuote || method.relationshipQuote !== method.relationshipQuote.trim()
        || method.relationshipQuote.length < 2 || method.relationshipQuote.length > 240
        || method.relationshipQuote === binding.nameQuote || !paragraph.text.includes(method.relationshipQuote)
        || method.clueId !== expectedClueId
        || method.spec.id !== method.mechanismId || method.spec.clueId !== method.clueId
        || method.spec.action !== "talk" || method.spec.target !== "npc" || method.spec.targetId !== binding.npcId
        || method.spec.onSuccess.length !== 1 || discovers.length !== 1 || discovers[0]!.clueId !== method.clueId
        || method.spec.onSuccess.some((effect) => effect.kind === "acquire_item");
    }
    const clue = draft.clueCandidates.find((candidate) => candidate.id === method.clueId);
    const canonicalClue = canonical.clueCandidates.find((candidate) => candidate.id === method.clueId);
    const marked = clue && graph.statements.find((statement) => statement.id === clue.markedItemStatementId);
    const name = clue && graph.statements.find((statement) => statement.id === clue.nameStatementId);
    const body = clue && graph.statements.find((statement) => statement.id === clue.bodyStatementId);
    const scoped = scene && clue && graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === scene.headingStatementId && relation.to === clue.markedItemStatementId);
    const nameChild = clue && graph.relations.some((relation) => relation.kind === "marked_item_name" && relation.from === clue.markedItemStatementId && relation.to === clue.nameStatementId);
    const bodyChild = clue && graph.relations.some((relation) => relation.kind === "marked_item_body" && relation.from === clue.markedItemStatementId && relation.to === clue.bodyStatementId);
    return !clue || !canonicalClue || !scene || clue.id !== canonicalClue.id
      || clue.markedItemStatementId !== canonicalClue.markedItemStatementId
      || clue.nameStatementId !== canonicalClue.nameStatementId
      || clue.bodyStatementId !== canonicalClue.bodyStatementId
      || clue.sceneCandidateId !== binding.sceneCandidateId
      || method.markedItemStatementId !== clue.markedItemStatementId
      || method.nameStatementId !== clue.nameStatementId
      || method.bodyStatementId !== clue.bodyStatementId
      || !marked || marked.kind !== "marked_item" || marked.parentStatementId !== scene.headingStatementId || !scoped
      || !name || name.kind !== "marked_item_name" || name.parentStatementId !== marked.id || !nameChild
      || !body || body.kind !== "marked_item_body" || body.parentStatementId !== marked.id || !bodyChild
      || method.spec.id !== method.mechanismId || method.spec.clueId !== method.clueId
      || method.spec.action !== "talk" || method.spec.target !== "npc" || method.spec.targetId !== binding.npcId
      || discovers.length !== 1 || discovers[0]!.clueId !== method.clueId;
  }));
  if (invalidNpcDialogueBinding) blocking.push("invalid_npc_dialogue_binding");
  const npcDialogueSlots = proseNpcBindings.flatMap((binding) => binding.dialogueMethods.map((method) => `${binding.npcId}:${method.clueId}`));
  if (new Set(npcDialogueSlots).size !== npcDialogueSlots.length) blocking.push("conflicting_npc_dialogue_slot");
  if (new Set(proseDialogueClues.map((clue) => clue.clueId)).size !== proseDialogueClues.length) blocking.push("duplicate_prose_dialogue_clue");
  if (itemBindings.some((binding) => !playable.has(binding.sceneCandidateId))) blocking.push("invalid_item_binding_scene");
  const defaultBindings = new Map<string, DefaultDiscoveryBinding>();
  const invalidDefaultInterpretationIds: string[] = [];
  for (const candidate of draft.interpretations) {
    if (candidate.claim.authority !== "engine_policy" || !candidate.claim.value || candidate.claim.value.kind !== "discovery_method") continue;
    const binding = defaultDiscoveryBinding(graph, draft, canonical, candidate);
    if (!binding) invalidDefaultInterpretationIds.push(candidate.id);
    else defaultBindings.set(candidate.id, binding);
  }
  if (invalidDefaultInterpretationIds.length) blocking.push("invalid_default_discovery_binding");
  const hintInterpretations = [
    ...answered.filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "connection_topology" }> } => entry.value.kind === "connection_topology").flatMap((entry) => entry.value.connections.map((connection) => withModuleScope(draft.moduleId, interpretation(entry.question, entry.resolution, connection.spec, `connection:${connection.connectionId}`)))),
    ...endingDeclarations.map((declaration) => withModuleScope(draft.moduleId, interpretation(declaration.question, declaration.resolution, declaration.spec, `ending:${declaration.endingId}`))),
    ...discoveries.map((entry) => withModuleScope(draft.moduleId, interpretation(entry.question, entry.resolution, entry.value.spec, `discovery:${entry.value.spec.id}`))),
    ...clueFactFacetBindings.flatMap((binding) => {
      const answeredBinding = answered.find((entry) => entry.question.id === binding.questionId);
      if (!answeredBinding) throw new CompilerQuestionError("invalid_clue_fact_partition", `clue fact facet question is missing: ${binding.questionId}`);
      return binding.findings.flatMap((finding) => finding.methods.map((method) => withModuleScope(
        draft.moduleId,
        interpretationFromExactEvidence(
          graph,
          answeredBinding.question,
          answeredBinding.resolution,
          method.spec,
          `clue-finding:${finding.clueId}:${method.mechanismId}`,
          [binding.headingStatementId, binding.bodyStatementId],
        ),
      )));
    }),
    ...sourceFactMechanicBindings.map((binding) => {
      const answeredBinding = answered.find((entry) => entry.question.id === binding.questionId);
      if (!answeredBinding) throw new CompilerQuestionError("invalid_source_fact_mechanic", `source fact mechanic question is missing: ${binding.questionId}`);
      return sourceFactMechanicInterpretation(graph, draft.moduleId, answeredBinding.question, answeredBinding.resolution, binding);
    }),
    ...proseNpcBindings.flatMap((binding) => {
      const answeredBinding = answered.find((entry) => entry.question.id === binding.questionId);
      if (!answeredBinding) throw new Error("npc_dialogue_question_missing");
      return binding.dialogueMethods.map((method) => withModuleScope(draft.moduleId, interpretationFromExactEvidence(
        graph,
        answeredBinding.question,
        answeredBinding.resolution,
        method.spec,
        `npc-dialogue:${binding.npcId}:${method.mechanismId}`,
        method.kind === "prose"
          ? [binding.headingStatementId, binding.paragraphStatementId]
          : [binding.headingStatementId, binding.paragraphStatementId, method.markedItemStatementId!, method.nameStatementId!, method.bodyStatementId!],
      )));
    }),
    ...encounterBindings.flatMap(({ binding, encounter }) => {
      const answeredBinding = answered.find((entry) => entry.question.id === binding.questionId);
      if (!answeredBinding) throw new Error("npc_encounter_question_missing");
      const definition = {
        kind: "encounter_definition" as const,
        id: encounter.encounterId,
        encounterId: encounter.encounterId,
        sceneId: encounter.sceneId,
        combatantId: encounter.combatantId,
        maxHp: encounter.maxHp,
        dodge: encounter.dodge,
        fight: encounter.fight,
        npcDamage: encounter.npcDamage,
        victoryEffects: encounter.victoryEffects,
      };
      const start = {
        kind: "state_transition" as const,
        id: encounter.autoStartMechanismId,
        when: {
          kind: "all" as const,
          predicates: [
            { kind: "current_scene" as const, sceneId: encounter.sceneId },
            { kind: "not" as const, predicate: { kind: "encounter_defeated" as const, encounterId: encounter.encounterId } },
          ],
        },
        effects: [{ kind: "start_encounter" as const, encounterId: encounter.encounterId }],
      };
      return [
        withModuleScope(draft.moduleId, interpretationFromExactEvidence(graph, answeredBinding.question, answeredBinding.resolution, definition, `npc-encounter:${binding.npcId}:${encounter.encounterId}`, encounter.sourceStatementIds)),
        withModuleScope(draft.moduleId, interpretationFromExactEvidence(graph, answeredBinding.question, answeredBinding.resolution, start, `npc-encounter-start:${binding.npcId}:${encounter.autoStartMechanismId}`, encounter.sourceStatementIds)),
      ];
    }),
    ...answered
      .filter((entry): entry is typeof entry & { value: Extract<ParsedCompilerHintValue, { kind: "reward_binding" }> } => entry.value.kind === "reward_binding" && entry.value.declaration !== null)
      .map((entry) => withModuleScope(draft.moduleId, interpretation(entry.question, entry.resolution, {
        kind: "reward_definition",
        id: entry.value.rewardCandidateId,
        when: entry.value.declaration!.when,
        settlement: entry.value.declaration!.settlement,
      }, `reward:${entry.value.rewardCandidateId}`))),
  ];
  const boundItemIds = new Set(itemBindings.map((binding) => binding.itemId));
  const itemBindingById = new Map(itemBindings.map((binding) => [binding.itemId, binding]));
  for (const discovery of discoveries) {
    if (discovery.value.spec.target === "item") {
      const binding = itemBindingById.get(discovery.value.spec.targetId);
      if (!binding) blocking.push("unbound_item_reference");
      else if (binding.sceneCandidateId !== discovery.value.locationSceneId) blocking.push("item_discovery_location_mismatch");
    }
    for (const effect of discovery.value.spec.onSuccess) {
      if (effect.kind !== "acquire_item") continue;
      const binding = itemBindingById.get(effect.itemId);
      if (!binding) blocking.push("unbound_item_reference");
      else if (binding.sceneCandidateId !== discovery.value.locationSceneId) blocking.push("item_discovery_location_mismatch");
    }
  }
  // Other mechanics may predicate or effect an item. Keeping symbols answer-only
  // makes those references fail closed during compilation; this early status keeps
  // an incomplete answer in draft_only rather than publishing a partial runtime.
  const itemReferenceIds = hintInterpretations.flatMap((candidate) => candidate.claim.value ? collectItemReferences(candidate.claim.value) : []);
  if (itemReferenceIds.some((itemId) => !boundItemIds.has(itemId))) blocking.push("unbound_item_reference");
  const hintedLocations = new Map([
    ...discoveries.map((entry) => [entry.value.spec.id, entry.value.locationSceneId] as const),
    ...clueFactFacetBindings.flatMap((binding) => binding.findings.flatMap((finding) => finding.methods.map((method) => [method.mechanismId, binding.sceneCandidateId] as const))),
    ...sourceFactMechanicBindings
      .filter((binding): binding is ResolvedExistingClueSourceFactMechanicBinding | ResolvedProseFactFindingSourceFactMechanicBinding => binding.declarationKind === "existing_clue_discovery" || binding.declarationKind === "prose_fact_finding")
      .map((binding) => [binding.mechanismId, binding.sceneCandidateId] as const),
    ...proseNpcBindings.flatMap((binding) => binding.dialogueMethods.map((method) => [method.mechanismId, binding.sceneCandidateId] as const)),
  ]);
  const explicitDiscoveryBindings = new Set([
    ...discoveries.map((entry) => `${entry.value.clueId}:${entry.value.locationSceneId}`),
    ...sourceFactMechanicBindings.map((binding) => `${binding.declarationKind === "scene_state_transition" ? binding.discoverClueId : binding.clueId}:${binding.sceneCandidateId}`),
  ]);
  const substitutedEnginePolicyInterpretationIds = draft.interpretations.filter((candidate) => {
    const binding = defaultBindings.get(candidate.id);
    return binding !== undefined && explicitDiscoveryBindings.has(`${binding.clueId}:${binding.locationSceneId}`);
  }).map((candidate) => candidate.id).sort();
  const acceptedDefaults = draft.interpretations.filter((candidate) => !substitutedEnginePolicyInterpretationIds.includes(candidate.id)).filter((candidate) => {
    if (candidate.claim.authority !== "engine_policy" || !candidate.claim.value || candidate.claim.value.kind !== "discovery_method") return true;
    const binding = defaultBindings.get(candidate.id);
    if (!binding) {
      blocking.push("invalid_default_discovery_binding");
      return false;
    }
    // A source-only marked body has no displayable shell and must not retain
    // the old automatic whole-container discovery just because it has a
    // canonical draft clue ID.
    if (!visibleShellClueIds.has(binding.clueId)) return false;
    if (!playable.has(binding.locationSceneId)) {
      blocking.push("invalid_default_discovery_binding");
      return false;
    }
    return true;
  });
  const acceptedInterpretations = structuredClone([...acceptedDefaults, ...hintInterpretations]);
  const declaredMechanismIds = acceptedInterpretations
    .map((candidate) => candidate.claim.value?.id)
    .filter((id): id is string => typeof id === "string");
  if (new Set(declaredMechanismIds).size !== declaredMechanismIds.length) blocking.push("duplicate_mechanism_id");
  const symbols: MechanicsSymbols = {
    clueIds: uniqueSorted([...visibleShellClueIds, ...findingClueIds, ...proseDialogueClues.map((clue) => clue.clueId), ...proseFactFindingClueIds]),
    sceneIds: [...playable].sort(),
    itemIds: [...boundItemIds].sort(), npcIds: proseNpcBindings.map((binding) => binding.npcId).sort(),
    connectionIds: topology.map((item) => item.connectionId).sort(),
    /** Encounter definitions are source candidates, not a compiler-hint-generated second DSL. */
    encounterIds: acceptedInterpretations
      .flatMap((candidate) => candidate.claim.value?.kind === "encounter_definition" ? [candidate.claim.value.encounterId] : [])
      .sort(),
    endingIds: endingDeclarations.map((item) => item.endingId).sort(),
    rewardIds: rewardBindings.filter((binding) => binding.declaration !== null).map((binding) => binding.rewardCandidateId).sort(),
    /** Only source-fact transition sentinels can grant compiler-owned state-write authority. */
    declaredStateKeys: sourceFactMechanicBindings
      .filter((binding): binding is ResolvedSceneStateTransitionSourceFactMechanicBinding => binding.declarationKind === "scene_state_transition")
      .map((binding) => binding.stateKey)
      .sort(),
  };
  const baseReadiness = deriveReadiness(draft, resolvedQueue, "draft_only", [], blocking);
  if (baseReadiness.publishBlockingQuestionIds.length || blocking.length || !entry || symbols.endingIds.length === 0) {
    return { resolvedQueue, acceptedInterpretations, proseNpcBindings, proseDialogueClues, itemBindings, rewardBindings, sourceFactMechanicBindings, clueFactFacetBindings, readiness: deriveReadiness(draft, resolvedQueue, "draft_only", [], [...blocking, ...(symbols.endingIds.length ? [] : ["missing_ending_rules"])]), substitutedEnginePolicyInterpretationIds };
  }
  const mechanicsIR = compileMechanics({ ...graph, interpretations: acceptedInterpretations }, {
    moduleId: draft.moduleId,
    documentHash: draft.documentHash,
    sourceGraphSchemaVersion: graph.schemaVersion,
    symbols,
    acceptedInterpretationIds: acceptedInterpretations.map((candidate) => candidate.id),
    compilationMode: "compatible",
    allowedEnginePolicyIds: ["marked-item-observation-v1"],
  });
  const retainedDefaultBindings = [...defaultBindings.values()].filter((binding) => acceptedDefaults.some((candidate) => candidate.id === binding.interpretationId));
  const discoveryLocations: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const method of mechanicsIR.discoveryMethods) {
    const binding = retainedDefaultBindings.find((binding) => binding.methodId === method.id && binding.clueId === method.clueId && method.sourceInterpretationIds.length === 1 && method.sourceInterpretationIds[0] === binding.interpretationId);
    const location = hintedLocations.get(method.id) ?? binding?.locationSceneId;
    if (!location) {
      return { resolvedQueue, acceptedInterpretations, proseNpcBindings, proseDialogueClues, itemBindings, rewardBindings, sourceFactMechanicBindings, clueFactFacetBindings, readiness: deriveReadiness(draft, resolvedQueue, "draft_only", [], ["missing_verified_discovery_location"]), substitutedEnginePolicyInterpretationIds };
    }
    discoveryLocations[method.id] = location;
  }
  const analysisInput: MechanicsAnalysisInput = {
    entrySceneId: entry.sceneId,
    initialState: { foundClueIds: [], visitedSceneIds: [], ownedItemIds: [], stateValues: {}, npcStates: {} },
    coreClueIds: uniqueSorted(core),
    connections: topology.map((item) => ({ id: item.connectionId, fromSceneId: item.fromSceneId, toSceneId: item.toSceneId })),
    discoveryLocations,
    // Control-state pruning keeps pure optional findings out of the bounded
    // search key; 500 remains a fail-closed capacity rather than an escape.
    maxStates: 500,
  };
  const reachabilityReport = analyzeMechanicsReachability(mechanicsIR, analysisInput);
  // Finding clues are intentionally not silently promoted to core clues, but
  // a declared gated fact that no successful path can ever reveal is still a
  // broken source partition rather than harmless optional flavor.
  const unreachableFindingClueIds = [...findingClueIds, ...proseFactFindingClueIds].filter((clueId) => !reachabilityReport.reachableClueIds.includes(clueId));
  // GameSession intentionally has no durable character-transaction path while
  // installing an already terminal module.  Use the same entry settlement as
  // reachability and GameSession so a source-bound terminal reward cannot be
  // published and then rejected only at runtime.
  const initialSettlement = settleInitialMechanics(mechanicsIR, analysisInput);
  const initialTerminalRewardsUnsupported = initialSettlement.state.terminalEndingId !== undefined && initialSettlement.state.rewardIds.length > 0;
  const reachabilityClean = !reachabilityReport.unreachableCoreClueIds.length && !reachabilityReport.unreachableEndingIds.length && !reachabilityReport.deadlockWitnesses.length && !reachabilityReport.failurePolicyRiskMethodIds.length && reachabilityReport.selectedTerminalEndingIds.length > 0;
  const clean = reachabilityClean && !initialTerminalRewardsUnsupported && unreachableFindingClueIds.length === 0;
  const closingBlocks = [
    ...(reachabilityClean ? [] : ["reachability_incomplete"]),
    ...(initialTerminalRewardsUnsupported ? ["initial_terminal_rewards_unsupported"] : []),
    ...(unreachableFindingClueIds.length ? ["unreachable_clue_fact_finding"] : []),
  ];
  return {
    resolvedQueue,
    acceptedInterpretations,
    mechanicsIR,
    analysisInput,
    reachabilityReport,
    readiness: deriveReadiness(draft, resolvedQueue, clean ? "mechanically_closed" : "draft_only", mechanismIds(mechanicsIR), closingBlocks),
    substitutedEnginePolicyInterpretationIds,
    proseNpcBindings,
    proseDialogueClues,
    itemBindings,
    rewardBindings,
    sourceFactMechanicBindings,
    clueFactFacetBindings,
  };
}
