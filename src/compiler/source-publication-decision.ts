import { createHash } from "node:crypto";

export const SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION = "1.0.0" as const;
const HASH_DOMAIN = "aitrpg:source-publication-decision:v1\0";
const SHA256 = /^[a-f0-9]{64}$/;

export type SourcePublicationDecisionKind = "research_lookup_admission" | "runtime_rule_admission" | "rejected";
export type SourceDecisionAuthorityClass = "human" | "delegated_assistant" | "lead_model";

export interface SourceDecisionWorkScope {
  readonly work_id: string;
  /** Every selected candidate is bound to the one exact work in this decision. */
  readonly candidate_work_ids: Readonly<Record<string, string>>;
}

export interface SourceDecisionAuthority {
  readonly authority_class: SourceDecisionAuthorityClass;
  readonly authority_id: string;
}

export interface SourcePublicationDecisionInput {
  readonly schema_version: typeof SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION;
  readonly decision_kind: SourcePublicationDecisionKind;
  readonly reviewed_source_manifest_hash: string;
  readonly source_records_hash: string;
  readonly selected_candidate_ids: readonly string[];
  readonly work_scope: SourceDecisionWorkScope;
  readonly decision_authority: SourceDecisionAuthority;
  readonly timestamp: string;
  readonly supersedes: string | null;
  readonly runtime_effect: boolean;
  /** Required only for a runtime rule admission; this contract does not inspect it. */
  readonly approved_ruleset_contract_hash: string | null;
}

export interface SourcePublicationDecision extends SourcePublicationDecisionInput {
  readonly decision_hash: string;
}

type UnknownRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`invalid source publication decision: ${message}`);
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (!isPlainRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected fields`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a nonempty string`);
  return value;
}

function hashPin(value: unknown, label: string): string {
  const hash = requiredString(value, label);
  if (!SHA256.test(hash)) fail(`${label} must be a lowercase sha256 hash`);
  return hash;
}

function nullableHashPin(value: unknown, label: string): string | null {
  return value === null ? null : hashPin(value, label);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainRecord(value)) fail("hash payload contains a non-canonical value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  Object.freeze(value);
  return value;
}

function validateTimestamp(value: unknown): string {
  const timestamp = requiredString(value, "timestamp");
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail("timestamp must be an exact ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function validateCandidateIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) fail("selected_candidate_ids must be a nonempty array");
  const ids = value.map((id, index) => requiredString(id, `selected_candidate_ids[${index}]`)).sort();
  if (new Set(ids).size !== ids.length) fail("selected_candidate_ids must not contain duplicates");
  return ids;
}

function validateWorkScope(value: unknown, candidateIds: readonly string[]): SourceDecisionWorkScope {
  const scope = exactRecord(value, ["work_id", "candidate_work_ids"], "work_scope");
  const workId = requiredString(scope.work_id, "work_scope.work_id");
  const candidateWorkIds = exactRecord(scope.candidate_work_ids, candidateIds, "work_scope.candidate_work_ids");
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const candidateId of candidateIds) {
    const candidateWorkId = requiredString(candidateWorkIds[candidateId], `work_scope.candidate_work_ids.${candidateId}`);
    if (candidateWorkId !== workId) fail(`candidate ${candidateId} is outside exact work scope`);
    normalized[candidateId] = candidateWorkId;
  }
  return { work_id: workId, candidate_work_ids: normalized };
}

function validateAuthority(value: unknown): SourceDecisionAuthority {
  const authority = exactRecord(value, ["authority_class", "authority_id"], "decision_authority");
  if (authority.authority_class !== "human" && authority.authority_class !== "delegated_assistant" && authority.authority_class !== "lead_model") {
    fail("decision_authority.authority_class must be human, delegated_assistant, or lead_model");
  }
  return {
    authority_class: authority.authority_class,
    authority_id: requiredString(authority.authority_id, "decision_authority.authority_id"),
  };
}

