# Generator Span Blocker: Literal V2 Preparation Only

## Disposition

Keep both numeric-span v1 attempts sealed and failed. Choose the contract
migration path for NEXT preparation: exact literal evidence plus program-derived
offsets. Do not clip, shift, tolerate end-inclusive values, auto-repair numeric
offsets, weaken validation, or retry either sealed v1 attempt.

This handoff authorizes preparation only. It does not authorize completion
requests, health probes, service startup, or bulk dispatch.

## Read Inputs

Root: `D:\aitrpg\世界模型\worldmodel` or its WSL alias
`/mnt/d/aitrpg/世界模型/worldmodel`.

Read these paths relative to that root:

```text
runs/_extraction_scheduler/20260924/proposition_smoke_v1/STAGE2_BLOCKER_generator_v1_span_bounds.md
runs/_extraction_scheduler/20260924/proposition_smoke_v1/generation_only_8000_v1/GENERATION_RESULT.md
runs/_extraction_scheduler/20260924/proposition_smoke_v1/generation_only_8000_v1_attempt2/EXPERIMENT_PREP.md
runs/_extraction_scheduler/20260924/proposition_smoke_v1/generation_only_8000_v1_attempt2/GENERATION_RESULT.md
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/generator_v1_span_blocker_review_v1/report.md
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/generator_v1_span_blocker_review_v1/report.json
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/generator_v1_span_blocker_review_v1/input_hashes.json
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/LITERAL_EXPERIMENT_HANDOFF.md
tools/prepare_literal_experiment.py
tools/proposition_literal_evidence.py
runs/_extraction_scheduler/20260924/proposition_canary_prompts/proposition_generator_prompt_v2_literal_evidence.txt
worker_config.json
```

The independent audit verifies 4 calls across 3 unique work/window pairs, with
one across-attempt repeat of W000467, not an automatic retry. The failed windows
were attempted, not unattempted. Preserve historical bookkeeping inconsistencies
and cite the audit rather than rewriting those reports.

## Frozen Preparation Selection

Prepare at most two cases, both from work `不死冥神`:

| Case | Window | Original failed evidence |
| --- | --- | --- |
| numeric_span_regression_01 | W000303 | B001:C0032:S000006, length 39, original span [18,42) |
| numeric_span_regression_02 | W004307 | B001:C0297:S000085, length 45, original span [0,46) |

These identify regression targets, not corrected answers. Do not put the prior
model proposition, desired literal, old offsets, or old verifier verdict into
the new generator request. It receives only the canonical literal-v2 prompt
and the original source window.

Use the FULL original coverage and sentence snapshots resolved and hash-verified
by the audit, not the selected-row coverage copies. Derive native-platform
absolute path references explicitly; verify exact hashes before use. Do not
substitute a newer or similarly named source file.

Prepare a fresh decision file matching the literal experiment selection schema,
with the two cases, exact work/window IDs, full-source pins, canonical literal-v2
prompt pin, and worker-config pin. No dispatch runner is needed.

## Output And Offline Checks

Create a NEW preparation directory, for example:

```text
runs/_extraction_scheduler/20260924/proposition_literal_span_regression_v1_preparation/
```

Keep the decision file outside the absent package child path. Use the documented
`prepare_literal_experiment.py prepare` dry-run and explicit `--materialize`
only. Record its external package-manifest hash. The tool must prepare exactly
two request bodies and preserve full original source snapshots and provenance.

Return:

```text
decision path/hash
package path/hash
two selected case/work/window identities
canonical prompt/core/normalizer/config hashes
planned calls = 2, dispatch_authorized=false
verification_status=pending_8001
independent_verification=false
candidate_not_confirmed / no_transfer / no_runtime_effect
```

If offline preparation fails, stop and report the failure. Do not edit sources,
prompts, pins, or schemas to manufacture passing preparation.

## New Budget Required

The original temporary 8000-only bound was at most five calls; four are already
evidenced. This two-case experiment is NOT covered by the one remaining call,
and a new contract does not reset a budget automatically. Obtain a new explicit
two-call authorization after returning the frozen preparation.

No request to W000303 or W004307 is permitted by this document alone. No reuse
of the original reserved acceptance-v2 output directories. No 8001 calls or
fallback verification on 8000. No repeated supported-control call is needed.

## Future Result Interpretation

If separately authorized, the inference owner sends each exact packaged request
once to 8000, saves raw bytes first, and returns the pinned response association
for OFFLINE `prepare_literal_experiment.py accept`. It must stop on the first
failure and leave remaining cases unattempted. No automatic retries.

Acceptance runs the real literal normalizer: unique exact source match, or exact
context disambiguation, then derives Python code-point half-open offsets. A
missing/ambiguous/unsupported literal fails without partial card salvage.
No new numeric spans are requested from the model.

Even a successful two-case regression establishes only structural/literal
normalization for those new responses. It does not repair old card records,
establish semantic entailment, validate the unavailable verifier, or authorize
bulk. Preserve the unresolved frozen dual-endpoint smoke and all historical
rejects. The 12/14 historical snapshot finding is corroboration, not proof that
all rejections have this same cause or future v1 failures are inevitable.
