# Compact Verifier Implementation

Date: 2026-10-15. Status: OFFLINE EXPERIMENT ONLY, NOT PRODUCTION SELECTED.
Semantic quality, token savings and latency improvements are unproven. This is a
content parser and a complete experimental prompt, not the design's proposed
transport-binding implementation or a completed verification pipeline.

## Owned Files

- `tools/proposition_compact_verifier.py`, relative to the worldmodel root.
- `tests/test_proposition_compact_verifier.py`, relative to the worldmodel root.
- `../proposition_canary_prompts/proposition_verifier_prompt_v4_compact_experiment.txt`.
- This implementation note.

`COMPACT_VERIFIER_DESIGN.md` was read in full and remains unchanged. The core,
helpers, existing prompts, configuration, outputs and selection paths were not
edited. No production scan, model/API/health request, service/process inspection,
or runtime integration was performed. The only execution was offline unit tests;
existing core tests use mocked transport and temporary artifacts. No inference
or rollout is authorized by these files.

## API And Ownership

Import through the existing namespace package:

```python
from tools.proposition_compact_verifier import (
    CONTRACT_VERSION, CompactVerifierError,
    build_model_output_schema, parse_compact,
)

schema = build_model_output_schema()
# Preconditions below must already hold. No transport or binding is done here.
result = parse_compact(
    content, normalized_card, validated_core_window,
    contract_version=CONTRACT_VERSION,
    answer_format="strict_json",
)
```

The stable experimental contract is exactly
`proposition_verifier_compact_experiment_v1`. The design's
`proposition_verifier_compact_v1_draft` is not accepted. Both `contract_version`
and `answer_format` are required keyword-only inputs chosen from trusted caller
metadata before inspecting the output. There is no shape-based dispatch, legacy
conversion, parser fallback, wrapper attachment or file/command entry point.

`build_model_output_schema()` returns a fresh JSON-compatible dictionary.
`parse_compact()` returns only `model_checks`, program-computed `overall`, and
these constant policy boundaries:

```json
{
  "no_runtime_effect": true,
  "review_only": true,
  "quality_certified": false,
  "automatic_promotion_permitted": false
}
```

`model_checks` is an object in canonical core field order; each check contains
exactly `verdict`, `evidence_ids`, `reason_code`. The overall reducer uses core
`VERDICT_PRECEDENCE`: `contradicted > insufficient_evidence > abstain > entailed`.
Valid negative and abstaining verdicts return normally. Invalid responses raise
`CompactVerifierError` with a fixed local code, with no partial checks or semantic
overall returned. Model field errors name the affected trusted field, for example
`proposition_text:citation_outside_sent_card`; arbitrary keys, citations and input
prose are never copied into the error message. These flags describe review policy;
they do not attest to source truth or successful transport/source binding.

The module uses stdlib only and calls core `validate_card` plus core constants.
Importing the core defines filesystem/network-capable functions; this module
does not invoke those operations. It does not read files, access network/DB,
dispatch processes, mutate arguments, persist artifacts or select results.

## Required Caller Preflight

The API intentionally accepts no expected case/work/request/response envelope.
It cannot validate HTTP status, response completeness, model identity, choice
count, finish reason, source work identity, or association with a specific call.
A syntactically complete JSON answer can still come from a truncated transport
or a response with `finish_reason=length`. Content success is not full verification.

Before calling this parser, a future trusted caller must do the following:

1. Freeze the original generation/candidate/source snapshots and exact evidence
   manifest. Validate source records with the core source preflight/build-window
   path. Bind work/window/card identity and source/candidate hashes to a unique
   immutable call/attempt and pinned contract, prompt, schema and adapter settings.
2. Durably capture the exact serialized request bytes and request hash in a
   request ledger before dispatch. Deliver exactly those bytes through a transport
   handle owned by that call. Save raw response bytes and their hash, and durably
   associate them with the same call/request before any envelope/content parsing.
   Missing, interrupted, ambiguous or failed capture/association blocks acceptance.
