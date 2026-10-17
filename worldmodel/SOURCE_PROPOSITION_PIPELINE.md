# Source Proposition Pipeline

## Decision

Retire the single binary `extractable_mechanism` clause task as a mechanism
training/certification target. Clause V1, V2, and V3 calibration artifacts are
negative evidence and remain immutable; they do not authorize a holdout or
production mechanism run.

The replacement architecture is proposition-first and multi-route.

## Method Borrowing

This design borrows only process patterns from analogous information extraction
work, not their claims or datasets:

```text
OpenIE: extract minimal propositions before downstream normalization
evidence verification/NLI: test whether cited spans support a proposition
weak supervision: heuristic rules vote or abstain, never become truth
selective prediction: abstain or human-review on high-risk strict decisions
human-in-the-loop KBC: separate content extraction from publication eligibility
```

Do not treat OpenIE triples, NLI entailment, heuristic votes, model agreement,
or similarity as proof that a proposition is a reusable mechanism.

## Record Axes (amended 2026-10-04, R1/R2 approved)

Every source proposition record has independently annotated axes:

```text
source_proposition_extractable: yes | no | unclear
generality_scope: instance | entity_scoped | class_scoped | world_general | unclear
```

`mechanism_contract_eligible` (yes | no | needs_human_policy |
pending_annotation) is **derived** from these axes plus route, assertion, and
evidence-bound operational fields. It is never annotated directly. The v2
two-axis data showed both labels fully determined by route and strict "yes"
mixing instance facts with reusable rules (lead review rewrote 9/15); the
generality axis separates those.

Route is content type only; attribution is carried by `assertion_status` +
`claimant_or_source`. See `PROPOSITION_ANNOTATION_CONTRACT.md`.

And independent classification fields:

```text
primary_route
content_facets[]
assertion_status
temporal_status
evidence_directness
```

## Pipeline

```text
source sentence/window
-> proposition segmentation (one or more minimal propositions)
-> exact evidence span binding
-> source proposition support review
-> multi-route content classification
-> strict mechanism eligibility review (only applicable propositions)
-> route-specific candidate queues
-> route-specific human/lead review
-> scoped query/published manifest decision
```

## Primary Routes

```text
mechanism
bounded_event
entity_profile
relationship_institution
environment_location
  attribution_only      (v2: attributed_context; pending R2 reclassification)
  tactic_context
  source_noise_fragment
```

One proposition has one primary route; one source window may create multiple
proposition records. This replaces the invalid “one window, one route” rule.

## Mechanism Eligibility

Only propositions with all conditions may enter the strict mechanism queue:

```text
source_proposition_extractable=yes
assertion_status=narrator_asserted | formally_enacted_direct
at least one direct operational field
generality_scope = class_scoped | world_general
generality_cue_span present, source-exact, distinct from the effect span
every field bound to exact evidence span
```

Institutional propositions lacking a complete operational contract route to
`relationship_institution` or `needs_human_policy`, never automatic mechanism.

## Evaluation

Evaluate separately:

```text
proposition evidence support precision/coverage
route classification accuracy
assertion/modality preservation
strict mechanism precision/recall
abstain/human-review coverage
per-route query usefulness
cross-work leakage
```

Strict mechanism certification remains:

```text
point precision >=98%
one-sided 95% Wilson lower bound >=95%
```

It applies only after the mechanism-eligible label is independently reannotated
under this ontology. Old window/clause binary labels must not be reused as its
gold target.

## Immediate Work

1. Build a two-axis annotation sheet from the 546 refined clauses.
2. Reannotate the old 40 yes, all institutional/legal clauses, one-off ability
   activations, tactics, and attributed/historical statements.
3. Implement a deterministic proposition record writer with no model calls.
4. Build one route-level queue at a time, beginning with
   `relationship_institution` and `bounded_event` because they explain most
   binary-label conflicts.
5. Only after new mechanism eligibility labels are stable, resume strict
   mechanism calibration on a new chapter-group split.
