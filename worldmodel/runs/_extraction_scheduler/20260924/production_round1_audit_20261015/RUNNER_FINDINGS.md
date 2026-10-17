# Runner Acceptance Findings

This review concerns first-round execution and source-support acceptance, not
runtime admission. Existing production artifacts remain unchanged. Line numbers
refer to the inspected runner revision and may shift after a repair.

## High Priority

1. `tools/proposition_canary_run.py:350-372,821`: overall entailment can pass
   with absent checks or a contradictory field check. Require explicit check
   coverage and deterministic overall consistency before queue admission.
2. `tools/proposition_canary_run.py:328-370,790-811`: citation scope is the whole
   window although the verifier receives only candidate evidence slices. Check
   citations against the actual supplied evidence, not unsupplied neighbors.
3. `tools/proposition_canary_run.py:394-519,617-624`: reverify trusts stored
   accepted cards and current source lookup without complete original-work,
   chapter, coverage, and source-snapshot reconciliation. Reject unresolved joins
   and revalidate stored cards before any new call.
4. `tools/proposition_canary_run.py:176-185,755-837`: returned model, choice count,
   and stop finish are not consistently required at both stages after smoke.
   Persist rejected raw envelopes and reject every invalid envelope.
5. `tools/proposition_canary_run.py:878-886`: `ok` principally means smoke plus
   zero transport failures, not full parse/schema/verification success.
   `window_errors` does not account for observed later parse errors. Separate
   attempts, valid results, rejected cards, and verification completeness.
6. `runs/_extraction_scheduler/20260924/run_wavea_canary_batch.py:178-188,257-266`
   and `run_reverify_8001.py:66-71`: retry can delete or overwrite evidence.
   Use absent-only attempt directories and explicit attempt selection.
7. `tools/proposition_canary_run.py:723-737,849-854`: raw generation/verifier
   responses are accumulated until book completion. Persist each raw call
   before validation/checkpoint advancement so interruption does not erase it.
8. Original queues and `reverify_8001` results coexist without one explicit
   effective-verification selection. Do not union them or select by timestamp.
   A future selector must bind generator/source/attempt hashes and fail closed
   when selected verification is missing or unusable.

## Additional Findings

9. `tools/proposition_canary_run.py:254-325`: claimant type/status completeness
   is not enforced. Preserve genuinely unresolved speakers explicitly; do not
   invent a claimant or move all attributed content to the attribution route.
10. Batch/reverify drivers can exit zero despite unresolved failed books, and
    supervisor completion predicates differ from driver predicates. Require
    consistent terminal outcomes and report budget exhaustion separately.

## Repair Order

First fix acceptance checks, citation scope, source lineage, and durable raw
capture using no-network adversarial tests. Then define explicit supersession
selection and reconcile the historical outputs into a NEW audit view. Only
afterward plan targeted re-verification; do not rerun all generators to repair
verifier-only failures. Historical `ok` flags must remain historical evidence.

No fixes to production runners, model calls, effective result selection,
publication, or runtime changes were performed in this audit.
