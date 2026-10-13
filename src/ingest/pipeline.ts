// 摄取管线 · 编排
//
// 为什么要有这个文件：在它之前，编排全在 `tools/_run-ingest.ts` 里，
// 而 `tools/` 在 .gitignore 之外 —— **整条管线没有一个进版本库的入口**。
// 所有实跑数字都出自那个脚本，可它本身不进版本库：换台机器、或者 tools/ 丢了，
// 这条管线就跑不起来，而没人能从仓库里看出它本来长什么样。
//
// 分工没变，只是把线划清楚：
//   · 本文件 = **编排**。谁先谁后、中间量怎么传、失败怎么降级。无 IO。
//   · `tools/_run-ingest.ts` = **IO 与度量**。读 PDF、写产物、对基准、拼 report。
//
// 无 IO 这条是硬的，不是风格：`_run-ingest.ts` 开头那句「src/ingest 那几个模块
// 保持无 IO 才能被纯逻辑单测」对本文件同样成立。所以入口收的是**已经读进内存的字节**，
// 不是路径 —— 一旦这里出现 readFileSync，整条管线就只能靠实跑来验，
// 而实跑要花钱、要 PDF、还不确定。
//
// **那份评分用的标注绝不出现在本文件里。** 它是度量用的答案，属于 tools 那一侧；
// 让它进编排层，等于让答案有机会流进 prompt。
// `src/__tests__/` 下有一份用途边界测试守着这条，它的做法是**全文扫字符串**，
// 所以这里连提都不能直接提那个模块名 —— 提了就会被自己判红。
// （本注释原先写了那个名字，红过一次。测试是道安全网，
// 为了让自家注释过关去钝化它，方向就反了。）
import type { LLMClient } from "../llm/client";
import { buildDocumentIR } from "./pdf-source";
import { cleanPages, cleanPagesWithTrace, joinPages, joinPagesWithTrace } from "./clean-text";
import { buildDocumentBlocks } from "./document-blocks";
import { createSyntheticDocumentIR, type DocumentBlock, type DocumentIR } from "./document-ir";
import { buildSourceFactGraph, type SourceFactGraph } from "../compiler/source-fact-graph";
import { sectionize, type Section } from "./sectionize";
import { toClassifyInputs, classifySections, type SectionKind } from "./classify-sections";
import { toItemInputs, classifyItems, type ItemInput, type ItemKind } from "./classify-items";
import { refineItemKinds } from "./classify-followup";
import { assignSceneIds, assignItemIds } from "./ids";
import { buildScenes } from "./build-scenes";
import { inferConnections } from "./infer-connections";
import { extractEndings } from "./extract-endings";
import { buildItems } from "./build-items";
import { buildClues } from "./build-clues";
import type { Scene } from "../module/types";
import type { Ending, ModuleItem, Provenance } from "../module/types";

/**
 * 一次摄取的全部产物与中间量。
 *
 * 中间量（sections / kinds / itemKindsFirstPass 之类）是**有意**交出去的，
 * 不是没封装好：度量那一侧要拿它们对基准、算混淆矩阵、算追问前后的差。
 * 只交 scenes 和 items 的话，`_run-ingest.ts` 就只能把编排再抄一遍来拿中间量 ——
 * 那正是这次要消掉的东西。
 */
export interface IngestResult {
  /** Source-exact input representation; synthetic for runIngestFromPages. */
  documentIR: DocumentIR;
  /** Addressable prose/heading/item inputs, before classification. */
  documentBlocks: DocumentBlock[];
  /** Deterministic source structure only; never supplied to existing prompts. */
  sourceFactGraph: SourceFactGraph;
  sections: Section[];
  /** 送去块分类的输入。度量那侧拿它算「送了却没回结果的标题」 */
  classifyInputs: ReturnType<typeof toClassifyInputs>;
  /** 块分类结果，以标题为键 */
  kinds: Map<string, SectionKind>;
  /** 与 sections 同下标的场景 id；非 scene 块那一格不会被任何 Scene 用到 */
  ids: string[];
  /**
   * 已经挂好线索的最终场景表——`buildScenes` 产出时 `.clues` 是空数组
   * （那一步"本轮只填 id/name/description"），`buildClues` 在这份编排的
   * 末尾把线索塞回各自场景，这里交出去的是塞完之后的版本，不是半成品。
   */
  scenes: Scene[];
  sceneWarnings: string[];
  itemInputs: ItemInput[];
  /** 追问**之前**的条目分类。留着是为了能算「修好几条 / 弄坏几条」 */
  itemKindsFirstPass: Map<string, ItemKind>;
  /** 追问之后的条目分类，buildItems 与 buildClues 用的都是这一份 */
  itemKinds: Map<string, ItemKind>;
  /** 条目键 → 物品/线索共用的 id 空间。是 Map 不是数组：条目的键是 pN:LN，不跟 sections 同下标 */
  itemIds: Map<string, string>;
  items: ModuleItem[];
  provenance: Provenance[];
  itemWarnings: string[];
  /** 产出的线索总数（跨全部场景）——todo-28 之前这个数恒为 0 */
  clueCount: number;
  /** 线索的改写留痕，path 已 rebase 到 `scenes[id].clues[id]` */
  clueProvenance: Provenance[];
  clueWarnings: string[];
  /**
   * 从 structure 块里抽出来的结局。
   * 抽不到就是空数组 —— 那意味着模组跑起来不会自行结束。
   */
  endings: Ending[];
}

