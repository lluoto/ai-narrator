import { sha256, validateEvidenceRef } from "../ingest/document-ir";
import { sourceFactGraphIdentity, parseMechanicsCandidateSpec, type ActorEffectProvenance, type CheckSpec, type CombatDamageSpec, type ConnectionGateSpec, type DiscoveryMethodSpec, type DiscoveryTarget, type Effect, type EndingRuleSpec, type Predicate, type RewardDefinitionSpec, type RewardPredicate, type SanityCheckEffect, type StateTransitionSpec } from "./mechanics-ir";
import { isEligibleRewardSourceRow } from "./reward-candidate-eligibility";
import type { RightsStatus } from "./source-authority";
import { deriveClueFactAtoms, deriveProseFactFindingCandidates, deriveSourceFactAtoms, type DraftClueFactAtom, type DraftModuleStructure, type DraftProseFactFindingCandidate, type DraftSourceFactAtom } from "./deterministic-template-compiler";
import { validateSourceFactGraph, type SourceFactGraph, type SourceStatement } from "./source-fact-graph";

/** 3.4 adds server-derived, atom-partitioned prose-fact discoveries. */
export const COMPILER_QUESTION_QUEUE_SCHEMA_VERSION = "3.4.0";
/** 2.2 adds source-exact prose dialogue relationship evidence. */
/** 2.3 permits the audited automatic wire to omit a prose dialogue mechanismId. */
export const MODULE_COMPILE_HINTS_SCHEMA_VERSION = "3.4.0";
/** Versioned audit payload written only when a grounded external proposal is accepted. */
export const COMPILER_HINT_PROPOSAL_AUDIT_SCHEMA_VERSION = "1.0.0";
/** Adds trusted producer/request/response provenance without invalidating prior human or proposal hints. */
export const COMPILER_HINT_PROPOSAL_AUDIT_PROVENANCE_SCHEMA_VERSION = "1.1.0";
/** Adds separately auditable source claims for automatic prose-NPC dialogue clues. */
export const COMPILER_HINT_PROPOSAL_AUDIT_NPC_PROSE_DIALOGUE_SCHEMA_VERSION = "1.2.0";
/** Adds source-exact automatic NPC combat claims and mandatory model provenance. */
export const COMPILER_HINT_PROPOSAL_AUDIT_NPC_ENCOUNTER_SCHEMA_VERSION = "1.3.0";

/**
 * Historical hint documents are readable according to the features they
 * actually introduced.  Do not use "not current" as a proxy for a missing
 * capability: that silently rejects valid archived human review.
 */
const MODULE_COMPILE_HINTS_SCHEMA_CAPABILITIES = {
  "1.3.0": { sourceFactDisposition: false, explicitNullItemBinding: false, sourceExactPositiveItemBinding: false, npcDialogue: false, explicitNpcDialogueDeclaration: false, proseDialogue: false, automaticProseDialogueWire: false, clueFactFacets: false },
  "1.4.0": { sourceFactDisposition: false, explicitNullItemBinding: false, sourceExactPositiveItemBinding: false, npcDialogue: false, explicitNpcDialogueDeclaration: false, proseDialogue: false, automaticProseDialogueWire: false, clueFactFacets: false },
  "1.5.0": { sourceFactDisposition: false, explicitNullItemBinding: false, sourceExactPositiveItemBinding: false, npcDialogue: false, explicitNpcDialogueDeclaration: false, proseDialogue: false, automaticProseDialogueWire: false, clueFactFacets: false },
  "1.6.0": { sourceFactDisposition: false, explicitNullItemBinding: false, sourceExactPositiveItemBinding: false, npcDialogue: false, explicitNpcDialogueDeclaration: false, proseDialogue: false, automaticProseDialogueWire: false, clueFactFacets: false },
  "1.7.0": { sourceFactDisposition: false, explicitNullItemBinding: false, sourceExactPositiveItemBinding: false, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: false, automaticProseDialogueWire: false, clueFactFacets: false },
  "1.8.0": { sourceFactDisposition: false, explicitNullItemBinding: false, sourceExactPositiveItemBinding: false, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: false, automaticProseDialogueWire: false, clueFactFacets: false },
  "1.9.0": { sourceFactDisposition: false, explicitNullItemBinding: true, sourceExactPositiveItemBinding: false, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: false, automaticProseDialogueWire: false, clueFactFacets: false },
  "2.0.0": { sourceFactDisposition: true, explicitNullItemBinding: true, sourceExactPositiveItemBinding: false, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: false, automaticProseDialogueWire: false, clueFactFacets: false },
  "2.1.0": { sourceFactDisposition: true, explicitNullItemBinding: true, sourceExactPositiveItemBinding: true, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: false, automaticProseDialogueWire: false, clueFactFacets: false },
  "2.2.0": { sourceFactDisposition: true, explicitNullItemBinding: true, sourceExactPositiveItemBinding: true, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: true, automaticProseDialogueWire: false, clueFactFacets: false },
  "2.3.0": { sourceFactDisposition: true, explicitNullItemBinding: true, sourceExactPositiveItemBinding: true, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: true, automaticProseDialogueWire: true, clueFactFacets: false },
  "3.0.0": { sourceFactDisposition: true, explicitNullItemBinding: true, sourceExactPositiveItemBinding: true, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: true, automaticProseDialogueWire: true, sourceFactMechanics: true, clueFactFacets: false },
  "3.1.0": { sourceFactDisposition: true, explicitNullItemBinding: true, sourceExactPositiveItemBinding: true, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: true, automaticProseDialogueWire: true, sourceFactMechanics: true, clueFactFacets: false },
  "3.2.0": { sourceFactDisposition: true, explicitNullItemBinding: true, sourceExactPositiveItemBinding: true, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: true, automaticProseDialogueWire: true, sourceFactMechanics: true, clueFactFacets: true },
  /** 3.3 makes every actor SAN effect cite its exact executable event slot. */
  "3.3.0": { sourceFactDisposition: true, explicitNullItemBinding: true, sourceExactPositiveItemBinding: true, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: true, automaticProseDialogueWire: true, sourceFactMechanics: true, clueFactFacets: true },
  /** 3.4 permits the closed source-atom selection wire for prose findings. */
  "3.4.0": { sourceFactDisposition: true, explicitNullItemBinding: true, sourceExactPositiveItemBinding: true, npcDialogue: true, explicitNpcDialogueDeclaration: true, proseDialogue: true, automaticProseDialogueWire: true, sourceFactMechanics: true, clueFactFacets: true, proseFactFindings: true },
} as const;

type ModuleCompileHintsSchemaVersion = keyof typeof MODULE_COMPILE_HINTS_SCHEMA_CAPABILITIES;

/** 3.0 may replay existing discovery children but cannot express transitions. */
const SOURCE_FACT_SCENE_TRANSITION_CAPABILITIES: Record<ModuleCompileHintsSchemaVersion, boolean> = {
  "1.3.0": false,
  "1.4.0": false,
  "1.5.0": false,
  "1.6.0": false,
  "1.7.0": false,
  "1.8.0": false,
  "1.9.0": false,
  "2.0.0": false,
  "2.1.0": false,
  "2.2.0": false,
  "2.3.0": false,
  "3.0.0": false,
  "3.1.0": true,
  "3.2.0": true,
  "3.3.0": true,
  "3.4.0": true,
};

function moduleCompileHintsCapabilities(schemaVersion: unknown): (typeof MODULE_COMPILE_HINTS_SCHEMA_CAPABILITIES)[ModuleCompileHintsSchemaVersion] & { sourceFactSceneTransition: boolean; actorEffectProvenance: boolean; proseFactFindings: boolean } {
  if (typeof schemaVersion !== "string" || !Object.hasOwn(MODULE_COMPILE_HINTS_SCHEMA_CAPABILITIES, schemaVersion)) {
    throw new CompilerQuestionError("schema_mismatch", "unsupported module compile hints schema");
  }
  const version = schemaVersion as ModuleCompileHintsSchemaVersion;
  return { ...MODULE_COMPILE_HINTS_SCHEMA_CAPABILITIES[version], sourceFactSceneTransition: SOURCE_FACT_SCENE_TRANSITION_CAPABILITIES[version], actorEffectProvenance: version === "3.3.0" || version === "3.4.0", proseFactFindings: version === "3.4.0" };
}

export type CompilerQuestionKind = "scene_role" | "entry_scene" | "connection_topology" | "core_clue" | "ending_rule" | "discovery_method" | "clue_fact_facets" | "source_fact_disposition" | "source_fact_mechanic" | "npc_binding" | "item_binding" | "reward_binding" | "check_spec" | "state_key";
export type CompilerQuestionStatus = "open" | "answered" | "rejected" | "deferred" | "not_applicable";
export type CompilerQuestionSeverity = "publish_blocking" | "draft_warning";
export type SceneRole = "playable_scene" | "rules_section" | "character_section" | "ending_section" | "other";

export interface CompilerQuestion {
  id: string;
  kind: CompilerQuestionKind;
  prompt: string;
  sourceStatementIds: string[];
  evidenceRefs: string[];
  /** Legacy general candidate set; semantic domains below are used where needed. */
  candidateIds?: string[];
  subjectCandidateId?: string;
  /**
   * Canonical source-statement subject where candidate identity alone is not
   * enough to distinguish independently reviewable source units.  It is
   * required for prose NPC anchors and source-fact disposition review.
   */
  subjectStatementId?: string;
  allowedCandidateIds?: string[];
  /** Discovery location candidates are deliberately distinct from mechanism targets. */
  allowedLocationCandidateIds?: string[];
  allowedMechanicsTargetIds?: Partial<Record<DiscoveryTarget, string[]>>;
  /** Closed source-exact atom domain for the marked clue facet partition. */
  allowedClueFactAtoms?: DraftClueFactAtom[];
  /** Closed root-atom domain for a prose-fact mechanics child. */
  allowedSourceFactAtoms?: DraftSourceFactAtom[];
  /** Server-derived successful-check findings; callers select IDs only. */
  allowedProseFactFindingCandidates?: DraftProseFactFindingCandidate[];
  /** A positive item name must be quoted from one of these exact marked-item children. */
  allowedItemNameEvidenceStatementIds?: string[];
  /** Reward conditions may reference only these same-draft symbols, by predicate kind. */
  allowedRewardPredicateIds?: Partial<Record<"scene" | "clue" | "item", string[]>>;
  /** V3 source-fact parents enumerate their exact permitted dispositions. */
  allowedDispositions?: Array<"source_only" | "mechanics_candidate">;
  /** Bidirectional prepared parent/child wire; both IDs are hash-covered queue data. */
  sourceFactChildQuestionId?: string;
  sourceFactParentQuestionId?: string;
  owningSceneCandidateId?: string;
  owningHeadingStatementId?: string;
  status: CompilerQuestionStatus;
  resolution?: CompilerQuestionResolution;
  blockingCode: string;
  severity: CompilerQuestionSeverity;
}

function canonicalDraftId(graph: SourceFactGraph, evidence: DraftModuleStructure["itemCandidates"][number]["evidence"], role: "scene" | "clue" | "item" | "prose_npc" | "reward"): string {
  const document = graph.documentIdentity.documentHash ?? `synthetic:${graph.documentIdentity.sourceDescriptor ?? "unspecified"}`;
  const locations = evidence.spans.map((span) => `${span.pageNumber}:${span.rawStart}:${span.rawEnd}`).join("|");
  return `draft_${role}_${sha256(`${document}|${role}|${locations}`).slice(0, 24)}`;
}

function isCanonicalDraftRewardCandidate(graph: SourceFactGraph, reward: DraftModuleStructure["rewardCandidates"][number]): boolean {
  const row = graph.statements.find((statement) => statement.id === reward.tableRowStatementId);
  const headingRelation = row && graph.relations.find((relation) => relation.kind === "heading_scopes" && relation.to === row.id);
  const heading = headingRelation && graph.statements.find((statement) => statement.id === headingRelation.from);
  return !!row && row.kind === "table_row" && !!heading && heading.kind === "heading"
    && row.parentStatementId === heading.id && reward.headingStatementId === heading.id
    && isEligibleRewardSourceRow(heading.text, row.text)
    && reward.id === canonicalDraftId(graph, row.evidence, "reward")
    && reward.status === "candidate" && JSON.stringify(reward.evidence) === JSON.stringify(row.evidence);
}

/** A queue can validate canonical item identity without recursively recompiling the draft. */
function isCanonicalDraftItemCandidate(graph: SourceFactGraph, item: DraftModuleStructure["itemCandidates"][number]): boolean {
  const marked = graph.statements.find((statement) => statement.id === item.markedItemStatementId);
  const name = graph.statements.find((statement) => statement.id === item.nameStatementId);
  const body = graph.statements.find((statement) => statement.id === item.bodyStatementId);
  const headingRelation = marked && graph.relations.find((relation) => relation.kind === "heading_scopes" && relation.to === marked.id);
  const heading = headingRelation && graph.statements.find((statement) => statement.id === headingRelation.from);
  const nameRelation = marked && graph.relations.some((relation) => relation.kind === "marked_item_name" && relation.from === marked.id && relation.to === item.nameStatementId);
  const bodyRelation = marked && graph.relations.some((relation) => relation.kind === "marked_item_body" && relation.from === marked.id && relation.to === item.bodyStatementId);
  return !!marked && marked.kind === "marked_item"
    && !!name && name.kind === "marked_item_name" && name.parentStatementId === marked.id && !!nameRelation
    && !!body && body.kind === "marked_item_body" && body.parentStatementId === marked.id && !!bodyRelation
    && !!heading && heading.kind === "heading" && marked.parentStatementId === heading.id
    && item.id === canonicalDraftId(graph, marked.evidence, "item")
    && item.sceneCandidateId === canonicalDraftId(graph, heading.evidence, "scene")
    && item.displayName === name.text.trim()
    && item.status === "candidate"
    && JSON.stringify(item.evidence) === JSON.stringify(marked.evidence);
}

export interface CompilerQuestionQueue {
  schemaVersion: typeof COMPILER_QUESTION_QUEUE_SCHEMA_VERSION;
  moduleId: string;
  documentHash: string | null;
  sourceGraphIdentity: string;
  questions: CompilerQuestion[];
  queueHash: string;
}

export interface CompilerQuestionResolution {
  questionId: string;
  kind: CompilerQuestionKind;
  value: unknown;
  sourceStatementIds: string[];
  evidenceRefs: string[];
  authority: "module_explicit" | "user_document" | "project_original";
  derivation: "explicit";
  reviewerKind: "deterministic_rule" | "human" | "approved_policy";
  policyId?: string;
  rightsStatus: RightsStatus;
  reason: string;
  /** Optional so pre-existing human-reviewed hints remain valid. */
  audit?: CompilerHintProposalAudit;
}

/** A verbatim source citation supplied by an untrusted proposal and verified by the compiler. */
export interface CompilerHintCitation {
  claimKey: string;
  statementId: string;
  quote: string;
}

/** Trusted adapter metadata, never a field supplied by an untrusted model response. */
export interface CompilerHintProposalProducerProvenance {
  providerFingerprint: string;
  modelFingerprint: string;
  requestHash: string;
  responseHash: string;
}

/** Provenance retained on a resolution after a grounded external proposal is compiled. */
export interface CompilerHintProposalAudit {
  kind: "compiler_hint_proposal";
  schemaVersion: typeof COMPILER_HINT_PROPOSAL_AUDIT_SCHEMA_VERSION | typeof COMPILER_HINT_PROPOSAL_AUDIT_PROVENANCE_SCHEMA_VERSION | typeof COMPILER_HINT_PROPOSAL_AUDIT_NPC_PROSE_DIALOGUE_SCHEMA_VERSION | typeof COMPILER_HINT_PROPOSAL_AUDIT_NPC_ENCOUNTER_SCHEMA_VERSION;
  proposalId: string;
  policyId: string;
  citations: CompilerHintCitation[];
  /** Present only for adapter-produced proposal audits using schema 1.1.0. */
  producer?: CompilerHintProposalProducerProvenance;
}

export interface ModuleCompileHints {
  /** Older writers remain readable only when they do not use newer semantic DSL extensions. */
  schemaVersion: ModuleCompileHintsSchemaVersion;
  moduleId: string;
  documentHash: string | null;
  sourceGraphIdentity: string;
  resolutions: CompilerQuestionResolution[];
}

/** An existing marked-item clue selected from the anchor heading's closed domain. */
export interface ParsedNpcMarkedItemDialogueMethod {
  kind: "marked_item";
  mechanismId: string;
  clueId: string;
  spec: DiscoveryMethodSpec;
}

/**
 * A new clue whose identity is the reviewed NPC paragraph relationship quote,
 * not a structural marked-item candidate.  The compiler derives its ID and
 * its only success effect so this path can never smuggle item acquisition or
 * an unrelated location/target into a dialogue answer.
 */
export interface ParsedNpcProseDialogueMethod {
  kind: "prose";
  mechanismId: string;
  clueId: string;
  relationshipEvidence: { statementId: string; quote: string };
  spec: DiscoveryMethodSpec;
}

export type ParsedNpcDialogueMethod = ParsedNpcMarkedItemDialogueMethod | ParsedNpcProseDialogueMethod;

export type ParsedCompilerHintValue =
  | { kind: "scene_role"; role: SceneRole }
  | { kind: "entry_scene"; sceneId: string }
  | { kind: "core_clue"; clueId: string; required: boolean }
  | { kind: "connection_topology"; connections: Array<{ fromSceneId: string; toSceneId: string; connectionId: string; spec: ConnectionGateSpec }> }
  | { kind: "ending_rule"; declarations: Array<{ endingId: string; spec: EndingRuleSpec }> }
  | { kind: "discovery_method"; clueId: string; locationSceneId: string; spec: DiscoveryMethodSpec }
  | {
    kind: "clue_fact_facets";
    clueId: string;
    shellAtoms: ParsedClueFactAtomQuote[];
    findings: ParsedClueFactFinding[];
    sourceOnlyAtomIds: string[];
  }
  | { kind: "source_fact_disposition"; statementId: string; disposition: "source_only" | "mechanics_candidate" }
  | {
    kind: "source_fact_mechanic";
    parentQuestionId: string;
    statementId: string;
    declarations: ParsedSourceFactMechanicDeclaration[];
  }
  | {
    kind: "npc_binding";
    proseAnchorId: string;
    presentNpcs: Array<{
      nameQuote: string;
      npcId: string;
      /** Absent only for a pre-dialogue legacy hint schema. */
      dialogueMethodsDeclared: boolean;
      dialogueMethods: ParsedNpcDialogueMethod[];
      /** Absent means this reviewed prose NPC remains narrative/non-combat. */
      encounter?: ParsedNpcEncounterBinding;
    }>;
  }
  /** null deliberately preserves the reviewed marked item as source-only evidence. */
  | { kind: "item_binding"; itemCandidateId: string; itemType: null }
  | {
    kind: "item_binding";
    itemCandidateId: string;
    itemType: "key" | "document" | "loot";
    /** Source-exact display identity for the runtime item, never a generated label. */
    itemNameEvidence: { statementId: string; quote: string };
  }
  | { kind: "reward_binding"; rewardCandidateId: string; declaration: null | Omit<RewardDefinitionSpec, "kind" | "id"> };

/** One queue-selected atom and its source-exact quote; callers cannot select a statement. */
export interface ParsedClueFactAtomQuote {
  atomId: string;
  quote: string;
}

/**
 * A gated finding is intentionally a tiny declaration, not a caller-provided
 * MechanicsIR fragment. IDs, effects, availability and heading location are
 * all compiler-derived below.
 */
export interface ParsedClueFactFinding {
  findingKey: string;
  clueId: string;
  atoms: ParsedClueFactAtomQuote[];
  methods: ParsedClueFactFindingMethod[];
}

/** Multiple genuinely distinct methods may reveal one finding clue. */
export interface ParsedClueFactFindingMethod {
  declarationKey: string;
  mechanismId: string;
  action: Exclude<DiscoveryMethodSpec["action"], "talk" | "custom">;
  target: "scene" | "clue";
  check: CheckSpec;
  failback?: { maxFailures: number };
  spec: DiscoveryMethodSpec;
}

export interface SourceFactMechanicEvidence {
  claimKey: string;
  statementId: string;
  quote: string;
}

/**
 * Source facts never accept a caller-selected mechanism or interpretation ID.
 * The declaration is intentionally narrow: it can only discover a same-heading
 * structural clue using an already supported MechanicsIR discovery action.
 */
export interface ParsedExistingClueSourceFactMechanicDeclaration {
  kind: "existing_clue_discovery";
  declarationKey: string;
  mechanismId: string;
  clueId: string;
  spec: DiscoveryMethodSpec;
  evidence: SourceFactMechanicEvidence[];
}

/**
 * A prose finding is selected solely by a server-derived candidate ID.  Every
 * runtime-facing detail is reconstructed from the prepared atom domain.
 */
export interface ParsedProseFactFindingSourceFactMechanicDeclaration {
  kind: "prose_fact_finding";
  declarationKey: string;
  candidateId: string;
  atomId: string;
  clueId: string;
  mechanismId: string;
  quote: string;
  check: CheckSpec;
  /** The remaining root atoms, retained as an explicit closed partition. */
  sourceOnlyAtomIds: string[];
  spec: DiscoveryMethodSpec;
  evidence: SourceFactMechanicEvidence[];
}

/** A compiler-expanded automatic transition with a derived one-shot state sentinel. */
export interface ParsedSceneStateTransitionSourceFactMechanicDeclaration {
  kind: "scene_state_transition";
  declarationKey: string;
  mechanismId: string;
  stateKey: string;
  trigger: { kind: "scene_enter" } | { kind: "clue_found"; clueId: string };
  discoverClueId: string;
  spec: StateTransitionSpec;
  evidence: SourceFactMechanicEvidence[];
}

export type ParsedSourceFactMechanicDeclaration = ParsedExistingClueSourceFactMechanicDeclaration | ParsedProseFactFindingSourceFactMechanicDeclaration | ParsedSceneStateTransitionSourceFactMechanicDeclaration;

/** Exact source citation and deterministic parsed value for one combat stat. */
export interface NpcEncounterStatEvidence {
  statementId: string;
  quote: string;
}

/** Server-derived, closed automatic-combat evidence candidates for one heading. */
export interface AllowedNpcEncounterProfile {
  headingStatementId: string;
  /** Alternate profile headings require the NPC name quote to be this exact heading. */
  requiredNameQuote?: string;
  statCandidates: Record<"maxHp" | "dodge" | "fight" | "npcDamage", NpcEncounterStatEvidence[]>;
}

/** One verified marked-item target for an NPC combat victory effect. */
export interface NpcEncounterVictoryEffectEvidence {
  candidateId: string;
  headingStatementId: string;
  statementId: string;
  quote: string;
  /** Reconstructed graph relation: heading -> marked item -> name/body. */
  sourceStatementIds: string[];
}

/**
 * Source evidence is retained alongside the derived definition so artifact
 * replay can prove every numeric combat value came from its reviewed heading.
 */
export interface ParsedNpcEncounterBinding {
  encounterId: string;
  autoStartMechanismId: string;
  sceneId: string;
  combatantId: string;
  maxHp: number;
  dodge: number;
  fight: number;
  npcDamage: CombatDamageSpec;
  victoryEffects: Effect[];
  /** Positional evidence bindings for every entry in victoryEffects. */
  victoryEffectEvidence: NpcEncounterVictoryEffectEvidence[];
  statEvidence: {
    maxHp: NpcEncounterStatEvidence;
    dodge: NpcEncounterStatEvidence;
    fight: NpcEncounterStatEvidence;
    npcDamage: NpcEncounterStatEvidence;
  };
}

export class CompilerQuestionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CompilerQuestionError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** Legacy hint schemas predate actor SAN effects and must not smuggle one in. */
function containsSanityCheck(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSanityCheck);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.kind === "sanity_check" || Object.values(record).some(containsSanityCheck);
}

/** Dialogue mechanics are a versioned binding extension, never an old-hint extra field. */
function containsNpcDialogueMethods(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.presentNpcs) && record.presentNpcs.some((npc) => !!npc && typeof npc === "object" && !Array.isArray(npc)
    && Object.hasOwn(npc as object, "dialogueMethods"));
}

/** Prose dialogue derives a new clue identity and therefore needs the current hint schema. */
function containsNpcProseDialogueMethods(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.presentNpcs)) return false;
  return record.presentNpcs.some((npc) => !!npc && typeof npc === "object" && !Array.isArray(npc)
    && Array.isArray((npc as Record<string, unknown>).dialogueMethods)
    && ((npc as Record<string, unknown>).dialogueMethods as unknown[]).some((method) => !!method && typeof method === "object" && !Array.isArray(method)
      && Object.hasOwn(method as object, "relationshipEvidence")));
}

/** Omitted prose mechanism IDs are reserved for the 2.3 audited auto wire. */
function containsAutomaticNpcProseDialogueWire(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const present = (value as Record<string, unknown>).presentNpcs;
  if (!Array.isArray(present)) return false;
  return present.some((npc) => !!npc && typeof npc === "object" && !Array.isArray(npc)
    && Array.isArray((npc as Record<string, unknown>).dialogueMethods)
    && ((npc as Record<string, unknown>).dialogueMethods as unknown[]).some((method) => !!method && typeof method === "object" && !Array.isArray(method)
      && Object.hasOwn(method as object, "relationshipEvidence")
      && !Object.hasOwn(method as object, "mechanismId")));
}

/** Combat is a newer, human-reviewed extension of the same NPC binding. */
function containsNpcEncounter(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.presentNpcs) && record.presentNpcs.some((npc) => !!npc && typeof npc === "object" && !Array.isArray(npc)
    && Object.hasOwn(npc as object, "encounter"));
}

