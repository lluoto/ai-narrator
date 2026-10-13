import { describe, expect, it } from "bun:test";
import { applyModuleCompileHints } from "../compiler/compile-hint-resolution";
import { buildCompilerHintProposalRequestEnvelope, type CompilerHintProposal, type TrustedCompilerHintProposalPolicy } from "../compiler/compiler-hint-proposals";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, buildCompilerQuestionQueue, validateModuleCompileHints, withQueueHash, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { compileDeterministicTemplates } from "../compiler/deterministic-template-compiler";
import { buildSourceFactGraph, type SourceFactGraph } from "../compiler/source-fact-graph";
import {
  requestCompilerHintProposals,
  type CompilerHintProposalAdapterLimits,
  type CompilerHintProposalAdapterInput,
} from "../api/compiler-hint-proposal-adapter";
import { LLMClient, type ChatOptions, type LLMLike, type Message } from "../llm/client";
import { cleanPageWithTrace, joinPagesWithTrace } from "../ingest/clean-text";
import { buildDocumentBlocks } from "../ingest/document-blocks";
import { createSyntheticDocumentIR } from "../ingest/document-ir";

function fixture() {
  const document = createSyntheticDocumentIR(["Scene One:\nordinary prose.\n◆ Key: exact text.\nScene Two:\n◆ Other: exact text."], "llm-hint-adapter");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "llm-hint-adapter" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

/** Covers every ordinary compiler kind without enabling source-fact or NPC capabilities. */
function ordinaryContractFixture() {
  const document = createSyntheticDocumentIR([
    "入口：\n普通叙述不能凭空绑定线索。\n▶父线索：一把刻有档案室标记的钥匙。\n档案室：\n▶子线索：一份需要检定才能读懂的档案。\n出口：\n▶出口说明：离开这里的旧车票。",
  ], "llm-hint-adapter-ordinary-contract");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "llm-hint-adapter-ordinary-contract" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

/**
 * A fresh deterministic queue with a broad, closed entry-scene domain.  The
 * individual labels are deliberately long enough to make prompt boilerplate
 * observable while remaining ordinary source text and candidate evidence.
 */
function broadEntryPromptFixture() {
  const moduleId = "llm-hint-adapter-broad-entry";
  const sceneBody = "The location retains ordinary source-bound context for its closed candidate domain, including a physical landmark, a route detail, and a mundane observation that distinguish it from every other location.";
  const document = createSyntheticDocumentIR([
    [
      "Entrance:\nOrdinary entry source text.",
      ...Array.from({ length: 49 }, (_, index) => `Location ${String(index + 1).padStart(2, "0")}:\n${sceneBody} This is location ${index + 1}.`),
      "Exit:\nOrdinary exit source text.",
    ].join("\n\n"),
  ], moduleId);
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId });
  const queue = buildCompilerQuestionQueue(graph, draft);
  const entry = queue.questions.find((question) => question.kind === "entry_scene");
  if (!entry?.allowedCandidateIds?.length) throw new Error("broad entry prompt fixture lacks the closed entry domain");
  return { graph, queue, entry };
}

function itemFixture() {
  const document = createSyntheticDocumentIR(["Study:\n\u25B6 Copper Key: Exact source-bound item evidence."], "llm-hint-adapter-item");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "llm-hint-adapter-item" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

function npcFixture() {
  const document = createSyntheticDocumentIR(["Dock:\nCaptain Mira waits beside the launch.\nExit:\nThe road leaves town."], "llm-hint-adapter-npc");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "llm-hint-adapter-npc" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

function automaticNpcEncounterFixture() {
  const moduleId = "llm-hint-adapter-automatic-encounter";
  const document = createSyntheticDocumentIR(["Dock:\nMira attacks the investigators. HP 2. Dodge 30. Fight 40. Damage 1d2.\nExit:"], moduleId);
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

/** The profile heading has an earlier statement ID than the anchor location. */
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
  const npc = queue.questions.find((question) => question.kind === "npc_binding" && question.subjectCandidateId === anchor.id);
  const profileHeading = graph.statements.find((statement) => statement.kind === "heading" && statement.text.trim() === "Mira:");
  const locationRole = queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === anchor.sceneCandidateId);
  const profileScene = profileHeading && draft.sceneCandidates.find((candidate) => candidate.headingStatementId === profileHeading.id);
  const profileRole = profileScene && queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === profileScene.id);
  if (!npc || !profileHeading || !locationRole || !profileRole) throw new Error("cross-heading NPC fixture scope missing");
  const sourceHeadings = npc.sourceStatementIds.filter((id) => graph.statements.find((statement) => statement.id === id)?.kind === "heading");
  if (sourceHeadings[0] !== profileHeading.id || !sourceHeadings.includes(anchor.headingStatementId)) {
    throw new Error("cross-heading NPC fixture did not put the profile heading before its location heading");
  }
  return { graph, queue, npc, locationRole, profileRole };
}

function sourceFactMechanicsFixture() {
  const document = createSyntheticDocumentIR(["Dock:\nA wet note says the key is hidden nearby.\n\n\u25b6 Rust Key: A rusted key lies under the crate."], "llm-hint-adapter-source-fact-mechanics");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "llm-hint-adapter-source-fact-mechanics" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

function proseFactFindingFixture(moduleId = "llm-hint-adapter-prose-finding") {
  const document = createSyntheticDocumentIR([
    "Archive:\nThe camera is old. 成功的知识鉴定后，调查员可以重播整个仪式的录像。 The monitor is dark.\nExit:",
  ], moduleId);
  const graph = buildSourceFactGraph(document, buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace))));
  const draft = compileDeterministicTemplates(graph, { moduleId });
  const queue = buildCompilerQuestionQueue(graph, draft);
  const parent = queue.questions.find((question) => question.kind === "source_fact_disposition" && question.sourceFactChildQuestionId);
  const child = parent && queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId);
  const sceneRole = child && queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId);
  const root = parent && graph.statements.find((statement) => statement.id === parent.subjectStatementId);
  if (!parent || !child || !sceneRole || !root || !child.allowedProseFactFindingCandidates?.length || !child.allowedSourceFactAtoms?.length) {
    throw new Error("prose finding adapter fixture scope missing");
  }
  return { graph, queue, parent, child, sceneRole, root };
}

function tableDispositionFixture() {
  const document = createSyntheticDocumentIR(["Rewards:\nSAN +1d6\nCM +2\nCR +3\nHP 10\nAttack 1d6"], "llm-hint-adapter-table-disposition");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "llm-hint-adapter-table-disposition" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

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
  ].join("\n")], "llm-hint-adapter-reward");
  const blocks = buildDocumentBlocks(document, joinPagesWithTrace(document.pages.map(cleanPageWithTrace)));
  const graph = buildSourceFactGraph(document, blocks);
  const draft = compileDeterministicTemplates(graph, { moduleId: "llm-hint-adapter-reward" });
  return { graph, queue: buildCompilerQuestionQueue(graph, draft) };
}

function exactCitation(graph: SourceFactGraph, question: CompilerQuestion, claimKey = "scene_role") {
  const statement = graph.statements.find((candidate) => candidate.id === question.sourceStatementIds[0])!;
  return { claimKey, statementId: statement.id, quote: statement.text };
}

function roleProposal(graph: SourceFactGraph, question: CompilerQuestion, role = "playable_scene"): CompilerHintProposal {
  return { questionId: question.id, kind: "scene_role", value: { role }, citations: [exactCitation(graph, question)] };
}

function sourceFactDispositionProposal(graph: SourceFactGraph, question: CompilerQuestion, disposition: "source_only" | "mechanics_candidate"): CompilerHintProposal {
  const statementId = question.subjectStatementId;
  if (!statementId) throw new Error("source fact disposition fixture lacks a root statement");
  return {
    questionId: question.id,
    kind: "source_fact_disposition",
    value: { statementId, disposition },
    citations: [exactCitation(graph, question, `source_fact_disposition:${statementId}`)],
  };
}

function humanResolution(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
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
    reason: "adapter source fact transition fixture",
  };
}

function itemProposal(graph: SourceFactGraph, question: CompilerQuestion, itemType: "key" | "document" | "loot" | null, claimKey?: string): CompilerHintProposal {
  const name = question.sourceStatementIds
    .map((statementId) => graph.statements.find((statement) => statement.id === statementId))
    .find((statement) => statement?.kind === "marked_item_name")!;
  const itemCandidateId = question.subjectCandidateId!;
  const itemNameEvidence = itemType === null ? undefined : { statementId: name.id, quote: name.text };
  return {
    questionId: question.id,
    kind: "item_binding",
    value: { itemCandidateId, itemType, ...(itemNameEvidence ? { itemNameEvidence } : {}) },
    citations: [{
      claimKey: claimKey ?? (itemType === null ? `item_binding:none:${itemCandidateId}` : `item_binding:${itemCandidateId}`),
      statementId: name.id,
      quote: name.text,
    }],
  };
}

type FakeReply = string | Error | ((messages: Message[], options: ChatOptions | undefined, call: number) => string | Error);

/** AbortSignal is a live capability and must not be sent through structuredClone. */
function snapshotChatOptions(options: ChatOptions | undefined): ChatOptions | undefined {
  if (!options) return undefined;
  const { signal, ...serializable } = options;
  return { ...structuredClone(serializable), ...(signal ? { signal } : {}) };
}

class FakeLLM implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options: ChatOptions | undefined }> = [];

  constructor(private readonly replies: FakeReply[]) {}

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    const call = this.calls.length;
    this.calls.push({ messages: structuredClone(messages), options: snapshotChatOptions(options) });
    const reply = this.replies[call];
    if (reply === undefined) throw new Error(`unexpected fake call ${call}`);
    const value = typeof reply === "function" ? reply(messages, options, call) : reply;
    if (value instanceof Error) throw value;
    return value;
  }
}

function input(graph: SourceFactGraph, queue: ReturnType<typeof fixture>["queue"], llm: LLMLike, limits: Partial<CompilerHintProposalAdapterInput["limits"]> = {}): CompilerHintProposalAdapterInput {
  return {
    graph,
    queue,
    llm,
    policy: { policyId: "trusted-policy-v1", rightsStatus: "user_provided" },
    producer: { providerFingerprint: "provider:test-v1", modelFingerprint: "model:test-v1" },
    // Most behavior tests exercise one request; the adapter's conservative
    // production default has a dedicated bound test below.
    limits: { maxQuestionsPerRequest: 8, ...limits },
  };
}

function response(proposals: unknown[]): string {
  return JSON.stringify({ proposals });
}

