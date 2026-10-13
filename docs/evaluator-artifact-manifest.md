# Evaluator Artifact Manifest

`src/compiler/evaluator-artifact-manifest.ts` defines a pure, canonical
provenance artifact for the deterministic `evaluate_action` evaluator. It
validates caller/build-provided SHA-256 pins only. It never reads an artifact or
fixture file, computes a filesystem hash, runs `evaluateAction`, invokes the
fixture runner, or wires a runtime consumer.

## Record

An unsigned manifest contains the following exact fields. Creation adds
`evaluator_artifact_manifest_hash`, the SHA-256 hash of the canonical unsigned
payload in the manifest hash domain.

- `evaluator_id` and `evaluator_version` identify the evaluator implementation.
- `evaluator_capabilities.allowed_capabilities` must be exactly
  `evaluate_action`.
- `evaluator_capabilities.forbidden_capabilities` must contain the complete,
  exact set: `state_mutation`, `persistence_write`, `filesystem_read`,
  `filesystem_write`, `runtime_rule_execution`, `runtime_wiring`,
  `cross_work_merge`, `prompt_injection`, `tool_call`, and `network`.
- `evaluator_artifact_hash` is the build-supplied SHA-256 of the implementation
  artifact. `fixture_artifact_hash` is the externally supplied SHA-256 of the
  fixture report artifact. `behavior_contract_hash` pins the behavior contract.
- `evaluator_input_schema_hash` and `evaluator_output_schema_hash` pin the
  evaluator's public schemas.
- `source_revision_or_build_identifier` records the reproducible source revision
  or build identifier, and `reproducibility_statement` records the accompanying
  reproducibility claim.

All records reject missing and unknown fields, including unknown nested fields.
Hash pins must be lowercase 64-hex SHA-256 values. The APIs canonicalize,
revalidate, and independently deep-freeze returned artifacts:
`createEvaluatorArtifactManifest`, `evaluatorArtifactManifestHash`, and
`validateEvaluatorArtifactManifest`.

## Fixture Report Pinning

`runEvaluateActionFixtures` is an in-memory verification function, not an
artifact producer. Before its report can appear in a manifest, an external
build/release step must serialize the complete report with its chosen canonical
format, hash those serialized bytes with SHA-256, retain the serialized report,
and pass that resulting lowercase hash as `fixture_artifact_hash`.

The manifest deliberately cannot perform any of those operations. Supplying a
hash merely pins an externally produced report; it does not prove the report was
run, serialize it, or execute evaluator rules.

## Ruleset Contract Mapping

`toApprovedRuntimeRulesetContractArtifactPins(manifest)` revalidates a complete
manifest and returns a deep-frozen, input-ready mapping without importing or
changing `approved-runtime-ruleset-contract.ts`:

- `evaluator_artifact_hash` becomes `deterministic_evaluator_artifact_hash`.
- `fixture_artifact_hash` becomes the sole entry in
  `test_fixture_artifact_hashes`.
- `behavior_contract_hash` remains `behavior_contract_hash`.

This helper neither admits the ruleset nor authorizes runtime use. The manifest
has no server, GameSession, state, world, SQLite, filesystem, network, or
runtime-rules dependency.
