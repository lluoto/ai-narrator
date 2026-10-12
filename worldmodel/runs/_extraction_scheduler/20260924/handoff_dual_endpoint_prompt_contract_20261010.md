# Dual Endpoint Prompt Contract (2026-10-10)

> **Status: binding instruction for this project.**
> Governs how the structured-source (`:8000`) and analysis/verifier (`:8001`)
> endpoints may be used in the worldmodel extraction pipeline. Applies to any
> runner, script, or agent operating under `runs/_extraction_scheduler/20260924/`.
> Non-negotiable: every output stays `candidate_not_confirmed`, `no_transfer`,
> and `no_runtime_effect`.

## 1. Endpoint Identity (verified state)

| Port | Role | Model | Context | Status |
| ---- | ---- | ----- | ------- | ------ |
| 8000 | `structured_source` | `/scratch/yl15858/qwen/Qwen3-27B` | 8192 | HTTP 200, stop, strict JSON/schema V6 smoke passed |
| 8001 | `unstructured_analysis` | `/scratch/yl15858/qwen/Qwen3-27B` | 32768 | HTTP 200, stop, analysis probe passed; caveat: thinking text appears inside `message.content` before `</think>` |

Never interchange these two roles merely because both endpoints expose the same
base model.

## 2. Endpoint 8000 — Structured Source Proposal

### Allowed use

Use 8000 only for source-bound candidate generation, schema repair, or approved
structured rendering. Use the canonical route prompt files rather than copying
their rules into a runner:

```text
bounded_event:
runs/_extraction_scheduler/20260924/slot_pilot_v6_regression_8000/bounded_event_slot_prompt_v6.txt

entity_profile:
runs/_extraction_scheduler/20260924/slot_pilot_v3_prompts/entity_profile_slot_prompt_v3.txt
```

### Request Envelope

```json
{
  "model": "/scratch/yl15858/qwen/Qwen3-27B",
  "temperature": 0,
  "max_tokens": 1500,
  "chat_template_kwargs": { "enable_thinking": false },
  "messages": [
    { "role": "system", "content": "<canonical route SYSTEM prompt>" },
    { "role": "user", "content": "<one frozen source-bound queue item>" }
  ]
}
```

### Required process environment

```text
DISABLE_LLM_THINKING=1
```

### Required acceptance

```text
HTTP 200
returned model equals this batch's /v1/models identity
one choice
finish_reason=stop
message.content strict JSON parses
route schema and source-span validation pass
```

### Failure handling

Fail-stop on the first transport, finish, JSON, schema, scope, or raw-capture
failure. Raw capture precedes schema validation. Output stays
`candidate_not_confirmed`, `no_transfer`, and `no_runtime_effect`.

## 3. Endpoint 8001 — Analysis / Verifier Advisory

Use 8001 for evidence analysis, failure diagnosis, and independent verifier
advisory. It is not a direct strict-JSON endpoint while thinking is enabled.

### System Prompt

```text
You are an independent source-evidence analyst.

Use only the supplied exact source evidence and structured candidate. Do not
use hidden context, prior model rationale, or another work. Do not propose a
runtime rule, publication, state write, cross-work transfer, or human approval.

First reason privately. Then append one final machine-readable block after all
thinking, exactly in this form:

<VERDICT_JSON>
{"case_id":"...","overall":"entailed|insufficient_evidence|contradicted|abstain","checks":[{"field_path":"...","verdict":"entailed|insufficient_evidence|contradicted|abstain","evidence_ids":["..."],"reason":"..."}],"no_runtime_effect":true}
</VERDICT_JSON>

The final block must cite only supplied evidence IDs. Do not put source prose,
chain-of-thought, markdown, or any text after </VERDICT_JSON>.
```

### User Prompt Template

```text
CASE_ID: <exact ID>
WORK_ID: <exact single work ID>
SOURCE EVIDENCE (the complete allowed evidence):
<source evidence IDs and text>

STRUCTURED CANDIDATE:
<candidate JSON only; no generator rationale>

Check each populated candidate field independently. A literal source match or
source-supported taxonomy mapping is not contradicted merely because an enum
token is absent from source prose. Mark missing support as insufficient rather
than inventing evidence. Return the required final VERDICT_JSON block.
```

### Parser Contract

Because this server may place a Qwen `<think>...</think>` trace in
`message.content`, a consumer must:

```text
1. retain the complete raw response as an immutable audit artifact;
2. require finish_reason=stop;
3. locate the last complete <VERDICT_JSON>...</VERDICT_JSON> block after any
   </think> marker;
4. parse only the enclosed JSON object;
5. reject absent, duplicate, trailing, cross-work, malformed, or schema-invalid
   verdict blocks;
6. never treat raw thought text as source evidence or executable data.
```

If the endpoint returns `length`, missing block, malformed block, or mismatched
model identity, record a failed verifier attempt and do not silently fall back
to 8000 verification.

## 4. Two-Stage Boundary

```text
8000 proposal artifact -> hash pin -> 8001 advisory/verifier artifact
-> hash pin -> lead review -> research-only manifest
```

No stage may overwrite an earlier artifact. Neither endpoint can publish a
fact, activate a rule, mutate state, write SQLite, or create cross-work facts.

## 5. GPU / VRAM Expectation

8001 is expected to consume more VRAM during active inference because:

```text
8000: 8192 context, thinking disabled, max_num_seqs policy 1
8001: 32768 context, thinking enabled, server capability max_num_seqs 8
```

The base Qwen weights are comparable, but KV cache grows with context length,
generated thought tokens, and concurrent sequences. Keep 8001 serial for
verification until a separate GPU/KV smoke authorizes higher concurrency.
