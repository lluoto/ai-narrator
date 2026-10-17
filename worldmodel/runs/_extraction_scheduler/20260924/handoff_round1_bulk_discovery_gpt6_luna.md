# First-Round Bulk Discovery Audit Handoff

## Executor

User-requested executor label: `gpt 6 luna`.

This document is a handoff, not evidence that that model has executed. Record
the actual provider/model/version when executing it. Do not substitute Qwen or
claim a model identity from the handoff label alone. No configured API identity
for this executor was found in the application configuration during preparation.

## Task

Audit the completed first round at:

```text
D:\aitrpg\世界模型\worldmodel
```

Locate systemic source-discovery, generation, and verification defects in the
existing output. Do NOT launch a second full production round. Produce evidence-
backed findings and targeted repair recommendations only.

## Authoritative Inputs

All paths below are relative to the workspace root:

```text
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/report.md
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/report.json
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/manifest.json
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/RUNNER_FINDINGS.md
runs/_extraction_scheduler/20260924/c01_coverage_partition_wavea_v1/
runs/_extraction_scheduler/20260924/proposition_canary_v1/
tools/proposition_canary_run.py
runs/_extraction_scheduler/20260924/run_wavea_canary_batch.py
runs/_extraction_scheduler/20260924/run_reverify_8001.py
runs/_extraction_scheduler/20260924/run_wavea_supervisor.sh
PROPOSITION_ANNOTATION_CONTRACT.md
SOURCE_PROPOSITION_RECORD_SCHEMA.md
```

Read `manifest.json` for audit artifact names and hash inventory. Do not guess
queue filenames. Follow per-job input hashes to the exact original source
artifact. Resolve WSL/Windows aliases only by matching content hashes.

## Known First-Round Scope

```text
Wave-A: 124 books, 3 no-work books, 9828 windows
Foundation: 6 books, 572 windows
Wave-A proposed/rejected/submitted: 22846 / 3722 / 19124
Foundation proposed/rejected/submitted: 1286 / 143 / 1143
Original unusable verifier rows: 437
Reverify unusable rows: 20
Reverify attempts: 14 books, 2162 rows
Original/reverify status conflicts: 713
```

The 457 repair entries count persisted failed attempt rows, not necessarily
457 distinct cards. Original and reverify results have NO chosen precedence.
Do not treat original `ok:true`, `cards_verified`, or `validated_route_queues`
as proof of semantic acceptance. No-work means no selected eligible windows,
not that the whole book contains no useful propositions.

## Procedure

1. Reproduce the deterministic audit with `audit_round1.py --check` from its
   directory. This is offline; do not run production runners.
2. Inspect every metadata-only repair queue entry and group errors by stage,
   cause, execution mode, work, route, prompt version, and finish reason.
3. Reproduce the acceptance counterexamples in `RUNNER_FINDINGS.md` offline.
4. For semantic discovery, freeze a deterministic sample before review. Include
   original entailed, insufficient, contradicted, unusable, schema/span rejected,
   and no-card windows. Include dual-endpoint, degraded 8001-only, and legacy
   cohorts separately. Use bounded review shards of at most 24 source windows.
5. Include attribution/noise boundary examples and controls. A near-zero output
   count is not a human baseline and is not evidence of zero true positives.
6. Read exact pinned source text for each sampled record. Check whether evidence
   supports the claim, actor/target roles, assertion, temporal scope, route, and
   generality. A literal substring match alone is NOT semantic entailment.
7. Retain attribution on a content route when separable content exists. Reserve
   `attribution_only` for attribution-only value. Do not classify all short
   questions or responses as noise without checking for separable content.
8. Separate model errors, deterministic validator defects, source preparation
   defects, insufficient context, and unresolved policy. Do not repair source
   evidence by inventing text or adjusting arbitrary span offsets.

The stratified sample is diagnostic, not a prevalence/recall estimate. Record
sampling rules and per-stratum counts; do not extrapolate it to all source IDs.
Different prompts/endpoints using Qwen3-27B are separate passes, NOT independent
model families or human validation.

## Outputs

Create a NEW absent-only directory:

```text
runs/_extraction_scheduler/20260924/production_round1_bulk_discovery_review_v1/
```

Required artifacts:

```text
executor_record.json
input_manifest.json
sample_manifest.json
findings.jsonl
findings.md
targeted_repair_plan.json
```

Each finding must include work/record/attempt IDs, source artifact path and
hash, evidence IDs, affected field, exact reproducible defect, observed versus
expected behavior, severity, cause category, and bounded repair action. Record
actual reviewer provenance as model/delegated review, never `human`.

## Prohibitions

No model/API calls launched by local production runners. No overwrite, delete,
automatic retry, prompt tuning on a sealed holdout, invented labels, human-gold
claim, tier upgrade, publication, runtime/state/SQLite writes, or cross-work
fact merging. Do not silently select a winning original/reverify result.

Stop after the audit and repair plan. Code fixes and new inference batches are
separate work; never turn diagnosis into unrecorded bulk regeneration.
