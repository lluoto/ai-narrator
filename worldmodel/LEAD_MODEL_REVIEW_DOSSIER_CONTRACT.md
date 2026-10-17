# Lead Model Review Dossier Contract

## Purpose And Boundary

This is a source-bound, immutable companion artifact for one generator,
verifier, and lead-model review. It records a research recommendation over
existing candidate, proposition, and route artifacts. It does not change those
schemas, mutate their records, publish a fact, or create runtime authority.

The lead model only grants a research recommendation, never runtime effect.
`runtime_effect` is always `false` in this dossier. Any publication, policy
exception, ruleset activation, state mutation, or POC integration remains a
separate authorized decision.

## Reference And Pinning Rules

The dossier is valid only when its references resolve in the hash-pinned input
artifacts. It copies no source text as a substitute for an ID.

```text
review_dossier_id             unique immutable dossier ID
schema_version                dossier contract version
immutable                     true
supersedes                    null or {review_dossier_id, content_sha256}

subject.dataset_id            exact dataset ID
subject.work_id               exactly one existing work ID
subject.candidate_ids[]       exact existing candidate IDs; [] only before a candidate exists
subject.proposition_ids[]     exact existing proposition IDs; [] only for candidate-only review
subject.source_unit_ids[]     exact clause/window IDs when present in the source record
subject.sentence_evidence_ids[] exact source sentence IDs; non-empty
subject.primary_route         copied route, never a route reassignment

artifact_pins[]               {artifact_id, artifact_path, sha256, role}
```

`artifact_pins` must include the dataset/source manifest, source-sentence
artifact, proposition artifact when `proposition_ids` is non-empty, candidate
artifact when `candidate_ids` is non-empty, and the generator/verifier/lead
input and output artifacts. A dossier content hash belongs in its enclosing
artifact manifest, avoiding a self-referential hash.

All referenced candidates and propositions must resolve to `subject.work_id`.
`sentence_evidence_ids` must be the exact IDs supporting the reviewed content,
not retrieval-neighbor or inferred IDs. This preserves the existing
single-work, source-exact record rules.

`subject.primary_route` is the existing route value; this contract introduces
no route ID or route-record schema. If a route queue is an input, it is pinned
as an additional `artifact_pins` entry with role `route_queue_input`.

## Required Review Payload

```text
modality.assertion_status
modality.claimant_or_source
modality.claimant_status
modality.temporal_status
modality.evidence_directness
modality.source_proposition_extractable
modality.generality_scope
modality.generality_cue_span

consumer_boundary.allowed_consumer       review_only | research_lookup_only
consumer_boundary.allowed_work_ids       [subject.work_id]
consumer_boundary.transfer_policy         copied from reviewed record
consumer_boundary.publication_status      candidate_not_confirmed
consumer_boundary.no_runtime_effect       true
consumer_boundary.prohibited_consumers[]  runtime, rule_engine, state_mutation,
                                          plot_fact, cross_work_merge, policy_exception
```

The modality block is an explicit snapshot of the referenced record values. A
rewrite may correct a source-supported proposition or payload, but may not
silently upgrade a speaker claim, rumor, conjecture, historical statement, or
contingent statement into a narrator fact. It may not broaden work scope or
transfer policy.

## Model Provenance And Results

`model_runs` has three separate entries: `generator`, `verifier`, and
`lead_model`. Each entry independently records:

```text
role                         generator | verifier | lead_model
provider
model
endpoint_or_profile
prompt_sha256
input_sha256
output_sha256
finish_status                completed | abstained | failed | cancelled | truncated
finish_reason                provider-reported value or null
job_record_id
```

Provider or model names may coincide, but role, prompt hash, input hash,
output hash, and finish status are never inherited or collapsed across roles.
The verifier receives cited source evidence and the structured proposal, not
the generator's hidden rationale.

The generator records its proposed candidate/proposition/route fields and the
sentence IDs cited for each proposed assertion. The verifier records a result
for every reviewed assertion:

```text
verifier.verdict             entailed | insufficient_evidence | contradicted | abstain
verifier.claim_checks[]      {claim_path, verdict, supporting_sentence_ids[],
                              contradicting_sentence_ids[], reason_codes[]}
```

`abstain` is a retained result, not a successful verification or a dropped
job. `supporting_sentence_ids` and `contradicting_sentence_ids` must be drawn
from `subject.sentence_evidence_ids`.

The lead entry contains only this disposition vocabulary:

```text
lead.disposition             retain | rewrite | return | needs_human_policy
lead.cited_sentence_ids[]    exact IDs used for the recommendation
lead.reason_codes[]
lead.rewrite_payload         null or source-supported replacement proposal
```

