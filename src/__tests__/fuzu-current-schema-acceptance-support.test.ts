import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  createFuzuAcceptanceAutoAdmission,
  countOpenCompilerQuestions,
} from "../../scripts/fuzu-current-schema-acceptance-support";
import type { CompilerQuestion } from "../compiler/compiler-question-queue";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(label: string): string {
  const value = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.add(value);
  return value;
}

describe("internal Fuzu current-schema acceptance support", () => {
  it("binds automatic admission to this run's temporary catalog root instead of default data", () => {
    const catalogRoot = root("fuzu-acceptance-catalog");
    const defaultDataRoot = resolve("data", "compiler-catalog");
    const before = existsSync(defaultDataRoot) ? readdirSync(defaultDataRoot).sort() : undefined;

    const admission = createFuzuAcceptanceAutoAdmission(catalogRoot);
    expect(admission.root).toBe(resolve(catalogRoot));
    expect(admission.file).toBe(join(resolve(catalogRoot), ".compiler-auto-admission.sqlite"));
    expect(admission.acquire({ principalFingerprint: "a".repeat(64), preparedArtifactId: "prepared-fuzu" }).status).toBe("acquired");
    expect(existsSync(admission.file)).toBe(true);
    expect(existsSync(defaultDataRoot) ? readdirSync(defaultDataRoot).sort() : undefined).toEqual(before);
  });

  it("derives its bounded-progress baseline from real post-hint queue status", () => {
    const questions = [
      ...Array.from({ length: 139 }, () => ({ status: "open" as const })),
      { status: "answered" as const },
      { status: "deferred" as const },
      { status: "not_applicable" as const },
    ] as Pick<CompilerQuestion, "status">[];
    expect(countOpenCompilerQuestions(questions)).toBe(139);
    questions[138] = { status: "answered" };
    expect(countOpenCompilerQuestions(questions)).toBe(138);
  });
});
