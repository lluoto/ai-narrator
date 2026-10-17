# Inference Efficiency Diagnostic Contract

Date: 2026-10-15. Review fixes applied. Validation scope: synthetic fixtures only.

Implemented `tools/report_proposition_efficiency.py` with a standalone standard-library
parser and `tests/test_proposition_efficiency.py`. This report contains implementation
and fixture counts, not production measurements. No production inventory was scanned,
no live model/API/process was invoked, and no existing runner, helper, prompt, or
configuration was changed. Offline suite tests mock runner dispatch. Bulk semantic
reasoning remains assigned to Luna. This document now lives in the intended scheduler
audit directory; the accidentally root-placed document was moved, not duplicated.

## CLI

```powershell
python -B tools/report_proposition_efficiency.py --inputs "D:\fixtures\inventory.json" --inputs-sha256 <64-lowercase-hex> --out-dir "D:\fixtures\new-report"
```

The default prints diagnostic JSON to stdout without creating files or directories.
Add `--materialize` to create the previously absent output directory and its single
`inference_efficiency.json` file. Its parent must already exist. Existing outputs are
refused even for dry runs. Materialization prints the same report as the saved file.
There is no overwrite option or output in the attempt directories.

Exit codes: `0` means a stable pinned diagnostic snapshot; `3` means pending metadata
with `snapshot_accepted: false`; `2` means rejected arguments/snapshot/materialization.
Snapshot failures emit only `FAIL: snapshot_rejected` on stderr, never offending input
payloads. Snapshot acceptance is byte-level diagnostic acceptance, not validation of
the runner's full output contract or certification of any proposition.

## Closed Inventory Schema

The inventory JSON object has exactly `schema_version` (integer `1`, not boolean)
and `attempts` (nonempty list). Each attempt has these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `work_id` | Yes | Nonempty identifier; scoped with attempt ID |
| `attempt_id` | Yes | Unique within the work |
| `attempt_kind` | Yes | Exactly `original` or `reverify`, explicitly chosen by the inventory author |
| `job` | Yes | Pinned JSON object |
| `validation` | Yes | Pinned JSON object |
| `generator` | No | Pinned generator LF JSONL, with outer window call metadata |
| `verifier` | No | Pinned external verifier LF JSONL, with nested verifier call metadata |

Each reference is exactly `{"path": "<absolute local file>", "sha256": "<64 lowercase hex>"}`.
Unknown inventory, attempt, or reference keys are rejected. Optional references must
be omitted rather than set to null. A schematic fixture inventory is:

```json
{
  "schema_version": 1,
  "attempts": [
    {
      "work_id": "fixture",
      "attempt_id": "original",
      "attempt_kind": "original",
      "job": {"path": "D:\\fixtures\\original\\job.json", "sha256": "<sha256>"},
      "validation": {"path": "D:\\fixtures\\original\\validation.json", "sha256": "<sha256>"},
      "generator": {"path": "D:\\fixtures\\original\\generator.jsonl", "sha256": "<sha256>"},
      "verifier": {"path": "D:\\fixtures\\original\\verifier.jsonl", "sha256": "<sha256>"}
    }
  ]
}
```

The `<sha256>` strings above are placeholders, not accepted pins. The CLI separately
requires the inventory's external SHA-256 pin. Work, attempt, window and card IDs must
be nonempty, at most 240 characters, without whitespace, controls, path separators or
ambiguous delimiter characters. Literal non-ASCII identifiers are supported.

Duplicate `(work_id, attempt_id)`, generator window IDs, generator card IDs and
verifier card IDs are rejected. Local IDs may repeat across attempts or works.
Conflicting pins, cross-role aliases, repeated result references and hardlink aliases
of result files are rejected. A reverify attempt may explicitly repeat the original
generator reference as reused input: its rows are indexed for lineage and card
accounting, but its generator calls and usage are not counted again.

## Snapshot Boundaries

Only inventory references are opened. `output_file_hashes`, `capture_dir`, source
paths, prompt paths, endpoints and other paths inside job/result records are never
followed. There is no recursive traversal, glob discovery, helper/runner import,
HTTP client, subprocess dispatch, or source lookup in the tool.

Paths must be absolute local paths without traversal, Windows device names, alternate
streams, trailing-dot/space aliases, UNC/device prefixes, symlinks, junctions or
ancestor reparse points. Inputs must be regular files. Pins are checked against the
bytes parsed, with initial file identity/stat stability checks. All inventory inputs,
including the inventory itself and reused inputs, are rehashed with file identity
checks before any accepted report is returned or any output directory is created.
An input mutation causes rejection before output.

JSON objects reject duplicate keys, NaN, Infinity, overflowing nonfinite numeric
tokens, invalid UTF-8 and excessive nesting. JSONL is split on byte LF, not Unicode
line separators; CRLF and a final unterminated row also work. Literal U+2028, U+2029
and U+0085 inside strings do not create extra records. Empty lines are ignored.

