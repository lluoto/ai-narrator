> ⚠ **本文件由 `scripts/make-review-bundle.ts` 生成，手改会被覆盖。**
> 要改正文请改 `docs/review-request.md`；要改附录请改被打包的那些脚本。

# 外部 review 请求：诊断判据是否可信

> 用途：把这份连同下面列出的文件一起交给**另一个模型**（不是写这些代码的那个），
> 请它独立判断。写这份文件的模型在同一类错误上连犯六次仍未自查出来，
> 需要的是失效模式不同的第二双眼睛，不是同一个人再看一遍。

---

## 背景：为什么找你

这是一个 CoC 7e 跑团引擎的仓库。近期工作大量依赖**自写的诊断脚本**来判断
「某个行为对不对」——因为很多行为离线测试盖不到（LLM 路径、随机骰、多局统计）。

问题是：**这些判据本身反复出错，而且错的方式高度雷同**。已知六次：

| # | 判据 | 错法 | 后果 |
|---|---|---|---|
| 1 | 「切割截断语义单元」检查 | 判据太宽 | 174 个假阳性淹没 2 个真问题 |
| 2 | 「倒下的人还在行动」 | 把急救苏醒后的正常行动也算违规 | 永远报警，等于没测 |
| 3 | 「敌人战斗数值解析」测试 | 用例里干扰项恰好在目标之后 | 实现改错也全绿（变异检验才抓出） |
| 4 | 「文件是否被引用」 | 用去扩展名短词做子串匹配 | 18 个文件全部"命中" |
| 5 | 「不可再生数据有多少」 | `.txt` 源材料判据漏了根目录 | 算出 53MB，实际 489MB（差 9 倍） |
| 6 | 「玩家说法能否匹配」 | 12 种用例里 8 种都含完整地名 | 跑出 100%，补进会掉的用例后是 66.9% |

**共同点**：判据要么太宽（假阳性）、要么太松（假阴性）、要么用例没有区分力。
每次都是「写完就用」，没有先验证判据本身能不能区分对错两种情形。

---

## 请你做的事

审下面列出的诊断脚本，对**每一个**回答三个问题：

### Q1. 这个判据能区分对错吗？
构造两种输入：一种「行为正确」、一种「行为错误」。
判据对二者的输出是否不同？如果都输出「通过」或都输出「报警」，它就是坏的。

### Q2. 假阳性 / 假阴性风险在哪？
- 什么情况下它会报一个**其实没问题**的东西？
- 什么情况下**真有问题**它却不报？

### Q3. 用例有没有区分力？
特别针对含测试用例的脚本：这些用例是不是**都太容易**？
（第 6 号错误就是这么来的：所有用例都含完整地名，于是 100% 通过。）

---

## 待审文件

以下都在 `C:\aitrpg\poc\scripts\diag\`（早先放在被 .gitignore 排除的
`tools\`，判据留在那里等于没人守——已经整批搬进 `scripts/diag/` 并入库）：

| 文件 | 它声称在量什么 | 当前结论 |
|---|---|---|
| `scripts/diag/diag-phrasing.ts` | 玩家的自然语言说法能否匹配到目标场景 | 含完整地名 100%，否则 0~3% |
| `scripts/diag/diag-downed.ts` | 昏迷的调查员是否还在掷骰 | 违规 0 次 |
| `scripts/diag/diag-wounds.ts` | 伤势分级／重伤检定／惩罚骰是否生效 | 40 局 74 次伤害，≥50% 有 4 次 |
| `scripts/diag/diag-combat.ts` | Boss 是否真的还手、玩家是否掉血 | 12 局挥击 46 次，打昏 2 次 |
| `scripts/diag/diag-fuzz.ts` | 随机玩法能否通关、有无死循环 | 10/10 通关 |
| `scripts/diag/audit-backup.ts` | 哪些数据丢了不可再生 | 500MB 不可再生 |

以及 `C:\aitrpg\poc\scripts\preflight.ts`（改动前后的自检）。

---

## 已知的环境约束（避免你误判）

- **Windows PowerShell 5.1**。仓库源码是 UTF-8 **无 BOM**，
  `Select-String` / `Get-Content` 读中文会 mojibake。用 `fs.readFileSync` 或专用工具。
- 诊断脚本一律走 `onLine` 回调在内存收集，自己 `Bun.write` 落盘，
  **不经控制台重定向**——`bun run x.ts *> file` 会把 UTF-8 写坏。
  （曾因此得出「12 局 0 次触发」的假结论，实际是编码问题。）
- 测试用 `bun test`。**只有测试条数是可靠回归信号**，
  `expect()` 计数会被一条无种子的随机测试搅动。
- 已知两条偶发假红：`coc-engine.test.ts:131`（约 1%）、
  `npc-reaction.test.ts` 的「高稳定性减少负面情绪」。

---

## 输出格式

对每个脚本给：

```
## <文件名>
- 能否区分对错：能 / 不能 / 存疑（说明理由）
- 假阳性风险：<具体场景>
- 假阴性风险：<具体场景>
- 用例区分力：<针对含用例的脚本>
- 建议：<具体改法，或"无需改">
```

最后给一段总评：**这六次错误有没有共同的根因？**
如果有，什么样的检查能一次性挡住这一类，而不是逐个打补丁？

---

## 一个请求

请**不要**只做表面复核（"看起来合理"）。上面六次错误里，
至少四次在肉眼审读时都"看起来合理"——它们是在
**构造反例**或**做变异检验**（把实现改坏看测试红不红）时才暴露的。

如果你判断某个判据可疑，请直接给出能让它露馅的**具体输入**。


======================================================================
# 附：待审脚本全文
======================================================================

## scripts/diag/diag-phrasing.ts

```ts
// 量「玩家说的话没被匹配上、引擎替他挑了」有多频繁。
//
// ⚠ 判据本身返工过一次（见 docs/review-request.md 第 6 条）。上一版的问题：
//   1. 12 种说法里 8 种都含完整地名 → 跑出 100%，看着像匹配很好，
//      其实只说明用例太容易。补进会掉的用例后是 66.9%。
//   2. 「换个地方看看」「去那边」这种句子**根本没指定目标**，
//      却被算进「目标命中率」的分母。分子必然是 0，指标不度量任何东西。
//      这类输入唯一能要求的是：引擎必须承认自己是替玩家挑的（forced=true）。
//   3. 报告写着「8 种说法」，实际列了 12 种。
//   4. 只按模组给的连接顺序跑一遍 —— 干扰项恰好排在目标之后时全绿，
//      实现改错也发现不了（同一份 review 的第 3 条错就是这么来的）。
//
// 现在：用例分正例 / 反例 / 歧义三类，各有各的判据（见 src/diagnostics/phrasing.ts，
// 那边有正反例校准测试）；每条用例按原序和逆序各跑一遍。
process.env.LLM_DISABLED = "true";

import { chooseConnection, type MoveWorldView } from "../../src/play-module";
import { matchKeys } from "../../src/play/move-util";
import { BARN_OF_PREMIER } from "../../src/module/barn-of-premier";
import type { SceneConnection } from "../../src/module/types";
import {
  addPhraseResult, newPhraseReport, pct,
  type PhraseCase, type PhraseOutcome,
} from "../../src/diagnostics/phrasing";
import { writeReport } from "../../src/diagnostics/report";

const view: MoveWorldView = {
  isSceneVisited: () => false,
  visitCount: () => 0,
  sceneExists: (id) => BARN_OF_PREMIER.scenes.some((s) => s.id === id),
  sceneName: (id) => BARN_OF_PREMIER.scenes.find((s) => s.id === id)?.name ?? "",
};

const nameOf = (c: SceneConnection) => view.sceneName(c.targetSceneId);
const stripVerb = (s: string) => s.replace(/^(前往|进入|返回|回到|离开|去|到)\s*/, "").trim();

/**
 * 这个说法在这组连接里是不是只对应**一个目标场景**。
 *
 * ⚠ 数的是**目的地**不是连接。`maintenance_room` 有两条连接都通向 `sewer`
 * （「返回下水道」/「通过奇怪管道」），按连接数算会把「去下水」判成歧义 ——
 * 可玩家想去哪儿一点都不含糊，两条路通同一个地方。
 * 这跟前面「别去下水道，去下水道」是同一个错：拿连接当身份，而身份是场景。
 */
function uniqueAmong(phrase: string, conns: SceneConnection[], target: SceneConnection): boolean {
  if (phrase.length < 2) return false;
  const hits = conns.filter((c) => matchKeys(c, view).some((k) => k.includes(phrase) || phrase.includes(k)));
  const targets = new Set(hits.map((c) => c.targetSceneId));
  return targets.size === 1 && targets.has(target.targetSceneId);
}

/**
 * 别的连接里有没有哪个键是这句话的子串 —— 有就是「重叠地名」陷阱。
 *
 * 比的是 `targetSceneId` 而不是连接对象：同一个场景可以挂两条连接
 * （`maintenance_room` 有两条都通向 `sewer`），拿另一条当干扰项
 * 会造出「别去下水道，去下水道」这种判不出东西的用例。
 */
function overlappingRival(said: string, conns: SceneConnection[], target: SceneConnection): SceneConnection | null {
  for (const c of conns) {
    if (c.targetSceneId === target.targetSceneId) continue;
    if (matchKeys(c, view).some((k) => k.length >= 2 && said.includes(k))) return c;
  }
  return null;
}

/**
 * 给一个「目标连接 + 它所在的连接组」造出一批用例。
 *
 * 前 8 条是含完整地名的正例（上一版就只有这些，所以 100%）；
 * 后面几条是**会掉的**：唯一简称、唯一别名、否定、提及非目标、重叠地名、
 * 同义改写、代词、描述特征。判据要有区分力，就得有会掉的。
 */
