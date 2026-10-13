// 摄取管线实跑：PDF → 清洗 → 切分 → 分类 → 场景骨架 → 对基准 diff（有基准时）。
//
// 所有 IO 集中在这里。src/ingest/ 那几个模块保持无 IO 才能被纯逻辑单测，
// 逻辑不要往这里搬。
//
// ⚠ 这个文件原先是 `tools/_run-ingest.ts`，而 `tools/` 在 .gitignore 里。
//   后果：`src/ingest/*` 六个模块 800 多行、16 个测试文件，**唯一的入口不在仓库中** ——
//   新克隆下来根本跑不起来，扫依赖图看到的是「整个子系统没人调用」。
//   （上一轮把 `tools/_diag-*.ts` 搬进 `scripts/diag/` 时漏了这一个。）
//
//   顺带：PDF 路径原先硬编码成某台机器上的绝对路径，也是「只有我这儿能跑」。
//   现在从命令行/环境变量取。
//
// 开发·无基准模式：这个脚本原来假设 BARN_OF_PREMIER 永远存在——覆盖率/
// 精确率/评分键/id 继承/calibrate diff 全部直接读这个模块级常量。跑一本
// 没有基准的新 PDF 时那样会崩，或者更糟——把不相干的基准硬套上去，报出
// 一堆没有意义的"漏报"。现在分两种模式：
//   有基准（`INGEST_BASELINE=barn`）—— 行为与改动前逐位不变，这是回归红线。
//   无基准（默认）—— 依赖基准的每一节都在报告里显式写"无基准，跳过"，
//     不是静默不打印、也不是尝试硬凑；只产出 module.json + warnings +
//     不依赖基准的结构性统计（几个场景/物品/线索/NPC、悬空引用数）。
// 覆盖率等计算搬进了 `src/ingest/baseline-comparison.ts`（纯函数，认得
// 的是 `BaselineData` 这个形状，不认得 BARN_OF_PREMIER 这个具体模块），
// 报告组装搬进了 `src/ingest/ingest-report.ts`——本文件只剩"读什么、
// 有没有基准、写什么文件"这几件事。
//
// 用法：
//   bun scripts/ingest/run.ts <模组 PDF 路径>
//   INGEST_PDF=... bun scripts/ingest/run.ts
//   INGEST_BASELINE=barn ... 同上，额外对照 BARN_OF_PREMIER 基准（仅这一个模组）
//   --module-id <id> (or INGEST_MODULE_ID) is required without that baseline.
//   --title <title> / --out <directory> override INGEST_MODULE_TITLE / INGEST_OUT.

import { mkdirSync, readFileSync } from "fs";
import { parseIngestRunConfig } from "./cli-config";
import { loadConfig } from "../../src/config";
import { LLMClient } from "../../src/llm/client";
import type { ChatOptions, Message } from "../../src/llm/client";
import { extractPages } from "../../src/ingest/pdf-source";

import { sourceKey } from "../../src/ingest/sectionize";
import { prepareSections, classifyAndBuild, requiredIngestFailure } from "../../src/ingest/pipeline";
import { assembleModule } from "../../src/ingest/assemble-module";
import { buildNarrative, applyNarrative, findMissingCreativeSourceRef, findRegisteredCreativeLayer } from "../../src/ingest/build-narrative";
import { readOriginalCorpus, buildCorpusFromPages, compareCorpusSources } from "../../src/ingest/three-way-audit";
import { computeBaselineComparison, type BaselineData } from "../../src/ingest/baseline-comparison";
import { buildIngestReport, type IngestReportContext } from "../../src/ingest/ingest-report";
import { BARN_OF_PREMIER } from "../../src/module/barn-of-premier";
// 评分键在这里**只用来对左手边**（键名 vs 实际抽出的 sourceKey），下面那段检查是它唯一的用处。
// 它绝不能进任何 prompt：本文件同时也是拼 prompt 的地方（classify-sections / classify-items），
// 白名单管得住谁能 import，管不住 import 进来往哪儿传。约定是：
// **只在分类返回之后读，绝不进 toClassifyInputs / toItemInputs 的任何参数。**
// 见 src/__tests__/ingest-scoring-key-boundary.test.ts 的 RUNNER_KEY_ALLOWLIST。
import { ENTRY_SCORING_KEY } from "../../src/ingest/scoring-key";