interface RequestedEnvelope {
  questions: Array<{
    questionId: string;
    kind: string;
    prompt: string;
    allowedKinds: string[];
    sourceStatements: Array<{ statementId: string; text: string }>;
    candidateDomains: {
      candidateIds?: string[];
      subjectCandidateId?: string;
      allowedCandidateIds?: string[];
      allowedLocationCandidateIds?: string[];
      allowedMechanicsTargetIds?: Record<string, string[]>;
      allowedSourceFactMechanicKinds?: string[];
      allowedSourceFactAtoms?: Array<{ atomId: string; quote: string; statementId: string }>;
      allowedProseFactFindingCandidates?: Array<{
        candidateId: string;
        atomId: string;
        quote: string;
        check: { kind: string; attribute?: string; difficulty?: string };
      }>;
      allowedItemNameEvidenceStatementIds?: string[];
      allowedRewardPredicateIds?: Partial<Record<"scene" | "clue" | "item", string[]>>;
      allowedNpcEncounterProfiles?: Array<{
        headingStatementId: string;
        requiredNameQuote?: string;
        statCandidates: Record<"maxHp" | "dodge" | "fight" | "npcDamage", Array<{ statementId: string; quote: string }>>;
      }>;
    };
  }>;
  candidateCatalog: Array<{ id: string; kind: string; label: string; sourceStatementId: string }>;
}

function requestedEnvelope(messages: Message[]): RequestedEnvelope {
  const content = messages[1]?.content ?? "";
  const envelopeText = content.slice(content.lastIndexOf("REQUEST ENVELOPE:\n") + "REQUEST ENVELOPE:\n".length);
  return JSON.parse(envelopeText) as RequestedEnvelope;
}

function requestedQuestionIds(messages: Message[]): string[] {
  return requestedEnvelope(messages).questions.map((question) => question.questionId);
}

/** The private model view may compact catalog metadata, never question scope. */
function expectModelQuestionScopes(
  messages: Message[],
  graph: SourceFactGraph,
  queue: ReturnType<typeof fixture>["queue"],
  policy?: TrustedCompilerHintProposalPolicy,
) {
  const trusted = buildCompilerHintProposalRequestEnvelope(graph, queue, policy);
  for (const actual of requestedEnvelope(messages).questions) {
    const expected = trusted.questions.find((question) => question.questionId === actual.questionId);
    if (!expected) throw new Error(`model prompt carried an unknown question ${actual.questionId}`);
    const actualScope: unknown = {
      questionId: actual.questionId,
      kind: actual.kind,
      allowedKinds: actual.allowedKinds,
      sourceStatements: actual.sourceStatements,
      candidateDomains: actual.candidateDomains,
    };
    const trustedScope: unknown = {
      questionId: expected.questionId,
      kind: expected.kind,
      allowedKinds: expected.allowedKinds,
      sourceStatements: expected.sourceStatements,
      candidateDomains: expected.candidateDomains,
    };
    expect(actualScope).toEqual(trustedScope);
  }
}

