# Evaluate Action Boundary

`src/compiler/evaluate-action.ts` is a deterministic, entry-state-only wrapper
around the compiler mechanics core. `evaluateAction` accepts exactly three
plain-object fields: a valid `mechanicsIR`, a valid `analysisInput`, and one
exact `requestedAction` union. The request is either `{ mechanismId, outcome }`
for `success`, `failure`, `failback`, or `traverse`, or the exact attack object
with its complete combat outcome. Extra fields, non-plain request objects, and
malformed action scalars are rejected before evaluation.

The wrapper validates through the shared core, creates the analysis entry state,
settles all initial automatic mechanics, executes exactly the requested action,
then settles automatic mechanics again. It returns a deep-frozen result with the
final `MechanicsState`, a cloned original request, complete ordered core-edge
trace, unresolved selected actor effects, and entry/final hashes. The trace is
replayable from `initialMechanicsState(analysisInput)` with the shared mechanics
replay rules; consecutive edge hashes must join from `beforeStateHash` to
`afterStateHash`.

`sanity_check` actor effects are reported in `unresolvedActorEffects`, never
applied to `MechanicsState`. Automatic conflicts, cycles, invalid mechanics
state, terminal entry states, and unavailable actions are not converted into
local fallback results: their shared mechanics errors propagate.

This is an evaluator artifact boundary only. It imports only mechanics core
compiler modules and has no GameSession, runtime state, world, persistence,
SQLite, filesystem, network, random, or prompt dependency. It does not expose
an endpoint, admit a ruleset, authorize runtime use, mutate persistent state,
or settle actor effects.

The approved runtime ruleset contract may pin a deterministic evaluator artifact
and names `evaluate_action` as its only allowed capability. As documented in
`approved-runtime-ruleset-contract.md`, that contract is not runtime wiring or
authorization. Connecting this wrapper to any runtime consumer requires a
separate approved integration task.

## In-Memory Fixture Replay

`src/compiler/evaluate-action-fixtures.ts` provides
`runEvaluateActionFixtures(mechanicsIR, analysisInput, fixtures)` for isolated
deterministic evaluator checks. Its fixture list is nonempty and every case has
an exact `id`, `requestedAction`, and explicit `expected` final-state hash plus
ordered `{ mechanismId, outcome }` trace. Duplicate IDs, unknown fields, empty
lists, malformed expectations, and expectation mismatches are rejected.

Each case is evaluated twice, checked for structural equality and canonical
entry/final hashes, then replayed through the shared mechanics witness rules.
The frozen null-prototype report is keyed by fixture ID and contains the verified
`EvaluateActionResult` values. The runner is in-memory only and imports solely
the evaluator and compiler mechanics core/reachability modules; it has no
runtime session, world, persistence, filesystem, network, or randomness role.
