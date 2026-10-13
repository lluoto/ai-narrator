# 世界模型模块 / 跨书分析与设计边界

> 从 2026-08-29 至 2026-09-06 的世界模型设计讨论整理。本文只追加；索引由 `bun scripts/docs-index.ts` 重建。

### ✅ 来源绑定的双管线与后续设计层（2026-09-06）

小说提取与西幻设计转换必须分层：先保留来源事实、来源推断、叙事特权候选和证据 ID；再由下游设计层决定是否可迁移。`rule` 管线提取显式、可重复的规则；`special` 管线提取书级特殊系统和叙事特权。任何模型输出都不能自动成为 `confirmed`。

设计转换层不能反写提取层。D&D 映射、跨书相似、文化兼容性和任务启发都属于设计分析元数据，不是原文事实。

### ✅ 中国玄幻语料进入西幻世界的文化转换边界（2026-09-06）

中国作品中的宗门、灵石、境界、天机、因果、修炼等内容应如实保留为来源概念，但不得未经转换进入西幻运行时。震旦定位为极东、受地理和政治路线阻隔的文化区，只通过少量行商、使团、学者、旅人、遗物或飞地与主舞台接触。

后续设计只吸收机制结构：触发、成本、效果、限制、反制和社会后果。文化表层和本地落地必须分开。具体政策见 `D:\aitrpg\世界模型\worldmodel\DESIGN_TRANSLATION_POLICY.md`。

### ✅ 武术与仙侠内容的武僧近似映射（2026-09-06）

不额外建立武术、气、真元或仙侠能力树。来源中与武术相近且功能边界足够明确的内容，优先映射到既有武僧的 `Focus`、职业特性、子职、专长或受限魔法物品。

调息、爆发、轻功、点穴、护体和冥想恢复只有在触发、成本、持续时间、限制和反制接近既有能力时才可映射。境界突破、渡劫、飞升、御剑、灵根、洞天和宇宙因果默认 `source_only` 或 `no_transfer`。

### ✅ 主角独有机制与叙事道德例外分离（2026-09-06）

必须区分：

```text
mechanism_access: 谁能获得或使用规则、物品、能力、系统
narrative_exception: 主角是否获得不同的道德、制度或剧情后果
```

只有明确独占、唯一前置条件，或同条件下其他角色无法使用的比较证据，才能判定 `holder_specific` 或 `narrative_privilege_candidate`。职业、物品、阵营和地点范围窄，不等于主角独有。

重生记忆、未来知识、唯一攻略知识、剧情豁免和明确独占收益默认进入叙事特权账本，不进入通用世界规则、跨书机制家族或运行时因果模板。

### ✅ 社会规范与极端利己主义分析（2026-09-06）

小说可以分析角色行动、角色主张、叙事/他者评价、剧情奖励/代价/免责和制度激励，但不能仅凭文本断言作者私人信念或读者整体认同。

分析维度包括个人利益与集体义务、他人工具化、互惠信任、规则合法性、暴力与强制、责任修复、等级特权、对外群体同理和主角道德例外。与教育或公民规范比较时必须先声明具体基线，例如人格尊严、互惠责任、规则一致适用、权力滥用防护和损害修复。

读者倾向必须使用独立的公开评论、论坛或调查语料，并记录平台、时间、采样和语境限制。分析结果只生成 `social_norm_candidate`、`institutional_incentive_candidate` 等下游候选，不自动成为运行时社会规则。完整政策见 `SOCIAL_NORM_ANALYSIS_POLICY.md`。

### ✅ 跨书主角碰撞作为世界模型可用性评测（2026-09-06）

跨书碰撞不是主角战力排名，而是检验世界模型能否在固定前提下执行能力契约。至少两本书完成 v2 registry 后，按证据构造 actor profile，声明地形、距离、视线、知识、准备时间、外部资源、超自然环境、胜利条件和时间限制。

