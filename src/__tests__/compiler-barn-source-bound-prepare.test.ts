import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { createPreparedCompilerArtifact } from "../compiler/compiler-artifact";
import { resolveDraftModule } from "../compiler/compile-hint-resolution";
import { buildCompilerQuestionQueue, MODULE_COMPILE_HINTS_SCHEMA_VERSION } from "../compiler/compiler-question-queue";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildPreparedSourceFactDispositionReport } from "../compiler/source-fact-disposition";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { sha256, type DocumentIR } from "../ingest/document-ir";
import { cleanPagesWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import {
  BARN_SOURCE_EVIDENCE_MANIFEST_PATH,
  BARN_SOURCE_PDF_SHA256,
  canonicalizeSourceEvidenceText,
  readSourceEvidenceManifest,
} from "../ingest/three-way-audit";

/**
 * Builds only a source-exact DocumentIR from the tracked, integrity-checked
 * evidence corpus. It deliberately does not import BARN_OF_PREMIER, its
 * handwritten runtime data, or any reviewed hints from another module.
 *
 * The separate opt-in two-PDF runner exercises the local PDF parser. Keeping
 * this regression source-bound makes ordinary `bun test` clean-clone-safe.
 */
function freshBarnDocument(): DocumentIR {
  const manifest = readSourceEvidenceManifest();
  if ("ok" in manifest) {
    if (!manifest.ok) throw new Error(manifest.reason);
    throw new Error("unexpected source-evidence manifest result");
  }
  const documentHash = manifest.source.originalPdfSha256;
  return {
    schemaVersion: "1.0.0",
    documentHash,
    hashSource: "pdf_bytes_sha256",
    pages: manifest.sections.map((section) => {
      const rawText = canonicalizeSourceEvidenceText(readFileSync(
        join(dirname(BARN_SOURCE_EVIDENCE_MANIFEST_PATH), manifest.corpusDirectory, section.file),
        "utf8",
      ));
      return {
        pageNumber: section.pdfPage,
        rawText,
        rawTextHash: sha256(rawText),
        documentHash,
        hashSource: "pdf_bytes_sha256",
      };
    }),
  };
}

function prepareFreshBarnStructure() {
  const document = freshBarnDocument();
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(cleanPagesWithTrace(document.pages)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "barn-source-bound-fresh" });
  const queue = buildCompilerQuestionQueue(graph, draft);
  return { document, graph, draft, queue };
}

