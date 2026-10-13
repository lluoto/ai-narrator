import { describe, expect, it } from "bun:test";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, buildCompilerQuestionQueue, parseCompilerHintValue, validateModuleCompileHints, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { createResolvedCompilerArtifact, restoreCompilerArtifact, type ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { projectResolvedCompilerArtifact, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { compiledMechanicsAction, GameSession } from "../api/game-session";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { compileGroundedHintProposals } from "../compiler/compiler-hint-proposals";
import { applyModuleCompileHints } from "../compiler/compile-hint-resolution";
import { requestCompilerHintProposals } from "../api/compiler-hint-proposal-adapter";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

function fixture() {
  const document = createSyntheticDocumentIR([
    "Dock:\nCaptain Mira says the stone can take you outside.\nArchive:\n◆Moon Key: The key opens the exit.\nExit:",
  ], "npc-prose-dialogue-clue");
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const draft = compileDeterministicTemplates(graph, { moduleId: "npc-prose-dialogue-clue" });
  const queue = buildCompilerQuestionQueue(graph, draft);
  const anchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("Mira"))!;
  const question = queue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id)!;
  const paragraph = graph.statements.find((statement) => statement.id === anchor.paragraphStatementId)!;
  return { graph, anchor, question, paragraph };
}

const PAGES = [
  "Dock:\nCaptain Mira waits beside the launch and says the stone can take you outside.\nArchive:\n▶Dream Stone: The dream stone opens the exit.\nExit:",
];

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
    reason: "human-reviewed exact NPC relationship fact",
  };
}

function preparedQuestion(
  prepared: PreparedCompilerApiResult,
  kind: CompilerQuestion["kind"],
  subject?: string,
): CompilerQuestion {
  const question = prepared.artifact.payload.preparedQueue.questions.find((candidate) => candidate.kind === kind
    && (subject === undefined || candidate.subjectCandidateId === subject));
  if (!question) throw new Error(`missing ${kind} question`);
  return question;
}

function proseDialogueValue(anchorId: string, paragraphStatementId: string) {
  return {
    proseAnchorId: anchorId,
    presentNpcs: [{
      nameQuote: "Mira",
      dialogueMethods: [{
        mechanismId: "ask_mira_about_stone",
        relationshipEvidence: { statementId: paragraphStatementId, quote: "the stone can take you outside" },
      }],
    }],
  };
}

function automaticProseDialogueValue(anchorId: string, paragraphStatementId: string) {
  return {
    proseAnchorId: anchorId,
    presentNpcs: [{
      nameQuote: "Mira",
      dialogueMethods: [{
        relationshipEvidence: { statementId: paragraphStatementId, quote: "the stone can take you outside" },
      }],
    }],
  };
}

function automaticProseDialogueCitations(anchorId: string, paragraphStatementId: string) {
  return [
    { claimKey: `npc_binding:${anchorId}:0:name`, statementId: paragraphStatementId, quote: "Mira" },
    { claimKey: `npc_binding:${anchorId}:0:relationship:0`, statementId: paragraphStatementId, quote: "the stone can take you outside" },
  ];
}

function closedHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, graph, preparedQueue: queue } = prepared.artifact.payload;
  const scene = (name: string) => {
    const candidate = draft.sceneCandidates.find((entry) => entry.displayName.startsWith(name));
    if (!candidate) throw new Error(`missing ${name} scene`);
    return candidate;
  };
  const dock = scene("Dock");
  const archive = scene("Archive");
  const exit = scene("Exit");
  const item = draft.itemCandidates[0];
  const clue = draft.clueCandidates[0];
  const anchor = draft.proseNpcAnchors.find((candidate) => candidate.sceneCandidateId === dock.id);
  const paragraph = anchor && graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
  const itemName = item && graph.statements.find((statement) => statement.id === item.nameStatementId);
  if (!item || !clue || !anchor || !paragraph || !itemName) throw new Error(`missing exact fixture candidate: items=${draft.itemCandidates.length} clues=${draft.clueCandidates.length} anchors=${draft.proseNpcAnchors.length}`);
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => answer(question, { shell: (question.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [] })),
      ...queue.questions.filter((question) => question.kind === "scene_role").map((question) => answer(question, { role: "playable_scene" })),
      answer(preparedQuestion(prepared, "entry_scene"), { sceneCandidateId: dock.id }),
      answer(preparedQuestion(prepared, "connection_topology", dock.id), { connections: [{ toSceneCandidateId: archive.id, connectionId: "dock_archive" }] }),
      answer(preparedQuestion(prepared, "connection_topology", archive.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "archive_exit" }] }),
      answer(preparedQuestion(prepared, "connection_topology", exit.id), { connections: [] }),
      answer(preparedQuestion(prepared, "core_clue", clue.id), { clueCandidateId: clue.id, required: false }),
      answer(preparedQuestion(prepared, "item_binding", item.id), {
        itemCandidateId: item.id,
        itemType: "key",
        itemNameEvidence: { statementId: item.nameStatementId, quote: itemName.text },
      }),
      answer(preparedQuestion(prepared, "discovery_method", clue.id), {
        clueCandidateId: clue.id,
        locationSceneCandidateId: archive.id,
        spec: {
          kind: "discovery_method",
          id: "search_dream_stone",
          clueId: clue.id,
          action: "search",
          target: "item",
          targetId: item.id,
          onSuccess: [{ kind: "discover_clue", clueId: clue.id }, { kind: "acquire_item", itemId: item.id }],
        },
      }),
      answer(preparedQuestion(prepared, "npc_binding", anchor.id), proseDialogueValue(anchor.id, paragraph.id)),
      answer(preparedQuestion(prepared, "ending_rule"), {
        declarations: [
          {
            endingId: "escape_with_stone",
            spec: {
              kind: "ending_rule",
              id: "rule_escape_with_stone",
              priority: 1,
              when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "item_owned", itemId: item.id }] },
              effects: [{ kind: "end_game", endingId: "escape_with_stone" }],
            },
          },
          {
            endingId: "lost_without_stone",
            spec: {
              kind: "ending_rule",
              id: "rule_lost_without_stone",
              priority: 2,
              when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "not", predicate: { kind: "item_owned", itemId: item.id } }] },
              effects: [{ kind: "end_game", endingId: "lost_without_stone" }],
            },
          },
        ],
      }),
    ],
  };
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const facetRevelations = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    if (binding.shellAtoms.length || binding.findings.length) facetRevelations.set(binding.clueId, binding.shellAtoms.map((atom) => atom.quote).join("\n") || payload.draft.clueCandidates.find((candidate) => candidate.id === binding.clueId)!.displayName);
    for (const finding of binding.findings) facetRevelations.set(finding.clueId, finding.atoms.map((atom) => atom.quote).join("\n"));
  }
  return {
    module: { title: "NPC prose dialogue", version: "1", ruleset: "cosmic-horror", era: "test", summary: "test", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: id }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: connection.id }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => [id, { findMethods: [], revelation: facetRevelations.get(id) ?? id, unlocks: [], importance: "bonus" as const }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((ending) => [ending.effects.find((effect) => effect.kind === "end_game")!.endingId, { name: ending.id, description: ending.id, conditions: [ending.id] }])),
  };
}

async function preparedClosedPayload(): Promise<{ prepared: PreparedCompilerApiResult; payload: ResolvedCompilerArtifactPayload }> {
  const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "npc-prose-dialogue-closed", sourceDescriptor: "npc-prose-dialogue-closed", pages: PAGES });
  if (prepared.status === "refused") throw new Error(prepared.message);
  const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, closedHints(prepared));
  if (resolved.status === "refused") throw new Error(resolved.message);
  return { prepared, payload: resolved.artifact.payload as ResolvedCompilerArtifactPayload };
}