/** 1.8 binds each victory effect to graph evidence; 1.7 may omit the field only. */
function containsNpcVictoryEffects(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.presentNpcs) && record.presentNpcs.some((npc) => {
    if (!npc || typeof npc !== "object" || Array.isArray(npc)) return false;
    const encounter = (npc as Record<string, unknown>).encounter;
    return !!encounter && typeof encounter === "object" && !Array.isArray(encounter)
      && Object.hasOwn(encounter, "victoryEffects");
  });
}

/** Explicit source-only item answers were introduced by ModuleCompileHints 1.9. */
function containsExplicitlyUnboundItemBinding(question: CompilerQuestion, value: unknown): boolean {
  return question.kind === "item_binding" && !!value && typeof value === "object" && !Array.isArray(value)
    && Object.hasOwn(value as object, "itemType") && (value as Record<string, unknown>).itemType === null;
}

/** Positive item bindings gained source-exact display evidence in hints 2.1. */
function containsPositiveItemBinding(question: CompilerQuestion, value: unknown): boolean {
  return question.kind === "item_binding" && !!value && typeof value === "object" && !Array.isArray(value)
    && Object.hasOwn(value as object, "itemType") && (value as Record<string, unknown>).itemType !== null;
}

function requiresExplicitNpcDialogueDeclaration(question: CompilerQuestion, value: unknown): boolean {
  if (question.kind !== "npc_binding" || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const present = (value as Record<string, unknown>).presentNpcs;
  return Array.isArray(present) && present.some((npc) => !!npc && typeof npc === "object" && !Array.isArray(npc)
    && !Object.hasOwn(npc as object, "dialogueMethods"));
}

/** Source-fact disposition is a breaking answer contract introduced in hints 2.0. */
function containsSourceFactDisposition(question: CompilerQuestion): boolean {
  return question.kind === "source_fact_disposition";
}

/** Detect the new wire before parsing so 3.0 fails by capability, not syntax. */
function containsSourceFactSceneTransition(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const declarations = (value as Record<string, unknown>).declarations;
  return Array.isArray(declarations) && declarations.some((declaration) => !!declaration && typeof declaration === "object"
    && !Array.isArray(declaration) && (declaration as Record<string, unknown>).kind === "scene_state_transition");
}

function documentIdentity(graph: SourceFactGraph): string { return graph.documentIdentity.documentHash ?? `synthetic:${graph.documentIdentity.sourceDescriptor ?? "unspecified"}`; }
function uniqueSorted(ids: readonly string[]): string[] { return [...new Set(ids)].sort(); }
/** Atom IDs are hashes; source span is the sole stable presentation order. */
function sourceOrderedClueFactAtoms(atoms: readonly DraftClueFactAtom[]): DraftClueFactAtom[] {
  return [...atoms].map((atom) => structuredClone(atom)).sort((left, right) => {
    const leftSpan = left.evidence.spans[0];
    const rightSpan = right.evidence.spans[0];
    if (!leftSpan || !rightSpan) return left.id.localeCompare(right.id);
    return leftSpan.pageNumber - rightSpan.pageNumber
      || leftSpan.rawStart - rightSpan.rawStart
      || leftSpan.rawEnd - rightSpan.rawEnd
      || left.id.localeCompare(right.id);
  });
}
function sourceOrderedSourceFactAtoms(atoms: readonly DraftSourceFactAtom[]): DraftSourceFactAtom[] {
  return [...atoms].map((atom) => structuredClone(atom)).sort((left, right) => {
    const leftSpan = left.evidence.spans[0];
    const rightSpan = right.evidence.spans[0];
    if (!leftSpan || !rightSpan) return left.id.localeCompare(right.id);
    return leftSpan.pageNumber - rightSpan.pageNumber
      || leftSpan.rawStart - rightSpan.rawStart
      || leftSpan.rawEnd - rightSpan.rawEnd
      || left.id.localeCompare(right.id);
  });
}
function questionId(graph: SourceFactGraph, kind: CompilerQuestionKind, sourceStatementIds: string[], role: string): string { return `question_${sha256(`${documentIdentity(graph)}|${kind}|${uniqueSorted(sourceStatementIds).join("|")}|${role}`).slice(0, 24)}`; }

function statements(graph: SourceFactGraph, ids: readonly string[]): SourceStatement[] {
  return ids.map((id) => {
    const statement = graph.statements.find((candidate) => candidate.id === id);
    if (!statement) throw new CompilerQuestionError("missing_statement", `question source statement is missing: ${id}`);
    return statement;
  });
}
function refs(graph: SourceFactGraph, ids: readonly string[]): string[] { return statements(graph, ids).map((statement) => statement.evidenceRefId); }

interface QuestionOptions {
  candidateIds?: string[];
  subjectCandidateId?: string;
  subjectStatementId?: string;
  allowedCandidateIds?: string[];
  allowedLocationCandidateIds?: string[];
  allowedMechanicsTargetIds?: Partial<Record<DiscoveryTarget, string[]>>;
  allowedClueFactAtoms?: DraftClueFactAtom[];
  allowedSourceFactAtoms?: DraftSourceFactAtom[];
  allowedProseFactFindingCandidates?: DraftProseFactFindingCandidate[];
  allowedItemNameEvidenceStatementIds?: string[];
  allowedRewardPredicateIds?: Partial<Record<"scene" | "clue" | "item", string[]>>;
  allowedDispositions?: Array<"source_only" | "mechanics_candidate">;
  sourceFactChildQuestionId?: string;
  sourceFactParentQuestionId?: string;
  owningSceneCandidateId?: string;
  owningHeadingStatementId?: string;
  initialStatus?: CompilerQuestionStatus;
}
function createQuestion(graph: SourceFactGraph, kind: CompilerQuestionKind, sourceStatementIds: string[], role: string, prompt: string, blockingCode: string, severity: CompilerQuestionSeverity, options: QuestionOptions = {}): CompilerQuestion {
  const sources = uniqueSorted(sourceStatementIds);
  if (sources.length === 0) throw new CompilerQuestionError("missing_source", `question ${kind} has no source statements`);
  const targets = options.allowedMechanicsTargetIds && Object.fromEntries(Object.entries(options.allowedMechanicsTargetIds).map(([kind, ids]) => [kind, uniqueSorted(ids!)]));
  const rewardTargets = options.allowedRewardPredicateIds && {
    scene: uniqueSorted(options.allowedRewardPredicateIds.scene ?? []),
    clue: uniqueSorted(options.allowedRewardPredicateIds.clue ?? []),
    item: uniqueSorted(options.allowedRewardPredicateIds.item ?? []),
  };
  return {
    id: questionId(graph, kind, sources, role), kind, prompt, sourceStatementIds: sources, evidenceRefs: refs(graph, sources),
    ...(options.candidateIds?.length ? { candidateIds: uniqueSorted(options.candidateIds) } : {}),
    ...(options.subjectCandidateId ? { subjectCandidateId: options.subjectCandidateId } : {}),
    ...(options.subjectStatementId ? { subjectStatementId: options.subjectStatementId } : {}),
    ...(options.allowedCandidateIds?.length ? { allowedCandidateIds: uniqueSorted(options.allowedCandidateIds) } : {}),
    ...(options.allowedLocationCandidateIds?.length ? { allowedLocationCandidateIds: uniqueSorted(options.allowedLocationCandidateIds) } : {}),
    ...(targets && Object.keys(targets).length ? { allowedMechanicsTargetIds: targets } : {}),
    ...(options.allowedClueFactAtoms ? { allowedClueFactAtoms: sourceOrderedClueFactAtoms(options.allowedClueFactAtoms) } : {}),
    ...(options.allowedSourceFactAtoms ? { allowedSourceFactAtoms: sourceOrderedSourceFactAtoms(options.allowedSourceFactAtoms) } : {}),
    ...(options.allowedProseFactFindingCandidates ? { allowedProseFactFindingCandidates: options.allowedProseFactFindingCandidates.map((candidate) => structuredClone(candidate)).sort((left, right) => left.id.localeCompare(right.id)) } : {}),
    ...(options.allowedItemNameEvidenceStatementIds?.length ? { allowedItemNameEvidenceStatementIds: [...options.allowedItemNameEvidenceStatementIds] } : {}),
    ...(rewardTargets ? { allowedRewardPredicateIds: rewardTargets } : {}),
    ...(options.allowedDispositions ? { allowedDispositions: uniqueSorted(options.allowedDispositions) as Array<"source_only" | "mechanics_candidate"> } : {}),
    ...(options.sourceFactChildQuestionId ? { sourceFactChildQuestionId: options.sourceFactChildQuestionId } : {}),
    ...(options.sourceFactParentQuestionId ? { sourceFactParentQuestionId: options.sourceFactParentQuestionId } : {}),
    ...(options.owningSceneCandidateId ? { owningSceneCandidateId: options.owningSceneCandidateId } : {}),
    ...(options.owningHeadingStatementId ? { owningHeadingStatementId: options.owningHeadingStatementId } : {}),
    status: options.initialStatus ?? "open", blockingCode, severity,
  };
}

function headingScopeSources(graph: SourceFactGraph, headingStatementId: string): string[] {
  return uniqueSorted([
    headingStatementId,
    ...graph.relations
      .filter((relation) => relation.kind === "heading_scopes" && relation.from === headingStatementId)
      .map((relation) => relation.to),
  ]);
}

type NpcEncounterStatLabel = "maxHp" | "dodge" | "fight" | "npcDamage";

/** A separately headed profile is offerable only when graph evidence proves all four stat slots. */
function encounterStatQuoteCandidates(text: string, label: NpcEncounterStatLabel): string[] {
  const pattern = label === "maxHp"
    ? /(?:hp|生命(?:值)?|生命力)\s*[:：=]?\s*\d{1,3}\s*(?:点|hp)?/gi
    : label === "dodge"
      ? /(?:dodge|闪避)\s*[:：=]?\s*\d{1,3}\s*%?/gi
      : label === "fight"
        ? /(?:fight|格斗)\s*[:：=]?\s*\d{1,3}\s*%?/gi
        : /(?:damage|伤害)\s*[:：=]?\s*\d{1,2}(?:\s*(?:d|骰)\s*\d{1,2})?/gi;
  return [...text.matchAll(pattern)].map((match) => match[0]!.trim()).filter((quote) => quote.length > 0);
}

function statementHasCompleteEncounterStat(statement: SourceStatement, label: NpcEncounterStatLabel): boolean {
  if (!(["paragraph", "table_row", "list_item"] as string[]).includes(statement.kind)) return false;
  return encounterStatQuoteCandidates(statement.text, label).some((quote) => {
    try {
      if (label === "npcDamage") parseEncounterDamageQuote(quote);
      else parseEncounterIntegerQuote(quote, label);
      return true;
    } catch {
      return false;
    }
  });
}

function headingHasCompleteEncounterProfile(graph: SourceFactGraph, heading: SourceStatement): boolean {
  const scoped = headingScopeSources(graph, heading.id)
    .map((id) => graph.statements.find((statement) => statement.id === id))
    .filter((statement): statement is SourceStatement => statement !== undefined);
  return (["maxHp", "dodge", "fight", "npcDamage"] as NpcEncounterStatLabel[])
    .every((label) => scoped.some((statement) => statementHasCompleteEncounterStat(statement, label)));
}

function offeredNpcEncounterProfileHeadings(
  graph: SourceFactGraph,
  paragraph: SourceStatement,
  locationHeading: SourceStatement,
): SourceStatement[] {
  return graph.statements
    .filter((statement): statement is SourceStatement => statement.kind === "heading"
      && statement.id !== locationHeading.id
      && statement.text.trim().length > 0
      && paragraph.text.includes(statement.text.trim())
      && headingHasCompleteEncounterProfile(graph, statement))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function headingMarkedItemSourceIds(graph: SourceFactGraph, heading: SourceStatement): string[] {
  return graph.statements
    .filter((statement) => {
      if (statement.kind !== "marked_item") return false;
      // Match deterministic-template-compiler's relationTarget() semantics:
      // one candidate belongs to the first structural heading relation.
      const scopedBy = graph.relations.find((relation) => relation.kind === "heading_scopes" && relation.to === statement.id);
      return scopedBy?.from === heading.id;
    })
    .flatMap((marked) => {
      const nameRelation = graph.relations.find((relation) => relation.kind === "marked_item_name" && relation.from === marked.id);
      const bodyRelation = graph.relations.find((relation) => relation.kind === "marked_item_body" && relation.from === marked.id);
      const name = nameRelation && graph.statements.find((statement) => statement.id === nameRelation.to);
      const body = bodyRelation && graph.statements.find((statement) => statement.id === bodyRelation.to);
      return name?.kind === "marked_item_name" && body?.kind === "marked_item_body"
        && name.text.trim() && body.text.trim() && body.evidence.spans.length > 0
        ? [marked.id, name.id, body.id]
        : [];
    });
}

function npcBindingQuestionSourceStatementIds(
  graph: SourceFactGraph,
  paragraph: SourceStatement,
  locationHeading: SourceStatement,
  profiles = offeredNpcEncounterProfileHeadings(graph, paragraph, locationHeading),
): string[] {
  return uniqueSorted([
    paragraph.id,
    ...headingScopeSources(graph, locationHeading.id),
    ...headingMarkedItemSourceIds(graph, locationHeading),
    ...profiles.flatMap((heading) => headingScopeSources(graph, heading.id)),
  ]);
}

const LEGACY_NPC_BINDING_PROMPT = "Bind only source-exact name quotes that are present in this ordinary paragraph. Each bound NPC may explicitly declare dialogueMethods that either reveal a marked clue candidate under this same heading, or (human review only) derive one independent prose clue from an exact relationshipEvidence statementId/quote in this anchor paragraph. Prose dialogue derives its clue ID, location, target, and sole discover_clue success effect; it cannot acquire an item. An NPC may optionally declare one encounter using exact same-heading statementId/quote evidence for HP, dodge, fight, and damage; every victoryEffects entry must bind one discover_clue or acquire_item effect to its exact same-heading marked-item candidate evidence. IDs, scene, target, and auto-start are compiler-derived. An empty presentNpcs array explicitly declares no NPC binding for this paragraph; dialogueMethods: [] explicitly declares no dialogue mechanism for that NPC.";
const PROFILE_NPC_BINDING_PROMPT = "Bind only source-exact name quotes that are present in this ordinary paragraph. Each bound NPC may explicitly declare dialogueMethods that either reveal a marked clue candidate under this same heading, or (human review only) derive one independent prose clue from an exact relationshipEvidence statementId/quote in this anchor paragraph. Prose dialogue derives its clue ID, location, target, and sole discover_clue success effect; it cannot acquire an item. An NPC may optionally declare one encounter using exact statementId/quote evidence for HP, dodge, fight, and damage from one heading only: the location heading or one offered complete profile heading. A profile encounter requires nameQuote to equal that profile heading exactly. Every victoryEffects entry must bind one discover_clue or acquire_item effect to its exact location-heading marked-item candidate evidence. IDs, scene, target, and auto-start are compiler-derived. An empty presentNpcs array explicitly declares no NPC binding for this paragraph; dialogueMethods: [] explicitly declares no dialogue mechanism for that NPC.";

function endingSources(graph: SourceFactGraph, draft: DraftModuleStructure): string[] {
  const explicitHeadings = draft.sceneCandidates
    .filter((scene) => /(?:结局|结尾|ending)/i.test(scene.displayName))
    .map((scene) => scene.headingStatementId);
  if (explicitHeadings.length > 0) return uniqueSorted(explicitHeadings.flatMap((heading) => headingScopeSources(graph, heading)));
  return uniqueSorted(graph.statements.map((statement) => statement.id));
}

/** Optional internal allocation guard for isolated untrusted-source preparation. */
export interface CompilerQuestionQueueBuildLimits { maxQuestions?: number; }

export function buildCompilerQuestionQueue(graph: SourceFactGraph, draft: DraftModuleStructure, limits?: CompilerQuestionQueueBuildLimits): CompilerQuestionQueue {
  validateSourceFactGraph(graph);
  const graphIdentity = sourceFactGraphIdentity(graph);
  if (draft.documentHash !== graph.documentIdentity.documentHash || draft.sourceGraphIdentity !== graphIdentity) throw new CompilerQuestionError("draft_identity_mismatch", "draft does not match SourceFactGraph identity");
  const storedQuestions: CompilerQuestion[] = [];
  const questions = new Proxy(storedQuestions, {
    get(target, key, receiver) {
      if (key === "push") return (...entries: CompilerQuestion[]): number => {
        if (limits?.maxQuestions !== undefined && target.length + entries.length > limits.maxQuestions) {
          throw new CompilerQuestionError("questions_limit_exceeded", "compiler question count exceeds the configured preparation budget");
        }
        return target.push(...entries);
      };
      return Reflect.get(target, key, receiver);
    },
  }) as CompilerQuestion[];
  const sceneIds = draft.sceneCandidates.map((scene) => scene.id);
  const rewardPredicateIds = {
    scene: sceneIds,
    clue: draft.clueCandidates.map((clue) => clue.id),
    item: draft.itemCandidates.map((item) => item.id),
  };
  for (const scene of draft.sceneCandidates) {
    questions.push(createQuestion(graph, "scene_role", [scene.headingStatementId], `scene:${scene.id}`, `Classify heading “${scene.displayName}” as a playable scene, rules section, character section, ending section, or other.`, "unresolved_scene_candidates", "publish_blocking", { candidateIds: [scene.id], subjectCandidateId: scene.id }));
    questions.push(createQuestion(graph, "connection_topology", headingScopeSources(graph, scene.headingStatementId), `topology:${scene.id}`, `Declare every outgoing connection from heading “${scene.displayName}”. An empty connections array explicitly declares zero outgoing edges; document order is not an edge.`, "missing_connection_topology", "publish_blocking", { candidateIds: [scene.id], subjectCandidateId: scene.id, allowedCandidateIds: sceneIds }));
  }
  const entrySources = draft.sceneCandidates.map((scene) => scene.headingStatementId);
  const fallbackEntrySources = entrySources.length ? entrySources : graph.statements[0] ? [graph.statements[0].id] : [];
  if (fallbackEntrySources.length) questions.push(createQuestion(graph, "entry_scene", fallbackEntrySources, "entry", "Select an explicit entry scene from the candidate headings; no heading is the default entry.", "missing_entry_scene", "publish_blocking", { candidateIds: sceneIds, allowedCandidateIds: sceneIds }));
  for (const clue of draft.clueCandidates) {
    const candidate = draft.itemCandidates.find((entry) => entry.markedItemStatementId === clue.markedItemStatementId);
    // A corrupted draft must not borrow an item identity from an adjacent clue
    // or emit a binding question for a forged candidate. The real clue review
    // questions remain present so a bad draft cannot disappear from the queue.
    const item = candidate && isCanonicalDraftItemCandidate(graph, candidate)
      ? candidate
      : undefined;
    const matchingItem = item
      && item.sceneCandidateId === clue.sceneCandidateId
      && item.nameStatementId === clue.nameStatementId
      && item.bodyStatementId === clue.bodyStatementId
      ? item
      : undefined;
    const sources = [clue.markedItemStatementId, clue.nameStatementId!, clue.bodyStatementId];
    questions.push(createQuestion(graph, "core_clue", sources, `core:${clue.id}`, `Decide whether marked item “${clue.displayName}” is required for the main path.`, "core_clue_unresolved", "draft_warning", { candidateIds: [clue.id], subjectCandidateId: clue.id }));
    const itemSources = item ? [item.markedItemStatementId, item.nameStatementId, item.bodyStatementId] : undefined;
    if (item && itemSources) questions.push(createQuestion(graph, "item_binding", itemSources, `item:${item.id}`, `Bind marked item “${item.displayName}” to one supported runtime item type with a source-exact name quote from its marked name or body, or leave it as source-only evidence.`, "item_binding_unresolved", "draft_warning", {
      candidateIds: [item.id],
      subjectCandidateId: item.id,
      allowedCandidateIds: [item.id],
      allowedItemNameEvidenceStatementIds: [item.nameStatementId, item.bodyStatementId],
    }));
    questions.push(createQuestion(graph, "discovery_method", sources, `discovery:${clue.id}`, `Declare an explicit discovery method for marked item “${clue.displayName}”, or leave the compatible default observation policy in force. Location and target use separate candidate domains.`, "unresolved_discovery_method", "draft_warning", {
      candidateIds: [clue.id], subjectCandidateId: clue.id, allowedLocationCandidateIds: [clue.sceneCandidateId],
      allowedMechanicsTargetIds: { scene: [clue.sceneCandidateId], clue: [clue.id], item: matchingItem ? [matchingItem.id] : [] },
    }));
    const scene = draft.sceneCandidates.find((candidate) => candidate.id === clue.sceneCandidateId);
    const atomIds = draft.clueFactAtoms
      .filter((atom) => atom.clueCandidateId === clue.id && atom.bodyStatementId === clue.bodyStatementId)
      .map((atom) => atom.id);
    questions.push(createQuestion(
      graph,
      "clue_fact_facets",
      scene ? [...sources, scene.headingStatementId] : sources,
      `clue-facets:${clue.id}`,
      atomIds.length
        ? "Partition every source-exact marked-clue body atom exactly once into visible shell, a gated finding, or source-only. Shell and findings must repeat the offered atom IDs and exact quotes. A finding supplies only declarationKey, action, target kind, check, and optional failback count; the compiler derives clue/mechanism IDs, heading location, availability, and discover effects."
        : "This marked clue body cannot be independently reconstructed into source-exact atoms. It remains draft-only: no whole-body shell or finding fallback is permitted.",
      "clue_fact_facets_unresolved",
      "publish_blocking",
      {
        candidateIds: [clue.id],
        subjectCandidateId: clue.id,
        allowedClueFactAtoms: draft.clueFactAtoms.filter((atom) => atomIds.includes(atom.id)),
        ...(scene ? { owningSceneCandidateId: scene.id, owningHeadingStatementId: scene.headingStatementId } : {}),
      },
    ));
  }
  const rewardRowStatementIds = new Set<string>();
  for (const reward of draft.rewardCandidates) {
    if (!isCanonicalDraftRewardCandidate(graph, reward)) {
      throw new CompilerQuestionError("invalid_reward_candidate", `reward candidate is not canonical source evidence: ${reward.id}`);
    }
    rewardRowStatementIds.add(reward.tableRowStatementId);
    questions.push(createQuestion(
      graph,
      "reward_binding",
      [reward.headingStatementId, reward.tableRowStatementId],
      `reward:${reward.id}`,
      "Confirm this source table row as a terminal reward, or explicitly declare it unbound. Conditions may only use clue_found, scene_visited, item_owned, all, any, and not; settlement supports positive SAN recovery, fixed Cthulhu Mythos, and fixed reputation.",
      "reward_binding_unresolved",
      "draft_warning",
      {
        candidateIds: [reward.id],
        subjectCandidateId: reward.id,
        allowedCandidateIds: [reward.id],
        allowedRewardPredicateIds: rewardPredicateIds,
      },
    ));
  }
  for (const anchor of draft.proseNpcAnchors) {
    const paragraph = graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
    const heading = graph.statements.find((statement) => statement.id === anchor.headingStatementId);
    if (!paragraph || paragraph.kind !== "paragraph" || !heading || heading.kind !== "heading") {
      throw new CompilerQuestionError("invalid_prose_npc_anchor", `prose NPC anchor is not a canonical source paragraph: ${anchor.id}`);
    }
    // The location remains the semantic owner of scene/auto-start.  Only a
    // named, complete profile can add its independently scoped evidence.
    const profiles = offeredNpcEncounterProfileHeadings(graph, paragraph, heading);
    const sourceStatementIds = npcBindingQuestionSourceStatementIds(graph, paragraph, heading, profiles);
    questions.push(createQuestion(
      graph,
      "npc_binding",
      sourceStatementIds,
      `prose-npc:${anchor.id}`,
      profiles.length ? PROFILE_NPC_BINDING_PROMPT : LEGACY_NPC_BINDING_PROMPT,
      "npc_binding_unresolved",
      "draft_warning",
      {
        candidateIds: [anchor.id],
        subjectCandidateId: anchor.id,
        subjectStatementId: anchor.paragraphStatementId,
        allowedCandidateIds: [anchor.id],
      },
    ));
  }
  for (const statementId of draft.readiness.unresolvedStatementIds) {
    const statement = graph.statements.find((candidate) => candidate.id === statementId);
    if (statement?.kind === "marked_item") questions.push(createQuestion(graph, "discovery_method", [statement.id], `unresolved-marked:${statement.id}`, "Resolve whether this marked item has an explicit discovery method; no clue is generated until it is resolved.", "unresolved_discovery_method", "draft_warning"));
  }
  // A rejected reward-shaped row is still a source root. Route it through the
  // existing source-only/mechanics-candidate disposition contract rather than
  // silently losing it or asking for a reward binding. Eligible rows above
  // remain in the narrower, source-bound reward review domain.
  for (const statement of graph.statements.filter((candidate) =>
    candidate.kind === "paragraph"
    || candidate.kind === "list_item"
    || (candidate.kind === "table_row" && !rewardRowStatementIds.has(candidate.id)),
  )) {
    // A source-fact child may be created only from one unambiguous structural
    // heading and a real same-heading clue domain.  A heading merely supplies
    // scope; it never substitutes for the root source fact's evidence.
    const headings = graph.relations
      .filter((relation) => relation.kind === "heading_scopes" && relation.to === statement.id)
      .map((relation) => graph.statements.find((candidate) => candidate.id === relation.from))
      .filter((candidate): candidate is SourceStatement => candidate?.kind === "heading" && statement.parentStatementId === candidate.id);
    const heading = headings.length === 1 ? headings[0] : undefined;
    const scene = heading && draft.sceneCandidates.find((candidate) => candidate.headingStatementId === heading.id);
    const sameHeadingClues = scene
      ? draft.clueCandidates.filter((candidate) => candidate.sceneCandidateId === scene.id
        && graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading!.id && relation.to === candidate.markedItemStatementId))
      : [];
    const sourceAtoms = draft.sourceFactAtoms.filter((atom) => atom.statementId === statement.id);
    // A prose finding may not re-state a structural marked clue's complete
    // source body.  Different facts in one heading remain independently
    // eligible; only exact duplicate revelation text is withheld.
    const proseFindingCandidates = draft.proseFactFindingCandidates.filter((candidate) => candidate.statementId === statement.id
      && sourceAtoms.some((atom) => atom.id === candidate.atomId)
      && !sameHeadingClues.some((clue) => {
        const body = graph.statements.find((entry) => entry.id === clue.bodyStatementId);
        return !!body && body.text.replace(/\s/g, "").includes(candidate.quote.replace(/\s/g, ""));
      }));
    const childSources = heading ? [statement.id, heading.id] : [];
    const childId = heading && scene && (sameHeadingClues.length || (sourceAtoms.length && proseFindingCandidates.length))
      ? questionId(graph, "source_fact_mechanic", childSources, `source-fact-mechanic:${statement.id}`)
      : undefined;
    questions.push(createQuestion(
      graph,
      "source_fact_disposition",
      [statement.id],
      `source-fact:${statement.id}`,
      childId
        ? `Classify this exact ${statement.kind} as source-only evidence or a mechanics candidate. A mechanics candidate activates one deferred, source-bound typed child; it does not itself declare runtime mechanics.`
        : `Classify this exact ${statement.kind} as source-only evidence. No safe typed mechanics domain exists under one owning heading and scene.`,
      "source_fact_disposition_unresolved",
      "draft_warning",
      {
        subjectStatementId: statement.id,
        allowedDispositions: childId ? ["source_only", "mechanics_candidate"] : ["source_only"],
        ...(childId ? { sourceFactChildQuestionId: childId } : {}),
      },
    ));
    if (!childId || !heading || !scene) continue;
    const parentId = questionId(graph, "source_fact_disposition", [statement.id], `source-fact:${statement.id}`);
    questions.push(createQuestion(
      graph,
      "source_fact_mechanic",
      childSources,
      `source-fact-mechanic:${statement.id}`,
      proseFindingCandidates.length
        ? "Select exactly one server-derived prose finding candidate and partition every offered root atom exactly once between that selected finding and source-only atoms. The compiler derives the clue, mechanism, EDU check, scene location, target, success effect, exact quote, and scope. No runtime IDs, skill, quote, target, location, effect, failure branch, or AST may be supplied. If legacy same-heading declarations are also offered, the two answer shapes are mutually exclusive: submit either this ID partition or the legacy declarations, never both."
        : "Declare one to four source-bound existing_clue_discovery or scene_state_transition declarations using only this child's closed same-heading domains. For transitions use trigger scene_enter or clue_found plus discoverClueCandidateId; clue_found needs declaration, trigger, prerequisite, and discover root-exact evidence, while scene_enter omits prerequisite. The compiler derives mechanism and interpretation IDs, location where applicable, guards, effects, private state, and scope. Do not supply runtime IDs, location, effects, or AST. Each declaration atom must cite the exact trimmed root statement; heading evidence supplies scope only.",
      "source_fact_mechanic_unresolved",
      "draft_warning",
      {
        subjectStatementId: statement.id,
        sourceFactParentQuestionId: parentId,
        owningSceneCandidateId: scene.id,
        owningHeadingStatementId: heading.id,
        allowedMechanicsTargetIds: {
          scene: [scene.id],
          clue: sameHeadingClues.map((candidate) => candidate.id),
          // A prepared item candidate is not a runtime symbol. Item targets
          // stay closed until a later source-fact mechanics revision can bind
          // them against an already accepted positive item_binding answer.
          item: [],
        },
        ...(proseFindingCandidates.length ? {
          allowedSourceFactAtoms: sourceAtoms,
          allowedProseFactFindingCandidates: proseFindingCandidates,
        } : {}),
        initialStatus: "deferred",
      },
    ));
  }
  const endingQuestionSources = endingSources(graph, draft);
  if (endingQuestionSources.length) questions.push(createQuestion(graph, "ending_rule", endingQuestionSources, "ending", "Declare one or more explicit ending rules and their end_game declarations; no ending condition or effect is inferred.", "missing_ending_rules", "publish_blocking", { candidateIds: sceneIds, allowedCandidateIds: [...sceneIds, ...draft.clueCandidates.map((clue) => clue.id)] }));
  const queue: CompilerQuestionQueue = { schemaVersion: COMPILER_QUESTION_QUEUE_SCHEMA_VERSION, moduleId: draft.moduleId, documentHash: draft.documentHash, sourceGraphIdentity: graphIdentity, questions: [...questions].sort((left, right) => left.id.localeCompare(right.id)), queueHash: "" };
  const completed = withQueueHash(queue);
  validateCompilerQuestionQueue(graph, completed);
  return completed;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompilerQuestionError("invalid_hint_value", `invalid ${label} hint value`);
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: readonly string[], label: string): void { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new CompilerQuestionError("invalid_hint_value", `undeclared ${label} field: ${key}`); }
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value)) throw new CompilerQuestionError("invalid_declaration", `invalid ${label} declaration`);
  return value;
}

