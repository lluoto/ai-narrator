// 摄取管线 · 实跑报告组装——开发·无基准模式 任务①。
//
// 从 `scripts/ingest/run.ts` 抽出来的纯函数：给什么数据、报什么内容，
// 不碰 IO。分两种模式：
//   有基准（`ctx.comparison` 不是 undefined）—— 逐节输出覆盖率/精确率/
//     准确率/calibrate diff，与本文件抽出之前 run.ts 里那份报告逐字一致
//     （这是本轮的回归红线：谷仓走这条路径，产出必须与改动前逐位不变）。
//   无基准（`ctx.comparison` 是 undefined）—— 每一节依赖基准的地方都换成
//     明确的"无基准，跳过"，不是静默不打印那一节、也不是尝试硬凑。
//     `now.md`「失败要主动喊出来，别指望别人从『零条 warn』里猜」——
//     一份看不出"哪些没测"的报告比没有报告更危险，所以"跳过"本身
//     也要是报告里能读到的一行字，不是从"这节不见了"倒推出来的空缺。
//
// 悬空引用检查不属于任何一种模式的专属——它是内部一致性（item.sceneId
// 是否在生成的 scenes 里找得到），两种模式都要跑、都要报。

import type { ModuleItem, Scene } from "../module/types";
import type { BaselineComparisonResult } from "./baseline-comparison";
import { formatDiff } from "./calibrate";

export interface NarrativeReportInfo {
  accepted: boolean;
  openingAtmosphereCount: number;
  prologueLineCount: number;
  hasPartySetup: boolean;
  provenanceCount: number;
  /** 创作层登记表判据：缺 sourceRef 集合与显式登记集合是否精确相等 */
  registryMatches: boolean;
  warnings: string[];
}

export interface CorpusSourceComparisonInfo {
  available: boolean;
  identical?: boolean;
  pageCorpusLength?: number;
  sliceCorpusLength?: number;
}

export interface CorpusReportInfo {
  ok: boolean;
  reason?: string;
  /** 与仓库里预先切好的切片语料的比较结果（开发·无基准模式 任务②）——只有谷仓有切片可比，其它模组这里恒为 available:false */
  sourceComparison?: CorpusSourceComparisonInfo;
}

export interface IngestReportContext {
  pageCount: number;
  sectionCount: number;
  classifyInputCount: number;
  kindsSize: number;
  dist: Map<string, number>;
  unanswered: string[];

  scenes: Scene[];
  sceneWarnings: string[];

  itemInputCount: number;
  itemKindsSize: number;
  itemIdsSize: number;
  itemDist: Map<string, number>;
  itemUnanswered: string[];
  items: ModuleItem[];
  provenanceCount: number;
  itemWarnings: string[];

  clueCount: number;
  clueProvenanceCount: number;
  clueWarnings: string[];

  npcCount: number;
  danglingRefs: string[];

  narrative: NarrativeReportInfo;
  corpus: CorpusReportInfo;

  /** 有基准时传入；无基准时不传，报告的相应小节整体切到"无基准，跳过" */
  comparison?: BaselineComparisonResult;
}

const NO_BASELINE_LINE = "无基准，跳过——本次摄取没有可对照的基准模组数据。";

