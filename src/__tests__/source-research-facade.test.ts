import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SourceResearchFacadeError,
  createSourceResearchFacade,
  type SourceResearchBindingConfig,
} from "../world/source-research-facade";
import type { ReviewerClass } from "../world/reviewed-source-query-adapter";

const root = mkdtempSync(join(tmpdir(), "source-research-facade-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function record(id: string, workId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposition_id: id,
    work_id: workId,
    source_unit_id: `unit-${id}`,
    source_chapter_id: "chapter-1",
    source_text: `source evidence ${id}`,
    evidence_ids: [`chapter-1:${id}`],
    assertion_status: "narrator_asserted",
    temporal_status: "bounded_occurrence",
    publication_status: "candidate_not_confirmed",
    allowed_work_ids: [workId],
    transfer_policy: "no_transfer",
    queryability: "queryable",
    ...overrides,
  };
}

function manifestRow(recordValue: Record<string, unknown>, recordLine: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "reviewed_source_query_manifest_v2",
    manifest_record_id: `manifest-${recordValue.proposition_id}`,
    candidate_id: `candidate-${recordValue.proposition_id}`,
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
      work_id: recordValue.work_id,
      allowed_work_ids: [recordValue.work_id],
      proposition_id: recordValue.proposition_id,
      source_unit_id: recordValue.source_unit_id,
      source_chapter_id: recordValue.source_chapter_id,
    },
    source_record_sha256: sha(recordLine),
    reviewed_evidence: { evidence_ids: recordValue.evidence_ids, source_exact: true },
    reviewed_text_kind: "reviewed_query_text",
    reviewed_text: `reviewed text ${recordValue.proposition_id}`,
    reviewed_modality: {
      assertion_status: recordValue.assertion_status,
      temporal_status: recordValue.temporal_status,
      modality_change: "preserved",
    },
    ...overrides,
  };
}

let fixtureNumber = 0;
function fixture(
  records: Record<string, unknown>[],
  rows: (lines: Map<string, string>) => Record<string, unknown>[],
  allowedReviewerClasses: readonly ReviewerClass[] = ["human"],
): SourceResearchBindingConfig {
  const dir = mkdtempSync(join(root, `case-${fixtureNumber++}-`));
  const lines = new Map(records.map((item) => [item.proposition_id as string, JSON.stringify(item)]));
  const recordsText = `${[...lines.values()].join("\n")}\n`;
  const manifestText = `${rows(lines).map((item) => JSON.stringify(item)).join("\n")}\n`;
  const sourceRecordsPath = join(dir, "source-records.jsonl");
  const manifestPath = join(dir, "reviewed-manifest.jsonl");
  writeFileSync(sourceRecordsPath, recordsText, "utf8");
  writeFileSync(manifestPath, manifestText, "utf8");
  return {
    manifestPath,
    manifestSha256: sha(Buffer.from(manifestText, "utf8")),
    sourceRecordsPath,
    sourceRecordsSha256: sha(Buffer.from(recordsText, "utf8")),
    allowedReviewerClasses,
  };
}

const WORK_A = record("P1", "work-a");
const WORK_B = record("P2", "work-b");