/**
 * This is the entire automatic NPC wire contract. It intentionally admits
 * only source selections and structural containers: the parser derives every
 * runtime-facing field. Human-reviewed hints keep the wider npc_binding
 * contract and are not routed through this guard.
 */
export function validateAutomaticNpcProseDialogueProposalValue(value: unknown): void {
  const binding = object(value, "automatic npc_binding");
  only(binding, ["proseAnchorId", "presentNpcs"], "automatic npc_binding");
  if (!Array.isArray(binding.presentNpcs)) throw new CompilerQuestionError("invalid_hint_value", "automatic npc_binding presentNpcs must be an array");
  for (const [npcIndex, rawNpc] of binding.presentNpcs.entries()) {
    const npc = object(rawNpc, `automatic presentNpcs[${npcIndex}]`);
    only(npc, ["nameQuote", "dialogueMethods", "encounter"], `automatic presentNpcs[${npcIndex}]`);
    if (!Array.isArray(npc.dialogueMethods)) throw new CompilerQuestionError("invalid_hint_value", `automatic presentNpcs[${npcIndex}].dialogueMethods must be an array`);
    for (const [methodIndex, rawMethod] of npc.dialogueMethods.entries()) {
      const method = object(rawMethod, `automatic presentNpcs[${npcIndex}].dialogueMethods[${methodIndex}]`);
      only(method, ["relationshipEvidence"], `automatic presentNpcs[${npcIndex}].dialogueMethods[${methodIndex}]`);
      const evidence = object(method.relationshipEvidence, `automatic presentNpcs[${npcIndex}].dialogueMethods[${methodIndex}].relationshipEvidence`);
      only(evidence, ["statementId", "quote"], `automatic presentNpcs[${npcIndex}].dialogueMethods[${methodIndex}].relationshipEvidence`);
    }
    if (npc.encounter !== undefined) {
      const encounter = object(npc.encounter, `automatic presentNpcs[${npcIndex}].encounter`);
      only(encounter, ["maxHp", "dodge", "fight", "npcDamage"], `automatic presentNpcs[${npcIndex}].encounter`);
      for (const label of ["maxHp", "dodge", "fight", "npcDamage"] as const) {
        const evidence = object(encounter[label], `automatic presentNpcs[${npcIndex}].encounter.${label}`);
        only(evidence, ["statementId", "quote"], `automatic presentNpcs[${npcIndex}].encounter.${label}`);
      }
    }
  }
}
function candidate(question: CompilerQuestion, value: unknown, label: string, allowed = question.allowedCandidateIds ?? question.candidateIds ?? []): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new CompilerQuestionError("unknown_hint_reference", `unallowed ${label} candidate`);
  return value;
}

/**
 * MechanicsIR owns the reward predicate grammar.  This queue-level walk only
 * binds its already-parsed symbol references to the trusted question domain.
 */
function validateRewardPredicateReferences(
  predicate: RewardPredicate,
  allowed: Partial<Record<"scene" | "clue" | "item", string[]>>,
): void {
  switch (predicate.kind) {
    case "all":
    case "any":
      for (const entry of predicate.predicates) validateRewardPredicateReferences(entry, allowed);
      return;
    case "not":
      validateRewardPredicateReferences(predicate.predicate, allowed);
      return;
    case "scene_visited":
      if (!allowed.scene?.includes(predicate.sceneId)) throw new CompilerQuestionError("unknown_hint_reference", "reward predicate scene is outside its semantic domain");
      return;
    case "clue_found":
      if (!allowed.clue?.includes(predicate.clueId)) throw new CompilerQuestionError("unknown_hint_reference", "reward predicate clue is outside its semantic domain");
      return;
    case "item_owned":
      if (!allowed.item?.includes(predicate.itemId)) throw new CompilerQuestionError("unknown_hint_reference", "reward predicate item is outside its semantic domain");
      return;
  }
}

interface NpcDialogueClueCandidate {
  id: string;
  markedItemStatementId: string;
  nameStatementId: string;
  bodyStatementId: string;
  headingStatementId: string;
}

/**
 * The prose-clue identity is derived entirely from the reviewed anchor/NPC
 * relationship fact.  It deliberately has no draft candidate counterpart:
 * generating candidates for every prose anchor would turn ordinary narrative
 * into speculative compiler input before a human has selected a fact.
 */
export function deriveNpcProseDialogueClueId(
  graph: SourceFactGraph,
  proseAnchorId: string,
  npcId: string,
  relationshipEvidence: { statementId: string; quote: string },
): string {
  return `prose_clue_${sha256(`${documentIdentity(graph)}|npc_prose_dialogue|${proseAnchorId}|${npcId}|${relationshipEvidence.statementId}|${relationshipEvidence.quote}`).slice(0, 24)}`;
}

/**
 * Automatic prose dialogue does not accept a model-authored mechanism ID.
 * Deriving it from the same bounded evidence as the clue gives replay-stable
 * identity without opening a second naming channel to an untrusted proposer.
 */
export function deriveNpcProseDialogueMechanismId(
  graph: SourceFactGraph,
  proseAnchorId: string,
  npcId: string,
  relationshipEvidence: { statementId: string; quote: string },
): string {
  return `prose_talk_${sha256(`${documentIdentity(graph)}|npc_prose_dialogue_method|${proseAnchorId}|${npcId}|${relationshipEvidence.statementId}|${relationshipEvidence.quote}`).slice(0, 24)}`;
}

/**
 * NPC dialogue may only reveal a real marked clue under the NPC anchor's
 * already-verified heading.  This deliberately reconstructs the small source
 * domain from graph relations instead of accepting a caller-supplied location.
 */
function npcDialogueClueCandidatesForHeading(graph: SourceFactGraph, heading: SourceStatement): NpcDialogueClueCandidate[] {
  return graph.statements
    .filter((statement): statement is SourceStatement => statement.kind === "marked_item"
      && statement.parentStatementId === heading.id
      && graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === statement.id))
    .flatMap((marked) => {
      const name = graph.statements.find((statement) => statement.kind === "marked_item_name" && statement.parentStatementId === marked.id
        && graph.relations.some((relation) => relation.kind === "marked_item_name" && relation.from === marked.id && relation.to === statement.id));
      const body = graph.statements.find((statement) => statement.kind === "marked_item_body" && statement.parentStatementId === marked.id
        && graph.relations.some((relation) => relation.kind === "marked_item_body" && relation.from === marked.id && relation.to === statement.id));
      if (!name || !body || !name.text.trim() || !body.text.trim()) return [];
      return [{
        id: canonicalDraftId(graph, marked.evidence, "clue"),
        markedItemStatementId: marked.id,
        nameStatementId: name.id,
        bodyStatementId: body.id,
        headingStatementId: heading.id,
      }];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function npcDialogueClueCandidates(graph: SourceFactGraph, question: CompilerQuestion): NpcDialogueClueCandidate[] {
  return npcDialogueClueCandidatesForHeading(graph, npcBindingHeading(graph, question));
}

interface NpcBindingAnchorStatement {
  paragraph: SourceStatement;
  heading: SourceStatement;
}

/**
 * A prose-NPC question is about one paragraph, even though its evidence may
 * deliberately include the full same-heading domain for combat/dialogue
 * review.  Never select the first paragraph from that broader domain.
 */
function npcBindingAnchorStatement(graph: SourceFactGraph, question: CompilerQuestion): NpcBindingAnchorStatement {
  if (question.kind !== "npc_binding"
    || !question.subjectStatementId
    || !question.subjectCandidateId
    || !question.sourceStatementIds.includes(question.subjectStatementId)) {
    throw new CompilerQuestionError("invalid_question", "npc binding question lacks its canonical prose anchor statement");
  }
  const paragraph = graph.statements.find((statement) => statement.id === question.subjectStatementId);
  if (!paragraph || paragraph.kind !== "paragraph") {
    throw new CompilerQuestionError("invalid_question", "npc binding subject must be an exact source paragraph");
  }
  const heading = graph.statements.find((statement) => statement.id === paragraph.parentStatementId);
  if (!heading || heading.kind !== "heading") {
    throw new CompilerQuestionError("invalid_question", "npc binding paragraph lacks a real parent heading");
  }
  // Alternate profiles may extend the evidence domain, but the anchor's
  // location heading remains its required semantic owner.
  if (!question.sourceStatementIds.includes(heading.id)) {
    throw new CompilerQuestionError("invalid_question", "npc binding paragraph is not under its source heading");
  }
  const scoped = paragraph.parentStatementId === heading.id
    && graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === paragraph.id);
  if (!scoped) throw new CompilerQuestionError("invalid_question", "npc binding paragraph is not under its source heading");
  if (question.subjectCandidateId !== canonicalDraftId(graph, paragraph.evidence, "prose_npc")) {
    throw new CompilerQuestionError("invalid_question", "npc binding candidate does not match its canonical prose anchor");
  }
  const expectedSources = npcBindingQuestionSourceStatementIds(graph, paragraph, heading);
  if (uniqueSorted(question.sourceStatementIds).join("|") !== expectedSources.join("|")) {
    throw new CompilerQuestionError("invalid_question", "npc binding question source domain is not the canonical location/profile reconstruction");
  }
  return { paragraph, heading };
}

function npcBindingHeading(graph: SourceFactGraph, question: CompilerQuestion): SourceStatement {
  return npcBindingAnchorStatement(graph, question).heading;
}

/**
 * Automatic proposal gates must use this canonical anchor-derived location,
 * never the first heading in an NPC question's broader evidence envelope.
 */
export function npcBindingLocationScene(graph: SourceFactGraph, question: CompilerQuestion): {
  headingStatementId: string;
  sceneCandidateId: string;
} {
  const heading = npcBindingAnchorStatement(graph, question).heading;
  return {
    headingStatementId: heading.id,
    sceneCandidateId: canonicalDraftId(graph, heading.evidence, "scene"),
  };
}

/**
 * Runtime item labels may be reviewed from the structural label or its body,
 * but never from a neighbouring marked item or arbitrary prose.
 */
function itemNameEvidenceStatements(graph: SourceFactGraph, question: CompilerQuestion): { name: SourceStatement; body: SourceStatement } {
  if (question.kind !== "item_binding" || !question.subjectCandidateId || question.allowedCandidateIds?.length !== 1 || question.allowedCandidateIds[0] !== question.subjectCandidateId) {
    throw new CompilerQuestionError("invalid_question", "item binding question lacks one canonical item subject");
  }
  const marked = question.sourceStatementIds
    .map((id) => graph.statements.find((statement) => statement.id === id))
    .find((statement): statement is SourceStatement => statement?.kind === "marked_item");
  const name = question.sourceStatementIds
    .map((id) => graph.statements.find((statement) => statement.id === id))
    .find((statement): statement is SourceStatement => statement?.kind === "marked_item_name");
  const body = question.sourceStatementIds
    .map((id) => graph.statements.find((statement) => statement.id === id))
    .find((statement): statement is SourceStatement => statement?.kind === "marked_item_body");
  const nameRelation = marked && graph.relations.some((relation) => relation.kind === "marked_item_name" && relation.from === marked.id && relation.to === name?.id);
  const bodyRelation = marked && graph.relations.some((relation) => relation.kind === "marked_item_body" && relation.from === marked.id && relation.to === body?.id);
  const allowed = question.allowedItemNameEvidenceStatementIds;
  if (!marked || !name || !body || name.parentStatementId !== marked.id || body.parentStatementId !== marked.id
    || !nameRelation || !bodyRelation || question.subjectCandidateId !== canonicalDraftId(graph, marked.evidence, "item")
    || !allowed || allowed.length !== 2 || allowed[0] !== name.id || allowed[1] !== body.id) {
    throw new CompilerQuestionError("invalid_question", "item binding question lacks its canonical item name evidence domain");
  }
  return { name, body };
}

interface NpcEncounterVictoryTargetCandidate {
  kind: "clue" | "item";
  id: string;
  headingStatementId: string;
  markedItemStatementId: string;
  nameStatementId: string;
  bodyStatementId: string;
}

/**
 * Victory effects can only target the same structural marked-item candidates
 * already proven by the graph.  Connections and state keys have no equivalent
 * candidate relation in this graph, so they deliberately remain unsupported.
 */
function npcEncounterVictoryTargetCandidates(graph: SourceFactGraph, heading: SourceStatement): NpcEncounterVictoryTargetCandidate[] {
  return npcDialogueClueCandidatesForHeading(graph, heading).flatMap((clue) => {
    const marked = graph.statements.find((statement) => statement.id === clue.markedItemStatementId);
    if (!marked) throw new CompilerQuestionError("invalid_question", "NPC victory target lacks its marked-item source statement");
    const common = {
      headingStatementId: clue.headingStatementId,
      markedItemStatementId: clue.markedItemStatementId,
      nameStatementId: clue.nameStatementId,
      bodyStatementId: clue.bodyStatementId,
    };
    return [
      { kind: "clue" as const, id: clue.id, ...common },
      { kind: "item" as const, id: canonicalDraftId(graph, marked.evidence, "item"), ...common },
    ];
  }).sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

function parseNpcEncounterVictoryEffects(
  graph: SourceFactGraph,
  heading: SourceStatement,
  value: unknown,
): { effects: Effect[]; evidence: NpcEncounterVictoryEffectEvidence[] } {
  if (value === undefined) return { effects: [], evidence: [] };
  if (!Array.isArray(value) || value.length > 100) throw new CompilerQuestionError("invalid_hint_value", "victoryEffects must be an array of at most 100 entries");
  const candidates = new Map(npcEncounterVictoryTargetCandidates(graph, heading).map((candidate) => [candidate.id, candidate]));
  const parsed = value.map((entry, index) => {
    const binding = object(entry, `encounter.victoryEffects[${index}]`);
    only(binding, ["effect", "evidence"], `encounter.victoryEffects[${index}]`);
    const inputEvidence = object(binding.evidence, `encounter.victoryEffects[${index}].evidence`);
    only(inputEvidence, ["candidateId", "headingStatementId", "statementId", "quote"], `encounter.victoryEffects[${index}].evidence`);
    if (typeof inputEvidence.candidateId !== "string" || typeof inputEvidence.headingStatementId !== "string" || typeof inputEvidence.statementId !== "string" || typeof inputEvidence.quote !== "string") {
      throw new CompilerQuestionError("invalid_npc_victory_evidence", "victory effect evidence must identify one exact source candidate");
    }
    const candidate = candidates.get(inputEvidence.candidateId);
    if (!candidate || inputEvidence.headingStatementId !== heading.id || candidate.headingStatementId !== heading.id
      || inputEvidence.statementId !== candidate.markedItemStatementId) {
      throw new CompilerQuestionError("invalid_npc_victory_evidence", "victory effect target is outside the NPC heading's source candidates");
    }
    const statement = graph.statements.find((source) => source.id === candidate.markedItemStatementId);
    if (!statement || statement.kind !== "marked_item" || statement.parentStatementId !== heading.id || statement.text !== inputEvidence.quote) {
      throw new CompilerQuestionError("invalid_npc_victory_evidence", "victory effect must quote its exact same-heading marked-item statement");
    }
    let effect: Effect;
    try {
      const probe = parseMechanicsCandidateSpec({
        kind: "encounter_definition", id: "encounter_victory_probe", encounterId: "encounter_victory_probe",
        sceneId: "scene_probe", combatantId: "npc_probe", maxHp: 1, dodge: 0, fight: 0,
        npcDamage: { kind: "fixed", amount: 1 }, victoryEffects: [binding.effect],
      });
      if (probe.kind !== "encounter_definition") throw new Error("unreachable victory effect probe");
      effect = probe.victoryEffects[0]!;
    } catch (error) {
      throw new CompilerQuestionError("invalid_npc_victory_effect", error instanceof Error ? error.message : "invalid NPC victory effect");
    }
    const targetMatches = candidate.kind === "clue"
      ? effect.kind === "discover_clue" && effect.clueId === candidate.id
      : effect.kind === "acquire_item" && effect.itemId === candidate.id;
    if (!targetMatches) {
      throw new CompilerQuestionError("unsupported_npc_victory_effect", "NPC victory effects only support exact same-heading clue discovery or item acquisition");
    }
    return {
      effect,
      evidence: {
        candidateId: candidate.id,
        headingStatementId: heading.id,
        statementId: statement.id,
        quote: statement.text,
        sourceStatementIds: [heading.id, statement.id, candidate.nameStatementId, candidate.bodyStatementId],
      },
    };
  });
  return { effects: parsed.map((entry) => entry.effect), evidence: parsed.map((entry) => entry.evidence) };
}

function npcEncounterEvidence(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  heading: SourceStatement,
  value: unknown,
  label: string,
): { statement: SourceStatement; evidence: NpcEncounterStatEvidence } {
  const input = object(value, `encounter.${label}`);
  only(input, ["statementId", "quote"], `encounter.${label}`);
  if (typeof input.statementId !== "string" || !question.sourceStatementIds.includes(input.statementId)) {
    throw new CompilerQuestionError("unknown_hint_reference", `encounter ${label} statement is outside its reviewed heading`);
  }
  if (typeof input.quote !== "string" || input.quote !== input.quote.trim() || !input.quote || input.quote.length > 120) {
    throw new CompilerQuestionError("invalid_hint_value", `encounter ${label} quote must be a bounded trimmed source substring`);
  }
  const statement = graph.statements.find((candidate) => candidate.id === input.statementId);
  const inHeading = statement && (statement.parentStatementId === heading.id
    || graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === statement.id));
  if (!statement || !inHeading || !["paragraph", "table_row", "list_item"].includes(statement.kind) || !statement.text.includes(input.quote)) {
    throw new CompilerQuestionError("invalid_npc_encounter_evidence", `encounter ${label} must quote an exact same-heading fact statement`);
  }
  return { statement, evidence: { statementId: statement.id, quote: input.quote } };
}

function parsedEncounterInteger(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  heading: SourceStatement,
  value: unknown,
  label: "maxHp" | "dodge" | "fight",
): { value: number; evidence: NpcEncounterStatEvidence } {
  const source = npcEncounterEvidence(graph, question, heading, value, label);
  return { value: parseEncounterIntegerQuote(source.evidence.quote, label), evidence: source.evidence };
}

/** The profile-domain probe and resolved encounter share this exact parser. */
function parseEncounterIntegerQuote(quote: string, label: "maxHp" | "dodge" | "fight"): number {
  const pattern = label === "maxHp"
    ? /^\s*(?:hp|生命(?:值)?|生命力)\s*[:：=]?\s*(\d{1,3})\s*(?:点|hp)?\s*$/i
    : label === "dodge"
      ? /^\s*(?:dodge|闪避)\s*[:：=]?\s*(\d{1,3})\s*%?\s*$/i
      : /^\s*(?:fight|格斗)\s*[:：=]?\s*(\d{1,3})\s*%?\s*$/i;
  const match = quote.match(pattern);
  if (!match) throw new CompilerQuestionError("invalid_npc_encounter_stat", `encounter ${label} quote must contain exactly one labeled integer`);
  const parsed = Number(match[1]);
  const valid = label === "maxHp" ? parsed >= 1 && parsed <= 20 : parsed >= 0 && parsed <= 100;
  if (!Number.isSafeInteger(parsed) || !valid) throw new CompilerQuestionError("invalid_npc_encounter_stat", `encounter ${label} is outside bounded combat limits`);
  return parsed;
}

function parsedEncounterDamage(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  heading: SourceStatement,
  value: unknown,
): { value: CombatDamageSpec; evidence: NpcEncounterStatEvidence } {
  const source = npcEncounterEvidence(graph, question, heading, value, "npcDamage");
  return { value: parseEncounterDamageQuote(source.evidence.quote), evidence: source.evidence };
}

/** MechanicsIR remains the final grammar authority for profile probes too. */
function parseEncounterDamageQuote(quote: string): CombatDamageSpec {
  const match = quote.match(/^\s*(?:damage|伤害)\s*[:：=]?\s*(\d{1,2})(?:\s*(?:d|骰)\s*(\d{1,2}))?\s*$/i);
  if (!match) throw new CompilerQuestionError("invalid_npc_encounter_stat", "encounter npcDamage quote must contain exactly one labeled fixed or NdM damage value");
  const first = Number(match[1]);
  const second = match[2] === undefined ? undefined : Number(match[2]);
  const spec: CombatDamageSpec = second === undefined ? { kind: "fixed", amount: first } : { kind: "dice", count: first, sides: second };
  // Keep the source parser and MechanicsIR grammar identical rather than
  // relying on this local regexp's bounds alone.
  try {
    const parsed = parseMechanicsCandidateSpec({
      kind: "encounter_definition", id: "encounter_damage_probe", encounterId: "encounter_damage_probe",
      sceneId: "scene_probe", combatantId: "npc_probe", maxHp: 1, dodge: 0, fight: 0,
      npcDamage: spec, victoryEffects: [{ kind: "discover_clue", clueId: "clue_probe" }],
    });
    if (parsed.kind !== "encounter_definition") throw new Error("unreachable encounter probe");
    return parsed.npcDamage;
  } catch (error) {
    throw new CompilerQuestionError("invalid_npc_encounter_stat", error instanceof Error ? error.message : "invalid encounter damage");
  }
}

function automaticEncounterStatCandidatesFromSources(
  graph: SourceFactGraph,
  sourceStatementIds: readonly string[],
  label: NpcEncounterStatLabel,
): NpcEncounterStatEvidence[] {
  return sourceStatementIds
    .map((id) => graph.statements.find((statement) => statement.id === id))
    .filter((statement): statement is SourceStatement => statement !== undefined)
    .filter((statement) => ["paragraph", "table_row", "list_item"].includes(statement.kind))
    .flatMap((statement) => encounterStatQuoteCandidates(statement.text, label).flatMap((quote) => {
      try {
        if (label === "npcDamage") parseEncounterDamageQuote(quote);
        else parseEncounterIntegerQuote(quote, label);
        return [{ statementId: statement.id, quote }];
      } catch {
        return [];
      }
    }))
    .sort((left, right) => left.statementId.localeCompare(right.statementId) || left.quote.localeCompare(right.quote));
}

function automaticNpcEncounterProfileCandidate(
  graph: SourceFactGraph,
  paragraph: SourceStatement,
  locationHeading: SourceStatement,
  heading: SourceStatement,
): AllowedNpcEncounterProfile | undefined {
  // A location profile belongs to this exact NPC anchor, never another
  // paragraph in the same scene. Alternate profile headings are permitted
  // only as whole, independently named profile scopes.
  const sourceStatementIds = heading.id === locationHeading.id
    ? [paragraph.id]
    : headingScopeSources(graph, heading.id);
  const statCandidates = {
    maxHp: automaticEncounterStatCandidatesFromSources(graph, sourceStatementIds, "maxHp"),
    dodge: automaticEncounterStatCandidatesFromSources(graph, sourceStatementIds, "dodge"),
    fight: automaticEncounterStatCandidatesFromSources(graph, sourceStatementIds, "fight"),
    npcDamage: automaticEncounterStatCandidatesFromSources(graph, sourceStatementIds, "npcDamage"),
  };
  // Never let a model choose between facts that could describe different
  // combatants. One unique direct candidate per slot is the whole contract.
  if (!(Object.keys(statCandidates) as NpcEncounterStatLabel[])
    .every((label) => statCandidates[label].length === 1)) return undefined;
  return {
    headingStatementId: heading.id,
    ...(heading.id === locationHeading.id ? {} : { requiredNameQuote: heading.text.trim() }),
    statCandidates,
  };
}

/**
 * The only automatic combat selection domain.  It is reconstructed from the
 * canonical anchor location and complete, name-bound alternate profiles, not
 * from proposal fields or sourceStatementIds ordering.
 */
export function allowedNpcEncounterProfiles(
  graph: SourceFactGraph,
  question: CompilerQuestion,
): AllowedNpcEncounterProfile[] {
  const { paragraph, heading: locationHeading } = npcBindingAnchorStatement(graph, question);
  const profiles = [locationHeading, ...offeredNpcEncounterProfileHeadings(graph, paragraph, locationHeading)]
    .map((heading) => automaticNpcEncounterProfileCandidate(graph, paragraph, locationHeading, heading))
    .filter((profile): profile is AllowedNpcEncounterProfile => profile !== undefined)
    .sort((left, right) => left.headingStatementId.localeCompare(right.headingStatementId));
  // An automatic encounter cannot make an ownership choice. A human reviewer
  // still has the broader same-heading parser below; only untrusted proposals
  // are fail-closed when the document offers more than one complete owner.
  return profiles.length === 1 ? profiles : [];
}

function automaticNpcEncounterProfile(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  npc: Extract<ParsedCompilerHintValue, { kind: "npc_binding" }> ["presentNpcs"][number],
): AllowedNpcEncounterProfile | undefined {
  if (!npc.encounter) return undefined;
  const headingId = npcEncounterEvidenceHeadingId(graph, question, npc.nameQuote, npc.encounter.statEvidence);
  const profile = allowedNpcEncounterProfiles(graph, question).find((candidate) => candidate.headingStatementId === headingId);
  if (!profile || (profile.requiredNameQuote !== undefined && npc.nameQuote !== profile.requiredNameQuote)) return undefined;
  for (const label of ["maxHp", "dodge", "fight", "npcDamage"] as const) {
    const selected = npc.encounter.statEvidence[label];
    if (!profile.statCandidates[label].some((candidate) => candidate.statementId === selected.statementId && candidate.quote === selected.quote)) return undefined;
  }
  return profile;
}

function npcEncounterHeadingForStatementIds(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  nameQuote: string,
  statementIds: readonly string[],
): SourceStatement {
  const { paragraph, heading: locationHeading } = npcBindingAnchorStatement(graph, question);
  const candidates = [locationHeading, ...offeredNpcEncounterProfileHeadings(graph, paragraph, locationHeading)];
  const matches = candidates.filter((heading) => {
    const scope = new Set(headingScopeSources(graph, heading.id));
    return statementIds.every((statementId) => scope.has(statementId));
  });
  if (matches.length !== 1) {
    throw new CompilerQuestionError("invalid_npc_encounter_evidence", "all encounter stats must come from one offered location or profile heading");
  }
  const selected = matches[0]!;
  if (selected.id !== locationHeading.id && nameQuote !== selected.text.trim()) {
    throw new CompilerQuestionError("invalid_name_quote", "a profile-backed encounter nameQuote must exactly equal its profile heading");
  }
  return selected;
}

/** Reconstructs the stat profile identity for resolved-artifact validation. */
export function npcEncounterEvidenceHeadingId(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  nameQuote: string,
  statEvidence: ParsedNpcEncounterBinding["statEvidence"],
): string {
  return npcEncounterHeadingForStatementIds(graph, question, nameQuote, [
    statEvidence.maxHp.statementId,
    statEvidence.dodge.statementId,
    statEvidence.fight.statementId,
    statEvidence.npcDamage.statementId,
  ]).id;
}

function parseNpcEncounterBinding(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  proseAnchorId: string,
  npcId: string,
  nameQuote: string,
  sceneId: string,
  value: unknown,
): ParsedNpcEncounterBinding {
  const input = object(value, "encounter");
  only(input, ["maxHp", "dodge", "fight", "npcDamage", "victoryEffects"], "encounter");
  const statStatementIds = (["maxHp", "dodge", "fight", "npcDamage"] as const).map((label) => {
    const evidence = object(input[label], `encounter.${label}`);
    if (typeof evidence.statementId !== "string") {
      throw new CompilerQuestionError("unknown_hint_reference", `encounter ${label} statement is outside its reviewed heading`);
    }
    return evidence.statementId;
  });
  const heading = npcEncounterHeadingForStatementIds(graph, question, nameQuote, statStatementIds);
  const maxHp = parsedEncounterInteger(graph, question, heading, input.maxHp, "maxHp");
  const dodge = parsedEncounterInteger(graph, question, heading, input.dodge, "dodge");
  const fight = parsedEncounterInteger(graph, question, heading, input.fight, "fight");
  const npcDamage = parsedEncounterDamage(graph, question, heading, input.npcDamage);
  const victory = parseNpcEncounterVictoryEffects(graph, npcBindingAnchorStatement(graph, question).heading, input.victoryEffects);
  const document = documentIdentity(graph);
  const encounterId = `encounter_${sha256(`${document}|npc_encounter|${proseAnchorId}|${npcId}`).slice(0, 24)}`;
  const autoStartMechanismId = `start_encounter_${sha256(`${document}|npc_encounter_start|${proseAnchorId}|${npcId}`).slice(0, 24)}`;
  let definition;
  try {
    definition = parseMechanicsCandidateSpec({
      kind: "encounter_definition", id: encounterId, encounterId, sceneId, combatantId: npcId,
      maxHp: maxHp.value, dodge: dodge.value, fight: fight.value, npcDamage: npcDamage.value,
      victoryEffects: victory.effects,
    });
  } catch (error) {
    throw new CompilerQuestionError("invalid_npc_encounter", error instanceof Error ? error.message : "invalid NPC encounter declaration");
  }
  if (definition.kind !== "encounter_definition") throw new CompilerQuestionError("invalid_npc_encounter", "NPC encounter did not produce an encounter definition");
  return {
    encounterId,
    autoStartMechanismId,
    sceneId,
    combatantId: npcId,
    maxHp: definition.maxHp,
    dodge: definition.dodge,
    fight: definition.fight,
    npcDamage: definition.npcDamage,
    victoryEffects: definition.victoryEffects,
    victoryEffectEvidence: victory.evidence,
    statEvidence: { maxHp: maxHp.evidence, dodge: dodge.evidence, fight: fight.evidence, npcDamage: npcDamage.evidence },
  };
}

function sourceFactMechanicRootAndHeading(graph: SourceFactGraph, question: CompilerQuestion): { root: SourceStatement; heading: SourceStatement } {
  if (question.kind !== "source_fact_mechanic" || !question.subjectStatementId || !question.sourceFactParentQuestionId
    || !question.owningSceneCandidateId || !question.owningHeadingStatementId
    || !question.allowedMechanicsTargetIds
    || question.sourceStatementIds.length !== 2
    || !question.sourceStatementIds.includes(question.subjectStatementId)
    || !question.sourceStatementIds.includes(question.owningHeadingStatementId)) {
    throw new CompilerQuestionError("invalid_question", "source fact mechanic question lacks its canonical parent, root, heading, and target domain");
  }
  const root = graph.statements.find((statement) => statement.id === question.subjectStatementId);
  const heading = graph.statements.find((statement) => statement.id === question.owningHeadingStatementId);
  if (!root || !["paragraph", "list_item", "table_row"].includes(root.kind)
    || !heading || heading.kind !== "heading" || root.parentStatementId !== heading.id
    || !graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === root.id)
    || question.owningSceneCandidateId !== canonicalDraftId(graph, heading.evidence, "scene")
    || question.allowedMechanicsTargetIds.scene?.length !== 1
    || question.allowedMechanicsTargetIds.scene[0] !== question.owningSceneCandidateId
    || (!(question.allowedMechanicsTargetIds.clue?.length) && !question.allowedProseFactFindingCandidates?.length)) {
    throw new CompilerQuestionError("invalid_question", "source fact mechanic question has an invalid source scope, canonical draft scene, or empty typed domain");
  }
  return { root, heading };
}