describe("Barn source-bound fresh compiler preparation", () => {
  it("creates a stable draft-only queue from the controlled 18-page source without runtime answers", () => {
    const first = prepareFreshBarnStructure();
    const second = prepareFreshBarnStructure();
    const byKind = Object.fromEntries(Object.entries(Object.groupBy(first.queue.questions, (question) => question.kind)).map(([kind, questions]) => [kind, questions.length]));
    const byStatus = Object.fromEntries(Object.entries(Object.groupBy(first.queue.questions, (question) => question.status)).map(([status, questions]) => [status, questions.length]));

    expect(first.document.documentHash).toBe(BARN_SOURCE_PDF_SHA256);
    expect(first.document.pages).toHaveLength(18);
    expect(first.draft.sourceGraphIdentity).toBe("1b2f07657a8727b522d231338a9af3bb2f9cbbb03a74e552dc8b4a3beecf3029");
    expect(first.draft).toMatchObject({
      moduleId: "barn-source-bound-fresh",
      documentHash: BARN_SOURCE_PDF_SHA256,
      sourceGraphIdentity: first.draft.sourceGraphIdentity,
    });
    expect({
      scenes: first.draft.sceneCandidates.length,
      clues: first.draft.clueCandidates.length,
      clueFactAtoms: first.draft.clueFactAtoms.length,
      sourceFactAtoms: first.draft.sourceFactAtoms.length,
      proseFactFindingCandidates: first.draft.proseFactFindingCandidates.length,
      items: first.draft.itemCandidates.length,
      rewards: first.draft.rewardCandidates.length,
      proseNpcAnchors: first.draft.proseNpcAnchors.length,
    }).toEqual({
      scenes: 49,
      clues: 30,
      clueFactAtoms: 81,
      sourceFactAtoms: 347,
      proseFactFindingCandidates: 0,
      items: 30,
      rewards: 2,
      proseNpcAnchors: 63,
    });
    expect(first.queue.questions).toHaveLength(410);
    expect(byKind).toEqual({
      connection_topology: 49,
      npc_binding: 63,
      clue_fact_facets: 30,
      source_fact_mechanic: 26,
      source_fact_disposition: 90,
      scene_role: 49,
      discovery_method: 39,
      core_clue: 30,
      item_binding: 30,
      ending_rule: 1,
      entry_scene: 1,
      reward_binding: 2,
    });
    expect(byStatus).toEqual({ open: 384, deferred: 26 });
    expect(first.queue.questions.filter((question) => question.severity === "publish_blocking")).toHaveLength(130);
    const facetQuestions = first.queue.questions.filter((question) => question.kind === "clue_fact_facets");
    expect(facetQuestions).toHaveLength(30);
    expect(facetQuestions.every((question) => (question.allowedClueFactAtoms?.length ?? 0) > 0)).toBe(true);

    const bodyFor = (clueName: string) => {
      const clue = first.draft.clueCandidates.find((candidate) => candidate.displayName === clueName);
      if (!clue) throw new Error(`missing Barn clue ${clueName}`);
      const body = first.graph.statements.find((statement) => statement.id === clue.bodyStatementId);
      if (!body) throw new Error(`missing Barn clue body ${clueName}`);
      const atoms = first.draft.clueFactAtoms.filter((atom) => atom.clueCandidateId === clue.id);
      return { clue, body, atoms };
    };
    const doorKey = bodyFor("防盗门的钥匙");
    const otherVictims = bodyFor("其他受害者的床位");
    expect(doorKey.clue.id).toBe("draft_clue_0f9d10d1bc808f5c2d0e3c80");
    expect(otherVictims.clue.id).toBe("draft_clue_4ddcf47ede81d623a8b85d8c");
    expect([...new Set(doorKey.body.evidence.spans.map((span) => span.pageNumber))]).toEqual([6, 7]);
    expect(doorKey.atoms.map((atom) => atom.evidence.spans[0]?.pageNumber)).toEqual([6, 6, 7]);
    expect(doorKey.atoms.map((atom) => atom.quote)).toEqual([
      "用来打开艾德里安农场\n谷仓的门。",
      "在这个小镇里，这种先进防盗门可",
      "不多见。",
    ]);
    expect([...new Set(otherVictims.body.evidence.spans.map((span) => span.pageNumber))]).toEqual([10, 11]);
    expect(otherVictims.atoms.map((atom) => atom.evidence.spans[0]?.pageNumber)).toEqual([10, 11, 11, 11, 11, 11]);
    for (const { body, atoms } of [doorKey, otherVictims]) {
      expect(atoms.length).toBeGreaterThan(0);
      expect(atoms.every((atom) => atom.evidence.spans.length === 1 && atom.evidence.spans[0]?.exactText === atom.quote)).toBe(true);
      expect(atoms.map((atom) => atom.quote).join("").replace(/\s/g, "")).toBe(body.text.replace(/\s/g, ""));
      expect(atoms.map((atom) => atom.id)).toEqual([...atoms]
        .sort((left, right) => left.evidence.spans[0]!.pageNumber - right.evidence.spans[0]!.pageNumber
          || left.evidence.spans[0]!.rawStart - right.evidence.spans[0]!.rawStart)
        .map((atom) => atom.id));
      for (let index = 1; index < atoms.length; index++) {
        const previous = atoms[index - 1]!.evidence.spans[0]!;
        const current = atoms[index]!.evidence.spans[0]!;
        if (previous.pageNumber === current.pageNumber) expect(current.rawStart).toBeGreaterThanOrEqual(previous.rawEnd);
      }
    }

    expect(first.queue.queueHash).toBe(second.queue.queueHash);
    // The source document/graph did not change, but atom candidates do, so a
    // former prepared queue and every hint bound to it are intentionally stale.
    expect(first.queue.queueHash).not.toBe("2758eb7372b9e5c4272c0aaf3da7b367458968304823196939d8ee325473b749");
    expect(first.draft.sourceGraphIdentity).toBe(second.draft.sourceGraphIdentity);

    const artifactFor = ({ graph, draft, queue }: ReturnType<typeof prepareFreshBarnStructure>) => createPreparedCompilerArtifact({
      identity: {
        moduleId: queue.moduleId,
        documentHash: queue.documentHash,
        sourceGraphIdentity: queue.sourceGraphIdentity,
        preparedQueueHash: queue.queueHash,
      },
      graph,
      draft,
      preparedQueue: queue,
      sourceFactDispositionReport: buildPreparedSourceFactDispositionReport(graph, draft, queue),
    });
    const firstArtifact = artifactFor(first);
    const secondArtifact = artifactFor(second);
    expect(firstArtifact.payload.identity.preparedQueueHash).toBe(first.queue.queueHash);
    expect(firstArtifact.payload.identity.preparedQueueHash).not.toBe("2758eb7372b9e5c4272c0aaf3da7b367458968304823196939d8ee325473b749");
    expect(firstArtifact.artifactHash).toBe(secondArtifact.artifactHash);

    const unresolved = resolveDraftModule(first.graph, first.draft, first.queue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: first.queue.moduleId,
      documentHash: first.queue.documentHash,
      sourceGraphIdentity: first.queue.sourceGraphIdentity,
      resolutions: [],
    });
    expect(unresolved.readiness.status).toBe("draft_only");
    expect(unresolved.mechanicsIR).toBeUndefined();
    expect(unresolved.readiness.openQuestionIds).toHaveLength(384);
    expect(unresolved.readiness.publishBlockingQuestionIds).toHaveLength(130);
    expect(unresolved.readiness.blockingCodes).toEqual(expect.arrayContaining([
      "unresolved_scene_candidates",
      "missing_entry_scene",
      "missing_ending_rules",
      "missing_connection_topology",
    ]));
  }, 20_000);
});
