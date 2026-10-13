import { describe, expect, it } from "bun:test";
import { compiledMechanicsAction, GameSession } from "../api/game-session";
import { type ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { projectResolvedCompilerArtifact, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { replayMechanicsWitness } from "../compiler/mechanics-reachability";

const SOURCE_PAGES = [
  [
    "开场",
    "雨水敲打庄园铁门，调查者听见镜中传来低语。",
    "门厅",
    "门厅的油灯照亮通向档案室的走廊，墙上的挂钟停在午夜。",
    "请搜索或调查，发现如下物品：",
    "铜钥匙：钥匙背面刻着档案室的门牌号。",
    "梦境之石：石头会在梦中映出镜厅的位置，带着它才能识破出口的幻象。",
    "档案室",
    "泛黄卷宗堆满书架，尽头的门通往镜厅。",
    "镜厅",
    "镜面倒映着已经开启的后门，空气中弥漫冷雾。",
    "终局",
    "调查者若带着梦境之石穿过后门，便安全醒来；若未带着它离开，便永远困在镜中梦境。",
  ].join("\n"),
];

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 512, temperature: 0.7 };
const WITH_STONE_ENDING = "benchmark_escape_with_dream_stone";
const WITHOUT_STONE_ENDING = "benchmark_lost_without_dream_stone";

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
    reason: "one-time real-source benchmark declaration bound to this prepared queue",
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function scene(prepared: PreparedCompilerApiResult, name: string) {
  return required(prepared.artifact.payload.draft.sceneCandidates.find((candidate) => candidate.displayName === name), `scene candidate ${name}`);
}

function clue(prepared: PreparedCompilerApiResult, name: string) {
  return required(prepared.artifact.payload.draft.clueCandidates.find((candidate) => candidate.displayName === name), `clue candidate ${name}`);
}

function question(prepared: PreparedCompilerApiResult, kind: CompilerQuestion["kind"], subjectCandidateId?: string) {
  return required(prepared.artifact.payload.preparedQueue.questions.find((candidate) => candidate.kind === kind && (subjectCandidateId === undefined || candidate.subjectCandidateId === subjectCandidateId)), `${kind} question${subjectCandidateId ? ` for ${subjectCandidateId}` : ""}`);
}

/** Benchmark declarations are the only authored mechanics; all candidate IDs come from this prepared artifact. */
function benchmarkHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const opening = scene(prepared, "开场");
  const foyer = scene(prepared, "门厅");
  const archive = scene(prepared, "档案室");
  const mirror = scene(prepared, "镜厅");
  const ending = scene(prepared, "终局");
  const copperKey = clue(prepared, "铜钥匙");
  const dreamStone = clue(prepared, "梦境之石");
  const topology = (candidateId: string) => question(prepared, "connection_topology", candidateId);

  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...queue.questions.filter((candidate) => candidate.kind === "clue_fact_facets").map((candidate) => answer(candidate, { shell: (candidate.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [] })),
      ...draft.sceneCandidates.map((candidate) => answer(question(prepared, "scene_role", candidate.id), {
        role: candidate.id === ending.id ? "ending_section" : "playable_scene",
      })),
      answer(question(prepared, "entry_scene"), { sceneCandidateId: opening.id }),
      answer(topology(opening.id), { connections: [{ toSceneCandidateId: foyer.id, connectionId: "benchmark_opening_to_foyer" }] }),
      answer(topology(foyer.id), { connections: [{ toSceneCandidateId: archive.id, connectionId: "benchmark_foyer_to_archive" }] }),
      answer(topology(archive.id), { connections: [{ toSceneCandidateId: mirror.id, connectionId: "benchmark_archive_to_mirror" }] }),
      answer(topology(mirror.id), { connections: [] }),
      answer(topology(ending.id), { connections: [] }),
      answer(question(prepared, "core_clue", copperKey.id), { clueCandidateId: copperKey.id, required: false }),
      answer(question(prepared, "core_clue", dreamStone.id), { clueCandidateId: dreamStone.id, required: true }),
      answer(question(prepared, "discovery_method", copperKey.id), {
        clueCandidateId: copperKey.id,
        locationSceneCandidateId: foyer.id,
        spec: {
          kind: "discovery_method",
          id: "benchmark_find_copper_key",
          clueId: copperKey.id,
          action: "search",
          target: "scene",
          targetId: foyer.id,
          onSuccess: [{ kind: "discover_clue", clueId: copperKey.id }],
        },
      }),
      answer(question(prepared, "discovery_method", dreamStone.id), {
        clueCandidateId: dreamStone.id,
        locationSceneCandidateId: foyer.id,
        spec: {
          kind: "discovery_method",
          id: "benchmark_find_dream_stone",
          clueId: dreamStone.id,
          action: "search",
          target: "scene",
          targetId: foyer.id,
          onSuccess: [{ kind: "discover_clue", clueId: dreamStone.id }],
        },
      }),
      answer(question(prepared, "ending_rule"), {
        declarations: [
          {
            endingId: WITH_STONE_ENDING,
            spec: {
              kind: "ending_rule",
              id: "benchmark_rule_escape_with_dream_stone",
              priority: 10,
              when: { kind: "all", predicates: [{ kind: "clue_found", clueId: dreamStone.id }, { kind: "scene_visited", sceneId: mirror.id }] },
              effects: [{ kind: "end_game", endingId: WITH_STONE_ENDING }],
            },
          },
          {
            endingId: WITHOUT_STONE_ENDING,
            spec: {
              kind: "ending_rule",
              id: "benchmark_rule_lost_without_dream_stone",
              priority: 20,
              when: {
                kind: "all",
                predicates: [
                  { kind: "scene_visited", sceneId: mirror.id },
                  { kind: "not", predicate: { kind: "clue_found", clueId: dreamStone.id } },
                ],
              },
              effects: [{ kind: "end_game", endingId: WITHOUT_STONE_ENDING }],
            },
          },
        ],
      }),
    ],
  };
}

