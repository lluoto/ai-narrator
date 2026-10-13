import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession, compiledMechanicsAction } from "../api/game-session";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotHash } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { projectResolvedCompilerArtifact, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, parseCompilerHintValue, validateModuleCompileHints, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { SanityEngine } from "../rules/coc-engine";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const PAGES = ["Entry:\nA cracked mirror shatters the mind: SAN 1d6/10; its echoes inflict SAN 10/10 twice on the road.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."];

function required<T>(value: T | undefined, label: string): T { if (value === undefined) throw new Error(`missing ${label}`); return value; }
async function freshSanityWorker(request: { root: string; sessionId: string; bundleId: string; input: string; actionId: string }): Promise<{ sanity: unknown; duplicate: unknown }> {
  const worker = new Worker(new URL("./compiler-source-bound-sanity-child.ts", import.meta.url).href, { type: "module" });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error("SAN restart worker timed out")); }, 10_000);
      worker.onmessage = (event: MessageEvent<{ status: "ok"; proof: Awaited<ReturnType<typeof freshSanityWorker>> } | { status: "error"; message: string }>) => { clearTimeout(timeout); event.data.status === "ok" ? resolve(event.data.proof) : reject(new Error(event.data.message)); };
      worker.onerror = (event: ErrorEvent) => { clearTimeout(timeout); reject(new Error(event.message || "SAN restart worker failed")); };
      worker.postMessage(request);
    });
  } finally { worker.terminate(); }
}
function answer(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
  return { questionId: question.id, kind: question.kind, value, sourceStatementIds: [...question.sourceStatementIds], evidenceRefs: [...question.evidenceRefs], authority: "user_document", derivation: "explicit", reviewerKind: "human", rightsStatus: "user_provided", reason: "source-bound SAN check fixture" };
}

const SAN_1D6_10 = { kind: "sanity_check", passLoss: { kind: "dice", count: 1, sides: 6 }, failLoss: { kind: "fixed", amount: 10 } };
const SAN_10_10 = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 10 }, failLoss: { kind: "fixed", amount: 10 } };

function sourceDeclaration(prepared: PreparedCompilerApiResult, question: CompilerQuestion, effect: any): { statementId: string; quote: string } {
  const key = (loss: any) => loss.kind === "fixed" ? `${loss.amount}` : `${loss.count}d${loss.sides}`;
  const expected = `${key(effect.passLoss)}/${key(effect.failLoss)}`.toLowerCase();
  const matcher = /(?:\bSAN\b|\u7406\u667a)(?:\s*(?:loss|\u635f\u5931|\u9274\u5b9a)\s*)?(?:[\(\uff08]\s*((?:\d+\s*[dD]\s*\d+|\d+))\s*\/\s*((?:\d+\s*[dD]\s*\d+|\d+))\s*[\)\uff09]|[\s\uff08]*((?:\d+\s*[dD]\s*\d+|\d+))\s*\/\s*((?:\d+\s*[dD]\s*\d+|\d+)))(?![\p{L}\p{N}_])(?:\s+(?:twice|\u4e24\u6b21))?/giu;
  for (const statementId of question.sourceStatementIds) {
    const text = required(prepared.artifact.payload.graph.statements.find((statement) => statement.id === statementId), "SAN source").text;
    for (const match of text.matchAll(matcher)) {
      const actual = `${(match[1] ?? match[3]!).replace(/\s+/g, "")}/${(match[2] ?? match[4]!).replace(/\s+/g, "")}`.toLowerCase();
      if (actual === expected) return { statementId, quote: match[0]! };
    }
  }
  const fallbackId = question.sourceStatementIds[0]!;
  return { statementId: fallbackId, quote: required(prepared.artifact.payload.graph.statements.find((statement) => statement.id === fallbackId), "fallback SAN source").text };
}

function hints(prepared: PreparedCompilerApiResult, sanityEffects: unknown[] = [SAN_1D6_10, SAN_10_10, SAN_10_10]): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const entry = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry");
  const exit = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit");
  const reward = required(draft.rewardCandidates[0], "source SAN reward");
  const question = (kind: CompilerQuestion["kind"], subject?: string) => required(queue.questions.find((candidate) => candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject)), kind);
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION, moduleId: queue.moduleId, documentHash: queue.documentHash, sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...draft.sceneCandidates.map((scene) => answer(question("scene_role", scene.id), { role: scene.id === entry.id || scene.id === exit.id ? "playable_scene" : "other" })),
      answer(question("entry_scene"), { sceneCandidateId: entry.id }),
      ...draft.sceneCandidates.map((scene) => answer(question("connection_topology", scene.id), { connections: scene.id === entry.id ? [{
        toSceneCandidateId: exit.id, connectionId: "mirror_road", onTraverse: [
          { kind: "unlock_connection", connectionId: "mirror_road" },
          ...sanityEffects,
        ],
        actorEffectProvenance: sanityEffects.map((effect: any, index) => ({
          effectPath: `onTraverse[${index + 1}]`,
          eventSlot: { kind: "connection", connectionId: "mirror_road", outcome: "traverse", effectIndex: index + 1 },
          source: sourceDeclaration(prepared, question("connection_topology", entry.id), effect),
        })),
      }] : [] })),
      answer(question("ending_rule"), { declarations: [{ endingId: "escape", spec: { kind: "ending_rule", id: "escape_rule", priority: 1, when: { kind: "scene_visited", sceneId: exit.id }, effects: [{ kind: "end_game", endingId: "escape" }] } }] }),
      ...draft.rewardCandidates.map((candidate) => answer(question("reward_binding", candidate.id), { rewardCandidateId: candidate.id, declaration: candidate.id === reward.id ? { when: { kind: "scene_visited", sceneId: exit.id }, settlement: { san: { kind: "fixed", amount: 1 } } } : null })),
    ],
  };
}

