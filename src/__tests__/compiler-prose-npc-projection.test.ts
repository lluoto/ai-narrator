import { describe, expect, it } from "bun:test";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { applyModuleCompileHints, resolveDraftModule } from "../compiler/compile-hint-resolution";
import { buildCompilerHintProposalRequestEnvelope, compileGroundedHintProposals } from "../compiler/compiler-hint-proposals";
import { projectResolvedCompilerArtifact, validateCanonicalCompilerModuleProjection, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { buildCompilerQuestionQueue, parseCompilerHintValue, validateCompilerQuestionQueue, withQueueHash, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { compiledMechanicsAction, GameSession } from "../api/game-session";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { restoreCompilerArtifact, type ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import type { CompilerHintCitation } from "../compiler/compiler-question-queue";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";

const PAGES = [
  "Dock:\nCaptain Mira and Dr. Hale wait beside the launch.\nExit:\nThe road leaves town.",
];

function graphFor(pages = PAGES) {
  const document = createSyntheticDocumentIR(pages, "prose-npc-projection");
  return buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
}

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
    reason: "strict prose NPC fixture",
  };
}

function closedHints(prepared: PreparedCompilerApiResult, dockRole: "playable_scene" | "other" = "playable_scene"): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const dock = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Dock"))!;
  const exit = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit"))!;
  const question = (kind: CompilerQuestion["kind"], subject?: string) => queue.questions.find((candidate) => candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject))!;
  const dockAnchor = draft.proseNpcAnchors.find((anchor) => {
    const paragraph = prepared.artifact.payload.graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
    return paragraph?.text.includes("Mira");
  })!;
  return {
    schemaVersion: "1.3.0",
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...queue.questions.filter((candidate) => candidate.kind === "scene_role").map((candidate) => answer(candidate, { role: candidate.subjectCandidateId === dock.id ? dockRole : "playable_scene" })),
      answer(question("entry_scene"), { sceneCandidateId: dock.id }),
      answer(question("connection_topology", dock.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "dock_exit" }] }),
      answer(question("connection_topology", exit.id), { connections: [] }),
      answer(question("ending_rule"), { declarations: [{ endingId: "leave", spec: { kind: "ending_rule", id: "rule_leave", priority: 1, when: { kind: "scene_visited", sceneId: exit.id }, effects: [{ kind: "end_game", endingId: "leave" }] } }] }),
      ...draft.proseNpcAnchors.map((anchor) => answer(question("npc_binding", anchor.id), {
        proseAnchorId: anchor.id,
        presentNpcs: anchor.id === dockAnchor.id ? [{ nameQuote: "Mira" }, { nameQuote: "Hale" }] : [],
      })),
    ],
  };
}

async function preparedFixture(): Promise<PreparedCompilerApiResult> {
  const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "prose-npc-projection", sourceDescriptor: "prose-npc-projection", pages: PAGES });
  if (prepared.status === "refused") throw new Error(prepared.message);
  return prepared;
}

async function resolvedFixture(): Promise<ResolvedCompilerArtifactPayload> {
  const prepared = await preparedFixture();
  const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, closedHints(prepared));
  if (resolved.status === "refused") throw new Error(resolved.message);
  return resolved.artifact.payload as ResolvedCompilerArtifactPayload;
}

async function freshProcessNpcProof(root: string, sessionId: string, bundleId: string): Promise<{ names: string[]; npcCount: number }> {
  const child = Bun.spawn([process.execPath, "src/__tests__/compiler-prose-npc-restart-child.ts", root, sessionId, bundleId], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`fresh prose NPC child process failed: ${stderr || stdout}`);
  const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("fresh prose NPC child process did not return JSON");
  return JSON.parse(line) as { names: string[]; npcCount: number };
}