function validateUnsigned(input: unknown): SourcePublicationDecisionInput {
  const record = exactRecord(input, [
    "schema_version", "decision_kind", "reviewed_source_manifest_hash", "source_records_hash",
    "selected_candidate_ids", "work_scope", "decision_authority", "timestamp", "supersedes",
    "runtime_effect", "approved_ruleset_contract_hash",
  ], "decision");
  if (record.schema_version !== SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION) {
    fail(`unsupported schema_version: ${String(record.schema_version)}`);
  }
  if (record.decision_kind !== "research_lookup_admission"
    && record.decision_kind !== "runtime_rule_admission"
    && record.decision_kind !== "rejected") {
    fail("decision_kind must be research_lookup_admission, runtime_rule_admission, or rejected");
  }
  if (typeof record.runtime_effect !== "boolean") fail("runtime_effect must be a boolean");

  const selectedCandidateIds = validateCandidateIds(record.selected_candidate_ids);
  const decisionAuthority = validateAuthority(record.decision_authority);
  const decision: SourcePublicationDecisionInput = {
    schema_version: SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION,
    decision_kind: record.decision_kind,
    reviewed_source_manifest_hash: hashPin(record.reviewed_source_manifest_hash, "reviewed_source_manifest_hash"),
    source_records_hash: hashPin(record.source_records_hash, "source_records_hash"),
    selected_candidate_ids: selectedCandidateIds,
    work_scope: validateWorkScope(record.work_scope, selectedCandidateIds),
    decision_authority: decisionAuthority,
    timestamp: validateTimestamp(record.timestamp),
    supersedes: nullableHashPin(record.supersedes, "supersedes"),
    runtime_effect: record.runtime_effect,
    approved_ruleset_contract_hash: nullableHashPin(record.approved_ruleset_contract_hash, "approved_ruleset_contract_hash"),
  };

  if (decision.decision_authority.authority_class !== "human" && decision.runtime_effect) {
    fail("only human decision authority can set runtime_effect=true");
  }
  if (decision.decision_kind === "research_lookup_admission" && decision.runtime_effect) {
    fail("research_lookup_admission must set runtime_effect=false");
  }
  if (decision.decision_kind === "rejected" && decision.runtime_effect) {
    fail("rejected decisions must set runtime_effect=false");
  }
  if (decision.decision_kind === "runtime_rule_admission") {
    if (!decision.runtime_effect) fail("runtime_rule_admission must set runtime_effect=true");
    if (!decision.approved_ruleset_contract_hash) {
      fail("runtime_rule_admission requires approved_ruleset_contract_hash");
    }
    if (decision.decision_authority.authority_class !== "human") {
      fail("runtime_rule_admission requires human decision authority");
    }
  }
  return decision;
}

/** Canonical integrity hash for an unsigned source publication decision. */
export function sourcePublicationDecisionHash(input: SourcePublicationDecisionInput): string {
  const decision = validateUnsigned(input);
  return createHash("sha256").update(HASH_DOMAIN).update(canonicalJson(decision)).digest("hex");
}

/** Validate, canonicalize, hash, and deep-freeze a new isolated decision record. */
export function createSourcePublicationDecision(input: SourcePublicationDecisionInput): SourcePublicationDecision {
  const decision = validateUnsigned(input);
  return deepFreeze({ ...decision, decision_hash: sourcePublicationDecisionHash(decision) });
}

/** Revalidate an existing immutable record and its canonical integrity hash. */
export function validateSourcePublicationDecision(input: unknown): SourcePublicationDecision {
  const record = exactRecord(input, [
    "schema_version", "decision_kind", "reviewed_source_manifest_hash", "source_records_hash",
    "selected_candidate_ids", "work_scope", "decision_authority", "timestamp", "supersedes",
    "runtime_effect", "approved_ruleset_contract_hash", "decision_hash",
  ], "decision");
  const decisionHash = hashPin(record.decision_hash, "decision_hash");
  const { decision_hash: _decisionHash, ...unsigned } = record;
  const decision = validateUnsigned(unsigned);
  if (decisionHash !== sourcePublicationDecisionHash(decision)) {
    fail("decision_hash does not match canonical decision payload");
  }
  return deepFreeze({ ...decision, decision_hash: decisionHash });
}
