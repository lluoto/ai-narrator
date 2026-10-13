import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Read-only research lookup over a *reviewed* source-query manifest.
 *
 * The manifest is the allowlist: a source proposition record is only visible if
 * a hash-pinned manifest row admits it. Displayed text and modality come from
 * the manifest, never from the raw record. Every inconsistency fails closed.
 *
 * Receipts have no authority: they must not reach game state, SQLite, rules,
 * prompt construction, or the world-model loader/integrator. See
 * `source-adapter-isolation.test.ts`.
 */

export type ReviewerClass = "human" | "delegated_assistant" | "lead_model" | "ai_provisional" | "model";
const REVIEWER_CLASSES: ReadonlySet<string> = new Set(["human", "delegated_assistant", "lead_model", "ai_provisional", "model"]);
const ASSERTION = new Set([
  "narrator_asserted", "direct_speech_claim", "reported_belief", "rumor",
  "conjecture", "historical_account", "prophecy_or_plan", "formally_enacted_direct",
]);
const TEMPORAL = new Set(["persistent_or_general", "bounded_occurrence", "historical", "future_or_contingent", "unknown"]);
const DECISIONS = new Set(["retain_source_query_only", "rewrite_source_query_only"]);
const TEXT_KINDS = new Set(["reviewed_query_text", "reviewed_context_text", "evidence_only"]);
const MAX_SOURCE_RESEARCH_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_RESEARCH_MANIFEST_ENTRIES = 1024;
const MAX_SOURCE_RESEARCH_RECORD_ENTRIES = 8192;

export interface ReviewedSourceQueryConfig {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly recordsPath: string;
  readonly recordsSha256: string;
  /** Required, no default: which reviewer classes may be admitted. */
  readonly allowedReviewerClasses: readonly ReviewerClass[];
}

export interface ReviewedSourceQuery {
  readonly workId: string;
  /** Literal substring matched against reviewed text and verbatim evidence. */
  readonly text: string;
  readonly reviewBatchType?: string;
}

export interface SourceResearchReceipt {
  readonly kind: "source_research_receipt";
  readonly manifestRecordId: string;
  readonly candidateId: string;
  readonly propositionId: string;
  readonly workId: string;
  readonly reviewBatchType: string;
  readonly decision: string;
  readonly reviewerClass: ReviewerClass;
  /** Reviewed prose, or null when only verbatim evidence was reviewed. */
  readonly reviewedText: string | null;
  readonly reviewedTextKind: string;
  readonly evidence: {
    readonly ids: readonly string[];
    readonly text: string;
    readonly sourceUnitId: string;
    readonly sourceChapterId: string;
  };
  readonly modality: {
    readonly assertionStatus: string;
    readonly temporalStatus: string;
    readonly modalityChange: "preserved" | "corrected";
  };
  readonly sourceRecordSha256: string;
  readonly warnings: readonly string[];
  readonly noRuntimeEffect: true;
}

export interface ReviewedSourceQueryAdapter {
  readonly admittedCount: number;
  readonly excludedByReviewerClass: number;
  /** Returns every admitted receipt for one exact work scope. */
  queryWork(workId: string): readonly SourceResearchReceipt[];
  query(request: ReviewedSourceQuery): readonly SourceResearchReceipt[];
}

export class ReviewedSourceQueryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewedSourceQueryError";
  }
}

type Obj = Record<string, unknown>;

