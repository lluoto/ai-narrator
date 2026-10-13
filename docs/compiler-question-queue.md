# Compiler Question Queue Boundaries

The compiler question queue is a structured inventory of missing executable
module decisions and their exact source evidence. It is not an error log, and
an open or unknown question is a valid, honest compiler state.

Questions are generated deterministically from draft scenes, draft clues,
unresolved marked items, heading-scoped table rows, and prose structure. They
ask about scene roles, entry, topology, core clues, endings, discovery methods,
item bindings, and reward bindings;
they do not answer those questions. In particular, headings do not become an
entry, document order does not become a connection, and marked items do not
become core clues.

Every question hashes its document identity, kind, source statement IDs, and
role. Its evidence refs must cover the cited SourceStatements. Draft readiness
links each blocking code to one or more open, publish-blocking questions while
remaining `draft_only`.

Question ownership follows the source subject. A real clue keeps its
`core_clue` and `discovery_method` questions even if a damaged draft has lost
the corresponding item candidate. An `item_binding` question is emitted only
for a graph-canonical candidate, and its accepted answer cites the exact marked
item name. This prevents corrupted intermediate data from becoming publishable
merely by making a question disappear.

Hints schema 1.9 makes a source-only marked item explicit with `itemType: null`.
That value means no runtime item: it must not create an item IR symbol,
projection, or workbench slot. Earlier hint schemas that try to express this
null source-only contract fail closed rather than being guessed as an item.
The model adapter prompt must preserve the same 1.9 distinction: a runtime
proposal supplies its runtime key/document/loot semantics with
`item_binding:<id>`; a source-only proposal supplies `itemType: null` with
`item_binding:none:<id>`. Uncertainty must not be converted into a guessed item
type or an implicit binding.

Queue schema 1.7 gives each NPC answer an exact `subjectStatementId` in addition
to heading context. A paragraph that is independently answerable under the same
heading is therefore a separate subject, not evidence that can be silently
borrowed by a neighboring NPC answer.

Queue schema 1.8 corrects an older dead-end representation: a `paragraph` or
`list` root is no longer made into a permanently unanswerable generic discovery
question. It receives one explicit `source_fact_disposition` decision instead.
Hints schema 2.0 carries that decision and report schema 1.1 accounts for it.
`source_only` is an intentional source answer, not a runtime binding: it creates
no runtime entity, MechanicsIR symbol, projection field, or workbench slot.
`mechanics_candidate` is structured pending work, not an inferred mechanic; it
keeps the prepared artifact incomplete until an independently valid binding is
accepted. The report therefore makes the distinction visible rather than
silently treating prose that cannot become a discovery action as answered.

A `reward_binding` question belongs to exactly one graph-canonical table-row
candidate and cites both the row and its verified heading scope. Its answer is
either an explicit `null` declaration or one `reward_definition`; conditions
are restricted to boolean composition of clue, scene, and owned-item facts,
and settlements are restricted to positive SAN recovery, fixed Cthulhu Mythos,
and fixed reputation. Unsupported predicates, negative SAN, skill growth,
foreign rows, and invented candidate IDs fail closed rather than remaining as
raw hint objects.

`ModuleCompileHints` is the in-memory validation contract for explicit answers.
A hint must match queue identity, question kind, semantic candidate domains,
exact source evidence, and allowed authority/reviewer values; duplicate
resolutions, unsupported kinds, dangling IDs, and inconsistent stored answers
fail closed. Resolution uses the same discriminated parser as validation and
derives readiness from the resulting answered queue rather than copying an old
draft snapshot.

## Candidate-local runtime item-name evidence (queue 2.0)

A positive `item_binding` now has a second, independent source contract:
`itemNameEvidence` must reproduce the canonical item's own marked name and body,
not a clue title, a nearby source fragment, or a model-invented display label.
Queue schema 2.0 emits that candidate-local evidence; hints 2.1 and
proposal-request 1.3 carry it. A null/source-only declaration forbids the field.
The shared value contract, parser and audit, accepted claim, resolved binding,
canonical regeneration, projection/source map, and runtime display preserve the
same evidence so the displayable loot name remains source-exact.

The canonical item's question derives from item-owned sources. In particular, a
malformed clue cannot pollute the question or provide evidence for the item.
This is a fail-closed binding rule, not a new text-extraction heuristic.

## Ordinary intent model replies are validated before fallback

The ordinary GameSession intent API accepts only a declared action allowlist and
the exact keys, value types, enums, and safe numeric values for that action.
`spell`, `luckSpend`, `weaponName`, `calledShot`, and `item` remain supported.
An invalid model reply is a warning and falls through to the existing regex
fallback; it never becomes a partly trusted action. This does not change the
separate compiled-intent contract or its execution authority.

