import { createResolvedCompilerArtifact, type CompilerArtifactEnvelope, type CompilerArtifactRefusal, type ResolvedCompilerArtifactIdentity, type ResolvedCompilerArtifactPayload } from "./compiler-artifact";
import { sha256, type EvidenceRef } from "../ingest/document-ir";
import type { MechanicsIR } from "./mechanics-ir";
import type { Clue, Ending, ModuleData, ModuleItem, ModuleNPC, Scene, SceneConnection } from "../module/types";

export interface ModuleDataPresentationMetadata {
  module: {
    title: string;
    version: string;
    ruleset: ModuleData["ruleset"];
    era: string;
    summary: string;
    playerCount: string;
    expectedDuration: string;
    triggerWarnings: string[];
  };
  scenes: Record<string, { description: string }>;
  connections: Record<string, { condition: string }>;
  clues: Record<string, { findMethods: Clue["findMethods"]; revelation: string; unlocks: string[]; importance: Clue["importance"] }>;
  endings: Record<string, { name: string; description: string; conditions: string[] }>;
}

export interface ProjectionStatementEvidence {
  statementId: string;
  evidenceRefId: string;
  evidence: EvidenceRef;
}

/**
 * The compiler has no source-level player/Keeper visibility marker.  A
 * publishable presentation therefore needs a server-owned review that selects
 * exact source text; it never carries reviewer-authored prose.
 */
export const TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION = "1.1.0";
/** Stable manifest and page shape returned to an authenticated operator before review minting. */
export const TRUSTED_PRESENTATION_WORKBENCH_PLAN_SCHEMA_VERSION = "1.2.0";
/** Server-owned cap for one source-exact candidate page; callers cannot raise it. */
export const TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE = 8;
/** Server-owned cap for one compact manifest slot page; callers cannot raise it. */
export const TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE = 16;

export const TRUSTED_PRESENTATION_MODULE_FIELDS = [
  "title",
  "version",
  "era",
  "summary",
  "playerCount",
  "expectedDuration",
  "triggerWarnings",
] as const;
export type TrustedPresentationModuleField = typeof TRUSTED_PRESENTATION_MODULE_FIELDS[number];

export interface TrustedPresentationTextBinding {
  kind: "source_exact";
  fieldPath: string;
  statementId: string;
  /** Exact, non-empty substring of statementId; it is also the rendered text. */
  quote: string;
  evidenceRefId: string;
  /** The verified heading scope in which this field may be presented. */
  headingStatementId: string;
}

/** An honest availability disclosure, never a claim about source text. */
export interface TrustedPresentationOpaqueBinding {
  kind: "opaque_unavailable";
  fieldPath: string;
}

export type TrustedPresentationBinding = TrustedPresentationTextBinding | TrustedPresentationOpaqueBinding;

export type TrustedPresentationQuotePolicy = "exact_whole_statement" | "exact_nonempty_substring";

export interface TrustedPresentationSourceCandidate {
  kind: "source_exact";
  binding: TrustedPresentationTextBinding;
  /** Full source statement text, kept separate from a permitted anchor quote. */
  exactText: string;
  quotePolicy: TrustedPresentationQuotePolicy;
}

export interface TrustedPresentationOpaqueCandidate {
  kind: "opaque_unavailable";
  binding: TrustedPresentationOpaqueBinding;
}

export type TrustedPresentationReviewCandidate = TrustedPresentationSourceCandidate | TrustedPresentationOpaqueCandidate;

/** A compact required review choice. Source text belongs to a requested page. */
export interface TrustedPresentationReviewManifestSlot {
  fieldPath: string;
  allowedBindingKinds: Array<TrustedPresentationBinding["kind"]>;
  sourceCandidateCount: number;
  /** Present only when `opaque_unavailable` is directly bindable for this slot. */
  opaqueBinding: TrustedPresentationOpaqueBinding | null;
}

/** One bounded manifest page; counts are calculated only for these slots. */
export interface TrustedPresentationReviewSlotPage {
  slots: TrustedPresentationReviewManifestSlot[];
  hasMore: boolean;
}

/** One bounded exact-source candidate page for one manifest slot. */
export interface TrustedPresentationReviewCandidatePage {
  fieldPath: string;
  candidates: TrustedPresentationSourceCandidate[];
  hasMore: boolean;
}

/** Internal cursor-binding material is returned to the HTTP boundary, not serialized to callers. */
export interface TrustedPresentationReviewCandidatePageBuild {
  status: "paged";
  page: TrustedPresentationReviewCandidatePage;
  sourceCandidateOrderHash: string;
}

/**
 * Server-private selection views for an authorized machine operator. A digest
 * identifies one canonical candidate; it is never an authorization grant.
 */
export interface TrustedPresentationSelectionSlotPageBuild {
  status: "selection_slot_paged";
  page: {
    slots: Array<TrustedPresentationReviewManifestSlot & {
      opaqueCandidateDigest: string | null;
    }>;
    hasMore: boolean;
  };
  fieldPathOrderHash: string;
}

export interface TrustedPresentationSelectionCandidatePageBuild {
  status: "selection_paged";
  page: {
    fieldPath: string;
    offset: number;
    sourceCandidateOrderHash: string;
    candidates: Array<{
      kind: "source_exact";
      candidateDigest: string;
      /** Source text is host-private prompt material, never a player release. */
      exactText: string;
      quotePolicy: TrustedPresentationQuotePolicy;
    }>;
    hasMore: boolean;
  };
}

/**
 * A non-enumerable host-only brand travels with a selection-page candidate
 * from the canonical builder to the in-process machine publisher. It is not
 * part of the page DTO, prompt, review, receipt, or any persisted object.
 */
const MACHINE_SELECTION_CANDIDATE_SOURCE_RANGE = Symbol("machineSelectionCandidateSourceRange");

type MachineSelectionCandidateSourceRange = {
  statementId: string;
  statementText: string;
  quote: string;
};

function withMachineSelectionCandidateSourceRange<T extends object>(
  candidate: T,
  binding: TrustedPresentationTextBinding,
  statementText: string,
): T {
  Object.defineProperty(candidate, MACHINE_SELECTION_CANDIDATE_SOURCE_RANGE, {
    value: Object.freeze({ statementId: binding.statementId, statementText, quote: binding.quote }) satisfies MachineSelectionCandidateSourceRange,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return candidate;
}

/**
 * Server-private comparison for two canonical candidate instances. A plain
 * DTO, structured clone, or caller-made lookalike has no brand and therefore
 * cannot invent a conflict; normal rehydration and final review validation
 * remain the authority at every persistence boundary.
 */
export function machinePresentationSelectionCandidatesShareSourceRange(left: unknown, right: unknown): boolean {
  const rangeFor = (value: unknown): MachineSelectionCandidateSourceRange | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const range = (value as { [MACHINE_SELECTION_CANDIDATE_SOURCE_RANGE]?: unknown })[MACHINE_SELECTION_CANDIDATE_SOURCE_RANGE];
    if (!range || typeof range !== "object") return undefined;
    const record = range as Partial<MachineSelectionCandidateSourceRange>;
    return typeof record.statementId === "string"
      && typeof record.statementText === "string"
      && typeof record.quote === "string"
      ? record as MachineSelectionCandidateSourceRange
      : undefined;
  };
  const leftRange = rangeFor(left);
  const rightRange = rangeFor(right);
  return !!leftRange && !!rightRange
    && leftRange.statementId === rightRange.statementId
    && sourceQuoteRangesOverlap(leftRange.statementText, leftRange.quote, rightRange.quote);
}

/** The only untrusted machine-selection shapes accepted for rehydration. */
export type UntrustedTrustedPresentationSelection =
  | {
    fieldPath: string;
    kind: "source_exact";
    candidateDigest: string;
    offset: number;
    sourceCandidateOrderHash: string;
  }
  | {
    fieldPath: string;
    kind: "opaque_unavailable";
    candidateDigest: string;
  };

export interface TrustedPresentationSelectionRehydration {
  status: "rehydrated";
  bindings: TrustedPresentationBinding[];
}

/** Internal slot-cursor binding material is returned to the HTTP boundary only. */
export interface TrustedPresentationReviewSlotPageBuild {
  status: "slot_paged";
  page: TrustedPresentationReviewSlotPage;
  fieldPathOrderHash: string;
}

export interface TrustedPresentationReview {
  schemaVersion: typeof TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION;
  id: string;
  reviewerPrincipalId: string;
  reviewedAt: string;
  preparedArtifactId: string;
  preparedArtifactHash: string;
  preparedIdentity: {
    moduleId: string;
    documentHash: string | null;
    sourceGraphIdentity: string;
    preparedQueueHash: string;
  };
  resolvedArtifactHash: string;
  resolvedIdentity: ResolvedCompilerArtifactIdentity;
  bindings: TrustedPresentationBinding[];
  /**
   * Present only when a server-owned machine service selected canonical
   * candidates.  This is an immutable audit receipt, not a capability and not
   * player-visible presentation text.
   */
  machinePublication?: TrustedPresentationMachinePublication;
  reviewHash: string;
}

export type TrustedPresentationAudience = "public_on_entry" | "found_clue" | "terminal_only" | "private_context";

export interface TrustedPresentationMachineScope {
  fieldPath: string;
  audience: TrustedPresentationAudience;
}

export interface TrustedPresentationMachinePublication {
  servicePrincipalId: string;
  policyId: string;
  requestHash: string;
  responseHash: string;
  decisionHash: string;
  coverageHash: string;
  scopes: TrustedPresentationMachineScope[];
}

/**
 * The machine receipt records the release boundary for every canonical field.
 * This deliberately describes actual compiled-player consumers, not a claim
 * that the selected source text is semantically safe in every circumstance.
 * In particular, item names are already emitted in the scene/inventory view;
 * item descriptions and NPC descriptions are not.
 */
export function trustedPresentationAudienceForFieldPath(fieldPath: string): TrustedPresentationAudience | undefined {
  if (/^module\.(title|version|era|summary|playerCount|expectedDuration|triggerWarnings)$/.test(fieldPath)) return "public_on_entry";
  if (/^scenes\.[^.]+\.(name|description)$/.test(fieldPath)) return "public_on_entry";
  if (/^connections\.[^.]+\.condition$/.test(fieldPath)) return "public_on_entry";
  if (/^clues\.[^.]+\.(name|description|revelation)$/.test(fieldPath)
    || /^clues\.[^.]+\.findMethods\.[^.]+\.description$/.test(fieldPath)) return "found_clue";
  if (/^items\.[^.]+\.name$/.test(fieldPath)) return "public_on_entry";
  if (/^items\.[^.]+\.description$/.test(fieldPath)) return "private_context";
  if (/^npcs\.[^.]+\.name$/.test(fieldPath)) return "public_on_entry";
  if (/^npcs\.[^.]+\.description$/.test(fieldPath)) return "private_context";
  if (/^endings\.[^.]+\.(name|description)$/.test(fieldPath)
    || /^endings\.[^.]+\.conditions\.0$/.test(fieldPath)) return "terminal_only";
  return undefined;
}

export type ProjectionFieldOrigin =
  | { kind: "source_exact"; statements: ProjectionStatementEvidence[] }
  | { kind: "resolved_interpretation"; interpretationIds: string[]; statements: ProjectionStatementEvidence[] }
  | { kind: "resolved_question"; questionIds: string[]; claimKeys: string[]; statements: ProjectionStatementEvidence[]; quotes: Array<{ statementId: string; quote: string }> }
  | { kind: "artifact"; artifactPath: string }
  | { kind: "caller_metadata"; metadataPath: string }
  | { kind: "trusted_presentation_review"; reviewId: string; reviewHash: string; fieldPath: string; statements: ProjectionStatementEvidence[]; quote: string }
  | { kind: "trusted_presentation_opaque"; reviewId: string; reviewHash: string; fieldPath: string; disclosure: "opaque_unavailable" };

export interface ModuleDataProjectionSourceMap {
  module: { fields: Record<string, ProjectionFieldOrigin> };
  scenes: Record<string, {
    fields: Record<string, ProjectionFieldOrigin>;
    clues: Record<string, {
      fields: Record<string, ProjectionFieldOrigin>;
      /**
       * A findMethods list is mechanically derived, but every reviewed display
       * label has its own stable source binding.  Keeping this separate from
       * the list-level origin prevents a later method from overwriting an
       * earlier method's evidence.
       */
      findMethods: Record<string, { fields: Record<"description", ProjectionFieldOrigin> }>;
    }>;
    connections: Record<string, { fields: Record<string, ProjectionFieldOrigin> }>;
  }>;
  npcs: Record<string, { fields: Record<string, ProjectionFieldOrigin> }>;
  items: Record<string, { fields: Record<string, ProjectionFieldOrigin> }>;
  endings: Record<string, { fields: Record<string, ProjectionFieldOrigin> }>;
}

export interface CompilerModuleDataProjection {
  status: "projected";
  module: ModuleData;
  entrySceneId: string;
  artifact: { artifactHash: string; identity: ResolvedCompilerArtifactIdentity };
  mechanics: Pick<MechanicsIR, "moduleId" | "documentHash" | "sourceGraphIdentity" | "mechanicsHash">;
  sourceMap: ModuleDataProjectionSourceMap;
  /** Present only for a catalog-backed, identity-bound visibility review. */
  presentationReview?: TrustedPresentationReview;
  /** Explicitly separates unavailable compiled metadata from source-derived facts. */
  compiledPresentationDisclosure?: { opaqueUnavailableModuleFields: TrustedPresentationModuleField[] };
}

export type CompilerModuleDataProjectionRefusalCode = "ARTIFACT_INVALID" | "MECHANICS_IDENTITY_MISMATCH" | "PRESENTATION_METADATA_INVALID";
export interface CompilerModuleDataProjectionRefusal {
  status: "refused";
  code: CompilerModuleDataProjectionRefusalCode;
  message: string;
  artifactCode?: CompilerArtifactRefusal["code"];
}

class ProjectionDataError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectionDataError"; }
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new ProjectionDataError(`${label} metadata keys must exactly match compiler IDs`);
}

function assertExactBindingKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function requiredText(value: string, label: string): string {
  if (!value.trim()) throw new ProjectionDataError(`${label} is required presentation metadata`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertFindMethods(value: unknown, label: string): asserts value is Clue["findMethods"] {
  if (!Array.isArray(value) || value.some((method) => !isRecord(method)
    || !["skill", "observation", "npc_dialogue", "item", "automatic"].includes(method.type as string)
    || typeof method.description !== "string" || !method.description.trim()
    || (method.skillName !== undefined && typeof method.skillName !== "string")
    || (method.difficulty !== undefined && !["regular", "hard", "extreme"].includes(method.difficulty as string)))) {
    throw new ProjectionDataError(`${label} has an invalid findMethods value`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new ProjectionDataError(`${label} must be a non-blank string array`);
  }
}

function sourceEvidence(payload: ResolvedCompilerArtifactPayload, statementIds: readonly string[]): ProjectionStatementEvidence[] {
  return statementIds.map((statementId) => {
    const statement = payload.graph.statements.find((candidate) => candidate.id === statementId);
    if (!statement) throw new ProjectionDataError(`missing source statement: ${statementId}`);
    return { statementId, evidenceRefId: statement.evidenceRefId, evidence: statement.evidence };
  });
}

function interpretationEvidence(payload: ResolvedCompilerArtifactPayload, interpretationIds: readonly string[]): ProjectionFieldOrigin {
  const statementIds = [...new Set(interpretationIds.flatMap((id) => {
    const interpretation = payload.acceptedInterpretations.find((candidate) => candidate.id === id);
    if (!interpretation) throw new ProjectionDataError(`missing accepted interpretation: ${id}`);
    return interpretation.sourceStatementIds;
  }))].sort();
  return { kind: "resolved_interpretation", interpretationIds: [...interpretationIds].sort(), statements: sourceEvidence(payload, statementIds) };
}

function artifactOrigin(path: string): ProjectionFieldOrigin { return { kind: "artifact", artifactPath: path }; }
function metadataOrigin(path: string): ProjectionFieldOrigin { return { kind: "caller_metadata", metadataPath: path }; }
function sourceOrigin(payload: ResolvedCompilerArtifactPayload, statementIds: readonly string[]): ProjectionFieldOrigin { return { kind: "source_exact", statements: sourceEvidence(payload, statementIds) }; }
function questionOrigin(payload: ResolvedCompilerArtifactPayload, binding: ResolvedCompilerArtifactPayload["proseNpcBindings"][number]): ProjectionFieldOrigin {
  return {
    kind: "resolved_question",
    questionIds: [binding.questionId],
    claimKeys: [binding.claimKey],
    statements: sourceEvidence(payload, [binding.headingStatementId, binding.paragraphStatementId]),
    quotes: [{ statementId: binding.paragraphStatementId, quote: binding.nameQuote }],
  };
}

/** Automatic combat keeps its individual audit claims visible to projection consumers. */
function encounterQuestionOrigin(
  payload: ResolvedCompilerArtifactPayload,
  binding: ResolvedCompilerArtifactPayload["proseNpcBindings"][number],
): ProjectionFieldOrigin {
  const encounter = binding.encounter;
  if (!encounter?.auditClaimKeys) return sourceOrigin(payload, encounter?.sourceStatementIds ?? []);
  const question = payload.resolvedQueue.questions.find((candidate) => candidate.id === binding.questionId);
  const audit = question?.resolution?.audit;
  const claimKeys = Object.values(encounter.auditClaimKeys);
  const citations = audit?.citations.filter((citation) => claimKeys.includes(citation.claimKey)) ?? [];
  if (!audit || citations.length !== claimKeys.length || new Set(citations.map((citation) => citation.claimKey)).size !== claimKeys.length) {
    throw new ProjectionDataError(`automatic NPC encounter audit claims are incomplete: ${binding.npcId}`);
  }
  return {
    kind: "resolved_question",
    questionIds: [binding.questionId],
    claimKeys: [...claimKeys].sort(),
    statements: sourceEvidence(payload, [...new Set(citations.map((citation) => citation.statementId))].sort()),
    quotes: citations.map((citation) => ({ statementId: citation.statementId, quote: citation.quote })),
  };
}
function itemQuestionOrigin(payload: ResolvedCompilerArtifactPayload, binding: ResolvedCompilerArtifactPayload["itemBindings"][number]): ProjectionFieldOrigin {
  const name = payload.graph.statements.find((statement) => statement.id === binding.itemNameStatementId);
  if (!name || (name.kind !== "marked_item_name" && name.kind !== "marked_item_body") || !name.text.includes(binding.itemNameQuote)) {
    throw new ProjectionDataError(`item binding name evidence is invalid: ${binding.itemId}`);
  }
  return {
    kind: "resolved_question",
    questionIds: [binding.questionId],
    claimKeys: [binding.claimKey],
    statements: sourceEvidence(payload, [binding.headingStatementId, binding.markedItemStatementId, binding.nameStatementId, binding.bodyStatementId]),
    quotes: [{ statementId: name.id, quote: binding.itemNameQuote }],
  };
}

type RuntimeClueSource =
  | {
    kind: "marked_item";
    id: string;
    sceneCandidateId: string;
    headingStatementId: string;
    nameStatementId: string;
    bodyStatementId: string;
    facetBinding: ResolvedCompilerArtifactPayload["clueFactFacetBindings"][number];
    shellAtoms: ResolvedCompilerArtifactPayload["clueFactFacetBindings"][number]["shellAtoms"];
  }
  | {
    kind: "clue_fact_finding";
    id: string;
    sceneCandidateId: string;
    headingStatementId: string;
    nameStatementId: string;
    bodyStatementId: string;
    facetBinding: ResolvedCompilerArtifactPayload["clueFactFacetBindings"][number];
    finding: ResolvedCompilerArtifactPayload["clueFactFacetBindings"][number]["findings"][number];
  }
  | {
    kind: "prose_dialogue";
    id: string;
    sceneCandidateId: string;
    headingStatementId: string;
    paragraphStatementId: string;
    relationshipStatementId: string;
    relationshipQuote: string;
    questionId: string;
    claimKey: string;
    npcId: string;
    mechanismId: string;
  }
  | {
    kind: "prose_fact_finding";
    id: string;
    sceneCandidateId: string;
    headingStatementId: string;
    statementId: string;
    atomId: string;
    quote: string;
    questionId: string;
    candidateId: string;
    mechanismId: string;
  };

/**
 * A projected runtime clue is either a structural marked-item clue or an
 * explicitly reviewed NPC relationship fact.  Keeping these shapes separate
 * prevents a prose fact from inheriting fake marked-item source fields.
 */
function runtimeClues(payload: ResolvedCompilerArtifactPayload): RuntimeClueSource[] {
  const marked = payload.clueFactFacetBindings.flatMap((facetBinding) => {
    const clue = payload.draft.clueCandidates.find((candidate) => candidate.id === facetBinding.clueId);
    const nameStatementId = clue?.nameStatementId;
    if (!clue) throw new ProjectionDataError(`facet binding source clue is missing: ${facetBinding.clueId}`);
    const scene = payload.draft.sceneCandidates.find((candidate) => candidate.id === clue.sceneCandidateId);
    if (!scene || !nameStatementId || facetBinding.markedItemStatementId !== clue.markedItemStatementId
      || facetBinding.nameStatementId !== nameStatementId || facetBinding.bodyStatementId !== clue.bodyStatementId
      || facetBinding.headingStatementId !== scene.headingStatementId || facetBinding.sceneCandidateId !== scene.id) {
      throw new ProjectionDataError(`clue facet source is incomplete: ${facetBinding.clueId}`);
    }
    const exactAtoms = (atoms: typeof facetBinding.shellAtoms) => atoms.every((atom) => atom.quote.trim()
      && atom.evidence.spans.length === 1 && atom.evidence.spans[0]?.exactText === atom.quote);
    if (!exactAtoms(facetBinding.shellAtoms) || facetBinding.findings.some((finding) => !exactAtoms(finding.atoms) || !finding.methods.length)) {
      throw new ProjectionDataError(`clue facet evidence is not source-exact: ${facetBinding.clueId}`);
    }
    const shell = facetBinding.shellAtoms.length || facetBinding.findings.length
      ? [{
      kind: "marked_item" as const,
      id: clue.id,
      sceneCandidateId: clue.sceneCandidateId,
      headingStatementId: scene.headingStatementId,
      nameStatementId,
      bodyStatementId: clue.bodyStatementId,
      facetBinding,
      shellAtoms: facetBinding.shellAtoms,
    }] : [];
    const findings = facetBinding.findings.map((finding) => ({
      kind: "clue_fact_finding" as const,
      id: finding.clueId,
      sceneCandidateId: clue.sceneCandidateId,
      headingStatementId: scene.headingStatementId,
      nameStatementId,
      bodyStatementId: clue.bodyStatementId,
      facetBinding,
      finding,
    }));
    return [...shell, ...findings];
  });
  const prose = payload.proseDialogueClues.map((clue) => {
    const paragraph = payload.graph.statements.find((statement) => statement.id === clue.paragraphStatementId);
    const heading = payload.graph.statements.find((statement) => statement.id === clue.headingStatementId);
    const binding = payload.proseNpcBindings.find((candidate) => candidate.npcId === clue.npcId
      && candidate.questionId === clue.questionId && candidate.proseAnchorId === clue.proseAnchorId);
    const method = binding?.dialogueMethods.find((candidate) => candidate.kind === "prose"
      && candidate.mechanismId === clue.mechanismId && candidate.clueId === clue.clueId);
    if (!paragraph || paragraph.kind !== "paragraph" || !heading || heading.kind !== "heading"
      || paragraph.id !== clue.relationshipStatementId || paragraph.parentStatementId !== heading.id
      || !payload.graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === paragraph.id)
      || clue.relationshipQuote !== clue.relationshipQuote.trim() || clue.relationshipQuote.length < 2 || clue.relationshipQuote.length > 240
      || !paragraph.text.includes(clue.relationshipQuote)
      || !binding || binding.paragraphStatementId !== paragraph.id || binding.headingStatementId !== heading.id || binding.sceneCandidateId !== clue.sceneCandidateId
      || !method || method.relationshipStatementId !== clue.relationshipStatementId || method.relationshipQuote !== clue.relationshipQuote) {
      throw new ProjectionDataError(`invalid source-exact prose dialogue clue: ${clue.clueId}`);
    }
    return {
      kind: "prose_dialogue" as const,
      id: clue.clueId,
      sceneCandidateId: clue.sceneCandidateId,
      headingStatementId: clue.headingStatementId,
      paragraphStatementId: clue.paragraphStatementId,
      relationshipStatementId: clue.relationshipStatementId,
      relationshipQuote: clue.relationshipQuote,
      questionId: clue.questionId,
      claimKey: clue.claimKey,
      npcId: clue.npcId,
      mechanismId: clue.mechanismId,
    };
  });
  const proseFacts = payload.sourceFactMechanicBindings
    .filter((binding): binding is Extract<ResolvedCompilerArtifactPayload["sourceFactMechanicBindings"][number], { declarationKind: "prose_fact_finding" }> => binding.declarationKind === "prose_fact_finding")
    .map((binding) => {
      const root = payload.graph.statements.find((statement) => statement.id === binding.statementId);
      const heading = payload.graph.statements.find((statement) => statement.id === binding.headingStatementId);
      const question = payload.resolvedQueue.questions.find((candidate) => candidate.id === binding.questionId);
      const candidate = question?.allowedProseFactFindingCandidates?.find((entry) => entry.id === binding.candidateId);
      const atom = question?.allowedSourceFactAtoms?.find((entry) => entry.id === binding.atomId);
      const method = payload.mechanicsIR.discoveryMethods.find((entry) => entry.id === binding.mechanismId);
      if (!root || !heading || heading.kind !== "heading" || root.parentStatementId !== heading.id
        || !payload.graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === root.id)
        || !candidate || !atom || candidate.atomId !== atom.id || candidate.quote !== binding.quote || atom.quote !== binding.quote
        || atom.evidence.spans.length !== 1 || atom.evidence.spans[0]?.exactText !== binding.quote
        || !method || method.clueId !== binding.clueId || method.action !== "search" || method.target !== "scene" || method.targetId !== binding.sceneCandidateId
        || method.check?.kind !== "attribute" || method.check.attribute !== "edu" || method.check.difficulty !== "regular"
        || method.onSuccess.length !== 1 || method.onSuccess[0]?.kind !== "discover_clue" || method.onSuccess[0]?.clueId !== binding.clueId
        || method.onFailure || method.failback) {
        throw new ProjectionDataError(`invalid source-exact prose fact clue: ${binding.clueId}`);
      }
      return {
        kind: "prose_fact_finding" as const,
        id: binding.clueId,
        sceneCandidateId: binding.sceneCandidateId,
        headingStatementId: binding.headingStatementId,
        statementId: binding.statementId,
        atomId: binding.atomId,
        quote: binding.quote,
        questionId: binding.questionId,
        candidateId: binding.candidateId,
        mechanismId: binding.mechanismId,
      };
    });
  const clues = [...marked, ...prose, ...proseFacts].filter((clue) => payload.mechanicsIR.symbols.clueIds.includes(clue.id));
  if (new Set(clues.map((clue) => clue.id)).size !== clues.length
    || clues.length !== payload.mechanicsIR.symbols.clueIds.length) {
    throw new ProjectionDataError("MechanicsIR clue symbols do not exactly match structural and source-derived prose clues");
  }
  return clues.sort((left, right) => left.id.localeCompare(right.id));
}

function proseDialogueClueOrigin(payload: ResolvedCompilerArtifactPayload, clue: Extract<RuntimeClueSource, { kind: "prose_dialogue" }>): ProjectionFieldOrigin {
  return {
    kind: "resolved_question",
    questionIds: [clue.questionId],
    claimKeys: [clue.claimKey],
    statements: sourceEvidence(payload, [clue.headingStatementId, clue.paragraphStatementId]),
    quotes: [{ statementId: clue.relationshipStatementId, quote: clue.relationshipQuote }],
  };
}

function proseFactFindingClueOrigin(payload: ResolvedCompilerArtifactPayload, clue: Extract<RuntimeClueSource, { kind: "prose_fact_finding" }>): ProjectionFieldOrigin {
  return {
    kind: "resolved_question",
    questionIds: [clue.questionId],
    claimKeys: [`source_fact_mechanic:${clue.statementId}:${clue.candidateId}:finding`],
    statements: sourceEvidence(payload, [clue.headingStatementId, clue.statementId]),
    quotes: [{ statementId: clue.statementId, quote: clue.quote }],
  };
}

/** The source map names every accepted atom/quote; it never uses body text as a display proxy. */
function clueFactClueOrigin(
  payload: ResolvedCompilerArtifactPayload,
  clue: Extract<RuntimeClueSource, { kind: "marked_item" | "clue_fact_finding" }>,
  atoms: ReadonlyArray<{ atomId: string; quote: string; evidence: EvidenceRef }>,
): ProjectionFieldOrigin {
  const atomsAreExact = atoms.every((atom) => atom.quote.trim() && atom.evidence.spans.length === 1 && atom.evidence.spans[0]?.exactText === atom.quote);
  if (!atomsAreExact) throw new ProjectionDataError(`clue fact source map lacks exact atom evidence: ${clue.id}`);
  // A name-only shell is an explicit compiler-derived identity: it has no
  // accepted body-atom claim to cite, so do not manufacture one in sourceMap.
  if (!atoms.length) return artifactOrigin(`resolved.clueFactFacetBindings[${clue.facetBinding.questionId}].shell_name_identity`);
  const quotes = atoms.length
    ? atoms.map((atom) => ({ statementId: clue.bodyStatementId, quote: atom.quote }))
    : [];
  const claimKeys = clue.kind === "marked_item"
    ? atoms.map((atom) => `clue_fact_shell:${clue.id}:${atom.atomId}`)
    : atoms.map((atom) => `clue_fact_finding:${clue.finding.findingKey}:${atom.atomId}`);
  return {
    kind: "resolved_question",
    questionIds: [clue.facetBinding.questionId],
    claimKeys,
    statements: sourceEvidence(payload, [clue.headingStatementId, clue.nameStatementId, clue.bodyStatementId]),
    quotes,
  };
}

function clueFactDisplayText(
  payload: ResolvedCompilerArtifactPayload,
  clue: Extract<RuntimeClueSource, { kind: "marked_item" | "clue_fact_finding" }>,
): string {
  const atoms = clue.kind === "marked_item" ? clue.shellAtoms : clue.finding.atoms;
  if (atoms.length) return atoms.map((atom) => atom.quote).join("\n");
  return sourceStatement(payload, clue.nameStatementId, "shell clue name").text;
}

/**
 * Facet method prose is compiler-owned interaction guidance, not a free
 * selection from the parent marked-item body.  That body can contain
 * source-only or separately gated atoms, so allowing presentation review to
 * quote it would reintroduce a disclosure channel.
 */
function compilerDerivedFacetFindMethods(methods: MechanicsIR["discoveryMethods"]): Clue["findMethods"] {
  return methods.map((method) => {
    const description = method.action === "observe" ? "Observe this clue."
      : method.action === "search" ? "Search this clue."
      : "Read this clue.";
    if (method.check?.kind === "skill") return { type: "skill" as const, skillName: method.check.skill, difficulty: method.check.difficulty, description };
    if (method.action === "observe") return { type: "observation" as const, description };
    return { type: "automatic" as const, description };
  });
}

function refusal(code: CompilerModuleDataProjectionRefusalCode, error: unknown, artifactCode?: CompilerArtifactRefusal["code"]): CompilerModuleDataProjectionRefusal {
  return { status: "refused", code, message: error instanceof Error ? error.message : String(error), ...(artifactCode ? { artifactCode } : {}) };
}

/** Shared projection core; opaque module values are reachable only from a validated trusted review. */
function projectResolvedCompilerArtifactCore(
  payload: ResolvedCompilerArtifactPayload,
  presentation: ModuleDataPresentationMetadata,
  options: { opaqueUnavailableModuleFields?: readonly TrustedPresentationModuleField[] } = {},
): CompilerModuleDataProjection | CompilerModuleDataProjectionRefusal {
  let envelope: CompilerArtifactEnvelope;
  try {
    envelope = createResolvedCompilerArtifact(payload);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return refusal("ARTIFACT_INVALID", error, typeof code === "string" ? code as CompilerArtifactRefusal["code"] : undefined);
  }
  const resolved = envelope.payload as ResolvedCompilerArtifactPayload;
  if (resolved.identity.mechanicsHash !== resolved.mechanicsIR.mechanicsHash || resolved.identity.moduleId !== resolved.mechanicsIR.moduleId || resolved.identity.documentHash !== resolved.mechanicsIR.documentHash || resolved.identity.sourceGraphIdentity !== resolved.mechanicsIR.sourceGraphIdentity) {
    return refusal("MECHANICS_IDENTITY_MISMATCH", "artifact and MechanicsIR identities do not agree");
  }
  try {
    if (presentation.module.ruleset !== "cosmic-horror") throw new ProjectionDataError("compiled modules require the cosmic-horror ruleset");
    const opaqueUnavailableModuleFields = new Set(options.opaqueUnavailableModuleFields ?? []);
    if ([...opaqueUnavailableModuleFields].some((field) => !TRUSTED_PRESENTATION_MODULE_FIELDS.includes(field))) {
      throw new ProjectionDataError("compiled presentation has an invalid opaque module metadata disclosure");
    }
    const playableIds = [...resolved.mechanicsIR.symbols.sceneIds].sort();
    const clueIds = [...resolved.mechanicsIR.symbols.clueIds].sort();
    const boundNpcIds = resolved.proseNpcBindings.map((binding) => binding.npcId).sort();
    if (new Set(boundNpcIds).size !== boundNpcIds.length
      || canonicalJson([...resolved.mechanicsIR.symbols.npcIds].sort()) !== canonicalJson(boundNpcIds)) {
      throw new ProjectionDataError("MechanicsIR NPC symbols do not exactly match reviewed prose NPC bindings");
    }
    const connectionIds = [...resolved.analysisInput.connections.map((connection) => connection.id)].sort();
    const endingById = new Map(resolved.mechanicsIR.endings.map((ending) => {
      const effect = ending.effects.find((candidate) => candidate.kind === "end_game");
      if (!effect) throw new ProjectionDataError(`ending lacks end_game: ${ending.id}`);
      return [effect.endingId, ending] as const;
    }));
    const endingIds = [...endingById.keys()].sort();
    assertExactKeys(presentation.scenes, playableIds, "scene");
    assertExactKeys(presentation.clues, clueIds, "clue");
    assertExactKeys(presentation.connections, connectionIds, "connection");
    assertExactKeys(presentation.endings, endingIds, "ending");
    for (const [label, value] of Object.entries(presentation.module)) {
      const moduleField = label as TrustedPresentationModuleField;
      if (typeof value === "string") {
        if (opaqueUnavailableModuleFields.has(moduleField)) {
          if (value !== "") throw new ProjectionDataError(`module.${label} must be empty when its source is opaque_unavailable`);
        } else {
          requiredText(value, `module.${label}`);
        }
      }
      if (Array.isArray(value)) {
        if (opaqueUnavailableModuleFields.has(moduleField) && value.length !== 0) throw new ProjectionDataError(`module.${label} must be empty when its source is opaque_unavailable`);
        if (value.some((entry) => !entry.trim())) throw new ProjectionDataError(`module.${label} contains blank metadata`);
      }
    }
    const sourceMap: ModuleDataProjectionSourceMap = { module: { fields: Object.create(null) }, scenes: Object.create(null), npcs: Object.create(null), items: Object.create(null), endings: Object.create(null) };
    for (const key of ["title", "version", "ruleset", "era", "summary", "playerCount", "expectedDuration", "triggerWarnings"] as const) {
      sourceMap.module.fields[key] = key === "ruleset"
        ? artifactOrigin("compiled.ruleset")
        : metadataOrigin(`module.${key}`);
    }
    const connectionsByScene = new Map(playableIds.map((id) => [id, [] as typeof resolved.analysisInput.connections]));
    for (const connection of resolved.analysisInput.connections) connectionsByScene.get(connection.fromSceneId)?.push(connection);
    const runtimeClueEntries = runtimeClues(resolved);
    const cluesByScene = new Map(playableIds.map((id) => [id, [] as RuntimeClueSource[]]));
    for (const clue of runtimeClueEntries) {
      cluesByScene.get(clue.sceneCandidateId)?.push(clue);
    }
    const sceneNpcs = new Map(playableIds.map((id) => [id, [] as ResolvedCompilerArtifactPayload["proseNpcBindings"]]));
    for (const binding of resolved.proseNpcBindings) {
      const anchor = resolved.draft.proseNpcAnchors.find((candidate) => candidate.id === binding.proseAnchorId);
      const paragraph = resolved.graph.statements.find((statement) => statement.id === binding.paragraphStatementId);
      if (!anchor || !paragraph || paragraph.kind !== "paragraph" || !paragraph.text.includes(binding.nameQuote)
        || anchor.paragraphStatementId !== binding.paragraphStatementId
        || anchor.headingStatementId !== binding.headingStatementId
        || anchor.sceneCandidateId !== binding.sceneCandidateId
        || !playableIds.includes(binding.sceneCandidateId)) {
        throw new ProjectionDataError(`invalid prose NPC binding: ${binding.npcId}`);
      }
      for (const dialogue of binding.dialogueMethods) {
        const method = resolved.mechanicsIR.discoveryMethods.find((candidate) => candidate.id === dialogue.mechanismId);
        if (!method || method.clueId !== dialogue.clueId || method.action !== "talk" || method.target !== "npc" || method.targetId !== binding.npcId
          || resolved.analysisInput.discoveryLocations[method.id] !== binding.sceneCandidateId) {
          throw new ProjectionDataError(`invalid prose NPC dialogue binding: ${dialogue.mechanismId}`);
        }
        if (dialogue.kind === "prose") {
          const proseClue = resolved.proseDialogueClues.find((candidate) => candidate.npcId === binding.npcId
            && candidate.mechanismId === dialogue.mechanismId && candidate.clueId === dialogue.clueId);
          if (!proseClue || proseClue.relationshipStatementId !== dialogue.relationshipStatementId
            || proseClue.relationshipQuote !== dialogue.relationshipQuote
            || method.onSuccess.length !== 1 || method.onSuccess[0]?.kind !== "discover_clue"
            || method.onSuccess[0].clueId !== dialogue.clueId) {
            throw new ProjectionDataError(`invalid prose NPC dialogue clue binding: ${dialogue.mechanismId}`);
          }
        }
      }
      const encounter = binding.encounter;
      const definition = resolved.mechanicsIR.encounterDefinitions.find((candidate) => candidate.combatantId === binding.npcId);
      if (encounter) {
        if (!definition || definition.encounterId !== encounter.encounterId || definition.id !== encounter.encounterId
          || definition.sceneId !== binding.sceneCandidateId || definition.sceneId !== encounter.sceneId
          || definition.combatantId !== binding.npcId || definition.maxHp !== encounter.maxHp
          || definition.dodge !== encounter.dodge || definition.fight !== encounter.fight
          || canonicalJson(definition.npcDamage) !== canonicalJson(encounter.npcDamage)
          || canonicalJson(definition.victoryEffects) !== canonicalJson(encounter.victoryEffects)
          || !encounter.sourceStatementIds.every((id) => resolved.graph.statements.some((statement) => statement.id === id))) {
          throw new ProjectionDataError(`invalid source-bound NPC encounter binding: ${binding.npcId}`);
        }
      } else if (definition) {
        throw new ProjectionDataError(`encounter definition has no reviewed NPC encounter binding: ${definition.encounterId}`);
      }
      sceneNpcs.get(binding.sceneCandidateId)!.push(binding);
    }
    const npcs: ModuleNPC[] = [...resolved.proseNpcBindings]
      .sort((left, right) => left.npcId.localeCompare(right.npcId))
      .map((binding) => {
        const paragraph = resolved.graph.statements.find((statement) => statement.id === binding.paragraphStatementId)!;
        sourceMap.npcs[binding.npcId] = { fields: {
          id: questionOrigin(resolved, binding),
          name: questionOrigin(resolved, binding),
          role: artifactOrigin("compiled.prose_npc_defaults.role"),
          description: sourceOrigin(resolved, [paragraph.id]),
          personality: artifactOrigin("compiled.prose_npc_defaults.personality"),
          knowledge: artifactOrigin("compiled.prose_npc_defaults.knowledge"),
          secrets: artifactOrigin("compiled.prose_npc_defaults.secrets"),
          sceneId: questionOrigin(resolved, binding),
          ...(binding.encounter ? { encounter: encounterQuestionOrigin(resolved, binding) } : {}),
        } };
        return {
          id: binding.npcId,
          name: binding.nameQuote,
          role: "",
          description: paragraph.text,
          personality: { traits: [], speech: "", attitude: "" },
          knowledge: [],
          secrets: [],
          sceneId: binding.sceneCandidateId,
        };
      });
    const items: ModuleItem[] = [...resolved.itemBindings]
      .sort((left, right) => left.itemId.localeCompare(right.itemId))
      .map((binding) => {
        const candidate = resolved.draft.itemCandidates.find((item) => item.id === binding.itemCandidateId);
        const scene = resolved.draft.sceneCandidates.find((entry) => entry.id === binding.sceneCandidateId);
        const heading = resolved.graph.statements.find((statement) => statement.id === binding.headingStatementId);
        const marked = resolved.graph.statements.find((statement) => statement.id === binding.markedItemStatementId);
        const name = resolved.graph.statements.find((statement) => statement.id === binding.nameStatementId);
        const body = resolved.graph.statements.find((statement) => statement.id === binding.bodyStatementId);
        const itemName = resolved.graph.statements.find((statement) => statement.id === binding.itemNameStatementId);
        const scopedByHeading = resolved.graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === binding.headingStatementId && relation.to === binding.markedItemStatementId);
        const nameIsMarkedChild = resolved.graph.relations.some((relation) => relation.kind === "marked_item_name" && relation.from === binding.markedItemStatementId && relation.to === binding.nameStatementId);
        const bodyIsMarkedChild = resolved.graph.relations.some((relation) => relation.kind === "marked_item_body" && relation.from === binding.markedItemStatementId && relation.to === binding.bodyStatementId);
        if (!candidate || !scene || scene.headingStatementId !== binding.headingStatementId
          || !heading || heading.kind !== "heading"
          || !marked || marked.kind !== "marked_item" || marked.parentStatementId !== heading.id || !scopedByHeading
          || !name || name.kind !== "marked_item_name" || name.parentStatementId !== marked.id || !nameIsMarkedChild
          || !body || body.kind !== "marked_item_body" || body.parentStatementId !== marked.id || !bodyIsMarkedChild
          || !itemName || (itemName.id !== name.id && itemName.id !== body.id)
          || (itemName.kind !== "marked_item_name" && itemName.kind !== "marked_item_body") || itemName.parentStatementId !== marked.id
          || binding.itemNameQuote !== binding.itemNameQuote.trim() || binding.itemNameQuote.length < 2 || binding.itemNameQuote.length > 120
          || !itemName.text.includes(binding.itemNameQuote)
          || candidate.id !== binding.itemId
          || candidate.markedItemStatementId !== binding.markedItemStatementId
          || candidate.nameStatementId !== binding.nameStatementId
          || candidate.bodyStatementId !== binding.bodyStatementId
          || candidate.sceneCandidateId !== binding.sceneCandidateId
          || !playableIds.includes(binding.sceneCandidateId)
          || !resolved.mechanicsIR.symbols.itemIds.includes(binding.itemId)) {
          throw new ProjectionDataError(`invalid item binding: ${binding.itemId}`);
        }
        sourceMap.items[binding.itemId] = { fields: {
          id: itemQuestionOrigin(resolved, binding),
          name: itemQuestionOrigin(resolved, binding),
          sceneId: itemQuestionOrigin(resolved, binding),
          description: sourceOrigin(resolved, [body.id]),
          type: itemQuestionOrigin(resolved, binding),
        } };
        return { id: binding.itemId, name: binding.itemNameQuote, sceneId: binding.sceneCandidateId, description: body.text, type: binding.itemType };
      });
    const scenes: Scene[] = playableIds.map((sceneId) => {
      const candidate = resolved.draft.sceneCandidates.find((scene) => scene.id === sceneId);
      if (!candidate) throw new ProjectionDataError(`playable scene candidate missing: ${sceneId}`);
      const heading = resolved.graph.statements.find((statement) => statement.id === candidate.headingStatementId);
      if (!heading) throw new ProjectionDataError(`scene heading statement missing: ${sceneId}`);
      const sceneMetadata = presentation.scenes[sceneId]!;
      requiredText(sceneMetadata.description, `scenes.${sceneId}.description`);
      const map = {
        fields: Object.create(null) as Record<string, ProjectionFieldOrigin>,
        clues: Object.create(null) as Record<string, {
          fields: Record<string, ProjectionFieldOrigin>;
          findMethods: Record<string, { fields: Record<"description", ProjectionFieldOrigin> }>;
        }>,
        connections: Object.create(null) as Record<string, { fields: Record<string, ProjectionFieldOrigin> }>,
      };
      map.fields.id = artifactOrigin(`draft.sceneCandidates[${sceneId}].id`);
      map.fields.name = sourceOrigin(resolved, [heading.id]);
      map.fields.description = metadataOrigin(`scenes.${sceneId}.description`);
      const bindings = (sceneNpcs.get(sceneId) ?? []).sort((left, right) => left.npcId.localeCompare(right.npcId));
      if (bindings.length) map.fields.npcIds = {
        kind: "resolved_question",
        questionIds: bindings.map((binding) => binding.questionId),
        claimKeys: bindings.map((binding) => binding.claimKey),
        statements: sourceEvidence(resolved, [...new Set(bindings.flatMap((binding) => [binding.headingStatementId, binding.paragraphStatementId]))]),
        quotes: bindings.map((binding) => ({ statementId: binding.paragraphStatementId, quote: binding.nameQuote })),
      };
      else map.fields.npcIds = artifactOrigin("resolved.proseNpcBindings.empty");
      const clues: Clue[] = (cluesByScene.get(sceneId) ?? []).sort((left, right) => left.id.localeCompare(right.id)).map((clue) => {
        const metadata = presentation.clues[clue.id]!;
        requiredText(metadata.revelation, `clues.${clue.id}.revelation`);
        assertFindMethods(metadata.findMethods, `clues.${clue.id}`);
        assertStringArray(metadata.unlocks, `clues.${clue.id}.unlocks`);
        if (!["core", "bonus", "color"].includes(metadata.importance)) throw new ProjectionDataError(`clues.${clue.id}.importance is invalid`);
        const nameStatementId = clue.kind === "prose_dialogue" ? clue.relationshipStatementId
          : clue.kind === "prose_fact_finding" ? clue.statementId : clue.nameStatementId;
        const bodyStatementId = clue.kind === "prose_dialogue" ? clue.relationshipStatementId
          : clue.kind === "prose_fact_finding" ? clue.statementId : clue.bodyStatementId;
        const nameStatement = resolved.graph.statements.find((statement) => statement.id === nameStatementId);
        const bodyStatement = resolved.graph.statements.find((statement) => statement.id === bodyStatementId);
        if (!nameStatement || !bodyStatement) throw new ProjectionDataError(`clue source statements missing: ${clue.id}`);
        const proseOrigin = clue.kind === "prose_dialogue" ? proseDialogueClueOrigin(resolved, clue)
          : clue.kind === "prose_fact_finding" ? proseFactFindingClueOrigin(resolved, clue) : undefined;
        const factClue = clue.kind === "marked_item" || clue.kind === "clue_fact_finding" ? clue : undefined;
        const factAtoms = factClue?.kind === "marked_item" ? factClue.shellAtoms : factClue?.finding.atoms;
        const factOrigin = factClue && factAtoms ? clueFactClueOrigin(resolved, factClue, factAtoms) : undefined;
        const methods = resolved.mechanicsIR.discoveryMethods.filter((method) => method.clueId === clue.id).sort((left, right) => left.id.localeCompare(right.id));
        const proseFact = clue.kind === "prose_fact_finding";
        const findMethods = factAtoms || proseFact ? compilerDerivedFacetFindMethods(methods) : structuredClone(metadata.findMethods);
        const clueName = clue.kind === "prose_dialogue" ? clue.relationshipQuote
          : proseFact ? clue.quote
            : clue.kind === "clue_fact_finding" ? clueFactDisplayText(resolved, clue) : nameStatement.text;
        const clueDescription = clue.kind === "prose_dialogue" ? clue.relationshipQuote
          : proseFact ? clue.quote
            : factAtoms ? clueFactDisplayText(resolved, clue) : bodyStatement.text;
        if ((factAtoms || proseFact) && metadata.revelation !== clueDescription) {
          throw new ProjectionDataError(`clues.${clue.id}.revelation must exactly equal accepted source facets`);
        }
        if (proseFact && metadata.importance === "core") {
          throw new ProjectionDataError(`clues.${clue.id}.importance must remain optional for a prose fact finding`);
        }
        map.clues[clue.id] = {
          fields: {
            id: proseOrigin ?? factOrigin ?? artifactOrigin(`draft.clueCandidates[${clue.id}].id`),
            // A canonical shell's name remains its structural marked-item
            // name.  Only a derived finding's name is its selected finding
            // atom; never claim that a body atom supplied the shell name.
            name: proseOrigin ?? (clue.kind === "clue_fact_finding" ? factOrigin! : sourceOrigin(resolved, [nameStatement.id])),
            description: proseOrigin ?? (factAtoms ? factOrigin! : sourceOrigin(resolved, [bodyStatement.id])),
            findMethods: factAtoms ? artifactOrigin(`resolved.clueFactFacetBindings[${factClue!.facetBinding.questionId}].compiler_derived_find_methods`)
              : proseFact ? artifactOrigin(`resolved.sourceFactMechanicBindings[${clue.questionId}].compiler_derived_prose_finding_guidance`)
                : metadataOrigin(`clues.${clue.id}.findMethods`),
            revelation: proseOrigin ?? (factAtoms ? factOrigin! : metadataOrigin(`clues.${clue.id}.revelation`)),
            unlocks: metadataOrigin(`clues.${clue.id}.unlocks`),
            importance: metadataOrigin(`clues.${clue.id}.importance`),
          },
          findMethods: factAtoms || proseFact
            ? Object.fromEntries(methods.map((method) => [method.id, { fields: { description: artifactOrigin(`mechanics.discoveryMethods[${method.id}].compiler_derived_facet_guidance`) } }]))
            : Object.create(null),
        };
        return { id: clue.id, name: clueName, description: clueDescription, findMethods, revelation: metadata.revelation, unlocks: [...metadata.unlocks], found: false, importance: metadata.importance };
      });
      const connections: SceneConnection[] = (connectionsByScene.get(sceneId) ?? []).sort((left, right) => left.id.localeCompare(right.id)).map((connection) => {
        const metadata = presentation.connections[connection.id]!;
        requiredText(metadata.condition, `connections.${connection.id}.condition`);
        const gate = resolved.mechanicsIR.connections.find((candidate) => candidate.connectionId === connection.id);
        if (!gate) throw new ProjectionDataError(`connection mechanism missing: ${connection.id}`);
        map.connections[connection.id] = {
          fields: {
            connectionId: artifactOrigin(`analysisInput.connections[${connection.id}].id`),
            targetSceneId: interpretationEvidence(resolved, gate.sourceInterpretationIds),
            condition: metadataOrigin(`connections.${connection.id}.condition`),
          },
        };
        return { connectionId: connection.id, targetSceneId: connection.toSceneId, condition: metadata.condition };
      });
      sourceMap.scenes[sceneId] = map;
      return { id: sceneId, name: heading.text, description: sceneMetadata.description, clues, npcIds: bindings.map((binding) => binding.npcId), connections };
    });
      const endings: Ending[] = endingIds.map((endingId) => {
      const metadata = presentation.endings[endingId]!;
      requiredText(metadata.name, `endings.${endingId}.name`);
      requiredText(metadata.description, `endings.${endingId}.description`);
      assertStringArray(metadata.conditions, `endings.${endingId}.conditions`);
      if (metadata.conditions.some((condition) => !condition.trim())) throw new ProjectionDataError(`endings.${endingId}.conditions contains blank metadata`);
      const ending = endingById.get(endingId)!;
      sourceMap.endings[endingId] = { fields: { id: interpretationEvidence(resolved, ending.sourceInterpretationIds), name: metadataOrigin(`endings.${endingId}.name`), description: metadataOrigin(`endings.${endingId}.description`), conditions: metadataOrigin(`endings.${endingId}.conditions`) } };
      return { id: endingId, name: metadata.name, description: metadata.description, conditions: [...metadata.conditions] };
    });
    const module: ModuleData = { id: resolved.identity.moduleId, title: presentation.module.title, version: presentation.module.version, ruleset: presentation.module.ruleset, era: presentation.module.era, summary: presentation.module.summary, scenes, npcs, meta: { playerCount: presentation.module.playerCount, expectedDuration: presentation.module.expectedDuration, triggerWarnings: [...presentation.module.triggerWarnings] }, endings, items };
    return { status: "projected", module, entrySceneId: resolved.analysisInput.entrySceneId, artifact: { artifactHash: envelope.artifactHash, identity: resolved.identity }, mechanics: { moduleId: resolved.mechanicsIR.moduleId, documentHash: resolved.mechanicsIR.documentHash, sourceGraphIdentity: resolved.mechanicsIR.sourceGraphIdentity, mechanicsHash: resolved.mechanicsIR.mechanicsHash }, sourceMap };
  } catch (error) {
    if (error instanceof ProjectionDataError) return refusal("PRESENTATION_METADATA_INVALID", error);
    throw error;
  }
}

