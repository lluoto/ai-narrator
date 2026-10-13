import { evidenceSpan, sha256, validateEvidenceRef, type EvidenceRef } from "../ingest/document-ir";
import { buildCompilerQuestionQueue } from "./compiler-question-queue";
import { compileMechanics, sourceFactGraphIdentity, type CheckSpec, type MechanicsCandidateSpec, type MechanicsIR } from "./mechanics-ir";
import { isEligibleRewardSourceRow } from "./reward-candidate-eligibility";
import { validateSourceFactGraph, type FactInterpretationCandidate, type SourceFactGraph, type SourceStatement } from "./source-fact-graph";

export const DRAFT_MODULE_STRUCTURE_SCHEMA_VERSION = "1.5.0";
export const MARKED_ITEM_OBSERVATION_POLICY_ID = "marked-item-observation-v1";

export interface DraftSceneCandidate {
  id: string;
  headingStatementId: string;
  displayName: string;
  evidence: EvidenceRef;
  status: "candidate";
}

export interface DraftClueCandidate {
  id: string;
  markedItemStatementId: string;
  nameStatementId?: string;
  bodyStatementId: string;
  sceneCandidateId: string;
  displayName: string;
  importance: "unknown";
  evidence: EvidenceRef;
  status: "candidate";
}

/**
 * A mechanically neutral, source-exact sentence-like body unit.  It is not a
 * SourceStatement and does not assert a game fact: it is only the finite,
 * independently verifiable review domain for a marked clue's visible shell
 * and gated findings.  Atomisation is deliberately structural; every atom
 * owns one exact span, and if the body cannot be rebuilt from that closed
 * partition we create no atoms and later resolution remains fail-closed
 * rather than falling back to the whole body.
 */
export interface DraftClueFactAtom {
  id: string;
  clueCandidateId: string;
  bodyStatementId: string;
  quote: string;
  evidence: EvidenceRef;
  status: "candidate";
}

/** A source-exact root atom for a prose-fact review, never a runtime fact by itself. */
export interface DraftSourceFactAtom {
  id: string;
  statementId: string;
  quote: string;
  evidence: EvidenceRef;
  status: "candidate";
}

/**
 * A deliberately tiny server-derived candidate: one unambiguous successful
 * check sentence, one exact source atom, and a compiler-owned check shape.
 * Reviewers may select its ID but can never author its clue, check, location,
 * target, success effect, or quote.
 */
export interface DraftProseFactFindingCandidate {
  id: string;
  statementId: string;
  atomId: string;
  quote: string;
  check: CheckSpec;
  status: "candidate";
}

/**
 * A potential runtime item anchored to one complete marked-item source unit.
 * Its stable identity is deliberately distinct from the companion clue
 * candidate: reviewing a clue never manufactures an item symbol.
 */
export interface DraftItemCandidate {
  id: string;
  markedItemStatementId: string;
  nameStatementId: string;
  bodyStatementId: string;
  sceneCandidateId: string;
  displayName: string;
  evidence: EvidenceRef;
  status: "candidate";
}

/**
 * A structural table row under an explicit heading.  Its row is evidence, not
 * an inferred reward: the queue must still accept an explicit declaration.
 */
export interface DraftRewardCandidate {
  id: string;
  tableRowStatementId: string;
  headingStatementId: string;
  evidence: EvidenceRef;
  status: "candidate";
}

/**
 * A source-exact ordinary paragraph which can be explicitly reviewed for
 * static narrative NPC presence. This is deliberately not a MechanicsIR
 * symbol or an inferred entity: it only fixes the evidence and scene domain
 * for a later binding decision.
 */
export interface DraftProseNpcAnchor {
  id: string;
  paragraphStatementId: string;
  headingStatementId: string;
  sceneCandidateId: string;
  evidence: EvidenceRef;
  status: "candidate";
}