规则执行器结算前置、成本、冷却、目标和直接状态；世界模型推演物理/社会派生后果；LLM 只能叙述已提交结果，不能补写缺失免疫或胜利条件。默认排除 `narrative_privilege_candidate`。结果只允许 `decisive`、`conditional` 或 `unresolved`，并统计证据追溯率、能力契约完整度、资源记账、反制覆盖和未决关键点。规范见 `CROSS_BOOK_COLLISION_EVALUATION.md`。

### ✅ D&D 3.0/3.5 神器分析需先提取原文（2026-09-06）

其他模型提供的神器摘要只能作为处理提示，不能作为证据。正确顺序是：取得可用原书/节选，提取条目和规则交叉引用，建立页码/段落证据锚点，展开标准关键词，再做神器层级和设计转换。

神器分析拆为四层：基础武器、增强加值、标准能力关键词、神器专属能力。`+5` 是 3.x 顶级武器常见底盘，但不是神器普遍条件；非武器神器无统一加值。只有明确涉及神格、神性加值、神性存在或对应神祇规则时，才标记 `divine_combat_relevance`。未经原文核验的札斯曼匕首、修玛之枪等记录只能保持 `candidate_pending_source_verification`。

### ❓ 数据化躯体建模等待原始描述（2026-09-06）

暂不从“取消弱点”“普通人致死伤延缓”等概括语句推导运行时能力。拿到具体原文后，先以战地急救和创伤后果的抽象基线建立 `damage_event`，再分析弱点覆盖、功能失能、延迟致死、核心同步/锚点、救治窗口、代价、上限和反制。小说单句存活描写不足以推出完整规则。

### ✅ 重载必须原子替换全部索引；可检索不等于权威世界模型（2026-09-26）

`WorldModelLoader.load(A)` 后再 `load(B)` 不能只清 `entries`：按小说、类型、版本、D&D 映射和高幻觉风险建立的索引也必须一起替换，否则 B 的查询会泄漏 A。正确做法是在局部完成解析和全部索引构建，成功后一次性替换；missing、读取失败、全无效或仅空白字段的 replacement 都进入 unloaded，并清空旧索引与消费状态。旧实现的空白条目和消费状态用例先红，修复后 loader/status/sharing 定向 18/18。

真实 v18 资源载入 383,688 entries / 73 novels / 424 types；Cthulhu 资源载入 145 / 7 / 11，二者也实际进入 fresh GameSession 的 KP 上下文。这只证明只读提示参考链可运行。当前 loader 仍缺 trusted-root containment、manifest、内容哈希验证、严格 schema 和 compiler module/corpus scope；因此数据不得成为规则真相或写入 GameSession/SQLite 世界真相。`docs/notes/index.json` 有并行改动，本条索引刷新延后。

### ✅ compiled 世界模型必须由 bundle scope 授权，不能回退共享全库（2026-09-26）

共享只读缓存不等于共享查询权限。compiled session 过去直接使用 v18 全库和 legacy Cthulhu aggregate；`allowedWorkIds/corpusScopeId` 没进入 artifact/catalog/session 链，另一模组曾经可用的候选会泄漏到当前模组。现将 server-owned Cthulhu binding 纳入 catalog bundle hash：绑定 module/artifact、canonical manifest digest、verified real root identity、排序唯一 allowed works、corpus scope、transfer policy 与 scope hash。保存、加载、session install 和 restore 都校验；A/B work、跨 module、磁盘篡改或 bundle 混配均 fail closed。

compiled bundle 没有合法 binding 时只禁用世界模型注入，MechanicsIR 跑团仍正常；绝不回退 v18 或 migration-only aggregate。普通 session 的 legacy path 保持兼容。受限 adapter 复用已验证 dataset 与同一 scope selector，prompt receipt 保存 work/chapter/source/text hashes 和 rights path，但只作叙事参考，不写规则或世界状态。v18 仍因缺少可信 per-work manifest/content mapping 而在 compiled path 禁用。HTTP 不返回 binding/root；`docs/notes/index.json` 与 `docs/architecture.json` 有并行改动，本条索引刷新延后。

