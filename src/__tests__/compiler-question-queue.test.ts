import { describe, expect, it } from "bun:test";
import {
  MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  buildCompilerQuestionQueue,
  parseCompilerHintValue,
  validateCompilerQuestionQueue,
  validateModuleCompileHints,
  withQueueHash,
  type ModuleCompileHints,
} from "../compiler/compiler-question-queue";
import { prepareCompiler } from "../compiler/compiler-api";
import { applyModuleCompileHints, resolveDraftModule } from "../compiler/compile-hint-resolution";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildResolvedSourceFactDispositionReport, validateSourceFactDispositionReport } from "../compiler/source-fact-disposition";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { importPointsTo, scanImports } from "../diagnostics/source-scan";
import { readFileSync } from "fs";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";

function graphFor(pages: string[]) {
  const document = createSyntheticDocumentIR(pages, "compiler-question-queue-test");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  return buildSourceFactGraph(document, blocks);
}

function fixture() {
  const graph = graphFor(["场景：\n普通段落。\n▶钥匙：桌上有一把钥匙。"]);
  const draft = compileDeterministicTemplates(graph, { moduleId: "question-fixture" });
  return { graph, draft, queue: buildCompilerQuestionQueue(graph, draft) };
}

function validHints(): { queue: ReturnType<typeof fixture>["queue"]; hints: ModuleCompileHints } {
  const { queue } = fixture();
  const question = queue.questions.find((entry) => entry.kind === "core_clue")!;
  return {
    queue,
    hints: {
      schemaVersion: "1.3.0",
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [{
        questionId: question.id,
        kind: question.kind,
        value: { clueCandidateId: question.subjectCandidateId, required: true },
        sourceStatementIds: [...question.sourceStatementIds],
        evidenceRefs: [...question.evidenceRefs],
        authority: "user_document",
        derivation: "explicit",
        reviewerKind: "human",
        rightsStatus: "user_provided",
        reason: "synthetic explicit answer",
      }],
    },
  };
}

