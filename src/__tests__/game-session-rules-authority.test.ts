import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import {
  projectResolvedCompilerArtifact,
  type ModuleDataPresentationMetadata,
} from "../compiler/compiler-module-data-projection";
import {
  MODULE_COMPILE_HINTS_SCHEMA_VERSION,
  type CompilerQuestion,
  type CompilerQuestionResolution,
  type ModuleCompileHints,
} from "../compiler/compiler-question-queue";
import { allShellClueFactFacetResolutions, clueFactFacetRevelations } from "./helpers/clue-fact-facet-hints";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function combatRuntime() {
  const units = [0, 0.2, 0, 0.2];
  let index = 0;
  return { compiledCombatRandom: () => units[index++ % units.length]! };
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
    reason: "GameSession RulesEngine authority fixture",
  };
}

function combatHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue, graph } = prepared.artifact.payload;
  const dock = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Dock"))!;
  const exit = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit"))!;
  const clue = draft.clueCandidates.find((candidate) => candidate.sceneCandidateId === dock.id)!;
  const anchor = draft.proseNpcAnchors.find((candidate) => candidate.sceneCandidateId === dock.id)!;
  const stats = graph.statements.find((statement) => statement.id === anchor.paragraphStatementId)!;
  const evidenceStatement = graph.statements.find((statement) => statement.id === clue.markedItemStatementId)!;
  const question = (kind: CompilerQuestion["kind"], subject?: string) => queue.questions.find((candidate) =>
    candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject),
  )!;
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
      answer(question("npc_binding", anchor.id), {
        proseAnchorId: anchor.id,
        presentNpcs: [{
          nameQuote: "Mira",
          dialogueMethods: [],
          encounter: {
            maxHp: { statementId: stats.id, quote: "HP 2" },
            dodge: { statementId: stats.id, quote: "Dodge 30" },
            fight: { statementId: stats.id, quote: "Fight 40" },
            npcDamage: { statementId: stats.id, quote: "Damage 1d2" },
            victoryEffects: [{
              effect: { kind: "discover_clue", clueId: clue.id },
              evidence: {
                candidateId: clue.id,
                headingStatementId: anchor.headingStatementId,
                statementId: evidenceStatement.id,
                quote: evidenceStatement.text,
              },
            }],
          },
        }],
      }),
    ],
  };
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const revelations = clueFactFacetRevelations(payload.clueFactFacetBindings);
  return {
    module: { title: "Rules authority", version: "1", ruleset: "cosmic-horror", era: "test", summary: "test", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: `scene:${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: `connection:${connection.id}` }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => [id, { findMethods: [], revelation: revelations.get(id) ?? `revelation:${id}`, unlocks: [], importance: "core" as const }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((ending) => [ending.effects.find((effect) => effect.kind === "end_game")!.endingId, { name: ending.id, description: `ending:${ending.id}`, conditions: ["test"] }])),
  };
}

async function compiledEncounterFixture() {
  const prepared = await prepareCompiler({
    kind: "synthetic_pages",
    moduleId: "game-session-rules-authority",
    sourceDescriptor: "game-session-rules-authority",
    pages: ["Dock:\nCaptain Mira waits beside the launch. HP 2. Dodge 30. Fight 40. Damage 1d2.\n\u25b6Harbor Ledger: It records the launch manifest.\nExit:"],
  });
  if (prepared.status === "refused") throw new Error(prepared.message);
  const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, combatHints(prepared));
  if (resolved.status === "refused") throw new Error(resolved.message);
  const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
  const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
  if (projection.status === "refused") throw new Error(projection.message);
  return { payload, projection };
}

describe("GameSession RulesEngine authority", () => {
  it("does not publish a rules capability on either its instance or prototype", () => {
    const session = new GameSession("rules-authority-shape", "cosmic-horror", CONFIG);
    try {
      expect(Object.hasOwn(session, "rules")).toBe(false);
      expect(Object.getOwnPropertyDescriptor(GameSession.prototype, "rules")).toBeUndefined();
      expect("rules" in session).toBe(false);
    } finally {
      session.close();
    }
  });

  it("keeps a real compiled player-and-counterattack exchange on the canonical engine despite a public decoy", async () => {
    const { payload, projection } = await compiledEncounterFixture();
    const session = new GameSession("rules-authority-compiled", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, undefined, undefined, "preferred", combatRuntime());
    try {
      expect(session.loadCompiledModule(payload, projection)).toMatchObject({ status: "loaded" });
      const encounter = payload.mechanicsIR.encounterDefinitions[0]!;
      Object.defineProperty(session, "rules", {
        configurable: true,
        value: { adjudicateAttack: () => { throw new Error("public RulesEngine decoy was used"); } },
      });

      const response = await session.act(`@compiled attack:${encounter.encounterId}`);

      expect(response.error).toBeUndefined();
      expect(response.combatSettlement).toMatchObject({
        mechanismId: `attack:${encounter.encounterId}`,
        player: { hit: true, damage: 1 },
        enemy: { hit: true, damageDealt: 2 },
      });
    } finally {
      session.close();
    }
  });

  it("keeps the ordinary CoC player attack and NPC counterattack on the canonical engine despite a public decoy", async () => {
    const session = new GameSession("rules-authority-ordinary", "cosmic-horror", CONFIG, undefined, undefined, undefined, undefined, undefined, "preferred", { careerEntryPersistence: "transient" });
    const originalRandom = Math.random;
    try {
      await session.act("创建角色 investigator Ada");
      expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
      expect(activateRegisteredGameSessionSceneForTest(session, "维森酒吧")).toBe(true);
      Object.defineProperty(session, "rules", {
        configurable: true,
        value: { adjudicateAttack: () => { throw new Error("public RulesEngine decoy was used"); } },
      });
      // Player fumble, then a real NPC critical and a player dodge fumble.
      // This keeps the monster alive while proving both ordinary call sites run.
      const units = [0, 0, 0.99, 0, 0, 0.99, 0, 0, 0, 0.99, 0.99];
      let index = 0;
      Math.random = () => units[index++] ?? 0.99;

      const response = await session.act("攻击 酒吧保镖");

      expect(response.error).toBeUndefined();
      expect(session.activeCharacter!.hp).toBeLessThan(session.activeCharacter!.maxHp);
      const guard = session.world.getEntity("酒吧保镖");
      expect(guard).not.toBeNull();
      expect(guard!.hp).toBeLessThan(guard!.maxHp);
    } finally {
      Math.random = originalRandom;
      session.close();
    }
  });

  it("keeps DnD and Grail NPC counterattack dispatch on the canonical engine despite a public decoy", async () => {
    const originalRandom = Math.random;
    try {
      for (const ruleset of ["dnd5e", "grail"] as const) {
        const session = new GameSession(`rules-authority-${ruleset}`, ruleset, CONFIG, undefined, undefined, undefined, undefined, undefined, "preferred", { careerEntryPersistence: "transient" });
        try {
          await session.act("创建角色 investigator Ada");
          expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
          expect(activateRegisteredGameSessionSceneForTest(session, "维森酒吧")).toBe(true);
          Object.defineProperty(session, "rules", {
            configurable: true,
            value: { adjudicateAttack: () => { throw new Error(`public ${ruleset} RulesEngine decoy was used`); } },
          });
          Math.random = () => 0;

          const response = await session.act("攻击 酒吧保镖");

          expect(response.error).toBeUndefined();
          const guard = session.world.getEntity("酒吧保镖");
          expect(guard).not.toBeNull();
          expect(guard!.hp).toBeLessThan(guard!.maxHp);
        } finally {
          session.close();
        }
      }
    } finally {
      Math.random = originalRandom;
    }
  });
});