export interface DraftReadinessReport {
  status: "draft_only" | "mechanically_closed";
  blockingCodes: string[];
  unresolvedStatementIds: string[];
  generatedMechanicIds: string[];
  questionQueueHash: string;
  openQuestionIds: string[];
  publishBlockingQuestionIds: string[];
}

export interface DraftModuleStructure {
  schemaVersion: typeof DRAFT_MODULE_STRUCTURE_SCHEMA_VERSION;
  moduleId: string;
  documentHash: string | null;
  sourceGraphIdentity: string;
  sceneCandidates: DraftSceneCandidate[];
  clueCandidates: DraftClueCandidate[];
  clueFactAtoms: DraftClueFactAtom[];
  sourceFactAtoms: DraftSourceFactAtom[];
  proseFactFindingCandidates: DraftProseFactFindingCandidate[];
  itemCandidates: DraftItemCandidate[];
  rewardCandidates: DraftRewardCandidate[];
  proseNpcAnchors: DraftProseNpcAnchor[];
  interpretations: FactInterpretationCandidate<MechanicsCandidateSpec>[];
  mechanicsIR?: MechanicsIR;
  readiness: DraftReadinessReport;
}

export interface DeterministicTemplateCompilationInput {
  moduleId: string;
}

function documentIdentity(graph: SourceFactGraph): string {
  return graph.documentIdentity.documentHash ?? `synthetic:${graph.documentIdentity.sourceDescriptor ?? "unspecified"}`;
}

function evidenceLocations(evidence: EvidenceRef): string {
  return evidence.spans.map((span) => `${span.pageNumber}:${span.rawStart}:${span.rawEnd}`).join("|");
}

function draftId(graph: SourceFactGraph, evidence: EvidenceRef, role: "scene" | "clue" | "item" | "mechanic" | "interpretation" | "prose_npc" | "reward"): string {
  return `draft_${role}_${sha256(`${documentIdentity(graph)}|${role}|${evidenceLocations(evidence)}`).slice(0, 24)}`;
}

function clueFactAtomId(graph: SourceFactGraph, clueId: string, bodyStatementId: string, start: number, end: number): string {
  return `draft_clue_fact_${sha256(`${documentIdentity(graph)}|clue_fact|${clueId}|${bodyStatementId}|${start}|${end}`).slice(0, 24)}`;
}

export function deriveSourceFactAtomId(graph: SourceFactGraph, statementId: string, start: number, end: number): string {
  return `draft_source_fact_${sha256(`${documentIdentity(graph)}|source_fact|${statementId}|${start}|${end}`).slice(0, 24)}`;
}

export function deriveProseFactFindingCandidateId(graph: SourceFactGraph, statementId: string, atomId: string): string {
  return `draft_prose_finding_${sha256(`${documentIdentity(graph)}|prose_finding|${statementId}|${atomId}`).slice(0, 24)}`;
}

/**
 * Splitting at an actual source punctuation boundary is intentionally a
 * structural operation, not an attempt to determine what a sentence means.
 * Whitespace is a separator, never an unreviewed fact atom.  Every non-space
 * code unit must be owned by exactly one returned range.
 */
function sourceExactBodyRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  const nonWhitespace = /\S/;
  const closingBracket = new Map<string, string>([["(", ")"], ["[", "]"], ["（", "）"], ["【", "】"]]);
  const bracketRange = (start: number): { start: number; end: number } | undefined => {
    const close = closingBracket.get(text[start]!);
    if (!close) return undefined;
    const stack = [close];
    for (let index = start + 1; index < text.length; index++) {
      const nested = closingBracket.get(text[index]!);
      if (nested) { stack.push(nested); continue; }
      if (text[index] !== stack[stack.length - 1]) continue;
      stack.pop();
      if (!stack.length) return { start, end: index + 1 };
    }
    return undefined;
  };
  while (cursor < text.length) {
    const rest = text.slice(cursor);
    const first = rest.search(nonWhitespace);
    if (first < 0) break;
    const start = cursor + first;
    let end = text.length;
    for (let index = start; index < text.length; index++) {
      if (closingBracket.has(text[index]!)) {
        if (index === start) {
          const bracket = bracketRange(start);
          if (!bracket) return [];
          end = bracket.end;
          // A bracketed clause may be followed by its sentence terminator.
          // Keep that terminator with the bracket atom so it cannot become a
          // meaningless one-character partition slot.
          while (end < text.length && "。！？!?.".includes(text[end]!)) end++;
        } else end = index;
        break;
      }
      if (!"。！？!?.".includes(text[index]!)) continue;
      end = index + 1;
      while (end < text.length && "。！？!?.".includes(text[end]!)) end++;
      break;
    }
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    if (end <= start) return [];
    ranges.push({ start, end });
    cursor = Math.max(end, start + 1);
  }
  const reconstructed = ranges.map((range) => text.slice(range.start, range.end)).join("").replace(/\s/g, "");
  if (!reconstructed || reconstructed !== text.replace(/\s/g, "")) return [];
  return ranges;
}

/**
 * A marked body may continue across PDF pages.  A review atom still needs one
 * inspectable raw envelope, so split only a punctuation-derived body range at
 * changes of source page—not at every line fragment.  Empty whitespace-only
 * intersections are deliberately omitted; reconstruction stays exact modulo
 * source whitespace.
 */
function sourcePageBoundedBodyRanges(
  text: string,
  sourcePieces: readonly EvidenceRef["spans"][number][],
): Array<{ start: number; end: number }> {
  const semanticRanges = sourceExactBodyRanges(text);
  if (!semanticRanges.length || !sourcePieces.length) return [];

  const pageRanges: Array<{ start: number; end: number; pageNumber: number; documentHash: string | null }> = [];
  let offset = 0;
  for (const piece of sourcePieces) {
    const start = offset;
    offset += piece.exactText.length;
    const previous = pageRanges.at(-1);
    if (previous && previous.pageNumber === piece.pageNumber && previous.documentHash === piece.documentHash) {
      previous.end = offset;
    } else {
      pageRanges.push({ start, end: offset, pageNumber: piece.pageNumber, documentHash: piece.documentHash });
    }
  }
  if (offset !== text.length) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const semanticRange of semanticRanges) {
    for (const pageRange of pageRanges) {
      const start = Math.max(semanticRange.start, pageRange.start);
      const end = Math.min(semanticRange.end, pageRange.end);
      if (start >= end || !/\S/.test(text.slice(start, end))) continue;
      ranges.push({ start, end });
    }
  }
  const reconstructed = ranges.map((range) => text.slice(range.start, range.end)).join("").replace(/\s/g, "");
  if (reconstructed !== text.replace(/\s/g, "")) return [];
  return ranges;
}

