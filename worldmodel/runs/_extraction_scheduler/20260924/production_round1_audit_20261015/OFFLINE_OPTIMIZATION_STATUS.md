# Offline Optimization Status

## Implemented Without Inference

| Component | Location relative to worldmodel | Scope |
| --- | --- | --- |
| Card-scoped verifier input compiler | `tools/prepare_card_reverify.py` | Explicit pinned selections, original/rejected/unselected accounting, no dispatch |
| Literal evidence normalizer | `tools/proposition_literal_evidence.py` | Pure exact quote/context matching into Python code-point spans, no semantic rewrite |
| Versioned literal generator prompt | `runs/_extraction_scheduler/20260924/proposition_canary_prompts/proposition_generator_prompt_v2_literal_evidence.txt` | Future experimental model contract; not selected by current runner |
| Inference efficiency report | `tools/report_proposition_efficiency.py` | Explicit pinned metadata inventories, token coverage, retries and cause-code counts |
| Literal experiment preparation/acceptance | `tools/prepare_literal_experiment.py` | At most five pinned requests, saved-response envelope validation and real normalizer; no dispatch |
| Compact verifier experimental parser | `tools/proposition_compact_verifier.py` | Eight semantic checks, closed reason matrix, deterministic overall; no transport or production integration |
| Compact verifier experimental prompt | `runs/_extraction_scheduler/20260924/proposition_canary_prompts/proposition_verifier_prompt_v4_compact_experiment.txt` | Complete model-visible experimental schema; unselected by production |

No current runner, helper, canonical selected prompt, configuration, frozen smoke
input, production output or operational process was changed in this optimization
slice. No model/health requests or production batch dispatch occurred. All new
tool tests use synthetic temporary fixtures.

## Source Evidence Optimization

The literal normalizer removes model offset arithmetic. It derives an exact
half-open span from one source sentence and preserves all semantic card fields.
Repeated literal matches need exact enclosing context; absent or ambiguous
matches fail. There is no trimming, Unicode normalization, paraphrase repair,
first-match guessing, or promotion from substring presence to semantic entailment.

The normalizer is a library, not a new runner. A separate OFFLINE experiment now
integrates it in request preparation and saved-response acceptance. The current
production runner still accepts `evidence_spans`; the new model contract emits
`evidence_quotes`. Do NOT set the existing runner's `--gen-prompt` to the new
prompt. Follow `LITERAL_EXPERIMENT_HANDOFF.md` for the isolated experiment.

Full source/work binding remains upstream. Current core window objects omit the
work ID, so the pure normalizer cannot authenticate a work on its own.

## Efficiency Optimization

Reports distinguish result rows, recorded call attempts, reported retries,
claimed capture-origin identities and usage coverage. Missing usage is unknown,
not zero. Reused generation is not counted as fresh compute. Verifier card IDs,
window IDs, routes and work metadata are joined when generation is available.

Token/card ratios are withheld when required counters, usage, attempt knowledge,
lineage or identity are incomplete/inconsistent. Suspected duplicate capture
origins suppress affected ratios. No metadata-only report proves unique provider
inference, actual VRAM usage, total historical retry costs, or monetary spending.

Only explicit closed reason codes may classify insufficient results. Arbitrary
reason prose is not parsed, emitted or counted as a cause; unresolved cases stay
`cause_unclassified_requires_review` for later Luna review.

Read `INFERENCE_EFFICIENCY_REPORT.md` for the pinned inventory schema. This slice
did not scan production inference outputs or generate a production cost report.

## Next Owner

Qwen calls remain owned by the other session. Any existing smoke must not be
restarted or duplicated to pick up these optional optimizations. Literal request
preparation and saved-response acceptance are implemented offline and need a
separate bounded live test. Compact content parsing and its prompt are implemented
offline; trusted call/response binding and transport integration still belong to
a future caller. Neither silently replaces the canonical acceptance-v2 contract.

Bulk semantic discovery/insufficient-cause adjudication remains a separate Luna
handoff; deterministic metadata counting is not that adjudication.

## Validation

```text
python -B -m unittest discover -s tests
```

Final Windows offline result: 331 tests, 329 passed, 2 symlink-privilege skips,
zero failures. Mocked symlink/reparse rejection coverage runs. Literal matching
also passed an independent synthetic review covering 2,500 generated cases.
No native POSIX or live Qwen quality claim is made from these tests.

Detailed contracts:

- `CARD_REVERIFY_PREPARATION.md`
- `LITERAL_EVIDENCE_CONTRACT.md`
- `INFERENCE_EFFICIENCY_REPORT.md`
- `COMPACT_VERIFIER_DESIGN.md`
- `COMPACT_VERIFIER_IMPLEMENTATION.md`
- `LITERAL_EXPERIMENT_HANDOFF.md`
- `INTEGRATION_READINESS.md`
