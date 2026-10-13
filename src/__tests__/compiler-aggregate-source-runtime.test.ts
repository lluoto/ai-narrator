import { describe, expect, it } from "bun:test";
import { compiledMechanicsAction, GameSession } from "../api/game-session";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { projectResolvedCompilerArtifact, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { summarizeCompilerRuntimeQuality } from "../compiler/compiler-runtime-quality";
import { allShellClueFactFacetResolutions, clueFactFacetRevelations } from "./helpers/clue-fact-facet-hints";

const SOURCE_PAGES = [
  [
    "Dock:",
    "Captain Mira waits beside the launch and guards the harbor manifest.",
    "▶Harbor Ledger: The signed ledger reveals the launch route.",
    "▶Moon Key: The brass key opens the archive cabinet.",
    "Archive:",
    "The cabinet contains a map to the old lighthouse.",
    "Lighthouse:",
    "The beacon can guide a vessel safely home.",
    "Exit:",
    "The launch leaves the harbor at dawn.",
    "Rewards:",
    "SAN +1d6",
    "CM +2",
    "CR +3",
    "Ending:",
    "Boarding the launch ends the investigation.",
  ].join("\n"),
];

function counts(values: readonly { [key: string]: unknown }[], key: string): Record<string, number> {
  return Object.fromEntries(values.reduce<Map<string, number>>((total, value) => {
    const name = String(value[key]);
    total.set(name, (total.get(name) ?? 0) + 1);
    return total;
  }, new Map()).entries());
}

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error("missing " + label);
  return value;
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
    reason: "aggregate source-to-runtime reviewed declaration",
  };
}

function sourceText(payload: ResolvedCompilerArtifactPayload, statementId: string): string {
  return required(payload.graph.statements.find((statement) => statement.id === statementId), "source statement " + statementId).text;
}

function aggregateHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const scene = (prefix: string) => required(draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(prefix)), "scene " + prefix);
  const clue = (name: string) => required(draft.clueCandidates.find((candidate) => candidate.displayName === name), "clue " + name);
  const item = (name: string) => required(draft.itemCandidates.find((candidate) => candidate.displayName === name), "item " + name);
  const question = (kind: CompilerQuestion["kind"], subject?: string) => required(
    queue.questions.find((candidate) => candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject)),
    kind + " question" + (subject ? " for " + subject : ""),
  );
  const dock = scene("Dock");
  const archive = scene("Archive");
  const lighthouse = scene("Lighthouse");
  const exit = scene("Exit");
  const ledger = clue("HarborLedger");
  const moonKey = clue("MoonKey");
  const dockAnchor = required(draft.proseNpcAnchors.find((anchor) => anchor.sceneCandidateId === dock.id), "Dock prose NPC anchor");
  const sanReward = required(draft.rewardCandidates.find((candidate) => sourceText(prepared.artifact.payload as ResolvedCompilerArtifactPayload, candidate.tableRowStatementId).includes("SAN")), "SAN reward candidate");

  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...allShellClueFactFacetResolutions(queue.questions, answer),
      ...queue.questions.filter((candidate) => candidate.kind === "source_fact_disposition").map((candidate) => answer(candidate, {
        statementId: candidate.subjectStatementId,
        disposition: "source_only",
      })),
      ...draft.sceneCandidates.map((candidate) => answer(question("scene_role", candidate.id), {
        role: [dock.id, archive.id, lighthouse.id, exit.id].includes(candidate.id) ? "playable_scene" : candidate.displayName.startsWith("Ending") ? "ending_section" : "other",
      })),
      answer(question("entry_scene"), { sceneCandidateId: dock.id }),
      ...draft.sceneCandidates.map((candidate) => answer(question("connection_topology", candidate.id), {
        connections: candidate.id === dock.id
          ? [{ toSceneCandidateId: archive.id, connectionId: "aggregate_dock_archive" }]
          : candidate.id === archive.id
            ? [{ toSceneCandidateId: lighthouse.id, connectionId: "aggregate_archive_lighthouse" }]
            : candidate.id === lighthouse.id
              ? [{ toSceneCandidateId: exit.id, connectionId: "aggregate_lighthouse_exit" }]
              : [],
      })),
      ...draft.clueCandidates.map((candidate) => answer(question("core_clue", candidate.id), {
        clueCandidateId: candidate.id,
        required: true,
      })),
      answer(question("discovery_method", ledger.id), {
        clueCandidateId: ledger.id,
        locationSceneCandidateId: dock.id,
        spec: {
          kind: "discovery_method",
          id: "aggregate_search_harbor_ledger",
          clueId: ledger.id,
          action: "search",
          target: "scene",
          targetId: dock.id,
          onSuccess: [{ kind: "discover_clue", clueId: ledger.id }],
        },
      }),
      answer(question("discovery_method", moonKey.id), {
        clueCandidateId: moonKey.id,
        locationSceneCandidateId: dock.id,
        spec: {
          kind: "discovery_method",
          id: "aggregate_take_moon_key",
          clueId: moonKey.id,
          action: "search",
          target: "item",
          targetId: item("MoonKey").id,
          onSuccess: [{ kind: "discover_clue", clueId: moonKey.id }, { kind: "acquire_item", itemId: item("MoonKey").id }],
        },
      }),
      ...draft.proseNpcAnchors.map((anchor) => answer(question("npc_binding", anchor.id), {
        proseAnchorId: anchor.id,
        presentNpcs: anchor.id === dockAnchor.id
          ? [{
            nameQuote: "Mira",
            dialogueMethods: [{
              mechanismId: "aggregate_ask_mira_about_ledger",
              clueCandidateId: ledger.id,
              check: { kind: "skill", skill: "persuade", difficulty: "regular" },
              onSuccess: [{ kind: "discover_clue", clueId: ledger.id }],
            }],
          }]
          : [],
      })),
      ...draft.itemCandidates.map((candidate) => answer(question("item_binding", candidate.id), {
        itemCandidateId: candidate.id,
        itemType: candidate.id === item("MoonKey").id ? "key" : null,
        ...(candidate.id === item("MoonKey").id ? {
          itemNameEvidence: {
            statementId: candidate.nameStatementId,
            quote: sourceText(prepared.artifact.payload as ResolvedCompilerArtifactPayload, candidate.nameStatementId),
          },
        } : {}),
      })),
      ...draft.rewardCandidates.map((candidate) => answer(question("reward_binding", candidate.id), {
        rewardCandidateId: candidate.id,
        declaration: candidate.id === sanReward.id
          ? {
            when: { kind: "scene_visited", sceneId: exit.id },
            settlement: { san: { kind: "dice", count: 1, sides: 6 } },
          }
          : null,
      })),
      answer(question("ending_rule"), {
        declarations: [{
          endingId: "aggregate_safe_departure",
          spec: {
            kind: "ending_rule",
            id: "aggregate_safe_departure_rule",
            priority: 1,
            when: { kind: "scene_visited", sceneId: exit.id },
            effects: [{ kind: "end_game", endingId: "aggregate_safe_departure" }],
          },
        }],
      }),
    ],
  };
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const firstHeading = required(payload.graph.statements.find((statement) => statement.kind === "heading"), "first heading").text;
  const sourceProse = required(payload.graph.statements.find((statement) => statement.kind === "paragraph"), "source prose").text;
  const facetRevelations = clueFactFacetRevelations(payload.clueFactFacetBindings);
  return {
    module: {
      title: firstHeading,
      version: firstHeading,
      ruleset: "cosmic-horror",
      era: sourceProse,
      summary: sourceProse,
      playerCount: sourceProse,
      expectedDuration: sourceProse,
      triggerWarnings: [sourceProse],
    },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((sceneId) => {
      const candidate = required(payload.draft.sceneCandidates.find((entry) => entry.id === sceneId), "playable scene candidate");
      return [candidate.id, { description: sourceText(payload, candidate.headingStatementId) }];
    })),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, {
      condition: sourceText(payload, required(payload.draft.sceneCandidates.find((candidate) => candidate.id === connection.fromSceneId), "connection source scene").headingStatementId),
    }])),
    clues: Object.fromEntries(payload.draft.clueCandidates.map((candidate) => [candidate.id, {
      findMethods: [],
      revelation: facetRevelations.get(candidate.id) ?? sourceText(payload, candidate.bodyStatementId),
      unlocks: [],
      importance: "core",
    }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.flatMap((rule) => rule.effects
      .filter((effect) => effect.kind === "end_game")
      .map((effect) => [effect.endingId, {
      name: sourceProse,
      description: sourceProse,
      conditions: [sourceProse],
      }]))),
  };
}

