# 接手说明

> 生成于 2026-10-13 16:01  ·  刷新：`bun scripts/handoff.ts`
> 状态快照看 `docs/now.md`；这份讲的是**怎么接手**。

## 这是什么

`C:\aitrpg\poc` —— 自主 AI RPG 引擎：模组机制编译为确定性、可验证的执行结构，
规则与状态由代码管理，LLM 只提出候选与叙事。**当前 HEAD**：9dcef35 chore: backup worldmodel pipeline artifacts  ·  **测试**：（未跑）

三条并行的局面驱动是**有意为之**，不是重复实现：
剧本杀（`play-module.ts`）／自由跑团（`api/game-session.ts`）／命令行（`index.ts`）。

## 当前生产化增量

[Unified NPC runtime transition atomicity open scope, corrected 2026-10-08] This closes only one NPCStore SQLite runtime transition and its live projection. The historical currentOpenScope wording that listed a public raw AgentRegistry setDB surface is superseded only by the deleted setDB API; public register/restore, live-agent aliases, prototype monkeypatching, reflection, old-agent bindings, and cross-store concerns remain open. A successful remember whose new memory is completely eliminated by retention still increments registry semanticRevision once: that is conservative invalidation, not a durable/live split, and remains the explicit P2 boundary. This does not establish ACID across SQLite and PlayerSession over a process crash, cross-store or multiwriter coordination, power-loss durability, deployment, authentication, or external-model quality. Mixed-store fanout remains fail-closed rather than globally atomic; compatibility-wrapper retirement remains separate authority work. todo-65 and the larger production goal remain open.

[NPC CLI fanout atomicity open scope, corrected 2026-10-08] This closes only the bounded in-process CLI fanout cohort and the pre-commit receipt completion interval. Mixed-store input fails closed; it is not a cross-store transaction. SQLite-to-PlayerSession process-crash ACID, cross-store/multiwriter/power-loss behavior, compatibility-wrapper retirement beyond this route, deployment, authentication, and external-model quality remain open. todo-65 and the larger production goal remain open.

[NPCAgent memory append atomicity open scope, corrected 2026-10-08] This historical record closes only ordinary memory append/retention. The formerly open state, relationship, and recordInteraction transition boundary is now closed by npcRuntimeTransitionAtomicity; CLI fanout is now closed by npcCliFanoutAtomicity. Neither closure establishes SQLite-to-PlayerSession process-crash ACID, cross-store/multiwriter/power-loss behavior, mixed-store atomicity (mixed-store input only fails closed), broader compatibility-wrapper retirement, deployment, authentication, or external-model quality. No new public NPCStore writer is exposed, and todo-65 remains open.

[NPCAgent private memory/state dispatch open scope, corrected 2026-10-08] This historical record closes only framework-internal dispatch through remaining public compatibility wrappers; persistState remains absent as a public shell while #persistState is private. Memory append is superseded by npcMemoryAppendAtomicity; state, relationship, and recordInteraction transition atomicity are now closed by npcRuntimeTransitionAtomicity; CLI fanout is now closed by npcCliFanoutAtomicity. The remaining boundaries are SQLite-to-PlayerSession process-crash ACID, cross-store/multiwriter/power-loss behavior, mixed-store fail-closed-only handling, broader compatibility-wrapper retirement, deployment, authentication, and external-model quality. This does not claim defense against all prototype tampering, and todo-65 remains open.

[Career leaf-lock exact dead-owner recovery open scope, 2026-10-07] This closes only managed Career-root character leaf recovery on a Windows fixed-local volume when the existing exact root fence is held. Non-Windows roots, network/NFS/SMB filesystems, unavailable kernel proof, legacy or malformed lock records, real power-loss durability, cross-store/Career atomicity, multiwriter work outside this bounded fence, deployment, authentication, compiler quality, and broader production quality remain open. todo-65 remains open.

[GameSession setScene writer retirement open scope, 2026-10-07] This closes only the obsolete public active-scene-only GameSession writer and its test-fixture migration. It does not introduce a replacement KP writer, alter real act movement or compiled synchronization semantics, reconcile all active-scene/player-position models, or close transaction, persistence, multiwriter, crash/power-loss, deployment, authentication, compiler-quality, Checkpoint I, or broader production-quality work. todo-65 remains open; authoritative full-suite and standard-preflight evidence are recorded.

[GameSession world-facade lifecycle open scope, 2026-10-07] This closes only retained `GameSessionWorldReadFacade` reads after their issuer closes. It does not expose raw SQLite or lifecycle authority, duplicate or revise WorldState reader logic, revoke caller-owned resources, unify all child-resource lifetimes, or close cross-store transactions, multiwriter/crash recovery, deployment, authentication, compiler-quality, or broader capability-lifetime work. todo-65 remains open; standard preflight remains pending.

[GameSession closed lifecycle reader and mutator guards open scope, 2026-10-07] This covers only the named session-issued CareerStore facade and the 21 existing GameSession paths sharing this guard. It does not revoke caller-owned raw CareerFileStore authority, delete or migrate Career files, make all child resources share one lifecycle, or close cross-store transactions, multiwriter/crash recovery, deployment, authentication, compiler-quality, or broader capability-lifetime work. todo-65 remains open; authoritative full-suite evidence is complete, while standard preflight remains pending. [Closed-read and compiled snapshot-ledger correction, 2026-10-08] This adds fail-read behavior only for session-bound dynamic capabilities and structural snapshot admission for its in-snapshot retry ledger. It does not make external providers exactly-once, turn stale standalone components into closed objects, establish cross-process or cross-store atomicity, or change Checkpoint I, II, or III scope/status. Its final standard external preflight is green; that delivery evidence does not expand the named boundary. todo-65 and the broader production goal remain open.

[GameSession NPCStore lifecycle and PlayerSession visible_to-writer retirement open scope, 2026-10-07] This does not make caller-owned raw NPCStore instances session-owned, expose write/close authority through the facade, or close broader GameSession child/reference, transaction, persistence, multiwriter, crash/power-loss, deployment, authentication, or compiler-quality boundaries. Historic snapshot visible_to remains accepted solely for backwards-compatible parser/restore/export round-trip; no new live producer may use it as a privacy policy. todo-65 remains open.

[Legacy WorldState read/input ownership open scope, 2026-10-07] This closes only the legacy `src/world/state.ts` play-module object-alias boundary. It does not merge the two WorldState implementations, add a registry/fallback, or close cross-store/Career consistency, multiwriter behavior, NFS/SMB, crash or power-loss recovery, Docker/Linux/assets/deployment, production authentication/operations, or real PDF/OCR/external-model quality. `play-module.ts` still applies llmExpanded to its external module after WorldState construction, but the scene pipeline consumes that external NPC data directly rather than depending on a WorldState write-through. todo-65 remains open.

[WorldState durable logical current round and legacy snapshot publication open scope, 2026-10-07] This closes only one WorldState durable logical-clock authority and the named legacy snapshot-publication transaction. It does not claim that two WorldState implementations have been reconciled, that independently opened stores or non-SQLite writers share a transaction, or that cross-store/Career operations, general multiwriter behavior, NFS/SMB, crash or power-loss recovery, Docker/Linux/assets/deployment, production authentication/operations, or real-PDF/OCR/external-model quality are closed. todo-65 remains open, as does the broad production-quality goal.

[now asynchronous full-suite capture open scope, 2026-10-07] This closes now's full-suite output capture and evidence authority only. It does not claim that a generator's outer zero is internal-suite green, production behavior, or general process-capture correctness outside the named boundary. The first standard preflight is green; regeneration of now/handoff and one terminal preflight rerun are delivery-consistency steps, not functional pending status. todo-65 and the production-quality goal remain open. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because both have parallel changes. Correction scope (2026-10-07): this adds only bounded diagnostic identity/context to a failed internal now run. The first failure did not reproduce and is not attributed to, or presented as repair of, any product test. todo-65 remains open.

[World single active-scene durable invariant open scope, 2026-10-07] This closes the named SQLite data/schema invariant, createSchema's transactional legacy validation/installation/read-back, and the covered fail-closed reader, setter, export, and snapshot handling of actual ambiguous or illegal durable data. It does not claim general WorldState multiwriter behavior, cross-store/Career consistency, NFS/SMB, power loss, independent volumes, Docker/Linux deployment, or external real-model quality. The first standard preflight is green; regeneration of now/handoff and one terminal preflight rerun are delivery-consistency steps, not functional pending status. todo-65 and the production-quality goal remain open. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because both have parallel changes.

[World relationship unordered durable invariant open scope, corrected 2026-10-07] This closes unordered pair uniqueness, public set/read/modify behavior, legacy-open fail-closed, and portable snapshot admission on one SQLite relationships table. It deliberately does not repair or migrate a legacy database that already has conflicting directional rows; an operator must resolve that ambiguity. It also does not prove arbitrary simultaneous lock scheduling beyond the covered SQLite constraint/first-create interleaving, all WorldState multiwriter behavior, cross-store/Career consistency, NFS/SMB, power loss, independent volumes, Docker/Linux deployment, or external real-model quality. todo-65 and the production-quality goal remain open. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because both have parallel changes. [Schema attestation correction, 2026-10-07] This adds transactional conflict scan, exact definition attestation, creation/read-back, and final scan for the unordered UNIQUE index; the first standard preflight is green, while regeneration of now/handoff and one terminal preflight rerun are delivery-consistency steps, not functional pending status. It does not change the listed multiwriter, cross-store, filesystem, power-loss, deployment, or model-quality boundaries.

[Compiled-intent durable success replay open scope, corrected 2026-10-06] This closes local replay of a successfully validated classification for processes sharing one trusted local-filesystem SQLite root, including a real barrier-driven two-service-process miss-to-acquire race that requires the production post-acquire replay lookup. It does not make the external provider exactly-once: dispatch followed by process loss before any local result can be durably confirmed remains ambiguous and requires quarantine/operator recovery. Multi-host or independent-volume coordination, NFS/SMB and power-loss qualification, global IdP/gateway cost policy, Docker/Linux deployment, external real-model quality, broader cross-store transactions, todo-64/todo-65, and the production-quality goal remain open. Checkpoints I/II/III are unchanged. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because both have parallel changes.

[Handoff full-suite process capture open scope, 2026-10-06] This closes local handoff test-evidence collection only. It does not complete Checkpoint I, enter Checkpoints II or III, or establish provider exactly-once, multi-host coordination, NFS/SMB or power-loss behavior, Docker/Linux deployment, external real-model quality, todo-64/todo-65, or the production-quality goal. A sandbox EPERM uv_spawn attempt is retained only as environment evidence. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because both have parallel changes.

[compiled-session creation ingress open scope, 2026-10-06] This closes authenticated in-process concurrency and physical body-cancel lifetime for compiled session creation, plus request-triggered compiler cold-path authentication ordering. It is not a distributed/gateway or cross-replica quota, durable start-rate/cost budget, per-person IdP policy, provider exactly-once guarantee, policy hot revocation mechanism, or universal request admission layer. Ordinary-session creation retains its separate durable coordinator. Docker/Linux execution, NFS/SMB, power loss, broader multiwriter semantics, external real-model/source-document quality, todo-65, and the production-quality goal remain open. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because both have parallel changes.

