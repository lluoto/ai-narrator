import { describe, expect, it } from "bun:test";
import { serializeCompilerArtifact, type ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../compiler/compiler-api";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../compiler/compiler-question-queue";
import { minimalPdfBytes } from "./helpers/minimal-pdf";

const PAGES = ["入口：\n普通叙述不能凭空绑定线索。\n▶父线索：一把刻有档案室标记的钥匙。\n档案室：\n▶子线索：一份需要检定才能读懂的档案。\n出口：\n▶出口说明：离开这里的旧车票。"];

function resolution(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
  return { questionId: question.id, kind: question.kind, value, sourceStatementIds: [...question.sourceStatementIds], evidenceRefs: [...question.evidenceRefs], authority: "user_document", derivation: "explicit", reviewerKind: "human", rightsStatus: "user_provided", reason: "explicit API fixture declaration bound to this prepared queue evidence" };
}

function hints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
  const { draft, preparedQueue: queue } = prepared.artifact.payload;
  const scene = (name: string) => draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(name))!;
  const clue = (name: string) => draft.clueCandidates.find((candidate) => candidate.displayName === name)!;
  const entry = scene("入口");
  const archive = scene("档案室");
  const exit = scene("出口");
  const parent = clue("父线索");
  const child = clue("子线索");
  const topology = (sceneId: string) => queue.questions.find((question) => question.kind === "connection_topology" && question.subjectCandidateId === sceneId)!;
  const core = (clueId: string) => queue.questions.find((question) => question.kind === "core_clue" && question.subjectCandidateId === clueId)!;
  const discovery = (clueId: string) => queue.questions.find((question) => question.kind === "discovery_method" && question.subjectCandidateId === clueId)!;
  const entryQuestion = queue.questions.find((question) => question.kind === "entry_scene")!;
  const endingQuestion = queue.questions.find((question) => question.kind === "ending_rule")!;
  return {
    schemaVersion: MODULE_COMPILE_HINTS_SCHEMA_VERSION, moduleId: queue.moduleId, documentHash: queue.documentHash, sourceGraphIdentity: queue.sourceGraphIdentity,
    resolutions: [
      ...queue.questions.filter((question) => question.kind === "clue_fact_facets").map((question) => resolution(question, {
        shell: (question.allowedClueFactAtoms ?? []).map((atom) => ({ atomId: atom.id, quote: atom.quote })), findings: [], sourceOnlyAtomIds: [],
      })),
      ...queue.questions.filter((question) => question.kind === "scene_role").map((question) => resolution(question, { role: "playable_scene" })),
      resolution(entryQuestion, { sceneCandidateId: entry.id }),
      resolution(topology(entry.id), { connections: [{ toSceneCandidateId: archive.id, connectionId: "connection_entry_archive" }, { toSceneCandidateId: exit.id, connectionId: "connection_entry_exit" }] }),
      resolution(topology(archive.id), { connections: [{ toSceneCandidateId: entry.id, connectionId: "connection_archive_entry" }, { toSceneCandidateId: exit.id, connectionId: "connection_archive_exit", availability: { kind: "connection_unlocked", connectionId: "connection_archive_exit" } }] }),
      resolution(topology(exit.id), { connections: [] }),
      resolution(core(parent.id), { clueCandidateId: parent.id, required: false }),
      resolution(core(child.id), { clueCandidateId: child.id, required: true }),
      resolution(discovery(parent.id), { clueCandidateId: parent.id, locationSceneCandidateId: entry.id, spec: { kind: "discovery_method", id: "discover_parent_explicit", clueId: parent.id, action: "search", target: "scene", targetId: entry.id, onSuccess: [{ kind: "discover_clue", clueId: parent.id }] } }),
      resolution(discovery(child.id), { clueCandidateId: child.id, locationSceneCandidateId: archive.id, spec: { kind: "discovery_method", id: "discover_child_checked", clueId: child.id, action: "read", target: "scene", targetId: archive.id, availability: { kind: "clue_found", clueId: parent.id }, check: { kind: "skill", skill: "library_use", difficulty: "hard" }, onSuccess: [{ kind: "discover_clue", clueId: child.id }, { kind: "unlock_connection", connectionId: "connection_archive_exit" }], failback: { maxFailures: 2, effects: [{ kind: "discover_clue", clueId: child.id }, { kind: "unlock_connection", connectionId: "connection_archive_exit" }] } } }),
      resolution(endingQuestion, { declarations: [
        { endingId: "ending_clean_escape", spec: { kind: "ending_rule", id: "rule_clean_escape", priority: 10, when: { kind: "all", predicates: [{ kind: "clue_found", clueId: child.id }, { kind: "scene_visited", sceneId: exit.id }] }, effects: [{ kind: "end_game", endingId: "ending_clean_escape" }] } },
        { endingId: "ending_hasty_exit", spec: { kind: "ending_rule", id: "rule_hasty_exit", priority: 20, when: { kind: "all", predicates: [{ kind: "scene_visited", sceneId: exit.id }, { kind: "not", predicate: { kind: "clue_found", clueId: child.id } }] }, effects: [{ kind: "end_game", endingId: "ending_hasty_exit" }] } },
      ] }),
    ],
  };
}

