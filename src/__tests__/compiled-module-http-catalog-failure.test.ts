import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleCompiledModuleHttpRequest, type CompiledModuleHttpDependencies } from "../api/compiled-module-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";

function pdf(text: string): Uint8Array {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", `<< /Length ${stream.length} >>\nstream\n${stream}endstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let output = "%PDF-1.4\n"; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(output.length); output += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = output.length; output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new TextEncoder().encode(output);
}

describe("compiled module HTTP catalog coordination failures", () => {
  it("maps a busy catalog to a bounded retryable 503 and policy disagreement to a server error", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-catalog-failure-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const dependencies = {
        catalog,
        authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: "operator:test", role: "operator" } }),
      } as unknown as CompiledModuleHttpDependencies;
      const load = catalog.loadPrepared.bind(catalog);
      (catalog as unknown as { loadPrepared(id: string): unknown }).loadPrepared = () => ({ status: "refused", code: "CATALOG_BUSY", message: "catalog publication is busy" });
      const busy = await handleCompiledModuleHttpRequest(new Request(`http://test/api/compiler/artifacts/${"a".repeat(24)}`), dependencies);
      expect(busy?.status).toBe(503);
      expect(busy?.headers.get("Retry-After")).toBe("1");
      expect(await busy?.json()).toMatchObject({ error: { code: "CATALOG_BUSY" } });

      (catalog as unknown as { loadPrepared(id: string): unknown }).loadPrepared = () => ({ status: "refused", code: "CATALOG_POLICY_MISMATCH", message: "deployment policy differs" });
      const mismatch = await handleCompiledModuleHttpRequest(new Request(`http://test/api/compiler/artifacts/${"a".repeat(24)}`), dependencies);
      expect(mismatch?.status).toBe(500);
      expect(mismatch?.headers.get("Retry-After")).toBeNull();
      expect(await mismatch?.json()).toMatchObject({ error: { code: "CATALOG_POLICY_MISMATCH" } });
      (catalog as unknown as { loadPrepared(id: string): unknown }).loadPrepared = load;
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("maps an indeterminate catalog write to minimal retryable recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-catalog-indeterminate-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      // The untrusted-PDF boundary validates in an isolated child and hands
      // the catalog a private receipt.  Fault the actual receipt-consuming
      // publication seam, not the legacy direct-artifact helper.
      (catalog as unknown as { savePrevalidatedPrepared(value: unknown): unknown }).savePrevalidatedPrepared = () => ({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE", message: "sync uncertain", recovery: { stage: "prepared", id: "a".repeat(24) } });
      const dependencies = { catalog, authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: "operator:test", role: "operator" } }) } as unknown as CompiledModuleHttpDependencies;
      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/prepare?moduleId=indeterminate", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf("Entry: catalog recovery") }), dependencies);
      expect(response?.status).toBe(503); expect(response?.headers.get("Retry-After")).toBe("1");
      const body = await response?.json() as any;
      expect(body).toMatchObject({ error: { code: "CATALOG_DURABILITY_INDETERMINATE", recovery: { stage: "prepared", id: "a".repeat(24) } } });
      expect(JSON.stringify(body)).not.toMatch(/hints|review|source|hash/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
