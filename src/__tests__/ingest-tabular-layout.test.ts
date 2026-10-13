import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { cleanPages, cleanPagesWithTrace, cleanPageText, cleanPageWithTrace, joinPages, joinPagesWithTrace } from "../ingest/clean-text";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR, sha256, validateEvidenceRef, type DocumentIR } from "../ingest/document-ir";
import { prepareSections } from "../ingest/pipeline";
import { detectTabularLayout, detectTabularLayouts } from "../ingest/tabular-layout";
import {
  BARN_SOURCE_EVIDENCE_MANIFEST_PATH,
  canonicalizeSourceEvidenceText,
  readSourceBoundCorpus,
  readSourceEvidenceManifest,
} from "../ingest/three-way-audit";

function sourceSection(file: string): { raw: string; document: DocumentIR } {
  const allCorpus = readSourceBoundCorpus();
  if (!allCorpus.ok) throw new Error(allCorpus.reason);
  const manifest = readSourceEvidenceManifest();
  if ("ok" in manifest) {
    if (!manifest.ok) throw new Error(manifest.reason);
    throw new Error("unexpected manifest corpus result");
  }
  const section = manifest.sections.find((entry) => entry.file === file);
  if (!section) throw new Error(`missing controlled section: ${file}`);
  const raw = canonicalizeSourceEvidenceText(readFileSync(join(dirname(BARN_SOURCE_EVIDENCE_MANIFEST_PATH), manifest.corpusDirectory, file), "utf8"));
  expect(sha256(raw)).toBe(section.canonicalTextSha256);
  const documentHash = manifest.source.originalPdfSha256;
  return {
    raw,
    document: {
      schemaVersion: "1.0.0",
      documentHash,
      hashSource: "pdf_bytes_sha256",
      pages: [{ pageNumber: section.pdfPage, rawText: raw, rawTextHash: sha256(raw), documentHash, hashSource: "pdf_bytes_sha256" }],
    },
  };
}

function normalizedLine(raw: string): string {
  return raw.replace(/[ \t\u00a0\u3000]+/g, " ").trim();
}

function rawLineRanges(raw: string): Array<{ rawStart: number; rawEnd: number; text: string }> {
  const rows: Array<{ rawStart: number; rawEnd: number; text: string }> = [];
  let rawStart = 0;
  for (const match of raw.matchAll(/\r?\n/g)) {
    rows.push({ rawStart, rawEnd: match.index!, text: raw.slice(rawStart, match.index!) });
    rawStart = match.index! + match[0].length;
  }
  rows.push({ rawStart, rawEnd: raw.length, text: raw.slice(rawStart) });
  return rows;
}

