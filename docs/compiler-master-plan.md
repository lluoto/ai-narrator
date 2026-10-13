# Compiler Master Plan

This is the control plan for the evidence-bound module compiler. It describes
the current implementation boundary, including the shipped public compiler
entry point, without implying broader CLI or world-model entry points.

## Milestones

| Milestone | Status | Verified result |
| --- | --- | --- |
| Source structure through draft and question queue | complete | DocumentIR evidence, SourceFactGraph, deterministic marked-item draft, and evidence-bound questions remain separate from runtime module loading. |
| Checkpoint I: hints through closed-world analysis and P4 execution semantics | historical foundation committed; current repair awaiting main-control acceptance | `bb42ef4`, Group A (`906ef06`), Group B (`1fea0b4`), and diagnostics simulation (`5095efe`) are on `master`/`origin/master`; the current uncommitted repair adds the Barn source-bound prepare correction, two-real-module identity probe, and scoped compiled world-model boundary described below. |
| Diagnostics process simulation | committed and pushed | `5095efe` retains private `WeakMap` lineage; detached process bundles still fail closed. |
| Checkpoint II: local artifact persistence | committed and pushed | `4c1f08d` adds versioned JSON-safe prepared/resolved envelopes that regenerate and compare compiler state on restore, use a distinct canonical artifact identity, and save atomically. |
| Checkpoint III: public compiler entry end-to-end validation | committed and pushed | `c0d3cb4` makes typed synthetic-pages and PDF-bytes preparation share the DocumentIR-to-artifact chain; resolve validates a restored prepared artifact before returning durable mechanically closed output. |
| ModuleData presentation projection | committed foundation, locally hardened | `107c99f` supplied the projection foundation; the current worktree replaces caller-authored presentation with an immutable, identity-bound trusted review and derives mechanics-visible fields from MechanicsIR/draft. |
| GameSession compiled runtime consumption | committed and pushed | `9354054` adds explicit dynamic loading that validates the complete resolved artifact and projection before host writes, starts at the compiled entry, and routes `@compiled <mechanismId>` through the shared core. Legacy loaders and drivers remain separate. |
| Compiled HTTP module lifecycle | committed and pushed | `552af6f` exposes the compiled-module lifecycle over HTTP. |
| Durable compiled artifact catalog | committed and pushed | `551a0e5` adds the artifact catalog used by compiled-module lifecycle handling. |
| Public bounded automatic mechanics resolution | implemented and locally verified | Catalog-only `POST /api/compiler/auto-resolve` restores a prepared ID and exact queue identity, applies bounded untrusted proposals under server-owned trust, and stops at mechanics. Validated partial work can resume from an opaque, immutable continuation without re-asking accepted questions; even a mechanically closed result remains `presentation_draft_only` until the controlled review/resolve path supplies independently trusted presentation. |
| Trusted presentation publication | implemented and locally verified | Exact source quote/evidence/heading bindings are stored in an immutable server review; `/resolve` accepts only its opaque ID and canonical bundle replay revalidates it. |
| Compiler control-plane authorization | implemented and locally verified | Host-resolved operator/Keeper/player principals gate every compiler/catalog/compiled-session creation route before body, lookup, model, or write; the default two-token deployment adapter fails closed. Earlier frozen 80854/preflight 89848 passed; current frozen full 6185 passed (5,531 tests / 506 files; typecheck 0), while this batch's standard preflight remains pending. Next live-combination code remains unverified, and this is not real-provider quality acceptance. |
| Restart-safe compiled sessions | committed and pushed | `f9d53d8` restores compiled sessions after restart. |
| Snapshot cross-process CAS, quota, and GC | implemented and locally verified | The independent SQLite coordinator now closes the bounded snapshot CAS/quota/GC path; it remains distinct from ordinary-session, claim-sidecar, and deployment-wide multi-writer readiness. |
| Control-state relevance pruning | implemented and locally verified | Report component 1.1 quotients only semantically inert pure-observation discoveries; the 500-state cap remains a finite safety boundary rather than a scalability claim. |
| Creator-bound durable compiled-session access | implemented foundation, superseded at the runtime boundary | Snapshot schema 2.8 binds a compiled session to an operator/Keeper role and a SHA-256 principal fingerprint. HTTP owner checks, snapshot inheritance, hidden listings, opaque diagnostics, and compiled-WebSocket refusal fail closed; schema 2.9/access 2.0 retains that owner boundary while adding the limited P1 facade below. |
| Compiled P1 player facade | implemented and locally verified | Snapshot schema 2.9/access 2.0 uses a creator-time host-trusted player resolver, owner-only fallback, safe read/action projections, and generation-bound HMAC opaque choices. It is a single-P1 REST/polling slice, not per-human identity, invitations, audit, or an authenticated WebSocket protocol. |
| P2 player-browser delivery | implemented and locally verified | Digest-only invite claiming uses CSPRNG invite/claim IDs and a session-bound `__Host-` secure cookie. The independent PlayerApp uses a bounded, no-store/no-CORS player API with polling and action retry. It is not an IdP, multi-writer delivery protocol, or complete production deployment. |
| Structured compiled action discovery and execution | committed and pushed | `8500297` exposes structured compiled-action discovery and execution. |
| Second real-module source-bound preparation | implemented and locally verified; draft-only by design | The controlled 18-page Barn corpus reaches DocumentIR → blocks → graph → draft → queue with 410 real questions. It does not reuse the hand-authored Barn runtime or Fuzu answers, and remains unpublished until independent review/model proposals satisfy the queue. |
| Compiled world-model scope isolation | production main issuance implemented and locally verified | The production host loads one strict startup policy and dataset pair before inventory/listening, then injects its exact `(moduleId, artifactHash)` resolver into resolve and loose-create publication. The policy cannot carry a dataset root and requests/PDF/LLM output cannot select work or transfer scope. Missing/mismatched tuples remain unbound, while issued bindings persist through catalog/action replacement/recovery without re-resolution. The operator config view exposes only safe status. Existing exact allowed-work, manifest/root, transfer-policy, tamper and two-module isolation remain in force; legacy ordinary sessions remain separate and compiled v18 stays disabled until it has a trustworthy per-work manifest. Authorization is issuance-time; hot revocation and actual Docker/Linux read-only-mount evidence remain later production boundaries. |
| Ordinary-session KP damage HP truth | implemented and locally verified | Successful KP damage now mirrors the WorldState `remainingHp` into the same-ID existing character sheet, keeping public state, character summary, and ordinary snapshots consistent without creating NPC character objects. |
| Browser durable compiled-action retry and reconciliation | implemented and locally verified | The browser persists the exact selected compiled request before its first POST, retries the same high-entropy actionId only while the live catalog still authorizes it, and reconciles stale/possibly-committed work from an authoritative session snapshot. |
| Source-bound item ownership | implemented and locally verified | Explicit item binding reaches MechanicsIR ownership, projection, durable GameSession execution and restart; candidate corruption fails closed without erasing clue questions. Full test, typecheck and preflight pass; not committed or pushed. |
| Source-bound terminal rewards and compiled SAN checks | implemented and locally verified | Heading-scoped reward definitions and human-reviewed, source-cited player-branch SAN checks reach MechanicsIR, deterministic durable GameSession settlement, and same-/fresh-process replay. The bounded slice excludes combat, skill growth, broad automatic compilation, and general source extraction. |
| Source-bound NPC dialogue discovery | implemented and locally verified | A reviewed prose NPC binding can declare same-heading dialogue discovery methods that derive canonical `talk`/`npc` MechanicsIR actions, exact evidence, NPC symbols, projection checks, shared execution, player-safe labels, and same-process durable replay. It does not add combat, NPC-state writes, movement, relationship/mood systems, generative chat, or a dialogue-specific fresh-child acceptance claim. |
| Later milestone: broader runtime consumption | open | General CLI/model-memory integration, content breadth, migration of hand-authored modules, real-provider document-quality acceptance, and broader world-model registries remain outside Checkpoint I. The narrow catalog-bound Cthulhu reference adapter below does not redefine that later milestone. |

## Checkpoint I contract

- A topology answer belongs to its source-scene question. It declares
  `connections[]`; an empty array is an explicit zero-outgoing declaration.
  Connection IDs are declarations and must be unique across the resolved set.
- An ending answer contains one or more declarations. Each declaration has a
  mechanism-rule ID that differs from its exactly one `end_game.endingId`.
- Named draft clues receive a discovery question with separate clue, location,
  and mechanics-target domains. Explicit discovery requires its location;
  generic prose questions cannot bind an arbitrary clue.
- Parsed hint values are a discriminated union shared by validation and
  resolution. Queue, hints, and draft agree on module ID plus document/source
  graph identity. The graph itself remains document identity, not a module
  container.
- Resolved interpretations retain queue evidence, authority, explicit
  derivation, rights status, review audit, and `{ moduleId }` scope.
- Resolved readiness is derived from the current answered queue and current
  generated MechanicsIR; it does not copy the draft queue snapshot. Open
  draft-warning questions remain distinct from publish blockers.

## Execution and analysis policy

The analyzer uses one execution order for graph search and witnesses:

1. Select a matching ending rule by priority and execute its declared
   `end_game` effect.
2. Otherwise apply compatible automatic transitions until their effects reach
   a fixed point.
3. Then explore one optional player action (discovery or traversal).

Conflicting automatic state writes and automatic state cycles fail closed.
Ordinary connections remain traversable unless their declared availability uses
`connection_unlocked`; `unlock_connection` is the only state change required
by that predicate.

Discovery methods are unavailable once their clue is found, including other
methods for the same clue. `maxFailures: N` means N failed checked attempts
are recorded; the next attempted use follows the declared failback. A checked
core method without bounded recovery is reported as a policy risk, not falsely
named a proven deadlock. Recovery is evaluated from that method's concrete
post-failure state: a fallback in a past or mutually exclusive branch, or one
requiring another unbounded check, does not clear the risk. A real reachable
state with no terminal path is reported separately with a witness.

Witness minimality is the count of reported `steps`: player actions,
atomic compatible automatic batches, and ending steps all count once. Search
propagates an improved shorter route to later states. Every automatic batch
also retains its concrete MechanicsIR mechanism IDs, so replay can execute the
same terminal-first/automatic-settlement/player-action semantics and verify
each outcome and state hash.

Default marked-item observation uses the draft clue's graph-verified heading
scope as its location. Its target remains a separate semantics field; a target
cannot relocate the default. The default's clue, heading relation, source and
evidence binding, module scope, and target binding must all validate or the
result stays `draft_only`. Explicit discovery substitutes only a default with
the same verified clue and location.

## Hash ownership

- `queueHash` hashes the complete current queue, including answer status and
  resolutions. Its canonical construction is owned by the queue module.
- `mechanicsHash` hashes the compiled executable MechanicsIR.
- State hashes identify normalized closed-world analyzer states and are not
  artifact or queue identities.

## Acceptance evidence and next action

The diagnostics process simulation keeps source graph, queue, mechanics and
state hashes under their existing owners. It revalidates snapshots at prepare,
questions, hints, resolve and execute boundaries, and accepts only a caller
prescribed mechanism/outcome script. Replay is a postcondition over the produced
trace, not a substitute for the script. Missing, stale, mismatched or
non-closed stages return a structured refusal. This slice deliberately excludes
artifact persistence, public APIs, real PDF ingestion, ModuleData, GameSession,
items, NPCs, combat, rewards, rulesets, narration, LLM and world-model support.

Hardening keeps direct actions behind terminal/automatic settlement, hides mutable
state-budget hashes, and copies outgoing provenance. Before execution, the
diagnostics bundle re-runs resolve against retained graph, draft, queue and hints
and compares the complete resolved queue, IR, analysis input and report. Test
preload assigns missing per-process world-model paths by default; real model
loading requires explicit `ALLOW_TEST_WORLD_MODEL=1` and remains untested here.
The default paths include a per-process UUID so stale files or PID reuse cannot
silently re-enable workstation-local model loading.

Final diagnostics closeout evidence: plain `bun test` exits 0 with 3147 pass /
32 intentional skip / 0 fail, 3179 tests across 216 files; plain preflight
exits 0. The replay postcondition is directly tested, and explicit network
opt-in causes all network-test probes to skip fetch calls.
This is a test-isolation result, not evidence that a real world-model runtime,
artifact persistence, public compiler entry, ModuleData projection, or
GameSession integration has been accepted.

Checkpoint I has focused positive and negative coverage for multi/zero
topology, multi-ending declarations, parent/child discovery, bounded failback,
unlock gating, ending-ID separation, heading-bound default-policy substitution,
automatic conflict/cycle handling, terminal-recovery loops, state-relative
failure-policy risks, and replayable shortest witnesses. The agreed
policy/provenance and process-summary audit is now verified. All delivery
evidence is committed and pushed: Checkpoint I (`bb42ef4`, `906ef06`,
`1fea0b4`, `5095efe`), persistence (`4c1f08d`), public API (`c0d3cb4`),
projection (`107c99f`), GameSession (`9354054`), delivery records (`908c332`),
compiled HTTP lifecycle (`552af6f`), artifact catalog (`551a0e5`), restart-safe
sessions (`f9d53d8`), and structured actions (`8500297`). `HEAD` and
`origin/master` both point to `8500297`. Repository regression evidence is
recorded in the active handoff.

Local P4 verification now includes action-specific replay charging, real
two-state replay cycles with hash deduplication and fresh invocation budgets,
own `__proto__` failure counters, JSON-restored witness replay, and an explicit
special-key resolver-location integration. Four-file regression: 46 pass / 192
assertions. Typecheck exits 0; full tests exit 0 with 3024 pass / 32 intentional
skip / 0 fail, 3056 tests across 214 files. Real production mutations for
action-only undercharging, per-observation overcharging, and unsafe counter
writes each failed the intended regression and were precisely restored.

The final audit validates original defaults completely before substitution,
including original-source symbols rather than replacement-only symbols;
canonical subtree identity, relation and review coverage; retained location
provenance and playable explicit locations; foreign/domain override isolation;
and stable returned provenance snapshots. Script regressions cover exact complete
Bun summaries, decoys/ambiguity, process-before-output verdicts, genuine unset
hooks versus errors, and preservation/separation of handwritten checkpoint text.
Real mutations for every audit family failed their intended assertions and were
restored. Independent follow-up reviews found no remaining issues in this scope.

Final compiler verification: 261 pass / 789 assertions across eight selected
files; typecheck exits 0; full tests exit 0 with 3117 pass / 32 intentional skip
/ 0 fail, 3149 tests across 215 files. A follow-up delivery-record run exits 0
with 3119 pass / 32 intentional skip / 0 fail, 3151 tests across 215 files.
The active baseline records tests/files/pass/skip so equal totals cannot conceal
pass-to-skip regressions. A follow-up parser guard rejects equal ending mechanism
and ending IDs; that historical full run was 3120 pass / 32 skip / 0 fail,
3152/215. The current final diagnostics result is recorded above.

Checkpoint II artifact evidence: prepared and resolved envelopes retain source
graph/draft/queue identities, accepted interpretations, hints, MechanicsIR,
analysis input, and reports. Restore validates component versions and an
artifact-specific canonical hash, regenerates deterministic queues and complete
resolution, and requires a mechanically closed terminal report. File storage
writes a flushed sibling temporary file before replacing the target. Diagnostics
lineage remains private and unchanged.

Checkpoint III API evidence: synthetic pages and original PDF bytes share one
DocumentIR-to-artifact preparation core. Resolve restores the prepared envelope
before binding caller hints to module, document, graph and queue identities; only
a mechanically closed result publishes a resolved artifact. That checkpoint
itself added no HTTP, CLI, filesystem-path, ModuleData, or runtime entry point.

ModuleData projection evidence: the adapter validates the complete resolved
artifact before projecting graph-verified playable scenes, source-exact clue
name/body fields, declared topology and ending IDs. Required legacy presentation
fields come only from exact caller metadata and the wrapper keeps artifact,
mechanics and evidence mappings separate from `ModuleData.provenance`.

GameSession runtime evidence: `GameSession.loadCompiledModule(payload, projection)` recreates and validates the complete resolved artifact, validates projection identities/topology/source-map coverage, settles initial mechanics, then makes the first world write. `MechanicsState` is the mechanics authority; settled scene, visit, and clue facts are mirrored to `WorldStateManager`, which is also the only discovery store read by `InvestigationEngine`. The strict action codec is `@compiled <exact mechanismId>`; checked discoveries use `CoCEngine.skillCheck` at their declared difficulty, then map that result to the shared-core action outcome. Ending IDs come from MechanicsIR and narration from validated projection metadata. Terminal sessions reject later actions. The direct core replay trace matches mechanism IDs and state hashes. Focused regression: 91 pass / 9 files; plain full result: 3169 pass / 32 intentional skip / 0 fail, 3201 tests across 220 files. A temporary mutation that bypassed `executeMechanicsAction` made the terminal integration test fail with `compiled_execution_failed`, then was restored. Real world-model loading remains intentionally unverified.

Post-GameSession evidence: the compiled-module lifecycle is exposed over HTTP;
the compiled artifact catalog is durable; compiled sessions restore after a
restart; and structured compiled actions support discovery and execution.
Those increments are `552af6f`, `551a0e5`, `f9d53d8`, and `8500297`,
respectively, all committed and pushed through `HEAD` and `origin/master`.

Current boundary: artifacts retain their distinct canonical identity and complete
regeneration contract; the public API accepts synthetic pages/PDF bytes and
resolves only validated prepared artifacts. A separate catalog-only automatic
route accepts a stored prepared ID plus its exact queue hash, with server-owned
LLM/policy/producer/limits, and stops at mechanics: its only closed response is
`presentation_draft_only`, while projection and durable publication require the
separate controlled manual resolve path with validated presentation. Projection
remains presentation-only; and GameSession dynamically validates before world
writes and routes exact `@compiled <mechanismId>` actions through the shared
core. The compiled HTTP lifecycle uses a durable artifact catalog, restores
compiled sessions after restart, and exposes structured compiled action
discovery and execution. CLI, world-model/model-memory
integration, content breadth, hand-authored module migration, legacy
loader/ScriptedSession/CLI consumption, real world-model loading, and
cross-request deployment-level authentication, rate, and model-cost governance
for automatic resolution remain outside this delivery.

## Current real-source acceptance record (2026-09-19)

This record adds evidence for the original Checkpoint I contract only. Its scope
remains source-scoped hints → accepted MechanicsIR → closed-world analysis and
P4 acceptance. Checkpoint II remains local artifact save/restore; Checkpoint III
remains public compiler end-to-end validation over in-memory pages/fixtures and
real PDF bytes. Neither is implemented or reopened by this work, and a public
PDF entry must not be permanently prohibited. GameSession runtime integration is
a later milestone; using GameSession as a terminal acceptance witness does not
claim that milestone as newly complete.

