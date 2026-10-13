import { describe, expect, it } from "bun:test";
import {
  APPROVED_RUNTIME_RULESET_CONTRACT_SCHEMA_VERSION,
  APPROVED_RUNTIME_RULESET_PROHIBITED_CAPABILITIES,
  createApprovedRuntimeRulesetContract,
  type ApprovedRuntimeRulesetContractInput,
} from "../compiler/approved-runtime-ruleset-contract";
import {
  SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION,
  createSourcePublicationDecision,
  type SourcePublicationDecision,
  type SourcePublicationDecisionInput,
} from "../compiler/source-publication-decision";
import { validateRuntimeRuleAdmissionLink } from "../compiler/runtime-rule-admission-link";

const manifestHash = "a".repeat(64);
const recordsHash = "b".repeat(64);
const evaluatorHash = "c".repeat(64);
const fixtureHash = "d".repeat(64);
const behaviorHash = "e".repeat(64);

function researchDecision(overrides: Partial<SourcePublicationDecisionInput> = {}): SourcePublicationDecision {
  return createSourcePublicationDecision({
    schema_version: SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION,
    decision_kind: "research_lookup_admission",
    reviewed_source_manifest_hash: manifestHash,
    source_records_hash: recordsHash,
    selected_candidate_ids: ["candidate-a", "candidate-b"],
    work_scope: {
      work_id: "work-a",
      candidate_work_ids: { "candidate-a": "work-a", "candidate-b": "work-a" },
    },
    decision_authority: { authority_class: "delegated_assistant", authority_id: "researcher-1" },
    timestamp: "2026-10-05T12:00:00.000Z",
    supersedes: null,
    runtime_effect: false,
    approved_ruleset_contract_hash: null,
    ...overrides,
  });
}

