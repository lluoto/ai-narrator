import { describe, expect, it } from "bun:test";
import { applyModuleCompileHints, parseCompilerHintValue, resolveDraftModule } from "../compiler/compile-hint-resolution";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, buildCompilerQuestionQueue, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { sourceStatementEvidenceRefId, type FactInterpretationCandidate } from "../compiler/source-fact-graph";
import type { EncounterDefinitionSpec, MechanicsCandidateSpec } from "../compiler/mechanics-ir";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";

function fixture() {
  const document = createSyntheticDocumentIR(["场景一：\n▶甲：正文。\n场景二：\n▶乙：正文。"], "p7-resolution-fixture");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "p7-resolution-fixture" });
  return { graph, draft, queue: buildCompilerQuestionQueue(graph, draft) };
}

function hints(queue: ReturnType<typeof fixture>["queue"]): ModuleCompileHints {
  const role = queue.questions.find((question) => question.kind === "scene_role")!;
  return { schemaVersion: "1.3.0", moduleId: queue.moduleId, documentHash: queue.documentHash, sourceGraphIdentity: queue.sourceGraphIdentity, resolutions: [{ questionId: role.id, kind: "scene_role", value: { role: "playable_scene" }, sourceStatementIds: [...role.sourceStatementIds], evidenceRefs: [...role.evidenceRefs], authority: "user_document", derivation: "explicit", reviewerKind: "human", rightsStatus: "user_provided", reason: "synthetic explicit scene role" }] };
}

describe("compile hint resolution", () => {
  it("answers only explicitly hinted questions and leaves partial drafts draft_only", () => {
    const { graph, draft, queue } = fixture();
    const resolved = applyModuleCompileHints(graph, queue, hints(queue));
    expect(resolved.questions.filter((question) => question.status === "answered")).toHaveLength(1);
    expect(resolved.questions.some((question) => question.kind === "entry_scene" && question.status === "open")).toBe(true);
    expect(resolveDraftModule(graph, draft, queue, hints(queue)).readiness.status).toBe("draft_only");
  });

  it("allows topology targets only from the question allowlist and core only from its subject", () => {
    const { queue } = fixture();
    const topology = queue.questions.find((question) => question.kind === "connection_topology")!;
    expect(() => parseCompilerHintValue(topology, { connections: [{ toSceneCandidateId: "invented", connectionId: "connection_x" }] })).toThrow("unallowed");
    const core = queue.questions.find((question) => question.kind === "core_clue")!;
    expect(() => parseCompilerHintValue(core, { clueCandidateId: "invented", required: true })).toThrow("subject");
  });

  it("accepts exact item bindings but keeps check_spec and state_key unsupported", () => {
    const { graph, queue } = fixture();
    const item = queue.questions.find((question) => question.kind === "item_binding")!;
    const bound: ModuleCompileHints = {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION, moduleId: queue.moduleId, documentHash: queue.documentHash, sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [{ questionId: item.id, kind: "item_binding", value: {
        itemCandidateId: item.subjectCandidateId,
        itemType: "key",
        itemNameEvidence: {
          statementId: item.allowedItemNameEvidenceStatementIds![1]!,
          quote: graph.statements.find((statement) => statement.id === item.allowedItemNameEvidenceStatementIds![1])!.text,
        },
      }, sourceStatementIds: [...item.sourceStatementIds], evidenceRefs: [...item.evidenceRefs], authority: "user_document", derivation: "explicit", reviewerKind: "human", rightsStatus: "user_provided", reason: "explicit source-bound item" }],
    };
    expect(applyModuleCompileHints(graph, queue, bound).questions.find((question) => question.id === item.id)?.status).toBe("answered");
    for (const kind of ["check_spec", "state_key"] as const) {
      expect(() => parseCompilerHintValue({ ...item, kind }, {})).toThrow("unsupported_hint_kind");
    }
  });

  it("preserves a reviewed source encounter definition without synthesizing one from hints", () => {
    const { graph, draft, queue } = fixture();
    const statementId = graph.statements[0]!.id;
    const spec: EncounterDefinitionSpec = {
      kind: "encounter_definition", id: "encounter_source", encounterId: "encounter_source", sceneId: "scene_one", combatantId: "npc_source",
      maxHp: 2, dodge: 20, fight: 40, npcDamage: { kind: "fixed", amount: 1 }, victoryEffects: [{ kind: "set_state", stateKey: "source_flag", value: true }],
    };
    const candidate: FactInterpretationCandidate<MechanicsCandidateSpec> = {
      id: "accepted:encounter_source",
      sourceStatementIds: [statementId],
      claim: {
        path: "mechanics.encounter_definition.encounter_source", value: spec, domain: "gameplay_mechanic", authority: "module_explicit", derivation: "explicit", status: "accepted",
        evidenceRefs: [sourceStatementEvidenceRefId(statementId)], sourceRef: null, confidence: null, reason: "source encounter", rightsStatus: "user_provided", scope: { moduleId: draft.moduleId },
      },
      interpretationStatus: "accepted",
      review: { interpretationId: "accepted:encounter_source", decision: "accept", reason: "fixture", reviewerKind: "deterministic_rule", policyId: "fixture", reviewEvidenceStatementIds: [statementId] },
    };
    draft.interpretations.push(candidate);
    const resolved = resolveDraftModule(graph, draft, queue, hints(queue));
    expect(resolved.acceptedInterpretations.find((entry) => entry.id === candidate.id)?.claim.value).toEqual(spec);
    expect(resolved.readiness.status).toBe("draft_only");
  });
});