function sourceFactProseDomains(
  graph: SourceFactGraph,
  question: CompilerQuestion,
): { root: SourceStatement; atoms: DraftSourceFactAtom[]; candidates: DraftProseFactFindingCandidate[] } {
  const { root } = sourceFactMechanicRootAndHeading(graph, question);
  const atoms = question.allowedSourceFactAtoms;
  const candidates = question.allowedProseFactFindingCandidates;
  if (!atoms || !candidates || !atoms.length || !candidates.length) {
    throw new CompilerQuestionError("invalid_question", "prose finding child lacks its closed root atom and finding domains");
  }
  const canonicalAtoms = deriveSourceFactAtoms(graph, root);
  if (canonical(atoms) !== canonical(canonicalAtoms)) {
    throw new CompilerQuestionError("invalid_question", "prose finding root atom IDs or evidence do not match canonical source derivation");
  }
  const markedDuplicate = (candidate: DraftProseFactFindingCandidate): boolean => graph.statements
    .filter((statement) => statement.kind === "marked_item_body" && statement.text.replace(/\s/g, "").includes(candidate.quote.replace(/\s/g, "")))
    .some((body) => {
      const marked = graph.statements.find((statement) => statement.id === body.parentStatementId);
      return !!marked && graph.relations.some((relation) => relation.kind === "heading_scopes"
        && relation.from === question.owningHeadingStatementId && relation.to === marked.id);
    });
  const canonicalCandidates = deriveProseFactFindingCandidates(graph, root, canonicalAtoms)
    .filter((candidate) => !markedDuplicate(candidate))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (canonical(candidates) !== canonical(canonicalCandidates)) {
    throw new CompilerQuestionError("invalid_question", "prose finding candidate IDs or checks do not match canonical source derivation");
  }
  const ordered = sourceOrderedSourceFactAtoms(atoms);
  if (ordered.map((atom) => atom.id).join("|") !== atoms.map((atom) => atom.id).join("|")
    || new Set(atoms.map((atom) => atom.id)).size !== atoms.length) {
    throw new CompilerQuestionError("invalid_question", "prose finding root atoms must be source-ordered and unique");
  }
  let previousEnd = -1;
  for (const atom of atoms) {
    const span = atom.evidence.spans[0];
    const page = span && graph.documentIdentity.pages.find((candidate) => candidate.pageNumber === span.pageNumber);
    try { validateEvidenceRef(atom.evidence, graph.documentIdentity); }
    catch { throw new CompilerQuestionError("invalid_question", "prose finding root atom has invalid evidence identity"); }
    if (atom.status !== "candidate" || atom.statementId !== root.id || atom.evidence.spans.length !== 1
      || !span || !page || page.rawText.slice(span.rawStart, span.rawEnd) !== atom.quote
      || !atom.quote.trim() || span.rawStart < previousEnd) {
      throw new CompilerQuestionError("invalid_question", "prose finding root atom is not one exact non-overlapping source span");
    }
    previousEnd = span.rawEnd;
  }
  if (atoms.map((atom) => atom.quote).join("").replace(/\s/g, "") !== root.text.replace(/\s/g, "")) {
    throw new CompilerQuestionError("invalid_question", "prose finding root atoms must reconstruct the exact source statement");
  }
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new CompilerQuestionError("invalid_question", "prose finding candidate IDs must be unique");
  }
  for (const candidate of candidates) {
    const atom = atomById.get(candidate.atomId);
    if (candidate.status !== "candidate" || candidate.statementId !== root.id || !atom || candidate.quote !== atom.quote
      || candidate.check.kind !== "attribute" || candidate.check.attribute !== "edu" || candidate.check.difficulty !== "regular"
      || !/^成功的知识鉴定后[，,:：][^。！？!?]+[。！？!?]?$/.test(candidate.quote.replace(/\s/g, ""))) {
      throw new CompilerQuestionError("invalid_question", "prose finding candidate is not a canonical single Knowledge success atom");
    }
  }
  return { root, atoms, candidates };
}

export function deriveSourceFactMechanicId(
  graph: SourceFactGraph,
  childQuestionId: string,
  declarationKey: string,
  declarationKind: ParsedSourceFactMechanicDeclaration["kind"],
): string {
  return `source_mechanic_${sha256(`${documentIdentity(graph)}|source_fact_mechanic|${childQuestionId}|${declarationKey}|${declarationKind}`).slice(0, 24)}`;
}

/** The prose clue identity is compiler-owned and binds the selected candidate. */
export function deriveSourceFactProseFindingClueId(graph: SourceFactGraph, childQuestionId: string, candidateId: string): string {
  return `source_prose_clue_${sha256(`${documentIdentity(graph)}|source_fact_prose_finding|${childQuestionId}|${candidateId}`).slice(0, 24)}`;
}

/** The transition sentinel shares the exact ID digest with its mechanism. */
export function deriveSourceFactMechanicStateKey(
  graph: SourceFactGraph,
  childQuestionId: string,
  declarationKey: string,
  declarationKind: "scene_state_transition",
): string {
  return `source_state_${deriveSourceFactMechanicId(graph, childQuestionId, declarationKey, declarationKind).slice("source_mechanic_".length)}`;
}

type SourceFactMechanicEvidenceDeclaration =
  | Pick<ParsedExistingClueSourceFactMechanicDeclaration, "declarationKey" | "kind" | "spec">
  | Pick<ParsedProseFactFindingSourceFactMechanicDeclaration, "declarationKey" | "kind" | "spec">
  | Pick<ParsedSceneStateTransitionSourceFactMechanicDeclaration, "declarationKey" | "kind" | "trigger" | "spec">;

export function sourceFactMechanicClaimKeys(statementId: string, declaration: SourceFactMechanicEvidenceDeclaration): string[] {
  const base = `source_fact_mechanic:${statementId}:${declaration.declarationKey}`;
  if (declaration.kind === "scene_state_transition") {
    return [
      `${base}:declaration`,
      `${base}:trigger`,
      ...(declaration.trigger.kind === "clue_found" ? [`${base}:prerequisite`] : []),
      `${base}:discover`,
    ];
  }
  if (declaration.kind === "prose_fact_finding") return [`${base}:finding`];
  const spec = declaration.spec;
  return [
    `${base}:declaration`,
    `${base}:action`,
    `${base}:target`,
    ...(spec.check === undefined ? [] : [`${base}:check`]),
    ...(spec.availability === undefined ? [] : [`${base}:availability`]),
    `${base}:discover`,
    ...(spec.onSuccess.some((effect) => effect.kind === "acquire_item") ? [`${base}:acquire`] : []),
  ];
}

function sourceFactMechanicEvidence(
  root: SourceStatement,
  declaration: SourceFactMechanicEvidenceDeclaration,
  value: unknown,
): SourceFactMechanicEvidence[] {
  if (!Array.isArray(value)) throw new CompilerQuestionError("invalid_hint_value", "source fact mechanic declaration evidence must be an array");
  const required = sourceFactMechanicClaimKeys(root.id, declaration);
  if (value.length !== required.length) throw new CompilerQuestionError("invalid_source_fact_evidence", "source fact mechanic evidence must cover every declaration atom exactly once");
  const evidence = value.map((entry, index) => {
    const item = object(entry, `source fact mechanic evidence[${index}]`);
    only(item, ["claimKey", "statementId", "quote"], `source fact mechanic evidence[${index}]`);
    if (typeof item.claimKey !== "string" || typeof item.statementId !== "string" || typeof item.quote !== "string") {
      throw new CompilerQuestionError("invalid_source_fact_evidence", "source fact mechanic evidence must contain strings");
    }
    return { claimKey: item.claimKey, statementId: item.statementId, quote: item.quote };
  });
  const keys = evidence.map((item) => item.claimKey);
  if (new Set(keys).size !== keys.length || keys.sort().join("|") !== [...required].sort().join("|")) {
    throw new CompilerQuestionError("invalid_source_fact_evidence", "source fact mechanic evidence claim keys do not match the declaration atoms");
  }
  const quote = root.text.trim();
  if (!quote || evidence.some((item) => item.statementId !== root.id || item.quote !== quote)) {
    throw new CompilerQuestionError("invalid_source_fact_evidence", "source fact mechanic evidence must exactly quote its trimmed root statement");
  }
  return evidence.sort((left, right) => left.claimKey.localeCompare(right.claimKey));
}

function safeSourceFactPredicate(
  predicate: Predicate,
  allowed: Required<Pick<NonNullable<CompilerQuestion["allowedMechanicsTargetIds"]>, "scene" | "clue" | "item">>,
): void {
  switch (predicate.kind) {
    case "all":
    case "any": predicate.predicates.forEach((entry) => safeSourceFactPredicate(entry, allowed)); return;
    case "not": safeSourceFactPredicate(predicate.predicate, allowed); return;
    case "clue_found": if (allowed.clue.includes(predicate.clueId)) return; break;
    case "scene_visited":
    case "current_scene": if (allowed.scene.includes(predicate.sceneId)) return; break;
    case "item_owned": if (allowed.item.includes(predicate.itemId)) return; break;
  }
  throw new CompilerQuestionError("unknown_hint_reference", "source fact mechanic predicate is outside its same-heading safe domain");
}

/**
 * The only prose-finding answer is a partition of prepared IDs.  It has no
 * caller-authored quote, check, location, target, effect, mechanism, or clue
 * field; all of those are reconstructed below from the selected candidate.
 */
function parseSourceFactProseFindingValue(
  question: CompilerQuestion,
  value: Record<string, unknown>,
  graph: SourceFactGraph,
): Extract<ParsedCompilerHintValue, { kind: "source_fact_mechanic" }> {
  only(value, ["findingCandidateIds", "sourceOnlyAtomIds"], "source_fact_mechanic prose finding");
  const { root, atoms, candidates } = sourceFactProseDomains(graph, question);
  if (!Array.isArray(value.findingCandidateIds) || value.findingCandidateIds.length !== 1
    || value.findingCandidateIds.some((id) => typeof id !== "string")) {
    throw new CompilerQuestionError("invalid_hint_value", "prose finding requires exactly one offered finding candidate ID");
  }
  if (!Array.isArray(value.sourceOnlyAtomIds) || value.sourceOnlyAtomIds.some((id) => typeof id !== "string")) {
    throw new CompilerQuestionError("invalid_hint_value", "prose finding sourceOnlyAtomIds must be an atom ID array");
  }
  const findingCandidateIds = value.findingCandidateIds as string[];
  const sourceOnlyInput = value.sourceOnlyAtomIds as string[];
  const candidate = candidates.find((entry) => entry.id === findingCandidateIds[0]);
  if (!candidate) throw new CompilerQuestionError("unknown_hint_reference", "prose finding candidate is outside the prepared closed domain");
  const sourceOnlyAtomIds = [...sourceOnlyInput].sort();
  if (new Set(sourceOnlyAtomIds).size !== sourceOnlyAtomIds.length || sourceOnlyAtomIds.some((id) => !atoms.some((atom) => atom.id === id))) {
    throw new CompilerQuestionError("invalid_source_fact_partition", "prose finding source-only atoms must be unique offered atom IDs");
  }
  const partition = [candidate.atomId, ...sourceOnlyAtomIds];
  if (new Set(partition).size !== partition.length || partition.length !== atoms.length
    || partition.sort().join("|") !== atoms.map((atom) => atom.id).sort().join("|")) {
    throw new CompilerQuestionError("incomplete_source_fact_partition", "prose finding must dispose every root atom exactly once as selected finding or source-only");
  }
  const clueId = deriveSourceFactProseFindingClueId(graph, question.id, candidate.id);
  const mechanismId = deriveSourceFactMechanicId(graph, question.id, candidate.id, "prose_fact_finding");
  let spec: DiscoveryMethodSpec;
  try {
    const parsed = parseMechanicsCandidateSpec({
      kind: "discovery_method",
      id: mechanismId,
      clueId,
      action: "search",
      target: "scene",
      targetId: question.owningSceneCandidateId,
      check: candidate.check,
      onSuccess: [{ kind: "discover_clue", clueId }],
    });
    if (parsed.kind !== "discovery_method") throw new Error("unreachable prose finding parser");
    spec = parsed;
  } catch (error) {
    throw new CompilerQuestionError("invalid_source_fact_mechanic", error instanceof Error ? error.message : "invalid prose source finding");
  }
  const declaration: ParsedProseFactFindingSourceFactMechanicDeclaration = {
    kind: "prose_fact_finding",
    declarationKey: candidate.id,
    candidateId: candidate.id,
    atomId: candidate.atomId,
    clueId,
    mechanismId,
    quote: candidate.quote,
    check: structuredClone(candidate.check),
    sourceOnlyAtomIds,
    spec,
    evidence: [{
      claimKey: sourceFactMechanicClaimKeys(root.id, { declarationKey: candidate.id, kind: "prose_fact_finding", spec })[0]!,
      statementId: root.id,
      quote: candidate.quote,
    }],
  };
  return {
    kind: "source_fact_mechanic",
    parentQuestionId: question.sourceFactParentQuestionId!,
    statementId: root.id,
    declarations: [declaration],
  };
}

