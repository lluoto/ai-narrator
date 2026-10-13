// This sentinel prevents known Barn representation regressions:
// - old wrapper files/symbols, registry indirection, and transition fields;
// - Barn loading through the legacy MythosModule path.
// It cannot discover a renamed semantic duplicate, external repository data,
// or a duplicate generated dynamically outside these checked source files.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { GameSession } from "../api/game-session";
import { findReverseImports, importPointsTo, maskSource, scanImports } from "../diagnostics/source-scan";

const LEGACY_WRAPPER = "src/rules/custom-modules/premiers_barn.ts";
const TRANSITION_FIELDS = ["loaderSceneDescriptions", "loaderExits", "clueBindings"];
const RETIRED_SYMBOLS = ["MODULE_PREMIERS_BARN", "PREMIERS_BARN_MODULE", "deriveMythosModule"];
const BARN_ONLY_LEGACY_IDENTIFIERS = ["bridgeBarnOfPremierClues", "barnSceneIdMap"];
const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 512, temperature: 0.7 };

function source(file: string): string {
  return readFileSync(file, "utf8");
}

function containsRuntimeField(sourceText: string, field: string): boolean {
  const masked = maskSource(sourceText).masked;
  if (masked.includes(field)) return true;
  const quoted = new RegExp(`["']${field}["']\\s*:`, "g");
  for (const match of sourceText.matchAll(quoted)) {
    const colon = (match.index ?? 0) + match[0].lastIndexOf(":");
    if (masked[colon] === ":") return true;
  }
  return false;
}

function productionFiles(): string[] {
  const files = Array.from(new Bun.Glob("{src,scripts}/**/*.ts").scanSync("."));
  if (files.length < 100) throw new Error("source scan input is unexpectedly incomplete");
  return files.filter((file) => !file.replaceAll("\\", "/").includes("/__tests__/"));
}

describe("Barn unification resurrection sentinels", () => {
  it("registry imports BARN_OF_PREMIER directly and cannot load the removed wrapper", () => {
    expect(existsSync(LEGACY_WRAPPER)).toBe(false);
    const imports = scanImports(source("src/rules/custom-modules/index.ts"));
    expect(imports.some((entry) => importPointsTo(entry.path, "barn-of-premier"))).toBe(true);
    expect(imports.some((entry) => importPointsTo(entry.path, "premiers_barn"))).toBe(false);
    expect(imports.some((entry) => importPointsTo(entry.path, "unified-module"))).toBe(false);
  });

  it("production import graph has no old Barn adapter consumer or retired symbol", () => {
    const files = productionFiles();
    const adapterImports = files.flatMap((file) => findReverseImports(file, source(file), "premiers_barn"));
    expect(adapterImports).toEqual([]);
    for (const symbol of RETIRED_SYMBOLS) {
      const symbolUsers = files.filter((file) => new RegExp(`\\b${symbol}\\b`).test(maskSource(source(file)).masked));
      expect(symbolUsers).toEqual([]);
    }
  });

  it("transition scene graph and clue binding fields cannot return to type, data, or loader", () => {
    for (const file of ["src/module/runtime-types.ts", "src/module/barn-of-premier.ts", "src/module/module-data-runtime-loader.ts"]) {
      for (const field of TRANSITION_FIELDS) expect(containsRuntimeField(source(file), field)).toBe(false);
    }
  });

  it("Barn GameSession path and direct loader never import the adapter", () => {
    for (const file of ["src/api/game-session.ts", "src/module/module-data-runtime-loader.ts"]) {
      const imports = scanImports(source(file));
      expect(imports.some((entry) => importPointsTo(entry.path, "premiers_barn"))).toBe(false);
    }
  });

  it("Barn load never constructs the legacy loader or revives Barn-only bridges", async () => {
    const session = new GameSession("barn-single-source-sentinel", "cosmic-horror", CONFIG, undefined, "调查员");
    await session.act("创建角色 investigator 甲");
    const loaded = await session.act("加载模组 普瑞米尔的谷仓");
    expect(Reflect.ownKeys(session)).not.toContain("_moduleLoader");
    expect(loaded.events.map((event) => event.content).join("\n")).toContain("【统一模组：普瑞米尔的谷仓】");
    const gameSessionSource = maskSource(source("src/api/game-session.ts")).masked;
    for (const identifier of BARN_ONLY_LEGACY_IDENTIFIERS) expect(gameSessionSource).not.toMatch(new RegExp(`\\b${identifier}\\b`));
  });

  it("mutation model: a registry import of the wrapper is detected", () => {
    const mutatedRegistry = 'import { MODULE_PREMIERS_BARN } from "./premiers_barn";';
    const imports = scanImports(mutatedRegistry);
    expect(imports.some((entry) => importPointsTo(entry.path, "premiers_barn"))).toBe(true);
  });

  it("mutation model: a wrapped registry value loses object identity", () => {
    const sourceModule = { id: "premiers_barn" };
    const wrapped = { ...sourceModule };
    expect(wrapped).not.toBe(sourceModule);
  });

  it("mutation model: restoring loaderExits to runtime data is detected", () => {
    const mutatedBarn = 'const runtime = { "loaderExits": {} };';
    expect(containsRuntimeField(mutatedBarn, "loaderExits")).toBe(true);
  });
});
