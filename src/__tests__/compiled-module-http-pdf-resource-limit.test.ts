import { describe, expect, it } from "bun:test";
import { deflateSync } from "zlib";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { COMPILER_HTTP_PDF_BODY_LIMIT_BYTES, handleCompiledModuleHttpRequest } from "../api/compiled-module-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { PdfExtractionResourceLimitError, extractDocumentPagesBounded } from "../ingest/pdf-source";
import { PDF_PREPARE_LIMITS, __replacePdfPrepareWorkerForTest, prepareUntrustedPdfCompilerArtifact } from "../compiler/compiler-pdf-prepare-isolation";
import { sha256 } from "../ingest/document-ir";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  return joined;
}

/** A local, valid PDF whose tiny Flate stream expands to the supplied text. */
function flatePdfBytes(expandedText: string): Uint8Array {
  // This mirrors the production Type0/ToUnicode shape.  The stream contains
  // More than the page-text limit, while Flate reduces its raw request bytes
  // to a few KiB.
  const hex = [...expandedText].map((character) => character.codePointAt(0)!.toString(16).padStart(4, "0")).join("");
  const compressed = new Uint8Array(deflateSync(bytes(`BT\n/F1 0.0001 Tf\n72 720 Td\n<${hex}> Tj\nET\n`)));
  const cmap = bytes("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
  const prefix = bytes("%PDF-1.4\n");
  const objects = [
    bytes("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    bytes("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    bytes("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n"),
    joinBytes([
      bytes(`4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`),
      compressed,
      bytes("\nendstream\nendobj\n"),
    ]),
    bytes("5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /Helvetica /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>\nendobj\n"),
    bytes("6 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Helvetica /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /CIDToGIDMap /Identity >>\nendobj\n"),
    joinBytes([bytes(`7 0 obj\n<< /Length ${cmap.length} >>\nstream\n`), cmap, bytes("endstream\nendobj\n")]),
    bytes("8 0 obj\n<< /Type /FontDescriptor /FontName /Helvetica /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>\nendobj\n"),
  ];
  const offsets: number[] = [];
  let cursor = prefix.length;
  for (const object of objects) { offsets.push(cursor); cursor += object.length; }
  const xref = bytes(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`);
  return joinBytes([prefix, ...objects, xref]);
}

/** Page-tree-only PDF: getInfo can count it, while getText would find no text. */
function manyPagePdf(pageCount: number): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    // A text read of page 1 must resolve this absent object and fail. getInfo
    // need only inspect the page tree, so the 257-page refusal proves no
    // getText call occurred before the page-count guard.
    ...Array.from({ length: pageCount }, (_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${index === 0 ? ` /Contents ${pageCount + 3} 0 R` : ""} >>`),
    "<< /Length 3 /Filter /FlateDecode >>\nstream\nxxx\nendstream",
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(bytes(output).byteLength);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = bytes(output).byteLength;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytes(output);
}

function dependencies(catalog: CompilerArtifactCatalog) {
  return {
    catalog,
    createSession: () => { throw new Error("session creation is outside this PDF resource-limit test"); },
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => undefined,
    generateId: () => "pdf-resource-limit-test",
    authenticateCompilerRequest: () => ({ status: "authenticated" as const, principal: { id: "pdf-resource-limit-test", role: "operator" as const } }),
  };
}

describe("compiled prepare PDF resource limits", () => {
  it("refuses a sub-8MiB Flate PDF whose one-page extracted text exceeds the server budget before catalog write", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-pdf-resource-limit-"));
    const catalog = new CompilerArtifactCatalog({ root });
    let preparedWrites = 0;
    const savePrevalidatedPrepared = catalog.savePrevalidatedPrepared.bind(catalog);
    (catalog as unknown as { savePrevalidatedPrepared(value: unknown): unknown }).savePrevalidatedPrepared = (value) => {
      preparedWrites++;
      return savePrevalidatedPrepared(value as never);
    };
    // This is intentionally one byte over the server's per-page UTF-8 cap
    // while compressing to a few KiB: the existing 8 MiB request-body cap
    // accepts it.  The HTTP result below proves the real parser expands this
    // document past the cap; do not pay for an unrelated, duplicate unbounded
    // parent-process extraction in this route test.
    const expandedText = "A".repeat(PDF_PREPARE_LIMITS.maxPageTextUtf8Bytes + 1);
    const pdf = flatePdfBytes(expandedText);
    expect(pdf.length).toBeLessThan(COMPILER_HTTP_PDF_BODY_LIMIT_BYTES);
    expect(expandedText.length).toBeGreaterThan(PDF_PREPARE_LIMITS.maxPageTextUtf8Bytes);
    try {
      const response = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/prepare?moduleId=flate-expansion", {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: pdf,
        }),
        dependencies(catalog),
      );
      const responseBody = await response?.json();
      expect(response?.status).toBe(422);
      expect(responseBody).toMatchObject({
        error: { stage: "prepare", code: "PREPARE_RESOURCE_LIMIT_EXCEEDED", limitKind: "page_text_utf8" },
      });
      expect(preparedWrites).toBe(0);
      expect(existsSync(join(root, "prepared"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses 257 pages before text extraction or catalog write", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-pdf-page-limit-"));
    const catalog = new CompilerArtifactCatalog({ root });
    let preparedWrites = 0;
    const savePrevalidatedPrepared = catalog.savePrevalidatedPrepared.bind(catalog);
    (catalog as unknown as { savePrevalidatedPrepared(value: unknown): unknown }).savePrevalidatedPrepared = (value) => {
      preparedWrites++;
      return savePrevalidatedPrepared(value as never);
    };
    const invalidTextPagePdf = manyPagePdf(257);
    let getTextCalls = 0;
    await expect(extractDocumentPagesBounded(invalidTextPagePdf.slice(), {
      maxPages: 256, maxPageTextUtf8Bytes: 512 * 1024, maxTotalTextUtf8Bytes: 8 * 1024 * 1024,
    }, { beforeGetText: () => { getTextCalls++; } })).rejects.toBeInstanceOf(PdfExtractionResourceLimitError);
    expect(getTextCalls).toBe(0);
    try {
      const response = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/prepare?moduleId=page-limit", {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: invalidTextPagePdf,
        }),
        dependencies(catalog),
      );
      expect(response?.status).toBe(422);
      expect(await response?.json()).toMatchObject({ error: { stage: "prepare", code: "PREPARE_RESOURCE_LIMIT_EXCEEDED", limitKind: "pages" } });
      expect(preparedWrites).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses an immutable one-shot validator receipt and rejects forged or replayed receipts", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-pdf-receipt-"));
    const catalog = new CompilerArtifactCatalog({ root });
    try {
      expect(catalog.savePrevalidatedPrepared({} as never).status).toBe("refused");
      const result = await prepareUntrustedPdfCompilerArtifact("receipt-module", flatePdfBytes("Entry:"));
      expect(result.status).toBe("prepared");
      if (result.status !== "prepared") return;
      // This is the public sibling, not the canonical receipt snapshot.
      (result.artifact.payload.identity as { moduleId: string }).moduleId = "tampered";
      const saved = catalog.savePrevalidatedPrepared(result.receipt);
      expect(saved.status).toBe("ok");
      if (saved.status !== "ok") return;
      const loaded = catalog.loadPrepared(saved.value.id);
      expect(loaded.status).toBe("ok");
      if (loaded.status === "ok") expect(loaded.value.identity.moduleId).toBe("receipt-module");
      expect(catalog.savePrevalidatedPrepared(result.receipt).status).toBe("refused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("kills an aborted parser before releasing the sole slot and refuses a full queue", async () => {
    const expansion = flatePdfBytes("A".repeat(4_100_000));
    const activeAbort = new AbortController();
    const active = prepareUntrustedPdfCompilerArtifact("active", expansion.slice(), activeAbort.signal);
    const queuedAborts = Array.from({ length: 4 }, () => new AbortController());
    const queued = queuedAborts.map((controller, index) => prepareUntrustedPdfCompilerArtifact(`queued-${index}`, expansion.slice(), controller.signal));
    const full = await prepareUntrustedPdfCompilerArtifact("full", expansion.slice());
    expect(full.status).toBe("busy");
    // Let the active process accept its bounded stdin before testing process
    // cancellation, rather than racing a Windows pipe creation failure.
    await Bun.sleep(100);
    queuedAborts.forEach((controller) => controller.abort());
    activeAbort.abort();
    expect((await active).status).toBe("unavailable");
    for (const pending of queued) expect((await pending).status).toBe("unavailable");
    // Completion proves the aborted child was reaped before the admission slot
    // was made available to a new parser/validator pair.
    expect((await prepareUntrustedPdfCompilerArtifact("after-abort", flatePdfBytes("Entry:"))).status).toBe("prepared");
  });

  it("fails closed for child timeout, oversized/invalid IPC, and a validator nonce mismatch", async () => {
    const small = flatePdfBytes("Entry:");
    let restore = __replacePdfPrepareWorkerForTest((async () => ({ status: "terminated", reason: "deadline" })) as never);
    try {
      expect(await prepareUntrustedPdfCompilerArtifact("timeout", small.slice())).toMatchObject({
        status: "refused", code: "PREPARE_RESOURCE_LIMIT_EXCEEDED", limitKind: "extract_deadline",
      });
    } finally { restore(); }

    restore = __replacePdfPrepareWorkerForTest((async () => ({ status: "terminated", reason: "output" })) as never);
    try {
      expect(await prepareUntrustedPdfCompilerArtifact("overflow", small.slice())).toMatchObject({
        status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE",
      });
    } finally { restore(); }

    restore = __replacePdfPrepareWorkerForTest((async () => ({ status: "ok", stdout: bytes("{") })) as never);
    try {
      expect(await prepareUntrustedPdfCompilerArtifact("bad-json", small.slice())).toMatchObject({
        status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE",
      });
    } finally { restore(); }

    restore = __replacePdfPrepareWorkerForTest((async (mode: "extract" | "validate", input: Uint8Array) => {
      if (mode === "extract") {
        const documentHash = sha256(input);
        return {
          status: "ok",
          stdout: bytes(JSON.stringify({
            status: "document",
            document: {
              schemaVersion: "1.0.0", documentHash, hashSource: "pdf_bytes_sha256",
              pages: [{ pageNumber: 1, rawText: "Entry:", rawTextHash: sha256("Entry:"), documentHash, hashSource: "pdf_bytes_sha256" }],
            },
          })),
        };
      }
      return { status: "ok", stdout: bytes(JSON.stringify({ status: "prepared", nonce: "wrong", artifact: {} })) };
    }) as never);
    try {
      expect(await prepareUntrustedPdfCompilerArtifact("wrong-nonce", small.slice())).toMatchObject({
        status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE",
      });
    } finally { restore(); }

    restore = __replacePdfPrepareWorkerForTest((async (mode: "extract" | "validate", input: Uint8Array, outputLimit: number, deadline: number, signal: AbortSignal | undefined, fallback: (mode: "extract" | "validate", input: Uint8Array, outputLimit: number, deadline: number, signal?: AbortSignal) => Promise<unknown>) => {
      if (mode === "validate") return fallback(mode, input, outputLimit, deadline, signal);
      const expectedHash = sha256(input);
      const forgedHash = "0".repeat(64);
      return {
        status: "ok",
        stdout: bytes(JSON.stringify({
          status: "document",
          document: {
            schemaVersion: "1.0.0", documentHash: forgedHash, hashSource: "pdf_bytes_sha256",
            pages: [{ pageNumber: 1, rawText: "Entry:", rawTextHash: sha256("Entry:"), documentHash: forgedHash, hashSource: "pdf_bytes_sha256" }],
          },
          expectedHash,
        })),
      };
    }) as never);
    try {
      expect(await prepareUntrustedPdfCompilerArtifact("forged-document-hash", small.slice())).toMatchObject({
        status: "unavailable", code: "PREPARE_ISOLATION_UNAVAILABLE",
      });
    } finally { restore(); }
  });
});
