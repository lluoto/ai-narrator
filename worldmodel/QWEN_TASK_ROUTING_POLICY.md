# Qwen Task Routing Policy

## Principle

The worker may classify a task, but it may not freely choose a model mode after
seeing an answer. Every API job must declare `execution_mode` before dispatch.
The dispatcher records model, endpoint, thinking mode, token budget, and gate
result in the job artifact.

## Modes

| execution_mode | Use | Thinking | Output contract | Default budget |
| --- | --- | --- | --- | --- |
| `structured_source` | d01 discovery, d02 review, schema repair, rule extraction | off | strict JSON, machine parsed | 1500; 2000 only after fresh smoke |
| `unstructured_analysis` | algorithm diagnosis, design analysis, incident analysis, non-binding research | on | Markdown/prose, no state mutation | long-context endpoint, serial |
| `human_escalation` | ambiguous source, policy judgment, publication, threshold decision | n/a | human label/decision | no automatic model decision |
| `structured_render` | approved decisions rendered into a schema | off | strict JSON, validation required | 1500 |

## Routing Rules

1. Output consumed by code, checkpoint, registry, manifest, rule executor, or
   automated gate is `structured_source` or `structured_render`.
2. Long causal explanation, design comparison, postmortem, or open planning is
   `unstructured_analysis`.
3. Source truth, ambiguous equivalence, threshold approval, candidate
   publication, POC state mutation, or policy exception is `human_escalation`.
4. A structured failure may not silently retry in thinking-on mode. It creates a
   new analysis/escalation artifact with the failure evidence.
5. Thinking-on analysis is never source evidence, registry content, or state
   mutation. A separate structured call renders only approved inputs.

## Endpoint Profiles

### Structured profile

```text
Qwen3-27B
DISABLE_LLM_THINKING=1
max_num_seqs=1 during validation
per-book 20-window smoke
max_tokens=1500, then 2000 only after a fresh passing smoke
```

Required checks: HTTP 200, `finish_reason != length`, valid JSON, schema/type/
scope/support-kind validation, and source/evidence scope validation.

### Analysis profile

```text
Qwen3-27B thinking-on
separate long-context server profile when needed
max_model_len 12288 or 16384 only after GPU/KV smoke
max_num_seqs=1
no machine-consumed JSON requirement
```

## Required Job Record

```text
job_id
execution_mode
input_artifact_hashes
endpoint
model
thinking_disabled
max_model_len
max_tokens
max_num_seqs
status
finish_reason
validation_result
output_artifact
```

## Current Applications

```text
d01 / d02 / Stage 18 / Stage 19 -> structured_source
c01/c01 repair diagnosis -> unstructured_analysis + human_escalation
mechanism synthesis proposal -> unstructured_analysis
publication and threshold decision -> human_escalation
POC rule/state mutation -> deterministic code, not Qwen
```

## Adoption Note (2026-10-03; recovery caveat 2026-10-10)

Enforcement landed:

- `tools/d01_discover_open_systems.mjs` and `tools/d02_agent_review_open_systems.mjs` now require
  `--execution-mode` and resolve endpoint/model/token budget/thinking mode from
  `worker_config.json` profiles via `tools/lib/routing.mjs`.
- Structured tools refuse to dispatch unless `execution_mode` is `structured_source` or
  `structured_render`, `thinking_disabled === true`, and `DISABLE_LLM_THINKING=1`. `--api`/`--model`
  overrides must match the resolved profile, and `--max-tokens` may not exceed the profile budget
  (1500, or the escalated 2000 only after a fresh passing smoke). Violations fail before any HTTP call.
- Each run writes `<outDir>/job_record.json` with the Required Job Record fields above; d01 also
  records the routing fields in `discovery_run_config.json`.
- `worker_config.json` profiles: `structured_source`/`structured_render` on `:8000`
  (`max_model_len=8192`, `max_tokens=1500`, `max_num_seqs=1`); `unstructured_analysis` on `:8001`
  (`max_model_len=32768`, operator cap `max_num_seqs=1`; the server is started with `--max-num-seqs 8`
  but policy validation runs serially). `human_escalation` performs no automatic model decision.

Historical verification on 2026-10-03 established the pre-dispatch guards and structured-run
artifacts described above.

## Current Verification (2026-10-10)

- Recovered `:8000` returned exactly `/scratch/yl15858/qwen/Qwen3-27B` from `/v1/models`.
  `chat_model`, `structured_source`, and `structured_render` use that returned identity.
- This is an 8000-only recovery check, not an availability finding for `:8001`: the existing
  `unstructured_analysis`/verifier profile remains configured but was reported unavailable and
  was not probed. No independent verifier call is authorized by this check.
