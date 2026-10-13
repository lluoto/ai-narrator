import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession, compiledMechanicsAction } from "../api/game-session";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotHash } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { applyTerminalRewards, initialMechanicsState, settleInitialMechanics } from "../compiler/mechanics-execution";
import { resolveDraftModule } from "../compiler/compile-hint-resolution";
import { projectResolvedCompilerArtifact, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { parseCompilerHintValue, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const PAGES = [
  "Entrance:\nThe rain has stopped at the manor gate.\nExit:\nA road home lies beyond the gate.\nAttic:\nA sealed door remains upstairs.\nRewards:\nSAN +1d6\nCM +2\nCR +3\nEnding:\nLeaving the gate ends the investigation.",
];

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
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
    reason: "source-bound reward end-to-end fixture",
  };
}

function rewardHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const entrance = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entrance")), "entrance scene");
  const exit = required(draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit")), "exit scene");
  const sanReward = required(draft.rewardCandidates.find((candidate) => {
    const row = prepared.artifact.payload.graph.statements.find((statement) => statement.id === candidate.tableRowStatementId);
    return row?.text.includes("SAN");
  }), "SAN table-row reward candidate");
  const cmReward = required(draft.rewardCandidates.find((candidate) => {
    const row = prepared.artifact.payload.graph.statements.find((statement) => statement.id === candidate.tableRowStatementId);
    return row?.text.includes("CM");
  }), "CM table-row reward candidate");
  const creditReward = required(draft.rewardCandidates.find((candidate) => {
    const row = prepared.artifact.payload.graph.statements.find((statement) => statement.id === candidate.tableRowStatementId);
    return row?.text.includes("CR");
  }), "CR table-row reward candidate");
  const question = (kind: CompilerQuestion["kind"], subject?: string) => required(queue.questions.find((entry) => entry.kind === kind && (subject === undefined || entry.subjectCandidateId === subject)), `${kind} question`);
  const topology = (sceneId: string) => question("connection_topology", sceneId);
  return {
    schemaVersion: "1.4.0",
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...draft.sceneCandidates.map((scene) => answer(question("scene_role", scene.id), { role: scene.id === entrance.id || scene.id === exit.id ? "playable_scene" : "other" })),
      answer(question("entry_scene"), { sceneCandidateId: entrance.id }),
      ...draft.sceneCandidates.map((scene) => answer(topology(scene.id), { connections: scene.id === entrance.id ? [{ toSceneCandidateId: exit.id, connectionId: "reward_exit" }] : [] })),
      answer(question("ending_rule"), {
        declarations: [{
          endingId: "reward_escape",
          spec: {
            kind: "ending_rule",
            id: "reward_escape_rule",
            priority: 1,
            when: { kind: "scene_visited", sceneId: exit.id },
            effects: [{ kind: "end_game", endingId: "reward_escape" }],
          },
        }],
      }),
      answer(question("reward_binding", sanReward.id), {
        rewardCandidateId: sanReward.id,
        declaration: {
          when: { kind: "scene_visited", sceneId: exit.id },
          settlement: { san: { kind: "dice", count: 1, sides: 6 } },
        },
      }),
      answer(question("reward_binding", cmReward.id), {
        rewardCandidateId: cmReward.id,
        declaration: {
          when: { kind: "scene_visited", sceneId: exit.id },
          settlement: { cthulhuMythos: 2 },
        },
      }),
      answer(question("reward_binding", creditReward.id), {
        rewardCandidateId: creditReward.id,
        declaration: {
          when: { kind: "scene_visited", sceneId: exit.id },
          settlement: { reputation: 3 },
        },
      }),
    ],
  };
}

/**
 * Rebind the real, source-bound table rewards to an ending which is true when
 * the entry scene is installed.  This keeps the queue, evidence, and reward
 * declarations real while exercising the initial automatic-settlement path.
 */
