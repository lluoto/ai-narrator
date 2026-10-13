import { parseCompilerHintValue, validateCompilerQuestionQueue, type CompilerQuestion, type CompilerQuestionQueue } from "./compiler-question-queue";
import type { ResolvedItemBinding, ResolvedProseNpcBinding, ResolvedRewardBinding, ResolvedSourceFactMechanicBinding } from "./compile-hint-resolution";
import type { DraftModuleStructure } from "./deterministic-template-compiler";
import type { MechanicsCandidateSpec } from "./mechanics-ir";
import type { FactInterpretationCandidate, SourceFactGraph, SourceStatement, SourceStatementKind } from "./source-fact-graph";

/** 2.1 keeps source-fact transitions root-exact in positive coverage. */
export const SOURCE_FACT_DISPOSITION_REPORT_SCHEMA_VERSION = "2.1.0";

const ROOT_KINDS = ["heading", "paragraph", "marked_item", "list_item", "table_row", "unknown"] as const;
const DISPOSITION_STATUSES = ["mechanics_evidence", "accepted_binding", "explicitly_unbound", "draft_candidate_open", "unmodeled"] as const;
const MECHANICS_QUESTION_KINDS = new Set<CompilerQuestion["kind"]>([
  "scene_role", "entry_scene", "connection_topology", "core_clue", "ending_rule", "discovery_method",
]);

export type SourceRootStatementKind = typeof ROOT_KINDS[number];
export type SourceFactDispositionStatus = typeof DISPOSITION_STATUSES[number];
/** A whole DocumentBlock statement that participates in source accounting. */
export type SourceFactDispositionRoot = Omit<SourceStatement, "kind"> & {
  kind: SourceRootStatementKind;
};

export interface SourceFactDispositionEntry {
  statementId: string;
  kind: SourceRootStatementKind;
  evidenceRefId: string;
  /**
   * One primary state per root statement.  This is a compact headline only:
   * unresolved semantic slots remain in openQuestionIds even when accepted
   * mechanics or bindings have higher precedence.
   */
  status: SourceFactDispositionStatus;
  reasons: string[];
  questionIds: string[];
  openQuestionIds: string[];
  interpretationIds: string[];
  /** Broad answer context is not enough: this flag is set only by exact positive evidence. */
  positiveCoverage: boolean;
  hasAcceptedBinding: boolean;
  hasMechanicsEvidence: boolean;
}

export interface SourceFactDispositionContentReadiness {
  status: "complete" | "incomplete";
  rootStatementCount: number;
  openQuestionCount: number;
  openRootCount: number;
  openQuestionIds: string[];
  unmodeledStatementIds: string[];
  /** Answered mechanics candidates remain pending without masquerading as open questions. */
  mechanicsCandidateStatementIds: string[];
}

/** Source-only is accounted for, but it is deliberately never positive mechanics coverage. */
export interface SourceFactDispositionPositiveCoverage {
  positiveRootCount: number;
  uncoveredRootCount: number;
  sourceOnlyDecisionRootCount: number;
  sourceOnlyOnlyRootCount: number;
  acceptedBindingRootCount: number;
  mechanicsEvidenceRootCount: number;
}

export interface SourceFactDispositionReport {
  schemaVersion: typeof SOURCE_FACT_DISPOSITION_REPORT_SCHEMA_VERSION;
  entries: SourceFactDispositionEntry[];
  counts: Record<SourceFactDispositionStatus, number>;
  contentReadiness: SourceFactDispositionContentReadiness;
  positiveCoverage: SourceFactDispositionPositiveCoverage;
}

/** The player-safe shape deliberately has no source statement IDs, evidence, or prose. */
export interface PublicSourceFactDispositionAggregate {
  /** V2 public wire: explicitly source-accounting readiness, never content breadth. */
  dispositionReadiness: "complete" | "incomplete";
  /** Safe aggregate only; source/evidence IDs and prose never cross this boundary. */
  positiveCoverage: SourceFactDispositionPositiveCoverage;
  rootStatementCount: number;
  openQuestionCount: number;
  openRootCount: number;
  unmodeledRootCount: number;
  mechanicsCandidateRootCount: number;
  counts: Record<SourceFactDispositionStatus, number>;
}

