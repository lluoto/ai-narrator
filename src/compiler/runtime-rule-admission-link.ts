import {
  approvedRuntimeRulesetContractHash,
  validateApprovedRuntimeRulesetContract,
} from "./approved-runtime-ruleset-contract";
import { validateSourcePublicationDecision } from "./source-publication-decision";

export interface RuntimeRuleAdmissionLinkReceipt {
  /** Identifies this as validation evidence, never as runtime activation. */
  readonly receipt_kind: "runtime_rule_admission_link_validation";
  readonly decision_hash: string;
  readonly approved_ruleset_contract_hash: string;
  readonly work_id: string;
}

function fail(message: string): never {
  throw new Error(`invalid runtime rule admission link: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  Object.freeze(value);
  return value;
}

/**
 * Validates the static evidence link between a final runtime admission and an
 * approved ruleset contract. The receipt is validation evidence only; it does
 * not activate, load, execute, or authorize any runtime behavior.
 */
export function validateRuntimeRuleAdmissionLink(
  decision: unknown,
  rulesetContract: unknown,
): RuntimeRuleAdmissionLinkReceipt {
  const validatedDecision = validateSourcePublicationDecision(decision);
  const validatedRulesetContract = validateApprovedRuntimeRulesetContract(rulesetContract);

  if (validatedDecision.decision_kind !== "runtime_rule_admission") {
    fail("decision must be a runtime_rule_admission");
  }
  if (!validatedDecision.runtime_effect) {
    fail("decision must set runtime_effect=true");
  }
  if (validatedDecision.decision_authority.authority_class !== "human") {
    fail("decision must have human authority");
  }

  // Check this before the contract reference so intentionally cyclic inputs fail explicitly.
  if (validatedRulesetContract.source_publication_decision_hashes.includes(validatedDecision.decision_hash)) {
    fail("ruleset contract must not include the final runtime admission decision_hash");
  }

  const {
    approved_ruleset_contract_hash: _approvedRulesetContractHash,
    ...unsignedRulesetContract
  } = validatedRulesetContract;
  const canonicalRulesetContractHash = approvedRuntimeRulesetContractHash(unsignedRulesetContract);
  if (validatedDecision.approved_ruleset_contract_hash !== canonicalRulesetContractHash) {
    fail("decision approved_ruleset_contract_hash does not match the canonical ruleset contract hash");
  }
  if (validatedDecision.work_scope.work_id !== validatedRulesetContract.work_scope.work_id) {
    fail("decision and ruleset contract work scopes must match exactly");
  }
  if (validatedRulesetContract.source_publication_decisions.some((sourceDecision) => (
    sourceDecision.reviewed_source_manifest_hash !== validatedDecision.reviewed_source_manifest_hash
    || sourceDecision.source_records_hash !== validatedDecision.source_records_hash
  ))) {
    fail("decision reviewed source pins must exactly match ruleset contract source pins");
  }
  if (validatedDecision.selected_candidate_ids.length !== validatedRulesetContract.source_candidate_ids.length
    || validatedDecision.selected_candidate_ids.some(
      (candidateId, index) => candidateId !== validatedRulesetContract.source_candidate_ids[index],
    )) {
    fail("decision selected candidate IDs must exactly match ruleset contract source candidate IDs");
  }

  return deepFreeze({
    receipt_kind: "runtime_rule_admission_link_validation",
    decision_hash: validatedDecision.decision_hash,
    approved_ruleset_contract_hash: canonicalRulesetContractHash,
    work_id: validatedDecision.work_scope.work_id,
  });
}