[public compiler JSON ingress open scope, corrected 2026-10-06] This closes in-process body/work lifetime for four authenticated compiler JSON routes, including provider and request-body cancellation drains. Compiled-session creation now has its own separate in-process controller; the bodyless auto-admission recovery route intentionally needs no body ingress slot. Neither controller is a distributed/gateway or cross-replica quota, start-rate or cost budget, per-person IdP, or provider exactly-once guarantee. Cross-replica enforcement, policy hot revocation, Docker/Linux execution, NFS/SMB, power loss, wider multiwriter semantics, and external real-model/source-document quality remain open. todo-65 and the production-quality goal remain open. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because they have parallel changes.

[public PDF prepare ingress open scope, corrected 2026-10-06] This bounds in-process authenticated PDF body ingestion and its real cancellation lifetime. Compiler JSON and compiled-session creation now have separate in-process controllers. None is a distributed or gateway quota or cross-replica admission policy, and they do not add durable start-rate or cost budgets, per-person IdP identity, provider exactly-once, NFS/SMB, power-loss, Docker/Linux execution, or broad multiwriter semantics. The production environment bearer still represents one service principal. External real-model/source-document quality, todo-65, and the production-quality goal remain open. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because they have parallel changes.

[automatic compiler admission startup open scope, 2026-10-06] This closes only startup compatibility and exact-root validation for the durable automatic-resolution coordinator. It does not add general PDF prepare/resolve admission, provider exactly-once semantics, cost budgets, policy hot revocation, Docker/Linux execution, NFS/SMB or power-loss guarantees, or broad multiwriter coordination. Quarantined provider work remains an operator recovery decision and is deliberately not cleared at startup. External real-model/source-document quality, todo-65, and the production-quality goal remain open. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because they have parallel changes.

[clean-clone external world-model content open scope, 2026-10-06] Docker is absent in this environment. The contract is statically tested, but no image build, Compose startup, Linux-native dependency, actual read-only mount, UID/GID access, volume migration, reverse proxy, or TLS behavior is claimed. Reviewed host content must remain readable/traversable by container UID/GID 1000. Policy hot revocation, provider exactly-once, NFS/SMB, power loss, multiwriter, external real-model/source-document quality, todo-65, and the production-quality goal remain open. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because they have parallel changes.

This closes production-main issuance of exact compiled Cthulhu bindings, not the whole production-quality objective. A catalog-issued bound bundle intentionally retains issuance-time authorization and there is no hot-revocation protocol. Docker/Linux image execution, actual read-only policy/dataset mounts, assets and deployment evidence remain open, as do provider exactly-once, NFS/SMB, power-loss, multiwriter, broader world-model registries, and external real-model/source-document quality. docs/notes/index.json remains intentionally unrefreshed because it has parallel changes.

[opening lifecycle / offline LLM / Docker correction, 2026-10-05] This bounded slice makes ordinary POST /api/sessions cancellation lifecycle-authoritative: Request.signal reaches GameSession.getOpeningScene, KPAgent.describeScene, and the existing LLMClient.chat. Abort before opening, provider abort, and the post-opening/pre-prepare race share one cleanup: release the namespace reservation as CREATE_REQUEST_ABORTED, close staging, delete only the non-authoritative staging root, return 408 REQUEST_ABORTED, and publish neither snapshot nor registry entry. The exact existing llmDisabledByOverride is applied before a shared client is injected: LLM_DISABLED=true or LLM_MODE=template uses one MockLLM for KP plus AgentRegistry/NPC and a null intent provider; valid explicit provider config remains provider-capable when no override applies. Docker contract audit fixes Bun at 1.3.14 with frozen frontend and backend production installs; host root production frozen dry-run, frontend frozen dry-run, and frontend build passed. Docker itself was unavailable, so no image or Linux-native build is claimed, and the absent assets/ directory remains a staging prerequisite. The legacy Cthulhu aggregate is migration-analysis-only, not a full compiled dataset/binding. In particular, production compiled world binding remains open: no authoritative module-to-allowedWorkIds/corpus/transfer policy is supplied and the main server resolver is absent. Do not describe production world binding as enabled. This is not Checkpoint completion or production completion. docs/notes/index.json remains deliberately unrefreshed because of parallel edits.

[Legacy ordinary runtime install/restore/projection authority open scope, 2026-10-05] This closes only legacy ordinary canonical install/restore/projection runtime string-shadow authority. It does not establish standalone legacy loader or host-trust closure, provider exactly-once, or authoritative module-to-world binding. Cross-store/Career and cross-filesystem semantics, NFS/SMB, power-loss, multiwriter, Docker/Linux/assets/deployment, external real-model quality, todo-65, Checkpoint I acceptance, and the production-quality goal remain open. The first standard preflight red due to unwired 46 to 57 is retained in verification; after wrapper deletion, the final standard host preflight is green at the exact 5060 / 447 and unwired 46 baselines. That gate does not complete this scope or goal.

[Ordinary durable provider single-attempt open scope, corrected 2026-10-06] All currently identified ordinary durable model call sites now reject the LLMClient's implicit second transport attempt. This is not provider exactly-once: LLMLike has no stable provider idempotency or operation key and no result lookup, so a provider may execute after dispatch while the process crashes before local persistence. Retrying that ambiguous operation remains potentially at-least-once; quarantine only trades automatic completion for an at-most-once local admission decision. Compiled-intent sequential replay, external provider contracts, cross-store/Career consistency, multiwriter, NFS/SMB, power loss, Docker/Linux/deployment, external real-model quality, todo-64/todo-65, and the production-quality goal remain open. docs/notes/index.json and docs/architecture.json remain deliberately unrefreshed because both have parallel changes.

[Compiled action load/install runtime-private authority open scope, 2026-10-05] This closes only canonical compiled load/install string-shadow dispatch and supersedes the prior record's statement that that boundary was unclaimed. It does not make every compiled child, alias, transaction, source binding, or deployment boundary closed. The final standard host preflight for the 5032 / 445 baseline is now green; that gate does not complete todo-65, Checkpoint I acceptance, or the production-quality goal. Provider exactly-once; authoritative module/artifact-to-world resolution; cross-store/Career and cross-filesystem consistency; NFS/SMB; power-loss; multiwriter; Docker/Linux/assets/deployment; external real-model quality; and other authority boundaries remain open.

[Compiler auto-hint proposal single-attempt open scope, 2026-10-05] One local outbound attempt per adapter chunk is at-most-once only for that process path; it is not provider exactly-once. There is no stable provider idempotency key, provider result lookup, or way for local SQLite to determine whether a provider executed after dispatch but before the local result was saved. Retrying after that crash remains potentially at-least-once, while permanent quarantine trades completion for at-most-once local admission. The final standard host preflight for the 5032 / 445 baseline is green; it does not close todo-65, Checkpoint I acceptance, authoritative module-to-world resolution, cross-store/Career and cross-filesystem semantics, NFS/SMB, power-loss, multiwriter, Docker/Linux/assets/deployment, or external real-model quality.

[Compiled action runtime-private canonical cohort open scope, 2026-10-05] This closes only canonical act/prepare/apply dispatch and the runtime/durable cohort actually reached by those paths. Load/install authority remains open. The final standard host `bun scripts/preflight.ts` gate is now green on its second identical run; the first one-failure run and its non-attribution limit are retained in the verification record, not erased by the retry. todo-65, Checkpoint I, and the production-quality goal remain open: provider exactly-once across a provider-executed/local-result-unsaved crash; authoritative module/artifact-to-world binding; cross-store/Career consistency; cross-filesystem power-loss and NFS/SMB semantics; multiwriter behavior; Docker/Linux/assets/deployment; external real-model quality; and other child, alias, or transaction authorities.

[Ordinary snapshot replay-directory-node occupancy open scope, 2026-10-05] This reserves the node-only generation-zero collision case only; it does not claim general crash, power-loss, cross-filesystem, NFS/SMB, or multiwriter closure. The final standard host `bun scripts/preflight.ts` is now green on its second identical run; the initial unrelated ordinary-case failure was preserved for audit and not attributed to replay-node work without an assertion stack. todo-65, Checkpoint I, and the production-quality goal remain open: provider exactly-once still needs a provider idempotency and result-lookup contract; authoritative module/artifact-to-world binding; cross-store/Career consistency; Docker/Linux/assets/deployment; external real-model quality; and other child, alias, or transaction authorities remain unclosed.

[GameSession constructor installer runtime-private authority open scope, 2026-10-05] The final standard host `bun scripts/preflight.ts` exited 0 and matched the updated 4990 / 443 baseline: 313 boolean-returning implementations / 0 discarded returns; generated/handwritten/structured/reverse document checks 3 / 8 / 1 / 3; internal typecheck 0; unwiredMethods 46; and `.githooks` commit-msg enforcement running. This remains a bounded construction-dispatch authority closure only; the prior full serial suite did not substitute for that final gate. todo-65 remains open: provider exactly-once across post-crash/provider outcomes; authoritative module/artifact-to-world source binding; Docker/Linux/assets/deployment; NFS/SMB; power-loss; multiwriter; cross-store and Career cross-file consistency; external real-model quality; and other child, alias, or transaction authorities. Neither Checkpoint I nor the production-quality goal is complete.

[preflight asynchronous test-child capture open scope, 2026-10-05] The final standard host `bun scripts/preflight.ts` exited 0 and matched the updated 4972 / 442 baseline: 313 boolean-returning implementations / 0 discarded returns; generated/handwritten/structured/reverse document checks 3 / 8 / 1 / 3; internal typecheck 0; unwiredMethods 46; and `.githooks` commit-msg enforcement running. This closes only the known full-test child output-buffer failure mode; the prior full-suite result did not substitute for that final host run. todo-65 remains open: provider exactly-once across post-crash/provider outcomes; cross-store and Career cross-file consistency; NFS/SMB; power-loss; multiwriter; source-bound compiled-world binding; Docker/Linux/assets/deployment; external real-model quality; and other child, alias, or transaction authorities.

[Career helper runtime-private authority open scope, corrected 2026-10-05] This supersedes the earlier `#createPartyMember`-only closure for its nested Career helper chain; it does not retroactively turn that top-level closure into proof that helper dispatch was sealed. The subsequently recorded final standard host preflight at the 4990 / 443 baseline covered this shared-tree helper closure, so the former pending-preflight wording is superseded; unwiredMethods was 46 in that verification. This historical correction does not broaden the helper closure. todo-65 stays open: provider exactly-once; cross-store/Career cross-file consistency; NFS/SMB; power-loss; multiwriter; source-bound compiled world binding; Docker/Linux/assets/deployment; external real-model quality; and other child, alias, or transaction authorities remain outside this bounded closure.

[GameSession createPartyMember runtime-private authority open scope, 2026-10-05] The third final-standard preflight is green after the retained first document-gate exit 1 and second real-test exit 1; this closes only same-process string-shadow authority for the three canonical party-member creation paths, not the wider goal. todo-65 remains open: provider exactly-once across crash/provider outcomes; cross-store and Career cross-file consistency; NFS/SMB; power-loss; multiwriter; source-bound compiled world binding; Docker/Linux/assets/deployment evidence; external real-model quality; and other child/alias or transaction authorities. Do not read final preflight green as production or goal completion.