### v18 的 novel 标签不是 compiled 授权域（2026-09-26）

只读复核确认 v18 主库虽然有 383,688 条与 73 个小说标签，但 loader 只强制非空 `type/chapter`；`novel` 可缺失，其余字段宽松放行。记录没有稳定 work/candidate ID、逐条 source/text hash、evidence span、rights/provenance 或与原文绑定的 published artifact manifest。旧 integrator 的 `activeNovel` 还是可选值，缺失时会跨全库检索，因此不能复用为 compiled scope selector。

现阶段正确策略仍是：无合法 Cthulhu binding 的 compiled session 正常执行 MechanicsIR，但世界模型上下文为空；不能按文件名、小说名、运行目录或 partial dataset manifest 自动 join。若要启用某个 v18 来源，必须从原文重建新的单作品 source-bound artifact 并独立发布，而不是给 legacy extraction 补一张推测 registry。相关离线 scope/dataset 回归 22 pass / 1,535 assertions；未调用外部模型。索引刷新继续延后。

### ✅ 普通 GameSession 的 legacy 模型也必须先有可信精确作品域（2026-09-28）

此前「compiled 已隔离、普通 legacy path 保持兼容」的表述有缺口：`WorldModelIntegrator` 的 `activeNovel` 是可选值，缺失时会使用全库查询；旧 ordinary `GameSession` 没有设置它，且 Cthulhu aggregate 还按 `getByType` 做全局切片。因此 compiled artifact scope 即使正确，也不能阻止普通会话的 A/B 作品互漏。

最小修正不是另建 registry 或第二套 selector，而是在 `GameSessionRuntimeDependencies` 增加 server-owned、runtime-only 的 exact `worldModelNovel`。只有非空、无首尾空白、非 loader 合成 `未知` 的值可用；无值、空白或带空格的值在任一 legacy `isLoaded/load` 前就清空 KP 上下文。加载后的 v18 `getByNovel(scope)` 必须非空且每个 entry 的 `novel` 与 scope 完全相同；否则 fail-closed。有效 scope 写入既有 `SceneContext.activeNovel`，由已有 integrator 执行 scoped 查询。

Cthulhu aggregate 使用同一 scope：必须有完全同源的 `getByNovel(scope)` bucket，随后只允许 `getByNovelAndType(scope, type)`。aggregate 没有该作品、bucket 混合或条目缺 source novel 时只返回空；绝不以 `getByType` 或全局 slice 补偿。这样 v18 合法而 aggregate 缺作品时，v18 的 scoped 参考仍可保留，Cthulhu 部分为空。

先红证据是 5 个反例：无 scope 仍读取两个 loader、A/B 同 keyword 互漏、空白/带空格 scope 仍读取、未知/混合/缺来源 bucket 仍注入、以及 v18 A 配 aggregate B 时 B 文本泄漏。三项真实实现变异也均红后还原为绿：移除 `SceneContext.activeNovel` 会泄漏 B 的 v18 relation；把 scoped deity 查询恢复为 `getByType` 会泄漏 B 的 aggregate deity；禁用无-scope guard 会重新触及 legacy loader。扩展定向为 73 tests / 6 files / 0 fail，typecheck exit 0；根完整 `bun test` 为 4046 tests / 318 files / 4014 pass / 32 skip / 0 fail / 23658 expectations / 207.57s。

这只是 fail-closed 的普通运行时边界，不是 durable artifact binding，也不是 legacy v18 的 source-bound 授权。当前普通 HTTP factory 不传入 trusted scope，故安全地得到空 context；HTTP body、module metadata 不能选择它。CLI 自有 `activeNovel` 路径和 compiled binding 路径不在本次改变范围。后续若要让普通 HTTP 可用，必须单独定义可信 scope 的来源、持久性及其与 source manifest/rights/provenance 的关系；不能以 novel 标签、文件名或 global fallback 推断。此轮未加载真实 240MB 模型，也未刷新 `docs/notes/index.json`（有并行改动）。