function initialTerminalRewardHints(prepared: PreparedCompilerApiResult, includeRewards: boolean): ModuleCompileHints {
  const hints = rewardHints(prepared);
  const entrance = required(prepared.artifact.payload.draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Entrance")), "entrance scene");
  const ending = required(hints.resolutions.find((resolution) => resolution.kind === "ending_rule"), "ending resolution");
  const endingValue = ending.value as { declarations: Array<{ spec: { when: unknown } }> };
  endingValue.declarations[0]!.spec.when = { kind: "scene_visited", sceneId: entrance.id };
  for (const resolution of hints.resolutions.filter((entry) => entry.kind === "reward_binding")) {
    const value = resolution.value as { declaration: null | { when: unknown } };
    if (value.declaration) value.declaration = includeRewards
      ? { ...value.declaration, when: { kind: "scene_visited", sceneId: entrance.id } }
      : null;
  }
  return hints;
}

async function freshRewardWorker(request: { root: string; sessionId: string; bundleId: string; input: string; actionId: string }): Promise<{ sanity: number; maxSan: number; cthulhuMythos: number; creditRating: number; duplicate: unknown }> {
  const worker = new Worker(new URL("./compiler-source-bound-rewards-child.ts", import.meta.url).href, { type: "module" });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error("reward restart worker timed out")); }, 10_000);
      worker.onmessage = (event: MessageEvent<{ status: "ok"; proof: Awaited<ReturnType<typeof freshRewardWorker>> } | { status: "error"; message: string }>) => {
        clearTimeout(timeout);
        if (event.data.status === "ok") resolve(event.data.proof);
        else reject(new Error(event.data.message));
      };
      worker.onerror = (event: ErrorEvent) => { clearTimeout(timeout); reject(new Error(event.message || "reward restart worker failed")); };
      worker.postMessage(request);
    });
  } finally {
    worker.terminate();
  }
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  return {
    module: { title: "Table reward", version: "1", ruleset: "cosmic-horror", era: "modern", summary: "table reward", playerCount: "1", expectedDuration: "short", triggerWarnings: ["none"] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: `Source scene ${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: "Source gate" }])),
    clues: {},
    endings: { reward_escape: { name: "Escape", description: "You escape the manor.", conditions: ["Reach exit"] } },
  };
}

describe("source-bound terminal rewards", () => {
  it("admits only source-evidenced supported positive reward settlements", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "reward-candidate-eligibility",
      sourceDescriptor: "reward-candidate-eligibility",
      pages: [
        "Rewards:\nSAN +1d6\nCM +2\nCR +3\nSAN 50\nCM 0\nCR 0\nHP +10\nAttack +1d6\nSAN loss 1d6\nDamage 1d6",
        "角色属性：\nSAN +1d6\nCM +2\nCR +3\n奖励：理智恢复1d6\n结算：克苏鲁神话 +2\n恢复声望 +3\n生命值+10\n攻击 +1d6",
        "SAN +1d6\nCM +2\nCR +3\nAfterword:\nNo heading scopes the preceding rows.",
      ],
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const candidateRows = prepared.artifact.payload.draft.rewardCandidates.map((candidate) => {
      const row = prepared.artifact.payload.graph.statements.find((statement) => statement.id === candidate.tableRowStatementId);
      if (!row) throw new Error("reward candidate row missing");
      return row.text;
    }).sort();

    expect(candidateRows).toEqual([
      "SAN +1d6",
      "CM +2",
      "CR +3",
      "奖励：理智恢复1d6",
      "结算：克苏鲁神话 +2",
      "恢复声望 +3",
    ].sort());
    expect(prepared.questions.filter((question) => question.kind === "reward_binding")).toHaveLength(6);
  });

  it("requires whole bounded settlement tokens while allowing bare values only with reward context", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "reward-candidate-token-boundaries",
      sourceDescriptor: "reward-candidate-token-boundaries",
      pages: [
        "Rewards:\nSAN = 1d6\nCM = 2\nCR = 3\nSAN +1d6 after escaping\nCM +2 for surviving\nCR +3 (finale)\nCM +2%\nCR +3%\nSAN +1d6%\nSAN +1/1d6",
        "Stats:\nSAN = 50\nCM = 2\nCR = 3\nReward SAN = 1d6",
      ],
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const candidateRows = prepared.artifact.payload.draft.rewardCandidates.map((candidate) => {
      const row = prepared.artifact.payload.graph.statements.find((statement) => statement.id === candidate.tableRowStatementId);
      if (!row) throw new Error("reward candidate row missing");
      return row.text;
    }).sort();

    expect(candidateRows).toEqual([
      "SAN = 1d6",
      "CM = 2",
      "CR = 3",
      "SAN +1d6 after escaping",
      "CM +2 for surviving",
      "CR +3 (finale)",
      "Reward SAN = 1d6",
    ].sort());
  });

  it("does not promote a structural table row that has no verifiable heading scope", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "unscoped-source-bound-reward",
      sourceDescriptor: "unscoped-source-bound-reward",
      pages: ["SAN +1d6\nCM +2\nCR +3\nIntroduction:\nThis heading follows the table."],
    });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    expect(prepared.artifact.payload.graph.statements.filter((statement) => statement.kind === "table_row")).toHaveLength(3);
    expect(prepared.artifact.payload.draft.rewardCandidates).toEqual([]);
    expect(prepared.questions.some((question) => question.kind === "reward_binding")).toBe(false);
  });

  it("refuses initial automatic terminal rewards before they can reach a runtime that requires player-action settlement", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "initial-source-bound-reward", sourceDescriptor: "initial-source-bound-reward", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const hints = initialTerminalRewardHints(prepared, true);
    const direct = resolveDraftModule(
      prepared.artifact.payload.graph,
      prepared.artifact.payload.draft,
      prepared.artifact.payload.preparedQueue,
      hints,
    );
    if (!direct.mechanicsIR || !direct.analysisInput) throw new Error("initial-terminal fixture did not compile mechanics");
    const initial = settleInitialMechanics(direct.mechanicsIR, direct.analysisInput);
    expect(initial.state.terminalEndingId).toBe("reward_escape");
    expect(initial.state.rewardIds).toHaveLength(3);
    expect(direct.reachabilityReport?.reachableEndingIds).toEqual(["reward_escape"]);

    const published = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    // This branch documents the pre-fix split: the runtime rejected an artifact
    // that the compiler had labelled mechanically closed.  It is unreachable
    // once the closure guard below is in place.
    if (published.status === "resolved") {
      const payload = published.artifact.payload as ResolvedCompilerArtifactPayload;
      const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
      if (projection.status !== "projected") throw new Error(projection.message);
      const root = mkdtempSync(join(tmpdir(), "initial-source-bound-reward-"));
      try {
        const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
        const saved = catalog.saveBundle(published.artifact, projection);
        if (saved.status !== "ok") throw new Error(saved.message);
        const bundle = catalog.loadBundle(saved.value.id);
        if (bundle.status !== "ok") throw new Error(bundle.message);
        const session = new GameSession("initial-source-bound-reward", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(root, "careers") });
        expect(session.loadDurableCompiledModule(bundle.value)).toMatchObject({
          status: "refused",
          message: expect.stringContaining("player-action terminal settlement"),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    expect(direct.readiness).toMatchObject({
      status: "draft_only",
      blockingCodes: expect.arrayContaining(["initial_terminal_rewards_unsupported"]),
    });
    expect(published).toMatchObject({ status: "refused", code: "RESOLVE_NOT_PUBLISHABLE" });
  });

  it("keeps a reward-free initial automatic ending publishable and loadable", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "initial-terminal-without-rewards", sourceDescriptor: "initial-terminal-without-rewards", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, initialTerminalRewardHints(prepared, false));
    if (resolved.status !== "resolved") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    expect(payload.mechanicsIR.rewards).toEqual([]);
    const initial = settleInitialMechanics(payload.mechanicsIR, payload.analysisInput);
    expect(initial.state).toMatchObject({ terminalEndingId: "reward_escape", rewardIds: [] });
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status !== "projected") throw new Error(projection.message);
    const root = mkdtempSync(join(tmpdir(), "initial-terminal-without-rewards-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = catalog.saveBundle(resolved.artifact, projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const session = new GameSession("initial-terminal-without-rewards", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(root, "careers") });
      expect(session.loadDurableCompiledModule(bundle.value)).toMatchObject({
        status: "loaded",
        compiled: { state: { terminalEndingId: "reward_escape", rewardIds: [] } },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries a structural table row through queue, terminal catalog, durable d6/CM/credit settlement, restart, and tamper rejection", async () => {
    const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "source-bound-reward", sourceDescriptor: "source-bound-reward", pages: PAGES });
    if (prepared.status !== "prepared") throw new Error(prepared.message);
    expect(prepared.artifact.payload.draft.rewardCandidates).toHaveLength(3);
    const sanCandidate = required(prepared.artifact.payload.draft.rewardCandidates.find((candidate) => {
      const row = prepared.artifact.payload.graph.statements.find((statement) => statement.id === candidate.tableRowStatementId);
      return row?.text.includes("SAN");
    }), "SAN table-row reward candidate");
    const cmCandidate = required(prepared.artifact.payload.draft.rewardCandidates.find((candidate) => {
      const row = prepared.artifact.payload.graph.statements.find((statement) => statement.id === candidate.tableRowStatementId);
      return row?.text.includes("CM");
    }), "CM table-row reward candidate");
    const creditCandidate = required(prepared.artifact.payload.draft.rewardCandidates.find((candidate) => {
      const row = prepared.artifact.payload.graph.statements.find((statement) => statement.id === candidate.tableRowStatementId);
      return row?.text.includes("CR");
    }), "CR table-row reward candidate");
    const rewardQuestion = required(prepared.questions.find((question) => question.kind === "reward_binding" && question.subjectCandidateId === sanCandidate.id), "reward question");
    const rewardId = required(rewardQuestion.subjectCandidateId, "reward subject");
    expect(rewardQuestion.severity).toBe("draft_warning");
    expect(rewardQuestion.sourceStatementIds).toHaveLength(2);
    expect(() => parseCompilerHintValue(rewardQuestion, { rewardCandidateId: "forged", declaration: null }, prepared.artifact.payload.graph)).toThrow("unallowed");
    expect(() => parseCompilerHintValue(rewardQuestion, { rewardCandidateId: rewardId, declaration: { when: { kind: "state_eq", stateKey: "forged", value: true }, settlement: { san: { kind: "fixed", amount: 1 } } } }, prepared.artifact.payload.graph)).toThrow("unsupported predicate");
    expect(() => parseCompilerHintValue(rewardQuestion, { rewardCandidateId: rewardId, declaration: { when: { kind: "scene_visited", sceneId: "forged" }, settlement: { san: { kind: "fixed", amount: -1 } } } }, prepared.artifact.payload.graph)).toThrow("positive fixed");

    const crossRowHints = rewardHints(prepared);
    const crossRowResolution = required(crossRowHints.resolutions.find((resolution) => resolution.kind === "reward_binding" && (resolution.value as any).rewardCandidateId === rewardId), "reward resolution");
    const anotherRow = required(prepared.artifact.payload.draft.rewardCandidates.find((candidate) => candidate.id !== rewardId), "another source row");
    crossRowResolution.sourceStatementIds = [anotherRow.headingStatementId, anotherRow.tableRowStatementId];
    expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, crossRowHints).status).toBe("refused");
    const crossDocumentHints = rewardHints(prepared);
    crossDocumentHints.documentHash = "forged-document";
    expect(resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, crossDocumentHints)).toMatchObject({ status: "refused", code: "RESOLVE_DOCUMENT_IDENTITY_MISMATCH" });

    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, rewardHints(prepared));
    if (resolved.status !== "resolved") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    expect(payload.mechanicsIR.rewards).toHaveLength(3);
    expect(payload.mechanicsIR.rewards.map((reward) => reward.id).sort()).toEqual([sanCandidate.id, cmCandidate.id, creditCandidate.id].sort());
    for (const candidate of [sanCandidate, cmCandidate, creditCandidate]) {
      const definition = required(payload.mechanicsIR.rewards.find((reward) => reward.id === candidate.id), `reward definition ${candidate.id}`);
      expect(definition.sourceInterpretationIds).toHaveLength(1);
      const binding = required(payload.rewardBindings.find((entry) => entry.rewardCandidateId === candidate.id), `reward binding ${candidate.id}`);
      expect(binding.tableRowStatementId).toBe(candidate.tableRowStatementId);
      expect(binding.headingStatementId).toBe(candidate.headingStatementId);
      expect(binding.declaration).not.toBeNull();
    }
    const falseTerminal = applyTerminalRewards(payload.mechanicsIR, {
      ...initialMechanicsState(payload.analysisInput),
      terminalEndingId: "reward_escape",
    });
    expect(falseTerminal.rewardIds).toEqual([]);
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status !== "projected") throw new Error(projection.message);

    const root = mkdtempSync(join(tmpdir(), "source-bound-reward-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = catalog.saveBundle(resolved.artifact, projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      // Standalone GameSession durable replay fixture.
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
      const host = createCompiledDurableTestHost();
      const session = new GameSession("source-bound-reward", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", host.runtimeDependencies);
      expect(session.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
      const initial = host.snapshot(session);
      expect(snapshots.save(initial).status).toBe("ok");
      host.acknowledge(session, initial);
      const gate = required(payload.mechanicsIR.connections.find((connection) => connection.connectionId === "reward_exit"), "exit gate");
      const committed = host.commit(session, compiledMechanicsAction(gate.id), "leave", 0, (snapshot) => {
        const result = snapshots.save(snapshot);
        if (result.status !== "ok") throw new Error(result.message);
      });
      expect(committed.status).toBe("committed");
      if (committed.status !== "committed") throw new Error("reward action did not commit");
      const action = committed.response.action as any;
      const settlements = action.rewardSettlements as any[];
      expect(settlements).toHaveLength(3);
      const sanSettlement = required(settlements.find((entry) => entry.rewardId === sanCandidate.id), "SAN settlement");
      const cmSettlement = required(settlements.find((entry) => entry.rewardId === cmCandidate.id), "CM settlement");
      const creditSettlement = required(settlements.find((entry) => entry.rewardId === creditCandidate.id), "credit settlement");
      expect(sanSettlement.san).toMatchObject({ kind: "dice", count: 1, sides: 6 });
      expect(sanSettlement.san.rolls[0]).toBeGreaterThanOrEqual(1);
      expect(sanSettlement.san.rolls[0]).toBeLessThanOrEqual(6);
      expect(sanSettlement.cthulhuMythos).toBeUndefined();
      expect(sanSettlement.reputation).toBeUndefined();
      expect(cmSettlement.cthulhuMythos).toMatchObject({ delta: 2 });
      expect(cmSettlement.san).toBeUndefined();
      expect(cmSettlement.reputation).toBeUndefined();
      expect(cmSettlement.cthulhuMythos.maxSanAfter).toBe(Math.min(cmSettlement.cthulhuMythos.maxSanBefore, 99 - cmSettlement.cthulhuMythos.after));
      expect(cmSettlement.cthulhuMythos.currentSanAfter).toBeLessThanOrEqual(cmSettlement.cthulhuMythos.maxSanAfter);
      expect(sanSettlement.san.before).toBe(cmSettlement.cthulhuMythos.currentSanAfter);
      expect(creditSettlement.reputation).toMatchObject({ delta: 3 });
      expect(creditSettlement.san).toBeUndefined();
      expect(creditSettlement.cthulhuMythos).toBeUndefined();
      expect(action.compiled.state.rewardIds).toEqual([sanCandidate.id, cmCandidate.id, creditCandidate.id].sort());

      const restoredHost = createCompiledDurableTestHost();
      const restored = new GameSession("source-bound-reward", "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(root, "restored-careers") }, undefined, "preferred", restoredHost.runtimeDependencies);
      expect(restored.restoreCompiledSession(committed.snapshot!, bundle.value).status).toBe("loaded");
      expect(restored.getSanity().currentSAN).toBe(sanSettlement.san.after);
      expect(restored.getSanity().maxSAN).toBe(cmSettlement.cthulhuMythos.maxSanAfter);
      expect((restored as any).activeCharacter.cthulhuMythos).toBe(cmSettlement.cthulhuMythos.after);
      expect((restored as any).activeCharacter.creditRating).toBe(creditSettlement.reputation.after);
      const duplicate = restoredHost.commit(restored, compiledMechanicsAction(gate.id), "leave", 0, () => {});
      expect(duplicate.status).toBe("duplicate");
      if (duplicate.status !== "duplicate") throw new Error("reward retry was not idempotent");
      expect((duplicate.response.action as any).rewardSettlements).toEqual(action.rewardSettlements);

      const workerProof = await freshRewardWorker({ root, sessionId: session.id, bundleId: bundle.value.id, input: compiledMechanicsAction(gate.id), actionId: "leave" });
      expect(workerProof).toMatchObject({ sanity: sanSettlement.san.after, maxSan: cmSettlement.cthulhuMythos.maxSanAfter, cthulhuMythos: cmSettlement.cthulhuMythos.after, creditRating: creditSettlement.reputation.after, duplicate: action });

      const mutations: Array<(snapshot: any) => void> = [
        (snapshot) => { snapshot.idempotency[0].response.action.compiled.state.rewardIds = ["forged_reward"]; },
        (snapshot) => { snapshot.idempotency[0].response.action.rewardSettlements.find((entry: any) => entry.rewardId === sanCandidate.id).rewardId = "forged_reward"; },
        (snapshot) => {
          const rolls = snapshot.idempotency[0].response.action.rewardSettlements.find((entry: any) => entry.rewardId === sanCandidate.id).san.rolls;
          rolls[0] = rolls[0] === 6 ? 5 : 6;
        },
        (snapshot) => { snapshot.idempotency[0].response.action.rewardSettlements.find((entry: any) => entry.rewardId === cmCandidate.id).cthulhuMythos.delta += 1; },
        (snapshot) => { snapshot.idempotency[0].response.action.rewardSettlements.find((entry: any) => entry.rewardId === cmCandidate.id).cthulhuMythos.before += 1; },
        (snapshot) => { snapshot.idempotency[0].response.action.rewardSettlements.push(structuredClone(snapshot.idempotency[0].response.action.rewardSettlements.find((entry: any) => entry.rewardId === sanCandidate.id))); },
        (snapshot) => { snapshot.idempotency[0].characterBefore.sheet.creditRating += 1; },
        (snapshot) => { snapshot.character.sheet.creditRating += 1; },
        (snapshot) => { snapshot.character.sanity.currentSAN = Math.max(0, snapshot.character.sanity.currentSAN - 1); },
      ];
      for (const mutate of mutations) {
        const forged = structuredClone(committed.snapshot!);
        mutate(forged);
        forged.snapshotHash = compiledSessionSnapshotHash(forged);
        const rejected = new GameSession("source-bound-reward-forged", "cosmic-horror", CONFIG, undefined, undefined, undefined, { careerRoot: join(root, "forged-careers") });
        const worldBefore = rejected.world.exportSnapshot();
        expect(rejected.restoreCompiledSession(forged, bundle.value).status).toBe("refused");
        expect(rejected.world.exportSnapshot()).toEqual(worldBefore);
        rejected.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