function buildCases(target: SceneConnection, conns: SceneConnection[]): PhraseCase[] {
  const name = nameOf(target);
  const want = target.targetSceneId;
  // ⚠ 干扰项必须指向**别的场景**，不能只是「别的连接」。
  // `maintenance_room` 有两条连接都通向 `sewer`（「返回下水道」/「通过奇怪管道」），
  // 按「别的连接」取就会造出「别去下水道，去下水道」这种句子 ——
  // forbid 与 want 是同一个地方，判据必然失败，而那是用例的错不是引擎的错。
  // 这正是这轮要修的那类毛病：用例没有区分力，跑出来的数说明不了任何事。
  const other = conns.find((c) => c.targetSceneId !== want && nameOf(c));
  const otherName = other ? nameOf(other) : "";
  const cases: PhraseCase[] = [
    { id: "p1-原文", kind: "positive", desc: "照抄选项原文", said: target.condition, wantSceneId: want },
    { id: "p2-地名", kind: "positive", desc: "只说地名", said: name, wantSceneId: want },
    { id: "p3-去地名", kind: "positive", desc: "「去」+地名", said: `去${name}`, wantSceneId: want },
    { id: "p4-我们去", kind: "positive", desc: "「我们去」+地名", said: `我们去${name}看看`, wantSceneId: want },
    { id: "p5-前往", kind: "positive", desc: "「前往」+地名", said: `前往${name}`, wantSceneId: want },
    { id: "p6-那边", kind: "positive", desc: "地名+「那边」", said: `${name}那边应该有线索`, wantSceneId: want },
    { id: "p7-犹豫", kind: "positive", desc: "带犹豫的口语", said: `嗯……先去${name}吧`, wantSceneId: want },
    { id: "p8-句中", kind: "positive", desc: "地名在句中", said: `我觉得${name}值得看看，走吧`, wantSceneId: want },
  ];

  // 唯一简称：地名的最短唯一前缀（如「维森酒吧」→「维森」）
  for (let len = 2; len < name.length; len++) {
    const abbr = name.slice(0, len);
    if (uniqueAmong(abbr, conns, target)) {
      cases.push({ id: "p9-唯一简称", kind: "positive", desc: "唯一简称", said: `先去${abbr}那边`, wantSceneId: want });
      break;
    }
  }

  // 唯一别名：选项文案去掉动词之后与场景真名不同的那种（「返回镇上」→ 场景叫「普瑞米尔」）
  const alias = stripVerb(target.condition).replace(/[（(][^）)]*[）)]/g, "").trim();
  if (alias && alias !== name && uniqueAmong(alias, conns, target)) {
    cases.push({ id: "p10-唯一别名", kind: "positive", desc: "唯一别名", said: `我们去${alias}`, wantSceneId: want });
  }

  // 唯一后缀：中文地名的中心词在后面（「霍姆斯**医院**」「维森**酒吧**」），
  // 玩家最常省掉的正是前面的专名。前缀那一支覆盖不到它。
  const bare = name.replace(/[（(][^）)]*[）)]/g, "").trim();
  for (let len = 2; len < bare.length; len++) {
    const suffix = bare.slice(bare.length - len);
    if (uniqueAmong(suffix, conns, target)) {
      cases.push({ id: "p11-唯一后缀", kind: "positive", desc: "唯一后缀（中心词）", said: `我们去${suffix}看看`, wantSceneId: want });
      break;
    }
  }

  if (other) {
    // 否定式：「别去 A，去 B」。判据要求**不能**选中 A。
    cases.push({
      id: "n1-否定", kind: "negative", desc: "否定一个目标同时指定另一个",
      said: `别去${otherName}，去${name}`, wantSceneId: want, forbidSceneId: other.targetSceneId,
    });
    // 提及非目标：「A 已经去过了，现在去 B」
    cases.push({
      id: "n2-提及非目标", kind: "negative", desc: "提到别处但目标是自己点名的那个",
      said: `${otherName}那边已经去过了，现在去${name}`, wantSceneId: want, forbidSceneId: other.targetSceneId,
    });
  }

  // 重叠地名：别的连接的键正好是这句话的子串
  const rival = overlappingRival(`去${name}`, conns, target);
  if (rival) {
    cases.push({
      id: "n3-重叠地名", kind: "negative", desc: "别处的地名是本句的子串",
      said: `去${name}`, wantSceneId: want, forbidSceneId: rival.targetSceneId,
    });
  }

  cases.push(
    { id: "a1-同义改写", kind: "ambiguous", desc: "同义改写（不含任何地名）", said: "换个地方看看", wantSceneId: null },
    { id: "a2-代词", kind: "ambiguous", desc: "代词指代", said: "去那边", wantSceneId: null },
    { id: "a3-描述特征", kind: "ambiguous", desc: "描述目的地特征", said: "去那个有灯光的房间", wantSceneId: null },
  );
  // 只说前两字：唯一时算正例（唯一简称已单列），不唯一时是歧义
  const two = name.slice(0, 2);
  if (!uniqueAmong(two, conns, target)) {
    cases.push({ id: "a4-前两字", kind: "ambiguous", desc: "只说地名前两字（不唯一）", said: `去${two}`, wantSceneId: null });
  }
  return cases;
}

function runOnce(said: string, conns: SceneConnection[]): PhraseOutcome {
  const r = chooseConnection({ action: said }, conns, view);
  // `trace.matched` 让判据说得出**为什么**没对上：一个键都没命中、
  // 只命中了别人的键、还是自己和别人都命中靠顺序抢先。三类修法完全不同。
  return { chosenSceneId: r.conn?.targetSceneId ?? null, forced: r.forced, matched: r.trace.matched };
}

const report = newPhraseReport();
// 顺序敏感性：同一批用例按原序和逆序各跑一遍。
// 只跑一种顺序时，「干扰项恰好排在目标之后」会让判据全绿。
const orders: { label: string; arrange: (c: SceneConnection[]) => SceneConnection[] }[] = [
  { label: "原序", arrange: (c) => c },
  { label: "逆序", arrange: (c) => [...c].reverse() },
];
const perOrder = new Map<string, { hit: number; total: number }>();
const caseIds = new Set<string>();

for (const scene of BARN_OF_PREMIER.scenes) {
  const conns = scene.connections as SceneConnection[];
  if (conns.length < 2) continue; // 单出口没得选，不算数

  for (const target of conns) {
    if (!nameOf(target)) continue;
    const cases = buildCases(target, conns);
    for (const c of cases) caseIds.add(`${c.kind}/${c.id}`);
    for (const o of orders) {
      const arranged = o.arrange(conns);
      for (const c of cases) {
        const j = addPhraseResult(report, c, runOnce(c.said, arranged), `${scene.name}→${nameOf(target)}·${o.label}`);
        const t = perOrder.get(o.label) ?? { hit: 0, total: 0 };
        t.total++; if (j.verdict === "pass") t.hit++;
        perOrder.set(o.label, t);
      }
    }
  }
}

const out: string[] = ["# 玩家说的话，引擎认不认", ""];
out.push(`拿模组里每个多出口场景 × 每个出口 × **${caseIds.size} 种说法**（正例/反例/歧义三类），`);
out.push("每种再按连接的原序与逆序各跑一遍 —— 只跑一种顺序时，干扰项恰好排在目标之后就会全绿。");
out.push("");
out.push("判据（见 `src/diagnostics/phrasing.ts`，有正反例校准测试）：");
out.push("");
out.push("| 类别 | 通过条件 | 进不进命中率 |");
out.push("|---|---|---|");
out.push("| 正例 | 选中目标且 `forced=false` | 进 |");
out.push("| 反例 | 不选中被否定/被提及的那个，且去了指定目标 | 不进 |");
out.push("| 歧义 | `forced=true`（引擎老实承认是替选） | 不进 |");
out.push("");
out.push("## 汇总");
out.push("");
out.push(`- **目标命中率（仅正例）：${report.hitRate.hit}/${report.hitRate.total} = ${pct(report.hitRate)}**`);
out.push(`- 反例通过率：${report.negative.hit}/${report.negative.total} = ${pct(report.negative)}`);
out.push(`- 歧义输入「老实承认替选」率：${report.ambiguous.hit}/${report.ambiguous.total} = ${pct(report.ambiguous)}`);
out.push("");
out.push("按连接顺序分：");
out.push("");
out.push("| 顺序 | 通过 | 总数 | 通过率 |");
out.push("|---|---|---|---|");
for (const [k, v] of perOrder) out.push(`| ${k} | ${v.hit} | ${v.total} | ${pct(v)} |`);
out.push("");
out.push("## 逐条说法");
out.push("");
out.push("| 类别 | 说法 | 通过 | 总数 | 通过率 |");
out.push("|---|---|---|---|---|");
for (const [id, v] of [...report.byId.entries()].sort()) {
  out.push(`| ${v.kind} | ${id} ${v.desc} | ${v.tally.hit} | ${v.tally.total} | ${pct(v.tally)} |`);
}
out.push("");
out.push("## 失败按成因分类");
out.push("");
out.push("三类的修法完全不同，混在一个「命中率」里等于知道有病不知道病在哪。");
out.push("");
const FAIL_LABEL: Record<string, string> = {
  "no-key": "一个键都没命中 —— 匹配方式太窄（缺简称/别名/同义词）",
  "rival-only": "只命中了别处的键 —— 子串比对认错了人（重叠地名、否定）",
  "ambiguous": "自己和别处都命中 —— 靠候选顺序抢先，换个顺序就翻车",
  "forced-hit": "目标对了但引擎标了替选 —— 是蒙对的，不是听懂的",
  "other": "其它",
};
out.push("| 成因 | 条数 |");
out.push("|---|---|");
for (const [k, n] of [...report.failKinds.entries()].sort((a, b) => b[1] - a[1])) {
  out.push(`| ${FAIL_LABEL[k] ?? k} | ${n} |`);
}
out.push("");
out.push(`## 没通过的例子（共 ${report.failures.length} 条，列前 25）`);
out.push("");
for (const f of report.failures.slice(0, 25)) out.push(`- ${f}`);

await writeReport("diag-phrasing.md", out.join("\n") + "\n");
console.log(
  `目标命中率 ${report.hitRate.hit}/${report.hitRate.total} = ${pct(report.hitRate)}｜` +
  `反例 ${report.negative.hit}/${report.negative.total}｜歧义承认 ${report.ambiguous.hit}/${report.ambiguous.total}` +
  `  -> analysis/diag/diag-phrasing.md`,
);
```

## scripts/diag/diag-downed.ts

```ts
// 量「昏迷的调查员是不是还在**自己掷骰**」。
//
// ── 范围（上一版没写清，名称/实现/报告三处不一致）──
// 只管该角色**自己发起的技能检定**。不管 SAN 检定（被动反应，单列计数）、
// 不管同伴替他做的事（急救掷骰的人是施救者）、不管说话和被拖走（引擎里没有对应掷骰）。
//
// ── 上一版为什么不可信 ──
// 它认 `❤ X HP n → 0（昏迷` 这一行。但昏迷有两条路径：
//   1. 伤害把 HP 打到 0        → 有那行
//   2. 重伤体质检定失败        → **没有那行**（HP 还剩着，人先倒了）
// 第 2 条整条漏掉，「违规 0 次」于是既可能是真没问题、也可能是根本没在看，
// 两种情况输出一模一样。现在改读结构化事件（src/play/events.ts），
// 判据在 src/diagnostics/downed.ts，有正例/反例/干扰项校准测试。
process.env.LLM_DISABLED = "true";

import { BARN_OF_PREMIER, BARN_SUPPORT } from "../../src/module/barn-of-premier";
import { runSeeded } from "../../src/diagnostics/run-harness";
import { writeReport } from "../../src/diagnostics/report";
import { reduceDowned, mergeDowned, type DownedReport } from "../../src/diagnostics/downed";

// 用法：bun scripts/diag/diag-downed.ts [局数] [起始局号]
// 起始局号让「每次最多跑 N 局」也能覆盖到不同的种子段：
//   bun scripts/diag/diag-downed.ts 3 1   → 第 1~3 局
//   bun scripts/diag/diag-downed.ts 3 4   → 第 4~6 局（与上面不重叠）
const N = Number(process.argv[2] ?? 20);
const FROM = Number(process.argv[3] ?? 1);
const TIMEOUT_MS = 120_000;
const MAX_DECISIONS = 200;