`retain` and `rewrite` mean research-only recommendations. `return` requests
another bounded preparation/review pass. `needs_human_policy` routes an
incomplete institutional, policy, or other authority-sensitive case to a human
or KP decision; it is not a policy decision.

## Disagreement, Reasons, And Errors

The dossier retains disagreement rather than reducing it to a single score:

```text
disagreement.generator_verifier     agree | disagree | not_comparable
disagreement.lead_verifier          agree | disagree | qualified
disagreement.contested_claims[]     {claim_path, generator_value, verifier_verdict,
                                     lead_treatment, sentence_ids[]}
disagreement.unresolved_claim_paths[]
```

Use `reason_codes[]` for substantive judgments and `errors[]` for failed or
malformed processing. Codes are drawn from this taxonomy:

| Class | Codes |
| --- | --- |
| evidence | `missing_evidence_id`, `evidence_not_source_exact`, `span_mismatch`, `unsupported_inference`, `contradicted_source` |
| preservation | `modality_loss`, `temporal_loss`, `route_mismatch`, `generality_cue_missing` |
| integrity | `unresolved_candidate_id`, `unresolved_proposition_id`, `cross_work_scope`, `artifact_hash_mismatch`, `missing_provenance` |
| execution | `schema_invalid`, `output_malformed`, `request_failed`, `finish_truncated`, `verifier_abstained` |
| policy | `institutional_contract_incomplete`, `needs_human_policy`, `forbidden_runtime_intent` |

Each `errors[]` item is `{stage, code, detail}`. Error detail describes the
failure without replacing a source citation or introducing new evidence.

## Acceptance Gates

A dossier may be accepted as a research recommendation only when all gates
pass:

1. Every required artifact pin resolves and its SHA-256 matches; all referenced
   IDs resolve to the pinned artifact and one `work_id`.
2. Non-empty exact sentence evidence supports every retained or rewritten
   assertion; sentence IDs belong to the referenced source unit/work.
3. The copied route, modality, scope, `candidate_not_confirmed` status, allowed
   work scope, and transfer policy pass the existing record validators.
4. Generator, verifier, and lead records each carry their own role/provider/
   model/prompt-hash/finish-status provenance and separate output hash.
5. `retain` cannot accept an assertion with verifier `insufficient_evidence`,
   `contradicted`, or `abstain`. A `rewrite` may survive such a result only if
   every retained replacement assertion has its own exact supporting evidence.
6. A failed, cancelled, or truncated verifier requires `return` or
   `needs_human_policy`; no missing output may be treated as agreement.
7. The lead disposition is exactly one of `retain`, `rewrite`, `return`, or
   `needs_human_policy`, and disagreement/reason/error fields are present.
8. The consumer boundary remains research-only with `no_runtime_effect=true`.
   Passing these gates does not publish a fact or authorize any runtime action.

## Immutability And Supersession

Once emitted, a dossier and its pinned payloads are immutable. A correction,
new review, or human override creates a new dossier ID with `supersedes`
pointing to the prior dossier ID and prior content SHA-256. It does not edit the
prior dossier or any candidate/proposition/route record. A superseding human
decision remains an authority record outside this contract.

## Illustrative JSON

This is a structural example only. Placeholder IDs, hashes, providers, models,
and finish statuses do not describe or imply an executed model call.