For v2 metadata, job and validation contract versions must both be integer `2`, with
matching recorded statuses. Contradictory statuses or terminal `ok` flags block
snapshot acceptance, including a running job paired with a completed report.
Matching running/pending/not_started/incomplete metadata produces a pending view.
Pending attempts do not open or parse generator/verifier files. Their declared pins
are marked unread/deferred, all actually read metadata is rehashed, and the snapshot
is explicitly not accepted or materializable. This permits pending diagnosis without
claiming that deferred result bytes were checked. Legacy records remain visibly
`legacy_unvalidated` when no terminal status is recorded; observing a legacy terminal
status still does not certify v2 provenance.

## Attempt Rows And Capture Identity

Generator calls come only from each generator window's outer `call_meta`. Embedded
card verifier metadata is ignored. Verifier calls come only from the explicitly
declared verifier file's `verifier.call_meta`. An embedded-only verifier is
`not_explicitly_declared`, not a source of verifier metrics. Reverify or explicitly
reused generation is `reused_not_compute`.

`call_metadata_rows` means result rows with a recorded call metadata object.
`attempt_row_totals` sums those row observations, including known final-response
usage. These are not unique provider calls or proof of distinct physical inference.
`unique_provider_compute_known` is always false. Deterministic raw responses,
content hashes, or copied metadata cannot prove distinct inference. No heuristic
deduplication based on content or guessed true provider compute is performed.

Raw capture files are not opened, statted, resolved, validated or discovered.
Capture-origin identity is a lexical claim only. A relative
`calls/NNNNNN_generator` or `calls/NNNNNN_verifier` is anchored to the pinned job
file's directory. The same relative name in different actual attempt directories
therefore denotes separate observed records. Stored absolute local paths retain
their claimed origin, with separators normalized and Windows paths case-folded.
An absolute path into an original attempt matches that original attempt's anchored
relative path, even when a copied row sits in a different attempt. Foreign Windows
and POSIX origins are not guessed to be equivalent. Unpinned capture symlink or
physical filesystem identity cannot be verified under this metadata-only scope.

Repeated canonical claimed origins within an attempt are rejected. Across attempts,
`suspected_duplicate_capture_origins` lists origin hashes and occurrence counts;
`rows_with_suspected_duplicate_origin` flags every affected row and attempt. All
affected token/card ratios are suppressed. Row totals still describe the declared
rows; they do not deduplicate or extrapolate actual provider computation. Capture
identity coverage reports missing, invalid, present, distinct-claimed-origin and
suspected-duplicate counts. Missing or invalid identity blocks a token/card ratio.

`observed_rows` and `rows_without_call_meta` distinguish result rows from rows with
call metadata. Reported stage attempts and total calls remain separate, with both
reported-minus-row and reported-minus-recorded-call-attempt differences.

Groups use stage, recorded job execution mode and the recorded stage profile. Mode,
profile and finish labels use closed vocabularies; unknown values become `unknown`.
Profiles are `structured_source`, `structured_render`, `unstructured_analysis`.
Modes additionally recognize `verifier_only_reverify_8001` and the two corresponding
`degraded_generation_*` modes. Finishes are `stop`, `length`, `content_filter`,
`tool_calls`, `function_call`. Endpoint, port, model and thinking text do not supply
an inferred profile. Model IDs alone may use explicit compact metadata labels and
are compared exactly with recorded job model IDs. `by_stage` separates original
from reverify. The
`first_pass_by_stage` view includes explicitly declared original attempts, including
any separately inventoried original retries. It never selects a chronological first
retry or replaces an original attempt with a reverify result.

## Usage And Retries

Only nonnegative integer `usage.prompt_tokens`, `completion_tokens` and `total_tokens`
are observed, excluding booleans, floats and numeric strings. Each field has its own
known sum and contributing-call count. A field with no observations is null, not
zero. Missing and partial call counts and their rate use call metadata rows as
the denominator. Missing call metadata is disclosed separately. Known sums with
incomplete coverage are partial observations, not estimates of total expenditure.

`call_meta.attempts` accepts only nonnegative integers, excluding booleans, strings
and floats. Zero is explicitly flagged as inconsistent with a recorded returned call
and is incomplete knowledge for ratios. Missing/invalid counts, observed attempt
sums, `max(attempts - 1, 0)` retry-attempt sums, and number of rows with explicit
retries are separate. `job.retried_calls` and `job.total_calls` are independently
observed nonnegative integers; missing or invalid job counts remain unavailable.
The runner's `retried_calls` field counts calls that retried, not total extra retry
attempts. Both measures are retained, without conflating their meanings.

