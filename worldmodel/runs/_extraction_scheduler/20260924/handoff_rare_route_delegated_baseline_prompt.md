# Rare Route Baseline Adjudication Prompt

## Role And Authority

You are a source-bound **delegated review** worker. Your task is to create a
high-precision baseline for two rare route boundaries across six works.

Your output provenance is always:

```text
reviewer_class=user_delegated_assistant_review
```

It is not human review, human gold, a tier decision, publication, a runtime
rule, a state update, or cross-work evidence.

## The Actual Decision

Do not begin by choosing a route name. For each source window, choose exactly
one operational disposition:

```text
A. discard_no_standalone_information
B. preserve_provenance_only
C. route_as_independent_content
D. need_more_context
```

The output serializer maps those dispositions as follows:

```text
A -> source_noise_fragment
B -> attribution_only (legacy v2 name: attributed_context)
C -> other_route_not_target
D -> needs_human_policy
```

### A. `discard_no_standalone_information`

Choose A only when the window has no independently retainable proposition:

```text
pure question
pure short response
address/transition/filler
sound effect
chapter title or metadata
isolated quote punctuation
OCR or punctuation fragment
incomplete fragment that cannot be understood without missing context
```

This maps to `source_noise_fragment`, is `audit_only`, and must not become
queryable content.

### B. `preserve_provenance_only`

Choose B only when the retainable value is the attribution itself:

```text
who said/believed/reported/rumored/planned/conjectured something
```

and there is no independently separable event, entity property, relationship,
environment fact, or mechanism proposition in the same window.

This maps to `attribution_only`. Preserve the claimant and modality. Do not
upgrade the utterance to narrator fact.

### C. `route_as_independent_content`

Choose C whenever the window contains an independently retainable content
proposition, even if it is spoken, reported, historical, speculative, or
quoted. The later route system decides whether it is a bounded event, entity,
relationship, environment, or another content route.

Do not incorrectly select B merely because a sentence contains quotation marks
or a reporting verb.

### D. `need_more_context`

Choose D only where the supplied window cannot distinguish A, B, and C without
inventing missing context. Do not guess.

## Input Data Paths

Workspace root:

```text
D:\aitrpg\世界模型\worldmodel
```

Use only the frozen coverage partitions below. The six books are:

```text
黎明之剑
异常生物见闻录_远瞳
贩罪
纣临
疯巫妖的实验日志
网游之亡者征途
```

Coverage input path template:

```text
runs\_extraction_scheduler\20260924\c01_coverage_partition_foundation_v1\<WORK_ID>\coverage_partition.jsonl
```

Use the corresponding per-work `coverage_partition_summary.json` in the same
directory to locate the declared clean-sentence/source artifact. Do not search
other works or infer missing source text from another file.

Reference-only existing candidate artifact:

```text
runs\_extraction_scheduler\20260924\source_proposition_records_v3\source_proposition_records_v3.jsonl
```

Its old route values are `ai_provisional` evidence only. They must never become
your label by default.

Ontology and boundary references:

```text
D01_CLAUSE_LABEL_ONTOLOGY_DECISION_20261004.md
PROPOSITION_ANNOTATION_CONTRACT.md
SOURCE_PROPOSITION_RECORD_SCHEMA.md
ROUTE_AGENT_AUTOMATION_POLICY.md
```

## Deterministic Sampling Plan

Build a frozen queue before adjudication. Do not label the entire corpus.

For each work, select exactly 48 distinct source windows:

```text
16 attribution-trigger candidates
16 noise-trigger candidates
8 ambiguous boundary candidates
8 deterministic random controls
```

Total target queue size:

```text
6 works x 48 = 288 windows
```

### Attribution Trigger Candidates

Select windows matching one or more source surfaces such as:

```text
说 / 称 / 道 / 表示 / 报告 / 据说 / 听说 / 传言 / 认为 / 相信
猜测 / 怀疑 / 估计 / 似乎 / 或许 / 也许 / 打算 / 计划
direct quotation marks / historical account markers
```

### Noise Trigger Candidates

Select windows matching one or more source surfaces such as:

```text
single short question
only punctuation or ellipsis
chapter/title formatting
sound-effect-only text
isolated acknowledgement/response
unbalanced quote/bracket
OCR-like character corruption
very short fragment lacking a predicate
```

### Ambiguous Boundary Candidates

Select windows containing both an attribution trigger and apparent content, or
both fragment-like form and a possible proposition. These are most important:
do not replace them with easy positives.

### Random Controls

Use a stable SHA-256 ranking of `work_id + source_unit_id + evidence_id`; take
the first eligible windows not already selected by the three targeted strata.

Each selected input must carry exact:

```text
item_id
work_id
source_unit_id
source_chapter_id
evidence_ids
source_text
selection_stratum
input file path and SHA-256
```

Reject duplicate source/evidence IDs and cross-work joins before labeling.

## Adjudication Rules

1. Use only one supplied `source_text` window. Never use later chapters, other
   windows, prior knowledge, or an unstated speaker identity.
2. Preserve direct speech, report, rumor, conjecture, plan, historical, and
   narrator modality exactly. Never turn it into narrator fact.
3. A quote containing a complete independent claim is normally C, not B.
4. A direct question with no separable content is normally A.
5. A short answer may still be C or B if it independently states a proposition
   or provenance relation. Do not classify by length alone.
6. Every cited span must be an exact continuous substring of `source_text`.
7. Do not manufacture a claimant. Set it to `null` when the window does not
   resolve it.

## Output Files

Create new files only under:

```text
runs\_extraction_scheduler\20260924\rare_route_delegated_baseline_v1\
```

Required outputs:

```text
sampling_manifest.json
rare_route_baseline_queue.jsonl
delegated_adjudications.jsonl
summary.json
summary.md
```

Process in batches of at most 24 queue items. Append one JSONL line per item;
never overwrite a completed batch. Record prompt hash, input hash, output hash,
batch number, and `finish_reason` for every model run.

## Output JSONL Schema

Emit exactly one JSON object per input queue item:

```json
{
  "item_id": "<exact input>",
  "work_id": "<exact input>",
  "source_unit_id": "<exact input>",
  "source_chapter_id": "<exact input>",
  "evidence_ids": ["<exact input IDs>"],
  "reviewer_class": "user_delegated_assistant_review",
  "label_version": "rare_route_delegated_baseline_v1",
  "selection_stratum": "attribution_trigger | noise_trigger | ambiguous_boundary | random_control",
  "disposition": "discard_no_standalone_information | preserve_provenance_only | route_as_independent_content | need_more_context",
  "route_decision": "source_noise_fragment | attribution_only | other_route_not_target | needs_human_policy",
  "source_proposition_extractable": "yes | no | uncertain",
  "queryability_recommendation": "queryable | audit_only | needs_human_policy",
  "assertion_status": "narrator_asserted | direct_speech_claim | reported_belief | rumor | conjecture | historical_account | prophecy_or_plan | unknown",
  "claimant_or_source_span": "<exact substring or null>",
  "supporting_spans": ["<exact substring>"],
  "reason_codes": ["attribution_core | separable_content_exists | incomplete_fragment | pure_question | pure_response | title_or_metadata | ocr_or_punctuation_fragment | insufficient_context | other"],
  "rationale": "<at most two sentences; no new facts>",
  "no_runtime_effect": true,
  "no_cross_work_transfer": true
}
```

Required consistency:

```text
discard_no_standalone_information -> source_noise_fragment + no + audit_only
preserve_provenance_only          -> attribution_only + yes + queryable/needs_human_policy
route_as_independent_content      -> other_route_not_target + yes/uncertain
need_more_context                 -> needs_human_policy + uncertain + needs_human_policy
```

## Forbidden Operations

```text
do not call this output human or human gold
do not update source_proposition_records_v3 or existing route records
do not train thresholds, claim recall, or authorize 8000 from this baseline
do not publish, promote, or create runtime facts
do not write SQLite, POC, GameSession, rules, or world state
do not merge or transfer facts across works
do not fill a human review sheet
```

The result is a delegated baseline candidate. A separate human/KP sample review
is required before it can become a human baseline or justify any route-level
automation threshold.