function sourceText(payload: Pick<ResolvedCompilerArtifactPayload, "graph">, statementId: string): string {
  return required(payload.graph.statements.find((statement) => statement.id === statementId), `source statement ${statementId}`).text;
}

function sourceParagraphForScene(payload: ResolvedCompilerArtifactPayload, sceneId: string): string {
  const candidate = required(payload.draft.sceneCandidates.find((sceneCandidate) => sceneCandidate.id === sceneId), `resolved scene ${sceneId}`);
  return required(
    payload.graph.statements.find((statement) => statement.kind === "paragraph" && statement.parentStatementId === candidate.headingStatementId),
    `source prose for ${sceneId}`,
  ).text;
}

function presentationMetadata(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const sourceProse = required(payload.graph.statements.find((statement) => statement.kind === "paragraph"), "source prose").text;
  const endingScene = required(payload.draft.sceneCandidates.find((candidate) => candidate.displayName === "终局"), "ending scene");
  const endingProse = sourceParagraphForScene(payload, endingScene.id);
  const endingIds = payload.mechanicsIR.endings.map((ending) => {
    const endGame = required(ending.effects.find((effect) => effect.kind === "end_game"), `end_game effect for ${ending.id}`);
    if (endGame.kind !== "end_game") throw new Error(`invalid end_game effect for ${ending.id}`);
    return endGame.endingId;
  });
  const facetRevelations = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    if (binding.shellAtoms.length || binding.findings.length) facetRevelations.set(binding.clueId, binding.shellAtoms.map((atom) => atom.quote).join("\n") || required(payload.draft.clueCandidates.find((candidate) => candidate.id === binding.clueId), `facet shell ${binding.clueId}`).displayName);
    for (const finding of binding.findings) facetRevelations.set(finding.clueId, finding.atoms.map((atom) => atom.quote).join("\n"));
  }

  return {
    module: {
      title: sourceText(payload, payload.draft.sceneCandidates[0]!.headingStatementId),
      version: sourceProse,
      ruleset: "cosmic-horror",
      era: sourceProse,
      summary: sourceProse,
      playerCount: sourceProse,
      expectedDuration: sourceProse,
      triggerWarnings: [sourceProse],
    },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: sourceParagraphForScene(payload, id) }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: sourceParagraphForScene(payload, connection.fromSceneId) }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => {
      const candidate = required(payload.draft.clueCandidates.find((clueCandidate) => clueCandidate.id === id), `resolved clue ${id}`);
      const body = facetRevelations.get(id) ?? sourceText(payload, candidate.bodyStatementId);
      return [id, {
        findMethods: [{ type: "observation" as const, description: body }],
        revelation: body,
        unlocks: [body],
        importance: candidate.displayName === "梦境之石" ? "core" as const : "bonus" as const,
      }];
    })),
    endings: Object.fromEntries(endingIds.map((id) => [id, { name: endingProse, description: endingProse, conditions: [endingProse] }])),
  };
}

