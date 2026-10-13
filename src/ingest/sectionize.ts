// 摄取管线 · 第三段：章节切分
//
// 把清洗后的逐页文本切成可寻址的块。锚点是清洗阶段特意保住的那两个：
//   短的冒号结尾行 → 标题（场景名、小节名）
//   有完整上下文依据的短独立行 → 标题（部分 PDF 的无冒号小节名）
//   ▶ 开头的行     → 条目（全书 45 条，四个陷阱全在内）
//
// 层级不能拍平。▶捕兽夹 属于「农场外围」这个场景，扁平之后陷阱就不知道
// 该挂到哪儿 —— 引擎里那对单数的 support.trapSceneId / trapClueId
// 正是这么来的：一个场景只认得一个陷阱，另外三个成了死数据。

import { parseExplicitSectionTitleLine, sectionTitleLines } from "./section-heading";

const DISCOVERY_LIST_ACTION = /(搜索|搜查|查找|寻找|调查|发现|找到|检视|检查)/;
const DISCOVERY_LIST_REFERENCE = /(?:(?:如下|下列|以下|这些|此处(?:的)?|这里(?:的)?)[^。！？；]{0,12}(?:物品|物件|东西|线索)|(?:物品|物件|东西|线索)[^。！？；]{0,12}(?:如下|下列|以下|包括|有))/;
const DISCOVERY_ITEM_LABEL_MAX_LEN = 24;

/** 一个条目：模组用 ▶ 标记的陷阱、可搜查物、规则说明 */
export interface SectionItem {
  /** ▶ 与第一个冒号之间的部分。没有冒号时为空串 */
  name: string;
  /** 冒号之后的正文；没有冒号时是整行 */
  text: string;
  source: SourceRef;
}

/** 一个块：一个标题及其名下的正文与条目 */
export interface Section {
  /** 标题（已去掉尾部冒号）。首个标题之前的内容归入 title 为空串的前置块 */
  title: string;
  body: string;
  items: SectionItem[];
  source: SourceRef;
}

/** 原文位置，供 Provenance.sourceRef 使用 */
export interface SourceRef {
  /** 页码，从 1 起。这个是真页码，与 PDF 一致 */
  page: number;
  /**
   * **清洗后**的页内行号，从 1 起 —— 不是 PDF 里的行号。
   *
   * cleanPageText 把栏宽硬换行接回去，各页压缩 1.8×–6.0×，所以两者差得很远：
   * `捕兽夹` 在 sourceKey 里是 p9:L13，PDF 实际在 p9:L40（差 27 行）；
   * `防盗门的钥匙` 是 p6:L17，PDF 实际 p6:L67（差 50 行）。
   * 实测见 `tools/_diag-lineno.ts`。
   *
   * 拿它当唯一键是够的（同一清洗行不会有两个条目）；
   * 拿它去 PDF 里数行找原文**会落空**。要真能追回 PDF 行号，
   * 得让 cleanPageText 把原始行号一路带出来，而它现在是丢掉的。
   */
  line: number;
}

/**
 * 位置的字符串形式，如 `p9:L13`。
 *
 * 条目分类以它为键。不能像块分类那样以名字为键 —— 标题会重复
 * （`驾驶证` 在证物室和交火现场各出现一次），而清洗后的行号天然唯一，
 * 同一行不会有两个条目。
 *
 * 它同时充当 Provenance.sourceRef。**坐标系是「真页码 + 清洗后行号」**，
 * 不是 PDF 的行号 —— 见 SourceRef.line 上那段实测。
 * 也不是 raw 切片文件加行号那一套（那是第三种坐标系）。
 * 三者别混着长，尤其别以为这个能拿去 PDF 里数行。
 */
export function sourceKey(ref: SourceRef): string {
  return `p${ref.page}:L${ref.line}`;
}

/**
 * 显式标题行：短，且以冒号收尾。
 *
 * 无冒号标题需要整页上下文，交由 section-heading.ts 的共享规则识别；
 * 本兼容入口只回答单行能确认的显式标题。
 */
const ITEM_LINE = /^[▶►▷]\s*(.*)$/;

/** 把 ▶ 行拆成名字与正文。以第一个冒号为界，正文里的冒号不参与 */
export function parseSectionItemLine(line: string): { name: string; text: string } | undefined {
  const itemMatch = line.match(ITEM_LINE);
  if (!itemMatch) return undefined;
  const rest = itemMatch[1] as string;
  const idx = rest.search(/[：:]/);
  if (idx < 0) return { name: "", text: rest.trim() };
  return { name: rest.slice(0, idx).trim(), text: rest.slice(idx + 1).trim() };
}

export function parseSectionTitleLine(line: string): string | undefined {
  return parseExplicitSectionTitleLine(line);
}

/** Shared by legacy Section.items and source-addressable document blocks. */
export function isDiscoveryListGuide(line: string): boolean {
  return DISCOVERY_LIST_ACTION.test(line) && DISCOVERY_LIST_REFERENCE.test(line);
}

function isDiscoveryItemLabel(name: string): boolean {
  return name.length <= DISCOVERY_ITEM_LABEL_MAX_LEN
    && !/[。！？；;，,、：:]/.test(name)
    && /^[\p{L}\p{N}\s·.'’“”"'（）()\-—]+$/u.test(name);
}

/** Parse a bare discovery-list entry only after isDiscoveryListGuide has matched. */
export function parseDiscoveryListItemLine(line: string): { name: string; text: string } | undefined {
  const index = line.search(/[：:]/);
  if (index <= 0) return undefined;
  const name = line.slice(0, index).trim();
  const text = line.slice(index + 1).trim();
  if (!name || !text || !isDiscoveryItemLabel(name)) return undefined;
  return { name, text };
}

/**
 * 切分。输入是**清洗后**的逐页文本（见 clean-text.ts）。
 *
 * 跨页是接续的：一个场景的描述经常从一页流到下一页，
 * 按页硬切会把同一个场景拆成两块，后面按标题归并时又要再拼回去。
 */
export function sectionize(pages: string[]): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  const bodyLines: string[] = [];
  let discoveryListPending = false;

  const flush = () => {
    if (!cur) return;
    cur.body = bodyLines.join("\n").trim();
    out.push(cur);
    bodyLines.length = 0;
  };

  for (let p = 0; p < pages.length; p++) {
    const lines = (pages[p] ?? "").split("\n");
    const titles = sectionTitleLines(lines);
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").trim();
      if (line === "") {
        discoveryListPending = false;
        continue;
      }
      const source: SourceRef = { page: p + 1, line: i + 1 };

      const title = titles[i];
      if (title !== undefined) {
        flush();
        cur = { title, body: "", items: [], source };
        discoveryListPending = false;
        continue;
      }

      const item = parseSectionItemLine(line);
      if (item) {
        // 条目出现在任何标题之前也要有处安放
        if (!cur) cur = { title: "", body: "", items: [], source };
        cur.items.push({ ...item, source });
        discoveryListPending = false;
        continue;
      }

      if (discoveryListPending) {
        const discoveryItem = parseDiscoveryListItemLine(line);
        if (discoveryItem) {
          if (!cur) cur = { title: "", body: "", items: [], source };
          cur.items.push({ ...discoveryItem, source });
          continue;
        }
      }

      // 普通正文。首个标题之前的内容归入 title 为空的前置块，不能丢 ——
      // 第 1 页开头的书名就在这儿。
      if (!cur) cur = { title: "", body: "", items: [], source };
      bodyLines.push(line);
      discoveryListPending = isDiscoveryListGuide(line);
    }
  }

  flush();
  return out;
}
