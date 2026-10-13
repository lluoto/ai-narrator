import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { handleCompiledModuleHttpRequest, type CompiledModuleHttpDependencies } from "../api/compiled-module-http";
import { handleRequest } from "../api/server";
import { CompiledSessionCreationAdmissionCoordinator, COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY } from "../api/compiled-session-creation-admission";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { createCompiledCthulhuWorldModelBinding, type CompiledCthulhuWorldModelBinding } from "../world/compiled-world-model-scope";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";

const roots = new Set<string>();
const sessions = new Set<GameSession>();
const DATASET_ROOT = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";

afterEach(() => {
  for (const session of sessions) session.close();
  sessions.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporaryCatalog(): CompilerArtifactCatalog {
  const root = mkdtempSync(join(tmpdir(), "compiled-world-model-http-publication-"));
  roots.add(root);
  return new CompilerArtifactCatalog({ root });
}

/** A structural identity fixture for the resolver seam; catalog validation is separately covered. */
function trustedBinding(identity: { moduleId: string; artifactHash: string }): CompiledCthulhuWorldModelBinding {
  return {
    schemaVersion: "1.0.0",
    kind: "cthulhu_dataset",
    moduleId: identity.moduleId,
    artifactHash: identity.artifactHash,
    datasetId: "cthulhu-gutenberg-source-bound",
    datasetVersion: "1",
    manifestHash: "0".repeat(64),
    datasetRoot: "server-owned-dataset-root",
    datasetRootIdentity: "1".repeat(64),
    allowedWorkIds: ["the_call_of_cthulhu"],
    corpusScopeId: null,
    transferPolicy: "analogy_only",
    scopeHash: "2".repeat(64),
  };
}

function dependencies(
  catalog: CompilerArtifactCatalog,
  resolver?: (identity: Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>) => CompiledCthulhuWorldModelBinding | undefined,
): CompiledModuleHttpDependencies {
  const compiledDurableHostCapability = Object.freeze(Object.create(null)) as object;
  const base: CompiledModuleHttpDependencies = {
    catalog,
    compiledDurableHostCapability,
    compiledSessionCreationAdmission: new CompiledSessionCreationAdmissionCoordinator({
      root: catalog.root,
      ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
    }),
    generateId: () => "world-model-publication-session",
    hasSession: () => false,
    createSession: (id, archetype, characterName, persona) => {
      const session = new GameSession(
        id,
        "cosmic-horror",
        { apiKey: "", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 },
        archetype,
        characterName,
        persona,
        { careerRoot: join(catalog.root, "careers") },
        undefined,
        "preferred",
        { compiledDurableHostCapability },
      );
      sessions.add(session);
      return session;
    },
    registerSession: () => {},
    persistSession: () => {},
    authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: "operator:world-model-publication", role: "operator" } }),
  };
  return resolver ? { ...base, resolveCompiledWorldModelBinding: resolver } : base;
}

async function preparedReview(catalog: CompilerArtifactCatalog, moduleId: string) {
  const fixture = await compiledModuleHttpFixture(moduleId);
  const prepared = catalog.savePrepared(fixture.prepared.artifact);
  if (prepared.status !== "ok") throw new Error(prepared.message);
  const review = catalog.saveTrustedPresentationReview(
    prepared.value.id,
    fixture.prepared.artifact,
    fixture.resolved.artifact,
    "operator:world-model-publication",
    exactReviewBindings(fixture.resolved.artifact.payload as any),
  );
  if (review.status !== "ok") throw new Error(review.message);
  return { fixture, preparedArtifactId: prepared.value.id, presentationReviewId: review.value.id };
}

async function resolvePublication(
  catalog: CompilerArtifactCatalog,
  resolver?: (identity: Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>) => CompiledCthulhuWorldModelBinding | undefined,
  moduleId = "world-model-http-resolve",
) {
  const ready = await preparedReview(catalog, moduleId);
  return {
    ready,
    response: await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preparedArtifactId: ready.preparedArtifactId,
        preparedQueueHash: ready.fixture.prepared.identity.preparedQueueHash,
        hints: (ready.fixture.resolved.artifact.payload as any).hints,
        presentationReviewId: ready.presentationReviewId,
      }),
    }), dependencies(catalog, resolver)),
  };
}

