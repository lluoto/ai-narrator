import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SLOT_RESEARCH_HTTP_PATH,
  createSlotResearchHttpHandler,
  type SlotResearchEnvironment,
} from "../api/slot-research-http";
import { handleRequest } from "../api/server";
import { loadReviewedSlotResearchAdapter } from "../world/reviewed-slot-research-adapter";

const root = mkdtempSync(join(tmpdir(), "slot-research-http-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

interface Fixture extends SlotResearchEnvironment {
  readonly manifestPath: string;
  readonly proposalPath: string;
}

let fixtureNumber = 0;
function fixture(options: { reviewerClass?: string; allowedReviewerClasses?: string } = {}): Fixture {
  const dir = mkdtempSync(join(root, `case-${fixtureNumber++}-`));
  const parent = writeArtifact(dir, "batch-manifest.json", "{\"artifact\":\"parent\"}\n");
  const sourceRecords = writeArtifact(dir, "source-records.jsonl", "{\"artifact\":\"source-record\"}\n");
  const sourceSentences = writeArtifact(dir, "source-sentences.csv", "id,text\n1,opaque\n");
  const proposalLine = "{\"proposition_id\":\"SPR-V2-A\",\"raw_source_prose\":\"do not expose this\"}";
  const proposal = writeArtifact(dir, "proposal.jsonl", `${proposalLine}\n`);
  const verifier = writeArtifact(dir, "canonical-verdict.json", "{\"case_id\":\"VCV5-BE-001\"}\n");
  const dossierLine = "{\"review_dossier_id\":\"LMD-SB8001-TRV1-001\",\"raw_source_prose\":\"nor this\"}";
  const dossier = writeArtifact(dir, "lead-dossier.jsonl", `${dossierLine}\n`);
  const row = {
    source_parent_hashes: {
      parent_batch_manifest_sha256: parent.sha256,
      source_proposition_records_sha256: sourceRecords.sha256,
      source_sentences_sha256: sourceSentences.sha256,
      lead_dossier_file_sha256: dossier.sha256,
    },
    proposal: {
      proposal_id: "SPR-V2-A",
      proposal_record_sha256: sha(proposalLine),
      proposal_records_file_sha256: proposal.sha256,
    },
    verifier: { case_id: "VCV5-BE-001", canonical_verdict_sha256: verifier.sha256 },
    lead_dossier: { dossier_id: "LMD-SB8001-TRV1-001", dossier_line_sha256: sha(`${dossierLine}\n`) },
    work_source: {
      work_id: "work-a",
      allowed_work_ids: ["work-a"],
      source_unit_id: "CG0003",
      source_evidence_id: "B001:C0077:S000030",
    },
    route: "bounded_event",
    modality_scope: {
      assertion_status: "narrator_asserted",
      claimant_or_source: null,
      claimant_status: "narrator",
      temporal_status: "bounded_occurrence",
      evidence_directness: "explicit",
      source_proposition_extractable: "yes",
      generality_scope: "instance",
      generality_cue_span: null,
    },
    reviewer_class: options.reviewerClass ?? "lead_model",
    publication_status: "candidate_not_confirmed",
    transfer_policy: "no_transfer",
    consumer_policy: "research_lookup_only",
    no_runtime_effect: true,
  };
  const manifestText = `${JSON.stringify(row)}\n`;
  const manifestPath = join(dir, "reviewed_slot_research_manifest_v1.jsonl");
  writeFileSync(manifestPath, manifestText, "utf8");
  const manifestSha256 = sha(manifestText);
  const indexPath = join(dir, "artifact-bindings.json");
  writeFileSync(indexPath, `${JSON.stringify({
    schema_version: "reviewed_slot_research_artifact_binding_index_v1",
    manifest_sha256: manifestSha256,
    bindings: [parent, sourceRecords, sourceSentences, proposal, verifier, dossier].map((artifact) => ({
      reference_sha256: artifact.sha256,
      path: artifact.path,
      file_sha256: artifact.sha256,
    })),
  })}\n`, "utf8");
  return {
    manifestPath,
    proposalPath: proposal.path,
    SLOT_RESEARCH_MANIFEST_PATH: manifestPath,
    SLOT_RESEARCH_MANIFEST_SHA256: manifestSha256,
    SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH: indexPath,
    SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256: sha(readFileSync(indexPath)),
    SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES: options.allowedReviewerClasses ?? "lead_model",
  };
}

function writeArtifact(dir: string, name: string, content: string): { readonly path: string; readonly sha256: string } {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return { path, sha256: sha(content) };
}

function request(query = "workId=work-a", init: RequestInit = {}): Request {
  return new Request(`http://research.test${SLOT_RESEARCH_HTTP_PATH}?${query}`, init);
}

describe("slot research HTTP facade", () => {
  it("stays unavailable without a nonblank reviewer-class policy before constructing an adapter", async () => {
    const configured = fixture();
    const { SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES: _allowedReviewerClasses, ...withoutAllowedReviewerClasses } = configured;
    let constructions = 0;
    for (const environment of [withoutAllowedReviewerClasses, { ...configured, SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES: "  " }]) {
      const handler = createSlotResearchHttpHandler(environment, () => {
        constructions++;
        throw new Error("must not construct");
      });
      const response = handler(request())!;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "SLOT_RESEARCH_UNAVAILABLE", message: "slot research is not configured" },
      });
    }
    expect(constructions).toBe(0);
  });

  it("fails closed with a generic error for invalid pins", async () => {
    const pinMismatch = fixture();
    writeFileSync(pinMismatch.proposalPath, "changed", "utf8");

    for (const environment of [pinMismatch]) {
      const response = createSlotResearchHttpHandler(environment)(request())!;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "SLOT_RESEARCH_BINDING_REJECTED", message: "slot research is unavailable" },
      });
    }
  });

  it("memoizes one binding rejection across known and unknown work IDs", async () => {
    let constructions = 0;
    const handler = createSlotResearchHttpHandler(fixture(), () => {
      constructions++;
      throw new Error("pinned artifact rejected");
    });

    for (const query of ["workId=work-a", "workId=unknown", "workId=work-a"]) {
      const response = handler(request(query))!;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "SLOT_RESEARCH_BINDING_REJECTED", message: "slot research is unavailable" },
      });
    }
    expect(constructions).toBe(1);
  });

  it("returns only frozen adapter metadata with a read-only, no-runtime-effect status", async () => {
    const response = createSlotResearchHttpHandler(fixture())(request())!;
    const body = await response.json() as {
      status: { readOnly: boolean; noRuntimeEffect: boolean; admittedReviewerClasses: string[] };
      receipts: Array<{ workSource: { workId: string }; reviewerClass: string; warnings: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["receipts", "status"]);
    expect(body.status).toEqual({ readOnly: true, noRuntimeEffect: true, admittedReviewerClasses: ["lead_model"] });
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]).toMatchObject({
      workSource: { workId: "work-a" },
      reviewerClass: "lead_model",
      warnings: expect.arrayContaining(["reviewer_class:lead_model", "model_reviewed_not_human_gold"]),
    });
    expect(JSON.stringify(body)).not.toContain("raw_source_prose");
    expect(JSON.stringify(body)).not.toContain("do not expose this");
    expect((await createSlotResearchHttpHandler(fixture())(request("workId=unknown"))!.json() as { receipts: unknown[] }).receipts).toEqual([]);
  });

  it("loads one configured binding once across known and unknown work IDs, then invalidates it when the configured artifacts change", async () => {
    const first = fixture();
    const second = fixture();
    const environment = { ...first };
    let constructions = 0;
    const handler = createSlotResearchHttpHandler(environment, (binding) => {
      constructions++;
      return loadReviewedSlotResearchAdapter(binding);
    });

    for (const query of ["workId=work-a", "workId=unknown", "workId=work-a"]) {
      expect(handler(request(query))!.status).toBe(200);
    }
    expect(constructions).toBe(1);

    environment.SLOT_RESEARCH_MANIFEST_SHA256 = "0".repeat(64);
    const rejected = handler(request())!;
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({
      error: { code: "SLOT_RESEARCH_BINDING_REJECTED", message: "slot research is unavailable" },
    });
    expect(constructions).toBe(2);

    environment.SLOT_RESEARCH_MANIFEST_PATH = second.SLOT_RESEARCH_MANIFEST_PATH;
    environment.SLOT_RESEARCH_MANIFEST_SHA256 = second.SLOT_RESEARCH_MANIFEST_SHA256;
    environment.SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH = second.SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH;
    environment.SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256 = second.SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256;
    environment.SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES = second.SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES;
    expect(handler(request())!.status).toBe(200);
    expect(constructions).toBe(3);
  });

  it("returns an empty metadata list when valid rows are outside the reviewer allowlist", async () => {
    const response = createSlotResearchHttpHandler(fixture({ allowedReviewerClasses: "human" }))(request())!;
    const body = await response.json() as {
      status: { admittedReviewerClasses: string[] };
      receipts: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.status.admittedReviewerClasses).toEqual(["human"]);
    expect(body.receipts).toEqual([]);
  });

  it("rejects unknown configured reviewer classes without echoing them", async () => {
    const unknownReviewerClass = "unknown_reviewer_class";
    const response = createSlotResearchHttpHandler(fixture({ allowedReviewerClasses: unknownReviewerClass }))(request())!;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: { code: "SLOT_RESEARCH_BINDING_REJECTED", message: "slot research is unavailable" },
    });
    expect(JSON.stringify(body)).not.toContain(unknownReviewerClass);
  });

  it("rejects mutable or expanded adapter data before it can enter a response", async () => {
    const handler = createSlotResearchHttpHandler(fixture(), () => ({
      admittedCount: 1,
      excludedByReviewerClass: 0,
      queryWork: () => [{ workSource: { workId: "work-a" }, sourceProse: "must not escape" }] as never,
    }));

    const response = handler(request())!;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SLOT_RESEARCH_BINDING_REJECTED", message: "slot research is unavailable" },
    });
  });

  it("accepts only one nonempty workId and rejects all query input before construction", () => {
    let constructions = 0;
    const handler = createSlotResearchHttpHandler(fixture(), () => {
      constructions++;
      throw new Error("must not construct");
    });

    for (const query of ["workId=", "workId=work-a&workId=work-b", "workId=work-a&text=needle", "workId=work-a&route=anything"]) {
      expect(handler(request(query))!.status).toBe(400);
    }
    expect(constructions).toBe(0);
  });

  it("is GET-only and never constructs an adapter for mutation methods", () => {
    let constructions = 0;
    const handler = createSlotResearchHttpHandler(fixture(), () => {
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

  it("uses only the slot adapter and dispatches before general session routes with CORS", async () => {
    const source = readFileSync(new URL("../api/slot-research-http.ts", import.meta.url), "utf8");
    const adapter = readFileSync(new URL("../world/reviewed-slot-research-adapter.ts", import.meta.url), "utf8");
    const server = readFileSync(new URL("../api/server.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])).toEqual([
      "../world/reviewed-slot-research-adapter",
    ]);
    expect([...adapter.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])).toEqual([
      "node:crypto",
      "node:fs",
      "node:path",
    ]);
    const optionsDispatch = server.indexOf('if (method === "OPTIONS" && segments[0] === "api")');
    const sourceResearchDispatch = server.indexOf("const sourceResearchResponse = handleSourceResearchHttpRequest(req);");
    const slotResearchDispatch = server.indexOf("const slotResearchResponse = handleSlotResearchHttpRequest(req);");
    const runtimeBootstrap = server.indexOf("compiledSnapshots ??= defaultCompiledSessionSnapshots;");
    const generalSessionDispatch = server.indexOf("// POST /api/sessions — 创建新会话");
    expect(optionsDispatch).toBeGreaterThanOrEqual(0);
    expect(sourceResearchDispatch).toBeGreaterThanOrEqual(0);
    expect(sourceResearchDispatch).toBeGreaterThan(optionsDispatch);
    expect(slotResearchDispatch).toBeGreaterThan(sourceResearchDispatch);
    expect(runtimeBootstrap).toBeGreaterThan(slotResearchDispatch);
    expect(generalSessionDispatch).toBeGreaterThan(slotResearchDispatch);
    expect(server.slice(slotResearchDispatch, runtimeBootstrap)).toContain(
      "if (slotResearchResponse) return withCors(slotResearchResponse);",
    );
    expect(server).toContain('"GET /api/slot-research?workId=<single> — 查询只读审核槽位研究收据"');

    let runtimeStorageTouched = false;
    const poisonedRuntimeStorage = new Proxy(Object.create(null), {
      get() {
        runtimeStorageTouched = true;
        throw new Error("slot research must not touch runtime storage");
      },
    });
    const response = await handleRequest(
      new Request(`http://research.test${SLOT_RESEARCH_HTTP_PATH}?workId=`, { method: "GET" }),
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

    const preflight = await handleRequest(
      new Request(`http://research.test${SLOT_RESEARCH_HTTP_PATH}`, { method: "OPTIONS" }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
