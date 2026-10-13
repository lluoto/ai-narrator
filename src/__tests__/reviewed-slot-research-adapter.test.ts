import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReviewedSlotResearchError,
  loadReviewedSlotResearchAdapter,
  type ReviewedSlotResearchConfig,
} from "../world/reviewed-slot-research-adapter";

const root = mkdtempSync(join(tmpdir(), "reviewed-slot-research-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const SLOT_RESEARCH_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SLOT_RESEARCH_MAX_BINDINGS = 128;
const SLOT_RESEARCH_MAX_MANIFEST_ENTRIES = 1024;

interface Fixture {
  readonly config: ReviewedSlotResearchConfig;
  readonly manifestPath: string;
  readonly indexPath: string;
  readonly proposalPath: string;
  readonly dossierTranchePath: string;
}

let fixtureNumber = 0;
function fixture(
  allowedReviewerClasses: ReviewedSlotResearchConfig["allowedReviewerClasses"] = ["lead_model"],
): Fixture {
  const dir = mkdtempSync(join(root, `case-${fixtureNumber++}-`));
  const parentBatch = writeArtifact(dir, "batch-manifest.json", "{\"artifact\":\"parent\"}\n");
  const sourcePropositions = writeArtifact(dir, "source-propositions.jsonl", "{\"proposition_id\":\"source\"}\n");
  const sourceSentences = writeArtifact(dir, "source-sentences.csv", "sentence_id,text\nS1,opaque\n");
  const proposalA = "{\"proposition_id\":\"SPR-V2-A\",\"raw_source_prose\":\"do not expose this\"}";
  const proposalB = "{\"proposition_id\":\"SPR-V2-B\",\"raw_source_prose\":\"nor this\"}";
  const proposal = writeArtifact(dir, "proposal-generation-records.jsonl", `${proposalA}\n${proposalB}\n`);
  const verifierA = writeArtifact(dir, "canonical-a.json", "{\"case_id\":\"VCV5-BE-001\"}\n");
  const verifierB = writeArtifact(dir, "canonical-b.json", "{\"case_id\":\"VCV5-EP-001\"}\n");
  const dossierTrancheLine = "{\"review_dossier_id\":\"LMD-SB8001-TRV1-001\",\"raw_source_prose\":\"or this\"}";
  const dossierRemainingLine = "{\"review_dossier_id\":\"LMD-SB8001-RMV1-001\",\"raw_source_prose\":\"also hidden\"}";
  const dossierTranche = writeArtifact(dir, "lead-review-tranche-dossiers.jsonl", `${dossierTrancheLine}\n`);
  const dossierRemaining = writeArtifact(dir, "lead-review-remaining-dossiers.jsonl", `${dossierRemainingLine}\n`);

  const rowA = realRow({
    proposalId: "SPR-V2-A",
    proposalRecordSha256: sha(proposalA),
    proposalFileSha256: proposal.sha256,
    verifierCaseId: "VCV5-BE-001",
    verifierSha256: verifierA.sha256,
    dossierId: "LMD-SB8001-TRV1-001",
    dossierLineSha256: sha(`${dossierTrancheLine}\n`),
    dossierFileSha256: dossierTranche.sha256,
    workId: "work-a",
    sourceUnitId: "CG0003",
    sourceEvidenceId: "B001:C0077:S000030",
    route: "bounded_event",
  }, parentBatch.sha256, sourcePropositions.sha256, sourceSentences.sha256);
  const rowB = realRow({
    proposalId: "SPR-V2-B",
    proposalRecordSha256: sha(proposalB),
    proposalFileSha256: proposal.sha256,
    verifierCaseId: "VCV5-EP-001",
    verifierSha256: verifierB.sha256,
    dossierId: "LMD-SB8001-RMV1-001",
    dossierLineSha256: sha(`${dossierRemainingLine}\n`),
    dossierFileSha256: dossierRemaining.sha256,
    workId: "work-b",
    sourceUnitId: "CN0001",
    sourceEvidenceId: "B001:C0001:S000060",
    route: "entity_profile",
  }, parentBatch.sha256, sourcePropositions.sha256, sourceSentences.sha256);
  const manifestText = `${JSON.stringify(rowA)}\n${JSON.stringify(rowB)}\n`;
  const manifestPath = join(dir, "reviewed_slot_research_manifest_v1.jsonl");
  writeFileSync(manifestPath, manifestText, "utf8");
  const manifestSha256 = sha(manifestText);
  const index = {
    schema_version: "reviewed_slot_research_artifact_binding_index_v1",
    manifest_sha256: manifestSha256,
    bindings: [
      parentBatch,
      sourcePropositions,
      sourceSentences,
      proposal,
      verifierA,
      verifierB,
      dossierTranche,
      dossierRemaining,
    ].map((artifact) => ({
      reference_sha256: artifact.sha256,
      path: artifact.path,
      file_sha256: artifact.sha256,
    })),
  };
  const indexPath = join(dir, "artifact-bindings.json");
  writeFileSync(indexPath, `${JSON.stringify(index)}\n`, "utf8");
  return {
    manifestPath,
    indexPath,
    proposalPath: proposal.path,
    dossierTranchePath: dossierTranche.path,
    config: {
      manifestPath,
      manifestSha256,
      artifactBindingIndexPath: indexPath,
      artifactBindingIndexSha256: sha(readFileSync(indexPath)),
      allowedReviewerClasses,
    },
  };
}

function writeArtifact(dir: string, name: string, content: string): { readonly path: string; readonly sha256: string } {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return { path, sha256: sha(content) };
}

function realRow(
  values: {
    readonly proposalId: string;
    readonly proposalRecordSha256: string;
    readonly proposalFileSha256: string;
    readonly verifierCaseId: string;
    readonly verifierSha256: string;
    readonly dossierId: string;
    readonly dossierLineSha256: string;
    readonly dossierFileSha256: string;
    readonly workId: string;
    readonly sourceUnitId: string;
    readonly sourceEvidenceId: string;
    readonly route: string;
  },
  parentBatchSha256: string,
  sourcePropositionsSha256: string,
  sourceSentencesSha256: string,
): Record<string, unknown> {
  return {
    source_parent_hashes: {
      parent_batch_manifest_sha256: parentBatchSha256,
      source_proposition_records_sha256: sourcePropositionsSha256,
      source_sentences_sha256: sourceSentencesSha256,
      lead_dossier_file_sha256: values.dossierFileSha256,
    },
    proposal: {
      proposal_id: values.proposalId,
      proposal_record_sha256: values.proposalRecordSha256,
      proposal_records_file_sha256: values.proposalFileSha256,
    },
    verifier: { case_id: values.verifierCaseId, canonical_verdict_sha256: values.verifierSha256 },
    lead_dossier: { dossier_id: values.dossierId, dossier_line_sha256: values.dossierLineSha256 },
    work_source: {
      work_id: values.workId,
      allowed_work_ids: [values.workId],
      source_unit_id: values.sourceUnitId,
      source_evidence_id: values.sourceEvidenceId,
    },
    route: values.route,
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
    reviewer_class: "lead_model",
    publication_status: "candidate_not_confirmed",
    transfer_policy: "no_transfer",
    consumer_policy: "research_lookup_only",
    no_runtime_effect: true,
  };
}

describe("reviewed slot research adapter", () => {
  it("loads the real closed row layout with proposal, verifier, and two dossier bindings", () => {
    const { config } = fixture();
    const adapter = loadReviewedSlotResearchAdapter(config);
    const [receipt] = adapter.queryWork("work-a");

    expect(receipt).toEqual({
      proposal: {
        id: "SPR-V2-A",
        recordSha256: sha("{\"proposition_id\":\"SPR-V2-A\",\"raw_source_prose\":\"do not expose this\"}"),
        recordsFileSha256: expect.any(String),
      },
      verifier: { caseId: "VCV5-BE-001", canonicalVerdictSha256: expect.any(String) },
      leadDossier: {
        id: "LMD-SB8001-TRV1-001",
        lineSha256: sha("{\"review_dossier_id\":\"LMD-SB8001-TRV1-001\",\"raw_source_prose\":\"or this\"}\n"),
        fileSha256: expect.any(String),
      },
      sourceParentHashes: {
        parentBatchManifestSha256: expect.any(String),
        sourcePropositionRecordsSha256: expect.any(String),
        sourceSentencesSha256: expect.any(String),
      },
      workSource: { workId: "work-a", sourceUnitId: "CG0003", sourceEvidenceId: "B001:C0077:S000030" },
      route: "bounded_event",
      reviewerClass: "lead_model",
      warnings: [
        "candidate_not_confirmed",
        "no_transfer",
        "research_lookup_only",
        "reviewer_class:lead_model",
        "model_reviewed_not_human_gold",
      ],
      modalityScope: {
        assertionStatus: "narrator_asserted",
        claimantOrSource: null,
        claimantStatus: "narrator",
        temporalStatus: "bounded_occurrence",
        evidenceDirectness: "explicit",
        sourcePropositionExtractable: "yes",
        generalityScope: "instance",
        generalityCueSpan: null,
      },
    });
    expect(adapter.admittedCount).toBe(2);
    expect(adapter.excludedByReviewerClass).toBe(0);
    expect(adapter.queryWork("work-b")[0]!.leadDossier.id).toBe("LMD-SB8001-RMV1-001");
    expect(adapter.queryWork("unknown")).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain("raw_source_prose");
    expect(JSON.stringify(receipt)).not.toContain("do not expose this");
  });

  it("rejects the prior synthetic schema, partial bindings, and duplicate binding references", () => {
    const synthetic = fixture();
    writeFileSync(synthetic.manifestPath, `${JSON.stringify({
      schema_version: "reviewed_slot_research_manifest_v1",
      proposal_artifact: {},
    })}\n`, "utf8");
    const syntheticManifestSha256 = sha(readFileSync(synthetic.manifestPath));
    const syntheticIndex = JSON.parse(readFileSync(synthetic.indexPath, "utf8")) as { manifest_sha256: string };
    syntheticIndex.manifest_sha256 = syntheticManifestSha256;
    writeFileSync(synthetic.indexPath, `${JSON.stringify(syntheticIndex)}\n`, "utf8");
    expect(() => loadReviewedSlotResearchAdapter({
      ...synthetic.config,
      manifestSha256: syntheticManifestSha256,
      artifactBindingIndexSha256: sha(readFileSync(synthetic.indexPath)),
    })).toThrow("unsupported field schema_version");

    const missing = fixture();
    const missingIndex = JSON.parse(readFileSync(missing.indexPath, "utf8")) as { bindings: unknown[] };
    missingIndex.bindings.pop();
    writeFileSync(missing.indexPath, `${JSON.stringify(missingIndex)}\n`, "utf8");
    expect(() => loadReviewedSlotResearchAdapter({
      ...missing.config,
      artifactBindingIndexSha256: sha(readFileSync(missing.indexPath)),
    })).toThrow("missing binding");

    const duplicate = fixture();
    const duplicateIndex = JSON.parse(readFileSync(duplicate.indexPath, "utf8")) as { bindings: unknown[] };
    duplicateIndex.bindings.push(duplicateIndex.bindings[0]!);
    writeFileSync(duplicate.indexPath, `${JSON.stringify(duplicateIndex)}\n`, "utf8");
    expect(() => loadReviewedSlotResearchAdapter({
      ...duplicate.config,
      artifactBindingIndexSha256: sha(readFileSync(duplicate.indexPath)),
    })).toThrow("duplicate reference_sha256");
  });

  it("fails closed when a pin or a selected proposal/dossier line hash drifts", () => {
    const pinMismatch = fixture();
    writeFileSync(pinMismatch.proposalPath, "changed\n", "utf8");
    expect(() => loadReviewedSlotResearchAdapter(pinMismatch.config)).toThrow("artifact binding");

    const lineMismatch = fixture();
    const manifestLines = readFileSync(lineMismatch.manifestPath, "utf8").trim().split("\n");
    const row = JSON.parse(manifestLines[0]!) as { lead_dossier: { dossier_line_sha256: string } };
    row.lead_dossier.dossier_line_sha256 = "0".repeat(64);
    manifestLines[0] = JSON.stringify(row);
    const manifestText = `${manifestLines.join("\n")}\n`;
    writeFileSync(lineMismatch.manifestPath, manifestText, "utf8");
    const index = JSON.parse(readFileSync(lineMismatch.indexPath, "utf8")) as { manifest_sha256: string };
    index.manifest_sha256 = sha(manifestText);
    writeFileSync(lineMismatch.indexPath, `${JSON.stringify(index)}\n`, "utf8");
    expect(() => loadReviewedSlotResearchAdapter({
      ...lineMismatch.config,
      manifestSha256: sha(manifestText),
      artifactBindingIndexSha256: sha(readFileSync(lineMismatch.indexPath)),
    })).toThrow("line sha256 mismatch");
  });

  it("rejects an oversized sparse bound artifact before hashing its bytes", () => {
    const oversized = fixture();
    truncateSync(oversized.proposalPath, SLOT_RESEARCH_MAX_ARTIFACT_BYTES + 1);

    expect(() => loadReviewedSlotResearchAdapter(oversized.config))
      .toThrow(`exceeds the ${SLOT_RESEARCH_MAX_ARTIFACT_BYTES}-byte resource limit`);
  });

  it("rejects more nonempty slot manifest entries than the public receipt budget before row parsing", () => {
    const oversized = fixture();
    const line = readFileSync(oversized.manifestPath, "utf8").trim().split("\n")[0]!;
    const manifest = `${Array.from({ length: SLOT_RESEARCH_MAX_MANIFEST_ENTRIES + 1 }, () => line).join("\n")}\n`;
    writeFileSync(oversized.manifestPath, manifest, "utf8");
    const index = JSON.parse(readFileSync(oversized.indexPath, "utf8")) as { manifest_sha256: string };
    index.manifest_sha256 = sha(manifest);
    writeFileSync(oversized.indexPath, `${JSON.stringify(index)}\n`, "utf8");

    expect(() => loadReviewedSlotResearchAdapter({
      ...oversized.config,
      manifestSha256: sha(manifest),
      artifactBindingIndexSha256: sha(readFileSync(oversized.indexPath)),
    })).toThrow(`slot manifest: exceeds the ${SLOT_RESEARCH_MAX_MANIFEST_ENTRIES}-entry resource limit`);
  });

  it("rejects a binding index with more entries than the fixed artifact budget before coverage validation", () => {
    const oversized = fixture();
    const index = JSON.parse(readFileSync(oversized.indexPath, "utf8")) as {
      bindings: Array<{ reference_sha256: string; path: string; file_sha256: string }>;
    };
    while (index.bindings.length <= SLOT_RESEARCH_MAX_BINDINGS) {
      const pin = index.bindings.length.toString(16).padStart(64, "0");
      index.bindings.push({ reference_sha256: pin, path: join(root, `unused-${index.bindings.length}`), file_sha256: pin });
    }
    writeFileSync(oversized.indexPath, `${JSON.stringify(index)}\n`, "utf8");

    expect(() => loadReviewedSlotResearchAdapter({
      ...oversized.config,
      artifactBindingIndexSha256: sha(readFileSync(oversized.indexPath)),
    })).toThrow(`artifact binding index bindings: exceeds the ${SLOT_RESEARCH_MAX_BINDINGS}-entry resource limit`);
  });

  it("deep-freezes all receipt metadata and rejects blank work IDs", () => {
    const adapter = loadReviewedSlotResearchAdapter(fixture().config);
    const receipts = adapter.queryWork("work-a");
    const receipt = receipts[0]!;

    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.isFrozen(receipts)).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.proposal)).toBe(true);
    expect(Object.isFrozen(receipt.leadDossier)).toBe(true);
    expect(Object.isFrozen(receipt.warnings)).toBe(true);
    expect(Object.isFrozen(receipt.modalityScope)).toBe(true);
    expect(() => adapter.queryWork("")).toThrow(ReviewedSlotResearchError);
  });

  it("requires an explicit reviewer-class policy and excludes valid unadmitted rows", () => {
    const configured = fixture();
    const { allowedReviewerClasses: _allowedReviewerClasses, ...withoutAllowedReviewerClasses } = configured.config;
    expect(() => loadReviewedSlotResearchAdapter(withoutAllowedReviewerClasses as ReviewedSlotResearchConfig))
      .toThrow("missing required field allowedReviewerClasses");
    expect(() => loadReviewedSlotResearchAdapter({ ...fixture().config, allowedReviewerClasses: [] }))
      .toThrow("allowedReviewerClasses must be an explicit nonempty list");

    const humanOnly = loadReviewedSlotResearchAdapter(fixture(["human"]).config);
    expect(humanOnly.admittedCount).toBe(0);
    expect(humanOnly.excludedByReviewerClass).toBe(2);
    expect(humanOnly.queryWork("work-a")).toEqual([]);

    const leadOnly = loadReviewedSlotResearchAdapter(fixture(["lead_model"]).config);
    expect(leadOnly.queryWork("work-a")[0]).toMatchObject({
      reviewerClass: "lead_model",
      warnings: expect.arrayContaining(["reviewer_class:lead_model", "model_reviewed_not_human_gold"]),
    });
  });

  it("rejects unknown reviewer classes in a manifest or configuration", () => {
    const unknownManifest = fixture();
    const manifestLines = readFileSync(unknownManifest.manifestPath, "utf8").trim().split("\n");
    const row = JSON.parse(manifestLines[0]!) as { reviewer_class: string };
    row.reviewer_class = "machine";
    manifestLines[0] = JSON.stringify(row);
    const manifestText = `${manifestLines.join("\n")}\n`;
    writeFileSync(unknownManifest.manifestPath, manifestText, "utf8");
    const index = JSON.parse(readFileSync(unknownManifest.indexPath, "utf8")) as { manifest_sha256: string };
    index.manifest_sha256 = sha(manifestText);
    writeFileSync(unknownManifest.indexPath, `${JSON.stringify(index)}\n`, "utf8");
    expect(() => loadReviewedSlotResearchAdapter({
      ...unknownManifest.config,
      manifestSha256: sha(manifestText),
      artifactBindingIndexSha256: sha(readFileSync(unknownManifest.indexPath)),
    })).toThrow("unknown reviewer_class machine");
    expect(() => loadReviewedSlotResearchAdapter({ ...fixture().config, allowedReviewerClasses: ["machine"] as never }))
      .toThrow("unknown reviewer class machine");
  });

  it("requires absolute manifest, index, and artifact binding paths", () => {
    const manifest = fixture();
    expect(() => loadReviewedSlotResearchAdapter({ ...manifest.config, manifestPath: "reviewed-slot-research.jsonl" }))
      .toThrow("manifest path must be absolute");

    const index = fixture();
    expect(() => loadReviewedSlotResearchAdapter({ ...index.config, artifactBindingIndexPath: "artifact-bindings.json" }))
      .toThrow("artifact binding index path must be absolute");

    const binding = fixture();
    const parsedIndex = JSON.parse(readFileSync(binding.indexPath, "utf8")) as {
      bindings: Array<{ path: string }>;
    };
    parsedIndex.bindings[0]!.path = "artifact.json";
    writeFileSync(binding.indexPath, `${JSON.stringify(parsedIndex)}\n`, "utf8");
    expect(() => loadReviewedSlotResearchAdapter({
      ...binding.config,
      artifactBindingIndexSha256: sha(readFileSync(binding.indexPath)),
    })).toThrow("artifact binding index bindings[0] path must be absolute");
  });

  it("rejects blank or whitespace manifest records while accepting one final newline terminator", () => {
    expect(() => loadReviewedSlotResearchAdapter(fixture().config)).not.toThrow();

    for (const suffix of ["\n", " \n", "\t\r\n"]) {
      const blankRecord = fixture();
      const manifestText = `${readFileSync(blankRecord.manifestPath, "utf8")}${suffix}`;
      writeFileSync(blankRecord.manifestPath, manifestText, "utf8");
      expect(() => loadReviewedSlotResearchAdapter({
        ...blankRecord.config,
        manifestSha256: sha(manifestText),
      })).toThrow("slot manifest line 3: must not be blank");
    }
  });
});