The real Fuzu source is a 16-page PDF with SHA-256
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5`. Its
22 retained headings are context-bound, including `黑夜中的尖叫`、`梦境之石` and
`楼梯上的蜘蛛`; two false headings are rejected. The source-named discovery
list conservatively retains the three page-6 `寻找劳伦` contexts `劳伦的尸体`、
`大圆环` and `屋子周围`, while NPC names and rule-colon lines are not promoted.
Those facts continue through legacy `Section.items`, DocumentBlocks, graph and
templates. Queue questions bind actual heading scopes; no-ending fallback covers
only source statements and never invents a terminal outcome.

The in-memory real-source-structure test prepares the compiler, obtains dynamic
queue IDs, supplies its explicit benchmark hints once, resolves mechanically,
replays the witness, and executes GameSession. Both reachable endings are
observed (`escape_with_dream_stone`, `lost_without_dream_stone`); terminal state
has no remaining actions and retry reports `compiled_terminal`. The corresponding
single-run acceptance reports 22 headings, 3 clues, 4 playable scenes, 33
reachable states, 2 reachable endings, no deadlock, an empty failure-risk list,
and non-empty audit evidence that explicit discovery replaces the default. Its
gitignored evidence is `analysis/fuzu-compiler-acceptance`.

This is deliberately distinct from the legacy ingest runner. The real legacy
ModuleData has 11 scenes, 1 item, 2 clues, 1 NPC, zero dangling references and
two textual endings, but `scripts/ingest/e2e-run.ts` exits nonzero as
`movement-smoke`: it completes 11 decisions over 11 scenes under neutral support
without a structured ending. Legacy ModuleData does not invent clue findMethods,
and it retains unconsumed top-level items; it must not be described as a completed
legacy playthrough.

Mandatory section/item classification that is entirely empty, or a source with
no usable scene, now fails before its first file write. Partial classification,
documents without items, and the existing connection/ending/narrative degradation
contracts remain intentionally distinct. The root agent's external final
`bun scripts/preflight.ts` run exits 0: it reports 163 boolean implementations,
0 discarded boolean returns, typecheck exit 0, 3334 tests across 240 files
matching the baseline, 84 unwired methods matching the baseline, and
`core.hooksPath=.githooks` with the `commit-msg` check active.

Final source-structure hardening also rejects a zero-usable-scene document
(including one without headings or classifier inputs) before an output directory
or first output file exists. Bullet discovery-guide entries must agree between
legacy `Section.items` and DocumentBlocks; no intermediate representation may
silently retain a source discovery that the other drops. Their focused regression
was verified red at 25 pass / 2 fail and green at 27 pass / 0 fail. The final
ingest suite reports 541 pass / 0 fail.

## Current execution slice (2026-09-19)

The current execution state adds grounded compiler hint proposals: an external
producer receives only a source-exact candidate catalog and may return
untrusted, cited proposals for the current queue. Deterministic identity,
domain, citation, and policy checks still decide what becomes a hint. The
bounded auto orchestrator now also has a deliberately restricted public path:
existing prepare must first create a durable catalog entry, then catalog-only
`POST /api/compiler/auto-resolve` revalidates that prepared identity and stale
queue hash before any model call. The server, not the request, owns model
capability, trust policy, producer fingerprints, rounds, and limits; draft-only
results never project or publish. This is not a public promise that arbitrary
documents can be automatically compiled.

### Presentation-boundary correction (2026-09-20)

The earlier wording that automatic resolution could publish a resolved artifact
or bundle is superseded. `POST /api/compiler/auto-resolve` accepts only a
catalog `preparedArtifactId`, its exact `preparedQueueHash`, and optional
explicit hints. Presentation, trust, limits, and detached artifacts are rejected
before model, projection, or catalog-bundle work.

The automatic route may close mechanics, but it has no server-trusted
player/Keeper presentation product. It therefore returns
`presentation_draft_only`, with mechanics readiness `mechanically_closed` and
presentation readiness `visibility_unresolved`; it returns no artifact, graph,
projection, bundle ID, source prose, model reply, exception message, or audit
quote. A validated partial or closed result is preserved privately as a
high-entropy, identity-bound continuation. The same
`/api/compiler/auto-resolve` route can resume it and asks only questions that
remain unanswered. A resumed call with no validated progress reuses the same
continuation and performs no catalog write; initial empty, malformed, refused,
or throwing model work receives no continuation. Prepared
artifact/hash/module/document/graph/queue identity and the complete stored hint
semantics are revalidated before another model call. A closed continuation
still requires the controlled presentation-review and manual
`/api/compiler/resolve` path, which re-runs the existing full resolution checks
before projection and publication. Combat, broad automatic compilation,
complex real-model/PDF acceptance, and rate/cost governance remain open.

Ordinary prose NPCs can now be projected as static `narrative_noncombat` NPC
data; this preserves a narration/conversation anchor without presenting it as a
combatant or an inferred gameplay mechanism. A compiled session also exposes an
API-backed natural-language intent resolver. It receives only the session's
current executable action allowlist and an expected generation, performs a
read-only classification, and returns no match or ambiguity rather than an
invented/default action. A selected ID still goes through the existing
structured, generation-checked deterministic action transaction; intent
classification has no execution or persistence authority.

This is a current execution slice, **not** a completed compiler
productionization. Source-bound positive terminal rewards, the narrow,
source-cited player-action SAN-check slice, and the catalog-only bounded
automatic-resolution API are now implemented as described below; combat, skill
growth, automatic compilation of arbitrary inputs, deployment-level auth/rate/
cost governance, and acceptance on genuinely complex PDFs with a real model
remain open. Arbitrary SAN mutation and automatic extraction of SAN checks are
not implied by the implemented slice. The
real-model intent smoke is deliberately narrow: with
`search_desk` and `leave_room` as the allowlist, `我想仔细搜查这张桌子` selected
`search_desk`, exited 0, and emitted no secret, endpoint, or raw reply. It is
not evidence for the outstanding complex-document/model acceptance.

## Source-bound item ownership slice (2026-09-19)

Marked items now produce an item candidate distinct from their clue identity.
Only an answered, source-cited `item_binding` admits that candidate to the
MechanicsIR item symbol domain. Item-target discovery must occur at the bound
heading-scoped scene and must declare `acquire_item` on success; `item_owned`
can then guard a reachable ending. Unsupported item types and unbound or
cross-location references fail closed.

`MechanicsState.ownedItemIds` is the execution authority. Projection derives
source-exact item names and descriptions plus reviewed type and scene bindings;
GameSession derives inventory and remaining scene items from the mechanics
state. The same state and views are validated through durable response replay,
same-process restore, and fresh-process restore. Projection tampering is
rejected before the first world write.

The final hardening prevents a missing or modified item candidate from erasing
the real clue's `core_clue` and `discovery_method` questions. Queue construction
keeps those questions and emits an item binding only for a graph-canonical
candidate. Resolution compares the full candidate set with deterministic
templates and returns `draft_only` with `invalid_draft_item_candidates` on a
missing, renamed, relocated, or evidence-rebased candidate. Artifact restore
also regenerates and compares the canonical draft. Item question provenance
contains the exact marked-name quote, and projection independently verifies the
heading scope and marked/name/body parent-child relations.

The initial regression reproduced the defect: after deleting
`draft.itemCandidates`, the real clue produced zero `core_clue` questions where
one was required. The repaired root-agent focused run is 74 pass / 0 fail across
eight files with 337 expectations. Current full evidence is `bun test` exit 0:
3358 pass / 32 intentional skip / 0 fail, 3390 tests across 247 files and 18429
expectations; typecheck exits 0. Final preflight follows generated-document
refresh and exits 0 with the 3390/247 baseline, 84 unwired methods, and active
`.githooks` commit-message validation.

## Source-bound terminal reward slice (2026-09-20)

Heading-scoped `table_row` statements now create deterministic reward
candidates without interpreting their text. A `reward_binding` answer belongs
to exactly one candidate and either explicitly leaves it unbound or contributes
one accepted `reward_definition` to MechanicsIR. Conditions reuse a restricted
subset of the existing predicate AST (`clue_found`, `scene_visited`,
`item_owned`, `all`, `any`, and `not`); the settlement contract currently admits
only positive SAN recovery, fixed Cthulhu Mythos, and fixed reputation.

The reward catalog is the sole terminal grant authority. It is evaluated after
ending effects against the resulting terminal mechanics state. GameSession
derives a structured settlement before any live character write, persists it
with the action generation, and restore recomputes the same reward IDs, dice,
SAN/maximum-SAN, Cthulhu Mythos, reputation, response, and character chain
before installing world state. Retry returns the already persisted settlement
instead of rolling again. A terminal `reward` effect is not a second grant
language and is rejected rather than silently ignored.

This slice does not claim general reward extraction. `table_row` remains an
uninterpreted source fact until an evidence-cited answer is accepted. Negative
SAN requires the existing insanity side effects and is therefore rejected;
skill growth and arbitrary character mutations are also outside the current
contract. Combat compilation, automatic compilation of arbitrary inputs,
deployment-level auth/rate/cost governance, and complex real-PDF/real-model
acceptance remain open productionization work.

## Source-bound compiled SAN-check slice (2026-09-20)

MechanicsIR 1.3 adds the bounded actor effect
`sanity_check { passLoss, failLoss }`. Each loss is either a fixed `0..100` or
a bounded dice expression (count `1..10`, sides `2..100`, total at most 100).
It is valid only on the actual player-selected discovery `success`, `failure`,
or `failback` branch, or a connection `traverse` branch. Transitions, endings,
and other automatic contexts reject it; the pure mechanics effect runner also
throws if handed one, rather than silently treating an actor effect as a state
effect.

The shared action executor, not GameSession, selects that branch and returns
each actor effect with its mechanism ID, outcome, original effect index/path,
and interpretation provenance. GameSession settles those effects in declared
order through the existing `SanityEngine` before terminal rewards. Its stable
random stream is bound to the session, mechanics hash, pre-action mechanics
state, generation, mechanism/outcome/original index, and draw index, so d100,
loss dice, and madness outcomes are prepared before persistence and cannot be
rerolled by retry or a failed persistence attempt. SAN loss remains a real CoC
check: pass/fail loss, temporary/indefinite madness, bout detail, and only the
new phobia/mania deltas come from `SanityEngine`; it is not a direct numeric
SAN subtraction.

The durable response and snapshot contain a bounded, exact SAN-settlement
ledger with declared losses, check and loss rolls, applied loss, madness delta,
and before/after sanity hashes. Restore starts from the generation-zero
character/SAN frame, replays the executor's recorded actor effects, and
compares the recomputed ledger, response SAN view (including manias and
indefinite level), and final frame before any world write. Tampered checks,
rolls, losses, madness details, hashes, response, or final SAN fail closed.
The compile-time actor-effect limit and persistent list limits agree, so a
valid artifact cannot later produce an unpersistable action.

This is deliberately human-reviewed source binding, not a claim that a model
can reliably extract a SAN loss grammar from arbitrary prose. Human-reviewed
hints retain the source statement/citation that contains the declared loss;
model/audited proposals and legacy hint versions reject `sanity_check` rather
than accepting an inadequately bound claim. It does not add combat, skill
growth, automatic compilation of arbitrary inputs, or complex
real-PDF/real-model acceptance.

## Compiled-session frontend dispatch boundary (2026-09-20)

The browser must not confuse the game HTTP API with the model API. A compiled
session is identified by its non-negative generation, including generation
zero. It may read its structured executable catalog, but natural language first
goes to the read-only `/compiled/intents` classifier. Only an exact `selected`
mechanism may make the second, generation-checked `/compiled/actions` request
with a high-entropy `actionId`; ambiguity, no-match, and model-unavailable
responses make no execution request. Ordinary sessions retain their existing
text `/action` route.

The action transaction remains the durable authority; classification has no
write or persistence authority. Before the first compiled-action POST, the
browser persists exactly the selected mechanism ID, pcId, expected generation,
and high-entropy actionId. A transport or response-body loss retains that
record and retries the identical request only after the current catalog still
authorizes it. A generation/catalog mismatch, or `compiled_unavailable` after
a possibly committed request, is never replayed: the browser first obtains an
authoritative session snapshot and then retires the unsafe record. Explicit
successful JSON responses and deterministic non-retryable refusals clear the
record. This completes the bounded lost-response recovery path; it does not
weaken server-side generation checks or actionId idempotency.

## Source-bound NPC dialogue discovery (2026-09-20)

A human-reviewed `npc_binding` may explicitly declare `dialogueMethods` for a
present, source-exact NPC. Each method selects one canonical marked clue under
the NPC anchor's graph-verified heading scope and derives, rather than accepts
from input, its mechanism ID, `action: "talk"`, `target: "npc"`, stable NPC
target ID, and discovery location. Its success branch must discover that exact
clue. The accepted interpretation retains only the anchor heading, the exact
NPC paragraph, and the selected clue's marked/name/body evidence.

Legacy schemas cannot smuggle the field; a current named NPC binding must say
either `dialogueMethods: []` or a constrained non-empty declaration. Unknown
fields, forged quote/citation, unbound NPCs, cross-heading clues, duplicate
mechanism IDs, and conflicting NPC/clue slots fail closed. MechanicsIR enforces
`talk` if and only if the target is an NPC, and its `symbols.npcIds` must be
the canonical reviewed binding set. Projection rechecks the IR method, target,
and heading-scene binding before its first world write.

The shared mechanics executor remains the only execution path. GameSession
lists `Talk to <source-exact name>` only when that projected NPC is in the
current mechanics scene; discovering the shared clue removes every competing
method for it. Same-process durable restart replays the result and preserves
actionId idempotency. This is discovery only: it does not introduce combat,
NPC-state writes, movement, mood/relationship state, generative dialogue, or
a dialogue-specific fresh-child acceptance claim.

## Trusted presentation publication boundary (2026-09-20)

Mechanically closed output is not automatically player-visible prose. The
public resolve route no longer accepts caller-authored presentation metadata.
It restores the prepared artifact from the catalog and requires an opaque
`presentationReviewId` minted only through the authenticated operator
workbench route. The immutable review binds the prepared and resolved artifact
identities and hashes, the reviewer principal and time, and every rendered
field to an exact source statement quote, evidence reference, and verified
heading scope. Catalog reload checks the review hash and envelope; resolve
checks it against the newly reproduced resolved artifact; bundle reload repeats
canonical projection validation.

The review selects display text only. Topology, ending identities,
`findMethods`, clue importance, and unlock relationships are derived from the
resolved draft and MechanicsIR. Source-map entries retain a separate reviewed
origin for every discovery method instead of overwriting the list with the last
method. Raw presentation, foreign scope, forged quote/evidence, stale review
identity, and canonical source-map tampering fail closed.

This completes the minimal trusted publication primitive. The authenticated
principal integration, operator workbench, and operator/Keeper/player HTTP
separation are described in the next section; they remain a minimal capability
boundary rather than a complete account and audit system. Automatic mechanics
remains `presentation_draft_only` until such a review exists. Complex
real-PDF/real-model acceptance, combat, and skill growth remain open
productionization work.

## Compiler control-plane authorization boundary (2026-09-20)

The HTTP compiler lifecycle now resolves a principal at the host boundary
before reading a request body, observing a catalog entry, invoking a model, or
performing a write. Request bodies, query parameters, and caller-declared role
headers are never identity inputs. Operator principals own prepare,
auto-resolve, presentation-review minting, resolve/publication, prepared and
bundle reads, and compiled-session creation. Keeper principals can read only
published bundles and create compiled sessions only by `bundleId`; players have
no compiler control-plane capability.

`POST /api/compiler/presentation-reviews` is the authenticated operator
workbench boundary. It restores the catalog prepared artifact, re-runs the
existing resolver from explicit hints or a private continuation, validates
exact source bindings, and stores the review with the authenticated principal
ID. The body cannot supply reviewer identity or free-form presentation, and the
response contains only opaque review metadata, not source, graph, artifact, or
projection payloads. Resolve and canonical bundle reload retain their existing
identity and review validation.

The default server integration requires distinct operator and Keeper Bearer
tokens of at least 32 printable non-whitespace characters. A missing, malformed,
comma-containing, or duplicated configuration makes the entire compiler
control plane return 503. Authentication failures are 401 and authenticated
role failures are 403; both occur before resource lookup, avoiding an existence
oracle. Token comparison hashes both operands before constant-time comparison,
and CORS explicitly permits the Authorization header. A malformed or throwing
host authenticator also fails closed with no body/catalog side effect.

This closes the anonymous compiler/catalog publication surface, not the full
product identity problem. The environment-token adapter is a minimal deployment
option; a real account/rotation/audit system may use the same host authenticator
seam. Ordinary session endpoints and the legacy WebSocket self-declared role
remain outside this slice. Rate/cost governance, complex real-PDF/real-model
acceptance, compiled combat, and skill growth remain open.

Root verification: the focused HTTP/catalog/projection/API set is 39 pass / 0
fail; auth plus lifecycle is 23 pass / 0 fail. The first full run correctly
exposed eight old test fixtures that omitted the new Keeper principal; explicit
Keeper injection restored them without weakening the production default. The
final full run is 3426 tests across 252 files, 3394 pass / 32 intentional skip /
0 fail. Typecheck and the final elevated preflight exit 0; unwired remains 82
and `core.hooksPath` remains `.githooks`. Mutations that bypassed the operator
guard, trusted a body reviewer identity, or restored player bundle reads each
made their intended regression red and were restored.

## Automatic mechanics continuation and resume (2026-09-20)

`POST /api/compiler/auto-resolve` now accepts exactly one of `explicitHints`
or `autoContinuationId`. A continuation is an opaque catalog capability bound
to the exact prepared catalog ID, artifact hash, module/document/graph
identity, and prepared queue hash. Catalog restoration validates its envelope
hash and then re-runs the existing queue/graph hint validator, so a correctly
re-signed but semantically altered hint set is rejected before any model call
or write.

Partial validated progress creates a new immutable continuation. Resume feeds
those accepted hints back through the existing bounded orchestrator, which
therefore does not ask or replace an answered question. No progress reuses the
same ID and writes no file; an already closed continuation is replayable with
zero model calls. A closed continuation can be consumed by both the
authenticated presentation-review workbench and the existing manual resolve
route. Public responses expose only opaque IDs, stable question coordinates,
and progress/readiness flags—not source prose, hints, citations, model replies,
or exception messages.

The root focused source-to-runtime set passes 43 tests across 6 files. The
post-resume full run exits 0 with 3395 pass / 32 intentional skip / 0 fail,
3427 tests across 252 files, and 18786 expectations. Directed lifecycle plus
access-control verification is 24 pass / 0 fail; the related catalog-directed
set is 26 pass / 0 fail; typecheck exits 0. Three production mutations—bypassing
continuation identity, issuing a continuation for empty partial work, and
re-asking an accepted question—made their intended regressions red and were
restored. Final preflight on the refreshed exact tree exits 0: typecheck passes,
3427 tests across 252 files match the baseline, unwired remains 82, and
`core.hooksPath` remains `.githooks`.

## Source-bound NPC combat runtime and publication corrections (2026-09-20)

A reviewed prose `npc_binding` can now derive one bounded, single-enemy
encounter from exact same-heading NPC stat quotes. The runtime projects that
encounter as a hostile NPC, offers its current compiled attack action, and
settles hit/miss, bounded damage, counterattack, defeat, and terminal loss
through `RulesEngine` before the shared mechanics executor commits the result.
The durable receipt records action-local entropy and is replayed before a
same- or fresh-process snapshot is installed; retries do not reroll it.

`victoryEffects` are no longer a trusted-review escape hatch. In hints schema
1.8, every effect carries an exact same-heading marked-item source candidate,
heading, statement, and quote. Only the graph-provable `discover_clue` and
`acquire_item` targets are admitted; connection and state effects have no
equivalent graph relation and fail closed. Schema 1.7 remains readable for NPC
dialogue and encounters that omit `victoryEffects`, but any 1.7
`victoryEffects` field is a schema mismatch rather than a silent
reinterpretation.

Grounded NPC proposal canonicalization was corrected to the same source-bound
shape. Trusted presentation review 1.1 now returns only
`opaque_unavailable` module metadata where presentation visibility is not
authorized. The earlier `/character` bypass premise was false: the generation
gate already existed. This slice adds snapshot immutability and hydrate
regressions; it does not claim a new generation authorization mechanism.

Directed verification is 66 and 53 passing tests for the relevant slices.
Authoritative full `bun test` exits 0 with 3466 tests across 256 files,
3434 pass / 32 intentional skip / 0 fail; typecheck exits 0. Real mutations
setting `targetMatches=true` and changing an opaque presentation origin to an
artifact origin each made their target regressions red and were restored green.

This closes the bounded source-to-runtime single-enemy combat path, not broad
combat productionization. OCR and complex text-bearing PDF layouts plus
real-model acceptance, content breadth, player/Keeper visibility and human
review operations, complete IdP/rotation/audit, rate/cost governance, and
explicit schema migration remain open. NPC combat also does not authorize
arbitrary effects or manufacture source facts outside the verified graph
relation.

## Text-layer PDF production entry fails closed (2026-09-20)

The production prepare boundary now distinguishes a document that has no
usable text layer from an ordinary unresolved draft. A textless PDF is rejected
directly with `PDF_TEXT_UNAVAILABLE`; the authenticated HTTP entry returns 422
for the same condition, and neither route writes a catalog entry. This is a
fail-closed intake rule, not a claim that all PDF forms are supported: OCR and
complex text-bearing layouts still require dedicated coverage, as does real
model end-to-end acceptance. A real mutation disabling that gate made both
direct-prepare and authenticated-HTTP regressions red; restoring the gate
returned them green. The root full run exits 0 with 3468 tests across 256
files, 3436 pass / 32 intentional skip / 0 fail, and 19082 expectations.

## Authenticated trusted presentation review workbench (2026-09-20)

`POST /api/compiler/presentation-workbench` gives an authenticated operator a
read-only construction plan for an existing trusted presentation review. The
operator supplies a catalog `preparedArtifactId`, its exact queue hash, and
exactly one of reviewed hints or an opaque continuation ID. Authentication and
operator authorization happen before request-body parsing, catalog access,
model use, or a write. The endpoint restores and re-resolves the canonical
artifact without persisting a review, bundle, or continuation and without a
model call.

The stable workbench response identifies the prepared and resolved artifacts
and contains slots with allowed binding kinds, exact-source candidates, and
their whole-statement versus nonempty-substring quote policy. Only an
authorized operator receives source prose. Candidate generation and final
trusted-projection validation share one authoritative rule plan: connection,
ending, and find-method statements are limited to accepted interpretation
provenance; fixed scene/clue/item/NPC heading and statement constraints remain
unchanged. Module metadata can be source-exact or opaque where permitted;
`triggerWarnings` remains opaque only.

The initial missing-route lifecycle test was 21 pass / 1 fail. A production
mutation that ignored the allowed statement IDs and admitted arbitrary prose
under a connection heading made the focused provenance regression 0 pass / 1
fail; restoration was green. The focused four-file run was 41 pass / 0 fail /
588 expectations. Typecheck exits 0. The authoritative full run exits 0:
3470 tests in 256 files, 3438 pass / 32 intentional skip / 0 fail, with 19325
expectations. This is a minimal operator workbench, not visibility/UI or
schema-migration work. It currently has no pagination or response-size budget:
a module metadata slot repeats all its eligible source candidates and can grow
with the source graph.

## Paginated trusted-presentation workbench (2026-09-20)

The preceding response-size limitation is now closed without broadening the
review or projection contract. `POST /api/compiler/presentation-workbench`
uses workbench schema `1.1.0`: its stable manifest lists only each required
`fieldPath`, allowed binding kinds, `sourceCandidateCount`, and a directly
bindable `opaque_unavailable` disclosure when available. It does not include
source candidate bindings, exact source text, quotes, or internal rule data.
An optional explicit `fieldPath` returns one server-owned fixed page of eight
direct-bindable `source_exact` candidates with exact text, quote policy,
`hasMore`, and an opaque `nextCursor`; `cursor` without `fieldPath`, unknown
request keys, and unknown fields fail closed. `opaque_unavailable` remains a
manifest capability and is not a repeated page candidate.

The cursor is transport integrity/continuity data, not an authorization
signature or a source of scope. It has a canonical base64url envelope bound to
the workbench schema, resolved artifact hash and full identity, requested
field path, page-aligned offset, and stable full candidate-order hash.
Malformed, foreign, stale, tampered, unknown-offset, or mismatched cursors
fail closed. Authentication and operator authorization still precede body and
catalog access. Every manifest or page request re-loads the catalog artifact,
canonically resolves it, and rebuilds the shared authoritative contract used
by `projectTrustedResolvedCompilerArtifact`; cursors never grant a broader
candidate domain.

The manifest counts eligible candidates without materializing their bindings
or source text. Only the requested page materializes its single field's exact
candidates; full statements and exact quotes are never silently truncated.
The existing prepare body limit remains the upper bound for source documents;
a single accepted statement/candidate can still be large and is not assigned a
new hidden response truncation rule here.

A real resolved fixture has twelve `module.title` candidates, crosses the
eight-candidate page boundary, and its page merge equals the authoritative
ordered candidates with no omission or duplication. Manifest and continuation
paths remain equivalent; no workbench request writes a review, bundle, or
continuation or calls a model. Paginated bindings are exercised through review
minting, resolve/publication, real `GameSession` action execution, and
generation advancement. Focused projection/HTTP/access verification is 32
pass / 0 fail / 610 expectations and typecheck exits 0. A real mutation that
ignored the cursor offset made the pagination regression 0 pass / 1 fail / 94
expectations; restoration was green. Root's authoritative full run exits 0:
3470 tests in 256 files, 3438 pass / 32 intentional skip / 0 fail, 19395
expectations.

This closes candidate response fan-out for the operator workbench. It does not
claim player/Keeper presentation visibility, a review UI or audit workflow,
schema migration, OCR or complex-PDF support, real-model acceptance, complete
IdP/rotation/audit, or rate/cost governance.

## Slot-manifest pagination for the trusted-presentation workbench (2026-09-20)

Schema `1.2.0` closes the remaining manifest-side response-growth path while
retaining the preceding `1.1.0` candidate-pagination contract as history. A
manifest-only `POST /api/compiler/presentation-workbench` now returns one
server-owned fixed slot page of sixteen compact slots, with `hasMore` and an
opaque next cursor when another page exists. It does not return a full manifest
or precompute source candidate counts for every rule. Each slot retains only
its `fieldPath`, allowed binding kinds, current-page `sourceCandidateCount`,
and allowed direct opaque disclosure; it still never contains candidate source
text or internal rule data.

An explicit `fieldPath` selects the mutually exclusive candidate-page mode.
That mode continues to return the fixed eight-item exact-source candidate page
for one field and does not return a slot page. The opaque cursor has an
explicit kind, so a slot cursor cannot be used for candidate paging and a
candidate cursor cannot be used for slot paging. Slot cursor integrity binds
the current schema, resolved artifact hash and complete resolved identity,
page-aligned slot offset, and the stable complete ordered field-path hash.
Malformed, foreign, stale, tampered, kind-mismatched, or unknown-offset cursor
input fails closed; cursors remain continuity data rather than authorization.

The compiler-layer authoritative contract now produces rules only. The slot
page builder slices rules first and counts source candidates only for that
page; the candidate-page builder still materializes exact bindings only for
its selected field. Every HTTP request authenticates and authorizes before
body or catalog work, restores the catalog artifact, canonically resolves it,
and rebuilds the same rule contract used by trusted projection. No workbench
request calls a model or writes a review, bundle, or continuation.

A real resolved fixture crosses the sixteen-slot boundary. Its HTTP page merge
equals the authoritative full field-path order exactly, without omissions or
duplicates, and the binding-to-mint-to-resolve-to-real-`GameSession` roundtrip
walks every slot page. The intentionally obsolete 1.1-shaped response first
failed at 0 pass / 1 fail / 2 expectations; the repaired target was 1 pass / 0
fail / 107 expectations. Restoring slot offset zero made the new regression
fail at 0 pass / 1 fail / 90 expectations, then restoration returned green.
Focused projection/HTTP/access verification is 32 pass / 0 fail / 650
expectations; typecheck exits 0. The authoritative full run exits 0 with 3470
tests in 256 files, 3438 pass / 32 intentional skip / 0 fail, and 19445
expectations.

This also closes manifest-slot fan-out. It does not claim player/Keeper
presentation visibility, a review UI or audit workflow, schema migration,
OCR or complex-PDF support, real-model acceptance, complete IdP/rotation/audit,
or rate/cost governance.

## Creator-bound durable compiled-session access (2026-09-20)

A compiled session is now bound at creation to the authenticated creator, not
to possession of a session ID. `CompiledSessionAccessBinding` is strict and
versioned: it stores only `ownerRole` (`operator` or `keeper`) and a SHA-256
fingerprint over that role and the normalized host principal ID. It never stores
or returns the raw principal ID, token, or authorization header. Snapshot schema
2.8 includes the binding in validation, canonical hashing, replay, restore, and
hydrate checks; every successor snapshot inherits it. Missing, malformed, or
unavailable bindings fail closed, so a legacy snapshot is not implicitly
authorized.

Every compiled `/api/sessions/:id/**` HTTP route authenticates and checks this
binding before request-body parsing, model work, action execution, or snapshot
write. Missing authentication returns 401, an unavailable/invalid runtime
binding returns 503, and a foreign role or fingerprint returns 403. Compiled
rows are omitted from anonymous and foreign session listings. An unavailable
compiled ID is deliberately indistinguishable from an unknown ID through the
ordinary HTTP lookup (generic 404); diagnostics remain a future authenticated
operator concern. The existing legacy-session HTTP behavior is unchanged.

Compiled WebSocket upgrades are intentionally unavailable. Refusal consults
live compiled sessions, durable snapshot occupancy including malformed or
incomplete snapshots, and compiled diagnostics, so eviction or failed hydration
cannot turn a known compiled ID into a legacy upgrade. Unknown and legacy IDs
keep their established behavior. Session IDs now use a CSPRNG by default as
defense in depth, but they are not authorization material. The in-process
`access: null` seam is test-only; HTTP treats it as unavailable with 503.

The access-control regression creates a real catalog bundle, creates a session
as its owner, verifies anonymous and foreign denial across read and mutation
routes, then hydrates a fresh durable instance for owner access. It also covers
generic summaries, history, state, suggestions, character, KP/export, ordinary
actions, compiled actions/intents, listings, and WebSocket refusal. Restoring
an owner-comparison bypass, dropping successor-binding inheritance, or restoring
query-role compiled-WebSocket access each made its regression red and was
restored. A separate deterministic durable-fixture test corrected an incidental
test-isolation defect: RNG contamination now lasts only for a synchronous
constructor callback, never across `await` or I/O; restoring the unsafe direct
constructor makes the test fail with an invalid character state, and restoration
is green.

The owner layer remains the fallback for all routes outside the narrow player
facade. It is a production access foundation, not completion of the
productionization goal. The default environment Bearer mapping identifies a
shared deployment capability rather than distinct humans; full IdP, rotation,
and per-person audit remain open. A snapshot hash is not a MAC and therefore
depends on storage file ACLs. Compiled WebSocket stays deliberately refused until
an authenticated protocol is specified and covered.

## Compiled P1 player facade (2026-09-20)

Snapshot schema 2.9 upgrades compiled access to version 2.0. At creator time a
host may supply a trusted resolver that associates one player principal with the
compiled session's `p1`; if it does not, or cannot resolve a valid player,
access falls back to the creator owner only. The default environment Bearer
authenticator intentionally cannot mint that player principal: a deployer must
inject the resolver/authenticator. The access binding is validated through
canonical hash, replay, restore, hydrate, and successor generations, so a
missing, malformed, or mismatched successor binding fails closed.

The player surface is deliberately only `GET /api/sessions/:id/player-view` and
`POST /api/sessions/:id/player-actions`. It supplies player-safe check and
archetype presentation and drives the real compiled combat facade; it does not
return raw check library-use data, archetype internals, or `mechanismId` values.
Submitted actions use opaque choices authenticated by HMAC and bound to the
authoritative generation, preventing forged, stale, and replayed submissions.
All old runtime routes remain owner-only, and compiled WebSocket remains
refused.

Focused final verification is 45 pass / 0 fail / 911 expectations. Mutations
that exposed raw check `library_use`, investigator archetype data, `mechanismId`,
an arbitrary player role, or a successor access mismatch each made its targeted
regression red before restoration. Root authoritative `bun test` exits 0 with
3483 tests in 258 files, 3451 pass / 32 intentional skip / 0 fail, and 19662
reported expectations; `bun run typecheck` exits 0. Expectation count is not a
stable repository baseline. The boundary remains single `p1` and
REST/polling, with generic labels only; it adds no IdP, invite flow, credential
rotation, audit trail, or authenticated WebSocket protocol.

### P2 player-browser delivery is a bounded deployment slice (2026-09-23)

The player delivery slice adds a separate browser entry rather than widening
the operator-facing client. An invitation stores and compares only a digest;
both invite and claim IDs come from a CSPRNG. A successful claim establishes a
session-bound `__Host-` `Secure`, `HttpOnly`, `SameSite=Strict` cookie, and a
repeat claim is idempotent. Delivery files are staged through a flushed
temporary file, hard-linked without replacement, then directory-fsynced; the
small 4 KiB sidecar follows the same durable boundary. This is a one-active-
writer design, not a distributed writer-coordination protocol.

The player request body is bounded cumulatively at 8 KiB for declared,
unknown, and underreported lengths, with cancellation once the limit is
crossed. Player responses are `no-store` and grant no CORS access. Same-origin
checking requires an explicit HTTPS `COMPILER_PUBLIC_ORIGIN` and does not trust
`X-Forwarded-*`; the configuration must therefore name the externally visible
origin. Compose supplies the operator, Keeper, delivery, public-origin, root,
and TTL defaults. The independent `PlayerApp` depends on `player-api`, not the
privileged `api.js` client, and retains polling/action retry behavior.

Acceptance evidence is deliberately concrete: the root-directed five-file
slice is 51 pass / 0 fail / 1049 expectations; `bun run typecheck` exits 0;
and frontend `bun run build` exits 0 with Vite 6.4.3, 31 modules, and an 8.24
kB PlayerApp chunk. The PlayerApp/index/helper dependency chain contains zero
forbidden markers. Three restored production mutations made their intended
checks red: disabling the cumulative stream limit made an unknown-length
oversized claim expect 413 but receive 400 (exit 1); restoring backend
`req.url` origin in the TLS-proxy positive path made its expected 204 become
404 (exit 1); and re-importing `api.js` into PlayerApp made the sealed-source
test find `frontend/src/api.js` (exit 1). The final authoritative repository
run is 3503 tests / 261 files, 3471 pass / 32 intentional skip / 0 fail / 19922
reported expectations.

This closes neither general productionization nor identity operations. IdP,
credential rotation, per-person audit, multi-player roles, rate/cost
governance, and authenticated WebSocket design remain open. The single active
writer restriction must be retained until a coordination design is specified,
and a real Docker TLS-proxy exercise remains a deployment acceptance task.

## Source disposition and reviewed player narrative (2026-09-23)

`SourceFactDispositionReport` now accounts for every root statement as exactly
one of `accepted_binding`, `explicitly_unbound`, `mechanics_evidence`,
`draft_candidate_open`, or `unmodeled`. The report is regenerated from the
canonical artifact and rejects tampering; its public form exposes aggregates
only. The representative real fixture has 16 pages, 136 statements, 130 roots,
22 scenes, 3 clues, 72 reward candidates, 32 NPC anchors, and 192 questions.
It is not content-ready: prepared readiness remains incomplete with 192 open
questions, 130 open roots, and one unmodeled root. The current root disposition
counts are 3 `mechanics_evidence`, 126 `draft_candidate_open`, and 1
`unmodeled`, with zero accepted or explicitly unbound roots. Mechanical closure
therefore cannot be used to hide open source slots or to claim arbitrary real
PDF content is complete.

Hints schema 1.9 makes source-only items explicit (`itemType: null`): they
produce no runtime item, MechanicsIR symbol, projection, or workbench slot, and
legacy null-shaped hints fail closed. Queue schema 1.7 gives an NPC answer an
exact `subjectStatementId`, so independently answerable paragraphs under one
heading cannot be conflated. Parallel connections preserve `connectionId`
through projection, reload, and tamper checks. Shared initial settlement and
initial terminal rewards fail closed; the automatic ending/reward chain is
covered. P4 now verifies concrete-state failure recovery and replays the
shortest reported-step witness.

Facade schema 1.1 is a separate, trusted player presentation boundary. Only a
durable canonical projection gated by `presentationReview` can yield the
current scene, discovered clues, or selected ending. Without that review it
returns no player narrative, and it never exposes identifiers, source evidence,
NPC data, or mechanism details. This is an implemented narrow slice, not
content completion, a general player/Keeper review workflow, or a production
identity model.

Authoritative verification for this state is `bun run typecheck` exit 0 and
full `bun test` exit 0: 3517 tests in 263 files, 3485 pass / 32 intentional
skip / 0 fail / 20146 expectations. The directed 13-file slice is 126 pass / 0
fail / 1601 expectations. Mutation evidence includes source readiness ignoring
open slots (2 pass / 1 fail), artifact same-snapshot removal (2 / 1),
show-all-clues (28 / 1), shared automatic settlement in a single step (0 / 1),
an initially red six-failure item contract, and parallel identity removal,
duplication, exchange, foreign, and direct forged-load cases.

The production boundary remains open: arbitrary real-PDF content readiness,
OCR and real-model end-to-end acceptance; IdP, credential rotation,
per-person audit, and rate/cost governance; multi-writer coordination and a
real Docker TLS-proxy drill; and broader combat, content, and multiplayer
coverage. This plan and the compiler productionization goal are not complete.

## Player natural-language intent facade and source-only model contract (2026-09-23)

The model adapter prompt now has two explicit item contracts. A runtime item
must name its runtime key/document/loot semantics and answer
`item_binding:<id>`; a source-only item must use `itemType: null` and answer
`item_binding:none:<id>`. Uncertainty is not permission to guess a runtime
type. The latter path answers the current schema-1.9 queue question but creates
no item binding, runtime item, MechanicsIR item symbol, projection, or
workbench slot. A real adapter-stub → `resolveCompiler` → projection test
proves that boundary; restoring the old prompt makes it red. The focused
source-only suite is 29 pass / 0 fail.

Authenticated `POST /api/sessions/:id/player-intents` is a narrow player-facade
route, not a general command interpreter. It requires the existing cookie,
same-origin, and trusted player resolver boundary; keeps the strict 8 KiB body
limit and no-store response; and classifies only. It has no regex fallback and
does not execute an action. Missing model support returns 503, invalid input
422, and no-match or ambiguous classifications return safe non-executing
results. Since classification may await, it rereads the action registry and
compares both generation and the internal catalog before selection. GameSession
maps a mechanism only to its current opaque choice; mechanism IDs, commands,
and internal state never enter the response.

PlayerApp sends natural-language input to this route. A selected result reuses
the established persistent actionId retry through player-actions; ambiguity
shows safe choices, 409 refreshes, and 422/503 are friendly errors. The app
does not import the owner API. A real mutation that added `mechanismId` to a
selected response made the leak regression red and was restored.

Verification is 28 pass / 0 fail / 654 expectations for player intents and 84
pass / 0 fail / 1385 expectations across the merged eight-file slice;
typecheck exits 0. Frontend build exits 0 (Vite 6.4.3, 31 modules, PlayerApp
JavaScript 10.76 kB, gzip 3.88 kB). The root authoritative full run exits 0:
3524 tests in 264 files, 3492 pass / 32 intentional skip / 0 fail / 20191
expectations. This is not real-model endpoint or API-network acceptance, and
it does not close arbitrary-PDF, OCR, real-model, IdP/rotation/audit/rate-cost,
multi-writer, Docker TLS, or broader combat/content/multiplayer work. The
productionization goal remains open.

## Source-to-runtime installation and source-disposition correction (2026-09-23)

This quality increment preserves the existing checkpoint scopes: Checkpoint I
is source facts through accepted mechanics and P4 semantics; Checkpoint II is
local artifact persistence and regeneration/restore; Checkpoint III is the
public prepare/resolve entry over its supported inputs. It adds no claim that
those scopes constitute arbitrary-document content completion, a general
runtime loader migration, or real-model acceptance.

Compiled projection direct load and restore now install atomically. Validation
and construction finish before the live instance is replaced, so a rejected
restore leaves its prior usable instance intact and the same instance can retry
after the failed input is corrected. This is deliberately stronger than merely
rejecting a bad payload: a failed restore must not poison the next direct load.
The automatic-orchestrator test fixtures were synchronized with the contract so
that this boundary is exercised against current fixture data rather than an
obsolete shape.

The source-disposition path now replaces the old permanent generic-discovery
dead end for `paragraph`/`list` facts. Queue 1.8, hints 2.0, and report 1.1
represent one `source_fact_disposition`: `source_only` intentionally creates no
runtime material, while `mechanics_candidate` remains structured pending work
and therefore contributes to incomplete readiness until separately accepted.
This correction preserves the existing source-only promise; it does not infer a
runtime mechanic from prose merely to make a queue look closed.

Test fixtures are isolated from operator data. Career tests set a temporary
`__CAREER_DIR`; the existing approximately 245112 historical directories under
`data/careers` were not deleted, interpreted as a fixture, or used as a cleanup
result. The lifecycle helper was moved out of a `.test` import, player-intent
focused coverage was narrowed from a misleading 28-test aggregate to its real
four-test target, and catalog rebinding coverage kept its assertions while
falling from about 4.53 s to about 0.98 s.

The current Fuzu prepared artifact is an old graph-schema 1.0 artifact that the
current validator rejects. Accordingly, no current-real-PDF rerun is claimed
here. The retained read-only historical artifact recorded 77 questions,
including 22 generic questions; the current synthetic contract is a one-to-one
replacement for that behavior, not evidence that the present validator has
accepted the old real artifact. This corrects, rather than overwrites, the
earlier real-source acceptance record.

Root's authoritative verification is `bun run typecheck` exit 0 and full
`bun test` exit 0: 3529 tests in 266 files, 3497 pass / 32 intentional skip /
0 fail / 20204 expectations in 73.52 s. That is +5 tests and +2 files over the
3524/264/3492/32 baseline. The directed affected regression is 231 tests in 17
files, exit 0; the repair-point regression is 17 tests in 3 files, exit 0.
The frontend build ran outside the sandbox and exited 0 (Vite 6.4.3, 31
modules). These results do not close the old-artifact incompatibility, arbitrary
real-PDF/OCR/real-model acceptance, IdP/rotation/audit/rate-cost work,
multi-writer coordination, Docker TLS acceptance, or broader content/combat/
multiplayer coverage; the productionization goal remains open.

## Correction: real Fuzu read-to-compile-to-runtime quality (2026-09-23)

The preceding old-schema statement is historical correction context, not the
current real-source state. The real Fuzu PDF was re-run from SHA-256
a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5
(16 pages). Its prepared source records 22 scenes, 3 clues, 3 items, 32 NPC
anchors, 72 reward candidates, and a fully answered 192/192 queue.

The accepted mechanics are mechanically closed: 4 playable scenes, 3
connections, 3 discovery methods, and 2 reachable endings. The closed-world
report has zero issues in each of its four reported issue categories. Two
witnesses replay, the restored artifact has the same canonical hash, and two
independent GameSession runs respectively reach lost_without_dream_stone and
escape_with_dream_stone.

Aggregate source-quality is deliberately separate from readiness. Across 130
roots it reports 22 mechanics_evidence, 0 accepted_binding, 108
explicitly_unbound, and 0 open/unmodeled roots. Coverage is 22→4 scenes, 3→3
clues, 3→0 items, 32→0 NPC anchors, 72→0 rewards, and 2→2 endings. This proves
a mechanically closed narrow path while making the remaining content width
visible; it is not production content completion.

The operator workbench and final resolve expose only this aggregate quality
view. It is neither a readiness value nor a publication gate, and it exposes
no IDs, source prose, evidence, or witnesses. todo-64 therefore remains open.

The final complete preflight exits 0: 3533 tests in 266 files, 3501 pass / 32
intentional skip / 0 fail; typecheck exits 0; unwired is 82; and
core.hooksPath passes. A red regression for the DeepSeek-only llmEnabled
omission was fixed. No external model was called for this verification.

The real source-disposition mutation evidence is equally specific: temporarily
returning itemCandidates from boundItems made compiler-source-fact-disposition
exit 1 at 5 pass / 1 fail (expected 0, received 1). Precise restoration exits
0 at 6 pass / 0 fail / 76 assertions, with no mutation residue.

## Ordinary GameSession intent-client boundary (2026-09-23)

This is a runtime isolation correction within the existing scopes, not a change
to Checkpoints I, II, or III. An ordinary GameSession now owns a fixed
LLMClient-or-null and calls parseIntentWithLLM; global parseIntent remains for
CLI compatibility. Compiled intent remains the separate allowlist
classification API. declareIntentPath reports the session client, and the
existing DeepSeek environment gate continues to be covered.

The old global selection made a second session use the first endpoint and let a
new disabled session fetch after an enabled session had run (new regression:
0 pass / 2 fail). Reverting act to global parseIntent made the mutation test
1 pass / 1 fail, then exact restoration returned 2/2. The first complete run
also surfaced a stale look-gate fake that depended on the global client:
3535 tests / 267 files, 3502 pass / 32 skip / 1 fail. Moving every fake to the
session helper while deliberately setting the global client to contrary help
made a helper-global-only mutation fail 7 pass / 1 fail; restoration returned
the focused suite to 14/14.

Root independently verified 25 pass / 5 files / 0 fail for the focused slice
and 143 pass / 9 files / 0 fail for the intent collection. Typecheck exits 0;
the final full run exits 0 with 3535 tests / 267 files, 3503 pass / 32
intentional skip / 0 fail / 20311 expectations in 73.73 seconds. Fetch was
intercepted, so no external model or network was called. At that point,
narrator/player-agent first-wins globals and the LLMClient static breaker were
separate runtime risks; the subsequent runtime-isolation increment below
supersedes that current-risk statement.

## Run-bound generative context and endpoint-scoped breaker (2026-09-23)

The runtime now treats generative context as owned by its execution boundary.
GameSession narration keeps its own LLMClient-or-null and does not mutate the
narrator or player-agent globals. PlayerAgent accepts an instance client:
explicit null is an offline contract, while undefined retains the legacy global
compatibility path. A play-module invocation creates one client through
RunOptions/RunContext and shares it across background, prologue, NPC, player,
and combat narration. Its normal configuration loading path, including the
DeepSeek-only configuration, is preserved; explicit null keeps the whole run
offline.

The LLM breaker is now keyed only by normalized endpoint base URL, never by an
API key. chat and chatStream therefore share breaker state for one endpoint but
not for different endpoints. Half-open recovery admits one probe at a time, and
success/reset removes state. Timeout, non-2xx HTTP, and empty responses release
the probe so recovery cannot become permanently wedged.

This is a runtime isolation and resilience increment, not a content-completion
claim. Red-first and restoration evidence covers disabled-session fetches,
contradictory global versus instance clients, GameSession global contamination,
and endpoint breaker key/probe mutations. The directed merged verification was
110 tests in 12 files with 0 failures and 300 expectations; typecheck exited
0. No external model call was made: tests use intercepted fetch or a local
127.0.0.1 seam. Content breadth, real complex-PDF plus real-model acceptance,
IdP, rate/cost governance, multi-writer coordination, and the other production
boundaries remain open.

## Process-local automatic-compiler admission (2026-09-23)

The catalog-only automatic mechanics route now has a bounded in-process
admission boundary before it may call an LLMLike dependency. After host
authentication, request-shape and capability checks, catalog restoration,
prepared-queue hash comparison, and continuation identity/validation succeed,
it acquires a server-owned lease. Invalid requests consequently do not consume
a model start. The controller retains only a SHA-256 principal fingerprint and
a hash of the prepared-artifact resource, never a raw principal or credential.

The production server owns one controller for its process: at most two runs are
concurrent globally, one is concurrent per principal, each principal may start
four runs in a 60-second sliding window, and one prepared artifact is
single-flight across principals. Tracking is capped at 1024 principals; expired
inactive state is evicted and capacity exhaustion fails closed. A busy or
rate-limited request receives 429 with a stable admission code and an integer
Retry-After. The lease is released idempotently in finally, covering model
orchestration and continuation persistence as well as normal responses.

This is an HTTP production-hardening increment, not a revision to Checkpoints
I, II, or III and not distributed coordination. It supplies neither a
cross-process lock nor a rate/cost budget, IdP, per-person audit, multi-writer
protocol, real-model acceptance, or a production-complete claim. Those remain
separate open milestones.

### Acceptance tailnote

Final preflight caught one avoidable public seam before accepting this
increment: `CompilerAutoAdmissionController.cleanup()` had no caller and moved
the unwired count from 82 to 83. The baseline was not raised. Its behavior was
already provided by lazy cleanup during acquire, so removing the public method
restored the focused admission verification to 9 tests in 2 files with 0
failures and 47 expectations, typecheck to 0, and probe-unwired to 82. The
authorized final preflight then exited 0: 200 boolean implementations, 0
discarded returns, documentation checks and typecheck passing, the
3561/270/3529/32 test baseline matching, unwired=82, and
core.hooksPath=.githooks. This acceptance result does not expand the
single-process boundary above or close its listed production gaps.

## Aggregate source-to-runtime breadth acceptance (2026-09-23)

The current productionization evidence adds one independent aggregate
acceptance, without revising Checkpoints I, II, or III. One curated synthetic
source flows through `prepareCompiler`, its actual draft and queue IDs,
current-schema human-reviewed hints, `resolveCompiler`, runtime-quality
summary, projection, and `GameSession`; no graph, draft, IR, or next-layer
input is hand-forged.

That source generates six scene candidates, two marked clues, two item
candidates, five prose-NPC anchors, three heading-scoped reward candidates,
and 33 questions. All 33 answers are explicit. Quality reports content
readiness complete with zero open questions, open roots, and unmodeled roots;
it has both accepted bindings and explicitly unbound roots. Runtime coverage is
four playable scenes, two compiled clues, one bound/runtime item, one bound NPC
anchor/NPC/dialogue method, one bound/runtime reward, and one reachable ending,
with zero entries in each closed-world issue category. The GameSession path
actually talks to Mira for a clue, acquires the Moon Key, traverses three
connections, then reaches a terminal reward and has no remaining action.

Non-target candidates are not erased: the other item and rewards are explicit
source-only null bindings and non-target NPC anchors are explicitly empty. The
existing production combination was directly green, so this adds missing
aggregate evidence rather than inventing a shared production defect. A real
`acquire_item` mutation made owned-item verification fail; removing the actual
source-bound terminal reward-catalog write made reward settlement verification
fail; both were exactly restored. An attempted legacy `reward` effect mutation
had no distinction because it is not the current runtime path, and is recorded
as such rather than counted as red-first evidence.

This remains curated synthetic structure plus human hints, not arbitrary-PDF
or automatic-model content coverage. The Fuzu numbers scenes 22→4, clues 3→3,
items 3→0, NPC anchors 32→0, rewards 72→0, and endings 2→2 are historical
acceptance measurements, not a current replay. The local prepared artifact now
returns `refused` at `parse` with
`ARTIFACT_COMPONENT_VERSION_MISMATCH` from `restoreCompilerArtifact`; the
original PDF is not present under `C:\aitrpg`, so it cannot be re-prepared from
the same source. A saved output that cannot restore under the current schema is
not current acceptance evidence, and reconstructing a graph cannot stand in
for the original PDF. Current-version real-PDF acceptance therefore remains
open, alongside complex PDF/OCR and real-model acceptance, broader content
width, rate/cost operations, identity/audit, and multi-writer coordination;
todo-64 stays open.

Root-authoritative verification is 23 directed tests in seven files, 0 fail,
and 369 expectations; typecheck exits 0. The full run exits 0: 3562 tests in
271 files, 3530 pass / 32 intentional skip / 0 fail / 20457 expectations in
73.80 seconds, a +1 test / +1 file / +1 pass increment over 3561/270/3529/32.

## Automatic aggregate proposal/continuation acceptance (2026-09-23)

This adds a second aggregate acceptance without changing the definitions of
Checkpoints I, II, or III. A distinct curated synthetic source first goes
through `prepareCompiler`; the test reads the actual draft and queue IDs rather
than manufacturing a graph, draft, IR, or later-stage input. It produces five
scene candidates, two marked clues, two item candidates, one prose-NPC anchor,
three heading-scoped table-row reward candidates, and 23 questions.

The automatic path is the real catalog-backed HTTP route and bounded
orchestrator/adapter, with deterministic FakeLLM only. Server-owned production
caps make the first round answer the 22 non-NPC questions in eight calls; after
the accepted playable scene role enables it, the second round asks and answers
the one NPC binding in one call. Every accepted answer carries
`approved_policy` review status and trusted producer provenance. The NPC is
only the source-exact static Mira binding with `dialogueMethods: []`: dialogue,
encounter, SAN, and presentation remain human-review boundaries.

The private canonical resolution has complete source disposition (zero open
questions, roots, and unmodeled roots), four playable scenes, two compiled
clues, one runtime item, one static NPC with zero dialogue methods, one runtime
reward, one reachable ending, and zero closed-world issues. Replaying the
closed opaque continuation makes zero model calls. The public HTTP result stays
`presentation_draft_only` with `visibility_unresolved`, makes no projection or
bundle write, and excludes source prose, hints, raw model reply, and audit
quotes. It is not a public publishing mechanism.

The test's real production mutations prove connected seams: constraining the
item-binding filter to `document` returned draft-only with
`unbound_item_reference`; forcing stored reward declarations to null caused
`reward_catalog_mismatch`; and temporarily returning private hints exposed the
source/audit leak. Each was restored. A raw-reply sentinel additionally proves
the response does not echo the model's original text.

This is still curated synthetic structure plus deterministic fake-model
evidence, not arbitrary PDF, real-model, automatic-presentation, or
production-completion acceptance. The current-version real-PDF boundary and
the broader rate/cost, identity/audit, and multi-writer work remain open in
todo-64. Root-authoritative full verification exits 0: 3563 tests in 272
files, 3531 pass / 32 intentional skip / 0 fail / 20500 expectations in
74.44 seconds, a +1 test / +1 file / +1 pass increment over 3562/271/3530/32.

## Historical current-schema Fuzu exact-source acceptance snapshot (2026-09-24; superseded)

The earlier historical wording that the Fuzu source PDF was absent and that
current-version acceptance was open is now obsolete. It is retained above as
history of the then-available local evidence, not as the current status. The
exact original is now present at
`C:\aitrpg\[kp进阶推荐模组]复足.pdf`: 1,751,612 bytes, 16 pages, and
SHA-256 `a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5`.

An internal, non-default acceptance script explicitly receives that PDF path,
checks its bytes/header/hash, and uses the authenticated public PDF prepare
route, catalog load, and current-schema restore. The historical saved prepared
artifact still refuses with `ARTIFACT_COMPONENT_VERSION_MISMATCH`; it is not
migrated or used as a production fallback. Instead, its 50 explicit
human/user-document benchmark values are re-reviewed and strictly rebound to
unique current questions. Current resolve has 50 answered and 142 open
questions: it is mechanically closed for its bounded witness paths but remains
content-incomplete. Its measured breadth is scenes 22→4, clues 3→3, items
3→0, NPC anchors 32→0, rewards 72→0, and endings 2→2. Both ending witnesses
replay, and separate GameSessions execute their actual 4- and 3-action paths.

The HTTP body contract is likewise current evidence: JSON/general bodies stay
at 1 MiB while only application/pdf compiler prepare is server-owned at 8 MiB;
oversized PDF input is rejected before compiler/catalog work. This remains an
exact-source, internal acceptance—not an arbitrary-PDF, OCR, real-model,
automatic presentation/publication, distributed, rate/cost, identity/audit,
multi-writer, or production-complete claim. Todo-64 therefore remains open.
The authoritative full run exits 0: 3566 tests in 273 files, 3534 pass / 32
intentional skip / 0 fail / 20484 expectations in 74.26 seconds; typecheck
exits 0.

## Historical current-schema Fuzu bounded automatic continuation (2026-09-24; superseded)

The exact-source internal acceptance now continues the same authenticated
catalog artifact through the public `POST /api/compiler/auto-resolve` route.
It carries the strictly rebound 50 human answers only on the first request,
then presents only the previous opaque continuation ID and the same prepared
queue hash. A deterministic server-owned FakeLLM answers only the actual
request envelopes and declared candidate domains. Under the production caps
(three questions per request, eight requests per round, two rounds), three
HTTP continuation requests and 48 FakeLLM calls make the private continuation
192/192 answered with zero open questions, roots, or unmodeled roots.

This exposed one production eligibility defect rather than a test-only gap.
The old automatic NPC filter asked only anchors under an already-playable
heading, so 27 Fuzu non-playable anchors could never receive their explicit
empty binding. Eligibility is now deliberately three-state: missing, invalid,
or unanswered scene roles stay ineligible; playable roles permit a static
binding or empty result; answered non-playable roles permit only
`presentNpcs: []`. The accepted-proposal boundary rejects any non-empty NPC
binding for the latter with `npc_binding_requires_playable_scene`; dialogue,
encounter, SAN, and presentation remain human-review-only.

Every automatic public response remains aggregate-only
`presentation_draft_only` / `visibility_unresolved`; it contains no hints,
raw reply, audit material, graph, artifact, projection, bundle, source prose,
or continuation token. The acceptance itself constructs one HTTP dependency
object and one process-local admission controller for all three requests, and
checks their identity rather than simulating each request with a fresh
controller. Its source-prose assertion scans every non-empty meaningful
prepared-graph statement (with a length threshold to avoid generic short
fragments), not one sentinel.

The final source disposition is content-complete, but its scope is not broad:
coverage remains scenes 22→4, clues 3→3, items 3→0, NPC anchors 32→0, rewards
72→0, and endings 2→2; the two GameSession ending paths remain 4 and 3 actual
actions. Content completion here means every source root has an explicit
disposition, not that the source has production content breadth, that arbitrary
PDFs or real models are accepted, or that automatic work may publish
presentation. Checkpoints I, II, and III are unchanged, and todo-64 remains
open for those wider boundaries.

Real restoration mutations make the linked checks distinguishable: old NPC
filter 13 pass / 1 fail / 156 expectations; removed positive-NPC guard 13 pass
/ 1 fail / 160 expectations; stopped continuation, public-hints leak, and
per-request dependency/controller construction each exit 1 (the last reports
expected 1, received 3). Exact restoration returns the exact-PDF script to
exit 0. Root-authoritative verification is 53 directed tests in five files,
0 failures, and 844 expectations; typecheck exits 0; full `bun test` exits 0:
3566 tests / 273 files, 3534 pass / 32 intentional skip / 0 fail / 20544
expectations in 74.07 seconds. Test/file/pass/skip baseline counts do not
change in this strengthening.

## Correction: reward-candidate precision on the exact Fuzu source (2026-09-24)

The earlier Fuzu references to 72 rewards describe the old, over-generalized
candidate rule and remain as historical evidence, not a current reward count.
The current source-derived, fail-closed rule prepares zero reward candidates:
a scoped table row must contain positive settlement evidence for only the
supported SAN recovery, fixed Cthulhu Mythos, or fixed reputation domain before
it may enter the existing reviewed `reward_binding` path. Stat, HP, attack,
loss, percent, slash-mixed, unrelated, and unscoped rows do not qualify.

All 72 Fuzu table rows now retain the existing `source_fact_disposition` root
contract instead. This preserves the 192-question queue rather than making the
benchmark a manual-review gate; the exact continuation still uses three HTTP
requests and 47 deterministic FakeLLM calls, and has zero runtime rewards. The
change improves type/source audit precision, not content breadth or model cost.
It does not complete cross-heading entity or encounter extraction, acceptance
of real complex PDFs or real models, automatic publication, or todo-64's
general production goal.

## Reward predicate target domains make reward proposals answerable without guessed IDs (2026-09-24)

`reward_binding` was already limited to the MechanicsIR reward predicate DSL,
but an automatic proposer previously received only the reward subject. A real
model therefore had to guess any `scene_visited`, `clue_found`, or `item_owned`
identifier. Queue schema 1.9 closes that request-contract hole by serializing
the stable same-draft `allowedRewardPredicateIds` partition for `scene`,
`clue`, and `item` on every reward question. Request-envelope schema 1.2
preserves that partition, includes its trusted typed candidates in the catalog,
and retains them when requests are chunked.

The shared hint-value parser still delegates the grammar to MechanicsIR; it
does not fork a reward DSL. After parsing, it recursively checks each permitted
predicate leaf, including leaves nested under `all`, `any`, and `not`, against
the corresponding queue domain. Forged or cross-domain IDs are rejected at the
parser and grounded-proposal boundary before later MechanicsIR compilation.
Unsupported predicate kinds remain MechanicsIR rejections. An explicit
`declaration: null` remains a source-only choice and does not require a
predicate target.

The request prompt now names these domains and the `item_binding`/
`reward_binding` citation keys. An emitted-envelope-only deterministic FakeLLM
constructs the positive reward proposal and exact row citation solely from the
actual request and trusted catalog, then passes the shared parser/audit. The
real mutation that removed the recursive domain walk made the target regression
red (14 pass / 1 fail / 82 expectations); exact restoration ended at 52 pass /
0 fail / 5 files / 511 expectations. The updated root baseline is 3576 tests /
273 files / 3544 pass / 32 intentional skip / 0 fail / 20620 expectations, and
typecheck exits 0.

The preceding Fuzu figures are a historical pre-item-evidence snapshot. The
current exact acceptance is recorded below; the opaque-ID contract remains
closed, but that does not establish content breadth, arbitrary-PDF or real-model
acceptance, automatic publication, or production completion.

## Current Fuzu item-name evidence and ordinary intent validation (2026-09-24)

Canonical runtime item bindings now require evidence rather than a guessed
display name. Queue schema 2.0, hints schema 2.1, and proposal-request schema
1.3 carry candidate-local `itemNameEvidence`: the exact marked item name and
body supplied by the item candidate itself. A positive `item_binding` must carry
that evidence; `declaration: null` must not carry it. The shared value contract,
parser/audit, accepted claim, resolved binding, canonical artifact regeneration,
projection/source map, and runtime display all retain the same value. The
canonical item question uses its own sources, so a malformed clue cannot lend or
contaminate the item's evidence.

The exact Fuzu prepare is now 22 scene candidates, 3 clues, 3 item candidates,
32 NPC anchors, 0 reward candidates, and 192 questions. The historical 50
answers plus two current human source reviews produce 52 answered / 140 open;
three bounded continuation requests and 47 deterministic FakeLLM calls then
produce 192 answered. Resolution is mechanically closed and content-complete in
the disposition sense, with 4 scenes, 3 clues and discoveries, one loot item
displayed as 梦境之石, one static narrative_noncombat NPC, zero
dialogue/encounter/reward, and 2 endings. The
two GameSession paths take 4 and 3 actions and distinguish ownership of that
item. Earlier 3→0-item and 48-call figures are retained only as historical
pre-item-evidence observations, not current Fuzu output.

That single NPC is 兰迪.帕蒂拉, bound only from the 中庭 same-heading scope and
its exact evidence. It remains static and narrative_noncombat: there is no talk
or combat surface. Source-map, projection, and GameSession paths accept the
binding. A real mutation to `presentNpcs: []` makes exact acceptance exit 1
with `expected boundNpcAnchors 1, received 0`; restoring it makes the exact
script exit 0. Root's rerun is 26 pass / 0 fail / 269 expectations and
typecheck 0, without changing the 3586/273/3554/32 baseline.

Item regressions first failed at the queue domain, after structural name-evidence
restoration, after removal of the exact-substring check, and after restoration of
shared clue sources; each was restored. The ordinary GameSession intent API now
accepts only model replies whose action is allowlisted and whose exact keys,
types, enums, and numeric values are safe. It preserves `spell`, `luckSpend`,
`weaponName`, `calledShot`, and `item`; invalid replies warn and use the existing
regex fallback. The session mock proves luck 10→7. This does not alter the
compiled-intent contract or execution authority.

Final verification: compiler 84 pass / 0 fail / 6 files / 616 expectations;
ordinary intent 127 pass / 0 fail / 9 files / 321 expectations; typecheck 0;
root final full run 3586 tests / 273 files / 3554 pass / 32 skip / 0 fail /
20644 expectations in 75.24s. Final `bun scripts/preflight.ts` exits 0: 205 boolean implementations / 0 discarded returns, typecheck 0, 3586/273 tests/files and unwired 82 match baseline, and `core.hooksPath=.githooks`. Expectations are recorded evidence, not a threshold. The first combined compiler run was 231 tests
with two fixed compatibility failures (the old Fake item shape and a
current-schema hardcode). The 9-file intent combination later had one 119/1
snapshot-completeness flake before returning 127/0. The pre-slice 3576 full run
was green; the first post-implementation full run was 3585 tests / 3551 pass /
32 skip / 2 fail; after repairing that canonical-item defect and adding one
regression, the final 3586 run is green. The flake remains a non-stable
isolation signal, not an explained root cause. Human source review,
deterministic FakeLLM, and one exact PDF do
not prove arbitrary-PDF, real-model, automatic-content, generic-app compiled
bearer, or production completion. Todo-64 is open.

## Human-reviewed prose dialogue clue closure (2026-09-24)

This slice adds a narrowly bounded source-to-runtime capability, rather than a
new automatic content path. A human-reviewed NPC binding may derive one or more
prose dialogue clues only from `relationshipEvidence` that is an exact,
non-name substring of that NPC anchor paragraph. The compiler derives the clue
ID from document identity, NPC anchor/identity, and that evidence; the caller
does not supply a clue ID, location, target, or a success effect. The sole
derived effect is `discover_clue`. Prose dialogue cannot acquire an item and
cannot declare `onFailure` or `failback`, so it cannot use a dialogue-looking
answer to inject state-changing failure mechanics.

The contract reaches accepted interpretations, MechanicsIR symbols and
mechanisms, projection and source map, artifact canonical replay, runtime
quality, GameSession, and durable restart. Its exact quote is verified at every
source-bound boundary. Automatic proposals continue to reject dialogue and
encounters; this is human review of source evidence, not automatic dialogue
generation or generative NPC chat.

The capability table is now explicit: null/source-only item binding requires
hints 1.9+, source-fact disposition 2.0+, positive source-exact item-name
evidence 2.1+, explicit `dialogueMethods` (including an empty declaration)
1.7+, and prose-only relationship-evidence dialogue 2.2+. Proposal requests
are schema 1.4; the queue is 2.1 and hints are 2.2. An audit found and repaired
two real failures: deciding support by `schemaVersion !== current` rejected
otherwise supported historical capability versions, and a prose-looking method
could retain a failure branch. Restoring those defects makes their target suites
red at 14 pass / 1 fail and 5 pass / 1 fail respectively. Removing the exact
relationship-quote check also turns the negative regression red; all three
restorations are green.

The exact Fuzu acceptance intentionally does not claim dialogue breadth. Randy
is still the one static NPC in the courtyard, but entering that scene takes the
terminal-first path immediately; there is no executable talk window. The
acceptance therefore remains 52 answered / 140 open followed by three bounded
requests and 47 deterministic FakeLLM calls to 192 answered / 0 open; runtime
is 4 scenes, 3 structural clues, 0 prose dialogue clues, 3 discoveries, 1 item,
1 static NPC, 0 dialogue/encounter/reward, and 2 endings. No ending or automatic
ordering was changed to manufacture a dialogue demonstration, and a
relationship proposition is not conflated with an unrelated location-plus-item
acquisition clue.

Root verification is 101 pass / 0 fail / 12 files / 882 expectations, typecheck
exit 0, and full `bun test` exit 0: 3593 tests / 274 files / 3561 pass / 32 skip
/ 0 fail / 20724 expectations in 76.16s. The baseline changes by +7 tests and
+1 file. Final `bun scripts/preflight.ts` exits 0: generated-document reference
checks pass, 206 boolean implementations have 0 discarded returns, typecheck
0, tests/files 3593/274 and unwired 82 match the baseline, and
`core.hooksPath=.githooks`. This closes only
the bounded reviewed prose-dialogue contract. Automatic content breadth,
arbitrary PDFs, real-model acceptance, publication, generic compiled bearer,
and todo-64's productionization goal remain open.

## Current ordinary Session owner-auth closure (2026-09-24)

The preceding references to ordinary-action owner authentication as open are a
historical pre-slice statement, not the current state. This slice closes the
ordinary Session owner-auth boundary while leaving todo-64 **open** for its
wider productionization work.

Each ordinary session now has an independent, versioned schema-1.0 owner
binding containing only a host-principal fingerprint. Raw host IDs, Bearer
tokens, and cookies are never persisted. Only operator and Keeper principals
can create an ordinary session; a player cannot. The durable metadata and live
binding are two required pieces of evidence and must agree: missing, old, or
tampered binding evidence fails closed. Stored lists are filtered by that owner
fingerprint. This is ownership enforcement, not ordinary-session restart
hydration: a process restart still does not promise a complete `GameSession`
restore.

Authentication precedes every observable locator or work boundary: `POST
/api/sessions` authenticates before body parsing, factory construction, or
opening; `GET /api/sessions` authenticates before enumeration; and every
host-owner `/:id` route authenticates before registry lookup. Foreign and
unknown session IDs consequently have the same opaque response. Rejected
actions pull zero body bytes and make no side effect. In `required` and
`prohibited` modes the legacy ordinary WebSocket surface is closed for every
locator. `required` is the default; only the exact
`ORDINARY_SESSION_AUTH_MODE=development_anonymous` outside production enables
the temporary anonymous compatibility path.

Creation receives `SessionRuntimeDependencies`, so focused tests use a private
registry and offline factory while the compiled create/list/runtime seams use
the same dependency ownership. IDs are CSPRNG UUIDs with bounded collision
checks against registry, metadata, and career roots. The service writes and
verifies metadata before publishing the live session; a controlled failure is a
safe 503 and rolls back exactly the newly created career directory.

The red-first evidence caught real boundary mistakes: the prior implementation
returned GET/action 200 to anonymous, wrong, foreign operator/Keeper, player,
and fake-cookie callers, and an anonymous action pulled one body; a mutating
owner comparison turned foreign 404 into 200; moving authentication after body
changed a rejected pull count from 0 to 1; and a missing-binding fallback
turned a closed 404 into 200. Legacy locator behavior (anonymous existing 401,
unknown 404) and a required unknown WebSocket returning `null` were likewise
restored to the closed contract. Initial tests accidentally consulted real
configuration, attempted an external endpoint, and contaminated the breaker;
the offline factory eliminates that coupling and the final logs contain no
endpoint attempt.

Root-focused verification is 31 pass / 0 fail / 7 files / 485 expectations;
the ordinary suite is 8 / 0 / 67; reviewer core coverage is 18 / 0 / 3 files /
370 expectations; and typecheck exits 0. Root's final full run exits 0 with
3601 tests in 275 files, 3569 pass, 32 skip, 0 fail, and 20775 expectations in
76.10 seconds. The baseline changes from 3593/274/3561/32 by +8 tests, +1
file, and +8 pass. Final `bun scripts/preflight.ts` exits 0: 209 boolean
implementations / 0 discarded returns, generated-document references pass,
typecheck 0, tests/files 3601/275 match, `unwiredMethods` 82 matches, and
`core.hooksPath=.githooks`.

Still open are host IdP/token registry/rotation/per-person audit, multi-writer
and file locking, an authenticated ordinary WebSocket replacement, ordinary
full restart hydrate, cross-file crash consistency, arbitrary-PDF and real-model
acceptance, content breadth, and automatic publication. A shared environment
Bearer is only a single service account, never a per-person IdP.

## Ordinary HTTP intent productionization increment (2026-09-24)

This is a runtime-boundary increment alongside the compiler work, not a claim
that arbitrary PDF ingestion, product delivery, or the overall compiler
production goal is complete. Ordinary HTTP actions are API-required by default;
only exact non-production `development_fallback` retains compatibility regex.
The server classifies before session mutation, accepts only strict allowlisted
ActionIntent values, and reports provider unavailability as 503 or invalid
model output as 422 without exposing raw model/provider content.

The increment also records session-owned exact local-command admission,
per-session FIFO action and HTTP transaction serialization, endpoint-plus-
workload breaker isolation, an end-to-end 15-second/128-token/one-attempt
intent budget, and 8 KiB/1000-code-point ordinary action input bounds. Those
are deployment/runtime safeguards; they do not expand compiler source coverage,
authorize an identity provider, enable ordinary WebSocket access, prove real
model behavior, or replace the remaining multi-writer, restart, audit, and
publication work tracked by todo-64.

## Source-fact scene-state transition closure (2026-09-24)

Queue and hints schema 3.1, proposal-request schema 1.7, and source-fact
disposition report 2.1 add one bounded `source_fact_mechanic` form:
`scene_state_transition`. A declaration belongs to its actual child question
and same-heading scope. It may trigger on `scene_enter`, or on `clue_found`
with a same-heading prerequisite, and its only public state-changing result is
to discover one canonical same-heading clue. Declaration, trigger,
prerequisite, and discovery atoms use root-exact citations; a heading proves
scope but cannot substitute for source evidence.

The compiler, not the caller or model, derives the mechanism and
interpretation identities and a declaration-private `source_state_*` sentinel.
It also constructs the fixed predicate/effect AST: current-scene scope, the
optional found-clue prerequisite, output-not-yet-found and sentinel guards,
followed by `discover_clue` and the private sentinel write. Callers cannot
supply runtime IDs, a state key, location, effects, or Predicate/Effect AST.
The resulting transition uses the existing MechanicsIR parser, validator,
automatic fixed-point execution, artifact replay, and closed-world analysis;
there is no second execution language.

Different legal discovery methods for the same clue remain alternatives and
may coexist, including an existing explicit discovery plus a transition. Only
a repeated declaration key or the same normalized transition slot is a
duplicate. A transition bound to the clue at its true heading location
substitutes that clue/location's default observation policy with a non-empty
audit; it cannot suppress an observation policy at another location. Report
2.1 accounts the actual accepted transition interpretation as mechanics
evidence without marking its heading merely because an identifier shares a
prefix.

External automatic proposals remain conservative by default: their declared
capability contains only `existing_clue_discovery`. A server-trusted policy
must explicitly opt in to `scene_state_transition`; only then does request 1.7
publish the exact declaration wire, and the grounded compiler enforces that
same allowlist. Human/current-schema hints may use the capability directly.
Hints 3.0 continue to accept their existing discovery form but reject a
transition; 3.1 is the first transition-capable version.

The exact Fuzu document is intentionally a negative control. Its two real
source-fact roots remain `source_only`: the prose describes visible approach
context while the canonical clue bodies include gated search, medical, or
skill-check detail, so turning either root into an automatic transition would
overclaim the source. No positive transition was manufactured for the
benchmark. The current exact run has 194 questions, 192 answered plus 2
not-applicable child questions, and 47 deterministic FakeLLM calls. Its
runtime remains narrow rather than newly broad: 4 scenes, 3 clues/discoveries,
1 item, 1 static NPC, no dialogue/encounter/reward, and 2 endings.

Three implementation mutations made the contract observably red before exact
restoration: removing the generated output-not-found transition guard (the
private sentinel stayed intact), restoring prefix-based disposition skipping
that polluted heading coverage, and removing the grounded trusted-policy gate
for external transitions. Restored directed evidence is 51 pass / 0 fail for
the focused slice, 207 / 0 for the wider compiler slice, and 57 / 0 for the
HTTP slice.
The root-authoritative final full run after the public-request-prompt correction
exits 0 with 3634 tests / 278 files, 3602 pass / 32 intentional skip / 0 fail /
21198 assertions in 84.90 seconds. The enforced tests/files/pass/skip baseline
therefore advances by +10 tests / +1 file / +10 pass over
3624/277/3592/32; `unwiredMethods` remains 82. No external model endpoint was
probed or called.

This is a Checkpoint I source hints → accepted MechanicsIR → closed-world/P4
increment. It does not redefine Checkpoint II (local artifact persistence) or
Checkpoint III (the public compiler end-to-end entry over in-memory
pages/fixtures and real PDF bytes), and it does not turn later runtime
integration into either checkpoint. One exact PDF, deterministic FakeLLM, and
synthetic positive fixtures do not prove arbitrary-PDF acceptance, a real
model, high-fidelity content breadth, automatic publication, or the overall
production goal. Todo-64 therefore remains open.

## Source-exact clue fact facets (2026-09-24)

The previous Fuzu acceptance exposed one content-fidelity defect behind an
otherwise closed state graph: a marked clue body could mix immediately visible
description with Medicine, Inspiration, or detailed-search conclusions, while
the runtime projected that body as one already-known clue. Draft schema 1.4 now
derives source-exact, non-overlapping body atoms in source order. Queue and
hints schema 3.2 adds one publish-blocking `clue_fact_facets` question per
marked clue. Its answer must partition every offered atom exactly once into the
shell, one gated finding, or `source_only`; an empty shell-body partition is
legal because the marked name remains the source-exact shell identity.

The answer cannot provide clue/mechanism IDs, location, target IDs,
availability, effects, state keys, or Predicate/Effect AST. For each accepted
finding the compiler derives a stable clue ID, its verified heading location,
`clue_found(shell) && !clue_found(finding)` availability, and the sole
`discover_clue(finding)` success effect. Compact methods are limited to
observe/search against scene or clue, or read against clue. `use_item` and
move remain unavailable until a real source-bound target contract exists.
Shell, finding, and source-only content remain distinct through accepted
interpretations, MechanicsIR symbols and reachability, artifact regeneration,
projection/sourceMap, the player action facade, and GameSession execution.

Proposal request 1.8 exposes only the closed atom IDs, exact quotes, and
statement IDs. A server-owned approved policy may propose the same complete
partition through the shared parser and one-to-one exact citations; this is
not a permanent human-per-item gate. Atom validation requires each quote to
match its raw page span, stay inside the canonical body evidence envelope,
preserve source order without overlap, and collectively reconstruct the full
body modulo whitespace. Restoring a prepared artifact regenerates and compares
the canonical queue, so a caller cannot self-sign a different atom set.

The exact 16-page Fuzu input now produces 197 questions. Bounded automatic
continuation makes three requests and 47 deterministic FakeLLM calls, leaving
195 answered, zero open, and two not-applicable child questions. The closed
runtime has four playable scenes, five clues and five discovery methods: three
shells plus separate Medicine and Inspiration findings. Arrival reveals only
the corpse and circle shells; the dream stone still requires its real detailed
search; camera prose remains source-only. GameSession dynamically verifies
that failed Medicine/Inspiration checks do not reveal their findings and fresh
successful checks do. Both declared endings remain reachable and replayable.

Real implementation mutations restored whole-body projection, removed the
child shell availability guard, and granted a finding automatically with its
shell; each made the intended regression red before restoration. Reordered,
deleted, out-of-envelope, and overlapping atom queues were independently
rejected. Final full verification is 3641 tests across 279 files, 3609 pass /
32 intentional skip / 0 fail / 21240 assertions in 90.61 seconds; typecheck
exits 0. No external model endpoint was called.

This materially raises read-to-runtime semantic fidelity, but does not close
the production goal. Exact Fuzu still has one runtime item, one static NPC,
zero dialogue/encounter/reward, and only four playable scenes; real-model
semantic partition quality, arbitrary/complex PDF coverage, automatic
publication, identity/rate-cost operations, and broader content remain open in
todo-64.

## Current exact Fuzu doctor / Susan acceptance (2026-09-24)

The preceding four-scene, one-static-NPC, zero-dialogue Fuzu figures are
historical pre-acceptance snapshots, not the current exact result. The verified
16-page, 1,751,612-byte PDF
`C:\aitrpg\[kp进阶推荐模组]复足.pdf` with SHA-256
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5`
now closes to five playable scenes, two bound NPCs, and one prose dialogue
clue. The red-first target coverage assertion fails as intended at
`runtime quality coverage playableScenes: expected 5, received 4`; exact
restoration succeeds.

This is an internal opt-in acceptance fixture change, not a production
compiler/DSL change and not a Fuzu or Susan production special case. It keeps
the real queue and changes the existing `屋子里的医生` role answer from `other`
to `playable`; the existing `该走了 → 中庭` topology remains and an optional
`该走了 → 屋子里的医生 → 中庭` route is added. It does not fabricate a question
or replace an answer with an invented relation.

Susan is not a new human answer. `DeterministicFuzuAutoLLM` may propose her
only from the actual NPC-binding request envelope's same candidate domain and
`sourceStatements`, using the exact name and relationship quote
`如果他们问起，她会告诉调查员这似乎是由某些奇特的快速生长的寄生虫感染造成，她只能自己把寄生虫摘除。`.
The canonical compiler then derives the mechanism and clue identities and
retains approved-policy and producer provenance. Randy remains the static
human-reviewed NPC and every other NPC is explicitly empty. Projection and
sourceMap retain Susan's exact name and fact. In GameSession, `Talk to
苏珊.艾当斯医生` is a discovery action that reveals the derived clue, grants no
item, state, or treatment, and then disappears.

The current aggregate artifact is
`338443f141575cb71c4ac542d72ab00cb985ef586c7b21f92bd95878105a1b63`:
22 scene candidates become 5 playable scenes; 3 clue candidates yield one
prose dialogue plus 6 compiled clues and 6 discovery methods; 32 anchors yield
2 bound NPCs; and there is 1 dialogue, 1 item, 0 encounter/reward, 2/2
reachable endings, and zero closed-world issues. It records 57 human answers,
139 initially open questions, and 47 deterministic fake-model calls; ending
witnesses take 4/3 actions. General directed root verification is 11 pass / 3
files / 0 fail / 174 assertions with typecheck exit 0. Exact acceptance exits
0, and the final Terra preflight exits 0 with the 3642-test / 279-file baseline
match and `unwiredMethods` 82.

No external model or network was used. This proves the current deterministic
prompt-envelope contract and exact-fixture acceptance only; it does not prove
real-model semantic quality, arbitrary-PDF coverage, treatment/infection/door/
combat behavior, automatic publication, or production completion. Todo-64
remains open.

## SAN check declarations must consume question-local source pairs (2026-09-24)

Parsed `sanity_check` declarations now have a source-fidelity gate before they
can enter accepted MechanicsIR. Each declaration must consume one canonical,
exact SAN/理智 slash pair from a real statement named by that question's
`sourceStatementIds`; a declaration saying `twice`/`两次` consumes two such
pairs. Consumption is a question-scope multiset, so repeated declarations
cannot reuse the same pair silently. This is deliberately not an event-level
citation claim: the gate proves the declaration's question consumed adequate
source evidence, not that an individual later runtime event carries its own
source citation.

The gate fails closed when the source fact graph is unavailable or lacks the
required canonical pair. It does not become a second numeric-rules parser:
the existing MechanicsIR parser remains the authority for bounds and legal
SAN-loss syntax. This corrects a source-declaration fidelity gap without
loosening either the accepted parser or the evidence domain.

Directed verification is 52 pass / 0 fail across 6 files and 331 assertions;
typecheck exits 0. The root-authoritative full `bun test` exits 0 with 3647
tests / 279 files, 3615 pass / 32 intentional skip / 0 fail / 21251 assertions
in 112.64 seconds, advancing the enforced baseline from
3642/279/3610/32 by +5 tests / +5 pass. Before the repair, and again with the
call to `validateSanityCheckSourceDeclarations` temporarily removed, the
dedicated 7-test SAN file had 4 failures; restoration is 7/7 green.

This is a bounded correction to source faithfulness. It does not establish
arbitrary-PDF ingestion, real-model semantic quality, or broader runtime and
content breadth; todo-64 remains open.

## Exact Fuzu Film SAN opening route (2026-09-24)

The exact current-schema Fuzu acceptance now uses the real source statement
`观影完毕之后，调查员们需要投理智鉴定（1 / 1d3）`.  Source-bound SAN
matching remains deliberately narrow: a `SAN` or `理智` label, optional
`loss`/`损失`/`鉴定`, and a contiguous slash pair in either ASCII or Chinese
parentheses. It is not an arbitrary-prose number extractor. MechanicsIR still
owns loss bounds and normalisation; the source gate only consumes matching
pairs from the current question's `sourceStatementIds`, as a question-scope
multiset, so a single declaration cannot be reused by another SAN effect.

The acceptance re-review changes only existing real queue answers. `电影时间`
changes from `other` to `playable_scene`, entry changes from `黑夜中的尖叫` to
`电影时间`, and the existing Film topology becomes the single stable
`film_to_night` connection. Its `onTraverse` is exactly
`{kind:'sanity_check',passLoss:{kind:'fixed',amount:1},failLoss:{kind:'dice',count:1,sides:3}}`.
`欢迎来到曲径旅店` remains `other` with no topology: its layout and equipment
text is not invented into an opening event.

The verified 16-page, 1,751,612-byte PDF remains SHA-256
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5`.
It closes with 197 questions; 57 human answers and 139 open initially, then
three bounded continuations / 47 deterministic FakeLLM calls yield 195
answered, two not-applicable children, and zero open. Runtime quality is six
playable scenes, six compiled clues and discovery methods, one item, two NPCs,
one dialogue, zero encounter/reward, and two reachable endings. Ending
witnesses take 5/4 player actions. Each crosses Film → Night exactly once and
GameSession produces one source-bound settlement with declared 1/1d3 loss,
valid before/after hashes, and an actual SAN decrease; the optional doctor
route begins through that same Film → Night traversal.

Red-first evidence was preserved: the old Fuzu expectation fails at six
expected versus five playable scenes; restoring the pre-extension Chinese SAN
parser makes the new source-bound parser/resolution test fail; and removing
Film's `onTraverse` SAN makes exact acceptance fail. All three were restored.
Root-authoritative verification is directed 74 pass / 5 files / 0 fail,
typecheck exit 0, and full `bun test` exit 0 at 3649 tests / 279 files /
3617 pass / 32 intentional skip. The prior preflight's only failure was the
old 3615 baseline; `docs/test-baseline.json` now records the new count.

This does not make the compiler a general prose interpreter, prove
arbitrary/complex-PDF or real-model quality, add broad scene/NPC/dialogue/
encounter/reward content, permit automatic publication, or close todo-64.

## Actor-effect event-slot closure (2026-09-24)

The earlier Film SAN account above is retained as a historical exact-PDF
increment. Queue/hints 3.3 closes the more general actor-effect provenance
gap it exposed: every emitted SAN actor effect has exactly one source binding
to its derived effect path and actual event slot. This is not a new SAN DSL.

The red-first cases were concrete ambiguity and capacity bugs: a `Red Room`
quote could bind to a `Room` connection through substring matching; repeated
actual target-heading slots could become falsely unique after set
deduplication; a checked-discovery quote could carry success and failure (or
Chinese equivalents) and nevertheless bind to an outcome; and an omitted
check was accidentally treated as checked. Other regressions showed that
question-local `(statementId, quote)` consumption allowed cross-question and
overlapping-substring reuse, that unrelated `twice` wording expanded capacity,
and that a shortened quote could hide the repeat suffix of the same source
declaration. The repaired contract canonicalizes declaration identity to the
statement plus absolute declaration span, requires full declaration coverage,
and accounts capacity across the full effective resolution set. Orphan or
extra provenance is rejected at the queue-value boundary.

Direct MechanicsIR compilation now separately verifies graph membership,
interpretation ownership, and a unique exact quote for each source binding;
it does not duplicate queue SAN/branch/capacity parsing. NPC dialogue uses the
same event-slot contract. The root full run after the implementation reported
3661 tests / 279 files / 3629 pass / 32 skip / 0 fail; directed verification
was 135 pass / 8 files / 0 fail / 641 assertions and typecheck exited 0. The
Film exact acceptance before the subsequent NPC-parser fixture follow-up was
green (artifact `b70f...2e39`, 197 questions / 0 open, 2 endings / 0 issues,
Film SAN once); a final Fuzu rerun remains owned by the root closeout.

This remains a fail-closed bounded contract, not acceptance for arbitrary
PDFs, real models, broad runtime/content coverage, clean-clone Fuzu
dependencies, automatic publication, or the overall production goal. Those
boundaries remain open in todo-64.

## Trackable Fuzu reviewed-answer input (2026-09-24)

The exact Fuzu acceptance no longer depends on ignored local analysis
artifacts. Its only retained human-review input is the non-ignored, trackable compact fixture
`scripts/fixtures/fuzu-reviewed-answers.json`: 50 question ID/kind/value/
short-reason judgments, with no PDF, prepared artifact, graph, queue,
presentation, long source prose, source-statement IDs, evidence refs, or
reviewer/authority metadata. The fresh prepare path supplies all provenance
and the existing apply/resolve validators recheck it.

The fixture is fail-closed against the exact module, PDF hash, source-graph
identity, current queue schema and prepared queue hash. It requires exactly
50 unique fresh questions with the fixed 22 topology / 22 role / 1 entry / 3
core clue / 1 discovery / 1 ending distribution, and exact fresh kinds. Any
identity or queue drift therefore asks for human re-review; there is no
locator fallback, old-artifact migration, write-back, or automatic review
marker. The seven later current-schema human constructions remain explicit
code over freshly prepared source data.

The fixture is currently untracked (`?? scripts/fixtures/`): a later authorised
commit is still required before a clean clone can use it. It is 9,965 bytes and contains only compact review values
(including the one short source declaration needed by the existing Film SAN
value). The exact user-supplied PDF run is green with artifact
`c58a...bfe5`: 197 prepared questions, 50 fixture plus seven current human
reviews, then 3 deterministic continuations / 47 calls to 195 answered, 0
open, 2 not-applicable and two reachable endings. This removes an ignored-file
dependency from the runtime benchmark input; it does not yet establish a
delivered clean-clone fixture, arbitrary
PDF, real-model, broad content, publication, or overall production readiness.

Root-authoritative full verification after the tracked-fixture change exits 0:
3664 tests / 280 files / 3632 pass / 32 intentional skips / 0 fail / 21,288
expectations in 94.70s. This updates the benchmark evidence only; the open
production boundaries above remain unchanged.

## Cross-heading source-bound NPC profiles (2026-09-24)

An independently headed NPC profile is a narrowly reviewable source domain,
not an alias, fallback, or inferred stat block. An anchor may offer one only
when its paragraph contains that profile heading's trimmed text exactly and
the heading scope has complete parser-accepted fixed HP, dodge, fight, and
damage evidence. The four selected stat quotes must all come from one heading;
when that heading is an alternate profile, `npc.nameQuote` must equal its
trimmed heading text exactly. This prevents one entity from borrowing another
entity's profile and prevents mixed-profile encounters.

The profile can supply encounter stats only. The anchor's location heading
still derives scene and auto-start, and it remains the only source for victory
clue or item effects. Canonical queue validation rebuilds the offered domain
from graph structure before accepting an answer, so a submitted source set
cannot widen it. Documents with no offered profiles use the exact legacy NPC
prompt, preserving their queue identity/hash.

The independently reviewed Fuzu acceptance is unchanged at artifact
`c58a4598...e8bbfe5`: 197 questions, 195 answered / 0 open / 2 N/A,
`mechanicallyClosed: true`, and runtime 6 discoveries / 1 item / 2 NPCs / 1
dialogue / 0 encounters / 0 rewards / 2 endings. Red-first profile evidence
was 12 pass / 2 fail; removing the same-profile/name-equality invariant was
13 pass / 1 fail.

The expanded source set deliberately contains the location heading and an
offered profile heading. Independent review caught the resulting ordering bug:
the grounded proposal gate and adapter had taken the first sorted heading to
decide whether an NPC binding belonged to a playable scene. That could reject
a playable location with a non-playable profile, or authorize a non-playable
location with a playable profile. `npcBindingLocationScene(graph, question)`
now reconstructs the anchor paragraph, its parent location heading, and its
canonical scene ID, then exact-matches `scene_role`; automatic encounter
authority remains disabled. Restoring the old first-heading gate made the
review regression 16 pass / 2 fail. Exact restoration produced the root
focused three-file suite at 50 pass / 0 fail / 421 assertions and typecheck
exit 0.

Two consecutive full-suite attempts hit the outer 5s fresh-Worker timeout;
the isolated case was 1 pass / 0 fail in 3.658s. Only that test's outer budget
is now 15s (its helper's 10s diagnostic is unchanged); its whole file is 12
pass / 0 fail and the target measured 5.612s. Assertions and production code
were not altered for that timing fix. The final root-authoritative full suite
is green: 3669 tests / 280 files / 3637 pass / 32 intentional skips / 0 fail
/ 21,272 assertions in 94.85s. This does not close broad combat, arbitrary
PDFs, real-model quality, automatic publication, or the overall production
goal. `docs/architecture.json` and `docs/notes/index.json` are intentionally
not refreshed in this shared-worktree closeout; their index/architecture
refresh remains deferred so parallel changes are not overwritten.

## Automatic source-exact NPC encounter and activation boundary (2026-09-24)

Automatic NPC encounter is a distinct, deliberately narrower capability than
the existing human-reviewed `npc_binding` encounter path. It is available only
when a server-owned trusted policy explicitly sets
`allowSourceExactNpcEncounters: true`; neither an unopted-in trusted policy nor
any request body can enable it. Only an already answered playable canonical
location can expose proposal request 1.9's closed encounter-profile domain. The
queue rebuilds that domain from the graph: it must have one and only one
attributable complete profile. A direct profile places exactly one HP, dodge,
fight, and damage candidate in the NPC anchor paragraph. An alternate profile
additionally requires the anchor to mention the trimmed profile heading
exactly, `nameQuote` to equal that heading, and all four stats to come from that
same profile. Multiple profiles, duplicate names, mixed owners, incomplete
profiles, and order-dependent selection fail closed.

The model may submit only the four closed stat-evidence
`{ statementId, quote }` selections. The compiler reuses the existing parser
and derives the encounter ID, owning scene, combatant, auto-start, and
MechanicsIR shape; it accepts no caller/model IDs, target, victory/effects,
runtime AST, or extra fields, and the derived `victoryEffects` is always empty.
Automatic audit 1.3 records producer provenance and exact per-claim evidence
for the name, four stats, and trigger; the older audit format cannot represent
this encounter contract.

Automatic hostility needs separate, intentionally small evidence. Its trigger
is a non-empty bounded exact substring of the anchor paragraph, different from
`nameQuote`, that names that NPC and matches only immediate, affirmative
hostility grammar. Friendly, negated, conditional, delayed, self-defence,
ability-description, and somebody-else-attacks wording is rejected even when
that produces a false negative. Compiling a valid shape only creates a pending
encounter: the NPC becomes hostile only after real activation. Combat RNG is
owned by each `GameSession` instance rather than a shared process proxy, and an
invalid combat unit fails closed before it can enter the runtime.

Focused verification is 106 tests / 10 files / 0 fail / 896 expectations and
typecheck exit 0. Exact Fuzu exits 0 for document
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5` and artifact
`e1ce9d252892143a6d99661a608eb70abf2da79eb46172eb645bf5641e11d220`: 197 questions,
195 answered / 0 open / 2 N/A, mechanically closed; runtime is 6 scenes / 6
discoveries / 1 item / 2 NPC / 1 dialogue / 0 encounter / 0 reward / 2 endings,
with 5/4-action witnesses and Film SAN exactly once on each. The
outside-sandbox authoritative full suite is 3677 tests / 281 files / 3645 pass
/ 32 skip / 0 fail / 21,366 expectations in 160.67s. This does not establish
arbitrary or complex PDFs, real-model behaviour, automatic publication, broad
combat, or external policy-issuer/artifact-integrity guarantees; todo-64 stays
open.

## Catalog durable-publication boundary (2026-09-24)

The durable catalog publication path is mechanically closed only to the extent
of its explicit file-system contract. An idempotent publish returns actual
metadata loaded from disk rather than request-local metadata. Pre-existing
entries and create races both load and fully validate the durable entry; a
staged directory is synced before publication; and the first acknowledgement
is accepted only after complete durable revalidation.

Opaque sync/load failures clean orphaned staged output. A deterministic sync
failure retains output only when full revalidation proves it valid, preventing
one process from rolling back another process's successful adoption. Corrupt
durable material is still cleaned rather than retained. This is a bounded
catalog durability result, not a claim that every multi-process or file-system
publication problem is solved.

Catalog-directed verification is 24 pass / 0 fail / 142 assertions; the broader
directed run is 67 tests across 5 files / 0 fail / 795 assertions; typecheck
exits 0. Root full `bun test` exits 0 with 3692 tests across 281 files, 3660
pass / 32 skip / 0 fail / 21478 assertions in 102.69s. All real mutations were
restored: in-memory metadata (10 pass / 3 fail), directory-sync removal (14 /
4), old corrupt-before-load behavior (15 / 1), cleanup no-op (14 / 6), recovery
that cleaned all owned paths (21 / 2), and unconditional deterministic-failure
retain (23 / 1).

The current exact Fuzu run is an acceptance witness, not a production claim:
the 16-page, 1,751,612-byte document with SHA-256 `a774…b5` prepared 22 scenes,
3 clues, 3 items, 32 NPC anchors, zero rewards, and 197 questions. From 57
human answers / 139 open / 2 deferred, three bounded requests and 47
deterministic FakeLLM calls reached 195 answered / 0 open / 2 N/A,
`mechanicallyClosed`, `contentReady`, and zero issues. Runtime has 6 scenes, 6
compiled clues and discoveries, 1 item, 2 NPCs, 1 dialogue, zero encounter or
reward, and 2 endings; real GameSession witnesses take 5/4 player actions and
cross Film SAN once each. No real external model was called.

Todo-64 remains open. Cross-process quota accounting is not closed because
`processLocks` is single-process; a newly created catalog root's parent
directory is not fsynced; review and bundle are not one transaction; and
player/Keeper audience and visibility semantics remain absent, so automatic
publication remains default-deny. Arbitrary/complex PDFs and real models are
unverified, and the exact Fuzu fixture is still untracked, leaving clean-clone
reproduction open. Mechanically the read-to-durable-publication loop is near a
production-grade boundary; content compilation and publication remain a
controlled trial, not production completion. Checkpoint I/II/III retain their
original scopes and this record does not advance into a new phase.

`docs/architecture.json` and `docs/notes/index.json` remain intentionally
deferred in this shared-worktree closeout: their architecture/index refresh
must not overwrite concurrent work.

## Catalog cross-process quota boundary and exact Fuzu correction (2026-09-25)

This section corrects and supersedes the 2026-09-24 section's statement that
cross-process quota remained unclosed. That older record remains historical
context; the closure below is limited to the catalog coordinator.

The catalog coordinator now closes its own cross-process quota boundary. Every
contender changes quota state inside SQLite `BEGIN IMMEDIATE`, compares the
persisted quota policy, and opens SQLite with `NOFOLLOW`, `FULLMUTEX`, and
`EXRESCODE`. It syncs the staged root after policy admission, publishes with a
no-replace hard link, and accepts a result only after durable reload. The
outcome is strictly one of `ok`, `refused`, or `indeterminate`; HTTP maps an
indeterminate catalog result to 503 rather than inventing a refusal or success.

The five catalog files are 74 pass / 0 fail / 804 assertions, and typecheck
exits 0. Real mutations all made their intended regressions red before exact
restoration: removing `BEGIN IMMEDIATE`, policy comparison, `NOFOLLOW`/path
checks, post-policy root sync, or the readback-fsync condition; restoring the
old post-ack refusal; and restoring a race-winner sync throw. This advances a
catalog sub-boundary, not todo-64 production completion.

The exact Fuzu acceptance exits 0 for the 16-page, 1,751,612-byte document
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5` and
artifact `e1ce9d252892143a6d99661a608eb70abf2da79eb46172eb645bf5641e11d220`.
It has 197 questions; its recorded initial state is 57 human / 139 open / 2
deferred, and three requests / 47 deterministic FakeLLM calls reach 195
answered / 0 open / 2 N/A. Runtime is 6 scenes / 6 clues plus discoveries / 1
item / 2 NPC / 1 dialogue / 0 encounters / 0 rewards / 2 endings, with
5/4-action GameSession witnesses.

An encoding-recovery audit corrected three original `◆` markers that had been
mistakenly restored as `▶`. Those mistakes admitted ordinary prose as marked
items. Exact restoration returns automatic coverage to 6/6 and NPC coverage to
8/8 without relaxing the FakeLLM or validator. The root full suite exits 0:
3718 tests / 284 files / 3686 pass / 32 skip / 0 fail / 21,562 expectations.

The remaining boundary is deliberate and narrower than a production claim. The
overall service is still single-active-writer because snapshot/claim sidecars
are outside the catalog coordinator. If publication completes but the process
crashes before its response reaches the caller, or that response is lost, the
caller can have an unknown opaque ID/orphan (Medium). NFS/SMB, external ancestor-path
replacement, old binaries, and Windows power-loss guarantees are unsupported;
review plus bundle is not one transaction. Real external LLMs and arbitrary
PDFs are unverified, and untracked Fuzu fixture/scripts keep clean-clone
reproduction open. `docs/architecture.json` and `docs/notes/index.json` remain
deferred in this shared worktree and must not be refreshed here.

## Compiled-session snapshot CAS is a bounded durable fact (2026-09-25)

Compiled-session snapshots now use their own SQLite coordinator rather than a
process-local lock or the catalog coordinator. The critical section is the full
durable decision: read the current header and validate the predecessor, publish
and validate the immutable body, publish the current header with directory
sync, then durable-reload before acknowledgement. Locking only a rename would
leave the predecessor observation outside the cross-process CAS and is not an
equivalent design.

Outcomes deliberately preserve uncertainty. An exact replay becomes `ok` only
after the durable body reload; competing different successors from one
predecessor cannot both acknowledge. Busy, conflict, storage failure, and a
possibly published result are distinct typed outcomes. The latter is
`indeterminate`, never an ordinary refusal. HTTP maps stale conflict to 409
with only the authoritative generation, and busy/indeterminate to 503 with
Retry-After. Generation zero commits at durable save: a later local create
acknowledgement failure must not remove a snapshot another process can adopt.

Recovery is one validated single-ID path, not a second restore implementation.
It matches the durable header and attempted identity exactly on
`sessionId`, `bundleId`, `generation`, and internal `snapshotHash`. Equal owner
identity is insufficient: a same-owner, different-snapshot registry entry must
fail closed rather than produce a mixed 201 response. Conversely, ordinary
precommit failure remains a 500 with private rollback and must not touch an
incomplete recovery identity.

The targeted six-file run is 66 tests / 1,021 expectations / 0 fail; typecheck
exits 0. Root full `bun test` exits 0 at 3736 tests / 286 files / 3704 pass / 32
skip / 0 fail / 21,684 expectations in 134.28s. Red-first mutations removed
the coordinator interval, authoritative rehydrate, indeterminate typing, or
exact recovery identity; all were restored. This closes a snapshot sub-boundary
only. Claim sidecars, ordinary sessions and metadata, quota/GC, trusted-root
symlink/junction handling, power-loss/NFS semantics, arbitrary PDFs, real-model
acceptance, and clean-clone fixtures remain outside the claim. The architecture
and notes indexes are intentionally deferred in this shared-worktree closeout.
Reviewed-source use is therefore a controlled beta/internal capability, not a
production or multi-instance readiness statement.

## Correction: ordinary prose facts and snapshot quota/GC closure (2026-09-25)

The preceding snapshot note is historical where it leaves snapshot quota/GC
open. The independent snapshot coordinator now closes that bounded path as
well: quota exhaustion returns the fixed safe HTTP `507` message; a configured
quota of zero forbids only immutable snapshot body/header publication; and the
SQLite coordinator may still bootstrap and its durable files count toward disk
use. This is deliberately not a claim that ordinary sessions, claims, metadata,
or arbitrary shared storage now have multi-writer safety. Directed evidence is
42 pass / 3 files / 286 expectations / exit 0, and independent review found
High = 0.

The ordinary source text `成功的知识鉴定后...` is now a separate
source-exact `prose_fact_finding` capability, not a widened clue parser. Draft
1.5 and queue/hints 3.4 make the server derive the atom, candidate, check, and
heading location. Its answer is a mutually exclusive ID-only partition; default
deny remains in force until an explicit trusted server policy enables it. The
real HTTP path completes its two bounded automatic rounds without human hints,
then preserves the finding through projection, sourceMap, and GameSession.
Scene identity is canonical and the draft schema fails closed rather than
accepting a caller-selected location.

The exact Fuzu acceptance remains a 16-page, 1,751,612-byte run: 197 questions;
195 answered / 0 open / 2 N/A; 7 clues / 7 discoveries including 1 prose
finding; 6 scenes / 1 item / 2 NPC / 1 dialogue / 0 encounters / 0 rewards / 2
endings; 643 reachable states under the current 1,000-state limit; 5/4-action
ending witnesses; and exit 0. Removing the same-heading gate, deleting the
prose parser, or allowing a free-form skill each turned the intended regression
red; restoration was green.

State-relevance pruning is still not done: the current 323 -> 643 expansion is
about 1.99x, so 1,000 states only covers this fixture and another similar
optional clue is expected to exceed it. Arbitrary PDFs, a second real module,
OCR, real-model multi-sample acceptance, ordinary-session multi-instance
consistency, IdP/audit/rate-cost governance, authenticated ordinary WebSocket,
and NFS/SMB semantics all remain open. Todo-64 remains open; this does not mark
the production goal complete. `docs/architecture.json` and
`docs/notes/index.json` remain intentionally deferred in the shared worktree.

## Control-state relevance pruning is a bounded quotient, not unbounded scale (2026-09-25)

The earlier 323 -> 643 state growth is now corrected by a constrained quotient.
Only a non-core pure-observation clue may be folded: no predicate or reward may
reference it; every source must be that clue's own discovery; and the discovery
must have no failure, failback, or additional effect. Fuzu folds the camera
prose finding and the NPC dialogue finding. The full edge set, witnesses, and
runtime hash remain unchanged; reported edges are quotient representative
evidence, not a claim to expose the complete full-hash adjacency.

The report component is version 1.1. A 1.0 report fails closed rather than
being silently reinterpreted. Fuzu now exits 0 with 227 control states, two
endings, zero issues, two witness replays, `mechanicallyClosed`, and artifact
hash `bc331a47c05217c295cb7400347000677f5b583aebdde3e852a729018de19bd2`.
The finite cap is restored to 500; it is a fail-closed safety budget, not a
promise that arbitrary new content will fit.

Restoring the full `mechanicsStateHash` control key makes the synthetic state
limit exceed at three and sends Fuzu back to draft-only at the 500 cap.
Incorrectly ignoring predicate references produces six failures and hides the
post-discovery trap deadlock. Both mutations restored green. Root-directed
evidence is 74 pass / 3 files / 239 expectations; the privileged broad compiler
matrix is 337 pass / 32 files / 2,502 expectations; reviewer evidence is 83
pass / 4 files / 297 expectations; typecheck exits 0. Independent review is
PASS with no High or Medium finding.

The root full suite exits 0 with 3,764 tests / 286 files / 3,732 pass / 32 skip
/ 0 fail / 21,845 expectations in 168.19s. Todo-64 remains open: arbitrary or
complex PDFs, a second real module, OCR, real-model acceptance, encounter and
reward breadth, and the operational production boundary are not closed.
`docs/notes/index.json` and `docs/architecture.json` remain deferred; the new
append-only notes below are intentionally a known stale-index entry until the
parallel-worktree refresh is authorised.

## Correction: result-oriented diagnostic intent simulation is API-required (2026-09-25)

The historical `probe-llm-intent` description that its result-oriented
`GameSession.act()` path exercised a live model became stale after intent
clients became session-bound. That script had cleared environment credentials
and supplied a placeholder/local configuration to a default-`preferred`
session, so execution fell back to regex even while an auxiliary global
classification column used the configured model.

The diagnostic now forwards the `LLMConfig` already loaded by its entrypoint to
each result session, selects `required`, and uses the required resolver for its
action-only rows. A model failure is visible and non-executing; it is never a
regex substitute. Exact local commands retain their existing protocol. The
entrypoint is import-safe for an offline regression, but the diagnostic itself
remains an explicit external probe and was not run. Ordinary HTTP sessions,
compiled owner UI, and the player facade retain their respective server-owned
intent endpoints; no browser model connection was added. Constructor-default
`preferred` remains the intentional internal/CLI compatibility behavior, not
an online-service policy.

The offline dynamic proof covers both configured `/chat/completions` requests
from the classifier and the actual result session; together with the directed
intent and deterministic compatibility matrix it is 48 pass / 0 fail / 454
expectations, with typecheck exit 0. Root-authoritative closeout `bun test`
exits 0 at 3767 tests / 287 files / 3735 pass / 32 skip / 0 fail / 21848
expectations / 225.64s. This is not a real external-model acceptance claim.
The fresh-worker restart test has an outer 15s scheduling budget (internal
diagnostic 10s) because an isolated completion showed the previous 5s outer
budget was too small; it is not a production latency promise. `todo-64`
remains open, and `docs/notes/index.json` and `docs/architecture.json` remain
explicitly deferred in the shared worktree.

## Correction: current-schema Fuzu acceptance is isolated and state-derived (2026-09-25)

The current exact Fuzu acceptance had three test-harness assumptions and one
resolver-boundary defect that made a green-looking run weaker than intended.
Its isolated auto-admission request could use the default catalog root and
return 503 instead of the fixture root. The test also fixed the initial open
count at a historical number rather than deriving it from the queue actually
prepared in that run. Neither behaviour is a product conclusion about the
document.

The harness now binds admission to its temporary catalog root and derives the
initial open set from the prepared queue. Its FakeLLM forwards the original
AbortSignal rather than cloning it, preventing detached cancellation state from
turning valid deterministic replies into `llm_call_failed`. In automatic
resolution, a non-empty `explicitHints` object no longer counts as progress:
only accepted resolution state may do so. A zero-accepted valid hint pass does
not create a continuation, and malformed explicit hints take the typed
draft-only path instead of escaping as HTTP 500.

Root's exact run exits 0 for the 16-page, 1,751,612-byte document
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5`: 197
questions, 195 answered / 0 open / 2 N/A, three bounded automatic requests /
46 deterministic FakeLLM calls, `mechanicallyClosed`, 227 control states, two
reachable endings, and two actual GameSession witness replays. The root
directed matrix is 38 pass / 0 fail / 237 expectations; root typecheck exits
0; root full `bun test` exits 0 at 3956 tests / 304 files / 3924 pass / 32
skip / 0 fail / 23107 expectations / 273.15s. `probe-unwired.ts` exits 0 with
75 unwired methods, so the baseline continues to enforce 75 as a non-growth
ceiling.

Real mutations restoring default-root fallback, cloned AbortSignal handling,
empty-accepted progress, and malformed-hint coercion each made their target
regression red before exact restoration. This repairs the current-schema
acceptance evidence for Checkpoint I's bounded read-to-accepted-MechanicsIR to
closed-world to runtime-witness loop. It does not advance Checkpoint II or III,
does not claim arbitrary/complex PDF or real-model quality, and does not close
the multi-instance, identity/audit/rate-cost, authenticated ordinary WebSocket,
or NFS/SMB production boundaries. `todo-64` remains open. The parallel
`docs/notes/index.json` and `docs/architecture.json` are intentionally not
refreshed by this closeout.

## Production hardening closeout remains an open acceptance boundary (2026-09-25)

The legacy author-facing `/api/modules` CRUD surface now has one narrow access
policy: it is operator-only. Authentication happens before a request body is
read or the module filesystem is touched; a request cannot self-declare a
role. Module IDs are restricted to a safe single segment and save, load, and
delete additionally prove that their resolved target remains inside the module
directory. The paired negative tests cover unauthenticated, keeper,
unavailable-authenticator, encoded-path, slash, backslash, absolute-path, and
dot-segment inputs; valid module-editor IDs retain their CRUD contract.

The unauthenticated legacy global `/api/characters` CRUD surface is retired.
This does not remove the session-bound character path, and it is not a claim
that every runtime or identity boundary has been production-certified.

Durable compiled-session recovery now attests the exact `bundleHash`, rather
than accepting a snapshot merely because module, artifact, or mechanics
identities resemble a current bundle. The Fuzu proof begins with the catalog,
persists a durable snapshot, and rebuilds each transaction from that state to
both declared ending IDs; it exits 0. This is actual transactional replay
evidence, not a statement about arbitrary PDFs or a real external model.

Root reports `bun run typecheck` exit 0 and full `bun test` exit 0 at 3965
tests / 306 files / 3933 pass / 32 skip / 0 fail; unwired methods remain 75.
Root-authoritative `bun scripts/preflight.ts` now exits 0: typecheck exits 0,
the 3965-test / 306-file baseline matches, unwired remains 75, it reports 258
boolean implementations / 0 discarded returns, and `core.hooksPath=.githooks`.
`todo-64` and the production-quality goal nevertheless remain open.
`docs/notes/index.json` and `docs/architecture.json` have shared
worktree changes and remain intentionally unrefreshed; their index lag is an
explicit handoff item.

## Final quality validation: heavy integration tests use scheduling budgets, not latency SLOs (2026-09-25)

Final preflight exposed three real integration chains whose former five-second
*outer* test timeout was smaller than their normal fresh-worker scheduling
time: the real HTTP PDF-to-terminal chain, the reviewed player-façade chain,
and the 16-case snapshot-forgery matrix. Their assertions and production code
were not changed. Each test now has only a `15_000ms` outer scheduling budget;
this is test-harness headroom, not a production latency SLO or performance
claim.

Independent repeat verification ran each group three times green, at roughly
5.26–5.60s. Root then ran one targeted instance of each chain green in the
same order at 5.17s / 4.52s / 3.87s, and `bun run typecheck` exited 0. The
authoritative full `bun test` exited 0: 3965 tests / 306 files / 3933 pass /
32 skip / 0 fail / 23115 expectations / 344.24s. The final preflight also
exited 0: typecheck 0; the 3965-test / 306-file baseline matched without a
baseline change; unwired methods remained 75; boolean implementations were
258 with 0 discarded returns; and `core.hooksPath=.githooks`.

This validates the revised test scheduling allowance only. `todo-64` and the
production-quality goal remain open. `docs/notes/index.json`,
`docs/architecture.json`, and `AGENTS.md` remain intentionally deferred and
were not refreshed by this validation record.

## Compiled intent classification has a durable cross-process admission boundary (2026-09-26)

Compiled natural-language intent classification is a read-only decision before
the existing structured action transaction, but it can still spend provider
work. The player `POST /api/sessions/:id/player-intents` facade and owner
`POST /api/sessions/:id/compiled/intents` therefore share one durable SQLite
admission controller. Its opaque lease identity binds the session and exact
expected generation; it is not a process-local Map and a later generation has
an independent key. Authentication/authorization, bounded JSON input, durable
compiled-session identity and generation, and current action-catalog checks
all occur before admission and before a provider call.

Only a committed holder may enter the provider. A same-key contender receives
429 plus `Retry-After` before provider, session, snapshot, or broadcast side
effects. Storage contention/uncertainty and root, schema, domain, or policy
mismatch remain fail-closed 503 rather than being misreported as a competing
request. The admission root must exactly equal the runtime namespace root;
the compiled wrapper fixes its SQLite filename, schema version, and coordinator
domain, so even a trusted host cannot inject a second same-root lock file.

`resolveCompiledActionIntent` explicitly uses `maxAttempts:1` and forwards the
HTTP Request signal. The request signal is combined with lease-renewal loss.
Abort, deadline, renewal failure, or any provider outcome whose completion is
uncertain quarantines the exact owner instead of releasing a lease while a
non-cooperating provider may still run. There is no TTL takeover. An
authenticated operator-only recovery route has no caller-selected generation
or fence and can delete only a quarantine that existed before the request; an
active row, including an expired one, remains refused. After the model await,
the server rereads durable namespace/snapshot identity and generation before
its existing registry and catalog rechecks, so another process's committed
action produces a safe conflict rather than an obsolete classification.

The database never stores raw player prose or an input-derived correlation
digest. Each acquisition gets a new CSPRNG 32-byte nonce solely for exact-owner
fencing/audit correlation. The player response remains opaque and does not
expose `mechanismId`.

Offline evidence is 35 passing tests across four files / 315 expectations,
typecheck exit 0, and the root full suite exit 0 at 3988 tests / 308 files /
3956 pass / 32 skip / 0 fail / 23299 expectations / 216.93s; unwired methods
remain 75. Real red-first mutations removing shared admission, restoring
default retries, dropping signal forwarding, allowing an injected filename,
or restoring prose-derived SHA-256 correlation made their target regressions
fail and were restored. Independent review is PASS. The pre-implementation
preflight did fail because its old 3965/306 baseline disagreed with then-current
3974/307 observations; this record does not preclaim the final preflight,
which root will run after the updated baseline and generated documents.

This is deliberately narrower than production completion. It does not prove
real provider behavior, automatic crash recovery (quarantine requires an
authenticated operator who has established the old worker stopped), ordinary
session/action or service-wide multi-writer safety, IdP/rotation/per-person
audit/rate-cost governance, authenticated ordinary WebSocket, arbitrary
PDF/content breadth, or NFS/SMB and power-loss semantics. `todo-64`, every
Checkpoint as a whole, and the production-quality goal remain open.

## Fresh source-to-runtime and world-system availability audit (2026-09-26)

The exact Fuzu source was rebuilt from its original PDF bytes rather than from
an existing artifact. The 16-page, 1,751,612-byte input has SHA-256
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5`.
Preparation produced 197 current-schema questions. Fifty-nine reviewed current
answers plus bounded deterministic proposals produced 195 answered, zero open,
and two not-applicable questions in three requests / 46 FakeLLM calls. The
resolved artifact is
`bc331a47c05217c295cb7400347000677f5b583aebdde3e852a729018de19bd2`;
its report is mechanically closed at 227 control states and both declared
endings are reached by real GameSession witnesses with five and four player
actions. No external model was invoked.

The durable witness now crosses an executable process boundary. The child is
given only a durable root plus session/action identities and generations. It
must read `header → catalog → body → restore`, replay the already committed
generation-one action idempotently, commit the next real Fuzu witness action at
generation three with the exact settled state hash, and return one machine-safe
JSON record. The parent reloads that successor from disk, restores it, and
continues the remaining witness. The first red run proved that no parent memory
was inherited by failing on a missing durable header; after aligning the
durable layout, another red run exposed runtime initialization text on stdout.
The CLI now suppresses only ordinary stdout logging before dynamic imports,
writes its proof directly, and preserves stderr/non-zero failures. The final
acceptance exits zero with empty stderr.

Public PDF preparation is also bounded before publication. A local admission
limit controls parser and validator children; raw bytes, page count, per-page
and total UTF-8 text, graph/queue structure, artifact size, and elapsed time
have fixed limits. The validator independently reconstructs and reseals the
artifact before a one-shot receipt permits catalog publication. A real
compressed one-page PDF that expands past the per-page text budget returns a
typed 422 and writes no catalog artifact. This is process isolation, not an OS
job/container memory cap; catalog read/restore still runs in the host process.

World-state persistence is operational for the tested local topology. Ordinary
and compiled sessions cover canonical snapshots, owner and namespace binding,
CAS/fencing, damaged or partial publication, exact action receipt replay, and
fresh-process recovery. SQLite remains the durable event truth used by clue,
visit, economy, and causation paths; the ten-turn economy tick was executed and
logged. The older in-memory world representation still duplicates parts of
NPC/scene truth and is not declared unified.

Both local world-model resources were loaded for real. The v18 resource
(`89C32185A15E34C8B7A4683BB2B688EEFDCC4BB5E6208EB489A13879A29CB305`)
contains 383,688 accepted entries across 73 novels and 424 types. The Cthulhu
resource (`6DE4EC192C9460E8A3E742FC148084BCE6E1EC3676459921C6921BE32B6E7F8D`)
contains 145 entries across seven works and eleven types. A fresh GameSession
loads both and includes both context sections in its KP prompt. Reload now
builds every index off to the side and atomically replaces live state; missing,
unreadable, all-invalid, or whitespace-only replacements unload instead of
serving stale entries or consumption state.

This makes the datasets useful read-only prompt references, not authoritative
world truth. The legacy loader still accepts operator-selected paths without a
trusted-root containment policy, manifest/content-hash attestation, strict
schema, or compiler module/corpus scope. It may not write executable rules or
GameSession/SQLite truth. Those controls, world-state representation
unification, arbitrary/complex PDF and OCR coverage, real-provider quality,
multi-node filesystem semantics, and deployment IdP/audit/rate-cost/WebSocket
work remain open under `todo-64`; the production-quality goal is not complete.

Independent directed evidence is 190 pass across fourteen compiler/runtime
files and 183 pass across fifteen durable/session files. World-model focused
evidence is 18 pass. The root full suite exits zero at 3998 tests / 310 files /
3966 pass / 32 skip / zero fail in 251.83 seconds. One later preflight run saw
one test failure that could not be reproduced: the immediate independent full
suite again exited zero at the same 3998/310 and 3966/32/0 counts. After the
measured unwired ceiling was corrected from 75 to 72, the final complete
preflight exited zero: typecheck zero, tests matched 3998/310, unwired matched
72, boolean-return discard was 0/259, and `core.hooksPath=.githooks`. Skip count
did not change. Concurrent `docs/notes/index.json` and
`docs/architecture.json` changes remain untouched, so their index view
deliberately lags this record.

## Correction: two real sources prepare independently and compiled lore is scope-bound (2026-09-26)

The exact Fuzu and Barn PDFs now have one opt-in, sanitized acceptance runner.
Its safe `--prepare` mode reads the original bytes locally, reports only stable
identities and counts, and makes no external call. Fuzu produces 197 questions
(195 open / 2 deferred); Barn produces 410 (384 open / 26 deferred). The two
prepared identities reject each other's hint envelopes in both directions.
Live mode requires both exact document SHA-256 values on the command line before
any source-derived proposal envelope may reach the configured provider; endpoint,
credential, complete prompt, and raw reply never enter the report. No such live
document call was authorized or executed in this record.

Barn exposed a real prepare defect rather than a model-quality result. A marked
body whose source brackets cannot be independently and exactly partitioned is a
publish-blocking empty atom domain. The generator already represented it that
way, while queue validation incorrectly demanded full reconstruction. Validation
now accepts that empty domain only when recomputation from the same graph also
returns no atoms. It still rejects forged emptiness, every attempted resolution
of an unpartitionable body, and any target/location inference. The tracked
source-bound regression covers the controlled 18 pages without depending on a
workstation PDF path: 49 scene candidates, 30 clues, 72 clue-fact atoms, 347
source-fact atoms, 30 items, two reward candidates, 63 NPC anchors, 410 queue
questions, 384 open, 26 deferred, and 130 publish blockers. Empty hints remain
`draft_only`; no MechanicsIR or runtime module is fabricated, and the hand-authored
`BARN_OF_PREMIER` is not used as an answer source.

The earlier statement that compiled sessions used unscoped shared world-model
context is also superseded for the compiled path. A server-owned Cthulhu binding
now records module/artifact identity, the canonical manifest digest and verified
dataset real root identity, sorted unique allowed works, optional corpus scope,
transfer policy, and a scope hash. It is part of the immutable catalog bundle
hash. Catalog save/load, durable session install, and restore reject identity,
scope, or bundle substitution. Prompt construction reuses the existing verified
dataset selector and returns exact work/chapter/source/text provenance; that text
remains reference-only and cannot write MechanicsIR or world state. A compiled
bundle with no binding loads and plays normally but injects neither v18 nor the
legacy aggregate Cthulhu loader. Ordinary sessions preserve their legacy path.
HTTP bundle inspection omits the server-only binding and dataset root.

This is a narrow fail-closed runtime adapter, not a general registry. The v18
resource has no trustworthy per-work manifest/content binding and is therefore
disabled for compiled sessions. Barn still requires an independent review or
bounded real-model proposal campaign before it can resolve and be played as a
new compiled module. Real-provider document quality, arbitrary/OCR documents,
world-state representation unification, distributed storage, IdP/audit/rate-cost,
and authenticated ordinary WebSocket remain open under `todo-64`.

Real mutations restored the old all-atoms reconstruction rule and suppressed a
typed runner refusal; their target tests turned red and were precisely restored.
Root directed suites exit zero at 25 tests / four files / 212 expectations and
104 tests / six files / 2,497 expectations. Typecheck exits zero. The root full
suite exits zero at 4,008 tests / 313 files / 3,976 pass / 32 intentional skip /
zero fail / 23,463 expectations in 333.57 seconds. Checkpoint I is ready to be
submitted to main-control review on this evidence. The final
`bun scripts/preflight.ts` exits zero with typecheck zero, the 4,008-test /
313-file baseline match, 261 boolean implementations / zero discarded returns,
72 unwired methods, and `core.hooksPath=.githooks`; this document does not mark
that review complete, does not enter Checkpoint II, and does not authorize a
commit or push. Concurrent `docs/notes/index.json` and `docs/architecture.json`
remain untouched, so their index view intentionally lags this correction.

## Correction: KP damage preserves the ordinary-session HP truth boundary (2026-09-26)

`GameSession.applyDamage()` previously committed damage only to the SQLite
world entity. The same PC's in-memory character sheet retained its old HP, so
the public world state and character summary disagreed immediately and an
otherwise legal ordinary-session snapshot then failed its existing
world/character consistency check. The successful world write now returns the
authoritative `remainingHp`, which is mirrored only into an already-existing
same-ID character sheet. NPC damage creates no character object; unknown target,
dead-state, HTTP, and snapshot-schema semantics are unchanged.

The initial regression exits one with expected summary HP 8 and received 10.
A real implementation mutation restoring the old world-only write reproduces
the same red result, and precise restoration is green. Root directed evidence
is 47 pass across four files / 215 expectations, with typecheck exit zero. The
root full suite exits zero at 4,009 tests / 313 files / 3,977 pass / 32
intentional skip / zero fail / 23,451 expectations in 304.11 seconds. The
first post-refresh preflight exits 1 because its embedded full test reports
one unnamed, non-reproduced failure (3,976 pass / 32 skip / 1 fail). The
immediate independent full rerun exits zero at 4,009 tests / 313 files /
3,977 pass / 32 skip / zero fail / 23,457 expectations in 344.81 seconds.
Root's final exact-tree `bun scripts/preflight.ts` exits zero: typecheck exits
zero; 4,009 tests / 313 files match the baseline; 261 boolean implementations
have zero discarded returns; `unwiredMethods=72` matches the baseline;
`core.hooksPath=.githooks`; and generated-document reference, hand-authored
payload, and architecture reference checks pass.

## Restored inactive companion commands must preserve response truthfulness (2026-10-05)

Recovery and library restoration can make a companion record reachable even when it is
inactive. That reachability is not a successful command outcome: the command resolver
must find the restored identity, and the real control/departure operation must still
propagate its own refusal. Treating an inactive lookup miss as success, or discarding
the false return from either operation, turns a recoverable state into a false-positive
player response.

The acceptance method used the real recovery/library path rather than a synthetic
manager result. The old implementation was 0 pass / 4 fail. Three independent
production mutations were red at 0 pass / 1 fail each: restore active-only
findCompanionId lookup, discard setControl's return, and discard handleDeparture's
return. Exact restoration was green. Terra directed verification was 95 pass / 8
files / 692 assertions; root directed verification was 29 pass / 4 files / 143
assertions; typecheck exited 0; and the direct probe was 46 no callers / 74
test-only / 36 should-private. The authoritative full bun test exited 0 at 5064
tests / 448 files / 5030 pass / 34 skip / 0 fail / 33694 expect calls / 431.39s.

This accepts only truthful responses for recovery/library-reachable inactive
companions. Normal new sessions still have no production recruit caller, complete
companion gameplay is not wired, and same-process prototype monkeypatching remains
an unclosed threat boundary. A public snapshot hash is an integrity check, not a
signature. This neither advances a compiler checkpoint nor closes todo-65 or the
production-quality goal. docs/notes/index.json and docs/architecture.json remain
deliberately unrefreshed while parallel edits are preserved.


## Current authority and automatic-proposal correction remains bounded (2026-10-05)

The current shared-worktree evidence adds two narrow compiler-adjacent
closures. Canonical compiled load/install dispatch now uses ECMAScript
`#private` authority; the corresponding 20-test authority regression was red
against the former implementation, red again under a real dynamic-dispatch
mutation, and green after exact restoration. The compiler auto hint-proposal
adapter now explicitly sets `maxAttempts: 1` for each chunk. A real LLMClient
with a local controlled-500 fetch made 16 POSTs for eight chunks before that
option and eight after it; removing the option restored the red result. The
ordinary LLMClient default retry contract is unchanged.

Combined directed verification was 129 tests / 11 files / 0 fail / 1034
assertions, and root typecheck exited 0. Root's serial full suite exited 0 at
5032 tests / 445 files / 4998 pass / 34 skip / 0 fail / 33457 expect() calls /
545.51s. This is an evidence and authority-boundary correction, not an advance
of milestone scope: Checkpoint I remains the source/hints/closed-world/P4
acceptance contract and is still awaiting main-control acceptance; Checkpoint
II remains local artifact persistence; Checkpoint III remains public compiler
entry end-to-end validation. No Checkpoint or production-quality goal is
declared complete here.

In particular, one adapter-process POST per chunk is not provider exactly-once:
there is no stable provider idempotency key or result lookup, and a crash after
provider dispatch but before local result persistence remains ambiguous.
Authoritative module-to-world resolution, cross-store/Career and
cross-filesystem behavior, NFS/SMB, power loss, multiwriter, Docker/Linux/
assets/deployment, and external real-model quality remain open. The final host
standard `bun scripts/preflight.ts` now exits 0 for the 5032 / 445 baseline:
313 boolean implementations / 0 discarded returns; generated/handwritten/
structured/reverse checks 3 / 8 / 1 / 3; typecheck 0; unwiredMethods 46; and
`core.hooksPath=.githooks`. That validates this bounded correction without
advancing Checkpoint I acceptance, II, III, or the production-quality goal.

Later ordinary durable model-call work adds a separate bounded retry policy:
KP outcome narration, NPC responses, and combat narrator first/constrained
regeneration calls explicitly use `maxAttempts: 1`; ordinary intent already
had that bound. Real LLMClient local-fetch coverage exercised 500 and
AbortError behavior, preserving round, gameTime, and history on trusted durable
intent failure. The corrected old regression was 1 pass / 3 fail; removing KP
`maxAttempts: 1` was a real 3 pass / 1 fail mutation with 2 POSTs; exact
restoration was green. Directed/broader/root-independent evidence was 38 / 6 /
140, 73 / 11 / 273, and 26 / 3 / 267 (tests / files / assertions), all green;
typecheck exited 0. The root serial suite then exited 0 at 5036 tests / 446
files / 5002 pass / 34 skip / 0 fail / 33470 expect() calls / 539.59s.

This does not change Checkpoint I's source/hints/closed-world/P4 acceptance
scope, Checkpoint II local artifact persistence, or Checkpoint III public
end-to-end validation; none is complete. One local process attempt is not
provider exactly-once, and the provider-executed/local-result-unsaved crash
window, authoritative module-to-world resolution, cross-store/Career and
cross-filesystem behavior, NFS/SMB, power loss, multiwriter, deployment, and
external real-model quality remain open. The final standard host
`bun scripts/preflight.ts` exited 0 for the 5036 / 446 baseline: 313 boolean
implementations / 0 discarded returns; generated/handwritten/structured/reverse
checks 3 / 8 / 1 / 3; typecheck 0; unwiredMethods 46; and
`core.hooksPath=.githooks`. That gate records bounded verification only and
does not complete any checkpoint or the production-quality goal.
`docs/notes/index.json` and `docs/architecture.json` remain deliberately
unrefreshed while parallel changes are preserved.

Legacy ordinary runtime install/restore/projection authority is another bounded
runtime-private correction. Canonical legacy ordinary load, generated-load,
restore, and projection dispatch, together with their actually reachable
origin/pickup/ModuleData/Mythos-NPC/clue/tome helper cohort, now use ECMAScript
`#private` authority rather than public or TypeScript-private compatibility
wrappers. Same-name own/prototype fakes and throwers can no longer manufacture
an empty successful projection or deny canonical dispatch; origin item reuse
does not bypass admission, and rehashed scene/pickup forgeries remain rejected.

The new regression was 0 pass / 24 fail against the former implementation.
Three real mutations—dynamic `handleLoadModule`, restore static assertion, and
runtime-origin dispatch—each made their four intended assertions red; exact
restoration was green. Related regression coverage was 123 / 123; typecheck
exited 0; the 13 target-helper dynamic `this` scan was 0; and root-independent
coverage was 58 tests / 4 files / 0 fail / 299 assertions. Root serial
verification was corrected after its first standard preflight exited 1: its
typecheck, 5060 / 447 baseline tests, and document checks were green, but
unwiredMethods rose from 46 to 57 because 11 of 13 new compatibility wrappers
had no callers. The correction deletes all 13 wrappers and keeps only
`#private` canonical authority. Decoy calls are now 0; invalid-package
coverage uses public `assertRuntimeModulePackage`; pre-character pickup uses a
portable public snapshot/package-statics/re-sign fixture that passes the
existing validator without a production test seam or validator relaxation.
All three no-wrapper mutations still made their intended four assertions red.
Agent probe returned unwiredMethods 46 and directed verification 56; root
13-name dynamic-`this` scan was 0; root probe exited 0 at 46 / 74 / 36; root
directed verification was 69 tests / 5 files / 0 fail / 380 assertions; and
typecheck exited 0. Root serial verification then exited 0 at 5060 tests / 447
files / 5026 pass / 34 skip / 0 fail / 33603 expect() calls / 545.75s. The
first preflight red remains part of the record. The corrected final standard
host `bun scripts/preflight.ts` then exited 0: 313 boolean implementations /
0 discarded returns; generated/handwritten/structured/reverse checks 3 / 8 /
1 / 3; typecheck 0; exact 5060 / 447 test baseline; unwiredMethods 46
baseline; and `core.hooksPath=.githooks`.

This does not advance Checkpoint I, II, III, or the production-quality goal.
It closes legacy ordinary canonical install/restore/projection string-shadow
authority only; standalone legacy loader/host trust, provider exactly-once,
authoritative module-to-world resolution, cross-store/Career and
cross-filesystem behavior, NFS/SMB, power loss, multiwriter,
Docker/Linux/assets/deployment, and external real-model quality remain open.
The final green gate verifies only this bounded correction; it does not erase
the earlier unwired 57 red result or complete any checkpoint or goal.

## Correction: ordinary snapshot build admission reuses the rules domain (2026-09-27)

Ordinary character admission previously duplicated a narrower `build >= 0`
validator even though `calcDamageBonus` legally accepts build values -2 through
8. This was not a hypothetical input: the controlled point-buy LCG seed 556
creates STR 37 / SIZ 45 / build -1 and the old validator rejected that legal
character. Admission now delegates to the same rules-domain validation;
boundary coverage accepts -2 and -1, and rejects -3 and 9.

The original boundary test exits one, and a real mutation restoring the
non-negative minimum exits one again; precise restoration is green. Snapshot
tests pass 15, ordinary-admission tests pass 9, and the root three-file run
passes 31 tests / 223 expectations. Typecheck exits zero.

The first two 4,010-test full runs also exposed scheduling evidence that must
not be written as a runtime SLA. The default five-second outer test deadline
was insufficient for six exact multistage process E2Es; only those tests now
have local 15-second budgets. An auto-deadline fixture used a 100ms lease TTL,
so it expired before exercising its intended two-second deadline; that fixture
now has a 10-second lease TTL while dedicated TTL coverage stays intact. No
production timeout, lease behavior, or global test budget changed. The final
root full suite exits zero: 4,010 tests / 313 files / 3,978 pass / 32
intentional skip / zero fail / 23,467 expectations in 241.13 seconds.

Root's final exact-tree `bun scripts/preflight.ts` exits zero: typecheck exits
zero; 4,010 tests / 313 files match the baseline; 261 boolean implementations
have zero discarded returns; `unwiredMethods=72` matches the baseline;
`core.hooksPath=.githooks`; and generated-document references, eight
hand-authored payload documents, and architecture reference/section checks
pass. This does not close Checkpoint I, `todo-64`, or the production-quality
goal. Concurrent `docs/notes/index.json` and `docs/architecture.json` remain
untouched.

The parallel boundary audits deliberately produced no speculative runtime
adapter. Barn still has two `unpartitionable_clue_body` publish blockers: it
must obtain new exact source spans and a new prepared identity before any human
or model answer can be accepted. Legacy v18 remains disabled for compiled
sessions because its optional `novel` label is not a stable work identity and
the corpus lacks per-record content hashes, evidence/rights provenance, and a
published per-work artifact manifest. Neither filename/name matching nor a
partial dataset manifest may become an implicit registry. `todo-64` and the
production-quality goal remain open. Concurrent `docs/notes/index.json` and
`docs/architecture.json` remain intentionally unrefreshed.

## Correction: Barn cross-page clue atoms are independently exact (2026-09-27)

The preceding 2026-09-26 statement that Barn's two
`unpartitionable_clue_body` blockers needed rebuilt source spans and a new
document/source-graph identity before review is superseded. The source spans
already existed. A new prepared queue/artifact identity is still required and
is produced below. The defect was in `deriveClueFactAtoms`: it passed a punctuation-derived semantic
range as a single whole range to same-page evidence lookup. Two marked-body
sentences cross a page boundary, so that all-or-nothing lookup returned no atom.
It was neither an unmatched-bracket condition nor a reviewer/model limitation.

The repaired derivation cuts a semantic punctuation range only at continuous
evidence-page-group boundaries. Every resulting atom remains one exact raw
span in source order, inside the canonical body envelope; it is not fragmented
per line, represented as a multi-span quote, or accepted through target
fallback. The queue validator, DocumentIR, source graph, and hint schema stay
strict and unchanged. Barn now has 81 atoms rather than 72, and all 30 actual
`clue_fact_facets` questions have nonempty answer domains. Its 410 questions,
384 open / 26 deferred state, and 130 publish blockers are intentionally
unchanged: these two questions are answerable but still unreviewed, so empty
hints remain `draft_only` and produce no MechanicsIR.

This is a derived-identity change, not a document/source-graph change. The
document hash and source graph identity
`1b2f07657a8727b522d231338a9af3bb2f9cbbb03a74e552dc8b4a3beecf3029` are
unchanged. The queue hash changes from
`2758eb7372b9e5c4272c0aaf3da7b367458968304823196939d8ee325473b749` to
`5937a83736ae1d149dab41077c634e70a7d46bec11d16f46e43b6e57655ec558`; the
new prepared artifact hash is
`22f5d503fe77295a07980d8f67c1116ee855afa7f6e2cafc7b6ceaec4a207e6b`.
Old queue and hint identities therefore fail closed rather than migrating or
being reinterpreted.

The synthetic cross-page old-path test fails with `atoms=[]`; restoring the
old range call in the real implementation yields two failures, including Barn
72 where 81 is required. Precise restoration passes 33 tests across 4 files
with 278 expectations; typecheck exits zero. Root's full suite exits zero at
4,011 tests / 313 files / 3,979 pass / 32 skip / zero fail / 23,502
expectations in 237.91 seconds. This record restores no public entry point and
does not advance Checkpoints II or III: their stated persistence and public
end-to-end scopes remain intact. Independent Barn review, accepted
MechanicsIR, publication, real-provider quality, and `todo-64` remain open.
Concurrent `docs/notes/index.json` and `docs/architecture.json` remain
intentionally unrefreshed.

## Correction: compiled intent admission waits for the winning lease (2026-09-26)

The first-time two-process compiled-intent admission race was not a provider
or intent-classification result. Compiled admission opened SQLite with
`busy_timeout=0`; its three immediate reopen attempts could all finish before
the winning process committed the durable lease. The loser then returned a
storage 503 instead of reading that lease and returning the intended 429.

Ordinary admission now owns a validated `busyTimeoutMs` option with a default
of 0 and an inclusive 0..60000 range. The compiled-intent path alone fixes
that value at 1000ms, applies it before any other SQLite pragma or
initialization, and removes the no-wait retry loop. A genuinely sustained lock
still returns 503; ordinary admission remains at 0. This is a narrow
first-contender lease-observation repair, not a claim of general multi-writer
storage readiness.

The same-tree preflight first exited 1 with 3975 pass / 2 fail. Independent
diagnostic full evidence then isolated `compiled intent durable admission >
allows exactly one first-time provider seam across two fresh Bun processes`:
exit 1 at 4009 tests / 313 files / 3976 pass / 32 skip / 1 fail / 23463
expectations / 308.11s. Terra dynamically reproduced the race 2 times in 20.
A real mutation restoring compiled timeout 0 makes the first race assertion
(line 115) red; precise restoration passes 25/25, and the final ordered run
passes 30/30. Root directed evidence is 26 pass / 3 files / 267 expectations /
0 fail; Terra typecheck exits 0. Root full `bun test` exits 0 at 4009 tests /
313 files / 3977 pass / 32 skip / 0 fail / 23445 expectations / 327.60s. Root's
final exact-tree `bun scripts/preflight.ts` exits zero: typecheck exits zero;
4,009 tests / 313 files match the baseline; 261 boolean implementations have
zero discarded returns; `unwiredMethods=72` matches the baseline;
`core.hooksPath=.githooks`; and generated-document reference, hand-authored
payload, and architecture reference checks pass.

## Current compiled-session creation ingress and compiler cold-path authority (2026-10-06)

The public compiled-session creation boundary now has a separate process-local,
no-queue admission controller: two active creations process-wide, one per exact
authenticated creator, and `Retry-After: 1`. Cheap media and declared-length
checks precede admission. The lease covers player assignment, body consumption,
catalog access, runtime namespace reservation, private construction,
generation-zero publication or exact recovery, and registry installation.
This is independent from ordinary-session durable creation admission and from
the compiler PDF/JSON controllers.

Two independent-review corrections define the accepted semantics. First, an
HTTP 408/413/400 is not the end of physical body work while `reader.cancel()`
is pending. PDF, compiler JSON, and compiled-create ingress now transfer lease
ownership to the actual cancellation drain; JSON also joins retained provider
drains before one idempotent release. Second, every recognized compiler route
authenticates before request-triggered coordinator construction or durable
inventory reconciliation without calling a stateful host authenticator twice.
The outer check mints a frozen, module-private WeakMap-backed, one-shot
capability bound to the exact Request, method, pathname, route-policy ID, and
principal; the inner boundary consumes it before comparison. Forged, replayed,
and cross-request/method/path use refuses before catalog/body work and never
falls back to the authenticator. Direct inner calls still authenticate once.

Real mutations removing creation acquire, releasing early, constructing a
fallback per request, accepting attacker-selected bucket material, suppressing
the body-drain handoff, restoring reconcile-before-auth, restoring the second
authenticator call, and removing replay protection all made discriminating
tests red and were exactly restored. Root final directed evidence is 59 tests /
8 files / 870 assertions; independent final audit evidence is 46 tests / 507
assertions. Typecheck and scoped diff-check exit zero. The authoritative serial
suite exits zero at 5240 tests / 478 files / 5205 pass / 35 skip / zero fail /
34651 assertions in 536.92 seconds. Final standard preflight exits zero with
326 boolean-returning implementations / zero discarded returns, references
3 / 8 / 1 / 3, internal typecheck zero, the exact 5240 / 478 baseline,
`unwiredMethods=46`, and `core.hooksPath=.githooks`.

This closes only in-process compiled-create concurrency, body-cancel lifetime,
and request-triggered compiler cold-auth ordering. Distributed/gateway and
cross-replica quotas, durable start-rate/cost policy, per-person IdP, provider
exactly-once, policy hot revocation, Docker/Linux execution, NFS/SMB,
power-loss, wider multiwriter behavior, external real-model/source quality,
`todo-65`, and the production-quality goal remain open. Checkpoints II and III
are unchanged. `docs/notes/index.json` and `docs/architecture.json` remain
intentionally unrefreshed because both have parallel changes.

## Ordinary opening provider single-attempt completion (2026-10-06)

The generation-zero ordinary opening was the remaining identified durable
ordinary model call that inherited `LLMClient`'s legacy two-attempt transport
policy. `KPAgent.describeSceneResult` now passes `maxAttempts: 1`, while real
request cancellation continues to abort creation instead of becoming a
persisted fallback.

Red-first coverage uses the real HTTP creation path, `GameSession`, and
`LLMClient` with a local fake transport. Both provider HTTP 500 and provider
`AbortError` issue one creation-time POST and still produce the sanitized 201
fallback, live registry entry, and generation-zero snapshot. Removing only the
new option makes both cases fail with two POSTs; exact restoration passes
13 tests / 2 files / 63 assertions. Typecheck exits zero. The authoritative
serial suite exits zero at 5241 tests / 478 files / 5206 pass / 35 skip /
zero fail / 34677 assertions in 580.64 seconds, one test and one pass above the
previous baseline with files and skips unchanged.

The final standard preflight exits zero with 326 boolean-returning
implementations / zero discarded returns, references 3 / 8 / 1 / 3, internal
typecheck zero, the exact 5241 / 478 baseline, `unwiredMethods=46`, and
`core.hooksPath=.githooks`.

This result deliberately does not claim provider exactly-once. The provider
interface exposes no stable idempotency key or result lookup, so a crash after
external execution but before local persistence remains ambiguous. A separate
compiled-session durable cross-process creation coordinator is feasible for a
shared trusted local SQLite root, but is not implemented in this slice and
would not prove independent-volume, NFS/SMB, or multi-host behavior.
Checkpoints II and III are unchanged. `docs/notes/index.json` and
`docs/architecture.json` remain intentionally unrefreshed because both have
parallel changes.

## Real dual-process compiled-intent replay race (2026-10-06)

The earlier evidence proved cross-process admission exclusion and committed
replay-row visibility separately, but did not combine them into the actual
miss-to-acquire interleaving. A new barrier-driven test now starts two fresh
Bun service processes against one real catalog, snapshot root, namespace,
SQLite admission coordinator, and SQLite replay store. B performs a real
initial replay miss and pauses immediately before its real coordinator
acquire. A calls the provider once, returns `no_match`, durably saves the
result, and releases. B then acquires and must obtain A's result from the
production post-acquire replay lookup without entering its provider.

The implementation mutation that made the post-acquire lookup behave as
absent caused B to enter its provider and made the test exit one. Exact
restoration is green. The test child protocol also drains stdout and stderr
concurrently under independent 16 KiB raw-byte limits. Hostile stdout and
stderr modes each write 32 KiB and never settle; both are rejected
fail-closed, wake pending consumers, and terminate only the precise child
handle created by the test. Root verification passed the new file at 2 tests
/ 12 assertions, the related replay/admission/player-intent set at 37 tests /
4 files / 336 assertions, and typecheck, all with exit zero.

The first complete run passed 5,297 tests / 487 files / 5,262 pass / 35 skip /
zero fail, but the following handoff run observed unrelated reviewed-slot
adapter files while they were being edited and correctly wrote a red internal
snapshot. Those three cases immediately passed 4 / 1 skip on the then-current
tree. After a no-write stability window, a fresh serial run exited zero at
5,298 tests / 487 files / 5,262 pass / 36 skip / zero fail / 34,994 assertions
/ 572.20 seconds, with no `src`, `docs`, or `scripts` writes during execution.
The additional skip is the new environment-gated actual-worldmodel smoke, not
a lost pass. Refreshed generated snapshots and final standard preflight remain
the acceptance gates for this increment.

This strengthens the shared-local-filesystem guarantee; it does not provide
external-provider exactly-once after provider execution but before local
durability, nor multi-host/independent-volume, NFS/SMB, power-loss,
Docker/Linux, or external real-model qualification. Checkpoint boundaries
remain unchanged.
`docs/notes/index.json` and `docs/architecture.json` remain intentionally
unrefreshed because both have parallel changes.

## Compiled-session durable creation admission (2026-10-06)

Compiled session creation now has two independent admission layers. The
existing process-local no-queue slot remains the immediate physical bound;
an independent SQLite coordinator under the trusted runtime namespace adds a
cross-process global limit of two, one active create per exact authenticated
principal, four starts per principal per 60 seconds, and a 1,024-principal
tracking bound. Its renewable 60-second lease has an immutable 300-second
whole-job deadline. The lease spans player assignment, body consumption,
catalog and namespace work, construction, generation-zero publication or
exact recovery, registry installation, and any still-pending body-reader
cancellation drain.

The coordinator has its own filename, tables, policy identity, principal
domain separation, fences, and recovery authority; it does not reuse ordinary
creation, intent, action, catalog, or compiler-auto admission. Main validates
and initializes the exact root/file before durable inventory or listening and
injects that same instance into request handling. A direct trusted host must
provide an exact-root coordinator or use the server's same-root default.
Missing, mismatched, busy-storage, indeterminate, expired, or unhealthy state
fails closed; no request-time process-local fallback exists. Expiry or whole-
job deadline loss persists an unknown-outcome quarantine. Only an
authenticated operator may call the bodyless and queryless recovery control
plane, which reports `providerOutcome: unknown` and never accepts a caller-
selected fence, principal, or replacement identity.

Review corrected a real deadline defect before acceptance. A renewal at time
1,016 originally moved `expiresAt` to 1,026 even though `deadlineAt` was 1,025,
and deadline expiry returned a refusal without atomically quarantining the
lease. Renewals are now capped at the immutable deadline, and physical expiry
or deadline expiry quarantines in the same SQLite transaction so a late owner
release cannot reopen capacity. HTTP tests also prove that a resolver-held
lease blocks a second process boundary, admission loss after resolution stops
before body/catalog/construction/publication, pending body cancellation keeps
both leases, and recovery invokes a stateful authenticator exactly once.
Fresh-database two-process contention produced one acquired result plus one
typed busy result in three consecutive runs.

The early-release implementation mutation removed the body-drain ownership
handoff. Its focused test exited 1 at zero pass / one fail: a same-principal
competitor received 400 instead of the required 429 while cancellation was
still pending. Exact restoration passed the new admission coverage at 20
tests / 3 files / 152 assertions. The first authoritative full suite then
exited 1 at 5,255 tests / 480 files / 5,209 pass / 35 skip / 11 fail / 34,701
assertions because eleven existing trusted-host fixtures had not supplied the
new required coordinator. The fixtures were given real same-root authorities
without adding a production fallback or weakening assertions; their directed
rerun passed 77 tests / 8 files / 597 assertions. A nested-sandbox attempt
reported 112 child-process failures while its PowerShell wrapper incorrectly
returned zero, so it is retained as invalid execution evidence rather than a
green run. The authoritative sandbox-external rerun exited zero at 5,255
tests / 480 files / 5,220 pass / 35 skip / zero fail / 34,767 assertions in
563.85 seconds. Typecheck and the current unwired probe exit zero; the latter
remains 46.

This closes a shared trusted local-filesystem SQLite admission domain, not
provider exactly-once or a distributed gateway quota. Independent volumes,
NFS/SMB, multi-host consensus, power-loss qualification, and an atomic
transaction spanning admission, catalog, namespace, snapshot, and registry
remain open. An unabortable resolver is awaited to real settlement; if its
lease is lost, publication stays forbidden and operator recovery remains
mandatory. Checkpoints II and III are unchanged. `docs/notes/index.json` and
`docs/architecture.json` remain intentionally unrefreshed because both have
parallel changes.

## Handoff full-suite process capture (2026-10-06)

The handoff generator no longer treats a fixed synchronous child-process
buffer as the authority for the full Bun suite. At the current suite size,
`spawnSync` exhausted its default output buffer and returned `ENOBUFS`, so a
green suite was rendered as “could not start.” The generator now awaits the
shared asynchronous process capture, which drains stdout and stderr
concurrently and places a combined 64 MiB bound on retained evidence. Hitting
that bound terminates capture and is an explicit failure; output is never
silently truncated into a green result.

The result is accepted only when process startup and both streams complete,
the child exits zero without a signal, exactly one authoritative terminal Bun
summary is present, failures are zero, and test/file counts meet the current
baseline. Nonzero exit, ambiguous or absent summary, stream failure, signal,
capture-limit termination, or count regression all fail closed. The existing
small `spawnSync` helper remains only for bounded Git metadata commands.

Red-first coverage failed before the evidence boundary existed at zero pass /
one fail / one error. Exact implementation passed 84 focused tests across
three files with 372 assertions; typecheck exited zero. The first authoritative
sandbox-external suite through the repaired capture exited zero at 5,259 tests
/ 481 files / 5,224 pass / 35 skip / zero fail / 34,796 assertions in 637.69
seconds, exactly four tests and one file above the prior baseline. The actual
handoff command then exited zero after its own complete run, generated 914
lines / 46.7 KB, reported the exact baseline as green, and contained no
`ENOBUFS` marker. The subsequent standard preflight exited zero with 327
boolean-returning implementations / zero discarded returns, document checks
3 / 8 / 1 / 3, internal typecheck zero, the exact 5,259 / 481 baseline,
`unwiredMethods=46`, and `core.hooksPath=.githooks`.

A follow-up generation check found that the new todo-65 closure, verification,
and open-scope values were still absent from the handoff body. The generator
intentionally uses an explicit `CurrentWorkItem` allowlist and a bounded
three-entry current-increment list, but the new keys had not been added. The
red-first mapping test exited one with all three markers absent. The corrected
allowlist prioritizes the capture closure/verification pair in current
increments and carries its open scope into current scopes without rendering
arbitrary todo payload keys. The focused generator suite passed 77 tests /
339 assertions; the combined process diagnostics passed 85 tests across three
files / 377 assertions; typecheck exited zero. The authoritative suite after
that correction exited zero at 5,260 tests / 481 files / 5,225 pass / 35 skip
/ zero fail, exactly one test and one pass above the preceding baseline with
files and skip unchanged.

This repairs local diagnostic evidence collection only. It does not expand
Checkpoint I, implement Checkpoints II or III, or close provider exactly-once,
multi-host, NFS/SMB, power-loss, Docker/Linux, external real-model quality,
todo-64/todo-65, or the production-quality goal. `docs/notes/index.json` and
`docs/architecture.json` remain intentionally unrefreshed because both have
parallel changes.

## Compiled-intent durable success replay (2026-10-06)

Compiled owner and player natural-language intent classification now has a
durable success-replay boundary. Both HTTP facades use the same sequence:
validate the current generation and action catalog, look for an exact replay,
acquire the generation-scoped durable admission lease, look again to close the
miss-to-acquire race, check scope capacity, call the provider once, revalidate
authoritative state and catalog, durably save the validated result, then
release admission. A committed selected, ambiguous, or no-match result can be
reused after process restart. The owner response may retain its trusted
mechanism projection; the player response is rebuilt through the current
opaque choice facade and never publishes a mechanism ID.

The fixed same-root SQLite ledger contains only HMAC-derived session, scope,
request, catalog, and mechanism identities plus a request-bound result MAC.
Player prose, labels, raw mechanism IDs, facade choices, and the private
integrity key never enter the database. Direct SQL substitution of a
well-shaped result or copying a result and MAC to a different request fails
verification and quarantines the row. All selected TEXT fields are gated in
SQLite by UTF-8 byte length before native-to-JS projection; a multi-byte value
whose character count fits but byte count exceeds the bound becomes `NULL`
and is rejected before JSON parsing.

Capacity is 64 records per immutable session/generation/bundle scope, not one
global 4,096-row pool. Exact hits remain replayable at the limit; unrelated
scopes do not consume one another's quota. Provider admission serializes one
session generation, so a post-acquire capacity check is stable for that scope;
the save transaction repeats the guard. A verified later generation deletes
only the same session's older-generation replay rows. Capacity refusal occurs
before provider work and releases admission normally. A provider result whose
save or commit cannot be acknowledged leaves the admission lease quarantined.

The original restart regression observed two provider calls for one exact
owner-to-player retry. Review found four additional defects before acceptance:
the post-acquire replay lookup was missing, result content was not MAC-bound,
the global capacity could be exhausted by one authenticated scope and was
checked only after provider work, and character-length SQL projection did not
bound byte transfer. Removing the second lookup, MAC verification,
provider-before-capacity guard, or byte-length projection made its specific
test red; each exact implementation was restored. Root directed verification
exited zero at 44 tests / 4 files / 369 assertions. The replay-only suite,
including a real Bun child writer and parent-process reader, exited zero
outside the sandbox at 7 tests / 1 file / 47 assertions; the sandbox attempt
is retained separately as `uv_spawn EPERM` environment evidence. Typecheck and
scoped diff-check exited zero. After the explicit handoff mapping regression
was added, the first complete stable-tree run exited one at 5,273 tests / 482
files / 5,237 pass / 35 skip / one fail. Its summary-only command had not
retained the failing test name, so no cause or fix is claimed and no assertion
changed. The second identical run used bounded failure extraction and exited
zero at 5,273 tests / 482 files / 5,238 pass / 35 skip / zero fail, exactly 13
tests and one file above the prior baseline. The direct unwired probe remains
46.

This is local durable replay for processes sharing one trusted filesystem, not
external-provider exactly-once. If the provider executes and the process dies
before any local result can be confirmed, the outcome remains ambiguous and
requires quarantine/operator recovery. Multi-host and independent-volume
coordination, NFS/SMB and power-loss qualification, gateway/IdP cost policy,
Docker/Linux deployment, external real-model quality, broader cross-store
transactions, todo-64/todo-65, and the production-quality goal remain open.
Checkpoint I/II/III boundaries are unchanged. A later standard-preflight run
found two verification-protocol defects rather than replay-product defects.
First, the global boolean-return scanner associated the replay store method
name `quarantine` with an unrelated ignored call. The replay-only method was
renamed to `quarantineReplayResult`; the scanner and the unrelated caller were
not weakened, and quick preflight returned 333 implementations / zero
discarded returns. Second, the pre-existing real-process ordinary-creation
test used a 100 ms lease and sometimes spawned its first contender only after
expiry. The original protocol failed 9 of 30 repetitions with the correct
early `UNHEALTHY` result. The test child now reports durable `expiresAt` and
`deadlineAt`; all three processes use the same 5 s policy; the test proves
`BUSY` before killing the holder, waits from the returned durable expiry, and
then proves `UNHEALTHY`. Production admission was unchanged. A `sleep(0)`
mutation was deterministically red with `BUSY`; exact restoration passed 30
of 30 in delegated verification, then 5 of 5 and the complete 10-test file in
independent root verification. Typecheck exited zero. The final stable-tree
full suite exited zero at 5,273 tests / 482 files / 5,238 pass / 35 skip /
zero fail.

The next standard preflight exited one without a terminal summary and returned
process exit 9 after naming three cross-process tests. Each named test passed
alone and their combined set passed 30 of 30, so no product cause or fix is
claimed. That run exposed a diagnostic weakness: only failure names survived.
Preflight now emits at most three failures, 18 lines, and 4 KiB of focused
error, expected/received, stack, and child-process context while retaining its
existing exit, summary, and baseline fail-closed gates. Returning no context
made three of four new tests red; changing the three-failure limit to four made
the integration contract red.

That added evidence made the following preflight actionable. A compiled CORS
listener child was using Bun's default 5 s test timeout instead of the bounded
outer contract, while a process-diagnostic test still expected the old
names-only rendering. The listener helper now passes an explicit runner/test
budget, reports `ready` and `result` phases, and uses one absolute 29 s
watchdog below the 30 s parent; phase progress cannot extend it, one second is
reserved for output drain, and only the exact child handle is terminated.
Custom timeouts retain the same strict cleanup margin and reject unsafe values.
Removing the owned-child kill and restoring watchdog equality with the parent
each made the hang coverage red. The stale rendering assertion was updated
without widening the three-failure / 18-line / 4-KiB limits.

Independent root verification passed 192 diagnostic tests / 557 assertions,
five native-fetch/listener tests / eight assertions, and typecheck. The
repaired standard preflight exited zero at 5,280 tests / 483 files / 5,245
pass / 35 skip / zero fail; the boolean scan was 334 implementations / zero
discarded, document checks were 3 / 8 / 1 / 3, typecheck exited zero,
`unwiredMethods` remained 46, and `core.hooksPath` remained `.githooks`.

Two later handoff refreshes exposed one remaining verification-entry drift:
the generator still launched bare `bun test`, while the standard gate used
one worker and a 30-second runner ceiling. Handoff now uses that same explicit
contract, but a further red refresh proved this was not the full cause. Because
the generator intentionally writes even a red snapshot, it now also prints the
existing three-failure / 18-line / 4-KiB bounded context for failed internal
evidence. The old argument assertion failed 1 of 78 before restoration; the
new diagnostic assertion was red before context existed, and the combined
contract passes 79 of 79 independently.

The first instrumented run localized the intermittent failure to the ordinary
CoC active-PC growth fixture rather than the owner map. It created p2 with
random skills, fixed only fighting at 90, then required both fighting and dodge
marks from a fixed d100=11 roll. A `dodge: 10` mutation reproduced the exact
received value `['fighting']`. The fixture now fixes both required p2 skills at
90; production code did not change. The target passed 20 of 20 delegated runs,
the complete file passed 25 of 25 independently, and a root complete-order run
exited zero at 5,281 tests / 483 files / 5,246 pass / 35 skip / zero fail. A
refreshed handoff must still show its own complete-suite result in the header
before the final standard preflight is accepted.

`docs/notes/index.json` and
`docs/architecture.json` remain intentionally unrefreshed because both have
parallel changes.

## WorldState durable logical round and legacy snapshot publication (2026-10-07)

The runtime now has one bounded WorldState correction alongside the compiler
work: `world_state_metadata.current_round` is the durable logical-clock
authority, while `snapshots` keeps historical publication order by `rowid`.
Legacy startup attests the complete historical snapshots definition and the
metadata singleton, validates every historical round, and seeds missing
metadata from the final valid historical row. A pruned history row therefore
does not roll the logical clock backward. `createSnapshot(round)` uses one
immediate transaction for state/events/context reads, historical INSERT, and
clock update; export, live state, default effect rounds, and portable restore
all use the durable singleton.

Root verification records 17 focused snapshot tests / 84 assertions, two
independent red mutations (process-local cached round and deferred snapshot
publication), typecheck, and a serial full suite of 5,326 tests / 488 files /
5,290 pass / 36 skip / zero fail. This records a runtime storage correction;
it does not alter the status of Checkpoint I, including any already-complete
compiler foundation, and does not claim broad production readiness. Separate
WorldState implementations, cross-store/Career transactions, non-SQLite or
independent-volume writers, multiwriter coordination outside this SQLite
boundary, NFS/SMB, crash/power-loss behavior, deployment, and real PDF/OCR or
external-model acceptance remain open.

## Runtime production correction: legacy WorldState ownership (2026-10-07)

The legacy play-module `src/world/state.ts` now owns its ModuleData input and
returns detached structured reader views, including deep Map/Set snapshot
state. This is a bounded runtime alias-authority repair: caller changes and
stale public views cannot redirect legacy scene, clue, NPC, narrative, or hint
decisions. The separate post-construction `llmExpanded` path remains safe only
because the scene pipeline directly consumes the external module NPC data; it
is not a shared-state contract. Root recorded 45 directed passes before the
generator mapping regression; the final combined directed set passed 129 tests
/ 5 files / 591 assertions. The authoritative serial full suite then exited
zero at 5,330 tests / 489 files / 5,294 passes / 36 skips / zero failures, with
1,406,599 captured bytes in 542.70 seconds.
The 46→41 unwired movement is test-only classification migration, not new
production wiring. This does not change Checkpoint I/II/III status or claim
the two WorldState implementations, multiwriter/cross-store durability,
deployment, or real PDF/OCR/model production validation are complete.

## Runtime boundary correction: lifecycle-scoped readers and unambiguous message routing (2026-10-07)

This is a bounded runtime authority correction, not a compiler-checkpoint
change. A `GameSession` NPCStore read facade is valid only while its issuing
session is open: retained facades reject after close, while caller-owned raw
stores remain caller-owned rather than being closed by the session. Separately,
`PlayerSession` now has one live message-routing authority. The retired
per-receiver writer is absent, and a new push carrying its own `visible_to`
field rejects before it can create a public-delivery/private-looking mismatch.
Live routing remains the established visibility/discoverer/targets contract.

Versioned parser, restore, and export keep historic snapshot `visible_to`
values as detached compatibility data; that backwards compatibility does not
re-authorize new writes. This correction leaves Checkpoint I, II, and III
statuses unchanged and does not claim completion of broader lifecycle,
cross-store, deployment, identity, or compiler-quality work.

Root authoritative verification then completed the child
`bun test --parallel=1 --timeout 30000` with exit 0,
`CAPTURE_BYTES=1397838`, and its unique terminal summary: 5,337 tests / 489
files / 5,301 pass / 36 skip / zero fail / 35,247 assertions / 552.08 seconds.
The initial sandbox-local temporary capture wrapper hit child-spawn EPERM. The
approved sandbox-external identical wrapper captured the complete successful
child, then itself returned 1 only because its post-capture comparison did not
trim the leading space in ` 0 fail`; this wrapper defect is not product-test
failure evidence, and the temporary file was deleted. The root unwired probe
also exited 0 at 41 no callers / 78 test-only / 30 should-private. Final
standard preflight remains pending. These facts leave Checkpoint I, II, and III
statuses unchanged.

## Runtime correction: closed-session reader and mutator authority (2026-10-07)

This is a bounded runtime authority correction, not checkpoint movement. A
retained `CareerStoreReadFacade` expires when its issuing `GameSession` closes:
its seven readers reject but the underlying Career persistence remains, and
separately caller-owned raw storage stays caller-owned. The shared GameSession
mutation guard rejects closure before all existing guarded public mutation
routes can begin their distinct side effects. The public contract preserves
normal idempotent close, fail-stop's unavailable result, live durable identity
priority, and ordinary snapshot restore's existing lifecycle diagnostic.

A closed database exception is not lifecycle admission evidence; the session
checks lifecycle before it reaches a backend. Directed evidence used real
stored Career data and direct message/Luck/SAN paths plus real guard removals.
Root combined focused verification exited 0 at 119 tests / 6 files / 0 fail /
725 assertions; root typecheck exited 0 and probe-unwired exited 0 at 41 no
callers. The authoritative full suite ran sandbox-external only because
sandbox-local `Bun.spawn` hit EPERM, then exited 0 at 5,341 tests / 490 files /
5,305 pass / 36 skip / 0 fail / 35,296 assertions / 457.17s, with 271,203
stdout bytes and 1,249,777 stderr bytes.

This does not change Checkpoint I, II, or III status, and does not close
cross-store transactions, multiwriter/crash handling, deployment, or broader
production quality. Authoritative full-suite evidence is complete; standard
preflight remains pending.

## Bounded runtime correction: GameSession world-facade lifecycle (2026-10-07)

Retained `GameSession.world` readers now pass through one issuer-lifecycle
resolver before any raw WorldStateManager dispatch. This makes closure a
stable capability result rather than a coincidental SQLite teardown error,
including for pure or cache-backed readers. The facade's frozen null-prototype
shape, reviewed read allowlist, and session-owned raw-close behavior remain
unchanged. This is a bounded runtime correction only: it does not alter
Checkpoint I, II, or III, and does not claim cross-store, multiwriter,
crash-recovery, deployment, authentication, or compiler-quality completion.

## Correction: now needs bounded failed-child diagnostics (2026-10-07)

`now` already used the shared asynchronous full-suite evidence boundary, but
its red path rendered only `TestRunEvidence.reason` and silently discarded
`TestRunEvidence.output`. The first observed refresh therefore exited zero as
the document writer while its internal suite exited one, leaving only
`bun test 退出码 1` in the red snapshot. That is a failed child result, but not a
diagnosis and not evidence for a product-code change.

The bounded correction reuses `boundedBunFailureDiagnostics` from the shared
source scan: on red evidence, now prints the existing capped failing-test
identity and nearby error/expected/received context after it writes the
snapshot. It neither replays bulk captured output nor changes the established
meaning of outer zero. The old implementation and a mutation removing that
projection each made the focused test red at 83 pass / 1 fail; exact
restoration passed 84 / 0 / 473 assertions and typecheck zero. A subsequent
same-worktree refresh exited zero with its child suite green at 5,342 tests /
490 files. Because the first failure did not reproduce, this closes only the
bounded diagnostic omission and does not claim repair of a product test.

This leaves Checkpoint I, II, and III unchanged and does not close todo-65,
the production-quality goal, or any broader process-capture, deployment, or
runtime boundary.

## Bounded runtime authority correction: retire GameSession setScene writer (2026-10-07)

The former public `GameSession.setScene` forwarding writer is retired. The
private canonical activation path remains the authority used by real `act`
movement and compiled load/restore synchronization, so this change does not
move or duplicate compiler ownership. A public active-scene-only writer was an
unsafe compatibility surface: it could switch the active scene while leaving
the player entity at the old position, splitting downstream scene and player
cohorts.

Fixture setup is deliberately not a reason to retain that production surface.
Test-only code may capture the test session's registered raw world and arrange
an active scene; it cannot be exported as a production writer. Product
semantics continue to prefer real actions. Prototype and own same-name decoys
are regression controls, not API restoration: canonical act/load/restore must
ignore them.

This is a bounded runtime authority repair. Checkpoint I, II, and III remain
unchanged; it does not close compiler admission, artifact persistence, public
compiler APIs, cross-store durability, multiwriter/crash recovery, deployment,
authentication, or the broader production-quality goal.

## Bounded production correction: Career leaf-lock dead-owner recovery (2026-10-07)

Character-leaf crash recovery now applies only when the managed Career root is
on a Windows fixed-local volume and its existing exact root fence is already
held. A leaf record binds token, PID, and creation FILETIME; dead/reused-owner
reclaim repeats liveness and raw/dev/inode checks at the unlink boundary. The
real kill-to-fresh-process regression, raw-token mutation, live-owner control,
invalid-record controls, and competitor-replacement control define this narrow
claim. Non-Windows and network/NFS/SMB roots, real power-loss, cross-store
atomicity, broader multiwriter behavior, and deployment remain open. This is
not a Checkpoint I, II, or III status change.

## Bounded production correction: NPCAgent private memory/state dispatch (2026-10-07)

This records a runtime correction alongside, not inside, the compiler plan.
NPCAgent internal response, interaction, combat, and horror paths now use
private memory/state helpers and one private append-memory core; their
remaining public methods remain compatibility forwarders. Public persistState
was deleted after the first standard preflight found it had no callers, while
#persistState remains private. Real GameSession coverage proves a
dialogue still returns while public memory wrappers are replaced with throws,
and checks both exact durable NPCStore memory and the portable ordinary
snapshot's live agent memory. Red controls restored public wrapper dispatch or
a SQLite-only append and reproduced the intended failures. The recorded serial
suite was 5,352 tests / 491 files / 5,316 pass / 36 skip / zero fail.

This is a bounded production correction only. It does not change the scope or
status of Checkpoint I, II, or III, introduce a compiler API, or close CLI
compatibility wrappers, NPCStore failure atomicity/degradation, cross-store or
multiwriter behavior, power-loss recovery, deployment, authentication, or
external-model quality.

The preflight red is recorded as a bounded production correction, not flaky
noise: boolean implementations 336 / discarded returns 0, references 3 / 8 /
1 / 3, typecheck 0, 5,352 tests / 491 files green, and `.githooks` passed;
only no-callers was 41 versus baseline 40. The exact probe identified public
`NPCAgent.persistState` with no production or test call site; descriptor
patching is not a caller. The correction deletes that shell rather than adding
a synthetic test caller or moving the baseline. Root then verified the
correction: 167 directed tests / 8 files / zero fail / 874 assertions,
typecheck zero, probe exit zero at 40 no-callers / 81 test-only / 26
should-private, and scoped diff-check zero with only the CRLF notice. Standard
preflight EXIT=0 with boolean implementations 336 / discarded returns 0,
references 3 generated / 8 handwritten / 1 structured / 3 reverse, typecheck
zero, exact 5,352 tests / 491 files and 40 unwired baselines, and `.githooks`.
Checkpoint I, II, and III scope and status are unchanged.

## Bounded production correction: NPCAgent memory append atomicity (2026-10-07)

This runtime correction records one bounded durable memory boundary alongside
the compiler plan. NPCStore keeps memory INSERT, count, and the existing
over-200 retention delete in a private SQLite transaction; NPCAgent calculates
a detached live cache and publishes it with revision only after durable commit.
Real insert/delete triggers cover rollback, including `sqlite_sequence`; real
GameSession talk with a caller-owned store distinguishes existing template
fallback from rejected storage failure. The read facade gains no writer. The
public `pruneMemories` shell became uncalled under private transaction
ownership, so it was deleted instead of creating a synthetic caller or moving
the unwired baseline. Root evidence records 71 directed tests / 9 files / zero
fail / 429 assertions, then 35 / 5 / zero fail / 189 after retirement; the
authoritative serial child passed 5,361 tests / 492 files / 5,325 pass / 36
skip / zero fail.

This is not a complete NPC state transaction: `updateState` after a successful
memory append, relationship and recordInteraction atomicity, CLI fanout,
cross-store/multiwriter/power-loss behavior, deployment, authentication, and
external-model quality remain open. Checkpoint I, II, and III scope and status
are unchanged.

## Bounded runtime correction: unified NPC transition and CLI fanout (2026-10-08)

This is a runtime correction alongside the compiler plan, not a compiler-plan
checkpoint advance. A single NPC runtime transition now treats mood,
relationship, and recordInteraction as one expected-to-next durable unit:
optional mood-event memory and retention, player-relationship update, and
`npc_states` upsert commit in one SQLite transaction after durable pre-state
validation. The agent computes detached live state first and publishes it once
only after the transaction succeeds; no-DB follows the same plan. This
supersedes only the old statement that state, relationship, and
recordInteraction remained outside the memory-append boundary.

CLI fanout is separately bounded through a lexical Registry WeakMap host and
private token, canonical clones and Map-key identity, sealed PlayerSession/NPC
plans, one NPCStore batch transaction, and ECMAScript-private post-durable
publication. The readonly-TypeScript post-SQL failure counterexample confirms
that compile-time annotations are not runtime authority. Mixed stores fail
closed rather than claiming a distributed transaction.

The two closures add 31 tests in one file. Directed evidence was 92 tests / 7
files / zero fail / 616 assertions, agent-directed evidence 115 / zero fail /
608 assertions, and typecheck zero. The sandbox-external full suite exited
zero: 5,392 tests / 493 files / 5,356 pass / 36 skip / zero fail / 35,604
assertions / 568.75s. Checkpoint I, II, and III scope and status remain
unchanged. SQLite-to-PlayerSession process-crash ACID, cross-store/multiwriter
and power-loss behavior, broader wrapper retirement, deployment,
authentication, and external-model quality remain open.

## Bounded runtime correction: retained NPC projection and receipt completion (2026-10-08)

This is an ordinary-runtime correction alongside the compiler plan. It does
not change Checkpoint I, II, or III scope or status, and does not claim entry
into a later compiler milestone. AgentRegistry now receives its NPCStore at
construction and keeps it private; public `setDB` is gone, so an own
same-named setter cannot redirect the real dependency.

Ordinary snapshot export validates its active registry/NPCStore cohort on all
wire versions 1.0 through 1.4: the runtime memory multiset is a subset of the
durable multiset, mood/relationship/interaction-count agree, a personality row
uses the runtime name as its id, and every nonzero relationship has its player
row. `remember`, memory-bearing runtime transitions, and CLI batch fanout
derive live memory from the post-retention durable multiset inside the SQLite
transaction; the no-DB retention bound is 40. CLI receipt lookup, uniqueness,
binding, and consumer completion all run in that same callback before commit.
A consumer exception consequently rolls back database writes and sequence as
well as the unpublished live/registry/session cohort.

The directed record is 89 tests / 5 files / zero fail / 484 assertions,
typecheck zero, and probe 39 no-callers / 86 test-only / 26 should-private.
The full suite was 5,405 tests / 494 files / 5,369 pass / 36 skip / zero fail
in 587.90s. Restoring `setDB`, removing the cohort guards, projecting the
candidate rather than retained set, or completing after commit each made the
real regressions red and was exactly restored. One explicit P2 remains: a
successful `remember` that retention completely removes still advances
registry semanticRevision once as conservative invalidation; no durable/live
split is claimed. Cross-store, multiwriter, crash/power-loss, deployment,
authentication, and external-model boundaries remain open.

## Bounded runtime correction: closed reads and snapshot idempotency (2026-10-08)

This is runtime hardening alongside the compiler plan. It does not change the
scope or status of Checkpoint I (hints through accepted MechanicsIR and
closed-world/P4), Checkpoint II (local artifact save/restore), or Checkpoint III
(public compiler end-to-end validation over in-memory fixtures and real PDF
bytes). GameSession now revokes all session-bound dynamic readers and retained
facade calls after close or fail-stop, including party-member SAN and compiled
mechanics/generation/action/player projections. Static diagnostic identity and
immutable caller-owned component references remain intentionally distinguishable
from session capability.

Compiled snapshot validation treats its idempotency array as an ordered ledger,
not input to a last-write-wins Map: every `actionId` is globally unique and
trim-canonical before restore materializes receipts. Re-signed duplicate and
whitespace-padded records fail direct validation and restore without changing
the target. The lifecycle guard's no-op mutation produced six failures and the
retained party-SAN resolver mutation one; removing duplicate or trim validation
also made the exact ledger regressions red. After a real initial full-run red at
eight closed-reader/`runAction` boundary failures, the repaired suite passed
5,411 tests / 494 files / 5,375 pass / 36 skip / zero fail / 35,946 assertions;
typecheck was zero and the directed set was 144 passing tests across 13 files.

The final standard external preflight also exited zero: boolean
implementations/discarded returns were 336/0; generated-document references,
handwritten payloads, and structured payloads were 3/8/1; typecheck was zero;
the 5,411 / 494 test and 39 unwiredMethods baselines matched; and
`core.hooksPath` remained `.githooks`.

## Bounded P1 production hardening close: public research, claims, and restore admission (2026-10-08)

This is a bounded operational hardening close beside the existing Checkpoint I
work, not a declaration that a compiler checkpoint, `todo-64`, `todo-65`, or
the production-quality goal is complete. It does not advance Checkpoint II or
III.

The public source/slot research path now gives a binding its full lifecycle
identity before caching: both ready and rejected results are cached by the
complete binding. Unknown source work IDs resolve through a prebuilt O(1) Map,
not repeated filtering. First unauthenticated reads accept absolute regular
inputs only, observe size exactly across the read race, and bound source files
at 16 MiB each with 1,024 manifest entries and 8,192 records. Slot reads bound
the manifest/index/artifact/aggregate at 4 MiB/1 MiB/16 MiB/64 MiB and the
manifest/bindings/JSONL cardinalities at 1,024/128/8,192. Proposal and dossier
are read once per request rather than through separate inspection and use
passes. External opt-in smoke coverage remains intentionally skipped.

Invitation claim is an authentication boundary, not a hydration side effect:
its pure preauthentication happens before namespace, catalog, registry,
factory, or hydration work. The real immutable-grant A-to-B cases corrected a
bad premise: snapshot access cannot switch to a different-grant successor.
Instead they prove pre-hydration staleness refuses before a claim, and
claim-boundary staleness yields neither a cookie nor installation while the
same immutable invite can be retried safely. For a replayed claim, both an
equal existing record and an EEXIST loser must fsync the directory before a
cookie is issued; sync failure refuses and a healthy retry repairs. Windows
EINVAL/EPERM directory-fsync limitations and temporary/expired-claim cleanup
remain deliberately open.

Ordinary-world restoration now treats `player_state` as a cohort ledger: its
ID set must exactly equal the PlayerSession player set in every supported
schema. The p1 pre-character placeholder remains legal, but re-signed future
p2 or foreign rows refuse before restore. The old foreign-row negative test
was corrected to this unchanged invariant rather than weakening the guard.

The red controls were substantive: cache-key rotation failed two cases, the
former unknown-source filter one, and the source-size guard one; removing claim
preauth, replay directory fsync, or exact-player-set validation also failed.
The first full 5,439 run had a single obsolete foreign-row expectation failure,
not a product regression; the corrected 11-test target was green before the
final run. Directed evidence was 135 pass / 2 skip / 0 fail / 1,174 assertions
across 11 files, with claim 10/175, pickup 11/106, and typecheck zero. Final
`bun test` was 5,439 tests / 494 files / 5,403 pass / 36 skip / 0 fail / 36,163
assertions in 710.16s: +15 tests and passes over 5,424 / 494 / 5,388 / 36.

Standard `bun scripts/preflight.ts` EXIT=0: boolean implementations/discarded
returns were 340/0; generated/handwritten/structured/reverse document checks
were 3/8/1/3; internal typecheck was zero; the exact 5,439 / 494 test and 39
unwiredMethods baselines matched; and `core.hooksPath=.githooks` with the
commit-msg criterion ran. `docs/notes/index.json` and `docs/architecture.json`
remain intentionally unrefreshed because they have parallel changes.

## P1 production hardening: player preauthentication and post-lease authority fence (2026-10-08)

This is a bounded production repair alongside the plan; it does not alter the
scope or status of Checkpoint I, II, or III, and it does not complete the
broader production-quality goal.

The compiled player facade now treats `GET /player-view`, `POST
/player-actions`, and the unified player-intents path as authentication
boundaries before namespace, catalog, registry, factory, or body work. A
snapshot/header locator plus delivery cookie or legacy bearer must establish
the grant first. Missing or invalid grants return `401` with `no-store`; a
valid but foreign legacy bearer returns `403`; both paths make no later touch.
If recovery or adoption yields a winner, identity and authority are checked
again against that winner rather than trusting a preliminary lookup.

An ordinary action's cross-process lease serializes the holder but cannot make
the authority pointer observed before acquisition fresh. After acquire and
before candidate derivation or any provider call, the holder rereads durable
authority and compares exact namespace, generation, envelope hash, and
snapshot hash. A newer authority yields durable replay only for the same
action/hash; a different action at that latest generation returns `409`.
Unreadable authority is `503` fail-closed. Stale sources close/restore exactly,
and `finally` releases both lease and timer.

The combined directed suite exited zero at 97 passes / 6 files / 1,254
assertions; the target handoff was 1 pass / 25 assertions; and typecheck was
zero. Full `bun test` exited zero: 5,424 tests / 494 files / 5,388 pass / 36
skip / zero fail / 36,154 assertions / 676.77s, an uplift of one test and one
pass with files, skips, and failures unchanged. Restoring intents-only
preauthentication made the target fail with a `404` and later-touch evidence;
deleting the post-acquire fence raised handoff provider calls from zero to one.
Both mutations were restored exactly.

Open follow-ups remain public source/slot repeated synchronous
load/hash/parse DoS, invitation-claim pre-hydration, stronger snapshot A→B
TOCTOU coverage, and ordinary `player_state` exact-ID-set validation.

The final standard `bun scripts/preflight.ts` exited zero: boolean
implementations/discarded returns were 339/0; generated/handwritten/structured
/reverse document checks were 3/8/1/3; internal typecheck was zero; the exact
5,424 / 494 test and 39 unwiredMethods baselines matched; and
`core.hooksPath=.githooks` with the commit-msg criterion running.

This does not establish provider exactly-once, cross-store/multiwriter
atomicity, power-loss recovery, deployment, authentication, external-model
quality, or the broader production-quality goal.

## Bounded runtime hardening: retained listings, loader source pins, and zero-timeout contention (2026-10-08)

This records runtime hardening alongside the compiler plan; it does not advance
Checkpoint I, II, or III. Retained registry cleanup/listing now classifies
immutable durable diagnostics: a closed durable ordinary listing restores its
envelope source before replacing source, cleanup evicts only in-memory state
without deleting durable metadata, and a closed durable compiled member in a
mixed partition returns fixed `session_unavailable` without internal leakage or
blocking healthy peers.

Shared `WorldModelLoader` instances are now source-pinned by a module-private
WeakMap. Once a loader binds a canonical source path, a different canonical
source is refused before either reads or clearing state with a stable path-free
error. Same-canonical aliases still work, independent loaders remain free to
load A then B, and missing or malformed input retains its former
clear-on-failure behavior.

The related contention change is a test-premise correction, not a retry-policy
change. `SessionNamespaceCoordinator` still uses `busy_timeout=0` and its API
still exposes typed 503 Retry-After without hidden retry. Under that policy two
simultaneous raw reserves may both return typed BUSY, so a sound test permits at
most one winner, requires BUSY/CONFLICT losers, requires an explicit reserved
retry when none wins, and checks final same-kind and different-kind CONFLICT.
Each corrected case passed 100 repetitions; no product behavior changed.

Directed evidence was 153 passes across 10 files with zero failure and 1,057
assertions; typecheck exited zero. The authoritative suite exited zero at 5,415
tests / 494 files / 5,379 pass / 36 skip / zero fail / 35,963 assertions in
574.38s. This does not claim provider exactly-once, cross-store or
cross-process atomicity, multiwriter/crash/power-loss recovery, deployment,
authentication, external-model quality, or broader production-goal completion.

## Checkpoint I repair closeout: trusted compiled-session admission (2026-10-08)

This repair remains in Checkpoint I: source hints through accepted MechanicsIR,
then closed-world analysis and P4 execution semantics. Checkpoint II remains
the local artifact save/restore boundary. Checkpoint III remains the public
compiler-entry boundary over in-memory pages/fixtures and real PDF bytes.
Neither is entered or advanced here. GameSession runtime integration is a
later milestone; a lifecycle regression at its boundary is not evidence that
the runtime milestone is accepted.

Public compiled-session admission is now `bundleId`-only, but an ID is not an
authority witness by itself. Admission requires the persisted, server-owned
trusted-presentation review bound to that bundle and an exact-source replay of
the canonical bundle. Request-authored presentation, a detached review, or a
replay whose source bindings do not match cannot publish a compiled session.
Catalog HTTP failures likewise expose only the stable public failure shape;
they do not disclose internal catalog errors or source-bearing diagnostics.

The opening path has an explicit close-during-await lifecycle fence: work that
started before an asynchronous boundary cannot publish its opening after the
session has closed. The CLI `runModule` path takes an isolated source clone at
its session boundary, so execution cannot retain or mutate the caller's module
source through an alias.

The acceptance tests used real mutations: removing the persisted trusted-review
witness or exact-source replay, weakening catalog HTTP redaction, removing the
post-await publication fence, or restoring CLI source aliasing made the
corresponding regressions red; each mutation was restored before the green run.
The final full suite was 5,423 tests / 494 files / 5,387 pass / 36 skip / 0
fail. This records only the current Checkpoint I repair. It does not mark
`todo-64` or `todo-65` as wholly complete, and it does not enter Checkpoint II
or III.

The final standard preflight also exited zero: boolean-returning
implementations/discarded returns were 339/0; generated, handwritten,
structured, and reverse document checks were 3/8/1/3; internal typecheck was
zero; the exact 5,423 / 494 test and 39 unwiredMethods baselines matched; and
`core.hooksPath` remained `.githooks`.

## Bounded invitation-claim schema v2 hardening (2026-10-08)

This is a narrowly scoped delivery-record hardening change in
`src/api/player-delivery.ts`; it does not advance Checkpoint I, II, or III and
does not complete `todo-64`, `todo-65`, or the broader production-quality
goal. New claims use strict schema `2.0.0` with an exact key set and safe,
positive integer timestamps. The durable claim stores the immutable grant's
exact `expiresAt` as `inviteExpiresAt`, rather than recalculating an expiry
from the claimant process's current invitation-TTL configuration. In the
cross-configuration case, a claim issued under A's 600-second TTL retains A's
exact expiry when B is configured for 60 seconds.

V2 replay, race resolution, and authentication all bind the same exact
`inviteExpiresAt`. Cookie lifetime is a separate capability lifetime: a valid
cookie may continue after the invitation expires until `cookieExpiresAt`.
Cookie expiry is deliberately outside replay equality and cannot extend either
the invitation-bound durable claim or a newly issued cookie. This keeps replay
identity immutable rather than making it depend on the time remaining for a
previous cookie.

The exact legacy five-key v1 record remains readable and authenticable. It is
replayable only for the same digest and `claimId`, rejects a different claim,
and is neither rewritten nor silently upgraded. V1's missing independent
invitation-expiry fact means it is not safe to garbage-collect it from a cookie
expiry alone.

The dedicated regression exited zero at 11 passes / 207 assertions, and
typecheck exited zero. Real red controls restored a
coherent v1-only new-write path (the new regression failed with schema `1.0.0`
and no `inviteExpiresAt`) and restored current-process TTL-derived expiry (the
regression expected `1700000600000` and received `1700000060000`); exact
restoration returned both to green. The authoritative complete suite exited
zero at 5,440 tests / 494 files / 5,404 pass / 36 skip / zero fail / 36,222
assertions in 704.38s. The final standard `bun scripts/preflight.ts` exited
zero: boolean implementations/discarded returns were 340/0;
generated/handwritten/structured/reverse document checks were 3/8/1/3;
internal typecheck exited zero; the exact 5,440 / 494 test and 39
unwiredMethods baselines matched; and `core.hooksPath=.githooks` with the
commit-msg criterion ran.

This does **not** implement claim garbage collection, scanning, locking, or
startup integration. Two independent audit findings remain: the claim root has
no quota, bounded enumeration, or cross-process mutual exclusion; and its
temporary files can accumulate unbounded crash leftovers. Future v2 deletion
must be no earlier than `max(cookieExpiresAt, inviteExpiresAt)`, while v1
cannot be safely deleted on `cookieExpiresAt`. Even then it needs a safe
bounded scan, root/leaf identity checks without reparsing, a shared
cross-process coordinator, directory fsync after unlink, and
operator-owned startup integration. Schema v2 therefore is not evidence that
GC is safe or complete.

## Bounded two-module validation record (2026-10-09)

The root-directed targeted suite passed 45 tests in 7 files with 639
assertions; typecheck exited zero. Restored red-to-green controls covered the
hardcoded backstory `他`, Barn source-free preparation, inferred-adult
provenance, and the random-KP fallback. This is narrow regression evidence,
not a production-quality or external-model-quality acceptance.

Barn's ordinary `GameSession` stayed safe offline, while its live attempt
returned fallback output and makes no real-quality claim. Fuzu correctly
refused the old graph-1.0.0 artifact. The former current-schema script failure
was reproduced as a detached frozen `activeCharacter` write and then repaired
**only** in the benchmark script: its owned ordinary snapshot now uses the
legal `medicine` seed rather than synthetic `idea`; deterministic d100 behavior
and production guards are unchanged.

The fresh current-PDF guarded CLI exits 0; helper import is safe and the joint
typecheck exits 0. The exported `compileCurrentFuzuAcceptance` is
benchmark-only, not a production entry point, and temporary cleanup remains.
The local no-provider aggregate is 22 scene candidates / 3 clues / 3 items / 32
NPC anchors / 197 questions; 50 tracked plus 9 reviewed answers; deterministic
fake input in 3 requests / 46 calls gives 195 answered / 0 open / 2
not-applicable. The runtime has 6 playable scenes, 7 clues with methods, 1
item, 2 NPCs, 1 dialogue, 2 endings, 227 states, 0 blockers, and 0 issues. Two
`GameSession` ending witnesses use 5 actions with the stone and 4 without it;
artifact hash is
`29e86f602e37a11672bdd6f812b1387535c41dfae9193a87dbaaaa2983780644`.

The diagnostic no longer depends on old JSON. Its fresh local offline,
escalated report (`omqxGw`) succeeded with zero provider requests: Barn was
sampled through the verified `premiers_barn` ordinary runtime with
`not_real_model` quality; Fuzu was sampled through the compiled runtime from
the current-PDF benchmark hints, with the artifact above and two reachable
endings. Fuzu contextual narration remains unsupported and its quality remains
incomplete; this local benchmark is not evidence of a production autonomous
model. Old physical files were retained rather than deleted.

External retry was denied without source-upload consent; no workaround or
endpoint status is recorded. Pre-change preflight exit 1 remains baseline-only
evidence (5,448 tests / 497 files / 5,410 pass / 38 skip; typecheck zero;
unwiredMethods 39).

Root's authoritative full `bun test` exited 0: 5,470 tests / 501 files /
5,432 pass / 38 skip / 0 fail / 36,736 assertions / 553.58s. This is a shared
dirty worktree delta of +30 tests / +7 files / +28 pass / +2 skip over 5,440 /
494 / 5,404 / 36, not a claim that all additions belong to this slice. The 38
skips are 32 retired `old32state` cases, four unverified Windows
symlink/junction-capability cases (`derivedLockSymlink`, `rootFileSymlink`,
`rootDirectoryJunction`, `suppliedRootJunction`), and two opt-in cases
(`worldModelManifest`, `sourceArtifact`). The prior 36-skip capability mix was
not rebuilt, so no skip-coverage equivalence is claimed. The full run began
before the identity assertion was strengthened; root separately ran the late
harness, EXIT=0: 7 pass / 1 file / 14 assertions.

Post-update standard preflight job 83536 exited 0: the 5,470-test / 501-file
baseline matched, internal typecheck exited 0, `unwiredMethods` remained 39,
boolean implementations/discarded returns were 346/0, and hooks ran normally.
The final broad targeted run hit Windows sandbox Bun-child `EPERM` only in two
wiring cases (48 pass / 2 fail); that wiring file alone passed 5 tests, and the
same eight-file command under normal escalation exited 0 at 50 pass / 651
assertions. `todo-52`, `todo-64`, `todo-65`, and the wider production goal
remain open. Notes/index and architecture refreshes are deferred because of
parallel changes; no generated now/handoff, commit, or push was made.

## Authorized two-PDF probe correction (2026-10-09)

The user explicitly authorized the necessary context from both supplied PDFs to
the configured API for this bounded probe; no endpoint, key, or request content
is recorded here. Source preflight job 50907 exited 0 at the then-current
5,470-test / 501-file baseline, with typecheck 0 and `unwiredMethods` 39.

The first real provider probe (`5m6EIw`) made six provider requests. Its Barn
entry was verified as `特里坎家`, but the opening described an invented office,
ledger, and bookshelf. Source audit found that `GameSession` always left the
KP directive empty and never wired the canonical public description. The
current scoped repair synchronizes that description privately for opening and
action prompts; `openingAtmosphere` is opening-only. It deliberately excludes
hidden clues, NPC secrets, and KP notes, and does not mutate world state. The
wiring began red at 3/6, passed 6/6 after the repair, failed 5/6 when the
opening synchronization was removed, and returned to 6/6; existing lifecycle
coverage remains 8/8. Network success alone is not grounded-quality evidence.

The real compiler probe initially exited 0 but made zero calls with
`PREPARE_PDF_INVALID`: it parsed the PDF bytes, detached them, then attempted
to prepare them again. The same harness made that defect red at 4/1; preparing
the retained entry made it green at 5/30; restoring the old source made it red
again at 4/1 before final restoration. The strict SHA gate, budget, and
identity checks remain unchanged. In the real after-compiler run, Fuzu made 9
calls / received 2 responses / accepted 3 answers (3 answered, 192 open, 2
deferred, 197 total) before `operation_aborted`; Barn made 8 calls / received
2 responses / accepted 0 answers (0 answered, 384 open, 26 deferred, 410
total) and refused `RESOLVE_NOT_PUBLISHABLE`. Both results are draft-only,
not closed, have zero ending witnesses; the identity checks recorded two
refusals and two unique modules/documents. Many calls hit the 15-second
timeout, so these outcomes do not directly establish low model quality and do
not justify increasing the current budget.

The real after-narrative report (`H0roUh`) made five provider requests and hit
the 180-second global deadline. Barn's provider opening now described the
source-compatible villa basketball court, parasols, chairs, and trailer. Its
look action is still unsupported for the observed metal grill, interior
furniture, and piled items; this is not a strict-grounding claim or a claim
beyond the earlier logs. NPC output remains provider-unobservable or fallback
and is not accepted. Fuzu remains a current-PDF benchmark-mechanics path with
contextual narration unsupported. The old physical artifact was not deleted;
the diagnostic merely no longer depends on it.

The root-directed final targeted suite exited 0 at 56 tests / 9 files / 681
assertions, with typecheck 0. The two-test increment is the wiring 5→6 and
compiler harness 4→5 coverage. The final full suite (46544) is still running;
the 5,470 baseline is not updated early, post-preflight remains pending, and
the wider production goal remains open. No staging, commit, or push occurred.

## Full-suite verification correction (2026-10-09)

Root's real full `bun test` session 46544 exited 0: 5,472 tests across 501
files, 5,434 pass, 38 skip, 0 fail, and 36,746 `expect()` calls in 862.43s.
`docs/test-baseline.json` now records exactly 5,472 / 501 / 5,434 / 38 / 0
with the unchanged 39 `unwiredMethods` ceiling. The increase is exactly two
tests and two passes with no new files or skip change: the real-model
two-module acceptance harness went 4→5 and the KP narration-constraint wiring
went 5→6. Earlier history is retained. Post-change standard preflight session
26601 exited 0: boolean implementations/discarded returns were 346/0;
generated/handwritten/structured/reverse document checks were 3/8/1/3;
typecheck exited 0; the exact 5,472-test / 501-file and `unwiredMethods` 39
baselines matched; and `core.hooksPath=.githooks` with the commit-msg criterion
ran. The production goal remains open: autonomous compiler output is
draft-only, NPC quality is unverified, and compiled contextual narration is
unsupported. No staging, commit, or push was made.

## Bounded two-module compiler probe: final frozen record (2026-10-09)

The source prompt/diagnostic slice is frozen after final directed verification:
62 tests across 6 files, 529 assertions, and EXIT=0; root typecheck also
exited 0. It corrects the ordinary
mechanics contract: an ending/discovery `spec.id` is a submitted, source-cited
mechanism declaration retained in accepted mechanics IR, not a compiler-rewritten
label. Server-derived runtime-ID restrictions remain limited to the automatic
`npc_binding`, `clue_fact_facets`, and `source_fact_mechanic` subsets. The
sanitized live report now distinguishes the adapter's approved stage categories
but emits only stage/code/count; unknown codes collapse to `other`, rather than
recording diagnostic messages, source identifiers, prompts, or responses.

The authorized final compiler probe 38730 completed its native/capture process
with EXIT=0 and a complete sanitized summary. It made 18 external calls under
the existing bounded budget and preserved one isolation pair with two identity
refusals, two unique modules, and two unique documents. Fuzu had 197 questions:
7 answered / 188 open / 2 deferred, 7 accepted, 9 calls, and 3 responses. It
remained draft-only, was not closed, and had zero ending witnesses after
`operation_aborted`. Barn had 410 questions: 8 answered / 377 open / 25
deferred, 8 accepted, 9 calls, and 3 responses; it also remained draft-only,
not closed, with zero ending witnesses. Fuzu diagnostics were chunking
`max_model_requests_reached` 139, model `llm_call_failed` 5, and one
orchestrator abort. Barn diagnostics were chunking request-limit 286 plus
oversize 2, model failure 5, proposal `other` 1, and one orchestrator abort.
The surfaced provider failures were timeouts.

This is a bounded progress probe, not a statistical quality result or a
full-coverage autonomous compilation: six total responses cannot close the
197/410-question queues, and both reports are draft-only. The prior 9877 native
EXIT=0 has no retained detailed summary because its collector matched only a
standalone `{` and missed the CLI's one-line JSON; it is not used to infer calls
or quality. A later offline capture correctly reported two modules and zero
external calls, but is only a capture check, not live evidence. The baseline
was 5,472 tests / 501 files before the final run. Root full-suite session 4567
subsequently exited 0: 5,486 tests / 502 files / 5,448 pass / 38 skip / 0 fail
/ 36,919 assertions in 741.23s. That is +14 tests / +1 file / +14 pass, with
skips unchanged; the new file is `npc-memory-provenance`, while additions are
concentrated in adapter citation/diagnostic aggregation, receipt focus, and
loader source-knowledge validation. Standard preflight 44873 subsequently
exited 0: boolean implementations/discarded returns 349/0;
generated/handwritten/structured/reverse document references 3/8/1/3;
typecheck 0; exact 5,486 tests / 502 files and `unwiredMethods` 39 matched the
baseline; and `core.hooksPath=.githooks` with commit-msg ran. This validates
only the currently frozen source hash, not the next narration feature. No
budget increase, staging, commit, or push occurred.

The adjacent NPC initial-knowledge bridge has only its own narrow evidence:
20 tests / 181 assertions, with three real mutations turned red and restored
green. Review still requires background-fact availability, arbitrary
parenthesized alias, and knowledge-array validation. The current focus
diagnostic remains offline-only (13 passes / 1 file / 44 assertions); its
provider-receipt mutation was restored after the expected two failures. A real
focus attempt was rejected at permission review before any external request;
it awaits explicit consent to send both PDFs to the configured external model.
Global guidance has not been trimmed and compiled contextual narration remains
unimplemented. `todo-52`, `todo-64`, `todo-65`, and the broader production
goal therefore remain open.

The bounded compiler probe's 7 accepted Fuzu answers and 8 accepted Barn
answers remain draft-only, not a completed autonomous compile. Directed
coverage included real adapter and NPC-provenance mutations made red and then
restored. The real NPC focus remains rejected at permission review before any
provider request; it awaits explicit consent to send both PDFs to the
configured external model. None of this completes the production goal.

## Next production gap: compiled player contextual narration (unimplemented)

Compiled player contextual narration is currently unsupported. The next scoped
production requirement is one bounded action path: durably retain the exact
mechanics candidate first, derive a player-safe before/after frame from that
candidate, and let only a host-held capability obtain model text behind a
generation/source/request/frame/candidate-identity fence. Candidate preparation
may contain random/date-dependent work and therefore must not be re-run during
recovery. Atomically commit the text receipt with the same candidate's
compare-and-swap snapshot transition. The frame must contain no private facts;
the receipt must bind the relevant generation, source, request, frame, and
candidate identities. A duplicate action or restart for the same `actionId`
must reuse the exact committed text rather than call the provider again.

The provider-to-snapshot uncertainty window must fail closed. If a request
finishes but no matching receipt/snapshot can be committed or recovered, the
runtime must not publish a template as though model narration succeeded. This
does not require another executor, world model, DSL, or a return of runtime
integration to Checkpoint III; it is a narrow durable action/receipt boundary.

Required red gates before this is treated as implemented:

- private information cannot enter the provider prompt or persisted response;
- malformed or otherwise invalid text cannot change action state;
- a receipt written before the action snapshot is recovered safely;
- duplicate and restarted delivery make zero additional provider calls and
  return the exact prior text;
- generation, request, player-safe-frame, or exact-candidate conflicts do not
  publish;
- abort, close, or lease loss does not publish or commit narration.

These are future implementation and acceptance requirements only. The source
slice remains frozen; root full-suite session 4567 has exited 0 as recorded
above. No new interface layer, permanent manual-approval rule, or completion
claim is created by this note.

## Bounded two-module/NPC verification closure (2026-10-09)

The frozen source slice has the full-suite and standard-preflight evidence
recorded above; it is not a production-goal completion. The compiler remains
draft-only and real NPC focus emitted no provider request because permission
review required more explicit consent for the two PDFs. `docs/notes/engine.md`
contains the new bounded compiler, NPC, and focus records, but
`docs/notes/index.json` is intentionally stale; `docs/architecture.json` has
parallel work and was not refreshed. Root refreshed now/handoff with the
existing `--no-test` script: the initial sandbox Git-spawn EPERM was followed
by a normal approved run with EXIT=0, without configuration changes. The
preflight validates the old frozen source hash only; the candidate/receipt/CAS
plan above has not been implemented or accepted.

## Durable compiled player narration: implemented, awaiting acceptance (2026-10-10)

The preceding "unimplemented" candidate/receipt section is retained as the
historical design requirement. Its narrow production path is now implemented:
one player action prepares and durably records its exact mechanical successor
before a bounded provider call; the provider receives only a rebuilt
player-safe before/after frame; and the accepted text is a receipt consumed
through that same candidate's generation/CAS transition. A receipt or
committed row is replayed without another provider request, while a
prepared-only recovery remains tied to its exact generation, action, and
request lease. Mechanics-only durable records retain request-hash v1; the
narrated provider mode uses v2, preserving old mechanics snapshots.

Root's focused acceptance run is 15 tests / 3 files / 319 assertions, EXIT=0,
and current typecheck exited 0. The quick preflight also exited 0 but explicitly
does not run the full suite. Root's standard `bun test --parallel=1
--timeout30000` session 2419 then exited 0 with 5,500 tests / 504 files /
5,462 pass / 38 skip / 0 fail / 37,017 assertions in 1038.17s (+14 tests /
+2 files / +14 pass from 5,486 / 502 / 5,448; skips unchanged), so the test
baseline now records those counts. The separate default CLI session 74755 also
exited 0 with the same test/file/pass/skip/fail counts, but 37,063 assertions
in 954.91s. Standard preflight 92567 then exited 0: 355 boolean-returning
implementations / 0 discarded returns, document references 3 / 8 / 1 / 3,
internal typecheck 0, exact 5,500 tests / 504 files matching baseline,
unwiredMethods 39, and the `.githooks` hooksPath criterion ran. A separate
local Cthulhu scope smoke (36747) also exited 0: 29 tests / 3 files / 1,535
assertions in 13.26s. It used a process-temporary local data path, fake
provider, and fixture artifact scopes, not Fuzu/Barn production binding; it
changed neither `.env` nor external data. These results verify the frozen
5,500-test batch only. Main has since started worldguard-ownership work, which
they do not cover. This is therefore not an acceptance-complete or
production-goal-complete claim. Narrative era is only
source-reviewed frame context: an unknown era is omitted, and there is no
claim of semantic grounding of generated text. This change neither moves
Checkpoint II/III back into runtime nor creates a permanent PDF prohibition or
manual-approval rule. In the two-module diagnostic, the only actual
provider/NPC samples are two attributable Barn ordinary-`GameSession` replies
from four requests; Fuzu remains a benchmark contextual-narration-unsupported
path with no comparable model narration. Autonomous two-PDF publication, real
NPC/narrative quality evidence, and the unfinished `epilogues` and
`narrative.entities` work remain open.

## World-narration guard: bounded implementation verification (2026-10-10)

The player narration path now has a bounded world guard before receipt
publication/commit. It uses the action's permitted source and scene scope,
the reviewed era where present, and the player-visible before/after state; a
post-action discovered fact is not hidden merely because it was absent before
the action. This is a host guard on publication, not a claim that a finite
phrase list proves arbitrary free-text factual entailment. The ordinary NPC
first-turn prompt already had its global rule 5 fact/date boundary, so this
work does not recast a missing first-turn warning as the cause of provider
quality.

Root independently ran session 6167: 76 tests in 4 files, 0 failures, 504
assertions, EXIT=0 in 66.94s; root typecheck also exited 0. Six real
implementation mutations each went red (EXIT=1) and were restored green: the
server publication gate (422 to 503), before/after fact-union reduced to
after-only (the existing `空荡荡` case changed 422 to 200), removal of the new
`空无一物` coverage, ignored 1893 telephone-era handling, cross-scene technical
authorization (422 to 200), and a commit-gate bypass that advanced an otherwise
forbidden receipt from g0 to g1. The owner restored the source and froze this
slice.

This is not a complete grounded-generation or external-model-quality result.
The Fuzu 84119 diagnostic ended EXIT=1 with `slot_ambiguous` before HTTP and is
not counted as a core red mutation. Autonomous two-PDF publication, real
quality acceptance, and an actual production world-model binding remain open;
no permanent manual approval path is implied.

## Source-validated prose-fact projection correction (2026-10-10)

A safe Fuzu diagnostic reached a real publication boundary and found
`missing_binding clues.source_prose_clue_9eb469fd77a9a69824b7cec8.name`.
This was a plan/project mismatch, not missing human review: the trusted-review
plan already omitted slots for a canonical `prose_fact_finding`, because its
single selected source atom and its full source-only partition were accepted
and source-validated upstream. The minimal repair removes only the projection's
three impossible review-quote reads for that clue's name, description, and
revelation. It neither adds presentation slots nor changes the review plan.
The canonical display fields, source graph/evidence origin, fixed derived
finding mechanics, and source-only partition remain authoritative; this does
not make presentation review a second source selector.

The owner's in-memory `synthetic_pages` fixture invokes the real prepare →
queue/hints → resolve functions, but uses neither a PDF nor a model proposal.
That e2e was 10 pass / 1 fail / 99 assertions / EXIT=1 before the repair, then
11 pass / 0 fail / 113 assertions / EXIT=0. Restoring the three removed quote
requirements returned to 10 / 1 / 99 / EXIT=1; restoration returned to 11 / 0
/ 113 / EXIT=0. Root independently ran 19 pass / 2 files / 0 fail / 171
assertions in 2.63s with typecheck EXIT=0. The retained negatives cover forged
or foreign candidate/atom/quote, incomplete or duplicate source-only
partitions, wrong source scope/check/mechanics, artifact tampering, and review
bindings outside the plan. Multi-atom clue-facet display and per-atom
provenance remain canonical rather than being collapsed to one review quote.

Root's standard preflight 66130 was a before-fix terminal failure: 5,505
tests / 5,466 pass / 1 fail, at the Fuzu HTTP case line 232; typecheck was 0,
`unwiredMethods` was 39, and `.githooks` was correct. Its original file/skip
summary was not retained and is not inferred here. The owner initially ran the
focused Fuzu receipt case as 95678: 1 pass / 13 filtered / 0 fail / 6
assertions / 1 file / EXIT=0 in 199.97s. Removing the temporary duplicate
restore/project debug helper gave 94506 green in 194.60s. This exercises the
in-process `handleRequest` chain with a fake provider and no fetch; it is not a
TCP-listener or real-model result. It covers trusted publication plus receipt
duplicate/restart with one call and script-local g0→g1 checks.

An execution-path mutation (40971) made the first opaque-action POST then the
same-session GET view fail red as intended: 0 pass / 1 fail / 13 filtered / 2
assertions / EXIT=1 in 144.69s, with
`fuzu_http_narration_receipt_mismatch`, not a 404. Restoring the POST yielded
21209 green: 1 pass / 13 filtered / 0 fail / 6 assertions / EXIT=0 in 193.56s.
Root independently reran the elevated case as 68983: 1 pass / 1 file / 13
filtered / 0 fail / 6 assertions / EXIT=0 in 201.43s; the latest root
typecheck also exited 0. This diagnostic execution-path mutation is distinct
from the production-core three-review-quote mutation, whose separate e2e was
10 / 1 red then 11 / 0 green.

The focused case had a 240-second testcase allowance before the final owner
green. Bun's synchronous CPU work is not preempted, so that is not a hard
wall-clock limit. The live 180-second limit is an external-request admission
budget; offline `externalCalls=0` and `liveDeadline=false` do not prove a run
finishes in under 180 seconds. Root's default `bun test` 76180 then terminated
EXIT=0: 5,505 tests / 504 files / 5,467 pass / 38 skip / 0 fail / 37,129
assertions in 959.32s. This is +5 tests / +0 files / +5 pass over the
5,500 / 504 / 5,462 / 38 / 0 baseline, with skips unchanged and
`unwiredMethods` still 39. It is default `bun test`, not a `--parallel`
variant. The shared world-guard/Fuzu wave uses existing files; no unverified
per-case attribution is made. Root's final standard preflight 42057 terminated
EXIT=0: its full 5,505 / 504
test result matches the baseline; typecheck is 0, `unwiredMethods` is 39,
`.githooks` is correct, and boolean implementations/ignored returns are 360/0.
This final gate does not complete autonomous two-PDF publication, live quality,
real world binding, or the production goal. The separately started internal
HTTP campaign-runner batch is not covered by this evidence.

For follow-up sizing only, fresh pinned-PDF `--prepare` completed with
`externalCalls=0`: Fuzu has 197 total questions including 49
publish-blocking, and Barn has 410 including 130 publish-blocking. Both remain
closed=false; the result demonstrates fresh preparation and isolation, not
autonomous publication. The remaining legitimate draft warnings are not all
mandatory answers. The current pilot cap of 3 questions/request × 8 requests ×
2 rounds = 48 per module is below each blocking count, so it is not a complete
automatic-compilation acceptance. This is a dependency for later work, not a
reason to loosen limits or change a baseline. Autonomous two-PDF publication,
real model-quality acceptance, and actual production world-model binding remain
open.

## Internal two-module HTTP campaign workflow boundary (2026-10-10)

The two-file internal campaign runner is frozen with owner evidence of 16 pass
/ 78 assertions / EXIT=0 and typecheck 0. Root independently recorded 16 pass
/ 1 file / 78 assertions / EXIT=0 in 199ms and typecheck 0; final review also
passed. Its no-op predecessor was intentionally red at 4 failures / 4 expects
/ 1 file / 51ms / EXIT=1, which was workflow-test red evidence rather than an
old compiler defect. Restored implementation mutations for cancellation-token
rejection, no-progress stopping, cross-module identity isolation, and falsely
published status each exited 1. A fifth mutation omitting
`autoContinuationId` from a continuation body was red at 15 pass / 1 fail / 66
assertions / EXIT=1; restoration returned 16 pass / 78 assertions / EXIT=0 in
202ms. The covered edge cases include duplicate-token over-dispatch, ABA
continuations, a legal closed `progress:false` response, an invalid cap silently
widening to the default, and thrown/JSON elapsed paths with unknown error-code
redaction.

The runner accepts exactly the existing public `/prepare` and `/auto-resolve`
contract through an injected transport. It retains the catalog's 24-character
base32 opaque-ID rule and an all-run continuation-token-to-module ownership
map. Its HTTP-attempt cap is not a provider retry or a real network-request
count; public `reportedProposalCalls` is adapter-reported accounting only.
It performs no review, resolve, bundle, or session route. This is a
fake-transport workflow unit test, not actual-PDF HTTP, an in-process host, or
model-quality evidence. The next internal-host slice (temporary catalog, shared
admission controller, actual handler, and offline injected LLM) remains
unverified. Consequently this new two-file coverage is outside the prior
5,505 / 504 full/preflight batch and baseline until a new full run and final
preflight are actually captured. Autonomous two-PDF publication, live quality,
and actual world-model binding remain open.

## In-process two-PDF HTTP host: offline boundary verification (2026-10-10)

The next host slice is now frozen and reviewed, but it is deliberately an
offline wiring result rather than autonomous publication. Root's focused run
recorded 20 passes across 2 files, 104 assertions, EXIT=0 in 2.60s, and
typecheck exited 0. The host uses a temporary catalog, the same admission
controller, and the real in-process compiler HTTP handler. It does not start a
listener, call `loadConfig`, instantiate `LLMClient`, or consume provider
credentials; it injects a fixed invalid `{}` reply. (Bun may auto-load `.env`
through `src/config.ts`; this host neither reads nor outputs its contents.)

The real pinned Fuzu and Barn PDFs ran offline in session 73831 with one
automatic attempt each and stopped `no_progress`: two reported proposal calls
per module, four fake-LLM calls total, zero fetch-dispatch attempts, one shared
controller, and removed temporary cleanup. Fuzu preparation/automatic times
were 1818/1720ms; Barn's were 2607/6304ms. An invalid reply intentionally
makes no validated progress, so this proves neither autonomous publication nor
model quality. It still invokes no review, resolve, bundle, or session route.

The restored mutation evidence is specific: replacing the real handler with a
fixed 503 gave 1 pass / 2 failures / 5 assertions across 3 tests; allocating a
new admission per request gave 2 / 1 / 14; and removing exception cleanup gave
3 / 1 / 25 while the temporary directory actually remained. Restored host
coverage was 4 / 0 / 26 in 2.78s before root's stronger 20 / 0 / 104 run. For
5xx/throw, chat settlement is not a public proof that handler draining ended;
cleanup remains conservatively deferred and may linger rather than being
deleted early. Default `bun test` session 80854 terminated EXIT=0 with 5,525
tests / 506 files / 5,487 pass / 38 skip / 0 fail / 37,200 assertions in
956.28s: +20 tests / +2 files / +20 pass over 5,505 / 504 / 5,467 / 38 / 0,
with skips unchanged. The runner's 16 and host's 4 tests are the two new test
files. `unwiredMethods` remains 39 without a new scan. This is the default CLI,
not a `--parallel` variant. Standard preflight 89848 subsequently terminated
EXIT=0 with the same 5,525 / 506 baseline counts, typecheck 0,
`unwiredMethods` 39, boolean/ignored 363/0, generated-reference categories
3/8/1/3, and `.githooks` confirmed. Two-PDF autonomous publication, live
quality, and actual production world binding remain open.

The next production cut is not a permanent unique-candidate helper. It is a
server-owned, bounded evidence-binding presentation producer over the existing
workbench candidate and binding validator, then a durable
selection/review/bundle receipt. A source-exact candidate is necessary but not
alone a player-visibility proof: the host must retain the structural
current-scene policy and let the existing façade release clues and endings only
at their mechanics-authorized times. Recovery is deliberately three-way:
before provider dispatch it may dispatch; once dispatch has begun but before a
selection is durable, the result is outcome-unknown and must fail closed (or
spend an explicitly new retry budget), never publish; only a durable selection
can replay review/project/bundle with zero new model call. Review and bundle
IDs/timestamps must be reserved durably rather than inferred from test-only
deterministic IDs or a content-derived capability. This remains future work;
it adds no per-item manual gate, fixture registry, or completion claim.

**Visibility correction.** A generic candidate digest and the existing binding
validator prove only that a chosen quote belongs to an authorized source slot;
they do not grant player visibility. The automatic path therefore needs an
explicit host-only presentation policy, producer provenance, and per-field
visibility eligibility, all independently rechecked before projection and
facade exposure. It must record automated-producer provenance. The existing
host-authenticated `operator` is an authorization principal rather than a
human-attestation label, so the service wrapper may use the existing route and
RBAC; only a model or request body may not self-assert that authority. In
particular, selecting a scene heading is not a
general safety proof: a heading can itself disclose a hidden corpse or ending
truth. Nor may the implementation reason circularly that it is safe merely
because `scene.name` is currently exposed. This is a required dependency of
the next production cut, not a change to the existing source-binding evidence.

**Two-PDF release-evidence sizing correction.** Read-only prepare plus pinned
SHA validation for the actual PDFs exited 0. Fuzu's resulting graph has 136
statements and four regex hits for public/Keeper wording; three are conditional
read-aloud passages that mix Keeper and mechanics text. Barn has 250 statements
and four hits, but they are whole/body duplicates for only two subjects; no
read-aloud cue matched. This neither proves Barn has no public-release evidence
nor makes a keyword hit an authorization. The current binding stores no
fragment evidence reference, candidates are whole statements, and final
validation only proves `statement.includes(quote)`. A cue fragment therefore
needs a unique raw span plus an existing IR release-target provenance link
before it can establish eligibility. A first fragment slice may cover only
clue/ending fields; it is a dependency, not a substitute for autonomous
two-PDF publication. NPC introductions and initial-scene safe eligibility
remain open. Root's now/handoff `--no-test` generators have exited 0 (the first
now sandbox Git-spawn EPERM was rerun elevated successfully). Standard
preflight 89848 then terminated EXIT=0 with the frozen 5,525 / 506 baseline
counts, typecheck 0, `unwiredMethods` 39, boolean/ignored 363/0,
generated-reference categories 3/8/1/3, and `.githooks` confirmed. This is a
final gate for this frozen batch only; it does not complete the open publication
or quality goals.

**Authority-contract historical correction.** The former blanket statement
that `src/compiler/` imports no world runtime and that no source-bound artifact
consumer exists is superseded. Its pure authority sublayer still has no
production `ClaimCandidate`/`CompilationManifest`/`resolveCandidates()` world
producer-consumer path. Separately, the catalog bridge validates and persists
an exact server-owned world binding, and the compiled runtime consumes that
binding only as scoped, non-authoritative prompt reference with provenance. It
does not fill module facts or establish player visibility; the latter remains
the new host policy/release-guard dependency above. This corrects historical
scope wording, not a claim that all world binding is independently accepted.

### Next bounded real-provider validation is authorized, not executed (2026-10-10)

The user has authorized one later, bounded compilation validation over the two
exact-SHA PDFs: at most 8 actual external requests, 2,400 tokens, a 180-second
admission deadline for the first external request, no retry, and no publication.
It has not been executed; this authorization is neither live-success evidence
nor a change to the open autonomous-publication, real-quality, or world-binding
goals. The final `now`/`handoff` refresh has exited 0.

**NPC factual-quality boundary.** Canonical Barn material gives Phoebe only
that she has had no news for more than half a month; Mir, rather than Phoebe,
is the source for last seeing her son half a month ago in the evening. Prior
model dialogue's phone call, evening attribution to Phoebe, and contact
frequency claims lack source support. The current NPC postcheck does not test
semantic entailment, and its capture test accepts an unsupported fake sentence.
This is an open quality defect: no prompt-only wording or keyword list is
recorded as a repair, and natural dialogue remains subject to later live
validation.

**Live-execution authorization boundary correction.** The attempted bounded
live execution was rejected at process creation: no process started and no API
request was made. External-destination disclosure confirmation remains pending;
an automatic goal continuation is not authorization. This says nothing about an
endpoint's availability. The frozen host target first showed 20 pass / 6 fail
in sandbox because the prepare child lacked its required environment; the same
command elevated passed 26 / 2 files / 148 assertions / EXIT=0 in 6.89s, and
root typecheck was 0. Owner host coverage was 10 / 70 / EXIT=0 in 6.93s. A
real CLI unconditional-offline-gate mutation was 9 pass / 1 fail / 69
assertions / EXIT=1 and restored to 10 / 70 / EXIT=0. Earlier fake-source
progress must not be read as four actual progress calls per module: arithmetic
only caps each module at four within the global eight, and the deadline can
leave Barn at zero. Root default `bun test` session 6185 is still live; this
adds no full-suite, baseline, or live-quality success claim.

**Automatic-presentation policy correction.** Existing trusted-review authority
may be exercised by a machine `operator` service through the existing route:
the required boundary is a server-owned policy plus producer
provenance/receipt and the existing binding validator. A permanent human
per-field gate, or an unbounded natural-language formal-semantic-proof system,
is not an established requirement. This does not weaken release safety:
`source_exact` remains insufficient to authorize player visibility; the full
plan needs one legal binding for every required field, rather than claiming
two-PDF publication from a clue/ending-only subset. Opaque remains limited to
module metadata; scenes, NPCs, and other required visible fields may not gain a
fallback. The disconnected root probe exited 0 with actual no-callers 39,
test-only 84, and should-private 26; baseline counts are unchanged. Full session
6185 remains live and the external-execution authorization boundary above is
unchanged.

**Current frozen-batch full-suite record.** Root default `bun test` session
6185 terminated EXIT=0: 5,531 tests / 506 files / 5,493 pass / 38 skip / 0
fail / 37,291 assertions / 1011.64s. That is +6 tests and +6 pass over the
previous 5,525 / 506 / 5,487 / 38 / 0 record, with files and skips unchanged;
no individual test or assertion-delta cause is assigned. Root typecheck was 0
and the disconnected probe's actual no-caller count was 39. This batch's
standard preflight has not run, so it is not a final gate; rejected live
execution remains API-zero and is not quality-success evidence.

**Current frozen-batch standard preflight.** Standard preflight 28197
terminated EXIT=0: boolean/ignored 365/0, generated-reference categories
3/8/1/3, typecheck 0, 5,531 tests / 506 files matching the baseline,
`unwiredMethods` 39, and `.githooks` confirmed. This is a final gate for the
current frozen batch, not evidence of a live provider run: no live process
started, API requests remain zero, and external-destination confirmation is
still pending.

**Canonical full-binding selection helper (new frozen slice).** The
`projection.ts` helper and its tests are frozen: owner 6 pass / 27 assertions /
EXIT=0 with typecheck 0. A real mutation that made unknown digest fall back to
the first binding went red at 5 pass / 1 fail / 20 assertions / EXIT=1 through
the cross-field check; restoration returned 6 / 27 / EXIT=0. Root independently
ran 3 files / 67 tests / 67 pass / 0 fail / 787 assertions / EXIT=0 in 71.09s
with typecheck 0. The same command sandboxed was 63 pass / 4 fail / 765
assertions / EXIT=1 in 59.75s because PDF/local-HTTP prerequisites failed; no
specific sandbox failure mechanism is claimed, and elevated rerun was green.
Review found no hard block. The seal-once structure is verified, but has no
runtime-count test. This is not a machine producer, publication, or quality
completion: it still must feed machine-host policy/provenance into the existing
review/catalog → resolve → session path before two fresh-PDF actual-play and
world-binding acceptance. Root full session 99430 has now terminated EXIT=0:
5,533 tests / 506 files / 5,495 pass / 38 skip / 0 fail / 37,231 assertions /
1114.42s, +2 tests/+2 pass with files/skips unchanged. Assertions are not a
baseline and no assertion-delta meaning is inferred. Root typecheck is 0.
Unwired scan 29963 also terminated EXIT=0 with actual no-callers 39, test-only
84, and should-private 26; it scans class methods only and cannot prove new
exported-helper production consumption. Standard preflight 62421 subsequently
failed only its baseline equality check, so this is not a final gate.

**Next minimum wiring (not implemented).** After durable auto-resolve
continuation, one admission-held `fullWork` must encompass selector,
scope-producer, and fenced review/bundle persistence. Race/drain ownership must
remain attached to that `fullWork`, so an unabortable LLM cannot release the
slot before later work writes. Field release is not inferred from launch
authorization or a path hash: private NPC description may be bundled; clues
and endings may be bundled only for future runtime gates; a private scene public
field must be refused. The 99430 full result and 29963 class-method scan do not
validate this wiring; preflight 62421 failed baseline equality, so it remains
unvalidated. This is
next-action design only, not implementation or acceptance.

**Compiled-talk quality source-review boundary.** Compiled talk runs from its
mechanism through `executeMechanicsAction` into before/after/action-label
narration; it does not invoke `NPCAgent`, so `knowledge=[]` is not an
independent root cause. A successful clue can enter the after frame as a model
fact, while the raw player question/topic does not enter that frame. A source
NPC description existing does not make it player- or provider-visible. The
proposed two-different-questions/same-mechanism counterexample has not run; it
is source proof/design only. Do not reopen found-clue checks or expose the
whole NPC private context. Quality remains open, live API calls remain zero
pending authorization, and terminal preflight 62421—not old 28197—leaves this
new batch open.

**Dynamic topic-loss proof (limited).** A read-only in-memory
compiled-module HTTP fixture ran bundle → `handleRequest` → two session creates
→ player intents → player actions with a fake LLM, native EXIT=0 in 8.40s. The
same `find_parent` mechanism/actions returned 200 at generation 1; each of two
different utterances was absent from narration messages. Initial clues were
empty and the after-found clue visibility gate behaved normally. This is not an
NPC-talk test (fixture NPC count is zero), does not prove private NPC
persistence/view behavior, and makes no prompt-equality claim: prompt bytes
differ because lifecycle/clock state differs. No source edits or API calls were
made and owned temporary data was cleaned. It proves topic loss only, not real
model quality; terminal preflight 62421 leaves the new batch open.

**Current-batch preflight and snapshot boundary.** Standard preflight 62421
terminated EXIT=1 solely because 5,496 pass did not equal the stored 5,495
baseline (and 5,534 tests did not equal 5,533). Typecheck 0, boolean/ignored
365/0, unwired 39, and `.githooks` reported no error. The real 99430 full
record remains 5,533 / 506 / 5,495 / 38 / 0, but it began at 08:37 whereas the
adapter and test mtimes are 08:45/08:46, so it cannot attest the later snapshot.
The bounded-output/request-identity tests belong to already-authorized
`maxPromptChars` work; there is insufficient evidence to attribute a writer,
blame it, or revert it. Root created an in-memory execution-input hash inventory
at 09:27:42; all 841 `src`/`scripts`/`config` inputs remained unchanged through
09:47:46. Fresh full session 2008 then terminated EXIT=0: 5,534 tests / 506
files / 5,496 pass / 38 skip / 0 fail / 37,318 assertions / 1181.94s. Root's
current adapter/proposals directed run was 49 tests / 2 files / 49 pass / 0
fail / 479 assertions / 827ms, with typecheck 0. The new standard preflight has
now terminated: preflight 89701 EXIT=0 with 5,534 tests / 506 files matching
baseline, typecheck 0, boolean/ignored 365/0, unwired 39, and `.githooks`
confirmed. Its 941 execution-input before/after hashes had `changes=[]`; the
protected index (`1fd90...1743`) and architecture (`6ec62...bb`) hashes were
unchanged. This is regression-gate evidence only; real quality, publication,
and world-binding remain open.

**Topic-preservation plan (not implemented).** The next topic slice spans five
production files plus tests. It must retain the original utterance only as
ephemeral request-scoped data and bind request identity with HMAC; it must not
use local storage. Continuing NPC dialogue is an independent open
implementation/acceptance dependency: a later source slice and freeze approval
remain to be determined; it is not implemented in this topic-preservation slice.

**NPC output-surface correction.** `compiledPlayerPresentationFor` currently
returns only current scene name/description, found-clue name/revelation, and a
terminal ending name/description. `getCompiledPlayerFacadeView` returns that
presentation plus actions/turn; it has no direct NPC-description field.
`compiledProjectionNpcView` filters by the scene's NPC IDs and each NPC's scene
ID, then supplies action-state NPC name/HP/status, not description. Thus an NPC
name/action label or same-location presence is not evidence that an NPC
description is directly leaked.
NPC descriptions may still exist in catalog/provider/Keeper context, and
indirect narration remains a verification concern; this correction neither
declares all NPC data safe nor introduces an `introduced` hard gate.

## Current machine-publication and world-scope boundary (2026-10-10)

The default server now constructs the machine presentation publisher; it does
not require a manually injected producer. The test LLM has only a host enable
seam. A model report is untrusted audience input: host field policy and catalog
replay validate every canonical slot before a trusted bundle can exist.
`source_exact` remains necessary source evidence, not public-release authority.
The current 24k prompt packing retains 16 mechanics and 16 selector items, has
one job-shared 32-chat dispatch guard, and `maxAttempts=1`. Selection is limited
to the first eight candidate pages; this is not an all-candidate optimum claim
or a proof of natural-language semantic form. A machine service may exercise
trusted `operator` authority; the result does not impose perpetual per-field
human approval in non-production.

Earlier 5,531/6185 frozen-batch records and earlier static
`presentation_draft_only` wording remain historical facts about their slices;
they are not overwritten by this implementation. Current machine publication
still requires the default host publisher, untrusted-audience handling, host
field policy, catalog replay, and complete canonical-slot validation described
above. The new path is therefore not an unconditional public-release claim.

Root's directed publisher/lifecycle run was 40 pass / 0 fail / 628 assertions
across 2 files in 67.81s (`--parallel=1 --timeout30000`), the complete host
world-model suite was 15 / 0 / 105 across 1 file in 24.06s, the frozen campaign
workflow was 23 / 0 / 102 across 1 file in 202ms, and root typecheck exited native 0.
The initial results above are directed evidence only. Historical full session
2008 (5,534 tests) and preflight 89701 belong to the earlier frozen batch and
must not be applied to the current tree. Root's current default `bun test`
session72048 is terminal native EXIT=0: 5,560 tests / 507 files / 5,522 pass /
38 skip / 0 fail / 37,432 assertions in 1035.14s, a +26 tests / +1 file / +26
pass change from 5,534 / 506 / 5,496 / 38 / 0. The shared-tree growth includes
the new publisher unit file and additional lifecycle/campaign/host coverage;
there is no invented exact per-file attribution. The 868 source/config
fingerprint capture ran from 12:03:37, when that test was already in progress,
to 12:20:27 with `changes=[]`; it is not a startup-precondition snapshot.
Standard preflight77024 then terminated native EXIT=0: 5,560 tests / 507 files
match baseline, typecheck 0, `unwiredMethods` 39, 369 boolean implementations /
0 discarded returns, and `core.hooksPath=.githooks`. Its 975 preflight-input
before/after records had `changes=[]`. Root then ran `now` and `handoff` with
`--no-test`, plus the review-bundle generator, all EXIT=0. This is a final
regression gate for this frozen tree, not autonomous two-PDF publication,
actual play, real-model quality, world-model binding, or production-goal
completion. Subsequent host-wiring work is separately in progress and is not
validated by this gate.

Fresh actual-PDF `real-model-two-module-acceptance.ts --prepare` made
`externalCalls=0`. Fuzu used source SHA-256
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5` and prepared
artifact `2f6d607156bd3cb1774955d325f681ddacc391f65a2ec7f49ab8dbef10f6045f`:
197 questions, 195 open, 2 deferred, 0 answered, closed=false. Barn used source
SHA-256 `7af2924849cdca9ade940fa28f730a44e9bce6148b1e67280b627b5e5afbb549` and
artifact `13c82ca5e6e07e294d75055ca0bb46d96cf4e67d5f17fbc70ba033d5603f9208`:
410 questions, 384 open, 26 deferred, 0 answered, closed=false. The run recorded
two cross-module identity refusals and two unique modules/documents. It is only
fresh isolated preparation: no new actual-business-PDF publication, model sample,
or quality conclusion follows.

The current Fuzu/Barn publish-blocking counts remain 49 / 130. One automatic
run is bounded at 2 rounds × 8 chats × 3 questions = 48, below either closure
need in the relevant way. A campaign with four total attempts can have aggregate
numeric capacity, but capacity alone neither yields valid answers nor guarantees
queue closure, publication, or quality acceptance.

Actual business-PDF live-host publication remains an open gap. A bounded local
fake-transport live-wrapper witness now explicitly enables machine publication
without raising the existing eight-call smoke cap. Its two-heading source fixture
publishes and consumes two modules under required world binding: it records two
selector calls, two resolver calls, two bound-session creations, and two local
receipts. A separate explicit optional-registry case resolves both modules but
returns no binding, still consumes both modules and performs their actions, and
records zero bound-session creations and zero receipts. The compact source
remains a separate pre-publication refusal with zero resolver/binding side
effects. The frozen host file passed 39 / 0 / 246 assertions in 141.16s; the
required forwarding target independently passed 1 / 0 / 28 assertions, and the
actual source-conflict target independently passed 1 / 0 / 13 assertions. Root
also reran the current compiler-closure/mechanics-reachability/auto-admission
set at 85 / 0 / 323 assertions and the compiled-action/world-binding isolation
set at 36 / 0 / 176 assertions. These are directed local, fake-transport
evidence; root typecheck exited 0. They do not constitute a full-suite or
preflight result, external-provider use, real-business-PDF closure, or language
quality evidence.

Source-owner mutations were red and restored for missing default factory
(`presentation_draft_only`), ignored model-private audience plus field-default
refill (422→200), packing merge beyond 24k (two calls→one), and removal of the
shared-32 guard (the 33rd dispatch resolves). The legacy missing-audience shape
only demonstrates 500→503 error capture; it is not evidence of an earlier
automatic-publication defect. The owner has now also restored three recovery
boundaries: a fresh resumed missing-review request stays 503 with one selector
and no bundle; legal draft-warning progress creates a new continuation,
resolved hash, review, and bundle while retaining the old bundle; and an atomic
start remains resolved across a fake 10ms deadline while a late selector cannot
write. Their ten focused tests passed (74 assertions, 31 filtered, 20.71s) and
owner typecheck exited 0, with all mutations restored. Root then independently
reran the complete two-file set natively: 44 pass / 0 fail / 660 assertions in
73.11s. That confirms this directed slice and is included in the later frozen-
tree full/preflight gate, not the broader publication/quality goal.

The world host uses a structured real-PDF-format fixture through actual prepare,
queue-bound fake hints, canonical catalog publication, `handleRequest` session
creation, and snapshot-validator/trace-delta observation. Its resolver is host
input only, not PDF, LLM, or HTTP authorization: two local Cthulhu single-work
scopes each bind a fresh resolved artifact hash and make a local session-opening
receipt without transport. Required scope with no resolver is refused with zero
consumption/action/receipt; wrong module or hash is also refused, while an
ordinary scope without `require` remains legal. The required guard is at the
consumer, not a publication-time block. This witness is neither an actual
world-model binding nor proof that a model used it or produced quality.

The five-file raw-topic preservation plan remains unimplemented, continuous NPC
dialogue is an independent read-only evaluation, and formal player integration
against a live published business-PDF campaign has not passed. Autonomous
two-PDF publication, paired real-language quality, and actual production
world-model profiles remain open. `docs/notes/index.json` and
`docs/architecture.json` have parallel protected work and remain intentionally
unrefreshed here.

## Bounded NPC continuity and public-view AI Player plan (2026-10-11)

This increment supersedes only the earlier current claim that NPC continuity
was still a read-only evaluation. It does not complete the separate five-file
raw-topic preservation plan, autonomous actual-business-PDF publication, or
production quality. Historical results and unfinished scopes above remain
records of their own frozen slices; `todo-65` remains `open`.

**Implemented continuity boundary.** Compiled same-generation NPC follow-ups
can now accept an untrusted `previousActionId` pointer. A versioned v2 ledger
record retains the accepted exact player question and a server-computed
`contextHash`; the current request identity and prepared/dispatch/receipt MAC
chain bind that context. Before a new or prepared dispatch inherits one earlier
exchange, the server rereads its settled v2 record and independent settled
admission anchor, verifies all three MACs and the reconstructed question hash,
and requires the same session, bundle, generation, scene, NPC, ordered clue
set, released facts, contact, and frame. The prompt receives that verified
question/reply as one `previousTurn`, not as additional `releasedFacts` or
source authority. It does not concatenate the first reply into the second
player question or create a world-model memory registry.

Current settled exact replay verifies its original binding and receipt before
returning with zero new model calls, including terminal replay and replay after
its predecessor is deleted. A new/prepared dispatch cannot inherit a deleted,
tampered, stale, foreign, or unanchored predecessor. Existing v1 rows keep their
original replay/prepared recovery contract but cannot be selected as prior
dialogue because they contain no exact question. Context is limited to one
exchange: question at most 1,000 UTF-16 code units, accepted reply at most 2,000
Unicode characters, and at most 3,000 Unicode characters total. This is durable
source-bound conversational context, not the unimplemented main-action
ephemeral topic-preservation path.

**Directed evidence, not language-quality acceptance.** The new actual loopback
HTTP continuity file passed `8 / 0 / 205 assertions`; root independently
reproduced `8 / 0 / 205`. Its second question uses a natural reference without
repeating the first answer. Ledger/input/reply/MAC/admission/frame/pointer
tampering, restart, v1 compatibility, context bounds, source/generation refusal,
and terminal/deleted-predecessor exact replay are covered. Two real production
mutations were red and exactly restored: dropping `contextHash` from v2 request
identity changed a tamper refusal from 409 to 200 (`0 pass / 1 fail / 56
assertions`), and allowing predecessor admission recovery changed an untrusted
dispatch anchor from 409 to 200 (`0 / 1 / 100`). The restored tamper target passed
`1 / 0 / 117`. The related facade/recovery set passed `27 / 0 / 485` and
typecheck exited 0.

The controlled formal host integration is now directed-verified, superseding
the earlier unpassed controlled-integration statement: root's three-file
full-quality set exited 0 at `8 pass / 263 assertions / 33.58s`. It uses two
synthetic source-bound PDF pairs (NPC at entry and NPC after public navigation),
intercepted fake transport, actual public player routes, and exact
`previousTurn`. Those Fuzu/Barn-labelled fixtures are not the two actual
business PDFs, and fake replies are not real-provider naturalness evidence.

The default-auth fresh-child 503 was a test environment dependency: a plain
`Bun.spawn` did not inherit the parent's JavaScript test-preload env edits, so
the child could load a configured provider from `.env`. A read-only no-provider
probe showed `disabled=null, enabled=true` for default spawn and
`disabled=true, enabled=false` with explicit env. The restart witness now
passes `env: { ...process.env, LLM_DISABLED: "true" }`; no auth/restart/action
assertions were removed and no production recovery fix is claimed. Its file
passed `11 / 0 / 211`, independently reproduced by root in 25.8s. No real
provider was called for this correction. The final shared-tree full suite and
standard preflight still await their final rerun; these directed results do
not replace that gate. Actual Fuzu/Barn PDF compilation and paired real-provider
dialogue/quality comparison remain pending, with no real-provider text from
this slice available to judge whether the conversation sounds human.

**AI Player integration remains planned, not implemented.** Reuse
`src/agent/player-agent.ts`'s role personality, background, current goal, and
`history.slice(-3)` prompt capability, prioritizing its LLM action-prose path.
The agent's decision input must be limited to its personal character, the
current `player-view` public presentation/action labels, and confirmed public
results of its own actions. Feed the generated action text through the existing
model-intent API, then execute only the returned opaque action with the current
generation/retry identity. Self-reported intent/target is not mechanism
authority. Do not inject hidden IR, unreleased clues/endings, witness plans,
internal scene routes, or core-clue rankings to select a path. The old fallback
explicitly expects play-module's core-clue-prioritized movement order; borrowing
that runner unchanged would not establish human-like autonomous choice.

Acceptance must exercise public multi-branch choices, different reasonable
role goals choosing differently under the same observation, replanning after
an actual failed result, asking for clarification when public messages are
insufficient, and fresh per-module/session histories with no future ending or
cross-module fact knowledge. Multi-branch generic actions must not acquire
missing information from internal scenes or witnesses. Count failed model
calls and template/fallback decisions separately; neither counts as successful
real-model quality. This remains the same open formal-player integration
dependency in `todo-65`, not a completed AI Player or a new permanent human
approval gate. Protected notes index, architecture, generated AGENTS, frontend,
and host code are not edited by this documentation increment.

### Continuity checkpoint: standard full green, final gate still open (2026-10-11)

Root's first full session90243 terminated native EXIT=1: 5,645 tests / 511
files / 5,604 pass / 36 skip / 5 fail / 38,492 assertions in 1058.46s. It had
an OS-level `LLM_DISABLED=true` override. The five failures were the explicit
provider-enabled opening, two opening-cancellation cases, and the HTTP-500 and
provider-AbortError opening witnesses. All depend on a provider-capable Worker
whose transport is fully fake. The unchanged three-file A/B run reproduced
the same five failures with that OS override (EXIT=1, 10 pass / 5 fail / 40
assertions, 6.29s); removing OS `LLM_DISABLED`/`LLM_MODE` while retaining the
repository preload and external-network guard passed (EXIT=0, 15 pass / 0 fail
/ 67 assertions, 3.79s). This diagnoses a test-run environment difference,
not a production repair or a reason to weaken the assertions.

The standard-environment full session65094 then terminated native EXIT=0:
5,645 tests / 511 files / 5,609 pass / 36 skip / 0 fail / 38,495 assertions
in 1028.88s. Root's collector elapsed 1,029,699ms and drained 123,565 stdout
bytes plus 1,124,258 stderr bytes; the 865-file source fingerprint reported
`changed=[]`. This supersedes the earlier pending full-run statement for that
frozen tree only. Standard preflight has not yet verified this checkpoint;
the final baseline is deliberately not advanced while the next AI Player slice
will add tests. Later implementation edits are not covered by session65094.

Current 36 skips have a complete observed list: the 32 retired ending-state
cases, two Career file-symlink capability cases, and two configured research
artifact/world-model opt-in cases. The older 38-skip session72048 has no retained
per-case list available for comparison. The two-count decrease therefore has
no established historical per-test cause; directory-junction passes in a newer
log are not sufficient to invent that attribution. Historical 38 remains
historical, and this checkpoint does not change skip conditions or the baseline.

The frontend continuity slice is also directed-verified: root independently
passed 27 tests / 208 assertions across two files at EXIT=0. The owner passed
55 tests / 378 assertions across five files, build EXIT=0, and typecheck
EXIT=0. Four actual frontend production mutations were red and restored:
omitting POST `previousActionId`; replacing a pending retry's original pointer
with a new caller pointer; removing contact/generation/terminal/scope cleanup
watching; and bypassing unknown-2xx status/reply/view validation. They respectively
exposed Vue continuity, frozen-retry, stale contact-switch rendering, and API/UI
validation failures. No unrecorded mutation exit codes or assertion counts are
claimed; root's 27/208 is the restored green evidence.

AI Player integration has now started in a separate implementation slice and
is **in progress**, not accepted or complete. The public-view, role-goal,
failed-action replanning, clarification, and module-isolation acceptance plan
above still applies. Actual Fuzu/Barn business-PDF compilation/publication and
paired real-provider dialogue quality, actual production source-bound world
scopes and evidence of model use, and the final shared-tree preflight remain
open. Fake-provider wiring and frontend greens are not real-provider naturalness
evidence; no such text is available from this checkpoint. `todo-65` stays open.
This record does not refresh now/handoff, protected indexes, architecture,
AGENTS, or the final test baseline, and runs no gate or generator.

### Controlled AI/UI slices verified; full-run recovery still unresolved (2026-10-11)

The AI Player controlled slice is implemented and directed-verified across four
changed files, adding 22 tests in two new files. The owner restored and passed
52 tests / 242 assertions across five files in 84.76s; root typecheck exited 0.
`PlayerAgent`'s strict instance-bound action contract and
`scripts/diag/compiled-public-player-rollout.ts` form an offline public-only
adapter: public observations and confirmed results drive role-based action
prose through the existing intent and opaque-action routes. This supersedes
only the earlier in-progress status of that bounded slice. It is not connected
to the live host's budget/CLI and does not complete autonomous production play.

Four actual AI implementation mutations each terminated native EXIT=1 and
were precisely restored: recording proposals as confirmed history (2 fail /
13 assertions / 2 files), spreading a private scene into the public observation
(2 fail / 6 assertions / 1 file), selecting the first ambiguous candidate
(1 fail / 3 assertions / 1 file), and continuing after an uncertain commit
(1 fail / 3 assertions / 1 file). Restored directed green is the evidence;
these controls do not establish real-provider quality.

The frontend ambiguous-topic defect was separately repaired in a two-file
slice with four additional tests. The response's top-level `topicBound` must
be retained for a user's explicit candidate choice, rather than read from an
action that does not own it. Root independently passed 31 tests / 232
assertions across two files in 407ms, with build EXIT=0; owner coverage passed
59 tests / 402 assertions across five files. The four actual frontend
implementation mutations each exited native 1 and were restored green. Root
typecheck is 0. This is controlled UI/action continuity acceptance, not a
real-provider conversation-quality claim.

Full session57520 nevertheless terminated native EXIT=1: 5,671 tests / 513
files / 5,634 pass / 36 skip / 1 fail / 38,723 assertions in 1720.66s. Its
275,964 stdout / 1,268,037 stderr bytes were captured and all 877 fingerprinted
inputs had `changed=[]`. The first full-quality player-route case exceeded its
30s outer harness budget, taking 40.89736s. After unchanged standard directed
reruns passed, root approved only that first case's full-chain harness budget
at 60s; product deadlines and semantic assertions were unchanged. The changed
two-case directed file passed 2 tests / 49 assertions in 16.61s. The full-run
timing failure does not establish a proved load-related cause.

The next full session59530 also terminated native EXIT=1: 5,671 tests / 513
files / 5,634 pass / 36 skip / 1 fail / 38,679 assertions in 1725.98s. Capture
was complete and the 870 fingerprinted inputs had `changed=[]`; the earlier
route case passed. The sole failure was ordinary action admission's two-fresh-
runtime/third-process replay witness: a child exited before the helper reported
its expected event. Original diagnostics did not establish an exit code/signal
cause. The unchanged admission file passed 20 tests / 263 assertions in 9.57s,
and the exact singleton passed 1 test / 9 assertions in 2.30s. A helper that
awaits exit/drain without rechecking a newly arrived event is a candidate
harness defect, with a deterministic red test now authorized/in progress;
neither the full-run root cause nor its repair is accepted as established yet.

The observed count growth from the old 5,560/507 baseline is +111 tests / +6
files: session65094's 5,645/511 represented +85/+4, followed by AI
+22/+2 and UI +4/+0. These counts come from completed runs, but the latest
full runs are red, so the baseline remains unchanged and no new standard
preflight green is claimed. The historical 38→36 skip difference still lacks
an old per-case list for attribution. Actual business-PDF compilation and
paired real-provider quality, production world scopes/model-use evidence, and
live runner budget/CLI integration remain open; `todo-65` stays open. Protected
notes index and architecture refresh are deferred. This record changes no
baseline, now/handoff, AGENTS, source, gate, or generator output.

### Frozen full green and bounded admission-harness repair (2026-10-11)

The admission helper candidate above is now a deterministically proved harness
defect, not a retrospective diagnosis of session59530. All three original
exit/drain guards failed the controlled red tests: after awaiting stream drain,
they must recheck whether the expected event arrived before reporting child
exit. Only that test file changed, adding nine tests and no file; its existing
business describe and all deadlines were byte-exact. Removing all three repaired
guards as a real mutation exited native 1 at 0 pass / 3 fail / 2 assertions /
1 file in 276ms (capture1791694346891). Exact restoration to SHA256
`406ba00470323c4be97352aca5bcb7378940b8036673edaad073e9e66d7978de`
passed 29 tests / 279 assertions / 1 file in 9.82s, native EXIT=0
(capture1791694383447). No production admission check or product timeout was
relaxed. Both earlier red full-run records remain historical evidence.

Root standard-environment full88120, `bun test --parallel=1 --timeout 30000`,
terminated native EXIT=0, signal=null, without capture error: 5,680 tests /
513 files / 5,644 pass / 36 skip / 0 fail / 38,728 assertions in 1619.06s.
Inner capture took 1,619,741ms and retained 280,820 stdout / 1,268,531 stderr
bytes in `analysis/diag/two-module-capture-1791696102950.{stdout,stderr}.log`;
all 870 frozen input hashes had `changed=[]`. The native terminal summary and
verdict establish green; expected negative-fixture diagnostics extracted by an
unconditional bounded-diagnostic call are not additional full-suite failures.
Root quick80436 separately exited 0 with boolean390/discard0, typecheck0,
unwired39 and hooks correct; its skipped tests/counts do not establish a new
standard preflight.

The baseline is now 5,680/513/5,644/36/0, with unwired39 unchanged. The old
5,560/507 to current growth is +120 tests/+6 files: the shared net +85/+4 at
65094, then AI +22/+2, UI +4/+0 and admission harness +9/+0. Historical skip38
still has no retained per-case comparison to skip36; no individual cause is
invented and no skip condition is adjusted. Final standard preflight remains
unverified. Actual two-business-PDF compilation/publication and paired real
provider language quality, production world scopes/model-use evidence, and
live runner budget/CLI integration remain open; `todo-65` stays open.
The handoff preserved slot is updated and now/handoff are refreshed only with
`--no-test`; their generation supplies no new test evidence. Protected notes
index, architecture and AGENTS are not refreshed: the latest engine notes and
new public rollout runner/test paths deliberately await a later index update.

### SAN-fixture precondition corrected; plain full green, preflight pending (2026-10-11)

Standard preflight90733 was a real EXIT=1, not superseded by the earlier88120
full green: world-state-truth-source's KP SAN assertion expected44/received43;
one test failed, pass5643 differed from baseline5644, and its bun test exited1.
Typecheck0, boolean390/discard0, refs/hooks and unwired39 were normal. All876
frozen hashes were unchanged; capture1216264ms retained stdout1656/stderr0
bytes at `analysis/diag/two-module-capture-1791697804091.*`.

Controlled per-session entropy proved a random fixture precondition error,
not a production synchronization defect: LCG722 yielded legal POW/maxSAN43;
set44 returned `value_out_of_domain` and all three reads stayed43. Constant.25
yielded POW/max61, accepted set44, and synchronized all three reads to44.
The old test ignored Result. Only its positive entropy/Result premise was
corrected, preserving expected44 and inventory/weapon assertions; a low-POW
refusal counterexample adds one test/no file. Related coverage passed60 tests/
255 assertions/6 files in1.95s, typecheck0. Two real source mutations each
exited1: omit persistence (world61!=44,capture1791698299616), and bypass
domain refusal (out-of-range SAN then restore refusal,capture1791698342166).
Production was exactly restored to SHA256
`588b3a32ca891ebf9087aaee30b7b51bc7726405105c379f72ac7c99ef09feb0`.

Root plain `bun test` full72737 terminated native0/signalnull/no captureerror:
5681 tests/513 files/5645 pass/36 skip/0 fail/38709 assertions/922.63s.
Capture922821ms retained stdout270701/stderr1479566 bytes at
`analysis/diag/two-module-capture-1791699487120.{stdout,stderr}.log`; all870
frozen hashes had changed=[]. Baseline5681/513/5645/36/0 keeps unwired39;
old5560/507 net growth is+121 tests/+6 files, latest SAN+1/+0. Earlier red
records and the historical38-to36 skip evidence gap remain. Standard preflight
still awaits rerun; todo-65 staysopen and actual business-PDF/provider/world
quality and live runner integration remain open. Only now/handoff --no-test
are regenerated; protected index/architecture/AGENTS stay unchanged.

### Final named standard preflight accepted (2026-10-11)

Root standard preflight76433 terminated native EXIT=0,signal=null,error absent:
capture1671043ms,stdout1104/stderr0 bytes,rawlogs
`analysis/diag/two-module-capture-1791701370371.*`; all876 frozen hashes had
changed=[]. It explicitly reported preflight passed: boolean390/discard0,
document refs3 generated/8 handwritten/1 structured/3 reverse,typecheck EXIT0,
tests5681/513 matching baseline (judge requires pass5645/skip36/fail0),
unwired39 and core.hooksPath=.githooks. Its output supplies no assertion total
or inner test duration; those remain the separate plainfull72737 evidence.
This supersedes only the latest standard-preflight-awaiting statement, not
the recorded90733/57520/59530 failures. Baseline counts/history are unchanged.
todo-65 staysopen: actual business-PDF/provider quality, authorized production
world scopes/model use, live runner wiring and uncommitted delivery remain
unfinished. now/handoff --no-test cite this named gate without running tests;
protected notes index/architecture/AGENTS remain unchanged.

### Local raw-evidence retention; final standard gate pending (2026-10-13)

Earlier preflight79602's Fuzu receipt/replay failure remains a real red with
unknown cause. Exact57940 green and the present full's Fuzu pass127318.25ms
are non-reproduction, not evidence of a repaired product defect. Four diagnostic
files now persist both streams and status/signal/error/byte counts/SHA256 from
the same capture in a unique ignored local directory; persistence failure is
failclosed. Product semantics, test parameters and existing assertions did not
change. Skipping the real persist call as a mutation exited native1/signalnull:
0pass/2fail/2assert/1file/68ms,capture91ms,logs1791899185568. Byte-exact restore
of all four files passed95/0/566 across3files in452ms (capture481ms,
logs1791899241081);typecheck0 (1662ms,1791899249491),frontendbuild0/33modules/
Vite925ms (1737ms,1791899257814).

Preflight91461's inner Bun exited0/signalnull/errornull:5686tests/514files/
5650pass/36skip/0fail/38769assert/1586.27s,1084 frozen inputs unchanged.
`analysis/diag/preflight-bun-test-MwEt2w` retains stdout290865B/stderr1270338B
and their hashes/exit metadata. The outer gate exited1 solely because the five
new passing tests differ from the old baseline;typecheck0,bool390/discard0,
unwired39/refs/hooks normal,capture1613346ms,logs1791899085556. Baseline advances
by5tests/1file (persistence-wiring2/raw-helper3) to5686/514/5650/36/0,unwired39;
final standardpreflight still awaits rerun. HEAD9dcef35 worldmodel backup is
already remote; diagnostic delivery remains uncommitted. todo65 staysopen,
external world-corpus clean-clone dependencies in at least11files are unresolved
without migration/new skips,and actual PDF/provider/world/live-runner quality
remains unverified. now/handoff --no-test cite this checkpoint without tests;
protected notes index/architecture/AGENTS remain untouched.

### Scene-enumeration budget isolation; final standard still pending (2026-10-13)

Preflight23847 was real outer/native1/signalnull,capture2132559ms. Raw604DuL
recorded5686tests/514files/5649pass/36skip/1fail/38755assert/2091.28s;1084
hashes were unchanged. The sole failure was scene-id-bridge's21-scene single
10s case taking14s. Fuzu passed246078.22ms;older79602's cause remains unknown.
Only scene-id-bridge.test.ts changed:21 independent named cases each retain10s,
with count/uniqueness guard,all old target/ending/negative assertions and an
additional other-unvisited-scene false assertion. Net+21tests/+0files is budget
isolation and stronger exhaustive coverage,not a product performance fix.
Real fixed-maintenance-room isSceneVisited mutation native1 was0pass/21fail/
11filtered/43assert/1file/4.27s,logs1791902594079. Production exact restore
SHA256`588b3a32ca891ebf9087aaee30b7b51bc7726405105c379f72ac7c99ef09feb0`
passed32/0/458/1file/6.31s,logs1791902645609;typecheck0,logs1791902640287.

Preflight70072 inner full native0/signalnull/errornull passed5707tests/514files/
5671pass/36skip/0fail/39144assert/1897.70s. Raw
`analysis/diag/preflight-bun-test-7gPCVR` retains stdout281790B/stderr1277667B
and hashes/exit metadata. OuterEXIT1 was only pass5671!=old5650;typecheck0,
bool390/discard0,unwired39/refs/hooks normal,capture1935786ms/logs1791904625798.
Baseline becomes5707/514/5671/36/0,unwired39;this batch totals+26tests/+1file.
Final standard remains pending,todo65 and external world-corpus cleanclone/
real PDF/provider/world/live quality remainopen. Prior reds are preserved;
now/handoff --no-test run no tests,and protected index/architecture/AGENTS stay fixed.

### Final standard gate accepted; delivery boundaries retained (2026-10-13)

Standard96874 outerEXIT0/status0/signalnull,capture1949229ms,logs
`analysis/diag/two-module-capture-1791907049173.*`;inner raw
`analysis/diag/preflight-bun-test-IWC9Jr` status0/signalnull/errornull:
5707tests/514files/5671pass/36skip/0fail/39164assert/1911.61s. Raw stdout284731B
SHA256`2a626aa568dcb050ddfcbfd0ac2a8eeec23a57f8e6142d6a341cdafd6ec1d896`,
stderr1277536B SHA256`5944e9f6d7057af67c0e3ad13f8fb9d1e03863c09a60dd418b226ace05d0ba6e`.
All1084 inputs were unchanged from15:24:53.684Z to15:58:34.828Z;manifest
`127e7ef868de73e9a4c4fad725925127962024d529a73e671aa114d6109700bf`,changed=[].
Typecheck0,bool390/discard0,unwired39,refs3/8/1/3,hooks.githooks passed. All21
scene cases passed244.18–377.93ms;Fuzu passed178588.70ms,without establishing
79602's root cause. This supersedes only the latest pending standard gate;
prior reds and unchanged baseline counts/history remain. todo65 staysopen,
indexing is deferred,and external-corpus cleanclone/real provider/world/live
quality remain unverified. now/handoff --no-test are doc-only refreshes;the
subsequent quick check is not another full result. Protected3 files stay fixed.
