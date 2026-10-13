import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Source-proposition adapters are research-only. No production module may
 * import them until a human-approved consumer is added to ALLOWLIST. The
 * isolated HTTP facade is the sole exception; it keeps receipts out of game
 * state, SQLite, rules, prompt construction, and the world-model loader.
 */
const ALLOWLIST: readonly string[] = ["api/source-research-http.ts"];
const GUARDED = /from\s+["'][^"']*(source-proposition-loader|reviewed-source-query-adapter|source-research-facade)["']|import\(\s*["'][^"']*(source-proposition-loader|reviewed-source-query-adapter|source-research-facade)["']/;
const SRC = join(import.meta.dir, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

export function guardedImporters(files: readonly string[], read: (path: string) => string): string[] {
  return files
    .map((f) => relative(SRC, f).split(sep).join("/"))
    .filter((rel) => !rel.startsWith("__tests__/"))
    .filter((rel) => !rel.endsWith("source-proposition-loader.ts") && !rel.endsWith("reviewed-source-query-adapter.ts") && !rel.endsWith("source-research-facade.ts"))
    .filter((rel) => GUARDED.test(read(join(SRC, rel))))
    .filter((rel) => !ALLOWLIST.includes(rel));
}

describe("source adapter isolation", () => {
  it("no production module imports a source-proposition adapter", () => {
    expect(guardedImporters(walk(SRC), (p) => readFileSync(p, "utf8"))).toEqual([]);
  });

  it("detects a forbidden import", () => {
    const fake = join(SRC, "engine", "prompt-builder.ts");
    const hits = guardedImporters([fake], () => `import { loadReviewedSourceQueryAdapter } from "../world/reviewed-source-query-adapter";`);
    expect(hits).toEqual(["engine/prompt-builder.ts"]);
  });
});