function exactStatementAtomParts(graph: SourceFactGraph, statement: SourceStatement): Array<{ start: number; end: number; quote: string; evidence: EvidenceRef }> {
  // A PDF paragraph may be represented by multiple exact line fragments even
  // though it is one normalized SourceStatement.  A prose atom can span such
  // fragments only when they stay on one source page and each omitted raw gap
  // is whitespace (normally the PDF line break).  The returned evidence is a
  // single raw envelope, so its quote remains byte-for-byte inspectable.
  const sourcePieces = statement.evidence.spans;
  const firstSpan = sourcePieces[0];
  const lastSpan = sourcePieces.at(-1);
  if (!firstSpan || !lastSpan
    || sourcePieces.some((span) => span.pageNumber !== firstSpan.pageNumber || span.documentHash !== firstSpan.documentHash)
    || sourcePieces.map((span) => span.exactText).join("").replace(/\s/g, "") !== statement.text.replace(/\s/g, "")) return [];
  const page = graph.documentIdentity.pages.find((candidate) => candidate.pageNumber === firstSpan.pageNumber);
  if (!page) return [];
  for (let index = 1; index < sourcePieces.length; index++) {
    const previous = sourcePieces[index - 1]!;
    const current = sourcePieces[index]!;
    if (current.rawStart < previous.rawEnd || !/^\s*$/.test(page.rawText.slice(previous.rawEnd, current.rawStart))) return [];
  }
  const normalizedLength = (text: string): number => text.replace(/\s/g, "").length;
  const rawStartAtNormalizedOffset = (text: string, normalizedOffset: number): number | undefined => {
    let seen = 0;
    for (let index = 0; index < text.length; index++) {
      if (/\s/.test(text[index]!)) continue;
      if (seen === normalizedOffset) return index;
      seen++;
    }
    return undefined;
  };
  const rawEndAtNormalizedOffset = (text: string, normalizedOffset: number): number | undefined => {
    let seen = 0;
    for (let index = 0; index < text.length; index++) {
      if (/\s/.test(text[index]!)) continue;
      seen++;
      if (seen === normalizedOffset) return index + 1;
    }
    return undefined;
  };
  const offsets: Array<{ start: number; end: number; spanIndex: number }> = [];
  let offset = 0;
  for (const [spanIndex, span] of sourcePieces.entries()) {
    const length = normalizedLength(span.exactText);
    if (!length) return [];
    offsets.push({ start: offset, end: offset + length, spanIndex });
    offset += length;
  }
  const atomEvidence = (range: { start: number; end: number }): EvidenceRef | undefined => {
    const normalizedStart = normalizedLength(statement.text.slice(0, range.start));
    const normalizedEnd = normalizedLength(statement.text.slice(0, range.end));
    const first = offsets.find((piece) => normalizedStart >= piece.start && normalizedStart < piece.end);
    const last = [...offsets].reverse().find((piece) => normalizedEnd > piece.start && normalizedEnd <= piece.end);
    if (!first || !last) return undefined;
    const firstText = sourcePieces[first.spanIndex]!.exactText;
    const lastText = sourcePieces[last.spanIndex]!.exactText;
    const firstOffset = rawStartAtNormalizedOffset(firstText, normalizedStart - first.start);
    const lastOffset = rawEndAtNormalizedOffset(lastText, normalizedEnd - last.start);
    if (firstOffset === undefined || lastOffset === undefined) return undefined;
    const rawStart = sourcePieces[first.spanIndex]!.rawStart + firstOffset;
    const rawEnd = sourcePieces[last.spanIndex]!.rawStart + lastOffset;
    if (rawEnd < rawStart) return undefined;
    const rawText = page.rawText.slice(rawStart, rawEnd);
    if (rawText.replace(/\s/g, "") !== statement.text.slice(range.start, range.end).replace(/\s/g, "")) return undefined;
    const evidence: EvidenceRef = { precision: statement.evidence.precision, spans: [evidenceSpan(page, rawStart, rawEnd)] };
    validateEvidenceRef(evidence, graph.documentIdentity);
    return evidence;
  };
  const atoms: Array<{ start: number; end: number; quote: string; evidence: EvidenceRef }> = [];
  for (const range of sourceExactBodyRanges(statement.text)) {
    const evidence = atomEvidence(range);
    if (!evidence) return [];
    const quote = evidence.spans[0]!.exactText;
    if (!quote.trim() || evidence.spans[0]!.exactText !== quote) return [];
    atoms.push({ start: range.start, end: range.end, quote, evidence });
  }
  return atoms;
}

/**
 * Build the only source-exact atom domain permitted for a marked body.  An
 * empty result is meaningful: the body cannot be independently partitioned,
 * so callers must retain it as draft-only rather than falling back to a
 * whole-body quote.
 */
