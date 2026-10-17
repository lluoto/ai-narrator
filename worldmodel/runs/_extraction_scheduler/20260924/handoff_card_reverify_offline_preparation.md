# Card-Scoped Reverify: Offline Preparation Handoff

## Task And Ownership

Prepare an explicit, source-bound input package for selected verifier repairs.
This handoff makes NO Qwen calls and grants NO dispatch authorization. Do not
interrupt, restart, inspect in-flight raw results, or duplicate the current
smoke/batch. Prepare only from sealed first-round generator/source snapshots.

Workspace root:

```text
D:\aitrpg\世界模型\worldmodel
/mnt/d/aitrpg/世界模型/worldmodel
```

Read first:

```text
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/CARD_REVERIFY_PREPARATION.md
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/report.md
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/verifier_repair_queue.jsonl
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/generator_repair_queue.jsonl
tools/prepare_card_reverify.py
```

## Selection Procedure

1. Preserve the original audit queues. They contain attempt rows, not necessarily
   distinct candidates. Group by exact work, full original generator hash,
   card ID and canonical candidate hash. Never deduplicate by local card ID alone.
2. Select a bounded preparation tranche of at most five explicit cards. Choose
   transport/finish/JSON/citation-contract failures for verifier repair; do not
   automatically retry semantically valid insufficient/contradicted results.
3. Bind original generator, sibling generator job, full original coverage, and
   full source-sentence files by absolute paths and complete-file SHA-256 pins.
   Read exact source bindings from the job/audit inventory. Do not guess the
   latest source version or silently remap a path to a different snapshot.
4. Confirm each selected card's own generation call and normalized proposal are
   valid. A rejected sibling does not invalidate the selected card, but must
   remain present in the package rejection ledger. A failed selected generator
   call/card requires generation repair instead; never strip it to force success.
5. Create a NEW decision JSON using the exact schema in
   `CARD_REVERIFY_PREPARATION.md`. Canonical candidate hashes use sorted keys,
   compact separators, `ensure_ascii=True`, `allow_nan=False`, UTF-8, no newline.
6. Pin the canonical new verifier prompt and current worker config:

```text
runs/_extraction_scheduler/20260924/proposition_canary_prompts/proposition_verifier_prompt_v3_acceptance_contract_2.txt
worker_config.json
```

Run on the platform where the explicit paths are valid. A WSL decision uses
`/mnt/...` absolute paths; a Windows decision uses native absolute paths. Do not
modify source artifacts or embedded historical paths to hide a binding error.

## Compiler Commands

Replace all angle-bracket values with the explicit prepared paths and pins.
These commands perform offline preparation only:

```text
python3 -B tools/prepare_card_reverify.py --selection <absolute-decision.json> --selection-sha256 <decision-pin> --out-dir <absent-package-directory>
python3 -B tools/prepare_card_reverify.py --selection <absolute-decision.json> --selection-sha256 <decision-pin> --out-dir <absent-package-directory> --materialize
python3 -B tools/prepare_card_reverify.py --verify-package <absolute-package-directory> --package-manifest-sha256 <returned-manifest-pin>
```

The package directory's parent must exist. Do not overwrite a previous package.
Retain the manifest pin externally. Input file, compiler, core, config and prompt
changes invalidate reconstruction; do not replace pins just to bypass a failure.

## Return Evidence

Return the decision path/hash, package path/hash, selected work/card IDs, and:

```text
selected + rejected + unselected == all inventoried cards
generation issues counted separately by window
original inputs unchanged
raw_captures_not_validated
strict_v2_provenance_validated=false
whole_generation_certified=false
quality_certified=false
dispatch_authorized=false
no_runtime_effect=true
```

Missing historical raw captures are a declared provenance limit, not evidence
of prior verification. The package prepares a NEW verifier input only. It does
not select an effective original/reverify verdict, certify a whole book, or
resolve the 713 first-round status conflicts.

## After Preparation

Stop after package verification. Send the package pin to the inference-owning
session, which separately coordinates resources and authorizes any bounded
Qwen request. No runner dispatch is supplied by this compiler. Fresh verifier
responses require raw-first capture, the current acceptance contract, and lead
review. Do not expand the tranche or rerun the whole corpus automatically.
