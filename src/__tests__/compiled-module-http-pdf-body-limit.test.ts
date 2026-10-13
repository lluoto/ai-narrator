import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleCompiledModuleHttpRequest, COMPILER_HTTP_BODY_LIMIT_BYTES, COMPILER_HTTP_PDF_BODY_LIMIT_BYTES } from "../api/compiled-module-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";

function dependencies(catalog: CompilerArtifactCatalog) {
  return {
    catalog,
    createSession: () => { throw new Error("session creation is outside this body-limit test"); },
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => undefined,
    generateId: () => "body-limit-test",
    authenticateCompilerRequest: () => ({ status: "authenticated" as const, principal: { id: "body-limit-test", role: "operator" as const } }),
  };
}

function unknownLengthStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

describe("compiled module HTTP PDF body limit", () => {
  it("rejects a declared PDF over the dedicated cap before catalog write", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-pdf-limit-"));
    const catalog = new CompilerArtifactCatalog({ root });
    let writes = 0;
    const savePrepared = catalog.savePrepared.bind(catalog);
    (catalog as unknown as { savePrepared(value: unknown): unknown }).savePrepared = (value) => {
      writes++;
      return savePrepared(value);
    };
    try {
      const response = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/prepare?moduleId=too-large", {
          method: "POST",
          headers: { "Content-Type": "application/pdf", "Content-Length": String(COMPILER_HTTP_PDF_BODY_LIMIT_BYTES + 1) },
          body: new Uint8Array([0x25]),
        }),
        dependencies(catalog),
      );
      expect(response?.status).toBe(413);
      expect(await response?.json()).toMatchObject({ error: { stage: "prepare", code: "BODY_TOO_LARGE" } });
      expect(writes).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown-length PDF over the dedicated cap before compiler completion or catalog write", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-pdf-stream-limit-"));
    const catalog = new CompilerArtifactCatalog({ root });
    let writes = 0;
    const savePrepared = catalog.savePrepared.bind(catalog);
    (catalog as unknown as { savePrepared(value: unknown): unknown }).savePrepared = (value) => {
      writes++;
      return savePrepared(value);
    };
    try {
      const response = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/prepare?moduleId=too-large-stream", {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: unknownLengthStream(new Uint8Array(COMPILER_HTTP_PDF_BODY_LIMIT_BYTES), new Uint8Array([0x20])),
        }),
        dependencies(catalog),
      );
      // The stream is not a valid PDF. A body-gate regression would therefore
      // enter the real compiler and yield a non-413 compiler refusal instead.
      expect(response?.status).toBe(413);
      expect(await response?.json()).toMatchObject({ error: { stage: "prepare", code: "BODY_TOO_LARGE" } });
      expect(writes).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the JSON/general cap at one mebibyte", async () => {
    expect(COMPILER_HTTP_BODY_LIMIT_BYTES).toBe(1024 * 1024);
    expect(COMPILER_HTTP_PDF_BODY_LIMIT_BYTES).toBe(8 * 1024 * 1024);
    const root = mkdtempSync(join(tmpdir(), "compiled-http-json-limit-"));
    try {
      const response = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": String(COMPILER_HTTP_BODY_LIMIT_BYTES + 1) },
          body: "{}",
        }),
        dependencies(new CompilerArtifactCatalog({ root })),
      );
      expect(response?.status).toBe(413);
      expect(await response?.json()).toMatchObject({ error: { stage: "resolve", code: "BODY_TOO_LARGE" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
