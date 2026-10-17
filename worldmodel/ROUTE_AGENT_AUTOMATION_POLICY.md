# Route Agent Automation Policy

## What May Enter Now

Reviewed manifests may enter only a POC research read facade when all records
are hash-pinned and preserve:

```text
single work scope
candidate_not_confirmed
no_transfer
review_only or research_lookup_only
no_runtime_effect=true
```

This supports KP/research retrieval receipts. It cannot alter prompt authority,
SQLite state, rules, NPC motive, plot fact, scene state, or event execution.

Eligible current manifests include:

```text
delegated_review_v1/reviewed_source_query_manifest_v1.jsonl
policy_evidence_dossier_v1/reviewed_policy_research_manifest_v1.jsonl
```

## Automation Model

```text
deterministic source preparation
-> agent proposition + route proposal
-> independent source-span verifier
-> deterministic scope/schema/modality gate
-> auto route queue
-> audit/policy/review queue
-> reviewed research manifest
```

Reviewer provenance may be `delegated_assistant`, `lead_model`, or `human`.
`lead_model` decisions may support research lookup only; runtime authority still
requires the separate admission decision.

Every model task is `structured_source`, thinking-off, source-bounded, and
checkpointed. Generator/verifier prompts and outputs remain separate.

## Automatic Versus Review-Required

| Route | Agent automation | Automatic materialization | Human/lead review |
| --- | --- | --- | --- |
| source_noise_fragment | deterministic only | audit-only | exceptions only |
| bounded_event | proposal + verifier | queue only | slots/research manifest sample |
| entity_profile | proposal + verifier | queue only | slots/research manifest sample |
| environment_location | proposal + verifier | queue only | sampled review |
| attributed_context | proposal + verifier | queue only, modality required | sampled review |
| tactic_context | proposal + verifier | queue only | sampled review |
| relationship_institution | proposal + verifier | context queue only | policy review |
| mechanism | proposal + verifier | strict candidate queue only | strict eligibility + publication review |

## Prohibited Automation

```text
confirmed fact publication
cross-work entity/fact merge
runtime rule activation
state mutation
plot fact / NPC motive fill
policy decision
Stage 23 registry promotion
```

Those operations are not omitted; their automated preparation and explicit A5
decision boundary are defined in `AUTOMATION_ESCALATION_LADDER.md`.

## Agent Output Contract

Each agent job writes:

```text
job_record.json
input hashes
execution_mode
endpoint/model/thinking/token profile
checkpoint/failure ledger
generator output
verifier output
route queue
validation report
audit sample manifest
```

Failures, abstentions, and insufficient evidence are retained as artifacts;
they are not silently dropped.

## Rollout

1. Connect reviewed research manifest to explicit POC read facade with tests.
2. Canary proposition/route automation on three foundational books.
3. Audit each route independently; disable only a failing route.
4. Expand deterministic prep and validated route queues to all source-ready
   books.
5. Maintain strict mechanism and policy routes behind lead/human gates.
