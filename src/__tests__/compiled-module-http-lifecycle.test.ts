import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCompiledSessionAccessBinding, handleCompiledModuleHttpRequest, COMPILER_HTTP_BODY_LIMIT_BYTES, COMPILER_HTTP_PDF_BODY_LIMIT_BYTES, type CompiledModuleHttpDependencies, type MachinePresentationSelectionInput } from "../api/compiled-module-http";
import { createServerMachinePresentationPublisher } from "../api/compiler-machine-presentation-publisher";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import {
  buildTrustedPresentationReviewCandidatePage,
  buildTrustedPresentationReviewSlotPage,
  buildTrustedPresentationSelectionCandidatePage,
  buildTrustedPresentationSelectionSlotPage,
  rehydrateTrustedPresentationSelections,
  TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE,
  TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE,
  trustedPresentationMachineCoverageIdentity,
  trustedPresentationMachineDecisionIdentity,
  validateTrustedPresentationReviewBindingAttempts,
  validateTrustedPresentationReviewBindings,
} from "../compiler/compiler-module-data-projection";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { summarizeCompilerRuntimeQuality } from "../compiler/compiler-runtime-quality";
import { CompilerArtifactCatalog, compilerArtifactCatalogNodeFileOps } from "../compiler/compiler-artifact-catalog";
import { CompiledWorldModelBindingRegistry } from "../world/compiled-world-model-binding-registry";
import { CompiledSessionSnapshotPersistenceError, CompiledSessionSnapshotStore as CompiledSessionSnapshotStoreImplementation, type CompiledSessionSnapshot, type CompiledSessionSnapshotStoreOptions } from "../api/compiled-session-snapshot";
import { mechanicsStateHash } from "../compiler/mechanics-execution";
import { commitCompiledDurableAction, GameSession } from "../api/game-session";
import { handleRequest, hydrateCompiledSessions } from "../api/server";
import type { ChatOptions, LLMLike, Message } from "../llm/client";
import { orchestratePreparedAutoCompiler } from "../api/compiler-auto-orchestrator";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { sha256 } from "../ingest/document-ir";
import { CompilerAutoAdmissionController, DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG } from "../api/compiler-auto-admission";
import { CompiledSessionCreationAdmissionCoordinator, COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY } from "../api/compiled-session-creation-admission";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { isolatedNativeFetchIt } from "./helpers/isolated-native-fetch";

/** Direct snapshot setup in this lifecycle suite is an explicit test-only seam. */
class CompiledSessionSnapshotStore extends CompiledSessionSnapshotStoreImplementation {
  constructor(options: CompiledSessionSnapshotStoreOptions = {}) {
    super({ ...options, allowUncoordinatedTestWrites: true });
  }
}

const PAGES = ["入口：\n▶父线索：一把档案室钥匙。\n档案室：\n▶子线索：一份必须读懂的档案。\n出口：\n▶出口说明：离开这里的旧车票。"];

const nativeFetchIt = isolatedNativeFetchIt(
  "src/__tests__/compiled-module-http-lifecycle.test.ts",
  "compiled module HTTP lifecycle",
);

async function withMockedRandom<T>(random: () => number, callback: () => T | Promise<T>): Promise<T> {
  const originalRandom = Math.random;
  Math.random = random;
  try {
    return await callback();
  } finally {
    Math.random = originalRandom;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function continuationHash(envelope: Record<string, unknown>): string {
  const { continuationHash: _continuationHash, ...unsigned } = envelope;
  return sha256(canonicalJson(unsigned));
}

function answer(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
  return { questionId: question.id, kind: question.kind, value, sourceStatementIds: [...question.sourceStatementIds], evidenceRefs: [...question.evidenceRefs], authority: "user_document", derivation: "explicit", reviewerKind: "human", rightsStatus: "user_provided", reason: "HTTP lifecycle fixture" };
}

function hints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const scene = (name: string) => draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(name))!;
  const clue = (name: string) => draft.clueCandidates.find((candidate) => candidate.displayName === name)!;
  const entry = scene("入口"), archive = scene("档案室"), exit = scene("出口"), parent = clue("父线索"), child = clue("子线索");
  const topology = (id: string) => queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === id)!;
  const core = (id: string) => queue.questions.find((question) => question.kind === "core_clue" && question.subjectCandidateId === id)!;
  const discovery = (id: string) => queue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === id)!;
  return { schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION, moduleId: queue.moduleId, documentHash: queue.documentHash, sourceGraphIdentity: queue.sourceGraphIdentity, resolutions: [
    ...queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => answer(question, { shell: (question.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [] })),
    ...queue.questions.filter((question) => question.kind === "scene_role").map((question) => answer(question, { role: "playable_scene" })),
    answer(queue.questions.find((question) => question.kind === "entry_scene")!, { sceneCandidateId: entry.id }),
    answer(topology(entry.id), { connections: [{ toSceneCandidateId: archive.id, connectionId: "entry_archive", availability: { kind: "connection_unlocked", connectionId: "entry_archive" } }] }),
    answer(topology(archive.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "archive_exit" }] }), answer(topology(exit.id), { connections: [] }),
    answer(core(parent.id), { clueCandidateId: parent.id, required: false }), answer(core(child.id), { clueCandidateId: child.id, required: true }),
    answer(discovery(parent.id), { clueCandidateId: parent.id, locationSceneCandidateId: entry.id, spec: { kind: "discovery_method", id: "find_parent", clueId: parent.id, action: "search", target: "scene", targetId: entry.id, onSuccess: [{ kind: "discover_clue", clueId: parent.id }, { kind: "unlock_connection", connectionId: "entry_archive" }] } }),
    answer(discovery(child.id), { clueCandidateId: child.id, locationSceneCandidateId: archive.id, spec: { kind: "discovery_method", id: "find_child", clueId: child.id, action: "read", target: "scene", targetId: archive.id, availability: { kind: "clue_found", clueId: parent.id }, check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: child.id }], failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: child.id }] } } }),
    answer(queue.questions.find((question) => question.kind === "ending_rule")!, { declarations: [
      { endingId: "clean", spec: { kind: "ending_rule", id: "rule_clean", priority: 10, when: { kind: "all", predicates: [{ kind: "clue_found", clueId: child.id }, { kind: "scene_visited", sceneId: exit.id }] }, effects: [{ kind: "end_game", endingId: "clean" }] } },
      { endingId: "hasty", spec: { kind: "ending_rule", id: "rule_hasty", priority: 20, when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "not", predicate: { kind: "clue_found", clueId: child.id } }] }, effects: [{ kind: "end_game", endingId: "hasty" }] } },
    ] }),
  ] };
}

function firstPathHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const [entry, archive, exit] = draft.sceneCandidates;
  const [parent, child] = draft.clueCandidates;
  if (!entry || !archive || !exit || !parent || !child) throw new Error("real PDF fixture did not produce the required path candidates");
  const topology = (id: string) => queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === id)!;
  const core = (id: string) => queue.questions.find((question) => question.kind === "core_clue" && question.subjectCandidateId === id)!;
  const discovery = (id: string) => queue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === id)!;
  return { schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION, moduleId: queue.moduleId, documentHash: queue.documentHash, sourceGraphIdentity: queue.sourceGraphIdentity, resolutions: [
    ...queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => answer(question, { shell: (question.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [] })),
    ...queue.questions.filter((question) => question.kind === "scene_role").map((question) => answer(question, { role: "playable_scene" })),
    answer(queue.questions.find((question) => question.kind === "entry_scene")!, { sceneCandidateId: entry.id }),
    answer(topology(entry.id), { connections: [{ toSceneCandidateId: archive.id, connectionId: "entry_archive", availability: { kind: "connection_unlocked", connectionId: "entry_archive" } }] }),
    answer(topology(archive.id), { connections: [{ toSceneCandidateId: exit.id, connectionId: "archive_exit" }] }), answer(topology(exit.id), { connections: [] }),
    answer(core(parent.id), { clueCandidateId: parent.id, required: false }), answer(core(child.id), { clueCandidateId: child.id, required: true }),
    answer(discovery(parent.id), { clueCandidateId: parent.id, locationSceneCandidateId: entry.id, spec: { kind: "discovery_method", id: "find_parent", clueId: parent.id, action: "search", target: "scene", targetId: entry.id, onSuccess: [{ kind: "discover_clue", clueId: parent.id }, { kind: "unlock_connection", connectionId: "entry_archive" }] } }),
    answer(discovery(child.id), { clueCandidateId: child.id, locationSceneCandidateId: archive.id, spec: { kind: "discovery_method", id: "find_child", clueId: child.id, action: "read", target: "scene", targetId: archive.id, availability: { kind: "clue_found", clueId: parent.id }, check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: child.id }], failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: child.id }] } } }),
    answer(queue.questions.find((question) => question.kind === "ending_rule")!, { declarations: [
      { endingId: "clean", spec: { kind: "ending_rule", id: "rule_clean", priority: 10, when: { kind: "all", predicates: [{ kind: "clue_found", clueId: child.id }, { kind: "scene_visited", sceneId: exit.id }] }, effects: [{ kind: "end_game", endingId: "clean" }] } },
      { endingId: "hasty", spec: { kind: "ending_rule", id: "rule_hasty", priority: 20, when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "not", predicate: { kind: "clue_found", clueId: child.id } }] }, effects: [{ kind: "end_game", endingId: "hasty" }] } },
    ] }),
  ] };
}

function pdf(text: string): Uint8Array {
  const hex = (value: string) => [...value].map((character) => character.codePointAt(0)!.toString(16).padStart(4, "0")).join("");
  const lines = text.split("\n").map((line) => `<${hex(line)}> Tj\nT*`).join("\n");
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n20 TL\n${lines}\nET\n`;
  const byteLength = (value: string) => new TextEncoder().encode(value).length;
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /Helvetica /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Helvetica /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /CIDToGIDMap /Identity >>",
    `<< /Length ${byteLength(cmap)} >>\nstream\n${cmap}endstream`,
    "<< /Type /FontDescriptor /FontName /Helvetica /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>",
  ];
  let out = "%PDF-1.4\n"; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(byteLength(out)); out += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = byteLength(out); out += `xref\n0 9\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function stream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const dependencyCatalogRoots = new Set<string>();
const dependencySessions = new Set<GameSession>();

afterEach(() => {
  for (const session of dependencySessions) session.close();
  dependencySessions.clear();
  for (const root of dependencyCatalogRoots) rmSync(root, { recursive: true, force: true });
  dependencyCatalogRoots.clear();
});

function dependencies(calls = { factory: 0, registered: 0, persisted: 0 }, catalog?: CompilerArtifactCatalog): CompiledModuleHttpDependencies {
  if (!catalog) {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-dependency-"));
    dependencyCatalogRoots.add(root);
    catalog = new CompilerArtifactCatalog({ root });
  }
  const sessionRoot = mkdtempSync(join(tmpdir(), "compiled-http-dependency-session-"));
  dependencyCatalogRoots.add(sessionRoot);
  const compiledDurableHostCapability = Object.freeze(Object.create(null)) as object;
  return {
    compiledDurableHostCapability,
    compiledSessionCreationAdmission: new CompiledSessionCreationAdmissionCoordinator({
      root: sessionRoot,
      ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
    }),
    generateId: () => "compiled1",
    hasSession: () => false,
    createSession: (id, archetype, characterName, persona) => {
      calls.factory++;
      const session = new GameSession(
        id,
        "cosmic-horror",
        { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 },
        archetype,
        characterName,
        persona,
        { careerRoot: join(sessionRoot, "careers") },
        undefined,
        "preferred",
        { compiledDurableHostCapability },
      );
      dependencySessions.add(session);
      return session;
    },
    registerSession: () => { calls.registered++; },
    persistSession: () => { calls.persisted++; },
    authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: "operator:test", role: "operator" } }),
    catalog,
  };
}

const operatorAuthenticator = () => ({ status: "authenticated" as const, principal: { id: "operator:test", role: "operator" as const } });

/** AbortSignal is a live capability; test recordings clone only data fields. */
function snapshotChatOptions(options: ChatOptions | undefined): ChatOptions | undefined {
  if (!options) return undefined;
  const { signal, ...serializable } = options;
  return { ...structuredClone(serializable), ...(signal ? { signal } : {}) };
}

interface AutoPromptQuestion {
  questionId: string;
  kind: string;
  prompt: string;
  sourceStatements: Array<{ statementId: string; text: string }>;
  candidateDomains: {
    subjectCandidateId?: string;
    allowedCandidateIds?: string[];
    allowedLocationCandidateIds?: string[];
    allowedMechanicsTargetIds?: Record<string, string[]>;
    allowedItemNameEvidenceStatementIds?: string[];
    allowedClueFactAtoms?: Array<{ atomId: string; quote: string; statementId: string }>;
  };
}

interface AutoPromptEnvelope {
  questions: AutoPromptQuestion[];
  candidateCatalog: Array<{ id: string; kind: string; label: string }>;
}

class AutoFakeLLM implements LLMLike {
  readonly calls: Array<{ messages: Message[]; options?: ChatOptions }> = [];

  constructor(private readonly reply: string | Error | ((messages: Message[], call: number) => string | Error)) {}

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    const call = this.calls.length;
    this.calls.push({ messages: structuredClone(messages), options: snapshotChatOptions(options) });
    const response = typeof this.reply === "function" ? this.reply(messages, call) : this.reply;
    if (response instanceof Error) throw response;
    return response;
  }
}

function autoEnvelope(messages: Message[]): AutoPromptEnvelope {
  const content = messages[1]?.content ?? "";
  const marker = "REQUEST ENVELOPE:\n";
  return JSON.parse(content.slice(content.lastIndexOf(marker) + marker.length)) as AutoPromptEnvelope;
}

function autoCitation(question: AutoPromptQuestion, claimKey: string) {
  const source = question.sourceStatements[0]!;
  return { claimKey, statementId: source.statementId, quote: source.text };
}

function autoItemCitation(question: AutoPromptQuestion) {
  const source = question.sourceStatements.find((statement) => statement.statementId.endsWith(":statement:name"));
  if (!source) throw new Error("item binding prompt lacks its exact marked-name statement");
  return { claimKey: `item_binding:${question.candidateDomains.subjectCandidateId}`, statementId: source.statementId, quote: source.text };
}

function autoItemNameEvidence(question: AutoPromptQuestion) {
  const statementId = question.candidateDomains.allowedItemNameEvidenceStatementIds?.[0];
  const source = question.sourceStatements.find((statement) => statement.statementId === statementId);
  if (!statementId || !source) throw new Error("item binding prompt lacks its candidate-local name evidence domain");
  return { statementId, quote: source.text };
}

