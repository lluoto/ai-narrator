import { describe, expect, it } from "bun:test";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, buildCompilerQuestionQueue, parseCompilerHintValue, validateModuleCompileHints, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { executeMechanicsAction, initialMechanicsState } from "../compiler/mechanics-execution";
import { projectResolvedCompilerArtifact, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { GameSession } from "../api/game-session";
import { compiledMechanicsAction } from "../api/game-session";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { allShellClueFactFacetResolutions, clueFactFacetRevelations } from "./helpers/clue-fact-facet-hints";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

function fixture() {
  const document = createSyntheticDocumentIR([
    "Dock:\nCaptain Mira waits beside the launch. On failure, the apparition inflicts SAN 0/1.\n▶Harbor Ledger: It records the launch manifest.\nExit:",
  ], "npc-dialogue-discovery");
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const draft = compileDeterministicTemplates(graph, { moduleId: "npc-dialogue-discovery" });
  const queue = buildCompilerQuestionQueue(graph, draft);
  const anchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("Mira"))!;
  const clue = draft.clueCandidates.find((candidate) => candidate.sceneCandidateId === anchor.sceneCandidateId)!;
  const question = queue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id)!;
  return { graph, clue, anchor, question };
}

describe("source-bound NPC dialogue discovery", () => {
  it("derives a talk/npc mechanism from a reviewed NPC binding instead of accepting caller target or location", () => {
    const { graph, clue, anchor, question } = fixture();
    const parsed = parseCompilerHintValue(question, {
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [{
          mechanismId: "ask_mira_about_manifest",
          clueCandidateId: clue.id,
          check: { kind: "skill", skill: "persuade", difficulty: "regular" },
          onSuccess: [{ kind: "discover_clue", clueId: clue.id }],
        }],
      }],
    }, graph);

    expect(parsed).toMatchObject({
      kind: "npc_binding",
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [{
          mechanismId: "ask_mira_about_manifest",
          clueId: clue.id,
          spec: { action: "talk", target: "npc", clueId: clue.id },
        }],
      }],
    });
    expect(() => parseCompilerHintValue(question, {
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [{
          mechanismId: "forged_location",
          clueCandidateId: clue.id,
          locationSceneCandidateId: anchor.sceneCandidateId,
          onSuccess: [{ kind: "discover_clue", clueId: clue.id }],
        }],
      }],
    }, graph)).toThrow("undeclared");
  });

  it("rejects legacy dialogue smuggling and distinguishes an unanswered binding from an explicit empty dialogueMethods array", () => {
    const { graph, clue, anchor, question } = fixture();
    const dialogueValue = {
      proseAnchorId: anchor.id,
      presentNpcs: [{ nameQuote: "Mira", dialogueMethods: [{ mechanismId: "ask_mira", clueCandidateId: clue.id, onSuccess: [{ kind: "discover_clue", clueId: clue.id }] }] }],
    };
    const legacy: ModuleCompileHints = {
      schemaVersion: "1.5.0",
      moduleId: "npc-dialogue-discovery",
      documentHash: graph.documentIdentity.documentHash,
      sourceGraphIdentity: buildCompilerQuestionQueue(graph, compileDeterministicTemplates(graph, { moduleId: "npc-dialogue-discovery" })).sourceGraphIdentity,
      resolutions: [answer(question, dialogueValue)],
    };
    expect(() => validateModuleCompileHints(buildCompilerQuestionQueue(graph, compileDeterministicTemplates(graph, { moduleId: "npc-dialogue-discovery" })), legacy, graph)).toThrow("legacy hints cannot declare NPC dialogue mechanics");
    const missingDialogueDeclaration = { ...legacy, resolutions: [answer(question, { proseAnchorId: anchor.id, presentNpcs: [{ nameQuote: "Mira" }] })] };
    for (const schemaVersion of ["1.7.0", "1.8.0", "1.9.0", "2.0.0", "2.1.0", "2.2.0"] as const) {
      expect(() => validateModuleCompileHints(buildCompilerQuestionQueue(graph, compileDeterministicTemplates(graph, { moduleId: "npc-dialogue-discovery" })), { ...missingDialogueDeclaration, schemaVersion }, graph)).toThrow("must explicitly declare dialogueMethods");
    }
    expect(parseCompilerHintValue(question, { proseAnchorId: anchor.id, presentNpcs: [{ nameQuote: "Mira", dialogueMethods: [] }] }, graph)).toMatchObject({ presentNpcs: [{ dialogueMethodsDeclared: true, dialogueMethods: [] }] });
  });

  it("compiles a checked NPC talk method through the shared executor and removes every competing clue action after discovery", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "npc-dialogue-closed",
      sourceDescriptor: "npc-dialogue-closed",
      pages: ["Dock:\nCaptain Mira waits beside the launch. On failure, the apparition inflicts SAN 0/1.\n▶Harbor Ledger: It records the launch manifest.\nExit:"],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, closedHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const dialogue = payload.mechanicsIR.discoveryMethods.find((method) => method.id === "ask_mira_about_manifest")!;
    const alternative = payload.mechanicsIR.discoveryMethods.find((method) => method.id === "search_manifest")!;
    expect(dialogue).toMatchObject({ action: "talk", target: "npc", clueId: alternative.clueId, check: { kind: "skill", skill: "persuade", difficulty: "regular" } });
    expect(payload.mechanicsIR.symbols.npcIds).toEqual(payload.proseNpcBindings.map((binding) => binding.npcId).sort());
    expect(payload.analysisInput.discoveryLocations[dialogue.id]).toBe(payload.proseNpcBindings[0]!.sceneCandidateId);

    const before = initialMechanicsState(payload.analysisInput);
    const failed = executeMechanicsAction(payload.mechanicsIR, payload.analysisInput, before, { mechanismId: dialogue.id, outcome: "failure" }).state;
    const recovered = executeMechanicsAction(payload.mechanicsIR, payload.analysisInput, failed, { mechanismId: dialogue.id, outcome: "failback" }).state;
    expect(recovered.foundClueIds).toEqual([dialogue.clueId]);
    expect(() => executeMechanicsAction(payload.mechanicsIR, payload.analysisInput, recovered, { mechanismId: alternative.id, outcome: "success" })).toThrow("requested action is unavailable");

    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const session = new GameSession("npc-dialogue-session", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, "investigator", "Ada");
    expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
    expect(session.getCompiledAvailableActions().find((action) => action.mechanismId === dialogue.id)?.label).toBe("Talk to Mira");
    const random = Math.random;
    try {
      Math.random = () => 0;
      const action = await session.act(compiledMechanicsAction(dialogue.id));
      expect(action.error).toBeUndefined();
      expect(action.compiled?.state.foundClueIds).toEqual([dialogue.clueId]);
    } finally {
      Math.random = random;
    }
  });

  it("keeps NPC dialogue discovery and idempotent action results across a durable in-process restart", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "npc-dialogue-restart", sourceDescriptor: "npc-dialogue-restart", pages: ["Dock:\nCaptain Mira waits beside the launch. On failure, the apparition inflicts SAN 0/1.\n▶Harbor Ledger: It records the launch manifest.\nExit:"] });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, closedHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const dialogue = payload.mechanicsIR.discoveryMethods.find((method) => method.id === "ask_mira_about_manifest")!;
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const root = mkdtempSync(join(tmpdir(), "npc-dialogue-restart-"));
    const random = Math.random;
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = catalog.saveBundle(resolved.artifact, projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      // This restart assertion is a standalone snapshot/GameSession fixture.
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
      const host = createCompiledDurableTestHost();
      const session = new GameSession("npc-dialogue-restart", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, "investigator", "Ada", undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", host.runtimeDependencies);
      expect(session.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
      const initial = host.snapshot(session);
      if (snapshots.save(initial).status === "refused") throw new Error("initial snapshot failed");
      host.acknowledge(session, initial);
      Math.random = () => 0;
      const committed = host.commit(session, compiledMechanicsAction(dialogue.id), "talk-mira-once", 0, (snapshot) => {
        const written = snapshots.save(snapshot);
        if (written.status !== "ok") throw new Error(written.message);
      });
      expect(committed.status).toBe("committed");
      if (committed.status !== "committed") throw new Error("dialogue action did not commit");
      const restoredHost = createCompiledDurableTestHost();
      const restored = new GameSession("npc-dialogue-restart", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, undefined, undefined, undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", restoredHost.runtimeDependencies);
      expect(restored.restoreCompiledSession(committed.snapshot, bundle.value).status).toBe("loaded");
      expect(restored.getCompiledMechanicsState()?.state.foundClueIds).toEqual([dialogue.clueId]);
      expect(restored.getState().npcs.map((npc) => npc.name)).toEqual(["Mira"]);
      const duplicate = restoredHost.commit(restored, compiledMechanicsAction(dialogue.id), "talk-mira-once", 0, () => { throw new Error("duplicate must not persist"); });
      expect(duplicate).toMatchObject({ status: "duplicate", response: committed.response, generation: 1 });
    } finally {
      Math.random = random;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
    reason: "reviewed NPC dialogue fixture",
  };
}

function closedHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const dock = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Dock"))!;
  const exit = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit"))!;
  const clue = draft.clueCandidates.find((candidate) => candidate.sceneCandidateId === dock.id)!;
  const anchor = draft.proseNpcAnchors.find((candidate) => candidate.sceneCandidateId === dock.id)!;
  const question = (kind: CompilerQuestion["kind"], subject?: string) => queue.questions.find((candidate) => candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject))!;
  const npcQuestion = question("npc_binding", anchor.id);
  const failureStatement = prepared.artifact.payload.graph.statements.find((statement) => npcQuestion.sourceStatementIds.includes(statement.id) && statement.text.includes("On failure, the apparition inflicts SAN 0/1."))!;
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...allShellClueFactFacetResolutions(queue.questions, answer),
      ...queue.questions.filter((candidate) => candidate.kind === "scene_role").map((candidate) => answer(candidate, { role: "playable_scene" })),
      answer(question("entry_scene"), { sceneCandidateId: dock.id }),
      answer(question("connection_topology", dock.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "dock_exit" }] }),
      answer(question("connection_topology", exit.id), { connections: [] }),
      answer(question("ending_rule"), { declarations: [{ endingId: "leave", spec: { kind: "ending_rule", id: "rule_leave", priority: 1, when: { kind: "scene_visited", sceneId: exit.id }, effects: [{ kind: "end_game", endingId: "leave" }] } }] }),
      answer(question("discovery_method", clue.id), { clueCandidateId: clue.id, locationSceneCandidateId: dock.id, spec: { kind: "discovery_method", id: "search_manifest", clueId: clue.id, action: "search", target: "scene", targetId: dock.id, onSuccess: [{ kind: "discover_clue", clueId: clue.id }] } }),
      answer(npcQuestion, {
        proseAnchorId: anchor.id,
        presentNpcs: [{
          nameQuote: "Mira",
          dialogueMethods: [{
            mechanismId: "ask_mira_about_manifest",
            clueCandidateId: clue.id,
            check: { kind: "skill", skill: "persuade", difficulty: "regular" },
            onSuccess: [{ kind: "discover_clue", clueId: clue.id }],
            onFailure: [{ kind: "sanity_check", passLoss: { kind: "fixed", amount: 0 }, failLoss: { kind: "fixed", amount: 1 } }],
            actorEffectProvenance: [{
              effectPath: "onFailure[0]",
              eventSlot: { kind: "discovery", mechanismId: "ask_mira_about_manifest", outcome: "failure", effectIndex: 0 },
              source: { statementId: failureStatement.id, quote: failureStatement.text },
            }],
            failback: { maxFailures: 1, effects: [{ kind: "discover_clue", clueId: clue.id }] },
          }],
        }],
      }),
    ],
  };
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const facetRevelations = clueFactFacetRevelations(payload.clueFactFacetBindings);
  return {
    module: { title: "NPC dialogue", version: "1", ruleset: "cosmic-horror", era: "test", summary: "test", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: id }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: connection.id }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => [id, { findMethods: [], revelation: facetRevelations.get(id) ?? id, unlocks: [], importance: "bonus" as const }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((ending) => [ending.effects.find((effect) => effect.kind === "end_game")!.endingId, { name: ending.id, description: ending.id, conditions: [ending.id] }])),
  };
}
