# 8000 Phase A Structured Proposal Batch Prompt

## Purpose

Use this handoff only to prepare source-bound, review-only slot proposals while
the independent 8001 verifier is unavailable. This is Phase A of a two-stage
pipeline:

```text
8000 structured_source -> candidate proposal artifact
8001 independent verifier (when restored) -> verifier artifact
lead review -> research-only manifest
```

Phase A never promotes, publishes, confirms, transfers, or activates a
candidate. It never writes runtime state, SQLite, prompts, rules, or POC state.

## Preconditions

Before any request, create a new hash-pinned batch authorization and record its
hash. Do not reuse a prior smoke authorization as batch authorization.

Require all of the following:

```text
GET http://localhost:8000/v1/models -> HTTP 200
returned model includes /scratch/yl15858/qwen/Qwen3-27B
DISABLE_LLM_THINKING=1
```

Use only source-bound, single-work, eligible route-queue items. Exclude audit
noise, cross-work records, previously completed item IDs, and any item without
exact source evidence IDs.

## Pinned Prompt Inputs

| Route | Canonical prompt | SHA-256 |
| --- | --- | --- |
| `bounded_event` | `runs/_extraction_scheduler/20260924/slot_pilot_v6_regression_8000/bounded_event_slot_prompt_v6.txt` | `153a9691a1609a74125c92a28234a4b1ab73c3721ea09e27293acf454bd8b719` |
| `entity_profile` | `runs/_extraction_scheduler/20260924/slot_pilot_v3_prompts/entity_profile_slot_prompt_v3.txt` | `81a9f325203119ea1dd1843c791c36da9420186262d9f9cd28b512c860acd889` |

Verify the bytes of both files before dispatch. Do not paste, paraphrase, or
silently edit the canonical route prompts in a batch runner. Render their
`[USER]` template only with the one selected frozen queue item.

The V6 bounded-event prompt is required because it enforces:

```text
same selected clause for action and observable outcome
null outcome rather than cross-clause causation
predicate-carrier quote/speaker modality preservation
question/proposal content is not a narrator event
```

## Request Envelope

One request is one queue item. Use serial dispatch only:

```json
{
  "model": "/scratch/yl15858/qwen/Qwen3-27B",
  "temperature": 0,
  "max_tokens": 1500,
  "chat_template_kwargs": { "enable_thinking": false },
  "messages": [
    { "role": "system", "content": "<canonical route [SYSTEM] text>" },
    { "role": "user", "content": "<canonical route [USER] text rendered with one queue item>" }
  ]
}
```

Rules:

```text
endpoint: http://localhost:8000/v1/chat/completions
execution_mode: structured_source
max_num_seqs policy: 1
one request per item
automatic retries: 0
raw response capture: before JSON/schema validation
```

Do not send source text from another item, generator rationale, verifier output,
lead rationale, session data, or hidden reasoning.

## Per-Item Acceptance

Accept a Phase-A proposal record only if all checks pass:

```text
HTTP 200
response model equals the model returned by this batch's /v1/models health check
exactly one choice
finish_reason=stop (never length)
strict JSON parse
route schema validation
same work ID, source unit ID, and evidence ID as selected queue item
all source-text slot checks and V6 predicate/carrier lint checks complete
```

`event_type`, `entity_kind`, and other controlled taxonomy enums are not literal
source spans. Record their diagnostics separately from textual source-fidelity
findings. Do not mark a record source-valid merely because its JSON schema is
valid.

Run the versioned lint policy:

```text
modal_not_preserved_v3 behavior
V6 predicate/carrier-scoped question and quote checks
same-clause causal/outcome check
categorical enum diagnostics reported separately
```

## Fail-Stop

On the first health, transport, model identity, finish, JSON, schema, source
scope, raw-capture, or output-integrity failure:

```text
write a terminal failure record
record the attempted item and error class
mark all remaining authorized items unattempted
send no further requests
do not retry automatically
```

Lint findings do not authorize promotion. Retain them in a per-item review
ledger. A textual source-fidelity failure must be routed to repair or review;
do not overwrite the proposal in place.

## Required Output Artifacts

Write to a new absent-only run directory. The job record must include:

```text
job_id
execution_mode=structured_source
batch authorization hash
input queue/prompt/linter/worker-config hashes
endpoint and health-response hash
actual model ID
thinking disabled settings
max tokens / max_num_seqs policy
one-call serial ledger
raw response hashes and paths
finish reason / JSON / schema / lint status per item
candidate_not_confirmed / no_transfer / no_runtime_effect boundaries
terminal status and unattempted IDs
```

Output proposals are always:

```text
candidate_not_confirmed
no_transfer
review_only
no_runtime_effect
```

## 8001 Follow-Up Contract

Do not treat this Phase-A artifact as independently verified. When 8001 is
healthy, create a separate verifier batch that reads only:

```text
hash-pinned Phase-A proposal
exact source evidence
source/work/scope pins
```

The verifier must not receive generator rationale. It creates a new verifier
artifact; it never overwrites this generator artifact. Only after verifier and
lead review may an item be considered for a separate research-only manifest.

## Explicit Prohibitions

```text
no full-batch dispatch without a new explicit batch authorization
no candidate promotion or publication
no runtime rule/state/SQLite mutation
no GameSession or prompt integration
no cross-work synthesis or transfer
no human-gold, Tier, or policy decision claim
no use of 8001 unavailability as verification approval
```