describe("source-bound tabular layout preservation", () => {
  it("keeps the nine real True End reward rows separate from prose", () => {
    const { raw, document } = sourceSection("section_14.txt");
    const rewards = raw.split(/\r?\n/).slice(15, 24).map(normalizedLine);
    expect(rewards).toHaveLength(9);
    const cleaned = cleanPageText(raw);
    const traced = cleanPageWithTrace(document.pages[0]!);
    expect(traced.text).toBe(cleaned);
    expect(cleanPageText(cleaned)).toBe(cleaned);
    const cleanedLines = cleaned.split("\n");
    expect(cleanedLines.filter((line) => rewards.includes(line))).toHaveLength(9);
    const trueEndProse = cleanedLines.find((line) => line.includes("调查员找到了事件的真相"))!;
    expect(trueEndProse).not.toContain(rewards[0]!);
  });

  it("emits nine exact table rows with heading scope and follows edges", () => {
    const { raw, document } = sourceSection("section_14.txt");
    const traced = cleanPageWithTrace(document.pages[0]!);
    const blocks = buildDocumentBlocks(document, [traced]);
    const rawRows = rawLineRanges(raw).slice(15, 24);
    const tableRows = blocks.filter((block) => block.kind === "table_row");
    const heading = blocks.find((block) => block.kind === "heading" && block.text === normalizedLine(rawLineRanges(raw)[12]!.text))!;
    expect(tableRows).toHaveLength(9);
    expect(tableRows.map((block) => block.text)).toEqual(rawRows.map((row) => normalizedLine(row.text)));
    for (const [index, block] of tableRows.entries()) {
      expect(block.parentSectionId).toBe(heading.id);
      expect(block.evidence.precision).toBe("exact_text");
      validateEvidenceRef(block.evidence, document);
      const spans = block.evidence.spans;
      expect(Math.min(...spans.map((span) => span.rawStart))).toBe(rawRows[index]!.rawStart);
      expect(Math.max(...spans.map((span) => span.rawEnd))).toBe(rawRows[index]!.rawEnd);
    }

    const graph = buildSourceFactGraph(document, blocks);
    const headingStatement = graph.statements.find((statement) => statement.kind === "heading" && statement.text === heading.text)!;
    const tableStatements = graph.statements.filter((statement) => statement.kind === "table_row");
    expect(tableStatements).toHaveLength(9);
    for (const [index, statement] of tableStatements.entries()) {
      expect(statement.parentStatementId).toBe(headingStatement.id);
      expect(graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === headingStatement.id && relation.to === statement.id)).toBe(true);
      if (index > 0) expect(graph.relations.some((relation) => relation.kind === "follows" && relation.from === tableStatements[index - 1]!.id && relation.to === statement.id)).toBe(true);
    }
  });

  it("does not promote controlled trap prose or short compact mechanic runs", () => {
    const trap = sourceSection("section_08.txt");
    const trapLines = rawLineRanges(trap.raw);
    const trapCleaned = cleanPageText(trap.raw);
    expect(trapCleaned).toContain(normalizedLine(trapLines[41]!.text) + normalizedLine(trapLines[42]!.text));
    expect(trapCleaned).toContain(normalizedLine(trapLines[18]!.text));
    expect(buildDocumentBlocks(trap.document, [cleanPageWithTrace(trap.document.pages[0]!)]).filter((block) => block.kind === "table_row")).toHaveLength(0);

    const shortRun = sourceSection("section_09.txt");
    const shortRunLines = rawLineRanges(shortRun.raw);
    const shortRunCleaned = cleanPageText(shortRun.raw);
    expect(shortRunCleaned).toContain(normalizedLine(shortRunLines[44]!.text) + normalizedLine(shortRunLines[45]!.text));
    expect(buildDocumentBlocks(shortRun.document, [cleanPageWithTrace(shortRun.document.pages[0]!)]).filter((block) => block.kind === "table_row")).toHaveLength(0);
  });

  it("keeps structural first rows intact at a page boundary in plain and traced joins", () => {
    const rawPages = [
      "前一页未结束的正文",
      "调查奖励 San d6\n信誉 +10\n侦查 d10",
    ];
    const cleanedPages = rawPages.map(cleanPageText);
    expect(detectTabularLayout(cleanedPages[1]!).lines.filter((line) => line.structural)).toHaveLength(3);
    expect(joinPages(cleanedPages)).toEqual(cleanedPages);

    const document = createSyntheticDocumentIR(rawPages, "cross-page-tabular-layout");
    const tracedPages = document.pages.map(cleanPageWithTrace);
    expect(joinPagesWithTrace(tracedPages).map((page) => page.text)).toEqual(cleanedPages);
  });

  it("does not weld a 2+1 structural run before the page join", () => {
    const rawPages = [
      "前页正常正文。\n调查奖励 San d6\n信誉 +10",
      "侦查 d10\n后页普通正文。",
    ];
    const expectedRows = "调查奖励 San d6\n信誉 +10\n侦查 d10";
    const cleanedPages = cleanPages(rawPages);
    expect(cleanedPages).toEqual([
      "前页正常正文。\n调查奖励 San d6\n信誉 +10",
      "侦查 d10\n后页普通正文。",
    ]);
    expect(joinPages(cleanedPages)).toEqual(cleanedPages);

    const document = createSyntheticDocumentIR(rawPages, "cross-page-2-plus-1-tabular-layout");
    const tracedPages = cleanPagesWithTrace(document.pages);
    expect(joinPagesWithTrace(tracedPages).map((page) => page.text)).toEqual(cleanedPages);
    const tableRows = buildDocumentBlocks(document, joinPagesWithTrace(tracedPages)).filter((block) => block.kind === "table_row");
    expect(tableRows.map((block) => block.text)).toEqual(expectedRows.split("\n"));
    expect(prepareSections(rawPages).flatMap((section) => section.body).join("\n")).toContain(expectedRows);
  });

  it("keeps a 2+1 structural run across raw page-edge blank lines", () => {
    const rawPages = [
      "前页正常正文。\n调查奖励 San d6\n信誉 +10\n \n",
      "\n\t\n侦查 d10\n后页普通正文。",
    ];
    const expectedRows = "调查奖励 San d6\n信誉 +10\n侦查 d10";
    const cleanedPages = cleanPages(rawPages);
    expect(cleanedPages).toEqual([
      "前页正常正文。\n调查奖励 San d6\n信誉 +10",
      "侦查 d10\n后页普通正文。",
    ]);
    expect(joinPages(cleanedPages)).toEqual(cleanedPages);

    const document = createSyntheticDocumentIR(rawPages, "cross-page-edge-blank-2-plus-1-tabular-layout");
    const tracedPages = cleanPagesWithTrace(document.pages);
    expect(joinPagesWithTrace(tracedPages).map((page) => page.text)).toEqual(cleanedPages);
    const tableRows = buildDocumentBlocks(document, joinPagesWithTrace(tracedPages)).filter((block) => block.kind === "table_row");
    expect(tableRows.map((block) => block.text)).toEqual(expectedRows.split("\n"));
    expect(prepareSections(rawPages).flatMap((section) => section.body).join("\n")).toContain(expectedRows);
  });

  it("does not let an internal blank line become cross-page layout noise", () => {
    const layouts = detectTabularLayouts([
      "调查奖励 San d6\n\n信誉 +10",
      "侦查 d10",
    ]);
    expect(layouts[0]!.lines.map((line) => line.text)).toEqual(["调查奖励 San d6", "", "信誉 +10"]);
    expect(layouts.flatMap((layout) => layout.lines).filter((line) => line.structural)).toHaveLength(0);
  });

  it("reports the actual compact mechanical runs across the controlled corpus", () => {
    const corpus = readSourceBoundCorpus();
    if (!corpus.ok) throw new Error(corpus.reason);
    const manifest = readSourceEvidenceManifest();
    if ("ok" in manifest) {
      if (!manifest.ok) throw new Error(manifest.reason);
      throw new Error("unexpected manifest corpus result");
    }
    const structuralRuns = manifest.sections.flatMap((section) => {
      const raw = canonicalizeSourceEvidenceText(readFileSync(join(dirname(BARN_SOURCE_EVIDENCE_MANIFEST_PATH), manifest.corpusDirectory, section.file), "utf8"));
      return detectTabularLayout(raw).lines.filter((line) => line.structural).map((line) => ({ file: section.file, index: line.index, text: line.text }));
    });
    expect(structuralRuns.filter((row) => row.file === "section_14.txt")).toHaveLength(9);
    expect(structuralRuns.filter((row) => row.file === "section_15.txt")).toHaveLength(15);
    expect(structuralRuns.filter((row) => row.file === "section_16.txt")).toHaveLength(3);
    expect(structuralRuns.filter((row) => !["section_14.txt", "section_15.txt", "section_16.txt"].includes(row.file))).toHaveLength(0);

    const npc = sourceSection("section_15.txt");
    const npcRows = buildDocumentBlocks(npc.document, [cleanPageWithTrace(npc.document.pages[0]!)]).filter((block) => block.kind === "table_row");
    const npcLineIndexes = [2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 16, 17, 18, 19];
    expect(npcRows.map((block) => block.text)).toEqual(npcLineIndexes.map((index) => normalizedLine(rawLineRanges(npc.raw)[index]!.text)));
  });
});
