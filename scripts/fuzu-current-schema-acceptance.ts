/**
 * Internal, opt-in current-schema acceptance for the specifically supplied
 * Fuzu PDF. This is neither a public compile entrypoint nor an artifact
 * migrator: it applies the tracked compact reviewed answers only to the
 * freshly prepared PDF queue and revalidates them through normal resolution.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { handleCompiledModuleHttpRequest, type CompiledModuleHttpDependencies } from "../src/api/compiled-module-http";
import { CompiledSessionSnapshotStore, type CompiledSessionSnapshot } from "../src/api/compiled-session-snapshot";
import { ordinaryGameSessionSnapshotHash, type OrdinarySnapshotJson } from "../src/api/ordinary-game-session-snapshot";
import { CompilerAutoAdmissionController } from "../src/api/compiler-auto-admission";
import { requestCompilerHintProposals } from "../src/api/compiler-hint-proposal-adapter";
import type { GameSession } from "../src/api/game-session";
import { CompilerArtifactCatalog } from "../src/compiler/compiler-artifact-catalog";
import {
  restoreCompilerArtifact,
  type CompilerArtifactEnvelope,
  type PreparedCompilerArtifactPayload,
  type ResolvedCompilerArtifactPayload,
} from "../src/compiler/compiler-artifact";
import { projectResolvedCompilerArtifact, type CompilerModuleDataProjection, type ModuleDataPresentationMetadata } from "../src/compiler/compiler-module-data-projection";
import { resolveCompiler, type PreparedCompilerApiResult } from "../src/compiler/compiler-api";
import { applyModuleCompileHints } from "../src/compiler/compile-hint-resolution";
import { materializeFuzuReviewedHints, readFuzuReviewedAnswersFixture } from "./fuzu-reviewed-answers";
import {
  countOpenCompilerQuestions,
  createFuzuAcceptanceAutoAdmission,
} from "./fuzu-current-schema-acceptance-support";
import {
  type CompilerQuestion,
  type ModuleCompileHints,
} from "../src/compiler/compiler-question-queue";
import { summarizeCompilerRuntimeQuality } from "../src/compiler/compiler-runtime-quality";
import { replayMechanicsWitness, type MechanicsWitness } from "../src/compiler/mechanics-reachability";
import { sha256 } from "../src/ingest/document-ir";
import type { ChatOptions, LLMLike, Message } from "../src/llm/client";

const EXPECTED_PDF_BYTES = 1_751_612;
const EXPECTED_DOCUMENT_HASH = "a774a2478962db7964b10e777a91cb8834a66020be29769493e52b94001235b5";
const EXPECTED_PDF_HEADER = "%PDF-1.7";
const EXPECTED_ENDINGS = ["escape_with_dream_stone", "lost_without_dream_stone"] as const;
const AUTO_CONTINUATION_REQUEST_LIMIT = 4;
const EXPECTED_AUTO_CONTINUATION_REQUESTS = 3;
const EXPECTED_AUTO_MODEL_CALLS = 46;
const BASE_PREPARED_QUESTION_COUNT = 192;
const CURRENT_CLUE_FACT_FACET_QUESTION_COUNT = 3;
const CURRENT_PREPARED_QUESTION_COUNT = BASE_PREPARED_QUESTION_COUNT + CURRENT_CLUE_FACT_FACET_QUESTION_COUNT;
const SERVER_AUTO_LIMITS = { maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxRequestChars: 24_000, maxResponseTokens: 2_400 } as const;
const SOURCE_PROSE_LEAK_MIN_CHARS = 32;
const FUZU_COURTYARD_HEADING = "中庭";
const FUZU_RANDY_NAME_QUOTE = "兰迪.帕蒂拉";
const FUZU_RANDY_PRESENCE_QUOTE = "你认出茧中的人就是兰迪.帕蒂拉";
const FUZU_DOCTOR_HEADING = "\u5c4b\u5b50\u91cc\u7684\u533b\u751f";
const FUZU_DOCTOR_SCENE_ID = "draft_scene_b433990d0b1ac5fd8cb822b9";
const FUZU_DOCTOR_HEADING_STATEMENT_ID = "block_8f057e49a416e88cc58d47ba:statement:whole";
const FUZU_DOCTOR_PARAGRAPH_STATEMENT_ID = "block_87ee29caf8dbfba1d816dfc4:statement:whole";
const FUZU_SUSAN_NAME_QUOTE = "\u82cf\u73ca.\u827e\u5f53\u65af\u533b\u751f";
const FUZU_SUSAN_DIALOGUE_FACT = "\u5982\u679c\u4ed6\u4eec\u95ee\u8d77\uff0c\u5979\u4f1a\u544a\u8bc9\u8c03\u67e5\u5458\u8fd9\u4f3c\u4e4e\u662f\u7531\u67d0\u4e9b\u5947\u7279\u7684\u5feb\u901f\u751f\u957f\u7684\u5bc4\u751f\u866b\u611f\u67d3\u9020\u6210\uff0c\u5979\u53ea\u80fd\u81ea\u5df1\u628a\u5bc4\u751f\u866b\u6458\u9664\u3002";
const FUZU_DOCTOR_ENTRY_SUPPORT = "\u5982\u679c\u8c03\u67e5\u5458\u8fdb\u5165 3~9 \u5c42\u7684\u4efb\u4f55\u4e00\u4e2a\u623f\u95f4";
const FUZU_LEAVE_HEADING = "\u8be5\u8d70\u4e86";
const FUZU_LEAVE_TO_DOCTOR_CONNECTION_ID = "leave_to_doctor";
const FUZU_FILM_HEADING = "\u7535\u5f71\u65f6\u95f4";
const FUZU_NIGHT_HEADING = "\u9ed1\u591c\u4e2d\u7684\u5c16\u53eb";
const FUZU_FILM_SAN_SOURCE = "\u89c2\u5f71\u5b8c\u6bd5\u4e4b\u540e\uff0c\u8c03\u67e5\u5458\u4eec\u9700\u8981\u6295\u7406\u667a\u9274\u5b9a\uff081 / 1d3\uff09";
const FUZU_FILM_TO_NIGHT_CONNECTION_ID = "film_to_night";
const FUZU_FILM_SANITY_EFFECT = {
  kind: "sanity_check",
  passLoss: { kind: "fixed", amount: 1 },
  failLoss: { kind: "dice", count: 1, sides: 3 },
} as const;

const FUZU_CORPSE_CLUE = "\u52b3\u4f26\u7684\u5c38\u4f53";
const FUZU_CIRCLE_CLUE = "\u5927\u5706\u73af";
const FUZU_AROUND_ROOM_CLUE = "\u5c4b\u5b50\u5468\u56f4";
const FUZU_MEDICINE_FRAGMENT = "\u533b\u5b66\u9274\u5b9a";
const FUZU_INSPIRATION_FRAGMENT = "\u7075\u611f\u9274\u5b9a";
const FUZU_DREAM_STONE_FRAGMENT = "\u68a6\u5883\u4e4b\u77f3";
const FUZU_FIND_LAUREN_ROOT_FRAGMENT = "\u5982\u679c\u8c03\u67e5\u5458\u4eec\u79bb\u5f00\u4ed6\u4eec\u7684\u623f\u95f4\u53bb\u8c03\u67e5\u5c16\u53eb\u58f0\u7684\u6e90\u5934";
const FUZU_CAMERA_KNOWLEDGE_FINDING_FRAGMENT = "\u6210\u529f\u7684\u77e5\u8bc6\u9274\u5b9a\u540e";

interface PreparedHttpResponse extends PreparedCompilerApiResult {
  preparedArtifactId: string;
}

export interface AcceptanceAggregate {
  acceptance: "fuzu-current-schema-internal";
  documentHash: string;
  artifactHash: string;
  pdf: { bytes: number; pages: number; hashSource: "pdf_bytes_sha256" };
  prepared: { sceneCandidates: number; clueCandidates: number; itemCandidates: number; proseNpcAnchors: number; rewardCandidates: number; questions: number; sourceFactMechanicChildren: number };
  rebinding: { reviewedHumanAnswers: number; addedCurrentHumanReviews: number; answeredQuestions: number; openQuestions: number; deferredQuestions: number };
  autoContinuation: {
    requests: number;
    modelCalls: number;
    answeredQuestions: number;
    openQuestions: number;
    notApplicableQuestions: number;
    contentReady: true;
    runtime: { discoveryMethods: number; runtimeItems: number; boundNpcs: number; dialogueMethods: number; runtimeRewards: number; reachableEndings: number };
  };
  resolution: { mechanicallyClosed: true; publishBlockingQuestions: number; reachableEndings: string[]; issueCount: number; reachableStateCount: number };
  quality: { dispositionReadiness: string; coverage: Record<string, number>; closedWorldIssueCounts: Record<string, number> };
  runtime: {
    replayedEndingWitnesses: number;
    gameSessions: Array<{
      ending: string;
      playerActions: number;
      ownedItemIds: string[];
      filmSanity: { settlementCount: 1; appliedLoss: number; beforeSAN: number; afterSAN: number };
    }>;
  };
}

/**
 * In-memory result of the opt-in current-PDF acceptance benchmark.
 *
 * The returned artifact and projection have passed this file's full
 * current-schema checks. They are not a published module or a durable
 * catalog entry: the temporary catalog is still removed before this returns.
 */
export interface CurrentFuzuAcceptanceResult {
  aggregate: AcceptanceAggregate;
  artifact: CompilerArtifactEnvelope;
  payload: ResolvedCompilerArtifactPayload;
  projection: CompilerModuleDataProjection;
}

/**
 * Script-internal positive checkpoint for a fresh Fuzu PDF.  It is available
 * only while this acceptance run owns its temporary catalog: callers must
 * finish their bounded check in the callback and cannot retain a catalog as a
 * published module.  The full acceptance below remains the no-callback path.
 */
export interface CurrentFuzuResolvedBenchmarkContext {
  catalog: CompilerArtifactCatalog;
  preparedArtifactId: string;
  preparedArtifact: CompilerArtifactEnvelope;
  prepared: PreparedCompilerArtifactPayload;
  initialResolvedArtifact: CompilerArtifactEnvelope;
  resolvedArtifact: CompilerArtifactEnvelope;
  payload: ResolvedCompilerArtifactPayload;
}

interface AutoPromptQuestion {
  questionId: string;
  kind: string;
  sourceStatements: Array<{ statementId: string; text: string }>;
  candidateDomains: {
    subjectCandidateId?: string;
    allowedLocationCandidateIds?: string[];
    allowedMechanicsTargetIds?: Record<string, string[]>;
    allowedClueFactAtoms?: Array<{ atomId: string; quote: string; statementId: string }>;
  };
}

function sourceFactMechanicChildQuestions(questions: readonly CompilerQuestion[]): CompilerQuestion[] {
  return questions.filter((question) => question.kind === "source_fact_mechanic");
}

function assertCurrentQuestionTotal(questions: readonly CompilerQuestion[], label: string): number {
  const childQuestions = sourceFactMechanicChildQuestions(questions);
  assertEqual(questions.length, CURRENT_PREPARED_QUESTION_COUNT + childQuestions.length, `${label} question count`);
  return childQuestions.length;
}

interface AutoPromptEnvelope {
  questions: AutoPromptQuestion[];
  candidateCatalog: Array<{ id: string; kind: string; label: string; sourceStatementId: string }>;
}

interface PublicAutoResolveResponse {
  status: string;
  preparedArtifactId: string;
  continuationId: string;
  resumed: boolean;
  progress: boolean;
  mechanics: { readiness: string };
  content: {
    dispositionReadiness: string;
    positiveCoverage: {
      positiveRootCount: number;
      uncoveredRootCount: number;
      sourceOnlyDecisionRootCount: number;
      sourceOnlyOnlyRootCount: number;
      acceptedBindingRootCount: number;
      mechanicsEvidenceRootCount: number;
    };
    openQuestionCount: number;
    openRootCount: number;
    unmodeledRootCount: number;
  };
  presentation: { readiness: string };
}

interface AutoDependencyConstruction {
  builds: number;
  admissions: Set<CompilerAutoAdmissionController>;
}

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) fail(label);
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) fail(label);
  return value;
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (!Object.is(actual, expected)) fail(`${label}: expected ${String(expected)}, received ${String(actual)}`);
}

function assertSameStrings(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(`${label}: values differ`);
  }
}

function parsePdfArgument(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--pdf" || !argv[1]?.trim()) {
    fail("usage: bun scripts/fuzu-current-schema-acceptance.ts --pdf <path>");
  }
  return resolve(argv[1]);
}

/** Child stdout/stderr are untrusted process output.  Retain enough evidence
 * to distinguish a protocol failure without reflecting model/source/secret
 * material into the acceptance error stream. */
function childOutputDiagnostic(stdout: string, stderr: string): string {
  const bytes = new TextEncoder();
  const stdoutBytes = bytes.encode(stdout);
  const stderrBytes = bytes.encode(stderr);
  return `stdout_bytes=${stdoutBytes.byteLength} stdout_sha256=${sha256(stdoutBytes)} stderr_bytes=${stderrBytes.byteLength} stderr_sha256=${sha256(stderrBytes)}`;
}

function autoPromptEnvelope(messages: readonly Message[]): AutoPromptEnvelope {
  const content = messages[1]?.content;
  const marker = "REQUEST ENVELOPE:\n";
  assert(typeof content === "string", "automatic compiler prompt must contain a user envelope");
  const offset = content.lastIndexOf(marker);
  assert(offset >= 0, "automatic compiler prompt must contain its request-envelope marker");
  return JSON.parse(content.slice(offset + marker.length)) as AutoPromptEnvelope;
}

function candidateForAutoQuestion(envelope: AutoPromptEnvelope, question: AutoPromptQuestion, expectedKind: string) {
  const candidateId = question.candidateDomains.subjectCandidateId;
  assert(typeof candidateId === "string" && candidateId.length > 0, `automatic ${question.kind} question must declare a subject candidate`);
  const candidate = envelope.candidateCatalog.find((entry) => entry.id === candidateId);
  assert(candidate !== undefined && candidate.kind === expectedKind, `automatic ${question.kind} candidate domain must be source-exact ${expectedKind}`);
  return candidate;
}

function citationForAutoQuestion(question: AutoPromptQuestion, claimKey: string, candidate?: { sourceStatementId: string; label: string }) {
  const source = candidate
    ? question.sourceStatements.find((statement) => statement.statementId === candidate.sourceStatementId)
    : question.sourceStatements[0];
  assert(source !== undefined, `automatic ${question.kind} citation must stay within its request evidence`);
  return { claimKey, statementId: source.statementId, quote: candidate ? candidate.label : source.text };
}

/**
 * This fake is deliberately a server-owned deterministic responder. Every
 * proposal is derived only from the current adapter request envelope and its
 * declared candidate domains; it never sees a hand-built graph or queue.
 */
