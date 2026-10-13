# Runtime Rule Admission Link

`src/compiler/runtime-rule-admission-link.ts` is a pure compiler-level
validator for the acyclic two-stage evidence chain:

1. Prior `research_lookup_admission` decisions provide source evidence.
2. An approved runtime ruleset contract pins the prior decision hashes, their
   reviewed-source pins, one work scope, and the exact selected candidate set.
3. A final human `runtime_rule_admission` cites the canonical contract hash.

`validateRuntimeRuleAdmissionLink(decision, rulesetContract)` revalidates both
artifacts, requires the final decision to be a human runtime admission with
`runtime_effect: true`, and checks the exact contract hash, work ID, source
pins, and candidate IDs. The contract must not include the final decision hash;
it contains only prior source-decision hashes so the chain remains acyclic.

The function returns a deep-frozen `RuntimeRuleAdmissionLinkReceipt`. This is
validation evidence, not activation: it does not load an evaluator, evaluate a
rule, mutate state, connect to `GameSession`, invoke an API, or authorize any
runtime behavior.

The contract stores opaque prior decision hashes and source pins. This linker
cannot prove that those hashes resolve to research decisions or that their
external payloads match the pins. Consumers that dereference those decisions
must validate them separately before relying on them.