function parseSourceFactMechanicValue(question: CompilerQuestion, value: Record<string, unknown>, graph: SourceFactGraph): Extract<ParsedCompilerHintValue, { kind: "source_fact_mechanic" }> {
  if (question.allowedProseFactFindingCandidates?.length
    && (!question.allowedMechanicsTargetIds?.clue?.length || Object.hasOwn(value, "findingCandidateIds") || Object.hasOwn(value, "sourceOnlyAtomIds"))) {
    return parseSourceFactProseFindingValue(question, value, graph);
  }
  only(value, ["declarations"], "source_fact_mechanic");
  const { root } = sourceFactMechanicRootAndHeading(graph, question);
  if (!Array.isArray(value.declarations) || value.declarations.length < 1 || value.declarations.length > 4) {
    throw new CompilerQuestionError("invalid_hint_value", "source fact mechanics require one to four declarations");
  }
  const declarationKeys = new Set<string>();
  const transitionSlots = new Set<string>();
  const allowed = question.allowedMechanicsTargetIds!;
  const domains = {
    scene: allowed.scene ?? [],
    clue: allowed.clue ?? [],
    item: allowed.item ?? [],
  };
  const declarations = value.declarations.map((raw, index) => {
    const declaration = object(raw, `source_fact_mechanic.declarations[${index}]`);
    const declarationKey = identifier(declaration.declarationKey, "source fact mechanic declarationKey");
    if (declarationKeys.has(declarationKey)) throw new CompilerQuestionError("duplicate_declaration", `duplicate source fact mechanic declarationKey: ${declarationKey}`);
    declarationKeys.add(declarationKey);
    if (declaration.kind === "existing_clue_discovery") {
      only(declaration, ["declarationKey", "kind", "clueCandidateId", "action", "target", "targetId", "check", "availability", "evidence"], `source_fact_mechanic.declarations[${index}]`);
      if (typeof declaration.clueCandidateId !== "string" || !domains.clue.includes(declaration.clueCandidateId)) {
        throw new CompilerQuestionError("unknown_hint_reference", "source fact mechanic clue must be a same-heading canonical clue");
      }
      if (!( ["observe", "search", "read", "use_item", "move"] as string[]).includes(declaration.action as string)
        || !( ["scene", "clue", "item"] as string[]).includes(declaration.target as string)
        || typeof declaration.targetId !== "string") {
        throw new CompilerQuestionError("invalid_hint_value", "source fact existing-clue discovery has an unsupported action or target");
      }
      const targetIds = domains[declaration.target as "scene" | "clue" | "item"];
      if (!targetIds.includes(declaration.targetId)) throw new CompilerQuestionError("unknown_hint_reference", "source fact mechanic target is outside its same-heading domain");
      const mechanismId = deriveSourceFactMechanicId(graph, question.id, declarationKey, "existing_clue_discovery");
      let spec: DiscoveryMethodSpec;
      try {
        const parsed = parseMechanicsCandidateSpec({
          kind: "discovery_method", id: mechanismId, clueId: declaration.clueCandidateId,
          action: declaration.action, target: declaration.target, targetId: declaration.targetId,
          ...(declaration.check === undefined ? {} : { check: declaration.check }),
          ...(declaration.availability === undefined ? {} : { availability: declaration.availability }),
          onSuccess: [
            { kind: "discover_clue", clueId: declaration.clueCandidateId },
            ...(declaration.target === "item" ? [{ kind: "acquire_item" as const, itemId: declaration.targetId }] : []),
          ],
        });
        if (parsed.kind !== "discovery_method") throw new Error("unreachable source fact discovery parser");
        spec = parsed;
      } catch (error) {
        throw new CompilerQuestionError("invalid_source_fact_mechanic", error instanceof Error ? error.message : "invalid source fact discovery");
      }
      if (spec.availability) safeSourceFactPredicate(spec.availability, domains);
      const parsed: ParsedExistingClueSourceFactMechanicDeclaration = {
        kind: "existing_clue_discovery", declarationKey, mechanismId, clueId: declaration.clueCandidateId, spec, evidence: [],
      };
      parsed.evidence = sourceFactMechanicEvidence(root, parsed, declaration.evidence);
      return parsed;
    }
    if (declaration.kind !== "scene_state_transition") {
      throw new CompilerQuestionError("unsupported_source_fact_mechanic", "unsupported source fact mechanic kind");
    }
    only(declaration, ["declarationKey", "kind", "trigger", "discoverClueCandidateId", "evidence"], `source_fact_mechanic.declarations[${index}]`);
    if (typeof declaration.discoverClueCandidateId !== "string" || !domains.clue.includes(declaration.discoverClueCandidateId)) {
      throw new CompilerQuestionError("unknown_hint_reference", "source fact transition output must be a same-heading canonical clue");
    }
    const rawTrigger = object(declaration.trigger, "source fact transition trigger");
    let trigger: ParsedSceneStateTransitionSourceFactMechanicDeclaration["trigger"];
    if (rawTrigger.kind === "scene_enter") {
      only(rawTrigger, ["kind"], "source fact transition scene_enter trigger");
      trigger = { kind: "scene_enter" };
    } else if (rawTrigger.kind === "clue_found") {
      only(rawTrigger, ["kind", "clueCandidateId"], "source fact transition clue_found trigger");
      if (typeof rawTrigger.clueCandidateId !== "string" || !domains.clue.includes(rawTrigger.clueCandidateId)) {
        throw new CompilerQuestionError("unknown_hint_reference", "source fact transition prerequisite must be a same-heading canonical clue");
      }
      if (rawTrigger.clueCandidateId === declaration.discoverClueCandidateId) throw new CompilerQuestionError("invalid_source_fact_mechanic", "source fact transition prerequisite cannot equal its output clue");
      trigger = { kind: "clue_found", clueId: rawTrigger.clueCandidateId };
    } else {
      throw new CompilerQuestionError("invalid_hint_value", "source fact transition trigger must be scene_enter or clue_found");
    }
    const slot = `scene_state_transition:${trigger.kind}:${trigger.kind === "clue_found" ? trigger.clueId : ""}:${declaration.discoverClueCandidateId}`;
    if (transitionSlots.has(slot)) throw new CompilerQuestionError("duplicate_declaration", "source fact transition duplicates an occupied trigger slot");
    const mechanismId = deriveSourceFactMechanicId(graph, question.id, declarationKey, "scene_state_transition");
    const stateKey = deriveSourceFactMechanicStateKey(graph, question.id, declarationKey, "scene_state_transition");
    let spec: StateTransitionSpec;
    try {
      const parsed = parseMechanicsCandidateSpec({
        kind: "state_transition",
        id: mechanismId,
        when: {
          kind: "all",
          predicates: [
            { kind: "current_scene", sceneId: question.owningSceneCandidateId! },
            ...(trigger.kind === "clue_found" ? [{ kind: "clue_found" as const, clueId: trigger.clueId }] : []),
            { kind: "not", predicate: { kind: "clue_found", clueId: declaration.discoverClueCandidateId } },
            { kind: "not", predicate: { kind: "state_eq", stateKey, value: true } },
          ],
        },
        effects: [
          { kind: "discover_clue", clueId: declaration.discoverClueCandidateId },
          { kind: "set_state", stateKey, value: true },
        ],
      });
      if (parsed.kind !== "state_transition") throw new Error("unreachable source fact transition parser");
      spec = parsed;
    } catch (error) {
      throw new CompilerQuestionError("invalid_source_fact_mechanic", error instanceof Error ? error.message : "invalid source fact transition");
    }
    const parsed: ParsedSceneStateTransitionSourceFactMechanicDeclaration = {
      kind: "scene_state_transition", declarationKey, mechanismId, stateKey, trigger, discoverClueId: declaration.discoverClueCandidateId, spec, evidence: [],
    };
    parsed.evidence = sourceFactMechanicEvidence(root, parsed, declaration.evidence);
    transitionSlots.add(slot);
    return parsed;
  });
  return { kind: "source_fact_mechanic", parentQuestionId: question.sourceFactParentQuestionId!, statementId: root.id, declarations };
}

function clueFactFacetAtoms(graph: SourceFactGraph, question: CompilerQuestion): DraftClueFactAtom[] {
  if (question.kind !== "clue_fact_facets" || !question.subjectCandidateId || !question.allowedClueFactAtoms
    || question.subjectStatementId !== undefined || question.allowedCandidateIds !== undefined
    || question.allowedLocationCandidateIds !== undefined || question.allowedMechanicsTargetIds !== undefined
    || question.allowedItemNameEvidenceStatementIds !== undefined || question.allowedRewardPredicateIds !== undefined
    || question.allowedDispositions !== undefined || question.sourceFactChildQuestionId !== undefined
    || question.sourceFactParentQuestionId !== undefined || !question.owningSceneCandidateId || !question.owningHeadingStatementId) {
    throw new CompilerQuestionError("invalid_question", "clue fact facet question lacks its closed clue, atom, and heading domains");
  }
  const body = question.sourceStatementIds
    .map((id) => graph.statements.find((statement) => statement.id === id))
    .find((statement): statement is SourceStatement => statement?.kind === "marked_item_body");
  const marked = body && graph.statements.find((statement) => statement.id === body.parentStatementId);
  const heading = graph.statements.find((statement) => statement.id === question.owningHeadingStatementId);
  if (!body || !marked || marked.kind !== "marked_item" || !heading || heading.kind !== "heading"
    || marked.parentStatementId !== heading.id
    || !graph.relations.some((relation) => relation.kind === "marked_item_body" && relation.from === marked.id && relation.to === body.id)
    || !graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === marked.id)
    || question.subjectCandidateId !== canonicalDraftId(graph, marked.evidence, "clue")
    || question.owningSceneCandidateId !== canonicalDraftId(graph, heading.evidence, "scene")) {
    throw new CompilerQuestionError("invalid_question", "clue fact facet question escapes its canonical marked clue heading scope");
  }
  const atoms = question.allowedClueFactAtoms;
  // An empty atom domain is not an empty partition. It is the explicit
  // fail-closed representation of a marked body whose exact source spans
  // cannot be independently reconstructed (for example an unclosed source
  // bracket or a page-spanning atom). Recompute that fact from the graph so
  // a forged empty domain cannot erase an otherwise reviewable body.
  if (atoms.length === 0) {
    if (deriveClueFactAtoms(graph, question.subjectCandidateId, body).length !== 0) {
      throw new CompilerQuestionError("invalid_question", "empty clue fact atom domain must be source-unpartitionable");
    }
    return [];
  }
  if (new Set(atoms.map((atom) => atom.id)).size !== atoms.length) throw new CompilerQuestionError("invalid_question", "clue fact facet atoms must be unique");
  if (atoms.map((atom) => atom.id).join("|") !== sourceOrderedClueFactAtoms(atoms).map((atom) => atom.id).join("|")) {
    throw new CompilerQuestionError("invalid_question", "clue fact facet atoms must retain source-span order");
  }
  for (const atom of atoms) {
    if (atom.status !== "candidate" || atom.clueCandidateId !== question.subjectCandidateId || atom.bodyStatementId !== body.id
      || atom.evidence.spans.length !== 1 || !atom.quote.trim() || atom.quote !== atom.quote.trim()) {
      throw new CompilerQuestionError("invalid_question", "clue fact facet atom has invalid structural identity");
    }
    try { validateEvidenceRef(atom.evidence, graph.documentIdentity); }
    catch { throw new CompilerQuestionError("invalid_question", "clue fact facet atom evidence is invalid"); }
    const span = atom.evidence.spans[0]!;
    const pageBodyPieces = body.evidence.spans.filter((candidate) => candidate.pageNumber === span.pageNumber);
    const pageBodyStart = Math.min(...pageBodyPieces.map((candidate) => candidate.rawStart));
    const pageBodyEnd = Math.max(...pageBodyPieces.map((candidate) => candidate.rawEnd));
    const page = graph.documentIdentity.pages.find((candidate) => candidate.pageNumber === span.pageNumber);
    // `marked_item_body` is currently a single envelope (it may itself be
    // tokenized). An atom is a smaller span inside that envelope, so checking
    // for whole body token spans *inside* the atom would accept only a full
    // body fallback. Verify the atom's own raw bytes instead.
    if (!pageBodyPieces.length || !page || span.rawStart < pageBodyStart || span.rawEnd > pageBodyEnd
      || page.rawText.slice(span.rawStart, span.rawEnd) !== atom.quote) {
      throw new CompilerQuestionError("invalid_question", "clue fact facet atom is not an exact bounded body quote");
    }
  }
  const sourceOrdered = sourceOrderedClueFactAtoms(atoms);
  for (let index = 1; index < sourceOrdered.length; index++) {
    const previous = sourceOrdered[index - 1]!.evidence.spans[0]!;
    const current = sourceOrdered[index]!.evidence.spans[0]!;
    if (previous.pageNumber === current.pageNumber && previous.rawEnd > current.rawStart) {
      throw new CompilerQuestionError("invalid_question", "clue fact facet atoms must not overlap");
    }
  }
  if (sourceOrdered.map((atom) => atom.quote).join("").replace(/\s/g, "") !== body.text.replace(/\s/g, "")) {
    throw new CompilerQuestionError("invalid_question", "clue fact facet atoms must reconstruct the marked body exactly");
  }
  return atoms;
}

export function deriveClueFactFindingClueId(graph: SourceFactGraph, questionId: string, findingKey: string): string {
  return `clue_finding_${sha256(`${documentIdentity(graph)}|clue_fact_finding|${questionId}|${findingKey}`).slice(0, 24)}`;
}

export function deriveClueFactFindingMechanismId(graph: SourceFactGraph, questionId: string, findingKey: string, declarationKey: string): string {
  return `clue_finding_method_${sha256(`${documentIdentity(graph)}|clue_fact_method|${questionId}|${findingKey}|${declarationKey}`).slice(0, 24)}`;
}

function parseClueFactAtomQuotes(value: unknown, atoms: readonly DraftClueFactAtom[], label: string, allowEmpty = false): ParsedClueFactAtomQuote[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new CompilerQuestionError("invalid_hint_value", `${label} must ${allowEmpty ? "be an atom quote array" : "contain one or more atom quotes"}`);
  const domain = new Map(atoms.map((atom) => [atom.id, atom]));
  const selected = value.map((raw, index) => {
    const item = object(raw, `${label}[${index}]`);
    only(item, ["atomId", "quote"], `${label}[${index}]`);
    if (typeof item.atomId !== "string" || typeof item.quote !== "string") throw new CompilerQuestionError("invalid_hint_value", `${label} atom quote must contain strings`);
    const atom = domain.get(item.atomId);
    if (!atom || item.quote !== atom.quote) throw new CompilerQuestionError("invalid_clue_fact_quote", `${label} must exactly repeat one offered body atom quote`);
    return { atomId: item.atomId, quote: item.quote };
  });
  if (new Set(selected.map((atom) => atom.atomId)).size !== selected.length) throw new CompilerQuestionError("duplicate_declaration", `${label} repeats a body atom`);
  // The offered queue domain is itself ordered by source span.  Preserve that
  // order rather than hash-ID order so a multi-atom shell/finding is rendered
  // in the document's exact reading order even when callers submit IDs out of
  // order.
  const sourceOrder = new Map(atoms.map((atom, index) => [atom.id, index]));
  return selected.sort((left, right) => sourceOrder.get(left.atomId)! - sourceOrder.get(right.atomId)!);
}

function parseClueFactFacetValue(question: CompilerQuestion, value: Record<string, unknown>, graph: SourceFactGraph): Extract<ParsedCompilerHintValue, { kind: "clue_fact_facets" }> {
  only(value, ["shell", "findings", "sourceOnlyAtomIds"], "clue_fact_facets");
  const atoms = clueFactFacetAtoms(graph, question);
  if (!atoms.length) throw new CompilerQuestionError("unpartitionable_clue_body", "clue body has no independently verified source atom domain");
  const shellAtoms = parseClueFactAtomQuotes(value.shell, atoms, "clue_fact_facets.shell", true);
  if (!Array.isArray(value.sourceOnlyAtomIds) || value.sourceOnlyAtomIds.some((id) => typeof id !== "string")) {
    throw new CompilerQuestionError("invalid_hint_value", "clue_fact_facets.sourceOnlyAtomIds must be an atom ID array");
  }
  if (!Array.isArray(value.findings) || value.findings.length > 16) throw new CompilerQuestionError("invalid_hint_value", "clue_fact_facets.findings must contain at most 16 findings");
  const findingKeys = new Set<string>();
  const findings = value.findings.map((rawFinding, findingIndex) => {
    const finding = object(rawFinding, `clue_fact_facets.findings[${findingIndex}]`);
    only(finding, ["findingKey", "atoms", "methods"], `clue_fact_facets.findings[${findingIndex}]`);
    const findingKey = identifier(finding.findingKey, "clue fact findingKey");
    if (findingKeys.has(findingKey)) throw new CompilerQuestionError("duplicate_declaration", `duplicate clue fact findingKey: ${findingKey}`);
    findingKeys.add(findingKey);
    const selectedAtoms = parseClueFactAtomQuotes(finding.atoms, atoms, `clue_fact_facets.findings[${findingIndex}].atoms`);
    if (!Array.isArray(finding.methods) || finding.methods.length < 1 || finding.methods.length > 4) {
      throw new CompilerQuestionError("invalid_hint_value", "a clue fact finding requires one to four methods");
    }
    const clueId = deriveClueFactFindingClueId(graph, question.id, findingKey);
    const methodKeys = new Set<string>();
    const methodSlots = new Set<string>();
    const methods = finding.methods.map((rawMethod, methodIndex) => {
      const method = object(rawMethod, `clue_fact_facets.findings[${findingIndex}].methods[${methodIndex}]`);
      only(method, ["declarationKey", "action", "target", "check", "failback"], `clue_fact_facets.findings[${findingIndex}].methods[${methodIndex}]`);
      const declarationKey = identifier(method.declarationKey, "clue fact method declarationKey");
      if (methodKeys.has(declarationKey)) throw new CompilerQuestionError("duplicate_declaration", `duplicate clue fact method declarationKey: ${declarationKey}`);
      methodKeys.add(declarationKey);
      const supportedPair = (method.action === "observe" || method.action === "search")
        ? (method.target === "scene" || method.target === "clue")
        : method.action === "read" && method.target === "clue";
      // A compact facet method has no caller-selected item ID and is already
      // scoped to its heading scene.  use_item and move would therefore imply
      // an unbound item/movement target; reject them rather than inventing one.
      if (!supportedPair || method.check === undefined) {
        throw new CompilerQuestionError("invalid_hint_value", "clue fact finding method requires observe/search on scene|clue or read on clue, plus an explicit check");
      }
      let failback: { maxFailures: number } | undefined;
      if (method.failback !== undefined) {
        const rawFailback = object(method.failback, "clue fact finding failback");
        only(rawFailback, ["maxFailures"], "clue fact finding failback");
        if (!Number.isInteger(rawFailback.maxFailures) || (rawFailback.maxFailures as number) < 1 || (rawFailback.maxFailures as number) > 10) {
          throw new CompilerQuestionError("invalid_hint_value", "clue fact finding failback maxFailures must be an integer from 1 to 10");
        }
        failback = { maxFailures: rawFailback.maxFailures as number };
      }
      const mechanismId = deriveClueFactFindingMechanismId(graph, question.id, findingKey, declarationKey);
      const target = method.target as "scene" | "clue";
      let spec: DiscoveryMethodSpec;
      try {
        const parsed = parseMechanicsCandidateSpec({
          kind: "discovery_method", id: mechanismId, clueId,
          action: method.action,
          target,
          targetId: target === "scene" ? question.owningSceneCandidateId : question.subjectCandidateId,
          check: method.check,
          availability: { kind: "all", predicates: [
            { kind: "clue_found", clueId: question.subjectCandidateId },
            { kind: "not", predicate: { kind: "clue_found", clueId } },
          ] },
          onSuccess: [{ kind: "discover_clue", clueId }],
          ...(failback ? { failback: { maxFailures: failback.maxFailures, effects: [{ kind: "discover_clue", clueId }] } } : {}),
        });
        if (parsed.kind !== "discovery_method") throw new Error("unreachable clue fact finding parser");
        spec = parsed;
      } catch (error) {
        throw new CompilerQuestionError("invalid_clue_fact_method", error instanceof Error ? error.message : "invalid clue fact method");
      }
      const slot = `${method.action}:${target}:${JSON.stringify(spec.check)}:${failback?.maxFailures ?? "none"}`;
      if (methodSlots.has(slot)) throw new CompilerQuestionError("duplicate_declaration", "clue fact finding duplicates an occupied method slot");
      methodSlots.add(slot);
      return { declarationKey, mechanismId, action: method.action as ParsedClueFactFindingMethod["action"], target, check: spec.check!, ...(failback ? { failback } : {}), spec };
    });
    return { findingKey, clueId, atoms: selectedAtoms, methods };
  });
  const sourceOnlyAtomIds = [...value.sourceOnlyAtomIds].sort();
  if (new Set(sourceOnlyAtomIds).size !== sourceOnlyAtomIds.length || sourceOnlyAtomIds.some((id) => !atoms.some((atom) => atom.id === id))) {
    throw new CompilerQuestionError("invalid_clue_fact_partition", "source-only disposition must select unique offered body atoms");
  }
  const partition = [...shellAtoms.map((atom) => atom.atomId), ...findings.flatMap((finding) => finding.atoms.map((atom) => atom.atomId)), ...sourceOnlyAtomIds];
  if (new Set(partition).size !== partition.length || partition.length !== atoms.length || partition.sort().join("|") !== atoms.map((atom) => atom.id).sort().join("|")) {
    throw new CompilerQuestionError("incomplete_clue_fact_partition", "clue fact partition must dispose every body atom exactly once");
  }
  return { kind: "clue_fact_facets", clueId: question.subjectCandidateId!, shellAtoms, findings, sourceOnlyAtomIds };
}

