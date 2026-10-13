import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { minimalPdfBytes } from "./helpers/minimal-pdf";
import {
  runLiveTwoModuleHttpCampaignHost,
  type TwoModuleHttpCampaignHostDocument,
} from "../../scripts/diag/two-module-http-campaign-host";
import { sha256 } from "../ingest/document-ir";
import { CompiledPlayerDelivery } from "../api/player-delivery";
import { CompiledWorldModelBindingRegistry } from "../world/compiled-world-model-binding-registry";

const CTHULHU_DATASET_ROOT = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";
const PROVIDER_BASE_URL = "https://full-quality-admission-test.invalid/v1";
const PROVIDER_URL = `${PROVIDER_BASE_URL}/chat/completions`;

const documents: readonly TwoModuleHttpCampaignHostDocument[] = [
  { id: "fuzu", moduleId: "full-quality-admission-fuzu", path: "memory://full-quality-admission-fuzu.pdf" },
  { id: "barn", moduleId: "full-quality-admission-barn", path: "memory://full-quality-admission-barn.pdf" },
];

const sources = new Map<string, Uint8Array>([
  ["memory://full-quality-admission-fuzu.pdf", minimalPdfBytes("Entry: a brass key opens the archive. Exit: a locked door leads outside.")],
  ["memory://full-quality-admission-barn.pdf", minimalPdfBytes("Farmhouse: a ledger names the owner. Cellar: a locked gate leads outside.")],
]);

function readDocument(document: TwoModuleHttpCampaignHostDocument): Uint8Array {
  const bytes = sources.get(document.path);
  if (!bytes) throw new Error("missing full-quality budget fixture source");
  return new Uint8Array(bytes);
}

