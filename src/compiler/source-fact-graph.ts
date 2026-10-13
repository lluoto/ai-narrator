import { type CandidateStatus, type ClaimCandidate } from "./source-authority";
import { sha256, validateEvidenceRef, type DocumentBlock, type DocumentBlockKind, type DocumentIR, type EvidenceRef } from "../ingest/document-ir";

/** Adds source-exact table_row statements and their structural relations. */
export const SOURCE_FACT_GRAPH_SCHEMA_VERSION = "1.1.0";

export type SourceStatementKind = DocumentBlockKind | "marked_item_name" | "marked_item_body";
export type SourceRelationKind = "contains" | "follows" | "heading_scopes" | "marked_item_name" | "marked_item_body";
export type InterpretationStatus = "candidate" | "accepted" | "rejected" | "deferred";

/** A verbatim, evidence-bound source statement; never an interpreted game fact. */
export interface SourceStatement {
  id: string;
  kind: SourceStatementKind;
  text: string;
  evidence: EvidenceRef;
  evidenceRefId: string;
  parentStatementId?: string;
  sourceStatus: "source_exact";
  semanticStatus: "uninterpreted";
}

/** Deterministic document structure, not a gameplay or semantic relationship. */
export interface SourceRelation {
  id: string;
  kind: SourceRelationKind;
  from: string;
  to: string;
  evidence: EvidenceRef;
}

/** A later semantic reading of statements. The builder never creates accepted entries. */
export interface FactInterpretationCandidate<T = unknown> {
  id: string;
  sourceStatementIds: string[];
  claim: ClaimCandidate<T>;
  interpretationStatus: InterpretationStatus;
  review?: FactInterpretationReview;
}

export interface SourceFactGraph {
  schemaVersion: typeof SOURCE_FACT_GRAPH_SCHEMA_VERSION;
  /** Retains pages so every statement can be revalidated against exact text. */
  documentIdentity: DocumentIR;
  statements: SourceStatement[];
  relations: SourceRelation[];
  interpretations: FactInterpretationCandidate[];
}

export interface FactInterpretationReview {
  interpretationId: string;
  decision: "accept" | "reject" | "defer";
  reason: string;
  reviewerKind?: "deterministic_rule" | "human" | "approved_policy";
  reviewEvidenceStatementIds?: string[];
  reviewerId?: string;
  policyId?: string;
}

export function sourceStatementEvidenceRefId(statementId: string): string {
  return `statement:${statementId}`;
}

function statementId(block: DocumentBlock, role: "whole" | "name" | "body" = "whole"): string {
  return `${block.id}:statement:${role}`;
}

function relationId(kind: SourceRelationKind, from: string, to: string): string {
  return `relation_${sha256(`${kind}|${from}|${to}`).slice(0, 24)}`;
}

function exactText(evidence: EvidenceRef): string {
  return evidence.spans.map((span) => span.exactText).join("");
}

function mergedEvidence(...refs: EvidenceRef[]): EvidenceRef {
  const spans = refs.flatMap((ref) => ref.spans);
  const precision = spans.length === 0
    ? "page_text"
    : spans.every((span) => span.documentHash === null) ? "synthetic_fixture" : "exact_text";
  return { spans, precision };
}

function pushRelation(relations: SourceRelation[], kind: SourceRelationKind, from: string, to: string, evidence: EvidenceRef): void {
  relations.push({ id: relationId(kind, from, to), kind, from, to, evidence });
}

/**
 * Build only source-exact statements and deterministic document relations.
 * Semantic interpretation remains empty until a later explicit review workflow.
 */