function compiledIds(payload: ResolvedCompilerArtifactPayload) {
  const sceneId = (name: string) => required(payload.draft.sceneCandidates.find((candidate) => candidate.displayName === name), `resolved ${name} scene`).id;
  const traversal = (fromSceneId: string, toSceneId: string) => {
    const connection = required(payload.analysisInput.connections.find((candidate) => candidate.fromSceneId === fromSceneId && candidate.toSceneId === toSceneId), `connection ${fromSceneId} -> ${toSceneId}`);
    return required(payload.mechanicsIR.connections.find((candidate) => candidate.connectionId === connection.id), `mechanism for ${connection.id}`).id;
  };
  const dreamStone = required(payload.draft.clueCandidates.find((candidate) => candidate.displayName === "梦境之石"), "resolved dream stone clue");
  return {
    openingToFoyer: traversal(sceneId("开场"), sceneId("门厅")),
    foyerToArchive: traversal(sceneId("门厅"), sceneId("档案室")),
    archiveToMirror: traversal(sceneId("档案室"), sceneId("镜厅")),
    dreamStone: required(payload.mechanicsIR.discoveryMethods.find((method) => method.clueId === dreamStone.id), "dream stone mechanism").id,
  };
}

function gameSession(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "结构回归调查员");
}

async function traverse(target: GameSession, mechanismId: string) {
  const result = await target.act(compiledMechanicsAction(mechanismId));
  expect(result.error).toBeUndefined();
  return result;
}

