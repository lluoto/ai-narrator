import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOURCE_RESEARCH_HTTP_PATH,
  createSourceResearchHttpHandler,
  type SourceResearchEnvironment,
} from "../api/source-research-http";
import { handleRequest } from "../api/server";
import { createSourceResearchFacade } from "../world/source-research-facade";

const root = mkdtempSync(join(tmpdir(), "source-research-http-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function record(propositionId: string, workId: string): Record<string, unknown> {
  return {
    proposition_id: propositionId,
    work_id: workId,
    source_unit_id: `unit-${propositionId}`,
    source_chapter_id: "chapter-1",
    source_text: `source evidence ${propositionId}`,
    evidence_ids: [`chapter-1:${propositionId}`],
    assertion_status: "narrator_asserted",
    temporal_status: "bounded_occurrence",
    publication_status: "candidate_not_confirmed",
    allowed_work_ids: [workId],
    transfer_policy: "no_transfer",
    queryability: "queryable",
  };
}

function v2ManifestRow(
  sourceRecord: Record<string, unknown>,
  sourceRecordLine: string,
  reviewerClass = "human",
): Record<string, unknown> {
  return {
    schema_version: "reviewed_source_query_manifest_v2",
    manifest_record_id: `manifest-${sourceRecord.proposition_id}`,
    candidate_id: `candidate-${sourceRecord.proposition_id}`,
    review_batch_type: "source_query",
    decision: "rewrite_source_query_only",
    reviewer_class: reviewerClass,
    candidate_status: "source_query_only",
    review_status: "review_only",
    publication_status: "candidate_not_confirmed",
    transfer_policy: "no_transfer",
    consumer_policy: "research_lookup_only",
    no_runtime_effect: true,
    work_scope: {
      scope: "single_work",
      work_id: sourceRecord.work_id,
      allowed_work_ids: [sourceRecord.work_id],
      proposition_id: sourceRecord.proposition_id,
      source_unit_id: sourceRecord.source_unit_id,
      source_chapter_id: sourceRecord.source_chapter_id,
    },
    source_record_sha256: sha(sourceRecordLine),
    reviewed_evidence: { evidence_ids: sourceRecord.evidence_ids, source_exact: true },
    reviewed_text_kind: "reviewed_query_text",
    reviewed_text: `reviewed text ${sourceRecord.proposition_id}`,
    reviewed_modality: {
      assertion_status: sourceRecord.assertion_status,
      temporal_status: sourceRecord.temporal_status,
      modality_change: "preserved",
    },
  };
}

let fixtureNumber = 0;
function fixture(options: { reviewerClass?: string; allowedReviewerClasses?: string } = {}): SourceResearchEnvironment & {
  readonly manifestPath: string;
  readonly recordsPath: string;
} {
  const dir = mkdtempSync(join(root, `case-${fixtureNumber++}-`));
  const records = [record("P1", "work-a"), record("P2", "work-b")];
  const lines = new Map(records.map((item) => [item.proposition_id as string, JSON.stringify(item)]));
  const recordsText = `${[...lines.values()].join("\n")}\n`;
  const manifestText = `${records.map((item) => JSON.stringify(v2ManifestRow(
    item,
    lines.get(item.proposition_id as string)!,
    options.reviewerClass,
  ))).join("\n")}\n`;
  const manifestPath = join(dir, "reviewed-manifest.jsonl");
  const recordsPath = join(dir, "source-records.jsonl");
  writeFileSync(manifestPath, manifestText, "utf8");
  writeFileSync(recordsPath, recordsText, "utf8");
  return {
    manifestPath,
    recordsPath,
    SOURCE_RESEARCH_MANIFEST_PATH: manifestPath,
    SOURCE_RESEARCH_MANIFEST_SHA256: sha(Buffer.from(manifestText, "utf8")),
    SOURCE_RESEARCH_RECORDS_PATH: recordsPath,
    SOURCE_RESEARCH_RECORDS_SHA256: sha(Buffer.from(recordsText, "utf8")),
    SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES: options.allowedReviewerClasses ?? "human",
  };
}

function request(query = "workId=work-a", init: RequestInit = {}): Request {
  return new Request(`http://research.test${SOURCE_RESEARCH_HTTP_PATH}?${query}`, init);
}

describe("source research HTTP facade", () => {
  it("stays unavailable without complete opt-in configuration before constructing a facade", async () => {
    let constructions = 0;
    const handler = createSourceResearchHttpHandler({
      SOURCE_RESEARCH_MANIFEST_PATH: "must-not-be-read",
    }, () => {
      constructions++;
      throw new Error("must not construct");
    });

    const response = handler(request())!;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SOURCE_RESEARCH_UNAVAILABLE", message: "source research is not configured" },
    });
    expect(constructions).toBe(0);
  });

  it("fails closed on pinned artifact hash mismatch", async () => {
    const config = fixture();
    writeFileSync(config.manifestPath, `${readFileSync(config.manifestPath, "utf8")}{}`, "utf8");

    const response = createSourceResearchHttpHandler(config)(request())!;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SOURCE_RESEARCH_BINDING_REJECTED", message: "source research is unavailable" },
    });
  });

  it("memoizes one binding rejection across known and unknown work IDs", async () => {
    let constructions = 0;
    const handler = createSourceResearchHttpHandler(fixture(), () => {
      constructions++;
      throw new Error("pinned artifact rejected");
    });

    for (const query of ["workId=work-a", "workId=unknown", "workId=work-a"]) {
      const response = handler(request(query))!;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "SOURCE_RESEARCH_BINDING_REJECTED", message: "source research is unavailable" },
      });
    }
    expect(constructions).toBe(1);
  });

  it("returns only immutable-v2 receipts from the exact requested work scope", async () => {
    const response = createSourceResearchHttpHandler(fixture())(request())!;
    const body = await response.json() as {
      status: { readOnly: boolean; noRuntimeEffect: boolean };
      receipts: Array<{ workId: string; noRuntimeEffect: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.status).toMatchObject({ readOnly: true, noRuntimeEffect: true });
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]).toMatchObject({ workId: "work-a", noRuntimeEffect: true });
    expect((await createSourceResearchHttpHandler(fixture())(request("workId=unknown"))!.json() as { receipts: unknown[] }).receipts).toEqual([]);
  });

  it("loads one configured binding once across known and unknown work IDs, then invalidates it when the configured artifacts change", async () => {
    const first = fixture();
    const second = fixture();
    const environment = { ...first };
    let constructions = 0;
    const handler = createSourceResearchHttpHandler(environment, (binding) => {
      constructions++;
      return createSourceResearchFacade(binding);
    });

    for (const query of ["workId=work-a", "workId=unknown", "workId=work-a"]) {
      expect(handler(request(query))!.status).toBe(200);
    }
    expect(constructions).toBe(1);

    environment.SOURCE_RESEARCH_MANIFEST_SHA256 = "0".repeat(64);
    const rejected = handler(request())!;
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({
      error: { code: "SOURCE_RESEARCH_BINDING_REJECTED", message: "source research is unavailable" },
    });
    expect(constructions).toBe(2);

    environment.SOURCE_RESEARCH_MANIFEST_PATH = second.SOURCE_RESEARCH_MANIFEST_PATH;
    environment.SOURCE_RESEARCH_MANIFEST_SHA256 = second.SOURCE_RESEARCH_MANIFEST_SHA256;
    environment.SOURCE_RESEARCH_RECORDS_PATH = second.SOURCE_RESEARCH_RECORDS_PATH;
    environment.SOURCE_RESEARCH_RECORDS_SHA256 = second.SOURCE_RESEARCH_RECORDS_SHA256;
    environment.SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES = second.SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES;
    expect(handler(request())!.status).toBe(200);
    expect(constructions).toBe(3);
  });

  it("fails closed when any reviewed row is outside the reviewer allowlist", async () => {
    const response = createSourceResearchHttpHandler(fixture({
      reviewerClass: "delegated_assistant",
      allowedReviewerClasses: "human",
    }))(request())!;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SOURCE_RESEARCH_BINDING_REJECTED", message: "source research is unavailable" },
    });
  });

  it("accepts only one nonempty workId and rejects text or route query input before construction", () => {
    let constructions = 0;
    const handler = createSourceResearchHttpHandler(fixture(), () => {
      constructions++;
      throw new Error("must not construct");
    });

    for (const query of ["workId=", "workId=work-a&workId=work-b", "workId=work-a&text=needle", "workId=work-a&route=anything"]) {
      const response = handler(request(query))!;
      expect(response.status).toBe(400);
    }
    expect(constructions).toBe(0);
  });

  it("is GET-only and never constructs a facade for mutation methods", () => {
    let constructions = 0;
    const handler = createSourceResearchHttpHandler(fixture(), () => {
      constructions++;
      throw new Error("must not construct");
    });

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = handler(request("workId=work-a", { method, body: "ignored" }))!;
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    }
    expect(constructions).toBe(0);
  });

  it("dispatches before general session routes and imports only the research facade", async () => {
    const source = readFileSync(new URL("../api/source-research-http.ts", import.meta.url), "utf8");
    const facade = readFileSync(new URL("../world/source-research-facade.ts", import.meta.url), "utf8");
    const adapter = readFileSync(new URL("../world/reviewed-source-query-adapter.ts", import.meta.url), "utf8");
    const server = readFileSync(new URL("../api/server.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])).toEqual([
      "../world/source-research-facade",
    ]);
    expect([...facade.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])).toEqual([
      "./reviewed-source-query-adapter",
    ]);
    expect([...adapter.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])).toEqual([
      "node:crypto",
      "node:fs",
      "node:path",
    ]);
    const researchDispatch = server.indexOf("const sourceResearchResponse = handleSourceResearchHttpRequest(req);");
    const slotResearchDispatch = server.indexOf("const slotResearchResponse = handleSlotResearchHttpRequest(req);");
    const runtimeBootstrap = server.indexOf("compiledSnapshots ??= defaultCompiledSessionSnapshots;");
    const generalSessionDispatch = server.indexOf("// POST /api/sessions — 创建新会话");
    expect(researchDispatch).toBeGreaterThanOrEqual(0);
    expect(slotResearchDispatch).toBeGreaterThan(researchDispatch);
    expect(runtimeBootstrap).toBeGreaterThan(slotResearchDispatch);
    expect(generalSessionDispatch).toBeGreaterThan(researchDispatch);
    expect(server.slice(researchDispatch, slotResearchDispatch)).toContain(
      "if (sourceResearchResponse) return withCors(sourceResearchResponse);",
    );
    expect(server).toContain('"GET /api/source-research?workId=<single> — 查询只读审核来源收据"');

    let runtimeStorageTouched = false;
    const poisonedRuntimeStorage = new Proxy(Object.create(null), {
      get() {
        runtimeStorageTouched = true;
        throw new Error("source research must not touch runtime storage");
      },
    });
    const response = await handleRequest(
      new Request(`http://research.test${SOURCE_RESEARCH_HTTP_PATH}?workId=`, { method: "GET" }),
      undefined,
      undefined,
      {},
      {},
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ordinarySnapshots: poisonedRuntimeStorage as never,
        sessionNamespace: poisonedRuntimeStorage as never,
      },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(runtimeStorageTouched).toBe(false);
  });
});