/**
 * Ingest may retain intermediate diagnostics after a model call fails, but the
 * CLI must not publish a module when a required classification stage has no
 * usable result. Partial classifications remain usable; an empty required
 * stage, or no resulting scene at all, does not.
 */
export type RequiredIngestFailure =
  | { stage: "section-classification"; kind: "no-classifications" | "no-scenes" }
  | { stage: "item-classification"; kind: "no-classifications" };

/** Pure publish gate for the CLI; it never infers failure from logs or clients. */
export function requiredIngestFailure(
  result: Pick<IngestResult, "classifyInputs" | "kinds" | "scenes" | "itemInputs" | "itemKindsFirstPass">,
): RequiredIngestFailure | undefined {
  if (result.classifyInputs.length > 0) {
    if (result.kinds.size === 0) return { stage: "section-classification", kind: "no-classifications" };
  }
  if (result.scenes.length === 0) return { stage: "section-classification", kind: "no-scenes" };
  if (result.itemInputs.length > 0 && result.itemKindsFirstPass.size === 0) {
    return { stage: "item-classification", kind: "no-classifications" };
  }
  return undefined;
}

/**
 * 调用方可以在每次 LLM 调用前收到一个标签，用来给录制分组。
 *
 * 不在这里直接依赖 RecordingClient：那是度量侧的东西，
 * 编排层不该知道有人在录 prompt。给个回调就够了。
 */
interface IngestHooks {
  onStage?: (label: string) => void;
}

/**
 * 跑一次完整摄取：PDF 字节 → 清洗 → 切分 → 分类 → 场景 → 条目 → 追问 → 物品。
 *
 * 分成 `prepareSections`（确定性、不花钱）与 `classifyAndBuild`（要花钱）两段，
 * 理由见各自的注释。这里只把两段接起来。
 */
export async function runIngest(
  pdfBytes: Uint8Array,
  client: LLMClient,
  hooks: IngestHooks = {},
): Promise<IngestResult> {
  return runIngestFromDocumentIR(await buildDocumentIR(pdfBytes), client, hooks);
}

/**
 * 从**已经解码出来的页文本**往下跑。
 *
 * 单独开这个入口，是因为 `extractPages` 是直接 import 进来的，测试里注不进替身，
 * 于是整条编排只能靠一份真 PDF 才能验 —— 而 PDF 在仓库之外。
 * 写测试写不动，通常说明缝没留对：解码是一件事，编排是另一件事，
 * 本来就该能分开验。上面那个 `runIngest` 只剩「解码然后交给这里」。
 */
export async function runIngestFromPages(
  rawPages: string[],
  client: LLMClient,
  hooks: IngestHooks = {},
): Promise<IngestResult> {
  // Page-text callers have no PDF bytes. Mark the descriptor rather than
  // inventing a documentHash that downstream code could mistake for a PDF hash.
  return runIngestFromDocumentIR(createSyntheticDocumentIR(rawPages, "runIngestFromPages"), client, hooks);
}

async function runIngestFromDocumentIR(
  documentIR: DocumentIR,
  client: LLMClient,
  hooks: IngestHooks,
): Promise<IngestResult> {
  const rawPages = documentIR.pages.map((page) => page.rawText);
  const sections = prepareSections(rawPages);
  const tracedPages = joinPagesWithTrace(cleanPagesWithTrace(documentIR.pages));
  const documentBlocks = buildDocumentBlocks(documentIR, tracedPages);
  const sourceFactGraph = buildSourceFactGraph(documentIR, documentBlocks);
  return classifyAndBuild(sections, client, hooks, documentIR, documentBlocks, sourceFactGraph);
}

/**
 * 页文本 → 块。**确定性的那一半**，不花钱、不联网。
 *
 * 单独导出是为了让调用方能在掏钱之前先看一眼切分结果。
 * `_run-ingest.ts` 就靠这个把「评分键左手边对不对得上」放在 LLM 调用之前 ——
 * 那段检查是确定性的，没道理等在一次可能失败的网络调用后面。
 * 合成一步的话，要么这检查挪到花完钱之后，要么调用方自己再切一遍 ——
 * 而自己再切一遍，就等于把编排又抄回去了。
 *
 * 顺序不能换：`cleanPages` 先看整份 raw pages，为跨页结构行标记连续性后再逐页清洗；
 * `joinPages` 才接普通的跨页断句。退回 `rawPages.map(cleanPageText)` 会让 2+1
 * 的结构行在页内先被焊死，之后已经无法恢复。反过来的话，正好断在页末的句子也
 * 永远接不回来 —— 实测 4 处，
 * 其中一处是 ▶防盗门的钥匙 的「不多见。」落到了下一页开头。
 */
