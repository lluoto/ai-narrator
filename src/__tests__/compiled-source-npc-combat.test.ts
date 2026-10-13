import { describe, expect, it } from "bun:test";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, buildCompilerQuestionQueue, parseCompilerHintValue, validateCompilerQuestionQueue, validateModuleCompileHints, withQueueHash, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildSourceFactGraph } from "../compiler/source-fact-graph";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { initialMechanicsState, settleAutomaticMechanics } from "../compiler/mechanics-execution";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { projectResolvedCompilerArtifact, projectTrustedResolvedCompilerArtifact, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { GameSession } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash } from "../api/ordinary-game-session-snapshot";
import { worldStateSnapshotHash } from "../state/world-state-snapshot";
import { createCompiledSessionAccessBinding } from "../api/compiled-module-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotHash } from "../api/compiled-session-snapshot";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { allShellClueFactFacetResolutions, clueFactFacetRevelations } from "./helpers/clue-fact-facet-hints";
import { validateCompiledActionIntentRequest } from "../llm/compiled-action-intent";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

/**
 * A complete exchange: player critical versus an NPC regular dodge, then NPC
 * critical versus a failed player dodge. All-zero entropy made both sides
 * critical and relied on the old (incorrect) critical-ignores-dodge rule.
 */
function combatRuntime() {
  const units = [0, 0.2, 0, 0.2];
  let index = 0;
  return { compiledCombatRandom: () => units[index++ % units.length]! };
}

function sourceNpcCombatFixture() {
  const document = createSyntheticDocumentIR([
    "Dock:\nCaptain Mira waits beside the launch. HP 2. Dodge 30. Fight 40. Damage 1d2.\n▶Harbor Ledger: It records the launch manifest.\nExit:",
    "Warehouse:\n\u25b6 Foreign Ledger: It records a different manifest.",
  ], "source-npc-combat");
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const draft = compileDeterministicTemplates(graph, { moduleId: "source-npc-combat" });
  const anchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("Mira"))!;
  const queue = buildCompilerQuestionQueue(graph, draft);
  const question = queue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id)!;
  const stats = graph.statements.find((statement) => statement.id === anchor.paragraphStatementId)!;
  const clue = draft.clueCandidates.find((candidate) => candidate.sceneCandidateId === anchor.sceneCandidateId)!;
  const item = draft.itemCandidates.find((candidate) => candidate.sceneCandidateId === anchor.sceneCandidateId)!;
  const foreignClue = draft.clueCandidates.find((candidate) => candidate.id !== clue.id)!;
  return { graph, queue, anchor, question, stats, clue, item, foreignClue };
}

function sourceBoundVictoryEffect(
  graph: ReturnType<typeof sourceNpcCombatFixture>["graph"],
  headingStatementId: string,
  candidate: { id: string; markedItemStatementId: string },
  effect: unknown,
) {
  const statement = graph.statements.find((entry) => entry.id === candidate.markedItemStatementId)!;
  return {
    effect,
    evidence: {
      candidateId: candidate.id,
      headingStatementId,
      statementId: statement.id,
      quote: statement.text,
    },
  };
}

function mutableRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`expected ${label}`);
  return value as Record<string, unknown>;
}

/** Compiled combat reads its persisted p1 sheet, so seed it before compilation through the portable boundary. */
function compiledCombatSession(id: string, mutate: (sheet: Record<string, unknown>) => void): GameSession {
  const create = (archetype?: string, name?: string) => new GameSession(
    id,
    "cosmic-horror",
    { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 },
    archetype,
    name,
    undefined,
    undefined,
    undefined,
    "preferred",
    combatRuntime(),
  );
  const source = create("investigator", "Ada");
  const snapshot = source.exportOrdinarySessionSnapshot();
  const p1 = snapshot.state.characters.find((entry) => entry.pcId === "p1");
  if (!p1) throw new Error("compiled combat fixture requires p1");
  const sheet = mutableRecord(p1.sheet, "p1 sheet");
  mutate(sheet);
  if (typeof sheet.hp === "number" || typeof sheet.maxHp === "number") {
    const player = snapshot.world.tables.entities.find((entity) => entity.id === "p1");
    if (!player) throw new Error("compiled combat fixture requires p1 world entity");
    if (typeof sheet.hp === "number") player.hp = sheet.hp;
    if (typeof sheet.maxHp === "number") player.max_hp = sheet.maxHp;
    const { hash: _worldHash, ...unsignedWorld } = snapshot.world;
    snapshot.world = { ...unsignedWorld, hash: worldStateSnapshotHash(unsignedWorld) };
  }
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const target = create();
  target.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
  source.close();
  return target;
}

