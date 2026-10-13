import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { compileDeterministicTemplates, MARKED_ITEM_OBSERVATION_POLICY_ID } from "../compiler/deterministic-template-compiler";
import { compileMechanics, type MechanicsCompilationInput } from "../compiler/mechanics-ir";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { importPointsTo, scanImports } from "../diagnostics/source-scan";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";

function graphFor(pages: string[]) {
  const document = createSyntheticDocumentIR(pages, "deterministic-template-test");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  return buildSourceFactGraph(document, blocks);
}

function documentAndBlocks(pages: string[]) {
  const document = createSyntheticDocumentIR(pages, "deterministic-template-test");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  return { document, blocks };
}

function compiledInput(draft: ReturnType<typeof compileDeterministicTemplates>, overrides: Partial<MechanicsCompilationInput> = {}): MechanicsCompilationInput {
  if (!draft.mechanicsIR) throw new Error("fixture did not generate mechanics IR");
  return {
    moduleId: draft.moduleId,
    documentHash: draft.documentHash,
    sourceGraphSchemaVersion: "1.1.0",
    symbols: draft.mechanicsIR.symbols,
    acceptedInterpretationIds: draft.interpretations.map((interpretation) => interpretation.id),
    compilationMode: "compatible",
    allowedEnginePolicyIds: [MARKED_ITEM_OBSERVATION_POLICY_ID],
    ...overrides,
  };
}

