import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReviewedSourceQueryError,
  loadReviewedSourceQueryAdapter,
  type ReviewerClass,
} from "../world/reviewed-source-query-adapter";

const root = mkdtempSync(join(tmpdir(), "reviewed-source-query-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const SOURCE_RESEARCH_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SOURCE_RESEARCH_MAX_MANIFEST_ENTRIES = 1024;

function rec(id: string, work: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposition_id: id,
    work_id: work,
    source_unit_id: `U-${id}`,
    source_chapter_id: "B001:C0001",
    source_text: `原文${id}：守夜人发现月门正在开启。`,
    evidence_ids: [`B001:C0001:${id}`],
    evidence_precision: "source_exact",
    primary_route: "bounded_event",
    assertion_status: "narrator_asserted",
    temporal_status: "bounded_occurrence",
    evidence_directness: "explicit",
    proposition_text: `未审阅改写${id}`,
    publication_status: "candidate_not_confirmed",
    allowed_work_ids: [work],
    transfer_policy: "no_transfer",
    queryability: "queryable",
    warnings: ["candidate_not_confirmed", "no_transfer"],
    ...o,
  };
}

function row(r: Record<string, unknown>, recordLine: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "reviewed_source_query_manifest_v2",
    manifest_record_id: `M-${r.proposition_id}`,
    candidate_id: `C-${r.proposition_id}`,
    review_batch_type: "source_query",
    decision: "rewrite_source_query_only",
    reviewer_class: "human",
    candidate_status: "source_query_only",
    review_status: "review_only",
    publication_status: "candidate_not_confirmed",
    transfer_policy: "no_transfer",
    consumer_policy: "research_lookup_only",
    no_runtime_effect: true,
    work_scope: {
      scope: "single_work",
      work_id: r.work_id,
      allowed_work_ids: [r.work_id],
      proposition_id: r.proposition_id,
      source_unit_id: r.source_unit_id,
      source_chapter_id: r.source_chapter_id,
    },
    source_record_sha256: sha(recordLine),
    reviewed_evidence: { evidence_ids: r.evidence_ids, source_exact: true },
    reviewed_text_kind: "reviewed_query_text",
    reviewed_text: `已审阅月门${r.proposition_id}`,
    reviewed_modality: {
      assertion_status: r.assertion_status,
      temporal_status: r.temporal_status,
      modality_change: "preserved",
    },
    ...o,
  };
}

let n = 0;
function build(
  records: Record<string, unknown>[],
  rows: (lines: Map<string, string>) => Record<string, unknown>[],
  allowedReviewerClasses: readonly ReviewerClass[] = ["human"],
) {
  const dir = mkdtempSync(join(root, `case${n++}-`));
  const lines = new Map(records.map((r) => [r.proposition_id as string, JSON.stringify(r)]));
  const recordsText = `${[...lines.values()].join("\n")}\n`;
  const manifestText = `${rows(lines).map((x) => JSON.stringify(x)).join("\n")}\n`;
  const recordsPath = join(dir, "records.jsonl");
  const manifestPath = join(dir, "manifest.jsonl");
  writeFileSync(recordsPath, recordsText, "utf8");
  writeFileSync(manifestPath, manifestText, "utf8");
  return {
    manifestPath,
    manifestSha256: sha(Buffer.from(manifestText, "utf8")),
    recordsPath,
    recordsSha256: sha(Buffer.from(recordsText, "utf8")),
    allowedReviewerClasses,
  };
}

const A = rec("P1", "作品甲");
const B = rec("P2", "作品乙");
const RAW = rec("P3", "作品甲", { proposition_text: "未审阅月门记录" });