describe("source-exact NPC prose dialogue clues", () => {
  it("derives an independent talk clue from a human-reviewed anchor-paragraph relationship quote", () => {
    const { graph, anchor, question, paragraph } = fixture();
    const parsed = parseCompilerHintValue(question, {
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [{
          mechanismId: "ask_mira_about_stone",
          relationshipEvidence: { statementId: paragraph.id, quote: "the stone can take you outside" },
        }],
      }],
    }, graph);

    expect(parsed).toMatchObject({
      kind: "npc_binding",
      presentNpcs: [{
        dialogueMethods: [{
          kind: "prose",
          mechanismId: "ask_mira_about_stone",
          relationshipEvidence: { statementId: paragraph.id, quote: "the stone can take you outside" },
          spec: {
            action: "talk",
            target: "npc",
            onSuccess: [{ kind: "discover_clue" }],
          },
        }],
      }],
    });
  });

  it("rejects a forged relationship fact, cross-heading marked clue substitution, duplicate prose declaration, and stale document/module identity", () => {
    const { graph, anchor, question, paragraph } = fixture();
    const foreign = graph.statements.find((statement) => statement.id !== paragraph.id && statement.kind === "heading")!;
    const base = proseDialogueValue(anchor.id, paragraph.id);
    expect(() => parseCompilerHintValue(question, {
      ...base,
      presentNpcs: [{ ...base.presentNpcs[0], dialogueMethods: [{ ...base.presentNpcs[0]!.dialogueMethods[0], relationshipEvidence: { statementId: paragraph.id, quote: "invented escape route" } }] }],
    }, graph)).toThrow("relationship quote");
    expect(() => parseCompilerHintValue(question, {
      ...base,
      presentNpcs: [{ ...base.presentNpcs[0], dialogueMethods: [{ ...base.presentNpcs[0]!.dialogueMethods[0], relationshipEvidence: { statementId: foreign.id, quote: foreign.text } }] }],
    }, graph)).toThrow("anchor paragraph");
    expect(() => parseCompilerHintValue(question, {
      ...base,
      presentNpcs: [{
        ...base.presentNpcs[0],
        dialogueMethods: [{
          ...base.presentNpcs[0]!.dialogueMethods[0],
          onFailure: [{ kind: "acquire_item", itemId: "forged_item" }],
        }],
      }],
    }, graph)).toThrow("prose dialogue cannot declare failure effects");
    expect(() => parseCompilerHintValue(question, {
      ...base,
      presentNpcs: [{
        ...base.presentNpcs[0],
        dialogueMethods: [{
          ...base.presentNpcs[0]!.dialogueMethods[0],
          failback: { maxFailures: 1, effects: [{ kind: "discover_clue", clueId: "forged_clue" }] },
        }],
      }],
    }, graph)).toThrow("prose dialogue cannot declare failure effects");
    expect(() => parseCompilerHintValue(question, {
      ...base,
      presentNpcs: [{
        ...base.presentNpcs[0],
        dialogueMethods: [{ ...base.presentNpcs[0]!.dialogueMethods[0], clueCandidateId: "forged", locationSceneCandidateId: foreign.id }],
      }],
    }, graph)).toThrow("undeclared");
    expect(() => parseCompilerHintValue(question, {
      ...base,
      presentNpcs: [{
        ...base.presentNpcs[0],
        dialogueMethods: [
          base.presentNpcs[0]!.dialogueMethods[0],
          { ...base.presentNpcs[0]!.dialogueMethods[0], mechanismId: "ask_mira_again" },
        ],
      }],
    }, graph)).toThrow("duplicate prose dialogue clue declaration");

    const queue = buildCompilerQuestionQueue(graph, compileDeterministicTemplates(graph, { moduleId: "npc-prose-dialogue-clue" }));
    const current = {
      schemaVersion: "2.2.0" as const,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [answer(question, base)],
    };
    expect(() => validateModuleCompileHints(queue, { ...current, moduleId: "foreign-module" }, graph)).toThrow("hints do not match compiler question queue identity");
    expect(() => validateModuleCompileHints(queue, { ...current, documentHash: "foreign-document" }, graph)).toThrow("hints do not match compiler question queue identity");
    expect(() => validateModuleCompileHints(queue, { ...current, schemaVersion: "2.1.0" }, graph)).toThrow("legacy hints cannot declare prose NPC dialogue clues");
  });

  it("keeps a source-exact prose talk clue independent from search/acquire, projects it, and replays the canonical artifact", async () => {
    const { payload } = await preparedClosedPayload();
    const proseClue = payload.proseDialogueClues[0]!;
    const dialogue = payload.mechanicsIR.discoveryMethods.find((method) => method.id === proseClue.mechanismId)!;
    const search = payload.mechanicsIR.discoveryMethods.find((method) => method.id === "search_dream_stone")!;
    const itemId = payload.itemBindings[0]!.itemId;
    expect(payload.readiness.status).toBe("mechanically_closed");
    expect(payload.draft.clueCandidates).toHaveLength(1);
    expect(payload.mechanicsIR.symbols.clueIds).toEqual(expect.arrayContaining([proseClue.clueId, search.clueId]));
    expect(dialogue).toMatchObject({ action: "talk", target: "npc", targetId: proseClue.npcId, clueId: proseClue.clueId, onSuccess: [{ kind: "discover_clue", clueId: proseClue.clueId }] });
    expect(dialogue.onSuccess.some((effect) => effect.kind === "acquire_item")).toBe(false);
    expect(payload.analysisInput.discoveryLocations[dialogue.id]).toBe(proseClue.sceneCandidateId);
    const restored = restoreCompilerArtifact(createResolvedCompilerArtifact(payload));
    expect(restored.status).toBe("restored");

    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const projectedProse = projection.module.scenes.flatMap((scene) => scene.clues).find((clue) => clue.id === proseClue.clueId)!;
    expect(projectedProse).toMatchObject({ name: "the stone can take you outside", description: "the stone can take you outside" });
    const proseOrigin = projection.sourceMap.scenes[proseClue.sceneCandidateId]!.clues[proseClue.clueId]!.fields.name;
    expect(proseOrigin).toMatchObject({ kind: "resolved_question", questionIds: [proseClue.questionId], quotes: [{ statementId: proseClue.relationshipStatementId, quote: proseClue.relationshipQuote }] });

    const session = new GameSession("npc-prose-dialogue", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, "investigator", "Ada");
    expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
    const talked = await session.act(compiledMechanicsAction(dialogue.id));
    expect(talked.error).toBeUndefined();
    expect(talked.compiled?.state.foundClueIds).toContain(proseClue.clueId);
    expect(talked.compiled?.state.ownedItemIds).not.toContain(itemId);
    expect(session.getCompiledAvailableActions().some((action) => action.mechanismId === payload.mechanicsIR.connections.find((gate) => gate.connectionId === "dock_archive")!.id)).toBe(true);
    expect((await session.act(compiledMechanicsAction(payload.mechanicsIR.connections.find((gate) => gate.connectionId === "dock_archive")!.id))).error).toBeUndefined();
    expect(session.getCompiledAvailableActions().some((action) => action.mechanismId === search.id)).toBe(true);
    const searched = await session.act(compiledMechanicsAction(search.id));
    expect(searched.error).toBeUndefined();
    expect(searched.compiled?.state.ownedItemIds).toContain(itemId);
    expect((await session.act(compiledMechanicsAction(payload.mechanicsIR.connections.find((gate) => gate.connectionId === "archive_exit")!.id))).compiled?.state.terminalEndingId).toBe("escape_with_stone");

    const withoutStone = new GameSession("npc-prose-dialogue-without-stone", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, "investigator", "Bea");
    expect(withoutStone.loadCompiledModule(payload, projection).status).toBe("loaded");
    await withoutStone.act(compiledMechanicsAction(payload.mechanicsIR.connections.find((gate) => gate.connectionId === "dock_archive")!.id));
    expect((await withoutStone.act(compiledMechanicsAction(payload.mechanicsIR.connections.find((gate) => gate.connectionId === "archive_exit")!.id))).compiled?.state.terminalEndingId).toBe("lost_without_stone");
  });

  it("retains the independently derived prose clue across a durable compiled-session restart", async () => {
    const { payload } = await preparedClosedPayload();
    const proseClue = payload.proseDialogueClues[0]!;
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const root = mkdtempSync(join(tmpdir(), "npc-prose-dialogue-restart-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = catalog.saveBundle(createResolvedCompilerArtifact(payload), projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      // This restart assertion is a standalone snapshot/GameSession fixture.
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
      const host = createCompiledDurableTestHost();
      const session = new GameSession("npc-prose-dialogue-restart", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, "investigator", "Ada", undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", host.runtimeDependencies);
      expect(session.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
      const initial = host.snapshot(session);
      expect(snapshots.save(initial).status).toBe("ok");
      host.acknowledge(session, initial);
      const committed = host.commit(session, compiledMechanicsAction(proseClue.mechanismId), "talk-mira-prose-once", 0, (snapshot) => {
        const written = snapshots.save(snapshot);
        if (written.status !== "ok") throw new Error(written.message);
      });
      expect(committed.status).toBe("committed");
      if (committed.status !== "committed") throw new Error("prose dialogue action did not commit");
      const restoredHost = createCompiledDurableTestHost();
      const restored = new GameSession("npc-prose-dialogue-restart", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, undefined, undefined, undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", restoredHost.runtimeDependencies);
      expect(restored.restoreCompiledSession(committed.snapshot, bundle.value).status).toBe("loaded");
      expect(restored.getCompiledMechanicsState()?.state.foundClueIds).toContain(proseClue.clueId);
      expect(restored.getCompiledMechanicsState()?.state.ownedItemIds).toEqual([]);
      expect(restored.getState().npcs.map((npc) => npc.name)).toEqual(["Mira"]);
      expect(restored.getCompiledAvailableActions().some((action) => action.mechanismId === payload.mechanicsIR.connections.find((gate) => gate.connectionId === "dock_archive")!.id)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not pretend a terminal-priority scene leaves an action window for its NPC prose dialogue", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "npc-prose-dialogue-terminal",
      sourceDescriptor: "npc-prose-dialogue-terminal",
      pages: ["Dock:\nExit:\nCaptain Mira waits beside the launch and says the stone can take you outside."],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { draft, graph, preparedQueue: queue } = prepared.artifact.payload;
    const dock = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Dock"))!;
    const exit = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit"))!;
    const anchor = draft.proseNpcAnchors.find((candidate) => candidate.sceneCandidateId === exit.id)!;
    const paragraph = graph.statements.find((statement) => statement.id === anchor.paragraphStatementId)!;
    const hints: ModuleCompileHints = {
      schemaVersion: "2.2.0",
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [
        ...queue.questions.filter((question) => question.kind === "scene_role").map((question) => answer(question, { role: "playable_scene" })),
        answer(preparedQuestion(prepared, "entry_scene"), { sceneCandidateId: dock.id }),
        answer(preparedQuestion(prepared, "connection_topology", dock.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "dock_exit" }] }),
        answer(preparedQuestion(prepared, "connection_topology", exit.id), { connections: [] }),
        answer(preparedQuestion(prepared, "ending_rule"), {
          declarations: [{
            endingId: "terminal_exit",
            spec: { kind: "ending_rule", id: "rule_terminal_exit", priority: 1, when: { kind: "scene_visited", sceneId: exit.id }, effects: [{ kind: "end_game", endingId: "terminal_exit" }] },
          }],
        }),
        answer(preparedQuestion(prepared, "npc_binding", anchor.id), proseDialogueValue(anchor.id, paragraph.id)),
      ],
    };
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const dialogue = payload.proseDialogueClues[0]!;
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const session = new GameSession("npc-prose-dialogue-terminal", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, "investigator", "Ada");
    expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
    const traverse = payload.mechanicsIR.connections.find((gate) => gate.connectionId === "dock_exit")!;
    expect((await session.act(compiledMechanicsAction(traverse.id))).compiled?.state.terminalEndingId).toBe("terminal_exit");
    expect(session.getCompiledAvailableActions()).toEqual([]);
    expect((await session.act(compiledMechanicsAction(dialogue.mechanismId))).error?.code).toBe("compiled_terminal");
  });

  it("keeps automatic prose NPC dialogue positive bindings closed until the same heading is answered playable", () => {
    const { graph, anchor, question, paragraph } = fixture();
    const queue = buildCompilerQuestionQueue(graph, compileDeterministicTemplates(graph, { moduleId: "npc-prose-dialogue-clue" }));
    const result = compileGroundedHintProposals(graph, queue, {
      schemaVersion: "1.0.0",
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      queueHash: queue.queueHash,
      proposalId: "automatic-prose-dialogue-injection",
      proposals: [{
        questionId: question.id,
        kind: "npc_binding",
        value: automaticProseDialogueValue(anchor.id, paragraph.id),
        citations: automaticProseDialogueCitations(anchor.id, paragraph.id),
      }],
    }, { policyId: "automatic-policy", rightsStatus: "user_provided" });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toMatchObject([{ questionId: question.id, code: "npc_binding_requires_playable_scene" }]);
  });

  it("runs an automatic prose dialogue proposal through adapter, resolution, projection, and a live talk action", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "npc-prose-dialogue-automatic",
      sourceDescriptor: "npc-prose-dialogue-automatic",
      pages: PAGES,
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, draft, preparedQueue } = prepared.artifact.payload;
    const anchor = draft.proseNpcAnchors.find((candidate) => candidate.sceneCandidateId === draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Dock"))?.id);
    const paragraph = anchor && graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
    if (!anchor || !paragraph) throw new Error("missing automatic prose NPC anchor");
    const allHuman = closedHints(prepared);
    const prerequisites: ModuleCompileHints = {
      ...allHuman,
      resolutions: allHuman.resolutions.filter((resolution) => resolution.kind !== "npc_binding"),
    };
    const queueWithPlayableScene = applyModuleCompileHints(graph, preparedQueue, prerequisites);
    const npcQuestion = queueWithPlayableScene.questions.find((question) => question.kind === "npc_binding" && question.subjectCandidateId === anchor.id);
    if (!npcQuestion) throw new Error("missing automatic NPC queue question");
    const proposal = {
      questionId: npcQuestion.id,
      kind: "npc_binding",
      value: automaticProseDialogueValue(anchor.id, paragraph.id),
      citations: automaticProseDialogueCitations(anchor.id, paragraph.id),
    };
    const automated = await requestCompilerHintProposals({
      graph,
      queue: queueWithPlayableScene,
      llm: { chat: async () => JSON.stringify({ proposals: [proposal] }) },
      policy: { policyId: "automatic-prose-dialogue-policy", rightsStatus: "user_provided" },
      producer: { providerFingerprint: "fake-provider", modelFingerprint: "fake-model" },
      limits: { maxQuestionsPerRequest: 8, maxRequestsPerRound: 1 },
    });
    expect(automated.accepted).toContainEqual(expect.objectContaining({ questionId: npcQuestion.id }));
    expect(automated.hints.schemaVersion).toBe(MODULE_COMPILE_HINTS_SCHEMA_VERSION);
    expect(automated.hints.resolutions).toMatchObject([{
      questionId: npcQuestion.id,
      reviewerKind: "approved_policy",
      audit: { schemaVersion: "1.2.0", citations: proposal.citations },
    }]);
    const automaticResolution = automated.hints.resolutions[0]!;
    const parsed = parseCompilerHintValue(npcQuestion, automaticResolution.value, graph);
    if (parsed.kind !== "npc_binding") throw new Error("automatic NPC proposal did not parse as npc_binding");
    expect(parsed.presentNpcs[0]!.dialogueMethods[0]!.mechanismId).not.toBe("ask_mira_about_stone");
    const merged: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: preparedQueue.moduleId,
      documentHash: preparedQueue.documentHash,
      sourceGraphIdentity: preparedQueue.sourceGraphIdentity,
      resolutions: [...prerequisites.resolutions, ...automated.hints.resolutions],
    };
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, merged);
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const proseClue = payload.proseDialogueClues[0]!;
    const dialogue = payload.mechanicsIR.discoveryMethods.find((method) => method.id === proseClue.mechanismId)!;
    expect(dialogue).toMatchObject({ action: "talk", target: "npc", targetId: proseClue.npcId, onSuccess: [{ kind: "discover_clue", clueId: proseClue.clueId }] });
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const automaticNpc = payload.proseNpcBindings.find((binding) => binding.npcId === proseClue.npcId)!;
    expect(automaticNpc.claimKey).toBe(`npc_binding:${anchor.id}:0:name`);
    expect(proseClue.claimKey).toBe(`npc_binding:${anchor.id}:0:relationship:0`);
    expect(projection.sourceMap.npcs[automaticNpc.npcId]!.fields.name).toMatchObject({
      kind: "resolved_question",
      claimKeys: [`npc_binding:${anchor.id}:0:name`],
      quotes: [{ statementId: paragraph.id, quote: "Mira" }],
    });
    expect(projection.sourceMap.scenes[proseClue.sceneCandidateId]!.clues[proseClue.clueId]!.fields.name).toMatchObject({
      kind: "resolved_question",
      claimKeys: [`npc_binding:${anchor.id}:0:relationship:0`],
    });
    const session = new GameSession("npc-prose-dialogue-automatic", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, "investigator", "Ada");
    expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
    expect(session.getCompiledAvailableActions().some((action) => action.mechanismId === dialogue.id)).toBe(true);
    const talked = await session.act(compiledMechanicsAction(dialogue.id));
    expect(talked.error).toBeUndefined();
    expect(talked.compiled?.state.foundClueIds).toContain(proseClue.clueId);
  });

  it("rejects automatic prose dialogue that is non-playable, cross-heading, unsafe, or insufficiently audited", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "npc-prose-dialogue-automatic-negative",
      sourceDescriptor: "npc-prose-dialogue-automatic-negative",
      pages: PAGES,
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { graph, draft, preparedQueue } = prepared.artifact.payload;
    const anchor = draft.proseNpcAnchors.find((candidate) => candidate.sceneCandidateId === draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Dock"))?.id);
    const paragraph = anchor && graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
    if (!anchor || !paragraph) throw new Error("missing automatic prose NPC anchor");
    const allHuman = closedHints(prepared);
    const prerequisites: ModuleCompileHints = { ...allHuman, resolutions: allHuman.resolutions.filter((resolution) => resolution.kind !== "npc_binding") };
    const playableQueue = applyModuleCompileHints(graph, preparedQueue, prerequisites);
    const question = playableQueue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id);
    if (!question) throw new Error("missing automatic NPC queue question");
    const value = automaticProseDialogueValue(anchor.id, paragraph.id);
    const citations = automaticProseDialogueCitations(anchor.id, paragraph.id);
    const automaticPolicy = { policyId: "automatic-policy", rightsStatus: "user_provided" } as const;
    const compile = (
      candidateValue: unknown,
      candidateCitations: unknown,
      policy: Parameters<typeof compileGroundedHintProposals>[3] = automaticPolicy,
    ) => compileGroundedHintProposals(graph, playableQueue, {
      schemaVersion: "1.0.0",
      moduleId: playableQueue.moduleId,
      documentHash: playableQueue.documentHash,
      sourceGraphIdentity: playableQueue.sourceGraphIdentity,
      queueHash: playableQueue.queueHash,
      proposalId: "automatic-prose-dialogue-negative",
      proposals: [{ questionId: question.id, kind: "npc_binding", value: candidateValue, citations: candidateCitations as never }],
    }, policy);
    const accepted = compile(value, citations);
    expect(accepted.accepted).toHaveLength(1);
    const foreign = graph.statements.find((statement) => statement.kind === "heading" && statement.id !== anchor.headingStatementId)!;
    const crossHeading = structuredClone(value);
    crossHeading.presentNpcs[0]!.dialogueMethods[0]!.relationshipEvidence = { statementId: foreign.id, quote: foreign.text };
    expect(compile(crossHeading, citations).rejected).toMatchObject([{ code: "unknown_hint_reference" }]);
    const nameAsRelationship = structuredClone(value);
    nameAsRelationship.presentNpcs[0]!.dialogueMethods[0]!.relationshipEvidence.quote = "Mira";
    expect(compile(nameAsRelationship, citations).rejected).toMatchObject([{ code: "invalid_relationship_quote" }]);
    const forgedRelationshipCitation = structuredClone(citations);
    forgedRelationshipCitation[1]!.quote = "Mira";
    expect(compile(value, forgedRelationshipCitation).rejected).toMatchObject([{ code: "invalid_audit" }]);
    expect(compile(value, [citations[0]!]).rejected).toMatchObject([{ code: "missing_claim_citation" }]);
    const malformedEncounter = {
      ...structuredClone(value),
      presentNpcs: [{ ...value.presentNpcs[0]!, encounter: { maxHp: 10, dodge: 0, fight: 0, npcDamage: { kind: "fixed", amount: 1 } } }],
    };
    expect(compile(malformedEncounter, citations).rejected).toMatchObject([{ code: "automatic_npc_encounter_not_allowed" }]);
    expect(compile(malformedEncounter, citations, {
      ...automaticPolicy,
      allowSourceExactNpcEncounters: true,
      producer: {
        providerFingerprint: "provider:test",
        modelFingerprint: "model:test",
        requestHash: "a".repeat(64),
        responseHash: "b".repeat(64),
      },
    }).rejected).toMatchObject([{ code: "invalid_hint_value" }]);
    for (const unsafeValue of [
      { ...structuredClone(value), presentNpcs: [{ ...value.presentNpcs[0]!, dialogueMethods: [{ ...value.presentNpcs[0]!.dialogueMethods[0]!, mechanismId: "forged_method" }] }] },
      { ...structuredClone(value), presentNpcs: [{ ...value.presentNpcs[0]!, dialogueMethods: [{ ...value.presentNpcs[0]!.dialogueMethods[0]!, check: { kind: "skill_check", skill: "spot_hidden" } }] }] },
      { ...structuredClone(value), presentNpcs: [{ ...value.presentNpcs[0]!, dialogueMethods: [{ ...value.presentNpcs[0]!.dialogueMethods[0]!, availability: { kind: "state_equals", key: "forged", value: true } }] }] },
      { ...structuredClone(value), presentNpcs: [{ ...value.presentNpcs[0]!, dialogueMethods: [{ ...value.presentNpcs[0]!.dialogueMethods[0]!, onSuccess: [{ kind: "acquire_item", itemId: "forged" }] }] }] },
      { ...structuredClone(value), presentNpcs: [{ ...value.presentNpcs[0]!, dialogueMethods: [{ ...value.presentNpcs[0]!.dialogueMethods[0]!, onFailure: [{ kind: "set_state", stateKey: "forged", value: true }] }] }] },
      { ...structuredClone(value), presentNpcs: [{ ...value.presentNpcs[0]!, dialogueMethods: [{ ...value.presentNpcs[0]!.dialogueMethods[0]!, failback: { maxFailures: 1, effects: [{ kind: "sanity_check", amount: 1 }] } }] }] },
      { ...structuredClone(value), presentNpcs: [{ ...value.presentNpcs[0]!, dialogueMethods: [{ clueCandidateId: "forged", mechanismId: "forged_method", onSuccess: [] }] }] },
    ]) expect(compile(unsafeValue, citations).rejected).toMatchObject([{ code: "invalid_hint_value" }]);
    const forgedAuditHints = structuredClone(accepted.hints);
    forgedAuditHints.resolutions[0]!.audit!.citations = [citations[0]!];
    expect(() => validateModuleCompileHints(playableQueue, forgedAuditHints, graph)).toThrow("does not cover every declaration");
    expect(() => validateModuleCompileHints(playableQueue, { ...accepted.hints, schemaVersion: "2.2.0" }, graph)).toThrow("cannot omit a prose NPC dialogue mechanismId");

    const dockScene = draft.sceneCandidates.find((scene) => scene.id === anchor.sceneCandidateId)!;
    const nonPlayableHints: ModuleCompileHints = {
      ...prerequisites,
      resolutions: prerequisites.resolutions.map((resolution) => resolution.kind === "scene_role" && resolution.questionId === preparedQueue.questions.find((candidate) => candidate.kind === "scene_role" && candidate.subjectCandidateId === dockScene.id)?.id
        ? answer(preparedQueue.questions.find((candidate) => candidate.id === resolution.questionId)!, { role: "other" })
        : resolution),
    };
    const nonPlayableQueue = applyModuleCompileHints(graph, preparedQueue, nonPlayableHints);
    const nonPlayableQuestion = nonPlayableQueue.questions.find((candidate) => candidate.id === question.id)!;
    const nonPlayable = await requestCompilerHintProposals({
      graph,
      queue: nonPlayableQueue,
      llm: { chat: async () => JSON.stringify({ proposals: [{ questionId: nonPlayableQuestion.id, kind: "npc_binding", value, citations }] }) },
      policy: { policyId: "automatic-prose-dialogue-policy", rightsStatus: "user_provided" },
      producer: { providerFingerprint: "fake-provider", modelFingerprint: "fake-model" },
      limits: { maxQuestionsPerRequest: 8, maxRequestsPerRound: 1 },
    });
    expect(nonPlayable.accepted).toEqual([]);
    expect(nonPlayable.rejected).toContainEqual(expect.objectContaining({ questionId: nonPlayableQuestion.id, code: "npc_binding_requires_playable_scene" }));
  });
});