describe("source-bound NPC encounter declarations", () => {
  it("offers a named complete profile to the real NPC question and compiles its encounter in the anchor scene", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "cross-heading-npc-profile",
      sourceDescriptor: "cross-heading-npc-profile",
      pages: ["Dock:\nMira: blocks the launch ramp.\n▶Harbor Ledger: It records the launch manifest.\nMira:\nHP 4. Dodge 20. Fight 35. Damage 1d3.\nExit:"],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const { draft, graph, preparedQueue: queue } = prepared.artifact.payload;
    const anchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("Mira: blocks"))!;
    const question = queue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id)!;
    const profileHeading = graph.statements.find((statement) => statement.kind === "heading" && statement.text.trim() === "Mira:")!;
    const profileStats = graph.statements.find((statement) => statement.parentStatementId === profileHeading.id && statement.text.includes("HP 4"))!;
    const dockClue = draft.clueCandidates.find((candidate) => candidate.sceneCandidateId === anchor.sceneCandidateId)!;
    expect(question.sourceStatementIds).toEqual(expect.arrayContaining([profileHeading.id, profileStats.id]));

    const base = combatHints(prepared);
    const profileScene = draft.sceneCandidates.find((scene) => scene.headingStatementId === profileHeading.id)!;
    const profileTopology = queue.questions.find((candidate) => candidate.kind === "connection_topology" && candidate.subjectCandidateId === profileScene.id)!;
    const profileNpc = {
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira:",
        dialogueMethods: [],
        encounter: {
          maxHp: { statementId: profileStats.id, quote: "HP 4" },
          dodge: { statementId: profileStats.id, quote: "Dodge 20" },
          fight: { statementId: profileStats.id, quote: "Fight 35" },
          npcDamage: { statementId: profileStats.id, quote: "Damage 1d3" },
          victoryEffects: [sourceBoundVictoryEffect(graph, anchor.headingStatementId, dockClue, { kind: "discover_clue", clueId: dockClue.id })],
        },
      }],
    };
    const hints: ModuleCompileHints = {
      ...base,
      resolutions: [
        ...base.resolutions.filter((resolution) => resolution.questionId !== question.id),
        answer(profileTopology, { connections: [] }),
        answer(question, profileNpc),
      ],
    };
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints);
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const binding = payload.proseNpcBindings.find((npc) => npc.nameQuote === "Mira:")!;
    expect(binding.sceneCandidateId).toBe(anchor.sceneCandidateId);
    expect(binding.encounter).toMatchObject({ maxHp: 4, dodge: 20, fight: 35, npcDamage: { kind: "dice", count: 1, sides: 3 } });
    expect(binding.encounter?.sourceStatementIds).toEqual(expect.arrayContaining([profileHeading.id, profileStats.id]));
    const encounterSource = payload.acceptedInterpretations.find((candidate) => candidate.claim.path.startsWith("mechanics.encounter_definition."))!;
    expect(encounterSource.sourceStatementIds).toEqual(expect.arrayContaining([profileHeading.id, profileStats.id]));
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    expect(projection.status).toBe("projected");
  });

  it("requires one offered profile and its exact heading name, rejects incomplete profiles, and rejects a forged profile domain", () => {
    const document = createSyntheticDocumentIR([
      "Dock:\nMira: and Hale: block the launch ramp; Rook: watches.\n▶Harbor Ledger: It records the launch manifest.\nMira:\nHP 4. Dodge 20. Fight 35. Damage 1d3.\n▶Profile Ledger: It records the profile only.\nHale:\nHP 8. Dodge 40. Fight 55. Damage 2.\nRook:\nHP 3. Dodge 10. Fight 20.\nExit:",
    ], "cross-heading-npc-profile-negative");
    const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
    const draft = compileDeterministicTemplates(graph, { moduleId: "cross-heading-npc-profile-negative" });
    const queue = buildCompilerQuestionQueue(graph, draft);
    const anchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("Mira: and Hale:"))!;
    const question = queue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id)!;
    const heading = (name: string) => graph.statements.find((statement) => statement.kind === "heading" && statement.text.trim() === name)!;
    const stats = (name: string) => graph.statements.find((statement) => statement.parentStatementId === heading(name).id && statement.text.includes("HP"))!;
    expect(question.sourceStatementIds).toEqual(expect.arrayContaining([heading("Mira:").id, heading("Hale:").id]));
    expect(question.sourceStatementIds).not.toContain(heading("Rook:").id);
    const encounter = (nameQuote: string, statHeading: string, overrides: Partial<Record<"maxHp" | "dodge" | "fight" | "npcDamage", string>> = {}) => ({
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote,
        dialogueMethods: [],
        encounter: {
          maxHp: { statementId: stats(statHeading).id, quote: overrides.maxHp ?? (statHeading === "Mira:" ? "HP 4" : "HP 8") },
          dodge: { statementId: stats(statHeading).id, quote: overrides.dodge ?? (statHeading === "Mira:" ? "Dodge 20" : "Dodge 40") },
          fight: { statementId: stats(statHeading).id, quote: overrides.fight ?? (statHeading === "Mira:" ? "Fight 35" : "Fight 55") },
          npcDamage: { statementId: stats(statHeading).id, quote: overrides.npcDamage ?? (statHeading === "Mira:" ? "Damage 1d3" : "Damage 2") },
        },
      }],
    });
    expect(() => parseCompilerHintValue(question, encounter("Mira:", "Hale:"), graph)).toThrow();
    expect(() => parseCompilerHintValue(question, {
      ...encounter("Mira:", "Mira:"),
      presentNpcs: [{
        ...encounter("Mira:", "Mira:").presentNpcs[0],
        encounter: {
          ...encounter("Mira:", "Mira:").presentNpcs[0]!.encounter,
          npcDamage: { statementId: stats("Hale:").id, quote: "Damage 2" },
        },
      }],
    }, graph)).toThrow();
    const miraScene = draft.sceneCandidates.find((candidate) => candidate.headingStatementId === heading("Mira:").id)!;
    const profileClue = draft.clueCandidates.find((candidate) => candidate.sceneCandidateId === miraScene.id)!;
    const profileEncounter = encounter("Mira:", "Mira:");
    expect(() => parseCompilerHintValue(question, {
      ...profileEncounter,
      presentNpcs: [{
        ...profileEncounter.presentNpcs[0],
        encounter: {
          ...profileEncounter.presentNpcs[0]!.encounter,
          victoryEffects: [sourceBoundVictoryEffect(graph, heading("Mira:").id, profileClue, { kind: "discover_clue", clueId: profileClue.id })],
        },
      }],
    }, graph)).toThrow();
    const forged = structuredClone(question);
    forged.sourceStatementIds = [...question.sourceStatementIds, heading("Rook:").id].sort();
    forged.evidenceRefs = forged.sourceStatementIds.map((id) => graph.statements.find((statement) => statement.id === id)!.evidenceRefId);
    const forgedQueue = withQueueHash({ ...queue, questions: queue.questions.map((candidate) => candidate.id === question.id ? forged : candidate) });
    expect(() => validateCompilerQuestionQueue(graph, forgedQueue)).toThrow();
  });

  it("derives encounter and auto-start identities from a reviewed NPC binding and exact same-heading stat quotes", () => {
    const { graph, anchor, question, stats, clue } = sourceNpcCombatFixture();
    const parsed = parseCompilerHintValue(question, {
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [],
        encounter: {
          maxHp: { statementId: stats.id, quote: "HP 2" },
          dodge: { statementId: stats.id, quote: "Dodge 30" },
          fight: { statementId: stats.id, quote: "Fight 40" },
          npcDamage: { statementId: stats.id, quote: "Damage 1d2" },
          victoryEffects: [sourceBoundVictoryEffect(graph, anchor.headingStatementId, clue, { kind: "discover_clue", clueId: clue.id })],
        },
      }],
    }, graph);

    expect(parsed).toMatchObject({
      kind: "npc_binding",
      presentNpcs: [{
        nameQuote: "Mira",
        encounter: {
          sceneId: anchor.sceneCandidateId,
          combatantId: expect.stringMatching(/^npc_/),
          encounterId: expect.stringMatching(/^encounter_/),
          autoStartMechanismId: expect.stringMatching(/^start_encounter_/),
          maxHp: 2,
          dodge: 30,
          fight: 40,
          npcDamage: { kind: "dice", count: 1, sides: 2 },
        },
      }],
    });
  });

  it("rejects free numeric values, a foreign stat statement, and an ambiguous stat quote", () => {
    const { graph, anchor, question, stats, clue } = sourceNpcCombatFixture();
    const npc = (encounter: unknown) => ({ proseAnchorId: anchor.id, presentNpcs: [{ nameQuote: "Mira", dialogueMethods: [], encounter }] });
    const base = {
      maxHp: { statementId: stats.id, quote: "HP 2" },
      dodge: { statementId: stats.id, quote: "Dodge 30" },
      fight: { statementId: stats.id, quote: "Fight 40" },
      npcDamage: { statementId: stats.id, quote: "Damage 1d2" },
      victoryEffects: [sourceBoundVictoryEffect(graph, anchor.headingStatementId, clue, { kind: "discover_clue", clueId: clue.id })],
    };
    expect(() => parseCompilerHintValue(question, npc({ ...base, maxHp: { ...base.maxHp, value: 2 } }), graph)).toThrow("undeclared");
    expect(() => parseCompilerHintValue(question, npc({ ...base, dodge: { statementId: anchor.headingStatementId, quote: "30" } }), graph)).toThrow();
    expect(() => parseCompilerHintValue(question, npc({ ...base, fight: { statementId: stats.id, quote: "40" } }), graph)).toThrow();
  });

  it("binds each victory effect to a same-heading source candidate and rejects arbitrary declared targets", () => {
    const { graph, anchor, question, stats, clue, item } = sourceNpcCombatFixture();
    const encounter = (victoryEffects: unknown) => ({
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [],
        encounter: {
          maxHp: { statementId: stats.id, quote: "HP 2" },
          dodge: { statementId: stats.id, quote: "Dodge 30" },
          fight: { statementId: stats.id, quote: "Fight 40" },
          npcDamage: { statementId: stats.id, quote: "Damage 1d2" },
          victoryEffects,
        },
      }],
    });
    const legal = parseCompilerHintValue(question, encounter([
      sourceBoundVictoryEffect(graph, anchor.headingStatementId, clue, { kind: "discover_clue", clueId: clue.id }),
      sourceBoundVictoryEffect(graph, anchor.headingStatementId, item, { kind: "acquire_item", itemId: item.id }),
    ]), graph);
    expect(legal).toMatchObject({
      kind: "npc_binding",
      presentNpcs: [{ encounter: { victoryEffects: [{ kind: "discover_clue", clueId: clue.id }, { kind: "acquire_item", itemId: item.id }] } }],
    });

    expect(() => parseCompilerHintValue(question, encounter([
      sourceBoundVictoryEffect(graph, anchor.headingStatementId, clue, { kind: "discover_clue", clueId: "declared_without_evidence" }),
    ]), graph)).toThrow();
    expect(() => parseCompilerHintValue(question, encounter([
      sourceBoundVictoryEffect(graph, anchor.headingStatementId, item, { kind: "acquire_item", itemId: "declared_without_evidence" }),
    ]), graph)).toThrow();
    expect(() => parseCompilerHintValue(question, encounter([
      sourceBoundVictoryEffect(graph, anchor.headingStatementId, clue, { kind: "unlock_connection", connectionId: "declared_without_evidence" }),
    ]), graph)).toThrow();
    expect(() => parseCompilerHintValue(question, encounter([
      sourceBoundVictoryEffect(graph, anchor.headingStatementId, clue, { kind: "set_state", stateKey: "declared_without_evidence", value: true }),
    ]), graph)).toThrow();
  });

  it("rejects foreign statement, quote, heading, or candidate identity tampering in victory evidence", () => {
    const { graph, anchor, question, stats, clue, foreignClue } = sourceNpcCombatFixture();
    const valid = sourceBoundVictoryEffect(graph, anchor.headingStatementId, clue, { kind: "discover_clue", clueId: clue.id });
    const encounter = (victoryEffects: unknown) => ({
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [],
        encounter: {
          maxHp: { statementId: stats.id, quote: "HP 2" },
          dodge: { statementId: stats.id, quote: "Dodge 30" },
          fight: { statementId: stats.id, quote: "Fight 40" },
          npcDamage: { statementId: stats.id, quote: "Damage 1d2" },
          victoryEffects,
        },
      }],
    });
    const foreignStatement = graph.statements.find((statement) => statement.id === foreignClue.markedItemStatementId)!;
    const foreignHeading = graph.statements.find((statement) => statement.id === foreignStatement.parentStatementId)!;
    expect(() => parseCompilerHintValue(question, encounter([{ ...valid, evidence: { ...valid.evidence, statementId: foreignStatement.id, quote: foreignStatement.text } }]), graph)).toThrow();
    expect(() => parseCompilerHintValue(question, encounter([{ ...valid, evidence: { ...valid.evidence, quote: "Harbor Ledger" } }]), graph)).toThrow();
    expect(() => parseCompilerHintValue(question, encounter([{ ...valid, evidence: { ...valid.evidence, headingStatementId: foreignHeading.id } }]), graph)).toThrow();
    expect(() => parseCompilerHintValue(question, encounter([{ ...valid, evidence: { ...valid.evidence, candidateId: foreignClue.id } }]), graph)).toThrow();
  });

  it("keeps older source NPC encounter declarations without victoryEffects valid", () => {
    const { graph, anchor, question, stats } = sourceNpcCombatFixture();
    expect(parseCompilerHintValue(question, {
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [],
        encounter: {
          maxHp: { statementId: stats.id, quote: "HP 2" },
          dodge: { statementId: stats.id, quote: "Dodge 30" },
          fight: { statementId: stats.id, quote: "Fight 40" },
          npcDamage: { statementId: stats.id, quote: "Damage 1d2" },
        },
      }],
    }, graph)).toMatchObject({ presentNpcs: [{ encounter: { victoryEffects: [] } }] });
  });

  it("keeps 1.7 dialogue and NPC encounters without victoryEffects readable, but rejects 1.7 raw victory effects", () => {
    const { graph, queue, anchor, question, stats, clue } = sourceNpcCombatFixture();
    const npcValue = {
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [],
        encounter: {
          maxHp: { statementId: stats.id, quote: "HP 2" },
          dodge: { statementId: stats.id, quote: "Dodge 30" },
          fight: { statementId: stats.id, quote: "Fight 40" },
          npcDamage: { statementId: stats.id, quote: "Damage 1d2" },
        },
      }],
    };
    const legacy: ModuleCompileHints = {
      schemaVersion: "1.7.0",
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [answer(question, npcValue)],
    };
    expect(() => validateModuleCompileHints(queue, legacy, graph)).not.toThrow();
    const rawVictoryEffects: ModuleCompileHints = {
      ...legacy,
      resolutions: [answer(question, {
        ...npcValue,
        presentNpcs: [{
          ...npcValue.presentNpcs[0],
          encounter: {
            ...npcValue.presentNpcs[0]!.encounter,
            victoryEffects: [{ kind: "discover_clue", clueId: clue.id }],
          },
        }],
      })],
    };
    expect(() => validateModuleCompileHints(queue, rawVictoryEffects, graph)).toThrow("1.7 hints cannot declare NPC victoryEffects");
  });

  it("uses the real NPC binding queue to compile a source-evidenced definition and current-scene automatic start", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-npc-combat-closed",
      sourceDescriptor: "source-npc-combat-closed",
      pages: ["Dock:\nCaptain Mira waits beside the launch. HP 2. Dodge 30. Fight 40. Damage 1d2.\n▶Harbor Ledger: It records the launch manifest.\nExit:"],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, combatHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const binding = payload.proseNpcBindings.find((npc) => npc.nameQuote === "Mira")!;
    const encounter = binding.encounter!;
    expect(encounter.statEvidence.maxHp.quote).toBe("HP 2");
    expect(payload.mechanicsIR.encounterDefinitions).toEqual([expect.objectContaining({
      encounterId: encounter.encounterId,
      sceneId: binding.sceneCandidateId,
      combatantId: binding.npcId,
      maxHp: 2,
      dodge: 30,
      fight: 40,
      npcDamage: { kind: "dice", count: 1, sides: 2 },
    })]);
    const settled = settleAutomaticMechanics(payload.mechanicsIR, initialMechanicsState(payload.analysisInput));
    expect(settled.state.encounters[encounter.encounterId]).toEqual({ status: "active", currentHp: 2 });
    expect(settled.steps.map((step) => step.mechanismId)).toContain(encounter.autoStartMechanismId);
  });

  it("maps a generic opaque façade choice to a sealed compiled attack without revealing the encounter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "source-npc-combat-facade-"));
    try {
      const prepared = await prepareCompiler({
        kind: "synthetic_pages",
        moduleId: "source-npc-combat-facade",
        sourceDescriptor: "source-npc-combat-facade",
        pages: ["Dock:\nCaptain Mira waits beside the launch. HP 2. Dodge 30. Fight 40. Damage 1d2.\n▶Harbor Ledger: It records the launch manifest.\nExit:"],
      });
      if (prepared.status === "refused") throw new Error(prepared.message);
      const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, combatHints(prepared));
      if (resolved.status === "refused") throw new Error(resolved.message);
      const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
      const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
      if (projection.status === "refused") throw new Error(projection.message);
      const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
      const saved = catalog.saveBundle(resolved.artifact, projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const host = createCompiledDurableTestHost();
      const session = new GameSession("source-npc-combat-facade", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", { ...combatRuntime(), ...host.runtimeDependencies });
      expect(session.loadDurableCompiledModule(bundle.value, createCompiledSessionAccessBinding(
        { role: "keeper", id: "keeper:facade-owner" },
        { role: "player", id: "player:facade-p1" },
      ))).toMatchObject({ status: "loaded" });

      const encounter = payload.mechanicsIR.encounterDefinitions[0]!;
      const view = session.getCompiledPlayerFacadeView();
      const attack = view.actions.find((action) => action.label === "Attack");
      expect(attack).toEqual({ choiceId: expect.stringMatching(/^choice_[A-Za-z0-9_-]{43}$/), label: "Attack" });
      const viewText = JSON.stringify(view);
      for (const forbidden of ["Mira", encounter.encounterId, `attack:${encounter.encounterId}`, "mechanismId", "@compiled", "npc_"]) {
        expect(viewText).not.toContain(forbidden);
      }
      expect(host.resolvePlayerChoice(session, attack!.choiceId, view.generation)).toBe(`@compiled attack:${encounter.encounterId}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projects the bound NPC as a hostile encounter and settles attack results through RulesEngine before core execution", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-npc-combat-runtime",
      sourceDescriptor: "source-npc-combat-runtime",
      pages: ["Dock:\nCaptain Mira waits beside the launch. HP 2. Dodge 30. Fight 40. Damage 1d2.\n▶Harbor Ledger: It records the launch manifest.\nExit:"],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, combatHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const session = new GameSession("source-npc-combat-runtime", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, "investigator", "Ada", undefined, undefined, undefined, "preferred", combatRuntime());
    expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
    const encounter = payload.mechanicsIR.encounterDefinitions[0]!;
    expect(session.getState().npcs).toEqual([]);
    expect(session.getState().monsters).toEqual([{ name: "Mira", hp: 2, maxHp: 2, status: ["hostile"] }]);
    const action = session.getCompiledAvailableActions();
    expect(action).toEqual([expect.objectContaining({ mechanismId: `attack:${encounter.encounterId}`, kind: "combat", label: "Attack Mira" })]);
    expect(validateCompiledActionIntentRequest({ input: "attack Mira", expectedGeneration: 0, catalog: action })).toBe("ok");

    const first = await session.act(action[0]!.command);
    expect(first.compiled?.state.encounters[encounter.encounterId]).toEqual({ status: "active", currentHp: 1 });
    expect(first.state.player.hp).toBeLessThan(first.state.player.maxHp);
    expect(first.state.monsters).toEqual([{ name: "Mira", hp: 1, maxHp: 2, status: ["hostile"] }]);
    expect(first.combatSettlement?.enemy).toMatchObject({ hit: true, damageDealt: 2 });
    const hpAfterCounterattack = first.state.player.hp;
    const final = await session.act(action[0]!.command);
    expect(final.compiled?.state.encounters[encounter.encounterId]).toEqual({ status: "defeated", currentHp: 0 });
    expect(final.state.monsters).toEqual([{ name: "Mira", hp: 0, maxHp: 2, status: ["defeated"] }]);
    expect(final.combatSettlement?.enemy).toBeNull();
    expect(final.state.player.hp).toBe(hpAfterCounterattack);
    expect(final.compiled?.state.foundClueIds).toEqual(payload.mechanicsIR.symbols.clueIds);
    expect(final.dead).toBe(false);
  });

  it("commits a RulesEngine counterattack as terminal loss and refuses every later compiled action", async () => {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-npc-combat-loss",
      sourceDescriptor: "source-npc-combat-loss",
      pages: ["Dock:\nCaptain Mira waits beside the launch. HP 2. Dodge 30. Fight 40. Damage 12.\n▶Harbor Ledger: It records the launch manifest.\nExit:"],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, combatHints(prepared, "Damage 12"));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const session = compiledCombatSession("source-npc-combat-loss", (sheet) => { sheet.hp = 1; });
    expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
    const encounter = payload.mechanicsIR.encounterDefinitions[0]!;
    const command = `@compiled attack:${encounter.encounterId}`;
    const loss = await session.act(command);
    expect(loss.dead).toBe(true);
    expect(loss.compiled?.state.terminalLoss).toEqual({ kind: "encounter_defeat", encounterId: encounter.encounterId, combatantId: encounter.combatantId });
    expect(loss.state.player.hp).toBe(0);
    expect(session.getCompiledAvailableActions()).toEqual([]);
    const refused = await session.act(command);
    expect(refused.error?.code).toBe("compiled_terminal");
    expect(session.getCompiledMechanicsState()?.state.terminalLoss).toEqual({ kind: "encounter_defeat", encounterId: encounter.encounterId, combatantId: encounter.combatantId });
  });

  it("rejects a durable compiled character missing either exact combat skill before any world install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "source-npc-combat-invalid-character-"));
    try {
    const prepared = await prepareCompiler({
      kind: "synthetic_pages",
      moduleId: "source-npc-combat-skills",
      sourceDescriptor: "source-npc-combat-skills",
      pages: ["Dock:\nCaptain Mira waits beside the launch. HP 2. Dodge 30. Fight 40. Damage 1d2.\n▶Harbor Ledger: It records the launch manifest.\nExit:"],
    });
    if (prepared.status === "refused") throw new Error(prepared.message);
    const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, combatHints(prepared));
    if (resolved.status === "refused") throw new Error(resolved.message);
    const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
    const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
    if (projection.status === "refused") throw new Error(projection.message);
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = catalog.saveBundle(resolved.artifact, projection);
    if (saved.status !== "ok") throw new Error(saved.message);
    const bundle = catalog.loadBundle(saved.value.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);
    const config = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
    const liveHost = createCompiledDurableTestHost();
    const live = new GameSession("source-npc-combat-missing-skill", "cosmic-horror", config, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", { ...combatRuntime(), ...liveHost.runtimeDependencies });
    expect(live.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
    const initial = liveHost.snapshot(live);
    for (const skill of ["dodge", "fighting"] as const) {
      const forged = structuredClone(initial);
      const initialSheet = mutableRecord(forged.initialCharacter.sheet, "initial character");
      delete mutableRecord(initialSheet.skillValues, "initial skillValues")[skill];
      forged.snapshotHash = compiledSessionSnapshotHash(forged);
      const target = new GameSession("source-npc-combat-missing-skill", "cosmic-horror", config, undefined, undefined, undefined, { careerRoot: join(dir, `restore-${skill}`) }, undefined, "preferred", combatRuntime());
      const beforeWorld = target.world.getCurrentState();
      expect(target.restoreCompiledSession(forged, bundle.value)).toMatchObject({ status: "refused", code: "COMPILED_PROJECTION_INVALID" });
      expect(target.getCompiledMechanicsState()).toBeNull();
      expect(target.world.getCurrentState()).toEqual(beforeWorld);
    }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists and replays the RulesEngine combat receipt before a fresh session installs any world mirror", async () => {
    const dir = mkdtempSync(join(tmpdir(), "source-npc-combat-durable-"));
    try {
      const prepared = await prepareCompiler({
        kind: "synthetic_pages",
        moduleId: "source-npc-combat-durable",
        sourceDescriptor: "source-npc-combat-durable",
        pages: ["Dock:\nCaptain Mira waits beside the launch. HP 2. Dodge 30. Fight 40. Damage 12.\n▶Harbor Ledger: It records the launch manifest.\nExit:"],
      });
      if (prepared.status === "refused") throw new Error(prepared.message);
      const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, combatHints(prepared, "Damage 12"));
      if (resolved.status === "refused") throw new Error(resolved.message);
      const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
      const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
      const savedPrepared = catalog.savePrepared(prepared.artifact);
      if (savedPrepared.status !== "ok") throw new Error(savedPrepared.message);
      const savedReview = catalog.saveTrustedPresentationReview(savedPrepared.value.id, prepared.artifact, resolved.artifact, "operator:source-npc-combat", exactReviewBindings(payload));
      if (savedReview.status !== "ok") throw new Error(savedReview.message);
      const review = catalog.loadTrustedPresentationReview(savedReview.value.id);
      if (review.status !== "ok") throw new Error(review.message);
      const projection = projectTrustedResolvedCompilerArtifact(payload, review.value.review);
      if (projection.status === "refused") throw new Error(projection.message);
      const saved = catalog.saveBundle(resolved.artifact, projection);
      if (saved.status !== "ok") throw new Error(saved.message);
      const bundle = catalog.loadBundle(saved.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      // Direct GameSession replay fixture; production HTTP coverage uses the
      // namespace permit bridge rather than this standalone store seam.
      const snapshots = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots"), allowUncoordinatedTestWrites: true });
      const config = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
      const liveHost = createCompiledDurableTestHost();
      const live = new GameSession("source-npc-combat-durable", "cosmic-horror", config, "investigator", "Ada", undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", { ...combatRuntime(), ...liveHost.runtimeDependencies });
      expect(live.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
      const initial = liveHost.snapshot(live);
      expect(snapshots.save(initial).status).toBe("ok");
      liveHost.acknowledge(live, initial);
      const encounter = payload.mechanicsIR.encounterDefinitions[0]!;
      const committed = liveHost.commit(live, `@compiled attack:${encounter.encounterId}`, "combat-one", 0, (snapshot) => {
        const stored = snapshots.save(snapshot);
        if (stored.status !== "ok") throw new Error(stored.message);
      });
      expect(committed).toMatchObject({ status: "committed", generation: 1 });
      if (committed.status !== "committed" || !committed.snapshot) throw new Error("expected durable combat snapshot");
      const committedSnapshot = committed.snapshot;
      const receipt = committed.response.action.combatSettlement;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("expected combat settlement receipt");
      const actorHpAfter = receipt.actorHpAfter;
      expect(receipt.mechanismId).toBe(`attack:${encounter.encounterId}`);
      expect(receipt.encounterId).toBe(encounter.encounterId);
      if (typeof receipt.actorHpBefore !== "number" || typeof actorHpAfter !== "number") throw new Error("combat receipt HP must be numeric");
      expect(receipt.outcome).toMatchObject({ enemyHit: true });
      const restoredHost = createCompiledDurableTestHost();
      const restored = new GameSession("source-npc-combat-durable", "cosmic-horror", config, undefined, undefined, undefined, { careerRoot: join(dir, "careers") }, undefined, "preferred", { ...combatRuntime(), ...restoredHost.runtimeDependencies });
      expect(restored.restoreCompiledSession(committedSnapshot, bundle.value)).toMatchObject({ status: "loaded" });
      expect(restored.getState().monsters).toEqual([{ name: "Mira", hp: 1, maxHp: 2, status: ["hostile"] }]);
      expect(restored.getState().player.hp).toBe(actorHpAfter);
      expect(restored.getState().player.hp).toBe(0);
      expect(restored.getCompiledMechanicsState()?.state.terminalLoss).toEqual({ kind: "encounter_defeat", encounterId: encounter.encounterId, combatantId: encounter.combatantId });
      expect(restored.getCompiledAvailableActions()).toEqual([]);
      expect(restoredHost.commit(restored, `@compiled attack:${encounter.encounterId}`, "combat-one", 0, () => {
        throw new Error("an idempotent combat retry must not persist or reroll");
      })).toMatchObject({ status: "duplicate", generation: 1 });
      const child = Bun.spawn([process.execPath, "src/__tests__/compiled-source-npc-combat-restart-child.ts", dir, "source-npc-combat-durable", saved.value.id], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exitCode !== 0) throw new Error(`fresh combat restore failed: ${stderr || stdout}`);
      const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) throw new Error("fresh combat restore did not emit state");
      expect(JSON.parse(line)).toEqual({ hp: actorHpAfter, monsters: [{ name: "Mira", hp: 1, maxHp: 2, status: ["hostile"] }], generation: 1 });

      const tampered = structuredClone(committedSnapshot);
      const tamperedReceipt = tampered.idempotency[0]!.response.action.combatSettlement;
      if (!tamperedReceipt || typeof tamperedReceipt !== "object" || Array.isArray(tamperedReceipt) || typeof tamperedReceipt.actorHpAfter !== "number") throw new Error("expected mutable combat settlement receipt");
      tamperedReceipt.actorHpAfter++;
      tampered.snapshotHash = compiledSessionSnapshotHash(tampered);
      const rejected = new GameSession("source-npc-combat-durable", "cosmic-horror", config, undefined, undefined, undefined, { careerRoot: join(dir, "reject-careers") }, undefined, "preferred", combatRuntime());
      expect(rejected.restoreCompiledSession(tampered, bundle.value)).toMatchObject({ status: "refused", code: "COMPILED_PROJECTION_INVALID" });
      expect(rejected.getCompiledMechanicsState()).toBeNull();

      const rejectedSettlement = (mutate: (receipt: Record<string, unknown>, action: Record<string, unknown>) => void, suffix: string) => {
        const forged = structuredClone(committedSnapshot);
        const action = forged.idempotency[0]!.response.action;
        const receipt = action.combatSettlement;
        if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("expected combat receipt");
        mutate(receipt, action);
        forged.snapshotHash = compiledSessionSnapshotHash(forged);
        const candidate = new GameSession("source-npc-combat-durable", "cosmic-horror", config, undefined, undefined, undefined, { careerRoot: join(dir, `reject-${suffix}`) }, undefined, "preferred", combatRuntime());
        expect(candidate.restoreCompiledSession(forged, bundle.value)).toMatchObject({ status: "refused", code: "COMPILED_PROJECTION_INVALID" });
      };
      rejectedSettlement((receipt) => {
        const player = mutableRecord(receipt.player, "player roll");
        player.roll = 99;
      }, "roll");
      rejectedSettlement((receipt) => {
        const units = receipt.randomUnits;
        if (!Array.isArray(units) || units.length === 0) throw new Error("expected recorded combat entropy");
        units[0] = 0.99;
      }, "entropy");
      rejectedSettlement((receipt) => {
        const enemy = mutableRecord(receipt.enemy, "enemy damage");
        enemy.damageDealt = 1;
      }, "damage");
      rejectedSettlement((receipt) => {
        const outcome = mutableRecord(receipt.outcome, "combat outcome");
        outcome.actorDamage = 1;
      }, "outcome");
      rejectedSettlement((_receipt, action) => {
        const state = mutableRecord(action.state, "response state");
        const player = mutableRecord(state.player, "response player");
        player.hp = 1;
      }, "response");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
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
    reason: "reviewed source NPC combat fixture",
  };
}

function combatHints(prepared: PreparedCompilerApiResult, npcDamageQuote = "Damage 1d2"): ModuleCompileHints {
  const { draft, preparedQueue: queue, graph } = prepared.artifact.payload;
  const dock = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Dock"))!;
  const exit = draft.sceneCandidates.find((scene) => scene.displayName.startsWith("Exit"))!;
  const clue = draft.clueCandidates.find((candidate) => candidate.sceneCandidateId === dock.id)!;
  const anchor = draft.proseNpcAnchors.find((candidate) => candidate.sceneCandidateId === dock.id)!;
  const stats = graph.statements.find((statement) => statement.id === anchor.paragraphStatementId)!;
  const question = (kind: CompilerQuestion["kind"], subject?: string) => queue.questions.find((candidate) => candidate.kind === kind && (subject === undefined || candidate.subjectCandidateId === subject))!;
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
            npcDamage: { statementId: stats.id, quote: npcDamageQuote },
            victoryEffects: [sourceBoundVictoryEffect(graph, anchor.headingStatementId, clue, { kind: "discover_clue", clueId: clue.id })],
          },
        }],
      }),
    ],
  };
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const facetRevelations = clueFactFacetRevelations(payload.clueFactFacetBindings);
  return {
    module: { title: "Source NPC combat", version: "1", ruleset: "cosmic-horror", era: "test", summary: "test", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: `scene:${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: `connection:${connection.id}` }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => [id, { findMethods: [], revelation: facetRevelations.get(id) ?? `revelation:${id}`, unlocks: [], importance: "core" as const }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((ending) => [ending.effects.find((effect) => effect.kind === "end_game")!.endingId, { name: ending.id, description: `ending:${ending.id}`, conditions: ["test"] }])),
  };
}