## Source-bound static NPCs remain non-interactive unless separately modeled

The exact Fuzu acceptance now has one bound NPC: 兰迪.帕蒂拉, whose evidence is
limited to the 中庭 same-heading scope. The accepted shape is static
`narrative_noncombat`; it creates neither talk nor combat. Its source map,
projection, and GameSession path are verified. Replacing its accepted
`presentNpcs` with `[]` makes the exact acceptance fail with expected
`boundNpcAnchors` 1 and received 0; restoration passes. This is one
source-evidenced static binding, not automatic NPC dialogue, encounters, or
general extraction breadth.

## Human-reviewed prose NPC dialogue clues (queue 2.1 / hints 2.2)

The queue's NPC subject remains the exact anchor paragraph. A human-reviewed
`dialogueMethods` entry may now use a distinct prose-only form with
`relationshipEvidence: { statementId, quote }`. Both values must identify a
trimmed, source-exact relationship substring in that same anchor paragraph,
not merely a matching NPC identity elsewhere in the document. The compiler,
not the caller, derives the prose clue ID, scene/location, mechanics target,
and the one `discover_clue` success effect. This form cannot acquire an item,
choose a foreign location or target, carry an arbitrary clue ID, or declare
`onFailure` or `failback`; a failed relationship talk has no side effects.

That derived clue is distinct from a marked structural clue. Its exact
relationship statement and quote survive the accepted interpretation,
MechanicsIR, runtime projection and source map, canonical artifact replay,
quality report, GameSession execution, and durable restart. Duplicate derived
clues fail closed. Automatic proposal production remains unable to declare any
dialogue or encounter, including this prose form: it is a bounded human-review
capability, not an automatic prose-to-mechanics inference.

### Hints capability matrix

The parser uses a declared capability table rather than treating every
historical schema as equivalent to the current schema. Supported capability
floors are:

| Capability | Minimum hints schema |
| --- | --- |
| Explicit null/source-only item binding | 1.9 |
| `source_fact_disposition` | 2.0 |
| Positive item binding with source-exact `itemNameEvidence` | 2.1 |
| Explicit `dialogueMethods`, including `[]` | 1.7 |
| Prose-only dialogue clue with `relationshipEvidence` | 2.2 |

This means a known lower schema may use only its declared capabilities; it is
not rejected merely because it is not byte-equal to the current schema. The
opposite is also enforced: a prose dialogue value under pre-2.2 hints fails
closed. The validation first rejects a prose `onFailure` or `failback` before
its shape is otherwise parsed, so an untrusted caller cannot smuggle failure
effects through the marked-clue dialogue branch.

Regression evidence includes restoring equality-to-current version checking
(14 pass / 1 fail), restoring the old failure-branch injection (5 pass / 1
fail), and removing exact relationship-quote validation (the negative quote
test turns red); each restoration returns green.

Final verification is 101 pass / 0 fail / 12 files / 882 expectations,
typecheck 0, and full test exit 0: 3593 tests / 274 files / 3561 pass / 32 skip
/ 0 fail / 20724 expectations in 76.16s. `bun scripts/preflight.ts` also exits
0: generated-document reference checks pass, 206 boolean implementations have
0 discarded returns, tests/files 3593/274 and unwired 82 match baseline, and
`core.hooksPath=.githooks`.

## Queue/hints 3.2: clue fact facets

Every marked clue with a verifiable body now receives one publish-blocking
`clue_fact_facets` question. Its `allowedClueFactAtoms` is a queue-owned,
source-ordered closed domain. A 3.2 answer must dispose every atom exactly once
as a shell atom, an atom in one independently named finding, or a source-only
atom. Findings require one to four compact methods; observe/search may target
scene or clue, and read may target clue. The compiler supplies the real scene,
target ID, finding clue/mechanism IDs, shell/not-found availability, and the
discover effect. Caller-authored IDs, location, effects, availability, state
keys, and runtime AST are undeclared fields and fail closed.

The atom catalog is not trusted merely because it hashes. Validation checks the
raw page quote, containment in the canonical marked-body evidence envelope,
source order, strict non-overlap, and complete body reconstruction modulo
whitespace. Artifact restore regenerates the queue from graph and draft before
snapshot comparison. Legacy hints cannot silently treat the whole body as
visible; 3.2 is the first version that can answer this question.

Proposal request 1.8 includes only atom ID, exact quote, and statement ID. A
server-owned approved policy may propose the same partition, with one-to-one
claim-key citations validated against the offered atom domain. Unsupported or
partial answers remain open/draft-only rather than becoming a human approval
requirement or a compatibility fallback.