export function deriveClueFactAtoms(graph: SourceFactGraph, clueId: string, body: SourceStatement): DraftClueFactAtom[] {
  // Marked bodies can consist of token spans separated by source formatting.
  // Their historical facet contract permits only whitespace between adjacent
  // atom pieces; preserve that stricter body-specific reconstruction rather
  // than forcing the prose-root contiguous-span rule onto marked structure.
  const sourcePieces = body.evidence.spans;
  if (!sourcePieces.length || sourcePieces.map((span) => span.exactText).join("") !== body.text) return [];
  const offsets: Array<{ start: number; end: number; spanIndex: number }> = [];
  let offset = 0;
  for (const [spanIndex, span] of sourcePieces.entries()) {
    offsets.push({ start: offset, end: offset + span.exactText.length, spanIndex });
    offset += span.exactText.length;
  }
  const atomEvidence = (range: { start: number; end: number }): EvidenceRef | undefined => {
    const first = offsets.find((piece) => range.start >= piece.start && range.start < piece.end);
    const last = [...offsets].reverse().find((piece) => range.end > piece.start && range.end <= piece.end);
    if (!first || !last) return undefined;
    const firstSpan = sourcePieces[first.spanIndex]!;
    const lastSpan = sourcePieces[last.spanIndex]!;
    if (firstSpan.pageNumber !== lastSpan.pageNumber || firstSpan.documentHash !== lastSpan.documentHash) return undefined;
    const page = graph.documentIdentity.pages.find((candidate) => candidate.pageNumber === firstSpan.pageNumber);
    if (!page) return undefined;
    const rawStart = firstSpan.rawStart + (range.start - first.start);
    const rawEnd = lastSpan.rawStart + (range.end - last.start);
    if (rawEnd < rawStart) return undefined;
    const rawText = page.rawText.slice(rawStart, rawEnd);
    if (rawText.replace(/\s/g, "") !== body.text.slice(range.start, range.end).replace(/\s/g, "")) return undefined;
    const evidence: EvidenceRef = { precision: body.evidence.precision, spans: [evidenceSpan(page, rawStart, rawEnd)] };
    validateEvidenceRef(evidence, graph.documentIdentity);
    return evidence;
  };
  const atoms: DraftClueFactAtom[] = [];
  for (const range of sourcePageBoundedBodyRanges(body.text, sourcePieces)) {
    const evidence = atomEvidence(range);
    if (!evidence) return [];
    const quote = evidence.spans[0]!.exactText;
    if (!quote.trim()) return [];
    atoms.push({
      id: clueFactAtomId(graph, clueId, body.id, range.start, range.end),
      clueCandidateId: clueId,
      bodyStatementId: body.id,
      quote,
      evidence,
      status: "candidate",
    });
  }
  return atoms;
}

/**
 * First-slice grammar: one Chinese Knowledge (EDU) success declaration.  The
 * grammar rejects alternatives (such as 摄影或电器维修), difficulties, and any
 * sentence that does not make the success-to-finding relation explicit.
 */
function proseFactFindingCheck(quote: string): CheckSpec | undefined {
  const compact = quote.replace(/\s/g, "");
  if (!/^成功的知识鉴定后[，,:：][^。！？!?]+[。！？!?]?$/.test(compact)) return undefined;
  return { kind: "attribute", attribute: "edu", difficulty: "regular" };
}

export function deriveSourceFactAtoms(graph: SourceFactGraph, statement: SourceStatement): DraftSourceFactAtom[] {
  return exactStatementAtomParts(graph, statement).map((atom) => ({
    id: deriveSourceFactAtomId(graph, statement.id, atom.start, atom.end),
    statementId: statement.id,
    quote: atom.quote,
    evidence: atom.evidence,
    status: "candidate" as const,
  }));
}

export function deriveProseFactFindingCandidates(
  graph: SourceFactGraph,
  statement: SourceStatement,
  atoms: readonly DraftSourceFactAtom[],
): DraftProseFactFindingCandidate[] {
  if (statement.kind !== "paragraph") return [];
  return atoms.flatMap((atom) => {
    const check = proseFactFindingCheck(atom.quote);
    return check ? [{
      id: deriveProseFactFindingCandidateId(graph, statement.id, atom.id),
      statementId: statement.id,
      atomId: atom.id,
      quote: atom.quote,
      check,
      status: "candidate" as const,
    }] : [];
  });
}