export function buildIngestReport(ctx: IngestReportContext): string {
  const lines: string[] = [];

  // ── 评分键左手边 ──
  if (ctx.comparison) {
    const { keyLhs } = ctx.comparison;
    lines.push(
      `评分键左手边: 抽出条目 ${keyLhs.extractedCount} / 键 ${keyLhs.keyCount} —— ${keyLhs.keyMissing.length === 0 && keyLhs.keyStale.length === 0 ? "**完全一致**" : "**对不上**"}`,
      `  抽出来了但键里没有（不参与计分）${keyLhs.keyMissing.length} 个: ${keyLhs.keyMissing.join("、") || "无"}`,
      `  键里有但抽不出来（行号漂了？）${keyLhs.keyStale.length} 个: ${keyLhs.keyStale.join("、") || "无"}`,
    );
    if (keyLhs.duplicateNote) lines.push(`  **${keyLhs.duplicateNote}**`);
  } else {
    lines.push("评分键左手边: " + NO_BASELINE_LINE);
  }
  lines.push("");

  // ── 块与场景 ──
  lines.push(
    `页数 ${ctx.pageCount} / 块 ${ctx.sectionCount} / 送分类 ${ctx.classifyInputCount} / 分类返回 ${ctx.kindsSize}`,
    `分类分布: ${[...ctx.dist].map(([k, n]) => `${k} ${n}`).join(" / ") || "无"}`,
    `送了但没拿到分类的块: ${ctx.unanswered.join("、") || "无"}`,
    `判成场景 ${ctx.scenes.length} 个`,
  );
  if (ctx.comparison) {
    const { sceneCoverage } = ctx.comparison;
    lines.push(
      `基准 ${sceneCoverage.baseSceneCount} 个场景，**按 name 严格覆盖 ${sceneCoverage.hit.length}**`,
      `名字变体（基准多了手写括号注解，实际是同一个场景）${sceneCoverage.variantPairs.length} 个: ${sceneCoverage.variantPairs.join("、") || "无"}`,
      `**按场景身份覆盖 ${sceneCoverage.hit.length + sceneCoverage.variantPairs.length}** —— 严格覆盖加上变体`,
      `真漏报（连去掉注解都对不上）: ${sceneCoverage.trueMissing.join("、") || "无"}`,
      `真误报（扣掉变体那侧）${sceneCoverage.trueExtraScenes.length} 个: ${sceneCoverage.trueExtraScenes.join("、") || "无"}`,
      `对账: 覆盖 ${sceneCoverage.hit.length + sceneCoverage.variantPairs.length} + 真误报 ${sceneCoverage.trueExtraScenes.length} = ${sceneCoverage.hit.length + sceneCoverage.variantPairs.length + sceneCoverage.trueExtraScenes.length}，判成场景 ${ctx.scenes.length}${sceneCoverage.hit.length + sceneCoverage.variantPairs.length + sceneCoverage.trueExtraScenes.length === ctx.scenes.length ? "，对上了" : "，**对不上——有重名标题被两边同时吃掉**"}（生成侧对上基准名字的 ${sceneCoverage.sceneMatchingGenerated} 个）`,
    );
  } else {
    lines.push("场景覆盖率: " + NO_BASELINE_LINE);
  }
  lines.push("", "scene warnings:", ...ctx.sceneWarnings.map((w) => `  ${w}`), "");

  if (ctx.comparison) {
    const { sceneIdInherit } = ctx.comparison;
    lines.push(
      `场景 id 继承基准：${sceneIdInherit.idMap.size}/${ctx.scenes.length} 继承成功，${sceneIdInherit.warnings.length} 个保留内部 id（不是错误，是如实报出的已知缺口）`,
      ...sceneIdInherit.warnings.map((w) => `  ${w}`),
    );
  } else {
    lines.push(`场景 id 继承: ${NO_BASELINE_LINE}全部保留内部句柄（scene_NN），未继承任何 id。`);
  }
  lines.push("");

  // ── 条目与物品 ──
  lines.push(
    "── 条目与物品 ──",
    `条目 ${ctx.itemInputCount} 送分类 / 分类返回 ${ctx.itemKindsSize}（全文共 ${ctx.itemIdsSize} 个结构化条目，来源包括显式标记与受上下文约束的发现列表；其余不在场景块上）`,
    `条目分类分布: ${[...ctx.itemDist].map(([k, n]) => `${k} ${n}`).join(" / ") || "无"}`,
    "",
  );

  if (ctx.comparison) {
    const { itemClassification } = ctx.comparison;
    lines.push(
      `── 条目分类准确率（拿评分键算，第一次能算全）──`,
      `**${itemClassification.correct}/${itemClassification.total}**（${((itemClassification.correct / Math.max(itemClassification.total, 1)) * 100).toFixed(0)}%）`,
      `  不计分 ${itemClassification.unscoreable.length} 条（键说 none —— 基准没收，无所谓对错）: ${itemClassification.unscoreable.join("、") || "无"}`,
      ...(itemClassification.notInKey.length ? [`  **送了分类但键里没有 ${itemClassification.notInKey.length} 条**: ${itemClassification.notInKey.join("、")}`] : []),
      "",
      "  混淆矩阵（预测 → 期望）:",
      ...[...itemClassification.confusion]
        .sort()
        .flatMap(([pred, inner]) => {
          const tot = [...inner.values()].reduce((a, b) => a + b, 0);
          return [
            `    判为 ${pred}（${tot}）:`,
            ...[...inner]
              .sort((a, b) => b[1] - a[1])
              .map(([exp, n]) => `        → 实际 ${exp} ${n}${exp === pred ? "  ✓" : ""}`),
          ];
        }),
      "",
      "  判错的逐条:",
      ...itemClassification.scored
        .filter((s) => !s.ok)
        .map((s) => `    ${s.key} 判 ${s.predicted} / 实际 ${s.expected.join("+")} — ${s.name || "（无名）"}`),
    );
  } else {
    lines.push(`── 条目分类准确率 ──`, NO_BASELINE_LINE);
  }
  lines.push(
    `送了但没拿到分类的条目: ${ctx.itemUnanswered.join("、") || "无"}`,
    `建成物品 ${ctx.items.length} 个，provenance ${ctx.provenanceCount} 条`,
  );

  if (ctx.comparison) {
    const { itemCoverage } = ctx.comparison;
    lines.push(
      `基准 ${itemCoverage.baseItemCount} 个物品，**按 name 覆盖 ${itemCoverage.itemHit}**`,
      `其中生成侧有 ${itemCoverage.itemMatchingGenerated} 个能对上基准名字 —— 比覆盖数多出的就是 PDF 里重复写了的（如 驾驶证）`,
      `**精确率 ${itemCoverage.itemHit}/${ctx.items.length}** —— 分子用覆盖数不用匹配数，重复写的那份不该算进真阳`,
      `误报（生成了但基准里不是 ModuleItem）${itemCoverage.extraItemNames.length} 个: ${itemCoverage.extraItemNames.join("、") || "无"}`,
      `基准里没被生成出来的: ${itemCoverage.missingBaseItemNames.join("、") || "无"}`,
    );
  } else {
    lines.push(`物品覆盖率: ${NO_BASELINE_LINE}`);
  }
  lines.push("", "item warnings:", ...ctx.itemWarnings.map((w) => `  ${w}`), "");

  if (ctx.comparison) {
    const { itemIdInherit } = ctx.comparison;
    lines.push(
      `物品 id 继承基准：${itemIdInherit.idMap.size}/${ctx.items.length} 继承成功，${itemIdInherit.warnings.length} 个保留内部 id（不是错误，是如实报出的已知缺口）`,
      ...itemIdInherit.warnings.map((w) => `  ${w}`),
    );
  } else {
    lines.push(`物品 id 继承: ${NO_BASELINE_LINE}全部保留内部句柄（item_NN），未继承任何 id。`);
  }
  lines.push("");

  // ── 线索 ──
  lines.push(
    "── 线索 ──",
    `产出 ${ctx.clueCount} 条线索，provenance ${ctx.clueProvenanceCount} 条`,
  );
  if (ctx.comparison) {
    const { clueCoverage } = ctx.comparison;
    lines.push(
      `基准 ${clueCoverage.scoringClueCount} 条线索有评分键坐标，**按评分键坐标覆盖 ${clueCoverage.clueHit}**`,
      `**精确率 ${clueCoverage.cluePrecisionHits}/${ctx.clueCount}**——分子是"这条线索的 sourceKey 在评分键里确实标记为 clue"的条数`,
      `漏掉的基准线索 ${clueCoverage.missedClueIds.length} 个: ${clueCoverage.missedClueIds.join("、") || "无"}`,
    );
  } else {
    lines.push(`线索覆盖率/精确率: ${NO_BASELINE_LINE}`);
  }
  lines.push("", "clue warnings:", ...ctx.clueWarnings.map((w) => `  ${w}`), "");

  if (ctx.comparison) {
    const { clueIdInherit } = ctx.comparison;
    lines.push(
      `线索 id 继承基准：${clueIdInherit.idMap.size}/${ctx.clueCount} 继承成功，${clueIdInherit.warnings.length} 个保留内部 id（不是错误，是如实报出的已知缺口）`,
      ...clueIdInherit.warnings.map((w) => `  ${w}`),
    );
  } else {
    lines.push(`线索 id 继承: ${NO_BASELINE_LINE}全部保留内部句柄（item_NN），未继承任何 id。`);
  }
  lines.push("");

  // ── 结构性统计（两种模式都有，无基准模式下这是唯一的"数字来源"） ──
  lines.push(
    "── 结构性统计（不依赖基准，两种模式都算）──",
    `场景 ${ctx.scenes.length} 个 / 物品 ${ctx.items.length} 个 / 线索 ${ctx.clueCount} 条 / NPC ${ctx.npcCount} 个`,
    "",
  );

  // ── 悬空引用（内部一致性，两种模式都跑）──
  lines.push(
    `悬空引用（item.sceneId 在生成的 scenes 里找不到）${ctx.danglingRefs.length} 个: ${ctx.danglingRefs.join("、") || "无"}`,
    `  —— 这一项没有任何 diff 能反映：refFields 把 sceneId 的差异归成 ref-mismatch，`,
    `     而那被当成预期噪音，挂错场景与挂对场景的输出长得一样。所以单独查。`,
    "",
  );

  // ── 创作层 ──
  lines.push(
    "── 创作层（todo-52：第一版，只产 openingAtmosphere/prologue/partySetup）──",
    `原文语料: ${ctx.corpus.ok ? "已从本次摄取的 PDF 页文本读取，第一档（禁止新造专名/术语）正常生效" : `**不可用**（${ctx.corpus.reason ?? ""}），创作层拒绝生成`}`,
  );
  if (ctx.corpus.sourceComparison) {
    const cmp = ctx.corpus.sourceComparison;
    lines.push(
      cmp.available
        ? `  语料来源比较: 与仓库切片语料${cmp.identical ? "归一化后逐字一致" : `**不一致**（页语料 ${cmp.pageCorpusLength} 字 / 切片语料 ${cmp.sliceCorpusLength} 字，如实记录，未强行判定为一致）`}`
        : "  语料来源比较: 无切片语料可比（tools/ 不进版本库，或本模组本来就没有切片）——跳过，不影响主流程",
    );
  }
  lines.push(
    `本轮生成: ${ctx.narrative.accepted ? "**通过全部约束，已采纳**" : "**未采纳**（约束不过 / 调用失败 / 解析失败 / 无语料拒绝生成，详见下方 warnings）"}`,
  );
  if (ctx.narrative.accepted) {
    lines.push(
      `openingAtmosphere ${ctx.narrative.openingAtmosphereCount} 个场景`,
      `prologue.lines ${ctx.narrative.prologueLineCount} 行`,
      `partySetup: ${ctx.narrative.hasPartySetup ? "已生成" : "未生成"}`,
      `provenance ${ctx.narrative.provenanceCount} 条，全部 by:"llm"（本模组逐字核对过原文没有对应内容，纯创作）`,
      `创作层登记表判据: 缺 sourceRef 的集合与显式登记的集合${ctx.narrative.registryMatches ? "精确相等，对上了" : "**对不上**"}`,
      "**不产** epilogues / narrative.entities（原因见 build-narrative.ts 文件头：两者都要求引用具体的线索/场景 id，本轮 LLM 拿不到这些 id，硬编风险太高，留给下一轮）",
    );
  }
  lines.push("", "narrative warnings:", ...ctx.narrative.warnings.map((w) => `  ${w}`), "");

  // ── calibrate diff ──
  if (ctx.comparison) {
    lines.push(formatDiff(ctx.comparison.diffs));
  } else {
    lines.push(`校准 diff: ${NO_BASELINE_LINE}`);
  }

  return lines.join("\n");
}
