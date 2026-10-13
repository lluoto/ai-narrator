import { describe, expect, it, vi } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleCompiledModuleHttpRequest, type CompiledModuleHttpDependencies } from "../api/compiled-module-http";
import { handleRequest, SERVER_AUTO_COMPILER_POLICY } from "../api/server";
import { CompilerAutoAdmissionController, type CompilerAutoAdmissionConfig } from "../api/compiler-auto-admission";
import { CompilerArtifactCatalog, compilerArtifactCatalogNodeFileOps } from "../compiler/compiler-artifact-catalog";
import { prepareCompiler } from "../compiler/compiler-api";
import { buildCompilerHintProposalRequestEnvelope } from "../compiler/compiler-hint-proposals";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION } from "../compiler/compiler-question-queue";
import type { ChatOptions, LLMLike, Message } from "../llm/client";
import { PAGES } from "./helpers/compiled-module-http-fixture";

class DeferredFakeLLM implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];
  private readonly firstCall: Promise<void>;
  private signalFirstCall!: () => void;
  private settled: { value: string } | { error: Error } | undefined;
  private readonly waiting: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];

  constructor() {
    this.firstCall = new Promise<void>((resolve) => { this.signalFirstCall = resolve; });
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.calls.push({ messages: structuredClone(messages), options: options ? { ...options } : undefined });
    if (this.calls.length === 1) this.signalFirstCall();
    if (this.settled) {
      if ("error" in this.settled) throw this.settled.error;
      return this.settled.value;
    }
    return new Promise<string>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  async waitForFirstCall(timeoutMs = 4_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.firstCall,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`DeferredFakeLLM did not receive its first call within ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  resolve(value = '{"proposals":[]}'): void {
    if (this.settled) throw new Error("DeferredFakeLLM was already settled");
    this.settled = { value };
    for (const waiter of this.waiting.splice(0)) waiter.resolve(value);
  }

  reject(error = new Error("deferred fake model failure")): void {
    if (this.settled) throw new Error("DeferredFakeLLM was already settled");
    this.settled = { error };
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }
}

class AbortAwareDeferredLLM implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];
  private readonly firstCall: Promise<void>;
  private signalFirstCall!: () => void;

  constructor() {
    this.firstCall = new Promise<void>((resolve) => { this.signalFirstCall = resolve; });
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.calls.push({ messages: structuredClone(messages), options: options ? { ...options } : undefined });
    if (this.calls.length === 1) this.signalFirstCall();
    return new Promise<string>((_resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(new DOMException("cancelled", "AbortError"));
        return;
      }
      options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  }

  async waitForFirstCall(timeoutMs = 4_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.firstCall,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`AbortAwareDeferredLLM did not receive its first call within ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

class LateProseFirstRoundLLM implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];
  private readonly firstCall: Promise<void>;
  private signalFirstCall!: () => void;
  private first: { messages: Message[]; options?: ChatOptions; resolve: (value: string) => void } | undefined;

  constructor() {
    this.firstCall = new Promise<void>((resolve) => { this.signalFirstCall = resolve; });
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.calls.push({ messages: structuredClone(messages), options: options ? { ...options } : undefined });
    if (this.calls.length !== 1) return new ProseFactFindingFakeLLM().chat(messages, options);
    this.signalFirstCall();
    return new Promise<string>((resolve) => { this.first = { messages, options, resolve }; });
  }

  async waitForFirstCall(timeoutMs = 4_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.firstCall,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`LateProseFirstRoundLLM did not receive its first call within ${timeoutMs}ms`)), timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async resolveFirst(): Promise<void> {
    if (!this.first) throw new Error("late first-round model was not waiting");
    const first = this.first;
    this.first = undefined;
    first.resolve(await new ProseFactFindingFakeLLM().chat(first.messages, first.options));
  }
}