/** Project caller-supplied presentation metadata with no opaque-field escape hatch. */
export function projectResolvedCompilerArtifact(
  payload: ResolvedCompilerArtifactPayload,
  presentation: ModuleDataPresentationMetadata,
): CompilerModuleDataProjection | CompilerModuleDataProjectionRefusal {
  return projectResolvedCompilerArtifactCore(payload, presentation);
}

function sameCanonical(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

/** Canonical identity for immutable, catalog-owned presentation review records. */
export function trustedPresentationReviewIdentity(review: Omit<TrustedPresentationReview, "reviewHash"> | TrustedPresentationReview): string {
  const { reviewHash: _reviewHash, ...unsigned } = review as TrustedPresentationReview;
  return sha256(canonicalJson(unsigned));
}

/** The receipt binds canonical bindings and the host-checked visibility map. */
export function trustedPresentationMachineDecisionIdentity(
  bindings: readonly TrustedPresentationBinding[],
  scopes: readonly TrustedPresentationMachineScope[],
): string {
  return sha256(canonicalJson({
    bindings: [...bindings].sort((left, right) => left.fieldPath.localeCompare(right.fieldPath)),
    scopes: [...scopes].sort((left, right) => left.fieldPath.localeCompare(right.fieldPath)),
  }));
}

export function trustedPresentationMachineCoverageIdentity(scopes: readonly TrustedPresentationMachineScope[]): string {
  return sha256(canonicalJson([...scopes].sort((left, right) => left.fieldPath.localeCompare(right.fieldPath))));
}

function validMachinePublication(review: TrustedPresentationReview): boolean {
  const publication = review.machinePublication;
  if (publication === undefined) return true;
  if (!isRecord(publication)
    || !assertExactBindingKeys(publication, ["servicePrincipalId", "policyId", "requestHash", "responseHash", "decisionHash", "coverageHash", "scopes"])
    || typeof publication.servicePrincipalId !== "string" || !publication.servicePrincipalId.trim()
    || typeof publication.policyId !== "string" || !publication.policyId.trim()
    || !/^[a-f0-9]{64}$/.test(publication.requestHash)
    || !/^[a-f0-9]{64}$/.test(publication.responseHash)
    || !/^[a-f0-9]{64}$/.test(publication.decisionHash)
    || !/^[a-f0-9]{64}$/.test(publication.coverageHash)
    || !Array.isArray(publication.scopes)) return false;
  const paths = new Set<string>();
  if (publication.scopes.some((scope) => {
    if (!isRecord(scope)
      || !assertExactBindingKeys(scope, ["fieldPath", "audience"])
      || typeof scope.fieldPath !== "string" || !scope.fieldPath.trim()
      || (scope.audience !== "public_on_entry" && scope.audience !== "found_clue" && scope.audience !== "terminal_only" && scope.audience !== "private_context")
      || trustedPresentationAudienceForFieldPath(scope.fieldPath) !== scope.audience
      || paths.has(scope.fieldPath)) return true;
    paths.add(scope.fieldPath);
    return false;
  })) return false;
  const bindingPaths = new Set(review.bindings.map((binding) => binding.fieldPath));
  if (paths.size !== bindingPaths.size || [...bindingPaths].some((fieldPath) => !paths.has(fieldPath))) return false;
  const scopes = publication.scopes as TrustedPresentationMachineScope[];
  return publication.coverageHash === trustedPresentationMachineCoverageIdentity(scopes)
    && publication.decisionHash === trustedPresentationMachineDecisionIdentity(review.bindings, scopes);
}

/** Catalog replay uses the same finite audience contract as projection. */
export function validateTrustedPresentationMachinePublication(review: TrustedPresentationReview): boolean {
  return validMachinePublication(review);
}

function sourceStatement(payload: ResolvedCompilerArtifactPayload, id: string, label: string) {
  const statement = payload.graph.statements.find((candidate) => candidate.id === id);
  if (!statement) throw new ProjectionDataError(`${label} references an unknown source statement`);
  return statement;
}

function headingScopesStatement(payload: ResolvedCompilerArtifactPayload, headingStatementId: string, statementId: string): boolean {
  const heading = sourceStatement(payload, headingStatementId, "presentation review heading");
  if (heading.kind !== "heading") return false;
  let currentId: string | undefined = statementId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    if (heading.id === currentId || payload.graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === currentId)) return true;
    currentId = sourceStatement(payload, currentId, "presentation review scope").parentStatementId;
  }
  return false;
}

