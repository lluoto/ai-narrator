# Offline Completion And Remaining Work

## Current Boundary

Service availability is not probed or changed by this code-repair session.
Qwen calls remain assigned to the separate inference session; bulk semantic
discovery remains assigned to Luna. Synthetic fixtures do not establish live
model quality. Do not infer active/completed calls solely from prepared packages.

## Implementation Status

| Component | Offline state | Still required |
| --- | --- | --- |
| Acceptance-v2 runner and versioned verifier prompt | Implemented and mock-tested | Bounded live smoke and independent source review |
| Attempt preservation and strict postflight | Implemented and race-tested | Apply read-only postflight to sealed live output |
| Explicit effective-verification selector | Implemented and fixture-tested | Explicit per-card choices and genuine pinned v2 evidence; no automatic historical precedence |
| Card-scoped reverify input compiler | Implemented and reconstruction-tested | Bounded real selection/package preparation, separately scheduled verifier requests |
| Literal normalizer | Implemented and Unicode/repetition tested | Live compliance and semantic quality assessment |
| Offline literal request/response experiment | Implemented and fixture-tested end to end | Separately authorized requests and saved-response associations |
| Approved-binding literal preparation/acceptance | Implemented as `tools/prepare_bound_literal_experiment.py`, exact sidecar tuples and original-byte preservation tested | Separate bounded live test; not implicitly selected by existing packages |
| Compact verifier content parser and prompt | Implemented and fixture-tested | Trusted caller transport/capture association, bounded live test and efficiency comparison |
| Token/retry/diagnostic reporting | Implemented and fixture-tested | Explicit sealed production inventory and measured report; no guessed spending |

The compact parser does not implement trusted transport binding. It must not be
treated as a complete replacement for the current verifier runner.

## Historical Work Still Open

- Approved source identity and derived deduplication are recorded separately in
  `SOURCE_RESOLUTION_APPROVED_STATUS.md`. The binding-aware V3 inventory contains
  3169 generation candidate windows and 47 deferred windows. This is no bulk
  dispatch authorization; the fixed five-case handoff is a separate scope.
- The audit's 457 verifier-repair entries are failed attempt rows and still need
  candidate/source-aware deduplication and bounded repair selection. This is not
  an authorization to submit all 457 or regenerate all 124 Wave-A books.
- Original/reverify statuses differ on 713 cards. No canonical winning result
  has been selected. Semantic disagreement adjudication belongs to the separate
  Luna handoff; a later effective view must retain exact chosen attempt hashes.
- The 3,865 rejected generator cards and five invalid-JSON generation windows
  remain historical rejects/errors. The new literal contract has not repaired
  them or measured a lower rejection rate.
- The two rare-route boundaries still require independent high-quality labels;
  delegated model review must retain truthful provenance, never human gold.
- Human/KP publication, tier decisions and runtime activation remain separate.

## Inference-Owner Order

1. Finish or report the already-prepared acceptance-v2 five-window smoke using
   its frozen execution inputs and corrected Stage 2 path instructions. Do not
   use optional optimization prompts in that frozen smoke.
2. Return sealed attempt paths for read-only postflight. Contract failure is
   diagnosis input, not a reason for automatic retry or bulk expansion.
3. Prepare a separate at-most-five-card reverify input tranche using
   `CARD_REVERIFY_PREPARATION.md`; preserve rejected siblings and unselected rows.
4. For literal generation, follow `LITERAL_EXPERIMENT_HANDOFF.md` using a new
   selection/package; do not point the old production runner at the new prompt.
5. The approved-binding literal experiment is a separate format. Follow
   `BOUND_LITERAL_EXPERIMENT.md` for later requests from the 83 approved local-ID
   source snapshots; do not replace a frozen generic package mid-attempt.
6. Compact-verifier transport integration, live comparison and production prompt
   selection are later explicit changes. No claimed token/latency/quality gain
   is supported before measurement.

## Verification

```text
python -B -m unittest discover -s tests
```

Latest Windows offline suite: 565 tests, 563 passed, two host-permission symlink
skips, zero failures. No live Qwen, production inference scan, or model-quality
evaluation was part of these tests. New experiments and parser remain outside
production routing and have no runtime effect or automatic promotion authority.

## Fixed Five-Case Execution Handoff

The user requested `先做5案例和其他测试的`. The fixed generic five-case package
has a separate inference-owner handoff; the code-repair session did not dispatch:

```text
runs/_extraction_scheduler/20260924/proposition_literal_followup_fivecase_execution_handoff_v1/README.md
runs/_extraction_scheduler/20260924/proposition_literal_followup_fivecase_execution_handoff_v1/authorization.json
authorization SHA256: 6da1ab7e6fff718523ce309cf7cc2e8b2afa3f1c3e2f552bcaf534fd7334f41e
package manifest SHA256: 9af4b3d35b194ab3c3ef475d260c57291371e96b12aa9fb8a0a24b1991066e36
```

At preparation, its directory contained only the sealed package and selection,
with no returned response associations. No claim of zero calls elsewhere is
made. The inference owner checks existing ledgers before dispatch to avoid
duplicates. This record permits at most five serial 8000 completions under the
explicit user instruction, not automatic retries, 8001 access or bulk expansion.