async function main() {
  const per: DownedReport[] = [];
  let koRuns = 0, bothRuns = 0, abnormal = 0, ambiguous = 0;
  const abnormalNotes: string[] = [];
  const ambiguityNotes: string[] = [];

  for (let i = FROM; i < FROM + N; i++) {
    const r = await runSeeded(BARN_OF_PREMIER, BARN_SUPPORT, {
      seed: i * 7919, timeoutMs: TIMEOUT_MS, maxDecisions: MAX_DECISIONS,
    });
    if (r.threw || r.timedOut || r.hitDecisionCap) {
      // 异常局照样要报出来。上一版直接 continue，等于把坏局从分母里删掉。
      abnormal++;
      abnormalNotes.push(`  #${i} ${r.timedOut ? "超时" : r.hitDecisionCap ? "决策步数打满" : "抛异常"}：${r.errorMessage}`);
    }
    const d = reduceDowned(r.events);
    per.push(d);
    if (d.everDown.length > 0) koRuns++;
    if (d.allDown) bothRuns++;
    if (d.ambiguousIdentity) {
      ambiguous++;
      ambiguityNotes.push(`  #${i}（seed ${i * 7919}）${d.ambiguityReason}`);
    }
  }

  const m = mergeDowned(per);
  const out = [
    `范围：**昏迷期间该角色自己发起的技能检定**。`,
    `SAN 检定（被动反应）、同伴代做的检定、受伤那一刻的重伤结算检定都不算违规，但都单列计数。`,
    ``,
    `第 ${FROM}~${FROM + N - 1} 局，共 ${N} 局（异常 ${abnormal} 局，已计入）：出现昏迷 ${koRuns} 局，两人同时倒下 ${bothRuns} 局`,
    ...abnormalNotes,
    ``,
    `倒下成因：HP 直接归零 ${m.byCause["hp-zero"]} 次，重伤体质检定失败 ${m.byCause["major-wound-con"]} 次`,
    `急救唤醒成功 ${m.revives} 次；苏醒后本人正常检定 ${m.checksAfterRevive} 次（这些**不是**违规）`,
    `昏迷期间同伴代做的检定 ${m.byPartnerWhileDown} 次（不是违规）`,
    `昏迷期间的 SAN 检定 ${m.sanWhileDowned} 次（范围外，被动反应）`,
    `受伤当场的重伤结算检定豁免 ${m.settlementExempt} 次`,
    ``,
    `**${ambiguous > 0 ? "疑似违规（见下方身份不可分辨）" : "违规（昏迷期间本人掷骰）"}：${m.violations.length} 次**`,
    ...m.violations.slice(0, 8).map((v) => `    ${v.actor} 【${v.skill}】（倒下成因：${v.cause}）`),
    ...(ambiguous > 0
      ? ["", `⚠ 有 ${ambiguous} 局**身份不可分辨**，这些局的违规计数既不能算通过也不能算违规：`, ...ambiguityNotes]
      : []),
    ``,
    ambiguous > 0
      ? "◻ 本轮**不可判定** —— 先把重名那几局排除掉再看结论"
      : m.byCause["hp-zero"] + m.byCause["major-wound-con"] === 0
        ? "· 本轮没有人倒下 —— 这不等于判据通过，只是没有可判的样本"
        : m.violations.length === 0
          ? "✓ 昏迷期间没有本人发起的技能检定"
          : "⚠ 仍有倒下的人在掷骰",
  ].join("\n");

  await writeReport("diag-downed.txt", out + "\n");
  console.log(out);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

## scripts/diag/diag-wounds.ts

```ts
// 量伤势分级 / 重伤体质检定 / 惩罚骰到底有没有生效。
//
// ── 上一版为什么不可信 ──
// 1. `lines.filter(l => /惩罚骰/.test(l))` 当成「伤势惩罚生效」的证据。
//    播报里带这三个字的至少三种来源：伤势 `[1惩罚骰·伤势]`、
//    环境 `[1惩罚骰]`、战斗疲劳 `[惩罚骰×2]`。混成一堆之后
//    **把 `recordWound()` 整个删掉，计数照样非零** —— 判据不会变红。
// 2. 只按播报标签分档。HP 归零那行的后缀被写死成「（昏迷/濒死！）」，
//    把伤势标签盖掉了，最该统计的那一档必然漏。
// 3. 「40 局 74 次伤害，≥50% 有 4 次」是**跨局汇总**，没有按角色、按顺序
//    验证「这 4 次各自后面跟了一次体质检定」。前者成立不代表后者成立。
//
// 现在按角色、按事件顺序跑状态机验四条不变量（见 src/diagnostics/wounds.ts，
// 那边有正例/反例/干扰项校准测试，删 recordWound / 删 CON 检定 / 去 ignoreWound
// 三种变异各有一条测试抓住）。
process.env.LLM_DISABLED = "true";

import { BARN_OF_PREMIER, BARN_SUPPORT } from "../../src/module/barn-of-premier";
import { runSeeded } from "../../src/diagnostics/run-harness";
import { writeReport } from "../../src/diagnostics/report";
import { reduceWounds, mergeWounds, type WoundReport } from "../../src/diagnostics/wounds";

const N = Number(process.argv[2] ?? 12);
const TIMEOUT_MS = 120_000;
const MAX_DECISIONS = 200;

const BREACH_LABEL: Record<string, string> = {
  "missing-con": "重伤之后没有体质检定",
  "duplicate-con": "同一次重伤掷了多次体质检定",
  "con-self-penalized": "体质检定被它自己结算的那处伤罚（双重计算）",
  "wound-penalty-missing": "身上有伤，读伤势的检定却没带惩罚骰",
  "penalty-after-heal": "伤势已处理，却还在扣伤势惩罚骰",
  "missing-wound-record": "重伤且人还站着，却没把伤势记下来（recordWound 没生效）",
};

async function main() {
  const per: WoundReport[] = [];
  let abnormal = 0;
  const abnormalNotes: string[] = [];

  for (let i = 1; i <= N; i++) {
    const r = await runSeeded(BARN_OF_PREMIER, BARN_SUPPORT, {
      seed: i * 7919, timeoutMs: TIMEOUT_MS, maxDecisions: MAX_DECISIONS,
    });
    if (r.threw || r.timedOut || r.hitDecisionCap) {
      abnormal++;
      abnormalNotes.push(`  #${i} ${r.timedOut ? "超时" : r.hitDecisionCap ? "决策步数打满" : "抛异常"}：${r.errorMessage}`);
    }
    per.push(reduceWounds(r.events));
  }

  const m = mergeWounds(per);
  const byKind = new Map<string, number>();
  for (const b of m.breaches) byKind.set(b.kind, (byKind.get(b.kind) ?? 0) + 1);

  const out: string[] = [];
  out.push(`${N} 局（异常 ${abnormal} 局，已计入）`);
  out.push(...abnormalNotes);
  out.push("");
  out.push("## 伤势分级（按引擎算出的 severity，不看播报标签）");
  out.push("");
  out.push(`  伤害事件 ${m.damages} 次`);
  for (const [k, v] of Object.entries(m.severityBuckets)) out.push(`  ${k.padEnd(9)} ${v}`);
  out.push("");
  out.push("  ⚠ HP 归零那一行的播报后缀是「昏迷/濒死！」，按文本分档会把这一档整个漏掉。");
  out.push("");
  out.push("## 重伤流程");
  out.push("");
  out.push(`  deep/grievous 且人还站着：${m.majorWoundsStanding} 次 → 应有同样次数的重伤体质检定`);
  out.push(`  deep/grievous 但当场昏迷：${m.majorWoundsWhileDown} 次 → **不该**掷体质检定（人已经躺下，那一掷没什么可决定的）`);
  out.push("    · 口径由 `needsMajorWoundCheck()` 一处说了算。四个调用点原先两种写法，");
  out.push("      判据当时只能把这一档单列出来不下结论 —— 判据被实现的不一致逼哑了。");
  out.push(`  实际重伤体质检定：${m.conChecks} 次`);
  out.push(`  记下的伤势：${m.woundsRecorded} 次，处理掉：${m.woundsHealed} 次`);
  out.push("");
  out.push("## 惩罚骰来源必须分开");
  out.push("");
  out.push(`  真被伤势罚到的检定：${m.woundPenalizedChecks} 次   ← 这是伤势机制生效的**唯一**证据`);
  out.push(`  只带环境/疲劳惩罚的检定：${m.envOnlyPenalizedChecks} 次   ← 不许拿它充数`);
  out.push(`  有伤但该掷骰路径不读伤势：${m.woundBlindRolls} 次   ← 应为 0，见下`);
  out.push("");
  out.push("  · 战斗里调查员的攻击掷骰原先直接调 `CoCEngine.skillCheck`，绕过 `checks.ts` 的");
  out.push("    `check()`，伤势惩罚在战斗攻击上一点作用都没有。这个缺口正是「按来源分账」");
  out.push("    之后露出来的：记下的伤势有好几处，真被伤势罚到的检定却几乎为零。");
  out.push("    现已接上（疲劳与伤势分别标注，合计仍受 CoC 7e 的 2 颗上限约束）。");
  out.push("    这一行留着守回归：再有谁另开一条绕过 `check()` 的路，它会立刻非零。");
  out.push("");
  out.push("## 不变量破例");
  out.push("");
  if (m.breaches.length === 0) {
    out.push(`  ✓ 无破例（${m.majorWoundsStanding} 次重伤各自恰有一次不受自身伤势影响的体质检定，`);
    out.push(`    ${m.woundPenalizedChecks} 次后续检定带伤势惩罚，${m.woundsHealed} 次处理后惩罚消失）`);
    if (m.majorWoundsStanding === 0) {
      out.push("  · 但本轮 0 次重伤 —— 「无破例」在这里只说明没有可判的样本，不说明机制生效");
    }
  } else {
    out.push(`  ✗ ${m.breaches.length} 处破例：`);
    for (const [k, v] of byKind) out.push(`    ${v} × ${BREACH_LABEL[k] ?? k}`);
    out.push("");
    for (const b of m.breaches.slice(0, 10)) out.push(`    ${JSON.stringify(b)}`);
  }

  await writeReport("diag-wounds.txt", out.join("\n") + "\n");
  console.log(out.join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

## scripts/diag/diag-combat.ts

```ts
// 量 Boss 到底还不还手、玩家掉不掉血。
//
// ── 上一版为什么不可信 ──
// `inCombat.filter(l => /【格斗】/.test(l)).length` 当敌人挥击次数，
// 然后 `swings === 0 ? 报警 : 通过`。三个洞：
//   1. **不验攻击者**：玩家若有个正好叫「格斗」的技能，判据直接变绿。
//   2. **认死技能名**：敌人技能改叫「触手」或「格斗(钳肢)」就一次都不认，
//      静默掉到 0 —— 真报警和漏报长得一模一样。
//   3. **跨局求和**：10 局里 1 局打了 1 下，另外 9 局全程发呆也算「会还手了」。
// 战斗段的行范围也是猜的（`findIndex(/战斗轮/)` 到下一条 `═{10,}`，
// 而 `═` 分隔线在战斗开始处就有三条）。
//
// 现在按 combat-start / combat-round 事件划分战斗与轮次，敌人还手直接读
// `enemy-attack` 事件（自带攻击者与目标）。判据见 src/diagnostics/combat.ts。
process.env.LLM_DISABLED = "true";

import { BARN_OF_PREMIER, BARN_SUPPORT } from "../../src/module/barn-of-premier";
import { runSeeded } from "../../src/diagnostics/run-harness";
import { writeReport } from "../../src/diagnostics/report";
import { reduceCombat, judgeCombat, type CombatReport } from "../../src/diagnostics/combat";

const N = Number(process.argv[2] ?? 10);
const TIMEOUT_MS = 120_000;
const MAX_DECISIONS = 200;

async function main() {
  const per: CombatReport[] = [];
  let abnormal = 0;
  const abnormalNotes: string[] = [];
  const perRun: string[] = [];

  for (let i = 1; i <= N; i++) {
    const r = await runSeeded(BARN_OF_PREMIER, BARN_SUPPORT, {
      seed: i * 7919, timeoutMs: TIMEOUT_MS, maxDecisions: MAX_DECISIONS,
    });
    if (r.threw || r.timedOut || r.hitDecisionCap) {
      abnormal++;
      abnormalNotes.push(`  #${i} ${r.timedOut ? "超时" : r.hitDecisionCap ? "决策步数打满" : "抛异常"}：${r.errorMessage}`);
    }
    const c = reduceCombat(r.events);
    per.push(c);
    for (const enc of c.encounters) {
      const swings = enc.rounds.reduce((a, rd) => a + rd.enemyAttacks.length, 0);
      const pcAtk = enc.rounds.reduce((a, rd) => a + rd.pcAttacks.length, 0);
      perRun.push(
        `  #${i} vs ${enc.enemy}：${enc.rounds.length} 轮，敌人挥击 ${swings} 次，` +
        `调查员攻击 ${pcAtk} 次，玩家掉血 ${enc.pcHpLost}，结果 ${enc.result}` +
        (swings === 0 ? "   ⚠ 这一局敌人一次都没动" : ""),
      );
    }
  }

  const v = judgeCombat(per);
  const out: string[] = [];
  out.push(`${N} 局（异常 ${abnormal} 局，已计入）：发生战斗 ${v.fights} 局`);
  out.push(...abnormalNotes);
  out.push("");
  out.push("## 敌人还手（按攻击者身份认，不按技能名）");
  out.push("");
  out.push(`  敌人挥击 ${v.enemySwings} 次：命中 ${v.enemyHits}，被闪开 ${v.dodged}，没掷中 ${v.missed}`);
  out.push(`  调查员攻击掷骰 ${v.pcAttacks} 次`);
  out.push(`  战斗中玩家掉血合计 ${v.pcHpLost} 点`);
  out.push(`  攻击者身份对不上的事件 ${v.misattributed} 次（应恒为 0，非 0 说明事件源出问题）`);
  out.push("");
  out.push("## 判据：按**发生战斗的那一局**看，不看跨局总数");
  out.push("");
  if (v.fights === 0) {
    out.push("  · 本轮一局都没打起来 —— 无从判断敌人会不会还手（不是通过，也不是失败）");
  } else if (v.silentFights > 0) {
    out.push(`  ⚠ ${v.silentFights}/${v.fights} 局的敌人一次都没挥击`);
  } else {
    out.push(`  ✓ ${v.fights}/${v.fights} 局敌人都还手了`);
  }
  out.push("");
  out.push("## 战斗中的昏迷（两条成因都认）");
  out.push("");
  const byCause = { "hp-zero": 0, "major-wound-con": 0 };
  for (const k of v.knockouts) byCause[k.cause]++;
  out.push(`  HP 直接归零 ${byCause["hp-zero"]} 次，重伤体质检定失败 ${byCause["major-wound-con"]} 次`);
  out.push("  · 第二条在播报里**没有** `HP n → 0` 那一行，只按文本找必然漏。");
  out.push("");
  out.push("## 战斗结果分布");
  out.push("");
  for (const [k, n] of Object.entries(v.results)) out.push(`  ${k.padEnd(10)} ${n}`);
  out.push("");
  out.push("## 逐局");
  out.push("");
  out.push(...perRun);

  await writeReport("diag-combat.txt", out.join("\n") + "\n");
  console.log(out.join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

## scripts/diag/diag-fuzz.ts

```ts
// 随机策略跑多局，找只在特定路径上冒出来的毛病。
//
// ── 上一版为什么不可信 ──
// 可复现的反例（它自己的输出）：
//     通关 10/10
//     跑完没有结局的局：1/10
// 两句话互相打脸，因为「通关」量的是**进过终局场景**，而「有没有结局」
// 量的是**念没念结局文本**。全员倒下时 `evaluateEnding` 返回 null，
// 一个结局字都不会念，但人可能早就进过维修间了。
//
// 另外三处：
//   · 分母是 `rows.length`，而 `rows` 只 push 成功的局 —— 越崩越接近 100%。
//   · `maxRepeat` / `emptyOptionStops` / `blank` 算了但从不判定也不打印。
//   · 「死循环」根本没测：既没超时也没决策步数上限，真死循环时脚本自己挂着。
//   · seed 只控制选项，骰子和战斗仍走 `Math.random()` —— 拿它当确定性依据是错的。
//
// 现在：通关 = 正常返回 **且** 发出 `ending` 事件；分母固定为计划局数；
// 每局有超时和决策步数上限；`maxRepeat`/空选项都参与判定并打印；
// 整条 RNG 注入（见 run-harness），并跑一次同 seed 复现自检把结论量出来。
process.env.LLM_DISABLED = "true";

import { BARN_OF_PREMIER, BARN_SUPPORT } from "../../src/module/barn-of-premier";
import { runSeeded } from "../../src/diagnostics/run-harness";
import { writeReport } from "../../src/diagnostics/report";
import {
  summarizeFuzzEvents, judgeFuzz, DEFAULT_FUZZ_THRESHOLDS,
  type FuzzRunOutcome,
} from "../../src/diagnostics/fuzz";

// 用法：bun scripts/diag/diag-fuzz.ts [局数] [起始局号]
// 起始局号让「每次最多跑 N 局」也能覆盖不同的种子段而不重叠。
const PLANNED = Number(process.argv[2] ?? 10);
const FROM = Number(process.argv[3] ?? 1);
const TH = { ...DEFAULT_FUZZ_THRESHOLDS, timeoutMs: 90_000, maxDecisions: 120 };
const FINALE = BARN_SUPPORT.finaleSceneId;

const FAIL_LABEL: Record<string, string> = {
  threw: "抛异常",
  timeout: "超时（疑似死循环）",
  "decision-cap": "决策步数打满（疑似死循环）",
  "no-ending": "跑完没有正式结局",
  "empty-options": "出现空选项岔口",
  "scene-loop": "同名场景连续进场超上限",
};

async function main() {
  const outcomes: FuzzRunOutcome[] = [];

  for (let i = FROM; i < FROM + PLANNED; i++) {
    const seed = i * 7919;
    const r = await runSeeded(BARN_OF_PREMIER, BARN_SUPPORT, {
      seed, timeoutMs: TH.timeoutMs, maxDecisions: TH.maxDecisions,
    });
    const s = summarizeFuzzEvents(r.events, FINALE);
    outcomes.push({
      seed,
      threw: r.threw, errorMessage: r.errorMessage,
      timedOut: r.timedOut, hitDecisionCap: r.hitDecisionCap,
      ...s,
      decisions: r.decisions, // 以脚手架计数为准（抛异常时事件可能没走完）
    });
  }

  const report = judgeFuzz(outcomes, PLANNED, TH);

  // 复现自检：同一个 seed 再跑一遍，比事件流。
  // 「seed 能不能当确定性回归依据」是个**可测量**的问题，不该靠声称。
  const a = await runSeeded(BARN_OF_PREMIER, BARN_SUPPORT, { seed: 7919, timeoutMs: TH.timeoutMs, maxDecisions: TH.maxDecisions, keepLines: true });
  const b = await runSeeded(BARN_OF_PREMIER, BARN_SUPPORT, { seed: 7919, timeoutMs: TH.timeoutMs, maxDecisions: TH.maxDecisions, keepLines: true });
  const eventsSame = JSON.stringify(a.events) === JSON.stringify(b.events);
  const linesSame = a.lines.join("\n") === b.lines.join("\n");

  const out: string[] = [];
  out.push(`# 随机玩法 fuzz（第 ${FROM}~${FROM + PLANNED - 1} 局，计划 ${PLANNED} 局）`);
  out.push("");
  out.push("判据：**通关 = 正常返回且产生正式结局**（`ending` 事件）。");
  out.push("「进过终局场景」不参与判定，只作对照 —— 上一版把它当通关，于是同一份输出里");
  out.push("「通关 10/10」和「跑完没有结局 1/10」同时成立。");
  out.push("");
  out.push(`阈值：单局超时 ${TH.timeoutMs}ms，最多决策 ${TH.maxDecisions} 步，同名场景最多连续进 ${TH.maxRepeat} 次。`);
  out.push("");
  out.push("## 结论");
  out.push("");
  out.push(`**通关 ${report.passed}/${report.planned}**`);
  out.push("");
  out.push("| 失败项 | 局数 |");
  out.push("|---|---|");
  for (const [k, n] of Object.entries(report.byFailure)) out.push(`| ${FAIL_LABEL[k] ?? k} | ${n} |`);
  out.push("");
  out.push(`走到终局场景却没有结局：${report.finaleWithoutEnding} 局`);
  out.push("（这个数**必然**已经包含在上面的「跑完没有正式结局」里；两者不再互相矛盾）");
  out.push("");
  out.push("结局分布：");
  out.push("");
  for (const [k, n] of Object.entries(report.endings)) out.push(`  ${k.padEnd(16)} ${n}`);
  out.push("");
  out.push("## 复现性自检（同 seed 连跑两局）");
  out.push("");
  out.push(`  事件流一致：${eventsSame ? "是" : "否"}（draws ${a.draws} vs ${b.draws}）`);
  out.push(`  播报文本一致：${linesSame ? "是" : "否"}`);
  out.push("");
  if (eventsSame && linesSame) {
    out.push("  ✓ 整条 RNG 已注入且没有跨局残留状态，事件流与播报文本都可复现，");
    out.push("    seed **可以**作确定性回归依据。");
  } else if (eventsSame) {
    out.push("  · 事件流可复现，可作回归依据；播报文本不可复现 —— 说明还有**跨局残留的状态**");
    out.push("    （不是随机源，随机源会连事件流一起打乱）。**不要用文本 diff 做回归**，");
    out.push("    并把残留的那份状态找出来收进 RunContext / Dedup。");
  } else {
    out.push("  ⚠ 事件流都不可复现 —— 还有未被 `withSeededRandom` 接管的随机源，");
    out.push("    seed 不能当确定性依据。先把它找出来，别拿 seed 做回归。");
  }
  out.push("");
  out.push("## 逐局");
  out.push("");
  out.push("| 局 | seed | 进场 | 不同场景 | 决策 | 最大连续同场景 | 空选项 | 到终局场景 | 结局 | 判定 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const { outcome: o, fails } of report.rows) {
    out.push(
      `| ${report.rows.indexOf(report.rows.find((r) => r.outcome === o)!) + 1} | ${o.seed} | ${o.sceneEntries} | ${o.distinctScenes} | ` +
      `${o.decisions} | ${o.maxRepeat} | ${o.emptyOptionStops} | ${o.reachedFinaleScene} | ${o.ending || "(无)"} | ` +
      `${fails.length === 0 ? "通关" : fails.map((f) => FAIL_LABEL[f] ?? f).join("、")} |`,
    );
  }

  await writeReport("diag-fuzz.md", out.join("\n") + "\n");
  console.log(`通关 ${report.passed}/${report.planned}｜没结局 ${report.byFailure["no-ending"]}｜走到终局场景却没结局 ${report.finaleWithoutEnding}｜事件流可复现 ${eventsSame}  -> analysis/diag/diag-fuzz.md`);
}

