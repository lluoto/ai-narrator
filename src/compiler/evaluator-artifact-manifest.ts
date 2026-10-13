import { createHash } from "node:crypto";

export const EVALUATOR_ARTIFACT_MANIFEST_SCHEMA_VERSION = "1.0.0" as const;
export const EVALUATOR_ARTIFACT_MANIFEST_ALLOWED_CAPABILITIES = ["evaluate_action"] as const;
export const EVALUATOR_ARTIFACT_MANIFEST_FORBIDDEN_CAPABILITIES = [
  "state_mutation",
  "persistence_write",
  "filesystem_read",
  "filesystem_write",
  "runtime_rule_execution",
  "runtime_wiring",
  "cross_work_merge",
  "prompt_injection",
  "tool_call",
  "network",
] as const;

const HASH_DOMAIN = "aitrpg:evaluator-artifact-manifest:v1\0";
const SHA256 = /^[a-f0-9]{64}$/;

export type EvaluatorArtifactManifestCapability = typeof EVALUATOR_ARTIFACT_MANIFEST_ALLOWED_CAPABILITIES[number];
export type EvaluatorArtifactManifestForbiddenCapability = typeof EVALUATOR_ARTIFACT_MANIFEST_FORBIDDEN_CAPABILITIES[number];

export interface EvaluatorArtifactManifestCapabilities {
  readonly allowed_capabilities: readonly EvaluatorArtifactManifestCapability[];
  readonly forbidden_capabilities: readonly EvaluatorArtifactManifestForbiddenCapability[];
}

/**
 * All SHA-256 values are caller/build-supplied opaque pins. This module never
 * loads an artifact, serializes a fixture report, or invokes an evaluator.
 */
export interface EvaluatorArtifactManifestInput {
  readonly schema_version: typeof EVALUATOR_ARTIFACT_MANIFEST_SCHEMA_VERSION;
  readonly evaluator_id: string;
  readonly evaluator_version: string;
  readonly evaluator_capabilities: EvaluatorArtifactManifestCapabilities;
  /** SHA-256 of the evaluator implementation artifact supplied by the build. */
  readonly evaluator_artifact_hash: string;
  /** SHA-256 of an externally serialized fixture-runner report. */
  readonly fixture_artifact_hash: string;
  readonly behavior_contract_hash: string;
  readonly evaluator_input_schema_hash: string;
  readonly evaluator_output_schema_hash: string;
  /** A source revision or reproducible build identifier supplied by the build. */
  readonly source_revision_or_build_identifier: string;
  readonly reproducibility_statement: string;
}

export interface EvaluatorArtifactManifest extends EvaluatorArtifactManifestInput {
  readonly evaluator_artifact_manifest_hash: string;
}

/** The three fields accepted by the current ApprovedRuntimeRulesetContract input. */
export interface ApprovedRuntimeRulesetContractArtifactPins {
  readonly deterministic_evaluator_artifact_hash: string;
  readonly test_fixture_artifact_hashes: readonly [string];
  readonly behavior_contract_hash: string;
}

type UnknownRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`invalid evaluator artifact manifest: ${message}`);
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (!isPlainRecord(value)) fail(`${label} must be an object`);
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some((key) => typeof key !== "string")) fail(`${label} has unexpected fields`);
  const actual = actualKeys as string[];
  const expected = [...keys].sort();
  actual.sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected fields`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    fail(`${label} must be a trimmed nonempty string`);
  }
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
  if (!value || typeof value !== "object") return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function validateCapabilities(value: unknown): EvaluatorArtifactManifestCapabilities {
  const capabilities = exactRecord(value, ["allowed_capabilities", "forbidden_capabilities"], "evaluator_capabilities");
  if (!Array.isArray(capabilities.allowed_capabilities)) {
    fail("evaluator_capabilities.allowed_capabilities must be an array");
  }
  const allowed = capabilities.allowed_capabilities.map((capability, index) => {
    const name = requiredString(capability, `evaluator_capabilities.allowed_capabilities[${index}]`);
    if (!(EVALUATOR_ARTIFACT_MANIFEST_ALLOWED_CAPABILITIES as readonly string[]).includes(name)) {
      fail("evaluator_capabilities.allowed_capabilities must be exactly evaluate_action");
    }
    return name as EvaluatorArtifactManifestCapability;
  }).sort();
  if (allowed.length !== 1 || allowed[0] !== "evaluate_action") {
    fail("evaluator_capabilities.allowed_capabilities must be exactly evaluate_action");
  }

  if (!Array.isArray(capabilities.forbidden_capabilities)) {
    fail("evaluator_capabilities.forbidden_capabilities must be an array");
  }
  const forbidden = capabilities.forbidden_capabilities.map((capability, index) => requiredString(
    capability,
    `evaluator_capabilities.forbidden_capabilities[${index}]`,
  )).sort();
  const required = [...EVALUATOR_ARTIFACT_MANIFEST_FORBIDDEN_CAPABILITIES].sort();
  if (forbidden.length !== required.length || forbidden.some((capability, index) => capability !== required[index])) {
    fail(`evaluator_capabilities.forbidden_capabilities must be exactly ${required.join(", ")}`);
  }
  return {
    allowed_capabilities: ["evaluate_action"],
    forbidden_capabilities: required as EvaluatorArtifactManifestForbiddenCapability[],
  };
}

function validateUnsigned(input: unknown): EvaluatorArtifactManifestInput {
  const record = exactRecord(input, [
    "schema_version",
    "evaluator_id",
    "evaluator_version",
    "evaluator_capabilities",
    "evaluator_artifact_hash",
    "fixture_artifact_hash",
    "behavior_contract_hash",
    "evaluator_input_schema_hash",
    "evaluator_output_schema_hash",
    "source_revision_or_build_identifier",
    "reproducibility_statement",
  ], "manifest");
  if (record.schema_version !== EVALUATOR_ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    fail(`unsupported schema_version: ${String(record.schema_version)}`);
  }
  return {
    schema_version: EVALUATOR_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    evaluator_id: requiredString(record.evaluator_id, "evaluator_id"),
    evaluator_version: requiredString(record.evaluator_version, "evaluator_version"),
    evaluator_capabilities: validateCapabilities(record.evaluator_capabilities),
    evaluator_artifact_hash: hashPin(record.evaluator_artifact_hash, "evaluator_artifact_hash"),
    fixture_artifact_hash: hashPin(record.fixture_artifact_hash, "fixture_artifact_hash"),
    behavior_contract_hash: hashPin(record.behavior_contract_hash, "behavior_contract_hash"),
    evaluator_input_schema_hash: hashPin(record.evaluator_input_schema_hash, "evaluator_input_schema_hash"),
    evaluator_output_schema_hash: hashPin(record.evaluator_output_schema_hash, "evaluator_output_schema_hash"),
    source_revision_or_build_identifier: requiredString(
      record.source_revision_or_build_identifier,
      "source_revision_or_build_identifier",
    ),
    reproducibility_statement: requiredString(record.reproducibility_statement, "reproducibility_statement"),
  };
}

/** Canonical integrity hash for an unsigned evaluator artifact manifest. */
export function evaluatorArtifactManifestHash(input: EvaluatorArtifactManifestInput): string {
  const manifest = validateUnsigned(input);
  return createHash("sha256").update(HASH_DOMAIN).update(canonicalJson(manifest)).digest("hex");
}

/** Validate, canonicalize, hash, and deep-freeze an evaluator artifact manifest. */
export function createEvaluatorArtifactManifest(input: EvaluatorArtifactManifestInput): EvaluatorArtifactManifest {
  const manifest = validateUnsigned(input);
  return deepFreeze({
    ...manifest,
    evaluator_artifact_manifest_hash: evaluatorArtifactManifestHash(manifest),
  });
}

/** Revalidate an existing manifest and its canonical integrity hash. */
export function validateEvaluatorArtifactManifest(input: unknown): EvaluatorArtifactManifest {
  const record = exactRecord(input, [
    "schema_version",
    "evaluator_id",
    "evaluator_version",
    "evaluator_capabilities",
    "evaluator_artifact_hash",
    "fixture_artifact_hash",
    "behavior_contract_hash",
    "evaluator_input_schema_hash",
    "evaluator_output_schema_hash",
    "source_revision_or_build_identifier",
    "reproducibility_statement",
    "evaluator_artifact_manifest_hash",
  ], "manifest");
  const manifestHash = hashPin(record.evaluator_artifact_manifest_hash, "evaluator_artifact_manifest_hash");
  const { evaluator_artifact_manifest_hash: _manifestHash, ...unsigned } = record;
  const manifest = validateUnsigned(unsigned);
  if (manifestHash !== evaluatorArtifactManifestHash(manifest)) {
    fail("evaluator_artifact_manifest_hash does not match canonical manifest payload");
  }
  return deepFreeze({ ...manifest, evaluator_artifact_manifest_hash: manifestHash });
}

/**
 * Returns the three pins in the shape accepted by ApprovedRuntimeRulesetContract
 * without importing, loading, or changing that contract.
 */
export function toApprovedRuntimeRulesetContractArtifactPins(input: unknown): ApprovedRuntimeRulesetContractArtifactPins {
  const manifest = validateEvaluatorArtifactManifest(input);
  return deepFreeze({
    deterministic_evaluator_artifact_hash: manifest.evaluator_artifact_hash,
    test_fixture_artifact_hashes: [manifest.fixture_artifact_hash] as [string],
    behavior_contract_hash: manifest.behavior_contract_hash,
  });
}