async function prepared(): Promise<PreparedCompilerApiResult> {
  const result = await prepareCompiler({ kind: "synthetic_pages", moduleId: "compiler-api-fixture", sourceDescriptor: "compiler-api-fixture", pages: PAGES });
  if (result.status === "refused") throw new Error(result.message);
  return result;
}

describe("public compiler API", () => {
  it("prepares synthetic pages into explicit questions and a durable synthetic artifact", async () => {
    const result = await prepared();
    expect(result.identity.documentHash).toBeNull();
    expect(result.artifact.payload.graph.documentIdentity.hashSource).toBe("synthetic_fixture");
    expect(result.questions).toEqual(result.artifact.payload.preparedQueue.questions);
    expect(result.questions.some((question) => question.kind === "entry_scene")).toBe(true);
  });

  it("is byte-for-byte deterministic across repeated prepare and resolve calls", async () => {
    const first = await prepared();
    const second = await prepared();
    expect(serializeCompilerArtifact(first.artifact)).toBe(serializeCompilerArtifact(second.artifact));
    const firstResolved = resolveCompiler(first.artifact, first.identity.preparedQueueHash, hints(first));
    const secondResolved = resolveCompiler(second.artifact, second.identity.preparedQueueHash, hints(second));
    if (firstResolved.status === "refused" || secondResolved.status === "refused") throw new Error("expected resolved compiler artifact");
    expect(serializeCompilerArtifact(firstResolved.artifact)).toBe(serializeCompilerArtifact(secondResolved.artifact));
  });

  it("restores a prepared JSON artifact before resolving mechanically closed output", async () => {
    const value = await prepared();
    const roundTripped = JSON.parse(JSON.stringify(value.artifact));
    const result = resolveCompiler(roundTripped, value.identity.preparedQueueHash, hints(value));
    if (result.status === "refused") throw new Error(result.message);
    expect(result.artifact.stage).toBe("resolved");
    expect(result.identity.mechanicsHash).toBe((result.artifact.payload as ResolvedCompilerArtifactPayload).identity.mechanicsHash);
  });

  it("rejects stale queue, module, document, graph, and incomplete hints without publishing", async () => {
    const value = await prepared();
    const valid = hints(value);
    expect(resolveCompiler(value.artifact, "stale", valid)).toMatchObject({ status: "refused", code: "RESOLVE_QUEUE_HASH_MISMATCH" });
    expect(resolveCompiler(value.artifact, value.identity.preparedQueueHash, { ...valid, moduleId: "foreign" })).toMatchObject({ status: "refused", code: "RESOLVE_MODULE_IDENTITY_MISMATCH" });
    expect(resolveCompiler(value.artifact, value.identity.preparedQueueHash, { ...valid, documentHash: "foreign" })).toMatchObject({ status: "refused", code: "RESOLVE_DOCUMENT_IDENTITY_MISMATCH" });
    expect(resolveCompiler(value.artifact, value.identity.preparedQueueHash, { ...valid, sourceGraphIdentity: "foreign" })).toMatchObject({ status: "refused", code: "RESOLVE_GRAPH_IDENTITY_MISMATCH" });
    expect(resolveCompiler(value.artifact, value.identity.preparedQueueHash, { ...valid, resolutions: [] })).toMatchObject({ status: "refused", code: "RESOLVE_NOT_PUBLISHABLE" });
  });

  it("parses deterministic actual PDF bytes and retains a byte-based non-null identity", async () => {
    const result = await prepareCompiler({ kind: "pdf_bytes", moduleId: "compiler-api-pdf", pdfBytes: minimalPdfBytes("Entry:") });
    if (result.status === "refused") throw new Error(result.message);
    expect(result.identity.documentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.artifact.payload.graph.documentIdentity.hashSource).toBe("pdf_bytes_sha256");
    expect(result.artifact.payload.graph.documentIdentity.pages[0]!.rawText).toContain("Entry:");
  });

  it("refuses a valid PDF whose text layer has no usable normalized text", async () => {
    const result = await prepareCompiler({ kind: "pdf_bytes", moduleId: "compiler-api-textless-pdf", pdfBytes: minimalPdfBytes("") });
    expect(result).toMatchObject({ status: "refused", stage: "prepare", code: "PDF_TEXT_UNAVAILABLE" });
  });

  it("refuses empty and malformed PDF bytes without treating them as synthetic input", async () => {
    expect(await prepareCompiler({ kind: "pdf_bytes", moduleId: "bad-pdf", pdfBytes: new Uint8Array() })).toMatchObject({ status: "refused", code: "PREPARE_PDF_INVALID" });
    expect(await prepareCompiler({ kind: "pdf_bytes", moduleId: "bad-pdf", pdfBytes: new TextEncoder().encode("not a PDF") })).toMatchObject({ status: "refused", code: "PREPARE_PDF_INVALID" });
  });
});
