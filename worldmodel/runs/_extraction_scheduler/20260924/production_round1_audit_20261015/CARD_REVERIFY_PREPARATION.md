# Offline Card Reverify Preparation

`tools/prepare_card_reverify.py` compiles explicit, pinned individual cards into
new verifier input packages. A sound selected card can coexist with a rejected
sibling in the same raw generation. The sibling remains in the rejection ledger;
the original generation and source files remain the referenced inputs.

Implementation scope is exactly the new compiler, its fixture-only regression
suite, and this document. No production/smoke output, runner, helper, prompt,
configuration, or scheduler was changed. No actual 457-item repair queue was
prepared. No API, Qwen, health check, production subprocess, process-control
operation, or git commit was used.

## Decision Schema

The decision is one strict JSON object with exactly these version-1 keys:

```json
{
  "schema_version": 1,
  "verifier_prompt": {"path": "ABSOLUTE_CANONICAL_V3_PROMPT_OR_IDENTICAL_COPY", "sha256": "LOWERCASE_SHA256"},
  "worker_config": {"path": "ABSOLUTE_WORKER_CONFIG", "sha256": "LOWERCASE_SHA256"},
  "sources": [
    {
      "work_id": "EXPLICIT_WORK",
      "generator": {"path": "ABSOLUTE_FULL_ORIGINAL_GENERATOR_JSONL", "sha256": "LOWERCASE_SHA256"},
      "generator_job": {"path": "ABSOLUTE_SIBLING_ORIGINAL_JOB_JSON", "sha256": "LOWERCASE_SHA256"},
      "coverage": {"path": "ABSOLUTE_FULL_ORIGINAL_COVERAGE_JSONL", "sha256": "LOWERCASE_SHA256"},
      "sentences": {"path": "ABSOLUTE_FULL_ORIGINAL_SENTENCES_JSONL", "sha256": "LOWERCASE_SHA256"},
      "selected_cards": [
        {"card_id": "EXPLICIT_WINDOW#0", "candidate_sha256": "LOWERCASE_SHA256"}
      ]
    }
  ]
}
```

The uppercase values above describe required values, not usable pins or paths.
Each reference has exactly `path` and `sha256`; each selected-card object has
exactly `card_id` and `candidate_sha256`. Hashes must be 64 lowercase hexadecimal
characters. Paths must be absolute, nontraversing paths. Symlinks, ancestor
symlinks, Windows reparse points, device namespaces, alternate streams, and
unsafe/reserved path components are refused. Duplicate JSON keys, nonfinite
numbers, conflicting pins for one path, duplicate snapshot selections, duplicate
window/card/source row IDs, and wrong-work joins fail closed.

Candidate hashes use the selector's same canonical rule:

```python
hashlib.sha256(json.dumps(card, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=True, allow_nan=False).encode("utf-8")).hexdigest()
```

There is no trailing newline in candidate hash input. JSONL and package JSON
files use this canonical encoding followed by a newline. Package bytes have no
timestamps or output-directory-dependent fields.

## Offline Commands

Run from the repository root. These examples describe a separate explicit
fixture decision; no such production decision or output was created here.

```powershell
python -B tools/prepare_card_reverify.py --selection "D:\offline_fixture\decision.json" --selection-sha256 "<decision-sha256>" --out-dir "D:\offline_fixture\new-package"
python -B tools/prepare_card_reverify.py --selection "D:\offline_fixture\decision.json" --selection-sha256 "<decision-sha256>" --out-dir "D:\offline_fixture\new-package" --materialize
python -B tools/prepare_card_reverify.py --verify-package "D:\offline_fixture\new-package" --package-manifest-sha256 "<externally-pinned-package-manifest-sha256>"
```

Preparation defaults to read-only validation, including final input rehashing.
Both preparation modes require an absent absolute output path with an existing
parent. `--materialize` alone permits creating that new directory and its six
files. Existing outputs are refused, including in dry-run mode. Exit status is
zero on success, two on a validation failure. Successful preparation prints the
report and `package_manifest_sha256`, including in dry-run mode; retain that
external pin to verify a materialized package. The package bytes and manifest
hash are identical for dry run and materialization with identical inputs/code.