// 硬编码绝对路径 = 只有作者那台机器能跑。缺参数就说清楚要什么，别拿一条
// ENOENT 让人猜。
const parsedConfig = parseIngestRunConfig(process.argv.slice(2), process.env);
if (!parsedConfig.ok) {
  console.error(parsedConfig.message);
  process.exit(2);
}
const PDF = parsedConfig.config.pdfPath;
// 产物落 analysis/（已 gitignore），与其余诊断产物同一个去处；tools/ 不再参与。
const OUT = parsedConfig.config.outputDir;

// 本仓目前只有这一份手写基准（普瑞米尔的谷仓），显式选择才对照它——
// 不是"默认假设当前 PDF 就是它"。跑别的 PDF 时不传这个变量，
// 走无基准路径，report 里每一节都会说清楚"没有基准可对照"。
const baselineData: BaselineData | undefined =
  parsedConfig.config.baseline === "barn"
    ? { module: BARN_OF_PREMIER, scoringKey: ENTRY_SCORING_KEY }
    : undefined;

/**
 * 录下每一次 prompt 与原始回复。
 *
 * classify* 只交出解析后的 Map，解析不出来时它是空的 —— 空表既可能是
 * 模型没答，也可能是键归一化又出问题（上一轮 `【农场外围】` 就把 43 条全卡掉了）。
 * 两者从空表上分不出来，而重发一次去看又要多烧一次调用还未必复现同一个回复。
 * 所以在同一次调用上把原文截下来，事后照着看，不猜。
 *
 * 用继承而不是塞一个同形状的对象：LLMClient 有私有字段，结构类型对不上。
 *
 * 存成列表而不是单组字段：本轮有两次调用（块分类、条目分类），
 * 单组字段会让后一次把前一次的原始回复覆盖掉 —— 而那正是唯一的证据。
 */
interface Recorded {
  label: string;
  prompt: string;
  raw: string;
  ms: number;
}

class RecordingClient extends LLMClient {
  calls: Recorded[] = [];
  /** 下一次调用记在哪个名下，调用前设 */
  label = "(未命名)";

  override async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    const rec: Recorded = {
      label: this.label,
      prompt: messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n"),
      raw: "",
      ms: 0,
    };
    this.calls.push(rec);
    const t0 = Date.now();
    try {
      const reply = await super.chat(messages, options);
      rec.raw = reply;
      return reply;
    } catch (e) {
      rec.raw = `<<调用抛错>> ${e instanceof Error ? e.message : String(e)}`;
      throw e;
    } finally {
      rec.ms = Date.now() - t0;
    }
  }
}

// 只在这里碰 IO：读 PDF、写产物。清洗、切分、分类、建场景建物品的顺序
// 全在 `src/ingest/pipeline.ts` 里 —— 那些是编排，属于版本库，
// 不属于这个 gitignore 掉的脚本。本文件只剩 IO 与度量。
//
// 分两步调而不是一把 runIngest：确定性的那半（切分）先跑完，
// 好让下面那段评分键检查赶在掏钱之前。
const raw = await extractPages(new Uint8Array(readFileSync(PDF)));
const sections = prepareSections(raw);

/**
 * 评分键的**左手边**对不对得上——只有基准时才有评分键可查。
 *
 * 单测只验了键名的形态（`/^p\d+:L\d+$/`），没验存在性 —— `"p99:L99"` 照样过。
 * 而键自己的文件头就写着：那个行号是**清洗后**的，「清洗逻辑一变行号就漂」。
 * 漂一行，那条就永远配不上任何条目，指标悄悄变差一点，看的人会以为是模型退步了。
 *
 * 为什么不进单测：它需要 PDF，而 PDF 在仓库之外。同 `pdf-source` 的内容保真一样，
 * 「要外部文件才能验的」归实跑器报，不进单测。
 *
 * 放在 LLM 调用**之前**：这段检查是确定性的、不花钱，没有理由让它等在一次可能失败的网络调用后面。
 */
const extractedKeys = sections.flatMap((s) => s.items.map((it) => sourceKey(it.source)));

const client = new RecordingClient(loadConfig());
// 阶段标签由编排层报过来，录制这边照着分组。
// 编排层不该知道有人在录 prompt，所以是回调不是依赖。
const {
  classifyInputs: inputs,
  kinds,
  scenes: rawScenes,
  sceneWarnings,
  itemInputs,
  itemKindsFirstPass,
  itemKinds,
  itemIds,
  items: rawItems,
  provenance,
  itemWarnings,
  clueCount,
  clueProvenance,
  clueWarnings,
  endings,
} = await classifyAndBuild(sections, client, {
  onStage: (label) => {
    client.label = label;
  },
});