[ordinary operator recovery open scope, 2026-10-05] Final standard host `bun scripts/preflight.ts` exited 0 with 313 boolean-returning implementations / 0 discarded returns, generated/handwritten/structured/reverse document checks 3 / 8 / 1 / 3, internal typecheck 0, exact 4939 tests / 439 files and unwiredMethods 46 baseline matches, and `.githooks` commit-msg enforcement running. todo-65 remains open. Provider exactly-once remains ambiguous across post-crash lease and provider outcomes. NFS/SMB, power-loss, multiwriter, deployment, cross-store/cross-file semantics, compiled artifact-to-world binding, Docker assets/image evidence, and authorized real-model evidence remain open. This bounded recovery contract is not production completion and does not close the wider todo-64/todo-65 goal.

[ordinary admission and lifecycle boundary, 2026-10-05] The opening-request cancellation path is closed only for the bounded staging lifecycle described in todo-64. Ordinary admission still lacks an exactly-once proof across post-crash leases and provider outcomes. NFS/SMB, power-loss, multiwriter, deployment, and cross-store/cross-file transaction semantics remain open. The preceding opening-request-cancellation slice, not the current ordinary operator recovery slice, had a final standard host `bun scripts/preflight.ts` exit 0 with 312 boolean-returning implementations / 0 discarded returns, generated/handwritten/structured/reverse document checks 3 / 8 / 1 / 3, internal typecheck 0, exact 4937 tests / 439 files and unwired 46 baseline matches, and `.githooks` commit-msg enforcement running. The current ordinary operator recovery slice subsequently had a final standard host `bun scripts/preflight.ts` exit 0 with 313 boolean-returning implementations / 0 discarded returns, generated/handwritten/structured/reverse document checks 3 / 8 / 1 / 3, internal typecheck 0, exact 4939 tests / 439 files and unwired 46 baseline matches, and `.githooks` commit-msg enforcement running. Neither verification closes these open boundaries. docs/notes/index.json remains deliberately unrefreshed because parallel edits are preserved.

[Unified NPC runtime transition atomicity closure, corrected 2026-10-08] One bounded single-NPC transition now commits mood, relationship, and recordInteraction together: its optional mood-event memory INSERT, retention count/prune, player relationship upsert, and npc_states upsert are one NPCStore SQLite transaction. The durable pre-state is checked in that transaction before any write. NPCAgent derives one detached next plan, commits SQLite first, and only then publishes memories/mood/relationship/count and registry revision once; the no-DB path uses that same plan and one publish. The writer neither saves personality implicitly nor disables foreign keys, and it remains outside the GameSession NPCStore read facade. Correction: AgentRegistry no longer exposes setDB; its constructor binds the NPCStore to the real ECMAScript-private dependency, so an own same-named setter cannot replace the store used by registry authority. Every ordinary snapshot wire 1.0 through 1.4 now applies one active-registry-to-NPCStore cohort check: runtime memory is an exact-multiset subset of durable memory, mood/relationship/interaction count agree, each personality row id equals its runtime name, and each nonzero relationship has the matching player row. remember, every memory-bearing transition, and CLI batch fanout derive the live cache from the retained durable memory multiset inside the SQLite transaction rather than the pre-retention candidate list; no-DB retention is 40 rather than 50.

[NPC CLI fanout atomicity closure, corrected 2026-10-08] CLI fanout now uses a Registry WeakMap lexical host plus a module-private token, canonical cloning, and Map-key identity rather than caller-provided aliases. PlayerSession and NPCAgent inputs become sealed plans, and NPCStore writes the whole fanout as one batch SQLite transaction. Receipt-to-plan lookup, uniqueness, binding, and consumer completion all execute inside that callback before commit. A consumer throw therefore rolls back inserts, retention deletes, sqlite_sequence, and unpublished live agent/registry/PlayerSession advancement rather than leaving a committed receipt or split cohort. ECMAScript #private authority owns the host and post-durable publication, so TypeScript readonly is not mistaken for runtime authority. The closure adds 10 tests in one new file.

[NPCAgent memory append atomicity closure, 2026-10-07] NPCStore appendMemoryWithRetention now owns one private SQLite transaction for memory INSERT, count, and the existing over-200 retention prune; a caller never observes a partially retained durable append. NPCAgent first calculates a detached live-memory cache, commits durable storage first, then publishes live memory and registry revision. The no-DB path remains supported, and the public NPCStore read facade exposes no new writer. Transaction privatization left public NPCStore.pruneMemories with no production caller, so it was deleted rather than manufacturing a test caller or raising the unwired baseline; the private retention core remains the authority.

[NPCAgent private memory/state dispatch closure, corrected 2026-10-07] NPCAgent has one private #appendMemory core, with private #rememberDialogue, #rememberEvent, #persistState, #triggerMood, and #adjustRelationship helpers. Public remember, rememberDialogue, rememberEvent, triggerMood, and adjustRelationship remain compatibility forwarders only. Public persistState was removed after the first standard preflight identified it as an uncalled wrapper; #persistState remains the private state authority. Internal respond, speakUp, recordInteraction, combat, and horror paths dispatch directly to the private core rather than through replaceable public wrappers. No new production API was introduced. Root later verified the corrected private-only surface with the exact no-callers baseline and a green standard preflight.

[Career leaf-lock exact dead-owner recovery closure, 2026-10-07] Direct Career leaf locks now retain a versioned token/PID/creation-FILETIME owner record only while a managed Windows fixed-local root operation already holds its exact root fence. After a writer crash, a fresh same-character writer can reclaim only that schema-valid leaf whose owner is proven exited or PID-reused, with repeated raw bytes and dev/inode identity checks at the unlink boundary. Live, legacy raw-token, malformed, unknown-version, unsupported, and internal-stage locks remain fail-closed; no lease or weak fallback was introduced.

[GameSession setScene writer retirement closure, 2026-10-07] This is distinct from the older gameSessionSetScenePrivateAuthority record: that slice protected internal callers from a still-public forwarding wrapper, while this slice deletes the public GameSession.setScene writer itself. #setSceneCanonical remains the private active-scene authority for real act movement and compiled load/restore synchronization. A normal GameSession prototype and instance publish no setScene method. Mechanical test setup uses a test-only helper that captures the registered raw world and activates only an already registered scene; it does not add a production writer. A public active-scene-only writer is not safe compatibility: it can change the displayed active scene without moving the player entity, creating an active-scene/player-position cohort split.

[GameSession world-facade lifecycle closure, 2026-10-07] `session.world` remains the stable frozen null-prototype `GameSessionWorldReadFacade` while its issuer is live, but retaining that facade does not extend its capability after `GameSession.close()`. Every allowlisted reader now crosses one session lifecycle resolver before it dispatches to the hidden WorldStateManager, so a closed session consistently revokes the facade without duplicating WorldState reader DSL or behavior. Session-owned raw world close remains the existing cleanup authority.

[GameSession closed lifecycle reader and mutator guards, 2026-10-07] A retained CareerStore read facade is issuer-scoped: after `GameSession.close()` each of its seven readers rejects, while its backing Career files and data remain intact. The shared ordinary durable mutation guard now rejects a closed GameSession before all 21 existing direct entry paths can cause an observable mutation, including host append, module load/restore, party/messages, character/luck/inventory/weapons, SAN/HP/damage, scene/difficulty, opening, and action paths. Ordinary close remains idempotent; fail-stop retains its unavailable result, a live durable object retains durable-identity priority, and ordinary snapshot restore retains its specific closed-restore diagnostic. [Closed-read and compiled snapshot-ledger correction, 2026-10-08] One private session-read guard now revokes every session-bound dynamic reader and retained facade invocation after close or fail-stop, including party-member SAN. This includes ordinary and compiled mechanics/generation/action/player projections; immutable diagnostics and caller-owned raw components remain deliberately outside that capability. The single snapshot idempotency validator now also requires globally unique, trimmed canonical `actionId` values before restore can materialize its receipt Map, so a re-signed duplicate or whitespace-padded record cannot silently overwrite a historical retry receipt.

[GameSession NPCStore lifecycle and PlayerSession visible_to-writer retirement, 2026-10-07] `GameSession.npcStore` remains a stable frozen detached read facade while its session is live; retaining it does not extend capability across lifecycle: after `GameSession.close()` every facade reader rejects, and only a session-owned raw NPCStore is closed (a caller-owned injected store remains caller-owned). Separately, PlayerSession has one live message-routing model: `pushPerPlayer` is deleted, and `push(message, visibility, discoverer, targets)` rejects any own `message.visible_to` before timestamping, routing, history/audit writes, or semantic revision. The five visibility modes and targeted/scene/discoverer behavior remain the authority. Versioned PlayerSession snapshot parser, restore, and export intentionally retain detached historic `visible_to` fields without treating them as new routing instructions.

[Legacy WorldState read/input ownership closure, 2026-10-07] Legacy `src/world/state.ts` now takes ownership of ModuleData with a structured clone. Its public structured views (`currentScene`, NPC readers, clues, narrative entities, skill hints, visible/pending views, state vars, and snapshots) are detached values; snapshots also clone their Map/Set, NPC-state, scene-vars, and history internals. A previously obtained view cannot observe later canonical mutations or redirect movement, clue discovery/unlocks/state variables, NPC meet/mood/relationship, or hint context through a retained alias.


### 验收记录

[Unified NPC runtime transition atomicity verification, corrected 2026-10-08] The new bounded transition adds 21 tests in no new test file. Real SQLite trigger counterexamples covered first-state INSERT, existing-state UPDATE, retention after the 200th memory, relationship writes, foreign-key failure, registry/runtime/revision/sequence rollback, durable success, no-DB publication, and facade exclusion. Real mutations that restored the old split state write, published live state early, deleted pre-state validation, notified twice, or returned early around player-relationship validation were each red and exactly restored. Final root-directed evidence exited 0: 92 tests / 7 files / 0 fail / 616 assertions; agent-directed evidence: 115 tests / 0 fail / 608 assertions; typecheck 0; probe-unwired 39 no-callers / 87 test-only / 26 should-private. The authoritative sandbox-external bun test exited 0: 5392 tests / 493 files / 5356 pass / 36 skip / 0 fail / 35604 assertions / 568.75s (stdout 118790 bytes, stderr 958945 bytes). Follow-up correction evidence exited 0: 89 tests / 5 files / 0 fail / 484 assertions; typecheck 0; probe 39 no-callers / 86 test-only / 26 should-private. Restoring setDB, removing snapshot cohort/identity/missing-row checks, or restoring candidate-only retention projection was red and exactly restored green. The authoritative full bun test exited 0: 5405 tests / 494 files / 5369 pass / 36 skip / 0 fail / 587.90s. Independent review found no P0/P1 issue.

