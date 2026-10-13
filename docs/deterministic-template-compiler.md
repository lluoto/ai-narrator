# Deterministic Template Compiler Boundaries

The deterministic template compiler works only from explicit SourceFactGraph
structure. A heading creates a draft scene candidate. A named marked item with
body evidence under that heading creates distinct draft clue and item
candidates, plus the default mechanism `marked-item-observation-v1`. Candidate
identity is derived from document identity and exact evidence spans; it is not
supplied by a hint.

That mechanism is an `engine_policy` default, not a module-explicit source
fact. It can compile only in compatible mode with its policy ID explicitly
allowed, an approved-policy review, exact statement evidence, default
derivation, and gameplay-mechanic schema. Strict mode rejects all engine policy
mechanisms. It cannot replace an accepted module-explicit mechanism on the same
path.

The template produces only `observe`, `check: none`, and an explicit
`discover_clue` success effect. It never infers skills, difficulty, importance,
core status, connections, state writes, endings, NPC dialogue, or paragraph
clues. Nameless or unscoped marked items remain unresolved rather than receiving
invented names or scenes.

An item candidate is still not an executable item. It enters the MechanicsIR
item symbol domain only after an explicit, source-cited `item_binding` answer.
Deleting, renaming, relocating, or rebasing its evidence cannot reduce the
question set or publish a partial result: resolution compares the entire draft
candidate set with a fresh deterministic compilation and stays `draft_only` on
any mismatch.

A preserved `table_row` with an actual `heading_scopes` relation creates a
separate draft reward candidate. This is only a review subject: the template
does not infer a condition, reward type, amount, or executable effect from row
text. An unscoped compact row creates no reward candidate, and resolution and
artifact restoration compare the complete reward-candidate set with a fresh
deterministic compilation before accepting a binding.

Output is always `draft_only`. Its blocking codes report that scene candidates,
entry scene, ending rules, and connection topology remain unresolved. These
codes are intentional evidence that the draft is not publishable. The queue
and resolution stages accept explicit answers for topology, endings,
core-clue policy, discovery, item binding, and reward binding. The draft itself
does not modify ModuleData or runtime behavior.

## Draft 1.4 marked-body atoms

The draft preserves the marked clue ID as the shell identity and additionally
derives ordered `clueFactAtoms` from the actual marked body. Splitting is
structural, not semantic: sentence punctuation and balanced bracket segments
form source-exact candidates, while the later queue answer decides shell,
gated finding, or source-only disposition. Each atom carries its body statement
and exact evidence; no atom is executable merely because it exists.

Derivation fails closed when the body cannot be represented as ordered,
non-overlapping raw source spans whose text reconstructs the body modulo
whitespace. It never falls back to making the full body immediately visible.
This allows a visible object identity and a checked conclusion to use separate
runtime clue symbols without adding partial-clue state.