const RUN_WORLDMODEL_SMOKE = process.env.SLOT_RESEARCH_RUN_WORLDMODEL_SMOKE === "true";
describe.skipIf(!RUN_WORLDMODEL_SMOKE)("reviewed slot research actual worldmodel smoke", () => {
  it("loads the 20260924 manifest only from a complete, independently pinned binding index", () => {
    type ArtifactConfigKey = Exclude<keyof ReviewedSlotResearchConfig, "allowedReviewerClasses">;
    const required = (name: ArtifactConfigKey): string => {
      const value = process.env[{
        manifestPath: "SLOT_RESEARCH_MANIFEST_PATH",
        manifestSha256: "SLOT_RESEARCH_MANIFEST_SHA256",
        artifactBindingIndexPath: "SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH",
        artifactBindingIndexSha256: "SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256",
      }[name]];
      if (!value?.trim()) throw new Error(`${name} is required when SLOT_RESEARCH_RUN_WORLDMODEL_SMOKE=true`);
      return value;
    };
    const artifactConfig = {
      manifestPath: required("manifestPath"),
      manifestSha256: required("manifestSha256"),
      artifactBindingIndexPath: required("artifactBindingIndexPath"),
      artifactBindingIndexSha256: required("artifactBindingIndexSha256"),
    };
    const leadModel = loadReviewedSlotResearchAdapter({ ...artifactConfig, allowedReviewerClasses: ["lead_model"] });
    const receipts = [
      ...leadModel.queryWork("异常生物见闻录_远瞳"),
      ...leadModel.queryWork("黎明之剑"),
      ...leadModel.queryWork("疯巫妖的实验日志"),
    ];

    expect(leadModel.admittedCount).toBe(79);
    expect(receipts).toHaveLength(79);
    expect(JSON.stringify(receipts)).not.toContain("raw_model_content");
    expect(JSON.stringify(receipts)).not.toContain("rewrite_payload");

    const human = loadReviewedSlotResearchAdapter({ ...artifactConfig, allowedReviewerClasses: ["human"] });
    expect(human.admittedCount).toBe(0);
    expect(human.excludedByReviewerClass).toBe(79);
  });
});
