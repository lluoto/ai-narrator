# 运行引擎 / 主循环

### CoC abdominal impale: percentile penalty closure evidence (2026-09-19)

Method: test the real NPC-to-player impale creation path first, then consume the persisted actor state through `GameSession.act`; do not treat a formatted status string or a narration line as proof of a working rule. The red-line suite has six cases and the related status/action/attack/investigation/first-aid/chest/head regression set has 141 passing cases. `CoCEngine` declares `abdominal_impaled` plus `1d3`; `RulesEngine` rolls that duration only if the damaged defender survives, and `GameSession` writes the resulting structured state to the defender's sole `WorldEntity.status[]` store.

The one shared effective-target consumer applies only to a Cosmic Horror player's reachable, intentional percentile action checks: ordinary skill checks; actual scene-clue rolls including the ordinary and idea-override branches; legacy player attacks; first aid; chase; and the reachable regex-attack fallback. A force-success clue grant remains a no-roll grant: it is not converted into a penalized d100. The rule deliberately does not apply to NPC counterattacks, SAN or first-sighting checks, damage follow-up CON checks, growth checks, or any other non-player-action roll. `/push` remains explicitly uncovered because no production path writes `_lastPushedRoll`; an unreachable API is not claimed as behavior.

`act()` snapshots the routed active actor's statuses before its normal status tick. Thus a duration-one abdominal wound expires from storage during that turn but its snapshot still reduces the final eligible percentile roll on that turn; the following turn returns to the base target. If the resolved route is a deterministic no-roll grant, the turn still advances/consumes duration without fabricating a percentile check. Duplicate abdominal entries do not stack: the status query selects the strongest single declared penalty (-20), while expired, malformed, and unknown labels have no modifier and another actor's state is never read.

Two restored production mutations established that the tests observe real wiring. Removing the CoC abdomen status/duration declaration made the focused suite exit 1 with 5 pass / 1 fail: the real creation E2E could no longer persist the wound. Bypassing the shared `GameSession` modifier made it exit 1 with 1 pass / 5 fail across the real skill, clue, legacy attack/first aid, chase/regex fallback, and no-stack consumers. Restoring each exact patch returned the suite to 6 pass / 0 fail.

This closes only the explicit abdomen-impale percentile consequence. Other hit-location text such as blindness, knockback, disarm, slowing, and any other unstructured body outcome still lacks a declared structured rule plus consumer; it is not inferred from narration. A general player-body constraint domain and broader physical-action semantics also remain open.

> 从 `docs/index-program.md` 拆出的 log，**只追加**。索引 `docs/notes/index.json`（重建：`bun scripts/docs-index.ts`）。

### ✅ 拆 play-module：先抽播报层与 NPC 对话（2026-08-21）

**起因是量出来的读取成本**，不是「看着太长」。`play-module.ts` 3537 行里
`runModuleInner` 一个函数占 2615 行 / **74%**，里面按注释能切出近 30 个块，
但**没有一个是能整段读进来的单元** —— 每次改动只能靠行号开窗口猜，
窄了缺上下文、宽了浪费。本轮改伤势时读了 `applyDamage`/`check` 3 次、陷阱段 4 次，
不是因为内容多，是因为没有「陷阱处理」这个可寻址的东西。

这也是当初 `chooseConnection` 必须抽出闭包才能测的同一个病。

**怎么定要抽哪一块**：写 `tools/_scan-free-idents.ts` 扫「用到但没在段内定义」的名字。
第一版结果全是噪音（`the`/`driven`/`a` —— 注释里的英文单词被当成标识符），
剥掉注释、字符串、模板串、正则字面量并排除属性访问之后才干净。
**但正则扫描仍不可信**（`say` 时有时无），最后是拿 tsc 报错当权威清单：
切出去 → `bun run typecheck` → 它精确列出 5 个解析不了的名字。

**分了三层，依赖单向**：

| 文件 | 行数 | 装什么 |
|---|---|---|
| `src/play/narration.ts` | 74 | `RunContext` / `runCtx` / `say` / `sayMech` / `divider` |
| `src/play/npc-text.ts` | 148 | `analyseNpcData` / `splitLeadingStageDirection` / `stripOuterQuotes` / `noteEntityMentions` |
| `src/play/npc-dialogue.ts` | 770 | 16 个对话生成函数 |

播报层必须先抽：拆出去的子模块要够到 `say()`，留在 play-module 里它们就得
反过来 import，成环。

**唯一的真闭包依赖是 `nextRevealBridge`**（捕获 `lastRevealBridge`，
用来避免连续两次用同一句引导语）。改成参数注入而不是把状态挪进 `RunContext` ——
函数自己声明需要什么，比隐式捕获清楚。6 处调用点用脚本批量补，手改容易漏。

**结果**：`runModuleInner` 2615 → 1873 行（74% → 71%），
play-module 3537 → 2630 行。

**纯搬运的判据**：1325 条测试 + typecheck + 主循环脚手架 10/10 通关。
⚠ 只看通关率会误判 —— 头一轮 fuzz 出 10/10 True End，而之前量到过 6~8 True，
差点当成回归；连跑三轮看到 7 True/3 Normal 才确认是固有方差
（检定走 `Math.random`，不可播种）。**方差没量清之前不要下回归结论。**

**顺带发现第二条无种子的假红**：`npc-reaction.test.ts` 的
「高稳定性减少负面情绪」，全量里偶发红，单独跑 5/5 全过，全量重跑两次也全绿。
仓里已知的那条在 `coc-engine.test.ts:131`，这是第二条。

### ✅ 拆 play-module 续：检定层与陷阱（2026-08-21）

接着上一条往下拆。这两块的性质跟 NPC 对话不同，值得分开记。

| 文件 | 行数 | 装什么 |
|---|---|---|
| `src/play/checks.ts` | 130 | `check` / `sanCheck` / `applyDamage` / 伤势状态 / flavor |
| `src/play/trap-util.ts` | 97 | `rollDice` / `trapsInScene` / `attributeValue` / `isMajorWound` |
| `src/play/traps.ts` | 220 | 一次进场的陷阱结算 |

**checks 那块零依赖**（自由标识符扫描的 B 列全是函数参数误报，
`cur`/`engine`/`next`/`diff` 这种），直接搬走即可。

**陷阱块相反，是真耦合**：要 `triggeredTraps`（哪些响过）、
`stepCounter`（决定轮到谁踩）、两个调查员、`world`、`scene`、两个 SAN 引擎。
它原本还不是函数而是个 `for` 循环，得包一层。

**包的写法要紧**：参数用解构接住、**名字与原闭包里的完全一致**，
于是循环体一个字都不用改 —— 搬运的正确性只取决于「参数是不是同一批东西」，
不取决于逐行改写有没有手滑。177 行手工改引用必然出错。

显式列出依赖本身也是收益：现在能拿假场景 + 假陷阱直接喂 `runSceneTraps`。

**为什么要多一个 trap-util**：`traps.ts` 要用 `rollDice`/`trapsInScene`，
它们还在 play-module 里，直接 import 就成环 —— 单独抽出来打断。

**判据**：typecheck + 1325 测试 + `tools/_diag-wounds.ts` 40 局对照
（伤害 74 次、分档同量级、「体质检定不被自身伤势罚」的不变量仍成立）。

**累计**：play-module 3537 → 2267 行。但 `runModuleInner` 仍占 75%（1703 行）——
**比例没降**，因为抽走的多是它外面的模块级函数与它里面耦合最松的块。
剩下的是真主循环（场景推进、对话编排、战斗、结局），
再往下拆得先想清楚状态怎么切，不是搬运能解决的。

### ✅ 状态按「谁在写」分组（2026-08-21）

上一条卡在「状态怎么切」。先量：`runModuleInner` 的闭包里平铺着**六类**
互不相干的状态，`WorldState` 只是其中一类 ——
所以这不是「给世界状态记录分类」的问题。

| 类别 | 变量 | 生命周期 | 谁在写 |
|---|---|---|---|
| 模组配置 | `module` `support` `threat` | 建局后只读 | — |
| 角色 | `p0/p1` `c1/c2` `san1/san2` | 整局 | 伤害、SAN、物品 |
| 世界 | `world` | 整局 | 线索、场景、NPC |
| 世界模型 | `wmIntegrator` `wmCache*` | 整局 | 只有缓存 |
| 叙事去重 | `lastAskBridge` `lastRevealBridge` `lastPartnerRemark` | 整局 | 每次播报 |
| 循环游标 | `done` `rounds` `stepCounter` `arrivedByPlayerChoice` `triggeredTraps` | 整局 | 主循环 |

**这些缝是实的**：前两次抽取各自只需要一个切片 ——
npc-dialogue 只要「叙事去重」，traps 只要「角色 + 世界 + 循环游标」。
而 `wounds` 在做惩罚骰时已经先挪进 `RunContext` 了，那是这个分解的第一刀。

**本轮收了 `Cast` / `Cursor` / `Dedup` 三类**（`src/play/run-state.ts`）。
世界模型缓存留着，等它的使用方抽出去时再一并处理。

**分组不是为了参数变少，是为了每个参数都是一个完整概念。**
收成一个大 bag 会把依赖重新藏起来，那正是抽出闭包要消除的东西 ——
拿到 `cast` 就知道这函数动角色，拿到 `cursor` 就知道它参与循环推进。

**两处立刻兑现的收益**：

1. `runSceneTraps` 参数 **11 → 4**（`cast, world, cursor, module, scene`）
2. **`revealNpcKnowledge` 那个回调注入没有了。** 早先它被迫接一个
   `nextBridge` 函数参数，因为引导桥要读写 `lastRevealBridge`，
   而那变量埋在闭包里够不到 —— **那处别扭正是状态没分类的症状**。
   `Dedup` 收成对象后，`buildRevealBridge` + `nextRevealBridge`
   一起搬进 `src/play/reveal-bridge.ts`，直接调即可。

**两个值得记的细节**：

- `stepCounter` 是**线索检定与陷阱共享**的（线索那边 `++`，陷阱那边只读它决定谁踩），
  这层共享散在闭包里时完全看不出来。
- `Cast` 把「名字 / 角色卡 / SAN 引擎」绑成一体，防的是错位 ——
  拿 `p0` 的名字配 `c2` 的角色卡，日志上看不出来（名字是对的），掉的却是另一个人的血。

**判据**：typecheck + 1325 测试 + fuzz 10/10 + `module-loop` 11 条
（其中几条专门守着 `arrivedByPlayerChoice` 的静默传送）+ 伤势诊断 40 局同量级。

⚠ 用脚本批量改名时切割边界差了一行，把 `extractSceneEssence` 的函数头带走、
只留下函数体，tsc 直接报语法错。**机械改动之后要看 tsc 报的是不是语法错** ——
语法错通常意味着切歪了，不是缺 import。

### ✅ 抽 Boss 战，以及为什么在线索块前面停下（2026-08-21）

**战斗抽出去了**（`src/play/combat.ts`，172 行）。依赖很干净：
`cast` + `world` + `scene` + `support` + `module`，不碰游标。

搬的时候发现 `migoFought` 这个变量**写了从没被读**，顺手去掉。

**验证战斗还在打**要单独量，光看测试和通关率不够 ——
`tools/_diag-combat.ts` 10 局：遭遇 6 局、击退 1 局、攻击掷骰 59 次、
疲劳惩罚骰 8 次。这几个数一起对上才说明战斗轮真的在跑。

顺带把 `_extract-block.ts` 每次搬运在原处留下的占位注释残渣清了 ——
连着几次搬运之后剩下一堆孤立的同款注释，指向的还不是同一个文件。

**在线索块前面停下的理由（有数据）**：

线索检定是我改得最多的一块（skill 优先、failback 兜底都在这儿），
按理该优先抽。但扫下来它跟前几块性质不同：

1. **四个函数不连续** —— `sanitizeRevelation` / `checkClueSanLoss` /
   `narrateClueDiscovery` / `runClueCheck` 中间隔着 `getUnlockedConnections`
2. **要注入三样东西** —— `buildWorldContext`、`sayPartnerRemark`、
   每场景的 `attemptedClueIds`
3. **`buildWorldContext` 被对话与线索两边共用**（5 处），
   而它自己又依赖 `buildWmContext` → 世界模型缓存那类状态

也就是说抽线索块会拖出一条链：线索 → `buildWorldContext` → `buildWmContext`
→ wm 状态分组。每步都不大，加起来就不小了，而且中途出错的面比前几次宽。

**下一步的形状**：先把 wm 那类状态收进 `run-state.ts`，
把 `buildWmContext` + `buildWorldContext` 抽成 `src/play/llm-context.ts`，
线索块才好干净地跟着走。或者退一步 —— 把 `buildWorldContext` 当**服务注入**
（线索模块只要「给我当前世界上下文」，不必知道怎么拼），
那是正当的依赖注入，跟当初 `nextBridge` 那种「状态够不到的变通」不是一回事。

**累计**：play-module 3537 → 2031 行，`runModuleInner` 2615 → 1511 行。
**比例仍是 74%** —— 三轮下来一直没降，因为每次抽走的都是它内部相对独立的块，
而剩下的是真正互相缠着的主循环。比例不降本身就是信号：
再往下不是搬运问题，是状态边界问题。

### ✅ 打通 LLM 上下文那条链，线索检定抽出（2026-08-21）

上一条判断「抽线索块会拖出一条链」，按 A 方案先解链。

**第一步：wm 状态收进 `WorldModelCtx`**（`integrator` + 神话 loader + 一格缓存），
`buildCthulhuContext` / `buildWmContext` / `buildWorldContext` 抽成
`src/play/llm-context.ts`（174 行）。

`buildWorldContext` 是关键 —— 它被对话与线索两边共用 5 处，
留在闭包里线索块就抽不干净。

**这块必须单独验**：这两个函数只在 LLM 可用时才注入 prompt，
**离线跑整局根本不会碰它们，全量测试绿不代表没坏**。
写了 `tools/_diag-wmctx.ts` 直接调：2020 字符、第二次命中缓存、
换场景后缓存失效重算 —— 缓存那一格从闭包变量改成对象字段，最容易在这里写错。

**第二步：线索检定抽成 `src/play/clue-check.ts`**（294 行），
连带 `sanitizeRevelation` / `sayPartnerRemark` / `isPassiveClue` / `investigableClues`。

依赖多是实情不是设计失误 —— 它同时碰世界、场景、两名调查员、两个 agent、LLM、
以及本次进场的「试过哪些」。收成 `ClueCtx` 一个参数，
调用点读起来是「按这套处境查线索」而不是十个散参数。
⚠ `scene` 与 `attemptedClueIds` 是**每次进场**的，ctx 也就得每次进场重建。

**踩到一个环**：`clue-check` 要 `partnerRemark` / `speechLead`，
而它们在 play-module 里 —— 但 play-module 已经 import 了 clue-check。
把这两个（连同 `askerScore`、`OUTGOING`/`RESERVED`）搬进 `npc-text.ts` 打断，
再从 play-module 转出给测试。**抽出来的模块反向 import 原文件就是环的信号**，
tsc 不会报，得自己看依赖方向。

**这轮的机械改动出错三次**，都是切割边界差一点：
把 `extractSceneEssence` 的函数头带走、把 `pl2` 与 LLM 客户端初始化多带走、
把陷阱/战斗调用点误切进 clue-check。**判据是 tsc 报的是不是语法错或
「Cannot find name」批量出现** —— 那通常意味着切歪了，不是缺 import。

**累计**：play-module 3537 → **1580** 行，`runModuleInner` 2615 → **1156** 行。
比例 73%，仍然没降 —— 但绝对值降了 56%，且剩下的确实是主循环骨架
（场景推进、对话编排、移动排序、结局）。

### ✅ 抽场景流水线：占比终于降了（2026-08-21）

**先记一次失败**。按「注释分块」挑边界抽「对话编排 L689~L1153」，
结果把 `processScene` **拦腰截断** —— 它的开头在那段里，函数体却一直
延伸到移动选择。抽完 dialogue-orch 里是半个函数，play-module 里剩下的半个
成了 `return` 之后的死代码。回退重来。

**教训：注释分块 ≠ 函数边界。** 为此写了 `tools/_fn-span.ts`，
抽之前先量目标函数的真实跨度。量出来 `processScene` 是 **L903~L1395、493 行**，
它本身就是「一次进场的完整流水线」：进场叙述 → NPC 遭遇 → 对话 → 线索 → 选下一步。

**顺带发现一处该归位的状态**：`globalVisitCount` 被 `processScene` 读 5 次
（判断首次进场、给移动选项排序）、被主循环写。这正是「循环游标」那一类，
并进 `Cursor`。收进来才看得出「谁在推进它」和「谁只是参考它」是两拨代码。

**这次抽 707 行**（`maybeRecognitionBeat` / `pickAsker` / `conductNpcConversation`
/ `fallbackQuestion` / `processScene`）→ `src/play/scene-pipeline.ts`。

改法上换了策略：**不逐个手改签名，写脚本统一插 ctx 解构**。
五个函数各自该解构哪些名字如果手挑，改到第三个必然手滑；
统一解构同一批名字反而安全 —— 多解构几个没用到的 tsc 会放过，少一个立刻报错。
**宁可多不可少。**

**又踩一次环**：scene-pipeline 要 `chooseConnection` / `isRedundantMoveLine`
/ `noticesEntity`，它们在 play-module。抽进 `move-util.ts` 打断。
这已经是第二次 —— 规律很清楚：**被抽出的模块要用什么，那东西多半也该跟着出来**。

**结果**：

| | play-module | runModuleInner | 占比 |
|---|---|---|---|
| 起点 | 3537 | 2615 | 74% |
| 上一轮 | 1580 | 1156 | 73% |
| 现在 | **757** | **436** | **58%** |

**占比第一次真正下降。** 之前三轮抽的都是「主循环外面的东西」，
这次抽的是主循环**自己那一层**，所以比例才动。
`runModuleInner` 剩下的 436 行是：车卡、世界初始化、主 while、结局结算 —— 名副其实的骨架。

| 文件 | 行数 |
|---|---|
| `play-module.ts` | 1580 |
| `play/npc-dialogue.ts` | 773 |
| `play/clue-check.ts` | 294 |
| `play/npc-text.ts` | 255 |
| `play/traps.ts` | 212 |
| `play/combat.ts` | 203 |
| `play/llm-context.ts` | 174 |
| `play/checks.ts` | 130 |
| `play/run-state.ts` | 111 |
| `play/trap-util.ts` | 97 |
| `play/narration.ts` | 74 |
| `play/reveal-bridge.ts` | 76 |

### 自由行动解析：agent 支持，引擎扔掉，而 intent 判别撑不住（2026-08-20）

问题是「要改成自由行动解析，现在的 subagent 支不支持」。逐层查下来：

**1. `PlayerAgent` 已经支持自由行动。**
- `buildPrompt`（`player-agent.ts:239`）最后一句是
  「现在，作为 X，你要怎么做？简短描述你的行动。」—— 要的就是自由文本，不是选号码。
- `parseAction`（`:448`）`action: content` —— **原样保留玩家说的话**。
- `availableClues` 已经作为【你可以调查的线索】传进去了（`:234`）。

**2. 扔掉它的是引擎。** `play-module.ts:2931-2949` 拿到自由行动之后
按场景名前 8 个字匹配连接，不中就按分数替玩家挑一个地方。

**3. 真正的拦路虎是 intent 判别。** `tools/_diag-intent.ts`，12 条用例 **7 对 5 错**：

```
✗ 我们回镇上              人=move        机=other     「回」不在移动词表
✗ 我掏枪对着米戈开火       人=combat      机=other     「开火」不在战斗词表
✗ 我去看看那张卡片写了什么  人=investigate 机=move      「去」的陷阱
✗ 我想找出艾德里安在隐瞒什么 人=investigate 机=search    「找」的陷阱
✗ 我打开手电筒照向管道深处  人=investigate 机=combat    ← 「打开」里的「打」命中战斗
```

最后一条是致命的：**「打开」被判成 combat**。
现在这不要紧 —— 反正每轮都强制移动，intent 几乎不影响结果。
一旦改成自由行动解析，intent 就在关键路径上：玩家开个门，引擎让他掏枪。

⚠️ 这 12 条用例是照着玩家会怎么说写的，不是从真实对局采的。
所以这个数说明的是**「这种写法会不会崩」**，不是线上准确率。

**修法不是把词表加长，是让 agent 自己说意图。**
LLM 生成这个行动的时候就知道自己要干什么，现在却把它扔了、再回头用关键词猜。
改成让它输出 `{action, intent, target}`，猜测这一步整个消失。
落点在 `player-agent.ts`，不碰 3128 行的 `play-module.ts`，
关键词判别留作 fallback。

### agent 自报 intent 上线（2026-08-20，`feat/free-action-intent`）

`player-agent.ts`。prompt 改成要一行 JSON `{action, intent, target}`，
`parseAction` 先按 JSON 读，读不出来退回原来的关键词匹配。

- **「打开」不再被判成 combat** —— 有测试守着这条真 bug。
- intent 认不出来时归 `other`，**不回退去猜**。猜一个错的比说「说不清」更糟
  （变异检验：把它改成回退关键词，那条测试立刻红）。
- 关键词那条路原样留着：`fallbackDecision` 那一支、
  以及没走新 prompt 的调用方，回来的仍然是纯文本。实测仍是 7/12，没动。
- 新增 `PlayerDecision.targetName`。agent 只知道自己想动谁，不知道它的 id；
  名字换 id 要有世界状态，那在引擎那一侧。硬塞名字进 id 字段会让下游
  按 id 去查、查不到、静默当成没指定。

### ✅ 4 条 core 线索的技能检定永远不会执行（2026-08-21，已修）

**症状**：`runClueCheck` 遍历 `findMethods`，碰到第一个 observation/automatic/item
就揭示并 `return`。于是同一条线索上排在后面的 `skill` 方法**到不了**。

`tools/_diag-deadskill.ts` 普查（32 条线索）：

| 只被动 17 | 只技能 9 | 两者都有、技能被吃掉 **4** |
|---|---|---|

四条全是 **core**：

| 场景 | 线索 | 原本死掉的检定 |
|---|---|---|
| 交火现场 | 黑色钱包 | 侦查/regular |
| 建筑内（谷仓大厅） | 门口的受害者尸体 | 医学/regular — 判断死因 |
| 建筑内（谷仓大厅） | 其他受害者床位 | 力量/regular — 掰开仪器 |
| 艾德里安的卧室 | 日记本与老旧文件 | 母语/hard — 对照文件 |

**连带后果：结局不区分。** True End 要「日记 + 文件 + 到过维修间」，
而 `clue_bedroom_diary` 是 observation（进卧室即得）且 `unlocks` 老旧文件，
去维修间又必须穿过卧室 —— 所以**凡是走到终局的必得 True End**。
实测随机玩法 10 局全是 True End，其中一局只走了 11 个场景、一次调查都没做。

**修法（用户选的方向）**：skill 优先，passive 退化成兜底。

1. 把 findMethods 分成 skill 组和 passive 组
2. 有 skill 就只跑 skill，不碰 passive
3. skill 失败累计 >= maxFails 时，**如果有 passive 方法**用它揭示
   （比 failback/revelation 更自然：作者写的就是"另一种发现方式"）
4. 没有 skill 的线索，passive 照旧立即生效

**效果（随机玩法 10 局 × 2 轮）**：

| | True End | Normal End |
|---|---|---|
| 修前 | 10/10 | 0/10 |
| 修后轮 1 | 8/10 | 2/10 |
| 修后轮 2 | 6/10 | 4/10 |

结局开始区分。Normal End 只有在日记母语检定失败时才会出现——而它出现了。

### ✅ 25% 的局会报废：查不到的 core 线索把队伍钉死（2026-08-20，已修）

**症状**：约四分之一的局跑满 `rounds < 40` 上限、只覆盖 10~13 个场景、
从没去过 `艾德里安的农场`（整个下半模组的入口），通不了关。

**根因**：一条永远检定不过的 core 线索，会让它所在的场景一直满足
`tgtHasCore`，于是在移动评分里稳拿 0 或 25 分（`play-module.ts:2988-3001`），
永远压过未访问场景的 30 分。队伍被无限拽回去重查。
`tools/_diag-derail.ts` 抓到的现场：`调查贵族身份` 被摆上选项 **8 次**，
`前往维森酒吧 (已充分探索)` 被选 **5 次**。

**为什么兜底没兜住**：代码里本来就有 `failback`
（连续失败 N 次 → 强制发现，注释写着 Gumshoe 原则），
但它只对**显式配了 `failback` 字段**的线索生效。普查模组：

| 总线索 32 | core **26** | 配了 failback 的 **0** |
|---|---|---|

**这套兜底一次都没生效过 —— 实际是死代码。**

**修法**：`fb || clue.importance === "core"` —— core 线索没写也享受兜底，
补救文本默认用线索自己的 `revelation`（那本来就是作者写的正文）。
显式配了 `failback` 的走原路径，行为不变。

**效果（实测 8 轮 → 8 轮）**：

| | 通关 | 不同场景数 | 进场总数 |
|---|---|---|---|
| 修前 | 6/8 | 10, 13, 16, 16, 16, 16, 16, 16 | 21~40 |
| 修后 | **8/8** | 16 ×8 | 21 ×8 |

修完变成确定性的，所以测试敢写死「必定通关」和「进场 < 30」。
变异检验：改回 `if (fb)` → 3 次里 2 次红
（剩下那次正是修复前 75% 会侥幸通过的情形）。

### ✅ 循环反转：玩家自己决定查什么（2026-08-20，已做）

`play-module.ts` 进场自动解线索那段现在只处理「不动手也会注意到」的，
技能类留给玩家。判据 `isPassiveClue` 跟 `runClueCheck` 的实际行为对齐：
它遍历 findMethods，碰到 observation/automatic/item 就直接揭示，只有 skill 才掷骰。

形态是**两段式**：先「查什么」循环（`MAX_SCENE_ACTIONS = 6`），再走原有的
「去哪」决策。没有可查线索时整段跳过，不产生额外 LLM 调用。
没做成单次统一提问是有意的取舍 —— 那要把 110 行移动决策整体缩进，
而这个函数昨天才第一次有测试，不值得。

**线索匹配放在 intent 判断前面**：`PlayerDecision.intent` 是可选的，
不设 intent 的决策器会让「永远不调查」成为默认行为 —— 那正是这次要修的毛病。
点了名就照做。

**`attemptedClueIds` 复活**：原先是只写不读的死变量，现在真的用上了 ——
检定失败的线索必须退出本次进场的选项，否则玩家会在同一个抽屉上反复失败。

**⚠️ 收益被模组数据卡死，不是被引擎卡死。** 普查（`tools/_diag-inversion.ts`）：

| 模组线索 | 共 32 | color 2 | 被动（进门就看见）**21** | 需动手查 **9** |
|---|---|---|---|---|

也就是说 **21/32 是作者标成 observation/automatic 的**，进门就给。
实跑一局（顺着引擎顺序走）只出现 **3 个调查岔口**。
引擎这一侧改对了，想让玩家真正有事可做，得动模组数据那一侧。

**代价实测**：顺着走 21 进场 / 8 移动岔口 / 3 调查岔口 / **到达终局** —— 与改前一致。

**⚠️ 对照实验的坑**：`git checkout <sha> -- <file>` **会同时改索引**。
用 `Copy-Item` 还原只修了工作树，之后一个 `git add 别的文件` + commit
就会把那个旧版本一起提交进去（本次踩过，靠 `git show --stat` 发现）。
做完这种实验必须跟一句 `git checkout HEAD -- <file>`。

**未覆盖的缺口（诚实记录）**：`attemptedClueIds` 只在检定**失败**时才起作用，
而骰子随机，全流程测试走不到那条路 —— 变异检验把这行删掉，测试**不会红**。
曾经写过一条测试想守它，既弱又会在重访场景时误判，已删。
不测东西的测试比没有更糟。

### ⛔ 主循环零测试覆盖 —— 动它之前先抽函数（2026-08-20）

1289 个测试里 **0 个**碰 `runModule` / `processScene`。
只从 play-module 引入纯函数（`speechLead`、`noticesEntity`、`rollDice`、
`isRedundantMoveLine`）。

所以改主循环**不会弄红任何测试** —— 也就是没有任何东西会拦住回归。
这个坑仓库里踩过，见 `src/__tests__/narrative-entity-recognition.test.ts:55`：
「这道门原先长在 runModuleInner 的闭包里，测不到 —— 于是四局实跑一次都没演」。

### `chooseConnection` 抽出闭包（2026-08-20，`feat/resolve-nonmove-actions`）

`play-module.ts:117-172`。**纯函数，原样搬运，无行为改动**（除下面两个 bug）。
返回 `{conn, forced}`，`forced` 表示「玩家的话没对上，这是引擎替他挑的」——
原先这两种情况出来一模一样，**外面无从分辨玩家的话被丢掉了**。

抽的过程中当场暴露两个真 bug：

1. **无连接场景会崩**。旧代码 `scored[0].conn` 在 `unlocked` 为空时读 undefined
   → TypeError。而且 `processScene`（1386-2957）**一个 `return null` 都没有**，
   声明的 `SceneConnection | null` 从来不成立 ——
   调用方那 ~60 行 dead-end BFS 兜底（`:3002+`）是**够不到的死代码**。
2. **差点漏掉 `-5` 那一支**（指向不存在场景的连接垫底）。丢了它，
   坏连接会因为「没访问过」拿 +10 排到第一 —— 把玩家送进不存在的地方。

**已钉住但没修**：`condition` 去掉动词后取前 8 字，
「艾德里安的农场（沿着小路向北）」截成「艾德里安的农场（」带半个括号，
玩家说「我去艾德里安的农场」对不上 → 被判 forced。
有测试记录现状（`choose-connection.test.ts` 最后一条），修它是行为改动，另开。

### 主循环脚手架（2026-08-20，`src/__tests__/module-loop.test.ts`）

`runModule` 现在能**离线、可控**地在测试里跑完一整局，约 2-3s/局。
三条注入缝都是现成的：`decide` 注决策、`onLine` 收播报、`LLM_DISABLED` 断网。

**`llmEnabled()`（`play-module.ts:557`）是承重件。** 原先有两份判据：
`llmOnce` 只看有没有 key，`runModuleInner` 里那份还看 `LLM_DISABLED`/`LLM_MODE`。
于是开发机上只要 key 在环境里，`LLM_DISABLED=true` **拦不住车卡阶段打网络**。
变异检验把这条判据去掉 → 4 个循环测试全部 60s 超时（这台机器有真 key）。

**量「玩家选了 X 引擎去没去 X」的正确姿势**（前两次都量错了）：
- ❌ 拿 `condition` 文本比 `scene.name` —— 那是两个字段
- ❌ 拿「下一个岔口所在的场景」当目的地 ——
  **28 次进场只有 15 个岔口**，很多场景进去了不产生岔口
- ✅ 决策器记下当时的播报位置，目的地 = 之后的**第一个进场标题**
  （`━ <name>` / `━ 再次来到 <name>`，见 `play-module.ts:1468`）

**必须选最后一项，不能选第一项。** `moveLabels` 是按引擎自己的优先级排过序的
（`:2890-2906`），选 `options[0]` 等于选了引擎本来就想去的地方。
实测差异：**选第一项 8/8 全兑现，选最后一项只有 26/29** —— 差的全是这个混淆。

曾经是 **26/29**，三处不兑现三轮完全复现。根因已查明并修掉，见下条。
现在断言是 `honored === scored`。
变异检验：让 `chooseConnection` 无视玩家 → 这条立刻红。

### ✅ 静默传送：玩家选的地方，到了又被弹走（2026-08-20，已修）

三处「选了 X 却到了 Y」是**同一个**根因：主循环的
「访问≥6次强制改道」（`play-module.ts:3054-3068`）。
玩家明确选了去某地 → 引擎照做移动过去 → **到达后、场景渲染之前**，
这条兜底发现该场景已进过 6 次，把人弹到别处，**一个字都不说**。
玩家说「返回镇上」，引擎回一句「返回镇上。」，然后人在报亭。

`tools/_diag-forced-move.ts` 量出的证据，三处完全一致：

| 案例 | 被选场景此前进场 | 实到 | 是「第一条通往未访问场景的出边」 | 中间播报 |
|---|---|---|---|---|
| 特里坎家 | **6** | 加比的拖车房 | ✓ | 0 行 |
| 农场外围 | **6** | 农场主别墅 | ✓ | 0 行 |
| 普瑞米尔 | **6** | 报亭 | ✓ | 1 行（那句「返回镇上。」）|

**修法**：`arrivedByPlayerChoice` —— 把人带到当前场景的那一步是不是玩家自己选的。
信号来自 `chooseConnection` 的 `forced`（这个字段就是为它建的）。
玩家自己要来的地方不再触发改道；真触发改道时**出声**。

**代价（实测，不是估计）**：
- 顺着引擎给的顺序走（选第一项）：21 进场 / 8 岔口 / **到达终局** —— 与修改前一致，零影响
- 永远选引擎最不想去的（选最后一项）：修改前 35 进场 / 30 岔口；
  修改后 **40 进场 / 40 岔口 / 到不了终局**，跑满 `rounds < 40`

也就是说：**原先是那条强制改道在把玩家往终局赶。** 拿掉之后，
一个铁了心乱走的玩家会走不到结局 —— 按「炸团也无所谓」这是对的，
但要知道这是真实代价。测试里专门有一条守住「正常玩法仍能通关」。

### ⚠️ 「引擎别再替玩家挪窝」这一步单独做不成立（2026-08-20）

原计划第 2 步是「intent 不是 move 就别强制移动」。查下去发现做不了，**原因如下**：

**整个场景循环里只有一个玩家决策点** —— `play-module.ts:2924-2927`，
而且它问的只有「接下来去哪」。线索探索是自动跑的，不由玩家行动驱动。

所以把强制移动去掉之后：玩家说「我检查那张卡片」，引擎不推他走了，
**但没有任何机制去执行这个行动**，下一轮重新进同一个场景。
`while (rounds < 40)` 兜着不会死循环，但那 40 轮什么也不会发生。
**比现在更糟 —— 现在至少还在推进。**

要让它有意义，必须同时给非移动 intent 一个落点
（investigate/search 就在当前场景跑一次线索检定，复用 `runClueCheck`（`:2701`）），
那已经是在动 `processScene` 这个 **1571 行**函数的控制流了。

**顺带查出一处**：`pl1.decideViaLLM(plContext, [], moveLabels)`（`:2927`）——
第二个参数是 `availableClues`，**传的是空数组**。
`plContext` 里有的是 `knownCluesFormatted`，即**已经发现的**线索，
不是**可以去查的**。对「有线索后玩家自行决定行动」这个设计来说正好是反的。

**还有三处强制移动，不止一处**，改的时候都得算进去：
- `processScene` 里的分数兜底（`:2935-2949`）
- 主循环 `else` 分支的 BFS 强制导航（`:3002+`）—— 返回 null 也会被强推
- 访问次数超限时的 `forcedConn`（`:2987-2988`）

---

**2026-08-21 补记：这条的大部分已经做掉了，别照着上面的结论动手。**

- 「只有一个决策点」不成立了 —— 循环反转之后场景内有「查什么」的循环
  （`scene-pipeline.ts` 的 `MAX_SCENE_ACTIONS` 那段），移动只是其中一个出口
- 三处强制移动里，「访问≥6次强制改道」已被 `arrivedByPlayerChoice` 挡住
  （玩家明确选的目的地不再被弹走，见本文件「静默传送」那条）
- `availableClues` 传空数组**已修**：现在传的是「这个场景还剩什么没查」。

  那个空数组不只是 prompt 里少列一段 —— 它还经 `scoreActionByContext`
  给调查类意图**扣 0.3 分**，等于引擎在主动压制「留下来再查查」。
  测试 `available-clues.test.ts` 钉住了这 0.3（做过变异检验）。

  **实测触发面很小**：6 局里 75 次移动决策，只有 3 次带着未查线索 ——
  因为调查循环通常已经把线索查完了。修的方向对，收益有限，
  真正的瓶颈仍是模组里可查线索只有 9 条（其余 21 条是 passive）。

**2026-08-21 再补：静默那一半修掉了，匹配那一半修不了。**

先量了一次匹配到底行不行（`tools/_diag-phrasing.ts`，
模组里每个多出口场景 × 每个出口 × 12 种说法 = 456 组）：

| 说法 | 命中率 |
|---|---|
| 照抄原文 / 只说地名 / 「去」+地名 / 「前往」+地名 / 地名在句中…… | **100%**（8 种全是） |
| 只说地名前两字 | 3% |
| 同义改写（「换个地方看看」） | **0%** |
| 代词指代（「去那边」） | **0%** |
| 描述特征（「去那个有灯光的房间」） | **0%** |

结论很干脆：**只要话里含完整地名就必中，不含就几乎必不中**。
`matchKeys` 那轮（整句／去括号／场景真名三个键）解决的是 8 字截断，
但本质仍是子串比对 —— 换个说法就掉。要真修得上语义匹配，那是另一件事。

⚠ **判据第一版没有区分力**：只放了 8 种「都含完整地名」的说法，
跑出 100%，看着像"匹配很好"。补进 4 种会掉的才看出真相（66.9%）。
全绿的判据要先怀疑是不是用例太容易。

**能修的是另一半：别瞒着玩家。**
`chooseConnection` 本来就诚实返回 `forced: true`，但上游只拿它喂
「访问≥6次强制改道」，玩家那边一个字都看不到。现在替他挑时会明说：
「（没听清要去哪，两人商量了一下，决定先去 X。）」

`forced-move-disclosure.test.ts` 钉住 `forced` 的语义（含变异检验），
特别钉了「没有出口时 `conn=null` 且 `forced=false`」——
null 是「没得挑」不是「替他挑了」，混同会让上游多播一句莫名其妙的话。

剩下没做的：BFS 强制导航仍在；匹配换语义方案是另一轮。

### ⚠️ 引擎的移动是「给选项 + 不选就替你选」（2026-08-20）

这一条是做活化时顺手查出来的，比文案问题严重得多。`play-module.ts:2925-2949`：

```
decision.action.includes(core)              ← 拿玩家说的话去匹配连接
if (!chosenConn) { ...按分数排序... chosenConn = scored[0].conn; }  ← 没匹配上就替他挑
```

玩家说的话只要不含某个场景名的前 8 个字，就被**静默丢弃**，
引擎按「没去过的 +10、去过的 −3」自己挑一个地方送过去。
**比菜单更糟 —— 菜单至少还承认玩家做了选择。**

而且这个 `decide` 是循环里的 advance 步，循环结构写死成
「进场景 → 探索 → 分析 → 挪窝」，`while (!done && rounds < 40)`，
**每一轮必定以移动结束**，没有「玩家自己决定做什么」的位置。

记在这里是因为它影响整条摄取线的取舍：
connections 这张图很大程度上是在给这个选项菜单供货。
如果范式改成「给线索、玩家自行决定行动」，图的作用会小很多 ——
那时需要的不是「枚举出口」，而是「判断玩家想去的地方能不能去」。

### ⚠ 载荷文档陈述反向传播进生产代码——这是第二次（2026-08-26）

第一次是 `kp-tool-surface-assessment.md` 把四个已经接上线的子系统写成
「零调用方」，多处生产代码/测试注释照抄了这个错误结论。

这一次换了个方向：`docs/voice-readiness.md` 引用的提示词第 7 条原文，
在 `41a8e66`（2026-08-18）被**反转**——从"要求台词带括号神态开头"改成
"默认直接开口，禁止把括号当固定开头"。`voice-readiness.md` 最后一次改是
`0dfefec`（08-13），停在反转前，之后没人回去核对过它引用的原文是否还
成立。于是这条**说反了的**陈述被抄进了 `src/voice/speech-plan.ts:49`
（生产代码的函数级注释）和 `src/__tests__/speech-plan.test.ts:55`（测试
注释）——三处都在说"提示词要求括号"，而提示词那时已经改成反过来的
"不要求括号"。

**两次同一根因**：判据只查路径存在性（"这个文件/这一行还在不在"），
查不出**语义是否仍然成立**，更查不出**语义有没有被反转**。这条不是
"没做判据"，是"这类判据做不出来"——反转前后两句话长得几乎一样，
差的是"要求"变成"禁止"这一个词，机器分不出这是内容更新还是笔误，
也分不出引用它的下游代码到底有没有跟着读过新版本。

**现实的应对不是造判据，是缩短"文档最后核对时间"与"下游引用时间"之间
的距离**——载荷文档（`LIVE_DOCS`）改了关键结论时，回头 grep 一下自己
的原文有没有被其它地方**逐字引用**，这件事目前只能靠人做。

### ⚠ 改了被判据观测的行为，没同步检查观测者的失败分类——这是第三次（2026-08-27）

前两次是"文档说的和代码不符"，去看一眼代码就能发现：

1. `kp-tool-surface-assessment.md` 把四个已经接上线的子系统写成"零调用方"，
   被 12 处生产代码/测试注释照抄（`apply-action.ts:3,30`、
   `world-state-manager.ts:407`、`scene-exits.ts:17`、`source-scan.ts:594`、
   `preflight.ts:102` 等）。已记在上一条。
2. `voice-readiness.md` 引用的提示词第 7 条原文在 `41a8e66`（2026-08-18）
   被反转，文档停在 `0dfefec`（08-13）没跟着改。说反了的陈述抄进了
   `src/voice/speech-plan.ts:49`（生产代码注释）与
   `src/__tests__/speech-plan.test.ts:55`（测试注释）。已记在上一条。

**第三次不一样**：给 `matchSceneClues` 加了"裸动词没有位置信号 → 报歧义，
不擅自选一个"的早退路径，行为本身是对的（歧义判定从 9/10 到 10/10）。
但判据 `src/diagnostics/clue-phrasing.ts` 的**失败分类**没跟上——早退在
`trace.matched` 被填充**之前**就返回，`classifyClueFailure` 只有
`matched.length === 0` 可判，于是把这条早退误判成 `no-key`。而 `no-key`
的定义是"切词/简称方式太窄，**缺同义词**"——处方正好是反的。

实测后果：`analysis/diag/diag-clue-phrasing.md` 26 条失败里 **14 条**
带着这个错误处方。照 `no-key` 去加同义词、放宽匹配，正好会推翻刚做完
的那次修复。

**为什么这次比前两次更隐蔽**：判据是绿的、条数是有的、分类也有，
只是分类是反的——而分类恰恰是这个判据存在的理由，`clue-phrasing.ts:55`
自己写着"四类的修法完全不同，混在一个「命中率」里等于知道有病不知道
病在哪"。一个**有数字、有分类、但分类指向相反修法**的判据，比没有
判据更危险：它会主动把人引向错误的方向，而且带着数据的权威感。

**已做的修法**（供以后照做）：让匹配器留结构化标记
（`ClueMatchTrace.noSignal`），判据读那个标记，不靠 `matched.length === 0`
猜——两条完全不同的路径殊途同归到同一个空数组。新增 `no-signal` 分类，
写明它的"修法"是**这是正确行为，不用修**，与其余分类都不同。效果：
`no-key` 从 14 条降到 1 条。

**可推广的判断**：改动一个被判据观测的行为时，要回头问一句——判据的
失败分类还成不成立？高危信号是新增"提前返回/短路"路径——它们往往
在判据依赖的字段被填充之前就返回，于是在判据眼里和某个既有失败类
"结构上长得一样"，被静默归错类。

⚠ 这一条**无法机器判定**（和前两次一样）：判据全绿、条数不变、分类表
看着完整。只能靠改行为的人回头看一眼判据。**不要为它硬造判据**——上一条
已经就"这类判据做不出来"给过结论（路径存在性判据查不出语义反转），
这条是同一结论在"行为 → 判据"方向上的第二个实例。

### ⚠ 已知语义：activePlayerId 是粘性的，多端下会互相踩（2026-08-28）

L2a 让 `act(input, actingPcId?)`（`src/api/game-session.ts:1290`）能指定谁
行动。**实测语义**：指定 p2 行动后，再不传 pcId，活动身份**仍停在 p2**——
`:1325-1336` 的切换写进 `this.activePlayerId`，是**持久**的（不是单次）。

这是既有语义，不是 L2a 引入的；单人多角色轮换下也合理。但目标场景是
「任意人数、真人各控各的 PC」：那时客户端 A 用 p1 提交、客户端 B 用 p2
提交，之后 A 再不带 pcId 就会**以 p2 的身份行动**。`activePlayerId` 成了
会被别人改写的**共享状态**。现在不会暴露（web 端仍是单客户端），但 L3
引入并发时会。

**倾向的解法（供 L3 参考）**：L3 要求**每次提交都带 pcId**，`activePlayerId`
退化成纯默认值，粘性问题自然消失——比在 L3 里另做「单次 vs 粘性」的开关
更简单。这条不在此轮处理，只记录语义与方向。

**可推广的判断**：当一个"活动身份"字段既被显式路由写入、又被当作默认回退
读取时，它就是共享可变状态；只要还存在"不带参就回落它"的调用方，多端下
就会互相踩。修法不是给读加开关，而是让默认路径本身不再能表达"上一个是谁"。

### ⚠ 可观测性复制了它要消除的歧义——这是第四次（2026-08-29）

给 `intent.ts` 两处 LLM 静默回落（JSON 解析失败 / 调用失败）各加了一条
`log.warn`。验收条款写的是"LLM 正常 → 一条 warn 都没有"——听着合理，
实际后果是：`if (_llmClient) { try {...} catch {...} }` 结构里，
`_llmClient` 为 `null`（LLM 根本没接上）时整块 `if` 都跳过，两处 warn
都摸不到。于是"零条 [intent] warn"同时符合两种截然相反的状态——
**LLM 接上了且这一局全对**，与**LLM 从没接上、全程 regex**——日志上
完全一样。实跑 30 回合 `[intent]` 日志恰好零条，而"零条"本身什么都
证明不了。

同类前科：世界模型门禁不能断言 `loaded`，因为懒加载时 `false` 是正常
状态——"静默 = 健康"的假设在这仓库已经错过两次，这是第三次。

**修法**：不是加更多 warn，是加一条**起手声明**——`declareIntentPath()`
在 `GameSession` 构造时打一条日志，一局一次，明确说这一局最终走的是
LLM 还是 regex，以及走 regex 的具体原因（`llmEnabled()` 为假，还是
接缝本身没配置）。两种"没接上"的原因还要能从措辞上分开，不能是同一句
话——见提交 `0dbd2b8`。

**可推广的判断**：给"失败路径"加可观测性时，要检查"成功路径"与
"从未进入这条路径"在观测者眼里是不是长得一样。如果一个信号的"沉默"
同时可能来自"一切正常"与"这条路根本没跑到"，这个信号就没有真正解决
可观测性问题，只是把歧义从"看不见"挪到了"看得见但读不出来"。

### ⚠ 防线装在让它永远通过的动作下游（2026-08-29）

`handleMove`（`game-session.ts:2089`）：`target = intent.target ?? ""`，
空目标时 `target` 是空串；`sceneId = sceneMap[target] ?? target` 同样
落到空串。`:2107-2108` 按需注册场景——`if (!this.world.getScene(sceneId))
this.world.registerScene(sceneId, target, ...)`——**用空串当 id 把它注册
成了一个真场景**。紧接着 `:2114` 那句 `if (!this.setScene(sceneId))` 是
专门用来拦"场景没能激活"的守卫，但此时场景**已经在上一行被注册过了**，
`setScene("")` 必然成功，守卫必然通过。

结果是一句解析不出目标的空动作，会把玩家"移动"到一个 id 是空字符串、
名字是空字符串、描述是"的场景"的地方，而检测这类失败的那句守卫代码
一次都没能触发过——它写对了判断逻辑，只是**被放在了让它必然通过的
位置之后**。

**可推广的判断**：加一道防线时，不能只问"这个判断本身对不对"，要问
"执行到这道防线之前，前面的代码有没有已经把它要拦的那种坏状态悄悄
修补掉"。防线的位置和防线的逻辑同样重要——写对了逻辑、摆错了顺序，
效果等于没写。

### ⚠ 声明式数据是装饰品——这是第五次（2026-08-29）

`evaluateEndNarration`（`barn-of-premier.ts`）手写了一遍 if 链来判定
结局，从不读 `END_NARRATIONS[i].condition`——那份声明式数据只在最后
一步被当成"按下标取文本"的查找表，靠注释 `return END_NARRATIONS[0];
// true` 人工维持下标与 id 的对应关系。**这不是"忘了接线"这么简单**：
32 态穷举（5 个布尔变量）实测声明式数据本身与 if 链的真实判断在 10 态
上不一致，其中 6 态声明式**给不出任何结局**——如果当年真的读了这份
数据而不是另写一遍逻辑，游戏会在这 6 态上卡死。

数据"看起来"是判定用的（有 `condition` 字段，字段名叫
`requiredClues`/`excludeClues`），实际上从没被求值过，因此也从没被
验证过是否正确——它是装饰品，只是形状做得像判定逻辑，直到有人真的
去读它，才会发现它是错的。见提交 `4f68eda`。

**可推广的判断**：一份数据"长得像"会被机器读取（有条件字段、有结构），
不代表它真的被读取过。判断一份声明式数据是不是真相源，唯一可靠的
方法是找到读它的那一行代码，并确认那行代码真的在**求值**这份数据，
而不是绕过它、只借用它的其它字段（比如这里的 `id`/`lines`）。

### ⚠ 模拟换了输入分布，把唯一没结论的问题绕过去了（2026-08-29）

两次实跑模拟都叫"30 回合"，读起来像是同一个强度的复测。实际输入的
平均长度差 3.5 倍：第一次 21.7 字/条，第二次 6.1 字/条。意图判错次数
从 6 次（≈20%）掉到 0 次。"0 次"看起来像是"问题被验证不存在了"，
但真正发生的是——第二次的输入分布更简短、更接近意图解析规则本来就
覆盖得好的那部分，判错的诱因根本没被触发，不是被修好了。

**可推广的判断**：拿"跑了几个回合""跑了几次"这类**次数**当对照实验
的强度指标是不够的——次数相同不代表输入分布相同。一个问题的复测如果
换了输入的形状（长度、句式、词汇），"没再出现"这个结果不能归因到
"已解决"，必须先确认新的输入分布仍然覆盖了旧的诱因。

### ⚠ 固定回合数把第 6 回合的发现埋进 24 回合噪音（2026-08-29）

第一次实跑模拟在第 6 回合就已经脱轨（一次自然调查被模糊匹配送进了
一个不存在的地方），但因为 prompt 写死"跑满 30 回合"，之后的 23 个
回合是在**已经脱轨的状态下**继续空转产生的——30 回合的记录里，真正
有诊断价值的只是前 6 回合，后面 24 回合（80%）只是在噪音里重复同一个
已经确定的结论，不提供新信息，反而让读整份记录去找"哪里出的问题"变
成大海捞针。

**可推广的判断**：跑模拟/取样时，回合数/次数不应该是写死的常量，
而应该在关键失效发生后允许提前终止（或至少标记"从这里开始不可信"）。
固定长度的取样对"衡量整体质量"有用，但对"定位具体是哪一步出的错"
反而有害——它把信号淹没在了本可以避免的噪音里。

### ⚠ 外部模型的根因推测四条全错（2026-08-29）

2026-08-07 UTF-8 损坏事故发生后，曾把损坏样本交给 DeepSeek 分析根因，
拿到四条推测：数据库 charset 配置、JSON 序列化丢字节、Handlebars
模板引擎转义问题、建议换用 Winston 日志库。**四条全错**——本仓没有
数据库 charset 问题（`WorldStateManager` 用 Bun SQLite，不涉及这类
编码协商）、没有用任何模板引擎（Handlebars 从未出现在依赖里）、
也没有 Winston（本仓自己的 `log.ts` 是从零写的极简封装）。真实机制
是纯字节层面的——3 字节 UTF-8 字符的末字节被替换成 `'?'`，紧随其后的
一个 ASCII 字节被吞掉——这是靠 `server_repair_v2.py` 对损坏文件做
逐字节比对分析查出来的，不是靠"哪个常见组件容易背这个锅"猜出来的
（完整记录见 `docs/incident-2026-08-07-utf8-corruption.md`）。

**可推广的判断**：外部模型在没有实际字节/日志证据的情况下，倾向于把
问题**归因到它训练数据里最常见的那类同名问题的成因**（"UTF-8 乱码"
在通用语料里十有八九是数据库 charset 或框架转义问题）——这是一种
"通用栈先验"，不是针对这个具体代码库的诊断。四条推测每一条单独看
都合理、都是真实存在过的一类 bug，但没有一条对得上这个仓库的技术栈。
向外部模型求助定位根因时，**没有字节/日志级证据支撑的推测只能当作
假设列表去逐条排除，不能当作结论直接采信**——尤其是当推测列出的
组件（ORM、模板引擎、特定日志库）根本不在本仓库的依赖清单里时，
那条推测的可信度应该直接归零，而不是因为"听起来是个合理的技术原因"
就继续往下查。

### ⚠ 整理索引的那一轮自己制造了悬空引用（2026-08-29）

上一轮把 `docs/index-world-model.md` 从 348 行/48KB 精简到 178 行/10.8KB，
但这不在当轮任务范围内，也没在交付里说明。精简删掉的章节里有两处正被
其它文件引用：`docs/todo.json` 的 `risk-01` 指着已删的「备份分层」一节，
`docs/notes/ingest.md` 两处指着已删的「原文与 raw/ 的血缘已确认」一节。
`bun scripts/preflight.ts` 当时没能拦下来——它只查"文档引用的代码路径
是否存在"（`src/diagnostics/source-scan.ts` 的 `LIVE_DOC_PATH` 只认
`ts|mjs|cjs|js` 扩展名），文档引用别的文档这个方向完全没有判据覆盖。

**可推广的判断**：删减或重排一份被别处引用的文档时，删除动作本身
不会报错——断链只在被引用方尝试跳转时才会现形，而这经常发生在
下一轮甚至更晚。**顺带产生的改动（这里是"精简索引"）如果超出了
当次任务声明的范围，产生的副作用（这里是断链）大概率不会被同一轮
自己发现**，因为交付检查通常只覆盖任务范围内的改动。这是本仓第四次
"文档陈述与实现不符"，前三次都是文档写的和代码对不上，这次是文档写的
和另一份文档对不上——同一类判据缺口换了个方向出现。

### ⚠ 两个运行时各持一半——这是第四次（2026-09-01）

`ClueDef.unlocks` 声明了线索间的前置关系（`clue_bedroom_diary.unlocks =
["clue_bedroom_old_doc"]`），但这份声明只被**剧本杀路径**
（`src/world/state.ts:97-104` 的 `discoverClue()`）读取，用来做"发现 A
自动连锁发现 B"。**自由跑团路径**（`GameSession`/`InvestigationEngine`）
从来没读过这个字段——`clue-match.ts` 的候选池里 `clue_bedroom_diary` 与
`clue_bedroom_old_doc` 的 `matchTexts` 高度重叠（"日记本与老旧文件" vs
"老旧文件（米-戈联络术）"），`uniqueAbbrevs` 找不出短唯一片段，逼出
"日记本与"这种没人会说的碎片，玩家怎么说都被 `clue-match.ts` 判 deny。
根因不是匹配算法不够聪明，是**模组数据本就声明了"old_doc 该在 diary 之
后才能拿到"，但自由跑团这条路完全不知道有这条声明**，两个字段候选一直
在互相抢位置。

修法（开发·卧室线索修复 任务①，`2c38d2c`）：给
`InvestigationEngine` 加 `isLockedByUndiscoveredPrerequisite()`，只做
前置门（候选集过滤：old_doc 未满足前置就不参与匹配），不做
`state.ts` 那种自动连锁——两者故意不同，因为 `clue_bedroom_old_doc` 是
Good End / True End 的分界线，自动连锁会让摸到日记的人顺带读懂米-戈联络
术，把结局分界抹平（详见 `investigation-engine.ts:276-297` 的注释）。

**这不是第一次**——本仓"两个运行时各持一半"已经是第四次实例，前三次
分别是：世界状态（`todo-03`，两套世界状态各存一份、四处同一事实各自
维护）、结局判定（声明式 `END_NARRATIONS` vs 硬编码 if 链，见上面
"声明式数据是装饰品——这是第五次"一条）、以及线索失败救济阶梯
（`dfdf57e`「bring the failback ladder into GameSession's clue path
(N=2)」，其提交信息自称"a third instance", 2026-08-31）。这一条按时间
顺序排在 `dfdf57e` 之后（`2c38d2c` 是 2026-09-01），是第四次。

**可推广的判断**：本仓存在两条并行的游戏推进路径（剧本杀/`play-module`
体系 vs 自由跑团/`GameSession`体系），任何"游戏机制"（结局判定、线索
救济、线索前置门……）如果只在其中一条路径的数据结构或求值器里实现，
另一条路径会表现得**看起来完全不知道这条规则存在**——不会报错，只是
静默按更简单的逻辑运作。新增一条依赖模组数据字段的机制时，要显式检查
两条路径是不是都读了它，不能默认"这份数据是全局的所以两边都能看到"。

### ⚠ 引擎教了玩家一个自己不认识的词——这是第二次（2026-09-02）

两个真实案例，同一个形状：

1. `2c38d2c`（开发·卧室线索修复 任务②）——`clue_bedroom_diary` 的揭示
   文本教玩家"打开下水道维修室门"，但场景表里的正式名字是"维修间"，
   `resolveSceneTarget` 曾经在"下水道"这个真场景名上抢先命中（同一句话
   前半段），"维修室"这个别名连候选都进不去。
2. `7d9e6f1`（开发·真相链路 任务①）——True End 第3行、near_truth 第1行、
   `ENCOUNTER_NARRATIONS` 三处反复用"培养缸"/"一大一小"/"营养液"称呼
   `clue_final_brain_jars`，但它的 `matchTexts` 只有 `[clue.name,
   ...findMethods[].description]`，即 `["母女的缸中脑", "打开光源观察
   房间"]`——玩家读完引擎自己写的叙事、用引擎自己教的词，反而被 deny，
   只有照念内部展示名"缸中脑"才行。

**这是第一次给这个具体模式起名字，但已经是第二次实例**——搜过全部
`docs/notes/`，之前没有任何一条用这个框架记过它；2c38d2c 当时只记进了
`docs/notes/engine.md:836`（归进"两个运行时各持一半"那条，因为它同时
牵扯了 unlocks 前置门，形状不纯）。真正干净的"引擎叙事用了匹配器不
认识的词"这个模式，第一次是维修室/维修间，第二次是培养缸/缸中脑。

两次根因相同：叙事文本（揭示文案、结局文案、战斗文案）与匹配器读的
数据（`matchTexts`/场景别名表）是**两份独立维护的文本**，写叙事的人
不会去核对匹配器认不认识这个词，写数据的人也不会去通读所有叙事找
"这个物件在别处还被叫过什么"。两次都是靠**实测自然语句被 deny**才被
人工发现的，不是靠读代码/读数据发现的——这类断链在静态审查里几乎
不可见，只有真的模拟一句玩家会打出来的话才会现形。

现有防线（`src/investigation/narrative-vocabulary-registry.ts`，
开发·真相链路 任务③）：显式登记表 + 判据对每一条跑真实匹配器断言
命中，同 `KNOWN_UNREACHABLE`/`FABRICATION_REGISTRY` 一个模式。**如实
写明它的边界**（该文件头部 `:17-23` 自己也这么写）：这份登记表只保护
**已经登记过的词**，不做散文分词、不自动扫 `barn-of-premier.ts` 的
叙事文本找新词、也不会主动提醒"这里可能还有一个没登记的"。也就是说
第三次同样的断链，如果出现在一个还没被人读到、还没被人拿去实测的
叙事句子里，这道防线**看不见它**——它是回归防护，不是预防机制。

**可推广的判断**：任何"引擎自己生成/写死的叙事文本"，只要提到了一个
可交互对象/地点，就该假定玩家会读到这段文本并用其中的词来指代这个
对象——写新叙事文本（结局、战斗、线索揭示……）时，如果引入了一个新
称呼，要么把这个称呼也补进对应的 `matchTexts`/别名表，要么去
`narrative-vocabulary-registry.ts` 补一条登记。这件事目前没有任何
自动化手段能替代"写完新叙事，自己拿它读一遍、挑几个新出现的名词
试着当玩家输入打一遍"这个人工步骤。

### 别名从引擎侧硬编码迁移到数据层（开发·别名迁移轮 B 组，2026-09-03）

上面两条实例（维修室/维修间、培养缸/缸中脑）修复时都是就地打补丁：
在 `game-session.ts` 里加一个 `if (r.id === "维修间")` 分支、加一张按
线索 id 查的静态表 `BARN_CLUE_MATCH_ALIASES`——修复本身是对的（判据
证明过），但落点选错了：别名是**模组数据的一部分**（"这个场景/线索
还能怎么称呼"），却被写进了**引擎代码**里，而且是按具体 id 一条条列
——`todo-19` 早就在追踪"premiers_barn 硬编码特例只增不减"，这两张表
正是新增的两处。

本轮把它们迁移回数据层：`module/types.ts` 的 `Clue` 加
`matchTexts?: string[]`，`mythos-module.ts` 的 `MythosModule` 加
`sceneAliases?: Record<string, string[]>`（照抄 `sceneBgm` 的既有
范式——同样是"模组数据带一份场景 id 为键的映射，加载时合并进运行时
状态"这个形状，不新发明一套接线方式）。四个词（培养缸/玻璃缸/一大
一小/营养液）迁进 `barn-of-premier.ts` 的 `clue_final_brain_jars.
matchTexts`，"维修室"迁进 `premiers_barn.ts` 的
`sceneAliases["维修间"]`。`game-session.ts` 里原来的静态表与
if 分支都删掉，`bridgeBarnOfPremierClues()` 现在直接读
`clue.matchTexts`，场景别名合并逻辑直接读 `mod.sceneAliases`。

**变异检验钉住了"判据测的是数据不是代码"这件事**：临时把这两处
迁移后的数据清空（不改一行引擎代码），`barn-of-premier-clue-bridge`/
`narrative-vocabulary-registry`/`game-session-run-harness`/
`scene-resolve` 四个文件里 9 条测试精确变红——如果这些测试测的其实
是"引擎代码里那张表还在不在"，清空数据不会让它们变红，变红说明
它们真的在验证运行时最终看到的别名内容，不管这些内容来自代码常量
还是模组数据。

**可推广的判断**：修一个"引擎教了玩家一个自己不认识的词"类 bug 时，
判据在哪测和数据落在哪层是两件独立的事——判据可以先对，数据落点
可以后改，但落点选错了不会立刻报错（测试全绿），只会让下一次遇到
同一类问题的人本能地跟着抄一遍"在引擎里加一个 if 分支"，因为仓库里
已经有两个先例长这样。三档约束（todo-52）第二档设计时反过来吸取了
这个教训——生成的别名（`ObjectMentionClaim`）从一开始就是准备写进
`Clue.matchTexts` 的（本轮 C 组任务），不会重新制造第三张引擎侧静态
表。`todo-19` 记录的 premiers_barn 特例计数从 6 处（4 条 `mod.id`
分支 + 2 张别名表）降到 4 处，仍然 open——`mod.id === "premiers_barn"`
那 4 条分支本身是加载流程耦合，不是别名/称呼类数据，不属于本轮迁移
范围。

### ✅ 多人可见性两处缺陷：存储层过滤、推送层不过滤；场景数据存两份且一份从不更新（开发·多人可见性 N6，2026-09-03）

两处都直接打在"多人拼团"这个目标上，todo-25/todo-24。

**todo-25（WS 广播泄漏）**：`PlayerSession.push()` 早就按可见性
（五档，含 `discoverer_only`）过滤消息，`GET /history?pcId=` 只返回
该玩家可见的那份——但 `ws-handler.ts` 的 `broadcastToSession` 对同一
session 的全部连接发同一份 msg，`server.ts` 用它推 `action-result`
时把完整 narrative（含线索揭示正文）广播给所有连接，包括没有发现
这条线索的另一个玩家。同一份内容，存储层过滤、推送层不过滤，两条
路口径不一致——这正是"信息泄漏只在'回看历史'这个维度成立，不是
'实时全程保密'"的字面意思。

修法边界（任务给定，照做）：不把可见性元数据发给客户端让前端过滤——
数据一旦到了客户端就不叫私密了；必须服务端按连接决定发什么，且要
复用既有的可见性判定，不能另写一套（本仓已经因"两个运行时各持
一半"吃过五次亏，见下一条 todo-24 的教训是同一个模式的另一个实例）。
落地方式：`ws-handler.ts` 加 `broadcastPerConnection`（通用的按连接
分发机制，`resolve` 只拿到"这个连接是谁"，不碰任何游戏状态，不重新
判定可见性）；`server.ts` 的 `broadcastActionResult` 对 player 连接
只发 `session.getPlayerHistory(pcId)` 这一回合新增的部分——直接读
GET /history 早就在用、且被 `clue-visibility-and-per-player-history
.test.ts` 验证过的同一条存储层过滤路径，广播层没有独立的可见性
逻辑，只是"按连接分别去问存储层"。

**todo-24（场景数据存两份，一份从不更新）**：`PlayerSlot.currentScene`
只在 `join()` 时设一次，唯一能更新它的 `setPlayerScene` 全仓零调用方，
玩家实际移动后这份拷贝再也不会跟着变。真正会随移动更新的场景数据
本来就存在——`WorldEntity.position`，`GameSession.movePlayerToScene()`
等每次玩家移动都会 `world.upsertEntity` 写回。两种修法：(a) 把
`setPlayerScene`接进移动路径去同步那份拷贝，(b) 直接删掉拷贝，读取点
改问权威来源。选了 (b)：本仓"同一事实存两份，其中一份不知不觉停止
跟随"这个模式已经出现过五次（世界状态、结局、failback 阶梯、
`unlocks`、别名表——上面那条 D 组记录就是"别名表"那一次），(a) 只是
把 setPlayerScene 接上，代价是从此多一处要记得同步的地方，下一次
新增移动路径（比如战斗撤退、剧情强制传送）忘了调用它，`currentScene`
又会重新漂移；(b) 消灭的是"存在漂移可能性"这件事本身，而不是把
今天已知的同步点补齐。前提是两个读取点都真的能拿到权威来源——
确认过：`PlayerSession` 的两个构造方（`GameSession`/`index.ts`）在
创建它时都已经有自己的 `WorldStateManager`，可以把一个
`sceneOf(characterId)` 解析闭包传进去，不需要额外的依赖注入设施。

**scene_restricted 仍然不完全可靠**：任务明确只要求修 todo-24 这一个
坑，另外两个（比的是活动玩家场景不是消息所属场景；两个 join 点给
了不同的 startingScene）本轮不碰，todo.json 里也没有标它们 done——
`scene_restricted` 这一档可见性规则整体上还不能信，别看到 todo-24
标 done 就以为这一档没问题了。

**如实记录一个不在本轮范围内的既有缺口**：`index.ts`（CLI/剧本杀
运行时）自己的移动处理不会在模组加载后持续调用 `world.upsertEntity`
保活"player"实体的 position（只有 `module-loader.ts` 的初始建号写
过一次）——这不是本轮改动引入的退化，删字段之前那份拷贝在这条路径
上同样是错的（冻结在一个从写死模组算出来、与玩家实际加载的模组
无关的初始值上），只是换了一种错法。这与本文件多次记录的"两个运行
时各持一半"是同一个模式的又一实例，但本轮不修，如实记着。

### 在场实体与线索路径：约束层对"NPC 编造不存在的人/物"的实际覆盖面（开发·在场实体与线索路径 N7，2026-09-03）

todo-41 的真实撞坑（analysis/sim/2026-08-30-barn-natural-play.md:58,86）：
维森酒吧只有"酒吧保镖"一个在场实体，但两条 core 线索的唯一获取路径
是"前台"——玩家换了「用卡片」「问名单」「问包场者」「问马克/旧仓库」
四种自然问法都打不开路，酒吧保镖反而编出"老板锁进抽屉"这类模组里
不存在的东西。报亭是同一个形状：`npcIds: []`，但原文给了报亭老板
整段可互动的行为（提绑架犯被捕、拒绝翻旧报、愿以 3 倍价收购）。

**A/B 按事实层/叙事层的分界补了两个 NPC**：前台（bar_receptionist）
知道什么、代价是什么，全部照原文抄，不编；性格/说话方式是创作，
注释里标清楚不冒充"原文如此"。报亭老板（newsstand_owner）同理，
3 倍价这个数字是原文已有的（也写在 atmosphere 里），没有另定一个。
顺带修了 bar_bouncer.knowledge 一处与原文自相矛盾的地方——原文明说
保安"不回答或者不知道"，但它的 knowledge 此前直接写着包场秘密的
内容，改成如实反映拒答并导向前台。

**C 端到端验证时的一个意外发现**：变异检验分别拿掉 NPC 和拿掉
matchTexts，只有后者会让自然语句路径变红——handleSkillCheck/
applyObjectNameGate 的线索匹配（decideClueMatch）只看 matchTexts，
完全不看 npcIds。也就是说，todo-41 报的"叙述把人引向不存在对象"
这个症状，机制上的根本修复其实是 matchTexts（让玩家的自然语句能
匹配到线索），NPC 补全本身对**这一条**症状不是必要条件——NPC 存在
与否是另一层信号：场景的真实感/一致性（玩家问"前台"能找到人应答，
不会撞见一个不存在的角色），以及本轮 E 建的登记表判据要用它做校验
对象。两件事都值得做，但不要把它们当成同一个机制的两个开关。

**D：约束层拦不住"编造不存在的实体"这件事，现在有判据背书了，不
再是推测**。用真实撞坑文本原样测：`applyConstraints`（
`src/agent/constraints.ts`）与 `checkDialogueText`（
`src/world/world-constraint.ts`，传不传 sceneId 结果一样）都放行
"名单什么的早让老板锁进抽屉了，哪轮得到你翻。"这句话，`passed:true`
原样通过。这与 todo-43 的结论一致（它说过"凭空发明的名词"这一半
没做，修的只是"否认已知对象"那一半），本轮的贡献是把这句话从
"如实记录"升级成一条会在改动后立刻报红的测例（
`npc-fabricated-entity-constraint-gap.test.ts`），并用两条对照测例
证明这不是"约束层整体失效"——时代错置词确实被拦，NPC 自己 secrets
里的内容泄露确实被 checkSecretLeak 拦，缺的具体是"这个专名到底存在
不存在于当前场景"这一个域，ConstraintContext 现在没有任何字段能
回答这个问题。要修需要：①npc-agent.ts 的两处 checkDialogueText 调用
传 sceneId（todo-43 记过的既有缺口）；②ConstraintContext 补一个能
读到"当前场景真实注册了哪些 NPC/物件"的域；③新约束命中时改口径而
不是任由 LLM 自由发挥。本轮不做，是独立的一轮（见 todo-56）。

**E：把"线索提到某角色但场景没有对应 NPC"从只能靠实跑撞到变成
确定性判据**——`scene-npc-noun-registry.ts`，形状照抄本仓已有的
登记表惯例（KNOWN_UNREACHABLE/FABRICATION_REGISTRY/
NARRATIVE_VOCABULARY_REGISTRY/CONFIRMED_FABRICATION_LOG）：只登记
已核实的词，不做通用扩展。当前只收"前台"/"报亭老板"两个词——刻意
不收"保安"/"客人"（原文这两类人"不回答或者不知道"，没有任何线索的
可达性依赖问他们，收进登记表只会对刚修好的 weisen_bar 产生假阳性，
因为 bar_bouncer 的 role 文本不含"保安"字面——这也是为什么本轮没有
把 bar_bouncer 改名对齐原文用词"保安"：改名的收益只是措辞更贴合，
代价是要动十几处测试里硬编码的"酒吧保镖"字面断言，判断下来不值得，
如实记在 A 那次提交的说明里）。扫描顺带用扩展过的候选词表发现医院
场景（hospital）有同形状的缺口——`clue_emily_birth` 要求问"医护
人员"，但该场景 `npcIds` 是空的——本轮不修（todo-41 的验收范围明确
只到维森酒吧/报亭），如实立了 todo-57，没有为了让登记表显得"扫描
全模组都干净"就顺手把这个词也收进正式登记表（收了会让判据在这个
已知缺口上恒报警，等真的动手修医院时再登记）。

### 澄清一条容易误解的因果：补 NPC 不等于修好可达性（开发·约束层补角色实体域 N9 任务 E，2026-09-03，前几轮漏记，本轮补）

**这条必须单独拎出来写清楚，因为写法上很容易被误读**：N7 的变异
检验（`weisen-bar-front-desk-reachability.test.ts` 的提交历史，
commit e42c553）已经证明过——**线索可达性只读 `Clue.matchTexts`，
不读 `Scene.npcIds`**。`handleSkillCheck`/`applyObjectNameGate` 的
线索匹配（`decideClueMatch`）从头到尾没有查过场景里有没有对应的
NPC，它只看玩家的话能不能对上某条线索的 matchTexts。变异检验当时
把 `bar_receptionist` 从 `weisen_bar.npcIds` 里单独拿掉（不动
matchTexts），"问包场者的事"这条自然语句照样能正确解析到线索——
证明 NPC 的有无对**这条特定的可达性判据**毫无影响，真正让路径打开
的机制开关是 matchTexts。

所以：**N7 补的 NPC（任务 A/B：前台/报亭老板，本轮任务 D：医院的
医护人员）本身并没有修好任何一条线索的可达性——修好可达性的是补
matchTexts（N7 任务 C，本轮任务①②在此基础上消掉了别名互相冲突的
问题）**。如果只做"补 NPC"而不补 matchTexts，"问包场者的事"这类
自然语句仍然会落进 fallback/deny，玩家依旧拿不到线索。

**那补 NPC 到底修了什么**——三件事，都不是"可达性"：
1. **玩家能跟一个真实存在的人说话**：`handleTalk` 按名字在
   `presentNpcEntities` 里找目标，没有 NPC 时会诚实回"这里没有
   「前台」"；有了 NPC 之后，玩家说"跟前台说话"能找到人对话，
   不再是"场景明明该有这个角色却连搭话都搭不上"。
2. **叙述提到的人真的存在，不是空中楼阁**：`getSuggestions()`
   这类行动锚点会列"与 XX 交谈"这类提示，NPC 不存在时锚点本身就是
   假的——提示"可以找前台问问"，玩家真去找却找不到人，是另一种
   "报告了一件没发生的事"。
3. **减少 LLM 编造空间（间接，需要 N9 任务 B 一起才真正落地）**：
   单纯补 NPC 不会让 LLM 自动停止编造——todo-56 的酒吧保镖案例发生
   在 weisen_bar **已经有** `bar_bouncer` 这个真实 NPC 的情况下，
   它编的是**另一个**不存在的角色（"老板"）。补 NPC 本身只是"给
   对话一个真实的说话人"，真正拦住"这个说话人编造别的不存在角色"
   要靠 N9 任务 B 新增的 `dialogue_fabricated_character` 约束域。

**这条为什么值得单独写一条 note，而不是散在各次提交说明里**：
不写清楚的话，下一个人遇到"某条线索死活拿不到"这个症状时，凭直觉
会先去检查"这个场景是不是缺 NPC"——那是错的排查方向，正确的排查
方向是先看这条线索有没有 matchTexts、matchTexts 会不会跟同场景
其它线索撞车（`scene-matchtext-collision.ts` 那条判据）。补 NPC 该
做（叙事真实感/避免玩家找不到该找的人/给约束层校验对象），但它
解决的是不同的问题，排查顺序搞反了会在错误的地方浪费时间。

### 待办里的行号引用值不值得建一条判据校验它没漂移（开发·陈旧记录纠正+收敛前置 N10，2026-09-03）

复核了 `docs/todo.json` 里 30 条 open 待办中带 `file.ext:line` 风格
引用的 12 条（共 15 处，todo-19/20/33/23/27/28/30/31/38/44/52，另加
`agent/types.ts:167` 那条），逐条对着当前源码验证行号是否还指向它
描述的内容。结果：**9 处准确、1 处偏移 3 行（todo-27）、3 处
（todo-19 的 4 个 mod.id 分支行号、todo-20 的 index.ts:179、todo-23
的三个 player-session.ts 行号）明显漂移但内容仍在附近能找到、1 处
（todo-31 的 `career.ts:265`）指向了完全无关的代码**——这是本轮抽样
里唯一一处"顺着行号去看会理解错内容"的真事故，其余漂移都只是"顺着
行号去看会先愣一下、往上下翻几行就能找到"级别的小麻烦。

**结论：不建一条强制校验行号+内容一致的机器判据，理由三点**：

1. **preflight 已经挡住了更危险的那一半**——tier-4 的存在性校验会
   拦住"引用一个已经不存在的文件/小节"（真正的悬空引用，读者会读到
   404，不会读错内容）；这次复核出的漂移全部是"文件还在、行号偏了"，
   属于代码正常演化的自然结果（相邻代码增删导致整体下移），不是
   "同一份事实存两份、一份忘了同步"那类系统性失效模式（那类模式
   本仓已经吃过六次亏，见 N7/N8/N9 各轮记录），性质不一样，不该
   用同一套"建判据堵死"的应对方式。
2. **要建这条判据，代价不小**：`docs/todo.json` 目前只存行号，要让
   判据能验证"内容对不对"，每条引用都得额外存一段锚点原文（比如
   引用行的字面文本或一个能唯一定位的短语），这份数据要在追加新
   待办、以及每次相关代码改动时手动保持同步——而 `docs/todo.json`
   的定位本来就是"问题记录"（历史日志，只追加），不是
   `scoring-key.ts`/`matchTexts` 那种运行时消费的契约数据，给它加
   一套需要持续维护的强一致性负担，成本大过它要防的那类问题本身
   造成的伤害。
3. **真正查出来的那 1 处严重案例（todo-31）本身就是"未验证"状态**
   （todo 正文自己写着"未验证"）——它的锚点从写下的第一天起就没有
   指向真正生效的代码路径（原文承认"实际在用的是 `CareerFileStore`"，
   却给了 `career.ts`——`CareerStore` 所在文件——的行号），这不是
   "行号漂移"，是从源头就给错了引用，机器判据能验证的是"行号还在
   不在原地"，验证不了"这个人是不是从一开始就引对了文件"，这类
   错误只能靠人工复核发现，跟本轮这次一样。

**替代方案（已经在做，继续做）**：定期人工复核（如本轮），复核时
顺手订正漂移的行号——这次复核出的所有漂移已经在各自的 todo 条目里
补了"记录纠正"段落。如果未来漂移量级明显增加（比如同一批复核发现
远超 1/12 的引用是"指向完全无关代码"这种严重级别），再重新评估要不
要投入建判据；现状不值得。

### 谷仓模组两份表示收敛方案（开发·陈旧记录纠正+收敛前置 N10 任务②B3，2026-09-04）

本节回答任务原文 (a)~(g)，是**方案设计**，不是本轮的执行结果——本轮
（N10）明确约束**不改两份表示本身、不动场景 id、不删第三份表示**，
这份文档是给下一轮收敛工作的输入，不是收工验收物。B4（本轮没做的事）
见本节末尾。

背景：`BARN_OF_PREMIER`（ModuleData，`module/barn-of-premier.ts`，
20 个 ASCII `id` 场景+中文 `name` 展示名）与 `MODULE_PREMIERS_BARN`
（MythosModule，`rules/custom-modules/premiers_barn.ts`，中文场景名
本身就是 key，GameSession 自由跑团实际加载的那份）是需要收敛的两份
表示；`PREMIERS_BARN_MODULE`（`rules/mythos-module.ts:959`，同样是
MythosModule 类型但用 ASCII 场景 id）是第三份、已确认死亡的表示，
见 (e)。

#### (a) "ModuleData 为权威源、MythosModule 降级为投影产物"——独立复核结论：不成立，缺口是双向的

`docs/index-world-model.md:36-37` 已有同向记载，但独立复核（对比
`module/types.ts` 的 `ModuleData`/`Scene`/`Clue`/`ModuleItem`/
`EndNarration` 与 `rules/mythos-module.ts` 的 `MythosModule`/
`ModuleNPC`/`ModuleEnding`/`ModuleItem` 两套类型的完整字段表）发现：
**两个方向都有对方补不出来的结构**，不是单向投影关系。

- **MythosModule → ModuleData 补不出来的**（任务提示的方向，验证
  属实）：`Clue.findMethods`（线索发现方式的结构化描述，MythosModule
  的 `clues` 只有 `{scene, clueType, description?, sanCost?}`，没有
  "怎么发现"这个维度）、`Clue.unlocks`（解锁关系，MythosModule 完全
  没有线索间依赖这个概念）、`ModuleItem.trap`（`TrapMechanics` 整个
  结构——伤害/侦测/规避/挣脱/持续效果，MythosModule 的 `ModuleItem`
  只有 `{name, sceneId, description?}`，没有陷阱概念）、
  `EndNarration.condition`（机器可判定的 `{requiredClues,
  excludeClues?, requiredScenes?}` 结构，MythosModule 的
  `ModuleEnding` 只有 `conditionText: string` 自由文本，交给 LLM KP
  自行判断，不是机器可核验的条件）。这四项确认"人的判断产物"
  （哪条线索该怎么找、找到什么解锁什么、陷阱怎么触发、结局条件怎么
  精确判定）只存在于 ModuleData，MythosModule 目前是更粗糙的投影。
- **ModuleData → MythosModule 也补不出来的**（任务提示没问，但独立
  复核时必须一并验证，否则"单向"这个结论就是没查对方向就下结论）：
  `activation`（模组整体触发条件）、`difficulty`、`introNarration`、
  `spells`/`tomes`（法术/魔法书系统，战斗规则相关）、`rewards`
  （结局奖励的 SAN/CM/reputation/skillGrowth 结构化变化）、`kpNotes`、
  `source`、`initialEffects`（NPC 初始状态覆盖）——这些是 MythosModule
  为"引擎能直接跑起来的可加载模组"这个用途设计的运行时钩子，
  ModuleData 完全没有对应字段，`ModuleSupport`（`types.ts:539-581`，
  `BARN_SUPPORT`）也只覆盖了 `evaluateEnding`/`traumaticClues`/
  `hubSceneId` 等少数几个概念，不是全部。此外 `ModuleNPC` 两侧形状
  完全不同——MythosModule 的 NPC 是战斗/属性导向
  （`hp/maxHp/ac/skills/attributes/faction`），ModuleData 的 NPC 是
  叙事导向（`entrance/knowledge/secrets/behaviors/llmExpanded`），
  谁都补不出对方那一半。

**结论**：不用"权威源/投影"这一对词描述两者关系——准确的说法是
"ModuleData 是叙事/线索结构的权威源，MythosModule 是引擎可加载运行
时的权威源"，收敛方案不能是"以一份为准、另一份降级"，必须是
"合并成一份同时满足两种权威性的结构"（这直接决定了 (g) 的方向：
不能简单删掉一份，需要真正的字段合并）。

#### (b) 场景 id 形态决策——本轮最重要的结论：id 空间收敛到"中文展示名"，不是 ASCII

复核证据（实测覆盖 `src/__tests__/` 与非测试 `src/` 下引用本模组
中文场景名字符串字面量的文件）：以 5 个代表性场景名
（维修间/艾德里安的农场/与艾德里安的会面/农场外围/加比的拖车房）
取并集去重统计，`src/__tests__/` 下 **48 个文件、287 处引用**直接
写死这些中文场景名字符串；非测试 `src/` 下还有 **19 个文件、135 处
引用**（含 `game-session.ts` 本身、ingest 管线多个文件、
`llm/npc-dialogue-prompts.ts`、`play/scene-resolve.ts` 等）。反过来，
`BARN_OF_PREMIER` 的 ASCII 场景 id（如 `adrian_hospital_meeting`/
`maintenance_room`/`farm_periphery`）目前**只在 `barn-of-premier.ts`
自己和依赖它读 `Scene.id` 字段的少数几个判据/桥接函数里出现**
（`barnSceneIdMap()`/`bridgeBarnOfPremierClues()`/
`scene-npc-noun-registry.ts`/`scene-matchtext-collision.ts` 这类）。

更关键的证据：`GameSession.stripBracketSuffix`
（`game-session.ts:4099-4101`）+ `barnSceneIdMap()`
（`:4123-4134`）的存在本身就说明，**运行时（GameSession +
MythosModuleLoader + InvestigationEngine）从来没有真正使用过 ASCII
场景 id**——`state.scene`、`investigation.getSceneClues()`、
`movePlayerToScene()` 全部拿中文展示名当 key；`BARN_OF_PREMIER` 的
ASCII id 只是它自己内部的私有句柄，每次要跟运行时打交道都得先经过
一次"ASCII id → 去括号后缀的中文名"的翻译。也就是说，**中文展示名
早就是事实上的运行时 canonical id**，ASCII id 是需要额外翻译层才能
用的那一个。

**决策**：收敛后的场景 id 形态应该是**中文展示名（去括号后缀）**，
不是统一成 ASCII。理由：
1. 改动量差 287:135 处以上——统一成 ASCII 需要动 `src/__tests__/`
   下至少 48 个文件（还不算这次只抽样了 5 个场景名，实际全部 20+
   个场景名覆盖的文件数只会更多），而让 `BARN_OF_PREMIER` 改用中文
   展示名当 `id`，只需要动 `barn-of-premier.ts` 自己 + 少数几个直接
   读 `Scene.id` 字段做翻译的桥接/判据文件（`game-session.ts` 的
   `barnSceneIdMap()`/`bridgeBarnOfPremierClues()`、
   `representation-consistency.ts`），量级在个位数到十位数文件，
   不是 38 vs 3 这种任务最初设想的数字（复核后的真实差距其实更
   悬殊，方向结论不变，量级说明作废，以本段实测为准）。
2. 运行时已经在用中文名当事实上的 id，改 ASCII 是在制造一个"新
   canonical id 空间"，还要再写一层新翻译；改中文名是"删掉一层已经
   不必要的翻译"，工作量小且直接消灭 `stripBracketSuffix`/
   `barnSceneIdMap` 这类专门为弥合两个 id 空间而存在的代码。
3. `ModuleData.Scene.id` 目前是 ASCII 这件事本身没有任何运行时读者
   依赖它是 ASCII——没有代码把它当数据库主键、URL 片段或者需要
   ASCII 安全性的场合使用，改成中文字符串不会破坏任何现有约束。

**分步建议**（细节留给 (g)，这里只定方向）：先让
`barnSceneIdMap()` 的翻译层退化成恒等映射（即：给
`BARN_OF_PREMIER.scenes` 的每个 `id` 都改成对应的去括号中文展示名，
`barnSceneIdMap()` 变成 `id => id` 的空操作），验证全部相关测试仍绿
后，再把 `barnSceneIdMap()`/`stripBracketSuffix` 这类翻译代码整体
删除——不是一步改完，是先让两边的 id 值相等，再删掉"处理不相等"
的代码，每一步都可以单独验证、单独回滚。

#### (c) MythosModule 独有字段落进 ModuleSupport 的复核——不能，形态不对，需要新字段而不是塞进旧结构

任务提示的 9 个字段（activation/difficulty/introNarration/spells/
tomes/hooks/rewards/kpNotes/sceneBgm）+ 复核中额外发现的
`sceneAliases`/`source`/`exits`/`sceneDescriptions`/`initialEffects`/
顶层 `clues`，逐项核对 `ModuleSupport`（`types.ts:543-581`）：
`ModuleSupport` 目前只有 `traumaticClues`/`evaluateEnding`（一个
函数，不是数据）/`endLabels`/`encounters`/`hubSceneId`/
`finaleSceneId`/`earlyGameEndSceneId?`/`finaleClueId`/
`bossNpcIdPattern`/`players?` 这十个字段，**没有一个能直接承载**
上面这些 MythosModule 独有字段——`ModuleSupport` 的设计定位是
"ModuleData 之外，引擎跑单条模组需要的少量运行时钩子/常量"
（`types.ts:538-542` 原注释），不是"MythosModule 专属字段的容器"。
把 `activation`/`spells`/`tomes`/`rewards` 这类整块结构硬塞进
`ModuleSupport` 会让它变成两份表示专属字段的大杂烩，违背它自己
"少量运行时钩子"的定位。

**结论**：不塞进 `ModuleSupport`，需要在合并后的统一模组类型上新增
对应字段（例如 `ModuleData` 补一个可选的 `runtimeHooks?:
{activation?, difficulty?, spells?, tomes?, rewards?, kpNotes?,
source?, initialEffects?}` 之类的分组字段，具体形状留给真正做合并
的那一轮设计，这里只确认"不能塞进现有 ModuleSupport"这个否定性
结论）。两个字段需要特别标注语义重叠、不能直接合并：
- `sceneAliases`（MythosModule，场景别名）与 `Clue.matchTexts`
  （ModuleData，线索文本别名）——`types.ts:313-314` 的既有注释已经
  写明"是同一件事在两种载体上的对应字段"，合并时要决定统一成哪种
  载体（场景 or 线索），不是简单地都保留。
- `sceneBgm`（MythosModule，场景→BGM 的直接映射）与
  `meta.bgmHints`/`Scene.bgmHint`（ModuleData，两个不同粒度的 BGM
  相关字段）——三者语义相近但形状都不同，合并时要选一种。

#### (d) MythosModule 独有的 6 个运行时场景——处置方案

B1/B2 已经给出成因（见 `representation-consistency.ts` 的
`KNOWN_INCONSISTENCIES`），本节给出正式处置方案：

1. **"奇怪的卡片"**（ModuleData 侧是 `clue_card`，线索不是场景）：
   处置方案——保持现状，不需要在 ModuleData 里新建一个同名场景。
   这是 MythosModule 把"一件线索物品"错误建模成了"可导航场景节点"，
   收敛时应该在 MythosModule 侧删掉这个伪场景节点，让"奇怪的卡片"
   回归线索身份，不是反过来在 ModuleData 里补一个场景。
2. **"旅店"**（ModuleData 侧有孤儿常量 `S.HOTEL` 但从未接进
   `buildScenes()`）：处置方案——这是真地点，只是 ModuleData 侧漏接。
   收敛时把 `S.HOTEL` 正式接入 `buildScenes()`（需要人工核对原文
   确认这个场景在故事里出现的必要性，不是自动化判据能决定的），
   让两侧都有这个场景，不是从 MythosModule 删掉它。
3. **"比较大的奇怪管道"/"艾米丽与爱莉的棺材"**（ModuleData 侧并进
   `维修间`，MythosModule 侧拆成独立场景节点）：
   【方案已修订，开发·场景集合收敛 N12 步骤 2c，2026-09-04】
   下面这段原案（"保留 MythosModule 的细粒度拆分"）已经被实测数据
   否定并执行了相反方案，不要再按原案执行。
   原案已执行的修订方向是：**从 MythosModule 删除这两个伪场景节点，
   内容并入维修间**（与 2a 处理三个伪场景同一手法）。修订理由：
   - 实测两个子场景都是零线索死胡同（走进去读一段描述，只能原路返
     回），"更精确地走到管道前/棺材旁"并不带来任何玩法提升。
   - ModuleData 侧同样内容是维修间里两条可被玩家动作命中的线索
     （`clue_final_pipe` / `clue_final_coffin`），玩法精度反而更高。
   - 原文（`tools/modules/raw/section_12.txt`）第 1 行即「维修间：」，
     管道（line 25）和棺材（line 39）都是 ▶ 子小节，不是独立房间——
     原案说"两侧都对得上原文结构"，实测原案方向（保留/扩大细粒度）
     与原文不符，合并方向（删子场景节点）才与原文一致。
   - 两个伪场景的描述文本已并入 MythosModule 的维修间 `sceneDescriptions`
     扩展段落（管道，92 字）和 `on_enter_scene` hook 叙事（棺材，75 字）。
   - 艾米丽/爱莉两个 NPC 的 `sceneId` 已从 `"艾米丽与爱莉的棺材"` 迁
     至 `"维修间"`，与 BARN_OF_PREMIER 一侧一致。这两条 npc_scene 不一
     致随之一并消失（总条数 8 → 4）。
   ⚠ 以下原案文字留作历史存档，已被上面的修订所替代——
   ~~原案（已否定）：处置方案——**保留 MythosModule 的细粒度拆分**，
   让 ModuleData 也拆出对应的子场景（而不是让 MythosModule 合并回粗
   粒度），理由：MythosModule 是运行时实跑加载的那份，细粒度场景让
   玩家能更精确地"走到管道前"/"走到棺材旁"而不是笼统地"在维修间"，
   叙事精度更高，收敛应该取更精细的一侧，不是取更粗糙的一侧。~~
4. **"菲碧_特里坎"/"米尔_特里坎"**（MythosModule 把 NPC 建成了可
   导航的伪场景节点）：处置方案——同"奇怪的卡片"，这是建模错误，
   收敛时应在 MythosModule 侧删掉这两个伪场景节点，让这两个 NPC
   回归"挂在 `tricam_house` 场景下的 NPC"身份（ModuleData 侧本来
   就是这么建的，`Scene.npcIds`），不需要在 ModuleData 里新建同名
   场景。

#### (e) 第三份表示 `PREMIERS_BARN_MODULE`——步骤 4 已完成（开发·场景集合收敛 N12，2026-09-06）

复核确认：`getCustomModule("premiers_barn")` 命中优先于
`builtinModules` fallback，标准调用串"普瑞米尔的谷仓"必然命中
`.includes("谷仓")` 分支，因此 `PREMIERS_BARN_MODULE` 在生产加载路径不可达。
执行步骤 4 前又核到一个 prompt 遗漏：`scripts/gen-speech.ts` 也消费了
该符号，实际消费方不止 prompt 列出的 6 处。

**已执行（按消费方先于定义删除）**：
- `gen-speech.ts`：保留 `MODULE_PREMIERS_BARN`，删除第三份表示。
- `confirmed-fabrication-log.test.ts`/log：确认 `MODULE_PREMIERS_BARN`
  没有历史 `adrian-secrets-aware` 同类错误，删除该旧护栏及其 dead-module
  测试；步骤 3 的 `premiers-barn` 护栏仍保持 6 条。
- `npc-secret-truth-consistency.test.ts`：删除。它专门测试已删除第三份
  表示的历史 bug；live `MODULE_PREMIERS_BARN` 的 secrets 已核对为正确，
  从未出现该错误，迁移测试反而会改变测试语义。
- `ingest-three-way-audit.test.ts`：审计仍保留 BARN_OF_PREMIER 与
  MODULE_PREMIERS_BARN 两份谷仓表示；`mythos-module.ts` 的其他内置模组
  仍由通用审计源覆盖，不把同文件其他模组误删。
- `mythos-scene-whitelist.test.ts`：保留 INNSMOUTH/ARKHAM 两个内置模组
  的边界循环，仅移除第三份谷仓表示。
- `game-session.ts`：保留同一 import 行中的 ARKHAM/INNSMOUTH；删除谷仓
  builtin fallback 值，allModules 的谷仓 key 保留但 value 使用现有 `mod`。
- `probe-semantic-contradiction.ts`：保留 live MODULE_PREMIERS_BARN，
  删除第三份采集源。
- 最后删除 `mythos-module.ts:959` 到文件末尾的
  `PREMIERS_BARN_MODULE` 定义。

**现状**：运行时 import 扫描仍发现 6 个合法的 `mythos-module` 文件级
import（它们使用 Arkham/InnsMouth/loader 等其他导出），但源码中
`PREMIERS_BARN_MODULE` symbol mentions 为 0；typecheck 与全量测试均通过。
第三份表示删除完成，步骤 5 才退役 `representation-consistency.ts`，本轮不删。

#### (f) 判据网在收敛中的角色分类

- **不受影响**（判的是场景/线索/NPC 数据本身的内部一致性，跟"有
  几份表示"无关，两份合并成一份之后原样继续跑）：
  `scene-npc-noun-registry.test.ts`、`scene-matchtext-collision.
  test.ts`、`end-narration-clue-reachability.test.ts`、
  `hospital-staff-reachability.test.ts`、`backstory-name-clash.
  test.ts` 等一大批读 `BARN_OF_PREMIER` 具体字段做叙事/匹配逻辑
  校验的测试——合并后这些字段仍然存在（只是可能挂在合并后的统一
  结构上），判据本身不需要改逻辑，最多改 import 路径。
- **安全网**（专门为"防止两份表示悄悄失步"而存在，收敛完成前必须
  留着，收敛完成那一刻自动变成"名单归零"的绿灯，可以直接删除或者
  转成"防止未来再长出第二份表示"的哨兵）：
  `representation-consistency.test.ts`（`KNOWN_INCONSISTENCIES`
  归零 = 收敛完成的验收标准，判据本身写在其头部注释里）、
  `module-endings-consistency.test.ts`（3 路结局 id 集合比对，收敛
  成一份后自动退化成只剩 1~2 路，判据逻辑要跟着简化）。
- **收敛后失效，需要删除或改写**（判的是"两个 id 空间之间的翻译
  是否正确"，翻译层被删除之后这些测试测的东西根本不存在了）：
  `scene-id-bridge.test.ts`、`ending-namespace-truth-source.test.ts`
  ——这两个测的是 `stripBracketSuffix`/`barnSceneIdMap` 这类桥接
  代码本身，(b) 的方案会把这些桥接代码整体删除，测试要跟着删除
  （不是改写，因为它们的被测对象将不复存在）。
- **半成立，需要拆分或重新定位**（`barn-of-premier-clue-bridge.
  test.ts` 测的是"32 条 ModuleData 侧线索被桥接进运行时"这件事本身
  ——收敛成一份数据结构之后，"桥接"这个动作也不复存在，但它验证的
  "这些线索确实可以通过真实场景导航+技能检定被玩家摸到"这个更底层
  的行为不能丢，需要拆成"直接对合并后的统一数据跑端到端可达性"的
  新测试，不是简单删除）。
- **依赖第三份表示，随 (e) 处理**：
  `confirmed-fabrication-log.test.ts`、`ingest-three-way-audit.
  test.ts`、`mythos-scene-whitelist.test.ts`、
  `npc-secret-truth-consistency.test.ts`——见 (e) 的两步处置方案。

#### (g) 分步顺序与每步验收判据

每一步必须能独立跑绿、独立回滚，不允许"这一步半成品，等下一步才能
测"。建议顺序（编号是执行顺序，不是优先级）：

1. **场景 id 形态收敛**（(b) 的方案）：
   1.1 把 `BARN_OF_PREMIER.scenes` 每个 `id` 改成对应的去括号中文
       展示名（`barn-of-premier.ts` 单文件改动）。
   验收：`barnSceneIdMap()` 退化为恒等映射后
   `barn-of-premier-clue-bridge.test.ts`/`scene-id-bridge.test.ts`/
   `ending-namespace-truth-source.test.ts` 全绿；
   `representation-consistency.ts` 的 npc_scene/scene_set 判据
   （因为不再需要跨 id 空间比对，直接用同一套中文名比较）逻辑可以
   简化，先跑一遍确认原有 12 条不一致里跟"id 形态不同"无关的那些
   （B2 已裁决的 4 条真实错误 + 2 条颗粒度差异 + 部分 scene_set 条目）
   不受影响，数字不因为这一步改动而意外变化。
   1.2 删除 `stripBracketSuffix`/`barnSceneIdMap`/
   `bridgeBarnOfPremierClues` 里的翻译逻辑（保留桥接動作本身，只删
   "id 不一致所以要翻译"这部分）。
   验收：同上全部测试保持绿，`git diff` 确认这一步只删代码不改
   数据。可独立回滚（`git revert` 这一个 commit 即可，因为 1.1 已经
   让 id 空间提前对齐，1.2 只是清理死代码）。

2. **场景集合收敛**（(d) 的方案）：按 (d) 给出的 4 类分别处理——
   "奇怪的卡片"/"菲碧_特里坎"/"米尔_特里坎" 从 MythosModule 删除
   伪场景节点（3 个改动，可以分别提交分别验收）；"旅店"接入
   `buildScenes()`（1 个改动）；管道/棺材两个子场景在 ModuleData
   侧补出对应拆分（1 个改动）。每个改动后跑
   `representation-consistency.ts` 的 `findSceneSetInconsistencies`，
   验收标准是"这一条从 `KNOWN_INCONSISTENCIES` 里消失"。

3. **确认的事实错误订正**（(a)(b) 无关，独立于收敛，B2 已裁决）：
   艾德里安/流浪汉/Mi-Go 的 `sceneId` 与绑架人数，在 MythosModule
   侧改成 B2 裁决的正确值。验收：`findNpcSceneInconsistencies`/
   `findNumericFactInconsistencies` 对应 4 条从 `KNOWN_INCONSISTENCIES`
   消失；`npc-secret-truth-consistency.test.ts` 这类叙事一致性测试
   保持绿（顺手确认这次订正没有引入新的叙事矛盾）。

4. **第三份表示清理**（(e) 的两步方案）：先处理 4 个测试文件的
   数据源依赖，验收每个测试文件独立改完后仍绿；再删
   `PREMIERS_BARN_MODULE` 定义与 `game-session.ts` 里的死 fallback，
   验收 `bun run typecheck`（确认没有遗漏的 import）+ 全量
   `bun test`。

5. **字段合并**（(a)(c) 的方案，工作量最大，放最后）：设计并落地
   合并后的统一模组类型（`ModuleData` 补 `runtimeHooks?` 之类的分组
   字段承载 MythosModule 独有的运行时钩子），把
   `MODULE_PREMIERS_BARN` 与 `BARN_OF_PREMIER` 合并成一份数据、一个
   加载路径。这一步影响面最大，应该拆成"先让统一类型能同时表达两边
   现有字段而不删任何东西"（验收：新类型的 typecheck 通过，两份
   原始数据都能无损转换成新类型）与"实际合并成一份、删除另一份"
   （验收：`representation-consistency.ts` 整个判据模块因为找不到
   第二份表示可比对而被删除，删除本身就是最终验收标准）两个子步骤。

**每步之间的依赖**：1 必须先于 2/3（id 形态统一之后场景/事实层面的
比对才不用再操心 id 空间不一致带来的噪音）；2/3/4 互相独立，谁先谁
后不影响正确性；5 必须最后做（依赖 1/2/3/4 都完成，字段/场景/事实
层面先对齐，合并才不会把还没订正的错误一起合并进最终结构）。

#### B4：本轮（N10）明确没有做的事

- **没有改动 `BARN_OF_PREMIER`/`MODULE_PREMIERS_BARN` 任何一份表示
  的数据**——B2 裁决出的 4 处确认错误（艾德里安/流浪汉/Mi-Go 站位、
  绑架人数）**没有订正**，只是把裁决结论写进了
  `KNOWN_INCONSISTENCIES.reason`；(g) 步骤 3 才是订正它们的地方。
- **没有动场景 id**——(b) 只是方案结论，`BARN_OF_PREMIER.scenes` 的
  `id` 字段仍然是 ASCII，`stripBracketSuffix`/`barnSceneIdMap` 仍然
  存在且仍在被使用；(g) 步骤 1 才是执行这个决策的地方。
- **没有删除第三份表示 `PREMIERS_BARN_MODULE`**——(e) 只是方案，
  `rules/mythos-module.ts:959` 的定义、`game-session.ts:46/4010/4018`
  的 import 与死 fallback、4 个依赖它的测试文件全部原样保留；(g)
  步骤 4 才是执行的地方。
- **没有新建任何字段**（`ModuleData.runtimeHooks?` 之类）——(c)/(a)
  只是给出"不能塞进 `ModuleSupport`、需要新字段"这个否定性+方向性
  结论，没有落地任何新类型定义；(g) 步骤 5 才是执行的地方。
- 这份文档本身是**方案设计**，不是收敛工作的执行记录——下一轮
  要做收敛，应该从 (g) 的步骤 1 开始，按顺序推进，每步都有独立
  验收标准，不需要重新调研，直接执行即可。

### 执行 (g) 步骤 1 前的补充复核：场景 id 改中文，跟摄取管线的「纯 ASCII」约束不冲突（开发·场景 id 收敛 N11，2026-09-04）

(b) 的理由 3（"没有任何运行时读者依赖 `Scene.id` 是 ASCII"）只查了运行时，
执行 (g) 步骤 1 前先查了摄取管线这一侧——`src/ingest/ids.ts:7` 与
`ingest-ids.test.ts:49/124/183` 三处写着"纯 ASCII"，`inherit-ids.ts`
又会让管线按 `name` 继承 `BARN_OF_PREMIER.scenes[].id` 这个基准 id，
表面上像是要跟步骤 1 撞车。逐层查证后**结论：不冲突，问题是这两处
断言各自在说不同阶段的 id，字面上共用"纯 ASCII"这个词造成了误读**。

**查证过程**：
1. `assignSceneIds`/`assignItemIds`/`assignNpcIds`（`ids.ts:35-96`）是
   管线自己的**内部句柄生成器**——按块在原文里的顺序编号，产出
   `scene_NN`/`item_NN`/`npc_NN`，**从不读取 `BARN_OF_PREMIER` 一个
   字节**，函数签名上根本没有基准数据这个输入。`ingest-ids.test.ts`
   里全部 3 处 `toMatch(/^[a-z0-9_]+$/)` 断言（`:53`/`:128`/`:186`）
   测的都是这三个函数**自己的直接返回值**，不是继承之后的最终 id。
   这批断言在 `BARN_OF_PREMIER.scenes[].id` 变成什么样之后都继续
   成立——它们跟基准 id 的形态毫无关系，步骤 1 不会碰它们。
2. 基准 id 唯一流入管线产物的地方是 `inherit-ids.ts` 的
   `computeIdInheritance`/`applySceneIdInheritance`/
   `applyItemIdInheritance`/`applyClueIdInheritance`——这四个函数
   全部是纯字符串 `Map` 操作（按 `stripDisplayAnnotation` 归一化后
   的 `name` 配对，配上就把内部 `scene_NN` 替换成基准的 `id` 值），
   没有任何一处对 id 的字符集做假设或校验。实测（构造中文基准 id
   `"维修间"`/`"霍姆斯医院"` 调用 `computeIdInheritance`+
   `applySceneIdInheritance`）：配对、替换、连带改写
   `connections[].targetSceneId` 全部正确工作，中文字符串跟 ASCII
   字符串在这套纯 `Map` 逻辑里没有任何差别。
3. 逐条核对"中文 id 会渗进存档文件名与 `Provenance.path`"这句测试
   注释里点名的两个风险点，**都不成立**：
   - **存档文件名**：全仓唯一按 id 拼文件名的地方是
     `api/module-editor.ts:115`（`` `${module.id}.json` ``），用的是
     `ModuleData.id`（模组顶层 id，`BARN_OF_PREMIER` 里是
     `"premiers_barn"`，`types.ts:6`），跟 `Scene.id`（步骤 1 要改的
     那个字段）是完全不同的两个字段，互不影响；`scripts/ingest/run.ts`
     的产物文件名（`scenes.json`/`items.json`/`provenance.json`/
     `report.txt` 等，`run.ts:203-339`）全部是写死的字符串，不掺
     任何场景 id。全仓找不到第二处把 `Scene.id` 拼进文件名的代码。
   - **`Provenance.path`**：形如
     `` `scenes[${sceneId}].openingAtmosphere` ``（`build-narrative.ts:409`
     等），是写进 JSON 产物里给人读的一段"类 JS 路径"展示字符串，
     不是真实文件系统路径，也没有任何代码把它当路径去 `readFileSync`/
     正则解析——中文字符出现在这里没有功能后果，只是"看起来不像
     western 风格的路径"，纯审美，不影响任何机制。
4. `ids.ts:7` 那句"id 的功能需求只有四条：…纯 ASCII…"，对照
   `inherit-ids.ts` 头部注释（`:9-15`，"已定方向：不迁移 id，让
   管线继承基准 id"）能看出这句注释写的时候心里想的场景是"配不上
   基准、只能用内部 `scene_NN` 兜底"这一支路径——那一支确实应该
   保持纯 ASCII（`scene_NN` 这个格式本身天然就是），但**继承成功的
   那一支，最终 id 形态从来就是"基准是什么形状，继承到的就是什么
   形状"，这是 todo-48 定下的设计目标本身**（"内容层可重新生成，
   id 层人工维护"），不是"id 必须是 ASCII"，只是过去基准恰好是
   ASCII，两件事没被区分开来，注释写法上把"内部句柄的性质"和
   "继承后的性质"混成了一句话。

**裁决：选 (ii) 的加强版**——不是"接受中文 id 之后在边界处 sanitize"，
是**查证后确认现在完全没有一个真实存在的边界需要 sanitize**：
`Scene.id`（不管 ASCII 还是中文）从来没有流向文件系统路径或者任何
做字符集假设的解析逻辑；真正拼文件名的 `ModuleData.id` 是另一个
字段，本轮不改它。(i)/(iii)/(iv) 三个选项都不需要——(i) 会让 todo-48
刚做完的 id 继承机制失去意义；(iii) 已被 (b) 自己的 287:135 引用量
否掉；(iv) 是重新引入一层翻译，跟步骤 1 要删翻译层的目标相反。

**连带修正（避免下一个人从字面误读，重蹈"注释比代码少说一件事"的
坑）**：`ids.ts:7` 的注释与 `ingest-ids.test.ts:49` 的测试标题都已
更新，明确"纯 ASCII"这条约束的范围限定在
`assignSceneIds`/`assignItemIds`/`assignNpcIds` 自己产出的**内部
句柄阶段**，不覆盖继承基准 id 之后的最终形态——两处改动只是文字
澄清，不改断言逻辑本身（`toMatch(/^[a-z0-9_]+$/)` 测的对象没变，
只是标题/注释说清楚了它测的是哪个阶段）。

### (g) 步骤 1 执行记录：场景 id 收敛（开发·场景 id 收敛 N11，2026-09-04）

前置裁决（上一节）确认无冲突后，执行了方案文档 (g) 的步骤 1，分两次
独立提交，各自可回滚：

**1.1（commit f4555a5）**：把 `BARN_OF_PREMIER.scenes` 全部 20 个
`id` 从 ASCII（`tricam_house`/`maintenance_room`/…）改成对应的去
括号中文展示名（`特里坎家`/`维修间`/…），同步改写文件内全部
`targetSceneId`/`sceneId`/`requiredScenes`/`hubSceneId`/
`finaleSceneId`/`earlyGameEndSceneId` 引用，以及仓库里其余 20 个
硬编码这些旧 id 的消费文件（严格限定在实际 `import` 了
`module/barn-of-premier` 的文件范围内，避免误碰 `rules/
mythos-module.ts` 里恰好复用了相同 ASCII slug 的已死第三份表示
`PREMIERS_BARN_MODULE`——两者是巧合同名，不是同一份数据）。
机械替换之外手工修了两处：`scene-resolve.test.ts` 里两处用旧 id 做
"对象属性访问"（不是字符串字面量，替换脚本按设计扫不到）构造别名
表；`ending-namespace-truth-source.test.ts` 有一条测试原本就是在
钉"ASCII id 与运行时 id 不同、但翻译后可查"，这条不一致本身正是这一步
要消灭的东西，改成直接断言相等。新增
`scene-id-bridge.test.ts` 的显式判据钉住 `barnSceneIdMap()`
在这一步之后是恒等映射（不靠其余测试全绿去推断）。

**1.2（commit 359ed5b）**：删除因此变成死代码的翻译层——
`GameSession.barnSceneIdMap()`（连带它的缓存字段）与
`GameSession.stripBracketSuffix`（只有两个调用点，一个是刚删的
`barnSceneIdMap()`，另一个是 `bridgeBarnOfPremierClues()`，后者
改成直接读 `scene.id` 不再需要重新计算）。`isSceneVisited()` 从
"先判断当前模组是不是 premiers_barn、是则经翻译层查、否则原样查"
简化成一行直接查，不再有模组专属分支。`representation-consistency.ts`
里独立内联的同一份去括号函数**没有删**——那份管的是
`ModuleData.Scene.name`（这个字段仍然带括号后缀，没变过）与
`MythosModule` 场景名的比较，跟 `GameSession` 这层 id 格式桥接是
两回事，只是巧合用了同一个正则，不在这次删除范围内。

**验收结果**（对照方案文档 (g) 给的验收标准逐条核对）：
- `barnSceneIdMap()` 在 1.1 后确认是恒等映射（新判据钉住），1.2 后
  确认整个方法已从 `GameSession` 实例上消失（新判据钉住，不是靠读
  代码肉眼确认）。
- `representation-consistency.ts` 的 `KNOWN_INCONSISTENCIES`（12 条）
  数字全程未变——该判据比较的是 `Scene.name`，不读 `Scene.id`，
  与本次改动的字段无关，`findBarnRepresentationInconsistencies()`
  与登记表精确相等的测试全程保持绿，符合"逐条可解释、不该动的没动"
  的验收要求。
- True End 端到端回放（`scene-id-bridge.test.ts` 里"端到端：通过
  确认离开流程也能拿到 True End 正文"一条）、64 态结局穷举
  （`end-narration-32-states.test.ts`）、`scene-matchtext-collision.ts`
  判据、三方审计、`scene-npc-noun-registry.ts`、WS 可见性、
  learn-gate 20 条、`dialogue_fabricated_character` 约束，全部
  保持绿，两次提交前后各跑过一次 `bun test`/`bun scripts/
  preflight.ts` 确认。
- `bun test`：2938（N10 结束基线）→ 2940（1.1，+2：新的恒等映射
  判据）→ 2939（1.2，新判据替换掉恒等映射判据，净 -1）。

**没有做的事（留给 (g) 后续步骤）**：场景集合收敛（步骤 2，
"奇怪的卡片"等 6 处 scene_set 差异）、B2 已裁决的 4 处事实错误订正
（步骤 3）、第三份表示 `PREMIERS_BARN_MODULE` 清理（步骤 4）、
字段合并（步骤 5）——全部原样保留，本轮只做了步骤 1。

### 步骤 5A：统一类型可表达性（开发·场景集合收敛 N12，2026-09-07）

步骤 2（场景集合）、步骤 3（4 条事实错误）和步骤 4（第三份表示）已在
后续轮次完成；两份活跃表示现为 `BARN_OF_PREMIER`（叙事/线索）与
`MODULE_PREMIERS_BARN`（运行/战斗）。步骤 5A 只建立最终目标类型的表达
能力和无损对账，不切换 loader，不迁移这两份活跃数据。

**目标形态**：`ModuleData` 仍是最终统一类型，新增可选 `runtime` 分组；
`ModuleNPC` 新增可选 `runtime` 嵌套。叙事字段保持顶层，战斗/加载字段
显式嵌套，避免同名 `ModuleNPC`/`ModuleItem`/`Ending`/`Clue` 被误当成
可直接交叉的同一个结构。共享运行类型移到中立
`src/module/runtime-types.ts`，`MythosModule` 复用并 re-export 历史类型名，
所以 `module/types.ts` 没有反向 import `rules/mythos-module.ts`。

`runtime` 承载 activation/difficulty/source/introNarration、spells/tomes、
rewards（含 reputation/skillGrowth）、KP notes、initial effects、hooks、
sceneBgm/sceneAliases，以及显式命名的 legacy endings/item placements/clue
bindings。`hooks` 不等于 `Scene.events`，`introNarration` 不等于 `prologue`，
`ModuleReward` 不等于 `Ending` 奖励，全部并存不降级。`ModuleSupport` 未扩展。

**机器验收**：`unified-module.test.ts` 对实际谷仓数据做结构化对账：14 个
叙事 NPC、11 个运行 NPC、4 spells、1 tome、9 rewards、8 KP notes、34 hooks、
19 sceneBgm、1 sceneAliases、32 丰富 Clue、4 trap 条目/其中 3 个
`TrapMechanics`、5 可求值结局和 4 epilogue。任务提示的「4 个
TrapMechanics」经核实不准确：第 4 个音响陷阱是原文已失效的纯叙事 trap
条目，刻意没有 `trap` 结构；两种计数都被独立钉住。

真实变异检验：临时删除 `ModuleRuntimeConfig.rewards` 字段，typecheck 报 9
个错误，覆盖投影、回投、字段差异检查和 rewards 断言；还原后 typecheck/
测试全绿。`scanImports`/`importPointsTo` 解析四条活跃入口的真实 imports，
确认它们都不 import `unified-module`，所以本轮「能表达」不等于已切换运行时。

未做：删除两份活跃表示、迁移实际数据、切换 GameSession 或剧本杀 loader、
删除 `representation-consistency.ts`。这些均留给步骤 5B/5C；后者完成前，
归零的 representation consistency 判据仍保留作安全网。

### 步骤 5B：统一维护入口与旧 Mythos 导出适配（开发·场景集合收敛 N12，2026-09-07）

步骤 5A 的类型 rehearsal 已完成后，运行字段已从
`custom-modules/premiers_barn.ts` 迁入 `barn-of-premier.ts` 的
`BARN_OF_PREMIER.runtime`。这不是把整个旧对象塞进 runtime：字段按运行配置
分组维护，Mythos `items/clues/endings` 使用显式 legacy 名称，场景图用
`loaderSceneDescriptions/loaderExits` 过渡字段保留现 loader 精确输入，11 个
运行 NPC snapshot 嵌在对应叙事 NPC 的 `runtime` 下，`NPC_STATS` 的混合
数值/特殊字符串表也原样迁入 `runtime.npcStats`。

`MODULE_PREMIERS_BARN` 的旧 import/registry 接口保留，但
`custom-modules/premiers_barn.ts` 已删除独立数据正文，只调用
`deriveMythosModule(BARN_OF_PREMIER)`。统一入口不反向 import 适配入口；
迁移前的 loader 行为冻结为结构化 fixture，测试独立对比派生输出的场景、出口、
NPC、人格、线索、法术、典籍物品、奖励、KP notes、hooks 与消息。额外对账：
漏 rewards、漏出口、漏 NPC 都必然红；修改统一来源会改变旧接口输出，证明没有
第二份手填值。

**仍未做（步骤 5C）**：`GameSession`/剧本杀/CLI 自己读取 `ModuleData.runtime`
的加载器切换；`runtime.loaderSceneDescriptions/loaderExits` 与丰富
`Scene.description/connections` 的最终语义收敛；退役 `representation-consistency.ts`。

### 步骤 5C：GameSession 直接加载 ModuleData（开发·场景集合收敛 N12，2026-09-07）

custom registry 的谷仓条目已从 MythosModule 适配结果改为
`BARN_OF_PREMIER`；`GameSession.registeredModules` 由 `any[]` 改成
`ModuleData | MythosModule` 联合类型。谷仓走新的
`ModuleDataRuntimeLoader`，该 loader 不 import `deriveMythosModule` 或
`MythosModuleLoader`；Arkham/InnsMouth 仍走明确 legacy 分支。

旧 `bridgeBarnOfPremierClues` 已删除。direct loader 从 Scene 注册 21 场景/
46 边，从丰富 Clue 注册 findMethods/matchTexts/difficulty/unlocks/revelation
和结构化 SAN；从 ModuleData.items 注册 4 trap 条目/3 TrapMechanics，并从
runtime 注册 spells/tomes/legacy items/clues/rewards/KP/hooks/BGM/aliases。
ModuleData 的 endings/epilogues/prologue/partySetup/narrative 随 load result
保留，GameSession 的 existing ending support 继续消费统一来源。

三名无 runtime snapshot 的叙事 NPC（前台/报亭老板/医护人员）用明确
`narrative_noncombat` 状态进入世界，不提交 hp/ac/skills；SQLite 的 hp=0 只是
存储占位，敌人选择显式排除此状态。自然语言交谈、行动锚点和原 matchTexts
线索路径均有独立端到端测试，仍然不把“NPC 存在”等同于线索可达。

场景描述/出口差异全部由原文裁决，无 D 类冲突；详见
`docs/module-scene-reconciliation.md`。采用 ModuleData 的 2 个新增描述和 5
条正确边是有意行为修复，旧 Mythos 运行字段则是等价迁移。rich Clue SAN
此前被 bridge 丢失，5C 后 True End 自然语言回放会在两条恐怖线索后实际扣
SAN，这是另一个有意修复，不是文本回归。

真实变异：删 rich Clue 注册红 14 条；漏加载前台红 2 条；删报亭→医院边红
场景图测试；direct loader 偷 import deriveMythosModule 红结构判据。最终
KNOWN/actual inconsistency 均为 0，6 条 fabrication guards 均绿。

5D 尚需迁移 `MODULE_PREMIERS_BARN`/`deriveMythosModule` 的 11 个兼容消费方，
再删除旧适配、冻结 fixture、loaderSceneDescriptions/loaderExits 和
representation-consistency。`MythosModuleLoader` 仍服务另外两个模组，不删。

### 步骤 5C 收尾：重试、legacy clues 与状态可见性（2026-09-07）

修正一句容易过头的记录：**GameSession 的谷仓加载分支不调用 derive 或旧
loader，但 custom registry 在模块 import 时仍会执行
`MODULE_PREMIERS_BARN = deriveMythosModule(BARN_OF_PREMIER)`**。registry
实际返回的是 ModuleData，派生对象不参与谷仓生产加载，但它仍被兼容消费方构造；
彻底不构造要等 5D 删除旧导出及 11 个消费方。

`ModuleDataRuntimeLoader.imported` 改为全部 host 操作成功后才写入。所有结构
预验证在 host 写入前完成；中途失败保留成功操作账本，重试只继续未完成操作，
不会重复 hooks/messages/items/scenes/clues。真实变异把 imported 写回旧位置，
失败后的第二次调用错误返回“已导入”，重试测试按预期变红。

`runtime.clueBindings` 的 10 条 legacy clues 已退出生产注册，但仍保留迁移
对账。逐条核对确认无独有事实：clue_0/1 在菲碧 knowledge/secrets，clue_2..9
在 rich Clue（部分结合 NPC knowledge）。rich 可匹配 id 不变；未发现列表移除
clue_0..9。唯一建议变化是特里坎家不再把 NPC 情报误报成“仔细搜查这里”，
改回“环顾四周”。

`narrative_noncombat` NPC 的 HP 仍为 0 存储占位，但 `state.npcs`/KP 状态现显式
包含它们；敌人选择继续按状态排除。状态接口、行动锚点、自然语言对话、战斗
排除分别有测试。MythosModuleLoader 构造已移入 Arkham/InnsMouth legacy
分支；加载谷仓时 `_moduleLoader` 保持 undefined。

### 步骤 5D：删除谷仓 Mythos 兼容表示（2026-09-08）

解析式 import 审计使用 `diagnostics/source-scan.ts` 的 `scanImports` 与
`findReverseImports`，实测旧薄适配的 11 个消费者是 custom registry、语音脚本、
语义矛盾 probe、fabrication guard、三方审计、legacy adapter fixture、结局一致性、
scene whitelist、representation consistency 与 unified projection 测试。全部迁到
`BARN_OF_PREMIER` 或直接退役后，`premiers_barn`、`unified-module`、
`representation-consistency` 均无反向 import。

谷仓 registry 现在直接登记 `BARN_OF_PREMIER`，不会在 import 时派生 MythosModule。
`scripts/gen-speech.ts` 直接读取 `runtime.introNarration`；semantic probe 只收统一
ModuleData 的叙事/runtime NPC；历史 `source:"premiers-barn"` fabrication records
保留标签但 resolver 检查统一 runtime NPC。三方审计只扫描唯一维护文件，结局检查
比较 `EndNarration`、display endings 与 `runtime.legacyEndings`，而不是比较同一投影
函数两端。Mythos scene whitelist 只保留 Arkham/InnsMouth。

删除 `MODULE_PREMIERS_BARN`、薄包装、`deriveMythosModule` 及投影/回投函数、旧
loader fixture、跨表示比较器，以及 `loaderSceneDescriptions`、`loaderExits`、
`clueBindings`。`runtime-npc-attachment.ts` 保留唯一仍需的 runtime snapshot 组装。
旧内容比对退役为 `barn-unification-sentinel.test.ts`：禁止旧 adapter/symbol/包装与三项
过渡字段复生，并验证 GameSession 谷仓路径不 import adapter。

真实变异逐项验证：registry 重引 wrapper 使两个 import 哨兵红；runtime 恢复
`loaderExits` 使字段哨兵红；删 rich Clue 注册使 direct loader 与自然语言 True End
回放红；fabrication resolver 指回已删除文件产生 ENOENT。还原后 typecheck 与全量测试
均绿。步骤 5 没有已定义的 5E 工作；Arkham/InnsMouth 的 ModuleData 迁移属于独立决策。

### 步骤 5E：单一数据源哨兵收尾（2026-09-09）

5D 已删除比较器和旧表示，5E 不重复删除。`barn-unification-sentinel.test.ts` 现明确
说明能力边界，并额外钉住 `PREMIERS_BARN_MODULE`、`deriveMythosModule` 等已退役符号、
registry 对 `BARN_OF_PREMIER` 的对象身份、谷仓加载不得构造 legacy loader，以及
`bridgeBarnOfPremierClues`/`barnSceneIdMap` 不得回流。通用 `MythosModuleLoader` import
本身不被禁止，因为 Arkham/InnsMouth 仍需要它；运行时测试分别确认谷仓不创建 loader、
两部 legacy 模组按需创建。

哨兵只覆盖已知文件、符号和静态路径，不能发现改名后的语义重复、外部仓库内容或动态
生成的第二份数据。四条历史 `source:"premiers-barn"` fabrication guard 仍保留来源标签，
但现在将统一 `ModuleNPC.runtime` 序列化成 guard-only 历史字段形状；这不是 MythosModule
投影，也不参与运行时。对艾德里安、流浪汉、Mi-Go 站位及绑架人数的统一数据变异均会红。

本轮发现并订正一条过早关闭的记录：谷仓表示与谷仓加载路径已收敛，`todo-19` 维持 done；
`todo-20` 仍必须 open，因为 Arkham/InnsMouth、CLI、ScriptedSession 的通用加载路径没有
统一。摄取 id 继承（todo-48）也未由谷仓场景 id 收敛解决。

### 编译闭环检查点 I：状态图必须采用执行语义，而不是边数启发式（2026-09-12）

本轮在纯 compiler 边界完成 hints → accepted interpretations → MechanicsIR →
closed-world 分析。旧 P4 的一些结论需要纠正：`unlockedConnectionIds` 以前只被写入，
并不构成门禁；ending rule 的机制 ID 被错误地覆盖到 `end_game.endingId`；而“有一条
changed edge”不能证明状态有终局恢复路径。修复不接 GameSession，也不把闭环结论扩写成
运行时已经使用的机制。

执行顺序现明确为：先按 priority 选择终局；若没有终局，执行所有相容的 automatic
transitions 至不再改变状态；最后才枚举一个可选玩家 discovery/traverse 动作。自动状态写
相互矛盾、或自动步骤回到同一闭包状态，均 fail-closed，绝不按数组或 ID 顺序选赢家。
因此 witness 与分析器共享一套顺序，不再分别描述“分析的状态”和“回放的状态”。

`connection_unlocked` 是显式受限谓词；没有该谓词的连接仍是普通连接。测试把 unlock
前、只有 `unlock_connection` 的变化、unlock 后三段分开，避免用 `set_state` 同时开门制造
假绿。发现某条 clue 后，所有同 clue 的 discovery method 都跳过成功、失败计数和副作用；
这补的是状态机语义，不是运行时 UI 的重复点击策略。

`maxFailures: N` 的现有口径保留为“先记录 N 次失败，第 N+1 次尝试执行 failback”。没有
failback 的 checked core method 现在叫 **policy risk**，而不是声称已构造了不可恢复状态。
只有可达状态图中没有任何终局路径才产生 deadlock witness；一个图上不可达的替代方法不能
掩盖可达 checked method 的无界失败风险，而有出口的玩家选择循环不会误报。产品模组不被
强制要求含 core clue。

本轮的变异红线实际改坏并还原了 ending ID 覆盖、unlock 门禁、发现后重试、空 topology
声明和异地点 engine-policy 替代。它们验证的是 compiler 的真实执行路径；不代表后续
artifact 保存或运行时接线已经完成。

### 编译闭环检查点 I 返工：恢复必须从失败态、证据必须从 heading scope（2026-09-12）

上条记录的“不可达替代不消除风险”还不够精确。实现曾把**全图任一曾可用**的同 clue
保底方法汇总为替代能力；于是入口的观察保底、或另一条互斥分支的保底，会错误替仍在单向
新地点的 checked core method 消除无界失败风险。正确问题不是“这个图上有没有成功路径”，
而是“该机制在这个状态失败后，能否不依赖另一条无界检定到达确定或有 failback 的发现方法”。
因此 policy risk 仍只是有界恢复的发布风险；检定成功后能终局并不能把失败分支叫作已证明的
deadlock。反过来，失败效果若实际开启了保底 availability，或失败态能走回保底，风险应消失。

另一处过早的简化是把 default observation 的 `targetId` 当作 location。target、clue 和
location 是不同语义域：默认位置必须由 marked item 到 heading 的 SourceFactGraph relation、
draft clue/scene 绑定、该 interpretation 的 source/evidence 与 module scope 共同验证。篡改
target 不会迁移位置；若 target 或来源无法与这一绑定相符，直接留在 `draft_only`。这也修正了
此前用克隆 interpretation 改 target 来证明“异地点默认政策”的弱测试：现在异地点正例来自
真实不同 heading 下的 marked item 及其自身证据。

witness 的“最短”也必须说明量纲：报告的每个 player action、兼容 automatic batch 和 ending
都算一步。普通 FIFO 的首次到达不是这个量纲的最短路径，尤其在先到分支带有自动链时。搜索按
报告步数传播更短 route；自动 batch 保存真实 IR mechanism IDs，回放从原始输入使用同一执行
语义逐步校验 mechanism、outcome 与状态 hash。将恢复逻辑重新退回全图汇总、将 witness 固定
在首次记录、或将 location 退回 target，定向反例都会变红；这才是检查点 I 仍待最终验收的证据。

### 编译闭环检查点 I：源码级闭合验证完成，等待交付（2026-09-12）

本条不改写前两条在当时的返工记录，只记录后续闭合结果。P4 closure trace、规范状态预算、
最短 witness、failure 因果与结果安全恢复固定点均已验证；default policy 在替代前完成
完整 audit，canonical graph subtree、heading/marked-item/name/body relation、review evidence 和
location provenance 均受证据约束；foreign/domain override 被隔离；脚本对 process/summary
不完整或失败结果 fail-closed。

上述防线都做过实际生产实现变异并精确恢复。最终八文件定向为 261 pass / 789 expect /
0 fail；全量为 3117 pass / 32 intentional skip / 0 fail，3149 tests / 215 files；typecheck
和 preflight 均退出 0。检查点 I 已于 2026-09-15 本地提交为 `bb42ef4`，待 GitHub
连接恢复后推送。artifact persistence、公开
compile entry、GameSession/runtime 和 world-model 接线仍为 deferred 里程碑。

### 编译闭环检查点 I：机制规则不能与剧情结局共用 ID（2026-09-15）

早期契约称 ending rule 的 mechanism ID 与 `end_game.endingId` 分离，但 parser 只检查
两个字段都存在且 effect 与 declaration 对齐，仍允许两者取同一个字符串。这会让规则节点、
witness mechanism 与玩家可见结局重回同一命名空间。现已在 ending hint parser 拒绝相等值；
删除该拒绝时负例立刻放行，恢复后全量为 3120 pass / 32 skip / 0 fail，3152 tests / 215 files。
这是 compiler 契约收紧，不代表运行时已经消费编译产物。

### 经济事件进入叙事：日志不是玩家可见性（2026-09-18）

PLAN §14.2 #4 的前提需要收窄：经济时钟、结算和 `world.logEvent()` 早已接通；真实断点是
`tickEconomy()` 过去只向玩家报告“发生 N 件大事”，把每条已结算事件的详情留在日志里。
现在它从同一批 `EconomyEvent[]` 同时写入 `[经济]` 日志并把原始 `description` 逐条投影为本
回合系统消息，不经 LLM 改写、补造或再次裁决。非经济 tick 回合不会重放历史日志。

这只闭合“已发生的经济事件可被玩家看见”的确定性接线；势力行为的内容来源，以及玩家行动
如何改变势力格局，仍未实现，不能被这层可见性误记为已完成。

### 身体状态：规则结果必须携带结构化执行语义（2026-09-18）

`CoCEngine.combatCheck()` 已经计算命中部位，却曾把“腹部暴击 → 无法行动一轮”及“头部暴击
→ 立即昏迷”压缩成 `details` 中的 `secondaryEffect`/描述文案；`GameSession` 因而只能叙述，
不能确定性阻断下一次玩家动作。正确的最小桥不是在会话层匹配中文关键词，而是由命中部位规则
本身显式给出 `statusEffect: "incapacitated"` 或 `statusEffect: "stunned"`，经既有
`RulesEngine` 结果写入实体唯一的 `status[]`，再复用状态库的 `cannot_act` 查询、tick 与动作门禁。

此接线只覆盖已有规则明确说出“无法行动一轮”或“立即昏迷”的两个结果。头部暴击文本中附带的
CON 死亡检定尚无确定性执行器：本轮没有伪造其通过、失败或死亡，仅复用既有 `stunned` 的一回合
行动门禁。其它 `secondaryEffect`（如致盲、击退、缴械、减速及 -20%）还没有等价的结构化规则
字段与执行器；不能把描述文本或关键词擅自升级为生理/行动规则。

### 会话元数据：单文件损坏不等于存储目录不可用（2026-09-19）

`listStoredSessions()` 的消费者是启动摘要和会话列表：其中一份 JSON 损坏不应让健康会话消失或
让服务器不能启动。恢复边界因此只包住每个已枚举文件的读取、JSON 解析和列表字段校验；坏文件被
跳过并用文件名告警。反之，创建或枚举 `data/sessions` 本身失败说明存储目录不可用，必须继续上抛，
不能伪装成“零个会话”。

旧动作仅更新 `lastActiveAt`/`round`/`scene` 的部分元数据仍是可识别的兼容输入，列表以
`unknown` 与时间 0 表示缺失字段；已存在但类型非法的 `createdAt`、`ruleset`、`playerName`、
`scene` 或 `bundleId` 则不被强制转换为可信摘要。此处只修损坏隔离，不建立过期清理策略。

### 玩家攻击也必须走同一条 CoC 裁决路径（2026-09-19）

`npcCounterAttack()` 早已经由 `RulesEngine.adjudicateAttack()` 消费 CoC 命中部位的结构化结果，
但玩家 `handleAttack()` 曾另行掷 d100、扣幸运和掷伤害。因此已有的“腹部暴击 → 一回合失能”在
NPC→玩家方向可执行，在玩家→NPC 方向却只是一笔 HP 变化。这里的修复不是把标准 CoC 攻击器
直接替换进去：标准路径会带入极难成功贯穿、随机部位、瞄准惩罚和不同的暴击伤害，改变既有玩家
命令的结果与 RNG 序列。

改由同一个 `RulesEngine` 执行具名 `game-session-legacy` 兼容配置，精确保留玩家旧口径：技能 50、
燃运、1~2 暴击、`floor(d12)+6` 暴击伤害，普通攻击不掷命中部位也不因旧的 `calledShot` 解析而
增加惩罚骰。只有已经明确指定的部位才作为现有命中部位规则的输入；其结构化 `statusEffect` 仍写入
实体唯一的 `status[]`。燃运不足的拒绝也保留旧路径先消费一枚 d100 的顺序。普通未指定部位攻击
不凭空加状态，死亡目标不会收到一回合状态。其余 `secondaryEffect` 与 CON 死亡检定仍没有足够的
结构化规则和执行器，不能由这条收敛接线推断为已完成。

### 头部暴击的 CON 后续检定必须区分 unknown（2026-09-19）

“头部暴击 → 立即昏迷（CON 检定失败即死亡）”现在由命中部位规则直接声明
`head-critical-con-death`，而不是从叙事文案或 `secondaryEffect` 回读关键词。`RulesEngine` 持有防御方
实体，故只在伤害后仍有 HP 时读取 `WorldEntity.attributes.constitution` 并调用一次既有
`CoCEngine.skillCheck()`；失败由 `GameSession` 的双向攻击路径使用既有 `killEntity()` 结算，成功才保留
已有的一回合 `stunned`。

角色卡的 CON 在创建玩家时原样投影到其战斗实体，模组运行时 NPC 也沿用其已写入的 attributes。任一方缺少或
不具可判定值的 CON 时，结果是结构化 `unresolved`：不掷骰、不致死，且明确报告仍只应用昏迷。伤害已使 HP 归零
同样不再加掷 CON，避免重复死亡判定。胸部等其它文字提到的检定仍没有这一结构化声明或执行器，不能顺带视为完成。

### 胸部贯穿的 CON 后续检定复用同一裁决与行动门禁（2026-09-19）

“贯穿胸部 → CON 检定或失去下一轮行动”是另一条已有明确语义的规则，不能继续只留在
`secondaryEffect` 文案中。命中部位规则现在直接声明
`chest-impale-con-incapacitation`；`RulesEngine` 与头部 follow-up 共用目标实体的 CON 读取、一次
`CoCEngine.skillCheck()`、伤害已致零不加掷及缺失属性返回 `unresolved` 的边界。会话层按这个
discriminated kind 消费结果：失败才向唯一 `status[]` 写入现有的一回合 `incapacitated`，随后仍由
既有 `cannot_act` 门禁阻断下一次输入；成功和 unresolved 都不伪造失能。

标准 CoC 的 NPC 反击可真实产生该极限胸部贯穿，故 E2E 覆盖其写入、阻断和到期恢复。玩家攻击的
`game-session-legacy` 兼容档有意不产生标准极限贯穿，不能为了对称测试而改变其既定骰序或伤害契约。
这不闭合其它部位的致盲、缴械、减速或 -20% 等描述：它们仍缺规则源已声明的等价结构与执行器。

### 急救必须从本回合的实体状态续算（2026-09-19）

`act()` 会先推进实体 `status[]` 的流血并扣除实体 HP；`handleFirstAid()` 若随后从角色卡缓存的
HP 治疗、且不写回实体，就会使 API/world state、下一回合流血与角色卡立刻分叉。急救现在以当前
玩家实体为存在性和 HP 的真相源：标准 `first_aid` 优先，旧卡才依次回退 `medicine`、中文急救和
30；成功时从 tick 后实体 HP 计算同一个封顶结果，写给实体与角色卡，并对实体唯一的 `status[]`
用 `parseStatus()` 精确移除所有 `bleeding`（含时限/层数格式）。其它结构化状态和不能识别的既有
裸标签原样保留。

失败和大失败不治疗也不止血；但这不撤销本回合已由实体结算的流血伤害：共享的
`tickStatusEffects()` 会把每个已登记角色的实体 HP 镜像回角色卡，故失败急救和随后任意普通行动都
不会留下 tick 前缓存。这个镜像不是治疗。大失败优先于数值比较，故 d100=100 即使卡上有 100% 也
不能成功。当前玩家实体不存在或形状不可用时，急救明确拒绝而不凭空创建第二份实体或只改缓存。
本次不为胸部暴击的“大出血”文案制定持续时间、额外伤害或治疗政策；这里只修既有普通 `bleeding`
的急救与既有状态 tick 的真相源闭环。

### 胸部暴击的大出血必须是独立状态，不是普通流血的别名（2026-09-19）

上项的“大出血尚未处理”是当时急救真相源小步的边界；胸部暴击文本本身已经明确“每轮额外失去
1d3 HP”，可安全闭合。`getHitLocationEffect()` 现在直接声明 `hemorrhaging`，由既有双向
`statusEffect → WorldEntity.status[]` 路径写入，绝不从描述或 `secondaryEffect` 回读关键词。
`STATUS_LIB` 将其定义为独立 physical 状态、`duration = -1`：规则文本没给自然到期，因而不伪造
三回合时限；成功急救沿已存在的“止血”语义一并移除它和普通 `bleeding`。

每个有效的大出血实例及其每一层都在 `tickStatusEffects()` 独立掷一次 1d3；这不能接成普通流血的
固定 1，也不能只掷一枚骰再乘层数。实体 HP 仍是唯一真相源，已登记角色卡继续镜像 tick 后结果。
这只覆盖胸部暴击的明确持续伤害；其它部位的致盲、缴械、减速及 -20% 描述仍没有对应结构化规则与
执行器。

### 腹部贯穿的 -20% 必须以行动者 tick 前状态统一消费（2026-09-19）

CoC 的“贯穿腹部：所有行动 -20% 减值持续 1d3 轮”此前只存在于命中部位的
`description`/`secondaryEffect`，不是实际裁决。最小闭环不是从这段文案回读关键词：
规则源显式声明 `abdominal_impaled` 和 `1d3` duration dice，`RulesEngine` 只在目标存活时
结算该骰，`GameSession` 仍只把结果写进目标实体唯一的 `status[]`。状态库持有该状态的
percentile target -20 语义，格式可以 round-trip。

时限状态在 `act()` 开始时会 tick，故主动行动必须读取**当前行动者 tick 前的 status 快照**：
这使 duration=1 最后一轮实际影响一次检定，之后自然恢复，而不是在判定前静默消失。多个
`abdominal_impaled` 实例取最强单一 -20，不能从重复条目推导无限叠加；不能解析的裸标签无效。
统一 helper 已用于普通技能、场景线索的普通/idea-override 检定、legacy 玩家攻击、急救、追逐
及可达的 regex 攻击旁路；force-success 是既有的无骰确定性 grant，保持不被降值伪装成检定。

范围是 GameSession 内玩家发起的百分目标检定，不包括被攻击后的 CON follow-up、SAN/目击和
成长等非主动判定。`/push` 目前没有生产路径写入 `_lastPushedRoll`，不能声称已覆盖。真实 NPC
→玩家腹部贯穿测试固定了规则源→RulesEngine→实体状态→目标 50 降至 30 的路径，并验证到期、
actor 隔离、未知标签与非叠加；删除结构化声明或令 helper 忽略 modifier 都会使相应 E2E 红。

### 状态 tick 的归零必须在同一回合截断意图（2026-09-19）

状态 tick 是实体 HP 的唯一结算；因此不能只在 `act()` 开头看旧的会话 `dead` 或角色卡缓存。行动
PC 已经为 0 时，在任何回合/状态/SAN/经济副作用前按该实体拒绝，避免倒下者反复推进全局时钟；若是
本回合 `tickStatusEffects()` 才把该 actor 从正数降到 0，则保留已经发生的 round 和伤害历史，再在
SAN 目击、经济 tick 与意图派发前读取同一实体并拒绝。

`dead` 不是这个门禁的替身：它是会话级终态，也被既有直接攻击死亡和模组离场复用。把一个 PC 的
状态伤害归零写进它会误封健康队友；门禁只读实际 `actingPcId` 路由后的实体。多 PC 路由也须在回合
副作用前完成，使状态、SAN 与响应 state 对应同一个 actor。复活、队伍全灭和其它身体状态语义仍不在
此处设计。

### 普通头部命中的下一次行动 -20% 是独立结构化状态（2026-09-19）

CoC 既有的普通头部命中（伤害至少 5）“下一次行动 -20%”此前只停在命中部位叙事文字。现在
`getHitLocationEffect()` 仅在该普通头部边界直接声明 `head_dazed`；`STATUS_LIB` 持有其固定一回合
及 percentile target -20 的语义。它沿既有 `CoCEngine → RulesEngine → GameSession → WorldEntity.status[]`
路径写入，不增加另一份存储、文本解析、额外 target modifier 或随机时限。

真实 NPC→玩家会话固定玩家未命中、NPC 普通成功、闪避失败、头部和 5 点伤害，证明状态以 duration=1
写入；行动者 tick 前快照让下一次 50% 技能检定以 30% 判定、d100=41 失败，随后同一技能恢复 50%
并成功。低于 5 点的头部、非头部、未命中与致死目标不写该状态；头部暴击保持已有 `stunned` 与 CON
死亡 follow-up，头部贯穿仍没有凭叙事发明的致盲/INT 执行。既有腹部贯穿测试继续守住多个 -20 状态只取
最强单项的规则。

实作变异删除这条普通头部的结构化声明后，focused suite 退出 1（1 pass / 2 fail）：规则源单测与真实
NPC E2E 都失去 `head_dazed`；还原后 focused head suite 3 pass / 0 fail，相关 head/abdomen/combat 集合
39 pass / 0 fail，typecheck 与完整 `bun test`（3257 pass / 32 skip / 0 fail）均恢复绿色。

### 夜间陷阱必须读共享时钟，不能把条件塞进叙事注释（2026-09-19）

谷仓外围的捕兽夹与霰弹枪原先在 `detect.penaltyDice: 1` 后写了“夜晚”注释；运行时只会无条件读取
这个数，因此白天也被罚。注释不是规则来源。最小的可消费数据契约是把既有 `penaltyDice` 明确保留为
无条件字段，另加 `nightPenaltyDice` 表示夜间**额外**骰；两个实际谷仓条目只迁后者，未为“条件”造
通用注册表。

`Cursor` 现在拥有 `newCursor()` 创建的 `GameTime`，CLI 模组主循环每轮显式调用一次既有
`advanceTime()`。陷阱只读取这个时钟，绝不从 `stepCounter` 推导时段。`game-time.ts` 导出的
`isNightPeriod()` 是唯一边界：`dusk/evening/night/late_night` 为夜间；GameSession 的过夜休息也改为
调用同一判定，避免两份字符串数组日后漂移。

判据走真实 `runSceneTraps → check()` 并捕获结构化 `check` 事件，固定随机而不读播报文本。它枚举八个
时段（四夜得额外 1、四昼得 0），同时保留旧无条件字段、缺失条件字段与两枚 CoC 惩罚骰上限。实际
生产变异把 `nightPenaltyDice` 无条件相加后，focused suite 退出 1（3 pass / 2 fail），白天的
`envPenalty` 从期望 0 变为 1；原补丁恢复后为 6 pass / 0 fail。闭合的是明确夜间规则到真实陷阱执行器的
这一条链，不等同于已经有了普适的时间压力或任意时段依赖机制。

### 经济因果 ID 必须穿过 SQLite 日志边界（2026-09-19）

`PoliticoEconomyEngine.advanceRound(causationId)` 已在引擎出口给同一次推进的所有 `EconomyEvent`
盖同一个 ID，并在重复投递时返回空数组、不会推进 round。本轮没有改变这份幂等契约；缺口是
`GameSession.tickEconomy()` 过去把事件改写为 `GameEvent` 时没有转交 ID，`event_log` 也没有列可保存它。

现在 `GameEvent.causationId` 是唯一的可选 TypeScript 字段，SQLite 对应唯一可空的 `causation_id`。新库
建表带列；打开旧库时用 `PRAGMA table_info(event_log)` 检查，只有缺列才原地 `ALTER TABLE ADD COLUMN`，
因此旧行不需要重建或删除。`logEvent()` 继续不把输入 timestamp 写进 INSERT，保留 SQLite 默认时间戳
的既有语义；`getRecentEvents()` 对有值事件逐字读回、对旧/普通空值事件省略属性，维持旧调用方形状。

判据包含真实旧 schema 文件迁移、直接日志 round-trip，以及真实 GameSession 的第十玩家回合：落库经济事件
共享 `eco:<session>:round:10`，而不是只在经济引擎内存账本中带 ID。实际删除 tick 的生产转交后，这个
E2E 立即以 2 pass / 1 fail 变红（读回 `undefined`），还原后为 3 pass / 0 fail。这只补经济事件到 SQLite
日志的因果链；不把它描述成通用派生事件模板、世界模型反馈闭环或完整推演引擎。

### 枚举输入在查表前必须封闭（2026-09-19）

`attributes.rank` 是运行时外部输入，不能因为 TypeScript 的 `as GrailRank` 就被当作五段位阶之一。
这里的正确边界是 `inferGrailRank()` 的单一闭合守卫：只接受 `bronze`、`iron`、`silver`、`gold` 与
`legendary`；其它字符串和非字符串同样回落到既有的名称/status 推断，最后才是 `bronze`。这既保留了
合法显式位阶的优先级，也不会为未声明位阶、兼容别名或新的数值规则开口。

这类值会立刻作为 `Map<GrailRank, RankConfig>` 的键进入真实攻击路径，故不能只断言 helper 返回值。
判据同时经过 `RulesEngine → GrailEngine.adjudicateAttack()`：无效的 `"platinum"` 配合“黄金”名称必须产生
完整裁决而非因缺少 rank config 崩溃。将生产代码临时改回“任意字符串 cast 为 GrailRank”会让该真实路径
和两条回落断言一起变红；恢复封闭守卫后再验证全绿。

### 编译会话中的模型只能分类当前可执行白名单（2026-09-19）

自然语言不是执行授权。compiled session 把本次、当前 generation 的 player-safe executable
action catalog 交给模型，模型至多返回其中一个 exact mechanism ID、多个明确歧义 ID，或 no-match。
catalog 是确定性执行核心当前可用动作的投影，不给模型线索、结局、证据或隐藏状态；模型不能凭输入
新增 ID、借标签猜 ID，或把历史 generation 的动作带回当前会话。

解析端必须只读且 generation-bound：调用前校验 `expectedGeneration`，模型返回后再校验 generation；
解析过程中不推进回合、不写 world/history/snapshot，也不持久化。无效 JSON、额外字段、白名单外 ID、重复
歧义项、超时或模型错误都明确失败；不以 regex、标签匹配或“第一项/默认动作”兜底。选择结果只是一条
可显示的分类，不能直接改变状态。

真正执行仍是既有的 structured action deterministic transaction：客户端带 exact mechanism ID、actionId
和 expected generation，经可用性校验、持久化/rehydration 与 shared mechanics core 完成。这样模型调用即使
出错、过期或被提示注入，也最多失去一次分类机会，不能绕过动作白名单、generation 并发控制或机制结算。

### 候选缺失不能让真实问题静默消失（2026-09-19）

编译 queue 的问题所有权来自 source clue，而不是来自后续语义候选是否仍完整。因此 item candidate
缺失或被篡改时，真实 clue 的 `core_clue` 与 `discovery_method` 问题仍必须生成；只有
`item_binding` 可以因缺少 graph-canonical candidate 而不生成。否则一个损坏的中间 draft 会通过
“少问一道题”缩小发布义务，得到比原来源更容易闭合的结果。

候选本身也不是可信 registry。resolve 必须从同一 graph 重新编译 deterministic template，并比较
完整 item candidate 集合：ID、scene、marked/name/body statement、display name、status 与 evidence
任何一项不一致都使结果保持 `draft_only`。artifact restore 再做完整 regeneration comparison；projection
则验证 heading scope、marked-item 父节点、name/body 子关系与精确 source quote。三层判据分别保护
问题完整性、编译身份和首次 runtime 写入边界，不能以某一层“通常会挡住”为由删除其它层。

运行时仍由 `MechanicsState.ownedItemIds` 持有物品所有权，投影只负责把已验证 ID 显示为来源中的名称。
这避免把 `ModuleData.items` 或玩家可见背包反向当作机制真相源，也使持久回放能够同时校验 mechanics
state 与 presentation view。初始红测确实得到 core_clue 期望 1、实际 0；修复后相关八文件 74 pass /
0 fail，完整回归 3390 tests / 247 files、3358 pass / 32 skip / 0 fail。

### 终局奖励必须只有一个授权入口，且恢复要重算角色链（2026-09-20）

来源表格行只是 reward candidate；逐行、带 evidence 的 `reward_binding` 才能把它
变成 MechanicsIR `reward_definition`。条件复用受限的现有 predicate AST，不能另造
奖励表达式，也不能开放任意 state/NPC 写入。当前 settlement 只接正向 SAN、固定
CM 与信誉；负向 SAN 会触发疯狂等既有规则副作用，技能成长也有独立检定语义，
两者在没有完整结算模型前必须明确拒绝。

奖励 catalog 是唯一授权。终局 effects 先产生稳定 terminal state，catalog 再按该
状态决定 reward IDs；旧的 `reward` effect 若继续被 validator 接受、执行器却过滤，
会形成“合法但无效”的 DSL，因此现已 fail closed，而不是保留第二条授予路径。
多条奖励的角色结算采用显式三相顺序：先统一增加 CM 并收紧 maximum/current SAN，
再做 SAN recovery，最后更新信誉；ID 排序只稳定同相审计记录，不决定不同字段之间
的语义先后。

持久化边界保存每代 action 前的完整 p1 character/SAN frame 和结构化 settlement。
恢复不信任最终角色快照：它从 generation-zero frame 沿真实 mechanics trace 逐代
重算 reward IDs、确定性骰值、CM/SAN/信誉和响应，再与 snapshot 对比；任何重哈希
后的 reward、roll、before/after、character 或 response 篡改都必须在首次 world
write 前拒绝。重复 actionId 返回同一持久结果，不能重新掷奖励骰。

### 编译 SAN 检定是 actor effect，回放必须重走实际分支（2026-09-20）

`sanity_check` 不是一个可在 `MechanicsState` 上静默应用的普通 effect，而是一次
CoC SAN 检定。它只有有界 `passLoss`/`failLoss`（fixed 或 dice）并只允许在实际
玩家动作的 discovery success/failure/failback、或 connection traverse 分支。自动
transition、ending 等上下文必须在 IR 验证时拒绝；纯 `applyMechanicsEffects` 如果
收到它也必须抛错。否则可达性、重放或新调用方很容易把需要 actor、骰子和疯狂语义
的 effect 当作 no-op，得到“验证过但没有执行”的第二种 DSL。

分支选择只能发生一次：共享 action executor 选中 outcome 后，连同 mechanism ID、
outcome、原始 effect index/path 和 source interpretation provenance 返回
`actorEffects`。GameSession 只结算这份结果，不能再从 IR 猜 success/failure 或按
压缩数组重编号。它用绑定 session、mechanics hash、动作前 state hash、generation、
mechanism/outcome/original index 和 draw index 的确定性随机流调用 `SanityEngine`；
因此 d100、loss dice、temporary/indefinite madness、bout 和本次真正新增的
phobia/mania 都可审计，且先于 terminal reward settlement。`applyLoss` 记录新增
症状必须看本次 push，而不能把已有数组最后一项误报为本轮 delta。

持久 ledger 只保存每项声明、实际 check/loss、madness delta、source identity 与
before/after sanity hash，不复制整份 state。恢复从 generation-zero character/SAN
frame 重放 trace 中的实际 `actorEffects`，重算每代 ledger、公开 SAN view（含
indefiniteLevel 与 manias）和最终 frame，然后才允许 world write；信任客户端或
持久 settlement 都会把篡改变成角色状态。编译期 actor-effect 上限和 snapshot 的
有界列表必须一致，避免一份合法 artifact 在持久边界才首次失败。

来源绑定也必须 fail closed：目前只有 human-reviewed、evidence-cited resolution
可声明 `sanity_check`，且 citation 要覆盖损失声明；model/audited proposals 与 legacy
hint versions 不能靠“同 scope 的任意 quote”获得这项权限。这里没有承诺自动从复杂
PDF/模型输出可靠抽取 SAN、没有开放 combat 或 skill growth，也没有把这一小段玩家
动作语义扩展为通用 SAN mutation API。

### Public automatic resolution: model proposals are never publication authority (2026-09-20)

The public automatic route begins after, not instead of, preparation. A caller
may name only a catalog-stored `preparedArtifactId`, its exact
`preparedQueueHash`, presentation metadata, and optional explicit hints. The
catalog replays artifact validation and the stale-hash comparison completes
before a model request. Detached artifacts and request-supplied LLM, policy,
producer, rounds, limits, or authority are not alternate trust channels.

The model is an untrusted proposal producer. The server owns its capability,
the `user_provided` policy, producer fingerprints, fixed proposal rounds, and
the per-round request cap. A cap is an absolute budget, not a best effort: each
unprocessed question receives a deterministic diagnostic and remains
unanswered. Invalid JSON, exceptions, malformed hints, corrupt catalog data,
and non-closed reachability stay fail-closed rather than being filled by a
default answer.

`draft_only` is a handoff state, never a publication state. It may expose
validated hints, rounds, readiness, unanswered questions, and sanitized
diagnostics for human continuation, but it must not invoke projection or
`saveBundle`. The only publication sequence is resolved artifact → successful
projection → durable bundle. Public diagnostics retain stable codes while
removing raw prompts, model responses, endpoints, keys, and model exception
text. The route is therefore a catalog-bound, bounded API slice—not acceptance
evidence for arbitrary PDFs, a real external model, or deployment-grade
authentication/rate/cost governance.

### Correction: automatic mechanics are not trusted presentation (2026-09-20)

The preceding historical handoff wording allowed a caller to provide
presentation and described automatic resolved output as projected and bundled.
That is a production trust-boundary error and is superseded. The public
automatic request is limited to `preparedArtifactId`, `preparedQueueHash`, and
optional explicit hints. Caller presentation, trust, limits, and detached
artifacts fail at the HTTP boundary before model invocation, projection, or
bundle storage.

Automatic proposals can close mechanics, but they do not establish player/Keeper
visibility for prose. Such a result is exactly `presentation_draft_only`:
mechanics readiness is `mechanically_closed`, presentation readiness is
`visibility_unresolved`, and there is no public artifact, graph, projection,
bundle ID, raw source/model text, audit citation, or exception message. Closed
accepted hints are retained only in a private catalog continuation with opaque
high-entropy ID and identity/hash binding to the prepared artifact. Manual
`/api/compiler/resolve` may consume that continuation together with validated
presentation and then repeats the existing full resolution checks before it may
project or save a bundle. Hints and a continuation are mutually exclusive.

Partial, malformed, and refused automatic outcomes issue no continuation: the
system has no resume API, so an opaque token must not be presented as a completed
human handoff. The continuation remains available until a successful manual
publication, allowing a projection or storage failure to be retried. This does
not claim trusted presentation binding, broad automatic compilation, arbitrary
PDF/real-model acceptance, or deployment authentication/rate/cost governance.

### Trusted player-visible presentation is a server capability record (2026-09-20)

MechanicsIR closure proves executable mechanics, not permission to show source
prose to players. The document graph currently has no deterministic
player-versus-Keeper visibility marker, so concatenating everything under a
heading can leak undiscovered clues, endings, or Keeper instructions into the
GameSession context. A public request body that labels its own presentation as
reviewed is not an authority either.

The minimal publication contract is now an immutable, catalog-private trusted
presentation review. It binds prepared/resolved artifact identities and hashes,
reviewer principal/time, and each rendered field to an exact statement quote,
evidence reference, and verified heading scope. The review carries no
reviewer-authored prose. Executable structure remains derived from
MechanicsIR/draft, including find methods, unlocks, importance, topology, and
ending identity. Every discovery method has its own source-map origin; a later
method cannot overwrite an earlier method's evidence.

Catalog reload, resolve, and bundle canonical replay revalidate the record at
successive boundaries. There is deliberately no public route to mint it. This
primitive still does not constitute deployment authentication: authenticated
principal injection, a review workbench, and player-versus-operator/Keeper
catalog and HTTP access separation remain open production requirements.

### 认证必须先于 body、catalog 与模型（2026-09-20，订正）

上段“没有公开 mint route”已被有认证的 operator workbench 边界取代，而不是把 mint 能力重新匿名公开。所有 compiler/catalog/compiled-session 创建路由先由 host authenticator 得到 principal，才允许读取 body、查询 catalog、调用模型或产生写入。身份不能来自 body、query 或 `X-Compiler-Role` 一类自报字段。operator 管理完整编译生命周期；Keeper 只读已发布 bundle，并且只能用 `bundleId` 建编译会话；player 无控制面权限。

默认部署适配器要求同时配置两枚不同的高熵 Bearer token。缺少任一项、格式非法、含逗号或两项相同均使控制面整体 503；结构正确但未认证是 401，已认证但越权是 403。认证器抛错或返回畸形对象也必须在读取请求体和 catalog 前 503，不能把 host integration 的运行时错误变成未捕获异常。环境 token 只是一种最小 capability，不代表完整账户、轮换或逐人审阅审计；普通 session 与 WebSocket 身份仍是独立未完成边界。

### 编译会话的自然语言必须先过只读分类边界（2026-09-20）

HTTP API 是浏览器与会话的边界，模型 API 是服务端分类器的下游；前端把自然
语言一律送普通 `/action`，不会自动变成“调用模型”。编译会话由非负
generation（包括 `0`）识别，先读取当前可执行 action catalog，再调用只读
`/compiled/intents`。只有返回 exact `selected` 才能带相同
expectedGeneration 和高熵 actionId 发第二次 `/compiled/actions`；歧义、无匹配
和模型不可用必须零执行。普通会话继续其原有 `/action` 路径。

分类与执行必须是两次请求：把 selected 偷塞进 `/action` 或令分类端写状态都会
绕过 durable transaction、generation 检查和 actionId 幂等。当前客户端没有把
actionId 持久化到响应丢失后的重试队列；此时应由 stale generation 拦截并刷新，
而不是假称未知请求已经可安全重放。这是待补的恢复体验，不是允许执行层降级的
理由。

### 自动续解必须重放既有验证，不得信任持久 token（2026-09-20，订正）

此前 partial 自动解析不发 continuation，是因为当时没有恢复入口；把这一临时
边界保留成永久限制会迫使长模组从头重复模型调用。现行做法只在出现新增且已验证
的问题答案时保存不可变 continuation，并把它同时绑定到 prepared catalog ID、
artifact hash、module/document/graph identity 与 prepared queue hash。恢复时先验
envelope，再用同一个 `validateModuleCompileHints` 对 catalog-restored graph/queue
重验 stored hints；只重签 continuation hash 不能让语义篡改进入模型 prompt。

恢复调用仍进入原有 bounded orchestrator，所以已回答问题自然从 open queue 中
消失，不需要另一套“已问列表”或第二解析器。无新增 validated answer 时返回原
token 且不写新文件；已闭合 token 重放时零模型调用。初始空回答、malformed、
refused 或模型异常不产生 token。closed continuation 只是 mechanics checkpoint，
仍须经 authenticated presentation review 与 manual resolve 才能发布 bundle；它
不扩大模型的 trust、presentation 或执行权限。

### 丢响应重试保存的是已授权请求，不是下一次意图（2026-09-20）

浏览器无法从网络错误推断服务端有没有提交动作。安全的恢复单元因此不是原始自然
语言，也不是重新调用 intent 分类器，而是**已由当前 catalog 授权**的完整结构化
请求：session、mechanism、pc、expected generation 和高熵 actionId。它必须在第一
次 POST 前写入受限 schema 的本地存储；只有收到明确成功的 JSON，或者确定不会重试
的拒绝，才允许删除。把 actionId 重新生成或在读取失败时提前清 pending，都会把“可能
已提交”的一次动作转换成新的交易，破坏服务端的幂等边界。

恢复时仍先读取 live compiled-action catalog。generation 前进、机制消失或 catalog
不再授权时，旧请求没有资格重放；浏览器应取得 authoritative session snapshot，用它
替换可见状态后再退役 pending。`compiled_unavailable` 也不能仅按 HTTP code 当作未
提交：若随后能读取权威 snapshot，先 reconcile；若不能读取，则保留 pending 以便以后
恢复，而不是猜测失败。这样客户端只是 durable transaction 的保守重试者，既不授予
机制权限，也不绕过 generation、server executor 或 actionId duplicate detection。

### 来源绑定 NPC 对话是发现方法，不是另一套 NPC 引擎（2026-09-20）

prose NPC 的可执行对话只能由 human-reviewed `npc_binding` 中的受限
`dialogueMethods` 声明。NPC ID 从 document、anchor 和 source-exact name quote 稳定
派生；method 的 `talk`、`npc` target、target ID 和 location 从该 binding 的
graph-verified heading scope 派生，调用方不能自报。每个 method 只可选择同 heading
的 canonical clue，并且成功分支必须精确 discover 该 clue。解释 provenance 只保留
NPC paragraph、anchor heading 与所选 clue 的 marked/name/body，不用整个候选集合冒充
证据。

这使对话复用既有 discovery/check/failure/failback、closed-world analysis 和共享
executor：同一 clue 被任一合法方法发现后，所有竞争方法都不可再用。IR 的 `talk` 与
NPC target 必须双向一致，`symbols.npcIds` 与 reviewed binding 集合完全相同；projection
在首次 world write 前再次验证 method、NPC、scene 和 evidence。GameSession 仅在该
投影 NPC 位于当前 mechanics scene 时显示 source-exact `Talk to <name>`。这没有开放
combat、NPC-state writes、移动、mood/relationship、generative chat 或新的执行 DSL；
durable 覆盖仅陈述已验证的同进程 replay/幂等，不把它写成 dialogue 专属 fresh-child
承诺。

### Source-bound compiled combat core is an execution foundation, not runtime combat (2026-09-20)

MechanicsIR now admits only a reviewed, provenance-bearing, bounded
single-enemy `encounter_definition`. Its encounter symbol must match the
definition exactly, and its scene, combatant, HP, percentages, NPC damage
declaration, victory effects, and player unarmed attack policy are all
structural, bounded data. The shared mechanics executor owns canonical
encounter HP and terminal loss: `start_encounter` initializes the definition's
HP once, an active encounter exposes only validated player-attack outcomes,
and a final enemy hit applies the definition's victory effects. Player defeat
is an explicit terminal loss, not an ending; snapshots and reachability replay
the same typed combat outcome and reject forged states or witnesses.

This is intentionally not a live combat feature. Source identification and
queue binding remain absent, as do projection/runtime package binding,
GameSession/RulesEngine settlement, and durable HTTP execution. `dodge`,
`fight`, and `npcDamage` are validated in the compiled definition but are not
yet consumed by a runtime rules path. No legacy GameSession attack connection,
random core execution, WorldEntity creation, or runtime combat promise follows
from this foundation.

### Source-bound victory effects and runtime claims must be checked at their real boundary (2026-09-20)

The preceding combat-core limitation is superseded for the bounded
single-enemy source-NPC path: reviewed same-heading encounter evidence now
reaches hostile-NPC projection, RulesEngine settlement, recorded action-local
entropy, and durable replay. This does not make trusted review a general effect
authority. Every `victoryEffects` entry in hints schema 1.8 must identify the
exact same-heading marked-item candidate, heading, source statement, and full
quote; the parser reconstructs the heading/marked/name/body relation and only
admits the matching `discover_clue` or `acquire_item`. Connection and state
effects have no graph-proven target relation and therefore fail closed. Schema
1.7 remains readable only for its pre-extension NPC dialogue and encounters
without a `victoryEffects` field; its old raw field is a schema mismatch, not a
best-effort conversion.

The method correction is to verify the actual authorization and execution path
before recording a bypass or an open boundary. `/character` did not bypass a
generation check: that check already existed, so the added evidence concerns
snapshot immutability and hydrate behavior rather than a fictional new gate.
Likewise, an opaque presentation origin must remain opaque when visibility is
unavailable; changing it to an artifact origin is a meaningful red mutation.
Evidence claims here therefore name the exact failed mutation and restored
regression, while keeping OCR, complex text-bearing PDF layouts, real-model
acceptance, content breadth, human visibility review, IdP/rate/cost operations,
and schema migration open.

### A production PDF intake must reject absent text before persistence (2026-09-20)

The source-bound compiler has a narrower, testable PDF intake guarantee: a
textless PDF does not continue as a prepared draft. Direct prepare returns
`PDF_TEXT_UNAVAILABLE`; the authenticated HTTP route reports 422; and both
paths leave the catalog unwritten. Disabling that real gate made both
regressions red, then restoration returned them green. This is not OCR support
or acceptance of arbitrary PDF layout: OCR, complex PDFs that do contain text,
and real-model end-to-end validation remain open and must not be described as
silent textless preparation.

### Authenticated trusted presentation review workbench (2026-09-20)

The new operator-only `POST /api/compiler/presentation-workbench` is a
read-only construction aid for the existing trusted presentation review. It
authenticates and authorizes before reading a body, consulting the catalog,
calling a model, or writing. Its strict request accepts only the catalog
prepared artifact ID/queue hash plus exactly one of hints or an opaque
continuation. It restores and canonically resolves that catalog state but does
not persist a review, bundle, or continuation and makes no model request.

Its versioned plan returns prepared/resolved identities and hashes plus stable
slots. A slot lists its allowed binding kinds and, only for an operator, the
exact source candidates with direct binding, statement/evidence/heading IDs,
text, and whole-statement or nonempty-substring quote policy. The public plan
does not expose its internal validation rules. Candidate construction and
`projectTrustedResolvedCompilerArtifact` share the same authoritative rule
plan, so a listed candidate cannot be broader than final validation:
connection/ending/find provenance comes only from accepted interpretations;
scene/clue/item/NPC fixed statement and heading scopes remain fixed;
module metadata is source-exact or opaque as allowed, while `triggerWarnings`
is opaque only.

The route began red at 21 pass / 1 fail. A real mutation that ignored allowed
statement IDs and admitted arbitrary same-heading connection prose made the
provenance test 0 pass / 1 fail; restoration returned green. Focused coverage
is 41 pass / 0 fail / 588 expectations, typecheck exits 0, and the
authoritative full run is 3470 tests in 256 files: 3438 pass / 32 intentional
skip / 0 fail, 19325 expectations. The remaining deliberate boundary is
response size: module-field candidates are not paginated and may grow with the
source graph.

### Paginating trusted presentation candidates without making cursors authority (2026-09-20)

The first workbench contract was safe about source provenance but unsafe about
response growth: putting every exact candidate and its whole source statement
inside every field slot makes a large module repeat the source graph at the
operator HTTP boundary. The correction is not to truncate text, discard later
candidates, or add a second presentation DSL. Schema 1.1 returns a compact
manifest of required field paths, allowed binding kinds, source candidate
counts, and a direct `opaque_unavailable` binding where allowed. A caller asks
for one explicit field page; the server owns the fixed size (eight), and every
page retains the full exact candidate text and quote with `hasMore`/opaque
`nextCursor` continuation.

The important implementation distinction is lazy materialization. Manifest
construction may count an eligible rule domain, but it does not build every
candidate binding or copy every source string. Only the requested field page
builds exact candidates. This bounds the fan-out response while preserving the
existing prepare body limit as the only document-size bound. It deliberately
does not create a silent per-candidate cap: a valid single source statement
can still be large and must remain exact until a separately specified limit is
designed and tested.

An opaque cursor is not a capability grant. Its base64url envelope is merely
structural/integrity continuity data and binds the workbench schema, resolved
artifact hash and complete identity, field path, page-aligned offset, and the
stable ordered candidate sequence. Authentication remains the operator
boundary. On every request the server restores the prepared catalog artifact,
canonically resolves it, and rebuilds the same authoritative rule contract
used by trusted projection before it serves a page. Thus a forged,
foreign, stale, tampered, unknown-field, or unknown-offset cursor fails
closed rather than expanding the candidate domain.

A real resolved fixture crossed the page boundary (twelve `module.title`
candidates at eight per page); merging all pages produced precisely the
authoritative ordered candidates with no omission or duplication. Continuation
and explicit-hints paths retained the same manifest, and the resulting
paginated bindings traveled through review minting, publication, and a real
compiled `GameSession` generation advance. The deliberate mutation that
ignored cursor offset kept returning the first page and made the regression
red (0 pass / 1 fail / 94 expectations); restoration returned green. Focused
projection/HTTP/access checks are 32 pass / 0 fail / 610 expectations,
typecheck is 0, and the root authoritative full run is 3470 tests across 256
files, 3438 pass / 32 intentional skip / 0 fail, 19395 expectations.

This is a response-size and review-construction improvement for large modules,
not a claim of player/Keeper visibility, a review UI, schema migration, OCR or
complex-PDF support, real-model acceptance, or complete identity/audit and
rate-cost operations.

### Slot pagination must be lazy before counting, not merely before rendering (2026-09-20)

Candidate pagination alone left an important boundedness gap: a compact slot
manifest could still materialize every rule and scan every eligible source
domain just to return the first response. Schema 1.2 makes the slot list itself
a server-owned fixed page of sixteen. The shared authoritative compiler
contract therefore produces ordered rules, not prebuilt manifest slots. The
slot-page boundary is applied to rules first; only rules in that page calculate
`sourceCandidateCount`. Exact-source candidate construction remains still
narrower: it materializes one selected field page of eight candidates.

The two pagination domains are intentionally different protocol modes. An
explicit field path requests candidate paging; absent field path requests slot
paging. Their opaque cursors have distinct kinds, and each cursor binds the
schema, canonical resolved artifact hash and full identity, its page-aligned
offset, and the complete stable ordering hash for its own domain. A cursor is
only integrity/continuity material: it cannot select a field, authorise a
different artifact, or become a substitute for the operator check that runs
before body and catalog access. Structural defects, stale or foreign identity,
order changes, kind exchange, and unknown offsets all fail closed.

The right end-to-end regression is not merely a page-size assertion. A real
fixture must cross a slot boundary, merge the HTTP pages into the authoritative
rule field-path order without duplicates or omissions, then use every returned
slot to complete the existing binding, review mint, resolve/publication, and
real `GameSession` execution path. Mutating the production slot offset back to
zero makes that merge fail; this distinguishes a real cursor-continuity guard
from a test that only accepts a plausible first page. The result bounds both
manifest and candidate fan-out without silently truncating a valid source
statement or widening presentation visibility.

### Durable compiled-session access is creator-bound, not ID-bound (2026-09-20)

A high-entropy session ID is only defense in depth; it cannot authorize a
durable compiled runtime. At authenticated compiled-session creation the server
therefore writes a strict, versioned `CompiledSessionAccessBinding` containing
only the owner role and a SHA-256 fingerprint over that role plus the normalized
host principal ID. It does not serialize raw principals, tokens, or headers.
Snapshot schema 2.8 carries that binding through canonical hash, replay, restore,
hydrate, and every successor generation. A missing, malformed, or unavailable
binding is unavailable rather than legacy-authorized.

The owner check must precede parsing a body, invoking a model, executing an
action, or writing a snapshot on every compiled `/api/sessions/:id/**` route.
It also applies to generic runtime reads, not only compiled-action endpoints.
Session listing filters compiled rows for anonymous and foreign callers. A
diagnostic-only durable ID must be indistinguishable from an unknown ID on the
ordinary HTTP lookup; diagnostics are not an anonymous availability oracle.

Compiled WebSocket must fail closed while no authenticated protocol exists.
Checking only the live registry is insufficient: cleanup can evict a compiled
session while a durable, incomplete, or corrupt snapshot remains, and failed
hydrate can leave a diagnostic. The refusal authority therefore includes live
compiled sessions, snapshot-store occupancy, and diagnostics. Legacy and truly
unknown session IDs keep their prior behavior.

The test lesson is equally narrow. A test that assigns a global RNG replacement
across `await` corrupts unrelated concurrent test construction and is itself a
race. The controlled NaN mutation now exists only inside one synchronous fixture
constructor callback with `finally` restoration; reverting that construction
makes the durable character-state regression red, and restoring it returns
green. This establishes fixture isolation without relaxing the production
snapshot validator.

The default Bearer-token mapping is a shared deployment capability, not a
per-human IdP. The snapshot hash is integrity validation rather than a MAC and
depends on storage ACLs. The in-process `access: null` seam is not an HTTP
bypass and receives 503 at the server boundary; an authenticated
compiled-WebSocket protocol remains explicitly open.

### Compiled P1 player facade is a separate, narrow access projection (2026-09-20)

Snapshot schema 2.9/access 2.0 retains creator ownership while allowing a host
to resolve exactly one trusted player principal for `p1` at compiled-session
creation. Resolution is creator-time trust, not a client assertion. If it is
missing or invalid, access remains owner-only. The supplied environment Bearer
adapter cannot create a player principal, so a deployment that wants player
access must inject a resolver/authenticator. The access material is carried and
fail-closed through canonical hash, replay, restore, hydrate, and successor
generations.

That principal has exactly two compiled runtime capabilities: read
`GET /api/sessions/:id/player-view` and execute
`POST /api/sessions/:id/player-actions`. The view presents safe check and
archetype data and can drive actual compiled combat without exposing raw
`library_use`, archetype internals, or `mechanismId`. Action choices are opaque,
generation-bound HMAC values; a forged, stale, or replayed value is rejected.
The existing runtime routes remain owner-only, and compiled WebSocket remains
refused rather than becoming an accidental second player protocol.

This is intentionally a single-`p1`, REST/polling façade with generic labels.
It does not provide an IdP, invitation/assignment workflow, credential rotation,
per-person audit, multi-player roles, or an authenticated WebSocket protocol.
The final focused suite is 45 pass / 0 fail / 911 expectations; mutations that
revealed raw check `library_use`, investigator archetype data, `mechanismId`, an
arbitrary player role, or a mismatched successor access binding each made the
corresponding regression red before restoration. The authoritative repository
run is 3482 tests / 258 files, 3450 pass / 32 skip / 0 fail, 19684 expectations;
`bun run typecheck` exits 0.

### Global monkeypatches restore in try/finally; cross-await tests stay serial (2026-09-20)

The current non-concurrent compiled lifecycle fixture temporarily replaces the
global RNG with withMockedRandom and must restore it in try/finally on both
success and callback throw paths. The meaningful negative test is exception
recovery: mutating that restoration made the dedicated lifecycle regression red
at 0 pass / 1 fail, then returned green after restoration. The lifecycle suite
is 24 pass / 0 fail / 587 reported expectations and the isolated fixture smoke
is 1 pass.

This helper is not a concurrency coordinator. A global monkeypatch held across
an await must be used only by serialized tests; interleaving callers can still
restore out of order. Concurrent coverage requires a different design—RNG
dependency injection, a real lock, or AsyncLocal-style isolation—not a claim
that the current helper shares state. The subsequent authoritative full run is
3483 tests / 258 files, 3451 pass / 32 skip / 0 fail, 19662 reported
expectations; typecheck exits 0. Expectations are deliberately not a stable
baseline here, so tests/files/pass/skip—not the expect count—are the regression
baseline.

### Player delivery must separate local controls from deployment acceptance (2026-09-23)

This player-browser slice is evidence for specific boundaries, not a shortcut
to a production-complete label. Digest-only invitation storage, CSPRNG IDs,
session-bound `__Host-` cookies, one-claim idempotence, 8 KiB cumulative body
accounting, no-store/no-CORS responses, and a sealed PlayerApp dependency path
are each local, testable controls. The origin rule is intentionally explicit:
only HTTPS `COMPILER_PUBLIC_ORIGIN` is authority, never a forwarded header.

Mutation evidence must identify the seam and its observed failure. Disabling
the 8 KiB accumulator changed an unknown-length oversized claim from expected
413 to received 400; restoring backend `req.url` origin changed the TLS-proxy
positive case from expected 204 to received 404; re-importing `api.js` made the
sealed source check identify that forbidden file. Each was restored before the
final green run. These are stronger than an undirected coverage count because
they show the intended test is connected to the production control.

The durable file sequence is only safe under its stated single-active-writer
assumption. `fsync`, hard-link no-clobber, and directory fsync make a local
claim durable; they do not elect a writer or coordinate replicas. Likewise,
Compose defaults and a strict public-origin rule do not replace a real Docker
TLS-proxy exercise. IdP, credential rotation, per-person audit, rate/cost
operations, multi-player roles, and authenticated WebSocket design remain
separate production work.

## Reviewed state-gated player narrative (2026-09-23)

Player narrative is trusted state projection, not a rendering of caller input.
Facade schema 1.1 may reveal only durable canonical-projection state gated by a
trusted `presentationReview`: the current scene, already discovered clues, and
the selected ending. No review means no player narrative. IDs, source evidence,
NPC details, and mechanics remain outside that surface, and untrusted caller
metadata never becomes player-visible text.

The compiled intent API is also a distinct fail-closed contract: it reads the
current executable allowlist and returns a structured selected/ambiguous/no-match
result before any compiled action can run. It is not a generic natural-language
or regex fallback. A generic session may retain its separate ordinary input
path, but a compiled session must not silently downgrade an unmatched intent to
that path or invent player text from it.

## Model-only player intent classification and opaque retry (2026-09-23)

The player facade may accept natural language only as a model classification
request. It must remain authenticated by the player cookie, same-origin check,
and trusted resolver; apply the strict body limit and no-store response; and
return no action execution as a side effect. Missing model support, invalid
input, ambiguous input, and no match are all explicit safe outcomes—not a
permission for a regex or ordinary-command fallback.

Because classification can await, selection must reread the authoritative
registry and compare the generation and internal catalog before exposing a
choice. The public result is an opaque current choice only: no mechanism ID,
command, or internal state. Once selected, the existing player-actions path owns
durability: persist and retry its same actionId, refresh after 409, and show
friendly 422/503 errors. This separates model interpretation from deterministic
action execution and prevents the UI from minting a new retry identity.

### Direct-load restore must be atomic, and fixtures must not borrow production state (2026-09-23)

Compiled projection direct load/restore now validates and constructs the next
state before installing it. A rejected restore therefore leaves the already
usable instance usable, and that same instance can retry after failure. Treating
"throw on bad input" as sufficient was too weak: a partially installed failed
restore can turn a recoverable bad request into a poisoned runtime.

The lifecycle fixture no longer imports setup from a `.test` module; the shared
helper has an ordinary test-helper boundary. Focused player-intent verification
was also corrected from a broad 28-test aggregate to the four tests that own
that behavior. Catalog rebinding retained all assertions while its focused run
fell from about 4.53 s to about 0.98 s. The lesson is to measure the targeted
contract, not a convenient transitive test set, and to remove setup coupling
without relaxing assertions.

Career tests now set a temporary `__CAREER_DIR`. The approximately 245112
historical directories already under `data/careers` remain untouched: isolation
means redirecting test writes, not deleting operator history to make a test
appear clean. Automatic-orchestrator tests likewise synchronize their fixture
shape with the current contract before claiming a regression exercises it.

When a real prepared artifact is rejected for an old schema, a synthetic
one-to-one contract is useful regression evidence but is not a real-source
rerun. The present Fuzu prepared artifact is graph schema 1.0 and the current
validator rejects it; its retained read-only history (77 questions, 22 generic)
must remain labeled historical. Timeouts and fast focused runs help locate the
seam, but do not upgrade old artifact compatibility or real-PDF acceptance.

### Correction: real source quality aggregates do not claim runtime breadth (2026-09-23)

The preceding old-schema Fuzu statement is retained solely as historical
correction context. The real 16-page Fuzu PDF with SHA-256
a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5
has now completed the read-to-compile-to-runtime evidence path: 22 scenes, 3
clues, 3 items, 32 NPC anchors, 72 reward candidates, and 192/192 answered
queue entries.

Its narrow mechanics path is mechanically closed: 4 playable scenes, 3
connections, 3 discovery methods, 2 reachable endings, and zero reports in
each of the four closed-world issue categories. Both witnesses replay, artifact
restore preserves the canonical hash, and separate GameSession executions reach
lost_without_dream_stone and escape_with_dream_stone.

The returned aggregate quality is 130 roots: 22 mechanics_evidence, 0
accepted_binding, 108 explicitly_unbound, and 0 open/unmodeled. Coverage is
scenes 22→4, clues 3→3, items 3→0, NPC anchors 32→0, rewards 72→0, and endings
2→2. This makes the difference explicit: mechanical closure has been
demonstrated, while broad content has not.

The operator workbench and final resolve return this aggregate only. It is not
a readiness result or gate and returns no IDs, prose, evidence, or witnesses.
todo-64 remains open. Complete preflight is green: 3533 tests / 266 files,
3501 pass / 32 skip / 0 fail; typecheck is 0; unwired is 82; and
core.hooksPath passes. The DeepSeek-only llmEnabled omission was red-tested and
fixed; this verification made no external model call.

The source-disposition regression also exercised the production boundary:
temporarily returning itemCandidates from boundItems made
compiler-source-fact-disposition exit 1 at 5 pass / 1 fail (expected 0,
received 1). Exact restoration returned exit 0 at 6 pass / 0 fail / 76
assertions, with no mutation residue.

### Ordinary GameSession intent LLM selection is session-bound (2026-09-23)

A process-global model client cannot correctly represent multiple ordinary
GameSession configurations. GameSession now fixes its own LLMClient or null at
construction and uses parseIntentWithLLM; the CLI and global parseIntent retain
their compatibility path. declareIntentPath reports the session client rather
than an incidental process-global client, and the existing DeepSeek environment
gate remains covered.

The regression began red against the old implementation: two new tests exited
1 at 0 pass / 2 fail because the second session called the first session's
endpoint, and a newly disabled session still fetched after an enabled session
had run. Reverting production act to global parseIntent exited 1 at 1 pass / 1
fail; restoration returned 2/2. The initial complete run correctly exposed a
separate stale look-gate fixture: 3535 tests / 267 files, 3502 pass / 32 skip /
1 fail, because that fixture still relied on a global fake.

The fixture correction is part of the method, not cleanup. Every look-gate
fake now injects through the session-bound helper and gives the global client
contradictory help. A helper mutation that set only the global client then
failed at 7 pass / 1 fail; restoration returned the focused suite to 14/14.
Root independently observed 25 pass / 5 files / 0 fail for the focused slice
and 143 pass / 9 files / 0 fail for the intent set. The final full run is 3535
tests / 267 files, 3503 pass / 32 intentional skip / 0 fail / 20311
expectations in 73.73 seconds; typecheck exits 0. No external model or network
call occurred: fetch was intercepted.

Compiled intent remains its allowlist-classification API; this change makes
ordinary GameSession intent interpretation session-bound. It does not make the
product production-complete. Narrator/player-agent global first-wins behavior
and the LLMClient static breaker remain distinct production risks that need
their own multi-session design and evidence.

### Run-bound generative context and endpoint-scoped breakers (2026-09-23)

The preceding final sentence was true before the follow-up runtime increment;
it is not the current risk statement. A generative client belongs to the
smallest execution boundary that owns the work. GameSession now holds its own
client-or-null for narration and never writes narrator/player global state.
PlayerAgent uses an injected instance client when one is supplied; explicit
`null` means offline, while `undefined` preserves the legacy global fallback.
Each play-module invocation creates one RunOptions/RunContext client and shares
it across background, prologue, NPC, player, and combat narration. This makes
one run internally coherent without allowing one run or session to configure
another. The ordinary config-loading route, including DeepSeek-only settings,
remains the default; explicit null is a stronger offline boundary.

Breaker state has the same ownership principle at a different level: it is
shared only by work targeting the same normalized endpoint base URL. API keys
are excluded from the identity, and chat/chatStream share that endpoint state.
Half-open recovery is single-flight. A successful request or explicit reset
clears the endpoint state; timeout, non-2xx HTTP, and empty-response paths all
release the half-open probe. A breaker must never trade a transient failure for
a permanently occupied recovery slot.

The regression method deliberately used contradictory state. Before repair, a
disabled session still made two fetches after an enabled one, PlayerAgent read
`GLOBAL` instead of its injected client, GameSession contaminated narrator
global state, and five old process-global-breaker counterexamples failed.
Restoring global narration made the second-session regression exit 1;
discarding the PlayerAgent instance client made its explicit-client regression
exit 1; removing the half-open probe guard or forcing one global endpoint key
made their breaker regressions red. Exact restoration returned the runtime
five-file slice to 47 pass / 0 fail / 148 expectations, the breaker slice to
14/14 / 47 expectations, and the related LLM breaker coverage to 24/24. The
root merged directed run was 110 tests in 12 files / 0 fail / 300 expectations,
with typecheck exit 0. Fetch was intercepted or addressed to local 127.0.0.1;
none of this is evidence of an external-model acceptance run.

The isolation and breaker boundaries are no longer the open production risks
described by the earlier paragraph. They also do not make the product complete:
content breadth, real complex-PDF and real-model validation, IdP, rate/cost
operations, multi-writer coordination, and the remaining deployment and
identity work stay open.

### Process-local automatic-compiler admission needs an ownership proof (2026-09-23)

Single-request proposal limits do not govern a burst of otherwise valid HTTP
requests. The admission seam must therefore sit after authentication, body
shape, capability, catalog, queue-hash, and continuation validation, but before
the first LLMLike call: invalid traffic must not spend a start, while the lease
must still cover orchestration, continuation saving, and response construction.
The controller stores only a principal fingerprint and an artifact-resource
hash. Its explicit process-local bounds are global=2, per-principal=1, four
starts per 60-second sliding window, one active lease per prepared artifact,
and at most 1024 tracked principals. It fails closed when full and releases
idempotently in finally.

The important regression evidence is not only direct controller coverage. A
real handleRequest test leaves admission uninjected, holds one deferred fake
LLM request for a principal, and sends a second different-artifact request with
an immediate fake. The second model has zero calls and receives 429 only if the
server module owns one controller across handleRequest calls. Replacing that
default with a new controller per configuredAutoCompiler call changed the
expected 429 into received 200; exact restoration returned green. Removing the
artifact lease or the per-principal gate separately made their target tests
wrongly acquire a lease. This proves the controls are connected, rather than
merely checking an error string.

The root-authoritative directed run was 44 tests across 5 files, 0 failures,
and 733 expectations; typecheck exited 0. The authoritative full run was 3561
tests across 270 files, 3529 pass, 32 intentional skip, 0 fail, and 20399
expectations in 134.15 seconds. A sandbox parent that cannot spawn bun reports
uv_spawn EPERM before the child runs; the authorized environment ran the same
command successfully. This record is deliberately not a distributed-lock,
rate/cost-budget, IdP, multi-writer, real-model, or production-completion
claim.

### Final acceptance: preflight must reject an unconnected public seam (2026-09-23)

The final preflight initially exited 1 for one precise reason: exposing
`CompilerAutoAdmissionController.cleanup()` without a caller increased the
unwired count from 82 to 83. That is not a reason to raise the baseline. The
controller already cleans expired principal state lazily at acquire time, so
the public method was an unnecessary surface rather than a missing operation.
Deleting it retained the actual behavior and restored the focused admission
run to 9 tests in 2 files, 0 failures, and 47 expectations; typecheck exited 0
and probe-unwired returned 82.

The final authorized preflight then exited 0 with 200 boolean implementations,
zero discarded returns, passing documentation checks and typecheck, the
3561/270/3529/32 test baseline, unwired=82, and core.hooksPath=.githooks. The
lesson is that a production hardening feature needs both runtime ownership
evidence and a minimal public API: do not preserve speculative maintenance
methods merely to avoid deleting code, and do not hide their absence of use by
loosening a repository-wide baseline.

### Aggregate acceptance must preserve source-generated breadth (2026-09-23)

An end-to-end compiler acceptance should begin with one source and retain every
candidate and question that source actually generated. A curated synthetic
source here produced six scene candidates, two marked clues, two item
candidates, five prose-NPC anchors, three heading-scoped reward candidates,
and 33 questions. The test answered all 33 through current-schema human hints;
it did not hand-build a graph, draft, IR, or downstream execution input.

The useful assertion is two-sided. It proves positive bindings reach runtime
(four playable scenes, two clues, one item, one NPC dialogue, one reward, and
one reachable ending), while non-target candidates remain explicit decisions:
source-only item and reward null bindings and empty NPC bindings. The source
disposition therefore has complete readiness and zero open, open-root, and
unmodeled counts, while retaining both accepted-binding and explicitly-unbound
roots. Deleting fixture facts to avoid questions would not establish that
contract.

Mutation evidence must target the code that actually executes. Skipping
`acquire_item` made the real discovery leave `ownedItemIds` empty; suppressing
the source-bound terminal reward-catalog write removed reward settlements.
Both made the aggregate test fail and were restored. In contrast, mutating the
legacy `reward` effect did not fail it because that effect is not the current
runtime path; that negative result is evidence to redirect the mutation, not a
reason to claim red-first coverage. This is curated synthetic structure plus
human-review evidence, not arbitrary-PDF or automatic-model content coverage.

A saved output that cannot restore under the current schema is historical
context, not current acceptance evidence. It must not be replayed as though it
were current, and its graph cannot be reconstructed and presented as the
original PDF; without the source, same-source preparation is unavailable.

### Automatic aggregate acceptance must retain both the bounded model seam and the public boundary (2026-09-23)

An automatic aggregate test needs the same source-derived discipline as a
human-review test: call `prepareCompiler`, read the actual draft and queue IDs,
and let the production adapter/orchestrator validate every answer. A FakeLLM is
appropriate when it is deterministic and proposes only against the request
envelope; it is not permission to hand-build a graph, draft, IR, or fabricated
later-stage input. Chunked envelopes are intentionally narrower than the full
candidate catalog, so a fixture responder must retain only IDs dynamically
read from the same prepared artifact, not assume every chunk contains every
candidate.

Bounded automatic work may naturally require more than one round. Here the
first production-capped round answers the non-NPC questions; the static NPC
becomes eligible only after its source heading has an accepted playable role.
The next round must ask it without re-asking the accepted set, and replaying a
closed continuation must make zero model calls. Static NPC automation must
remain static (`dialogueMethods: []`): NPC dialogue/encounter, SAN mechanics,
and presentation are not gaps a model test may silently fill.

Mechanical closure is not public publication. The canonical result can prove
runtime item/NPC/reward/ending breadth privately while the HTTP result remains
`presentation_draft_only` and `visibility_unresolved`, with no projection or
bundle write. Test both halves: use source and raw-reply sentinels to establish
that prose and raw output do not escape, and mutate the response to expose
private hints so the test demonstrably fails. Mutate the production item and
reward seams too; a failing test that only changes the FakeLLM is evidence of a
fixture contract, not of runtime enforcement.

This method is a bounded deterministic acceptance, not arbitrary-PDF or
real-model acceptance. A current-schema-restorable original source is still
required for the latter; an old artifact or reconstructed graph cannot replace
it.

### Historical exact-source acceptance snapshot (2026-09-24; superseded)

The earlier observation that a saved artifact refused current restore did not
prove that the original source could never be replayed. Once the exact Fuzu PDF
was found, the correct procedure was to hash and size-check the original bytes,
use the authenticated public prepare route, and restore the new current artifact.
The old output still correctly refuses with
`ARTIFACT_COMPONENT_VERSION_MISMATCH`; that refusal is not a schema migration
request, and the one-time strict rebind of historical human answers to unique
current questions is acceptance re-review, never an artifact migrator or
production fallback.

Mechanical closure and content readiness are separate claims. The bounded Fuzu
paths replay and run, while 50 answered versus 142 open current questions stays
content-incomplete and its items/NPC/rewards remain unbound. Preserve both
facts instead of promoting a terminal witness into a content-completeness
claim.

Body limits also need endpoint-specific ownership: preserve the compatible
1 MiB JSON/general cap, but allow only authenticated compiler PDF prepare an
8 MiB server-owned cap. Reject both declared and streamed oversized PDFs before
compiler or catalog work. Finally, a test mock that alters a module at Bun
process scope can invalidate unrelated suite evidence; prefer a real route and
stream boundary when it proves the same pre-compile rejection. The initial
roughly 100 suite failures from that mock were test-isolation failure, not a
production regression.

### Historical automatic-continuation snapshot (2026-09-24; superseded)

An acceptance that calls an HTTP route more than once must model its ownership
boundary, not merely its return values. The exact Fuzu continuation acceptance
constructs one HTTP dependency object and one process-local admission
controller for its entire run; all three bounded continuation requests reuse
them. A construction-count plus object-identity assertion is deliberately
stronger than a sequential green result, because sequential requests would
otherwise hide a fresh controller on every call. Reintroducing that old wiring
made the script fail with `expected 1, received 3`; restoring shared ownership
returned it to green.

Eligibility also has a meaningful distinction between “do not ask” and “ask
only for an explicit absence.” A prose NPC anchor without an answered valid
scene role remains ineligible. An answered playable heading can offer the
existing static-or-empty contract. An answered non-playable heading must still
be asked so its source fact is disposed, but it may only accept
`presentNpcs: []`; the accepted-proposal boundary, not prompt wording alone,
rejects a positive binding with `npc_binding_requires_playable_scene`.
This closed 27 otherwise permanent Fuzu open questions without opening NPC
dialogue, encounter, SAN, or presentation to automatic work.

Public-boundary leak assertions should test all meaningful private material
that is available to the acceptance, not one convenient phrase. The Fuzu
script derives every trimmed prepared-graph source statement at or above a
modest length threshold and recursively checks every public response string;
the threshold prevents a short generic public label from becoming a false
positive. It also checks raw model reply and keeps opaque continuation values
out of stdout. The final 192/192 source disposition is therefore content
complete, but it remains a narrow 22→4 scene / 3→0 item / 32→0 NPC-anchor /
72→0 reward result. Complete disposition is not content breadth, publication,
arbitrary-PDF acceptance, real-model acceptance, or production completion.

### Correction: table rows are source roots unless a supported reward is proven (2026-09-24)

The historical Fuzu count of 72 reward candidates was a defect in candidate
admission, not evidence for 72 rewards. Reward admission is now source-derived
and fail-closed: only a heading-scoped row with explicit positive settlement
semantics in the implemented SAN recovery, fixed Cthulhu Mythos, or fixed
reputation domain can request the pre-existing `reward_binding` review. Stats,
HP, attacks, loss wording, percent or slash-mixed values, arbitrary table rows,
and rows without scope remain non-rewards.

An eligible row is deliberately not also a source disposition. Every other
table row is a normal `source_fact_disposition` root, and the model contract,
shared parser, audit and report accept that exact `table_row` subject. The exact
Fuzu preparation therefore has zero reward candidates and zero runtime rewards;
its 72 table rows are disposition roots, the queue remains 192, and automatic
continuation remains three requests and 47 deterministic FakeLLM calls. This is
source/type audit precision only: it neither increases content breadth nor
claims lower model cost, real-model readiness, automatic publication, or a
production-complete compiler.

### Reward predicate candidates must be a queue-owned, typed domain (2026-09-24)

The reward parser was correctly small, but the proposal request was not
answerable: it named only the `reward_binding` subject and no valid IDs for a
`scene_visited`, `clue_found`, or `item_owned` condition. Queue schema 1.9 now
stores `allowedRewardPredicateIds` as stable same-draft `{ scene, clue, item }`
lists. Request-envelope schema 1.2 exports those exact lists, includes their
trusted typed catalog rows, and keeps them during proposal chunking.

This is not a second predicate implementation. The shared parser first asks
MechanicsIR to parse and reject unsupported reward predicate syntax, then walks
the returned supported reward AST recursively. Every leaf below `all`, `any`,
or `not` must belong to the queue's matching scene/clue/item domain. The caller
supplies only an untrusted value; the accepted IDs come from the prepared queue.
Forged and cross-domain IDs now fail at parser/grounded-proposal boundaries,
before later MechanicsIR compilation. `declaration: null` returns before that
target lookup and continues to represent a source-only reward row.

The model contract names the domain rule and the previously omitted
`item_binding`/`reward_binding` citation keys without adding a second prompt
message. An envelope-only FakeLLM produces a positive cited reward answer from
the actual request/catalog and reaches the shared audit. Removing the parser
domain walk made the target test set red (14 pass / 1 fail / 82 expectations);
restoration is green at 52 pass / 0 fail / 5 files / 511 expectations and
typecheck exit 0. The exact Fuzu run remains intentionally narrow—0 reward
candidates/runtime rewards and deterministic FakeLLM only—so todo-64 and the
production/content-breadth goals remain open.

### Current item-name evidence and ordinary intent boundary (2026-09-24)

The prior Fuzu 3→0 runtime-item and 48-call observations are historical
pre-item-evidence snapshots. The current exact run prepares 22 scenes, 3 clues,
3 items, 32 NPC anchors, 0 reward candidates, and 192 questions. Fifty legacy
answers plus two current human reviews leave 52 answered / 140 open; three
requests and 47 deterministic FakeLLM calls then close all 192. Runtime has 4
scenes, 3 clues/discoveries, one loot item displayed as 梦境之石, one bound
static narrative_noncombat NPC, no dialogue/encounter/reward, and 2 endings. Separate 4- and 3-action
GameSession paths distinguish owning that item. This is mechanically closed and
content-complete only in the source-disposition sense.

The NPC is 兰迪.帕蒂拉 from the 中庭 same-heading scope and exact source evidence;
it has no talk or combat. sourceMap, projection, and GameSession accept it.
Mutating `presentNpcs` to `[]` makes exact acceptance exit 1 with expected
boundNpcAnchors 1 / received 0; restoration makes the exact script exit 0.
Root rerun is 26 pass / 0 fail / 269 expectations with typecheck 0 and no
baseline-count change.

Queue 2.0, hints 2.1, and proposal request 1.3 require positive item bindings
to carry candidate-local marked-name/body `itemNameEvidence`; null declarations
forbid it. The parser/audit through claim, resolved binding, canonical artifact
regeneration, projection/sourceMap, and runtime display preserve that exact
value. Item-owned question sources prevent a bad clue from contaminating this
contract. Item regressions went red at the initial queue domain, structural name
restoration, exact-substring removal, and shared-clue-source restoration before
the final green run.

Ordinary intent accepts a model response only after strict action allowlist,
exact-key, type/enum, and safe-numeric validation. Valid optional fields still
include `spell`, `luckSpend`, `weaponName`, `calledShot`, and `item`; invalid
responses warn and use the existing regex fallback. A session mock demonstrates
luck 10→7. Compiled intent and execution authority are unchanged. The pre-slice
3576 full run was green; the first post-implementation full was 3585 tests /
3551 pass / 32 skip / 2 fail; the repaired final is 3586 / 3554 / 32 / 0.
Generic-app compiled bearer, real-model/API connectivity, arbitrary PDFs,
automatic content, and production completion stay open; a no-key warning is
expected rather than network-success evidence.

Final root verification is `bun test` exit 0: 3586 tests / 273 files / 3554 pass / 32 skip / 0 fail / 20644 expectations in 75.24s. Final `bun scripts/preflight.ts` exits 0 with boolean 205 / discarded 0, typecheck 0, baseline tests/files, unwired 82, and `core.hooksPath=.githooks` all matching. Expectations are evidence only; todo-64 remains open.

### Source-exact prose dialogue is a derived discovery, not a free-form action (2026-09-24)

Hints 2.2 and queue 2.1 add a human-reviewed NPC prose dialogue method. The
only evidence is an exact `relationshipEvidence` substring in the NPC anchor
paragraph. From it, the existing compiler derives the stable clue ID,
heading-scoped location, mechanics target, and a unique `discover_clue`
success effect. Callers cannot choose those values or turn the dialogue into
`acquire_item`; prose dialogue explicitly rejects `onFailure` and `failback`.
The same mechanics execution path is used for analysis, replay, GameSession,
and durable restart—there is no second dialogue DSL or executor.

The contract travels through accepted interpretations, MechanicsIR, projection
and `sourceMap`, canonical artifact replay, and quality accounting. Exact quote
validation, anchor-statement identity, duplicate-clue rejection, and
human-review-only admission are fail-closed. Automatic proposal production
still rejects dialogue and encounters. Proposal request 1.4 carries the
current compatible request surface; it does not authorize automatic prose
dialogue.

The schema capability table deliberately separates support from the current
version number: null items are 1.9+, source-fact dispositions 2.0+, positive
item-name evidence 2.1+, explicit `dialogueMethods` 1.7+, and prose dialogue
2.2 only. Restoring the old current-version equality decision produced 14 pass
/ 1 fail; restoring old failure-effect injection produced 5 pass / 1 fail; and
removing source-exact quote validation made its negative regression red. All
were restored green.

Fuzu remains a negative breadth control for dialogue. It has one static Randy
NPC, but the courtyard transition is terminal-first, so no talk action is
available before its ending. This deliberately preserves 0 prose dialogue
clues, 0 dialogue methods, 0 encounters, and 0 rewards rather than changing
the ending order or inventing an item-acquisition reading merely to exercise
the generic capability. Root verification: 101 pass / 0 fail / 12 files / 882
expectations, typecheck 0, full suite 3593 tests / 274 files / 3561 pass / 32
skip / 0 fail / 20724 expectations in 76.16s. Final preflight exits 0:
generated-document reference checks pass; boolean implementations 206 with 0
discarded returns; typecheck 0; tests/files 3593/274 and unwired 82 match the
baseline; and `core.hooksPath=.githooks`. This is not a real-model,
automatic-content, or production-completion claim; todo-64 remains open.

### Ordinary Session ownership is an evidence boundary, not a lookup rule (2026-09-24)

The earlier current wording that left ordinary action owner authentication open
is now historical and corrected. The method is to authenticate *before* any
body read, factory/opening work, enumeration, or session locator. Otherwise a
foreign-versus-unknown distinction, an extra body pull, or a factory side
effect becomes an oracle even when the final status code looks acceptable.
The regression suite deliberately observed all three: foreign and unknown are
opaque, rejected action requests have `bodyPulls=0`, and rejected routes have no
creation or action side effect.

Durable and live evidence must corroborate each other. Ordinary session metadata
has an independent versioned schema-1.0 binding with a host-principal
fingerprint only; the raw principal ID/token/cookie is neither stored nor used
as an identity record. A live binding that lacks matching durable metadata, or
any missing/old/tampered binding, is a fail-closed condition. Filtering the
stored list by that fingerprint is part of the contract. This does not turn the
existing ordinary session format into a full process-restart `GameSession`
hydrate.

Publishing is a transaction boundary too. Give create/list/runtime code explicit
`SessionRuntimeDependencies` so tests can hold a private registry and an offline
factory instead of inheriting global configuration. Generate a CSPRNG UUID,
check the finite collision set, persist/verify metadata, and only then publish
the live session. On a controlled failure, return 503 and remove exactly the
new career directory. This arrangement made an earlier test-isolation bug
visible: reading real configuration tried an external endpoint and polluted a
shared breaker; the offline factory removed that false dependency and final
logs show no endpoint attempt.

The useful mutations were ownership comparison that mutated state, auth moved
after body parsing, missing-binding fallback, and legacy locator/unknown-WS
behavior. Each changed a specific external observation and went red before the
exact restoration. The final evidence is 31 pass / 0 fail / 7 files / 485
expectations focused, 8 / 0 / 67 for ordinary access, reviewer core 18 / 0 / 3
files / 370 expectations, typecheck 0, and root full suite 3601 tests / 275
files / 3569 pass / 32 skip / 0 fail / 20775 expectations in 76.10s. The
final `bun scripts/preflight.ts` also exits 0: 209 boolean implementations / 0
discarded returns, generated-document references pass, typecheck 0,
tests/files 3601/275 match, unwired 82 matches, and
`core.hooksPath=.githooks`. The remaining work is identity-provider/rotation/
per-person audit, multi-writer and crash consistency, authenticated ordinary
WebSocket replacement, full ordinary restart hydration,
arbitrary-PDF/real-model/content breadth, and automatic publication—not this
completed owner-auth boundary.

## Ordinary HTTP intent API-required productionization (2026-09-24)

The prior ordinary-intent wording that allowed invalid/error regex fallback is
historical pre-slice behavior, not the HTTP production contract. Ordinary
`POST /api/sessions/:id/action` now receives a server-owned policy: it is
`required` by default, and only the exact `development_fallback` value outside
production permits the legacy compatibility path. A request body cannot request
fallback. Direct `GameSession` and CLI use may retain their existing preferred
compatibility behavior; that is deliberately not evidence about the HTTP
boundary.

The method is classify before commit. Required mode rejects missing or disabled
clients, breaker/open-provider failures, timeout, and transport failure with
503; non-JSON or strictly invalid model output is 422. It does not run regex
after either result, and no rejected action advances round/time/tick or changes
history, world, model, metadata, or action state. The model emits only a
strict ActionIntent allowlist. Internal traces retain safe provenance
(`model`, `regex_offline`, `regex_invalid`, or `regex_error`), latency and
safe error code; raw provider bodies, exception text, complete user input, API
keys and endpoint-sensitive breaker material are not public diagnostics.

Deterministic commands are an exception only when the *same parsed contract*
both admits and executes them. In required mode a module command is either the
bare list command or an exact title/alias in the session's current module
catalog; a companion command names an exact current CompanionManager id/name;
recruit remains its strict two-token local structure. Unknown, composite, or
natural-language-looking text returns to the API-required path rather than
being consumed locally. This avoids both prefix parsing and a second generic
regex gate. The same session-local result is passed to the handler, so admission
and execution cannot drift.

Concurrency is part of the state contract: each `GameSession.act` is FIFO, and
the ordinary HTTP transaction also serializes its prior counts, action,
metadata update, and broadcast for that registry/session instance. This keeps a
model response paired with its own events/narrative and prevents a metadata or
broadcast observer from seeing another action's state. Client timeout covers
both headers and body parsing with an explicit deadline race; timeout attempts
best-effort cancellation without awaiting a non-cooperating body/cancel stream.
Intent uses 15 seconds, 128 tokens and one attempt, rather than a pair of retry
budgets. Authentication is followed by a dedicated cumulative 8 KiB ordinary
JSON reader; then input is capped at 1000 Unicode code points before model or
state work.

Red/green mutations included restoring required→regex fallback, moving parse
behind tick effects, restoring retries or endpoint-only breaker keys, reviving
the environment-key second gate, awaiting a non-cooperating response cancel,
and reopening generic/unknown module local bypasses. Their targeted regressions
went red and the exact implementations were restored. Root directed evidence
is 101 tests / 11 files / 0 fail / 544 expectations; independent review is 134
tests / 14 files / 0 fail; typecheck exits 0. These are contract tests with
offline FakeLLM/fetch seams, not real-network evidence.

The slice remains non-blocking with respect to full production identity and
delivery: a shared bearer is one service account, no IdP/token rotation or
per-person audit is added, ordinary WebSocket stays unavailable, and there is
no ordinary full-restart hydrate, multi-writer/file-locking, cross-file crash
consistency, arbitrary-PDF/real-model acceptance, or automatic publication
claim. Todo-64 therefore remains open.

## Source-fact transition must compile to one fixed state contract (2026-09-24)

The safe unit is not a model-authored Predicate/Effect program. Queue/hints
3.1 accepts a root-exact `scene_state_transition` declaration whose only
choice is a bounded trigger (`scene_enter`, or same-heading `clue_found`) and
one same-heading canonical clue output. The compiler derives its mechanism and
interpretation IDs, private `source_state_*` sentinel, location, guards, and
effects, then sends the fixed result through the existing MechanicsIR parser,
automatic settlement, reachability, artifact replay, and runtime core.

Both output-not-found and the private sentinel belong in the executable
contract. The first prevents a second legal discovery method from replaying
the transition after the clue is already known; the second makes the
declaration's own one-shot state explicit without granting callers a general
state-key namespace. Multiple methods for one clue are therefore valid
alternatives, not a conflict; only a duplicate declaration key or identical
normalized trigger/prerequisite/output slot is rejected.

Automatic proposal authority is a separate decision. Proposal request 1.7
keeps transitions absent by default and reveals the exact wire only when a
trusted server policy opts in; the grounded acceptance boundary enforces the
same capability. Disposition report 2.1 skips only the exact interpretations
materialized by source-fact bindings, never every ID sharing a prefix, so a
heading cannot become positive mechanics evidence accidentally. Removing the
generated output-not-found guard (while leaving the private sentinel intact),
restoring prefix-based disposition skipping, and bypassing the grounded-policy
kind gate each made its intended regression red before restoration.

Root's final evidence is focused 51/0, wider compiler 207/0, HTTP 57/0, and,
after the public request-prompt correction, full `bun test` exit 0 with 3634
tests / 278 files / 3602 pass / 32 skip / 0 fail / 21198 assertions in 84.90s.
That advances the enforced baseline by +10 tests / +1 file / +10 pass over
3624/277/3592/32 while keeping unwired 82. No external model endpoint was
probed or called. This increment does not establish arbitrary-PDF, real-model,
high-fidelity content, automatic publication, or overall production
completion, and todo-64 stays open.

## A discovered clue identity is not every fact written under it (2026-09-24)

The runtime can retain its existing boolean `foundClueIds` contract without
introducing partial-clue state, provided the compiler creates separate symbols
for the visible shell and each independently gated finding. Queue/hints 3.2
therefore accepts only a complete partition over a compiler-owned atom domain.
For a positive finding the compiler derives the clue/mechanism IDs, verified
heading location, shell prerequisite, not-yet-found guard, and discover effect;
the proposal cannot author runtime AST or state keys.

Projection is part of the security boundary. Shell text is the accepted shell
atoms (or its marked name), finding text is only that finding's atoms, and the
method display is compiler-derived rather than selected from the whole body.
Source maps point back to actual accepted question claims and evidence. This
closed a reviewed whole-body method-description leak that the state-machine
test alone did not reveal.

Proposal request 1.8 permits a server-approved policy and deterministic
FakeLLM to submit the same bounded partition, so the feature is not a permanent
human-per-clue gate. Proposal compilation and audit replay validate facet
quotes against the queue-owned raw atom domain; generic normalized statement
substring checks remain unchanged for other kinds. Artifact restore regenerates
the queue from graph/draft and compares it, preventing a self-signed atom set.

Mutations restoring whole-body projection, removing the finding's shell guard,
or granting the finding automatically with the shell each made the new
regression red and were restored. Exact Fuzu also executes failed and successful
Medicine/Inspiration actions through GameSession, not only static reachability.
Full verification is 3641 tests / 279 files / 3609 pass / 32 skip / 0 fail /
21240 assertions; no external model was called. Content breadth and real-model
partition quality remain open production questions.

## Pending source-exact encounters activate hostility only at runtime (2026-09-24)

The automatic source-exact encounter compiler may produce a valid pending
encounter shape, but that shape is not itself a hostile actor. The NPC becomes
hostile only when the encounter is actually activated; projection, restore, or
the mere existence of a pending encounter must not advance combat state. This
keeps source admission and a real gameplay activation as separate observable
boundaries.

Combat randomness is instance-scoped: each `GameSession` owns its combat RNG,
so another session cannot perturb its rolls through a shared global crypto/RNG
proxy. Runtime combat accepts only a complete compiler-derived valid unit. Any
invalid or partial unit fails closed before activation instead of creating a
half-hostile NPC or falling back to guessed combat data. The focused source-
exact encounter evidence is 106 tests across 10 files, 0 failures, and 896
expectations; restoring either early-pending hostility or the global RNG proxy
made its target regressions red before restoration. This isolation does not
claim broad combat or general automatic encounter coverage.

## Durable catalog acknowledgement must be a disk fact (2026-09-24)

Catalog publication treats an acknowledgement as a durable observation, not a
request-local success value. An idempotent call returns metadata loaded from
disk. Existing entries and create races both use the complete durable-load path;
the staged directory is synced before it becomes visible, and the first
acknowledgement is admitted only after full durable revalidation.

Cleanup distinguishes opaque failure from verified adoption. Sync/load failures
whose final durable state is opaque remove their orphaned staged output.
Conversely, deterministic sync failure retains output only if full
revalidation proves it valid. Retaining unconditionally would allow one
process to erase another process's successful adoption; corrupt material is
never retained. The real red-first mutations were in-memory metadata (10 pass
/ 3 fail), removed directory sync (14 / 4), old corrupt-before-load behavior
(15 / 1), cleanup no-op (14 / 6), recovery that removed every owned path (21 /
2), and unconditional deterministic-failure retain (23 / 1); all were
restored.

Evidence is catalog-focused 24 pass / 0 fail / 142 assertions, broader directed
67 tests across 5 files / 0 fail / 795 assertions, typecheck exit 0, and full
`bun test` exit 0 at 3692 tests / 281 files / 3660 pass / 32 skip / 0 fail /
21478 assertions / 102.69s. This is close to production-grade for the bounded
mechanical loop, but the compilation/publication workflow remains a controlled
trial. Cross-process quota (`processLocks` is single-process), new catalog-root
parent-directory fsync, a review-plus-bundle transaction, player/Keeper
audience/visibility semantics, arbitrary/complex PDFs, real-model behavior,
and an exact tracked Fuzu fixture for clean-clone reproduction remain open.
Automatic publication therefore remains default-deny; todo-64 is open.

## Cross-process catalog quota is a coordinator boundary, not service-wide writer safety (2026-09-25)

The meaningful unit of closure is the component that actually coordinates the
shared durable fact. For catalog quota, every contender uses SQLite `BEGIN
IMMEDIATE`, compares the persisted quota policy, and opens the database with
`NOFOLLOW`, `FULLMUTEX`, and `EXRESCODE`. After policy admission it syncs the
staged root, publishes through a no-replace hard link, and does a durable
reload before acknowledging the result. Thus a cross-process decision is not a
collection of local caches that happen to agree in ordinary tests.

Uncertainty must remain observable. The result type is strictly `ok`,
`refused`, or `indeterminate`; HTTP turns indeterminate into 503. Folding an
unknown durable outcome into either success or policy refusal would let callers
make an irreversible follow-up from an assertion the coordinator cannot prove.
The five-file evidence is 74 pass / 0 fail / 804 assertions. Removing `BEGIN
IMMEDIATE`, the persistent-policy comparison, `NOFOLLOW`/path checks,
post-policy root sync, or the readback-fsync condition, as well as restoring
the old post-ack refusal or a race-winner sync throw, each made the relevant
regression red before exact restoration.

This logic does not magically make every adjacent durable object coordinated.
The whole service remains single-active-writer because snapshot/claim sidecars
are outside this coordinator. If publication completes but the process crashes
before its response reaches the caller, or that response is lost, the caller
can have an unknown opaque ID/orphan (Medium). NFS/SMB, external ancestor-path replacement, old
binaries, and Windows power-loss guarantees are outside the contract; review
plus bundle remains non-transactional. Treating this catalog sub-boundary as
todo-64 production completion would erase those distinctions.

## Encoding recovery must restore semantic markers, not merely readable bytes (2026-09-25)

The encoding repair audit found three original `◆` markers that had been
mistakenly restored as `▶`. The text looked readable, but marker identity is a
semantic classifier: `▶` admits a marked item, so ordinary prose had silently
entered the item path. Byte legibility was therefore an insufficient recovery
criterion.

The correction restored the exact source markers and re-ran the existing
contracts without loosening the deterministic FakeLLM or validator: automatic
coverage is 6/6 and NPC coverage is 8/8. The associated exact Fuzu witness is
the 16-page, 1,751,612-byte document
`a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5` with
artifact `e1ce9d252892143a6d99661a608eb70abf2da79eb46172eb645bf5641e11d220`:
197 questions, recorded 57 human / 139 open / 2 deferred, then three requests
and 47 deterministic FakeLLM calls to 195 answered / 0 open / 2 N/A. Runtime
is 6 scenes / 6 clues plus discoveries / 1 item / 2 NPC / 1 dialogue / 0
encounters / 0 rewards / 2 endings, with 5/4-action witnesses. The method is
to verify downstream category membership after recovery, not to make a
repaired corpus pass by widening its consumers.

## Snapshot CAS: durable identity is stronger than ownership (2026-09-25)

The compiled-session snapshot coordinator owns one complete cross-process
decision interval: current-header/predecessor read and validation, immutable
body publish and validation, current-header publish plus directory sync, then
durable reload. A mutex around only the final rename, or a process-local Set,
does not make the earlier read a compare-and-swap.

The outcome type must carry what the filesystem can prove. Exact replay is
`ok` only after durable body reload; same-predecessor different-successor saves
permit at most one `ok`. `busy`, `conflict`, storage failure, and possibly
published `indeterminate` remain separate. `indeterminate` is a retryable 503,
not a convenient refusal. A stale action conflict is 409 with the safe durable
generation. Generation zero is committed by durable save, so later local
registration/ack failure never deletes a public snapshot.

Post-commit recovery uses the existing full single-ID hydrator. It accepts only
an exact durable match on `(sessionId, bundleId, generation, snapshotHash)`;
same owner is not same snapshot. A mismatched registry adopter fails closed
instead of constructing a response from one session's invite/bundle and
another session's durable state. Normal precommit failure is still 500 with
private rollback and must not inspect a missing snapshot identity.

The proof includes real two-process competition, exact replay, winner durable
reload, typed busy/indeterminate, g0 durable-commit, conditional registry
installation, and red-first mutations that remove the coordinator, recovery,
indeterminate classification, or exact identity. It is a narrow snapshot CAS
closure, not multi-writer service completion: claim sidecars, ordinary sessions
and metadata, quota/GC, trusted-root symlink/junction handling, power-loss/NFS,
arbitrary PDFs, real-model acceptance, and clean-clone fixtures remain open.
Architecture and note indexes are intentionally deferred in this shared
worktree.

## Correction: result-oriented intent probing uses its session-owned API client (2026-09-25)

The historical `probe-llm-intent` comments said that its result-oriented
`GameSession.act()` cases exercised live LLM classification. That ceased to be
true after the session-bound intent-client change: the diagnostic cleared the
environment and constructed each session with `sk-placeholder` and a local
fake endpoint, so the default `preferred` policy silently used regex during
the simulated execution. The separate global `parseIntent` value was only a
report column and could not make that execution model-backed.

The diagnostic now passes the already loaded `LLMConfig` to every result
session and selects `required`. Its action-only diagnostic rows also use the
required resolver, so unavailable, malformed, or transport-failed model work
is reported as such and result play does not advance by regex. Explicit module
commands retain their existing deterministic local protocol. The diagnostic
entry is import-safe for an offline unit test; running the probe itself remains
an explicit external, non-deterministic operation and was not run here.

This is not a change to `GameSession`'s `preferred` constructor default:
deterministic internal harnesses and CLI compatibility still use that legacy
path deliberately. Ordinary HTTP play is already API-required, compiled owner
play uses `/compiled/intents`, and the player facade uses `/player-intents`;
the browser has no model client. Directed intent plus deterministic
compatibility-matrix verification was 48 pass / 0 fail / 454 expectations,
plus typecheck exit 0; the exact API-path dynamic proof is the three probe
cases, including intercepted requests from both the classifier and the actual
result session. Replacing `required` with `preferred` made the new no-client
natural-language regression fail, then exact restoration was green. The
root-authoritative closeout full run exits 0: 3767 tests / 287 files / 3735
pass / 32 skip / 0 fail / 21848 expectations / 225.64s. No external model was
called and no credential was output. The fresh-worker restart regression uses
an outer 15s test budget while its internal diagnostic remains 10s; that is
test scheduling evidence, not a production latency claim. Real-model quality
and the deferred notes/architecture indexes remain open.

### 纠正：snapshot 配额与 GC 属于 publication 边界，不是 coordinator 生存边界（2026-09-25）

旧 CAS 收尾把 snapshot 的 quota/GC 留作开放项；该说法现仅是历史。独立 SQLite
coordinator 已闭合这条 snapshot 子边界，但必须把三个结果分开：quota exhaustion
只给固定安全 HTTP `507` message；quota=0 只禁止 immutable body/header publication；
coordinator 自己仍可 bootstrap，且其 durable files 仍计入磁盘。把 quota=0 解释成
“不能创建 coordinator”会把 admission policy 误当成 durable coordination 的前提。

42 pass / 3 files / 286 expects 的定向验证和独立审查 High=0 只支持这个窄结论。
claim sidecar、ordinary session、session metadata、多实例协议、power-loss 与 NFS/SMB
仍不在该 coordinator 的保护范围；不要把 snapshot closure 升格为服务生产化完成。

### 纠正：control-state pruning 是语义等价商，不是放宽状态上限（2026-09-25）

此前 323 -> 643 的增长不能靠把 `maxStates` 调大来“修复”。report component 1.1 只对
non-core pure observation clue 取商：它不能被 predicate/reward 引用，所有来源必须仅是
自身 discover，且该 discover 没有 failure、failback 或任何额外 effect。Fuzu 只因此折叠
camera prose finding 和 NPC dialogue finding；edge、witness 与 runtime hash 的完整语义不变。
report 中保留的 edge 只是 quotient representative evidence，不能误读为 full-hash graph 的
完整 adjacency。

`maxStates=500` 仍是有限、fail-closed 的安全预算，绝非内容可以无限扩展的结论。恢复完整
mechanicsStateHash 会使 synthetic `state_limit_exceeded:3` 与 Fuzu draft_only 同时变红；把
predicate reference 错当无关会漏 post-discovery trap deadlock。旧 component 1.0 必须拒绝，
不能按 1.1 默默解释。notes index 因并行 worktree 暂不刷新，本条是已知的滞后索引记录。

### 纠正：自动解析的 progress 是 accepted state，不是 hint 容器（2026-09-25）

自动解析可以收到非空 `explicitHints`，却没有任何内容进入 accepted resolution state。把
“对象非空”当作 progress，会让 continuation 表示并不存在的恢复点，后续恢复便会从伪造的
前进状态继续。正确判据是队列/解析后的 accepted resolution state 是否实际增加；零 accepted
的 pass 维持 draft-only 且不得写 continuation。输入形状无效也必须在边界变成 typed rejection，
不能靠 `as` 强转让 HTTP 500 替代编译契约。

同一条执行边界也包括取消语义：测试 FakeLLM 若克隆 `AbortSignal`，它就不再表示调用者真正的
取消状态，可能把有效 deterministic reply 误报为 `llm_call_failed`。桥接 test double 时传递原
signal，而不是复制看似相同的对象。根代理对真实 current-schema Fuzu acceptance 已验证这两条
约束，并以恢复“非空 hints 即 progress”、malformed-hint coercion 和 cloned signal 的实现变异
使相应回归变红；恢复后精确 run 到达两条真实 GameSession ending witness。本结论不涉及真实外部
模型或服务端可用性；notes index 的并行刷新仍延后。

### 纠正：作者全局接口与 durable bundle 身份需要独立收口（2026-09-25）

遗留 `/api/modules` CRUD 不能把“模块编辑器存在”误当成公开作者接口的
授权。它现在采用 operator-only 契约，并且在读取 request body 或触及模块文件前
完成认证；请求头和 body 都不能声明 role。module ID 是安全单段，保存、读取和删除
还要在解析路径后证明目标仍在模块目录内。因此编码路径、斜杠、反斜杠、绝对路径和
点段均 fail-closed，同时保留合法 editor ID 的既有 CRUD 行为。无认证的全局
`/api/characters` CRUD 已退役；受 GameSession 约束的角色路径仍是另一条契约，不能
由此声称普通 runtime 或身份边界已全部闭合。

同样，durable compiled-session 不能只用 module/artifact/mechanics 身份判断可恢复性。
快照必须证明精确 `bundleHash`；否则不同 bundle 可被错误地当作同一可执行状态。Fuzu
验收从 catalog 取得 bundle、写入 durable snapshot，再从该 snapshot 逐步重建 transaction，
真实到达两个声明 ending ID 并 exit 0。根代理记录 typecheck exit 0、完整 suite 为 3965
tests / 306 files / 3933 pass / 32 skip / 0 fail、unwired=75；root-authoritative
`bun scripts/preflight.ts` 亦 exit 0，报告 typecheck 0、258 boolean implementations /
0 discarded returns 与 `core.hooksPath=.githooks`。生产级目标保持 open。
`docs/notes/index.json` 正在并行修改，本追加条目只记录其索引
滞后，未刷新索引。

### 最终质量验证：重型集成测试的 outer timeout 是调度预算，不是生产 SLO（2026-09-25）

final preflight 暴露三条真实集成链原有的 5s **outer** timeout 小于其正常的
fresh-worker 调度时间：real HTTP PDF-to-terminal chain、reviewed player façade
chain，以及 16-case snapshot forgery matrix。本轮没有改生产代码或测试断言；仅将
这三条的 outer 调度预算设为 `15_000ms`。它是 test-harness headroom，不能写成生产
latency SLO 或性能承诺。

并发独立复验中，每组均为 3/3 green，约 5.26–5.60s。root 随后按同一顺序独立定向
1+1+1 green：5.17s / 4.52s / 3.87s；`bun run typecheck` exit 0。authoritative
full `bun test` exit 0：3965 tests / 306 files / 3933 pass / 32 skip / 0 fail /
23115 expectations / 344.24s。final preflight 也 exit 0：typecheck 0，3965/306
baseline 未改且 match，unwired=75，258 boolean implementations / 0 discarded
returns，`core.hooksPath=.githooks`。

这只是对测试调度预算的最终验证，不关闭 `todo-64` 或生产质量目标。
`docs/notes/index.json`、`docs/architecture.json` 与 `AGENTS.md` 仍为 deferred，
本轮均未修改或刷新。

## 编译自然语言意图：跨进程 admission 是 provider 前的持久事实（2026-09-26）

`POST /api/sessions/:id/player-intents` 和 owner
`POST /api/sessions/:id/compiled/intents` 都只是分类，不执行 action；但它们仍可能
各自先花一次模型调用。现两条路由共用同一 SQLite admission，opaque lease key 同时
绑定 session 与 exact expectedGeneration，不能用本进程 Map 冒充多实例安全。认证/授权、
8 KiB 有界 JSON、durable compiled-session identity/generation 和当前 catalog 校验都必须
发生在 acquire/模型前。同 key 已有 committed holder 时，竞争者在 provider 前收到
429 + `Retry-After`，没有模型、session、snapshot 或 broadcast 副作用；SQLite/root/
schema/domain/policy 的不确定性一律是 fail-closed 503，不把基础设施问题伪装成竞争。

锁域是部署契约的一部分：admission root 必须与 runtime namespace root 精确相同，
compiled wrapper 固定 SQLite filename、schema 和 coordinator domain；即使受信 host
经 injection 提供不同 filename/domain，也不能制造第二把锁。数据库不保存 raw prose，
也不保存由低熵玩家输入导出的 SHA-256；每次 acquire 生成新的 CSPRNG 32-byte nonce，
只在 exact-owner fencing/audit correlation 内使用。player 的响应仍不含 `mechanismId`。

`resolveCompiledActionIntent` 明确传 `maxAttempts:1`，把 HTTP Request signal 传进
LLM client，并与 lease-renewal-loss abort 合并。provider timeout/abort、renewal loss、
request disconnect 或任何 completion 不确定的 model error 都先对 exact owner quarantine；
即使 provider 忽略 abort，finally 也不释放，从而第二请求不能并发进入。只有已知结束的
provider result 才 release。TTL 绝不自动接管仍可能活着的调用。恢复不是隐藏的 client
API：operator-only recovery 无 body，generation 从 authoritative durable session 读取，
只能删本次请求前已经存在的 quarantine；active（包括 expired）一律拒绝。模型 await
之后会再读 durable namespace + compiled snapshot identity/generation，然后保留原有
registry/catalog recheck，防另一进程已提交 action 后本地 registry 仍旧而误分类。

离线双 Bun 与两条 HTTP 路由竞争验证恰一方进入阻塞 provider seam；定向为 35 pass /
4 files / 315 expectations，typecheck 0，root 全套为 3988 tests / 308 files /
3956 pass / 32 skip / 0 fail / 23299 expectations / 216.93s，unwired=75。真实变异
移除 admission、恢复默认 retry、丢 signal、放开 injected filename、恢复输入 SHA-256
分别令互斥、单尝试/取消、锁域和不可关联性回归变红，均已还原；独立 review PASS。
本轮开始前 preflight 只因旧 baseline 3965/306 与当时实测 3974/307 不一致而失败；
最终 preflight 必须由 root 在本次文档/基线更新后重跑，本文不提前写通过。

仍开放的边界必须如实保留：这不是真实 provider 的运行保证，也不自动证明 crash 后旧
worker 已停止；operator recovery 仍需有权限的人作该判断。它不覆盖 ordinary action/
session 或全服务 multi-writer、IdP/rotation/per-person audit/rate-cost、authenticated
ordinary WebSocket、任意 PDF/内容宽度、NFS/SMB 或 power-loss 语义。`todo-64`、各
Checkpoint 整体与生产质量目标均继续 open；`docs/notes/index.json` 和
`docs/architecture.json` 本轮未改。

## 真实模组恢复必须跨进程，而不只是同进程重建对象（2026-09-26）

同一进程中每次从 snapshot 重建新 `GameSession` 能证明序列化/还原，但不能证明新进程只凭持久状态启动。Fuzu 验收现在让独立 Bun child 只接收 durable root、session、action ID 和 generation，强制按 header→catalog→body→restore 顺序恢复；已提交 action 的重放保持 generation 1，下一条真实 witness action 提交到 generation 3 并匹配精确 state hash，父进程随后读取 child successor、恢复并继续到 ending。

第一轮缺 header 的红结果是有效证据：child 没有继承父进程内存。目录对齐后，静态依赖初始化向 stdout 打印随机表日志，又把单记录 JSON 协议变红；机器接口必须在动态导入前隔离普通日志，并保留 stderr 与非零退出。最终原 PDF 全链 exit 0、stderr 为空，两个 ending 的玩家动作数仍为 5/4。该证明不外推到多节点/NFS/SMB/power-loss，也不替代真实 provider 验收；notes index 刷新因并行改动延后。

## 真实模型质量验收必须把“授权、理解、闭合、执行”分开计量（2026-09-26）

检测到 API key 或一次通用 JSON health response 不能授权上传本地模组，也不能证明模型理解来源。双模组 runner 因此把 live authority 绑定到两份 exact PDF SHA-256；缺任一 hash 就在 provider 配置/调用前拒绝。允许后也只发送当前 queue/evidence allowlist 的 bounded proposal envelope，每模块最多 2 rounds、16 calls、每 call 15s；报告只保留 request/response hash、延迟、typed code、accepted/open/closed/witness counts，不保存 endpoint、credential、完整 prompt 或 raw reply。

`--prepare` 已以 externalCalls=0 证明 Fuzu 与 Barn 的真实文档身份和双向 module isolation；Barn 仍 draft-only 是质量事实，不是要靠套用手写答案消除的失败。只有真实 accepted hints 再经现有 resolver、closed-world 和 witness replay，才能计作可运行模块。本轮未获两份文档的显式外部上传授权，所以没有执行 live source call；`docs/notes/index.json` 的并行改动继续保留，索引刷新延后。

## 写入真相源后仍要消除同一事实的运行时缓存分叉（2026-09-26）

“规则写入 SQLite”并不自动意味着单一真相源：`GameSession.applyDamage()` 已把 PC HP 写进 WorldState，却没更新同一 PC 的内存角色卡，导致 `/state` 与 character summary 立刻给出两个答案，普通 snapshot 随后按既有一致性校验拒绝导出。修复边界不是再建投影，而是只在 world 写成功后使用其返回的 authoritative `remainingHp` 同步同 ID 的既有角色对象；NPC 没有角色卡就不创建，失败写入也不碰缓存。

新增回归同时钉住 active/inactive PC、对象身份、两个读取面和 snapshot export。初始实现与真实回退变异都按 expected 8 / received 10 变红，恢复后定向与全量均绿。这仍只消除了一条已证明的 HP 分叉，不代表 legacy `src/world/state.ts` 与 SQLite 的所有重叠已经统一。notes index 因并行改动继续延后刷新。

## 规则域和测试调度的边界必须各自可证（2026-09-27）

入口 validator 不能复制一个看似更安全、实则更窄的数值域。普通角色
snapshot admission 曾要求 `build >= 0`，但规则函数 `calcDamageBonus` 的合法
域是 -2..8；受控 point-buy LCG seed 556 实际生成 STR 37 / SIZ 45 / build -1，
因此旧入口拒绝了规则已允许的角色。修复是让 validator 复用规则域，而不是
把另一个范围同步成“看起来一样”。边界测试接受 -2/-1、拒绝 -3/9；原实现和
恢复 `min(0)` 的真实变异均各有一次失败，恢复后 snapshot 15、ordinary
admission 9、根三文件 31/223 和 typecheck 均绿。

全量中出现的 E2E timeout 也必须先区分业务时限和测试调度。多阶段 child/
HTTP/process fixture 的 lease TTL 必须长于它要验证的业务 deadline，否则会先
得到 `LEASE_EXPIRED`，没有测到 intended `DEADLINE`。本轮 auto-deadline
fixture 的 TTL 从 100ms 调至 10s，以隔离其 2s deadline；专门 TTL 测试未变。
同时只有六个精确多阶段 E2E 获得本地 15s outer budget，避免默认 5s 把调度
误报成产品失败。这个单例 E2E 预算是确定性验收资源，不是生产 latency SLA，
更不是全局 timeout 的放宽。最终 full suite 为 4010 tests / 313 files / 3978
pass / 32 skip / 0 fail；exact-tree preflight 仍待在同一工作树上执行。notes
index 与 architecture 仍因并行修改而未刷新。

## 共享参考数据的 API 边界必须与共享缓存边界一致（2026-09-27）

`sharedWorldModel()` 的共享不是只把同一 loader 放进 Map：只要 getter
把内部 entry、嵌套 JSON 或索引 bucket 的可变引用交出去，任意一个消费者就能
污染所有后续查询。冻结仅顶层数组也不够，调用者仍可改 `entry.name`、
`properties` 或未声明的嵌套 JSON；而只冻结 entry 不冻结 bucket，又可通过
`pop()` 令 type 查询与总数分叉。

因此在成功替换 live model 前一次性冻结 JSON 派生对象图及所有索引 bucket，
使公开查询的现有引用语义成为只读语义，而不是每次查询深拷贝。共享身份使用
resolved lexical path（Windows 再折叠大小写）；这解决真实 `nested/../` 别名，
不等于 realpath，也不构成 symlink/junction containment、可信根、per-work
manifest、content hash、严格 schema 或 compiled v18 许可。实载 v18 的 RSS
只记录为单次探针观察，不能升级成容量或延迟 SLA；这些来源与部署边界继续开放。

## Prompt 的结构化值也必须经过表示层，而不是泄漏宿主字符串化（2026-09-27）

候选条目即使已由 loader 正确解析、筛选和排序，直接插值其中的 `relation`、
`behavior`、`resource` 或未知 JSON 字段，仍会让数组变成逗号串、对象变成
`[object Object]`。这既没有改善来源质量，也不能靠修改候选集合来掩盖；问题在
prompt 表示边界。

修复应复用已有的文本化契约，并只对已选条目建立浅层 render copy：数据模型、
acceptance、候选数量和排序保持原样，prompt 中每种 guidance 统一使用同一可读
标量表示。真实 v18 探针可证明数组语义被接入可读 guidance，但不外推为可信根、
manifest/hash、严格 schema、compiled v18 许可或真实模型质量验收。

## 公共读取模型应断开内部引用，而不是假定调用者不会修改它（2026-09-27）

`GameSession` 的 public view 若直接回传内部角色、KP、SAN、背包或场景物品的
嵌套引用，读取就是一次隐形写权限：同进程消费者可把后续规则 gate 的 difficulty
改掉，或污染下一次状态/历史读取。HTTP 恰好序列化为 JSON 并不能让核心 API
自动安全；测试与嵌入式调用可直接触碰这些引用。

边界修复应在所有公共读取面一致地产生 detached fields；历史消息尤其需要按
完整结构 clone，而不是只复制数组壳。它保持 HTTP payload、规则结算和持久化
不变，也只能证明本地 API 引用隔离，不能把这个事实写成已证实的远程漏洞或
完整多租户安全结论。

## SQLite 的首次竞争不能把可恢复 BUSY 与提交不确定性混为一谈（2026-09-27）

首次 acquire 的正确结果不是“任一错误都拒绝”：两个竞争者在默认无等待、无
同事务重试时可能一起失去资格。`BUSY` 在同一连接的 COMMIT 位置仍可有限重试；
持续 BUSY 则必须 rollback 并返回 ordinary busy，避免把可说明的暂时竞争写成
不明错误。

反过来，`LOCKED`、IO、缺少错误码和 post-commit acknowledgement 的不确定性
不能借由扩大 BUSY 分类而伪装成可重试；它们保持 indeterminate。此规则只覆盖
经压力验证的本地 ordinary first-acquire 路径：不外推为普通服务全局 multi-writer、
crash/power-loss、NFS/SMB、IdP/audit/rate-cost 或 authenticated WebSocket 的
生产结论。

### 更正：ordinary 默认 1000ms 不是稳定修复（2026-09-27）

先前把 ordinary `busy_timeout` 提到 1000ms 的方案已经被完整运行反证：该设置下
exact preflight 出现两项失败，带上下文 full 又出现成片五秒测试调度 timeout。
后者涉及 PDF resource、delivery、facade、creator access、restart 与 Barn，不能
偷换成业务失败或写入通过基线；但它足以否定“1000ms 是 ordinary 的正确默认值”。

现行 ordinary 默认是 25ms，显式 0 仍然是 0；private compiled contention 继续
显式 1000ms。只有同一事务 COMMIT 的明确 `SQLITE_BUSY[_*]` 才有限重试一次；
持续 BUSY rollback 为 ordinary busy。`LOCKED`、IO、无 code 和 post-commit
acknowledgement 不确定性仍为 indeterminate。反证保留在历史中，不能由覆盖旧
记录或把 timeout 失败记入基线来伪造收口。

## 多语句真相源切换必须在同一事务中失败或提交（2026-09-27）

活动场景的“唯一 active”不是两条独立 `UPDATE` 的自然结果：先清掉旧行、再
打开目标行时，目标不存在会留下零 active；目标存在但第二阶段受 trigger 或
SQLite 操作错误拒绝，也会留下相同的破损中间态。存在性检查只能避免前者，
不能替代事务。

因此存在性验证、清除、激活和回读确认应同属一个 SQLite transaction。未知
目标在写入前返回 `false`；第二阶段失败则继续暴露操作错误，并由 SQLite 回滚
原 active。测试用拒绝目标激活的 trigger 走到第二阶段验证该保证；把实现变异
回裸 sequential `UPDATE` 会使该红例失败，恢复事务后转绿。这是单一 durable
truth-source transition 的原子性，不外推为多进程写入、崩溃恢复或部署级保证。

## preflight 可靠性依赖资源、边界 fixture 与竞争输入各自可证（2026-09-27）

资源型解析器的生命周期属于生产调用的正确性：创建后必须由 `finally` 释放，
即使解析/上界校验抛错也不能泄漏。应以可观察的 destroy 计数先把旧路径变红，
再用移除 cleanup 的实现变异确认回归真在守卫；慢资源测试在修复后缩短只是
资源生命周期证据，不是产品延迟 SLA。

拒绝路径的 hostile fixture 要最小充分。为超过单页 UTF-8 上界而构造数百万字符，
会让资源耗尽遮住本来要验证的 `422 page_text_utf8`；恰为上界加一字节仍能走真实
HTTP/guard 链。关闭两个 guard 后变成 201 才证明 fixture 没被改成纯单元桩。

确定性 fixture 的缓存也不应降低竞争覆盖：只缓存相同 moduleId 的构建 promise，
每次消费者都拿 `structuredClone` 的独立图，因此嵌套 mutation 不会跨例污染 root、
catalog 或 session。缓存同时避免每例重新构建让同 generation 的 owner/player
竞争被调度噪声放大；把 admission lease key 随机化仍必须让双调用红，说明共享
fixture 不是通过弱化竞争取得绿灯。失败的 preflight/串行运行应记录根因，不能
改写成业务失败、通过结果或测试基线。

## 多阶段伤害的真值字段必须在同一事务转换并回读（2026-09-27）

HP 归零与实体的 `alive/status` 不是可独立提交的两个事实。若先更新 HP、再更新
致死字段，第二句被 SQL trigger 拒绝时就会留下“HP 为零但仍存活”的 durable
矛盾。把所有后续读取交给调用方修补只会扩大该中间态。

正确边界是：同一 transaction 读取实体、写 HP、按致死结果写 alive/status，
再从持久层回读 authoritative state；操作错误继续抛出，整个转换回滚。测试应在
第二阶段注入会中止的 SQL trigger，证明每个字段恢复原值；恢复裸顺序 UPDATE 的
真实变异必须重新变红。这证明一条 local damage transition，不等于所有 world
mutation、跨进程竞争、crash/power-loss 或部署语义已经关闭。

## 效果 tick 的 update-select-delete 必须作为一次消费事务（2026-09-27）

效果持续时间更新、读取仍有效的 row、删除过期 row 和转换广播对象不是可以各自
落盘的四步。若 DELETE 被 SQL trigger 拒绝，裸 UPDATE→SELECT→DELETE 会先把
duration 消耗为零，随后丢掉 active effect，却让先前构造的 snapshot/broadcast
残留，令读取、持久层和消息语义互相矛盾。

应把这些步骤和 row-to-effect 放入同一 transaction：失败继续抛出，SQLite 回滚
duration、active row 及可见结果，因此错误不消费效果也不丢广播依据。以最后一段
DELETE trigger 失败注入的红例，再把实现变异回裸三步确认回归真在守卫。该结论
只针对 local effect tick，不外推 round orchestration、其余 world mutations、
multi-writer、crash/power-loss 或部署语义。

## Auto-registering a durable player row is part of the setter transaction (2026-09-28)

A public player-state setter that first creates a default `player_state` row and then updates one column is not two independently publishable operations. If SQLite rejects the second statement, exposing a new default player row after the caller receives an error makes the durable truth source contradict the operation result. The registration and requested-column update therefore share one same-connection SQLite transaction; the database error continues to propagate and rolls both writes back.

The regression must inject the failure at the second statement, not at registration: a rejecting `UPDATE` trigger proves that a previously unknown player leaves no row or projected player state, while a pre-existing player's complete persisted row and view remain unchanged. A successful setter for a previously unknown player remains an auto-registering durable write. This distinguishes transaction behavior from a change to the public registration contract.

Evidence should include both the initial old-path red result and an independent real mutation after a green repair. Restoring the old `INSERT OR IGNORE` followed by bare `UPDATE` must make the regression red again; restoring the transaction must return it green. This proves only the local same-connection, single-setter auto-register-plus-column-update boundary. It does not establish multi-connection, cross-store, whole-round, crash/power-loss, or deployment atomicity.

## 直接动作异常不能伪装成跨存储回滚（2026-09-28）

`GameSession.act()` 一次动作可以跨 world、agent、NPC、career 和 `await` 边界。
对共享 store 取全量 memento 后再写回，既不能回收已经发生的文件副作用，也可能覆盖
等待期间由外部组件写入的数据，因此不能把它称为安全的原子回滚。

当前 direct 契约是 crash-only fail-stop：未显式注入时，NPCStore 是每个会话私有的
`:memory:` store；需要共享或持久化时必须由调用方显式注入。动作异常在 FIFO operation
内部先标记 fail-stop 并关闭资源、再释放队列，所以首个调用仍收到原始错误，而排队或
后续调用只能收到稳定的 unavailable 拒绝，不能继续消费部分状态。这不是 atomic commit
保证。普通 HTTP 路径已有隔离 candidate 加 CAS 的事务边界，未因该修复回退为 direct
执行。

完整 direct 原子提交仍是开放工程：必须从 source revision 建立 candidate 并防护 ABA，
继承精确的 LLM/fake 依赖，stage career 文件副作用，协调组件安装或提供补偿；若补偿失败，
仍须 fail-stop。测试应验证这些真实边界，而不能在关闭的数据库上读取状态来伪证 rollback。

## Omitted fields must not be republished from a stale scene read (2026-09-28)

`registerScene(sceneId, name)` has an explicit preservation contract: omitting description changes the name while retaining the already durable description and the non-owned scene fields. Implementing that contract as SELECT followed by UPDATE is unsafe even though the second statement appears to write the same description. A SQLite trigger or another same-database writer can change description after the read; writing the cached value back erases that committed change.

The repair is not `REPLACE`, because replacement would discard scene-owned lighting, dangers, exits, or active state. It is an `INSERT ... ON CONFLICT(id) DO UPDATE` with two narrow branches: the omitted-description conflict branch writes only name, and the explicit-description branch writes name plus description. The regression uses a real `BEFORE UPDATE OF name` trigger to make the interleaving observable. Both the initial old path and an independent restoration of that old path are red at 1 pass / 1 fail; restoring the UPSERT returns 2/2 green.

This is only an intra-SQLite stale-writeback boundary for `registerScene`. It is not a whole-service multi-writer, NFS, distributed, crash/power-loss, or deployment guarantee, and it does not settle the separately unresolved entity-liveness authority.

Validation history must preserve counter-evidence without inventing a diagnosis. After updating the baseline, the first `bun scripts/preflight.ts` exited 1 with a summary of 4017 pass / 1 fail and a test-count mismatch; the summary retained no failing test name. It is therefore recorded as non-reproduced evidence, not attributed to this repair or any other guessed cause. A subsequent default full run was green at 4050 tests / 320 files / 4018 pass / 32 skip / 0 fail / 23659 expects / 206.60s; the exact preflight `bun test --parallel=1` run was green at 23700 expects / 249.98s. The second final preflight was green with typecheck 0, the 4050/320 baseline match, 263 boolean implementations with 0 discarded returns, unwired 71, and `.githooks` installed.

## A mutation's returned count must come from that mutation statement (2026-09-28)

An UPSERT followed by a separate `SELECT` can durably increment a counter correctly and still return the wrong count to its caller. Another SQLite connection may commit a second increment in the interval, causing the first caller to receive that later value instead of the count its own call produced. For a public result-bearing mutation, that is an observable contract failure even when the final durable count is correct.

`INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING fail_count` makes the durable increment and its returned count one SQLite statement. The returned field must still be validated as a positive safe integer: a missing or malformed row is a storage anomaly to expose, not an excuse to return a fabricated zero. The regression uses two real `WorldStateManager` instances against one temporary SQLite database; its controlled hook merely schedules the second legal commit after the first old-path UPSERT and before its old-path `SELECT`, without simulating SQLite results. The initial old path is 1 pass / 1 fail / 5 expects, an independent restoration of `run+SELECT` is red again, and restoring `RETURNING` is 2 pass / 0 fail / 8 expects.

This result is deliberately narrower than a failback claim. The current `GameSession` reads its threshold before the action and ignores `WorldStateManager.incrementClueFail`'s return; `src/world/state.ts` is a distinct implementation whose caller consumes its return immediately. Same-session actions are FIFO. Cross-session/process coordination is not established by this slice. During validation, the sandbox collector reported `uv_spawn EPERM` before tests started; the subsequently approved external execution succeeded, so that startup failure is retained as environment evidence rather than attributed to the repair.

## Partial durable updates must leave omitted fields inside the statement (2026-09-28)

`upsertEntity` accepts a required identity plus optional durable fields. Reading the
entity to fill every omitted field in JavaScript, then writing the assembled row,
silently turns a partial update into a stale full-row write: a second connection can
commit damage after the read, and an identity-only update later restores the old HP.
The same problem applies to status, scene ownership, faction, and attributes.

The correction is one `INSERT ... ON CONFLICT(id) DO UPDATE` statement. Required
`name` and `type` retain their established overwrite contract. Each optional field
is selected by whether a non-null, non-undefined value was actually supplied;
SQLite's current column remains authoritative when it was omitted. This cannot use
truthiness because `0`, `""`, `[]`, and `{}` are valid explicit updates. Insert
defaults remain unchanged.

The regression uses two real `WorldStateManager` instances over one temporary
SQLite file. Its hook only schedules the second public `applyDamage(10, 3)` before
the first upsert's durable statement; it forges no database result. Old read plus
UPDATE writes cached HP 10 over durable HP 7, and restoring that full old path after
the repair turns the test red again. This proves a public shared-file or embedded
multi-connection stale-writeback boundary, not that ordinary HTTP currently races:
`GameSession` defaults to `:memory:` and ordinary actions are FIFO. The existing
`alive=1` update behavior is intentionally retained, so hp=0/liveness/revival
authority remains a separate unresolved contract.

## Partial scene environment writes must retain omitted columns in SQLite (2026-09-28)

`setSceneEnvironment` owns `lighting` and `dangers` independently. A partial
call such as a lighting-only update must not read both fields into JavaScript
and later write both back: another connection can durably change `dangers`
between those statements, and the caller then silently restores the old list.
The ownership rule is therefore per supplied column, not per assembled scene
object: leave every omitted column in the SQL statement as its current SQLite
value. This preserves explicit `""` and `[]`; only an omitted value retains the
stored column.

The regression uses two real `WorldStateManager` instances over one temporary
SQLite file. A hook on A's real `db.run` schedules B's public dangers-only
environment write immediately before A's lighting-only statement. It neither
forges a database row nor simulates SQLite output. The old `getScene` plus
two-column UPDATE restores `['wet floor']` over B's durable `['toxic fog']`;
the single supplied-flag UPDATE retains B's result while applying A's lighting.
`run().changes` also preserves the pre-existing unknown-scene throw. This
establishes the public shared-file/embedded multi-connection boundary only:
`GameSession` defaults to `:memory:` and normal HTTP has no reachable
two-connection path. Exits, active-scene, registration, and entity
liveness/revival semantics remain outside this change.

## Unattributed compiled restore serial counter-evidence (2026-09-28)

The final generated verification initially failed before the scene-environment
slice can be called: `bun scripts/preflight.ts` was exit 1 despite typecheck 0,
263 boolean implementations with zero discarded returns, unwired 71, and normal
hooks. Its test child reported 4023 pass / 32 skip / 1 fail. An exact
`bun test --parallel=1` repeated the same one failure in the compiled-session
restart rehashed-forgery matrix (4023/32/1/23669; 261.77s); the target lasted
389.79ms, but its assertion or exception stack was not retained. This is
counter-evidence, not proof of a repair or a reason to lower the baseline.

The target alone was green (1 pass / 34 expects, about 3.17s), and a third exact
serial run was green (4024/32/0/23679; 319.94s; target 2625ms); the second
preflight was also green with the 4056/323 baseline, typecheck 0, 263/0,
unwired 71, and `.githooks`. Local Bun help confirms `--parallel=1` implies
test-file isolation, and the target's own timeout is 15 seconds, so the short
failure is neither a cross-file global leak nor a timeout conclusion. The
forged restore returns at validation before any world projection; that projection
does not call `setSceneEnvironment`, so there is no evidence connecting this
counter-evidence to the scene-environment UPDATE.

The matrix does construct 16 rejected-target `GameSession` values without
closing them. They hold in-memory SQLite stores, so this is a test-resource
hygiene hypothesis only, not an established cause. If the failure returns,
concurrently drain and preserve full stdout/stderr with its forged-case index,
assertion, and stack first; only then choose a filesystem, validator, or
resource-specific minimal reproduction.

## Ordinary full-process `GameSession` hydrate correction (2026-09-29)

The 2026-09-24 "Ordinary Session ownership is an evidence boundary, not a
lookup rule" note recorded that ordinary full-process `GameSession` hydration
was still open. That was the correct boundary at the time; it is now historical
and superseded rather than erased.

`ordinary-session-process-restart.test.ts` now starts fresh Bun seed and resume
processes against the durable ordinary-session storage. It verifies restored
state and ordinary generation, an exact duplicate receipt without a second
action or broadcast, action-ID conflict rejection, and a continued action with
its broadcast. Its cold case also replays a receipt after it has fallen beyond
the hot window. `ordinary-game-session-snapshot.test.ts` separately covers a
fresh-target ordinary snapshot restore and fail-closed tamper cases. Ordinary
full-process restart hydration is therefore no longer an open todo-64 item.

This correction does not widen the production claim. Authenticated ordinary
WebSocket replacement; host IdP/token registry, rotation, and per-person audit;
multi-writer/file-locking coordination; cross-file crash, power-loss, and
deployment semantics (including NFS/SMB); and the remaining PDF, real-model,
content-breadth, rate/cost, and publication work are still open.

## Relationship updates must derive from the committed new attitude (2026-09-29)

A relationship is not an independently recomputed delta. Its visible relation
must be derived from the `new attitude` selected by the same durable transition;
otherwise a stale pre-read can make the relation disagree with the value the
attitude update actually commits.

For one pair, the attitude increment therefore belongs in one SQL
truth-source transition that reuses the one existing directional relationship
row. It neither requires, creates, nor atomically publishes a reciprocal or
inverse row. If both opposite directional rows already exist, that is an
ambiguous precondition: fail closed before writing either the attitude or a
relationship. No canonicalization or schema migration is implied.

The strong mutation must create durable disagreements, not merely alter an
in-memory result: the focused test is exit 1 with 0 pass / 3 fail / 4 expects,
including `ally/1 → hostile/1` and `ally/2 → neutral/1`. Restoring the real
path is exit 0 with 3 pass / 0 fail / 14 expects.

This is not a schema-migration, multi-writer, cross-file crash/power-loss,
NFS/SMB, or deployment-completion claim. Those boundaries remain open even
when the local same-pair transition is correct.

## A local timeout may document bounded suite cost, not weaken a test (2026-09-29)

The first clean full run was not green: its sole failure was the restart-safe
compiled-session state-limit target at 5023ms, above that target's default
5000ms budget. Three target-only measurements (2884/2868/2911ms), the restart
file's 4337–4614ms load, and a roughly 6247ms Worker with no residual process
showed bounded Windows/full-suite scheduling cost rather than an unbounded
hang. The target has no Worker of its own; it constructs two durable
catalog/snapshot sets, performs synchronous persistence, and fresh-rehydrates
them repeatedly.

The repair is deliberately local: a reason comment plus that one target's
10000ms timeout. It changes neither assertions nor any global test or
production timeout. Afterward the target was 2987ms, the restart file was
green, and the subsequent clean full suite was green. This sequence must be
recorded as one red run repaired by a local budget correction, not as proof
that broader restart, deployment, or production limits are complete.

## Candidate work keeps its source session alive until installation settles (2026-09-29)

For an ordinary durable HTTP action, the source session remains the registry
lifecycle authority while its FIFO awaits a staging candidate, commits durable
state, and installs the candidate. Candidate activity does not refresh the
source session's `lastActiveAt`. Treating that await interval as idle lets a
TTL cleanup remove and close the source at exactly the point a candidate can
still commit, turning a successful durable action into
`ordinary_registry_replaced` at installation.

The lifecycle guard must reuse the actual FIFO transaction boundary rather
than infer activity from timestamps: expose the existing in-flight counter as
read-only `hasActiveActionTransactions`, increment it on FIFO entry, decrement
it in `finally`, and make cleanup skip an active source. This preserves normal
idle TTL eviction and changes neither TTL policy, CAS, nor the cross-process
protocol.

The evidence is an HTTP interleaving that first observes cleanup returning the
source UUID rather than an empty cleanup result, and a real removal of the
guard that turns the regression red again. It is not a data-loss or
authorization-bypass repair, and it does not prove cross-process action
protection, global lifecycle atomicity, or deployment completion.

## Store ownership must follow construction, not merely the concrete type (2026-09-29)

An injected `NPCStore` is caller-owned even when the caller happened to create
it freshly. A `GameSession` owns only the private store it constructs itself;
only that store may be closed or carried through portable snapshot
export/restore. Closing every store during direct-action fail-stop turns one
session's late error into a different session's closed-database failure when a
caller intentionally shares an injected store.

Fail-stop therefore closes only a session-owned store. A caller-owned store
remains usable by its other owners, while the failed session remains stably
unavailable. Caller-owned snapshot export/restore must fail closed rather than
silently claiming portability. Server-created ordinary sessions should use the
constructor-private path instead of injecting a needless fresh store.

This is an ownership and lifecycle boundary, not atomic rollback: source
revision/ABA defense, coordinated component installation, cross-store rollback,
and full action commit semantics remain separate open work.

## 玩家动作必须消费既有领域 transition（2026-09-29；典籍阅读纠正）

玩家动作不是一组可任意拆写的字段更新。`GameSession.handleRead()` 曾直接增加
CM，绕过 `SanityEngine.learnCthulhuMythos()`；同一阅读因此漏掉 maxSAN 降低、
currentSAN 截断、99 封顶和 `mythosLog`。修正是让动作消费唯一既有 transition，
而不是在动作层复制其中一部分规则。

回归必须从真实 `act()` 路径证明整组不变量，并验证回合持久化与普通快照投影仍与
领域状态一致；只测 helper 不能证明玩家入口已接线。这个纠正不意味着住院、治疗、
长休或行动惩罚已有可执行产品协议；它们仍是独立的开放边界。

## WAL snapshots require one consistent read transaction (2026-09-29)

In WAL mode, several autocommit reads are not one snapshot: a writer may commit after `createSnapshot()` reads entities but before it reads `event_log`, yielding a state/event/context mixture that never coexisted. The legacy CLI/debug snapshot therefore reads state, recent events, and context text in one deferred read-only SQLite transaction. It ends that transaction before inserting the historical snapshot row, which avoids `SQLITE_BUSY_SNAPSHOT` when a concurrent writer has committed.

The resulting history row is an internally consistent, possibly earlier observation. It is not globally linearized with its later INSERT, and it does not coordinate two `WorldState` implementations, per-instance `currentRound`, multiple writers, or ordinary/compiled HTTP boundaries.

The regression uses two real `WorldStateManager` instances over a temporary WAL file. B performs real `applyDamage` plus `logCombatEvent` between A's entity read and its old event query: the old path is red at exit 1 with HP 10 plus event_count 1. The transaction repair returns HP 10, event_count 0, and no new context event; a real mutation removing that read transaction is red again. Restored directed verification is 10 pass / 0 fail / 64 expects.

## 可用性列表与身份 inventory 不能共用错误策略（2026-09-29）

给人看的 legacy 会话列表是可用性视图：已枚举 leaf 先经 `lstat` guard，只有 regular、non-link
文件才读取；坏 JSON、形状错误、leaf I/O、symlink 或其他非普通 leaf 都可 warning 后逐项 skip，
使健康项仍然可见。旧无 guard 路径因 unsafe leaf 被计入而红（exit 1，1 pass / 1 fail）；删除
guard 的真实变异也红，恢复后转绿。Windows 无法创建真实 symlink（EPERM）时，测试只在狭窄的
`lstat` seam 模拟该 leaf；实际读取、JSON、形状与列表代码仍会执行。

身份和 namespace inventory 则必须 fail-closed，保留 quarantine 与 collision evidence；不能将它们
降级成“跳过坏项继续列”的人类列表语义。根目录创建/枚举失败同样必须上抛，不能伪装为空结果。
这不是 fd-level nofollow 或完整 Windows reparse-point 治理：`readdir → lstat → read` 的 TOCTOU
仍在；也不顺带完成 durable retention/TTL 策略。

## 别名判定必须在持久化边界规范化（2026-09-29）

解析或判定层把 `investigation` 当作 `spot_hidden` 的别名，只说明这一次读取能找到
正确技能；若成长标记仍持久化 raw `investigation`，后续休息或模组结算会把增量写成
`skillValues.investigation` 幽灵字段，而真正的 `spot_hidden` 不变。别名解析与持久化写回
因此必须使用同一 storage-key 规则，且该规则要同时用于 mark 和 consume，不能只修其中一端。

规则的顺序也属于兼容性契约：直接存在的存储 key 优先，即使它是已经持久化的旧 raw
marker；只有直接 key 不存在时才查 `COC_SKILL_ALIASES`/`SKILL_NAME_MAP`，并且映射得到的
规范 key 必须实际存在。未知 key 原样保留，而不是凭名称猜测后新建字段。这样真实别名会
回写到已有规范字段，同时 ordinary snapshot restore 仍能消费历史 raw marker；它不改变骰法、
99 封顶、字段优先级、消息、清空时机或成长标记的 owner 语义。

## 模组增量必须在成功发布时留下历史起点（2026-09-29）

“本模组变化”不是从结算时的角色当前值可以反推的量。若 SAN/CM 起点只会被导出、恢复和读取，
而从未在生产加载路径写入，结算只能拿当前 `maxSAN` 与 0 当 fallback：开模前已经损失的 SAN 和
已有 CM 会被误记为本模组变化，离场再写 0/0 也只是另一种伪造履历。

起点的正确边界是成功发布：ordinary 模组已安装且入口已经发布后，才为当时存在的 PC 捕获 SAN/CM；
之后成功发布的 late join 或同 ID 角色替换，以该角色真正进入会话时的当前值新增或覆盖自己的起点。
加载失败、半安装和未发布入口都不得污染基线。恢复则应保留已序列化的历史起点，不能从恢复后的
当前状态倒推；compiled 的不同生命周期尚未建立证据时也不能借 ordinary 规则擅自接线。

结算和离场必须共用同一 delta 解释。对于历史 snapshot 中显式存在却为空的 ordinary 起点 map，
技能结算在掷骰、写卡和清 marks 前 fail-closed，以免把未知证据变成数字；离场的会话结束事实可以
照常成立，但履历没有证据就只给明确警告、不写假的 CareerEntry。这样把“能否结束”与“能否证明
职业增量”分开，也不以 `maxSAN`/0 或 0/0 伪装兼容性。

## 延迟技能成长必须把 owner、快照迁移与执行核分开（记录纠正，2026-09-29）

本节补正先前把技能成长 marks 描述为无 owner、并把休息与模组结算描述为两个未收敛主体的
历史记录。那是旧实现的事实；当前 ordinary 路径的权威 pending state 是
`Map<pcId, string[]>`，不是全局数组。延迟语义的消费者（rest、module settlement）可以有各自的
消息和流程格式，但 mark 必须在产生时绑定行动 PC，消费必须指定同一 owner；否则 active PC 的
临时视图会在多 PC 情形变成错误的生产真相。为兼容旧调用保留的 `skillGrowthMarks` facade 只能显示或
修改 active-PC view，不能倒过来成为存储模型。

当状态从一个无 owner 的数组变成 owner-indexed entries 时，变化的是 schema 形状，而不只是字段名。
因此 ordinary snapshot 必须升版本，并且 legacy 1.0 必须先按它自己的 envelope、components、state
和 canonical hash 验证；只有这个先验验证成功后才可迁移和以新版本重新签名。不能用“先转换、再验
新形状”掩盖旧快照的篡改，也不能把新 schema 的 hash 规则投射回旧文件。

迁移不是猜测器。空 legacy marks 不携带归属证据，可以在多 PC 情形安全地变成空 owner map；非空
marks 只有在恰有一个 PC 时才可归属。零 PC 或多个 PC 的非空 marks 是不可消除的歧义，必须
fail-closed，而不是按 active PC、排序第一人或每个 PC 复制来伪造历史。

共享性应落在不依赖调用方呈现的执行核：同一个 `applySkillGrowth` 承担掷骰、storage-key 解析、
99 钳位与角色写回。rest 和 module 可以据 outcome 生成不同消息、累计或履历格式，但不得各自重写
成长规则。该闭合不自动授权 compiled path 采用 ordinary 生命周期，也不解决无 ordinary module 时
CareerEntry delta fallback，或 CareerStore 写失败后的可重试/原子持久化语义；这些仍需分别建立证据。

## Career JSON：损坏不能等同缺失（2026-09-29）

`CareerFileStore` 的 read recovery 只能把精确的 `ENOENT` 解释成尚未创建；截断、坏 JSON、非法
schema、I/O 与身份/路径不绑定都必须继续失败，不能把已有证据抹成空档案后再覆盖。v1 解析和验证
必须集中在一处，并覆盖 root/version/base/entries、时间戳和有限数值、必需的非空 ID/name、
identity/path binding 以及 entry ID 唯一性；列举也要拒绝 unbound/misbound 文件。

幂等性依据 canonical content，而不是“同 ID 就成功”：同 ID 且同一 canonical entry 才是 no-op，
同 ID 不同内容必须冲突失败。持久化顺序是同目录 UUID 私有 exclusive temp 的完整写入、file fsync、
close、rename、directory fsync；Windows 仅对 directory fsync 的精确 `EINVAL`/`EPERM`/`EISDIR`
例外，且只清理本 store 创建的 temp。它减小重命名边界的风险，不承诺 safe-name collisions、
symlink/reparse/root confinement、多写者 CAS/lost update、跨文件/跨 store transaction 或跨平台掉电保证。

六例真实完整性回归先让旧实现以 0 pass / 5 fail 退出：截断文件的 `addEntry` 没有抛错且被覆盖；
恢复 catch-all `null` recovery 的生产变异也以 3 pass / 3 fail 转红，精确恢复后为 6/6/34。fixture
occupation 同时校正为生产本来就使用的 `label`/`id` string。首次 full run 的单一红灯来自 admission
测试把负载下的真实时钟 TTL 误判为 busy→quarantine；共享受控 clock 使该文件 65/65/710。随后 serial
run 的三项 compiled-session access-control 默认 5s timeout 没有 assertion mismatch；确认 durable FS
工作有界且无泄漏后，才只将那三个测试局部限时 15s。最终 `bun test --parallel=1` 为 4092 tests /
329 files / 4060 pass / 32 skip / 0 fail / 23897 expects（310.43s）。

## 持久化逻辑身份不能由 lossy 文件名承担（2026-09-29）

角色名是逻辑身份，不是可逆的文件组件。把 `/`、`:` 或空白统一替换成 `_` 会让不同角色落到同一
路径；后来用内容 identity 拒绝串读虽能避免覆盖，却仍会让第二个合法身份无法存储。新布局应从完整
逻辑名得到 case-insensitive-safe 的固定 v1 文件名；本实现使用 SHA-256 的 UTF-16 code-unit 输入。
哈希不是身份真相：读出的 JSON 仍须绑定其逻辑 identity，任何罕见 hash collision 都必须 fail-closed。

兼容旧布局不是悄悄搬家。仅有一个已验证的 legacy 文件时可以原地继续读写；同一 identity 同时出现
v1 和 legacy 文件，或新旧候选无法唯一选择时，必须拒绝而非猜测、合并或覆盖。列举也必须把文件名、
内容 identity 和唯一性一起验证。

文件系统隔离的证据需要按能力分层。root/leaf 的 lstat、realpath、dev/inode 检查，以及 POSIX
`O_NOFOLLOW` 是静态防线；Windows/Bun 的 file symlink 与 junction probe 返回 `EPERM` 时，相关三例
测试只能计为明确 skip，绝不能写成 reparse 动态通过。任意非-symlink reparse tag 和 Windows 的
lstat/open TOCTOU 仍是开放边界。

测试也不能复制生产哈希算法，否则两处同错会一起变绿。它应在指定 session 目录严格枚举唯一
`.career.json`（零个或多个都失败），再通过 store 校验逻辑身份；这样既验证实际落盘和 root 隔离，
也不把私有布局反变成外部契约。

## Same-identity JSON writers need a durable ownership boundary (2026-09-29)

An atomic rename preserves one replacement; it does not serialize a
read-modify-write sequence performed by two `CareerFileStore` instances. The
coordination key must therefore derive from the non-lossy logical identity, not
from whichever legacy or v1 physical data file is selected. A same-identity
lock is an immediate fail-closed `O_EXCL` private leaf: a busy or crash-left
lock is not evidence that it is safe to overwrite, so no mtime/TTL reclaim is
valid without a fence.

The lock is owned by more than its path. Its random token and the filesystem
identity pinned from the created file descriptor must both match immediately
before release. If an outside actor has replaced the leaf, leave that foreign
leaf in place and report the operation as uncertain; deleting it would turn a
storage failure into destructive interference. This still does not create a
cross-file transaction or eliminate Windows path/open/unlink TOCTOU.

Concurrency regressions need a deterministic real boundary, not timing luck.
Two child stores can pause after their real read and before their actual write
by replacing only that test instance's private method; production receives no
environment switch, public setter, or test hook. Start the competitor only
after the holder reports that it reached the barrier: process spawn order is
not synchronization. A capability failure to make a symlink is an explicit
skip in the baseline, not evidence that reparse rejection dynamically passed.

## Retire a dead persistence authority only after three independent checks (2026-09-30)

Removing a second persistence implementation is safe only after proving three
separate facts: no production or test call surface constructs it, no package or
other public export makes it a supported external API, and no legacy data file
exists that would require a migration. These are different claims. An unused
class alone does not prove an external consumer cannot import it; no import
alone does not prove an operator has no data to preserve.

Once those checks hold, leave the shared domain types and pure state functions
in their dependency-light module, and make the production composition root
name the sole storage class explicitly. The authority regression should inspect
the real module namespace, parsed runtime imports, and production composition;
a test-created object that merely resembles module exports can never detect a
restored executable store. Machine-local absence of a database is investigation
evidence, not a permanent test assertion.

This removes an unused SQLite/JSON split without claiming a migration protocol:
there was no supported caller or legacy career database to migrate. It does not
settle CareerFileStore locking, reparse, crash recovery, cross-file atomicity,
or power-loss boundaries.

## Ordinary snapshot promotion must preserve the evidence it has not yet normalized (2026-09-30)

The earlier 1.1 ordinary-snapshot note is historical, not the current schema.
Schema 1.2 adds the Career projection by reusing the one `CareerFileStore`
parser rather than accepting a second, snapshot-specific Career shape. A
complete current snapshot is an exact replacement. Legacy 1.0 and 1.1 are
different evidence: each must first pass its own original hash and shape
validation, after which only its local history bases are retained. Validating a
rewritten legacy object against 1.2 would turn a migration into a forgery
detector with the wrong evidence source.

The v1.4 outer envelope may carry that embedded history without changing old
receipts or AVL state. It becomes a new representation only after the next
successful action, when lazy upgrade is allowed. Premier KP-note keys must be
serialized in canonical order for the same reason: stable identity belongs to
the established representation, not to incidental object insertion order.
Four local legacy outer-1.0 envelopes remain explicitly unsupported. This is a
bounded compatibility rule, not a claim that arbitrary historic outer envelopes
can be restored.

## Durable ordinary errors are part of the commit contract (2026-09-30)

The old description that ordinary `CareerStore.addEntry` failures were merely
warned and swallowed is superseded. Both departure and skill restoration paths
now propagate the failure to the candidate boundary: the HTTP result is a
stable 500 code with no internal body detail, generation g2 is unchanged, and
no receipt is written. Retrying the repaired same action ID then commits g3
once, rather than treating the failed attempt as a receipt-bearing partial
success. A direct unexpected `runAction` exception likewise has the stable
`ordinary_execution_failed` surface.

This is not cross-file atomicity. Source-revision/ABA defence, cross-file
transactions, and power-loss behaviour are still separate open work. The
method is to assert the externally durable observations together--status,
generation, receipt, and restart result--rather than call a caught exception
"handled" because a local method returned.

## AVL cache cleanup needs structural counterexamples (2026-09-30)

An equal hash is not enough to discard a checkpoint-map leaf: RL and LR AVL
double rotations can leave a same-hash leaf reachable after a superseded
cleanup candidate has been chosen. The regression therefore uses both rotation
shapes, verifies that the reachable leaf survives, and permits cache reuse only
when the remaining entry is legal. It also asserts the performance contract:
200 actions copy zero checkpoint maps and cleanup performs no O(n) `Map`
enumeration.

The evidence is mutation-based at the public boundary. Restoring either
departure or skill catch-swallowing turns the expected 500 into 200; restoring
a raw error body leaks implementation detail; restoring the old
cache/superseded handling makes g3 fail as `ORDINARY_SNAPSHOT_INDETERMINATE`.
Each mutation is red and the precise restoration is green. The directed set is
92 tests in 6 files, all passing (668 expects), with career 5/62, ordinary
durable 32/178, skill 9/26, departure 15/46, direct 7/27, and snapshot-store
24/329. Root's serial full suite is 4123 tests / 334 files / 4087 pass / 36
skip / 0 fail / 24121 expects; typecheck is clean. These results establish the
stated local contracts, not the still-open cross-file or power-loss guarantees.

## Resource limits are admission rules, not merely parser preferences (2026-09-30)

The earlier integrity notes did not establish a resource boundary; this is a
correction, not a retrospective claim that shape validation alone bounded work.
`CareerFileStore` now admits at most 2 MiB of raw or portable data, 4096
records/entries/members/root entries, 128 lock bytes, 256 identity/key units,
4096 ordinary-field units, 64 KiB long text, and 128 timestamp units. The
limits cover both transport and persisted forms so that an import cannot evade
the store's disk-read limit, or vice versa.

The order is part of the contract. Decode untrusted bytes with strict UTF-8;
use a post-read `fstat` check and the observed size for allocation; stream the
root rather than materializing an unbounded object; and finish preflight before
any mutation. A cap checked after a full `readFileSync`, a replacement-sized
allocation, or a permissive replacement character has already admitted the
resource failure it was meant to reject.

The mutation evidence distinguishes those errors: restoring unbounded
`readFileSync` is 14 pass / 3 skip / 2 fail; removing the entries cap is
15 / 3 / 1; removing fatal decoding is 18 / 3 / 1; and restoring limit+1
allocation is 18 / 3 / 1. Exact restoration is 19 pass / 3 skip (22 total).
This validates the stated local bounds, not global root CAS, dynamic reparse
handling, lstat/open/release-unlink TOCTOU, stale-lock recovery, cross-file
transactions, or power-loss semantics.

## An unwired-method baseline must not absorb a boundary leak (2026-09-30)

A first implementation exposed budget helpers publicly and moved the probe's
no-callers result from 60 to 61. Raising the baseline would have made the
diagnostic pass while preserving the accidental public surface. The closure is
internal instead: the final probe returns 60 no callers, 70 test-only callers,
and 47 should-private methods, so the existing 60 ceiling remains in force.
Counts are evidence of the actual surface, not a budget to be edited upward
after every leak.

The root-authoritative serial suite for this semantically equivalent resource
closure is 4133 tests / 334 files / 4097 pass / 36 skip / 0 fail / 24152
expects in 286.18s, with typecheck clean. An earlier run of the same complete
set reported 24168 expects; this is runtime assertion-count variation, not
evidence that tests were omitted. That result establishes the bounded admission
rules above; it does not broaden the unresolved filesystem or atomicity claims.

## A session listing has two different error policies (2026-09-30)

The original todo-38 statement that one malformed JSON file necessarily
crashes `listStoredSessions()` is historical: the already-present dirty-tree
implementation had changed the human listing to per-leaf warn-and-skip, but
the todo had not taken ownership of that fact. This slice completes the
remaining resource and identity boundary rather than rediscovering the old
fix.

The human-facing list is an availability view. A regular, identified metadata
file with bad content or list shape warns and is skipped so healthy sessions
remain visible. The namespace locator is an identity inventory, not that view:
oversize input, invalid UTF-8, and invalid JSON remain regular-but-invalid
collision evidence. I/O, root, or path-identity uncertainty fails the whole
namespace operation closed. Reusing the convenient human-list policy there
would make an ambiguous identity disappear.

Metadata files are limited to 1 MiB and the root's total entries to 4096.
Enumeration is streamed through `opendir`; read identity is verified across
`lstat`, open, `fstat`, and path checks; POSIX adds `O_NOFOLLOW`; UTF-8 is
fatal; allocation follows observed size plus one. These steps distinguish a
bounded bad leaf from uncertainty about which leaf was read.

## Persisted session metadata must be bounded before mutation (2026-09-30)

Saving first serializes and applies its byte cap, then uses a UUID,
`O_EXCL` 0600 temporary file, write-all, file fsync, identity recheck, rename,
and only the precise Windows directory-fsync exceptions. A post-write cap is
not an admission boundary: it can have already materialized or partly
published the oversized object.

The new resource cases are red on the old implementation while its two
pre-existing cases remain green; the restored resource file is 8 pass / 0 fail
/ 23 expects. Restoring unbounded `readFileSync`, permissive
`fatal: false`, or removing the write cap independently turns the intended
regressions red, and exact restoration returns green. The root-directed set is
8 pass / 0 fail, and the four-file integration is 66 pass / 0 fail / 394
expects.

This closes todo-38's explicit listing-resilience problem and its local
resource/identity/save boundary. It does not establish multiwriter CAS,
protection from a same-inode/same-size external rewrite, cross-file
transactions, NFS/SMB behaviour, or power-loss guarantees.

## Realtime owner handshakes authorize before locating state (2026-09-30)

A realtime handshake must authenticate before it parses any session locator or
touches a namespace, snapshot, or live registry. The authority is the durable
owner binding plus the namespace identity that agrees with the fully validated
envelope; a query-supplied role is transport input, never authorization. The
transport role must therefore be derived by the server, and a rejected
handshake must not construct or restore a `GameSession` merely to decide that
it is unauthorized.

Handshake authentication proves only admission at that moment. It does not
provide connection-period revocation, credential rotation, or per-person audit
semantics; those require their own authenticated credential and lifecycle
protocols.

## LLM transport limits must be enforced locally, not implied by request options (2026-09-30)

`max_tokens` is a model-generation hint and `AbortSignal` is a cancellation
capability; neither is memory accounting nor a completed deadline guarantee.
The client must therefore apply fixed local byte caps, count bytes actually
observed rather than trusting `Content-Length`, and race every awaitable
transport operation against one explicit absolute deadline. Cleanup must not
await a noncooperating reader or cancellation path, including when a streaming
consumer returns early.

For a successful nonstreaming 200 response, the client uses a fixed,
non-exported 2 MiB raw-body cap, a `Content-Length` precheck, an observed-byte
gate, fatal UTF-8 plus JSON parsing, an opaque `invalid_response`, and the same
absolute deadline through body consumption. Streaming chat separately uses a
fixed, non-exported 4 MiB total raw cap and a 256 KiB pending SSE line/event
cap. It enforces declared and observed lengths; races fetch and every
`reader.read()` against that deadline; flushes UTF-8 at EOF fatally; rejects
malformed JSON or deltas fail-closed; and performs nonawaited reader cleanup
and cancellation. Standard SSE `data:` accepts an optional space, comments,
and unknown fields. The existing breaker policy remains intact.

Mutation evidence must exercise transport behavior, not just a parser: the
old `resp.json` oversize path was red, removing the observed gate read tail 34
instead of expected 33, the old stream rejected legal no-space `data:`, and a
noncooperating fetch hung. Replacing `Promise.race(reader.read, deadline)`
with raw `reader.read()` produced `{state:'hung'}` at about 79 ms; restoration
was green. Mutation tests themselves can leak processes, so their harnesses
must self-bound and post-run process inventory is part of credible evidence.
One initial full run was invalid after two subagent Bun mutations leaked (PID
26704 at about 10.3 GB and PID 14192 at about 690 CPU seconds), causing eight
timeout/cascade failures; only those processes were killed and the user
service PID 18708 was preserved. The stable rerun was 4163 tests / 337 files /
4127 pass / 36 skip / 0 fail / 24231 expects in 295.55s, with typecheck clean.

These limits are client-internal policy. They do not prove external provider
behavior, model quality, or rate/cost governance; those remain production
boundaries to establish separately. `docs/notes/index.json` remains
intentionally stale/delayed.

## Ordinary/general JSON bodies need transport admission, not parser optimism (2026-09-30)

`Content-Length` is metadata, not an allocation proof: count observed bytes as
well. The ordinary/general `server.ts` reader uses 8 KiB player/action and 1
MiB general/module caps, fatal UTF-8, record-only JSON, and 413/408/400; auth
remains before body consumption.

Body absence differs from a zero-byte body: only `req.body === null` keeps
bodyless session-create compatibility. Start one five-second absolute deadline
before the loop and race every `reader.read()`; per-chunk timeouts admit a
slow-drip bypass. Propagate abort, then cancel/release without awaiting hostile
cleanup.

Evidence must exercise the real boundary: old over-1-MiB underdeclared input
returned 201 and constructed a session, while a stalled abort exceeded 250 ms.
Removing the observed-byte gate again returned 201 rather than 413; restoration
was green. The four-case focused file, 94-test directed set, typecheck, and
4167/338 serial suite all passed. This is not real-socket slow-client
acceptance.

The old `readJsonBody`, `readBoundedJsonRecord`, and direct `req.json` paths
are gone. `compiled-module-http.ts` `bodyBytes` remains separately deferred:
no explicit body deadline, awaited cancel, and nonfatal UTF-8. Preflight is
unverified after sandbox cmd.exe-spawn EPERM and rejected escalation.
`docs/notes/index.json` is intentionally stale/deferred and was not changed.

## Compiled-module body reads need their own host-owned deadline (2026-09-30)

A body-read deadline is not a compile deadline or a model deadline. It begins
at the HTTP admission boundary and races every individual read against one
absolute stop condition and the request signal. The host may configure the
bounded policy, but request headers and bytes must never choose it. JSON/PDF
caps remain byte admission rules; a shared tagged result makes the binary-byte
stage distinct from fatal UTF-8 JSON decoding, so bodyless JSON can remain
`JSON_INVALID` while bodyless PDF remains `PDF_EMPTY`.

Reader cleanup is a liveness concern, not a completion dependency: release the
reader immediately and let cancellation settle in the background rather than
awaiting a hostile `cancel()`. Test the resource boundary in isolation as well
as its HTTP routes--including an independent PDF deadline--so a compile or
model timeout cannot accidentally stand in for body admission evidence. This
closes the previously deferred `compiled-module-http.ts` body-read boundary,
not real-socket slow-client or proxy/host integration, external provider/model
behavior, or rate/cost governance. `docs/notes/index.json` is intentionally
stale/deferred and remains unchanged.

## WebSocket runtime defaults are not product resource policy (2026-09-30)

A runtime default is a capability, not an application admission decision. First
minimize the protocol: the ordinary channel supports compatibility ping only,
so its payload cap is correspondingly small. Enforce that cap at the wire and
again in the handler, measure UTF-8 bytes rather than JavaScript characters,
and reject oversize input before decoding or parsing. Bun backpressure needs
an explicit limit plus close-on-limit policy; its permissive defaults do not
make a slow client safe.

The production handler factory and its `Bun.serve.websocket` wiring are part
of that boundary, not incidental plumbing. A mutation that removes the wired
factory's payload policy must make the regression fail, otherwise a tested
standalone handler can silently diverge from production. This proves the local
wire and handler policy only; dynamic slow-client disconnect behavior, rate
limits, credentials, and cross-process lifecycle remain separate work.

## Outbound LLM requests need deterministic admission before resilience logic (2026-09-30)

An endpoint breaker describes provider health; it must not turn deterministic,
local invalid input into an apparent provider failure, nor hide that failure
while the breaker is open. Normalize and validate the runtime message shape,
role/content domain, counts, aggregate UTF-8 content, model/config scalars,
and fixed serialized request budget before acquiring the breaker, fetching, or
entering retry. `chat` and `chatStream` must share that one construction path;
a streaming generator performs it at its first iteration, and every retry
reuses the already-built body rather than rereading user-owned getters.

The serialized-body cap is still necessary after aggregate content accounting:
request envelopes and configuration strings are variable. But measuring only
after `JSON.stringify` permits an oversized model/config string to allocate
first. Preflight those variable strings before serialization, then enforce the
final UTF-8 byte cap on the one serialized body. This is local resource and
cost-exposure containment, not evidence of provider/model quality or of global
request-rate, quota, or cost governance.

## A host request cap is an outer ceiling, not an endpoint contract (2026-09-30)

The Bun host's default request-body allowance is a runtime default, not a
product admission policy. The production server now chooses an 8 MiB outer
ceiling because compiled PDF is the largest legitimate endpoint, and a real
socket test proves a limit-plus-one request is rejected before application body
handling. That outer ceiling does not replace the endpoint-specific 8 KiB
player/action, 1 MiB JSON, and 8 MiB PDF caps; those are independent, narrower
semantic contracts and remain enforced by their own readers.

An exact-at-limit request reaching the authenticated PDF reader and being
rejected as an invalid PDF distinguishes host admission from application
validation. It does not establish proxy/deployment behavior, slow-client or
backpressure handling, connection/request rate limits, or credential and
cross-process lifecycle policy. `docs/notes/index.json` is intentionally
stale/deferred and was not refreshed for these entries.

## Sensitive configuration must authenticate before it is observable (2026-09-30)

A configuration endpoint is an authority boundary, not a harmless diagnostic
read. Authenticate before loading configuration, deriving world-model status,
counting sessions, or setting up compiled routes: otherwise status codes,
latency, shape, or failures can disclose whether a deployment is configured
and what subsystems it has. The required order is authentication first, then
the operator gate, then the existing configuration work. Thus an anonymous
caller receives 401, unavailable/malformed/throwing authentication receives
503, and an authenticated keeper or player receives the opaque
CONFIG_OPERATOR_REQUIRED 403 without observing the protected work.

Once admitted, preserve the operator contract rather than creating a second
diagnostic API: retain the existing response shape and mark it no-store. A
protected subroute does not make the public API root private, and it does not
by itself provide an IdP lifecycle, browser/player credentials, per-person
audit, or deployment policy. Those are separate production boundaries.

The regression method is to make the no-observation claim executable: arrange
spies/failing dependencies for every protected read and prove that each denied
principal is rejected before any one fires. A mutation removing the real
operator gate must then make the public behavior red. This distinguishes
authorization order from merely checking the eventual status code.

## Provider concurrency is local admission, not rate or cost governance (2026-09-30)

For outbound LLM work, use one explicit sequence: deterministic local
build/validation, breaker acquisition, no-queue in-process admission, then
transport. Admission is keyed by normalized endpoint so spelling variants do
not evade the shared total cap; API keys do not create independent buckets.
The adopted local policy is a total of eight concurrent requests per endpoint
and four each for default, intent, and narration. Capacity exhaustion is a
typed but opaque admission_limited result, rather than an unbounded wait.

Lease lifetime follows the logical operation. A retrying chat keeps one lease
across all transport attempts. A stream acquires only on its first generator
iteration, not when the generator is created, and releases only after consumer
early return, abort, EOF, or error. If a half-open breaker admission fails, its
probe must be released; defeat/reset handling likewise must not erase slots
owned by still-active work. These are liveness and accounting rules, so test
them with deterministic controlled fetches and mutations of the real release
path rather than timing-dependent bursts.

An in-process burst cap is not distributed rate limiting, provider quota
enforcement, cost accounting, or cross-process coordination. It also says
nothing about provider availability or model quality. docs/notes/index.json is
intentionally stale/deferred while its parallel edit awaits refresh. The formal
post-document preflight exited 1: five internal cmd.exe spawns across typecheck,
bun test, probe-unwired, and git config hooksPath failed EPERM: operation not
permitted, uv_spawn C:\Windows\system32\cmd.exe. Its document reference,
payload, and interlink checks did run (274 boolean returns and 0 discarded);
git ls-files was unavailable, so it checked only that referenced scripts exist,
not whether they are tracked. The preflight bun test has no summary and is not
passing evidence. Keep the independent direct evidence separate: typecheck
exit 0, full 4191 / 344 / 4155 / 36 / 0, probe 60 / 70 / 47, and hooksPath
.githooks.

## Browser owner bearer isolation and scripted admission are local boundaries (2026-09-30)

An owner Bearer held by browser code is a capability, not an application-wide
default header. Keep it in one module's memory rather than browser storage;
reject malformed, whitespace-normalized, or comma-bearing input instead of
repairing it; and let only the explicit owner call sites use the wrapper.
The wrapper must own the authorization header, use `credentials: same-origin`
and `redirect: error`, and reject a caller-supplied authorization header. Its
URL rule must be based on the canonical final URL, not a string-prefix check:
protocol-relative, backslash-disguised, and other values that normalize to a
foreign origin are cross-origin and must never reach fetch. Player façades and
unrelated raw-fetch integrations remain separate authority surfaces rather
than accidental consumers of the owner bearer.

For legacy scripted HTTP, authorization comes before observation. Authenticate
and compare the owner binding before parsing a locator, reading a body, looking
up a registry entry, consuming a cursor, or updating activity. An opaque
foreign/unknown response is only meaningful when those rejected paths have no
such side effects. Store the creator binding as a digest, use collision-aware
CSPRNG identifiers, roll back a synchronous start failure, and mark successful
or capacity responses no-store; these make the narrow local contract
testable.

A fixed entry cap and idle timeout bound only an in-process legacy registry.
They are neither durable storage nor recovery, multiprocess coordination,
distributed rate/cost governance, an IdP, credential rotation/revocation, or
per-person audit. Treat those as separately open production work rather than
promoting a bounded process-local cache into a lifecycle guarantee.

## Static delivery is a single interpretation boundary (2026-09-30)

The document root, ordinary non-API asset routes, and SPA fallback must not
each reinterpret a request pathname. They delegate to one static-delivery
boundary so that the same fatal decoding, root-relative grammar, containment,
regular-file rule, cache policy, and response headers apply regardless of
which server branch reached it. A deployment-selected build root is a trust
input: this policy is not a claim that a hostile actor may concurrently replace
that root or its contents safely.

Reject control/NUL characters, backslashes, colons, empty segments, `.` and
`..` segments after fatal decoding. This is a segment grammar, not a broad
punctuation ban: `app..js` is an ordinary legal filename. Resolve natively,
compare native relative paths, then realpath and verify containment before
serving only a regular file. That prevents an already-present symlink or
junction from redirecting lookup outside the root at the time it is checked;
it does not close TOCTOU for an adversarially mutable build root. Missing
extension-bearing resources stay 404 instead of becoming HTML fallback, while
hashed assets can be immutable and other static replies remain no-cache.

Browser policy belongs to every static response, not only HTML: nosniff,
no-referrer, DENY framing, and disabled camera/microphone/geolocation. HTML
also needs an explicit CSP for default, script, style, image, media, connect,
font, frame, frame-ancestors, base, form, and object behavior. Same-origin
scripts without inline or eval and `connect-src 'self'` are the intended
contract. `style-src-attr 'unsafe-inline'` is retained as the narrowest
compatibility exception for real Vue dynamic styles; frame ancestors, base,
form, and objects are none.

The proof must cover the real server route as well as the helper: a mutation
of the actual CSP path must fail both a focused check and a server subprocess,
then exact restoration must pass. Keep environment evidence separate: a
proxy-environment frontend build that succeeds after elevation does not prove
that a root-environment build previously blocked by sandbox EPERM was rerun.
Likewise, local static routing and headers do not establish TLS/HSTS or
reverse-proxy behavior without deployment-level tests. `docs/notes/index.json`
remains intentionally stale/deferred, and todo-64 remains open for those
deployment, mutable-root, and identity-lifecycle boundaries.

## HEAD is GET validation without a representation body (2026-09-30)

HEAD must enter the same static GET validation, pathname interpretation,
resolution, and response-policy boundary; a separate permissive HEAD path
would make the method an authorization or traversal bypass. Its successful
response retains GET-equivalent metadata, including `Content-Length`, but its
body is `null`. Test the actual server behavior, not only a helper: replacing
that `null` body with the GET body must make the regression fail, and exact
restoration must return green.

This is a local HTTP semantic contract. It does not establish TLS/HSTS,
reverse-proxy behavior, or safety when an adversary can mutate the build root
while lookup is in progress.

## RNG mutation evidence needs a child-isolated process (2026-09-30)

A short-lived `Math.random` mutation in a shared test worker can contaminate
adjacent files because those files may interleave before the original function
is restored. A local `finally` is necessary but does not make that shared
worker a reliable isolation boundary. Run the mutation in a child process and
make the child outcome observable at a durable boundary. Here, removing the
0.5 protection made the durable module refuse the result because
`entities.hp` is `NOT NULL`; restoring the protection returned the adjacent
four-file set green.

The child demonstrates isolation for that regression only. It is not evidence
of production-wide randomness, multi-process durability, or the todo-64
production objective.

## Preflight spawn failures are not hook configuration evidence (2026-09-30)

The current sandbox preflight exits 1 after its static checks complete because
five internal process launches fail `EPERM`. Reproducing the failure with a
direct `shell: false` spawn and with absolute `process.execPath` shows that
`cmd.exe` is only a shell-wrapper surface, not the cause and not evidence that
hooks are absent. Keep this aggregate result separate from direct green test
and typecheck evidence; the repository's actual `hooksPath` is `.githooks`.
`docs/notes/index.json` refresh remains intentionally deferred.

## 普通 CoC 技能成长应由成功使用触发（记录纠正，2026-09-30）

此前 ordinary `GameSession` 将失败检定写入延迟成长 mark；这与本项目采用的
CoC 成长语义不符。普通路径现在只有**真实成功**的、具有 canonical CoC skill
storage key 的技能使用才标记成长。Credit Rating、Cthulhu Mythos、属性和未知/非
技能 key 被拒绝；这不是按任意输入名称新建成长槽位的兼容 fallback。

该规则必须在所有真实 ordinary skill 检定入口一致消费：scene clue 的成功检定和
push 成功会标记；force-success grant 与 idea 分支没有实际成功技能检定，不能借用
其叙事成功制造 mark。pending marks 仍按 owner 存在、每位角色每个 canonical skill
去重，并由同一结算核经 rest、module settlement、snapshot 和 durable HTTP 传递。
旧 snapshot 的 raw `investigation` marker 则在消费前归一为 `spot_hidden`，避免写出
幽灵技能字段。

红测先证明旧实现漏记成功、错误记录失败、无法正确去重/持久化；将生产条件恢复为
`if (!success)` 的真实变异再次转红，精确还原后 focused 与 directed 集均恢复绿色。
这没有闭合 ordinary `handleAttack`：它尚未携带 canonical 武器技能 ID，因此攻击成长
仍是明确开放边界。当前三次完整 suite 均枚举 4218 tests / 348 files，却各有 58 个
fresh Bun/server-process 失败；不能把直接定向绿误记为完整绿，也不得更新基线。验收仍需
在用户终端复跑完整 `bun test` 和 preflight；`docs/notes/index.json` 继续延后刷新。

### 后续受管 runner 验证不应覆盖完整套件状态（2026-09-30）

后续主控复核中，preflight 的静态部分为 277 boolean / 0 discarded，但五个内部
`cmd.exe` launch 都为 `uv_spawn ... EPERM`，所以 exit 1 仍不是 preflight 通过。direct
probe 则实际为 exit 0（60 no callers / 70 test-only / 48 should-private）。

三次完整 suite 的 58 个失败应暂定为受管 runner 的累计/嵌套子进程边界，而不是把它们
写成已经定位的产品错误或已经消失：module-editor + ordinary admission（18/0/147）、
ordinary process restart + server namespace（7/0/20）、static delivery + namespace
coordinator（24/0/169）、compiled snapshot process + server host（28/0/130）、legacy
routes（2/0/3）及 server host 单独（1/0/6）均直接绿。反过来，shard 1/4 的 991 tests
仍有 5 个 cross-process failures；即使对应两文件直跑为 28/0/130，也不能把 shard 或
拆组成功升级成完整 suite 全绿。基线与 todo-64 的 open 状态不变，仍需用户终端复验。

## 普通徒手 combat 只有可验证技能才能标记成长（2026-09-30）

普通 `handleAttack` 与 `act` text fallback 现在只把正向、可验证的徒手/裸攻击绑定到
active PC 的 canonical fighting skill，并先叠加已有状态修正；成功执行后才写入该 owner
的 delayed growth mark。它不是“任意攻击成功就增长”的名称推断。

显式或未知武器（射击、铁锹、瓶子等）尚无权威 weapon→skill mapping，必须保留旧的
target=50 执行口径且不标记成长；无目标、燃运不足和 D&D 路径同样不能制造 mark。mark
仍经 snapshot restore、rest 与 module settlement 传递。初始红测、fixed-50 与删除 mark
两个生产变异均红，精确还原后的新文件为 5/0/53、主控定向为 143/0/527，typecheck 为 0。

新增五例使候选总量变为 4223 tests / 349 files；受管完整 runner 与 preflight 的环境边界
未解除，故不更新顶部 baseline，也不把该局部闭环说成完整 suite green。显式武器的权威
映射和 todo-64 继续开放。

### scripted owner 测试应隔离 durable 根而不是放宽全局时间（2026-09-30）

scripted owner 的不稳定根因是每次 `handleRequest` 在 scripted route 前，对共享 data 根执行
durable namespace reconcile（511–950ms）；九次累计使首项到 3.93/3.96/4.02s，
auth-before-locator 到 5.20/5.06s。改为临时 career/session 根并在 `afterAll` 清理后，
首项约 40–62ms、auth 约 38–59ms；真实 route、认证、locator 和 body 断言仍在，未增加
local timeout。

4097 root-entry I/O 用例三次为 2.59–3.36s，合并可至 4.65s，故只有这个 `it` 得到 10s
局部调度上限。双文件定向为 13/0/93，typecheck 为 0。最新完整 `bun test` 仍 exit 1：
4223 tests / 349 files / 4126 pass / 36 skip / 61 fail / 24620 expects / 357.95s；修复项不再
位于末尾，但剩余 fresh-process 失败仍随受管环境波动。这不更新 baseline、不构成完整绿，
todo-64 保持 open。

## 普通 CoC 急救和受击闪避增长都必须绑定真实成功（2026-09-30）

ordinary first aid 先使用 `first_aid`，仅缺失时使用 `medicine`。它只在成功**且**真实增加
HP 或移除 `bleeding`/`hemorrhaging` 时给该 owner 写 mark；无效治疗、失败、fumble、缺实体、
D&D 与 compiled 都不产生成长。初始 red-first 为 6/2/38，删除 mark 接线的真实变异同样转红；
还原后子代理 34/0/193、单文件 11/0/54、根首轮六文件 117/0/392。

NPC counter 的防御必须读取 active PC 的 canonical dodge，不能把 `DEX/2` 作为闪避替身，且要
消费既有状态百分比修正。仅结构化 resolved dodge success 才 mark；attacker miss、failed 和
critical-hit 都不是防御成功。玩家叙事相应区分“扑空”和“躲开”，mark 仍经过 snapshot/rest。
初始红为 2/3/8，恢复 `DEX/2` 的变异为 3/2/15；还原专用集 5/0/17、组合 16/0/81，跨急救
与成长六文件 45/0/221，typecheck 为 0。

这次审计还发现共享 `cocCombatRollHits` 会将 defense critical 判为攻击命中，须独立返工；不得
用本次 dodge 成长闭环掩盖该 combat 语义缺陷。todo-64 继续 open，基线和完整-suite 状态不变。

## CoC 防守 critical 记录订正：成功等级必须先比较（2026-09-30）

上一节把共享 `cocCombatRollHits` 将 defense critical 当作攻击命中的问题列为待返工；那是
发现时的真实状态，现已修复，保留原文仅作历史。共享裁决现在显式使用
`CoCDefenseMode = none | dodge | fight_back`：dodge 要求攻击成功等级**严格高于**防守，
fight-back 则攻击方平手获胜。critical 只是成功等级，legacy 伤害的 critical 不能跳过这层
比较；`counterDamage` 仅属于胜出的 fight-back。

RulesEngine 的 intent 映射表达同一模式、冲突 fail-closed；compiled receipt replay 和 validator
的显式 dodge 也复用相同语义。规则来源是 Chaosium 官方 Combat 页面：
https://cthulhuwiki.chaosium.com/rules/combat.html 。初始红为 0/3/9；恢复
`defense critical => hit` 变异为 3/3/26；精确还原核心为 7/0/38。子代理七文件 159/0/2876、
compiled restart 13/0/158、根代理七文件 70/0/765，相关 typecheck 均为 0。

这闭合的是防守成功等级与 compiled replay 的这一条共享语义，并不把 todo-64、基线或完整
suite 状态升级为 green。

## 急救开启的休息恢复资格必须归具体角色所有（2026-09-30）

旧 `_woundsTreated:boolean` 不能表达资格 owner：无效果急救也会开门，p1 治疗可被 p2
借用，p2 的消费可清 p1，替换角色还会继承残留资格。现在有效且实际发生的治疗才写入
`Set<pcId>`；rest 只消费同一 owner，替换角色会清除此 owner 的资格。

ordinary snapshot 升到 1.3 并持久化 `woundsTreatedByPC`，未知或重复 owner 均拒绝。旧
1.2/1.1/1.0 scalar `false` 迁为空集合；`true` 仅在恰有一个 verified character 时迁入，
零或多个角色一律 fail-closed。初始红为 11/4/59；恢复“任一 owner 都可消费”变异为
15/1/70；精确还原单文件 16/0/71，子代理和根代理同一六文件均 115/0/340，typecheck 均为 0。

这只闭合 ordinary 急救与休息恢复资格的 owner/snapshot 语义，不更新基线或完整-suite
状态；todo-64 继续 open。

## First Aid 与 Medicine 不能共用 1D3 治疗量（2026-09-30）

Chaosium 官方规则将成功的 First Aid 定为固定 1 HP，Medicine 为 1D3 HP；实现因此在
`first_aid` 存在时（即使同时有 `medicine`）固定 +1 且不消费 d3 RNG。只有缺失
`first_aid` 时，canonical `medicine` 才兼容回退到 1D3。中文/默认 fallback 固定 +1，
但不凭名称伪造 canonical growth。规则来源：
https://cthulhuwiki.chaosium.com/rules/hit-points-wounds-and-healing.html 。

止血、effective-treatment、owner 恢复资格、成长和状态百分比修正维持原契约。初始红为
15/3/68；恢复“所有成功都掷 1D3”变异仍红；还原单文件 18/0/82，子代理与根代理相邻六文件
均 117/0/351，typecheck 为 0。

当前没有可信时间、伤情时间戳或医疗物资模型，因而没有实现 Medicine 的至少一小时、适当
设备/补给或每伤限制。该内容边界和 todo-64 仍 open，基线与完整-suite 状态不变。

## CoC 对抗检定的固定熵 fixture 必须表达完整消费序列（2026-09-30）

固定全零熵不是“双方都普通成功”的中性基线：在 CoC opposed roll 中，零会把双方的 d100
都落到 critical。判定必须先比较成功等级；dodge 的平局属于防御方，所以攻击只有在成功等级
**严格高于**防御时才命中。不要把 fight-back 的平局规则投射到 dodge。腹部
`fighting=50` 仍要显式保留 30% 腹部 penalty；First Aid 的成功治疗量是固定 1 HP，不是
1D3（后者仅属 Medicine 的既有分支）。

确定性 fixture 应把随机流视为输入合同，而不是测试内部实现细节：逐项列出并消费前置 SAN、
攻击、dodge/fight-back 防御和伤害所需的值。body-status、entity、narrator 与 npc-fights-back
等相邻路径若也消费熵，必须固定其顺序；否则插入一项无关掷骰就会把“规则断言”错位成随机
位置断言。缺失 CON 的十一条已知非-CON 骰点仍按原有 missing-CON 口径处理；compiled
lifecycle 使用 `[0, 0.2]`，并同时断言 receipt 命中、恰好 1 点伤害和无反击。

判断失败性质时要区分 stale fixture 与 wiring bug：本轮首次权威串行完整套件是
`bun test --parallel=1` exit 1（4248 tests / 351 files / 4202 pass / 36 skip / 10 fail /
24917 expects / 471.11 s），十项均为旧确定性 RNG 或旧急救期望与上述已修正 CoC 语义的
冲突，而非新增生产实现缺陷。这不是放宽回归门槛：真实变异把 coc-engine 的 dodge 比较由
`>` 暂时恢复成 `>=` 后，`coc-combat-defense-mode` exit 1，平局断言报
`Expected false, Received true`；精确还原后恢复。此前 defense-critical 错误语义变异的
证据仍单独有效。根定向集 exit 0（60 tests / 10 files / 293 expects），typecheck exit 0；
最终权威串行完整套件 exit 0（4248 tests / 351 files / 4212 pass / 36 skip / 0 fail /
24968 expects / 314.81 s）。这只证明本轮规则/fixture 收口，不是 todo-64 或生产质量总目标
完成。`docs/notes/index.json` 保持刻意延后，未刷新。

## CoC 技能成长只在正式结算时消费（2026-09-30）

Chaosium 官方 [Rewards of Success](https://callofcthulhuwiki.chaosium.com/rules/rewards-of-success.html)
把 skill increase 的结算放在 scenario 或 gaming session 结束时，而非短休。成功使用技能产生的
owner mark 与持久化 snapshot mark 可以在会话中累积；短休不是成长检定或职业记录的替代结算点，也不应
消耗 growth RNG。

此前 ordinary `GameSession.handleRest` 会独立调用 `applySkillGrowth`、写入
`_growthChangesByPC` 并清除 owner mark，因此短休能够抢先消费本应留到正式结算的成长。现行规则是
single settlement authority：短休保留 owner/snapshot marks，不掷成长、不写 career growth、也不 clear；
只有正式 module/explicit `handleSkillAdvancement` 路径按同一成长公式消费 mark。这样 owner 归属、snapshot
传递和随机消费的时机都由同一结算边界管理。

验证先以 `ordinary-skill-growth-ownership` 得到 8 pass / 1 fail，guard stack 为
`handleRest` → `applySkillGrowth`。真实临时变异恢复等价 rest apply+clear 后，仍得到同一 8 pass /
1 fail，随后精确还原。根定向验证为 9 files / 141 pass / 0 fail / 535 expects，typecheck exit 0；
最终权威串行 `bun test --parallel=1` exit 0：4248 tests / 351 files / 4212 pass / 36 skip / 0 fail /
24993 expects / 277.50 s。本 slice 未运行 preflight；此前同环境的直接 exit 1 仅来自五个内部 spawn
EPERM，四项核心直接判据已独立通过。

这证明的是本地 skill-growth timing、owner/snapshot 保留和正式结算 authority，而不是整个生产目标已经
完成。todo-64 保持 open；`docs/notes/index.json` 仍刻意延后刷新。


## 普通 CoC 技能成长的提交点是确认离场（记录订正，2026-09-30）

此前“explicit `handleSkillAdvancement` 是正式结算 authority”的记录保留为当时的历史，但其结论已经订正。玩家自然语言不是独立提交协议：显式“模组结算/技能成长”请求只打开 `pendingLeaveConfirm`，不得消费 RNG 或 marks，不得改写 skill/career/dead，也不得写入 ending。真正的提交点是玩家确认离场；仅该路径经唯一 `settlePendingSkillGrowth` 核心一次提交成长与真实 ending。

这与 Chaosium 官方 [Rewards of Success](https://callofcthulhuwiki.chaosium.com/rules/rewards-of-success.html) 把技能成长置于 scenario 或 gaming session 结束的时机一致。普通模组结算还须先验证恰有一个已发布 ordinary module，且 registered/loaded 身份一致；缺少模块、身份不一致或 baseline 不可验证时，保留 marks、legacy state 与 RNG，不猜 SAN/CM，不写伪造 career entry 或 `completed` ending。没有 career store 时仍可结算成长并清 mark；身份或起点不可验证时允许离场终态，但保留成长状态且不写 entry。durable candidate 写失败则不得提交 generation、receipt、dead、skill 或 clear 状态，并允许同一 actionId 在修复后重试一次。

本方法论只闭合 ordinary module 的 settlement authority/timing；compiled growth 和更广生产边界仍开放，`docs/notes/index.json` 继续延后。

## ordinary 终态不能被压缩为死亡布尔值（2026-09-30）

ordinary 模组的确认离场曾沿用 `dead=true` 作为“不能继续行动”的快捷标记。结果是已完成调查被
API、持久化快照和前端误报为死亡，后续输入也得到“你已经死了”；单一布尔值无法保留真实 ending
身份，恢复时也无法区分死亡、正常离场和历史状态。

终态应是判别联合，而不是从 `dead` 猜测：`death`、携带真实 `endingId`/`endingName` 的
`module_departure`、以及无法从旧载荷可靠判定原因的 `legacy_unknown`。真实死亡才有
`dead=true`；正常离场为 `dead=false`，但同样在共享终态门禁上拒绝所有后续动作。持久化及公开
响应都必须携带这一判别值，durable receipt 与 current snapshot 要精确交叉验证；客户端以权威 GET
reconcile 恢复死亡、调查结束或历史未知的不同呈现，并为全部终态禁用输入。compiled 路径不借用
ordinary 专属终态字段。

旧版本只有 `dead=true` 而没有原因时，不能为了兼容把它猜成死亡或任一 ending；迁移应为
fail-closed 的 `legacy_unknown`，保留终态阻断但不杜撰叙事事实。该规则已由旧实现红测、离场重新
写回 `dead=true` 的真实变异、以及将门禁退回只检查 `dead` 后允许离场再行动的真实变异覆盖。完整
串行套件随后为 4260 tests / 353 files / 4224 pass / 36 skip / 0 fail；`docs/notes/index.json` 因
并行修改仍延后刷新。

## Ordinary terminal WebSocket projection is response-owned and domain-scoped (2026-09-30)

An ordinary terminal discriminant is not usable by a WebSocket-only client unless every
authorized projection boundary carries it. `broadcastActionResult` previously constructed
its own payload and silently omitted `terminal`; since an ordinary `module_departure` has
`dead=false`, KP and observer clients could mistake a completed investigation for a live
session.

The broadcast contract now carries `terminal` verbatim only when both facts are true: the
current session is ordinary and the ActionResponse explicitly owns the property. That
includes the explicit live value `terminal: null`. Legacy action responses that lack the
property remain omitted, rather than reconstructing a value from mutable or adjacent
session state. Compiled responses must discard the ordinary-only field even if malformed
input tries to add it. This is an audience projection rule, not an authority transfer:
existing per-player history visibility and unknown/no-new-message fail-closed behavior
remain in force.

Formal preflight evidence must name its execution environment. The sandbox invocation of
the identical command stopped at five internal `cmd.exe` spawn `EPERM` failures and is not
green evidence. The authorized outside-sandbox rerun exited 0 and independently reported
typecheck success, the 4266-test/353-file baseline match, unwired 60, hooksPath
`.githooks`, and 279 boolean-return implementations with zero discarded returns. That
validates the documented gate without converting a sandbox process-launch restriction into
a product result.

## terminal 的原因与兼容布尔值必须只有一个权威（2026-09-30）

上一节已经把 ordinary 的终态由单一 `dead` 改为判别联合；随后的审计发现，公开可写的
`GameSession.dead` 仍是第二个状态权威，而 `ordinaryTerminalState()` 仍可从该布尔值反推
原因。这样外部调用方既能把存活 ordinary 会话伪造成死亡，也能清除真实死亡的布尔标志；这同样违反
pre-1.4 载荷仅有布尔值时不得猜测原因的迁移契约。

兼容布尔值只能是只读派生视图，不能写入，更不能作为 reason 的反向来源：ordinary 仅由
`ordinaryTerminal?.kind === 'death'` 派生 `dead`，compiled 仅由
`compiledModule.state.terminalLoss` 派生它，二者都不保留第二个 mirror。ordinary 的 restore、确认离场
和真实 lethal 只经 `setOrdinaryTerminal` 写入终态，`ordinaryTerminalState()` 不再有布尔 fallback。
因此历史兼容测试必须从受验证的 wire envelope 构造并重算 hash，而不是写 runtime 的 private 或 public
字段来伪造历史状态。

这条规则由真实实现变异覆盖：恢复可写 `dead` 和旧 fallback 后，外部伪造、真实死亡一致性和历史原因
断言均转红；精确还原后，新回归 9 pass / 0 fail / 54 expects，主控定向四文件 98 pass / 0 fail / 429
expects，最终串行全量为 4261 tests / 353 files / 4225 pass / 36 skip / 0 fail / 25212 expects。它只封闭
terminal authority，不替代 direct action atomicity、跨进程或更广生产边界；`docs/notes/index.json` 仍因并行
改动延后刷新。

同一 slice 的前端构建首次在沙箱内只因 esbuild spawn `EPERM` 而 exit 1，不能记为源码或构建失败；按
升级规则以相同命令在沙箱外重跑后 exit 0。Vite 6.4.3 转换 32 个模块、943 ms 完成，且构建产物没有出现于
`git status`。这补充的是终态公开视图的构建证据，不改变上述 terminal authority 或更广生产边界的结论。

## Direct action 的外部 close 不是业务 fail-stop（2026-09-30）

direct `GameSession.act()` 的 FIFO 只保证同一会话内动作按次序开始，并不阻止拥有 session 的
外部调用方在异步 intent provider 等待期间调用 `close()`。此前 provider 返回后的旧动作会继续进入
已关闭的 backing store，并向调用方泄漏 `Cannot use a closed database`；这不是动作的业务失败，也不应
把它伪装成 crash-only fail-stop。

会话现在在动作取得 FIFO 位次后记录 lifecycle revision，并在 provider 返回后及成功响应确认前复验。
close 改变 revision 后，正在等待的动作和已排队 follower 都以稳定的
`closed GameSession cannot accept actions` 拒绝；没有 round、gameTime 或 lastActiveAt 的副作用，且
external close 不写 `directActionFailStopped`。这只封闭 close 生命周期的 stale acknowledgement，不能
当成业务 source-state revision/ABA、完整 atomic commit、rollback、组件补偿、career staging 或跨文件
atomicity 的证据；todo-65 继续 open。

业务异常的 fail-stop 边界仍不同：真实 legacy runtime-host/generated-story 写入失败保留第一因果错误，
随后动作才稳定 unavailable。两条真实实现变异分别验证这两个边界：移除 provider 后 lifecycle gate 会让
lastActiveAt 变化而使回归变红；把 internal fail-stop 恢复为直接 close 会把 generated-story 因果错误覆写，
同样变红；精确还原后绿色。定向证据为 28 pass / 3 files / 135 expects，typecheck exit 0；全量为
4267 tests / 353 files / 4231 pass / 36 skip / 0 fail / 25258 expects / 257.45s。

这次的流程记录也需要写清：PowerShell wrapper 不得由父 shell 在 child 完成前展开
`$LASTEXITCODE`。最终完整测试采用 Bun.spawn，同时排空 stdout/stderr，并以 `process.exit(code)` 返回子进程
退出码；此前一次包装错误的 4230 pass / 36 skip / 1 fail 不是通过证据。`docs/notes/index.json` 有并行改动，
仍延后刷新。

## Durable recovery factory 继承依赖而不接管状态（2026-09-30）

ordinary 的可信 `createOrdinaryRecoverySession` 以前只用于 initial/request recovery。durable action
transaction 的 staging candidate、success replacement 以及 CAS、indeterminate、post-commit recovery 则各自
hard-code 构造，导致 host 注入的 storyGenerator 或 fake intent LLM 在第一次 durable action 后丢失。这个问题
不能只在最早的恢复点修：任何后续 pristine session construction site 都是实际运行期依赖的继承边界。

现在所有这些路径共同使用 `OrdinaryPristineSessionFactory`。handler 只传入既有 trusted host seam；request
JSON 没有可选依赖字段，不能升级为注入通道。factory 的职责仅是提供运行期依赖，绝不是状态权威：每个
candidate 仍须通过既有 pristine snapshot/identity restore 验证；factory 抛错、返回非 GameSession 或错误
session ID 都 fail-closed，且不发布。默认 production fallback 也未改变。

旧实现的红测在第二笔 action 得到随机“诅咒之枯木镇”，而不是 `SENTINEL HOST STORY`（0 pass / 1 fail）。
分别恢复 staging candidate 或 success replacement 的 hard-coded construction，两项真实变异也各自为
0/1；精确还原后 pair 为 2 pass / 17 expects。定向三文件为 54 pass / 0 fail / 430 expects，typecheck
exit 0；完整套件为 4269 tests / 353 files / 4233 pass / 36 skip / 0 fail / 25275 expects / 413.95s。

本项只闭合 durable recovery 的依赖继承，不能声称 source-state revision/ABA、完整 atomic commit/rollback、
career staging、组件补偿或跨文件 atomicity 已完成；todo-65 保持 open。`docs/notes/index.json` 有并行改动，
继续延后刷新。

## Ordinary durable source retirement is a lifecycle lease, not a transaction revision (2026-09-30)

`GameSession.runExclusiveActionTransaction` now hands its caller an opaque lifecycle lease only after the
operation has acquired its FIFO position. The ordinary durable HTTP transaction validates that lease on
entry (but only when the closed source is still the exact registry live value), after the awaited staging
candidate action, and inside the final synchronous publication gate. Therefore an external `source.close()`
while the candidate waits for an injected or remote intent result returns retryable 503 instead of publishing
g1: no generation advance, receipt, or broadcast.

The recovery path evicts only that exact stale source. It then re-reads the current authoritative snapshot
pointer before trusted rehydration; it must not reinstall the captured g0 envelope after another writer has
already published g1. An exact retry may commit once after recovery. Existing queued-duplicate replay is
preserved when its old source had already been replaced. This closes source lifecycle retirement only; it is
not business source-state revision/ABA protection or a claim of complete transaction atomicity.

The staging-delete suspicion from the initial investigation was false. The complete career projection is in
the snapshot, and installing the real-root replacement installs that projection after a successful write. The
remaining career concern is partial multi-file projection installation, not loss caused by a successful write.
Still open are business state revision/ABA, synchronous component/career installation compensation,
cross-file and power-loss atomicity, and rollback-failure fail-stop. The legacy HTTP mutators remain
deliberately blocked as `409 ordinary_mutation_not_durable`, rather than an existing defect.

The lifecycle regression was real: removing both post-await/pre-publication guards made the response 200;
exact restoration was green. The expanded focused set was 59 pass / 0 fail / 480 expects across 4 files,
and typecheck exited 0. The root-authoritative full run used concurrent Bun.spawn stdout/stderr drains and
finished 4271 tests / 353 files / 4235 pass / 36 skip / 0 fail / 25304 expects in 328.63s, exit 0.

## Production intent policy must read the runtime environment dynamically (2026-09-30)

At ordinary-handler policy selection, Bun transformed/cached a direct `process.env.NODE_ENV` expression.
That allowed a trusted `development_fallback` to remain enabled after a runtime switch to production. The
existing helper contract and trusted host intent-factory inheritance remain unchanged; it now receives
`Reflect.get(process.env, "NODE_ENV")`. Production without a provider again requires the provider and returns
503. Restoring the direct property read made the focused production test red again (`expected 503, got 200`);
the exact dynamic-read restoration was green.

`docs/notes/index.json` is deliberately deferred while parallel changes exist.

## Durable source-state fencing and Career projection publication (2026-09-30)

The ordinary durable action path now compares a full portable snapshot business hash of the exact live
source. The hash deliberately excludes only operational `session.lastActiveAt`. Its opaque source-state
capability is sampled after FIFO acquisition, checked after awaited intent/candidate work, and checked again
synchronously at the publication fence. A live HP mutation during that await, or a mutation injected at the
final fence, therefore returns retryable 503 without g1, a receipt, a broadcast, or an automatic model rerun.
Recovery evicts only the divergent exact source and rehydrates from the latest durable pointer. An observation
that changes only `lastActiveAt` still commits. This is a net-state comparison; it does not close transient
mutate-restore ABA or provide a general revision protocol.

Career projection restore no longer exposes leaf-by-leaf replacement at the real session root. It writes a
complete immutable generation under a private staging capability, fsyncs its files, writes a bounded completion
manifest with the portable-projection SHA-256, verifies the manifest and exact expected leaf set, and then
atomically replaces one root-local active pointer under a fail-closed root fence. Conforming readers resolve
and pin that one active layout for an operation. Once the pointer exists, they must not fall back to direct
legacy root leaves; incomplete or tampered pointers fail closed. Pointer-mode `save`, `add`, `delete`, and
`import` are full-projection copy-on-write publications, so published generations remain immutable. Retention
is bounded; cleanup refuses reparse and non-regular leaves.

The deterministic fault seam had an old Target-only projection and a desired Ada-plus-Bea projection, then
threw at the second staged leaf. The old in-place mutation exposed Ada-new + Target-old with Bea missing;
the pointer-bypass mutation made the same test red. The restored publication leaves a fresh conforming reader
with the complete old projection on failure and the complete new projection after retry. Tests must therefore
assert session Career persistence through `CareerFileStore`'s public projection API, not by enumerating
`.career.json` leaves directly under a session root after pointer publication. Direct-leaf enumeration remains
appropriate only for explicit legacy or low-level storage tests.

These are bounded publication and net-state guarantees, not a claim of cross-platform power-loss closure,
NFS/SMB locking/rename semantics, stale-root-lock recovery or read availability, old-process interoperability,
component-install compensation, rollback-failure fail-stop, or general cross-file atomicity. The current full
suite is 4275 tests / 353 files / 4239 pass / 36 skip / 0 fail / 25302 expects in 415.64s; the Bun child and
wrapper both exited 0. Direct probe exit 0 reported no callers 60 / test-only 71 / should-private 47. Final
the final outside-sandbox preflight exited 0: 280 boolean-return implementations / 0 discarded return values;
generated-document reference validation covered 3 docs, handwritten payload validation 8, and structured
payload validation 1; typecheck exited 0; 4275 tests / 353 files and unwired 60 matched their baselines; and
`core.hooksPath` pointed to `.githooks` with the commit-msg criterion run. This records that final preflight;
it does not claim a post-update second preflight. `docs/notes/index.json` remains deliberately deferred while
parallel changes exist.

## Owner-validated recovery outages are retryable, not opaque absence (2026-09-30)

An ordinary locator must stay opaque until the durable envelope has established its exact owner. Before that
check, a foreign or unknown locator is still the same 404; a caller must not infer that a session exists from
recovery diagnostics. After that check succeeds, however, a trusted replacement-factory or restore outage is
an availability failure, not absence. The handler therefore returns the bounded retryable
`ordinary_recovery_unavailable` 503 contract with retry/no-store headers, and action handling does not read a
body it cannot execute. Authentication failure remains earlier than factory use. If another actor wins the
registry while a replacement is restoring, the candidate which lost publication is closed exactly once and the
winner remains authority.

This is a boundary between authenticated ownership and recovery availability. It does not make trusted
factories infallible, turn a foreign locator into a visible resource, or close the wider direct-action
transaction and cross-file durability work.

## Startup inventory is an attestation, not anonymous request work (2026-09-30)

Namespace inventory exists to attest the process's resolved durable root domain before it accepts traffic. It
must not silently become a full filesystem scan on every anonymous request: besides needless cost and timing
exposure, that lets post-start filesystem damage change service availability at an unrelated request boundary.
The private readiness capability is consequently valid only for the exact coordinator and ordinary, compiled,
metadata, and Career roots successfully scanned by the real default Node inventory. A failed bootstrap, root
change, or test-only/fake inventory seam cannot receive that capability. Production passes the established
namespace into the handler; exported direct handlers which lack it still use the existing lazy, fail-closed
path for compatibility.

The two contracts deliberately compose: owner validation happens before an ordinary session is opened, while
the startup attestation prevents a healthy production request from gratuitously repeating process inventory.
Neither claim closes transient ABA/revision, other trusted direct synchronous mutators, component-install
compensation, rollback-failure fail-stop, or cross-file/power-loss semantics. `docs/notes/index.json` remains
deferred while parallel edits exist. The final outside-sandbox preflight after the corresponding baseline update exited 0: 282 boolean-return implementations / 0 discarded returns; generated-document references covered 3 docs, handwritten payloads 8, structured payload 1; typecheck exit 0; tests 4280 / 353 and unwired 60 matched baseline; `core.hooksPath` was `.githooks` and the commit-msg criterion ran. The later documentation backfill had only JSON/diff checks, not a second full suite or preflight.

## Content hashes cannot identify ABA; revision scope must be named (2026-09-30)

A snapshot or business-content hash catches a divergent final state, but cannot distinguish mutate-then-restore
from no mutation when both observations serialize identically. The ordinary durable source therefore also
compares a process-local, non-persistent facade revision captured at the FIFO pre-action snapshot boundary.
It advances only after a successful semantic change through the controlled live facade; same-value no-ops do
not advance it. That closes ABA only for those controlled mutators. Public child components, world/session/
registry access, and publicly mutable fields can bypass the facade, so the counter is not a general source
revision or a closure of the wider transaction boundary.

After the baseline update, the final outside-sandbox `bun scripts/preflight.ts` exited 0: 282 boolean-return
implementations / 0 discarded returns; generated references 3 docs; handwritten payloads 8; structured payload
1; typecheck exit 0; tests 4282 / 353 and unwired 60 matched baseline; and `core.hooksPath` was `.githooks` with
the commit-msg criterion run. The subsequent documentation backfill has only JSON/diff checks, not a second full
suite or preflight.

## Component compensation ends at the external Career boundary (2026-10-01)

`createPartyMember` now takes a pre-write capture of the world, session, and local component state. If
installation fails before Career persistence begins, it restores that capture. If this compensation also
fails, the original causal error remains the reported error and the direct action enters fail-stop; a later
call must not continue using a session whose component state may be indeterminate. The guarantee stops at
the external Career persistence boundary: it is not a claim of cross-file atomicity, crash recovery, or
power-loss consistency.

Two direct-action-atomicity regressions make both limits observable. The old implementation left p2 SAN and
`player_state` behind after a failed installation, and it could keep accepting actions after a compensation
failure. Removing component compensation or ignoring the compensation-failed fail-stop made the respective
real mutations red; exact restoration was green. Directed evidence was 10 passing direct-action-atomicity
tests, 67 game-session tests, and 9 world-truth tests.

## Portable identity includes operational timestamps (2026-10-01)

An operational timestamp covered by portable snapshot or business identity is semantic state for the
operation that uses that identity. A true no-op must not rewrite it. `setPlayerHp` formerly upserted an
entity even when the card and entity HP already matched; SQLite could then advance `updated_at` across a
second boundary, changing both hashes while HP and the facade revision stayed unchanged. That made an
in-flight ordinary no-op intermittently return 503. A dynamic probe observed exactly that, and a
schema-only BEFORE UPDATE trigger made the former behavior stably fail.

The repair performs no write and no revision bump when both HP values already agree. It synchronizes only
the differing side and bumps once for a real change. The ordinary staged-successor guard still requires the
same captured snapshot hash, business hash, and non-persistent facade mutation revision: a real
mutate-then-restore ABA is rejected, while a genuine no-op is not. Removing the revision equality made the
ABA regression red; restoring the same-value upsert also made its regression stably red. Independent checks
were concurrency 9/9, direct-action-atomicity 10/10, world truth 9/9, game-session 67/67, the no-op target
10 consecutive times with no failure, and typecheck exit 0.

The final outside-sandbox full suite, with stdout and stderr drained concurrently, exited 0: 4284 tests /
353 files / 4248 pass / 36 skip / 0 fail / 25364 expect calls / 369.89s. A final preflight has not yet been
run after this documentation update; this note deliberately does not report one as passing.

## Preflight failures must retain bounded identity (2026-10-01)

A gate that reports only a failure count has discarded the evidence needed to investigate it. Preserve a
bounded identity instead: preflight may retain a small, length-capped set of `(fail)` test titles, but must
not replay assertion bodies, stacks, or complete test stdout/stderr, which can leak payloads and bury the
signal. This changes observability only, never the test pass/fail/count criteria.

The earlier single red at the 4284 baseline left no title in the old output and did not reproduce in an exact
standalone serial run. It is therefore unlocalized rather than a product fix. After the two identity
diagnostics, the isolated preflight's tests were green but its old passed baseline was 4248 rather than 4250.
After the baseline update, the final exclusive outside-sandbox preflight exited 0: 282 boolean-return
implementations / 0 discarded returns; generated refs 3 / handwritten payloads 8 / structured payload 1;
typecheck exit 0; 4286 tests / 353 files and unwired 60 matched baseline; `core.hooksPath` was `.githooks` and
the commit-msg criterion ran. This documentation backfill then had only JSON/diff checks; it does not claim a
second full-suite or preflight run.

## Same-connection SQLite mutation stamps expose otherwise invisible ABA (2026-10-01)

Content hashes describe net content, so a same-connection SQLite A→B→A sequence can return to the same hash.
Capture that connection's monotonic `total_changes()` mutation stamp at the exact pre-action boundary and
reuse it in both post-await and final fences: reads do not advance it, while DML remains observable even after
content is restored. The stamp complements the existing facade revision and snapshot/business hashes, and is
not part of the portable snapshot schema.

Public `activeCharacter` reference identity is a separate, narrower signal: it rejects one net replacement by
a clone, but cannot detect replacement followed by restoration of the original reference. This slice therefore
does not close all public children or aliases, raw non-SQLite mutations, other state domains, or cross-file
Career durability; todo-65 remains open for those boundaries.

After this baseline update, the final exclusive outside-sandbox `bun scripts/preflight.ts` exited 0: 282
boolean-return implementations / 0 discarded returns; generated refs 3 / handwritten payloads 8 / structured
payload 1; typecheck exit 0; 4288 tests / 353 files and unwired 60 matched baseline; `core.hooksPath` was
`.githooks` and the commit-msg criterion ran. This documentation backfill then had only Bun JSON/diff checks;
it does not claim a second full-suite or preflight run.

## Sanity assignment revision is alias protection, not state closure (2026-10-01)

A public `sanity` getter/setter over private backing can retain the reference API while a non-persistent BigInt
assignment revision records only `next !== backing`. Capture both the sanity reference and that revision at the
exact pre-action snapshot, then compare both in the shared post-await/final source fences. This rejects a
SanityEngine A→B→A reference replacement that identity alone cannot see, leaves same-reference assignment a
no-op, preserves the other stamps and hashes, and changes neither sanityEngines/party/world linkage nor the
snapshot, hash, or schema.

That revision covers alias assignment only. `SanityEngine.state` remains publicly writable, so field, whole-
state, and nested-array mutation followed by restoration remain outside this guard; it is not a state-closure
claim. The same caveat applies to the remaining public child domains, raw non-SQLite mutations, and Career
cross-file durability, so todo-65 remains open.

After this baseline update, the final exclusive outside-sandbox `bun scripts/preflight.ts` exited 0: 282
boolean-return implementations / 0 discarded returns; generated refs 3 / handwritten payloads 8 / structured
payload 1; typecheck exit 0; 4292 tests / 353 files and unwired 60 matched baseline; `core.hooksPath` was
`.githooks` and the commit-msg criterion ran. This documentation backfill then had only Bun JSON/diff checks;
it does not claim a second full-suite or preflight run.

## ActiveCharacter assignment revision detects restored-reference ABA (2026-10-01)

Identity alone cannot distinguish A→clone→A from no change. A private backing field with the same public
getter/setter can keep the public API while a non-persistent BigInt assignment revision increments only for
`next !== backing`. Capture that revision at the exact pre-action snapshot and require it in the shared
post-await/final fences alongside identity, the world SQLite mutation stamp, facade revision, and content
hashes. Same-reference assignment remains a no-op, while the restored-reference ABA is rejected; the revision
does not enter the snapshot, hash, or schema.

Changing a public data field into an accessor slightly changes its own/enumerable reflection shape. The
repository has no dependency on that shape, but this is only a local compatibility observation, not a claim
about external consumers. This closes reference assignment ABA only—not mutation and restoration of properties
inside the activeCharacter object, other public child/alias domains, raw non-SQLite mutation, or Career
cross-file durability—so todo-65 remains open.

After this baseline update, the final exclusive outside-sandbox `bun scripts/preflight.ts` exited 0: 282
boolean-return implementations / 0 discarded returns; generated refs 3 / handwritten payloads 8 / structured
payload 1; typecheck exit 0; 4290 tests / 353 files and unwired 60 matched baseline; `core.hooksPath` was
`.githooks` and the commit-msg criterion ran. This documentation backfill then had only Bun JSON/diff checks;
it does not claim a second full-suite or preflight run.

## Readonly views need semantic revisions to close component ABA (2026-10-01)

The previous note's premise that `SanityEngine.state` remained publicly writable is now corrected. The engine
owns private state and exposes a revision-cached deep clone whose object, arrays, and nested mythos entries are
recursively frozen. `restoreState` validates the exact shape, clones the accepted input, and treats deep equality
as a genuine no-op. Callers therefore cannot retain a writable alias through the restore boundary or mutate the
returned view through a nested collection.

Readonly ownership alone does not expose A→B→A to an asynchronous publisher. A non-persistent BigInt semantic
revision records actual component changes, while one reentrant mutation scope covers every public state mutator
and advances the revision even when a mutator throws after changing state. The ordinary action fence captures
the active engine identity, its assignment revision, and its semantic revision at the same pre-action boundary,
then reuses those facts after awaited work and at the synchronous publication fence. Negative `recoverSan` and
`applyLoss` are now rejected: accepting them was not compatibility behavior but a route to states already
rejected by the snapshot validator.

The old ownership/negative-input regression was 0 pass / 3 fail, and the old deferred HTTP currentSAN A→B→A
case expected retryable 503 but received 200. Three implementation mutations each made their distinguishing
case red: removing semantic-revision equality let the controlled ABA return 200; incrementing on an equal
restore turned an intended no-op into 503; and sharing shallow-frozen arrays let a nested phobias push succeed.
After restoration, focused evidence was 120 tests / 2 files, expanded evidence 242 / 7, and ordinary
snapshot/durable/process/store evidence 79 / 4, all with 0 failures; typecheck exited 0.

The first complete suite had one compiled CORS ephemeral-server 5-second timeout: 4303 tests / 353 files /
4266 pass / 36 skip / 1 fail. Its file immediately reran at 27 / 1 / 0 fail, and a second complete suite exited
0 with 4303 tests / 353 files / 4267 pass / 36 skip / 0 fail / 25501 expects / 370.89s. The baseline records that
complete green run. The subsequent outside-sandbox preflight exited 0: 283 boolean-return implementations /
0 discarded returns; generated refs 3 / handwritten payloads 8 / structured payload 1; typecheck exit 0; tests
4303 / 353 matched baseline; and `core.hooksPath` was `.githooks`. It measured unwired 59 rather than 60. That
is recorded only as a reproducible net improvement in the current shared tree, without guessing which parallel
change caused it, and the baseline is tightened to 59. Root's final outside-sandbox preflight against that
tightened baseline also exited 0 with the same summary: 283 boolean-return implementations / 0 discarded
returns; refs 3 / 8 / 1; typecheck exit 0; tests 4303 / 353 and unwired 59 matched baseline; and
`core.hooksPath` was `.githooks`. This documentation backfill then has only JSON/diff checks; it does not claim
another preflight run.

This is a component boundary, not overall transaction closure. PlayerSession whole-state replacement and
aliases, the other session/registry/investigation/kp/npcStore children, activeCharacter's internal fields, and
Career cross-file/crash/power-loss consistency remain open under todo-65.

## A valid checkpoint must be able to repair an invalid live alias state (2026-10-01)

PlayerSession whole-state replacement now has a non-persistent BigInt `stateReplacementRevision`. The restore
entry point first prepares the complete candidate through the existing validator, then either retains an exact
semantic match without a bump or atomically installs a different valid state and advances once. Invalid input
cannot partially write or advance the revision. `restoreSinglePlayer` reuses this path and preserves the same
existing joinedAt, so wall-clock allocation cannot turn a semantic no-op into a false replacement. GameSession
captures the revision at the exact FIFO boundary and checks it in the shared post-await and final publication
fences; the value is deliberately absent from snapshot, hash, and schema.

An important repair rule fell out of review: validating the candidate and comparing it with current state are
not the same operation. Public aliases can make live state non-exportable after a valid checkpoint is captured.
If restore insists on successfully exporting that current state before installing the already validated
checkpoint, corruption prevents its own repair. The intermediate implementation did exactly that after a
message was appended through `getPlayerHistory`; its real regression was 0 pass / 1 fail. The fixed path uses
the validated checkpoint as replacement authority when current comparison is unavailable, restores it, and
advances the revision exactly once.

The old deferred ordinary HTTP restore A→B→A returned 200 instead of the expected retryable 503. Removing the
revision equality reproduced that red result, while unconditionally advancing on an exact restore changed an
intended no-op from expected 200 to 503. Restoration was green. The discriminating pair was 2 / 0; both the
agent and root player-snapshot plus concurrency sets were 26 tests / 2 files / 0 fail / 248 expects. Root's
expanded five-file set was 90 pass / 0 fail / 673 expects, and typecheck plus diff-check exited 0. The complete
outside-sandbox suite exited 0 with 4308 tests / 353 files / 4272 pass / 36 skip / 0 fail / 25541 expects /
367.82s. The baseline keeps unwired 59. The final outside-sandbox preflight exited 0: 284 boolean-return
implementations / 0 discarded returns; refs 3 / 8 / 1; typecheck exit 0; tests 4308 / 353 and unwired 59
matched baseline; and `core.hooksPath` was `.githooks`. This documentation backfill then has only JSON/diff
checks; it does not claim another preflight run.

This revision covers semantic whole-state replacement only. It does not make public PlayerSlot, Set, or array
aliases safe, and it does not record join/leave/switch/push/discover or other ordinary mutator ABA. Those paths,
other session/registry/investigation/kp/npcStore children, activeCharacter internals, and Career
cross-file/crash/power-loss consistency remain open under todo-65.

## PlayerSession reads and inputs own their boundaries (2026-10-01)

Method: prove ownership at the returned/caller boundary, not by exposing a read-only API. `join`, `get`,
`getActive`, `getAll`, and `getPlayersInScene` keep writable compatibility results, but each result is a
snapshot-at-return detached slot. History/global getters deep-own messages and `visible_to`; `push` owns both
timestamped and unstamped input. The internal `activeSlot` remains private so private/scene routing keeps its
existing source of truth.

The old implementation was made red and then restored green at the real seams: a live `get` result exposed a
secret alias that let a deferred HTTP source observe B although final state was A; shallow history/message
copies let `content` and `visible_to` write through; `push` retained caller input aliases; and lazy nested
copying let a view returned before `discover`/`push` observe later secret/history. Expanded five-file evidence
was 95 pass / 0 fail / 704 expects; typecheck and scoped diff-check exited 0.

The first outside-sandbox full run was otherwise green but failed only because the deterministic grammar case
exceeded its default 5000 ms timeout at 6137.79 ms: 4313 tests / 353 files / 4276 pass / 36 skip / 1 fail. Its
file immediately passed 16 / 0, with that case at 3048.92 ms. Audit found about 21 serial durable HTTP requests,
so the test alone now uses 15000 ms without changing a business assertion; a temporary 2000 ms value timed out
red at 3200.21 ms, and the restored file again passed 16 / 0. The second full suite exited 0: 4313 tests /
353 files / 4277 pass / 36 skip / 0 fail / 25565 expects / 465.87s. This is test-harness stability, not a
production action-timeout policy. The final outside-sandbox preflight exited 0: 284 boolean-return
implementations / 0 discarded returns; generated refs 3 / handwritten payloads 8 / structured payload 1;
typecheck exit 0; tests 4313 / files 353 and unwired 59 matched baseline; `core.hooksPath` was `.githooks`.
This documentation backfill then has only JSON/diff checks; it does not claim another preflight run.

This closes only public PlayerSlot/Set/history/message aliases and `push` input ownership. Routine PlayerSession
mutator ABA through `join`/`leave`/`switchActive`/`push`/`pushPerPlayer`/`discover`, other public children,
activeCharacter internals, and Career cross-file/crash/power-loss consistency remain open under todo-65.

## PlayerSession semantic revisions distinguish restored state from no change (2026-10-01)

Method: own read/input boundaries are insufficient when a valid public mutation can change and restore the same
snapshot. A non-persistent PlayerSession `semanticRevision` now advances exactly once for actual
`join`/`leave`/`switchActive`/`push`/`pushPerPlayer`/`discover` changes and actual restore. Same active or
unknown selection, repeated secret discovery, empty/all-unknown `pushPerPlayer`, and exact/invalid restore do not
advance. The existing `stateReplacementRevision` remains restore-only; an actual restore advances both. Neither is
part of snapshot, hash, or schema, and the ordinary source guard captures and compares both at the exact FIFO boundary.

`push` preplans recipients before mutation: a throwing `sceneOf` leaves the exact snapshot and both revisions
unchanged, while targeted duplicate delivery order remains intact. `pushPerPlayer` likewise preplans valid deliveries
and advances once. The real deferred HTTP p1→p2→p1 public-child switch formerly returned 200; it now returns retryable
503 `ordinary_source_state_changed`, keeps g0, emits no receipt/broadcast, and makes one model call. The no-op HTTP
case remains 200. Removing semantic-revision equality restored the 200 ABA; incrementing for a same switch or repeated
discover turned the no-op into 503; and restoring a scene mutation before preplanning made the atomicity test red. Each
was restored green.

Root-directed evidence was 35 pass / 2 files / 338 expects, with 37 pass / 4 files / 125 expects related coverage;
typecheck and scoped diff-check exited 0. The outside-sandbox full suite exited 0: 4317 tests / 353 files / 4281 pass /
36 skip / 0 fail / 25653 expects / 370.98s. The first final outside-sandbox preflight exited 1 even though
typecheck, documentation, and hook checks passed: its test stage was 4317 tests / 353 files / 4280 pass / 36
skip / 1 fail, solely the `source-bound terminal rewards structural table row` case. It simultaneously measured
unwiredMethods 59→58. Root then reran that file five consecutive times at 6 pass / 0 fail / 82 expects, about
1.76–1.78s each, and the prior independent complete 4317-test suite was green. This is unreproduced evidence,
not a claimed product repair. The root's second outside-sandbox `bun scripts/preflight.ts` exited 0 after the
singleton failure in the prior full preflight did not reproduce: 284 boolean implementations / 0 discarded returns;
generated refs 3 / handwritten payload 8 / structured payload 1; typecheck exit 0; tests 4317 / files 353 and
unwired 58 matched baseline; `core.hooksPath` was `.githooks` and the commit-msg criterion ran. This does not
claim a product repair targeted the prior test. This documentation backfill then performs only JSON/diff checks and
does not claim another preflight run.

This does not establish a coherent GameSession active-switch facade across activePlayerId, activeCharacter, and SAN.
ActiveCharacter object internals, other public child/alias paths, raw non-SQLite mutation, other trusted synchronous
mutators, and cross-store/Career crash/power-loss consistency remain open under todo-65.

## Direct actions validate active routing twice, then synchronize once (2026-10-01)

Method: do not switch active actor before an awaited intent merely because the target looks selectable. Ordinary
direct act first performs a pure validation of the current PlayerSession routing slot, its current SAN-map alias, and
the target character/SAN/slot. Only after a successful intent does it repeat that validation; then, in one no-await
interval, it synchronizes activePlayerId, activeCharacter, sanity, and PlayerSession.active. A missing slot or
long-lived split returns `active_player_state_inconsistent` before any lastActiveAt, round, time, world, SAN, or
history write. Required-provider failure cannot switch early, and removal of the target slot during await rejects.

This preserves unknown-target, compiled, placeholder, and same-actor behavior. A current public activeCharacter
replacement remains compatible with the LLM luck 10→7 path; a current public sanity replacement makes direct act
fail closed rather than silently rebinding map/world state. The public session, activePlayerId, activeCharacter, and
sanity authorities remain public: this is a direct-act pre/post-intent routing gate, not a coherent GameSession
active-switch facade or a guarantee of permanent consistency after arbitrary public writes.

The old leave(p2)→act p2 and public session/split paths were focused red with error undefined. The pre-await-commit
regression was red; restoring that real mutation made 2 of 7 tests fail. An activeCharacter compatibility assertion
was red under an identity guard and green after repair. The first-aid negative fixture was corrected from an invalid
activePlayerId=missing-player setup to legal p1 routing plus deletion of p1's actual world SQLite entity, retaining all
business assertions at 18/18.

Root-directed outside-sandbox evidence was 156 pass / 9 files / 0 fail / 800 expects; typecheck and scoped diff-check
exited 0. A nine-file combined run had an unreproduced compiled action-discovery singleton failure: its file immediately
passed 11 / 0, and the later root 156-pass set included it and was green, so no product repair is claimed. The root
authoritative outside-sandbox suite exited 0: 4324 tests / 354 files / 4288 pass / 36 skip / 0 fail / 25773 expects /
368.89s. unwired remains 58. The final outside-sandbox `bun scripts/preflight.ts` exited 0: 284 boolean
implementations / 0 discarded returns; generated refs 3 / handwritten payloads 8 / structured payload 1;
typecheck exit 0; tests 4324 / files 354 and unwired 58 matched baseline; `core.hooksPath` was `.githooks` and
the commit-msg criterion ran. This documentation backfill then performs only JSON/diff checks and does not claim a
second preflight run.

## GameSession exposes a frozen reader, not its PlayerSession authority (2026-10-01)

Method: preserve the compatibility read surface without making an object private only by convention. The real
GameSession authority is ECMAScript runtime-private `#playerSession`. Public `session` is created once as an
`Object.freeze` plain read facade; its closure binds the private authority and dynamically exposes count,
semanticRevision, stateReplacementRevision, and the get/getActive/getAll/getAllNames/snapshot/exportSnapshot/history,
secret, and scene readers. It exposes neither membership/active/history/secret mutators
(join/leave/switchActive/restore*/push*/discover) nor an authority escape hatch. All internal GameSession reads/writes
use `#playerSession`; production scanning found no `.session.<mutator>`, and `this.session` is now only a
construction assignment. Standalone PlayerSession and the `src/index.ts` CLI remain unchanged.

The old facade focus was red because `Object.isFrozen` expected true but received false; the other seven cases were
green. Temporarily exposing `switchActive` made the absence check red at 7 pass / 1 fail, then exact restoration
returned green. Four prior HTTP public-PlayerSession-mutator fixtures now prove absent restore authority, detached
export snapshot with unchanged revisions, absent switch/leave, and absent discover/push. PlayerSession revision
semantics stay in the player-session-snapshot unit boundary; casts do not invent a private capability.

The compiled stale-view fixture retains durable compiled addPartyMember rejection as
`compiled_mutation_unsupported`: session remains p1 with no p2 slot, while only compatibility active fields may be
stale. Thus compiled durable p1 remains authority without weakening compiled behavior. Root-directed outside-sandbox
evidence was 188 pass / 9 files / 0 fail / 1095 expects; typecheck and scoped diff-check exited 0. The full
outside-sandbox suite exited 0: 4325 tests / 354 files / 4289 pass / 36 skip / 0 fail / 25771 expects / 348.01s. The
two fewer expects replace four unreachable HTTP mutation fixtures with authority-absence/ownership checks; it is not
missing coverage. unwired remains 58. The final outside-sandbox `bun scripts/preflight.ts` exited 0: 284 boolean
implementations / 0 discarded returns; generated refs 3 / handwritten payloads 8 / structured payload 1;
typecheck exit 0; tests 4325 / files 354 and unwired 58 matched baseline; `core.hooksPath` was `.githooks` and
the commit-msg criterion ran. This documentation backfill then performs only JSON/diff checks and does not claim a
second preflight run.

This closes only external mutation of PlayerSession membership, active selection, history, and secrets through
GameSession.session. activePlayerId, activeCharacter, and sanity remain public authorities; coherent GameSession
active-switch synchronization, permanent coherence after arbitrary public writes, other public child/alias paths,
and cross-store/Career crash/power-loss consistency remain open under todo-65.

## A selector can be runtime-private without closing its cohort (2026-10-01)

Method: a TypeScript declaration alone is not an authority boundary. GameSession.activePlayerId is now a prototype
getter over ECMAScript runtime-private `#activePlayerId`: there is no setter and no own property. Ordinary restore,
compiled restore/temporary p1 view/commit, and direct actor commit write only private backing. An external assignment
throws TypeError and leaves state unchanged. No switch API was added; standalone PlayerSession and the CLI remain
unchanged.

The tests exercise real `act(..., pcId)` paths rather than a private seam. Compiled stale view keeps its
activeCharacter compatibility behavior; the sole runtime assignment is a readonly red-line that must throw, and
ordinary snapshot-candidate tampering remains tested. The old implementation's focus was 8 pass / 1 fail because its
getter was undefined. A real mutation that added a public setter writing backing was likewise 8 pass / 1 fail; exact
restoration was green. Agent focus was 9 pass / 150 expects, compiled 11 pass, four files 66 pass, and typecheck 0.

Root expanded outside-sandbox evidence was 128 tests / 9 files / 0 fail / 1104 expects; typecheck and scoped
diff-check exited 0. The full root outside-sandbox suite exited 0: 4326 tests / 354 files / 4290 pass / 36 skip /
0 fail / 25766 expects / 273.74s. The net five fewer expects come from fixture migration, not missing coverage.
unwired remains 58. The final outside-sandbox `bun scripts/preflight.ts` exited 0: 284 boolean implementations /
0 discarded returns; generated refs 3 / handwritten payloads 8 / structured payload 1; typecheck exit 0; tests
4326 / files 354 and unwired 58 matched baseline; `core.hooksPath` was `.githooks` and the commit-msg criterion
ran. This documentation backfill then performs only JSON/diff checks and does not claim a second preflight run.

This closes selector assignment authority only. activeCharacter and sanity compatibility setters, object/child
internals, and permanent cohort coherence between the readonly selector and those still-public fields remain open;
it is not a full active-switch closure.

## ActiveCharacter reads are owned snapshots, not the live compatibility raw view (2026-10-01)

Method: a readonly TypeScript shape is insufficient when a caller can retain nested references. GameSession now keeps
internal authority in `#activeCharacterRaw`; public `activeCharacter` getter returns a structuredClone that is
recursively frozen and detached. Its setter clone-owns input: unchanged detached readback and the same retained input
are no-ops, while a content-changed retained input imports and bumps. Internal code uses raw, and status tick mirrors HP
into a distinct compatibility raw view.

The old real nested-ABA HTTP case returned 200 where the scoped guard now returns retryable 503. Returning raw through
the getter made the readonly test red at 0/1 because `Object.isFrozen` was false. Mutating the status mirror made
6/7 fail with HP expected 5 but received 8. Fifteen old fixtures that wrote nested activeCharacter fields directly
isolated red at 3 pass / 15 fail, with CoC defense red at 6/7; they were migrated semantically, not by weakening the
getter contract.

Root focused evidence was 58/58 exit 0; compiled-action isolation passed four runs at 11/11 each; typecheck exited 0.
The first 4328/354 full run had 4276 pass / 36 skip / 16 fail: 15 were old fixtures and one was an unreproduced
compiled-action singleton. This is counter-evidence, not a claimed product repair. The final outside-sandbox suite
exited 0: 4328 tests / 354 files / 4292 pass / 36 skip / 0 fail / 25791 expects / 315.63s. unwired remains 58 pending
final preflight. The first outside-sandbox preflight exited 1 despite typecheck exit 0 and unwired 58: its suite had
4290 pass / 36 skip / 2 fail because two real auto-admission heavy integration cases exceeded the default 5s budget.
Both the ordinary single file and exact `--parallel=1` run were 17/17, repeatedly green. The two tests alone now have
a 30s per-test timeout; assertions and production semantics did not change. Related admission/recovery evidence was
13/13 and typecheck exited 0. This is stabilization evidence, not a proven product repair. The final outside-sandbox
`bun scripts/preflight.ts` exited 0: 285 boolean implementations / 0 discarded returns; generated refs 3 /
handwritten payloads 8 / structured payload 1; typecheck exit 0; tests 4328 / files 354 and unwired 58 matched
baseline; `core.hooksPath` was `.githooks` and the commit-msg criterion ran. This documentation backfill then
performs only JSON/diff checks and does not claim another preflight run.

This closes detached read ownership and its nested alias/ABA slice only. Whole-object setter compatibility can still
create raw state distinct from the characters map; other public aliases, the SAN surface, and permanent cohort
coherence remain open under todo-65.

## Whole-state restore needs an identity-replacement revision, not only a content hash (2026-10-01)

`AgentRegistry.restoreSnapshot()` may install a fresh set of live `NPCAgent` objects whose exported content is exactly
the same as before. A portable snapshot/business hash therefore cannot distinguish A→B→A restoration, even though
retained object identities and aliases have been retired. The narrow guard is a private, non-persistent
`stateReplacementRevision`: validate the complete input first, install atomically, then increment once for every
successful restore, including exact content. Invalid input must neither install nor increment. The ordinary action
source fence samples and compares this revision at the same FIFO boundary as its other source evidence.

A real deferred HTTP regression restored registry snapshot A→B→A while the model call was waiting. The old boundary
returned 200; the repaired boundary returns retryable 503, retains generation 0, and emits no receipt or broadcast.
Removing the revision comparison reproduced the 200; exact restoration was green. Snapshot tests separately prove
0n→1n→2n across two exact successful restores, new agent identity, and no increment on invalid input. Registry-focused
verification was 84 pass / 6 files / 738 expects.

This is intentionally a restore-only conclusion. `register`, `unregister`, `unregisterWhere`, and mutations through a
retained live `NPCAgent` can still form semantic or identity ABA intervals without touching that revision. Those are the
next registry boundary under todo-65; a restore counter must not be presented as a general registry mutation counter.

## Character construction must own and validate every entropy draw (2026-10-01)

Global `Math.random` is mutable process state and is not a safe default for durable GameSession character creation. A
hostile or accidental monkeypatch could generate impossible CoC attributes, luck, or credit rating, and the failure
would appear later as an unrelated snapshot/SAN invariant error. GameSession now defaults character construction to
`globalThis.crypto.getRandomValues`; its trusted runtime-only seam is validated on every draw as finite and in
`[0, 1)`. Initial, party-member, and text character creation all receive that owned source. Entropy failures propagate
as entropy failures instead of being rewritten as unknown occupations. Request payloads cannot select the seam.

Validation also belongs at directly exported random-consuming boundaries, not only at the GameSession adapter:
`buildCoCCharacter`, `rollLuck`, `rollCreditRating`, and `buildBaseBackgroundProfile` all consume through the shared
`drawRandomUnit` contract. This keeps direct callers fail-closed while preserving `Math.random` as their legacy default;
it does not alter later action, check, or combat RNG semantics.

With global `Math.random = () => 100000`, the old direct compiled-session child produced invalid character values and
could not create a complete durable snapshot. The repaired child completes both direct and HTTP compiled-session
creation, persists the snapshot, and confirms the hostile global remains installed, proving isolation rather than test
cleanup. Invalid units `NaN`, `Infinity`, `-0.001`, and `1` fail closed. A real mutation making `drawRandomUnit` return
fixed `0.5` changed the four-case invalid-source set to 1 pass / 3 fail; exact restoration returned 4 pass / 0 fail.
Combined directed verification was 318 pass / 11 files, typecheck exited 0, and the outside-sandbox full suite exited 0:
4334 tests / 355 files / 4298 pass / 36 skip / 0 fail / 25843 expects / 301.39s.

The first unchanged outside-sandbox `bun scripts/preflight.ts` exited 1 at one test only:
`compiler artifact catalog > reports an indeterminate recovery ID when temp unlink or final temp sync cannot revoke a
valid link-created target`; its suite reported 4297 pass / 36 skip / 1 fail. Typecheck exited 0, boolean implementations
were 285 with 0 discarded returns, unwired remained 58, and `.githooks` was active. The failing file then passed 31/31
for eight consecutive runs, and the exact singleton passed 1/1 in about 1.84s. Read-only diagnosis makes its default
five-second budget the most likely explanation, but preflight intentionally trimmed the first failure stack. Therefore
timeout is not proven; neither production nor that test was modified, and no product repair is claimed.

The second identical outside-sandbox preflight exited 0: 285 boolean implementations / 0 discarded returns; generated
references 3 / handwritten payloads 8 / structured payload 1; typecheck exit 0; 4334 tests / 355 files matched the
baseline; unwired 58 matched; and `core.hooksPath` was `.githooks`. This final validation does not turn the prior
unreproduced failure into a diagnosed defect and does not close todo-65.

An intermittent `compiled-action-discovery` singleton did not reproduce across isolated repeated runs. The contaminated
global RNG defect is independently proven, but no causal relationship between the two has been established; this slice
must not be described as repairing that flake.

## Registry semantic revision must follow current identity and actual writes (2026-10-01)

A restore-only replacement counter cannot see ordinary registry A→B→A intervals or a current live agent whose runtime
state changes and returns to its original serialized value. `AgentRegistry` therefore has a separate private,
non-persistent `semanticRevision`. An actual register, successful unregister, every deletion performed by
`unregisterWhere`, and successful registry restore advance it. The ordinary GameSession source fence captures and
compares this semantic revision while retaining the existing `stateReplacementRevision`, because semantic mutation and
whole-map identity replacement are different evidence.

Live child observation must be identity-bound. An actual runtime write advances registry semantic revision only while
the registry map still contains that exact `NPCAgent`; after unregister, writes through a retained stale reference do
not mutate registry authority and therefore do not advance it. Same-value `restoreRuntimeState` and relationship no-ops
do not advance. This keeps no-ops compatible without allowing a real write-then-restore interval to disappear.

Read and input ownership are part of the same boundary. Agent construction clone-owns personality, while the public
personality view is recursively frozen and detached. `remember` clone-owns its input and `getRecentMemories` returns
deep clones. Without this ownership, a caller could mutate registry-relevant child state without passing through the
observer or revision contract.

Three deferred HTTP regressions were red against the old implementation: unregister/register,
unregisterWhere/register, and live `restoreRuntimeState` A→B→A each returned 200 instead of required retryable 503,
yielding 3 failures and exit 1. The repaired boundary retains generation 0, emits no receipt or broadcast, and invokes
the provider once. Removing only the GameSession semantic-revision comparison made the structural ABA return 200 again;
exact restoration was green. Root directed verification was 134 tests / 9 files / 0 fail / 824 expects; typecheck and
scoped diff-check exited 0.

The first outside-sandbox full suite exited 1 at 4339 tests / 355 files / 4302 pass / 36 skip / 1 fail / 25879 expects /
286.35s. The sole failure was the compiled-source-NPC-combat restart receipt test taking 5009.37ms against its default
5000ms outer budget; the target passed in about 1.94s when rerun. Only that test received a local 30s scheduling budget;
its assertions, fixture, and production code were unchanged. Its file then passed 14 tests, the related set passed 22,
and typecheck exited 0. The final outside-sandbox full suite exited 0: 4339 tests / 355 files / 4303 pass / 36 skip /
0 fail / 25912 expects / 286.45s. This is test scheduling stabilization, not a product semantic repair.

The first Registry final outside-sandbox preflight exited 1 only at
`compiled p1 player façade > uses the trusted resolver without exposing it and executes a retry-safe action through the
opaque view`: 4302 pass / 36 skip / 1 fail. Typecheck exited 0, boolean implementations were 288 with 0 discarded
returns, unwired was 57, and `.githooks` was active. Preflight trimmed the original failure stack, so timeout cannot be
asserted. The exact target passed 1/1 in 1931.53ms with 138 expects, and the whole file passed 5/5 for six consecutive
runs in about 6.81–6.92s.

Audit found no local timeout on that target. It performs a heavy integration chain: catalog and session creation,
multiple HTTP authorization and opaque-view checks, retry-safe action execution with duplicate/stale/forged requests,
snapshot, and fresh restore. Only that `it` now receives a local 30s outer scheduling budget; production code, fixture,
and assertions are unchanged. Follow-up verification was file 5/5 with the target at 1914.12ms, intent 10/10, lifecycle
2/2, and typecheck 0. This is bounded scheduling headroom, not a diagnosed product repair.

The final identical outside-sandbox `bun scripts/preflight.ts` exited 0: 288 boolean implementations / 0 discarded
returns; generated references 3 / handwritten payloads 8 / structured payload 1; typecheck exit 0; 4339 tests / 355
files matched the baseline; unwired 57 matched; and `core.hooksPath` was `.githooks`. This final validation retains the
first failure as counter-evidence and does not close todo-65 or expand the completed boundary.

The unwired baseline is tightened from 58 to the first preflight's observed 57. This records a reproducible net
improvement only; it does not guess which method changed or claim that unwired methods are cleared.

This slice does not close `npcStore` or `setDB` replacement, hook reentrancy, compiled-session source fencing, external
database transaction/SQLite consistency, or every GameSession child. todo-65 remains open.

## Correction: activeCharacter is a read projection, not a replacement command (2026-10-01)

Earlier notes left the public whole-object `activeCharacter` setter as a compatibility boundary. Dynamic inspection
showed that this was not a coherent command: it clone-wrote only `#activeCharacterRaw`, leaving `characters`, party,
world, SAN, PlayerSession, snapshot, and restore authority unchanged. One counterexample exposed summary
Replacement / HP 7 / POW 1 while state, world, and snapshot still reported Original. Restore discarded the replacement;
direct act nevertheless used the raw replacement skill while persistence retained the old canonical map. A setter with
that behavior is not compatibility—it is a second, lossy authority.

Production has no `.activeCharacter =` caller. `activeCharacter` is now getter-only, returning a fresh deep clone with
recursive freeze for every read. The setter, retained-input WeakMap, assignment revision, corresponding ordinary
source-fence comparison, and obsolete status-tick replacement mirror are removed. Private internal installation remains
for canonical state transitions; its caller must already hold the canonical authority. Tests were migrated through real
character creation, canonical map/snapshot paths, or `setPlayerHp`, without introducing another public mutation seam.

The new regression was red under the old setter because snapshot p1 was `p1` while summary was `owned replacement`.
Temporarily restoring the raw-only setter reproduced the same exit-1 failure; exact deletion returned 1 pass / 0 fail.
Root directed verification exited 0: 253 tests / 20 files / 1384 expects / 46.38s; typecheck and scoped diff-check exited
0. Review found no blocker.

One parallel 19-file expansion made the existing compiled-action-discovery heavy test take 5.38s against its default
5s outer budget; it passed independently in 2.17s. Only that test received a local 30s scheduling budget. Fixture,
assertions, and production behavior were unchanged, so this is stabilization rather than a product repair. The final
full suite exited 0: 4337 tests / 355 files / 4301 pass / 36 skip / 0 fail / 25869 expects / 300.33s.

The two-test decrease from 4339 is intentional: it removes impossible public-setter replacement/ABA concurrency
contracts while retaining new readonly and snapshot-rejection coverage. Files and skips are unchanged. This closes
whole-object public assignment only. The unreachable legacy HTTP character/luck mutation branch, an optional private
raw/map/party invariant, SAN and other authorities remain open under todo-65.

The final unchanged outside-sandbox `bun scripts/preflight.ts` exited 0: 287 boolean implementations / 0 discarded
returns; generated references 3 / handwritten payloads 8 / structured payload 1; typecheck exit 0; 4337 tests / 355
files matched the baseline; unwired 57 matched; and `core.hooksPath` was `.githooks` with the commit-msg criterion
running. This documentation backfill performs only JSON/diff checks and does not claim another preflight run. The green
preflight does not close todo-65 or widen the authority conclusion above.

## Correction: GameSession SAN is a state-only facade, not a replaceable engine (2026-10-01)

Earlier notes correctly separated `SanityEngine` state ownership from GameSession source-fence evidence, but still
described a public GameSession `sanity` getter/setter as an alias-protection boundary. That public shape was not
coherent authority: replacing an equal-looking engine changed the active read while `sanityEngines`, party, world,
ordinary snapshots, and restore retained the prior engine; exposing the live engine also let callers mutate SAN
without the world write that normal GameSession mechanisms require.

GameSession now owns the active engine in runtime-private `#sanityRaw`. Every internal reference change goes through
one private install path. The public `sanity` value is one stable `Object.freeze` facade with only a dynamic readonly
`state` getter. Its state comes from the existing recursively frozen SanityEngine view, so neither engine identity nor
`applyLoss`, `restoreState`, `sanityCheck`, semantic revision, or another mutable escape path is public. The same
facade identity reads the new active raw engine after a supported actor switch. The ordinary source fence still samples
private SAN engine identity, internal installation revision, and semantic revision; these are internal ABA evidence,
not public compatibility fields.

The old replacement regression was red because persisted snapshot SAN was 58 while public SAN was 57; the old live
getter regression also permitted world SAN to become stale before a later action persisted it. Two real implementation
mutations proved the new boundary: temporarily restoring a raw-only public setter recreated the 58/57 split, and
temporarily returning `#sanityRaw` made the frozen-facade assertion fail. Exact restoration was green. Root directed
verification was 182 tests / 9 files / 0 fail / 1078 expects; independent review was 84 / 5 / 0 / 667; typecheck
exited 0; and the full suite exited 0 with 4337 tests / 355 files / 4301 pass / 36 skip / 0 fail / 25847 expects /
330.72s. The final unchanged outside-sandbox `bun scripts/preflight.ts` exited 0: 287 boolean implementations / 0 discarded returns; generated refs 3 / handwritten payloads 8 / structured payload 1; typecheck exit 0; 4337 tests / 355 files matched baseline; unwired 57 matched; and `core.hooksPath` was `.githooks` with the commit-msg criterion running. This documentation backfill performs only JSON/diff checks and does not claim a second full-suite or preflight run.

This closes only public `GameSession.sanity` replacement and live-engine authority. It does not close todo-65, private
canonical-map/party invariants, other public child aliases, coherent multi-component transactions, or cross-store and
crash/power-loss consistency. This documentation update itself performs only JSON and scoped-diff validation; it does
not claim another preflight run.

## Correction: GameSession investigation is a read facade, not public engine authority (2026-10-01)

The former public `investigation` own property was a writable/configurable live `InvestigationEngine`; replacement,
mutators/executors, Maps, and returned aliases could therefore bypass GameSession authority. GameSession now owns
ECMAScript-private `#investigationRaw` and `#investigationFacade`; public `investigation` is a prototype getter with no
setter or own replaceable property. It returns one stable frozen ten-method observation facade, with no raw receiver,
mutator, executor, or registry Map. Every returned array, clue-match object, and match-text array is detached and
frozen; extracted methods remain bound to private authority.

GameSession internals uniformly use raw. The facade consequently observes real BARN installation and ordinary snapshot
restore without becoming another state owner. Standalone `InvestigationEngine` component mutators remain available.
The old regression was 1 pass / 2 fail; raw getter, raw alias, and raw-array-freeze mutations were respectively red at
1/2, 2/1, and 2/1, then exactly restored. Root verification was 157 tests / 19 files / 683 expects; supplemental
component/source fence 65 / 4 / 272; final facade+BARN 17 / 2 / 89, all zero-failure. Typecheck exited 0, review found
no blocker, and full `bun test` exited 0: 4340 tests / 356 files / 4304 pass / 36 skip / 0 fail / 25895 expects / 256.01s.

This closes only public InvestigationEngine reference authority. Public mutable `world` and canonical discovery,
remaining child/alias surfaces, transaction boundaries, and cross-store/crash consistency remain open under todo-65.
The final outside-sandbox `bun scripts/preflight.ts` exited 0: 287 boolean implementations / 0 discarded returns;
document-reference coverage was generated 3 / handwritten 8 / structured 1; internal typecheck exited 0; 4340 tests /
356 files matched the baseline (4304 pass / 36 skip / 0 fail); unwired 57 matched; and `core.hooksPath` was
`.githooks` with the commit-msg criterion running. This closes no additional todo-65 boundary.

## Correction: GameSession world reference is not assignable authority (2026-10-01)

`GameSession.world` previously existed as a writable/configurable own `WorldStateManager` property. Replacing that
reference could make public reads diverge from the canonical world used by Investigation, snapshots, and ordinary
actions; replacing it and then restoring the original reference also left the old source fence looking current.

GameSession now owns ECMAScript-private `#worldRaw` and exposes `world` through a getter-only compatibility reference.
All authoritative session paths—SQLite mutation stamp, snapshots/restores, Investigation and PlayerSession bindings,
close, action execution, and module-host adaptation—use raw. An external `Object.defineProperty` can still mask a
prototype getter for its own observation; it cannot divert these internal paths. The old shape regression exited 1 at
0 pass / 1 fail / 1 expect. Reconnecting `worldSqliteMutationStamp` to public `world` was a real red mutation: the
reflective-mask canonical scene A→B→A action committed with 200 rather than required 503 (24 pass / 1 fail / 208
expects); exact restoration was green.

Focused world/ordinary tests were 27 tests / 2 files / 229 expects, and broader Investigation, ordinary snapshot,
concurrency, compiled, and BARN coverage was 82 tests / 605 expects, all green. Root typecheck and the full suite
were green: 4343 tests / 357 files / 4307 pass / 36 skip / 0 fail / 25923 expects / 258.45s. This raises the baseline
by 3 tests / 1 file / 3 passes relative to Investigation, with 36 skips unchanged and unwired remaining 57. The final
`bun scripts/preflight.ts` exited 0: 287 boolean implementations / 0 discarded returns; generated/handwritten/
structured document-reference coverage 3/8/1; internal typecheck 0; 4343 tests / 357 files matched baseline;
unwired 57 matched; and `core.hooksPath` was `.githooks` with the commit-msg criterion running.

This closes only whole-reference assignment and internal authority drift through public-world masking. It does not
close public `WorldStateManager` mutators, `getDatabase`, `close`, method monkeypatching, reflection masking as an
external observation concern, raw database authority, or cross-store consistency. `WorldStateManager` has no `setDB`
API; that must not be recorded as an existing boundary.

## Correction: GameSession registry is not replaceable authority, and setDB is a semantic dependency write (2026-10-01)

`GameSession.registry` formerly exposed a writable/configurable own `AgentRegistry` reference. Replacing it split
public observations from the registry used by snapshots, module NPC registration, NPC dialogue, and ordinary source
fencing. Separately, `AgentRegistry.setDB()` treated an NPCStore dependency swap as invisible even when it went
A-to-B-to-A during a deferred ordinary action.

GameSession now owns ECMAScript-private `#registryRaw`; `registry` is a getter-only compatibility reference. Internal
snapshot/restore, module NPC registration, dialogue, and ordinary source-fence reads uniformly use raw. `setDB()` now
bumps the process-local, non-portable `semanticRevision` once for each real DB identity change and is a strict no-op
for the same instance. It does not change portable snapshot schema or `stateReplacementRevision`; standalone
`AgentRegistry` retains its legal mutable component API.

The old shape and setDB tests were red at 0 pass / 2 fail / 2 expects. Reconnecting the source fence to public
`registry` made a reflective canonical A-to-B-to-A interval publish 200 rather than required 503 (27 pass / 1 fail /
235 expects). Removing the setDB bump was red at 29 pass / 2 fail / 243 expects. Exact restoration was green: focused
31 pass / 255 expects, broader registry/snapshot/NPC/direct-action/BARN/ordinary coverage 89 pass / 555 expects, and
root typecheck exited 0. The full suite exited 0: 4349 tests / 358 files / 4313 pass / 36 skip / 0 fail / 25975 expects
/ 260.93s. A review found that the NPC dialogue test tried `registry-reference.invalid`; it now uses a local,
deterministic one-call fetch stub restored in `finally`, so the verification makes no external request. Final review
found no blocker. The first final preflight exited 0: 287 boolean implementations / 0 discarded returns, generated/
handwritten/structured refs 3/8/1, internal typecheck 0, and tests 4349 / 358 matched the baseline. It measured
unwired 57→56, so the baseline was tightened without guessing the cause; `core.hooksPath` was `.githooks`. The second
exact-match preflight also exited 0: boolean 287 / discarded 0, refs 3/8/1, internal typecheck 0, 4349 tests / 358
files exact baseline match (4313 pass / 36 skip / 0 fail from the full suite), unwired 56 exact match, and `.githooks`
with the commit-msg criterion running.

This closes only ordinary public whole-reference replacement and setDB dependency changes being invisible to the
source fence. It does not close public raw `register`/`restore`/`setDB`, live `NPCAgent` aliases, method monkeypatching,
TypeScript-private reflection, old agents bound to a prior DB, reflection as an observation mask, `npcStore`, or
cross-store consistency; todo-65 remains open.

## Correction: GameSession NPCStore is an observation facade, not session write authority (2026-10-01)

`GameSession.npcStore` previously exposed a writable/configurable live `NPCStore`, so ordinary replacement, raw
write/close methods, and aliases from readers could split persistence from the registry and snapshot/close paths.
GameSession now owns ECMAScript-private `#npcStoreRaw` and publishes one stable, frozen eleven-method read facade.
The facade has no raw receiver or close/restore/save/delete/add/prune/update method; snapshot, personality, memory,
relationship, and state results are cloned and recursively frozen. Constructor, AgentRegistry binding, ordinary
snapshot/restore/pristine export, owned-store close, and all authoritative source-fence reads use raw. An injected
store remains caller-owned and is not closed by the session.

The ordinary fence captures a validated string `CAST(total_changes() AS TEXT)` from both the raw world and the raw
NPCStore SQLite connections at the FIFO boundary. It detects a canonical NPCStore save-to-exact-restore ABA and a
rolled-back same-connection DML attempt which portable hashes cannot see. This corrects a potential overstatement:
SQLite `total_changes()` is a connection-local attempted-write counter (and can advance for rolled-back DML), not a
database-content version, rollback proof, or cross-connection sequence. It therefore does not cover another SQLite
connection, DDL/PRAGMA, or an external database transaction.

The old facade regression exited 1 at 1 pass / 3 fail / 5 expects. Returning raw, deleting the NPCStore stamp, and
exporting through the public facade were real red mutations; deleting the stamp made both same-connection ABA cases
publish 200 instead of required 503 (27 pass / 2 fail / 244 expects). Exact restoration was green: focused verification
was 33 tests / 2 files / 284 expects; independent facade/server isolation was 5 / 2 / 37 and ABA filtering 2 / 1 / 19
with 27 filtered; the strengthened facade file was 4 / 1 / 31; typecheck exited 0. Full `bun test` exited 0: 4354 tests
/ 359 files / 4318 pass / 36 skip / 0 fail / 26026 expects / 259.97s. The first fresh preflight exited 0 and measured
unwired 56→53, so the baseline was tightened without claiming a cause. The second exact-match preflight exited 0:
287 boolean implementations / 0 discarded returns; internal typecheck 0; tests 4354 / 359 exact; unwired 53 exact;
and `core.hooksPath` `.githooks` had the commit-msg criterion running. This closes only the GameSession public NPCStore write/reference surface and the
same-connection fence. Public raw AgentRegistry/NPCAgent access, caller-owned mutable stores, prototype monkeypatching,
TypeScript-private reflection, old-agent DB bindings, cross-store consistency, and cross-connection/DDL/PRAGMA remain
open under todo-65.

## Correction: GameSession KP is a read facade, not session authority (2026-10-01)

TypeScript `readonly` on an own property is a compile-time restriction, not a
runtime authority boundary. The former `GameSession.kp` was a
writable/configurable own live `KPAgent`; replacement, a retained alias, or a
public raw monkeypatch could expose mutators and make the public observation
diverge from the client used by the session.

GameSession now owns ECMAScript-private `#kpRaw` and a stable frozen public
facade. The prototype getter has no setter or own property and exposes exactly
`getDirective` and `getTurns`; both results are detached and recursively
frozen. Opening-scene, world-context, and action-narration execution use the
private canonical KP path, so a public reflection mask changes only external
observation. This does not make standalone `KPAgent` immutable or close
prototype monkeypatching, TypeScript-private reflection, provider/resource
policy, public `worldModel`/`wmIntegrator` references, or the remaining
registry, NPCAgent, world, and transaction authority boundaries.

Test method correction: KP wiring tests must drive the actual request boundary
through a deterministic local `fetch` capture, rather than monkeypatching the
public raw child. Every temporary environment override and fetch stub must be
restored in `finally`, including failure paths. Every test-created session must
also close session-owned SQLite authorities in `finally` or reliable
`afterEach`; multi-session loops must close all registered sessions even when a
peer close throws, while a constructor failure is never registered as an owned
resource. This preserves zero external requests without adding a production
test seam.

Verification correction: the first fresh KP preflight exited 0 and measured
unwired methods 53 to 52, so the regression ceiling was tightened without
attributing the change. A second preflight after that update also exited 0 and
matched exactly: 287 boolean-returning implementations with 0 discarded
returns, typecheck 0, 4357 tests / 360 files / 4321 pass / 36 skip / 0 fail,
unwired 52, and `.githooks` as `core.hooksPath`. This validates the recorded
slice only; it does not close todo-65 or make the remaining authority boundaries
complete.

## Correction: GameSession world-model readers are not loader authority (2026-10-01)

The earlier KP scope still listed public `worldModel` and `wmIntegrator` as
open. That was correct at the time but is now superseded for the three
GameSession references: `worldModel`, `wmIntegrator`, and `cthulhuLoader` are
prototype getters with no setter or own raw value. Their per-session public
values are stable frozen read facades; the v18/Cthulhu facades have explicit
non-mutating compatibility readers only, and the integrator facade freezes and
detaches compound output. They do not expose `load`, `consumeCausal`, loader
fields, a rebind path, or the raw integrator.

The canonical session references are ECMAScript-private `#worldModelRaw`,
`#wmIntegratorRaw`, and `#cthulhuLoaderRaw`. Legacy context construction uses
only these raw references, so masking a public getter does not redirect loading
or prompt context. Trusted runtime dependencies may inject raw v18 and Cthulhu
loaders for a host-controlled local fixture or production embedding; request and
module data cannot select them, the injector retains any alias, and GameSession
always constructs the integrator from that same private v18 loader. There is no
integrator injection seam.

The loader's admission path already deeply freezes every JSON-derived entry.
The public facade therefore makes a fresh frozen result container while sharing
those immutable entries, rather than `structuredClone`-ing a 383k-entry corpus
on every read. `randomCausal` remains a non-deterministic compatibility read;
it is not evidence that the facade or the loader is pure or deterministic.

Sharing also needs a loaded witness, not merely two unloaded objects with equal
status. An isolated child process now points both defaults at small local JSONL
fixtures before importing runtime code, drives two default sessions through
actual lazy injection, and separately proves v18 and Cthulhu behavior: the
first session loads each default shared bucket once, the factory sees that
loaded bucket, and the second session's distinct frozen facade reads the same
entry and novel statistics without a second load. The child restores its
prototype counter, closes both sessions, uses a one-record stdout protocol, and
the parent concurrently drains stdout/stderr, rejects non-zero/oversized output,
and removes the fixture directory in `finally`.

The prior implementation failed 0 pass / 4 fail / 5 expects. Returning a raw
getter, routing one execution call through `this.wmIntegrator`, and returning
unfrozen integrator output were real red mutations. Replacing either default
shared loader with a per-session `new WorldModelLoader()` also made the isolated
sharing proof red. Restoration was green: six directed files were 41 pass / 0
fail / 271 expects; the final sharing/facade/compiled-scope review was 20 / 0 /
153; typecheck exited 0; and full `bun test` exited 0 with 4362 tests / 361
files / 4326 pass / 36 skip / 0 fail / 26161 expects in 259.11s. The first
fresh preflight measured unwired 52→48 and tightened the baseline without
assigning a cause. The second exact-match preflight exited 0: 287
boolean-returning implementations / 0 discarded returns; typecheck 0; 4362
tests / 361 files / 4326 pass / 36 skip / 0 fail matched exactly; unwired 48
matched exactly; and core.hooksPath was `.githooks` with the commit-msg
criterion running. todo-65 remains open.

This closes only GameSession public capability exposure. It does not close the
standalone/shared loader or CLI APIs, aliases retained by trusted injectors,
prototype monkeypatching or TypeScript-private reflection, path/content
identity, concurrent load/revision behavior, or source-fence cache ABA.

## Correction: removing a public write capability can close an ABA that a net snapshot cannot see (2026-10-01)

`GameSession.politicoEconomy` was a writable, configurable own reference to a
live `PoliticoEconomyEngine`. A deferred ordinary HTTP action could use the
public `exportSnapshot() -> advanceRound() -> restoreSnapshot()` sequence and
return portable economy content exactly to its prior value. The snapshot hash
therefore saw no interval and the candidate incorrectly committed with 200.

The appropriate boundary fix is not a new portable revision field or a
production-only test seam. `GameSession` keeps `#politicoEconomyRaw` private;
its public getter returns one frozen six-key observation facade: dynamic
`round`, `getState`, `getBriefState`, `getEconomyVizData`,
`getDiplomaticContext`, and `renderEconomyHtml`. Structured results are cloned
and recursively frozen. Snapshot/restore, state projection, economy action,
and clock code use raw, so a reflection mask is observation-only.

The durable regression deliberately has two outcomes. If legacy raw capability
exists, it performs the real ABA and requires retryable 503, generation 0, no
receipt, no broadcast, and no source publication. If the capability is absent,
no mutation is possible and the ordinary request must normally commit with
generation 1, a matching durable receipt, and one broadcast. This preserves a
real old-path counterexample without inventing a post-fix write seam.

Fresh preflight for this slice exited 0 with 287 boolean-returning
implementations and 0 discarded returns. Its internal typecheck passed; 4367
tests / 362 files / 4331 pass / 36 skip / 0 fail and 48 unwired methods exactly
matched the baseline; `core.hooksPath` was `.githooks` with the commit-message
criterion running. This validates the slice and does not close todo-65.

## Correction: an execution-only child needs no public read facade (2026-10-01)

`GameSession.rules` was a writable/configurable own `RulesEngine` reference.
Unlike an observation-oriented child, the session has no supported public read
contract for this engine: the engine only adjudicates internal combat. A frozen
facade would therefore preserve an unnecessary capability and create a second
contract to maintain. The correct boundary is complete absence, not a facade:
`GameSession` owns one ECMAScript-private `#rulesRaw`, publishes no `rules`
own property or prototype getter, and each of its four combat adjudication
sites uses the same private engine.

The regression must drive the actual execution paths. A source-derived compiled
encounter proves the player and NPC counterattack calls; an ordinary CoC turn
proves both ordinary calls through enemy and player damage; DnD and Grail
ordinary turns prove their NPC-counter dispatch. All run while a public
`Object.defineProperty` decoy throws, so a public routing regression fails
without inventing a production test seam. The prior public own raw and one
compiled public-shadow mutation were both red before exact restoration.

Portable snapshots record a `ruleset`, not engine identity. That was never a
substitute for protecting an exposed live engine reference: any identity or
method substitution could occur outside the snapshot contract. Hiding this
execution-only child removes that public authority rather than adding a
portable revision field. This leaves standalone `RulesEngine`/CLI behavior,
prototype monkeypatching, TypeScript-private reflection, and the unrelated
`ruleEngine`/`spellEngine` fields outside this slice.

## Correction: default-registry test helpers must own and release their lifetime (2026-10-01)

The first final preflight after the RulesEngine authority slice failed, but the
failure was not a rules regression. The compiled-player delivery default-auth
test helper let its fixture registry escape into the server's global default
registry. Repeated default construction therefore accumulated state and crossed
the helper's five-second timeout at a run-dependent point.

The diagnosis was deliberately time-independent: the dynamic origin test was
red under the default timeout (0 pass / 1 fail after roughly 5.4-5.9 seconds)
but green at 20 seconds; sequential default-registry creates grew from roughly
1.0 to 1.35 to 2.56 seconds, while a fresh test-local registry closed in
`afterEach` remained around 1.0 seconds. That distinguishes a harness lifetime
leak from a production performance claim or a rules-engine semantic failure.

The test repair is scoped to its fixture: it creates a local registry, uses one
`afterEach` path to close and clear it, and grants only the heavy end-to-end
case a 20-second timeout. The file went from 6 pass / 1 fail to 7 pass / 0
fail; player-delivery plus rules review was 11 pass / 2 files / 0 fail. Final
preflight then passed with 4371 tests / 363 files, 4335 pass / 36 skip / 0
fail, and 48 unwired methods. This validates the completed rules authority and
test-harness lifetime slices; it does not mark todo-65 or the broader
production-quality goal complete.

## Correction: a multi-PC SAN fence must bind the whole live cohort (2026-10-01)

A frozen public SAN view is not enough when inactive party members retain
separate engines. `PartyMemberView` now publishes only frozen state, never its
internal member or raw `SanityEngine`; the ordinary all-SAN fence captures a
pcId-sorted cohort's cardinality, raw identity, and semantic revision, then
checks the party key/member.pcId/raw aliases and active raw/map aliases.

That makes an inactive p2 A→B→A engine interval visible even when final
portable content looks equal: it must reject with retryable 503, generation 0,
no receipt, and no broadcast. An exact p2 no-op remains a normal 200. The
cardinality assertion is deliberately composite protection with the portable
hash; it is not misdescribed as independently mutation-proven. This does not
turn TypeScript-private maps or party containers into ECMAScript `#private`
state, and `PartyMemberView.sheet` remains a writable compatibility reference.

## Correction: a wrapper exit code is not test evidence unless it awaits the child (2026-10-01)

A nested PowerShell command in double quotes expanded `$LASTEXITCODE` in the
outer shell and once printed a wrapper exit code of zero alongside a one-failure
test summary. That result is invalid, not a flaky green run. The trusted full
rerun uses `Bun.spawn`, drains stdout and stderr concurrently, and awaits
`p.exited`; it exited 0 with 4379 tests / 363 files, 4343 pass / 36 skip / 0
fail, and 26229 assertions in 417.82 seconds.

The earlier 4379-test run's lone failure was a career-departure heavy E2E
exceeding its default five-second timeout at 5780.93ms. Its isolated file was
5 pass / 0 fail with correct cleanup, so only the three durable heavy E2Es use
20-second local limits. This is a test-budget correction, not a production
performance claim, and it does not complete todo-65 or the production-quality
goal.

## Correction: SAN maps are now runtime-private, while member sheets are not (2026-10-02)

The Slice B note above correctly records its then-open boundary but is
superseded for GameSession's SAN containers. `sanityEngines` and `party` are
now ECMAScript-private `#sanityEngines` and `#party`; neither own-property nor
reflection observation exposes the real maps. Assigning same-name external
maps produces inert shadows, not an authority path. Snapshot restore may still
replace the private maps as one consistent operation.

The package-internal `sanity-cohort-fence` is the shared ordinary-source state
authority. It receives caller-owned maps and party iterable rather than a
GameSession, captures pcId-stably-sorted cohorts, and checks map cardinality,
raw identity, semantic revision, party key/member.pcId/raw aliases, and the
active raw/map alias. It supplies no raw test seam, constructor injection, or
exported symbol. This closes runtime SAN-map privacy, not the writable
`PartyMemberView.sheet` compatibility reference or `characters`; both remain
later Slice D scope and todo-65 remains open.

The legacy TypeScript-private own-property/non-`#` fallback was red in the
runtime-privacy regression. Removing each helper size, identity, revision,
party-alias, or active-alias check also produced its corresponding red test;
exact restoration was green. Directed Slice C coverage was 108 pass / 6 files
/ 0 fail / 790 assertions and root typecheck exited 0. The trusted full
`Bun.spawn` runner drained both streams and awaited exit: 4381 tests / 363
files / 4345 pass / 36 skip / 0 fail / 26307 assertions in 505.08 seconds.
The prior unwired-method baseline of 48 is intentionally retained pending a
fresh preflight; no preflight is claimed here.

## Correction: isolated child fixtures must release their own process state (2026-10-02)

The child-lifecycle correction is test-only. Each isolated child uses its own
registry, closes sessions, has a 15-second internal deadline within the
20-second test budget, and is concurrently drained then killed/awaited by the
parent. It does not change product semantics. The post-fix combined regression
was 40 pass / 3 files / 0 fail / 335 assertions in 55.65 seconds; the isolated
child completed in 1913ms.

## Correction: SAN Slice C now has fresh preflight evidence (2026-10-02)

The preceding Slice C wording that retained 48 unwired methods pending a fresh
preflight is superseded, not an expansion of the slice. `bun
scripts/preflight.ts` was run outside the sandbox and exited 0: 288
boolean-returning implementations / 0 discarded returns; generated,
handwritten, and structured references were 3 / 8 / 1; internal typecheck
exited 0; 4381 tests / 363 files exactly matched the baseline; and
`unwiredMethods` 48 exactly matched. `core.hooksPath` was `.githooks` and the
commit-msg criterion ran. This validates the recorded runtime SAN-map privacy
and test-fixture evidence only; `PartyMemberView.sheet`, `characters`, and
todo-65 remain open.

## Correction: character observations must not be character authority (2026-10-02)

The preceding final sentence is superseded for `PartyMemberView.sheet` and
`characters`. `GameSession` now holds canonical characters in ECMAScript-private
`#characters`. Reflection and a same-name external `Map` can create only an
inert shadow. `PartyMemberView.sheet` is likewise an observation: every view
contains a detached recursively frozen snapshot. A retained view therefore
stays frozen and stale after a later controlled update; fresh party state,
world state, and portable snapshots are the observable canonical evidence.

The explicit character-patch and luck-spend APIs materialize a caller record
once before validation or commit. They accept only enumerable string own data
descriptors on ordinary `Object.prototype` records, reject accessor,
non-enumerable, Symbol, dangerous-key, and throwing-Proxy inputs fail-closed,
and never reread caller-owned objects. Finite, in-domain values are then
validated as one patch. HP and maxHp apply to ordinary rulesets and synchronize
canonical character and world; skills, luck, credit rating, attributes, and
luck spending are CoC-only. A mixed D&D/Grail HP-plus-luck patch therefore
rejects atomically rather than taking the HP portion.

First-aid source selection is package-internal, with consumers using the
helper's `healing` field rather than recomputing it. The latent server
character and luck handlers call the controlled APIs, but ordinary HTTP still
returns `ordinary_mutation_not_durable` 409 before body read. This does not
claim a durable HTTP write path: derive-persist-install, latent
character-to-inventory-to-weapons transactionality, cross-store authority,
and todo-65 remain open.

The original privacy/synchronization mutations and the later caller-TOCTOU,
ruleset-guard, and Proxy-reflection mutations each produced red regressions
before exact restoration. Directed Slice D verification was 194 pass across
22 files with typecheck exit 0. The first trusted full run exposed one old
test-contract error: it expected a detached party view to update live. After
the test instead asserted a stale frozen view and read fresh canonical
projections, the trusted full run exited 0 with 4393 tests / 364 files / 4357
pass / 36 skip / 0 fail / 26414 assertions in 412.09s. `unwiredMethods` stays
48 pending a fresh preflight; this note does not claim preflight ran.

## Correction: Character Authority Slice D now has fresh preflight evidence (2026-10-02)

The preceding Slice D pending-preflight wording is superseded only for that
evidence. Root ran `bun scripts/preflight.ts` outside the sandbox and it exited
0: 288 boolean-returning implementations with 0 discarded returns; generated,
handwritten, and structured document references were 3 / 8 / 1; internal
typecheck exited 0; 4393 tests / 364 files exactly matched the baseline;
`unwiredMethods` 48 exactly matched; and `core.hooksPath` was `.githooks` with
the commit-msg criterion running.

This validates the recorded Character Authority Slice D tests and baseline. It
does not broaden its runtime-character, detached-observation, controlled-patch,
and fail-closed input boundaries, and it does not close todo-65's ordinary
durable mutation protocol or the remaining cross-store/transactional work.

## Correction: execution-only session children need no public facade (2026-10-02)

`GameSession` had constructed and publicly exposed `RuleEngine` and
`SpellEngine` children without any in-session consumer or supported observation
contract. The correct authority boundary is their absence: it neither
constructs nor publishes either child, rather than retaining a read facade for
an execution-only capability.

`NPCCombatEngine` remains necessary solely for execution-time creature metadata.
It is now ECMAScript-private `#npcCombatRaw`, and the real Shoggoth sighting
SAN-cost lookup uses that authority. A same-name public `npcCombat` property
can therefore only be an inert shadow; it cannot redirect sighting execution.
Standalone engine and CLI APIs are unchanged. The old public contract failed
three regressions; restoring each removed public child or the public NPC route
made its corresponding test red, and exact restoration was green. Directed
coverage and typecheck passed, as did the trusted full suite at 4396 tests /
365 files / 4360 pass / 36 skip / 0 fail.

## Correction: execution-only child Slice E now has fresh preflight evidence (2026-10-02)

The preceding pending-preflight wording is superseded only for that evidence.
Root ran `bun scripts/preflight.ts` outside the sandbox after the baseline
update and it exited 0: 288 boolean-returning implementations with 0 discarded
returns; generated, handwritten, and structured document references were 3 / 8
/ 1; internal typecheck exited 0; 4396 tests / 365 files and `unwiredMethods`
48 exactly matched the baseline; and `core.hooksPath` was `.githooks` with the
commit-msg criterion running. This validates Slice E only and does not close
todo-65 or expand its production-hardening scope.

## Correction: Mythos spell names are capability identities, not loose intent text (2026-10-02)

`GameSession` now keeps learned Mythos spell names and canonical definitions in
ECMAScript-private maps. The legacy module host has only a narrow
`registerSpell` capability, and retained module-loader callbacks are private as
well; a public shadow or TypeScript-private alias cannot become a second spell
authority.

For CoC, cast admission requires both an exact learned canonical name and the
matching canonical definition. Parser handling consequently preserves
`呼唤`/`召唤`/`驱逐`/`放逐` in the spell identity and strips only outer action
prefixes such as `念咒` or `吟唱`. A real reading-to-casting-to-snapshot/restore
path demonstrates the authority; an unknown call and an unlearned banishment
remain rejected, while D&D remains unchanged. Public-name, runtime-map,
length-only, loader-alias, and natural-command-extractor regressions were each
made red and restored green. Directed coverage, typecheck, and the 4399-test
full suite passed.

This is not complete spell provenance. `handleRead` still has a hardcoded tome
catalogue and does not require a tome to be present in the active scene or
actually held. Fresh preflight is pending; public world and the other todo-65
authority and transaction boundaries remain open.

## Correction: Mythos spell authority Slice F now has fresh preflight evidence (2026-10-02)

The preceding pending-preflight wording is superseded only for that evidence.
Root ran `bun scripts/preflight.ts` outside the sandbox after the baseline
update and it exited 0: 288 boolean-returning implementations with 0 discarded
returns; generated, handwritten, and structured document references were 3 / 8
/ 1; internal typecheck exited 0; 4399 tests / 366 files and `unwiredMethods`
48 exactly matched the baseline; and `core.hooksPath` was `.githooks` with the
commit-msg criterion running. This validates Slice F only: the hardcoded
`handleRead` catalogue and its missing scene/possession provenance check remain
open, as do todo-65's public-world, authority, and transaction boundaries.

## Correction: a tome name is not execution authority (2026-10-02)

Slice G replaces the old hardcoded `handleRead` catalogue with installed
`RuntimeModuleTome` declarations. The declaration registry and scene placement
are ECMAScript-private; module loaders receive only a narrow registration
callback and source modules retain no raw registry alias. A read must resolve
an exact installed declaration, then prove either exact canonical world
inventory possession or private placement at the active player's canonical
world scene. The player position is never inferred from a command target.
Unloaded titles, remote titles, another module's title, same-name public
shadows, and missing player entities reject before any SAN, CM, learned-spell,
or Mythos-log side effect.

Executable declarations have one shared preflight/normalization contract for
legacy loader, direct loader, and GameSession callback: rating is an integer in
1..99; SAN cost has exactly two bounded `integer`, `NdM`, or `NdM+K`
components; and spell names are unique. This prevents accepting a declaration
that would first alter SAN and only then make `learnCthulhuMythos` fail. The
source-consistent Barn value `1/1d3+1` remains authoritative: the canonical
modifier is now actually applied by `SanityEngine.parseSanCost`, while generic
legacy non-tome parsing remains permissive. A listed tome spell without an
installed definition is skipped, never fabricated into casting authority.

Red-first tests covered unsafe legacy/direct declarations and the previously
ignored `+K`. Real mutations restoring a hardcoded fallback, target-derived
location, ignored possession, old fixed values, TypeScript-private
`sceneItems`, finite/nonempty-only validation, or modifier-ignoring parsing
each made a matching regression red; exact restoration was green. Root
directed coverage was 258 tests / 12 files / 3132 assertions / 0 fail and
typecheck exited 0. The first full run (4408 tests / 367 files) was exit 1 only
because three historical tests reflected `sceneItems`, expected arbitrary prose
to fabricate reading narration, or seeded CM from an uninstalled Necronomicon.
They were migrated to public loading plus movement, explicit rejection, and a
pristine-target signed ordinary snapshot that updates and re-signs both the
session SAN truth and world SAN mirror. The final full run exited 0: 4408 tests
/ 367 files / 4372 pass / 36 skip / 0 fail / 26555 assertions / 403.12s.

This is not inventory pickup completion: `handlePickup` remains narration-only,
so the inventory-positive proof uses an existing controlled canonical world
inventory source. Root then ran fresh outside-sandbox `bun scripts/preflight.ts`: exit 0; 289 boolean-returning
implementations / 0 discarded returns; internal typecheck exit 0; 4408 tests / 367 files and unwiredMethods 48 exactly
matched the baseline; and core.hooksPath was `.githooks` with the commit-msg criterion running. Slice G does not close
todo-65's broader public-world, child-authority, transaction, or durable/crash
boundaries.

## Correction: pickup custody must be a real world-state transfer (2026-10-02)

The former `handlePickup` merely narrated success. It now admits only an exact
installed package declaration that is physically placed at the active player's
canonical world scene, writes that name into canonical `WorldState` inventory,
then removes the corresponding private placement. An exact model item is
accepted; the offline fallback accepts only a complete pickup command. Remote,
unknown, foreign-package, trap, duplicate pickup, and missing
entity-or-position requests fail closed. A failed WorldState inventory write
leaves the placement intact.

One normalization contract supplies pickup origins from legacy placements,
rich key/document/weapon/loot declarations, and installed tomes. It rejects
same-name cross-location declarations, semantic conflicts, orphan/illegal
sources, and pre-existing inventory collisions before a host write. The private
origin registry cannot be replaced by a same-name public shadow. Snapshot
validation applies conservation per origin: it must appear in its declared
scene xor exactly one verified `PlayerSession` inventory. Loss, duplicate,
both-location, relocation, and foreign-player states reject; the verified
dynamic placement is restored. A `PlayerSession` without a character remains a
valid player identity, so using `state.characters` as the identity set was a
bug rather than a security boundary.

The old narration-only route, removed remote gate, old static scene comparison,
and wrong character-derived snapshot identity each produced a targeted red
test; exact restoration was green. Root verification was 125 pass across 10
files with 1349 assertions, typecheck exited 0, and the full suite was 4420
tests / 368 files / 4384 pass / 36 skip / 0 fail / 26686 assertions in 404.95s.
This does not claim global atomicity: inventory is written before private
placement removal, and process-crash or cross-store recovery remains open under
todo-65. Fresh preflight is not claimed by this record.

## Correction: ordinary pickup Slice H now has fresh preflight evidence (2026-10-02)

The preceding Slice H note's no-preflight wording is superseded only for that
evidence. Root ran `bun scripts/preflight.ts` outside the sandbox and it exited
0: 290 boolean-returning implementations with 0 discarded returns;
generated, handwritten, and structured document references were 3 / 8 / 1;
internal typecheck exited 0; 4420 tests / 368 files and `unwiredMethods` 48
exactly matched the baseline; and `core.hooksPath` was `.githooks` with the
commit-message criterion running.

This validates the recorded Slice H custody, admission, and snapshot evidence
only. It neither broadens the world-state transaction claim nor closes
todo-65.

## Correction: GameSession AgentRegistry is an observation, not a capability (2026-10-02)

`GameSession.registry` is now one stable frozen data-only facade over the
private `#registryRaw`. It dynamically exposes only `count`, `has(name)`, and
`getAllNames()`; each returned name array is detached and frozen. Module NPC
registration, ordinary snapshot export/restore, and dialogue continue through
the private registry, so a same-name public shadow cannot become an internal
authority path. The server's unreachable later raw `/npc-chat` handler was
removed while its existing compiled/ordinary POST pre-body 409 guards remain.
Standalone `AgentRegistry` is unchanged.

This corrects the earlier test shape: eight GameSession raw-registry ABA tests
were not discarded. Their registry revision/snapshot semantics are covered at
the standalone registry boundary, while facade-unreachability and a real
same-name-shadow module/dialogue integration cover the GameSession boundary.
The net suite grows by three tests rather than reducing coverage. Restoring the
raw getter, routing an internal registry check through the facade, or returning
an unfrozen name list each made its regression red; restoration was green.
Root verification recorded 4423 tests / 368 files / 4387 pass / 36 skip / 0
fail / 26679 assertions in 412.27s, with typecheck exit 0. This note does not
claim a fresh preflight and does not close todo-65's remaining authority or
transaction boundaries.

## Correction: AgentRegistry facade Slice I now has fresh preflight evidence (2026-10-02)

The preceding Slice I no-preflight wording is superseded only for that
evidence. Root ran `bun scripts/preflight.ts` outside the sandbox and it exited
0: 290 boolean-returning implementations with 0 discarded returns; generated,
handwritten, and structured document references were 3 / 8 / 1; internal
typecheck exited 0; 4423 tests / 368 files and `unwiredMethods` 48 exactly
matched the baseline; and `core.hooksPath` was `.githooks` with the
commit-message criterion running.

This validates the recorded Slice I facade evidence only. It does not broaden
the boundary or close todo-65. This documentation backfill performs only JSON
and diff checks; it does not claim a second full-suite or preflight run.

## Correction: GameSession CompanionManager is an observation, not a capability (2026-10-02)

`GameSession.companionManager` now exposes one stable `Object.freeze` read
facade backed by ECMAScript-private `#companionManagerRaw`, rather than the raw
mutable manager. Its exact surface is `findByEntityId`, `getActiveCompanions`,
`getCommandObeyState`, `getControl`, `getMorale`, `getPlayerControlled`,
`hasActed`, `hasItem`, `isActive`, `listItems`, and `resolveWeapon`. Structured
reader results are `structuredClone`d and recursively frozen; arrays are fresh
for each call. Snapshot export/restore, state, KP, suggestions, find, round,
control, and combat all retain raw authority, so a public shadow cannot become
an internal command path. The standalone `CompanionManager` write API is
unchanged.

The fixture correction matters as much as the facade: the three former
GameSession raw-manager tests now prepare a real source snapshot through
standalone `WorldStateManager`/`CompanionManager`, re-sign it, and restore it
into a pristine `GameSession`. They do not retain a public GameSession mutator
as a test-only back door. The old 5 + 6 + 16 cases remain, with four new
facade cases. Restoring the raw getter, routing internal `setControl` through a
public shadow, or returning a live active-companions alias each made its
matching regression red; exact restoration was green. Root verification was
90 pass / 8 files / 646 assertions, typecheck exit 0, and the full suite was
4427 tests / 369 files / 4391 pass / 36 skip / 0 fail / 26730 assertions in
534.05s. This note does not claim a fresh preflight and does not close
todo-65: `GameSession.world` remains raw, standalone companion writes,
prototype monkeypatching, TypeScript-private reflection, cross-component or
cross-store consistency, crash/power-loss behavior, and a production recruit
caller remain open.

The first attempted final preflight is deliberately not recorded as green: it
exited 1. Its internal typecheck exited 0 and it retained 4427 tests / 369
files, but `CompiledSessionSnapshotStore cross-process CAS > admits exactly
the measured peak` was the sole failure (4390 pass / 1 fail). The exact test
then passed independently three times (1 pass / 0 fail each), and the complete
file was 27 pass / 0 fail / 124 assertions, so this did not establish a
deterministic Slice J defect. The same failed preflight measured
`unwiredMethods` 47; the baseline is tightened by one without attribution,
because the current name-based reference check can be influenced by same-name
member references. A fresh passing preflight has not yet been obtained.

## Correction: CompanionManager facade Slice J now has fresh preflight evidence (2026-10-02)

Only the preceding pending-preflight statement is superseded. The first
preflight exit 1, its sole `CompiledSessionSnapshotStore` cross-process CAS
failure, and the three exact plus one complete-file green reruns remain part of
the record. After `unwiredMethods` was tightened to 47, root ran
`bun scripts/preflight.ts` outside the sandbox and it exited 0: 290
boolean-returning implementations with 0 discarded returns; generated,
handwritten, and structured references were 3 / 8 / 1; internal typecheck
exited 0; 4427 tests / 369 files and `unwiredMethods` 47 exactly matched the
baseline; and `core.hooksPath` was `.githooks` with the commit-message
criterion running.

This validates Slice J only; it does not close todo-65. This documentation
backfill performs only JSON and diff checks and does not claim another full
suite or preflight run.

## GameSession ruleset selection is canonical authority, not presentation (Slice K, 2026-10-02)

Ruleset selection determines executable rules, not just what a summary says.
`GameSession.activeRuleset` therefore keeps its canonical value in
ECMAScript-private `#activeRulesetRaw`; the getter is compatibility
observation only. A same-name own-property shadow can change a caller's direct
observation, but every internal rules, NPC, spell, host, snapshot, summary,
and character-creation decision must retain the raw authority.

The useful test pair distinguishes a presentation check from execution
evidence: external assignment must not change a DnD projection, and the real
CoC-only luck gate must still reject DnD even after an own-property shadow.
Routing that gate through the public getter was a red mutation despite a
passing-looking public surface, which is why presentation assertions alone are
not sufficient authority evidence. This closes only ruleset-selection
replacement/shadow authority. `GameSession.world`, other public mutable state,
prototype monkeypatching/private reflection, cross-store/crash consistency,
and other transaction boundaries remain open. `docs/notes/index.json` has
concurrent changes, so its refresh remains intentionally deferred.

## Correction: Slice K ruleset authority now has final preflight evidence (2026-10-02)

The preceding Slice K wording that fresh preflight was pending is superseded
only for that evidence. The first `bun scripts/preflight.ts` exited 1 for one
static test-quality issue: the new ruleset test had an empty `catch` on line
28. Its internal typecheck was already 0, and it already measured the exact
4429-test / 370-file baseline, `unwiredMethods` 47, and normal `.githooks`
commit-message enforcement. The test was corrected to record explicit
`assignmentStatus`/`TypeError` behavior; its dedicated contract then passed
2 cases / 0 failures / 8 assertions and typecheck exited 0.

The second complete preflight exited 0: 290 boolean-returning implementations
with 0 discarded returns; generated, handwritten, and structured document
references 3 / 8 / 1; internal typecheck 0; 4429 tests / 370 files and
`unwiredMethods` 47 exactly matching baseline; and `.githooks` with the
commit-message criterion running. This preserves the first failure and
validates Slice K only; it neither expands the ruleset-authority boundary nor
closes todo-65. No third preflight is claimed. `docs/notes/index.json` remains
intentionally unrefreshed because concurrent changes must not be overwritten.

## GameSession round is causal and persistent authority (Slice L, 2026-10-02)

A round counter is not merely presentation: it drives committed action traces,
economy tick causation, events, snapshots, and module-host behavior. Its
canonical value must therefore be private; a public getter can observe that
value but cannot be an internal execution route. A same-name own-property
shadow may hide a caller's direct read, yet a real action and every committed
projection must continue from the private counter.

Tests that need a later round must reach it through real actions, rather than
injecting a public counter value. The economy regression now performs ten
ordinary `/roll 1d6` actions before checking the tenth-round tick. That also
exercises the causal path that a direct fixture write would skip. An own-shadow
regression must cover the commit projection—state, summary, and snapshot—not
just getter output. This closes only round replacement/shadow authority;
public world, `combatActive`, other mutable state, reflection/monkeypatching,
and cross-store or crash consistency remain open. `docs/notes/index.json`
remains deferred because concurrent changes must not be overwritten.

## Correction: Slice L round authority has fresh preflight evidence (2026-10-02)

The preceding Slice L fresh-preflight-pending wording is superseded only for
this evidence. Root ran one fresh outside-sandbox `bun scripts/preflight.ts`
and it exited 0: 290 boolean-returning implementations with 0 discarded
returns; generated, handwritten, and structured document references 3 / 8 / 1;
internal typecheck 0; 4431 tests / 371 files and `unwiredMethods` 47 exactly
matching baseline; and `.githooks` with the commit-message criterion running.

This validates Slice L only. It neither expands the round-authority boundary
nor closes todo-65, and does not claim a second or later Slice L preflight.
`docs/notes/index.json` remains intentionally unrefreshed because concurrent
changes must not be overwritten.

## GameSession configuration must not become an HTTP recovery capability (Slice V, 2026-10-02)

A public session configuration can leak API credentials and let a recovery path
quietly reintroduce that authority even after the main session surface is
sealed. Compiled recovery must instead accept one trusted host factory and use
it consistently at every normal and conflict HTTP call site. The regression
needs real HTTP recovery with a throwing public-config shadow, not just a
source scan; the scan complements the behavioral proof.

The root-independent assertion result is the recorded test evidence (24),
rather than a conflicting agent-local count. This closes only public config/API
key exposure and those recovery reads. Other host recovery design, public
aliases, reflection/prototype risks, transactions, crash consistency,
deployment, and external-model work remain open. Slice V changes no checkpoint
I/II/III boundary. Generated documents and `docs/notes/index.json` remain
deferred while concurrent changes exist, and fresh final preflight is still
pending.

## Cleanup lifecycle observations are authority when they protect live work (Slice Y, 2026-10-02)

A prototype getter becomes authority when an external lifecycle decision such
as session cleanup consumes it. The transaction count must be private and its
compatibility observation must be a protected own accessor; descriptor tests
alone are insufficient. A real cleanup counterexample must hold an actual
transaction gate, attempt a same-name false shadow, and show that cleanup no
longer removes a live session.

An unrelated mixed-run failure is not erased by an isolated green rerun. The
child NPC isolation failure remains recorded as a failed four-file combination;
its isolated passing file only prevents an unsupported Slice Y or NPC change.
Public world/canonical discovery, other aliases, reflection/prototype risks,
cross-store transactions, crash/power-loss consistency, deployment, and
external-model work remain open. Slice Y changes no checkpoint I/II/III
boundary. Generated documents and `docs/notes/index.json` remain deferred
while concurrent changes exist; fresh final preflight is still pending.

## Correction: Slice W active-player selector has final preflight evidence (2026-10-02)

The preceding Slice W pending-preflight wording is superseded only for this
evidence. Exact sandbox `bun scripts/preflight.ts` exited 1 with six
`uv_spawn cmd.exe` EPERM failures before internal typecheck, tests, probe, or
hooks checks started. It is an environment block, neither semantic failure nor
green evidence. Root reran the same command outside sandbox and it exited 0:
291 boolean-returning implementations with 0 discarded returns; generated,
handwritten, and structured document references 3 / 8 / 1; internal typecheck
0; 4463 tests / 382 files and `unwiredMethods` 47 exactly matching baseline;
and `.githooks` with the commit-message criterion running.

This is the one recorded successful Slice W preflight. It validates only that
slice, leaves todo-65 and the total production goal open, and does not claim a
second or later successful run. Generated documents and `docs/notes/index.json`
remain deferred while concurrent changes exist.

## GameSession active-player selection needs an own protected accessor (Slice W, 2026-10-02)

An inherited getter can still be shadowed. The active-player selector must be
one private canonical value, exposed only through a construction-installed
non-enumerable, non-configurable own getter without setter. Every snapshot and
actor selection path then uses the private selector, while server reads retain
compatibility. The meaningful mutation reconnects snapshot fields as well as
removing the accessor: otherwise a descriptor-only test cannot prove export
semantics.

An unavailable HTTP path cannot be converted into dynamic coverage by removing
its existing admission gate. The KP default-target probe was removed because
the handler is deliberately preempted by `ordinary_mutation_not_durable` 409.
Coherent active cohort atomicity across every restore and temporary switch,
public world/canonical discovery, other aliases, reflection/prototype risks,
cross-store transactions, and crash consistency remain open. Slice W changes
no checkpoint I/II/III boundary. Generated documents and
`docs/notes/index.json` remain deferred while concurrent changes exist; fresh
final preflight is still pending.

## Correction: Slice V public config recovery has final preflight evidence (2026-10-02)

The preceding Slice V pending-preflight wording is superseded only for this
evidence. Exact sandbox `bun scripts/preflight.ts` exited 1 with six
`uv_spawn cmd.exe` EPERM failures before internal typecheck, tests, probe, or
hooks checks started. It is an environment block, neither semantic failure nor
green evidence. Root reran the same command outside sandbox and it exited 0:
291 boolean-returning implementations with 0 discarded returns; generated,
handwritten, and structured document references 3 / 8 / 1; internal typecheck
0; 4462 tests / 382 files and `unwiredMethods` 47 exactly matching baseline;
and `.githooks` with the commit-message criterion running.

This is the one recorded successful Slice V preflight. It validates only that
slice, leaves todo-65 and the total production goal open, and does not claim a
second or later successful run. Generated documents and `docs/notes/index.json`
remain deferred while concurrent changes exist.

## GameSession PlayerSession exposure is observation, not a replaceable gate (Slice U, 2026-10-02)

Server admission may depend on `session.session.get(pcId)`, so even a read
facade must be stable rather than a publicly replaceable reference. A frozen
private-backed facade published through an enumerable, non-configurable own
getter preserves the server's read contract while making forged `get` methods
inert. The regression needs to drive the real server gate: known identity stays
200 while forged identity stays 404 under a replacement attempt.

This closes no other inherited getter or server observation. Configuration
credential recovery design, other public aliases, reflection/prototype risks,
cross-store transactions, and crash consistency remain open. Slice U changes
no checkpoint I/II/III boundary. Generated documents and `docs/notes/index.json`
remain deferred while concurrent changes exist, and fresh post-documentation
preflight is still pending.

## GameSession skill-growth marks are observation, not a mutable fixture seam (Slice X, 2026-10-02)

Compatibility facades must remain observation-only. A direct array alias lets a
fixture manufacture progress without an action: before repair, one public
`push('spot_hidden')` changed the persisted snapshot despite no skill check.
Canonical marks belong in a private map; every public observation must be a
fresh frozen detached copy, and the getter itself must resist setter or
define-property replacement.

Tests must not reverse this boundary by defining a public production mutation
just to build a fixture. A successful real action or a re-signed ordinary
snapshot establishes legitimate marks through existing authority paths, leaving
schema, validator, and settlement policy unchanged. This closes only public
skillGrowthMarks write/alias authority. Public world/canonical discovery,
other aliases, reflection/prototype risks, cross-store transactions, crash and
power-loss consistency, deployment, and external-model work remain open.
Checkpoint I/II/III boundaries are unchanged. Root probe-unwired independently
measured 47 no callers / 63 test-only / 42 should-private this round; fresh
final preflight remains pending. Generated documents and `docs/notes/index.json`
remain deferred while concurrent changes exist.

## Correction: Slice U PlayerSession read facade has final preflight evidence (2026-10-02)

The preceding Slice U pending-preflight wording is superseded only for this
evidence. The fresh post-documentation sandbox invocation exited 1 with six
`uv_spawn cmd.exe` EPERM failures before internal typecheck, tests, probe, or
git-config checks started. It is an environment block, neither semantic
failure nor green evidence. Root reran the same `bun scripts/preflight.ts`
outside sandbox and it exited 0: 291 boolean-returning implementations with 0
discarded returns; generated, handwritten, and structured document references
3 / 8 / 1; internal typecheck 0; 4460 tests / 381 files and
`unwiredMethods` 47 exactly matching baseline; and `.githooks` with the
commit-message criterion running.

This is the one recorded successful Slice U preflight. It validates only that
slice, leaves todo-65 open and total goal incomplete, and does not claim a
second or later successful run. Generated documents and `docs/notes/index.json`
remain deferred while concurrent changes exist.

## GameSession identity is namespace authority, not mutable metadata (Slice T, 2026-10-02)

Session ID determines snapshot acknowledgement, restore, SAN seeding, career
namespace, and server-visible projections. It therefore needs one private
canonical value and a compatible read-only own accessor. Assignment and every
Reflect/define-property route must reject, while every internal identity
consumer uses the private value. A useful regression proves not just the
getter descriptor but that ordinary snapshot, summary, and lazy on-disk career
directory remain canonical under a forged public attempt.

This does not change the broader ID grammar or namespace design, nor prove
server registry-wide namespace consistency. Other public authority,
reflection/prototype risks, OS-memory and crash behavior, and cross-store
transactions remain open. Assertion counts describe this run's evidence, not
a stable baseline. Slice T changes no checkpoint I/II/III boundary; generated
documents and `docs/notes/index.json` remain deferred while concurrent changes
exist, and fresh post-documentation preflight is still pending.

## LLMClient configuration is a private capability, not a caller alias (Slice S, 2026-10-02)

TypeScript `private` alone does not protect a runtime configuration reference.
LLMClient needs an ECMAScript-private, frozen exact copy and every chat and
stream path—defaults, breaker, admission, URL, and authorization—must consume
that same canonical copy. Constructor validation must reject hostile getters
and malformed critical strings without exposing credentials. A public
same-name shadow then has no authority over either chat or stream requests.

The regression must mutate every meaningful field across both request paths:
URL, Bearer token, model, max tokens, and temperature. This does not establish
OS-memory secrecy, and GameSession's public compatibility config still exposes
`apiKey`; provider policy is deliberately unchanged. GameSession.id authority,
other public aliases, reflection/prototype risks, transactions, crash
consistency, deployment, and external-model work remain open. Slice S changes
no checkpoint I/II/III boundary. Generated documents and `docs/notes/index.json`
remain deferred while concurrent changes exist; fresh post-documentation
preflight is still pending.

## Correction: Slice T GameSession ID authority has final preflight evidence (2026-10-02)

The preceding Slice T pending-preflight wording is superseded only for this
evidence. The fresh post-documentation sandbox invocation exited 1 with six
`uv_spawn cmd.exe` EPERM failures before internal typecheck, tests, probe, or
git-config checks started. It is an environment block, neither semantic
failure nor green evidence. Root reran the same `bun scripts/preflight.ts`
outside sandbox and it exited 0: 291 boolean-returning implementations with 0
discarded returns; generated, handwritten, and structured document references
3 / 8 / 1; internal typecheck 0; 4455 tests / 380 files and
`unwiredMethods` 47 exactly matching baseline; and `.githooks` with the
commit-message criterion running.

This is the one recorded successful Slice T preflight. It validates only that
slice, leaves todo-65 open and total goal incomplete, and does not claim a
second or later successful run. Generated documents and `docs/notes/index.json`
remain deferred while concurrent changes exist.

## Correction: Slice S LLMClient config capability has final preflight evidence (2026-10-02)

The preceding Slice S pending-preflight wording is superseded only for this
evidence. The fresh post-documentation sandbox invocation exited 1 with six
`uv_spawn cmd.exe` EPERM failures before internal typecheck, tests, probe, or
git-config checks started. It is an environment block, neither semantic
failure nor green evidence. Root reran the same `bun scripts/preflight.ts`
outside sandbox and it exited 0: 291 boolean-returning implementations with 0
discarded returns; generated, handwritten, and structured document references
3 / 8 / 1; internal typecheck 0; 4450 tests / 379 files and
`unwiredMethods` 47 exactly matching baseline; and `.githooks` with the
commit-message criterion running.

This is the one recorded successful Slice S preflight. It validates only that
slice, leaves todo-65 open and total goal incomplete, and does not claim a
second or later successful run. Generated documents and `docs/notes/index.json`
remain deferred while concurrent changes exist.

## GameSession configuration and LLM clients are references of authority (Slice R, 2026-10-02)

Configuration can change every consumer of a session-local LLM, so it needs a
private canonical copy rather than a public mutable input reference. A stable
own getter preserves compatibility observation, while private local-client
injection must be the only route into intent, narration, registry, and KP
work. Tests must mutate URL, model, and authentication candidates as well as
attempt raw-client exposure; one surface-only assertion cannot establish this
boundary.

Sandbox child-process failures need classification before they enter the
quality record. Here every lifecycle failure was the same
`PREPARE_ISOLATION_UNAVAILABLE` 503, while the unchanged suite passed outside
the sandbox: that is a process-permission boundary, neither a product semantic
failure nor a green result for the sandbox run.

This slice intentionally does not claim credential confidentiality: public
`config` still contains `apiKey` as a compatibility surface, and direct
standalone LLMClient caller aliases require a separate assessment. Other
public aliases, reflection/prototype risks, cross-store/crash behavior,
deployment, and external-model work remain open. Checkpoint I/II/III
boundaries are unchanged; generated documents and `docs/notes/index.json`
remain deferred while concurrent changes exist, and fresh post-documentation
preflight is still pending.

## Correction: Slice R LLM/config authority has final preflight evidence (2026-10-02)

The preceding Slice R pending-preflight wording is superseded only for this
evidence. The first fresh post-documentation sandbox invocation exited 1 with
six `uv_spawn cmd.exe` EPERM failures before typecheck, tests, probe, or
git-config checks started. It is an environment block, neither semantic
failure nor green evidence. Root reran the original `bun scripts/preflight.ts`
outside sandbox and it exited 0: 291 boolean-returning implementations with 0
discarded returns; generated, handwritten, and structured document references
3 / 8 / 1; internal typecheck 0; 4446 tests / 378 files and
`unwiredMethods` 47 exactly matching baseline; and `.githooks` with the
commit-message criterion running.

This is the one recorded successful Slice R preflight. It validates only that
slice, does not broaden its authority boundary, leaves todo-65 open and the
total goal incomplete, and does not claim a second or later successful run.
Generated documents and `docs/notes/index.json` remain deferred while
concurrent changes exist.

## GameSession career persistence is a capability, not a public store (Slice Q, 2026-10-02)

An injected-or-lazy persistence store is authority even when ordinary gameplay
only reads it. A GameSession must retain its canonical CareerFileStore
privately and publish a stable frozen null-prototype read facade whose
structured results are detached. Every snapshot, character-persistence,
departure-history, and compatibility path must go through the private raw or
private lazy initializer, otherwise an own-property shadow can redirect a real
write.

Host policy is a separate capability: `careerEntryPersistence` defaults to
durable and may be set only by trusted runtime dependencies. A transient host
policy can skip departure-entry writing, but it must not skip validated growth
settlement, mark clearing, or base/projection persistence. Invalid injected
policy fails closed, and request or module input cannot select it.

The correct persistence regression couples a facade shadow to a real lazy
`addPartyMember` write, rather than calling a read facade in isolation. This
does not settle CareerFileStore crash, power-loss, cross-file, or cross-store
consistency; nor does it close other public aliases, reflection/prototype
risks, broad transactions, deployment, or external-model work. Checkpoint
I/II/III boundaries are unchanged. Generated documents and
`docs/notes/index.json` remain deferred while concurrent changes exist, and a
fresh post-documentation preflight is still pending.

## Correction: Slice Q CareerFileStore authority has final preflight evidence (2026-10-02)

The preceding Slice Q pending-preflight wording is superseded only for this
evidence. The first fresh post-documentation sandbox invocation exited 1 with
six `uv_spawn cmd.exe` EPERM failures; typecheck, tests, probe, and git-config
checks did not start. That is an environment block, not a semantic failure and
not passing evidence. Root then reran the original `bun scripts/preflight.ts`
outside sandbox and it exited 0: 291 boolean-returning implementations with 0
discarded returns; generated, handwritten, and structured document references
3 / 8 / 1; internal typecheck 0; 4443 tests / 377 files and
`unwiredMethods` 47 exactly matching baseline; and `.githooks` with the
commit-message criterion running.

This is the one recorded successful Slice Q preflight. It validates only that
slice, does not broaden its authority boundary or close todo-65, and does not
claim a second or later successful preflight. Generated documents and
`docs/notes/index.json` remain deferred while concurrent changes exist.

## GameSession timestamps are persistent authority, not writable metadata (Slice P, 2026-10-02)

Session timestamps participate in persistence, action commit, summary, and
server expiry; they cannot be ordinary writable metadata. Their canonical
values must be private. Enumerable, non-configurable own read accessors retain
compatible observation for server consumers while disallowing assignment,
Reflect operations, and own-property redefinition as shadow routes.

Timestamp fixtures must preserve the actual authority path. A valid snapshot
is re-signed and restored through the real validator; an action test proves
only last-active time advances. Tests which need expiry use a relative
canonical window or a synchronous constructor-window clock adjustment that is
restored in `finally`, never a cross-await global clock patch or a production
test setter. This closes only timestamp replacement/shadow authority.
CareerFileStore, other public aliases, reflection/prototype risks, cross-store
transactions, and crash consistency remain open. Slice P changes no checkpoint
I/II/III boundary; generated documents and `docs/notes/index.json` remain
deferred while concurrent changes exist, and fresh post-documentation
preflight is still pending.

## Correction: Slice P timestamp authority has final preflight evidence (2026-10-02)

The preceding Slice P pending-preflight wording is superseded only for this
evidence. Root ran one fresh post-documentation `bun scripts/preflight.ts` and
it exited 0: 291 boolean-returning implementations with 0 discarded returns;
generated, handwritten, and structured document references 3 / 8 / 1;
internal typecheck 0; 4440 tests / 376 files and `unwiredMethods` 47 exactly
matching baseline; and `.githooks` with the commit-message criterion running.

This validates Slice P only. It neither broadens timestamp authority nor
closes todo-65, and does not claim a second or later Slice P preflight.
Generated documents and `docs/notes/index.json` remain intentionally deferred
while concurrent changes exist.

## GameSession legacy records require the same canonical boundary (Slice O, 2026-10-02)

A small legacy record is still persistent authority when export, pristine
restore gates, and restore trust it. `skillMarks` therefore has one private
canonical record and a detached frozen null-prototype public projection. The
projection must be refreshed only as part of canonical replacement. An own
property with a forged record can then obscure an external observation but
cannot poison exported state or prevent an authenticated restore.

The meaningful restore test is not a hand-built object: it re-signs a
non-empty valid ordinary snapshot, drives the real validator and restore path,
then checks that export preserves the record. This boundary leaves
`skillGrowthMarks`, its schema, and validation unchanged. It also leaves
CareerFileStore, other public mutable/alias authority, reflection/prototype
risks, cross-store transactions, and crash consistency open. Slice O does not
change checkpoint I/II/III boundaries; generated documents and
`docs/notes/index.json` remain deferred while concurrent changes exist, and a
fresh post-documentation preflight is still pending.

## Correction: Slice O legacy skillMarks authority has final preflight evidence (2026-10-02)

The preceding Slice O pending-preflight wording is superseded only for this
evidence. Root ran one fresh post-documentation `bun scripts/preflight.ts` and
it exited 0: 291 boolean-returning implementations with 0 discarded returns;
generated, handwritten, and structured document references 3 / 8 / 1;
internal typecheck 0; 4438 tests / 375 files and `unwiredMethods` 47 exactly
matching baseline; and `.githooks` with the commit-message criterion running.

This validates Slice O only. It neither broadens legacy skill-mark authority
nor closes todo-65, and does not claim a second or later Slice O preflight.
Generated documents and `docs/notes/index.json` remain intentionally deferred
while concurrent changes exist.

## GameSession world is a capability boundary; test timeouts are a policy (Slice N, 2026-10-02)

The world manager is database and lifecycle authority, so a public raw object
cannot be treated as a read view. A stable frozen null-prototype facade must
publish only an explicit allowlist, while all engine paths retain a private
canonical raw receiver. If a facade delegates a method, it should obtain the
canonical raw method at call time and apply it to the raw receiver: this keeps
the facade from becoming an alternate authority route while allowing narrowly
targeted, test-only prototype fault injection.

Fault injection should identify a real target without adding a production seam
or leaving marker state: capturing the synchronous export receiver, retaining
it in a WeakSet, and restoring in `finally` gives that isolation. Projection
and compensation tests should compare exact snapshots before and after rather
than forge an alias through the formerly public world field.

Timeout failures require their own evidence. Bun 1.3.14 ignored the attempted
`[test].timeout` configuration; a 5.1-second probe still failed at its default
5001ms, so that key was removed rather than documented as a fix. The shared
bunfig preload now sets a bounded 20-second default through `jest.setTimeout`,
with explicit shorter test timeouts still taking priority. Whole-suite timeout
drift that consistently passes isolated and combined batches is load evidence,
not evidence to relax business assertions. Slice N does not expand checkpoint
I/II/III boundaries or close todo-65; generated documents and
`docs/notes/index.json` remain deferred while concurrent changes exist, and a
fresh post-documentation preflight is still pending.

## Correction: Slice N world capability facade has final preflight evidence (2026-10-02)

The preceding Slice N pending-preflight wording is superseded only for this
evidence. Root ran one fresh post-documentation `bun scripts/preflight.ts` and
it exited 0: 291 boolean-returning implementations with 0 discarded returns;
generated, handwritten, and structured document references 3 / 8 / 1;
internal typecheck 0; 4436 tests / 374 files and `unwiredMethods` 47 exactly
matching baseline; and `.githooks` with the commit-message criterion running.

This validates Slice N only. It does not broaden the world-capability or test
timeout-policy boundary, does not close todo-65, and does not claim a second
or later Slice N preflight. Generated documents and `docs/notes/index.json`
remain intentionally deferred while concurrent changes exist.

## GameSession combat-active is executable boolean authority (Slice M, 2026-10-02)

A boolean runtime mode can be as authoritative as a larger state object:
combat-active controls suggestions, KP/state projections, counterattack gates,
and durable snapshots. Its canonical value must be private; a public getter is
only observation. Tests should exercise both directions of an own shadow: a
true shadow must not fabricate inactive combat, and a false shadow must not
suppress combat created by a real action.

Fixtures must establish combat through a real controlled action or a correctly
signed ordinary snapshot restored on the same pristine identity, not through a
public field injection. RNG-driven attack tests also must not manually settle a
counterattack after an automatic path already settled it: the CoC defense
repair used a signed active snapshot and exactly one private counter. This
closes only combat-active replacement/shadow authority. Public world, other
mutable state, prototype/private reflection, and cross-store or crash
consistency remain open; `docs/notes/index.json` stays deferred because of
concurrent changes.

## Correction: Slice M combat-active authority has fresh preflight evidence (2026-10-02)

The preceding Slice M fresh-preflight-pending wording is superseded only for
this evidence. Root ran one fresh outside-sandbox `bun scripts/preflight.ts`
and it exited 0: 291 boolean-returning implementations with 0 discarded
returns; the one increase from Slice L is the new `hasCombatSuggestion` test
helper, whose return is consumed. Generated, handwritten, and structured
document references were 3 / 8 / 1; internal typecheck exited 0; 4433 tests /
372 files and `unwiredMethods` 47 exactly matched baseline; and `.githooks`
with the commit-message criterion was running.

This validates Slice M only. It neither broadens combat-active authority nor
closes todo-65, and does not claim a second or later Slice M preflight.
`docs/notes/index.json` remains intentionally unrefreshed because concurrent
changes must not be overwritten.

## Observation facades must not retain world authority (Slice Z, 2026-10-02)

`GameSession.world` is now a stable frozen null-prototype observation-only
allowlist facade over private `#worldRaw`, installed as a non-enumerable,
non-configurable own getter. Public DB, snapshot restore, lifecycle, and world
writers are absent; GameSession internal authority routes use the private raw
world. Tests that formerly wrote through `session.world` now use real public
actions/setters or the existing signed ordinary-world fixture—never a
production backdoor or a weakened validator.

The meaningful regressions change real authority: restoring the
`recordClueDiscovery` wrapper permits forged canonical clue state, and removing
the own accessor removes the required descriptor. The first full suite failed
because two legacy tests still cast `session.world.upsertEntity`; migrating them
through the signed fixture repaired the suite without reopening the facade.

Ambient entropy is not uniqueness authority. A combat test restores
`Math.random` in `finally`, and TradeSystem resolves Date/random route-ID
collisions against its Map with a deterministic suffix. Tests that patch globals
must always restore them. Slice Z leaves todo-65, other public child/alias
authority, prototype/private-reflection risks, cross-store and crash behavior,
deployment, and external-model quality open; Checkpoint I/II/III boundaries
are unchanged. The repaired full suite is green, but fresh final preflight is
still pending; generated documents and `docs/notes/index.json` remain deferred.

## Correction: Slice Z world facade has final preflight evidence (2026-10-02)

The preceding Slice Z pending-preflight wording is superseded only for this
evidence. The exact sandbox `bun scripts/preflight.ts` exited 1 with six
`uv_spawn cmd.exe` EPERM failures before internal typecheck, tests, probe, or
hooks checks started: environment evidence, neither semantic failure nor green
evidence. Under approval, root reran the same exact command outside sandbox;
it exited 0 with 291 boolean-returning implementations / 0 discarded returns,
generated/handwritten/structured document references 3 / 8 / 1, internal
typecheck exit 0, 4467 tests / 383 files and `unwiredMethods` 47 exactly
matching baseline, and `.githooks` with the commit-msg criterion running.

This validates Slice Z only. todo-65 and the broad production goal remain
open; it does not claim external-model or real-quality verification. Generated
documents and `docs/notes/index.json` remain deferred.

## Durable ordinary party mutation must be a receipt-bearing operation (2026-10-03)

An ordinary HTTP mutator cannot become safe merely by being removed from the
`ordinary_mutation_not_durable` gate. `POST /api/sessions/:id/party` now uses
the same candidate -> compare-and-swap -> persist -> hydrate/install core as a
text action, but records a typed `party_member_create` operation rather than
pretending JSON is text input. Its request identity is in a separate operation
hash domain; success and an exact replay both return the original `201` receipt.
The route is exact, and authentication plus remaining ordinary-mutator gates
still run before any request body is read.

Wire compatibility and storage policy are separate contracts. Envelope and
receipt wire version 1.5 explicitly reads legacy 1.4, while the coordinator's
SQLite policy/file-layout schema remains 1.4: otherwise a wire-only upgrade
would reject an otherwise valid old persistent policy root. A genuine policy
quota difference still fails closed. Session liveness is durable state too: a
successful operation writes `max(Date.now(), predecessor + 1)` into the same
signed successor; failures and exact replays do not advance it, so cleanup and
replay see the same committed fact.

The original positive case was red at expected 201 / actual 409. Reinstating
the global party gate produced 5 failures and 2 passes; precise restoration
returned the party suite green. Tests also made the old extra-path 201, stale
success timestamp, and wire-version-coupled policy mismatch fail, then verified
the corrected behavior against a real old policy root and a still-rejected
quota mismatch. Final directed evidence was 148 pass / 0 fail / 1241 assertions
over 8 files; typecheck exited 0; the full suite exited 0 at 4732 tests / 408
files / 4696 pass / 36 skip / 29190 assertions. Final standard preflight
exited 1 with exactly six internal `C:\\Windows\\system32\\cmd.exe` `uv_spawn`
EPERM failures. Typecheck, `bun test`, the probe, and `git config hooksPath`
lookup did not start; the test wrapper has no parseable test result/count, and
`git ls-files` was unavailable. Static checks did complete: 295 boolean
implementations / 0 discarded returns and generated/handwritten/structured
document references 3 / 8 / 1. Independent root typecheck 0, full-suite
4732 / 408 / 4696 / 36 / 0, and probe 47 / 69 / 35 evidence remains valid but
does not substitute for a green standard-preflight wrapper.

## Durable ordinary Luck spending must bind the active actor and successor (2026-10-03)

`POST /api/sessions/:id/luck-spend` is a typed `luck_spend` operation, not an
exception to the ordinary durable transaction boundary. It uses the same
candidate -> ABA/lifecycle/admission -> archive/replay-directory -> CAS ->
hydrate/install core as text actions and party creation. Its exact, bounded
request accepts only `amount`, `actionId`, and `expectedGeneration`; the client
does not select a PC. The operation hash is generic while legacy text hashing
remains compatible.

A receipt is evidence about a particular actor and successor, not merely a
successful response. Current 1.5 projection records `activePlayerId` and party
member Luck (`number` or `null` for a ruleset without Luck). The receipt binds
the active PC, amount, before/after arithmetic, committed successor Luck,
summary, and generation. It therefore detects an otherwise well-formed archive
whose response no longer agrees with the signed successor. Exact replay returns
the original 200 receipt; restart cannot deduct twice; rejected, failed, and
replayed requests do not advance liveness, while a successful signed successor
does.

The old positive request was red at expected 200 / actual 409. Reinstating the
ordinary global 409 gate made all six new cases fail; removing the committed
snapshot active-Luck receipt binding left five passing and one failing. Exact
restoration was green. The resource limit is part of the public contract too:
a hostile 9 KiB player request now reaches the established 8 KiB player cap and
returns 413, rather than travelling through the former 1 MiB path to 400.

Root directed evidence was 132 pass / 0 fail / 1068 assertions over 8 files;
typecheck exited 0. The full suite exited 0 at 4738 tests / 409 files / 4702
pass / 36 skip / 29279 assertions / 352.56s. The probe was 47 no callers / 69
test-only / 35 should-private. The standard preflight did run and exited 1 with
exactly six internal `uv_spawn C:\\Windows\\system32\\cmd.exe` EPERM startup
problems: typecheck, `bun test` (so no parseable cases/count), probe-unwired,
and `git config hooksPath` lookup did not start. Static checks did complete at
295 boolean implementations / 0 discarded returns and document references
3 / 8 / 1; `git ls-files` was unavailable, so only referenced-script existence
was checked. The direct typecheck, directed, full-suite, and probe evidence
above remains valid but does not make the standard preflight green. This closes only the ordinary
`/luck-spend` durable operation; other ordinary mutators, cross-store and
crash/power-loss behavior, deployment, external-model quality, Checkpoint I,
todo-64, todo-65, and the production-quality goal remain open. Generated
documents and `docs/notes/index.json` remain deferred.

## Frontend Luck retries are typed, session-scoped durable operations (2026-10-03)

The browser helper must not turn a new structured operation into an ambiguous
variant of legacy text. The request union therefore keeps legacy text without a
discriminator and gives `luck_spend` its strict discriminator and payload. Both
share one pending key per session, but an endpoint-aware dispatcher prevents a
text helper from bypassing an already-pending Luck request. The pending record
is written before POST and only an exact successful match may clean it up.

An exact replay is still a successful durable response, not permission to keep
stale browser state. The helper reconciles the authoritative session and
history after replay success. This remains a client retry contract: `App.vue`
does not yet expose Luck and no browser UI consumes it, so it must not be
presented as player-facing Luck UI or broader ordinary-route coverage.

The old helper was red at 0 pass / 1 fail / exit 1; the smallest repair was
1 / 0 / 3. Restoring the real bypass in `sendOrdinaryAction` was red at
0 / 1 / exit 1, while exact restoration was 1 / 0 / 4. Independent directed
verification was 45 pass / 0 fail / 318 assertions over 6 files, and typecheck
exited 0. A sandbox full `bun test` exited 1 at 4746 tests / 410 files / 4649
pass / 36 skip / 61 fail / 29044 assertions, but every failure arose from
`Bun.spawn` `bun.exe` EPERM or derived 503. The requested outside-sandbox rerun
was policy-rejected and not bypassed. It is not full-suite green evidence and
does not replace the established 4738 / 409 / 4702 / 36 / 0 baseline.

## Public compiled projections are not class-internal authority (2026-10-03)

`getCompiledMechanicsState()` and `getCompiledAvailableActions()` may remain
public compatibility wrappers, but compiled load results, refusals, player
façade view, current opaque-choice mapping, and compiled suggestions must use
private canonical projection helpers. Otherwise same-name own or prototype
shadows can forge a response/view or deny a compiled operation without
changing the supported external API. Server external public projection
boundaries, the shared core, DSL, settling, generation, opaque choices, and
execution remain outside this slice.

The test uses a real `compiledModuleHttpFixture` artifact/projection, durable
bundle, and `createCompiledSessionAccessBinding`, not a hand-built mechanics
state. Twelve own/prototype fake and throw cases retain the public wrappers as
negative controls while comparing exact canonical load/refusal state, player
façade/current mapping, and suggestions. The old implementation and the real
mutation restoring only the five internal public dynamic calls were both red:
0 pass / 12 fail / 32 assertions / exit 1. Exact restoration was 12 / 0 / 44.
Adjacent individual verification passed: compiled-action-discovery 11 / 0 /
109, compiled-player-facade 5 / 0 / 222, compiler-game-session-integration 9
/ 0 / 59, and game-session-compiled-runtime-authority 32 / 0 / 155; typecheck
was 0. Root independently verified 69 tests / 5 files / 589 assertions / 0
fail / exit 0, plus typecheck 0.

The authoritative full `bun test` exited 0: 4716 tests / 406 files / 4680 pass
/ 36 skip / 0 fail / 29004 assertions / 452.04s. The probe was 47 no callers /
69 test-only / 35 should-private. This closes only class-internal compiled
projection dispatch. Server external public projection boundaries, other
public dispatch, cross-store, crash/power-loss, deployment, external-model
quality, Checkpoint I, todo-64, todo-65, and the broad production goal remain
open. Root then ran standard `bun scripts/preflight.ts`; it exited 1 with
exactly six internal `uv_spawn C:\\Windows\\system32\\cmd.exe` EPERM problems.
Typecheck, `bun test`, the probe, and `git config hooksPath` lookup did not
start, so the test wrapper produced neither a parseable failure nor a count.
Static checks did complete: 295 boolean implementations / 0 discarded returns
and generated/handwritten/structured document references 3 / 8 / 1. `git
ls-files` was unavailable, so only referenced-script existence—not tracked
status—was checked. Independent root typecheck, full `bun test`, and probe
green evidence remains valid but cannot substitute for a green
standard-preflight wrapper. The baseline remains 4716 / 406 / 4680 / 36 / 47;
todo-64, todo-65, Checkpoint I, and the broad production goal remain open.
Generated documents and `docs/notes/index.json` remain deferred.

## TypeScript private is not runtime authority (Slice AA, 2026-10-02)

TypeScript `private` own properties remain JavaScript own properties at runtime:
an alias can replace them and thereby forge a semantic ordinary owner/access
snapshot or durable identity. Canonical `ordinarySessionAccess` and
`ordinaryDurableIdentity` therefore use ECMAScript `#private` fields, not
runtime-writable TypeScript-private storage.

The proof starts from the 0 pass / 3 fail / 8 assertion forgery regression and
uses a real negative control that restores the old own fields; both are red.
Exact hardening is 3 pass / 0 fail / 32 assertions, with directed 138 / 8 / 0
/ 1049 evidence, typecheck 0, full Bun 4470 tests / 384 files / 4434 pass /
36 skip / 0 fail / 27378 assertions, and probe 47 / 63 / 42. This closes only
that own-property authority; todo-65, the production goal, and subsequent
Checkpoint I/II/III work remain open. Fresh final preflight is pending, and
generated documents plus `docs/notes/index.json` remain deferred.

## Standalone registry internals need runtime-private authority (Slice AB, 2026-10-02)

TypeScript-private registry fields are still runtime-own properties, so
reflection can clear or replace `agents` to bypass duplicate-name lifecycle,
forge semantic/replacement revisions, or redirect LLM and DB dependencies.
AgentRegistry now keeps its six canonical authority fields as ECMAScript
`#private`: `#agents`, `#liveSemanticRevision`, `#replacementRevision`, `#llm`,
`#hooks`, and `#db`.

The attacks belong in the existing snapshot regression: the old implementation
was 3 pass / 3 fail, the exact repair 3 / 0, and restoring
`liveSemanticRevision` as a runtime-own field made the expected `1n` revision
observe `99n` again. Public AgentRegistry methods still intentionally return
live `NPCAgent` instances; this is not an immutability claim for that API.
Directed evidence was 21 / 2 / 0 / 158, full Bun was 4473 tests / 384 files /
4437 pass / 36 skip / 0 fail / 27409 assertions, and probe was 47 / 63 / 42.
Fresh final preflight remains pending. todo-65, broad production hardening,
cross-component work, later checkpoints, generated documents, and
`docs/notes/index.json` remain open or deferred as before.

## Correction: Slice AB registry private fields have final preflight evidence (2026-10-02)

The preceding Slice AB pending-preflight wording is superseded only for this
evidence. An earlier sandbox `bun scripts/preflight.ts` exited 1 with six
`uv_spawn cmd.exe` EPERM failures: an environment limitation, neither a code
failure nor green evidence. On the final stable Slice AB worktree, the same
command ran outside the sandbox and exited 0 with 291 boolean-returning
implementations / 0 discarded returns, generated/handwritten/structured
document references 3 / 8 / 1, internal typecheck exit 0, 4473 tests / 384
files and `unwiredMethods` 47 exactly matching baseline, and `core.hooksPath`
set to `.githooks`.

This validates Slice AB only. todo-65 and the broader production goal remain
open; generated documents and `docs/notes/index.json` remain deferred.

## Irreversible lifecycle needs private ownership authority (Slice AC, 2026-10-02)

Ownership and close state determine whether an NPCStore is irreversibly closed,
so they cannot be runtime-own TypeScript-private fields. GameSession keeps
`#hasSessionOwnedNpcStore`, `#npcStoreClosed`, `#lifecycleRevision`, and
`#directActionFailStopped` as ECMAScript private authority. Tests must observe
the resulting lifecycle behavior rather than read those internal fields.

The old implementation failed all six new lifecycle behavior tests. Restoring
`hasSessionOwnedNpcStore` as a runtime-own field makes the two shared-store
cases red because their database is closed incorrectly; exact restoration is
green. `lifecycleRevision` alone does not bypass close because the decision
also requires the closed flag, so it is not represented as a fabricated
independent counterexample. Directed evidence was 45 / 5 / 0 / 215, full Bun
was 4479 tests / 385 files / 4443 pass / 36 skip / 0 fail / 27433 assertions,
and probe was 47 / 63 / 42. This closes only that lifecycle/owned-dependency
authority; todo-65, broad production hardening, later checkpoints, generated
documents, and `docs/notes/index.json` remain open or deferred. Fresh final
preflight is still pending.

## Correction: Slice AC lifecycle authority has final preflight evidence (2026-10-02)

The preceding Slice AC pending-preflight wording is superseded only for this
evidence. On the stable Slice AC worktree after the 4479 / 385 baseline,
`bun scripts/preflight.ts` ran outside the sandbox and exited 0 with 291
boolean-returning implementations / 0 discarded returns,
generated/handwritten/structured document references 3 / 8 / 1, internal
typecheck exit 0, 4479 tests / 385 files and `unwiredMethods` 47 exactly
matching baseline, and `core.hooksPath` set to `.githooks`.

This validates Slice AC only. todo-65 and the broader production goal remain
open; generated documents and `docs/notes/index.json` remain deferred.

## Transaction leases and ABA revisions need runtime-private authority (Slice AD, 2026-10-02)

The FIFO action-transaction tail and ordinary commit snapshot-export closure
are capabilities: a runtime-own replacement can jump a queued lease or export
during an active transaction. Facade mutation revision is likewise authority
because a medium-to-hard-to-medium change must not recreate a prior revision.
GameSession therefore keeps `#actionTransactionTail`,
`#ordinaryCommitSnapshotExport`, `#facadeMutationRevision`, and
`#sanityAssignmentRevision` as ECMAScript private fields; tests assert
behavior, not direct revision values.

The old six behavior tests were 0 pass / 6 fail; exact hardening was 6 / 0,
and restoring the first three fields as runtime-own repeated 0 / 6. There is
no independent reachable raw SAN ABA: `#sanityRaw`, `#sanityEngines`, and
`#party` are private, while public sanity is frozen state-only. Its revision is
private canonical source-fence state, not a fabricated standalone defect.
Directed evidence was 128 / 6 / 0 / 927; full Bun was 4485 tests / 386 files /
4449 pass / 36 skip / 0 fail / 27476 assertions / 413.72s; probe was 47 / 63 /
42. Slice AD leaves todo-65, broad production hardening, later checkpoints,
generated documents, and `docs/notes/index.json` open or deferred. Fresh final
preflight is still pending.

## Correction: Slice AD transaction authority has final preflight evidence (2026-10-02)

The preceding Slice AD pending-preflight wording is superseded only for this
evidence. On the stable Slice AD worktree after the 4485 / 386 baseline,
`bun scripts/preflight.ts` ran outside the sandbox and exited 0 with 291
boolean-returning implementations / 0 discarded returns,
generated/handwritten/structured document references 3 / 8 / 1, internal
typecheck exit 0, 4485 tests / 386 files and `unwiredMethods` 47 exactly
matching baseline, and `core.hooksPath` set to `.githooks`.

This validates Slice AD only. todo-65 and the broader production goal remain
open; generated documents and `docs/notes/index.json` remain deferred.

## Host-only intent dependencies must be construction-only and inherited (Slice AE, 2026-10-02)

An ordinary session's intent client and policy are host authority, not request,
module, or snapshot data. GameSession keeps `#intentLLM` and `#intentPolicy`
private; `NormalSessionIntentClient` is deliberately narrow, and
`sessionIntentClient` enters only through trusted construction. Staging and
durable recovery must preserve that same ordinary client into their replacement
successor, rather than allowing a post-construction replacement seam.

The old four authority cases let required no-client intent degrade and advance
round/history/state, and let attacker help replace canonical status. Hardening
was 4 / 4; restoring runtime-own reads repeated 4 / 4 failure. Ordinary intent
policy was 17 / 17 across generation 0, staged action, and generation 1/2
recovery with the same client. The initial 12-file combination was 152 / 1,
with one unexplained direct child-process 2.66ms failure, so it is retained as
failure evidence—not green. Subsequent attributable runs were direct 1 / 0,
full direct file 10 / 0, and the other 11 files 143 / 0. Full Bun was 4490
tests / 387 files / 4454 pass / 36 skip / 0 fail / 27496 assertions; probe was
47 / 63 / 42. Slice AE leaves todo-65, broader production hardening, later
checkpoints, generated documents, and `docs/notes/index.json` open or
deferred. Fresh final preflight is still pending.

## Correction: Slice AE preflight evidence has a verification boundary (2026-10-02)

The first stable-AE outside-sandbox `bun scripts/preflight.ts` exited 1. Its
internal typecheck was 0, unwiredMethods 47 and `core.hooksPath` `.githooks`
were exact, but tests were 4453 pass / 1 fail:
`CompiledSessionSnapshotStore cross-process CAS > classifies header,
directory-sync, and coordinator-close ambiguity without refusing a possible
commit`. It is failure evidence, not a green preflight. The case later passed
alone 1 / 0.

The default sandbox full compiled-session-snapshot-process file was 23 / 4,
but all four cases were 1 / 0 in isolation, indicating unreliable sandbox
multi-process behavior. Under approval outside sandbox with in-memory
concurrency drained, the complete file was 27 / 0 / 124 assertions / 20.70s.
No code changed afterward, but a requested second outside-sandbox preflight
was refused by the current approval policy and was not bypassed. Slice AE final
preflight remains pending and is not claimed passing; baseline remains the
independent full Bun exit 0 result of 4490 tests / 387 files. todo-65 remains
open, and generated documents plus `docs/notes/index.json` remain deferred.

## Host-only runtime authority must remain private through recovery (Slice AF, 2026-10-02)

GameSession's canonical `narrativeLLM`, `storyGenerator`,
`compiledCombatRandom`, `characterRandomUnit`, `worldModelNovel`, and
`careerEntryPersistence` seams are now ECMAScript `#private`, while trusted
constructor and default behavior remain intact. Behavior coverage spans
`generated-story-runtime-package`, `game-session-character-entropy`,
`compiled-encounter-projection-lifecycle`,
`game-session-career-store-authority`,
`game-session-world-model-read-facade`, and
`runtime-llm-context-isolation`.

Against the old runtime-own implementation, shadow attacks could forge
story/world behavior, skip career persistence, and replace narrative/card
behavior. Restoring story authority as runtime-own made the sentinel behavior
red; exact restoration was green. The first full run found one old white-box
assertion in the untracked `ordinary-session-durable-http.test.ts` that read
`storyGenerator`. It was migrated to the behavioral path: durable `/help`
rehydrate, then staged story generation. A recovery-factory negative control
that omitted the generator produced the default story rather than the
sentinel. The final isolated ordinary file was 35 / 35 and AF combined
directed evidence was 104 / 104.

Typecheck exited 0. The root final full Bun run exited 0: 4496 tests / 387
files / 4460 pass / 36 skip / 0 fail / 27506 expect calls / 274.46s. The probe
also exited 0: 47 no callers / 63 test-only / 42 should-private. Final
preflight is pending and is not claimed. Slice AF leaves todo-65, the broader
production goal, later Checkpoint I/II/III work, generated documents, and
`docs/notes/index.json` open or deferred.

## Runtime control latches are canonical session authority (Slice AG, 2026-10-02)

Ordinary terminal state, party-leave confirmation, and per-PC compound-move
replies control whether the session is live, whether a departure can occur, and
which actor can complete a staged command. They are canonical authority, not
publicly replaceable runtime-own TypeScript-private storage. GameSession now
keeps them in ECMAScript `#ordinaryTerminal`, `#pendingLeaveConfirm`, and
`#pendingCompoundMove` fields.

The serialized contract is unchanged: the snapshot wire still uses `terminal`,
`pendingLeaveConfirm`, and `pendingCompoundMoves`, and export, restore, and
pristine-session semantics remain intact. Compound-move re-ask coverage no
longer reads the latch directly; it proves the real observable prompt behavior.

The new untracked `game-session-runtime-control-latches-authority.test.ts`
contains six behavior cases. Assignment or `defineProperty` cannot fabricate a
live terminal or clear a real departure; public-name shadows cannot forge or
cancel leave confirmation; an attacker Map cannot replace per-PC pending
compound state or clear a legitimate compound reply. The old implementation
was red at 0 pass / 6 fail. A real negative control that temporarily routed
leave through the public-name latch was 3 pass / 3 fail; exact restoration was
green.

Agent exact 10-file evidence was 123 pass / 0 fail / 639 assertions. Root's
alternate 10-file directed run was 124 pass / 0 fail / 661 assertions, plus
`ordinary-career-projection-snapshot` at 3 pass / 0 fail / 19 assertions.
Root typecheck exited 0 and the exact legacy scan was 0. The root full Bun run
exited 0: 4502 tests / 388 files / 4466 pass / 36 skip / 0 fail / 27509
assertions / 310.13s. Probe exited 0: 47 no callers / 63 test-only / 42
should-private.

Final preflight is PENDING/UNKNOWN and is not claimed green. In the sandbox,
`bun scripts/preflight.ts` exited 1 with six `uv_spawn cmd.exe` EPERM failures.
The implementation agent's two escalated attempts returned no output or exit
metadata, so its initial preflight-success claim was explicitly corrected as
unsubstantiated. Slice AG leaves todo-65, the broader production goal,
module/static state, cross-store/crash/power-loss behavior, deployment,
external-model/real-quality work, and later Checkpoint I/II/III work open.
Generated documents and `docs/notes/index.json` remain deferred.

## Compiled runtime authority must survive shadows and durable restore (Slice AH, 2026-10-03)

`compiledModule`, `compiledWorldModelPromptReceipt`, `compiledGeneration`,
`compiledIdempotency`, `compiledFailStopped`, and `installingCompiledState`
are canonical compiled-session authority. They moved from runtime-own
TypeScript-private storage to ECMAScript `#private` fields. This preserves the
existing API, request, snapshot, schema, validator, and replacement seams.

The new `game-session-compiled-runtime-authority.test.ts` uses a real catalog
bundle, durable snapshots, and restore to prove six consequences: ordinary or
loaded module shadows are ignored; generation cannot be forged; a restored
idempotency record cannot be cleared or replaced; a stale object remains
fail-stopped after commit; an installing shadow cannot bypass the durable
mutation block; and a trusted prompt receipt cannot be forged or cleared. The
old implementation was red at 0 / 6. A public fail-stop read negative control
was 5 pass / 1 fail, and exact restoration was green.

White-box private-field corruption was removed from
`compiled-action-discovery`, `first-aid-bleeding-truth`,
`ordinary-terminal-reason`, and `ws-broadcast-per-player-visibility` tests.
They now use public behavior and real fixtures; discovery proves
listing/refusal immutability instead of mutating internal state. Evidence was
authority 6 / 0 / 26 assertions, migrated 53 / 0, snapshot plus world 14 / 0,
restart plus source 27 / 0, and access 6 / 0.

The initial 11-file combined sandbox run exited 1 with 121 pass / 5 fail. Three
lifecycle PDF tests returned 503 because isolation workers could not start
under sandbox/concurrent load; the compiled-action and source-NPC children
failed `uv_spawn` EPERM. This is failure evidence, not a green aggregate.
Each PDF case passed alone. Outside sandbox, the full lifecycle file was 27 / 0
/ 568 assertions, the child files were 25 / 0 / 200 assertions, and the root
non-child eight-file set was 74 / 0 / 586 assertions. Root typecheck and the
exact legacy scan both exited 0.

The authoritative full `bun test` outside sandbox exited 0: 4508 tests / 389
files / 4472 pass / 36 skip / 0 fail / 27556 assertions / 279.33s. The probe
was 47 no callers / 63 test-only / 42 should-private. Slice AH preflight has
not been run and remains pending. The previous Slice AG standard preflight was
exit 1 with six `uv_spawn cmd.exe` EPERM errors, while escalation output was
unavailable; neither is green preflight evidence.

This closes only compiled runtime-own authority. Ordinary module/static
authority, remaining runtime-own fields, cross-store/crash/power-loss,
deployment, external-model/real-quality work, and later checkpoints remain
open. todo-65 and the broader production goal remain open; generated documents
and `docs/notes/index.json` remain deferred.

## Module/static authority must survive public-name shadows (Slice AI, 2026-10-03)

`sceneDisplayNames`, `sceneAliases`, `sceneBgm`, `registeredModules`,
`moduleItemDescriptions`, `moduleKpNotes`, `moduleRewards`, and
`_loadedModules` are canonical module/static authority. They moved from
runtime-own TypeScript-private storage to ECMAScript `#private` fields. The
internal routes for snapshot export, restore and pristine handling, module
installation, compiled-projection rollback, navigation, narration/world-model,
departure, and settlement/rewards all use the private canonical values. The
ordinary snapshot wire keeps its existing field names and shapes.

The new `game-session-module-static-authority.test.ts` has six behavior cases
and 36 assertions. It proves that a fresh identity/departure/package cannot be
forged; clearing the real identity cannot disable actual departure or
settlement; scene/navigation/presentation/BGM/snapshot shadows cannot redirect
behavior; item/KP/reward shadows cannot change output; a pristine restore does
not acquire contaminated module state; and first/duplicate install shadows do
not change the canonical install. The old implementation was red at 5 / 6. An
initially weak install assertion was strengthened to require canonical scene
data.

The meaningful negative control routed `ordinarySnapshotModule` through public
`registeredModules` / `_loadedModules`; it reproduced the intended forged
package failure (one red failure). Exact restoration was green. Barn's
canonical entry is `特里坎家`, not `普瑞米尔`; world-model coverage therefore
installs through the public action and binds source data to that real scene,
without a test-only write seam.

Authority evidence was 6 / 0; world-model evidence 14 / 0; targeted evidence
129 / 0; and narrative evidence 9 / 0. The root-directed run was 160 tests in
12 files, 0 failures, and 735 assertions; typecheck and the exact legacy source
scan both exited 0, and the scoped diff check was clean. The authoritative full
outside-sandbox `bun test` exited 0: 4514 tests / 390 files / 4478 pass / 36
skip / 0 fail / 27624 assertions / 279.86s. The probe was 47 no callers / 63
test-only / 42 should-private.

Slice AI preflight has not run and remains pending; prior sandbox `uv_spawn`
EPERM results are not green preflight evidence. This closes only these
module/static runtime-own fields. todo-65 and the broader production goal
remain open, including other runtime-own fields/caches and trusted dependency
fields, cross-store/crash/power-loss consistency, deployment, external-model
and real-quality work, and later checkpoints. Generated documents and
`docs/notes/index.json` remain deferred.

## Turn/result authority must not be a runtime-own shadow (Slice AJ, 2026-10-03)

`lastNarrative`, `lastDiceRoll`, `lastRolls`, `gameTime`, `activeDifficulty`,
`lastPushedRoll`, `actingStatusesBeforeTick`, `turnMessages`, and
`sightedMythos` are canonical turn/result authority. They moved from
runtime-own TypeScript-private storage to ECMAScript `#private` fields, with
the wire and schema unchanged. Snapshot/result projection, clock,
difficulty-transition, push, status-tick, message, and mythos/SAN routes now
read the private canonical values.

`game-session-turn-result-private-authority.test.ts` adds seven behavior
attacks: snapshot narrative/dice/history, clock, difficulty transition source,
push eligibility, pre-tick status accessor, turn-message redirect/DoS, and
mythos SAN-sighting deduplication. The old implementation was 0 pass / 7 fail
/ 20 assertions. Restoring runtime-own `activeDifficulty` as a real negative
control made the focused test 0 pass / 1 fail: the transition reported forged
`from=medium`, rather than the canonical `hard`. Exact restoration was green.

Private-authority migration is not permission to delete coverage. Existing
white-box tests were moved to public responses, signed snapshots, and real
actions. In review, `direct-action-atomicity` had briefly lost its `gameTime`
assertion; it was restored and strengthened with a post-provider invalid-intent
clock boundary. This makes a clock-only regression observable through public
response/state. The stale-provider case locks public period before close, and
the closed case proves rejection through an adjacent public boundary without
illegally reading the released DB. This is the rule for closed resources:
assert an observable neighboring refusal, not an inaccessible private value.

The repaired legacy file was 11 / 0 / 59; new authority evidence was 7 / 0 /
28. Agent focused evidence was 113 / 0 / 606 across 13 files. Root directed
evidence was 107 / 0 / 427 across 12 files, plus 18 / 0 / 87 across two
strengthened files. Root typecheck and the exact legacy source scan exited 0.
The authoritative full outside-sandbox `bun test` exited 0: 4522 tests / 391
files / 4486 pass / 36 skip / 0 fail / 27648 assertions / 281.03s. The probe
was 47 no callers / 63 test-only / 42 should-private.

Slice AJ preflight has not run and remains pending; it is not green evidence.
This closes only the listed GameSession turn/result fields. todo-65 and the
broader production goal remain open, including career/growth/persona/careerRoot
and other runtime fields, standalone AgentRegistry TypeScript-private fields,
other authority boundaries, transactions, crash/power-loss behavior,
deployment, external-model/real-quality work, and later checkpoints. Generated
documents and `docs/notes/index.json` remain deferred.

## Career/growth and sanity-facade authority require public evidence (Slices AK/AL, 2026-10-03)

Slice AK makes `woundsTreatedByPC`, `moduleStartByPC`, `growthChangesByPC`,
`p1Persona`, and readonly `careerRoot` ECMAScript-private as
`#woundsTreatedByPC`, `#moduleStartByPC`, `#growthChangesByPC`, `#p1Persona`,
and readonly `#careerRoot`. Persona input is `structuredClone`d. The wire and
schema remain unchanged. The seven-case
`game-session-career-growth-private-authority.test.ts` was 0 / 7 red against
the old implementation; career-root and module-baseline public-shadow negative
controls were red, and exact restoration was green.

The migration principle is that private authority must gain public evidence,
not lose tests. `game-session.test`, `module-start-baseline`, and
`skill-settlement-module-authority` now use a real first-aid action, valid
signed snapshots, and a real published module rather than internal writes.
`game-session.test` additionally proves first aid through the public
`afterFirstAid` result. AK evidence was new 7 / 0 / 57, migrated 87 / 0 / 337,
and adjacent 79 / 0 / 401; root-directed evidence was 145 tests / 10 files /
0 fail / 678 assertions. Typecheck and the exact legacy-source scan both
exited 0.

Slice AL makes the readonly `sanityFacade` backing field readonly
ECMAScript-private `#sanityFacade`; its public surface remains getter-only.
The two-case `game-session-sanity-facade-private-authority.test.ts` was 0 / 2
red against the old implementation, and the public-shadow negative control was
also 0 / 2 red. Exact restoration was green. AL adjacent evidence was 51 / 0 /
473, and combined AL+AK root evidence was 58 tests / 6 files / 0 fail / 530
assertions. The exact scan for runtime-own TypeScript-private GameSession data
fields is now 0.

A one-off full-suite failure is evidence, never noise to erase. The first
outside-sandbox full run exited 1: 4531 tests / 393 files / 4494 pass / 36 skip
/ 1 fail / 27718 assertions / 282.45s. Its only failure was the
`compiled-player-facade` durable player grant/choice-key mutation case. It was
kept and reproduced before classification: the focused rerun was 1 / 0 / 6 and
rerun-each was 20 / 0 / 120. The second authoritative outside-sandbox full
`bun test` then exited 0: 4531 tests / 393 files / 4495 pass / 36 skip / 0 fail
/ 27721 assertions / 282.96s. The final baseline is green, while the earlier
non-reproducing failure remains part of the record. The probe was 47 no callers
/ 63 test-only / 42 should-private.

AK/AL preflight has not run and remains pending; it is not claimed green. These
slices do not close todo-65 or the broad production goal. Public observation
getter shadowing and prototype monkeypatching, other authority boundaries and
cross-store transactions, crash/power-loss behavior, deployment,
external-model/real-quality work, and later checkpoints remain open. Generated
documents and `docs/notes/index.json` remain deferred.

## Correction: AK/AL standard preflight is an environment boundary (2026-10-03)

On the current sandbox, the standard `bun scripts/preflight.ts` exited 1 with
six problems. Typecheck, `bun test`, `probe-unwired`, and the `git config`
hooksPath lookup each failed to spawn `cmd.exe` with EPERM. The test stage
therefore had no parseable product failure and no test count. This is not a
product-test failure, and it is also not passing preflight evidence.

The static parts that did run reported 291 boolean implementations and zero
discarded returns; document-reference coverage printed normally. The latest
code's external standard preflight remains pending. Independent direct evidence
is unchanged: typecheck exited 0; the second full `bun test` exited 0 with
4531 tests / 393 files / 4495 pass / 36 skip / 0 fail / 27721 assertions; the
probe exited 0 with 47 no callers / 63 test-only / 42 should-private; and the
direct hooksPath value is `.githooks`.

The earlier first full-suite one-failure result remains retained as
non-reproducing evidence; this sandbox spawn failure neither replaces it nor
reclassifies it. todo-65 and the broad production goal remain open. Generated
documents and `docs/notes/index.json` remain deferred.

## Private guards must not be re-opened by public predicates (2026-10-03)

The compiled-session mutation guard and `#isDurableCompiledSession` are now
ECMAScript private. The public observation consumed by server cleanup is a
non-enumerable, non-configurable, non-writable own accessor, so a same-name
public shadow cannot redirect cleanup. The old guard was 6 pass / 2 fail / 30
assertions; public-dependency evidence was 8 / 2 / 51; the writable-installer
mutation was 9 / 1 / 57; and exact authority was 10 / 0 / 66. Directed
verification was 85 tests / 7 files / 0 fail / 746 assertions, and the
stage-level full run exited 0: 4535 tests / 393 files / 4499 pass / 36 skip /
0 fail / 27731 assertions / 283.15s.

The four ordinary-terminal helper methods are likewise ECMAScript private. The
old implementation was 6 pass / 4 fail / 22 assertions, its negative control
was 8 / 2 / 43, and exact authority was 10 / 0 / 57. Root-directed evidence
was 124 tests / 6 files / 0 fail / 536 assertions; typecheck exited 0.

The correction is behavioral: private storage is incomplete if a decision still
depends on a public, shadowable predicate. Conversely, a rejected action in an
ordinary terminal session retains its existing canonical system blocking
message. Tests must not incorrectly demand byte-identical history or snapshot
hashes. They must prove the relevant non-mutation boundary instead: no player
action, round, `gameTime`, or terminal identity changes.

The final authoritative full `bun test` exited 0: 4539 tests / 393 files /
4503 pass / 36 skip / 0 fail / 27804 assertions / 280.77s. The probe exited 0:
47 no callers / 63 test-only / 42 should-private. todo-64, todo-65, and the
broad production goal remain open. Standard preflight remains pending for
external verification; earlier sandbox `cmd.exe` EPERM results are neither
product failures nor green preflight evidence. Generated documents and
`docs/notes/index.json` remain deferred.

## Pristine eligibility is an authority decision, not a TypeScript annotation (2026-10-03)

`#isPristineDurableCompiledSession`, `#isPristineCompiledRestoreTarget`, and
`#isPristineOrdinaryRestoreTarget`, together with their three internal gates,
are ECMAScript private. Complete-validation and pristine eligibility are
authority decisions. They must be made from private canonical state before the
validator runs and before any write occurs; TypeScript `private` does not form a
runtime security boundary.

The old authority regression was 11 pass / 6 fail / 81 assertions. Three true
public-name shadows really overrode load or restore, and three throwing shadows
caused denial of service. Routing durable load through a public shadow was the
real negative control at 15 / 2 / 86. Exact private authority was 17 / 0 / 89.
Root independently verified five related files at 68 tests / 5 files / 0 fail /
518 assertions; typecheck exited 0; the legacy public-call scan was 0 and
private references were 6.

The rule is therefore both semantic and availability-related: a public shadow
that returns true must not change pristine semantics, and one that throws must
not make a valid operation unavailable. The private canonical decision rejects
before validation and writes, rather than consulting a replaceable public
predicate.

The authoritative full `bun test` exited 0: 4546 tests / 393 files / 4510 pass
/ 36 skip / 0 fail / 27781 assertions / 283.49s. The probe exited 0: 47 no
callers / 63 test-only / 42 should-private. The latest sandbox standard
preflight exited 1 with six `cmd.exe` EPERM spawn errors; static output was 291
boolean implementations / 0 discarded returns. It is neither a product failure
nor green preflight evidence, and external standard preflight remains pending.
todo-64, todo-65, and the broad production goal remain open. Generated
documents and `docs/notes/index.json` remain deferred.

## Public party admission is not textual recruit-command authority (2026-10-03)

`addPartyMember()` may remain the supported public compatibility and HTTP
surface, but the textual recruit command must call a private
`#addPartyMemberCanonical` operation. Sharing a public method with HTTP does
not make dynamic public dispatch safe for class-internal authority. The HTTP
`/party` boundary, `createPartyMember` compensation, parser/schema, and
player-facing text remain outside this narrow slice.

Six own/prototype fake-success, fake-rejected, and throw tests exercise the
real `GameSession.act('创建队友 Luna investigator')` path. The public shadow is
the negative control; correctness is structural rather than narrative: p2 must
agree across ordinary snapshot characters/party, PlayerSession, world IDs and
player_state, with active p1 retained and p99/ForgedMember absent. The fixture
uses the real `archetypeId` sheet field, not `archetype`; product behavior was
not changed to satisfy a faulty test premise.

The old implementation and the mutation restoring only the textual
`this.addPartyMember` call were both red: 0 pass / 6 fail / 20 assertions /
exit 1. Exact restoration was 6 / 0 / 72. Adjacent individual verification
was 21 / 0 / 175, 10 / 0 / 44, 9 / 0 / 21, and 17 / 0 / 235; typecheck was 0.
Root independently verified 63 tests / 5 files / 547 assertions / 0 fail /
exit 0, plus typecheck 0. Static scanning found zero production
`this.<publicMethod>()` calls; `setScene`'s only match is a comment.

The authoritative full `bun test` exited 0: 4722 tests / 407 files / 4686 pass
/ 36 skip / 0 fail / 29118 assertions / 387.22s. The probe was 47 no callers /
69 test-only / 35 should-private. This closes only internal textual recruitment
dispatch. The HTTP `/party` public boundary, server other-public-API dispatch,
cross-store/Career crash-power-loss behavior, deployment, external-model
quality, Checkpoint I, todo-64, todo-65, and the broad production goal remain
open. Root then ran standard `bun scripts/preflight.ts`; it exited 1 with
exactly six internal `uv_spawn C:\\Windows\\system32\\cmd.exe` EPERM problems.
Typecheck, `bun test`, the probe, and `git config hooksPath` lookup did not
start, so the test wrapper produced neither a parseable failure nor a count.
Static checks did complete: 295 boolean implementations / 0 discarded returns
and generated/handwritten/structured document references 3 / 8 / 1. `git
ls-files` was unavailable, so only referenced-script existence—not tracked
status—was checked. Independent root typecheck, full `bun test`, and probe
green evidence remains valid but cannot substitute for a green
standard-preflight wrapper. The baseline remains 4722 / 407 / 4686 / 36 / 47;
todo-64, todo-65, Checkpoint I, and the broad production goal remain open.
Generated documents and `docs/notes/index.json` remain deferred.

## Direct actor switch is an atomic cohort, not five independent helpers (2026-10-03)

`activePlayerStateInconsistent`, `validateOrdinaryDirectActor`,
`commitOrdinaryDirectActor`, `installActiveCharacter`, and
`installSanityEngine` are now ECMAScript private. Their private-use counts are
4 / 3 / 2 / 9 / 13; all calls migrated, and legacy dispatch/definition scans
are zero. Public APIs, raw maps, PlayerSession, and the SAN facade are
unchanged. The existing untracked
`game-session-active-switch-consistency.test.ts` gained nine real two-player
action cases.

The cases exercise a deferred post-intent commit shadow; fake/throw validator;
no-op/throw character installer; no-op/throw SAN installer (`p1=1`, `p2=2`);
and reachable fake/throw inconsistent-response helper. They assert
response/state/history/active ID/session active/character/SAN/snapshot. The old
implementation was red at 14 pass / 9 fail / 256 assertions / exit 1: a `p2`
request could act as `p1`, rejection could be forged, throws could fail-stop,
character/SAN could split, and the inconsistent helper could fake or deny
service. A real negative control made post-await commit prefer an own public
helper: 22 pass / 1 fail / 369 assertions / exit 1 (expected `p2`, received
`p1`). Exact authority was 23 / 0 / 381 / exit 0.

Actor switch is a coherent commit across active ID, PlayerSession, character,
and SAN. The routing trio and installer pair must become unshadowable together;
hardening only part of the cohort still permits a successful response for the
wrong actor or a half-commit followed by fail-stop. Root's six-file run was
rerun after an uncounted first >30s no-exit attempt and exited 0: 104 pass / 0
fail / 923 assertions / 31.36s. Root typecheck and the scoped diff check
exited 0.

The authoritative full `bun test` exited 0: 4576 tests / 393 files / 4540 pass
/ 36 skip / 0 fail / 28027 assertions / 287.39s. The probe was 47 no callers /
63 test-only / 42 should-private. Standard preflight after documentation has
not run and is not claimed green; preceding sandbox attempts had six
`uv_spawn cmd.exe` EPERM errors with static 291 boolean implementations / zero
discarded returns. todo-64, todo-65, and the broad production goal remain open.
Generated documents and `docs/notes/index.json` remain deferred.

## Private data fields do not seal public helper dispatch (AgentRegistry, 2026-10-03)

The Slice AB assessment is corrected: its six AgentRegistry data fields were
already ECMAScript private. The remaining authority gap was TypeScript-private
helper dispatch through `createObservedAgent`, `bumpSemanticRevision`, and
`emit`. These are now ECMAScript `#private`; legacy internal public-helper
calls are zero and private helper calls are eleven.

The old 20-test implementation was 14 pass / 6 fail / 106 assertions. Own
shadows on revision, factory, and hook helpers each changed real behavior. A
real register public-revision-helper negative control was red at 19 / 1 / 125;
exact authority was 20 / 0 / 131. Root adjacent verification was 42 tests / 5
files / 0 fail / 259 assertions, and root typecheck exited 0. Hook exceptions
remain non-blocking; making the dispatcher private does not turn observer
failure into a registration failure.

The audit rule is to distinguish data-field authority from helper-dispatch
authority. `#private` data fields cannot protect revision, factory, or hook
semantics if the internal path still dispatches through a public-shadowable
helper.

The authoritative full `bun test` exited 0: 4552 tests / 393 files / 4516 pass
/ 36 skip / 0 fail / 27860 assertions / 284.08s. The probe was 47 no callers /
63 test-only / 42 should-private. todo-64, todo-65, and the broad production
goal remain open. External standard preflight for the current version remains
pending; generated documents and `docs/notes/index.json` remain deferred.

## Outer action transactions need private helper dispatch too (2026-10-03)

`#bumpFacadeMutationRevision`, `#failStopDirectAction`,
`#directActionLifecycleIsCurrent`, `#closedDirectActionError`, and
`#actUnlocked` are now ECMAScript private, and every production call was
migrated. Ordinary handlers, actor helpers, and SQLite stamp helpers were not
changed. The existing untracked
`game-session-action-transaction-private-authority.test.ts` gained ten tests.

The old implementation was red at 16 tests / 6 pass / 10 fail / 32 assertions
/ exit 1. The real negative control temporarily let a FIFO callback prefer the
public `actUnlocked` shadow: 16 tests / 15 pass / 1 fail / 43 assertions /
exit 1, with a forged `/help` narrative taking over. Exact restoration was 16
/ 0 / 48 / exit 0. Root's six-file verification was 116 pass / 0 fail / 717
assertions / 26.12s; typecheck exited 0; `legacy_dispatch_hits=0`,
`legacy_definition_hits=0`, and the scoped diff check exited 0.

The methodological boundary is broader than data fields. A canonical outer
action transaction executor, lifecycle check, fail-stop, first-causal-error
constructor, or revision bump remains vulnerable if it is dispatched through a
runtime-own TypeScript-private helper. Such helpers are authority and must be
unshadowable ECMAScript-private dispatch too.

The authoritative full `bun test` exited 0: 4562 tests / 393 files / 4526 pass
/ 36 skip / 0 fail / 27865 assertions / 285.38s. The probe was 47 no callers /
63 test-only / 42 should-private. todo-64, todo-65, and the broad production
goal remain open. Standard preflight has not been verified after this
documentation update and is not claimed green. Generated documents and
`docs/notes/index.json` remain deferred.

## Source-fence stamps are authority even behind a raw-DB facade boundary (2026-10-03)

`worldSqliteMutationStamp` and `npcStoreSqliteMutationStamp` are now
ECMAScript private, with all four capture/compare routes migrated to `this.#`.
DB behavior, snapshots, ownership, and facades are unchanged. The existing
untracked `game-session-action-transaction-private-authority.test.ts` gained
five tests: real same-connection world raw-SQL ABA; default session-owned
private NPCStore portable save/restore ABA; two throwing own shadows; and exact
current no-op behavior.

The old implementation was red at 17 pass / 4 fail / 55 assertions / exit 1.
The real negative control made the final world compare prefer a public-name
shadow: 19 pass / 2 fail / 57 assertions / exit 1, falsely classifying real
world ABA as current. Exact authority was 21 / 0 / 57 / exit 0. The NPC check
uses prototype capture only during synchronous portable export and restores it
exactly in `finally`. Caller-owned stores are correctly rejected by portable
snapshot; that rejection is not evidence that the default session-owned private
store's stamp is protected.

The rule is that an inaccessible raw DB does not eliminate source-fence
authority. A runtime-own TypeScript-private stamp helper can still make a real
same-connection ABA look current, or throw during capture and deny service; it
must be ECMAScript-private. Root's six-file run was 123 pass / 0 fail / 759
assertions / 26.21s; typecheck exited 0; legacy dispatch and definition scans
were zero, private hits were six, and the scoped diff check exited 0.

The authoritative full `bun test` exited 0: 4567 tests / 393 files / 4531 pass
/ 36 skip / 0 fail / 27868 assertions / 285.37s. The probe was 47 no callers /
63 test-only / 42 should-private. The previous post-documentation sandbox
standard-preflight attempt exited 1 only through six `uv_spawn cmd.exe` EPERM
errors; static output was 291 boolean implementations / 0 discarded returns,
and document-reference checks ran. It is neither product failure nor green
preflight. Standard preflight after this documentation update remains pending.
todo-64, todo-65, and the broad production goal remain open. Generated
documents and `docs/notes/index.json` remain deferred.

## Public observations may remain public; transactions must use private projections (2026-10-03)

`buildActionResponse`, `persistSanity`, and `intentPolicyFailure` are now
ECMAScript private. Public `getState` and `getSanity` remain observation APIs,
but internal transactions build their response and commit through
`#stateProjection` / `#sanityProjection` and private terminal/dead state.
Fourteen tests were added.

The old implementation was red at 21 pass / 14 fail / 64 assertions / exit 1.
The real negative control temporarily routed `#buildActionResponse` through
public `getState`: 33 pass / 2 fail / 140 assertions / exit 1. Root's
independent nine-file verification was 140 pass / 0 fail / 847 assertions, and
typecheck exited 0.

The method boundary is not "make helpers private" in isolation. A public
observer can remain a public observer, but any internal transaction response or
commit must be constructed from private canonical projections; otherwise an own
shadow on that observer still controls the transaction's output or commit.

The authoritative full `bun test` exited 0: 4590 tests / 393 files / 4554 pass
/ 36 skip / 0 fail / 28145 assertions / 287.61s. The probe was 47 no callers /
63 test-only / 42 should-private. Ordinary snapshots still use public `dead`,
and `compiledFailure` / prepared compiled responses still use public
`getState`; those are later authority boundaries. todo-64, todo-65, and the
broad production goal remain open. Standard preflight is not claimed green.
Generated documents and `docs/notes/index.json` remain deferred.

## Durable compiled responses must project privately before publication (2026-10-03)

`compiledFailure` and `preparedCompiledActionResponse` now construct their
internal state through `#stateProjection`, not public `getState`. The public
API, temporary `p1` installation/restoration, and cloning remain unchanged.
Four tests were added.

The old implementation was red at 17 pass / 4 fail / 97 assertions / exit 1.
Negative control A restored prepared response through public `getState`: 19
pass / 2 fail / 101 assertions / exit 1. Negative control B restored
`compiledFailure` through public `getState`: 19 pass / 2 fail / 103 assertions
/ exit 1. Root's independent three-file verification was 69 pass / 0 fail /
419 assertions, and typecheck exited 0.

The required ordering is before publication, not "validate on restore." A
durable response must be built from private canonical projection before a
successor is published. A structurally valid forged value can otherwise pass
the initial shape boundary, publish the successor, and only later fail semantic
restore—creating durable denial of service.

The authoritative full `bun test` exited 0: 4594 tests / 393 files / 4558 pass
/ 36 skip / 0 fail / 28114 assertions / 289.31s. The probe was 47 no callers /
63 test-only / 42 should-private. `preparedCompiledSummary` public `getSummary`
and ordinary snapshot public `dead` are later authority boundaries. todo-64,
todo-65, and the broad production goal remain open. Standard preflight after
this slice has not run and is not claimed green. Generated documents and
`docs/notes/index.json` remain deferred.

## Persisted compiled summary must be private before successor publication (2026-10-03)

The existing body of `getSummary` is now `#summaryProjection`; public
`getSummary` remains a wrapper, while `preparedCompiledSummary` uses the
private projection. Two tests were added.

The old implementation was red at 21 pass / 2 fail / 111 assertions / exit 1.
The only real negative control restored `preparedCompiledSummary` through
public `getSummary`, producing the same 21 pass / 2 fail / 111 assertions /
exit 1. The initial subagent four-file aggregate had 79 pass / 1 transient
fail. That evidence is retained: `--only-failures` was green, then root
independently reran the complete four files at 80 pass / 0 fail / 487
assertions / exit 0. Typecheck exited 0.

Persisted summary is action state for publication purposes. It must be built
from private canonical projection before the successor is published; a semantic
check that only arrives at restore can fail closed, but cannot prevent a
structurally valid forgery from publishing a durable denial of service.

The authoritative full `bun test` exited 0: 4596 tests / 393 files / 4560 pass
/ 36 skip / 0 fail / 28159 assertions / 289.81s. The probe was 47 no callers /
63 test-only / 42 should-private. The next boundary is public `dead` through
four internal dispatches. todo-64, todo-65, and the broad production goal
remain open. Standard preflight after this slice has not run and is not claimed
green. Generated documents and `docs/notes/index.json` remain deferred.

## Public `dead` may observe terminality, but internal decisions must not dispatch through it (2026-10-03)

Ordinary snapshot-export `state.dead` and the three pristine predicates now
read private `#ordinaryTerminal` death truth, rather than public `this.dead`.
The public getter and terminal semantics are unchanged. Nine tests were added.

The old implementation was red at 24 pass / 8 fail / 141 assertions / exit 1.
The real negative control restored `this.dead` at all four internal dispatches
and was equally red. Final agent-directed evidence was 118 / 0 / 574; root
independently ran the four files at 118 pass / 0 fail / 574 assertions / exit
0, and typecheck exited 0. A real non-pristine `/help` target with own
`dead:false` still rejects ordinary restore, durable compiled load, and compiled
restore with state unchanged.

Validation is necessary but not sufficient: it can reject durable forgery, but
cannot replace internal canonical dispatch. An observation shadow must not gain
authority to deny a legitimate export, load, or restore.

The authoritative full `bun test` exited 0: 4605 tests / 393 files / 4569 pass
/ 36 skip / 0 fail / 28203 assertions / 292.83s. The probe was 47 no callers /
63 test-only / 42 should-private. The shared tree's six AgentRegistry slots
are already `#private` and are not repeated here. Public/prototype
monkeypatching is a distinct, unimplemented threat boundary. todo-64, todo-65,
and the broad production goal remain open. Standard preflight remains pending
for root and is not claimed green. Generated documents and `docs/notes/index.json`
remain deferred.

## Zero-HP admission is a private dispatch boundary, not terminality (2026-10-03)

`zeroHpActionBlockMessage` is now ECMAScript private, and both its before-turn
and post-tick action-admission callers dispatch privately. The message itself
is unchanged. Three tests were added.

The old direct regression was red at 3 pass / 3 fail / 30 assertions / exit 1;
the old durable-staging regression was red at 0 pass / 1 fail / 8 assertions /
exit 1. Restoring only the before-turn public helper was red at 4 pass / 2 fail
/ 39 assertions / exit 1; restoring only the post-tick helper was red at 5
pass / 1 fail / 50 assertions / exit 1. Root independently verified five files
at 87 pass / 0 fail / 462 assertions / exit 0, and typecheck exited 0.

The HTTP boundary corrects the invariant: a zero-HP block persists as a
generation-1/200 receipt. The required outcome is round=0, HP=0, and no action
event—not no successor. Character-admission helper dispatch must be private,
especially because prototype poison can cross a staging candidate. HP=0 is not
terminal state or party death.

The authoritative full `bun test` exited 0: 4608 tests / 393 files / 4572 pass
/ 36 skip / 0 fail / 28232 assertions / 293.86s. The probe was 47 no callers /
63 test-only / 42 should-private. Player/displayed-scene private projections
are the next candidate boundary. todo-64, todo-65, and the broad production
goal remain open. Standard preflight remains pending for root and is not
claimed green. Generated documents and `docs/notes/index.json` remain deferred.

## Early-game hint facts must be private canonical world reads (2026-10-03)

`isEarlyGame` remains a public wrapper, while `#earlyGameProjection` supplies
internal failure-clue hints. It reads facts directly from
`#worldRaw.isSceneVisitedByAnyone` and `#worldRaw.isClueDiscoveredByAnyone`;
no public `isSceneVisited` or `isClueFound` capability was added. The premise
is corrected: `clue_drugs` is not core, so its failed-check count does not
increment.

The old implementation and the real mutation that restored only internal
public dispatch were both red at 15 pass / 10 fail / 111 assertions / exit 1.
Final agent evidence was early file 25 / 0 / 151, six files 84 / 0 / 369, and
ordinary durable HTTP 37 / 0 / 227; typecheck exited 0. Root independently
verified seven files at 121 pass / 0 fail / 596 assertions / exit 0; root
typecheck exited 0.

Internal hint behavior must derive from private canonical world facts, not a
shadowable public observer. The authoritative full `bun test` exited 0: 4650
tests / 396 files / 4614 pass / 36 skip / 0 fail / 28561 assertions / 294.50s.
The probe was 47 no callers / 67 test-only / 38 should-private. Ordinary
departure ending predicates were the next high-risk boundary. todo-64, todo-65,
and the broad production goal remain open; Checkpoint I is not complete.
Standard preflight has not rerun after this slice and is not claimed green.
Generated documents and `docs/notes/index.json` remain deferred.

## Departure endings must use private rule facts across every output (2026-10-03)

`isClueFound` and `isSceneVisited` remain public observation wrappers, but
`#clueFoundPredicate` and `#sceneVisitedPredicate` read the canonical facts
directly from `#worldRaw`. `resolveModuleDeparture` ending callbacks dispatch
only to those private predicates. No DSL, compiled behavior, or no-support
`left_early` policy changed.

Five new tests use a legal signed ordinary snapshot, confirmed departure, and
prototype poison with exact `finally` restoration. They check the terminal
response and portable snapshot, ending narration in history, and CareerEntry
`endingId`/name/narrative together. The old implementation and the mutation
that restored only departure callbacks to public dispatch were both red at 0
pass / 5 fail / 23 assertions / exit 1. Final authority evidence was 5 / 0 /
53; root independently verified eight files at 63 pass / 0 fail / 356
assertions / exit 0, with typecheck 0.

Rule-execution facts cannot travel through a shadowable public observer, and
terminal response, portable snapshot, narration, and career entry must share
the same canonical source. The authoritative full `bun test` exited 0: 4655
tests / 397 files / 4619 pass / 36 skip / 0 fail / 28597 assertions / 295.31s;
the probe was 47 no callers / 67 test-only / 38 should-private. The preceding
early-slice standard preflight exited 1 only because six `cmd.exe` `uv_spawn`
EPERM failures occurred; static checks were 292 boolean implementations / 0
discarded returns. It is neither product-failure nor green evidence, and
post-slice standard preflight remains for root to run. todo-64, todo-65,
Checkpoint I, and the broad production goal stay open. The next boundary is
awaiting audit; generated documents and `docs/notes/index.json` remain deferred.

## Active wrappers must not dispatch through public sibling mutators (2026-10-03)

`updateActiveCharacter` and public `updateCharacter` now share
`#updateCharacterCanonical`; `spendActiveCharacterLuck` and public
`spendCharacterLuck` likewise share `#spendCharacterLuckCanonical`. This keeps
the active wrappers from reaching canonical mutation through a shadowable
public sibling. Validation, compiled refusal, revision, and world-HP semantics
are unchanged. Server ordinary/compiled character and luck mutator guards still
preflight 409, so this is direct-API dispatch hardening, not an HTTP capability
or vulnerability claim.

Eight own/prototype fake-or-throw tests check return values, detached character,
world HP, snapshot, and source-fence consistency. The old implementation and
the mutation restoring only the two active-wrapper public dispatches were both
red at 0 pass / 8 fail / 12 assertions / exit 1. Final authority evidence was
8 / 0 / 44; root independently verified seven files at 118 pass / 0 fail / 669
assertions / exit 0, with typecheck 0.

An initial full-suite attempt through nested PowerShell reported 60 failures /
4567 pass / 36 skip, concentrated in fresh-process/server-main/namespace/
world-loader tests; its outer `$LASTEXITCODE` had expanded before execution and
misreported exit 0. That environment/command-wrapper false result is retained,
not treated as code evidence. A direct representative three-file run was 24 /
0 / 187, and the authoritative direct `bun test` exited 0: 4663 tests / 398
files / 4627 pass / 36 skip / 0 fail / 28634 assertions / 296.19s. The probe
was 47 no callers / 69 test-only / 36 should-private. The preceding standard
preflight still had six `cmd.exe` `uv_spawn` EPERM failures; post-slice
preflight remains for root and is not claimed green. todo-64, todo-65,
Checkpoint I, and the broad production goal remain open; the next boundary is
awaiting audit. Generated documents and `docs/notes/index.json` remain deferred.

## Fixed-capacity expiry cleanup is session-admission authority (2026-10-03)

`ScriptedSessionRegistry.create()` now invokes ECMAScript-private
`#cleanupExpired`; the shadowable public method was removed because there are
no legitimate external consumers. Strict TTL `>`, non-LRU live behavior,
`getAuthorized` refresh/access, capacity, start-failure cleanup, ID retry, and
binding copy remain unchanged.

Two controlled-now, `maxActive = 1`, short-TTL tests prove that own no-op and
throwing same-name shadows cannot prevent replacement of an expired session;
direct shadow is the negative control. The old implementation was red at 0
pass / 2 fail / 8 assertions / exit 1. Restoring a public wrapper with dynamic
dispatch was red at 0 / 2 / 7 / exit 1. Final authority evidence was 2 / 0 /
16; root independently verified two files at 7 pass / 0 fail / 86 assertions /
exit 0, with typecheck 0.

Fixed-capacity expiry reclamation is admission authority, so internal cleanup
cannot route through a shadowable hook. The authoritative full `bun test`
exited 0: 4665 tests / 399 files / 4629 pass / 36 skip / 0 fail / 28693
assertions / 295.48s. The probe was 47 no callers / 69 test-only / 35
should-private. The preceding standard preflight still had six `cmd.exe`
`uv_spawn` EPERM failures; post-slice preflight remains for root and is not
claimed green. todo-64, todo-65, Checkpoint I, and the broad production goal
remain open; the next boundary is awaiting audit. Generated documents and
`docs/notes/index.json` remain deferred.

## Durable compiled growth must replay receipts, not frame exceptions (2026-10-03)

Current game-session snapshot/components schema 3.2.0 pairs with persisted
response 1.4.0; receipt-free 3.1.0/2.9.0 and response 1.3.0 are explicitly
supported, while a schema/response mismatch rejects. Every current 1.4 action
has a strict `skillGrowthReceipt`. Pending growth is derived by folding those
receipts generation-by-generation over a complete, continuous `characterBefore`
chain—not through arbitrary same-non-skill deltas in a raw action frame.

Ordinary and compiled flows share the pure CoC growth core. Compiled uses
action-bound hash entropy. Successful skill discovery, receipt-proven fighting
hit, and successful counter-dodge can mark growth; failure, none, failback, and
attributes cannot. Only a real `terminalEnding` settles; `terminalLoss` does
not. The action order is combat, actor SAN, growth, then terminal reward, so a
successful action that reaches terminal folds first and settles second.

The initial old durable test was red at exit 1 / 0 pass / 1 fail / 4 assertions
because the receipt was undefined; discarding its successful mark was red at
0 / 1 / 6. A legal 100% skill no-growth receipt then revealed an invalid 99
ceiling, producing `compiled_persistence_failed`: current and new 100 are now
valid, but increase at 100 remains forbidden. Same-action terminal replay also
must preserve the pre-mutation `checkedCharacter`; recomputing an original
check target from the growth-mutated sheet rejects a legal snapshot. Schema
mismatch, rehashed tamper, world-zero-write, restart, retry, history, and
message consistency are all covered. A second actual same-skill method was not
available after successful use in the fixture and was not fabricated; ordinary
dedupe coverage remains.

Root focused evidence was 5 / 0 / 66, six files 64 / 0 / 561, and adjacent ten
files 98 / 0 / 1157; typecheck exited 0. The authoritative full `bun test`
exited 0: 4670 tests / 400 files / 4634 pass / 36 skip / 0 fail / 28768
assertions / 330.01s. The probe was 47 no callers / 69 test-only / 35
should-private, and hooksPath is `.githooks`. Standard preflight has not run
after this slice and is not claimed green. This closes only compiled
skill-growth durable replay; todo-64, todo-65, and the broad production goal
remain open for real complex-PDF/external-model quality, broader content/combat,
identity, deployment, and other production boundaries. Generated documents and
`docs/notes/index.json` remain deferred.

## `/diff` must privately dispatch canonical mutation and consume its Result (2026-10-03)

Public `setDifficulty` remains a wrapper; its full logic is now
`#setDifficultyCanonical`. Slash dispatches privately and consumes its Result:
changes write `难度设为…`, while empty changes write `难度已经是…`. Slash still
consumes round, time, and generation. One new file plus ordinary durable
coverage adds 12 tests.

The old direct evidence was red at 3 pass / 8 fail / 37 assertions / exit 1;
old durable evidence was red at 0 / 1 / 5 / exit 1. Restoring only slash public
dispatch was red at direct 4 / 7 / 44 / exit 1 and durable 0 / 1 / 5 / exit 1.
Root's isolated eight-file verification was 135 pass / 0 fail / 811 assertions
/ exit 0; restart alone was 4 / 0 / 11, and typecheck exited 0. A subagent
nine-file aggregate had 135 pass / 4 restart-child interference failures. It
is retained; an immediate standalone rerun was green.

Command mutation must privately dispatch and consume Result so receipt, history,
and snapshot agree. HTTP staged candidates do not inherit source own shadows,
but a prototype shadow can cross. KP HTTP set-difficulty is unreachable because
both compiled and ordinary branches preflight 409; this does not authorize a
new capability, only later guard coverage.

The authoritative full `bun test` exited 0: 4634 tests / 396 files / 4598 pass
/ 36 skip / 0 fail / 28424 assertions / 295.80s. The probe was 47 no callers /
66 test-only / 39 should-private. todo-64, todo-65, and the broad production
goal remain open. Standard preflight remains pending for root and is not
claimed green. Generated documents and `docs/notes/index.json` remain deferred.

## Gate mutation delta must read private state before response audit (2026-10-03)

The existing body of `getGateState` is now `#gateStateProjection`; public
`getGateState` remains a wrapper, and `setDifficulty` reads only private gate
state. A new file adds seven tests. Ordinary KP set-difficulty HTTP rejects
before session creation with `409 ordinary_mutation_not_durable`, so no 200
fixture exists.

The old implementation was red at 1 pass / 6 fail / 12 assertions / exit 1.
The real negative control restored only `setDifficulty` to public dispatch and
was equally red. Root independently verified eight files at 125 pass / 0 fail
/ 516 assertions / exit 0, and typecheck exited 0.

The first full suite exited 1: 4622 tests / 395 files / 4585 pass / 36 skip /
1 fail / 28300 assertions. Its only failure was compiled-runtime-authority
throwing-own-dead-projection clean restore. This is retained as transient
evidence: the case passed alone 1 / 1 and with gate authority 39 / 39. The
second authoritative full run exited 0: 4622 tests / 395 files / 4586 pass /
36 skip / 0 fail / 28348 assertions / 292.18s.

Mutation delta must come from private canonical gate state. Late durable state
must not diverge from the response audit. The authoritative probe was 47 no
callers / 66 test-only / 39 should-private; one wrapper moved from
should-private to test-only. Public `setDifficulty` dispatch is the next
boundary. todo-64, todo-65, and the broad production goal remain open.
Standard preflight remains pending for root and is not claimed green. Generated
documents and `docs/notes/index.json` remain deferred.

## Player position and KP displayed scene are distinct private projections (2026-10-03)

`#playerPositionProjection` retains the position → scene → tavern fallback;
`#displayedSceneProjection` reads only the active scene. Public wrappers stay
available. Every internal call, including the `sceneFabricable` default, moved
to private projection while preserving the difference between physical player
position and the KP-displayed scene. A new file adds four tests.

The old implementation was red at 0 pass / 4 fail / 17 assertions / exit 1.
The displayed-scene negative control restored public dispatch only in
`getSuggestions`: 2 pass / 2 fail / 40 assertions / exit 1. The position-entry
negative control was 3 pass / 1 fail / 39 assertions / exit 1. Root
independently verified 14 files at 114 pass / 0 fail / 598 assertions / exit
0, and typecheck exited 0.

The authority rule is not merely that observers cannot write. Physical player
position and KP displayed scene need separate private projections. An observer
shadow must not produce divergent truths for remote NPCs, clues, suggestions,
movement, combat, response, or snapshot.

The authoritative full `bun test` exited 0: 4612 tests / 394 files / 4576 pass
/ 36 skip / 0 fail / 28268 assertions / 292.02s. The probe was 47 no callers /
65 test-only / 40 should-private: two wrappers moved from should-private to
test-only, while no-callers remains 47. `sceneFabricableCharacterNouns` own
dispatch is the next boundary. todo-64, todo-65, and the broad production goal
remain open. Standard preflight remains pending for root and is not claimed
green. Generated documents and `docs/notes/index.json` remain deferred.

## Dialogue noun-list integrity is narrow authority, not rules authority (2026-10-03)

The prior premise is corrected: `sceneFabricableCharacterNouns` was public, not
TypeScript private. It is now ECMAScript private, and its sole `handleTalk`
caller dispatches privately. This protects only NPC dialogue-repair noun-list
prompt/output integrity; entity, registry, world, target, and rules authority
are unchanged. Three tests were added.

The old implementation was red at 1 pass / 3 fail / 14 assertions / exit 1.
The real negative control restored public forwarding dispatch and was equally
red. Root independently verified five files at 55 pass / 0 fail / 284
assertions / exit 0, and typecheck exited 0.

Prompt/output integrity guards must not obtain canonical constraint inputs
through a shadowable public helper. That does not make this helper entity or
rules authority, and the scope must not be inflated beyond dialogue repair.

The authoritative full `bun test` exited 0: 4615 tests / 394 files / 4579 pass
/ 36 skip / 0 fail / 28288 assertions / 296.85s. The probe was 47 no callers /
65 test-only / 40 should-private. todo-64, todo-65, and the broad production
goal remain open. Standard preflight remains pending for root and is not
claimed green. Generated documents and `docs/notes/index.json` remain deferred.

## Snapshot evidence must use one private canonical builder (2026-10-03)

Public observation API can remain compatible and shadowable. Persistence and
source-fence authority cannot rely on that public surface: a single private
canonical snapshot builder must supply both transaction pre-action capture and
later source-current comparison. Here, public `exportOrdinarySessionSnapshot`
is only a forwarder, while `snapshotBeforeAction` and
`isPreActionSnapshotCurrent` invoke `#exportOrdinarySessionSnapshotCanonical`
directly.

Eight own/prototype fake-or-throw and capture-after-shadow tests make the
negative-control boundary explicit. The public call continues to observe a
shadow; internal snapshot evidence does not. The old implementation and the
mutation restoring only the two internal public dispatches were both red at 0
pass / 8 fail / 22 assertions / exit 1; exact restoration was 8 / 0 / 26.
Root verified 119 pass / 5 files / 0 fail / 658 assertions and typecheck 0.

The authoritative full `bun test` exited 0: 4678 tests / 401 files / 4642 pass
/ 36 skip / 0 fail / 28777 assertions / 388.09s. The probe was 47 no callers /
69 test-only / 35 should-private. This closes only transaction snapshot
evidence no longer passing through a shadowable public export. `close()`,
`setScene()`, `addMessage()`, other public dispatch, cross-store,
crash/power-loss, deployment, and external-model quality remain open. todo-64,
todo-65, Checkpoint I, and the broad production goal remain open. Standard
preflight has not run after documentation update and is not claimed green.
Generated documents and `docs/notes/index.json` remain deferred.

## Internal fail-closed paths must not depend on a lifecycle wrapper (2026-10-03)

Public `close()` may remain a compatibility wrapper. It must not be the
authority used by internal fail-stop or restore-apply failure: those paths need
one private `#closeCanonical` operation so a same-name own or prototype shadow
cannot suppress closure. This does not require freezing the public method.

The correctness criterion is observable resource/closed state, not merely an
action latch. Tests must trigger real action and restore-apply faults, then
prove by canonical export that the session closed. Their negative control keeps
the public shadow observable, demonstrating that the internal paths no longer
depend on it. The old implementation and the mutation restoring only the two
internal `this.close` calls were both red at 0 pass / 8 fail / 26 assertions /
exit 1; exact restoration returned the new tests green. Root verified 125 pass
/ 8 files / 0 fail / 613 assertions with typecheck 0.

The authoritative full `bun test` exited 0: 4686 tests / 402 files / 4650 pass
/ 36 skip / 0 fail / 28814 assertions / 363.99s. The probe was 47 no callers /
69 test-only / 35 should-private. This closes only canonical close from
internal fail-stop and restore-failure paths. Public `close()`, `setScene()`,
`addMessage()`, other public dispatch, cross-store, crash/power-loss,
deployment, and external-model quality remain open, as do todo-64, todo-65,
Checkpoint I, and the broad production goal. Standard preflight has not run
after documentation update and is not claimed green. Generated documents and
`docs/notes/index.json` remain deferred.

## Scene-control wrappers are not world/player/compiler synchronization authority (2026-10-03)

Public `setScene()` can remain a compatibility wrapper, but internal scene
changes must call a single private `#setSceneCanonical` operation. Compiled
mechanics synchronization, player movement, and dynamic movement otherwise
inherit a shadowable scene-control dispatch and can produce divergent state.
Unregistered rejection, compiled mutation gating, revision, free-movement
registration, and KP manual scene-change semantics remain outside this change.

Negative-control coverage must preserve a shadowable public wrapper while
proving the internal operation ignores it. Six own/prototype fake-true,
fake-false, and throw tests include a real Barn action, free movement, and real
compiler-fixture load/durable restore, restoring prototype state in `finally`.
The correctness evidence is a coherent response, active world scene, p1
position and visit state, and compiled mechanics scene—not merely a successful
return. The old implementation and the mutation restoring only the three
internal `this.setScene` calls were both red at 0 pass / 6 fail / 17 assertions
/ exit 1; exact restoration was 6 / 0 / 51. Root verified 57 pass / 5 files /
0 fail / 348 assertions with typecheck 0.

The authoritative full `bun test` exited 0: 4692 tests / 403 files / 4656 pass
/ 36 skip / 0 fail / 28815 assertions / 373.69s. The probe was 47 no callers /
69 test-only / 35 should-private. This closes only private scene-control
dispatch for world/player/compiler synchronization. `addMessage()`, other
public dispatch, cross-store, crash/power-loss, deployment, external-model
quality, Checkpoint I, todo-64, todo-65, and the broad production goal remain
open. Standard preflight has now run in the restricted environment and exited
1 with exactly six internal `uv_spawn C:\\Windows\\system32\\cmd.exe` EPERM
problems: typecheck, bun test, probe, and `git config hooksPath` lookup did not
start; the test wrapper therefore has neither a parseable failure nor a count.
Static checks did complete: 295 boolean implementations / 0 discarded returns,
and generated/handwritten/structured document references 3 / 8 / 1. `git
ls-files` was unavailable, so only referenced-script existence—not tracked
status—was checked. Independent root typecheck, full `bun test`, and probe
evidence remain valid, but do not substitute for green standard-preflight
wrapper evidence. Generated documents and `docs/notes/index.json` remain
deferred.

## State effects and their audit must share private message authority (2026-10-03)

Public `addMessage()` can remain a compatibility wrapper, but internal send,
host-fallback, tick-damage, and tick-expiry paths must call one private
`#addMessageCanonical` operation. A shadowable public message hook must not
decide whether a state effect completed or whether its audit is available.
Host fallback is not a reason to add a test-only public interface.

The proof uses own/prototype no-op and throw shadows while preserving public
shadow as a negative control. It checks canonical send history and portable
snapshot consistency, plus a legal signed ordinary fixture where a real action
processes p1 bleeding and duration-1 status expiry: HP/status and their
damage/expiry audit must agree. The old implementation and the mutation
restoring only the five internal `this.addMessage` calls were both red at 0
pass / 8 fail / 28 assertions / exit 1. Root verified 77 pass / 7 files / 0
fail / 367 assertions with typecheck 0.

The first full run is retained, not normalized away: it exited 1 at 4700 tests
/ 404 files / 4663 pass / 36 skip / 1 fail / 28877 assertions / 514.22s. Its
sole failure was the existing `game-session-compiled-runtime-authority` case
`does not let a throwing pristine-compiled-restore shadow DoS the normal
conflict refusal`, timing out at 8700.33ms against 5000ms. That file passed
independently at 32 / 0 / 155 / 17.01s. The second unmodified full run, without
raising timeout, exited 0: 4700 / 404 / 4664 pass / 36 skip / 0 fail / 28890
assertions / 489.65s. The probe was 47 no callers / 69 test-only / 35
should-private.

This closes only addMessage internal dispatch. `getHistory`, NPC prompt
context, other public dispatch, cross-store, crash/power-loss, deployment,
external-model quality, Checkpoint I, todo-64, todo-65, and the broad
production goal remain open. Standard preflight has now run in the restricted
environment and exited 1 with exactly six internal `uv_spawn
C:\\Windows\\system32\\cmd.exe` EPERM problems: typecheck, bun test, probe,
and `git config hooksPath` lookup did not start; the test wrapper has neither a
parseable failure nor a count. Static checks completed: 295 boolean
implementations / 0 discarded returns and generated/handwritten/structured
document references 3 / 8 / 1. `git ls-files` was unavailable, so only
referenced-script existence—not tracked status—was checked. Independent
typecheck, full `bun test`, and probe green evidence remains valid, but does
not substitute for green standard-preflight wrapper evidence. Generated
documents and `docs/notes/index.json` remain deferred.

## Public history is not NPC prompt-context authority (2026-10-03)

`getHistory()` may remain a public observation and compatibility wrapper, but
an NPC talk turn must use a private canonical history projection. Otherwise an
own-property or prototype shadow can fabricate model context or make a normal
talk turn fail without changing the public API contract.

The acceptance test needs to capture the actual local NPC prompt, not merely a
returned transcript. A canonical marker must appear in that prompt and a
forged marker supplied by a shadowed public wrapper must not. The same proof
must cover fake and throwing own/prototype shadows, while restoring the public
shadow after each test. This is a context-authority boundary only: NPC intent,
constraints, fallback, PlayerSession history, and public compatibility remain
unchanged.

The old implementation and the mutation changing only `handleTalk` back to
`this.getHistory(10)` were both red at 0 pass / 4 fail / 34 assertions / exit
1. Exact restoration produced 4 pass / 0 fail / 64 assertions. Root verified
35 pass / 6 files / 181 assertions, typecheck 0, and full `bun test` 4704
tests / 405 files / 4668 pass / 36 skip / 0 fail / 28996 assertions / 436.20s.
The unwired probe was 47 no callers / 69 test-only / 35 should-private.
Root then ran standard `bun scripts/preflight.ts`; it exited 1 with exactly six
internal `uv_spawn C:\\Windows\\system32\\cmd.exe` EPERM problems. Typecheck,
`bun test`, the probe, and `git config hooksPath` lookup did not start, so the
test wrapper produced neither a parseable failure nor a count. Static checks
did complete: 295 boolean implementations / 0 discarded returns and
generated/handwritten/structured document references 3 / 8 / 1. `git
ls-files` was unavailable, so only referenced-script existence—not tracked
status—was checked. Independent root typecheck, full `bun test`, and probe
green evidence remains valid but cannot substitute for a green
standard-preflight wrapper. The baseline remains 4704 / 405 / 4668 / 36 / 47;
todo-64, todo-65, and the broad production goal remain open. Generated
documents and `docs/notes/index.json` remain deferred.

## Ordinary snapshot evidence and Luck controls require canonical authority (2026-10-03)

Persistence evidence and source-current fencing use
`#exportOrdinarySessionSnapshotCanonical`, not the public compatibility export.
An own or prototype shadow may still affect the public observation wrapper, but
must not fabricate or deny the snapshot used inside a transaction.

The player-facing Luck control has the same rule: unknown is `null`, not a
guessed balance. Only canonical create, GET, reconciliation, or a validated
receipt can set the displayed value, and a spend is generation-bound with no
optimistic deduction. The shared pending record is a closed text-or-Luck union:
an unresolved text action is not a successful Luck reconciliation, and a 401
retains the pending action for its proper authenticated replay.

Current 1.5 ordinary cosmic-horror receipts bind displayed Luck to the active
canonical party member. Compiled, D&D, and invalid-Luck states omit that
projection. A signed 1.4 hot text receipt can carry the same canonical Luck,
but legacy may omit it; a rehashed envelope whose carried value no longer
matches canonical state is rejected. `luck:null` for a current non-CoC state is
not a reason to invent a display-Luck requirement.

The initial full regression retained two real defects rather than treating them
as sandbox noise: the shallow frontend owner-auth assertion and the overbroad
1.4 Luck rejection. After their behavior-based and envelope-aware repairs, the
authoritative full suite was 4753 tests / 411 files / 4717 pass / 36 skip / 0
fail. This narrows snapshot and ordinary Luck authority only; it does not add a
public PlayerApp entry or close the remaining ordinary mutators, cross-store,
crash/power-loss, deployment, or external-model boundaries.

The final standard `bun scripts/preflight.ts` remains an environment-limited
result, not a substitute verdict: it exited 1 with exactly six internal
`C:\\Windows\\system32\\cmd.exe` `uv_spawn` EPERM startup failures. Typecheck,
`bun test` (so no parseable test failure or count), the unwired probe, and the
`git config core.hooksPath` lookup did not start. Its static portions did
complete at 295 boolean implementations / 0 discarded returns and document
references 3 / 8 / 1; `git ls-files` was unavailable, so it checked only
referenced-script existence. The independent typecheck 0, full 4753-suite
green result, and 47 / 69 / 35 direct probe remain the relevant product
evidence, without making this wrapper green.

## Durable receipts and owner pending state are session-scoped (2026-10-03)

An ordinary durable receipt is evidence of the committed canonical successor,
not a UI-local success token. The `/character` operation therefore binds its
strict `actionId` and `expectedGeneration`, canonical active PC, signed
candidate/archive, CAS publication, replay, and hydrate/install result as one
receipt boundary. A receipt detached from its committed snapshot is invalid;
compiled requests remain refused and legacy payloads fail before mutation.
Internal snapshot evidence must likewise come from the private canonical
ordinary builder rather than a shadowable public export.

The owner party-create UI has one durable pending slot **per session**, not one
global pending record. A known pre-persist failure clears only its false slot;
an ambiguous result stays for replay. `newGame` must neither transplant old
session pending state nor discard the new session's own recoverable record.

Correction: the first full regression's two assertion failures were stale test
premises, not evidence that the stricter behavior was wrong; both were replaced
with behavior-based checks and red/restored production mutations. The third
failure was the sandbox host EPERM. The final outside-sandbox suite was 4771
tests / 414 files / 4735 pass / 36 skip / 0 fail / 29531 assertions. This
narrows durable character/party and snapshot authority only: full frontend DOM
coverage, a production Vite build, cross-store/Career and crash/power-loss
recovery, and multi-writer/process guarantees remain open.

The subsequent standard-preflight evidence is an environment boundary, not a
green verdict. Requested outside-sandbox elevation for `bun scripts/preflight.ts`
was policy-rejected; the ordinary sandbox command exited 1 with exactly six
internal `uv_spawn C:\\Windows\\system32\\cmd.exe` EPERM startup problems:
one typecheck, three `bun test` starts (hence no parseable failure name or test
count), one probe, and one `git config core.hooksPath` lookup. Its static work
did complete at 295 boolean-returning implementations / 0 discarded returns
and generated/handwritten/structured references 3 / 8 / 1; `git ls-files` was
unavailable, so only referenced-script existence was checked. This neither
replaces nor invalidates independent typecheck 0, the outside-sandbox 4771 / 414
/ 4735 / 36 / 0 suite, direct probe 47 / 69 / 35, or outside-sandbox
`server-host-resource-policy` 1 / 1. It does not validate the frontend
production build, which remains unverified.

## Cross-store recovery must be identity-bound, and check inputs must retain their domain (2026-10-03)

An ordinary successor and its Career projection are two durable stores, not one
transaction merely because a caller holds a local lock. A correct recovery
record must bind the exact predecessor and successor identities (including
generation and canonical envelope hashes), fence competing writers, and
reconcile only that authenticated pair. A generic "the projection now looks
valid" test cannot distinguish an ABA return or a substituted staged snapshot.
The safe residual when a process is killed or a root lock is stale is
fail-closed/manual recovery; it must not be described as automatic crash or
power-loss recovery until it is actually tested.

The same separation applies to discovery checks. `luck`, `strength`, ordinary
skills, clues, locations, and targets are different semantic domains. A check
may project canonical character attributes into a transient evaluation view,
but must not write proxy values into `skillValues` or relax the character
validator to accommodate a test fixture. Tests should use legal canonical
characters and demonstrate both that the intended attribute check succeeds and
that an existing real skill still wins where its mechanics say it should.

For owner UI, a visible patch is not a committed character change. The durable
contract is the generation-bound operation and its authenticated canonical
receipt; pending/retry state belongs to the session and ambiguous transport
outcomes remain recoverable, not local success. These three boundaries were
verified in the 4801-test full suite (4765 pass, 36 skip, 0 fail), but they do
not close ordinary `/kp` or `/npc-chat` (both remain 409), full browser
DOM/production-build evidence, compiler checkpoints, or the production-quality
goal. `docs/notes/index.json` is intentionally not refreshed here because it
has parallel edits.

## Process termination coverage is not power-loss coverage (2026-10-03)

The Career journal now has real child-process termination/reconciliation
coverage for E=g1/N=g0, including a poisoned-predecessor repair case. That is
stronger than a simulated throw: recovery must select the exact authenticated
predecessor/successor pair after a real process boundary, rather than accept a
plausible-looking projection. It is still a deliberately narrow result.

Automatic recovery of a stale Career-root lock is not established; the current
safe procedure remains fail-closed/manual recovery. Orphan stage cleanup and
real power-loss behavior are likewise open. The full verification at this
point is `bun test` exit 0: 4801 tests / 418 files / 4765 pass / 36 skip / 0
fail / 29829 assertions; typecheck and the unwired probe also exited 0, with
46 no-caller methods. None of that makes todo-64, todo-65, Checkpoint I, or
the production-quality objective complete.

## Retiring unreachable runtime code is not a route change (2026-10-04)

Once a durable route has returned, source-history dead mutation code must not remain below that return: it is neither fallback behavior nor a usable API. A behavior gate proves the live contract (including durable routes and deliberate pre-body tombstone refusals); a source-retirement sentinel proves that the unreachable legacy authority block stays gone. They have different jobs.

Do not erase a tombstone refusal into a 404 merely because it rejects, and do not mistake a dead post-return block for an available legacy mutation path. Keep intentional rejection behavior explicit while removing only unreachable authority.


## Same-name method diagnostics must retain class identity (2026-10-04)

An unwired-method diagnostic must key a class method by its declaring class or equivalent symbol identity, not only by a textual `.name(` match. Same-named component methods can otherwise hide a dead aggregate-facade method, or a valid component API can be falsely treated as the aggregate's authority.

Keep the domains explicit: a component API such as `WorldStateManager.setPlayerArmor` may be legitimate internal state authority, while `GameSession.setPlayerArmor` can still be an obsolete public aggregate write path. Retiring the latter must preserve the former and the canonical armor snapshot behavior.

## Durable live capability gates precede irreversible writes (2026-10-04)

An acknowledged ordinary live session is an observation, not a second mutation
authority. A capability check that happens only at final acknowledgement is too
late: a missing or wrong capability must fail closed before any restore,
derivation, persistence, or CAS can create `g0` or advance `g1`. Restore is a
mutation surface too; treating it as a read-like recovery shortcut can split
state, hash, history, and durable identity.

Constructor-only server capability injection is not published-object rebinding.
The host may mint the constructor capability for its own new session, but no
public bind/rebind operation may attach it to an existing server session. The
server transaction wrapper is therefore the only legal mutating route. Legal
work happens in an identity-null staging candidate; the acknowledged live
object remains read-only until the candidate has passed the durable CAS path.

Acknowledgement must be monotonic: first install succeeds, a repeat of the
exact tuple is idempotent, and a different tuple rejects. This preserves a
stable live identity instead of silently advancing it through a second ack.

Correction to the earlier, narrower framing: final-ack rejection alone and
the mere fact of constructor injection are not sufficient authority proofs.
The historical entries remain valid for their recorded scopes, but this note
adds the required pre-write fail-closed, restore, staging, and exact-ack
criteria. The current 4838 / 425 candidate baseline is an auditable +8 tests /
+1 file uplift awaiting host preflight confirmation, not a full-suite or
standard-preflight green claim.

## Ordinary terminal and dice views are public projections, not canonical aliases (2026-10-04)

`getOrdinaryTerminal()` and `ActionResponse.terminal` now return detached,
frozen terminal projections. `ActionResponse.dice` is likewise detached and
deep-frozen. These are observation surfaces: the canonical terminal and dice
internals keep their existing authority and are not changed by this closure.

The old implementation and three independent fallback-alias mutations were
red; exact restoration was green. Root's independent check was 34 pass / 0
fail / 225 assertions, with typecheck exit 0. This proves the public projection
boundary only; it does not establish a general child/alias or cross-store
atomicity guarantee.

## Career partial-stage recovery is bounded and remains operator-gated (2026-10-04)

Career publication verifies a completed `building-*` stage before atomically
renaming it to `projection-*`. A completed stage that is not protected by the
pointer or journal is first renamed to `retired-*`, then deleted. Recovery of
`building-*` and `retired-*` residuals is bounded. Old or hostile partial
`projection-*` layouts remain fail-closed and operator-only.

The new coverage includes two storage Career-writer child-termination plus
HTTP-composition cases—not a full server-request kill—and namespace coverage.
Restoring construction inside the projection path made the intended regression
red; exact restoration was green. Root's independent results were 42 pass / 4
existing Windows symlink/junction skips / 0 fail / 248 assertions and 24 pass /
0 fail / 205 assertions; typecheck exited 0 and the probe was 46 no callers /
74 test-only / 37 should-private.

Correction: saying that every action works directly in the final root was too
broad. A candidate first operates in a temporary root, and the server's later
final-root prepare path is genuinely reachable. Saying that lock recovery is
unneeded, or that a stale lock means permanent 503, was also too broad. A
stale root lock intentionally fails closed; an operator must first confirm the
writer process has exited and then remove that exact lock. The resulting new
residual is eligible only for the bounded recovery above, not automatic broad
reclamation.

Windows directory sync remains best-effort. This is not a cross-platform true
power-loss or directory-fsync claim. The 4844 / 425 / 4808 / 36 / 46 candidate
adds six tests, no files, and six passing cases over 4838 / 425 / 4802 / 36.
No full `bun test` or standard host preflight was run or returned for it, so it
is not full green and the host-preflight result remains outstanding. todo-65
remains open for that host preflight, frontend build/DOM coverage, true
cross-platform power-loss and directory-fsync behavior, admission quarantine
and operator-recovery as independent boundaries, multiwriter, deployment,
external-model, Checkpoint, and the other production-quality work.

## Admission domains, early authentication, and fixture authority remain distinct (2026-10-04)

An injected ordinary admission coordinator must name the exact runtime-namespace
SQLite file, not merely a same-looking root. Host-owned ordinary durable routes
authenticate before body, namespace, snapshot, receipt, Career, or model work;
the action, character, party, luck-spend, KP-message, and legacy ambiguous
action routes fail closed when their admission domain is wrong. Compiled host
intents authenticate before namespace reconciliation, while compiled player
intents may inspect only a fully validated bounded snapshot before cookie
authentication. Unknown, corrupt, absent-cookie, and malformed-cookie player
locators must remain the same `401 PLAYER_AUTH_REQUIRED` no-store response,
including when player delivery is unavailable; a later authenticated legacy
Bearer path may still report its own service condition. These are preflight
ordering and locator-oracle boundaries, not an authorization bypass.

The confirmation baseline is `bun test` exit 0: 4853 tests / 426 files / 4817
pass / 36 skip / 0 fail / 30360 assertions / 375.58s. Its +9 tests and +1
file over 4844/425 are five ordinary-admission/early-auth cases, three
player-preauth/locator-oracle cases, and one compiled negative-build case;
projection type work adds no test. Directed evidence was 48 / 0 / 534, 19 /
0 / 192, and 53 / 0 / 361, with typecheck exit 0 and probe exit 0 at 46 / 74
/ 37.

The compiled build failure was a validator/domain mismatch, not retry noise:
the rules engine permits `COC_BUILD_RANGE` -2 through 8, but snapshot
validation had rejected legal build -1. Deterministic seed 556 reproduced the
old HTTP-create 500. Restoring the old minimum-zero predicate made that case
red; exact restoration was green. Rehashed -2 and 8 validate, while -3 and 9
reject. Do not widen the domain beyond the rules range to hide malformed
fixtures.

Legacy envelope, fresh-process restart, and NPC-isolation fixtures also must
not fabricate a durable host capability: they receive the exact opaque object
only through the server factory's constructor runtime dependencies. After
durable identity acknowledgement, the NPC regression uses the real strict
HTTP action transaction and rereads the installed registry target. Removing
constructor propagation or restoring direct post-ack `act` makes the relevant
tests red; the fixture repair adds no tests or files.

Standard preflight remains an open host action. Inside this sandbox it exits 1
with exactly six `C:\Windows\system32\cmd.exe` uv_spawn EPERM startup
failures; requested host elevation was policy-rejected. The full suite and
direct typecheck are valid product evidence but are not a green preflight. No
external model was used, no commit/push occurred, and generated docs plus the
notes index remain deferred. todo-65 remains open for the still-unclosed
authority, cross-store, multiwriter, frontend/build, deployment,
external-model, checkpoint, and true power-loss boundaries.

## Construction failure cleanup and compiled durable host authority (2026-10-04)

Construction is fail-closed at the narrow boundaries now covered: an unknown
archetype returns 422 before durable construction or persistence, and a
construction fault cleans up its private staging state rather than publishing
an incomplete session. This is not a claim of generic crash/power-loss cleanup
or cross-store atomicity.

Compiled durable authority is now a module-private WeakMap capability. The
constructor receives one opaque server/test host object; only the corresponding
module helpers can read the full access binding, create a durable snapshot,
acknowledge it, resolve a player choice, or commit an action. Public
`GameSession` no longer exposes the old access-secret, snapshot, ack, commit,
or player-choice authority entries, and serializable public projections omit
`choiceHmacKey` and `inviteDigest`. The persisted snapshot deliberately still
contains the access secret, so a fresh restore produces stable choice IDs.

Durable compiled `act()` rejects instead of advancing in memory. Acknowledging
a snapshot compares the full canonical current snapshot, not merely session,
generation, and bundle identity, so a forged same-identity hash cannot become a
successor predecessor. Server authorization and player choice resolution use
the host helper rather than a public/own-shadowable session accessor. HTTP
request data never chooses the host capability.

The first authoritative full run recorded the migration gap rather than hiding
it: `bun test` exited 1 with 4862 tests / 427 files / 4824 pass / 36 skip / 2
fail. The two 503s were stale fixtures that did not install their own opaque
capability: keeper object-form input correctly stopped at
`COMPILED_DURABLE_HOST_UNAVAILABLE`, and the negative-build source/recovery
fixture did likewise. Each fixture now creates one explicit capability and
passes it through the source, HTTP dependency, and rehydrated target. A new
mismatch test proves that a factory session with a different capability is
rejected before module load or persistence; this is a fixture/host boundary,
not an HTTP capability fallback.

Real mutations were restored after turning their intended regressions red:
two construction catch/gate mutations; public whole-secret getter; public
arbitrary ack/forged predecessor; public arbitrary persistence-callback commit;
removal of the durable direct-act guard; server choice dispatch through a
public own-shadowable accessor; and removal of the production factory capability
assertion. The last changed the mismatch test from expected 500 to 409.

Verification after restoration: joint directed 254 pass / 22 files / 0 fail;
independent 13 pass / 3 files / 0 fail; typecheck exit 0; and direct
`probe-unwired` exit 0 at 46 no callers / 73 test-only / 37 should-private.
The second authoritative full `bun test` exited 0: 4863 tests / 427 files /
4827 pass / 36 skip / 0 fail / 30446 assertions / 380.40s.

Standard preflight still needs a host rerun. The sandbox's six `cmd.exe`
`uv_spawn` EPERM startup failures are not green preflight evidence. Generated
documents and `docs/notes/index.json` remain deferred. This closes only the
construction and compiled durable-authority slices; todo-65 and the broader
production objective remain open.

## Isolated production API/startup smoke and deployment audit (2026-10-04)

A disposable production-mode server root exercised the real startup and HTTP
chain without external-model access. `GET /api` returned 200; the SPA fallback
and a hashed JavaScript asset `HEAD` each returned 200. `GET /api/config` was
401 without credentials and returned 200 with `Cache-Control: no-store` for an
operator. Ordinary session create returned 201, list and authenticated summary
returned 200, and an unauthenticated summary was 401. With `LLM_DISABLED` and
the required intent policy, an ordinary action returned 503 and the
authoritative generation stayed at 0. The temporary fixture root was deleted.

This is bounded API/static/startup smoke evidence; it is not frontend-build,
Docker-image, standard-preflight, deployment, or real-model evidence. In
particular, `frontend` `bun run build` exited 1 in the agent sandbox because
its esbuild child spawn was denied with `EPERM`. A request to run that command
outside the sandbox was policy-rejected, so the result is neither a product
build failure nor green build evidence; the host must rerun it.

A separate read-only audit of Dockerfile, docker-compose, frontend production
paths, static delivery, and the API entrypoint found no static configuration
blocker: Vite emits to the image's configured frontend root, browser calls are
same-origin `/api`, Docker starts the API entrypoint, and the exposed port and
`/app/data` volume match runtime defaults. The current checkout does not
contain the deliberately external `assets/` directory required by Dockerfile
`COPY`, so no Docker build was run. Providing those world-model assets and
deployment credentials remains a host deployment prerequisite, not a source
configuration defect. todo-65 and the broader production objective remain
open; generated documents and the notes index remain deferred.

## Checkpoint I candidate revalidation and ordinary unsupported intents (2026-10-04)

Checkpoint I now has current candidate evidence, but is not marked complete.
Failure recovery is judged from the concrete failed state; shortest witnesses
use reported `steps.length`, may replace an earlier longer route, and propagate
that improvement to later witnesses; default discovery location remains tied
to verified heading scope rather than `targetId`. Restoring full-graph recovery
aggregation, first-witness fixation, or target-location fallback made the
intended regression red; exact restoration was green.

Valid required-provider `equip`, `unequip`, `use_item`, `allocate_skills`, and
`reload` labels used to consume a turn and could report completion without an
authoritative protocol. Reload also has no ammo truth source. They now return
`ordinary_action_unsupported` before
`lastActiveAt`, round, game time, status, history, or other state mutation.
HTTP maps that exact code to 422, and the existing non-200 durable transaction
rule publishes neither successor generation nor receipt. No speculative
equipment, ammo, consumable-effect, or skill-allocation model was added.

Removing `reload` from the pre-turn refusal restored its real old success path
and made the focused file 0 pass / 2 fail / 48 assertions: direct act had no
error and HTTP returned 200. Exact restoration was 2 pass / 0 fail / 57
assertions, with the GameSession hash exactly restored. Current full
`bun test` exited 0: 4867 tests / 428 files / 4831 pass / 36 skip / 0 fail /
30466 assertions / 382.43s; typecheck exited 0. Standard host
`bun scripts/preflight.ts` also exited 0: typecheck 0, 4867 tests / 428 files
and unwired 46 match their baselines, boolean-returning implementations are
302 with 0 discarded returns, and core.hooksPath is `.githooks`. Checkpoint I
verification evidence is ready for main-controller acceptance; this work does
not self-declare acceptance or enter Checkpoint II. Frontend `bun run build`
exited 1 in the sandbox only because esbuild spawn was denied with `EPERM`; the
same host/outside-sandbox command exited 0 with Vite 6.4.3, 33 transformed
modules, an 862ms build, and emitted `dist/index.html` plus hashed CSS/JS.
Frontend build is therefore verified; browser DOM coverage remains open. The
external `C:\aitrpg\poc\assets` directory is still absent, so actual Docker
build remains blocked on that prerequisite. This is +4 tests / +1 file over
4863/427: two unsupported-intent cases, one shortest-route propagation case,
and one durable world-scope recovery case. todo-64/todo-65 and later compiler
checkpoints remain open; generated docs and the notes index remain deferred.

## Ordinary unsupported actions and safe read projections (2026-10-04)

The ordinary required-provider labels `equip`, `unequip`, `use_item`,
`allocate_skills`, `reload`, `shop`, `buy`, and `sell` remain parseable but are
not executable mutation protocols. They now fail before the turn with
`ordinary_action_unsupported`: HTTP returns 422 at generation g0, publishes no
receipt, and advances no state, round, game time, status, history,
`lastActiveAt`, or `lastNarrative`. Buy and sell preserve the established
truthful-feedback contract through read-only system events; sell reads only
the validated actor's canonical inventory. No missing equipment, ammo, item,
skill-allocation, shop, purchase, or sale model was invented.

Read-only information surfaces were narrowed at the same boundary.
`view_module` exposes only installed modules' player-safe display name and
version, not internal module ID, description, or summary. `spell_list` exposes
only canonical names of spells the validated character knows, not unlearned
spells or effect details.

The first simple buy/sell refusal made the real full suite red: 4868 tests /
428 files / 4824 pass / 36 skip / 8 fail / 30518 assertions / 385.90s. All
eight failures were existing game-session/no-lying-stubs truthful-feedback
contracts; no test was removed or weakened. Read-only refusal projection then
returned the directed set to 75 pass / 0 fail / 316 assertions, with typecheck
exit 0. Removing the buy guard was 1 pass / 2 fail / 83 assertions because
direct act had no error and HTTP returned 200; precise restoration was green
and retained GameSession hash prefix `B59BC4`. Removing the reload guard was
0 pass / 2 fail / 48 assertions and restored to 2 pass / 0 fail / 57
assertions. Removing the shop guard was 1 pass / 2 fail and likewise restored.

After the additional unsupported-intent test, an initial full run reported
4868 tests / 428 files / 4830 pass / 36 skip / 2 fail / 30585 assertions /
569.44s. Both failures were only the default 5000ms budget: the ordinary
fail-closed contract completed in 5207ms and the scene-id 21-scenario
enumeration in 6230ms; focused reruns completed in 4771ms and 4601ms with
28 pass / 0 fail. Only those two tests received local 10,000ms budgets;
assertions and behavior did not change. Directed verification was 28 pass /
0 fail / 292 assertions and typecheck exited 0. A later full run interrupted
externally with 0xC000013A is not result evidence. The reliable final full run
exited 0: 4868 tests / 428 files / 4834 pass / 34 skip / 0 fail / 30585
assertions / 362.74s. The skip count is capability-dependent: two
`FILE_SYMLINK_SUPPORTED` cases executed in this authorized environment, two
junction-capability cases may still skip by platform, and the other 32 are
retired 32-state cases. The measured 34 is not asserted as an invariant for
every host.

Root then ran the original post-change `bun scripts/preflight.ts` on the
authorized host and it exited 0: 304 boolean-returning implementations / 0
discarded returns; generated, handwritten, and structured reference counts
3 / 8 / 1 plus reverse references 3; internal typecheck exit 0; exact 4868
tests / 428 files (4834 pass / 34 skip) and unwired 46 matching their
baselines; and core.hooksPath `.githooks` with the commit-msg criterion
running. Checkpoint I's candidate evidence is ready for main-controller
acceptance, but the checkpoint is not self-declared complete and this work
does not enter Checkpoint II.
todo-64/todo-65 and the broad production-quality objective remain open. The
trusted compiled artifact-to-work/corpus selector, external Docker assets,
browser DOM/deployment verification, real-model quality, and wider production
behavior remain unresolved; external-model probing remains unauthorized.
Generated status documents and `docs/notes/index.json` are intentionally not
refreshed.

## Correction: transient fixture authority and compiled generation lineage (2026-10-04)

This corrects the fixture method in the preceding durable/Career history; it
does not delete that history or loosen the production direct durable/Career
gate. A purely in-memory fixture is an explicitly `transient` source and may
restore only to an explicitly `transient` target. It must not write Career
base/projection state. Its current signed snapshot must state
`career.mode: "transient"`; a transient snapshot cannot be upgraded into a
durable target, and there is no durable fallback.

Tests that assert actual Career base/projection writes, growth settlement,
departure persistence, or durable recovery must instead create the proper
constructor capability and execute `runOrdinaryDurableActionTransaction`, or
exercise the real HTTP route. The older public `act` monkeypatch is no longer
a valid synchronization point: direct action now enters through a gate and
transaction path that does not establish durable context merely because the
public wrapper was intercepted. The correction is to use the real authority,
not to bypass or weaken the gate.

A stale compiled g0 fixture is likewise not a reusable successor. Its
`beforeAll` must rehydrate the namespace-exact authoritative g1 and preserve
the matching generation and signed-snapshot lineage; a same-name record,
cross-namespace generation, or memory fallback is not equivalent. Root's
first complete run recorded the gap honestly at 4896 tests / 431 files /
4813 pass / 34 skip / 49 fail. After the fixture authority migration and
compiled-fixture rehydration, the representative 116-test/9-file group and
the repaired 213-test/19-file group both exited 0; typecheck exited 0. The
final full run exited 0: 4896 tests / 431 files / 4862 pass / 34 skip / 0
fail / 30829 assertions / 473.11s. This records test-fixture correctness only;
it does not claim cross-store, crash/power-loss, or broader production
completion.

## Long test processes have one owner (2026-10-04)

Current shared-tree baseline correction: the parallel source-proposition loader
adds 7 tests / 1 file, yielding 4911 tests / 434 files / 4877 pass / 34 skip /
0 fail / 31011 assertions / 481.55s; it is not attributed to the preceding
world-binding slice, whose own evidence remains 4904 tests and +8 tests / +2
files.

A full suite or preflight is a single-owner operation: do not start parallel
preflight/full-test workers against the same worktree, registry roots, ports,
or process tree. Their timeout fallout is environment contention, not product
evidence, until the exact competing processes have been identified and removed.

The first 4904-test full run had one real five-second timeout: a static-authority
fixture inherited ambient LLM configuration and the default Career root. The
repair made the fixture explicitly offline, gave it a temporary Career root,
set fetch to zero, and cleaned up; it did not widen the test timeout. A later
rerun had 18 pure timeouts because three residual parallel preflight workers
were still active, so it is not counted as red or green evidence. Those test
processes were precisely terminated while the user's `opencode` process was
preserved; the subsequent clean single-owner full run was 4904 tests / 433
files / 4870 pass / 34 skip / 0 fail / 31001 assertions / 569.07s.

This is process-ownership methodology, not a claim that concurrency bugs or
external-model quality are closed. `docs/notes/index.json` remains deliberately
unrefreshed, so its index is behind this append.

## Correction: bounded Career stale-owner recovery on Windows fixed local volumes (2026-10-04)

The older operational boundary stating that every Career root lock required a
human `unlink` is corrected, not erased. For a **Windows fixed local volume**,
a root-wide `Global` named mutex now covers the whole root operation and a v1
lock record binds the owning PID to its process-creation FILETIME. Reclaiming
an apparent stale owner requires two liveness checks plus raw/dev/ino identity
validation. A lock that is merely contended is never deleted. Old or malformed
records, non-Windows or nonfixed locations, unknown identity, and access-denied
liveness remain fail-closed; mutex-cleanup errors preserve the original causal
error.

This closes a narrow stale-owner recovery case, not generic lock safety. It
does not establish NFS/SMB behavior, power-loss recovery, non-Windows automatic
reclaim, cross-file atomicity, multiwriter completion, or deployment readiness.

The direct process-kill suite exited 0 with 13 pass / 0 fail / 48 assertions.
The 12-file Career suite exited 0 with 98 pass / 2 existing symlink-capability
skips / 0 fail / 717 assertions; typecheck exited 0. Restoring the previous
permanent stale-lock fail-closed behavior made the direct suite red at 6 pass /
4 fail, and removing the owner-liveness gates made the live-owner target red at
0 pass / 1 fail. Exact restoration was green. The clean full suite exited 0:
4915 tests / 434 files / 4881 pass / 34 skip / 0 fail / 31009 assertions /
520.73s. Correction: the subsequent final standard host `bun scripts/preflight.ts`
exited 0; it confirmed 312 boolean-returning implementations / 0 discarded
returns, document-reference checks 3 / 8 / 1 / 3, internal typecheck 0, and
the exact 4915-test / 434-file and unwired-46 baselines with `.githooks`
commit-msg enforcement running. This adds no second full-suite claim.
`docs/notes/index.json` is deliberately unrefreshed and therefore does not yet
index this correction.

## Opening cancellation, shared offline LLM construction, and test isolation (2026-10-05)

Cancellation of an ordinary opening request is lifecycle authority, not a
narrative fallback. `POST /api/sessions` carries `Request.signal` through
`GameSession.getOpeningScene` and `KPAgent.describeScene` to the existing
`LLMClient.chat`. An abort before opening, a provider error carrying the
aborted signal, and the post-opening/pre-prepare race all use the same cleanup:
release the namespace reservation with `CREATE_REQUEST_ABORTED`, close the
staging session, delete only its non-authoritative staging root, and return
`408 REQUEST_ABORTED`. That path publishes neither a snapshot nor a registry
entry. It must not fabricate a template opening after cancellation.

The offline override must be applied **before** a shared client is injected
into KP and NPC consumers. The existing exact `llmDisabledByOverride` rule
makes `LLM_DISABLED=true` or `LLM_MODE=template` choose one `MockLLM` for KP
and `AgentRegistry`/NPC, plus a null intent provider. Valid explicit provider
configuration remains provider-capable when that override is absent. A raw
registry LLM or a late override makes the construction boundary inconsistent;
neither is an acceptable test-only bypass.

Provider and listener tests that depend on global process state must isolate
the **whole consumer path** in a child process. Do not toggle parent
`process.env` or global `fetch` around an imported consumer: the shared preload
is intentionally offline, while the child can create the real `LLMClient` and
make the asserted request. The two real loopback CORS cases similarly run an
isolated `Bun.serve` path with both streams drained and a 30-second kill guard.
Removing the signal or post-await opening gate, the offline construction gate,
the raw-registry protection, the child HTTP path, or the isolated loopback
fetch path made its intended regression red; exact restoration and five CORS
stress rounds were green.

The final single-owner suite was 4937 tests / 439 files / 4903 pass / 34 skip /
0 fail / 30807 assertions / 471.71s; typecheck and the direct unwired probe
also exited 0 (46 no callers / 74 test-only / 36 should-private). The final
standard host `bun scripts/preflight.ts` also exited 0: 312 boolean-returning
implementations / 0 discarded returns; generated/handwritten/structured/reverse
document checks 3 / 8 / 1 / 3; internal typecheck 0; 4937 tests / 439 files
and unwired 46 exactly matched baseline; and `core.hooksPath` was `.githooks`
with the commit-msg criterion running. This validates the current baseline,
not production completion. A static Docker audit is likewise not image
evidence. The Dockerfile now pins Bun
1.3.14 and uses frozen frontend and backend production installs; host frozen
installs and the Vite 6.4.3 frontend build passed, but Docker was unavailable
and no image/Linux-native build ran. `assets/` is still absent and required for
staging. The legacy Cthulhu aggregate remains migration-analysis-only, not a
production compiled dataset/binding. No authoritative production
module-to-allowedWorkIds/corpus/transfer policy or main-server resolver exists,
so production world binding is not enabled. todo-64/todo-65, ordinary
post-crash lease/provider exactly-once behavior, NFS/SMB, power-loss,
multiwriter, deployment, and external real-model quality remain open.
`docs/notes/index.json` stays deliberately unrefreshed because parallel edits
are being preserved.

## Ordinary operator recovery: TTL observes; durable authority decides (2026-10-05)

An expired lease is evidence for an authenticated operator to ask the server to
recover; it is not takeover authority. Ordinary recovery therefore has two
separate durable transactions. The first bodyless operator call must compare
the complete authoritative binding and the expired lease, then CAS-persist a
quarantine and return `202 quarantined` without `Retry-After`. Only a later,
independent call may CAS-delete that quarantined row and return `200 recovered`.
Combining creation and deletion in one request would erase the durable
intermediate fact needed to make the operation observable and retry-safe. A
still-live active lease is `busy`, not a TTL-based transfer.

The server's durable state, rather than caller input, decides the binding,
generation, and fence. A requested generation above authoritative
`currentGeneration` is a policy mismatch (`503`) that leaves the row unchanged.
An older-or-equal generation can remain recoverable: publish may have succeeded
while its release acknowledgement failed, leaving an old durable row. This is
ordinary-only (`recoverOrdinaryForOperator`); the compiled route continues on
its existing `recoverQuarantinedForOperator` contract. No request body,
caller-provided generation, or caller-provided fence is recovery authority.

The process-kill evidence is deliberately narrow but real: the test owns the
exact Bun child it creates, uses a 100ms lease, kills it, waits for exit and
stream drain, then observes `202` followed by an independent `200` recovery.
It performs zero player probes and zero model calls, allows a replacement
acquire, leaves no test process, and does not touch an unrelated user process.
This demonstrates the bounded server-side recovery protocol; it does not prove
provider exactly-once behavior. Exactly-once ambiguity across a post-crash
provider outcome remains open, as do NFS/SMB, power-loss, multiwriter,
cross-store/cross-file, deployment, compiled-artifact-to-world-binding, Docker
image/assets, and authorized real-model boundaries.

The final standard host `bun scripts/preflight.ts` for this recovery slice
exited 0: 313 boolean-returning implementations / 0 discarded returns;
generated/handwritten/structured/reverse document checks 3 / 8 / 1 / 3;
internal typecheck 0; exact 4939 tests / 439 files and unwiredMethods 46
baseline matches; and `core.hooksPath` was `.githooks` with the commit-msg
criterion running. This is a successful bounded verification, not production
completion or an exactly-once provider claim.

## Runtime-private canonical construction authority (2026-10-05)

TypeScript `private` is a source-level checking convention, not a runtime
authority boundary. In a shared process, an own or prototype property using the
same string name can shadow a TypeScript-private method. Any internal entry
that must not be redirected through such a decoy must use an ECMAScript
`#private` member, a closure, or an opaque capability; a type annotation alone
is insufficient.

The `GameSession` party-member constructor is the concrete negative control.
The string decoy remains observable, but canonical p1 construction,
`#addPartyMemberCanonical`, and `handleCreateCharacter` dispatch only through
`#createPartyMember`. Coverage must exercise all three paths, rather than just
the method declaration: construction, canonical add, and text character
creation must each remain immune to fake and throwing own/prototype shadows.

Evidence should include a red-first run against the old dispatch, a real
mutation that restores one string dispatch, and exact restoration, followed by
focused and full-suite verification. Here, old code was red at 10/10 failures;
restoring `this.createPartyMember` in only `#addPartyMemberCanonical` was red
at 4/10 failures; restored targeted sets and typecheck were green; and the
full suite was 4949 tests / 440 files / 4915 pass / 34 skip / 0 fail / 30966
assertions / 445.22s. Final standard preflight has not yet run for this slice
and the complete preflight sequence is recorded below. This bounded closure does not settle provider exactly-once,
cross-store/Career cross-file consistency, NFS/SMB, power-loss, multiwriter,
source-bound compiled-world binding, Docker/Linux/assets/deployment, or
external real-model quality.

### Final-preflight sequence (2026-10-05)

The first final standard preflight for this slice exited 1. Its sole failure
was a generated handoff sentence that named an untracked authority-regression
test file, making the document tell a fresh clone to run a path it cannot
obtain. The evidence remains specific without publishing that non-portable
path: the authority regression is 10 tests in 1 file.

All other reported preflight gates were green: 313 boolean-returning
implementations / 0 discarded returns; document checks 3 / 8 / 1 / 3;
typecheck 0; exact 4949 tests / 440 files and unwiredMethods 46 baseline
matches; and `.githooks` commit-msg enforcement active.

The corrected second preflight still exited 1. This must remain in the
evidence: its sole failure was the real `SessionNamespaceCoordinator >
serializes ordinary-vs-compiled reservations in separate processes` test,
with 4914 pass / 1 fail. The document, typecheck, unwired, and hooks gates
remained green. Focused rechecks then passed both the named case (1 pass / 0
fail / 3 assertions / exit 0) and the complete session-namespace-coordinator
file (24 pass / 0 fail / 169 assertions / exit 0).

The third final standard host preflight exited 0: 313 boolean-returning
implementations / 0 discarded returns; generated/handwritten/structured/reverse
document checks 3 / 8 / 1 / 3; internal typecheck 0; exact 4949 tests / 440
files and unwiredMethods 46 baseline matches; and `.githooks` commit-msg
enforcement active. This final green verifies the bounded authority slice only;
it is not production completion, goal completion, or evidence that the stated
provider, cross-store, crash, filesystem, deployment, or real-model boundaries
are closed.

## Runtime-private Career helpers must close the whole dispatch chain (2026-10-05)

An ECMAScript-private entry method does not automatically make its nested
helpers runtime-private. A TypeScript-private helper still has a string property
name at runtime, so an own or prototype decoy can shadow it whenever an internal
call dispatches through that name. Authority review must trace the actual chain,
not stop at the first `#` declaration.

For party-member construction, the relevant chain is
`#createPartyMember -> #persistCareerSnapshot -> #ensureCareerStore ->
#careerSessionDirectory`. The earlier `#createPartyMember` slice sealed only the
first edge; the three Career helpers remained TypeScript-private. They are now
ECMAScript `#private`, and every GameSession-internal call along the chain uses
`#` dispatch, with no new alias or public API. This supersedes the earlier
createPartyMember-only closure for this nested helper boundary; it does not
retroactively make that earlier closure proof that the helpers were sealed.

The regression verifies real effects, not just member declarations: the old
chain could leave the complete Career base absent, route an export through a
fake store, write beneath a diverted directory root, or let throwing shadows
deny construction and late add. Red-first against that implementation was
18/18 failures. Mutating only the `#createPartyMember` call to
`(this as any).persistCareerSnapshot` again made all 18/18 fail; exact
restoration was green. That mutation is evidence for the persist fake/throw
route, not three independent leaf mutations: the other shadow cases reject or
deny service at the dynamic chain entry when no `#` alias is available.

Focused evidence was Career helper authority regression 18 tests / 1 file,
career-root 5/5, Career facade/projection 8/8, and typecheck 0. Independent
controller direction was 31 tests / 4 files / 0 fail / 303 assertions. Full
`bun test` exited 0: 4967 tests / 441 files / 4933 pass / 34 skip / 0 fail /
31142 assertions / 445.92s. Final standard preflight for this superseding
helper-chain slice is pending. Provider exactly-once, cross-store/Career
cross-file consistency, NFS/SMB, power-loss, multiwriter, source-bound compiled
world binding, Docker/Linux/assets/deployment, and external real-model quality
remain open.

## Preflight test children must concurrently drain both streams (2026-10-05)

The standard preflight's full-suite child had used synchronous default-buffer
capture. Its test output could exceed that fixed buffer and turn the harness
into `ENOBUFS`, even when the child had produced a passing summary. That is not
product-test evidence, and it is not a green preflight: the failure names and
complete summary may be unavailable.

The full-test path now uses the shared asynchronous `shell:false` capture and
starts both stdout and stderr drains concurrently. It preserves the complete
text for the existing process verdict, summary, and failure-name parsers;
startup, stream, signal, or nonzero-exit errors continue to fail closed. This
is a harness transport repair, not a change to RPG execution semantics.

Evidence is intentionally separated by layer. Before the helper existed, its
focused regression exited 1 at 0 pass / 1 fail / 1 error. The old real
`spawnSync` behavior reproduced `ENOBUFS` with 1.2 MB on each stream. Restoring
that path as a real mutation made the timeout-policy focused run exit 1 at
2 pass / 1 fail; exact restoration was green. Directed capture coverage was
192 pass / 4 files / 0 fail / 574 assertions and typecheck 0. An in-sandbox
three-file invocation hit `uv_spawn` `EPERM`, which is environment evidence
only; outside the sandbox the same scope was 189 pass / 3 files / 0 fail /
559 assertions, exit 0. The root full suite was green at 4972 tests / 442
files / 4938 pass / 34 skip / 0 fail / 31208 assertions / 526.81s.

Final standard host preflight is still pending. A full-suite green is not a
substitute for that final gate, and none of this closes provider exactly-once,
cross-store/Career cross-file consistency, NFS/SMB, power-loss, multiwriter,
source-bound compiled-world binding, Docker/Linux/assets/deployment, or
external real-model quality.

## Correction: asynchronous preflight capture has its final host evidence (2026-10-05)

The preceding entry deliberately retained the distinction between a green
full-suite child and a green standard preflight. The latter has now run on the
host and exited 0: 313 boolean-returning implementations / 0 discarded
returns; generated, handwritten, structured, and reverse document checks
3 / 8 / 1 / 3; internal typecheck 0; and exact baseline matches for 4972
tests / 442 files and unwiredMethods 46. `core.hooksPath` was `.githooks`,
with the commit-msg criterion running.

That closes the known default-buffer test-child capture failure mode only. It
does not erase the earlier ENOBUFS reproduction, sandbox `uv_spawn` EPERM
environment evidence, red-first regression, mutation, or full-suite evidence;
those remain the reason this transport repair is trusted. The shared
asynchronous capture still drains stdout and stderr concurrently and fails
closed for startup, stream, signal, or nonzero-exit errors.

`todo-65` and the wider production-quality goal remain open: provider
exactly-once across post-crash/provider outcomes; cross-store and Career
cross-file consistency; NFS/SMB; power loss; multiwriter behavior;
source-bound compiled-artifact/world mapping; Docker/Linux/assets/deployment;
authorized external real-model quality; and other child, alias, and
transaction authorities are not closed by this harness slice.

`docs/notes/index.json` remains deliberately unrefreshed because parallel
edits are preserved; its index therefore does not yet contain this correction.

## Constructor installers are runtime authority, not TypeScript decoration (2026-10-05)

Compatibility slots installed during construction are part of the session's
authority boundary. A TypeScript `private` installer still has a runtime string
name, so a same-name prototype property can intercept its dynamic call before
the canonical read-only slot exists. A fake can redirect an observation; a
throw can deny construction. Checking only a final member declaration misses
that constructor-time dispatch path.

The nine GameSession installers for id, timestamps, active player, ordinary
character editor, skill-growth marks, active action transactions, durable
compiled-session status, world, and PlayerSession observations now use
ECMAScript `#private` declarations and `#` constructor dispatch. The public
slots remain sealed read-only observations; no fallback or public API was
introduced. The regression first calls each fake/throw decoy directly to prove
the decoy is real, then proves construction bypasses it and retains canonical
summary, snapshot, player/world/session, transaction, and slot-descriptor
behavior.

Evidence is bounded and explicit: the old implementation was 0 pass / 18
fail. Restoring dynamic dispatch at only the world installer made its two
decoy cases 0 pass / 2 fail; exact restoration was 18 pass / 1818 assertions.
Root typecheck exited 0, independent directed coverage was 94 pass / 9 files /
0 fail / 2225 assertions, and the full serial suite exited 0 at 4990 tests /
443 files / 4956 pass / 34 skip / 0 fail / 33015 expect calls / 530.79s.

Final standard host preflight for this newer slice is still pending. This
constructor-dispatch repair does not establish provider exactly-once,
authoritative module/artifact-to-world source binding, Docker/Linux/assets or
deployment behavior, NFS/SMB, power-loss, multiwriter, cross-store/Career
cross-file consistency, external real-model quality, Checkpoint I completion,
or production-goal completion. `docs/notes/index.json` remains deliberately
unrefreshed because parallel edits are preserved.

## Correction: constructor-installer authority has final host-preflight evidence (2026-10-05)

The preceding constructor-installer entry correctly kept its serial full-suite
result separate from the final host gate. That host `bun scripts/preflight.ts`
has now exited 0: 313 boolean-returning implementations / 0 discarded returns;
generated, handwritten, structured, and reverse document checks 3 / 8 / 1 / 3;
internal typecheck 0; exact baseline matches for 4990 tests / 443 files and
unwiredMethods 46; and `core.hooksPath` was `.githooks` with the commit-msg
criterion running.

This final gate completes only the bounded constructor-dispatch authority
slice. It preserves the red-first 0 pass / 18 fail result, the world-installer
dynamic-dispatch mutation at 0 pass / 2 fail, exact restoration, directed
coverage, and the 4990-test serial full-suite evidence; none is replaced by a
summary claim.

`todo-65`, Checkpoint I, and the wider production-quality goal remain open:
provider exactly-once across post-crash/provider outcomes; authoritative
source-bound module/artifact-to-world mapping; Docker/Linux/assets/deployment;
NFS/SMB; power loss; multiwriter behavior; cross-store and Career cross-file
consistency; authorized external real-model quality; and other child, alias,
and transaction authorities are beyond this slice. `docs/notes/index.json`
remains deliberately unrefreshed because parallel edits are preserved.

## Compiled action canonical cohorts now dispatch through runtime-private authority (2026-10-05)

Canonical compiled-action `act`, `prepare`, and `apply` paths had a runtime
authority boundary wider than their immediately visible method names: their
actual runtime and durable dependency cohort could still be reached through
same-name dynamic dispatch. Those canonical paths and reached cohorts now use
ECMAScript `#private` dispatch. A same-process own/prototype string decoy can
no longer redirect or make those paths throw. No public alias or fallback was
added.

The evidence distinguishes the former implementation, a real mutation, and
the restored result. The old implementation made the new regression exit 1 at
0 pass / 12 fail. Restoring dynamic `prepare` dispatch as a real mutation made
the same regression exit 1 at 0 pass / 12 fail. Exact restoration was 20 pass
/ 244 assertions. Independent directed coverage spanning durable, restart,
skill, projection, runtime, snapshot, process, and namespace paths was 154
tests / 10 files / 0 fail / 1339 assertions, exit 0; root typecheck exited 0;
and the legacy `this.<cohort>` call scan found 0 remaining calls. The root
full serial suite exited 0 at 5011 tests / 444 files / 4977 pass / 34 skip /
0 fail / 33284 assertions / 532.79s.

This is not a claim that every compiled-action authority is closed. Load and
install dispatch remain explicitly open. The final standard host preflight for
this newer slice is pending. Provider exactly-once, authoritative
module/artifact-to-world binding, cross-store/Career consistency,
cross-filesystem power-loss, NFS/SMB, multiwriter behavior,
Docker/Linux/assets/deployment, external real-model quality, Checkpoint I, and
the production-quality goal remain open.

## An orphaned replay-directory node reserves an ordinary session ID (2026-10-05)

Occupied-ID listing already recognized replay-directory-node artifacts, but
`isOccupied` did not. A legal session ID represented only by a matching
regular replay-directory-node file could therefore be missed by the
generation-zero save conflict path. `isOccupied` now recognizes that suffix as
occupied, so such a save refuses `ORDINARY_SNAPSHOT_CONFLICT` rather than
reusing the ID. Existing regular-file, symlink, quota, unsafe-root, and ID
validator behavior is unchanged.

Using a real temporary root, legal ID, and matching 64-hex node filename, old
behavior exited 1 at 0 pass / 1 fail / 2 expects. A real mutation that restored
the omission reproduced that red result. Exact restoration was 1 pass / 3
expects. The dedicated store coverage was 27 pass / 342 assertions and the
process-plus-namespace coverage was 28 pass / 180 assertions, all exit 0.

This closes the node-only generation-zero collision only. It does not claim
generic crash recovery, power-loss, cross-filesystem, NFS/SMB, or multiwriter
semantics; final standard host preflight remains pending. `todo-65`, Checkpoint
I, and production-quality completion remain open.

## Provider exactly-once remains an external contract boundary (2026-10-05)

`LLMLike` and `LLMClient` expose neither a stable idempotency key nor a result
lookup operation. SQLite can durably record a local lease or later receipt, but
cannot determine whether a provider executed after the request left the
process and before the result was saved. A crash in that interval therefore
cannot be closed honestly by local persistence: retry risks at-least-once
provider execution, while permanent quarantine preserves at-most-once local
admission by sacrificing automatic completion.

A production closure needs a provider contract: a client-generated operation
ID durably recorded before dispatch; provider idempotent execution for that ID
with a conflict on different request content; and a retained lookup returning
pending, succeeded with the original result, or failed. Recovery must look up
the operation before any resend and durably store the validated result. Setting
an automatic adapter to `maxAttempts: 1` would only remove its in-process
implicit retry; it is not exactly-once across the crash window. This boundary
remains open alongside authoritative world binding, cross-filesystem/power-loss
and NFS/SMB behavior, multiwriter semantics, Docker/Linux/assets/deployment,
and external real-model quality.

## Final host preflight retained one transient failure before its exact green rerun (2026-10-05)

The final standard host `bun scripts/preflight.ts` must not be summarized as a
simple retry-to-green. Its first run exited 1 with exactly one failure:
`ordinary character patch failure does not pollute its live source`. It had
4976 pass / 1 fail against the 4977-pass baseline. All other gates were green:
313 boolean-returning implementations / 0 discarded returns; generated,
handwritten, structured, and reverse document checks 3 / 8 / 1 / 3; typecheck
0; unwiredMethods 46; and `.githooks` commit-msg enforcement.

Focused follow-up kept the strict assertion intact. The named case passed alone
1/1; its complete file passed 8/8 / 113 assertions; and three consecutive
single-case reruns each passed 1/1 / 5 assertions, all exit 0. The first
preflight emitted no assertion stack, so a read-only audit could find no
specific cause. It also found no direct causal link to the compiled canonical
cohort closure or replay-directory-node occupancy fix. That absence is a
diagnostic limit, not a claim that the first failure was impossible or an
authorization to weaken the test.

The second identical standard host preflight exited 0: 313 boolean-returning
implementations / 0 discarded returns; document checks 3 / 8 / 1 / 3;
typecheck 0; exact 5011 tests / 444 files baseline; unwiredMethods 46; and
`.githooks` green. This final gate covers the two bounded closures recorded
above, but does not close `todo-65`, Checkpoint I, or the production-quality
goal. Load/install authority, provider exactly-once, authoritative
module/artifact-to-world binding, cross-store/Career and cross-filesystem
consistency, power loss, NFS/SMB, multiwriter behavior,
Docker/Linux/assets/deployment, and external real-model quality remain open.

## Correction: compiled load/install authority and auto-hint retry scope (2026-10-05)

The earlier canonical-cohort record deliberately left compiled load/install
authority unclaimed. That historical limit is now superseded narrowly:
canonical compiled load and install dispatch use ECMAScript `#private`
authority, joining the prior act/prepare/apply and reached runtime/durable
cohort closure. The 20-test install-authority regression was red against the
former implementation; a real implementation mutation restored the dynamic
route and made the intended regression red again; exact restoration was green.
No public alias or fallback was introduced.

The automatic compiler hint-proposal adapter also now sets `maxAttempts: 1` on
every chunk's `LLMLike.chat` options. The proof deliberately used a real
`LLMClient` with a local controlled-500 fetch rather than a mock that bypasses
client retry behavior. Eight one-question chunks made 16 outbound POSTs before
the change and exactly 8 after it, while the adapter retained its existing
fail-closed empty draft and per-chunk diagnostic. Removing the option as a
real mutation restored the 16-POST red result; exact restoration was green.
The ordinary `LLMClient` default retry and other callers are unchanged.

The combined directed set exited 0 at 129 tests / 11 files / 0 fail / 1034
assertions; root typecheck exited 0. Root's full serial suite exited 0 at 5032
tests / 445 files / 4998 pass / 34 skip / 0 fail / 33457 expect() calls /
545.51s. The +21 tests / +1 file increment is 20 compiled install-authority
regressions and one single-attempt adapter regression. Final standard preflight
for this post-baseline documentation state remains root-owned and pending.

This is not provider exactly-once. One adapter process makes at most one POST
per chunk, but there is still no provider idempotency key or result lookup.
SQLite cannot distinguish a provider execution from a crash after dispatch and
before local result persistence. Retry after that window remains potentially
at-least-once; permanent quarantine preserves at-most-once local admission by
trading away automatic completion. `todo-65`, Checkpoint I acceptance, and the
production-quality goal remain open, as do authoritative module-to-world
resolution, cross-store/Career and cross-filesystem consistency, NFS/SMB,
power loss, multiwriter behavior, Docker/Linux/assets/deployment, and external
real-model quality. `docs/notes/index.json` and `docs/architecture.json` are
deliberately not refreshed in this shared-worktree closeout.

## Final standard preflight verifies the 5032 / 445 baseline, not production completion (2026-10-05)

After the 5032-test full serial result and generated-document update, the host
standard `bun scripts/preflight.ts` exited 0. It reported 313 boolean
implementations / 0 discarded returns; generated documents 3, handwritten
payloads 8, structured checks 1, and reverse references 3; typecheck 0; exact
5032 tests / 445 files baseline equality; unwiredMethods 46 baseline equality;
and `core.hooksPath=.githooks`.

That final gate validates the bounded compiled load/install runtime-private
authority closure and compiler auto-hint per-chunk `maxAttempts: 1` change in
the current tree. It does not turn one local POST per chunk into provider
exactly-once, erase the provider-executed/local-result-unsaved crash window,
or complete `todo-65`, Checkpoint I acceptance, or the production-quality
goal. Authoritative module-to-world resolution, cross-store/Career and
cross-filesystem behavior, NFS/SMB, power loss, multiwriter, Docker/Linux/
assets/deployment, and external real-model quality remain open.

`docs/notes/index.json` and `docs/architecture.json` remain deliberately
unrefreshed while parallel shared-worktree changes are preserved.

## Ordinary durable model calls now bound local retry, not provider execution (2026-10-05)

KP outcome narration, NPC responses, and combat narration have a durable
failure boundary: an ambiguous provider retry must not manufacture a second
same-process POST before the durable operation can report its existing failure
semantics. Their initial calls, and combat's constrained regeneration, now
explicitly use `maxAttempts: 1`; ordinary intent already did. This is a narrow
caller policy atop the unchanged ordinary `LLMClient` default retry behavior.

The regression used a real LLMClient with local controlled 500 and AbortError
fetch paths, not a model double that skips transport retries. A trusted durable
intent failure left round, gameTime, and history unchanged. After correcting
the first expected failure code, old behavior was 1 pass / 3 fail. Removing
KP's `maxAttempts: 1` as a real mutation was 3 pass / 1 fail and made 2 POSTs;
exact restoration was green. Directed evidence was 38 tests / 6 files / 0 fail
/ 140 assertions, broader coverage was 73 tests / 11 files / 0 fail / 273
assertions, and root-independent coverage was 26 tests / 3 files / 0 fail /
267 assertions; typecheck exited 0. Root's serial full suite exited 0 at 5036
tests / 446 files / 5002 pass / 34 skip / 0 fail / 33470 expect() calls /
539.59s.

This is not provider exactly-once. It removes implicit retry only within these
process-local callers; provider execution after dispatch but before local
result persistence remains unknowable without a stable provider idempotency
key and result lookup. Retrying after that crash is still potentially
at-least-once, while permanent quarantine trades automatic completion for
at-most-once local admission. The final standard host `bun scripts/preflight.ts`
then exited 0 for the 5036 / 446 baseline: 313 boolean implementations / 0
discarded returns; generated/handwritten/structured/reverse checks 3 / 8 / 1 /
3; typecheck 0; unwiredMethods 46; and `core.hooksPath=.githooks`. That
verification does not turn this into provider exactly-once or complete a
checkpoint. `todo-65`, Checkpoint I acceptance, the production-quality goal,
authoritative module-to-world resolution, cross-store/Career and
cross-filesystem behavior, NFS/SMB, power loss, multiwriter,
Docker/Linux/assets/deployment, and external real-model quality remain open.
`docs/notes/index.json` and `docs/architecture.json` remain deliberately
unrefreshed.

## Production world-model binding is an issuance authority (2026-10-06)

A compiled world-model resolver is not production wiring until the host owns
the policy that creates its bindings. The production main now loads an atomic
pair of startup configuration: a bounded policy file and the separately
configured Cthulhu dataset root. Both absent or blank means disabled; supplying
only one, or supplying malformed, oversized, non-UTF-8, non-regular,
symlinked, replaced, grown, duplicate, noncanonical, or invalid-scope policy
input fails startup before namespace creation/inventory, hydration, provider
setup, timers, or listening.

The policy binds exact `(moduleId, artifactHash)` tuples. It contains no
dataset-root field, and each entry is minted through the existing
`createCompiledCthulhuWorldModelBinding` validator, so the manifest hashes,
actual dataset bytes, work/corpus scope, transfer policy, and binding hash keep
their existing authority. Missing or mismatched tuples resolve to no binding;
module-only inheritance would let a different PDF reuse a lore scope and is
therefore forbidden. Requests, PDF content, compiler hints, module data, and
LLM output cannot select the policy, root, works, or transfer policy.

Catalog publication is the issuance point. A bound bundle carries its binding
through action replacement and restart without consulting a mutable current
policy; this is deliberate issuance-time authorization, not hot revocation.
Operators may first publish an unbound deterministic artifact to learn its
hash, add that exact tuple to the reviewed policy, restart, and publish a new
bound bundle. Binding content participates in the immutable bundle identity,
so the two publications do not overwrite each other.

The real-main HTTP acceptance starts the production entrypoint, observes only
safe operator status, publishes a loose-create artifact, and reads the exact
binding back from the real default catalog. HTTP/config responses contain no
policy path, dataset root, module, work scope, or raw binding. Initial registry
coverage was red because the module did not exist. Four implementation
mutations independently exited 1 and were restored: deleting main resolver
injection, changing lookup to module-only, silently disabling half-configured
input, and deleting duplicate-tuple rejection. Root directed coverage exited
0 at 30 tests / 6 files / 201 assertions; independent review and 6 Docker
contract tests passed; typecheck exited 0. The authoritative full suite exited
0 at 5206 tests / 472 files / 5171 pass / 35 skip / 0 fail / 34344 assertions
in 463.77 seconds, +6 tests / +1 file / +6 pass with skip unchanged.

The first standard preflight then completed typecheck, the full 5206-test
suite, exact unwired count 46, document references, and hooks checks, but
exited 1 on four false dropped-return findings. The registry's boolean helper
was named `blank`, so the repository-wide name scan confused it with the
existing void lexical-mask helper `blank` in `source-scan.ts`. The scanner was
not relaxed: the registry predicate became `isBlankConfigValue`, and a
real-source regression test reproduced the four findings before the rename.
The final combined diagnostic/registry run was 114 pass / 2 files / 211
assertions, typecheck exited 0, and the stable standard preflight exited 0 at
325 boolean implementations / 0 discarded returns, references 3 / 8 / 1 / 3,
5207 tests / 472 files / 5172 pass / 35 skip / 0 fail, unwiredMethods 46, and
`core.hooksPath=.githooks`.

After the result was written and generated documents were refreshed, one
standard preflight produced a single failure in the existing missing-CON head
critical case. It did not reproduce in 20 isolated repetitions, 10 neighboring
suite repetitions, an independent adjacent four-suite serial run, or a full
serial rerun. The latter exited 0 at 5207 tests / 472 files / 5172 pass / 35
skip / 0 fail / 34316 assertions in 552.39 seconds, and the following standard
preflight also exited 0 with the same 325 / 0 boolean, 3 / 8 / 1 / 3 reference,
typecheck, 5207 / 472 baseline, unwired 46, and `.githooks` results. No
reproducible product or isolation defect justified changing runtime semantics
or weakening the assertion; the isolated failure remains explicit negative
evidence to monitor.

This closes production-main issuance for the current source-bound Cthulhu
dataset, not the broader production-quality objective. Actual Docker/Linux
image execution, read-only bind mounts, assets/deployment, policy hot
revocation, other world-model registries, provider exactly-once, NFS/SMB,
power-loss, multiwriter, and external real-model/source-document quality remain
open. `docs/notes/index.json` and `docs/architecture.json` remain deliberately
unrefreshed to preserve parallel changes.

## Legacy ordinary runtime install/restore/projection is now canonical-private (2026-10-05)

Legacy ordinary canonical load, generated-load, restore, and projection paths
had retained public or TypeScript-private compatibility wrappers whose
same-name own/prototype properties could redirect a canonical path, forge a
successful empty projection, or throw to deny service. The actual reached
origin/pickup/ModuleData/Mythos-NPC/clue/tome helper cohort is now internally
direct through ECMAScript `#private` authority. This does not add a public
fallback. An origin already containing an item still cannot bypass admission,
and rehashed scene/pickup forgeries remain rejected.

The new focused regression was 0 pass / 24 fail on the old implementation.
Three real mutations each returned the expected four-assertion red result:
dynamic `handleLoadModule` dispatch, dynamic restore static assertion, and
dynamic runtime-origin dispatch. Exact restoration was green. Related
regressions were 123 / 123; typecheck exited 0; the 13 target-helper dynamic
`this` call scan was 0; and independent root coverage was 58 tests / 4 files /
0 fail / 299 assertions. That first implementation then exposed a preflight
signal that must not be hidden; the corrected final full-suite evidence is
recorded below.

This closes legacy ordinary canonical install/restore/projection runtime
string-shadow authority only. It does not establish standalone legacy
loader/host trust, provider exactly-once, authoritative module-to-world
binding, cross-store/Career or cross-filesystem semantics, NFS/SMB, power-loss,
multiwriter, Docker/Linux/assets/deployment, or external real-model quality.
`todo-65`, Checkpoint I acceptance, and the production-quality goal remain
open. Final standard preflight for the 5060 / 447 baseline is root-owned and
pending. `docs/notes/index.json` and `docs/architecture.json` remain
deliberately unrefreshed.

## Correction: remove all legacy compatibility wrappers after unwired preflight red (2026-10-05)

The first standard preflight for the legacy ordinary authority slice exited 1.
Typecheck was 0, the 5060 / 447 test baseline was green, and document checks
were green, but unwiredMethods rose from 46 to 57. The cause was concrete: 11
of the 13 newly retained compatibility wrappers had no callers. This red gate
is retained as evidence, not treated as a flaky or unrelated result.

The correction deletes all 13 wrappers and retains only ECMAScript `#private`
canonical dispatch. The focused decoy-call count is 0. Invalid runtime package
coverage uses the public `assertRuntimeModulePackage`; the pre-character pickup
fixture constructs and re-signs through a public empty snapshot plus
public-loaded package statics, passes the existing validator, and adds neither
a production test interface nor a validator relaxation. The three no-wrapper
mutations—dynamic `handleLoadModule`, restore static assertion, and runtime
origin dispatch—each remain 4 / 4 red; exact restoration is green.

The agent probe returned unwiredMethods 46 and directed coverage 56. Root's
13-name dynamic-`this` scan was 0; its probe exited 0 at 46 / 74 / 36; its
directed coverage was 69 tests / 5 files / 0 fail / 380 assertions; and
typecheck exited 0. The corrected root serial full suite exited 0: 5060 tests
/ 447 files / 5026 pass / 34 skip / 0 fail / 33603 expect() calls / 545.75s.
The corrected final standard host `bun scripts/preflight.ts` then exited 0:
313 boolean implementations / 0 discarded returns; generated/handwritten/
structured/reverse checks 3 / 8 / 1 / 3; typecheck 0; exact 5060 / 447 test
baseline; unwiredMethods 46 baseline; and `core.hooksPath=.githooks`.

This correction still closes only legacy ordinary canonical
install/restore/projection runtime string-shadow authority. Standalone legacy
loader/host trust, provider exactly-once, authoritative module-to-world
binding, cross-store/Career and cross-filesystem behavior, NFS/SMB, power loss,
multiwriter, Docker/Linux/assets/deployment, and external real-model quality
remain open. `todo-65`, Checkpoint I acceptance, and the production-quality
goal remain open; `docs/notes/index.json` and `docs/architecture.json` remain
deliberately unrefreshed. The final green gate verifies the bounded correction;
it does not erase the earlier 57-unwired red result or complete any goal.

## Recovery/library reachability is not successful companion command execution (2026-10-05)

A restored companion may be reachable through the recovery/library state while being
inactive. This is deliberately distinct from successful command execution. Command
identity resolution must include that restored record so it can receive its defined
inactive response, but control and departure must preserve their real false result.
Otherwise active-only lookup or a discarded return value manufactures a player-visible
success from a command that did not take effect.

The repair is in src/api/game-session.ts and src/combat/companion-manager.ts; the
new regression is src/__tests__/companion-restored-inactive-command.test.ts. The old
implementation was 0 pass / 4 fail. Restoring active-only findCompanionId lookup,
ignoring setControl's return, or ignoring handleDeparture's return independently made
the focused mutation 0 pass / 1 fail; exact restoration was green. Terra directed
verification was 95 pass / 8 files / 692 assertions, root directed verification was
29 pass / 4 files / 143 assertions, typecheck exited 0, and the direct probe was 46
no callers / 74 test-only / 36 should-private. The authoritative full bun test exited
0: 5064 tests / 448 files / 5030 pass / 34 skip / 0 fail / 33694 expect calls /
431.39s.

The boundary is narrow: it closes recovery/library-reachable inactive companion
command response truthfulness only. Normal new sessions have no production recruit
caller, complete companion gameplay remains unwired, and same-process prototype
monkeypatching remains unclosed. A public snapshot hash is integrity validation, not
a signature. todo-65 and the production-quality goal stay open. Concurrent
docs/notes/index.json and docs/architecture.json are deliberately not refreshed.

## SAN canonical helpers must be lexical-private, and invalid therapy rolls must not mutate (2026-10-05)

The six GameSession SAN helpers `#recoverSan`, `#rollNightmare`,
`#triggerIrreversibleChange`, `#getIndefiniteGuidance`, `#getPhobiaGuidance`,
and `#getManiaGuidance` are lexical ECMAScript-private helpers: there is no
old compatibility wrapper to dispatch through an own or prototype same-name
property. The constructor also defines its `sanity` getter as a
non-configurable own accessor. This preserves the public observation path
without allowing a caller to replace the canonical helper route or define an
own `sanity` property over it.

`therapyCheck` validates roll 1..100 and skill 0..100 before state work. -1
and 101 are rejected with state and revision unchanged. Test migration retains
the public-path contract; it does not invent a test-only mutation seam.

Before the repair, own/prototype helper decoys were 0 pass / 1 fail and own
`sanity` define was 2 pass / 1 fail. Restoring dynamic `recoverSan` dispatch
was 0 pass / 1 fail; removing the constructor accessor was 2 pass / 1 fail;
and each invalid therapy input was red before correction. A 30s-to-20s
preflight-policy mutation was 2 pass / 1 fail. Every mutation was exactly
restored. Root SAN-directed evidence was 131 pass / 4 files / 2597
assertions; timeout-policy plus diagnostics evidence was 112 pass / 2 files /
197 assertions; typecheck exited 0; and the direct probe was 46 no callers /
74 test-only / 30 should-private.

The first SAN full run had one old active-switch own-property *shape*
assertion failure. It is retained, did not lower the baseline, and is not an
implementation-regression claim. Independent public-semantics coverage then
made the actual baseline increment +2 tests / +1 file. Likewise, default
parallel 5-second world/intent resource timeouts and later preflight
CAS/200-receipt pressure timeouts are policy diagnostics, not green evidence
or implementation failures. The 200-receipt case already has an explicit
30_000 ms contract, so a CLI-wide 20s setting must not override it. The final
preflight policy is bounded 30000 ms / parallel=1 / captureProcess, with no
retry or Infinity. Its authoritative full run, `bun test --parallel=1
--timeout 30000`, exited 0: 5066 tests / 449 files / 5032 pass / 34 skip /
0 fail / 33683 expect calls / 972.81s.

This closes only named SAN helper string-shadow dispatch, the constructor
getter, and invalid therapy-input immutability. It does not protect public
`SanityEngine.sanityCheck`/`applyLoss` or other public methods from prototype
replacement; same-process prototype monkeypatching remains open. Companion
gameplay still has no production recruit caller. `todo-65` and the
production-quality goal remain open. The earlier accidental notes-index
refresh plus parallel edits make `docs/notes/index.json` stale/unattributable;
it is not refreshed by this record, and `docs/architecture.json` remains
untouched.

## Correction: SAN final preflight retains the first non-green gate (2026-10-05)

After the 5066 / 449 / 5032 / 34 baseline update, the first standard
`bun scripts/preflight.ts` exited 1. It had exactly one failure:
`ordinary action serialization > rejects a direct scene ABA attempt while the
staged successor remains valid`; its 5031 pass result did not meet the 5032
baseline. Typecheck, document checks, `unwiredMethods=46`, and hooks were
otherwise green. This is retained as a non-green gate, not relabelled as an
implementation regression and not erased by later evidence.

Diagnosis was bounded and did not change production code, test assertions,
or retry policy. The entire ordinary-session-action-concurrency file under
`bun test --parallel=1 --timeout 30000` exited 0 at 35 pass / 1 file / 221
expect calls / 17.72s; the target took 3.14198s. The target with
`--rerun-each=5` exited 0 at 5 pass / 170 filtered / 0 fail / 65 expect
calls, with individual runs 2.28–2.61s. These focused executions found no
stable implementation failure. They are diagnostic evidence, not an
automatic retry or a substitute green standard gate.

A second independent standard `bun scripts/preflight.ts` exited 0: 315
boolean-returning implementations / 0 discarded returns; generated,
handwritten, structured, and section references 3 / 8 / 1 / 3; internal
typecheck 0; exact 5066 tests / 449 files baseline; exact
`unwiredMethods=46`; and `core.hooksPath=.githooks`. This validates the
current SAN slice and its preflight policy only. It does not close public
`SanityEngine` prototype replacement, same-process prototype monkeypatching,
the missing companion production recruit caller, `todo-65`, or the
production-quality goal. The accidental notes-index refresh remains
stale/unattributable under parallel changes; it is not refreshed here.

## SanityEngine class authority needs both prototype and constructor frozen (2026-10-05)

The `SanityEngine` constructor and `SanityEngine.prototype` are frozen, with
no retained mutable wrapper. The pair matters: freezing only the prototype
still leaves class-level constructor/static replacement surface, while freezing
only the constructor leaves prototype method definitions writable. This closes
the named class-level route by which a same-process caller could replace SAN
method definitions after initialization.

The old implementation was 1 pass / 2 fail / 23 expect calls / exit 1.
Removing prototype freeze was 2 pass / 3 fail / 37 expect calls / exit 1;
removing constructor freeze was 2 pass / 1 fail / 23 expect calls / exit 1.
Exact restoration was green. Root SAN-directed verification was 134 pass /
0 fail / 2620 expect calls / exit 0; typecheck exited 0; and the direct
probe was 46 no callers / 74 test-only / 30 should-private. The authoritative
full `bun test --parallel=1 --timeout 30000` exited 0: 5069 tests / 450
files / 5035 pass / 34 skip / 0 fail / 33727 expect calls / 460.79s.

This is a +3 tests / +1 file / +3 pass baseline change over 5066 / 449 /
5032 / 34. No standard preflight is claimed. Freezing this class-level
surface does not make public `SanityEngine` methods private, prove safety
against instance-level or unrelated same-process monkeypatching, or close
other authority boundaries. The companion production recruit caller remains
absent; `todo-65` and the production-quality goal remain open. The earlier
notes-index refresh is still stale/unattributable under parallel edits and is
not refreshed here.

## Correction: class-authority preflight first failed the static comment rule (2026-10-05)

The first final standard `bun scripts/preflight.ts` for the SAN
class-authority slice exited 1, but not for a freeze or runtime failure. In
`src/rules/coc-engine.ts`, the top-level `/** */` JSDoc immediately before
the two freezes left a direct statement after it. `findTruncatedBlocks`
conservatively treats that layout as a potentially cut function header.
Internal typecheck was 0; the 5069-test / 450-file baseline,
`unwiredMethods=46`, document checks, and hooks were otherwise green.

The correction changed only the JSDoc to contiguous `//` lines. Both freezes
and their runtime meaning are unchanged. Agent directed evidence was 5 pass /
0 fail / 51 expect calls with typecheck 0; root independently obtained the
same 5 / 0 / 51. This is a deterministic static-rule correction, not a
runtime regression diagnosis.

The second standard `bun scripts/preflight.ts` then exited 0: 315
boolean-returning implementations / 0 discarded returns; generated,
handwritten, structured, and section references 3 / 8 / 1 / 3; typecheck
0; exact 5069 tests / 450 files baseline; exact `unwiredMethods=46`; and
`core.hooksPath=.githooks`. It verifies the corrected static rule. It is not
an automatic retry. `todo-65` and the production-quality goal remain open;
the notes-index record remains stale/unattributable and is not refreshed.

## P2 Docker healthcheck is liveness, not readiness (2026-10-05)

Docker now has one exec-form Bun `HEALTHCHECK`: interval 30s, timeout 5s,
start-period 20s, and retries 3. It runs the internal
`src/api/container-healthcheck.ts`, which gives its loopback `GET /api` four
seconds and exits 0 only when strict `PORT` (1..65535) yields a 2xx JSON
`status: ok` response. Every other result silently exits 1. It adds neither
an HTTP API nor curl/wget/shell dependencies.

The old behavior was 3 pass / 6 fail / 21 assertions / exit 1. Deleting the
healthcheck was 3 pass / 1 fail / 8 assertions / exit 1; accepting arbitrary
200 was 4 pass / 1 fail / 13 assertions / exit 1; exact restoration was
green. Agent-directed verification was 15 pass / 0 fail / 76 assertions,
and root-directed verification was 19 pass / 6 files / 0 fail / 145
assertions. Typecheck exited 0 and the direct probe was 46 no callers / 74
test-only / 30 should-private. The authoritative full
`bun test --parallel=1 --timeout 30000` exited 0: 5075 tests / 451 files /
5041 pass / 34 skip / 0 fail / 33733 expect calls / 462.98s.

This does not make the container ready for traffic: it proves neither world
or staged-asset availability nor LLM availability. Docker image/Linux-native
execution, staged assets, runtime UID/volume ownership, audio, and
reverse-proxy/TLS behavior remain unverified. The frontend production build
was re-run on the host (Vite 6.4.3 / 33 modules / 862ms); the earlier sandbox
esbuild spawn EPERM was not a product build failure, and the host build is
not image-build evidence. No standard preflight is claimed. `todo-65` and
the production-quality goal remain open; the notes-index record stays
stale/unattributable and is not refreshed.

## P2 liveness preflight is green; the image environment remains absent (2026-10-05)

The P2 liveness repository contract now has a green standard
`bun scripts/preflight.ts`: 315 boolean-returning implementations / 0
discarded returns; generated, handwritten, structured, and section
references 3 / 8 / 1 / 3; internal typecheck 0; exact 5075 tests / 451
files baseline; exact `unwiredMethods=46`; and `core.hooksPath=.githooks`.

That result is not image evidence. A subsequent read-only environment check
exited 0 while reporting `DockerCommand` missing, `assets` directory false,
and both required model files false. No Docker image pull/build or Linux
validation ran. This leaves the preflight counters unchanged and keeps real
Docker/Linux execution, staged assets, runtime UID/volume behavior, audio,
and proxy/TLS open. `todo-65` and the production-quality goal remain open;
the notes-index record stays stale/unattributable and is not refreshed.

## Docker non-root runtime owns only the image data directory (2026-10-05)

The precise `oven/bun:bun-v1.3.14-debian-slim` base creates `bun` as
UID/GID 1000 but specifies no `USER`, so the earlier final image ran as root.
The Dockerfile now creates and chowns `/app/data` to `bun:bun` before
`VOLUME`, then has one `USER bun` before the existing healthcheck and CMD.
It deliberately does not chown `/app`, add a root fallback/init path, or
alter compose. Server persistence defaults to `/app/data`; the healthcheck
is read-only.

The old implementation was 4 pass / 1 fail / 11 assertions / exit 1.
Deleting USER was 4 pass / 1 fail / 13 assertions / exit 1; putting USER
after a root directive was 4 pass / 1 fail / 20 assertions / exit 1; and
deleting the data chown was 4 pass / 1 fail / 11 assertions / exit 1. Each
mutation was exactly restored. Agent and root directed verification each
exited 0 at 47 pass / 0 fail / 418 assertions; typecheck exited 0; direct
probe was 46 no callers / 74 test-only / 30 should-private. The authoritative
full `bun test --parallel=1 --timeout 30000` exited 0: 5076 tests / 451
files / 5042 pass / 34 skip / 0 fail / 33756 expect calls / 503.07s.

The image can make a fresh local named volume compatible with its directory
ownership; it cannot safely repair every pre-existing mount. A root-owned
`trpg_data` volume needs an operator-confirmed stop, backup, and one-time
recursive UID/GID 1000 migration. Bind mounts, NFS/SMB, external drivers,
and user namespaces must instead be made writable by their host/driver.
Any persistence root overridden outside `/app/data` needs the same prior
write permission. CLI play logs and analysis are outside the server-image
promise. Docker/image/Linux/volume migration was not run because Docker is
missing and assets are absent; no standard preflight is claimed. `todo-65`
and the production-quality goal remain open, and notes-index remains
stale/unattributable and unrefreshed.

## Correction: Docker P2 preflight saw a changing parallel test-discovery set (2026-10-05)

The first final Docker P2 standard preflight exited 1 even though internal
typecheck, documents, `unwiredMethods=46`, and hooks were green. It found
5075 tests / 5041 pass / 34 skip / 0 fail while the baseline was already
5076 / 5042 / 34. That non-green gate is retained; it is not discarded as a
flaky Docker or test-parser result.

The worktree changed during diagnosis. Parallel source-research work modified
`reviewed-source-query-adapter` and `source-research-facade` at 05:08, then
at 05:31 added/changed `source-adapter-isolation.test.ts` and added
`source-research-http.test.ts`. A JUnit run exited 0 at 5082 tests / 452
files / 5047 pass / 35 skip / 0 fail / 33756 assertions / 498.10s. Its
discovery included the two `source-adapter-isolation` tests but missed the
seven concurrently introduced `source-research-http` tests. This is evidence
of a changing test set, not random parser omission. The related five files
were 33 tests / 32 pass / 1 skip / 0 fail / 100 assertions; the two final
new files were 9 pass / 0 fail / 29 assertions.

Once that set stopped changing, pre- and post-run manifests were identical:
453 files, 5,380,568 bytes, SHA-256
`81c039e1683ca7182e449d0fb0679b5ae98330a7ed786872a665f2bcbfe621ac`.
The authoritative full `bun test` then exited 0 at 5089 tests / 453 files /
5054 pass / 35 skip / 0 fail / 33784 assertions / 410.22s. The baseline now
matches that stable set. A final standard preflight after this baseline update
remains pending. This correction changes no Docker claim: image/Linux,
assets, and volume migration remain unverified; `todo-65` and the
production-quality goal remain open. Notes index remains stale/unattributable
and unrefreshed.

## Listener teardown guard: stable baseline after a moving-worktree audit (2026-10-05)

The listener teardown guard adds two tests in one test file. Against the old
implementation, its focused regression exited 1 at 1 pass / 1 fail / 2
assertions and enumerated ten bare `stop` calls. Reintroducing the
access-control bare-stop mutation was the same 1 pass / 1 fail / 2
assertions / exit-1 result; the implementation was then exactly restored.
Terra-directed evidence was 42 pass / 659 assertions, typecheck 0, and the
direct probe at 46 no callers / 74 test-only / 30 should-private. Root
independently recorded 42 pass / 6 files / 659 assertions / exit 0.

The initial sandbox combined invocation hit `uv_spawn EPERM`. A subsequently
permitted subprocess rerun was green; that is a sandbox/process boundary,
not evidence of a product failure. The next authority full run also exited 0
at 5091 tests / 454 files / 5056 pass / 35 skip / 0 fail / 33806 assertions
/ 501.42s, but it cannot define a final baseline: parallel work added
`source-publication-decision.ts` and its test while that run was in progress.
The new test itself was directed at 6 pass / 0 fail / 16 assertions.

After the test set stopped changing, the authoritative full
`bun test --parallel=1 --timeout 30000` exited 0 at 5097 tests / 455 files /
5062 pass / 35 skip / 0 fail / 33842 assertions / 600.31s. This is the
updated baseline. Its input hash changed afterward only as parallel
`.env.example` and source-research deployment-document work landed; test-file
and source counts did not change. The direct consumers
`docker-runtime`, `source-research-http`, and `source-publication-decision`
then jointly passed 18 / 0 / 75, followed by observation with no further
writes.

The final standard preflight after this baseline update remains a root action.
Earlier preflight's two compiled failures did not recur. The moving worktree
and an unawaited teardown are recorded as possibilities, but this does not
claim teardown as their determined root cause. Graceful shutdown remains the
next P2. Docker/Linux/assets/volume migration remains unverified; `todo-65`
and the production-quality goal remain open. The notes index remains
stale/unattributable and is not refreshed.

## P2 graceful shutdown: code-level fail-closed contract, not deployment proof (2026-10-05)

This supersedes the earlier planning note that graceful shutdown was the next
P2: its code-level slice is now covered, while the deployment boundary is
still open. Shutdown first closes the request gate with 503, runs
`stop(false)` and a WebSocket close-code-1001 first sweep, and then gives
listener close plus in-flight drain one shared ten-second window. It performs
a second WebSocket sweep afterward. Only complete success deduplicates and
closes sessions. Any timeout, listener-close failure, or WebSocket-close
failure is fail-closed: sessions remain and the signal path exits 1. The
successful terminal path relies on natural process exit; it never forces
`exit(0)`.

Controller old/order behavior was 0 pass / 2 fail / 1 error / exit 1, while
the bad-ordering mutation was 4 pass / 2 fail / 26 assertions; the existing
gate, drain, and idempotence mutations remained red. The combined
reject-plus-WebSocket-throw fix was first 6 pass / 1 fail / 36 assertions /
exit 1; removing immediate error normalization was 5 pass / 2 fail / 30
assertions / exit 1. After exact restoration, the related eight-file root run
was 26 pass / 162 assertions / exit 0.

The real WebSocket helper had been swallowing individual close errors. It now
attempts every close before raising `AggregateError`; the controller returns
`websocket_close_failed` and retains sessions. Both the old implementation
and the swallow-error mutation were 7 pass / 2 fail / 42 assertions / exit
1. The root final helper verification was 14 pass / 3 files / 69 assertions
/ exit 0. Compose now declares `stop_signal: SIGTERM` and
`stop_grace_period: 20s`, deliberately longer than the application ten-second
budget. The old configuration was 5 pass / 1 fail / 24 assertions / exit 1;
mutating 20 seconds to 10 seconds was 5 pass / 1 fail / 25 assertions / exit
1. Root Docker/health/shutdown coverage was 19 pass / 4 files / 91 assertions
/ exit 0, and root typecheck exited 0.

The authoritative full `bun test --parallel=1 --timeout 30000` exited 0 at
5110 tests / 457 files / 5075 pass / 35 skip / 0 fail / 33876 assertions /
525.55s, an uplift of 13 tests / 2 files / 13 pass from 5097 / 455 / 5062 /
35. Test-input metadata was unchanged before and after: 788 files,
11,629,500 bytes, SHA-256
`2b76935204be0bd1e8bf6de5d8e5119f0bb30bfc6b5434ae27d6d9f66e102b5d`.
`unwiredMethods` remains 46. Standard preflight after this update is still a
root action.

Docker was not installed or run. Linux/PID 1, `docker stop`, actual
in-flight-plus-WebSocket drain, and normal stop without restart are therefore
unverified; assets and volume migration also remain unverified. The ten
seconds are best-effort only: legal 15-second body/intent work and 120-second
auto-compile work can outlive it, after which recovery is crash-like. This
does not close `todo-65` or the production-quality goal. Notes index remains
stale/unattributable and is not refreshed.

### Final preflight correction

The prior “final standard preflight remains a root action” wording for this
slice is now superseded. Root ran standard `bun scripts/preflight.ts` on
stable documentation/code input and it exited 0. Input metadata was identical
before and after: 887 files / 15,218,272 bytes / SHA-256
`e8f03e9bc7bb33e99d11f5aaae00f59c955485038a3efd6f906eef2d542dab7b`.
The gate reported 315 boolean-returning implementations / 0 discarded returns;
generated/handwritten/structured/section document refs 3 / 8 / 1 / 3;
internal typecheck exit 0; exact 5110 tests / 457 files baseline; exact
`unwiredMethods=46`; and `core.hooksPath=.githooks`.

This corrects the repository-gate status only. It does not make Docker/Linux,
PID 1, `docker stop`, actual in-flight-plus-WebSocket drain, normal stop
without restart, staged assets, or volume migration verified. `todo-65` and
the production-quality goal remain open; notes index remains
stale/unattributable and is not refreshed.

## Runtime configuration must govern behavior, not only presentation (2026-10-05)

The server previously advertised `SESSION_TIMEOUT_MINUTES` through
`/api/config` while ordinary cleanup still used a fixed 30-minute constant;
similarly, `parseInt` let a malformed `PORT=0junk` reach real startup even
though the container healthcheck rejected it. A configuration display is not
evidence that the value is wired into behavior. The repair parses one strict
runtime configuration before inventory validation or listener creation, then
uses that same authority for listener binding, startup logging, ordinary
session expiry, operator-visible configuration, and healthcheck parsing.
`PORT` is an exact decimal integer in 1..65535, and
`SESSION_TIMEOUT_MINUTES` is a positive safe integer with a safe millisecond
conversion. Compose forwards the timeout explicitly.

Deployment mode is also an authority boundary. A negative check such as
`NODE_ENV !== "production"` makes unset, misspelled, staging, and case-varied
production values inherit development escape hatches. Anonymous ordinary
access and deterministic intent fallback are now available only under exact
`development` or `test`; every other value fails closed. Direct `/api/config`
inspection remains behind operator authorization, and invalid host
configuration yields one opaque 503 rather than leaking the bad value.

The startup-order proof uses a real main-process child marker: invalid
configuration is rejected before inventory or listen work. The cleanup proof
uses a real idle-session fixture, so `SESSION_TIMEOUT_MINUTES=1` removes a
two-minute-idle session rather than merely changing a reported number. These
fixtures distinguish behavior wiring from source-string or response-shape
claims. The initial focused set was 1 pass / 4 fail. Real regressions for the
old non-production escape check, permissive `parseInt` port, and fixed
30-minute cleanup each exited 1; exact restoration was green. Directed
verification was 64 pass / 10 files / 637 assertions, the main-child check
was 2 pass / 6 assertions, and typecheck exited 0.

The authoritative serial suite exited 0 at 5121 tests / 459 files / 5086
pass / 35 skip / 0 fail / 33940 assertions / 521.76s, an increase of 11 tests
and two files with skip unchanged. This closes the named configuration
split-brain only. Ordinary-session creation cost/concurrency admission,
WebSocket connection cardinality, provider-error sanitization, and actual
Docker/Linux/PID1/assets/volume validation remain open, along with broader
durability and authority boundaries. `todo-65` and the production-quality
goal remain open. `docs/notes/index.json` is deliberately not refreshed;
`docs/architecture.json` is likewise deferred because the available split
generator would also overwrite the parallel index, todo, and note files.

### Final preflight correction

The pending standard-preflight wording for this runtime-configuration slice
is now superseded. Root ran `bun scripts/preflight.ts` after the baseline and
document update; it exited 0 with 316 boolean-returning implementations / 0
discarded returns, generated/handwritten/structured/section references 3 / 8
/ 1 / 3, internal typecheck 0, exact 5121 tests / 459 files baseline, exact
`unwiredMethods=46`, and `core.hooksPath=.githooks`.

This verifies the bounded repository contract and does not change the open
scope above. `todo-65` and the production-quality goal remain open, and no
Docker/Linux/PID1/assets/volume deployment evidence is inferred. The
parallel `docs/notes/index.json` and `docs/architecture.json` remain
deliberately unrefreshed.

## WebSocket admission must reserve before upgrade and release by socket identity (2026-10-05)

Ordinary WebSocket admission is now explicitly process-local and bounded.
Strict startup parsing supplies defaults of 512 global, four per session, and
32 per principal. After durable authorization and before `upgrade`, admission
reserves against both pending reservations and open sockets. A host principal
is keyed by role plus id; the explicitly enabled development-anonymous path
uses one fixed sentinel. Saturation returns one opaque 429 response with
`Retry-After`, so per-session and per-principal details do not become an
enumeration channel.

The reservation is an opaque, non-enumerable TTL lease. `upgrade` false or
throw releases it; successful open consumes it; limit failure closes with
1013; and close release is idempotent. Shutdown first drains admission, then
begins the existing WebSocket close sweep. The important correction is that
release authority belongs to the socket that completed the successful-open
transition, not merely to a replayable lease-shaped value. The earlier unified
release path let an old open replay free capacity still held by a live socket.
A WeakSet now restricts close release to successfully opened sockets.

The old direct-upgrade path was red at 5 pass / 1 fail / 37 assertions. Real
mutations for excluding reserved leases from counts, deleting upgrade-failure
release, deleting the shutdown fence, and restoring unified replay release
were respectively 9 pass / 4 fail, 12 / 1, 21 / 2, and 12 / 1; every run
exited 1 and was exactly restored. Root directed verification exited 0 at 57
pass / 11 files / 423 assertions, typecheck exited 0, and review passed. A
real-main development-anonymous max=1 fixture rejected its second handshake
and allowed reconnect only after the real `onclose`. Existing owner-auth
coverage proves required owner authorization and opaque ordering; a complete
required-mode real-main header E2E remains a useful strengthening boundary,
not an identified wiring defect.

The authoritative serial suite exited 0 at 5137 tests / 461 files / 5102
pass / 35 skip / 0 fail / 34007 assertions / 518.65s, an increase of 16
tests and two files with skip unchanged. This is not distributed quota or
production completion. Ordinary session creation still lacks cross-process
provider-before-work admission; provider error-text sanitization and actual
Docker/Linux/PID1/assets/volume deployment validation remain open.
`todo-65` and the production-quality goal remain open. Standard preflight is
corrected below. The parallel `docs/notes/index.json` and
`docs/architecture.json` remain deliberately unrefreshed.

### Final preflight correction

The first standard `bun scripts/preflight.ts` for this WebSocket admission
slice exited 1. Its 5137 tests / 461 files baseline, internal typecheck 0, and
`unwiredMethods=46` were green, but the boolean-return scan reported three
sites. The new admission `open(): boolean` name globally contaminated two
existing SQLite `open().run` sites, while one admission release result was
genuinely ignored. This result is retained as a failed gate rather than
discarded as scanner noise.

The scanner and existing coordinator were not weakened. The admission API was
renamed to `activateReservedLease` and `releaseLease`; a wrongly bound release
is now a hard invariant, while expected idempotent race outcomes explicitly
discard their boolean with `void`. Restoring the old `open` name as a static
mutation made quick preflight exit 1 with exactly the two name-collision false
positives. Exact restoration gave root directed verification of 15 pass / 3
files / 95 assertions and typecheck 0.

The second standard preflight exited 0: 319 boolean-returning implementations
/ 0 discarded returns; generated/handwritten/structured/section references
3 / 8 / 1 / 3; internal typecheck 0; exact 5137 tests / 461 files baseline;
exact `unwiredMethods=46`; and `core.hooksPath=.githooks`. This corrects the
repository gate only. The open production boundaries above, `todo-65`, and
the production-quality goal remain open. `docs/notes/index.json` and
`docs/architecture.json` remain deliberately unrefreshed.

## Opening fallback must be structured internally and opaque publicly (2026-10-05)

Ordinary `POST /api/sessions` now separates a real request-signal abort from
a provider failure that merely resembles one. A genuinely aborted request is
still 408 and publishes neither snapshot nor registry entry. Any other
opening failure—including a provider-created `AbortError` while the request
signal remains live—uses the fixed `ORDINARY_OPENING_FALLBACK`, persists
generation zero, and returns 201 fallback. Persistence failure retains its
own original error. No public response reflects provider message, name,
stack, cause, status, body, URL, model, path, or request-id. Ready responses
carry `openingStatus=ready` without an opening code; fallback responses carry
`openingStatus=fallback` and `ORDINARY_OPENING_UNAVAILABLE`.

The internal contract had to remain structured without breaking the existing
host seam. `KPAgent.describeSceneResult` reports structured provider status;
GameSession uses a private structured helper and keeps `getOpeningScene` as
the compatible observer, passing state once in the same call. Server
continues through that old string seam, so factory overrides are not bypassed
and CLI/direct callers remain compatible. Provider warnings are a fixed safe
event with no `err` field. The real GameSession→KPAgent→LLMClient coverage
used local fake fetch and Worker infrastructure only; it contacted no external
network or model.

Red-first evidence was 2 pass / 3 fail / 15 assertions. Mutations restoring
message interpolation, treating every error as a request abort, and returning
201 before persistence were 4 / 1 / 17, 2 / 3 / 11, and 2 / 3 / 20. Review
then exposed a deeper defect: real KP-layer fallback was labelled ready and
its warning leaked provider data. The real chain was 5 / 2 / 29; a
string-only server mutation was 6 / 1 / 29; and restoring `err.message`
logging was 6 / 1 / 33. Each run exited 1 and was exactly restored.

The first full serial suite exited 1 at 5144 tests / 462 files / 5093 pass /
35 skip / 16 fail / 33948 assertions / 927.44s. It was not flaky. Server had
bypassed `getOpeningScene` and directly called the new result API, disabling
the factory override seam, adding provider calls during creation, and causing
concurrent timeouts. The focused seam test was 0 / 1 / 2, and the bypass
mutation was identically red. Routing through the private structured helper
plus observer restored the root problem group to 109 pass / 7 files / 922
assertions. Earlier root directed evidence was 74 pass / 9 files / 418
assertions; typecheck exited 0. Quick preflight exited 0 at 319 boolean-return
implementations / 0 discarded returns, references 3 / 8 / 1 / 3, and
`unwiredMethods=46`.

The final authoritative serial suite exited 0 at 5145 tests / 462 files /
5110 pass / 35 skip / 0 fail / 34123 assertions / 535.78s, an increase of
eight tests and one file with skip unchanged. This bounded response/log/
fallback-persistence closure does not complete ordinary creation. Cross-
process provider-cost admission, namespace lease heartbeat for a 30-second
lease versus legal 120-second opening, provider exactly-once, authoritative
module/world binding, Docker/Linux/assets/deployment, NFS/SMB, power loss,
multiwriter behavior, and external real-model quality remain open.
`todo-65`, Checkpoint I, and the production-quality goal remain open.
`docs/notes/index.json` and `docs/architecture.json` remain deliberately
unrefreshed.

## Ordinary creation admission must cover the whole job, not only provider dispatch (2026-10-05)

Slices A/B/B2 establish a dedicated durable admission domain for expensive
ordinary-session creation. Its SQLite policy fixes global and per-principal
concurrency, durable starts per authenticated principal and time window,
bounded tracked-principal cardinality, physical lease TTL, absolute whole-job
deadline, and busy timeout. Quota identity is the authenticated owner
fingerprint; persona fields in the request body are not identity. Defaults are
two global, one per principal, and four starts per 60 seconds. Physical leases
last 60 seconds and renew under an absolute five-minute deadline.

The lease is acquired after authentication and body validation but before ID
allocation, namespace reservation, GameSession construction, opening-provider
work, generation-zero publication, rehydration, or registry install. It stays
held across that complete sequence. Renewal may extend physical occupancy but
cannot move the absolute deadline. Request abort, renewal loss, or deadline
aborts cooperative work; a provider that ignores abort continues to occupy the
slot until it actually settles. Releasing early would admit a second expensive
job while the first is still executing. The namespace reservation now uses the
whole-job deadline rather than its former 30-second opening window.

Expired or uncertain provider work is not safe automatic takeover evidence.
The operator-only, bodyless recovery route accepts no caller-supplied
principal or fence and reports `providerOutcome=unknown`. This preserves the
distinction between freeing quarantined local capacity and claiming that a
provider did or did not execute. Strict startup config, the authenticated
`/api/config` view, `.env.example`, Compose, and deployment guidance share the
validated defaults and reject malformed or widening values.

Main-process composition exposed two operational rules. First, a strict
coordinator must not weaken its root validation by creating directories
itself. The host owns exactly one root creation step and must perform it before
strict coordinator initialization, inventory, timers, or listen. Unsafe
pre-existing roots still fail closed. This ordering requires a real-main test;
an injected unit coordinator cannot demonstrate that a fresh production root
exists at the right instant. Second, post-commit staging cleanup is
non-authoritative. Independent review found that a staging `close()` throw
could leak the creation slot after generation zero was already authoritative.
Cleanup is now contained, and an idempotent outer `finally` releases admission
on every post-acquire exit without reversing the committed envelope.

The first complete `bun test` exited 1 at 5200 tests / 471 files / 5159
pass / 35 skip / 6 fail / 34274 assertions / 454.87s. This was not flaky and
was separate from the earlier review-found close leak. Five failures were
real-main fresh-root cases that initialized admission before the host-created
namespace root existed. The sixth was an old exact `/api/config` `toEqual`
shape that omitted the new validated creation-admission snapshot. Creating
only the owned host root before strict initialization and updating that exact
contract fixed the two causes. Root correction coverage exited 0 at 9 pass /
5 files / 147 assertions, and typecheck exited 0.

The final authoritative `bun test` exited 0 at 5200 tests / 471 files /
5165 pass / 35 skip / 0 fail / 34277 assertions / 423.50s, an increase of
55 tests and nine files over 5145 / 462 / 5110 / 35 with skip unchanged.
The final standard `bun scripts/preflight.ts` exited 0: 324 boolean-returning
implementations / 0 discarded returns; generated/handwritten/structured/
section references 3 / 8 / 1 / 3; internal typecheck 0; exact 5200 tests /
471 files baseline; exact `unwiredMethods=46`; and
`core.hooksPath=.githooks`. This bounded
admission contract is not provider exactly-once or production completion.
Authoritative module/world binding, Docker/Linux/assets/deployment, NFS/SMB,
power loss, broader multiwriter semantics, and external real-model quality
remain open. `todo-65`, Checkpoint I, and the production-quality goal remain
open. `docs/notes/index.json` and `docs/architecture.json` remain deliberately
unrefreshed.

## External world-model data belongs in runtime mounts, not the image (2026-10-06)

The previous Dockerfile unconditionally copied `assets/`, even though that
directory is gitignored and absent in a clean source clone. That made private
content an undocumented image-build prerequisite and blurred reviewed runtime
data with application code. Image construction now excludes `assets/` and
creates three empty, root-owned mode-0555 mount points: legacy assets, the
compiled-policy directory, and the Cthulhu dataset root. The writable
`/app/data` volume remains a separate bun-owned authority.

Base Compose deliberately keeps compiled world binding disabled. The optional
`docker-compose.world-model.yml` override requires explicit operator host
paths, mounts all three sources read-only at fixed container paths, and passes
only those fixed paths into the process. It does not let a request, PDF, or
model response select a host path. The compiled policy and dataset still form
one atomic startup pair under the existing exact `(moduleId, artifactHash)`
registry. Host files and directories must permit UID/GID 1000 to read and
traverse them; SELinux labels and equivalent host mount policy are deployment
responsibilities.

The initial focused regression was 6 pass / 1 fail / 28 assertions because
the runtime stage still copied `assets/`. Restoring that `COPY` and separately
removing the policy mount's `read_only` flag each reproduced 6 pass / 1 fail
and exit 1. Exact restoration gave root-directed container/config coverage of
31 pass / 5 files / 264 assertions and typecheck exit 0. The sandbox frontend
build hit child-process `EPERM`; the permitted host rerun exited 0 with Vite
6.4.3, 33 modules, and 774ms. The authoritative serial suite exited 0 at 5208
tests / 472 files / 5173 pass / 35 skip / 0 fail / 34327 assertions / 522.67s.
The final standard preflight exited 0: 325 boolean-returning implementations /
0 discarded returns; generated/handwritten/structured/section references
3 / 8 / 1 / 3; internal typecheck 0; exact 5208 tests / 472 files baseline;
exact `unwiredMethods=46`; and `core.hooksPath=.githooks`.

This is a clean-clone and deployment-contract correction, not actual container
evidence. Docker is absent here, so image build, Compose startup, Linux-native
dependencies, mount permissions, UID/GID behavior, volume migration, proxy,
and TLS remain unverified. Content availability remains an operator concern.
Policy hot revocation, provider exactly-once, NFS/SMB, power loss, multiwriter,
external real-model/source-document quality, `todo-65`, and the production-
quality goal remain open. `docs/notes/index.json` and
`docs/architecture.json` remain deliberately unrefreshed.

## A startup barrier must probe the schema used by the first request (2026-10-06)

Merely opening an admission database and comparing its policy row was not a
complete startup compatibility check. A malformed auxiliary health table
could pass initialization and listening, then fail only when the first
automatic-resolution acquisition read it. Startup now prepares no-row
probes for every leases, health, and starts column used by acquisition inside
the same transaction as policy validation. Preparing the statements validates
the schema without observing a health row, consuming quota, publishing a
lease, or clearing quarantine. The operational rule is broader than this
coordinator: a claimed startup barrier must cover every durable table and
column its first request is guaranteed to touch, while state-value decisions
that belong to request or recovery semantics must remain untouched.

Root configuration has the same fail-closed requirement. An explicitly
present empty environment value is not equivalent to absence: allowing it to
fall through path resolution turned the process working directory into an
accidental authority and could override a valid lower-precedence catalog
root. Config roots are now accepted only when nonblank and byte-for-byte equal
to their trimmed value. Default controller construction is lazy so strict
admission parsing does not reorder unrelated startup errors: invalid PORT is
still rejected before any root selection or filesystem write.

The original real-main regression caught only missing startup initialization.
Independent review then supplied both counterexamples above; a complete green
suite before those counterexamples was therefore retained as pre-correction
evidence, not promoted as final proof. The corrected mutations independently
removed the auxiliary probe, restored empty-root fallback, and removed main
initialization; each made its intended regression red before exact
restoration. Root-directed coverage exited 0 at 57 tests / 6 files / 355
assertions, independent review passed 24 tests / 2 files / 123 assertions,
and typecheck exited 0. The authoritative serial suite exited 0 at 5214
tests / 472 files / 5179 pass / 35 skip / 0 fail / 34359 assertions /
527.46s. The final standard preflight exited 0 with 325 boolean-returning
implementations / 0 discarded returns, references 3 / 8 / 1 / 3, internal
typecheck 0, exact 5214 / 472 baseline, exact `unwiredMethods=46`, and
`core.hooksPath=.githooks`.

This closes only automatic-resolution admission startup
compatibility. General compiler admission, provider exactly-once, hot
revocation, container execution, NFS/SMB and power-loss behavior, wider
multiwriter semantics, and external model/source quality remain open.
`docs/notes/index.json` and `docs/architecture.json` remain deliberately
unrefreshed because both have parallel changes.

## Input ownership is also runtime authority (2026-10-07)

An in-memory runtime object cannot treat a caller-owned module or a returned
object view as harmless read data. If either value retains a canonical alias,
an unrelated caller can redirect the real movement, clue-unlock/state-variable,
NPC relationship, or prompt-context decision after the nominal API call has
returned. The legacy `WorldState` therefore takes a structured clone at its
input boundary and returns detached structured values from every public reader.
This includes stale-view behavior: an old reader result must neither see a
later canonical mutation nor be able to supply one. A state snapshot must clone
its nested Map, Set, NPC state, scene variables, and history—not merely clone
the outer object.

Ownership changes also require a call-graph check. `play-module.ts` applies
LLM-expanded NPC text after constructing legacy WorldState, but its scene
pipeline consumes that external module NPC data directly; the state holder does
not rely on a post-construction write-through. That observation is a bounded
compatibility fact, not a reason to merge the legacy and SQLite WorldState
implementations.

The latest unwired probe moved from 46 no-callers to 41 because the ownership
regression exercises five formerly uncalled legacy methods as test-only
callers. This is a test-coverage classification change, not evidence of new
production wiring or broad cleanup completion.

## A logical clock is not the newest surviving history row (2026-10-07)

Snapshot history and live logical time are different kinds of truth. A
snapshot row records one historical publication in append order; retention or
repair may later remove it. Deriving the current round from `MAX(round)` or
the newest surviving `rowid` therefore turns history pruning into an
unannounced clock rollback. The durable current round needs a separate
singleton authority, while historical rows remain ordered only for historical
inspection and legacy initialization.

Migration evidence has two independent obligations. The singleton must have
the exact durable schema and a valid value, and every historical `round` must
be checked for SQLite integer type plus non-negative safe-integer range before
startup blesses the store. Checking only the latest row leaves an older corrupt
row latent until a later export; accepting a partial same-named `snapshots`
table leaves a store that opens but cannot publish. Both are fail-closed
admission failures, not repair opportunities.

Publication needs one immediate SQLite transaction spanning the state/events
read, derived context, historical snapshot INSERT, and logical-clock update.
A test that merely observes eventual rows is not enough: arrange a real second
connection at the old INSERT boundary, require it to receive the lock while
the transaction owns the write reservation, then retry it outside the
transaction. Separately, mutate all public round consumers back to an
instance cache and require a second manager to observe `round_0` where the
durable clock requires `round_8`. Those two failures distinguish the intended
multi-connection and publication semantics from a process-local happy path.

This does not make two WorldState implementations one authority, create a
cross-store transaction, or establish multi-host, crash/power-loss, deployment,
or external-model guarantees.

## Admission must precede the resource it claims to bound (2026-10-06)

The isolated PDF compiler already allowed one active parser and four queued
workers, but the HTTP route acquired that admission only after it had read an
entire PDF of up to 8 MiB. The worker bound therefore did not bound request
bodies or slow client connections: an authenticated operator could create
arbitrarily many body reads before any request reached the queue.

The HTTP route now uses a distinct process-shared ingress lease before its
first handler-controlled getReader call. Authorization and cheap Content-Type,
module ID, UTF-8, and declared Content-Length checks run first. Admission then
uses only the exact host-principal fingerprint, never a query, header, module
ID, or PDF-derived key. The fixed limits are five process-wide and two per
principal, matching the maximum one active plus four waiting worker jobs while
preserving per-principal capacity. Refusal is immediate, reads no body through
the handler, and exposes neither identity nor live counts.

The ingress lease spans the body, existing isolated parser/validator admission,
and catalog publication. It is released idempotently on every return and throw.
The two guards are intentionally not merged: ingress bounds memory and client
connection occupancy; worker admission bounds physical parser processes.
Testing had to distinguish Bun Request construction from handler consumption,
because Bun may prefetch an underlying stream while constructing a Request.
The stable boundary is whether the handler obtains a reader.

Mutations removing acquire, releasing before body read, and using moduleId as
the bucket each failed at 3 pass / 1 fail / 26 assertions. Rebuilding the
fallback controller per request failed at 4 pass / 1 fail / 36 assertions,
which proves that a syntactically present controller is insufficient unless
production requests share it. Root-directed final coverage was 19 tests / 4
files / 123 assertions, and independent review passed.

The first complete serial run had one failure in an existing entity-id major-
wound status case: 5183 pass / 35 skip / 1 fail. The case then passed 100
isolated repetitions and 140 adjacent ending/entity tests without a code or
assertion change. The following full rerun passed 5219 tests / 473 files /
5184 pass / 35 skip / 0 fail / 34417 assertions in 533.48s. The first result
remains non-repeating negative evidence, not a claimed repair.

This closes only in-process public PDF body ingress. Compiled-session creation
ingress, gateway and cross-replica quotas, starts and cost budgets, per-person
IdP identity, provider exactly-once, Docker/Linux execution, NFS/SMB and
power-loss behavior, wider multiwriter semantics, and external model/source
quality remain open. `docs/notes/index.json` and `docs/architecture.json`
remain deliberately unrefreshed because both have parallel changes.

The first standard preflight after this record exited 1 on the existing
cross-process ordinary-vs-compiled namespace reservation case, while its
typecheck, source scan, document references, unwired count, and hooks checks
all passed. No implementation or assertion was changed: the exact case then
passed 10 isolated repetitions; the complete 24-case namespace file passed
240 tests across ten repetitions; and a related namespace/startup/snapshot
pressure set passed 275 tests across five repetitions. The following standard
preflight on the unchanged implementation exited 0 and matched the 5219-test /
473-file baseline. The isolated preflight failure is retained as negative
evidence to monitor, not described as a repaired product defect.

## A response boundary is not a resource-settlement boundary (2026-10-06)

The four public compiler JSON routes now acquire one shared process-local
admission lease after authentication and cheap header validation but before
the handler obtains a body reader. The fixed policy is eight process-wide and
two per exact host-principal fingerprint. The lease covers body consumption,
strict UTF-8/JSON decoding, catalog work, resolution/projection, and automatic
provider plus durable publication work. Busy requests return 429 without a
handler body read. Request-selected query, header, body, artifact, and route
values do not influence the bucket.

An initial implementation used explicit `return await` so the outer `finally`
did not release a lease merely after receiving a Promise. That was necessary
but not sufficient. Independent review found that automatic resolution can
legitimately return a deadline or lost-fence response while an abort-ignoring
provider continues in a background drain. In that branch the awaited route is
already complete, so an ordinary outer `finally` still releases too early.
A dynamic counterexample returned 503 from the first request and then allowed
a second request to read/parse its body and return 400 while the first provider
was still pending.

The corrected contract transfers JSON-lease ownership synchronously to the
same observed background-drain promise used to settle durable automatic
admission. Both deadline and lease-loss branches use that one handoff. The
outer `finally` releases only when no handoff occurred; the drain releases on
fulfilment or rejection. A provider that never settles therefore consumes a
bounded slot and eventually fails closed instead of silently reopening
capacity. This is a general review rule: tests must follow physical resource
lifetime past the HTTP response, not only await the route function.

The missing-controller red test and mutations removing acquire, releasing
before awaited work, and constructing the fallback per request all failed.
After the review finding, a second real mutation made the drain handoff a
no-op and reproduced the competing request's incorrect 400; exact restoration
returned 429 with zero `getReader`, followed by successful reuse only after
provider settlement. Root-directed final coverage passed 66 tests / 6 files /
825 assertions. The complete serial suite passed 5226 tests / 474 files /
5191 pass / 35 skip / 0 fail / 34504 assertions in 536.46s.

This closes only in-process lifetime admission for the four compiler JSON
routes. Compiled-session creation ingress, gateway/cross-replica quotas,
starts and cost budgets, per-person IdP, provider exactly-once, Docker/Linux,
NFS/SMB, power loss, wider multiwriter behavior, and external model/source
quality remain open. `docs/notes/index.json` and `docs/architecture.json`
remain deliberately unrefreshed because both have parallel changes.

After the baseline and generated handoff documents were refreshed, the final
standard preflight exited 0: 325 boolean-returning implementations / 0
discarded returns, document references 3 / 8 / 1 / 3, internal typecheck 0,
exact 5226 tests / 474 files, exact unwiredMethods 46, and core.hooksPath
`.githooks`.

## 2026-10-06 — compiled creation admission must follow physical cleanup and authenticate once

The earlier JSON-ingress closeout correctly retained capacity for a provider
draining past its HTTP response, but its recorded statement that compiled
session creation ingress remained entirely open is now superseded. A separate
compiled-create controller admits two requests process-wide and one per exact
authenticated creator, after cheap media/declared-length checks and before
player assignment or `getReader`. Its lease spans every private construction
and generation-zero publication/recovery phase.

Independent review exposed the same physical-lifetime mistake one layer lower.
`reader.cancel()` is asynchronous: returning 408, 413, or 400 does not prove
that the underlying body resource has stopped. Before correction, a deferred
cancel let a same-principal competitor enter and reach PDF 503 or JSON/session
400 instead of 429. `bodyBytes` now records the one real cancellation promise,
and PDF, compiler JSON, and compiled-create wrappers transfer their lease to
that drain. JSON joins body and provider settlements before its idempotent
release. Abort, deadline, byte overflow, and read rejection therefore share
one resource-lifetime rule rather than three route-specific readers.

A second review found that the exported server cold path reconciled durable
runtime inventory before the inner compiler boundary authenticated. Moving
the same policy check earlier fixed the ordering but initially called the host
authenticator twice. That is not benign: `CompilerRequestAuthenticator` is not
declared pure or idempotent. A single-use dynamic counterexample authenticated
once, materialized the namespace, then returned 401 on the second call and
double-counted the identity-provider event.

The final contract authenticates exactly once before request-triggered durable
bootstrap, then carries a frozen null-prototype token whose authority exists
only in a module-private WeakMap. The record binds the exact `Request`, method,
pathname, route-policy ID, and frozen principal, and is consumed before any
comparison. Forgery, replay, and cross-request/method/path use fail closed
without falling back to the authenticator or touching catalog/body state.
Direct inner-handler calls without the token still authenticate once. This is
the reusable rule: moving authentication earlier must carry an unforgeable
decision forward, not repeat a possibly stateful authority check.

Real mutations removing creation acquire, releasing it early, allocating the
fallback per request, using attacker-selected bucket material, dropping the
body-drain handoff, restoring reconcile-before-auth, restoring the second
authenticator call, and removing token replay protection all made their
discriminating tests fail and were exactly restored. Root final targeted
coverage passed 59 tests / 8 files / 870 assertions; independent final audit
passed 46 tests / 507 assertions. The authoritative serial suite passed 5240
tests / 478 files / 5205 pass / 35 skip / 0 fail / 34651 assertions in
536.92s. The final standard preflight exited 0 with 326 boolean-returning
implementations / 0 discarded returns, references 3 / 8 / 1 / 3, internal
typecheck 0, exact 5240 tests / 478 files, exact unwiredMethods 46, and
core.hooksPath `.githooks`.

This closes in-process compiled-create concurrency and body-cancel lifetime,
not gateway/cross-replica quotas, durable start-rate/cost policy, per-person
IdP, provider exactly-once, Docker/Linux, NFS/SMB, power-loss, or broad
multiwriter guarantees. `docs/notes/index.json` and `docs/architecture.json`
remain deliberately unrefreshed because both have parallel changes.

## Single-attempt must cover the generation-zero opening call (2026-10-06)

The earlier ordinary provider audit closed implicit retries for intent, outcome
narration, NPC dialogue, combat narration, and constrained regeneration, but it
missed `KPAgent.describeSceneResult`. That call runs inside durable ordinary
session creation, and the default `LLMClient` policy still allowed a second
POST after an HTTP 5xx or provider-side `AbortError`.

The opening call now explicitly uses `maxAttempts: 1`. The discriminating test
does not call the client in isolation: it drives the actual HTTP creation path
through `GameSession`, uses a real `LLMClient` with a local fake transport, and
checks the provider call count together with the sanitized 201 fallback, live
registry installation, and generation-zero snapshot. Removing only the option
makes both failure variants report two identical POSTs; exact restoration
passes 13 tests across 2 files with 63 assertions. Typecheck exits zero. The
authoritative serial suite exits zero at 5241 tests / 478 files / 5206 pass /
35 skip / zero fail / 34677 assertions in 580.64 seconds.

The final standard preflight exits zero with 326 boolean-returning
implementations / zero discarded returns, references 3 / 8 / 1 / 3, internal
typecheck zero, the exact 5241 / 478 baseline, `unwiredMethods=46`, and
`core.hooksPath=.githooks`.

This is an at-most-one local dispatch attempt, not provider exactly-once. The
current `LLMLike` contract has neither a caller-supplied stable idempotency key
nor a provider result lookup. A provider can therefore execute after dispatch
while the process crashes before local persistence, and no local lease can
resolve that external ambiguity. `docs/notes/index.json` remains intentionally
unrefreshed because it has parallel changes.

## Durable admission deadlines are persisted state transitions (2026-10-06)

A renewable resource lease and an absolute whole-job deadline are different
authorities. The first compiled-session creation coordinator initially checked
both, but renewal wrote `now + ttl` without capping it at the immutable
deadline, and a deadline failure returned `LEASE_EXPIRED` without persisting
the unknown-outcome quarantine. The HTTP guard immediately attempted a second
quarantine call, but that left a crash gap between the refusal transaction and
the guard call; a late exact-owner release could also remove the still-active
row.

The corrected rule is local to the coordinator transaction: every renewal is
`min(now + ttl, deadlineAt)`, and either physical expiry or deadline expiry
atomically changes the owned active lease into the persisted quarantine before
returning a refusal. A late finalizer is then harmless and only the operator
recovery control plane can restore admission. A controllable-clock test caught
the old 1,026-versus-1,025 extension and proves late release remains false.

Resource admission must follow physical settlement, not HTTP response
settlement. Compiled creation now retains both its process-local slot and its
durable fence while `reader.cancel()` is pending. Releasing both in `finally`
was a discriminating mutation: the same-principal competitor reached body
validation and returned 400 instead of being rejected at 429. Resolver work
has no cancellation contract, so the implementation awaits its real result;
if renewal or the deadline is lost, checkpoints prohibit all later body,
catalog, construction, publication, and registry work and leave the durable
domain quarantined.

Cross-process admission changes the setup contract of every trusted direct
HTTP test host. A missing coordinator returning 503 is the product behavior,
not a compatibility path. Eleven older fixtures initially failed before their
intended assertions; they were corrected with real temporary same-root
coordinators. A namespace race fixture also needed different authenticated
principals so the new per-principal guard did not mask the namespace conflict
it was specifically designed to test. Tests must arrange the authorities
needed to reach their target layer; production validators must not be relaxed
to preserve an obsolete fixture.

Finally, nested process execution must be judged from the test summary as
well as the wrapper exit status. A sandboxed PowerShell pipeline reported 112
child-process failures but returned exit zero. That run is invalid evidence.
The same stable tree passed through the sandbox-external Bun wrapper at 5,255
tests / 480 files / 5,220 pass / 35 skip / zero fail / 34,767 assertions.
`docs/notes/index.json` remains intentionally unrefreshed because it has
parallel changes.

## Separate cross-process proofs do not prove the combined race (2026-10-06)

Showing that a durable admission lease excludes another process and showing
that a committed replay row is visible to another process are necessary but
not sufficient. They can both pass while the production path still omits the
second lookup between acquire and provider dispatch. The discriminating test
must force the whole order: B reads an actual miss, A saves and releases, B
actually acquires, and B reaches the real post-acquire lookup. The observable
claim is not merely a 200 response; A has exactly one provider call and B has
zero.

The test's process protocol is itself part of the evidence boundary. Both
streams must drain concurrently, captured bytes must be bounded before string
materialization, overflow must wake waiters and fail closed, and cleanup must
hold only the exact spawned handle. A child that writes beyond the cap and
then never settles distinguishes real termination from a timeout-only claim.
`docs/notes/index.json` remains intentionally unrefreshed because it has
parallel changes.

## Diagnostic output limits are verification failures (2026-10-06)

A process runner's output buffer is part of the verification boundary. The
handoff generator used synchronous capture for the full suite, so growing test
output exhausted the default buffer and produced `ENOBUFS` before the terminal
summary could be observed. Increasing the buffer would only move the hidden
threshold. The durable rule is to drain stdout and stderr concurrently, retain
them under one explicit bound, and treat startup, stream, signal, limit, exit,
or summary failure as red evidence.

The new shared test-run evidence boundary requires exactly one terminal Bun
summary, a real zero process exit, zero failed tests, and non-regressed test
and file counts. It does not infer success from partial output, an outer shell
exit, or a nearby count-looking line. A 2.4 MB two-stream fixture proves that
the terminal summary remains observable after output beyond the old sync
buffer; separate cases reject nonzero, unparseable, and capture-limit results.

The actual repaired handoff command completed a full run, exited zero, wrote
914 lines / 46.7 KB, reported 5,259 tests / 481 files as green and baseline-
consistent, and no longer emitted an `ENOBUFS` marker. The following standard
preflight also exited zero with 327 boolean-returning implementations / zero
discarded returns, document checks 3 / 8 / 1 / 3, internal typecheck zero,
the exact 5,259 / 481 baseline, `unwiredMethods=46`, and
`core.hooksPath=.githooks`. A sandbox `EPERM uv_spawn` attempt remains
environment evidence only and was not counted as either product failure or a
green run. `docs/notes/index.json` remains intentionally unrefreshed because
it has parallel changes.

Generated status documents need an explicit data-selection regression as well
as a process regression. After the capture fix was recorded in todo-65, the
handoff still omitted all three new fields because its typed allowlist and
bounded current-increment selector had not been extended. A red test asserted
the exact closure, verification, and open-scope markers and failed against the
omission. The corrected selector keeps its bounded, explicit authority:
closure plus verification are prioritized as current increments, open scope
is rendered with the other current boundaries, and unrelated todo keys remain
unpublished. The final mapping coverage passed 77 tests / 339 assertions; the
combined process diagnostics passed 85 tests across three files / 377
assertions; typecheck exited zero. The authoritative suite after the mapping
repair exited zero at 5,260 tests / 481 files / 5,225 pass / 35 skip / zero
fail. `docs/notes/index.json` remains intentionally unrefreshed because it has
parallel changes.

## Durable admission needs a durable result and a second read (2026-10-06)

A lease prevents overlapping provider calls, but it does not by itself make a
completed classification replayable. Releasing a generation-scoped intent
lease after success meant the same input could call the provider again after a
restart. A separate success ledger closes that sequential case only when its
write commits before lease release.

There is also a smaller concurrency window that is easy to miss. Request B can
read no replay, pause, then request A can save and release before B acquires
the now-free lease. B must read the replay ledger again after acquisition and
before provider dispatch. The first implementation omitted that read; removing
the correction again changes the interleaving test from zero provider calls to
one. Component tests additionally cover real cross-process admission exclusion
and committed-row visibility.

A replay identity does not authenticate replay content. HMAC-derived lookup
keys prevented cross-session discovery but still allowed a well-shaped local
SQL edit to change selected into no-match or to substitute another catalog
mechanism. The durable row now carries a result MAC under a request-specific
integrity key derived inside GameSession's host capability. The key is never
stored. The MAC binds scope, request, catalog, generation, kind, and mechanism
keys; well-shaped direct SQL substitution and cross-request copying therefore
fail closed and quarantine rather than becoming a fresh provider call.

Resource bounds must be checked before irreversible external work. A global
4,096-row limit let one authenticated scope deny unrelated sessions, and its
post-provider check could consume a model call that could not be replayed. The
ledger now assigns 64 records to each immutable session/generation/bundle
scope. The generation admission lease serializes all writers for that scope,
so a post-acquire, pre-provider capacity check remains stable until the save;
the save transaction repeats the check defensively. Exact hits still replay at
capacity, unrelated scopes are independent, and a newer verified generation
clears only the same session's older rows. No LRU or TTL silently reopens a
provider call.

Finally, a JavaScript length check is too late for corrupt SQLite TEXT, and
`length(TEXT)` counts characters rather than bounding bytes transferred to the
host. Each projected TEXT column is now guarded in SQLite with
`length(CAST(column AS BLOB))` before the original value is selected. A valid
multi-byte JSON payload whose character count fits but UTF-8 byte count exceeds
the bound distinguished the old and new behavior: the old query returned the
field, while the corrected query returns `NULL` and never enters JSON parsing.

These rules yield local durable success replay, not provider exactly-once. If
the external provider executes but the process dies before any local result is
durably confirmed, local storage cannot infer that result; quarantine and
operator recovery remain the honest outcome. `docs/notes/index.json` remains
intentionally unrefreshed because it has parallel changes.

## Controlled rolls also require controlled skill thresholds (2026-10-07)

The same class of fixture error later appeared in the first ordinary combat
growth test. It fixed the d100 result and fighting values but asserted a dodge
mark against a generated dodge skill. A threshold below the fixed roll is a
legitimate failure, so an internal handoff suite could be red while the test
usually passed alone. Setting dodge to 10 reproduced the exact missing-mark
failure; restoring a fixture-owned dodge value of 90 passed 20 repeated target
runs and the complete five-test file. Production combat and growth semantics
were unchanged.

Deterministic outcome tests must control every input to the asserted branch:
entropy alone is insufficient when the threshold itself is generated. A
generator's outer exit code also remains distinct from the embedded suite
status; the generated header must be read back before acceptance.
`docs/notes/index.json` remains intentionally unrefreshed because it has
parallel changes.

## An unordered relationship needs one key at first creation (2026-10-07)

An atomic `INSERT ... ON CONFLICT ... attitude = attitude + delta` is not
enough when the schema key is directional but the reader treats `(A,B)` and
`(B,A)` as one logical relationship. Two connections can both preselect an
absent pair, choose opposite first-write directions, and each insert a valid
row. No increment is technically lost, yet the truth source becomes
ambiguous because the two increments live in different rows.

The bounded correction is to choose a stable ordinal direction only when no
persisted direction exists. Once either direction exists, preserving it avoids
rewriting identity and keeps existing explicit `setRelation` behavior. A
discriminating test must pause the first caller after its real empty SELECT,
execute the reverse caller through the real public method, and then resume the
first write; merely making two sequential reverse calls cannot expose the
race. Restoring the caller-order fallback must produce two rows and make the
test red. This closes one shared-SQLite first-create interleaving, not unordered
schema uniqueness, arbitrary lock scheduling, or all multiwriter behavior.
`docs/notes/index.json` remains intentionally unrefreshed because it has
parallel changes.

The same logical-pair rule applies to reads after damage already exists. A
reader using SQLite `.get()` silently chooses one of two directional rows and
turns an ambiguous durable truth into an arbitrary attitude. `getAttitude`
therefore consumes all matches from one SELECT snapshot: zero remains the
historical neutral `0`, one row remains symmetric, and two rows fail closed.
It does not choose a winner or repair the database. Replacing that read with
the old first-row behavior must make the conflict regression red.

Correction: read-time rejection is not a sufficient production invariant.
The schema now owns the same unordered identity through a CASE-expression
unique index, while `setRelation` preserves an existing row's direction and id
or uses the same stable first-create ordering as `modifyAttitude`. A legacy
database that already contains both directions is not silently merged: opening
fails with both rows unchanged and the failed constructor closes its handle.
Portable snapshots reject a re-signed reverse duplicate before restore SQL.
The migration uses a single-statement SQLite call because Bun's batch `exec`
did not surface the observed index-build failure even though no index was
created; a schema gate must prove that its constraint actually exists.

## Cross-process timing tests must observe the durable clock (2026-10-06)

A real-process lease test cannot use a tiny fixed TTL as both the concurrency
window and the expected scheduling budget. The ordinary-creation admission
test used 100 ms; under a complete-suite load, the holder could legally expire
before the contender process reached acquisition. The observed `UNHEALTHY`
answer was correct production behavior, while the test expected `BUSY`.
Repeated execution made the distinction concrete: the original protocol
failed 9 of 30 runs for this exact reason.

The corrected protocol consumes the same durable times that production
admission returns. The child reports `expiresAt` and `deadlineAt`, every
participant uses one 5 s policy, the first contender must observe `BUSY`, and
after the holder is killed the test waits only until the returned persistent
expiry before requiring `UNHEALTHY`. It neither accepts both codes nor adds an
unrelated blind delay. Replacing the derived wait with `sleep(0)` is a real
mutation and fails deterministically with `BUSY`; restoration passed 30 of 30
delegated repetitions, five of five independent repetitions, and the complete
10-test file. No production admission code changed.

The broader rule is that cross-process timing assertions should be anchored to
the authority's persisted deadline, not to the parent test's estimate of when
a child acquired a lease. `docs/notes/index.json` remains intentionally
unrefreshed because it has parallel changes.

## Failed verification needs bounded evidence, not names alone (2026-10-06)

A full-suite capture can be too large to replay, but retaining only `(fail)`
titles is also insufficient. One standard preflight ended with process exit 9
and no terminal summary after naming three cross-process tests. Those tests all
passed alone and passed 30 of 30 as a group, so the run did not justify a
product change; without assertion context it also could not justify a cause.

Preflight now extracts a deliberately small diagnostic projection: at most
three failures, 18 rendered lines, and 4 KiB total. It preserves nearby error,
expected/received, stack, timeout, signal, and child-process lines, filters
unrelated bulk output, and explicitly says when Bun printed a failure name but
no recognized context. When Bun prints no failure name, bounded process-level
diagnostics are still retained. This evidence is additive only: nonzero exit,
missing or ambiguous terminal summary, failed tests, and baseline regression
remain independent reasons for a red gate. Returning an empty projection made
three of four new tests fail, and widening the three-failure limit to four made
the integration test fail.

The first run with this projection immediately located two test-harness
defects. One diagnostic integration test still expected the superseded
semicolon-separated names format. More importantly, an isolated loopback CORS
test spawned a new Bun runner without passing a timeout, so the child used the
default 5 s limit even though the outer verification contract allowed 30 s.
The child now receives explicit runner and test budgets, emits `ready` and
`result` protocol phases, and remains under one absolute parent-owned watchdog.
Phase progress may shorten that watchdog but never restart or extend it. The
default watchdog is 29 s under a 30 s parent; custom timeouts reserve the same
one-second drain margin and reject values too small to do so. A real hung child
is terminated only through the handle that the test itself spawned. Removing
that kill and restoring watchdog equality with the parent both made the new
hang coverage red.

The repaired standard preflight exited zero at 5,280 tests / 483 files /
5,245 pass / 35 skip / zero fail with typecheck zero, boolean returns 334 / 0,
`unwiredMethods=46`, and `.githooks`. These changes improve verification
authority only; no product CORS, Career, admission, or replay behavior was
weakened. `docs/notes/index.json` remains intentionally unrefreshed because it
has parallel changes.

## Generated snapshots need bounded internal failure evidence (2026-10-06)

A document generator may intentionally exit zero after writing a red snapshot,
so its process status is not the status of an internal test run. Multiple
handoff refreshes wrote a header reporting `bun test` exit 1 while a surrounding
standard preflight and a later complete-order run were green. Aligning handoff
with preflight's explicit `--parallel=1 --timeout 30000` contract removed one
scheduling drift, but did not by itself remove the red run; treating it as the
root cause would have been an unsupported conclusion.

Handoff therefore also reuses the existing bounded failure projection whenever
its internal evidence is red: at most three failures, 18 lines, and 4 KiB. It
still writes the red snapshot and never converts a failed child to green. The
original argument assertion failed one of 78 checks before restoration. The
new diagnostic assertion failed before the context existed, and the combined
contract passes 79 of 79 independently.

That context exposed the real intermittent fixture defect. The ordinary CoC
active-player test generated p2 skills randomly, fixed only fighting at 90,
then expected both fighting and dodge marks from d100=11. A generated dodge
below 11 legitimately omitted the dodge mark. Fixing p2 dodge to 10 reproduced
the exact received array `['fighting']`; the final fixture fixes both asserted
skills to 90. No production owner, combat, or growth code changed. The target
passed 20 delegated repetitions and the complete file passed 25 independent
repetitions. A root complete-order run then passed 5,281 tests / 483 files /
5,246 pass / 35 skip / zero fail. A generated header must itself say the suite
is green before that snapshot is accepted. `docs/notes/index.json` remains
intentionally unrefreshed because it has parallel changes.

The same distinction applied to `now`. Before its capture correction,
`bun scripts/now.ts` exited zero while writing a red snapshot containing
`spawnSync bun ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)`:
the full suite emitted about 961 KiB, beyond synchronous capture's default
buffer. That is neither a product-test failure nor a green generated snapshot.
The generator now shares `collectTestRunEvidence`, invokes the explicit
single-worker 30-second Bun contract, concurrently drains stdout and stderr
under one 64 MiB bound, and remains fail-closed for capture/process/summary/
baseline evidence. It still writes a red snapshot for a non-green child; its
outer zero means only that the document write completed. The current-increment
allowlist was also brought forward for the active-scene and relationship
records. Initial capture coverage was 81 pass / 2 fail; restoring synchronous
`spawnSync` was red at 82 / 1; agent and root final diagnostics passed 83 / 0
/ 393 assertions with typecheck zero. Generated `now`/`handoff` and final
standard preflight remain separate follow-up evidence. `docs/notes/index.json`
and `docs/architecture.json` remain deliberately unrefreshed because both have
parallel changes.

## IF NOT EXISTS is not schema attestation (2026-10-07)

`CREATE ... IF NOT EXISTS` proves only that SQLite accepted a request not to
create a second object with that name. It does not prove that an existing
same-named index is unique, partial, or has the required expression and
predicate; nor does it prove that a same-named trigger has the required
`WHEN` clause or body. Treating the name as the invariant lets a corrupt or
older definition pass initialization while silently weakening the database.

The admission boundary must attest the actual definition from `sqlite_master`
and the applicable `PRAGMA` metadata. In one transaction it scans legacy data
against the invariant, checks the existing objects, creates any missing DDL,
and reads both data and schema evidence back before commit. Keeping the data
scan inside that same transaction matters: a pre-DDL scan outside it leaves a
TOCTOU window in which a concurrent writer can introduce the state the scan
just ruled out.

This is deliberately separate from two other obligations. `createSchema` owns
schema attestation and answers whether SQLite is equipped to enforce the
invariant; the legacy-data scan answers whether already persisted rows satisfy
it. Reader, setter, export, and snapshot paths fail closed when durable data
is actually ambiguous or illegal, such as multiple active scenes or an
illegal active bit, even after protections have been deliberately removed for
a fault probe. They do not independently reject merely because schema
attestation is absent. One obligation is not evidence for another.

`docs/notes/index.json` and `docs/architecture.json` remain deliberately
unrefreshed because both have parallel changes.

## Capability lifetime and legacy policy fields are separate boundaries (2026-10-07)

A dependency supplied by a caller may remain caller-owned without becoming a
capability that a session-issued facade may exercise after the session ends.
The `GameSession` NPCStore reader is a useful boundary: it exposes a frozen,
detached read surface while the session is live, but retained readers reject
after `close()`. Closing the session-owned raw store is lifecycle cleanup;
leaving a caller-owned injected store open preserves the caller's ownership.
Neither fact authorizes the retained facade to keep reading after its issuer has
ended.

Similarly, an unconsumed field that looks like policy is more dangerous than an
unknown field. `visible_to: ["alice"]` looked like a privacy declaration while
the live writer actually followed the default public route, creating a false
signal rather than a parse error. New live writes therefore fail closed before
any history, audit, or revision side effect when they own that field. This does
not license destructive migration of old durable data: versioned snapshot
parser, restore, and export continue to preserve historical `visible_to` as
detached compatibility data. Compatibility for a past representation and
authority for a new command must be specified and tested separately.

## Lifecycle policy is not an accidental closed-resource error (2026-10-07)

A resource error after teardown is not itself lifecycle policy. For example, a
closed SQLite world may eventually throw `Cannot use a closed database`, but a
public session mutator that reached it has already escaped the intended
lifecycle boundary. The session issuer must revoke its own facades and direct
mutation capability explicitly before a reader, history write, in-memory
character change, or database operation begins.

The backing durable data has an independent lifetime. A retained CareerStore
facade must fail after its `GameSession` issuer closes, without deleting the
Career files or revoking a separately caller-owned raw store. Resource cleanup,
authority revocation, and durable-data retention are three different facts;
tests must observe each rather than inferring one from another.

When multiple public mutators share a guard, put the lifecycle check at that
shared boundary so all current callers fail before their distinct side effects.
Do not flatten established error precedence while doing so: ordinary close,
fail-stop, a live durable identity, and a restore-specific lifecycle contract
can require different public results. Test those precedence cases explicitly,
then remove the shared check in a real mutation to prove the common regression
actually observes it.

## Retained world facades revoke before any dispatch (2026-10-07)

Closing a session-owned raw world is resource cleanup, not the public
lifecycle policy for a retained `session.world` capability. A backend error
such as `Cannot use a closed database` says only that a particular SQLite path
was reached too late; it cannot revoke a reader that is pure today or becomes
cache-backed tomorrow.

Put one resolver at the GameSession world-facade boundary and make every
allowlisted facade method obtain its raw manager through it before dispatch.
That preserves the existing WorldState DSL and its method-specific behavior
while consistently revoking retained capabilities before pure, cached, or
SQLite-backed work begins. Regression coverage must exercise both a
cache-only delegate and a real SQLite reader after an idempotent double close;
removing that one resolver check must make the test red.

## Captured failure output must retain bounded identity (2026-10-07)

Draining and retaining a child process capture is not enough if the caller
then reports only a generic exit reason and discards the captured failure
identity. The result is non-green but not actionable evidence: `bun test`
exit 1 says that the child failed, while omitting the failing test name and
nearby expected/received or error context needed to decide whether a product,
fixture, runner, or diagnostic path warrants investigation. Project retained
output through the existing bounded diagnostic extractor instead of replaying
the entire capture; this preserves a small, relevant failure identity without
turning a large test log into generated-document noise.

The writer's outer zero is likewise evidence only that its snapshot write
completed. It is never evidence that the child suite was green. In the first
observed now refresh, the writer exited zero while its internal full suite
exited one and the snapshot said only `bun test 退出码 1`. The child did not
reproduce on the later same-worktree green run, so the correction claims only
diagnostic observability, not a repaired product test. Red tests for both the
old implementation and removal of the projection call prove the identity
projection is required; a green writer remains separately accountable to its
recorded child evidence.

## Fixture scene activation must not preserve a split-brain public writer (2026-10-07)

Tests sometimes need an already-registered scene as setup. That need is not a
reason to keep a production `GameSession` scene writer whose semantics differ
from real player movement. In particular, a public operation that changes only
the active scene can leave the player entity at its previous position. Any
consumer that reads active-scene state while another reads player position then
observes two incompatible cohorts of the same session.

Retire that writer rather than hiding it behind a private annotation, renaming
it, or leaving a throwing compatibility alias. Real movement continues through
the canonical action path, which updates the coupled player facts; compiled
load and restore continue through their private canonical synchronization path.
When a test only needs mechanical scene arrangement, keep the escape hatch in
test code: capture that test session's raw world through an existing read
observation seam, require the scene to be registered, and activate it there.
The helper must never be re-exported through production, and product-semantic
tests should prefer a real `act` whenever movement behavior itself is under
test.

## Exact dead-owner recovery needs existing local authority (2026-10-07)

A residual per-character Career lock is not safe to delete merely because it
looks old, blocks a new writer, or contains a PID. PID reuse and a replaced
lock path make those guesses destructive. Recovery needs both a local
serialization authority already held by every conforming writer and a durable
owner identity that distinguishes the former process from a reused PID.

For the bounded supported case, use the existing Windows fixed-local managed
root fence and persist a versioned lock record containing a token, PID, and
process creation FILETIME. Before reclaiming, prove the owner exited or was
reused, reread the raw record through a pinned descriptor, compare dev/inode,
and repeat those checks immediately at unlink. A fresh child process after a
real kill is the useful regression shape; it exercises recovery rather than a
same-process mock. Live, raw legacy, malformed, unknown-version, non-Windows,
network/NFS/SMB, unavailable-proof, and staging locks must remain fail-closed.
This improves bounded crash availability only; it is not a real power-loss or
cross-store durability proof.

## Private agent transactions must bypass compatibility wrappers (2026-10-07)

An internal transaction chain must not dispatch through a replaceable public
compatibility wrapper. In NPCAgent, remaining public memory and state methods
remain for callers that need compatibility, but framework-internal respond, speakUp,
recordInteraction, combat, and horror chains go straight to private helpers
and the one private append-memory core. A public wrapper can then be tested as
a forwarding boundary without becoming hidden framework authority.

Durability is not sufficient evidence for that correction. Tests must observe
both the durable NPCStore result and the portable ordinary snapshot's live
agent memory. A SQLite-only append can make database assertions green while
the snapshot silently receives no memory, leaving history and live state
divergent. The same principle applies to state, relationship, and event paths:
use a real public-wrapper restoration as a red control, then restore the
private route exactly.

This history records only the framework-internal dispatch boundary. CLI
external direct wrappers remain compatibility surface; NPCStore add/count/prune
failure atomicity and degradation policy, TypeScript-private runtime
notification, cross-store and multiwriter semantics, power loss, deployment,
authentication, and real-model quality remain separate work. It does not
claim that every form of prototype tampering is prevented.

### Correction: remove an uncalled compatibility shell (2026-10-07)

Compatibility is not established by leaving a public shell that has no
production or test caller. The first standard preflight after this correction
was a real red, not a flaky run: boolean implementations 336 / discarded
returns 0, document references 3 / 8 / 1 / 3, typecheck 0, 5,352 tests / 491
files green, and `.githooks` all passed; only no-callers was 41 against the
40 baseline. The exact probe record identified `NPCAgent.persistState`; a
descriptor patch is observation or a fault injection, not a call site.

Delete that public wrapper rather than manufacturing a test caller or raising
the unwired baseline. The private `#persistState` remains the internal state
authority. Root then verified the correction: 167 directed tests / 8 files /
zero fail / 874 assertions, typecheck zero, and probe exit zero at 40
no-callers / 81 test-only / 26 should-private; scoped diff-check was zero with
only the CRLF notice. Standard preflight also exited zero: boolean
implementations 336 / discarded returns 0, references 3 generated / 8
handwritten / 1 structured / 3 reverse, typecheck zero, exact 5,352 tests /
491 files and 40 unwired baselines, and `.githooks`.

This remains a bounded dispatch correction, not a claim about the remaining
public compatibility boundary, NPCStore failure atomicity/degradation, or the
broader open persistence work.

## Durable memory append is a bounded transaction, not a whole NPC transition (2026-10-07)

The durable memory boundary needs one owner and one transaction: INSERT,
retention count, and any over-limit delete must commit or roll back together.
The useful negative proof is a real SQLite trigger on both the insert and the
retention delete path, including `sqlite_sequence`; a row-count-only check can
miss a durable partial append. Keep the store write core private and do not
publish a new writer through a read facade.

An agent must calculate its next live cache as detached data, commit the
durable transaction first, and only then publish live memory and revision.
Storage failure is not an LLM or constraint fallback: those established
fallbacks can still resolve their template without memory, while failed storage
rejects. Similarly, a mood change that depends on a memory must not change
mood, memory, durable state, or revision when that append fails. Real
caller-owned-store GameSession coverage should observe what is actually
published, including the existing unanswered system message rather than an
invented NPC reply.

Private transaction ownership can make a former public helper dead. An
uncalled compatibility shell is not compatibility: delete it rather than add a
synthetic test caller or move the unwired baseline. This correction closes only
memory append and retention. `updateState` can still fail after memory commits,
and relationship/recordInteraction, CLI fanout, cross-store, multiwriter,
power-loss, deployment, authentication, and external-model boundaries remain
separate work.

## Correction: NPC runtime state is relative to one durable transition (2026-10-08)

The earlier memory-append note was deliberately narrower: it did not make a
memory event and a later state write one fact. The correction is not to make
every NPC method a transaction, but to define one bounded expected-to-next
runtime transition. Its durable pre-state is checked *inside* the SQLite
transaction; optional event-memory INSERT, retention count/prune, player
relationship update, and `npc_states` upsert then succeed or fail together.
The next live memories, mood, relationship, and interaction count are detached
before that transaction. They publish once only after durable success. A
failure therefore leaves the live agent and registry revision unchanged; no-DB
uses the same detached plan and the same single publication rule.

The player-relationship projection must be checked even on a mood-only plan.
Otherwise a state/player drift can survive a successful state write merely
because that plan did not increment the relationship counter. Its
`interaction_count` remains deliberately distinct from total interaction
count; the invariant is the relationship value, not equality of those counters.
Real SQLite INSERT/UPDATE/prune/foreign-key triggers are useful here because
row-count assertions alone do not prove rollback of retention or sequence.

## Correction: a CLI fanout is a batch, not a loop (2026-10-08)

For a command which changes PlayerSession and several NPCs, planning and
authority must be settled before the first durable write. The bounded design
uses a lexical Registry host held by WeakMap, a module-private token, canonical
clone, and Map-key identity; caller-provided aliases do not select authority.
It seals PlayerSession and NPCAgent plans, commits NPCStore work in one batch
transaction, then publishes the private live result only after durable success.
Mixed stores are not promoted to a fictional distributed transaction: they
fail closed.

TypeScript `private` and `readonly` are not runtime authority. A post-SQL
assignment can still throw after durability if its target is only TypeScript
readonly, stranding a durable batch before live publication. Lexical
ECMAScript `#private` authority avoids that split. More generally,
post-durable publication must be non-throwing with respect to application
authority: validate, clone, seal, and select every possible throw path before
the commit, then publish only owned detached data. The red controls for old
public wrappers, early PlayerSession publication, per-NPC transactions, token
check removal, readonly post-SQL assignment, and degraded private publication
are all required evidence of that ordering.

These are corrections to the historical 2026-10-07 note, not a claim that the
former scope was wrong at the time. The memory-append boundary remains useful
for ordinary appends; state/relationship/recordInteraction and CLI fanout now
have their own bounded closures. Cross SQLite-to-PlayerSession process-crash
ACID, cross-store/multiwriter/power-loss behavior, broader compatibility
wrapper retirement, deployment, authentication, and external-model quality
remain open.

## Correction: a retained durable multiset is the only live-memory projection (2026-10-08)

The preceding 2026-10-08 transition/fanout note remains historical evidence,
but its closure needs this narrower correction. A candidate memory list is not
the durable result when retention can remove rows. `remember`, a memory-bearing
runtime transition, and CLI batch fanout must all project the retained durable
multiset to their live caches from inside the same SQLite transaction. The
no-DB path must follow the same rule and the same 40-entry retention bound;
otherwise a snapshot can look internally coherent while live memory names rows
that cannot be durably recovered.

Snapshot validation is a cohort test, not merely a serialization test. For
every supported ordinary wire version (1.0-1.4), compare the active runtime
registry with NPCStore using exact-multiset memory subset semantics, matching
mood/relationship/interaction count, personality `id === runtime.name`, and
a matching player relationship row whenever the relationship is nonzero. Check
the identity and missing-row cases separately: equality-only checks can accept
the wrong NPC, and an absent row is not an empty row.

The batch rule is likewise temporal, not just structural. Receipt-to-plan lookup,
uniqueness, binding, and consumer completion are part of the transaction
callback before commit. A consumer throw must roll back inserts, retention
deletes, `sqlite_sequence`, and every unpublished live/registry/session
projection. It is insufficient to prove the database rolled back if a
PlayerSession or active registry already moved. Construction-bound private
AgentRegistry store authority is the companion rule: deleting public `setDB`
prevents a same-named own setter from selecting a different real dependency.

The evidence was 89 tests / 5 files / zero fail / 484 assertions, typecheck
zero, probe 39 no-callers / 86 test-only / 26 should-private, and full Bun
5,405 tests / 494 files / 5,369 pass / 36 skip / zero fail in 587.90s. The
red controls restored `setDB`, removed cohort/identity/missing-row guards,
restored candidate-only projection, or moved consumer completion after commit;
each was restored exactly. The remaining P2 is deliberate and visible: a
successful `remember` fully removed by retention still increments
semanticRevision once. That is conservative invalidation, not evidence of a
durable/live split, and remains open rather than being normalized away.

## Correction: closing a session must revoke reads as well as writes (2026-10-08)

The earlier lifecycle closure was too narrow: protecting mutations and a few
facades still allowed some session-bound readers to observe a close/fail-stop
partially retired cohort. One shared read guard now sits at every dynamic
GameSession reader and retained facade invocation, including party-member SAN.
The same guard applies to ordinary and durable-compiled state projections. A
retained facade may retain object identity, but it does not retain authority:
invocation after closure must fail with the stable lifecycle error rather than
leak a lower-level closed SQLite error or stale in-memory value.

The useful restore regression faults after CompanionManager applied during an
ordinary restore. The target must be closed and unreadable, not merely unable
to take another action. Normal close, direct fail-stop, that restore fault, and
durable compiled close were all red before the correction. A no-op common guard
gave six failures; deleting the party-SAN resolver guard gave one. The
`runAction` entry boundary also must normalize a closed initial generation read
by mode: ordinary returns `ordinary_execution_failed`, durable compiled returns
`compiled_unavailable`.

## Correction: validate a snapshot ledger before folding it into a Map (2026-10-08)

An idempotency array is a historical ledger, not a collection whose identity can
be reconstructed with last-write-wins `Map` semantics. Structural validation
must enforce a globally unique, trim-canonical `actionId` before restore folds
any receipt. Otherwise a re-signed two-generation snapshot can retain the final
record while erasing the first receipt and turn a legitimate retry into a
conflict. Direct validator and restore tests re-sign both a duplicate and a
whitespace-padded record, and assert the target remains unchanged. Restoring
either the uniqueness omission or the missing trim check makes its regression
red.

These corrections cover session-issued dynamic read capability and local
snapshot structural admission only. They do not establish provider exactly-once,
cross-store or cross-process atomicity, power-loss recovery, or general
standalone-component retirement. Final evidence was 144 directed passes across
13 files, typecheck zero, probe 39 / 86 / 26, and full Bun 5,411 tests / 494
files / 5,375 pass / 36 skip / zero fail / 35,946 assertions. The final
standard external preflight also exited zero: boolean implementations/discarded
returns 336/0; document coverage 3 generated / 8 handwritten / 1 structured;
typecheck zero; exact 5,411 / 494 tests and 39 unwiredMethods baseline; and
`core.hooksPath=.githooks`.

## Method correction: cache a complete binding, authenticate an immutable claim, and restore a cohort (2026-10-08)

A cache key is an authority decision. A public source or slot result must not
be cached under the early portion of a binding and later reused after the rest
of the binding changes; the cached lifecycle is the complete binding, and it
includes deterministic rejection as well as readiness. Unknown source work IDs
are a lookup concern, so build the work-ID Map before requests rather than
repeatedly filtering the catalog. Size limits also need to describe the actual
read authority: require absolute regular paths, bound every file and declared
cardinality before parse, and compare the exact observed size across the read
race. Do not count the same proposal or dossier as independently safe merely
because two consumers each reread it.

The bounded public limits used here are intentionally explicit: source files
are 16 MiB each with at most 1,024 manifest entries and 8,192 records; slot
manifest/index/artifact/aggregate are 4 MiB/1 MiB/16 MiB/64 MiB with at most
1,024 manifest entries, 128 bindings, and 8,192 JSONL records. This protects
the first unauthenticated GET, not all deployment or external-model paths.
External opt-in smoke tests remain skipped rather than being presented as
coverage they did not provide.

Invitation claim must be a pure preauthentication operation. Put it before
namespace, catalog, registry, factory, and hydration so a stale source cannot
create a partial object before refusal. The useful A-to-B test uses a real
immutable grant: pre-hydration staleness makes no claim, and claim-boundary
staleness makes no cookie or install while retry of that same grant remains
safe. A hypothetical different-grant successor was a test-design error, not a
condition to accommodate, because snapshot access is immutable. Idempotent
replay still has a durable edge: both an equal existing record and an EEXIST
loser must directory-fsync before issuing the cookie. If sync fails, refuse;
let a later healthy retry repair. Windows EINVAL/EPERM directory-fsync behavior
and temp/expired-claim garbage collection remain open work.

Snapshot restoration must validate a ledger before folding it into runtime
state. For ordinary worlds, `player_state` IDs must exactly equal the
PlayerSession player IDs in every supported schema. This permits p1's
pre-character placeholder but refuses a re-signed future p2 or a foreign row
before restore. Correcting an old negative test that expected the foreign row
is a test-premise repair: it leaves the target invariant, not the product
guard, unchanged.

Red evidence should distinguish a defect from a stale expectation. Here,
rotating the cache key failed two tests; restoring the old unknown-source
filter and removing the source-size guard failed one each; and removing claim
preauth, replay fsync, or the exact-player-set guard made their regressions
red. The first complete 5,439-test run had one failure only because the old
foreign-row expectation contradicted the restored invariant. After correcting
that expectation, the targeted 11-test set and the final full run were green:
5,439 tests / 494 files / 5,403 pass / 36 skip / 0 fail / 36,163 assertions.
This documents a bounded close only: `todo-64`, `todo-65`, production quality,
directory-fsync portability, claim GC, distributed/cross-store/multiwriter and
crash/power-loss properties, deployment, authentication, and external-model
quality remain open. Standard `bun scripts/preflight.ts` EXIT=0: boolean
implementations/discarded returns 340/0; generated/handwritten/structured/
reverse document checks 3/8/1/3; internal typecheck 0; exact 5,439 tests / 494
files and 39 unwiredMethods baselines; and `core.hooksPath=.githooks` with the
commit-msg criterion ran. `docs/notes/index.json` and `docs/architecture.json`
remain intentionally unrefreshed because they have parallel changes.

## Method correction: authenticate snapshot authority before hydration; fence after lease acquisition (2026-10-08)

Snapshot-derived player authority is an authentication decision, not a
convenient consequence of later hydration. Validate the snapshot/header locator
and delivery-cookie or legacy-bearer grant before any namespace, catalog,
registry, factory, or request-body operation. Recovered or adopted winners
need a second identity-and-authority check: the object that finally wins is the
one that must be authorized. This ordering makes invalid/missing grants a
stable `401 no-store`, foreign authenticated legacy bearers a stable `403`, and
denial observably free of later dependency touches.

A lease only serializes current holders; it does not prove that an authority
pointer read before acquisition is still current. After acquire, and before an
irreversible candidate, derivation, or provider operation, reread durable
authority and compare exact namespace, generation, envelope hash, and snapshot
hash. If authority advanced, replay only the same durable action/hash and
return conflict for a different action at the latest generation. A failed
reread is fail-closed, while stale source close/restore and lease/timer cleanup
must remain exact even on every exceptional exit.

The final standard `bun scripts/preflight.ts` exited zero: boolean
implementations/discarded returns 339/0; generated/handwritten/structured/
reverse document checks 3/8/1/3; internal typecheck zero; exact 5,424 / 494
tests and 39 unwiredMethods baseline; and `core.hooksPath=.githooks` with the
commit-msg criterion running.

## Method correction: preserve durable classification and do not mistake zero-timeout scheduling for an invariant (2026-10-08)

When cleanup and listing have different durability obligations, classify the
immutable diagnostic before changing either live memory or the returned source.
Cleanup may evict a process cache without deleting durable metadata; a later
listing may need to recover the durable envelope source before it replaces the
source view. The error shown for a closed durable compiled member must be a
stable public classification, not an internal exception text, and one unavailable
member must not prevent peers from being listed.

Likewise, a shared mutable loader needs an origin decision before any operation
which can read or clear it. Bind the loader instance to a canonical source in
module-private state, then reject a different canonical source before a read or
clear. This avoids the misleading repair in which validation occurs after a
foreign source has already erased valid state. Canonical aliases are equivalent;
independent loader instances are not inadvertently coupled; and a source-pin
rule must preserve intentional missing/malformed clear-on-failure behavior.

Finally, a zero-timeout SQLite admission test must describe the API contract,
not a favored OS schedule. With `busy_timeout=0`, two simultaneous contenders
may both receive typed BUSY even when neither child timed out or failed to
start. Diagnose repeated runs with child exit and stderr evidence before calling
that result flaky. Assert at most one raw winner, typed BUSY/CONFLICT losers,
an explicit caller retry if nobody reserved, and the final durable conflict.
Do not add hidden retries merely to make a one-winner test deterministic.

## Method: current Checkpoint I trust and lifecycle boundaries (2026-10-08)

A public identifier is not its own authority. For compiled-session admission,
the durable authority witness is the persisted, server-owned trusted-presentation
review bound to the `bundleId`; admission must replay the exact source bindings
from the canonical bundle before it publishes. A caller-supplied presentation,
a detached review, or a mechanically plausible bundle without that witness is
not a substitute for the trust chain.

An asynchronous operation needs a publication fence, not merely an entry check.
When opening awaits, close can occur while no JavaScript is executing. The
continuation must therefore prove that its session is still live immediately
before it publishes an opening-derived result. This makes close-during-await a
lifecycle rule rather than a race accidentally delegated to a later closed
resource error.

Session boundaries also own their inputs. CLI `runModule` clones the module
source before session execution so that a caller-held object cannot mutate the
runtime's source view, and runtime changes cannot write back through the same
alias. This is the same authority principle as a durable witness: the value
that selects or affects a session must be owned at the boundary that trusts it.

HTTP catalog errors are a separate public boundary. Map internal failures to a
stable, source-free public response; neither exception text nor catalog/source
diagnostics may become an oracle through the error payload. Test the redaction
at the HTTP surface rather than only testing the internal error constructor.

Trust-chain tests must exercise public admission through the persisted review
and exact-source replay. They may use an explicit scheduling budget to arrange
the real asynchronous interleaving, but that budget cannot replace the
assertions: the test still has to prove refusal without the witness, no
publication after close, source-clone isolation, and redacted HTTP output.
Removing those checks in production made the relevant regressions red, and
restoring them returned the final suite to 5,423 tests / 494 files / 5,387 pass
/ 36 skip / 0 fail. This is Checkpoint I repair evidence only; `todo-64` and
`todo-65` remain open as whole objectives, and Checkpoints II and III are not
entered.

The same worktree's final standard preflight exited zero: 339 boolean-returning
implementations, zero discarded returns, document checks 3/8/1/3, internal
typecheck zero, exact 5,423 / 494 tests, exact unwiredMethods 39, and
`core.hooksPath=.githooks`.

## Method: version durable invitations around immutable authority, not local policy (2026-10-08)

An invitation claim is a durable statement about one immutable grant. A new
schema must persist the grant's exact expiry as `inviteExpiresAt`; it must not
derive that value from whichever invitation TTL configuration happens to be
active during replay, recovery, or another process's authentication. Schema
v2 therefore uses strict exact keys and safe positive integer timestamps, and
binds exact `inviteExpiresAt` into new-write validation, replay/race equality,
and authentication. A real A-to-B regression uses A's 600-second issue policy
and B's 60-second policy, and still requires the persisted A expiry.

Do not merge the cookie's separate capability lifetime into durable claim
identity. A cookie may legitimately authenticate after the invitation itself
expires, until `cookieExpiresAt`; that timestamp is not a replay-equality
input and must not be used to extend a claim or refresh an invitation-derived
expiry. The legacy exact five-key v1 record remains a compatibility boundary:
it reads and authenticates, replays only for the identical digest plus
`claimId`, refuses a different claim, and is not rewritten or upgraded. Since
v1 lacks independently persisted invitation expiry, cookie expiry cannot
safely authorize its deletion.

Red controls must change the authority rule, not merely the test fixture. A
coherent reversion to v1-only writes made the target fail with schema `1.0.0`
and a missing `inviteExpiresAt`; deriving expiry from B's current TTL made it
expect `1700000600000` but receive `1700000060000`. Both controls were
restored. The dedicated regression exited zero at 11 passes / 207 assertions,
and typecheck exited zero. The authoritative complete suite exited zero at
5,440 tests / 494 files / 5,404 pass / 36 skip / zero fail / 36,222 assertions
in 704.38s. The final standard `bun scripts/preflight.ts` exited zero: boolean
implementations/discarded returns were 340/0;
generated/handwritten/structured/reverse document checks were 3/8/1/3;
internal typecheck exited zero; the exact 5,440 / 494 test and 39
unwiredMethods baselines matched; and `core.hooksPath=.githooks` with the
commit-msg criterion ran.

Versioned schema alone is not a garbage collector. The claim root still has no
quota, bounded enumeration, or cross-process lock, and temporary crash
leftovers may grow without bound. A future v2 collector may delete no earlier
than `max(cookieExpiresAt, inviteExpiresAt)`; v1 cannot use the analogous
cookie-only rule. Any collector also needs a bounded safe scan, root/leaf
identity without reparsing, a shared coordinator, directory fsync after
unlink, and operator-owned startup integration. None of those mechanisms is
implemented by this hardening slice.

## Bounded two-module validation record (2026-10-09)

The root-directed targeted suite passed: 45 tests in 7 files, 639 assertions,
and typecheck exited zero. Four real red-to-green controls were restored:
the backstory's hardcoded `他`, Barn source-free preparation, inferred-adult
provenance, and the random-KP fallback. This is evidence for those bounded
regressions, not a production-quality or external-model-quality claim.

Barn's ordinary `GameSession` path was safe offline; a live attempt produced
fallback output, so it is not evidence of real narrative quality. Fuzu's old
graph-1.0.0 artifact was correctly refused. The former current-schema script
failure was reproduced as a detached frozen `activeCharacter` write and then
repaired **only** in the benchmark script: its owned ordinary snapshot now has
the legal `medicine` seed rather than synthetic `idea`, while the existing
deterministic d100 behavior and production guards are unchanged.

The fresh current-PDF guarded CLI exits 0; its helper import is safe and the
joint typecheck exits 0. This benchmark-only path exports
`compileCurrentFuzuAcceptance`, is not a production entry point, and
retains temporary cleanup. Its local, no-provider aggregate is: 22 scene
candidates / 3 clues / 3 items / 32 NPC anchors / 197 questions; 50 tracked
plus 9 reviewed answers; deterministic fake input in 3 requests / 46 calls
gives 195 answered / 0 open / 2 not-applicable. The resulting runtime has 6
playable scenes, 7 clues with methods, 1 item, 2 NPCs, 1 dialogue, 2 endings,
227 states, 0 blockers, and 0 issues. Two `GameSession` ending witnesses use
5 actions with the stone and 4 without it; artifact hash is
`29e86f602e37a11672bdd6f812b1387535c41dfae9193a87dbaaaa2983780644`.

The new diagnostic no longer depends on old JSON. Its fresh local offline,
escalated report (`omqxGw`) succeeded with zero provider requests: Barn was
sampled through the verified `premiers_barn` ordinary runtime with
`not_real_model` quality; Fuzu was sampled through the compiled runtime from
the current-PDF benchmark hints, with the artifact above and two reachable
endings. Fuzu contextual narration remains unsupported and its quality remains
incomplete; this local benchmark is not evidence of a production autonomous
model. Old physical files were retained rather than deleted.

External retry was denied because source-upload consent was unavailable; no
workaround or endpoint status is recorded. The pre-change preflight exit 1
remains baseline-only evidence (5,448 tests / 497 files / 5,410 pass / 38
skip, typecheck zero, unwiredMethods 39).

Root's authoritative full `bun test` then exited 0: 5,470 tests / 501 files /
5,432 pass / 38 skip / 0 fail / 36,736 assertions / 553.58s. This shared dirty
worktree is +30 tests / +7 files / +28 pass / +2 skip over the 5,440 / 494 /
5,404 / 36 baseline; those deltas are not attributed wholesale to this
two-module slice. The 38 skips are 32 retired `old32state` cases, four
unverified Windows symlink/junction-capability cases (`derivedLockSymlink`,
`rootFileSymlink`, `rootDirectoryJunction`, `suppliedRootJunction`), and two
opt-in cases (`worldModelManifest`, `sourceArtifact`). The earlier 36-skip
capability mix was not rebuilt, so this does not claim skip-coverage
equivalence. The full run started before the strengthened identity assertion;
root ran that late harness separately, EXIT=0: 7 pass / 1 file / 14 assertions.

Post-update standard preflight job 83536 exited 0: the 5,470-test / 501-file
baseline matched, internal typecheck exited 0, `unwiredMethods` remained 39,
boolean implementations/discarded returns were 346/0, and hooks ran normally.
The final broad targeted run hit Windows sandbox Bun-child `EPERM` only in two
wiring cases (48 pass / 2 fail); that wiring file alone passed 5 tests, and the
same eight-file command under normal escalation exited 0 at 50 pass / 651
assertions. `todo-52`, `todo-64`, and `todo-65`, and the wider production goal,
remain open. `docs/notes/index.json` and `docs/architecture.json` remain
deferred because they have parallel changes; no generated now/handoff record or
commit/push was made.

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
exited 0. The correction records
that ordinary ending/discovery `spec.id` is a submitted, source-cited mechanism
declaration retained in accepted mechanics IR; it is not a compiler-rewritten
label. Server-derived runtime-ID limits remain scoped to automatic
`npc_binding`, `clue_fact_facets`, and `source_fact_mechanic`. The sanitized
report exposes only approved stage/code/count aggregates; it distinguishes
approved adapter stages, collapses unknown codes to `other`, and never emits a
diagnostic message, source ID, prompt, or response.

Authorized compiler probe 38730 completed natively and in capture with EXIT=0
and a complete sanitized report. It made 18 external calls under the existing
budget; isolation recorded one pair, two identity refusals, two modules, and
two documents. Fuzu: 197 total, 7 answered / 188 open / 2 deferred, 7
accepted, 9 calls, 3 responses, draft-only, not closed, zero ending witnesses,
with `operation_aborted`. Barn: 410 total, 8 answered / 377 open / 25
deferred, 8 accepted, 9 calls, 3 responses, draft-only, not closed, zero
ending witnesses. Fuzu aggregate diagnostics were chunking request-cap 139,
model failure 5, and orchestrator abort 1. Barn had chunking request-cap 286
and oversize 2, model failure 5, proposal `other` 1, and orchestrator abort 1.
The surfaced provider failures were timeouts. `proposal:other` cannot identify
its underlying diagnostic without intentionally violating the raw-content
privacy boundary, so it is not treated as a semantic-quality conclusion.

This improves on the earlier 3/0 accepted-answer probe but is not a quality
comparison, statistical result, or complete autonomous compile: only three
responses per module arrived and both queues remained overwhelmingly open. The
earlier 9877 native EXIT=0 has no preserved detailed result because its
collector accepted only a standalone `{` and missed the one-line JSON; no call
count or quality inference is made from it. A later offline capture reporting
two modules and zero external calls only validates capture handling. The
baseline was 5,472 / 501 before the final run. Root full-suite session 4567
subsequently exited 0: 5,486 tests / 502 files / 5,448 pass / 38 skip / 0 fail
/ 36,919 assertions in 741.23s. This is +14 tests / +1 file / +14 pass, with
skips unchanged; the new file is `npc-memory-provenance`, and additions are
concentrated in adapter citation/diagnostic aggregation, receipt focus, and
loader source-knowledge validation. Standard preflight 44873 subsequently
exited 0: boolean implementations/discarded returns 349/0;
generated/handwritten/structured/reverse document references 3/8/1/3;
typecheck 0; exact 5,486 tests / 502 files and `unwiredMethods` 39 matched the
baseline; and `core.hooksPath=.githooks` with commit-msg ran. This validates
only the currently frozen source hash, not a later narration feature. No
budget increase, staging, commit, or push occurred.

The adjacent NPC initial-knowledge bridge has only its own narrow evidence:
20 tests / 181 assertions with three real mutations restored green. Review
still requires background-fact availability, arbitrary parenthesized alias,
and knowledge-array validation. The focus diagnostic is currently offline-only
(13 passes / 1 file / 44 assertions); its provider-receipt mutation was
restored after the expected two failures. A real focus attempt was rejected at
permission review before any external request and awaits explicit consent to
send both PDFs to the configured external model. Global guidance remains
untrimmed, compiled contextual narration is unimplemented, and `todo-52`,
`todo-64`, `todo-65`, and the broader production goal remain open.

The bounded compiler probe's 7 accepted Fuzu answers and 8 accepted Barn
answers remain draft-only, not a completed autonomous compile. Directed
coverage included real adapter and NPC-provenance mutations made red and then
restored. The real NPC focus remains rejected at permission review before any
provider request and awaits explicit consent to send both PDFs to the
configured external model. None of this completes the production goal.

## Bounded two-module/NPC verification closure (2026-10-09)

The frozen source slice has the full-suite and standard-preflight evidence
above, but this is not a production-goal completion. The compiler remains
draft-only and real NPC focus made no provider request because permission
review required more explicit two-PDF consent. This file has new bounded
compiler, NPC, and focus records, while `docs/notes/index.json` is deliberately
stale and `docs/architecture.json` remains unrefreshed due to parallel work.
Root refreshed now/handoff with the existing `--no-test` script: an initial
sandbox Git-spawn EPERM was followed by a normal approved EXIT=0 run, without
configuration changes. The next compiled-player plan is unimplemented: it must
retain the exact random/date-sensitive candidate durably, use a host-only
provider capability, bind receipt and frame identities, and apply the same
candidate CAS rather than replaying preparation. The 44873 preflight covers
only the prior frozen source hash, not that future feature.

## Corrected bounded live NPC probe record (2026-10-10)

The user explicitly authorized the configured-model request for this bounded
probe. Native run 17395 exited 0 and wrote its sanitized report to the local
temporary `aitrpg-two-module-narrative-BjQrKB/report.json`; it observed four
of eight permitted provider requests, with a 600-token limit and a 180-second
global deadline that was reached. This corrects the earlier “awaits consent”
status: consent was obtained for this probe, but the result is not a quality
pass. Barn has two real provider dialogue receipts whose content hashes exactly
match their recorded dialogue hashes. The second receipt's claim that the
mother's last telephone call was “about half a month ago at dusk” has no
identified source basis and remains subject to the separate source-grounding
review. Fuzu remains a benchmark-only unsupported contextual-narration path.
The new candidate/receipt production path is still under development review;
neither the 5,486-test full suite nor the prior preflight may be reused as
green evidence for it.

## Player façade presentation rendering: bounded verification (2026-10-10)

`PlayerApp` now renders only the sealed player view's reviewed current scene,
discovered clues, optional selected ending, and persisted latest-turn text. It
does not render history, raw identifiers, or a list of endings. Turn text uses
Vue interpolation rather than HTML insertion, and an absent turn does not
claim provider success. The focused test compiles the actual Vue SFC for SSR
and renders a reload-shaped player view; it began at 9 pass / 1 fail / 90
assertions because the old template omitted the authorized presentation, then
passed at 10 / 0 / 104. The direct mutation that hid the presentation block
made the same focused test fail at 9 / 1 / 90 before restoration; the restored
source again passed 10 / 0 / 104. Its SSR compiler configuration now supplies
the descriptor CSS variables, so the directed run has no Vue css-vars warning.

Root independently reproduced that directed result. A production Vite build
first failed only at sandboxed esbuild startup with EPERM; the approved rerun
against the same fresh temporary build root (identified locally by
`9db4439d5b1f4fbdb7521274415022be`) exited 0, built 33 modules in 853 ms, and
left that output intentionally to protect prior artifacts. The nonempty-output
notice is not a quiet build warning. This is not a deployment or live-browser
UI observation, and the earlier 5,486-test full suite and preflight do not
validate this new presentation feature.

## Compiler proposal dependency-priority ordering (2026-10-10)

The former global `questionId` lexical order was an implementation detail, not
the autonomous-closure contract. Proposal scheduling now ranks verifiable
queue and graph conditions: publish-blocking scene-role prerequisites first,
then other publish blockers, then a source-disposition whose deferred child
has a verified playable owning scene role, then otherwise eligible mechanics
and NPC decisions, and finally ordinary warnings. `questionId` remains the
deterministic order only within the same rank. This does not loosen
eligibility, unsupported/deferred/oversize rejection, chunk limits, request
or token budgets, and it neither changes `queueHash` nor conflates its purpose
with the independent request hash. Repeating the same snapshot must yield
identical complete calls, messages, options, and request hashes.

The directed regression used a real generated queue in which a lexically
earlier warning occupied the one-question cap while its owning scene-role
prerequisite was omitted. It failed before the rank change, passed as 27
adapter tests after the repair, failed again as 0 pass / 1 fail when the
comparator was mutated back to global lexical order, and passed after that
mutation was restored. Root independently ran the adapter and real-acceptance
coverage: 32 pass across 2 files, 352 assertions, EXIT=0 in 716 ms. This is
evidence for deterministic prioritization and continuation progress, not a
claim that one bounded round completes a compiler queue: the per-round 48
budget is not an answer for all 197/410 questions or a closed-world result.
Historical `unpartitionable` wording must not be treated as a statement that
the current queue has only two oversize items.

Autonomous publication remains hard-stopped at `presentation_draft_only`.
The production goal is therefore still open; this scheduling repair is not a
substitute for a verified publishable presentation authority.

## Compiled player narration: durable boundary and bounded verification (2026-10-10)

The narrated player-action path has a narrower durability contract than a
mechanics retry. It prepares and stores the exact private mechanical successor
before provider dispatch, including its settled entropy and timestamp-bearing
snapshot, and revalidates the candidate against the live trusted projection
before exposing a player-safe before/after frame. A receipt is provider prose
bound to that candidate: receipt or committed rows are consumed through the
normal snapshot CAS without another provider call, and receipt evidence is not
quarantined merely because a later CAS, fence acknowledgement, or live-session
installation is unavailable. Prepared-only recovery remains exact to the
session/generation/action/request lease binding; it cannot clear a different
action's lease. Mechanics-only receipts retain the legacy v1 request hash;
provider narration uses the distinct v2 hash, while legacy snapshot schemas
continue to validate with v1.

This record corrects a timeout interpretation. Two initial default three-file
runs reported 14 pass / 1 fail because the real three-source era case reached
the default 5,000 ms test timeout. The era assertion was not weakened; its
test now has an explicit 30-second allowance. Root then independently ran the
same three focused files with `--parallel=1 --timeout 30000`: 15 pass / 0 fail
/ 319 assertions, EXIT=0 in 45.58 seconds. The latest typecheck also exited
0. Root's standard `bun test --parallel=1 --timeout30000` session 2419 then
exited 0: 5,500 tests / 504 files / 5,462 pass / 38 skip / 0 fail / 37,017
assertions in 1038.17s, a +14 tests / +2 files / +14 pass change from 5,486 /
502 / 5,448 with skips unchanged. The separate default CLI session 74755 also
exited 0 at the same test/file/pass/skip/fail counts, with 37,063 assertions
in 954.91s. Standard preflight 92567 then exited 0: 355 boolean-returning
implementations / 0 discarded returns; references 3 / 8 / 1 / 3; internal
typecheck 0; exact 5,500 tests / 504 files and unwiredMethods 39 matched the
baseline; and the `.githooks` hooksPath criterion ran. A separate local
Cthulhu scope smoke 36747 exited 0 at 29 tests / 3 files / 1,535 assertions /
13.26s, using only a process-temporary local data path, fake provider, and
fixture artifact scopes. It is not Fuzu/Barn production binding, did not alter
`.env`, and sent no data externally. This evidence verifies the frozen
5,500-test batch; main's newly started worldguard-ownership changes are not
covered and must not be called all-green evidence. The production goal remains
open. No additional provider API call, commit, or push occurred.

The era disclosure remains deliberately limited. A year enters the narration
frame only when reviewed source metadata supplies an accepted four-digit year;
unknown era is omitted from the frame and the prompt tells the model not to
infer chronology. The system does not claim post-generation textual-era
grounding: there is no semantic dialogue-text year checker. The accompanying
read-only audit found no additional candidate, receipt/CAS recovery, or hash
compatibility blocker in the frozen implementation, subject to that stated
prompt-only limitation.

`docs/notes/index.json` and `docs/architecture.json` remain deliberately
unrefreshed because of parallel changes. The current architecture index has no
compiled-narration-ledger, compiled-narration-admission, or player-narration
entry, and the notes index has no current durable-boundary record title. The
three new runtime modules and this engine methodology/verification record are
therefore explicit handoff indexing work, not evidence that those documents
were refreshed. Root will use the existing now/handoff generator with
`--no-test`; this note does not alter AGENTS guidance.

## World-narration publication guard: bounded evidence and correction (2026-10-10)

The new guard is a host publication boundary: it evaluates the action's
allowed source/scene scope, reviewed era where available, and the player-safe
before/after state before a narration receipt can be published or committed.
The visible fact domain is the relevant before/after union, so a fact first
discovered by the action is available after it; it is not silently dropped for
having been absent before. This does not turn a finite set of lexical and
structural checks into free-text semantic entailment. Separately, the ordinary
NPC first turn was already covered by `SYSTEM_PROMPT_PREAMBLE` rule 5; the
empty-memory formatting path only omits a duplicate memory block, not that
global fact/date boundary.

Root's independent session 6167 exited 0: 76 tests / 4 files / 0 failures /
504 assertions in 66.94s, and root typecheck exited 0. Six direct source
mutations each produced EXIT=1 and were restored green: server gate 422→503;
before/after union reduced to after-only, changing the existing `空荡荡` case
422→200; removal of the separately covered `空无一物`; ignored 1893
telephone-era handling; cross-scene technical authorization 422→200; and a
commit-gate bypass advancing an otherwise forbidden receipt g0→g1. The owner
restored and froze the source. Fuzu 84119 ended EXIT=1 with `slot_ambiguous`
before HTTP, so it is neither a provider call nor a core guard mutation.

This is bounded guard evidence, not a claim that generation is fully grounded
or quality-accepted. Autonomous two-PDF publication, real model-quality
evidence, and actual production world-model binding remain open; it adds no
permanent manual-review requirement.

## Machine publisher and scoped world consumer: method-boundary correction (2026-10-10)

The default server constructs the machine presentation publisher without a
manual-producer injection; a test LLM is only a host enable seam. Model reports
remain untrusted audience input. Host field policy plus catalog replay must
validate complete canonical-slot coverage, and `source_exact` alone grants no
player visibility. The bounded packer retains 16 mechanics and 16 selector
items within 24k, shares one 32-chat guard per job, allows one attempt, and
selects only from the first eight candidate pages. Those finite bounds do not
prove all-candidate optimality or an NLP semantic-form guarantee. Trusted
machine service authority is permitted; this does not establish a permanent
human-by-human field approval policy.

Root independently recorded publisher/lifecycle 40 pass / 0 fail / 628
assertions across 2 files in 67.81s, complete host world-model 15 / 0 / 105
across 1 file in 24.06s, frozen campaign 23 / 0 / 102 across 1 file in 202ms,
and root typecheck exited native 0. These are directed only: the old full session 2008 and
preflight 89701 are earlier frozen-batch evidence, not current full acceptance.
The later current-tree full session72048 is terminal native EXIT=0 at 5,560
tests / 507 files / 5,522 pass / 38 skip / 0 fail / 37,432 assertions in
1035.14s. Standard preflight77024 then exited 0 with matching 5,560 / 507
baseline counts, typecheck 0, unwiredMethods 39, 369 boolean implementations /
0 discarded returns, and `core.hooksPath=.githooks`; all 975 preflight-input
before/after records had `changes=[]`. Root's `now`/`handoff --no-test` and
review-bundle generators also exited 0. The source/config capture began 1m23s
after test start, so it is not described as a pre-start snapshot. This is a
frozen-tree regression gate only. Autonomous two-PDF publication, actual play,
real-model quality, and production world-model binding remain open, and later
host-wiring work is not covered by this gate.

Restored publisher mutations cover missing default factory
(`presentation_draft_only`), treating private model audience as ignorable and
refilling by field default (422→200), removing the >24k packing split (two
calls→one), and deleting the shared-32 dispatch guard (33rd dispatch resolves).
The old missing-audience shape is only a 500→503 capture regression, not the
first proof of automatic public release. Three further recovery boundaries are
now owner-verified and frozen; root's later two-file rerun covers them: fresh resumed
missing-review stays 503 with one selector/no bundle; legal draft-warning
progress gets a new continuation/resolved hash/review/bundle while preserving
the earlier bundle; and an atomic start survives a fake 10ms deadline while a
late selector is write-refused. Owner evidence is 10 focused pass / 74
assertions / 31 filtered / EXIT=0 in 20.71s plus typecheck 0; all mutations were
restored. Root independently reran the complete two-file set natively: 44 pass
/ 0 fail / 660 assertions in 73.11s. This confirms the directed recovery slice,
not a full gate or the broader publication/quality goal.

The host world evidence uses a structured real-PDF-format fixture, then actual
prepare, queue-bound fake hints, canonical catalog publication, `handleRequest`
session/action creation, and observable snapshot-validator/trace-delta progress.
The resolver is host input only, never PDF/LLM/HTTP authority. Its two local
Cthulhu single-work scopes each receive a fresh resolved-artifact-hash binding
and local session-opening receipt without transport. Required scope without a
resolver is `consumer_refused` with zero consumed/action/receipt; foreign module
or hash is likewise refused, while non-required ordinary scope remains valid.
The enforcement point is the consumer, so it is not a claim of pre-publication
blocking. A world-state witness is not a world-model binding, model-use proof,
or generated-quality result.

### Host closure, machine selection, and same-generation follow-up boundaries (2026-10-10)

A green directed test is not evidence that the whole host chain is closed. The
current root-native host run is `19 pass / 12 fail / 119 assertions / 31 tests /
36.76s`; current changes are not frozen, so neither this result nor any
single-slice green result may be recorded as all-green acceptance. For ending
source diagnosis, `candidateCount === 0` or an absent opaque token is likewise
not proof that source material is absent: terminal slots have no opaque
alternative, and the only admissible evidence is the accepted ending
interpretation's `sourceStatementIds`. The queue uses heading-scoped sources
when an explicit ending heading exists and otherwise the graph; ordinary hint
resolution must preserve its question's exact source IDs, not invent a broader
resolver fallback. Compare ordinary and machine pages only for the same
artifact/slot. The latest heading-only artifact was `ordinary=1, machine=1`,
and the accepted new body interpretation has a parsed statement ID. A former
false exact-text result was a raw-PDF-layout versus parser-normalized-string
comparison error, not evidence loss or a machine-clearance failure.

Candidate-page `offset` and order hash are page metadata, not candidate
properties. The canonical candidate retains its non-enumerable, host-only
source-range brand; page metadata is carried alongside it, and a spread/clone
must not silently discard that brand or mask the resulting type error. For a
same-generation NPC follow-up, facts may be formed only from the actually
published, own, found clue `name`/`revelation` values in deterministic order,
never from the full `relationshipQuote` evidence. Its source/contact binding,
typed MAC chain, and independent admission record fence a single-ledger
rollback; they do not establish resistance to rollback of the entire persistent
root. The real race-first red path was a closed-session read while formatting a
conflict; the repair returns 409 without reporting a stale generation, and the
old implementation was restored to reproduce red then green.

Terminal coverage must retain every leaving branch's terminal path, an actual
`Ending` paragraph, and a generated queue that permits multiple declarations
in the same scene. Replacing an Exit-plus-item gate with a Dock second Talk is
not equivalent when it creates two deadlocks, and a stale scene/token 409 is
not a terminal-gate red. The bounded terminal target was `1 pass / 9
assertions` natively; its guard mutation genuinely changed expected 409 to 200
and provider calls remained zero after repair. Finally, a single scoped
follow-up prompt without prior dialogue cannot establish conversational
continuity. Quality evidence still requires fresh-PDF machine publication for
both modules, player intents/actions/narration, two referential follow-ups, and
observable world binding; actual external calls remain zero and model quality
is unverified.

**Module/slot correction.** The measured Fuzu ending slot is
`ordinary=1, machine=1`; Barn's `benchmark_exit` slot is `0`. These are
module-and-slot observations only: they neither establish a global missing-
source condition nor identify a global machine-clearance/guard cause.

### One accepted exchange is continuity, not new source authority (2026-10-11)

The earlier single-frame follow-up warning remains a valid methodological
boundary, but a narrow production continuity slice is now implemented and
frozen. The client supplies only an untrusted `previousActionId`. A v2 follow-up
ledger row stores the accepted exact question and server-computed `contextHash`
alongside the existing source/request/frame binding. The request hash and
prepared/dispatch/receipt MAC chain bind the selected context. New/prepared
dispatch rereads the prior settled v2 row and requires an independently settled
admission receipt, three valid MACs, a reconstructed question hash, and equal
session/bundle/generation/scene/NPC/clue/facts/contact/frame scope. The prompt
receives one exact prior question/reply as `previousTurn`; it does not append
the answer to player input or enlarge the authoritative `releasedFacts` set.

Replay and inheritance are deliberately different. A settled current request
can replay its verified receipt without a provider call after predecessor
deletion, and terminal exact replay remains legal. Deleted or unanchored prior
rows cannot authorize a new dispatch. Old v1 rows keep their replay/prepared
recovery behavior but cannot supply a guessed question. The one-exchange bound
is 1,000 UTF-16 units for the question, 2,000 Unicode characters for the reply,
and 3,000 Unicode characters in total; no recursive history/global memory or
world-model facts are introduced.

The actual loopback HTTP test file passed 8 tests / 205 assertions, independently
reproduced by root. A naturally referential second question, not a pasted first
reply, reaches a prompt containing the verified prior exchange. The suite also
executes ledger/admission tampering, source/frame/generation refusals, host
restart, v1 compatibility, bounds, and zero-call exact replay. Real mutations
that removed the v2 context-hash identity binding and enabled recovery of a
predecessor dispatch admission produced 409→200 failures (0/1/56 and 0/1/100);
both were precisely restored and the tamper target returned 1/0/117. Related
facade/recovery coverage was 27/0/485, with typecheck exit 0. This tests prompt
continuity and authority, not whether a real model understands references well.

Root's controlled formal full-quality integration now passes 8 tests / 263
assertions across three files in 33.58s, including entry-NPC and second-scene-NPC
synthetic PDF pairs, public navigation, actual player intent/action routes, and
exact follow-up context. The synthetic Fuzu/Barn labels do not turn those
fixtures into actual business PDFs. Every upstream response is intercepted;
no external-provider conversation exists here for a naturalness assessment.
Actual two-business-PDF compilation and paired real-provider quality comparison,
as well as the final shared-tree full-suite/preflight gate, remain pending.

The remaining default-auth restart-child 503 was separately diagnosed without
provider calls. A plain `Bun.spawn` bypassed the test preload and did not inherit
its parent's JavaScript env changes; importing only the enabled predicate in a
child showed `disabled=null, enabled=true`, versus `disabled=true, enabled=false`
with explicit env. The test now gives that offline auth/restart witness
`env: { ...process.env, LLM_DISABLED: "true" }`. All auth/restart/action
assertions remain; no production fix or provider-receipt quality is claimed.
The file passed 11/0/211, independently rerun by root at 11/0/211 in 25.8s.

The open AI Player integration should reuse `PlayerAgent`'s personality,
background, goal, and last-three-exchange prompt, not its old runner's
core-clue-ranked movement fallback. Its LLM proposes action prose from only
personal character information, `player-view` public fields/action labels, and
confirmed public results; the existing model-intent API then supplies an opaque
action for normal execution. Hidden IR, witness plans, unreleased clues/endings,
or internal scene routes cannot guide the agent. Acceptance must cover genuine
public forks, distinct reasonable role-goal choices, changed plans after an
actual failure, clarification when observations are insufficient, and isolated
module/session history with no advance ending knowledge. Generic public actions
do not justify filling their missing detail from internal witnesses. Failed
model calls and fallback/template choices are separate evidence, not real-model
quality. This is a pending plan under open todo-65, not an implementation or
permanent manual approval policy. This note does not edit protected indexes,
architecture, AGENTS, frontend, host, or any frozen production source.

### Standard-environment continuity checkpoint and next-slice boundary (2026-10-11)

Root full session90243 was genuinely red: native EXIT=1, 5,645 tests / 511
files / 5,604 pass / 36 skip / 5 fail / 38,492 assertions / 1058.46s. It
injected OS `LLM_DISABLED=true`, unlike the repository's JavaScript preload
default. The exact three-file fake-fetch comparison reproduced the explicit
opening, cancellation pair, and HTTP500/AbortError pair as 10 pass / 5 fail /
40 assertions / EXIT=1 in 6.29s. Removing OS `LLM_DISABLED` and `LLM_MODE`,
while retaining repository preload and external-network blocking, restored
15 pass / 0 fail / 67 assertions / EXIT=0 in 3.79s without any file edits.
Each provider-capable Worker replaces fetch before construction/request and
does not delegate to real transport. This is evidence of an environment
precondition failure, not a production fix or permission to weaken checks.

Root's subsequent standard-environment full session65094 terminated native
EXIT=0: 5,645 tests / 511 files / 5,609 pass / 36 skip / 0 fail / 38,495
assertions / 1028.88s. The collector took 1,029,699ms, drained stdout/stderr
123,565/1,124,258 bytes, and the 865-file source fingerprint had `changed=[]`.
This verifies its frozen source tree only; standard preflight remains unverified
and subsequent AI Player edits are not covered. No final baseline update is
made while that next implementation slice will add tests.

The newer raw skip list accounts for 36 cases (retired ending-state 32,
Career file-symlink capability two, configured research artifact/world-model
opt-in two). No per-case skip list for the historical 38-skip session72048 was
found. Its reduction cannot be attributed to particular tests from summary
counts alone, nor inferred merely from newer directory-junction passes. No skip
condition was changed to force a number; preserve this historical-evidence gap.

Frontend continuity is directed-verified after restoration: root independently
ran two files at EXIT=0, 27 pass / 208 assertions; the owner ran five files at
55 pass / 378 assertions, with build and typecheck EXIT=0. Real production
mutations omitting POST previousActionId, replacing a pending retry's original
pointer with a later caller pointer, removing contact/generation/terminal/scope
cleanup watching, and bypassing unknown-2xx status/reply/view validation all
went red, then were restored. They caught Vue continuity, frozen-retry, stale
contact-switch rendering, and API/UI validation failures respectively. Do not
invent mutation exit/assertion counts that were not recorded.

AI Player integration is now in progress in a separate slice, with its earlier
public-view/role-goal/failure-replanning/clarification/module-isolation acceptance
still outstanding. Actual two-business-PDF compilation/publication, paired real
provider language quality, production source-bound world scopes and model-use
evidence, and final preflight remain open; current fake text cannot establish
human-like language quality. todo-65 remains open. This checkpoint runs no gate
or generator and does not edit baseline, now/handoff, indexes, architecture,
AGENTS, frontend, host, or frozen production source.

### Verify controlled slices without promoting a red full run (2026-10-11)

The public-only AI Player adapter is now directed-verified: four changed files
add 22 tests in two new files; the owner's restored five-file run passed
52 tests / 242 assertions in 84.76s and root typecheck exited 0. Its strict
instance-bound action-prose decision and public rollout operate on public
observations/confirmed results through existing intent/opaque-action routes.
This is an offline adapter, not live budget/CLI wiring or production autonomy.
Four real implementation mutations each exited native 1 and were precisely
restored: proposal-history contamination (2 fail/13 assertions/2 files),
private scene spread (2/6/1), first ambiguous-candidate selection (1/3/1), and
continuing after uncertain commit (1/3/1). Their restored green does not attest
real-provider language quality.

The UI's ambiguous response carries `topicBound` at the response level, not
inside a candidate action. Losing that binding incorrectly refused the user's
explicit candidate choice. Its two-file fix adds four tests; root independently
passed 31/0/232 across two files in 407ms with build 0, and owner coverage was
59/0/402 across five files. Four actual frontend implementation mutations each
exited native 1 and were restored; root typecheck is 0. These directed results
complete only the controlled fixes, not the final shared-tree gate.

Root full57520 exited native 1 at 5,671 tests/513 files/5,634 pass/36 skip/
1 fail/38,723 assertions/1720.66s, with stdout/stderr 275,964/1,268,037 bytes
and 877 fingerprinted inputs unchanged. The first full-quality route case's
30s outer harness timed out at 40.89736s. Root approved only that case's 60s
full-chain harness budget after unchanged directed reruns; product deadlines
and assertions stayed intact. The changed directed file passed 2/0/49 in
16.61s. No proved load explanation is inferred from the timeout.

Root full59530 then exited native 1 at 5,671 tests/513 files/5,634 pass/36
skip/1 fail/38,679 assertions/1725.98s, with complete capture and 870 inputs
unchanged. The route case passed; the sole ordinary admission multi-process
witness reported child exit before the expected event, without a diagnostic
exit-code/signal cause. The unchanged admission file passed 20/0/263 in 9.57s
and its exact singleton 1/0/9 in 2.30s. Missing post-drain event recheck is only
a candidate helper race; the authorized deterministic red proof is in progress,
not a confirmed full-run root cause or completed fix.

Latest full results remain red: do not refresh baseline or claim a new standard
preflight green. Observed growth is +111 tests/+6 files over 5,560/507: the
earlier 5,645/511 checkpoint contributed +85/+4, then AI +22/+2 and UI +4/+0.
The historical 38-skip list is still unavailable, so do not invent a per-case
cause for the present 36. Actual two-business-PDF publication/quality, real
provider dialogue, production world scopes/model use, and live runner budget/CLI
remain open. todo-65 stays open; protected index/architecture refresh is deferred.
This append does not alter baseline, now/handoff, AGENTS, source, or run a
gate/generator.

### Admit a proved harness repair and a native full green (2026-10-11)

The ordinary admission exit/drain candidate is now proved as a test-harness
defect by deterministic red cases against all three original guards. After
awaiting stdout/stderr drain, each helper must recheck its event queue before
throwing child-exit failure. Only the test file changed (+9 tests/+0 files);
the existing business describe and all deadlines stayed byte-exact. A real
mutation deleting all three repaired guards exited native1 at 0 pass/3 fail/
2 assertions/1 file/276ms (capture1791694346891). Exact restore hash
`406ba00470323c4be97352aca5bcb7378940b8036673edaad073e9e66d7978de`
passed 29/0/279 across one file in9.82s, native0 (capture1791694383447).
This does not retroactively prove the cause of full59530; both prior red full
records and the route-only outer harness adjustment remain preserved above.

Root standard full88120 (`bun test --parallel=1 --timeout 30000`) terminated
native0/signalnull/no capture error: 5680 tests/513 files/5644 pass/36 skip/
0 fail/38728 assertions/1619.06s. Inner capture1619741ms retained stdout280820
and stderr1268531 bytes at
`analysis/diag/two-module-capture-1791696102950.{stdout,stderr}.log`; all870
frozen input hashes had changed=[]. Native summary/verdict is authoritative;
the unconditional bounded diagnostic also finds expected negative-fixture
exceptions, which are not actual full-suite failures. Root quick80436 exited0:
boolean390/discard0,typecheck0,unwired39,hooks correct; its skipped tests/counts
are not a final standard preflight result.

Baseline is raised to5680/513/5644/36/0 with unwired39 unchanged, preserving
all old history. The +120 tests/+6 files from5560/507 consist of shared net
65094 +85/+4, offline AI +22/+2, UI +4/+0 and harness +9/+0. Historical38skip
has no retained per-case list for the present36 comparison; do not fabricate
the two individual causes or change skips to match. now/handoff --no-test
refresh documentation only, not test evidence. Final standard preflight,
actual two-business-PDF/provider quality, production world scopes/model use,
and live runner budget/CLI remain open; todo-65 is open. Protected notes index,
architecture and AGENTS stay untouched, so this engine-note append and the
new public rollout runner/test paths have an explicit deferred indexing step.

### Keep the red gate while correcting a random SAN fixture (2026-10-11)

Standard preflight90733 exited1: KP-panel SAN expected44/received43 in
world-state-truth-source,one test failed,pass5643!=baseline5644,bun test EXIT1.
Typecheck0,bool390/discard0,refs/hooks/unwired39 were normal;876 hashes were
unchanged,capture1216264ms,stdout1656/stderr0 bytes,logs
`analysis/diag/two-module-capture-1791697804091.*`. Earlier88120 full green
does not turn that gate green.

Controlled entropy established the ignored Result/random-premise error:
LCG722 gives POW/max43,set44 returns value_out_of_domain,all three reads
unchanged43; constant.25 gives61,set44 succeeds and all three reads equal44.
The positive test now fixes existing entropy and checks Result,retaining
expected44 and inventory/weapon assertions; a legal low-POW refusal adds1
test/0 files. Related60pass/255assert/6files/1.95s,typecheck0. Two real source
mutations exited1: skipped persistence leaves world61!=44 (1791698299616);
bypassed refusal creates out-of-range SAN and restore refusal (1791698342166).
Production exact restoration SHA256 is
`588b3a32ca891ebf9087aaee30b7b51bc7726405105c379f72ac7c99ef09feb0`.

Root plain bun test full72737 native0/signalnull/no captureerror passed
5681tests/513files/5645pass/36skip/0fail/38709assert/922.63s,capture922821ms,
stdout270701/stderr1479566 bytes;870 frozen hashes changed=[],rawlogs
`analysis/diag/two-module-capture-1791699487120.{stdout,stderr}.log`.
Baseline5681/513/5645/36/0 retains unwired39 and history; net+121tests/+6files
over5560/507 includes latest SAN+1/+0. Skip38-to36 still lacks historical
per-case attribution. Standard preflight awaits rerun;todo-65/actual business
PDF/provider/world quality/live runner remain open. now/handoff --no-test
refresh only docs; protected notes index/architecture/AGENTS remain unchanged.

### Separate the final named gate from documentation generation (2026-10-11)

Root standard preflight76433 nativeEXIT0/signalnull/error absent reported
preflight passed:bool390/discard0,refs3/8/1/3,typecheckEXIT0,tests5681/513
match baseline (judge pass5645/skip36/fail0),unwired39,hooks.githooks correct.
Capture1671043ms,stdout1104/stderr0 bytes,876 frozen hashes changed=[],logs
`analysis/diag/two-module-capture-1791701370371.*`. No assertion total or
internal test duration was printed; do not borrow plainfull72737's values
as this gate's metrics. Latest preflight pending is superseded, while90733
and both earlier red full records remain history. Baseline counts/history
stay unchanged;todo-65/actual PDF/provider quality/authorized production world
scopes/model use/live runner/uncommitted delivery remain open. now/handoff
--no-test refresh docs only and cite76433; index/architecture/AGENTS stay fixed.

### Preserve same-run raw evidence without declaring an intermittent fix (2026-10-13)

Four diagnostic files now retain stdout/stderr plus status/signal/error/bytes/
SHA256 in a unique ignored local directory;save failure is failclosed. No product
semantics,parameters or existing assertions changed. Real skipped-persist-call
mutation native1/signalnull was0pass/2fail/2assert/1file/68ms,capture91ms,
logs1791899185568. Four-file byte-exact restoration passed95/0/566/3files/452ms,
capture481ms/logs1791899241081;typecheck0/1662ms/logs1791899249491 and frontend
build0/1737ms/33modules/Vite925ms/logs1791899257814 followed.

Preflight91461 inner Bun native0/signalnull/errornull passed5686tests/514files/
5650pass/36skip/0fail/38769assert/1586.27s;1084 frozen inputs unchanged.
Raw `analysis/diag/preflight-bun-test-MwEt2w` contains stdout290865B/stderr1270338B
with hashes and exit metadata. OuterEXIT1 was only the new five passes differing
from baseline;typecheck0,bool390/discard0,unwired39/refs/hooks normal,
capture1613346ms/logs1791899085556. Baseline rises+5tests/+1file (diagnostic
wiring2/raw-helper3),skips/unwired unchanged;final standard gate remains pending.
Earlier79602 Fuzu receipt/replay red is not diagnosed or repaired:57940 exact
green and this full's Fuzu pass127318.25ms are non-reproduction only. At least11
files still depend on external world corpus for clean-clone reproduction;no
migration or new skip masks them. todo65/live quality remainopen. HEAD9dcef35
backup is remote but current diagnostic delivery is uncommitted. now/handoff
--no-test run no tests; protected index/architecture/AGENTS stay fixed.

### Isolate exhaustive-case budgets without claiming product speedup (2026-10-13)

Preflight23847 outer/native1/signalnull,capture2132559ms;raw604DuL full was
5686tests/514files/5649pass36skip1fail38755assert2091.28s,1084 hashes unchanged.
Only the old21-scene single scene-id-bridge case exceeded10s at14s. Its Fuzu
pass246078.22ms is not a diagnosis/repair of79602's intermittent receipt failure.
The test-only change gives21 independent named cases their unchanged10s each,
adds count/uniqueness guard and other-unvisited-scene false checks,retains all
prior target/ending/negative assertions,and nets+21tests/+0files. This is budget
isolation/stronger coverage,not product performance or semantic repair.
Real fixed-maintenance-room isSceneVisited mutation native1:0pass21fail/
11filtered43assert1file4.27s/logs1791902594079. Production byte-exact restore
SHA256`588b3a32ca891ebf9087aaee30b7b51bc7726405105c379f72ac7c99ef09feb0`
passed32/0/458/1file6.31s/logs1791902645609;typecheck0/logs1791902640287.
Preflight70072 inner full native0/signalnull/errornull:5707tests514files5671pass/
36skip0fail39144assert1897.70s,raw`analysis/diag/preflight-bun-test-7gPCVR`,
stdout281790B/stderr1277667B plus hash/exit metadata. OuterEXIT1 onlypass5671!=
old5650,typecheck0/bool390discard0/unwired39/refs/hooks normal,capture1935786ms/
logs1791904625798. Baseline5707/514/5671/36/0 keeps unwired39;batch+26tests/+1file.
Final standard remains pending;todo65/external-corpus cleanclone/live quality
remainopen. now/handoff --no-test only generate docs;protected3 files stay fixed.

### Name the final full gate without erasing the old failure (2026-10-13)

Standard96874 outerEXIT0/status0/signalnull/capture1949229ms,logs1791907049173;
inner raw`analysis/diag/preflight-bun-test-IWC9Jr` status0/signalnull/errornull
passed5707tests514files5671pass36skip0fail39164assert1911.61s,stdout284731B/
stderr1277536B with SHA/exit metadata. All1084 inputs were unchanged between
15:24:53.684Z and15:58:34.828Z. Typecheck0,bool390discard0,unwired39,refs3/8/1/3
and hooks.githooks passed. All21scene cases passed244.18–377.93ms;Fuzu
passed178588.70ms but79602's cause remains unknown. Latest standard pending
is superseded,not prior red history. Baseline counts/history stay untouched;
todo65/external-corpus cleanclone/live quality and deferred indexing remainopen.
now/handoff --no-test only refresh docs;post-refresh quick cannot replace full.
Protected index/architecture/AGENTS remain untouched.
