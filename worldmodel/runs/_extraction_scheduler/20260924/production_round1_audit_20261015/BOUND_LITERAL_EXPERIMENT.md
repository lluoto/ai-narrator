# Approved-Bound Literal Experiment

Paths in this document are relative to the worldmodel root.

## Status

Implemented `tools/prepare_bound_literal_experiment.py` as the isolated experimental format `approved_bound_literal_experiment.v1`. Offline implementation and temporary synthetic tests only. No actual new case selections, production experiment packages, model responses, or accepted production candidates were materialized.

The generic literal preparation tools, strict core, approved-identity helper, literal normalizer, V2 prompt, worker configuration, source files, historical job/generator associations, audit products, production paths, and smoke behavior are unchanged. There is no HTTP transport, Qwen invocation, health probe, service/process control, retry, dispatch, verifier execution, promotion, or scheduler integration in the new tool.

## Explicit Selection

The selection remains an exact JSON object with integer `schema_version: 1`, the existing `worker_config`, `literal_prompt`, and `cases` fields, plus one mandatory field:

```json
"approved_identity_manifest": {
  "path": "ABSOLUTE_PATH_TO_APPROVED_MANIFEST",
  "sha256": "EXTERNALLY_SUPPLIED_FULL_SHA256"
}
```

This fragment documents the field, not a materialized selection. Every pin has exactly `path` and `sha256`. Absolute, nontraversing, non-device, non-symlink/reparse paths are required. Duplicate JSON keys, nonfinite values, unknown selection/case/pin fields, duplicate cases/windows, and selections outside one through five cases fail closed.

Each case retains exactly `case_id`, `work_id`, `window_id`, `coverage`, and `sentences`. The latter two are full-file pins, not selected-row or deduplicated snapshots. Named and missing/null source `work_id` behavior is retained, but even a named-only selection must explicitly supply the approved manifest. Nothing discovers approval from a directory name, title, sentence-ID prefix, or the string `B001`.

The existing canonical literal V2 prompt is byte-checked and rendered in one pass. The structured-source configuration must still identify localhost port 8000, strict JSON, thinking disabled, 1500 output tokens, 8192 model length, and one sequence. Request bodies contain only the existing model/messages/temperature/max_tokens/chat_template_kwargs fields, with temperature zero and thinking off. The maximum inert manual-call plan is the number of selected cases, at most five, serial, with zero automatic retries. The tool does not execute that plan.

## Integrity Division

1. The tool calls the unchanged `tools.approved_source_identity.load_approved_bindings` API with the explicitly supplied manifest path and external SHA256 and `verify_sources=False`. The real helper reconstructs the fixed 83-binding authorization declaration and checks its evidence and metadata. This is a metadata-only authorization load, not an attestation about current source bytes.
2. The consumer independently reads and hashes every selected full original sentence and coverage snapshot against the selection pins. It retains the helper manifest, authorization, binding index, evidence manifests/outputs, and non-source metadata pins in its own input inventory. Unselected original source files are not implicitly read or attested by this consumer.
3. Every declared, non-null source work ID different from the named case work is checked using `validate_local_identity` with the exact `(named_work_id, full_original_sentence_file_sha256, local_work_id)` tuple. This applies to the complete selected snapshot, including unselected rows, not merely the chosen window. There is no global alias or fallback.
4. All tracked source, metadata, code, configuration, prompt, package, and response inputs are rehashed before output and after writes. The same checks apply to dry runs without writing. Completed manifests are written last and removed if their immediate post-write recheck fails. A failed materialization may leave an incomplete absent-only output directory, which is not a valid completed package or acceptance product and is never reused automatically.

Reports explicitly label this division with `authorization_load: metadata_only_verify_sources_false`, `selected_source_integrity: consumer_full_original_bytes_sha256_and_final_rehash`, `integrity_skipped: false`, and `unselected_source_integrity_attested: false`. Metadata-only helper loading is not used as an integrity exemption.

## Narrow Projection

Only a validator-only in-memory source-row copy receives the named `work_id`, and only after exact approval. No persisted projected source file is produced. The strict core's complete coverage/source duplicate-ID and work preflight still runs. The consumer also checks chapter syntax and sentence/chapter prefix consistency across the full source snapshot; selected-window source membership, chapter bindings, duplicate anchor/attachment IDs, and text validity run through the unchanged core window builder.

Coverage rows must already carry the named work or missing/null work. Local coverage IDs are rejected: a sentence-file approval does not imply coverage-file approval. Original duplicate sentence IDs, including byte-identical duplicates in an approved snapshot, are never collapsed. Wrong named work, a colliding `B001` from another work/hash, an unapproved local ID, and a changed original full-file hash all reject. The deduplicated `943f...` source hash does not inherit original approval. The excluded work `\u7f51\u6e38\u4e4b\u5c04\u7834\u82cd\u7a79` cannot be selected.

Raw source copies in the package are byte-for-byte original, including original work IDs, text, sentence IDs, chapters, offsets, extra provenance, and physical encoding. Requests use the exact original selected sentence strings and IDs, without rationale or precomputed evidence offsets. For ordinary named-source cases, body bytes/hashes may be identical to generic V2; the surrounding records and package format are intentionally different.

