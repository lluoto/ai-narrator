import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import {
  createMechanicsStateBudget,
  executeMechanicsAction,
  initialMechanicsState,
  mechanicsStateHash,
  settleAutomaticMechanics,
} from "../compiler/mechanics-execution";
import { projectResolvedCompilerArtifact, type CompilerModuleDataProjection, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { compiledMechanicsAction, GameSession } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash, type OrdinarySnapshotJson } from "../api/ordinary-game-session-snapshot";
import { runGameSessionScript } from "../diagnostics/game-session-run-harness";
import { patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";

const PAGES = ["入口：\n▶父线索：一把档案室钥匙。\n档案室：\n▶子线索：一份必须读懂的档案。\n出口：\n▶出口说明：离开这里的旧车票。"];
const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 512, temperature: 0.7 };

function withFixedNow<T>(now: number, operation: () => T): T {
  const original = Date.now;
  Date.now = () => now;
  try {
    return operation();
  } finally {
    Date.now = original;
  }
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
    reason: "compiler GameSession integration fixture",
  };
}

function hints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const scene = (name: string) => draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(name))!;
  const clue = (name: string) => draft.clueCandidates.find((candidate) => candidate.displayName === name)!;
  const entry = scene("入口"), archive = scene("档案室"), exit = scene("出口"), parent = clue("父线索"), child = clue("子线索");
  const topology = (id: string) => queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === id)!;
  const core = (id: string) => queue.questions.find((question) => question.kind === "core_clue" && question.subjectCandidateId === id)!;
  const discovery = (id: string) => queue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === id)!;
  const entryQuestion = queue.questions.find((question) => question.kind === "entry_scene")!;
  const endingQuestion = queue.questions.find((question) => question.kind === "ending_rule")!;
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => answer(question, {
        shell: (question.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [],
      })),
      ...queue.questions.filter((question) => question.kind === "scene_role").map((question) => answer(question, { role: "playable_scene" })),
      answer(entryQuestion, { sceneCandidateId: entry.id }),
      answer(topology(entry.id), { connections: [{ toSceneCandidateId: archive.id, connectionId: "entry_archive", availability: { kind: "connection_unlocked", connectionId: "entry_archive" } }] }),
      answer(topology(archive.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "archive_exit" }] }),
      answer(topology(exit.id), { connections: [] }),
      answer(core(parent.id), { clueCandidateId: parent.id, required: false }),
      answer(core(child.id), { clueCandidateId: child.id, required: true }),
      answer(discovery(parent.id), { clueCandidateId: parent.id, locationSceneCandidateId: entry.id, spec: {
        kind: "discovery_method", id: "find_parent", clueId: parent.id, action: "search", target: "scene", targetId: entry.id,
        onSuccess: [{ kind: "discover_clue", clueId: parent.id }, { kind: "unlock_connection", connectionId: "entry_archive" }],
      } }),
      answer(discovery(child.id), { clueCandidateId: child.id, locationSceneCandidateId: archive.id, spec: {
        kind: "discovery_method", id: "find_child", clueId: child.id, action: "read", target: "scene", targetId: archive.id,
        availability: { kind: "clue_found", clueId: parent.id }, check: { kind: "skill", skill: "library_use", difficulty: "hard" },
        onSuccess: [{ kind: "discover_clue", clueId: child.id }],
        failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: child.id }] },
      } }),
      answer(endingQuestion, { declarations: [
        {
          endingId: "compiled_clean_escape",
          spec: {
            kind: "ending_rule", id: "rule_clean_escape", priority: 10,
            when: { kind: "all", predicates: [{ kind: "clue_found", clueId: child.id }, { kind: "scene_visited", sceneId: exit.id }] },
            effects: [{ kind: "end_game", endingId: "compiled_clean_escape" }],
          },
        },
        {
          endingId: "compiled_hasty_exit",
          spec: {
            kind: "ending_rule", id: "rule_hasty_exit", priority: 20,
            when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "not", predicate: { kind: "clue_found", clueId: child.id } }] },
            effects: [{ kind: "end_game", endingId: "compiled_hasty_exit" }],
          },
        },
      ] }),
    ],
  };
}