describe("source research facade", () => {
  it("returns only immutable, same-work research receipts with read-only status", () => {
    const facade = createSourceResearchFacade(fixture(
      [WORK_A, WORK_B],
      (lines) => [manifestRow(WORK_A, lines.get("P1")!), manifestRow(WORK_B, lines.get("P2")!)],
    ));

    const result = facade.query({ workId: "work-a" });
    expect(result.status).toBe(facade.status);
    expect(result.status).toEqual({
      kind: "source_research_facade_status",
      state: "ready",
      admittedReceiptCount: 2,
      noRuntimeEffect: true,
      readOnly: true,
    });
    expect(result.receipts.map((receipt) => receipt.propositionId)).toEqual(["P1"]);
    expect(result.receipts[0]!.workId).toBe("work-a");
    expect(result.receipts[0]!.noRuntimeEffect).toBe(true);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipts)).toBe(true);
    expect(Object.isFrozen(result.receipts[0]!)).toBe(true);
    expect(Object.isFrozen(result.receipts[0]!.evidence.ids)).toBe(true);
  });

  it("rejects blank or expanded work queries", () => {
    const facade = createSourceResearchFacade(fixture([WORK_A], (lines) => [manifestRow(WORK_A, lines.get("P1")!)]));
    expect(() => facade.query({ workId: "" })).toThrow(SourceResearchFacadeError);
    expect(() => facade.query({ workId: "work-a", text: "not supported" } as unknown as { readonly workId: string })).toThrow("unsupported source research query field");
  });

  it("fails closed when either pinned artifact changes", () => {
    const manifestMismatch = fixture([WORK_A], (lines) => [manifestRow(WORK_A, lines.get("P1")!)]);
    writeFileSync(manifestMismatch.manifestPath, "{}\n", "utf8");
    expect(() => createSourceResearchFacade(manifestMismatch)).toThrow("manifest sha256 mismatch");

    const recordsMismatch = fixture([WORK_A], (lines) => [manifestRow(WORK_A, lines.get("P1")!)]);
    writeFileSync(recordsMismatch.sourceRecordsPath, "{}\n", "utf8");
    expect(() => createSourceResearchFacade(recordsMismatch)).toThrow("records sha256 mismatch");
  });

  it("rejects a reviewer class outside the explicit allowlist", () => {
    const config = fixture(
      [WORK_A],
      (lines) => [manifestRow(WORK_A, lines.get("P1")!, { reviewer_class: "delegated_assistant" })],
      ["human"],
    );
    expect(() => createSourceResearchFacade(config)).toThrow("reviewer class is not allowlisted");
  });

  it("loads a hash-pinned lead_model review only when lead_model is explicitly allowlisted", () => {
    const config = fixture(
      [WORK_A],
      (lines) => [manifestRow(WORK_A, lines.get("P1")!, { reviewer_class: "lead_model" })],
      ["human"],
    );

    expect(() => createSourceResearchFacade(config)).toThrow("reviewer class is not allowlisted");

    const facade = createSourceResearchFacade({ ...config, allowedReviewerClasses: ["human", "lead_model"] });
    expect(facade.query({ workId: "work-a" }).receipts[0]!.reviewerClass).toBe("lead_model");
  });

  it("rejects missing noRuntimeEffect and cross-work records", () => {
    const missingEffect = fixture(
      [WORK_A],
      (lines) => [manifestRow(WORK_A, lines.get("P1")!, { no_runtime_effect: undefined })],
    );
    expect(() => createSourceResearchFacade(missingEffect)).toThrow("no_runtime_effect must be true");

    const crossWork = fixture(
      [WORK_A],
      (lines) => [manifestRow(WORK_A, lines.get("P1")!, {
        work_scope: {
          scope: "single_work",
          work_id: "work-b",
          allowed_work_ids: ["work-b"],
          proposition_id: "P1",
          source_unit_id: "unit-P1",
          source_chapter_id: "chapter-1",
        },
      })],
    );
    expect(() => createSourceResearchFacade(crossWork)).toThrow("work_id mismatch with record");
  });

  it("rejects untyped extra bindings and unsupported mutation calls", () => {
    const config = fixture([WORK_A], (lines) => [manifestRow(WORK_A, lines.get("P1")!)]);
    expect(() => createSourceResearchFacade({ ...config, stateStore: "forbidden" } as SourceResearchBindingConfig)).toThrow("unsupported source research binding field");

    const facade = createSourceResearchFacade(config) as unknown as { readonly mutate: () => void };
    expect(() => facade.mutate()).toThrow("unsupported mutation method: mutate");
  });
});

const configuredArtifact = {
  manifestPath: process.env.SOURCE_RESEARCH_MANIFEST_PATH,
  manifestSha256: process.env.SOURCE_RESEARCH_MANIFEST_SHA256,
  sourceRecordsPath: process.env.SOURCE_RESEARCH_RECORDS_PATH,
  sourceRecordsSha256: process.env.SOURCE_RESEARCH_RECORDS_SHA256,
  allowedReviewerClasses: process.env.SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES,
  workId: process.env.SOURCE_RESEARCH_WORK_ID,
};
const hasConfiguredArtifact = Object.values(configuredArtifact).every((value) => typeof value === "string" && value.trim().length > 0);

describe.skipIf(!hasConfiguredArtifact)("configured reviewed v2 source research artifact", () => {
  it("loads only the caller-provided hash-pinned work scope", () => {
    const workId = configuredArtifact.workId!;
    const facade = createSourceResearchFacade({
      manifestPath: configuredArtifact.manifestPath!,
      manifestSha256: configuredArtifact.manifestSha256!,
      sourceRecordsPath: configuredArtifact.sourceRecordsPath!,
      sourceRecordsSha256: configuredArtifact.sourceRecordsSha256!,
      allowedReviewerClasses: configuredArtifact.allowedReviewerClasses!.split(",").map((value) => value.trim()) as ReviewerClass[],
    });
    const result = facade.query({ workId });
    expect(result.status.noRuntimeEffect).toBe(true);
    for (const receipt of result.receipts) expect(receipt.workId).toBe(workId);
  });
});
