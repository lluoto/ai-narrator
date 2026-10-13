import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { handleCompiledModuleHttpRequest, type CompiledModuleHttpDependencies } from "../api/compiled-module-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import {
  buildCompiledCthulhuWorldModelContext,
  createCompiledCthulhuWorldModelBinding,
  type CompiledCthulhuWorldModelBindingInput,
} from "../world/compiled-world-model-scope";
import { selectLoreCandidates } from "../dataset/cthulhu-dataset";
import { CTHULHU_DATASET_MANIFEST } from "../dataset/cthulhu-manifest";
import { WorldModelLoader } from "../world/world-model-loader";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { isolatedProviderSeamIt } from "./helpers/provider-seam-child";

const CONFIG = { apiKey: "", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const KP_CAPTURE_CONFIG = { ...CONFIG, apiKey: "test-kp-capture-key" };
const BARN_COMMAND = "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3";
const ownedSessions: GameSession[] = [];

function ownSession<T extends GameSession>(session: T): T {
  ownedSessions.push(session);
  return session;
}

/** Test-local trusted runtime references; request/module data never choose these. */
function legacyReferenceDependencies(
  worldModelNovel: string | undefined,
  worldModelLoader?: WorldModelLoader,
  cthulhuWorldModelLoader?: WorldModelLoader,
) {
  return { worldModelNovel, worldModelLoader, cthulhuWorldModelLoader };
}

function rawLoader(overrides: Record<string, unknown> = {}): WorldModelLoader {
  return Object.assign(new WorldModelLoader(), overrides);
}

afterEach(() => {
  const closing = ownedSessions.splice(0);
  let closeFailure: unknown;
  for (const session of closing) {
    try {
      session.close();
    } catch (error) {
      closeFailure ??= error;
    }
  }
  if (closeFailure !== undefined) throw closeFailure;
});
const DATASET_ROOT = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";

/**
 * Exercise the real KP request boundary without patching a session child. The
 * local response is deterministic and restored in finally, so this never
 * reaches the configured provider while preserving the exact prompt capture.
 */
async function captureOpeningWorldModelContext(open: () => Promise<unknown>): Promise<string> {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ messages?: Array<{ role?: unknown; content?: unknown }> }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("KP request body was not JSON text");
    requests.push(JSON.parse(init.body) as { messages?: Array<{ role?: unknown; content?: unknown }> });
    return new Response(JSON.stringify({ choices: [{ message: { content: "deterministic KP capture" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await open();
  } finally {
    globalThis.fetch = previousFetch;
  }
  expect(requests).toHaveLength(1);
  const systemContents = (requests[0]?.messages ?? [])
    .filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => message.content as string);
  // LLMClient coalesces adjacent system frames. KPAgent's directive ends at
  // the style line, so what follows is exactly the session-owned context.
  const merged = systemContents.join("\n");
  const directiveStart = merged.lastIndexOf("\n叙事风格: standard");
  if (directiveStart < 0) {
    throw new Error("KP capture did not contain its directive boundary");
  }
  const directiveEnd = merged.indexOf("\n", directiveStart + 1);
  return merged.slice(directiveEnd < 0 ? merged.length : directiveEnd + 1).trim();
}

async function bundleFor(
  catalog: CompilerArtifactCatalog,
  moduleId: string,
  workId: "the_call_of_cthulhu" | "the_dunwich_horror",
) {
  const fixture = await compiledModuleHttpFixture(moduleId);
  const binding = createCompiledCthulhuWorldModelBinding({
    moduleId,
    artifactHash: fixture.resolved.artifact.artifactHash,
    datasetRoot: DATASET_ROOT,
    allowedWorkIds: [workId],
    transferPolicy: "analogy_only",
  });
  const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection, binding);
  if (saved.status !== "ok") throw new Error(saved.message);
  const loaded = catalog.loadBundle(saved.value.id);
  if (loaded.status !== "ok") throw new Error(loaded.message);
  return { fixture, binding, saved: saved.value, bundle: loaded.value };
}

const providerSeamIt = isolatedProviderSeamIt("src/__tests__/compiled-world-model-scope.test.ts");

describe("compiled world-model scope", () => {
  it("keeps actual Cthulhu candidates and prompt provenance inside each module work scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-world-model-scope-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const a = await bundleFor(catalog, "scope-a", "the_call_of_cthulhu");
      const b = await bundleFor(catalog, "scope-b", "the_dunwich_horror");

      const aContext = buildCompiledCthulhuWorldModelContext(a.binding, { keywords: ["Cthulhu", "dream"] });
      const bContext = buildCompiledCthulhuWorldModelContext(b.binding, { keywords: ["stone", "Old Ones"] });

      expect(aContext.text).toContain("Cthulhu");
      expect(aContext.text).not.toContain("Ritual of the Stone Circles");
      expect(new Set(aContext.provenance.map((entry) => entry.workId))).toEqual(new Set(["the_call_of_cthulhu"]));
      expect(bContext.text).toContain("Ritual of the Stone Circles");
      expect(bContext.text).not.toContain("Cthulhu Cult Chant");
      expect(new Set(bContext.provenance.map((entry) => entry.workId))).toEqual(new Set(["the_dunwich_horror"]));

      const session = ownSession(new GameSession("scope-a-session", "cosmic-horror", CONFIG, "investigator", "Ada"));
      expect(session.loadDurableCompiledModule(a.bundle).status).toBe("loaded");
      await session.getOpeningScene();
      expect(session.getCompiledWorldModelPromptReceipt()).toEqual(expect.objectContaining({ scopeHash: a.binding.scopeHash }));
      expect(session.getCompiledWorldModelPromptReceipt()?.provenance.every((entry) => entry.workId === "the_call_of_cthulhu")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for a missing binding, cross-module binding, and a bundle/scope hash substitution during restore", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-world-model-tamper-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const a = await bundleFor(catalog, "scope-tamper-a", "the_call_of_cthulhu");
      const b = await bundleFor(catalog, "scope-tamper-b", "the_dunwich_horror");

      const unbound = catalog.saveBundle(a.fixture.resolved.artifact, a.fixture.projection);
      expect(unbound.status).toBe("ok");
      if (unbound.status !== "ok") return;
      const unboundLoaded = catalog.loadBundle(unbound.value.id);
      expect(unboundLoaded.status).toBe("ok");
      if (unboundLoaded.status !== "ok") return;
      let v18LoadAttempts = 0;
      let aggregateCthulhuLoadAttempts = 0;
      // These real local loaders retain their injected aliases and fail if a
      // compiled-but-unbound session reaches legacy reference data.
      const unboundV18 = rawLoader({ isLoaded: () => { v18LoadAttempts++; throw new Error("v18 must not load for an unbound compiled session"); } });
      const unboundCthulhu = rawLoader({ isLoaded: () => { aggregateCthulhuLoadAttempts++; throw new Error("aggregate Cthulhu must not load for an unbound compiled session"); } });
      const unboundSession = ownSession(new GameSession(
        "scope-unbound", "cosmic-horror", CONFIG, "investigator", "Ada",
        undefined, undefined, undefined, undefined,
        legacyReferenceDependencies(undefined, unboundV18, unboundCthulhu),
      ));
      expect(unboundSession.loadDurableCompiledModule(unboundLoaded.value).status).toBe("loaded");
      await unboundSession.getOpeningScene();
      expect(v18LoadAttempts).toBe(0);
      expect(aggregateCthulhuLoadAttempts).toBe(0);
      expect(unboundSession.getCompiledWorldModelPromptReceipt()).toBeNull();

      const crossModule = catalog.saveBundle(a.fixture.resolved.artifact, a.fixture.projection, b.binding);
      expect(crossModule.status).toBe("refused");

      // Identity rejection intentionally precedes any filesystem-backed
      // dataset validation. An invalid root would otherwise mask the attack.
      const wrongIdentity = structuredClone(b.binding);
      wrongIdentity.datasetRoot = join(root, "does-not-exist");
      const rejectedBeforeDatasetLoad = catalog.saveBundle(a.fixture.resolved.artifact, a.fixture.projection, wrongIdentity);
      expect(rejectedBeforeDatasetLoad).toMatchObject({ status: "refused", message: "world-model binding does not match artifact identity" });

      const host = createCompiledDurableTestHost();
      const source = ownSession(new GameSession("scope-restore", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, undefined, undefined, undefined, host.runtimeDependencies));
      expect(source.loadDurableCompiledModule(a.bundle).status).toBe("loaded");
      const snapshot = host.snapshot(source);
      const forged = structuredClone(a.bundle);
      forged.worldModelBinding = b.binding;
      const restored = ownSession(new GameSession("scope-restore", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, undefined, undefined, undefined, host.runtimeDependencies));
      expect(restored.restoreCompiledSession(snapshot, forged).status).toBe("refused");

      const path = join(root, "catalog", "bundles", `${a.saved.id}.json`);
      const persisted = JSON.parse(readFileSync(path, "utf8"));
      persisted.worldModelBinding.allowedWorkIds = ["the_dunwich_horror"];
      writeFileSync(path, JSON.stringify(persisted));
      expect(catalog.loadBundle(a.saved.id).status).toBe("refused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  providerSeamIt("keeps unscoped ordinary sessions away from both legacy global loaders and keeps catalog binding roots off HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-world-model-public-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const a = await bundleFor(catalog, "scope-public-a", "the_call_of_cthulhu");
      let v18Accesses = 0;
      let aggregateAccesses = 0;
      const ordinaryV18 = rawLoader({ isLoaded: () => { v18Accesses += 1; throw new Error("unscoped ordinary session must not access v18"); } });
      const ordinaryCthulhu = rawLoader({ isLoaded: () => { aggregateAccesses += 1; throw new Error("unscoped ordinary session must not access aggregate Cthulhu"); } });
      const ordinary = ownSession(new GameSession(
        "scope-ordinary", "cosmic-horror", KP_CAPTURE_CONFIG, "investigator", "Ada",
        undefined, undefined, undefined, undefined,
        legacyReferenceDependencies(undefined, ordinaryV18, ordinaryCthulhu),
      ));
      const observedContext = await captureOpeningWorldModelContext(() => ordinary.getOpeningScene());
      expect(observedContext).toBe("");
      expect(v18Accesses).toBe(0);
      expect(aggregateAccesses).toBe(0);

      const response = await handleCompiledModuleHttpRequest(
        new Request(`http://test/api/compiler/bundles/${a.saved.id}`),
        {
          catalog,
          authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: "scope-test", role: "operator" } }),
        } as unknown as CompiledModuleHttpDependencies,
      );
      expect(response?.status).toBe(200);
      const publicBundle = await response?.json() as Record<string, unknown>;
      expect(publicBundle.worldModelBinding).toBeUndefined();
      expect(JSON.stringify(publicBundle)).not.toContain(a.binding.datasetRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a sorted, unique allowed-work scope before signing", () => {
    expect(() => createCompiledCthulhuWorldModelBinding({
      moduleId: "scope-canonical",
      artifactHash: "a".repeat(64),
      datasetRoot: DATASET_ROOT,
      allowedWorkIds: ["the_dunwich_horror", "the_call_of_cthulhu"],
      transferPolicy: "analogy_only",
    })).toThrow("sorted and unique");
    expect(() => createCompiledCthulhuWorldModelBinding({
      moduleId: "scope-canonical",
      artifactHash: "a".repeat(64),
      datasetRoot: DATASET_ROOT,
      allowedWorkIds: ["the_call_of_cthulhu", "the_call_of_cthulhu"],
      transferPolicy: "analogy_only",
    })).toThrow("sorted and unique");
  });

  it("validates an optional single-work corpus scope without broadening candidate selection", () => {
    const input: CompiledCthulhuWorldModelBindingInput = {
      moduleId: "scope-single-work-corpus",
      artifactHash: "a".repeat(64),
      datasetRoot: DATASET_ROOT,
      allowedWorkIds: ["the_call_of_cthulhu"],
      transferPolicy: "analogy_only",
    };

    expect(() => createCompiledCthulhuWorldModelBinding({
      ...input,
      corpusScopeId: "not-in-manifest",
    })).toThrow("corpusScopeId");

    const binding = createCompiledCthulhuWorldModelBinding({
      ...input,
      corpusScopeId: "seven-work-corpus",
    });
    const context = buildCompiledCthulhuWorldModelContext(binding, { keywords: ["Cthulhu", "dream"] });
    expect(context.provenance.length).toBeGreaterThan(0);
    expect(new Set(context.provenance.map((entry) => entry.workId))).toEqual(new Set(["the_call_of_cthulhu"]));

    const otherWorkOnlyCorpus = structuredClone(CTHULHU_DATASET_MANIFEST);
    otherWorkOnlyCorpus.corpusScopes = [{
      id: "dunwich-only",
      allowedWorkIds: ["the_dunwich_horror"],
    }];
    expect(() => selectLoreCandidates(otherWorkOnlyCorpus, {
      domain: "cosmology",
      allowedWorkIds: ["the_call_of_cthulhu"],
      corpusScopeId: "dunwich-only",
      transferPolicy: "analogy_only",
    }, { candidates: [] })).toThrow("corpus scope does not allow all requested works");
  });

  providerSeamIt("scopes ordinary GameSession world-model context to one exact legacy novel", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-world-model-scope-"));
    try {
      const v18Path = join(root, "v18.jsonl");
      const cthulhuPath = join(root, "cthulhu.jsonl");
      writeFileSync(v18Path, [
        { type: "faction_relation", chapter: "1", novel: "work-a", name: "A v18 relation", description: "\u7279\u91cc\u574e\u5bb6 A-only" },
        { type: "faction_relation", chapter: "1", novel: "work-b", name: "B v18 relation", description: "\u7279\u91cc\u574e\u5bb6 B-only" },
      ].map((row) => JSON.stringify(row)).join("\n"), "utf8");
      writeFileSync(cthulhuPath, [
        { type: "deity", chapter: "1", novel: "work-a", name: "A aggregate deity", mechanic: "A-only" },
        { type: "deity", chapter: "1", novel: "work-b", name: "B aggregate deity", mechanic: "B-only" },
      ].map((row) => JSON.stringify(row)).join("\n"), "utf8");
      const v18 = new WorldModelLoader();
      const aggregate = new WorldModelLoader();
      v18.load(v18Path);
      aggregate.load(cthulhuPath);

      const session = new GameSession(
        "ordinary-exact-scope", "cosmic-horror", KP_CAPTURE_CONFIG,
        undefined, undefined, undefined, undefined, undefined, undefined,
        legacyReferenceDependencies("work-a", v18, aggregate),
      );
      ownSession(session);
      expect((await session.act(BARN_COMMAND)).error).toBeUndefined();
      expect(session.getDisplayedScene()).toBe("\u7279\u91cc\u574e\u5bb6");
      const observedContext = await captureOpeningWorldModelContext(() => session.getOpeningScene());
      expect(observedContext).toContain("A v18 relation");
      expect(observedContext).toContain("A aggregate deity");
      expect(observedContext).not.toContain("B v18 relation");
      expect(observedContext).not.toContain("B aggregate deity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  providerSeamIt("fails closed before loading legacy models for absent, blank, or padded ordinary scopes", async () => {
    for (const scope of [undefined, "", "   ", " work-a "]) {
      let v18Accesses = 0;
      let aggregateAccesses = 0;
      const v18 = rawLoader({ isLoaded: () => { v18Accesses += 1; throw new Error("invalid scope reached v18"); } });
      const aggregate = rawLoader({ isLoaded: () => { aggregateAccesses += 1; throw new Error("invalid scope reached aggregate"); } });
      const session = ownSession(new GameSession(
        `ordinary-invalid-scope-${String(scope)}`, "cosmic-horror", KP_CAPTURE_CONFIG,
        undefined, undefined, undefined, undefined, undefined, undefined,
        legacyReferenceDependencies(scope, v18, aggregate),
      ));
      const observedContext = await captureOpeningWorldModelContext(() => session.getOpeningScene());
      expect(observedContext).toBe("");
      expect(v18Accesses).toBe(0);
      expect(aggregateAccesses).toBe(0);
    }
  });

  providerSeamIt("does not touch aggregate Cthulhu when an ordinary scope is unknown, mixed, or missing its source novel", async () => {
    const runInvalidScope = async (label: string, scope: string, worldModelLoader: WorldModelLoader) => {
      let aggregateAccesses = 0;
      const cthulhuWorldModelLoader = rawLoader({ isLoaded: () => { aggregateAccesses += 1; throw new Error("invalid v18 scope reached aggregate"); } });
      const session = ownSession(new GameSession(
        `ordinary-${label}-scope`, "cosmic-horror", KP_CAPTURE_CONFIG,
        undefined, undefined, undefined, undefined, undefined, undefined,
        legacyReferenceDependencies(scope, worldModelLoader, cthulhuWorldModelLoader),
      ));
      const observedContext = await captureOpeningWorldModelContext(() => session.getOpeningScene());
      return { observedContext, aggregateAccesses };
    };

    let unknownLoaded = false;
    let unknownLoads = 0;
    const unknown = await runInvalidScope("unknown", "work-missing", rawLoader({
      isLoaded: () => unknownLoaded,
      load: () => { unknownLoads += 1; unknownLoaded = true; },
      getByNovel: () => [],
    }));
    expect(unknownLoads).toBe(1);
    expect(unknown).toEqual({ observedContext: "", aggregateAccesses: 0 });

    for (const [label, loader] of [
      ["mixed", rawLoader({ isLoaded: () => true, getByNovel: () => [{ novel: "work-b" }] })],
      ["missing-novel", rawLoader({ isLoaded: () => true, getByNovel: () => [{ novel: undefined }] })],
    ] as const) {
      const result = await runInvalidScope(label, "work-a", loader);
      expect(result).toEqual({ observedContext: "", aggregateAccesses: 0 });
    }
  });

  providerSeamIt("keeps valid ordinary v18 context when aggregate Cthulhu has no matching novel", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-world-model-aggregate-empty-"));
    try {
      const v18Path = join(root, "v18.jsonl");
      const cthulhuPath = join(root, "cthulhu.jsonl");
      writeFileSync(v18Path, JSON.stringify({ type: "faction_relation", chapter: "1", novel: "work-a", name: "A v18 relation", description: "\u7279\u91cc\u574e\u5bb6 A-only" }), "utf8");
      writeFileSync(cthulhuPath, JSON.stringify({ type: "deity", chapter: "1", novel: "work-b", name: "B aggregate deity", mechanic: "B-only" }), "utf8");
      const v18 = new WorldModelLoader();
      const aggregate = new WorldModelLoader();
      v18.load(v18Path);
      aggregate.load(cthulhuPath);
      const session = new GameSession(
        "ordinary-aggregate-empty", "cosmic-horror", KP_CAPTURE_CONFIG,
        undefined, undefined, undefined, undefined, undefined, undefined,
        legacyReferenceDependencies("work-a", v18, aggregate),
      );
      ownSession(session);
      expect((await session.act(BARN_COMMAND)).error).toBeUndefined();
      expect(session.getDisplayedScene()).toBe("\u7279\u91cc\u574e\u5bb6");
      const observedContext = await captureOpeningWorldModelContext(() => session.getOpeningScene());
      expect(observedContext).toContain("A v18 relation");
      expect(observedContext).not.toContain("B aggregate deity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  providerSeamIt("rejects mixed or source-less aggregate buckets without falling back from a valid ordinary v18 scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-world-model-aggregate-invalid-"));
    try {
      const v18Path = join(root, "v18.jsonl");
      const cthulhuPath = join(root, "cthulhu.jsonl");
      writeFileSync(v18Path, JSON.stringify({ type: "faction_relation", chapter: "1", novel: "work-a", name: "A v18 relation", description: "\u7279\u91cc\u574e\u5bb6 A-only" }), "utf8");
      writeFileSync(cthulhuPath, JSON.stringify({ type: "deity", chapter: "1", novel: "work-b", name: "B aggregate deity", mechanic: "B-only" }), "utf8");
      const v18 = new WorldModelLoader();
      v18.load(v18Path);

      for (const [label, aggregateNovel] of [["mixed", "work-b"], ["missing-source", undefined]] as const) {
        const aggregate = new WorldModelLoader();
        aggregate.load(cthulhuPath);
        (aggregate as any).getByNovel = () => [{ novel: aggregateNovel }];
        const session = new GameSession(
          `ordinary-aggregate-${label}`, "cosmic-horror", KP_CAPTURE_CONFIG,
          undefined, undefined, undefined, undefined, undefined, undefined,
          legacyReferenceDependencies("work-a", v18, aggregate),
        );
        ownSession(session);
        expect((await session.act(BARN_COMMAND)).error).toBeUndefined();
        expect(session.getDisplayedScene()).toBe("\u7279\u91cc\u574e\u5bb6");
        const observedContext = await captureOpeningWorldModelContext(() => session.getOpeningScene());
        expect(observedContext).toContain("A v18 relation");
        expect(observedContext).not.toContain("B aggregate deity");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
