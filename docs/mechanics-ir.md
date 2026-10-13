# MechanicsIR Boundaries

MechanicsIR is a small executable data language. It is not an automatic
semantic extractor: source prose, headings, and marked items remain only
SourceStatements until an explicit interpretation is reviewed and accepted.

`compileMechanics` consumes only caller-named accepted interpretations. Each
accepted interpretation must have source statements, matching evidence refs, a
permitted gameplay authority, a `mechanics.*` path, a strict candidate schema,
and an auditable review. The compiler does not infer actions, checks, effects,
symbols, or endings from prose alone.

The DSL limits predicates to boolean composition, clue/scene/item facts,
declared state equality, and NPC state. Effects are limited to clue discovery,
explicit item acquisition, declared state writes, connection unlocks,
encounters, and an explicit end game. `item_owned` and `acquire_item`
refer only to item IDs admitted through source-bound compiler answers. IDs and
all referenced symbols are statically checked, and the canonical MechanicsIR
hash is stable for identical input.

Terminal rewards are a catalog of source-bound `reward_definition` nodes, not
an alternate free-form effect channel. Each definition has one stable reward
ID, accepted-interpretation provenance, a restricted clue/scene/item predicate,
and a bounded settlement. The shared terminal executor evaluates the catalog
only after ending effects have produced the terminal state. Runtime settlement
is then deterministic and idempotent: Cthulhu Mythos tightens the SAN cap,
positive SAN recovery respects that cap, reputation is bounded, and the exact
rolled result is replayed from the durable action trace. Negative SAN and its
insanity side effects, skill growth, and arbitrary character writes are not
accepted by this contract.

`availability` means an action may be attempted. `onSuccess` means an effect
occurs after that attempt succeeds. A parent clue making a child action
available does not discover the child; only an explicit `discover_clue` effect
does so.

Unknown, candidate, rejected, and deferred interpretations remain valid
non-executable states. Closed-world reachability, shortest witness replay,
automatic settlement, connection gates, item ownership, and ending closure now
share the same execution semantics. Projection may expose source-exact display
data, but MechanicsIR and MechanicsState remain the execution authority.

## Faceted clue execution

Clue fact facets do not add another runtime language or partial-discovery
state. The shell and every accepted finding are ordinary clue symbols. A
compiler-derived finding method uses the verified heading scene and requires
both `clue_found(shell)` and `not clue_found(finding)`; its success effect is
the existing `discover_clue(finding)`. Consequently automatic settlement may
reveal an accepted shell without revealing a checked finding, and all existing
reachability, replay, failure/failback, durable state, and discovered-action
suppression semantics continue to apply unchanged.

## MechanicsIR 1.6 actor-effect sidecar

MechanicsIR 1.6 retains actor effects as a source-bound sidecar rather than
making SAN declarations a new general-purpose effect DSL. Direct compilation
and `validateMechanicsCandidate` independently verify that every provenance
binding belongs to the current interpretation's `sourceStatementIds`, that the
statement exists in the source graph, and that its quote is a unique exact
substring of that statement. This graph-aware boundary deliberately checks
identity and exact citation only; queue validation remains the authority for
SAN grammar, branch meaning, slot matching, and declaration capacity.

The shared executor emits the validated actor effects, and GameSession applies
them through its SAN settlement path. Snapshot restore/replay re-executes the
same compiled mechanisms and compares the durable settlement/character frame,
so a sidecar cannot be silently omitted or forged between compile and replay.
