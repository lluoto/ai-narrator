import { describe, expect, it } from "bun:test";
import { compiledMechanicsAction, GameSession } from "../api/game-session";
import { createResolvedCompilerArtifact, restoreCompilerArtifact, sealCompilerArtifact, type ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import {
  projectResolvedCompilerArtifact,
  projectTrustedResolvedCompilerArtifact,
  trustedPresentationAudienceForFieldPath,
  trustedPresentationMachineCoverageIdentity,
  trustedPresentationMachineDecisionIdentity,
  trustedPresentationReviewIdentity,
  TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION,
  validateTrustedPresentationReviewBindings,
  type ModuleDataPresentationMetadata,
  type TrustedPresentationMachinePublication,
  type TrustedPresentationReview,
} from "../compiler/compiler-module-data-projection";
import { prepareCompiler, resolveCompiler } from "../compiler/compiler-api";
import { applyModuleCompileHints, resolveDraftModule } from "../compiler/compile-hint-resolution";
import type { ResolvedSceneStateTransitionSourceFactMechanicBinding } from "../compiler/compile-hint-resolution";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, buildCompilerQuestionQueue, validateCompilerQuestionQueue, withQueueHash, type CompilerHintCitation, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildResolvedSourceFactDispositionReport } from "../compiler/source-fact-disposition";
import { buildCompilerHintProposalRequestEnvelope, compileGroundedHintProposals, type CompilerHintProposalBatch } from "../compiler/compiler-hint-proposals";
import { allShellClueFactFacetResolutions, clueFactFacetRevelations } from "./helpers/clue-fact-facet-hints";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";

const SUCCESSFUL_EDU_FINDING = "\u6210\u529f\u7684\u77e5\u8bc6\u9274\u5b9a\u540e\uff0c\u8c03\u67e5\u5458\u53ef\u4ee5\u91cd\u64ad\u6574\u4e2a\u4eea\u5f0f\u7684\u5f55\u50cf\u3002";

function resolution(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
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
    reason: "source fact mechanics fixture",
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function sourceText(payload: ResolvedCompilerArtifactPayload, statementId: string): string {
  return required(payload.graph.statements.find((statement) => statement.id === statementId), `source statement ${statementId}`).text;
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const firstHeading = required(payload.graph.statements.find((statement) => statement.kind === "heading"), "heading").text;
  const prose = required(payload.graph.statements.find((statement) => statement.kind === "paragraph"), "paragraph").text;
  const facetRevelations = clueFactFacetRevelations(payload.clueFactFacetBindings);
  const proseFactClues = payload.sourceFactMechanicBindings
    .filter((binding): binding is Extract<ResolvedCompilerArtifactPayload["sourceFactMechanicBindings"][number], { declarationKind: "prose_fact_finding" }> => binding.declarationKind === "prose_fact_finding");
  return {
    module: { title: firstHeading, version: firstHeading, ruleset: "cosmic-horror", era: prose, summary: prose, playerCount: prose, expectedDuration: prose, triggerWarnings: [prose] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((sceneId) => {
      const scene = required(payload.draft.sceneCandidates.find((candidate) => candidate.id === sceneId), `scene ${sceneId}`);
      return [sceneId, { description: sourceText(payload, scene.headingStatementId) }];
    })),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, {
      condition: sourceText(payload, required(payload.draft.sceneCandidates.find((candidate) => candidate.id === connection.fromSceneId), `connection scene ${connection.id}`).headingStatementId),
    }])),
    clues: Object.fromEntries([
      ...payload.draft.clueCandidates.map((clue) => [clue.id, {
        findMethods: [], revelation: facetRevelations.get(clue.id) ?? sourceText(payload, clue.bodyStatementId), unlocks: [], importance: "core" as const,
      }] as const),
      ...proseFactClues.map((clue) => [clue.clueId, {
        findMethods: [], revelation: clue.quote, unlocks: [], importance: "bonus" as const,
      }] as const),
    ]),
    endings: Object.fromEntries(payload.mechanicsIR.endings.flatMap((ending) => ending.effects
      .filter((effect) => effect.kind === "end_game")
      .map((effect) => [effect.endingId, { name: prose, description: prose, conditions: [prose] }]))),
  };
}