function presentation(payload: Awaited<ReturnType<typeof resolvedFixture>>): ModuleDataPresentationMetadata {
  return {
    module: { title: "Prose NPC fixture", version: "1", ruleset: "cosmic-horror", era: "test", summary: "test", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: `scene:${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: `connection:${connection.id}` }])),
    clues: {},
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((ending) => [ending.effects.find((effect) => effect.kind === "end_game")!.endingId, { name: ending.id, description: `ending:${ending.id}`, conditions: ["test"] }])),
  };
}

describe("prose NPC compiler projection", () => {
  it("anchors ordinary heading-scoped paragraphs for explicit NPC binding", () => {
    const document = createSyntheticDocumentIR([
      "Dock:\nCaptain Mira and Dr. Hale wait beside the launch.",
    ], "prose-npc-red");
    const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
    const draft = compileDeterministicTemplates(graph, { moduleId: "prose-npc-red" });

    expect(draft.proseNpcAnchors).toHaveLength(1);
    expect(draft.proseNpcAnchors[0]).toMatchObject({ status: "candidate" });
  });

  it("creates one anchor-only NPC question with fixed heading and paragraph evidence", () => {
    const graph = graphFor();
    const draft = compileDeterministicTemplates(graph, { moduleId: "prose-npc-projection" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const anchor = draft.proseNpcAnchors[0]!;
    const question = queue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id)!;
    expect(question.severity).toBe("draft_warning");
    expect(question.candidateIds).toEqual([anchor.id]);
    expect(question.allowedCandidateIds).toEqual([anchor.id]);
    expect(question.sourceStatementIds).toEqual([anchor.headingStatementId, anchor.paragraphStatementId].sort());
    expect(question.evidenceRefs).toEqual(question.sourceStatementIds.map((id) => graph.statements.find((statement) => statement.id === id)!.evidenceRefId));
    expect(question.prompt).toContain("empty presentNpcs array explicitly");
    const alteredQuestion = queue.questions.map((candidate) => candidate.id === question.id ? { ...candidate, allowedCandidateIds: ["forged_anchor"] } : candidate);
    const staleHashTampered = { ...structuredClone(queue), questions: alteredQuestion };
    expect(() => validateCompilerQuestionQueue(graph, staleHashTampered)).toThrow("queueHash");
    const tampered = withQueueHash(staleHashTampered);
    expect(() => buildCompilerHintProposalRequestEnvelope(graph, tampered)).toThrow("unknown_candidate_catalog_entry");
  });

  it("accepts multiple source-exact quotes and an explicit empty binding, while rejecting forged, cross-anchor, duplicate, and oversized values", () => {
    const graph = graphFor();
    const draft = compileDeterministicTemplates(graph, { moduleId: "prose-npc-projection" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const dock = draft.proseNpcAnchors.find((anchor) => graph.statements.find((statement) => statement.id === anchor.paragraphStatementId)!.text.includes("Mira"))!;
    const exit = draft.proseNpcAnchors.find((anchor) => anchor.id !== dock.id)!;
    const dockQuestion = queue.questions.find((question) => question.kind === "npc_binding" && question.subjectCandidateId === dock.id)!;
    const exitQuestion = queue.questions.find((question) => question.kind === "npc_binding" && question.subjectCandidateId === exit.id)!;
    const parsed = parseCompilerHintValue(dockQuestion, { proseAnchorId: dock.id, presentNpcs: [{ nameQuote: "Mira" }, { nameQuote: "Hale" }] }, graph);
    expect(parsed).toMatchObject({ kind: "npc_binding", proseAnchorId: dock.id, presentNpcs: [{ nameQuote: "Mira" }, { nameQuote: "Hale" }] });
    expect(parseCompilerHintValue(exitQuestion, { proseAnchorId: exit.id, presentNpcs: [] }, graph)).toMatchObject({ kind: "npc_binding", presentNpcs: [] });
    expect(() => parseCompilerHintValue(dockQuestion, { proseAnchorId: exit.id, presentNpcs: [] }, graph)).toThrow("unallowed prose NPC anchor");
    expect(() => parseCompilerHintValue(dockQuestion, { proseAnchorId: dock.id, presentNpcs: [{ nameQuote: "fabricated" }] }, graph)).toThrow("nameQuote");
    expect(() => parseCompilerHintValue(dockQuestion, { proseAnchorId: dock.id, presentNpcs: [{ nameQuote: "Mira" }, { nameQuote: "Mira" }] }, graph)).toThrow("duplicate deterministic NPC ID");
    expect(() => parseCompilerHintValue(dockQuestion, { proseAnchorId: dock.id, presentNpcs: Array.from({ length: 33 }, () => ({ nameQuote: "Mira" })) }, graph)).toThrow("at most 32");
  });

  it("accepts only NPC proposals whose claim keys and citations bind the selected quote", () => {
    const graph = graphFor();
    const draft = compileDeterministicTemplates(graph, { moduleId: "prose-npc-projection" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const anchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)!.text.includes("Mira"))!;
    const sceneRole = queue.questions.find((candidate) => candidate.kind === "scene_role" && candidate.subjectCandidateId === anchor.sceneCandidateId)!;
    const workingQueue = applyModuleCompileHints(graph, queue, {
      schemaVersion: "2.3.0",
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [answer(sceneRole, { role: "playable_scene" })],
    });
    const question = workingQueue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id)!;
    const paragraph = graph.statements.find((statement) => statement.id === anchor.paragraphStatementId)!;
    const batch = (citations: CompilerHintCitation[]) => ({ schemaVersion: "1.0.0" as const, moduleId: workingQueue.moduleId, documentHash: workingQueue.documentHash, sourceGraphIdentity: workingQueue.sourceGraphIdentity, queueHash: workingQueue.queueHash, proposalId: "prose-npc-proposal", proposals: [{ questionId: question.id, kind: "npc_binding" as const, value: { proseAnchorId: anchor.id, presentNpcs: [{ nameQuote: "Mira", dialogueMethods: [] }] }, citations }] });
    const good = compileGroundedHintProposals(graph, workingQueue, batch([{ claimKey: `npc_binding:${anchor.id}:0`, statementId: paragraph.id, quote: "Mira" }]), { policyId: "trusted-prose-npc", rightsStatus: "user_provided" });
    expect(good.accepted).toHaveLength(1);
    expect(good.hints.resolutions[0]?.audit?.citations).toEqual([{ claimKey: `npc_binding:${anchor.id}:0`, statementId: paragraph.id, quote: "Mira" }]);
    const wrongQuote = compileGroundedHintProposals(graph, workingQueue, batch([{ claimKey: `npc_binding:${anchor.id}:0`, statementId: paragraph.id, quote: "Captain" }]), { policyId: "trusted-prose-npc", rightsStatus: "user_provided" });
    expect(wrongQuote.rejected[0]?.code).toBe("invalid_audit");
    const foreign = compileGroundedHintProposals(graph, workingQueue, batch([{ claimKey: `npc_binding:${anchor.id}:0`, statementId: exitQuestionId(graph, question), quote: "road" }]), { policyId: "trusted-prose-npc", rightsStatus: "user_provided" });
    expect(foreign.rejected[0]?.code).toBe("foreign_statement");
  });

  it("keeps prose NPC bindings as closed-world symbols and projects exact names, full paragraphs, scene IDs, and auditable origins", async () => {
    const payload = await resolvedFixture();
    expect(payload.mechanicsIR.symbols.npcIds).toEqual(payload.proseNpcBindings.map((binding) => binding.npcId).sort());
    const result = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (result.status === "refused") throw new Error(result.message);
    expect(result.module.npcs.map((npc) => npc.name).sort()).toEqual(["Hale", "Mira"]);
    expect(result.module.npcs.every((npc) => npc.description === "Captain Mira and Dr. Hale wait beside the launch.")).toBe(true);
    const dock = result.module.scenes.find((scene) => scene.name.startsWith("Dock"))!;
    expect(dock.npcIds).toEqual(result.module.npcs.map((npc) => npc.id).sort());
    const mira = result.module.npcs.find((npc) => npc.name === "Mira")!;
    expect(result.sourceMap.npcs[mira.id]!.fields.name).toMatchObject({ kind: "resolved_question", quotes: [{ quote: "Mira" }] });
    expect(result.sourceMap.npcs[mira.id]!.fields.description).toMatchObject({ kind: "source_exact" });
    const nameOrigin = result.sourceMap.npcs[mira.id]!.fields.name;
    if (nameOrigin.kind !== "resolved_question") throw new Error("expected NPC name resolved-question origin");
    const tampered = structuredClone(result);
    tampered.module.npcs[0]!.name = "forged";
    expect(validateCanonicalCompilerModuleProjection(payload, tampered)).toMatchObject({ status: "refused", code: "PRESENTATION_METADATA_INVALID" });

    const npcScene = result.module.scenes.find((scene) => scene.id === mira.sceneId)!;
    const otherScene = result.module.scenes.find((scene) => scene.id !== mira.sceneId)!;
    const canonicalTampering = [
      (() => { const value = structuredClone(result); value.module.scenes.find((scene) => scene.id === npcScene.id)!.npcIds = []; return value; })(),
      (() => { const value = structuredClone(result); delete (value.module.scenes.find((scene) => scene.id === npcScene.id)! as { npcIds?: string[] }).npcIds; return value; })(),
      (() => { const value = structuredClone(result); value.module.npcs.find((npc) => npc.id === mira.id)!.sceneId = otherScene.id; return value; })(),
      (() => { const value = structuredClone(result); (value.sourceMap.npcs[mira.id]!.fields.name as any).quotes = [{ statementId: nameOrigin.quotes[0]!.statementId, quote: "forged" }]; return value; })(),
      (() => { const value = structuredClone(result); value.sourceMap.npcs[mira.id]!.fields.name = { kind: "artifact", artifactPath: "forged" }; return value; })(),
      (() => { const value = structuredClone(result); value.sourceMap.scenes[npcScene.id]!.fields.npcIds = { kind: "artifact", artifactPath: "forged" }; return value; })(),
    ];
    for (const value of canonicalTampering) {
      expect(validateCanonicalCompilerModuleProjection(payload, value)).toMatchObject({ status: "refused", code: "PRESENTATION_METADATA_INVALID" });
    }
  });

  it("fails closed when a prose binding belongs to a non-playable scene and leaves no-NPC sources empty", async () => {
    const prepared = await preparedFixture();
    const resolved = resolveDraftModule(prepared.artifact.payload.graph, prepared.artifact.payload.draft, prepared.artifact.payload.preparedQueue, closedHints(prepared, "other"));
    expect(resolved.readiness.status).toBe("draft_only");
    expect(resolved.readiness.blockingCodes).toContain("invalid_npc_binding_scene");
    const noNpcGraph = graphFor(["Empty heading only:"]);
    const noNpcDraft = compileDeterministicTemplates(noNpcGraph, { moduleId: "no-prose-npc" });
    expect(noNpcDraft.proseNpcAnchors).toEqual([]);
    expect(buildCompilerQuestionQueue(noNpcGraph, noNpcDraft).questions.some((question) => question.kind === "npc_binding")).toBe(false);
  });

  it("installs static compiled NPC presence from projection, while state follows the mechanics scene and summary remains module-wide", async () => {
    const payload = await resolvedFixture();
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const session = new GameSession("prose-npc-runtime", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, "investigator", "Ada");
    expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
    expect(session.getState().npcs.map((npc) => npc.name).sort()).toEqual(["Hale", "Mira"]);
    expect(session.getSummary().npcCount).toBe(2);
    const gate = payload.mechanicsIR.connections.find((connection) => connection.connectionId === "dock_exit")!;
    const moved = await session.act(compiledMechanicsAction(gate.id));
    expect(moved.state.npcs).toEqual([]);
    expect(session.getState().npcs).toEqual([]);
    expect(session.getSummary().npcCount).toBe(2);
  });

  it("refuses a forged NPC projection before any GameSession world write", async () => {
    const payload = await resolvedFixture();
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const forged = structuredClone(projection);
    const npcScene = forged.module.scenes.find((scene) => scene.npcIds.length > 0)!;
    npcScene.npcIds = [];
    const session = new GameSession("prose-npc-forged", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, "investigator", "Ada");
    const before = session.getState();
    const worldBefore = session.world.exportSnapshot();

    expect(session.loadCompiledModule(payload, forged).status).toBe("refused");
    expect(session.world.exportSnapshot()).toEqual(worldBefore);
    expect(session.getCompiledMechanicsState()).toBeNull();
    expect(session.getState()).toEqual(before);
  });

  it("keeps canonical NPC presence through a durable action response, fresh-session restore, and fresh child-process restore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prose-npc-restart-"));
    try {
      const prepared = await preparedFixture();
      const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, closedHints(prepared));
      if (resolved.status !== "resolved") throw new Error(resolved.message);
      if (resolved.artifact.stage !== "resolved") throw new Error("expected a resolved artifact");
      const restoredArtifact = restoreCompilerArtifact(resolved.artifact);
      if (restoredArtifact.status !== "restored" || restoredArtifact.stage !== "resolved") throw new Error("resolved artifact did not restore");
      const payload = restoredArtifact.payload;
      const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
      if (projection.status === "refused") throw new Error(projection.message);
      const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
      const saved = catalog.saveBundle(resolved.artifact, projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      // The test manually creates/replays the durable body; it is not a host
      // publication path and opts in explicitly rather than weakening stores.
      const snapshots = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots"), allowUncoordinatedTestWrites: true });
      const config = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
      const host = createCompiledDurableTestHost();
      const live = new GameSession("prose-npc-durable", "cosmic-horror", config, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", host.runtimeDependencies);
      expect(live.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
      const initial = host.snapshot(live);
      expect(snapshots.save(initial).status).toBe("ok");
      host.acknowledge(live, initial);
      const gate = payload.mechanicsIR.connections.find((connection) => connection.connectionId === "dock_exit")!;
      const committed = host.commit(live, compiledMechanicsAction(gate.id), "move-to-exit", 0, (snapshot) => {
        const savedSnapshot = snapshots.save(snapshot);
        if (savedSnapshot.status !== "ok") throw new Error(savedSnapshot.message);
      });
      expect(committed).toMatchObject({ status: "committed", generation: 1 });
      if (committed.status !== "committed" || !committed.snapshot) throw new Error("expected durable action snapshot");
      expect((committed.response.action as any).state.npcs).toEqual([]);
      expect((committed.response.summary as any).npcCount).toBe(2);
      const restoredHost = createCompiledDurableTestHost();
      const restored = new GameSession("prose-npc-durable", "cosmic-horror", config, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", restoredHost.runtimeDependencies);
      expect(restored.restoreCompiledSession(committed.snapshot, bundle.value).status).toBe("loaded");
      expect(restored.getState().npcs).toEqual([]);
      expect(restored.getSummary().npcCount).toBe(2);
      const fresh = await freshProcessNpcProof(dir, "prose-npc-durable", saved.value.id);
      expect(fresh).toEqual({ names: [], npcCount: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function exitQuestionId(graph: ReturnType<typeof graphFor>, question: CompilerQuestion): string {
  return graph.statements.find((statement) => statement.kind === "paragraph" && !question.sourceStatementIds.includes(statement.id))!.id;
}