export function prepareSections(rawPages: string[]): Section[] {
  return sectionize(joinPages(cleanPages(rawPages)));
}

/**
 * 块 → 分类 → 场景与物品。**要花钱的那一半**。
 *
 * 一处顺序不能换：`refineItemKinds` 必须在 `buildItems` **之前**。
 * 追问会把「床头柜」这类从 item 改判成 clue，改判之后它们才不会变成 ModuleItem。
 * 放到后面就只剩一份没人用的分类表 —— 不抛错、不变红，
 * 只是实跑物品精确率从 9/11 悄悄退回 9/19。有测试守着这一条。
 */
export async function classifyAndBuild(
  sections: Section[],
  client: LLMClient,
  hooks: IngestHooks = {},
  documentIR = createSyntheticDocumentIR([], "classifyAndBuild sections-only"),
  documentBlocks: DocumentBlock[] = [],
  sourceFactGraph = buildSourceFactGraph(documentIR, documentBlocks),
): Promise<IngestResult> {
  const stage = (label: string) => hooks.onStage?.(label);

  stage("块分类");
  const classifyInputs = toClassifyInputs(sections);
  const kinds = await classifySections(classifyInputs, client);
  const ids = assignSceneIds(sections);
  const built = buildScenes(sections, kinds, ids);
  let scenes = built.scenes;
  const sceneWarnings = built.warnings;

  // 连接必须在 buildScenes **之后** —— 它要的是最终进了场景表的那批，
  // 不是全部块。上一轮量过：场景表里多 3 个误报块，模型就会把边分给垃圾节点，
  // 正确边可达从 20 掉到 11。**上游的精确率直接决定这一步的成绩。**
  stage("推断连接");
  const conns = await inferConnections(scenes, client);
  const nameById = new Map(scenes.map((s) => [s.id, s.name]));
  for (const s of scenes) {
    const targets = conns.get(s.id);
    if (!targets) continue;
    // condition 是必填的，而模型这一步只答「走不走得通」，不答「要什么条件」，
    // 所以只能填一句复述。挑「前往<场景名>」这个写法是因为运行时的
    // `isRedundantMoveLine`（play-module.ts:101）正好把它识别成复述并抑制，
    // 界面上不会多出一行废话；换个别的写法反而会被当成真条件显示出来。
    // 门禁字段（requiredClueId / checkRequired）一概不填 ——
    // 那是另一件事，基准那 44 条边自己也一处没用。
    s.connections = targets.map((targetSceneId) => ({
      targetSceneId,
      condition: `前往${nameById.get(targetSceneId) ?? targetSceneId}`,
    }));
  }

  const itemInputs = toItemInputs(sections, kinds, ids);
  stage("条目分类");
  const itemKindsFirstPass = await classifyItems(itemInputs, client);
  stage("条目追问");
  const itemKinds = await refineItemKinds(itemInputs, itemKindsFirstPass, client);
  const itemIds = assignItemIds(sections);
  const { items, provenance, warnings: itemWarnings } = buildItems(itemInputs, itemKinds, itemIds);

  // 线索复用条目分类/追问/编号的同一份产出（itemInputs/itemKinds/itemIds）——
  // "这一条结构化条目是不是线索"与"是不是物品"是同一次分类回答的，不是两遍问题。
  // 必须在 buildItems 之后没有先后依赖，只是编排上顺着同一批中间量往下写。
  stage("建线索");
  const { scenes: scenesWithClues, clueCount, provenance: clueProvenance, warnings: clueWarnings } =
    buildClues(scenes, itemInputs, itemKinds, itemIds);
  scenes = scenesWithClues;

  // 结局藏在 structure 块里。整批送过去、让模型自己找，而不是按标题挑 ——
  // 「结局」这个词是这份模组的写法，别的模组未必这么写标题。
  // structure 块一共就 8 个，全送也不贵。
  stage("抽结局");
  const structureBlocks = sections
    .filter((s) => s.title !== "" && kinds.get(s.title) === "structure")
    .map((s) => ({ title: s.title, body: s.body }));
  const endings = await extractEndings(structureBlocks, client);

  return {
    documentIR,
    documentBlocks,
    sourceFactGraph,
    sections,
    classifyInputs,
    kinds,
    ids,
    scenes,
    sceneWarnings,
    itemInputs,
    itemKindsFirstPass,
    itemKinds,
    clueCount,
    clueProvenance,
    clueWarnings,
    itemIds,
    items,
    provenance,
    itemWarnings,
    endings,
  };
}