function sourceProfileRegistry(): { registry: CompiledWorldModelBindingRegistry; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "two-module-full-quality-budget-"));
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify({
    schemaVersion: "1.1.0",
    kind: "compiled_cthulhu_world_model_policy",
    bindings: [],
    sourceProfiles: documents.map((document, index) => ({
      moduleId: document.moduleId,
      documentHash: sha256(readDocument(document)),
      allowedWorkIds: [index === 0 ? "the_call_of_cthulhu" : "the_dunwich_horror"],
      corpusScopeId: null,
      transferPolicy: "analogy_only",
    })),
  }), "utf8");
  return {
    registry: new CompiledWorldModelBindingRegistry({
      COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: policyPath,
      CTHULHU_DATASET_PATH: CTHULHU_DATASET_ROOT,
    }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fullQualityInput(
  registry: CompiledWorldModelBindingRegistry,
  beforeLiveCampaignDispatch: NonNullable<Parameters<typeof runLiveTwoModuleHttpCampaignHost>[0]["beforeLiveCampaignDispatch"]>,
  scheduleDeadline?: Parameters<typeof runLiveTwoModuleHttpCampaignHost>[0]["scheduleDeadline"],
) {
  return {
    documents,
    allowedDocumentHashes: documents.map((document) => sha256(readDocument(document))),
    readDocument,
    worldModelBindingRegistry: registry,
    config: {
      apiKey: "sk-full-quality-admission-test-key",
      baseUrl: PROVIDER_BASE_URL,
      model: "full-quality-admission-test-model",
      maxTokens: 256_000,
      temperature: 0,
    },
    fullQuality: {
      mode: "full_quality" as const,
      playerDelivery: new CompiledPlayerDelivery({
        secret: "a".repeat(43),
        publicOrigin: "https://full-quality-player.example",
      }),
    },
    ...(scheduleDeadline ? { scheduleDeadline } : {}),
    beforeLiveCampaignDispatch,
  };
}

test("refuses an unscoped full-quality provider fetch before it can start the deadline or reach the fake upstream", async () => {
  const originalFetch = globalThis.fetch;
  const sourceProfiles = sourceProfileRegistry();
  let upstreamCalls = 0;
  let deadlineSchedules = 0;
  let observedRejection = "";
  globalThis.fetch = (async () => {
    upstreamCalls++;
    return new Response("unexpected upstream dispatch", { status: 500 });
  }) as unknown as typeof fetch;
  try {
    await expect(runLiveTwoModuleHttpCampaignHost(fullQualityInput(
      sourceProfiles.registry,
      async () => {
        try {
          await globalThis.fetch(PROVIDER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ max_tokens: 600 }),
          });
        } catch (error) {
          observedRejection = error instanceof Error ? error.message : String(error);
        }
        expect(observedRejection).toBe("external_fetch_shape_refused");
        expect(upstreamCalls).toBe(0);
        expect(deadlineSchedules).toBe(0);
        throw new Error("stop_after_unscoped_admission_probe");
      },
      () => {
        deadlineSchedules++;
        return () => undefined;
      },
    ))).rejects.toThrow("stop_after_unscoped_admission_probe");
    expect(upstreamCalls).toBe(0);
    expect(deadlineSchedules).toBe(0);
  } finally {
    sourceProfiles.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("reserves the reachable two-module phase plan before each fake upstream dispatch and preserves a 600-token narration cap", async () => {
  const originalFetch = globalThis.fetch;
  const sourceProfiles = sourceProfileRegistry();
  let upstreamCalls = 0;
  let deadlineSchedules = 0;
  const observed: Array<{ url: string; maxTokens: number }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { max_tokens: number };
    upstreamCalls++;
    observed.push({ url: String(input), maxTokens: body.max_tokens });
    return new Response("{}", { status: 503 });
  }) as unknown as typeof fetch;
  try {
    await expect(runLiveTwoModuleHttpCampaignHost(fullQualityInput(
      sourceProfiles.registry,
      async (probe) => {
        if (!probe) throw new Error("full-quality admission probe missing");
        const dispatch = (module: "fuzu" | "barn", phase: "compiler" | "player_intent" | "narration" | "followup", maxTokens: number) =>
          probe.run({ module, phase }, () => globalThis.fetch(PROVIDER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ max_tokens: maxTokens }),
          }));
        for (const module of ["fuzu", "barn"] as const) {
          for (let index = 0; index < 96; index++) await dispatch(module, "compiler", 1_000);
          await dispatch(module, "player_intent", 128);
          await dispatch(module, "narration", 600);
          await dispatch(module, "followup", 600);
          await dispatch(module, "followup", 600);
        }
        expect(probe.snapshot()).toEqual({
          dispatches: 200,
          reservedOutputTokens: 195_856,
          deadlineStarted: true,
          deadlineReached: false,
        });
        await expect(dispatch("fuzu", "followup", 600)).rejects.toThrow("external_fetch_budget_exhausted");
        expect(probe.snapshot().dispatches).toBe(200);
        throw new Error("stop_after_reachable_phase_budget_probe");
      },
      () => {
        deadlineSchedules++;
        return () => undefined;
      },
    ))).rejects.toThrow("stop_after_reachable_phase_budget_probe");
    expect(upstreamCalls).toBe(200);
    expect(deadlineSchedules).toBe(1);
    expect(observed).toHaveLength(200);
    expect(observed.every(({ url }) => url === PROVIDER_URL)).toBe(true);
    expect(observed.filter(({ maxTokens }) => maxTokens === 600)).toHaveLength(6);
  } finally {
    sourceProfiles.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("never refunds a failed compiler dispatch before enforcing that phase's reserved boundary", async () => {
  const originalFetch = globalThis.fetch;
  const sourceProfiles = sourceProfileRegistry();
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls++;
    if (upstreamCalls === 1) throw new Error("fake_upstream_failure");
    return new Response("{}", { status: 503 });
  }) as unknown as typeof fetch;
  try {
    await expect(runLiveTwoModuleHttpCampaignHost(fullQualityInput(
      sourceProfiles.registry,
      async (probe) => {
        if (!probe) throw new Error("full-quality admission probe missing");
        const dispatch = () => probe.run({ module: "fuzu", phase: "compiler" }, () => globalThis.fetch(PROVIDER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ max_tokens: 1_000 }),
        }));
        await expect(dispatch()).rejects.toThrow("fake_upstream_failure");
        for (let index = 0; index < 95; index++) await dispatch();
        expect(probe.snapshot()).toMatchObject({ dispatches: 96, reservedOutputTokens: 96_000 });
        await expect(dispatch()).rejects.toThrow("external_fetch_budget_exhausted");
        expect(probe.snapshot()).toMatchObject({ dispatches: 96, reservedOutputTokens: 96_000 });
        throw new Error("stop_after_no_refund_probe");
      },
    ))).rejects.toThrow("stop_after_no_refund_probe");
    expect(upstreamCalls).toBe(96);
  } finally {
    sourceProfiles.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("keeps the exact quality-phase reservations ahead of otherwise available module capacity", async () => {
  const originalFetch = globalThis.fetch;
  const sourceProfiles = sourceProfileRegistry();
  let upstreamCalls = 0;
  globalThis.fetch = (async () => {
    upstreamCalls++;
    return new Response("{}", { status: 503 });
  }) as unknown as typeof fetch;
  try {
    await expect(runLiveTwoModuleHttpCampaignHost(fullQualityInput(
      sourceProfiles.registry,
      async (probe) => {
        if (!probe) throw new Error("full-quality admission probe missing");
        const dispatch = (url: string, phase: "compiler" | "narration" | "followup", maxTokens: number) =>
          probe.run({ module: "fuzu", phase }, () => globalThis.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ max_tokens: maxTokens }),
          }));
        await expect(dispatch("https://full-quality-admission-test.invalid/other", "compiler", 1_000)).rejects.toThrow("external_fetch_shape_refused");
        expect(probe.snapshot()).toMatchObject({ dispatches: 0, reservedOutputTokens: 0, deadlineStarted: false });
        await expect(dispatch(PROVIDER_URL, "narration", 601)).rejects.toThrow("external_fetch_budget_exhausted");
        await dispatch(PROVIDER_URL, "followup", 600);
        await dispatch(PROVIDER_URL, "followup", 600);
        await expect(dispatch(PROVIDER_URL, "followup", 600)).rejects.toThrow("external_fetch_budget_exhausted");
        expect(probe.snapshot()).toMatchObject({ dispatches: 2, reservedOutputTokens: 1_200, deadlineStarted: true });
        throw new Error("stop_after_phase_reservation_probe");
      },
    ))).rejects.toThrow("stop_after_phase_reservation_probe");
    expect(upstreamCalls).toBe(2);
  } finally {
    sourceProfiles.dispose();
    globalThis.fetch = originalFetch;
  }
});