3. Verify the complete HTTP/API envelope against the pinned request: expected
   success status/model, exactly one choice, expected stop finish and string public
   content, with no partial-body/decode errors. Preserve raw reasoning separately;
   never parse `reasoning_content` as fallback public content. Pin the adapter
   independently of whether any particular output happens to contain tags.
4. Verify that the exact normalized card and evidence manifest agree with the
   actual rendered request. Preserve every `(work_id, sentence_id, start, end,
   exact_text)` slice, original offsets and source bytes without expansion or
   merging. The card's IDs must be exactly the IDs of its sent spans; every card
   span must have been sent unchanged. Then pass that card and validated core
   window to this parser. Core `validate_card` is repeated here for card/span and
   vocabulary validation; it does not reconstruct the request bytes.
5. Only after those gates and content validation succeed may the caller attach
   trusted case/work/call metadata and request/response references/hashes in its
   own envelope. Failures retain bound artifacts and deterministic failure status
   without an accepted semantic overall. Independent source review is still needed
   to assess whether the model's judgments are correct.

Never attach by output order, timestamp, filename, citation overlap or an echoed
model identifier. The core window omits work identity. Two works can share local
sentence IDs and both pass this content parser with their own valid cards. An
owned fixture deliberately demonstrates that limitation; it does not claim swap
protection. A hash records bytes, not proof that a remote model used the intended
request. Rehashing an incorrectly paired response cannot repair its provenance.
The design's durable-ledger, broken-dispatcher and binding-spy tests belong to a
future caller implementation and are not claimed by this task.

## Content Rules

The top-level model object has exactly core `REQUIRED_VERIFIER_FIELDS`:
`primary_route`, `proposition_text`, `assertion_status`, `temporal_status`,
`evidence_directness`, `content_facets`, `generality_scope`, `claimant_or_source`.
Object order is irrelevant to validation and field identity. No identifiers,
contract echo, overall, hashes, flags, summaries or coverage wrappers are allowed.
Every check has exactly the three required members. Duplicate JSON keys at every
depth, unknown keys/values, wrong verdict/code pairs, bad types, uncovered fields,
nonfinite numbers including float overflow, and invalid citations fail closed.

| Verdict | Reason Code | Restriction |
| --- | --- | --- |
| `entailed` | `semantic_support` | Ordinary meaning support |
| `entailed` | `narrator_null_supported` | Claimant only; null narrator candidate and entailed assertion check |
| `insufficient_evidence` | `missing_support` | Source does not establish the value |
| `insufficient_evidence` | `ambiguous_support` | Competing source readings remain |
| `insufficient_evidence` | `unresolved_claimant` | Claimant only; null non-narrator candidate |
| `contradicted` | `source_conflict` | Positive source conflict |
| `abstain` | `policy_undecidable` | Undecidable classification policy boundary |

Every null non-narrator claimant requires exactly insufficient/unresolved as
spelled `insufficient_evidence` / `unresolved_claimant`. For a null narrator
candidate, an entailed claimant check requires `narrator_null_supported` and an
entailed assertion-status check. Ordinary `semantic_support` cannot certify that
null. Narrator candidates with unsupported null attribution can return ordinary
negative or abstaining claimant results. Neither special null code is available
to non-null claimants. Actual narrator attribution remains a semantic question.

Each citation array is nonempty, unique and a subset of the validated card's
actually sent IDs, including for negative results. The parser excludes unsent
neighbors even when present in the full window. Multiple spans with the same ID
authorize only those exact slices. This parser cannot detect semantic reliance
on omitted portions of a cited sentence; source review and the caller's manifest
check remain necessary. Literal presence, valid offsets and citation membership
never force entailment or preclude contradiction. Taxonomy mappings do not
require literal enum spellings in source text.

## Answer Adapters

`strict_json` is the thinking-off public-answer adapter. It consumes one JSON
object in full with only surrounding JSON whitespace (space, tab, CR, LF).
Fences, tags, BOM, leading commentary, trailing text, multiple objects and
malformed/truncated JSON fail. There is no arbitrary object search or salvage.

