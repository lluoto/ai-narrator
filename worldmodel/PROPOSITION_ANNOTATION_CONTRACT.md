# Proposition Annotation Contract

## Unit

One annotation row represents one minimal source proposition, not an entire
window. A source clause may yield zero, one, or more propositions. Every
proposition has exact evidence IDs and source text spans.

## Required Axes

```text
source_proposition_extractable: yes | no | unclear
generality_scope: instance | entity_scoped | class_scoped | world_general | unclear
```

`generality_scope` (R1, approved 2026-10-04) is annotated independently of
route and of operational fields:

| Value | Meaning |
| --- | --- |
| `instance` | one occurrence, one occasion, or one stated case |
| `entity_scoped` | stable for a named entity/individual only |
| `class_scoped` | stated for an explicitly bounded class (e.g. 每个噩兽幼体, 基层审查官) |
| `world_general` | stated as a general rule of the work's world |
| `unclear` | evidence does not decide; this is a valid abstention |

`class_scoped` and `world_general` require `generality_cue_span`: an exact
span (e.g. 每/都/一天只有一次/必修课/总是/凡是) that is distinct from the
operational effect span. Re-citing the effect sentence without a cue span is
not generality evidence.

## Derived Eligibility (Not A Label)

`mechanism_contract_eligible` is computed, never annotated:

```text
yes                 if source_proposition_extractable = yes
                    and primary_route = mechanism
                    and assertion_status in {narrator_asserted, formally_enacted_direct}
                    and >= 1 operational field bound to an exact evidence span
                    and generality_scope in {class_scoped, world_general}
                    and generality_cue_span is present and source-exact
needs_human_policy  if primary_route = relationship_institution and the
                    institutional/legal contract below is incomplete
pending_annotation  if any required sub-judgment above is missing/unclear
no                  otherwise
```

Constraint: `source_proposition_extractable != yes -> mechanism_contract_eligible = no`.

An annotation sheet must not contain an eligibility column. Validators recompute
eligibility and reject any record whose stored value disagrees.

## Classification

```text
primary_route (content type only; see R2):
  mechanism
  bounded_event
  entity_profile
  relationship_institution
  environment_location
  attribution_only
  tactic_context
  source_noise_fragment

assertion_status:
  narrator_asserted
  formally_enacted_direct
  direct_speech_claim
  reported_belief
  rumor
  conjecture
  historical_account
  prophecy_or_plan

claimant_or_source:  surface string | null (narrator)
claimant_status:     narrator | resolved | unresolved_speaker

temporal_status:
  persistent_or_general
  bounded_occurrence
  historical
  future_or_contingent
  unknown

evidence_directness: explicit | inferred
```

## Route Versus Attribution (R2, approved 2026-10-04)

`primary_route` states what the proposition is about. Who asserts it is carried
only by `assertion_status` plus `claimant_or_source` / `claimant_status`.

- A speaker's claim about a person goes to `entity_profile` with
  `assertion_status=direct_speech_claim` (slot `attribute_mode=speaker_claim`).
- A speaker's claim about an event, institution, place, or tactic goes to that
  content route with its modality preserved.
- `attribution_only` (formerly `attributed_context`) is reserved for
  propositions whose content is the attribution act itself (X said/heard/
  believes, with no separable content proposition).
- Any non-narrator `assertion_status` requires `claimant_status` to be
  `resolved` or `unresolved_speaker`; it may never be silently dropped.

Moving a record between routes never changes its `assertion_status`,
`temporal_status`, or evidence.

## Strict Mechanism Sub-Judgments

Strict review annotates only atomic sub-judgments, each with evidence spans:

```text
assertion_status
operational field spans (subject/trigger/effect/limit/cost/applicability)
generality_scope
generality_cue_span
span binding check
```

Institutional/legal propositions default to `needs_human_policy` unless a
complete authority/condition/procedure/effect-or-sanction/scope contract is
directly stated.

## Annotator Provenance

Every annotation row carries `annotator_class: human | delegated_assistant |
ai_provisional | model` and `sample_frame: enriched_calibration |
coverage_window | stratified_audit`. Only `human` rows may serve as gold for a
certification gate.

## Non-Mechanism Value

`mechanism_contract_eligible=no` does not discard the proposition. It is routed
to its primary content queue with modality and temporal status preserved.