describe("compiled HTTP world-model publication", () => {
  it("passes the exact resolved artifact identity and binding to resolve publication", async () => {
    const catalog = temporaryCatalog();
    const observedIdentities: Array<Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>> = [];
    let observedBinding: CompiledCthulhuWorldModelBinding | undefined;
    const originalSaveBundle = catalog.saveBundle.bind(catalog);
    (catalog as any).saveBundle = (artifact: unknown, projection: unknown, binding: CompiledCthulhuWorldModelBinding | undefined) => {
      observedBinding = binding;
      // The synthetic binding only validates structurally so this test can
      // remain independent of a host dataset. Capture the exact call, then
      // let the real catalog publish its normal unbound test artifact.
      return originalSaveBundle(artifact, projection);
    };

    const resolver = (identity: Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>) => {
      observedIdentities.push(identity);
      return trustedBinding(identity);
    };
    const { ready, response } = await resolvePublication(catalog, resolver);

    expect(response?.status).toBe(200);
    expect(observedIdentities).toEqual([{
      moduleId: ready.fixture.resolved.identity.moduleId,
      artifactHash: ready.fixture.resolved.artifact.artifactHash,
      documentHash: ready.fixture.resolved.identity.documentHash,
    }]);
    expect(observedBinding).toEqual(trustedBinding({ moduleId: ready.fixture.resolved.identity.moduleId, artifactHash: ready.fixture.resolved.artifact.artifactHash }));
  });

  it("forwards the server-owned resolver into compiled HTTP publication", async () => {
    const catalog = temporaryCatalog();
    const ready = await preparedReview(catalog, "world-model-http-server");
    const observedIdentities: Array<Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>> = [];
    let observedBinding: CompiledCthulhuWorldModelBinding | undefined;
    const originalSaveBundle = catalog.saveBundle.bind(catalog);
    (catalog as any).saveBundle = (artifact: unknown, projection: unknown, binding: CompiledCthulhuWorldModelBinding | undefined) => {
      observedBinding = binding;
      return originalSaveBundle(artifact, projection);
    };
    const resolver = (identity: Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>) => {
      observedIdentities.push(identity);
      return trustedBinding(identity);
    };

    const response = await handleRequest(
      new Request("http://test/api/compiler/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: ready.preparedArtifactId,
          preparedQueueHash: ready.fixture.prepared.identity.preparedQueueHash,
          hints: (ready.fixture.resolved.artifact.payload as any).hints,
          presentationReviewId: ready.presentationReviewId,
        }),
      }),
      catalog,
      undefined,
      { careerRoot: join(catalog.root, "careers"), sessionRoot: join(catalog.root, "sessions") },
      {},
      {},
      () => ({ status: "authenticated", principal: { id: "operator:world-model-publication", role: "operator" } }),
      undefined,
      undefined,
      undefined,
      {},
      { resolveCompiledWorldModelBinding: resolver },
    );

    expect(response.status).toBe(200);
    expect(observedIdentities).toEqual([{
      moduleId: ready.fixture.resolved.identity.moduleId,
      artifactHash: ready.fixture.resolved.artifact.artifactHash,
      documentHash: ready.fixture.resolved.identity.documentHash,
    }]);
    expect(observedBinding).toEqual(trustedBinding({ moduleId: ready.fixture.resolved.identity.moduleId, artifactHash: ready.fixture.resolved.artifact.artifactHash }));
  });

  it("passes the exact reviewed-resolve artifact identity and binding to catalog publication before bundle-ID creation", async () => {
    const catalog = temporaryCatalog();
    const observedIdentities: Array<Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>> = [];
    let observedBinding: CompiledCthulhuWorldModelBinding | undefined;
    const originalSaveBundle = catalog.saveBundle.bind(catalog);
    (catalog as any).saveBundle = (artifact: unknown, projection: unknown, binding: CompiledCthulhuWorldModelBinding | undefined) => {
      observedBinding = binding;
      return originalSaveBundle(artifact, projection);
    };
    const resolver = (identity: Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>) => {
      observedIdentities.push(identity);
      return trustedBinding(identity);
    };

    const { ready, response } = await resolvePublication(catalog, resolver, "world-model-http-reviewed-create");
    expect(response?.status).toBe(200);
    const body = await response?.json() as { bundleId: string };
    const created = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: body.bundleId, archetype: "investigator", characterName: "Ada" }),
    }), dependencies(catalog, resolver));

    expect(created?.status).toBe(201);
    expect(observedIdentities).toEqual([{
      moduleId: ready.fixture.resolved.identity.moduleId,
      artifactHash: ready.fixture.resolved.artifact.artifactHash,
      documentHash: ready.fixture.resolved.identity.documentHash,
    }]);
    expect(observedBinding).toEqual(trustedBinding({ moduleId: ready.fixture.resolved.identity.moduleId, artifactHash: ready.fixture.resolved.artifact.artifactHash }));
  });

  it("never invokes the resolver or overwrites a catalog bundle when create receives bundleId", async () => {
    const catalog = temporaryCatalog();
    const fixture = await compiledModuleHttpFixture("world-model-http-bundle-id");
    const saved = saveTrustedFixtureBundle(catalog, fixture);
    let resolverCalls = 0;
    let catalogWrites = 0;
    const originalSaveBundle = catalog.saveBundle.bind(catalog);
    (catalog as any).saveBundle = (artifact: unknown, projection: unknown, binding?: unknown) => {
      catalogWrites++;
      return originalSaveBundle(artifact, projection, binding as any);
    };

    const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), dependencies(catalog, (identity) => {
      resolverCalls++;
      return trustedBinding(identity);
    }));

    expect(response?.status).toBe(201);
    expect(resolverCalls).toBe(0);
    expect(catalogWrites).toBe(0);
  });

  it("fails closed before a catalog write when the resolver throws or returns a mismatched binding", async () => {
    for (const [index, resolver] of [
      () => { throw new Error("trusted resolver unavailable"); },
      (identity: Readonly<{ moduleId: string; artifactHash: string; documentHash: string | null }>) => trustedBinding({ ...identity, moduleId: "different-module" }),
    ].entries()) {
      const catalog = temporaryCatalog();
      let catalogWrites = 0;
      const originalSaveBundle = catalog.saveBundle.bind(catalog);
      (catalog as any).saveBundle = (artifact: unknown, projection: unknown, binding?: unknown) => {
        catalogWrites++;
        return originalSaveBundle(artifact, projection, binding as any);
      };
      const { response } = await resolvePublication(catalog, resolver, `world-model-http-reject-${index}`);

      expect(response?.status).toBe(500);
      expect(await response?.json()).toMatchObject({ error: { stage: "resolve", code: "WORLD_MODEL_BINDING_RESOLUTION_FAILED" } });
      expect(catalogWrites).toBe(0);
    }
  });

  it("takes document identity only from the catalog-restored artifact, never the resolve body", async () => {
    const catalog = temporaryCatalog();
    const ready = await preparedReview(catalog, "world-model-http-body-document-hash");
    let resolverCalls = 0;
    let bundleWrites = 0;
    const originalSaveBundle = catalog.saveBundle.bind(catalog);
    (catalog as any).saveBundle = (artifact: unknown, projection: unknown, binding?: unknown) => {
      bundleWrites++;
      return originalSaveBundle(artifact, projection, binding);
    };

    const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preparedArtifactId: ready.preparedArtifactId,
        preparedQueueHash: ready.fixture.prepared.identity.preparedQueueHash,
        hints: (ready.fixture.resolved.artifact.payload as any).hints,
        presentationReviewId: ready.presentationReviewId,
        documentHash: "f".repeat(64),
      }),
    }), dependencies(catalog, () => {
      resolverCalls++;
      throw new Error("request document hash must not reach the resolver");
    }));

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { stage: "resolve", code: "REQUEST_SHAPE_INVALID" } });
    expect(resolverCalls).toBe(0);
    expect(bundleWrites).toBe(0);
  });

  it("retains the existing unbound publication when no trusted resolver is configured", async () => {
    const catalog = temporaryCatalog();
    const { response } = await resolvePublication(catalog, undefined, "world-model-http-unbound");
    expect(response?.status).toBe(200);
    const body = await response?.json() as { bundleId: string };
    const loaded = catalog.loadBundle(body.bundleId);
    expect(loaded).toMatchObject({ status: "ok" });
    if (loaded.status === "ok") expect(loaded.value.worldModelBinding).toBeUndefined();
  });

  it("redacts a vanished bound dataset root before either bundle metadata or session creation can expose it", async () => {
    const catalog = temporaryCatalog();
    const fixture = await compiledModuleHttpFixture("world-model-http-vanished-root");
    const reviewed = saveTrustedFixtureBundle(catalog, fixture);
    const reviewedBundle = catalog.loadBundle(reviewed.id);
    if (reviewedBundle.status !== "ok") throw new Error(reviewedBundle.message);

    // The binding is created and catalog-validated while its server-owned root
    // exists. Removing only this test-owned directory reproduces a deployment
    // whose previously valid configured root disappears after publication.
    const datasetRoot = join(catalog.root, "dataset-root-that-must-not-leak");
    cpSync(DATASET_ROOT, datasetRoot, { recursive: true });
    const binding = createCompiledCthulhuWorldModelBinding({
      moduleId: fixture.resolved.identity.moduleId,
      artifactHash: fixture.resolved.artifact.artifactHash,
      datasetRoot,
      allowedWorkIds: ["the_call_of_cthulhu"],
      transferPolicy: "analogy_only",
    });
    const bound = catalog.saveBundle(
      reviewedBundle.value.artifact,
      reviewedBundle.value.projection,
      binding,
    );
    if (bound.status !== "ok") throw new Error(bound.message);
    rmSync(datasetRoot, { recursive: true, force: true });

    const bundleRead = await handleCompiledModuleHttpRequest(
      new Request(`http://test/api/compiler/bundles/${bound.value.id}`),
      dependencies(catalog),
    );
    expect(bundleRead?.status).toBe(409);
    const bundleReadText = await bundleRead?.text() ?? "";
    expect(bundleReadText).not.toContain(datasetRoot);
    expect(bundleReadText).not.toContain("ENOENT");
    expect(JSON.parse(bundleReadText)).toMatchObject({ error: { code: "CATALOG_CORRUPT" } });

    const calls = { factory: 0, registered: 0, persisted: 0 };
    const sessionDeps: CompiledModuleHttpDependencies = {
      ...dependencies(catalog),
      createSession: () => { calls.factory++; throw new Error("factory must not run for a corrupt bundle"); },
      registerSession: () => { calls.registered++; },
      persistSession: () => { calls.persisted++; },
    };
    const creation = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: bound.value.id, archetype: "investigator", characterName: "Ada" }),
    }), sessionDeps);
    expect(creation?.status).toBe(409);
    const creationText = await creation?.text() ?? "";
    expect(creationText).not.toContain(datasetRoot);
    expect(creationText).not.toContain("ENOENT");
    expect(JSON.parse(creationText)).toMatchObject({ error: { code: "CATALOG_CORRUPT" } });
    expect(calls).toEqual({ factory: 0, registered: 0, persisted: 0 });
  });

  it("keeps internal catalog failure codes and transport contracts while withholding diagnostics", async () => {
    const catalog = temporaryCatalog();
    const originalLoadBundle = catalog.loadBundle.bind(catalog);
    const cases = [
      { code: "CATALOG_CORRUPT", raw: "ENOENT: C:\\server\\secret\\catalog.json", message: "catalog data is unavailable", status: 409, retryAfter: null, redacted: true },
      { code: "CATALOG_INCOMPATIBLE", raw: "unsupported deployment schema at C:\\server\\secret", message: "catalog data is incompatible with this runtime", status: 409, retryAfter: null, redacted: true },
      { code: "CATALOG_STORAGE_FAILED", raw: "EACCES: C:\\server\\secret\\catalog.json", message: "catalog storage is unavailable", status: 500, retryAfter: null, redacted: true },
      { code: "CATALOG_BUSY", raw: "catalog publication is busy", message: "catalog publication is busy", status: 503, retryAfter: "1", redacted: false },
    ] as const;
    try {
      for (const expected of cases) {
        (catalog as unknown as { loadBundle(id: string): unknown }).loadBundle = () => ({ status: "refused", code: expected.code, message: expected.raw });
        const response = await handleCompiledModuleHttpRequest(
          new Request(`http://test/api/compiler/bundles/${"a".repeat(24)}`),
          dependencies(catalog),
        );
        expect(response?.status).toBe(expected.status);
        expect(response?.headers.get("Retry-After")).toBe(expected.retryAfter);
        const text = await response?.text() ?? "";
        if (expected.redacted) expect(text).not.toContain(expected.raw);
        else expect(text).toContain(expected.raw);
        expect(JSON.parse(text)).toMatchObject({ error: { code: expected.code, message: expected.message } });
      }
    } finally {
      (catalog as unknown as { loadBundle(id: string): unknown }).loadBundle = originalLoadBundle;
    }
  });
});
