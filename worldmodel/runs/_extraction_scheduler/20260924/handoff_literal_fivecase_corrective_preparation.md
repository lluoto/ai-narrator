# Literal Five-Case Result: Corrective Preparation Only

## Sealed Outcome

Do not rerun or overwrite:

```text
runs/_extraction_scheduler/20260924/proposition_literal_followup_inventory_v2_preparation/attempt_8000_v1/
acceptance manifest SHA256: 49c209bc8a1a983990fb932800c4eb5eb0771d70d6c43e0d81e27c91332a26bf
```

Independent offline audit:

```text
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/fivecase_literal_offline_review_v1/report.md
```

Observed saved records: five attempted, four pending independent verification,
one rejected, zero unattempted, ten normalized propositions, one format error.
All saved responses have stop finishes. Case 05 public content is Markdown-
fenced and fails strict JSON. Do not strip fences, parse an inner object as an
accepted candidate, or relabel the failure as a transport/span success.

The five-call scope is consumed by the reported attempt. This handoff authorizes
zero model/health calls, no automatic retries, and no bulk expansion. Do not
regenerate cases 01-04 merely to complete a new set.

## Format Correction Preparation

1. Inspect the exact case-05 request and saved raw response to confirm the
   model-visible output contract was complete and source text was treated as
   data. Do not use old output text as new source evidence.
2. Preserve the canonical literal-v2 prompt and package. If proposing a prompt
   change, create a new version with a documented delta and new hashes; do not
   tune the frozen package in place.
3. A future constrained-output experiment may use a complete JSON Schema only
   after the inference owner has separately established endpoint support and
   obtained permission for any discovery request. Do not assume vLLM support,
   invent an accepted response_format field, silently fall back to plain text,
   or weaken the normalizer. Prompt-only strict JSON and schema-constrained
   decoding are different request contracts and require separate experiment pins.
4. Prepare at most ONE case-05 regression request and its new request-body hash.
   Return preparation before dispatch. It requires fresh explicit one-call
   authorization; no remaining five-call or earlier two-call budget is implied.

## Sequencing Correction

The disclosed batch sent all five requests before literal normalization. Record
that as a protocol deviation, even though the sole failure happened last.
The posthoc `request_ledger_derived_from_saved_bytes` cannot prove a durable
predispatch association or raw-before-parse chronology.

Before any future multi-case execution, demonstrate with mocked transport that:

```text
persist exact case/request-body hash BEFORE dispatch
send exactly one currently released request
persist raw bytes/hash/status BEFORE parsing
validate envelope, strict JSON, schema and literal normalization
persist a machine-readable per-case validation result
ONLY THEN release the next case
```

A failure at case 01 or case 03 must leave every subsequent case unattempted
with zero corresponding transport calls. Pending/interrupted validation must
not release the next request. Repeated invocation must not duplicate an already
sent or uncertain-outcome call. Tests use synthetic fixtures/mocks and make no
live calls. Do not claim a disclosure note or retrospective accounting proves
the sequence was enforced.

## Return

Return an offline format-analysis note, proposed versioned one-case input/hash
if warranted, sequencing regression evidence, and an explicit list of remaining
model-dependent steps. Keep ten existing normalized candidates pending 8001;
no semantic entailment, human gold, publication or runtime activation is granted.
Do not start/probe 8001 or substitute 8000 verification under this document.