export function buildSourceFactGraph(document: DocumentIR, blocks: DocumentBlock[]): SourceFactGraph {
  const statements: SourceStatement[] = [];
  const relations: SourceRelation[] = [];
  const blockStatements = new Map<string, string>();
  const seenBlocks = new Set<string>();

  for (const block of blocks) {
    if (seenBlocks.has(block.id)) throw new Error(`duplicate DocumentBlock id: ${block.id}`);
    seenBlocks.add(block.id);
    validateEvidenceRef(block.evidence, document);
    if (block.nameEvidence) validateEvidenceRef(block.nameEvidence, document);
    if (block.bodyEvidence) validateEvidenceRef(block.bodyEvidence, document);
    const id = statementId(block);
    statements.push({
      id,
      kind: block.kind,
      text: block.text,
      evidence: block.evidence,
      evidenceRefId: sourceStatementEvidenceRefId(id),
      sourceStatus: "source_exact",
      semanticStatus: "uninterpreted",
    });
    blockStatements.set(block.id, id);
  }

  const statementsById = new Map(statements.map((statement) => [statement.id, statement]));
  let previous: SourceStatement | undefined;
  for (const block of blocks) {
    const wholeId = blockStatements.get(block.id)!;
    const whole = statementsById.get(wholeId)!;
    if (block.parentSectionId) {
      const parentId = blockStatements.get(block.parentSectionId);
      if (!parentId) throw new Error(`DocumentBlock parent missing: ${block.parentSectionId}`);
      whole.parentStatementId = parentId;
      pushRelation(relations, "heading_scopes", parentId, wholeId, block.evidence);
    }
    if (previous) pushRelation(relations, "follows", previous.id, wholeId, mergedEvidence(previous.evidence, whole.evidence));
    previous = whole;

    if (block.kind !== "marked_item") continue;
    if (block.nameEvidence) {
      const id = statementId(block, "name");
      statements.push({
        id,
        kind: "marked_item_name",
        text: exactText(block.nameEvidence),
        evidence: block.nameEvidence,
        evidenceRefId: sourceStatementEvidenceRefId(id),
        parentStatementId: wholeId,
        sourceStatus: "source_exact",
        semanticStatus: "uninterpreted",
      });
      pushRelation(relations, "contains", wholeId, id, block.nameEvidence);
      pushRelation(relations, "marked_item_name", wholeId, id, block.nameEvidence);
    }
    if (block.bodyEvidence) {
      const id = statementId(block, "body");
      statements.push({
        id,
        kind: "marked_item_body",
        text: exactText(block.bodyEvidence),
        evidence: block.bodyEvidence,
        evidenceRefId: sourceStatementEvidenceRefId(id),
        parentStatementId: wholeId,
        sourceStatus: "source_exact",
        semanticStatus: "uninterpreted",
      });
      pushRelation(relations, "contains", wholeId, id, block.bodyEvidence);
      pushRelation(relations, "marked_item_body", wholeId, id, block.bodyEvidence);
    }
  }

  const graph: SourceFactGraph = {
    schemaVersion: SOURCE_FACT_GRAPH_SCHEMA_VERSION,
    documentIdentity: document,
    statements,
    relations,
    interpretations: [],
  };
  validateSourceFactGraph(graph);
  return graph;
}

export function validateSourceFactGraph(graph: SourceFactGraph): void {
  if (graph.schemaVersion !== SOURCE_FACT_GRAPH_SCHEMA_VERSION) throw new Error(`unsupported graph schema: ${graph.schemaVersion}`);
  const statements = new Map<string, SourceStatement>();
  for (const statement of graph.statements) {
    if (statements.has(statement.id)) throw new Error(`duplicate SourceStatement id: ${statement.id}`);
    if (statement.sourceStatus !== "source_exact" || statement.semanticStatus !== "uninterpreted") {
      throw new Error(`SourceStatement is not source_exact/uninterpreted: ${statement.id}`);
    }
    validateEvidenceRef(statement.evidence, graph.documentIdentity);
    statements.set(statement.id, statement);
  }
  for (const statement of graph.statements) {
    if (statement.parentStatementId && !statements.has(statement.parentStatementId)) {
      throw new Error(`SourceStatement parent missing: ${statement.parentStatementId}`);
    }
  }
  const relationIds = new Set<string>();
  for (const relation of graph.relations) {
    if (relationIds.has(relation.id)) throw new Error(`duplicate SourceRelation id: ${relation.id}`);
    relationIds.add(relation.id);
    if (!statements.has(relation.from) || !statements.has(relation.to)) throw new Error(`SourceRelation endpoint missing: ${relation.id}`);
    validateEvidenceRef(relation.evidence, graph.documentIdentity);
  }
  const interpretationIds = new Set<string>();
  for (const interpretation of graph.interpretations) {
    if (interpretationIds.has(interpretation.id)) throw new Error(`duplicate interpretation id: ${interpretation.id}`);
    interpretationIds.add(interpretation.id);
    if (interpretation.sourceStatementIds.length === 0) throw new Error(`interpretation has no source statements: ${interpretation.id}`);
    for (const statementId of interpretation.sourceStatementIds) {
      const statement = statements.get(statementId);
      if (!statement) throw new Error(`interpretation source statement missing: ${statementId}`);
      if (!interpretation.claim.evidenceRefs.includes(statement.evidenceRefId)) {
        throw new Error(`interpretation evidence does not reference statement: ${statementId}`);
      }
    }
    if (interpretation.interpretationStatus === "accepted" && interpretation.claim.status !== "accepted") {
      throw new Error(`accepted interpretation has non-accepted claim: ${interpretation.id}`);
    }
    if (interpretation.interpretationStatus === "accepted") {
      if (!interpretation.review) throw new Error(`accepted interpretation lacks review audit: ${interpretation.id}`);
      validateReviewAudit(interpretation, interpretation.review);
      if (interpretation.review.decision !== "accept") throw new Error(`accepted interpretation has non-accept review: ${interpretation.id}`);
    } else if (interpretation.review) {
      validateReviewAudit(interpretation, interpretation.review);
    }
  }
}

