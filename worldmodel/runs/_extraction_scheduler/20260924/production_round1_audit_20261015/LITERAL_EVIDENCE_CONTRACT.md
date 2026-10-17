# Literal Evidence Proposal Contract v2

Status: **candidate_only / no_runtime_effect**. Offline implementation and synthetic
tests only. No live validation, production integration, inference calls, process
inspection/control, or live artifact reads/writes are part of this change. The
existing core runner, selected prompts, helpers, configuration, outputs, route
queues, and slot ontology are unchanged. A separate owner must perform a smoke
evaluation before any future integration; this document does not authorize it.

## Pure API

```python
from tools import proposition_canary_run as core
from tools.proposition_literal_evidence import normalize_payload, LiteralEvidenceError

# In-memory source records must already be pinned to the intended work/chapter.
window = core.build_window(coverage_record, sentence_records_by_id)
result = normalize_payload(model_payload_or_json_string, window)
legacy_cards = result["propositions"]
receipts = result["provenance"]
```

This is a library, with no CLI, dispatch, persistence, retries, or promotion.
Success returns a fresh object containing `contract_version`, `candidate_only:
true`, `no_runtime_effect: true`, `propositions`, and `provenance`. Any invalid
card raises `LiteralEvidenceError`; no partially normalized batch is returned.
Empty `propositions` succeeds with empty cards and receipts. At most three cards
are allowed. The caller's payload and source window are never mutated. Returned
cards, receipts, and repeated calls have independent mutable containers.

The model envelope remains exactly `{"propositions": [...]}`; the version belongs
to this explicitly named prompt/API and the returned envelope/receipts. Each
proposal has all legacy `CARD_KEYS` except that `evidence_quotes` replaces
`evidence_spans`. No semantic field is inferred, rewritten, or renamed. Each
proposal must contain exactly one quote and `evidence_ids == [quote.sentence_id]`.
Quote shape is exactly:

```json
{"sentence_id":"B001:C0001:S000001","source_slice":"exact literal","source_context":null}
```

Unknown/missing fields, unknown types, empty/null slices, multiple quotes,
extraneous offsets, and unsupplied IDs fail. The string path uses the core strict
JSON parser, rejecting duplicate keys at all depths, NaN/Infinity constants,
non-object envelopes, fences, and trailing prose. Numeric values have no valid
position in this model schema, including overflowed JSON numbers. Already parsed
objects cannot reveal duplicate keys discarded by another parser; pass original
JSON strings when duplicate-key detection is needed.

## Source Binding

The input must be the ORIGINAL validated window returned by current core
`build_window`, after the caller's existing source/work preflight. It is not a
model-supplied window or an arbitrary sentence lookup. `build_window` checks
window/chapter IDs, sentence/chapter prefixes, source-record identity, duplicate
IDs, text, and work equality when both records declare a work. Core preflight
performs the intended-book checks. Those upstream requirements remain in force.

The normalizer rechecks the exact core window shape, sentence ID/text-map
membership, and reconstructed `build_window` result, including `sentences_block`.
Only IDs actually supplied in that window may be cited. Literal lookup stays in
the quote's pinned sentence; text in another supplied sentence cannot repair it.
Core windows discard `work_id`; the normalizer cannot recover or authenticate a
work binding from them and does not invent a work receipt. It must not substitute
for upstream source/work validation or authenticate caller-forged source data.

## Matching Rules

Algorithm: `exact_overlapping_literal_context_v1`.

1. Search the original Python sentence string for every exact nonempty
   `source_slice` occurrence, advancing one Unicode code point between searches
   so overlapping matches count. No match fails.
2. With null context, require exactly one occurrence. Never select the first of
   multiple matches.
3. A supplied context must be a strictly larger exact contiguous substring of
   that same sentence. It must contain the slice exactly once, counting overlaps.
   Enumerate all overlapping context occurrences and retain only slice starts
   they enclose. Exactly one quote candidate must remain. Missing or ambiguous
   context fails, even when the slice alone happens to be unique.
4. Derive `start` and `end = start + len(source_slice)` in Python Unicode code
   points, with an inclusive start and exclusive end. Support is ONLY the slice;
   context never expands the evidence span or supplies additional claim support.
5. Construct the old `CARD_KEYS` card and call current core `validate_card` after
   conversion. Any core schema/enum/citation error fails the whole batch.

