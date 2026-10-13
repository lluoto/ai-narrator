import { describe, expect, it } from "bun:test";
import {
  MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  buildCompilerQuestionQueue,
  parseCompilerHintValue,
  validateCompilerQuestionQueue,
  validateModuleCompileHints,
  type CompilerQuestion,
  type ModuleCompileHints,
} from "../compiler/compiler-question-queue";
import { applyModuleCompileHints } from "../compiler/compile-hint-resolution";
import { compileGroundedHintProposals, buildCompilerHintProposalRequestEnvelope } from "../compiler/compiler-hint-proposals";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { buildResolvedSourceFactDispositionReport, validateSourceFactDispositionReport } from "../compiler/source-fact-disposition";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";

function fixture() {
  const document = createSyntheticDocumentIR([
    "Dock:\nA weathered notice hangs by the gate.\n\n- The tide ledger is incomplete.\n\n◈ Key: The rusted key opens the gate.",
  ].map((page) => page.replace("\u923c?", "\u25b6 ")).concat(["Safe Dock:\nA verified source fact is actionable.\n\n\u25b6 Safe Key: A bounded clue exists."]), "source-fact-disposition-contract");
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const draft = compileDeterministicTemplates(graph, { moduleId: "source-fact-disposition-contract" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

describe("source fact disposition question contract", () => {
  it("replaces generic prose discovery with one exact whole-statement disposition question", () => {
    const { graph, queue } = fixture();
    const roots = graph.statements.filter((statement) => statement.kind === "paragraph" || statement.kind === "list_item");
    const questions = queue.questions.filter((question) => question.kind === ("source_fact_disposition" as CompilerQuestion["kind"]));

    expect(questions).toHaveLength(roots.length);
    expect(queue.questions.some((question) => question.kind === "discovery_method" && !question.subjectCandidateId)).toBe(false);
    for (const root of roots) {
      const question = questions.find((candidate) => candidate.subjectStatementId === root.id)!;
      expect(question.sourceStatementIds).toEqual([root.id]);
      expect(parseCompilerHintValue(question, {
        statementId: root.id,
        disposition: "source_only",
      }, graph)).toEqual({ kind: "source_fact_disposition", statementId: root.id, disposition: "source_only" });
      expect(() => parseCompilerHintValue(question, {
        statementId: root.id,
        disposition: "source_only",
        clueCandidateId: "forged",
      }, graph)).toThrow("undeclared");
    }
  });

  it("accepts an audited whole-statement source-only decision, keeps mechanics candidates incomplete, and rejects forged wires", () => {
    const { graph, queue } = fixture();
    const source = queue.questions.find((question) => question.kind === "source_fact_disposition" && question.sourceFactChildQuestionId)!;
    const statement = graph.statements.find((candidate) => candidate.id === source.subjectStatementId)!;
    const proposal = {
      questionId: source.id,
      kind: "source_fact_disposition" as const,
      value: { statementId: statement.id, disposition: "source_only" as const },
      citations: [{ claimKey: `source_fact_disposition:${statement.id}`, statementId: statement.id, quote: statement.text }],
    };
    const batch = {
      schemaVersion: "1.0.0" as const,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      queueHash: queue.queueHash,
      proposalId: "source_fact_disposition_stub",
      proposals: [proposal],
    };

    const request = buildCompilerHintProposalRequestEnvelope(graph, queue);
    expect(request.questions.find((question) => question.questionId === source.id)?.allowedKinds).toEqual(["source_fact_disposition"]);
    const compiled = compileGroundedHintProposals(graph, queue, batch, { policyId: "source-fact-policy", rightsStatus: "user_provided" });
    expect(compiled.accepted).toHaveLength(1);
    expect(compiled.hints.resolutions[0]?.audit?.citations).toEqual(proposal.citations);
    expect(compiled.hints.resolutions[0]?.audit?.schemaVersion).toBe("1.0.0");

    const answeredQueue = applyModuleCompileHints(graph, queue, compiled.hints);
    const sourceOnlyReport = buildResolvedSourceFactDispositionReport(graph, {} as never, answeredQueue, [], {
      proseNpcBindings: [], itemBindings: [], rewardBindings: [],
    });
    const sourceOnlyEntry = sourceOnlyReport.entries.find((entry) => entry.statementId === statement.id)!;
    expect(sourceOnlyEntry).toMatchObject({ status: "explicitly_unbound", reasons: expect.arrayContaining(["explicitly_unbound_source_fact"]) });
    expect(sourceOnlyEntry.interpretationIds).toEqual([]);

    const mechanicsCandidateHints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [{
        questionId: source.id,
        kind: "source_fact_disposition",
        value: { statementId: statement.id, disposition: "mechanics_candidate" },
        sourceStatementIds: [...source.sourceStatementIds], evidenceRefs: [...source.evidenceRefs],
        authority: "user_document" as const, derivation: "explicit" as const, reviewerKind: "human" as const,
        rightsStatus: "user_provided" as const, reason: "needs a separately grounded mechanics contract",
      }],
    };
    const mechanicsQueue = applyModuleCompileHints(graph, queue, mechanicsCandidateHints);
    const mechanicsReport = buildResolvedSourceFactDispositionReport(graph, {} as never, mechanicsQueue, [], {
      proseNpcBindings: [], itemBindings: [], rewardBindings: [],
    });
    expect(mechanicsReport.entries.find((entry) => entry.statementId === statement.id)).toMatchObject({
      status: "draft_candidate_open", reasons: expect.arrayContaining(["source_fact_mechanics_candidate"]), interpretationIds: [],
    });
    expect(mechanicsReport.contentReadiness).toMatchObject({
      status: "incomplete", mechanicsCandidateStatementIds: [statement.id],
    });
    expect(mechanicsReport.contentReadiness.openQuestionIds).not.toContain(source.id);
    const forgedMechanicsCandidateIds = {
      ...mechanicsReport,
      contentReadiness: { ...mechanicsReport.contentReadiness, mechanicsCandidateStatementIds: [] },
    };
    expect(() => validateSourceFactDispositionReport(graph, forgedMechanicsCandidateIds)).toThrow();

    const foreign = graph.statements.find((candidate) => candidate.id !== statement.id)!;
    const invalidProposals = [
      { ...proposal, value: { statementId: foreign.id, disposition: "source_only" } },
      { ...proposal, citations: [{ ...proposal.citations[0], statementId: foreign.id, quote: foreign.text }] },
      { ...proposal, citations: [{ ...proposal.citations[0], quote: statement.text.slice(0, -1) }] },
      { ...proposal, citations: [{ ...proposal.citations[0], claimKey: `source_fact_disposition:${foreign.id}` }] },
      { ...proposal, value: { statementId: statement.id, disposition: "source_only", clueCandidateId: "forged" } },
    ];
    for (const invalid of invalidProposals) {
      const result = compileGroundedHintProposals(graph, queue, { ...batch, proposals: [invalid] }, { policyId: "source-fact-policy", rightsStatus: "user_provided" });
      expect(result.accepted).toEqual([]);
      expect(result.hints.resolutions).toEqual([]);
    }
    expect(() => validateModuleCompileHints(queue, { ...compiled.hints, schemaVersion: "1.9.0" }, graph)).toThrow("legacy hints cannot declare source fact disposition");

    const forgedQueue = structuredClone(queue);
    const forged = forgedQueue.questions.find((question) => question.id === source.id)!;
    forged.sourceStatementIds = [foreign.id];
    forged.evidenceRefs = [foreign.evidenceRefId];
    expect(() => validateCompilerQuestionQueue(graph, forgedQueue)).toThrow("exactly one statement subject");
  });
});