describe("deterministic marked-item templates", () => {
  it("keeps context-recognized discovery entries source-exact and scoped to their heading", () => {
    const graph = graphFor([[
      "搜查现场：",
      "搜索房间可以发现以下物品。",
      "染血钥匙：挂在门后。",
      "石像：摆在书桌上。",
    ].join("\n")]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "template-fixture" });
    const heading = graph.statements.find((statement) => statement.kind === "heading" && statement.text === "搜查现场：")!;
    const key = draft.clueCandidates.find((candidate) => candidate.displayName === "染血钥匙")!;
    const keyItem = graph.statements.find((statement) => statement.id === key.markedItemStatementId)!;
    const keyName = graph.statements.find((statement) => statement.id === key.nameStatementId)!;
    const keyBody = graph.statements.find((statement) => statement.id === key.bodyStatementId)!;

    expect(draft.clueCandidates.map((candidate) => candidate.displayName)).toEqual(["染血钥匙", "石像"]);
    expect(keyItem.parentStatementId).toBe(heading.id);
    expect(graph.relations.some((relation) => relation.kind === "heading_scopes" && relation.from === heading.id && relation.to === keyItem.id)).toBe(true);
    expect(keyName.evidence.spans.map((span) => span.exactText).join("")).toBe("染血钥匙");
    expect(keyBody.evidence.spans.map((span) => span.exactText).join("")).toBe("挂在门后。");
  });

  it("allows the reviewed policy only in compatible mode with its explicit allowlist", () => {
    const graph = graphFor(["场景：\n▶钥匙：桌上有一把钥匙。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "template-fixture" });
    expect(() => compileMechanics({ ...graph, interpretations: draft.interpretations }, compiledInput(draft, { compilationMode: "strict" }))).toThrow("strict mode");
    expect(compileMechanics({ ...graph, interpretations: draft.interpretations }, compiledInput(draft)).discoveryMethods).toHaveLength(1);
    const missingPolicy = structuredClone(draft.interpretations);
    delete missingPolicy[0]!.review!.policyId;
    expect(() => compileMechanics({ ...graph, interpretations: missingPolicy }, compiledInput(draft))).toThrow("policyId");
    const wrongPolicy = structuredClone(draft.interpretations);
    wrongPolicy[0]!.review!.policyId = "other-policy";
    expect(() => compileMechanics({ ...graph, interpretations: wrongPolicy }, compiledInput(draft))).toThrow("not allowed");
  });

  it("rejects engine policy outside gameplay mechanics", () => {
    const graph = graphFor(["场景：\n▶钥匙：桌上有一把钥匙。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "template-fixture" });
    const plotFact = structuredClone(draft.interpretations);
    plotFact[0]!.claim.domain = "plot_fact";
    plotFact[0]!.claim.path = "plot.key";
    expect(() => compileMechanics({ ...graph, interpretations: plotFact }, compiledInput(draft))).toThrow("not a gameplay mechanic");
  });

  it("creates draft scene, clue, approved interpretation, and observe-only mechanic from explicit structure", () => {
    const graph = graphFor(["场景：\n普通散文不应成为线索。\n▶钥匙：桌上有一把钥匙。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "template-fixture" });
    expect(draft.sceneCandidates).toHaveLength(1);
    expect(draft.clueCandidates).toHaveLength(1);
    expect(draft.interpretations[0]?.review).toMatchObject({ reviewerKind: "approved_policy", policyId: MARKED_ITEM_OBSERVATION_POLICY_ID });
    const mechanism = draft.mechanicsIR?.discoveryMethods[0]!;
    expect(mechanism).toMatchObject({ action: "observe", target: "scene", check: { kind: "none" } });
    expect(mechanism.onSuccess).toEqual([{ kind: "discover_clue", clueId: draft.clueCandidates[0]?.id }]);
    expect(draft.readiness).toMatchObject({ status: "draft_only" });
    expect(draft.readiness.blockingCodes).toEqual(["unresolved_scene_candidates", "missing_entry_scene", "missing_ending_rules", "missing_connection_topology"]);
  });

  it("does not turn paragraphs, nameless items, or unscoped items into clues", () => {
    const paragraphOnly = compileDeterministicTemplates(graphFor(["场景：\n普通散文。"]), { moduleId: "template-fixture" });
    expect(paragraphOnly.clueCandidates).toEqual([]);
    const nameless = compileDeterministicTemplates(graphFor(["场景：\n▶：无名正文。"]), { moduleId: "template-fixture" });
    expect(nameless.clueCandidates).toEqual([]);
    expect(nameless.readiness.unresolvedStatementIds).not.toEqual([]);
    const unscoped = compileDeterministicTemplates(graphFor(["▶钥匙：正文。"]), { moduleId: "template-fixture" });
    expect(unscoped.clueCandidates).toEqual([]);
    expect(unscoped.readiness.unresolvedStatementIds).not.toEqual([]);
  });

  it("uses evidence-based IDs for duplicate text and remains stable after unrelated insertion", () => {
    const duplicate = compileDeterministicTemplates(graphFor(["场景：\n▶钥匙：正文。\n▶钥匙：正文。"]), { moduleId: "template-fixture" });
    expect(duplicate.clueCandidates).toHaveLength(2);
    expect(duplicate.clueCandidates[0]?.id).not.toBe(duplicate.clueCandidates[1]?.id);
    const { document, blocks } = documentAndBlocks(["场景：\n▶无关：正文。\n▶钥匙：正文。"]);
    const first = compileDeterministicTemplates(buildSourceFactGraph(document, blocks.filter((block) => block.kind !== "marked_item" || block.text.startsWith("钥匙"))), { moduleId: "template-fixture" });
    const withUnrelated = compileDeterministicTemplates(buildSourceFactGraph(document, blocks), { moduleId: "template-fixture" });
    expect(withUnrelated.clueCandidates.find((clue) => clue.displayName === "钥匙")?.id).toBe(first.clueCandidates[0]?.id);
  });

  it("keeps every generated interpretation tied to exact source statement evidence", () => {
    const graph = graphFor(["场景：\n▶钥匙：正文。"]);
    const draft = compileDeterministicTemplates(graph, { moduleId: "template-fixture" });
    const statements = new Map(graph.statements.map((statement) => [statement.id, statement]));
    for (const interpretation of draft.interpretations) {
      for (const statementId of interpretation.sourceStatementIds) {
        const statement = statements.get(statementId);
        if (!statement) throw new Error(`generated interpretation references missing statement: ${statementId}`);
        expect(interpretation.claim.evidenceRefs).toContain(statement.evidenceRefId);
      }
    }
  });

  it("does not import world-model, runtime, dataset, or ModuleData loaders", () => {
    const imports = scanImports(readFileSync("src/compiler/deterministic-template-compiler.ts", "utf8"));
    for (const forbidden of ["world-model-loader", "cthulhu-dataset", "game-session", "module-data-runtime-loader", "mythos-module"]) {
      expect(imports.some((entry) => importPointsTo(entry.path, forbidden))).toBe(false);
    }
  });
});