class DeterministicFuzuAutoLLM implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];
  lastReply = "";

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    // The live automatic route forwards a cooperative AbortSignal. Signals
    // are intentionally not structured-cloneable; this deterministic test
    // responder records scalar request options while preserving the actual
    // call's cancellation capability for the adapter contract.
    const { signal: _signal, ...recordedOptions } = options ?? {};
    this.calls.push({ messages: structuredClone(messages), options: structuredClone(recordedOptions) });
    const envelope = autoPromptEnvelope(messages);
    this.lastReply = JSON.stringify({ proposals: envelope.questions.map((question) => this.proposal(question, envelope)) });
    return this.lastReply;
  }

  private proposal(question: AutoPromptQuestion, envelope: AutoPromptEnvelope): unknown {
    switch (question.kind) {
      case "discovery_method": {
        const clue = candidateForAutoQuestion(envelope, question, "clue");
        const locationSceneCandidateId = question.candidateDomains.allowedLocationCandidateIds?.[0];
        assert(typeof locationSceneCandidateId === "string" && locationSceneCandidateId.length > 0, "automatic discovery must use an envelope location scene");
        const targets = question.candidateDomains.allowedMechanicsTargetIds ?? {};
        const target = ["scene", "clue", "item", "npc"]
          .map((kind) => ({ kind, id: targets[kind]?.[0] }))
          .find((entry): entry is { kind: string; id: string } => typeof entry.id === "string" && entry.id.length > 0);
        assert(target !== undefined, "automatic discovery must use an envelope mechanics target");
        const id = `fuzu_auto_discovery_${question.questionId.slice(-12)}`;
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: {
            clueCandidateId: clue.id,
            locationSceneCandidateId,
            spec: {
              kind: "discovery_method",
              id,
              clueId: clue.id,
              action: target.kind === "npc" ? "talk" : "search",
              target: target.kind,
              targetId: target.id,
              onSuccess: [{ kind: "discover_clue", clueId: clue.id }],
            },
          },
          citations: [citationForAutoQuestion(question, `discovery:${id}`, clue)],
        };
      }
      case "item_binding": {
        const item = candidateForAutoQuestion(envelope, question, "item");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { itemCandidateId: item.id, itemType: null },
          citations: [citationForAutoQuestion(question, `item_binding:none:${item.id}`, item)],
        };
      }
      case "npc_binding": {
        const anchor = candidateForAutoQuestion(envelope, question, "prose_npc_anchor");
        const susanSource = question.sourceStatements.find((statement) => statement.text.includes(FUZU_SUSAN_NAME_QUOTE)
          && statement.text.includes(FUZU_SUSAN_DIALOGUE_FACT));
        // This is intentionally only an envelope-local source reading.  The
        // responder may bind Susan exactly when the current NPC question's
        // candidate domain is the paragraph that states both her name and
        // her answer; it never consults the private graph or queue.
        if (susanSource !== undefined && anchor.sourceStatementId === susanSource.statementId && anchor.label === susanSource.text) {
          return {
            questionId: question.questionId,
            kind: question.kind,
            value: {
              proseAnchorId: anchor.id,
              presentNpcs: [{
                nameQuote: FUZU_SUSAN_NAME_QUOTE,
                dialogueMethods: [{ relationshipEvidence: { statementId: susanSource.statementId, quote: FUZU_SUSAN_DIALOGUE_FACT } }],
              }],
            },
            citations: [
              { claimKey: `npc_binding:${anchor.id}:0:name`, statementId: susanSource.statementId, quote: FUZU_SUSAN_NAME_QUOTE },
              { claimKey: `npc_binding:${anchor.id}:0:relationship:0`, statementId: susanSource.statementId, quote: FUZU_SUSAN_DIALOGUE_FACT },
            ],
          };
        }
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { proseAnchorId: anchor.id, presentNpcs: [] },
          citations: [citationForAutoQuestion(question, `npc_binding:none:${anchor.id}`, anchor)],
        };
      }
      case "reward_binding": {
        const reward = candidateForAutoQuestion(envelope, question, "reward");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { rewardCandidateId: reward.id, declaration: null },
          citations: [citationForAutoQuestion(question, `reward_binding:none:${reward.id}`, reward)],
        };
      }
      case "source_fact_disposition": {
        const source = question.sourceStatements[0];
        assert(source !== undefined && question.sourceStatements.length === 1, "automatic source disposition must use exactly one whole statement");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { statementId: source.statementId, disposition: "source_only" },
          citations: [citationForAutoQuestion(question, `source_fact_disposition:${source.statementId}`)],
        };
      }
      case "clue_fact_facets": {
        const clue = candidateForAutoQuestion(envelope, question, "clue");
        const atoms = question.candidateDomains.allowedClueFactAtoms;
        assert(Array.isArray(atoms) && atoms.length > 0, "automatic clue facet question must expose a non-empty exact atom domain");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: {
            shell: atoms.map((atom) => ({ atomId: atom.atomId, quote: atom.quote })),
            findings: [],
            sourceOnlyAtomIds: [],
          },
          citations: atoms.map((atom) => ({
            claimKey: `clue_fact_shell:${clue.id}:${atom.atomId}`,
            statementId: atom.statementId,
            quote: atom.quote,
          })),
        };
      }
      default:
        return fail(`automatic Fuzu responder received unsupported question kind: ${question.kind}`);
    }
  }
}

/**
 * The stable human benchmark partitions below exercise the source-specific
 * Medicine/Inspiration choices.  This separate run proves normal server
 * policy does not turn every marked clue into a manual gate: no facet answer
 * is supplied here, and the same FakeLLM must receive and return valid 1.8
 * proposals through the real adapter.
 */