main().catch((e) => { console.error("跑挂了:", e); process.exit(1); });
```

## scripts/diag/audit-backup.ts

```ts
// 分辨「丢了就没了」和「能重新生成」。
//
// ── 上一版为什么不可信 ──
// 1. `if (n === "poc") continue;` —— 假定整个 `poc/` 都有远端。可是 `.gitignore`
//    排掉了 `tools/ data/ play-logs/ analysis/ play-records/` 与
//    `frontend/public/{bgm,voice}`，光 bgm+voice 就 76MB。
//    「有仓库」不等于「入库了」，要问 git 而不是猜目录名。
// 2. 分类优先级反了：`.md/.yaml` 先撞「手写设计」→ 生成目录里的报告被算成人写的；
//    「备份残留」排在扩展名规则后面 → `x.ts.bak` 先被算成脚本，
//    于是「备份残留」那一档看着永远很干净。
// 3. 漏项：根目录 `.txt`（4.5MB 小说全文）、图片、音频、`.zip`、
//    `.py`（4109 个）、没有 raw/source 路径特征的手写 JSON/TXT。
//    review-request 第 5 条那个「53MB vs 489MB，差 9 倍」就是漏根目录 txt 来的。
// 4. `depth > 6 return` 和 `catch { return }` 都是**静默**的：
//    截断和读不了的目录一声不吭，算出来的总量凭什么可信。
// 5. 「其它」还剩一大堆没分类，却照样发布「不可再生 500MB」这种精确数。
//
// 分类判据抽成了纯函数 `src/diagnostics/backup-classify.ts`，
// 那边用临时路径字符串做正反夹具，不必真有一棵 4GB 的文件树才能测。

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  classifyPath, summarize, irreplaceableStatement,
  type AuditItem, type BackupClass,
} from "../../src/diagnostics/backup-classify";
import { writeReport } from "../../src/diagnostics/report";

