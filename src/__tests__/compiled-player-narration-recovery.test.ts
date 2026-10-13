import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompiledNarrationAdmissionCoordinator } from "../api/compiled-narration-admission";
import { CompiledNarrationLedger } from "../api/compiled-narration-ledger";
import { createCompiledSessionAccessBinding } from "../api/compiled-module-http";
import { CompiledSessionSnapshotStore, canonicalJson, validateCompiledSessionSnapshot } from "../api/compiled-session-snapshot";
import { GameSession, prepareCompiledDurableNarration } from "../api/game-session";
import { runCompiledActionTransaction } from "../api/server";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { buildTrustedPresentationReviewCandidatePage, projectTrustedResolvedCompilerArtifact } from "../compiler/compiler-module-data-projection";
import { sha256 } from "../ingest/document-ir";
import type { LLMLike } from "../llm/client";
import { compiledModuleHttpFixture, PAGES, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

async function narrationHarness(root: string, id: string) {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const saved = saveTrustedFixtureBundle(catalog, fixture);
  const bundle = catalog.loadBundle(saved.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
  const host = createCompiledDurableTestHost();
  const session = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined,
    { careerRoot: join(root, "careers") }, undefined, "preferred", host.runtimeDependencies);
  const loaded = session.loadDurableCompiledModule(bundle.value, createCompiledSessionAccessBinding(
    { id: `keeper:${id}`, role: "keeper" }, { id: `player:${id}`, role: "player" },
  ));
  if (loaded.status === "refused") throw new Error(loaded.message);
  const g0 = host.snapshot(session);
  if (snapshots.save(g0).status !== "ok") throw new Error("could not save g0");
  host.acknowledge(session, g0);
  const action = session.getCompiledAvailableActions()[0];
  if (!action) throw new Error("fixture must offer a compiled action");
  return { catalog, bundle: bundle.value, snapshots, host, session, action };
}

function exactReviewBinding(payload: any, fieldPath: string, exactText: string) {
  for (let offset = 0; ; offset += 8) {
    const page = buildTrustedPresentationReviewCandidatePage(payload, fieldPath, offset);
    if (page.status === "refused") throw new Error(page.message);
    const candidate = page.page.candidates.find((value) => value.exactText === exactText);
    if (candidate) return candidate.binding;
    if (!page.page.hasMore) break;
  }
  throw new Error(`source fixture lacks exact presentation candidate for ${fieldPath}`);
}

/** This remains a source-reviewed bundle: the only special presentation fact
 * is its exact source year, needed to exercise the durable receipt guard. */
async function sourceEraNarrationHarness(root: string, id: string) {
  const fixture = await compiledModuleHttpFixture(id, [`${PAGES[0]}\n1893`]);
  const payload: any = fixture.resolved.artifact.payload;
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const prepared = catalog.savePrepared(fixture.prepared.artifact);
  if (prepared.status !== "ok") throw new Error(prepared.message);
  const bindings = exactReviewBindings(payload).map((binding) =>
    binding.fieldPath === "module.era" ? exactReviewBinding(payload, binding.fieldPath, "1893") : binding,
  );
  const review = catalog.saveTrustedPresentationReview(
    prepared.value.id,
    fixture.prepared.artifact,
    fixture.resolved.artifact,
    "operator:receipt-semantic-guard",
    bindings,
  );
  if (review.status !== "ok") throw new Error(review.message);
  const loadedReview = catalog.loadTrustedPresentationReview(review.value.id);
  if (loadedReview.status !== "ok") throw new Error(loadedReview.message);
  const projection = projectTrustedResolvedCompilerArtifact(payload, loadedReview.value.review);
  if (projection.status === "refused") throw new Error(projection.message);
  if (projection.module.era !== "1893") throw new Error("receipt fixture requires the exact source-reviewed year");
  const saved = catalog.saveBundle(fixture.resolved.artifact, projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  const bundle = catalog.loadBundle(saved.value.id);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
  const host = createCompiledDurableTestHost();
  const session = new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada", undefined,
    { careerRoot: join(root, "careers") }, undefined, "preferred", host.runtimeDependencies);
  const loaded = session.loadDurableCompiledModule(bundle.value, createCompiledSessionAccessBinding(
    { id: `keeper:${id}`, role: "keeper" }, { id: `player:${id}`, role: "player" },
  ));
  if (loaded.status === "refused") throw new Error(loaded.message);
  const g0 = host.snapshot(session);
  if (snapshots.save(g0).status !== "ok") throw new Error("could not save g0");
  host.acknowledge(session, g0);
  const action = session.getCompiledAvailableActions()[0];
  if (!action) throw new Error("fixture must offer a compiled action");
  return { catalog, bundle: bundle.value, snapshots, host, session, action, g0 };
}

describe("compiled player narration receipt recovery", () => {
  it("does not dispatch a provider call after its generation lease expires before the fenced transition", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-fence-"));
    let session: GameSession | undefined;
    try {
      const built = await narrationHarness(root, "compiled-player-narration-fence");
      session = built.session;
      let now = 0;
      const ledger = new CompiledNarrationLedger(join(root, "ledger"));
      const originalSave = ledger.savePrepared.bind(ledger);
      ledger.savePrepared = (candidate) => {
        now = 10;
        return originalSave(candidate);
      };
      let calls = 0;
      const narrator: LLMLike = { async chat() { calls += 1; return '{"text":"must not be called"}'; } };
      const result = await runCompiledActionTransaction(session, {
        input: built.action.command, pcId: "p1", actionId: "expired-before-dispatch", expectedGeneration: 0,
      }, {
        catalog: built.catalog, snapshots: built.snapshots, sessionRegistry: new Map([[session.id, session]]), diagnostics: new Map(),
        storage: { careerRoot: join(root, "tx-careers") }, compiledDurableHostCapability: built.host.capability,
        narration: {
          llm: narrator,
          admission: new CompiledNarrationAdmissionCoordinator(ledger.root, { leaseTtlMs: 5, now: () => now }),
          ledger,
        },
      });
      expect(result.status).toBe(503);
      expect(calls).toBe(0);
      expect(session.getCompiledGeneration()).toBe(0);
    } finally {
      session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers only an exact prepared candidate after its matching lease expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-prepared-recovery-"));
    let session: GameSession | undefined;
    try {
      const built = await narrationHarness(root, "compiled-player-narration-prepared-recovery");
      session = built.session;
      const body = { input: built.action.command, pcId: "p1", actionId: "prepared-exact-recovery", expectedGeneration: 0 } as const;
      const prepared = prepareCompiledDurableNarration(session, built.host.capability, body.input, body.actionId, body.expectedGeneration);
      if (prepared.status !== "prepared") throw new Error("narration candidate was not prepared");
      const ledger = new CompiledNarrationLedger(join(root, "ledger"));
      expect(ledger.savePrepared(prepared.candidate).status).toBe("stored");
      let now = 0;
      const admission = new CompiledNarrationAdmissionCoordinator(ledger.root, { leaseTtlMs: 5, now: () => now });
      const requestHash = sha256(JSON.stringify({
        domain: "compiled-player-narration-admission-request-v1",
        input: body.input,
        actionId: body.actionId,
        expectedGeneration: body.expectedGeneration,
      }));
      const originalLease = admission.acquire({ sessionId: session.id, expectedGeneration: 0, actionId: body.actionId, requestHash });
      expect(originalLease.status).toBe("acquired");
      now = 10;
      // Observing the stale lease quarantines its *original* exact binding.
      // A distinct opaque request must not be permitted to clear it.
      expect(admission.acquire({ sessionId: session.id, expectedGeneration: 0, actionId: body.actionId, requestHash: "b".repeat(64) }).status).not.toBe("acquired");
      expect(admission.recoverPrepared({ sessionId: session.id, expectedGeneration: 0, actionId: body.actionId, requestHash: "b".repeat(64) })).toBe(false);
      let calls = 0;
      const narrator: LLMLike = { async chat() { calls += 1; return '{"text":"Ada resumes from the prepared threshold."}'; } };
      const result = await runCompiledActionTransaction(session, body, {
        catalog: built.catalog, snapshots: built.snapshots, sessionRegistry: new Map([[session.id, session]]), diagnostics: new Map(),
        storage: { careerRoot: join(root, "tx-careers") }, compiledDurableHostCapability: built.host.capability,
        narration: { llm: narrator, admission, ledger },
      });
      expect(result.status).toBe(200);
      expect(calls).toBe(1);
      expect(result.session?.getCompiledPlayerFacadeView().turn).toEqual({ generation: 1, text: "Ada resumes from the prepared threshold." });
    } finally {
      session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a syntactically valid but source-invalid durable receipt after g0 restore without a provider retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-semantic-receipt-"));
    let source: GameSession | undefined;
    let restored: GameSession | undefined;
    try {
      const built = await sourceEraNarrationHarness(root, "compiled-player-narration-semantic-receipt");
      source = built.session;
      const actionId = "semantic-receipt-invalid";
      const prepared = prepareCompiledDurableNarration(source, built.host.capability, built.action.command, actionId, 0);
      if (prepared.status !== "prepared") throw new Error("semantic receipt fixture was not prepared");
      const ledger = new CompiledNarrationLedger(join(root, "ledger"));
      expect(ledger.savePrepared(prepared.candidate).status).toBe("stored");
      expect(ledger.markDispatching(prepared.candidate).status).toBe("stored");
      // The record is wire-valid and receipt-hashed, but a 1893 source bundle
      // does not authorize an unreviewed mobile phone. This models a durable
      // store compromised after receipt persistence, not a parser failure.
      expect(ledger.saveReceipt(prepared.candidate, { schemaVersion: "1.0.0", text: "手机在黑暗中响起。" }).status).toBe("stored");
      expect(ledger.read(source.id, actionId)).toMatchObject({
        status: "ok",
        value: { state: "receipt", narration: { schemaVersion: "1.0.0", text: "手机在黑暗中响起。" } },
      });
      source.close();
      source = undefined;

      const restoredHost = createCompiledDurableTestHost();
      restored = new GameSession(
        "compiled-player-narration-semantic-receipt", "cosmic-horror", CONFIG, undefined, undefined, undefined,
        { careerRoot: join(root, "restored-careers") }, undefined, "preferred", restoredHost.runtimeDependencies,
      );
      expect(restored.restoreCompiledSession(built.g0, built.bundle).status).toBe("loaded");
      let calls = 0;
      const narrator: LLMLike = { async chat() { calls += 1; return '{"text":"must not be called"}'; } };
      const request = { input: built.action.command, pcId: "p1", actionId, expectedGeneration: 0 } as const;
      const options = {
        catalog: built.catalog,
        snapshots: built.snapshots,
        sessionRegistry: new Map([[restored.id, restored]]),
        diagnostics: new Map(),
        storage: { careerRoot: join(root, "recovery-careers") },
        compiledDurableHostCapability: restoredHost.capability,
        narration: { llm: narrator, admission: new CompiledNarrationAdmissionCoordinator(ledger.root), ledger },
      };
      const first = await runCompiledActionTransaction(restored, request, options);
      expect(first.body).toMatchObject({ code: "compiled_narration_invalid" });
      expect([422, 503]).toContain(first.status);
      const retry = await runCompiledActionTransaction(restored, request, options);
      expect(retry.body).toMatchObject({ code: "compiled_narration_invalid" });
      expect([422, 503]).toContain(retry.status);
      expect(calls).toBe(0);
      expect(restored.getCompiledGeneration()).toBe(0);
      const persisted = built.snapshots.read(restored.id);
      if (persisted.status !== "ok") throw new Error(persisted.message);
      const checked = validateCompiledSessionSnapshot(persisted.value);
      if (checked.status !== "ok") throw new Error(checked.message);
      expect(checked.value.generation).toBe(0);
      expect(checked.value.idempotency.some((record) => record.response.action.playerNarration !== undefined)).toBe(false);
      expect(ledger.read(restored.id, actionId)).toMatchObject({ status: "ok", value: { state: "receipt" } });
    } finally {
      source?.close();
      restored?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("retains a receipt after a busy snapshot CAS and commits that exact receipt without another provider call", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-busy-recovery-"));
    let session: GameSession | undefined;
    let replacement: GameSession | undefined;
    try {
      const built = await narrationHarness(root, "compiled-player-narration-busy");
      session = built.session;
      const ledger = new CompiledNarrationLedger(join(root, "ledger"));
      const admission = new CompiledNarrationAdmissionCoordinator(ledger.root);
      let calls = 0;
      const narrator: LLMLike = { async chat() { calls += 1; return '{"text":"Ada keeps to the reviewed path."}'; } };
      const originalSave = built.snapshots.save.bind(built.snapshots);
      let failOnce = true;
      (built.snapshots as unknown as { save: typeof built.snapshots.save }).save = ((snapshot: Parameters<typeof built.snapshots.save>[0], ...rest: unknown[]) => {
        if (failOnce) {
          failOnce = false;
          return { status: "refused", code: "SNAPSHOT_BUSY", message: "test busy", sessionId: session!.id };
        }
        return (originalSave as (...args: unknown[]) => ReturnType<typeof built.snapshots.save>)(snapshot, ...rest);
      }) as typeof built.snapshots.save;
      const options = {
        catalog: built.catalog, snapshots: built.snapshots, sessionRegistry: new Map([[session.id, session]]), diagnostics: new Map(),
        storage: { careerRoot: join(root, "tx-careers") }, compiledDurableHostCapability: built.host.capability,
        createRecoverySession: ({ id }: { id: string }) => {
          replacement = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
            { careerRoot: join(root, "recovered-careers") }, undefined, "preferred", built.host.runtimeDependencies);
          return replacement;
        },
        narration: { llm: narrator, admission, ledger },
      };
      const body = { input: built.action.command, pcId: "p1", actionId: "receipt-busy-recovery", expectedGeneration: 0 } as const;
      const first = await runCompiledActionTransaction(session, body, options);
      expect(first.status).toBe(503);
      expect(calls).toBe(1);
      expect(ledger.read(session.id, "receipt-busy-recovery")).toMatchObject({ status: "ok", value: { state: "receipt" } });
      const second = await runCompiledActionTransaction(session, body, options);
      expect(second.status).toBe(200);
      expect(calls).toBe(1);
      expect(second.session?.getCompiledPlayerFacadeView().turn).toEqual({ generation: 1, text: "Ada keeps to the reviewed path." });
    } finally {
      session?.close();
      replacement?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a receipt when its fenced write acknowledgement is indeterminate", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-receipt-fence-"));
    let session: GameSession | undefined;
    let replacement: GameSession | undefined;
    try {
      const built = await narrationHarness(root, "compiled-player-narration-receipt-fence");
      session = built.session;
      const ledger = new CompiledNarrationLedger(join(root, "ledger"));
      const admission = new CompiledNarrationAdmissionCoordinator(ledger.root);
      const originalAcquire = admission.acquire.bind(admission);
      let fencedWrites = 0;
      admission.acquire = (input) => {
        const lease = originalAcquire(input);
        if (lease.status !== "acquired") return lease;
        const originalFence = lease.withActiveFence;
        lease.withActiveFence = (operation) => {
          const outcome = originalFence(operation);
          fencedWrites += 1;
          return fencedWrites === 2 && outcome.status === "executed"
            ? { status: "indeterminate", code: "ORDINARY_ACTION_INDETERMINATE", retryAfterSeconds: 60, value: outcome.value }
            : outcome;
        };
        return lease;
      };
      let calls = 0;
      const narrator: LLMLike = { async chat() { calls += 1; return '{"text":"Ada waits for the durable result."}'; } };
      const body = { input: built.action.command, pcId: "p1", actionId: "receipt-fence-recovery", expectedGeneration: 0 } as const;
      const options = {
        catalog: built.catalog, snapshots: built.snapshots, sessionRegistry: new Map([[session.id, session]]), diagnostics: new Map(),
        storage: { careerRoot: join(root, "tx-careers") }, compiledDurableHostCapability: built.host.capability,
        createRecoverySession: ({ id }: { id: string }) => {
          replacement = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
            { careerRoot: join(root, "recovered-careers") }, undefined, "preferred", built.host.runtimeDependencies);
          return replacement;
        },
        narration: { llm: narrator, admission, ledger },
      };
      const first = await runCompiledActionTransaction(session, body, options);
      expect(first.status).toBe(503);
      expect(calls).toBe(1);
      expect(ledger.read(session.id, body.actionId)).toMatchObject({ status: "ok", value: { state: "receipt" } });
      const second = await runCompiledActionTransaction(session, body, options);
      expect(second.status).toBe(200);
      expect(calls).toBe(1);
      expect(second.session?.getCompiledPlayerFacadeView().turn).toEqual({ generation: 1, text: "Ada waits for the durable result." });
    } finally {
      session?.close();
      replacement?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a receipt when durable persistence succeeds but live installation throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-install-recovery-"));
    let session: GameSession | undefined;
    let resumed: GameSession | undefined;
    const replacements = new Set<GameSession>();
    try {
      const built = await narrationHarness(root, "compiled-player-narration-install-recovery");
      session = built.session;
      const ledger = new CompiledNarrationLedger(join(root, "ledger"));
      const admission = new CompiledNarrationAdmissionCoordinator(ledger.root);
      let calls = 0;
      let rejectLiveInstall = true;
      const narrator: LLMLike = { async chat() { calls += 1; return '{"text":"Ada keeps the exact durable account."}'; } };
      const body = { input: built.action.command, pcId: "p1", actionId: "receipt-install-recovery", expectedGeneration: 0 } as const;
      const options = {
        catalog: built.catalog, snapshots: built.snapshots, sessionRegistry: new Map([[session.id, session]]), diagnostics: new Map(),
        storage: { careerRoot: join(root, "tx-careers") }, compiledDurableHostCapability: built.host.capability,
        createRecoverySession: ({ id }: { id: string }) => {
          const replacement = new GameSession(id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
            { careerRoot: join(root, "recovered-careers") }, undefined, "preferred", built.host.runtimeDependencies);
          if (rejectLiveInstall) replacement.restoreCompiledSession = () => { throw new Error("test live install failure"); };
          replacements.add(replacement);
          return replacement;
        },
        narration: { llm: narrator, admission, ledger },
      };
      const first = await runCompiledActionTransaction(session, body, options);
      expect(first.status).toBe(503);
      expect(calls).toBe(1);
      expect(ledger.read(session.id, body.actionId)).toMatchObject({ status: "ok", value: { state: "receipt" } });
      const persisted = built.snapshots.read(session.id);
      if (persisted.status !== "ok") throw new Error(persisted.message);
      const checked = validateCompiledSessionSnapshot(persisted.value);
      if (checked.status !== "ok") throw new Error(checked.message);

      // The first worker lost its live object after the persisted CAS. A
      // restart may consume this exact receipt, but must not call the model.
      rejectLiveInstall = false;
      resumed = new GameSession(session.id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
        { careerRoot: join(root, "resumed-careers") }, undefined, "preferred", built.host.runtimeDependencies);
      expect(resumed.restoreCompiledSession(checked.value, built.bundle).status).toBe("loaded");
      const second = await runCompiledActionTransaction(resumed, body, {
        ...options,
        sessionRegistry: new Map([[resumed.id, resumed]]),
      });
      expect(second.status).toBe(200);
      expect(calls).toBe(1);
      expect(second.session?.getCompiledPlayerFacadeView().turn).toEqual({ generation: 1, text: "Ada keeps the exact durable account." });
      expect(ledger.read(resumed.id, body.actionId)).toMatchObject({ status: "ok", value: { state: "committed" } });
    } finally {
      session?.close();
      resumed?.close();
      for (const replacement of replacements) replacement.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits a durable receipt after restart without re-preparing or invoking a provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-recovery-"));
    let source: GameSession | undefined;
    let restored: GameSession | undefined;
    let replacement: GameSession | undefined;
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = saveTrustedFixtureBundle(catalog, fixture);
      const bundle = catalog.loadBundle(saved.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
      const sourceHost = createCompiledDurableTestHost();
      source = new GameSession(
        "compiled-player-narration-receipt", "cosmic-horror", CONFIG, "investigator", "Ada", undefined,
        { careerRoot: join(root, "careers") }, undefined, "preferred", sourceHost.runtimeDependencies,
      );
      const loaded = source.loadDurableCompiledModule(bundle.value, createCompiledSessionAccessBinding(
        { id: "keeper:narration-recovery", role: "keeper" },
        { id: "player:narration-recovery", role: "player" },
      ));
      if (loaded.status === "refused") throw new Error(loaded.message);
      const g0 = sourceHost.snapshot(source);
      expect(snapshots.save(g0)).toMatchObject({ status: "ok" });
      sourceHost.acknowledge(source, g0);
      const action = source.getCompiledAvailableActions()[0];
      if (!action) throw new Error("fixture must offer a compiled action");
      const prepared = prepareCompiledDurableNarration(source, sourceHost.capability, action.command, "receipt-before-snapshot", 0);
      if (prepared.status !== "prepared") throw new Error("narration candidate was not prepared");

      const tampered = structuredClone(prepared.candidate);
      Object.assign(tampered.frame.before, { hiddenClue: "private source-only fact" });
      tampered.frameHash = sha256(canonicalJson(tampered.frame));
      tampered.candidateHash = sha256(canonicalJson({
        domain: "compiled-narration-candidate-v1",
        sessionId: tampered.sessionId,
        bundleId: tampered.bundleId,
        actionId: tampered.actionId,
        expectedGeneration: tampered.expectedGeneration,
        nextGeneration: tampered.nextGeneration,
        predecessorSnapshotHash: tampered.predecessorSnapshotHash,
        requestHash: tampered.requestHash,
        playerRequestHash: tampered.playerRequestHash,
        frameHash: tampered.frameHash,
        snapshotHash: tampered.snapshot.snapshotHash,
      }));
      const tamperedRoot = join(root, "tampered-ledger");
      const tamperedLedger = new CompiledNarrationLedger(tamperedRoot);
      expect(tamperedLedger.savePrepared(tampered).status).toBe("stored");
      let tamperedCalls = 0;
      const narrator: LLMLike = { async chat() { tamperedCalls += 1; return '{"text":"must not be called"}'; } };
      const tamperedResult = await runCompiledActionTransaction(source, {
        input: action.command, pcId: "p1", actionId: "receipt-before-snapshot", expectedGeneration: 0,
      }, {
        catalog, snapshots, sessionRegistry: new Map([[source.id, source]]), diagnostics: new Map(), storage: { careerRoot: join(root, "tampered-careers") },
        compiledDurableHostCapability: sourceHost.capability,
        narration: { llm: narrator, admission: new CompiledNarrationAdmissionCoordinator(tamperedRoot), ledger: tamperedLedger },
      });
      expect(tamperedResult.status).toBe(503);
      expect(tamperedCalls).toBe(0);

      const ledger = new CompiledNarrationLedger(snapshots.root);
      // Simulate the exact crash window: the provider receipt was written
      // under a live generation lease, but the process died before snapshot
      // CAS/release. A restart must consume the receipt, not take over this
      // lingering provider lease or issue another request.
      const admission = new CompiledNarrationAdmissionCoordinator(snapshots.root);
      const lease = admission.acquire({ sessionId: source.id, expectedGeneration: 0, actionId: "receipt-before-snapshot", requestHash: "a".repeat(64) });
      if (lease.status !== "acquired") throw new Error("receipt fixture could not acquire its narration lease");
      expect(ledger.savePrepared(prepared.candidate).status).toBe("stored");
      expect(ledger.markDispatching(prepared.candidate).status).toBe("stored");
      const receipt = lease.withActiveFence(() => ledger.saveReceipt(prepared.candidate, { schemaVersion: "1.0.0", text: "Ada pauses at the reviewed threshold." }));
      expect(receipt).toMatchObject({ status: "executed", value: { status: "stored" } });
      source.close();
      source = undefined;

      const restoredHost = createCompiledDurableTestHost();
      restored = new GameSession(
        "compiled-player-narration-receipt", "cosmic-horror", CONFIG, undefined, undefined, undefined,
        { careerRoot: join(root, "restored-careers") }, undefined, "preferred", restoredHost.runtimeDependencies,
      );
      expect(restored.restoreCompiledSession(g0, bundle.value).status).toBe("loaded");
      const registry = new Map([[restored.id, restored]]);
      const result = await runCompiledActionTransaction(restored, {
          input: action.command,
          pcId: "p1",
          actionId: "receipt-before-snapshot",
          expectedGeneration: 0,
        }, {
          catalog,
          snapshots,
          sessionRegistry: registry,
          diagnostics: new Map(),
          storage: { careerRoot: join(root, "recovery-careers") },
          compiledDurableHostCapability: restoredHost.capability,
          createRecoverySession: ({ id }) => {
            replacement = new GameSession(
              id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
              { careerRoot: join(root, "recovered-careers") }, undefined, "preferred", restoredHost.runtimeDependencies,
            );
            return replacement;
          },
          narration: {
            admission: new CompiledNarrationAdmissionCoordinator(snapshots.root),
            ledger,
          },
        });
      expect(result.status).toBe(200);
        expect(result.body.playerNarration).toEqual({ schemaVersion: "1.0.0", text: "Ada pauses at the reviewed threshold." });
        expect(result.session?.getCompiledPlayerFacadeView().turn).toEqual({ generation: 1, text: "Ada pauses at the reviewed threshold." });
      const stored = snapshots.read("compiled-player-narration-receipt");
      if (stored.status !== "ok") throw new Error(stored.message);
      const checkedStored = validateCompiledSessionSnapshot(stored.value);
      if (checkedStored.status !== "ok") throw new Error(checkedStored.message);
      expect(checkedStored.value.trace).toEqual(prepared.candidate.snapshot.trace);
      expect(checkedStored.value.state).toEqual(prepared.candidate.snapshot.state);
      expect(ledger.read("compiled-player-narration-receipt", "receipt-before-snapshot")).toMatchObject({ status: "ok", value: { state: "committed" } });
    } finally {
      source?.close();
      restored?.close();
      if (replacement && replacement !== restored) replacement.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
