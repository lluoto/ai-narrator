# Offline Literal Experiment Handoff

`tools/prepare_literal_experiment.py` supplies a separate, bounded path from a
pinned selection to inert generator requests, then from saved raw envelopes to
literal-normalized candidate records. It integrates `normalize_payload` only in
this experiment. The production runner, helpers, prompts, configuration, and
outputs are outside its implementation scope.

This session performs no Qwen calls, API/model/health requests, service checks,
or process controls. Only synthetic temporary fixtures are exercised. The CLI
contains no transport, automatic dispatch, bulk inference, retries, verifier
requests, or promotion. Loading core code uses only its pure parsing, rendering,
preflight, window-building, and card-validation contracts.

## Selection Contract

The selection is one strict JSON object with exactly these schema-1 keys:

```json
{
  "schema_version": 1,
  "worker_config": {"path": "ABSOLUTE_WORKER_CONFIG", "sha256": "LOWERCASE_SHA256"},
  "literal_prompt": {"path": "ABSOLUTE_LITERAL_V2_PROMPT_OR_IDENTICAL_COPY", "sha256": "LOWERCASE_SHA256"},
  "cases": [
    {
      "case_id": "explicit-case-1",
      "work_id": "explicit-work",
      "window_id": "explicit-window",
      "coverage": {"path": "ABSOLUTE_FULL_COVERAGE_JSONL", "sha256": "LOWERCASE_SHA256"},
      "sentences": {"path": "ABSOLUTE_FULL_SENTENCES_JSONL", "sha256": "LOWERCASE_SHA256"}
    }
  ]
}
```

Uppercase placeholders describe required values; they are not usable paths or
pins. Supply one through five explicit cases. Each reference has exactly `path`
and `sha256`, using 64 lowercase hexadecimal characters. Selection, response
association, and package-manifest hashes must be supplied externally on the CLI.
Unknown fields in owned schemas, duplicate JSON keys, nonfinite/overflowed JSON
numbers, duplicate case IDs, duplicate selected windows in one source scope,
conflicting pins, and duplicate IDs anywhere in the full source snapshots fail.
Paths must be absolute and nontraversing. Symlinks, reparse points, unsafe Windows
components, device paths, and alternate streams are rejected.

The prompt must be byte-identical to the canonical
`runs/_extraction_scheduler/20260924/proposition_canary_prompts/proposition_generator_prompt_v2_literal_evidence.txt`.
The pinned config must provide `profiles.structured_source` with the configured
localhost port-8000 chat-completions endpoint, an explicit model, thinking
disabled, `output_contract=strict_json`, `max_tokens=1500`, `max_model_len=8192`,
and `max_num_seqs=1`. Requests use that exact model, temperature zero, a 1500-token
budget, and `chat_template_kwargs.enable_thinking=false`.

Full original coverage and sentence files are pinned and preserved byte for byte
in the package. They must be the intended full snapshots, not caller-created
selected-row extracts; the tool cannot infer whether a caller omitted historical
rows before pinning a file. Core `preflight_sources` checks all snapshot IDs and
declared work bindings. Missing/null source `work_id` follows the core contract;
an explicit conflicting work fails, including in unselected rows. Only selected
windows are built. Their chapter prefixes, exact ordered sentence IDs, source
record bindings, nonempty text, and selected-work binding pass core `build_window`.
Unselected windows are not extracted or built. Each shared input is read/parsed
once per invocation, with separate final byte rehashes that bypass the cache.

Template rendering is one pass. Source braces and instruction-like source text
remain original data; they cannot trigger another substitution. All supplied
source content, including copied literal instructions, is untrusted source data.
Literal provenance does not prove that a remote model resisted instructions or
that a candidate is semantically entailed.

## Prepare Offline

From the repository root, use a new absolute output path whose parent exists:

```powershell
python -B tools/prepare_literal_experiment.py prepare --selection "D:\offline_fixture\selection.json" --selection-sha256 "<selection-sha256>" --out-dir "D:\offline_fixture\literal-package"
python -B tools/prepare_literal_experiment.py prepare --selection "D:\offline_fixture\selection.json" --selection-sha256 "<selection-sha256>" --out-dir "D:\offline_fixture\literal-package" --materialize
```

