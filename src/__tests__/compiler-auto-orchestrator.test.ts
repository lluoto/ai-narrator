import { describe, expect, it } from "bun:test";
import { orchestrateAutoCompiler } from "../api/compiler-auto-orchestrator";
import { resolveDraftModule } from "../compiler/compile-hint-resolution";
import { prepareCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import type { ChatOptions, LLMLike, Message } from "../llm/client";

const SOURCE = {
  kind: "synthetic_pages" as const,
  moduleId: "auto-compiler-e2e",
  sourceDescriptor: "auto-compiler-e2e",
  pages: ["Entry:\n◆Copper Key: It opens the archive.\nArchive:\n◆Exit Pass: It permits departure.\nExit:"],
};

interface PromptQuestion {
  questionId: string;
  kind: string;
  sourceStatements: Array<{ statementId: string; text: string }>;
  candidateDomains: {
    candidateIds?: string[];
    subjectCandidateId?: string;
    allowedCandidateIds?: string[];
    allowedLocationCandidateIds?: string[];
    allowedMechanicsTargetIds?: Record<string, string[]>;
  };
}

interface PromptEnvelope {
  questions: PromptQuestion[];
  candidateCatalog: Array<{ id: string; kind: "scene" | "clue" }>;
}

type FakeReply = string | Error | ((messages: Message[], options: ChatOptions | undefined, call: number) => string | Error);

/** AbortSignal is intentionally kept by identity rather than cloned. */
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

function promptEnvelope(messages: Message[]): PromptEnvelope {
  const content = messages[1]?.content ?? "";
  const marker = "REQUEST ENVELOPE:\n";
  return JSON.parse(content.slice(content.lastIndexOf(marker) + marker.length)) as PromptEnvelope;
}

function citation(question: PromptQuestion, claimKey: string) {
  const source = question.sourceStatements[0]!;
  return { claimKey, statementId: source.statementId, quote: source.text };
}

function proposal(question: PromptQuestion, envelope: PromptEnvelope): unknown {
  const sceneIds = envelope.candidateCatalog.filter((candidate) => candidate.kind === "scene").map((candidate) => candidate.id).sort();
  const sceneIndex = sceneIds.indexOf(question.candidateDomains.subjectCandidateId ?? "");
  const clueId = question.candidateDomains.subjectCandidateId!;
  switch (question.kind) {
    case "scene_role":
      return { questionId: question.questionId, kind: question.kind, value: { role: "playable_scene" }, citations: [citation(question, "scene_role")] };
    case "entry_scene":
      return { questionId: question.questionId, kind: question.kind, value: { sceneCandidateId: sceneIds[0] }, citations: [citation(question, "entry_scene")] };
    case "connection_topology": {
      const nextSceneId = sceneIndex >= 0 ? sceneIds[sceneIndex + 1] : undefined;
      const connectionId = `connection_auto_${question.questionId.slice(-8)}`;
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { connections: nextSceneId ? [{ toSceneCandidateId: nextSceneId, connectionId }] : [] },
        citations: [citation(question, nextSceneId ? `connection:${connectionId}` : "topology")],
      };
    }
    case "core_clue":
      return { questionId: question.questionId, kind: question.kind, value: { clueCandidateId: clueId, required: true }, citations: [citation(question, "core_clue")] };
    case "discovery_method": {
      const location = question.candidateDomains.allowedLocationCandidateIds![0]!;
      const targetId = question.candidateDomains.allowedMechanicsTargetIds!.scene![0]!;
      const methodId = `discovery_auto_${question.questionId.slice(-8)}`;
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: {
          clueCandidateId: clueId,
          locationSceneCandidateId: location,
          spec: { kind: "discovery_method", id: methodId, clueId, action: "search", target: "scene", targetId, onSuccess: [{ kind: "discover_clue", clueId }] },
        },
        citations: [citation(question, `discovery:${methodId}`)],
      };
    }
    case "source_fact_disposition": {
      const statementId = question.sourceStatements[0]!.statementId;
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { statementId, disposition: "source_only" },
        citations: [citation(question, `source_fact_disposition:${statementId}`)],
      };
    }
    case "ending_rule": {
      const endingId = "ending_auto_exit";
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: {
          declarations: [{
            endingId,
            spec: {
              kind: "ending_rule",
              id: "rule_auto_exit",
              priority: 10,
              when: { kind: "scene_visited", sceneId: sceneIds.at(-1)! },
              effects: [{ kind: "end_game", endingId }],
            },
          }],
        },
        citations: [citation(question, `ending:${endingId}`)],
      };
    }
    case "npc_binding": {
      const proseAnchorId = question.candidateDomains.subjectCandidateId!;
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { proseAnchorId, presentNpcs: [] },
        citations: [citation(question, `npc_binding:none:${proseAnchorId}`)],
      };
    }
    default:
      throw new Error(`fake was asked for unsupported kind: ${question.kind}`);
  }
}