No trimming, case folding, Unicode NFC/NFKC normalization, punctuation repair,
combining-mark removal, byte/UTF-16 indexing, or paraphrase matching is allowed.
Negation, modality, conditionality, and attribution must remain in model claims
and supporting literals. Exact matching checks provenance, not these semantics;
it neither repairs a false claim nor certifies entailment or quote minimality.

Synthetic Unicode example: in `\u7532\U0001f600\u8bf4\uff1a\u201c\u95e8\u4e0d\u80fd\u5f00\u3002\u201d e\u0301`
(Python string notation), the negative slice `\u95e8\u4e0d\u80fd\u5f00` has span
`[5, 9)`, the astral emoji `[1, 2)`, and `e\u0301` `[12, 14)`. In `aaab`, slice
`aa` has overlapping candidates 0 and 1; context `aab` selects `[1, 3)` without
expanding to the context. In `aaa`, context `aaa` contains `aa` twice and fails.
The new prompt also gives synthetic Chinese examples with repeated phrases.

## Provenance Receipts

One deterministic receipt per card, in card order, includes:

- `contract_version`: `proposition_literal_evidence_v2`.
- `algorithm`: `exact_overlapping_literal_context_v1`.
- Zero-based `proposition_index`, `window_id`, `chapter_id`, and `sentence_id`.
- `source_text_utf8_sha256`: SHA-256 of the full original sentence encoded as
  strict UTF-8, without newline or preprocessing. Non-encodable text fails.
- `evidence_quote`: independent copy of the original exact quote object,
  including its literal, context, and explicit null when present.
- `literal_context_canonical_sha256`: SHA-256 of that exact quote object encoded
  with `json.dumps(quote, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
  allow_nan=False).encode("ascii")`, without a trailing newline. This hashes
  original decoded strings, not source spelling of JSON escapes or key order.
- `derived_span`: independent `{sentence_id, start, end}` object.
- `span_unit`: `python_unicode_code_point`; `span_interval`: `half_open`.

No timestamps, randomness, verified label, acceptance status, or entailment
verdict are generated. These hashes establish reproducible literal provenance,
not source authenticity or semantic verification.

## Prompt And Integration Boundary

The new scheduler prompt is
`proposition_canary_prompts/proposition_generator_prompt_v2_literal_evidence.txt`.
It retains every core content/modality/generality enum and the existing semantic
rules. Controlled enum strings are distinct from copied source literals. The
legacy route token **`attributed_context`** is preserved: use it only when the
attribution act itself is the content and no separable content proposition
exists. Attributed content about an entity, event, institution, location, tactic,
or mechanism keeps its content route and records attribution separately. There
is no new route, slot, quota, or operational eligibility judgment.

The old runner expects `evidence_spans` and does not load this contract. Selecting
the new prompt in the old runner alone would fail; integration requires an
explicit future owner change. Next owner must smoke the proposal-to-normalizer
path and independent semantic verification, check Unicode/repetition failures
and abstentions, preserve immutable raw payloads and receipts, and review before
any production prompt selection. No live smoke or production validation was
performed for this offline change.

## Offline Verification

Owned suite: `python -B -m unittest discover -s tests -p test_proposition_literal_evidence.py -v`.
Core contract suite: `python -B -m unittest discover -s tests -p test_proposition_canary_contract.py -v`.
Core runner suite: `python -B -m unittest discover -s tests -p test_proposition_canary_runner.py -v`.
Tests use synthetic sources and temporary artifacts; core transport is mocked.
Bytecode writes were disabled with `-B`; temporary artifacts were confined to
`C:\Users\lluoto\AppData\Local\Temp\opencode` and cleaned by the tests.

Executed offline on 2026-10-15:

- Owned literal contract suite: **18 passed** (including the final test revision).
- Existing core contract suite: **45 passed**.
- Existing core runner suite: **9 passed**.
- Total: **72 tests passed**, zero failures/errors, zero live model requests.

Coverage includes CJK, astral emoji, combining marks, original negative text and
attribution, overlapping/repeated slices and contexts, absent/invalid contexts,
forged/unsupplied IDs, model offsets and unknown fields/types, forbidden Unicode
normalization, nulls, empty batches, strict parsing, core card validation,
deterministic hashes, and deepcopy independence. These are offline contract
results only; they do not measure live model compliance or semantic precision.