```json
{
  "review_dossier_id": "LMD-EXAMPLE-0001",
  "schema_version": "1.0",
  "immutable": true,
  "supersedes": null,
  "subject": {
    "dataset_id": "dataset-id",
    "work_id": "work-id",
    "candidate_ids": ["candidate-id"],
    "proposition_ids": ["PROP-id"],
    "source_unit_ids": ["clause-id"],
    "sentence_evidence_ids": ["sentence-id-17"],
    "primary_route": "bounded_event"
  },
  "artifact_pins": [
    {
      "artifact_id": "dataset-manifest",
      "artifact_path": "runs/dataset-id/version/dataset_manifest.json",
      "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
      "role": "dataset_manifest"
    },
    {
      "artifact_id": "source-sentences",
      "artifact_path": "runs/dataset-id/version/source_sentences.jsonl",
      "sha256": "2222222222222222222222222222222222222222222222222222222222222222",
      "role": "source_sentences"
    },
    {
      "artifact_id": "source-manifest",
      "artifact_path": "runs/dataset-id/version/artifact_manifest.json",
      "sha256": "3333333333333333333333333333333333333333333333333333333333333333",
      "role": "source_manifest"
    },
    {
      "artifact_id": "propositions",
      "artifact_path": "runs/dataset-id/version/propositions.jsonl",
      "sha256": "4444444444444444444444444444444444444444444444444444444444444444",
      "role": "proposition_input"
    },
    {
      "artifact_id": "candidates",
      "artifact_path": "runs/dataset-id/version/candidates.jsonl",
      "sha256": "5555555555555555555555555555555555555555555555555555555555555555",
      "role": "candidate_input"
    },
    {
      "artifact_id": "generator-input",
      "artifact_path": "runs/dataset-id/version/jobs/job-generator-id/input.json",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "role": "generator_input"
    },
    {
      "artifact_id": "generator-output",
      "artifact_path": "runs/dataset-id/version/jobs/job-generator-id/output.json",
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "role": "generator_output"
    },
    {
      "artifact_id": "verifier-input",
      "artifact_path": "runs/dataset-id/version/jobs/job-verifier-id/input.json",
      "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "role": "verifier_input"
    },
    {
      "artifact_id": "verifier-output",
      "artifact_path": "runs/dataset-id/version/jobs/job-verifier-id/output.json",
      "sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "role": "verifier_output"
    },
    {
      "artifact_id": "lead-input",
      "artifact_path": "runs/dataset-id/version/jobs/job-lead-id/input.json",
      "sha256": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      "role": "lead_input"
    },
    {
      "artifact_id": "lead-output",
      "artifact_path": "runs/dataset-id/version/jobs/job-lead-id/output.json",
      "sha256": "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      "role": "lead_output"
    }
  ],
  "modality": {
    "assertion_status": "narrator_asserted",
    "claimant_or_source": null,
    "claimant_status": "narrator",
    "temporal_status": "bounded_occurrence",
    "evidence_directness": "explicit",
    "source_proposition_extractable": "yes",
    "generality_scope": "instance",
    "generality_cue_span": null
  },
  "consumer_boundary": {
    "allowed_consumer": "research_lookup_only",
    "allowed_work_ids": ["work-id"],
    "transfer_policy": "no_transfer",
    "publication_status": "candidate_not_confirmed",
    "no_runtime_effect": true,
    "prohibited_consumers": ["runtime", "rule_engine", "state_mutation", "plot_fact", "cross_work_merge", "policy_exception"]
  },
  "model_runs": {
    "generator": {
      "role": "generator",
      "provider": "<recorded-provider>",
      "model": "<recorded-generator-model>",
      "endpoint_or_profile": "structured_source",
      "prompt_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "input_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "output_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "finish_status": "completed",
      "finish_reason": "<recorded-finish-reason>",
      "job_record_id": "job-generator-id"
    },
    "verifier": {
      "role": "verifier",
      "provider": "<recorded-provider>",
      "model": "<recorded-verifier-model>",
      "endpoint_or_profile": "structured_source",
      "prompt_sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "input_sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "output_sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "finish_status": "completed",
      "finish_reason": "<recorded-finish-reason>",
      "job_record_id": "job-verifier-id"
    },
    "lead_model": {
      "role": "lead_model",
      "provider": "<recorded-provider>",
      "model": "<recorded-lead-model>",
      "endpoint_or_profile": "structured_source",
      "prompt_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "input_sha256": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      "output_sha256": "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      "finish_status": "completed",
      "finish_reason": "<recorded-finish-reason>",
      "job_record_id": "job-lead-id"
    }
  },
  "generator": {
    "proposal_artifact_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "cited_sentence_ids": ["sentence-id-17"]
  },
  "verifier": {
    "verdict": "entailed",
    "claim_checks": [
      {
        "claim_path": "route_payload.observable_outcome",
        "verdict": "entailed",
        "supporting_sentence_ids": ["sentence-id-17"],
        "contradicting_sentence_ids": [],
        "reason_codes": []
      }
    ]
  },
  "lead": {
    "disposition": "retain",
    "cited_sentence_ids": ["sentence-id-17"],
    "reason_codes": [],
    "rewrite_payload": null
  },
  "disagreement": {
    "generator_verifier": "agree",
    "lead_verifier": "agree",
    "contested_claims": [],
    "unresolved_claim_paths": []
  },
  "reason_codes": [],
  "errors": []
}
```

See `MULTI_MODEL_REVIEW_UPGRADE.md` for the role split and
`SOURCE_PROPOSITION_RECORD_SCHEMA.md` for the records this dossier references.

## Structural Validation

Run the fail-closed structural validator against a JSON dossier, JSON array, or
JSONL file. It validates only the supplied input and never resolves artifact
paths, reads candidate files, or invokes models.

```powershell
node tools/d09_validate_lead_model_review_dossier.mjs --input tools/d09_validate_lead_model_review_dossier.fixture.json
```