export function loadReviewedSourceQueryAdapter(config: ReviewedSourceQueryConfig): ReviewedSourceQueryAdapter {
  const allowed = parseAllowedClasses(config?.allowedReviewerClasses);
  const manifestLines = readPinned(config.manifestPath, config.manifestSha256, "manifest", MAX_SOURCE_RESEARCH_MANIFEST_ENTRIES);
  const recordLines = readPinned(config.recordsPath, config.recordsSha256, "records", MAX_SOURCE_RESEARCH_RECORD_ENTRIES);

  const records = new Map<string, { record: Obj; sha256: string }>();
  for (const [index, line] of recordLines) {
    const record = parseObject(line, `records line ${index}`);
    const id = str(record, "proposition_id", `records line ${index}`);
    if (records.has(id)) throw new ReviewedSourceQueryError(`duplicate proposition_id in records: ${id}`);
    records.set(id, { record, sha256: sha256(line) });
  }

  const receipts: SourceResearchReceipt[] = [];
  const seenCandidates = new Set<string>();
  const seenPropositions = new Set<string>();
  let excluded = 0;

  for (const [index, line] of manifestLines) {
    const at = `manifest line ${index}`;
    const row = parseObject(line, at);
    expect(row, "schema_version", "reviewed_source_query_manifest_v2", at);
    expect(row, "candidate_status", "source_query_only", at);
    expect(row, "review_status", "review_only", at);
    expect(row, "publication_status", "candidate_not_confirmed", at);
    expect(row, "transfer_policy", "no_transfer", at);
    expect(row, "consumer_policy", "research_lookup_only", at);
    if (row.no_runtime_effect !== true) fail(at, "no_runtime_effect must be true");

    const candidateId = str(row, "candidate_id", at);
    if (seenCandidates.has(candidateId)) fail(at, `duplicate candidate_id ${candidateId}`);
    seenCandidates.add(candidateId);

    const decision = str(row, "decision", at);
    if (!DECISIONS.has(decision)) fail(at, `unknown decision ${decision}`);
    const reviewerClass = str(row, "reviewer_class", at);
    if (!REVIEWER_CLASSES.has(reviewerClass)) fail(at, `unknown reviewer_class ${reviewerClass}`);

    const scope = obj(row, "work_scope", at);
    expect(scope, "scope", "single_work", at);
    const workId = str(scope, "work_id", at);
    const allowedWorkIds = strArray(scope, "allowed_work_ids", at);
    if (allowedWorkIds.length !== 1 || allowedWorkIds[0] !== workId) fail(at, "allowed_work_ids must be exactly [work_id]");
    const propositionId = str(scope, "proposition_id", at);
    if (seenPropositions.has(propositionId)) fail(at, `duplicate proposition_id ${propositionId}`);
    seenPropositions.add(propositionId);

    const entry = records.get(propositionId);
    if (!entry) fail(at, `proposition ${propositionId} not found in records`);
    const { record, sha256: recordSha } = entry!;
    if (str(row, "source_record_sha256", at) !== recordSha) fail(at, `source_record_sha256 mismatch for ${propositionId}`);

    // Exact envelope join.
    for (const key of ["source_unit_id", "source_chapter_id"] as const) {
      if (str(scope, key, at) !== str(record, key, at)) fail(at, `${key} mismatch with record`);
    }
    if (str(record, "work_id", at) !== workId) fail(at, "work_id mismatch with record");
    const recordAllowed = strArray(record, "allowed_work_ids", at);
    if (recordAllowed.length !== 1 || recordAllowed[0] !== workId) fail(at, "record allowed_work_ids mismatch");
    if (record.queryability !== "queryable") fail(at, "record is not queryable");
    if (record.publication_status !== "candidate_not_confirmed" || record.transfer_policy !== "no_transfer") {
      fail(at, "record publication/transfer state is not candidate_not_confirmed/no_transfer");
    }
    const evidence = obj(row, "reviewed_evidence", at);
    if (evidence.source_exact !== true) fail(at, "reviewed_evidence.source_exact must be true");
    const evidenceIds = strArray(evidence, "evidence_ids", at);
    if (JSON.stringify(evidenceIds) !== JSON.stringify(strArray(record, "evidence_ids", at))) fail(at, "evidence_ids mismatch with record");

    // Modality: manifest wins only when the change is declared.
    const modality = obj(row, "reviewed_modality", at);
    const assertionStatus = str(modality, "assertion_status", at);
    const temporalStatus = str(modality, "temporal_status", at);
    if (!ASSERTION.has(assertionStatus) || !TEMPORAL.has(temporalStatus)) fail(at, "non-enum reviewed modality");
    const modalityChange = str(modality, "modality_change", at);
    const differs = assertionStatus !== record.assertion_status || temporalStatus !== record.temporal_status;
    if (modalityChange === "preserved" && differs) fail(at, "modality differs from record but modality_change=preserved");
    if (modalityChange === "corrected" && !differs) fail(at, "modality_change=corrected but modality equals record");
    if (modalityChange !== "preserved" && modalityChange !== "corrected") fail(at, `unknown modality_change ${modalityChange}`);

    const reviewedTextKind = str(row, "reviewed_text_kind", at);
    if (!TEXT_KINDS.has(reviewedTextKind)) fail(at, `unknown reviewed_text_kind ${reviewedTextKind}`);
    const reviewedText = row.reviewed_text;
    if (reviewedTextKind === "evidence_only") {
      if (reviewedText !== null) fail(at, "evidence_only rows must have reviewed_text=null");
    } else if (typeof reviewedText !== "string" || !reviewedText.trim()) {
      fail(at, "reviewed_text required for reviewed text kinds");
    }

    if (!allowed.has(reviewerClass)) {
      excluded += 1;
      continue;
    }

    const warnings = ["candidate_not_confirmed", "no_transfer", "research_lookup_only", `reviewer_class:${reviewerClass}`];
    if (modalityChange === "corrected") warnings.push("modality_corrected_in_review");
    if (assertionStatus !== "narrator_asserted") warnings.push(`attributed_or_modal:${assertionStatus}`);

    receipts.push(deepFreeze({
      kind: "source_research_receipt",
      manifestRecordId: str(row, "manifest_record_id", at),
      candidateId,
      propositionId,
      workId,
      reviewBatchType: str(row, "review_batch_type", at),
      decision,
      reviewerClass: reviewerClass as ReviewerClass,
      reviewedText: reviewedText as string | null,
      reviewedTextKind,
      evidence: {
        ids: [...evidenceIds],
        text: str(record, "source_text", at),
        sourceUnitId: str(record, "source_unit_id", at),
        sourceChapterId: str(record, "source_chapter_id", at),
      },
      modality: { assertionStatus, temporalStatus, modalityChange: modalityChange as "preserved" | "corrected" },
      sourceRecordSha256: recordSha,
      warnings,
      noRuntimeEffect: true,
    } satisfies SourceResearchReceipt));
  }

  const frozen = Object.freeze(receipts);
  const byWork = new Map<string, SourceResearchReceipt[]>();
  for (const receipt of frozen) {
    const workReceipts = byWork.get(receipt.workId);
    if (workReceipts) workReceipts.push(receipt);
    else byWork.set(receipt.workId, [receipt]);
  }
  const frozenByWork = new Map<string, readonly SourceResearchReceipt[]>();
  for (const [workId, workReceipts] of byWork) {
    frozenByWork.set(workId, Object.freeze(workReceipts));
  }
  const emptyWorkReceipts: readonly SourceResearchReceipt[] = Object.freeze([]);
  const forWork = (workId: string): readonly SourceResearchReceipt[] => frozenByWork.get(workId) ?? emptyWorkReceipts;
  return Object.freeze({
    admittedCount: frozen.length,
    excludedByReviewerClass: excluded,
    queryWork(workId: string): readonly SourceResearchReceipt[] {
      return forWork(queryString(workId, "workId"));
    },
    query(request: ReviewedSourceQuery): readonly SourceResearchReceipt[] {
      const workId = queryString(request?.workId, "workId");
      const text = queryString(request?.text, "text");
      const batch = request?.reviewBatchType === undefined ? undefined : queryString(request.reviewBatchType, "reviewBatchType");
      return Object.freeze(forWork(workId).filter((r) =>
        (batch === undefined || r.reviewBatchType === batch)
        && ((r.reviewedText ?? "").includes(text) || r.evidence.text.includes(text)),
      ));
    },
  });
}

