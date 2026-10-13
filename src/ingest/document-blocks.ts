import {
  evidenceRefFromTrace,
  sliceTracedText,
  splitTracedLines,
  trimTracedText,
  type TracedText,
} from "./clean-text";
import { sha256, type DocumentBlock, type DocumentBlockKind, type DocumentIR, type EvidenceRef } from "./document-ir";
import { sectionTitleLines } from "./section-heading";
import { isDiscoveryListGuide, parseDiscoveryListItemLine, parseSectionItemLine } from "./sectionize";
import { detectTabularLayouts, type TabularLayoutLine } from "./tabular-layout";

const MARKED_ITEM = /^[▶►▷]\s*/;
const LIST_ITEM = /^(?:[-*•]|\d+[.)])\s+/;

function concatTraces(parts: TracedText[], separator = ""): TracedText {
  let text = "";
  const fragments = [] as TracedText["fragments"];
  for (const [index, part] of parts.entries()) {
    if (index > 0) text += separator;
    const offset = text.length;
    text += part.text;
    fragments.push(...part.fragments.map((fragment) => ({
      outputStart: offset + fragment.outputStart,
      outputEnd: offset + fragment.outputEnd,
      evidence: fragment.evidence,
    })));
  }
  return { text, fragments };
}

/** Stable across reclassification because it depends on document identity and evidence, never block order. */
function blockId(document: DocumentIR, kind: DocumentBlockKind, evidence: EvidenceRef): string {
  const documentIdentity = document.documentHash ?? `synthetic:${document.sourceDescriptor ?? "unspecified"}`;
  const locations = evidence.spans.map((span) => `${span.pageNumber}:${span.rawStart}:${span.rawEnd}`).join("|");
  return `block_${sha256(`${documentIdentity}|${kind}|${locations}`).slice(0, 24)}`;
}

function block(document: DocumentIR, kind: DocumentBlockKind, trace: TracedText, parentSectionId?: string, details: Partial<DocumentBlock> = {}): DocumentBlock {
  const evidence = evidenceRefFromTrace(trace);
  return {
    id: blockId(document, kind, evidence),
    kind,
    text: trace.text,
    evidence,
    ...(parentSectionId ? { parentSectionId } : {}),
    ...details,
  };
}

function markedItemTrace(line: TracedText): { text: TracedText; name?: TracedText; body: TracedText } {
  const marker = line.text.match(MARKED_ITEM)?.[0] ?? "";
  const rest = trimTracedText(sliceTracedText(line, marker.length, line.text.length));
  const parsed = parseSectionItemLine(line.text);
  if (!parsed) throw new Error("marked item parser disagrees with block parser");
  const colon = rest.text.search(/[：:]/);
  if (colon < 0) return { text: rest, body: rest };
  const name = trimTracedText(sliceTracedText(rest, 0, colon));
  const body = trimTracedText(sliceTracedText(rest, colon + 1, rest.text.length));
  return { text: rest, ...(name.text ? { name } : {}), body };
}

function discoveryListItemTrace(line: TracedText): { text: TracedText; name: TracedText; body: TracedText } | undefined {
  if (!parseDiscoveryListItemLine(line.text)) return undefined;
  const colon = line.text.search(/[：:]/);
  const name = trimTracedText(sliceTracedText(line, 0, colon));
  const body = trimTracedText(sliceTracedText(line, colon + 1, line.text.length));
  return { text: line, name, body };
}

/** Uses raw-layout spans carried by the trace; it never reclassifies cleaned prose. */
function isTracedTableRow(line: TracedText, pageNumber: number, candidates: readonly TabularLayoutLine[]): boolean {
  const evidence = evidenceRefFromTrace(line);
  if (evidence.spans.length === 0) return false;
  const rawStart = Math.min(...evidence.spans.map((span) => span.rawStart));
  const rawEnd = Math.max(...evidence.spans.map((span) => span.rawEnd));
  return candidates.some((candidate) =>
    evidence.spans.every((span) => span.pageNumber === pageNumber)
      && rawStart === candidate.contentStart
      && rawEnd === candidate.contentEnd,
  );
}

/**
 * Produce source-addressable prose, heading, and marked-item blocks before any
 * LLM classification. Existing Section/SourceRef output is deliberately left
 * unchanged for legacy measurement-coordinate compatibility.
 */
export function buildDocumentBlocks(document: DocumentIR, tracedPages: TracedText[], limits?: { maxBlocks: number }): DocumentBlock[] {
  if (tracedPages.length !== document.pages.length) {
    throw new Error(`document pages and traces length mismatch: ${document.pages.length} vs ${tracedPages.length}`);
  }

  const blocks: DocumentBlock[] = [];
  const addBlock = (entry: DocumentBlock): void => {
    // Keep the guard adjacent to allocation.  Callers that process untrusted
    // text must not first materialize an arbitrarily large block array and
    // only then discover that it exceeds their resource policy.
    if (limits && blocks.length >= limits.maxBlocks) throw new Error("document_blocks_limit_exceeded");
    blocks.push(entry);
  };
  const tabularRowsByPage = detectTabularLayouts(document.pages.map((page) => page.rawText));
  let parentSectionId: string | undefined;
  let discoveryListPending = false;
  let paragraph: TracedText[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const trace = concatTraces(paragraph, "\n");
    addBlock(block(document, "paragraph", trace, parentSectionId));
    paragraph = [];
  };

  for (const [pageIndex, page] of tracedPages.entries()) {
    const rawPage = document.pages[pageIndex]!;
    const tabularRows = tabularRowsByPage[pageIndex]!.lines.filter((line) => line.structural);
    const lines = splitTracedLines(page);
    const titles = sectionTitleLines(lines.map((line) => line.text));
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.text === "") {
        flushParagraph();
        discoveryListPending = false;
        continue;
      }
      const heading = titles[index];
      if (heading !== undefined) {
        flushParagraph();
        const headingBlock = block(document, "heading", line);
        addBlock(headingBlock);
        parentSectionId = headingBlock.id;
        discoveryListPending = false;
        continue;
      }
      if (parseSectionItemLine(line.text)) {
        flushParagraph();
        const item = markedItemTrace(line);
        addBlock(block(document, "marked_item", item.text, parentSectionId, {
          ...(item.name ? { nameEvidence: evidenceRefFromTrace(item.name) } : {}),
          bodyEvidence: evidenceRefFromTrace(item.body),
        }));
        discoveryListPending = false;
        continue;
      }
      if (discoveryListPending) {
        const item = discoveryListItemTrace(line);
        if (item) {
          flushParagraph();
          addBlock(block(document, "marked_item", item.text, parentSectionId, {
            nameEvidence: evidenceRefFromTrace(item.name),
            bodyEvidence: evidenceRefFromTrace(item.body),
          }));
          continue;
        }
      }
      const list = line.text.match(LIST_ITEM);
      if (list) {
        flushParagraph();
        const item = trimTracedText(sliceTracedText(line, list[0].length, line.text.length));
        addBlock(block(document, "list_item", item, parentSectionId));
        // A guide may itself be formatted as a list item. Keep the same
        // immediately-following-line contract as sectionize rather than
        // letting this representation silently discard its discovery scope.
        discoveryListPending = isDiscoveryListGuide(line.text);
        continue;
      }
      if (isTracedTableRow(line, rawPage.pageNumber, tabularRows)) {
        flushParagraph();
        addBlock(block(document, "table_row", line, parentSectionId));
        discoveryListPending = false;
        continue;
      }
      paragraph.push(line);
      discoveryListPending = isDiscoveryListGuide(line.text);
    }
  }
  flushParagraph();
  return blocks;
}