/** A deterministic stand-in for a model: it only returns proposals from the prompt's domains. */
function fullAutoReply(messages: Message[]): string {
  const envelope = autoEnvelope(messages);
  const sceneId = (label: string) => envelope.candidateCatalog.find((candidate) => candidate.kind === "scene" && candidate.label.startsWith(label))?.id;
  const entrySceneId = sceneId("入口") ?? envelope.questions.find((question) => question.kind === "entry_scene")?.candidateDomains.allowedCandidateIds?.[0]!;
  const archiveSceneId = sceneId("档案室") ?? entrySceneId;
  const exitSceneId = sceneId("出口") ?? entrySceneId;
  const proposals = envelope.questions.map((question) => {
    const clueId = question.candidateDomains.subjectCandidateId!;
    switch (question.kind) {
      case "scene_role": return { questionId: question.questionId, kind: question.kind, value: { role: "playable_scene" }, citations: [autoCitation(question, "scene_role")] };
      case "entry_scene": return { questionId: question.questionId, kind: question.kind, value: { sceneCandidateId: entrySceneId }, citations: [autoCitation(question, "entry_scene")] };
      case "connection_topology": {
        const nextSceneId = question.prompt?.includes("入口") ? archiveSceneId : question.prompt?.includes("档案室") ? exitSceneId : undefined;
        const connectionId = `connection_auto_${question.questionId.slice(-8)}`;
        return { questionId: question.questionId, kind: question.kind, value: { connections: nextSceneId ? [{ toSceneCandidateId: nextSceneId, connectionId }] : [] }, citations: [autoCitation(question, nextSceneId ? `connection:${connectionId}` : "topology")] };
      }
      case "core_clue": return { questionId: question.questionId, kind: question.kind, value: { clueCandidateId: clueId, required: question.sourceStatements[0]?.text.includes("必须读懂") ?? false }, citations: [autoCitation(question, "core_clue")] };
      case "item_binding": return {
        questionId: question.questionId,
        kind: question.kind,
        value: { itemCandidateId: clueId, itemType: "key", itemNameEvidence: autoItemNameEvidence(question) },
        citations: [autoItemCitation(question)],
      };
      case "discovery_method": {
        const locationSceneCandidateId = question.candidateDomains.allowedLocationCandidateIds![0]!;
        const targetId = question.candidateDomains.allowedMechanicsTargetIds!.scene![0]!;
        const id = `discovery_auto_${question.questionId.slice(-8)}`;
        return { questionId: question.questionId, kind: question.kind, value: { clueCandidateId: clueId, locationSceneCandidateId, spec: { kind: "discovery_method", id, clueId, action: "search", target: "scene", targetId, onSuccess: [{ kind: "discover_clue", clueId }] } }, citations: [autoCitation(question, `discovery:${id}`)] };
      }
      case "clue_fact_facets": {
        const atoms = question.candidateDomains.allowedClueFactAtoms;
        if (!atoms?.length) throw new Error("facet prompt lacks exact atom domain");
        return {
          questionId: question.questionId,
          kind: question.kind,
          value: { shell: atoms.map((atom) => ({ atomId: atom.atomId, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [] },
          citations: atoms.map((atom) => ({ claimKey: `clue_fact_shell:${clueId}:${atom.atomId}`, statementId: atom.statementId, quote: atom.quote })),
        };
      }
      case "ending_rule": {
        const endingId = "ending_auto_exit";
        return { questionId: question.questionId, kind: question.kind, value: { declarations: [{ endingId, spec: { kind: "ending_rule", id: "rule_auto_exit", priority: 10, when: { kind: "scene_visited", sceneId: exitSceneId }, effects: [{ kind: "end_game", endingId }] } }] }, citations: [autoCitation(question, `ending:${endingId}`)] };
      }
      case "npc_binding": return { questionId: question.questionId, kind: question.kind, value: { proseAnchorId: clueId, presentNpcs: [] }, citations: [autoCitation(question, `npc_binding:none:${clueId}`)] };
      default: throw new Error(`unexpected automatic compiler question: ${question.kind}`);
    }
  });
  return JSON.stringify({ proposals });
}

/** The server default publisher sees only one bounded machine page at a time. */
function automaticMachinePublisherReply(
  messages: Message[],
  classifyAudience: (slot: { fieldPath: string; expectedAudience: "public_on_entry" | "found_clue" | "terminal_only" | "private_context" }) => "public_on_entry" | "found_clue" | "terminal_only" | "private_context" = (slot) => slot.expectedAudience,
): string {
  const content = messages[1]?.content ?? "";
  if (!content.startsWith('{"schemaVersion":"server-machine-presentation-selector-v1"')) {
    return fullAutoReply(messages);
  }
  const request = JSON.parse(content) as {
    schemaVersion?: string;
    slots?: Array<{
      fieldPath: string;
      expectedAudience: "public_on_entry" | "found_clue" | "terminal_only" | "private_context";
      candidates: Array<{ candidateDigest: string; exactText: string }>;
      opaqueCandidateDigest: string | null;
    }>;
  };
  if (request.schemaVersion !== "server-machine-presentation-selector-v1" || !request.slots) throw new Error("machine selector prompt is malformed");
  const publicTexts = request.slots
    .filter((slot) => slot.expectedAudience === "public_on_entry")
    .map((slot) => slot.candidates.at(-1)?.exactText)
    .filter((text): text is string => !!text);
  return JSON.stringify({
    selections: request.slots.map((slot) => {
      const candidate = slot.expectedAudience === "terminal_only"
        ? slot.candidates.find((entry) => !publicTexts.some((text) => sourceTextRangesOverlap(entry.exactText, text))) ?? slot.candidates.at(-1)
        : slot.candidates.at(-1);
      if (candidate) return { fieldPath: slot.fieldPath, kind: "source_exact", candidateDigest: candidate.candidateDigest, audience: classifyAudience(slot) };
      if (!slot.opaqueCandidateDigest) throw new Error(`selector prompt omitted every canonical choice for ${slot.fieldPath}`);
      return { fieldPath: slot.fieldPath, kind: "opaque_unavailable", candidateDigest: slot.opaqueCandidateDigest, audience: classifyAudience(slot) };
    }),
  });
}

/** Test-model stand-in for the host's statement/range cross-slot constraint. */
function sourceTextRangesOverlap(left: string, right: string): boolean {
  return left.includes(right) || right.includes(left);
}

/**
 * Test-model only: it may choose solely from the real default selector's
 * bounded canonical prompt.  It deliberately chooses a current-scene clue
 * source candidate for the scene-description slot, rather than constructing a
 * binding, receipt, or digest itself.
 */
function automaticMachinePublisherReplySelectingProtectedSceneCandidate(
  messages: Message[],
  targetFieldPath: string,
  protectedQuote: string,
  terminalQuote: string,
  observed: { selected: boolean; emptyField?: string; publicTexts: string[]; terminalTexts: string[] },
): string {
  const content = messages[1]?.content ?? "";
  if (!content.startsWith('{"schemaVersion":"server-machine-presentation-selector-v1"')) return fullAutoReply(messages);
  const request = JSON.parse(content) as {
    schemaVersion?: string;
    slots?: Array<{
      fieldPath: string;
      expectedAudience: "public_on_entry" | "found_clue" | "terminal_only" | "private_context";
      candidates: Array<{ candidateDigest: string; exactText: string }>;
      opaqueCandidateDigest: string | null;
    }>;
  };
  if (request.schemaVersion !== "server-machine-presentation-selector-v1" || !request.slots) throw new Error("machine selector prompt is malformed");
  const candidateForPublicSlot = (slot: NonNullable<typeof request.slots>[number]) => {
    const protectedCandidate = slot.fieldPath === targetFieldPath
      ? slot.candidates.find((candidate) => candidate.exactText.includes(protectedQuote))
      : undefined;
    return protectedCandidate ?? slot.candidates.find((candidate) => !observed.terminalTexts.some((text) => sourceTextRangesOverlap(candidate.exactText, text))) ?? slot.candidates[0];
  };
  const selectedPublicCandidates = request.slots
    .filter((slot) => slot.expectedAudience === "public_on_entry")
    .map(candidateForPublicSlot)
    .filter((candidate): candidate is { candidateDigest: string; exactText: string } => !!candidate);
  const publicTexts = [...observed.publicTexts, ...selectedPublicCandidates.map((candidate) => candidate.exactText)];
  const selections = request.slots.map((slot) => {
      const protectedCandidate = slot.fieldPath === targetFieldPath
        ? slot.candidates.find((candidate) => candidate.exactText.includes(protectedQuote))
        : undefined;
      if (protectedCandidate) {
        observed.selected = true;
        return { fieldPath: slot.fieldPath, kind: "source_exact", candidateDigest: protectedCandidate.candidateDigest, audience: slot.expectedAudience };
      }
      const candidate = slot.expectedAudience === "terminal_only"
        ? slot.candidates.find((entry) => entry.exactText.includes(terminalQuote))
          ?? slot.candidates.find((entry) => !publicTexts.some((text) => sourceTextRangesOverlap(entry.exactText, text)))
          ?? slot.candidates.at(-1)
        : candidateForPublicSlot(slot);
      if (candidate) return { fieldPath: slot.fieldPath, kind: "source_exact", candidateDigest: candidate.candidateDigest, audience: slot.expectedAudience };
      if (!slot.opaqueCandidateDigest) {
        observed.emptyField = slot.fieldPath;
        throw new Error(`selector prompt omitted every canonical choice for ${slot.fieldPath}`);
      }
      return { fieldPath: slot.fieldPath, kind: "opaque_unavailable", candidateDigest: slot.opaqueCandidateDigest, audience: slot.expectedAudience };
    });
  observed.publicTexts.push(...selectedPublicCandidates.map((candidate) => candidate.exactText));
  for (const [index, slot] of request.slots.entries()) {
    if (slot.expectedAudience !== "terminal_only") continue;
    const selected = selections[index];
    const candidate = selected?.kind === "source_exact"
      ? slot.candidates.find((entry) => entry.candidateDigest === selected.candidateDigest)
      : undefined;
    if (candidate) observed.terminalTexts.push(candidate.exactText);
  }
  return JSON.stringify({ selections });
}

function autoPresentation(resolved: Awaited<ReturnType<typeof compiledModuleHttpFixture>>["resolved"]) {
  const payload: any = resolved.artifact.payload;
  const facetRevelations = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    if (binding.shellAtoms.length || binding.findings.length) facetRevelations.set(binding.clueId, binding.shellAtoms.map((atom: any) => atom.quote).join("\n") || payload.draft.clueCandidates.find((candidate: any) => candidate.id === binding.clueId).displayName);
    for (const finding of binding.findings) facetRevelations.set(finding.clueId, finding.atoms.map((atom: any) => atom.quote).join("\n"));
  }
  return {
    module: { title: "Auto HTTP", version: "1", ruleset: "cosmic-horror", era: "test", summary: "server projection", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id: string) => [id, { description: `scene:${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection: any) => [connection.id, { condition: `connection:${connection.id}` }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id: string) => [id, { findMethods: [], revelation: facetRevelations.get(id) ?? `revelation:${id}`, unlocks: [], importance: "core" }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((ending: any) => [ending.effects.find((effect: any) => effect.kind === "end_game").endingId, { name: `ending:${ending.id}`, description: `ending:${ending.id}`, conditions: ["declared"] }])),
  };
}

function autoDependencies(
  llm: LLMLike,
  catalog: CompilerArtifactCatalog,
  // This fixture deliberately exercises several retryable auto starts in one
  // ephemeral catalog. Keep its coordinator durable and shared by catalog
  // root, while raising only the fixture's start budget above that scenario.
  admission = new CompilerAutoAdmissionController({
    ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
    root: catalog.root,
    startsPerPrincipal: 64,
  }),
): CompiledModuleHttpDependencies {
  return {
    ...dependencies(undefined, catalog),
    autoCompiler: {
      llm,
      policy: { policyId: "server-auto-test-v1", rightsStatus: "user_provided" },
      producer: { providerFingerprint: "server:auto-test", modelFingerprint: "model:auto-test" },
      limits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxRequestChars: 24_000, maxResponseTokens: 2_400 },
      maxProposalRounds: 2,
      admission,
    },
  };
}

function machineScopeForField(fieldPath: string): "public_on_entry" | "found_clue" | "terminal_only" | "private_context" {
  if (fieldPath.startsWith("clues.")) return "found_clue";
  if (/^items\.[^.]+\.name$/.test(fieldPath)) return "public_on_entry";
  if (fieldPath.startsWith("items.")) return "private_context";
  if (fieldPath.startsWith("endings.")) return "terminal_only";
  if (/^npcs\.[^.]+\.description$/.test(fieldPath)) return "private_context";
  return "public_on_entry";
}

/**
 * A host-side benchmark producer reads only the bounded canonical pages it is
 * handed.  It deliberately chooses a non-first candidate where available;
 * production must still rehydrate and validate every returned tuple.
 */
function completeMachineSelections(input: any): { selections: Array<Record<string, unknown>>; scopes: Array<{ fieldPath: string; audience: string }>; selectedNonFirstCandidate: boolean } {
  const selections: Array<Record<string, unknown>> = [];
  const scopes: Array<{ fieldPath: string; audience: string }> = [];
  let selectedNonFirstCandidate = false;
  for (let offset = 0; ; ) {
    const slots = input.readSlotPage(offset);
    if (slots.status === "refused") throw new Error(slots.message);
    for (const slot of slots.page.slots) {
      if (slot.sourceCandidateCount === 0) {
        if (!slot.opaqueCandidateDigest) throw new Error(`missing opaque selection for ${slot.fieldPath}`);
        selections.push({ fieldPath: slot.fieldPath, kind: "opaque_unavailable", candidateDigest: slot.opaqueCandidateDigest });
      } else {
        const candidates = input.readCandidatePage(slot.fieldPath, 0);
        if (candidates.status === "refused" || candidates.page.candidates.length === 0) throw new Error(`missing source selection for ${slot.fieldPath}`);
        selectedNonFirstCandidate ||= candidates.page.candidates.length > 1;
        const candidate = candidates.page.candidates.at(-1)!;
        selections.push({
          fieldPath: slot.fieldPath,
          kind: "source_exact",
          candidateDigest: candidate.candidateDigest,
          offset: candidates.page.offset,
          sourceCandidateOrderHash: candidates.page.sourceCandidateOrderHash,
        });
      }
      scopes.push({ fieldPath: slot.fieldPath, audience: machineScopeForField(slot.fieldPath) });
    }
    if (!slots.page.hasMore) break;
    offset += slots.page.slots.length;
  }
  return { selections, scopes, selectedNonFirstCandidate };
}

describe("compiled module HTTP lifecycle", () => {
  it("binds automatic admission to its supplied ephemeral catalog root", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-auto-admission-root-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const dependencies = autoDependencies({ chat: async () => '{"proposals":[]}' }, catalog);
      expect(dependencies.autoCompiler?.admission.root).toBe(catalog.root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Real PDF parsing happens three times here to prove byte-stable public
  // output. Keep its larger end-to-end budget local to this exact contract.
  it("prepares deterministic actual PDF bytes and preserves their byte identity", async () => {
    const request = () => new Request("http://test/api/compiler/prepare?moduleId=pdf-module", { method: "POST", headers: { "Content-Type": "Application/PDF; charset=binary" }, body: pdf("Entry:") });
    const first = await handleCompiledModuleHttpRequest(request(), dependencies());
    const second = await handleCompiledModuleHttpRequest(request(), dependencies());
    expect(first?.status).toBe(201); expect(await first?.json()).toMatchObject({ status: "prepared", identity: { documentHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(await second?.text()).toBe(await (await handleCompiledModuleHttpRequest(request(), dependencies()))?.text());
  }, 15_000);

  it("forwards the catalog-restored PDF document identity with the exact resolved artifact to the world binding resolver", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-pdf-world-binding-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const preparedResponse = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/prepare?moduleId=pdf-world-binding", {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: pdf(PAGES[0]!),
        }),
        dependencies(undefined, catalog),
      );
      expect(preparedResponse?.status).toBe(201);
      const prepared = await preparedResponse?.json() as PreparedCompilerApiResult & { preparedArtifactId: string };
      expect(prepared.identity.documentHash).toMatch(/^[a-f0-9]{64}$/);
      const localResolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, firstPathHints(prepared));
      if (localResolved.status === "refused") throw new Error(localResolved.message);
      const review = catalog.saveTrustedPresentationReview(
        prepared.preparedArtifactId,
        prepared.artifact,
        localResolved.artifact,
        "operator:pdf-world-binding",
        exactReviewBindings(localResolved.artifact.payload as any),
      );
      if (review.status !== "ok") throw new Error(review.message);
      const policyPath = join(root, "world-model-policy.json");
      writeFileSync(policyPath, JSON.stringify({
        schemaVersion: "1.1.0",
        kind: "compiled_cthulhu_world_model_policy",
        bindings: [],
        sourceProfiles: [{
          moduleId: prepared.identity.moduleId,
          documentHash: prepared.identity.documentHash,
          allowedWorkIds: ["the_call_of_cthulhu"],
          corpusScopeId: null,
          transferPolicy: "analogy_only",
        }],
      }), "utf8");
      const registry = new CompiledWorldModelBindingRegistry({
        COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: policyPath,
        CTHULHU_DATASET_PATH: process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\\u4e16\u754c\u6a21\u578b\\datasets\\cthulhu",
      });
      const observed: Array<{ moduleId: string; artifactHash: string; documentHash: string | null }> = [];
      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: prepared.preparedArtifactId,
          preparedQueueHash: prepared.identity.preparedQueueHash,
          hints: firstPathHints(prepared),
          presentationReviewId: review.value.id,
        }),
      }), {
        ...dependencies(undefined, catalog),
        resolveCompiledWorldModelBinding: (identity) => {
          observed.push({ ...identity });
          return registry.resolve(identity);
        },
      });

      expect(response?.status).toBe(200);
      expect(observed).toEqual([{
        moduleId: prepared.identity.moduleId,
        artifactHash: localResolved.artifact.artifactHash,
        documentHash: prepared.identity.documentHash,
      }]);
      const resolvedBody = await response?.json() as { status: string; bundleId: string };
      expect(resolvedBody.status).toBe("resolved");
      expect(catalog.loadBundle(resolvedBody.bundleId)).toMatchObject({
        status: "ok",
        value: { worldModelBinding: { moduleId: prepared.identity.moduleId, artifactHash: localResolved.artifact.artifactHash } },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("keeps same-PDF source-profile bindings isolated by their exact prepared module through actual HTTP publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-same-document-profile-isolation-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const sharedPdf = pdf(PAGES[0]!);
      const prepare = async (moduleId: string) => {
        const response = await handleCompiledModuleHttpRequest(
          new Request(`http://test/api/compiler/prepare?moduleId=${encodeURIComponent(moduleId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/pdf" },
            body: sharedPdf,
          }),
          dependencies(undefined, catalog),
        );
        expect(response?.status).toBe(201);
        return await response?.json() as PreparedCompilerApiResult & { preparedArtifactId: string };
      };
      const first = await prepare("same-document-profile-call");
      const second = await prepare("same-document-profile-dunwich");
      expect(first.identity.documentHash).toBe(second.identity.documentHash);

      const policyPath = join(root, "world-model-policy.json");
      writeFileSync(policyPath, JSON.stringify({
        schemaVersion: "1.1.0",
        kind: "compiled_cthulhu_world_model_policy",
        bindings: [],
        sourceProfiles: [
          {
            moduleId: first.identity.moduleId,
            documentHash: first.identity.documentHash,
            allowedWorkIds: ["the_call_of_cthulhu"],
            corpusScopeId: null,
            transferPolicy: "analogy_only",
          },
          {
            moduleId: second.identity.moduleId,
            documentHash: second.identity.documentHash,
            allowedWorkIds: ["the_dunwich_horror"],
            corpusScopeId: null,
            transferPolicy: "analogy_only",
          },
        ],
      }), "utf8");
      const registry = new CompiledWorldModelBindingRegistry({
        COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: policyPath,
        CTHULHU_DATASET_PATH: process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\\u4e16\u754c\u6a21\u578b\\datasets\\cthulhu",
      });
      const publish = async (prepared: PreparedCompilerApiResult & { preparedArtifactId: string }) => {
        const localResolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, firstPathHints(prepared));
        if (localResolved.status === "refused") throw new Error(localResolved.message);
        const review = catalog.saveTrustedPresentationReview(
          prepared.preparedArtifactId,
          prepared.artifact,
          localResolved.artifact,
          "operator:same-document-profile-isolation",
          exactReviewBindings(localResolved.artifact.payload as any),
        );
        if (review.status !== "ok") throw new Error(review.message);
        const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            preparedArtifactId: prepared.preparedArtifactId,
            preparedQueueHash: prepared.identity.preparedQueueHash,
            hints: firstPathHints(prepared),
            presentationReviewId: review.value.id,
          }),
        }), {
          ...dependencies(undefined, catalog),
          resolveCompiledWorldModelBinding: registry.resolve,
        });
        expect(response?.status).toBe(200);
        const body = await response?.json() as { status: string; bundleId: string };
        expect(body.status).toBe("resolved");
        const bundle = catalog.loadBundle(body.bundleId);
        if (bundle.status !== "ok") throw new Error(bundle.message);
        return { localResolved, bundle: bundle.value };
      };

      const publishedFirst = await publish(first);
      const publishedSecond = await publish(second);
      expect(publishedFirst.bundle.worldModelBinding).toMatchObject({
        moduleId: first.identity.moduleId,
        artifactHash: publishedFirst.localResolved.artifact.artifactHash,
        allowedWorkIds: ["the_call_of_cthulhu"],
      });
      expect(publishedSecond.bundle.worldModelBinding).toMatchObject({
        moduleId: second.identity.moduleId,
        artifactHash: publishedSecond.localResolved.artifact.artifactHash,
        allowedWorkIds: ["the_dunwich_horror"],
      });
      expect(publishedFirst.bundle.worldModelBinding?.scopeHash).not.toBe(publishedSecond.bundle.worldModelBinding?.scopeHash);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("fails ordinary PDF publication before bundle persistence when an exact and a source-profile rule both match", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-pdf-world-binding-conflict-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const preparedResponse = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/prepare?moduleId=pdf-world-binding-conflict", {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: pdf(PAGES[0]!),
        }),
        dependencies(undefined, catalog),
      );
      expect(preparedResponse?.status).toBe(201);
      const prepared = await preparedResponse?.json() as PreparedCompilerApiResult & { preparedArtifactId: string };
      const localResolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, firstPathHints(prepared));
      if (localResolved.status === "refused") throw new Error(localResolved.message);
      const review = catalog.saveTrustedPresentationReview(
        prepared.preparedArtifactId,
        prepared.artifact,
        localResolved.artifact,
        "operator:pdf-world-binding-conflict",
        exactReviewBindings(localResolved.artifact.payload as any),
      );
      if (review.status !== "ok") throw new Error(review.message);
      const policyPath = join(root, "world-model-policy.json");
      writeFileSync(policyPath, JSON.stringify({
        schemaVersion: "1.1.0",
        kind: "compiled_cthulhu_world_model_policy",
        bindings: [{
          moduleId: prepared.identity.moduleId,
          artifactHash: localResolved.artifact.artifactHash,
          allowedWorkIds: ["the_call_of_cthulhu"],
          corpusScopeId: null,
          transferPolicy: "analogy_only",
        }],
        sourceProfiles: [{
          moduleId: prepared.identity.moduleId,
          documentHash: prepared.identity.documentHash,
          allowedWorkIds: ["the_call_of_cthulhu"],
          corpusScopeId: null,
          transferPolicy: "analogy_only",
        }],
      }), "utf8");
      const registry = new CompiledWorldModelBindingRegistry({
        COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: policyPath,
        CTHULHU_DATASET_PATH: process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\\u4e16\u754c\u6a21\u578b\\datasets\\cthulhu",
      });
      let bundleWrites = 0;
      const saveBundle = catalog.saveBundle.bind(catalog);
      (catalog as unknown as { saveBundle: typeof catalog.saveBundle }).saveBundle = (...args) => {
        bundleWrites++;
        return saveBundle(...args);
      };
      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: prepared.preparedArtifactId,
          preparedQueueHash: prepared.identity.preparedQueueHash,
          hints: firstPathHints(prepared),
          presentationReviewId: review.value.id,
        }),
      }), {
        ...dependencies(undefined, catalog),
        resolveCompiledWorldModelBinding: registry.resolve,
      });

      expect(response?.status).toBe(500);
      expect(await response?.json()).toMatchObject({ error: { stage: "resolve", code: "WORLD_MODEL_BINDING_RESOLUTION_FAILED" } });
      expect(bundleWrites).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("rejects an authenticated textless PDF before writing a prepared catalog entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-textless-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      let preparedWrites = 0;
      const savePrepared = catalog.savePrepared.bind(catalog);
      (catalog as unknown as { savePrepared(value: unknown): unknown }).savePrepared = (value) => {
        preparedWrites++;
        return savePrepared(value);
      };

      const response = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/prepare?moduleId=textless-pdf", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf("") }),
        dependencies(undefined, catalog),
      );

      expect(response?.status).toBe(422);
      expect(await response?.json()).toMatchObject({ error: { stage: "prepare", code: "PDF_TEXT_UNAVAILABLE" } });
      expect(preparedWrites).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("maps media, body, JSON, and compiler refusals without throwing", async () => {
    const cases = [
      new Request("http://test/api/compiler/prepare", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf("Entry:") }),
      new Request("http://test/api/compiler/prepare?moduleId=x", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" }),
      new Request("http://test/api/compiler/prepare?moduleId=x", { method: "POST", headers: { "Content-Type": "application/pdf", "Content-Length": String(COMPILER_HTTP_PDF_BODY_LIMIT_BYTES + 1) }, body: pdf("Entry:") }),
      new Request("http://test/api/compiler/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }),
    ];
    for (const request of cases) { const response = await handleCompiledModuleHttpRequest(request, dependencies()); expect(response?.status).toBeGreaterThanOrEqual(400); expect(await response?.json()).toHaveProperty("error.stage"); }
  });

  it("bounds unknown-length streams at the exact compiler limit and classifies Content-Length", async () => {
    const exact = new Uint8Array(COMPILER_HTTP_BODY_LIMIT_BYTES); exact.fill(0x20);
    const accepted = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream(exact) }), dependencies());
    expect(accepted?.status).toBe(400);
    expect(await accepted?.json()).toMatchObject({ error: { code: "JSON_INVALID" } });
    const rejected = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream(new Uint8Array(COMPILER_HTTP_BODY_LIMIT_BYTES), new Uint8Array([0x20])) }), dependencies());
    expect(rejected?.status).toBe(413);
    expect(await rejected?.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
    const malformed = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "-1" }, body: "{}" }), dependencies());
    expect(malformed?.status).toBe(400);
    expect(await malformed?.json()).toMatchObject({ error: { code: "CONTENT_LENGTH_INVALID" } });
  });

  it("rejects a JSON-round-tripped artifact at the public resolve boundary and creates only from a trusted bundle", async () => {
    const value = await compiledModuleHttpFixture();
    const resolveResponse = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preparedArtifact: JSON.parse(JSON.stringify(value.prepared.artifact)), preparedQueueHash: value.prepared.identity.preparedQueueHash, hints: hints(value.prepared), presentationReviewId: "a".repeat(24) }) }), dependencies());
    expect(resolveResponse?.status).toBe(400);
    const calls = { factory: 0, registered: 0, persisted: 0 };
    const catalog = new CompilerArtifactCatalog({ root: mkdtempSync(join(tmpdir(), "compiled-http-trusted-create-")) });
    dependencyCatalogRoots.add(catalog.root);
    const bundle = saveTrustedFixtureBundle(catalog, value);
    const good = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundleId: bundle.id, archetype: "investigator", characterName: "Ada" }) }), dependencies(calls, catalog));
    expect(good?.status).toBe(201); expect(calls).toEqual({ factory: 1, registered: 1, persisted: 1 });
  });

  it("rejects a raw resolved artifact and caller projection before catalog or session side effects", async () => {
    const fixture = await compiledModuleHttpFixture();
    const calls = { factory: 0, registered: 0, persisted: 0 };
    const catalog = new CompilerArtifactCatalog({ root: mkdtempSync(join(tmpdir(), "compiled-http-raw-create-")) });
    dependencyCatalogRoots.add(catalog.root);
    let bundleWrites = 0;
    const saveBundle = catalog.saveBundle.bind(catalog);
    (catalog as any).saveBundle = (artifact: unknown, projection: unknown, binding?: unknown) => {
      bundleWrites++;
      return saveBundle(artifact, projection, binding as any);
    };

    const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resolvedArtifact: fixture.resolved.artifact,
        projection: fixture.projection,
        archetype: "investigator",
        characterName: "Ada",
      }),
    }), dependencies(calls, catalog));

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { code: "REQUEST_SHAPE_INVALID" } });
    expect(bundleWrites).toBe(0);
    expect(calls).toEqual({ factory: 0, registered: 0, persisted: 0 });
  });

  it("rejects a legacy catalog bundle without a trusted presentation review before session side effects", async () => {
    const fixture = await compiledModuleHttpFixture();
    const calls = { factory: 0, registered: 0, persisted: 0 };
    const catalog = new CompilerArtifactCatalog({ root: mkdtempSync(join(tmpdir(), "compiled-http-unreviewed-bundle-")) });
    dependencyCatalogRoots.add(catalog.root);
    const legacy = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
    if (legacy.status !== "ok") throw new Error(legacy.message);

    const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: legacy.value.id, archetype: "investigator", characterName: "Ada" }),
    }), dependencies(calls, catalog));

    expect(response?.status).toBe(422);
    expect(await response?.json()).toMatchObject({ error: { code: "TRUSTED_PRESENTATION_REVIEW_REQUIRED" } });
    expect(calls).toEqual({ factory: 0, registered: 0, persisted: 0 });
  });

  it("rejects a valid-looking reviewed projection when its catalog review witness is absent", async () => {
    const fixture = await compiledModuleHttpFixture();
    const source = new CompilerArtifactCatalog({ root: mkdtempSync(join(tmpdir(), "compiled-http-source-review-")) });
    const target = new CompilerArtifactCatalog({ root: mkdtempSync(join(tmpdir(), "compiled-http-missing-review-")) });
    dependencyCatalogRoots.add(source.root);
    dependencyCatalogRoots.add(target.root);
    const trustedBundle = saveTrustedFixtureBundle(source, fixture);
    const sourceBundle = source.loadBundle(trustedBundle.id);
    if (sourceBundle.status !== "ok") throw new Error(sourceBundle.message);
    const copied = target.saveBundle(sourceBundle.value.artifact, sourceBundle.value.projection);
    if (copied.status !== "ok") throw new Error(copied.message);
    const calls = { factory: 0, registered: 0, persisted: 0 };

    const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: copied.value.id, archetype: "investigator", characterName: "Ada" }),
    }), dependencies(calls, target));

    expect(response?.status).toBe(422);
    expect(await response?.json()).toMatchObject({ error: { code: "TRUSTED_PRESENTATION_REVIEW_UNAVAILABLE" } });
    expect(calls).toEqual({ factory: 0, registered: 0, persisted: 0 });
  });

  it("normalizes valid archetypes and cleans up only failed pre-commit compiled-session construction", async () => {
    const value = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: mkdtempSync(join(tmpdir(), "compiled-http-normalized-create-")) });
    dependencyCatalogRoots.add(catalog.root);
    const bundle = saveTrustedFixtureBundle(catalog, value);
    const request = (archetype = " investigator ") => new Request("http://test/api/sessions/compiled", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundleId: bundle.id, archetype, characterName: " Ada " }) });
    const seen: string[] = [];
    const base = dependencies(undefined, catalog);
    const good = await handleCompiledModuleHttpRequest(request(), { ...base, createSession: (_id, archetype, name) => {
      seen.push(`${archetype}/${name}`);
      return base.createSession("compiled1", archetype, name, {});
    } });
    expect(good?.status).toBe(201);
    expect(seen).toEqual(["investigator/Ada"]);
    const unknown = await handleCompiledModuleHttpRequest(request("not-an-archetype"), dependencies(undefined, catalog));
    expect(unknown?.status).toBe(422);
    expect(await unknown?.json()).toMatchObject({ error: { code: "ARCHETYPE_UNKNOWN" } });

    const calls = { factory: 0, registered: 0, persisted: 0, rolledBack: 0, unregistered: 0 };
    const failedPersistence = await handleCompiledModuleHttpRequest(request("investigator"), {
      ...dependencies(calls, catalog),
      persistSession: () => { calls.persisted++; throw new Error("disk full"); },
      rollbackSessionStorage: () => { calls.rolledBack++; },
      unregisterSession: () => { calls.unregistered++; },
    });
    expect(failedPersistence?.status).toBe(500);
    expect(calls).toMatchObject({ factory: 1, persisted: 1, registered: 0, rolledBack: 1, unregistered: 1 });

    const failedRegistration = await handleCompiledModuleHttpRequest(request("investigator"), {
      ...dependencies(calls, catalog),
      registerSession: () => { calls.registered++; throw new Error("registry failure"); },
      rollbackSessionStorage: () => { calls.rolledBack++; },
      unregisterSession: () => { calls.unregistered++; },
    });
    expect(failedRegistration?.status).toBe(503);
    expect(failedRegistration?.headers.get("Retry-After")).toBe("1");
    expect(calls).toMatchObject({ registered: 1, rolledBack: 1, unregistered: 2 });
  });

  it("never reads incomplete snapshot identity before recovery is eligible and fails closed when eligible identity is malformed", async () => {
    const value = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: mkdtempSync(join(tmpdir(), "compiled-http-recovery-create-")) });
    dependencyCatalogRoots.add(catalog.root);
    const bundle = saveTrustedFixtureBundle(catalog, value);
    const request = () => new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: bundle.id, archetype: "investigator", characterName: "Ada" }),
    });
    const precommit = { factory: 0, registered: 0, persisted: 0, rolledBack: 0, unregistered: 0 };
    const ordinaryFailure = await handleCompiledModuleHttpRequest(request(), {
      ...dependencies(precommit, catalog),
      persistSession: () => { precommit.persisted++; throw new Error("disk full"); },
      rollbackSessionStorage: () => { precommit.rolledBack++; },
      unregisterSession: () => { precommit.unregistered++; },
    });
    expect(ordinaryFailure?.status).toBe(500);
    expect(precommit).toMatchObject({ persisted: 1, rolledBack: 1, unregistered: 1 });

    const malformed = { factory: 0, registered: 0, persisted: 0, rolledBack: 0, unregistered: 0, recovery: 0 };
    const ambiguous = await handleCompiledModuleHttpRequest(request(), {
      ...dependencies(malformed, catalog),
      persistSession: () => { malformed.persisted++; throw new CompiledSessionSnapshotPersistenceError("SNAPSHOT_INDETERMINATE", "ambiguous fake snapshot"); },
      rollbackSessionStorage: () => { malformed.rolledBack++; },
      unregisterSession: () => { malformed.unregistered++; },
      recoverPersistedSession: () => { malformed.recovery++; return undefined; },
    });
    expect(ambiguous?.status).toBe(503);
    expect(ambiguous?.headers.get("Retry-After")).toBe("1");
    expect(await ambiguous?.json()).toMatchObject({ error: { code: "SNAPSHOT_INDETERMINATE", recovery: { generation: 0 } } });
    expect(malformed).toMatchObject({ persisted: 1, recovery: 1, rolledBack: 0, unregistered: 1 });
  });

  it("keeps a committed generation-zero snapshot restartable when acknowledgement or registration fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-creation-recovery-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      for (const phase of ["acknowledge", "register"] as const) {
        const catalog = new CompilerArtifactCatalog({ root: join(root, phase, "catalog") });
        const savedBundle = saveTrustedFixtureBundle(catalog, fixture);
        const snapshots = new CompiledSessionSnapshotStore({ root: join(root, phase, "snapshots") });
        const sessions = new Map<string, GameSession>();
        const compiledDurableHostCapability = Object.freeze(Object.create(null)) as object;
        const id = `rollback-${phase}`;
        let storageCleanupCalls = 0;
        const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundleId: savedBundle.id, archetype: "investigator", characterName: "Ada" }),
        }), {
          compiledDurableHostCapability,
          compiledSessionCreationAdmission: new CompiledSessionCreationAdmissionCoordinator({
            root,
            ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
          }),
          generateId: () => id,
          hasSession: (candidate) => sessions.has(candidate),
          hasDurableSession: (candidate) => snapshots.isOccupied(candidate),
          createSession: (sessionId, archetype, characterName, persona) => {
            const session = new GameSession(
              sessionId,
              "cosmic-horror",
              { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 },
              archetype,
              characterName,
              persona,
              { careerRoot: join(root, phase, "careers") },
              undefined,
              "preferred",
              { compiledDurableHostCapability },
            );
            return session;
          },
          persistSession: (_id, _session, _bundleId, snapshot) => {
            const saved = snapshots.save(snapshot);
            if (saved.status !== "ok") throw new Error(saved.message);
          },
          registerSession: (sessionId, session) => {
            sessions.set(sessionId, session as GameSession);
            if (phase === "register") throw new Error("registration failure");
          },
          unregisterSession: (sessionId) => sessions.delete(sessionId),
          rollbackSessionStorage: () => { storageCleanupCalls++; },
          acknowledgeCompiledSnapshot: () => {
            if (phase === "acknowledge") throw new Error("acknowledgement failure");
          },
          authenticateCompilerRequest: operatorAuthenticator,
          catalog,
        });
        expect(response?.status).toBe(503);
        expect(response?.headers.get("Retry-After")).toBe("1");
        expect(storageCleanupCalls).toBe(0);
        expect(sessions.has(id)).toBe(false);
        expect(snapshots.listHeaders()).toMatchObject([{ status: "ok", value: { sessionId: id, generation: 0 } }]);
        expect(hydrateCompiledSessions({ sessions: new Map(), catalog, snapshots }).hydrated).toEqual([id]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("adopts one complete legacy compiled store before the first recovery constructor", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-legacy-namespace-"));
    const id = "12345678-1234-4123-8123-123456789abc";
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
    const freshRegistry = new Map<string, GameSession>();
    let source: GameSession | undefined;
    try {
      const fixture = await compiledModuleHttpFixture();
      const stored = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
      if (stored.status !== "ok") throw new Error(stored.message);
      const bundle = catalog.loadBundle(stored.value.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const sourceHost = createCompiledDurableTestHost();
      source = new GameSession(
        id,
        "cosmic-horror",
        { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 },
        "investigator",
        "Ada",
        undefined,
        { careerRoot: join(root, "source-careers") },
        undefined,
        "preferred",
        sourceHost.runtimeDependencies,
      );
      const loaded = source.loadDurableCompiledModule(bundle.value, createCompiledSessionAccessBinding({ id: "operator:test", role: "operator" }));
      if (loaded.status !== "loaded") throw new Error(`${loaded.code}: ${loaded.message}`);
      const snapshot = sourceHost.snapshot(source);
      expect(snapshots.save(snapshot)).toMatchObject({ status: "ok", value: { generation: 0 } });
      const response = await handleRequest(new Request(`http://test/api/sessions/${id}`), catalog, snapshots,
        { careerRoot: join(root, "careers") }, {}, {}, operatorAuthenticator, undefined, undefined, undefined, undefined, { registry: freshRegistry });
      expect(response.status).toBe(200);
      expect(freshRegistry.get(id)?.getCompiledGeneration()).toBe(0);
      expect(new SessionNamespaceCoordinator(join(root, "careers", ".runtime-session-namespace")).read(id))
        .toMatchObject({ kind: "compiled", state: "committed", expectedIdentity: { generation: 0, format: "compiled-session-snapshot-v1" } });
    } finally {
      source?.close(); for (const session of freshRegistry.values()) session.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  nativeFetchIt("applies production CORS to compiled refusals over an ephemeral Bun server", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-server-"));
    const catalog = new CompilerArtifactCatalog({ root });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleRequest(request, catalog, undefined, {}, {}, {}, operatorAuthenticator) });
    try {
      const semantic = await fetch(`http://127.0.0.1:${server.port}/api/compiler/prepare?moduleId=x`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
      expect(semantic.status).toBe(415);
      expect(semantic.headers.get("access-control-allow-origin")).toBe("*");
      const oversized = await fetch(`http://127.0.0.1:${server.port}/api/compiler/prepare?moduleId=x`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: new Uint8Array(COMPILER_HTTP_PDF_BODY_LIMIT_BYTES + 1) });
      expect(oversized.status).toBe(413);
      expect(oversized.headers.get("access-control-allow-origin")).toBe("*");
      const options = await fetch(`http://127.0.0.1:${server.port}/api/compiler/prepare`, { method: "OPTIONS" });
      expect(options.status).toBe(204);
      expect(options.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores Math.random after an awaited check throws", async () => {
    const originalRandom = Math.random;
    let thrown: unknown;
    try {
      await withMockedRandom(() => 0.99, async () => {
        await Promise.resolve();
        throw new Error("forced async RNG test failure");
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ message: "forced async RNG test failure" });
    expect(Math.random).toBe(originalRandom);
  });

  // This covers several durable fsync/recovery HTTP rounds; 15s is a test scheduler budget, not a production latency SLO.
  it("runs the real HTTP PDF-to-terminal-compiled-session chain", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-chain-"));
    const catalog = new CompilerArtifactCatalog({ root });
    const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleRequest(request, catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, operatorAuthenticator) });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const preparedResponse = await fetch(`${base}/api/compiler/prepare?moduleId=real-http-fixture`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf(PAGES[0]!) });
      expect(preparedResponse.status).toBe(201);
      const prepared = await preparedResponse.json() as PreparedCompilerApiResult & { preparedArtifactId: string };
      const resolvedHints = firstPathHints(prepared);
      const localResolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, resolvedHints);
      if (localResolved.status === "refused") throw new Error(localResolved.message);
      const payload: any = localResolved.artifact.payload;
      const review = catalog.saveTrustedPresentationReview(prepared.preparedArtifactId, prepared.artifact, localResolved.artifact, "operator:http-chain", exactReviewBindings(payload));
      if (review.status !== "ok") throw new Error(review.message);
      const resolvedResponse = await fetch(`${base}/api/compiler/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preparedArtifactId: prepared.preparedArtifactId, preparedQueueHash: prepared.identity.preparedQueueHash, hints: resolvedHints, presentationReviewId: review.value.id }) });
      expect(resolvedResponse.status).toBe(200);
      const resolved = await resolvedResponse.json() as { bundleId: string; artifact: { artifactHash: string }; identity: { mechanicsHash: string } };
      expect(resolved.artifact.artifactHash).toBe(localResolved.artifact.artifactHash);
      expect(resolved.identity.mechanicsHash).toBe((localResolved.artifact.payload as any).identity.mechanicsHash);
      const sessionResponse = await fetch(`${base}/api/sessions/compiled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundleId: resolved.bundleId, archetype: "investigator", characterName: "Ada" }) });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json() as { sessionId: string; compiled: { artifactHash: string; mechanicsHash: string } };
      expect(session.compiled).toMatchObject({ artifactHash: resolved.artifact.artifactHash, mechanicsHash: resolved.identity.mechanicsHash });
      const namespace = new SessionNamespaceCoordinator(join(root, "careers", ".runtime-session-namespace"));
      expect(namespace.read(session.sessionId)).toMatchObject({ kind: "compiled", state: "committed", expectedIdentity: { generation: 0, format: "compiled-session-snapshot-v1" } });
      let generation = 0;
      let actionNumber = 0;
      const action = async (input: string) => {
        const response = await fetch(`${base}/api/sessions/${session.sessionId}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input, pcId: "p1", actionId: `action-${++actionNumber}`, expectedGeneration: generation }) });
        expect(response.status).toBe(200);
        const result = await response.json() as { generation: number; dice?: Array<{ expr: string; total: number; detail?: string }>; events: Array<{ speaker: string; content: string; type: string }>; compiled: { terminalEnding?: { id: string }; state: any; stateHash: string } };
        generation = result.generation;
        return result;
      };
      const methods = payload.mechanicsIR.discoveryMethods;
      const parent = methods.find((method: any) => method.id === "find_parent")!;
      const child = methods.find((method: any) => method.id === "find_child")!;
      const entry = payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "entry_archive")!;
      const exit = payload.mechanicsIR.connections.find((connection: any) => connection.connectionId === "archive_exit")!;
      await action(`@compiled ${parent.id}`);
      await action(`@compiled ${entry.id}`);
      const firstChild = await withMockedRandom(() => 0.99, () => action(`@compiled ${child.id}`));
      expect(firstChild).toMatchObject({ dice: [{ expr: "d100", total: 100, detail: "library_use/hard" }] });
      expect(firstChild.events).toContainEqual(expect.objectContaining({ speaker: "系统", type: "system", content: expect.stringMatching(/^🎲 library_use hard 检定 d100=100 \(目标=\d+%\) → 失败$/) }));
      if (!firstChild.compiled.state.foundClueIds.includes(child.clueId)) {
        await withMockedRandom(() => 0, () => action(`@compiled ${child.id}`));
      }
      const ending = await action(`@compiled ${exit.id}`);
      expect(ending.compiled.terminalEnding).toBeDefined();
      expect(ending.compiled.stateHash).toBe(mechanicsStateHash(ending.compiled.state));
      // The last real action advances the same durable namespace pointer; a
      // fresh observer sees no process-local registry state or permit.
      expect(new SessionNamespaceCoordinator(join(root, "careers", ".runtime-session-namespace")).read(session.sessionId))
        .toMatchObject({ kind: "compiled", state: "committed", expectedIdentity: { generation, format: "compiled-session-snapshot-v1" } });
      // A clean runtime has neither the old registry nor its in-memory permit
      // map. It must accept the durable gN pointer and hydrate it, rather than
      // treating g1+ as a legacy cross-store conflict.
      const freshRegistry = new Map<string, GameSession>();
      const restarted = await handleRequest(new Request(`http://test/api/sessions/${session.sessionId}`), catalog, snapshots,
        { careerRoot: join(root, "careers") }, {}, {}, operatorAuthenticator, undefined, undefined, undefined, undefined, { registry: freshRegistry });
      expect(restarted.status).toBe(200);
      expect(freshRegistry.get(session.sessionId)?.getCompiledGeneration()).toBe(generation);
      for (const recovered of freshRegistry.values()) recovered.close();
    } finally {
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects durable compiled character mutations outside the action transaction without corrupting the snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-character-gate-"));
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleRequest(request, catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, operatorAuthenticator) });
    try {
      const fixture = await compiledModuleHttpFixture();
      const savedBundle = saveTrustedFixtureBundle(catalog, fixture);
      const base = `http://127.0.0.1:${server.port}`;
      const created = await fetch(`${base}/api/sessions/compiled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId: savedBundle.id, archetype: "investigator", characterName: "Ada" }),
      });
      expect(created.status).toBe(201);
      const { sessionId } = await created.json() as { sessionId: string };
      const before = snapshots.read(sessionId);
      expect(before.status).toBe("ok");
      if (before.status !== "ok") return;
      const initialSnapshot = structuredClone(before.value) as CompiledSessionSnapshot;

      const mutation = await fetch(`${base}/api/sessions/${sessionId}/character`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hp: 1,
          maxHp: 1,
          skills: { library_use: 99 },
          inventory: ["forged inventory"],
          weapons: ["forged weapon"],
          luck: 0,
          creditRating: 999,
          attributes: { power: 1 },
        }),
      });
      expect(mutation.status).toBe(409);
      expect(await mutation.json()).toEqual({ code: "compiled_mutation_unsupported", generation: 0 });

      expect(snapshots.read(sessionId)).toEqual({ status: "ok", value: initialSnapshot });
      const restoredSessions = new Map<string, GameSession>();
      const restoredDiagnostics = new Map<string, { id: string; code: string; message: string }>();
      const restoredHost = createCompiledDurableTestHost();
      expect(hydrateCompiledSessions({
        sessions: restoredSessions,
        diagnostics: restoredDiagnostics,
        catalog,
        snapshots,
        compiledDurableHostCapability: restoredHost.capability,
        createSession: (id, runtimeDependencies) => new GameSession(
          id, "cosmic-horror", undefined, undefined, undefined, undefined, { careerRoot: join(root, "restored-careers") }, undefined, "preferred", runtimeDependencies,
        ),
      })).toEqual({ hydrated: [sessionId], unavailable: [] });
      expect(restoredSessions.get(sessionId)?.getCharacterSummary()).toMatchObject({
        hp: initialSnapshot.character.sheet.hp,
        maxHp: initialSnapshot.character.sheet.maxHp,
        attributes: initialSnapshot.character.sheet.attributes,
      });
      expect(restoredSessions.get(sessionId)?.activeCharacter).toMatchObject({
        luck: initialSnapshot.character.sheet.luck,
        creditRating: initialSnapshot.character.sheet.creditRating,
        skillValues: initialSnapshot.character.sheet.skillValues,
      });
      for (const restored of restoredSessions.values()) restored.close();
    } finally {
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps HTTP orchestration on public boundaries, not diagnostics or a second resolver", () => {
    const source = readFileSync("src/api/compiled-module-http.ts", "utf8");
    expect(source).toContain("prepareCompiler"); expect(source).toContain("resolveCompiler"); expect(source).toContain("orchestratePreparedAutoCompiler"); expect(source).toContain("projectTrustedResolvedCompilerArtifact"); expect(source).toContain("GameSession");
    expect(source).not.toMatch(/resolveDraftModule|mechanics-reachability/i);
  });

  it("resolves catalog IDs and creates sessions from trusted bundle IDs", async () => {
    const value = await compiledModuleHttpFixture();
    const root = mkdtempSync(join(tmpdir(), "compiled-http-id-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = catalog.savePrepared(value.prepared.artifact);
      expect(prepared.status).toBe("ok");
      if (prepared.status !== "ok") return;
      const review = catalog.saveTrustedPresentationReview(prepared.value.id, value.prepared.artifact, value.resolved.artifact, "operator:catalog-id", exactReviewBindings(value.resolved.artifact.payload as any));
      if (review.status !== "ok") throw new Error(review.message);
      const resolved = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preparedArtifactId: prepared.value.id, preparedQueueHash: value.prepared.identity.preparedQueueHash, hints: hints(value.prepared), presentationReviewId: review.value.id }) }), dependencies(undefined, catalog));
      expect(resolved?.status).toBe(200);
      const body = await resolved?.json() as { bundleId: string };
      expect(body.bundleId).toMatch(/^[a-z2-7]{24}$/);
      const session = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundleId: body.bundleId, archetype: "investigator", characterName: "Ada" }) }), dependencies(undefined, catalog));
      expect(session?.status).toBe(201);
      expect(await session?.json()).toMatchObject({ bundleId: body.bundleId });
      const read = await handleCompiledModuleHttpRequest(new Request(`http://test/api/compiler/bundles/${body.bundleId}`), dependencies(undefined, catalog));
      expect(read?.status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects raw presentation and publishes only a catalog-backed exact-source review", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-presentation-review-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const raw = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: prepared.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash, hints: (fixture.resolved.artifact.payload as any).hints, presentation: { unsafe: true } }),
      }), dependencies(undefined, catalog));
      expect(raw?.status).toBe(400);

      const bindings = exactReviewBindings(fixture.resolved.artifact.payload as any);
      const forged = structuredClone(bindings);
      const sourceExact = forged.find((binding) => binding.kind === "source_exact");
      if (!sourceExact || sourceExact.kind !== "source_exact") throw new Error("fixture has no source_exact review binding");
      sourceExact.quote = "not source text";
      expect(catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:fixture", forged)).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });
      const originalSourceExact = bindings.find((binding) => binding.kind === "source_exact");
      if (!originalSourceExact || originalSourceExact.kind !== "source_exact") throw new Error("fixture has no source_exact review binding");
      const foreignHeading = (fixture.resolved.artifact.payload as any).graph.statements.find((statement: any) => statement.kind === "heading" && statement.id !== originalSourceExact.headingStatementId)!;
      const wrongScope = structuredClone(bindings);
      const wrongScopeSourceExact = wrongScope.find((binding) => binding.kind === "source_exact");
      if (!wrongScopeSourceExact || wrongScopeSourceExact.kind !== "source_exact") throw new Error("fixture has no source_exact review binding");
      wrongScopeSourceExact.headingStatementId = foreignHeading.id;
      expect(catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:fixture", wrongScope)).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });
      const review = catalog.saveTrustedPresentationReview(prepared.value.id, fixture.prepared.artifact, fixture.resolved.artifact, "operator:fixture", bindings);
      if (review.status !== "ok") throw new Error(review.message);
      expect(catalog.loadTrustedPresentationReview(review.value.id)).toMatchObject({ status: "ok", value: { reviewHash: review.value.reviewHash } });
      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: prepared.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash, hints: (fixture.resolved.artifact.payload as any).hints, presentationReviewId: review.value.id }),
      }), dependencies(undefined, catalog));
      expect(response?.status).toBe(200);
      const body = await response?.json() as any;
      expect(JSON.stringify(body.projection.sourceMap)).not.toContain("caller_metadata");
      expect(body.projection.presentationReview).toMatchObject({ id: review.value.id, reviewerPrincipalId: "operator:fixture" });
      expect(catalog.loadBundle(body.bundleId)).toMatchObject({ status: "ok", value: { id: body.bundleId, projection: { presentationReview: { id: review.value.id } } } });

      const reviewPath = join(root, "presentation-reviews", `${review.value.id}.json`);
      const tampered = JSON.parse(readFileSync(reviewPath, "utf8"));
      tampered.review.bindings[0].headingStatementId = "forged-heading";
      writeFileSync(reviewPath, JSON.stringify(tampered));
      const rejected = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: prepared.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash, hints: (fixture.resolved.artifact.payload as any).hints, presentationReviewId: review.value.id }),
      }), dependencies(undefined, catalog));
      expect(rejected?.status).toBe(409);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("mints presentation reviews only as the authenticated operator and binds the stored reviewer principal", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-presentation-review-http-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const bindings = exactReviewBindings(fixture.resolved.artifact.payload as any);
      const mint = (body: Record<string, unknown>, principalId = "operator:reviewer") => handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/presentation-reviews", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }), { ...dependencies(undefined, catalog), authenticateCompilerRequest: () => ({ status: "authenticated", principal: { id: principalId, role: "operator" } }) });
      const request = {
        preparedArtifactId: prepared.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        hints: (fixture.resolved.artifact.payload as any).hints,
        bindings,
      };

      const forgedReviewer = await mint({ ...request, reviewerPrincipalId: "attacker" });
      expect(forgedReviewer?.status).toBe(400);
      expect(await forgedReviewer?.json()).toMatchObject({ error: { code: "REQUEST_SHAPE_INVALID" } });

      const minted = await mint(request);
      expect(minted?.status).toBe(201);
      const mintText = await minted?.text() ?? "";
      const mintBody = JSON.parse(mintText) as { presentationReviewId: string };
      expect(mintBody.presentationReviewId).toMatch(/^[a-z2-7]{24}$/);
      const sourceExactBinding = bindings.find((binding) => binding.kind === "source_exact");
      if (!sourceExactBinding || sourceExactBinding.kind !== "source_exact") throw new Error("fixture has no source_exact review binding");
      expect(mintText).not.toContain(sourceExactBinding.quote);
      expect(mintText).not.toContain("sourceGraphIdentity");
      expect(catalog.loadTrustedPresentationReview(mintBody.presentationReviewId)).toMatchObject({ status: "ok", value: { review: { reviewerPrincipalId: "operator:reviewer" } } });

      const published = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: prepared.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash, hints: (fixture.resolved.artifact.payload as any).hints, presentationReviewId: mintBody.presentationReviewId }),
      }), dependencies(undefined, catalog));
      expect(published?.status).toBe(200);
      const publishedBody = await published?.json() as { projection?: { compiledPresentationDisclosure?: unknown } };
      expect(publishedBody.projection?.compiledPresentationDisclosure).toEqual({
        opaqueUnavailableModuleFields: ["era", "expectedDuration", "playerCount", "summary", "title", "triggerWarnings", "version"],
      });

      const foreign = await prepareCompiler({ kind: "synthetic_pages", moduleId: "foreign-review", sourceDescriptor: "foreign-review", pages: PAGES });
      if (foreign.status === "refused") throw new Error(foreign.message);
      const foreignPrepared = catalog.savePrepared(foreign.artifact);
      if (foreignPrepared.status !== "ok") throw new Error(foreignPrepared.message);
      const foreignResolve = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: foreignPrepared.value.id, preparedQueueHash: foreign.identity.preparedQueueHash, hints: hints(foreign), presentationReviewId: mintBody.presentationReviewId }),
      }), dependencies(undefined, catalog));
      expect(foreignResolve?.status).toBe(409);
      expect(await foreignResolve?.json()).toMatchObject({ error: { code: "PRESENTATION_REVIEW_MISMATCH" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // This intentionally exhausts server-owned slot and candidate cursors, then
  // verifies every tamper boundary. It is one multi-stage HTTP contract.
  it("returns an operator-only, read-only authoritative presentation workbench with stable source-bound candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-presentation-workbench-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const continuation = catalog.saveAutoResolveContinuation(
        prepared.value.id,
        fixture.prepared.artifact,
        (fixture.resolved.artifact.payload as any).hints,
      );
      if (continuation.status !== "ok") throw new Error(continuation.message);
      let reviewWrites = 0;
      let bundleWrites = 0;
      let continuationWrites = 0;
      const saveReview = catalog.saveTrustedPresentationReview.bind(catalog);
      const saveBundle = catalog.saveBundle.bind(catalog);
      const saveContinuation = catalog.saveAutoResolveContinuation.bind(catalog);
      (catalog as any).saveTrustedPresentationReview = (...args: any[]) => { reviewWrites++; return (saveReview as any)(...args); };
      (catalog as any).saveBundle = (...args: any[]) => { bundleWrites++; return (saveBundle as any)(...args); };
      (catalog as any).saveAutoResolveContinuation = (...args: any[]) => { continuationWrites++; return (saveContinuation as any)(...args); };
      const request = (body: Record<string, unknown>) => new Request("http://test/api/compiler/presentation-workbench", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const explicit = {
        preparedArtifactId: prepared.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        hints: (fixture.resolved.artifact.payload as any).hints,
      };
      const llm = new AutoFakeLLM("must not be called by the read-only workbench");
      const workbenchDependencies = autoDependencies(llm, catalog);
      const first = await handleCompiledModuleHttpRequest(request(explicit), workbenchDependencies);
      expect(first?.status).toBe(200);
      const firstBody = await first?.json() as {
        status: string;
        preparedArtifactId: string;
        preparedQueueHash: string;
        resolvedArtifactHash: string;
        workbenchSchemaVersion: string;
        prepared: { artifactId: string; artifactHash: string; identity: unknown };
        resolved: { artifactHash: string; identity: unknown };
        slotPage?: { slots: Array<{
          fieldPath: string;
          allowedBindingKinds: string[];
          sourceCandidateCount: number;
          opaqueBinding: { kind: "opaque_unavailable"; fieldPath: string } | null;
        }>; hasMore: boolean; nextCursor?: string };
        candidatePage?: { fieldPath: string; candidates: Array<{ kind: string; binding: { statementId: string; quote: string }; exactText: string; quotePolicy: string }>; hasMore: boolean; nextCursor?: string };
      };
      expect(firstBody).toMatchObject({
        status: "review_ready",
        preparedArtifactId: prepared.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        resolvedArtifactHash: fixture.resolved.artifact.artifactHash,
        workbenchSchemaVersion: "1.2.0",
        prepared: { artifactId: prepared.value.id, artifactHash: fixture.prepared.artifact.artifactHash, identity: fixture.prepared.identity },
        resolved: { artifactHash: fixture.resolved.artifact.artifactHash, identity: (fixture.resolved.artifact.payload as any).identity },
      });
      expect(firstBody).toHaveProperty("quality");
      expect(JSON.stringify(firstBody)).not.toContain('"artifact"');
      expect(JSON.stringify(firstBody)).not.toContain('"projection"');
      expect(JSON.stringify(firstBody)).not.toContain('"hints"');
      expect(JSON.stringify(firstBody)).not.toContain('"bindings"');
      expect(JSON.stringify(firstBody)).not.toContain("一把档案室钥匙。");
      expect(firstBody).not.toHaveProperty("candidatePage");
      expect(firstBody).not.toHaveProperty("manifest");
      expect(firstBody).toHaveProperty("slotPage");
      expect(firstBody.slotPage?.slots).toHaveLength(TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE);
      expect(firstBody.slotPage?.hasMore).toBe(true);
      expect(firstBody.slotPage?.nextCursor).toEqual(expect.any(String));
      expect(firstBody.slotPage?.slots.every((slot) => !("candidates" in slot) && !("exactText" in slot))).toBe(true);
      const pagedSlots: NonNullable<typeof firstBody.slotPage>["slots"] = [];
      let nextSlotPage = firstBody.slotPage;
      let slotPageCount = 0;
      while (nextSlotPage) {
        slotPageCount++;
        expect(slotPageCount).toBeLessThan(20);
        expect(nextSlotPage.slots.length).toBeLessThanOrEqual(TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE);
        pagedSlots.push(...nextSlotPage.slots);
        if (!nextSlotPage.hasMore) break;
        expect(nextSlotPage.nextCursor).toEqual(expect.any(String));
        const later = await handleCompiledModuleHttpRequest(request({ ...explicit, cursor: nextSlotPage.nextCursor }), workbenchDependencies);
        expect(later?.status).toBe(200);
        nextSlotPage = (await later?.json() as typeof firstBody).slotPage;
      }
      expect(pagedSlots.map((slot) => slot.fieldPath)).toEqual([...pagedSlots.map((slot) => slot.fieldPath)].sort());
      expect(new Set(pagedSlots.map((slot) => slot.fieldPath)).size).toBe(pagedSlots.length);
      const payload: any = fixture.resolved.artifact.payload;
      const expectedSlots: NonNullable<typeof firstBody.slotPage>["slots"] = [];
      for (let offset = 0; ; offset += TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE) {
        const authoritative = buildTrustedPresentationReviewSlotPage(payload, offset);
        if (authoritative.status === "refused") throw new Error(authoritative.message);
        expectedSlots.push(...authoritative.page.slots);
        if (!authoritative.page.hasMore) break;
      }
      expect(pagedSlots).toEqual(expectedSlots);
      const sourceSlot = pagedSlots.find((slot) => slot.fieldPath === "module.title")!;
      expect(sourceSlot).toMatchObject({ allowedBindingKinds: ["source_exact", "opaque_unavailable"], opaqueBinding: { kind: "opaque_unavailable", fieldPath: "module.title" } });
      // This is a real resolved fixture: its broad module title domain crosses
      // the server-owned page boundary rather than mocking a lower layer.
      expect(sourceSlot.sourceCandidateCount).toBeGreaterThan(TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE);
      const pageResponse = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath }), workbenchDependencies);
      expect(pageResponse?.status).toBe(200);
      const pageBody = await pageResponse?.json() as typeof firstBody;
      expect(pageBody).not.toHaveProperty("slotPage");
      expect(pageBody.candidatePage).toMatchObject({ fieldPath: sourceSlot.fieldPath, hasMore: true });
      expect(pageBody.candidatePage?.candidates).toHaveLength(TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE);
      expect(pageBody.candidatePage?.candidates.every((candidate) => candidate.kind === "source_exact")).toBe(true);
      expect(pageBody.candidatePage?.nextCursor).toEqual(expect.any(String));

      const pagedCandidates: Array<{ kind: string; binding: { statementId: string; quote: string }; exactText: string; quotePolicy: string }> = [];
      let nextPage = pageBody.candidatePage;
      let pageCount = 0;
      while (nextPage) {
        pageCount++;
        expect(pageCount).toBeLessThan(20);
        expect(nextPage.candidates.length).toBeLessThanOrEqual(TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE);
        pagedCandidates.push(...nextPage.candidates);
        if (!nextPage.hasMore) break;
        expect(nextPage.nextCursor).toEqual(expect.any(String));
        const later = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, cursor: nextPage.nextCursor }), workbenchDependencies);
        expect(later?.status).toBe(200);
        nextPage = (await later?.json() as typeof firstBody).candidatePage;
      }
      expect(pagedCandidates).toHaveLength(sourceSlot.sourceCandidateCount);
      expect(new Set(pagedCandidates.map((candidate) => JSON.stringify(candidate.binding))).size).toBe(pagedCandidates.length);
      for (const candidate of pagedCandidates) {
        const statement = payload.graph.statements.find((entry: any) => entry.id === candidate.binding.statementId)!;
        expect(candidate).toMatchObject({ kind: "source_exact", exactText: statement.text, quotePolicy: "exact_nonempty_substring" });
        expect(statement.text).toContain(candidate.binding.quote);
      }
      const expectedCandidates: Array<{ kind: string; binding: { statementId: string; quote: string }; exactText: string; quotePolicy: string }> = [];
      for (let offset = 0; ; offset += TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE) {
        const authoritative = buildTrustedPresentationReviewCandidatePage(payload, sourceSlot.fieldPath, offset);
        if (authoritative.status === "refused") throw new Error(authoritative.message);
        expectedCandidates.push(...authoritative.page.candidates);
        if (!authoritative.page.hasMore) break;
      }
      expect(pagedCandidates).toEqual(expectedCandidates);

      const firstCursor = pageBody.candidatePage!.nextCursor!;
      const firstSlotCursor = firstBody.slotPage!.nextCursor!;
      const badCursor = `${firstCursor.slice(0, -1)}${firstCursor.endsWith("A") ? "B" : "A"}`;
      const tampered = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, cursor: badCursor }), workbenchDependencies);
      expect(tampered?.status).toBe(400);
      expect(await tampered?.json()).toMatchObject({ error: { code: "PRESENTATION_WORKBENCH_CURSOR_INVALID" } });
      const badSlotCursor = `${firstSlotCursor.slice(0, -1)}${firstSlotCursor.endsWith("A") ? "B" : "A"}`;
      const tamperedSlot = await handleCompiledModuleHttpRequest(request({ ...explicit, cursor: badSlotCursor }), workbenchDependencies);
      expect(tamperedSlot?.status).toBe(400);
      expect(await tamperedSlot?.json()).toMatchObject({ error: { code: "PRESENTATION_WORKBENCH_CURSOR_INVALID" } });
      const unknownCursor = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, cursor: "unknown" }), workbenchDependencies);
      expect(unknownCursor?.status).toBe(400);
      const cursorWithoutField = await handleCompiledModuleHttpRequest(request({ ...explicit, cursor: firstCursor }), workbenchDependencies);
      expect(cursorWithoutField?.status).toBe(409);
      expect(await cursorWithoutField?.json()).toMatchObject({ error: { code: "PRESENTATION_WORKBENCH_CURSOR_KIND_MISMATCH" } });
      const slotCursorWithField = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, cursor: firstSlotCursor }), workbenchDependencies);
      expect(slotCursorWithField?.status).toBe(409);
      expect(await slotCursorWithField?.json()).toMatchObject({ error: { code: "PRESENTATION_WORKBENCH_CURSOR_KIND_MISMATCH" } });
      const unknownField = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: "module.unknown" }), workbenchDependencies);
      expect(unknownField?.status).toBe(400);
      const callerPageSize = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, pageSize: 999 }), workbenchDependencies);
      expect(callerPageSize?.status).toBe(400);
      const fieldMismatch = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: "module.version", cursor: firstCursor }), workbenchDependencies);
      expect(fieldMismatch?.status).toBe(409);
      expect(await fieldMismatch?.json()).toMatchObject({ error: { code: "PRESENTATION_WORKBENCH_CURSOR_MISMATCH" } });
      const rewriteCursor = (cursor: string, patch: Record<string, unknown>) => {
        const envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        envelope.payload = { ...envelope.payload, ...patch };
        const payloadForIntegrity = envelope.payload;
        envelope.integrity = sha256(payloadForIntegrity.cursorKind === "slot"
          ? JSON.stringify({
            cursorSchemaVersion: payloadForIntegrity.cursorSchemaVersion,
            workbenchSchemaVersion: payloadForIntegrity.workbenchSchemaVersion,
            cursorKind: payloadForIntegrity.cursorKind,
            resolvedArtifactHash: payloadForIntegrity.resolvedArtifactHash,
            resolvedIdentity: payloadForIntegrity.resolvedIdentity,
            offset: payloadForIntegrity.offset,
            fieldPathOrderHash: payloadForIntegrity.fieldPathOrderHash,
          })
          : JSON.stringify({
            cursorSchemaVersion: payloadForIntegrity.cursorSchemaVersion,
            workbenchSchemaVersion: payloadForIntegrity.workbenchSchemaVersion,
            cursorKind: payloadForIntegrity.cursorKind,
            resolvedArtifactHash: payloadForIntegrity.resolvedArtifactHash,
            resolvedIdentity: payloadForIntegrity.resolvedIdentity,
            fieldPath: payloadForIntegrity.fieldPath,
            offset: payloadForIntegrity.offset,
            sourceCandidateOrderHash: payloadForIntegrity.sourceCandidateOrderHash,
          }));
        return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
      };
      const staleSchema = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, cursor: rewriteCursor(firstCursor, { workbenchSchemaVersion: "1.0.0" }) }), workbenchDependencies);
      expect(staleSchema?.status).toBe(400);
      const staleArtifact = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, cursor: rewriteCursor(firstCursor, { resolvedArtifactHash: "0".repeat(64) }) }), workbenchDependencies);
      expect(staleArtifact?.status).toBe(409);
      const cursorPayload = JSON.parse(Buffer.from(firstCursor, "base64url").toString("utf8")).payload;
      const staleIdentity = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, cursor: rewriteCursor(firstCursor, { resolvedIdentity: { ...cursorPayload.resolvedIdentity, mechanicsHash: "0".repeat(64) } }) }), workbenchDependencies);
      expect(staleIdentity?.status).toBe(409);
      const unknownOffset = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, cursor: rewriteCursor(firstCursor, { offset: Math.ceil((sourceSlot.sourceCandidateCount + 1) / TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE) * TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE }) }), workbenchDependencies);
      expect(unknownOffset?.status).toBe(409);
      const staleOrder = await handleCompiledModuleHttpRequest(request({ ...explicit, fieldPath: sourceSlot.fieldPath, cursor: rewriteCursor(firstCursor, { sourceCandidateOrderHash: "0".repeat(64) }) }), workbenchDependencies);
      expect(staleOrder?.status).toBe(409);
      const staleSlotSchema = await handleCompiledModuleHttpRequest(request({ ...explicit, cursor: rewriteCursor(firstSlotCursor, { workbenchSchemaVersion: "1.1.0" }) }), workbenchDependencies);
      expect(staleSlotSchema?.status).toBe(400);
      const staleSlotArtifact = await handleCompiledModuleHttpRequest(request({ ...explicit, cursor: rewriteCursor(firstSlotCursor, { resolvedArtifactHash: "0".repeat(64) }) }), workbenchDependencies);
      expect(staleSlotArtifact?.status).toBe(409);
      const slotCursorPayload = JSON.parse(Buffer.from(firstSlotCursor, "base64url").toString("utf8")).payload;
      const staleSlotIdentity = await handleCompiledModuleHttpRequest(request({ ...explicit, cursor: rewriteCursor(firstSlotCursor, { resolvedIdentity: { ...slotCursorPayload.resolvedIdentity, mechanicsHash: "0".repeat(64) } }) }), workbenchDependencies);
      expect(staleSlotIdentity?.status).toBe(409);
      const unknownSlotOffset = await handleCompiledModuleHttpRequest(request({ ...explicit, cursor: rewriteCursor(firstSlotCursor, { offset: Math.ceil((pagedSlots.length + 1) / TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE) * TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE }) }), workbenchDependencies);
      expect(unknownSlotOffset?.status).toBe(409);
      const staleFieldOrder = await handleCompiledModuleHttpRequest(request({ ...explicit, cursor: rewriteCursor(firstSlotCursor, { fieldPathOrderHash: "0".repeat(64) }) }), workbenchDependencies);
      expect(staleFieldOrder?.status).toBe(409);

      const resumed = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: prepared.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: continuation.value.id,
      }), workbenchDependencies);
      expect(resumed?.status).toBe(200);
      expect(await resumed?.json()).toEqual(firstBody);
      const stale = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: prepared.value.id,
        preparedQueueHash: "stale",
        autoContinuationId: continuation.value.id,
      }), dependencies(undefined, catalog));
      expect(stale?.status).toBe(409);
      expect(await stale?.json()).toMatchObject({ error: { code: "AUTO_CONTINUATION_MISMATCH" } });
      const foreign = await prepareCompiler({ kind: "synthetic_pages", moduleId: "foreign-workbench", sourceDescriptor: "foreign-workbench", pages: PAGES });
      if (foreign.status === "refused") throw new Error(foreign.message);
      const foreignPrepared = catalog.savePrepared(foreign.artifact);
      if (foreignPrepared.status !== "ok") throw new Error(foreignPrepared.message);
      const foreignResponse = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: foreignPrepared.value.id,
        preparedQueueHash: foreign.identity.preparedQueueHash,
        autoContinuationId: continuation.value.id,
      }), workbenchDependencies);
      expect(foreignResponse?.status).toBe(409);
      expect(await foreignResponse?.json()).toMatchObject({ error: { code: "AUTO_CONTINUATION_MISMATCH" } });
      const foreignCursor = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: foreignPrepared.value.id,
        preparedQueueHash: foreign.identity.preparedQueueHash,
        hints: hints(foreign),
        fieldPath: sourceSlot.fieldPath,
        cursor: firstCursor,
      }), workbenchDependencies);
      expect(foreignCursor?.status).toBe(409);
      expect(await foreignCursor?.json()).toMatchObject({ error: { code: "PRESENTATION_WORKBENCH_CURSOR_MISMATCH" } });
      const foreignSlotCursor = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: foreignPrepared.value.id,
        preparedQueueHash: foreign.identity.preparedQueueHash,
        hints: hints(foreign),
        cursor: firstSlotCursor,
      }), workbenchDependencies);
      expect(foreignSlotCursor?.status).toBe(409);
      expect(await foreignSlotCursor?.json()).toMatchObject({ error: { code: "PRESENTATION_WORKBENCH_CURSOR_MISMATCH" } });
      const continuationPath = join(root, "continuations", `${continuation.value.id}.json`);
      const corruptContinuation = JSON.parse(readFileSync(continuationPath, "utf8"));
      corruptContinuation.continuationHash = "0".repeat(64);
      writeFileSync(continuationPath, JSON.stringify(corruptContinuation));
      const corrupt = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: prepared.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: continuation.value.id,
      }), dependencies(undefined, catalog));
      expect(corrupt?.status).toBe(409);
      expect(await corrupt?.json()).toMatchObject({ error: { code: "CATALOG_CORRUPT" } });
      expect(reviewWrites).toBe(0);
      expect(bundleWrites).toBe(0);
      expect(continuationWrites).toBe(0);
      expect(llm.calls).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("paginates legal workbench bindings through mint, resolve, and real compiled-session generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-presentation-workbench-roundtrip-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const payload = fixture.resolved.artifact.payload as any;
      const workbenchBody = {
        preparedArtifactId: prepared.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        hints: payload.hints,
      };
      const workbenchRequest = (body: Record<string, unknown>) => new Request("http://test/api/compiler/presentation-workbench", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const firstSlotResponse = await handleCompiledModuleHttpRequest(workbenchRequest(workbenchBody), dependencies(undefined, catalog));
      expect(firstSlotResponse?.status).toBe(200);
      type WorkbenchSlot = { fieldPath: string; sourceCandidateCount: number; opaqueBinding: { kind: "opaque_unavailable"; fieldPath: string } | null };
      type WorkbenchSlotPage = { slots: WorkbenchSlot[]; hasMore: boolean; nextCursor?: string };
      const expectedQuality = summarizeCompilerRuntimeQuality(payload);
      const firstSlotBody = await firstSlotResponse?.json() as { slotPage: WorkbenchSlotPage; quality: unknown };
      expect(firstSlotBody.quality).toEqual(expectedQuality);
      let slotPage = firstSlotBody.slotPage;
      const slots: WorkbenchSlot[] = [];
      for (let pageCount = 0; ; pageCount++) {
        expect(pageCount).toBeLessThan(20);
        expect(slotPage.slots.length).toBeLessThanOrEqual(TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE);
        slots.push(...slotPage.slots);
        if (!slotPage.hasMore) break;
        expect(slotPage.nextCursor).toEqual(expect.any(String));
        const later = await handleCompiledModuleHttpRequest(workbenchRequest({ ...workbenchBody, cursor: slotPage.nextCursor }), dependencies(undefined, catalog));
        expect(later?.status).toBe(200);
        slotPage = (await later?.json() as { slotPage: WorkbenchSlotPage }).slotPage;
      }
      expect(slots.length).toBeGreaterThan(TRUSTED_PRESENTATION_WORKBENCH_SLOT_PAGE_SIZE);
      const selected: Array<{ kind: string; fieldPath: string }> = [];
      for (const slot of slots) {
        if (slot.sourceCandidateCount > 0) {
          const pageResponse = await handleCompiledModuleHttpRequest(workbenchRequest({ ...workbenchBody, fieldPath: slot.fieldPath }), dependencies(undefined, catalog));
          expect(pageResponse?.status).toBe(200);
          const page = await pageResponse?.json() as { candidatePage: { candidates: Array<{ binding: { kind: string; fieldPath: string } }> } };
          selected.push(page.candidatePage.candidates[0]!.binding);
        } else {
          if (!slot.opaqueBinding) throw new Error(`workbench slot has no direct binding: ${slot.fieldPath}`);
          selected.push(slot.opaqueBinding);
        }
      }
      const bindingAttempts: Array<Array<{ kind: string; fieldPath: string }>> = [];
      for (const slot of slots) {
        // Pure page iteration checks every exact candidate against the same
        // final validator; the bindings actually published above came from
        // the paginated HTTP workbench, never an unbounded plan helper.
        for (let offset = 0; ; offset += TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE) {
          const page = buildTrustedPresentationReviewCandidatePage(payload, slot.fieldPath, offset);
          if (page.status === "refused") throw new Error(page.message);
          for (const candidate of page.page.candidates) {
            bindingAttempts.push(selected.map((binding) => binding.fieldPath === slot.fieldPath ? candidate.binding : binding));
          }
          if (!page.page.hasMore) break;
        }
        if (slot.opaqueBinding) {
          bindingAttempts.push(selected.map((binding) => binding.fieldPath === slot.fieldPath ? slot.opaqueBinding! : binding));
        }
      }
      const validatedAttempts = validateTrustedPresentationReviewBindingAttempts(payload, bindingAttempts);
      expect(validatedAttempts).toHaveLength(bindingAttempts.length);
      for (const validated of validatedAttempts) expect(validated).toMatchObject({ status: "validated" });
      // The single-review public API delegates to the same final validator.
      expect(validateTrustedPresentationReviewBindings(payload, bindingAttempts[0]!)).toMatchObject({ status: "validated" });

      // A batch cannot retain a prior payload's validation state. Both a
      // distinct canonical artifact and a tampered payload fail closed.
      const foreignPrepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "http-fixture-foreign", sourceDescriptor: "http-fixture-foreign", pages: PAGES });
      if (foreignPrepared.status === "refused") throw new Error(foreignPrepared.message);
      const foreignResolved = resolveCompiler(foreignPrepared.artifact, foreignPrepared.identity.preparedQueueHash, hints(foreignPrepared));
      if (foreignResolved.status === "refused") throw new Error(foreignResolved.message);
      expect(validateTrustedPresentationReviewBindingAttempts(foreignResolved.artifact.payload as any, [bindingAttempts[0]!])[0]).toMatchObject({ status: "refused" });
      const tamperedPayload = structuredClone(payload);
      tamperedPayload.identity.moduleId = "tampered-workbench-payload";
      expect(validateTrustedPresentationReviewBindingAttempts(tamperedPayload, [bindingAttempts[0]!])[0]).toMatchObject({ status: "refused" });
      const mint = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/presentation-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: prepared.value.id,
          preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
          hints: payload.hints,
          bindings: selected,
        }),
      }), dependencies(undefined, catalog));
      expect(mint?.status).toBe(201);
      const review = await mint?.json() as { presentationReviewId: string };
      const published = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: prepared.value.id,
          preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
          hints: payload.hints,
          presentationReviewId: review.presentationReviewId,
        }),
      }), dependencies(undefined, catalog));
      expect(published?.status).toBe(200);
      const bundle = await published?.json() as { bundleId: string; quality: unknown };
      expect(bundle.quality).toEqual(expectedQuality);
      const sessions = new Map<string, GameSession>();
      const compiledDurableHostCapability = Object.freeze(Object.create(null)) as object;
      const created = await handleCompiledModuleHttpRequest(new Request("http://test/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId: bundle.bundleId, archetype: "investigator", characterName: "Ada" }),
      }), {
        compiledDurableHostCapability,
        compiledSessionCreationAdmission: new CompiledSessionCreationAdmissionCoordinator({
          root,
          ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
        }),
        generateId: () => "workbench-runtime",
        hasSession: (id) => sessions.has(id),
        createSession: (id, archetype, characterName, persona) => new GameSession(
          id,
          "cosmic-horror",
          { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 },
          archetype,
          characterName,
          persona,
          { careerRoot: join(root, "careers") },
          undefined,
          "preferred",
          { compiledDurableHostCapability },
        ),
        registerSession: (id, session) => sessions.set(id, session as GameSession),
        persistSession: () => undefined,
        authenticateCompilerRequest: operatorAuthenticator,
        catalog,
      });
      expect(created?.status).toBe(201);
      const createdBody = await created?.json() as { sessionId: string };
      const durable = sessions.get(createdBody.sessionId)!;
      const durableActions = durable.getCompiledAvailableActions();
      expect(durableActions.length).toBeGreaterThan(0);
      const committed = commitCompiledDurableAction(durable, compiledDurableHostCapability, durableActions[0]!.command, "workbench-runtime-action", 0, () => undefined);
      expect(committed).toMatchObject({ status: "committed", generation: 1 });

      // The normal in-memory GameSession execution path accepts the same
      // published command and advances generation without any model call.
      const stored = catalog.loadBundle(bundle.bundleId);
      if (stored.status !== "ok") throw new Error(stored.message);
      const direct = new GameSession("workbench-direct", "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, "investigator", "Ada", undefined, { careerRoot: join(root, "direct-careers") });
      expect(direct.loadCompiledModule(stored.value.artifact.payload as any, stored.value.projection).status).toBe("loaded");
      const actions = direct.getCompiledAvailableActions();
      expect(actions.length).toBeGreaterThan(0);
      const beforeGeneration = direct.getCompiledGeneration();
      const acted = await direct.act(actions[0]!.command);
      expect(acted).not.toHaveProperty("error");
      expect(direct.getCompiledGeneration()).toBe((beforeGeneration ?? 0) + 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("rejects every caller-supplied presentation or auto-resolution trust/control field before model or bundle side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-untrusted-shape-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      let bundleWrites = 0;
      const saveBundle = catalog.saveBundle.bind(catalog);
      (catalog as any).saveBundle = (artifact: unknown, projection: unknown) => { bundleWrites++; return saveBundle(artifact, projection); };
      const llm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const local = await orchestratePreparedAutoCompiler({
        prepared: fixture.prepared,
        llm: new AutoFakeLLM((messages) => fullAutoReply(messages)),
        policy: { policyId: "server-auto-test-v1", rightsStatus: "user_provided" },
        producer: { providerFingerprint: "server:auto-test", modelFingerprint: "model:auto-test" },
        proposalLimits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxRequestChars: 24_000, maxResponseTokens: 2_400 },
        maxProposalRounds: 2,
      });
      if (local.status !== "resolved") throw new Error(JSON.stringify(local.diagnostics));
      const request = (extra: Record<string, unknown>) => new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash, ...extra }),
      });

      for (const extra of [
        // This metadata matches a genuinely resolved automatic artifact. A
        // mutation that restores caller presentation publication therefore
        // writes a bundle instead of merely failing projection validation.
        { presentation: autoPresentation(local.resolved) },
        { trust: { rightsStatus: "project_original" } },
        { limits: { maxRequestsPerRound: 99 } },
        { preparedArtifact: fixture.prepared.artifact },
      ]) {
        const response = await handleCompiledModuleHttpRequest(request(extra), autoDependencies(llm, catalog));
        expect(response?.status).toBe(400);
        expect(await response?.json()).toMatchObject({ error: { code: "REQUEST_SHAPE_INVALID" } });
      }
      expect(llm.calls).toEqual([]);
      expect(bundleWrites).toBe(0);
      expect(existsSync(join(root, "bundles"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps mechanically closed automatic mechanics visibility-unresolved and never returns or stores Keeper-only presentation", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-resolved-"));
    try {
      const keeperOnly = "KEEPER_ONLY_AUTO_PRESENTATION_SENTINEL";
      const undiscovered = "UNDISCOVERED_CLUE_AUTO_PRESENTATION_SENTINEL";
      const prepared = await prepareCompiler({
        kind: "synthetic_pages",
        moduleId: "auto-private-source",
        sourceDescriptor: "auto-private-source",
        pages: [`${PAGES[0]!}\nKeeper-only: ${keeperOnly}.\nUndiscovered clue: ${undiscovered}.`],
      });
      if (prepared.status === "refused") throw new Error(prepared.message);
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      let bundleWrites = 0;
      const saveBundle = catalog.saveBundle.bind(catalog);
      (catalog as any).saveBundle = (artifact: unknown, projection: unknown) => { bundleWrites++; return saveBundle(artifact, projection); };
      const llm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: prepared.identity.preparedQueueHash }),
      }), autoDependencies(llm, catalog));

      expect(response?.status).toBe(200);
      const responseText = await response?.text() ?? "";
      const body = JSON.parse(responseText) as Record<string, unknown>;
      expect(body.continuationId).toMatch(/^[a-z2-7]{24}$/);
      expect(body).toMatchObject({
        status: "presentation_draft_only",
        preparedArtifactId: saved.value.id,
        mechanics: { readiness: "mechanically_closed" },
        content: {
          dispositionReadiness: expect.any(String),
          rootStatementCount: expect.any(Number),
          openQuestionCount: expect.any(Number),
          openRootCount: expect.any(Number),
          unmodeledRootCount: expect.any(Number),
          positiveCoverage: expect.any(Object),
          counts: expect.any(Object),
        },
        presentation: { readiness: "visibility_unresolved" },
      });
      for (const key of ["artifact", "projection", "bundleId", "hints", "resolutionSnapshot"]) expect(body).not.toHaveProperty(key);
      for (const rawField of ["statementId", "evidenceRefId", "openQuestionIds", "unmodeledStatementIds"]) expect(responseText).not.toContain(rawField);
      expect(responseText).not.toContain(keeperOnly);
      expect(responseText).not.toContain(undiscovered);
      expect(llm.calls.length).toBeGreaterThan(0);
      expect(bundleWrites).toBe(0);
      expect(existsSync(join(root, "bundles"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not report a machine-published module when its catalog bundle reservation refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-machine-publication-refusal-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);

      let selectorCalls = 0;
      let bundleWrites = 0;
      const saveBundle = catalog.saveBundle.bind(catalog);
      let refuseFirstBundle = true;
      (catalog as any).saveBundle = (...args: Parameters<typeof catalog.saveBundle>) => {
        bundleWrites++;
        if (refuseFirstBundle) {
          refuseFirstBundle = false;
          return { status: "refused", code: "CATALOG_INCOMPATIBLE", message: "test bundle reservation refusal" };
        }
        return saveBundle(...args);
      };
      const configured = autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), catalog);
      (configured.autoCompiler as any).machinePublisher = {
        servicePrincipalId: "service:compiler-publisher",
        policyId: "test-machine-presentation-v1",
        select: async (input: unknown) => {
          selectorCalls++;
          return { ...completeMachineSelections(input), requestHash: "0".repeat(64), responseHash: "1".repeat(64) };
        },
      };

      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), configured);

      expect(response?.status).toBe(409);
      const refused = await response?.json() as { error: { code: string }; autoContinuationId?: string; recovery?: string };
      if (typeof refused.autoContinuationId !== "string") throw new Error(JSON.stringify(refused));
      const recoveryContinuationId = refused.autoContinuationId;
      expect(refused).toMatchObject({ error: { code: "CATALOG_INCOMPATIBLE" }, autoContinuationId: expect.stringMatching(/^[a-z2-7]{24}$/), recovery: "retry this automatic continuation" });
      expect(selectorCalls).toBe(1);
      expect(bundleWrites).toBe(1);
      const restartedCatalog = new CompilerArtifactCatalog({ root });
      const persistedContinuation = restartedCatalog.loadAutoResolveContinuation(recoveryContinuationId);
      expect(persistedContinuation.status).toBe("ok");
      if (persistedContinuation.status !== "ok" || !persistedContinuation.value.machinePublication) throw new Error("machine publication reservation was not durable");
      const reservation = persistedContinuation.value.machinePublication;
      const restarted = autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), restartedCatalog, new CompilerAutoAdmissionController({
        ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
        root: restartedCatalog.root,
        startsPerPrincipal: 64,
      }));
      (restarted.autoCompiler as NonNullable<typeof restarted.autoCompiler>).machinePublisher = {
        servicePrincipalId: "service:compiler-publisher",
        policyId: "test-machine-presentation-v1",
        select: async (input: unknown) => {
          selectorCalls++;
          return { ...completeMachineSelections(input), requestHash: "0".repeat(64), responseHash: "1".repeat(64) };
        },
      };
      const resumed = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash, autoContinuationId: recoveryContinuationId }),
      }), restarted);
      if (resumed?.status !== 200) throw new Error(`${recoveryContinuationId}: ${await resumed?.text()}`);
      expect(resumed?.status).toBe(200);
      expect((await resumed?.json() as { status: string }).status).toBe("resolved");
      expect(selectorCalls).toBe(1);
      expect(bundleWrites).toBe(1);
      const bundle = restartedCatalog.loadBundle(reservation.bundleId);
      expect(bundle.status).toBe("ok");
      if (bundle.status !== "ok") throw new Error(bundle.message);
      expect(bundle.value.projection.presentationReview?.id).toBe(reservation.reviewId);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed on a resumed durable machine reservation whose review receipt is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-machine-missing-receipt-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);

      let selectorCalls = 0;
      let bundleWrites = 0;
      (catalog as any).saveBundle = () => {
        bundleWrites++;
        return { status: "refused", code: "CATALOG_INCOMPATIBLE", message: "test bundle reservation refusal" };
      };
      const configured = autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), catalog);
      (configured.autoCompiler as NonNullable<typeof configured.autoCompiler>).machinePublisher = {
        servicePrincipalId: "service:compiler-publisher",
        policyId: "test-machine-presentation-v1",
        select: async (input) => {
          selectorCalls++;
          return { ...completeMachineSelections(input), requestHash: "a".repeat(64), responseHash: "b".repeat(64) };
        },
      };
      const request = (autoContinuationId?: string) => new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: saved.value.id,
          preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
          ...(autoContinuationId ? { autoContinuationId } : {}),
        }),
      });
      const initial = await handleCompiledModuleHttpRequest(request(), configured);
      expect(initial?.status).toBe(409);
      const initialBody = await initial?.json() as { autoContinuationId?: string };
      if (typeof initialBody.autoContinuationId !== "string") throw new Error("durable recovery continuation was not returned");
      const continuationId = initialBody.autoContinuationId;
      const continuation = catalog.loadAutoResolveContinuation(continuationId);
      expect(continuation.status).toBe("ok");
      if (continuation.status !== "ok" || !continuation.value.machinePublication) throw new Error("machine reservation was not durable");
      const reservation = continuation.value.machinePublication;
      rmSync(join(root, "presentation-reviews", `${reservation.reviewId}.json`));

      const restartedCatalog = new CompilerArtifactCatalog({ root });
      const restarted = autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), restartedCatalog, new CompilerAutoAdmissionController({
        ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
        root: restartedCatalog.root,
        startsPerPrincipal: 64,
      }));
      (restarted.autoCompiler as NonNullable<typeof restarted.autoCompiler>).machinePublisher = {
        servicePrincipalId: "service:compiler-publisher",
        policyId: "test-machine-presentation-v1",
        select: async (input) => {
          selectorCalls++;
          return { ...completeMachineSelections(input), requestHash: "a".repeat(64), responseHash: "b".repeat(64) };
        },
      };
      const resumed = await handleCompiledModuleHttpRequest(request(continuationId), restarted);
      expect(resumed?.status).toBe(503);
      expect(await resumed?.json()).toMatchObject({ error: { code: "AUTO_PUBLICATION_RECEIPT_MISSING" } });
      expect(selectorCalls).toBe(1);
      expect(bundleWrites).toBe(1);
      expect(restartedCatalog.loadBundle(reservation.bundleId)).toMatchObject({ status: "refused", code: "CATALOG_NOT_FOUND" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("creates a new machine reservation when a legal draft-warning answer advances a closed continuation", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-machine-progress-reservation-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const warning = fixture.prepared.artifact.payload.preparedQueue.questions.find((question) => question.severity === "draft_warning");
      if (!warning) throw new Error("fixture has no generated draft-warning question");
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const request = (autoContinuationId?: string) => new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: saved.value.id,
          preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
          ...(autoContinuationId ? { autoContinuationId } : {}),
        }),
      });
      const omitWarning = new AutoFakeLLM((messages) => {
        const reply = JSON.parse(fullAutoReply(messages)) as { proposals: Array<{ questionId: string }> };
        return JSON.stringify({ proposals: reply.proposals.filter((proposal) => proposal.questionId !== warning.id) });
      });
      let selectorCalls = 0;
      const initialDependencies = autoDependencies(omitWarning, catalog);
      (initialDependencies.autoCompiler as NonNullable<typeof initialDependencies.autoCompiler>).machinePublisher = {
        servicePrincipalId: "service:compiler-publisher",
        policyId: "test-machine-presentation-v1",
        select: async (input) => {
          selectorCalls++;
          return { ...completeMachineSelections(input), requestHash: "c".repeat(64), responseHash: "d".repeat(64) };
        },
      };
      const initial = await handleCompiledModuleHttpRequest(request(), initialDependencies);
      expect(initial?.status).toBe(200);
      expect((await initial?.json() as { status: string }).status).toBe("resolved");
      const initialContinuationIds = readdirSync(join(root, "continuations"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
      expect(initialContinuationIds).toHaveLength(1);
      const initialContinuation = catalog.loadAutoResolveContinuation(initialContinuationIds[0]!);
      expect(initialContinuation.status).toBe("ok");
      if (initialContinuation.status !== "ok" || !initialContinuation.value.machinePublication) throw new Error("initial closed warning continuation has no machine reservation");
      const oldReservation = initialContinuation.value.machinePublication;
      expect(catalog.loadBundle(oldReservation.bundleId).status).toBe("ok");

      const advancedDependencies = autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), catalog);
      (advancedDependencies.autoCompiler as NonNullable<typeof advancedDependencies.autoCompiler>).machinePublisher = {
        servicePrincipalId: "service:compiler-publisher",
        policyId: "test-machine-presentation-v1",
        select: async (input) => {
          selectorCalls++;
          return { ...completeMachineSelections(input), requestHash: "e".repeat(64), responseHash: "f".repeat(64) };
        },
      };
      const advanced = await handleCompiledModuleHttpRequest(request(initialContinuationIds[0]!), advancedDependencies);
      expect(advanced?.status).toBe(200);
      expect((await advanced?.json() as { status: string }).status).toBe("resolved");
      const continuationIds = readdirSync(join(root, "continuations"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length));
      expect(continuationIds).toHaveLength(2);
      const newContinuationId = continuationIds.find((id) => id !== initialContinuationIds[0]);
      if (!newContinuationId) throw new Error("warning progress reused the original continuation");
      const nextContinuation = catalog.loadAutoResolveContinuation(newContinuationId);
      expect(nextContinuation.status).toBe("ok");
      if (nextContinuation.status !== "ok" || !nextContinuation.value.machinePublication) throw new Error("advanced continuation has no machine reservation");
      const newReservation = nextContinuation.value.machinePublication;
      expect(newReservation.resolvedArtifactHash).not.toBe(oldReservation.resolvedArtifactHash);
      expect(newReservation.resolvedIdentity).not.toEqual(oldReservation.resolvedIdentity);
      expect(newReservation.reviewId).not.toBe(oldReservation.reviewId);
      expect(newReservation.bundleId).not.toBe(oldReservation.bundleId);
      expect(catalog.loadBundle(oldReservation.bundleId).status).toBe("ok");
      expect(catalog.loadBundle(newReservation.bundleId).status).toBe("ok");
      expect(selectorCalls).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("returns a durable machine bundle when its active fenced commit crosses the whole-job deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-machine-atomic-publish-"));
    try {
      let now = 1_000;
      const catalog = new CompilerArtifactCatalog({
        root,
        fileOps: {
          ...compilerArtifactCatalogNodeFileOps,
          publish(temp, target) {
            compilerArtifactCatalogNodeFileOps.publish(temp, target);
            if (target.includes("bundles")) now += 11;
          },
        },
      });
      const fixture = await compiledModuleHttpFixture();
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const controller = new CompilerAutoAdmissionController({
        ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
        root,
        leaseTtlMs: 100,
        wholeJobDeadlineMs: 10,
        now: () => now,
      });
      const configured = autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), catalog, controller);
      (configured.autoCompiler as NonNullable<typeof configured.autoCompiler>).machinePublisher = {
        servicePrincipalId: "service:compiler-publisher",
        policyId: "test-machine-presentation-v1",
        select: async (input) => ({ ...completeMachineSelections(input), requestHash: "1".repeat(64), responseHash: "2".repeat(64) }),
      };
      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), configured);
      expect(now).toBeGreaterThan(1_010);
      expect(response?.status).toBe(200);
      const body = await response?.json() as { status: string; bundleId: string };
      expect(body.status).toBe("resolved");
      expect(catalog.loadBundle(body.bundleId).status).toBe("ok");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a selector that finishes after the deadline before review or bundle publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-machine-late-selector-"));
    try {
      let now = 1_000;
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const controller = new CompilerAutoAdmissionController({
        ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
        root,
        leaseTtlMs: 100,
        wholeJobDeadlineMs: 10,
        now: () => now,
      });
      let selectorCalls = 0;
      const configured = autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), catalog, controller);
      (configured.autoCompiler as NonNullable<typeof configured.autoCompiler>).machinePublisher = {
        servicePrincipalId: "service:compiler-publisher",
        policyId: "test-machine-presentation-v1",
        select: async (input) => {
          selectorCalls++;
          now += 11;
          return { ...completeMachineSelections(input), requestHash: "3".repeat(64), responseHash: "4".repeat(64) };
        },
      };
      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), configured);
      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({ error: { code: "AUTO_ADMISSION_DEADLINE_EXCEEDED" } });
      expect(selectorCalls).toBe(1);
      expect(existsSync(join(root, "presentation-reviews"))).toBe(false);
      expect(existsSync(join(root, "bundles"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("publishes an exact non-first machine selection with a durable scoped review", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-machine-publication-success-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      let selectorCalls = 0;
      let capturedSelection: ReturnType<typeof completeMachineSelections> | undefined;
      const configured = autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), catalog);
      (configured.autoCompiler as any).machinePublisher = {
        servicePrincipalId: "service:compiler-publisher",
        policyId: "test-machine-presentation-v1",
        select: async (input: unknown) => {
          selectorCalls++;
          capturedSelection = completeMachineSelections(input);
          return { ...capturedSelection, requestHash: "2".repeat(64), responseHash: "3".repeat(64) };
        },
      };
      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), configured);
      expect(response?.status).toBe(200);
      const body = await response?.json() as { status: string; bundleId: string; projection: { presentationReview?: { machinePublication?: { scopes: Array<{ fieldPath: string; audience: string }> } } } };
      expect(body.status).toBe("resolved");
      expect(body.bundleId).toMatch(/^[a-z2-7]{24}$/);
      expect(selectorCalls).toBe(1);
      expect(capturedSelection?.selectedNonFirstCandidate).toBe(true);
      const bundle = catalog.loadBundle(body.bundleId);
      expect(bundle.status).toBe("ok");
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const review = bundle.value.projection.presentationReview;
      expect(review?.machinePublication?.servicePrincipalId).toBe("service:compiler-publisher");
      const rehydrated = rehydrateTrustedPresentationSelections(
        bundle.value.artifact.payload as any,
        capturedSelection?.selections ?? [],
      );
      expect(rehydrated.status).toBe("rehydrated");
      if (rehydrated.status !== "rehydrated") throw new Error(rehydrated.message);
      expect(review?.bindings).toEqual(rehydrated.bindings);
      expect(review?.machinePublication?.scopes.some((scope) => /^items\.[^.]+\.name$/.test(scope.fieldPath) && scope.audience === "public_on_entry")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects private and future scopes for a player-visible item name before review or bundle publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-machine-item-scope-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      for (const [index, audience] of (["private_context", "found_clue"] as const).entries()) {
        const catalog = new CompilerArtifactCatalog({ root: join(root, `scope-${index}`) });
        const saved = catalog.savePrepared(fixture.prepared.artifact);
        if (saved.status !== "ok") throw new Error(saved.message);
        const configured = autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), catalog);
        (configured.autoCompiler as any).machinePublisher = {
          servicePrincipalId: "service:compiler-publisher",
          policyId: "test-machine-presentation-v1",
          select: async (input: unknown) => {
            const selected = completeMachineSelections(input);
            const itemName = selected.scopes.find((scope) => /^items\.[^.]+\.name$/.test(scope.fieldPath));
            if (!itemName) throw new Error("fixture lacks an item name exposure");
            itemName.audience = audience;
            return { ...selected, requestHash: "4".repeat(64), responseHash: "5".repeat(64) };
          },
        };
        const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
        }), configured);
        expect(response?.status).toBe(422);
        expect(await response?.json()).toMatchObject({ error: { code: "AUTO_PUBLICATION_SCOPE_INVALID" } });
        expect(existsSync(join(catalog.root, "presentation-reviews"))).toBe(false);
        expect(existsSync(join(catalog.root, "bundles"))).toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("consumes the host-owned machine publisher through the actual server auto-resolve path", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-machine-server-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const llm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const controller = new CompilerAutoAdmissionController({
        ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
        root: catalog.root,
      });
      let selectorCalls = 0;
      const response = await handleRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), catalog, undefined, {}, {}, {
        llm,
        isLlmEnabled: () => true,
        admission: controller,
        machinePublisher: {
          servicePrincipalId: "service:compiler-publisher",
          policyId: "test-machine-presentation-v1",
          select: async (input) => {
            selectorCalls++;
            return { ...completeMachineSelections(input), requestHash: "6".repeat(64), responseHash: "7".repeat(64) };
          },
        },
      }, operatorAuthenticator);
      expect(response.status).toBe(200);
      expect((await response.json() as { status: string }).status).toBe("resolved");
      expect(selectorCalls).toBe(1);
      expect(llm.calls.length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("forwards the catalog-restored document identity to auto publication and writes no bundle when profile resolution fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-world-profile-conflict-"));
    try {
      const fixture = await compiledModuleHttpFixture("auto-world-profile-conflict");
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const llm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const configured = autoDependencies(llm, catalog);
      const observedIdentities: Array<{ moduleId: string; artifactHash: string; documentHash: string | null }> = [];
      let bundleWrites = 0;
      const originalSaveBundle = catalog.saveBundle.bind(catalog);
      (catalog as any).saveBundle = (artifact: unknown, projection: unknown, binding?: unknown) => {
        bundleWrites++;
        return originalSaveBundle(artifact, projection, binding);
      };
      configured.resolveCompiledWorldModelBinding = (identity) => {
        observedIdentities.push({ ...identity });
        // This represents the registry's exact+profile conflict. The HTTP
        // route must fail closed before its saveBundle write boundary.
        throw new Error("ambiguous exact and source-profile binding");
      };
      (configured.autoCompiler as NonNullable<typeof configured.autoCompiler>).machinePublisher = {
        servicePrincipalId: "service:auto-world-profile-conflict",
        policyId: "auto-world-profile-conflict-v1",
        select: async (input) => ({
          ...completeMachineSelections(input),
          requestHash: "a".repeat(64),
          responseHash: "b".repeat(64),
        }),
      };

      const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), configured);

      expect(response?.status).toBe(500);
      expect(await response?.json()).toMatchObject({ error: { stage: "resolve", code: "WORLD_MODEL_BINDING_RESOLUTION_FAILED" } });
      expect(observedIdentities).toHaveLength(1);
      expect(observedIdentities[0]).toMatchObject({
        moduleId: fixture.prepared.identity.moduleId,
        documentHash: fixture.prepared.identity.documentHash,
      });
      expect(observedIdentities[0]?.artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(bundleWrites).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("constructs the bounded default machine publisher through the actual server path", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-default-machine-server-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const llm = new AutoFakeLLM((messages) => automaticMachinePublisherReply(messages));
      const controller = new CompilerAutoAdmissionController({
        ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG,
        root: catalog.root,
      });
      const response = await handleRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), catalog, undefined, {}, {}, {
        llm,
        isLlmEnabled: () => true,
        admission: controller,
        machinePublicationEnabled: true,
      }, operatorAuthenticator);
      expect(response.status).toBe(200);
      expect((await response.json() as { status: string }).status).toBe("resolved");
      const selectorCalls = llm.calls.filter((call) => call.messages[1]?.content.includes("server-machine-presentation-selector-v1"));
      expect(selectorCalls.length).toBeGreaterThan(0);
      expect(llm.calls.length).toBeLessThanOrEqual(32);
      expect(llm.calls.every((call) => call.options?.maxAttempts === 1)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not let the default machine publisher release an unfound clue through the current scene description", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-public-clue-release-"));
    const registry = new Map<string, GameSession>();
    try {
      // This fixture is a real prepared DocIR and legal queue resolution.  Its
      // entry-scene clue remains mechanically unfound at generation zero.
      const fixture = await compiledModuleHttpFixture("auto-public-clue-release");
      const payload: any = fixture.resolved.artifact.payload;
      const entrySceneId = payload.analysisInput.entrySceneId as string;
      const protectedFacet = payload.clueFactFacetBindings.find((binding: any) => binding.sceneCandidateId === entrySceneId && binding.shellAtoms.length > 0);
      if (!protectedFacet) throw new Error("fixture lacks an entry-scene clue shell");
      const protectedQuote = protectedFacet.shellAtoms[0]!.quote as string;
      const terminalFacet = payload.clueFactFacetBindings.find((binding: any) => binding.sceneCandidateId !== entrySceneId && binding.shellAtoms.length > 0);
      if (!terminalFacet) throw new Error("fixture lacks a distinct source-exact terminal candidate");
      const terminalQuote = terminalFacet.shellAtoms[0]!.quote as string;
      const protectedClueId = protectedFacet.clueId as string;
      const targetFieldPath = `scenes.${entrySceneId}.description`;
      expect(payload.mechanicsIR.discoveryMethods.some((method: any) => method.clueId === protectedClueId)).toBe(true);
      expect(protectedQuote.trim()).not.toBe("");
      // This remains a valid operator-review candidate. The regression fixes
      // the narrower machine public-release domain, not source provenance.
      const manualCandidates = buildTrustedPresentationReviewCandidatePage(payload, targetFieldPath, 0);
      if (manualCandidates.status === "refused") throw new Error(manualCandidates.message);
      const protectedCandidate = manualCandidates.page.candidates.find((candidate) => candidate.exactText.includes(protectedQuote));
      expect(protectedCandidate).toBeDefined();
      if (!protectedCandidate) return;

      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const observed: { selected: boolean; emptyField?: string; publicTexts: string[]; terminalTexts: string[] } = {
        selected: false,
        publicTexts: [],
        terminalTexts: [],
      };
      const llm = new AutoFakeLLM((messages) => automaticMachinePublisherReplySelectingProtectedSceneCandidate(messages, targetFieldPath, protectedQuote, terminalQuote, observed));
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
      const storage = { careerRoot: join(root, "careers") };
      const playerResolver = () => ({ status: "assigned" as const, principal: { role: "player" as const, id: "player:public-release" } });
      const autoOptions = {
        llm,
        isLlmEnabled: () => true,
        admission: new CompilerAutoAdmissionController({ ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG, root: catalog.root }),
        machinePublicationEnabled: true,
      };
      const invoke = (request: Request, compilerAutoOptions = {}) => handleRequest(
        request, catalog, snapshots, storage, {}, compilerAutoOptions, operatorAuthenticator,
        undefined, playerResolver, undefined, undefined, { registry },
      );

      const resolved = await invoke(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), autoOptions);

      // The default machine publisher must retain an actual safe candidate;
      // a blanket publication refusal is not a release-policy fix.
      if (resolved.status !== 200) throw new Error(`safe machine publication was refused at ${observed.emptyField ?? "an unknown selector slot"}: ${resolved.status} ${await resolved.text()}`);
      const publication = await resolved.json() as { status: string; bundleId: string };
      expect(publication.status).toBe("resolved");
      expect(observed.selected).toBe(false);
      const bundle = catalog.loadBundle(publication.bundleId);
      expect(bundle.status).toBe("ok");
      if (bundle.status !== "ok") return;
      expect(bundle.value.projection.presentationReview?.machinePublication?.servicePrincipalId).toBe("service:server-machine-presentation");

      // A candidate/review hash is only identity, not clearance.  Replacing
      // the safe binding with an ordinary canonical (manual-review-valid)
      // clue-shell candidate and recomputing the receipt's decision hash must
      // still fail at the payload-aware catalog projection boundary.
      const review = bundle.value.projection.presentationReview;
      if (!review?.machinePublication) throw new Error("machine publication receipt is missing");
      const publishedPayload: any = bundle.value.artifact.payload;
      const publishedCandidates = buildTrustedPresentationReviewCandidatePage(publishedPayload, targetFieldPath, 0);
      if (publishedCandidates.status === "refused") throw new Error(publishedCandidates.message);
      const publishedProtectedCandidate = publishedCandidates.page.candidates.find((candidate) => candidate.exactText.includes(protectedQuote));
      if (!publishedProtectedCandidate) throw new Error("published payload lacks the manually valid protected candidate");
      const rehashedBindings = review.bindings.map((binding) => binding.fieldPath === targetFieldPath
        ? structuredClone(publishedProtectedCandidate.binding)
        : structuredClone(binding));
      expect(validateTrustedPresentationReviewBindings(publishedPayload, rehashedBindings)).toMatchObject({ status: "validated" });
      const rehashedPublication = {
        ...review.machinePublication,
        coverageHash: trustedPresentationMachineCoverageIdentity(review.machinePublication.scopes),
        decisionHash: trustedPresentationMachineDecisionIdentity(rehashedBindings, review.machinePublication.scopes),
      };
      expect(catalog.saveTrustedPresentationReview(
        saved.value.id,
        fixture.prepared.artifact,
        bundle.value.artifact,
        review.machinePublication.servicePrincipalId,
        rehashedBindings,
        { machinePublication: rehashedPublication },
      )).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });

      // Candidate-page filtering is not the only guard: a replayed, rehashed
      // review can combine a separately machine-eligible public choice with a
      // terminal choice from the same source range.  The final full binding
      // set must reject that permutation regardless of selector page order.
      const allManualCandidates = (fieldPath: string) => {
        const candidates: Array<{ binding: any; exactText: string }> = [];
        for (let offset = 0; ; offset += TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE) {
          const page = buildTrustedPresentationReviewCandidatePage(publishedPayload, fieldPath, offset);
          if (page.status === "refused") throw new Error(page.message);
          candidates.push(...page.page.candidates);
          if (!page.page.hasMore) return candidates;
        }
      };
      const scopes = review.machinePublication.scopes;
      const publicCandidates = scopes
        .filter((scope) => scope.audience === "public_on_entry")
        .flatMap((scope) => {
          const machinePage = buildTrustedPresentationSelectionCandidatePage(publishedPayload, scope.fieldPath, 0);
          if (machinePage.status === "refused") throw new Error(machinePage.message);
          const machineTexts = new Set(machinePage.page.candidates.map((candidate) => candidate.exactText));
          return allManualCandidates(scope.fieldPath)
            .filter((candidate) => machineTexts.has(candidate.exactText));
        });
      const terminalCandidates = scopes
        .filter((scope) => scope.audience === "terminal_only")
        .flatMap((scope) => allManualCandidates(scope.fieldPath));
      const crossSlotPair = publicCandidates.flatMap((publicCandidate) => terminalCandidates
        .filter((terminalCandidate) => terminalCandidate.binding.statementId === publicCandidate.binding.statementId
          && sourceTextRangesOverlap(terminalCandidate.exactText, publicCandidate.exactText))
        .map((terminalCandidate) => ({ publicCandidate, terminalCandidate })))[0];
      if (!crossSlotPair) throw new Error("fixture lacks a machine-eligible public/terminal source-range pair");
      const crossSlotBindings = review.bindings.map((binding) => binding.fieldPath === crossSlotPair.publicCandidate.binding.fieldPath
        ? structuredClone(crossSlotPair.publicCandidate.binding)
        : binding.fieldPath === crossSlotPair.terminalCandidate.binding.fieldPath
          ? structuredClone(crossSlotPair.terminalCandidate.binding)
          : structuredClone(binding));
      expect(validateTrustedPresentationReviewBindings(publishedPayload, crossSlotBindings)).toMatchObject({ status: "validated" });
      const crossSlotPublication = {
        ...review.machinePublication,
        decisionHash: trustedPresentationMachineDecisionIdentity(crossSlotBindings, scopes),
        coverageHash: trustedPresentationMachineCoverageIdentity(scopes),
      };
      expect(catalog.saveTrustedPresentationReview(
        saved.value.id,
        fixture.prepared.artifact,
        bundle.value.artifact,
        review.machinePublication.servicePrincipalId,
        crossSlotBindings,
        { machinePublication: crossSlotPublication },
      )).toMatchObject({ status: "refused", code: "CATALOG_INCOMPATIBLE" });

      const created = await invoke(new Request("http://test/api/sessions/compiled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId: publication.bundleId, archetype: "investigator", characterName: "Ada" }),
      }));
      expect(created.status).toBe(201);
      const { sessionId } = await created.json() as { sessionId: string };
      const viewResponse = await invoke(new Request(`http://test/api/sessions/${sessionId}/player-view`));
      expect(viewResponse.status).toBe(200);
      const view = await viewResponse.json() as { presentation: { scene: { description: string }; clues: unknown[] } };
      expect(view.presentation.clues).toEqual([]);
      expect(view.presentation.scene.description).not.toContain(protectedQuote);
    } finally {
      for (const session of registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("requires host-provided eligibility when opposite-audience canonical ranges land in separate selector batches", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-cross-batch-selector-"));
    try {
      // A plain paragraph is neither a clue/finding nor an NPC private body.
      // It stays a source-exact public candidate and is also legal ending
      // evidence, so the host must resolve the audience collision rather than
      // treating a protected disclosure as a convenient red fixture.
      const fixture = await compiledModuleHttpFixture("auto-cross-batch-selector", [`${PAGES[0]}\n旅客可以看到墙上画着平台图。`]);
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const baseline = new AutoFakeLLM((messages) => automaticMachinePublisherReply(messages));
      const published = await handleRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), catalog, undefined, {}, {}, {
        llm: baseline,
        isLlmEnabled: () => true,
        admission: new CompilerAutoAdmissionController({ ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG, root: catalog.root }),
        machinePublicationEnabled: true,
      }, operatorAuthenticator);
      expect(published.status).toBe(200);
      const naturalSelectorCalls = baseline.calls.filter(({ messages }) =>
        (messages[1]?.content ?? "").startsWith('{"schemaVersion":"server-machine-presentation-selector-v1"'));
      // This is the default HTTP publisher's native page order, not the
      // later two-page reader-contract probe below.
      expect(naturalSelectorCalls.length).toBeGreaterThanOrEqual(2);
      const publication = await published.json() as { bundleId: string };
      const bundle = catalog.loadBundle(publication.bundleId);
      expect(bundle.status).toBe("ok");
      if (bundle.status !== "ok") return;
      const review = bundle.value.projection.presentationReview;
      if (!review?.machinePublication) throw new Error("baseline machine publication receipt is missing");
      const payload: any = bundle.value.artifact.payload;

      const allManualCandidates = (fieldPath: string) => {
        const candidates: Array<{ binding: any; exactText: string }> = [];
        for (let offset = 0; ; offset += TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE) {
          const page = buildTrustedPresentationReviewCandidatePage(payload, fieldPath, offset);
          if (page.status === "refused") throw new Error(page.message);
          candidates.push(...page.page.candidates);
          if (!page.page.hasMore) return candidates;
        }
      };
      const machineCandidates = (fieldPath: string) => {
        const candidates: Array<{ candidateDigest: string; exactText: string }> = [];
        for (let offset = 0; ; ) {
          const page = buildTrustedPresentationSelectionCandidatePage(payload, fieldPath, offset);
          if (page.status === "refused") throw new Error(page.message);
          candidates.push(...page.page.candidates);
          if (!page.page.hasMore) return candidates;
          offset += page.page.candidates.length;
        }
      };
      const publicCandidates = review.machinePublication.scopes
        .filter((scope) => scope.audience === "public_on_entry")
        .flatMap((scope) => {
          const texts = new Set(machineCandidates(scope.fieldPath).map((candidate) => candidate.exactText));
          return allManualCandidates(scope.fieldPath).filter((candidate) => texts.has(candidate.exactText));
        });
      const terminalCandidates = review.machinePublication.scopes
        .filter((scope) => scope.audience === "terminal_only")
        .flatMap((scope) => {
          const texts = new Set(machineCandidates(scope.fieldPath).map((candidate) => candidate.exactText));
          return allManualCandidates(scope.fieldPath).filter((candidate) => texts.has(candidate.exactText));
        });
      const pair = terminalCandidates.flatMap((terminalCandidate) => publicCandidates
        .filter((publicCandidate) => publicCandidate.binding.statementId === terminalCandidate.binding.statementId
          && sourceTextRangesOverlap(terminalCandidate.exactText, publicCandidate.exactText)
          && machineCandidates(publicCandidate.binding.fieldPath).length > 1
          && machineCandidates(terminalCandidate.binding.fieldPath).length > 1)
        .map((publicCandidate) => ({ terminalCandidate, publicCandidate })))[0];
      if (!pair) throw new Error("fixture lacks a machine-eligible public/terminal pair with alternatives");

      const targetFor = (candidate: { binding: { fieldPath: string }; exactText: string }) => {
        const selected = machineCandidates(candidate.binding.fieldPath).find((entry) => entry.exactText === candidate.exactText);
        if (!selected) throw new Error(`cross-batch target is not selectable: ${candidate.binding.fieldPath}`);
        return selected;
      };
      const terminalTarget = targetFor(pair.terminalCandidate);
      const publicTarget = targetFor(pair.publicCandidate);
      const slotFor = (fieldPath: string) => {
        for (let offset = 0; ; ) {
          const page = buildTrustedPresentationSelectionSlotPage(payload, offset);
          if (page.status === "refused") throw new Error(page.message);
          const slot = page.page.slots.find((entry) => entry.fieldPath === fieldPath);
          if (slot) return slot;
          if (!page.page.hasMore) break;
          offset += page.page.slots.length;
        }
        throw new Error(`cross-batch slot is missing: ${fieldPath}`);
      };
      const run = async (direction: "terminal_first" | "public_first", ignoreEligibility = false) => {
        const first = direction === "terminal_first" ? pair.terminalCandidate : pair.publicCandidate;
        const second = direction === "terminal_first" ? pair.publicCandidate : pair.terminalCandidate;
        const firstTarget = direction === "terminal_first" ? terminalTarget : publicTarget;
        const secondTarget = direction === "terminal_first" ? publicTarget : terminalTarget;
        const slots = [slotFor(first.binding.fieldPath), slotFor(second.binding.fieldPath)];
        const calls: Array<{ slots: Array<{ fieldPath: string; expectedAudience: string; candidates: Array<{ candidateDigest: string }>; opaqueCandidateDigest: string | null; eligibility?: { forbiddenCandidateDigests?: string[] } }> }> = [];
        const llm: LLMLike = {
          chat: async (messages) => {
            const request = JSON.parse(messages[1]?.content ?? "{}") as typeof calls[number];
            calls.push(request);
            return JSON.stringify({
              selections: request.slots.map((slot) => {
                const blocked = new Set(slot.eligibility?.forbiddenCandidateDigests ?? []);
                const target = slot.fieldPath === first.binding.fieldPath ? firstTarget
                  : slot.fieldPath === second.binding.fieldPath ? secondTarget : undefined;
                const candidate = target && (ignoreEligibility || !blocked.has(target.candidateDigest))
                  ? target
                  : slot.candidates.find((entry) => !blocked.has(entry.candidateDigest));
                if (candidate) return { fieldPath: slot.fieldPath, kind: "source_exact", candidateDigest: candidate.candidateDigest, audience: slot.expectedAudience };
                if (!slot.opaqueCandidateDigest) throw new Error(`cross-batch fixture lacks a safe choice: ${slot.fieldPath}`);
                return { fieldPath: slot.fieldPath, kind: "opaque_unavailable", candidateDigest: slot.opaqueCandidateDigest, audience: slot.expectedAudience };
              }),
            });
          },
        };
        const input: MachinePresentationSelectionInput = {
          identity: payload.identity,
          readSlotPage: (offset) => {
            const slot = slots[offset];
            if (!slot) return { status: "refused", code: "PRESENTATION_METADATA_INVALID", message: "cross-batch slot offset is unknown" } as const;
            return { status: "selection_slot_paged", page: { slots: [slot], hasMore: offset + 1 < slots.length }, fieldPathOrderHash: sha256(slots.map((entry) => entry.fieldPath).join("\n")) } as const;
          },
          readCandidatePage: (fieldPath, offset) => buildTrustedPresentationSelectionCandidatePage(payload, fieldPath, offset),
          signal: new AbortController().signal,
        };
        const result = await createServerMachinePresentationPublisher(llm).select(input);
        expect(calls).toHaveLength(2);
        expect(calls[0]?.slots[0]?.fieldPath).toBe(first.binding.fieldPath);
        expect(calls[1]?.slots[0]?.fieldPath).toBe(second.binding.fieldPath);
        expect(calls[0]?.slots[0]?.candidates.map((candidate) => candidate.candidateDigest)).toContain(firstTarget.candidateDigest);
        expect(calls[1]?.slots[0]?.candidates.map((candidate) => candidate.candidateDigest)).toContain(secondTarget.candidateDigest);
        expect(calls[1]?.slots[0]?.eligibility?.forbiddenCandidateDigests).toContain(secondTarget.candidateDigest);
        expect(result.selections).not.toContainEqual(expect.objectContaining({ fieldPath: second.binding.fieldPath, candidateDigest: secondTarget.candidateDigest }));
      };

      await run("terminal_first");
      await run("public_first");
      // The model cannot turn a digest-only host constraint into a choice by
      // simply returning the blocked canonical digest.
      await expect(run("terminal_first", true)).rejects.toMatchObject({ code: "selector_response_invalid" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("refuses a default selector's stricter private classification for a public scene field", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-default-machine-scope-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const llm = new AutoFakeLLM((messages) => automaticMachinePublisherReply(messages, (slot) => /^scenes\.[^.]+\.description$/.test(slot.fieldPath) ? "private_context" : slot.expectedAudience));
      const response = await handleRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), catalog, undefined, {}, {}, {
        llm,
        isLlmEnabled: () => true,
        admission: new CompilerAutoAdmissionController({ ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG, root: catalog.root }),
        machinePublicationEnabled: true,
      }, operatorAuthenticator);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "AUTO_PUBLICATION_SCOPE_INVALID" } });
      expect(existsSync(join(root, "presentation-reviews"))).toBe(false);
      expect(existsSync(join(root, "bundles"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when the default selector omits every untrusted audience classification", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-default-machine-missing-audience-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const llm = new AutoFakeLLM((messages) => {
        const content = messages[1]?.content ?? "";
        if (!content.startsWith('{"schemaVersion":"server-machine-presentation-selector-v1"')) return fullAutoReply(messages);
        const request = JSON.parse(content) as { slots: Array<{ fieldPath: string; candidates: Array<{ candidateDigest: string }>; opaqueCandidateDigest: string | null }> };
        return JSON.stringify({
          selections: request.slots.map((slot) => ({
            fieldPath: slot.fieldPath,
            kind: slot.candidates.length ? "source_exact" : "opaque_unavailable",
            candidateDigest: slot.candidates[0]?.candidateDigest ?? slot.opaqueCandidateDigest,
          })),
        });
      });
      const response = await handleRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), catalog, undefined, {}, {}, {
        llm,
        isLlmEnabled: () => true,
        admission: new CompilerAutoAdmissionController({ ...DEFAULT_COMPILER_AUTO_ADMISSION_CONFIG, root: catalog.root }),
        machinePublicationEnabled: true,
      }, operatorAuthenticator);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "AUTO_PUBLICATION_SELECTOR_UNAVAILABLE" } });
      expect(existsSync(join(root, "presentation-reviews"))).toBe(false);
      expect(existsSync(join(root, "bundles"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps partial, malformed, and throwing model work draft-only without bundle publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-draft-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      for (const reply of ["{\"proposals\":[]}", "not json", new Error("model endpoint contains a secret")] as const) {
        const catalog = new CompilerArtifactCatalog({ root: join(root, crypto.randomUUID()) });
        const saved = catalog.savePrepared(fixture.prepared.artifact);
        if (saved.status !== "ok") throw new Error(saved.message);
        let bundleWrites = 0;
        const saveBundle = catalog.saveBundle.bind(catalog);
        (catalog as any).saveBundle = (artifact: unknown, projection: unknown) => { bundleWrites++; return saveBundle(artifact, projection); };
        const llm = new AutoFakeLLM(reply);
        const response = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
        }), autoDependencies(llm, catalog));
        expect(response?.status).toBe(200);
        const body = await response?.json() as { status: string; unansweredQuestionIds: string[]; diagnostics: Array<{ code: string; message?: string }> };
        expect(body.status).toBe("draft_only");
        expect(body.unansweredQuestionIds.length).toBeGreaterThan(0);
        expect(body).not.toHaveProperty("continuationId");
        if (reply instanceof Error) expect(body.diagnostics.some((diagnostic) => diagnostic.message?.includes("secret"))).toBe(false);
        expect(body.diagnostics.every((diagnostic) => diagnostic.message === undefined)).toBe(true);
        expect(llm.calls.length).toBeGreaterThan(0);
        expect(bundleWrites).toBe(0);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("resumes catalog-bound partial automatic mechanics without re-asking accepted questions or leaking private hints", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-resume-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      const first = new AutoFakeLLM((messages, call) => call === 0 ? fullAutoReply(messages) : JSON.stringify({ proposals: [] }));
      const partialDependencies = {
        ...autoDependencies(first, catalog),
        autoCompiler: { ...autoDependencies(first, catalog).autoCompiler!, maxProposalRounds: 1 },
      };
      const request = (body: Record<string, unknown>) => new Request("http://test/api/compiler/auto-resolve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const initial = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
      }), partialDependencies);
      expect(initial?.status).toBe(200);
      const initialText = await initial?.text() ?? "";
      const initialBody = JSON.parse(initialText) as { status: string; continuationId: string; progress: boolean; resumed: boolean; rounds: Array<{ acceptedQuestionIds: string[] }> };
      const initialContinuationId = initialBody.continuationId;
      expect(initialBody).toMatchObject({ status: "draft_only", progress: true, resumed: false, continuationId: expect.stringMatching(/^[a-z2-7]{24}$/) });
      const accepted = initialBody.rounds.flatMap((round) => round.acceptedQuestionIds);
      expect(accepted.length).toBeGreaterThan(0);
      const privateQuote = autoEnvelope(first.calls[0]!.messages).questions[0]!.sourceStatements[0]!.text;
      expect(initialText).not.toContain("sourceStatements");
      expect(initialText).not.toContain("hints");
      expect(initialText).not.toContain("quote");
      expect(initialText).not.toContain("proposals");
      expect(initialText).not.toContain(privateQuote);

      const beforeNoProgress = readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"));
      const noProgressLlm = new AutoFakeLLM(new Error("resume model failure must remain private"));
      const noProgress = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: initialContinuationId,
      }), autoDependencies(noProgressLlm, catalog));
      expect(noProgress?.status).toBe(200);
      expect(await noProgress?.json()).toMatchObject({ status: "draft_only", continuationId: initialContinuationId, resumed: true, progress: false });
      expect(readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"))).toEqual(beforeNoProgress);

      const refusalLlm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const entriesBeforeRefusals = readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"));
      const stale = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: "stale",
        autoContinuationId: initialContinuationId,
      }), autoDependencies(refusalLlm, catalog));
      expect(stale?.status).toBe(409);
      expect(await stale?.json()).toMatchObject({ error: { code: "RESOLVE_QUEUE_HASH_MISMATCH" } });
      const foreignPrepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "foreign-auto-resume", sourceDescriptor: "foreign-auto-resume", pages: PAGES });
      if (foreignPrepared.status === "refused") throw new Error(foreignPrepared.message);
      const foreignSaved = catalog.savePrepared(foreignPrepared.artifact);
      if (foreignSaved.status !== "ok") throw new Error(foreignSaved.message);
      const foreign = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: foreignSaved.value.id,
        preparedQueueHash: foreignPrepared.identity.preparedQueueHash,
        autoContinuationId: initialContinuationId,
      }), autoDependencies(refusalLlm, catalog));
      expect(foreign?.status).toBe(409);
      expect(await foreign?.json()).toMatchObject({ error: { code: "AUTO_CONTINUATION_MISMATCH" } });
      expect(refusalLlm.calls).toEqual([]);
      expect(readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"))).toEqual(entriesBeforeRefusals);

      const second = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const resumed = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: initialContinuationId,
      }), autoDependencies(second, catalog));
      expect(resumed?.status).toBe(200);
      const resumedText = await resumed?.text() ?? "";
      const resumedBody = JSON.parse(resumedText) as { status: string; continuationId: string; resumed: boolean; progress: boolean };
      const finalContinuationId = resumedBody.continuationId;
      expect(resumedBody).toMatchObject({ status: "presentation_draft_only", resumed: true, progress: true, continuationId: expect.stringMatching(/^[a-z2-7]{24}$/) });
      expect(resumedText).not.toContain("sourceStatements");
      expect(resumedText).not.toContain("hints");
      expect(resumedText).not.toContain("quote");
      expect(resumedText).not.toContain("proposals");
      const resumedQuestionIds = second.calls.flatMap((call) => autoEnvelope(call.messages).questions.map((question) => question.questionId));
      expect(resumedQuestionIds.filter((questionId) => accepted.includes(questionId))).toEqual([]);

      const closedReplayLlm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const entriesBeforeClosedReplay = readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"));
      const closedReplay = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: finalContinuationId,
      }), autoDependencies(closedReplayLlm, catalog));
      expect(closedReplay?.status).toBe(200);
      expect(await closedReplay?.json()).toMatchObject({ status: "presentation_draft_only", continuationId: finalContinuationId, resumed: true, progress: false });
      expect(closedReplayLlm.calls).toEqual([]);
      expect(readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"))).toEqual(entriesBeforeClosedReplay);

      const finalContinuation = catalog.loadAutoResolveContinuation(finalContinuationId);
      if (finalContinuation.status !== "ok") throw new Error(finalContinuation.message);
      const finalResolved = resolveCompiler(fixture.prepared.artifact, fixture.prepared.identity.preparedQueueHash, finalContinuation.value.hints);
      if (finalResolved.status === "refused") throw new Error(finalResolved.message);
      const minted = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/presentation-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: saved.value.id,
          preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
          autoContinuationId: finalContinuationId,
          bindings: exactReviewBindings(finalResolved.artifact.payload as any),
        }),
      }), dependencies(undefined, catalog));
      expect(minted?.status).toBe(201);
      const mintedBody = await minted?.json() as { presentationReviewId: string };
      const manual = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preparedArtifactId: saved.value.id,
          preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
          autoContinuationId: finalContinuationId,
          presentationReviewId: mintedBody.presentationReviewId,
        }),
      }), dependencies(undefined, catalog));
      expect(manual?.status).toBe(200);

      const retry = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: initialContinuationId,
      }), autoDependencies(new AutoFakeLLM((messages) => fullAutoReply(messages)), catalog));
      expect(retry?.status).toBe(200);
      expect(await retry?.json()).toMatchObject({ status: "presentation_draft_only", resumed: true });

      const tamperedPath = join(root, "continuations", `${initialContinuationId}.json`);
      const entriesBeforeCorruption = readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"));
      const wrongStage = JSON.parse(readFileSync(tamperedPath, "utf8"));
      wrongStage.stage = "prepared";
      writeFileSync(tamperedPath, JSON.stringify(wrongStage));
      const corruptLlm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const wrongStageResponse = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: initialContinuationId,
      }), autoDependencies(corruptLlm, catalog));
      expect(wrongStageResponse?.status).toBe(409);
      expect(await wrongStageResponse?.json()).toMatchObject({ error: { code: "CATALOG_INCOMPATIBLE" } });
      wrongStage.stage = "continuation";
      wrongStage.hints.moduleId = "queue-invalid-continuation";
      wrongStage.continuationHash = continuationHash(wrongStage);
      writeFileSync(tamperedPath, JSON.stringify(wrongStage));
      const semanticCorrupt = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: initialContinuationId,
      }), autoDependencies(corruptLlm, catalog));
      expect(semanticCorrupt?.status).toBe(409);
      expect(await semanticCorrupt?.json()).toMatchObject({ error: { code: "CATALOG_CORRUPT" } });
      wrongStage.continuationHash = "0".repeat(64);
      writeFileSync(tamperedPath, JSON.stringify(wrongStage));
      const corrupt = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: initialContinuationId,
      }), autoDependencies(corruptLlm, catalog));
      expect(corrupt?.status).toBe(409);
      expect(await corrupt?.json()).toMatchObject({ error: { code: "CATALOG_CORRUPT" } });
      expect(corruptLlm.calls).toEqual([]);
      expect(readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"))).toEqual(entriesBeforeCorruption);

      const conflictLlm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const entriesBeforeConflict = readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"));
      const conflict = await handleCompiledModuleHttpRequest(request({
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: initialContinuationId,
        explicitHints: hints(fixture.prepared),
      }), autoDependencies(conflictLlm, catalog));
      expect(conflict?.status).toBe(400);
      expect(conflictLlm.calls).toEqual([]);
      expect(readdirSync(join(root, "continuations")).filter((name) => name.endsWith(".json"))).toEqual(entriesBeforeConflict);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects disabled, stale, and client-trust-shaped automatic requests before any model call or bundle write", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-refusal-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      let bundleWrites = 0;
      const saveBundle = catalog.saveBundle.bind(catalog);
      (catalog as any).saveBundle = (artifact: unknown, projection: unknown) => { bundleWrites++; return saveBundle(artifact, projection); };
      const llm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const request = (body: unknown) => new Request("http://test/api/compiler/auto-resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      const disabled = await handleRequest(request({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }), catalog, undefined, {}, {}, { llm, isLlmEnabled: () => false }, operatorAuthenticator);
      expect(disabled.status).toBe(503);
      const stale = await handleCompiledModuleHttpRequest(request({ preparedArtifactId: saved.value.id, preparedQueueHash: "stale" }), autoDependencies(llm, catalog));
      expect(stale?.status).toBe(409);
      const forgedTrust = await handleCompiledModuleHttpRequest(request({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash, policy: { rightsStatus: "project_original" } }), autoDependencies(llm, catalog));
      expect(forgedTrust?.status).toBe(400);
      const detached = await handleCompiledModuleHttpRequest(request({ preparedArtifactId: saved.value.id, preparedArtifact: fixture.prepared.artifact, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }), autoDependencies(llm, catalog));
      expect(detached?.status).toBe(400);
      const explicitHintSentinel = "EXPLICIT_HINT_SENTINEL_MUST_NOT_ECHO";
      const badHints = await handleCompiledModuleHttpRequest(request({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash, explicitHints: { diagnostic: explicitHintSentinel } }), autoDependencies(llm, catalog));
      expect(badHints?.status).toBe(200);
      const badHintsText = await badHints?.text() ?? "";
      const badHintsBody = JSON.parse(badHintsText) as { status: string; progress?: unknown; continuationId?: unknown };
      expect(badHintsBody).toMatchObject({ status: "draft_only", progress: false });
      expect(badHintsBody.continuationId).toBeUndefined();
      expect(badHintsText).not.toContain(explicitHintSentinel);
      expect(existsSync(join(root, "continuations"))).toBe(false);
      writeFileSync(join(root, "prepared", `${saved.value.id}.json`), "{corrupt");
      const corrupt = await handleCompiledModuleHttpRequest(request({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }), autoDependencies(llm, catalog));
      expect(corrupt?.status).toBe(409);
      expect((await corrupt?.json() as { error: { code: string } }).error.code).toBe("CATALOG_CORRUPT");
      expect(llm.calls).toEqual([]);
      expect(bundleWrites).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("hands automatic hints to the existing manual presentation route through a retry-safe opaque continuation", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiler-auto-http-projection-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root });
      const saved = catalog.savePrepared(fixture.prepared.artifact);
      if (saved.status !== "ok") throw new Error(saved.message);
      let bundleWrites = 0;
      const saveBundle = catalog.saveBundle.bind(catalog);
      (catalog as any).saveBundle = (artifact: unknown, projection: unknown) => { bundleWrites++; return saveBundle(artifact, projection); };
      const llm = new AutoFakeLLM((messages) => fullAutoReply(messages));
      const local = await orchestratePreparedAutoCompiler({
        prepared: fixture.prepared,
        llm: new AutoFakeLLM((messages) => fullAutoReply(messages)),
        policy: { policyId: "server-auto-test-v1", rightsStatus: "user_provided" },
        producer: { providerFingerprint: "server:auto-test", modelFingerprint: "model:auto-test" },
        proposalLimits: { maxQuestionsPerRequest: 3, maxRequestsPerRound: 8, maxRequestChars: 24_000, maxResponseTokens: 2_400 },
        maxProposalRounds: 2,
      });
      if (local.status !== "resolved") throw new Error(JSON.stringify(local.diagnostics));
      const review = catalog.saveTrustedPresentationReview(saved.value.id, fixture.prepared.artifact, local.resolved.artifact, "operator:auto-continuation", exactReviewBindings(local.resolved.artifact.payload as any));
      if (review.status !== "ok") throw new Error(review.message);
      const automatic = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/auto-resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: saved.value.id, preparedQueueHash: fixture.prepared.identity.preparedQueueHash }),
      }), autoDependencies(llm, catalog));
      expect(automatic?.status).toBe(200);
      const automaticBody = await automatic?.json() as { status: string; continuationId: string };
      expect(automaticBody.status).toBe("presentation_draft_only");
      expect(automaticBody.continuationId).toMatch(/^[a-z2-7]{24}$/);
      expect(llm.calls.length).toBeGreaterThan(0);
      expect(bundleWrites).toBe(0);
      const manualPayload = {
        preparedArtifactId: saved.value.id,
        preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
        autoContinuationId: automaticBody.continuationId,
        presentationReviewId: review.value.id,
      };
      const manual = await handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manualPayload),
      }), dependencies(undefined, catalog));
      expect(manual?.status).toBe(200);
      expect(await manual?.json()).toMatchObject({ status: "resolved", bundleId: expect.stringMatching(/^[a-z2-7]{24}$/) });
      expect(catalog.loadAutoResolveContinuation(automaticBody.continuationId)).toMatchObject({ status: "ok" });
      expect(bundleWrites).toBe(1);

      const resolveWith = (body: Record<string, unknown>) => handleCompiledModuleHttpRequest(new Request("http://test/api/compiler/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }), dependencies(undefined, catalog));
      const stale = await resolveWith({ ...manualPayload, preparedQueueHash: "stale" });
      expect(stale?.status).toBe(409);
      expect(await stale?.json()).toMatchObject({ error: { code: "AUTO_CONTINUATION_MISMATCH" } });
      const foreignPrepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "foreign-continuation", sourceDescriptor: "foreign-continuation", pages: PAGES });
      if (foreignPrepared.status === "refused") throw new Error(foreignPrepared.message);
      const foreignSaved = catalog.savePrepared(foreignPrepared.artifact);
      if (foreignSaved.status !== "ok") throw new Error(foreignSaved.message);
      const foreign = await resolveWith({ ...manualPayload, preparedArtifactId: foreignSaved.value.id, preparedQueueHash: foreignPrepared.identity.preparedQueueHash });
      expect(foreign?.status).toBe(409);
      expect(await foreign?.json()).toMatchObject({ error: { code: "AUTO_CONTINUATION_MISMATCH" } });
      const bothHintsAndToken = await resolveWith({ ...manualPayload, hints: hints(fixture.prepared) });
      expect(bothHintsAndToken?.status).toBe(400);
      const continuationPath = join(root, "continuations", `${automaticBody.continuationId}.json`);
      const tamperedContinuation = JSON.parse(readFileSync(continuationPath, "utf8"));
      tamperedContinuation.continuationHash = "0".repeat(64);
      writeFileSync(continuationPath, JSON.stringify(tamperedContinuation));
      const corrupt = await resolveWith(manualPayload);
      expect(corrupt?.status).toBe(409);
      expect(await corrupt?.json()).toMatchObject({ error: { code: "CATALOG_CORRUPT" } });
      expect(bundleWrites).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("advertises the bounded catalog-only automatic route from the server health endpoint", async () => {
    const response = await handleRequest(new Request("http://test/api"));
    expect(response.status).toBe(200);
    const endpoints = (await response.json() as { endpoints: string[] }).endpoints;
    const route = endpoints.find((endpoint) => endpoint.startsWith("POST /api/compiler/auto-resolve"));
    expect(route).toContain("mechanics");
    expect(route).toContain("presentation");
    expect(endpoints.find((endpoint) => endpoint.startsWith("POST /api/compiler/presentation-workbench"))).toContain("operator");
  });
});