const ROOT = "C:\\aitrpg";
const REPO = join(ROOT, "poc");
const MAX_DEPTH = 12;

// ── 1. 问 git：哪些文件真的入库了 ─────────────────────────────

function gitTrackedFiles(): { tracked: Set<string>; ok: boolean; note: string } {
  const r = spawnSync("git", ["-C", REPO, "ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    return {
      tracked: new Set(),
      ok: false,
      note: `git ls-files 失败（${r.error?.message ?? `退出码 ${r.status}`}）—— 无法区分已跟踪与被忽略，poc/ 全部按「未备份」计入`,
    };
  }
  const set = new Set(
    r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      .map((p) => join(REPO, p.replace(/\//g, "\\"))),
  );
  return { tracked: set, ok: true, note: "" };
}

/** 入库 ≠ 推上去了。没有 upstream 或有未推送提交，「有远端」这个前提就不成立 */
function remoteStatus(): string {
  const remotes = spawnSync("git", ["-C", REPO, "remote"], { encoding: "utf8" });
  if (remotes.error || remotes.status !== 0) return "⚠ 读不到 git remote —— 无法确认 poc/ 是否真有远端";
  const names = remotes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return "⚠ **poc/ 根本没有配置远端** —— 「已跟踪 = 有备份」这个前提不成立，全部按未备份看待";
  const ahead = spawnSync("git", ["-C", REPO, "rev-list", "--count", "@{u}..HEAD"], { encoding: "utf8" });
  if (ahead.error || ahead.status !== 0) {
    return `远端：${names.join(", ")}；⚠ 当前分支没有 upstream —— 已提交但未必推得上去`;
  }
  const n = Number(ahead.stdout.trim());
  return n > 0
    ? `远端：${names.join(", ")}；⚠ 有 ${n} 个提交**尚未推送** —— 这部分同样只存在于本机`
    : `远端：${names.join(", ")}；HEAD 已推送`;
}

// ── 2. 遍历。截断与读失败都要留痕，不许静默 ────────────────────

const items: AuditItem[] = [];
const truncatedDirs: string[] = [];
const unreadableDirs: string[] = [];
const unreadableFiles: string[] = [];
let trackedCount = 0;
let trackedSize = 0;

const { tracked, ok: gitOk, note: gitNote } = gitTrackedFiles();

function record(full: string, size: number) {
  const rel = full.startsWith(ROOT + "\\") ? full.slice(ROOT.length + 1) : full;
  const r = classifyPath({ rel, size });
  items.push({ rel, size, kind: r.kind, rule: r.rule, manualReview: r.manualReview });
}

function walk(dir: string, depth: number) {
  if (depth > MAX_DEPTH) { truncatedDirs.push(dir); return; }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    // 上一版这里是 `catch { return }` —— 读不了的目录一声不吭地从统计里消失
    unreadableDirs.push(`${dir}  (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  for (const n of names) {
    if (n === ".git" || n === "node_modules") continue;
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch (e) {
      unreadableFiles.push(`${p}  (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (st.isDirectory()) { walk(p, depth + 1); continue; }
    // poc/ 里**已跟踪**的文件才算有远端；被 .gitignore 排除的照样要审
    if (gitOk && tracked.has(p)) { trackedCount++; trackedSize += st.size; continue; }
    record(p, st.size);
  }
}

walk(ROOT, 0);

// ── 3. 汇总 ──────────────────────────────────────────────────

const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
const s = summarize(items);

const RECOVERY: Record<BackupClass, string> = {
  "源材料": "**找不回来** — 外部来源，未必还能拿到",
  "手写设计": "**找不回来** — 人写的",
  "脚本": "**找不回来** — 除非 poc 里有副本",
  "抽取产物": "能重跑（前提是源材料 + 脚本都在）",
  "备份残留": "本身就是旧副本，不必再备",
  "待确认": "**判据说不准，需要人过一遍**",
};

const out: string[] = ["# 备份分层：什么丢了就没了", ""];
out.push("范围：`C:\\aitrpg` **全部**，其中 `poc/` 只排除 git 已跟踪的文件。");
out.push("");
out.push(`- ${remoteStatus()}`);
out.push(`- poc/ 已跟踪（视为有远端，未计入下表）：${trackedCount} 个 / ${mb(trackedSize)} MB`);
if (!gitOk) out.push(`- ${gitNote}`);
out.push(`- 遍历深度上限 ${MAX_DEPTH}；被截断的目录 ${truncatedDirs.length} 个，读不了的目录 ${unreadableDirs.length} 个，读不了的文件 ${unreadableFiles.length} 个`);
out.push("");

out.push("| 类别 | 文件数 | 大小 (MB) | 丢了怎么办 |");
out.push("|---|---|---|---|");
for (const [k, v] of [...s.byKind.entries()].sort((a, b) => b[1].size - a[1].size)) {
  out.push(`| ${k} | ${v.count} | ${mb(v.size)} | ${RECOVERY[k]} |`);
}
out.push("");
out.push("## 结论");
out.push("");
out.push(irreplaceableStatement(s));
out.push("");

if (!s.complete) {
  out.push("## 待人工确认清单（判据说不准的那些）");
  out.push("");
  out.push("判据只能把它们排除在「明确可重建」之外，不能替人断定值不值得备份。");
  out.push("在这份清单被过完之前，**上面的总量只是下界**。");
  out.push("");
  const pending = items.filter((i) => i.kind === "待确认" || i.manualReview);
  const byRule = new Map<string, { n: number; size: number; samples: string[] }>();
  for (const p of pending) {
    const cur = byRule.get(p.rule) ?? { n: 0, size: 0, samples: [] };
    cur.n++; cur.size += p.size;
    if (cur.samples.length < 5) cur.samples.push(`${p.rel} (${mb(p.size)} MB)`);
    byRule.set(p.rule, cur);
  }
  for (const [rule, v] of [...byRule.entries()].sort((a, b) => b[1].size - a[1].size)) {
    out.push(`### ${rule} — ${v.n} 个 / ${mb(v.size)} MB`);
    out.push("");
    for (const sm of v.samples) out.push(`- \`${sm}\``);
    out.push("");
  }
  out.push("按大小排前 20 个待确认：");
  out.push("");
  for (const p of [...pending].sort((a, b) => b.size - a.size).slice(0, 20)) {
    out.push(`- \`${p.rel}\`  ${mb(p.size)} MB  [${p.rule}]`);
  }
  out.push("");
}

out.push("## 已确定不可再生 · 按大小排前 25");
out.push("");
const crit = items.filter((i) => ["源材料", "手写设计", "脚本"].includes(i.kind));
for (const it of [...crit].sort((a, b) => b.size - a.size).slice(0, 25)) {
  out.push(`- \`${it.rel}\`  ${mb(it.size)} MB  [${it.kind} · ${it.rule}]`);
}
out.push("");
out.push("## 最大的抽取产物（能重跑，但要时间）");
out.push("");
for (const it of items.filter((i) => i.kind === "抽取产物").sort((a, b) => b.size - a.size).slice(0, 8)) {
  out.push(`- \`${it.rel}\`  ${mb(it.size)} MB`);
}

if (truncatedDirs.length || unreadableDirs.length || unreadableFiles.length) {
  out.push("");
  out.push("## 遍历没覆盖到的地方（这些不在上面任何一个数字里）");
  out.push("");
  for (const d of truncatedDirs.slice(0, 20)) out.push(`- 深度截断：\`${d}\``);
  for (const d of unreadableDirs.slice(0, 20)) out.push(`- 读不了的目录：\`${d}\``);
  for (const f of unreadableFiles.slice(0, 20)) out.push(`- 读不了的文件：\`${f}\``);
}

await writeReport("audit-backup.md", out.join("\n") + "\n");
console.log(
  `${s.complete ? "审计完成" : "**审计未完成**"}｜已确定不可再生 ${s.irreplaceableCount} 个 / ${mb(s.irreplaceableSize)} MB｜` +
  `待确认 ${s.pendingCount} 个 / ${mb(s.pendingSize)} MB｜` +
  `深度截断 ${truncatedDirs.length}｜读失败 ${unreadableDirs.length + unreadableFiles.length}` +
  `  -> analysis/diag/audit-backup.md`,
);
```

## scripts/preflight.ts

```ts
// 改动前后各跑一次的自检。把反复犯的几类错做成机器判据，别靠记性。
//
// 用法：
//   bun scripts/preflight.ts            全查
//   bun scripts/preflight.ts --quick    只查快的（跳过测试）
//
// 检查项：切割残渣 / 占位注释 / 反向 import / PowerShell 读中文 / typecheck /
//         测试条数基线 / 文档引用的脚本是否入库 / 丢掉的成功与否返回值 /
//         无声吞错的 catch / 源码引用的证据文件是否存在 / 断线的公开方法 /
//         提交信息 commit-msg 判据是否真的装上（core.hooksPath）
//
// ⚠ 这份脚本自己返工过一次。上一版六项检查里，**五项能被同一段坏代码骗过**：
//   1. 切割残渣：只认 `return|await|赋值` 四种起手式 → 函数头被删后留下
//      `register()` / `if` / `for` 一个都不报；同时不看花括号深度 →
//      合法函数里「JSDoc + return」被当成切歪（这是 174 个假阳性的来源）。
//   3. 循环依赖：正则 `from ["']\.\.\/play-module["']` → dynamic import、
//      带扩展名的路径、别名、`export ... from`、`require()` 全漏；
//      而注释和字符串里的 import 文本反倒会误报。
//   4. PowerShell 风险：只查 `.ts`、只认 `spawnSync`，命中之后还只放进
//      `notes`，脚本照样 `exit 0` —— 报了等于没报。
//   5. typecheck：只 grep stdout 里的 `error TS`。进程没起来、被信号杀掉、
//      或者 tsc 换个输出格式，三种情况都是「炸了但报绿」。
//   6. 测试条数：只 print，不跟任何基线比 —— 那不是回归检查。
//
// 判据都抽到了 `src/diagnostics/source-scan.ts`，每一项有「应报」「不应报」
// 两侧测试（`src/__tests__/diag-preflight-checks.test.ts`）。

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { captureProcess } from "../src/diagnostics/process-capture";
import {
  findTruncatedBlocks, findPlaceholderResidue, findReverseImports, findShellRisks,
  judgeProcess, parseTestOutput, judgeTestCount, boundedBunFailureDiagnostics,
  referencedScripts, judgeScriptRefs, generatedDocs, resolveRef,
  referencedRepoPaths, LIVE_DOCS,
  architecturePathRefs, ARCHITECTURE_DOCS,
  docSectionRefs, docHeadings, judgeDocSectionRefs,
  boolReturningNames, findDroppedReturns, findSilentCatches,
  type Finding, type TestBaseline,
} from "../src/diagnostics/source-scan";

const quick = process.argv.includes("--quick");
const problems: string[] = [];
const notes: string[] = [];
const testFailureDiagnostics: string[] = [];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".codegraph", ".superpowers"]);

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => p.toLowerCase().endsWith(x))) out.push(p);
  }
  return out;
}