function interpretationStatementIds(payload: ResolvedCompilerArtifactPayload, ids: readonly string[]): Set<string> {
  const statements = new Set<string>();
  for (const id of ids) {
    const interpretation = payload.acceptedInterpretations.find((candidate) => candidate.id === id);
    if (!interpretation) throw new ProjectionDataError(`presentation review references an unknown interpretation: ${id}`);
    for (const statementId of interpretation.sourceStatementIds) statements.add(statementId);
  }
  return statements;
}

interface ReviewBindingRule {
  fieldPath: string;
  /** Source-exact is forbidden when omitted (for opaque-only disclosures). */
  sourceExact?: {
    headingStatementId?: string;
    statementId?: string;
    allowedStatementIds?: ReadonlySet<string>;
    /** Some projected fields deliberately require the entire source value. */
    exactQuote?: string;
    quotePolicy: TrustedPresentationQuotePolicy;
  };
  allowsOpaque?: boolean;
}

interface TrustedPresentationReviewPlanContract {
  rules: ReviewBindingRule[];
}

function sourceExactCandidates(
  payload: ResolvedCompilerArtifactPayload,
  fieldPath: string,
  rule: NonNullable<ReviewBindingRule["sourceExact"]>,
  machinePublicRelease = false,
): TrustedPresentationTextBinding[] {
  const statementIds = rule.statementId
    ? [rule.statementId]
    : rule.allowedStatementIds
      ? [...rule.allowedStatementIds].sort()
      : payload.graph.statements.map((statement) => statement.id).sort();
  const headings = payload.graph.statements.filter((statement) => statement.kind === "heading").sort((left, right) => left.id.localeCompare(right.id));
  const candidates: TrustedPresentationTextBinding[] = [];
  for (const statementId of statementIds) {
    const statement = sourceStatement(payload, statementId, `presentation review ${fieldPath}`);
    if (!statement.text.trim()) continue;
    const headingIds = rule.headingStatementId
      ? [rule.headingStatementId]
      : headings.filter((heading) => headingScopesStatement(payload, heading.id, statement.id)).map((heading) => heading.id);
    for (const headingStatementId of headingIds) {
      if (!headingScopesStatement(payload, headingStatementId, statement.id)) continue;
      const binding: TrustedPresentationTextBinding = {
        kind: "source_exact",
        fieldPath,
        statementId: statement.id,
        quote: rule.exactQuote ?? statement.text,
        evidenceRefId: statement.evidenceRefId,
        headingStatementId,
      };
      if (!machinePublicRelease || machineSourceExactBindingHasPublicClearance(payload, binding)) candidates.push(binding);
    }
  }
  return candidates.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

/** Count a rule's candidate domain without constructing source text/bindings. */
function sourceExactCandidateCount(
  payload: ResolvedCompilerArtifactPayload,
  fieldPath: string,
  rule: NonNullable<ReviewBindingRule["sourceExact"]>,
  machinePublicRelease = false,
): number {
  return sourceExactCandidates(payload, fieldPath, rule, machinePublicRelease).length;
}

/**
 * The one authoritative contract for both a workbench's offered selections
 * and the projection validator. It intentionally contains source domain and
 * heading rules, not renderer-provided prose or executable topology.
 */
function trustedPresentationReviewPlanContract(payload: ResolvedCompilerArtifactPayload): TrustedPresentationReviewPlanContract {
  const playableIds = [...payload.mechanicsIR.symbols.sceneIds].sort();
  const sceneById = new Map(payload.draft.sceneCandidates.map((scene) => [scene.id, scene]));
  const runtimeClueById = new Map(runtimeClues(payload).map((clue) => [clue.id, clue]));
  const connectionById = new Map(payload.analysisInput.connections.map((connection) => [connection.id, connection]));
  const endingById = new Map(payload.mechanicsIR.endings.map((ending) => {
    const effect = ending.effects.find((candidate) => candidate.kind === "end_game");
    if (!effect) throw new ProjectionDataError(`ending lacks end_game: ${ending.id}`);
    return [effect.endingId, ending] as const;
  }));
  const rules: ReviewBindingRule[] = [];
  const add = (rule: ReviewBindingRule) => rules.push(rule);

  for (const field of TRUSTED_PRESENTATION_MODULE_FIELDS) {
    add({ fieldPath: `module.${field}`, ...(field === "triggerWarnings" ? { allowsOpaque: true } : { sourceExact: { quotePolicy: "exact_nonempty_substring" }, allowsOpaque: true }) });
  }
  for (const sceneId of playableIds) {
    const scene = sceneById.get(sceneId);
    if (!scene) throw new ProjectionDataError(`playable scene candidate missing: ${sceneId}`);
    const heading = sourceStatement(payload, scene.headingStatementId, `scene heading ${sceneId}`);
    if (heading.kind !== "heading") throw new ProjectionDataError(`playable scene heading is invalid: ${sceneId}`);
    add({ fieldPath: `scenes.${sceneId}.name`, sourceExact: { headingStatementId: heading.id, statementId: heading.id, exactQuote: heading.text, quotePolicy: "exact_whole_statement" } });
    add({ fieldPath: `scenes.${sceneId}.description`, sourceExact: { headingStatementId: heading.id, quotePolicy: "exact_nonempty_substring" } });
  }
  for (const [connectionId, connection] of [...connectionById.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const scene = sceneById.get(connection.fromSceneId);
    const gate = payload.mechanicsIR.connections.find((candidate) => candidate.connectionId === connectionId);
    if (!scene || !gate) throw new ProjectionDataError(`connection mechanism missing: ${connectionId}`);
    add({
      fieldPath: `connections.${connectionId}.condition`,
      sourceExact: { headingStatementId: scene.headingStatementId, allowedStatementIds: interpretationStatementIds(payload, gate.sourceInterpretationIds), quotePolicy: "exact_nonempty_substring" },
    });
  }
  for (const [clueId, clue] of [...runtimeClueById.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const scene = sceneById.get(clue.sceneCandidateId);
    if (!scene) throw new ProjectionDataError(`clue scene is incomplete: ${clueId}`);
    if (clue.kind === "prose_dialogue") {
      add({ fieldPath: `clues.${clueId}.name`, sourceExact: { headingStatementId: scene.headingStatementId, statementId: clue.relationshipStatementId, exactQuote: clue.relationshipQuote, quotePolicy: "exact_nonempty_substring" } });
      add({ fieldPath: `clues.${clueId}.description`, sourceExact: { headingStatementId: scene.headingStatementId, statementId: clue.relationshipStatementId, exactQuote: clue.relationshipQuote, quotePolicy: "exact_nonempty_substring" } });
      add({ fieldPath: `clues.${clueId}.revelation`, sourceExact: { headingStatementId: scene.headingStatementId, quotePolicy: "exact_nonempty_substring" } });
    }
    // Facet text was already selected and source-validated by the 3.2 queue.
    // It is not a free presentation-review choice: one binding cannot preserve
    // a multi-atom result without either dropping atoms or exposing its body.
    if (clue.kind === "prose_dialogue") for (const method of payload.mechanicsIR.discoveryMethods.filter((candidate) => candidate.clueId === clueId).sort((left, right) => left.id.localeCompare(right.id))) {
      add({
        fieldPath: `clues.${clueId}.findMethods.${method.id}.description`,
        sourceExact: { headingStatementId: scene.headingStatementId, allowedStatementIds: interpretationStatementIds(payload, method.sourceInterpretationIds), quotePolicy: "exact_nonempty_substring" },
      });
    }
  }
  for (const [endingId, ending] of [...endingById.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const allowedStatementIds = interpretationStatementIds(payload, ending.sourceInterpretationIds);
    for (const field of ["name", "description", "conditions.0"] as const) {
      add({ fieldPath: `endings.${endingId}.${field}`, sourceExact: { allowedStatementIds, quotePolicy: "exact_nonempty_substring" } });
    }
  }
  for (const item of [...payload.itemBindings].sort((left, right) => left.itemId.localeCompare(right.itemId))) {
    const name = sourceStatement(payload, item.nameStatementId, `item name ${item.itemId}`);
    const description = sourceStatement(payload, item.bodyStatementId, `item description ${item.itemId}`);
    add({ fieldPath: `items.${item.itemId}.name`, sourceExact: { headingStatementId: item.headingStatementId, statementId: name.id, exactQuote: name.text, quotePolicy: "exact_whole_statement" } });
    add({ fieldPath: `items.${item.itemId}.description`, sourceExact: { headingStatementId: item.headingStatementId, statementId: description.id, exactQuote: description.text, quotePolicy: "exact_whole_statement" } });
  }
  for (const npc of [...payload.proseNpcBindings].sort((left, right) => left.npcId.localeCompare(right.npcId))) {
    const paragraph = sourceStatement(payload, npc.paragraphStatementId, `NPC paragraph ${npc.npcId}`);
    add({ fieldPath: `npcs.${npc.npcId}.name`, sourceExact: { headingStatementId: npc.headingStatementId, statementId: paragraph.id, exactQuote: npc.nameQuote, quotePolicy: "exact_nonempty_substring" } });
    add({ fieldPath: `npcs.${npc.npcId}.description`, sourceExact: { headingStatementId: npc.headingStatementId, statementId: paragraph.id, exactQuote: paragraph.text, quotePolicy: "exact_whole_statement" } });
  }

  return { rules: rules.sort((left, right) => left.fieldPath.localeCompare(right.fieldPath)) };
}

/**
 * Machine publication has a narrower public-release domain than an operator
 * review.  The source graph has no generic player-visible annotation, so this
 * deliberately uses only the compiler's finite, already-bound disclosure
 * facts.  It is not a prose classifier: matching requires the same source
 * statement plus its exact compiler-bound quote (or an explicitly private
 * whole paragraph/body statement).
 */
function machineSourceExactBindingHasPublicClearance(
  payload: ResolvedCompilerArtifactPayload,
  binding: TrustedPresentationTextBinding,
  allBindings: readonly TrustedPresentationBinding[] = [],
): boolean {
  // Scene headings are mandatory public identities: their slots have no
  // opaque alternative and require the exact whole heading.  Reject an
  // ending candidate that reuses the same source range while the candidate
  // page is being built, rather than leaving a selector to discover only at
  // the final all-binding check that no legal combination exists.
  if (/^endings\.[^.]+\./.test(binding.fieldPath)) {
    const statement = sourceStatement(payload, binding.statementId, `machine release ${binding.fieldPath}`);
    const overlapsMandatorySceneHeading = payload.mechanicsIR.symbols.sceneIds
      .map((sceneId) => payload.draft.sceneCandidates.find((scene) => scene.id === sceneId))
      .filter((scene): scene is NonNullable<typeof scene> => !!scene)
      .some((scene) => {
        const heading = sourceStatement(payload, scene.headingStatementId, `scene heading ${scene.id}`);
        return heading.id === binding.statementId
          && sourceQuoteRangesOverlap(statement.text, binding.quote, heading.text);
      });
    if (overlapsMandatorySceneHeading) return false;
  }
  if (trustedPresentationAudienceForFieldPath(binding.fieldPath) !== "public_on_entry") return true;

  const npcName = /^npcs\.([^.]+)\.name$/.exec(binding.fieldPath)?.[1];
  if (npcName) {
    const npc = payload.proseNpcBindings.find((candidate) => candidate.npcId === npcName);
    // A source-bound name is a deliberately public identity, not permission
    // to release the rest of the NPC's private paragraph.
    if (npc
      && binding.statementId === npc.paragraphStatementId
      && binding.quote === npc.nameQuote) return true;
  }

  const itemName = /^items\.([^.]+)\.name$/.exec(binding.fieldPath)?.[1];
  if (itemName) {
    const item = payload.itemBindings.find((candidate) => candidate.itemId === itemName);
    // Existing player-facing item state consumes only this exact canonical
    // identity; neither an item body nor the same source in another field is
    // thereby cleared.
    if (item
      && binding.statementId === item.nameStatementId
      && binding.quote === sourceStatement(payload, item.nameStatementId, `item name ${item.itemId}`).text) return true;
  }

  const wholeProtectedStatements = new Set<string>();
  const protectedQuotes = new Map<string, Set<string>>();
  const protectQuote = (statementId: string, quote: string) => {
    if (!quote.trim()) throw new ProjectionDataError("machine release clearance has an empty protected quote");
    const values = protectedQuotes.get(statementId) ?? new Set<string>();
    values.add(quote);
    protectedQuotes.set(statementId, values);
  };

  for (const facet of payload.clueFactFacetBindings) {
    // The marked clue's name is itself an undiscovered clue disclosure when
    // moved into a public scene/module/connection field.  The item-name
    // exception above is intentionally limited to its existing exact slot.
    protectQuote(facet.nameStatementId, sourceStatement(payload, facet.nameStatementId, `clue name ${facet.clueId}`).text);
    // The parser retains a marked item's whole statement alongside its
    // name/body children. A public slot must not switch to that parent to
    // bypass the child atom boundary.
    wholeProtectedStatements.add(facet.markedItemStatementId);
    for (const atom of facet.shellAtoms) protectQuote(facet.bodyStatementId, atom.quote);
    for (const finding of facet.findings) for (const atom of finding.atoms) protectQuote(facet.bodyStatementId, atom.quote);
    const question = payload.resolvedQueue.questions.find((candidate) => candidate.id === facet.questionId);
    for (const atom of question?.allowedClueFactAtoms ?? []) {
      if (facet.sourceOnlyAtomIds.includes(atom.id)) protectQuote(facet.bodyStatementId, atom.quote);
    }
  }
  for (const clue of payload.proseDialogueClues) protectQuote(clue.relationshipStatementId, clue.relationshipQuote);
  for (const fact of payload.sourceFactMechanicBindings) {
    if (fact.declarationKind !== "prose_fact_finding") continue;
    protectQuote(fact.statementId, fact.quote);
    const question = payload.resolvedQueue.questions.find((candidate) => candidate.id === fact.questionId);
    for (const atomId of fact.sourceOnlyAtomIds) {
      const atom = question?.allowedSourceFactAtoms?.find((candidate) => candidate.id === atomId);
      if (!atom) throw new ProjectionDataError(`machine release clearance cannot restore source-only prose fact atom: ${fact.questionId}:${atomId}`);
      protectQuote(fact.statementId, atom.quote);
    }
  }
  for (const npc of payload.proseNpcBindings) wholeProtectedStatements.add(npc.paragraphStatementId);
  if (wholeProtectedStatements.has(binding.statementId)) return false;
  const statement = sourceStatement(payload, binding.statementId, `machine release ${binding.fieldPath}`);
  if ([...(protectedQuotes.get(binding.statementId) ?? [])].some((quote) => sourceQuoteRangesOverlap(statement.text, binding.quote, quote))) return false;
  // An ending question may cite broad context. It becomes a terminal-gated
  // body only when this exact resolved review binds text to an endings.* slot;
  // reject reuse of that actual statement/range in a public slot without
  // treating every broad citation as private prose.
  return !allBindings.some((other) => other.kind === "source_exact"
    && /^endings\.[^.]+\./.test(other.fieldPath)
    && other.statementId === binding.statementId
    && sourceQuoteRangesOverlap(statement.text, binding.quote, other.quote));
}

/** Both values are validated source substrings. Any same-statement overlap is a disclosure. */
function sourceQuoteRangesOverlap(source: string, left: string, right: string): boolean {
  const ranges = (quote: string): Array<readonly [number, number]> => {
    const values: Array<readonly [number, number]> = [];
    for (let start = 0; ; start++) {
      const index = source.indexOf(quote, start);
      if (index < 0) return values;
      values.push([index, index + quote.length]);
      start = index;
    }
  };
  return ranges(left).some(([leftStart, leftEnd]) => ranges(right).some(([rightStart, rightEnd]) => leftStart < rightEnd && rightStart < leftEnd));
}

/** The same finite clearance is required wherever a machine receipt is consumed. */
function machinePublicationBindingsWithoutPublicClearance(
  payload: ResolvedCompilerArtifactPayload,
  bindings: readonly TrustedPresentationBinding[],
): TrustedPresentationTextBinding[] {
  return bindings.filter((binding): binding is TrustedPresentationTextBinding => binding.kind === "source_exact"
    && !machineSourceExactBindingHasPublicClearance(payload, binding, bindings));
}

function reviewManifestSlot(
  payload: ResolvedCompilerArtifactPayload,
  rule: ReviewBindingRule,
  machinePublicRelease = false,
): TrustedPresentationReviewManifestSlot {
  return {
    fieldPath: rule.fieldPath,
    allowedBindingKinds: [
      ...(rule.sourceExact ? ["source_exact" as const] : []),
      ...(rule.allowsOpaque ? ["opaque_unavailable" as const] : []),
    ],
    sourceCandidateCount: rule.sourceExact ? sourceExactCandidateCount(payload, rule.fieldPath, rule.sourceExact, machinePublicRelease) : 0,
    opaqueBinding: rule.allowsOpaque ? { kind: "opaque_unavailable" as const, fieldPath: rule.fieldPath } : null,
  };
}

/**
 * Build one compact manifest slot page from a sealed resolved artifact. The
 * plan itself contains only rules: counts are evaluated for this page's rules
 * alone, so a large module never needs an all-slot count pass before slicing.
 */
export function buildTrustedPresentationReviewSlotPage(
  payload: ResolvedCompilerArtifactPayload,
  offset: number,
): TrustedPresentationReviewSlotPageBuild | CompilerModuleDataProjectionRefusal {
  try {
    const sealed = createResolvedCompilerArtifact(payload);
    return buildTrustedPresentationReviewSlotPageFromSealed(sealed, offset);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return refusal("PRESENTATION_METADATA_INVALID", error, typeof code === "string" ? code as CompilerArtifactRefusal["code"] : undefined);
  }
}

/** Reuses a caller's already validated resolved artifact; never accept raw input. */
function buildTrustedPresentationReviewSlotPageFromSealed(
  sealed: CompilerArtifactEnvelope,
  offset: number,
): TrustedPresentationReviewSlotPageBuild {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE !== 0) {
    throw new ProjectionDataError("presentation workbench slot offset is invalid");
  }
  const resolved = sealed.payload as ResolvedCompilerArtifactPayload;
  const contract = trustedPresentationReviewPlanContract(resolved);
  if (offset > contract.rules.length || (offset === contract.rules.length && contract.rules.length > 0)) {
    throw new ProjectionDataError("presentation workbench slot offset is unknown");
  }
  const end = Math.min(offset + TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE, contract.rules.length);
  return {
    status: "slot_paged",
    page: {
      slots: structuredClone(contract.rules.slice(offset, end).map((rule) => reviewManifestSlot(resolved, rule))),
      hasMore: end < contract.rules.length,
    },
    fieldPathOrderHash: sha256(canonicalJson(contract.rules.map((rule) => rule.fieldPath))),
  };
}

/**
 * Build one fixed-size page from the same contract used by final binding
 * validation. The order hash binds HTTP continuation cursors to this exact
 * authoritative candidate sequence without exposing rules or Sets.
 */
export function buildTrustedPresentationReviewCandidatePage(
  payload: ResolvedCompilerArtifactPayload,
  fieldPath: string,
  offset: number,
): TrustedPresentationReviewCandidatePageBuild | CompilerModuleDataProjectionRefusal {
  try {
    const sealed = createResolvedCompilerArtifact(payload);
    return buildTrustedPresentationReviewCandidatePageFromSealed(sealed, fieldPath, offset);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return refusal("PRESENTATION_METADATA_INVALID", error, typeof code === "string" ? code as CompilerArtifactRefusal["code"] : undefined);
  }
}

/** Reuses a caller's already validated resolved artifact; never accept raw input. */
function buildTrustedPresentationReviewCandidatePageFromSealed(
  sealed: CompilerArtifactEnvelope,
  fieldPath: string,
  offset: number,
  machinePublicRelease = false,
): TrustedPresentationReviewCandidatePageBuild {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE !== 0) {
    throw new ProjectionDataError("presentation workbench candidate offset is invalid");
  }
  const resolved = sealed.payload as ResolvedCompilerArtifactPayload;
  const contract = trustedPresentationReviewPlanContract(resolved);
  const rule = contract.rules.find((candidate) => candidate.fieldPath === fieldPath);
  if (!rule) throw new ProjectionDataError("presentation workbench fieldPath is unknown");
  const candidates = rule.sourceExact
    ? sourceExactCandidates(resolved, fieldPath, rule.sourceExact, machinePublicRelease).map((binding) => ({
      kind: "source_exact" as const,
      binding,
      exactText: sourceStatement(resolved, binding.statementId, `presentation candidate ${binding.fieldPath}`).text,
      quotePolicy: rule.sourceExact!.quotePolicy,
    }))
    : [];
  if (offset > candidates.length || (offset === candidates.length && candidates.length > 0)) {
    throw new ProjectionDataError("presentation workbench candidate offset is unknown");
  }
  const end = Math.min(offset + TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE, candidates.length);
  return {
    status: "paged",
    page: {
      fieldPath,
      candidates: structuredClone(candidates.slice(offset, end)),
      hasMore: end < candidates.length,
    },
    sourceCandidateOrderHash: sha256(canonicalJson(candidates)),
  };
}

function sourceSelectionDigest(
  artifactHash: string,
  identity: ResolvedCompilerArtifactIdentity,
  fieldPath: string,
  offset: number,
  sourceCandidateOrderHash: string,
  binding: TrustedPresentationTextBinding,
): string {
  return sha256(canonicalJson({
    schemaVersion: TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION,
    artifactHash,
    identity,
    fieldPath,
    offset,
    sourceCandidateOrderHash,
    binding,
  }));
}

function opaqueSelectionDigest(
  artifactHash: string,
  identity: ResolvedCompilerArtifactIdentity,
  binding: TrustedPresentationOpaqueBinding,
): string {
  return sha256(canonicalJson({
    schemaVersion: TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION,
    artifactHash,
    identity,
    binding,
  }));
}

/**
 * Host-only wrapper around the ordinary bounded slot page. It gives an
 * authorized machine operator a stable opaque-selection token without making
 * opaque values available for scene/clue/item/NPC/ending fields.
 */
export function buildTrustedPresentationSelectionSlotPage(
  payload: ResolvedCompilerArtifactPayload,
  offset: number,
): TrustedPresentationSelectionSlotPageBuild | CompilerModuleDataProjectionRefusal {
  let sealed: CompilerArtifactEnvelope;
  try {
    sealed = createResolvedCompilerArtifact(payload);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return refusal("ARTIFACT_INVALID", error, typeof code === "string" ? code as CompilerArtifactRefusal["code"] : undefined);
  }
  const resolved = sealed.payload as ResolvedCompilerArtifactPayload;
  try {
    const page = buildTrustedPresentationReviewSlotPageFromSealed(sealed, offset);
    const contract = trustedPresentationReviewPlanContract(resolved);
    return {
      status: "selection_slot_paged",
      page: {
        slots: page.page.slots.map((slot) => {
          const rule = contract.rules.find((candidate) => candidate.fieldPath === slot.fieldPath);
          if (!rule) throw new ProjectionDataError("machine presentation slot is outside the canonical plan");
          return {
          ...reviewManifestSlot(resolved, rule, true),
          opaqueCandidateDigest: slot.opaqueBinding
            ? opaqueSelectionDigest(sealed.artifactHash, resolved.identity, slot.opaqueBinding)
            : null,
          };
        }),
        hasMore: page.page.hasMore,
      },
      fieldPathOrderHash: page.fieldPathOrderHash,
    };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return refusal("PRESENTATION_METADATA_INVALID", error, typeof code === "string" ? code as CompilerArtifactRefusal["code"] : undefined);
  }
}

/**
 * Host-only wrapper around the ordinary bounded candidate page. Candidate
 * source text remains prompt material; an untrusted response can return only
 * its digest plus this page's existing cursor-binding fields.
 */
export function buildTrustedPresentationSelectionCandidatePage(
  payload: ResolvedCompilerArtifactPayload,
  fieldPath: string,
  offset: number,
): TrustedPresentationSelectionCandidatePageBuild | CompilerModuleDataProjectionRefusal {
  let sealed: CompilerArtifactEnvelope;
  try {
    sealed = createResolvedCompilerArtifact(payload);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return refusal("ARTIFACT_INVALID", error, typeof code === "string" ? code as CompilerArtifactRefusal["code"] : undefined);
  }
  const resolved = sealed.payload as ResolvedCompilerArtifactPayload;
  try {
    const page = buildTrustedPresentationReviewCandidatePageFromSealed(sealed, fieldPath, offset, true);
    return {
      status: "selection_paged",
      page: {
        fieldPath: page.page.fieldPath,
        offset,
        sourceCandidateOrderHash: page.sourceCandidateOrderHash,
        candidates: page.page.candidates.map((candidate) => withMachineSelectionCandidateSourceRange({
          kind: "source_exact" as const,
          candidateDigest: sourceSelectionDigest(
            sealed.artifactHash,
            resolved.identity,
            fieldPath,
            offset,
            page.sourceCandidateOrderHash,
            candidate.binding,
          ),
          exactText: candidate.exactText,
          quotePolicy: candidate.quotePolicy,
        }, candidate.binding, candidate.exactText)),
        hasMore: page.page.hasMore,
      },
    };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return refusal("PRESENTATION_METADATA_INVALID", error, typeof code === "string" ? code as CompilerArtifactRefusal["code"] : undefined);
  }
}

/**
 * Rebuild canonical bindings from untrusted machine selections. The digest is
 * an identity check only: artifact validity, complete plan coverage, and the
 * existing source/heading/quote validator remain authoritative.
 */
export function rehydrateTrustedPresentationSelections(
  payload: ResolvedCompilerArtifactPayload,
  rawSelections: readonly unknown[],
): TrustedPresentationSelectionRehydration | CompilerModuleDataProjectionRefusal {
  let sealed: CompilerArtifactEnvelope;
  try {
    sealed = createResolvedCompilerArtifact(payload);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return refusal("ARTIFACT_INVALID", error, typeof code === "string" ? code as CompilerArtifactRefusal["code"] : undefined);
  }
  try {
    const resolved = sealed.payload as ResolvedCompilerArtifactPayload;
    const plan = trustedPresentationReviewPlanContract(resolved);
    if (!Array.isArray(rawSelections) || rawSelections.length !== plan.rules.length) {
      throw new ProjectionDataError("trusted presentation selection lacks complete plan coverage");
    }
    const ruleByPath = new Map(plan.rules.map((rule) => [rule.fieldPath, rule]));
    const bindings: TrustedPresentationBinding[] = [];
    const seenFields = new Set<string>();
    for (const rawSelection of rawSelections) {
      if (!isRecord(rawSelection) || typeof rawSelection.fieldPath !== "string" || !rawSelection.fieldPath.trim()
        || typeof rawSelection.kind !== "string" || typeof rawSelection.candidateDigest !== "string"
        || !/^[a-f0-9]{64}$/.test(rawSelection.candidateDigest) || seenFields.has(rawSelection.fieldPath)) {
        throw new ProjectionDataError("trusted presentation selection is malformed or duplicate");
      }
      const rule = ruleByPath.get(rawSelection.fieldPath);
      if (!rule) throw new ProjectionDataError("trusted presentation selection field is outside the canonical plan");
      seenFields.add(rawSelection.fieldPath);
      if (rawSelection.kind === "source_exact") {
        const offset = rawSelection.offset;
        const sourceCandidateOrderHash = rawSelection.sourceCandidateOrderHash;
        if (!assertExactBindingKeys(rawSelection, ["fieldPath", "kind", "candidateDigest", "offset", "sourceCandidateOrderHash"])
          || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
          || typeof sourceCandidateOrderHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceCandidateOrderHash)) {
          throw new ProjectionDataError("trusted presentation source selection is malformed");
        }
        const fieldPath = rawSelection.fieldPath;
        const page = buildTrustedPresentationReviewCandidatePageFromSealed(sealed, fieldPath, offset, true);
        if (page.sourceCandidateOrderHash !== sourceCandidateOrderHash) {
          throw new ProjectionDataError("trusted presentation source selection does not match the canonical page");
        }
        const candidate = page.page.candidates.find((entry) => sourceSelectionDigest(
          sealed.artifactHash,
          resolved.identity,
          fieldPath,
          offset,
          page.sourceCandidateOrderHash,
          entry.binding,
        ) === rawSelection.candidateDigest);
        if (!candidate) throw new ProjectionDataError("trusted presentation source selection is unknown");
        bindings.push(candidate.binding);
        continue;
      }
      if (rawSelection.kind === "opaque_unavailable") {
        if (!assertExactBindingKeys(rawSelection, ["fieldPath", "kind", "candidateDigest"]) || !rule.allowsOpaque) {
          throw new ProjectionDataError("trusted presentation opaque selection is not authorized for this field");
        }
        const binding: TrustedPresentationOpaqueBinding = { kind: "opaque_unavailable", fieldPath: rawSelection.fieldPath };
        if (opaqueSelectionDigest(sealed.artifactHash, resolved.identity, binding) !== rawSelection.candidateDigest) {
          throw new ProjectionDataError("trusted presentation opaque selection is unknown");
        }
        bindings.push(binding);
        continue;
      }
      throw new ProjectionDataError("trusted presentation selection kind is unknown");
    }
    if (seenFields.size !== plan.rules.length || plan.rules.some((rule) => !seenFields.has(rule.fieldPath))) {
      throw new ProjectionDataError("trusted presentation selection lacks required fields");
    }
    const validated = validateTrustedReviewBindingsAgainstPlan(resolved, plan, bindings);
    return { status: "rehydrated", bindings: [...validated.values()].sort((left, right) => left.fieldPath.localeCompare(right.fieldPath)) };
  } catch (error) {
    if (error instanceof ProjectionDataError) return refusal("PRESENTATION_METADATA_INVALID", error);
    throw error;
  }
}

function validateTrustedReviewBindingsAgainstPlan(
  payload: ResolvedCompilerArtifactPayload,
  plan: TrustedPresentationReviewPlanContract,
  rawBindings: readonly unknown[],
): Map<string, TrustedPresentationBinding> {
  const ruleByPath = new Map(plan.rules.map((rule) => [rule.fieldPath, rule]));
  const byPath = new Map<string, TrustedPresentationBinding>();
  for (const rawBinding of rawBindings) {
    if (!isRecord(rawBinding) || typeof rawBinding.fieldPath !== "string" || !rawBinding.fieldPath.trim()
      || typeof rawBinding.kind !== "string" || byPath.has(rawBinding.fieldPath)) {
      throw new ProjectionDataError("trusted presentation review has duplicate or malformed bindings");
    }
    const rule = ruleByPath.get(rawBinding.fieldPath);
    if (!rule) throw new ProjectionDataError("trusted presentation review has bindings outside the publishable projection");
    if (rawBinding.kind === "source_exact") {
      if (!rule.sourceExact
        || !assertExactBindingKeys(rawBinding, ["kind", "fieldPath", "statementId", "quote", "evidenceRefId", "headingStatementId"])
        || typeof rawBinding.statementId !== "string" || !rawBinding.statementId.trim()
        || typeof rawBinding.quote !== "string" || !rawBinding.quote.trim() || rawBinding.quote !== rawBinding.quote.trim()
        || typeof rawBinding.evidenceRefId !== "string" || !rawBinding.evidenceRefId.trim()
        || typeof rawBinding.headingStatementId !== "string" || !rawBinding.headingStatementId.trim()) {
        throw new ProjectionDataError("trusted presentation review has malformed source_exact bindings");
      }
      const binding = rawBinding as unknown as TrustedPresentationTextBinding;
      const statement = sourceStatement(payload, binding.statementId, `presentation binding ${binding.fieldPath}`);
      if (statement.evidenceRefId !== binding.evidenceRefId || !statement.text.includes(binding.quote) || !headingScopesStatement(payload, binding.headingStatementId, statement.id)
        || (rule.sourceExact.headingStatementId && binding.headingStatementId !== rule.sourceExact.headingStatementId)
        || (rule.sourceExact.statementId && binding.statementId !== rule.sourceExact.statementId)
        || (rule.sourceExact.allowedStatementIds && !rule.sourceExact.allowedStatementIds.has(binding.statementId))
        || (rule.sourceExact.exactQuote !== undefined && binding.quote !== rule.sourceExact.exactQuote)) {
        throw new ProjectionDataError(`trusted presentation binding is not source-exact and authorized: ${binding.fieldPath}`);
      }
      byPath.set(binding.fieldPath, binding);
      continue;
    }
    if (rawBinding.kind === "opaque_unavailable" && rule.allowsOpaque && assertExactBindingKeys(rawBinding, ["kind", "fieldPath"])) {
      byPath.set(rawBinding.fieldPath, rawBinding as unknown as TrustedPresentationOpaqueBinding);
      continue;
    }
    throw new ProjectionDataError("trusted presentation review has malformed opaque_unavailable bindings");
  }
  if (byPath.size !== plan.rules.length || plan.rules.some((rule) => !byPath.has(rule.fieldPath))) {
    throw new ProjectionDataError("trusted presentation review lacks required bindings");
  }
  return byPath;
}

function trustedPresentationBindingValidationRefusal(error: unknown): CompilerModuleDataProjectionRefusal {
  const code = (error as { code?: unknown })?.code;
  return refusal("PRESENTATION_METADATA_INVALID", error, typeof code === "string" ? code as CompilerArtifactRefusal["code"] : undefined);
}

/**
 * Validate several independent workbench selections for one payload. The
 * canonical artifact and its authoritative contract are rebuilt once for the
 * batch; each attempt still goes through the exact same final binding
 * validator as a standalone review.
 */
export function validateTrustedPresentationReviewBindingAttempts(
  payload: ResolvedCompilerArtifactPayload,
  attempts: readonly (readonly unknown[])[],
): Array<{ status: "validated"; bindings: TrustedPresentationBinding[] } | CompilerModuleDataProjectionRefusal> {
  try {
    const sealed = createResolvedCompilerArtifact(payload);
    const resolved = sealed.payload as ResolvedCompilerArtifactPayload;
    const plan = trustedPresentationReviewPlanContract(resolved);
    return attempts.map((bindings) => {
      try {
        const byPath = validateTrustedReviewBindingsAgainstPlan(resolved, plan, bindings);
        return { status: "validated" as const, bindings: [...byPath.values()].sort((left, right) => left.fieldPath.localeCompare(right.fieldPath)) };
      } catch (error) {
        return trustedPresentationBindingValidationRefusal(error);
      }
    });
  } catch (error) {
    return attempts.map(() => trustedPresentationBindingValidationRefusal(error));
  }
}

/** Pure validation for bindings selected from the authoritative workbench contract. */
export function validateTrustedPresentationReviewBindings(
  payload: ResolvedCompilerArtifactPayload,
  bindings: readonly unknown[],
): { status: "validated"; bindings: TrustedPresentationBinding[] } | CompilerModuleDataProjectionRefusal {
  return validateTrustedPresentationReviewBindingAttempts(payload, [bindings])[0]!;
}

function reviewBindingOrigin(payload: ResolvedCompilerArtifactPayload, review: TrustedPresentationReview, binding: TrustedPresentationTextBinding): ProjectionFieldOrigin {
  return {
    kind: "trusted_presentation_review",
    reviewId: review.id,
    reviewHash: review.reviewHash,
    fieldPath: binding.fieldPath,
    statements: sourceEvidence(payload, [binding.statementId]),
    quote: binding.quote,
  };
}

function reviewOpaqueOrigin(review: TrustedPresentationReview, binding: TrustedPresentationOpaqueBinding): ProjectionFieldOrigin {
  return {
    kind: "trusted_presentation_opaque",
    reviewId: review.id,
    reviewHash: review.reviewHash,
    fieldPath: binding.fieldPath,
    disclosure: "opaque_unavailable",
  };
}

function validateTrustedReviewEnvelope(payload: ResolvedCompilerArtifactPayload, artifactHash: string, review: TrustedPresentationReview): void {
  if (!review || typeof review !== "object" || Array.isArray(review)
    || review.schemaVersion !== TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION
    || !/^[a-z2-7]{24}$/.test(review.id)
    || !review.reviewerPrincipalId?.trim()
    || !review.reviewedAt?.trim()
    || Number.isNaN(Date.parse(review.reviewedAt))
    || !/^[a-z2-7]{24}$/.test(review.preparedArtifactId)
    || !/^[a-f0-9]{64}$/.test(review.preparedArtifactHash)
    || !/^[a-f0-9]{64}$/.test(review.resolvedArtifactHash)
    || !/^[a-f0-9]{64}$/.test(review.reviewHash)
    || !Array.isArray(review.bindings)
    || !validMachinePublication(review)) {
    throw new ProjectionDataError("trusted presentation review has an invalid envelope");
  }
  const preparedIdentity = {
    moduleId: payload.identity.moduleId,
    documentHash: payload.identity.documentHash,
    sourceGraphIdentity: payload.identity.sourceGraphIdentity,
    preparedQueueHash: payload.identity.preparedQueueHash,
  };
  if (!sameCanonical(review.preparedIdentity, preparedIdentity)
    || review.resolvedArtifactHash !== artifactHash
    || !sameCanonical(review.resolvedIdentity, payload.identity)
    || review.reviewHash !== trustedPresentationReviewIdentity(review)) {
    throw new ProjectionDataError("trusted presentation review does not match the resolved compiler artifact");
  }
}

/**
 * Produce a player-visible ModuleData view from an authenticated review record.
 * Review records select source text only; executable structure remains derived
 * from MechanicsIR and the resolved draft.
 */
export function projectTrustedResolvedCompilerArtifact(
  payload: ResolvedCompilerArtifactPayload,
  review: TrustedPresentationReview,
): CompilerModuleDataProjection | CompilerModuleDataProjectionRefusal {
  let sealed: CompilerArtifactEnvelope;
  try {
    sealed = createResolvedCompilerArtifact(payload);
    const resolved = sealed.payload as ResolvedCompilerArtifactPayload;
    validateTrustedReviewEnvelope(resolved, sealed.artifactHash, review);

    const plan = trustedPresentationReviewPlanContract(resolved);
    const byPath = validateTrustedReviewBindingsAgainstPlan(resolved, plan, review.bindings);
    const machineClearanceFailures = review.machinePublication
      ? machinePublicationBindingsWithoutPublicClearance(resolved, [...byPath.values()])
      : [];
    if (machineClearanceFailures.length) {
      throw new ProjectionDataError(`machine presentation review selects source text outside the finite public-release clearance: ${machineClearanceFailures.map((binding) => binding.fieldPath).sort().join(",")}`);
    }
    const used = new Set<string>();
    // Source/domain/scope rules, including machine-only public clearance, are
    // checked above against the same canonical plan that feeds the selector.
    const quote = (fieldPath: string, _validatedByPlan?: unknown): string => {
      const binding = byPath.get(fieldPath);
      if (!binding) throw new ProjectionDataError(`trusted presentation review lacks binding: ${fieldPath}`);
      if (binding.kind !== "source_exact") throw new ProjectionDataError(`trusted presentation review field must be source_exact: ${fieldPath}`);
      used.add(fieldPath);
      return binding.quote;
    };
    const binding = (fieldPath: string): TrustedPresentationTextBinding => {
      const value = byPath.get(fieldPath);
      if (!value) throw new ProjectionDataError(`trusted presentation review lacks binding: ${fieldPath}`);
      if (value.kind !== "source_exact") throw new ProjectionDataError(`trusted presentation review field must be source_exact: ${fieldPath}`);
      if (!used.has(fieldPath)) throw new ProjectionDataError(`trusted presentation review binding was not validated: ${fieldPath}`);
      return value;
    };

    const playableIds = [...resolved.mechanicsIR.symbols.sceneIds].sort();
    const sceneById = new Map(resolved.draft.sceneCandidates.map((scene) => [scene.id, scene]));
    const runtimeClueById = new Map(runtimeClues(resolved).map((clue) => [clue.id, clue]));
    const connectionById = new Map(resolved.analysisInput.connections.map((connection) => [connection.id, connection]));
    const endingById = new Map(resolved.mechanicsIR.endings.map((ending) => {
      const effect = ending.effects.find((candidate) => candidate.kind === "end_game");
      if (!effect) throw new ProjectionDataError(`ending lacks end_game: ${ending.id}`);
      return [effect.endingId, ending] as const;
    }));

    const opaqueUnavailableModuleFields = new Set<TrustedPresentationModuleField>();
    const moduleBinding = (field: TrustedPresentationModuleField): TrustedPresentationBinding => {
      const value = byPath.get(`module.${field}`);
      if (!value) throw new ProjectionDataError(`trusted presentation review lacks module metadata disclosure: ${field}`);
      if (field === "triggerWarnings" && value.kind !== "opaque_unavailable") {
        throw new ProjectionDataError("trusted presentation review only supports opaque_unavailable triggerWarnings");
      }
      used.add(value.fieldPath);
      if (value.kind === "opaque_unavailable") opaqueUnavailableModuleFields.add(field);
      return value;
    };
    const moduleText = (field: Exclude<TrustedPresentationModuleField, "triggerWarnings">): string => {
      const value = moduleBinding(field);
      return value.kind === "opaque_unavailable" ? "" : quote(value.fieldPath);
    };
    const triggerWarnings = moduleBinding("triggerWarnings");
    if (triggerWarnings.kind !== "opaque_unavailable") throw new ProjectionDataError("trusted presentation review only supports opaque_unavailable triggerWarnings");
    const module = {
      title: moduleText("title"),
      version: moduleText("version"),
      ruleset: "cosmic-horror" as ModuleData["ruleset"],
      era: moduleText("era"),
      summary: moduleText("summary"),
      playerCount: moduleText("playerCount"),
      expectedDuration: moduleText("expectedDuration"),
      triggerWarnings: [] as string[],
    };
    const scenes = Object.fromEntries(playableIds.map((sceneId) => {
      const scene = sceneById.get(sceneId);
      if (!scene) throw new ProjectionDataError(`playable scene candidate missing: ${sceneId}`);
      if (quote(`scenes.${sceneId}.name`, { headingStatementId: scene.headingStatementId, statementId: scene.headingStatementId }) !== sourceStatement(resolved, scene.headingStatementId, "scene name").text) throw new ProjectionDataError(`trusted presentation review must select the exact scene heading: ${sceneId}`);
      return [sceneId, { description: quote(`scenes.${sceneId}.description`, { headingStatementId: scene.headingStatementId }) }];
    }));
    const connections = Object.fromEntries([...connectionById.entries()].map(([connectionId, connection]) => {
      const fromScene = sceneById.get(connection.fromSceneId);
      const gate = resolved.mechanicsIR.connections.find((candidate) => candidate.connectionId === connectionId);
      if (!fromScene || !gate) throw new ProjectionDataError(`connection mechanism missing: ${connectionId}`);
      return [connectionId, { condition: quote(`connections.${connectionId}.condition`, {
        headingStatementId: fromScene.headingStatementId,
        allowedStatementIds: interpretationStatementIds(resolved, gate.sourceInterpretationIds),
      }) }];
    }));
    const clues = Object.fromEntries([...runtimeClueById.entries()].map(([clueId, clue]) => {
      const scene = sceneById.get(clue.sceneCandidateId);
      if (!scene) throw new ProjectionDataError(`clue scene is incomplete: ${clueId}`);
      if (clue.kind === "prose_dialogue") {
        if (quote(`clues.${clueId}.name`, { headingStatementId: scene.headingStatementId, statementId: clue.relationshipStatementId }) !== clue.relationshipQuote) throw new ProjectionDataError(`trusted presentation review must select the exact prose dialogue clue name: ${clueId}`);
        if (quote(`clues.${clueId}.description`, { headingStatementId: scene.headingStatementId, statementId: clue.relationshipStatementId }) !== clue.relationshipQuote) throw new ProjectionDataError(`trusted presentation review must select the exact prose dialogue clue description: ${clueId}`);
      }
      const methods = resolved.mechanicsIR.discoveryMethods.filter((method) => method.clueId === clueId).sort((left, right) => left.id.localeCompare(right.id));
      const findMethods = clue.kind === "prose_dialogue" ? methods.map((method) => {
        const description = quote(`clues.${clueId}.findMethods.${method.id}.description`, {
          headingStatementId: scene.headingStatementId,
          allowedStatementIds: interpretationStatementIds(resolved, method.sourceInterpretationIds),
        });
        if (method.check?.kind === "skill") return { type: "skill" as const, skillName: method.check.skill, difficulty: method.check.difficulty, description };
        if (method.action === "observe") return { type: "observation" as const, description };
        if (method.action === "talk") return { type: "npc_dialogue" as const, description };
        if (method.action === "use_item") return { type: "item" as const, description };
        return { type: "automatic" as const, description };
      }) : compilerDerivedFacetFindMethods(methods);
      const unlocks = [...new Set(methods.flatMap((method) => [method.onSuccess, method.onFailure ?? [], method.failback?.effects ?? []].flatMap((effects) => effects.filter((effect): effect is Extract<typeof effects[number], { kind: "discover_clue" }> => effect.kind === "discover_clue").map((effect) => effect.clueId))).filter((id) => id !== clueId))].sort();
      return [clueId, {
        findMethods,
        revelation: clue.kind === "prose_dialogue"
          ? quote(`clues.${clueId}.revelation`, { headingStatementId: scene.headingStatementId })
          : clue.kind === "prose_fact_finding" ? clue.quote : clueFactDisplayText(resolved, clue),
        unlocks,
        importance: resolved.analysisInput.coreClueIds.includes(clueId) ? "core" as const : "bonus" as const,
      }];
    }));
    const endings = Object.fromEntries([...endingById.entries()].map(([endingId, ending]) => {
      const allowedStatementIds = interpretationStatementIds(resolved, ending.sourceInterpretationIds);
      const name = quote(`endings.${endingId}.name`, { allowedStatementIds });
      const description = quote(`endings.${endingId}.description`, { allowedStatementIds });
      return [endingId, { name, description, conditions: [quote(`endings.${endingId}.conditions.0`, { allowedStatementIds })] }];
    }));
    for (const item of resolved.itemBindings) {
      if (quote(`items.${item.itemId}.name`, { headingStatementId: item.headingStatementId, statementId: item.nameStatementId }) !== sourceStatement(resolved, item.nameStatementId, "item name").text) throw new ProjectionDataError(`trusted presentation review must select the exact item name: ${item.itemId}`);
      if (quote(`items.${item.itemId}.description`, { headingStatementId: item.headingStatementId, statementId: item.bodyStatementId }) !== sourceStatement(resolved, item.bodyStatementId, "item description").text) throw new ProjectionDataError(`trusted presentation review must select the exact item description: ${item.itemId}`);
    }
    for (const npc of resolved.proseNpcBindings) {
      if (quote(`npcs.${npc.npcId}.name`, { headingStatementId: npc.headingStatementId, statementId: npc.paragraphStatementId }) !== npc.nameQuote) throw new ProjectionDataError(`trusted presentation review must select the exact NPC name: ${npc.npcId}`);
      if (quote(`npcs.${npc.npcId}.description`, { headingStatementId: npc.headingStatementId, statementId: npc.paragraphStatementId }) !== sourceStatement(resolved, npc.paragraphStatementId, "NPC description").text) throw new ProjectionDataError(`trusted presentation review must select the exact NPC description: ${npc.npcId}`);
    }
    const metadata: ModuleDataPresentationMetadata = { module, scenes, connections, clues, endings };
    const projected = projectResolvedCompilerArtifactCore(resolved, metadata, { opaqueUnavailableModuleFields: [...opaqueUnavailableModuleFields] });
    if (projected.status === "refused") return projected;

    for (const field of TRUSTED_PRESENTATION_MODULE_FIELDS) {
      const reviewed = moduleBinding(field);
      projected.sourceMap.module.fields[field] = reviewed.kind === "source_exact"
        ? reviewBindingOrigin(resolved, review, reviewed)
        : reviewOpaqueOrigin(review, reviewed);
    }
    projected.sourceMap.module.fields.ruleset = artifactOrigin("compiled.ruleset");
    for (const scene of projected.module.scenes) {
      projected.sourceMap.scenes[scene.id]!.fields.name = reviewBindingOrigin(resolved, review, binding(`scenes.${scene.id}.name`));
      projected.sourceMap.scenes[scene.id]!.fields.description = reviewBindingOrigin(resolved, review, binding(`scenes.${scene.id}.description`));
      for (const clue of scene.clues) {
        const clueMap = projected.sourceMap.scenes[scene.id]!.clues[clue.id]!;
        const fields = clueMap.fields;
        const runtimeClue = runtimeClueById.get(clue.id);
        if (!runtimeClue) throw new ProjectionDataError(`trusted projection clue source is missing: ${clue.id}`);
        if (runtimeClue.kind === "prose_dialogue") {
          fields.name = reviewBindingOrigin(resolved, review, binding(`clues.${clue.id}.name`));
          fields.description = reviewBindingOrigin(resolved, review, binding(`clues.${clue.id}.description`));
          fields.revelation = reviewBindingOrigin(resolved, review, binding(`clues.${clue.id}.revelation`));
        }
        fields.findMethods = artifactOrigin(`mechanics.discoveryMethods[${clue.id}]`);
        if (runtimeClue.kind === "prose_dialogue") clueMap.findMethods = Object.fromEntries(
          resolved.mechanicsIR.discoveryMethods
            .filter((candidate) => candidate.clueId === clue.id)
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((method) => [method.id, {
              fields: {
                description: reviewBindingOrigin(resolved, review, binding(`clues.${clue.id}.findMethods.${method.id}.description`)),
              },
            }]),
        );
        fields.unlocks = artifactOrigin(`mechanics.discoveryMethods[${clue.id}].discover_clue`);
        fields.importance = artifactOrigin(`analysisInput.coreClueIds[${clue.id}]`);
      }
      for (const connection of resolved.analysisInput.connections.filter((candidate) => candidate.fromSceneId === scene.id)) {
        projected.sourceMap.scenes[scene.id]!.connections[connection.id]!.fields.condition = reviewBindingOrigin(resolved, review, binding(`connections.${connection.id}.condition`));
      }
    }
    for (const item of projected.module.items) {
      const fields = projected.sourceMap.items[item.id]!.fields;
      fields.name = reviewBindingOrigin(resolved, review, binding(`items.${item.id}.name`));
      fields.description = reviewBindingOrigin(resolved, review, binding(`items.${item.id}.description`));
    }
    for (const npc of projected.module.npcs) {
      const fields = projected.sourceMap.npcs[npc.id]!.fields;
      fields.name = reviewBindingOrigin(resolved, review, binding(`npcs.${npc.id}.name`));
      fields.description = reviewBindingOrigin(resolved, review, binding(`npcs.${npc.id}.description`));
    }
    for (const ending of projected.module.endings) {
      const fields = projected.sourceMap.endings[ending.id]!.fields;
      fields.name = reviewBindingOrigin(resolved, review, binding(`endings.${ending.id}.name`));
      fields.description = reviewBindingOrigin(resolved, review, binding(`endings.${ending.id}.description`));
      fields.conditions = reviewBindingOrigin(resolved, review, binding(`endings.${ending.id}.conditions.0`));
    }
    if (used.size !== byPath.size) throw new ProjectionDataError("trusted presentation review has bindings outside the publishable projection");
    return {
      ...projected,
      presentationReview: structuredClone(review),
      compiledPresentationDisclosure: { opaqueUnavailableModuleFields: [...opaqueUnavailableModuleFields].sort() },
    };
  } catch (error) {
    if (error instanceof ProjectionDataError) return refusal("PRESENTATION_METADATA_INVALID", error);
    throw error;
  }
}

function presentationFromProjection(payload: ResolvedCompilerArtifactPayload, value: unknown): ModuleDataPresentationMetadata {
  if (!isRecord(value) || value.status !== "projected" || !isRecord(value.module)) throw new ProjectionDataError("compiled projection has an invalid shape");
  const module = value.module;
  if (!Array.isArray(module.scenes) || !Array.isArray(module.items) || !Array.isArray(module.endings) || !isRecord(module.meta)) throw new ProjectionDataError("compiled projection module has an invalid shape");
  const asText = (input: unknown, label: string): string => {
    if (typeof input !== "string") throw new ProjectionDataError(`${label} must be text`);
    return input;
  };
  const scenes = Object.fromEntries(module.scenes.map((scene) => {
    if (!isRecord(scene)) throw new ProjectionDataError("compiled projection scene has an invalid shape");
    return [asText(scene.id, "scene ID"), { description: asText(scene.description, `scenes.${String(scene.id)}.description`) }];
  }));
  const clues = Object.fromEntries(module.scenes.flatMap((scene) => {
    if (!isRecord(scene) || !Array.isArray(scene.clues)) throw new ProjectionDataError("compiled projection clues have an invalid shape");
    return scene.clues.map((clue) => {
      if (!isRecord(clue)) throw new ProjectionDataError("compiled projection clue has an invalid shape");
      const clueId = asText(clue.id, "clue ID");
      assertFindMethods(clue.findMethods, `clues.${clueId}`);
      assertStringArray(clue.unlocks, `clues.${clueId}.unlocks`);
      if (typeof clue.revelation !== "string" || !["core", "bonus", "color"].includes(clue.importance as string)) throw new ProjectionDataError(`clues.${clueId} has invalid metadata`);
      return [clueId, { findMethods: clue.findMethods, revelation: clue.revelation, unlocks: clue.unlocks, importance: clue.importance as Clue["importance"] }];
    });
  }));
  const sceneById = new Map(module.scenes.map((scene) => [isRecord(scene) ? scene.id : "", scene]));
  const expectedConnectionsByScene = new Map<string, typeof payload.analysisInput.connections>();
  for (const connection of payload.analysisInput.connections) {
    const expected = expectedConnectionsByScene.get(connection.fromSceneId) ?? [];
    expected.push(connection);
    expectedConnectionsByScene.set(connection.fromSceneId, expected);
  }
  const connectionMetadata: Record<string, { condition: string }> = Object.create(null);
  for (const [sceneId, expectedUnsorted] of expectedConnectionsByScene) {
    const scene = sceneById.get(sceneId);
    if (!isRecord(scene) || !Array.isArray(scene.connections)) throw new ProjectionDataError(`compiled projection lacks scene connections: ${sceneId}`);
    const expected = [...expectedUnsorted].sort((left, right) => left.id.localeCompare(right.id));
    if (scene.connections.length !== expected.length) throw new ProjectionDataError(`compiled projection connection count is invalid: ${sceneId}`);
    for (const [index, connection] of expected.entries()) {
      const candidate = scene.connections[index];
      if (!isRecord(candidate) || candidate.connectionId !== connection.id) {
        throw new ProjectionDataError(`compiled projection connection identity is invalid: ${connection.id}`);
      }
      if (candidate.targetSceneId !== connection.toSceneId || typeof candidate.condition !== "string") {
        throw new ProjectionDataError(`compiled projection connection metadata is invalid: ${connection.id}`);
      }
      connectionMetadata[connection.id] = { condition: candidate.condition };
    }
  }
  const connections = Object.fromEntries(payload.analysisInput.connections.map((connection) => {
    const metadata = connectionMetadata[connection.id];
    if (!metadata) throw new ProjectionDataError(`compiled projection lacks connection metadata: ${connection.id}`);
    return [connection.id, metadata];
  }));
  const endings = Object.fromEntries(module.endings.map((ending) => {
    if (!isRecord(ending)) throw new ProjectionDataError("compiled projection ending has an invalid shape");
    const endingId = asText(ending.id, "ending ID");
    assertStringArray(ending.conditions, `endings.${endingId}.conditions`);
    return [endingId, { name: asText(ending.name, `endings.${endingId}.name`), description: asText(ending.description, `endings.${endingId}.description`), conditions: ending.conditions }];
  }));
  for (const item of module.items) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.description !== "string" || typeof item.sceneId !== "string" || !["key", "document", "loot"].includes(item.type as string)) {
      throw new ProjectionDataError("compiled projection item has an invalid shape");
    }
  }
  assertStringArray(module.meta.triggerWarnings, "module.triggerWarnings");
  return {
    module: {
      title: asText(module.title, "module.title"), version: asText(module.version, "module.version"), ruleset: asText(module.ruleset, "module.ruleset") as ModuleData["ruleset"], era: asText(module.era, "module.era"), summary: asText(module.summary, "module.summary"),
      playerCount: asText(module.meta.playerCount, "module.meta.playerCount"), expectedDuration: asText(module.meta.expectedDuration, "module.meta.expectedDuration"), triggerWarnings: module.meta.triggerWarnings,
    },
    scenes,
    connections,
    clues,
    endings,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ProjectionDataError("compiled projection contains a non-plain value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function normalizeGeneratedOrder(value: unknown): unknown {
  const result = structuredClone(value) as unknown;
  if (!isRecord(result) || !isRecord(result.module) || !Array.isArray(result.module.scenes) || !Array.isArray(result.module.npcs) || !Array.isArray(result.module.items) || !Array.isArray(result.module.endings)) return result;
  result.module.scenes.sort((left, right) => String((left as Record<string, unknown>).id).localeCompare(String((right as Record<string, unknown>).id)));
  for (const scene of result.module.scenes) {
    if (!isRecord(scene)) continue;
    if (Array.isArray(scene.clues)) scene.clues.sort((left, right) => String((left as Record<string, unknown>).id).localeCompare(String((right as Record<string, unknown>).id)));
    if (Array.isArray(scene.connections)) scene.connections.sort((left, right) => String((left as Record<string, unknown>).connectionId).localeCompare(String((right as Record<string, unknown>).connectionId)));
    if (Array.isArray(scene.npcIds)) scene.npcIds.sort((left, right) => String(left).localeCompare(String(right)));
  }
  result.module.npcs.sort((left, right) => String((left as Record<string, unknown>).id).localeCompare(String((right as Record<string, unknown>).id)));
  result.module.items.sort((left, right) => String((left as Record<string, unknown>).id).localeCompare(String((right as Record<string, unknown>).id)));
  result.module.endings.sort((left, right) => String((left as Record<string, unknown>).id).localeCompare(String((right as Record<string, unknown>).id)));
  return result;
}

/** Reprojects permitted presentation metadata and compares the full canonical result. */
export function validateCanonicalCompilerModuleProjection(
  payload: ResolvedCompilerArtifactPayload,
  value: unknown,
): CompilerModuleDataProjection | CompilerModuleDataProjectionRefusal {
  try {
    const review = isRecord(value) && "presentationReview" in value ? value.presentationReview as TrustedPresentationReview : undefined;
    const expected = review
      ? projectTrustedResolvedCompilerArtifact(payload, review)
      : projectResolvedCompilerArtifact(payload, presentationFromProjection(payload, value));
    if (expected.status === "refused") return expected;
    if (canonicalJson(normalizeGeneratedOrder(value)) !== canonicalJson(normalizeGeneratedOrder(expected))) throw new ProjectionDataError("compiled projection does not match the canonical artifact projection");
    return structuredClone(expected);
  } catch (error) {
    return refusal("PRESENTATION_METADATA_INVALID", error);
  }
}
