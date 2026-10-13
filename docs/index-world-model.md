# 内容索引 — 世界模型与模组

> 用途：世界模型、模组内容、原始材料和外部语料工程的共同地图。
> 姊妹篇：`docs/index-program.md`（代码架构、待办和工作记录）。
> 刷新日期：2026-08-29。路径和状态以当前磁盘审计为准。
> 历史细节（旧清点、一次性核对记录、`relics/` 遗物母版子工程）已归档到
> `docs/archive-world-model-2026-08.md`，不在当前地图范围但仍可查。

## 当前地图

| 区域 | 当前位置 | 角色 | 状态 |
|---|---|---|---|
| POC 引擎与模组 | `C:\aitrpg\poc\` | Git 管理的 TRPG 引擎、PDF 摄取和运行时 | 活跃 |
| POC 外部材料 | `C:\aitrpg\` 根目录 | PDF、YAML 规则原材料、规则书、计划文档 | 活跃但未全部接入 |
| 小说语料与提取工程 | `D:\aitrpg\世界模型\` | 原文、章节切片、旧产物、v2 语义提取 | 活跃 |
| 旧路径兼容入口 | `C:\aitrpg\世界模型` | 指向 D 盘语料工程的 Junction | 已验证 |

`C:\aitrpg\世界模型` 必须保持为 Junction。POC 中仍有 `../世界模型/v18_output/...` 的默认路径；删除或改成空目录会使运行时语料加载失效。

## 一句话现状

当前存在两条不应混淆的世界模型线：

1. POC 运行时仍加载旧 `v18_output/v18_all_master.jsonl`，作为只读参考语料。
2. `D:\aitrpg\世界模型\worldmodel\` 是新版、来源绑定的候选提取管线。它还没有替换 POC 的 v18 运行时语料。

新版管线的目标是候选库，不是运行时世界状态：任何模型输出都不能自动成为 `confirmed`。

## POC 模组与运行时

### 三层结构

| 层 | 文件 | 职责 | 状态 |
|---|---|---|---|
| 原著世界内容库 | `poc/src/rules/mythos-expansion.ts` | 神话生物、典籍、法术等跨模组内容 | 通用目录由 `createMythosEntity()` 明确消费；模组加载保留模组自身遭遇数值，不让目录覆写 |
| 摄取中间表示 | `poc/src/module/types.ts` 的 `ModuleData` | PDF 读取模块应产出的权威结构 | 已接入 |
| 运行时导入容器 | `poc/src/rules/mythos-module.ts` 的 `MythosModule` | legacy activation、loader、hooks、initialEffects | 已接入；服务 Arkham/InnsMouth，不承载谷仓 |

【步骤 5D 已完成，2026-09-08】谷仓运行字段已迁入 `ModuleData.runtime`，
唯一维护数据为 `BARN_OF_PREMIER`。薄适配、投影函数与过渡场景图/线索绑定
均已删除；`ModuleDataRuntimeLoader` 直接加载谷仓。`MythosModule` 与 loader
仍是 Arkham/InnsMouth 的 legacy 容器，不受此迁移影响：

| 文件 | 类型 | 风险 |
|---|---|---|
| `poc/src/module/barn-of-premier.ts` | 手写 `ModuleData` | 谷仓唯一维护入口，剧本与自由跑团均直接读取 |
| `poc/src/rules/mythos-module.ts` | 其他内置模组类型与 loader | 仅服务 Arkham/InnsMouth legacy 分支 |

谷仓的跨表示内容比对已退役为禁止第二份表示复生的结构哨兵；详见
`docs/module-unification-matrix.md`。

其余已接入的模组相关文件：`poc/src/module/types.ts`（模组类型契约，23 个
interface：`ModuleData`/`Scene`/`Clue`/`ModuleItem`/`TrapMechanics`/`Provenance` 等）、
`poc/src/module/threat-analyzer.ts`（从模组反推难度：敌对 NPC 数、最大伤害、陷阱数、
困难/极限检定数、最大 SAN 损失、有无 Boss）、`poc/src/rules/custom-modules/index.ts`
（社区模组注册表与查询入口）。

### POC 运行时世界模型

| 路径 | 职责 |
|---|---|
| `poc/src/world/world-model-loader.ts` | 加载旧 v18 参考语料，默认经 C→D Junction 定位 |
| `poc/src/world/world-model-integrator.ts` | 按场景、行为和因果向运行时提供参考约束 |
| `poc/src/world/world-constraint.ts` | 文本/物品约束；当前主要覆盖时代错置和 meta 词汇 |
| `poc/src/world/module-loader.ts` | 将 `ModuleData` 灌入 SQLite |
| `poc/src/state/world-state-manager.ts` | SQLite 世界状态；与 `src/world/state.ts` 存在待收敛的双实现 |
| `poc/src/investigation/investigation-engine.ts` | 多入口线索判定 |

### 运行时边界

目标顺序是：玩家经律书提出解释/适用请求，KP 裁定并记录先例；规则执行器读取已提交 SQLite 状态并结算确定性规则；世界模型只以可验证模板写入物理/社会派生事件；LLM 只叙事，不能直接写规则结果或状态。

`PLAN.md` 中部分旧段落仍将“律书”称为确定性执行器。以本索引和 `docs/todo.json` 的 `todo-17` 为准：律书是玩家侧的规则辩论与先例制度，确定性代码名称是“规则执行器”。

## POC 外部原材料

| 路径/组 | 内容 | 接入状态 |
|---|---|---|
| `MikuFan-普瑞米尔的谷仓/` | PDF 原件及 6 张附件图 | PDF 摄取候选；图片未接入 |
| `forensic_rules.yaml` | 尸检、伤害和世界物理规则 | 未接入 |
| `mythos_rules.yaml`、`mythos_taxonomy.yaml` | 原著神话规则与实体分类 | 未接入 |
| `investigation_system.yaml` | 完整版复合线索系统 | POC 有裁剪版 |
| `narrative_style.yaml` | 原著叙事特征 | 未接入 |
| `dnd_rules.yaml`、`cr_replacement.yaml` | D&D SRD/替换辅助材料 | 未接入 |
| `miskatonic_*.yaml` | 密大教授与参考设定 | 未接入 |
| `module_integration.yaml` | 模组接入设计 | 未接入 |
| `pigeon_takeover.yaml` | 玩家缺席处理 | 未接入 |
| `COC七版规则空白卡CY20.06.1.xlsx`、PDF/TXT 规则资料 | 人工参考材料 | 未接入 |

这些文件与 `poc/src/rules/` 中的材料可能同源但版本不同。接入前必须比较来源、语义与许可证，不能按文件名直接覆盖。

`poc/tools/modules/raw/`（PDF 按章节切分的 19 个 txt，与源 PDF 逐字一致，已核对
17/17，见 `docs/archive-world-model-2026-08.md`「原文与 raw/ 的血缘已确认（2026-08-19）」）与
`poc/tools/modules/structured/`（从旧 `.ts` **反向拆出**的 15 个字段 txt，是派生物
不是来源）都在 `.gitignore` 排除的 `poc/tools/` 下。它们属于不可复现的历史工具链：
其原始输入 `premiers_barn_raw.txt` 已不存在，摄取必须从 PDF 重跑。历史脚本及其
输入缺失事实见 `docs/archive-world-model-2026-08.md`「摄取相关脚本（poc/tools/ 遗留脚本，2026-08-19 状态）」。
当前受支持的摄取入口是 `scripts/ingest/run.ts`；它产出可对比候选，不自动写最终 ModuleData。

## D 盘小说语料与新版提取

### 目录分层

| 路径 | 角色 | 当前处理 |
|---|---|---|
| `D:\aitrpg\世界模型\*.txt`、`*.epub` | 原始小说语料 | 保留，不与章节切片去重 |
| `D:\aitrpg\世界模型\chapters_*` | 原文的章节/合成切片 | 派生输入；保留与来源文本的血缘 |
| `D:\aitrpg\世界模型\v18_output` | POC 当前运行时参考语料 | 保留，未被 v2 替换 |
| `D:\aitrpg\世界模型\datasets\cthulhu` | 克苏鲁原文、章节、提取结果与专用管线 | POC 开发侧可直接消费的独立数据集 |
| `D:\aitrpg\世界模型\relics`、`verification_*`、`output`、`results` | 旧提取、遗物和验证实验 | 历史/参考；不可作为 v2 新结论依据 |
| `D:\aitrpg\世界模型\worldmodel` | 当前来源绑定 v2 提取工程 | 活跃 |

审计时的规模约为：D 盘语料工程 `100,030` 文件、`2.74 GiB`；其中当前 `worldmodel/` 核心约 `625 MiB`。数字会随提取产物变化，不能当固定容量承诺。迁移前（C 盘、98,269 文件/1.5GB）按材料类型分类的旧清点见
`docs/archive-world-model-2026-08.md`「世界模型语料工程旧清点（`世界模型/`，2026-08-19 状态：98,269 文件 / 1.5GB）」。

### V2 管线

核心文档和入口：

| 文件 | 用途 |
|---|---|
| `worldmodel/tools/WORKFLOW.md` | v2 规范工作流 |
| `worldmodel/DELEGATION_PROTOCOL.md` | worker 与 lead review 边界 |
| `worldmodel/handoff_absolute_priest_v2_batched.md` | 《绝对牧师》从头执行的当前提示 |
| `worldmodel/handoff_v2_semantic_migration.md` | 其他旧书的 v2 迁移说明 |
| `worldmodel/handoff_yuchong_huanshi_synthetic.md` | 《驭宠幻世》假章节标题问题的前置重建 |
| `worldmodel/worker_config.json` | 不含密钥的 chat/embedding 端点配置 |
| `worldmodel/DESIGN_TRANSLATION_POLICY.md` | 提取后设计转换政策，不改变抽取事实 |

每本书先通过 `29_validate_semantic_inputs.mjs`，再分别执行：

```text
rule discovery -> cluster -> review -> rule registry
special discovery -> cluster -> review -> special registry -> privilege ledger
```

`19_agent_review_open_systems.mjs --batch-size 6` 是串行批量审核优化：每次请求最多审核 6 个同 mode 候选，逐条验证，单条失败不影响批内其他候选。

### 当前书籍状态

| 书籍 | 状态 |
|---|---|
| `绝对牧师` | 有已验证的输入与 targeted queue；尚未完成 v2 rule/special 管线，是当前第一优先级 |
| `网游之奥术至高` | 已有 v2 rule/special/registry/privilege 目录；先核验产物和失败记录，避免盲目重跑 |
| `网游之魔剑圣域` | 旧 unified/v1 已完成；必须按 v2 重跑才可参与跨书比较 |
| `奥法权杖`、`传奇博物馆`、`网游之数据为王`、`网游之焚尽八荒` | 待核验最新输入后迁移到 v2 |
| `驭宠幻世` | 先以强制合成分段重建，再进入 v2 |

旧 `cross_book_round1` 已删除：它存在已知错误合并。后续跨书比较只可在至少两份 v2 registry 完成后进行，并比较触发、前提、成本、效果、限制、可观察性和反制，不可只按标签 embedding 融合。

### 文化转换边界

中文作品的来源概念必须如实保留，但不能自动进入西幻运行时。后续设计重用只能在审核后分配：

```text
monk_existing_feature
monk_subclass_or_feat
magic_item_only
source_only
no_transfer
```

相近武术内容优先映射到既有武僧 `Focus`、职业特性、子职或专长；不新建仙侠/修真能力系统。境界、渡劫、飞升、御剑、灵根、因果等默认 `source_only` 或 `no_transfer`。震旦作为极东、低扩散文化区，只通过稀少行商、使团、旅人、遗物或飞地进入场景。

## 重复审计（2026-08-29）

清理前对 C 盘工作区和 D 盘语料工程进行 SHA-256 审计，跳过依赖目录、缓存目录和 C→D Junction，扫描 `121,433` 个文件：发现 `4,263` 组字节级重复，去除每组保留的一份后约 `63.4 MiB`。本节列出的无歧义派生副本已按下表清理；剩余重复需在下一次全量哈希复检后重新计数。

| 重复类别 | 典型位置 | 处理原则 |
|---|---|---|
| 阈值扫描重跑产物 | `semantic_threshold_scan/t78` 与正式 `semantic_clusters_round*` | 已删除全部扫描目录；正式 semantic 输出保留 |
| 旧阶段重复产物 | `v14_output/world_model_v14_clean.jsonl` 与 `v18_output/v17_structured_data/world_model_clean.jsonl` | 已删除 v14 副本；保留 v18 运行时谱系 |
| 同输入重复生成 | `evidence_atoms_round*`、D&D audit 重跑目录 | 已删除经哈希确认且被最新轮次覆盖的旧副本；保留当前执行提示指定的输入轮次 |
| 验证工作副本 | `verification_*` 下章节与根 `chapters_*` | 是可重跑验证快照，不能与原文混为同一保留级别 |
| POC 证据/日志副本 | `docs/evidence/` 与 `play-logs/` | 先检查文档链接与测试引用，再决定保留哪一侧 |

禁止仅按文件名、目录名或“看起来相似”删除。删除重复前必须完成：完整哈希一致、保留侧存在、运行时/脚本引用检查、以及来源与派生产物角色确认。（本次审计前按脚本/文件类型归因的旧重复清单见
`docs/archive-world-model-2026-08.md`「重复与占位（清理线索，2026-08-19 状态）」，粒度更细但范围已被本次全量扫描覆盖。）

## 已清理与重复处理

本轮已删除：

- D 盘 `worldmodel/runs/末法王座` 的非当前实验产物。
- 已知错误合并的 `worldmodel/runs/cross_book_round1`。
- `worldmodel/tools/__pycache__`。
- 被 v2 替代的旧 mechanical/semantic/review handoff。
- 根目录 DeepGen 专属脚本、部署文件、快速指南和测试。
- 全部 `semantic_threshold_scan`、`mechanism_cluster_threshold_scan`，以及旧 `v14_output` 完全副本。
- 被最新 evidence-atom/D&D audit 轮次覆盖的旧审核输入；POC `tools/ingest-out` 中已复制到 `docs/evidence` 的三份中间快照。

保留原则：原文与章节切片不是简单重复，二者构成来源与派生输入；`v18_output` 与 v2 registry 也不是简单重复，前者仍被 POC 运行时消费，后者尚未接入运行时。

## 待办

1. 从 PDF 重跑《普瑞米尔的谷仓》摄取，并确定 `ModuleData` 与 `MythosModule` 的唯一权威源。
2. 接入或明确弃用根目录 YAML 原材料，优先物理/尸检、神话规则和叙事特征。
3. 为规则执行器与世界模型补齐物理/社会派生事件模板；保持 LLM 无直接写状态权限。
4. 完成《绝对牧师》v2 双管线，再按书迁移其他语料。
5. 获取具体原始描述后，才定义数据化躯体的伤害事件、弱点覆盖和致死伤延缓规则。
6. 至少两本书完成 v2 registry 后，用固定前提的跨书对撞评测检验世界模型可用性，不做主角战力排行。
7. 需要时，在完成来源审核后做叙事规范分析；作品文本不用于推断作者或读者本人信念。
8. 每次迁移或清理后更新本索引、`docs/todo.json` 和 `worldmodel/HANDOFF_DEVICE_TRANSFER.md`，避免 C/D 路径、历史产物和当前主线再次断层。
9. `mythos-expansion.ts`（原著世界内容库）接进剧本引擎——现在剧本引擎零引用，只有 LLM prompt 层在用。
10. 6 张模组附件图（`MikuFan-普瑞米尔的谷仓/附件/`）未接入任何摄取或展示路径。

更早的旧清点、一次性核对记录与 `relics/` 遗物母版子工程见
`docs/archive-world-model-2026-08.md`。