## Queue/hints 3.3: actor-effect event-slot provenance

Each declared actor-effect `sanity_check` has one exact provenance binding:
the compiler-derived `effectPath`, an event slot, and an exact source
`statementId` plus quote. The event slot is a real connection-traverse slot or
a discovery mechanism/outcome/effect-index slot. A SAN effect without one of
those bindings is rejected, as are orphan bindings, extra bindings, and any
binding cardinality that is not exactly the emitted SAN-slot cardinality.

Connection provenance is resolved against the current topology's actual
connection slots. A source quote that names `Red Room` cannot be attributed to
the separate `Room` target merely by substring inclusion, and duplicate
target-heading slots remain ambiguous rather than being collapsed by a set.
For checked discovery, the source quote must carry exactly one matching branch
meaning (success, failure, or failback); a quote carrying multiple branch
markers, including Chinese markers, is not proof for any one branch. A
discovery is checked only when `check !== undefined && check.kind !== 'none'`;
an omitted check is unchecked and does not need a branch marker. NPC dialogue
methods use the same contract.

Source declaration capacity is not a `(statementId, quote)` string key. The
validator resolves the quoted text once in the full source statement, parses a
canonical declaration at that absolute location, requires the quote to cover
that declaration, and keys consumption by `statementId` plus its canonical
absolute span. Capacity is one unless that declaration itself has its adjacent
repeat marker (for example, `SAN 1/1 twice`); unrelated wording elsewhere in
the quote cannot expand it. Capacity is checked over the complete effective
resolution set, including answered queue resolutions and incoming resolutions,
while each question continues to enforce its own domain and slot rules.

## Cross-heading NPC encounter profiles

An `npc_binding` anchor remains owned by its actual location heading. It may
offer a separately headed NPC profile for the four encounter stats only when
the anchor paragraph exactly contains the profile heading's trimmed text and
that one scope contains complete parser-accepted HP, dodge, fight, and fixed
or `NdM` damage evidence. All four selected stats must come from one heading;
an alternate-profile selection additionally requires `nameQuote` to equal the
trimmed profile heading exactly. A profile cannot be used by a different
same-paragraph NPC, combined with another profile, or inferred by substring.

Scene ID and auto-start continue to derive from the anchor location. Victory
clue and item effects likewise require the location heading's marked evidence,
not the profile heading. The canonical queue validator recreates the offered
source domain from graph scopes and evidence spans, including the required
location heading, before accepting an answer. If no alternate profile is
offered, it emits the legacy NPC-binding prompt unchanged so existing queue
hashes remain stable.

An alternate profile therefore makes the canonical source set multi-heading,
but it does not change the binding's location owner. Any grounded
proposal/adapter scene policy must derive the scene from the anchor paragraph's
parent location heading and exact-match its canonical `scene_role`; it must
not inspect the first sorted `sourceStatementIds` heading. Encounter generation
remains human-review only.

## Automatic source-exact NPC encounter (request 1.9 / audit 1.3)

Automatic encounter is not a relaxation of human-reviewed encounter binding.
It is exposed only by a server-owned trusted policy with
`allowSourceExactNpcEncounters: true`; request input cannot enable the
capability. An NPC question must already have an answered playable canonical
location, and the queue must reconstruct exactly one complete owner/profile
from graph evidence before proposal request 1.9 publishes
`allowedNpcEncounterProfiles`. A direct profile needs exactly one HP, dodge,
fight, and damage evidence candidate in the anchor paragraph. An alternate
profile still needs an exact anchor mention of its trimmed heading, an exact
`nameQuote` equal to that heading, and all four slots from that one profile.
No profile ambiguity, same-name ambiguity, mixed location/profile owner,
incomplete stat set, or source-order choice is accepted.

The request exposes only the four closed stat evidence selections as
`{ statementId, quote }`. The compiler derives the encounter ID, canonical
location scene, combatant, auto-start, and MechanicsIR runtime shape through
the existing parser. Caller/model-provided IDs, targets, victory/effects,
runtime AST, and unknown fields are not part of the value contract; the derived
`victoryEffects` is empty. Documents without an eligible profile retain their
byte-stable legacy request/prompt/hash, and the existing human-reviewed
encounter contract is unchanged.

The automatic-only audit is version 1.3 because older audit shapes cannot
represent its claims. It requires producer provenance plus one exact citation
for the name, each of the four stats, and the trigger. The trigger must be a
non-empty bounded exact substring of the anchor paragraph, distinct from the
name quote, which names that NPC and satisfies only the narrow immediate,
affirmative-hostility grammar. Friendly, negated, conditional, delayed,
self-defence, ability-only, and third-party-attack wording is deliberately
rejected rather than guessed into combat.