const read = (f: string) => readFileSync(f, "utf8"); // 中文源码必须走 fs，不能过 PowerShell
const push = (fs: Finding[]) => { for (const f of fs) problems.push(`${f.file}:${f.line}  ${f.message}`); };

const srcFiles = walk("src", [".ts"]);

// ── 1. 切割残渣：**顶层**块注释后面直接是语句 ──
//
// 收窄的关键是花括号深度必须为 0。深度 ≥ 1 的地方（接口字段、对象属性、
// switch case、联合类型续行、函数体内的说明）本来就允许注释后面跟非声明，
// 上一版没这一条，174 个假阳性淹掉 2 个真问题。
// 有了深度之后，判据可以反过来写：顶层注释后面**不是声明**就报，
// 于是 `register()` / `if` / `for` 这些残骸也一并认出来。
for (const f of srcFiles) push(findTruncatedBlocks(f, read(f)));

// ── 2. 搬运残渣：同一句占位注释出现多次 ──
for (const f of srcFiles) push(findPlaceholderResidue(f, read(f)));

// ── 3. 循环依赖：src/play/* 反向 import play-module ──
// 抽出来的模块反向 import 原文件就是环。tsc 不报，得自己看。
// 用 Bun 的解析器取 import（见 source-scan.scanImports）：静态/动态/require/
// `export ... from` 都认，注释与字符串里的 import 文本不认。
for (const f of srcFiles.filter((p) => p.includes("play") && !p.endsWith("play-module.ts"))) {
  push(findReverseImports(f, read(f), "play-module"));
}

// ── 4. 中文过 PowerShell ──
//
// 范围从「只有 scripts/*.ts」扩到仓库里真正在跑的脚本类型：
// `.ts/.js/.mjs/.cjs/.ps1`，覆盖 src、scripts、tools、frontend。
// `src/__tests__` 排除 —— 那里的坏样例是**判据的输入夹具**，不是真调用；
// 这条排除有明确理由，不是「让输出变绿」。
//
// 命中一律进 problems。上一版放进 notes 然后 exit 0，等于报了也没人拦。
const scriptExts = [".ts", ".js", ".mjs", ".cjs", ".ps1"];
const scriptFiles = [
  ...walk("src", scriptExts).filter((p) => !p.includes(join("src", "__tests__"))),
  ...walk("scripts", scriptExts),
  ...walk("tools", scriptExts),
  ...walk("frontend", scriptExts),
];
for (const f of scriptFiles) push(findShellRisks(f, read(f)));

// ── 8. 「成功与否」的返回值被丢掉 ──
//
// 「静默失败」在这个仓库有前科，docs/kp-tool-surface-assessment.md §八 记了两次，
// 原话是「类型检查与 710 个测试全绿，只有真实跑团暴露了它」。
// 这条检查第一次跑就逮到 `this.setScene(sceneId);` 两处 ——
// 而 `setActiveScene` 失败时会先清空全部 is_active，把世界弄成
// **一个活动场景都不剩**，比什么都没做更糟。
//
// 现在仓库里是 0 处，所以**不设豁免名单**：新增一处就红，
// 要么接住返回值，要么显式 `void`，要么说明白为什么可以不管。
{
  const scanned = [...srcFiles, ...walk("scripts", [".ts"])]
    .filter((p) => !p.includes(join("src", "__tests__")));
  const boolNames = new Set<string>();
  for (const f of scanned) for (const n of boolReturningNames(read(f))) boolNames.add(n);
  for (const f of scanned) push(findDroppedReturns(f, read(f), boolNames));
  notes.push(`返回 boolean 的实现 ${boolNames.size} 个，返回值被丢掉 0 处（超过 0 就会变成上面的问题）`);
}

// ── 9. 无声吞掉错误的 catch ──
//
// 空 catch 不是罪，**吞掉了却不说为什么**才是。
// 实跑第一次逮到 `mythos-module` 两处：`JSON.parse(exits)` 失败后照样
// 把空数组写回数据库，场景出口被静默抹掉 —— 正是 §八 记的那种事故。
// 修完是 0 处，同样不设豁免名单：写一行理由就能过，这个成本该付。
for (const f of [...srcFiles, ...walk("scripts", [".ts"])]) {
  push(findSilentCatches(f, read(f)));
}

