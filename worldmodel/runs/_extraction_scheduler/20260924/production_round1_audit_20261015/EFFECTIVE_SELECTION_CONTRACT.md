# Effective Verification Selection Contract

## Scope

`tools/select_effective_verification.py` is an offline, explicit decision-file
validator and optional materializer. It never dispatches a model, probes an API,
loads endpoint configuration, chooses attempts, promotes candidates, modifies
originals/reverifies, or changes runtime admission. It does not read historical
route queues, aggregate `ok` reports, timestamps, or scheduler selection pointers.

Only artifacts named in the decision file, the selected calls' job-manifest-pinned
captures, and the current strict parser at `tools/proposition_canary_run.py` are
opened. Generator/source/verifier JSONL files are indexed for identity ambiguity.
Only selected cards' parent generator windows, candidates, and raw verifier
responses are revalidated. This is not a bulk historical reparse or a blanket
selection of first-round results.

## Decision Schema

The input is a UTF-8 JSON object with exactly `schema_version` (integer `1`) and
`entries` (nonempty array). No duplicate JSON keys or nonfinite numbers are
permitted. Every entry has exactly these fields:

```json
{
  "schema_version": 1,
  "entries": [
    {
      "work_id": "chosen-work",
      "card_id": "W000001#0",
      "attempt_kind": "reverify",
      "candidate_sha256": "<64 lowercase hex digits>",
      "generator": {
        "path": "D:/explicit/original/proposition_generator.jsonl",
        "sha256": "<64 lowercase hex digits>"
      },
      "generator_job": {
        "path": "D:/explicit/original/job_record.json",
        "sha256": "<64 lowercase hex digits>"
      },
      "verifier": {
        "path": "D:/explicit/chosen-attempt/proposition_verifier.jsonl",
        "sha256": "<64 lowercase hex digits>"
      },
      "verifier_job": {
        "path": "D:/explicit/chosen-attempt/job_record.json",
        "sha256": "<64 lowercase hex digits>"
      },
      "coverage": {
        "path": "D:/explicit/source/coverage_partition.jsonl",
        "sha256": "<64 lowercase hex digits>"
      },
      "sentences": {
        "path": "D:/explicit/source/sentences.jsonl",
        "sha256": "<64 lowercase hex digits>"
      }
    }
  ]
}
```

The example is a schema illustration, not an executable decision. Paths must be
absolute and contain no `..` components. Each artifact reference has exactly
`path` and `sha256`. Pins hash raw file bytes, including whitespace/newlines.
Paths resolve to canonical absolute paths in the output. Conflicting pins for
the same resolved path are errors. All named artifacts must exist and match
their pins, including the selected verifier file and both jobs. A missing file
is an input error; a missing selected row in an existing pinned verifier file is
an `unverified` effective result.

`attempt_kind` is explicitly `original` or `reverify`. It is never inferred from
a directory name or the presence of another attempt. The full decision identity
is `(work_id, generator byte SHA, card_id, normalized candidate canonical SHA,
coverage byte SHA, sentences byte SHA)`. At most one entry is allowed per
`(work_id, generator byte SHA, card_id)`, so changing candidate/source pins cannot
disguise competing choices for one snapshot/card. Multiple generator snapshots
are distinct identities, not merged or promoted to a latest snapshot.

### Candidate Canonical SHA

Hash the normalized card returned by the current strict `validate_card`, not
the surrounding generator or verifier row:

```python
hashlib.sha256(json.dumps(
    normalized_card,
    sort_keys=True,
    separators=(",", ":"),
    ensure_ascii=True,
    allow_nan=False,
).encode("utf-8")).hexdigest()
```

There is **no trailing newline** in candidate canonical bytes. Object keys are
sorted recursively; array order, string content, and evidence offsets are not
changed. Non-ASCII characters use JSON escapes. There is no Unicode, whitespace,
or evidence-span normalization beyond the current card validator. The helper
`candidate_sha256` implements this rule; it does not choose a card or attempt.

## Binding Rules

1. The generator job and chosen verifier job must declare the selected `book`
   and match the pinned coverage/sentence hashes under
   `input_artifact_hashes["coverage_partition.jsonl"]` and
   `input_artifact_hashes["sentences.jsonl"]`.
2. Each data file must be a sibling of its explicitly pinned job file. Original
   selection requires the same generator/verifier job reference and a non-reused
   generator job, not a verifier-only execution. Reverify selection requires
   `generator_reused: true`, `generator_jsonl_sha256` matching the selected
   generator snapshot, and `generator_jsonl` resolving to that generator.
