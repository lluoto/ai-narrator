import { describe, expect, test } from "bun:test";
import {
  capProbeRequestBody,
  focusedNpcSample,
  isNpcPurposeRequestBody,
  liveModelAvailability,
  npcProviderContentHashesForWindow,
  observeNpcProviderContent,
  openingSample,
  parseTwoModuleNarrativeArgs,
  renderSanitizedTwoModuleNarrativeReport,
    runTwoModuleNarrativeProbe,
    sampleFromActionResponse,
  validateCurrentFuzuCompilation,
  validateFuzuArtifactPair,
  type TwoModuleNarrativeReport,
} from "../../scripts/diag/probe-two-module-narrative";
import { sha256 } from "../ingest/document-ir";
import { DEGRADATION_NOTICE } from "../llm/fallback";

describe("two-module narrative quality diagnostic", () => {
  test("requires explicit per-document consent before live narration", () => {
    expect(parseTwoModuleNarrativeArgs(["--live"])).toEqual({ ok: false, code: "upload_authorization_required" });
    expect(parseTwoModuleNarrativeArgs(["--offline"])).toEqual({ ok: true, mode: "offline", allowedDocumentHashes: [] });
    expect(parseTwoModuleNarrativeArgs(["--offline", "--allow-upload-sha256", "a".repeat(64)])).toEqual({ ok: false, code: "usage_invalid" });
  });

  test("keeps the default argument object stable while accepting explicit NPC focus", () => {
    expect(parseTwoModuleNarrativeArgs(["--offline"])).toEqual({ ok: true, mode: "offline", allowedDocumentHashes: [] });
    expect(parseTwoModuleNarrativeArgs(["--live", "--focus", "npc", "--allow-upload-sha256", "a".repeat(64)])).toEqual({
      ok: true,
      mode: "live",
      focus: "npc",
      allowedDocumentHashes: ["a".repeat(64)],
    });
    expect(parseTwoModuleNarrativeArgs(["--offline", "--focus", "other"])).toEqual({ ok: false, code: "usage_invalid" });
  });

  test("recognizes only the current NPC system-prompt shape as an NPC provider purpose", () => {
    expect(isNpcPurposeRequestBody(JSON.stringify({
      messages: [{
        role: "system",
        content: "你是一个 TRPG 非玩家角色（NPC）。\n\n你的名字: 菲碧·特里坎",
      }],
    }))).toBe(true);
    expect(isNpcPurposeRequestBody(JSON.stringify({
      messages: [{ role: "system", content: "请分类这个玩家意图。" }],
    }))).toBe(false);
  });

  test("marks focused NPC dialogue provider-backed only for an exact same-window raw-trim hash", () => {
    const dialogue = "  她在昏暗的门廊下沉默了一会儿。  ";
    const exact = sha256(new TextEncoder().encode(dialogue.trim()));
    const response = {
      narrative: "host narration must not be used as focused NPC text",
      events: [{ type: "dialogue", content: dialogue }],
    };
    expect(focusedNpcSample(response, "live", [exact])).toMatchObject({
      provenance: "provider",
      text: dialogue.trim(),
      dialogueHash: exact,
      matchingProviderContentHash: exact,
    });
    expect(focusedNpcSample(response, "live", ["b".repeat(64)])).toMatchObject({
      provenance: "provider_unobservable",
      dialogueHash: exact,
    });
  });

  test("does not treat empty, constrained, fallback, or a foreign-window receipt as provider dialogue", () => {
    const safeDialogue = "我现在不方便回答。";
    const safeHash = sha256(new TextEncoder().encode(safeDialogue));
    const unsafeHash = sha256(new TextEncoder().encode("unsafe original"));
    expect(focusedNpcSample({ events: [{ type: "dialogue", content: "   " }] }, "live", [safeHash])).toMatchObject({
      provenance: "provider_unobservable",
      status: "error",
    });
    expect(focusedNpcSample({ events: [{ type: "dialogue", content: safeDialogue }] }, "live", [unsafeHash])).toMatchObject({
      provenance: "provider_unobservable",
    });
    expect(focusedNpcSample({
      events: [{ type: "dialogue", content: safeDialogue }],
      error: { code: "provider_failed" },
    }, "live", [safeHash])).toMatchObject({
      provenance: "provider_unobservable",
      status: "error",
    });
    expect(focusedNpcSample({
      narrative: DEGRADATION_NOTICE,
      events: [{ type: "dialogue", content: safeDialogue }],
    }, "live", [safeHash])).toMatchObject({
      provenance: "fallback",
      status: "fallback",
    });
    const foreignWindow = npcProviderContentHashesForWindow([
      { requestIndex: 4, contentHash: "c".repeat(64) },
      // This old same-text receipt settles late, after the newer request, but
      // its dispatch ordinal belongs to the preceding action window.
      { requestIndex: 2, contentHash: safeHash },
    ], 2, 4);
    expect(foreignWindow).toEqual(["c".repeat(64)]);
    expect(focusedNpcSample({ events: [{ type: "dialogue", content: safeDialogue }] }, "live", foreignWindow)).toMatchObject({
      provenance: "provider_unobservable",
    });
  });

  test("reads a bounded NPC receipt from a clone without consuming the client response and fails closed on cancellation or size", async () => {
    const payload = JSON.stringify({ choices: [{ message: { content: "  exact provider reply  " } }] });
    const original = new Response(payload);
    const receipt = await observeNpcProviderContent(original.clone(), new AbortController().signal, () => undefined);
    expect(receipt).toBe(sha256(new TextEncoder().encode("exact provider reply")));
    expect(await original.text()).toBe(payload);

    let oversizedAborted = false;
    await expect(observeNpcProviderContent(
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
      new AbortController().signal,
      () => { oversizedAborted = true; },
    )).resolves.toBeNull();
    expect(oversizedAborted).toBe(true);

    const controller = new AbortController();
    let cancelledAborted = false;
    const stalled = new Response(new ReadableStream({
      pull: () => new Promise<void>(() => undefined),
    }));
    const pending = observeNpcProviderContent(stalled, controller.signal, () => { cancelledAborted = true; });
    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(cancelledAborted).toBe(true);
  });

  test("marks a non-empty fallback opening as fallback, never a real provider success", () => {
    expect(openingSample("离线兜底仍然有文字。", "fallback", "provider")).toMatchObject({
      status: "fallback",
      provenance: "fallback",
      text: "离线兜底仍然有文字。",
      errorCode: "provider_fallback",
    });
  });

  test("treats a missing or placeholder model config as unavailable, not a success", () => {
    expect(liveModelAvailability({ apiKey: "sk-placeholder" }, false)).toBe("model_unavailable");
    expect(liveModelAvailability({ apiKey: "usable-key" }, true)).toBe("model_disabled");
  });

  test("rejects a compiled artifact whose module identity does not match Fuzu", () => {
    expect(validateFuzuArtifactPair(
      { stage: "resolved", artifactHash: "a".repeat(64), payload: { identity: { moduleId: "other", documentHash: "b", sourceGraphIdentity: "c", mechanicsHash: "d" } } },
      { status: "projected", module: { id: "fuzu" }, artifact: { artifactHash: "a".repeat(64), identity: { moduleId: "fuzu", documentHash: "b", sourceGraphIdentity: "c", mechanicsHash: "d" } } },
    )).toEqual({ ok: false, code: "fuzu_module_mismatch" });
    // An injected helper must not let the outer fresh-current guard turn a
    // mismatched artifact/projection pair into a success either.
    expect(validateCurrentFuzuCompilation({
      aggregate: { documentHash: "b", artifactHash: "a".repeat(64), resolution: { reachableEndings: ["ending"] } },
      artifact: { stage: "resolved", artifactHash: "a".repeat(64), payload: { identity: { moduleId: "other", documentHash: "b", sourceGraphIdentity: "c", mechanicsHash: "d" } } },
      payload: { identity: { moduleId: "other", documentHash: "b", sourceGraphIdentity: "c", mechanicsHash: "d" } },
      projection: { status: "projected", module: { id: "fuzu" }, artifact: { artifactHash: "a".repeat(64), identity: { moduleId: "fuzu", documentHash: "b", sourceGraphIdentity: "c", mechanicsHash: "d" } } },
    }, "b")).toEqual({ ok: false, code: "fuzu_module_mismatch" });
  });

  test("keeps non-empty player text while faithfully retaining an action refusal", () => {
    expect(sampleFromActionResponse("action", {
      narrative: "这里暂时无法继续。",
      error: { code: "compiled_action_unavailable" },
    }, "mechanics")).toMatchObject({
      status: "error",
      text: "这里暂时无法继续。",
      errorCode: "compiled_action_unavailable",
    });
  });

  test("does not call fetch in offline mode and caps an oversized provider body", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("offline diagnostic must not fetch");
    }) as unknown as typeof fetch;
    try {
      let fuzuCompileCalls = 0;
      const report = await runTwoModuleNarrativeProbe({ ok: true, mode: "offline", allowedDocumentHashes: [] }, {
        // This is intentionally a fail-closed seam, not a fake projection:
        // unit tests must not rebuild the PDF or claim compiled success.
        compileCurrentFuzuAcceptance: async () => {
          fuzuCompileCalls++;
          throw new Error("current Fuzu compiler intentionally unavailable in unit test");
        },
      });
      expect(fetchCalls).toBe(0);
      expect(fuzuCompileCalls).toBe(1);
      expect(report.model).toMatchObject({ requested: "offline_mock", availability: "offline" });
      expect(report.modules.find((module) => module.module === "barn")).toMatchObject({
        status: "sampled",
        source: {
          id: "premiers_barn",
          verifiedActive: {
            moduleId: "premiers_barn",
            entryScene: "特里坎家",
            observedVia: "public_kp_state",
          },
        },
      });
      expect(report.modules.find((module) => module.module === "barn")?.samples.map((sample) => sample.step))
        .toEqual(["opening", "look", "npc", "action"]);
      expect(report.modules.find((module) => module.module === "fuzu")).toMatchObject({
        status: "refused",
        code: "fuzu_current_compile_failed",
        contextualNarration: "unsupported",
        quality: "incomplete",
        source: { id: "fuzu", currentPdfBenchmark: { provenance: "current_pdf_benchmark_hints" } },
        samples: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(JSON.parse(capProbeRequestBody(JSON.stringify({ model: "x", max_tokens: 256000 })) as string)).toMatchObject({ max_tokens: 600 });
  });

  test("drives the current Fuzu PDF through the trusted HTTP narration receipt and durable replay", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("offline Fuzu narration benchmark must not fetch");
    }) as unknown as typeof fetch;
    try {
      const report = await runTwoModuleNarrativeProbe({ ok: true, mode: "offline", allowedDocumentHashes: [] });
      const fuzu = report.modules.find((module) => module.module === "fuzu");
      const narrated = fuzu?.samples.find((sample) => sample.step === "action");
      expect(fetchCalls).toBe(0);
      expect(fuzu).toMatchObject({
        runtime: "compiled_game_session",
        contextualNarration: "supported",
        status: "sampled",
        quality: "not_real_model",
        source: { currentPdfBenchmark: { provenance: "current_pdf_benchmark_hints" } },
      });
      expect(narrated).toMatchObject({ step: "action", status: "ready", provenance: "mock" });
      expect(narrated?.text.trim().length).toBeGreaterThan(0);
      expect(narrated?.narrationReceipt).toMatchObject({ replayedAfterRestart: true });
      expect(narrated?.narrationReceipt?.rawResponseHash).not.toBe(narrated?.narrationReceipt?.textHash);
    } finally {
      globalThis.fetch = originalFetch;
    }
  // Fresh local-PDF preparation is synchronous and cannot be pre-empted by
  // Bun's per-test timer. This bounded allowance is not a provider deadline.
  }, 240_000);

  test("explicit offline NPC focus skips opening and look while leaving the Fuzu benchmark unsupported", async () => {
    const report = await runTwoModuleNarrativeProbe({ ok: true, mode: "offline", focus: "npc", allowedDocumentHashes: [] }, {
      compileCurrentFuzuAcceptance: async () => { throw new Error("no PDF compilation in this diagnostic test"); },
    });
    expect(report.budget).toMatchObject({
      maxProviderRequests: 8,
      maxTokens: 600,
      maxAttempts: 1,
      globalDeadlineMs: 180_000,
      observedProviderRequests: 0,
    });
    expect(report.modules.find((module) => module.module === "barn")?.samples.map((sample) => sample.step)).toEqual(["npc", "npc"]);
    expect(report.modules.find((module) => module.module === "fuzu")).toMatchObject({
      runtime: "compiled_game_session",
      contextualNarration: "unsupported",
      quality: "incomplete",
    });
  });

  test("whitelists report output and excludes accidental endpoint/key fields", () => {
    const report = {
      schemaVersion: "1.0.0",
      mode: "offline",
      model: { requested: "offline_mock", availability: "offline", maxTokens: 600, maxAttempts: 1, apiKey: "sk-secret", endpoint: "https://provider.invalid" },
      budget: { maxProviderRequests: 8, observedProviderRequests: 0, maxActionsPerModule: 3, maxTokens: 600, maxAttempts: 1, globalDeadlineMs: 180000, deadlineReached: false, requestBudgetReached: false, providerFailureCodes: [] },
      comparison: "incomplete_compiled_contextual_narration_unsupported",
      modules: [{
        module: "fuzu",
        source: {
          id: "fuzu",
          version: "private source prose must never render",
          kind: "compiled_artifact",
          currentPdfBenchmark: { provenance: "current_pdf_benchmark_hints", documentHash: "a".repeat(64) },
        },
        runtime: "compiled_game_session",
        contextualNarration: "unsupported",
        status: "refused",
        samples: [{
          step: "npc",
          status: "ready",
          provenance: "provider",
          text: "player-facing text only",
          leakFlags: [],
          dialogueHash: "b".repeat(64),
          observedProviderContentHashes: ["c".repeat(64), "https://provider.invalid/raw-response"],
          matchingProviderContentHash: "c".repeat(64),
        }],
        quality: "incomplete",
      }],
    } as unknown as TwoModuleNarrativeReport;
    const rendered = renderSanitizedTwoModuleNarrativeReport(report);
    expect(rendered).not.toContain("sk-secret");
    expect(rendered).not.toContain("provider.invalid");
    expect(rendered).not.toContain("private source prose");
    expect(rendered).toContain("current_pdf_benchmark_hints");
    expect(rendered).toContain("b".repeat(64));
    expect(rendered).toContain("c".repeat(64));
  });
});