Verification requires the external manifest hash and is mutually exclusive with
preparation arguments. It checks the complete five-output hash inventory, refuses
unexpected package entries, recompiles from the pinned decision and full original
inputs, and compares all six files byte for byte. It then rehashes both the input
read set and the package files. Complete directory membership and safe regular-file
types are checked before reconstruction, immediately after reconstruction, and
again after the final hash checks, just before returning success. Unexpected files
or directories, symlinks and reparse points fail on that verification invocation.
The verifier writes no files and does not remove entries introduced by another
writer. This verifies package integrity/reconstructability, including the selected
messages and fixed contract; it grants no dispatch or semantic certification.
Original pinned files, compiler/core bytes and canonical prompt must remain
available and unchanged for reconstruction.

## Validation And Provenance

Each source binds the original job's `book`, model, original coverage/sentences
hashes, and sibling generator. Reused-generator/verifier-only jobs cannot replace
the original generator job. If `output_file_hashes` is present, all its entries
must have safe relative paths and valid hashes, and its generator entry must
match the actual full generator file, even when decision pins were refreshed.

Every generator row and card is indexed within its work and generation hash.
Local IDs may repeat across different works. Duplicate selected
`work|window|card` case IDs across competing snapshots are refused rather than
creating ambiguous requests. Source records may omit `work_id` or set it to null,
as supported by the core; any explicit conflicting work is rejected globally.

A selected window must bind its chapter and exact ordered sentence IDs to the
original coverage/source. Its parent call requires integer HTTP 200, the exact
job model, `finish_reason=stop`, explicit null `error`, `model_parse_ok=true`, and
explicit null `parse_error`. A recorded content hash, when present, must agree.
Strict raw JSON must contain only `propositions`, a list of at most three items;
the proposed count, card count, positional IDs and original generator-card
objects must correspond exactly and in order. Rejected siblings do not prevent
a sound selected candidate from passing these parent correspondence checks.

Each selected candidate must pass the current core schema/span validator, have
the same canonical normalized card, original `accepted_for_verification=true`,
explicit empty `schema_errors`, and the correct route and work/window/chapter
bindings. Any selected failure aborts before output creation. There is no
automatic replacement, fallback selection, whole-book completion, or verdict.

All historical snapshots remain `UNVERIFIED_verifier_INPUT`, including snapshots
whose historical job says `ok=true`. Missing acceptance-contract-v2 metadata,
output manifests, and declared/pinned raw captures are reported as provenance
warnings and mark legacy input. This compiler does not validate saved raw call
captures, even if their entries are declared in a v2 job. Consequently
`strict_v2_provenance_validated=false` and `raw_captures_not_validated` remain
explicit for every snapshot. This is sufficient for preparing new independent
verifier inputs, never evidence of a previously verified candidate.

The pinned prompt must be byte-identical to the current canonical
`proposition_verifier_prompt_v3_acceptance_contract_2.txt`; expected markers and
all eight field names are checked. Its system/user templates are rendered with
the core's single-pass renderer, using only the normalized candidate and its
exact sliced evidence. Generator rationale, raw response and unused source
sentences are excluded from messages. Original file references/hashes and
generation/card/evidence hashes accompany each input outside the prompt.

The request plan whitelists `unstructured_analysis`, its pinned configuration's
model/context/sequence/thinking settings, and the existing `ver16000` budget of
16000 output tokens. It requires thinking enabled, serial policy sequence limit
one, sufficient configured context, and no smaller explicit profile token cap.
The plan describes one completion per selected input and zero automatic retries.
It contains no endpoint, credentials, authorization headers or executable runner.
Every package record and plan has `dispatch_authorized=false`.

## Package Accounting

| File | Contents |
| --- | --- |
| `verifier_inputs.jsonl` | One record per explicit valid selected card, exact canonical-contract messages, sliced evidence, normalized card, source/hash bindings and inert request plan. |
| `rejected_cards.jsonl` | Every inventoried original generator card rejected by current schema/span checks, original/observed codes, disagreement notes, source references and hashes; no candidate/source prose. |
| `unselected_cards.jsonl` | Remaining cards, current validation status and inherited-flag/normalization disagreements; never implied accepted. |
| `generation_issues.jsonl` | Each bad generator envelope, parse/count/correspondence or source-window binding, including windows with zero cards; source references, row location, observed card count and error markers. |
| `preparation_report.json` | Snapshot/legacy provenance, global/per-work/per-route counts, full input hash inventory, card accounting and hashes of the four JSONL files. |
| `package_manifest.json` | Version, pinned decision, complete input inventory, boundaries and hashes of all five other package files. Its own hash is pinned externally to avoid a hash cycle. |

