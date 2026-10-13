// 摄取管线 · 第一段：PDF → 逐页文本
//
// 依赖是 pdf-parse v2.4.5，导出的是 PDFParse **类**，不是网上示例里那个默认函数。
// require("pdf-parse")(buffer) 会抛 pdfParse is not a function ——
// 这个坑值半小时，写在这儿免得下一个人再踩。
//
// 本模块只收 Uint8Array，不收路径、不碰 fs：读盘是 tools 脚本的事。
// 中间这几段保持无 IO，才能被纯逻辑单测（tools/ 不进版本库，放那里等于放弃测试）。
//
// getText() 之外还有 getPageTables / getImage / getHyperlinks，
// 模组附件是 6 张图，将来用得上。

import { PDFParse } from "pdf-parse";
import { sha256, type DocumentIR, type DocumentPage } from "./document-ir";
import { cleanPageText } from "./clean-text";

export const PDF_TEXT_UNAVAILABLE = "PDF_TEXT_UNAVAILABLE" as const;

/**
 * Limits used by the isolated public-PDF worker.  They deliberately describe
 * output rather than parser implementation details: pdf-parse has no
 * streaming text budget API, so the worker must inspect one page at a time.
 */
export interface PdfExtractionLimits {
  maxPages: number;
  maxPageTextUtf8Bytes: number;
  maxTotalTextUtf8Bytes: number;
}

export type PdfExtractionLimitKind = "pages" | "page_text_utf8" | "total_text_utf8";

/** A safe, typed worker-to-parent signal; never surface a parser message. */
export class PdfExtractionResourceLimitError extends Error {
  constructor(readonly limitKind: PdfExtractionLimitKind) {
    super(`PDF extraction exceeded ${limitKind}`);
    this.name = "PdfExtractionResourceLimitError";
  }
}

/** A syntactically valid PDF without a usable text layer needs OCR, not compilation. */
export class PdfTextUnavailableError extends Error {
  readonly code = PDF_TEXT_UNAVAILABLE;

  constructor() {
    super("[ingest] PDF has no usable normalized text layer");
    this.name = "PdfTextUnavailableError";
  }
}

/**
 * 抽出逐页原始文本。下游是 cleanPageText。
 *
 * 坏输入一律抛，不返回空数组：空数组会让整条管线安静地产出零个场景，
 * 表现成「模型没干活」，而真正的原因在最上游。
 */