async function assertFuzuAutomaticFacetProposalPath(
  current: PreparedCompilerArtifactPayload,
  humanHintsWithoutFacets: ModuleCompileHints,
): Promise<void> {
  let queue = applyModuleCompileHints(current.graph, current.preparedQueue, humanHintsWithoutFacets);
  const llm = new DeterministicFuzuAutoLLM();
  const facetQuestionIds = new Set(queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => question.id));
  assertEqual(facetQuestionIds.size, CURRENT_CLUE_FACT_FACET_QUESTION_COUNT, "Fuzu automatic probe facet question count");
  // The public adapter is deliberately capped at eight requests per round;
  // this isolated probe may have to advance past unrelated open work before
  // the three facet questions reach a bounded chunk.
  for (let round = 0; round < 16; round++) {
    const unanswered = queue.questions.filter((question) => facetQuestionIds.has(question.id) && question.status === "open");
    if (!unanswered.length) break;
    const proposed = await requestCompilerHintProposals({
      graph: current.graph,
      queue,
      llm,
      policy: { policyId: "internal-fuzu-facet-auto-probe-v1", rightsStatus: "user_provided" },
      producer: { providerFingerprint: "internal-fuzu-acceptance", modelFingerprint: "deterministic-fake" },
      limits: { ...SERVER_AUTO_LIMITS },
    });
    assert(proposed.callCount > 0, "Fuzu automatic facet probe must call the adapter FakeLLM");
    const rejectedFacet = proposed.rejected.filter((diagnostic) => diagnostic.questionId !== undefined
      && facetQuestionIds.has(diagnostic.questionId) && diagnostic.code !== "max_model_requests_reached");
    if (rejectedFacet.length) fail(`Fuzu automatic facet probe rejected grounded facets: ${rejectedFacet.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`).join(" | ")}`);
    assert(proposed.accepted.length > 0, "Fuzu automatic facet probe must make proposal progress");
    queue = applyModuleCompileHints(current.graph, queue, proposed.hints);
  }
  const facets = queue.questions.filter((question) => facetQuestionIds.has(question.id));
  assert(facets.every((question) => question.status === "answered" && question.resolution?.reviewerKind === "approved_policy" && question.resolution.audit?.producer !== undefined), "Fuzu FakeLLM must answer every facet through the trusted automatic proposal path");
  assert(llm.calls.some((call) => autoPromptEnvelope(call.messages).questions.some((question) => question.kind === "clue_fact_facets")), "Fuzu FakeLLM must actually receive a clue_fact_facets request");
}

function catalogDependencies(catalog: CompilerArtifactCatalog): CompiledModuleHttpDependencies {
  return {
    catalog,
    createSession: () => fail("session creation is outside this prepare-only acceptance"),
    hasSession: () => false,
    registerSession: () => undefined,
    persistSession: () => undefined,
    generateId: () => "fuzu-current-schema-acceptance",
    authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: "fuzu-current-schema-acceptance", role: "operator" } }),
  };
}

function autoCatalogDependencies(
  catalog: CompilerArtifactCatalog,
  llm: DeterministicFuzuAutoLLM,
  admission: CompilerAutoAdmissionController,
  construction: AutoDependencyConstruction,
): CompiledModuleHttpDependencies {
  construction.builds++;
  construction.admissions.add(admission);
  return {
    ...catalogDependencies(catalog),
    autoCompiler: {
      llm,
      policy: { policyId: "internal-fuzu-auto-acceptance-v1", rightsStatus: "user_provided" },
      producer: { providerFingerprint: "internal-fuzu-acceptance", modelFingerprint: "deterministic-fake" },
      limits: { ...SERVER_AUTO_LIMITS },
      maxProposalRounds: 2,
      admission,
    },
  };
}

function preparedPayloadFromHttp(body: PreparedHttpResponse, catalog: CompilerArtifactCatalog): PreparedCompilerArtifactPayload {
  assertEqual(body.status, "prepared", "HTTP prepare body status");
  assertEqual(body.identity.moduleId, "fuzu", "HTTP prepared module id");
  assertEqual(body.identity.documentHash, EXPECTED_DOCUMENT_HASH, "HTTP prepared document hash");
  assert(typeof body.preparedArtifactId === "string" && body.preparedArtifactId.length > 0, "HTTP prepared artifact id");
  const loaded = catalog.loadPrepared(body.preparedArtifactId);
  assert(loaded.status === "ok", "current prepared artifact must load from temporary catalog");
  const restored = restoreCompilerArtifact(loaded.value.artifact);
  assert(restored.status === "restored" && restored.stage === "prepared", "current prepared artifact must restore under current schema");
  return restored.payload;
}

function assertPreparedStructure(payload: PreparedCompilerArtifactPayload): void {
  assertEqual(payload.identity.moduleId, "fuzu", "prepared module id");
  assertEqual(payload.identity.documentHash, EXPECTED_DOCUMENT_HASH, "prepared document hash");
  assertEqual(payload.graph.documentIdentity.hashSource, "pdf_bytes_sha256", "prepared hash source");
  assertEqual(payload.graph.documentIdentity.pages.length, 16, "prepared page count");
  assertEqual(payload.draft.sceneCandidates.length, 22, "prepared scene candidate count");
  assertEqual(payload.draft.clueCandidates.length, 3, "prepared clue candidate count");
  assertEqual(payload.draft.itemCandidates.length, 3, "prepared item candidate count");
  assertEqual(payload.draft.proseNpcAnchors.length, 32, "prepared prose NPC anchor count");
  assertEqual(payload.draft.rewardCandidates.length, 0, "prepared reward candidate count");
  const childCount = assertCurrentQuestionTotal(payload.preparedQueue.questions, "prepared");
  assert(payload.preparedQueue.questions.filter((question) => question.kind === "source_fact_mechanic").every((question) => question.status === "deferred" && question.resolution === undefined), "prepared source fact children must be deferred without resolutions");
  assert(childCount >= 0, "prepared source fact child count must be non-negative");
}

/**
 * Locate the doctor branch strictly through this freshly prepared PDF graph
 * and its existing questions.  These assertions deliberately make a changed
 * source graph fail before any answer is rewritten.
 */
function fuzuDoctorQueue(current: PreparedCompilerArtifactPayload) {
  const doctorScenes = current.draft.sceneCandidates.filter((candidate) => candidate.id === FUZU_DOCTOR_SCENE_ID
    && candidate.displayName === FUZU_DOCTOR_HEADING
    && candidate.headingStatementId === FUZU_DOCTOR_HEADING_STATEMENT_ID);
  assertEqual(doctorScenes.length, 1, "current Fuzu graph must expose the exact doctor scene candidate");
  const doctorScene = doctorScenes[0]!;
  const heading = required(current.graph.statements.find((statement) => statement.id === doctorScene.headingStatementId), "current Fuzu doctor heading statement");
  assert(heading.kind === "heading" && heading.text === FUZU_DOCTOR_HEADING, "current Fuzu doctor heading must remain source exact");
  const paragraph = required(current.graph.statements.find((statement) => statement.id === FUZU_DOCTOR_PARAGRAPH_STATEMENT_ID), "current Fuzu doctor paragraph statement");
  assert(paragraph.kind === "paragraph" && paragraph.parentStatementId === heading.id
    && paragraph.text.includes(FUZU_DOCTOR_ENTRY_SUPPORT) && paragraph.text.includes(FUZU_SUSAN_NAME_QUOTE)
    && paragraph.text.includes(FUZU_SUSAN_DIALOGUE_FACT), "current Fuzu doctor paragraph must retain its entry support and exact Susan fact");

  const oneQuestion = (kind: CompilerQuestion["kind"], subjectCandidateId: string, label: string) => {
    const questions = current.preparedQueue.questions.filter((question) => question.kind === kind && question.subjectCandidateId === subjectCandidateId);
    assertEqual(questions.length, 1, label);
    return questions[0]!;
  };
  const doctorRole = oneQuestion("scene_role", doctorScene.id, "current Fuzu doctor scene role question");
  assertSameStrings(doctorRole.sourceStatementIds, [heading.id], "current Fuzu doctor role source evidence");
  const doctorTopology = oneQuestion("connection_topology", doctorScene.id, "current Fuzu doctor topology question");
  assert(doctorTopology.sourceStatementIds.includes(heading.id) && doctorTopology.sourceStatementIds.includes(paragraph.id), "current Fuzu doctor topology must retain heading and paragraph evidence");

  const leaveScenes = current.draft.sceneCandidates.filter((candidate) => candidate.displayName === FUZU_LEAVE_HEADING);
  const courtyardScenes = current.draft.sceneCandidates.filter((candidate) => candidate.displayName === FUZU_COURTYARD_HEADING);
  assertEqual(leaveScenes.length, 1, "current Fuzu graph must expose one leave scene");
  assertEqual(courtyardScenes.length, 1, "current Fuzu graph must expose one courtyard scene");
  const leaveScene = leaveScenes[0]!;
  const courtyardScene = courtyardScenes[0]!;
  const leaveTopology = oneQuestion("connection_topology", leaveScene.id, "current Fuzu leave topology question");
  assert(leaveTopology.allowedCandidateIds?.includes(doctorScene.id) === true && leaveTopology.allowedCandidateIds?.includes(courtyardScene.id) === true, "current Fuzu leave topology must permit both optional targets");
  assert(doctorTopology.allowedCandidateIds?.includes(courtyardScene.id) === true, "current Fuzu doctor topology must permit the courtyard target");

  const susanAnchors = current.draft.proseNpcAnchors.filter((candidate) => candidate.sceneCandidateId === doctorScene.id
    && candidate.headingStatementId === heading.id && candidate.paragraphStatementId === paragraph.id);
  assertEqual(susanAnchors.length, 1, "current Fuzu doctor paragraph must expose one prose NPC anchor");
  const susanAnchor = susanAnchors[0]!;
  const susanQuestion = oneQuestion("npc_binding", susanAnchor.id, "current Fuzu Susan NPC binding question");
  assertEqual(susanQuestion.subjectStatementId, paragraph.id, "current Fuzu Susan question must retain its exact paragraph");
  assert(susanQuestion.sourceStatementIds.includes(heading.id) && susanQuestion.sourceStatementIds.includes(paragraph.id), "current Fuzu Susan question must retain same-heading evidence");
  return { doctorScene, heading, paragraph, doctorRole, doctorTopology, leaveScene, courtyardScene, leaveTopology, susanAnchor, susanQuestion };
}

/**
 * The three marked Fuzu clues are partitioned from the queue's offered atom
 * domain.  These are real human benchmark judgments, not a compatibility
 * fallback: every body atom is explicitly shell, gated finding, or
 * source-only, and the parser still derives all runtime IDs and predicates.
 */
function addFuzuClueFactFacetHumanBindings(current: PreparedCompilerArtifactPayload, reviewed: ModuleCompileHints): ModuleCompileHints {
  const hints = structuredClone(reviewed);
  const candidateById = new Map(current.draft.clueCandidates.map((candidate) => [candidate.id, candidate]));
  const questions = current.preparedQueue.questions.filter((question) => question.kind === "clue_fact_facets");
  assertEqual(questions.length, CURRENT_CLUE_FACT_FACET_QUESTION_COUNT, "Fuzu marked clues must each receive one facet partition question");
  const atom = (question: CompilerQuestion, fragment: string) => {
    const selected = question.allowedClueFactAtoms?.find((candidate) => candidate.quote.includes(fragment));
    assert(selected !== undefined, `Fuzu facet atom must exactly contain ${fragment}`);
    return selected;
  };
  const selectedQuote = (value: { id: string; quote: string }) => ({ atomId: value.id, quote: value.quote });
  for (const question of questions) {
    const candidate = question.subjectCandidateId ? candidateById.get(question.subjectCandidateId) : undefined;
    assert(candidate !== undefined, "Fuzu facet question must name one canonical marked clue");
    const atoms = question.allowedClueFactAtoms;
    assert(atoms !== undefined && atoms.length > 0, "Fuzu facet question must expose a source-exact atom domain");
    let value: unknown;
    if (candidate.displayName === FUZU_CORPSE_CLUE) {
      const shell = atom(question, "\u52b3\u4f26\u5f88\u660e\u663e\u5df2\u7ecf\u6b7b\u4e86");
      const medicine = atom(question, FUZU_MEDICINE_FRAGMENT);
      value = {
        shell: [selectedQuote(shell)],
        findings: [{
          findingKey: "medicine-details",
          atoms: [selectedQuote(medicine)],
          methods: [{ declarationKey: "medicine-check", action: "search", target: "clue", check: { kind: "skill", skill: "medicine", difficulty: "regular" }, failback: { maxFailures: 1 } }],
        }],
        sourceOnlyAtomIds: atoms.filter((candidateAtom) => candidateAtom.id !== shell.id && candidateAtom.id !== medicine.id).map((candidateAtom) => candidateAtom.id),
      };
    } else if (candidate.displayName === FUZU_CIRCLE_CLUE) {
      const shell = atom(question, "\u7531\u9c9c\u8840\u6784\u6210\u5706\u73af\u53ea\u662f\u4e00\u4e2a\u5706\u73af");
      const inspiration = atom(question, FUZU_INSPIRATION_FRAGMENT);
      value = {
        shell: [selectedQuote(shell)],
        findings: [{
          findingKey: "inspiration-details",
          atoms: [selectedQuote(inspiration)],
          methods: [{ declarationKey: "inspiration-check", action: "search", target: "clue", check: { kind: "skill", skill: "idea", difficulty: "regular" }, failback: { maxFailures: 1 } }],
        }],
        sourceOnlyAtomIds: atoms.filter((candidateAtom) => candidateAtom.id !== shell.id && candidateAtom.id !== inspiration.id).map((candidateAtom) => candidateAtom.id),
      };
    } else if (candidate.displayName === FUZU_AROUND_ROOM_CLUE) {
      const dreamStone = atom(question, FUZU_DREAM_STONE_FRAGMENT);
      value = {
        // find_dream_stone already supplies the source-stated detailed-area
        // search (with check:none).  The stone is its shell revelation, not a
        // second same-action child that would require an artificial retry.
        shell: [selectedQuote(dreamStone)],
        findings: [],
        sourceOnlyAtomIds: atoms.filter((candidateAtom) => candidateAtom.id !== dreamStone.id).map((candidateAtom) => candidateAtom.id),
      };
    } else {
      fail(`unexpected Fuzu facet clue: ${candidate.displayName}`);
    }
    hints.resolutions.push({
      questionId: question.id,
      kind: question.kind,
      value,
      sourceStatementIds: [...question.sourceStatementIds],
      evidenceRefs: [...question.evidenceRefs],
      authority: "user_document",
      derivation: "explicit",
      reviewerKind: "human",
      rightsStatus: "user_provided",
      reason: "human-reviewed Fuzu visible shell / gated finding source-exact partition",
    });
  }
  assertEqual(hints.resolutions.length, 59, "tracked reviewed answers plus Fuzu current human constructions, camera prose finding, and clue facet partitions count");
  return hints;
}

/**
 * The first "find Lauren" source root explicitly says that entering the
 * room reveals its visible scene.  It now safely compiles to two automatic
 * shell-only transitions: the faceted details remain unavailable until their
 * own checked methods, and no transition may grant a finding clue.
 */
function addFuzuArrivalShellTransitions(current: PreparedCompilerArtifactPayload, reviewed: ModuleCompileHints): ModuleCompileHints {
  const hints = structuredClone(reviewed);
  const rootParent = current.preparedQueue.questions.find((question) => question.kind === "source_fact_disposition"
    && question.subjectStatementId !== undefined
    && current.graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes(FUZU_FIND_LAUREN_ROOT_FRAGMENT) === true);
  assert(rootParent !== undefined && rootParent.sourceFactChildQuestionId !== undefined, "Fuzu find-Lauren root must expose a typed source-fact child");
  const child = required(current.preparedQueue.questions.find((question) => question.id === rootParent.sourceFactChildQuestionId), "Fuzu find-Lauren source-fact child");
  assertEqual(child.kind, "source_fact_mechanic", "Fuzu find-Lauren child kind");
  const corpse = required(current.draft.clueCandidates.find((candidate) => candidate.displayName === FUZU_CORPSE_CLUE), "Fuzu corpse shell candidate");
  const circle = required(current.draft.clueCandidates.find((candidate) => candidate.displayName === FUZU_CIRCLE_CLUE), "Fuzu circle shell candidate");
  assert(child.allowedMechanicsTargetIds?.clue?.includes(corpse.id) && child.allowedMechanicsTargetIds?.clue?.includes(circle.id), "Fuzu arrival child must retain both closed shell targets");
  const root = required(current.graph.statements.find((statement) => statement.id === rootParent.subjectStatementId), "Fuzu find-Lauren root source statement");
  const transition = (declarationKey: string, discoverClueCandidateId: string) => {
    const base = `source_fact_mechanic:${root.id}:${declarationKey}`;
    const evidence = ["declaration", "trigger", "discover"].map((suffix) => ({
      claimKey: `${base}:${suffix}`,
      statementId: root.id,
      quote: root.text.trim(),
    }));
    return { declarationKey, kind: "scene_state_transition", trigger: { kind: "scene_enter" }, discoverClueCandidateId, evidence };
  };
  hints.resolutions.push({
    questionId: rootParent.id,
    kind: rootParent.kind,
    value: { statementId: root.id, disposition: "mechanics_candidate" },
    sourceStatementIds: [...rootParent.sourceStatementIds],
    evidenceRefs: [...rootParent.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "human-reviewed Fuzu arrival prose is a source-bound automatic visible-shell transition only",
  });
  hints.resolutions.push({
    questionId: child.id,
    kind: child.kind,
    value: { declarations: [transition("enter-reveals-corpse", corpse.id), transition("enter-reveals-circle", circle.id)] },
    sourceStatementIds: [...child.sourceStatementIds],
    evidenceRefs: [...child.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "human-reviewed Fuzu entering-the-room prose automatically reveals only the two visible marked-clue shells",
  });
  assertEqual(hints.resolutions.length, 52, "tracked reviewed answers plus Fuzu arrival shell transitions count");
  return hints;
}

/**
 * The camera paragraph has no marked camera clue. Its one unambiguous
 * Knowledge-success sentence is nevertheless a closed, exact root atom:
 * select it by server-issued ID and explicitly leave the camera background
 * and the unsupported OR-skill sentence source-only.
 */
function addFuzuCameraProseFinding(current: PreparedCompilerArtifactPayload, reviewed: ModuleCompileHints): ModuleCompileHints {
  const hints = structuredClone(reviewed);
  const parents = current.preparedQueue.questions.filter((question) => question.kind === "source_fact_disposition"
    && question.subjectStatementId !== undefined
    && current.graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes(FUZU_CAMERA_KNOWLEDGE_FINDING_FRAGMENT) === true);
  assertEqual(parents.length, 1, "fresh Fuzu camera source must expose one exact source-fact parent");
  const parent = parents[0]!;
  const child = required(current.preparedQueue.questions.find((question) => question.id === parent.sourceFactChildQuestionId), "fresh Fuzu camera prose child");
  const root = required(current.graph.statements.find((statement) => statement.id === parent.subjectStatementId), "fresh Fuzu camera source root");
  assertEqual(child.kind, "source_fact_mechanic", "Fuzu camera prose child kind");
  assertEqual(child.owningHeadingStatementId, root.parentStatementId, "Fuzu camera child must derive its heading scope from the source root");
  const candidates = child.allowedProseFactFindingCandidates ?? [];
  const atoms = child.allowedSourceFactAtoms ?? [];
  assertEqual(candidates.length, 1, "Fuzu camera source must offer exactly one single-check finding candidate");
  assertEqual(atoms.length, 3, "Fuzu camera source must partition all three exact root atoms");
  const candidate = candidates[0]!;
  assert(candidate.quote.replace(/\s/g, "").includes(FUZU_CAMERA_KNOWLEDGE_FINDING_FRAGMENT), "Fuzu camera candidate must be the exact Knowledge-success sentence");
  assertEqual(candidate.check.kind, "attribute", "Fuzu camera candidate check kind");
  assert(candidate.check.kind === "attribute" && candidate.check.attribute === "edu" && candidate.check.difficulty === "regular", "Fuzu camera candidate must be the server-derived regular EDU check");
  assert(atoms.some((atom) => atom.id === candidate.atomId && atom.quote === candidate.quote), "Fuzu camera candidate must name one offered exact root atom");
  const sourceOnlyAtomIds = atoms.filter((atom) => atom.id !== candidate.atomId).map((atom) => atom.id);
  assertEqual(sourceOnlyAtomIds.length, 2, "Fuzu camera source-only remainder must retain background and unsupported OR-skill atoms");

  hints.resolutions.push({
    questionId: parent.id,
    kind: parent.kind,
    value: { statementId: root.id, disposition: "mechanics_candidate" },
    sourceStatementIds: [...parent.sourceStatementIds],
    evidenceRefs: [...parent.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "human-reviewed Fuzu camera prose contains one exact successful Knowledge finding and two source-only atom remainders",
  });
  hints.resolutions.push({
    questionId: child.id,
    kind: child.kind,
    value: { findingCandidateIds: [candidate.id], sourceOnlyAtomIds },
    sourceStatementIds: [...child.sourceStatementIds],
    evidenceRefs: [...child.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "human-reviewed Fuzu camera finding selects only the server-derived Knowledge candidate and partitions every remaining exact atom source-only",
  });
  assertEqual(hints.resolutions.length, 54, "tracked reviewed answers plus Fuzu arrival and camera prose findings count");
  return hints;
}

/**
 * One additional human review turns the exact body quote "梦境之石" into a
 * loot binding.  It intentionally edits only the existing reviewed discovery
 * and two existing ending declarations whose ids name that same evidence.
 */
function addDreamStoneHumanBinding(current: PreparedCompilerArtifactPayload, reviewed: ModuleCompileHints): ModuleCompileHints {
  const hints = structuredClone(reviewed);
  const dreamStone = current.draft.itemCandidates.filter((candidate) => {
    const body = current.graph.statements.find((statement) => statement.id === candidate.bodyStatementId);
    return body?.text.includes("梦境之石") === true;
  });
  assertEqual(dreamStone.length, 1, "current Fuzu graph must expose exactly one dream-stone item candidate");
  const item = dreamStone[0]!;
  const body = current.graph.statements.find((statement) => statement.id === item.bodyStatementId);
  assert(body !== undefined && body.kind === "marked_item_body" && body.parentStatementId === item.markedItemStatementId, "dream-stone item body must remain a marked-item child");
  assert(body.text.includes("梦境之石"), "dream-stone body must contain the human-reviewed exact quote");
  const itemQuestion = current.preparedQueue.questions.find((question) => question.kind === "item_binding" && question.subjectCandidateId === item.id);
  assert(itemQuestion !== undefined, "dream-stone item must retain its current binding question");
  assert(itemQuestion.allowedItemNameEvidenceStatementIds?.includes(body.id), "dream-stone body must be in its candidate-local name evidence domain");

  const discovery = hints.resolutions.find((resolution) => {
    const value = resolution.value as { spec?: { id?: string } };
    return resolution.kind === "discovery_method" && value.spec?.id === "find_dream_stone";
  });
  assert(discovery !== undefined, "tracked reviewed answers must retain find_dream_stone");
  const discoveryValue = discovery.value as {
    clueCandidateId: string;
    locationSceneCandidateId: string;
    spec: { target: string; targetId: string; onSuccess: Array<{ kind: string; clueId?: string; itemId?: string }> };
  };
  assertEqual(discoveryValue.locationSceneCandidateId, item.sceneCandidateId, "dream-stone discovery location must be item source scene");
  assert(!discoveryValue.spec.onSuccess.some((effect) => effect.kind === "acquire_item"), "tracked reviewed discovery must not already acquire an unbound item");
  discoveryValue.spec.onSuccess.push({ kind: "acquire_item", itemId: item.id });

  const ending = hints.resolutions.find((resolution) => resolution.kind === "ending_rule");
  assert(ending !== undefined, "tracked reviewed answers must retain ending declarations");
  const declarations = (ending.value as {
    declarations: Array<{ endingId: string; spec: { when: { kind: string; predicates?: Array<unknown> } } }>;
  }).declarations;
  const escape = declarations.find((declaration) => declaration.endingId === "escape_with_dream_stone");
  const lost = declarations.find((declaration) => declaration.endingId === "lost_without_dream_stone");
  assert(escape !== undefined && lost !== undefined, "tracked reviewed answers must retain both dream-stone endings");
  const escapeScene = escape.spec.when.predicates?.find((predicate) => (predicate as { kind?: string }).kind === "scene_visited") as { kind: "scene_visited"; sceneId: string } | undefined;
  const lostScene = lost.spec.when.predicates?.find((predicate) => (predicate as { kind?: string }).kind === "scene_visited") as { kind: "scene_visited"; sceneId: string } | undefined;
  assert(escapeScene !== undefined && lostScene !== undefined, "both reviewed endings must retain their source-scoped exit scene");
  escape.spec.when = { kind: "all", predicates: [{ kind: "item_owned", itemId: item.id }, escapeScene] };
  lost.spec.when = { kind: "all", predicates: [lostScene, { kind: "not", predicate: { kind: "item_owned", itemId: item.id } }] } as typeof lost.spec.when;

  hints.resolutions.push({
    questionId: itemQuestion.id,
    kind: "item_binding",
    value: {
      itemCandidateId: item.id,
      itemType: "loot",
      itemNameEvidence: { statementId: body.id, quote: "梦境之石" },
    },
    sourceStatementIds: [...itemQuestion.sourceStatementIds],
    evidenceRefs: [...itemQuestion.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "human-reviewed exact Fuzu body quote binds the dream stone as loot",
  });
  assertEqual(hints.resolutions.length, 55, "tracked reviewed answers plus current human constructions, camera finding, and dream-stone binding count before facet partitions");
  return hints;
}

/**
 * This is a deliberately narrow human review of one static presence, not an
 * extraction rule. The selected paragraph explicitly places Randy in the
 * courtyard scene; no dialogue or encounter mechanic is declared.
 */
function addCourtyardRandyHumanBinding(current: PreparedCompilerArtifactPayload, reviewed: ModuleCompileHints): ModuleCompileHints {
  const hints = structuredClone(reviewed);
  const courtyard = current.draft.sceneCandidates.filter((candidate) => candidate.displayName === FUZU_COURTYARD_HEADING);
  assertEqual(courtyard.length, 1, "current Fuzu graph must expose exactly one courtyard scene candidate");
  const scene = courtyard[0]!;
  const heading = current.graph.statements.find((statement) => statement.id === scene.headingStatementId);
  assert(heading !== undefined && heading.kind === "heading" && heading.text === FUZU_COURTYARD_HEADING, "courtyard scene must retain its exact source heading");

  const anchors = current.draft.proseNpcAnchors.filter((candidate) => {
    if (candidate.sceneCandidateId !== scene.id || candidate.headingStatementId !== heading.id) return false;
    const paragraph = current.graph.statements.find((statement) => statement.id === candidate.paragraphStatementId);
    return paragraph?.kind === "paragraph"
      && paragraph.parentStatementId === heading.id
      && paragraph.text.includes(FUZU_RANDY_NAME_QUOTE)
      && paragraph.text.includes(FUZU_RANDY_PRESENCE_QUOTE);
  });
  assertEqual(anchors.length, 1, "courtyard source must expose exactly one directly-present Randy prose NPC anchor");
  const anchor = anchors[0]!;
  const paragraph = current.graph.statements.find((statement) => statement.id === anchor.paragraphStatementId);
  assert(paragraph !== undefined && paragraph.kind === "paragraph" && paragraph.text.includes(FUZU_RANDY_NAME_QUOTE), "courtyard Randy anchor must retain the exact source name");
  const question = current.preparedQueue.questions.filter((candidate) => candidate.kind === "npc_binding" && candidate.subjectCandidateId === anchor.id);
  assertEqual(question.length, 1, "courtyard Randy anchor must retain one current NPC binding question");
  const npcQuestion = question[0]!;
  assertEqual(npcQuestion.subjectStatementId, paragraph.id, "courtyard Randy question must retain its exact prose paragraph");
  assert(npcQuestion.sourceStatementIds.includes(heading.id) && npcQuestion.sourceStatementIds.includes(paragraph.id), "courtyard Randy question must retain same-heading evidence");

  hints.resolutions.push({
    questionId: npcQuestion.id,
    kind: "npc_binding",
    value: {
      proseAnchorId: anchor.id,
      presentNpcs: [{ nameQuote: FUZU_RANDY_NAME_QUOTE, dialogueMethods: [] }],
    },
    sourceStatementIds: [...npcQuestion.sourceStatementIds],
    evidenceRefs: [...npcQuestion.evidenceRefs],
    authority: "user_document",
    derivation: "explicit",
    reviewerKind: "human",
    rightsStatus: "user_provided",
    reason: "human-reviewed exact Fuzu courtyard paragraph identifies Randy Patila alive in a cocoon; static presence only",
  });
  assertEqual(hints.resolutions.length, 56, "tracked reviewed answers plus current human constructions, camera finding, and static Randy binding count before facet partitions");
  return hints;
}

function sourceText(payload: ResolvedCompilerArtifactPayload, statementId: string, label: string): string {
  const statement = payload.graph.statements.find((candidate) => candidate.id === statementId);
  assert(statement !== undefined && statement.text.trim().length > 0, label);
  return statement.text;
}

function sourceTextForScene(payload: ResolvedCompilerArtifactPayload, sceneId: string): string {
  const candidate = payload.draft.sceneCandidates.find((scene) => scene.id === sceneId);
  assert(candidate !== undefined, "resolved scene candidate");
  const paragraph = payload.graph.statements.find((statement) => statement.kind === "paragraph" && statement.parentStatementId === candidate.headingStatementId && statement.text.trim());
  return paragraph ? paragraph.text : sourceText(payload, candidate.headingStatementId, "scene source heading");
}

function fuzuCourtyardRandyBinding(payload: ResolvedCompilerArtifactPayload) {
  const courtyard = payload.draft.sceneCandidates.filter((candidate) => candidate.displayName === FUZU_COURTYARD_HEADING);
  assertEqual(courtyard.length, 1, "resolved Fuzu must retain one courtyard scene candidate");
  const scene = courtyard[0]!;
  const bindings = payload.proseNpcBindings.filter((binding) => binding.sceneCandidateId === scene.id && binding.nameQuote === FUZU_RANDY_NAME_QUOTE);
  assertEqual(bindings.length, 1, "resolved Fuzu must retain exactly one courtyard Randy binding");
  const binding = bindings[0]!;
  assertEqual(binding.headingStatementId, scene.headingStatementId, "resolved Randy binding must remain under courtyard heading");
  assertEqual(binding.dialogueMethods.length, 0, "resolved Randy binding must have no dialogue methods");
  assert(binding.encounter === undefined, "resolved Randy binding must have no encounter");
  const paragraph = payload.graph.statements.find((statement) => statement.id === binding.paragraphStatementId);
  assert(paragraph !== undefined && paragraph.kind === "paragraph" && paragraph.text.includes(FUZU_RANDY_PRESENCE_QUOTE), "resolved Randy binding must retain direct courtyard-presence source evidence");
  return binding;
}

function fuzuDoctorSusanBinding(payload: ResolvedCompilerArtifactPayload) {
  const doctorScenes = payload.draft.sceneCandidates.filter((candidate) => candidate.id === FUZU_DOCTOR_SCENE_ID
    && candidate.displayName === FUZU_DOCTOR_HEADING && candidate.headingStatementId === FUZU_DOCTOR_HEADING_STATEMENT_ID);
  assertEqual(doctorScenes.length, 1, "resolved Fuzu must retain the exact doctor scene candidate");
  const scene = doctorScenes[0]!;
  const bindings = payload.proseNpcBindings.filter((binding) => binding.sceneCandidateId === scene.id && binding.nameQuote === FUZU_SUSAN_NAME_QUOTE);
  assertEqual(bindings.length, 1, "resolved Fuzu must retain exactly one automatic Susan binding");
  const binding = bindings[0]!;
  assertEqual(binding.headingStatementId, FUZU_DOCTOR_HEADING_STATEMENT_ID, "resolved Susan binding heading provenance");
  assertEqual(binding.paragraphStatementId, FUZU_DOCTOR_PARAGRAPH_STATEMENT_ID, "resolved Susan binding paragraph provenance");
  assertEqual(binding.dialogueMethods.length, 1, "resolved Susan binding dialogue count");
  assert(binding.encounter === undefined, "resolved Susan binding must not declare combat");
  const dialogue = binding.dialogueMethods[0]!;
  assertEqual(dialogue.kind, "prose", "resolved Susan dialogue kind");
  assertEqual(dialogue.relationshipStatementId, FUZU_DOCTOR_PARAGRAPH_STATEMENT_ID, "resolved Susan dialogue relationship statement");
  assertEqual(dialogue.relationshipQuote, FUZU_SUSAN_DIALOGUE_FACT, "resolved Susan dialogue relationship quote");
  assertEqual(dialogue.spec.action, "talk", "resolved Susan dialogue action");
  assertEqual(dialogue.spec.target, "npc", "resolved Susan dialogue target");
  assertEqual(dialogue.spec.targetId, binding.npcId, "resolved Susan dialogue target identity");
  assertEqual(dialogue.spec.onSuccess.length, 1, "resolved Susan dialogue effect count");
  const dialogueEffect = dialogue.spec.onSuccess[0];
  assert(dialogueEffect?.kind === "discover_clue", "resolved Susan dialogue effect kind");
  assertEqual(dialogueEffect.clueId, dialogue.clueId, "resolved Susan dialogue effect clue identity");
  const proseClues = payload.proseDialogueClues.filter((clue) => clue.npcId === binding.npcId && clue.mechanismId === dialogue.mechanismId && clue.clueId === dialogue.clueId);
  assertEqual(proseClues.length, 1, "resolved Susan dialogue must derive one prose clue");
  const proseClue = proseClues[0]!;
  assertEqual(proseClue.relationshipStatementId, FUZU_DOCTOR_PARAGRAPH_STATEMENT_ID, "resolved Susan prose clue relationship statement");
  assertEqual(proseClue.relationshipQuote, FUZU_SUSAN_DIALOGUE_FACT, "resolved Susan prose clue relationship quote");
  return { scene, binding, dialogue, proseClue };
}

/** Build presentation metadata only from the freshly resolved exact-source graph/draft. */
function exactSourcePresentation(payload: ResolvedCompilerArtifactPayload): ModuleDataPresentationMetadata {
  const firstSource = payload.graph.statements.find((statement) => statement.text.trim());
  assert(firstSource !== undefined, "current graph must contain source text");
  const source = firstSource.text;
  const scenes: ModuleDataPresentationMetadata["scenes"] = Object.create(null);
  for (const sceneId of payload.mechanicsIR.symbols.sceneIds) scenes[sceneId] = { description: sourceTextForScene(payload, sceneId) };
  const connections: ModuleDataPresentationMetadata["connections"] = Object.create(null);
  for (const connection of payload.analysisInput.connections) connections[connection.id] = { condition: sourceTextForScene(payload, connection.fromSceneId) };
  const clues: ModuleDataPresentationMetadata["clues"] = Object.create(null);
  const facetText = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    const shell = binding.shellAtoms.map((atom) => atom.quote).join("\n")
      || payload.draft.clueCandidates.find((candidate) => candidate.id === binding.clueId)?.displayName;
    if (shell && (binding.shellAtoms.length || binding.findings.length)) facetText.set(binding.clueId, shell);
    for (const finding of binding.findings) facetText.set(finding.clueId, finding.atoms.map((atom) => atom.quote).join("\n"));
  }
  const proseDialogueText = new Map<string, string>();
  for (const clue of payload.proseDialogueClues) {
    const statement = payload.graph.statements.find((candidate) => candidate.id === clue.relationshipStatementId);
    assert(statement?.kind === "paragraph" && statement.text.includes(clue.relationshipQuote), "derived prose dialogue clue must retain its exact relationship quote");
    assert(clue.relationshipQuote.trim().length > 0, "derived prose dialogue clue relationship quote must not be empty");
    proseDialogueText.set(clue.clueId, clue.relationshipQuote);
  }
  const proseFactFindingText = new Map<string, string>();
  for (const binding of payload.sourceFactMechanicBindings) {
    if (binding.declarationKind !== "prose_fact_finding") continue;
    const atom = payload.draft.sourceFactAtoms.find((candidate) => candidate.id === binding.atomId);
    assert(atom !== undefined && atom.quote === binding.quote && atom.evidence.spans.length === 1
      && atom.evidence.spans[0]?.exactText === binding.quote, "derived prose finding clue must retain its one exact atom quote");
    proseFactFindingText.set(binding.clueId, binding.quote);
  }
  for (const clueId of payload.mechanicsIR.symbols.clueIds) {
    const display = proseFactFindingText.get(clueId) ?? proseDialogueText.get(clueId) ?? facetText.get(clueId);
    assert(display !== undefined, "resolved clue must have source-exact facet, prose-finding, or prose-relationship display text");
    clues[clueId] = {
      findMethods: [],
      revelation: display,
      unlocks: [],
      importance: payload.analysisInput.coreClueIds.includes(clueId) ? "core" : "bonus",
    };
  }
  const endings: ModuleDataPresentationMetadata["endings"] = Object.create(null);
  for (const ending of payload.mechanicsIR.endings) {
    const endGame = ending.effects.filter((effect) => effect.kind === "end_game");
    assertEqual(endGame.length, 1, "resolved ending end_game effect count");
    const effect = endGame[0]!;
    assert(effect.kind === "end_game", "resolved ending effect kind");
    endings[effect.endingId] = { name: source, description: source, conditions: [source] };
  }
  return {
    module: {
      title: source,
      version: source,
      ruleset: "cosmic-horror",
      era: source,
      summary: source,
      playerCount: source,
      expectedDuration: source,
      triggerWarnings: [source],
    },
    scenes,
    connections,
    clues,
    endings,
  };
}

function fuzuFacetBinding(payload: ResolvedCompilerArtifactPayload, displayName: string) {
  const candidate = payload.draft.clueCandidates.find((clue) => clue.displayName === displayName);
  assert(candidate !== undefined, `Fuzu canonical shell must exist: ${displayName}`);
  const binding = payload.clueFactFacetBindings.find((candidateBinding) => candidateBinding.clueId === candidate.id);
  assert(binding !== undefined, `Fuzu canonical shell must retain a facet binding: ${displayName}`);
  return { candidate, binding };
}

/** Regression guard for the three source-specific Fuzu visibility decisions. */
function assertFuzuFacetSemantics(
  payload: ResolvedCompilerArtifactPayload,
  projection: ReturnType<typeof projectResolvedCompilerArtifact> & { status: "projected" },
): void {
  const corpse = fuzuFacetBinding(payload, FUZU_CORPSE_CLUE);
  const medicine = corpse.binding.findings.find((finding) => finding.atoms.some((atom) => atom.quote.includes(FUZU_MEDICINE_FRAGMENT)));
  assert(medicine !== undefined, "corpse medical detail must be a gated finding");
  assert(!corpse.binding.shellAtoms.some((atom) => atom.quote.includes(FUZU_MEDICINE_FRAGMENT)), "corpse visible shell must not disclose Medicine finding");
  assert(medicine.methods.some((method) => method.action === "search" && method.check.kind === "skill" && method.check.skill === "medicine"), "corpse Medicine finding must require its explicit checked method");
  const corpseScene = required(projection.module.scenes.find((scene) => scene.id === corpse.candidate.sceneCandidateId), "Fuzu corpse scene projection");
  assert(!required(corpseScene.clues.find((clue) => clue.id === corpse.candidate.id), "Fuzu corpse shell projection").description.includes(FUZU_MEDICINE_FRAGMENT), "Fuzu corpse shell projection must not leak Medicine finding text");

  const circle = fuzuFacetBinding(payload, FUZU_CIRCLE_CLUE);
  const inspiration = circle.binding.findings.find((finding) => finding.atoms.some((atom) => atom.quote.includes(FUZU_INSPIRATION_FRAGMENT)));
  assert(inspiration !== undefined, "circle inspiration detail must be a gated finding");
  assert(!circle.binding.shellAtoms.some((atom) => atom.quote.includes(FUZU_INSPIRATION_FRAGMENT)), "circle visible shell must not disclose Inspiration finding");
  assert(inspiration.methods.some((method) => method.action === "search" && method.check.kind === "skill" && method.check.skill === "idea"), "circle Inspiration finding must require its explicit checked method");
  const circleScene = required(projection.module.scenes.find((scene) => scene.id === circle.candidate.sceneCandidateId), "Fuzu circle scene projection");
  assert(!required(circleScene.clues.find((clue) => clue.id === circle.candidate.id), "Fuzu circle shell projection").description.includes(FUZU_INSPIRATION_FRAGMENT), "Fuzu circle shell projection must not leak Inspiration finding text");

  const aroundRoom = fuzuFacetBinding(payload, FUZU_AROUND_ROOM_CLUE);
  const dreamStone = aroundRoom.binding.shellAtoms.find((atom) => atom.quote.includes(FUZU_DREAM_STONE_FRAGMENT));
  assert(dreamStone !== undefined && aroundRoom.binding.findings.length === 0, "dream stone must be the one-search visible shell, never a duplicate gated child");
  const roomScene = required(projection.module.scenes.find((scene) => scene.id === aroundRoom.candidate.sceneCandidateId), "Fuzu room scene projection");
  const projectedShell = required(roomScene.clues.find((clue) => clue.id === aroundRoom.candidate.id), "Fuzu around-room shell projection");
  assert(projectedShell.description.includes(FUZU_DREAM_STONE_FRAGMENT), "dream-stone shell projection must retain exact selected source text");
  assert(!roomScene.clues.some((clue) => clue.id !== aroundRoom.candidate.id && clue.description.includes(FUZU_DREAM_STONE_FRAGMENT)), "dream stone must not create a duplicate child clue");
  const detailedSearch = required(payload.mechanicsIR.discoveryMethods.find((method) => method.id === "find_dream_stone"), "Fuzu detailed dream-stone search mechanism");
  assertEqual(detailedSearch.clueId, aroundRoom.candidate.id, "one detailed search must reveal the dream-stone shell itself");
  assert(detailedSearch.action === "search" && detailedSearch.target === "scene" && detailedSearch.check?.kind === "none", "dream stone must require the source-stated detailed no-check area search");

  const arrivalRoot = required(payload.graph.statements.find((statement) => statement.text.includes(FUZU_FIND_LAUREN_ROOT_FRAGMENT)), "Fuzu find-Lauren root statement");
  const arrivalTransitions = payload.sourceFactMechanicBindings.filter((binding): binding is Extract<(typeof payload.sourceFactMechanicBindings)[number], { declarationKind: "scene_state_transition" }> => binding.statementId === arrivalRoot.id && binding.declarationKind === "scene_state_transition");
  assertEqual(arrivalTransitions.length, 2, "find-Lauren source root must compile exactly two automatic shell transitions");
  assert(arrivalTransitions.every((binding) => binding.trigger.kind === "scene_enter"), "find-Lauren transitions must trigger only on entering the room");
  assertSameStrings(arrivalTransitions.map((binding) => binding.discoverClueId).sort(), [corpse.candidate.id, circle.candidate.id].sort(), "automatic arrival transitions must reveal only corpse and circle shells");
  const findingIds = [medicine.clueId, inspiration.clueId];
  assert(arrivalTransitions.every((binding) => binding.spec.effects.every((effect) => effect.kind !== "discover_clue" || !findingIds.includes(effect.clueId))), "automatic arrival transitions must never grant Medicine or Inspiration findings");
  assert(!payload.mechanicsIR.transitions.some((transition) => transition.effects.some((effect) => effect.kind === "discover_clue" && (effect.clueId === aroundRoom.candidate.id || findingIds.includes(effect.clueId)))), "scene-enter automation must not reveal dream stone or a gated finding");

  const cameraQuestion = required(payload.resolvedQueue.questions.find((question) => question.kind === "source_fact_disposition"
    && question.subjectStatementId !== undefined
    && payload.graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes(FUZU_CAMERA_KNOWLEDGE_FINDING_FRAGMENT) === true), "Fuzu source must retain its camera source-fact question");
  const cameraRoot = required(payload.graph.statements.find((statement) => statement.id === cameraQuestion.subjectStatementId), "Fuzu camera source root");
  assertEqual((cameraQuestion.resolution?.value as { disposition?: unknown } | undefined)?.disposition, "mechanics_candidate", "Fuzu camera source fact must activate its closed prose finding child");
  const cameraChild = required(payload.resolvedQueue.questions.find((question) => question.id === cameraQuestion.sourceFactChildQuestionId), "Fuzu camera source child");
  const cameraCandidates = cameraChild.allowedProseFactFindingCandidates ?? [];
  const cameraAtoms = cameraChild.allowedSourceFactAtoms ?? [];
  assertEqual(cameraCandidates.length, 1, "Fuzu camera source must retain exactly one derived Knowledge candidate");
  const cameraBinding = required(payload.sourceFactMechanicBindings.find((binding): binding is Extract<(typeof payload.sourceFactMechanicBindings)[number], { declarationKind: "prose_fact_finding" }> => binding.declarationKind === "prose_fact_finding" && binding.questionId === cameraChild.id), "Fuzu resolved camera prose finding binding");
  const cameraCandidate = cameraCandidates[0]!;
  assertEqual(cameraBinding.candidateId, cameraCandidate.id, "Fuzu camera binding candidate id");
  assertEqual(cameraBinding.atomId, cameraCandidate.atomId, "Fuzu camera binding exact atom id");
  assertEqual(cameraBinding.quote, cameraCandidate.quote, "Fuzu camera binding exact atom quote");
  assert(cameraBinding.check.kind === "attribute" && cameraBinding.check.attribute === "edu" && cameraBinding.check.difficulty === "regular", "Fuzu camera binding must retain the one server-derived EDU check");
  assertEqual(cameraBinding.spec.onSuccess.length, 1, "Fuzu camera finding must have one success effect");
  assert(cameraBinding.spec.onSuccess[0]?.kind === "discover_clue" && cameraBinding.spec.onSuccess[0]?.clueId === cameraBinding.clueId, "Fuzu camera finding must only discover its derived clue");
  assert(cameraBinding.spec.onFailure === undefined && cameraBinding.spec.failback === undefined, "Fuzu camera finding must have no failure or failback effect");
  assertSameStrings([...cameraBinding.sourceOnlyAtomIds].sort(), cameraAtoms.filter((atom) => atom.id !== cameraCandidate.atomId).map((atom) => atom.id).sort(), "Fuzu camera binding must partition all unselected exact atoms source-only");
  assert(!payload.analysisInput.coreClueIds.includes(cameraBinding.clueId), "Fuzu camera prose clue must remain optional rather than core");
  assert(!payload.draft.clueCandidates.some((clue) => clue.displayName.includes("\u6444\u50cf")), "Fuzu camera must not become a canonical marked-clue shell");
  const cameraOrigin = projection.sourceMap.scenes[cameraBinding.sceneCandidateId]?.clues[cameraBinding.clueId]?.fields.description;
  assert(cameraOrigin?.kind === "resolved_question", "Fuzu camera projection must retain resolved-question source-map provenance");
  assertSameStrings(cameraOrigin.quotes.map((quote) => `${quote.statementId}\u0000${quote.quote}`), [`${cameraRoot.id}\u0000${cameraCandidate.quote}`], "Fuzu camera projection source map must point to its exact atom");
}

function fuzuFilmSanConnection(payload: ResolvedCompilerArtifactPayload) {
  const oneScene = (displayName: string, label: string) => {
    const scenes = payload.draft.sceneCandidates.filter((candidate) => candidate.displayName === displayName);
    assertEqual(scenes.length, 1, label);
    const scene = scenes[0]!;
    const heading = required(payload.graph.statements.find((statement) => statement.id === scene.headingStatementId), `${label} heading`);
    assert(heading.kind === "heading" && heading.text === displayName, `${label} heading must remain source exact`);
    return { scene, heading };
  };
  const film = oneScene(FUZU_FILM_HEADING, "resolved Fuzu film scene");
  const night = oneScene(FUZU_NIGHT_HEADING, "resolved Fuzu night scene");
  const connections = payload.analysisInput.connections.filter((connection) => connection.id === FUZU_FILM_TO_NIGHT_CONNECTION_ID);
  assertEqual(connections.length, 1, "resolved Fuzu film-to-night connection count");
  const connection = connections[0]!;
  assertEqual(connection.fromSceneId, film.scene.id, "resolved Fuzu film connection source");
  assertEqual(connection.toSceneId, night.scene.id, "resolved Fuzu film connection target");
  const gate = required(payload.mechanicsIR.connections.find((candidate) => candidate.connectionId === FUZU_FILM_TO_NIGHT_CONNECTION_ID), "resolved Fuzu film SAN connection mechanism");
  assertEqual(gate.onTraverse?.length, 1, "resolved Fuzu film SAN on-traverse effect count");
  assert(JSON.stringify(gate.onTraverse?.[0]) === JSON.stringify(FUZU_FILM_SANITY_EFFECT), "resolved Fuzu film SAN declaration must remain exact");
  const sourceStatementIds = new Set(payload.acceptedInterpretations
    .filter((interpretation) => gate.sourceInterpretationIds.includes(interpretation.id))
    .flatMap((interpretation) => interpretation.sourceStatementIds));
  assert([...sourceStatementIds].some((id) => {
    const statement = payload.graph.statements.find((candidate) => candidate.id === id);
    return statement?.kind === "paragraph" && statement.parentStatementId === film.heading.id && statement.text.includes(FUZU_FILM_SAN_SOURCE);
  }), "resolved Fuzu film SAN mechanism must retain its exact source paragraph");
  return { film, night, gate };
}

function playerWitnessSteps(witness: MechanicsWitness) {
  const steps = witness.steps.filter((step) => step.outcome !== "transition" && step.outcome !== "ending");
  for (const step of steps) assert(step.outcome === "success" || step.outcome === "traverse", "Fuzu GameSession witness step must be deterministic discovery or traversal");
  return steps;
}

/** A GameSession action settles the following automatic closure before it returns. */
function settledPlayerWitnessSteps(witness: MechanicsWitness): Array<{ step: ReturnType<typeof playerWitnessSteps>[number]; settledStateHash: string }> {
  const settled: Array<{ step: ReturnType<typeof playerWitnessSteps>[number]; settledStateHash: string }> = [];
  for (let index = 0; index < witness.steps.length; index++) {
    const step = witness.steps[index]!;
    if (step.outcome === "transition" || step.outcome === "ending") continue;
    assert(step.outcome === "success" || step.outcome === "traverse", "Fuzu durable witness player action must be deterministic");
    let closure = step;
    while (index + 1 < witness.steps.length && (witness.steps[index + 1]!.outcome === "transition" || witness.steps[index + 1]!.outcome === "ending")) {
      closure = witness.steps[++index]!;
    }
    settled.push({ step, settledStateHash: closure.afterStateHash });
  }
  return settled;
}

/**
 * Cross an actual executable boundary.  The restart runner intentionally
 * receives only durable paths and structured action identities; no live
 * GameSession, artifact envelope, or mechanics state crosses this boundary.
 */
async function replayFuzuWitnessInFreshProcess(
  root: string,
  id: string,
  settledSteps: readonly ReturnType<typeof settledPlayerWitnessSteps>[number][],
): Promise<{ ordering: string[]; duplicate: { generation?: unknown }; continued: { generation?: unknown; compiled?: { stateHash?: unknown } } }> {
  assert(settledSteps.length > 2, "Fuzu fresh-process replay requires a continued witness action");
  const { compiledMechanicsAction } = await import("../src/api/game-session");
  const childPath = join(import.meta.dir, "..", "src", "__tests__", "compiled-session-restart-child.ts");
  const child = Bun.spawn([
    process.execPath,
    childPath,
    root,
    id,
    compiledMechanicsAction(settledSteps[0]!.step.mechanismId),
    `${id}-action-0`,
    "0",
    compiledMechanicsAction(settledSteps[2]!.step.mechanismId),
    `${id}-action-2`,
    "2",
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const diagnostic = childOutputDiagnostic(stdout, stderr);
  assertEqual(exitCode, 0, `Fuzu fresh-process restart runner exit (${diagnostic})`);
  const proofJson = stdout.endsWith("\n") ? stdout.slice(0, -1) : "";
  assert(proofJson.length > 0 && !proofJson.includes("\n"), `Fuzu fresh-process restart runner must emit exactly one JSON line (${diagnostic})`);
  let proof: unknown;
  try { proof = JSON.parse(proofJson); } catch { fail(`Fuzu fresh-process restart runner must return JSON proof (${diagnostic})`); }
  assert(proof && typeof proof === "object" && !Array.isArray(proof), "Fuzu fresh-process restart runner proof shape");
  return proof as { ordering: string[]; duplicate: { generation?: unknown }; continued: { generation?: unknown; compiled?: { stateHash?: unknown } } };
}

/** Execute each real Fuzu checked finding through GameSession twice: a first
 * failed check must preserve the child truth, while a fresh success must set
 * exactly that compiler-derived child clue. */
async function assertFuzuCheckedFindingsGameSession(
  payload: ResolvedCompilerArtifactPayload,
  projection: ReturnType<typeof projectResolvedCompilerArtifact> & { status: "projected" },
  route: MechanicsWitness,
): Promise<void> {
  const corpse = fuzuFacetBinding(payload, FUZU_CORPSE_CLUE);
  const circle = fuzuFacetBinding(payload, FUZU_CIRCLE_CLUE);
  const findings = [
    required(corpse.binding.findings.find((finding) => finding.atoms.some((atom) => atom.quote.includes(FUZU_MEDICINE_FRAGMENT))), "Fuzu Medicine finding"),
    required(circle.binding.findings.find((finding) => finding.atoms.some((atom) => atom.quote.includes(FUZU_INSPIRATION_FRAGMENT))), "Fuzu Inspiration finding"),
  ];
  const {
    GameSession,
    compiledMechanicsAction,
  } = await import("../src/api/game-session");
  const sessionFor = (id: string, skillValues?: Record<string, number>) => {
    const source = new GameSession(id, "cosmic-horror", {
      apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0,
    }, "investigator", "Fuzu acceptance investigator");
    if (!skillValues) {
      assertEqual(source.loadCompiledModule(payload, projection).status, "loaded", "Fuzu checked-finding GameSession load");
      return source;
    }
    // Compiled checks read the persisted p1 sheet. Seed it before loading via
    // the ordinary snapshot/hash boundary; activeCharacter is observation-only.
    const snapshot = source.exportOrdinarySessionSnapshot();
    const p1 = snapshot.state.characters.find((entry) => entry.pcId === "p1");
    assert(p1?.sheet && !Array.isArray(p1.sheet) && typeof p1.sheet === "object", "Fuzu checked-finding fixture requires p1 sheet");
    const sheet = p1.sheet as Record<string, OrdinarySnapshotJson>;
    assert(sheet.skillValues && !Array.isArray(sheet.skillValues) && typeof sheet.skillValues === "object", "Fuzu checked-finding fixture requires p1 skillValues");
    Object.assign(sheet.skillValues as Record<string, OrdinarySnapshotJson>, skillValues);
    const { snapshotHash: _discarded, ...unsigned } = snapshot;
    const session = new GameSession(id, "cosmic-horror", {
      apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0,
    });
    session.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
    source.close();
    assertEqual(session.loadCompiledModule(payload, projection).status, "loaded", "Fuzu checked-finding GameSession load");
    return session;
  };
  for (const finding of findings) {
    const method = required(finding.methods.find((candidate) => candidate.check.kind === "skill"), `Fuzu checked finding method ${finding.clueId}`);
    const skill = method.check.kind === "skill" ? method.check.skill : fail("checked Fuzu finding must have a skill");
    for (const outcome of ["failure", "success"] as const) {
      // `idea` is a compiled pseudo-skill, not a legal persisted skill key.
      // Its success/failure branches below are already selected by the
      // deterministic d100 samples, so only seed actual CoC skill values.
      const session = sessionFor(
        `fuzu-current-schema-${skill}-${outcome}`,
        skill === "idea" ? undefined : { [skill]: outcome === "success" ? 100 : 1 },
      );
      for (const step of playerWitnessSteps(route)) {
        if (session.getCompiledAvailableActions().some((action) => action.mechanismId === method.mechanismId)) break;
        const moved = await session.act(compiledMechanicsAction(step.mechanismId));
        assert(moved.error === undefined, `Fuzu route to ${skill} finding must execute`);
      }
      assert(session.getCompiledAvailableActions().some((action) => action.mechanismId === method.mechanismId), `Fuzu ${skill} finding must become available only after its shell route`);
      const originalRandom = Math.random;
      try {
        Math.random = () => outcome === "success" ? 0 : 0.99;
        const result = await session.act(compiledMechanicsAction(method.mechanismId));
        assert(result.error === undefined, `Fuzu ${skill} ${outcome} check must execute`);
        assertEqual(result.compiled?.trace.at(-1)?.outcome, outcome, `Fuzu ${skill} check outcome`);
        assertEqual(result.compiled?.state.foundClueIds.includes(finding.clueId), outcome === "success", `Fuzu ${skill} finding truth after ${outcome}`);
      } finally {
        Math.random = originalRandom;
      }
    }
  }

  const camera = required(payload.sourceFactMechanicBindings.find((binding): binding is Extract<(typeof payload.sourceFactMechanicBindings)[number], { declarationKind: "prose_fact_finding" }> => binding.declarationKind === "prose_fact_finding"), "Fuzu camera prose finding binding for GameSession");
  assert(camera.check.kind === "attribute" && camera.check.attribute === "edu", "Fuzu camera GameSession finding must retain Knowledge/EDU check");
  for (const outcome of ["failure", "success"] as const) {
    const session = sessionFor(`fuzu-current-schema-camera-knowledge-${outcome}`);
    for (const step of playerWitnessSteps(route)) {
      if (session.getCompiledAvailableActions().some((action) => action.mechanismId === camera.mechanismId)) break;
      const moved = await session.act(compiledMechanicsAction(step.mechanismId));
      assert(moved.error === undefined, "Fuzu route to camera Knowledge finding must execute");
    }
    assert(session.getCompiledAvailableActions().some((action) => action.mechanismId === camera.mechanismId), "Fuzu camera Knowledge finding must become available in its owning scene");
    const originalRandom = Math.random;
    try {
      Math.random = () => outcome === "success" ? 0 : 0.99;
      const result = await session.act(compiledMechanicsAction(camera.mechanismId));
      assert(result.error === undefined, `Fuzu camera Knowledge ${outcome} check must execute`);
      assertEqual(result.compiled?.trace.at(-1)?.outcome, outcome, `Fuzu camera Knowledge check outcome`);
      assertEqual(result.compiled?.state.foundClueIds.includes(camera.clueId), outcome === "success", `Fuzu camera Knowledge finding truth after ${outcome}`);
    } finally {
      Math.random = originalRandom;
    }
  }
}

interface FuzuWitnessStepResult {
  mechanismId: string;
  outcome: string;
  stateHash: string;
  terminalEndingId?: string;
}

interface FuzuWitnessReplay {
  ending: string;
  playerActions: number;
  ownedItemIds: string[];
  filmSanity: { settlementCount: 1; appliedLoss: number; beforeSAN: number; afterSAN: number };
  steps: FuzuWitnessStepResult[];
}

async function replayGameSession(
  id: string,
  payload: ResolvedCompilerArtifactPayload,
  projection: ReturnType<typeof projectResolvedCompilerArtifact> & { status: "projected" },
  endingId: string,
  witness: MechanicsWitness,
): Promise<FuzuWitnessReplay> {
  // GameSession is delayed until the acceptance runner has silenced unrelated
  // internal diagnostics, keeping this CLI's successful stdout machine-safe.
  const {
    GameSession,
    compiledMechanicsAction,
  } = await import("../src/api/game-session");
  const session = new GameSession(id, "cosmic-horror", {
    apiKey: "sk-placeholder",
    baseUrl: "http://offline.invalid",
    model: "offline",
    maxTokens: 1,
    temperature: 0,
  }, "investigator", "Fuzu acceptance investigator");
  assertEqual(session.loadCompiledModule(payload, projection).status, "loaded", "GameSession compiled module load");
  const settledSteps = settledPlayerWitnessSteps(witness);
  const steps = settledSteps.map(({ step }) => step);
  assert(steps.length > 0, "GameSession witness must contain player actions");
  const filmSan = fuzuFilmSanConnection(payload);
  assertEqual(steps.filter((step) => step.mechanismId === filmSan.gate.id).length, 1, "each Fuzu ending witness must traverse the film SAN connection exactly once");
  const dreamStoneShell = fuzuFacetBinding(payload, FUZU_AROUND_ROOM_CLUE).candidate.id;
  const dreamStoneItem = required(payload.itemBindings.find((binding) => binding.itemType === "loot"), "Fuzu dream-stone runtime item binding").itemId;
  let observedDetailedDreamStoneSearch = false;
  let filmSanity: { settlementCount: 1; appliedLoss: number; beforeSAN: number; afterSAN: number } | undefined;
  let lastResult: Awaited<ReturnType<GameSession["act"]>> | undefined;
  const observedSteps: FuzuWitnessStepResult[] = [];
  for (const [stepIndex, step] of steps.entries()) {
    if (step.mechanismId === "find_dream_stone") {
      const before = session.getCompiledMechanicsState();
      assert(before !== null && !before.state.foundClueIds.includes(dreamStoneShell), "scene entry must not auto-discover the dream-stone shell before detailed search");
    }
    const beforeSAN = step.mechanismId === filmSan.gate.id ? session.getSanity().currentSAN : undefined;
    const result = await session.act(compiledMechanicsAction(step.mechanismId));
    assert(result.error === undefined, "GameSession witness action must execute");
    assertEqual(result.compiled?.stateHash, settledSteps[stepIndex]!.settledStateHash, `GameSession ${step.mechanismId} settled mechanics state hash`);
    assert(result.compiled?.trace.some((trace) => trace.mechanismId === step.mechanismId && trace.outcome === step.outcome && trace.afterStateHash === step.afterStateHash) === true, `GameSession ${step.mechanismId} must retain the replayed witness outcome`);
    const settlements = result.sanityCheckSettlements ?? [];
    if (step.mechanismId === filmSan.gate.id) {
      assertEqual(settlements.length, 1, "Film traversal must produce one SAN settlement");
      const settlement = settlements[0]!;
      assertEqual(settlement.mechanismId, filmSan.gate.id, "Film SAN settlement mechanism id");
      assertEqual(settlement.outcome, "traverse", "Film SAN settlement traversal outcome");
      assert(JSON.stringify(settlement.declared) === JSON.stringify({ passLoss: FUZU_FILM_SANITY_EFFECT.passLoss, failLoss: FUZU_FILM_SANITY_EFFECT.failLoss }), "Film SAN settlement must retain exact declared 1/1d3 losses");
      assert(settlement.check.appliedLoss >= 1 && settlement.check.appliedLoss <= 3, "Film SAN settlement applied loss must be in the declared 1..3 range");
      assert(/^[a-f0-9]{64}$/.test(settlement.beforeSanityHash) && /^[a-f0-9]{64}$/.test(settlement.afterSanityHash), "Film SAN settlement hashes must be valid");
      assert(settlement.beforeSanityHash !== settlement.afterSanityHash, "Film SAN settlement hashes must bind a real SAN change");
      const afterSAN = session.getSanity().currentSAN;
      assert(beforeSAN !== undefined && afterSAN < beforeSAN, "Film SAN traversal must lower actual session SAN");
      assertEqual(settlement.check.appliedLoss, beforeSAN - afterSAN, "Film SAN applied loss must equal the session SAN delta");
      filmSanity = { settlementCount: 1, appliedLoss: settlement.check.appliedLoss, beforeSAN, afterSAN };
    } else {
      assertEqual(settlements.length, 0, "only the Fuzu film traversal may settle a SAN check in an ending witness");
    }
    if (step.mechanismId === "find_dream_stone") {
      assert(result.compiled?.state.foundClueIds.includes(dreamStoneShell) === true, "one detailed no-check search must discover the dream-stone shell");
      assert(result.compiled?.state.ownedItemIds.includes(dreamStoneItem) === true, "one detailed no-check search must acquire the reviewed dream-stone item");
      observedDetailedDreamStoneSearch = true;
    }
    observedSteps.push({
      mechanismId: step.mechanismId,
      outcome: step.outcome,
      stateHash: required(result.compiled?.stateHash, `GameSession ${step.mechanismId} state hash`),
      ...(result.compiled?.terminalEnding ? { terminalEndingId: result.compiled.terminalEnding.id } : {}),
    });
    lastResult = result;
  }
  if (endingId === "escape_with_dream_stone") assert(observedDetailedDreamStoneSearch, "dream-stone escape witness must perform exactly the source-bound detailed search");
  assert(filmSanity !== undefined, "Fuzu ending witness must record one film SAN settlement");
  assertEqual(lastResult?.compiled?.terminalEnding?.id, endingId, "GameSession terminal ending");
  assertEqual(session.getCompiledAvailableActions().length, 0, "GameSession terminal available action count");
  const retry = await session.act(compiledMechanicsAction(steps[steps.length - 1]!.mechanismId));
  assertEqual(retry.error?.code, "compiled_terminal", "GameSession terminal retry refusal");
  return { ending: endingId, playerActions: steps.length, ownedItemIds: [...(lastResult?.compiled?.state.ownedItemIds ?? [])], filmSanity, steps: observedSteps };
}

/**
 * The public Fuzu replay above intentionally exercises the volatile façade.
 * This companion crosses the actual durable boundary: an immutable catalog
 * reload, generation-zero snapshot, server transaction, and a fresh
 * GameSession rebuilt from every committed successor snapshot.
 */
async function replayDurableGameSession(
  id: string,
  artifact: CompilerArtifactEnvelope,
  projection: ReturnType<typeof projectResolvedCompilerArtifact> & { status: "projected" },
  endingId: string,
  witness: MechanicsWitness,
  volatile: FuzuWitnessReplay,
  root: string,
): Promise<void> {
  const {
    GameSession,
    acknowledgeCompiledDurableSessionSnapshot,
    compiledMechanicsAction,
    createCompiledDurableSessionSnapshot,
  } = await import("../src/api/game-session");
  const { runCompiledActionTransaction } = await import("../src/api/server");
  // Keep this whole replay in the durable root shape the independent CLI
  // knows how to hydrate.  It is intentionally a new catalog from this run's
  // just-resolved artifact, never a reference to a pre-existing artifact.
  const durableRoot = join(root, `${id}-fresh-process`);
  const durableCatalog = new CompilerArtifactCatalog({ root: join(durableRoot, "catalog") });
  const savedBundle = durableCatalog.saveBundle(artifact, projection);
  assert(savedBundle.status === "ok", "Fuzu durable bundle must be saved to the catalog");
  const loadedBundle = durableCatalog.loadBundle(savedBundle.value.id);
  assert(loadedBundle.status === "ok", "Fuzu durable bundle must be reloaded from the catalog");

  // A catalog envelope is an immutable durable root, not merely a syntactically
  // valid 64-hex hint that a caller may substitute before its first snapshot.
  const forgedBundle = structuredClone(loadedBundle.value);
  forgedBundle.bundleHash = "0".repeat(64);
  const forgedBundleTarget = new GameSession(`${id}-forged-bundle`, "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0,
  }, "investigator", "Fuzu acceptance investigator", undefined, { careerRoot: join(root, "forged-bundle-careers") });
  assertEqual(forgedBundleTarget.loadDurableCompiledModule(forgedBundle).status, "refused", "Fuzu durable install must reject a forged catalog bundle hash");
  assertEqual(forgedBundleTarget.getCompiledGeneration(), null, "forged bundle must not install a compiled generation");

  const snapshots = new CompiledSessionSnapshotStore({ root: join(durableRoot, "snapshots"), allowUncoordinatedTestWrites: true });
  const careers = join(durableRoot, "careers");
  const durableHostCapability = Object.freeze(Object.create(null)) as object;
  const durableRuntimeDependencies = { compiledDurableHostCapability: durableHostCapability };
  let current = new GameSession(id, "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0,
  }, "investigator", "Fuzu acceptance investigator", undefined, { careerRoot: careers }, undefined, "preferred", durableRuntimeDependencies);
  assertEqual(current.loadDurableCompiledModule(loadedBundle.value).status, "loaded", "Fuzu durable GameSession catalog install");
  const initial = createCompiledDurableSessionSnapshot(current, durableHostCapability);
  const initialWrite = snapshots.save(initial);
  assert(initialWrite.status === "ok", "Fuzu durable generation-zero snapshot must persist");
  acknowledgeCompiledDurableSessionSnapshot(current, durableHostCapability, initial);

  // The restore validator must reject a rehashed snapshot whose state identity
  // is detached from the sealed mechanics state before world writes occur.
  const forgedSnapshot = structuredClone(initial);
  forgedSnapshot.stateHash = "0".repeat(64);
  const forgedSnapshotTarget = new GameSession(id, "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0,
  }, undefined, undefined, undefined, { careerRoot: join(root, "forged-snapshot-careers") });
  assertEqual(forgedSnapshotTarget.restoreCompiledSession(forgedSnapshot, loadedBundle.value).status, "refused", "Fuzu durable restore must reject a forged snapshot state hash");

  const registry = new Map<string, GameSession>([[id, current]]);
  const diagnostics = new Map<string, { id: string; code: string; message: string }>();
  const options = {
    catalog: durableCatalog,
    snapshots,
    sessionRegistry: registry,
    diagnostics,
    storage: { careerRoot: careers },
    compiledDurableHostCapability: durableHostCapability,
    createRecoverySession: ({ id: recoveryId, storage: recoveryStorage }: { id: string; storage: { careerRoot?: string; sessionRoot?: string } }) => new GameSession(
      recoveryId,
      "cosmic-horror",
      { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 },
      undefined,
      undefined,
      undefined,
      recoveryStorage,
      undefined,
      "preferred",
      durableRuntimeDependencies,
    ),
  };
  const settledSteps = settledPlayerWitnessSteps(witness);
  const steps = settledSteps.map(({ step }) => step);
  assertEqual(steps.length, volatile.steps.length, "Fuzu volatile/durable witness step count");

  // A forged witness mechanism must neither persist a successor nor advance
  // the in-memory generation.
  const forgedWitness = structuredClone(witness);
  const forgedStep = playerWitnessSteps(forgedWitness)[0]!;
  forgedStep.mechanismId = "forged_fuzu_witness_mechanism";
  const rejected = await runCompiledActionTransaction(current, {
    input: compiledMechanicsAction(forgedStep.mechanismId), pcId: "p1", actionId: `${id}-forged-witness`, expectedGeneration: 0,
  }, options);
  assert(rejected.status !== 200, "Fuzu durable transaction must reject a forged witness mechanism");
  const afterRejected = snapshots.read(id);
  assert(afterRejected.status === "ok", "Fuzu rejected witness must retain generation-zero snapshot");
  assertEqual((afterRejected.value as CompiledSessionSnapshot).generation, 0, "Fuzu rejected witness must not advance persisted generation");
  assertEqual(current.getCompiledGeneration(), 0, "Fuzu rejected witness must not advance live generation");

  for (const [index, step] of steps.entries()) {
    const beforeGeneration = current.getCompiledGeneration();
    assertEqual(beforeGeneration, index, `Fuzu durable ${step.mechanismId} predecessor generation`);
    if (index === 2) {
      const freshProof = await replayFuzuWitnessInFreshProcess(durableRoot, id, settledSteps);
      assertSameStrings(freshProof.ordering, ["header", "catalog", "body", "restore"], "Fuzu fresh-process durable restore ordering");
      assertEqual(freshProof.duplicate.generation, 1, "Fuzu fresh-process idempotent replay generation");
      assertEqual(freshProof.continued.generation, 3, "Fuzu fresh-process continued action generation");
      assertEqual(freshProof.continued.compiled?.stateHash, settledSteps[index]!.settledStateHash, "Fuzu fresh-process continued action state hash");
      const childPersisted = snapshots.read(id);
      assert(childPersisted.status === "ok", "Fuzu fresh-process continued successor snapshot must persist");
      const childSnapshot = childPersisted.value as CompiledSessionSnapshot;
      assertEqual(childSnapshot.generation, 3, "Fuzu fresh-process persisted continuation generation");
      assertEqual(childSnapshot.stateHash, settledSteps[index]!.settledStateHash, "Fuzu fresh-process persisted continuation state hash");
      current = new GameSession(id, "cosmic-horror", {
        apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0,
      }, undefined, undefined, undefined, { careerRoot: careers }, undefined, "preferred", durableRuntimeDependencies);
      assertEqual(current.restoreCompiledSession(childSnapshot, loadedBundle.value).status, "loaded", "Fuzu parent must restore fresh-process successor");
      registry.set(id, current);
      const childState = required(current.getCompiledMechanicsState(), "Fuzu fresh-process restored mechanics state");
      assertEqual(childState.stateHash, settledSteps[index]!.settledStateHash, "Fuzu fresh-process restored witness state hash");
      continue;
    }
    const transaction = await runCompiledActionTransaction(current, {
      input: compiledMechanicsAction(step.mechanismId), pcId: "p1", actionId: `${id}-action-${index}`, expectedGeneration: index,
    }, options);
    assertEqual(transaction.status, 200, `Fuzu durable ${step.mechanismId} transaction status`);
    assert(transaction.session !== undefined, `Fuzu durable ${step.mechanismId} transaction must replace the GameSession from its snapshot`);
    current = transaction.session;
    assertEqual(current.getCompiledGeneration(), index + 1, `Fuzu durable ${step.mechanismId} generation`);
    assertEqual(transaction.body.generation, index + 1, `Fuzu durable ${step.mechanismId} response generation`);
    const compiled = required(current.getCompiledMechanicsState(), `Fuzu durable ${step.mechanismId} compiled state`);
    const volatileStep = volatile.steps[index]!;
    assertEqual(compiled.stateHash, settledSteps[index]!.settledStateHash, `Fuzu durable ${step.mechanismId} settled reachability state hash`);
    assertEqual(compiled.stateHash, volatileStep.stateHash, `Fuzu durable ${step.mechanismId} volatile state hash`);
    assertEqual(volatileStep.mechanismId, step.mechanismId, `Fuzu durable ${step.mechanismId} volatile mechanism`);
    assertEqual(volatileStep.outcome, step.outcome, `Fuzu durable ${step.mechanismId} volatile outcome`);
    assert(compiled.trace.some((trace) => trace.mechanismId === step.mechanismId && trace.outcome === step.outcome && trace.afterStateHash === step.afterStateHash), `Fuzu durable ${step.mechanismId} trace must retain the witness outcome`);
    const persisted = snapshots.read(id);
    assert(persisted.status === "ok", `Fuzu durable ${step.mechanismId} successor snapshot must persist`);
    const snapshot = persisted.value as CompiledSessionSnapshot;
    assertEqual(snapshot.generation, index + 1, `Fuzu durable ${step.mechanismId} persisted generation`);
    assertEqual(snapshot.stateHash, compiled.stateHash, `Fuzu durable ${step.mechanismId} persisted state hash`);
  }

  const terminal = required(current.getCompiledMechanicsState(), "Fuzu durable terminal compiled state");
  assertEqual(terminal.terminalEnding?.id, endingId, "Fuzu durable terminal ending");
  assertEqual(terminal.terminalEnding?.id, volatile.ending, "Fuzu durable/volatile terminal ending");
  assertEqual(terminal.stateHash, witness.final.stateHash, "Fuzu durable terminal witness state hash");
  const retry = await runCompiledActionTransaction(current, {
    input: compiledMechanicsAction(steps.at(-1)!.mechanismId), pcId: "p1", actionId: `${id}-terminal-retry`, expectedGeneration: steps.length,
  }, options);
  assert(retry.status !== 200, "Fuzu durable terminal retry must fail closed");
}

/** Verify the public GameSession view, without reaching into its executor. */
async function assertCourtyardRandyGameSession(
  payload: ResolvedCompilerArtifactPayload,
  projection: ReturnType<typeof projectResolvedCompilerArtifact> & { status: "projected" },
  witnesses: readonly MechanicsWitness[],
): Promise<void> {
  const binding = fuzuCourtyardRandyBinding(payload);
  const { GameSession, compiledMechanicsAction } = await import("../src/api/game-session");
  for (const [index, witness] of witnesses.entries()) {
    const session = new GameSession(`fuzu-current-schema-static-randy-${index}`, "cosmic-horror", {
      apiKey: "sk-placeholder",
      baseUrl: "http://offline.invalid",
      model: "offline",
      maxTokens: 1,
      temperature: 0,
    }, "investigator", "Fuzu acceptance investigator");
    assertEqual(session.loadCompiledModule(payload, projection).status, "loaded", "GameSession static Randy module load");
    for (const step of playerWitnessSteps(witness)) {
      const result = await session.act(compiledMechanicsAction(step.mechanismId));
      assert(result.error === undefined, "GameSession route to static Randy must execute");
      if (session.getState().scene !== binding.sceneCandidateId) continue;
      const npcs = session.getState().npcs;
      assertEqual(npcs.length, 1, "courtyard GameSession must expose one static NPC");
      assertEqual(npcs[0]!.name, FUZU_RANDY_NAME_QUOTE, "courtyard GameSession NPC must preserve exact reviewed name");
      assert(npcs[0]!.status.includes("narrative_noncombat"), "courtyard GameSession NPC must be noncombat narrative presence");
      const actions = session.getCompiledAvailableActions();
      assert(!actions.some((action) => action.label === `Talk to ${FUZU_RANDY_NAME_QUOTE}`), "static Randy must not expose a talk action");
      assert(!actions.some((action) => action.kind === "combat"), "static Randy must not expose a combat action");
      return;
    }
  }
  assert(false, "an existing Fuzu ending witness must reach the static Randy courtyard scene");
}

/** Replay the optional source-supported branch without changing either
 * shortest ending witness: enter the doctor scene, see Susan, talk once, and
 * observe exactly the compiler-derived prose clue. */
async function assertFuzuDoctorDialogueGameSession(
  payload: ResolvedCompilerArtifactPayload,
  projection: ReturnType<typeof projectResolvedCompilerArtifact> & { status: "projected" },
): Promise<void> {
  const { scene, binding, dialogue, proseClue } = fuzuDoctorSusanBinding(payload);
  const projectedNpc = required(projection.module.npcs.find((npc) => npc.id === binding.npcId), "Fuzu projected Susan NPC");
  assertEqual(projectedNpc.name, FUZU_SUSAN_NAME_QUOTE, "Fuzu projected Susan exact name");
  assertEqual(projectedNpc.sceneId, scene.id, "Fuzu projected Susan scene");
  const susanOrigin = projection.sourceMap.npcs[binding.npcId]?.fields.name;
  assert(susanOrigin?.kind === "resolved_question", "Fuzu projected Susan name must retain resolved-question provenance");
  assertSameStrings(susanOrigin.quotes.map((quote) => `${quote.statementId}\u0000${quote.quote}`), [`${FUZU_DOCTOR_PARAGRAPH_STATEMENT_ID}\u0000${FUZU_SUSAN_NAME_QUOTE}`], "Fuzu projected Susan source-map exact name quote");
  const projectedClue = required(projection.module.scenes.find((candidate) => candidate.id === scene.id), "Fuzu projected doctor scene")
    .clues.find((clue) => clue.id === proseClue.clueId);
  assert(projectedClue !== undefined && projectedClue.name === FUZU_SUSAN_DIALOGUE_FACT && projectedClue.description === FUZU_SUSAN_DIALOGUE_FACT, "Fuzu projected prose clue must display the exact relationship quote");
  const clueOrigin = projection.sourceMap.scenes[scene.id]?.clues[proseClue.clueId]?.fields.name;
  assert(clueOrigin?.kind === "resolved_question", "Fuzu projected prose clue must retain resolved-question provenance");
  assertSameStrings(clueOrigin.quotes.map((quote) => `${quote.statementId}\u0000${quote.quote}`), [`${FUZU_DOCTOR_PARAGRAPH_STATEMENT_ID}\u0000${FUZU_SUSAN_DIALOGUE_FACT}`], "Fuzu projected prose clue source-map exact relationship quote");

  const { GameSession, compiledMechanicsAction } = await import("../src/api/game-session");
  const session = new GameSession("fuzu-current-schema-susan-dialogue", "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0,
  }, "investigator", "Fuzu acceptance investigator");
  assertEqual(session.loadCompiledModule(payload, projection).status, "loaded", "Fuzu Susan GameSession load");
  const opening = fuzuFilmSanConnection(payload);
  assertEqual(session.getState().scene, opening.film.scene.id, "Fuzu optional doctor route must begin at the reviewed film opening");
  const traverse = async (connectionId: string) => {
    const mechanism = required(payload.mechanicsIR.connections.find((candidate) => candidate.connectionId === connectionId), `Fuzu ${connectionId} connection mechanism`);
    const result = await session.act(compiledMechanicsAction(mechanism.id));
    assert(result.error === undefined, `Fuzu ${connectionId} traversal must execute`);
  };
  await traverse(opening.gate.connectionId);
  await traverse("night_to_lauren");
  await traverse("lauren_to_leave");
  await traverse(FUZU_LEAVE_TO_DOCTOR_CONNECTION_ID);
  assertEqual(session.getState().scene, scene.id, "Fuzu optional route must enter the doctor scene");
  const visibleSusan = session.getState().npcs.filter((npc) => npc.name === FUZU_SUSAN_NAME_QUOTE);
  assertEqual(visibleSusan.length, 1, "Fuzu doctor scene must visibly contain Susan");
  // GameSession exposes a talk discovery as the public discovery action kind;
  // its exact label and mechanism identity preserve the NPC interaction.
  assert(session.getCompiledAvailableActions().some((action) => action.mechanismId === dialogue.mechanismId
    && action.kind === "discovery" && action.label === `Talk to ${FUZU_SUSAN_NAME_QUOTE}`), "Fuzu doctor scene must expose Susan talk action");
  const before = session.getCompiledMechanicsState();
  assert(before !== null, "Fuzu Susan GameSession mechanics state before talk");
  const talked = await session.act(compiledMechanicsAction(dialogue.mechanismId));
  assert(talked.error === undefined, "Fuzu Susan talk action must execute");
  assert(talked.compiled?.state.foundClueIds.includes(proseClue.clueId) === true, "Fuzu Susan talk must discover the compiler-derived prose clue");
  assertSameStrings(talked.compiled?.state.ownedItemIds ?? [], before.state.ownedItemIds, "Fuzu Susan dialogue must not grant an item");
  assert(JSON.stringify(talked.compiled?.state.stateValues ?? {}) === JSON.stringify(before.state.stateValues), "Fuzu Susan dialogue must not add a state or treatment effect");
  assert(!session.getCompiledAvailableActions().some((action) => action.mechanismId === dialogue.mechanismId), "Fuzu Susan talk action must disappear after its clue is discovered");
}

function assertInitialResolvedStructure(payload: ResolvedCompilerArtifactPayload): ReturnType<typeof summarizeCompilerRuntimeQuality> {
  assertEqual(payload.readiness.status, "mechanically_closed", "resolved readiness");
  fuzuFilmSanConnection(payload);
  const answered = payload.resolvedQueue.questions.filter((question) => question.status === "answered").length;
  const open = payload.resolvedQueue.questions.filter((question) => question.status === "open").length;
  const deferred = payload.resolvedQueue.questions.filter((question) => question.status === "deferred").length;
  assertEqual(answered, 59, "resolved answered question count");
  assertEqual(open, 138, "resolved open question count");
  assertEqual(deferred, sourceFactMechanicChildQuestions(payload.resolvedQueue.questions).length - 2, "resolved deferred source fact child count");
  assertEqual(payload.readiness.publishBlockingQuestionIds.length, 0, "resolved publish-blocking question count");
  assertSameStrings([...payload.reachabilityReport.reachableEndingIds].sort(), [...EXPECTED_ENDINGS].sort(), "resolved reachable endings");
  assertEqual(payload.reachabilityReport.issues.length, 0, "resolved reachability issue count");
  const quality = summarizeCompilerRuntimeQuality(payload);
  assertEqual(quality.sourceRootDisposition.dispositionReadiness, "incomplete", "source disposition readiness");
  const expectedCoverage = {
    sceneCandidates: 22,
    playableScenes: 6,
    clueCandidates: 3,
    proseFactFindingClues: 1,
    compiledClues: 6,
    discoveryMethods: 4,
    itemCandidates: 3,
    boundItems: 1,
    runtimeItems: 1,
    proseNpcAnchors: 32,
    boundNpcAnchors: 1,
    boundNpcs: 1,
    dialogueMethods: 0,
    encounters: 0,
    rewardCandidates: 0,
    boundRewards: 0,
    runtimeRewards: 0,
    declaredEndings: 2,
    reachableEndings: 2,
  } as const;
  for (const [key, expected] of Object.entries(expectedCoverage)) {
    assertEqual(quality.coverage[key as keyof typeof quality.coverage], expected, `runtime quality coverage ${key}`);
  }
  for (const value of Object.values(quality.closedWorldIssueCounts)) assertEqual(value, 0, "closed-world issue count");
  return quality;
}

function assertFullyAutoResolvedStructure(payload: ResolvedCompilerArtifactPayload): ReturnType<typeof summarizeCompilerRuntimeQuality> {
  assertEqual(payload.readiness.status, "mechanically_closed", "fully answered resolved readiness");
  fuzuFilmSanConnection(payload);
  const answered = payload.resolvedQueue.questions.filter((question) => question.status === "answered").length;
  const open = payload.resolvedQueue.questions.filter((question) => question.status === "open").length;
  const deferred = payload.resolvedQueue.questions.filter((question) => question.status === "deferred").length;
  const notApplicable = payload.resolvedQueue.questions.filter((question) => question.status === "not_applicable").length;
  const childCount = assertCurrentQuestionTotal(payload.resolvedQueue.questions, "fully answered resolved");
  assertEqual(answered, CURRENT_PREPARED_QUESTION_COUNT + 2, "fully answered resolved question count");
  assertEqual(open, 0, "fully answered resolved open question count");
  assertEqual(deferred, 0, "fully answered resolved deferred question count");
  assertEqual(notApplicable, childCount - 2, "fully answered source-only child not-applicable count");
  assertEqual(payload.readiness.publishBlockingQuestionIds.length, 0, "fully answered publish-blocking question count");
  assertSameStrings([...payload.reachabilityReport.reachableEndingIds].sort(), [...EXPECTED_ENDINGS].sort(), "fully answered reachable endings");
  assertEqual(payload.reachabilityReport.issues.length, 0, "fully answered reachability issue count");
  const quality = summarizeCompilerRuntimeQuality(payload);
  assertEqual(quality.sourceRootDisposition.dispositionReadiness, "complete", "fully answered source disposition readiness");
  assertEqual(quality.sourceRootDisposition.openQuestionCount, 0, "fully answered source open question count");
  assertEqual(quality.sourceRootDisposition.openRootCount, 0, "fully answered source open root count");
  assertEqual(quality.sourceRootDisposition.unmodeledRootCount, 0, "fully answered source unmodeled root count");
  assert(quality.sourceRootDisposition.rootStatementCount > 0, "fully answered source root count");
  assert(quality.sourceRootDisposition.counts.explicitly_unbound > 0, "fully answered source-only decisions must remain accounted");
  const expectedCoverage = {
    sceneCandidates: 22,
    playableScenes: 6,
    clueCandidates: 3,
    proseDialogueClues: 1,
    proseFactFindingClues: 1,
    compiledClues: 7,
    discoveryMethods: 7,
    itemCandidates: 3,
    boundItems: 1,
    runtimeItems: 1,
    proseNpcAnchors: 32,
    boundNpcAnchors: 2,
    boundNpcs: 2,
    dialogueMethods: 1,
    encounters: 0,
    rewardCandidates: 0,
    boundRewards: 0,
    runtimeRewards: 0,
    declaredEndings: 2,
    reachableEndings: 2,
  } as const;
  for (const [key, expected] of Object.entries(expectedCoverage)) {
    assertEqual(quality.coverage[key as keyof typeof quality.coverage], expected, `fully answered runtime quality coverage ${key}`);
  }
  for (const value of Object.values(quality.closedWorldIssueCounts)) assertEqual(value, 0, "fully answered closed-world issue count");
  return quality;
}

function publicResponseLeaksInternalMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(publicResponseLeaksInternalMaterial);
  if (!value || typeof value !== "object") return false;
  const forbidden = new Set(["hints", "rawReply", "raw", "audit", "graph", "artifact", "artifactHash", "projection", "bundle", "bundleId", "sourceStatements", "sourceProse"]);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => forbidden.has(key) || publicResponseLeaksInternalMaterial(nested));
}

function responseContainsText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text);
  if (Array.isArray(value)) return value.some((entry) => responseContainsText(entry, text));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((entry) => responseContainsText(entry, text));
}

function meaningfulSourceProse(prepared: PreparedCompilerArtifactPayload): readonly string[] {
  const texts = new Set(
    prepared.graph.statements
      .map((statement) => statement.text.trim())
      .filter((text) => text.length >= SOURCE_PROSE_LEAK_MIN_CHARS),
  );
  assert(texts.size > 0, "current Fuzu graph must supply meaningful private source prose for leak checks");
  return [...texts];
}

function assertPublicAutoResponse(
  value: PublicAutoResolveResponse,
  preparedArtifactId: string,
  expectedResumed: boolean,
  previousOpenQuestions: number,
  lastRawReply: string,
  sourceProse: readonly string[],
): void {
  assertEqual(value.status, "presentation_draft_only", "automatic public status");
  assertEqual(value.preparedArtifactId, preparedArtifactId, "automatic public prepared artifact identity");
  assertEqual(value.resumed, expectedResumed, "automatic public continuation state");
  assertEqual(value.progress, true, "automatic public progress");
  assert(typeof value.continuationId === "string" && value.continuationId.length > 0, "automatic public continuation id");
  assertEqual(value.mechanics.readiness, "mechanically_closed", "automatic public mechanics readiness");
  assertEqual(value.presentation.readiness, "visibility_unresolved", "automatic public presentation readiness");
  assert(!Object.hasOwn(value.content, "contentReadiness"), "automatic public content must not expose the legacy contentReadiness alias");
  for (const count of Object.values(value.content.positiveCoverage)) assert(Number.isSafeInteger(count) && count >= 0, "automatic public positive coverage must be safe aggregate counts");
  assert(
    value.content.openQuestionCount < previousOpenQuestions,
    `automatic public content must make bounded progress (previous ${previousOpenQuestions}, received ${value.content.openQuestionCount})`,
  );
  assert(!publicResponseLeaksInternalMaterial(value), "automatic public response must not expose private compiler material");
  assert(!responseContainsText(value, lastRawReply), "automatic public response must not echo the raw model reply");
  for (const sourceText of sourceProse) {
    assert(!responseContainsText(value, sourceText), "automatic public response must not expose source prose");
  }
}

function assertFullyValidatedAutoHints(hints: ModuleCompileHints, prepared: PreparedCompilerArtifactPayload, initialHints: ModuleCompileHints): void {
  const childQuestionIds = new Set(sourceFactMechanicChildQuestions(prepared.preparedQueue.questions).map((question) => question.id));
  const doctor = fuzuDoctorQueue(prepared);
  const randyQuestion = required(prepared.preparedQueue.questions.find((question) => question.kind === "npc_binding"
    && question.subjectStatementId !== undefined
    && prepared.graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes(FUZU_RANDY_NAME_QUOTE) === true
    && prepared.graph.statements.find((statement) => statement.id === question.subjectStatementId)?.text.includes(FUZU_RANDY_PRESENCE_QUOTE) === true), "current Fuzu Randy NPC binding question");
  const initiallyAnsweredChildren = initialHints.resolutions.filter((resolution) => resolution.kind === "source_fact_mechanic");
  assertEqual(hints.resolutions.length, CURRENT_PREPARED_QUESTION_COUNT + initiallyAnsweredChildren.length, "private automatic continuation answer count");
  const initialIds = new Set(initialHints.resolutions.map((resolution) => resolution.questionId));
  assert(initialIds.has(randyQuestion.id), "Randy must remain an initial human static binding");
  assert(!initialIds.has(doctor.susanQuestion.id), "Susan must not be added as a human binding");
  const resolutions = new Map(hints.resolutions.map((resolution) => [resolution.questionId, resolution]));
  assertEqual(resolutions.size, CURRENT_PREPARED_QUESTION_COUNT + initiallyAnsweredChildren.length, "private automatic continuation unique answer count");
  for (const question of prepared.preparedQueue.questions) {
    const resolution = resolutions.get(question.id);
    if (childQuestionIds.has(question.id)) {
      assert(resolution === undefined || initialIds.has(question.id), "only an initial mechanics-candidate source fact child may retain an incoming hint resolution");
      continue;
    }
    assert(resolution !== undefined, "private automatic continuation must answer every current question");
    if (!initialIds.has(question.id)) {
      assertEqual(resolution.reviewerKind, "approved_policy", "automatic answer reviewer kind");
      assert(resolution.audit?.producer !== undefined, "automatic answer must retain producer provenance");
    }
    const value = resolution.value as Record<string, unknown>;
    switch (question.kind) {
      case "discovery_method": {
        const spec = value.spec as { onSuccess?: Array<{ kind?: string; clueId?: string }> } | undefined;
        assert(Array.isArray(spec?.onSuccess) && spec.onSuccess.some((effect) => effect.kind === "discover_clue"), "automatic discovery must discover its real clue");
        break;
      }
      case "item_binding": {
        if (initialIds.has(question.id)) {
          assertEqual(value.itemType, "loot", "human-reviewed dream-stone binding must remain loot");
          const evidence = value.itemNameEvidence as { quote?: string } | undefined;
          assertEqual(evidence?.quote, "梦境之石", "human-reviewed dream-stone evidence quote");
        } else {
          assertEqual(value.itemType, null, "automatic item binding must remain source-only");
          assert(value.itemNameEvidence === undefined, "automatic source-only item binding must not invent name evidence");
        }
        break;
      }
      case "npc_binding": {
        if (question.id === randyQuestion.id) {
          assert(initialIds.has(question.id), "Randy must remain initially human reviewed");
          const presentNpcs = value.presentNpcs as Array<{ nameQuote?: unknown; dialogueMethods?: unknown; encounter?: unknown }>;
          assert(Array.isArray(presentNpcs) && presentNpcs.length === 1, "human-reviewed Randy binding must retain exactly one NPC");
          assertEqual(presentNpcs[0]!.nameQuote, FUZU_RANDY_NAME_QUOTE, "human-reviewed Randy binding must retain exact name quote");
          assert(Array.isArray(presentNpcs[0]!.dialogueMethods) && presentNpcs[0]!.dialogueMethods.length === 0, "human-reviewed Randy binding must remain static");
          assert(presentNpcs[0]!.encounter === undefined, "human-reviewed Randy binding must not gain an encounter");
        } else if (question.id === doctor.susanQuestion.id) {
          assert(!initialIds.has(question.id), "Susan must be resolved automatically rather than by an initial human answer");
          assertEqual(resolution.reviewerKind, "approved_policy", "automatic Susan binding reviewer kind");
          assert(resolution.audit?.producer !== undefined, "automatic Susan binding must retain producer provenance");
          const presentNpcs = value.presentNpcs as Array<{ nameQuote?: unknown; dialogueMethods?: Array<{ relationshipEvidence?: { statementId?: unknown; quote?: unknown }; mechanismId?: unknown; onSuccess?: unknown; encounter?: unknown }> }>;
          assert(Array.isArray(presentNpcs) && presentNpcs.length === 1, "automatic Susan binding must retain exactly one NPC");
          const susan = presentNpcs[0]!;
          assertEqual(susan.nameQuote, FUZU_SUSAN_NAME_QUOTE, "automatic Susan binding exact source name");
          assert(Array.isArray(susan.dialogueMethods) && susan.dialogueMethods.length === 1, "automatic Susan binding must retain one prose dialogue method");
          const dialogue = susan.dialogueMethods[0]!;
          assertEqual(dialogue.mechanismId, undefined, "automatic Susan prose dialogue must let the compiler derive its mechanism id");
          assertEqual(dialogue.relationshipEvidence?.statementId, doctor.paragraph.id, "automatic Susan relationship statement");
          assertEqual(dialogue.relationshipEvidence?.quote, FUZU_SUSAN_DIALOGUE_FACT, "automatic Susan relationship quote");
          const citations = resolution.audit?.citations ?? [];
          assertSameStrings(citations.map((citation) => `${citation.claimKey}\u0000${citation.statementId}\u0000${citation.quote}`).sort(), [
            `npc_binding:${doctor.susanAnchor.id}:0:name\u0000${doctor.paragraph.id}\u0000${FUZU_SUSAN_NAME_QUOTE}`,
            `npc_binding:${doctor.susanAnchor.id}:0:relationship:0\u0000${doctor.paragraph.id}\u0000${FUZU_SUSAN_DIALOGUE_FACT}`,
          ].sort(), "automatic Susan binding source-exact NPC citation contract");
        } else {
          assert(!initialIds.has(question.id), "only Randy may be an initial Fuzu NPC binding");
          assert(Array.isArray(value.presentNpcs) && value.presentNpcs.length === 0, "automatic NPC binding must remain explicitly empty");
        }
        break;
      }
      case "reward_binding": assertEqual(value.declaration, null, "automatic reward binding must remain source-only"); break;
      case "source_fact_disposition": {
        // The one reviewed arrival root is intentionally mechanical; all
        // remaining automatic source roots stay explicitly source-only.
        assertEqual(value.disposition, initialIds.has(question.id) ? "mechanics_candidate" : "source_only", "source disposition must preserve its reviewed policy");
        break;
      }
    }
  }
}

async function continueAutomaticResolution(
  catalog: CompilerArtifactCatalog,
  preparedResponse: PreparedHttpResponse,
  prepared: PreparedCompilerArtifactPayload,
  initialHints: ModuleCompileHints,
): Promise<{ artifact: CompilerArtifactEnvelope; payload: ResolvedCompilerArtifactPayload; quality: ReturnType<typeof summarizeCompilerRuntimeQuality>; requests: number; modelCalls: number; artifactHash: string }> {
  const llm = new DeterministicFuzuAutoLLM();
  const dependencyConstruction: AutoDependencyConstruction = { builds: 0, admissions: new Set() };
  // Keep the automatic continuation lease beside the ephemeral prepared
  // artifact it protects.  An unrooted controller would coordinate through
  // the process default catalog and make this isolated acceptance dependent
  // on (and able to mutate) server data.
  const admission = createFuzuAcceptanceAutoAdmission(catalog.root);
  const dependencies = autoCatalogDependencies(catalog, llm, admission, dependencyConstruction);
  assertEqual(dependencyConstruction.builds, 1, "automatic HTTP dependencies must be constructed once per acceptance run");
  assertEqual(dependencyConstruction.admissions.size, 1, "automatic HTTP admission must be constructed once per acceptance run");
  assert(dependencies.autoCompiler?.admission === admission, "automatic HTTP dependencies must retain the shared admission controller identity");
  const sourceProse = meaningfulSourceProse(prepared);
  let continuationId: string | undefined;
  // Do not couple the first continuation assertion to a historical Fuzu
  // count.  The initial hints are already validated by the real resolver;
  // derive this run's baseline from that resulting queue so a schema change
  // cannot turn a stale constant into either a false red or a hidden stall.
  const initialQueue = applyModuleCompileHints(prepared.graph, prepared.preparedQueue, initialHints);
  let previousOpenQuestions = countOpenCompilerQuestions(initialQueue.questions);
  let requests = 0;
  let lastPublic: PublicAutoResolveResponse | undefined;
  for (let index = 0; index < AUTO_CONTINUATION_REQUEST_LIMIT; index++) {
    const body = continuationId
      ? { preparedArtifactId: preparedResponse.preparedArtifactId, preparedQueueHash: preparedResponse.identity.preparedQueueHash, autoContinuationId: continuationId }
      : { preparedArtifactId: preparedResponse.preparedArtifactId, preparedQueueHash: preparedResponse.identity.preparedQueueHash, explicitHints: initialHints };
    const response = await handleCompiledModuleHttpRequest(
      new Request("http://internal.invalid/api/compiler/auto-resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      dependencies,
    );
    assert(response !== null, "internal HTTP automatic resolve route must respond");
    assertEqual(response.status, 200, "internal HTTP automatic resolve status");
    const publicResponse = await response.json() as PublicAutoResolveResponse;
    assertPublicAutoResponse(publicResponse, preparedResponse.preparedArtifactId, index > 0, previousOpenQuestions, llm.lastReply, sourceProse);
    if (index === 0) {
      assertEqual(publicResponse.content.dispositionReadiness, "incomplete", "one bounded automatic request must leave real Fuzu source disposition open");
      assert(publicResponse.content.openQuestionCount > 0, "one bounded automatic request must leave real Fuzu open questions");
    }
    if (continuationId) assert(publicResponse.continuationId !== continuationId, "automatic continuation must advance to a fresh opaque id after progress");
    continuationId = publicResponse.continuationId;
    previousOpenQuestions = publicResponse.content.openQuestionCount;
    lastPublic = publicResponse;
    requests++;
    if (publicResponse.content.dispositionReadiness === "complete") break;
  }
  assert(lastPublic !== undefined && lastPublic.content.dispositionReadiness === "complete", "automatic continuation request bound must reach complete source disposition");
  assertEqual(dependencyConstruction.builds, 1, "automatic HTTP dependencies must be constructed once per acceptance run");
  assertEqual(dependencyConstruction.admissions.size, 1, "automatic HTTP admission must be shared for every continuation request");
  assertEqual(lastPublic.content.openQuestionCount, 0, "automatic public final open question count");
  assertEqual(lastPublic.content.openRootCount, 0, "automatic public final open root count");
  assertEqual(lastPublic.content.unmodeledRootCount, 0, "automatic public final unmodeled root count");
  assertEqual(requests, EXPECTED_AUTO_CONTINUATION_REQUESTS, "automatic continuation request count");
  assertEqual(llm.calls.length, EXPECTED_AUTO_MODEL_CALLS, "automatic model call count");
  assert(llm.calls.every((call) => autoPromptEnvelope(call.messages).questions.every((question) => question.kind !== "source_fact_mechanic")), "automatic source-only continuation must never send deferred/not-applicable source fact children to the model");
  assert(continuationId !== undefined, "automatic final continuation id");
  const loadedPrepared = catalog.loadPrepared(preparedResponse.preparedArtifactId);
  assert(loadedPrepared.status === "ok", "automatic final prepared catalog entry must load");
  const loadedContinuation = catalog.loadAutoResolveContinuation(continuationId);
  assert(loadedContinuation.status === "ok", "automatic final continuation must load privately");
  const validatedContinuation = catalog.validateAutoResolveContinuationHints(loadedContinuation.value, loadedPrepared.value.artifact);
  assert(validatedContinuation.status === "ok", "automatic final continuation hints must validate against the catalog-restored prepared artifact");
  assertFullyValidatedAutoHints(validatedContinuation.value.hints, prepared, initialHints);
  const resolved = resolveCompiler(loadedPrepared.value.artifact, preparedResponse.identity.preparedQueueHash, validatedContinuation.value.hints);
  assert(resolved.status === "resolved", "fully answered private automatic continuation must resolve current prepared artifact");
  const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
  const quality = assertFullyAutoResolvedStructure(payload);
  return { artifact: resolved.artifact, payload, quality, requests, modelCalls: llm.calls.length, artifactHash: resolved.artifact.artifactHash };
}

export async function compileCurrentFuzuAcceptance(pdfPath: string): Promise<CurrentFuzuAcceptanceResult>;
export async function compileCurrentFuzuAcceptance<T>(
  pdfPath: string,
  onResolved: (context: CurrentFuzuResolvedBenchmarkContext) => T | Promise<T>,
): Promise<T>;
export async function compileCurrentFuzuAcceptance<T>(
  pdfPath: string,
  onResolved?: (context: CurrentFuzuResolvedBenchmarkContext) => T | Promise<T>,
): Promise<CurrentFuzuAcceptanceResult | T> {
  const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
  assertEqual(pdfBytes.length, EXPECTED_PDF_BYTES, "PDF byte length");
  assertEqual(sha256(pdfBytes), EXPECTED_DOCUMENT_HASH, "PDF SHA-256");
  assertEqual(new TextDecoder().decode(pdfBytes.subarray(0, EXPECTED_PDF_HEADER.length)), EXPECTED_PDF_HEADER, "PDF header");

  const temporaryCatalogRoot = mkdtempSync(join(tmpdir(), "fuzu-current-schema-"));
  try {
    const catalog = new CompilerArtifactCatalog({ root: temporaryCatalogRoot });
    const response = await handleCompiledModuleHttpRequest(
      new Request("http://internal.invalid/api/compiler/prepare?moduleId=fuzu", {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: pdfBytes,
      }),
      catalogDependencies(catalog),
    );
    assert(response !== null, "internal HTTP prepare route must respond");
    if (response.status !== 201) fail(`internal HTTP prepare status: expected 201, received ${response.status}; ${await response.text()}`);
    const preparedResponse = await response.json() as PreparedHttpResponse;
    const currentPrepared = preparedPayloadFromHttp(preparedResponse, catalog);
    assertPreparedStructure(currentPrepared);

    assertEqual(currentPrepared.preparedQueue.queueHash, preparedResponse.identity.preparedQueueHash, "prepared HTTP/current queue hash");
    const reviewedAnswers = materializeFuzuReviewedHints(await readFuzuReviewedAnswersFixture(), {
      moduleId: currentPrepared.identity.moduleId,
      documentHash: currentPrepared.identity.documentHash,
      sourceGraphIdentity: currentPrepared.identity.sourceGraphIdentity,
      preparedQueueHash: currentPrepared.preparedQueue.queueHash,
      queueSchemaVersion: currentPrepared.preparedQueue.schemaVersion,
      questions: currentPrepared.preparedQueue.questions,
    });
    const humanHintsWithoutFacets = addCourtyardRandyHumanBinding(
      currentPrepared,
      addDreamStoneHumanBinding(currentPrepared, addFuzuCameraProseFinding(currentPrepared, addFuzuArrivalShellTransitions(currentPrepared, reviewedAnswers))),
    );
    // The source-specific proposal-path regression includes deliberate
    // negative attempts.  It remains part of the full acceptance result, but
    // a bounded callback needs only the positive fresh prepare/resolve chain.
    if (!onResolved) await assertFuzuAutomaticFacetProposalPath(currentPrepared, humanHintsWithoutFacets);
    const currentHints = addFuzuClueFactFacetHumanBindings(currentPrepared, humanHintsWithoutFacets);
    const initialResolved = resolveCompiler(preparedResponse.artifact, preparedResponse.identity.preparedQueueHash, currentHints);
    assert(initialResolved.status === "resolved", "current PDF must resolve from tracked reviewed human hints");
    assertInitialResolvedStructure(initialResolved.artifact.payload as ResolvedCompilerArtifactPayload);
    const automatic = await continueAutomaticResolution(catalog, preparedResponse, currentPrepared, currentHints);
    const payload = automatic.payload;
    const quality = automatic.quality;
    if (onResolved) {
      const prepared = catalog.loadPrepared(preparedResponse.preparedArtifactId);
      assert(prepared.status === "ok", "fresh Fuzu prepared artifact must remain catalog-resolvable during callback");
      return await onResolved({
        catalog,
        preparedArtifactId: preparedResponse.preparedArtifactId,
        preparedArtifact: prepared.value.artifact,
        prepared: currentPrepared,
        initialResolvedArtifact: initialResolved.artifact,
        resolvedArtifact: automatic.artifact,
        payload,
      });
    }
    // This fresh PDF is bounded by control-relevant state classes. Pure
    // optional findings retain complete replay hashes but do not multiply the
    // closed-world search budget; keep this measured count explicit.
    assertEqual(payload.reachabilityReport.reachableStateCount, 227, "Fuzu closed-world reachability state budget evidence");

    const witnesses = payload.reachabilityReport.endingWitnesses;
    assertSameStrings(Object.keys(witnesses).sort(), [...EXPECTED_ENDINGS].sort(), "ending witness keys");
    for (const endingId of EXPECTED_ENDINGS) {
      const witness = witnesses[endingId];
      assert(witness !== undefined, "ending witness must exist");
      assertEqual(replayMechanicsWitness(payload.mechanicsIR, payload.analysisInput, witness).terminalEndingId, endingId, "replayed ending witness");
    }
    const withStoneSteps = playerWitnessSteps(witnesses.escape_with_dream_stone!);
    const withoutStoneSteps = playerWitnessSteps(witnesses.lost_without_dream_stone!);
    const dreamStoneActions = withStoneSteps.filter((step) => !withoutStoneSteps.some((other) => other.mechanismId === step.mechanismId));
    assertEqual(dreamStoneActions.length, 1, "with-dream-stone witness-only action count");
    assert(payload.mechanicsIR.discoveryMethods.some((method) => method.id === dreamStoneActions[0]!.mechanismId && (!method.check || method.check.kind === "none")), "with-dream-stone witness action must be an unchecked discovery");

    const projection = projectResolvedCompilerArtifact(payload, exactSourcePresentation(payload));
    assert(projection.status === "projected", "current exact-source presentation projection");
    assertFuzuFacetSemantics(payload, projection);
    await assertFuzuCheckedFindingsGameSession(payload, projection, witnesses.escape_with_dream_stone!);
    assertEqual(projection.module.items.length, 1, "Fuzu projection runtime item count");
    assertEqual(projection.module.npcs.length, 2, "Fuzu projection runtime NPC count");
    const randyBinding = fuzuCourtyardRandyBinding(payload);
    const randyNpc = projection.module.npcs.find((npc) => npc.id === randyBinding.npcId);
    assert(randyNpc !== undefined && randyNpc.name === FUZU_RANDY_NAME_QUOTE, "Fuzu projection static NPC must display exact reviewed name");
    assertEqual(randyNpc.sceneId, randyBinding.sceneCandidateId, "Fuzu projection static NPC must remain in reviewed courtyard scene");
    const randyOrigin = projection.sourceMap.npcs[randyBinding.npcId]?.fields.name;
    assert(randyOrigin?.kind === "resolved_question", "Fuzu projection static NPC name must retain source-map provenance");
    assertSameStrings(randyOrigin.quotes.map((quote) => `${quote.statementId}\u0000${quote.quote}`), [`${randyBinding.paragraphStatementId}\u0000${FUZU_RANDY_NAME_QUOTE}`], "Fuzu projection static NPC source-map exact name quote");
    const dreamStoneBinding = payload.itemBindings[0];
    assert(dreamStoneBinding !== undefined && dreamStoneBinding.itemType === "loot", "Fuzu resolved dream-stone loot binding");
    const dreamStoneItem = projection.module.items.find((item) => item.id === dreamStoneBinding.itemId);
    assert(dreamStoneItem !== undefined && dreamStoneItem.name === "梦境之石", "Fuzu runtime item must display its exact reviewed body quote");
    const dreamStoneOrigin = projection.sourceMap.items[dreamStoneBinding.itemId]?.fields.name;
    assert(dreamStoneOrigin?.kind === "resolved_question", "Fuzu runtime item name must retain source-map provenance");
    assertSameStrings(dreamStoneOrigin.quotes.map((quote) => `${quote.statementId}\u0000${quote.quote}`), [`${dreamStoneBinding.itemNameStatementId}\u0000梦境之石`], "Fuzu runtime item source-map exact name quote");
    const gameSessions = [
      await replayGameSession("fuzu-current-schema-with-stone", payload, projection, "escape_with_dream_stone", witnesses.escape_with_dream_stone!),
      await replayGameSession("fuzu-current-schema-without-stone", payload, projection, "lost_without_dream_stone", witnesses.lost_without_dream_stone!),
    ];
    await replayDurableGameSession("fuzu-current-schema-durable-with-stone", automatic.artifact, projection, "escape_with_dream_stone", witnesses.escape_with_dream_stone!, gameSessions[0]!, temporaryCatalogRoot);
    await replayDurableGameSession("fuzu-current-schema-durable-without-stone", automatic.artifact, projection, "lost_without_dream_stone", witnesses.lost_without_dream_stone!, gameSessions[1]!, temporaryCatalogRoot);
    assertEqual(gameSessions[0]!.playerActions, 5, "with-dream-stone witness player action count");
    assertEqual(gameSessions[1]!.playerActions, 4, "without-dream-stone witness player action count");
    await assertCourtyardRandyGameSession(payload, projection, EXPECTED_ENDINGS.map((endingId) => witnesses[endingId]!));
    await assertFuzuDoctorDialogueGameSession(payload, projection);
    assert(gameSessions[0]!.ownedItemIds.includes(dreamStoneBinding.itemId), "with-dream-stone GameSession must own the reviewed loot");
    assert(!gameSessions[1]!.ownedItemIds.includes(dreamStoneBinding.itemId), "without-dream-stone GameSession must not own the reviewed loot");

    const aggregate: AcceptanceAggregate = {
      acceptance: "fuzu-current-schema-internal",
      documentHash: EXPECTED_DOCUMENT_HASH,
      artifactHash: automatic.artifactHash,
      pdf: { bytes: pdfBytes.length, pages: currentPrepared.graph.documentIdentity.pages.length, hashSource: "pdf_bytes_sha256" },
      prepared: {
        sceneCandidates: currentPrepared.draft.sceneCandidates.length,
        clueCandidates: currentPrepared.draft.clueCandidates.length,
        itemCandidates: currentPrepared.draft.itemCandidates.length,
        proseNpcAnchors: currentPrepared.draft.proseNpcAnchors.length,
        rewardCandidates: currentPrepared.draft.rewardCandidates.length,
        questions: currentPrepared.preparedQueue.questions.length,
        sourceFactMechanicChildren: sourceFactMechanicChildQuestions(currentPrepared.preparedQueue.questions).length,
      },
      rebinding: {
        reviewedHumanAnswers: 50,
        addedCurrentHumanReviews: 9,
        answeredQuestions: 59,
        openQuestions: 138,
        deferredQuestions: sourceFactMechanicChildQuestions((initialResolved.artifact.payload as ResolvedCompilerArtifactPayload).resolvedQueue.questions).length - 2,
      },
      autoContinuation: {
        requests: automatic.requests,
        modelCalls: automatic.modelCalls,
        answeredQuestions: CURRENT_PREPARED_QUESTION_COUNT,
        openQuestions: 0,
        notApplicableQuestions: sourceFactMechanicChildQuestions(payload.resolvedQueue.questions).length,
        contentReady: true,
        runtime: {
          discoveryMethods: quality.coverage.discoveryMethods,
          runtimeItems: quality.coverage.runtimeItems,
          boundNpcs: quality.coverage.boundNpcs,
          dialogueMethods: quality.coverage.dialogueMethods,
          runtimeRewards: quality.coverage.runtimeRewards,
          reachableEndings: quality.coverage.reachableEndings,
        },
      },
      resolution: { mechanicallyClosed: true, publishBlockingQuestions: 0, reachableEndings: [...EXPECTED_ENDINGS].sort(), issueCount: 0, reachableStateCount: payload.reachabilityReport.reachableStateCount },
      quality: {
        dispositionReadiness: quality.sourceRootDisposition.dispositionReadiness,
        coverage: { ...quality.coverage },
        closedWorldIssueCounts: { ...quality.closedWorldIssueCounts },
      },
      runtime: { replayedEndingWitnesses: EXPECTED_ENDINGS.length, gameSessions },
    };
    return { aggregate, artifact: automatic.artifact, payload, projection };
  } finally {
    rmSync(temporaryCatalogRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;

  void Promise.resolve()
    .then(() => compileCurrentFuzuAcceptance(parsePdfArgument(process.argv.slice(2))))
    .then(({ aggregate }) => {
      // Successful stdout intentionally contains only aggregate/hash/count/ending facts.
      console.log = originalConsoleLog;
      console.warn = originalConsoleWarn;
      originalConsoleLog(JSON.stringify(aggregate));
    })
    .catch((error: unknown) => {
      console.log = originalConsoleLog;
      console.warn = originalConsoleWarn;
      console.error(`fuzu current-schema acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