/** Parse hint syntax before the shared source-bound SAN declaration check. */
function parseCompilerHintValueUnchecked(question: CompilerQuestion, value: unknown, graph?: SourceFactGraph): ParsedCompilerHintValue {
  const input = object(value, question.kind);
  switch (question.kind) {
    case "scene_role": {
      only(input, ["role"], "scene_role");
      if (!( ["playable_scene", "rules_section", "character_section", "ending_section", "other"] as string[]).includes(input.role as string)) throw new CompilerQuestionError("invalid_hint_value", "invalid scene role");
      return { kind: "scene_role", role: input.role as SceneRole };
    }
    case "entry_scene":
      only(input, ["sceneCandidateId"], "entry_scene");
      return { kind: "entry_scene", sceneId: candidate(question, input.sceneCandidateId, "entry scene") };
    case "core_clue": {
      only(input, ["clueCandidateId", "required"], "core_clue");
      if (typeof input.required !== "boolean") throw new CompilerQuestionError("invalid_hint_value", "core clue required must be boolean");
      if (input.clueCandidateId !== question.subjectCandidateId) throw new CompilerQuestionError("unknown_hint_reference", "unknown reference: core clue must match question subject");
      return { kind: "core_clue", clueId: candidate(question, input.clueCandidateId, "core clue", [question.subjectCandidateId!]), required: input.required };
    }
    case "connection_topology": {
      only(input, ["connections"], "connection_topology");
      if (!Array.isArray(input.connections)) throw new CompilerQuestionError("invalid_hint_value", "connections must be an array");
      if (!question.subjectCandidateId) throw new CompilerQuestionError("invalid_question", "topology question lacks source scene subject");
      const declared = new Set<string>();
      return {
        kind: "connection_topology",
        connections: input.connections.map((entry, index) => {
          const connection = object(entry, `connections[${index}]`);
          only(connection, ["toSceneCandidateId", "connectionId", "availability", "onTraverse", "actorEffectProvenance"], `connections[${index}]`);
          const connectionId = identifier(connection.connectionId, "connectionId");
          if (declared.has(connectionId)) throw new CompilerQuestionError("duplicate_declaration", `duplicate connection declaration: ${connectionId}`);
          declared.add(connectionId);
          const spec = parseMechanicsCandidateSpec({ kind: "connection_gate", id: `hint_connection_${connectionId}`, connectionId, ...(connection.availability === undefined ? {} : { availability: connection.availability }), ...(connection.onTraverse === undefined ? {} : { onTraverse: connection.onTraverse }), ...(connection.actorEffectProvenance === undefined ? {} : { actorEffectProvenance: connection.actorEffectProvenance }) });
          if (spec.kind !== "connection_gate") throw new CompilerQuestionError("invalid_hint_value", "invalid connection hint");
          return { fromSceneId: question.subjectCandidateId!, toSceneId: candidate(question, connection.toSceneCandidateId, "connection target"), connectionId, spec };
        }),
      };
    }
    case "ending_rule": {
      only(input, ["declarations"], "ending_rule");
      if (!Array.isArray(input.declarations) || input.declarations.length === 0) throw new CompilerQuestionError("invalid_hint_value", "ending declarations must be non-empty");
      const endingIds = new Set<string>();
      return {
        kind: "ending_rule",
        declarations: input.declarations.map((entry, index) => {
          const declaration = object(entry, `declarations[${index}]`);
          only(declaration, ["endingId", "spec"], `declarations[${index}]`);
          const endingId = identifier(declaration.endingId, "endingId");
          if (endingIds.has(endingId)) throw new CompilerQuestionError("duplicate_declaration", `duplicate ending declaration: ${endingId}`);
           endingIds.add(endingId);
           const spec = parseMechanicsCandidateSpec(declaration.spec);
           if (spec.kind !== "ending_rule") throw new CompilerQuestionError("invalid_hint_value", "ending hint requires EndingRuleSpec");
           if (spec.id === endingId) throw new CompilerQuestionError("invalid_declaration", "ending rule mechanism ID must differ from endingId");
           const endGames = spec.effects.filter((effect) => effect.kind === "end_game");
          if (endGames.length !== 1 || endGames[0]!.endingId !== endingId) throw new CompilerQuestionError("invalid_declaration", "ending declaration must match exactly one end_game effect");
          return { endingId, spec };
        }),
      };
    }
    case "discovery_method": {
      only(input, ["clueCandidateId", "locationSceneCandidateId", "spec", "actorEffectProvenance"], "discovery_method");
      if (!question.subjectCandidateId) throw new CompilerQuestionError("invalid_question", "discovery question has no clue subject");
      if (!question.allowedLocationCandidateIds?.length || !question.allowedMechanicsTargetIds) throw new CompilerQuestionError("invalid_question", "discovery question has no candidate domains");
      const clueId = candidate(question, input.clueCandidateId, "discovery clue", [question.subjectCandidateId]);
      const locationSceneId = candidate(question, input.locationSceneCandidateId, "discovery location", question.allowedLocationCandidateIds);
      const rawSpec = object(input.spec, "discovery_method.spec");
      const spec = parseMechanicsCandidateSpec({ ...rawSpec, ...(input.actorEffectProvenance === undefined ? {} : { actorEffectProvenance: input.actorEffectProvenance }) });
      if (spec.kind !== "discovery_method") throw new CompilerQuestionError("invalid_hint_value", "discovery hint requires DiscoveryMethodSpec");
      if (spec.clueId !== clueId) throw new CompilerQuestionError("unknown_hint_reference", "discovery spec must bind the question clue");
      const targetIds = question.allowedMechanicsTargetIds[spec.target];
      if (!targetIds?.includes(spec.targetId)) throw new CompilerQuestionError("unknown_hint_reference", "discovery target is outside its semantic domain");
      return { kind: "discovery_method", clueId, locationSceneId, spec };
    }
    case "clue_fact_facets":
      if (!graph) throw new CompilerQuestionError("source_graph_required", "clue fact facets require SourceFactGraph for exact atom validation");
      return parseClueFactFacetValue(question, input, graph);
    case "source_fact_disposition": {
      only(input, ["statementId", "disposition"], "source_fact_disposition");
      if (!question.subjectStatementId || question.sourceStatementIds.length !== 1 || question.sourceStatementIds[0] !== question.subjectStatementId || !question.allowedDispositions?.length) {
        throw new CompilerQuestionError("invalid_question", "source fact disposition question lacks one canonical statement subject");
      }
      if (input.statementId !== question.subjectStatementId) throw new CompilerQuestionError("unknown_hint_reference", "source fact disposition statement must match question subject");
      if (input.disposition !== "source_only" && input.disposition !== "mechanics_candidate") {
        throw new CompilerQuestionError("invalid_hint_value", "source fact disposition must be source_only or mechanics_candidate");
      }
      if (!question.allowedDispositions.includes(input.disposition)) throw new CompilerQuestionError("unknown_hint_reference", "source fact disposition is not allowed by this prepared parent domain");
      return { kind: "source_fact_disposition", statementId: input.statementId, disposition: input.disposition };
    }
    case "source_fact_mechanic":
      if (!graph) throw new CompilerQuestionError("source_graph_required", "source fact mechanics require SourceFactGraph for exact evidence validation");
      return parseSourceFactMechanicValue(question, input, graph);
    case "npc_binding": {
      only(input, ["proseAnchorId", "presentNpcs"], "npc_binding");
      if (!question.subjectCandidateId || !question.allowedCandidateIds?.length) throw new CompilerQuestionError("invalid_question", "npc binding question has no anchor domain");
      const proseAnchorId = candidate(question, input.proseAnchorId, "prose NPC anchor", [question.subjectCandidateId]);
      if (!Array.isArray(input.presentNpcs) || input.presentNpcs.length > 32) throw new CompilerQuestionError("invalid_hint_value", "presentNpcs must be an array of at most 32 entries");
      if (!graph) throw new CompilerQuestionError("source_graph_required", "npc binding requires SourceFactGraph for quote validation");
      const { paragraph } = npcBindingAnchorStatement(graph, question);
      const document = documentIdentity(graph);
      const ids = new Set<string>();
      const mechanismIds = new Set<string>();
      const proseDialogueClueIds = new Set<string>();
      const dialogueClues = new Map(npcDialogueClueCandidates(graph, question).map((clue) => [clue.id, clue]));
      const presentNpcs = input.presentNpcs.map((entry, index) => {
        const npc = object(entry, `presentNpcs[${index}]`);
        only(npc, ["nameQuote", "dialogueMethods", "encounter"], `presentNpcs[${index}]`);
        if (typeof npc.nameQuote !== "string" || npc.nameQuote !== npc.nameQuote.trim() || npc.nameQuote.length < 2 || npc.nameQuote.length > 120 || npc.nameQuote === paragraph.text || !paragraph.text.includes(npc.nameQuote)) {
          throw new CompilerQuestionError("invalid_name_quote", "NPC nameQuote must be a trimmed 2-120 character bounded verbatim substring of the anchor paragraph");
        }
        const npcId = `npc_${sha256(`${document}|prose_npc|${proseAnchorId}|${npc.nameQuote}`).slice(0, 24)}`;
        if (ids.has(npcId)) throw new CompilerQuestionError("duplicate_declaration", `duplicate deterministic NPC ID: ${npcId}`);
        ids.add(npcId);
        const dialogueMethodsDeclared = Object.hasOwn(npc, "dialogueMethods");
        if (dialogueMethodsDeclared && (!Array.isArray(npc.dialogueMethods) || npc.dialogueMethods.length > 32)) {
          throw new CompilerQuestionError("invalid_hint_value", "dialogueMethods must be an array of at most 32 entries");
        }
        const dialogueMethods = dialogueMethodsDeclared ? (npc.dialogueMethods as unknown[]).map((value, methodIndex) => {
          const method = object(value, `presentNpcs[${index}].dialogueMethods[${methodIndex}]`);
          const label = `presentNpcs[${index}].dialogueMethods[${methodIndex}]`;
          const prose = Object.hasOwn(method, "relationshipEvidence");
          if (prose && (method.onFailure !== undefined || method.failback !== undefined)) {
            throw new CompilerQuestionError("invalid_hint_value", "prose dialogue cannot declare failure effects or failback; a failed relationship talk has no side effects");
          }
          only(method,
            prose
              ? ["mechanismId", "relationshipEvidence", "check", "availability"]
              : ["mechanismId", "clueCandidateId", "check", "availability", "onSuccess", "onFailure", "failback", "actorEffectProvenance"],
            label,
          );
          if (prose) {
            const evidence = object(method.relationshipEvidence, "dialogue relationshipEvidence");
            only(evidence, ["statementId", "quote"], "dialogue relationshipEvidence");
            const statementId = identifier(evidence.statementId, "dialogue relationship evidence statementId");
            if (statementId !== paragraph.id) {
              throw new CompilerQuestionError("unknown_hint_reference", "prose dialogue relationship evidence must be the NPC anchor paragraph");
            }
            if (typeof evidence.quote !== "string" || evidence.quote !== evidence.quote.trim() || evidence.quote.length < 2 || evidence.quote.length > 240
              || evidence.quote === npc.nameQuote || !paragraph.text.includes(evidence.quote)) {
              throw new CompilerQuestionError("invalid_relationship_quote", "prose dialogue relationship quote must be a trimmed 2-240 character source-exact anchor-paragraph substring distinct from the NPC name");
            }
            const relationshipEvidence = { statementId, quote: evidence.quote };
            const clueId = deriveNpcProseDialogueClueId(graph, proseAnchorId, npcId, relationshipEvidence);
            if (proseDialogueClueIds.has(clueId)) throw new CompilerQuestionError("duplicate_declaration", `duplicate prose dialogue clue declaration: ${clueId}`);
            proseDialogueClueIds.add(clueId);
            const mechanismId = method.mechanismId === undefined
              ? deriveNpcProseDialogueMechanismId(graph, proseAnchorId, npcId, relationshipEvidence)
              : identifier(method.mechanismId, "dialogue mechanismId");
            if (mechanismIds.has(mechanismId)) throw new CompilerQuestionError("duplicate_declaration", `duplicate dialogue mechanismId: ${mechanismId}`);
            mechanismIds.add(mechanismId);
            const spec = parseMechanicsCandidateSpec({
              kind: "discovery_method",
              id: mechanismId,
              clueId,
              action: "talk",
              target: "npc",
              targetId: npcId,
              ...(method.availability === undefined ? {} : { availability: method.availability }),
              ...(method.check === undefined ? {} : { check: method.check }),
              onSuccess: [{ kind: "discover_clue", clueId }],
            });
            if (spec.kind !== "discovery_method" || spec.action !== "talk" || spec.target !== "npc" || spec.targetId !== npcId || spec.id !== mechanismId || spec.clueId !== clueId
              || spec.onSuccess.length !== 1 || spec.onSuccess[0]?.kind !== "discover_clue" || spec.onSuccess[0].clueId !== clueId) {
              throw new CompilerQuestionError("invalid_hint_value", "prose dialogue method could not be derived as an exact talk/npc discovery");
            }
            return { kind: "prose" as const, mechanismId, clueId, relationshipEvidence, spec };
          }
          const mechanismId = identifier(method.mechanismId, "dialogue mechanismId");
          if (mechanismIds.has(mechanismId)) throw new CompilerQuestionError("duplicate_declaration", `duplicate dialogue mechanismId: ${mechanismId}`);
          mechanismIds.add(mechanismId);
          if (typeof method.clueCandidateId !== "string" || !dialogueClues.has(method.clueCandidateId)) {
            throw new CompilerQuestionError("unknown_hint_reference", "dialogue clue must be a canonical candidate under the NPC heading");
          }
          const clueId = method.clueCandidateId;
          const spec = parseMechanicsCandidateSpec({
            kind: "discovery_method",
            id: mechanismId,
            clueId,
            action: "talk",
            target: "npc",
            targetId: npcId,
            ...(method.availability === undefined ? {} : { availability: method.availability }),
            ...(method.check === undefined ? {} : { check: method.check }),
            onSuccess: method.onSuccess,
            ...(method.onFailure === undefined ? {} : { onFailure: method.onFailure }),
            ...(method.failback === undefined ? {} : { failback: method.failback }),
            ...(method.actorEffectProvenance === undefined ? {} : { actorEffectProvenance: method.actorEffectProvenance }),
          });
          if (spec.kind !== "discovery_method" || spec.action !== "talk" || spec.target !== "npc" || spec.targetId !== npcId || spec.id !== mechanismId || spec.clueId !== clueId) {
            throw new CompilerQuestionError("invalid_hint_value", "dialogue method could not be derived as a talk/npc discovery");
          }
          const discovers = spec.onSuccess.filter((effect) => effect.kind === "discover_clue");
          if (discovers.length !== 1 || discovers[0]!.clueId !== clueId) {
            throw new CompilerQuestionError("invalid_declaration", "dialogue onSuccess must discover exactly its selected clue");
          }
          return { kind: "marked_item" as const, mechanismId, clueId, spec };
        }) : [];
        const encounter = npc.encounter === undefined
          ? undefined
          : parseNpcEncounterBinding(graph, question, proseAnchorId, npcId, npc.nameQuote, canonicalDraftId(graph, npcBindingHeading(graph, question).evidence, "scene"), npc.encounter);
        return { nameQuote: npc.nameQuote, npcId, dialogueMethodsDeclared, dialogueMethods, ...(encounter ? { encounter } : {}) };
      });
      return { kind: "npc_binding", proseAnchorId, presentNpcs };
    }
    case "item_binding": {
      only(input, ["itemCandidateId", "itemType", "itemNameEvidence"], "item_binding");
      if (!question.subjectCandidateId || !question.allowedCandidateIds?.length) throw new CompilerQuestionError("invalid_question", "item binding question has no item candidate domain");
      const itemCandidateId = candidate(question, input.itemCandidateId, "item candidate", [question.subjectCandidateId]);
      if (input.itemCandidateId !== question.subjectCandidateId) throw new CompilerQuestionError("unknown_hint_reference", "item binding must match question subject");
      if (input.itemType === null) {
        if (Object.hasOwn(input, "itemNameEvidence")) throw new CompilerQuestionError("invalid_hint_value", "source-only item binding must not declare itemNameEvidence");
        return { kind: "item_binding", itemCandidateId, itemType: null };
      }
      if (input.itemType === "key" || input.itemType === "document" || input.itemType === "loot") {
        if (!graph) throw new CompilerQuestionError("source_graph_required", "positive item binding requires SourceFactGraph for itemNameEvidence validation");
        const evidence = object(input.itemNameEvidence, "itemNameEvidence");
        only(evidence, ["statementId", "quote"], "itemNameEvidence");
        const { name, body } = itemNameEvidenceStatements(graph, question);
        const statementId = identifier(evidence.statementId, "item name evidence statementId");
        if (statementId !== name.id && statementId !== body.id) throw new CompilerQuestionError("unknown_hint_reference", "item name evidence must be one of the candidate-local marked item children");
        const source = statementId === name.id ? name : body;
        if (typeof evidence.quote !== "string" || evidence.quote !== evidence.quote.trim() || evidence.quote.length < 2 || evidence.quote.length > 120 || !source.text.includes(evidence.quote)) {
          throw new CompilerQuestionError("invalid_name_quote", "item name evidence quote must be a trimmed 2-120 character source-exact substring");
        }
        return { kind: "item_binding", itemCandidateId, itemType: input.itemType, itemNameEvidence: { statementId, quote: evidence.quote } };
      }
      throw new CompilerQuestionError("invalid_hint_value", "item binding type must be key, document, loot with itemNameEvidence, or null for source-only evidence");
    }
    case "reward_binding": {
      only(input, ["rewardCandidateId", "declaration"], "reward_binding");
      if (!question.subjectCandidateId || !question.allowedCandidateIds?.length) throw new CompilerQuestionError("invalid_question", "reward binding question has no candidate domain");
      const rewardCandidateId = candidate(question, input.rewardCandidateId, "reward candidate", [question.subjectCandidateId]);
      if (input.rewardCandidateId !== question.subjectCandidateId) throw new CompilerQuestionError("unknown_hint_reference", "reward binding must match question subject");
      if (input.declaration === null) return { kind: "reward_binding", rewardCandidateId, declaration: null };
      if (!question.allowedRewardPredicateIds) throw new CompilerQuestionError("invalid_question", "reward binding question has no predicate target domains");
      const declaration = object(input.declaration, "reward_binding.declaration");
      only(declaration, ["when", "settlement"], "reward_binding.declaration");
      const parsed = parseMechanicsCandidateSpec({ kind: "reward_definition", id: rewardCandidateId, when: declaration.when, settlement: declaration.settlement });
      if (parsed.kind !== "reward_definition") throw new CompilerQuestionError("invalid_hint_value", "reward binding requires a reward definition");
      validateRewardPredicateReferences(parsed.when, question.allowedRewardPredicateIds);
      return { kind: "reward_binding", rewardCandidateId, declaration: { when: parsed.when, settlement: parsed.settlement } };
    }
    case "check_spec":
    case "state_key":
      throw new CompilerQuestionError("unsupported_hint_kind", `unsupported_hint_kind: ${question.kind}`);
  }
}

/**
 * Source text is not an executable mechanics language.  This deliberately
 * recognizes only labelled, slash-paired SAN declarations so it can bind an
 * already-parsed MechanicsIR effect to the exact pair the source stated.
 */
const SOURCE_SANITY_DECLARATION = /(?:\bSAN\b|理智)(?:\s*(?:loss|损失|鉴定)\s*)?(?:[（(]\s*((?:\d+\s*[dD]\s*\d+|\d+))\s*\/\s*((?:\d+\s*[dD]\s*\d+|\d+))\s*[）)]|[\s：:]*((?:\d+\s*[dD]\s*\d+|\d+))\s*\/\s*((?:\d+\s*[dD]\s*\d+|\d+)))(?![\p{L}\p{N}_])(?:\s+(?:twice\b|两次))?/giu;

function sourceSanityLossValue(text: string): unknown | undefined {
  const compact = text.replace(/\s+/g, "");
  const dice = /^(\d+)[dD](\d+)$/.exec(compact);
  if (dice) return { kind: "dice", count: Number(dice[1]), sides: Number(dice[2]) };
  if (/^\d+$/.test(compact)) return { kind: "fixed", amount: Number(compact) };
  return undefined;
}

function sanityCheckKey(effect: SanityCheckEffect): string {
  const lossKey = (loss: SanityCheckEffect["passLoss"]): string => loss.kind === "fixed" ? `fixed:${loss.amount}` : `dice:${loss.count}d${loss.sides}`;
  return `${lossKey(effect.passLoss)}/${lossKey(effect.failLoss)}`;
}

/**
 * The MechanicsIR parser remains the sole bounds authority: source matching
 * only tokenizes a labelled pair, then asks that parser to normalize it.
 */
function sourceSanityDeclarationKey(passText: string, failText: string): string | undefined {
  const passLoss = sourceSanityLossValue(passText);
  const failLoss = sourceSanityLossValue(failText);
  if (!passLoss || !failLoss) return undefined;
  try {
    const parsed = parseMechanicsCandidateSpec({
      kind: "connection_gate",
      id: "source_sanity_declaration",
      connectionId: "source_sanity_declaration",
      onTraverse: [{ kind: "sanity_check", passLoss, failLoss }],
    });
    const effect = parsed.kind === "connection_gate" ? parsed.onTraverse?.[0] : undefined;
    return effect?.kind === "sanity_check" ? sanityCheckKey(effect) : undefined;
  } catch {
    return undefined;
  }
}

function parsedSanityChecks(value: unknown): SanityCheckEffect[] {
  if (Array.isArray(value)) return value.flatMap(parsedSanityChecks);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.kind === "sanity_check") return [record as SanityCheckEffect];
  return Object.values(record).flatMap(parsedSanityChecks);
}

interface ParsedSanityEffectSlot {
  effect: SanityCheckEffect;
  effectPath: string;
  eventSlot: ActorEffectProvenance["eventSlot"];
  binding: ActorEffectProvenance | undefined;
}

function sanitySlotsForDiscovery(spec: DiscoveryMethodSpec): ParsedSanityEffectSlot[] {
  const branches: Array<{ outcome: "success" | "failure" | "failback"; path: "onSuccess" | "onFailure" | "failback.effects"; effects: readonly Effect[] }> = [
    { outcome: "success", path: "onSuccess", effects: spec.onSuccess },
    { outcome: "failure", path: "onFailure", effects: spec.onFailure ?? [] },
    { outcome: "failback", path: "failback.effects", effects: spec.failback?.effects ?? [] },
  ];
  return branches.flatMap((branch) => branch.effects.flatMap((effect, effectIndex) => effect.kind === "sanity_check"
    ? [{ effect, effectPath: `${branch.path}[${effectIndex}]`, eventSlot: { kind: "discovery" as const, mechanismId: spec.id, outcome: branch.outcome, effectIndex }, binding: spec.actorEffectProvenance?.find((candidate) => candidate.effectPath === `${branch.path}[${effectIndex}]` && candidate.eventSlot.kind === "discovery" && candidate.eventSlot.outcome === branch.outcome && candidate.eventSlot.effectIndex === effectIndex) }]
    : []));
}

function sanitySlotsForConnection(connectionId: string, spec: ConnectionGateSpec): ParsedSanityEffectSlot[] {
  return (spec.onTraverse ?? []).flatMap((effect, effectIndex) => effect.kind === "sanity_check"
    ? [{ effect, effectPath: `onTraverse[${effectIndex}]`, eventSlot: { kind: "connection" as const, connectionId, outcome: "traverse" as const, effectIndex }, binding: spec.actorEffectProvenance?.find((candidate) => candidate.effectPath === `onTraverse[${effectIndex}]` && candidate.eventSlot.kind === "connection" && candidate.eventSlot.outcome === "traverse" && candidate.eventSlot.effectIndex === effectIndex) }]
    : []);
}

function parsedSanityEffectSlots(parsed: ParsedCompilerHintValue): ParsedSanityEffectSlot[] {
  switch (parsed.kind) {
    case "connection_topology": return parsed.connections.flatMap((connection) => sanitySlotsForConnection(connection.connectionId, connection.spec));
    case "discovery_method": return sanitySlotsForDiscovery(parsed.spec);
    case "npc_binding": return parsed.presentNpcs.flatMap((npc) => npc.dialogueMethods.flatMap((method) => sanitySlotsForDiscovery(method.spec)));
    default: return [];
  }
}

function parsedActorEffectProvenance(parsed: ParsedCompilerHintValue): ActorEffectProvenance[] {
  switch (parsed.kind) {
    case "connection_topology": return parsed.connections.flatMap((connection) => connection.spec.actorEffectProvenance ?? []);
    case "discovery_method": return parsed.spec.actorEffectProvenance ?? [];
    case "npc_binding": return parsed.presentNpcs.flatMap((npc) => npc.dialogueMethods.flatMap((method) => method.spec.actorEffectProvenance ?? []));
    default: return [];
  }
}

function checkedDiscoveryMechanismIds(parsed: ParsedCompilerHintValue): Set<string> {
  const specs = parsed.kind === "discovery_method"
    ? [parsed.spec]
    : parsed.kind === "npc_binding"
      ? parsed.presentNpcs.flatMap((npc) => npc.dialogueMethods.map((method) => method.spec))
      : [];
  return new Set(specs.filter((spec) => spec.check !== undefined && spec.check.kind !== "none").map((spec) => spec.id));
}

function actorEffectBindingNamesSlot(binding: ActorEffectProvenance, slot: ParsedSanityEffectSlot): boolean {
  if (binding.effectPath !== slot.effectPath || binding.eventSlot.kind !== slot.eventSlot.kind
    || binding.eventSlot.outcome !== slot.eventSlot.outcome || binding.eventSlot.effectIndex !== slot.eventSlot.effectIndex) return false;
  return binding.eventSlot.kind === "connection"
    ? slot.eventSlot.kind === "connection" && binding.eventSlot.connectionId === slot.eventSlot.connectionId
    : slot.eventSlot.kind === "discovery" && binding.eventSlot.mechanismId === slot.eventSlot.mechanismId;
}

function validateExactActorEffectProvenance(parsed: ParsedCompilerHintValue, slots: readonly ParsedSanityEffectSlot[]): void {
  const bindings = parsedActorEffectProvenance(parsed);
  if (slots.length === 0) {
    if (bindings.length > 0) throw new CompilerQuestionError("invalid_actor_effect_provenance", "actor-effect provenance is allowed only for a SAN effect slot");
    if (parsedSanityChecks(parsed).length > 0) throw new CompilerQuestionError("missing_actor_effect_provenance", "SAN checks require an actor-effect event-slot binding");
    return;
  }
  if (bindings.length !== slots.length) throw new CompilerQuestionError("invalid_actor_effect_provenance", "every SAN effect slot requires exactly one actor-effect provenance binding");
  const bound = new Set<ParsedSanityEffectSlot>();
  for (const binding of bindings) {
    const matchingSlots = slots.filter((slot) => actorEffectBindingNamesSlot(binding, slot));
    if (matchingSlots.length !== 1 || bound.has(matchingSlots[0]!)) {
      throw new CompilerQuestionError("invalid_actor_effect_provenance", "actor-effect provenance must name one exact SAN event slot");
    }
    bound.add(matchingSlots[0]!);
  }
}

function sourceSanityRepeat(text: string): boolean { return /(?:\s+twice\b|\s+\u4e24\u6b21)/iu.test(text); }

interface SourceSanityDeclarationReference {
  identity: string;
  sanityKey: string;
  capacity: number;
}

function sourceSanityDeclarationReference(statement: SourceStatement, quote: string): SourceSanityDeclarationReference | undefined {
  const quoteStart = statement.text.indexOf(quote);
  const quotedDeclarations = [...quote.matchAll(SOURCE_SANITY_DECLARATION)];
  const quotedDeclaration = quotedDeclarations.length === 1 ? quotedDeclarations[0]! : undefined;
  if (quoteStart < 0 || !quotedDeclaration || quotedDeclaration.index === undefined) return undefined;
  const declarationStart = quoteStart + quotedDeclaration.index;
  const canonicalDeclarations = [...statement.text.matchAll(SOURCE_SANITY_DECLARATION)]
    .filter((declaration) => declaration.index === declarationStart);
  const declaration = canonicalDeclarations.length === 1 ? canonicalDeclarations[0]! : undefined;
  if (!declaration || declaration.index === undefined || quoteStart + quote.length < declaration.index + declaration[0].length) return undefined;
  const sanityKey = sourceSanityDeclarationKey(declaration[1] ?? declaration[3]!, declaration[2] ?? declaration[4]!);
  if (!sanityKey) return undefined;
  const start = declaration.index;
  return { identity: `${statement.id}|${start}|${start + declaration[0].length}`, sanityKey, capacity: sourceSanityRepeat(declaration[0]) ? 2 : 1 };
}

function consumeSourceSanityDeclaration(consumed: Map<string, { capacity: number; used: number }>, declaration: SourceSanityDeclarationReference): void {
  const state = consumed.get(declaration.identity) ?? { capacity: declaration.capacity, used: 0 };
  if (state.capacity !== declaration.capacity || state.used >= state.capacity) {
    throw new CompilerQuestionError("source_declaration_mismatch", "source declaration mismatch: SAN source declaration was consumed by more event slots than it explicitly declares");
  }
  state.used += 1;
  consumed.set(declaration.identity, state);
}

function targetSceneName(graph: SourceFactGraph, candidateId: string): string {
  const headings = graph.statements.filter((statement) => statement.kind === "heading" && canonicalDraftId(graph, statement.evidence, "scene") === candidateId);
  if (headings.length !== 1 || !headings[0]!.text.trim()) throw new CompilerQuestionError("invalid_question", "SAN multi-edge target does not resolve to one source heading");
  return headings[0]!.text.trim();
}

function quoteNamesExactlyOneConnectionTarget(connectionTargetNames: ReadonlyMap<string, string>, connectionId: string, quote: string): boolean {
  const matchingSlots = [...connectionTargetNames].filter(([, targetName]) => quote.includes(targetName));
  return matchingSlots.length === 1 && matchingSlots[0]![0] === connectionId;
}

type DiscoveryBranchOutcome = "success" | "failure" | "failback";
const DISCOVERY_BRANCH_MARKERS: Readonly<Record<DiscoveryBranchOutcome, RegExp>> = {
  success: /(?:\bsuccess\b|\u6210\u529f)/iu,
  failure: /(?:\bfailure\b|\u5931\u8d25)/iu,
  failback: /(?:\bfailback\b|\u56de\u9000)/iu,
};

function uniqueDiscoveryBranchInQuote(quote: string): DiscoveryBranchOutcome | undefined {
  const outcomes = (Object.keys(DISCOVERY_BRANCH_MARKERS) as DiscoveryBranchOutcome[])
    .filter((outcome) => DISCOVERY_BRANCH_MARKERS[outcome].test(quote));
  return outcomes.length === 1 ? outcomes[0] : undefined;
}

