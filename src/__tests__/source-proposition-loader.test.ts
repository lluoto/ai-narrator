import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SourcePropositionLoadError,
  SourcePropositionScopeError,
  loadSourcePropositionAdapter,
} from "../world/source-proposition-loader";

const fixtureRoot = mkdtempSync(join(tmpdir(), "source-proposition-loader-"));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposition_id: "SPR-test-001",
    work_id: "测试作品",
    source_unit_id: "unit-001",
    source_chapter_id: "chapter-001",
    source_text: "守夜人发现月门正在开启。",
    evidence_ids: ["chapter-001:sentence-001"],
    evidence_precision: "source_exact",
    primary_route: "mechanism",
    assertion_status: "narrator_asserted",
    temporal_status: "bounded_occurrence",
    evidence_directness: "explicit",
    proposition_text: "守夜人发现月门正在开启。",
    publication_status: "candidate_not_confirmed",
    allowed_work_ids: ["测试作品"],
    transfer_policy: "no_transfer",
    queryability: "queryable",
    warnings: ["candidate_not_confirmed", "no_transfer"],
    ...overrides,
  };
}

function fixture(name: string, rows: unknown[]): string {
  const path = join(fixtureRoot, name);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return path;
}

function ignoresFrozenMutation(mutator: () => void): void {
  try {
    mutator();
  } catch {
    // Frozen writes throw in strict modules; the following assertions prove no mutation occurred.
  }
}

describe("source proposition adapter", () => {
  it("loads a valid injected synthetic fixture as an audit receipt", () => {
    const adapter = loadSourcePropositionAdapter({ path: fixture("valid.jsonl", [record()]) });

    expect(adapter.query({ workId: "测试作品", text: "月门" })).toEqual([{
      propositionId: "SPR-test-001",
      workId: "测试作品",
      proposition: "守夜人发现月门正在开启。",
      evidence: {
        ids: ["chapter-001:sentence-001"],
        precision: "source_exact",
        sourceUnitId: "unit-001",
        sourceChapterId: "chapter-001",
        text: "守夜人发现月门正在开启。",
      },
      modality: { assertionStatus: "narrator_asserted", evidenceDirectness: "explicit" },
      temporal: "bounded_occurrence",
      warnings: ["candidate_not_confirmed", "no_transfer"],
      route: "mechanism",
      noRuntimeEffect: true,
    }]);
    expect(adapter.query({ workId: "另一作品", text: "月门" })).toEqual([]);
  });

  it("rejects an empty work scope instead of widening the query", () => {
    const adapter = loadSourcePropositionAdapter({ path: fixture("empty-scope.jsonl", [record()]) });

    expect(() => adapter.query({ workId: "", text: "月门" })).toThrow(SourcePropositionScopeError);
  });

  it("rejects a cross-work candidate rather than treating it as transferable", () => {
    const path = fixture("cross-work.jsonl", [record({ allowed_work_ids: ["测试作品", "另一作品"] })]);

    expect(() => loadSourcePropositionAdapter({ path })).toThrow("allowed_work_ids must contain exactly its work_id");
  });

  it("excludes audit-only noise from queryable receipts", () => {
    const adapter = loadSourcePropositionAdapter({ path: fixture("audit-noise.jsonl", [
      record(),
      record({ proposition_id: "SPR-audit-002", proposition_text: "审计记录", queryability: "audit_only" }),
    ]) });

    expect(adapter.query({ workId: "测试作品", text: "记录" })).toEqual([]);
    expect(adapter.query({ workId: "测试作品", text: "月门" })).toHaveLength(1);
  });

  it("keeps loaded receipts deeply immutable and does not consume query results", () => {
    const adapter = loadSourcePropositionAdapter({ path: fixture("immutable.jsonl", [record()]) });
    const receipt = adapter.query({ workId: "测试作品", text: "月门" })[0]! as unknown as {
      proposition: string;
      evidence: { ids: string[] };
      warnings: string[];
    };

    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.evidence)).toBe(true);
    expect(Object.isFrozen(receipt.evidence.ids)).toBe(true);
    expect(Object.isFrozen(receipt.warnings)).toBe(true);
    ignoresFrozenMutation(() => { receipt.proposition = "篡改"; });
    ignoresFrozenMutation(() => { receipt.evidence.ids.pop(); });
    ignoresFrozenMutation(() => { receipt.warnings.push("篡改"); });

    expect(adapter.query({ workId: "测试作品", text: "月门" })).toEqual([expect.objectContaining({
      proposition: "守夜人发现月门正在开启。",
      evidence: expect.objectContaining({ ids: ["chapter-001:sentence-001"] }),
      warnings: ["candidate_not_confirmed", "no_transfer"],
    })]);
  });

  it("uses literal Chinese substring matching and an optional exact route", () => {
    const adapter = loadSourcePropositionAdapter({ path: fixture("chinese-query.jsonl", [
      record(),
      record({ proposition_id: "SPR-test-002", proposition_text: "月门的倒影消失。", primary_route: "bounded_event" }),
    ]) });

    expect(adapter.query({ workId: "测试作品", text: "月门" })).toHaveLength(2);
    expect(adapter.query({ workId: "测试作品", text: "月门", route: "mechanism" }).map((entry) => entry.propositionId))
      .toEqual(["SPR-test-001"]);
  });

  it("fails closed for malformed JSONL and invalid queryable candidates", () => {
    const malformed = join(fixtureRoot, "malformed.jsonl");
    writeFileSync(malformed, `${JSON.stringify(record())}\nnot-json\n`, "utf8");
    const invalid = fixture("invalid-candidate.jsonl", [record({ proposition_text: "" })]);

    expect(() => loadSourcePropositionAdapter({ path: malformed })).toThrow(SourcePropositionLoadError);
    expect(() => loadSourcePropositionAdapter({ path: invalid })).toThrow("proposition_text must be a nonempty string");
  });

  it("throws on unexpected publication/transfer/queryability states and duplicate ids", () => {
    const published = fixture("published.jsonl", [record({ publication_status: "published" })]);
    const transfer = fixture("transfer.jsonl", [record({ transfer_policy: "allowed" })]);
    const unknownQuery = fixture("unknown-query.jsonl", [record({ queryability: "maybe" })]);
    const duplicate = fixture("duplicate.jsonl", [record(), record()]);

    expect(() => loadSourcePropositionAdapter({ path: published })).toThrow("publication_status must be candidate_not_confirmed");
    expect(() => loadSourcePropositionAdapter({ path: transfer })).toThrow("transfer_policy must be no_transfer");
    expect(() => loadSourcePropositionAdapter({ path: unknownQuery })).toThrow("queryability must be queryable or audit_only");
    expect(() => loadSourcePropositionAdapter({ path: duplicate })).toThrow("duplicate proposition_id");
  });
});