3. If present, reverify `source_generator_jsonl`,
   `source_generator_jsonl_sha256`, `source_book`, and `source_bindings` must
   agree too. Shipped historical relative generator paths have exactly one
   resolution base: the current canary runner's `BASE`. There is no search,
    cwd fallback, or path precedence. New decision-file references are always
    explicit absolute paths.

   Capture-location portability does not remap embedded reverify generator
   paths. Full reverify relocation requires an explicit mapping from each stored
   original generator path to the current pinned generator path/hash, together
   with the unchanged candidate, job, work, and source proofs. Schema version 1
   has no such mapping field: unresolved embedded paths fail closed. There is no
   guessed relocation root, basename/content search, or automatic Windows/WSL
   drive alias for these generator bindings.
4. Generator window IDs, generator card IDs across all rows, verifier card IDs,
   coverage window IDs, and source sentence IDs must be unique within their
   named files. Exactly one generator card must match the selected card ID.
5. The generator row's declared work (or the job's work for shipped legacy rows
   without `work_id`) and `allowed_work_ids` must bind to the selected work.
   Its chapter/window and ordered sentence IDs must agree with the pinned
   coverage window reconstructed using `build_window` and pinned source text.
   A source record's non-null declared work must agree; source formats that
   omit work rely on the pinned job/source hashes and chapter/sentence binding.
6. The selected generator card and any matching verifier row must bind work,
   chapter, window, and exactly `[work_id]` for allowed works. The generator
   candidate and stored normalized card must both pass `validate_card` and
   agree, with `accepted_for_verification: true` and matching route. The
   decision's candidate canonical SHA must match. A present verifier candidate
   must equal that generator candidate; an ID alone never establishes a join.
7. Exact candidate evidence is rendered with `render_evidence` from the
   validated source text and the candidate's literal `[start:end]` offsets.
   `parse_verifier_card` receives the normalized card, reconstructed window,
   expected `work|window|card` case ID, selected job's verifier model, raw
   response, and call metadata. Citations must be within the candidate's
   evidence IDs, not merely another sentence in the source window. The output
   records the exact supplied evidence block and its UTF-8 SHA. Literal spans
   establish provenance, not semantic quality certification.
8. Both pinned jobs must explicitly declare integer
   `acceptance_contract_version: 2`. The generator job's `output_file_hashes`
   must reference the selected sibling generator JSONL, and the verifier job's
   manifest must reference the selected sibling verifier JSONL. Each digest
   must equal the corresponding decision pin and actual file bytes. A decision
   pin alone is not evidence that a file belongs to a job. Reverify additionally
   retains the generator path/hash and source-snapshot checks in rules 1-3;
   it does not claim the reused generator as its own output.
9. Every output-manifest key must be a canonical relative POSIX path, with
   lowercase SHA-256 values. Absolute paths, drive/stream separators, backslashes,
   empty/dot/traversal components, control characters, trailing dots/spaces,
   and self-referential job/report entries are rejected. Selected files and
   selected capture paths must resolve to actual files under the pinned job's
   directory without symlink redirection. Generator/verifier JSONL files must
   be direct siblings of their jobs, not arbitrary files with matching content.

### Selected Generation

A normalized candidate alone cannot establish valid generation. For every
selection, its parent generator row must independently meet all of these checks:

- `call_meta` declares integer HTTP `200`, exactly the generator job's nonempty
  `model`, finish reason `stop`, an explicitly present null `error`, and no
  incomplete-response flag. The raw content must match `content_sha256`.
- `model_parse_ok` is exactly `true`, and `parse_error` is explicitly null.
- The raw response passes the current strict JSON parser and is exactly an
  object with `propositions`, a list no longer than the current strict runner's
  `MAX_CARDS_PER_WINDOW`. Extra keys, duplicate JSON keys, nonfinite values,
  malformed JSON, and non-object responses fail closed.
- Integer `proposed_count`, raw proposition count, and stored `cards` length
  agree. Every stored `generator_card` matches its raw proposition using exact
  canonical JSON, preserving list order and JSON types. Positional card IDs
  must be exactly `window_id#index`. There is no truncation, reordering, inferred
  card correspondence, or selection from a schema-invalid oversized response.