interface DispositionMarks {
  mechanicsEvidence: Set<string>;
  positiveMechanicsEvidence: Set<string>;
  acceptedBinding: Set<string>;
  explicitlyUnbound: Set<string>;
  draftCandidateOpen: Set<string>;
  reasons: Set<string>;
  questionIds: Set<string>;
  openQuestionIds: Set<string>;
  interpretationIds: Set<string>;
}

interface BindingContext {
  proseNpcBindings: readonly ResolvedProseNpcBinding[];
  itemBindings: readonly ResolvedItemBinding[];
  rewardBindings: readonly ResolvedRewardBinding[];
  sourceFactMechanicBindings?: readonly ResolvedSourceFactMechanicBinding[];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function isRootKind(kind: SourceStatementKind): kind is SourceRootStatementKind {
  return (ROOT_KINDS as readonly string[]).includes(kind);
}

function isSourceFactDispositionRoot(statement: SourceStatement): statement is SourceFactDispositionRoot {
  return isRootKind(statement.kind);
}

/** Marked-item name/body statements are structural children, never a second root fact. */
export function sourceFactDispositionRoots(graph: SourceFactGraph): SourceFactDispositionRoot[] {
  return graph.statements
    .filter(isSourceFactDispositionRoot)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function markFor(marks: Map<string, DispositionMarks>, statementId: string): DispositionMarks | undefined {
  return marks.get(statementId);
}

function markStatementIds(
  marks: Map<string, DispositionMarks>,
  statementIds: readonly string[],
  apply: (mark: DispositionMarks) => void,
): void {
  for (const statementId of statementIds) {
    const mark = markFor(marks, statementId);
    if (mark) apply(mark);
  }
}

/** Only a question's semantic subject may create draft-candidate status. */
function questionCandidateRootIds(graph: SourceFactGraph, question: CompilerQuestion): string[] {
  if (question.kind === "source_fact_disposition") return question.subjectStatementId ? [question.subjectStatementId] : [];
  if (!question.subjectCandidateId) return [];
  if (question.kind === "npc_binding") return question.subjectStatementId ? [question.subjectStatementId] : [];
  const rootKind = question.kind === "scene_role" || question.kind === "connection_topology"
    ? "heading"
    : question.kind === "core_clue" || question.kind === "discovery_method" || question.kind === "item_binding"
      ? "marked_item"
      : question.kind === "reward_binding"
        ? "table_row"
        : undefined;
  if (!rootKind) return [];
  return question.sourceStatementIds.filter((statementId) => graph.statements.find((statement) => statement.id === statementId)?.kind === rootKind);
}

/** Mechanical questions name a semantic root; their broad context is not all mechanics evidence. */
function questionMechanicsRootIds(graph: SourceFactGraph, question: CompilerQuestion): string[] {
  const rootKind = question.kind === "scene_role" || question.kind === "entry_scene" || question.kind === "connection_topology" || question.kind === "ending_rule"
    ? "heading"
    : question.kind === "core_clue" || question.kind === "discovery_method" ? "marked_item" : undefined;
  return rootKind
    ? question.sourceStatementIds.filter((statementId) => graph.statements.find((statement) => statement.id === statementId)?.kind === rootKind)
    : [];
}

function addQuestionMarks(graph: SourceFactGraph, marks: Map<string, DispositionMarks>, queue: CompilerQuestionQueue): void {
  for (const question of queue.questions) {
    // Deferred children are prepared data, not live blockers; source_only
    // resolves them to not_applicable. Only a currently open question is
    // content-pending.
    const unresolved = question.status === "open";
    markStatementIds(marks, question.sourceStatementIds, (mark) => {
      mark.questionIds.add(question.id);
      if (unresolved) {
        mark.openQuestionIds.add(question.id);
        mark.reasons.add("unanswered_question");
      }
    });
    if (unresolved) {
      // Full heading-scope evidence is intentionally broader than the subject
      // of topology/NPC questions. It records support, not a draft candidate
      // for every neighbouring paragraph/list/table root.
      markStatementIds(marks, questionCandidateRootIds(graph, question), (mark) => mark.draftCandidateOpen.add(question.id));
    }
    if (question.status === "answered" && MECHANICS_QUESTION_KINDS.has(question.kind) && question.resolution) {
      const parsed = parseCompilerHintValue(question, question.resolution.value, graph);
      const positive = (parsed.kind === "scene_role" && parsed.role === "playable_scene")
        || (parsed.kind === "connection_topology" && parsed.connections.length > 0)
        || parsed.kind === "discovery_method";
      markStatementIds(marks, questionMechanicsRootIds(graph, question), (mark) => {
        mark.mechanicsEvidence.add(question.id);
        mark.reasons.add("answered_mechanics_question");
        if (positive) mark.positiveMechanicsEvidence.add(question.id);
      });
    }
  }
}

function interpretationMechanicsRootIds(graph: SourceFactGraph, interpretation: FactInterpretationCandidate<MechanicsCandidateSpec>): string[] {
  const kind = interpretation.claim.value?.kind;
  const rootKinds: readonly SourceRootStatementKind[] = kind === "connection_gate" || kind === "ending_rule" || kind === "state_transition"
    ? ["heading"]
    : kind === "discovery_method"
      ? ["marked_item"]
      : kind === "reward_definition"
        ? ["table_row"]
        // Combat numeric rows and source prose can both be actual mechanics
        // evidence, unlike a topology question's merely neighbouring scope.
        : kind === "encounter_definition"
          ? ["paragraph", "marked_item", "table_row"]
          : [];
  return interpretation.sourceStatementIds.filter((statementId) => {
    const statement = graph.statements.find((candidate) => candidate.id === statementId);
    return !!statement && rootKinds.includes(statement.kind as SourceRootStatementKind);
  });
}

function addInterpretationMarks(
  graph: SourceFactGraph,
  marks: Map<string, DispositionMarks>,
  interpretations: readonly FactInterpretationCandidate<MechanicsCandidateSpec>[],
  sourceFactMechanicInterpretationIds: ReadonlySet<string>,
): void {
  for (const interpretation of interpretations) {
    if (interpretation.interpretationStatus !== "accepted" || interpretation.claim.status !== "accepted") continue;
    // Source-fact bindings below mark their exact root statement. Their
    // heading is scope-only and must never become generic transition coverage.
    if (sourceFactMechanicInterpretationIds.has(interpretation.id)) continue;
    markStatementIds(marks, interpretationMechanicsRootIds(graph, interpretation), (mark) => {
      mark.mechanicsEvidence.add(interpretation.id);
      mark.positiveMechanicsEvidence.add(interpretation.id);
      mark.interpretationIds.add(interpretation.id);
      mark.reasons.add("accepted_mechanics_interpretation");
    });
  }
}

function addBindingMarks(
  graph: SourceFactGraph,
  marks: Map<string, DispositionMarks>,
  queue: CompilerQuestionQueue,
  bindings: BindingContext,
): void {
  for (const binding of bindings.proseNpcBindings) {
    const mark = markFor(marks, binding.paragraphStatementId);
    if (!mark) continue;
    mark.acceptedBinding.add(binding.questionId);
    mark.positiveMechanicsEvidence.add(binding.questionId);
    mark.questionIds.add(binding.questionId);
    mark.reasons.add("accepted_npc_binding");
  }
  for (const binding of bindings.itemBindings) {
    const mark = markFor(marks, binding.markedItemStatementId);
    if (!mark) continue;
    mark.acceptedBinding.add(binding.questionId);
    mark.positiveMechanicsEvidence.add(binding.questionId);
    mark.questionIds.add(binding.questionId);
    mark.reasons.add("accepted_item_binding");
  }
  for (const binding of bindings.rewardBindings) {
    const mark = markFor(marks, binding.tableRowStatementId);
    if (!mark) continue;
    mark.questionIds.add(binding.questionId);
    if (binding.declaration === null) {
      mark.explicitlyUnbound.add(binding.questionId);
      mark.reasons.add("explicitly_unbound_reward");
    } else {
      mark.acceptedBinding.add(binding.questionId);
      mark.positiveMechanicsEvidence.add(binding.questionId);
      mark.reasons.add("accepted_reward_binding");
    }
  }
  for (const binding of bindings.sourceFactMechanicBindings ?? []) {
    const mark = markFor(marks, binding.statementId);
    if (!mark) throw new Error(`source fact mechanic root is absent from disposition report: ${binding.questionId}`);
    mark.mechanicsEvidence.add(binding.interpretationId);
    mark.positiveMechanicsEvidence.add(binding.interpretationId);
    mark.interpretationIds.add(binding.interpretationId);
    mark.questionIds.add(binding.questionId);
    mark.reasons.add("accepted_source_fact_mechanic");
  }
  // An explicit empty NPC binding is semantically distinct from leaving the
  // anchor unanswered. It has no runtime binding object, so recover it from
  // the validated answered queue.
  for (const question of queue.questions) {
    if (question.kind !== "npc_binding" || question.status !== "answered" || !question.resolution || !question.subjectStatementId) continue;
    const parsed = parseCompilerHintValue(question, question.resolution.value, graph);
    if (parsed.kind !== "npc_binding" || parsed.presentNpcs.length !== 0) continue;
    const mark = markFor(marks, question.subjectStatementId);
    if (!mark) continue;
    mark.explicitlyUnbound.add(question.id);
    mark.questionIds.add(question.id);
    mark.reasons.add("explicitly_unbound_npc_anchor");
  }
  // Item source-only answers likewise have no runtime binding object. Recover
  // their disposition only from the already validated answered queue so an
  // open item question can never be mistaken for an explicit decision.
  for (const question of queue.questions) {
    if (question.kind !== "item_binding" || question.status !== "answered" || !question.resolution) continue;
    const parsed = parseCompilerHintValue(question, question.resolution.value, graph);
    if (parsed.kind !== "item_binding" || parsed.itemType !== null) continue;
    const rootIds = questionCandidateRootIds(graph, question);
    if (rootIds.length !== 1) throw new Error(`source-only item question lacks one marked-item root: ${question.id}`);
    const mark = markFor(marks, rootIds[0]!);
    if (!mark) throw new Error(`source-only item root is absent from disposition report: ${question.id}`);
    mark.explicitlyUnbound.add(question.id);
    mark.questionIds.add(question.id);
    mark.reasons.add("explicitly_unbound_item");
  }
  // Source-fact answers deliberately do not create interpretations, IR nodes,
  // or runtime projections. A source-only declaration closes the exact root;
  // a mechanics candidate remains a content-readiness gap until a distinct,
  // source-bound mechanical contract is supplied elsewhere.
  for (const question of queue.questions) {
    if (question.kind !== "source_fact_disposition" || question.status !== "answered" || !question.resolution) continue;
    const parsed = parseCompilerHintValue(question, question.resolution.value, graph);
    if (parsed.kind !== "source_fact_disposition") continue;
    const rootIds = questionCandidateRootIds(graph, question);
    if (rootIds.length !== 1 || rootIds[0] !== parsed.statementId) {
      throw new Error(`source fact disposition question lacks one exact root: ${question.id}`);
    }
    const mark = markFor(marks, parsed.statementId);
    if (!mark) throw new Error(`source fact disposition root is absent from disposition report: ${question.id}`);
    mark.questionIds.add(question.id);
    if (parsed.disposition === "source_only") {
      mark.explicitlyUnbound.add(question.id);
      mark.reasons.add("explicitly_unbound_source_fact");
    } else {
      mark.draftCandidateOpen.add(question.id);
      mark.reasons.add("source_fact_mechanics_candidate");
    }
  }
}

/**
 * Primary-status precedence is intentionally deterministic:
 * accepted binding > explicitly unbound > mechanics evidence > open draft
 * candidate > unmodeled.  Lower-priority evidence is retained in reasons and
 * openQuestionIds; precedence may never make content readiness appear complete.
 */
function statusFor(mark: DispositionMarks): SourceFactDispositionStatus {
  if (mark.acceptedBinding.size) return "accepted_binding";
  if (mark.explicitlyUnbound.size) return "explicitly_unbound";
  if (mark.mechanicsEvidence.size) return "mechanics_evidence";
  if (mark.draftCandidateOpen.size) return "draft_candidate_open";
  return "unmodeled";
}

function createReport(
  graph: SourceFactGraph,
  queue: CompilerQuestionQueue,
  interpretations: readonly FactInterpretationCandidate<MechanicsCandidateSpec>[],
  bindings: BindingContext,
): SourceFactDispositionReport {
  validateCompilerQuestionQueue(graph, queue);
  const roots = sourceFactDispositionRoots(graph);
  const marks = new Map(roots.map((statement) => [statement.id, {
    mechanicsEvidence: new Set<string>(),
    positiveMechanicsEvidence: new Set<string>(),
    acceptedBinding: new Set<string>(),
    explicitlyUnbound: new Set<string>(),
    draftCandidateOpen: new Set<string>(),
    reasons: new Set<string>(),
    questionIds: new Set<string>(),
    openQuestionIds: new Set<string>(),
    interpretationIds: new Set<string>(),
  } satisfies DispositionMarks]));
  const sourceFactMechanicInterpretationIds = new Set((bindings.sourceFactMechanicBindings ?? []).map((binding) => binding.interpretationId));
  addQuestionMarks(graph, marks, queue);
  addInterpretationMarks(graph, marks, interpretations, sourceFactMechanicInterpretationIds);
  addBindingMarks(graph, marks, queue, bindings);

  const entries = roots.map((statement) => {
    const mark = marks.get(statement.id)!;
    const status = statusFor(mark);
    if (status === "unmodeled") mark.reasons.add("no_modeled_disposition");
    if (status === "draft_candidate_open") mark.reasons.add("draft_candidate_open");
    return {
      statementId: statement.id,
      kind: statement.kind,
      evidenceRefId: statement.evidenceRefId,
      status,
      reasons: uniqueSorted(mark.reasons),
      questionIds: uniqueSorted(mark.questionIds),
      openQuestionIds: uniqueSorted(mark.openQuestionIds),
      interpretationIds: uniqueSorted(mark.interpretationIds),
      positiveCoverage: mark.positiveMechanicsEvidence.size > 0,
      hasAcceptedBinding: mark.acceptedBinding.size > 0,
      hasMechanicsEvidence: mark.mechanicsEvidence.size > 0,
    } satisfies SourceFactDispositionEntry;
  });
  const counts = Object.fromEntries(DISPOSITION_STATUSES.map((status) => [status, entries.filter((entry) => entry.status === status).length])) as Record<SourceFactDispositionStatus, number>;
  const openQuestionIds = uniqueSorted(entries.flatMap((entry) => entry.openQuestionIds));
  const unmodeledStatementIds = entries.filter((entry) => entry.status === "unmodeled").map((entry) => entry.statementId).sort();
  const mechanicsCandidateStatementIds = entries
    .filter((entry) => entry.reasons.includes("source_fact_mechanics_candidate") && !entry.reasons.includes("accepted_source_fact_mechanic"))
    .map((entry) => entry.statementId)
    .sort();
  const sourceOnlyDecisionRootCount = entries.filter((entry) => entry.reasons.includes("explicitly_unbound_source_fact")).length;
  const sourceOnlyOnlyRootCount = entries.filter((entry) => entry.status === "explicitly_unbound" && entry.reasons.includes("explicitly_unbound_source_fact")).length;
  const acceptedBindingRootCount = entries.filter((entry) => entry.hasAcceptedBinding).length;
  const mechanicsEvidenceRootCount = entries.filter((entry) => entry.hasMechanicsEvidence && entry.positiveCoverage).length;
  const positiveRootCount = entries.filter((entry) => entry.positiveCoverage).length;
  const report: SourceFactDispositionReport = {
    schemaVersion: SOURCE_FACT_DISPOSITION_REPORT_SCHEMA_VERSION,
    entries,
    counts,
    contentReadiness: {
      status: openQuestionIds.length || unmodeledStatementIds.length || mechanicsCandidateStatementIds.length ? "incomplete" : "complete",
      rootStatementCount: roots.length,
      openQuestionCount: openQuestionIds.length,
      openRootCount: entries.filter((entry) => entry.openQuestionIds.length > 0).length,
      openQuestionIds,
      unmodeledStatementIds,
      mechanicsCandidateStatementIds,
    },
    positiveCoverage: {
      positiveRootCount,
      uncoveredRootCount: roots.length - positiveRootCount,
      sourceOnlyDecisionRootCount,
      sourceOnlyOnlyRootCount,
      acceptedBindingRootCount,
      mechanicsEvidenceRootCount,
    },
  };
  validateSourceFactDispositionReport(graph, report);
  return report;
}

/** Prepared accounting includes deterministic draft interpretations but no caller answers. */
export function buildPreparedSourceFactDispositionReport(
  graph: SourceFactGraph,
  draft: DraftModuleStructure,
  queue: CompilerQuestionQueue,
): SourceFactDispositionReport {
  return createReport(graph, queue, draft.interpretations, { proseNpcBindings: [], itemBindings: [], rewardBindings: [], sourceFactMechanicBindings: [] });
}

/** Resolved accounting derives from the effective answered queue and accepted runtime bindings. */
export function buildResolvedSourceFactDispositionReport(
  graph: SourceFactGraph,
  _draft: DraftModuleStructure,
  resolvedQueue: CompilerQuestionQueue,
  acceptedInterpretations: readonly FactInterpretationCandidate<MechanicsCandidateSpec>[],
  bindings: BindingContext,
): SourceFactDispositionReport {
  return createReport(graph, resolvedQueue, acceptedInterpretations, bindings);
}

export function publicSourceFactDispositionAggregate(report: SourceFactDispositionReport): PublicSourceFactDispositionAggregate {
  validateDispositionReportShape(report);
  return {
    dispositionReadiness: report.contentReadiness.status,
    positiveCoverage: { ...report.positiveCoverage },
    rootStatementCount: report.contentReadiness.rootStatementCount,
    openQuestionCount: report.contentReadiness.openQuestionCount,
    openRootCount: report.contentReadiness.openRootCount,
    unmodeledRootCount: report.contentReadiness.unmodeledStatementIds.length,
    mechanicsCandidateRootCount: report.contentReadiness.mechanicsCandidateStatementIds.length,
    counts: { ...report.counts },
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSortedUnique(values: unknown, label: string): asserts values is string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string") || !sameStrings(values, uniqueSorted(values))) {
    throw new Error(`invalid source fact disposition ${label}`);
  }
}

function validateDispositionReportShape(report: SourceFactDispositionReport): void {
  if (!report || report.schemaVersion !== SOURCE_FACT_DISPOSITION_REPORT_SCHEMA_VERSION || !Array.isArray(report.entries) || !report.counts || !report.contentReadiness || !report.positiveCoverage) {
    throw new Error("invalid source fact disposition report schema");
  }
  for (const status of DISPOSITION_STATUSES) if (!Number.isSafeInteger(report.counts[status]) || report.counts[status] < 0) throw new Error(`invalid source fact disposition count: ${status}`);
  const readiness = report.contentReadiness;
  if (readiness.status !== "complete" && readiness.status !== "incomplete") throw new Error("invalid source fact disposition readiness");
  for (const key of ["rootStatementCount", "openQuestionCount", "openRootCount"] as const) {
    if (!Number.isSafeInteger(readiness[key]) || readiness[key] < 0) throw new Error(`invalid source fact disposition readiness ${key}`);
  }
  assertSortedUnique(readiness.openQuestionIds, "openQuestionIds");
  assertSortedUnique(readiness.unmodeledStatementIds, "unmodeledStatementIds");
  assertSortedUnique(readiness.mechanicsCandidateStatementIds, "mechanicsCandidateStatementIds");
  const positive = report.positiveCoverage;
  for (const key of ["positiveRootCount", "uncoveredRootCount", "sourceOnlyDecisionRootCount", "sourceOnlyOnlyRootCount", "acceptedBindingRootCount", "mechanicsEvidenceRootCount"] as const) {
    if (!Number.isSafeInteger(positive[key]) || positive[key] < 0) throw new Error(`invalid source fact disposition positive coverage ${key}`);
  }
  for (const entry of report.entries) {
    if (!entry || typeof entry.statementId !== "string" || !isRootKind(entry.kind) || typeof entry.evidenceRefId !== "string" || typeof entry.positiveCoverage !== "boolean" || typeof entry.hasAcceptedBinding !== "boolean" || typeof entry.hasMechanicsEvidence !== "boolean" || !(DISPOSITION_STATUSES as readonly string[]).includes(entry.status)) {
      throw new Error("invalid source fact disposition entry");
    }
    assertSortedUnique(entry.reasons, "entry reasons");
    assertSortedUnique(entry.questionIds, "entry questionIds");
    assertSortedUnique(entry.openQuestionIds, "entry openQuestionIds");
    assertSortedUnique(entry.interpretationIds, "entry interpretationIds");
  }
}

/** Validate one exact disposition entry for every source whole-statement. */
export function validateSourceFactDispositionReport(graph: SourceFactGraph, report: SourceFactDispositionReport): void {
  validateDispositionReportShape(report);
  const roots = sourceFactDispositionRoots(graph);
  if (report.entries.length !== roots.length || new Set(report.entries.map((entry) => entry.statementId)).size !== roots.length) {
    throw new Error("source fact disposition does not account for every root statement exactly once");
  }
  const entries = new Map(report.entries.map((entry) => [entry.statementId, entry]));
  for (const statement of roots) {
    const entry = entries.get(statement.id);
    if (!entry || entry.kind !== statement.kind || entry.evidenceRefId !== statement.evidenceRefId) {
      throw new Error(`source fact disposition root identity mismatch: ${statement.id}`);
    }
  }
  const counts = Object.fromEntries(DISPOSITION_STATUSES.map((status) => [status, report.entries.filter((entry) => entry.status === status).length])) as Record<SourceFactDispositionStatus, number>;
  for (const status of DISPOSITION_STATUSES) if (report.counts[status] !== counts[status]) throw new Error(`source fact disposition count mismatch: ${status}`);
  const openQuestionIds = uniqueSorted(report.entries.flatMap((entry) => entry.openQuestionIds));
  const unmodeledStatementIds = report.entries.filter((entry) => entry.status === "unmodeled").map((entry) => entry.statementId).sort();
  const mechanicsCandidateStatementIds = report.entries
    .filter((entry) => entry.reasons.includes("source_fact_mechanics_candidate") && !entry.reasons.includes("accepted_source_fact_mechanic"))
    .map((entry) => entry.statementId)
    .sort();
  const sourceOnlyDecisionRootCount = report.entries.filter((entry) => entry.reasons.includes("explicitly_unbound_source_fact")).length;
  const sourceOnlyOnlyRootCount = report.entries.filter((entry) => entry.status === "explicitly_unbound" && entry.reasons.includes("explicitly_unbound_source_fact")).length;
  const acceptedBindingRootCount = report.entries.filter((entry) => entry.hasAcceptedBinding).length;
  const mechanicsEvidenceRootCount = report.entries.filter((entry) => entry.hasMechanicsEvidence && entry.positiveCoverage).length;
  const positiveRootCount = report.entries.filter((entry) => entry.positiveCoverage).length;
  const readiness = report.contentReadiness;
  if (readiness.rootStatementCount !== roots.length
    || readiness.openQuestionCount !== openQuestionIds.length
    || readiness.openRootCount !== report.entries.filter((entry) => entry.openQuestionIds.length > 0).length
    || !sameStrings(readiness.openQuestionIds, openQuestionIds)
    || !sameStrings(readiness.unmodeledStatementIds, unmodeledStatementIds)
    || !sameStrings(readiness.mechanicsCandidateStatementIds, mechanicsCandidateStatementIds)
    || readiness.status !== (openQuestionIds.length || unmodeledStatementIds.length || mechanicsCandidateStatementIds.length ? "incomplete" : "complete")) {
    throw new Error("source fact disposition readiness mismatch");
  }
  const positive = report.positiveCoverage;
  if (positive.positiveRootCount !== positiveRootCount
    || positive.uncoveredRootCount !== roots.length - positiveRootCount
    || positive.sourceOnlyDecisionRootCount !== sourceOnlyDecisionRootCount
    || positive.sourceOnlyOnlyRootCount !== sourceOnlyOnlyRootCount
    || positive.acceptedBindingRootCount !== acceptedBindingRootCount
    || positive.mechanicsEvidenceRootCount !== mechanicsEvidenceRootCount) {
    throw new Error("source fact disposition positive coverage mismatch");
  }
}
