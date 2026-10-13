import { createHash } from "node:crypto";

export const APPROVED_RUNTIME_RULESET_CONTRACT_SCHEMA_VERSION = "1.1.0" as const;
export const APPROVED_RUNTIME_RULESET_ALLOWED_CAPABILITIES = ["evaluate_action"] as const;
export const APPROVED_RUNTIME_RULESET_PROHIBITED_CAPABILITIES = [
  "state_mutation",
  "persistence_write",
  "cross_work_merge",
  "prompt_injection",
  "tool_call",
  "network",
] as const;

const HASH_DOMAIN = "aitrpg:approved-runtime-ruleset-contract:v1\0";
const SHA256 = /^[a-f0-9]{64}$/;

export type ApprovedRuntimeRulesetCapability = typeof APPROVED_RUNTIME_RULESET_ALLOWED_CAPABILITIES[number];
export type ProhibitedRuntimeRulesetCapability = typeof APPROVED_RUNTIME_RULESET_PROHIBITED_CAPABILITIES[number];

export interface ApprovedRuntimeRulesetWorkScope {
  readonly work_id: string;
  /** Every cited source decision is bound to this same one work. */
  readonly source_decision_work_ids: Readonly<Record<string, string>>;
}

/** Opaque pins; this contract neither loads nor revalidates source decisions. */
export interface ApprovedRuntimeRulesetSourceDecisionPin {
  readonly source_publication_decision_hash: string;
  readonly reviewed_source_manifest_hash: string;
  readonly source_records_hash: string;
}

export interface ApprovedRuntimeRulesetApproval {
  readonly approver_class: "human";
  readonly approver_id: string;
  readonly approved_at: string;
}

export interface ApprovedRuntimeRulesetCapabilities {
  readonly allowed_capabilities: readonly ApprovedRuntimeRulesetCapability[];
  readonly prohibited_capabilities: readonly ProhibitedRuntimeRulesetCapability[];
}

export interface ApprovedRuntimeRulesetContractInput {
  readonly schema_version: typeof APPROVED_RUNTIME_RULESET_CONTRACT_SCHEMA_VERSION;
  readonly ruleset_id: string;
  readonly ruleset_version: string;
  readonly work_scope: ApprovedRuntimeRulesetWorkScope;
  /** Canonical identities of prior source decisions whose opaque pins appear below. */
  readonly source_publication_decision_hashes: readonly string[];
  /** Exact candidate set selected by those prior source decisions. */
  readonly source_candidate_ids: readonly string[];
  readonly source_publication_decisions: readonly ApprovedRuntimeRulesetSourceDecisionPin[];
  /** Identity pin only. This module does not load or execute evaluator code. */
  readonly deterministic_evaluator_artifact_hash: string;
  readonly test_fixture_artifact_hashes: readonly string[];
  readonly behavior_contract_hash: string;
  readonly approval: ApprovedRuntimeRulesetApproval;
  readonly runtime_capabilities: ApprovedRuntimeRulesetCapabilities;
}

export interface ApprovedRuntimeRulesetContract extends ApprovedRuntimeRulesetContractInput {
  readonly approved_ruleset_contract_hash: string;
}

type UnknownRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`invalid approved runtime ruleset contract: ${message}`);
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
  const timestamp = requiredString(value, "approval.approved_at");
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail("approval.approved_at must be an exact ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function validateSourceDecisions(value: unknown): ApprovedRuntimeRulesetSourceDecisionPin[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("source_publication_decisions must be a nonempty array");
  }
  const decisions = value.map((candidate, index) => {
    const decision = exactRecord(candidate, [
      "source_publication_decision_hash",
      "reviewed_source_manifest_hash",
      "source_records_hash",
    ], `source_publication_decisions[${index}]`);
    return {
      source_publication_decision_hash: hashPin(
        decision.source_publication_decision_hash,
        `source_publication_decisions[${index}].source_publication_decision_hash`,
      ),
      reviewed_source_manifest_hash: hashPin(
        decision.reviewed_source_manifest_hash,
        `source_publication_decisions[${index}].reviewed_source_manifest_hash`,
      ),
      source_records_hash: hashPin(
        decision.source_records_hash,
        `source_publication_decisions[${index}].source_records_hash`,
      ),
    };
  }).sort((left, right) => left.source_publication_decision_hash < right.source_publication_decision_hash
    ? -1
    : left.source_publication_decision_hash > right.source_publication_decision_hash ? 1 : 0);
  if (new Set(decisions.map((decision) => decision.source_publication_decision_hash)).size !== decisions.length) {
    fail("source_publication_decisions must not contain duplicate decision hashes");
  }
  return decisions;
}