describe("aggregate source-to-runtime content breadth", () => {
  it("carries source candidates, a fully reviewed queue, and bound content through a terminal GameSession", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "aggregate-source-runtime",
      sourceDescriptor: "aggregate-source-runtime",
      pages: SOURCE_PAGES,
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { draft, preparedQueue } = prepared.artifact.payload;
    expect(draft.sceneCandidates).toHaveLength(6);
    expect(draft.clueCandidates).toHaveLength(2);
    expect(draft.itemCandidates).toHaveLength(2);
    expect(draft.proseNpcAnchors).toHaveLength(5);
    expect(draft.rewardCandidates).toHaveLength(3);
    expect(counts(preparedQueue.questions as unknown as Array<{ kind: string }>, "kind")).toEqual({
      clue_fact_facets: 2,
      scene_role: 6,
      connection_topology: 6,
      npc_binding: 5,
      source_fact_disposition: 5,
      source_fact_mechanic: 1,
      reward_binding: 3,
      discovery_method: 2,
      core_clue: 2,
      item_binding: 2,
      entry_scene: 1,
      ending_rule: 1,
    });

    const hints = aggregateHints(prepared);
    const preparedSourceFactChildren = preparedQueue.questions.filter((question) => question.kind === "source_fact_mechanic");
    expect(preparedSourceFactChildren).toHaveLength(1);
    expect(preparedSourceFactChildren[0]!.status).toBe("deferred");
    expect(hints.schemaVersion).toBe(MODULE_COMPILE_HINTS_SCHEMA_VERSION);
    expect(hints.resolutions).toHaveLength(preparedQueue.questions.length - preparedSourceFactChildren.length);
    expect(hints.resolutions.some((resolution) => resolution.kind === "source_fact_mechanic")).toBe(false);
    expect(hints.resolutions.every((resolution) => resolution.authority === "user_document" && resolution.reviewerKind === "human" && resolution.sourceStatementIds.length > 0 && resolution.evidenceRefs.length > 0)).toBe(true);
    expect(hints.resolutions.filter((resolution) => resolution.kind === "item_binding" && (resolution.value as { itemType: string | null }).itemType === null)).toHaveLength(1);
    expect(hints.resolutions.filter((resolution) => resolution.kind === "reward_binding" && (resolution.value as { declaration: unknown }).declaration === null)).toHaveLength(2);

    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    expect(payload.resolvedQueue.questions.filter((question) => question.status === "open")).toHaveLength(0);
    expect(required(payload.resolvedQueue.questions.find((question) => question.kind === "source_fact_disposition"), "source fact parent").status).toBe("answered");
    expect(required(payload.resolvedQueue.questions.find((question) => question.kind === "source_fact_mechanic"), "source fact child").status).toBe("not_applicable");
    expect(payload.itemBindings).toHaveLength(1);
    expect(payload.mechanicsIR.symbols.itemIds).toHaveLength(1);
    expect(payload.proseNpcBindings).toHaveLength(1);
    expect(payload.proseNpcBindings[0]!.dialogueMethods).toHaveLength(1);
    expect(payload.rewardBindings.filter((binding) => binding.declaration !== null)).toHaveLength(1);
    expect(payload.mechanicsIR.rewards).toHaveLength(1);

    const quality = summarizeCompilerRuntimeQuality(payload);
    expect(quality.sourceRootDisposition).toMatchObject({
      dispositionReadiness: "complete",
      openQuestionCount: 0,
      openRootCount: 0,
      unmodeledRootCount: 0,
    });
    expect(quality.sourceRootDisposition.counts.accepted_binding).toBeGreaterThan(0);
    expect(quality.sourceRootDisposition.counts.explicitly_unbound).toBeGreaterThan(0);
    expect(quality.coverage).toMatchObject({
      playableScenes: 4,
      compiledClues: 2,
      boundItems: 1,
      runtimeItems: 1,
      boundNpcAnchors: 1,
      boundNpcs: 1,
      dialogueMethods: 1,
      boundRewards: 1,
      runtimeRewards: 1,
      reachableEndings: 1,
    });
    expect(quality.closedWorldIssueCounts).toEqual({
      unreachable_core_clue: 0,
      unreachable_ending: 0,
      core_clue_failure_policy_risk: 0,
      closed_world_deadlock: 0,
    });

    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status !== "projected") throw new Error(projection.message);
    expect(projection.status).toBe("projected");
    expect(projection.module.items).toHaveLength(1);
    expect(projection.module.npcs).toHaveLength(1);

    const session = new GameSession("aggregate-source-runtime-session", "cosmic-horror", CONFIG, "investigator", "Ada");
    expect(session.setPlayerSan("p1", 40)).toMatchObject({ ok: true });
    expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
    const dialogue = required(payload.mechanicsIR.discoveryMethods.find((method) => method.id === "aggregate_ask_mira_about_ledger"), "Mira dialogue");
    const takeMoonKey = required(payload.mechanicsIR.discoveryMethods.find((method) => method.id === "aggregate_take_moon_key"), "Moon Key discovery");
    const dockToArchive = required(payload.mechanicsIR.connections.find((connection) => connection.connectionId === "aggregate_dock_archive"), "Dock to Archive connection");
    const archiveToLighthouse = required(payload.mechanicsIR.connections.find((connection) => connection.connectionId === "aggregate_archive_lighthouse"), "Archive to Lighthouse connection");
    const lighthouseToExit = required(payload.mechanicsIR.connections.find((connection) => connection.connectionId === "aggregate_lighthouse_exit"), "Lighthouse to Exit connection");
    const initialSan = session.getSanity().currentSAN;
    const random = Math.random;
    try {
      Math.random = () => 0;
      const talked = await session.act(compiledMechanicsAction(dialogue.id));
      expect(talked.error).toBeUndefined();
      expect(talked.compiled?.state.foundClueIds).toContain(dialogue.clueId);
      const acquired = await session.act(compiledMechanicsAction(takeMoonKey.id));
      expect(acquired.error).toBeUndefined();
      expect(acquired.compiled?.state.ownedItemIds).toContain(payload.itemBindings[0]!.itemId);
      expect((await session.act(compiledMechanicsAction(dockToArchive.id))).error).toBeUndefined();
      expect((await session.act(compiledMechanicsAction(archiveToLighthouse.id))).error).toBeUndefined();
      const terminal = await session.act(compiledMechanicsAction(lighthouseToExit.id));
      expect(terminal.error).toBeUndefined();
      expect(terminal.compiled?.state.terminalEndingId).toBe("aggregate_safe_departure");
      expect((terminal as any).rewardSettlements).toHaveLength(1);
      expect(session.getSanity().currentSAN).toBeGreaterThan(initialSan);
      expect(session.getCompiledAvailableActions()).toEqual([]);
    } finally {
      Math.random = random;
    }
  });
});
