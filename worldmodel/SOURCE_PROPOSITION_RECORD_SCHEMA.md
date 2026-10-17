# Source Proposition Record Schema

## Purpose

This schema persists source-supported propositions independently of strict
mechanism eligibility. It is for scoped research/query and route-level review;
it is not runtime state, a confirmed fact, or a POC mutation.

## Common Record

```json
{
  "proposition_id": "PROP-...",
  "dataset_id": "...",
  "work_id": "...",
  "source_unit_id": "clause id",
  "evidence_ids": ["sentence id"],
  "evidence_precision": "source_exact",
  "source_proposition_extractable": "yes",
  "primary_route": "bounded_event",
  "content_facets": ["event"],
  "assertion_status": "narrator_asserted",
  "temporal_status": "bounded_occurrence",
  "evidence_directness": "explicit",
  "proposition_text": "...",
  "operational_fields": {},
  "generality_scope": "unclear",
  "generality_cue_span": null,
  "claimant_or_source": null,
  "claimant_status": "narrator",
  "mechanism_contract_eligible": "no",
  "mechanism_contract_eligible_basis": "derived",
  "annotator_class": "ai_provisional",
  "sample_frame": "enriched_calibration",
  "publication_status": "candidate_not_confirmed",
  "allowed_work_ids": ["..."],
  "transfer_policy": "no_transfer",
  "warnings": []
}
```

## Route Payload Requirements

| Route | Minimum payload |
| --- | --- |
| `bounded_event` | event type/action, participants or unknown, observable outcome/context |
| `entity_profile` | entity surface/kind, direct attribute proposition |
| `relationship_institution` | subject/object or institution, relation/scope, modality |
| `environment_location` | location/environment surface, observable condition |
| `attribution_only` (v2 name `attributed_context`) | claimant/source, attribution act; only when no separable content proposition exists |
| `tactic_context` | actor/group, tactic/goal/context, transferability not established |
| `source_noise_fragment` | disposition reason only; not queryable |
| `mechanism` | mechanism card fields; strict eligibility is a separate review field |

## Invariants

- One record belongs to exactly one `work_id`.
- Every evidence ID resolves to that work and source unit.
- `assertion_status` and `temporal_status` are preserved; direct speech and
  historical statements are not upgraded to narrator facts.
- `mechanism_contract_eligible=no|needs_human_policy` cannot create active rule
  data, runtime state, or POC behavior.
- `source_noise_fragment` records are audit-only and excluded from query output.
- `mechanism_contract_eligible` is derived (see `PROPOSITION_ANNOTATION_CONTRACT.md`);
  a stored value that disagrees with recomputation is a validation failure.
  v3 adds `pending_annotation` for records missing a required sub-judgment.
- `generality_scope in {class_scoped, world_general}` requires a source-exact
  `generality_cue_span`.
- Non-narrator `assertion_status` requires `claimant_status` in
  `{resolved, unresolved_speaker}`.
- Route reassignment (R2) never changes assertion, temporal, or evidence fields.
- v2 artifacts stay immutable; v3 is emitted by
  `runs/_extraction_scheduler/20260924/build_source_proposition_records_v3.py`.
