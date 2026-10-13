# Approved Runtime Ruleset Contract

`src/compiler/approved-runtime-ruleset-contract.ts` creates a standalone,
canonical, SHA-256-pinned `approved_ruleset_contract_hash` artifact. A final
human `runtime_rule_admission` source-publication decision can cite that hash.
The contract carries opaque pins to prior research decisions, but does not
load, call, or alter `source-publication-decision.ts`.

## Record

The unsigned contract contains all of the following, and the returned artifact
adds `approved_ruleset_contract_hash` over the canonical unsigned payload:

- `schema_version`, `ruleset_id`, and `ruleset_version` identify the approved
  ruleset contract.
- `work_scope` names exactly one `work_id`. Its exact
  `source_decision_work_ids` map binds every cited source-decision hash to that
  work; a cross-work decision is rejected.
- `source_publication_decision_hashes` is a nonempty, duplicate-free canonical
  set that must exactly match the hashes in `source_publication_decisions`.
- `source_candidate_ids` is the nonempty, duplicate-free canonical candidate
  set selected by the pinned prior source decisions.
- `source_publication_decisions` is nonempty. Each opaque pin includes the
  source publication decision hash, reviewed source-manifest hash, and source
  records hash. This module does not dereference or revalidate those records.
- `deterministic_evaluator_artifact_hash` identifies an evaluator artifact only.
  The validator never loads or executes evaluator code.
- `test_fixture_artifact_hashes` is a nonempty, duplicate-free set of fixture
  artifact pins, and `behavior_contract_hash` pins the expected behavior.
- `approval` requires a nonempty human approver identity and an exact
  ISO-8601 UTC approval timestamp. Delegated or model approvers are rejected.
- `runtime_capabilities` has a nonempty allowlist limited to
  `evaluate_action`, plus the exact prohibited-capability set:
  `state_mutation`, `persistence_write`, `cross_work_merge`,
  `prompt_injection`, `tool_call`, and `network`.

Every object is strict: missing, additional, malformed, duplicate, and
non-lowercase-64-hex hash fields fail validation. Set-like collections are
sorted before hashing. `createApprovedRuntimeRulesetContract` and
`validateApprovedRuntimeRulesetContract` return independently deep-frozen
values, and `approvedRuntimeRulesetContractHash` recalculates the canonical
artifact hash.

## Boundary

This is **not** runtime wiring or runtime authorization. It does not connect to
`GameSession`, the server, state, SQLite, action processing, rules execution,
tools, prompts, or networking. It grants no permission to evaluate an action,
write state, persist data, or invoke any evaluator. A consumer, including a
human `runtime_rule_admission`, requires a separate explicitly approved
integration task.
