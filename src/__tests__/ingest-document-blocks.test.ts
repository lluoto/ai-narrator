import { describe, expect, it } from "bun:test";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { cleanPageText, cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { createSyntheticDocumentIR, sha256, validateEvidenceRef } from "../ingest/document-ir";
import { sectionize } from "../ingest/sectionize";

function blocksFor(pages: string[]) {
  const document = createSyntheticDocumentIR(pages, "document-block-test");
  const traced = joinPagesWithTrace(document.pages.map(cleanPageWithTrace));
  const blocks = buildDocumentBlocks(document, traced);
  for (const block of blocks) validateEvidenceRef(block.evidence, document);
  return { document, traced, blocks };
}

describe("DocumentBlock evidence", () => {
  it("recognizes consecutive named entries only after an explicit discovery list guide", () => {
    const { blocks } = blocksFor([[
      "搜查现场：",
      "搜索房间可以发现以下物品。",
      "染血钥匙：挂在门后。",
      "石像：摆在书桌上。",
      "窗边：有一块月光石。",
      "这段普通散文不能被绑定到前一个物品。",
    ].join("\n")]);
    const items = blocks.filter((block) => block.kind === "marked_item");

    expect(items.map((item) => item.text)).toEqual([
      "染血钥匙：挂在门后。",
      "石像：摆在书桌上。",
      "窗边：有一块月光石。",
    ]);
    expect(items.map((item) => item.nameEvidence?.spans.map((span) => span.exactText).join(""))).toEqual(["染血钥匙", "石像", "窗边"]);
    expect(items.map((item) => item.bodyEvidence?.spans.map((span) => span.exactText).join(""))).toEqual(["挂在门后。", "摆在书桌上。", "有一块月光石。"]);
    expect(blocks.some((block) => block.kind === "marked_item" && block.text.includes("普通散文"))).toBe(false);
  });

  it("keeps a bulleted discovery guide semantically identical to legacy Section.items", () => {
    const page = [
      "搜查现场：",
      "- 搜索房间可以发现以下物品：",
      "染血钥匙：挂在门后。",
      "石像：摆在书桌上。",
    ].join("\n");
    const { blocks } = blocksFor([page]);
    const legacyItems = sectionize([cleanPageText(page)])
      .flatMap((section) => section.items)
      .map((item) => ({ name: item.name, text: item.text }));
    const blockItems = blocks
      .filter((block) => block.kind === "marked_item")
      .map((block) => ({
        name: block.nameEvidence?.spans.map((span) => span.exactText).join(""),
        text: block.bodyEvidence?.spans.map((span) => span.exactText).join(""),
      }));

    expect(legacyItems).toEqual([
      { name: "染血钥匙", text: "挂在门后。" },
      { name: "石像", text: "摆在书桌上。" },
    ]);
    expect(blockItems).toEqual(legacyItems);
  });

  it("does not promote NPC or rules colon fields without discovery-list context", () => {
    const { blocks } = blocksFor([[
      "人物资料：",
      "力量：10",
      "护甲：2",
      "规则说明：",
      "伤害：1d6",
    ].join("\n")]);

    expect(blocks.filter((block) => block.kind === "marked_item")).toEqual([]);
  });

  it("does not promote a named colon line without an explicit discovery-list guide", () => {
    const { blocks } = blocksFor(["房间：\n染血钥匙：挂在门后。"]);

    expect(blocks.filter((block) => block.kind === "marked_item")).toEqual([]);
  });

  it("keeps context-backed bare PDF headings separate, without mistaking quoted fragments for headings", () => {
    // Shape transcribed from the raw text of 《复足》: short headings have no
    // colon, while the quoted plea is deliberately split across short lines.
    // Keep this in memory so the regression test never depends on an external PDF.
    const raw = [
      "“幸运”检定.）",
      "电影时间",
      "首映式定于周六的晚上，调查员们正在他们十层的套房中。",
      "黑夜中的尖叫",
      "最终，调查员们都会回到他们的套房中睡觉。",
      "兰迪微微发出痛苦的声音，嘴唇一张一翕，“",
      "跑……",
      "快跑…",
      "石头能带你",
      "出去……”",
      "然后又陷入了僵硬的死寂。",
      "据说这石头来自失落之城“",
      "冷”",
      "中发掘文物。",
      "劳伦.",
      "理查兹扮演的英",
      "雄般的女主角带着文物冲出了丛林。",
      "成年冷蛛的资料如下.",
      "NPC 属性",
      "汤姆.法佐理",
      "力量 10 体质 13 敏捷 12 体型 14",
    ].join("\n");
    const expected = [
      "“幸运”检定.）",
      "电影时间",
      "首映式定于周六的晚上，调查员们正在他们十层的套房中。",
      "黑夜中的尖叫",
      "最终，调查员们都会回到他们的套房中睡觉。",
      "兰迪微微发出痛苦的声音，嘴唇一张一翕，“跑……",
      "快跑…",
      "石头能带你出去……”",
      "然后又陷入了僵硬的死寂。",
      "据说这石头来自失落之城“冷”中发掘文物。",
      "劳伦.理查兹扮演的英雄般的女主角带着文物冲出了丛林。",
      "成年冷蛛的资料如下.",
      "NPC 属性",
      "汤姆.法佐理",
      "力量 10 体质 13 敏捷 12 体型 14",
    ].join("\n");
    const document = createSyntheticDocumentIR([raw], "bare-heading-layout-test");
    const traced = cleanPageWithTrace(document.pages[0]!);
    const blocks = buildDocumentBlocks(document, [traced]);

    expect(cleanPageText(raw)).toBe(expected);
    expect(traced.text).toBe(expected);
    expect(sectionize([traced.text]).map((section) => section.title).filter(Boolean)).toEqual([
      "电影时间",
      "黑夜中的尖叫",
      "NPC 属性",
      "汤姆.法佐理",
    ]);
    expect(blocks.filter((block) => block.kind === "heading").map((block) => block.text)).toEqual([
      "电影时间",
      "黑夜中的尖叫",
      "NPC 属性",
      "汤姆.法佐理",
    ]);
    expect(blocks.filter((block) => block.kind === "heading").map((block) => block.evidence.spans.map((span) => span.exactText))).toEqual([
      ["电影时间"],
      ["黑夜中的尖叫"],
      ["NPC", "属性"], // the normalized inter-word space is synthetic
      ["汤姆.法佐理"],
    ]);
    expect(blocks.some((block) => block.kind === "heading" && /石头能带你|冷|理查兹扮演的英/.test(block.text))).toBe(false);
    for (const block of blocks) validateEvidenceRef(block.evidence, document);
  });

  it("keeps heading, ordinary paragraph, marked item name, and item body separately addressable", () => {
    const { blocks } = blocksFor(["前置散文。\n场景：\n普通正文。\n▶钥匙：打开门。"]);
    const heading = blocks.find((block) => block.kind === "heading");
    const paragraph = blocks.find((block) => block.kind === "paragraph" && block.text === "普通正文。");
    const item = blocks.find((block) => block.kind === "marked_item");
    expect(blocks.find((block) => block.kind === "paragraph" && block.text === "前置散文。")?.parentSectionId).toBeUndefined();
    expect(heading?.evidence.spans).not.toEqual([]);
    expect(paragraph?.parentSectionId).toBe(heading?.id);
    expect(item?.nameEvidence?.spans.map((span) => span.exactText).join("")).toBe("钥匙");
    expect(item?.bodyEvidence?.spans.map((span) => span.exactText).join("")).toBe("打开门。");
  });

  it("represents cross-page prose with multiple page spans instead of one synthetic range", () => {
    const { blocks } = blocksFor(["场景：\n这一段没有收尾", "补上。\n▶物：正文"]);
    const paragraph = blocks.find((block) => block.kind === "paragraph");
    expect(paragraph?.text).toBe("这一段没有收尾补上。");
    expect(new Set(paragraph?.evidence.spans.map((span) => span.pageNumber))).toEqual(new Set([1, 2]));
  });

  it("keeps unnamed and same-named marked items distinct by evidence position", () => {
    const { blocks } = blocksFor(["场景：\n▶没有名字\n▶钥匙：甲\n▶钥匙：乙"]);
    const items = blocks.filter((block) => block.kind === "marked_item");
    expect(items).toHaveLength(3);
    expect(items[0]?.nameEvidence).toBeUndefined();
    expect(items[1]?.id).not.toBe(items[2]?.id);
    expect(items[1]?.evidence.spans[0]?.rawStart).not.toBe(items[2]?.evidence.spans[0]?.rawStart);
  });

  it("uses evidence-derived IDs rather than a position in a filtered output list", () => {
    const { blocks } = blocksFor(["甲：\n甲正文。\n乙：\n乙正文。"]);
    const second = blocks.find((block) => block.text === "乙正文。");
    const afterFiltering = blocks.filter((block) => block.text !== "甲正文。").find((block) => block.text === "乙正文。");
    expect(second?.id).toBe(afterFiltering?.id);
    expect(second?.id).toBe(`block_${sha256("synthetic:document-block-test|paragraph|1:11:15").slice(0, 24)}`);
  });

  it("leaves legacy section body and sourceKey coordinates unchanged", () => {
    const pages = ["场景：\n正文。\n▶物：条目。"];
    const sections = sectionize(pages);
    expect(sections).toEqual([{ title: "场景", body: "正文。", items: [{ name: "物", text: "条目。", source: { page: 1, line: 3 } }], source: { page: 1, line: 1 } }]);
  });
});
