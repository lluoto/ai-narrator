import { describe, expect, it } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompilerArtifactCatalog, COMPILER_ARTIFACT_CATALOG_ID_LENGTH } from "../compiler/compiler-artifact-catalog";
import { compilerArtifactCatalogNodeFileOps } from "../compiler/compiler-artifact-catalog";
import { CatalogCoordinatorFailure } from "../compiler/compiler-artifact-catalog-coordinator";
import { prepareCompiler } from "../compiler/compiler-api";
import { projectTrustedResolvedCompilerArtifact, validateCanonicalCompilerModuleProjection } from "../compiler/compiler-module-data-projection";
import { GameSession } from "../api/game-session";
import { compiledModuleHttpFixture, hints, PAGES } from "./helpers/compiled-module-http-fixture";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";

function root(): string { return mkdtempSync(join(tmpdir(), "compiler-catalog-")); }
function id(letter: string): string { return letter.repeat(COMPILER_ARTIFACT_CATALOG_ID_LENGTH); }

describe("compiler artifact catalog", () => {
  it("returns durable prepared metadata for an idempotent replay", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      let preparedNow = 0;
      const syncPaths: string[] = [];
      const preparedCatalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("v"),
        now: () => `2026-01-01T00:00:0${preparedNow++}.000Z`,
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          syncDirectory: (path) => { syncPaths.push(path); },
          publish: (tempPath, targetPath) => {
            syncPaths.push("publish");
            compilerArtifactCatalogNodeFileOps.publish(tempPath, targetPath);
          },
        },
      });
      const firstPrepared = preparedCatalog.savePrepared(fixture.prepared.artifact);
      const replayedPrepared = preparedCatalog.savePrepared(fixture.prepared.artifact);
      expect(firstPrepared.status).toBe("ok");
      expect(replayedPrepared.status).toBe("ok");
      if (firstPrepared.status !== "ok" || replayedPrepared.status !== "ok") return;
      const loadedPrepared = preparedCatalog.loadPrepared(firstPrepared.value.id);
      expect(loadedPrepared.status).toBe("ok");
      if (loadedPrepared.status !== "ok") return;
      expect(replayedPrepared.value).toEqual(firstPrepared.value);
      expect(loadedPrepared.value).toMatchObject(replayedPrepared.value);
      // New-stage parent sync and post-temp-removal sync bracket durable reload.
      expect(syncPaths).toEqual([dir, dir, "publish", join(dir, "prepared"), dir, join(dir, "prepared")]);

    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns durable bundle metadata for an idempotent replay", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      let bundleNow = 0;
      const bundleCatalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("w"),
        now: () => `2026-01-02T00:00:0${bundleNow++}.000Z`,
      });
      const firstBundle = bundleCatalog.saveBundle(fixture.resolved.artifact, fixture.projection);
      const replayedBundle = bundleCatalog.saveBundle(fixture.resolved.artifact, fixture.projection);
      expect(firstBundle.status).toBe("ok");
      expect(replayedBundle.status).toBe("ok");
      if (firstBundle.status !== "ok" || replayedBundle.status !== "ok") return;
      const loadedBundle = bundleCatalog.loadBundle(firstBundle.value.id);
      expect(loadedBundle.status).toBe("ok");
      if (loadedBundle.status !== "ok") return;
      expect(replayedBundle.value).toEqual(firstBundle.value);
      expect(loadedBundle.value).toMatchObject(replayedBundle.value);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reloads a same-content hard-link race and refuses an invalid shallow match", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const racedCreatedAt = "2026-02-01T00:00:00.000Z";
      const raceSyncPaths: string[] = [];
      const racingCatalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("x"),
        now: () => "2026-01-01T00:00:00.000Z",
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          syncDirectory: (path) => { raceSyncPaths.push(path); },
          publish: (tempPath, targetPath) => {
            raceSyncPaths.push("publish");
            const competitor = JSON.parse(readFileSync(tempPath, "utf8"));
            competitor.createdAt = racedCreatedAt;
            writeFileSync(targetPath, JSON.stringify(competitor));
            throw new Error("hard-link target already exists");
          },
        },
      });
      const raced = racingCatalog.savePrepared(fixture.prepared.artifact);
      expect(raced).toEqual(expect.objectContaining({ status: "ok", value: expect.objectContaining({ createdAt: racedCreatedAt }) }));
      const racedLoaded = racingCatalog.loadPrepared(id("x"));
      expect(racedLoaded.status).toBe("ok");
      if (raced.status !== "ok" || racedLoaded.status !== "ok") return;
      expect(racedLoaded.value).toMatchObject(raced.value);
      expect(raceSyncPaths).toEqual([dir, dir, "publish", join(dir, "prepared"), join(dir, "prepared")]);

      const corruptDir = root();
      try {
        const firstCatalog = new CompilerArtifactCatalog({ root: corruptDir, generateId: () => id("y") });
        const first = firstCatalog.savePrepared(fixture.prepared.artifact);
        expect(first.status).toBe("ok");
        if (first.status !== "ok") return;
        const path = join(corruptDir, "prepared", `${first.value.id}.json`);
        const corrupt = JSON.parse(readFileSync(path, "utf8"));
        corrupt.artifact.payload.draft.moduleId = "tampered-after-publication";
        writeFileSync(path, JSON.stringify(corrupt));
        expect(firstCatalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
      } finally { rmSync(corruptDir, { recursive: true, force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("classifies a valid different hard-link race as an immutable ID collision", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const different = await prepareCompiler({
        kind: "synthetic_pages",
        moduleId: "different-race-fixture",
        sourceDescriptor: "different-race-fixture",
        pages: PAGES,
      });
      if (different.status === "refused") throw new Error(different.message);
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("n"),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish: (tempPath, targetPath) => {
            const competitor = JSON.parse(readFileSync(tempPath, "utf8"));
            competitor.artifact = different.artifact;
            competitor.artifactHash = different.artifact.artifactHash;
            competitor.identity = different.artifact.payload.identity;
            writeFileSync(targetPath, JSON.stringify(competitor));
            throw new Error("hard-link target already exists");
          },
        },
      });
      expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_ID_COLLISION" });
      expect(catalog.loadPrepared(id("n"))).toMatchObject({ status: "ok", value: { artifactHash: different.artifact.artifactHash } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("revalidates existing and raced targets before shallow collision comparison", async () => {
    const fixture = await compiledModuleHttpFixture();
    const invalidCases: Array<{ label: string; mutate: (envelope: any) => unknown; code: "CATALOG_CORRUPT" | "CATALOG_INCOMPATIBLE" }> = [
      {
        label: "artifact hash",
        mutate: (envelope) => ({ ...envelope, artifactHash: "a".repeat(64) }),
        code: "CATALOG_CORRUPT",
      },
      {
        label: "schema",
        mutate: (envelope) => ({ ...envelope, schemaVersion: "0.0.0", artifactHash: "b".repeat(64) }),
        code: "CATALOG_INCOMPATIBLE",
      },
      {
        label: "JSON",
        mutate: () => "{",
        code: "CATALOG_CORRUPT",
      },
    ];
    for (const invalid of invalidCases) {
      const dir = root();
      try {
        const catalog = new CompilerArtifactCatalog({ root: dir, generateId: () => id("k") });
        const first = catalog.savePrepared(fixture.prepared.artifact);
        if (first.status !== "ok") throw new Error(first.message);
        const path = join(dir, "prepared", `${first.value.id}.json`);
        const original = JSON.parse(readFileSync(path, "utf8"));
        const mutated = invalid.mutate(original);
        writeFileSync(path, typeof mutated === "string" ? mutated : JSON.stringify(mutated));
        expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: invalid.code });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }

    const raceDir = root();
    try {
      const racingCatalog = new CompilerArtifactCatalog({
        root: raceDir,
        generateId: () => id("l"),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish: (_tempPath, targetPath) => {
            writeFileSync(targetPath, "{");
            throw new Error("hard-link target already exists");
          },
        },
      });
      expect(racingCatalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
    } finally { rmSync(raceDir, { recursive: true, force: true }); }
  });

  it("cleans an unacknowledged continuation, preserves opaque retry semantics, and rejects post-write corruption", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const continuationStage = join(dir, "continuations");
      let failContinuationSync = true;
      let opaqueAttempt = 0;
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("c"),
        generateOpaqueId: () => id(opaqueAttempt++ === 0 ? "d" : "e"),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          syncDirectory: (path) => {
            if (failContinuationSync && path === continuationStage) throw new Error("continuation stage sync failed");
          },
        },
      });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      expect(catalog.saveAutoResolveContinuation(prepared.value.id, fixture.prepared.artifact, hints(fixture.prepared))).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE" });
      const known = new CompilerArtifactCatalog({ root: dir }).loadAutoResolveContinuation(id("d"));
      expect(known).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });

      failContinuationSync = false;
      const retry = catalog.saveAutoResolveContinuation(prepared.value.id, fixture.prepared.artifact, hints(fixture.prepared));
      expect(retry).toMatchObject({ status: "ok", value: { id: id("e") } });
      expect(retry).not.toMatchObject({ status: "ok", value: { id: id("d") } });
      expect(new CompilerArtifactCatalog({ root: dir }).loadAutoResolveContinuation(id("e"))).toMatchObject({ status: "ok" });
      expect(readdirSync(continuationStage).filter((name) => name.endsWith(".json"))).toEqual([`${id("e")}.json`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }

    const corruptDir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({
        root: corruptDir,
        generateId: () => id("f"),
        generateOpaqueId: () => id("g"),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish: (tempPath, targetPath) => {
            if (!targetPath.includes("continuations")) return compilerArtifactCatalogNodeFileOps.publish(tempPath, targetPath);
            const corrupt = JSON.parse(readFileSync(tempPath, "utf8"));
            corrupt.hints.moduleId = "tampered-during-continuation-publication";
            writeFileSync(targetPath, JSON.stringify(corrupt));
          },
        },
      });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      expect(catalog.saveAutoResolveContinuation(prepared.value.id, fixture.prepared.artifact, hints(fixture.prepared))).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
      expect(catalog.loadAutoResolveContinuation(id("g"))).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });
    } finally { rmSync(corruptDir, { recursive: true, force: true }); }
  });

  it("returns the durable winner metadata for a same-hash presentation-review hard-link race", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const winnerCreatedAt = "2026-05-01T00:00:00.000Z";
      let winnerReviewHash = "";
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("h"),
        generateOpaqueId: () => id("i"),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish: (tempPath, targetPath) => {
            if (!targetPath.includes("presentation-reviews")) return compilerArtifactCatalogNodeFileOps.publish(tempPath, targetPath);
            const winner = JSON.parse(readFileSync(tempPath, "utf8"));
            winner.createdAt = winnerCreatedAt;
            winnerReviewHash = winner.reviewHash;
            writeFileSync(targetPath, JSON.stringify(winner));
            throw new Error("hard-link target already exists");
          },
        },
      });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const saved = catalog.saveTrustedPresentationReview(
        prepared.value.id,
        fixture.prepared.artifact,
        fixture.resolved.artifact,
        "operator:presentation-race",
        exactReviewBindings(fixture.resolved.artifact.payload as any),
      );
      expect(saved).toMatchObject({ status: "ok", value: { id: id("i"), createdAt: winnerCreatedAt, reviewHash: winnerReviewHash } });
      if (saved.status !== "ok") return;
      const durable = catalog.loadTrustedPresentationReview(saved.value.id);
      expect(durable.status).toBe("ok");
      if (durable.status !== "ok") return;
      expect(saved.value).toMatchObject({ reviewHash: durable.value.reviewHash, createdAt: durable.value.createdAt });
    } finally { rmSync(dir, { recursive: true, force: true }); }

    const corruptDir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({
        root: corruptDir,
        generateId: () => id("j"),
        generateOpaqueId: () => id("k"),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish: (tempPath, targetPath) => {
            if (!targetPath.includes("presentation-reviews")) return compilerArtifactCatalogNodeFileOps.publish(tempPath, targetPath);
            const corrupt = JSON.parse(readFileSync(tempPath, "utf8"));
            corrupt.review.reviewHash = "a".repeat(64);
            writeFileSync(targetPath, JSON.stringify(corrupt));
          },
        },
      });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      expect(catalog.saveTrustedPresentationReview(
        prepared.value.id,
        fixture.prepared.artifact,
        fixture.resolved.artifact,
        "operator:presentation-post-write-corrupt",
        exactReviewBindings(fixture.resolved.artifact.payload as any),
      )).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
      expect(catalog.loadTrustedPresentationReview(id("k"))).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });
    } finally { rmSync(corruptDir, { recursive: true, force: true }); }
  });

  it("cleans an unacknowledged presentation review before a fresh opaque retry", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const reviewStage = join(dir, "presentation-reviews");
      let failReviewSync = true;
      let opaqueAttempt = 0;
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("l"),
        generateOpaqueId: () => id(opaqueAttempt++ === 0 ? "m" : "n"),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          syncDirectory: (path) => {
            if (failReviewSync && path === reviewStage) throw new Error("presentation review stage sync failed");
          },
        },
      });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const save = () => catalog.saveTrustedPresentationReview(
        prepared.value.id,
        fixture.prepared.artifact,
        fixture.resolved.artifact,
        "operator:presentation-sync-retry",
        exactReviewBindings(fixture.resolved.artifact.payload as any),
      );
      expect(save()).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE" });
      expect(catalog.loadTrustedPresentationReview(id("m"))).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });

      failReviewSync = false;
      expect(save()).toMatchObject({ status: "ok", value: { id: id("n") } });
      expect(readdirSync(reviewStage).filter((name) => name.endsWith(".json"))).toEqual([`${id("n")}.json`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("never refuses an opaque publication while leaving a formal entry after its final temp sync fails", async () => {
    const fixture = await compiledModuleHttpFixture();
    for (const kind of ["continuation", "presentation-review"] as const) {
      const dir = root();
      try {
        const stage = join(dir, kind === "continuation" ? "continuations" : "presentation-reviews");
        let stageSyncs = 0;
        const catalog = new CompilerArtifactCatalog({
          root: dir,
          generateId: () => id(kind === "continuation" ? "w" : "x"),
          generateOpaqueId: () => id(kind === "continuation" ? "y" : "z"),
          fileOps: {
            ...compilerArtifactCatalogNodeFileOps,
            syncDirectory: (path) => {
              if (path === stage && ++stageSyncs >= 1) throw new Error("final temporary sync failed");
            },
          },
        });
        const prepared = catalog.savePrepared(fixture.prepared.artifact);
        if (prepared.status !== "ok") throw new Error(prepared.message);
        const saved = kind === "continuation"
          ? catalog.saveAutoResolveContinuation(prepared.value.id, fixture.prepared.artifact, hints(fixture.prepared))
          : catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:final-temp-sync", exactReviewBindings(fixture.resolved.artifact.payload as any));
        expect(saved).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE" });
        const loaded = kind === "continuation" ? catalog.loadAutoResolveContinuation(id("y")) : catalog.loadTrustedPresentationReview(id("z"));
        expect(loaded).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("makes opaque publication outcome agree with rollback and close finalization", async () => {
    const fixture = await compiledModuleHttpFixture();
    for (const finalization of ["rollback", "close"] as const) {
      for (const kind of ["continuation", "presentation-review"] as const) {
        const dir = root();
        try {
          const prerequisite = new CompilerArtifactCatalog({ root: dir, generateId: () => id("a") });
          const prepared = prerequisite.savePrepared(fixture.prepared.artifact);
          if (prepared.status !== "ok") throw new Error(prepared.message);
          const opaqueId = id(kind === "continuation" ? "b" : "c");
          const catalog = new CompilerArtifactCatalog({
            root: dir,
            generateOpaqueId: () => opaqueId,
            coordinatorFactory: () => ({
              initializePolicy: () => undefined,
              beginPublication: () => undefined,
              finishPublication: () => finalization === "rollback"
                ? { rollbackFailure: new CatalogCoordinatorFailure("CATALOG_STORAGE_FAILED", "injected rollback failure") }
                : { closeFailure: new CatalogCoordinatorFailure("CATALOG_STORAGE_FAILED", "injected close failure") },
            }),
          });
          const saved = kind === "continuation"
            ? catalog.saveAutoResolveContinuation(prepared.value.id, fixture.prepared.artifact, hints(fixture.prepared))
            : catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:finalization", exactReviewBindings(fixture.resolved.artifact.payload as any));
          const loaded = kind === "continuation" ? catalog.loadAutoResolveContinuation(opaqueId) : catalog.loadTrustedPresentationReview(opaqueId);
          // A close failure leaves lock release uncertain, but cannot make a
          // fully replay-validated opaque ID unreachable from its response.
          expect(saved).toMatchObject({ status: "ok", value: { id: opaqueId } });
          expect(loaded).toMatchObject({ status: "ok" });
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    }
  });

  it("never refuses a validated opaque target that cannot be removed after coordinator close failure", async () => {
    const fixture = await compiledModuleHttpFixture();
    for (const kind of ["continuation", "presentation-review"] as const) {
      const dir = root();
      try {
        const prerequisite = new CompilerArtifactCatalog({ root: dir, generateId: () => id("d") });
        const prepared = prerequisite.savePrepared(fixture.prepared.artifact);
        if (prepared.status !== "ok") throw new Error(prepared.message);
        const opaqueId = id(kind === "continuation" ? "e" : "f");
        const stage = join(dir, kind === "continuation" ? "continuations" : "presentation-reviews");
        const target = join(stage, `${opaqueId}.json`);
        let targetRemoveAttempts = 0;
        const catalog = new CompilerArtifactCatalog({
          root: dir,
          generateOpaqueId: () => opaqueId,
          fileOps: {
            ...compilerArtifactCatalogNodeFileOps,
            remove: (path) => {
              if (path === target) {
                targetRemoveAttempts++;
                throw new Error("target remove failed after close failure");
              }
              compilerArtifactCatalogNodeFileOps.remove(path);
            },
          },
          coordinatorFactory: () => ({
            initializePolicy: () => undefined,
            beginPublication: () => undefined,
            finishPublication: () => ({ closeFailure: new CatalogCoordinatorFailure("CATALOG_STORAGE_FAILED", "injected close failure") }),
          }),
        });
        const saved = kind === "continuation"
          ? catalog.saveAutoResolveContinuation(prepared.value.id, fixture.prepared.artifact, hints(fixture.prepared))
          : catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:close-remove", exactReviewBindings(fixture.resolved.artifact.payload as any));
        expect(saved).toMatchObject({ status: "ok", value: { id: opaqueId } });
        expect(targetRemoveAttempts).toBe(0);
        const loaded = kind === "continuation" ? catalog.loadAutoResolveContinuation(opaqueId) : catalog.loadTrustedPresentationReview(opaqueId);
        expect(loaded).toMatchObject({ status: "ok" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("reports same-content opaque race winners with recovery when acknowledgement sync fails", async () => {
    const fixture = await compiledModuleHttpFixture();
    for (const kind of ["continuation", "presentation-review"] as const) {
      const dir = root();
      try {
        const prerequisite = new CompilerArtifactCatalog({ root: dir, generateId: () => id("n") });
        const prepared = prerequisite.savePrepared(fixture.prepared.artifact);
        if (prepared.status !== "ok") throw new Error("prepared prerequisite failed");
        const opaqueId = id(kind === "continuation" ? "o" : "p");
        const stage = join(dir, kind === "continuation" ? "continuations" : "presentation-reviews");
        mkdirSync(stage);
        let removedWinner = false;
        const catalog = new CompilerArtifactCatalog({
          root: dir, generateOpaqueId: () => opaqueId,
          fileOps: {
            ...compilerArtifactCatalogNodeFileOps,
            publish: (temp, target) => { writeFileSync(target, readFileSync(temp)); throw new Error("hard-link target exists"); },
            syncDirectory: (path) => { if (path === stage) throw new Error("winner acknowledgement sync failed"); },
            remove: (path) => { if (path.endsWith(`${opaqueId}.json`)) removedWinner = true; compilerArtifactCatalogNodeFileOps.remove(path); },
          },
        });
        const saved = kind === "continuation"
          ? catalog.saveAutoResolveContinuation(prepared.value.id, fixture.prepared.artifact, hints(fixture.prepared))
          : catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:race-winner", exactReviewBindings(fixture.resolved.artifact.payload as any));
        expect(saved).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE", recovery: { stage: kind, id: opaqueId } });
        expect(removedWinner).toBe(false);
        expect(kind === "continuation" ? catalog.loadAutoResolveContinuation(opaqueId) : catalog.loadTrustedPresentationReview(opaqueId)).toMatchObject({ status: "ok" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("reports an indeterminate recovery ID when temp unlink or final temp sync cannot revoke a valid link-created target", async () => {
    const fixture = await compiledModuleHttpFixture();
    for (const fault of ["temp-unlink", "final-sync", "final-sync-remove-success"] as const) for (const kind of ["continuation", "presentation-review"] as const) {
      const dir = root();
      try {
        const prerequisite = new CompilerArtifactCatalog({ root: dir, generateId: () => id("g") });
        const prepared = prerequisite.savePrepared(fixture.prepared.artifact);
        if (prepared.status !== "ok") throw new Error(prepared.message);
        const opaqueId = id(kind === "continuation" ? "h" : "i");
        const stage = join(dir, kind === "continuation" ? "continuations" : "presentation-reviews");
        const target = join(stage, `${opaqueId}.json`);
        let targetRemoveAttempts = 0;
        // Precreate the stage so its first injected sync is the final temp
        // unlink sync, rather than directory initialization.
        mkdirSync(stage);
        const catalog = new CompilerArtifactCatalog({
          root: dir,
          generateOpaqueId: () => opaqueId,
          fileOps: {
            ...compilerArtifactCatalogNodeFileOps,
            publish: (tempPath, targetPath) => linkSync(tempPath, targetPath),
            remove: (path) => {
              if (fault === "temp-unlink" && path.endsWith(".tmp")) throw new Error("temp unlink failed after hard link");
              if (path === target && fault !== "final-sync-remove-success") {
                targetRemoveAttempts++;
                throw new Error("target rollback remove failed");
              }
              compilerArtifactCatalogNodeFileOps.remove(path);
            },
            syncDirectory: (path) => {
              if ((fault === "final-sync" || fault === "final-sync-remove-success") && path === stage) throw new Error("final temp sync failed");
            },
          },
          coordinatorFactory: () => ({
            initializePolicy: () => undefined,
            beginPublication: () => undefined,
            finishPublication: () => ({ closeFailure: new CatalogCoordinatorFailure("CATALOG_STORAGE_FAILED", "injected close failure") }),
          }),
        });
        const saved = kind === "continuation"
          ? catalog.saveAutoResolveContinuation(prepared.value.id, fixture.prepared.artifact, hints(fixture.prepared))
          : catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:link-unlink", exactReviewBindings(fixture.resolved.artifact.payload as any));
        expect(saved).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE", recovery: { stage: kind, id: opaqueId } });
        expect(targetRemoveAttempts).toBe(fault === "final-sync-remove-success" ? 0 : 1);
        const loaded = kind === "continuation" ? catalog.loadAutoResolveContinuation(opaqueId) : catalog.loadTrustedPresentationReview(opaqueId);
        expect(loaded).toMatchObject(fault === "final-sync-remove-success" ? { status: "refused", code: "CATALOG_NOT_FOUND" } : { status: "ok" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("does not turn a transient post-sync read failure plus failed revoke into a refused-but-loadable entry", async () => {
    const fixture = await compiledModuleHttpFixture();
    for (const kind of ["continuation", "presentation-review"] as const) {
      const dir = root();
      try {
        const prerequisite = new CompilerArtifactCatalog({ root: dir, generateId: () => id("j") });
        const prepared = prerequisite.savePrepared(fixture.prepared.artifact);
        if (prepared.status !== "ok") throw new Error("prepared prerequisite failed");
        const opaqueId = id(kind === "continuation" ? "k" : "l");
        const stage = join(dir, kind === "continuation" ? "continuations" : "presentation-reviews");
        const target = join(stage, `${opaqueId}.json`);
        let firstTargetRead = true;
        const catalog = new CompilerArtifactCatalog({
          root: dir,
          generateOpaqueId: () => opaqueId,
          fileOps: {
            ...compilerArtifactCatalogNodeFileOps,
            read: (path) => {
              if (path === target && firstTargetRead) {
                firstTargetRead = false;
                throw new Error("transient durable reload failure");
              }
              return compilerArtifactCatalogNodeFileOps.read(path);
            },
            remove: (path) => {
              if (path === target) throw new Error("target revoke failed after transient reload");
              compilerArtifactCatalogNodeFileOps.remove(path);
            },
          },
        });
        const saved = kind === "continuation"
          ? catalog.saveAutoResolveContinuation(prepared.value.id, fixture.prepared.artifact, hints(fixture.prepared))
          : catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:transient-read", exactReviewBindings(fixture.resolved.artifact.payload as any));
        expect(saved).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE", recovery: { stage: kind, id: opaqueId } });
        const loaded = kind === "continuation" ? new CompilerArtifactCatalog({ root: dir }).loadAutoResolveContinuation(opaqueId) : new CompilerArtifactCatalog({ root: dir }).loadTrustedPresentationReview(opaqueId);
        expect(loaded).toMatchObject({ status: "ok" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("returns ok only after a compensating formal-target stage sync succeeds", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const stage = join(dir, "prepared");
      let stageSyncAttempts = 0;
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("m"),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          syncDirectory: (path) => {
            if (path === stage && ++stageSyncAttempts === 1) throw new Error("first formal target sync failed");
          },
        },
      });
      expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "ok", value: { id: id("m") } });
      expect(stageSyncAttempts).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("cleans an owned poisoned bundle target after post-write validation", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("o"),
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish: (tempPath, targetPath) => {
            const corrupt = JSON.parse(readFileSync(tempPath, "utf8"));
            corrupt.bundleHash = "a".repeat(64);
            writeFileSync(targetPath, JSON.stringify(corrupt));
          },
        },
      });
      expect(catalog.saveBundle(fixture.resolved.artifact, fixture.projection)).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
      expect(catalog.loadBundle(id("o"))).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not acknowledge a first write before durable revalidation", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const durableCreatedAt = "2026-03-01T00:00:00.000Z";
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("z"),
        now: () => "2026-01-01T00:00:00.000Z",
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish: (tempPath, targetPath) => {
            const durable = JSON.parse(readFileSync(tempPath, "utf8"));
            durable.createdAt = durableCreatedAt;
            writeFileSync(targetPath, JSON.stringify(durable));
          },
        },
      });
      expect(catalog.savePrepared(fixture.prepared.artifact)).toEqual(expect.objectContaining({ status: "ok", value: expect.objectContaining({ createdAt: durableCreatedAt }) }));

      const corruptDir = root();
      try {
        const corruptingCatalog = new CompilerArtifactCatalog({
          root: corruptDir,
          generateId: () => id("q"),
          fileOps: {
            ...compilerArtifactCatalogNodeFileOps,
            publish: (tempPath, targetPath) => {
              const durable = JSON.parse(readFileSync(tempPath, "utf8"));
              durable.artifact.payload.draft.moduleId = "corrupted-during-publication";
              writeFileSync(targetPath, JSON.stringify(durable));
            },
          },
        });
        expect(corruptingCatalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
        expect(corruptingCatalog.loadPrepared(id("q"))).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });
      } finally { rmSync(corruptDir, { recursive: true, force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("removes an unverified deterministic entry after final temp sync failure so a retry can republish it", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const stage = join(dir, "prepared");
      const failedSyncPaths: string[] = [];
      const failed = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("m"),
        now: () => "2026-04-01T00:00:00.000Z",
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          syncDirectory: (path) => {
            failedSyncPaths.push(path);
            if (path === stage) throw new Error("stage directory sync failed");
          },
          publish: (tempPath, targetPath) => {
            failedSyncPaths.push("publish");
            compilerArtifactCatalogNodeFileOps.publish(tempPath, targetPath);
          },
        },
      });
      expect(failed.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE" });
      expect(failedSyncPaths).toEqual([dir, dir, "publish", stage, stage, stage]);
      const target = join(stage, `${id("m")}.json`);
      expect(existsSync(target)).toBe(false);
      const durable = new CompilerArtifactCatalog({ root: dir }).loadPrepared(id("m"));
      expect(durable).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });

      const retrySyncPaths: string[] = [];
      const retry = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("m"),
        now: () => "2026-04-01T00:00:01.000Z",
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          syncDirectory: (path) => { retrySyncPaths.push(path); },
          publish: (tempPath, targetPath) => {
            retrySyncPaths.push("publish");
            compilerArtifactCatalogNodeFileOps.publish(tempPath, targetPath);
          },
        },
      }).savePrepared(fixture.prepared.artifact);
      expect(retry.status).toBe("ok");
      if (retry.status !== "ok") return;
      expect(retry.value).toMatchObject({ createdAt: "2026-04-01T00:00:01.000Z" });
      expect(retrySyncPaths).toEqual([dir, "publish", stage]);
      expect(readFileSync(target, "utf8")).toContain("2026-04-01T00:00:01.000Z");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a same-process alias adopter while its creator owns the SQLite critical section", async () => {
    const fixture = await compiledModuleHttpFixture();
    for (const stage of ["prepared", "bundle"] as const) {
      const dir = root();
      try {
        const stageDir = join(dir, stage === "prepared" ? "prepared" : "bundles");
        const rootAlias = dir.toUpperCase();
        const entryId = id(stage === "prepared" ? "r" : "s");
        const save = (catalog: CompilerArtifactCatalog) => stage === "prepared"
          ? catalog.savePrepared(fixture.prepared.artifact)
          : catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
        const load = (catalog: CompilerArtifactCatalog) => stage === "prepared"
          ? catalog.loadPrepared(entryId)
          : catalog.loadBundle(entryId);
        const adopterSyncPaths: string[] = [];
        let adopted: ReturnType<typeof save> | undefined;
        let injected = false;
        const creator = new CompilerArtifactCatalog({
          root: dir,
          generateId: () => entryId,
          now: () => "2026-06-01T00:00:00.000Z",
          fileOps: {
            ...compilerArtifactCatalogNodeFileOps,
            syncDirectory: (path) => {
              if (path !== stageDir || injected) return;
              injected = true;
              const adopter = new CompilerArtifactCatalog({
                root: rootAlias,
                generateId: () => entryId,
                now: () => "2026-06-01T00:00:01.000Z",
                fileOps: {
                  ...compilerArtifactCatalogNodeFileOps,
                  syncDirectory: (adopterPath) => {
                    adopterSyncPaths.push(adopterPath);
                    compilerArtifactCatalogNodeFileOps.syncDirectory?.(adopterPath);
                  },
                },
              });
              adopted = save(adopter);
              throw new Error("creator stage sync failed after deterministic adoption");
            },
          },
        });

        expect(creator.root).not.toBe(rootAlias);
        expect(save(creator)).toMatchObject({ status: "ok" });
        expect(adopted).toMatchObject({ status: "refused", code: "CATALOG_BUSY" });
        expect(adopterSyncPaths).toEqual([]);
        const durable = load(new CompilerArtifactCatalog({ root: dir }));
        expect(durable).toMatchObject({ status: "ok" });

        const retry = save(new CompilerArtifactCatalog({
          root: dir,
          generateId: () => entryId,
          now: () => "2026-06-01T00:00:02.000Z",
        }));
        expect(retry.status).toBe("ok");
        if (retry.status !== "ok") return;
        expect(retry.value).toMatchObject({ id: entryId, createdAt: "2026-06-01T00:00:00.000Z" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("removes a deterministic target corrupted while acknowledgement directory sync throws", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const entryId = id("w");
      const stage = join(dir, "prepared");
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => entryId,
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish: (tempPath, targetPath) => {
            compilerArtifactCatalogNodeFileOps.publish(tempPath, targetPath);
            const corrupt = JSON.parse(readFileSync(targetPath, "utf8"));
            corrupt.artifact.payload.draft.moduleId = "corrupt-during-failed-acknowledgement";
            writeFileSync(targetPath, JSON.stringify(corrupt));
          },
          syncDirectory: (path) => {
            if (path === stage) throw new Error("stage sync failed after target corruption");
          },
        },
      });
      expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE" });
      expect(catalog.loadPrepared(entryId)).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not delete a pre-existing or hard-link race winner when acknowledgement sync fails", async () => {
    const fixture = await compiledModuleHttpFixture();
    for (const outcome of ["pre-existing", "race-winner"] as const) {
      const dir = root();
      try {
        const stage = join(dir, "prepared");
        const entryId = id(outcome === "pre-existing" ? "t" : "u");
        if (outcome === "pre-existing") {
          expect(new CompilerArtifactCatalog({ root: dir, generateId: () => entryId }).savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "ok" });
        }
        let removedTarget = false;
        const catalog = new CompilerArtifactCatalog({
          root: dir,
          generateId: () => entryId,
          fileOps: {
            ...compilerArtifactCatalogNodeFileOps,
            syncDirectory: (path) => {
              if (path === stage) throw new Error(`${outcome} acknowledgement sync failed`);
            },
            publish: (tempPath, targetPath) => {
              if (outcome === "pre-existing") return compilerArtifactCatalogNodeFileOps.publish(tempPath, targetPath);
              const winner = JSON.parse(readFileSync(tempPath, "utf8"));
              winner.createdAt = "2026-06-02T00:00:00.000Z";
              writeFileSync(targetPath, JSON.stringify(winner));
              throw new Error("hard-link target already exists");
            },
            remove: (path) => {
              if (path === join(stage, `${entryId}.json`)) removedTarget = true;
              compilerArtifactCatalogNodeFileOps.remove(path);
            },
          },
        });
        expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE", recovery: { stage: "prepared", id: entryId } });
        expect(removedTarget).toBe(false);
        expect(new CompilerArtifactCatalog({ root: dir }).loadPrepared(entryId)).toMatchObject({ status: "ok" });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("fails closed when owned-target cleanup durability also fails", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const entryId = id("v");
      const stage = join(dir, "prepared");
      let stageSyncs = 0;
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => entryId,
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish: (tempPath, targetPath) => {
            const corrupt = JSON.parse(readFileSync(tempPath, "utf8"));
            corrupt.artifact.payload.draft.moduleId = "corrupt-before-cleanup";
            writeFileSync(targetPath, JSON.stringify(corrupt));
          },
          remove: (path) => {
            if (path === join(stage, `${entryId}.json`)) throw new Error("cleanup remove failed");
            compilerArtifactCatalogNodeFileOps.remove(path);
          },
          syncDirectory: (path) => {
            if (path === stage && ++stageSyncs > 1) throw new Error("cleanup stage sync failed");
          },
        },
      });
      expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "indeterminate", code: "CATALOG_DURABILITY_INDETERMINATE" });
      expect(stageSyncs).toBeGreaterThanOrEqual(2);
      expect(catalog.loadPrepared(entryId)).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("round-trips immutable prepared artifacts and resolved bundles across catalog instances", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: dir, generateId: () => id("a") });
      const prepared = catalog.savePrepared(JSON.parse(JSON.stringify(fixture.prepared.artifact)));
      expect(prepared.status).toBe("ok");
      if (prepared.status !== "ok") return;
      const loadedPrepared = new CompilerArtifactCatalog({ root: dir }).loadPrepared(prepared.value.id);
      expect(loadedPrepared).toMatchObject({ status: "ok", value: { artifactHash: fixture.prepared.artifact.artifactHash } });
      const bundle = new CompilerArtifactCatalog({ root: dir, generateId: () => id("b") }).saveBundle(fixture.resolved.artifact, fixture.projection);
      expect(bundle.status).toBe("ok");
      if (bundle.status !== "ok") return;
      const loadedBundle = new CompilerArtifactCatalog({ root: dir }).loadBundle(bundle.value.id);
      expect(loadedBundle).toMatchObject({ status: "ok", value: { mechanicsHash: (fixture.resolved.artifact.payload as any).identity.mechanicsHash } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses malformed IDs, immutable collisions, quota overrun, and tampered entries", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: dir, generateId: () => id("c") });
      const first = catalog.savePrepared(fixture.prepared.artifact);
      expect(first.status).toBe("ok");
      expect(catalog.loadPrepared("../outside")).toMatchObject({ status: "refused", code: "CATALOG_ID_INVALID" });
      expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "ok" });
      const changed = structuredClone(fixture.prepared.artifact); (changed as any).artifactHash = "different";
      expect(catalog.savePrepared(changed)).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });
      const quota = new CompilerArtifactCatalog({ root: join(dir, "quota"), maxEntries: 0 });
      expect(quota.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_QUOTA_EXCEEDED" });
      expect(existsSync(join(dir, "quota", "prepared"))).toBe(true);
      if (first.status === "ok") {
        const path = join(dir, "prepared", `${first.value.id}.json`);
        const original = JSON.parse(await Bun.file(path).text());
        const unknownField = { ...original, unexpected: true }; writeFileSync(path, JSON.stringify(unknownField));
        expect(catalog.loadPrepared(first.value.id)).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });
        const wrongVersion = { ...original, schemaVersion: "0.0.0" }; writeFileSync(path, JSON.stringify(wrongVersion));
        expect(catalog.loadPrepared(first.value.id)).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });
        writeFileSync(path, "{");
        expect(catalog.loadPrepared(first.value.id)).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
        const raw = structuredClone(original); raw.artifact.payload.draft.moduleId = "tampered"; writeFileSync(path, JSON.stringify(raw));
        expect(catalog.loadPrepared(first.value.id)).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("serializes quota-boundary writers and does not expose partial temp files", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: dir, maxEntries: 1, generateId: (() => { let n = 0; return () => id(n++ ? "e" : "d"); })() });
      const [one, two] = await Promise.all([Promise.resolve(catalog.savePrepared(fixture.prepared.artifact)), Promise.resolve(catalog.savePrepared(fixture.prepared.artifact))]);
      expect([one, two].filter((result) => result.status === "ok")).toHaveLength(1);
      expect([one, two].filter((result) => result.status === "refused")).toMatchObject([{ code: "CATALOG_QUOTA_EXCEEDED" }]);
      writeFileSync(join(dir, "prepared", `${id("f")}.json.abandoned.tmp`), "{");
      expect(catalog.loadPrepared(id("f"))).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("cleans failed injected writes without publishing an entry", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: dir, generateId: () => id("g"), fileOps: { ...compilerArtifactCatalogNodeFileOps, flush: () => { throw new Error("flush failed"); } } });
      expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
      expect(catalog.loadPrepared(id("g"))).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a catalog root that is not a real directory", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const fileRoot = join(dir, "not-a-directory");
      writeFileSync(fileRoot, "not a directory");
      const catalog = new CompilerArtifactCatalog({ root: fileRoot });
      expect(catalog.savePrepared(fixture.prepared.artifact)).toMatchObject({ status: "refused", code: "CATALOG_STORAGE_FAILED" });
      expect(catalog.loadPrepared(id("h"))).toMatchObject({ status: "refused", code: "CATALOG_CORRUPT" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("allocates a fresh opaque review ID when its presentation-review stage already contains the candidate", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      let opaqueAttempt = 0;
      const catalog = new CompilerArtifactCatalog({
        root: dir,
        generateId: () => id("p"),
        generateOpaqueId: () => id(opaqueAttempt++ < 2 ? "r" : "s"),
      });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      expect(prepared.status).toBe("ok");
      if (prepared.status !== "ok") return;
      const bindings = exactReviewBindings(fixture.resolved.artifact.payload as any);
      const first = catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:one", bindings);
      expect(first).toMatchObject({ status: "ok", value: { id: id("r") } });
      const second = catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:two", bindings);
      expect(second).toMatchObject({ status: "ok", value: { id: id("s") } });
      if (first.status !== "ok" || second.status !== "ok") return;
      expect(catalog.loadTrustedPresentationReview(first.value.id)).toMatchObject({ status: "ok", value: { review: { reviewerPrincipalId: "operator:one" } } });
      expect(catalog.loadTrustedPresentationReview(second.value.id)).toMatchObject({ status: "ok", value: { review: { reviewerPrincipalId: "operator:two" } } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("publishes headerless module metadata only with explicit opaque disclosures, never the first heading", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: dir, generateOpaqueId: () => id("o") });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const moduleFields = ["title", "version", "era", "summary", "playerCount", "expectedDuration", "triggerWarnings"] as const;
      const bindings = [
        ...exactReviewBindings(fixture.resolved.artifact.payload as any).filter((binding) => !binding.fieldPath.startsWith("module.")),
        ...moduleFields.map((fieldPath) => ({ fieldPath: `module.${fieldPath}`, kind: "opaque_unavailable" })),
      ] as any;
      const saved = catalog.saveTrustedPresentationReview(
        prepared.value.id,
        fixture.prepared.artifact,
        fixture.resolved.artifact,
        "operator:opaque-module-metadata",
        bindings,
      );
      expect(saved.status).toBe("ok");
      if (saved.status !== "ok") return;
      const loaded = catalog.loadTrustedPresentationReview(saved.value.id);
      if (loaded.status !== "ok") throw new Error(loaded.message);
      const projection = projectTrustedResolvedCompilerArtifact(fixture.resolved.artifact.payload as any, loaded.value.review);
      if (projection.status === "refused") throw new Error(projection.message);
      const firstHeading = (fixture.resolved.artifact.payload as any).graph.statements.find((statement: any) => statement.kind === "heading")!;
      expect(projection.module).toMatchObject({ title: "", version: "", era: "", summary: "", meta: { playerCount: "", expectedDuration: "", triggerWarnings: [] } });
      expect(JSON.stringify({
        title: projection.module.title,
        version: projection.module.version,
        era: projection.module.era,
        summary: projection.module.summary,
        ...projection.module.meta,
      })).not.toContain(firstHeading.text);
      expect(projection.compiledPresentationDisclosure).toEqual({ opaqueUnavailableModuleFields: [...moduleFields].sort() });
      for (const field of moduleFields) {
        const origin = projection.sourceMap.module.fields[field]!;
        expect(origin).toMatchObject({ kind: "trusted_presentation_opaque", fieldPath: `module.${field}` });
        expect(JSON.stringify(origin)).not.toContain(firstHeading.id);
      }
      const bundle = catalog.saveBundle(fixture.resolved.artifact, projection);
      expect(bundle.status).toBe("ok");
      if (bundle.status !== "ok") return;
      const reloadedBundle = new CompilerArtifactCatalog({ root: dir }).loadBundle(bundle.value.id);
      if (reloadedBundle.status !== "ok") throw new Error(reloadedBundle.message);
      expect(reloadedBundle.value.projection.compiledPresentationDisclosure).toEqual(projection.compiledPresentationDisclosure);
      const session = new GameSession("opaque-headerless", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, "investigator", "Ada");
      expect(session.loadCompiledModule(fixture.resolved.artifact.payload as any, reloadedBundle.value.projection).status).toBe("loaded");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("requires one exact module disclosure per field and rejects binding or projection forgeries", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: dir });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const payload: any = fixture.resolved.artifact.payload;
      const firstHeading = payload.graph.statements.find((statement: any) => statement.kind === "heading")!;
      const baseBindings = exactReviewBindings(payload);
      const base = () => structuredClone(baseBindings);
      const save = (bindings: any[]) => catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:module-disclosures", bindings);

      const exactTitle = base().map((binding) => binding.fieldPath === "module.title"
        ? { kind: "source_exact", fieldPath: "module.title", statementId: firstHeading.id, quote: firstHeading.text, evidenceRefId: firstHeading.evidenceRefId, headingStatementId: firstHeading.id }
        : binding);
      const saved = save(exactTitle);
      expect(saved.status).toBe("ok");
      if (saved.status !== "ok") return;
      const loaded = catalog.loadTrustedPresentationReview(saved.value.id);
      if (loaded.status !== "ok") throw new Error(loaded.message);
      const projection = projectTrustedResolvedCompilerArtifact(payload, loaded.value.review);
      if (projection.status === "refused") throw new Error(projection.message);
      expect(projection.module.title).toBe(firstHeading.text);
      expect(projection.sourceMap.module.fields.title).toMatchObject({ kind: "trusted_presentation_review", quote: firstHeading.text, statements: [{ statementId: firstHeading.id }] });

      const missing = base().filter((binding) => binding.fieldPath !== "module.version");
      expect(save(missing)).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });
      const titleDisclosure = base().find((binding) => binding.fieldPath === "module.title")!;
      expect(save([...base(), structuredClone(titleDisclosure)])).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });
      expect(save([...base(), { kind: "opaque_unavailable", fieldPath: "module.forged" }])).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });

      const arbitraryText = base();
      const sourceExact = arbitraryText.find((binding) => binding.kind === "source_exact");
      if (!sourceExact || sourceExact.kind !== "source_exact") throw new Error("fixture has no source_exact review binding");
      sourceExact.quote = "reviewer-authored prose";
      expect(save(arbitraryText)).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });
      const pseudoSourceExact = base().map((binding) => binding.fieldPath === "module.title"
        ? { kind: "source_exact", fieldPath: "module.title", statementId: firstHeading.id }
        : binding);
      expect(save(pseudoSourceExact)).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });
      const opaqueWithFakeOrigin = base().map((binding) => binding.fieldPath === "module.title"
        ? { kind: "opaque_unavailable", fieldPath: "module.title", statementId: firstHeading.id }
        : binding);
      expect(save(opaqueWithFakeOrigin)).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });

      const disclosureTamper = structuredClone(projection);
      disclosureTamper.compiledPresentationDisclosure!.opaqueUnavailableModuleFields = [];
      expect(validateCanonicalCompilerModuleProjection(payload, disclosureTamper)).toMatchObject({ status: "refused", code: "PRESENTATION_METADATA_INVALID" });
      const hashTamper = structuredClone(projection);
      hashTamper.presentationReview!.reviewHash = "a".repeat(64);
      expect(validateCanonicalCompilerModuleProjection(payload, hashTamper)).toMatchObject({ status: "refused", code: "PRESENTATION_METADATA_INVALID" });
      const originTamper = structuredClone(projection);
      originTamper.sourceMap.module.fields.version = { kind: "trusted_presentation_opaque", reviewId: loaded.value.review.id, reviewHash: loaded.value.review.reviewHash, fieldPath: "module.version", disclosure: "forged" } as any;
      expect(validateCanonicalCompilerModuleProjection(payload, originTamper)).toMatchObject({ status: "refused", code: "PRESENTATION_METADATA_INVALID" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("records every trusted discovery label at its method path and rejects a tampered method origin on canonical replay", async () => {
    const dir = root();
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: dir, generateId: () => id("t"), generateOpaqueId: () => id("u") });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const saved = catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:method-origins", exactReviewBindings(fixture.resolved.artifact.payload as any));
      if (saved.status !== "ok") throw new Error(saved.message);
      const loaded = catalog.loadTrustedPresentationReview(saved.value.id);
      if (loaded.status !== "ok") throw new Error(loaded.message);
      const payload: any = fixture.resolved.artifact.payload;
      const projection = projectTrustedResolvedCompilerArtifact(payload, loaded.value.review);
      if (projection.status === "refused") throw new Error(projection.message);
      for (const method of payload.mechanicsIR.discoveryMethods) {
        const clue = payload.draft.clueCandidates.find((candidate: any) => candidate.id === method.clueId)!;
        const scene = projection.module.scenes.find((candidate) => candidate.id === clue.sceneCandidateId)!;
        const origin = projection.sourceMap.scenes[scene.id]!.clues[method.clueId]!.findMethods[method.id]!.fields.description;
        const reviewed = loaded.value.review.bindings.find((binding) => binding.fieldPath === `clues.${method.clueId}.findMethods.${method.id}.description`);
        if (!reviewed) {
          expect(origin).toMatchObject({
            kind: "artifact",
            artifactPath: `mechanics.discoveryMethods[${method.id}].compiler_derived_facet_guidance`,
          });
          continue;
        }
        if (reviewed.kind !== "source_exact") throw new Error("method description must be source_exact");
        expect(origin).toMatchObject({
          kind: "trusted_presentation_review",
          fieldPath: reviewed.fieldPath,
          quote: reviewed.quote,
          statements: [{ statementId: reviewed.statementId, evidenceRefId: reviewed.evidenceRefId }],
        });
      }
      const tampered = structuredClone(projection);
      const firstScene = tampered.module.scenes[0]!;
      const firstMethodId = Object.keys(tampered.sourceMap.scenes[firstScene.id]!.clues[firstScene.clues[0]!.id]!.findMethods)[0]!;
      (tampered.sourceMap.scenes[firstScene.id]!.clues[firstScene.clues[0]!.id]!.findMethods[firstMethodId]!.fields.description as any).quote = "tampered";
      expect(validateCanonicalCompilerModuleProjection(payload, tampered)).toMatchObject({ status: "refused", code: "PRESENTATION_METADATA_INVALID" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
