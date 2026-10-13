import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { maskSource } from "../diagnostics/source-scan";

function testFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function unawaitedListenerStops(source: string): number[] {
  const masked = maskSource(source).masked;
  const findings: number[] = [];
  for (const [index, line] of masked.split(/\r?\n/).entries()) {
    const calls = /\b(?:server|reservation)\.stop\(true\)\s*;/g;
    for (let match = calls.exec(line); match; match = calls.exec(line)) {
      if (!/\bawait\s*$/.test(line.slice(0, match.index))) findings.push(index + 1);
    }
  }
  return findings;
}

describe("Bun listener teardown policy", () => {
  test("flags only direct listener stops whose Promise is not awaited", () => {
    const source = [
      "server.stop(true);",
      "void reservation.stop(true);",
      "await server.stop(true);",
      "// reservation.stop(true);",
      'const example = "server.stop(true);";',
    ].join("\n");

    expect(unawaitedListenerStops(source)).toEqual([1, 2]);
  });

  test("test sources await every direct Bun Server.stop Promise", () => {
    const root = resolve(import.meta.dir);
    const findings = testFiles(root).flatMap((file) =>
      unawaitedListenerStops(readFileSync(file, "utf8")).map((line) => `${file}:${line}`),
    );

    expect(findings).toEqual([]);
  });
});