/** The adapter's prompt budget is intentionally JavaScript UTF-16 String.length, not UTF-8 bytes. */
function promptChars(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function queueWithOnlyOpenQuestions(queue: ReturnType<typeof fixture>["queue"], questionIds: readonly string[]) {
  const open = new Set(questionIds);
  return withQueueHash({
    ...structuredClone(queue),
    questions: queue.questions.map((question) => ({
      ...structuredClone(question),
      status: open.has(question.id) ? "open" as const : "deferred" as const,
    })),
  });
}

describe("LLMLike compiler hint proposal adapter", () => {
  it("answers scene roles within a small prompt budget without weakening citation validation", async () => {
    const { graph, queue } = fixture();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const selected = queueWithOnlyOpenQuestions(queue, [role.id]);
    const valid = roleProposal(graph, role, "playable_scene");
    const llm = new FakeLLM([response([valid])]);
    const result = await requestCompilerHintProposals(input(graph, selected, llm, { maxPromptChars: 6_000 }));
    expect(result.accepted).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);
    expect(promptChars(llm.calls[0]!.messages)).toBeLessThanOrEqual(6_000);
    expect(requestedEnvelope(llm.calls[0]!.messages).questions[0]!.sourceStatements.length).toBeGreaterThan(0);
    const forged = { ...valid, citations: [{ ...valid.citations[0]!, quote: "Invented source evidence." }] };
    const refused = await requestCompilerHintProposals(input(graph, selected, new FakeLLM([response([forged])]), { maxPromptChars: 6_000 }));
    expect(refused.callCount).toBe(1);
    expect(refused.accepted).toHaveLength(0);
  });

  it("fits a fresh broad entry-scene domain under the production 24k prompt cap and accepts its legal claim", async () => {
    const { graph, queue, entry } = broadEntryPromptFixture();
    expect(entry.allowedCandidateIds).toHaveLength(51);
    const selected = queueWithOnlyOpenQuestions(queue, [entry.id]);
    const sceneCandidateId = entry.allowedCandidateIds![1] ?? entry.allowedCandidateIds![0]!;
    const proposal: CompilerHintProposal = {
      questionId: entry.id,
      kind: "entry_scene",
      value: { sceneCandidateId },
      citations: [exactCitation(graph, entry, "entry_scene")],
    };
    const llm = new FakeLLM([response([proposal])]);

    const result = await requestCompilerHintProposals(input(graph, selected, llm, {
      maxQuestionsPerRequest: 1,
      maxRequestsPerRound: 1,
      maxRequestChars: 24_000,
      maxPromptChars: 24_000,
    }));

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ questionId: entry.id });
    expect(llm.calls).toHaveLength(1);
    expect(promptChars(llm.calls[0]!.messages)).toBeLessThanOrEqual(24_000);
    expect(requestedEnvelope(llm.calls[0]!.messages).candidateCatalog).toHaveLength(entry.allowedCandidateIds!.length);
  });

  it("uses only each fresh singleton kind's required grammar under the 24k cap", async () => {
    const { graph, queue } = broadEntryPromptFixture();
    const topology = queue.questions.find((question) => question.kind === "connection_topology");
    const ending = queue.questions.find((question) => question.kind === "ending_rule");
    const item = itemFixture();
    const facet = item.queue.questions.find((question) => question.kind === "clue_fact_facets");
    if (!topology || !ending || !facet) throw new Error("singleton prompt fixture lacks a required question");

    const singleton = async (sourceGraph: SourceFactGraph, sourceQueue: typeof queue, question: CompilerQuestion) => {
      const llm = new FakeLLM([response([])]);
      const result = await requestCompilerHintProposals(input(sourceGraph, queueWithOnlyOpenQuestions(sourceQueue, [question.id]), llm, {
        maxQuestionsPerRequest: 1,
        maxRequestsPerRound: 1,
        maxRequestChars: 24_000,
        maxPromptChars: 24_000,
      }));
      if (!llm.calls[0]) throw new Error(`singleton ${question.kind} did not reach the fake`);
      return { result, prompt: llm.calls[0].messages[1]!.content, messages: llm.calls[0].messages };
    };

    const topologyRequest = await singleton(graph, queue, topology);
    expect(topologyRequest.result.rejected).toEqual([]);
    expect(topologyRequest.prompt).toContain('"onTraverse":Effect[]');
    expect(topologyRequest.prompt).toContain("A topology connection may have only");
    expect(topologyRequest.prompt).not.toContain("An ending declaration has spec");
    expect(topologyRequest.prompt).not.toContain("Item binding has exactly two contracts");
    expect(promptChars(topologyRequest.messages)).toBeLessThanOrEqual(24_000);

    const endingLlm = new FakeLLM([]);
    const endingResult = await requestCompilerHintProposals(input(graph, queueWithOnlyOpenQuestions(queue, [ending.id]), endingLlm, {
      maxQuestionsPerRequest: 1,
      maxRequestsPerRound: 1,
      maxRequestChars: 24_000,
      maxPromptChars: 24_000,
    }));
    // The model catalog remains lossless. This broad ending still exceeds the
    // fixed cap after kind shaping, so it must remain a no-dispatch refusal.
    expect(endingLlm.calls).toEqual([]);
    expect(endingResult.rejected).toContainEqual(expect.objectContaining({
      questionId: ending.id,
      code: "question_exceeds_request_limit",
      stage: "chunking",
    }));

    const facetRequest = await singleton(item.graph, item.queue, facet);
    expect(facetRequest.result.rejected).toEqual([]);
    expect(facetRequest.prompt).toContain("Partition every offered atom exactly once");
    expect(facetRequest.prompt).toContain("regular|hard|extreme");
    expect(facetRequest.prompt).not.toContain("Item binding has exactly two contracts");
    expect(facetRequest.prompt).not.toContain("Reward binding =");
  });

  it("keeps the mixed item and reward dependency union while omitting unrelated contracts", async () => {
    const { graph, queue } = rewardFixture();
    const item = queue.questions.find((question) => question.kind === "item_binding");
    const reward = queue.questions.find((question) => question.kind === "reward_binding");
    if (!item || !reward) throw new Error("mixed prompt fixture lacks item or reward binding");
    const selected = queueWithOnlyOpenQuestions(queue, [item.id, reward.id]);
    const llm = new FakeLLM([response([])]);

    const result = await requestCompilerHintProposals(input(graph, selected, llm, {
      maxQuestionsPerRequest: 2,
      maxRequestsPerRound: 1,
      maxRequestChars: 24_000,
      maxPromptChars: 24_000,
    }));

    const messages = llm.calls[0]!.messages;
    const prompt = messages[1]!.content;
    const envelope = requestedEnvelope(messages);
    expect(result.rejected).toEqual([]);
    expect(requestedQuestionIds(messages).sort()).toEqual([item.id, reward.id].sort());
    expectModelQuestionScopes(messages, graph, selected);
    expect(prompt).toContain("Item binding has exactly two contracts");
    expect(prompt).toContain("Reward binding =");
    expect(prompt).toContain("candidateDomains.allowedRewardPredicateIds.clue, .scene, and .item respectively");
    expect(prompt).not.toContain("An ending declaration has spec");
    expect(prompt).not.toContain("A topology connection may have only");
    const referenced = [
      ...(item.candidateIds ?? []),
      ...(item.allowedCandidateIds ?? []),
      ...(reward.candidateIds ?? []),
      ...(reward.allowedCandidateIds ?? []),
      ...Object.values(reward.allowedRewardPredicateIds ?? {}).flatMap((ids) => ids ?? []),
    ];
    expect(referenced.every((id) => envelope.candidateCatalog.some((candidate) => candidate.id === id))).toBe(true);
  });

  it("unions entry, topology, ending, and facet grammar in one actual fresh queue chunk", async () => {
    const { graph, queue } = itemFixture();
    const entry = queue.questions.find((question) => question.kind === "entry_scene");
    const topology = queue.questions.find((question) => question.kind === "connection_topology");
    const ending = queue.questions.find((question) => question.kind === "ending_rule");
    const facet = queue.questions.find((question) => question.kind === "clue_fact_facets");
    if (!entry || !topology || !ending || !facet) throw new Error("kind-union fixture lacks an ordinary singleton question");
    const selected = queueWithOnlyOpenQuestions(queue, [entry.id, topology.id, ending.id, facet.id]);
    const llm = new FakeLLM([response([])]);

    const result = await requestCompilerHintProposals(input(graph, selected, llm, {
      maxQuestionsPerRequest: 4,
      maxRequestsPerRound: 1,
      maxRequestChars: 24_000,
      maxPromptChars: 24_000,
    }));

    expect(result.rejected).toEqual([]);
    expect(llm.calls).toHaveLength(1);
    expect(requestedQuestionIds(llm.calls[0]!.messages).sort()).toEqual([entry.id, topology.id, ending.id, facet.id].sort());
    expectModelQuestionScopes(llm.calls[0]!.messages, graph, selected);
    const prompt = llm.calls[0]!.messages[1]!.content;
    expect(prompt).toContain('- entry_scene: {"sceneCandidateId":"a listed candidate id"}');
    expect(prompt).toContain("A topology connection may have only");
    expect(prompt).toContain("An ending declaration has spec");
    expect(prompt).toContain("Partition every offered atom exactly once");
    expect(prompt).toContain("- Predicate =");
    expect(prompt).toContain("- Effect =");
    expect(prompt).toContain("- Check =");
    expect(prompt).not.toContain("Item binding has exactly two contracts");
    expect(prompt).not.toContain("Reward binding =");
    expect(promptChars(llm.calls[0]!.messages)).toBeLessThanOrEqual(24_000);
  });

  it("states the validator's ordinary citation keys and legal ordinary mechanism-ID boundary per chunk", async () => {
    const { graph, queue } = ordinaryContractFixture();
    const ordinaryKinds = ["scene_role", "entry_scene", "connection_topology", "core_clue", "ending_rule", "discovery_method"] as const;
    const ordinaryQuestionIds = new Set(ordinaryKinds.map((kind) => {
      const question = queue.questions.find((candidate) => candidate.kind === kind);
      if (!question) throw new Error(`ordinary contract fixture lacks ${kind}`);
      return question.id;
    }));
    const selected = withQueueHash({
      ...structuredClone(queue),
      // Keep every trusted candidate-bearing question in the queue catalog, but
      // make only one example of each ordinary kind eligible for this prompt test.
      questions: queue.questions.map((question) => ({
        ...structuredClone(question),
        status: ordinaryQuestionIds.has(question.id) ? question.status : "deferred" as const,
      })),
    });
    const expectedCitationContract: Record<typeof ordinaryKinds[number], string[]> = {
      scene_role: ['claimKey "scene_role"'],
      entry_scene: ['claimKey "entry_scene"'],
      connection_topology: ['claimKey "topology"', 'claimKey "connection:<connectionId>"'],
      core_clue: ['claimKey "core_clue"'],
      ending_rule: ['claimKey "ending:<endingId>"'],
      discovery_method: ['claimKey "discovery:<spec.id>"'],
    };
    const mechanicKinds = new Set(["connection_topology", "ending_rule", "discovery_method"]);
    const seen = new Set<string>();
    const llm = new FakeLLM(Array.from({ length: ordinaryKinds.length }, () => response([])));

    const result = await requestCompilerHintProposals(input(graph, selected, llm, { maxQuestionsPerRequest: 1, maxRequestsPerRound: 8 }));

    expect(result.callCount).toBe(ordinaryKinds.length);
    expect(llm.calls).toHaveLength(ordinaryKinds.length);
    for (const call of llm.calls) {
      const requested = requestedEnvelope(call.messages);
      const kinds = requested.questions.map((question) => question.kind as typeof ordinaryKinds[number]);
      const user = call.messages[1]!.content;
      const system = call.messages[0]!.content;
      for (const kind of kinds) {
        if (!ordinaryKinds.includes(kind)) continue;
        seen.add(kind);
        for (const claimKey of expectedCitationContract[kind]) expect(user).toContain(claimKey);
      }
      if (kinds.some((kind) => mechanicKinds.has(kind))) {
        expect(user).toContain("Mechanics DSL:");
        expect(user).not.toContain("IDs are compiler-derived");
        expect(system).not.toContain("compiler derives the runtime mechanism IDs");
      }
      if (kinds.includes("connection_topology")) {
        expect(system).toContain("connectionId is a source-cited unique declaration label scoped to that connection");
        expect(user).toContain("Declare each connectionId once as a new stable ID");
      }
      if (kinds.includes("ending_rule")) {
        expect(system).toContain("endingId is a source-cited unique declaration label and spec.id is a source-cited unique mechanism declaration retained in the accepted mechanics IR");
        expect(user).toContain("Declare each endingId and its distinct spec.id once as new stable IDs");
      }
      if (kinds.includes("discovery_method")) {
        expect(system).toContain("spec.id is a source-cited unique mechanism declaration retained in the accepted mechanics IR");
        expect(user).toContain("Declare spec.id once as a new stable ID");
      }
    }
    expect([...seen].sort()).toEqual([...ordinaryKinds].sort());
  });

  it("keeps accepted ordinary ending and discovery spec IDs as submitted mechanics declarations", async () => {
    const { graph, queue } = ordinaryContractFixture();
    const ending = queue.questions.find((question) => question.kind === "ending_rule");
    const discovery = queue.questions.find((question) => question.kind === "discovery_method");
    if (!ending || !discovery || !discovery.subjectCandidateId || !discovery.allowedLocationCandidateIds?.[0]) {
      throw new Error("ordinary contract fixture lacks ending or discovery candidate domains");
    }
    const selectedQuestionIds = new Set([ending.id, discovery.id]);
    const selected = withQueueHash({
      ...structuredClone(queue),
      questions: queue.questions.map((question) => ({
        ...structuredClone(question),
        status: selectedQuestionIds.has(question.id) ? question.status : "deferred" as const,
      })),
    });
    const sceneId = discovery.allowedLocationCandidateIds[0];
    const endingId = "source_cited_ending";
    const endingSpecId = "source_cited_ending_rule";
    const discoverySpecId = "source_cited_discovery";
    const proposals: CompilerHintProposal[] = [
      {
        questionId: ending.id,
        kind: "ending_rule",
        value: {
          declarations: [{
            endingId,
            spec: {
              kind: "ending_rule",
              id: endingSpecId,
              priority: 1,
              when: { kind: "scene_visited", sceneId },
              effects: [{ kind: "end_game", endingId }],
            },
          }],
        },
        citations: [exactCitation(graph, ending, `ending:${endingId}`)],
      },
      {
        questionId: discovery.id,
        kind: "discovery_method",
        value: {
          clueCandidateId: discovery.subjectCandidateId,
          locationSceneCandidateId: sceneId,
          spec: {
            kind: "discovery_method",
            id: discoverySpecId,
            clueId: discovery.subjectCandidateId,
            action: "search",
            target: "scene",
            targetId: sceneId,
            onSuccess: [{ kind: "discover_clue", clueId: discovery.subjectCandidateId }],
          },
        },
        citations: [exactCitation(graph, discovery, `discovery:${discoverySpecId}`)],
      },
    ];
    const result = await requestCompilerHintProposals(input(graph, selected, new FakeLLM([response(proposals)]), { maxQuestionsPerRequest: 2 }));

    expect(result.accepted.map((proposal) => proposal.questionId).sort()).toEqual([ending.id, discovery.id].sort());
    expect(result.hints.resolutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ questionId: ending.id, value: { declarations: [expect.objectContaining({ endingId, spec: expect.objectContaining({ id: endingSpecId }) })] } }),
      expect.objectContaining({ questionId: discovery.id, value: expect.objectContaining({ spec: expect.objectContaining({ id: discoverySpecId }) }) }),
    ]));
  });

  it("uses one outbound LLMClient attempt per failed automatic-proposal chunk", async () => {
    const { graph, queue } = fixture();
    const eligible = buildCompilerHintProposalRequestEnvelope(graph, queue).questions
      .filter((question) => question.allowedKinds.length > 0 && question.kind !== "npc_binding")
      .map((question) => question.questionId)
      .sort();
    const originalFetch = globalThis.fetch;
    const outbound: Array<{ url: string; method: string | undefined }> = [];
    LLMClient.resetDefeat();
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      outbound.push({ url: String(url), method: init?.method });
      return new Response("temporary provider failure", { status: 500 });
    }) as typeof fetch;

    try {
      const llm = new LLMClient({
        apiKey: "adapter-single-attempt-key",
        baseUrl: "http://compiler-hint-adapter-single-attempt.test/v1",
        model: "adapter-single-attempt-model",
        maxTokens: 64,
        temperature: 0,
      });
      const result = await requestCompilerHintProposals(input(graph, queue, llm, {
        maxQuestionsPerRequest: 1,
        maxRequestsPerRound: 8,
      }));

      expect(eligible.length).toBeGreaterThan(0);
      expect(result.status).toBe("failed");
      expect(result.hints.resolutions).toEqual([]);
      expect(result.accepted).toEqual([]);
      expect(result.callCount).toBe(eligible.length);
      expect(result.calls).toHaveLength(eligible.length);
      expect(result.calls.every((call) => call.status === "failed")).toBe(true);
      expect(result.rejected.filter((diagnostic) => diagnostic.stage === "model" && diagnostic.code === "llm_call_failed")).toHaveLength(eligible.length);
      expect(outbound).toHaveLength(eligible.length);
      expect(outbound.every((request) => request.method === "POST" && request.url.endsWith("/chat/completions"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      LLMClient.resetDefeat();
    }
  });

  it("sends only eligible open questions and accepts a valid fenced partial response with deterministic options", async () => {
    const { graph, queue } = fixture();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const llm = new FakeLLM([`\`\`json\n${response([roleProposal(graph, role)])}\n\`\`\``]);

    const result = await requestCompilerHintProposals(input(graph, queue, llm));

    expect(result.status).toBe("partial");
    expect(result.callCount).toBe(1);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    expect(result.hints.resolutions[0]).toMatchObject({
      questionId: role.id,
      authority: "user_document",
      reviewerKind: "approved_policy",
      rightsStatus: "user_provided",
      audit: {
        schemaVersion: "1.1.0",
        producer: { providerFingerprint: "provider:test-v1", modelFingerprint: "model:test-v1" },
      },
    });
    expect(result.calls[0]?.questionIds).toEqual(
      buildCompilerHintProposalRequestEnvelope(graph, queue).questions
        .filter((question) => question.allowedKinds.length > 0 && question.kind !== "npc_binding")
        .map((question) => question.questionId)
        .sort(),
    );
    expect(llm.calls[0]?.options).toMatchObject({ jsonMode: true, temperature: 0, maxTokens: 2_400 });
    expect(llm.calls[0]?.messages[1]?.content).toContain("Return exactly");
    expect(llm.calls[0]?.messages[1]?.content).toContain("authority");
    expect(llm.calls[0]?.messages[1]?.content).toContain('"onTraverse":Effect[]');
    const prompt = llm.calls[0]?.messages[1]?.content ?? "";
    expect(llm.calls[0]?.messages[0]?.content).not.toContain("automatic NPC subset permits source-exact nameQuote and source-exact prose relationshipEvidence only");
    expect(prompt).not.toContain('"relationshipEvidence":{"statementId":"the same anchor paragraph id"');
    expect(prompt).not.toContain("dialogueMethods may instead be []");
    expect(prompt).not.toContain("npc_binding:none:<proseAnchorId>");
    expect(prompt).not.toContain("onSuccess must include");
    expect(prompt).toContain("Omit a question instead of guessing source facts, candidate IDs, or an ID shape outside its stated contract");
    for (const contract of ["scene_visited", "state_eq", "clue_found", "connection_unlocked", '"kind":"all"', '"kind":"any"', '"kind":"not"', "discover_clue", "set_state", "unlock_connection", "start_encounter", "end_game"]) {
      expect(prompt).toContain(contract);
    }
    expect(prompt).not.toContain("Reward binding =");
    expect(prompt).not.toContain("state_equals");
    expect(prompt).not.toContain("transition_scene");
    expect(prompt).not.toContain("condition object");
  });

  it("keeps source transitions disabled by default and emits their exact wire only for an explicit trusted capability", async () => {
    const { graph, queue } = sourceFactMechanicsFixture();
    const parent = queue.questions.find((question) => question.kind === "source_fact_disposition" && question.sourceFactChildQuestionId)!;
    const child = queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId)!;
    const sceneRole = queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId)!;
    const root = graph.statements.find((statement) => statement.id === parent.subjectStatementId)!;
    const activatedHints: ModuleCompileHints = {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [
        humanResolution(parent, { statementId: root.id, disposition: "mechanics_candidate" }),
        humanResolution(sceneRole, { role: "playable_scene" }),
      ],
    };
    const activated = applyModuleCompileHints(graph, queue, activatedHints);
    expect(activated.questions.find((question) => question.id === child.id)?.status).toBe("open");

    const defaultLlm = new FakeLLM([response([])]);
    await requestCompilerHintProposals(input(graph, activated, defaultLlm));
    const defaultPrompt = defaultLlm.calls[0]?.messages[1]?.content ?? "";
    const defaultChild = requestedEnvelope(defaultLlm.calls[0]!.messages).questions.find((question) => question.questionId === child.id)!;
    expect(defaultChild.candidateDomains.allowedSourceFactMechanicKinds).toEqual(["existing_clue_discovery"]);
    expect(defaultPrompt).toContain("or scene_state_transition; compiler derives");

    const transitionLlm = new FakeLLM([(messages) => {
      const envelope = requestedEnvelope(messages);
      const requested = envelope.questions.find((question) => question.questionId === child.id)!;
      const declarationKey = "enter-dock";
      const citations = ["declaration", "trigger", "discover"].map((atom) => ({
        claimKey: `source_fact_mechanic:${root.id}:${declarationKey}:${atom}`,
        statementId: root.id,
        quote: root.text.trim(),
      }));
      return response([{
        questionId: requested.questionId,
        kind: "source_fact_mechanic",
        value: {
          declarations: [{
            declarationKey,
            kind: "scene_state_transition",
            trigger: { kind: "scene_enter" },
            discoverClueCandidateId: requested.candidateDomains.allowedMechanicsTargetIds!.clue![0]!,
            evidence: citations,
          }],
        },
        citations,
      }]);
    }]);
    const capabilityInput = input(graph, activated, transitionLlm);
    capabilityInput.policy = {
      policyId: "trusted-policy-transition-v1",
      rightsStatus: "user_provided",
      allowedSourceFactMechanicKinds: ["existing_clue_discovery", "scene_state_transition"],
    };
    const transitionResult = await requestCompilerHintProposals(capabilityInput);
    const enabledPrompt = transitionLlm.calls[0]?.messages[1]?.content ?? "";
    const enabledChild = requestedEnvelope(transitionLlm.calls[0]!.messages).questions.find((question) => question.questionId === child.id)!;
    expect(enabledChild.candidateDomains.allowedSourceFactMechanicKinds).toEqual(["existing_clue_discovery", "scene_state_transition"]);
    expect(enabledPrompt).toContain("scene_state_transition uses exactly");
    expect(enabledPrompt).toContain("prerequisite only for clue_found");
    expect(enabledPrompt).not.toContain("or scene_state_transition; compiler derives");
    expect(transitionResult.accepted).toHaveLength(1);
    expect(transitionResult.hints.resolutions[0]).toMatchObject({ questionId: child.id, kind: "source_fact_mechanic" });
  });

  it("exposes and accepts prose findings only under an explicit trusted capability, with ID-only replies", async () => {
    const { graph, queue, parent, child, sceneRole, root } = proseFactFindingFixture();
    const activated = applyModuleCompileHints(graph, queue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [
        humanResolution(parent, { statementId: root.id, disposition: "mechanics_candidate" }),
        humanResolution(sceneRole, { role: "playable_scene" }),
      ],
    });
    const activatedChild = activated.questions.find((question) => question.id === child.id)!;
    const candidate = activatedChild.allowedProseFactFindingCandidates![0]!;
    const atoms = activatedChild.allowedSourceFactAtoms!;
    const value = {
      findingCandidateIds: [candidate.id],
      sourceOnlyAtomIds: atoms.filter((atom) => atom.id !== candidate.atomId).map((atom) => atom.id),
    };

    const defaultLlm = new FakeLLM([response([{
      questionId: child.id,
      kind: "source_fact_mechanic",
      value,
      citations: [],
    }])]);
    const defaultResult = await requestCompilerHintProposals(input(graph, activated, defaultLlm));
    const defaultChild = requestedEnvelope(defaultLlm.calls[0]!.messages).questions.find((question) => question.questionId === child.id)!;
    expect(defaultChild.candidateDomains.allowedSourceFactMechanicKinds).toEqual(["existing_clue_discovery"]);
    expect(defaultChild.candidateDomains.allowedSourceFactAtoms).toBeUndefined();
    expect(defaultChild.candidateDomains.allowedProseFactFindingCandidates).toBeUndefined();
    expect(defaultResult.accepted).toHaveLength(0);
    expect(defaultResult.rejected).toContainEqual(expect.objectContaining({ questionId: child.id, code: "source_fact_mechanic_kind_not_allowed" }));

    const proseLlm = new FakeLLM([(messages) => {
      const requested = requestedEnvelope(messages).questions.find((question) => question.questionId === child.id)!;
      const offered = requested.candidateDomains.allowedProseFactFindingCandidates![0]!;
      const offeredAtoms = requested.candidateDomains.allowedSourceFactAtoms!;
      return response([{
        questionId: requested.questionId,
        kind: "source_fact_mechanic",
        value: {
          findingCandidateIds: [offered.candidateId],
          sourceOnlyAtomIds: offeredAtoms.filter((atom) => atom.atomId !== offered.atomId).map((atom) => atom.atomId),
        },
        citations: [],
      }]);
    }]);
    const proseInput = input(graph, activated, proseLlm);
    proseInput.policy = {
      policyId: "trusted-policy-prose-finding-v1",
      rightsStatus: "user_provided",
      allowedSourceFactMechanicKinds: ["existing_clue_discovery", "prose_fact_finding"],
    };
    const proseResult = await requestCompilerHintProposals(proseInput);
    const request = requestedEnvelope(proseLlm.calls[0]!.messages);
    const requestedChild = request.questions.find((question) => question.questionId === child.id)!;
    expect(requestedChild.candidateDomains.allowedProseFactFindingCandidates).toEqual([{
      candidateId: candidate.id,
      atomId: candidate.atomId,
      quote: candidate.quote,
      check: candidate.check,
    }]);
    expect(requestedChild.candidateDomains.allowedSourceFactAtoms).toHaveLength(atoms.length);
    expect(requestedChild.prompt).toContain("findingCandidateIds");
    expect(requestedChild.prompt).toContain("citations must be []");
    expect(requestedChild.prompt).toContain("Do not combine");
    expect(proseResult.accepted).toHaveLength(1);
    expect(proseResult.hints.resolutions[0]).toMatchObject({
      questionId: child.id,
      kind: "source_fact_mechanic",
      value,
      audit: { citations: [{ claimKey: `source_fact_mechanic:${root.id}:${candidate.id}:finding`, quote: candidate.quote }] },
    });

    const freeFieldLlm = new FakeLLM([response([{
      questionId: child.id,
      kind: "source_fact_mechanic",
      value: { ...value, quote: "caller-authored", check: { kind: "skill", skill: "spot_hidden" }, location: "foreign" },
      citations: [],
    }])]);
    const freeFieldInput = input(graph, activated, freeFieldLlm);
    freeFieldInput.policy = proseInput.policy;
    const freeField = await requestCompilerHintProposals(freeFieldInput);
    expect(freeField.accepted).toHaveLength(0);
    expect(freeField.rejected).toContainEqual(expect.objectContaining({ questionId: child.id, code: "invalid_hint_value" }));

    const citationLlm = new FakeLLM([response([{
      questionId: child.id,
      kind: "source_fact_mechanic",
      value,
      citations: [{ claimKey: "caller", statementId: root.id, quote: candidate.quote }],
    }])]);
    const citationInput = input(graph, activated, citationLlm);
    citationInput.policy = proseInput.policy;
    const citation = await requestCompilerHintProposals(citationInput);
    expect(citation.accepted).toHaveLength(0);
    expect(citation.rejected).toContainEqual(expect.objectContaining({ questionId: child.id, code: "prose_fact_finding_citations_forbidden" }));
  });

  it("gives the model exactly the runtime and source-only item-binding contracts, then rejects uncited, wrong-claim, and legacy-null variants", async () => {
    const { graph, queue } = itemFixture();
    const item = queue.questions.find((question) => question.kind === "item_binding")!;
    const runtimeLLM = new FakeLLM([response([itemProposal(graph, item, "key")])]);
    const runtime = await requestCompilerHintProposals(input(graph, queue, runtimeLLM));
    const prompt = runtimeLLM.calls[0]?.messages[1]?.content ?? "";

    expect(prompt).toContain('Runtime item: {"itemCandidateId":"the question subject id","itemType":"key|document|loot","itemNameEvidence":{"statementId":"one candidateDomains.allowedItemNameEvidenceStatementIds id","quote":"a trimmed source-exact substring of that statement"}}. Its only citation claim key is item_binding:<itemCandidateId>, and its citation quote must exactly equal itemNameEvidence.quote.');
    expect(prompt).toContain('Source-only item: {"itemCandidateId":"the question subject id","itemType":null}. Its only citation claim key is item_binding:none:<itemCandidateId>; it must not include itemNameEvidence. null creates no runtime item and its citation quote must exactly equal the marked item name.');
    expect(prompt).toContain("Choose exactly one of these two contracts; never infer a runtime itemType merely because the source is uncertain.");
    expect(prompt).not.toContain('Item binding = {"itemCandidateId":"the question subject id","itemType":"key|document|loot"}.');
    expect(runtime.hints.resolutions).toMatchObject([{
      questionId: item.id,
      value: {
        itemCandidateId: item.subjectCandidateId,
        itemType: "key",
        itemNameEvidence: { statementId: item.allowedItemNameEvidenceStatementIds![0]!, quote: expect.any(String) },
      },
    }]);
    expect(requestedEnvelope(runtimeLLM.calls[0]!.messages).questions.find((question) => question.questionId === item.id)?.candidateDomains.allowedItemNameEvidenceStatementIds).toEqual(item.allowedItemNameEvidenceStatementIds);

    const sourceOnlyLLM = new FakeLLM([response([itemProposal(graph, item, null)])]);
    const sourceOnly = await requestCompilerHintProposals(input(graph, queue, sourceOnlyLLM));
    expect(sourceOnly.hints.schemaVersion).toBe(MODULE_COMPILE_HINTS_SCHEMA_VERSION);
    expect(sourceOnly.hints.resolutions).toMatchObject([{
      questionId: item.id,
      value: { itemCandidateId: item.subjectCandidateId, itemType: null },
      audit: { citations: [{ claimKey: `item_binding:none:${item.subjectCandidateId}` }] },
    }]);

    const uncitedLLM = new FakeLLM([response([{ ...itemProposal(graph, item, null), citations: [] }])]);
    const uncited = await requestCompilerHintProposals(input(graph, queue, uncitedLLM));
    expect(uncited).toMatchObject({ status: "failed", hints: { resolutions: [] } });
    expect(uncited.rejected).toContainEqual(expect.objectContaining({ stage: "proposal", code: "missing_claim_citation", questionId: item.id }));

    const wrongClaimLLM = new FakeLLM([response([itemProposal(graph, item, null, `item_binding:${item.subjectCandidateId}`)])]);
    const wrongClaim = await requestCompilerHintProposals(input(graph, queue, wrongClaimLLM));
    expect(wrongClaim).toMatchObject({ status: "failed", hints: { resolutions: [] } });
    expect(wrongClaim.rejected).toContainEqual(expect.objectContaining({ stage: "proposal", code: "unknown_claim_key", questionId: item.id }));

    expect(() => validateModuleCompileHints(queue, { ...sourceOnly.hints, schemaVersion: "1.8.0" }, graph)).toThrow("legacy hints cannot declare explicit source-only item bindings");
  });

  it("keeps reward predicate target domains and reward/item claim keys in the single emitted request prompt", async () => {
    const { graph, queue } = rewardFixture();
    const reward = queue.questions.find((question) => question.kind === "reward_binding")!;
    const rewardOnlyQueue = structuredClone(queue);
    for (const question of rewardOnlyQueue.questions) {
      if (question.id === reward.id) continue;
      question.status = "deferred";
      delete question.resolution;
    }
    const boundedQueue = withQueueHash(rewardOnlyQueue);
    const llm = new FakeLLM([(messages) => {
      const envelope = requestedEnvelope(messages);
      const question = envelope.questions[0]!;
      const rewardCandidateId = question.candidateDomains.subjectCandidateId!;
      const sceneId = question.candidateDomains.allowedRewardPredicateIds!.scene![0]!;
      const rewardEntry = envelope.candidateCatalog.find((candidate) => candidate.id === rewardCandidateId && candidate.kind === "reward")!;
      return response([{
        questionId: question.questionId,
        kind: "reward_binding",
        value: {
          rewardCandidateId,
          declaration: { when: { kind: "scene_visited", sceneId }, settlement: { san: { kind: "fixed", amount: 1 } } },
        },
        citations: [{ claimKey: `reward_binding:${rewardCandidateId}`, statementId: rewardEntry.sourceStatementId, quote: rewardEntry.label }],
      }]);
    }]);

    const result = await requestCompilerHintProposals(input(graph, boundedQueue, llm));
    const messages = llm.calls[0]!.messages;
    const prompt = messages[1]?.content ?? "";
    const envelope = requestedEnvelope(messages);
    const sent = envelope.questions[0]!;

    expect(messages).toHaveLength(2);
    expect(sent.candidateDomains.allowedRewardPredicateIds).toEqual(reward.allowedRewardPredicateIds);
    for (const [kind, ids] of Object.entries(sent.candidateDomains.allowedRewardPredicateIds!) as Array<["scene" | "clue" | "item", string[]]>) {
      expect(ids.every((id) => envelope.candidateCatalog.some((candidate) => candidate.id === id && candidate.kind === kind))).toBe(true);
    }
    expect(prompt).not.toContain("item_binding:<itemCandidateId>");
    expect(prompt).toContain("Its only citation claim key is reward_binding:<rewardCandidateId>");
    expect(prompt).toContain("candidateDomains.allowedRewardPredicateIds.clue, .scene, and .item respectively");
    expect(result).toMatchObject({ status: "ok", accepted: [{ questionId: reward.id }] });
    expect(result.hints.resolutions[0]?.audit?.citations).toEqual([expect.objectContaining({ claimKey: `reward_binding:${reward.subjectCandidateId}` })]);
  });

  it("exposes a table-row source disposition to the model and accepts its exact source-only audit", async () => {
    const { graph, queue } = tableDispositionFixture();
    const question = queue.questions.find((candidate) => candidate.kind === "source_fact_disposition"
      && graph.statements.find((statement) => statement.id === candidate.subjectStatementId)?.kind === "table_row")!;
    const row = graph.statements.find((statement) => statement.id === question.subjectStatementId)!;
    const tableOnlyQueue = structuredClone(queue);
    for (const candidate of tableOnlyQueue.questions) {
      if (candidate.id === question.id) continue;
      candidate.status = "deferred";
      delete candidate.resolution;
    }
    const boundedQueue = withQueueHash(tableOnlyQueue);
    const proposal = {
      questionId: question.id,
      kind: "source_fact_disposition",
      value: { statementId: row.id, disposition: "source_only" },
      citations: [{ claimKey: `source_fact_disposition:${row.id}`, statementId: row.id, quote: row.text }],
    };
    const llm = new FakeLLM([response([proposal])]);

    const result = await requestCompilerHintProposals(input(graph, boundedQueue, llm));

    const sent = requestedEnvelope(llm.calls[0]!.messages);
    expect(sent.questions).toEqual([expect.objectContaining({
      questionId: question.id,
      kind: "source_fact_disposition",
      sourceStatements: [{ statementId: row.id, text: row.text }],
    })]);
    const prompt = llm.calls[0]!.messages[1]?.content ?? "";
    expect(prompt).toContain("whole paragraph, list item, or table row");
    expect(prompt).toContain('source_fact_disposition: {"statementId":"the sole source statement id","disposition":"source_only|mechanics_candidate"}');
    expect(prompt).toContain('claimKey "source_fact_disposition:<statementId>"');
    expect(result).toMatchObject({ status: "ok", accepted: [{ questionId: question.id }] });
    expect(result.hints.resolutions).toMatchObject([{
      questionId: question.id,
      value: proposal.value,
      audit: { citations: proposal.citations },
    }]);
    expect(() => validateModuleCompileHints(boundedQueue, result.hints, graph)).not.toThrow();
  });

  it("keeps unanswered NPC anchors unasked, but makes answered non-playable anchors explicit none-only decisions", async () => {
    const { graph, queue } = npcFixture();
    const npc = queue.questions.find((question) => question.kind === "npc_binding")!;
    const headingStatementId = npc.sourceStatementIds.find((statementId) => graph.statements.find((statement) => statement.id === statementId)?.kind === "heading")!;
    const sceneRole = queue.questions.find((question) => question.kind === "scene_role" && question.sourceStatementIds.includes(headingStatementId))!;

    const unansweredLLM = new FakeLLM(Array.from({ length: 8 }, () => response([])));
    await requestCompilerHintProposals(input(graph, queue, unansweredLLM));
    expect(unansweredLLM.calls.flatMap((call) => requestedQuestionIds(call.messages))).not.toContain(npc.id);

    const nonPlayableRoleLLM = new FakeLLM(Array.from({ length: 8 }, () => (messages) => response(
      requestedQuestionIds(messages).includes(sceneRole.id) ? [roleProposal(graph, sceneRole, "other")] : [],
    )));
    const nonPlayableProposal = await requestCompilerHintProposals(input(graph, queue, nonPlayableRoleLLM));
    const nonPlayableQueue = applyModuleCompileHints(graph, queue, nonPlayableProposal.hints);
    const proseAnchorId = npc.subjectCandidateId!;
    const noneOnlyProposal = {
      questionId: npc.id,
      kind: "npc_binding",
      value: { proseAnchorId, presentNpcs: [] },
      citations: [exactCitation(graph, npc, `npc_binding:none:${proseAnchorId}`)],
    };
    const nonPlayableLLM = new FakeLLM(Array.from({ length: 8 }, () => (messages) => response(
      requestedQuestionIds(messages).includes(npc.id) ? [noneOnlyProposal] : [],
    )));
    const noneOnly = await requestCompilerHintProposals(input(graph, nonPlayableQueue, nonPlayableLLM));
    expect(nonPlayableLLM.calls.flatMap((call) => requestedQuestionIds(call.messages))).toContain(npc.id);
    expect(noneOnly.accepted).toContainEqual(expect.objectContaining({ questionId: npc.id }));
    expect(noneOnly.hints.resolutions).toContainEqual(expect.objectContaining({ questionId: npc.id, value: { proseAnchorId, presentNpcs: [] } }));
    const noneOnlyPrompt = nonPlayableLLM.calls
      .map((call) => requestedEnvelope(call.messages).questions.find((question) => question.questionId === npc.id)?.prompt)
      .find((prompt): prompt is string => typeof prompt === "string");
    expect(noneOnlyPrompt).toContain("only return presentNpcs: []");

    const paragraph = npc.sourceStatementIds
      .map((statementId) => graph.statements.find((statement) => statement.id === statementId))
      .find((statement) => statement?.kind === "paragraph")!;
    const positiveNpc = {
      questionId: npc.id,
      kind: "npc_binding",
      value: { proseAnchorId, presentNpcs: [{ nameQuote: "Captain Mira", dialogueMethods: [] }] },
      citations: [{ claimKey: `npc_binding:${proseAnchorId}:0`, statementId: paragraph.id, quote: "Captain Mira" }],
    };
    const nonPlayablePositiveLLM = new FakeLLM(Array.from({ length: 8 }, () => (messages) => response(
      requestedQuestionIds(messages).includes(npc.id) ? [positiveNpc] : [],
    )));
    const nonPlayablePositive = await requestCompilerHintProposals(input(graph, nonPlayableQueue, nonPlayablePositiveLLM));
    expect(nonPlayablePositive.accepted.some((proposal) => proposal.questionId === npc.id)).toBe(false);
    expect(nonPlayablePositive.hints.resolutions.some((resolution) => resolution.questionId === npc.id)).toBe(false);
    expect(nonPlayablePositive.rejected).toContainEqual(expect.objectContaining({
      stage: "proposal",
      questionId: npc.id,
      code: "npc_binding_requires_playable_scene",
    }));
  });

  it("uses the anchor location role, rather than a sort-first profile role, for automatic NPC request mode", async () => {
    const { graph, queue, npc, locationRole, profileRole } = crossHeadingNpcProfileFixture();
    const answeredQueue = (locationRoleValue: "playable_scene" | "other", profileRoleValue: "playable_scene" | "other") => applyModuleCompileHints(graph, queue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [
        humanResolution(locationRole, { role: locationRoleValue }),
        humanResolution(profileRole, { role: profileRoleValue }),
      ],
    });
    const npcPrompt = async (candidateQueue: typeof queue): Promise<string> => {
      const llm = new FakeLLM(Array.from({ length: 8 }, () => response([])));
      await requestCompilerHintProposals(input(graph, candidateQueue, llm, { maxRequestsPerRound: 8 }));
      const prompt = llm.calls
        .flatMap((call) => requestedEnvelope(call.messages).questions)
        .find((question) => question.questionId === npc.id)?.prompt;
      if (!prompt) throw new Error("cross-heading NPC was not offered to the proposal adapter");
      return prompt;
    };

    expect(await npcPrompt(answeredQueue("playable_scene", "other"))).toContain("already answered playable_scene");
    expect(await npcPrompt(answeredQueue("other", "playable_scene"))).toContain("only return presentNpcs: []");
  });

  it("accepts a source-exact static NPC binding and rejects the legacy name-only shape", async () => {
    const { graph, queue } = npcFixture();
    const npc = queue.questions.find((question) => question.kind === "npc_binding")!;
    const headingStatementId = npc.sourceStatementIds.find((statementId) => graph.statements.find((statement) => statement.id === statementId)?.kind === "heading")!;
    const sceneRole = queue.questions.find((question) => question.kind === "scene_role" && question.sourceStatementIds.includes(headingStatementId))!;
    const roleResult = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([response([roleProposal(graph, sceneRole)])])));
    const playableQueue = applyModuleCompileHints(graph, queue, roleResult.hints);
    const playableNpc = playableQueue.questions.find((question) => question.id === npc.id)!;
    const proseAnchorId = playableNpc.subjectCandidateId!;
    const paragraph = playableNpc.sourceStatementIds
      .map((statementId) => graph.statements.find((statement) => statement.id === statementId))
      .find((statement) => statement?.kind === "paragraph")!;
    const staticNpc = {
      questionId: playableNpc.id,
      kind: "npc_binding",
      value: { proseAnchorId, presentNpcs: [{ nameQuote: "Mira", dialogueMethods: [] }] },
      citations: [{ claimKey: `npc_binding:${proseAnchorId}:0`, statementId: paragraph.id, quote: "Mira" }],
    };

    const staticLLM = new FakeLLM([response([staticNpc])]);
    const accepted = await requestCompilerHintProposals(input(graph, playableQueue, staticLLM));

    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.rejected).toEqual([]);
    expect(accepted.hints.resolutions).toMatchObject([{ questionId: playableNpc.id, value: staticNpc.value, audit: { citations: staticNpc.citations } }]);
    const npcRequest = requestedEnvelope(staticLLM.calls[0]!.messages).questions.find((question) => question.questionId === playableNpc.id)!;
    expect(npcRequest.prompt).toContain("may declare dialogueMethods: [] or one or more prose methods");
    expect(npcRequest.prompt).not.toContain("may optionally declare one encounter");

    const oldLLM = new FakeLLM([response([{
      ...staticNpc,
      value: { proseAnchorId, presentNpcs: [{ nameQuote: "Mira" }] },
    }])]);
    const rejected = await requestCompilerHintProposals(input(graph, playableQueue, oldLLM));

    expect(rejected.accepted).toEqual([]);
    expect(rejected.hints.resolutions).toEqual([]);
    expect(rejected.status).toBe("failed");
    expect(rejected.rejected).toContainEqual(expect.objectContaining({
      stage: "proposal",
      code: "invalid_hint_value",
      message: expect.stringContaining("dialogueMethods must be an array"),
    }));
  });

  it("exposes a closed automatic encounter profile only under capability and accepts no model-authored runtime IDs", async () => {
    const { graph, queue, anchor, question, sceneRole, paragraph } = automaticNpcEncounterFixture();
    const playable = applyModuleCompileHints(graph, queue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: queue.moduleId,
      documentHash: queue.documentHash,
      sourceGraphIdentity: queue.sourceGraphIdentity,
      resolutions: [humanResolution(sceneRole, { role: "playable_scene" })],
    });
    const proposal = {
      questionId: question.id,
      kind: "npc_binding",
      value: {
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
      },
      citations: [
        { claimKey: `npc_binding:${anchor.id}:0:name`, statementId: paragraph.id, quote: "Mira" },
        { claimKey: `npc_binding:${anchor.id}:0:encounter:trigger`, statementId: paragraph.id, quote: "Mira attacks the investigators." },
        { claimKey: `npc_binding:${anchor.id}:0:encounter:maxHp`, statementId: paragraph.id, quote: "HP 2" },
        { claimKey: `npc_binding:${anchor.id}:0:encounter:dodge`, statementId: paragraph.id, quote: "Dodge 30" },
        { claimKey: `npc_binding:${anchor.id}:0:encounter:fight`, statementId: paragraph.id, quote: "Fight 40" },
        { claimKey: `npc_binding:${anchor.id}:0:encounter:npcDamage`, statementId: paragraph.id, quote: "Damage 1d2" },
      ],
    };
    const policy: TrustedCompilerHintProposalPolicy = {
      policyId: "trusted-policy-v1",
      rightsStatus: "user_provided",
      allowSourceExactNpcEncounters: true,
    };
    const llm = new FakeLLM([(messages) => {
      const requested = requestedEnvelope(messages).questions.find((candidate) => candidate.questionId === question.id)!;
      expectModelQuestionScopes(messages, graph, playable, policy);
      expect(requested.candidateDomains.allowedNpcEncounterProfiles).toHaveLength(1);
      expect(requested.candidateDomains.allowedNpcEncounterProfiles?.[0]?.statCandidates).toMatchObject({
        maxHp: [{ statementId: paragraph.id, quote: "HP 2" }],
        dodge: [{ statementId: paragraph.id, quote: "Dodge 30" }],
        fight: [{ statementId: paragraph.id, quote: "Fight 40" }],
        npcDamage: [{ statementId: paragraph.id, quote: "Damage 1d2" }],
      });
      expect(requested.prompt).toContain("allowedNpcEncounterProfiles");
      expect(messages[1]?.content).toContain(":encounter:trigger");
      // The cap is measured after this NPC capability-specific prompt rewrite,
      // not from the earlier generic request envelope.
      expect(promptChars(messages)).toBeLessThanOrEqual(48_000);
      return response([proposal]);
    }]);
    const result = await requestCompilerHintProposals({
      ...input(graph, playable, llm, { maxPromptChars: 48_000 }),
      policy,
    });
    expect(result.accepted).toContainEqual(expect.objectContaining({ questionId: question.id }));
    expect(result.hints.resolutions).toMatchObject([{
      questionId: question.id,
      audit: { schemaVersion: "1.3.0", producer: { providerFingerprint: "provider:test-v1", modelFingerprint: "model:test-v1" } },
    }]);
    expect((result.hints.resolutions[0]!.value as { presentNpcs: Array<{ encounter: Record<string, unknown> }> }).presentNpcs[0]!.encounter).not.toHaveProperty("encounterId");

    const deniedEnvelope = buildCompilerHintProposalRequestEnvelope(graph, playable, { policyId: "trusted-policy-v1", rightsStatus: "user_provided" });
    expect(deniedEnvelope.questions.find((candidate) => candidate.questionId === question.id)?.candidateDomains.allowedNpcEncounterProfiles).toBeUndefined();
    const missingProducerLlm = new FakeLLM([]);
    const missingProducer = await requestCompilerHintProposals({
      ...input(graph, playable, missingProducerLlm),
      policy: { policyId: "trusted-policy-v1", rightsStatus: "user_provided", allowSourceExactNpcEncounters: true },
      producer: { providerFingerprint: "", modelFingerprint: "" },
    });
    expect(missingProducer.status).toBe("failed");
    expect(missingProducerLlm.calls).toEqual([]);

    const legacy = npcFixture();
    const legacyNpc = legacy.queue.questions.find((candidate) => candidate.kind === "npc_binding")!;
    const legacyHeading = legacyNpc.sourceStatementIds.find((id) => legacy.graph.statements.find((statement) => statement.id === id)?.kind === "heading")!;
    const legacyRole = legacy.queue.questions.find((candidate) => candidate.kind === "scene_role" && candidate.sourceStatementIds.includes(legacyHeading))!;
    const legacyPlayable = applyModuleCompileHints(legacy.graph, legacy.queue, {
      schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
      moduleId: legacy.queue.moduleId,
      documentHash: legacy.queue.documentHash,
      sourceGraphIdentity: legacy.queue.sourceGraphIdentity,
      resolutions: [humanResolution(legacyRole, { role: "playable_scene" })],
    });
    const legacyEnvelope = buildCompilerHintProposalRequestEnvelope(legacy.graph, legacyPlayable, { policyId: "trusted-policy-v1", rightsStatus: "user_provided", allowSourceExactNpcEncounters: true });
    expect(legacyEnvelope.schemaVersion).toBe("1.8.0");
    expect(legacyEnvelope.questions.find((candidate) => candidate.questionId === legacyNpc.id)?.candidateDomains.allowedNpcEncounterProfiles).toBeUndefined();
    const legacyDefaultLlm = new FakeLLM([response([])]);
    const legacyEnabledLlm = new FakeLLM([response([])]);
    const legacyDefault = await requestCompilerHintProposals(input(legacy.graph, legacyPlayable, legacyDefaultLlm));
    const legacyEnabled = await requestCompilerHintProposals({
      ...input(legacy.graph, legacyPlayable, legacyEnabledLlm),
      policy: { policyId: "trusted-policy-v1", rightsStatus: "user_provided", allowSourceExactNpcEncounters: true },
    });
    expect(legacyEnabledLlm.calls[0]?.messages).toEqual(legacyDefaultLlm.calls[0]?.messages);
    expect(legacyEnabled.requestHashes).toEqual(legacyDefault.requestHashes);
  });

  it("does not call the model when no questions are eligible", async () => {
    const { graph, queue } = fixture();
    const noEligible = withQueueHash({
      ...structuredClone(queue),
      questions: queue.questions.map((question) => ({ ...structuredClone(question), status: "deferred" as const })),
    });
    const llm = new FakeLLM([]);

    const result = await requestCompilerHintProposals(input(graph, noEligible, llm));

    expect(result).toMatchObject({ status: "no_eligible_questions", callCount: 0, hints: { resolutions: [] } });
    expect(llm.calls).toEqual([]);

    const invalidPolicy = await requestCompilerHintProposals({ ...input(graph, noEligible, llm), policy: { policyId: "", rightsStatus: "user_provided" } });
    expect(invalidPolicy).toMatchObject({ status: "failed", callCount: 0 });
    expect(invalidPolicy.rejected[0]).toMatchObject({ code: "invalid_trusted_policy", stage: "input" });
  });

  it("fails closed for bad JSON or any extra root field while retaining response hashes and diagnostics", async () => {
    const { graph, queue } = fixture();
    for (const reply of ["not json", JSON.stringify({ proposals: [], authority: "forged" }), JSON.stringify([])]) {
      const result = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([reply])));
      expect(result.status).toBe("failed");
      expect(result.hints.resolutions).toEqual([]);
      expect(result.rejected[0]).toMatchObject({ stage: "response" });
      expect(result.responseHashes).toHaveLength(1);
    }
  });

  it("treats a model exception as a structured failed result and never manufactures a hint", async () => {
    const { graph, queue } = fixture();
    const result = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([new Error("offline")])))