[NPC CLI fanout atomicity verification, corrected 2026-10-08] Real red controls restored an old public wrapper, advanced PlayerSession before durable success, committed one NPC at a time, deleted the token check, and degraded private publication; all were exactly restored green. A readonly TypeScript-private P0 control was also real: after SQLite it threw Attempted to assign readonly, proving compile-time readonly cannot own post-durable runtime authority. Final root-directed evidence exited 0: 92 tests / 7 files / 0 fail / 616 assertions; agent-directed evidence: 115 tests / 0 fail / 608 assertions; typecheck 0; probe-unwired 39 no-callers / 87 test-only / 26 should-private. The authoritative sandbox-external bun test exited 0: 5392 tests / 493 files / 5356 pass / 36 skip / 0 fail / 35604 assertions / 568.75s (stdout 118790 bytes, stderr 958945 bytes). The follow-up mutation that moved consumer.complete after commit was red and exactly restored green. Its directed evidence exited 0: 89 tests / 5 files / 0 fail / 484 assertions; typecheck 0; probe 39 no-callers / 86 test-only / 26 should-private; full bun test 0: 5405 tests / 494 files / 5369 pass / 36 skip / 0 fail / 587.90s. Independent review found no P0/P1 issue.

[NPCAgent memory append atomicity verification, 2026-10-07] Root-directed coverage exited 0 at 71 tests / 9 files / 71 pass / 0 fail / 429 assertions. Real caller-owned NPCStore plus GameSession talk storage failure publishes only the existing unanswered system text. LLM and constraint fallback in respond/speakUp still resolve their template without memory; storage failure instead rejects. triggerMood memory failure leaves mood, memory, durable state, and revision unchanged. Real SQLite INSERT and retention-DELETE trigger counterexamples prove rollback, including sqlite_sequence rollback; the no-DB path remains covered and the read facade cannot obtain the new writer. Real mutations publishing live memory/notify before durable commit, moving append back into the LLM catch, and splitting the SQLite transaction were red and exactly restored. After private transaction ownership exposed dead public pruneMemories, root deleted it and rechecked 35 tests / 5 files / 35 pass / 0 fail / 189 assertions. Typecheck exited 0; probe exited 0 at 40 no-callers / 82 test-only / 26 should-private. The authoritative serial full Bun child exited 0, DURATION_MS=631074, stdout 285360 bytes, stderr 1138208 bytes: 5361 tests / 492 files / 5325 pass / 36 skip / 0 fail / 35428 assertions / 630.67s.

[NPCAgent private memory/state dispatch verification, corrected 2026-10-07] Red-first GameSession talk had a reply but NPCStore expected 1 memory and received 0; the old state dispatch was also red when public adjustRelationship or triggerMood threw. The real GameSession regression replaces prototype remember and rememberDialogue with throws and proves zero calls, preserves the dialogue reply, asserts exact NPCStore type/content, and asserts the ordinary snapshot agentRegistry live memory is exactly the same. Direct coverage includes remaining public compatibility wrappers, speakUp, recordInteraction, combat, horror, and durable state, relationship, and event paths. Real mutations restoring public rememberDialogue in respond and speakUp each made expected 1 / received 0; restoring public adjustRelationship in recordInteraction threw; and making #appendMemory write SQLite while skipping live push/notify passed SQLite checks but made the ordinary snapshot receive []. Each was exactly restored. Root-directed coverage was 83 tests / 7 files / 83 pass / 0 fail / 374 assertions; typecheck 0; internal mutable public-dispatch scan 0; scoped diff-check 0 with CRLF notice only. The authoritative serial wrapper exited 0, DURATION_MS=722908, stdout 276080 bytes, stderr 1136182 bytes; terminal summary 5352 tests / 491 files / 5316 pass / 36 skip / 0 fail / 722.34s. The first subsequent standard preflight was a real red, not flaky: boolean implementations 336 / discarded returns 0, document references 3 / 8 / 1 / 3, typecheck 0, tests 5352 / 491 green, and core.hooksPath .githooks all passed; only no-callers was 41 against baseline 40. analysis/diag/probe-unwired.md identified public NPCAgent.persistState with zero production and test call sites; descriptor patching is not a caller. The wrapper was deleted rather than manufacturing a test caller or raising the baseline. Root then verified the correction: directed coverage 167 tests / 8 files / 0 fail / 874 assertions; typecheck 0; probe exit 0 at 40 no-callers / 81 test-only / 26 should-private; scoped diff-check 0 with CRLF notice only. Standard preflight EXIT=0: boolean implementations 336 / discarded returns 0; document references 3 generated / 8 handwritten / 1 structured / 3 reverse; typecheck 0; exact 5352 tests / 491 files baseline; exact unwiredMethods 40 baseline; core.hooksPath=.githooks.

[Career leaf-lock exact dead-owner recovery verification, 2026-10-07] Red-first, the old implementation left a killed child writer's raw character lock behind after root recovery, so a fresh same-character child still failed stale-lock admission. A real mutation that emitted a raw token instead of the owner record made the same kill/retry regression red again; exact restoration was green. The regression also proves live owner retention, legacy/malformed/unknown-version fail-closed behavior, and a competitor substituted at the final dead-owner unlink boundary survives. Root-directed sandbox-external verification exited 0 at 59 tests / 5 files / 57 pass / 2 existing capability skips / 0 fail / 305 assertions; typecheck exited 0; probe exited 0 at 40 no callers / 79 test-only / 29 should-private. The authoritative sandbox-external wrapper exited 0 in 622938 ms (stdout 254892 bytes, stderr 1252687 bytes); its child terminal summary was 5346 tests / 490 files / 5310 pass / 36 skip / 0 fail in 622.77s.

[GameSession setScene writer retirement verification, 2026-10-07] The retirement regression proves normal prototype and instance absence, then installs own and prototype same-name decoys to prove real Barn act/free movement plus compiled load/restore continue through #setSceneCanonical; the temporary prototype decoy is deleted in finally. A real dynamic mutation temporarily restored the old public wrapper and made the new retirement assertions red at 4 fail; exact removal restored private-authority to 6 pass / 0 fail. Existing directed evidence covered 14 files / 156 pass / 0 fail; typecheck exited 0; probe exited 0 at 40 no callers / 79 test-only / 29 should-private. Root then captured the authoritative sandbox-external full suite with wrapper EXIT=0 and DURATION_MS=480042 (child terminal summary 479.85s): 5342 tests / 490 files / 5306 pass / 36 skip / 0 fail, stdout 264455 bytes, stderr 1250481 bytes. The first standard sandbox-external `bun scripts/preflight.ts` then exited 0: 335 boolean implementations / 0 discarded returns; document references 3 / 8 / 1 / 3; typecheck 0; exact 5342 tests / 490 files baseline; exact unwiredMethods 40 baseline; and core.hooksPath=.githooks.

[GameSession world-facade lifecycle verification, 2026-10-07] Red-first, the old retained facade reached the closed backend and exposed `Cannot use a closed database`. A real mutation removing the resolver lifecycle check let the cache-only representative reader succeed after close while the SQLite-backed reader again leaked its bottom-layer error; exact restoration was green. Agent-4 related files exited 0 at 19 pass / 0 fail. Root-directed verification exited 0 at 24 tests / 6 files / 0 fail / 291 assertions; typecheck exit 0; probe exit 0 at 40 no callers / 79 test-only / 30 should-private. The authoritative full sandbox-external suite (sandbox-local Bun.spawn has known EPERM) exited 0 at 5342 tests / 490 files / 5306 pass / 36 skip / 0 fail / 35285 assertions / 450.97s, with 261853 stdout bytes and 1249973 stderr bytes. Standard preflight remains pending.

[GameSession closed lifecycle reader and mutator guards verification, 2026-10-07] Red-first, the old retained CareerStore facade still read the real Ada record after close; deleting its lifecycle check made the Career regression red and exact restoration returned it green. The old shared guard let history append and Luck decrease after close, while SAN reached the closed SQLite database and failed incidentally rather than at the lifecycle boundary. Deleting the new shared closed check made the three direct-mutation regressions red; restoring it returned them green. Restored agent-directed verification exited 0 at 29 tests / 5 files / 190 assertions; root-directed verification exited 0 at 43 tests / 6 files / 304 assertions; root combined focused verification exited 0 at 119 tests / 6 files / 0 fail / 725 assertions; root typecheck exited 0; root probe-unwired exited 0 at 41 no callers. The authoritative sandbox-external full suite (sandbox-local Bun.spawn hit EPERM) exited 0 at 5341 tests / 490 files / 5305 pass / 36 skip / 0 fail / 35296 assertions / 457.17s, with 271203 stdout bytes and 1249777 stderr bytes. Standard preflight remains pending. [Closed-read and compiled snapshot-ledger correction, 2026-10-08] The new lifecycle tests were red first: normal close, direct fail-stop, ordinary restore after CompanionManager had applied then threw, and durable compiled close all leaked session-bound reads. Making the common read guard a no-op produced 6 failures; removing the retained party-SAN resolver guard produced 1 failure. A real two-generation snapshot was re-signed with a duplicate `actionId`, and a separate record was re-signed with whitespace padding; direct validation and restore both reject each form without changing the target. Removing the uniqueness guard or the trim guard independently made its regression red. The initial complete run exposed 8 failures at the closed-reader and `runAction` outcome boundary; `runAction` now normalizes its initial generation read, returning `ordinary_execution_failed` for ordinary closure and `compiled_unavailable` for durable compiled closure. After restoration, 13 directed files passed 144/144; typecheck exited 0; probe was 39 no-callers / 86 test-only / 26 should-private; and the authoritative complete suite exited 0: 5411 tests / 494 files / 5375 pass / 36 skip / 0 fail / 35946 assertions. The final standard external preflight then exited 0: boolean implementations/discarded returns 336/0; generated-document references 3; handwritten payloads 8; structured payloads 1; typecheck 0; exact 5411 tests / 494 files and 39 unwiredMethods baselines; and core.hooksPath=.githooks.

[GameSession NPCStore lifecycle and PlayerSession visible_to-writer retirement verification, 2026-10-07] Red-first PlayerSession coverage made the old implementation fail two assertions: a default-public message carrying visible_to=['alice'] did not throw and would reach Bob, and PlayerSession.prototype still owned pushPerPlayer (12 pass / 2 fail / 133 assertions). Two real implementation mutations were independently red then exactly restored: deleting the own-visible_to rejection gave 13 pass / 1 fail / 134 assertions, and restoring the old pushPerPlayer implementation gave 13 pass / 1 fail / 137 assertions. Restored focused PlayerSession suite was 14 pass / 0 fail / 138 assertions. Root merged directed verification covered the GameSession-close NPCStore facade and message-route boundaries: 114 tests / 9 files / 966 assertions, zero failures; typecheck exited 0. Root authoritative full-suite evidence then ran the child `bun test --parallel=1 --timeout 30000` to exit 0 with CAPTURE_BYTES=1397838 and one terminal summary: 5337 tests / 489 files / 5301 pass / 36 skip / 0 fail / 35247 assertions / 552.08s. The sandbox-local temporary wrapper first hit child-spawn EPERM; the approved sandbox-external identical wrapper captured the successful child but exited 1 only because its post-capture check compared the untrimmed ` 0 fail` line. That wrapper verdict is not claimed as test failure, and the temporary file was deleted. Root probe-unwired exited 0 at 41 no callers / 78 test-only / 30 should-private. Final standard preflight remains pending.

