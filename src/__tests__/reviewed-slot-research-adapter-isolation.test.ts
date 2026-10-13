import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MODULE = "src/world/reviewed-slot-research-adapter.ts";
const SRC = join(import.meta.dir, "..");
const GUARDED = /from\s+["'][^"']*reviewed-slot-research-adapter["']|import\(\s*["'][^"']*reviewed-slot-research-adapter["']/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function productionImporters(files: readonly string[], read: (path: string) => string): string[] {
  return files
    .map((path) => relative(SRC, path).split(sep).join("/"))
    .filter((path) => !path.startsWith("__tests__/"))
    .filter((path) => path !== "world/reviewed-slot-research-adapter.ts")
    .filter((path) => GUARDED.test(read(join(SRC, path))));
}

describe("reviewed slot research adapter isolation", () => {
  it("depends only on file and hash primitives", () => {
    const source = readFileSync(MODULE, "utf8");
    const imports = Array.from(source.matchAll(/\bfrom\s+["']([^"']+)["']/g), (match) => match[1]!);

    expect(imports).toEqual(["node:crypto", "node:fs", "node:path"]);
  });

  it("is imported only by the isolated slot HTTP facade", () => {
    expect(productionImporters(walk(SRC), (path) => readFileSync(path, "utf8"))).toEqual([
      "api/slot-research-http.ts",
    ]);
  });

  it("detects a forbidden runtime import", () => {
    const fake = join(SRC, "api", "server.ts");
    expect(productionImporters([fake], () => 'import { loadReviewedSlotResearchAdapter } from "../world/reviewed-slot-research-adapter";'))
      .toEqual(["api/server.ts"]);
  });
});