Default behavior validates, reconstructs bytes in memory, rehashes inputs, and
prints the report and `package_manifest_sha256` without filesystem writes,
including bytecode caches. Only `--materialize` creates a new directory. An
existing output is refused in both modes. Keep the printed package-manifest hash
outside the package. Identical input/code bytes produce identical package bytes
and the same manifest hash, independent of the chosen package output directory.

| Package File | Contents |
| --- | --- |
| `request_0001.json` through the selected case count | Canonical inert request bodies, with no endpoint, credential, authorization header, or executable dispatch. |
| `requests.jsonl` | Ordered case/work/window/chapter/sentence/source bindings and each exact request-body filename and SHA-256. |
| `source_0001.jsonl` onward | Unique complete pinned coverage/sentence snapshots, byte for byte. |
| `preparation_report.json` | Code/core/normalizer/prompt/config pins, input inventory, full-snapshot mapping, bounds, and generator settings. |
| `package_manifest.json` | Complete output hash inventory, selection pin, input inventory, and candidate-only boundaries. Its own hash is external. |

Canonical JSON uses sorted keys, ASCII escapes, compact separators, and no
nonfinite numbers. Request-body hashes cover canonical bytes without a trailing
newline. JSON reports and JSONL records add exactly one newline. Full source and
raw-response copies preserve their original bytes. The original tool, core,
normalizer, selection, config, canonical/selected prompts, and sources must remain
available and unchanged for acceptance reconstruction.

## Separate Inference Session

An explicitly authorized inference session handles at most the selected five
manual generator calls. It must review the package and external manifest pin,
use each selected request body as inert input, and preserve raw response bytes
first, before parsing or normalization. It records the actual integer HTTP status
and whether the response body was fully captured. It must preserve failed,
truncated, and interrupted responses and never overwrite an earlier capture.
No live inference is performed by this tool or authorized by merely preparing
or accepting a package. Additional attempts require a separate bounded decision;
there is one response association per selected case in an acceptance invocation.

After raw-first capture, that session supplies a separately pinned association
file with exactly this shape:

```json
{
  "schema_version": 1,
  "responses": [
    {
      "case_id": "explicit-case-1",
      "request_body_sha256": "EXACT_HASH_FROM_REQUESTS_JSONL",
      "raw_response": {"path": "ABSOLUTE_IMMUTABLE_RESPONSE_BODY", "sha256": "LOWERCASE_SHA256"},
      "http_status": 200,
      "response_complete": true
    }
  ]
}
```

The association may contain a subset, including an empty list. Every omitted
selected case is reported as `unattempted`; omission cannot become success.
Unknown case IDs, duplicate associations, and unknown association fields fail
the invocation. Observed model, choice count, finish reason, and content come
from the pinned raw envelope itself, not extra caller metadata.

**The caller-provided case/source/request/response association is an audit link,
not proof that a remote model evaluated the packaged request.** Hashes verify
local bytes and reproducible bindings. They do not attest remote execution,
model identity beyond its recorded envelope, source authenticity, or capture
completeness beyond the caller's declaration.

## Accept Saved Responses Offline

```powershell
python -B tools/prepare_literal_experiment.py accept --package "D:\offline_fixture\literal-package" --package-manifest-sha256 "<external-package-manifest-sha256>" --responses "D:\offline_fixture\response-association.json" --responses-sha256 "<association-sha256>" --out-dir "D:\offline_fixture\literal-review"
python -B tools/prepare_literal_experiment.py accept --package "D:\offline_fixture\literal-package" --package-manifest-sha256 "<external-package-manifest-sha256>" --responses "D:\offline_fixture\response-association.json" --responses-sha256 "<association-sha256>" --out-dir "D:\offline_fixture\literal-review" --materialize
```

Acceptance defaults to no writes. Its output must be new and outside the input
package. Before normalization, the external manifest pin is checked, all package
bytes are reconstructed from the original pinned inputs, and the manifest and
every package file are compared byte for byte. Self-asserted package hashes are
insufficient, even if a modified manifest is freshly pinned. Directory membership
and regular-file safety are checked around byte rehashes. Sources, code, prompts,
config, package, association, and successfully pinned raw files are rehashed after
processing and again after materialization. Detected concurrent mutation fails
the invocation; these checks do not provide a filesystem lock or remote attestation.

