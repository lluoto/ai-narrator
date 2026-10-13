import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompilerAutoAdmissionController, DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG } from "../api/compiler-auto-admission";
import { compiledMechanicsAction, GameSession } from "../api/game-session";
import { handleCompiledModuleHttpRequest, type CompiledModuleHttpDependencies } from "../api/compiled-module-http";
import { resolveCompiler, prepareCompiler } from "../compiler/compiler-api";
import { createResolvedCompilerArtifact, restoreCompilerArtifact, type ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { projectResolvedCompilerArtifact, type ModuleDataPresentationMetadata } from "../compiler/compiler-module-data-projection";
import { summarizeCompilerRuntimeQuality } from "../compiler/compiler-runtime-quality";
import type { ChatOptions, LLMLike, Message } from "../llm/client";

const SOURCE_PAGES = [[
  "Dock:",
  "Captain Mira waits beside the launch and guards the harbor manifest.",
  "▶Harbor Ledger: The signed ledger reveals the launch route.",
  "▶Moon Key: The brass key opens the archive cabinet.",
  "Archive:",
  "Lighthouse:",
  "Exit:",
  "Rewards:",
  "SAN +1d6",
  "CM +2",
  "CR +3",
].join("\n")];

const PRODUCTION_LIMITS = {
  maxQuestionsPerRequest: 3,
  maxRequestsPerRound: 8,
  maxRequestChars: 24_000,
  maxResponseTokens: 2_400,
};
const RAW_REPLY_SENTINEL = "AUTO_AGGREGATE_RAW_REPLY_SENTINEL";

interface PromptQuestion {
  questionId: string;
  kind: string;
  sourceStatements: Array<{ statementId: string; text: string }>;
  sourceFactScope?: { rootStatementId: string; parentQuestionId: string; owningHeadingStatementId: string; owningSceneCandidateId: string };
  candidateDomains: {
    candidateIds?: string[];
    subjectCandidateId?: string;
    allowedCandidateIds?: string[];
    allowedLocationCandidateIds?: string[];
    allowedMechanicsTargetIds?: Record<string, string[]>;
    allowedItemNameEvidenceStatementIds?: string[];
    allowedRewardPredicateIds?: Partial<Record<"scene" | "clue" | "item", string[]>>;
    allowedDispositions?: Array<"source_only" | "mechanics_candidate">;
    allowedClueFactAtoms?: Array<{ atomId: string; quote: string; statementId: string }>;
  };
}

interface PromptEnvelope {
  candidateCatalog: Array<{ id: string; kind: "scene" | "clue" | "item" | "prose_npc_anchor" | "reward"; label: string }>;
  questions: PromptQuestion[];
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${label}`);
  return value;
}

/** AbortSignal is a live cancellation capability, not serializable request data. */
function snapshotChatOptions(options: ChatOptions | undefined): ChatOptions | undefined {
  if (!options) return undefined;
  const { signal, ...serializable } = options;
  return { ...structuredClone(serializable), ...(signal ? { signal } : {}) };
}

function promptEnvelope(messages: Message[]): PromptEnvelope {
  const marker = "REQUEST ENVELOPE:\n";
  const content = required(messages.findLast((message) => message.content.includes(marker))?.content, "proposal request envelope");
  return JSON.parse(content.slice(content.lastIndexOf(marker) + marker.length)) as PromptEnvelope;
}

function source(question: PromptQuestion, claimKey: string, predicate: (value: { statementId: string; text: string }) => boolean = () => true) {
  const statement = required(question.sourceStatements.find(predicate), `${question.kind} source statement`);
  return { claimKey, statementId: statement.statementId, quote: statement.text };
}

function itemNameEvidence(question: PromptQuestion): { statementId: string; quote: string } {
  const statementId = required(question.candidateDomains.allowedItemNameEvidenceStatementIds?.[0], "item name evidence domain");
  const statement = required(question.sourceStatements.find((candidate) => candidate.statementId === statementId), "item name evidence source statement");
  return { statementId, quote: statement.text };
}

function candidate(envelope: PromptEnvelope, id: string, label: string) {
  return required(envelope.candidateCatalog.find((entry) => entry.id === id), label);
}

interface AnswerContext {
  dock: string;
  archive: string;
  lighthouse: string;
  exit: string;
  moonKeyItem: string;
}

function subjectLabel(question: PromptQuestion, envelope: PromptEnvelope): string {
  return candidate(envelope, required(question.candidateDomains.subjectCandidateId, `${question.kind} subject`), `${question.kind} candidate`).label;
}

function isMoonQuestion(question: PromptQuestion, envelope: PromptEnvelope): boolean {
  return subjectLabel(question, envelope).includes("MoonKey");
}

function automaticProposal(question: PromptQuestion, envelope: PromptEnvelope, context: AnswerContext, sourceFactMode: "source_only" | "mechanics_candidate" = "source_only"): unknown {
  const { dock, archive, lighthouse, exit, moonKeyItem } = context;
  const subjectId = question.candidateDomains.subjectCandidateId;
  switch (question.kind) {
    case "clue_fact_facets": {
      const clueId = required(subjectId, "clue facet shell subject");
      const atoms = required(question.candidateDomains.allowedClueFactAtoms, "clue facet atom domain");
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: {
          shell: atoms.map((atom) => ({ atomId: atom.atomId, quote: atom.quote })),
          findings: [],
          sourceOnlyAtomIds: [],
        },
        citations: atoms.map((atom) => ({
          claimKey: `clue_fact_shell:${clueId}:${atom.atomId}`,
          statementId: atom.statementId,
          quote: atom.quote,
        })),
      };
    }
    case "scene_role": {
      const playable = [dock, archive, lighthouse, exit].includes(required(subjectId, "scene subject"));
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { role: playable ? "playable_scene" : "other" },
        citations: [source(question, "scene_role")],
      };
    }
    case "entry_scene":
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { sceneCandidateId: dock },
        citations: [source(question, "entry_scene")],
      };
    case "connection_topology": {
      const next = new Map([[dock, archive], [archive, lighthouse], [lighthouse, exit]]).get(required(subjectId, "topology subject"));
      const connectionId = `auto_connection_${question.questionId.slice(-8)}`;
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { connections: next ? [{ toSceneCandidateId: next, connectionId }] : [] },
        citations: [source(question, next ? `connection:${connectionId}` : "topology")],
      };
    }
    case "core_clue":
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { clueCandidateId: required(subjectId, "core clue subject"), required: true },
        citations: [source(question, "core_clue")],
      };
    case "discovery_method": {
      const moon = isMoonQuestion(question, envelope);
      const clueId = required(subjectId, "discovery clue subject");
      const targetId = moon ? moonKeyItem : dock;
      const methodId = `auto_discovery_${question.questionId.slice(-8)}`;
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: {
          clueCandidateId: clueId,
          locationSceneCandidateId: dock,
          spec: {
            kind: "discovery_method",
            id: methodId,
            clueId,
            action: "search",
            target: moon ? "item" : "scene",
            targetId,
            onSuccess: moon
              ? [{ kind: "discover_clue", clueId }, { kind: "acquire_item", itemId: targetId }]
              : [{ kind: "discover_clue", clueId }],
          },
        },
        citations: [source(question, `discovery:${methodId}`)],
      };
    }
    case "item_binding": {
      const moon = isMoonQuestion(question, envelope);
      const itemCandidateId = required(subjectId, "item subject");
      const evidence = moon ? itemNameEvidence(question) : undefined;
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { itemCandidateId, itemType: moon ? "key" : null, ...(evidence ? { itemNameEvidence: evidence } : {}) },
        citations: [evidence
          ? { claimKey: `item_binding:${itemCandidateId}`, statementId: evidence.statementId, quote: evidence.quote }
          : source(question, `item_binding:none:${itemCandidateId}`, (statement) => statement.text === subjectLabel(question, envelope))],
      };
    }
    case "reward_binding": {
      const rewardCandidateId = required(subjectId, "reward subject");
      const san = subjectLabel(question, envelope).includes("SAN");
      const sceneId = required(question.candidateDomains.allowedRewardPredicateIds?.scene?.[0], "reward scene predicate target");
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: {
          rewardCandidateId,
          declaration: san
            ? { when: { kind: "scene_visited", sceneId }, settlement: { san: { kind: "fixed", amount: 1 } } }
            : null,
        },
        citations: [source(question, san ? `reward_binding:${rewardCandidateId}` : `reward_binding:none:${rewardCandidateId}`, (statement) => statement.text === subjectLabel(question, envelope))],
      };
    }
    case "npc_binding": {
      const proseAnchorId = required(subjectId, "NPC anchor subject");
      const bindsMira = question.sourceStatements.some((statement) => statement.text.includes("Mira"));
      const miraStatement = bindsMira ? required(question.sourceStatements.find((statement) => statement.text.includes("Mira")), "Mira source statement") : undefined;
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { proseAnchorId, presentNpcs: bindsMira ? [{ nameQuote: "Mira", dialogueMethods: [] }] : [] },
        citations: bindsMira
          ? [{ claimKey: `npc_binding:${proseAnchorId}:0`, statementId: miraStatement!.statementId, quote: "Mira" }]
          : [source(question, `npc_binding:none:${proseAnchorId}`)],
      };
    }
    case "source_fact_disposition": {
      const statementId = required(question.sourceStatements[0], "source disposition subject").statementId;
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: { statementId, disposition: sourceFactMode === "mechanics_candidate" && question.candidateDomains.allowedDispositions?.includes("mechanics_candidate") ? "mechanics_candidate" : "source_only" },
        citations: [source(question, `source_fact_disposition:${statementId}`)],
      };
    }
    case "source_fact_mechanic": {
      const scope = required(question.sourceFactScope, "source fact mechanic scope");
      const root = required(question.sourceStatements.find((statement) => statement.statementId === scope.rootStatementId), "source fact mechanic root");
      const declarationKey = `auto_source_${question.questionId.slice(-8)}`;
      const claimKeys = ["declaration", "action", "target", "discover"]
        .map((atom) => `source_fact_mechanic:${root.statementId}:${declarationKey}:${atom}`);
      const evidence = claimKeys.map((claimKey) => ({ claimKey, statementId: root.statementId, quote: root.text.trim() }));
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: {
          declarations: [{
            declarationKey,
            kind: "existing_clue_discovery",
            clueCandidateId: required(question.candidateDomains.allowedMechanicsTargetIds?.clue?.[0], "source fact clue domain"),
            action: "search",
            target: "scene",
            targetId: required(question.candidateDomains.allowedMechanicsTargetIds?.scene?.[0], "source fact scene domain"),
            evidence,
          }],
        },
        citations: evidence.map((citation) => ({ ...citation })),
      };
    }
    case "ending_rule": {
      const endingId = "auto_aggregate_departure";
      return {
        questionId: question.questionId,
        kind: question.kind,
        value: {
          declarations: [{
            endingId,
            spec: {
              kind: "ending_rule",
              id: "auto_aggregate_departure_rule",
              priority: 1,
              when: { kind: "scene_visited", sceneId: exit },
              effects: [{ kind: "end_game", endingId }],
            },
          }],
        },
        citations: [source(question, `ending:${endingId}`)],
      };
    }
    default:
      throw new Error(`unsupported automatic proposal kind: ${question.kind}`);
  }
}

class DeterministicAutoFakeLLM implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options: ChatOptions | undefined }> = [];

  constructor(
    private readonly context: AnswerContext,
    private readonly sourceFactMode: "source_only" | "mechanics_candidate" = "source_only",
  ) {}

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.calls.push({ messages: structuredClone(messages), options: snapshotChatOptions(options) });
    const envelope = promptEnvelope(messages);
    return `${RAW_REPLY_SENTINEL}\n${JSON.stringify({ proposals: envelope.questions.map((question) => automaticProposal(question, envelope, this.context, this.sourceFactMode)) })}`;
  }
}

function answerContext(prepared: Awaited<ReturnType<typeof prepareCompiler>> & { status: "prepared" }): AnswerContext {
  const { draft } = prepared.artifact.payload;
  const scene = (heading: string) => required(draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(heading)), `${heading} scene`).id;
  return {
    dock: scene("Dock"),
    archive: scene("Archive"),
    lighthouse: scene("Lighthouse"),
    exit: scene("Exit"),
    moonKeyItem: required(draft.itemCandidates.find((candidate) => candidate.displayName.includes("MoonKey")), "Moon Key item").id,
  };
}

function autoDependencies(catalog: CompilerArtifactCatalog, llm: LLMLike): CompiledModuleHttpDependencies {
  return {
    generateId: () => "not-used",
    hasSession: () => false,
    createSession: () => { throw new Error("auto-resolve must not create a session"); },
    registerSession: () => { throw new Error("auto-resolve must not register a session"); },
    persistSession: () => { throw new Error("auto-resolve must not persist a session"); },
    catalog,
    authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: "aggregate-auto-operator", role: "operator" } }),
    autoCompiler: {
      llm,
      policy: { policyId: "aggregate-auto-policy-v1", rightsStatus: "user_provided" },
      producer: { providerFingerprint: "fake:aggregate-auto", modelFingerprint: "fake:aggregate-auto" },
      limits: PRODUCTION_LIMITS,
      maxProposalRounds: 2,
      // Keep durable admission in the same per-test catalog root. The default
      // root is intentionally process-shared for production and must not leak
      // into an isolated catalog fixture.
      admission: new CompilerAutoAdmissionController({ ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG, root: catalog.root }),
    },
  };
}

function autoRequest(preparedArtifactId: string, preparedQueueHash: string, autoContinuationId?: string): Request {
  return new Request("http://test/api/compiler/auto-resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preparedArtifactId, preparedQueueHash, ...(autoContinuationId ? { autoContinuationId } : {}) }),
  });
}

function presentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const facetRevelations = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    if (binding.shellAtoms.length || binding.findings.length) {
      facetRevelations.set(binding.clueId, binding.shellAtoms.map((atom) => atom.quote).join("\n"));
    }
    for (const finding of binding.findings) {
      facetRevelations.set(finding.clueId, finding.atoms.map((atom) => atom.quote).join("\n"));
    }
  }
  return {
    module: { title: "Aggregate source fact", version: "1", ruleset: "cosmic-horror", era: "test", summary: "test", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id) => [id, { description: id }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection) => [connection.id, { condition: connection.id }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id) => [id, { findMethods: [], revelation: facetRevelations.get(id) ?? id, unlocks: [], importance: "bonus" as const }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((ending) => [ending.effects.find((effect) => effect.kind === "end_game")!.endingId, { name: ending.id, description: ending.id, conditions: [ending.id] }])),
  };
}

describe("automatic aggregate source-to-runtime proposal continuation", () => {
  it("binds automatic admission to its ephemeral catalog root", () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-aggregate-admission-root-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const dependencies = autoDependencies(catalog, { chat: async () => '{"proposals":[]}' });
      expect(dependencies.autoCompiler?.admission.root).toBe(catalog.root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses production-capped proposals over two rounds, retains only a presentation draft, and resolves breadth privately", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-aggregate-"));
    try {
      const prepared = await prepareCompiler({
        kind: "synthetic_pages",
        moduleId: "auto-aggregate-source-runtime",
        sourceDescriptor: "auto-aggregate-source-runtime",
        pages: SOURCE_PAGES,
      });
      if (prepared.status === "refused") throw new Error(prepared.message);
      const { draft, preparedQueue } = prepared.artifact.payload;
      expect(draft.sceneCandidates).toHaveLength(5);
      expect(draft.clueCandidates).toHaveLength(2);
      expect(draft.itemCandidates).toHaveLength(2);
      expect(draft.proseNpcAnchors).toHaveLength(1);
      expect(draft.rewardCandidates).toHaveLength(3);
      expect(preparedQueue.questions).toHaveLength(26);
      expect(preparedQueue.questions.filter((question) => question.kind === "source_fact_mechanic")).toHaveLength(1);

      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      let bundleWrites = 0;
      const saveBundle = catalog.saveBundle.bind(catalog);
      (catalog as unknown as { saveBundle: typeof catalog.saveBundle }).saveBundle = ((artifact: unknown, projection: unknown) => {
        bundleWrites++;
        return saveBundle(artifact, projection);
      }) as typeof catalog.saveBundle;
      const llm = new DeterministicAutoFakeLLM(answerContext(prepared));

      const response = required(await handleCompiledModuleHttpRequest(
        autoRequest(saved.value.id, prepared.identity.preparedQueueHash),
        autoDependencies(catalog, llm),
      ), "automatic response");
      expect(response.status).toBe(200);
      const publicText = await response.text();
      const body = JSON.parse(publicText) as {
        status: string;
        continuationId: string;
        mechanics: { readiness: string };
        presentation: { readiness: string };
        rounds: Array<{ round: number; askedQuestionIds: string[]; acceptedQuestionIds: string[]; callCount: number }>;
      };
      expect(body).toMatchObject({
        status: "presentation_draft_only",
        mechanics: { readiness: "mechanically_closed" },
        presentation: { readiness: "visibility_unresolved" },
      });
      expect(body.continuationId).toMatch(/^[a-z2-7]{24}$/);
      expect(body.rounds).toHaveLength(2);
      expect(body.rounds[0]?.callCount).toBe(8);
      expect(body.rounds[1]?.callCount).toBe(1);
      const npcQuestionIds = preparedQueue.questions.filter((question) => question.kind === "npc_binding").map((question) => question.id);
      expect(body.rounds[0]?.askedQuestionIds).not.toContain(npcQuestionIds[0]!);
      expect(body.rounds[1]?.askedQuestionIds).toEqual(npcQuestionIds);
      expect(body.rounds[1]?.askedQuestionIds.some((questionId) => body.rounds[0]?.askedQuestionIds.includes(questionId))).toBe(false);
      expect(publicText).not.toContain("Captain Mira");
      expect(publicText).not.toContain("Moon Key");
      expect(publicText).not.toContain("Harbor Ledger");
      expect(publicText).not.toContain(RAW_REPLY_SENTINEL);
      expect(publicText).not.toContain("\"hints\"");
      expect(publicText).not.toContain("\"approved_policy\"");
      expect(publicText).not.toContain("\"audit\"");
      expect(bundleWrites).toBe(0);

      const continuation = catalog.loadAutoResolveContinuation(body.continuationId);
      if (continuation.status !== "ok") throw new Error(continuation.message);
      expect(continuation.value.hints.resolutions).toHaveLength(preparedQueue.questions.filter((question) => question.kind !== "source_fact_mechanic").length);
      expect(continuation.value.hints.resolutions.every((resolution) =>
        resolution.authority === "user_document"
        && resolution.reviewerKind === "approved_policy"
        && resolution.audit?.producer?.providerFingerprint === "fake:aggregate-auto"
        && resolution.audit?.producer?.modelFingerprint === "fake:aggregate-auto",
      )).toBe(true);
      expect(continuation.value.hints.resolutions.find((resolution) => resolution.kind === "npc_binding")?.value).toMatchObject({
        presentNpcs: [{ nameQuote: "Mira", dialogueMethods: [] }],
      });

      const callsBeforeContinuation = llm.calls.length;
      const replay = required(await handleCompiledModuleHttpRequest(
        autoRequest(saved.value.id, prepared.identity.preparedQueueHash, body.continuationId),
        autoDependencies(catalog, llm),
      ), "automatic continuation replay");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status: "presentation_draft_only", resumed: true, progress: false });
      expect(llm.calls).toHaveLength(callsBeforeContinuation);

      const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, continuation.value.hints);
      if (resolved.status === "refused") throw new Error(resolved.message);
      const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
      const quality = summarizeCompilerRuntimeQuality(payload);
      expect(payload.readiness.status).toBe("mechanically_closed");
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
        dialogueMethods: 0,
        encounters: 0,
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cumulatively activates an approved-policy source child, restores its artifact, projects it, and executes its derived discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-source-child-"));
    try {
      const prepared = await prepareCompiler({
        kind: "synthetic_pages",
        moduleId: "auto-aggregate-source-child",
        sourceDescriptor: "auto-aggregate-source-child",
        pages: SOURCE_PAGES,
      });
      if (prepared.status === "refused") throw new Error(prepared.message);
      const preparedQueueHash = prepared.identity.preparedQueueHash;
      const sourceParent = prepared.artifact.payload.preparedQueue.questions.find((question) => question.kind === "source_fact_disposition" && question.sourceFactChildQuestionId)!;
      const sourceChildId = sourceParent.sourceFactChildQuestionId!;
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const llm = new DeterministicAutoFakeLLM(answerContext(prepared), "mechanics_candidate");

      const response = required(await handleCompiledModuleHttpRequest(
        autoRequest(saved.value.id, preparedQueueHash),
        autoDependencies(catalog, llm),
      ), "source child automatic response");
      expect(response.status).toBe(200);
      const body = await response.json() as {
        continuationId: string;
        rounds: Array<{ queueHash: string; askedQuestionIds: string[]; acceptedQuestionIds: string[] }>;
      };
      expect(body.rounds).toHaveLength(2);
      expect(body.rounds[0]?.askedQuestionIds).toContain(sourceParent.id);
      expect(body.rounds[0]?.askedQuestionIds).not.toContain(sourceChildId);
      expect(body.rounds[1]?.askedQuestionIds).toContain(sourceChildId);
      expect(body.rounds[1]?.queueHash).not.toBe(body.rounds[0]?.queueHash);
      expect(prepared.identity.preparedQueueHash).toBe(preparedQueueHash);

      const continuation = catalog.loadAutoResolveContinuation(body.continuationId);
      if (continuation.status !== "ok") throw new Error(continuation.message);
      const childResolution = continuation.value.hints.resolutions.find((resolution) => resolution.questionId === sourceChildId)!;
      expect(childResolution).toMatchObject({
        kind: "source_fact_mechanic",
        reviewerKind: "approved_policy",
        audit: { producer: { providerFingerprint: "fake:aggregate-auto" } },
      });
      expect(continuation.value.hints.resolutions.find((resolution) => resolution.questionId === sourceParent.id)?.value)
        .toEqual({ statementId: sourceParent.subjectStatementId, disposition: "mechanics_candidate" });

      const resolved = resolveCompiler(prepared.artifact, preparedQueueHash, continuation.value.hints);
      if (resolved.status === "refused") throw new Error(resolved.message);
      const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
      const binding = payload.sourceFactMechanicBindings.find((candidate) => candidate.questionId === sourceChildId);
      if (!binding || binding.declarationKind !== "existing_clue_discovery") throw new Error("missing existing-clue source fact binding");
      const interpretation = payload.acceptedInterpretations.find((candidate) => candidate.id === binding.interpretationId)!;
      const mechanism = payload.mechanicsIR.discoveryMethods.find((candidate) => candidate.id === binding.mechanismId)!;
      expect(binding).toMatchObject({ parentQuestionId: sourceParent.id, declarationKind: "existing_clue_discovery", sceneCandidateId: answerContext(prepared).dock });
      expect(interpretation.sourceStatementIds).toEqual(expect.arrayContaining([binding.statementId, binding.headingStatementId]));
      expect(mechanism).toMatchObject({ id: binding.mechanismId, clueId: binding.spec.clueId, action: "search", target: "scene", onSuccess: [{ kind: "discover_clue", clueId: binding.spec.clueId }] });
      expect(payload.analysisInput.discoveryLocations[binding.mechanismId]).toBe(binding.sceneCandidateId);
      const dispositionEntry = payload.resolvedSourceFactDispositionReport.entries.find((entry) => entry.statementId === binding.statementId)!;
      expect(dispositionEntry.positiveCoverage).toBe(true);
      expect(dispositionEntry.reasons.includes("accepted_source_fact_mechanic")).toBe(true);

      const artifact = createResolvedCompilerArtifact(payload);
      expect(restoreCompilerArtifact(artifact)).toMatchObject({ status: "restored", stage: "resolved" });
      const tampered = structuredClone(artifact);
      ((tampered.payload as ResolvedCompilerArtifactPayload).sourceFactMechanicBindings[0]!.evidence[0]!).quote = "forged source fact";
      expect(restoreCompilerArtifact(tampered).status).toBe("refused");

      const projection = projectResolvedCompilerArtifact(payload, presentation(payload));
      if (projection.status === "refused") throw new Error(projection.message);
      expect(projection.sourceMap.scenes[binding.sceneCandidateId]!.clues[binding.spec.clueId]).toBeDefined();
      const session = new GameSession("aggregate-source-child", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 1 }, "investigator", "Ada");
      expect(session.loadCompiledModule(payload, projection).status).toBe("loaded");
      expect(session.getCompiledAvailableActions().some((action) => action.mechanismId === binding.mechanismId)).toBe(true);
      const discovered = await session.act(compiledMechanicsAction(binding.mechanismId));
      expect(discovered.error).toBeUndefined();
      expect(discovered.compiled?.state.foundClueIds).toContain(binding.spec.clueId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
