# Execute Conflict Review In The Separate Luna Session

## User Instruction And Scope

The user requested `进行luna` and confirmed the executor is the OTHER Luna
session, not a local API/CLI. Perform the semantic review in that session. Do
not ask this code-repair session to dispatch Qwen, guess a provider endpoint, or
claim that preparation itself executed Luna.

This is review of existing evidence only: 713 conflict cases across 14 works.
No production generation, model-service operation, candidate promotion, source
edit, runtime write, or global original/reverify precedence is authorized.

## Workspace And Pinned Inputs

```text
Root: D:\aitrpg\世界模型\worldmodel
Package: runs/_extraction_scheduler/20260924/luna_conflict_review_preparation_v1/
Manifest SHA256: d530c71a1eb56064ee79ae262404889bc1e498985b4161a8fcca2c536b4e0027
```

Read these files in the package:

```text
README.md
prompt.md
verdict_schema.json
shard_index.json
executor_registration.json
```

Preparation registration is intentionally unexecuted. Do not edit or reuse it
as a completed executor record. Record the actual provider/model/version exposed
by your session in a NEW output record. If unavailable, disclose that limitation;
do not invent a version or copy `gpt6luna` as proof of execution identity.

## Execution Procedure

1. Verify the external manifest pin and each shard's hash/membership from the
   index. The preparation's optional offline `--check` command reconstructs
   existing files only; do not run a production runner or call 8000/8001.
2. Take the FIRST shard in `shard_index.json` and review all its cases, at most
   24, belonging to exactly one work. Read candidate and source evidence before
   considering historical votes. Follow the frozen `prompt.md` and schema,
   rather than paraphrasing them into a different task.
3. Produce one response per case. Use only that case's `allowed_review_ids`.
   Distinguish prior sent evidence from newly supplied full-sentence context;
   support found only in new context does not retroactively validate an old
   verifier response. Literal presence is not semantic entailment.
4. Mark uncertainty explicitly. Choosing `original`, `reverify`, `neither` or
   `undecided` is a recommendation ONLY. Neither the more positive vote, the
   more negative vote, nor the later timestamp wins by default.
5. Validate each response against `verdict_schema.json` AND the context-sensitive
   `validate_response(response, case)` in `tools/prepare_luna_conflict_review.py`.
   After the first shard validates and its output is saved, proceed sequentially
   through the remaining index entries. Stop on pin/schema/citation/identity
   errors; preserve partial output and report it instead of fabricating entries.
6. Do not repeatedly rewrite a difficult judgment to force consistency. Preserve
   any correction as a new explicit review revision. Never tune against hidden
   holdout answers or treat the structural sampler as an answer baseline.

## New Output Directory

Use a NEW absent-only local directory:

```text
runs/_extraction_scheduler/20260924/luna_conflict_review_results_v1/
```

Required products:

```text
executor_record.json
input_manifest.json
shard_results/<one immutable JSONL file per completed shard>
review_ledger.jsonl
summary.json
summary.md
output_manifest.json
```

Record package/shard/output hashes and exact case membership. The ledger must
separate completed, blocked, failed and unreviewed cases; there is no implicit
approval for missing cases. On interruption, return the next shard identity and
saved hashes; never overwrite a completed shard or mix another work's context.

Summarize source-fidelity, modality, temporal, actor/claimant and routing errors
separately, retaining concise public evidence summaries but no private reasoning
trace. Record `reviewer_class=model_delegated`; never label model review human,
human gold or an independently certified baseline. Do not report precision or
recall from this enriched conflict cohort.

## Return To Code-Repair Session

Return the actual executor registration, completed shard count/case count,
unreviewed/blocked counts, recommendation distribution, output directory and
external output-manifest hash. The code-repair session will independently check
JSON/schema/citation/hash/accounting; it will not replace Luna's bulk semantic
judgments or silently apply a winning verdict.

All existing sources, audit evidence, original/reverify artifacts and effective
selection pointers remain unchanged. Keep the private source packets/results
local; do not upload novel excerpts to GitHub. No runtime or state authority is
created by successful review.
