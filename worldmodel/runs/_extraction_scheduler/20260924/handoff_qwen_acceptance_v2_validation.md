# Qwen Acceptance V2 Validation Handoff

## Ownership

This prompt is for the separate session responsible for Qwen inference. The
code-repair session has NOT dispatched these requests. Do not stop, restart,
kill, or resubmit any current production process. Wait until its owner confirms
the inference slot is available. Do not execute this handoff as a full batch.

Workspace:

```text
D:\aitrpg\世界模型\worldmodel
/mnt/d/aitrpg/世界模型/worldmodel
```

## Read First

```text
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/REPAIR_IMPLEMENTATION.md
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/report.md
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/manifest.json
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/EFFECTIVE_SELECTION_CONTRACT.md
tools/proposition_canary_run.py
tools/proposition_attempts.py
tools/select_effective_verification.py
worker_config.json
```

Canonical new verifier prompt, relative to the workspace:

```text
runs/_extraction_scheduler/20260924/proposition_canary_prompts/proposition_verifier_prompt_v3_acceptance_contract_2.txt
```

This prompt has offline tests only; a fresh bounded live smoke is required. Do
not reuse old model outputs as evidence that this new prompt works.

## Stage 1: Offline Preparation

1. Record exact runner, prompt, config, source and input hashes.
2. Pick at most five source-bound cases for a bounded smoke: a supported content
   claim, a valid insufficient claim, a contradiction control, an attributed
   claim with an unresolved speaker, and a valid empty-proposal control where
   applicable. Freeze selection before reading new outputs.
3. Bind exact work/chapter/window/sentence IDs and source snapshots. Do not
   fabricate a target result for a real source case.
4. Run the offline tests. Prepare a NEW absent-only attempt path. Do not use
   `--overwrite` or write below an existing completed attempt.
5. Report planned completion-request count, model IDs, token budgets, and prompt
   hashes to the inference owner. Obtain their execution approval.

If verifier-only reuse is planned, first prove the original generator snapshot
passes the new binding checks. If it contains invalid generator JSON, rejected
cards, or missing windows, do NOT call the whole-book reverify runner and do NOT
delete rejected cards to manufacture a clean snapshot. Prepare an explicitly
scoped, source-bound repair plan instead, with lineage to the original records.

## Stage 2: Bounded Live Smoke

Only the inference-owning session may perform these calls after approval:

```text
8000: configured structured_source model, thinking disabled, temperature 0
8001: configured unstructured_analysis model, separate verifier prompt
serial dispatch, one request per authorized case, no automatic retries
```

Discover exact model identity via `/v1/models` and compare with config before
completion calls. A shared Qwen base model is a separated review pass, not an
independent model family or human baseline.

Use the canonical prompt's `[SYSTEM]` and `[USER]` sections. Supply only the
candidate plus exact source evidence to the verifier; no generator rationale.
Preserve the new eight-field checks and overall precedence. Do not simplify
the schema in the runner or silently adapt malformed responses to pass it.

Stop on HTTP, model, choice-count, finish, JSON, source binding, schema, citation,
or field-check contract failure. Persist raw captures first. A valid insufficient
or contradicted result is a normal review outcome, not a transport failure.

## Stage 3: Return Evidence

For the NEW explicit output directory, the code-repair session can independently
run this read-only postflight; it makes no HTTP requests, starts no inference,
and never changes the attempt:

```text
python -B tools/inspect_proposition_attempt.py --attempt <absolute-new-attempt-output-directory>
```

Exit 0 means strict completed/no-work, exit 3 means pending/not-started/unstable,
and exit 1 means failed/invalid/legacy-unvalidated. A running attempt with no
terminal report is not treated as a model failure. Send the exact output path
back to the code-repair session; do not ask it to rerun the Qwen requests.

Produce a new smoke report with request ledger, raw response hashes, exact call
counts, valid/unusable/unattempted counts, field-check coverage, source binding,
and offline replay results. Declare:

```text
candidate_not_confirmed
no_transfer
review_only
no_runtime_effect
quality_certified=false
bulk_dispatch_authorized=false
```

Do not retry failed smoke cases or expand to all 124 books automatically. Return
the failure evidence for offline analysis. Large-batch semantic discovery is a
separate Luna handoff, not part of this small integration smoke.