describe("reviewed source query adapter", () => {
  it("returns only manifest-admitted rows, with reviewed text instead of record text", () => {
    const adapter = loadReviewedSourceQueryAdapter(build([A, B, RAW], (l) => [row(A, l.get("P1")!), row(B, l.get("P2")!)]));
    const hits = adapter.query({ workId: "作品甲", text: "月门" });
    expect(hits.map((h) => h.propositionId)).toEqual(["P1"]);
    expect(adapter.queryWork("作品甲").map((h) => h.propositionId)).toEqual(["P1"]);
    expect(hits[0]!.reviewedText).toBe("已审阅月门P1");
    expect(JSON.stringify(hits)).not.toContain("未审阅");
    expect(hits[0]!.noRuntimeEffect).toBe(true);
    expect(hits[0]!.kind).toBe("source_research_receipt");
    expect(Object.keys(hits[0]!)).not.toContain("operationalFields");
  });

  it("never returns another work's rows", () => {
    const adapter = loadReviewedSourceQueryAdapter(build([A, B], (l) => [row(A, l.get("P1")!), row(B, l.get("P2")!)]));
    for (const work of ["作品甲", "作品乙"]) {
      for (const hit of adapter.query({ workId: work, text: "月门" })) expect(hit.workId).toBe(work);
    }
    expect(() => adapter.query({ workId: "", text: "月门" })).toThrow(ReviewedSourceQueryError);
  });

  it("indexes exact work IDs at load time so public unknown-work queries do not rescan every receipt", () => {
    const adapter = loadReviewedSourceQueryAdapter(build([A, B], (l) => [row(A, l.get("P1")!), row(B, l.get("P2")!)]));
    const allReceipts = [
      ...adapter.queryWork("作品甲"),
      ...adapter.queryWork("作品乙"),
    ];
    const originalFilter = Array.prototype.filter;
    Object.defineProperty(Array.prototype, "filter", {
      configurable: true,
      writable: true,
      value(this: readonly unknown[], ...args: readonly unknown[]) {
        if (this.length === allReceipts.length && this.every((receipt, index) => receipt === allReceipts[index])) {
          throw new Error("queryWork must use its prebuilt work index");
        }
        return Reflect.apply(originalFilter, this, args);
      },
    });

    let unknown: readonly unknown[];
    try {
      unknown = adapter.queryWork("unknown-work");
    } finally {
      Object.defineProperty(Array.prototype, "filter", {
        configurable: true,
        writable: true,
        value: originalFilter,
      });
    }

    expect(unknown!).toEqual([]);
  });

  it("fails closed on hash tampering", () => {
    const cfg = build([A], (l) => [row(A, l.get("P1")!)]);
    writeFileSync(cfg.recordsPath, `${readFileSync(cfg.recordsPath, "utf8")}\n `, "utf8");
    expect(() => loadReviewedSourceQueryAdapter(cfg)).toThrow("records sha256 mismatch");
    expect(() => loadReviewedSourceQueryAdapter({ ...cfg, manifestSha256: "" })).toThrow("sha256 pin required");
  });

  it("rejects an oversized sparse records artifact before trying to hash or parse it", () => {
    const cfg = build([A], (l) => [row(A, l.get("P1")!)]);
    truncateSync(cfg.recordsPath, SOURCE_RESEARCH_MAX_ARTIFACT_BYTES + 1);

    expect(() => loadReviewedSourceQueryAdapter(cfg))
      .toThrow(`records exceeds the ${SOURCE_RESEARCH_MAX_ARTIFACT_BYTES}-byte resource limit`);
  });

  it("requires documented absolute regular files before attempting to read a pinned source artifact", () => {
    const cfg = build([A], (l) => [row(A, l.get("P1")!)]);

    expect(() => loadReviewedSourceQueryAdapter({ ...cfg, manifestPath: "relative-manifest.jsonl" }))
      .toThrow("manifest path must be absolute");
    expect(() => loadReviewedSourceQueryAdapter({ ...cfg, recordsPath: root }))
      .toThrow("records must be a regular file");
  });

  it("rejects a pinned source binding with more nonempty manifest records than the public receipt budget", () => {
    const records = Array.from({ length: SOURCE_RESEARCH_MAX_MANIFEST_ENTRIES + 1 }, (_, index) =>
      rec(`P-${index}`, "overflow-work"),
    );
    const cfg = build(records, (lines) => records.map((entry) => row(entry, lines.get(entry.proposition_id as string)!)));

    expect(() => loadReviewedSourceQueryAdapter(cfg))
      .toThrow(`manifest exceeds the ${SOURCE_RESEARCH_MAX_MANIFEST_ENTRIES}-entry resource limit`);
  });

  it("fails closed on envelope, evidence, source-record hash, and scope mismatches", () => {
    const cases: Array<[string, (l: Map<string, string>) => Record<string, unknown>[]]> = [
      ["source_unit_id mismatch", (l) => [row(A, l.get("P1")!, { work_scope: { ...(row(A, l.get("P1")!).work_scope as object), source_unit_id: "X" } })]],
      ["evidence_ids mismatch", (l) => [row(A, l.get("P1")!, { reviewed_evidence: { evidence_ids: ["other"], source_exact: true } })]],
      ["source_record_sha256 mismatch", (l) => [row(A, l.get("P1")!, { source_record_sha256: "0".repeat(64) })]],
      ["allowed_work_ids must be exactly", (l) => [row(A, l.get("P1")!, { work_scope: { ...(row(A, l.get("P1")!).work_scope as object), allowed_work_ids: ["作品甲", "作品乙"] } })]],
      ["not found in records", (l) => [row(rec("PX", "作品甲"), l.get("P1")!)]],
    ];
    for (const [msg, rows] of cases) {
      expect(() => loadReviewedSourceQueryAdapter(build([A], rows))).toThrow(msg);
    }
  });

  it("throws instead of silently dropping non-candidate states and duplicates", () => {
    expect(() => loadReviewedSourceQueryAdapter(build([A], (l) => [row(A, l.get("P1")!, { publication_status: "published" })])))
      .toThrow("publication_status must be candidate_not_confirmed");
    expect(() => loadReviewedSourceQueryAdapter(build([A], (l) => [row(A, l.get("P1")!, { no_runtime_effect: false })])))
      .toThrow("no_runtime_effect must be true");
    expect(() => loadReviewedSourceQueryAdapter(build([A], (l) => [row(A, l.get("P1")!), row(A, l.get("P1")!, { candidate_id: "C-dup" })])))
      .toThrow("duplicate proposition_id");
    const audit = rec("P9", "作品甲", { queryability: "audit_only" });
    expect(() => loadReviewedSourceQueryAdapter(build([audit], (l) => [row(audit, l.get("P9")!)])))
      .toThrow("record is not queryable");
  });

  it("takes modality from the manifest only when the correction is declared", () => {
    const corrected = (l: Map<string, string>) => [row(A, l.get("P1")!, {
      reviewed_modality: { assertion_status: "direct_speech_claim", temporal_status: "bounded_occurrence", modality_change: "corrected" },
    })];
    const hit = loadReviewedSourceQueryAdapter(build([A], corrected)).query({ workId: "作品甲", text: "月门" })[0]!;
    expect(hit.modality.assertionStatus).toBe("direct_speech_claim");
    expect(hit.warnings).toContain("modality_corrected_in_review");

    const undeclared = (l: Map<string, string>) => [row(A, l.get("P1")!, {
      reviewed_modality: { assertion_status: "direct_speech_claim", temporal_status: "bounded_occurrence", modality_change: "preserved" },
    })];
    expect(() => loadReviewedSourceQueryAdapter(build([A], undeclared))).toThrow("modality_change=preserved");
  });

  it("evidence-only rows expose verbatim evidence and no prose", () => {
    const adapter = loadReviewedSourceQueryAdapter(build([A], (l) => [row(A, l.get("P1")!, { reviewed_text_kind: "evidence_only", reviewed_text: null })]));
    const hit = adapter.query({ workId: "作品甲", text: "守夜人" })[0]!;
    expect(hit.reviewedText).toBeNull();
    expect(hit.evidence.text).toContain("守夜人");
  });

  it("requires an explicit reviewer-class policy and excludes non-admitted classes", () => {
    const rows = (l: Map<string, string>) => [row(A, l.get("P1")!, { reviewer_class: "delegated_assistant" })];
    const humanOnly = loadReviewedSourceQueryAdapter(build([A], rows, ["human"]));
    expect(humanOnly.admittedCount).toBe(0);
    expect(humanOnly.excludedByReviewerClass).toBe(1);
    const withDelegated = loadReviewedSourceQueryAdapter(build([A], rows, ["human", "delegated_assistant"]));
    expect(withDelegated.query({ workId: "作品甲", text: "月门" })[0]!.warnings).toContain("reviewer_class:delegated_assistant");
    expect(() => loadReviewedSourceQueryAdapter(build([A], rows, []))).toThrow("allowedReviewerClasses");
  });

  it("receipts are deeply frozen", () => {
    const hit = loadReviewedSourceQueryAdapter(build([A], (l) => [row(A, l.get("P1")!)])).query({ workId: "作品甲", text: "月门" })[0]!;
    expect(Object.isFrozen(hit)).toBe(true);
    expect(Object.isFrozen(hit.evidence.ids)).toBe(true);
    expect(Object.isFrozen(hit.warnings)).toBe(true);
  });
});