function fullReply(messages: Message[]): string {
  const envelope = promptEnvelope(messages);
  return JSON.stringify({ proposals: envelope.questions.map((question) => proposal(question, envelope)) });
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
    reason: "caller-reviewed explicit declaration bound to the prepared queue evidence",
  };
}

function completeExplicitHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const queue = prepared.artifact.payload.preparedQueue;
  const sceneIds = queue.questions.filter((question) => question.kind === "scene_role").map((question) => question.subjectCandidateId!).sort();
  const value = (question: CompilerQuestion): unknown => {
    const sceneIndex = sceneIds.indexOf(question.subjectCandidateId ?? "");
    const clueId = question.subjectCandidateId!;
    switch (question.kind) {
      case "scene_role": return { role: "playable_scene" };
      case "entry_scene": return { sceneCandidateId: sceneIds[0] };
      case "connection_topology": {
        const nextSceneId = sceneIndex >= 0 ? sceneIds[sceneIndex + 1] : undefined;
        return { connections: nextSceneId ? [{ toSceneCandidateId: nextSceneId, connectionId: `connection_explicit_${question.id.slice(-8)}` }] : [] };
      }
      case "core_clue": return { clueCandidateId: clueId, required: true };
      case "discovery_method": {
        const location = question.allowedLocationCandidateIds![0]!;
        const targetId = question.allowedMechanicsTargetIds!.scene![0]!;
        return {
          clueCandidateId: clueId,
          locationSceneCandidateId: location,
          spec: { kind: "discovery_method", id: `discovery_explicit_${question.id.slice(-8)}`, clueId, action: "search", target: "scene", targetId, onSuccess: [{ kind: "discover_clue", clueId }] },
        };
      }
      case "source_fact_disposition": return { statementId: question.subjectStatementId, disposition: "source_only" };
      case "ending_rule": {
        const endingId = "ending_explicit_exit";
        return { declarations: [{ endingId, spec: { kind: "ending_rule", id: "rule_explicit_exit", priority: 10, when: { kind: "scene_visited", sceneId: sceneIds.at(-1)! }, effects: [{ kind: "end_game", endingId }] } }] };
      }
      case "npc_binding": return { proseAnchorId: question.subjectCandidateId, presentNpcs: [] };
      default: throw new Error(`cannot make an explicit answer for ${question.kind}`);
    }
  };
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
    moduleId: queue.moduleId,
    documentHash: queue.documentHash,
    sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: queue.questions.filter((question) => (["scene_role", "entry_scene", "connection_topology", "core_clue", "ending_rule", "discovery_method", "npc_binding"].includes(question.kind) && question.subjectCandidateId !== undefined) || ["entry_scene", "ending_rule", "source_fact_disposition"].includes(question.kind)).map((question) => humanResolution(question, value(question))),
  };
}

function semanticallyUnclosedHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const hints = structuredClone(completeExplicitHints(prepared));
  const queue = prepared.artifact.payload.preparedQueue;
  const sceneIds = queue.questions.filter((question) => question.kind === "scene_role").map((question) => question.subjectCandidateId!).sort();
  const entry = hints.resolutions.find((resolution) => resolution.kind === "entry_scene")!;
  const entrySceneId = (entry.value as { sceneCandidateId: string }).sceneCandidateId;
  const entryTopologyQuestion = queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === entrySceneId)!;
  const entryTopology = hints.resolutions.find((resolution) => resolution.questionId === entryTopologyQuestion.id)!;
  entryTopology.value = { connections: [] };
  const unreachableSceneId = sceneIds.find((sceneId) => sceneId !== entrySceneId)!;
  const ending = hints.resolutions.find((resolution) => resolution.kind === "ending_rule")!;
  ending.value = {
    declarations: [{
      endingId: "ending_explicit_unreachable",
      spec: {
        kind: "ending_rule",
        id: "rule_explicit_unreachable",
        priority: 10,
        when: { kind: "scene_visited", sceneId: unreachableSceneId },
        effects: [{ kind: "end_game", endingId: "ending_explicit_unreachable" }],
      },
    }],
  };
  return hints;
}