export async function extractDocumentPages(data: Uint8Array): Promise<DocumentPage[]> {
  // 抢在 pdf-parse 之前拦空数据，是为了让错误带上 [ingest] 前缀落在本管线名下。
  // 少了这行也会抛（库自己报 InvalidPDFException），但那条消息指不回这里。
  if (data.length === 0) throw new Error("[ingest] PDF 数据为空");

  // pdf-parse may transfer/detach the caller's ArrayBuffer. Record the
  // source-exact identity before handing it off, so a later page result never
  // turns the original PDF identity into the SHA-256 of an emptied buffer.
  const documentHash = sha256(data);

  const parser = new PDFParse({ data });
  try {
    const res = await parser.getText();

  // 逐页元素的形状是实测的，不是照记忆写的：pages[i] 是对象 { num, text }，
  // num 从 1 起，text 就是该页全文；这与包内 PageTextResult 的声明一致。
  // 取值一路走类型系统（不写 res as any），是为了让「库改了形状、并且改了 .d.ts」
  // 这一类变更直接摔在 bun run typecheck 上，而不是拖到运行时才发作。
  if (res.pages.length === 0) {
    // v2.4.5 对空字节和非 PDF 字节都会先抛 InvalidPDFException，走不到这里。
    // 留着是防以后版本改成「返回空结果」——那样整条管线会安静地产出零个场景。
    throw new Error("[ingest] pdf-parse 未返回逐页结果");
  }

  // 上面那道编译期保证只管得住「形状变了且声明跟着变了」。反过来的情况它一点办法没有：
  // 库改了形状却没更新 .d.ts，类型系统会一路点头放行，p.text 在运行时是 undefined，
  // 本函数于是返回一串 undefined 冒充 string[]。而下游 cleanPageText 的头一行是
  // `if (!raw) return ""`，每个 undefined 都会在下一段悄悄变成空字符串 ——
  // 那正是本模块唯一不能有的失败方式：整条管线产出零个场景、表现成「模型没干活」，
  // 全程没有一个人抛错，而真正的原因在最上游。
  //
  // 所以两道一起才成立：声明变了编译期拦，声明没变运行时拦。
  // 单靠类型不够，这也是为什么这里不能只写 res.pages.map((p) => p.text)。
  const pages = res.pages.map((p) => {
    if (typeof p.text !== "string") {
      throw new Error(`[ingest] pdf-parse 第 ${p.num} 页的 text 不是字符串`);
    }
    if (!Number.isInteger(p.num) || p.num < 1) {
      throw new Error(`[ingest] pdf-parse 页码无效: ${p.num}`);
    }
    return { pageNumber: p.num, rawText: p.text };
  });
    return pages.map((page) => ({
      ...page,
      rawTextHash: sha256(page.rawText),
      documentHash,
      hashSource: "pdf_bytes_sha256",
    }));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * Extract untrusted PDF text page-by-page.  This must run only in the
 * disposable parser process: asking pdf-parse for all pages creates one large
 * aggregate string before the caller can enforce a budget.
 */
export async function extractDocumentPagesBounded(
  data: Uint8Array,
  limits: PdfExtractionLimits,
  observer?: { beforeGetText(pageNumber: number): void },
): Promise<DocumentPage[]> {
  if (data.length === 0) throw new Error("[ingest] PDF data is empty");
  const documentHash = sha256(data);
  const parser = new PDFParse({ data });
  try {
    const info = await parser.getInfo();
    if (!Number.isSafeInteger(info.total) || info.total < 1) throw new Error("[ingest] pdf-parse returned invalid page count");
    // This check intentionally precedes every getText call.  Do not change it
    // to a post-extraction check: a 257-page document must never expand page 1.
    if (info.total > limits.maxPages) throw new PdfExtractionResourceLimitError("pages");
    const pages: DocumentPage[] = [];
    let totalBytes = 0;
    const encoder = new TextEncoder();
    for (let pageNumber = 1; pageNumber <= info.total; pageNumber++) {
      observer?.beforeGetText(pageNumber);
      const textResult = await parser.getText({ partial: [pageNumber] });
      const page = textResult.pages.find((candidate) => candidate.num === pageNumber);
      if (!page || typeof page.text !== "string") throw new Error("[ingest] pdf-parse returned no text for a requested page");
      const pageBytes = encoder.encode(page.text).byteLength;
      if (pageBytes > limits.maxPageTextUtf8Bytes) throw new PdfExtractionResourceLimitError("page_text_utf8");
      totalBytes += pageBytes;
      if (totalBytes > limits.maxTotalTextUtf8Bytes) throw new PdfExtractionResourceLimitError("total_text_utf8");
      pages.push({
        pageNumber,
        rawText: page.text,
        rawTextHash: sha256(page.text),
        documentHash,
        hashSource: "pdf_bytes_sha256",
      });
    }
    return pages;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** Build the complete source-exact representation from original PDF bytes. */
export async function buildDocumentIR(data: Uint8Array): Promise<DocumentIR> {
  const pages = await extractDocumentPages(data);
  if (!pages.some((page) => cleanPageText(page.rawText).trim() !== "")) {
    throw new PdfTextUnavailableError();
  }
  const documentHash = pages[0]?.documentHash;
  if (!documentHash) throw new Error("[ingest] PDF 文档哈希缺失");
  return {
    schemaVersion: "1.0.0",
    documentHash,
    hashSource: "pdf_bytes_sha256",
    pages,
  };
}

/** Compatibility wrapper. New callers should retain DocumentPage metadata. */
export async function extractPages(data: Uint8Array): Promise<string[]> {
  return (await extractDocumentPages(data)).map((page) => page.rawText);
}
