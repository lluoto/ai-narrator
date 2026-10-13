import { describe, expect, test } from "bun:test";
import { prepareCompiler } from "../compiler/compiler-api";
import {
  BudgetedRedactingLLM,
  REAL_MODEL_MAX_CALL_MS,
  REAL_MODEL_PROPOSAL_LIMITS,
  RealModelAcceptanceError,
  assertPreparedModuleIdentityIsolation,
  parseRealModelAcceptanceArgs,
  renderSanitizedAcceptanceReport,
  runLiveModule,
  uploadsAreAuthorized,
  type SanitizedAcceptanceReport,
} from "../../scripts/real-model-two-module-acceptance";
import type { ChatOptions, LLMLike, Message } from "../llm/client";

class RecordingLLM implements LLMLike {
  readonly options: ChatOptions[] = [];
  readonly messages: Message[][] = [];
  constructor(private readonly reply = "{}") {}
  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.messages.push(messages);
    this.options.push(options ?? {});
    return this.reply;
  }
}

describe("real-model two-module acceptance authority", () => {
  test("requires an explicit document hash authorization before live mode", () => {
    expect(parseRealModelAcceptanceArgs([])).toEqual({ ok: false, code: "usage_invalid" });
    expect(parseRealModelAcceptanceArgs(["--live"])).toEqual({ ok: false, code: "upload_authorization_required" });
    expect(parseRealModelAcceptanceArgs(["--offline"])).toEqual({ ok: true, mode: "offline", allowedDocumentHashes: [] });
    expect(parseRealModelAcceptanceArgs(["--prepare"])).toEqual({ ok: true, mode: "prepare", allowedDocumentHashes: [] });
    expect(uploadsAreAuthorized(["a".repeat(64), "b".repeat(64)], ["a".repeat(64)])).toBe(false);
    expect(uploadsAreAuthorized(["a".repeat(64), "b".repeat(64)], ["a".repeat(64), "b".repeat(64)])).toBe(true);
    expect(REAL_MODEL_PROPOSAL_LIMITS).toMatchObject({ maxRequestChars: 24_000, maxPromptChars: 24_000 });
  });

  test("tightens every provider call without retaining prompts or replies", async () => {
    const upstream = new RecordingLLM("provider reply must not be recorded");
    const llm = new BudgetedRedactingLLM(upstream, { maxCalls: 1, timeoutMs: REAL_MODEL_MAX_CALL_MS });
    await expect(llm.chat([{ role: "user", content: "source prose must never enter diagnostics" }], { timeout: 90_000, maxAttempts: 2 })).resolves.toBe("provider reply must not be recorded");
    expect(upstream.options[0]).toMatchObject({ timeout: REAL_MODEL_MAX_CALL_MS, maxAttempts: 1 });
    expect(upstream.options[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toEqual({
      latencyMs: expect.any(Number),
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      responseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(llm.calls)).not.toContain("source prose");
    expect(JSON.stringify(llm.calls)).not.toContain("provider reply");
    await expect(llm.chat([{ role: "user", content: "second request" }])).rejects.toMatchObject({ code: "model_call_budget_exhausted" } satisfies Pick<RealModelAcceptanceError, "code">);
  });

  test("renders a field whitelist, including only aggregated diagnostic stage/code/count", () => {
    const hash = "a".repeat(64);
    const report = {
      schemaVersion: "1.0.0",
      mode: "live",
      externalCalls: 1,
      budgets: { maxModuleJobMs: 120_000, maxCallMs: 15_000, maxCallsPerModule: 16, maxProposalRounds: 2, maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxRequestChars: 24_000, maxPromptChars: 24_000, maxResponseTokens: 2_400 },
      modules: [{
        module: "fuzu",
        documentHash: hash,
        artifactHash: hash,
        status: "draft_only",
        code: "RESOLVE_NOT_PUBLISHABLE",
        questions: { total: 4, answered: 1, open: 3, deferred: 0 },
        accepted: 1,
        model: { calls: 1, latencyMs: 12, requestHashes: [hash], responseHashes: [hash], errorCodes: ["provider_timeout"] },
        diagnostics: [
          { stage: "adapter_response", code: "invalid_citations", count: 2, message: "source prose must never render", questionId: "source-derived-id" },
          { stage: "adapter_chunking", code: "question_exceeds_prompt_limit", count: 1, message: "source-derived prompt must never render", questionId: "source-derived-prompt-id" },
          { stage: "untrusted-stage", code: "untrusted_code", count: 3, rawResponse: "untrusted diagnostic response" },
        ],
        closed: false,
        witnesses: { declaredEndingWitnesses: 0, replayedEndingWitnesses: 0 },
        endpoint: "https://provider.example/v1",
        apiKey: "super-secret-key",
        prompt: "full source prose",
        rawReply: "untrusted provider reply",
        error: { message: "transport error with endpoint" },
      }],
      isolation: { comparedPairs: 1, identityRefusals: 2, uniqueModuleIds: 2, uniqueDocumentHashes: 2 },
    } as unknown as SanitizedAcceptanceReport;
    const rendered = renderSanitizedAcceptanceReport(report);
    for (const secret of ["provider.example", "super-secret-key", "full source prose", "untrusted provider reply", "transport error", "source prose must never render", "source-derived-id", "source-derived prompt must never render", "source-derived-prompt-id", "untrusted diagnostic response", "untrusted_code"]) {
      expect(rendered).not.toContain(secret);
    }
    expect(rendered).toContain(hash);
    expect(rendered).toContain("provider_timeout");
    expect(rendered).toContain("RESOLVE_NOT_PUBLISHABLE");
    expect(rendered).toContain('"stage":"adapter_response","code":"invalid_citations","count":2');
    expect(rendered).toContain('"stage":"adapter_chunking","code":"question_exceeds_prompt_limit","count":1');
    expect(rendered).toContain('"stage":"other","code":"other","count":3');
  });

  test("uses the existing resolver to reject both cross-module hint identities", async () => {
    const left = await prepareCompiler({ kind: "synthetic_pages", moduleId: "isolation-left", sourceDescriptor: "left", pages: ["# 场景一\n一段可定位的来源文本。"] });
    const right = await prepareCompiler({ kind: "synthetic_pages", moduleId: "isolation-right", sourceDescriptor: "right", pages: ["# 场景二\n另一段可定位的来源文本。"] });
    expect(left.status).toBe("prepared");
    expect(right.status).toBe("prepared");
    if (left.status !== "prepared" || right.status !== "prepared") throw new Error("fixture did not prepare");
    expect(assertPreparedModuleIdentityIsolation(left, right)).toBe(2);
  });

  test("reuses the prepared artifact when the parser has detached the original PDF bytes", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "real-model-live-memory",
      sourceDescriptor: "real-model-live-memory",
      pages: ["Entry:\n◆Copper Key: It opens the archive.\nArchive:\n◆Exit Pass: It permits departure.\nExit:"],
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("memory fixture did not prepare");

    const upstream = new RecordingLLM("{}");
    const report = await runLiveModule({
      document: { id: "fuzu", moduleId: "real-model-live-memory", path: "memory://prepared-artifact" },
      documentHash: "a".repeat(64),
      // pdf-parse can detach its caller-owned input; live work must use the
      // already-validated artifact rather than attempting a second prepare.
      pdfBytes: new Uint8Array(),
      prepared,
    }, upstream, "model:memory");

    expect(upstream.messages.length).toBeGreaterThan(0);
    expect(upstream.options[0]).toMatchObject({
      jsonMode: true,
      maxTokens: 2_400,
      maxAttempts: 1,
      timeout: REAL_MODEL_MAX_CALL_MS,
    });
    expect(report.model.calls).toBeGreaterThan(0);
    expect(report.code).not.toBe("PREPARE_PDF_INVALID");
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ stage: "adapter_response", code: "invalid_response_root", count: expect.any(Number) }));
    expect(report.diagnostics.every((diagnostic) => Object.keys(diagnostic).sort().join(",") === "code,count,stage")).toBe(true);
  });
});
