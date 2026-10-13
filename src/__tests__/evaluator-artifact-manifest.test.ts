import { describe, expect, it } from "bun:test";
import {
  EVALUATOR_ARTIFACT_MANIFEST_FORBIDDEN_CAPABILITIES,
  EVALUATOR_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  createEvaluatorArtifactManifest,
  evaluatorArtifactManifestHash,
  toApprovedRuntimeRulesetContractArtifactPins,
  validateEvaluatorArtifactManifest,
  type EvaluatorArtifactManifestInput,
} from "../compiler/evaluator-artifact-manifest";
import type { ApprovedRuntimeRulesetContractInput } from "../compiler/approved-runtime-ruleset-contract";

const evaluatorHash = "a".repeat(64);
const fixtureHash = "b".repeat(64);
const behaviorHash = "c".repeat(64);
const inputSchemaHash = "d".repeat(64);
const outputSchemaHash = "e".repeat(64);

function manifest(overrides: Partial<EvaluatorArtifactManifestInput> = {}): EvaluatorArtifactManifestInput {
  return {
    schema_version: EVALUATOR_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    evaluator_id: "compiler-evaluate-action",
    evaluator_version: "1.0.0",
    evaluator_capabilities: {
      allowed_capabilities: ["evaluate_action"],
      forbidden_capabilities: [...EVALUATOR_ARTIFACT_MANIFEST_FORBIDDEN_CAPABILITIES],
    },
    evaluator_artifact_hash: evaluatorHash,
    fixture_artifact_hash: fixtureHash,
    behavior_contract_hash: behaviorHash,
    evaluator_input_schema_hash: inputSchemaHash,
    evaluator_output_schema_hash: outputSchemaHash,
    source_revision_or_build_identifier: "git:0123456789abcdef",
    reproducibility_statement: "All artifact and schema SHA-256 pins are supplied by the caller or build.",
    ...overrides,
  };
}

describe("evaluator artifact manifest", () => {
  it("creates a canonical, deep-frozen manifest with deterministic hash pins", () => {
    const input = manifest({
      evaluator_capabilities: {
        allowed_capabilities: ["evaluate_action"],
        forbidden_capabilities: [...EVALUATOR_ARTIFACT_MANIFEST_FORBIDDEN_CAPABILITIES].reverse(),
      },
    });
    const created = createEvaluatorArtifactManifest(input);
    const canonical = createEvaluatorArtifactManifest(manifest());
    const contractPins: Pick<ApprovedRuntimeRulesetContractInput,
      "deterministic_evaluator_artifact_hash" | "test_fixture_artifact_hashes" | "behavior_contract_hash"
    > = toApprovedRuntimeRulesetContractArtifactPins(created);

    expect(created.evaluator_artifact_manifest_hash).toBe(evaluatorArtifactManifestHash(input));
    expect(created.evaluator_artifact_manifest_hash).toBe(canonical.evaluator_artifact_manifest_hash);
    expect(validateEvaluatorArtifactManifest(created)).toEqual(created);
    expect(contractPins).toEqual({
      deterministic_evaluator_artifact_hash: evaluatorHash,
      test_fixture_artifact_hashes: [fixtureHash],
      behavior_contract_hash: behaviorHash,
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.evaluator_capabilities)).toBe(true);
    expect(Object.isFrozen(created.evaluator_capabilities.forbidden_capabilities)).toBe(true);
    expect(Object.isFrozen(contractPins)).toBe(true);
    expect(() => (created.evaluator_capabilities.forbidden_capabilities as string[]).pop()).toThrow();
  });

  it("rejects malformed hash pins", () => {
    expect(() => createEvaluatorArtifactManifest(manifest({
      fixture_artifact_hash: "B".repeat(64),
    }))).toThrow("fixture_artifact_hash must be a lowercase sha256 hash");
  });

  it("rejects expanded allowed capabilities", () => {
    expect(() => createEvaluatorArtifactManifest(manifest({
      evaluator_capabilities: {
        allowed_capabilities: ["evaluate_action", "network"] as unknown as ["evaluate_action"],
        forbidden_capabilities: [...EVALUATOR_ARTIFACT_MANIFEST_FORBIDDEN_CAPABILITIES],
      },
    }))).toThrow("evaluator_capabilities.allowed_capabilities must be exactly evaluate_action");
  });

  it("requires every explicit forbidden capability", () => {
    expect(() => createEvaluatorArtifactManifest(manifest({
      evaluator_capabilities: {
        allowed_capabilities: ["evaluate_action"],
        forbidden_capabilities: EVALUATOR_ARTIFACT_MANIFEST_FORBIDDEN_CAPABILITIES.slice(1),
      },
    }))).toThrow("evaluator_capabilities.forbidden_capabilities must be exactly");
  });

  it("rejects unknown fields and a manifest tampered after hashing", () => {
    expect(() => createEvaluatorArtifactManifest({
      ...manifest(),
      unexpected: true,
    } as unknown as EvaluatorArtifactManifestInput)).toThrow("manifest has unexpected fields");

    const created = createEvaluatorArtifactManifest(manifest());
    expect(() => validateEvaluatorArtifactManifest({
      ...created,
      source_revision_or_build_identifier: "git:changed",
    })).toThrow("evaluator_artifact_manifest_hash does not match canonical manifest payload");
  });
});