### ✅ durable recovery 不继承未持久化的普通会话作品域（2026-10-04）

`worldModelNovel` 是可信宿主构造 ordinary `GameSession` 时提供的 runtime-only 选择，不进入 ordinary snapshot。来源进程中的 `work-a` 不能仅凭 session ID、旧 prompt 或 loader 内容在重启后自动恢复；新的 recovery constructor 没有再次收到可信 scope 时，必须保持世界模型上下文为空，并且不读取 v18 或 Cthulhu fallback loader。

新增回归先以真实本地 A/B 两作品 loader 创建 scope 为 `work-a` 的 g0，再清空旧 registry，以没有 scope、但同时持有 A/B loader 的新宿主执行 durable HTTP action。断言恢复后的 prompt 不含任一作品文本、loader 读取记录为空、snapshot 不泄漏 `work-a`，同时普通 action 正常提交 g1。把 recovery fallback 恢复为 `work-b` 的真实变异使该反例变红，精确还原后为绿。

这只闭合 ordinary restart 的 fail-closed 规则，不把 runtime-only scope 变成持久授权，也不证明 compiled HTTP 已有可信 artifact → exact work/corpus selector。后者仍需 source-bound artifact、rights/provenance、精确选择器、持久化与恢复的端到端契约；在此之前不得用 novel 标签、文件名或可查询 loader 自动绑定。`docs/notes/index.json` 因并行改动继续延后刷新。

### ✅ Trusted compiled binding publication and two-module offline HTTP lifecycle (2026-10-04)

`CompiledWorldModelBindingResolver(identity { moduleId, artifactHash })` 是可选的
server-owned capability，不是 request input，也不是 client-visible catalog 字段。resolve
publication 与 loose create 只接受其已经存在且 identity-matched 的
`CompiledCthulhuWorldModelBinding`，并经 `catalog.saveBundle` 持久化；bundleId create
复用已保存 bundle，不再 resolve。resolver exception 或 identity mismatch 必须在 write
前 fail-closed；没有 resolver 时仍是 unbound/empty context，绝不回退 legacy。

即便单一 work，`corpusScopeId` 也必须是 manifest scope 且包含
`allowedWorkIds`。合法但更大的 corpus 不会扩大实际候选：查询仍严格限制在 exact
allowed works。两模组离线 HTTP 生命周期覆盖真实 catalog/session/action/recovery chain：A
为 resolve + bundle create，B 为 loose create；两者各自经历 create → compiled action
replacement → empty-registry fresh recovery。compiler 模组来自
`compiledModuleHttpFixture` synthetic pages；scoped world-model candidates 来自真实本地
dataset。本地 fake provider 捕获实际 `GameSession` opening prompt/receipt；work provenance
和 `scopeHash` 全程隔离，HTTP 不返回 binding 或 `datasetRoot`，resolver publication 恰为
两次。

旧 single-work corpus validation bypass、切断 resolve resolver、切断 loose-create
binding save 均使对应回归变红，精确恢复后为绿。定向验证为 94 tests / 7 files / 0 fail /
2502 assertions，typecheck exit 0；干净的 single-owner 完整结果为 4904 tests / 433 files /
4870 pass / 34 skip / 0 fail / 31001 assertions / 569.07s，较前一 baseline 新增 8 tests /
2 files。

当前 shared-tree baseline 补正为 4911 tests / 434 files / 4877 pass / 34 skip / 0 fail / 31011 assertions / 481.55s；其中并行的 source-proposition loader 为 +7 tests / +1 file，不归因于上述 world-binding slice 的 4904/+8/+2 证据。

这只证明有界的 publication/isolation seam，不证明外部真实模型/源文档质量、更广内容行为、
deployment 或一般 production boundary。`todo-64`、`todo-65` 保持 open；
`docs/notes/index.json` 未刷新，故索引滞后于本次追加记录。
