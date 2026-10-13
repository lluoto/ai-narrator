import { readFileSync } from "node:fs";

export interface SourcePropositionLoadConfig {
  /** Required caller-supplied artifact path. This module has no default source. */
  readonly path: string;
}

export interface SourcePropositionQuery {
  /** A single work is required; this adapter never expands a work scope. */
  readonly workId: string;
  /** Literal text matched with String.prototype.includes, including Chinese text. */
  readonly text: string;
  /** Optional exact filter for the artifact's primary_route. */
  readonly route?: string;
}

export interface SourcePropositionEvidence {
  readonly ids: readonly string[];
  readonly precision: string;
  readonly sourceUnitId: string;
  readonly sourceChapterId: string;
  readonly text: string;
}

export interface SourcePropositionModality {
  readonly assertionStatus: string;
  readonly evidenceDirectness: string;
}

/**
 * A receipt is source evidence only. It has no authority to change game state,
 * execute rules, or alter any prompt.
 */
export interface SourcePropositionReceipt {
  readonly propositionId: string;
  readonly workId: string;
  readonly proposition: string;
  readonly evidence: SourcePropositionEvidence;
  readonly modality: SourcePropositionModality;
  readonly temporal: string;
  readonly warnings: readonly string[];
  readonly route?: string;
  readonly noRuntimeEffect: true;
}

export interface SourcePropositionAdapter {
  query(request: SourcePropositionQuery): readonly SourcePropositionReceipt[];
}

export class SourcePropositionLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourcePropositionLoadError";
  }
}

export class SourcePropositionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcePropositionScopeError";
  }
}

/**
 * RAW AUDIT ONLY: this reads unreviewed source proposition records. Research
 * consumers must use `reviewed-source-query-adapter.ts`, whose hash-pinned
 * reviewed manifest is the allowlist.
 *
 * Loads a supplied JSONL artifact into an isolated read-only adapter. No path,
 * environment variable, or runtime dependency is implied when this module loads.
 */
export function loadSourcePropositionAdapter(config: SourcePropositionLoadConfig): SourcePropositionAdapter {
  const path = requiredString(config, "path", "load configuration");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new SourcePropositionLoadError(`source proposition artifact cannot be read: ${path}`, { cause: error });
  }

  const entries: SourcePropositionReceipt[] = [];
  const seenIds = new Set<string>();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new SourcePropositionLoadError(`source proposition artifact has malformed JSONL at line ${index + 1}`, { cause: error });
    }
    const receipt = normalizeRecord(parsed, index + 1);
    if (!receipt) continue;
    if (seenIds.has(receipt.propositionId)) throw recordError(index + 1, `duplicate proposition_id ${receipt.propositionId}`);
    seenIds.add(receipt.propositionId);
    entries.push(receipt);
  }

  const immutableEntries = Object.freeze(entries);
  return Object.freeze({
    query(request: SourcePropositionQuery): readonly SourcePropositionReceipt[] {
      const workId = requiredQueryString(request, "workId");
      const text = requiredQueryString(request, "text");
      const route = optionalQueryString(request, "route");
      return Object.freeze(immutableEntries.filter((entry) =>
        entry.workId === workId
        && entry.proposition.includes(text)
        && (route === undefined || entry.route === route),
      ));
    },
  });
}

function normalizeRecord(value: unknown, line: number): SourcePropositionReceipt | undefined {
  const record = requiredRecord(value, line);
  const workId = requiredRecordString(record, "work_id", line);
  const allowedWorkIds = requiredStringArray(record, "allowed_work_ids", line);
  if (allowedWorkIds.length !== 1 || allowedWorkIds[0] !== workId) {
    throw recordError(line, "allowed_work_ids must contain exactly its work_id");
  }

  // Fail closed: an unexpected state is an artifact error, never a silent drop.
  const publicationStatus = requiredRecordString(record, "publication_status", line);
  const transferPolicy = requiredRecordString(record, "transfer_policy", line);
  const queryability = requiredRecordString(record, "queryability", line);
  if (publicationStatus !== "candidate_not_confirmed") {
    throw recordError(line, `publication_status must be candidate_not_confirmed, got ${publicationStatus}`);
  }
  if (transferPolicy !== "no_transfer") {
    throw recordError(line, `transfer_policy must be no_transfer, got ${transferPolicy}`);
  }
  if (queryability === "audit_only") return undefined;
  if (queryability !== "queryable") {
    throw recordError(line, `queryability must be queryable or audit_only, got ${queryability}`);
  }

  const route = optionalRecordString(record, "primary_route", line);
  const receipt: SourcePropositionReceipt = {
    propositionId: requiredRecordString(record, "proposition_id", line),
    workId,
    proposition: requiredRecordString(record, "proposition_text", line),
    evidence: Object.freeze({
      ids: Object.freeze(requiredStringArray(record, "evidence_ids", line)),
      precision: requiredRecordString(record, "evidence_precision", line),
      sourceUnitId: requiredRecordString(record, "source_unit_id", line),
      sourceChapterId: requiredRecordString(record, "source_chapter_id", line),
      text: requiredRecordString(record, "source_text", line),
    }),
    modality: Object.freeze({
      assertionStatus: requiredRecordString(record, "assertion_status", line),
      evidenceDirectness: requiredRecordString(record, "evidence_directness", line),
    }),
    temporal: requiredRecordString(record, "temporal_status", line),
    warnings: Object.freeze(requiredStringArray(record, "warnings", line)),
    ...(route === undefined ? {} : { route }),
    noRuntimeEffect: true,
  };
  return Object.freeze(receipt);
}

function requiredRecord(value: unknown, line: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw recordError(line, "record must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, key: string, subject: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourcePropositionLoadError(`${subject} must be an object with a nonempty ${key}`);
  }
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new SourcePropositionLoadError(`${subject} requires a nonempty ${key}`);
  }
  return candidate;
}

function requiredRecordString(record: Record<string, unknown>, key: string, line: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw recordError(line, `${key} must be a nonempty string`);
  return value;
}

function optionalRecordString(record: Record<string, unknown>, key: string, line: number): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw recordError(line, `${key} must be a nonempty string when present`);
  return value;
}

function requiredStringArray(record: Record<string, unknown>, key: string, line: number): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw recordError(line, `${key} must be a nonempty string array`);
  }
  return [...value];
}

function requiredQueryString(request: SourcePropositionQuery, key: "workId" | "text"): string {
  const value = request?.[key];
  if (typeof value !== "string" || !value.trim()) throw new SourcePropositionScopeError(`${key} must be nonempty`);
  return value;
}

function optionalQueryString(request: SourcePropositionQuery, key: "route"): string | undefined {
  const value = request?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new SourcePropositionScopeError(`${key} must be nonempty when present`);
  return value;
}

function recordError(line: number, message: string): SourcePropositionLoadError {
  return new SourcePropositionLoadError(`source proposition record at line ${line}: ${message}`);
}