function sourceTopology(prepared: PreparedCompilerApiResult, currentHints: ModuleCompileHints) {
  const { graph, preparedQueue: queue } = prepared.artifact.payload;
  const resolution = required(currentHints.resolutions.find((candidate) => candidate.kind === "connection_topology" && (candidate.value as any).connections.some((connection: any) => connection.onTraverse?.some((effect: any) => effect.kind === "sanity_check"))), "SAN topology resolution");
  return { graph, question: required(queue.questions.find((candidate) => candidate.id === resolution.questionId), "SAN topology question"), resolution };
}

function replaceSanityEffect(currentHints: ModuleCompileHints, replacement: unknown, index: number): ModuleCompileHints {
  const forged: any = structuredClone(currentHints);
  const resolution = forged.resolutions.find((candidate: any) => candidate.kind === "connection_topology" && candidate.value.connections.some((connection: any) => connection.onTraverse?.some((effect: any) => effect.kind === "sanity_check")));
  const effects = resolution.value.connections[0].onTraverse;
  const effectIndex = effects.map((effect: any, currentIndex: number) => effect.kind === "sanity_check" ? currentIndex : -1).filter((currentIndex: number) => currentIndex >= 0)[index];
  effects[effectIndex] = replacement;
  return forged;
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  return {
    module: { title: "SAN", version: "1", ruleset: "cosmic-horror", era: "modern", summary: "SAN", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: id }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: connection.id }])),
    clues: {}, endings: { escape: { name: "Escape", description: "Escape.", conditions: ["exit"] } },
  };
}