function rulesetContractInput(
  sourceDecision: SourcePublicationDecision,
  overrides: Partial<ApprovedRuntimeRulesetContractInput> = {},
): ApprovedRuntimeRulesetContractInput {
  return {
    schema_version: APPROVED_RUNTIME_RULESET_CONTRACT_SCHEMA_VERSION,
    ruleset_id: "call-of-cthulhu-7e",
    ruleset_version: "7.0.0",
    work_scope: {
      work_id: sourceDecision.work_scope.work_id,
      source_decision_work_ids: { [sourceDecision.decision_hash]: sourceDecision.work_scope.work_id },
    },
    source_publication_decision_hashes: [sourceDecision.decision_hash],
    source_candidate_ids: [...sourceDecision.selected_candidate_ids],
    source_publication_decisions: [{
      source_publication_decision_hash: sourceDecision.decision_hash,
      reviewed_source_manifest_hash: sourceDecision.reviewed_source_manifest_hash,
      source_records_hash: sourceDecision.source_records_hash,
    }],
    deterministic_evaluator_artifact_hash: evaluatorHash,
    test_fixture_artifact_hashes: [fixtureHash],
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

function runtimeDecision(
  sourceDecision: SourcePublicationDecision,
  approvedRulesetContractHash: string,
  overrides: Partial<SourcePublicationDecisionInput> = {},
): SourcePublicationDecision {
  return createSourcePublicationDecision({
    schema_version: SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION,
    decision_kind: "runtime_rule_admission",
    reviewed_source_manifest_hash: sourceDecision.reviewed_source_manifest_hash,
    source_records_hash: sourceDecision.source_records_hash,
    selected_candidate_ids: [...sourceDecision.selected_candidate_ids],
    work_scope: {
      work_id: sourceDecision.work_scope.work_id,
      candidate_work_ids: { ...sourceDecision.work_scope.candidate_work_ids },
    },
    decision_authority: { authority_class: "human", authority_id: "reviewer-1" },
    timestamp: "2026-10-05T12:00:01.000Z",
    supersedes: null,
    runtime_effect: true,
    approved_ruleset_contract_hash: approvedRulesetContractHash,
    ...overrides,
  });
}

describe("runtime rule admission link", () => {
  it("returns an immutable receipt for an acyclic matching evidence chain", () => {
    const sourceDecision = researchDecision();
    const contract = createApprovedRuntimeRulesetContract(rulesetContractInput(sourceDecision));
    const decision = runtimeDecision(sourceDecision, contract.approved_ruleset_contract_hash);

    const receipt = validateRuntimeRuleAdmissionLink(decision, contract);

    expect(receipt).toEqual({
      receipt_kind: "runtime_rule_admission_link_validation",
      decision_hash: decision.decision_hash,
      approved_ruleset_contract_hash: contract.approved_ruleset_contract_hash,
      work_id: "work-a",
    });
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("rejects a final admission pinned to another ruleset contract hash", () => {
    const sourceDecision = researchDecision();
    const contract = createApprovedRuntimeRulesetContract(rulesetContractInput(sourceDecision));
    const decision = runtimeDecision(sourceDecision, "0".repeat(64));

    expect(() => validateRuntimeRuleAdmissionLink(decision, contract)).toThrow(
      "decision approved_ruleset_contract_hash does not match the canonical ruleset contract hash",
    );
  });

  it("rejects mismatched work scope", () => {
    const sourceDecision = researchDecision();
    const contract = createApprovedRuntimeRulesetContract(rulesetContractInput(sourceDecision, {
      work_scope: {
        work_id: "work-b",
        source_decision_work_ids: { [sourceDecision.decision_hash]: "work-b" },
      },
    }));
    const decision = runtimeDecision(sourceDecision, contract.approved_ruleset_contract_hash);

    expect(() => validateRuntimeRuleAdmissionLink(decision, contract)).toThrow(
      "decision and ruleset contract work scopes must match exactly",
    );
  });

  it("rejects mismatched source pins", () => {
    const sourceDecision = researchDecision();
    const contract = createApprovedRuntimeRulesetContract(rulesetContractInput(sourceDecision, {
      source_publication_decisions: [{
        source_publication_decision_hash: sourceDecision.decision_hash,
        reviewed_source_manifest_hash: "f".repeat(64),
        source_records_hash: sourceDecision.source_records_hash,
      }],
    }));
    const decision = runtimeDecision(sourceDecision, contract.approved_ruleset_contract_hash);

    expect(() => validateRuntimeRuleAdmissionLink(decision, contract)).toThrow(
      "decision reviewed source pins must exactly match ruleset contract source pins",
    );
  });

  it("rejects mismatched source candidate IDs", () => {
    const sourceDecision = researchDecision();
    const contract = createApprovedRuntimeRulesetContract(rulesetContractInput(sourceDecision, {
      source_candidate_ids: ["candidate-a", "candidate-c"],
    }));
    const decision = runtimeDecision(sourceDecision, contract.approved_ruleset_contract_hash);

    expect(() => validateRuntimeRuleAdmissionLink(decision, contract)).toThrow(
      "decision selected candidate IDs must exactly match ruleset contract source candidate IDs",
    );
  });

  it("rejects a research decision even when it cites the contract hash", () => {
    const sourceDecision = researchDecision();
    const contract = createApprovedRuntimeRulesetContract(rulesetContractInput(sourceDecision));
    const decision = researchDecision({ approved_ruleset_contract_hash: contract.approved_ruleset_contract_hash });

    expect(() => validateRuntimeRuleAdmissionLink(decision, contract)).toThrow(
      "decision must be a runtime_rule_admission",
    );
  });

  it("rejects a contract that explicitly includes the final admission hash", () => {
    const sourceDecision = researchDecision();
    const contract = createApprovedRuntimeRulesetContract(rulesetContractInput(sourceDecision));
    const decision = runtimeDecision(sourceDecision, contract.approved_ruleset_contract_hash);
    const cyclicContract = createApprovedRuntimeRulesetContract(rulesetContractInput(sourceDecision, {
      work_scope: {
        work_id: "work-a",
        source_decision_work_ids: {
          [sourceDecision.decision_hash]: "work-a",
          [decision.decision_hash]: "work-a",
        },
      },
      source_publication_decision_hashes: [sourceDecision.decision_hash, decision.decision_hash],
      source_publication_decisions: [
        {
          source_publication_decision_hash: sourceDecision.decision_hash,
          reviewed_source_manifest_hash: sourceDecision.reviewed_source_manifest_hash,
          source_records_hash: sourceDecision.source_records_hash,
        },
        {
          source_publication_decision_hash: decision.decision_hash,
          reviewed_source_manifest_hash: decision.reviewed_source_manifest_hash,
          source_records_hash: decision.source_records_hash,
        },
      ],
    }));

    expect(() => validateRuntimeRuleAdmissionLink(decision, cyclicContract)).toThrow(
      "ruleset contract must not include the final runtime admission decision_hash",
    );
  });
});