;

    expect(result).toMatchObject({ status: "failed", hints: { resolutions: [] }, callCount: 1 });
    expect(result.rejected[0]).toMatchObject({ stage: "model", code: "llm_call_failed" });
  });

  it("rejects model attempts to inject authority or identity instead of allowing them to influence trusted fields", async () => {
    const { graph, queue } = fixture();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const forgedProposal = { ...roleProposal(graph, role), authority: "project_original" };
    const injected = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([response([forgedProposal])])))
;
    expect(injected.status).toBe("failed");
    expect(injected.rejected[0]).toMatchObject({ stage: "proposal", code: "forbidden_proposal_field" });
    expect(injected.hints.resolutions).toEqual([]);

    const rootIdentity = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([JSON.stringify({ proposals: [], queueHash: "forged" })])));
    expect(rootIdentity.rejected[0]).toMatchObject({ stage: "response", code: "unexpected_root_field" });
  });

  it("prioritizes a generated owning scene-role prerequisite over a hash-earlier warning and recomputes after continuation", async () => {
    // This is a real generated queue, not a hand-written priority fixture. The
    // module identity deliberately yields a source-fact disposition whose
    // opaque hash ID sorts before its owning scene-role prerequisite.
    const { graph, queue, parent, child, sceneRole } = proseFactFindingFixture("priority-probe-5");
    expect(parent.id.localeCompare(sceneRole.id)).toBeLessThan(0);
    expect(child.status).toBe("deferred");
    const focused = withQueueHash({
      ...structuredClone(queue),
      questions: queue.questions.map((question) => question.id === parent.id || question.id === sceneRole.id
        ? structuredClone(question)
        : { ...structuredClone(question), status: "deferred" as const }),
    });
    const first = new FakeLLM([(messages) => {
      expect(requestedQuestionIds(messages)).toEqual([sceneRole.id]);
      return response([roleProposal(graph, sceneRole)]);
    }]);

    const initial = await requestCompilerHintProposals(input(graph, focused, first, {
      maxQuestionsPerRequest: 1,
      maxRequestsPerRound: 1,
    }));

    expect(initial.calls.map((call) => call.questionIds)).toEqual([[sceneRole.id]]);
    const continued = applyModuleCompileHints(graph, focused, initial.hints);
    const second = new FakeLLM([(messages) => {
      expect(requestedQuestionIds(messages)).toEqual([parent.id]);
      return response([sourceFactDispositionProposal(graph, parent, "source_only")]);
    }]);

    const resumed = await requestCompilerHintProposals(input(graph, continued, second, {
      maxQuestionsPerRequest: 1,
      maxRequestsPerRound: 1,
    }));

    expect(resumed.calls.map((call) => call.questionIds)).toEqual([[parent.id]]);
    expect(resumed.accepted).toEqual([expect.objectContaining({ questionId: parent.id })]);
  });

  it("chunks in stable dependency/blocker priority order, uses question IDs within a tier, and makes same-snapshot request identities stable", async () => {
    const { graph, queue } = fixture();
    const envelope = buildCompilerHintProposalRequestEnvelope(graph, queue);
    const eligible = envelope.questions.filter((question) => question.allowedKinds.length > 0 && question.kind !== "npc_binding").map((question) => question.questionId).sort();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const replies = () => eligible.map(() => (messages: Message[]) => response(requestedQuestionIds(messages).includes(role.id) ? [roleProposal(graph, role)] : []));
    const llm = new FakeLLM(replies());

    const result = await requestCompilerHintProposals(input(graph, queue, llm, { maxQuestionsPerRequest: 1, maxRequestsPerRound: 8, maxRequestChars: 20_000 }));
    const replayLlm = new FakeLLM(replies());
    const replay = await requestCompilerHintProposals(input(graph, queue, replayLlm, { maxQuestionsPerRequest: 1, maxRequestsPerRound: 8, maxRequestChars: 20_000 }));
    const questionById = new Map(queue.questions.map((question) => [question.id, question]));
    const rank = (questionId: string) => {
      const question = questionById.get(questionId)!;
      return question.severity === "publish_blocking" ? question.kind === "scene_role" ? 0 : 1 : 4;
    };
    const scheduled = result.calls.flatMap((call) => call.questionIds);
    const scheduledRanks = scheduled.map(rank);

    expect(result.callCount).toBe(eligible.length);
    expect([...scheduled].sort()).toEqual(eligible);
    expect(scheduledRanks).toEqual([...scheduledRanks].sort((left, right) => left - right));
    for (const tier of [...new Set(scheduledRanks)]) {
      const ids = scheduled.filter((questionId) => rank(questionId) === tier);
      expect(ids).toEqual([...ids].sort());
    }
    expect(replay.calls).toEqual(result.calls);
    expect(replayLlm.calls).toEqual(llm.calls);
    expect(result.requestHashes).toHaveLength(eligible.length);
    expect(new Set(result.requestHashes).size).toBe(eligible.length);
    expect(result.hints.resolutions.map((resolution) => resolution.questionId)).toEqual([role.id]);
  });

  it("keeps the envelope cap distinct while enforcing an exact UTF-16 system-plus-user prompt cap before chat", async () => {
    const { graph, queue } = ordinaryContractFixture();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const selected = queueWithOnlyOpenQuestions(queue, [role.id]);
    const probe = new FakeLLM([response([])]);
    await requestCompilerHintProposals(input(graph, selected, probe, {
      maxQuestionsPerRequest: 1,
      maxRequestChars: 500_000,
      maxPromptChars: 500_000,
    }));
    const messages = probe.calls[0]!.messages;
    const envelope = messages[1]!.content.slice(messages[1]!.content.lastIndexOf("REQUEST ENVELOPE:\n") + "REQUEST ENVELOPE:\n".length);
    const unitLength = promptChars(messages);
    expect(new TextEncoder().encode(messages.map((message) => message.content).join("")).length).toBeGreaterThan(unitLength);
    expect(unitLength).toBeGreaterThan(envelope.length);

    // Retain maxRequestChars's existing envelope-only contract even when the
    // final prompt is larger because it includes trusted guidance.
    const envelopeCapped = new FakeLLM([response([])]);
    await requestCompilerHintProposals(input(graph, selected, envelopeCapped, {
      maxQuestionsPerRequest: 1,
      maxRequestChars: envelope.length,
      maxPromptChars: 500_000,
    }));
    expect(envelopeCapped.calls).toHaveLength(1);

    const exact = new FakeLLM([response([])]);
    await requestCompilerHintProposals(input(graph, selected, exact, {
      maxQuestionsPerRequest: 1,
      maxRequestChars: 500_000,
      maxPromptChars: unitLength,
    }));
    expect(exact.calls).toHaveLength(1);
    expect(promptChars(exact.calls[0]!.messages)).toBe(unitLength);
    expect(exact.calls[0]!.messages[1]!.content).toContain('claimKey "scene_role"');

    const tooLarge = new FakeLLM([]);
    const rejected = await requestCompilerHintProposals(input(graph, selected, tooLarge, {
      maxQuestionsPerRequest: 1,
      maxRequestChars: 500_000,
      maxPromptChars: unitLength - 1,
    }));
    expect(tooLarge.calls).toEqual([]);
    expect(rejected).toMatchObject({ status: "failed", callCount: 0, hints: { resolutions: [] } });
    expect(rejected.rejected).toContainEqual(expect.objectContaining({ questionId: role.id, code: "question_exceeds_prompt_limit", stage: "chunking" }));
  });

  it("splits on the exact outgoing prompt and still applies the request-count cap after splitting", async () => {
    const { graph, queue } = ordinaryContractFixture();
    const roles = queue.questions.filter((question) => question.kind === "scene_role").slice(0, 2);
    if (roles.length !== 2) throw new Error("prompt split fixture requires two scene roles");
    const selected = queueWithOnlyOpenQuestions(queue, roles.map((question) => question.id));
    const unrestricted = new FakeLLM([response([])]);
    await requestCompilerHintProposals(input(graph, selected, unrestricted, {
      maxQuestionsPerRequest: 2,
      maxRequestsPerRound: 8,
      maxRequestChars: 500_000,
      maxPromptChars: 500_000,
    }));
    expect(unrestricted.calls).toHaveLength(1);
    const combinedChars = promptChars(unrestricted.calls[0]!.messages);

    const singleProbe = new FakeLLM([response([]), response([])]);
    await requestCompilerHintProposals(input(graph, selected, singleProbe, {
      maxQuestionsPerRequest: 1,
      maxRequestsPerRound: 8,
      maxRequestChars: 500_000,
      maxPromptChars: 500_000,
    }));
    const largestSingleChars = Math.max(...singleProbe.calls.map((call) => promptChars(call.messages)));
    expect(combinedChars).toBeGreaterThan(largestSingleChars);
    const promptCap = combinedChars - 1;

    const split = new FakeLLM([response([]), response([])]);
    const splitResult = await requestCompilerHintProposals(input(graph, selected, split, {
      maxQuestionsPerRequest: 2,
      maxRequestsPerRound: 8,
      maxRequestChars: 500_000,
      maxPromptChars: promptCap,
    }));
    expect(splitResult.callCount).toBe(2);
    expect(split.calls.map((call) => requestedQuestionIds(call.messages))).toEqual(roles.map((question) => [question.id]).sort((left, right) => left[0]!.localeCompare(right[0]!)));
    expect(split.calls.every((call) => promptChars(call.messages) <= promptCap)).toBe(true);

    const requestCapped = new FakeLLM([response([])]);
    const requestCappedResult = await requestCompilerHintProposals(input(graph, selected, requestCapped, {
      maxQuestionsPerRequest: 2,
      maxRequestsPerRound: 1,
      maxRequestChars: 500_000,
      maxPromptChars: promptCap,
    }));
    expect(requestCapped.calls).toHaveLength(1);
    expect(requestCappedResult.callCount).toBe(1);
    expect(requestCappedResult.rejected.filter((diagnostic) => diagnostic.code === "max_model_requests_reached").map((diagnostic) => diagnostic.questionId))
      .toEqual([roles.map((question) => question.id).sort()[1]!]);
  });

  it("enforces an absolute per-round model-call cap and diagnoses every unprocessed question", async () => {
    const { graph, queue } = fixture();
    const eligible = buildCompilerHintProposalRequestEnvelope(graph, queue).questions
      .filter((question) => question.allowedKinds.length > 0 && question.kind !== "npc_binding")
      .map((question) => question.questionId)
      .sort();
    const llm = new FakeLLM([response([])]);

    const result = await requestCompilerHintProposals(input(graph, queue, llm, {
      maxQuestionsPerRequest: 1,
      // The public API owns this limit; the adapter must nevertheless prove
      // that a low trusted value prevents all later chunks from reaching chat.
      maxRequestsPerRound: 1,
    }));

    expect(result.callCount).toBe(1);
    expect(llm.calls).toHaveLength(1);
    const firstSceneRole = queue.questions
      .filter((question) => question.kind === "scene_role" && eligible.includes(question.id))
      .map((question) => question.id)
      .sort()[0];
    expect(result.calls[0]?.questionIds).toEqual([firstSceneRole ?? eligible[0]!]);
    expect(result.unansweredQuestionIds).toEqual(eligible);
    expect(result.rejected.filter((diagnostic) => diagnostic.code === "max_model_requests_reached").map((diagnostic) => diagnostic.questionId).sort())
      .toEqual(eligible.filter((questionId) => questionId !== (firstSceneRole ?? eligible[0]!)));
  });

  it("puts every chunk's referenced IDs in a source-exact candidate catalog, including cross-chunk entry domains", async () => {
    const { graph, queue } = fixture();
    const expected = buildCompilerHintProposalRequestEnvelope(graph, queue).candidateCatalog;
    const eligible = buildCompilerHintProposalRequestEnvelope(graph, queue).questions.filter((question) => question.allowedKinds.length > 0 && question.kind !== "npc_binding");
    const llm = new FakeLLM(eligible.map(() => (messages) => {
      const envelope = requestedEnvelope(messages);
      const question = envelope.questions[0]!;
      const referenced = [
        ...(question.candidateDomains.candidateIds ?? []),
        ...(question.candidateDomains.subjectCandidateId ? [question.candidateDomains.subjectCandidateId] : []),
        ...(question.candidateDomains.allowedCandidateIds ?? []),
        ...(question.candidateDomains.allowedLocationCandidateIds ?? []),
        ...Object.values(question.candidateDomains.allowedMechanicsTargetIds ?? {}).flatMap((ids) => ids),
      ];
      for (const id of referenced) {
        const actual = envelope.candidateCatalog.find((candidate) => candidate.id === id);
        const trusted = expected.find((candidate) => candidate.id === id);
        expect(actual).toBeDefined();
        expect(actual).toEqual({
          id: trusted!.id,
          kind: trusted!.kind,
          label: trusted!.label,
          sourceStatementId: trusted!.sourceStatementId,
        });
      }
      return response([]);
    }));

    const result = await requestCompilerHintProposals(input(graph, queue, llm, { maxQuestionsPerRequest: 1, maxRequestsPerRound: 8 }));

    expect(result.callCount).toBe(eligible.length);
    const entryCall = llm.calls.find((call) => requestedEnvelope(call.messages).questions[0]?.candidateDomains.allowedCandidateIds?.length)!;
    const entryEnvelope = requestedEnvelope(entryCall.messages);
    expect(entryEnvelope.candidateCatalog.length).toBeGreaterThan(0);
    expect(entryEnvelope.candidateCatalog.every((candidate) => {
      const source = graph.statements.find((statement) => statement.id === candidate.sourceStatementId);
      return source?.text === candidate.label
        && Object.keys(candidate).sort().join(",") === "id,kind,label,sourceStatementId";
    })).toBe(true);
  });

  it("uses bounded output options in request identity and fails closed for an invalid response bound", async () => {
    const { graph, queue } = fixture();
    const first = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([response([])]), { maxResponseTokens: 1_300 }));
    const second = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([response([])]), { maxResponseTokens: 1_700 }));
    const defaults = await requestCompilerHintProposals({ ...input(graph, queue, new FakeLLM([response([]), response([])])), limits: undefined });
    // Existing callers may still provide the former complete object shape;
    // maxPromptChars is normalized internally rather than made a breaking API requirement.
    const legacyExplicitLimits: CompilerHintProposalAdapterLimits = {
      maxQuestionsPerRequest: 8,
      maxRequestsPerRound: 8,
      maxRequestChars: 24_000,
      maxResponseTokens: 2_400,
    };
    const legacyDefaults = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([response([])]), legacyExplicitLimits));
    const invalid = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([]), { maxResponseTokens: 127 }));
    const invalidPromptFloor = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([]), { maxPromptChars: 0 }));
    const invalidPromptCeiling = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([]), { maxPromptChars: 512_001 }));
    // Optional means omitted may default; every supplied malformed runtime
    // value (including null) must fail closed before a fake can receive text.
    const malformedPromptLimits = await Promise.all([null, Number.NaN, Infinity, "24_000"].map((maxPromptChars) => requestCompilerHintProposals(
      input(graph, queue, new FakeLLM([]), { maxPromptChars: maxPromptChars as unknown as number }),
    )));

    expect(first.calls[0]?.requestHash).not.toBe(second.calls[0]?.requestHash);
    expect(first.calls[0]?.questionIds).toEqual(second.calls[0]?.questionIds);
    expect(defaults.calls.every((call) => call.questionIds.length <= 3)).toBe(true);
    expect(defaults.calls[0]?.requestHash).not.toBe(first.calls[0]?.requestHash);
    expect(legacyDefaults.callCount).toBe(1);
    expect(invalid).toMatchObject({ status: "failed", callCount: 0 });
    expect(invalid.rejected[0]).toMatchObject({ code: "invalid_limit", stage: "input" });
    expect(invalidPromptFloor).toMatchObject({ status: "failed", callCount: 0 });
    expect(invalidPromptFloor.rejected[0]).toMatchObject({ code: "invalid_limit", stage: "input" });
    expect(invalidPromptCeiling).toMatchObject({ status: "failed", callCount: 0 });
    expect(invalidPromptCeiling.rejected[0]).toMatchObject({ code: "invalid_limit", stage: "input" });
    for (const malformed of malformedPromptLimits) {
      expect(malformed).toMatchObject({ status: "failed", callCount: 0 });
      expect(malformed.rejected[0]).toMatchObject({ code: "invalid_limit", stage: "input" });
    }
  });

  it("returns partial when one chunk fails but another is valid, and rejects duplicate or foreign chunk answers fail-closed", async () => {
    const { graph, queue } = fixture();
    const eligible = buildCompilerHintProposalRequestEnvelope(graph, queue).questions.filter((question) => question.allowedKinds.length > 0 && question.kind !== "npc_binding").map((question) => question.questionId).sort();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const failedQuestionId = eligible.find((questionId) => questionId !== role.id)!;
    const partial = await requestCompilerHintProposals(input(graph, queue, new FakeLLM(eligible.map(() => (messages) => {
      const questionId = requestedQuestionIds(messages)[0]!;
      if (questionId === failedQuestionId) return new Error("one chunk failed");
      return response(questionId === role.id ? [roleProposal(graph, role)] : []);
    })), { maxQuestionsPerRequest: 1, maxRequestsPerRound: 8 }));
    expect(partial.status).toBe("partial");
    expect(partial.hints.resolutions.map((resolution) => resolution.questionId)).toEqual([role.id]);
    expect(partial.rejected.some((diagnostic) => diagnostic.code === "llm_call_failed")).toBe(true);

    const duplicate = await requestCompilerHintProposals(input(graph, queue, new FakeLLM(eligible.map(() => (messages) => {
      const questionId = requestedQuestionIds(messages)[0]!;
      return response(questionId === role.id ? [roleProposal(graph, role), roleProposal(graph, role)] : []);
    })), { maxQuestionsPerRequest: 1, maxRequestsPerRound: 8 }));
    expect(duplicate.status).toBe("failed");
    expect(duplicate.rejected.some((diagnostic) => diagnostic.code === "duplicate_question_proposal" && diagnostic.stage === "response")).toBe(true);

    const foreignQuestionId = eligible.find((questionId) => questionId !== eligible[0])!;
    const foreign = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([response([{ questionId: foreignQuestionId, kind: "scene_role", value: { role: "playable_scene" }, citations: [] }]), ...eligible.slice(1).map(() => response([]))]), { maxQuestionsPerRequest: 1, maxRequestsPerRound: 8 }));
    expect(foreign.status).toBe("failed");
    expect(foreign.rejected[0]).toMatchObject({ code: "question_outside_chunk", stage: "response" });
  });

  it("derives hash-addressed proposal provenance from trusted metadata and preserves it through apply", async () => {
    const { graph, queue } = fixture();
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const first = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([response([roleProposal(graph, role)])])));
    const repeated = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([response([roleProposal(graph, role)])])));
    const changed = await requestCompilerHintProposals(input(graph, queue, new FakeLLM([response([roleProposal(graph, role, "other")] )] )));

    const firstAudit = first.hints.resolutions[0]!.audit!;
    const repeatedAudit = repeated.hints.resolutions[0]!.audit!;
    const changedAudit = changed.hints.resolutions[0]!.audit!;
    const firstProducer = firstAudit.producer;
    const changedProducer = changedAudit.producer;
    if (!firstProducer || !changedProducer) throw new Error("adapter audit lacks producer provenance");
    expect(first.requestHashes).toEqual(repeated.requestHashes);
    expect(first.responseHashes).toEqual(repeated.responseHashes);
    expect(firstAudit.proposalId).toBe(repeatedAudit.proposalId);
    expect(firstAudit.proposalId).not.toBe(changedAudit.proposalId);
    expect(firstProducer.requestHash).toBe(first.requestHashes[0]);
    expect(firstProducer.responseHash).toBe(first.responseHashes[0]);
    expect(firstProducer.responseHash).not.toBe(changedProducer.responseHash);
    const applied = applyModuleCompileHints(graph, queue, first.hints);
    expect(applied.questions.find((question) => question.id === role.id)?.resolution?.audit).toEqual(firstAudit);
  });

  it("forwards AbortSignal by identity as a live capability without serializing it, then stops later chunks", async () => {
    const { graph, queue } = fixture();
    const cancellation = new AbortController();
    const llm = new FakeLLM([(_messages, options) => {
      expect(options?.signal).toBe(cancellation.signal);
      expect(options?.signal?.aborted).toBe(false);
      // This callback intentionally snapshots its options like existing test
      // doubles. The helper must retain signal identity rather than trying to
      // structuredClone the non-serializable capability.
      cancellation.abort();
      return response([]);
    }]);
    const request = input(graph, queue, llm, { maxQuestionsPerRequest: 1, maxRequestsPerRound: 8 });
    request.signal = cancellation.signal;

    const result = await requestCompilerHintProposals(request);

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.options?.signal).toBe(cancellation.signal);
    expect(llm.calls[0]?.options?.signal?.aborted).toBe(true);
    expect(result.rejected).toContainEqual(expect.objectContaining({ code: "operation_aborted", stage: "model" }));
  });
});
