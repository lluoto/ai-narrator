import { describe, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { type CompilerRequestAuthenticator, type CompiledWorldModelBindingResolver } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture, hints } from "./helpers/compiled-module-http-fixture";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";
import { createCompiledCthulhuWorldModelBinding, type CompiledCthulhuWorldModelBinding } from "../world/compiled-world-model-scope";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { isolatedProviderSeamIt } from "./helpers/provider-seam-child";

const DATASET_ROOT = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";
const KP_CAPTURE_CONFIG = {
  apiKey: "test-kp-capture-key",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

const operator: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { id: "operator:compiled-http-world-isolation", role: "operator" },
});

type CreatedSession = { sessionId: string; bundleId: string };
type OpeningProof = {
  prompt: string;
  receipt: NonNullable<ReturnType<GameSession["getCompiledWorldModelPromptReceipt"]>>;
};

function noBindingLeaks(value: unknown, binding: CompiledCthulhuWorldModelBinding): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain(binding.datasetRoot);
  expect(json).not.toContain("worldModelBinding");
  expect(json).not.toContain("datasetRoot");
}

/**
 * This is a deterministic in-process KP provider. It replaces fetch only for
 * the consumer call, so neither the configured provider nor a network socket
 * can be reached while preserving the actual LLM request shape for inspection.
 */