function validateSourceDecisionHashes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("source_publication_decision_hashes must be a nonempty array");
  }
  const hashes = value.map((hash, index) => hashPin(
    hash,
    `source_publication_decision_hashes[${index}]`,
  )).sort();
  if (new Set(hashes).size !== hashes.length) {
    fail("source_publication_decision_hashes must not contain duplicates");
  }
  return hashes;
}

function validateSourceCandidateIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("source_candidate_ids must be a nonempty array");
  }
  const ids = value.map((id, index) => requiredString(id, `source_candidate_ids[${index}]`)).sort();
  if (new Set(ids).size !== ids.length) {
    fail("source_candidate_ids must not contain duplicates");
  }
  return ids;
}

function validateWorkScope(value: unknown, sourceDecisionHashes: readonly string[]): ApprovedRuntimeRulesetWorkScope {
  const scope = exactRecord(value, ["work_id", "source_decision_work_ids"], "work_scope");
  const workId = requiredString(scope.work_id, "work_scope.work_id");
  const sourceDecisionWorkIds = exactRecord(
    scope.source_decision_work_ids,
    sourceDecisionHashes,
    "work_scope.source_decision_work_ids",
  );
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const sourceDecisionHash of sourceDecisionHashes) {
    const sourceWorkId = requiredString(
      sourceDecisionWorkIds[sourceDecisionHash],
      `work_scope.source_decision_work_ids.${sourceDecisionHash}`,
    );
    if (sourceWorkId !== workId) {
      fail(`source publication decision ${sourceDecisionHash} is outside exact work scope`);
    }
    normalized[sourceDecisionHash] = sourceWorkId;
  }
  return { work_id: workId, source_decision_work_ids: normalized };
}

function validateFixtureHashes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("test_fixture_artifact_hashes must be a nonempty array");
  }
  const hashes = value.map((hash, index) => hashPin(hash, `test_fixture_artifact_hashes[${index}]`)).sort();
  if (new Set(hashes).size !== hashes.length) fail("test_fixture_artifact_hashes must not contain duplicates");
  return hashes;
}

function validateApproval(value: unknown): ApprovedRuntimeRulesetApproval {
  const approval = exactRecord(value, ["approver_class", "approver_id", "approved_at"], "approval");
  if (approval.approver_class !== "human") fail("approval.approver_class must be human");
  return {
    approver_class: "human",
    approver_id: requiredString(approval.approver_id, "approval.approver_id"),
    approved_at: validateTimestamp(approval.approved_at),
  };
}

function validateCapabilities(value: unknown): ApprovedRuntimeRulesetCapabilities {
  const capabilities = exactRecord(value, ["allowed_capabilities", "prohibited_capabilities"], "runtime_capabilities");
  if (!Array.isArray(capabilities.allowed_capabilities) || capabilities.allowed_capabilities.length === 0) {
    fail("runtime_capabilities.allowed_capabilities must be a nonempty array");
  }
  const allowed = capabilities.allowed_capabilities.map((capability, index) => {
    const name = requiredString(capability, `runtime_capabilities.allowed_capabilities[${index}]`);
    if (!(APPROVED_RUNTIME_RULESET_ALLOWED_CAPABILITIES as readonly string[]).includes(name)) {
      fail("runtime_capabilities.allowed_capabilities may contain only evaluate_action");
    }
    return name as ApprovedRuntimeRulesetCapability;
  }).sort();
  if (new Set(allowed).size !== allowed.length) {
    fail("runtime_capabilities.allowed_capabilities must not contain duplicates");
  }

  if (!Array.isArray(capabilities.prohibited_capabilities)) {
    fail("runtime_capabilities.prohibited_capabilities must be an array");
  }
  const prohibited = capabilities.prohibited_capabilities.map((capability, index) => requiredString(
    capability,
    `runtime_capabilities.prohibited_capabilities[${index}]`,
  )).sort();
  const required = [...APPROVED_RUNTIME_RULESET_PROHIBITED_CAPABILITIES].sort();
  if (prohibited.length !== required.length || prohibited.some((capability, index) => capability !== required[index])) {
    fail(`runtime_capabilities.prohibited_capabilities must be exactly ${required.join(", ")}`);
  }
  return {
    allowed_capabilities: allowed,
    prohibited_capabilities: required as ProhibitedRuntimeRulesetCapability[],
  };
}