[Legacy WorldState read/input ownership final verification, 2026-10-07] Before the generated-document mapping regression was added, root authoritative serial `bun test` exited 0 at 5329 tests / 489 files / 5293 pass / 36 skip / 0 fail / 35157 assertions / 804.73s. After the mapping regression, root reran the authoritative serial suite: exit 0 at 5330 tests / 489 files / 5294 pass / 36 skip / 0 fail, with 1,406,599 captured bytes in 542.70s. Typecheck exited 0. Root probe exited 0 at 41 no callers / 79 test-only / 30 should-private. The 46→41 no-caller change is transparently recorded as five existing legacy methods gaining test-only callers from the ownership regression, not as new production wiring or completion of an unwired-method cleanup.

## 编译闭环检查点 I 交接

### 本批最终 standard 已绿；交付边界保留（2026-10-13）

具名96874 outerEXIT0/status0/signalnull/capture1949229ms，logs1791907049173；
inner raw `analysis/diag/preflight-bun-test-IWC9Jr` status0/signalnull/errornull：
5707tests514files5671pass36skip0fail39164assert1911.61s，stdout284731B/stderr1277536B及SHA证据。
1084inputs 15:24:53.684Z→15:58:34.828Z unchanged；typecheck0/bool390discard0/
unwired39/refs3/8/1/3/hooks.githooks通过。21scene均PASS244.18–377.93ms、FuzuPASS178588.70ms，
不等79602根因已定位。仅将最新standard待验改为已验，保留下面所有真实红；baseline counts/
history不变。todo65仍open，外语料cleanclone/真实provider/world/live质量未完，索引延后。
now/handoff --no-test仅刷新文档，本次未跑测试字段不冒充full；依据是上述具名gate。
刷新后的quick只查快项，不替代full；保护index/architecture/AGENTS不动。

### 场景穷举预算隔离已验；最终 standard 待验（2026-10-13）

23847真实outer/native1/signalnull/capture2132559ms，raw604DuL：5686tests514files/
5649pass36skip1fail38755assert2091.28s，1084hash unchanged；唯一旧21scene单it10s在14s超时。
Fuzu pass246078.22ms不等79602根因已定位。仅改scene-id-bridge.test.ts为21独立具名case、
各仍10s，保留target/ending/negative，增加数量/唯一guard及其它未访问scene仍false；
净+21tests0files是预算隔离/覆盖增强，不是产品性能修复。真实固定查维修间变异native1：
0pass21fail11filtered43assert1file4.27s/logs1791902594079，生产精确还原后32/0/458/1file/
6.31s/logs1791902645609、typecheck0/1791902640287。70072内部full native0/signalnull/
errornull：5707tests514files5671pass36skip0fail39144assert1897.70s，raw
`analysis/diag/preflight-bun-test-7gPCVR` stdout281790B/stderr1277667B及hash/exit metadata。
外层EXIT1仅pass5671!=旧5650，typecheck0/bool390discard0/unwired39/refs/hooks正常，
capture1935786ms/logs1791904625798。基线5707/514/5671/36/0、unwired39，本批总+26tests/+1file；
最终standard仍待验，todo65/外语料cleanclone/live质量仍open。now/handoff仅--no-test，
保护index/architecture/AGENTS，不抹此前真实红。

### 本地完整日志接线已验；最终 standard 待验（2026-10-13）

诊断4文件把同次capture双stream/status/signal/error/bytes/SHA留存于本地ignored唯一目录，
保存失败failclosed；产品语义/参数/旧断言不改。真实跳persist变异native1：0pass2fail2assert/
1file68ms，logs1791899185568；4文件byteExact恢复95pass0fail566assert3files452ms，
logs1791899241081；typecheck0/1791899249491、frontendbuild0/33modules/Vite925ms/
1791899257814。preflight91461内部Bun native0/signalnull/errornull：5686tests514files/
5650pass36skip0fail38769assert1586.27s，1084freeze unchanged，raw为
`analysis/diag/preflight-bun-test-MwEt2w`（stdout290865B/stderr1270338B及capture.json）。
外层EXIT1仅新增5pass不符旧基线，typecheck0/bool390discard0/unwired39/refs/hooks正常，
capture1613346ms/logs1791899085556。基线现5686/514/5650/36/0、unwired39：+5tests/+1file
（诊断接线2+rawhelper3），最终standard仍待验。79602的Fuzu回执/重放红原因仍未知；
57940精确绿与本次full Fuzu pass127318.25ms只代表未复现，不是修好。至少11文件的
外部world语料cleanclone依赖仍open，不迁移/新增skip；todo65及真实PDF/provider/world/
live质量仍open。HEAD9dcef35 backup已remote，本批诊断未提交。now/handoff仅--no-test；
保护index/architecture/AGENTS，不把下面旧具名绿当本轮gate。

### 最终具名 standard preflight 通过（2026-10-11）

root standard preflight76433 nativeEXIT0/signalnull/error无，capture1671043ms、
stdout1104B/stderr0，rawlogs `analysis/diag/two-module-capture-1791701370371.*`，
876hash changed=[]。输出明确通过：bool390/discard0、refs3/8/1/3、typecheckEXIT0、
tests5681/513与baseline一致（judge要求pass5645/skip36/fail0）、unwired39、hooks.githooks正确。
输出没有assert总数/内部test耗时；plainfull72737的数仍是独立证据。仅更新最新待验gate为通过，
90733及两次full红历史保留；baseline counts/history不改。now/handoff --no-test仅刷新文档，
不跑测试，验收依据是具名76433。todo65仍open：真实PDF/provider质量、授权production world
scopes/model use、live runner接线及未提交交付仍未完成；index/architecture/AGENTS不刷。

### SAN 测试前提与最新完整绿（2026-10-11）

standard preflight90733 真实EXIT1必须保留：KP SAN Expected44/Received43，
tests1fail/pass5643!=baseline5644/bun test EXIT1；typecheck0、refs/hooks/unwired39正常，
876hash unchanged。控制entropy证实旧test忽略合法拒绝Result：LCG722→POW/max43，
set44 value_out_of_domain且三读不变；.25→61，set44ok并同步44。仅修正正例entropy/
Result前提，保留原44/背包武器断言，新增低POW拒绝1test；相关60pass255assert6files1.95s/
typecheck0。两真实生产变异各EXIT1后源码精确还原；完整hash/日志见手写master/engine/todo。
root plain `bun test` full72737 native0/signalnull/captureerror无：5681tests/513files/
5645pass/36skip/0fail/38709assert/922.63s，870hash changed=[]，rawlogs
`analysis/diag/two-module-capture-1791699487120.*`。基线5681/513/5645/36/0、unwired39，
旧5560净+121tests/+6files、最新SAN仅+1/+0。standard preflight仍待重跑，todo65open；
真实PDF/provider/world/live接线、历史skip归因缺口保持open。now/handoff仅--no-test，
index/architecture/AGENTS不刷；下面88120和所有旧红历史保留。

### 当前连续对话与公开 AI Player 验收（2026-10-11）

主控记录见 master-plan 最新 frozen-full checkpoint 与 todo-65 的
`compiledCurrentBatchFinalFullVerification`。NPC 单轮可信 previousTurn、前端连续
重试和 ambiguous 顶层 topicBound、公开 AI Player offline adapter 的定向验收已绿；
AI/UI 各四个真实实现变异均红并精确还原。公开 adapter 只使用 player-view、角色与
已确认结果；新 runner 仍未跟踪/未入库，不是 clean-clone 已交付可执行入口，
尚未接 live budget/CLI。不是实际人类自然度或外部模型质量证明；详细源码/日志见手写主控记录。

admission test harness 的三个原 exit/drain guard 已有确定性红证据；删除修复后的三个
重查 guard 的真实变异 native1（0pass/3fail/2assert），精确还原 hash
`406ba00470323c4be97352aca5bcb7378940b8036673edaad073e9e66d7978de`
后 29pass/279assert/1file/9.82s，native0。该 harness 缺陷不等于 full59530 的
追溯根因。full57520、59530 两次 native1 的历史和首 route 仅 outer harness
30s→60s、产品期限/断言不变的边界均保留在三份主控记录。

root full88120 `bun test --parallel=1 --timeout 30000` native0/signalnull/
captureerror无：5680tests/513files/5644pass/36skip/0fail/38728assert/1619.06s。
rawlogs 为 `analysis/diag/two-module-capture-1791696102950.{stdout,stderr}.log`，
870 frozen hashes changed=[]。基线据此更新为5680/513/5644/36/0，unwired仍39；
旧5560/507→+120tests/+6files（65094共享净+85/+4，AI+22/+2、UI+4/+0、harness+9/+0）。
旧38skip缺逐项历史证据，不能归因现36。quick80436 native0（bool390/discard0、
typecheck0、unwired39、hooks正常）跳过tests/counts，不是最终 standard preflight。
now/handoff 仅 `--no-test` 生成，不冒充新测试。todo-65 保持open：实际两业务PDF
编译发布/真实provider成对语言质量、production world scopes/model use、live runner
接线及最终 standard preflight仍待证实。notes/index、architecture、AGENTS不刷，
最新engine笔记和新public runner/test路径索引明确延后，保留下面其它手写历史。

`docs/compiler-master-plan.md` 是编译链的唯一主控计划。当前 `HEAD` 为 `8500297`
（`feat: expose structured compiled actions`），但当前工作树包含尚未提交的后续生产化改动。
原计划范围保持不变：I 是 hints → accepted MechanicsIR → closed-world/P4；II 是本地 artifact
保存/恢复；III 是公共编译入口对内存 pages/fixture 与真实 PDF 的端到端验证。II、III、投影与
GameSession 接入已在后续里程碑完成，本轮没有重定义这些检查点，而是在 open 的 todo-64 下补
可信 presentation 与 compiler control-plane 认证授权。未 commit、未暂存、未 push。

【现行 compiled P1 player façade，2026-09-20】snapshot schema 2.9/access 2.0 在 creator-bound owner
binding 上加入 creator-time、host-trusted 的单一 p1 player resolver；解析缺席或无效时安全回退
owner-only。该 player 只可读 GET /api/sessions/:id/player-view、提交 POST
/api/sessions/:id/player-actions。view 只给 safe check/archetype presentation 与 generic labels；
真实 compiled combat 可通过 façade 执行，choice 为 generation-bound HMAC opaque value。旧 runtime
routes 仍 owner-only，compiled WebSocket 继续 refused。

最终定向验证 45 pass / 0 fail / 911 expect；raw check library_use 泄露、investigator archetype 泄露、
mechanismId 暴露、任意 player role、successor access mismatch 五个真实 mutation 均令对应回归变红后
恢复。权威完整状态为 bun test exit 0：3483 tests / 258 files，3451 pass / 32 skip / 0 fail，19662
reported expect；bun run typecheck exit 0。expect 数在本仓不作为稳定基线。