describe("CompilerQuestionQueue", () => {
  it("keeps a marked body without a complete exact atom partition draft-only instead of refusing preparation", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "unpartitionable-marked-body",
      sourceDescriptor: "unpartitionable-marked-body",
      pages: ["场景：\n▶破损线索：第一句。未闭合（来源排版损坏"],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);

    const question = prepared.questions.find((candidate) => candidate.kind === "clue_fact_facets");
    expect(question).toBeDefined();
    expect(question?.allowedClueFactAtoms).toEqual([]);
    expect(question?.status).toBe("open");
    expect(question?.severity).toBe("publish_blocking");
    expect(() => parseCompilerHintValue(question!, {
      shell: [], findings: [], sourceOnlyAtomIds: [],
    }, prepared.artifact.payload.graph)).toThrow("clue body has no independently verified source atom domain");

    const partitionable = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "partitionable-marked-body",
      sourceDescriptor: "partitionable-marked-body",
      pages: ["场景：\n▶完整线索：第一句。第二句。"],
    });
    if (partitionable.status === "refused") throw new Error(partitionable.message);
    const forged = structuredClone(partitionable.artifact.payload.preparedQueue);
    const partitionableQuestion = forged.questions.find((candidate) => candidate.kind === "clue_fact_facets");
    if (!partitionableQuestion) throw new Error("partitionable fixture lacks clue facet question");
    expect(partitionableQuestion.allowedClueFactAtoms?.length).toBeGreaterThan(0);
    partitionableQuestion.allowedClueFactAtoms = [];
    expect(() => validateCompilerQuestionQueue(partitionable.artifact.payload.graph, withQueueHash(forged))).toThrow("empty clue fact atom domain must be source-unpartitionable");
  });

  it("creates evidence-bound scene, entry, topology, core, and ending questions without answering them", () => {
    const { graph, draft, queue } = fixture();
    expect(queue.questions.filter((question) => question.kind === "scene_role")).toHaveLength(draft.sceneCandidates.length);
    expect(queue.questions.some((question) => question.kind === "entry_scene" && question.severity === "publish_blocking")).toBe(true);
    expect(queue.questions.some((question) => question.kind === "connection_topology" && question.severity === "publish_blocking")).toBe(true);
    expect(queue.questions.filter((question) => question.kind === "core_clue")).toHaveLength(draft.clueCandidates.length);
    expect(queue.questions.some((question) => question.kind === "ending_rule" && question.severity === "publish_blocking")).toBe(true);
    expect(queue.questions.every((question) => question.status === "open" || question.kind === "source_fact_mechanic" && question.status === "deferred")).toBe(true);
    expect(draft.readiness.questionQueueHash).toBe(queue.queueHash);
    expect(draft.readiness.publishBlockingQuestionIds.length).toBeGreaterThan(0);
    expect(queue.questions.find((question) => question.kind === "entry_scene")?.sourceStatementIds).toEqual(draft.sceneCandidates.map((scene) => scene.headingStatementId).sort());
    expect(queue.questions.filter((question) => question.kind === "connection_topology").every((question) => question.candidateIds?.length === 1)).toBe(true);
    expect(queue.questions.filter((question) => question.kind === "core_clue").every((question) => question.status === "open" && question.severity === "draft_warning")).toBe(true);
    for (const code of draft.readiness.blockingCodes) expect(queue.questions.some((question) => question.blockingCode === code)).toBe(true);
    validateCompilerQuestionQueue(graph, queue);
  });

  it("records unresolved marked items and prose as questions without making them clues", () => {
    const graph = graphFor(["场景：\n普通段落。\n▶：无名正文。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "question-fixture" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    expect(draft.clueCandidates).toEqual([]);
    const proseRoots = graph.statements.filter((statement) => statement.kind === "paragraph" || statement.kind === "list_item");
    const sourceDispositions = queue.questions.filter((question) => question.kind === "source_fact_disposition");
    expect(sourceDispositions).toHaveLength(proseRoots.length);
    expect(sourceDispositions.every((question) => question.sourceStatementIds.length === 1 && question.subjectStatementId === question.sourceStatementIds[0])).toBe(true);
    expect(queue.questions.some((question) => question.kind === "discovery_method"
      && question.sourceStatementIds.some((statementId) => {
        const kind = graph.statements.find((statement) => statement.id === statementId)?.kind;
        return kind === "paragraph" || kind === "list_item";
      }))).toBe(false);
    expect(queue.questions.some((question) => question.kind === "discovery_method" && question.prompt.includes("marked item"))).toBe(true);
  });

  it("isolates a canonical item question from a corrupted clue while default discovery still fails closed", () => {
    const { graph, draft } = fixture();
    const clue = draft.clueCandidates[0]!;
    const item = draft.itemCandidates.find((candidate) => candidate.markedItemStatementId === clue.markedItemStatementId)!;
    const foreignHeading = draft.sceneCandidates.find((scene) => scene.id !== clue.sceneCandidateId) ?? draft.sceneCandidates[0]!;
    clue.nameStatementId = foreignHeading.headingStatementId;

    const queue = buildCompilerQuestionQueue(graph, draft);
    draft.readiness.questionQueueHash = queue.queueHash;
    const itemQuestion = queue.questions.find((question) => question.kind === "item_binding" && question.subjectCandidateId === item.id)!;
    const coreQuestion = queue.questions.find((question) => question.kind === "core_clue" && question.subjectCandidateId === clue.id)!;
    const discoveryQuestion = queue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === clue.id)!;
    expect(itemQuestion.sourceStatementIds).toEqual([item.markedItemStatementId, item.nameStatementId, item.bodyStatementId].sort());
    expect(itemQuestion.sourceStatementIds).not.toContain(foreignHeading.headingStatementId);
    expect(coreQuestion.sourceStatementIds).toContain(foreignHeading.headingStatementId);
    expect(discoveryQuestion.sourceStatementIds).toContain(foreignHeading.headingStatementId);
    expect(itemQuestion.allowedItemNameEvidenceStatementIds).toEqual([item.nameStatementId, item.bodyStatementId]);

    const resolved = resolveDraftModule(graph, draft, queue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [],
    });
    expect(resolved.readiness.status).toBe("draft_only");
    expect(resolved.readiness.blockingCodes).toContain("invalid_default_discovery_binding");
  });

  it("keeps reward review mutually exclusive with source-only table-row disposition", () => {
    const graph = graphFor(["Rewards:\nSAN +1d6\nCM +2\nCR +3\nSAN 50\nHP 10\nAttack 1d6"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "table-root-disposition" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const rowsByText = new Map(graph.statements.filter((statement) => statement.kind === "table_row").map((statement) => [statement.text, statement]));
    const rewardRowIds = new Set(draft.rewardCandidates.map((candidate) => candidate.tableRowStatementId));
    const dispositionQuestions = queue.questions.filter((question) => question.kind === "source_fact_disposition");

    expect(draft.rewardCandidates).toHaveLength(3);
    expect(queue.questions.filter((question) => question.kind === "reward_binding")).toHaveLength(3);
    expect(dispositionQuestions).toHaveLength(3);
    for (const question of queue.questions.filter((question) => question.kind === "reward_binding")) {
      const rowId = question.sourceStatementIds.find((id) => graph.statements.find((statement) => statement.id === id)?.kind === "table_row");
      expect(rowId).toBeDefined();
      expect(rewardRowIds.has(rowId!)).toBe(true);
      expect(dispositionQuestions.some((candidate) => candidate.subjectStatementId === rowId)).toBe(false);
    }
    for (const question of dispositionQuestions) {
      if (!question.subjectStatementId) throw new Error("source disposition lacks its table-row subject");
      expect(question.sourceStatementIds).toEqual([question.subjectStatementId]);
      expect(rewardRowIds.has(question.subjectStatementId)).toBe(false);
    }
    validateCompilerQuestionQueue(graph, queue);
    expect(draft.readiness.questionQueueHash).toBe(queue.queueHash);

    const statRow = rowsByText.get("SAN 50")!;
    const statDisposition = dispositionQuestions.find((question) => question.subjectStatementId === statRow.id)!;
    expect(parseCompilerHintValue(statDisposition, { statementId: statRow.id, disposition: "source_only" }, graph)).toEqual({ kind: "source_fact_disposition", statementId: statRow.id, disposition: "source_only" });
    expect(() => parseCompilerHintValue(statDisposition, { statementId: statRow.id, disposition: "mechanics_candidate" }, graph)).toThrow("not allowed by this prepared parent domain");

    const hints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: dispositionQuestions.map((question) => ({
        questionId: question.id,
        kind: question.kind,
        value: { statementId: question.subjectStatementId, disposition: "source_only" },
        sourceStatementIds: [...question.sourceStatementIds],
        evidenceRefs: [...question.evidenceRefs],
        authority: "user_document",
        derivation: "explicit",
        reviewerKind: "human",
        rightsStatus: "user_provided",
        reason: "explicit source-only table-row review",
      })),
    };
    validateModuleCompileHints(queue, hints, graph);
    for (const schemaVersion of ["2.0.0", "2.1.0"] as const) {
      expect(() => validateModuleCompileHints(queue, { ...hints, schemaVersion }, graph)).not.toThrow();
    }
    expect(() => validateModuleCompileHints(queue, { ...hints, schemaVersion: "1.9.0" }, graph)).toThrow("legacy hints cannot declare source fact disposition");
    const answeredQueue = applyModuleCompileHints(graph, queue, hints);
    const report = buildResolvedSourceFactDispositionReport(graph, draft, answeredQueue, draft.interpretations, {
      proseNpcBindings: [], itemBindings: [], rewardBindings: [],
    });
    validateSourceFactDispositionReport(graph, report);
    expect(report.entries.find((entry) => entry.statementId === statRow.id)?.status).toBe("explicitly_unbound");
    expect(report.contentReadiness.unmodeledStatementIds).not.toContain(statRow.id);

    const unscopedGraph = graphFor(["SAN +1d6\nCM +2\nCR +3\nAfterword:\nThe heading does not scope the rows above."]);
    const unscopedDraft = compileDeterministicTemplates(unscopedGraph, { moduleId: "unscoped-table-root-disposition" });
    const unscopedQueue = buildCompilerQuestionQueue(unscopedGraph, unscopedDraft);
    expect(unscopedDraft.rewardCandidates).toEqual([]);
    expect(unscopedQueue.questions.filter((question) => question.kind === "source_fact_disposition" && unscopedGraph.statements.find((statement) => statement.id === question.subjectStatementId)?.kind === "table_row").map((question) => question.subjectStatementId).sort()).toEqual(
      unscopedGraph.statements.filter((statement) => statement.kind === "table_row").map((statement) => statement.id).sort(),
    );
    validateCompilerQuestionQueue(unscopedGraph, unscopedQueue);
  });

  it("does not default the first heading when multiple scene candidates exist", () => {
    const graph = graphFor(["场景一：\n▶甲：正文。\n场景二：\n▶乙：正文。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "question-fixture" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    expect(queue.questions.find((question) => question.kind === "entry_scene")?.sourceStatementIds).toEqual(draft.sceneCandidates.map((scene) => scene.headingStatementId).sort());
    expect(queue.questions.filter((question) => question.kind === "connection_topology").every((question) => question.candidateIds?.length === 1)).toBe(true);
  });

  it("binds each topology question to its heading and direct heading scope, not the next heading scope", () => {
    const graph = graphFor(["入口场景：\n机关开启后才能前往档案室。\n▶控制台：输入正确密码会打开门。\n档案室场景：\n档案室内有另一把钥匙。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "question-fixture" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const entry = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("入口场景"))!;
    const archive = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("档案室场景"))!;
    if (!entry || !archive) throw new Error(`expected scoped headings, got ${JSON.stringify(draft.sceneCandidates.map((scene) => scene.displayName))}`);
    const entryScopeIds = graph.relations
      .filter((relation) => relation.kind === "heading_scopes" && relation.from === entry.headingStatementId)
      .map((relation) => relation.to);
    const archiveScopeIds = graph.relations
      .filter((relation) => relation.kind === "heading_scopes" && relation.from === archive.headingStatementId)
      .map((relation) => relation.to);
    const question = queue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === entry.id)!;
    const expectedIds = [entry.headingStatementId, ...entryScopeIds].sort();
    const evidenceById = new Map(graph.statements.map((statement) => [statement.id, statement.evidenceRefId]));

    expect(question.sourceStatementIds).toEqual(expectedIds);
    expect(question.evidenceRefs).toEqual(expectedIds.map((id) => evidenceById.get(id)!));
    expect(question.sourceStatementIds).not.toContain(archive.headingStatementId);
    for (const id of archiveScopeIds) expect(question.sourceStatementIds).not.toContain(id);
  });

  it("binds an explicit ending heading to the ending question with its direct scope", () => {
    const graph = graphFor(["入口场景：\n通往结局前需要找到钥匙。\n结局场景：\n若持有钥匙并离开建筑，游戏结束。\n尾声场景：\n这段文字不属于结局条件。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "question-fixture" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const ending = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("结局场景"))!;
    const epilogue = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("尾声场景"))!;
    if (!ending || !epilogue) throw new Error(`expected ending headings, got ${JSON.stringify(draft.sceneCandidates.map((scene) => scene.displayName))}`);
    const endingScopeIds = graph.relations
      .filter((relation) => relation.kind === "heading_scopes" && relation.from === ending.headingStatementId)
      .map((relation) => relation.to);
    const epilogueScopeIds = graph.relations
      .filter((relation) => relation.kind === "heading_scopes" && relation.from === epilogue.headingStatementId)
      .map((relation) => relation.to);
    const question = queue.questions.find((candidate) => candidate.kind === "ending_rule")!;
    const expectedIds = [ending.headingStatementId, ...endingScopeIds].sort();
    const evidenceById = new Map(graph.statements.map((statement) => [statement.id, statement.evidenceRefId]));

    expect(question.sourceStatementIds).toEqual(expectedIds);
    expect(question.evidenceRefs).toEqual(expectedIds.map((id) => evidenceById.get(id)!));
    expect(question.sourceStatementIds).not.toContain(epilogue.headingStatementId);
    for (const id of epilogueScopeIds) expect(question.sourceStatementIds).not.toContain(id);
  });

  it("uses every source statement for an ending fallback without creating an ending", () => {
    const graph = graphFor(["入口场景：\n找到钥匙后才能离开建筑。\n出口场景：\n离开建筑时应检查是否持有钥匙。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "question-fixture" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const question = queue.questions.find((candidate) => candidate.kind === "ending_rule")!;
    const expectedIds = graph.statements.map((statement) => statement.id).sort();
    const evidenceById = new Map(graph.statements.map((statement) => [statement.id, statement.evidenceRefId]));

    expect(question.sourceStatementIds).toEqual(expectedIds);
    expect(question.evidenceRefs).toEqual(expectedIds.map((id) => evidenceById.get(id)!));
    expect(question.status).toBe("open");
    expect(question.resolution).toBeUndefined();
    expect(draft.mechanicsIR?.endings ?? []).toEqual([]);
  });

  it("preserves exact statement evidence and creates distinct IDs for distinct evidence", () => {
    const graph = graphFor(["场景：\n▶钥匙：正文。\n▶钥匙：正文。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "question-fixture" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const core = queue.questions.filter((question) => question.kind === "core_clue");
    expect(core).toHaveLength(2);
    expect(core[0]?.id).not.toBe(core[1]?.id);
    const statements = new Map(graph.statements.map((statement) => [statement.id, statement]));
    for (const question of queue.questions) for (const sourceId of question.sourceStatementIds) {
      const statement = statements.get(sourceId);
      if (!statement) throw new Error(`missing question source: ${sourceId}`);
      expect(question.evidenceRefs).toContain(statement.evidenceRefId);
    }
  });

  it("keeps same-heading prose NPC anchors separately answerable by their exact paragraph", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "same-heading-prose-npcs",
      sourceDescriptor: "same-heading-prose-npcs",
      pages: ["Dock:\nCaptain Mira watches the launch.\n\nProfessor Hale studies the tide chart.\n\nExit:\nThe road ends at the seawall."],
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status === "refused") throw new Error(prepared.message);

    const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
    const anchors = draft.proseNpcAnchors
      .filter((anchor) => draft.sceneCandidates.find((scene) => scene.id === anchor.sceneCandidateId)?.displayName.startsWith("Dock"))
      .sort((left, right) => left.paragraphStatementId.localeCompare(right.paragraphStatementId));
    expect(anchors).toHaveLength(2);
    const questions = anchors.map((anchor) => queue.questions.find((question) => question.kind === "npc_binding" && question.subjectCandidateId === anchor.id)!);
    expect(questions).toHaveLength(2);
    expect(questions[0]!.id).not.toBe(questions[1]!.id);
    expect(questions[0]!.subjectStatementId).toBe(anchors[0]!.paragraphStatementId);
    expect(questions[1]!.subjectStatementId).toBe(anchors[1]!.paragraphStatementId);
    expect(parseCompilerHintValue(questions[1]!, {
      proseAnchorId: anchors[1]!.id,
      presentNpcs: [{ nameQuote: "Hale", dialogueMethods: [] }],
    }, graph)).toMatchObject({ kind: "npc_binding", proseAnchorId: anchors[1]!.id, presentNpcs: [{ nameQuote: "Hale" }] });
    expect(() => parseCompilerHintValue(questions[0]!, {
      proseAnchorId: anchors[0]!.id,
      presentNpcs: [{ nameQuote: "Hale", dialogueMethods: [] }],
    }, graph)).toThrow("nameQuote");

    const duplicate = structuredClone(queue);
    duplicate.questions.push({ ...structuredClone(questions[0]!), id: "question_forged_same_subject" });
    expect(() => validateCompilerQuestionQueue(graph, withQueueHash(duplicate))).toThrow("duplicate question");

    const exitAnchor = draft.proseNpcAnchors.find((anchor) => anchor.sceneCandidateId !== anchors[0]!.sceneCandidateId)!;
    const wrongHeading = structuredClone(queue);
    const wrongHeadingQuestion = wrongHeading.questions.find((question) => question.id === questions[0]!.id)!;
    wrongHeadingQuestion.subjectCandidateId = exitAnchor.id;
    wrongHeadingQuestion.subjectStatementId = exitAnchor.paragraphStatementId;
    wrongHeadingQuestion.candidateIds = [exitAnchor.id];
    wrongHeadingQuestion.allowedCandidateIds = [exitAnchor.id];
    wrongHeadingQuestion.sourceStatementIds = [...new Set([...wrongHeadingQuestion.sourceStatementIds, exitAnchor.paragraphStatementId])].sort();
    wrongHeadingQuestion.evidenceRefs = wrongHeadingQuestion.sourceStatementIds
      .map((statementId) => graph.statements.find((statement) => statement.id === statementId)!.evidenceRefId)
      .sort();
    expect(() => validateCompilerQuestionQueue(graph, withQueueHash(wrongHeading))).toThrow("not under its source heading");
  });

  it("keeps question IDs stable when an unrelated block is added to the same document", () => {
    const document = createSyntheticDocumentIR(["场景：\n▶无关：正文。\n▶钥匙：正文。"], "compiler-question-queue-test");
    const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
    const firstGraph = buildSourceFactGraph(document, blocks.filter((block) => block.kind !== "marked_item" || block.text.startsWith("钥匙")));
    const fullGraph = buildSourceFactGraph(document, blocks);
    const firstDraft = compileDeterministicTemplates(firstGraph, { moduleId: "question-fixture" });
    const fullDraft = compileDeterministicTemplates(fullGraph, { moduleId: "question-fixture" });
    const first = buildCompilerQuestionQueue(firstGraph, firstDraft).questions.find((question) => question.kind === "core_clue")!;
    const full = buildCompilerQuestionQueue(fullGraph, fullDraft).questions.find((question) => question.kind === "core_clue" && question.candidateIds?.includes(fullDraft.clueCandidates.find((clue) => clue.displayName === "钥匙")!.id))!;
    expect(full.id).toBe(first.id);
  });

  it("fails closed for duplicate questions, dangling evidence, and invalid hints", () => {
    const { graph, queue } = fixture();
    const duplicate = structuredClone(queue);
    duplicate.questions.push(structuredClone(duplicate.questions[0]!));
    expect(() => validateCompilerQuestionQueue(graph, duplicate)).toThrow("duplicate question");
    const danglingEvidence = structuredClone(queue);
    danglingEvidence.questions[0]!.evidenceRefs = [];
    expect(() => validateCompilerQuestionQueue(graph, danglingEvidence)).toThrow("evidence");
    const { hints } = validHints();
    expect(() => validateModuleCompileHints(queue, hints)).not.toThrow();
    const wrongEvidence = structuredClone(hints);
    wrongEvidence.resolutions[0]!.evidenceRefs = [queue.questions.find((entry) => entry.kind === "entry_scene")!.evidenceRefs[0]!];
    expect(() => validateModuleCompileHints(queue, wrongEvidence)).toThrow("evidence");
    const wrongHash = structuredClone(hints);
    wrongHash.sourceGraphIdentity = "wrong";
    expect(() => validateModuleCompileHints(queue, wrongHash)).toThrow("identity");
    const unknownReference = structuredClone(hints);
    unknownReference.resolutions[0]!.value = { clueCandidateId: "invented", required: true };
    expect(() => validateModuleCompileHints(queue, unknownReference)).toThrow("unknown reference");
  });

  it("rejects conflicting resolutions and never defaults an open question", () => {
    const { queue, hints } = validHints();
    const conflict = structuredClone(hints);
    conflict.resolutions.push({ ...conflict.resolutions[0]!, value: false });
    expect(() => validateModuleCompileHints(queue, conflict)).toThrow("multiple resolutions");
    const defaulted = structuredClone(hints);
    defaulted.resolutions[0]!.derivation = "default" as never;
    expect(() => validateModuleCompileHints(queue, defaulted)).toThrow("cannot be defaulted");
  });

  it("validates answered status, stored resolution, and the recomputed queue hash together", () => {
    const { queue, hints } = validHints();
    const { graph } = fixture();
    const missingResolution = structuredClone(queue);
    missingResolution.questions[0]!.status = "answered";
    expect(() => validateCompilerQuestionQueue(graph, missingResolution)).toThrow("lacks resolution");
    const staleResolution = structuredClone(queue);
    staleResolution.questions[0]!.resolution = structuredClone(hints.resolutions[0]!);
    expect(() => validateCompilerQuestionQueue(graph, staleResolution)).toThrow("non-answered");
    const answered = structuredClone(queue);
    const target = answered.questions.find((question) => question.id === hints.resolutions[0]!.questionId)!;
    target.status = "answered";
    target.resolution = structuredClone(hints.resolutions[0]!);
    // The answer is otherwise valid, so a stale hash is the only rejected part.
    expect(() => validateCompilerQuestionQueue(graph, answered)).toThrow("queueHash");
  });

  it("does not import world-model, runtime, dataset, or ModuleData loaders", () => {
    const imports = scanImports(readFileSync("src/compiler/compiler-question-queue.ts", "utf8"));
    for (const forbidden of ["world-model-loader", "cthulhu-dataset", "game-session", "module-data-runtime-loader", "mythos-module"]) {
      expect(imports.some((entry) => importPointsTo(entry.path, forbidden))).toBe(false);
    }
  });
});