function relationTarget(graph: SourceFactGraph, from: string, kind: "marked_item_name" | "marked_item_body" | "heading_scopes"): SourceStatement | undefined {
  const relation = graph.relations.find((candidate) => candidate.kind === kind && candidate.to === from);
  if (kind === "heading_scopes") return relation ? graph.statements.find((statement) => statement.id === relation.from) : undefined;
  return relation ? graph.statements.find((statement) => statement.id === relation.to) : undefined;
}

function childStatement(graph: SourceFactGraph, parentId: string, kind: "marked_item_name" | "marked_item_body"): SourceStatement | undefined {
  const relation = graph.relations.find((candidate) => candidate.kind === kind && candidate.from === parentId);
  return relation ? graph.statements.find((statement) => statement.id === relation.to) : undefined;
}

function statementRefs(statements: SourceStatement[]): string[] {
  return statements.map((statement) => statement.evidenceRefId);
}

function templateInterpretation(
  graph: SourceFactGraph,
  moduleId: string,
  clue: DraftClueCandidate,
  heading: SourceStatement,
  whole: SourceStatement,
  name: SourceStatement,
  body: SourceStatement,
): FactInterpretationCandidate<MechanicsCandidateSpec> {
  const id = draftId(graph, whole.evidence, "interpretation");
  const mechanicId = draftId(graph, whole.evidence, "mechanic");
  const sources = [whole, body, heading, name];
  const sourceStatementIds = [...new Set(sources.map((statement) => statement.id))];
  const value: MechanicsCandidateSpec = {
    kind: "discovery_method",
    id: mechanicId,
    clueId: clue.id,
    action: "observe",
    target: "scene",
    targetId: clue.sceneCandidateId,
    check: { kind: "none" },
    onSuccess: [{ kind: "discover_clue", clueId: clue.id }],
  };
  return {
    id,
    sourceStatementIds,
    claim: {
      path: `mechanics.discovery_method.${mechanicId}`,
      value,
      domain: "gameplay_mechanic",
      authority: "engine_policy",
      derivation: "default",
      status: "accepted",
      evidenceRefs: statementRefs(sources),
      sourceRef: null,
      confidence: null,
      reason: "Engine default observation mechanism for an explicit marked item; not a source claim about checks or importance.",
      rightsStatus: "project_owned",
      scope: { moduleId },
    },
    interpretationStatus: "accepted",
    review: {
      interpretationId: id,
      decision: "accept",
      reason: "Approved deterministic default for a named marked item under an explicit heading scope.",
      reviewerKind: "approved_policy",
      policyId: MARKED_ITEM_OBSERVATION_POLICY_ID,
      reviewEvidenceStatementIds: sourceStatementIds,
    },
  };
}

/**
 * Compiles only explicit marked-item structure into draft candidates. It never
 * derives gameplay facts from prose or creates a publishable module topology.
 */