`retry_accounting` compares job call/retried-call counts and validation stage/total
counts with observed rows and recorded call-attempt sums. Conflicts are explicit;
they neither replace validation values nor multiply usage. Usage normally describes
the final response only. Prior retry tokens are unknown if retries, incomplete attempt
knowledge, missing required counters or contradictory retry/call metadata are
recorded. `prior_retry_tokens` stays null in those cases. Only complete no-retry
metadata permits zero prior-retry tokens. Stage summaries describe their row metadata;
attempt and inventory summaries also account for job/validation uncertainty.

Reasoning usage comes only from explicit
`usage.completion_tokens_details.reasoning_tokens`. Its known sum and contributing
call count are separate; it is not added again to completion or total tokens.
Raw reasoning length, raw response length and top-level `reasoning_tokens` do not
supply usage. Flags expose invalid fields, prompt-plus-completion differing from the
reported total, and explicit reasoning exceeding completion. Known reported totals
are preserved even when inconsistent.

Finish counts, sanitized model identities, exact recorded-versus-job model mismatch
counts, identity-unavailable counts and sanitized call-error groups are included.
There is no dollar estimate, rate inference, invented timing or actual-VRAM estimate.

## Cards And Structured Diagnostics

Per attempt/work and closed route, counts distinguish emitted generator cards,
generator eligibility, actual observed submissions (external verifier rows with call
metadata), verifier result rows, recorded-valid, recorded-unusable, unclassified
validity and recorded entailed cards. Eligibility comes from explicit
`accepted_for_verification: true`; it is not an observed submission. Expected report
counts and observed-minus-reported differences remain separate. Missing stage counts
are null, including route counts, rather than fabricated zeros. Routes outside the
eight fixed primary routes become `unknown`. Generator card counts in reverify are
explicitly scoped as `reused_input`, not newly emitted compute.

When a generator is explicitly provided, each verifier card must join to an eligible
generator card with the same card ID, window, work and route. Unrelated IDs,
ineligible cards, mismatched windows, explicit wrong works and mismatched routes
reject the snapshot even if all numeric counts match. Reused reverify generator rows
are indexed for this same check. Missing explicit work/window/closed-route metadata
leaves the join unknown. Without an explicit generator the join is unknown; recorded
verdict counts can be observed but no token/card ratio is available. This checks
metadata lineage, not semantic payload equivalence or source entailment.

Recorded-valid means an explicit empty `verifier.errors` list and recognized recorded
verdict. Nonempty recorded errors mean unusable; absent/invalid validity metadata
remains unclassified. This is recorded validator status, not a new semantic check.
Overall distributions separate recorded-valid from error/unclassified results.
Structured check counts include validity bucket, closed field label and verdict.
Verifier error/rejection groups use a fixed vocabulary of diagnostics emitted by the
card/verifier contracts in `tools/proposition_canary_run.py`; recognized error names
may strip a colon field/detail suffix. HTTP status error names map to `http_error`.
Any other error becomes `unknown_code`. Unknown field names become `unknown_field`.
Regex-shaped or separator-joined source prose is never an allowed diagnostic label.
The output includes file locators/hashes and row line/ID locators, without candidate,
source, rationale, free reason, or raw-response payloads.

Insufficient/abstain causes use only explicit structured `reason_codes` or an
insufficient check's `reason_code(s)`, exactly matching the legacy verifier v1 prompt
vocabulary: `source_supported`, `not_established`, `material_expansion`,
`modality_conflict`, `temporal_conflict`, `attribution_conflict`, `unusable_source`.
V2/v3 contracts provide free reasons rather than a reason-code vocabulary. Unknown
codes become `unknown_code`, without preserving arbitrary text or inferring a cause
from a known prefix plus appended source text. With no recognized explicit code, the bucket is
`cause_unclassified_requires_review`. Free-text references to missing context,
truncation, or wrong routes never create cause labels. Structured reason-code counts
are counts of occurrences; per-card insufficient cause counts deduplicate codes
within the card. No bulk semantic interpretation is performed.

`missing_or_invalid_reported_counts` discloses every absent/invalid validation count.
`cardinality.reported_counts_complete` is false when any required counter is missing.
The required fields are `proposer_cards`, `cards_considered`, `cards_verified`,
`cards_valid`, `cards_unusable`, `cards_schema_or_span_rejected`, `generator_attempts`,
`verifier_attempts`, `total_calls`. Null differences never count as agreement.

`accepted_card_token_cost` requires all these counters, all observed comparisons
present and equal, a positive recorded entailed/error-free denominator, complete
eligible generator lineage, all required stage rows/call metadata, known mode/profile,
complete capture-origin coverage without suspected duplicates, matching model IDs,
stop finishes, no call errors, complete consistent usage, explicit single attempts on
all call metadata, explicit zero job retries, and matching job/validation call counts.
Any failure leaves the metric null. Its numerator covers every call metadata row in
that attempt and its denominator is named. For reverify it covers verifier final
responses only. This is a row-based token ratio, not a unique provider inference cost,
money, or a final accepted-quality measure. Unknown prior retry tokens are never
treated as zero to produce a ratio.