async function waitForAdmissionDrain(
  controller: CompilerAutoAdmissionController,
  input: Parameters<CompilerAutoAdmissionController["acquire"]>[0],
  timeoutMs = 4_000,
): Promise<Extract<ReturnType<CompilerAutoAdmissionController["acquire"]>, { status: "acquired" }>> {
  const deadline = Date.now() + timeoutMs;
  let last = controller.acquire(input);
  while (last.status !== "acquired") {
    if (Date.now() >= deadline) {
      throw new Error(`automatic admission did not drain within ${timeoutMs}ms (last refusal: ${last.code})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    last = controller.acquire(input);
  }
  return last;
}

class ImmediateFakeLLM implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.calls.push({ messages: structuredClone(messages), options: options ? { ...options } : undefined });
    return '{"proposals":[]}';
  }
}

interface ProposalRequestQuestion {
  questionId: string;
  kind: string;
  prompt: string;
  sourceStatements: Array<{ statementId: string; text: string }>;
  candidateDomains: {
    allowedDispositions?: Array<"source_only" | "mechanics_candidate">;
    allowedSourceFactMechanicKinds?: string[];
    allowedSourceFactAtoms?: Array<{ atomId: string; quote: string; statementId: string }>;
    allowedProseFactFindingCandidates?: Array<{ candidateId: string; atomId: string; quote: string; check: unknown }>;
  };
}

interface ProposalRequestEnvelope {
  questions: ProposalRequestQuestion[];
}

function proposalRequestEnvelope(messages: Message[]): ProposalRequestEnvelope {
  const marker = "REQUEST ENVELOPE:\n";
  const content = messages[1]?.content ?? "";
  return JSON.parse(content.slice(content.lastIndexOf(marker) + marker.length)) as ProposalRequestEnvelope;
}

class ProseFactFindingFakeLLM implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    this.calls.push({ messages: structuredClone(messages), options: options ? { ...options } : undefined });
    const proposals: Array<{ questionId: string; kind: string; value: unknown; citations: unknown[] }> = [];
    for (const question of proposalRequestEnvelope(messages).questions) {
      const source = question.sourceStatements[0];
      if (question.kind === "source_fact_mechanic"
        && question.candidateDomains.allowedProseFactFindingCandidates?.length
        && question.candidateDomains.allowedSourceFactAtoms?.length) {
        const finding = question.candidateDomains.allowedProseFactFindingCandidates[0]!;
        const atoms = question.candidateDomains.allowedSourceFactAtoms;
        proposals.push({
          questionId: question.questionId,
          kind: question.kind,
          value: {
            findingCandidateIds: [finding.candidateId],
            sourceOnlyAtomIds: atoms.filter((atom) => atom.atomId !== finding.atomId).map((atom) => atom.atomId),
          },
          citations: [],
        });
        continue;
      }
      if (!source) continue;
      if (question.kind === "scene_role") {
        proposals.push({
          questionId: question.questionId,
          kind: question.kind,
          value: { role: "playable_scene" },
          citations: [{ claimKey: "scene_role", statementId: source.statementId, quote: source.text }],
        });
        continue;
      }
      if (question.kind === "source_fact_disposition" && question.candidateDomains.allowedDispositions?.includes("mechanics_candidate")) {
        proposals.push({
          questionId: question.questionId,
          kind: question.kind,
          value: { statementId: source.statementId, disposition: "mechanics_candidate" },
          citations: [{ claimKey: `source_fact_disposition:${source.statementId}`, statementId: source.statementId, quote: source.text }],
        });
      }
    }
    return JSON.stringify({ proposals });
  }
}

function admission(root: string, overrides: Partial<CompilerAutoAdmissionConfig> = {}) {
  let now = 1_000;
  return {
    controller: new CompilerAutoAdmissionController({
      root,
      globalConcurrent: 2,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 4,
      windowMs: 60_000,
      maxTrackedPrincipals: 32,
      now: () => now,
      ...overrides,
    }),
    advance(milliseconds: number) { now += milliseconds; },
  };
}

async function storePrepared(catalog: CompilerArtifactCatalog, moduleId: string, pages = PAGES) {
  const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId, sourceDescriptor: moduleId, pages });
  if (prepared.status === "refused") throw new Error(prepared.message);
  const saved = catalog.savePrepared(prepared.artifact);
  if (saved.status !== "ok") throw new Error(saved.message);
  return { id: saved.value.id, identity: prepared.identity, artifact: prepared.artifact };
}

function dependencies(catalog: CompilerArtifactCatalog, llm: LLMLike, controller: CompilerAutoAdmissionController, principalId: string): CompiledModuleHttpDependencies {
  return {
    generateId: () => "not-used",
    hasSession: () => false,
    createSession: () => { throw new Error("automatic resolution must not create sessions"); },
    registerSession: () => { throw new Error("automatic resolution must not register sessions"); },
    persistSession: () => { throw new Error("automatic resolution must not persist sessions"); },
    catalog,
    authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: principalId, role: "operator" } }),
    autoCompiler: {
      llm,
      policy: { policyId: "server-auto-admission-test-v1", rightsStatus: "user_provided" },
      producer: { providerFingerprint: "test:deferred", modelFingerprint: "test:deferred" },
      limits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxRequestChars: 24_000, maxResponseTokens: 2_400 },
      maxProposalRounds: 1,
      admission: controller,
    },
  };
}

function request(prepared: { id: string; identity: { preparedQueueHash: string } }, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Request("http://test/api/compiler/auto-resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ preparedArtifactId: prepared.id, preparedQueueHash: prepared.identity.preparedQueueHash, ...extra }),
  });
}

function unavailableDependencies(catalog: CompilerArtifactCatalog): CompiledModuleHttpDependencies {
  return {
    generateId: () => "not-used",
    hasSession: () => false,
    createSession: () => { throw new Error("not reached"); },
    registerSession: () => { throw new Error("not reached"); },
    persistSession: () => { throw new Error("not reached"); },
    catalog,
    authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: "operator:trusted", role: "operator" } }),
  };
}

describe("compiled module HTTP automatic-resolution admission", () => {
  it("does not report or persist initial manual hints as automatic progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-initial-manual-no-progress-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "initial-manual-no-progress");
      const question = prepared.artifact.payload.preparedQueue.questions.find((entry) => entry.kind === "scene_role" && entry.status === "open");
      if (!question) throw new Error("scene-role question missing");
      const explicitHints = {
        schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
        moduleId: prepared.artifact.payload.preparedQueue.moduleId,
        documentHash: prepared.artifact.payload.preparedQueue.documentHash,
        sourceGraphIdentity: prepared.artifact.payload.preparedQueue.sourceGraphIdentity,
        resolutions: [{
          questionId: question.id,
          kind: question.kind,
          value: { role: "playable_scene" },
          sourceStatementIds: [...question.sourceStatementIds],
          evidenceRefs: [...question.evidenceRefs],
          authority: "user_document",
          derivation: "explicit",
          reviewerKind: "human",
          rightsStatus: "user_provided",
          reason: "trusted reviewer supplies one initial answer",
        }],
      };
      const response = await handleCompiledModuleHttpRequest(
        request(prepared, { explicitHints }),
        dependencies(catalog, new ImmediateFakeLLM(), admission(root).controller, "operator:initial-manual-no-progress"),
      );

      expect(response?.status).toBe(200);
      const body = await response?.json() as { progress?: unknown; continuationId?: unknown };
      expect(body.progress).toBe(false);
      expect(body.continuationId).toBeUndefined();
      expect(existsSync(join(root, "continuations"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("server-owned automatic policy enables source-exact encounters and rejects body capability overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-server-policy-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "server-source-exact-npc", ["Dock:\nMira attacks the investigators. HP 2. Dodge 30. Fight 40. Damage 1d2.\nExit:"]);
      const llm = new ImmediateFakeLLM();
      const authenticate = () => ({ status: "authenticated" as const, principal: { id: "operator:server-policy", role: "operator" as const } });
      const queue = prepared.artifact.payload.preparedQueue;
      const trustedEnvelope = buildCompilerHintProposalRequestEnvelope(
        prepared.artifact.payload.graph,
        queue,
        SERVER_AUTO_COMPILER_POLICY,
      );
      expect(trustedEnvelope.schemaVersion).toBe("1.9.0");
      const sceneRole = queue.questions.find((question) => question.kind === "scene_role" && question.status === "open")!;
      const explicitHints = {
        schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION,
        moduleId: queue.moduleId,
        documentHash: queue.documentHash,
        sourceGraphIdentity: queue.sourceGraphIdentity,
        resolutions: [{
          questionId: sceneRole.id,
          kind: "scene_role",
          value: { role: "playable_scene" },
          sourceStatementIds: [...sceneRole.sourceStatementIds],
          evidenceRefs: [...sceneRole.evidenceRefs],
          authority: "user_document",
          derivation: "explicit",
          reviewerKind: "human",
          rightsStatus: "user_provided",
          reason: "trusted test reviewer marks the direct NPC location playable",
      }],
      };
      const controller = admission(root).controller;
      const configured = await handleRequest(
        request(prepared, { explicitHints }),
        catalog,
        undefined,
        {},
        {},
        { llm, isLlmEnabled: () => true, admission: controller },
        authenticate,
      );
      expect(configured.status).toBe(200);
      const encounterRequest = llm.calls
        .map((call) => call.messages[1]?.content ?? "")
        .map((content) => JSON.parse(content.slice(content.lastIndexOf("REQUEST ENVELOPE:\n") + "REQUEST ENVELOPE:\n".length)) as {
          schemaVersion?: unknown;
          questions: Array<{ kind: string; candidateDomains: { allowedNpcEncounterProfiles?: unknown[] } }>;
        })
        .find((envelope) => envelope.questions.some((question) => question.kind === "npc_binding"));
      const npcRequest = encounterRequest?.questions.find((question) => question.kind === "npc_binding");
      expect(Object.hasOwn(encounterRequest ?? {}, "schemaVersion")).toBe(false);
      expect(encounterRequest?.schemaVersion).toBeUndefined();
      expect(npcRequest?.candidateDomains.allowedNpcEncounterProfiles).toHaveLength(1);
      const callsBeforeBodyOverride = llm.calls.length;
      const bodyOverride = await handleRequest(
        request(prepared, { allowSourceExactNpcEncounters: false }),
        catalog,
        undefined,
        {},
        {},
        { llm, isLlmEnabled: () => true, admission: controller },
        authenticate,
      );
      expect(SERVER_AUTO_COMPILER_POLICY).toEqual({
        policyId: "server-auto-compiler-user-provided-v1",
        rightsStatus: "user_provided",
        allowSourceExactNpcEncounters: true,
        allowedSourceFactMechanicKinds: ["existing_clue_discovery", "prose_fact_finding"],
      });
      expect(Object.isFrozen(SERVER_AUTO_COMPILER_POLICY.allowedSourceFactMechanicKinds)).toBe(true);
      expect(() => (SERVER_AUTO_COMPILER_POLICY.allowedSourceFactMechanicKinds as unknown as string[]).push("scene_state_transition")).toThrow(TypeError);
      expect(SERVER_AUTO_COMPILER_POLICY.allowedSourceFactMechanicKinds).toEqual(["existing_clue_discovery", "prose_fact_finding"]);
      expect(bodyOverride.status).toBe(400);
      expect(llm.calls).toHaveLength(callsBeforeBodyOverride);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses two server-owned auto rounds for prose-finding ID-only proposals and rejects body policy injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-server-prose-finding-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "server-prose-finding", ["Archive:\nThe camera is old. \u6210\u529f\u7684\u77e5\u8bc6\u9274\u5b9a\u540e\uff0c\u8c03\u67e5\u5458\u53ef\u4ee5\u91cd\u64ad\u6574\u4e2a\u4eea\u5f0f\u7684\u5f55\u50cf\u3002 The monitor is dark.\nExit:"]);
      const { preparedQueue: queue } = prepared.artifact.payload;
      const parent = queue.questions.find((question) => question.kind === "source_fact_disposition" && question.sourceFactChildQuestionId);
      if (!parent) throw new Error("prose finding disposition question missing");
      const child = queue.questions.find((question) => question.id === parent.sourceFactChildQuestionId);
      if (!child?.allowedProseFactFindingCandidates?.length || !child.allowedSourceFactAtoms?.length) {
        throw new Error("prose finding child candidates missing");
      }
      const sceneRole = queue.questions.find((question) => question.kind === "scene_role" && question.subjectCandidateId === child.owningSceneCandidateId);
      if (!sceneRole) throw new Error("prose finding owning scene question missing");
      const llm = new ProseFactFindingFakeLLM();
      const controller = admission(root).controller;
      const authenticate = () => ({ status: "authenticated" as const, principal: { id: "operator:server-prose-finding", role: "operator" as const } });
      const resolved = await handleRequest(
        request(prepared),
        catalog,
        undefined,
        {},
        {},
        { llm, isLlmEnabled: () => true, admission: controller },
        authenticate,
      );
      expect(resolved.status).toBe(200);
      const body = await resolved.json() as {
        continuationId?: string;
        rounds: Array<{ askedQuestionIds: string[]; acceptedQuestionIds: string[] }>;
      };
      expect(body.rounds).toHaveLength(2);
      expect(body.rounds[0]?.acceptedQuestionIds).toEqual(expect.arrayContaining([parent.id, sceneRole.id]));
      expect(body.rounds[1]?.askedQuestionIds).toContain(child.id);
      const proseRequest = llm.calls
        .map((call) => proposalRequestEnvelope(call.messages).questions)
        .flat()
        .find((question) => question.questionId === child.id)!;
      expect(llm.calls.findIndex((call) => proposalRequestEnvelope(call.messages).questions.some((question) => question.questionId === child.id))).toBeGreaterThan(0);
      const finding = child.allowedProseFactFindingCandidates[0]!;
      expect(proseRequest.candidateDomains.allowedSourceFactMechanicKinds).toEqual(["existing_clue_discovery", "prose_fact_finding"]);
      expect(proseRequest.candidateDomains.allowedSourceFactMechanicKinds).not.toContain("scene_state_transition");
      expect(proseRequest.candidateDomains.allowedProseFactFindingCandidates).toEqual([{
        candidateId: finding.id,
        atomId: finding.atomId,
        quote: finding.quote,
        check: finding.check,
      }]);
      expect(proseRequest.candidateDomains.allowedSourceFactAtoms).toHaveLength(child.allowedSourceFactAtoms.length);
      expect(proseRequest.prompt).toContain("findingCandidateIds");
      expect(proseRequest.prompt).toContain("citations must be []");

      expect(body.continuationId).toBeDefined();
      const continuation = catalog.loadAutoResolveContinuation(body.continuationId!);
      if (continuation.status !== "ok") throw new Error(continuation.message);
      expect(continuation.value.hints.resolutions.find((resolution) => resolution.questionId === child.id)).toMatchObject({
        value: {
          findingCandidateIds: [finding.id],
          sourceOnlyAtomIds: child.allowedSourceFactAtoms.filter((atom) => atom.id !== finding.atomId).map((atom) => atom.id),
        },
        audit: { citations: [{ claimKey: `source_fact_mechanic:${parent.subjectStatementId}:${finding.id}:finding`, quote: finding.quote }] },
      });

      const callsBeforeInjection = llm.calls.length;
      const bodyInjection = await handleRequest(
        request(prepared, { allowedSourceFactMechanicKinds: ["scene_state_transition"] }),
        catalog,
        undefined,
        {},
        {},
        { llm, isLlmEnabled: () => true, admission: controller },
        authenticate,
      );
      expect(bodyInjection.status).toBe(400);
      expect(llm.calls).toHaveLength(callsBeforeInjection);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("shares an explicit durable controller across handleRequest calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-server-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const firstPrepared = await storePrepared(catalog, "admission-server-first");
      const secondPrepared = await storePrepared(catalog, "admission-server-second");
      const firstLlm = new DeferredFakeLLM();
      const secondLlm = new ImmediateFakeLLM();
      const { controller } = admission(root);
      const authenticate = () => ({ status: "authenticated" as const, principal: { id: "operator:server-shared", role: "operator" as const } });
      const first = handleRequest(request(firstPrepared), catalog, undefined, {}, {}, { llm: firstLlm, isLlmEnabled: () => true, admission: controller }, authenticate);
      await firstLlm.waitForFirstCall();

      const blocked = await handleRequest(request(secondPrepared), catalog, undefined, {}, {}, { llm: secondLlm, isLlmEnabled: () => true, admission: controller }, authenticate);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBe("1");
      expect(await blocked.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_BUSY" } });
      expect(secondLlm.calls).toEqual([]);

      firstLlm.resolve();
      expect((await first).status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("blocks a second artifact for one principal without calling its model, then releases after a model failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-http-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const firstPrepared = await storePrepared(catalog, "admission-principal-first");
      const secondPrepared = await storePrepared(catalog, "admission-principal-second");
      const { controller } = admission(root);
      const firstLlm = new DeferredFakeLLM();
      const secondLlm = new DeferredFakeLLM();
      const first = handleCompiledModuleHttpRequest(request(firstPrepared), dependencies(catalog, firstLlm, controller, "operator:one"));
      await firstLlm.waitForFirstCall();

      const blocked = await handleCompiledModuleHttpRequest(request(secondPrepared), dependencies(catalog, secondLlm, controller, "operator:one"));
      expect(blocked?.status).toBe(429);
      expect(blocked?.headers.get("Retry-After")).toBe("1");
      expect(await blocked?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_BUSY" } });
      expect(secondLlm.calls).toEqual([]);

      firstLlm.reject();
      expect((await first)?.status).toBe(200);
      const retryLlm = new DeferredFakeLLM();
      const retry = handleCompiledModuleHttpRequest(request(secondPrepared), dependencies(catalog, retryLlm, controller, "operator:one"));
      await retryLlm.waitForFirstCall();
      retryLlm.resolve();
      expect((await retry)?.status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("single-flights a prepared artifact across principals and separately enforces the global cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-http-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const firstPrepared = await storePrepared(catalog, "admission-artifact-first");
      const secondPrepared = await storePrepared(catalog, "admission-artifact-second");
      const thirdPrepared = await storePrepared(catalog, "admission-artifact-third");
      const { controller } = admission(root);
      const one = new DeferredFakeLLM();
      const sameArtifact = new DeferredFakeLLM();
      const first = handleCompiledModuleHttpRequest(request(firstPrepared), dependencies(catalog, one, controller, "operator:one"));
      await one.waitForFirstCall();
      const blockedArtifact = await handleCompiledModuleHttpRequest(request(firstPrepared), dependencies(catalog, sameArtifact, controller, "operator:two"));
      expect(blockedArtifact?.status).toBe(429);
      expect(await blockedArtifact?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_BUSY" } });
      expect(sameArtifact.calls).toEqual([]);

      const two = new DeferredFakeLLM();
      const second = handleCompiledModuleHttpRequest(request(secondPrepared), dependencies(catalog, two, controller, "operator:two"));
      await two.waitForFirstCall();
      const blockedGlobal = await handleCompiledModuleHttpRequest(request(thirdPrepared), dependencies(catalog, new DeferredFakeLLM(), controller, "operator:three"));
      expect(blockedGlobal?.status).toBe(429);
      expect(await blockedGlobal?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_BUSY" } });

      one.resolve();
      two.resolve();
      expect((await first)?.status).toBe(200);
      expect((await second)?.status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not charge malformed, stale, or forged requests; headers and bodies cannot bypass the trusted principal window", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-http-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "admission-window");
      const clock = admission(root, { startsPerPrincipal: 1 });
      const llm = new DeferredFakeLLM();
      const trusted = dependencies(catalog, llm, clock.controller, "operator:trusted");

      const malformed = await handleCompiledModuleHttpRequest(request(prepared, { limits: { startsPerPrincipal: 999 } }), trusted);
      expect(malformed?.status).toBe(400);
      const stale = await handleCompiledModuleHttpRequest(request(prepared, { preparedQueueHash: "stale" }), trusted);
      expect(stale?.status).toBe(409);
      const missingContinuation = await handleCompiledModuleHttpRequest(request(prepared, { autoContinuationId: "aaaaaaaaaaaaaaaaaaaaaaaa" }), trusted);
      expect(missingContinuation?.status).toBe(404);
      expect(llm.calls).toEqual([]);

      const first = handleCompiledModuleHttpRequest(request(prepared), trusted);
      await llm.waitForFirstCall();
      llm.resolve();
      expect((await first)?.status).toBe(200);

      const forgedBody = await handleCompiledModuleHttpRequest(request(prepared, { principal: "operator:other" }), trusted);
      expect(forgedBody?.status).toBe(400);
      const limited = await handleCompiledModuleHttpRequest(request(prepared, {}, { "X-Compiler-Principal": "operator:other" }), trusted);
      expect(limited?.status).toBe(429);
      expect(limited?.headers.get("Retry-After")).toMatch(/^\d+$/);
      expect(await limited?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_RATE_LIMITED" } });

      clock.advance(60_000);
      const recovered = await handleCompiledModuleHttpRequest(request(prepared), trusted);
      expect(recovered?.status).toBe(200);
      expect(llm.calls.length).toBeGreaterThan(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ends a delayed automatic job at its whole-job deadline and never returns a late result", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-deadline-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "admission-deadline");
      const controller = new CompilerAutoAdmissionController({
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
        // The missed-heartbeat and physical-TTL cases below cover lease expiry.
        // This test isolates the whole-job deadline, so its physical lease must
        // remain valid even if a busy event loop delays the timeout callback.
        leaseTtlMs: 10_000,
        wholeJobDeadlineMs: 2_000,
      });
      const llm = new DeferredFakeLLM();
      const pending = handleCompiledModuleHttpRequest(request(prepared), dependencies(catalog, llm, controller, "operator:deadline"));
      try {
        await llm.waitForFirstCall(4_000);
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let response: Response | null | undefined;
        try {
          response = await Promise.race([
            pending,
            new Promise<Response | undefined>((resolve) => {
              deadlineTimer = setTimeout(() => resolve(undefined), 4_000);
            }),
          ]);
        } finally {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        }
        expect(response?.status).toBe(503);
        expect(response?.headers.get("Retry-After")).toBe("1");
        expect(await response?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_DEADLINE_EXCEEDED" } });
        expect(controller.acquire({ principalFingerprint: "b".repeat(64), preparedArtifactId: "second-still-blocked" })).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY" });
      } finally {
        llm.resolve();
        await pending;
      }
      const afterDrain = await waitForAdmissionDrain(controller, { principalFingerprint: "b".repeat(64), preparedArtifactId: "second-after-settle" });
      expect(afterDrain.status).toBe("acquired");
      afterDrain.release();
      expect(existsSync(join(root, "continuations"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("cooperatively aborts a deadline-expired multi-round job before it can issue another model request", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-abort-rounds-"));
    vi.useFakeTimers({ now: 0 });
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "admission-abort-rounds");
      const controller = new CompilerAutoAdmissionController({
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
        leaseTtlMs: 100,
        wholeJobDeadlineMs: 20,
        hardDrainMs: 100,
      });
      const llm = new LateProseFirstRoundLLM();
      const deps = dependencies(catalog, llm, controller, "operator:abort-rounds");
      if (!deps.autoCompiler) throw new Error("expected automatic compiler dependency");
      deps.autoCompiler.maxProposalRounds = 2;
      deps.autoCompiler.limits = { ...deps.autoCompiler.limits, maxQuestionsPerRequest: 1 };
      const pending = handleCompiledModuleHttpRequest(request(prepared), deps);
      await llm.waitForFirstCall();
      vi.advanceTimersByTime(20);
      const response = await pending;
      expect(response?.status).toBe(503);
      expect(llm.calls[0]?.options?.signal?.aborted).toBe(true);

      // The late first response is otherwise valid and would leave pending
      // questions for round two. The abort boundary must discard it before a
      // second model request is scheduled.
      await llm.resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
      expect(llm.calls).toHaveLength(1);
      expect(existsSync(join(root, "continuations"))).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards deadline cancellation to an abort-aware model call and drains its lease once it settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-abort-aware-"));
    vi.useFakeTimers({ now: 0 });
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "admission-abort-aware");
      const controller = new CompilerAutoAdmissionController({
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
        leaseTtlMs: 100,
        wholeJobDeadlineMs: 20,
        hardDrainMs: 100,
      });
      const llm = new AbortAwareDeferredLLM();
      const pending = handleCompiledModuleHttpRequest(request(prepared), dependencies(catalog, llm, controller, "operator:abort-aware"));
      await llm.waitForFirstCall();
      vi.advanceTimersByTime(20);
      expect((await pending)?.status).toBe(503);
      expect(llm.calls).toHaveLength(1);
      expect(llm.calls[0]?.options?.signal?.aborted).toBe(true);
      // Keep the coordinator clock at the fake epoch until the abort-aware
      // provider has settled. Switching Date.now() to wall-clock time in this
      // gap would manufacture an expiry and exercise reclaim quarantine rather
      // than the cooperative-abort path being tested.
      let afterAbort: ReturnType<CompilerAutoAdmissionController["acquire"]> | undefined;
      for (let turn = 0; turn < 20; turn++) {
        afterAbort = controller.acquire({ principalFingerprint: "b".repeat(64), preparedArtifactId: "after-abort-drain" });
        if (afterAbort.status === "acquired") break;
        await Promise.resolve();
      }
      expect(afterAbort).toMatchObject({ status: "acquired" });
      if (afterAbort?.status === "acquired") afterAbort.release();
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines a never-settling unabortable deadline drain instead of reopening the physical model slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-hard-drain-"));
    const llm = new DeferredFakeLLM();
    let pending: Promise<Response | null> | undefined;
    vi.useFakeTimers({ now: 0 });
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "admission-hard-drain");
      const config = {
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
        leaseTtlMs: 100,
        wholeJobDeadlineMs: 20,
        hardDrainMs: 30,
      } satisfies CompilerAutoAdmissionConfig;
      const controller = new CompilerAutoAdmissionController(config);
      pending = handleCompiledModuleHttpRequest(request(prepared), dependencies(catalog, llm, controller, "operator:hard-drain"));
      await llm.waitForFirstCall();
      vi.advanceTimersByTime(20);
      expect((await pending)?.status).toBe(503);

      vi.advanceTimersByTime(30);
      const restarted = new CompilerAutoAdmissionController(config);
      expect(restarted.acquire({ principalFingerprint: "b".repeat(64), preparedArtifactId: "must-not-oversubscribe" })).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_UNHEALTHY" });

      llm.resolve();
      let afterSettle: ReturnType<CompilerAutoAdmissionController["acquire"]> | undefined;
      for (let turn = 0; turn < 20; turn++) {
        afterSettle = controller.acquire({ principalFingerprint: "b".repeat(64), preparedArtifactId: "after-unabortable-settles" });
        if (afterSettle.status === "acquired") break;
        await Promise.resolve();
      }
      if (!afterSettle) throw new Error("expected a post-drain admission attempt");
      expect(afterSettle.status).toBe("acquired");
      if (afterSettle.status === "acquired") afterSettle.release();
    } finally {
      try { llm.resolve(); } catch { /* already settled in the assertion path */ }
      vi.useRealTimers();
      if (pending) await pending;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renews the drain lease before exposing a deadline response when a missed heartbeat crosses its physical TTL", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-deadline-handoff-"));
    let now = 1_000;
    const llm = new DeferredFakeLLM();
    let pending: Promise<Response | null> | undefined;
    let challenger: ReturnType<CompilerAutoAdmissionController["acquire"]> | undefined;
    vi.useFakeTimers({ now: 0 });
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "admission-deadline-handoff");
      const controller = new CompilerAutoAdmissionController({
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
        leaseTtlMs: 100,
        wholeJobDeadlineMs: 10,
        now: () => now,
      });
      pending = handleCompiledModuleHttpRequest(request(prepared), dependencies(catalog, llm, controller, "operator:deadline-handoff"));
      await llm.waitForFirstCall();

      // Do not deliver the 50ms heartbeat. Move only the coordination clock
      // past the 100ms TTL, then deliver the already-scheduled 10ms deadline
      // callback. The deadline path must fail closed rather than revive a
      // physically expired slot.
      now = 1_110;
      vi.advanceTimersByTime(10);
      const response = await pending;
      expect(response?.status).toBe(503);
      challenger = controller.acquire({ principalFingerprint: "b".repeat(64), preparedArtifactId: "second-deadline-handoff" });
      expect(challenger).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_UNHEALTHY" });
    } finally {
      if (challenger?.status === "acquired") challenger.release();
      llm.resolve();
      vi.useRealTimers();
      if (pending) await pending;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines an expired physical slot before a replacement can start, then admits only after the old call settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-reclaimed-renewal-"));
    const oldLlm = new DeferredFakeLLM();
    const newLlm = new DeferredFakeLLM();
    let oldPending: Promise<Response | null> | undefined;
    let newPending: Promise<Response | null> | undefined;
    try {
      let now = 1_000;
      const config = {
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
        leaseTtlMs: 100,
        wholeJobDeadlineMs: 2_000,
        hardDrainMs: 300,
        now: () => now,
      } satisfies CompilerAutoAdmissionConfig;
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "admission-reclaimed-renewal");
      const oldController = new CompilerAutoAdmissionController(config);
      const replacementController = new CompilerAutoAdmissionController(config);
      oldPending = handleCompiledModuleHttpRequest(request(prepared), dependencies(catalog, oldLlm, oldController, "operator:old-reclaimed"));
      await oldLlm.waitForFirstCall();

      // The old model call is deliberately unresolved. A replacement process
      // sees expiry, but may not delete-and-insert in the same transaction:
      // that would start B while the real A provider call is still running.
      now += 101;
      newPending = handleCompiledModuleHttpRequest(request(prepared), dependencies(catalog, newLlm, replacementController, "operator:new-reclaimed"));
      const blocked = await newPending;
      expect(blocked?.status).toBe(503);
      expect(await blocked?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_UNHEALTHY" } });
      expect(newLlm.calls).toEqual([]);

      let expiry: ReturnType<typeof setTimeout> | undefined;
      const oldResponse = await Promise.race([
        oldPending,
        new Promise<never>((_resolve, reject) => { expiry = setTimeout(() => reject(new Error("old reclaimed lease was not aborted before its whole-job deadline")), 750); }),
      ]);
      if (expiry !== undefined) clearTimeout(expiry);
      expect(oldResponse?.status).toBe(503);
      expect(await oldResponse?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_LEASE_EXPIRED" } });
      expect(oldLlm.calls[0]?.options?.signal?.aborted).toBe(true);

      // Abort alone is insufficient: while this fake provider ignores it the
      // durable reclaim quarantine continues to prevent all replacement work.
      const isolated = new CompilerAutoAdmissionController(config).acquire({ principalFingerprint: "c".repeat(64), preparedArtifactId: "third-must-not-start" });
      expect(isolated).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_UNHEALTHY" });
      expect(existsSync(join(root, "continuations"))).toBe(false);

      oldLlm.resolve();
      const settled = await waitForAdmissionDrain(replacementController, {
        principalFingerprint: "d".repeat(64),
        preparedArtifactId: "old-provider-settled",
      });
      settled.release();
      const replacement = handleCompiledModuleHttpRequest(request(prepared), dependencies(catalog, newLlm, replacementController, "operator:new-reclaimed"));
      await newLlm.waitForFirstCall();
      newLlm.resolve();
      expect((await replacement)?.status).toBe(200);
    } finally {
      try { oldLlm.resolve(); } catch { /* already settled */ }
      try { newLlm.resolve(); } catch { /* already settled */ }
      if (oldPending) await oldPending;
      if (newPending) await newPending;
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("checks the durable fence before continuation persistence so a reclaimed old owner cannot publish", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-fence-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "admission-fence", ["Archive:\nThe camera is old. 成功的知识鉴定后，调查员可以重播整个仪式的录像。 The monitor is dark.\nExit:"]);
      let now = 1_000;
      const config = {
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
        leaseTtlMs: 10,
        wholeJobDeadlineMs: 100,
        now: () => now,
      } satisfies CompilerAutoAdmissionConfig;
      const oldOwner = new CompilerAutoAdmissionController(config);
      const replacementOwner = new CompilerAutoAdmissionController(config);
      const inner = new ProseFactFindingFakeLLM();
      let replacement: ReturnType<CompilerAutoAdmissionController["acquire"]> | undefined;
      const llm: LLMLike = {
        async chat(messages, options) {
          if (!replacement) {
            now += 11;
            replacement = replacementOwner.acquire({ principalFingerprint: "b".repeat(64), preparedArtifactId: prepared.id });
          }
          return inner.chat(messages, options);
        },
      };
      const response = await handleCompiledModuleHttpRequest(request(prepared), dependencies(catalog, llm, oldOwner, "operator:old-owner"));
      expect(response?.status).toBe(503);
      expect(response?.headers.get("Retry-After")).toBe("1");
      expect(await response?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_LEASE_EXPIRED" } });
      expect(replacement).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_UNHEALTHY" });
      expect(existsSync(join(root, "continuations"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds the admission fence across synchronous continuation publication, so a contender cannot reclaim in its middle", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-atomic-fence-"));
    try {
      let now = 1_000;
      const config = {
        root,
        globalConcurrent: 1,
        perPrincipalConcurrent: 1,
        startsPerPrincipal: 4,
        windowMs: 60_000,
        maxTrackedPrincipals: 8,
        leaseTtlMs: 10,
        // Publication starts while the absolute deadline is still valid; the
        // synchronous catalog commit itself crosses it. That critical section
        // must finish and return its real result rather than creating an
        // HTTP-invisible continuation that cannot be rolled back.
        wholeJobDeadlineMs: 10,
        now: () => now,
      } satisfies CompilerAutoAdmissionConfig;
      const owner = new CompilerAutoAdmissionController(config);
      const contender = new CompilerAutoAdmissionController(config);
      let contenderResult: ReturnType<CompilerAutoAdmissionController["acquire"]> | undefined;
      const catalog = new CompilerArtifactCatalog({
        root,
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish(temp, target) {
            if (target.includes("continuations")) {
              now += 11;
              contenderResult = contender.acquire({ principalFingerprint: "b".repeat(64), preparedArtifactId: "competing-artifact" });
            }
            compilerArtifactCatalogNodeFileOps.publish(temp, target);
          },
        },
      });
      const prepared = await storePrepared(catalog, "admission-atomic-fence", ["Archive:\nThe camera is old. 成功的知识鉴定后，调查员可以重播整个仪式的录像。 The monitor is dark.\nExit:"]);
      const response = await handleCompiledModuleHttpRequest(request(prepared), dependencies(catalog, new ProseFactFindingFakeLLM(), owner, "operator:atomic-owner"));
      expect(response?.status).toBe(200);
      expect(now).toBeGreaterThan(1_010);
      expect(contenderResult).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY" });
      expect(existsSync(join(root, "continuations"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps durable capacity, policy, and storage failures to stable safe admission responses", async () => {
    const capacityRoot = mkdtempSync(join(tmpdir(), "compiler-auto-admission-capacity-"));
    const policyRoot = mkdtempSync(join(tmpdir(), "compiler-auto-admission-policy-"));
    const storageRoot = mkdtempSync(join(tmpdir(), "compiler-auto-admission-storage-"));
    try {
      const capacityCatalog = new CompilerArtifactCatalog({ root: capacityRoot });
      const capacityPrepared = await storePrepared(capacityCatalog, "admission-capacity");
      const capacity = admission(capacityRoot, { maxTrackedPrincipals: 1 });
      expect((await handleCompiledModuleHttpRequest(request(capacityPrepared), dependencies(capacityCatalog, new ImmediateFakeLLM(), capacity.controller, "operator:capacity-a")))?.status).toBe(200);
      const capacityResponse = await handleCompiledModuleHttpRequest(request(capacityPrepared), dependencies(capacityCatalog, new ImmediateFakeLLM(), capacity.controller, "operator:capacity-b"));
      expect(capacityResponse?.status).toBe(429);
      expect(capacityResponse?.headers.get("Retry-After")).toBe("60");
      expect(await capacityResponse?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_CAPACITY_EXHAUSTED", message: "automatic compiler resolution is currently busy" } });

      const policyCatalog = new CompilerArtifactCatalog({ root: policyRoot });
      const policyPrepared = await storePrepared(policyCatalog, "admission-policy");
      const baseline = admission(policyRoot);
      const seed = baseline.controller.acquire({ principalFingerprint: "a".repeat(64), preparedArtifactId: policyPrepared.id });
      if (seed.status === "acquired") seed.release();
      const mismatch = admission(policyRoot, { globalConcurrent: 3 });
      const policyResponse = await handleCompiledModuleHttpRequest(request(policyPrepared), dependencies(policyCatalog, new ImmediateFakeLLM(), mismatch.controller, "operator:policy"));
      expect(policyResponse?.status).toBe(503);
      expect(policyResponse?.headers.get("Retry-After")).toBe("60");
      expect(await policyResponse?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_POLICY_MISMATCH", message: "automatic compiler admission is unavailable" } });

      const storageCatalog = new CompilerArtifactCatalog({ root: storageRoot });
      const storagePrepared = await storePrepared(storageCatalog, "admission-storage");
      const unavailable = admission(join(storageRoot, "missing-admission-root"));
      const storageResponse = await handleCompiledModuleHttpRequest(request(storagePrepared), dependencies(storageCatalog, new ImmediateFakeLLM(), unavailable.controller, "operator:storage"));
      expect(storageResponse?.status).toBe(503);
      expect(storageResponse?.headers.get("Retry-After")).toBe("60");
      expect(await storageResponse?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_STORAGE_UNAVAILABLE", message: "automatic compiler admission is unavailable" } });
    } finally {
      rmSync(capacityRoot, { recursive: true, force: true });
      rmSync(policyRoot, { recursive: true, force: true });
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("keeps disabled automatic compilation at 503 before any model admission work", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-admission-http-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = await storePrepared(catalog, "admission-disabled");
      const response = await handleCompiledModuleHttpRequest(request(prepared), unavailableDependencies(catalog));
      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({ error: { code: "AUTO_COMPILER_UNAVAILABLE" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