Per-scope identity receipts appear in preparation reports and request records, and are carried into every case result, including rejections and unattempted cases. They contain the approved-manifest, authorization, binding-index and full-original-source pins, exact binding keys and canonical binding-record hashes, original work-ID distributions, selected original work IDs, and source-hash policy flags. Projection receipts record the original/validator canonical-row hashes, changed-row count, and changed fields. The original and validator hashes of all fields excluding `work_id` must match; only `work_id` may differ. This proves the scope of the projection without substituting projected bytes for raw provenance.

## Preparation And Acceptance

The CLI provides the same two explicit offline modes:

```text
python -B tools/prepare_bound_literal_experiment.py prepare --selection ABSOLUTE_SELECTION --selection-sha256 EXTERNAL_SELECTION_SHA256 --out-dir ABSOLUTE_ABSENT_DIRECTORY
python -B tools/prepare_bound_literal_experiment.py accept --package ABSOLUTE_PACKAGE --package-manifest-sha256 EXTERNAL_PACKAGE_MANIFEST_SHA256 --responses ABSOLUTE_ASSOCIATION --responses-sha256 EXTERNAL_ASSOCIATION_SHA256 --out-dir ABSOLUTE_ABSENT_DIRECTORY
```

These are usage templates, not commands executed against real cases. Both modes default to dry run. Only an explicit `--materialize` writes a new absent directory with an existing parent; existing outputs are never overwritten. Acceptance output must be outside the preparation package.

The saved-response association retains exactly integer `schema_version: 1` and `responses`. Each response row has exactly `case_id`, `request_body_sha256`, `raw_response` (path/hash pin), `http_status`, and `response_complete`. Unknown/duplicate case IDs and unsafe or malformed pins fail. HTTP status must be the integer 200, completeness must be boolean true, and the request body hash must match the selected case. An association is not remote-execution proof.

Acceptance reconstructs every package byte from external selection pins and current exact tool/helper/V2/core/normalizer/config/prompt/authority/source inputs. It verifies exact package membership and all output bytes against reconstruction, not just self-reported hashes. Re-pinning a tampered package cannot bypass this check. It pins the reused V2 code bytes and executes private, exact-byte modules without changing shared core/helper globals or allowlists.

The V2 envelope function and literal normalizer are reused unchanged. Only the existing V2 server-metadata allowlists are accepted, with the same exact model, single-choice/index/completion/message checks. No fence stripping, prose repair, schema relaxation, retry, or partial-card recovery is added. Generator reasoning stays only in a saved raw response copy and is not copied into candidate records. Literal provenance and offsets come from the unchanged normalizer over the original selected text.

Case outcomes are `unattempted`, `rejected`, or `pending_independent_verification`. A bad card rejects the whole case with empty proposition/provenance arrays, not a partially accepted card list. Valid content is still only a candidate: there is no selected verdict, semantic-entailment certification, quality certification, batch acceptance/authorization, runtime effect, publication authority, or dispatch permission.

The manifest has the explicit experiment version and additional boundary fields. The original generic parser rejects this package rather than silently interpreting it. The original generic tools and their existing outputs remain independently replayable; no compatibility fallback was added.

## Offline Tests

`tests/test_bound_literal_experiment.py` uses temporary source/code/prompt/config/metadata fixtures. Its only authorization substitution is a pure fake `load_approved_bindings` bound to an exact synthetic manifest pin, returning a deeply immutable two-key map. It is not a permissive `B001` alias and is not evidence that a production 83-binding manifest was loaded. The real exact-key validator, private core, V2 envelope, and normalizer remain unchanged.

The consumer tests cover approved-local end-to-end preparation and mock raw acceptance, original source/request bytes, projection field/hash receipts, named/null/missing work IDs, mandatory sidecar/schema behavior, wrong-work and colliding-local rejection, wrong original and derived hashes, excluded work, duplicate IDs and JSON keys, full-snapshot chapter/work checks, unsafe paths, external pins, response association rules, incomplete/error envelopes, all-or-nothing case rejection, package/code/metadata/source tampering, pre/post-write rehashes, deterministic dry runs, replay, and generic format isolation. An instrumented read test proves the consumer's metadata-only path does not read the unselected fixture source and does rehash the selected full source.

The five-case synthetic run has four attempted responses and one unattempted case: one nonempty valid result, one valid empty result, one bad second card, and one incomplete response. Exactly two cases remain pending independent verification, two reject, and one remains unattempted. Nothing authorizes a batch.

The separate, unchanged `tests/test_approved_source_identity.py` provides 20 tests of the real helper implementation with temporary 83-approved/one-excluded synthetic fixtures and fixture authority pins. These exercise real declaration reproduction, external pins, immutable records, authorization/index/evidence tamper detection, exact local identity, excluded work, metadata-only behavior, and full source rehashing. They are distinct from the mocked-loader consumer tests and do not constitute production source review.

Verified on 2026-10-17:

- `python -B -m unittest discover -s tests -p test_bound_literal_experiment.py -v`: 17 tests passed.
- `python -B -m unittest discover -s tests`: 565 tests, OK, two skipped. The initial verbose run exceeded the 120-second command timeout; the complete rerun passed in 229.722 seconds with a longer timeout.
- The overall suite includes all 20 real-helper fixture tests and the unchanged generic literal experiment tests. Skips are pre-existing host-dependent checks. No live model, API, health, process-control, or production case dispatch was performed.