function parseAllowedClasses(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReviewedSourceQueryError("allowedReviewerClasses must be an explicit nonempty list");
  }
  for (const v of value) {
    if (typeof v !== "string" || !REVIEWER_CLASSES.has(v)) throw new ReviewedSourceQueryError(`unknown reviewer class ${String(v)}`);
  }
  return new Set(value as string[]);
}

function readPinned(path: unknown, expectedSha: unknown, label: string, maximumEntries: number): Array<[number, string]> {
  if (typeof path !== "string" || !path.trim()) throw new ReviewedSourceQueryError(`${label} path required`);
  if (!isAbsolute(path)) throw new ReviewedSourceQueryError(`${label} path must be absolute`);
  if (typeof expectedSha !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha)) {
    throw new ReviewedSourceQueryError(`${label} sha256 pin required (64 lowercase hex)`);
  }
  const bytes = readBoundedRegularFile(path, label, MAX_SOURCE_RESEARCH_ARTIFACT_BYTES);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha) throw new ReviewedSourceQueryError(`${label} sha256 mismatch: expected ${expectedSha}, got ${actual}`);

  const out: Array<[number, string]> = [];
  const text = bytes.toString("utf8");
  let start = 0;
  let lineNumber = 1;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    const rawLine = text.slice(start, end === -1 ? text.length : end);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim()) {
      if (out.length >= maximumEntries) {
        throw new ReviewedSourceQueryError(`${label} exceeds the ${maximumEntries}-entry resource limit`);
      }
      out.push([lineNumber, line]);
    }
    if (end === -1) break;
    start = end + 1;
    lineNumber += 1;
  }
  return out;
}