async function captureOpening(session: GameSession): Promise<OpeningProof> {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ messages?: Array<{ role?: unknown; content?: unknown }> }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("KP request body was not JSON text");
    requests.push(JSON.parse(init.body) as { messages?: Array<{ role?: unknown; content?: unknown }> });
    return new Response(JSON.stringify({ choices: [{ message: { content: "deterministic local KP scene" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    expect(await session.getOpeningScene()).toBe("deterministic local KP scene");
  } finally {
    globalThis.fetch = previousFetch;
  }
  expect(requests).toHaveLength(1);
  const prompt = (requests[0]?.messages ?? [])
    .filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => message.content as string)
    .join("\n");
  const receipt = session.getCompiledWorldModelPromptReceipt();
  if (!receipt) throw new Error("compiled opening did not retain a world-model receipt");
  return { prompt, receipt };
}

function assertScopedOpening(
  proof: OpeningProof,
  binding: CompiledCthulhuWorldModelBinding,
  workId: "the_call_of_cthulhu" | "the_dunwich_horror",
  otherWorkId: "the_call_of_cthulhu" | "the_dunwich_horror",
): void {
  expect(proof.receipt.scopeHash).toBe(binding.scopeHash);
  expect(proof.receipt.provenance.length).toBeGreaterThan(0);
  expect(new Set(proof.receipt.provenance.map((entry) => entry.workId))).toEqual(new Set([workId]));
  // The work-qualified prompt line is an observable A/B marker in addition
  // to the opaque receipt. This proves the KP consumer did not receive the
  // other module's data while still keeping the binding off HTTP responses.
  expect(proof.prompt).toContain(`[${workId}/`);
  expect(proof.prompt).not.toContain(`[${otherWorkId}/`);
  expect(proof.prompt).not.toContain(binding.datasetRoot);
}

const providerSeamIt = isolatedProviderSeamIt("src/__tests__/compiled-http-world-model-isolation.test.ts");

describe("compiled HTTP world-model isolation", () => {
  providerSeamIt("keeps two server-bound work scopes through publication, action replacement, and a fresh recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-world-isolation-"));
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
    const ids = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ];
    const registry = new Map<string, GameSession>();
    let freshRegistry: Map<string, GameSession> | undefined;
    const initialHost = createCompiledDurableTestHost();
    const resolverCalls: Array<{ moduleId: string; artifactHash: string; documentHash: string | null }> = [];

    const close = (sessions: ReadonlyMap<string, GameSession>) => {
      for (const session of sessions.values()) session.close();
      if (sessions instanceof Map) sessions.clear();
    };

    try {
      const aFixture = await compiledModuleHttpFixture("http-world-a");
      const bFixture = await compiledModuleHttpFixture("http-world-b");
      const aBinding = createCompiledCthulhuWorldModelBinding({
        moduleId: "http-world-a",
        artifactHash: aFixture.resolved.artifact.artifactHash,
        datasetRoot: DATASET_ROOT,
        allowedWorkIds: ["the_call_of_cthulhu"],
        transferPolicy: "analogy_only",
      });
      const bBinding = createCompiledCthulhuWorldModelBinding({
        moduleId: "http-world-b",
        artifactHash: bFixture.resolved.artifact.artifactHash,
        datasetRoot: DATASET_ROOT,
        allowedWorkIds: ["the_dunwich_horror"],
        transferPolicy: "analogy_only",
      });
      const bindingByArtifact = new Map([
        [aBinding.artifactHash, aBinding],
        [bBinding.artifactHash, bBinding],
      ]);
      const resolver: CompiledWorldModelBindingResolver = (identity) => {
        resolverCalls.push({ ...identity });
        return bindingByArtifact.get(identity.artifactHash);
      };

      const runtime = (targetRegistry: Map<string, GameSession>, capability: object): SessionRuntimeDependencies => ({
        registry: targetRegistry,
        generateCompiledSessionId: () => ids.shift() ?? "10000000-0000-4000-8000-0000000000ff",
        compiledDurableHostCapability: capability,
        resolveCompiledWorldModelBinding: resolver,
        // The installed/recovered object, rather than a test-built child, is
        // the GameSession on which the existing KP consumer is exercised.
        createCompiledRecoverySession: ({ id, storage, runtimeDependencies }) => new GameSession(
          id,
          "cosmic-horror",
          KP_CAPTURE_CONFIG,
          undefined,
          undefined,
          undefined,
          storage,
          undefined,
          "preferred",
          runtimeDependencies,
        ),
      });

      const request = (path: string, init: RequestInit = {}, targetRegistry = registry, capability = initialHost.capability) =>
        handleRequest(
          new Request(`http://test${path}`, init),
          catalog,
          snapshots,
          { careerRoot: join(root, "careers") },
          {},
          {},
          operator,
          undefined,
          undefined,
          undefined,
          undefined,
          runtime(targetRegistry, capability),
        );

      // A uses the actual HTTP resolve/publication route. Its resolver input
      // is the catalog-restored, validated resolved identity, not request
      // supplied binding data.
      const aPrepared = catalog.savePrepared(aFixture.prepared.artifact);
      if (aPrepared.status !== "ok") throw new Error(aPrepared.message);
      const aReview = catalog.saveTrustedPresentationReview(
        aPrepared.value.id,
        aFixture.prepared.artifact,
        aFixture.resolved.artifact,
        "operator:compiled-http-world-isolation",
        exactReviewBindings(aFixture.resolved.artifact.payload as any),
      );
      if (aReview.status !== "ok") throw new Error(aReview.message);
      const publishedA = await request("/api/compiler/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: aPrepared.value.id,
          preparedQueueHash: aFixture.prepared.identity.preparedQueueHash,
          hints: hints(aFixture.prepared),
          presentationReviewId: aReview.value.id,
        }),
      });
      expect(publishedA.status).toBe(200);
      const publishedABody = await publishedA.json() as { bundleId: string };
      noBindingLeaks(publishedABody, aBinding);
      expect(catalog.loadBundle(publishedABody.bundleId)).toMatchObject({
        status: "ok",
        value: { worldModelBinding: { scopeHash: aBinding.scopeHash, allowedWorkIds: ["the_call_of_cthulhu"] } },
      });

      // B follows the same reviewed resolve/publication boundary before a
      // bundle-ID session create. Its server-owned binding must remain a
      // catalog fact rather than an ephemeral request/session attachment.
      const bPrepared = catalog.savePrepared(bFixture.prepared.artifact);
      if (bPrepared.status !== "ok") throw new Error(bPrepared.message);
      const bReview = catalog.saveTrustedPresentationReview(
        bPrepared.value.id,
        bFixture.prepared.artifact,
        bFixture.resolved.artifact,
        "operator:compiled-http-world-isolation",
        exactReviewBindings(bFixture.resolved.artifact.payload as any),
      );
      if (bReview.status !== "ok") throw new Error(bReview.message);
      const publishedB = await request("/api/compiler/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: bPrepared.value.id,
          preparedQueueHash: bFixture.prepared.identity.preparedQueueHash,
          hints: hints(bFixture.prepared),
          presentationReviewId: bReview.value.id,
        }),
      });
      expect(publishedB.status).toBe(200);
      const publishedBBody = await publishedB.json() as { bundleId: string };
      const fromBundleB = await request("/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId: publishedBBody.bundleId, archetype: "investigator", characterName: "Bryn" }),
      });
      expect(fromBundleB.status).toBe(201);
      const b = await fromBundleB.json() as CreatedSession;
      noBindingLeaks(b, bBinding);
      expect(catalog.loadBundle(b.bundleId)).toMatchObject({
        status: "ok",
        value: { worldModelBinding: { scopeHash: bBinding.scopeHash, allowedWorkIds: ["the_dunwich_horror"] } },
      });

      // Creating A from its published bundle intentionally must not resolve
      // a binding again: the signed catalog body is the only restore input.
      const fromBundleA = await request("/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId: publishedABody.bundleId, archetype: "investigator", characterName: "Ada" }),
      });
      expect(fromBundleA.status).toBe(201);
      const a = await fromBundleA.json() as CreatedSession;
      noBindingLeaks(a, aBinding);
      expect(resolverCalls).toEqual([
        { moduleId: "http-world-a", artifactHash: aBinding.artifactHash, documentHash: aFixture.resolved.identity.documentHash },
        { moduleId: "http-world-b", artifactHash: bBinding.artifactHash, documentHash: bFixture.resolved.identity.documentHash },
      ]);

      const bundleReadA = await request(`/api/compiler/bundles/${a.bundleId}`);
      expect(bundleReadA.status).toBe(200);
      noBindingLeaks(await bundleReadA.json(), aBinding);
      const bundleReadB = await request(`/api/compiler/bundles/${b.bundleId}`);
      expect(bundleReadB.status).toBe(200);
      noBindingLeaks(await bundleReadB.json(), bBinding);

      const aInitial = await captureOpening(registry.get(a.sessionId)!);
      const bInitial = await captureOpening(registry.get(b.sessionId)!);
      assertScopedOpening(aInitial, aBinding, "the_call_of_cthulhu", "the_dunwich_horror");
      assertScopedOpening(bInitial, bBinding, "the_dunwich_horror", "the_call_of_cthulhu");

      const replaceByAction = async (created: CreatedSession, label: string) => {
        const before = registry.get(created.sessionId);
        if (!before) throw new Error(`${label} session was not installed`);
        const available = await request(`/api/sessions/${created.sessionId}/compiled/actions?pcId=p1`);
        expect(available.status).toBe(200);
        const actions = (await available.json() as { actions: Array<{ mechanismId: string }> }).actions;
        const action = actions[0];
        if (!action) throw new Error(`${label} fixture has no compiled action`);
        const committed = await request(`/api/sessions/${created.sessionId}/compiled/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pcId: "p1", mechanismId: action.mechanismId, actionId: `${label}-replacement`, expectedGeneration: 0 }),
        });
        expect(committed.status).toBe(200);
        const body = await committed.json() as { generation: number };
        expect(body.generation).toBe(1);
        noBindingLeaks(body, label === "a" ? aBinding : bBinding);
        const replacement = registry.get(created.sessionId);
        expect(replacement).toBeDefined();
        expect(replacement).not.toBe(before);
        return replacement!;
      };

      const aAfterAction = await replaceByAction(a, "a");
      const bAfterAction = await replaceByAction(b, "b");
      const aReplacement = await captureOpening(aAfterAction);
      const bReplacement = await captureOpening(bAfterAction);
      assertScopedOpening(aReplacement, aBinding, "the_call_of_cthulhu", "the_dunwich_horror");
      assertScopedOpening(bReplacement, bBinding, "the_dunwich_horror", "the_call_of_cthulhu");
      expect(aReplacement.receipt.scopeHash).toBe(aInitial.receipt.scopeHash);
      expect(bReplacement.receipt.scopeHash).toBe(bInitial.receipt.scopeHash);
      expect(new Set(aReplacement.receipt.provenance.map((entry) => entry.workId))).toEqual(new Set(aInitial.receipt.provenance.map((entry) => entry.workId)));
      expect(new Set(bReplacement.receipt.provenance.map((entry) => entry.workId))).toEqual(new Set(bInitial.receipt.provenance.map((entry) => entry.workId)));

      // A new registry and a new durable-host capability model a clean
      // process recovery. The only hand-off is catalog + snapshot + namespace
      // storage; no test fabricates a session-layer input.
      close(registry);
      freshRegistry = new Map<string, GameSession>();
      const freshHost = createCompiledDurableTestHost();
      expect(freshRegistry.size).toBe(0);
      const restartedA = await request(`/api/sessions/${a.sessionId}`, {}, freshRegistry, freshHost.capability);
      const restartedB = await request(`/api/sessions/${b.sessionId}`, {}, freshRegistry, freshHost.capability);
      expect(restartedA.status).toBe(200);
      expect(restartedB.status).toBe(200);
      noBindingLeaks(await restartedA.json(), aBinding);
      noBindingLeaks(await restartedB.json(), bBinding);
      expect(freshRegistry.get(a.sessionId)).toBeDefined();
      expect(freshRegistry.get(b.sessionId)).toBeDefined();
      expect(freshRegistry.get(a.sessionId)).not.toBe(aAfterAction);
      expect(freshRegistry.get(b.sessionId)).not.toBe(bAfterAction);
      expect(freshRegistry.get(a.sessionId)?.getCompiledGeneration()).toBe(1);
      expect(freshRegistry.get(b.sessionId)?.getCompiledGeneration()).toBe(1);
      const aRecovered = await captureOpening(freshRegistry.get(a.sessionId)!);
      const bRecovered = await captureOpening(freshRegistry.get(b.sessionId)!);
      assertScopedOpening(aRecovered, aBinding, "the_call_of_cthulhu", "the_dunwich_horror");
      assertScopedOpening(bRecovered, bBinding, "the_dunwich_horror", "the_call_of_cthulhu");
      expect(aRecovered.receipt.scopeHash).toBe(aInitial.receipt.scopeHash);
      expect(bRecovered.receipt.scopeHash).toBe(bInitial.receipt.scopeHash);
      expect(new Set(aRecovered.receipt.provenance.map((entry) => entry.workId))).toEqual(new Set(aInitial.receipt.provenance.map((entry) => entry.workId)));
      expect(new Set(bRecovered.receipt.provenance.map((entry) => entry.workId))).toEqual(new Set(bInitial.receipt.provenance.map((entry) => entry.workId)));
      expect(resolverCalls).toHaveLength(2);
      close(freshRegistry);
      freshRegistry = undefined;
    } finally {
      if (freshRegistry) close(freshRegistry);
      close(registry);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
