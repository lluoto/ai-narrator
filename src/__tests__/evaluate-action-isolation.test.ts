import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const EVALUATOR = "src/compiler/evaluate-action.ts";
const FIXTURE_RUNNER = "src/compiler/evaluate-action-fixtures.ts";

describe("evaluateAction import isolation", () => {
  it("imports only compiler mechanics core modules", () => {
    const source = readFileSync(EVALUATOR, "utf8");
    const imports = Array.from(source.matchAll(/\bfrom\s+["']([^"']+)["']/g), (match) => match[1]!);

    expect(imports).toEqual(["./mechanics-execution", "./mechanics-ir"]);
  });

  it("keeps the fixture runner within evaluator and compiler mechanics modules", () => {
    const source = readFileSync(FIXTURE_RUNNER, "utf8");
    const imports = Array.from(source.matchAll(/\bfrom\s+["']([^"']+)["']/g), (match) => match[1]!);

    expect(imports).toEqual([
      "./evaluate-action",
      "./mechanics-execution",
      "./mechanics-ir",
      "./mechanics-reachability",
    ]);
  });
});