export function compileDeterministicTemplates(
  graph: SourceFactGraph,
  input: DeterministicTemplateCompilationInput,
): DraftModuleStructure {
  validateSourceFactGraph(graph);
  if (!input.moduleId.trim()) throw new Error("template moduleId is required");
  const sourceGraphId = sourceFactGraphIdentity(graph);
  const headingStatements = graph.statements.filter((statement) => statement.kind === "heading");
  const sceneCandidates = headingStatements.map((heading) => ({
    id: draftId(graph, heading.evidence, "scene"),
    headingStatementId: heading.id,
    displayName: heading.text.trim(),
    evidence: heading.evidence,
    status: "candidate" as const,
  }));
  const scenesByHeading = new Map(sceneCandidates.map((scene) => [scene.headingStatementId, scene]));
  const clueCandidates: DraftClueCandidate[] = [];
  const clueFactAtoms: DraftClueFactAtom[] = [];
  const sourceFactAtoms: DraftSourceFactAtom[] = [];
  const proseFactFindingCandidates: DraftProseFactFindingCandidate[] = [];
  const itemCandidates: DraftItemCandidate[] = [];
  const rewardCandidates: DraftRewardCandidate[] = [];
  const proseNpcAnchors: DraftProseNpcAnchor[] = [];
  const interpretations: FactInterpretationCandidate<MechanicsCandidateSpec>[] = [];
  const unresolvedStatementIds = new Set<string>();

  for (const whole of graph.statements.filter((statement) => statement.kind === "marked_item")) {
    const heading = relationTarget(graph, whole.id, "heading_scopes");
    const name = childStatement(graph, whole.id, "marked_item_name");
    const body = childStatement(graph, whole.id, "marked_item_body");
    if (!heading || !scenesByHeading.has(heading.id)) {
      unresolvedStatementIds.add(whole.id);
      continue;
    }
    if (!name || !name.text.trim()) {
      unresolvedStatementIds.add(whole.id);
      continue;
    }
    if (!body || !body.text.trim() || body.evidence.spans.length === 0) {
      unresolvedStatementIds.add(whole.id);
      continue;
    }
    const scene = scenesByHeading.get(heading.id)!;
    const clue: DraftClueCandidate = {
      id: draftId(graph, whole.evidence, "clue"),
      markedItemStatementId: whole.id,
      nameStatementId: name.id,
      bodyStatementId: body.id,
      sceneCandidateId: scene.id,
      displayName: name.text.trim(),
      importance: "unknown",
      evidence: whole.evidence,
      status: "candidate",
    };
    clueCandidates.push(clue);
    clueFactAtoms.push(...deriveClueFactAtoms(graph, clue.id, body));
    itemCandidates.push({
      id: draftId(graph, whole.evidence, "item"),
      markedItemStatementId: whole.id,
      nameStatementId: name.id,
      bodyStatementId: body.id,
      sceneCandidateId: scene.id,
      displayName: name.text.trim(),
      evidence: whole.evidence,
      status: "candidate",
    });
    interpretations.push(templateInterpretation(graph, input.moduleId, clue, heading, whole, name, body));
  }

  // A table row remains structural evidence until both its source heading and
  // its own text verify an executable, positive RewardSettlement shape.
  // This is deliberately lexical and fail-closed: stat tables, loss values,
  // percentages, and arbitrary compact rows never become reward reviews.
  for (const row of graph.statements.filter((statement) => statement.kind === "table_row")) {
    const heading = relationTarget(graph, row.id, "heading_scopes");
    if (!heading || heading.kind !== "heading" || row.evidence.spans.length === 0 || !isEligibleRewardSourceRow(heading.text, row.text)) continue;
    rewardCandidates.push({
      id: draftId(graph, row.evidence, "reward"),
      tableRowStatementId: row.id,
      headingStatementId: heading.id,
      evidence: row.evidence,
      status: "candidate",
    });
  }
  rewardCandidates.sort((left, right) => left.id.localeCompare(right.id));

  // Ordinary prose is never treated as a named entity by the compiler.  It
  // becomes only a reviewable evidence anchor when the fact graph already
  // places it under one explicit heading scope.
  for (const paragraph of graph.statements.filter((statement) => statement.kind === "paragraph" && statement.text.trim() && statement.evidence.spans.length > 0)) {
    const heading = relationTarget(graph, paragraph.id, "heading_scopes");
    const scene = heading && scenesByHeading.get(heading.id);
    if (!heading || !scene) continue;
    proseNpcAnchors.push({
      id: draftId(graph, paragraph.evidence, "prose_npc"),
      paragraphStatementId: paragraph.id,
      headingStatementId: heading.id,
      sceneCandidateId: scene.id,
      evidence: paragraph.evidence,
      status: "candidate",
    });
  }
  proseNpcAnchors.sort((left, right) => left.id.localeCompare(right.id));

  // Source-fact disposition keeps every ordinary root visible.  Atomisation
  // happens before a review is allowed to select a mechanics candidate, so a
  // successful-check finding can never stand in for unselected neighboring
  // prose.  Only the narrow grammar above creates a selectable candidate.
  for (const statement of graph.statements.filter((candidate) => ["paragraph", "list_item", "table_row"].includes(candidate.kind))) {
    const atoms = deriveSourceFactAtoms(graph, statement);
    sourceFactAtoms.push(...atoms);
    proseFactFindingCandidates.push(...deriveProseFactFindingCandidates(graph, statement, atoms));
  }

  const symbols = {
    clueIds: clueCandidates.map((clue) => clue.id),
    sceneIds: sceneCandidates.map((scene) => scene.id),
    itemIds: [], npcIds: [], connectionIds: [], encounterIds: [], endingIds: [], rewardIds: [], declaredStateKeys: [],
  };
  const mechanicsIR = interpretations.length === 0 ? undefined : compileMechanics(
    { ...graph, interpretations },
    {
      moduleId: input.moduleId,
      documentHash: graph.documentIdentity.documentHash,
      sourceGraphSchemaVersion: graph.schemaVersion,
      symbols,
      acceptedInterpretationIds: interpretations.map((interpretation) => interpretation.id),
      compilationMode: "compatible",
      allowedEnginePolicyIds: [MARKED_ITEM_OBSERVATION_POLICY_ID],
    },
  );
  const generatedMechanicIds = mechanicsIR?.discoveryMethods.map((method) => method.id).sort() ?? [];
  const draft: DraftModuleStructure = {
    schemaVersion: DRAFT_MODULE_STRUCTURE_SCHEMA_VERSION,
    moduleId: input.moduleId,
    documentHash: graph.documentIdentity.documentHash,
    sourceGraphIdentity: sourceGraphId,
    sceneCandidates,
    clueCandidates,
    clueFactAtoms: clueFactAtoms.sort((left, right) => {
      const leftSpan = left.evidence.spans[0]!;
      const rightSpan = right.evidence.spans[0]!;
      return leftSpan.pageNumber - rightSpan.pageNumber || leftSpan.rawStart - rightSpan.rawStart || left.id.localeCompare(right.id);
    }),
    sourceFactAtoms: sourceFactAtoms.sort((left, right) => {
      const leftSpan = left.evidence.spans[0]!;
      const rightSpan = right.evidence.spans[0]!;
      return leftSpan.pageNumber - rightSpan.pageNumber || leftSpan.rawStart - rightSpan.rawStart || left.id.localeCompare(right.id);
    }),
    proseFactFindingCandidates: proseFactFindingCandidates.sort((left, right) => left.id.localeCompare(right.id)),
    itemCandidates,
    rewardCandidates,
    proseNpcAnchors,
    interpretations,
    ...(mechanicsIR ? { mechanicsIR } : {}),
    readiness: {
      status: "draft_only",
      blockingCodes: ["unresolved_scene_candidates", "missing_entry_scene", "missing_ending_rules", "missing_connection_topology"],
      unresolvedStatementIds: [...unresolvedStatementIds].sort(),
      generatedMechanicIds,
      questionQueueHash: "",
      openQuestionIds: [],
      publishBlockingQuestionIds: [],
    },
  };
  const questionQueue = buildCompilerQuestionQueue(graph, draft);
  return {
    ...draft,
    readiness: {
      ...draft.readiness,
      questionQueueHash: questionQueue.queueHash,
      openQuestionIds: questionQueue.questions.filter((question) => question.status === "open").map((question) => question.id),
      publishBlockingQuestionIds: questionQueue.questions.filter((question) => question.severity === "publish_blocking" && question.status === "open").map((question) => question.id),
    },
  };
}