function validateSanityCheckSourceDeclarations(question: CompilerQuestion, parsed: ParsedCompilerHintValue, graph?: SourceFactGraph): void {
  const slots = parsedSanityEffectSlots(parsed);
  validateExactActorEffectProvenance(parsed, slots);
  if (slots.length === 0) {
    return;
  }
  if (!graph) throw new CompilerQuestionError("source_graph_required", "source graph is required for SAN declaration validation");
  const consumed = new Map<string, { capacity: number; used: number }>();
  const multiConnectionQuestion = parsed.kind === "connection_topology" && parsed.connections.length > 1;
  const connectionTargetNames = parsed.kind === "connection_topology"
    ? new Map(parsed.connections.map((connection) => [connection.connectionId, targetSceneName(graph, connection.toSceneId)]))
    : new Map<string, string>();
  const checkedDiscoveryMechanisms = checkedDiscoveryMechanismIds(parsed);
  for (const slot of slots) {
    const binding = slot.binding;
    if (!binding || binding.effectPath !== slot.effectPath || binding.eventSlot.kind !== slot.eventSlot.kind
      || binding.eventSlot.outcome !== slot.eventSlot.outcome || binding.eventSlot.effectIndex !== slot.eventSlot.effectIndex
      || (binding.eventSlot.kind === "connection" && (slot.eventSlot.kind !== "connection" || binding.eventSlot.connectionId !== slot.eventSlot.connectionId))
      || (binding.eventSlot.kind === "discovery" && (slot.eventSlot.kind !== "discovery" || binding.eventSlot.mechanismId !== slot.eventSlot.mechanismId))) {
      throw new CompilerQuestionError("invalid_actor_effect_provenance", "SAN actor-effect binding does not name its exact event slot");
    }
    const statementId = binding.source.statementId;
    if (!question.sourceStatementIds.includes(statementId)) throw new CompilerQuestionError("unknown_hint_reference", "SAN actor-effect binding cites a statement outside its question evidence");
    const statement = graph.statements.find((candidate) => candidate.id === statementId);
    const quote = binding.source.quote;
    if (!statement || typeof quote !== "string" || quote !== quote.trim() || !quote || statement.text.indexOf(quote) < 0 || statement.text.indexOf(quote) !== statement.text.lastIndexOf(quote)) {
      throw new CompilerQuestionError("invalid_actor_effect_provenance", "SAN actor-effect binding quote must be a unique exact source substring");
    }
    const declaration = sourceSanityDeclarationReference(statement, quote);
    if (!declaration || declaration.sanityKey !== sanityCheckKey(slot.effect)) {
      throw new CompilerQuestionError("source_declaration_mismatch", "source declaration mismatch: SAN actor-effect binding quote does not uniquely cover its declared loss pair");
    }
    if (binding.eventSlot.kind === "connection" && multiConnectionQuestion
      && !quoteNamesExactlyOneConnectionTarget(connectionTargetNames, binding.eventSlot.connectionId, quote)) {
      throw new CompilerQuestionError("ambiguous_actor_effect_slot", "multi-edge SAN evidence must name the source-exact destination scene for its connection event slot");
    }
    if (binding.eventSlot.kind === "discovery" && checkedDiscoveryMechanisms.has(binding.eventSlot.mechanismId)
      && uniqueDiscoveryBranchInQuote(quote) !== binding.eventSlot.outcome) {
      throw new CompilerQuestionError("ambiguous_actor_effect_slot", "checked SAN evidence must name exactly one matching discovery branch");
    }
    consumeSourceSanityDeclaration(consumed, declaration);
  }
}

function validateResolvedSanityDeclarationConsumption(graph: SourceFactGraph, resolutions: ReadonlyArray<{ question: CompilerQuestion; resolution: CompilerQuestionResolution }>): void {
  const consumed = new Map<string, { capacity: number; used: number }>();
  for (const { question, resolution } of resolutions) {
    const parsed = parseCompilerHintValue(question, resolution.value, graph);
    for (const slot of parsedSanityEffectSlots(parsed)) {
      const binding = slot.binding;
      const statement = binding && graph.statements.find((candidate) => candidate.id === binding.source.statementId);
      const declaration = statement && binding ? sourceSanityDeclarationReference(statement, binding.source.quote) : undefined;
      if (!declaration) throw new CompilerQuestionError("source_declaration_mismatch", "source declaration mismatch: SAN actor-effect binding has no exact source declaration");
      consumeSourceSanityDeclaration(consumed, declaration);
    }
  }
}

/** The one value-semantics contract used by both hint validation and resolution. */
export function parseCompilerHintValue(question: CompilerQuestion, value: unknown, graph?: SourceFactGraph): ParsedCompilerHintValue {
  const parsed = parseCompilerHintValueUnchecked(question, value, graph);
  validateSanityCheckSourceDeclarations(question, parsed, graph);
  return parsed;
}

/**
 * Stable, declaration-level citation keys for a parsed hint value.
 * A zero-edge topology is itself a declaration, so it still needs one citation.
 */
export function compilerHintClaimKeys(value: ParsedCompilerHintValue): string[] {
  switch (value.kind) {
    case "scene_role": return ["scene_role"];
    case "entry_scene": return ["entry_scene"];
    case "core_clue": return ["core_clue"];
    case "connection_topology": return value.connections.length
      ? value.connections.map((connection) => `connection:${connection.connectionId}`)
      : ["topology"];
    case "ending_rule": return value.declarations.map((declaration) => `ending:${declaration.endingId}`);
    case "discovery_method": return [`discovery:${value.spec.id}`];
    case "clue_fact_facets": return [
      ...value.shellAtoms.map((atom) => `clue_fact_shell:${value.clueId}:${atom.atomId}`),
      ...value.findings.flatMap((finding) => [
        ...finding.atoms.map((atom) => `clue_fact_finding:${finding.findingKey}:${atom.atomId}`),
        ...finding.methods.map((method) => `clue_fact_method:${finding.findingKey}:${method.declarationKey}`),
      ]),
      ...value.sourceOnlyAtomIds.map((atomId) => `clue_fact_source_only:${value.clueId}:${atomId}`),
    ];
    case "source_fact_disposition": return [`source_fact_disposition:${value.statementId}`];
    case "source_fact_mechanic": return value.declarations.flatMap((declaration) => sourceFactMechanicClaimKeys(value.statementId, declaration));
    case "npc_binding": return value.presentNpcs.length
      ? value.presentNpcs.map((_npc, index) => `npc_binding:${value.proseAnchorId}:${index}`)
      : [`npc_binding:none:${value.proseAnchorId}`];
    case "item_binding": return [value.itemType === null ? `item_binding:none:${value.itemCandidateId}` : `item_binding:${value.itemCandidateId}`];
    case "reward_binding": return [value.declaration === null ? `reward_binding:none:${value.rewardCandidateId}` : `reward_binding:${value.rewardCandidateId}`];
  }
}

/**
 * Automatic NPC audits split identity from every independently actionable
 * source fact. The legacy key shape remains readable for historical static
 * NPC proposal audits.
 */
export function automaticNpcProseDialogueClaimKeys(value: ParsedCompilerHintValue): string[] {
  if (value.kind !== "npc_binding" || !value.presentNpcs.some((npc) => npc.dialogueMethods.some((method) => method.kind === "prose") || npc.encounter !== undefined)) {
    return compilerHintClaimKeys(value);
  }
  return value.presentNpcs.flatMap((npc, npcIndex) => [
    `npc_binding:${value.proseAnchorId}:${npcIndex}:name`,
    ...npc.dialogueMethods.map((method, methodIndex) => {
      if (method.kind !== "prose") throw new CompilerQuestionError("invalid_audit", "automatic NPC dialogue audit cannot contain a marked-item dialogue method");
      return `npc_binding:${value.proseAnchorId}:${npcIndex}:relationship:${methodIndex}`;
    }),
    ...(npc.encounter === undefined ? [] : [
      `npc_binding:${value.proseAnchorId}:${npcIndex}:encounter:trigger`,
      `npc_binding:${value.proseAnchorId}:${npcIndex}:encounter:maxHp`,
      `npc_binding:${value.proseAnchorId}:${npcIndex}:encounter:dodge`,
      `npc_binding:${value.proseAnchorId}:${npcIndex}:encounter:fight`,
      `npc_binding:${value.proseAnchorId}:${npcIndex}:encounter:npcDamage`,
    ]),
  ]);
}

/** Proposals must cite each bound name itself, not unrelated words in its paragraph. */
export function validateNpcBindingCitationQuote(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  parsed: ParsedCompilerHintValue,
  citations: readonly CompilerHintCitation[],
): void {
  if (parsed.kind !== "npc_binding") return;
  const { paragraph } = npcBindingAnchorStatement(graph, question);
  for (const [index, npc] of parsed.presentNpcs.entries()) {
    const claimKey = `npc_binding:${parsed.proseAnchorId}:${index}`;
    const citation = citations.find((candidate) => candidate.claimKey === claimKey);
    if (!citation || citation.statementId !== paragraph.id || citation.quote !== npc.nameQuote) {
      throw new CompilerQuestionError("invalid_audit", `NPC binding citation must exactly quote its nameQuote: ${question.id}`);
    }
  }
}

function hasAutomaticNpcEncounter(value: ParsedCompilerHintValue): boolean {
  return value.kind === "npc_binding" && value.presentNpcs.some((npc) => npc.encounter !== undefined);
}

/** Narrow automatic-combat trigger grammar: explicit, immediate hostility only. */
export function isAutomaticNpcEncounterHostilityTrigger(nameQuote: string, quote: string): boolean {
  if (quote !== quote.trim() || quote.length < 2 || quote.length > 240 || !quote.includes(nameQuote) || quote === nameQuote) return false;
  const escapedName = nameQuote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactName = `(?<![\\p{L}\\p{N}_])${escapedName}(?![\\p{L}\\p{N}_])`;
  const hostile = new RegExp(`${exactName}[\\s,:-]*(?:(?:suddenly|immediately)\\s+)?(?:attacks?|ambush(?:es|ed|ing)?|charges?|becomes?\\s+hostile|tries?\\s+to\\s+kill)\\b`, "iu").test(quote)
    || new RegExp(`${escapedName}[\\s,，:：-]*(?:\\u653b\\u51fb|\\u88ad\\u51fb|\\u4f0f\\u51fb|\\u6251\\u5411|\\u56f4\\u653b|\\u53d8\\u5f97\\u654c\\u5bf9)`, "u").test(quote);
  const negated = /\b(?:not|never|does\s+not|doesn't|will\s+not|won't|refuses?\s+to)(?:\s+\w+){0,3}\s+attack(?:s|ed|ing)?\b/iu.test(quote)
    || /\u4e0d(?:\u4f1a|\u518d|\u4e3b\u52a8|\u76f4\u63a5)?[^\u3002\uff1b\uff0c,]{0,8}\u653b\u51fb|\u907f\u514d|\u8eb2\u907f|\u62d2\u7edd\u653b\u51fb/u.test(quote);
  const conditional = /\b(?:if|unless|when|after|only\s+when|when\s+provoked|after\s+(?:being\s+)?provoked|in\s+self-defense|self-defen[cs]e|defensively|attacks?\s+anyone\s+who\s+attacks|only\s+against)\b/iu.test(quote)
    || /\u5982\u679c|\u82e5|\u9664\u975e|\u53d7\u5230\u653b\u51fb\u540e|\u6fc0\u6012\u540e|\u5426\u5219|\u81ea\u536b|\u53cd\u51fb|\u8fd8\u51fb/u.test(quote);
  const capability = /\b(?:can|may|could|might)\s+(?:\w+\s+){0,2}attack\b/iu.test(quote) || /\u53ef\u4ee5\u653b\u51fb/u.test(quote);
  return hostile && !negated && !conditional && !capability;
}

/** Automatic NPC dialogue and encounters must independently prove each actor and fact. */
export function validateAutomaticNpcProseDialogueCitationQuotes(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  parsed: ParsedCompilerHintValue,
  citations: readonly CompilerHintCitation[],
): void {
  if (parsed.kind !== "npc_binding" || !parsed.presentNpcs.some((npc) => npc.dialogueMethods.some((method) => method.kind === "prose") || npc.encounter !== undefined)) return;
  const { paragraph } = npcBindingAnchorStatement(graph, question);
  for (const [npcIndex, npc] of parsed.presentNpcs.entries()) {
    const nameKey = `npc_binding:${parsed.proseAnchorId}:${npcIndex}:name`;
    const nameCitation = citations.find((candidate) => candidate.claimKey === nameKey);
    if (!nameCitation || nameCitation.statementId !== paragraph.id || nameCitation.quote !== npc.nameQuote) {
      throw new CompilerQuestionError("invalid_audit", `automatic NPC name citation must exactly quote nameQuote: ${question.id}`);
    }
    for (const [methodIndex, method] of npc.dialogueMethods.entries()) {
      if (method.kind !== "prose") throw new CompilerQuestionError("invalid_audit", `automatic NPC dialogue audit cannot contain marked-item dialogue: ${question.id}`);
      const relationshipKey = `npc_binding:${parsed.proseAnchorId}:${npcIndex}:relationship:${methodIndex}`;
      const relationshipCitation = citations.find((candidate) => candidate.claimKey === relationshipKey);
      if (!relationshipCitation
        || relationshipCitation.statementId !== paragraph.id
        || relationshipCitation.quote !== method.relationshipEvidence.quote
        || relationshipCitation.quote === npc.nameQuote) {
        throw new CompilerQuestionError("invalid_audit", `automatic NPC relationship citation must exactly quote relationshipEvidence: ${question.id}`);
      }
    }
    if (npc.encounter !== undefined) {
      if (npc.encounter.victoryEffects.length !== 0 || npc.encounter.victoryEffectEvidence.length !== 0 || !automaticNpcEncounterProfile(graph, question, npc)) {
        throw new CompilerQuestionError("invalid_audit", `automatic NPC encounter must select one closed stat profile with no victory effects: ${question.id}`);
      }
      const triggerKey = `npc_binding:${parsed.proseAnchorId}:${npcIndex}:encounter:trigger`;
      const trigger = citations.find((candidate) => candidate.claimKey === triggerKey);
      if (!trigger || trigger.statementId !== paragraph.id || !isAutomaticNpcEncounterHostilityTrigger(npc.nameQuote, trigger.quote)) {
        throw new CompilerQuestionError("invalid_audit", `automatic NPC encounter requires an immediate hostile anchor trigger citation: ${question.id}`);
      }
      for (const label of ["maxHp", "dodge", "fight", "npcDamage"] as const) {
        const claimKey = `npc_binding:${parsed.proseAnchorId}:${npcIndex}:encounter:${label}`;
        const citation = citations.find((candidate) => candidate.claimKey === claimKey);
        const evidence = npc.encounter.statEvidence[label];
        if (!citation || citation.statementId !== evidence.statementId || citation.quote !== evidence.quote) {
          throw new CompilerQuestionError("invalid_audit", `automatic NPC encounter ${label} citation must exactly quote its selected stat: ${question.id}`);
        }
      }
    }
  }
}

/** Item type is an adapter choice, but its identity must cite the exact marked name. */
export function validateItemBindingCitationQuote(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  parsed: ParsedCompilerHintValue,
  citations: readonly CompilerHintCitation[],
): void {
  if (parsed.kind !== "item_binding") return;
  const { name } = itemNameEvidenceStatements(graph, question);
  const claimKey = parsed.itemType === null ? `item_binding:none:${parsed.itemCandidateId}` : `item_binding:${parsed.itemCandidateId}`;
  const citation = citations.find((candidate) => candidate.claimKey === claimKey);
  if (parsed.itemType === null) {
    if (!citation || citation.statementId !== name.id || citation.quote !== name.text) {
      throw new CompilerQuestionError("invalid_audit", `source-only item binding citation must exactly quote its marked item name: ${question.id}`);
    }
  } else if (!citation || citation.statementId !== parsed.itemNameEvidence.statementId || citation.quote !== parsed.itemNameEvidence.quote) {
    throw new CompilerQuestionError("invalid_audit", `positive item binding citation must exactly quote itemNameEvidence: ${question.id}`);
  }
}

/** A reward proposal must cite the exact table row, never a neighbouring row or heading. */
export function validateRewardBindingCitationQuote(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  parsed: ParsedCompilerHintValue,
  citations: readonly CompilerHintCitation[],
): void {
  if (parsed.kind !== "reward_binding") return;
  const row = question.sourceStatementIds
    .map((id) => graph.statements.find((statement) => statement.id === id))
    .find((statement): statement is SourceStatement => statement?.kind === "table_row");
  if (!row) throw new CompilerQuestionError("invalid_question", "reward binding question lacks its source table row");
  const claimKey = parsed.declaration === null ? `reward_binding:none:${parsed.rewardCandidateId}` : `reward_binding:${parsed.rewardCandidateId}`;
  const citation = citations.find((candidate) => candidate.claimKey === claimKey);
  if (!citation || citation.statementId !== row.id || citation.quote !== row.text) {
    throw new CompilerQuestionError("invalid_audit", `reward binding citation must exactly quote its table row: ${question.id}`);
  }
}

/** A source disposition is a whole-statement declaration, never a partial prose quote. */
export function validateSourceFactDispositionCitationQuote(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  parsed: ParsedCompilerHintValue,
  citations: readonly CompilerHintCitation[],
): void {
  if (parsed.kind !== "source_fact_disposition") return;
  const statement = sourceFactDispositionSubjectStatement(graph, question);
  const claimKey = `source_fact_disposition:${parsed.statementId}`;
  const citation = citations.find((candidate) => candidate.claimKey === claimKey);
  if (!citation || citation.statementId !== statement.id || citation.quote !== statement.text) {
    throw new CompilerQuestionError("invalid_audit", `source fact disposition citation must exactly quote its whole source statement: ${question.id}`);
  }
}

/** Future audited proposal adapters reuse the same declaration atom keys as human evidence. */
export function validateSourceFactMechanicCitationQuotes(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  parsed: ParsedCompilerHintValue,
  citations: readonly CompilerHintCitation[],
): void {
  if (parsed.kind !== "source_fact_mechanic") return;
  const { root } = sourceFactMechanicRootAndHeading(graph, question);
  const expected = parsed.declarations.flatMap((declaration) => declaration.evidence);
  for (const evidence of expected) {
    const citation = citations.find((candidate) => candidate.claimKey === evidence.claimKey);
    if (!citation || citation.statementId !== root.id || citation.quote !== evidence.quote) {
      throw new CompilerQuestionError("invalid_audit", `source fact mechanic citation must exactly quote its declared root atom: ${question.id}`);
    }
  }
}

/**
 * A proposal may only partition the atom domain that the queue exposed.  The
 * generic audit validator proves that each quote is a source substring; this
 * stricter check also binds each claim to its exact structural atom.  Methods
 * cite the first atom of their own finding because a method has no separate
 * source prose beyond the finding it reveals.
 */
export function validateClueFactFacetCitationQuotes(
  graph: SourceFactGraph,
  question: CompilerQuestion,
  parsed: ParsedCompilerHintValue,
  citations: readonly CompilerHintCitation[],
): void {
  if (parsed.kind !== "clue_fact_facets") return;
  const offered = new Map(clueFactFacetAtoms(graph, question).map((atom) => [atom.id, atom]));
  const exact = (claimKey: string, atomId: string) => {
    const atom = offered.get(atomId);
    const citation = citations.find((candidate) => candidate.claimKey === claimKey);
    if (!atom || !citation || citation.statementId !== atom.bodyStatementId || citation.quote !== atom.quote) {
      throw new CompilerQuestionError("invalid_audit", `clue fact facet citation must exactly quote its offered atom: ${question.id}`);
    }
  };
  for (const atom of parsed.shellAtoms) exact(`clue_fact_shell:${parsed.clueId}:${atom.atomId}`, atom.atomId);
  for (const finding of parsed.findings) {
    for (const atom of finding.atoms) exact(`clue_fact_finding:${finding.findingKey}:${atom.atomId}`, atom.atomId);
    const methodAtom = finding.atoms[0];
    if (!methodAtom) throw new CompilerQuestionError("invalid_audit", `clue fact finding has no atom for method citation: ${question.id}`);
    for (const method of finding.methods) exact(`clue_fact_method:${finding.findingKey}:${method.declarationKey}`, methodAtom.atomId);
  }
  for (const atomId of parsed.sourceOnlyAtomIds) exact(`clue_fact_source_only:${parsed.clueId}:${atomId}`, atomId);
}

/**
 * Structural body statements are normalized by ingestion, while a facet atom
 * retains its raw source span (including whitespace).  This admits only an
 * offered atom's own exact quote at the generic citation boundary; the
 * claim-to-atom relation remains enforced by validateClueFactFacetCitationQuotes.
 */
export function isExactClueFactAtomCitation(question: CompilerQuestion, statementId: string, quote: string): boolean {
  return question.kind === "clue_fact_facets"
    && question.allowedClueFactAtoms?.some((atom) => atom.bodyStatementId === statementId && atom.quote === quote) === true;
}

function auditRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompilerQuestionError("invalid_audit", "proposal audit must be an object");
  return value as Record<string, unknown>;
}

function auditOnly(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new CompilerQuestionError("invalid_audit", `undeclared proposal audit field: ${key}`);
}

function validateProposalAudit(graph: SourceFactGraph | undefined, question: CompilerQuestion, resolution: CompilerQuestionResolution, parsed: ParsedCompilerHintValue): void {
  if (!resolution.audit) return;
  if (!graph) throw new CompilerQuestionError("audit_requires_graph", `proposal audit requires SourceFactGraph: ${resolution.questionId}`);
  const audit = auditRecord(resolution.audit);
  const schemaVersion = audit.schemaVersion;
  const legacy = schemaVersion === COMPILER_HINT_PROPOSAL_AUDIT_SCHEMA_VERSION;
  const provenance = schemaVersion === COMPILER_HINT_PROPOSAL_AUDIT_PROVENANCE_SCHEMA_VERSION;
  const proseDialogue = schemaVersion === COMPILER_HINT_PROPOSAL_AUDIT_NPC_PROSE_DIALOGUE_SCHEMA_VERSION;
  const encounter = schemaVersion === COMPILER_HINT_PROPOSAL_AUDIT_NPC_ENCOUNTER_SCHEMA_VERSION;
  if (!legacy && !provenance && !proseDialogue && !encounter) throw new CompilerQuestionError("invalid_audit", `unsupported proposal audit schema: ${resolution.questionId}`);
  auditOnly(audit, provenance || proseDialogue || encounter ? ["kind", "schemaVersion", "proposalId", "policyId", "citations", "producer"] : ["kind", "schemaVersion", "proposalId", "policyId", "citations"]);
  if (audit.kind !== "compiler_hint_proposal") throw new CompilerQuestionError("invalid_audit", `unsupported proposal audit kind: ${resolution.questionId}`);
  if (typeof audit.proposalId !== "string" || !audit.proposalId.trim()) throw new CompilerQuestionError("invalid_audit", `proposal audit lacks proposalId: ${resolution.questionId}`);
  if (typeof audit.policyId !== "string" || !audit.policyId.trim()) throw new CompilerQuestionError("invalid_audit", `proposal audit lacks policyId: ${resolution.questionId}`);
  if (provenance || encounter || (proseDialogue && audit.producer !== undefined)) {
    const producer = auditRecord(audit.producer);
    auditOnly(producer, ["providerFingerprint", "modelFingerprint", "requestHash", "responseHash"]);
    for (const key of ["providerFingerprint", "modelFingerprint"] as const) {
      if (typeof producer[key] !== "string" || !producer[key].trim()) throw new CompilerQuestionError("invalid_audit", `proposal audit lacks ${key}: ${resolution.questionId}`);
    }
    for (const key of ["requestHash", "responseHash"] as const) {
      if (typeof producer[key] !== "string" || !/^[a-f0-9]{64}$/.test(producer[key] as string)) throw new CompilerQuestionError("invalid_audit", `proposal audit has invalid ${key}: ${resolution.questionId}`);
    }
  }
  if (resolution.authority !== "user_document" || resolution.derivation !== "explicit" || resolution.reviewerKind !== "approved_policy" || resolution.policyId !== audit.policyId) {
    throw new CompilerQuestionError("invalid_audit", `proposal audit resolution authority is not compiler-controlled: ${resolution.questionId}`);
  }
  // A model/audited proposal can cite a nearby sentence but cannot reliably
  // prove that its loss grammar is the source declaration.  SAN checks remain
  // available through the existing human-reviewed source hint path only.
  if (containsSanityCheck(parsed)) throw new CompilerQuestionError("invalid_audit", `model proposals cannot declare sanity_check; require human review: ${resolution.questionId}`);
  const automaticProseDialogue = parsed.kind === "npc_binding" && parsed.presentNpcs.some((npc) => npc.dialogueMethods.some((method) => method.kind === "prose"));
  const automaticNpcEncounter = hasAutomaticNpcEncounter(parsed);
  if (automaticNpcEncounter) {
    if (!encounter) throw new CompilerQuestionError("invalid_audit", `automatic NPC encounter requires audit schema 1.3.0: ${resolution.questionId}`);
    validateAutomaticNpcProseDialogueProposalValue(resolution.value);
  } else if (encounter) {
    throw new CompilerQuestionError("invalid_audit", `proposal audit schema 1.3.0 requires an automatic NPC encounter: ${resolution.questionId}`);
  }
  if (automaticProseDialogue && !automaticNpcEncounter) {
    if (!proseDialogue) throw new CompilerQuestionError("invalid_audit", `automatic prose NPC dialogue requires audit schema 1.2.0: ${resolution.questionId}`);
    validateAutomaticNpcProseDialogueProposalValue(resolution.value);
  } else if (proseDialogue && !automaticNpcEncounter) {
    throw new CompilerQuestionError("invalid_audit", `proposal audit schema 1.2.0 requires automatic prose NPC dialogue: ${resolution.questionId}`);
  }
  if (parsed.kind === "npc_binding" && parsed.presentNpcs.some((npc) => npc.dialogueMethods.some((method) => method.kind === "marked_item"))) {
    throw new CompilerQuestionError("invalid_audit", `model proposals cannot declare marked-item NPC dialogue; require human review: ${resolution.questionId}`);
  }
  if (!Array.isArray(audit.citations)) throw new CompilerQuestionError("invalid_audit", `proposal audit citations must be an array: ${resolution.questionId}`);
  const requiredKeys = automaticProseDialogue || automaticNpcEncounter ? automaticNpcProseDialogueClaimKeys(parsed) : compilerHintClaimKeys(parsed);
  const required = new Set(requiredKeys);
  const citedKeys = new Set<string>();
  const statementsById = new Map(graph.statements.map((statement) => [statement.id, statement]));
  for (const citationValue of audit.citations) {
    const citation = auditRecord(citationValue);
    auditOnly(citation, ["claimKey", "statementId", "quote"]);
    if (typeof citation.claimKey !== "string" || !citation.claimKey) throw new CompilerQuestionError("invalid_audit", `proposal audit citation lacks claimKey: ${resolution.questionId}`);
    if (!required.has(citation.claimKey)) throw new CompilerQuestionError("invalid_audit", `proposal audit has unknown claimKey: ${citation.claimKey}`);
    if (citedKeys.has(citation.claimKey)) throw new CompilerQuestionError("invalid_audit", `proposal audit duplicates claimKey: ${citation.claimKey}`);
    if (typeof citation.statementId !== "string" || !question.sourceStatementIds.includes(citation.statementId)) throw new CompilerQuestionError("invalid_audit", `proposal audit cites foreign statement: ${resolution.questionId}`);
    if (typeof citation.quote !== "string" || !citation.quote.trim()) throw new CompilerQuestionError("invalid_audit", `proposal audit has empty quote: ${resolution.questionId}`);
    const statement = statementsById.get(citation.statementId);
    if (!statement || (!statement.text.includes(citation.quote) && !isExactClueFactAtomCitation(question, citation.statementId, citation.quote))) {
      throw new CompilerQuestionError("invalid_audit", `proposal audit quote is not source-exact: ${resolution.questionId}`);
    }
    citedKeys.add(citation.claimKey);
  }
  if (citedKeys.size !== required.size || requiredKeys.some((key) => !citedKeys.has(key))) throw new CompilerQuestionError("invalid_audit", `proposal audit does not cover every declaration: ${resolution.questionId}`);
  if (automaticProseDialogue || automaticNpcEncounter) validateAutomaticNpcProseDialogueCitationQuotes(graph, question, parsed, audit.citations as CompilerHintCitation[]);
  else validateNpcBindingCitationQuote(graph, question, parsed, audit.citations as CompilerHintCitation[]);
  validateItemBindingCitationQuote(graph, question, parsed, audit.citations as CompilerHintCitation[]);
  validateRewardBindingCitationQuote(graph, question, parsed, audit.citations as CompilerHintCitation[]);
  validateSourceFactDispositionCitationQuote(graph, question, parsed, audit.citations as CompilerHintCitation[]);
  validateSourceFactMechanicCitationQuotes(graph, question, parsed, audit.citations as CompilerHintCitation[]);
  validateClueFactFacetCitationQuotes(graph, question, parsed, audit.citations as CompilerHintCitation[]);
}

