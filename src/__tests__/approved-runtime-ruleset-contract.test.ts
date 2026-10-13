import { describe, expect, it } from "bun:test";
import {
  APPROVED_RUNTIME_RULESET_CONTRACT_SCHEMA_VERSION,
  APPROVED_RUNTIME_RULESET_PROHIBITED_CAPABILITIES,
  approvedRuntimeRulesetContractHash,
  createApprovedRuntimeRulesetContract,
  validateApprovedRuntimeRulesetContract,
  type ApprovedRuntimeRulesetContractInput,
} from "../compiler/approved-runtime-ruleset-contract";

const sourceDecisionHash = "a".repeat(64);
const manifestHash = "b".repeat(64);
const recordsHash = "c".repeat(64);
const evaluatorHash = "d".repeat(64);
const behaviorHash = "e".repeat(64);
const fixtureHash = "f".repeat(64);
const secondFixtureHash = "1".repeat(64);

function contract(overrides: Partial<ApprovedRuntimeRulesetContractInput> = {}): ApprovedRuntimeRulesetContractInput {
  return {
    schema_version: APPROVED_RUNTIME_RULESET_CONTRACT_SCHEMA_VERSION,
    ruleset_id: "call-of-cthulhu-7e",
    ruleset_version: "7.0.0",
    work_scope: {
      work_id: "work-a",
      source_decision_work_ids: { [sourceDecisionHash]: "work-a" },
    },
    source_publication_decision_hashes: [sourceDecisionHash],
    source_candidate_ids: ["candidate-a"],
    source_publication_decisions: [{
      source_publication_decision_hash: sourceDecisionHash,
      reviewed_source_manifest_hash: manifestHash,
      source_records_hash: recordsHash,
    }],
    deterministic_evaluator_artifact_hash: evaluatorHash,
    test_fixture_artifact_hashes: [fixtureHash, secondFixtureHash],
    behavior_contract_hash: behaviorHash,
    approval: {
      approver_class: "human",
      approver_id: "reviewer-1",
      approved_at: "2026-10-05T12:00:00.000Z",
    },
    runtime_capabilities: {
      allowed_capabilities: ["evaluate_action"],
      prohibited_capabilities: [...APPROVED_RUNTIME_RULESET_PROHIBITED_CAPABILITIES],
    },
    ...overrides,
  };
}

describe("approved runtime ruleset contract", () => {
  it("creates an immutable, canonical hash artifact for one reviewed work", () => {
    const fixtureHashes = [fixtureHash, secondFixtureHash];
    const input = contract({ test_fixture_artifact_hashes: fixtureHashes });
    const approved = createApprovedRuntimeRulesetContract(input);

    expect(approved.approved_ruleset_contract_hash).toBe(approvedRuntimeRulesetContractHash(input));
    expect(validateApprovedRuntimeRulesetContract(approved)).toEqual(approved);
    expect(approved.test_fixture_artifact_hashes).toEqual([secondFixtureHash, fixtureHash]);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(Object.isFrozen(approved.work_scope)).toBe(true);
    expect(Object.isFrozen(approved.work_scope.source_decision_work_ids)).toBe(true);
    expect(Object.isFrozen(approved.source_publication_decision_hashes)).toBe(true);
    expect(Object.isFrozen(approved.source_candidate_ids)).toBe(true);
    expect(Object.isFrozen(approved.source_publication_decisions)).toBe(true);
    expect(Object.isFrozen(approved.source_publication_decisions[0]!)).toBe(true);
    expect(Object.isFrozen(approved.runtime_capabilities)).toBe(true);
    expect(() => (approved.test_fixture_artifact_hashes as string[]).push("0".repeat(64))).toThrow();

    fixtureHashes[0] = "0".repeat(64);
    expect(approved.test_fixture_artifact_hashes).toEqual([secondFixtureHash, fixtureHash]);
  });

  it("rejects a delegated approver", () => {
    expect(() => createApprovedRuntimeRulesetContract(contract({
      approval: {
        approver_class: "delegated_assistant",
        approver_id: "agent-7",
        approved_at: "2026-10-05T12:00:00.000Z",
      } as unknown as ApprovedRuntimeRulesetContractInput["approval"],
    }))).toThrow("approval.approver_class must be human");
  });

  it("rejects missing test fixture pins", () => {
    expect(() => createApprovedRuntimeRulesetContract(contract({
      test_fixture_artifact_hashes: [],
    }))).toThrow("test_fixture_artifact_hashes must be a nonempty array");
  });

  it("requires source decisions and the exact prohibited-capability set", () => {
    expect(() => createApprovedRuntimeRulesetContract(contract({
      source_publication_decisions: [],
    }))).toThrow("source_publication_decisions must be a nonempty array");
    expect(() => createApprovedRuntimeRulesetContract(contract({
      source_candidate_ids: [],
    }))).toThrow("source_candidate_ids must be a nonempty array");
    expect(() => createApprovedRuntimeRulesetContract(contract({
      runtime_capabilities: {
        allowed_capabilities: ["evaluate_action"],
        prohibited_capabilities: APPROVED_RUNTIME_RULESET_PROHIBITED_CAPABILITIES.slice(1),
      },
    }))).toThrow("runtime_capabilities.prohibited_capabilities must be exactly");
  });

  it("rejects capabilities outside the narrow allowlist", () => {
    expect(() => createApprovedRuntimeRulesetContract(contract({
      runtime_capabilities: {
        allowed_capabilities: ["evaluate_action", "state_mutation"] as unknown as ["evaluate_action"],
        prohibited_capabilities: [...APPROVED_RUNTIME_RULESET_PROHIBITED_CAPABILITIES],
      },
    }))).toThrow("runtime_capabilities.allowed_capabilities may contain only evaluate_action");
  });

  it("rejects a source decision from another work", () => {
    expect(() => createApprovedRuntimeRulesetContract(contract({
      work_scope: {
        work_id: "work-a",
        source_decision_work_ids: { [sourceDecisionHash]: "work-b" },
      },
    }))).toThrow("is outside exact work scope");
  });

  it("requires explicit source decision hashes to match the opaque source pins", () => {
    expect(() => createApprovedRuntimeRulesetContract(contract({
      source_publication_decision_hashes: ["0".repeat(64)],
    }))).toThrow("source_publication_decision_hashes must exactly match source_publication_decisions");
  });

  it("rejects an artifact whose payload no longer matches its pinned hash", () => {
    const approved = createApprovedRuntimeRulesetContract(contract());
    expect(() => validateApprovedRuntimeRulesetContract({
      ...approved,
      behavior_contract_hash: "0".repeat(64),
    })).toThrow("approved_ruleset_contract_hash does not match canonical contract payload");
  });

  it("rejects unknown fields and non-lowercase hash pins", () => {
    expect(() => createApprovedRuntimeRulesetContract({
      ...contract(),
      unexpected: true,
    } as unknown as ApprovedRuntimeRulesetContractInput)).toThrow("contract has unexpected fields");
    expect(() => createApprovedRuntimeRulesetContract(contract({
      behavior_contract_hash: "E".repeat(64),
    }))).toThrow("behavior_contract_hash must be a lowercase sha256 hash");
  });
});