Original and reverify stay separate in attempt records and groups. No precedence,
effective verification selection, final quality, population prevalence or recall is
produced. Complete metadata still cannot prove that distinct inference occurred.

## Fixture Validation

Owned fixture tests:

```text
python -B -m unittest discover -s tests -p test_proposition_efficiency.py
```

Result: **47 tests passed, 0 failed, 0 skipped**. Fixture files and materialized
outputs exist only in `TemporaryDirectory` locations; `-B` prevents bytecode writes.

Full `tests/` discovery was also executed in a `python -B` process with the following
audit wrapper. Final result: **264 tests run, 262 passed, 0 failures/errors, 2 skipped**.
The guard forbids live network/child-process operations, workspace writes and reads
of workspace JSON/JSONL/BIN/log data. Existing tests read source code/contracts and
exercise temporary fixtures with their existing mocked dispatch. No live model was
started or contacted, and no production snapshot was reported.

```python
import os, sys, unittest
root = os.path.normcase(os.path.abspath('.')) + os.sep
blocked = {'socket.connect', 'socket.connect_ex', 'socket.getaddrinfo',
           'subprocess.Popen', 'os.system', 'os.posix_spawn'}
def guard(event, args):
    if event in blocked:
        raise AssertionError('offline suite forbids network and child processes')
    if event == 'open' and isinstance(args[0], (str, bytes, os.PathLike)):
        path = os.path.normcase(os.path.abspath(os.fsdecode(args[0])))
        if path.startswith(root):
            if args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                raise AssertionError('offline suite forbids workspace writes')
            if path.endswith(('.json', '.jsonl', '.bin', '.log')):
                raise AssertionError('offline suite forbids live workspace data reads')
sys.addaudithook(guard)
suite = unittest.defaultTestLoader.discover('tests')
result = unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(not result.wasSuccessful())
```

| Synthetic case | Observed diagnostic counts |
| --- | --- |
| Original, with duplicate embedded verifier metadata | 1 outer generator + 1 external verifier = 2 call metadata rows; prompt 20, completion 10, total 30; 1 joined recorded entailed card; row-based token ratio 30/card with complete identity/counter/no-retry metadata |
| Original plus separate negative reverify | 3 call metadata rows, known row token sum 45; original recorded entailed 1, reverify recorded entailed 0; neither overrides the other |
| Same absolute verifier capture origin in original and reverify | 3 row observations retained; 2 rows share a suspected duplicate origin; both affected ratios suppressed; unique provider compute unknown |
| Same relative verifier call name under distinct job directories | 3 row observations with 3 distinct claimed origins; no duplicate flag, no assertion of distinct provider inference |
| Embedded verifier without a verifier reference | 1 generator call metadata row; verifier unavailable; verifier card metrics and token ratio null |
| 4 reported generator attempts, 1 generator row | Difference 3; combined observed row usage stays 30 tokens, with no retry-cost extrapolation |
| `call_meta.attempts=4`, job `retried_calls=3`, validation `total_calls=2` | 5 known call attempts across 2 rows, 3 known extra retry attempts, 1 row with retries; validation-minus-attempts -3; job retry-call conflict; prior retry tokens unknown; ratio null |
| Partial generator usage plus absent verifier usage | 1 partial + 1 missing usage row; known prompt 10, completion null, total null; missing/partial rate 1.0 |
| Generator eligibility exceeds submissions | 2 emitted, 2 eligible, 1 observed submitted card |
| Matching v2 running metadata | 0 result call metadata rows; result files never read; snapshot not accepted; materialization refused |
| Insufficient result with only a free reason | 1 `cause_unclassified_requires_review`; no semantic text classification |
| Encoded prose in reason-code fields | 4 `unknown_code` occurrences; 1 `cause_unclassified_requires_review`; encoded text absent from all output |
| Missing any required validation counter, capture identity, attempts or lineage | Incomplete fields disclosed; ratio null |

Tests also cover closed schema and external pins, duplicate keys/IDs/origins,
relative/absolute and Windows case/separator origin matching, same-file/hardlink result
aliases, unsafe paths and mocked ancestor reparse points, input-only reads, legacy
metadata, conflicting statuses and file roles, reused-generator lineage indexing,
equal-count wrong card/window/work/route rejection, explicit reasoning detail,
unknown usage, strict retry counters, missing required counters, inconsistent totals,
response finishes/model identities/errors, closed reason/error/enum vocabularies,
missing call metadata, literal Unicode separators, mutation of every pinned input
before publication, and dry-run/new-output CLI behavior. Production performance,
unique provider computation and production reason distributions remain unmeasured.
