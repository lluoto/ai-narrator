// 摄取管线 · PDF → 逐页文本
//
// 这里只测形态，不测内容保真。
//
// 内容保真需要原文切片，而切片在被 .gitignore 排除的 tools/ 下，
// 且 `0fbf778 chore: keep one copy of the raw material` 明确只留一份素材。
// 把 PDF 文本复制进 fixtures 既违背那个决定，也等于把模组原文又铺进一处。
// 保真靠实跑对 tools/modules/raw/ 逐字比对（已验证 17/17），不靠单测假装验证。
//
// 别把这条当成漏测顺手补上。

import { describe, test, expect } from "bun:test";
import { PDFParse } from "pdf-parse";
import { buildDocumentIR, extractDocumentPages, extractPages } from "../ingest/pdf-source";
import { sha256 } from "../ingest/document-ir";
import { minimalPdfBytes } from "./helpers/minimal-pdf";

describe("extractPages", () => {
  test("releases the whole-document parser after extraction", async () => {
    const originalDestroy = PDFParse.prototype.destroy;
    let destroyCalls = 0;
    PDFParse.prototype.destroy = async function (this: PDFParse): Promise<void> {
      destroyCalls++;
      await originalDestroy.call(this);
    };
    try {
      await extractDocumentPages(minimalPdfBytes("parser lifecycle fixture"));
      expect(destroyCalls).toBe(1);
    } finally {
      PDFParse.prototype.destroy = originalDestroy;
    }
  });

  // await 不能省：expect(...).rejects 返回的是 Promise，
  // 不 await 就没人观察这个断言，函数不抛时测试照样绿 —— 等于什么都没测
  test("空数据抛的必须是本模块那条 —— 返回空数组会让整条管线安静地产出零个场景", async () => {
    // 那种失败会表现成「模型没干活」，而真正的原因在最上游。
    //
    // 消息写全，不是光判「抛了没有」：pdf-parse 自己对空字节也抛
    // （InvalidPDFException: The PDF file is empty），所以裸的 toThrow() 在
    // 把实现里 data.length === 0 那句删掉之后照样绿。而那句的全部意义就是
    // 抢在库前面给失败盖上 [ingest] 戳、指明是哪一层报的 —— 裸断言等于没测它。
    await expect(extractPages(new Uint8Array(0))).rejects.toThrow("[ingest] PDF 数据为空");
  });

  test("不是 PDF 的字节也要抛，不能假装成功", async () => {
    // 这条故意不按上面那条的规格收紧：本模块对非 PDF 字节没有自己的检查，
    // 真正抛的是 pdf-parse（InvalidPDFException: Invalid PDF structure）。
    // 硬套 [ingest] 前缀是断言一件不存在的事；改成钉库自己的措辞，又等于把
    // 别人家的文案设成我们的回归门槛 —— pdf-parse 换个说法就无端变红，
    // 而本模块一行没动。这里能诚实保证的只有「不许静默成功」，到此为止。
    await expect(extractPages(new TextEncoder().encode("这不是 PDF"))).rejects.toThrow();
  });
});

describe("buildDocumentIR", () => {
  test("retains the SHA-256 of non-empty PDF input bytes after pdf-parse", async () => {
    const pdfBytes = minimalPdfBytes("PDF identity fixture");
    const expectedDocumentHash = sha256(pdfBytes);

    const document = await buildDocumentIR(pdfBytes);

    expect(document.documentHash).toBe(expectedDocumentHash);
    expect(document.hashSource).toBe("pdf_bytes_sha256");
    expect(document.pages.length).toBeGreaterThan(0);
    for (const page of document.pages) {
      expect(page.documentHash).toBe(expectedDocumentHash);
      expect(page.hashSource).toBe("pdf_bytes_sha256");
    }
  });
});