/** Source disposition never carries a candidate-domain identity: the statement is its sole subject. */
function sourceFactDispositionSubjectStatement(graph: SourceFactGraph, question: CompilerQuestion): SourceStatement {
  if (question.kind !== "source_fact_disposition"
    || !question.subjectStatementId
    || question.sourceStatementIds.length !== 1
    || question.sourceStatementIds[0] !== question.subjectStatementId
    || question.subjectCandidateId !== undefined
    || question.candidateIds?.length
    || question.allowedCandidateIds?.length
    || question.allowedLocationCandidateIds?.length
    || question.allowedMechanicsTargetIds
    || !question.allowedDispositions?.length
    || question.sourceFactParentQuestionId !== undefined
    || question.owningSceneCandidateId !== undefined
    || question.owningHeadingStatementId !== undefined) {
    throw new CompilerQuestionError("invalid_question", "source fact disposition question must have exactly one statement subject and no candidate domain");
  }
  const statement = graph.statements.find((candidate) => candidate.id === question.subjectStatementId);
  if (!statement || (statement.kind !== "paragraph" && statement.kind !== "list_item" && statement.kind !== "table_row")) {
    throw new CompilerQuestionError("invalid_question", "source fact disposition subject must be an exact source paragraph, list item, or table row");
  }
  const dispositions = question.allowedDispositions;
  if (dispositions.some((entry) => entry !== "source_only" && entry !== "mechanics_candidate")
    || uniqueSorted(dispositions).join("|") !== dispositions.join("|")) {
    throw new CompilerQuestionError("invalid_question", "source fact disposition domain must be sorted and unique");
  }
  if (question.sourceFactChildQuestionId && !dispositions.includes("mechanics_candidate")) {
    throw new CompilerQuestionError("invalid_question", "source fact parent with child must permit mechanics_candidate");
  }
  if (!question.sourceFactChildQuestionId && (dispositions.length !== 1 || dispositions[0] !== "source_only")) {
    throw new CompilerQuestionError("invalid_question", "source fact parent without child must be source_only only");
  }
  return statement;
}

function validateSourceFactMechanicPair(graph: SourceFactGraph, queue: CompilerQuestionQueue, child: CompilerQuestion): void {
  const { root, heading } = sourceFactMechanicRootAndHeading(graph, child);
  const parent = queue.questions.find((question) => question.id === child.sourceFactParentQuestionId);
  if (!parent || parent.kind !== "source_fact_disposition" || parent.sourceFactChildQuestionId !== child.id
    || parent.subjectStatementId !== root.id) {
    throw new CompilerQuestionError("invalid_question", "source fact mechanic child does not match its prepared disposition parent");
  }
  if (child.subjectCandidateId !== undefined || child.candidateIds?.length || child.allowedCandidateIds?.length
    || child.allowedLocationCandidateIds?.length || child.allowedItemNameEvidenceStatementIds?.length
    || child.allowedRewardPredicateIds || child.allowedClueFactAtoms !== undefined || !child.allowedMechanicsTargetIds) {
    throw new CompilerQuestionError("invalid_question", "source fact mechanic child has an undeclared candidate domain");
  }
  const targets = child.allowedMechanicsTargetIds;
  for (const kind of ["scene", "clue", "item"] as const) {
    const values = targets[kind] ?? [];
    if (values.some((value) => typeof value !== "string") || values.join("|") !== uniqueSorted(values).join("|")) {
      throw new CompilerQuestionError("invalid_question", `source fact mechanic ${kind} domain must be sorted and unique`);
    }
  }
  const hasLegacyClues = !!targets.clue?.length;
  const hasProseFindings = !!child.allowedProseFactFindingCandidates?.length;
  if (targets.scene?.length !== 1 || targets.scene[0] !== child.owningSceneCandidateId || (!hasLegacyClues && !hasProseFindings)
    || !graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === root.id)) {
    throw new CompilerQuestionError("invalid_question", "source fact mechanic child lacks a closed same-heading domain");
  }
  if (hasProseFindings) sourceFactProseDomains(graph, child);
  else if (child.allowedSourceFactAtoms !== undefined || child.allowedProseFactFindingCandidates !== undefined) {
    throw new CompilerQuestionError("invalid_question", "source fact mechanic child has an incomplete prose finding domain");
  }
}

function validateResolution(graph: SourceFactGraph | undefined, question: CompilerQuestion, resolution: CompilerQuestionResolution): void {
  if (resolution.questionId !== question.id || resolution.kind !== question.kind) throw new CompilerQuestionError("kind_mismatch", `hint kind does not match question: ${resolution.questionId}`);
  if (!( ["module_explicit", "user_document", "project_original"] as string[]).includes(resolution.authority)) throw new CompilerQuestionError("invalid_authority", `hint authority is not allowed: ${resolution.questionId}`);
  if (!( ["deterministic_rule", "human", "approved_policy"] as string[]).includes(resolution.reviewerKind)) throw new CompilerQuestionError("invalid_reviewer", `hint reviewer kind is not allowed: ${resolution.questionId}`);
  if (resolution.reviewerKind !== "human" && !resolution.policyId?.trim()) throw new CompilerQuestionError("invalid_reviewer", `policy reviewer lacks policyId: ${resolution.questionId}`);
  if (!( ["unknown", "open_licensed", "project_owned", "user_provided"] as string[]).includes(resolution.rightsStatus)) throw new CompilerQuestionError("invalid_rights", `hint rights are not allowed: ${resolution.questionId}`);
  if (resolution.derivation !== "explicit") throw new CompilerQuestionError("open_question_default", `open question cannot be defaulted: ${resolution.questionId}`);
  if (!resolution.reason.trim()) throw new CompilerQuestionError("missing_reason", `hint reason is required: ${resolution.questionId}`);
  if (uniqueSorted(resolution.sourceStatementIds).join("|") !== uniqueSorted(question.sourceStatementIds).join("|")) throw new CompilerQuestionError("evidence_mismatch", `hint source statements do not match question: ${resolution.questionId}`);
  if (uniqueSorted(resolution.evidenceRefs).join("|") !== uniqueSorted(question.evidenceRefs).join("|")) throw new CompilerQuestionError("evidence_mismatch", `hint evidence does not match question: ${resolution.questionId}`);
  const parsed = parseCompilerHintValue(question, resolution.value, graph);
  validateProposalAudit(graph, question, resolution, parsed);
}

export function validateCompilerQuestionQueue(graph: SourceFactGraph, queue: CompilerQuestionQueue): void {
  validateSourceFactGraph(graph);
  if (queue.schemaVersion !== COMPILER_QUESTION_QUEUE_SCHEMA_VERSION) throw new CompilerQuestionError("schema_mismatch", "unsupported compiler question queue schema");
  if (!queue.moduleId.trim()) throw new CompilerQuestionError("identity_mismatch", "queue moduleId is required");
  if (queue.documentHash !== graph.documentIdentity.documentHash || queue.sourceGraphIdentity !== sourceFactGraphIdentity(graph)) throw new CompilerQuestionError("identity_mismatch", "queue does not match SourceFactGraph identity");
  const ids = new Set<string>();
  const equivalence = new Set<string>();
  for (const question of queue.questions) {
    if (ids.has(question.id)) throw new CompilerQuestionError("duplicate_question", `duplicate question id: ${question.id}`);
    ids.add(question.id);
    if (question.sourceStatementIds.length === 0) throw new CompilerQuestionError("missing_source", `question has no source statements: ${question.id}`);
    if (new Set(question.sourceStatementIds).size !== question.sourceStatementIds.length) throw new CompilerQuestionError("duplicate_source", `question duplicates source statements: ${question.id}`);
    const requiredRefs = refs(graph, question.sourceStatementIds);
    if (uniqueSorted(question.evidenceRefs).join("|") !== uniqueSorted(requiredRefs).join("|")) throw new CompilerQuestionError("evidence_mismatch", `question evidence does not exactly cover source statements: ${question.id}`);
    if (question.kind === "npc_binding") npcBindingAnchorStatement(graph, question);
    else if (question.kind === "item_binding") itemNameEvidenceStatements(graph, question);
    else if (question.kind === "clue_fact_facets") clueFactFacetAtoms(graph, question);
    else if (question.kind === "source_fact_disposition") sourceFactDispositionSubjectStatement(graph, question);
    else if (question.kind === "source_fact_mechanic") validateSourceFactMechanicPair(graph, queue, question);
    else if (question.subjectStatementId !== undefined) throw new CompilerQuestionError("invalid_question", `only npc binding and source fact questions may declare subjectStatementId: ${question.id}`);
    if (question.kind !== "item_binding" && question.allowedItemNameEvidenceStatementIds !== undefined) {
      throw new CompilerQuestionError("invalid_question", `only item binding questions may declare item name evidence domains: ${question.id}`);
    }
    if (question.kind !== "clue_fact_facets" && question.allowedClueFactAtoms !== undefined) {
      throw new CompilerQuestionError("invalid_question", `only clue fact facet questions may declare clue fact atom domains: ${question.id}`);
    }
    if (question.kind !== "source_fact_mechanic" && (question.allowedSourceFactAtoms !== undefined || question.allowedProseFactFindingCandidates !== undefined)) {
      throw new CompilerQuestionError("invalid_question", `only source fact mechanics may declare prose finding domains: ${question.id}`);
    }
    if (question.kind === "reward_binding") {
      const domains = question.allowedRewardPredicateIds;
      if (!domains || Object.keys(domains).length !== 3 || !["scene", "clue", "item"].every((kind) => Array.isArray(domains[kind as keyof typeof domains]))) {
        throw new CompilerQuestionError("invalid_question", `reward binding question lacks complete predicate target domains: ${question.id}`);
      }
      for (const kind of ["scene", "clue", "item"] as const) {
        const ids = domains[kind]!;
        if (ids.some((id) => typeof id !== "string") || uniqueSorted(ids).join("|") !== ids.join("|")) {
          throw new CompilerQuestionError("invalid_question", `reward binding predicate targets must be unique and sorted: ${question.id}`);
        }
      }
    } else if (question.allowedRewardPredicateIds !== undefined) {
      throw new CompilerQuestionError("invalid_question", `only reward binding questions may declare reward predicate target domains: ${question.id}`);
    }
    // NPC review evidence intentionally contains a shared heading scope.  Its
    // canonical prose statement is therefore part of semantic equivalence,
    // while a forged duplicate of that same statement remains rejected.
    const key = `${question.kind}|${question.subjectStatementId ?? ""}|${uniqueSorted(question.sourceStatementIds).join("|")}`;
    if (equivalence.has(key)) throw new CompilerQuestionError("duplicate_question", `duplicate question kind and evidence: ${question.id}`);
    equivalence.add(key);
    if (!( ["open", "answered", "rejected", "deferred", "not_applicable"] as string[]).includes(question.status)) throw new CompilerQuestionError("resolution_status_mismatch", `unknown question status: ${question.id}`);
    if (question.status === "answered") {
      if (!question.resolution) throw new CompilerQuestionError("resolution_status_mismatch", `answered question lacks resolution: ${question.id}`);
      validateResolution(graph, question, question.resolution);
    } else if (question.resolution) {
      throw new CompilerQuestionError("resolution_status_mismatch", `non-answered question has resolution: ${question.id}`);
    }
  }
  for (const parent of queue.questions.filter((question) => question.kind === "source_fact_disposition" && question.sourceFactChildQuestionId)) {
    const child = queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId);
    if (!child || child.kind !== "source_fact_mechanic") throw new CompilerQuestionError("invalid_question", `source fact parent child is missing: ${parent.id}`);
    if (parent.status !== "answered") {
      if (child.status !== "deferred") throw new CompilerQuestionError("resolution_status_mismatch", `unanswered source fact parent cannot activate child: ${child.id}`);
      continue;
    }
    const parsed = parseCompilerHintValue(parent, parent.resolution!.value, graph);
    if (parsed.kind !== "source_fact_disposition") throw new CompilerQuestionError("invalid_question", `source fact parent did not parse: ${parent.id}`);
    if (parsed.disposition === "source_only" && child.status !== "not_applicable") {
      throw new CompilerQuestionError("resolution_status_mismatch", `source-only disposition must make child not_applicable: ${child.id}`);
    }
    if (parsed.disposition === "mechanics_candidate" && child.status !== "open" && child.status !== "answered") {
      throw new CompilerQuestionError("resolution_status_mismatch", `mechanics-candidate disposition must activate child: ${child.id}`);
    }
  }
  validateResolvedSanityDeclarationConsumption(graph, queue.questions
    .filter((question) => question.status === "answered" && question.resolution)
    .map((question) => ({ question, resolution: question.resolution! })));
  const expected = sha256(canonical({ ...queue, queueHash: undefined }));
  if (queue.queueHash !== expected) throw new CompilerQuestionError("hash_mismatch", "queueHash does not match canonical queue");
}

function validateModuleCompileHintsShape(queue: CompilerQuestionQueue, hints: ModuleCompileHints, graph?: SourceFactGraph): void {
  const capabilities = moduleCompileHintsCapabilities(hints.schemaVersion);
  if (hints.moduleId !== queue.moduleId || hints.documentHash !== queue.documentHash || hints.sourceGraphIdentity !== queue.sourceGraphIdentity) throw new CompilerQuestionError("identity_mismatch", "hints do not match compiler question queue identity");
  const resolved = new Set<string>();
  const effectiveResolutions = new Map(queue.questions
    .filter((question) => question.status === "answered" && question.resolution)
    .map((question) => [question.id, { question, resolution: question.resolution! }]));
  for (const resolution of hints.resolutions) {
    if (resolved.has(resolution.questionId)) throw new CompilerQuestionError("conflicting_resolution", `multiple resolutions for question: ${resolution.questionId}`);
    resolved.add(resolution.questionId);
    const question = queue.questions.find((candidate) => candidate.id === resolution.questionId);
    if (!question) throw new CompilerQuestionError("unknown_question", `hint references unknown question: ${resolution.questionId}`);
    if (question.status === "rejected" || question.status === "not_applicable") throw new CompilerQuestionError("resolution_status_mismatch", `cannot answer ${question.status} question: ${question.id}`);
    if (!capabilities.sourceFactDisposition && containsSourceFactDisposition(question)) throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare source fact disposition; use 2.0.0");
    if (!capabilities.clueFactFacets && question.kind === "clue_fact_facets") throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare clue fact partitions; use 3.2.0");
    if (question.kind === "source_fact_mechanic" && hints.schemaVersion !== "3.0.0" && hints.schemaVersion !== "3.1.0" && hints.schemaVersion !== "3.2.0" && hints.schemaVersion !== "3.3.0" && hints.schemaVersion !== "3.4.0") throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare source fact mechanics; use 3.0.0");
    if (question.kind === "source_fact_mechanic" && question.allowedProseFactFindingCandidates?.length && !capabilities.proseFactFindings) {
      throw new CompilerQuestionError("schema_mismatch", "atom-partitioned prose findings require 3.4.0 hints");
    }
    if (!capabilities.explicitNullItemBinding && containsExplicitlyUnboundItemBinding(question, resolution.value)) throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare explicit source-only item bindings; use 1.9.0");
    if (!capabilities.sourceExactPositiveItemBinding && containsPositiveItemBinding(question, resolution.value)) throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare positive item bindings without source-exact itemNameEvidence; use 2.1.0");
    if (hints.schemaVersion === "1.3.0" && question.kind === "reward_binding") throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare source-bound rewards");
    if (!capabilities.npcDialogue && containsNpcDialogueMethods(resolution.value)) throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare NPC dialogue mechanics");
    if (!capabilities.proseDialogue && containsNpcProseDialogueMethods(resolution.value)) throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare prose NPC dialogue clues; use 2.2.0");
    if (!capabilities.automaticProseDialogueWire && containsAutomaticNpcProseDialogueWire(resolution.value)) throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot omit a prose NPC dialogue mechanismId; use 2.3.0");
    if (!capabilities.npcDialogue && containsNpcEncounter(resolution.value)) throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare NPC encounter mechanics");
    if (containsSanityCheck(resolution.value) && !capabilities.actorEffectProvenance) throw new CompilerQuestionError("schema_mismatch", "SAN actor effects require slot-bound hints schema 3.3.0");
    if (hints.schemaVersion === "1.7.0" && containsNpcVictoryEffects(resolution.value)) throw new CompilerQuestionError("schema_mismatch", "1.7 hints cannot declare NPC victoryEffects; use 1.8 source-bound effect evidence");
    if (capabilities.explicitNpcDialogueDeclaration && requiresExplicitNpcDialogueDeclaration(question, resolution.value)) throw new CompilerQuestionError("invalid_hint_value", "current NPC bindings must explicitly declare dialogueMethods, including an empty array");
    if (!capabilities.npcDialogue && containsSanityCheck(resolution.value)) throw new CompilerQuestionError("schema_mismatch", "legacy hints cannot declare sanity_check effects");
    if (!capabilities.sourceFactSceneTransition && question.kind === "source_fact_mechanic" && containsSourceFactSceneTransition(resolution.value)) {
      throw new CompilerQuestionError("schema_mismatch", "scene_state_transition source fact mechanics require 3.1.0 hints");
    }
    validateResolution(graph, question, resolution);
    if (question.status === "answered" && canonical(question.resolution) !== canonical(resolution)) throw new CompilerQuestionError("conflicting_resolution", `answered question conflict: ${question.id}`);
    effectiveResolutions.set(question.id, { question, resolution });
  }
  if (graph) validateResolvedSanityDeclarationConsumption(graph, [...effectiveResolutions.values()]);
}

function answerQuestion(question: CompilerQuestion, resolution: CompilerQuestionResolution): CompilerQuestion {
  return { ...structuredClone(question), status: "answered", resolution: structuredClone(resolution) };
}

/**
 * The only state-transition authority for supplied hints. Parent answers are
 * replayed before their typed children regardless of caller order, which also
 * makes repeated incremental apply calls equivalent to one cumulative replay.
 */
export function replayModuleCompileHints(graph: SourceFactGraph, queue: CompilerQuestionQueue, hints: ModuleCompileHints): CompilerQuestionQueue {
  validateSourceFactGraph(graph);
  validateCompilerQuestionQueue(graph, queue);
  validateModuleCompileHintsShape(queue, hints, graph);
  const incoming = new Map(hints.resolutions.map((resolution) => [resolution.questionId, resolution]));
  let questions = queue.questions.map((question) => structuredClone(question));
  const replace = (next: CompilerQuestion): void => {
    questions = questions.map((question) => question.id === next.id ? next : question);
  };
  // Parents deterministically own their child activation. A direct deferred
  // child answer cannot get past this phase, even when it appears first.
  for (const parent of questions.filter((question) => question.kind === "source_fact_disposition").sort((left, right) => left.id.localeCompare(right.id))) {
    const incomingParent = incoming.get(parent.id);
    const resolvedParent = incomingParent ? answerQuestion(parent, incomingParent) : parent;
    if (incomingParent) replace(resolvedParent);
    const childId = resolvedParent.sourceFactChildQuestionId;
    if (!childId) continue;
    const child = questions.find((question) => question.id === childId);
    if (!child) throw new CompilerQuestionError("invalid_question", `source fact child missing during replay: ${childId}`);
    if (resolvedParent.status !== "answered") {
      if (incoming.has(child.id)) throw new CompilerQuestionError("resolution_status_mismatch", `cannot answer deferred source fact child without mechanics_candidate parent: ${child.id}`);
      continue;
    }
    const disposition = parseCompilerHintValue(resolvedParent, resolvedParent.resolution!.value, graph);
    if (disposition.kind !== "source_fact_disposition") throw new CompilerQuestionError("invalid_question", `source fact parent did not parse: ${resolvedParent.id}`);
    if (disposition.disposition === "source_only") {
      if (incoming.has(child.id)) throw new CompilerQuestionError("resolution_status_mismatch", `source_only parent cannot answer source fact child: ${child.id}`);
      const { resolution: _resolution, ...notApplicable } = structuredClone(child);
      replace({ ...notApplicable, status: "not_applicable" });
      continue;
    }
    if (child.status === "deferred" || child.status === "not_applicable") {
      const { resolution: _resolution, ...openChild } = structuredClone(child);
      replace({ ...openChild, status: "open" });
    }
  }
  // Ordinary questions can be answered in canonical ID order. Children are
  // intentionally excluded until their parent has activated them above.
  for (const question of [...questions].sort((left, right) => left.id.localeCompare(right.id))) {
    if (question.kind === "source_fact_disposition" || question.kind === "source_fact_mechanic") continue;
    const resolution = incoming.get(question.id);
    if (!resolution) continue;
    if (question.status !== "open" && question.status !== "answered") throw new CompilerQuestionError("resolution_status_mismatch", `cannot answer ${question.status} question: ${question.id}`);
    replace(answerQuestion(question, resolution));
  }
  for (const child of [...questions].filter((question) => question.kind === "source_fact_mechanic").sort((left, right) => left.id.localeCompare(right.id))) {
    const resolution = incoming.get(child.id);
    if (!resolution) continue;
    if (child.status !== "open" && child.status !== "answered") throw new CompilerQuestionError("resolution_status_mismatch", `cannot answer ${child.status} source fact child: ${child.id}`);
    const sceneRole = questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId);
    if (!sceneRole || sceneRole.status !== "answered" || !sceneRole.resolution) {
      throw new CompilerQuestionError("invalid_scene_resolution", `source fact mechanic requires an answered playable owning scene: ${child.id}`);
    }
    const role = parseCompilerHintValue(sceneRole, sceneRole.resolution.value, graph);
    if (role.kind !== "scene_role" || role.role !== "playable_scene") {
      throw new CompilerQuestionError("invalid_scene_resolution", `source fact mechanic owning scene is not playable: ${child.id}`);
    }
    replace(answerQuestion(child, resolution));
  }
  const replayed = withQueueHash({ ...queue, questions });
  validateCompilerQuestionQueue(graph, replayed);
  return replayed;
}

export function validateModuleCompileHints(queue: CompilerQuestionQueue, hints: ModuleCompileHints, graph?: SourceFactGraph): void {
  validateModuleCompileHintsShape(queue, hints, graph);
  if (graph) replayModuleCompileHints(graph, queue, hints);
}

export function withQueueHash(queue: Omit<CompilerQuestionQueue, "queueHash"> & { queueHash?: string }): CompilerQuestionQueue {
  return { ...queue, queueHash: sha256(canonical({ ...queue, queueHash: undefined })) };
}