const requiredFailure = requiredIngestFailure({
  classifyInputs: inputs,
  kinds,
  scenes: rawScenes,
  itemInputs,
  itemKindsFirstPass,
});
if (requiredFailure) {
  console.error(
    `[ingest] required ${requiredFailure.stage} cannot publish a module: ${requiredFailure.kind}`,
  );
  process.exit(1);
}

// The publish gate above must run before this creates an output directory or
// any artifact file. Failed required stages retain only in-memory diagnostics.
mkdirSync(OUT, { recursive: true });

/**
 * 有基准：对基准算覆盖率/精确率/id 继承/calibrate diff，`scenes`/`items`
 * 是尝试继承过基准 id 的最终版本。
 * 无基准：不猜、不硬套——`scenes`/`items` 就是内部句柄的原样版本
 * （scene_NN/item_NN），一个 id 都不改写。这正是开发·无基准模式 任务④
 * 要求的行为：不得静默生成看起来像意译的 id，那等于凭空造第四套命名
 * 体系（现有三套见 todo-19/34）。回归判据见
 * `ingest-no-baseline-ids.test.ts`——就算场景名字听起来很像基准会用的
 * 手写意译（"艾德里安的卧室"），无基准时产出的 id 也必须严格是
 * `scene_NN`/`item_NN` 形状，不能被巧合地"猜"成 `adrian_bedroom` 这类。
 */
const comparison = baselineData
  ? computeBaselineComparison(baselineData, {
      rawScenes,
      rawItems,
      extractedKeys,
      clueProvenance,
      clueCount,
      itemInputs,
      itemKinds,
    })
  : undefined;
const scenes = comparison?.scenes ?? rawScenes;
const items = comparison?.items ?? rawItems;

const danglingRefsSceneIdSet = new Set(scenes.map((s) => s.id));
const danglingRefs = items
  .filter((i) => !danglingRefsSceneIdSet.has(i.sceneId))
  .map((i) => `${i.id}(${i.name}) → ${i.sceneId}`);

const dist = new Map<string, number>();
for (const v of kinds.values()) dist.set(v, (dist.get(v) ?? 0) + 1);
const unanswered = inputs.filter((s) => !kinds.has(s.title)).map((s) => s.title);

const itemDist = new Map<string, number>();
for (const v of itemKinds.values()) itemDist.set(v, (itemDist.get(v) ?? 0) + 1);
const itemUnanswered = itemInputs.filter((i) => !itemKinds.has(i.key)).map((i) => `${i.key}${i.name ? `(${i.name})` : ""}`);

await Bun.write(`${OUT}/scenes.json`, JSON.stringify(scenes, null, 2));
await Bun.write(
  `${OUT}/id-name.txt`,
  ["id ↔ name 对照表", "", ...scenes.map((s) => `${s.id}\t${s.name}`)].join("\n"),
);
await Bun.write(`${OUT}/items.json`, JSON.stringify(items, null, 2));
await Bun.write(`${OUT}/provenance.json`, JSON.stringify(provenance, null, 2));

// 装配成一个完整 ModuleData 并落盘。
const assembled = assembleModule(
  { sections, kinds, scenes, items, provenance, endings },
  { id: parsedConfig.config.moduleId, title: parsedConfig.config.moduleTitle },
);

