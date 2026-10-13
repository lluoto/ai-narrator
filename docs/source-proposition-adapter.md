# Source Proposition Adapter

## Status And Boundary

`src/world/source-proposition-loader.ts` is an isolated, read-only evidence
adapter for `source_proposition_records_v2.jsonl`. It has no default path and
does not read an environment variable: a caller must explicitly inject
`{ path }`, such as the current scheduler artifact at
`D:\aitrpg\世界模型\worldmodel\runs\_extraction_scheduler\20260924\source_proposition_records_v2.jsonl`.

It accepts only `candidate_not_confirmed`, `no_transfer`, `queryable` records
whose sole `allowed_work_ids` entry exactly equals `work_id`. Malformed JSONL,
invalid queryable candidates, empty work scopes, and cross-work records are
rejected. Non-queryable audit records are deliberately not returned.

Queries require one nonempty `workId`, use exact same-work filtering, and may
add an exact optional `route`; text matching is literal substring matching and
supports Chinese text. Returned receipts contain the proposition, source
evidence, modality, temporal status, warnings, and `noRuntimeEffect: true`.

This adapter is not connected to `world-model-loader`, `world-model-integrator`,
game sessions, world state, rule execution, or prompt construction. Loading or
querying it cannot create game facts, mutate state, execute a rule, or inject
prompt context.