function validateReviewAudit(
  interpretation: FactInterpretationCandidate,
  review: FactInterpretationReview,
): void {
  if (review.interpretationId !== interpretation.id) throw new Error(`review interpretation mismatch: ${review.interpretationId}`);
  if (!review.reason.trim()) throw new Error(`review reason is required: ${review.interpretationId}`);
  const evidenceIds = review.reviewEvidenceStatementIds;
  if (!evidenceIds || evidenceIds.length === 0) throw new Error(`review evidence is required: ${review.interpretationId}`);
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error(`review evidence duplicates a statement: ${review.interpretationId}`);
  for (const statementId of evidenceIds) {
    if (!interpretation.sourceStatementIds.includes(statementId)) {
      throw new Error(`review evidence is outside interpretation sources: ${review.interpretationId}`);
    }
  }
  if (review.decision === "accept" && !review.reviewerKind) throw new Error(`accept review lacks reviewerKind: ${review.interpretationId}`);
  if ((review.reviewerKind === "deterministic_rule" || review.reviewerKind === "approved_policy") && !review.policyId?.trim()) {
    throw new Error(`review policyId is required: ${review.interpretationId}`);
  }
}

/** Apply deterministic accept/reject/defer reviews; conflicting review decisions fail closed. */
export function applyFactInterpretationReviews(
  graph: SourceFactGraph,
  reviews: FactInterpretationReview[],
): SourceFactGraph {
  validateSourceFactGraph(graph);
  const decisions = new Map<string, FactInterpretationReview>();
  for (const review of reviews) {
    const previous = decisions.get(review.interpretationId);
    if (previous && previous.decision !== review.decision) {
      throw new Error(`conflicting interpretation reviews: ${review.interpretationId}`);
    }
    decisions.set(review.interpretationId, review);
  }
  const known = new Set(graph.interpretations.map((interpretation) => interpretation.id));
  for (const review of reviews) if (!known.has(review.interpretationId)) throw new Error(`review interpretation missing: ${review.interpretationId}`);
  for (const review of reviews) {
    const interpretation = graph.interpretations.find((candidate) => candidate.id === review.interpretationId)!;
    validateReviewAudit(interpretation, review);
  }

  const interpretations = graph.interpretations.map((interpretation) => {
    const review = decisions.get(interpretation.id);
    if (!review) return { ...interpretation, sourceStatementIds: [...interpretation.sourceStatementIds], claim: { ...interpretation.claim, evidenceRefs: [...interpretation.claim.evidenceRefs], scope: { ...interpretation.claim.scope } } };
    const interpretationStatus: InterpretationStatus = review.decision === "accept" ? "accepted" : review.decision === "reject" ? "rejected" : "deferred";
    const claimStatus: CandidateStatus = review.decision === "accept" ? "accepted" : review.decision === "reject" ? "rejected" : "candidate";
    return {
      ...interpretation,
      sourceStatementIds: [...interpretation.sourceStatementIds],
      interpretationStatus,
      review: { ...review, reviewEvidenceStatementIds: [...review.reviewEvidenceStatementIds!] },
      claim: { ...interpretation.claim, evidenceRefs: [...interpretation.claim.evidenceRefs], scope: { ...interpretation.claim.scope }, status: claimStatus, reason: `${interpretation.claim.reason}; review: ${review.reason}` },
    };
  });
  const reviewed = { ...graph, interpretations };
  validateSourceFactGraph(reviewed);
  return reviewed;
}