// ── 7. 生成的文档叫人跑的脚本，仓库里得真有 ──
//
// `docs/handoff.md` 曾经整整一张表指着 `tools/_diag-*.ts`，而 `tools/`
// 在 .gitignore 里 —— 新克隆一个都没有。判据入了库、测试也齐了，
// 可跑它们的入口不在仓库里。这跟「判据看着在检查、其实什么也没量」
// 是同一类错，只是换了层皮，所以做成检查项。
//
// **只查脚本生成的那几份文档**：它们每次都会被重写，里面的每一句都必须
// 当下为真。`docs/notes/*.md` 是 append-only 的工作记录，
// 「当时用某个一次性脚本数出 4 处」是历史事实，那脚本后来删了不算缺陷。
// 不收窄的话第一次跑就是 43 个报告，其中 42 个来自 notes —— 又一次假阳性淹没真问题。
{
  const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // git ls-files 出来的就是正斜杠，不用归一化。
  const trackedPaths = (tracked.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const gitOk = !tracked.error && tracked.status === 0;
  // 磁盘候选：文档里可能写裸文件名/相对路径（`play/clue-check.ts`），
  // 得拿真实文件树去反查它落在哪个完整路径上。
  // ⚠ join() 在 Windows 上产出反斜杠，resolveRef 的 endsWith("/"+ref) 靠正斜杠
  //   分隔，不归一化这里会让「存在性」判断全量假阳性（永远判不存在）。
  const diskCandidates = [
    ...walk("src", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("scripts", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("tools", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("frontend", [".ts", ".js", ".mjs", ".cjs"]),
  ].map((p) => p.replace(/\\/g, "/"));
  const generated = generatedDocs(walk("scripts", [".ts"]).map(read));
  for (const doc of generated) {
    if (!existsSync(doc)) continue; // 还没生成过，不是这条检查的事
    const refs = referencedScripts(read(doc)).map((p) => ({
      path: p,
      exists: resolveRef(p, diskCandidates),
      // git 拿不到时不冤枉人：只查存在性，并在 notes 里说清楚
      tracked: gitOk ? resolveRef(p, trackedPaths) : true,
    }));
    push(judgeScriptRefs(refs, doc));
  }
  notes.push(`文档引用校验覆盖 ${generated.length} 份生成文档：${generated.join("、") || "(无)"}`);
  if (!gitOk) notes.push("git ls-files 不可用 —— 只校验了文档引用脚本是否存在，没校验是否入库");

  // ── 7b. 手写但载荷的文档：同一个病，换一批文档 ──
  //
  // 上面那截只查脚本生成的 3 份。另有 8 份手写文档被当成设计依据/验收标准
  // 引用（生产代码、测试注释都指着它们），但没有脚本重写过，路径一样会漂。
  //
  // 只查存在性、不查入库（tracked）—— tier-1 是叫人去"跑"的脚本，新克隆
  // 必须有；这几份是清单/评估文档，"里面写的东西还在不在"才是它的断言，
  // 跟入不入库无关。候选范围比 tier-1 多一个 docs/ 目录（引用范围也多了
  // docs/ 前缀），但同样只认脚本扩展名——见 referencedRepoPaths 的注释。
  const docCandidates = [
    ...walk("src", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("scripts", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("tools", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("frontend", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("docs", [".ts", ".js", ".mjs", ".cjs"]),
  ].map((p) => p.replace(/\\/g, "/"));
  let liveDocsChecked = 0;
  for (const doc of LIVE_DOCS) {
    if (!existsSync(doc)) continue;
    liveDocsChecked++;
    const refs = referencedRepoPaths(read(doc)).map((p) => ({
      path: p,
      exists: resolveRef(p, docCandidates),
      tracked: true, // tier-2 不判入库
    }));
    push(judgeScriptRefs(refs, doc));
  }
  notes.push(`手写载荷文档校验覆盖 ${liveDocsChecked} 份（只判存在性，不判入库）：${LIVE_DOCS.join("、")}`);

  // ── 7c. 结构化的手写载荷文档：architecture.json ──
  //
  // 同一个病的第三层皮：这份是 JSON，tier-1/tier-2 的正则（要么找
  // writeFileSync 目标、要么找反引号包裹的路径）都够不到它。按结构取
  // sections[].tables[].rows[][0]，跳过"工具脚本"节——见
  // architecturePathRefs 的注释。候选/存在性判法与 tier-2 一致，
  // 复用同一份 docCandidates，不用为多一份文档单独扫一次磁盘。
  let architectureDocsChecked = 0;
  for (const doc of ARCHITECTURE_DOCS) {
    if (!existsSync(doc)) continue;
    architectureDocsChecked++;
    const refs = architecturePathRefs(read(doc)).map((p) => ({
      path: p,
      exists: resolveRef(p, docCandidates),
      tracked: true, // 同 tier-2：只判存在性，不判入库
    }));
    push(judgeScriptRefs(refs, doc));
  }
  notes.push(`结构化载荷文档校验覆盖 ${architectureDocsChecked} 份（只判存在性，跳过"工具脚本"节）：${ARCHITECTURE_DOCS.join("、")}`);

  // ── 7d. 反向：文档引用文档的存在性 ──
  //
  // 前三层全部只查"文档引用的代码路径是否有效"这一个方向。文档引用
  // 另一份文档、或另一份文档的某个小节，完全没有判据覆盖——2026-08-29
  // 精简 docs/index-world-model.md 那一轮，docs/todo.json 与
  // docs/notes/ingest.md 各留了一处指向被删小节的死链，没有任何检查拦下。
  //
  // 只认规范写法 `` `docs/路径.md`「小节标题」``（见 docSectionRefs 的注释）；
  // 扫描范围是全部入库的 docs/**/*.md 加 docs/todo.json（后者是 JSON 字符串，
  // 直接当文本扫，正则一样能命中）。
  const docSourceFiles = [
    ...walk("docs", [".md"]),
    "docs/todo.json",
  ].filter((p) => existsSync(p));
  let docRefsChecked = 0;
  for (const doc of docSourceFiles) {
    const refs = docSectionRefs(read(doc));
    if (refs.length === 0) continue;
    docRefsChecked++;
    const verdicts = refs.map((ref) => {
      const fileExists = existsSync(ref.file);
      const sectionExists = fileExists && docHeadings(read(ref.file)).has(ref.section);
      return { ref, fileExists, sectionExists };
    });
    push(judgeDocSectionRefs(verdicts, doc));
  }
  notes.push(`文档互相引用校验（反向判据）覆盖 ${docRefsChecked} 份含小节引用的文档，规范写法之外的引用不在覆盖范围`);

  // ── 10. 源码拿来当证据的文件，仓库里得真有 ──
  //
  // 第 7 项管的是「文档叫人跑的脚本」，这一项管的是「代码引用的证据」。
  // 同一个病，另一层皮：四处注释写着「实跑原文见 play-logs/run-….txt」，
  // 而 `play-logs/` 在 .gitignore 里 —— **克隆下来的人根本打不开那个文件**。
  // 一句指向不存在之物的证据，读起来像有据可查，实际等于没有。
  //
  // 只认「路径样子的引用」：带目录分隔符且有扩展名。散文里提一句
  // 「见跑局日志」不算，那没许诺具体哪一份。
  //
  // ⚠ **不查 `analysis/`**。判据第一版把它算进来，报出 4 条全是误报：
  //   那是各个探针在 console.log 里声明自己的产物路径。
  //   `analysis/` 的东西都能由一个点得出名字的脚本重跑再生，
  //   引用它不算「指向不存在之物」。真正查不回来的是
  //   `play-logs/`（一次性跑局原文）、`tools/`（历史草稿）、`data/`（本机库）。
  const EVIDENCE_REF = /(?:^|[\s(（「`])((?:play-logs|data|tools)\/[\w./-]+\.(?:txt|md|json|jsonl))/g;
  const srcFiles = [...walk("src", [".ts"]), ...walk("scripts", [".ts"])];
  for (const f of srcFiles) {
    const text = read(f);
    for (const m of text.matchAll(EVIDENCE_REF)) {
      const ref = m[1]!;
      const line = text.slice(0, m.index).split("\n").length;
      if (!existsSync(ref)) {
        push([{ file: f, line, rule: "evidence-missing", message: `引用的证据文件不存在：${ref}` }]);
      } else if (gitOk && !trackedPaths.includes(ref)) {
        push([{
          file: f, line, rule: "evidence-untracked",
          message: `证据没入库，别人克隆下来打不开：${ref}`
            + `（要么拷进 docs/evidence/ 并改引用，要么别在注释里点具体文件名）`,
        }]);
      }
    }
  }
}

// ── 5. typecheck ──
// 先看退出状态（error / signal / status），再看输出。
// 只 grep 输出的话，进程没起来时输出是空串，判据会当成「零个错」。
const tsc = spawnSync("bun", ["run", "typecheck"], { encoding: "utf8", shell: true });
const tscVerdict = judgeProcess("typecheck", tsc);
const tscOut = (tsc.stdout ?? "") + (tsc.stderr ?? "");
if (!tscVerdict.ok) {
  problems.push(tscVerdict.reason);
  const tsErrors = tscOut.split("\n").filter((l) => /error TS/.test(l));
  const syntax = tsErrors.filter((l) => /TS1\d{3}/.test(l));
  if (tsErrors.length) problems.push(`  输出里能认出 ${tsErrors.length} 条 error TS`);
  if (syntax.length) problems.push(`  其中 ${syntax.length} 条是**语法错** —— 通常意味着切歪了，不是缺 import`);
  for (const e of tsErrors.slice(0, 5)) problems.push("  " + e.trim());
} else {
  // 退出码 0 但输出里有 error TS = tsc 的行为变了，同样要拦
  const stray = tscOut.split("\n").filter((l) => /error TS/.test(l));
  if (stray.length) problems.push(`typecheck 退出码 0，输出里却有 ${stray.length} 条 error TS —— 判据与工具行为不一致，先查清楚`);
  else notes.push("typecheck 通过（退出码 0）");
}

// ── 6. 测试：退出状态 + 条数基线 ──
// 「只打印当前条数」不是检查 —— 跟什么比？有基线才有回归。
const BASELINE_PATH = "docs/test-baseline.json";
if (!quick) {
  // Full-run fixtures share filesystem, SQLite, and CPU-heavy PDF work. The
  // runner-level per-test default must be explicit on Bun's CLI; a preload
  // cannot configure other test files. The verified 200-receipt filesystem
  // fixture declares a bounded 30s local limit, so the CLI cap cannot be
  // shorter. Keep one reproducible worker and a finite 30s runner ceiling.
  const t = await captureProcess("bun", ["test", "--parallel=1", "--timeout", "30000"]);
  const text = (t.stdout ?? "") + "\n" + (t.stderr ?? "");
  const verdict = judgeProcess("bun test", t);
  const counts = parseTestOutput(text);

  if (!verdict.ok || (counts.failed ?? 0) > 0) {
    const diagnostics = boundedBunFailureDiagnostics(text);
    if (diagnostics.length) {
      testFailureDiagnostics.push(...diagnostics);
    } else {
      problems.push("bun test 失败，但 Bun 输出中没有可解析的失败用例名（未重放完整测试输出）");
    }
  }

  if (!existsSync(BASELINE_PATH)) {
    problems.push(`缺少测试基线 ${BASELINE_PATH} —— 没有基线就没有回归检查；先跑一次并写入 {"tests":N,"files":M}`);
  } else {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as TestBaseline;
    const r = judgeTestCount(counts, base);
    problems.push(...r.problems);
    notes.push(...r.notes);
  }
  // 退出码与条数是两条独立证据，都要看：
  // 条数对得上但进程非零退出（比如收尾时崩了）同样是坏的。
  if (!verdict.ok && (counts.failed ?? 0) === 0) {
    problems.push(`${verdict.reason}（输出里没解析到失败条数 —— 别因为「看着没 fail」就放过）`);
  } else if (!verdict.ok) {
    problems.push(verdict.reason);
  }
} else {
  notes.push("--quick：跳过测试与条数基线检查");
}

// ── 11. 断线：类的公开方法没有调用方 ──
//
// 这一轮反复撞见同一个病：**两端都写好了，中间那根线没接**。
//   · `NPCCombatEngine.getSanCost()`               遭遇修格斯 = 遭遇野狗
//   · `InvestigationEngine.setDifficultyProfile()` 难度按钮按下去什么都没变
// 数据在、实现在，只差一句调用。不报错、不让测试变红，
// 只让「本该发生的事」安静地不发生。
//
// 现有的 `probe-dead-code` 抓不到 —— 它量的是**模块级导出**，
// 而这些是**类的公开方法**：类本身在用，只有那一个方法没人调。
// tsc 也不管（`noUnusedLocals` 不看公开方法）。
//
// ⚠ 判法是「**不许增长**」而不是「必须为 0」。
//   当前有 90 处，绝大多数是整套没接线的子系统（经济/派系/金融/法术/职业档案）——
//   要求清零等于要求现在把它们全删掉或全接上，那不是这一条该做的决定。
//   能守住的是：**别再新增**。哪天有人又写了一个没人调的 setter，这里会变红。
{
  const p = spawnSync("bun", ["scripts/diag/probe-unwired.ts"], { encoding: "utf8", shell: true });
  const verdict = judgeProcess("probe-unwired", p);
  const out = (p.stdout ?? "") + (p.stderr ?? "");
  const m = verdict.ok ? /没调用方\s*(\d+)/.exec(out) : null;
  if (!verdict.ok) {
    problems.push(verdict.reason);
  } else if (!m) {
    problems.push("断线判据没跑起来（probe-unwired 的输出里解析不到条数）—— 判据自己坏了也要变红");
  } else {
    const now = Number(m[1]);
    const base = existsSync(BASELINE_PATH)
      ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { unwiredMethods?: number }).unwiredMethods
      : undefined;
    if (base === undefined) {
      problems.push(`${BASELINE_PATH} 里缺 unwiredMethods 基线 —— 没有基线就没有回归检查；当前是 ${now}`);
    } else if (now > base) {
      problems.push(
        `没有调用方的公开方法从 ${base} 涨到 ${now} —— 新写的能力没接上，` +
        `或者接线被改掉了。看 analysis/diag/probe-unwired.md`,
      );
    } else {
      notes.push(
        now < base
          ? `断线 ${base} → ${now}（少了 ${base - now} 处，记得把基线调下来）`
          : `断线 ${now} 处，与基线一致（判法是不许增长，不是必须为 0 —— 理由见 preflight 第 11 项）`,
      );
    }
  }
}

// ── 12. 提交信息约定的机器判据是否真的在跑（docs/todo.json rule-04）──
//
// `.githooks/commit-msg` 生效靠 `git config core.hooksPath .githooks`——
// 这条配置**不随提交走**，新 clone 下来默认不生效。一个可能没装上的
// hook，正是本仓反复修的那种「看着在检查、其实什么也没量」：装了和
// 没装，从提交历史上看不出区别。这条检查把「判据没在跑」本身变成
// 能被 preflight 抓到的事，不靠人记得去核对。
{
  const hooksPath = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8", shell: true });
  const configured = (hooksPath.stdout ?? "").trim();
  const verdict = judgeProcess("git config core.hooksPath lookup", hooksPath);
  const stderr = (hooksPath.stderr ?? "").trim();
  const unset = hooksPath.status === 1 && !hooksPath.error && !hooksPath.signal && configured === "" && stderr === "";
  if (!verdict.ok && !unset) {
    problems.push(verdict.reason + (stderr ? `（stderr：${stderr}）` : ""));
  } else if (configured !== ".githooks") {
    problems.push(
      `core.hooksPath 没有指向 .githooks（当前：「${configured || "(未设置)"}」）—— ` +
      `commit-msg 判据没有真的在跑。跑一次 \`git config core.hooksPath .githooks\`。`,
    );
  } else if (!existsSync(".githooks/commit-msg")) {
    problems.push("core.hooksPath 已指向 .githooks，但 .githooks/commit-msg 文件不存在——判据丢了。");
  } else {
    notes.push("core.hooksPath 已指向 .githooks，commit-msg 判据在跑（未装上时这条只能靠人遵守）。");
  }
}

// ── 输出 ──
console.log(problems.length === 0 ? "✓ preflight 通过" : `✗ preflight 发现 ${problems.length} 个问题`);
for (const p of problems) console.log("  " + p);
if (testFailureDiagnostics.length) {
  console.log("\n  bun test bounded failure context:");
  for (const line of testFailureDiagnostics) console.log("    " + line);
}
if (notes.length) {
  console.log("");
  for (const n of notes) console.log("  · " + n);
}
process.exit(problems.length ? 1 : 0);
```

======================================================================
# 附：最近一次产物（供对照）
======================================================================

## analysis/diag/diag-phrasing.md

```
# 玩家说的话，引擎认不认

拿模组里每个多出口场景 × 每个出口 × **17 种说法**（正例/反例/歧义三类），
每种再按连接的原序与逆序各跑一遍 —— 只跑一种顺序时，干扰项恰好排在目标之后就会全绿。

判据（见 `src/diagnostics/phrasing.ts`，有正反例校准测试）：

| 类别 | 通过条件 | 进不进命中率 |
|---|---|---|
| 正例 | 选中目标且 `forced=false` | 进 |
| 反例 | 不选中被否定/被提及的那个，且去了指定目标 | 不进 |
| 歧义 | `forced=true`（引擎老实承认是替选） | 不进 |

## 汇总

- **目标命中率（仅正例）：800/800 = 100.0%**
- 反例通过率：144/144 = 100.0%
- 歧义输入「老实承认替选」率：234/234 = 100.0%

按连接顺序分：

| 顺序 | 通过 | 总数 | 通过率 |
|---|---|---|---|
| 原序 | 589 | 589 | 100.0% |
| 逆序 | 589 | 589 | 100.0% |

## 逐条说法

| 类别 | 说法 | 通过 | 总数 | 通过率 |
|---|---|---|---|---|
| ambiguous | a1-同义改写 同义改写（不含任何地名） | 76 | 76 | 100.0% |
| ambiguous | a2-代词 代词指代 | 76 | 76 | 100.0% |
| ambiguous | a3-描述特征 描述目的地特征 | 76 | 76 | 100.0% |
| ambiguous | a4-前两字 只说地名前两字（不唯一） | 6 | 6 | 100.0% |
| negative | n1-否定 否定一个目标同时指定另一个 | 72 | 72 | 100.0% |
| negative | n2-提及非目标 提到别处但目标是自己点名的那个 | 72 | 72 | 100.0% |
| positive | p1-原文 照抄选项原文 | 76 | 76 | 100.0% |
| positive | p10-唯一别名 唯一别名 | 44 | 44 | 100.0% |
| positive | p11-唯一后缀 唯一后缀（中心词） | 74 | 74 | 100.0% |
| positive | p2-地名 只说地名 | 76 | 76 | 100.0% |
```

## analysis/diag/diag-downed.txt

```
范围：**昏迷期间该角色自己发起的技能检定**。
SAN 检定（被动反应）、同伴代做的检定、受伤那一刻的重伤结算检定都不算违规，但都单列计数。

第 1~3 局，共 3 局（异常 0 局，已计入）：出现昏迷 1 局，两人同时倒下 0 局

倒下成因：HP 直接归零 1 次，重伤体质检定失败 0 次
急救唤醒成功 0 次；苏醒后本人正常检定 0 次（这些**不是**违规）
昏迷期间同伴代做的检定 4 次（不是违规）
昏迷期间的 SAN 检定 3 次（范围外，被动反应）
受伤当场的重伤结算检定豁免 0 次

**违规（昏迷期间本人掷骰）：0 次**

✓ 昏迷期间没有本人发起的技能检定
```

## analysis/diag/diag-wounds.txt

```
3 局（异常 0 局，已计入）

## 伤势分级（按引擎算出的 severity，不看播报标签）

  伤害事件 12 次
  scratch   4
  flesh     6
  deep      2
  grievous  0
  lethal    0

  ⚠ HP 归零那一行的播报后缀是「昏迷/濒死！」，按文本分档会把这一档整个漏掉。

## 重伤流程

  deep/grievous 且人还站着：1 次 → 应有同样次数的重伤体质检定
  deep/grievous 但当场昏迷：1 次 → **不该**掷体质检定（人已经躺下，那一掷没什么可决定的）
    · 口径由 `needsMajorWoundCheck()` 一处说了算。四个调用点原先两种写法，
      判据当时只能把这一档单列出来不下结论 —— 判据被实现的不一致逼哑了。
  实际重伤体质检定：1 次
  记下的伤势：1 次，处理掉：0 次

## 惩罚骰来源必须分开

  真被伤势罚到的检定：0 次   ← 这是伤势机制生效的**唯一**证据
  只带环境/疲劳惩罚的检定：3 次   ← 不许拿它充数
  有伤但该掷骰路径不读伤势：0 次   ← 应为 0，见下

  · 战斗里调查员的攻击掷骰原先直接调 `CoCEngine.skillCheck`，绕过 `checks.ts` 的
    `check()`，伤势惩罚在战斗攻击上一点作用都没有。这个缺口正是「按来源分账」
    之后露出来的：记下的伤势有好几处，真被伤势罚到的检定却几乎为零。
    现已接上（疲劳与伤势分别标注，合计仍受 CoC 7e 的 2 颗上限约束）。
    这一行留着守回归：再有谁另开一条绕过 `check()` 的路，它会立刻非零。

## 不变量破例

  ✓ 无破例（1 次重伤各自恰有一次不受自身伤势影响的体质检定，
    0 次后续检定带伤势惩罚，0 次处理后惩罚消失）
```

## analysis/diag/diag-combat.txt

```
3 局（异常 0 局，已计入）：发生战斗 2 局

## 敌人还手（按攻击者身份认，不按技能名）

  敌人挥击 12 次：命中 4，被闪开 1，没掷中 7
  调查员攻击掷骰 13 次
  战斗中玩家掉血合计 15 点
  攻击者身份对不上的事件 0 次（应恒为 0，非 0 说明事件源出问题）

## 判据：按**发生战斗的那一局**看，不看跨局总数

  ✓ 2/2 局敌人都还手了

## 战斗中的昏迷（两条成因都认）

  HP 直接归零 1 次，重伤体质检定失败 0 次
  · 第二条在播报里**没有** `HP n → 0` 那一行，只按文本找必然漏。

## 战斗结果分布

  lost       1
  defeated   1

## 逐局

  #1 vs 米-戈：4 轮，敌人挥击 8 次，调查员攻击 7 次，玩家掉血 11，结果 lost
  #2 vs 米-戈：3 轮，敌人挥击 4 次，调查员攻击 6 次，玩家掉血 4，结果 defeated
```

## analysis/diag/audit-backup.md

```
# 备份分层：什么丢了就没了

范围：`C:\aitrpg` **全部**，其中 `poc/` 只排除 git 已跟踪的文件。

- 远端：origin；HEAD 已推送
- poc/ 已跟踪（视为有远端，未计入下表）：299 个 / 3.5 MB
- 遍历深度上限 12；被截断的目录 0 个，读不了的目录 0 个，读不了的文件 0 个

| 类别 | 文件数 | 大小 (MB) | 丢了怎么办 |
|---|---|---|---|
| 抽取产物 | 89349 | 2028.6 | 能重跑（前提是源材料 + 脚本都在） |
| 源材料 | 308 | 801.0 | **找不回来** — 外部来源，未必还能拿到 |
| 待确认 | 6339 | 196.8 | **判据说不准，需要人过一遍** |
| 脚本 | 4355 | 15.3 | **找不回来** — 除非 poc 里有副本 |
| 手写设计 | 753 | 7.4 | **找不回来** — 人写的 |
| 备份残留 | 10 | 3.8 | 本身就是旧副本，不必再备 |

## 结论

⚠ 审计**未完成**，不给精确总量。
已确定不可再生**至少** 5416 个文件 / 823.6 MB；
另有待人工确认 6341 个 / 200.1 MB，上界为 1023.7 MB。
原因：待确认 6341 个 / 200.1 MB（占 6.6%），超过 2% 或 50MB 阈值

## 待人工确认清单（判据说不准的那些）

判据只能把它们排除在「明确可重建」之外，不能替人断定值不值得备份。
在这份清单被过完之前，**上面的总量只是下界**。

### small-text-unclassified — 6318 个 / 115.2 MB

- `poc\.superpowers\sdd\acc.txt (0.0 MB)`
- `poc\.superpowers\sdd\acc2.txt (0.0 MB)`
- `poc\.superpowers\sdd\acc3.txt (0.0 MB)`
- `poc\.superpowers\sdd\ci.txt (0.0 MB)`
- `poc\.superpowers\sdd\ci2.txt (0.0 MB)`

### unknown-ext — 19 个 / 60.3 MB

- `poc\.codegraph\.gitignore (0.0 MB)`
```