describe("real source structure compiler playthrough", () => {
  it("closes a bare-heading discovery list into two replayable endings and executable terminal sessions", async () => {
    expect(SOURCE_PAGES[0]).not.toContain("▶");
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "real-source-structure-playthrough",
      sourceDescriptor: "real-source-structure-playthrough",
      pages: SOURCE_PAGES,
    });
    if (prepared.status === "refused") throw new Error(prepared.message);

    const sourceDraft = prepared.artifact.payload.draft;
    expect(sourceDraft.sceneCandidates.map((candidate) => candidate.displayName)).toEqual(expect.arrayContaining(["开场", "门厅", "档案室", "镜厅", "终局"]));
    expect(sourceDraft.clueCandidates.map((candidate) => candidate.displayName)).toEqual(expect.arrayContaining(["铜钥匙", "梦境之石"]));
    const sourceDreamStone = clue(prepared, "梦境之石");
    expect(sourceText(prepared.artifact.payload, sourceDreamStone.bodyStatementId)).toContain("梦中映出镜厅的位置");

    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, benchmarkHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    expect(payload.readiness.status).toBe("mechanically_closed");
    const playableSourceIds = ["开场", "门厅", "档案室", "镜厅"].map((name) => scene(prepared, name).id);
    const endingSourceId = scene(prepared, "终局").id;
    expect(payload.mechanicsIR.symbols.sceneIds).toHaveLength(4);
    expect(payload.mechanicsIR.symbols.sceneIds).toEqual(expect.arrayContaining(playableSourceIds));
    expect(payload.mechanicsIR.symbols.sceneIds).not.toContain(endingSourceId);
    expect(payload.analysisInput.connections).toHaveLength(3);
    expect(sourceParagraphForScene(payload, endingSourceId)).toContain("若未带着它离开");
    expect(payload.reachabilityReport.unreachableEndingIds).toEqual([]);
    expect(payload.substitutedEnginePolicyInterpretationIds.length).toBeGreaterThan(0);
    expect(payload.acceptedInterpretations.map((interpretation) => interpretation.id)).not.toEqual(expect.arrayContaining(payload.substitutedEnginePolicyInterpretationIds));

    const endingWitnesses = payload.reachabilityReport.endingWitnesses;
    const withStoneWitness = required(endingWitnesses[WITH_STONE_ENDING], "dream-stone ending witness");
    const withoutStoneWitness = required(endingWitnesses[WITHOUT_STONE_ENDING], "no-stone ending witness");
    const withStoneState = replayMechanicsWitness(payload.mechanicsIR, payload.analysisInput, withStoneWitness);
    const withoutStoneState = replayMechanicsWitness(payload.mechanicsIR, payload.analysisInput, withoutStoneWitness);
    const dreamStoneId = required(payload.draft.clueCandidates.find((candidate) => candidate.displayName === "梦境之石"), "resolved dream stone clue").id;
    expect(withStoneState.terminalEndingId).toBe(WITH_STONE_ENDING);
    expect(withoutStoneState.terminalEndingId).toBe(WITHOUT_STONE_ENDING);
    expect(withStoneState.foundClueIds).toContain(dreamStoneId);
    expect(withoutStoneState.foundClueIds).not.toContain(dreamStoneId);
    for (const ending of payload.mechanicsIR.endings) {
      const endGame = required(ending.effects.find((effect) => effect.kind === "end_game"), `end_game effect for ${ending.id}`);
      if (endGame.kind !== "end_game") throw new Error(`invalid end_game effect for ${ending.id}`);
      expect(ending.id).not.toBe(endGame.endingId);
    }

    const projection = projectResolvedCompilerArtifact(payload, presentationMetadata(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const ids = compiledIds(payload);

    const withStone = gameSession("real-source-with-stone");
    expect(withStone.loadCompiledModule(payload, projection).status).toBe("loaded");
    await traverse(withStone, ids.openingToFoyer);
    await traverse(withStone, ids.dreamStone);
    await traverse(withStone, ids.foyerToArchive);
    const safeEnding = await traverse(withStone, ids.archiveToMirror);
    expect(safeEnding.compiled?.terminalEnding?.id).toBe(WITH_STONE_ENDING);
    expect(withStone.getCompiledAvailableActions()).toHaveLength(0);
    expect((await withStone.act(compiledMechanicsAction(ids.dreamStone))).error?.code).toBe("compiled_terminal");

    const withoutStone = gameSession("real-source-without-stone");
    expect(withoutStone.loadCompiledModule(payload, projection).status).toBe("loaded");
    await traverse(withoutStone, ids.openingToFoyer);
    await traverse(withoutStone, ids.foyerToArchive);
    const lostEnding = await traverse(withoutStone, ids.archiveToMirror);
    expect(lostEnding.compiled?.terminalEnding?.id).toBe(WITHOUT_STONE_ENDING);
    expect(withoutStone.getCompiledAvailableActions()).toHaveLength(0);
    expect((await withoutStone.act(compiledMechanicsAction(ids.archiveToMirror))).error?.code).toBe("compiled_terminal");
  });
});
