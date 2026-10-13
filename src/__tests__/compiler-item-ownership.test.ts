import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, buildCompilerQuestionQueue, parseCompilerHintValue, validateModuleCompileHints, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { buildTrustedPresentationReviewSlotPage, projectResolvedCompilerArtifact, type CompilerModuleDataProjection, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { compilerArtifactIdentity, restoreCompilerArtifact, sealCompilerArtifact, type ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { resolveDraftModule } from "../compiler/compile-hint-resolution";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { requestCompilerHintProposals } from "../api/compiler-hint-proposal-adapter";
import { compiledMechanicsAction, GameSession } from "../api/game-session";
import type { LLMLike } from "../llm/client";
import { allShellClueFactFacetResolutions, clueFactFacetRevelations } from "./helpers/clue-fact-facet-hints";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const PAGES = [
  {
    pageNo: 1,
    text: "Study:\n▶Copper Key: An engraved key with a moon mark.",
  },
];

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

function answer(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
  return {
    questionId: question.id,
    kind: question.kind,
    value,
    sourceStatementIds: [...question.sourceStatementIds],
    evidenceRefs: [...question.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "source-bound item ownership fixture",
  };
}

function itemHints(prepared: PreparedCompilerApiResult, includeBinding = true): ModuleCompileHints {
  const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
  const scene = draft.sceneCandidates[0]!;
  const clue = draft.clueCandidates[0]!;
  const item = draft.itemCandidates[0]!;
  const byKind = (kind: CompilerQuestion["kind"]) => queue.questions.filter((question) => question.kind === kind);
  const entry = byKind("entry_scene")[0]!;
  const ending = byKind("ending_rule")[0]!;
  const discovery = byKind("discovery_method").find((question) => question.subjectCandidateId === clue.id)!;
  const resolutions = [
    ...allShellClueFactFacetResolutions(queue.questions, answer),
    ...byKind("scene_role").map((question) => answer(question, { role: "playable_scene" })),
    answer(entry, { sceneCandidateId: scene.id }),
    ...byKind("connection_topology").map((question) => answer(question, { connections: [] })),
    ...byKind("core_clue").map((question) => answer(question, { clueCandidateId: question.subjectCandidateId, required: false })),
    ...(includeBinding ? [answer(byKind("item_binding")[0]!, {
      itemCandidateId: item.id,
      itemType: "key",
      itemNameEvidence: {
        statementId: item.nameStatementId,
        quote: graph.statements.find((statement) => statement.id === item.nameStatementId)!.text,
      },
    })] : []),
    answer(discovery, {
      clueCandidateId: clue.id,
      locationSceneCandidateId: scene.id,
      spec: {
        kind: "discovery_method",
        id: "take_copper_key",
        clueId: clue.id,
        action: "search",
        target: "item",
        targetId: item.id,
        onSuccess: [{ kind: "discover_clue", clueId: clue.id }, { kind: "acquire_item", itemId: item.id }],
      },
    }),
    answer(ending, {
      declarations: [{
        endingId: "item_exit",
        spec: {
          kind: "ending_rule",
          id: "item_exit_rule",
          priority: 1,
          when: { kind: "item_owned", itemId: item.id },
          effects: [{ kind: "end_game", endingId: "item_exit" }],
        },
      }],
    }),
  ];
  return { schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION, moduleId: queue.moduleId, documentHash: queue.documentHash, sourceGraphIdentity: queue.sourceGraphIdentity, resolutions };
}

/** A reviewed marked item can deliberately remain source-only without a runtime identity. */
function sourceOnlyItemHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const hints = structuredClone(itemHints(prepared, false));
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const scene = draft.sceneCandidates[0]!;
  const clue = draft.clueCandidates[0]!;
  const item = draft.itemCandidates[0]!;
  const itemQuestion = queue.questions.find((question) => question.kind === "item_binding" && question.subjectCandidateId === item.id)!;
  const discovery = hints.resolutions.find((resolution) => resolution.kind === "discovery_method")!;
  const discoveryValue = discovery.value as { locationSceneCandidateId: string; spec: { target: string; targetId: string; onSuccess: unknown[] } };
  discoveryValue.locationSceneCandidateId = scene.id;
  discoveryValue.spec.target = "scene";
  discoveryValue.spec.targetId = scene.id;
  discoveryValue.spec.onSuccess = [{ kind: "discover_clue", clueId: clue.id }];
  const ending = hints.resolutions.find((resolution) => resolution.kind === "ending_rule")!;
  (ending.value as { declarations: Array<{ spec: { when: unknown } }> }).declarations[0]!.spec.when = { kind: "clue_found", clueId: clue.id };
  hints.schemaVersion = MODULE_COMPILE_HINTS_SCHEMA_VERSION;
  hints.resolutions.push(answer(itemQuestion, { itemCandidateId: item.id, itemType: null }));
  return hints;
}

function presentation(prepared: PreparedCompilerApiResult, payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const scene = prepared.artifact.payload.draft.sceneCandidates[0]!;
  const clue = prepared.artifact.payload.draft.clueCandidates[0]!;
  const facetRevelations = clueFactFacetRevelations(payload.clueFactFacetBindings);
  return {
    module: { title: "Bound item", version: "1", ruleset: "cosmic-horror", era: "modern", summary: "A bound item test.", playerCount: "1", expectedDuration: "short", triggerWarnings: ["none"] },
    scenes: { [scene.id]: { description: "A source-bound study." } },
    connections: {},
    clues: { [clue.id]: { findMethods: [{ type: "observation", description: "Search the study." }], revelation: facetRevelations.get(clue.id) ?? "A clue was found.", unlocks: [], importance: "bonus" } },
    endings: { item_exit: { name: "Key secured", description: "The key opens a way forward.", conditions: ["Own the key"] } },
  };
}

describe("compiler item ownership", () => {
  it("derives a source-bound item candidate before asking for item bindings", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "item-ownership-fixture",
      sourceDescriptor: "item-ownership-source",
      pages: PAGES.map((page) => page.text),
    });

    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    expect(prepared.artifact.payload.draft.itemCandidates).toHaveLength(1);
    const item = prepared.artifact.payload.draft.itemCandidates[0]!;
    const clue = prepared.artifact.payload.draft.clueCandidates[0]!;
    expect(item.id).not.toBe(clue.id);
    const itemQuestion = prepared.questions.find((question) => question.kind === "item_binding")!;
    const discoveryQuestion = prepared.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === clue.id)!;
    expect(itemQuestion.subjectCandidateId).toBe(item.id);
    expect(discoveryQuestion.allowedMechanicsTargetIds?.item).toEqual([item.id]);
    const itemName = prepared.artifact.payload.graph.statements.find((statement) => statement.id === item.nameStatementId)!;
    expect(parseCompilerHintValue(itemQuestion, {
      itemCandidateId: item.id,
      itemType: "key",
      itemNameEvidence: { statementId: itemName.id, quote: itemName.text },
    }, prepared.artifact.payload.graph)).toEqual({
      kind: "item_binding",
      itemCandidateId: item.id,
      itemType: "key",
      itemNameEvidence: { statementId: itemName.id, quote: itemName.text },
    });
    expect(parseCompilerHintValue(itemQuestion, { itemCandidateId: item.id, itemType: null })).toEqual({ kind: "item_binding", itemCandidateId: item.id, itemType: null });
    expect(() => parseCompilerHintValue(itemQuestion, { itemCandidateId: clue.id, itemType: "key" }, prepared.artifact.payload.graph)).toThrow("unallowed");
    expect(() => parseCompilerHintValue(itemQuestion, { itemCandidateId: item.id, itemType: "weapon" })).toThrow("null for source-only evidence");
    expect(() => parseCompilerHintValue(itemQuestion, { itemCandidateId: item.id, itemType: "trap" })).toThrow("null for source-only evidence");
    expect(() => parseCompilerHintValue(itemQuestion, { itemCandidateId: item.id })).toThrow("null for source-only evidence");
    expect(() => parseCompilerHintValue(itemQuestion, { itemCandidateId: item.id, itemType: null, inventedId: "no" })).toThrow("undeclared");
    expect(() => parseCompilerHintValue(itemQuestion, null)).toThrow("invalid item_binding");
    expect(() => parseCompilerHintValue(itemQuestion, { itemCandidateId: item.id, itemType: "key", itemNameEvidence: { statementId: itemName.id, quote: itemName.text }, inventedId: "no" }, prepared.artifact.payload.graph)).toThrow("undeclared");
    expect(() => parseCompilerHintValue(discoveryQuestion, { clueCandidateId: item.id, locationSceneCandidateId: item.sceneCandidateId, spec: {} })).toThrow("unallowed");
  });

  it("requires a positive item binding to carry candidate-local source-exact name evidence", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "item-name-evidence-fixture",
      sourceDescriptor: "item-name-evidence-source",
      pages: PAGES.map((page) => page.text),
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const { graph, draft, preparedQueue } = prepared.artifact.payload;
    const item = draft.itemCandidates[0]!;
    const question = preparedQueue.questions.find((candidate) => candidate.kind === "item_binding" && candidate.subjectCandidateId === item.id)!;
    const name = graph.statements.find((statement) => statement.id === item.nameStatementId)!;
    const body = graph.statements.find((statement) => statement.id === item.bodyStatementId)!;
    const foreign = graph.statements.find((statement) => statement.id !== item.nameStatementId && statement.id !== item.bodyStatementId)!;

    expect(question.allowedItemNameEvidenceStatementIds).toEqual([item.nameStatementId, item.bodyStatementId]);
    const value = {
      itemCandidateId: item.id,
      itemType: "key" as const,
      itemNameEvidence: { statementId: name.id, quote: name.text },
    };
    expect(parseCompilerHintValue(question, value, graph)).toEqual({ kind: "item_binding", ...value });
    expect(() => parseCompilerHintValue(question, { itemCandidateId: item.id, itemType: "key" }, graph)).toThrow("itemNameEvidence");
    expect(() => parseCompilerHintValue(question, { itemCandidateId: item.id, itemType: null, itemNameEvidence: value.itemNameEvidence }, graph)).toThrow("itemNameEvidence");
    expect(() => parseCompilerHintValue(question, { ...value, itemNameEvidence: { statementId: foreign.id, quote: foreign.text } }, graph)).toThrow("item name evidence");
    expect(() => parseCompilerHintValue(question, { ...value, itemNameEvidence: { statementId: body.id, quote: "invented item" } }, graph)).toThrow("source-exact");
    expect(() => parseCompilerHintValue(question, { ...value, itemNameEvidence: { statementId: body.id, quote: "" } }, graph)).toThrow("source-exact");
  });

  it("reads historical item-binding capabilities by their introduced schema version", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "item-binding-schema-capability-fixture",
      sourceDescriptor: "item-binding-schema-capability-source",
      pages: PAGES.map((page) => page.text),
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const { graph, preparedQueue: queue } = prepared.artifact.payload;
    const positive = itemHints(prepared);
    // Historical schema fixtures predate the publish-blocking facet question;
    // exercise item capability gates without smuggling a 3.2-only answer.
    const legacyPositive = { ...positive, resolutions: positive.resolutions.filter((resolution) => resolution.kind !== "clue_fact_facets") };
    for (const schemaVersion of ["2.1.0", "2.2.0"] as const) {
      expect(() => validateModuleCompileHints(queue, { ...legacyPositive, schemaVersion }, graph)).not.toThrow();
    }
    for (const schemaVersion of ["1.9.0", "2.0.0"] as const) {
      expect(() => validateModuleCompileHints(queue, { ...legacyPositive, schemaVersion }, graph)).toThrow("positive item bindings");
    }

    const sourceOnly = sourceOnlyItemHints(prepared);
    const legacySourceOnly = { ...sourceOnly, resolutions: sourceOnly.resolutions.filter((resolution) => resolution.kind !== "clue_fact_facets") };
    for (const schemaVersion of ["1.9.0", "2.0.0", "2.1.0", "2.2.0"] as const) {
      expect(() => validateModuleCompileHints(queue, { ...legacySourceOnly, schemaVersion }, graph)).not.toThrow();
    }
    expect(() => validateModuleCompileHints(queue, { ...legacySourceOnly, schemaVersion: "1.8.0" }, graph)).toThrow("explicit source-only item bindings");
  });

  it("fails closed when an item acquisition is placed outside the item's bound scene", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "item-ownership-two-scenes",
      sourceDescriptor: "item-ownership-source",
      pages: [...PAGES.map((page) => page.text), "Hallway:\nAn empty corridor leads away from the study."],
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const item = prepared.artifact.payload.draft.itemCandidates[0]!;
    const otherScene = prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.id !== item.sceneCandidateId);
    expect(otherScene).toBeDefined();
    const hints = structuredClone(itemHints(prepared));
    const discovery = hints.resolutions.find((resolution) => resolution.kind === "discovery_method")!;
    (discovery.value as { locationSceneCandidateId: string }).locationSceneCandidateId = otherScene!.id;
    expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints).status).toBe("refused");
  });

  it("keeps an explicitly source-only item answered without a runtime item, projection entry, or presentation-workbench slot", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-only-item-fixture", sourceDescriptor: "source-only-item-source", pages: PAGES.map((page) => page.text) });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
    const item = draft.itemCandidates[0]!;
    const itemQuestion = queue.questions.find((question) => question.kind === "item_binding" && question.subjectCandidateId === item.id)!;
    const name = graph.statements.find((statement) => statement.kind === "marked_item_name" && itemQuestion.sourceStatementIds.includes(statement.id))!;
    const llm: LLMLike = {
      async chat() {
        return JSON.stringify({ proposals: [{
          questionId: itemQuestion.id,
          kind: "item_binding",
          value: { itemCandidateId: item.id, itemType: null },
          citations: [{ claimKey: `item_binding:none:${item.id}`, statementId: name.id, quote: name.text }],
        }] });
      },
    };
    const proposed = await requestCompilerHintProposals({
      graph,
      queue,
      llm,
      policy: { policyId: "source-only-adapter-policy", rightsStatus: "user_provided" },
      producer: { providerFingerprint: "provider:source-only-stub", modelFingerprint: "model:source-only-stub" },
      limits: { maxQuestionsPerRequest: 8, maxRequestsPerRound: 1 },
    });
    expect(proposed).toMatchObject({ status: "partial", callCount: 1, rejected: [] });
    expect(proposed.hints.schemaVersion).toBe(MODULE_COMPILE_HINTS_SCHEMA_VERSION);
    expect(proposed.hints.resolutions).toMatchObject([{
      questionId: itemQuestion.id,
      value: { itemCandidateId: item.id, itemType: null },
      audit: { citations: [{ claimKey: `item_binding:none:${item.id}`, statementId: name.id, quote: name.text }] },
    }]);

    const hints = sourceOnlyItemHints(prepared);
    const sourceOnlyResolutionIndex = hints.resolutions.findIndex((resolution) => resolution.questionId === itemQuestion.id);
    expect(sourceOnlyResolutionIndex).toBeGreaterThanOrEqual(0);
    hints.resolutions[sourceOnlyResolutionIndex] = proposed.hints.resolutions[0]!;
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const resolvedItemQuestion = payload.resolvedQueue.questions.find((question) => question.kind === "item_binding" && question.subjectCandidateId === item.id)!;
    expect(resolvedItemQuestion).toMatchObject({ status: "answered", resolution: { value: { itemCandidateId: item.id, itemType: null } } });
    expect(payload.resolvedQueue.queueHash).not.toBe(prepared.identity.preparedQueueHash);
    expect(payload.itemBindings).toEqual([]);
    expect(payload.mechanicsIR.symbols.itemIds).toEqual([]);

    const projection = projectResolvedCompilerArtifact(payload, presentation(prepared, payload));
    expect(projection.status).toBe("projected");
    if (projection.status !== "projected") throw new Error(projection.message);
    expect(projection.module.items).toEqual([]);
    expect(projection.sourceMap.items).toEqual({});
    const workbench = buildTrustedPresentationReviewSlotPage(payload, 0);
    expect(workbench.status).toBe("slot_paged");
    if (workbench.status !== "slot_paged") throw new Error(workbench.message);
    expect(workbench.page.slots.some((slot) => slot.fieldPath.startsWith(`items.${item.id}.`))).toBe(false);

    const legacy = { ...hints, schemaVersion: "1.8.0" as const };
    expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, legacy)).toMatchObject({ status: "refused", causeCode: "RESOLVED_HINTS_INVALID" });
    const legacyArtifact = structuredClone(resolved.artifact) as any;
    legacyArtifact.payload.hints.schemaVersion = "1.8.0";
    delete legacyArtifact.artifactHash;
    expect(restoreCompilerArtifact(sealCompilerArtifact(legacyArtifact))).toMatchObject({ status: "refused", stage: "resolved", code: "RESOLVED_HINTS_INVALID" });
    const legacyComponentArtifact = structuredClone(resolved.artifact) as any;
    legacyComponentArtifact.componentVersions.hints = "1.8.0";
    delete legacyComponentArtifact.artifactHash;
    expect(restoreCompilerArtifact(sealCompilerArtifact(legacyComponentArtifact))).toMatchObject({ status: "refused", stage: "parse", code: "ARTIFACT_COMPONENT_VERSION_MISMATCH" });
  });

  it("projects the reviewed body evidence quote rather than recovering a structural item heading", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "item-body-display-fixture", sourceDescriptor: "item-body-display-source", pages: PAGES.map((page) => page.text) });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const item = prepared.artifact.payload.draft.itemCandidates[0]!;
    const body = prepared.artifact.payload.graph.statements.find((statement) => statement.id === item.bodyStatementId)!;
    const hints = itemHints(prepared);
    const binding = hints.resolutions.find((resolution) => resolution.kind === "item_binding")!;
    binding.value = {
      itemCandidateId: item.id,
      itemType: "loot",
      itemNameEvidence: { statementId: body.id, quote: "engraved" },
    };
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    if (resolved.status !== "resolved") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const projection = projectResolvedCompilerArtifact(payload, presentation(prepared, payload));
    if (projection.status !== "projected") throw new Error(projection.message);
    const resolvedItem = payload.itemBindings[0]!;
    expect(projection.module.items).toEqual([expect.objectContaining({ id: resolvedItem.itemId, name: "engraved", type: "loot" })]);
    expect(projection.sourceMap.items[resolvedItem.itemId]?.fields.name).toMatchObject({
      kind: "resolved_question",
      quotes: [{ statementId: body.id, quote: "engraved" }],
    });
  });

  it("keeps real clue questions and fail-closes missing canonical item candidates through the public artifact boundary", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "item-candidate-integrity", sourceDescriptor: "item-ownership-source", pages: PAGES.map((page) => page.text) });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const graph = prepared.artifact.payload.graph;
    const draft = structuredClone(prepared.artifact.payload.draft);
    const clue = draft.clueCandidates[0]!;
    const nonItemHints = (): ModuleCompileHints => {
      const hints = itemHints(prepared, false);
      const discovery = hints.resolutions.find((resolution) => resolution.kind === "discovery_method")!;
      const discoveryValue = discovery.value as { spec: { target: string; targetId: string; onSuccess: unknown[] } };
      discoveryValue.spec.target = "clue";
      discoveryValue.spec.targetId = clue.id;
      discoveryValue.spec.onSuccess = [{ kind: "discover_clue", clueId: clue.id }];
      const ending = hints.resolutions.find((resolution) => resolution.kind === "ending_rule")!;
      (ending.value as { declarations: Array<{ spec: { when: unknown } }> }).declarations[0]!.spec.when = { kind: "clue_found", clueId: clue.id };
      return hints;
    };
    draft.itemCandidates = [];
    const rebuilt = buildCompilerQuestionQueue(graph, draft);
    expect(rebuilt.questions.filter((question) => question.kind === "core_clue" && question.subjectCandidateId === clue.id)).toHaveLength(1);
    expect(rebuilt.questions.filter((question) => question.kind === "discovery_method" && question.subjectCandidateId === clue.id)).toHaveLength(1);
    expect(rebuilt.questions.some((question) => question.kind === "item_binding")).toBe(false);
    draft.readiness.questionQueueHash = rebuilt.queueHash;
    const direct = resolveDraftModule(graph, draft, rebuilt, nonItemHints());
    expect(direct.readiness.status).toBe("draft_only");
    expect(direct.readiness.blockingCodes).toContain("invalid_draft_item_candidates");

    const evidenceDraft = structuredClone(prepared.artifact.payload.draft);
    evidenceDraft.itemCandidates[0]!.evidence.spans[0]!.rawStart += 1;
    const evidenceQueue = buildCompilerQuestionQueue(graph, evidenceDraft);
    evidenceDraft.readiness.questionQueueHash = evidenceQueue.queueHash;
    expect(evidenceQueue.questions.filter((question) => question.kind === "core_clue" && question.subjectCandidateId === clue.id)).toHaveLength(1);
    expect(evidenceQueue.questions.filter((question) => question.kind === "discovery_method" && question.subjectCandidateId === clue.id)).toHaveLength(1);
    expect(evidenceQueue.questions.some((question) => question.kind === "item_binding")).toBe(false);
    const evidenceDirect = resolveDraftModule(graph, evidenceDraft, evidenceQueue, nonItemHints());
    expect(evidenceDirect.readiness.status).toBe("draft_only");
    expect(evidenceDirect.readiness.blockingCodes).toContain("invalid_draft_item_candidates");

    const tamperedArtifact = structuredClone(prepared.artifact);
    tamperedArtifact.payload.draft.itemCandidates = [];
    tamperedArtifact.artifactHash = compilerArtifactIdentity(tamperedArtifact);
    const refused = resolveCompiler(tamperedArtifact, prepared.identity.preparedQueueHash, itemHints(prepared));
    expect(refused).toMatchObject({ status: "refused", code: "RESOLVE_ARTIFACT_INVALID", artifactCode: "PREPARED_DRAFT_MISMATCH" });
  });

  it("carries a bound item from source evidence through ownership, durable replay, and an item_owned ending", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "item-ownership-fixture", sourceDescriptor: "item-ownership-source", pages: PAGES.map((page) => page.text) });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const unresolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, itemHints(prepared, false));
    expect(unresolved.status).toBe("refused");
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, itemHints(prepared));
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    expect(payload.itemBindings).toHaveLength(1);
    const projection = projectResolvedCompilerArtifact(payload, presentation(prepared, payload));
    expect(projection.status).toBe("projected");
    if (projection.status !== "projected") throw new Error(projection.message);
    const item = payload.itemBindings[0]!;
    expect(projection.module.items).toEqual([{ id: item.itemId, name: "CopperKey", sceneId: item.sceneCandidateId, description: "Anengravedkeywithamoonmark.", type: "key" }]);
    expect(projection.sourceMap.items[item.itemId]?.fields.name.kind).toBe("resolved_question");
    expect(projection.sourceMap.items[item.itemId]?.fields.type.kind).toBe("resolved_question");
    const itemNameStatement = payload.graph.statements.find((statement) => statement.id === item.nameStatementId)!;
    expect(projection.sourceMap.items[item.itemId]?.fields.type).toEqual(expect.objectContaining({
      quotes: [{ statementId: item.nameStatementId, quote: itemNameStatement.text }],
    }));

    const evidenceTamperedPayload = structuredClone(payload);
    evidenceTamperedPayload.draft.itemCandidates[0]!.evidence.spans[0]!.rawStart += 1;
    expect(projectResolvedCompilerArtifact(evidenceTamperedPayload, presentation(prepared, evidenceTamperedPayload)).status).toBe("refused");
    const nameEvidenceTamperedPayload = structuredClone(payload);
    nameEvidenceTamperedPayload.itemBindings[0]!.itemNameQuote = "Forged Key";
    expect(projectResolvedCompilerArtifact(nameEvidenceTamperedPayload, presentation(prepared, nameEvidenceTamperedPayload)).status).toBe("refused");
    const nameEvidenceTamperedArtifact = structuredClone(resolved.artifact) as any;
    nameEvidenceTamperedArtifact.payload.itemBindings[0].itemNameStatementId = item.bodyStatementId;
    delete nameEvidenceTamperedArtifact.artifactHash;
    expect(restoreCompilerArtifact(sealCompilerArtifact(nameEvidenceTamperedArtifact))).toMatchObject({ status: "refused", stage: "resolved" });

    const root = mkdtempSync(join(tmpdir(), "compiler-item-ownership-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = catalog.saveBundle(resolved.artifact, projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      // Isolated GameSession replay fixture; server/HTTP tests retain the
      // default coordinator-required snapshot publication boundary.
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
      const host = createCompiledDurableTestHost();
      const session = new GameSession("item-ownership", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", host.runtimeDependencies);
      expect(session.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
      const candidateTamperSession = new GameSession("item-candidate-evidence-tamper", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(root, "candidate-tamper-careers") });
      const candidateTamperWorldBefore = candidateTamperSession.world.exportSnapshot();
      expect(candidateTamperSession.loadCompiledModule(evidenceTamperedPayload, projection).status).toBe("refused");
      expect(candidateTamperSession.world.exportSnapshot()).toEqual(candidateTamperWorldBefore);
      const initial = host.snapshot(session);
      expect(snapshots.save(initial).status).toBe("ok");
      host.acknowledge(session, initial);
      expect(session.getState().inventory).toEqual([]);
      expect(session.getState().sceneItems).toEqual(["CopperKey"]);
      expect(session.getCompiledAvailableActions()).toEqual(expect.arrayContaining([expect.objectContaining({ mechanismId: "take_copper_key", label: "Take CopperKey" })]));

      const committed = host.commit(session, compiledMechanicsAction("take_copper_key"), "take-key", 0, (snapshot) => {
        const result = snapshots.save(snapshot);
        if (result.status !== "ok") throw new Error(result.message);
      });
      expect(committed.status).toBe("committed");
      if (committed.status !== "committed") throw new Error("item action did not commit");
      expect((committed.response.action.state as any).inventory).toEqual(["CopperKey"]);
      expect((committed.response.action.state as any).sceneItems).toEqual([]);
      expect((committed.response.action.compiled as any).state.ownedItemIds).toEqual([item.itemId]);
      expect((committed.response.action.compiled as any).terminalEnding?.id).toBe("item_exit");

      const restoredHost = createCompiledDurableTestHost();
      const restored = new GameSession("item-ownership", "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", restoredHost.runtimeDependencies);
      expect(restored.restoreCompiledSession(committed.snapshot!, bundle.value).status).toBe("loaded");
      expect(restored.getState().inventory).toEqual(["CopperKey"]);
      expect(restored.getState().sceneItems).toEqual([]);
      expect(restored.getCompiledMechanicsState()?.state.ownedItemIds).toEqual([item.itemId]);
      expect(restoredHost.commit(restored, compiledMechanicsAction("take_copper_key"), "take-key", 0, () => {}).status).toBe("duplicate");

      const expectProjectionTamperRejectedBeforeWrite = (label: string, mutate: (candidate: CompilerModuleDataProjection) => void): void => {
        const tampered = structuredClone(projection) as CompilerModuleDataProjection;
        mutate(tampered);
        const rejected = new GameSession(`item-tamper-${label}`, "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(root, `tamper-careers-${label}`) });
        const worldBefore = rejected.world.exportSnapshot();
        expect(rejected.loadCompiledModule(payload, tampered).status).toBe("refused");
        expect(rejected.world.exportSnapshot()).toEqual(worldBefore);
        rejected.close();
      };
      expectProjectionTamperRejectedBeforeWrite("name", (candidate) => { candidate.module.items[0]!.name = "Forged Key"; });
      expectProjectionTamperRejectedBeforeWrite("description", (candidate) => { candidate.module.items[0]!.description = "Forged description"; });
      expectProjectionTamperRejectedBeforeWrite("type", (candidate) => { candidate.module.items[0]!.type = "loot"; });
      expectProjectionTamperRejectedBeforeWrite("scene", (candidate) => { candidate.module.items[0]!.sceneId = "forged-scene"; });
      expectProjectionTamperRejectedBeforeWrite("origin", (candidate) => { candidate.sourceMap.items[item.itemId]!.fields.name = { kind: "artifact", artifactPath: "forged" }; });
      expectProjectionTamperRejectedBeforeWrite("question-quote", (candidate) => {
        const origin = candidate.sourceMap.items[item.itemId]!.fields.type;
        if (origin.kind !== "resolved_question") throw new Error("expected item question provenance");
        origin.quotes = [{ statementId: item.markedItemStatementId, quote: itemNameStatement.text }];
      });
      expectProjectionTamperRejectedBeforeWrite("missing", (candidate) => { candidate.module.items = []; });
      expectProjectionTamperRejectedBeforeWrite("extra", (candidate) => { candidate.module.items.push({ ...candidate.module.items[0]!, id: "invented-item" }); });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
