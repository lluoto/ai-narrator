import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import {
  COMPILER_HINT_PROPOSAL_BATCH_SCHEMA_VERSION,
  LEGACY_COMPILER_HINT_PROPOSAL_REQUEST_SCHEMA_VERSION,
  buildCompilerHintProposalRequestEnvelope,
  compileGroundedHintProposals,
  type CompilerHintProposal,
  type CompilerHintProposalBatch,
} from "../compiler/compiler-hint-proposals";
import { applyModuleCompileHints } from "../compiler/compile-hint-resolution";
import { allowedNpcEncounterProfiles, buildCompilerQuestionQueue, isAutomaticNpcEncounterHostilityTrigger, parseCompilerHintValue, validateCompilerQuestionQueue, validateModuleCompileHints, withQueueHash, type CompilerQuestion } from "../compiler/compiler-question-queue";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildSourceFactGraph, type SourceFactGraph } from "../compiler/source-fact-graph";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";
import { importPointsTo, scanImports } from "../diagnostics/source-scan";

function fixture() {
  const document = createSyntheticDocumentIR(["场景一：\n普通段落。\n▶甲：正文。\n场景二：\n▶乙：正文。"], "grounded-hint-proposals");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "grounded-hint-proposals" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

function sourceFactMechanicsFixture() {
  const document = createSyntheticDocumentIR(["Dock:\nA wet note says the key is hidden nearby.\n\n\u25b6 Rust Key: A rusted key lies under the crate."], "grounded-source-fact-mechanics");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "grounded-source-fact-mechanics" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

/**
 * This real queue deliberately has a complete cross-heading profile whose
 * hashed statement ID sorts before the anchor location heading.  The profile
 * must never become the automatic NPC proposal's scene authority.
 */
function crossHeadingNpcProfileFixture() {
  const moduleId = "grounded-cross-profile-5";
  const document = createSyntheticDocumentIR([
    "Dock:\nMira: guards the ramp.\n\u25b6 Ledger: Evidence.\nMira:\nHP 4. Dodge 20. Fight 35. Damage 1d3.\nExit:",
  ], moduleId);
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const draft = compileDeterministicTemplates(graph, { moduleId });
  const queue = buildCompilerQuestionQueue(graph, draft);
  const anchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("guards"));
  if (!anchor) throw new Error("cross-heading NPC anchor missing");
  const question = queue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id);
  const profileHeading = graph.statements.find((statement) => statement.kind === "heading" && statement.text.trim() === "Mira:");
  const locationRole = queue.questions.find((candidate) => candidate.kind === "scene_role" && candidate.subjectCandidateId === anchor.sceneCandidateId);
  const profileScene = profileHeading && draft.sceneCandidates.find((candidate) => candidate.headingStatementId === profileHeading.id);
  const profileRole = profileScene && queue.questions.find((candidate) => candidate.kind === "scene_role" && candidate.subjectCandidateId === profileScene.id);
  if (!question || !profileHeading || !locationRole || !profileRole) throw new Error("cross-heading NPC fixture scope missing");
  const sourceHeadings = question.sourceStatementIds.filter((id) => graph.statements.find((statement) => statement.id === id)?.kind === "heading");
  if (sourceHeadings[0] !== profileHeading.id || !sourceHeadings.includes(anchor.headingStatementId)) {
    throw new Error("cross-heading NPC fixture did not put the profile heading before its location heading");
  }
  const paragraph = graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
  if (!paragraph || paragraph.kind !== "paragraph") throw new Error("cross-heading NPC paragraph missing");
  const proposal: CompilerHintProposal = {
    questionId: question.id,
    kind: "npc_binding",
    value: { proseAnchorId: anchor.id, presentNpcs: [{ nameQuote: "Mira:", dialogueMethods: [] }] },
    citations: [{ claimKey: `npc_binding:${anchor.id}:0`, statementId: paragraph.id, quote: "Mira:" }],
  };
  return { graph, queue, question, locationRole, profileRole, proposal };
}

/** A complete direct location profile may be automatic only with an attack fact. */
function automaticNpcEncounterFixture(anchorText = "Mira attacks the investigators.") {
  const moduleId = "grounded-automatic-npc-encounter";
  const document = createSyntheticDocumentIR([
    `Dock:\n${anchorText} HP 2. Dodge 30. Fight 40. Damage 1d2.\nExit:`,
  ], moduleId);
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const draft = compileDeterministicTemplates(graph, { moduleId });
  const queue = buildCompilerQuestionQueue(graph, draft);
  const anchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("Mira"));
  if (!anchor) throw new Error("automatic encounter anchor missing");
  const question = queue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id);
  const sceneRole = queue.questions.find((candidate) => candidate.kind === "scene_role" && candidate.subjectCandidateId === anchor.sceneCandidateId);
  const paragraph = graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
  if (!question || !sceneRole || !paragraph) throw new Error("automatic encounter fixture scope missing");
  return { graph, queue, anchor, question, sceneRole, paragraph };
}

/** Deliberately varies stat ownership without changing the human-review parser. */
function automaticNpcEncounterOwnerFixture(moduleId: string, body: string) {
  const document = createSyntheticDocumentIR([body], moduleId);
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const draft = compileDeterministicTemplates(graph, { moduleId });
  const queue = buildCompilerQuestionQueue(graph, draft);
  const anchor = draft.proseNpcAnchors.find((candidate) => graph.statements.find((statement) => statement.id === candidate.paragraphStatementId)?.text.includes("Mira"));
  const question = anchor && queue.questions.find((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id);
  const sceneRole = anchor && queue.questions.find((candidate) => candidate.kind === "scene_role" && candidate.subjectCandidateId === anchor.sceneCandidateId);
  const paragraph = anchor && graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
  if (!anchor || !question || !sceneRole || !paragraph) throw new Error("automatic encounter owner fixture scope missing");
  return { graph, queue, anchor, question, sceneRole, paragraph };
}

type RewardPredicateDomains = Partial<Record<"scene" | "clue" | "item", string[]>>;

function rewardFixture() {
  const document = createSyntheticDocumentIR([[
    "Dock:",
    "▶ Harbor Ledger: The signed ledger reveals the launch route.",
    "▶ Moon Key: The brass key opens the archive cabinet.",
    "Exit:",
    "Rewards:",
    "SAN +1d6",
    "CM +2",
    "CR +3",
  ].join("\n")], "grounded-reward-predicate-domains");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "grounded-reward-predicate-domains" });
  return { graph, draft, queue: buildCompilerQuestionQueue(graph, draft) };
}

function rewardDomains(question: CompilerQuestion): RewardPredicateDomains | undefined {
  return (question as CompilerQuestion & { allowedRewardPredicateIds?: RewardPredicateDomains }).allowedRewardPredicateIds;
}

function requestedRewardDomains(value: unknown): RewardPredicateDomains | undefined {
  return (value as { allowedRewardPredicateIds?: RewardPredicateDomains }).allowedRewardPredicateIds;
}