function validateUnsigned(input: unknown): ApprovedRuntimeRulesetContractInput {
  const record = exactRecord(input, [
    "schema_version",
    "ruleset_id",
    "ruleset_version",
    "work_scope",
    "source_publication_decision_hashes",
    "source_candidate_ids",
    "source_publication_decisions",
    "deterministic_evaluator_artifact_hash",
    "test_fixture_artifact_hashes",
    "behavior_contract_hash",
    "approval",
    "runtime_capabilities",
  ], "contract");
  if (record.schema_version !== APPROVED_RUNTIME_RULESET_CONTRACT_SCHEMA_VERSION) {
    fail(`unsupported schema_version: ${String(record.schema_version)}`);
  }
  const sourcePublicationDecisionHashes = validateSourceDecisionHashes(record.source_publication_decision_hashes);
  const sourceCandidateIds = validateSourceCandidateIds(record.source_candidate_ids);
  const sourcePublicationDecisions = validateSourceDecisions(record.source_publication_decisions);
  const pinnedSourceDecisionHashes = sourcePublicationDecisions.map(
    (decision) => decision.source_publication_decision_hash,
  );
  if (sourcePublicationDecisionHashes.length !== pinnedSourceDecisionHashes.length
    || sourcePublicationDecisionHashes.some((hash, index) => hash !== pinnedSourceDecisionHashes[index])) {
    fail("source_publication_decision_hashes must exactly match source_publication_decisions");
  }
  return {
    schema_version: APPROVED_RUNTIME_RULESET_CONTRACT_SCHEMA_VERSION,
    ruleset_id: requiredString(record.ruleset_id, "ruleset_id"),
    ruleset_version: requiredString(record.ruleset_version, "ruleset_version"),
    work_scope: validateWorkScope(
      record.work_scope,
      sourcePublicationDecisionHashes,
    ),
    source_publication_decision_hashes: sourcePublicationDecisionHashes,
    source_candidate_ids: sourceCandidateIds,
    source_publication_decisions: sourcePublicationDecisions,
    deterministic_evaluator_artifact_hash: hashPin(
      record.deterministic_evaluator_artifact_hash,
      "deterministic_evaluator_artifact_hash",
    ),
    test_fixture_artifact_hashes: validateFixtureHashes(record.test_fixture_artifact_hashes),
    behavior_contract_hash: hashPin(record.behavior_contract_hash, "behavior_contract_hash"),
    approval: validateApproval(record.approval),
    runtime_capabilities: validateCapabilities(record.runtime_capabilities),
  };
}

/** Canonical integrity hash for an unsigned approved runtime ruleset contract. */
export function approvedRuntimeRulesetContractHash(input: ApprovedRuntimeRulesetContractInput): string {
  const contract = validateUnsigned(input);
  return createHash("sha256").update(HASH_DOMAIN).update(canonicalJson(contract)).digest("hex");
}

/** Validate, canonicalize, hash, and deep-freeze an isolated ruleset contract. */
export function createApprovedRuntimeRulesetContract(input: ApprovedRuntimeRulesetContractInput): ApprovedRuntimeRulesetContract {
  const contract = validateUnsigned(input);
  return deepFreeze({
    ...contract,
    approved_ruleset_contract_hash: approvedRuntimeRulesetContractHash(contract),
  });
}

/** Revalidate an existing ruleset contract and its canonical integrity hash. */
export function validateApprovedRuntimeRulesetContract(input: unknown): ApprovedRuntimeRulesetContract {
  const record = exactRecord(input, [
    "schema_version",
    "ruleset_id",
    "ruleset_version",
    "work_scope",
    "source_publication_decision_hashes",
    "source_candidate_ids",
    "source_publication_decisions",
    "deterministic_evaluator_artifact_hash",
    "test_fixture_artifact_hashes",
    "behavior_contract_hash",
    "approval",
    "runtime_capabilities",
    "approved_ruleset_contract_hash",
  ], "contract");
  const contractHash = hashPin(record.approved_ruleset_contract_hash, "approved_ruleset_contract_hash");
  const { approved_ruleset_contract_hash: _contractHash, ...unsigned } = record;
  const contract = validateUnsigned(unsigned);
  if (contractHash !== approvedRuntimeRulesetContractHash(contract)) {
    fail("approved_ruleset_contract_hash does not match canonical contract payload");
  }
  return deepFreeze({ ...contract, approved_ruleset_contract_hash: contractHash });
}