【compiled lifecycle async RNG 恢复，2026-09-20】当前非 concurrent lifecycle fixture 的
withMockedRandom 以 try/finally 恢复 global monkeypatch，callback throw path 同样恢复。真实
exception-recovery mutation 令专用 lifecycle regression 为 0 pass / 1 fail，恢复后绿；lifecycle
定向为 24 pass / 0 fail / 587 reported expect，isolated fixture smoke 为 1 pass。跨 await 的 global
monkeypatch 测试必须串行：当前 helper 不协调 overlapping caller，未来 concurrent 覆盖需 RNG 依赖注入或
真正的 lock/AsyncLocal 设计。tests/files/pass/skip 才是基线，expect 只作该次报告。

此切片仍只支持 single p1 和 REST/polling。默认环境 authenticator 不能产生 player principal，部署者
必须注入 resolver/authenticator；没有 IdP、invite、rotation、per-person audit、多 player role 或
authenticated WebSocket。snapshot hash 不是 MAC，仍依赖 storage ACL。todo-64 因这些生产化缺口仍为
open。

最终根代理独立实测：`bun run typecheck` exit 0；`bun test` exit 0，**3370 pass / 32 intentional
skip / 0 fail，3402 tests / 249 files / 18594 expect（34.11s）**。`docs/test-baseline.json` 已只向上
收紧 tests/files/pass，并把直接实测的 `unwiredMethods` 上限从 84 降到 82；没有减少 skip 或降低
测试门槛。奖励/IR/可达性/restart 四文件独立复跑 66 pass / 0 fail / 435 expect。