Generation envelope, parse-status, raw-schema, or correspondence failure makes
that explicit selection `unverified` with a `selected_generator_*` reason,
even if the chosen verifier response is strictly positive. Existing binding or
normalized-card errors remain hard errors. **Aggregate original-book success is
not required.** A valid selected generator window can be repaired with an explicit
reverify even when unrelated verifier calls, other windows, or the book's
aggregate completion flags failed. Unselected generator responses are not
reparsed or used as substitutes.

### Selected Call Captures

Both the selected generator call and selected verifier call require
`call_meta.capture_dir`. The runner joins its `out_dir` with
`calls/<number>_<stage>` and stores that full string in call metadata; it only
uses a job-relative path in the separate stage-start journal. Consequently,
metadata can contain an already relative `calls/...`, a canonical repository
relative `out_dir` prefix (such as `runs/_extraction_scheduler/20260924/.../calls/...`),
or an absolute Windows or POSIX location, including `/mnt/<drive>/...` under WSL.
Windows drive paths and ordinary UNC share paths are recognized lexically on
either OS; Windows separators are accepted for Windows and relative paths.

The selector extracts exactly one safe trailing identity:
`calls/<at-least-six-digits>_generator` or `calls/<at-least-six-digits>_verifier`,
matching the selected stage and preserving the exact digits. The stored prefix
is inert provenance, never a filesystem read location or a resolution base.
Every component must be nonempty, nontraversing, and free of control characters,
drive/stream separators (except the recognized leading drive), trailing
dots/spaces, and Windows wildcard/device syntax. Dot aliases, duplicate or
case-ambiguous `calls` components, extra trailing components, unsafe stages,
drive-relative paths, and unrecognized roots are errors. No search, call-number
inference, or alternate capture occurs.

All three capture reads use only that exact `calls/...` identity beneath the
explicitly pinned **current** job directory, with the existing containment and
symlink checks. The same exact keys must exist in that job's pinned output hash
manifest. An intact original attempt can therefore move between Windows, WSL,
and POSIX locations by updating the decision's explicit artifact paths and its
own decision hash, leaving all job, JSONL, and capture bytes/hashes unchanged.
An available historical absolute capture is never a fallback for a missing
current job capture. Reverify generator bindings still obey rule 3.

The job's `output_file_hashes` must pin each selected call's `request_body.bin`,
`response_body.bin`, and `journal.jsonl`. These files are hashed and checked
without opening other calls' artifacts. Each selected call's metadata must have
an explicit null error, correct model/HTTP/finish, and matching raw content hash.
The saved request model and final user-message SHA must match the row's model
and `prompt_sha256` (inside `verifier` for verifier rows). The saved response
must contain exactly one stopped choice from the expected model with content
identical to the row's raw response. Its journal must contain exactly
`request_saved`, `response_saved`, `envelope_validated`, with matching body hashes,
HTTP `200`, and an explicitly null terminal error. Missing or invalid captures
cannot silently count as provenance. Captured-request prompt hashes are checked;
external prompt templates are not independently rerendered.

For example, an original job's relevant manifest portion is:

```json
{
  "acceptance_contract_version": 2,
  "model": "generator-model",
  "verifier_model": "verifier-model",
  "output_file_hashes": {
    "proposition_generator.jsonl": "<generator byte SHA>",
    "proposition_verifier.jsonl": "<verifier byte SHA>",
    "calls/000001_generator/request_body.bin": "<request byte SHA>",
    "calls/000001_generator/response_body.bin": "<response byte SHA>",
    "calls/000001_generator/journal.jsonl": "<journal byte SHA>",
    "calls/000002_verifier/request_body.bin": "<request byte SHA>",
    "calls/000002_verifier/response_body.bin": "<response byte SHA>",
    "calls/000002_verifier/journal.jsonl": "<journal byte SHA>"
  }
}
```

The actual job manifest may contain more outputs. This illustration does not
claim a complete attempt tree.

Bindings, schema/hash/path errors, wrong work/source, missing generator card,
mutated generator, or duplicate/ambiguous identities abort validation with exit
code `2` before any output directory is created. Input bytes, including the
loaded strict parser revision, are rehashed immediately before materialization.
The tool uses validated in-memory bytes; later edits cannot change that view.
Concurrent output reservation is exclusive. An interrupted materialization may
leave an incomplete directory; investigate it and use a fresh path, never reuse
or overwrite it. The reconciliation report is written last.

Excessive JSON nesting is caught at the selector's strict JSON and CLI boundaries
without a traceback. A deeply nested decision, job, or indexed JSONL artifact
fails with exit `2` before writing. A deeply nested selected capture or raw model
response fails its normal selected-call/parse check and remains `unverified`;
it cannot yield a certified or entailed result.