describe("source-bound compiled SAN checks", () => {
  it("rejects a human-reviewed SAN value that differs from its source declaration through the public parser", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-bound-sanity-tampered", sourceDescriptor: "source-bound-sanity-tampered", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const forged = replaceSanityEffect(hints(prepared), { kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 10 } }, 0);
    const { graph, question, resolution } = sourceTopology(prepared, forged);
    expect(() => parseCompilerHintValue(question, resolution.value, graph)).toThrow("source declaration mismatch");
  });

  it("refuses the same value-tampered SAN resolution through complete compiler resolution", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-bound-sanity-tampered-resolve", sourceDescriptor: "source-bound-sanity-tampered-resolve", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const forged = replaceSanityEffect(hints(prepared), { kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 10 } }, 0);
    expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, forged).status).toBe("refused");
  });

  it("rejects a second consumption of a SAN declaration that appears once in scope", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-bound-sanity-duplicate", sourceDescriptor: "source-bound-sanity-duplicate", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const forged = replaceSanityEffect(hints(prepared), SAN_1D6_10, 1);
    const { graph, question, resolution } = sourceTopology(prepared, forged);
    expect(() => parseCompilerHintValue(question, resolution.value, graph)).toThrow("source declaration mismatch");
    expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, forged).status).toBe("refused");
  });

  it("rejects SAN bindings swapped between source-named parallel connection slots", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages", moduleId: "source-bound-sanity-parallel", sourceDescriptor: "source-bound-sanity-parallel",
      pages: ["Entry:\nAlpha invokes SAN 1/1. Beta invokes SAN 1/1.\nAlpha:\nThe alpha route.\nBeta:\nThe beta route.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."],
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const currentHints: any = hints(prepared, []);
    const graph = prepared.artifact.payload.graph;
    const resolution = required(currentHints.resolutions.find((candidate: any) => candidate.kind === "connection_topology" && candidate.questionId === required(prepared.artifact.payload.preparedQueue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry").id), "entry topology").id), "entry topology resolution");
    const question = required(prepared.artifact.payload.preparedQueue.questions.find((candidate) => candidate.id === resolution.questionId), "entry topology question");
    const alpha = required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Alpha")), "Alpha scene");
    const beta = required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Beta")), "Beta scene");
    const statementId = required(question.sourceStatementIds.find((id) => required(graph.statements.find((statement) => statement.id === id), "parallel source").text.includes("Alpha invokes")), "parallel SAN statement");
    const effect = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 1 } };
    const binding = (connectionId: string, quote: string) => ({ effectPath: "onTraverse[0]", eventSlot: { kind: "connection", connectionId, outcome: "traverse", effectIndex: 0 }, source: { statementId, quote } });
    resolution.value = { connections: [
      { toSceneCandidateId: alpha.id, connectionId: "alpha_edge", onTraverse: [effect], actorEffectProvenance: [binding("alpha_edge", "Alpha invokes SAN 1/1")] },
      // Same numeric pair, but the source quote proves Alpha rather than Beta.
      { toSceneCandidateId: beta.id, connectionId: "beta_edge", onTraverse: [effect], actorEffectProvenance: [binding("beta_edge", "Alpha invokes SAN 1/1")] },
    ] };
    expect(() => parseCompilerHintValue(question, resolution.value, graph)).toThrow("destination scene");
  });

  it("rejects a source quote whose target heading also contains another topology slot heading", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages", moduleId: "source-bound-sanity-overlapping-targets", sourceDescriptor: "source-bound-sanity-overlapping-targets",
      pages: ["Entry:\nRed Room: invokes SAN 1/1.\nRoom:\nThe plain room.\nRed Room:\nThe red room.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."],
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const currentHints: any = hints(prepared, []);
    const { graph, draft, preparedQueue } = prepared.artifact.payload;
    const entry = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry");
    const room = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Room")), "room");
    const redRoom = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Red Room")), "red room");
    const question = required(preparedQueue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === entry.id), "entry topology");
    const resolution = required(currentHints.resolutions.find((candidate: any) => candidate.questionId === question.id), "entry topology resolution");
    const statementId = required(question.sourceStatementIds.find((id) => required(graph.statements.find((statement) => statement.id === id), "overlapping source").text.includes("Red Room: invokes")), "overlapping SAN statement");
    const effect = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 1 } };
    resolution.value = { connections: [
      { toSceneCandidateId: room.id, connectionId: "room_edge", onTraverse: [effect], actorEffectProvenance: [{ effectPath: "onTraverse[0]", eventSlot: { kind: "connection", connectionId: "room_edge", outcome: "traverse", effectIndex: 0 }, source: { statementId, quote: "Red Room: invokes SAN 1/1" } }] },
      { toSceneCandidateId: redRoom.id, connectionId: "red_room_edge" },
    ] };
    expect(() => parseCompilerHintValue(question, resolution.value, graph)).toThrow("destination scene");
  });

  it("rejects an unmarked discovery success binding backed by a failure declaration", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages", moduleId: "source-bound-sanity-discovery-branch", sourceDescriptor: "source-bound-sanity-discovery-branch",
      pages: ["Entry:\nOn success SAN 1/1; on failure SAN 1/1.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."],
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const graph = prepared.artifact.payload.graph;
    const entry = required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry scene");
    const exit = required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit scene");
    const topology = required(prepared.artifact.payload.preparedQueue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === entry.id), "entry topology");
    const question: CompilerQuestion = { ...topology, kind: "discovery_method", subjectCandidateId: exit.id, allowedCandidateIds: [exit.id], allowedLocationCandidateIds: [entry.id], allowedMechanicsTargetIds: { scene: [entry.id] } };
    const statementId = required(question.sourceStatementIds.find((id) => required(graph.statements.find((statement) => statement.id === id), "discovery source").text.includes("failure SAN")), "discovery SAN statement");
    const value = {
      clueCandidateId: exit.id, locationSceneCandidateId: entry.id,
      spec: { kind: "discovery_method", id: "inspect_exit", clueId: exit.id, action: "observe", target: "scene", targetId: entry.id, check: { kind: "skill", skill: "spot_hidden", difficulty: "regular" }, onSuccess: [{ kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 1 } }, { kind: "discover_clue", clueId: exit.id }] },
      actorEffectProvenance: [{ effectPath: "onSuccess[0]", eventSlot: { kind: "discovery", mechanismId: "inspect_exit", outcome: "success", effectIndex: 0 }, source: { statementId, quote: "failure SAN 1/1" } }],
    };
    expect(() => parseCompilerHintValue(question, value, graph)).toThrow("discovery branch");
  });

  it("requires a branch marker only when a discovery actually has a check", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages", moduleId: "source-bound-sanity-checked-semantics", sourceDescriptor: "source-bound-sanity-checked-semantics",
      pages: ["Entry:\nThe mirror invokes SAN 1/1.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."],
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const { graph, draft, preparedQueue } = prepared.artifact.payload;
    const entry = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry scene");
    const exit = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit scene");
    const topology = required(preparedQueue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === entry.id), "entry topology");
    const question: CompilerQuestion = { ...topology, kind: "discovery_method", subjectCandidateId: exit.id, allowedCandidateIds: [exit.id], allowedLocationCandidateIds: [entry.id], allowedMechanicsTargetIds: { scene: [entry.id] } };
    const statementId = required(question.sourceStatementIds.find((id) => required(graph.statements.find((statement) => statement.id === id), "unchecked discovery source").text.includes("SAN 1/1")), "unchecked SAN statement");
    const value: any = {
      clueCandidateId: exit.id, locationSceneCandidateId: entry.id,
      spec: { kind: "discovery_method", id: "inspect_exit", clueId: exit.id, action: "observe", target: "scene", targetId: entry.id, onSuccess: [{ kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 1 } }, { kind: "discover_clue", clueId: exit.id }] },
      actorEffectProvenance: [{ effectPath: "onSuccess[0]", eventSlot: { kind: "discovery", mechanismId: "inspect_exit", outcome: "success", effectIndex: 0 }, source: { statementId, quote: "SAN 1/1" } }],
    };
    expect(() => parseCompilerHintValue(question, value, graph)).not.toThrow();
    value.spec.check = { kind: "skill", skill: "spot_hidden", difficulty: "regular" };
    expect(() => parseCompilerHintValue(question, value, graph)).toThrow("discovery branch");
  });

  it("rejects checked discovery quotes that name mutually exclusive branches, including failback and Chinese labels", async () => {
    const cases = [
      { label: "success-failure", quote: "On success or failure, SAN 1/1 twice.", outcomes: ["success", "failure"] },
      { label: "success-failback", quote: "On success or failback, SAN 1/1 twice.", outcomes: ["success", "failback"] },
      { label: "chinese", quote: "\u6210\u529f\u6216\u5931\u8d25\uff0cSAN 1/1 twice.", outcomes: ["success", "failure"] },
    ] as const;
    const effect = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 1 } };
    for (const fixture of cases) {
      const outcomes: readonly string[] = fixture.outcomes;
      const prepared = await prepareCompiler({
        kind: "synthetic_pages", moduleId: `source-bound-sanity-discovery-mutually-exclusive-${fixture.label}`, sourceDescriptor: `source-bound-sanity-discovery-mutually-exclusive-${fixture.label}`,
        pages: [`Entry:\n${fixture.quote}\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation.`],
      });
      if (prepared.status !== "prepared") throw new Error(prepared.message);
      const { graph, draft, preparedQueue } = prepared.artifact.payload;
      const entry = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry scene");
      const exit = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit scene");
      const topology = required(preparedQueue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === entry.id), "entry topology");
      const question: CompilerQuestion = { ...topology, kind: "discovery_method", subjectCandidateId: exit.id, allowedCandidateIds: [exit.id], allowedLocationCandidateIds: [entry.id], allowedMechanicsTargetIds: { scene: [entry.id] } };
      const statementId = required(question.sourceStatementIds.find((id) => required(graph.statements.find((statement) => statement.id === id), "discovery source").text.includes(fixture.quote)), "discovery SAN statement");
      const branches: any = {
        onSuccess: [effect, { kind: "discover_clue", clueId: exit.id }],
        ...(outcomes.includes("failure") ? { onFailure: [effect] } : {}),
        ...(outcomes.includes("failback") ? { failback: { maxFailures: 1, effects: [effect] } } : {}),
      };
      const bindings = outcomes.map((outcome) => ({
        effectPath: outcome === "failback" ? "failback.effects[0]" : outcome === "success" ? "onSuccess[0]" : "onFailure[0]",
        eventSlot: { kind: "discovery", mechanismId: "inspect_exit", outcome, effectIndex: 0 },
        source: { statementId, quote: fixture.quote },
      }));
      const value = {
        clueCandidateId: exit.id, locationSceneCandidateId: entry.id,
        spec: { kind: "discovery_method", id: "inspect_exit", clueId: exit.id, action: "observe", target: "scene", targetId: entry.id, check: { kind: "skill", skill: "spot_hidden", difficulty: "regular" }, ...branches },
        actorEffectProvenance: bindings,
      };
      expect(() => parseCompilerHintValue(question, value, graph)).toThrow("discovery branch");
    }
  });

  it("does not permit one un-repeated declaration to feed two effect slots", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-bound-sanity-slot-consumption", sourceDescriptor: "source-bound-sanity-slot-consumption", pages: ["Entry:\nThe mirror invokes SAN 1/1.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."] });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const currentHints: any = hints(prepared, []);
    const graph = prepared.artifact.payload.graph;
    const question = required(prepared.artifact.payload.preparedQueue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry").id), "entry topology");
    const resolution = required(currentHints.resolutions.find((candidate: any) => candidate.questionId === question.id), "entry topology resolution");
    const exit = required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit");
    const statementId = required(question.sourceStatementIds.find((id) => required(graph.statements.find((statement) => statement.id === id), "consumption source").text.includes("SAN 1/1")), "consumption statement");
    const effect = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 1 } };
    resolution.value = { connections: [{ toSceneCandidateId: exit.id, connectionId: "mirror_road", onTraverse: [effect, effect], actorEffectProvenance: [
      { effectPath: "onTraverse[0]", eventSlot: { kind: "connection", connectionId: "mirror_road", outcome: "traverse", effectIndex: 0 }, source: { statementId, quote: "SAN 1/1" } },
      { effectPath: "onTraverse[1]", eventSlot: { kind: "connection", connectionId: "mirror_road", outcome: "traverse", effectIndex: 1 }, source: { statementId, quote: "SAN 1/1" } },
    ] }] };
    expect(() => parseCompilerHintValue(question, resolution.value, graph)).toThrow("consumed");
  });

  it("consumes each exact SAN declaration across the actual resolved queue, including overlapping quote substrings", async () => {
    const makeHints = async (label: string, declaration: string, topologySlots: number) => {
      const prepared = await prepareCompiler({
        kind: "synthetic_pages", moduleId: `source-bound-sanity-global-${label}`, sourceDescriptor: `source-bound-sanity-global-${label}`,
        pages: [`Entry:\n▶Fuzu Film: Fuzu Film invokes ${declaration}.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation.`],
      });
      if (prepared.status !== "prepared") throw new Error(prepared.message);
      const { graph, draft, preparedQueue } = prepared.artifact.payload;
      const entry = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry");
      const exit = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit");
      const clue = required(draft.clueCandidates[0], "Fuzu Film clue");
      const topology = required(preparedQueue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === entry.id), "entry topology");
      const discovery = required(preparedQueue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === clue.id), "Fuzu Film discovery");
      const statementId = required(topology.sourceStatementIds.find((id) => discovery.sourceStatementIds.includes(id) && required(graph.statements.find((statement) => statement.id === id), "shared Fuzu Film source").text.includes("SAN 1/1")), "shared topology/discovery source");
      const effect = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 1 } };
      const topQuote = `Fuzu Film invokes ${declaration}`;
      const discoveryQuote = declaration;
      const topologyValue = { connections: [{ toSceneCandidateId: exit.id, connectionId: "fuzu_path", onTraverse: Array.from({ length: topologySlots }, () => effect), actorEffectProvenance: Array.from({ length: topologySlots }, (_, effectIndex) => ({ effectPath: `onTraverse[${effectIndex}]`, eventSlot: { kind: "connection", connectionId: "fuzu_path", outcome: "traverse", effectIndex }, source: { statementId, quote: topQuote } })) }] };
      const discoveryValue = {
        clueCandidateId: clue.id, locationSceneCandidateId: entry.id,
        spec: { kind: "discovery_method", id: "inspect_fuzu_film", clueId: clue.id, action: "observe", target: "scene", targetId: entry.id, onSuccess: [effect, { kind: "discover_clue", clueId: clue.id }] },
        actorEffectProvenance: [{ effectPath: "onSuccess[0]", eventSlot: { kind: "discovery", mechanismId: "inspect_fuzu_film", outcome: "success", effectIndex: 0 }, source: { statementId, quote: discoveryQuote } }],
      };
      const hints: ModuleCompileHints = { schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION, moduleId: preparedQueue.moduleId, documentHash: preparedQueue.documentHash, sourceGraphIdentity: preparedQueue.sourceGraphIdentity, resolutions: [answer(topology, topologyValue), answer(discovery, discoveryValue)] };
      return { graph, queue: preparedQueue, hints };
    };
    const once = await makeHints("once", "SAN 1/1", 1);
    expect(() => validateModuleCompileHints(once.queue, once.hints, once.graph)).toThrow("consumed");

    const twice = await makeHints("twice", "SAN 1/1 twice", 1);
    expect(() => validateModuleCompileHints(twice.queue, twice.hints, twice.graph)).not.toThrow();

    const third = await makeHints("third", "SAN 1/1 twice", 2);
    expect(() => validateModuleCompileHints(third.queue, third.hints, third.graph)).toThrow("consumed");
  });

  it("does not treat an unrelated English or Chinese repetition word as SAN declaration capacity", async () => {
    for (const [label, quote] of [
      ["english", "The ritual happened twice; SAN 1/1"],
      ["chinese", "The ritual happened \u4e24\u6b21; SAN 1/1"],
    ] as const) {
      const prepared = await prepareCompiler({
        kind: "synthetic_pages", moduleId: `source-bound-sanity-unrelated-repeat-${label}`, sourceDescriptor: `source-bound-sanity-unrelated-repeat-${label}`,
        pages: [`Entry:\n${quote}.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation.`],
      });
      if (prepared.status !== "prepared") throw new Error(prepared.message);
      const currentHints: any = hints(prepared, []);
      const { graph, draft, preparedQueue } = prepared.artifact.payload;
      const entry = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry");
      const exit = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit");
      const question = required(preparedQueue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === entry.id), "entry topology");
      const resolution = required(currentHints.resolutions.find((candidate: any) => candidate.questionId === question.id), "entry topology resolution");
      const statementId = required(question.sourceStatementIds.find((id) => required(graph.statements.find((statement) => statement.id === id), "repeat source").text.includes(quote)), "repeat SAN statement");
      const effect = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 1 } };
      resolution.value = { connections: [{ toSceneCandidateId: exit.id, connectionId: "repeat_path", onTraverse: [effect, effect], actorEffectProvenance: [
        { effectPath: "onTraverse[0]", eventSlot: { kind: "connection", connectionId: "repeat_path", outcome: "traverse", effectIndex: 0 }, source: { statementId, quote } },
        { effectPath: "onTraverse[1]", eventSlot: { kind: "connection", connectionId: "repeat_path", outcome: "traverse", effectIndex: 1 }, source: { statementId, quote } },
      ] }] };
      expect(() => parseCompilerHintValue(question, resolution.value, graph)).toThrow("consumed");
    }
  });

  it("does not let a truncated quote hide an adjacent SAN repeat declaration", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages", moduleId: "source-bound-sanity-truncated-repeat", sourceDescriptor: "source-bound-sanity-truncated-repeat",
      pages: ["Entry:\nprefix SAN 1/1 twice suffix\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."],
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const currentHints: any = hints(prepared, []);
    const { graph, draft, preparedQueue } = prepared.artifact.payload;
    const entry = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry");
    const exit = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit");
    const question = required(preparedQueue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === entry.id), "entry topology");
    const resolution = required(currentHints.resolutions.find((candidate: any) => candidate.questionId === question.id), "entry topology resolution");
    const statementId = required(question.sourceStatementIds.find((id) => required(graph.statements.find((statement) => statement.id === id), "truncated repeat source").text.includes("SAN 1/1 twice")), "truncated repeat statement");
    const effect = { kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "fixed", amount: 1 } };
    const binding = (effectIndex: number, quote: string) => ({ effectPath: `onTraverse[${effectIndex}]`, eventSlot: { kind: "connection", connectionId: "repeat_path", outcome: "traverse", effectIndex }, source: { statementId, quote } });
    resolution.value = { connections: [{ toSceneCandidateId: exit.id, connectionId: "repeat_path", onTraverse: [effect, effect], actorEffectProvenance: [binding(0, "SAN 1/1 twice"), binding(1, "SAN 1/1")] }] };
    expect(() => parseCompilerHintValue(question, resolution.value, graph)).toThrow("cover its declared loss pair");
  });

  it("rejects every tampered SAN slot identity field before resolution", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-bound-sanity-slot-tamper", sourceDescriptor: "source-bound-sanity-slot-tamper", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const original = hints(prepared);
    const { graph, question, resolution } = sourceTopology(prepared, original);
    const mutations: Array<(binding: any) => void> = [
      (binding) => { binding.source.statementId = "foreign_statement"; },
      (binding) => { binding.source.quote = "SAN 1/1"; },
      (binding) => { binding.effectPath = "onTraverse[99]"; },
      (binding) => { binding.eventSlot.connectionId = "wrong_connection"; },
      (binding) => { binding.eventSlot.outcome = "success"; },
    ];
    for (const mutate of mutations) {
      const forged: any = structuredClone(resolution.value);
      mutate(forged.connections[0].actorEffectProvenance[0]);
      expect(() => parseCompilerHintValue(question, forged, graph)).toThrow();
    }
  });

  it("rejects extra or orphan actor-effect provenance in the queue value parser", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-bound-sanity-orphan-provenance", sourceDescriptor: "source-bound-sanity-orphan-provenance", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const currentHints = hints(prepared);
    const { graph, question, resolution } = sourceTopology(prepared, currentHints);
    const extra: any = structuredClone(resolution.value);
    extra.connections[0].actorEffectProvenance.push(structuredClone(extra.connections[0].actorEffectProvenance[0]));
    expect(() => parseCompilerHintValue(question, extra, graph)).toThrow("exactly one actor-effect provenance");

    const entry = required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entry")), "entry");
    const exit = required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit");
    const topology = required(prepared.artifact.payload.preparedQueue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === entry.id), "entry topology");
    const statementId = topology.sourceStatementIds[0]!;
    const orphan = { connections: [{ toSceneCandidateId: exit.id, connectionId: "orphan_path", onTraverse: [{ kind: "unlock_connection", connectionId: "orphan_path" }], actorEffectProvenance: [
      { effectPath: "onTraverse[0]", eventSlot: { kind: "connection", connectionId: "orphan_path", outcome: "traverse", effectIndex: 0 }, source: { statementId, quote: required(graph.statements.find((statement) => statement.id === statementId), "orphan source").text } },
    ] }] };
    expect(() => parseCompilerHintValue(topology, orphan, graph)).toThrow("allowed only for a SAN effect slot");
  });

  it("accepts explicit repeated, Chinese, and subset source SAN declarations", async () => {
    const chinese = await prepareCompiler({
      kind: "synthetic_pages", moduleId: "source-bound-sanity-chinese", sourceDescriptor: "source-bound-sanity-chinese",
      pages: ["Entry:\n恐惧令调查员承受理智 1 / 1D10。\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."],
    });
    if (chinese.status !== "prepared") throw new Error(chinese.message);
    const chineseHints = hints(chinese, [{ kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "dice", count: 1, sides: 10 } }]);
    const chineseResolved = resolveCompiler(chinese.artifact, chinese.identity.preparedQueueHash, chineseHints);
    if (chineseResolved.status !== "resolved") throw new Error(chineseResolved.message);
    expect(required((chineseResolved.artifact.payload as ResolvedCompilerArtifactPayload).mechanicsIR.connections.find((connection) => connection.connectionId === "mirror_road"), "Chinese SAN gate").onTraverse).toContainEqual({ kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "dice", count: 1, sides: 10 } });

    const subset = await prepareCompiler({
      kind: "synthetic_pages", moduleId: "source-bound-sanity-subset", sourceDescriptor: "source-bound-sanity-subset",
      pages: ["Entry:\nThe mirror causes SAN 1d6/10; a later omen causes SAN 2/2.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."],
    });
    if (subset.status !== "prepared") throw new Error(subset.message);
    expect(resolveCompiler(subset.artifact, subset.identity.preparedQueueHash, hints(subset, [SAN_1D6_10])).status).toBe("resolved");
  });

  it("accepts labelled Chinese and SAN sanity-check declarations enclosed in Chinese or ASCII punctuation", async () => {
    for (const [label, statement] of [
      ["chinese", "\u89c2\u5f71\u5b8c\u6bd5\u4e4b\u540e\uff0c\u8c03\u67e5\u5458\u4eec\u9700\u8981\u6295\u7406\u667a\u9274\u5b9a\uff081 / 1d3\uff09\u3002"],
      ["ascii", "The mirror calls for SAN loss (1 / 1d3)."],
    ] as const) {
      const prepared = await prepareCompiler({
        kind: "synthetic_pages", moduleId: `source-bound-sanity-${label}-check`, sourceDescriptor: `source-bound-sanity-${label}-check`,
        pages: [`Entry:\n${statement}\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation.`],
      });
      if (prepared.status !== "prepared") throw new Error(prepared.message);
      const currentHints = hints(prepared, [{
        kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "dice", count: 1, sides: 3 },
      }]);
      const { graph, question, resolution } = sourceTopology(prepared, currentHints);
      expect(() => parseCompilerHintValue(question, resolution.value, graph)).not.toThrow();
      expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, currentHints).status).toBe("resolved");
    }
  });

  it("fails closed for unclosed or interrupted parenthesized SAN pairs", async () => {
    for (const [label, statement] of [
      ["unclosed", "\u7406\u667a\u9274\u5b9a\uff081 / 1d3\u3002"],
      ["interrupted", "SAN loss (1 / unrelated text / 1d3)."],
    ] as const) {
      const prepared = await prepareCompiler({
        kind: "synthetic_pages", moduleId: `source-bound-sanity-${label}-pair`, sourceDescriptor: `source-bound-sanity-${label}-pair`,
        pages: [`Entry:\n${statement}\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation.`],
      });
      if (prepared.status !== "prepared") throw new Error(prepared.message);
      const currentHints = hints(prepared, [{
        kind: "sanity_check", passLoss: { kind: "fixed", amount: 1 }, failLoss: { kind: "dice", count: 1, sides: 3 },
      }]);
      const { graph, question, resolution } = sourceTopology(prepared, currentHints);
      expect(() => parseCompilerHintValue(question, resolution.value, graph)).toThrow("source declaration mismatch");
      expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, currentHints).status).toBe("refused");
    }
  });

  it("does not infer a SAN loss from recovery, unlabeled numbers, another question scope, or a graphless parser call", async () => {
    const cases = [
      { label: "recovery", pages: ["Entry:\nThe mirror grants SAN +1.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."] },
      { label: "unlabeled", pages: ["Entry:\nThe mirror exacts 1/1d10.\nExit:\nThe road home lies beyond the gate.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."] },
      { label: "foreign scope", pages: ["Entry:\nThe mirror is silent.\nExit:\nThe road exacts SAN 1d6/10.\nRewards:\nSAN +1\nCM +1\nCR +1\nEnding:\nLeaving ends the investigation."] },
    ];
    for (const fixture of cases) {
      const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: `source-bound-sanity-${fixture.label}`, sourceDescriptor: `source-bound-sanity-${fixture.label}`, pages: fixture.pages });
      if (prepared.status !== "prepared") throw new Error(prepared.message);
      const currentHints = hints(prepared, [SAN_1D6_10]);
      const { graph, question, resolution } = sourceTopology(prepared, currentHints);
      expect(() => parseCompilerHintValue(question, resolution.value, graph)).toThrow("source declaration mismatch");
      expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, currentHints).status).toBe("refused");
    }
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-bound-sanity-graphless", sourceDescriptor: "source-bound-sanity-graphless", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const currentHints = hints(prepared);
    const { question, resolution } = sourceTopology(prepared, currentHints);
    expect(() => parseCompilerHintValue(question, resolution.value)).toThrow("source graph is required");
  });

  it("carries source-explicit SAN losses into selected mixed traversal effects, insanity, durable replay, then terminal reward settlement", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-bound-sanity", sourceDescriptor: "source-bound-sanity", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const currentHints = hints(prepared);
    for (const legacySchemaVersion of ["1.3.0", "1.4.0"] as const) {
      expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, { ...currentHints, schemaVersion: legacySchemaVersion }).status).toBe("refused");
    }
    const proposedSanityHints: any = structuredClone(currentHints);
    const topology = proposedSanityHints.resolutions.find((resolution: any) => resolution.kind === "connection_topology" && resolution.value.connections.some((connection: any) => connection.onTraverse?.some((effect: any) => effect.kind === "sanity_check")));
    topology.reviewerKind = "approved_policy";
    topology.policyId = "untrusted-model";
    topology.audit = { kind: "compiler_hint_proposal", schemaVersion: "1.0.0", proposalId: "model-san", policyId: "untrusted-model", citations: [] };
    expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, proposedSanityHints).status).toBe("refused");
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, currentHints);
    if (resolved.status !== "resolved") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const gate = required(payload.mechanicsIR.connections.find((connection) => connection.connectionId === "mirror_road"), "gate");
    expect(gate.onTraverse).toEqual([
      { kind: "unlock_connection", connectionId: "mirror_road" },
      { kind: "sanity_check", passLoss: { kind: "dice", count: 1, sides: 6 }, failLoss: { kind: "fixed", amount: 10 } },
      { kind: "sanity_check", passLoss: { kind: "fixed", amount: 10 }, failLoss: { kind: "fixed", amount: 10 } },
      { kind: "sanity_check", passLoss: { kind: "fixed", amount: 10 }, failLoss: { kind: "fixed", amount: 10 } },
    ]);
    expect(gate.actorEffectProvenance).toEqual([
      expect.objectContaining({ effectPath: "onTraverse[1]", eventSlot: { kind: "connection", connectionId: "mirror_road", outcome: "traverse", effectIndex: 1 }, source: expect.objectContaining({ quote: "SAN 1d6/10" }) }),
      expect.objectContaining({ effectPath: "onTraverse[2]", eventSlot: { kind: "connection", connectionId: "mirror_road", outcome: "traverse", effectIndex: 2 }, source: expect.objectContaining({ quote: "SAN 10/10 twice" }) }),
      expect.objectContaining({ effectPath: "onTraverse[3]", eventSlot: { kind: "connection", connectionId: "mirror_road", outcome: "traverse", effectIndex: 3 }, source: expect.objectContaining({ quote: "SAN 10/10 twice" }) }),
    ]);
    const sourceStatementIds = new Set(payload.acceptedInterpretations.filter((entry) => gate.sourceInterpretationIds.includes(entry.id)).flatMap((entry) => entry.sourceStatementIds));
    expect([...sourceStatementIds].some((id) => required(payload.graph.statements.find((statement) => statement.id === id), "SAN source statement").text.includes("SAN 1d6/10"))).toBe(true);
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status !== "projected") throw new Error(projection.message);
    const root = mkdtempSync(join(tmpdir(), "source-bound-sanity-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = catalog.saveBundle(resolved.artifact, projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      // Standalone GameSession durable replay fixture.
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
      const host = createCompiledDurableTestHost();
      const session = new GameSession("source-bound-sanity", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", host.runtimeDependencies);
      expect(session.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
      const initial = host.snapshot(session);
      expect(snapshots.save(initial).status).toBe("ok"); host.acknowledge(session, initial);
      const committed = host.commit(session, compiledMechanicsAction(gate.id), "leave", 0, (snapshot) => { const result = snapshots.save(snapshot); if (result.status !== "ok") throw new Error(result.message); });
      expect(committed.status).toBe("committed");
      if (committed.status !== "committed") return;
      const action = committed.response.action as any;
      expect(action.sanityCheckSettlements).toHaveLength(3);
      expect(action.sanityCheckSettlements.map((entry: any) => entry.effectIndex)).toEqual([1, 2, 3]);
      expect(action.sanityCheckSettlements.every((entry: any) => entry.outcome === "traverse" && entry.sourceInterpretationIds.join(",") === gate.sourceInterpretationIds.join(","))).toBe(true);
      expect(action.sanityCheckSettlements.map((entry: any) => entry.provenance.effectPath)).toEqual(["onTraverse[1]", "onTraverse[2]", "onTraverse[3]"]);
      expect(action.sanityCheckSettlements[0]).toMatchObject({ mechanismId: gate.id, declared: { passLoss: { kind: "dice", count: 1, sides: 6 }, failLoss: { kind: "fixed", amount: 10 } } });
      expect(action.sanityCheckSettlements[0].check.selectedLoss.kind).toMatch(/dice|fixed/);
      expect(action.sanityCheckSettlements[0].check.appliedLoss).toBe(action.sanityCheckSettlements[0].check.total);
      expect(action.sanityCheckSettlements.slice(1).every((entry: any) => entry.check.total === 10 && entry.check.appliedLoss === 10)).toBe(true);
      expect(action.sanity.temporaryInsanity).toBe(true);
      expect(action.sanity.indefiniteInsanity).toBe(true);
      const rewardSettlement = action.rewardSettlements[0];
      const lossAfter = (initial.character.sanity as any).currentSAN - action.sanityCheckSettlements.reduce((total: number, entry: any) => total + entry.check.appliedLoss, 0);
      expect(rewardSettlement.san).toMatchObject({ kind: "fixed", total: 1, before: lossAfter, after: lossAfter + 1 });
      expect(action.sanity.currentSAN).toBe(rewardSettlement.san.after);
      const indefinite = required(action.sanityCheckSettlements.find((entry: any) => entry.madness.indefiniteInsanityTriggered), "indefinite sanity settlement");
      expect(action.sanity.indefiniteLevel).toBe(indefinite.madness.indefiniteLevel);
      expect(["mild", "moderate", "severe"]).toContain(indefinite.madness.indefiniteLevel);
      const restoredHost = createCompiledDurableTestHost();
      const restored = new GameSession("source-bound-sanity", "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(root, "restored-careers") }, undefined, "preferred", restoredHost.runtimeDependencies);
      expect(restored.restoreCompiledSession(committed.snapshot!, bundle.value).status).toBe("loaded");
      expect(restored.getSanity().currentSAN).toBe(action.sanity.currentSAN);
      const duplicate = restoredHost.commit(restored, compiledMechanicsAction(gate.id), "leave", 0, () => {});
      expect(duplicate.status).toBe("duplicate");
      if (duplicate.status !== "duplicate") throw new Error("SAN action retry was not idempotent");
      expect((duplicate.response.action as any).sanityCheckSettlements).toEqual(action.sanityCheckSettlements);
      const workerProof = await freshSanityWorker({ root, sessionId: session.id, bundleId: bundle.value.id, input: compiledMechanicsAction(gate.id), actionId: "leave" });
      expect(workerProof).toMatchObject({ sanity: expect.objectContaining(action.sanity), duplicate: action });
      const mutations: Array<(snapshot: any) => void> = [
        (snapshot) => { snapshot.idempotency[0].response.action.sanityCheckSettlements[0].check.roll = 101; },
        (snapshot) => { snapshot.idempotency[0].response.action.sanityCheckSettlements[0].check.appliedLoss -= 1; },
        (snapshot) => { snapshot.idempotency[0].response.action.sanityCheckSettlements[0].beforeSanityHash = "0".repeat(64); },
        (snapshot) => { snapshot.idempotency[0].response.action.sanityCheckSettlements[0].provenance.source.quote = "SAN 1/1"; },
        (snapshot) => { snapshot.idempotency[0].response.action.sanityCheckSettlements[0].provenance.eventSlot.connectionId = "wrong_connection"; },
        (snapshot) => { const entry = snapshot.idempotency[0].response.action.sanityCheckSettlements.find((candidate: any) => candidate.madness.indefiniteInsanityTriggered); entry.madness.indefiniteLevel = null; },
        (snapshot) => { snapshot.idempotency[0].response.action.sanity.indefiniteLevel = null; },
        (snapshot) => { snapshot.character.sanity.currentSAN += 1; },
        (snapshot) => { snapshot.idempotency.push(structuredClone(snapshot.idempotency[0])); snapshot.idempotency[1].generation = 2; snapshot.idempotency[1].expectedGeneration = 1; },
      ];
      for (const [mutationIndex, mutate] of mutations.entries()) {
        const forged = structuredClone(committed.snapshot!);
        mutate(forged); forged.snapshotHash = compiledSessionSnapshotHash(forged);
        const rejected = new GameSession("source-bound-sanity", "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(root, `forged-${mutationIndex}`) });
        const worldBefore = rejected.world.exportSnapshot();
        const result = rejected.restoreCompiledSession(forged, bundle.value);
        if (result.status !== "refused") throw new Error(`tamper ${mutationIndex} unexpectedly restored`);
        expect(rejected.world.exportSnapshot()).toEqual(worldBefore);
        rejected.close();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not report a pre-existing symptom as a new insanity delta", () => {
    const real = Math.random;
    try {
      Math.random = () => 0.99;
      const sanity = new SanityEngine(60);
      sanity.restoreState({ ...sanity.state, phobias: ["old-phobia"], manias: ["old-mania"] });
      const result = sanity.applyLoss(5);
      expect(result.temporaryInsanityTriggered).toBe(true);
      expect(result.newPhobia).toBeUndefined();
      expect(result.newMania).toBeUndefined();
    } finally { Math.random = real; }
  });
});