describe("source fact mechanics children", () => {
  it("offers a server-derived prose finding from an exact successful check atom without a marked clue", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-prose-finding-red",
      sourceDescriptor: "source-prose-finding-red",
      pages: ["Archive:\nThe camera is old. 成功的知识鉴定后，调查员可以重播整个仪式的录像。 The door is locked."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, preparedQueue: queue } = prepared.artifact.payload;
    const parent = required(queue.questions.find((question) => question.kind === "source_fact_disposition"
      && graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes("知识鉴定")), "prose source parent");
    const child = required(queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId), "prose source child");

    expect(child.kind).toBe("source_fact_mechanic");
    expect((child as any).allowedProseFactFindingCandidates).toEqual([
      expect.objectContaining({
        atomId: expect.any(String),
        check: { kind: "attribute", attribute: "edu", difficulty: "regular" },
      }),
    ]);
    expect((child as any).allowedSourceFactAtoms).toHaveLength(3);
  });

  it("exposes the prose ID partition to automatic proposals only under an explicit server policy", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-prose-proposal",
      sourceDescriptor: "source-prose-proposal",
      pages: ["Archive:\nThe camera is old. 成功的知识鉴定后，调查员可以重播整个仪式的录像。 The door is locked."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, preparedQueue: queue } = prepared.artifact.payload;
    const parent = required(queue.questions.find((question) => question.kind === "source_fact_disposition"), "prose proposal parent");
    const child = required(queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId), "prose proposal child");
    const sceneRole = required(queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId), "prose proposal scene role");
    const activated = applyModuleCompileHints(graph, queue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [
        resolution(parent, { statementId: parent.subjectStatementId, disposition: "mechanics_candidate" }),
        resolution(sceneRole, { role: "playable_scene" }),
      ],
    });
    const candidate = required((child as any).allowedProseFactFindingCandidates?.[0], "proposal prose candidate");
    const sourceOnlyAtomIds = (child as any).allowedSourceFactAtoms.map((atom: { id: string }) => atom.id).filter((id: string) => id !== candidate.atomId);
    expect(() => applyModuleCompileHints(graph, queue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [
        resolution(parent, { statementId: parent.subjectStatementId, disposition: "mechanics_candidate" }),
        resolution(sceneRole, { role: "other" }),
        resolution(child, { findingCandidateIds: [candidate.id], sourceOnlyAtomIds }),
      ],
    })).toThrow("owning scene is not playable");
    const batch = (value: unknown, citations: CompilerHintCitation[] = []): CompilerHintProposalBatch => ({
      schemaVersion: "1.0.0" as const,
      moduleId: activated.moduleId,
      documentHash: activated.documentHash,
      sourceGraphIdentity: activated.sourceGraphIdentity,
      queueHash: activated.queueHash,
      proposalId: "prose-finding-proposal",
      proposals: [{ questionId: child.id, kind: "source_fact_mechanic" as const, value, citations }],
    });
    const defaultEnvelope = buildCompilerHintProposalRequestEnvelope(graph, activated, { policyId: "default-server-policy", rightsStatus: "user_provided" });
    const defaultQuestion = required(defaultEnvelope.questions.find((question) => question.questionId === child.id), "default proposal question");
    expect(defaultQuestion.candidateDomains.allowedSourceFactMechanicKinds).not.toContain("prose_fact_finding");
    expect(defaultQuestion.candidateDomains.allowedSourceFactAtoms).toBeUndefined();
    expect(defaultQuestion.candidateDomains.allowedProseFactFindingCandidates).toBeUndefined();
    expect(compileGroundedHintProposals(graph, activated, batch({ findingCandidateIds: [candidate.id], sourceOnlyAtomIds }), { policyId: "default-server-policy", rightsStatus: "user_provided" }).rejected).toMatchObject([{ code: "source_fact_mechanic_kind_not_allowed" }]);

    const explicitPolicy = { policyId: "server-prose-finding-policy", rightsStatus: "user_provided" as const, allowedSourceFactMechanicKinds: ["prose_fact_finding"] as const };
    const envelope = buildCompilerHintProposalRequestEnvelope(graph, activated, explicitPolicy);
    const question = required(envelope.questions.find((entry) => entry.questionId === child.id), "explicit prose proposal question");
    expect(question.candidateDomains.allowedProseFactFindingCandidates).toEqual([{ candidateId: candidate.id, atomId: candidate.atomId, quote: candidate.quote, check: candidate.check }]);
    expect(question.candidateDomains.allowedSourceFactAtoms).toHaveLength(3);
    expect(question.candidateDomains.allowedSourceFactAtoms).toContainEqual(expect.objectContaining({ atomId: candidate.atomId, quote: candidate.quote }));
    const accepted = compileGroundedHintProposals(graph, activated, batch({ findingCandidateIds: [candidate.id], sourceOnlyAtomIds }), explicitPolicy);
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.hints.resolutions[0]?.audit?.citations).toEqual([{ claimKey: `source_fact_mechanic:${parent.subjectStatementId!}:${candidate.id}:finding`, statementId: parent.subjectStatementId!, quote: candidate.quote }]);
    expect(compileGroundedHintProposals(graph, activated, batch({ findingCandidateIds: [candidate.id], sourceOnlyAtomIds, skill: "invented" }), explicitPolicy).rejected).toMatchObject([{ code: "invalid_hint_value" }]);
    expect(compileGroundedHintProposals(graph, activated, batch({ findingCandidateIds: [candidate.id], sourceOnlyAtomIds }, [{ claimKey: "forged", statementId: parent.subjectStatementId!, quote: candidate.quote }]), explicitPolicy).rejected).toMatchObject([{ code: "prose_fact_finding_citations_forbidden" }]);
    expect(compileGroundedHintProposals(graph, activated, batch({ findingCandidateIds: [candidate.id], sourceOnlyAtomIds: sourceOnlyAtomIds.slice(1) }), explicitPolicy).rejected).toMatchObject([{ code: "incomplete_source_fact_partition" }]);
    expect(compileGroundedHintProposals(graph, activated, batch({ findingCandidateIds: [candidate.id], sourceOnlyAtomIds: [sourceOnlyAtomIds[0], sourceOnlyAtomIds[0]] }), explicitPolicy).rejected).toMatchObject([{ code: "invalid_source_fact_partition" }]);
    expect(compileGroundedHintProposals(graph, activated, batch({ findingCandidateIds: [candidate.id, candidate.id], sourceOnlyAtomIds }), explicitPolicy).rejected).toMatchObject([{ code: "invalid_hint_value" }]);
    expect(compileGroundedHintProposals(graph, activated, batch({ findingCandidateIds: [candidate.id], sourceOnlyAtomIds, declarations: [] }), explicitPolicy).rejected).toMatchObject([{ code: "invalid_hint_value" }]);

    // The queue is an explicit boundary.  A rehashed foreign domain must not
    // be accepted merely because a prepared artifact check would catch it.
    const forgedCandidateId = structuredClone(activated);
    required(forgedCandidateId.questions.find((question) => question.id === child.id), "forged candidate child")
      .allowedProseFactFindingCandidates![0]!.id = "draft_prose_finding_forged";
    expect(() => validateCompilerQuestionQueue(graph, withQueueHash(forgedCandidateId))).toThrow("candidate IDs or checks do not match canonical");
    const forgedAtomId = structuredClone(activated);
    required(forgedAtomId.questions.find((question) => question.id === child.id), "forged atom child")
      .allowedSourceFactAtoms![0]!.id = "draft_source_fact_forged";
    expect(() => validateCompilerQuestionQueue(graph, withQueueHash(forgedAtomId))).toThrow("root atom IDs or evidence do not match canonical");
    for (const mutate of [
      (atom: any) => { atom.evidence.spans[0].documentHash = "f".repeat(64); },
      (atom: any) => { atom.evidence.spans[0].textHash = "e".repeat(64); },
      (atom: any) => { atom.evidence.spans[0].rawEnd += 1; },
    ]) {
      const forgedEvidence = structuredClone(activated);
      mutate(required(forgedEvidence.questions.find((question) => question.id === child.id), "forged evidence child").allowedSourceFactAtoms![0]!);
      expect(() => validateCompilerQuestionQueue(graph, withQueueHash(forgedEvidence))).toThrow("root atom IDs or evidence do not match canonical");
    }
    const reorderedCheck = structuredClone(activated);
    const reorderedCandidate = required(reorderedCheck.questions.find((question) => question.id === child.id), "reordered check child").allowedProseFactFindingCandidates![0]!;
    reorderedCandidate.check = { difficulty: "regular", attribute: "edu", kind: "attribute" } as typeof reorderedCandidate.check;
    expect(() => validateCompilerQuestionQueue(graph, withQueueHash(reorderedCheck))).not.toThrow();
  });

  it("rejects direct draft prose-domain tampering while accepting reordered canonical check keys", async () => {
    const candidatePrepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "direct-prose-domain-order",
      sourceDescriptor: "direct-prose-domain-order",
      pages: ["Archive:\nThe camera is old. \u6210\u529f\u7684\u77e5\u8bc6\u9274\u5b9a\u540e\uff0c\u8c03\u67e5\u5458\u53ef\u4ee5\u91cd\u64ad\u6574\u4e2a\u4eea\u5f0f\u7684\u5f55\u50cf\u3002 The door is locked."],
    });
    if (candidatePrepared.status === "refused") throw new Error(candidatePrepared.message);
    const candidateDraft = compileDeterministicTemplates(candidatePrepared.artifact.payload.graph, { moduleId: candidatePrepared.artifact.payload.draft.moduleId });
    const candidateQueue = buildCompilerQuestionQueue(candidatePrepared.artifact.payload.graph, candidateDraft);
    const reorderedDraft = structuredClone(candidateDraft);
    const reordered = required(reorderedDraft.proseFactFindingCandidates[0], "reordered draft prose candidate");
    reordered.check = { difficulty: "regular", attribute: "edu", kind: "attribute" } as typeof reordered.check;
    expect(() => resolveDraftModule(candidatePrepared.artifact.payload.graph, reorderedDraft, candidateQueue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: reorderedDraft.moduleId,
      documentHash: reorderedDraft.documentHash,
      sourceGraphIdentity: candidateQueue.sourceGraphIdentity,
      resolutions: [],
    })).not.toThrow();

    const plainPrepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "direct-prose-domain-tamper",
      sourceDescriptor: "direct-prose-domain-tamper",
      pages: ["Archive:\nThe room is quiet. The door is locked."],
    });
    if (plainPrepared.status === "refused") throw new Error(plainPrepared.message);
    const plainDraft = compileDeterministicTemplates(plainPrepared.artifact.payload.graph, { moduleId: plainPrepared.artifact.payload.draft.moduleId });
    const plainQueue = buildCompilerQuestionQueue(plainPrepared.artifact.payload.graph, plainDraft);
    const tamperedDraft = structuredClone(plainDraft);
    expect(tamperedDraft.proseFactFindingCandidates).toHaveLength(0);
    expect(tamperedDraft.sourceFactAtoms.length).toBeGreaterThan(0);
    tamperedDraft.sourceFactAtoms[0]!.quote = "forged direct draft atom";
    expect(() => resolveDraftModule(plainPrepared.artifact.payload.graph, tamperedDraft, plainQueue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: tamperedDraft.moduleId,
      documentHash: tamperedDraft.documentHash,
      sourceGraphIdentity: plainQueue.sourceGraphIdentity,
      resolutions: [],
    })).toThrow("draft prose-fact atom or finding domains do not match canonical source derivation");
  });

  it("rejects a rehashed source-fact scene domain that is not the heading's canonical draft scene", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-fact-forged-scene",
      sourceDescriptor: "source-fact-forged-scene",
      pages: ["Archive:\nThe camera is old. 成功的知识鉴定后，调查员可以重播整个仪式的录像。 The door is locked."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
    const parent = required(queue.questions.find((question) => question.kind === "source_fact_disposition"
      && graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes("知识鉴定")), "forged scene source parent");
    const child = required(queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId), "forged scene source child");

    // Rehashing proves this is rejected by semantic provenance validation, not
    // merely by the integrity seal.  Both child fields agree on the forged ID.
    const forgedQueue = structuredClone(queue);
    const forgedChild = required(forgedQueue.questions.find((question) => question.id === child.id), "forged scene queue child");
    forgedChild.owningSceneCandidateId = "scene_forged";
    forgedChild.allowedMechanicsTargetIds!.scene = ["scene_forged"];
    expect(() => validateCompilerQuestionQueue(graph, withQueueHash(forgedQueue))).toThrow("canonical draft scene");

    // A direct draft path previously re-derived this same forged queue.  It
    // must fail at the queue boundary before a hint can parse against it.
    const forgedDraft = structuredClone(draft);
    required(forgedDraft.sceneCandidates.find((scene) => scene.headingStatementId === child.owningHeadingStatementId), "forged draft scene").id = "scene_forged";
    expect(() => buildCompilerQuestionQueue(graph, forgedDraft)).toThrow("canonical draft scene");
    expect(() => resolveDraftModule(graph, forgedDraft, withQueueHash(forgedQueue), {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: forgedDraft.moduleId,
      documentHash: forgedDraft.documentHash,
      sourceGraphIdentity: forgedQueue.sourceGraphIdentity,
      resolutions: [],
    })).toThrow("canonical draft scene");
  });

  it("rejects legacy draft schemas before reading absent legacy fields", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "legacy-draft-schema",
      sourceDescriptor: "legacy-draft-schema",
      pages: ["Archive:\nThe door is locked."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
    const hints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: draft.moduleId,
      documentHash: draft.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [],
    };
    const legacyLabel = structuredClone(draft);
    legacyLabel.schemaVersion = "1.4.0" as typeof legacyLabel.schemaVersion;
    expect(() => resolveDraftModule(graph, legacyLabel, queue, hints)).toThrow("unsupported draft module structure schema");

    // Simulate a true legacy payload too: reject the schema before touching a
    // field that was introduced after it, rather than leaking a TypeError.
    const incompleteLegacy = structuredClone(legacyLabel) as unknown as Record<string, unknown>;
    delete incompleteLegacy.sourceFactAtoms;
    expect(() => resolveDraftModule(graph, incompleteLegacy as unknown as typeof draft, queue, hints)).toThrow("unsupported draft module structure schema");
  });

  it("fails closed for unparseable or ambiguous prose and never duplicates a same-heading marked clue", async () => {
    const ordinary = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "ordinary-source-only",
      sourceDescriptor: "ordinary-source-only",
      pages: ["Archive:\nThe camera records an old ritual. The door is locked."],
    });
    if (ordinary.status === "refused") throw new Error(ordinary.message);
    expect(ordinary.artifact.payload.draft.proseFactFindingCandidates).toEqual([]);
    const ordinaryParent = required(ordinary.artifact.payload.preparedQueue.questions.find((question) => question.kind === "source_fact_disposition"), "ordinary source parent");
    expect(ordinaryParent.allowedDispositions).toEqual(["source_only"]);
    expect(ordinaryParent.sourceFactChildQuestionId).toBeUndefined();

    const ambiguous = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "ambiguous-source-only",
      sourceDescriptor: "ambiguous-source-only",
      pages: ["Archive:\n\u6210\u529f\u7684\u6444\u5f71\u6216\u7535\u5668\u7ef4\u4fee\u9274\u5b9a\u663e\u793a\u6444\u50cf\u673a\u662f\u81ea\u52a8\u5173\u95ed\u7684\u3002"],
    });
    if (ambiguous.status === "refused") throw new Error(ambiguous.message);
    expect(ambiguous.artifact.payload.draft.proseFactFindingCandidates).toEqual([]);

    const duplicate = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "marked-prose-duplicate",
      sourceDescriptor: "marked-prose-duplicate",
      pages: [`Archive:\n\u25b6 Camera Log: The lens is damaged. ${SUCCESSFUL_EDU_FINDING}\n\n${SUCCESSFUL_EDU_FINDING}\n\nExit:`],
    });
    if (duplicate.status === "refused") throw new Error(duplicate.message);
    const duplicateRoot = required(duplicate.artifact.payload.graph.statements.find((statement) => statement.kind === "paragraph" && statement.text.includes(SUCCESSFUL_EDU_FINDING)), "duplicate prose root");
    const duplicateParent = required(duplicate.artifact.payload.preparedQueue.questions.find((question) => question.kind === "source_fact_disposition" && question.subjectStatementId === duplicateRoot.id), "duplicate parent");
    const duplicateChildId = required(duplicateParent.sourceFactChildQuestionId || undefined, "duplicate child id");
    const duplicateChild = required(duplicate.artifact.payload.preparedQueue.questions.find((question) => question.id === duplicateChildId), "duplicate child");
    expect(duplicateChild.allowedProseFactFindingCandidates).toBeUndefined();
    expect(duplicateChild.allowedSourceFactAtoms).toBeUndefined();
  });

  it("resolves an atom-partitioned prose finding through MechanicsIR, projection, and checked GameSession execution", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-prose-finding-e2e",
      sourceDescriptor: "source-prose-finding-e2e",
      pages: [
        "Archive:\nThe camera is old. 成功的知识鉴定后，调查员可以重播整个仪式的录像。 The door is locked.\n\nExit:\nThe archive door leads outside.",
      ],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
    const archive = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Archive")), "archive scene");
    const exit = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit scene");
    const parent = required(queue.questions.find((question) => question.kind === "source_fact_disposition"
      && graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes("知识鉴定")), "prose finding parent");
    const child = required(queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId), "prose finding child");
    const candidate = required((child as any).allowedProseFactFindingCandidates?.[0], "prose finding candidate");
    const selectedAtomId = candidate.atomId as string;
    const sourceOnlyAtomIds = (child as any).allowedSourceFactAtoms.map((atom: { id: string }) => atom.id).filter((id: string) => id !== selectedAtomId);
    const resolutions: CompilerQuestionResolution[] = [];
    for (const question of queue.questions) {
      if (question.kind === "source_fact_mechanic") continue;
      switch (question.kind) {
        case "scene_role":
          resolutions.push(resolution(question, { role: question.subjectCandidateId === archive.id || question.subjectCandidateId === exit.id ? "playable_scene" : "other" }));
          break;
        case "entry_scene": resolutions.push(resolution(question, { sceneCandidateId: archive.id })); break;
        case "connection_topology":
          resolutions.push(resolution(question, { connections: question.subjectCandidateId === archive.id ? [{ toSceneCandidateId: exit.id, connectionId: "archive_exit" }] : [] }));
          break;
        case "ending_rule":
          resolutions.push(resolution(question, { declarations: [{ endingId: "prose_fact_escape", spec: { kind: "ending_rule", id: "prose_fact_escape_rule", priority: 1, when: { kind: "scene_visited", sceneId: exit.id }, effects: [{ kind: "end_game", endingId: "prose_fact_escape" }] } }] }));
          break;
        case "source_fact_disposition":
          resolutions.push(resolution(question, { statementId: question.subjectStatementId, disposition: question.id === parent.id ? "mechanics_candidate" : "source_only" }));
          break;
        case "npc_binding": resolutions.push(resolution(question, { proseAnchorId: question.subjectCandidateId, presentNpcs: [] })); break;
        default: throw new Error(`unexpected question kind: ${question.kind}`);
      }
    }
    resolutions.push(resolution(child, { findingCandidateIds: [candidate.id], sourceOnlyAtomIds }));
    const hints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions,
    };
    const draftResolved = resolveDraftModule(graph, draft, queue, hints);
    if (draftResolved.readiness.status !== "mechanically_closed") {
      throw new Error(JSON.stringify({ readiness: draftResolved.readiness, reachability: draftResolved.reachabilityReport }));
    }
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    if (resolved.status !== "resolved") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const binding = required(payload.sourceFactMechanicBindings.find((entry): entry is Extract<ResolvedCompilerArtifactPayload["sourceFactMechanicBindings"][number], { declarationKind: "prose_fact_finding" }> => entry.declarationKind === "prose_fact_finding"), "resolved prose finding binding");
    expect(binding).toMatchObject({ candidateId: candidate.id, atomId: selectedAtomId, sourceOnlyAtomIds: sourceOnlyAtomIds.sort(), check: candidate.check, spec: { clueId: binding.clueId, target: "scene", targetId: archive.id, onSuccess: [{ kind: "discover_clue", clueId: binding.clueId }] } });
    expect(payload.mechanicsIR.symbols.clueIds).toContain(binding.clueId);
    expect(payload.analysisInput.coreClueIds).not.toContain(binding.clueId);
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status !== "projected") throw new Error(projection.message);
    expect(projection.sourceMap.scenes[archive.id]?.clues[binding.clueId]?.fields.description).toMatchObject({ quotes: [{ statementId: binding.statementId, quote: binding.quote }] });

    // A prose fact finding already has one queue-selected, exact source atom;
    // the trusted-review plan intentionally has no separate text slots for it.
    // Its review must therefore project that canonical fact without asking the
    // reviewer to recreate its name/description/revelation bindings.
    const trustedReview: TrustedPresentationReview = {
      schemaVersion: TRUSTED_PRESENTATION_REVIEW_SCHEMA_VERSION,
      id: "a".repeat(24),
      reviewerPrincipalId: "keeper:source-fact-mechanics",
      reviewedAt: "2026-10-10T04:00:00.000Z",
      preparedArtifactId: "b".repeat(24),
      preparedArtifactHash: prepared.artifact.artifactHash,
      preparedIdentity: prepared.identity,
      resolvedArtifactHash: resolved.artifact.artifactHash,
      resolvedIdentity: payload.identity,
      bindings: exactReviewBindings(payload),
      reviewHash: "",
    };
    trustedReview.reviewHash = trustedPresentationReviewIdentity(trustedReview);
    const proseFactPaths = ["name", "description", "revelation"].map((field) => `clues.${binding.clueId}.${field}`);
    expect(trustedReview.bindings.some((entry) => proseFactPaths.includes(entry.fieldPath))).toBe(false);

    const trusted = projectTrustedResolvedCompilerArtifact(payload, trustedReview);
    expect(trusted.status).toBe("projected");
    if (trusted.status !== "projected") throw new Error(trusted.message);
    const trustedScene = required(trusted.module.scenes.find((scene) => scene.id === archive.id), "trusted archive scene");
    const trustedClue = required(trustedScene.clues.find((clue) => clue.id === binding.clueId), "trusted prose fact clue");
    expect(trustedClue).toMatchObject({ name: binding.quote, description: binding.quote, revelation: binding.quote });
    const fields = required(trusted.sourceMap.scenes[archive.id]?.clues[binding.clueId]?.fields, "trusted prose fact source map");
    for (const field of ["name", "description", "revelation"] as const) {
      expect(fields[field]).toMatchObject({
        kind: "resolved_question",
        questionIds: [binding.questionId],
        claimKeys: [`source_fact_mechanic:${binding.statementId}:${binding.candidateId}:finding`],
        statements: [{ statementId: binding.headingStatementId }, { statementId: binding.statementId }],
        quotes: [{ statementId: binding.statementId, quote: binding.quote }],
      });
    }
    expect(fields.findMethods).toMatchObject({ kind: "artifact" });

    // A prose fact has no review slot: an otherwise well-shaped extra binding
    // must remain rejected rather than becoming a free player-facing override.
    const sourceBinding = required(trustedReview.bindings.find((entry) => entry.kind === "source_exact"), "review source binding");
    const withOutsideBinding = structuredClone(trustedReview);
    withOutsideBinding.bindings.push({ ...sourceBinding, fieldPath: `clues.${binding.clueId}.name` });
    withOutsideBinding.reviewHash = trustedPresentationReviewIdentity(withOutsideBinding);
    expect(projectTrustedResolvedCompilerArtifact(payload, withOutsideBinding)).toMatchObject({ status: "refused", code: "PRESENTATION_METADATA_INVALID" });

    // A source-only atom remains a canonical source substring, so an operator
    // may bind it to the scene description under the ordinary review plan.
    // A machine receipt cannot turn that mechanical-only atom into entry
    // disclosure merely by recomputing its receipt hashes.
    const sourceOnlyAtom = required((child as any).allowedSourceFactAtoms.find((atom: { id: string }) => sourceOnlyAtomIds.includes(atom.id)), "source-only fact atom");
    const sourceOnlyScenePath = `scenes.${archive.id}.description`;
    const sourceOnlyStatement = required(payload.graph.statements.find((statement) => statement.id === binding.statementId), "source-only statement");
    const sourceOnlyBindings = trustedReview.bindings.map((entry) => entry.fieldPath === sourceOnlyScenePath
      ? {
          kind: "source_exact" as const,
          fieldPath: sourceOnlyScenePath,
          statementId: binding.statementId,
          quote: sourceOnlyAtom.quote,
          evidenceRefId: sourceOnlyStatement.evidenceRefId,
          headingStatementId: binding.headingStatementId,
        }
      : structuredClone(entry));
    expect(sourceOnlyBindings).toHaveLength(trustedReview.bindings.length);
    expect(validateTrustedPresentationReviewBindings(payload, sourceOnlyBindings)).toMatchObject({ status: "validated" });
    const scopes = sourceOnlyBindings.map((entry) => {
      const audience = trustedPresentationAudienceForFieldPath(entry.fieldPath);
      if (!audience) throw new Error(`missing presentation audience: ${entry.fieldPath}`);
      return { fieldPath: entry.fieldPath, audience };
    });
    const machinePublication: TrustedPresentationMachinePublication = {
      servicePrincipalId: "service:source-fact-machine",
      policyId: "source-fact-machine-v1",
      requestHash: "1".repeat(64),
      responseHash: "2".repeat(64),
      decisionHash: trustedPresentationMachineDecisionIdentity(sourceOnlyBindings, scopes),
      coverageHash: trustedPresentationMachineCoverageIdentity(scopes),
      scopes,
    };
    const sourceOnlyMachineReview: TrustedPresentationReview = {
      ...trustedReview,
      id: "c".repeat(24),
      reviewerPrincipalId: machinePublication.servicePrincipalId,
      bindings: sourceOnlyBindings,
      machinePublication,
      reviewHash: "",
    };
    sourceOnlyMachineReview.reviewHash = trustedPresentationReviewIdentity(sourceOnlyMachineReview);
    expect(projectTrustedResolvedCompilerArtifact(payload, sourceOnlyMachineReview)).toMatchObject({ status: "refused", code: "PRESENTATION_METADATA_INVALID" });

    const makeSession = () => new GameSession("source-prose-finding-e2e", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, "investigator", "Ada");
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.999;
      const failed = makeSession();
      expect(failed.loadCompiledModule(payload, projection).status).toBe("loaded");
      const failedAction = await failed.act(compiledMechanicsAction(binding.mechanismId));
      expect(failedAction.error).toBeUndefined();
      expect(failedAction.compiled?.state.foundClueIds).not.toContain(binding.clueId);

      Math.random = () => 0;
      const succeeded = makeSession();
      expect(succeeded.loadCompiledModule(payload, projection).status).toBe("loaded");
      const successAction = await succeeded.act(compiledMechanicsAction(binding.mechanismId));
      expect(successAction.error).toBeUndefined();
      expect(successAction.compiled?.state.foundClueIds).toContain(binding.clueId);
      const exitAction = await succeeded.act(compiledMechanicsAction(required(payload.mechanicsIR.connections.find((connection) => connection.connectionId === "archive_exit"), "archive exit mechanism").id));
      expect(exitAction.error).toBeUndefined();
      expect(exitAction.compiled?.state.terminalEndingId).toBe("prose_fact_escape");
    } finally {
      Math.random = originalRandom;
    }
  });

  it("prepares a deferred typed child and replays unordered parent/child answers deterministically", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-fact-mechanics",
      sourceDescriptor: "source-fact-mechanics",
      pages: ["Dock:\nA wet note says the key is hidden nearby.\n\n\u25b6 Rust Key: A rusted key lies under the crate."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const queue = prepared.artifact.payload.preparedQueue;
    const parent = queue.questions.find((question) => question.kind === "source_fact_disposition"
      && prepared.artifact.payload.graph.statements.find((statement) => statement.id === question.subjectStatementId)?.kind === "paragraph")!;
    const childId = (parent as any).sourceFactChildQuestionId as string;
    const child = queue.questions.find((question) => question.id === childId)!;

    expect(child).toMatchObject({ kind: "source_fact_mechanic", status: "deferred", sourceFactParentQuestionId: parent.id });
    expect(child.prompt).toContain("scene_state_transition");
    expect(child.prompt).toContain("this child's closed same-heading domains");
    expect(child.prompt).toContain("scene_enter omits prerequisite");
    const root = prepared.artifact.payload.graph.statements.find((statement) => statement.id === parent.subjectStatementId)!;
    const clueId = (child.allowedMechanicsTargetIds?.clue ?? [])[0]!;
    const sceneRole = queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId)!;
    const hints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      // The child deliberately comes first: replay must canonicalize activation.
      resolutions: [
        resolution(child, {
          declarations: [{
            declarationKey: "wet-note",
            kind: "existing_clue_discovery",
            clueCandidateId: clueId,
            action: "search",
            target: "scene",
            targetId: child.owningSceneCandidateId,
            evidence: [
              { claimKey: `source_fact_mechanic:${root.id}:wet-note:declaration`, statementId: root.id, quote: root.text.trim() },
              { claimKey: `source_fact_mechanic:${root.id}:wet-note:action`, statementId: root.id, quote: root.text.trim() },
              { claimKey: `source_fact_mechanic:${root.id}:wet-note:target`, statementId: root.id, quote: root.text.trim() },
              { claimKey: `source_fact_mechanic:${root.id}:wet-note:discover`, statementId: root.id, quote: root.text.trim() },
            ],
          }],
        }),
        resolution(parent, { statementId: root.id, disposition: "mechanics_candidate" }),
        resolution(sceneRole, { role: "playable_scene" }),
      ],
    };
    const replayed = applyModuleCompileHints(prepared.artifact.payload.graph, queue, hints);
    expect(replayed.questions.find((question) => question.id === parent.id)?.status).toBe("answered");
    expect(replayed.questions.find((question) => question.id === child.id)?.status).toBe("answered");
    const resolved = resolveDraftModule(prepared.artifact.payload.graph, prepared.artifact.payload.draft, queue, hints);
    expect(resolved.sourceFactMechanicBindings).toMatchObject([{ parentQuestionId: parent.id, questionId: child.id, mechanismId: expect.stringMatching(/^source_mechanic_/), sceneCandidateId: child.owningSceneCandidateId }]);
    expect(resolved.acceptedInterpretations.find((interpretation) => interpretation.id === resolved.sourceFactMechanicBindings[0]?.interpretationId)?.claim.value).toMatchObject({
      kind: "discovery_method", action: "search", target: "scene", onSuccess: [{ kind: "discover_clue", clueId }],
    });
    const disposition = buildResolvedSourceFactDispositionReport(prepared.artifact.payload.graph, prepared.artifact.payload.draft, resolved.resolvedQueue, resolved.acceptedInterpretations, {
      proseNpcBindings: resolved.proseNpcBindings,
      itemBindings: resolved.itemBindings,
      rewardBindings: resolved.rewardBindings,
      sourceFactMechanicBindings: resolved.sourceFactMechanicBindings,
    });
    expect(disposition.entries.find((entry) => entry.statementId === root.id)).toMatchObject({
      status: "mechanics_evidence", positiveCoverage: true, reasons: expect.arrayContaining(["accepted_source_fact_mechanic"]),
    });
    expect(disposition.contentReadiness.mechanicsCandidateStatementIds).not.toContain(root.id);

    expect(() => applyModuleCompileHints(prepared.artifact.payload.graph, queue, {
      ...hints,
      resolutions: [hints.resolutions[0]!],
    })).toThrow("deferred source fact child");
    expect(() => applyModuleCompileHints(prepared.artifact.payload.graph, queue, {
      ...hints,
      resolutions: hints.resolutions.map((entry) => entry.questionId === parent.id
        ? resolution(parent, { statementId: root.id, disposition: "source_only" })
        : entry),
    })).toThrow("source_only parent cannot answer source fact child");
    expect(() => applyModuleCompileHints(prepared.artifact.payload.graph, queue, {
      ...hints,
      resolutions: hints.resolutions.map((entry) => entry.questionId === sceneRole.id ? resolution(sceneRole, { role: "other" }) : entry),
    })).toThrow("owning scene is not playable");

    const forged = structuredClone(queue);
    const forgedChild = forged.questions.find((question) => question.id === child.id)!;
    forgedChild.sourceFactParentQuestionId = "forged_parent";
    expect(() => validateCompilerQuestionQueue(prepared.artifact.payload.graph, withQueueHash(forged))).toThrow("does not match its prepared disposition parent");
    const foreignEvidence = structuredClone(hints);
    ((foreignEvidence.resolutions[0]!.value as any).declarations[0].evidence[0].quote) = "forged quote";
    expect(() => applyModuleCompileHints(prepared.artifact.payload.graph, queue, foreignEvidence)).toThrow("exactly quote its trimmed root statement");
    const callerMechanismId = structuredClone(hints);
    ((callerMechanismId.resolutions[0]!.value as any).declarations[0].mechanismId) = "caller_selected";
    expect(() => applyModuleCompileHints(prepared.artifact.payload.graph, queue, callerMechanismId)).toThrow("undeclared source_fact_mechanic.declarations[0] field");
  });

  it("derives a bounded scene transition from a root-exact typed child declaration", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-fact-transition",
      sourceDescriptor: "source-fact-transition",
      pages: ["Dock:\nA wet note says the signal reveals the key.\n\n\u25b6 Harbor Signal: The signal identifies the crate.\n\u25b6 Rust Key: A rusted key lies under the crate.\n\nAttic:\n\u25b6 Attic Map: The map points to a foreign room."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, preparedQueue: queue } = prepared.artifact.payload;
    const parent = queue.questions.find((question) => question.kind === "source_fact_disposition"
      && graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes("wet note"))!;
    const child = queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId)!;
    const [prerequisiteClueId, outputClueId] = child.allowedMechanicsTargetIds!.clue!;
    const owningSceneCandidateId = required(child.owningSceneCandidateId, "owning scene");
    const root = graph.statements.find((statement) => statement.id === parent.subjectStatementId)!;
    const sceneRole = queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId)!;
    const claim = (atom: string) => ({
      claimKey: `source_fact_mechanic:${root.id}:signal-reveals-key:${atom}`,
      statementId: root.id,
      quote: root.text.trim(),
    });
    const hints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [
        resolution(child, {
          declarations: [{
            declarationKey: "signal-reveals-key",
            kind: "scene_state_transition",
            trigger: { kind: "clue_found", clueCandidateId: prerequisiteClueId },
            discoverClueCandidateId: outputClueId,
            evidence: [claim("declaration"), claim("trigger"), claim("prerequisite"), claim("discover")],
          }],
        }),
        resolution(parent, { statementId: root.id, disposition: "mechanics_candidate" }),
        resolution(sceneRole, { role: "playable_scene" }),
      ],
    };

    const replayed = applyModuleCompileHints(graph, queue, hints);
    expect(replayed.questions.find((question) => question.id === child.id)?.status).toBe("answered");
    const resolved = resolveDraftModule(graph, prepared.artifact.payload.draft, queue, hints);
    const binding = resolved.sourceFactMechanicBindings.find((candidate) => candidate.questionId === child.id)!;
    if (binding.declarationKind !== "scene_state_transition") throw new Error("transition binding did not remain discriminated");
    expect(binding).toMatchObject({
      declarationKind: "scene_state_transition",
      sceneCandidateId: child.owningSceneCandidateId,
      mechanismId: expect.stringMatching(/^source_mechanic_[a-f0-9]{24}$/),
    });
    expect(binding.stateKey).toMatch(/^source_state_[a-f0-9]{24}$/);
    expect(binding.spec).toMatchObject({
      kind: "state_transition",
      effects: [
        { kind: "discover_clue", clueId: outputClueId },
        { kind: "set_state", stateKey: binding.stateKey, value: true },
      ],
    });
    expect(binding.spec.when).toEqual({
      kind: "all",
      predicates: [
        { kind: "current_scene", sceneId: owningSceneCandidateId },
        { kind: "clue_found", clueId: prerequisiteClueId },
        { kind: "not", predicate: { kind: "clue_found", clueId: outputClueId } },
        { kind: "not", predicate: { kind: "state_eq", stateKey: binding.stateKey, value: true } },
      ],
    });
  });

  it("versions transition capability explicitly and keeps distinct explicit paths to one clue", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-fact-transition-schema",
      sourceDescriptor: "source-fact-transition-schema",
      pages: ["Dock:\nA wet note says the signal reveals the key.\n\n\u25b6 Harbor Signal: The signal identifies the crate.\n\u25b6 Rust Key: A rusted key lies under the crate.\n\nAttic:\n\u25b6 Attic Map: The map points to a foreign room."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
    const parent = required(queue.questions.find((question) => question.kind === "source_fact_disposition"
      && graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes("wet note")), "source fact parent");
    const child = required(queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId), "source fact child");
    const [signalId, keyId] = required(child.allowedMechanicsTargetIds?.clue, "child clue domain");
    const root = required(graph.statements.find((statement) => statement.id === parent.subjectStatementId), "source root");
    const sceneRole = required(queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId), "owning scene role");
    const claim = (declarationKey: string, atom: string) => ({
      claimKey: `source_fact_mechanic:${root.id}:${declarationKey}:${atom}`,
      statementId: root.id,
      quote: root.text.trim(),
    });
    const transition = {
      declarationKey: "signal-reveals-key",
      kind: "scene_state_transition",
      trigger: { kind: "clue_found", clueCandidateId: signalId },
      discoverClueCandidateId: keyId,
      evidence: [claim("signal-reveals-key", "declaration"), claim("signal-reveals-key", "trigger"), claim("signal-reveals-key", "prerequisite"), claim("signal-reveals-key", "discover")],
    };
    const discovery = {
      declarationKey: "search-for-key",
      kind: "existing_clue_discovery",
      clueCandidateId: keyId,
      action: "search",
      target: "scene",
      targetId: child.owningSceneCandidateId,
      evidence: [claim("search-for-key", "declaration"), claim("search-for-key", "action"), claim("search-for-key", "target"), claim("search-for-key", "discover")],
    };
    const hints = (schemaVersion: ModuleCompileHints["schemaVersion"], declarations: unknown[]): ModuleCompileHints => ({
      schemaVersion,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [
        resolution(child, { declarations }),
        resolution(parent, { statementId: root.id, disposition: "mechanics_candidate" }),
        resolution(sceneRole, { role: "playable_scene" }),
      ],
    });

    // 3.0 remains a readable existing-discovery child contract.
    expect(applyModuleCompileHints(graph, queue, hints("3.0.0", [discovery])).questions.find((question) => question.id === child.id)?.status).toBe("answered");
    expect(() => applyModuleCompileHints(graph, queue, hints("3.0.0", [transition]))).toThrow("require 3.1.0");

    // A direct discovery and a transition may both discover the same output.
    const resolved = resolveDraftModule(graph, draft, queue, hints(MODULE_COMPILE_HINTS_SCHEMA_VERSION, [discovery, transition]));
    expect(resolved.sourceFactMechanicBindings.filter((binding) => binding.questionId === child.id)).toHaveLength(2);

    const duplicateSlot = structuredClone(transition);
    duplicateSlot.declarationKey = "same-trigger-same-output";
    expect(() => applyModuleCompileHints(graph, queue, hints(MODULE_COMPILE_HINTS_SCHEMA_VERSION, [transition, duplicateSlot]))).toThrow("duplicates an occupied trigger slot");
    const selfPrerequisite = structuredClone(transition);
    selfPrerequisite.trigger.clueCandidateId = keyId;
    expect(() => applyModuleCompileHints(graph, queue, hints(MODULE_COMPILE_HINTS_SCHEMA_VERSION, [selfPrerequisite]))).toThrow("cannot equal its output clue");
    const foreignClueId = required(draft.clueCandidates.find((candidate) => candidate.sceneCandidateId !== child.owningSceneCandidateId)?.id, "foreign-heading clue");
    const crossHeading = structuredClone(transition);
    crossHeading.discoverClueCandidateId = foreignClueId;
    expect(() => applyModuleCompileHints(graph, queue, hints(MODULE_COMPILE_HINTS_SCHEMA_VERSION, [crossHeading]))).toThrow("same-heading canonical clue");
    const callerStateKey = structuredClone(transition) as Record<string, unknown>;
    callerStateKey.stateKey = "caller_state";
    expect(() => applyModuleCompileHints(graph, queue, hints(MODULE_COMPILE_HINTS_SCHEMA_VERSION, [callerStateKey]))).toThrow("undeclared source_fact_mechanic.declarations[0] field");
    const partialEvidence = structuredClone(transition);
    partialEvidence.evidence[0]!.quote = "wet note";
    expect(() => applyModuleCompileHints(graph, queue, hints(MODULE_COMPILE_HINTS_SCHEMA_VERSION, [partialEvidence]))).toThrow("exactly quote its trimmed root statement");
    expect(() => applyModuleCompileHints(graph, queue, hints(MODULE_COMPILE_HINTS_SCHEMA_VERSION, []))).toThrow("one to four declarations");
    expect(() => applyModuleCompileHints(graph, queue, hints(MODULE_COMPILE_HINTS_SCHEMA_VERSION, Array.from({ length: 5 }, () => transition)))).toThrow("one to four declarations");
  });

  it("prepares, seals, restores, projects, and executes a source-bound automatic transition", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-fact-transition-e2e",
      sourceDescriptor: "source-fact-transition-e2e",
      pages: ["Dock:\nA wet note says the harbor signal reveals the rust key and harbor chart.\n\n\u25b6 Harbor Signal: The signal identifies the crate.\n\u25b6 Rust Key: The rusted key opens the gate.\n\u25b6 Harbor Chart: The chart marks the safe channel.\nEnding:\nReading the harbor chart ends the investigation."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, draft, preparedQueue: queue } = prepared.artifact.payload;
    const scene = (name: string) => required(draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(name)), `scene ${name}`);
    const clue = (name: string) => required(draft.clueCandidates.find((candidate) => candidate.displayName === name), `clue ${name}`);
    const dock = scene("Dock");
    const signal = clue("HarborSignal");
    const key = clue("RustKey");
    const chart = clue("HarborChart");
    const parent = required(queue.questions.find((question) => question.kind === "source_fact_disposition"
      && graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes("wet note")), "source fact parent");
    const child = required(queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId), "source fact child");
    const root = required(graph.statements.find((statement) => statement.id === parent.subjectStatementId), "source fact root");
    const evidence = (declarationKey: string, atom: string) => ({ claimKey: `source_fact_mechanic:${root.id}:${declarationKey}:${atom}`, statementId: root.id, quote: root.text.trim() });
    const answerFor = (question: CompilerQuestion, value: unknown) => resolution(question, value);
    const resolutions: CompilerQuestionResolution[] = [];
    for (const question of queue.questions) {
      if (question.kind === "source_fact_mechanic") continue;
      switch (question.kind) {
        case "clue_fact_facets":
          resolutions.push(...allShellClueFactFacetResolutions([question], answerFor));
          break;
        case "source_fact_disposition":
          resolutions.push(answerFor(question, { statementId: question.subjectStatementId, disposition: question.id === parent.id ? "mechanics_candidate" : "source_only" }));
          break;
        case "scene_role":
          resolutions.push(answerFor(question, { role: question.subjectCandidateId === dock.id ? "playable_scene" : question.subjectCandidateId === scene("Ending").id ? "ending_section" : "other" }));
          break;
        case "entry_scene": resolutions.push(answerFor(question, { sceneCandidateId: dock.id })); break;
        case "connection_topology":
          resolutions.push(answerFor(question, { connections: [] }));
          break;
        case "core_clue":
          resolutions.push(answerFor(question, { clueCandidateId: question.subjectCandidateId, required: question.subjectCandidateId === key.id }));
          break;
        case "discovery_method": {
          const clueId = question.subjectCandidateId!;
          // The transition is the only explicit mechanism for its outputs;
          // this proves it replaces the matching default observations.
          if (clueId !== signal.id) break;
          resolutions.push(answerFor(question, {
            clueCandidateId: clueId,
            locationSceneCandidateId: dock.id,
            spec: { kind: "discovery_method", id: clueId === signal.id ? "transition_find_signal" : `transition_find_${clueId}`, clueId, action: "search", target: "scene", targetId: dock.id, onSuccess: [{ kind: "discover_clue", clueId }] },
          }));
          break;
        }
        case "item_binding": resolutions.push(answerFor(question, { itemCandidateId: question.subjectCandidateId, itemType: null })); break;
        case "npc_binding": resolutions.push(answerFor(question, { proseAnchorId: question.subjectCandidateId, presentNpcs: [] })); break;
        case "reward_binding": resolutions.push(answerFor(question, { rewardCandidateId: question.subjectCandidateId, declaration: null })); break;
        case "ending_rule":
          resolutions.push(answerFor(question, { declarations: [{ endingId: "transition_safe_home", spec: { kind: "ending_rule", id: "transition_safe_home_rule", priority: 1, when: { kind: "clue_found", clueId: chart.id }, effects: [{ kind: "end_game", endingId: "transition_safe_home" }] } }] }));
          break;
        default: throw new Error(`unexpected question kind: ${question.kind}`);
      }
    }
    resolutions.push(answerFor(child, {
      declarations: [{
        declarationKey: "signal-reveals-key",
        kind: "scene_state_transition",
        trigger: { kind: "clue_found", clueCandidateId: signal.id },
        discoverClueCandidateId: key.id,
        evidence: [evidence("signal-reveals-key", "declaration"), evidence("signal-reveals-key", "trigger"), evidence("signal-reveals-key", "prerequisite"), evidence("signal-reveals-key", "discover")],
      }, {
        declarationKey: "signal-reveals-chart",
        kind: "scene_state_transition",
        trigger: { kind: "clue_found", clueCandidateId: signal.id },
        discoverClueCandidateId: chart.id,
        evidence: [evidence("signal-reveals-chart", "declaration"), evidence("signal-reveals-chart", "trigger"), evidence("signal-reveals-chart", "prerequisite"), evidence("signal-reveals-chart", "discover")],
      }],
    }));
    const hints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions,
    };
    const draftResolved = resolveDraftModule(graph, draft, queue, hints);
    if (draftResolved.readiness.status !== "mechanically_closed") throw new Error(JSON.stringify({ readiness: draftResolved.readiness, reachability: draftResolved.reachabilityReport }));
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    if (resolved.status !== "resolved") throw new Error(resolved.message);
    expect(resolved.status).toBe("resolved");
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const substitutedOutputDefaults = draft.interpretations
      .filter((candidate) => candidate.claim.value?.kind === "discovery_method" && [key.id, chart.id].includes(candidate.claim.value.clueId))
      .map((candidate) => candidate.id);
    expect(payload.substitutedEnginePolicyInterpretationIds).toEqual(expect.arrayContaining(substitutedOutputDefaults));
    const bindings = payload.sourceFactMechanicBindings.filter((candidate): candidate is ResolvedSceneStateTransitionSourceFactMechanicBinding => candidate.questionId === child.id && candidate.declarationKind === "scene_state_transition");
    if (bindings.length !== 2) throw new Error("missing scene-state-transition bindings");
    const binding = required(bindings.find((candidate) => candidate.discoverClueId === key.id), "key transition binding");
    const chartBinding = required(bindings.find((candidate) => candidate.discoverClueId === chart.id), "chart transition binding");
    expect(payload.mechanicsIR.symbols.declaredStateKeys).toEqual(expect.arrayContaining([binding.stateKey, chartBinding.stateKey]));
    const transitionsById = new Map(payload.mechanicsIR.transitions.map((transition) => [transition.id, transition]));
    expect(transitionsById.get(binding.mechanismId)).toMatchObject({ effects: [{ kind: "discover_clue", clueId: key.id }, { kind: "set_state", stateKey: binding.stateKey, value: true }] });
    expect(transitionsById.get(chartBinding.mechanismId)).toMatchObject({ effects: [{ kind: "discover_clue", clueId: chart.id }, { kind: "set_state", stateKey: chartBinding.stateKey, value: true }] });
    expect(payload.analysisInput.discoveryLocations[binding.mechanismId]).toBeUndefined();
    expect(payload.analysisInput.discoveryLocations[chartBinding.mechanismId]).toBeUndefined();
    const rootDisposition = required(payload.resolvedSourceFactDispositionReport.entries.find((entry) => entry.statementId === root.id), "root disposition");
    expect(rootDisposition.positiveCoverage).toBe(true);
    expect(rootDisposition.reasons.includes("accepted_source_fact_mechanic")).toBe(true);
    const sealed = createResolvedCompilerArtifact(payload);
    const restored = restoreCompilerArtifact(sealed);
    expect(restored).toMatchObject({ status: "restored", stage: "resolved" });
    const tampered = structuredClone(sealed);
    const tamperedBinding = (tampered.payload as ResolvedCompilerArtifactPayload).sourceFactMechanicBindings.find((candidate) => candidate.declarationKind === "scene_state_transition");
    if (!tamperedBinding || tamperedBinding.declarationKind !== "scene_state_transition") throw new Error("missing sealed transition binding");
    tamperedBinding.stateKey = `${tamperedBinding.stateKey}_forged`;
    const { artifactHash: _artifactHash, ...unsealedTamper } = tampered;
    expect(restoreCompilerArtifact(sealCompilerArtifact(unsealedTamper))).toMatchObject({ status: "refused", stage: "resolved", code: "RESOLVED_SNAPSHOT_MISMATCH" });
    const tamperedSpec = structuredClone(sealed);
    const specBinding = (tamperedSpec.payload as ResolvedCompilerArtifactPayload).sourceFactMechanicBindings.find((candidate) => candidate.declarationKind === "scene_state_transition");
    if (!specBinding || specBinding.declarationKind !== "scene_state_transition") throw new Error("missing sealed transition spec");
    specBinding.spec.effects[0] = { kind: "discover_clue", clueId: signal.id };
    const { artifactHash: _specArtifactHash, ...unsealedSpecTamper } = tamperedSpec;
    expect(restoreCompilerArtifact(sealCompilerArtifact(unsealedSpecTamper))).toMatchObject({ status: "refused", stage: "resolved", code: "RESOLVED_SNAPSHOT_MISMATCH" });
    const tamperedSymbols = structuredClone(sealed);
    (tamperedSymbols.payload as ResolvedCompilerArtifactPayload).mechanicsIR.symbols.declaredStateKeys[0] = "source_state_forged";
    const { artifactHash: _symbolsArtifactHash, ...unsealedSymbolsTamper } = tamperedSymbols;
    expect(restoreCompilerArtifact(sealCompilerArtifact(unsealedSymbolsTamper))).toMatchObject({ status: "refused", stage: "resolved", code: "RESOLVED_SNAPSHOT_MISMATCH" });
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status !== "projected") throw new Error(projection.message);
    const session = new GameSession("source-fact-transition-e2e", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, "investigator", "Ada");
    expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
    const foundSignal = await session.act(compiledMechanicsAction("transition_find_signal"));
    expect(foundSignal.error).toBeUndefined();
    expect(foundSignal.compiled?.state.foundClueIds).toEqual(expect.arrayContaining([signal.id, key.id, chart.id]));
    expect(foundSignal.compiled?.state.stateValues[binding.stateKey]).toBe(true);
    expect(foundSignal.compiled?.state.stateValues[chartBinding.stateKey]).toBe(true);
    const transitionEdges = foundSignal.compiled?.trace.filter((edge) => edge.outcome === "transition") ?? [];
    expect(transitionEdges).toHaveLength(1);
    expect(transitionEdges[0]!.mechanismIds).toEqual([binding.mechanismId, chartBinding.mechanismId].sort());
    expect(foundSignal.compiled?.state.terminalEndingId).toBe("transition_safe_home");
    expect(foundSignal.compiled?.trace.at(-1)?.outcome).toBe("ending");
  });
});