For each snapshot and globally:

```text
verifier_inputs + rejected_cards + unselected_cards = inventoried_cards
```

Generation-issue counts describe windows and are separate from card arithmetic.
An unselected card whose original source window cannot be reconstructed remains
explicitly `schema_span_status=unassessable` in the unselected ledger, with a null
candidate hash, a source-window disagreement marker and a corresponding generation
issue. It is never called valid or selected. Malformed card objects/IDs and
ambiguous duplicate IDs abort preparation rather than inventing identities.

Rejection classification uses current validation, not inherited acceptance flags.
Ordinary error codes are preserved. Unknown field-name details or non-code prose
in recorded errors are reduced to diagnostic codes; a hash of the full original
error value and the full original generator reference preserve its audit binding.
All packages set `whole_generation_certified=false`, `quality_certified=false`,
`automatic_promotion_permitted=false`, `no_runtime_effect=true`, and
`review_only=true`. There is no accepted verdict or runtime/promotion artifact.

Parsing and ID indexes are cached once per referenced file per invocation.
Windows are built once per inventoried generator row, not per selected card.
There is no persistent/mtime cache. Every read input, including decision, prompt,
config, compiler and core, is rehashed immediately before any materialization.
JSONL records split only on actual LF bytes. CRLF record endings remain valid JSON
whitespace. Literal UTF-8 U+2028, U+2029 and U+0085 inside JSON strings remain part
of the source text, preserving character offsets, sliced evidence and its hash.

## Fixture Verification

Executed from the repository root on Windows using bytecode-disabled Python:

```powershell
python -B -m unittest discover -s tests -p test_card_reverify_preparation.py -v
python -B -m unittest discover -s tests
```

| Suite | Run | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: | ---: |
| New card preparation | 33 | 32 | 1 | 0 |
| Existing effective selector | 42 | 42 | 0 | 0 |
| Existing core/runner/attempt/postflight | 124 | 123 | 1 | 0 |
| Full suite total | 199 | 197 | 2 | 0 |

The new skip is the real symlink fixture: this Windows host lacks symlink-creation
permission. Reparse-point rejection is additionally exercised with mocked file
attributes without requiring that privilege. Existing suite dispatch/subprocess
behavior is mocked; all generations, decisions and materialized packages used
for tests are temporary fixtures. These results establish Windows execution only;
native POSIX execution was not performed.

The base imperfect-book fixture accounts for three cards as one selected, one
rejected sibling and one valid unselected card, with zero generation issues.
The unselected bad-window fixture preserves both a failed populated window and
a zero-card failed window as two generation issues without losing any cards.
The two-work collision fixture accounts for six cards as two selected, two
rejected and two unselected, retaining separate work-bound case IDs.

Regressions cover wrong-work collisions at every join, changed/repinned sources,
normalized/raw mismatch, rejected selection, strict duplicate keys and IDs,
conflicting/invalid pins, legacy provenance, exact v3 message reconstruction,
rationale/source/credential exclusion, no-write dry runs, absent-output rules,
final mutation detection, deterministic bytes, parse/index caching, external
manifest pins, output tampering and tampering with self-consistent output hashes.

Independent-review regressions also add `unexpected.jsonl` or a directory from a
deterministic mocked reconstruction and require the first verification to fail.
A separate mutation occurs after the final known-file hash checks and must fail
the final directory inventory. Mocked known-entry directory/symlink/reparse types
exercise the repeated safety checks without requiring symlink privileges. Existing
package bytes stay unchanged in every mutation test; injected entries are left
untouched by the verifier.

The Unicode fixture writes source records with `ensure_ascii=False`, checking
that all three separator characters are literal UTF-8 inside JSON strings and
that only record delimiters contain physical newline bytes. Both LF and CRLF
files agree with `C.read_jsonl`. Separators outside selected support preserve
the original span values, evidence bytes/hash and exact messages. Separators
inside support retain the same literal character offsets and exact UTF-8 sliced
evidence/hash. All four combinations materialize and verify successfully without
altering the source bytes.