Each attempted case requires its exact packaged request-body hash, integer HTTP
200 (booleans fail), `response_complete` exactly true, the exact configured model,
one choice, `finish_reason=stop`, and string assistant content. A `length` finish
is rejected even if content looks complete. Raw envelopes use strict JSON with
duplicate-key detection at every depth. The tool permits the conventional
OpenAI envelope metadata fields enumerated in `envelope`; unknown fields fail
with static diagnostics. Tool calls and refusals are rejected. Optional reasoning
content remains only in the immutable raw copy and is not used for normalization.

Only original assistant content, as a string, goes to the real
`literal.normalize_payload`. No fence stripping, prose repair, fallback parser,
offset guessing, or model retry exists. Literal matching preserves Unicode,
negation, attribution, and whitespace exactly. Missing or ambiguous quotes and
invalid schemas reject that case's entire proposal batch; no cards or receipts
from that case are retained. Other cases have independent, explicit statuses.

| Acceptance File | Contents |
| --- | --- |
| `case_results.jsonl` | Every selected case, including unattempted/rejected cases, normalized legacy `CARD_KEYS`, literal provenance receipts, original scope/request/source pins, observed valid-envelope metadata, and diagnostic codes. |
| `raw_response_0001.bin` onward | Exact bytes of each successfully pinned raw file, including rejected envelopes. No prior response file is modified. |
| `acceptance_report.json` | Selected/attempted/pending/rejected/unattempted/error/proposition counts, unattempted IDs, per-case errors, association pin, scope, and boundaries. |
| `acceptance_manifest.json` | Package/association pins and hashes of every other new output file. The printed hash pins this manifest externally. |

Valid cases have `status=pending_independent_verification` and the corresponding
boolean true, including a valid empty proposal batch. Rejected and unattempted
cases have empty cards/receipts and that boolean false. `batch_accepted` is always
false. `all_selected_cases_normalized` describes coverage and structural/literal
normalization only; any rejected or unattempted case makes it false. Candidate
records and receipts are never full acceptance, semantic verification, or runtime
promotion. This generator-only tool creates no verifier request; generator
reasoning/CoT must never be copied into subsequent independent verifier requests.

Exit zero means the offline invocation completed and its report is available;
case rejections and omissions must be read from the report. Exit two indicates
an invocation-level failure such as invalid selection/association, pin mismatch,
package tamper, unsafe path, or concurrent mutation. If an I/O failure or mutation
is detected after creating a new directory, partial files may remain for audit;
do not treat them as a completed package or reuse the directory. The tool never
removes concurrent changes or overwrites an old output.

## Verification

All experiment tests copy code and the canonical prompt into a temporary fixture
tree, construct synthetic full sources/config/selections, and use saved mock
envelopes with the actual normalizer. No production selection, package, or saved
model output is created during implementation verification. Run with bytecode
writes disabled and temporary storage under the approved temporary directory:

```powershell
python -B -m unittest discover -s tests -p test_literal_experiment.py -v
python -B -m unittest discover -s tests -p test_proposition_literal_evidence.py -v
python -B -m unittest discover -s tests -p test_proposition_canary_contract.py -v
python -B -m unittest discover -s tests -p test_proposition_canary_runner.py -v
```

Coverage includes the full prepare/raw-save/normalize path, Unicode code-point
spans, repeated and missing matches, empty proposals, five-case mixed outcomes,
unattempted accounting, one-pass rendering, shared-input caching, full snapshots,
wrong work/model, length stops, strict schemas/duplicate IDs/keys, all external
pins, tamper and repinned self-assertions, mutation during validation/rehashing,
absent-only output handling, immutable raw preservation, and no dry-run writes.

Executed offline on 2026-10-15 with `-B` and temporary storage under
`C:\Users\lluoto\AppData\Local\Temp\opencode`:

- Experiment suite: 24 passed.
- Existing literal-normalizer suite: 18 passed.
- Existing core-contract suite: 45 passed.
- Existing core-runner suite: 9 passed.
- Total: 96 passed, zero failures/errors, zero live requests. Existing transport
  and health-preflight tests use mocks only.

These results check local contracts and reproducibility. They do not measure
live Qwen literal-copy compliance or semantic precision. No production package
or acceptance output was materialized in this session.