/** Symlinks may target a configured read-only file; pipes, devices, and directories may not. */
function readBoundedRegularFile(path: string, label: string, maximumBytes: number): Buffer {
  assertBoundedRegularFile(path, label, maximumBytes);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const stat = fstatSync(descriptor);
    const size = boundedRegularFileSize(stat, label, maximumBytes);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(descriptor, bytes, offset, size - offset, null);
      if (bytesRead === 0) throw new ReviewedSourceQueryError(`${label} changed while reading`);
      offset += bytesRead;
    }
    if (fstatSync(descriptor).size !== size) throw new ReviewedSourceQueryError(`${label} changed while reading`);
    return bytes;
  } catch (error) {
    if (error instanceof ReviewedSourceQueryError) throw error;
    throw new ReviewedSourceQueryError(`${label} cannot be read: ${path}`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertBoundedRegularFile(path: string, label: string, maximumBytes: number): void {
  try {
    const link = lstatSync(path);
    if (!link.isFile() && !link.isSymbolicLink()) throw new ReviewedSourceQueryError(`${label} must be a regular file`);
    boundedRegularFileSize(statSync(path), label, maximumBytes);
  } catch (error) {
    if (error instanceof ReviewedSourceQueryError) throw error;
    throw new ReviewedSourceQueryError(`${label} cannot be read: ${path}`, { cause: error });
  }
}

function boundedRegularFileSize(stat: { isFile(): boolean; size: number }, label: string, maximumBytes: number): number {
  if (!stat.isFile()) throw new ReviewedSourceQueryError(`${label} must be a regular file`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new ReviewedSourceQueryError(`${label} has an unsafe file size`);
  if (stat.size > maximumBytes) throw new ReviewedSourceQueryError(`${label} exceeds the ${maximumBytes}-byte resource limit`);
  return stat.size;
}

function sha256(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

function parseObject(line: string, at: string): Obj {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new ReviewedSourceQueryError(`${at}: malformed JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(at, "must be an object");
  return value as Obj;
}

function obj(o: Obj, key: string, at: string): Obj {
  const v = o[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(at, `${key} must be an object`);
  return v as Obj;
}

function str(o: Obj, key: string, at: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) fail(at, `${key} must be a nonempty string`);
  return v as string;
}

function strArray(o: Obj, key: string, at: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !x.trim())) {
    fail(at, `${key} must be a nonempty string array`);
  }
  return [...(v as string[])];
}

function expect(o: Obj, key: string, expected: string, at: string): void {
  if (o[key] !== expected) fail(at, `${key} must be ${expected}, got ${JSON.stringify(o[key])}`);
}

function queryString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ReviewedSourceQueryError(`${key} must be nonempty`);
  return value;
}

function fail(at: string, message: string): never {
  throw new ReviewedSourceQueryError(`${at}: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
