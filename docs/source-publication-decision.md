# Source Publication Decision

`src/compiler/source-publication-decision.ts` is a standalone, pure admission
record contract. It neither loads source records nor has any runtime consumer.
In particular, it is not connected to `GameSession`, the server, state, rules,
SQLite, the world-model loader, or the source-proposition adapter.

## Record

A decision is schema-versioned and canonically hashed as `decision_hash`. It
binds all of the following fields:

- `reviewed_source_manifest_hash` and `source_records_hash` are lowercase
  SHA-256 pins for the reviewed manifest and reviewed source-record set.
- `selected_candidate_ids` is a nonempty, duplicate-free set of candidate IDs.
- `work_scope` contains one nonempty `work_id` and an exact candidate-to-work
  map. Every selected candidate must map to that same work; cross-work records
  fail validation.
- `decision_authority` records a `human`, `delegated_assistant`, or
  `lead_model` class and a nonempty authority identifier.
- `timestamp` is a canonical ISO-8601 UTC instant and `supersedes` is either
  `null` or a prior decision hash.
- `runtime_effect` is explicit, not inferred from the decision kind.

The create and validate functions return deep-frozen independent values. The
hash function uses canonical JSON with sorted object keys and preserves the
normalized candidate-ID ordering, so the hash binds the complete decision
payload rather than a mutable caller object.

## Admission Rules

`decision_kind` is required and has only three values:

- `research_lookup_admission` must set `runtime_effect: false`.
- `runtime_rule_admission` must set `runtime_effect: true`, include a separate
  `approved_ruleset_contract_hash`, and name a `human` authority. This module
  does not inspect or execute that ruleset contract.
- `rejected` must set `runtime_effect: false`.

Neither a delegated assistant nor a lead model may set `runtime_effect: true`,
including when it supplies a ruleset hash. A runtime-rule record that lacks
either the approved ruleset-contract pin or human authority is rejected by this
validator.

## Boundary

This is a source-publication/admission audit primitive only. A valid runtime
rule admission is not runtime wiring, a ruleset evaluation, a state mutation,
or authorization for any existing execution path. Any future consumer must be
introduced in a separate, explicitly approved integration task.
