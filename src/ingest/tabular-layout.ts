/**
 * Source-layout detector for compact, mechanically-valued table rows.
 * It deliberately knows no reward wording: a row is structural only as part
 * of a sufficiently long run of compact value-bearing lines.
 */
export interface TabularLayoutLine {
  index: number;
  rawStart: number;
  rawEnd: number;
  contentStart: number;
  contentEnd: number;
  rawText: string;
  text: string;
  hasTab: boolean;
  compact: boolean;
  mechanicValueLike: boolean;
  structural: boolean;
}

export interface TabularLayout {
  lines: TabularLayoutLine[];
}

const COMPACT_ROW_MAX_LENGTH = 72;
const SENTENCE_END = /[。！？；.!?;…]$/;
const DICE_VALUE = /(?:\d+)?d\d+(?:\s*[+-]\s*\d+)?/i;
const SIGNED_OR_PERCENT_VALUE = /(?:^|\D)[+-]\s*\d+\b|\d+\s*%/;
// PDF table cells often concatenate a stat label and its value (for example
// "Str50" or "HP13"). Do not use a trailing word boundary here: digits and
// adjacent CJK text are both word characters to the regexp engine. The
// standalone-number arm keeps all-numeric cells visible after tab cleanup.
const STAT_OR_VALUE_TOKEN = /(?:San|HP|MP|CM|CON|STR|DEX|SIZ|INT|POW|EDU|APP|RP|KP|PL)\s*\d+|(?:^|\s)\d{1,3}(?=\s|$)/i;

function normalizedLine(raw: string): string {
  return raw.replace(/[ \t\u00a0\u3000]+/g, " ").trim();
}

function rawLineRanges(raw: string): Array<{ rawStart: number; rawEnd: number }> {
  const lines: Array<{ rawStart: number; rawEnd: number }> = [];
  let rawStart = 0;
  for (const match of raw.matchAll(/\r?\n/g)) {
    lines.push({ rawStart, rawEnd: match.index! });
    rawStart = match.index! + match[0].length;
  }
  lines.push({ rawStart, rawEnd: raw.length });
  return lines;
}

function contentBounds(raw: string, rawStart: number, rawEnd: number): { contentStart: number; contentEnd: number } {
  const line = raw.slice(rawStart, rawEnd);
  const leading = line.match(/^[ \t\u00a0\u3000]*/)?.[0].length ?? 0;
  const trailing = line.match(/[ \t\u00a0\u3000]*$/)?.[0].length ?? 0;
  return { contentStart: rawStart + leading, contentEnd: rawEnd - trailing };
}

function mechanicValueLike(text: string): boolean {
  return DICE_VALUE.test(text) || SIGNED_OR_PERCENT_VALUE.test(text) || STAT_OR_VALUE_TOKEN.test(text);
}

function createTabularLayout(raw: string): TabularLayout {
  return {
    lines: rawLineRanges(raw).map(({ rawStart, rawEnd }, index) => {
      const rawText = raw.slice(rawStart, rawEnd);
      const text = normalizedLine(rawText);
      const bounds = contentBounds(raw, rawStart, rawEnd);
      const compact = text.length > 0 && text.length <= COMPACT_ROW_MAX_LENGTH && !SENTENCE_END.test(text);
      return {
        index,
        rawStart,
        rawEnd,
        ...bounds,
        rawText,
        text,
        hasTab: rawText.includes("\t"),
        compact,
        mechanicValueLike: mechanicValueLike(text),
        structural: false,
      };
    }),
  };
}

function markStructuralRuns(layouts: TabularLayout[]): void {
  const lines: Array<TabularLayoutLine | undefined> = [];
  let previousPageHadContent = false;
  for (const [pageIndex, layout] of layouts.entries()) {
    const firstContent = layout.lines.findIndex((line) => line.text !== "");
    const lastContent = layout.lines.findLastIndex((line) => line.text !== "");
    const pageHasContent = firstContent >= 0;

    // PDF extraction commonly leaves a newline at one or both page edges.
    // Those edge-only blanks are layout noise for a cross-page table run, not
    // an internal paragraph break. Keep every raw line and offset in its
    // layout; this trimmed view is used only to decide run continuity.
    if (pageIndex > 0 && (!previousPageHadContent || !pageHasContent)) lines.push(undefined);
    if (pageHasContent) lines.push(...layout.lines.slice(firstContent, lastContent + 1));
    previousPageHadContent = pageHasContent;
  }

  for (let start = 0; start < lines.length;) {
    if (!lines[start]?.compact || !lines[start]?.mechanicValueLike) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < lines.length && lines[end]?.compact && lines[end]?.mechanicValueLike) end++;
    if (end - start >= 3) {
      for (let index = start; index < end; index++) lines[index]!.structural = true;
    }
    start = end;
  }
}

/**
 * Detect source rows which must retain their line boundary. The same detector
 * runs over raw tabbed PDF text and already-normalized text, preserving the
 * cleanPageText idempotence contract without a tab-only escape hatch.
 */
export function detectTabularLayout(raw: string): TabularLayout {
  return detectTabularLayouts([raw])[0]!;
}

/**
 * Page-batch counterpart to detectTabularLayout. It deliberately preserves
 * page-local offsets while allowing one structural run to cross a PDF page
 * boundary, so a 2+1 split is classified before either page can be cleaned.
 */
export function detectTabularLayouts(rawPages: readonly string[]): TabularLayout[] {
  const layouts = rawPages.map(createTabularLayout);
  markStructuralRuns(layouts);
  return layouts;
}