## Effective Status

Only explicit integer `acceptance_contract_version: 2` in both pinned jobs,
matching selected-file output manifests, independently valid selected generation,
valid selected call captures, and a successful current strict verifier parse can
yield a verified effective status.
The parser requires the full fixed field-check coverage, nonempty check reasons
and citations, reconciled overall/check verdicts, correct case/model/envelope,
and `no_runtime_effect: true`. Stored `entailed`, verdict/check summaries, or
historical aggregate `ok` flags cannot certify a result.

The selected row is `unverified` with reasons when it is missing, lacks usable
verifier payload/call metadata/candidate data, has recorded verifier errors,
fails the strict parser or content hash, lacks explicit v2 acceptance in either
job, lacks an entire historical output manifest, or fails the selected-generation
or selected-capture checks above. Missing capture references or capture manifest
entries also yield `unverified` with an explicit diagnostic. A present manifest
that omits the selected JSONL or disagrees with a decision/file hash is a hard
error, as are unsafe manifest paths or missing/tampered manifest-pinned files.
Refreshing a generator/verifier decision pin cannot override an unchanged job's
output hash.
Incomplete binding identity is instead an input error because it cannot be
safely attributed to this work/card. There is **no fallback** to another attempt,
even if the original is positive or a reverify is positive.

Successful strict parses preserve the **exact contract overall** as
`effective_status`: `entailed`, `insufficient_evidence`, `contradicted`, or
`abstain`. The parser's legacy reduction to `insufficient` is deliberately not
used as the effective status. Only `entailed` rows enter REVIEW queues.

## Validation Limit

This tool validates **selected JSONL files and selected calls' captures**, not the
full attempt tree. All manifest entries are checked for safe path/hash syntax,
but unrelated outputs are not opened or hashed. It does not prove that the
manifest covers every file in the attempt directory, reconcile every call
number/count, validate unselected calls, rerender external prompt templates, or
certify whole-book completion. An unrelated missing output does not invalidate
an otherwise fully pinned selected call. This narrower scope is intentional so
verifier-only repairs do not depend on aggregate original-book success. The
reconciliation report records this limitation in `output_validation_scope`.

## Outputs And Commands

Default mode validates offline, prints the reconciliation report to stdout, and
writes no files. Parser import does not write a bytecode cache. `--materialize`
is the only write opt-in. Both modes require an absolute, absent output path
with an already-existing parent; existing files/directories/symlinks are refused.

From the repository root in PowerShell:

```powershell
$pin = (Get-FileHash -Algorithm SHA256 -LiteralPath "D:/decisions/selection.json").Hash.ToLowerInvariant()
python -B tools/select_effective_verification.py --selection "D:/decisions/selection.json" --selection-sha256 $pin --out-dir "D:/reviews/new-effective-view"
python -B tools/select_effective_verification.py --selection "D:/decisions/selection.json" --selection-sha256 $pin --out-dir "D:/reviews/new-effective-view" --materialize
python -B -m unittest discover -s tests -p test_effective_verification.py -v
python -B -m unittest discover -s tests
```

A successful validation/materialization exits `0`, including a correctly
recorded `unverified` selection. Exit success is not acceptance or certification;
inspect `effective_status_counts` and each row's `reasons`.

Materialization writes only the new output directory:

- `effective_manifest.jsonl`: one complete pinned row per explicit decision,
  including generator/job/verifier/job/source/selection/parser hashes, candidate
  SHA, selected verifier physical line number (null when missing), exact evidence,
   reparsed checks/citations, effective status, reasons, and the selected
   request/response/journal references under `selected_call_captures`.
- `entailed_REVIEW_queues/<route>.jsonl`: one file for each current primary route,
  containing only selected, strictly entailed rows with full pins. These are
  human review inputs, not runtime or cross-work merged knowledge.
- `reconciliation_report.json`: selected status counts, per-route entailed REVIEW
  counts, and individually listed unselected card IDs in explicitly pinned
  generator snapshots. `not_selected` never implies accepted. Cards in all other
  snapshots/files are outside the report's scope, not silently accepted.

Every effective row and report declares `no_runtime_effect: true`,
`quality_certified: false`, `review_only: true`, `cross_work_merge: false`, and
`automatic_promotion_permitted: false`. Effective rows retain
`candidate_not_confirmed`, `no_transfer`, `REVIEW`, and a single allowed work.
No original output, selection pointer, queue, job, or runtime registry is edited.
