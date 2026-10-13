import { describe, expect, it } from "bun:test";
import {
  SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION,
  createSourcePublicationDecision,
  sourcePublicationDecisionHash,
  validateSourcePublicationDecision,
  type SourcePublicationDecisionInput,
} from "../compiler/source-publication-decision";

const manifestHash = "a".repeat(64);
const recordsHash = "b".repeat(64);
const rulesetHash = "c".repeat(64);

function researchDecision(overrides: Partial<SourcePublicationDecisionInput> = {}): SourcePublicationDecisionInput {
  return {
    schema_version: SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION,
    decision_kind: "research_lookup_admission",
    reviewed_source_manifest_hash: manifestHash,
    source_records_hash: recordsHash,
    selected_candidate_ids: ["candidate-a"],
    work_scope: { work_id: "work-a", candidate_work_ids: { "candidate-a": "work-a" } },
    decision_authority: { authority_class: "delegated_assistant", authority_id: "research-worker-7" },
    timestamp: "2026-10-05T12:00:00.000Z",
    supersedes: null,
    runtime_effect: false,
    approved_ruleset_contract_hash: null,
    ...overrides,
  };
}

describe("source publication decision", () => {
  it("creates an immutable research lookup admission bound to exact reviewed source pins", () => {
    const selectedCandidateIds = ["candidate-a"];
    const input = researchDecision({ selected_candidate_ids: selectedCandidateIds });
    const decision = createSourcePublicationDecision(input);

    expect(decision.decision_hash).toBe(sourcePublicationDecisionHash(input));
    expect(validateSourcePublicationDecision(decision)).toEqual(decision);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.selected_candidate_ids)).toBe(true);
    expect(Object.isFrozen(decision.work_scope)).toBe(true);
    expect(Object.isFrozen(decision.work_scope.candidate_work_ids)).toBe(true);
    expect(Object.isFrozen(decision.decision_authority)).toBe(true);
    expect(() => (decision.selected_candidate_ids as string[]).push("candidate-b")).toThrow();

    selectedCandidateIds[0] = "candidate-forgery";
    expect(decision.selected_candidate_ids).toEqual(["candidate-a"]);
  });

  it("rejects empty work scope and missing reviewed-source pins", () => {
    expect(() => createSourcePublicationDecision(researchDecision({
      work_scope: { work_id: "", candidate_work_ids: { "candidate-a": "" } },
    }))).toThrow("work_scope.work_id must be a nonempty string");

    for (const pin of ["reviewed_source_manifest_hash", "source_records_hash"] as const) {
      expect(() => createSourcePublicationDecision({ ...researchDecision(), [pin]: "" })).toThrow(`${pin} must be a nonempty string`);
    }
  });

  it("rejects candidate selections outside the exact one-work scope", () => {
    expect(() => createSourcePublicationDecision(researchDecision({
      selected_candidate_ids: ["candidate-a", "candidate-b"],
      work_scope: {
        work_id: "work-a",
        candidate_work_ids: { "candidate-a": "work-a", "candidate-b": "work-b" },
      },
    }))).toThrow("candidate candidate-b is outside exact work scope");
  });

  it("rejects a delegated assistant attempting runtime activation", () => {
    expect(() => createSourcePublicationDecision(researchDecision({
      decision_kind: "runtime_rule_admission",
      runtime_effect: true,
      approved_ruleset_contract_hash: rulesetHash,
    }))).toThrow("only human decision authority can set runtime_effect=true");
  });

  it("permits a lead_model research lookup admission but rejects runtime activation", () => {
    const leadModel = { authority_class: "lead_model", authority_id: "lead-model-1" } as const;
    const research = createSourcePublicationDecision(researchDecision({ decision_authority: leadModel }));

    expect(research.decision_authority).toEqual(leadModel);
    expect(() => createSourcePublicationDecision(researchDecision({
      decision_kind: "runtime_rule_admission",
      decision_authority: leadModel,
      runtime_effect: true,
      approved_ruleset_contract_hash: rulesetHash,
    }))).toThrow("only human decision authority can set runtime_effect=true");
  });

  it("rejects an unsigned runtime rule admission", () => {
    expect(() => createSourcePublicationDecision(researchDecision({
      decision_kind: "runtime_rule_admission",
      decision_authority: { authority_class: "human", authority_id: "reviewer-1" },
      runtime_effect: true,
      approved_ruleset_contract_hash: null,
    }))).toThrow("runtime_rule_admission requires approved_ruleset_contract_hash");
  });

  it("permits only a human-approved, separately pinned runtime rule admission", () => {
    const decision = createSourcePublicationDecision(researchDecision({
      decision_kind: "runtime_rule_admission",
      decision_authority: { authority_class: "human", authority_id: "reviewer-1" },
      runtime_effect: true,
      approved_ruleset_contract_hash: rulesetHash,
    }));

    expect(decision).toMatchObject({
      decision_kind: "runtime_rule_admission",
      runtime_effect: true,
      approved_ruleset_contract_hash: rulesetHash,
    });
  });
});
