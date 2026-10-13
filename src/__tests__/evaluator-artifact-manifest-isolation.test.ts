import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const MANIFEST = "src/compiler/evaluator-artifact-manifest.ts";

describe("evaluator artifact manifest import isolation", () => {
  it("imports only the pure SHA-256 primitive", () => {
    const source = readFileSync(MANIFEST, "utf8");
    const imports = Array.from(source.matchAll(/\bfrom\s+["']([^"']+)["']/g), (match) => match[1]!);

    expect(imports).toEqual(["node:crypto"]);
  });
});