async function fixture(): Promise<{ payload: ResolvedCompilerArtifactPayload; projection: CompilerModuleDataProjection }> {
  const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "compiled-game-session", sourceDescriptor: "compiled-game-session", pages: PAGES });
  if (prepared.status === "refused") throw new Error(prepared.message);
  const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints(prepared));
  if (resolved.status === "refused") throw new Error(resolved.message);
  const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
  const facetRevelations = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    if (binding.shellAtoms.length || binding.findings.length) facetRevelations.set(binding.clueId, binding.shellAtoms.map((atom) => atom.quote).join("\n") || payload.draft.clueCandidates.find((candidate) => candidate.id === binding.clueId)!.displayName);
    for (const finding of binding.findings) facetRevelations.set(finding.clueId, finding.atoms.map((atom) => atom.quote).join("\n"));
  }
  const metadata: ModuleDataPresentationMetadata = {
    module: { title: "Compiled session", version: "1", ruleset: "cosmic-horror", era: "test", summary: "validated presentation", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: `scene:${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: `connection:${connection.id}` }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => [id, { findMethods: [], revelation: facetRevelations.get(id) ?? `revelation:${id}`, unlocks: [], importance: "core" }])),
    endings: {
      compiled_clean_escape: { name: "Clean escape", description: "Validated ending narration.", conditions: ["all core clues found"] },
      compiled_hasty_exit: { name: "Hasty exit", description: "Hasty validated ending narration.", conditions: ["left without core clue"] },
    },
  };
  const projection = projectResolvedCompilerArtifact(payload, metadata);
  if (projection.status === "refused") throw new Error(projection.message);
  return { payload, projection };
}

function session(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "调查员");
}

/** Compiled checks read the persisted p1 sheet, so seed it before loading through the ordinary portable boundary. */
function sessionWithSkills(id: string, skillValues: Record<string, number>): GameSession {
  const source = session(id);
  const snapshot = source.exportOrdinarySessionSnapshot();
  const p1 = snapshot.state.characters.find((entry) => entry.pcId === "p1");
  if (!p1 || p1.sheet === null || Array.isArray(p1.sheet) || typeof p1.sheet !== "object") throw new Error("fixture requires p1 sheet");
  const sheet = p1.sheet as Record<string, OrdinarySnapshotJson>;
  if (sheet.skillValues === null || Array.isArray(sheet.skillValues) || typeof sheet.skillValues !== "object") throw new Error("fixture requires p1 skillValues");
  Object.assign(sheet.skillValues as Record<string, OrdinarySnapshotJson>, skillValues);
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const replacement = new GameSession(id, "cosmic-horror", CONFIG);
  replacement.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
  source.close();
  return replacement;
}

function ids(payload: ResolvedCompilerArtifactPayload) {
  const parent = payload.mechanicsIR.discoveryMethods.find((method) => method.id === "find_parent")!;
  const child = payload.mechanicsIR.discoveryMethods.find((method) => method.id === "find_child")!;
  const entryGate = payload.mechanicsIR.connections.find((connection) => connection.connectionId === "entry_archive")!;
  const exitGate = payload.mechanicsIR.connections.find((connection) => connection.connectionId === "archive_exit")!;
  return { parent: parent.id, child: child.id, entryGate: entryGate.id, exitGate: exitGate.id };
}

async function unlockAndEnter(target: GameSession, payload: ResolvedCompilerArtifactPayload): Promise<void> {
  const action = ids(payload);
  expect((await target.act(compiledMechanicsAction(action.parent))).error).toBeUndefined();
  expect((await target.act(compiledMechanicsAction(action.entryGate))).error).toBeUndefined();
}

async function withRandom<T>(value: number, run: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = () => value;
  try {
    return await run();
  } finally {
    Math.random = original;
  }
}

describe("compiled GameSession integration", () => {
  it("dynamically loads a validated projection at its explicit entry rather than presentation order", async () => {
    const { payload, projection } = await fixture();
    const reordered = structuredClone(projection);
    reordered.module.scenes.reverse();
    const target = session("compiled-entry");

    const loaded = target.loadCompiledModule(payload, reordered);

    expect(loaded.status).toBe("loaded");
    expect(target.getState().scene).toBe(payload.analysisInput.entrySceneId);
    expect(target.getCompiledMechanicsState()?.state.currentSceneId).toBe(payload.analysisInput.entrySceneId);
  });

  it("rolls back a failed direct projection install before allowing the same target to retry", async () => {
    const { payload, projection } = await fixture();
    const target = session("compiled-direct-install-atomicity");
    const ordinaryBefore = target.exportOrdinarySessionSnapshot();
    const before = {
      state: target.getState(),
      scenes: target.world.listScenes(),
      displayNames: ordinaryBefore.state.sceneDisplayNames,
      aliases: ordinaryBefore.state.sceneAliases,
      sceneItems: ordinaryBefore.state.sceneItems,
    };
    const restoreSetActiveScene = patchGameSessionWorldMethod(target, "setActiveScene", () => false);
    try {
      expect(target.loadCompiledModule(payload, projection).status).toBe("refused");
      expect(target.getCompiledMechanicsState()).toBeNull();
      expect(target.getCompiledGeneration()).toBeNull();
      expect(target.getState()).toEqual(before.state);
      expect(target.world.listScenes()).toEqual(before.scenes);
      expect(target.exportOrdinarySessionSnapshot().state.sceneDisplayNames).toEqual(before.displayNames);
      expect(target.exportOrdinarySessionSnapshot().state.sceneAliases).toEqual(before.aliases);
      expect(target.exportOrdinarySessionSnapshot().state.sceneItems).toEqual(before.sceneItems);
    } finally {
      restoreSetActiveScene();
    }
    expect(target.loadCompiledModule(payload, projection).status).toBe("loaded");
  });

  it("uses exact gated topology and a real hard GameSession check instead of a preselected success", async () => {
    const { payload, projection } = await fixture();
    const target = sessionWithSkills("compiled-gate-check", { library_use: 80 });
    expect(target.loadCompiledModule(payload, projection).status).toBe("loaded");
    const action = ids(payload);

    expect((await target.act(compiledMechanicsAction(action.entryGate))).error?.code).toBe("compiled_action_unavailable");
    expect((await target.act(compiledMechanicsAction(action.parent))).error).toBeUndefined();
    const parentClueId = payload.mechanicsIR.discoveryMethods.find((method) => method.id === action.parent)!.clueId;
    expect(target.world.isClueDiscoveredBy(target.activePlayerId, parentClueId)).toBe(true);
    expect(target.investigation.isDiscoveredBy(parentClueId, target.activePlayerId)).toBe(true);
    expect((await target.act(compiledMechanicsAction(action.entryGate))).error).toBeUndefined();
    expect(target.getState().scene).toBe(payload.analysisInput.connections.find((connection) => connection.id === "entry_archive")!.toSceneId);
    const checked = await withRandom(0.4, () => target.act(compiledMechanicsAction(action.child)));

    const dice = checked.dice;
    const roll = dice?.[0];
    if (!dice || !roll) throw new Error("checked compiled action must report a dice roll");
    const wire = JSON.stringify(checked);
    expect(roll).toMatchObject({ total: 41, detail: "library_use/hard" });
    expect(Object.isFrozen(dice)).toBe(true);
    expect(Object.isFrozen(roll)).toBe(true);
    expect(Reflect.set(dice, 0, { expr: "d100", total: 1 })).toBe(false);
    expect(Reflect.set(roll, "total", 1)).toBe(false);
    expect(JSON.stringify(checked)).toBe(wire);
    expect(checked.compiled?.trace.at(-1)).toMatchObject({ mechanismId: action.child, outcome: "failure" });
    expect(checked.compiled?.state.foundClueIds).not.toContain(payload.mechanicsIR.discoveryMethods.find((method) => method.id === action.child)!.clueId);
  });

  it("executes N failures then declared failback, settles ending in the same act, and refuses terminal actions", async () => {
    const { payload, projection } = await fixture();
    const target = sessionWithSkills("compiled-failback-terminal", { library_use: 1 });
    expect(target.loadCompiledModule(payload, projection).status).toBe("loaded");
    const action = ids(payload);
    await unlockAndEnter(target, payload);
    await withRandom(0.5, () => target.act(compiledMechanicsAction(action.child)));
    await withRandom(0.5, () => target.act(compiledMechanicsAction(action.child)));
    const failback = await target.act(compiledMechanicsAction(action.child));
    expect(failback.compiled?.trace.slice(-3).map((edge) => `${edge.mechanismId}:${edge.outcome}`)).toEqual([
      `${action.child}:failure`, `${action.child}:failure`, `${action.child}:failback`,
    ]);

    const ending = await target.act(compiledMechanicsAction(action.exitGate));
    expect(ending.compiled?.terminalEnding).toEqual({ id: "compiled_clean_escape", name: "Clean escape", narration: "Validated ending narration." });
    expect(ending.narrative).toBe("Validated ending narration.");
    expect(ending.compiled?.trace.slice(-2).map((edge) => edge.outcome)).toEqual(["traverse", "ending"]);
    const before = target.getCompiledMechanicsState()!;
    const refused = await target.act(compiledMechanicsAction(action.parent));
    expect(refused.error?.code).toBe("compiled_terminal");
    expect(target.getCompiledMechanicsState()).toEqual(before);
  });

  it("has per-session MechanicsState and matches direct shared-core replay through the deterministic GameSession harness", async () => {
    const { payload, projection } = await fixture();
    const action = ids(payload);
    const target = sessionWithSkills("compiled-replay-a", { library_use: 100 });
    const other = session("compiled-replay-b");
    expect(target.loadCompiledModule(payload, projection).status).toBe("loaded");
    expect(other.loadCompiledModule(payload, projection).status).toBe("loaded");
    const run = await runGameSessionScript(target, [
      { input: compiledMechanicsAction(action.parent) },
      { input: compiledMechanicsAction(action.entryGate) },
      { input: compiledMechanicsAction(action.child) },
      { input: compiledMechanicsAction(action.exitGate) },
    ], { seed: 2, timeoutMs: 30_000, maxSteps: 4 });
    expect(run).toMatchObject({ threw: false, timedOut: false, hitStepCap: false });
    expect(run.draws).toBe(1);

    const snapshot = target.getCompiledMechanicsState()!;
    expect(snapshot.state.terminalEndingId).toBe("compiled_clean_escape");
    expect(other.getCompiledMechanicsState()?.state.foundClueIds).toEqual([]);
    expect(other.getCompiledMechanicsState()?.state).not.toBe(snapshot.state);

    const budget = createMechanicsStateBudget(payload.analysisInput.maxStates);
    let direct = settleAutomaticMechanics(payload.mechanicsIR, initialMechanicsState(payload.analysisInput), budget);
    const directTrace = [...direct.steps];
    for (const edge of snapshot.trace.filter((edge): edge is typeof edge & { outcome: "success" | "failure" | "failback" | "traverse" } => ["success", "failure", "failback", "traverse"].includes(edge.outcome))) {
      const executed = executeMechanicsAction(payload.mechanicsIR, payload.analysisInput, direct.state, edge);
      directTrace.push(executed.edge);
      budget.observe(executed.state);
      direct = settleAutomaticMechanics(payload.mechanicsIR, executed.state, budget);
      directTrace.push(...direct.steps);
    }
    expect(snapshot.trace.map((edge) => [edge.mechanismId, edge.beforeStateHash, edge.afterStateHash])).toEqual(
      directTrace.map((edge) => [edge.mechanismId, edge.beforeStateHash, edge.afterStateHash]),
    );
    expect(snapshot.stateHash).toBe(mechanicsStateHash(direct.state));
  });

  it("refuses tampered artifact, projection identity, and analysis input before any world host write", async () => {
    const { payload, projection } = await fixture();
    for (const [label, alteredPayload, alteredProjection] of [
      ["artifact", { ...structuredClone(payload), identity: { ...payload.identity, mechanicsHash: "tampered" } }, projection],
      ["projection", payload, { ...structuredClone(projection), artifact: { ...projection.artifact, identity: { ...projection.artifact.identity, mechanicsHash: "tampered" } } }],
      ["analysis", { ...structuredClone(payload), analysisInput: { ...payload.analysisInput, maxStates: 0 } }, projection],
    ] as const) {
      const target = session(`compiled-zero-write-${label}`);
      const worldBefore = target.world.exportSnapshot();
      expect(target.loadCompiledModule(alteredPayload as ResolvedCompilerArtifactPayload, alteredProjection as CompilerModuleDataProjection).status).toBe("refused");
      expect(target.world.exportSnapshot()).toEqual(worldBefore);
    }
  });

  it("rejects forged source text, fixed fields, and source-map origins before constructing runtime state", async () => {
    const { payload, projection } = await fixture();
    const sceneId = projection.module.scenes[0]!.id;
    const clue = projection.module.scenes[0]!.clues[0]!;
    const forged = [
      (() => { const value = structuredClone(projection); value.module.scenes[0]!.name = "forged scene"; return value; })(),
      (() => { const value = structuredClone(projection); value.module.scenes[0]!.clues[0]!.description = "forged clue"; return value; })(),
      (() => { const value = structuredClone(projection); value.sourceMap.scenes[sceneId]!.fields.name = { kind: "artifact", artifactPath: "forged" }; return value; })(),
      (() => { const value = structuredClone(projection); value.sourceMap.scenes[sceneId]!.clues[clue.id]!.fields.revelation = { kind: "caller_metadata", metadataPath: "forged" }; return value; })(),
      (() => { const value = structuredClone(projection); (value.module as any).ruleset = "dnd5e"; return value; })(),
      (() => { const value = structuredClone(projection); (value.module as any).npcs = [{ id: "forged" }]; return value; })(),
    ];
    for (const value of forged) {
      const target = session(`compiled-forged-${crypto.randomUUID()}`);
      expect(target.loadCompiledModule(payload, value).status).toBe("refused");
    }
  });

  it("refreshes activity only after an accepted compiled action", async () => {
    const { payload, projection } = await fixture();
    const target = withFixedNow(1, () => session(`compiled-activity-${crypto.randomUUID()}`));
    expect(target.loadCompiledModule(payload, projection).status).toBe("loaded");
    expect((await target.act(compiledMechanicsAction("not-available"))).error?.code).toBe("compiled_action_unavailable");
    expect(target.lastActiveAt).toBe(1);
    expect((await target.act(compiledMechanicsAction(ids(payload).parent))).error).toBeUndefined();
    expect(target.lastActiveAt).toBeGreaterThan(1);
  });

  it("keeps the shared-core call as a static mutation sentinel", () => {
    const source = readFileSync("src/api/game-session.ts", "utf8");
    const requiresSharedCore = (value: string) => /executeMechanicsAction\(\s*compiled\.payload\.mechanicsIR/.test(value)
      && /settleAutomaticMechanics\(\s*compiled\.payload\.mechanicsIR/.test(value);
    expect(requiresSharedCore(source)).toBe(true);
    expect(requiresSharedCore(source.replaceAll("executeMechanicsAction", "bypassedMechanicsAction"))).toBe(false);
  });
});