`qwen_final_block` is the explicitly selected thinking-on adapter. Its anchored
grammar accepts one complete `<VERDICT_JSON>JSON</VERDICT_JSON>` block, optionally
preceded by one closed `<think>...</think>` or an implicit-opening thought ending
in `</think>`. Only JSON whitespace may separate the closed thought and final
block or surround the public block. Exact verdict markers inside thought are
rejected as ambiguous, as are repeated/unclosed think wrappers, extra blocks,
untagged public answers, other public prefixes and trailing output. The JSON
inside the final block passes the same strict decoder and semantic validation.
No raw thought is returned. A thought containing valid JSON with an empty or
malformed final answer still fails.

Both adapters enforce a 65,536-character content limit, strict UTF-8 encodability
of the supplied string and a maximum JSON container nesting depth of 16. Depth
scanning respects quoted strings and escapes. These are local content bounds,
not claims about HTTP decoding, provider token limits or finish validation.

## Prompt And Schema

The v4 experimental prompt is complete: system and user sections, visible eight
field list, full closed reason matrix, full Draft 2020-12 JSON schema, pinned
taxonomy token definitions, claimant guards and a complete fictional candidate,
sent excerpt and eight-field answer. No schema filename, external catalog or
unresolved schema placeholder is needed. It explicitly treats source/candidate
text as untrusted data and provides both serialization rules.

The schema builder and validator share core field/verdict constants and the
module's `REASON_MATRIX`. Owned tests compare the prompt's complete embedded
schema to `build_model_output_schema()` by decoded equality, compare schema pairs
to that matrix, check visible field/code lists, compare every taxonomy enum to
the current core, and parse the complete example. Runtime card-dependent claimant
guards and exact citation membership remain additional to JSON Schema.

The catalog deliberately preserves `attributed_context` in both primary routes
and content facets. It does not migrate to the newer `attribution_only` spelling
or add `claimant_status` to the current candidate contract. Taxonomy explanations
are this experiment's prompt definitions, not a change to core validation policy.

Only real input substitutions remain: `answer_format_json`, `work_id_json`,
`candidate_json`, `sent_evidence_json`. A future caller must JSON-serialize these
values, verify its trusted selector, substitute once without recursively
interpreting inserted text, and reject unresolved template inputs before dispatch.
`sent_evidence_json` must carry the complete exact manifest described above.
No rendering/dispatch integration is included. The existing runner cannot consume
this prompt simply by changing a prompt path; its parser expects a different
contract. Historical results retain their original contracts and provenance.

## Offline Verification

Executed from the worldmodel root with bytecode writing disabled:

```text
python -B -m unittest discover -s tests -p "test_proposition_compact_verifier.py" -v
43 tests passed, 0 failures, 0 errors.

python -B -m unittest discover -s tests -p "test_proposition_canary_*.py" -v
54 existing core tests passed, 0 failures, 0 errors.
```

The existing suite covers `test_proposition_canary_contract.py` and
`test_proposition_canary_runner.py`; all transport is mocked. Its temporary
artifacts were directed to `C:\Users\lluoto\AppData\Local\Temp\opencode`.
The compact suite reads only this experimental prompt and uses synthetic
in-memory cards/windows. Counts are unittest test methods; parameterized subtests
within those methods exercise additional fields, codes, statuses and failures.

Coverage includes every field, reason compatibility, all verdict precedence
combinations, supported/unsupported/null/non-null claimants, card/span validation,
sent-card versus full-window citations, repeated IDs across works, multiple slices,
literal-present contradiction/insufficiency, enum support without literal tokens,
strict JSON/tag failures, resource bounds, no mutation, sanitized errors, schema
freshness/parity and inert parsing. These establish protocol behavior only. No
semantic quality, transport binding, model finish handling, efficiency gain or
production readiness has been demonstrated by these unit tests.
