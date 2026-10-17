# Multi-Model Review Upgrade

## Roles

```text
generator_model
  -> source proposition / route / slot proposal

verifier_model
  -> only tests cited source-span entailment

lead_model
  -> evidence-first judgment, rewrite, route disposition, risk classification,
     decision dossier

human_or_kp_authority
  -> publication, policy exception, ruleset activation, state-impact approval
```

Models use separate prompts and artifacts. The verifier does not receive
generator rationale. The lead model receives source evidence, generator output,
verifier result, and contract checklist, but not hidden runtime state.

## Dossier Contract

`LEAD_MODEL_REVIEW_DOSSIER_CONTRACT.md` defines the source-bound, hash-pinned
review dossier shared by generator, verifier, and lead model. Its lead outcome
is limited to `retain`, `rewrite`, `return`, or `needs_human_policy`, and is a
research recommendation only.

## Lead Model Authority

The lead model may recommend only:

```text
retain
rewrite
return
needs_human_policy
```

Every decision records reviewer_class=lead_model, evidence basis, cited IDs,
modality/temporal handling, rationale, risk flags, and consumer boundary.
The lead model only grants a research recommendation; it never grants runtime
effect.

After scope and hash checks pass, a lead recommendation may be attached to a
`research_lookup_only` manifest. That attachment does not publish a fact or
grant runtime authority.

## Authority Boundary

The lead model may not independently set:

```text
runtime_effect=true
published_fact
active_rule
state mutation
plot fact
cross-work fact merge
policy exception
```

Those require human/KP authority plus approved ruleset contract, deterministic
fixtures, and a hash-pinned admission record.

## Disagreement Routing

```text
generator/verifier agree + lead retain/rewrite -> research candidate
generator/verifier disagree -> lead review queue
lead return/needs_human_policy -> human_policy_or_lead_escalation queue
human decision overrides model decision -> immutable superseding record
```

## Quality Controls

- Random stratified audit of lead-model retain/rewrite decisions.
- Different model/provider for generator and verifier where practical.
- Track model/endpoint/prompt hash/finish reason for every job.
- Never count model agreement as independent source evidence.
- Maintain explicit abstain/needs_human_policy outcomes.