function input(llm: LLMLike, extra: Partial<Parameters<typeof orchestrateAutoCompiler>[0]> = {}) {
  return {
    source: SOURCE,
    llm,
    policy: { policyId: "trusted-auto-policy-v1", rightsStatus: "user_provided" as const },
    producer: { providerFingerprint: "provider:auto-test", modelFingerprint: "model:auto-test" },
    ...extra,
  };
}

async function prepared(): Promise<PreparedCompilerApiResult> {
  const result = await prepareCompiler(SOURCE);
  if (result.status === "refused") throw new Error(result.message);
  return result;
}

describe("internal auto compiler orchestrator", () => {
  it("runs synthetic pages through prepare, bounded fake-LLM proposals, grounded compilation, and resolve into a closed artifact", async () => {
    const llm = new FakeLLM(Array.from({ length: 8 }, () => (messages: Message[]) => fullReply(messages)));
    const result = await orchestrateAutoCompiler(input(llm, { maxProposalRounds: 2, proposalLimits: { maxQuestionsPerRequest: 2, maxRequestsPerRound: 8, maxResponseTokens: 2_800 } }));

    if (result.status !== "resolved") throw new Error(JSON.stringify(result.diagnostics));
    expect(result.prepared.artifact.stage).toBe("prepared");
    expect(result.resolved.artifact.stage).toBe("resolved");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.callCount).toBeGreaterThan(1);
    const npcQuestionIds = result.prepared.artifact.payload.preparedQueue.questions.filter((question) => question.kind === "npc_binding").map((question) => question.id).sort();
    expect(result.rounds[0]?.askedQuestionIds).not.toContain(npcQuestionIds[0]!);
    expect(result.rounds[1]?.askedQuestionIds).toEqual(npcQuestionIds);
    expect(result.rounds[1]?.askedQuestionIds.some((questionId) => result.rounds[0]?.askedQuestionIds.includes(questionId))).toBe(false);
    expect(result.hints.resolutions.every((resolution) => resolution.authority === "user_document" && resolution.reviewerKind === "approved_policy" && resolution.audit?.producer?.modelFingerprint === "model:auto-test")).toBe(true);
  });

  it("returns draft_only after partial answers and does not re-ask the question answered in an earlier round", async () => {
    let firstAnsweredQuestionId = "";
    const llm = new FakeLLM(Array.from({ length: 20 }, () => (messages, _options, call) => {
      const envelope = promptEnvelope(messages);
      const question = envelope.questions[0]!;
      if (call === 0) {
        firstAnsweredQuestionId = question.questionId;
        return JSON.stringify({ proposals: [proposal(question, envelope)] });
      }
      return JSON.stringify({ proposals: [] });
    }));
    const result = await orchestrateAutoCompiler(input(llm, { maxProposalRounds: 2, proposalLimits: { maxQuestionsPerRequest: 1 } }));

    expect(result.status).toBe("draft_only");
    if (result.status !== "draft_only") return;
    expect(result.hints.resolutions.map((resolution) => resolution.questionId)).toEqual([firstAnsweredQuestionId]);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[1]?.askedQuestionIds).not.toContain(firstAnsweredQuestionId);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "RESOLVE_NOT_PUBLISHABLE")).toBe(true);
    expect(result.resolutionSnapshot?.readiness.status).toBe("draft_only");
    expect(result.resolutionSnapshot?.readiness.openQuestionIds).toEqual(result.unansweredQuestionIds);
  });

  it("turns bad JSON and a model exception into diagnostic draft_only results without manufacturing answers", async () => {
    for (const reply of ["not json", new Error("offline")] as const) {
      const result = await orchestrateAutoCompiler(input(new FakeLLM([reply]), { maxProposalRounds: 1, proposalLimits: { maxQuestionsPerRequest: 8 } }));
      expect(result.status).toBe("draft_only");
      if (result.status !== "draft_only") continue;
      expect(result.hints.resolutions).toEqual([]);
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === (typeof reply === "string" ? "invalid_json" : "llm_call_failed"))).toBe(true);
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "RESOLVE_NOT_PUBLISHABLE")).toBe(true);
    }
  });

  it("fails closed for stale or conflicting caller hints before asking the model", async () => {
    const current = await prepared();
    const queue = current.artifact.payload.preparedQueue;
    const role = queue.questions.find((question) => question.kind === "scene_role")!;
    const staleLLM = new FakeLLM([]);
    const stale = await orchestrateAutoCompiler(input(staleLLM, {
      explicitHints: { schemaVersion: "1.3.0", moduleId: "foreign", documentHash: queue.documentHash, sourceGraphIdentity: queue.sourceGraphIdentity, resolutions: [] },
    }));
    const conflictLLM = new FakeLLM([]);
    const conflict = await orchestrateAutoCompiler(input(conflictLLM, {
      explicitHints: {
        schemaVersion: "1.3.0", moduleId: queue.moduleId, documentHash: queue.documentHash, sourceGraphIdentity: queue.sourceGraphIdentity,
        resolutions: [humanResolution(role, { role: "playable_scene" }), humanResolution(role, { role: "other" })],
      },
    }));

    expect(stale).toMatchObject({ status: "draft_only" });
    expect(conflict).toMatchObject({ status: "draft_only" });
    if (stale.status === "draft_only") expect(stale.diagnostics[0]?.code).toBe("identity_mismatch");
    if (conflict.status === "draft_only") expect(conflict.diagnostics[0]?.code).toBe("conflicting_resolution");
    if (stale.status === "draft_only") expect(stale.resolutionSnapshot).toBeUndefined();
    if (conflict.status === "draft_only") expect(conflict.resolutionSnapshot).toBeUndefined();
    expect(staleLLM.calls).toEqual([]);
    expect(conflictLLM.calls).toEqual([]);
  });

  it("exposes the compiler's concrete readiness and reachability causes when complete hints are semantically nonclosed", async () => {
    const current = await prepared();
    const llm = new FakeLLM([]);
    const result = await orchestrateAutoCompiler(input(llm, { explicitHints: semanticallyUnclosedHints(current), maxProposalRounds: 1 }));

    expect(result.status).toBe("draft_only");
    if (result.status !== "draft_only") return;
    expect(llm.calls).toEqual([]);
    expect(result.resolveRefusal?.code).toBe("RESOLVE_NOT_PUBLISHABLE");
    expect(result.resolutionSnapshot?.readiness).toMatchObject({ status: "draft_only" });
    expect(result.resolutionSnapshot?.readiness.blockingCodes).toContain("reachability_incomplete");
    expect(result.resolutionSnapshot?.analysis?.unreachableEndingIds).toContain("ending_explicit_unreachable");
    const direct = resolveDraftModule(current.artifact.payload.graph, current.artifact.payload.draft, current.artifact.payload.preparedQueue, result.hints);
    expect(result.resolutionSnapshot?.readiness).toEqual({
      status: direct.readiness.status,
      blockingCodes: direct.readiness.blockingCodes,
      openQuestionIds: direct.readiness.openQuestionIds,
      publishBlockingQuestionIds: direct.readiness.publishBlockingQuestionIds,
      generatedMechanicIds: direct.readiness.generatedMechanicIds,
    });
    expect(result.resolutionSnapshot?.analysis).toEqual({
      unreachableCoreClueIds: direct.reachabilityReport?.unreachableCoreClueIds ?? [],
      unreachableEndingIds: direct.reachabilityReport?.unreachableEndingIds ?? [],
      deadlockIds: direct.reachabilityReport?.deadlockWitnesses.map((witness) => witness.final.id).sort() ?? [],
      failurePolicyRiskMethodIds: direct.reachabilityReport?.failurePolicyRiskMethodIds ?? [],
    });
  });

  it("does not call LLMLike when caller hints already answer every eligible question", async () => {
    const current = await prepared();
    const llm = new FakeLLM([]);
    const result = await orchestrateAutoCompiler(input(llm, { explicitHints: completeExplicitHints(current), maxProposalRounds: 2 }));

    if (result.status !== "resolved") throw new Error(JSON.stringify(result));
    expect(result.rounds[0]).toMatchObject({ status: "no_eligible_questions", callCount: 0 });
    expect(llm.calls).toEqual([]);
  });
});
