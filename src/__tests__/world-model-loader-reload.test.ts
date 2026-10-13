import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { sharedWorldModel, WorldModelLoader } from "../world/world-model-loader";

const fixtureRoot = mkdtempSync(join(tmpdir(), "world-model-loader-reload-"));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeJsonl(name: string, rows: unknown[]): string {
  const path = join(fixtureRoot, name);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return path;
}

function consumedCount(loader: WorldModelLoader): number {
  return (loader as unknown as { consumedIndices: Set<number> }).consumedIndices.size;
}

function ignoresFrozenMutation(mutator: () => void): void {
  try {
    mutator();
  } catch {
    // Bun modules run in strict mode: frozen writes may throw. Both a throw and
    // a no-op are acceptable; the assertions after each attempt are the contract.
  }
}

describe("WorldModelLoader reload isolation", () => {
  it("atomically replaces every index when a loader is pointed at another valid model", () => {
    const modelA = writeJsonl("model-a.jsonl", [{
      type: "causal", chapter: "a1", novel: "novel-a", name: "A causal",
      description: "astrolabe signal", _version: "a", game_rule: true,
      dnd_mapping: "A mapping", hallucination_risk: true,
    }]);
    const modelB = writeJsonl("model-b.jsonl", [{
      type: "behavior", chapter: "b1", novel: "novel-b", name: "B behavior",
      description: "verdigris response", _version: "b",
    }]);
    const loader = new WorldModelLoader();

    loader.load(modelA);
    expect(loader.isLoaded()).toBe(true);
    expect(loader.queryCausal(["astrolabe"])).toHaveLength(1);
    expect(loader.getDndRules()).toHaveLength(1);
    expect(loader.getDndMappings()).toHaveLength(1);
    expect(loader.getStats().hallucinationRisky).toBe(1);

    loader.load(modelB);
    expect(loader.isLoaded()).toBe(true);
    expect(loader.getAll().map((entry) => entry.name)).toEqual(["B behavior"]);
    expect(loader.getByNovel("novel-a")).toEqual([]);
    expect(loader.getByType("causal")).toEqual([]);
    expect(loader.queryCausal(["astrolabe"])).toEqual([]);
    expect(loader.search(["astrolabe"])).toEqual([]);
    expect(loader.getDndRules()).toEqual([]);
    expect(loader.getDndMappings()).toEqual([]);
    expect(loader.getStats()).toMatchObject({
      total: 1,
      byNovel: { "novel-b": 1 },
      byType: { behavior: 1 },
      byVersion: { b: 1 },
      dndGameRules: 0,
      dndMappings: 0,
      hallucinationRisky: 0,
    });
  });

  it("fails closed for a missing or malformed replacement instead of serving the prior model", () => {
    const model = writeJsonl("good.jsonl", [{
      type: "causal", chapter: "1", novel: "good", name: "Good entry", description: "signal",
    }]);
    const malformed = join(fixtureRoot, "malformed.jsonl");
    writeFileSync(malformed, 'not json\n{"type":"behavior","novel":"missing chapter"}\n', "utf8");
    const loader = new WorldModelLoader();

    loader.load(model);
    expect(loader.isLoaded()).toBe(true);
    loader.load(join(fixtureRoot, "missing.jsonl"));
    expect(loader.isLoaded()).toBe(false);
    expect(loader.getAll()).toEqual([]);
    expect(loader.getStats().total).toBe(0);

    loader.load(model);
    expect(loader.isLoaded()).toBe(true);
    loader.load(malformed);
    expect(loader.isLoaded()).toBe(false);
    expect(loader.getAll()).toEqual([]);
    expect(loader.getByNovel("good")).toEqual([]);
  });

  it("rejects all-whitespace required fields and clears consumption state", () => {
    const good = writeJsonl("whitespace-good.jsonl", [{
      type: "causal", chapter: "1", novel: "good", name: "Good entry",
    }]);
    const whitespaceOnly = writeJsonl("whitespace-only.jsonl", [
      { type: " \t", chapter: "1", novel: "invalid-type" },
      { type: "causal", chapter: "\t ", novel: "invalid-chapter" },
    ]);
    const loader = new WorldModelLoader();

    loader.load(good);
    loader.consumeCausal({});
    expect(consumedCount(loader)).toBe(1);

    loader.load(whitespaceOnly);
    expect(loader.isLoaded()).toBe(false);
    expect(loader.getAll()).toEqual([]);
    expect(consumedCount(loader)).toBe(0);
  });

  it("clears consumption state when a readable path cannot be read as a model", () => {
    const good = writeJsonl("directory-good.jsonl", [{
      type: "causal", chapter: "1", novel: "good", name: "Good entry",
    }]);
    const loader = new WorldModelLoader();

    loader.load(good);
    loader.consumeCausal({});
    expect(consumedCount(loader)).toBe(1);

    expect(() => loader.load(fixtureRoot)).not.toThrow();
    expect(loader.isLoaded()).toBe(false);
    expect(loader.getAll()).toEqual([]);
    expect(consumedCount(loader)).toBe(0);
  });

  it("shares a single loader for the same local resource path", () => {
    const path = writeJsonl("shared.jsonl", [{ type: "scene", chapter: "1", novel: "shared" }]);
    expect(sharedWorldModel(path)).toBe(sharedWorldModel(path));
  });

  it("keeps a shared loader pinned to its factory source without clearing live data", () => {
    const sourceA = writeJsonl("shared-pinned-a.jsonl", [{
      type: "causal", chapter: "1", novel: "shared-pinned", name: "Source A",
    }]);
    const sourceB = writeJsonl("shared-pinned-b.jsonl", [{
      type: "causal", chapter: "1", novel: "shared-pinned", name: "Source B",
    }]);
    const firstObserver = sharedWorldModel(sourceA);
    const secondObserver = sharedWorldModel(sourceA);

    firstObserver.load(sourceA);
    expect(firstObserver.getAll().map((entry) => entry.name)).toEqual(["Source A"]);
    expect(secondObserver.getAll().map((entry) => entry.name)).toEqual(["Source A"]);

    expect(() => firstObserver.load(sourceB)).toThrow("shared world-model loader is pinned to its source");
    expect(firstObserver.isLoaded()).toBe(true);
    expect(firstObserver.getAll().map((entry) => entry.name)).toEqual(["Source A"]);
    expect(secondObserver.isLoaded()).toBe(true);
    expect(secondObserver.getAll().map((entry) => entry.name)).toEqual(["Source A"]);
  });

  it("keeps shared JSON-derived entries and every index read-only for unsafe JavaScript consumers", () => {
    const path = writeJsonl("shared-read-only.jsonl", [{
      type: "causal",
      chapter: "1",
      novel: "shared-read-only",
      name: "Untampered causal",
      description: "signal remains searchable",
      properties: { tag: "stable" },
      untyped_nested: { tag: "nested-stable", labels: ["stable"] },
    }]);
    const first = sharedWorldModel(path);
    first.load(path);
    const second = sharedWorldModel(path);
    expect(second).toBe(first);

    const unsafeBucket = first.getByType("causal") as unknown as Array<Record<string, unknown>>;
    const removed = unsafeBucket[0];
    ignoresFrozenMutation(() => { unsafeBucket.pop(); });
    expect(first.getByType("causal")).toHaveLength(1);
    ignoresFrozenMutation(() => { unsafeBucket.push(removed); });
    expect(first.getByType("causal")).toHaveLength(1);

    const unsafeEntry = first.getAll()[0] as unknown as {
      name: string;
      properties: { tag: string };
      untyped_nested: { tag: string; labels: string[] };
    };
    ignoresFrozenMutation(() => { unsafeEntry.name = "tampered name"; });
    ignoresFrozenMutation(() => { unsafeEntry.properties.tag = "tampered property"; });
    ignoresFrozenMutation(() => { unsafeEntry.untyped_nested.tag = "tampered nested object"; });
    ignoresFrozenMutation(() => { unsafeEntry.untyped_nested.labels[0] = "tampered nested array"; });

    for (const consumer of [first, second]) {
      expect(consumer.getAll()).toHaveLength(1);
      expect(consumer.getByType("causal")).toHaveLength(1);
      expect(consumer.getByNovel("shared-read-only")).toHaveLength(1);
      expect(consumer.search(["signal"], "shared-read-only", "causal").map(({ entry }) => entry.name))
        .toEqual(["Untampered causal"]);
      expect(consumer.getStats()).toMatchObject({
        total: 1,
        byNovel: { "shared-read-only": 1 },
        byType: { causal: 1 },
      });
      const entry = consumer.getAll()[0] as unknown as {
        name: string;
        properties: { tag: string };
        untyped_nested: { tag: string; labels: string[] };
      };
      expect(entry).toMatchObject({
        name: "Untampered causal",
        properties: { tag: "stable" },
        untyped_nested: { tag: "nested-stable", labels: ["stable"] },
      });
    }
  });

  it("shares one loader for normalized aliases of the same local model path", () => {
    const basename = "shared-alias.jsonl";
    const model = writeJsonl(basename, [{ type: "scene", chapter: "1", novel: "shared-alias" }]);
    const nested = join(fixtureRoot, "shared-alias-nested");
    mkdirSync(nested);
    // node:path.join normalizes `..`, so retain it in the supplied path string
    // while independently proving it resolves to the same local resource.
    const alias = `${nested}${sep}..${sep}${basename}`;
    expect(resolve(alias)).toBe(resolve(model));
    expect(existsSync(alias)).toBe(true);

    const first = sharedWorldModel(model);
    first.load(alias);
    const second = sharedWorldModel(alias);
    expect(second).toBe(first);
    expect(second.getStats().total).toBe(1);
  });
});