真实复足 PDF 的 SHA-256 为
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5`（16 页、22 headings）。
两个假 heading 已排除，`黑夜中的尖叫`、`梦境之石`、`楼梯上的蜘蛛` 被上下文保留。「寻找劳伦」
第 6 页保守抽取 `劳伦的尸体`、`大圆环`、`屋子周围` 三个具名 discovery/context，贯通 legacy
`Section.items`、DocumentBlocks、graph、templates；NPC 名称和规则冒号行不提升。项目符号 discovery
guide 也须在 `Section.items` 与 DocumentBlocks 一致，不能让两份中间表示漂移。

真实 source-structure 回放使用 `prepareCompiler → dynamic queue IDs →` 一次明确 benchmark hints
`→ resolveCompiler → witness replay → GameSession`。queue 绑定真实 heading scope；无结局 fallback
只覆盖 source statements、不伪造终局。一次性 acceptance：22 headings / 3 clues / 4 playable scenes /
33 reachable states / 2 reachable endings / deadlocks 0 / failure risks `[]`，显式 discovery 覆盖默认项
的审计非空；两个 GameSession 终局为 `escape_with_dream_stone` 与 `lost_without_dream_stone`，terminal
后 actions=0/retry=`compiled_terminal`。证据为 gitignored `analysis/fuzu-compiler-acceptance`。

真实 LLM legacy ingest 在清理进程代理变量后本地获得 22/22 section、3/3 item；ModuleData 为 11
scenes / 1 item / 2 clues / 1 NPC / 0 dangling refs / 2 textual endings，产物在 gitignored
`analysis/ingest-fuzu`。这只记录本地方法和结果，不记录外部端点可用性。legacy
`scripts/ingest/e2e-run.ts` 对该 ModuleData **exit 1**：movement-smoke、completed=false、11 decisions /
11 scenes、neutral support 无 structured ending。legacy ModuleData 不猜 clue findMethods，且仍有未消费
顶层条目，所以不能称 legacy 路线已完成跑团；真正的终局证据是 compiler→GameSession。

`scripts/ingest/run.ts` 对 mandatory section/item classification 全空或零 usable scene fail closed；
后者包括无 heading 或无 classifyInputs，且在创建输出目录/首次写文件之前返回 `no-scenes`。部分分类、
无 item 文档与连接/结局/叙事既有降级契约不变。上述两个新负例先为 25 pass / 2 fail，恢复为 27 pass /
0 fail；最终全部 ingest 定向验证为 541 pass / 0 fail。

`docs/notes/index.json` 正由并行改动持有，绝不可在本轮刷新或覆盖；索引尚未登记
`docs/notes/ingest.md` 的表格结构/奖励状态纠正与 `docs/notes/engine.md` 的终局奖励方法记录，故依赖
索引的 open/warn 列表可能滞后。现有 `docs-index.ts split` 会同时重写 todo 与索引，不能只刷新
architecture；`docs/architecture.json` 的表格/奖励条目因此同样延后。

【当前编译执行态，2026-09-20】执行态包含 grounded hint proposals、内部有界 auto orchestrator、
普通 prose 的静态 `narrative_noncombat` NPC projection、generation-bound 的只读 compiled intent
API、source-bound item ownership，以及受限的 source-bound positive terminal rewards。模型只能在
当前 executable allowlist 内分类；选择结果必须再交给既有 structured deterministic action
transaction 执行。

物品闭环使用独立 item candidate 和显式 `item_binding`，`acquire_item`/`item_owned` 已贯通
MechanicsIR、closed-world、投影、durable GameSession 与同/跨进程 restart。MechanicsState 的
`ownedItemIds` 是权威，背包和场景物品只是 source-exact view。删除 candidate 的初始红测为
core_clue expected 1/received 0；修复后真实 clue 的 core/discovery 问题不再静默消失，缺失或篡改的
candidate 以 `invalid_draft_item_candidates` 保持 draft_only，artifact/projection 篡改在首次 world write
前拒绝。根代理相关八文件独立验证 74 pass / 0 fail / 337 expect。

奖励闭环从带真实 heading scope 的 `table_row` 生成 candidate，逐行 `reward_binding` 进入
MechanicsIR catalog；SAN、CM、CR 三行各有独立 provenance。终局统一按 CM cap → SAN recovery →
reputation 结算，确定性骰值、character-before frame、响应和最终角色状态在同进程与 fresh-process
restore 中逐代重算。重试不重掷，篡改在首次 world write 前拒绝。旧 `reward` effect 曾能验证通过却被
执行器静默过滤；新增红测先复现，现由 validator 与执行 guard 明确拒绝第二授予通道。

最终 `bun scripts/preflight.ts` 在沙箱外 exit 0：boolean 实现 173、丢弃返回值 0；typecheck 0；
3402 tests / 249 files 与基线一致；unwired 82；`core.hooksPath=.githooks` 且 commit-msg 判据生效。

【自动 mechanics/presentation 边界订正，2026-09-20】上段“最终 preflight 3402/249”是此前
奖励切片的历史快照，不是本轮基线：本轮完整 `bun test` exit 0，3413 tests / 250 files，3381 pass /
32 skip / 0 fail，18730 expect；提权后的 `bun scripts/preflight.ts` exit 0，typecheck、基线测试、
82 条 unwired 与 `.githooks` 均通过。`POST /api/compiler/auto-resolve` 现在只接受
`preparedArtifactId`、`preparedQueueHash` 和可选 `explicitHints`；caller presentation、trust、limits
及 detached artifact 都在模型、投影和 bundle 前 400 拒绝。自动结果即使 mechanics 为
`mechanically_closed` 也只返回 `presentation_draft_only` / `visibility_unresolved`，没有 artifact、graph、
projection、bundle ID、hints、来源/模型原文、audit quote 或异常 message，且零发布。仅私有的、
高熵且绑定 prepared identity/hash 的 continuation 保存闭合 hints；受控手工 `/resolve` 加独立
presentation 后重走全量复验才可投影/保存。本段“partial 不发 token、尚无 resume API”是当时快照，
已被下方自动续解订正取代；复杂 PDF/真实模型和完整部署治理仍是 open。`notes/index.json` 及
`architecture.json` 因并行修改未刷新。

【可信 presentation 与控制面认证订正，2026-09-20】公开 `/resolve` 不再接收 raw presentation，
只接受 catalog prepared identity/hash、hints 或私有 continuation，以及 server-minted review ID。
review 将每个展示字段绑定到 exact statement quote、evidence 与 heading scope；mechanics 字段仍从
MechanicsIR/draft 派生。当前又新增 authenticated operator-only
`POST /api/compiler/presentation-reviews`：principal 由 host authenticator 提供，body 不能自报 reviewer
或提供自由 presentation，响应不回显 source/graph/artifact/projection。

所有 compiler/catalog/compiled-session 创建路由现在先认证授权，再读取 body、catalog、模型或写入。
operator 拥有完整控制面；Keeper 只读已发布 bundle，且只能由 `bundleId` 建会话；player 无权限。
默认部署要求同时配置两枚不同的至少 32 字符 Bearer token；缺失、畸形、相同或 malformed host auth
均 503 fail-closed。完整账户/轮换/逐人审计、普通 session 和 WebSocket 身份仍未由此完成。

本切片根代理定向验证为 39 pass / 0 fail / 261 expect，auth+lifecycle 为 23 pass / 0 fail / 212 expect。
首次完整回归如实暴露八个旧测试 fixture 未注入新 Keeper principal：3386 pass / 32 skip / 8 fail；
只修 fixture 后 compiled action discovery/intent 为 35 pass / 0 fail / 310 expect，生产默认未放宽。
最终完整 `bun test` exit 0：3426 tests / 252 files，3394 pass / 32 intentional skip / 0 fail，
18752 expect（37.65s）；typecheck exit 0。三项真实变异（跳过 operator guard、信任 body reviewer、
恢复 player bundle 读取）均红后恢复；malformed authenticator 旧实现的 TypeError 也先红后修为稳定 503。
沙箱内 preflight 因 `cmd.exe` 子进程 EPERM exit 1，未冒充验证；同一命令提升权限后 exit 0：
typecheck 0、3426 tests / 252 files 与基线一致、unwired 82、`core.hooksPath=.githooks`。

【自动 mechanics 续解订正，2026-09-20】`POST /api/compiler/auto-resolve` 现在接受
`explicitHints` 或 `autoContinuationId` 二选一。partial 只有出现新增 validated answer 才写入新的
immutable continuation；恢复调用经同一 queue validator 与 orchestrator，只询问剩余问题。无进展复用
原 token 且零新文件，closed token 重放零模型调用；初始空/Malformed/refused/model throw 不发 token。
continuation 绑定 prepared ID、artifact hash、module/document/graph/queue identity，篡改 hints 后即使重签
envelope hash 也会在模型与写入前拒绝。最终 token 可供 authenticated review mint 与 manual resolve
消费，但仍不能自行发布 presentation。

根代理定向的读取→运行六文件为 43 pass / 0 fail / 375 expect；完整 `bun test` exit 0：3427 tests /
252 files，3395 pass / 32 intentional skip / 0 fail，18786 expect（38.25s）；typecheck exit 0。三项真实
生产变异（绕过 continuation identity、空 partial 发 token、重问已答题）均按预期红后恢复。当前正式
基线已上调为 3427/252。刷新基线与生成文档后的最终 `bun scripts/preflight.ts` exit 0：typecheck 0、
3427 tests / 252 files 与基线一致、unwired 82、`core.hooksPath=.githooks`。

生产化仍未完成：完整 runtime combat、一般 SAN 损失/疯狂副作用、skill growth、公开 automatic compile 工作流、
真实复杂 PDF + 真实模型验收仍开放。正向终局奖励子集完成不代表通用奖励抽取完成；普通 prose NPC
仍只是 narrative_noncombat。索引/architecture 延后项如上，不能把索引查询无结果解释成未实现。

### 当前工作树验收快照（2026-09-20）

浏览器 compiled-action 的 durable retry/reconcile 与 source-bound NPC dialogue
discovery 已完成：前者仅重放 live catalog 仍授权的同一结构化 action，后者以 reviewed
binding 的同 heading clue 复用 shared discovery executor，均不扩大运行时机制权限。

source-bound compiled combat core foundation 也已完成，但只在 compiled core：MechanicsIR、
shared mechanics executor、reachability 与 compiled-session snapshot 共享有界、单敌人的
canonical encounter state 和 typed combat outcome。它不是可实际运行的战斗。combat 的 source
identification/queue binding、projection/runtime package、GameSession/RulesEngine 结果生成和
settlement、durable HTTP combat execution 都仍开放；definition 的 `dodge`、`fight`、`npcDamage`
也尚未被 runtime 消费。

当前权威完整 `bun test` exit 0：3451 tests / 255 files，3419 pass / 32 intentional skip /
0 fail，18968 expect。root focused 六文件为 95 pass / 0 fail / 602 expectations；typecheck
exit 0。root 提权实跑最终 preflight exit 0：boolean impl 184 / discarded 0，docs refs 3，
payload docs 8+1，3451 tests / 255 files 与 baseline 一致，unwired 82，`core.hooksPath`
为 `.githooks`。`docs/notes/index.json` 与 `docs/architecture.json` 仍按既定边界延后，
不能刷新或据此声称索引/architecture 已完成。

### Source-fact scene-state transition 现行交接（2026-09-24）

Queue/hints 3.1 将 root-exact、same-heading 的 `scene_state_transition` 编译成固定
MechanicsIR：`scene_enter` 或带前置线索的 `clue_found` 只能发现一个 canonical clue；
mechanism/interpretation ID、private sentinel、location、guards/effects 均由编译器派生，
调用方不能提供 state key 或 AST。合法的多种发现方法可共存，匹配 clue/location 的
default observation 才被替代。External proposal 默认只允许 `existing_clue_discovery`，
只有 server-trusted policy 显式 opt-in 才暴露并接受 transition。

真实 Fuzu 的两个 root 是负控，继续保持 `source_only`，不能为了正例而自动授予包含
检定细节的整条 clue。三项真实实现变异——移除 output-not-found guard（sentinel 保留）、
恢复 prefix-based disposition skip、绕过 grounded policy-kind gate——均令对应回归变红后
精确恢复。Exact Fuzu 脚本 exit 0：194 questions / 192 answered + 2 N/A child /
47 deterministic FakeLLM calls，runtime 仍为 4 scenes / 3 clues-discoveries / 1 item /
1 static NPC / 0 dialogue-encounter-reward / 2 endings。`bun run typecheck` exit 0；最终
`bun test` exit 0：3634 tests / 278 files / 3602 pass / 32 intentional skip / 0 fail /
21198 assertions / 84.90s。

这是 todo-64 下的受限能力，不证明 arbitrary PDF、真实模型、高保真内容宽度或生产目标
完成；todo-64 保持 open。本轮未探测或调用外部模型，未 commit、未 push。
`docs/notes/index.json` 与 `docs/architecture.json` 因并行改动继续未刷新，不能用其滞后
否定当前实现，也不能宣称索引或 architecture 已同步。





























































































































































































































































































































































































































































































































































































## 第一件事：读这三份

```
docs/now.md                          现在在哪（30 秒）
bun scripts/docs-index.ts todo warn  动手前要扫的坑
bun scripts/preflight.ts             跑一次，确认接手时是干净的
```

**不要整份读 `docs/architecture.json`**（36KB）。用查询：

```
bun scripts/docs-index.ts arch <关键词>    架构里找模块
bun scripts/docs-index.ts log <关键词>     查某问题记录过没有（搜正文）
```

## 工作纪律（踩出来的，不是规范文档）

1. 改动前后各跑一次 `bun scripts/preflight.ts`。它把反复犯的几类错做成了机器判据：切割截断语义单元、搬运残渣、循环依赖、语法错。别靠记性。

2. 同一类失误连着犯到第 3 次就停手，换一双眼睛（另一个模型 review diff）。本轮机械切割边界连错 5 次才自己发现——失效模式相同的人查不出自己的系统性错误。

3. **判据没验过就不算数**。写完诊断脚本先确认它能区分对错两种情形：第一版「切割截断」判据出了 174 个假阳性，第一版「倒下仍行动」判据永远报警。判据本身要做变异检验。

4. 提交信息用英文、格式兼容 GitHub（只对新提交生效，不追溯历史）：subject 英文祈使句 + conventional 前缀（feat/fix/docs/test/refactor/chore）+ 冒号 + 空格，≤72 字符；允许在 `"..."` 或「...」内引用中文术语/原文（如 `fix: "潜行" was listed as an attack verb`）。空一行。body 每行 ≤72 字符手动换行——正文长不是问题，不换行才是（GitHub 不折行，会横向滚动）。**body 不用 markdown 粗体/斜体**：GitHub 提交消息不渲染 markdown，`**x**` 会原样显示成星号；「」中文引号没问题，继续用。模板见 `.gitmessage`（生效需手动 `git config commit.template .gitmessage`，这条配置不随提交走，新 clone 默认不生效）。实测最近 80 条：英文标题 55 条平均 82 字符、超 72 的 30 条（55%），说明「英文」不等于「兼容 GitHub」，是两件事，这条约定对两者都管。已有 347 条英文历史提交（含切到中文前那 320+ 条）与 28 条中文提交（`9afbe9e` 起）都不按这条约定判违规——切换点 `0880f75`（最后一条英文）→`9afbe9e`（第一条中文）是有意决策，不是事故，中文提交保留原样不重写。机器判据见 `.githooks/commit-msg` + `core.hooksPath`，preflight 第 12 项检查是否真的装上；未装上时这条只能靠人遵守。

5. 先想再写：不确定就问，把多种理解都列出来再动手。pendingConfirm 统一成单字段时没想过多 PC 场景——跨 PC 泄漏拖了一整轮才现形（5f01296）。

6. 只改必须改的：顺手做的事一旦超出任务范围，副作用大概率不会被自己发现。索引轮静默把 index-world-model.md 从 348 行精简到 178 行，留下两处悬空引用（aca5d68）。

7. 答案已经确定就用代码，别再问模型一遍。模组名里的「检查」把「加载模组」判成技能检定，改成前缀直接判定（src/llm/intent.ts:457-467）。

8. token 预算是硬约束，加一条先考虑删一条。index-program.md 曾 2152 行/每次读约 40k token，拆成 JSON + 只追加的 log（f6f5a7a）。

9. 先读再写，别只看片段就断言。「两套世界状态」读了字段才发现是一份状态两半实现，四处同一事实各存一份（todo-03）。

10. 测试要验意图，不是验现状。32 态穷举发现声明式结局数据与硬编码 if 链有 10 态不一致，修的是数据不是判据（4f68eda）。

11. 长流程要设检查点。模拟写死「跑满 30 回合」，第 6 回合已经脱轨，后面 23 回合都是在噪音里空转（docs/notes/engine.md:780）。

12. 惯例优先于个人品味。提交信息在 0880f75→9afbe9e 之间无声从英文切到中文，354 条对 21 条一直没人察觉（todo-40）。

13. 失败要主动喊出来，别指望别人从"零条 warn"里猜。围栏解析静默回落 regex 两轮模拟没定性（todo-29）；同一个"零"曾表示两种相反状态（0dbd2b8）；本轮启动挂起 8 分半没有任何信号（ebe9b95）。

14. 提交信息的语言在 `0880f75`（最后一条英文）→ `9afbe9e`（第一条中文）之间无声切换，此后（2026-08-30 实测，`git rev-list --count 9afbe9e..HEAD`=20，加 9afbe9e 本身共 21）21 条全中文，之前 354 条全英文（含 7 条在英文句子里用 `"..."`/「...」引用中文术语，如 `fix: "潜行" was listed as an attack verb`——那 7 条整体仍算英文，不是例外）。**已裁决保留这 21 条中文提交原样，不重写历史**：正文信息密度很高（根因链条、变异检验记录、实测数字），重写的收益是"好看"，风险是"弄坏一批高质量记录"。往后新提交按 rule-04 用英文——这是两件独立的事："保留旧的"和"新的怎么写"不冲突，也不代表旧的违反了当时不存在的规则。免得后人翻 git log 时以为切换点是一次事故。

15. 语义矛盾探针（`scripts/diag/probe-semantic-contradiction.ts`）是非确定性判据（LLM 驱动），只能告警、不能当 preflight 门禁——不接入 `bun test`，产物落 `analysis/`（gitignored），任何候选都需要人工核对原文后裁决。引用它的结论（准确率、误判数）时必须记模型名/日期/样本数，不能当常量用：实测 ecnu-plus 即使 temperature=0，同一批校准样本连跑 3 轮结果都有波动（校准命中率 15/21，两个已知阳性均在多数轮次里被正确标出），单轮结果不足以判断探针灵不灵。

16. `end-narration-32-states.test.ts` 里的旧 `oldIfChainOracle` 32 态穷举已 `describe.skip` 退役（开发·摄取管线校准 阶段3，`966f9e0`）——它冻结的是「if 链 → 声明式求值器」那次重构的行为基准，这一轮 True End 条件被故意改变，继续拿它当基准等于用上一次的契约阻止这一次的变更。文件里保留但跳过（不删除），是为了让后人知道这段历史存在、不是被随手抹掉。`bun test` 报的 32 条 skip 均来自这里，是有意为之，不是被跳过的失败——回归核查时看到 32 skip 不必追查，看到这个数字变化（无论增减）才需要关注。

## 启动后端做实跑（模拟局/手动测试）

**不要**用 `start "" /b bun run server > out.log 2> err.log`——这条写法
两个毛病占全了：`bun run server` 是包装脚本，会再 spawn 一个子进程，
杀掉包装脚本后真正监听端口的那个变成孤儿；`start /b` 不脱离控制台，
子孙进程继承调用者的 stdout/stderr 句柄，等的是"管道关闭"不是"进程退出"，
工具会永远等不到 EOF、空转。正确用法已经写进仓库（这条已经在模拟 prompt
里丢过一次，模拟 prompt 每轮重写不算数，脚本才算）：

```
bun run dev-server:start     启动，PID 落 .dev-server.pid，日志落 server-out.log / server-err.log
bun run dev-server:stop      按 PID 干净地杀掉，不留孤儿
bun run dev-server:status    看还在不在
```

服务端口默认 **3099**（不是 3000），见 `src/api/server.ts:1037`，用环境变量
`PORT` 覆盖。脚本本体：`scripts/dev-server.ps1`。

## 提交信息（rule-04，只对新提交生效，不追溯历史）

subject 英文祈使句 + conventional 前缀（feat/fix/docs/test/refactor/chore）+
冒号 + 空格，**≤72 字符**；允许在 `"..."` 或「...」内引用中文术语/原文
（如 `fix: "潜行" was listed as an attack verb`）。空一行。body 每行 ≤72
字符手动换行——正文长不是问题，不换行才是（GitHub 不折行会横向滚动）。
**body 不用 markdown 粗体/斜体**：GitHub 提交消息不渲染 markdown，
`**x**` 会原样显示成星号；「」中文引号没问题。模板：`.gitmessage`
（生效需手动 `git config commit.template .gitmessage`，不随提交走）。

⚠ 「回到英文」不等于「兼容 GitHub」：已有 347 条英文历史提交里，最近
80 条的英文标题平均 82 字符、超 72 的占 55%——本身就不兼容这条规则，
只是没人量过。这条约定不追溯：历史提交（含 28 条中文，切换点
`0880f75`→`9afbe9e`，有意决策不是事故）一律不重写。

机器判据：`.githooks/commit-msg` + `core.hooksPath`，preflight 第 12 项
检查是否真的装上——没装上时这条纯靠人遵守，装了没配置和没装看不出区别。

## 环境坑

- **PowerShell 5.1**。仓库源码 UTF-8 **无 BOM**，`Select-String`/`Get-Content`
  读中文会 mojibake → 用 Read/Grep 工具或 `fs.readFileSync`
- `bun run x.ts *> file` 会把 UTF-8 写坏。诊断脚本一律走回调在内存收，
  自己 `Bun.write` 落盘。**曾因此得出「12 局 0 次触发」的假结论**
- `git checkout <sha> -- <file>` 会**同时改索引**。变异检验后用 `Copy-Item` 还原即可，
  多跑一句 `git checkout HEAD --` 会把未提交的改动冲掉（踩过）
- 测试**只有条数是可靠回归信号**，基线在 `docs/test-baseline.json`；
  `expect()` 计数会被无种子的随机测试搅动。已知两条偶发假红：
  `coc-engine.test.ts:131`、`npc-reaction.test.ts` 的「高稳定性减少负面情绪」
- `typescript@7.0.2` 是 native preview，`require("typescript")` **没有** `createSourceFile`。
  要解析 TS 就用 `Bun.Transpiler`（`scanImports()` 是真解析器）

## 验证手段（离线，不用 API key）

| 脚本 | 量什么 | 判据在哪 | 校准测试 |
|---|---|---|---|
| `scripts/diag/diag-fuzz.ts` | 通关率（= 正常返回**且**有正式结局）、死循环 | `src/diagnostics/fuzz.ts` | `diag-fuzz.test.ts` |
| `scripts/diag/diag-wounds.ts` | 伤势分级／重伤检定／惩罚骰 | `src/diagnostics/wounds.ts` | `diag-wounds.test.ts` |
| `scripts/diag/diag-combat.ts` | Boss 还手（按攻击者身份，不按技能名）、玩家掉血 | `src/diagnostics/combat.ts` | `diag-combat.test.ts` |
| `scripts/diag/diag-downed.ts` | 昏迷期间本人是否还在**掷骰** | `src/diagnostics/downed.ts` | `diag-downed.test.ts` |
| `scripts/diag/diag-phrasing.ts` | 玩家说法能否匹配到场景 | `src/diagnostics/phrasing.ts` | `diag-phrasing.test.ts` |
| `scripts/diag/audit-backup.ts` | 哪些数据丢了不可再生 | `src/diagnostics/backup-classify.ts` | `diag-backup-classify.test.ts` |
| `scripts/diag/probe-llm.ts` | LLM 通不通（**实际发一次请求**） | — | — |
| `scripts/diag/probe-llm-move.ts` | LLM 消歧值不值得接（重点是它肯不肯说「说不准」） | — | — |

⚠ 上面五个跑局脚本都写死 `LLM_DISABLED=true` —— **它们量的是离线行为**。
这不是缺陷（要可复现），但别把结论当成「整个引擎都这样」。
判断 LLM 通不通**必须实际发一次请求**：`bun scripts/diag/probe-llm.ts`。
`bun test` 输出里那句 `[config] No LLM_API_KEY set` 是**测试在验证无 key 的降级路径**，
跟真实可用性无关，最容易被当成证据。

⚠ **这些判据本身出过六次错**（详见 `docs/review-request.md`）。已做的返工：

1. **判据与脚本分开**。判断逻辑抽成纯函数放 `src/diagnostics/`（入库、可测），
   `scripts/diag/*` 只负责跑局和排版。早先脚本本体放在 `tools/`（.gitignore
   排除），判据留在那里等于没人守——后来整批搬进了 `scripts/diag/` 并入库。
2. **每条判据三种输入都有测试**：行为正确 → 通过；目标行为错误 → 失败；
   文本相似但合法 → 不误报。少了第二种就是「永远通过」，少了第三种就是「永远报警」。
3. **不再猜自然语言**。诊断读 `src/play/events.ts` 的结构化事件流，
   因为有些事实**文本里根本不存在**：重伤体质检定失败导致的昏迷没有 `HP n → 0` 那行，
   `➜ 米戈 【格斗】` 看不出攻击者是敌是我。补正则只会补出下一个假阳性。
4. **seed 现在控制整局**（`src/diagnostics/run-harness.ts` 接管 `Math.random`）。
   实测：同 seed 的事件流与播报文本**都可复现**，可作确定性回归依据。
   `scripts/diag/diag-fuzz.ts` 每次都把这条自检的结果打出来 —— 它是量出来的，不是声称的。

用它们之前仍然先确认能区分对错两种情形，别信「全绿」。
判据自己会说明三种「不算通过」的情形：
样本数为 0（没有可判的样本）、身份不可分辨（两名调查员重名）、以及本轮有异常局。

**这套判据上线后立刻报出真缺陷，都已修**（各带正/反/干扰三侧测试 + 变异检验）：

| 缺陷 | 谁报出来的 | 旧判据为什么看不见 |
|---|---|---|
| `askCounts` 模块级 Map 跨局残留 | fuzz 的复现自检 | 旧脚本没有复现自检 |
| 昏迷者还在掷「挣脱陷阱」 | downed | 那条昏迷路径没有 `HP n → 0` 播报 |
| 昏迷的同伴还在掷急救 | downed | 同上（且两人重名时无法归属） |
| 战斗攻击不读伤势惩罚 | wounds 的惩罚骰分账 | 旧判据数 `/惩罚骰/` 行数，疲劳的照样计数 |
| 两名调查员可能重名 | downed 的身份不可分辨检测 | 名字是日志里唯一的身份标记 |

用法：跑局类脚本都收 `[局数] [起始局号]`，
`bun scripts/diag/diag-downed.ts 3 4` = 第 4~6 局，便于分批跑而不重叠。

## 手上还挂着的（22）

- ️ 「引擎别再替玩家挪窝」这一步单独做不成立（2026-08-20）
  `docs/notes/engine.md:526`
- ️ 引擎的移动是「给选项 + 不选就替你选」（2026-08-20）
  `docs/notes/engine.md:602`
- 载荷文档陈述反向传播进生产代码——这是第二次（2026-08-26）
  `docs/notes/engine.md:624`
- 改了被判据观测的行为，没同步检查观测者的失败分类——这是第三次（2026-08-27）
  `docs/notes/engine.md:648`
- 已知语义：activePlayerId 是粘性的，多端下会互相踩（2026-08-28）
  `docs/notes/engine.md:694`
- 可观测性复制了它要消除的歧义——这是第四次（2026-08-29）
  `docs/notes/engine.md:714`
- 防线装在让它永远通过的动作下游（2026-08-29）
  `docs/notes/engine.md:739`
- 声明式数据是装饰品——这是第五次（2026-08-29）
  `docs/notes/engine.md:759`
- 模拟换了输入分布，把唯一没结论的问题绕过去了（2026-08-29）
  `docs/notes/engine.md:779`
- 固定回合数把第 6 回合的发现埋进 24 回合噪音（2026-08-29）
  `docs/notes/engine.md:792`
- 外部模型的根因推测四条全错（2026-08-29）
  `docs/notes/engine.md:806`
- 整理索引的那一轮自己制造了悬空引用（2026-08-29）
  `docs/notes/engine.md:830`
- 两个运行时各持一半——这是第四次（2026-09-01）
  `docs/notes/engine.md:848`
- 引擎教了玩家一个自己不认识的词——这是第二次（2026-09-02）
  `docs/notes/engine.md:884`
- ️ 一直在报的那个数不衡量目标：可运行性是 1/27（2026-08-20）
  `docs/notes/ingest.md:748`
- 手抄本没有校验源就必然漂移（2026-09-02）
  `docs/notes/ingest.md:1600`
- 工具绿灯 ≠ 没问题——三方审计的能力边界撞上真实案例（2026-09-02）
  `docs/notes/ingest.md:1632`
- 改一处漏同文件另一处（2026-09-02）
  `docs/notes/ingest.md:1663`
- 管线继承基准 id：把命名体系差异从内容差异里摘出来（2026-09-02）
  `docs/notes/ingest.md:1695`
- 块分类几乎全灭：JSON 键带正文，不是 token 截断（2026-09-02）
  `docs/notes/ingest.md:1734`
- 展示格式渗进输出契约——这是第三次（2026-09-02）
  `docs/notes/ingest.md:1762`
- 数据化躯体建模等待原始描述（2026-09-06）
  `docs/notes/world-model.md:56`

## 最近做了什么

- 9dcef35 chore: backup worldmodel pipeline artifacts
- 8500297 feat: expose structured compiled actions
- f9d53d8 feat: restore compiled sessions after restart
- 551a0e5 feat: add compiled artifact bundle catalog
- 552af6f feat: expose compiled module lifecycle over HTTP
- 908c332 docs: close compiler delivery records
- 9354054 feat: integrate compiled artifacts with GameSession
- 107c99f feat: project compiler artifacts to ModuleData
- c0d3cb4 feat: add public compiler artifact API
- 4c1f08d feat: persist validated compiler artifacts
- 5095efe feat: add deterministic compiler process simulation
- 1fea0b4 fix: harden compiler delivery verification

## 代码地图

拆分之后 `play-module.ts` 只剩骨架（车卡／世界初始化／主 while／结局结算）：

| 文件 | 装什么 |
|---|---|
| `play/scene-pipeline.ts` | 一次进场的完整流水线（进场→NPC→对话→线索→选下一步） |
| `play/npc-dialogue.ts` | 对话生成 |
| `play/clue-check.ts` | 线索检定（skill 优先、failback 兜底） |
| `play/traps.ts` / `combat.ts` | 陷阱 / Boss 战 |
| `play/checks.ts` | 检定、伤势、伤害 |
| `play/run-state.ts` | 本局状态，按「谁在写」分组（Cast/Cursor/Dedup/WorldModelCtx） |
| `play/narration.ts` | 播报输出层 |

**依赖单向**：`play-module → play/*`。子模块反向 import 就是环，
preflight 会报（tsc 不报）。