// ── 创作层（todo-52，第一版：openingAtmosphere/prologue/partySetup）──
//
// 必须在 assembleModule() **之后**、在算完基准 diff（`comparison`）
// **之后**调用——顺序不是随便选的：diff 用的 `scenes` 变量在这之前
// 就已经定型，从头到尾没见过 openingAtmosphere 这个字段，创作层的内容
// 因此天然不会漏进 diff 里，不需要事后再从 diff 结果里摘掉。
client.label = "创作层";
// 开发·无基准模式 任务②：语料现在来自这次摄取自己解码出的逐页原文
// （`raw`，`extractPages` 的产物），不是仓库里预先切好的谷仓专属切片
// ——对任意 PDF 都能用，不只是这一本模组。`pdf-source.ts` 的内容保真
// 已经实跑验证过（与切片逐字一致 17/17），这里仍然把切片语料也读出来
// 做一次真实比较（`compareCorpusSources`），而不是假设两条路一定等价
// 就跳过验证——切片语料读不到（`tools/` 不进版本库）时优雅跳过这一步，
// 不影响主流程使用页语料。
const pdfCorpusText = buildCorpusFromPages(raw);
const pdfCorpusOk = pdfCorpusText.trim().length > 0;
const sliceCorpus = readOriginalCorpus();
const corpusComparison = sliceCorpus.ok ? compareCorpusSources(pdfCorpusText, sliceCorpus.text) : null;
const narrative = await buildNarrative(
  {
    title: assembled.module.title,
    era: assembled.module.era,
    scenes: assembled.module.scenes.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      clues: s.clues.map((c) => ({ id: c.id, name: c.name, description: c.description, findMethods: c.findMethods, matchTexts: c.matchTexts })),
    })),
  },
  client,
  pdfCorpusOk ? pdfCorpusText : undefined,
);
const finalModule = applyNarrative(assembled.module, narrative);
await Bun.write(`${OUT}/module.json`, JSON.stringify(finalModule, null, 2));
await Bun.write(
  `${OUT}/module-gaps.txt`,
  [
    "装配成 ModuleData 时的缺口 —— 每一条都是「原文里没抽到，留空了」，",
    "不是 bug，是摄取还没做到那儿。填假值比留空更糟，所以一律留空。",
    "",
    ...assembled.warnings.map((w) => `· ${w}`),
  ].join("\n"),
);

await Bun.write(
  `${OUT}/item-kinds.txt`,
  [
    "条目分类逐条结果（键 → 类别 / 场景 / 名字）",
    "",
    ...itemInputs.map(
      (i) => `${i.key}\t${itemKinds.get(i.key) ?? "(未返回)"}\t${i.sceneTitle}\t${i.name || "(无名)"}`,
    ),
  ].join("\n"),
);

// 原始回复单独落一份：报告里要贴的就是它，也是「模型到底答没答」的唯一证据
await Bun.write(
  `${OUT}/classify-raw.txt`,
  client.calls
    .flatMap((c) => [
      `=== ${c.label} ===`,
      `耗时 ${c.ms}ms / 回复长度 ${c.raw.length} 字符`,
      "",
      "--- 原始回复 ---",
      c.raw,
      "",
      "--- prompt ---",
      c.prompt,
      "",
    ])
    .join("\n"),
);

const reportCtx: IngestReportContext = {
  pageCount: raw.length,
  sectionCount: sections.length,
  classifyInputCount: inputs.length,
  kindsSize: kinds.size,
  dist,
  unanswered,
  scenes,
  sceneWarnings,
  itemInputCount: itemInputs.length,
  itemKindsSize: itemKinds.size,
  itemIdsSize: itemIds.size,
  itemDist,
  itemUnanswered,
  items,
  provenanceCount: provenance.length,
  itemWarnings,
  clueCount,
  clueProvenanceCount: clueProvenance.length,
  clueWarnings,
  npcCount: assembled.module.npcs.length,
  danglingRefs,
  narrative: {
    accepted: narrative.accepted,
    openingAtmosphereCount: narrative.openingAtmosphereByScene.size,
    prologueLineCount: narrative.prologueLines.length,
    hasPartySetup: narrative.partySetup !== undefined,
    provenanceCount: narrative.provenance.length,
    registryMatches:
      new Set(findMissingCreativeSourceRef(narrative.provenance)).size ===
        new Set(findRegisteredCreativeLayer(narrative.provenance)).size &&
      findMissingCreativeSourceRef(narrative.provenance).every((p) => findRegisteredCreativeLayer(narrative.provenance).includes(p)),
    warnings: narrative.warnings,
  },
  corpus: {
    ok: pdfCorpusOk,
    reason: pdfCorpusOk ? undefined : "本次摄取解出的页文本为空",
    sourceComparison: corpusComparison
      ? {
          available: true,
          identical: corpusComparison.identical,
          pageCorpusLength: corpusComparison.pageCorpusLength,
          sliceCorpusLength: corpusComparison.sliceCorpusLength,
        }
      : { available: false },
  },
  comparison,
};

await Bun.write(`${OUT}/report.txt`, buildIngestReport(reportCtx));

console.log(baselineData ? "有基准模式（BARN_OF_PREMIER）" : "无基准模式——本次摄取没有可对照的基准模组数据");
console.log(
  `场景 ${scenes.length} 个 / 物品 ${items.length} 个 / 线索 ${clueCount} 条 / NPC ${assembled.module.npcs.length} 个 / ` +
    `悬空引用 ${danglingRefs.length} 个，产物在 ${OUT}/`,
);