function exactCitation(graph: SourceFactGraph, question: CompilerQuestion, claimKey = "scene_role") {
  const statement = graph.statements.find((candidate) => candidate.id === question.sourceStatementIds[0])!;
  return { claimKey, statementId: statement.id, quote: statement.text };
}

function batchFor(queue: ReturnType<typeof fixture>["queue"], proposals: CompilerHintProposal[]): CompilerHintProposalBatch {
  return {
    schemaVersion: COMPILER_HINT_PROPOSAL_BATCH_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    queueHash: queue.queueHash,
    proposalId: "proposal_fixture_1",
    proposals,
  };
}

function roleProposal(graph: SourceFactGraph, question: CompilerQuestion, role = "playable_scene"): CompilerHintProposal {
  return { questionId: question.id, kind: "scene_role", value: { role }, citations: [exactCitation(graph, question)] };
}

describe("grounded compiler hint proposals", () => {
  it("keeps the proposal compiler pure and independent from LLM runtime", () => {
    const imports = scanImports(readFileSync("src/compiler/compiler-hint-proposals.ts", "utf8"));
    for (const forbidden of ["llm/client", "llm/json", "llm/intent", "game-session", "world-model-loader"]) {
      expect(imports.some((entry) => importPointsTo(entry.path, forbidden))).toBe(false);
    }
  });

  it("builds a deterministic request envelope with source text and candidate domains, never an inferred answer", () => {
    const { graph, queue } = fixture();
    const envelope = buildCompilerHintProposalRequestEnvelope(graph, queue);
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const requested = envelope.questions.find((question) => question.questionId === role.id)!;

    expect(envelope.schemaVersion).toBe(LEGACY_COMPILER_HINT_PROPOSAL_REQUEST_SCHEMA_VERSION);
    expect(envelope.queueHash).toBe(queue.queueHash);
    expect(requested.sourceStatements.map((statement) => statement.statementId)).toEqual(role.sourceStatementIds);
    const roleSource = graph.statements.find((statement) => statement.id === role.sourceStatementIds[0]!)!;
    expect(requested.sourceStatements[0]!.text).toBe(roleSource.text);
    expect(requested.candidateDomains.subjectCandidateId).toBe(role.subjectCandidateId);
    expect(requested.allowedKinds).toEqual(["scene_role"]);
    expect("value" in requested).toBe(false);
  });

  it("uses the anchor location, not a sort-first non-playable profile, to authorize an automatic static NPC proposal", () => {
    const { graph, queue, locationRole, profileRole, proposal } = crossHeadingNpcProfileFixture();
    const roleAnswers = compileGroundedHintProposals(graph, queue, batchFor(queue, [
      roleProposal(graph, locationRole, "playable_scene"),
      roleProposal(graph, profileRole, "other"),
    ]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(roleAnswers.rejected).toEqual([]);
    const answered = applyModuleCompileHints(graph, queue, roleAnswers.hints);

    const result = compileGroundedHintProposals(graph, answered, batchFor(answered, [proposal]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
    });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.hints.resolutions).toMatchObject([{ questionId: proposal.questionId, value: proposal.value }]);
  });

  it("refuses automatic NPC authority from a playable profile when its anchor location is non-playable", () => {
    const { graph, queue, locationRole, profileRole, proposal } = crossHeadingNpcProfileFixture();
    const roleAnswers = compileGroundedHintProposals(graph, queue, batchFor(queue, [
      roleProposal(graph, locationRole, "other"),
      roleProposal(graph, profileRole, "playable_scene"),
    ]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(roleAnswers.rejected).toEqual([]);
    const answered = applyModuleCompileHints(graph, queue, roleAnswers.hints);

    const result = compileGroundedHintProposals(graph, answered, batchFor(answered, [proposal]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
    });

    expect(result.accepted).toEqual([]);
    expect(result.hints.resolutions).toEqual([]);
    expect(result.rejected).toContainEqual(expect.objectContaining({
      questionId: proposal.questionId,
      code: "npc_binding_requires_playable_scene",
    }));
  });

  it("admits a capability-gated source-exact automatic encounter only with each stat and an immediate hostile anchor claim", () => {
    const { graph, queue, anchor, question, sceneRole, paragraph } = automaticNpcEncounterFixture();
    const roles = compileGroundedHintProposals(graph, queue, batchFor(queue, [roleProposal(graph, sceneRole)]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
    });
    const playable = applyModuleCompileHints(graph, queue, roles.hints);
    const value = {
      proseAnchorId: anchor.id,
      presentNpcs: [{
        nameQuote: "Mira",
        dialogueMethods: [],
        encounter: {
          maxHp: { statementId: paragraph.id, quote: "HP 2" },
          dodge: { statementId: paragraph.id, quote: "Dodge 30" },
          fight: { statementId: paragraph.id, quote: "Fight 40" },
          npcDamage: { statementId: paragraph.id, quote: "Damage 1d2" },
        },
      }],
    };
    const citations = [
      { claimKey: `npc_binding:${anchor.id}:0:name`, statementId: paragraph.id, quote: "Mira" },
      { claimKey: `npc_binding:${anchor.id}:0:encounter:trigger`, statementId: paragraph.id, quote: "Mira attacks the investigators." },
      { claimKey: `npc_binding:${anchor.id}:0:encounter:maxHp`, statementId: paragraph.id, quote: "HP 2" },
      { claimKey: `npc_binding:${anchor.id}:0:encounter:dodge`, statementId: paragraph.id, quote: "Dodge 30" },
      { claimKey: `npc_binding:${anchor.id}:0:encounter:fight`, statementId: paragraph.id, quote: "Fight 40" },
      { claimKey: `npc_binding:${anchor.id}:0:encounter:npcDamage`, statementId: paragraph.id, quote: "Damage 1d2" },
    ];
    const proposal: CompilerHintProposal = { questionId: question.id, kind: "npc_binding", value, citations };

    const denied = compileGroundedHintProposals(graph, playable, batchFor(playable, [proposal]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
    });
    expect(denied.accepted).toEqual([]);
    expect(denied.rejected).toContainEqual(expect.objectContaining({ code: "automatic_npc_encounter_not_allowed" }));

    const accepted = compileGroundedHintProposals(graph, playable, batchFor(playable, [proposal]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
      allowSourceExactNpcEncounters: true,
      producer: {
        providerFingerprint: "provider:test",
        modelFingerprint: "model:test",
        requestHash: "a".repeat(64),
        responseHash: "b".repeat(64),
      },
    });
    expect(accepted.rejected).toEqual([]);
    expect(accepted.hints.resolutions).toMatchObject([{
      questionId: question.id,
      audit: { schemaVersion: "1.3.0", citations },
    }]);
    expect(parseCompilerHintValue(question, accepted.hints.resolutions[0]!.value, graph)).toMatchObject({
      kind: "npc_binding",
      presentNpcs: [{ encounter: { maxHp: 2, dodge: 30, fight: 40, npcDamage: { kind: "dice", count: 1, sides: 2 }, victoryEffects: [] } }],
    });
    const swappedStatCitation = structuredClone(proposal);
    swappedStatCitation.citations.find((citation) => citation.claimKey.endsWith(":encounter:maxHp"))!.quote = "Dodge 30";
    expect(compileGroundedHintProposals(graph, playable, batchFor(playable, [swappedStatCitation]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
      allowSourceExactNpcEncounters: true,
      producer: {
        providerFingerprint: "provider:test",
        modelFingerprint: "model:test",
        requestHash: "a".repeat(64),
        responseHash: "b".repeat(64),
      },
    }).rejected).toContainEqual(expect.objectContaining({ code: "invalid_audit" }));
  });

  it("gives automatic encounter stats one unambiguous NPC owner without narrowing human encounter review", () => {
    const borrowedLocation = automaticNpcEncounterOwnerFixture(
      "grounded-automatic-owner-borrowed-location",
      "Dock:\nMira attacks the investigators.\n\nKarl has HP 6. Dodge 25. Fight 45. Damage 1d4.\nExit:",
    );
    expect(allowedNpcEncounterProfiles(borrowedLocation.graph, borrowedLocation.question)).toEqual([]);
    const borrowedEnvelope = buildCompilerHintProposalRequestEnvelope(borrowedLocation.graph, borrowedLocation.queue, {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
      allowSourceExactNpcEncounters: true,
    });
    expect(borrowedEnvelope.questions.find((candidate) => candidate.questionId === borrowedLocation.question.id)?.candidateDomains.allowedNpcEncounterProfiles).toBeUndefined();
    const borrowedPlayable = applyModuleCompileHints(borrowedLocation.graph, borrowedLocation.queue, compileGroundedHintProposals(
      borrowedLocation.graph,
      borrowedLocation.queue,
      batchFor(borrowedLocation.queue, [roleProposal(borrowedLocation.graph, borrowedLocation.sceneRole)]),
      { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" },
    ).hints);
    const karlStats = borrowedLocation.graph.statements.find((statement) => statement.kind === "paragraph" && statement.text.includes("Karl has HP 6"))!;
    const borrowedProposal: CompilerHintProposal = {
      questionId: borrowedLocation.question.id,
      kind: "npc_binding",
      value: {
        proseAnchorId: borrowedLocation.anchor.id,
        presentNpcs: [{
          nameQuote: "Mira",
          dialogueMethods: [],
          encounter: {
            maxHp: { statementId: karlStats.id, quote: "HP 6" },
            dodge: { statementId: karlStats.id, quote: "Dodge 25" },
            fight: { statementId: karlStats.id, quote: "Fight 45" },
            npcDamage: { statementId: karlStats.id, quote: "Damage 1d4" },
          },
        }],
      },
      citations: [
        { claimKey: `npc_binding:${borrowedLocation.anchor.id}:0:name`, statementId: borrowedLocation.paragraph.id, quote: "Mira" },
        { claimKey: `npc_binding:${borrowedLocation.anchor.id}:0:encounter:trigger`, statementId: borrowedLocation.paragraph.id, quote: "Mira attacks the investigators." },
        { claimKey: `npc_binding:${borrowedLocation.anchor.id}:0:encounter:maxHp`, statementId: karlStats.id, quote: "HP 6" },
        { claimKey: `npc_binding:${borrowedLocation.anchor.id}:0:encounter:dodge`, statementId: karlStats.id, quote: "Dodge 25" },
        { claimKey: `npc_binding:${borrowedLocation.anchor.id}:0:encounter:fight`, statementId: karlStats.id, quote: "Fight 45" },
        { claimKey: `npc_binding:${borrowedLocation.anchor.id}:0:encounter:npcDamage`, statementId: karlStats.id, quote: "Damage 1d4" },
      ],
    };
    expect(compileGroundedHintProposals(borrowedLocation.graph, borrowedPlayable, batchFor(borrowedPlayable, [borrowedProposal]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
      allowSourceExactNpcEncounters: true,
      producer: { providerFingerprint: "provider:test", modelFingerprint: "model:test", requestHash: "a".repeat(64), responseHash: "b".repeat(64) },
    }).rejected).toContainEqual(expect.objectContaining({ code: "invalid_audit" }));

    const duplicateSlot = automaticNpcEncounterOwnerFixture(
      "grounded-automatic-owner-duplicate-slot",
      "Dock:\nMira attacks the investigators. HP 2. HP 3. Dodge 30. Fight 40. Damage 1d2.\nExit:",
    );
    expect(allowedNpcEncounterProfiles(duplicateSlot.graph, duplicateSlot.question)).toEqual([]);

    const duplicateProfiles = automaticNpcEncounterOwnerFixture(
      "grounded-automatic-owner-duplicate-profiles",
      "Dock:\nMira: attacks the investigators.\nMira:\nHP 2. Dodge 30. Fight 40. Damage 1d2.\nMira:\nHP 3. Dodge 35. Fight 45. Damage 1d3.\nExit:",
    );
    expect(allowedNpcEncounterProfiles(duplicateProfiles.graph, duplicateProfiles.question)).toEqual([]);

    const direct = automaticNpcEncounterFixture();
    expect(allowedNpcEncounterProfiles(direct.graph, direct.question)).toMatchObject([{
      headingStatementId: direct.anchor.headingStatementId,
      statCandidates: {
        maxHp: [{ statementId: direct.paragraph.id, quote: "HP 2" }],
        dodge: [{ statementId: direct.paragraph.id, quote: "Dodge 30" }],
        fight: [{ statementId: direct.paragraph.id, quote: "Fight 40" }],
        npcDamage: [{ statementId: direct.paragraph.id, quote: "Damage 1d2" }],
      },
    }]);

    const alternate = automaticNpcEncounterOwnerFixture(
      "grounded-automatic-owner-unique-profile",
      "Dock:\nMira: attacks the investigators.\nMira:\nHP 2. Dodge 30. Fight 40. Damage 1d2.\nExit:",
    );
    const alternateHeading = alternate.graph.statements.find((statement) => statement.kind === "heading" && statement.text.trim() === "Mira:")!;
    const alternateProfiles = allowedNpcEncounterProfiles(alternate.graph, alternate.question);
    expect(alternateProfiles).toMatchObject([{
      headingStatementId: alternateHeading.id,
      requiredNameQuote: "Mira:",
      statCandidates: {
        maxHp: [{ quote: "HP 2" }],
        dodge: [{ quote: "Dodge 30" }],
        fight: [{ quote: "Fight 40" }],
        npcDamage: [{ quote: "Damage 1d2" }],
      },
    }]);
    expect(isAutomaticNpcEncounterHostilityTrigger("Mira:", "Mira: attacks the investigators.")).toBe(true);
    const alternateProfile = alternateProfiles[0]!;
    const alternatePlayable = applyModuleCompileHints(alternate.graph, alternate.queue, compileGroundedHintProposals(
      alternate.graph,
      alternate.queue,
      batchFor(alternate.queue, [roleProposal(alternate.graph, alternate.sceneRole)]),
      { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" },
    ).hints);
    const alternateProposal: CompilerHintProposal = {
      questionId: alternate.question.id,
      kind: "npc_binding",
      value: {
        proseAnchorId: alternate.anchor.id,
        presentNpcs: [{
          nameQuote: "Mira:",
          dialogueMethods: [],
          encounter: {
            maxHp: alternateProfile.statCandidates.maxHp[0],
            dodge: alternateProfile.statCandidates.dodge[0],
            fight: alternateProfile.statCandidates.fight[0],
            npcDamage: alternateProfile.statCandidates.npcDamage[0],
          },
        }],
      },
      citations: [
        { claimKey: `npc_binding:${alternate.anchor.id}:0:name`, statementId: alternate.paragraph.id, quote: "Mira:" },
        { claimKey: `npc_binding:${alternate.anchor.id}:0:encounter:trigger`, statementId: alternate.paragraph.id, quote: "Mira: attacks the investigators." },
        ...(["maxHp", "dodge", "fight", "npcDamage"] as const).map((label) => ({
          claimKey: `npc_binding:${alternate.anchor.id}:0:encounter:${label}`,
          ...alternateProfile.statCandidates[label][0]!,
        })),
      ],
    };
    expect(compileGroundedHintProposals(alternate.graph, alternatePlayable, batchFor(alternatePlayable, [alternateProposal]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
      allowSourceExactNpcEncounters: true,
      producer: { providerFingerprint: "provider:test", modelFingerprint: "model:test", requestHash: "a".repeat(64), responseHash: "b".repeat(64) },
    }).accepted).toHaveLength(1);
  });

  it("fails closed for negated, defensive, conditional, capable, friendly, or wrong-actor automatic combat trigger prose", () => {
    expect(isAutomaticNpcEncounterHostilityTrigger("Mira", "Mira attacks the investigators.")).toBe(true);
    for (const trigger of [
      "Mira does not directly attack investigators.",
      "Mira attacks anyone who attacks her.",
      "Mira attacks in self-defense.",
      "Mira may attack investigators.",
      "Mira helps the investigators.",
      "Hale attacks the investigators while Mira watches.",
      "米拉不主动攻击调查员。",
      "米拉在自卫时攻击调查员。",
    ]) expect(isAutomaticNpcEncounterHostilityTrigger("Mira", trigger)).toBe(false);
    expect(isAutomaticNpcEncounterHostilityTrigger("米拉", "米拉攻击调查员。 ")).toBe(false);
    expect(isAutomaticNpcEncounterHostilityTrigger("米拉", "米拉攻击调查员。")).toBe(true);
  });

  it("exposes only an activated, playable source-fact child with its trusted root/scope and closed typed catalog", () => {
    const { graph, queue } = sourceFactMechanicsFixture();
    const parent = queue.questions.find((question) => question.kind === "source_fact_disposition" && question.sourceFactChildQuestionId)!;
    const child = queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId)!;
    const sceneRole = queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId)!;
    const root = graph.statements.find((statement) => statement.id === parent.subjectStatementId)!;

    const preparedEnvelope = buildCompilerHintProposalRequestEnvelope(graph, queue);
    expect(preparedEnvelope.questions.find((question) => question.questionId === child.id)).toMatchObject({
      allowedKinds: [],
      sourceFactScope: {
        rootStatementId: root.id,
        parentQuestionId: parent.id,
        owningHeadingStatementId: child.owningHeadingStatementId,
        owningSceneCandidateId: child.owningSceneCandidateId,
      },
    });
    expect(preparedEnvelope.questions.find((question) => question.questionId === parent.id)?.candidateDomains.allowedDispositions)
      .toEqual(["mechanics_candidate", "source_only"]);

    const parentAndScene = compileGroundedHintProposals(graph, queue, batchFor(queue, [
      roleProposal(graph, sceneRole),
      {
        questionId: parent.id,
        kind: "source_fact_disposition",
        value: { statementId: root.id, disposition: "mechanics_candidate" },
        citations: [{ claimKey: `source_fact_disposition:${root.id}`, statementId: root.id, quote: root.text }],
      },
    ]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(parentAndScene.rejected).toEqual([]);
    const activated = applyModuleCompileHints(graph, queue, parentAndScene.hints);
    const activatedChild = activated.questions.find((question) => question.id === child.id)!;
    expect(activatedChild.status).toBe("open");

    const nonPlayableParentAndScene = compileGroundedHintProposals(graph, queue, batchFor(queue, [
      { questionId: sceneRole.id, kind: "scene_role", value: { role: "other" }, citations: [exactCitation(graph, sceneRole)] },
      {
        questionId: parent.id,
        kind: "source_fact_disposition",
        value: { statementId: root.id, disposition: "mechanics_candidate" },
        citations: [{ claimKey: `source_fact_disposition:${root.id}`, statementId: root.id, quote: root.text }],
      },
    ]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    const nonPlayable = applyModuleCompileHints(graph, queue, nonPlayableParentAndScene.hints);
    expect(nonPlayable.questions.find((question) => question.id === child.id)?.status).toBe("open");
    expect(buildCompilerHintProposalRequestEnvelope(graph, nonPlayable).questions.find((question) => question.questionId === child.id)?.allowedKinds).toEqual([]);

    const envelope = buildCompilerHintProposalRequestEnvelope(graph, activated);
    const requested = envelope.questions.find((question) => question.questionId === child.id)!;
    expect(requested.allowedKinds).toEqual(["source_fact_mechanic"]);
    expect(requested.candidateDomains.allowedSourceFactMechanicKinds).toEqual(["existing_clue_discovery"]);
    expect(requested.prompt).toContain("scene_state_transition is not enabled by trusted policy");
    expect(requested.prompt).not.toContain("or scene_state_transition declarations");
    expect(requested.sourceFactScope).toEqual({
      rootStatementId: root.id,
      parentQuestionId: parent.id,
      owningHeadingStatementId: child.owningHeadingStatementId!,
      owningSceneCandidateId: child.owningSceneCandidateId!,
    });
    for (const [kind, ids] of Object.entries(requested.candidateDomains.allowedMechanicsTargetIds ?? {})) {
      const catalogKind = kind as "scene" | "clue" | "item";
      expect(ids.every((id) => envelope.candidateCatalog.some((candidate) => candidate.id === id && candidate.kind === catalogKind))).toBe(true);
    }

    const declarationKey = "wet_note";
    const claimKeys = ["declaration", "action", "target", "discover"].map((atom) => `source_fact_mechanic:${root.id}:${declarationKey}:${atom}`);
    const evidence = claimKeys.map((claimKey) => ({ claimKey, statementId: root.id, quote: root.text.trim() }));
    const proposal: CompilerHintProposal = {
      questionId: child.id,
      kind: "source_fact_mechanic",
      value: {
        declarations: [{
          declarationKey,
          kind: "existing_clue_discovery",
          clueCandidateId: requested.candidateDomains.allowedMechanicsTargetIds!.clue![0]!,
          action: "search",
          target: "scene",
          targetId: requested.candidateDomains.allowedMechanicsTargetIds!.scene![0]!,
          evidence,
        }],
      },
      citations: evidence,
    };
    const accepted = compileGroundedHintProposals(graph, activated, batchFor(activated, [proposal]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(accepted.rejected).toEqual([]);
    expect(accepted.hints.resolutions).toMatchObject([{ questionId: child.id, kind: "source_fact_mechanic", audit: { citations: evidence } }]);

    const transitionKey = "enter-dock";
    const transitionEvidence = ["declaration", "trigger", "discover"].map((atom) => ({
      claimKey: `source_fact_mechanic:${root.id}:${transitionKey}:${atom}`,
      statementId: root.id,
      quote: root.text.trim(),
    }));
    const transitionProposal: CompilerHintProposal = {
      questionId: child.id,
      kind: "source_fact_mechanic",
      value: {
        declarations: [{
          declarationKey: transitionKey,
          kind: "scene_state_transition",
          trigger: { kind: "scene_enter" },
          discoverClueCandidateId: requested.candidateDomains.allowedMechanicsTargetIds!.clue![0]!,
          evidence: transitionEvidence,
        }],
      },
      citations: transitionEvidence,
    };
    const policyDefaultRejected = compileGroundedHintProposals(graph, activated, batchFor(activated, [transitionProposal]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(policyDefaultRejected.accepted).toEqual([]);
    expect(policyDefaultRejected.rejected).toContainEqual(expect.objectContaining({ questionId: child.id, code: "source_fact_mechanic_kind_not_allowed" }));

    const transitionPolicy = {
      policyId: "grounded-proposal-policy-transition-v1",
      rightsStatus: "user_provided" as const,
      allowedSourceFactMechanicKinds: ["existing_clue_discovery", "scene_state_transition"] as const,
    };
    const transitionRequest = buildCompilerHintProposalRequestEnvelope(graph, activated, transitionPolicy)
      .questions.find((question) => question.questionId === child.id)!;
    expect(transitionRequest.candidateDomains.allowedSourceFactMechanicKinds).toEqual(["existing_clue_discovery", "scene_state_transition"]);
    expect(transitionRequest.prompt).toContain("trigger:{kind:scene_enter}|{kind:clue_found,clueCandidateId}");
    expect(transitionRequest.prompt).toContain("scene_enter evidence has declaration, trigger, and discover; clue_found additionally has prerequisite");
    const transitionAccepted = compileGroundedHintProposals(graph, activated, batchFor(activated, [transitionProposal]), transitionPolicy);
    expect(transitionAccepted.rejected).toEqual([]);
    expect(transitionAccepted.hints.resolutions).toMatchObject([{ questionId: child.id, kind: "source_fact_mechanic" }]);

    const nonPlayableProposal = compileGroundedHintProposals(graph, nonPlayable, batchFor(nonPlayable, [proposal]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(nonPlayableProposal.accepted).toEqual([]);
    expect(nonPlayableProposal.hints.resolutions).toEqual([]);
    expect(nonPlayableProposal.rejected).toContainEqual(expect.objectContaining({ questionId: child.id, code: "source_fact_mechanic_requires_playable_scene" }));

    const partialOuterQuote = structuredClone(proposal);
    partialOuterQuote.citations = partialOuterQuote.citations.map((citation, index) => index === 0 ? { ...citation, quote: "wet note" } : citation);
    const rejected = compileGroundedHintProposals(graph, activated, batchFor(activated, [partialOuterQuote]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(rejected.accepted).toEqual([]);
    expect(rejected.rejected).toContainEqual(expect.objectContaining({ questionId: child.id, code: "invalid_audit" }));
  });

  it("exposes every same-draft reward predicate target as a typed, source-exact request domain", () => {
    const { graph, draft, queue } = rewardFixture();
    const reward = queue.questions.find((question) => question.kind === "reward_binding")!;
    const envelope = buildCompilerHintProposalRequestEnvelope(graph, queue);
    const requested = envelope.questions.find((question) => question.questionId === reward.id)!;
    const expected: RewardPredicateDomains = {
      scene: draft.sceneCandidates.map((candidate) => candidate.id).sort(),
      clue: draft.clueCandidates.map((candidate) => candidate.id).sort(),
      item: draft.itemCandidates.map((candidate) => candidate.id).sort(),
    };

    expect(rewardDomains(reward)).toEqual(expected);
    expect(requestedRewardDomains(requested.candidateDomains)).toEqual(expected);
    for (const [kind, ids] of Object.entries(expected) as Array<[keyof RewardPredicateDomains, string[]]>) {
      const catalogKind = kind === "scene" ? "scene" : kind === "clue" ? "clue" : "item";
      expect(ids).not.toHaveLength(0);
      expect(ids.every((id) => envelope.candidateCatalog.some((candidate) => candidate.id === id && candidate.kind === catalogKind))).toBe(true);
    }
  });

  it("accepts an exact reward proposal whose predicate target is selected only from the emitted request envelope", () => {
    const { graph, queue } = rewardFixture();
    const envelope = buildCompilerHintProposalRequestEnvelope(graph, queue);
    const requested = envelope.questions.find((question) => question.kind === "reward_binding")!;
    const domains = requestedRewardDomains(requested.candidateDomains)!;
    const rewardCandidateId = requested.candidateDomains.subjectCandidateId!;
    const sceneId = domains.scene![0]!;
    const rewardCatalogEntry = envelope.candidateCatalog.find((candidate) => candidate.id === rewardCandidateId && candidate.kind === "reward")!;
    const proposal: CompilerHintProposal = {
      questionId: requested.questionId,
      kind: "reward_binding",
      value: {
        rewardCandidateId,
        declaration: { when: { kind: "scene_visited", sceneId }, settlement: { san: { kind: "fixed", amount: 1 } } },
      },
      citations: [{ claimKey: `reward_binding:${rewardCandidateId}`, statementId: rewardCatalogEntry.sourceStatementId, quote: rewardCatalogEntry.label }],
    };

    const compiled = compileGroundedHintProposals(graph, queue, batchFor(queue, [proposal]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(compiled.rejected).toEqual([]);
    expect(compiled.accepted).toHaveLength(1);
    expect(compiled.hints.resolutions[0]?.audit?.citations).toEqual(proposal.citations);
  });

  it("rejects forged and cross-domain reward predicate IDs before MechanicsIR compilation, including nested predicates", () => {
    const { graph, queue } = rewardFixture();
    const reward = queue.questions.find((question) => question.kind === "reward_binding")!;
    const domains = rewardDomains(reward)!;
    const rewardCandidateId = reward.subjectCandidateId!;
    const row = graph.statements.find((statement) => statement.kind === "table_row" && reward.sourceStatementIds.includes(statement.id))!;
    const declaration = (when: unknown) => ({
      rewardCandidateId,
      declaration: { when, settlement: { san: { kind: "fixed", amount: 1 } } },
    });
    const cases: Array<[string, unknown]> = [
      ["forged scene", { kind: "scene_visited", sceneId: "forged_scene" }],
      ["forged clue", { kind: "clue_found", clueId: "forged_clue" }],
      ["forged item", { kind: "item_owned", itemId: "forged_item" }],
      ["scene uses clue ID", { kind: "scene_visited", sceneId: domains.clue![0]! }],
      ["clue uses item ID", { kind: "clue_found", clueId: domains.item![0]! }],
      ["item uses scene ID", { kind: "item_owned", itemId: domains.scene![0]! }],
      ["nested forged item", { kind: "all", predicates: [{ kind: "scene_visited", sceneId: domains.scene![0]! }, { kind: "any", predicates: [{ kind: "not", predicate: { kind: "item_owned", itemId: "forged_item" } }] }] }],
    ];

    for (const [_label, when] of cases) {
      const value = declaration(when);
      expect(() => parseCompilerHintValue(reward, value, graph)).toThrow("reward predicate");
      const result = compileGroundedHintProposals(graph, queue, batchFor(queue, [{
        questionId: reward.id,
        kind: "reward_binding",
        value,
        citations: [{ claimKey: `reward_binding:${rewardCandidateId}`, statementId: row.id, quote: row.text }],
      }]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
      expect(result.rejected[0]?.code).toBe("unknown_hint_reference");
    }

    const nestedAccepted = declaration({
      kind: "all",
      predicates: [
        { kind: "scene_visited", sceneId: domains.scene![0]! },
        { kind: "any", predicates: [{ kind: "clue_found", clueId: domains.clue![0]! }, { kind: "not", predicate: { kind: "item_owned", itemId: domains.item![0]! } }] },
      ],
    });
    expect(parseCompilerHintValue(reward, nestedAccepted, graph)).toMatchObject({ kind: "reward_binding", declaration: { when: nestedAccepted.declaration.when } });
    expect(() => parseCompilerHintValue(reward, declaration({ kind: "state_eq", stateKey: "forged", value: true }), graph)).toThrow("unsupported predicate");
  });

  it("accepts an explicit null reward declaration without requiring predicate targets", () => {
    const { graph, queue } = rewardFixture();
    const reward = queue.questions.find((question) => question.kind === "reward_binding")!;
    const rewardCandidateId = reward.subjectCandidateId!;
    const withoutTargets = structuredClone(reward) as CompilerQuestion & { allowedRewardPredicateIds?: RewardPredicateDomains };
    delete withoutTargets.allowedRewardPredicateIds;

    expect(parseCompilerHintValue(withoutTargets, { rewardCandidateId, declaration: null }, graph)).toEqual({
      kind: "reward_binding",
      rewardCandidateId,
      declaration: null,
    });
  });

  it("fails closed for a pre-domain prepared queue instead of migrating it", () => {
    const { graph, queue } = rewardFixture();
    const legacy = structuredClone(queue);
    legacy.schemaVersion = "1.8.0" as never;

    expect(() => validateCompilerQuestionQueue(graph, legacy)).toThrow("unsupported compiler question queue schema");
  });

  it("decodes every candidate ID with a source-exact scene or clue label and refuses foreign domains", () => {
    const { graph, queue } = fixture();
    const envelope = buildCompilerHintProposalRequestEnvelope(graph, queue);
    const sceneQuestion = queue.questions.find((question) => question.kind === "scene_role")!;
    const clueQuestion = queue.questions.find((question) => question.kind === "core_clue")!;
    const sceneId = sceneQuestion.subjectCandidateId!;
    const clueId = clueQuestion.subjectCandidateId!;
    const sceneSource = graph.statements.find((statement) => statement.id === sceneQuestion.sourceStatementIds[0])!;
    const clueSource = graph.statements.find((statement) => statement.kind === "marked_item_name" && clueQuestion.sourceStatementIds.includes(statement.parentStatementId ?? ""))!;
    const scene = envelope.candidateCatalog.find((candidate) => candidate.id === sceneId)!;
    const clue = envelope.candidateCatalog.find((candidate) => candidate.id === clueId)!;

    expect(scene).toEqual({ id: sceneId, kind: "scene", label: sceneSource.text, sourceStatementId: sceneSource.id, evidenceRefId: sceneSource.evidenceRefId });
    expect(clue).toEqual({ id: clueId, kind: "clue", label: clueSource.text, sourceStatementId: clueSource.id, evidenceRefId: clueSource.evidenceRefId });
    const entry = envelope.questions.find((question) => question.kind === "entry_scene")!;
    expect(entry.candidateDomains.allowedCandidateIds?.every((id) => envelope.candidateCatalog.some((candidate) => candidate.id === id && candidate.kind === "scene"))).toBe(true);

    const foreignDomain = withQueueHash({
      ...structuredClone(queue),
      questions: queue.questions.map((question) => question.kind === "entry_scene"
        ? { ...structuredClone(question), allowedCandidateIds: [clueId] }
        : structuredClone(question)),
    });
    expect(() => buildCompilerHintProposalRequestEnvelope(graph, foreignDomain)).toThrow("foreign_candidate_domain");
    expect(() => compileGroundedHintProposals(graph, foreignDomain, batchFor(foreignDomain, []), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" })).toThrow("foreign_candidate_domain");
    const unknownCandidate = withQueueHash({
      ...structuredClone(queue),
      questions: queue.questions.map((question) => question.kind === "entry_scene"
        ? { ...structuredClone(question), allowedCandidateIds: ["foreign_candidate"] }
        : structuredClone(question)),
    });
    expect(() => buildCompilerHintProposalRequestEnvelope(graph, unknownCandidate)).toThrow("unknown_candidate_catalog_entry");
  });

  it("accepts a grounded item binding only with candidate-local source-exact name evidence and matching citation", () => {
    const { graph, queue } = fixture();
    const item = queue.questions.find((question) => question.kind === "item_binding")!;
    const evidence = graph.statements.find((statement) => statement.id === item.allowedItemNameEvidenceStatementIds![1])!;
    const proposal: CompilerHintProposal = {
      questionId: item.id,
      kind: "item_binding",
      value: {
        itemCandidateId: item.subjectCandidateId,
        itemType: "key",
        itemNameEvidence: { statementId: evidence.id, quote: evidence.text },
      },
      citations: [{ claimKey: `item_binding:${item.subjectCandidateId}`, statementId: evidence.id, quote: evidence.text }],
    };
    const accepted = compileGroundedHintProposals(graph, queue, batchFor(queue, [proposal]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.hints.resolutions[0]?.value).toMatchObject({
      itemNameEvidence: { statementId: evidence.id, quote: evidence.text },
    });
    const missingEvidence = structuredClone(proposal);
    delete (missingEvidence.value as { itemNameEvidence?: unknown }).itemNameEvidence;
    expect(compileGroundedHintProposals(graph, queue, batchFor(queue, [missingEvidence]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" }).rejected[0]?.code).toBe("invalid_hint_value");
    const nullWithEvidence = structuredClone(proposal);
    nullWithEvidence.value = { itemCandidateId: item.subjectCandidateId, itemType: null, itemNameEvidence: { statementId: evidence.id, quote: evidence.text } };
    nullWithEvidence.citations[0]!.claimKey = `item_binding:none:${item.subjectCandidateId}`;
    expect(compileGroundedHintProposals(graph, queue, batchFor(queue, [nullWithEvidence]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" }).rejected[0]?.code).toBe("invalid_hint_value");
    const otherItem = queue.questions.find((question) => question.kind === "item_binding" && question.id !== item.id)!;
    const otherStatementId = otherItem.allowedItemNameEvidenceStatementIds![0]!;
    const otherStatement = graph.statements.find((statement) => statement.id === otherStatementId)!;
    const crossCandidate = structuredClone(proposal);
    (crossCandidate.value as { itemNameEvidence: { statementId: string; quote: string } }).itemNameEvidence = { statementId: otherStatement.id, quote: otherStatement.text };
    crossCandidate.citations[0]!.statementId = otherStatement.id;
    crossCandidate.citations[0]!.quote = otherStatement.text;
    expect(compileGroundedHintProposals(graph, queue, batchFor(queue, [crossCandidate]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" }).rejected[0]?.code).toBe("unknown_hint_reference");
    const forged = structuredClone(proposal);
    forged.citations[0]!.quote = "正文";
    expect(compileGroundedHintProposals(graph, queue, batchFor(queue, [forged]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" }).rejected[0]?.code).toBe("invalid_audit");
  });

  it("gives an explicitly source-only item its own cited none claim instead of silently treating it as a runtime binding", () => {
    const { graph, queue } = fixture();
    const item = queue.questions.find((question) => question.kind === "item_binding")!;
    const name = graph.statements.find((statement) => statement.kind === "marked_item_name" && item.sourceStatementIds.includes(statement.id))!;
    const proposal: CompilerHintProposal = {
      questionId: item.id,
      kind: "item_binding",
      value: { itemCandidateId: item.subjectCandidateId, itemType: null },
      citations: [{ claimKey: `item_binding:none:${item.subjectCandidateId}`, statementId: name.id, quote: name.text }],
    };
    const accepted = compileGroundedHintProposals(graph, queue, batchFor(queue, [proposal]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.hints.resolutions[0]?.audit?.citations).toEqual(proposal.citations);
    const runtimeClaim = structuredClone(proposal);
    runtimeClaim.citations[0]!.claimKey = `item_binding:${item.subjectCandidateId}`;
    expect(compileGroundedHintProposals(graph, queue, batchFor(queue, [runtimeClaim]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" }).rejected[0]?.code).toBe("unknown_claim_key");
  });

  it("accepts dynamically generated IDs into partial hints and preserves proposal audit through apply", () => {
    const { graph, queue } = fixture();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const topology = queue.questions.find((question) => question.kind === "connection_topology")!;
    const topologyTargets = topology.allowedCandidateIds?.filter((id) => id !== topology.subjectCandidateId) ?? [];
    const firstTarget = topologyTargets[0]!;
    const secondTarget = topologyTargets[1] ?? firstTarget;
    const topologyStatements = topology.sourceStatementIds.map((id) => graph.statements.find((statement) => statement.id === id)!);
    const topologyProposal: CompilerHintProposal = {
      questionId: topology.id,
      kind: "connection_topology",
      value: { connections: [
        { toSceneCandidateId: firstTarget, connectionId: "connection_alpha" },
        { toSceneCandidateId: secondTarget, connectionId: "connection_beta" },
      ] },
      citations: [
        { claimKey: "connection:connection_alpha", statementId: topologyStatements[0]!.id, quote: topologyStatements[0]!.text },
        { claimKey: "connection:connection_beta", statementId: topologyStatements[0]!.id, quote: topologyStatements[0]!.text },
      ],
    };
    const result = compileGroundedHintProposals(graph, queue, batchFor(queue, [roleProposal(graph, role), topologyProposal]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
    expect(result.hints.resolutions[0]).toMatchObject({
      authority: "user_document",
      derivation: "explicit",
      reviewerKind: "approved_policy",
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
      audit: {
        proposalId: "proposal_fixture_1",
        policyId: "grounded-proposal-policy-v1",
        citations: [exactCitation(graph, role)],
      },
    });
    expect(result.hints.resolutions[0]?.sourceStatementIds).toEqual(role.sourceStatementIds);
    expect(result.hints.resolutions[0]?.evidenceRefs).toEqual(role.evidenceRefs);
    try {
      validateModuleCompileHints(queue, result.hints);
      throw new Error("expected audit validation without a graph to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "audit_requires_graph" });
    }
    const applied = applyModuleCompileHints(graph, queue, result.hints);
    expect(applied.questions.find((question) => question.id === role.id)?.resolution?.audit).toEqual(result.hints.resolutions[0]?.audit);
    expect(applied.questions.some((question) => question.kind === "entry_scene" && question.status === "open")).toBe(true);
    expect(buildCompilerHintProposalRequestEnvelope(graph, applied).questions.find((question) => question.questionId === role.id)?.allowedKinds).toEqual([]);
  });

  it("requires one exact citation for every ending declaration in a real queue", () => {
    const { graph, queue } = fixture();
    const ending = queue.questions.find((question) => question.kind === "ending_rule")!;
    const candidates = ending.allowedCandidateIds!;
    const firstSceneId = candidates[0]!;
    const secondSceneId = candidates[1] ?? firstSceneId;
    const firstStatement = graph.statements.find((statement) => statement.id === ending.sourceStatementIds[0]!)!;
    const value = {
      declarations: [
        {
          endingId: "ending_alpha",
          spec: {
            kind: "ending_rule",
            id: "rule_alpha",
            priority: 10,
            when: { kind: "scene_visited", sceneId: firstSceneId },
            effects: [{ kind: "end_game", endingId: "ending_alpha" }],
          },
        },
        {
          endingId: "ending_beta",
          spec: {
            kind: "ending_rule",
            id: "rule_beta",
            priority: 20,
            when: { kind: "scene_visited", sceneId: secondSceneId },
            effects: [{ kind: "end_game", endingId: "ending_beta" }],
          },
        },
      ],
    };
    const proposal: CompilerHintProposal = {
      questionId: ending.id,
      kind: "ending_rule",
      value,
      citations: [
        { claimKey: "ending:ending_alpha", statementId: firstStatement.id, quote: firstStatement.text },
        { claimKey: "ending:ending_beta", statementId: firstStatement.id, quote: firstStatement.text },
      ],
    };
    const accepted = compileGroundedHintProposals(graph, queue, batchFor(queue, [proposal]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.hints.resolutions[0]?.audit?.citations.map((citation) => citation.claimKey)).toEqual(["ending:ending_alpha", "ending:ending_beta"]);

    const missingOne = { ...proposal, citations: [proposal.citations[0]!] };
    const rejected = compileGroundedHintProposals(graph, queue, batchFor(queue, [missingOne]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    expect(rejected.accepted).toEqual([]);
    expect(rejected.rejected[0]?.code).toBe("missing_claim_citation");
  });

  it("accepts a live-style ending proposal using the exact Predicate and Effect DSL", () => {
    const { graph, queue } = fixture();
    const ending = queue.questions.find((question) => question.kind === "ending_rule")!;
    const sceneId = queue.questions.find((question) => question.kind === "scene_role")!.subjectCandidateId!;
    const clueId = queue.questions.find((question) => question.kind === "core_clue")!.subjectCandidateId!;
    const endingId = "ending_live_escape";
    const proposal: CompilerHintProposal = {
      questionId: ending.id,
      kind: "ending_rule",
      value: {
        declarations: [{
          endingId,
          spec: {
            kind: "ending_rule",
            id: "rule_live_escape",
            priority: 10,
            when: {
              kind: "all",
              predicates: [
                { kind: "scene_visited", sceneId },
                { kind: "any", predicates: [{ kind: "clue_found", clueId }, { kind: "not", predicate: { kind: "connection_unlocked", connectionId: "connection_live_escape" } }] },
                { kind: "state_eq", stateKey: "chapter_complete", value: true },
              ],
            },
            effects: [
              { kind: "set_state", stateKey: "chapter_complete", value: true },
              { kind: "unlock_connection", connectionId: "connection_live_escape" },
              { kind: "end_game", endingId },
            ],
          },
        }],
      },
      citations: [exactCitation(graph, ending, `ending:${endingId}`)],
    };

    const result = compileGroundedHintProposals(graph, queue, batchFor(queue, [proposal]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    expect(result.hints.resolutions[0]?.value).toEqual(proposal.value);
  });

  it("rejects ungrounded or semantically invalid proposals without accepting their partial batch entries", () => {
    const { graph, queue } = fixture();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const item = queue.questions.find((question) => question.kind === "item_binding")!;
    const prose = queue.questions.find((question) => question.kind === "source_fact_disposition")!;
    const foreign = queue.questions.find((question) => question.id !== role.id && question.sourceStatementIds.some((id) => !role.sourceStatementIds.includes(id)))!;
    const foreignStatementId = foreign.sourceStatementIds.find((id) => !role.sourceStatementIds.includes(id))!;
    const foreignStatement = graph.statements.find((statement) => statement.id === foreignStatementId)!;
    const entry = queue.questions.find((question) => question.kind === "entry_scene")!;
    const invalidDsl = { ...roleProposal(graph, role), value: { role: "not_a_scene_role" } };
    const invalidTarget = { questionId: entry.id, kind: "entry_scene" as const, value: { sceneCandidateId: "invented" }, citations: [exactCitation(graph, entry, "entry_scene")] };
    const kindMismatch = { ...roleProposal(graph, role), kind: "entry_scene" as const, citations: [exactCitation(graph, role, "entry_scene")] };
    const foreignQuote = { ...roleProposal(graph, role), citations: [{ claimKey: "scene_role", statementId: foreignStatement.id, quote: foreignStatement.text }] };
    const hallucinatedQuote = { ...roleProposal(graph, role), citations: [{ claimKey: "scene_role", statementId: role.sourceStatementIds[0]!, quote: "invented quotation" }] };
    const emptyQuote = { ...roleProposal(graph, role), citations: [{ claimKey: "scene_role", statementId: role.sourceStatementIds[0]!, quote: "" }] };
    const missingClaim = { ...roleProposal(graph, role), citations: [] };
    const extraClaim = { ...roleProposal(graph, role), citations: [exactCitation(graph, role), exactCitation(graph, role, "extra")] };
    const duplicateClaim = { ...roleProposal(graph, role), citations: [exactCitation(graph, role), exactCitation(graph, role)] };
    const itemBinding = { questionId: item.id, kind: "item_binding" as const, value: { itemCandidateId: item.subjectCandidateId }, citations: [exactCitation(graph, item, "item_binding")] };
    const genericProse = { questionId: prose.id, kind: "source_fact_disposition" as const, value: { clueCandidateId: "forged" }, citations: [exactCitation(graph, prose, `source_fact_disposition:${prose.subjectStatementId}`)] };
    const proposals = [invalidDsl, invalidTarget, kindMismatch, foreignQuote, hallucinatedQuote, emptyQuote, missingClaim, extraClaim, duplicateClaim, itemBinding, genericProse];
    const codes = proposals.map((proposal) => {
      const result = compileGroundedHintProposals(graph, queue, batchFor(queue, [proposal]), {
        policyId: "grounded-proposal-policy-v1",
        rightsStatus: "user_provided",
      });
      expect(result.accepted).toEqual([]);
      expect(result.hints.resolutions).toEqual([]);
      return result.rejected[0]?.code;
    });

    expect(codes.sort()).toEqual([
      "empty_quote",
      "foreign_statement",
      "hallucinated_quote",
      "invalid_hint_value",
      "invalid_hint_value",
      "kind_mismatch",
      "missing_claim_citation",
      "unknown_hint_reference",
      "unknown_claim_key",
      "duplicate_claim_key",
      "invalid_hint_value",
    ].sort());
  });

  it("rejects proposal-controlled authority metadata and fails the entire batch for stale identity or duplicate question proposals", () => {
    const { graph, queue } = fixture();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const forged = { ...roleProposal(graph, role), authority: "project_original" } as unknown as CompilerHintProposal;
    const rejected = compileGroundedHintProposals(graph, queue, batchFor(queue, [forged]), {
      policyId: "grounded-proposal-policy-v1",
      rightsStatus: "user_provided",
    });
    expect(rejected.rejected[0]?.code).toBe("forbidden_proposal_field");

    const stale = batchFor(queue, [roleProposal(graph, role)]);
    stale.queueHash = "stale";
    expect(() => compileGroundedHintProposals(graph, queue, stale, { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" })).toThrow("identity_mismatch");
    const unsupportedBatchSchema = { ...batchFor(queue, [roleProposal(graph, role)]), schemaVersion: "1.1.0" } as unknown as CompilerHintProposalBatch;
    expect(() => compileGroundedHintProposals(graph, queue, unsupportedBatchSchema, { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" })).toThrow("schema_mismatch");
    const wrongDocument = batchFor(queue, [roleProposal(graph, role)]);
    wrongDocument.documentHash = "wrong-document";
    expect(() => compileGroundedHintProposals(graph, queue, wrongDocument, { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" })).toThrow("identity_mismatch");
    expect(() => compileGroundedHintProposals(graph, queue, batchFor(queue, [roleProposal(graph, role), roleProposal(graph, role)]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" })).toThrow("duplicate_question_proposal");
    const first = compileGroundedHintProposals(graph, queue, batchFor(queue, [roleProposal(graph, role)]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" });
    const answeredQueue = applyModuleCompileHints(graph, queue, first.hints);
    expect(() => compileGroundedHintProposals(graph, answeredQueue, batchFor(answeredQueue, [roleProposal(graph, role)]), { policyId: "grounded-proposal-policy-v1", rightsStatus: "user_provided" })).toThrow("conflicting_resolution");
  });
});
