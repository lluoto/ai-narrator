import { prepareCompiler, resolveCompiler, type PreparedCompilerApiResult } from "../../compiler/compiler-api";
import { projectResolvedCompilerArtifact, projectTrustedResolvedCompilerArtifact, type ModuleDataPresentationMetadata } from "../../compiler/compiler-module-data-projection";
import { MODULE_COMPILE_HINTS_SCHEMA_VERSION, type CompilerQuestion, type CompilerQuestionResolution, type ModuleCompileHints } from "../../compiler/compiler-question-queue";
import { CompilerArtifactCatalog, type BundleCatalogMetadata } from "../../compiler/compiler-artifact-catalog";
import { exactReviewBindings } from "./trusted-presentation-review";

export const PAGES = ["入口：\n▶父线索：一把档案室钥匙。\n档案室：\n▶子线索：一份必须读懂的档案。\n出口：\n▶出口说明：离开这里的旧车票。"];

function answer(question: CompilerQuestion, value: unknown): CompilerQuestionResolution {
  return { questionId: question.id, kind: question.kind, value, sourceStatementIds: [...question.sourceStatementIds], evidenceRefs: [...question.evidenceRefs], authority: "user_document", derivation: "explicit", reviewerKind: "human", rightsStatus: "user_provided", reason: "HTTP lifecycle fixture" };
}

export function hints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
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

export function firstPathHints(prepared: PreparedCompilerApiResult): ModuleCompileHints {
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

async function buildCompiledModuleHttpFixture(moduleId: string, pages: readonly string[] = PAGES) {
  const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId, sourceDescriptor: moduleId, pages: [...pages] });
  if (prepared.status === "refused") throw new Error(prepared.message);
  const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, hints(prepared));
  if (resolved.status === "refused") throw new Error(resolved.message);
  const payload: any = resolved.artifact.payload;
  const facetRevelations = new Map<string, string>();
  for (const binding of payload.clueFactFacetBindings) {
    if (binding.shellAtoms.length || binding.findings.length) facetRevelations.set(binding.clueId, binding.shellAtoms.map((atom: any) => atom.quote).join("\n") || payload.draft.clueCandidates.find((candidate: any) => candidate.id === binding.clueId).displayName);
    for (const finding of binding.findings) facetRevelations.set(finding.clueId, finding.atoms.map((atom: any) => atom.quote).join("\n"));
  }
  const metadata: ModuleDataPresentationMetadata = {
    module: { title: "HTTP fixture", version: "1", ruleset: "cosmic-horror", era: "test", summary: "caller supplied", playerCount: "1", expectedDuration: "short", triggerWarnings: [] },
    scenes: Object.fromEntries(payload.mechanicsIR.symbols.sceneIds.map((id: string) => [id, { description: `scene:${id}` }])),
    connections: Object.fromEntries(payload.analysisInput.connections.map((connection: any) => [connection.id, { condition: `connection:${connection.id}` }])),
    clues: Object.fromEntries(payload.mechanicsIR.symbols.clueIds.map((id: string) => [id, { findMethods: [], revelation: facetRevelations.get(id) ?? `revelation:${id}`, unlocks: [], importance: "core" }])),
    endings: Object.fromEntries(payload.mechanicsIR.endings.map((ending: any) => [ending.effects.find((effect: any) => effect.kind === "end_game").endingId, { name: `ending:${ending.id}`, description: `ending:${ending.id}`, conditions: ["declared"] }])),
  };
  const projection = projectResolvedCompilerArtifact(payload, metadata);
  if (projection.status === "refused") throw new Error(projection.message);
  return { prepared, resolved, projection };
}

/**
 * The HTTP suites exercise storage, delivery and admission independently;
 * recompiling the identical synthetic document for every one of those cases
 * only adds allocation pressure to a serial run.  Keep one deterministic
 * source result per module id, but never share it with a caller: several
 * suites intentionally mutate values to model corrupt input, and a fixture
 * cache must not turn that into cross-test state.
 */
const compiledModuleHttpFixtureCache = new Map<string, Promise<Awaited<ReturnType<typeof buildCompiledModuleHttpFixture>>>>();

export async function compiledModuleHttpFixture(moduleId = "http-fixture", pages: readonly string[] = PAGES) {
  // Fixture source controls the trusted-review candidate universe; key the
  // cache by it so one document's reviewed projection cannot bleed into
  // another document sharing a mechanics fixture name.
  const cacheKey = `${moduleId}\u0000${JSON.stringify(pages)}`;
  let cached = compiledModuleHttpFixtureCache.get(cacheKey);
  if (!cached) {
    cached = buildCompiledModuleHttpFixture(moduleId, pages);
    compiledModuleHttpFixtureCache.set(cacheKey, cached);
  }
  try {
    return structuredClone(await cached);
  } catch (error) {
    // Do not turn a transient compiler failure into a process-lifetime cached
    // rejection.  A concurrent caller still owns the same pending promise.
    if (compiledModuleHttpFixtureCache.get(cacheKey) === cached) {
      compiledModuleHttpFixtureCache.delete(cacheKey);
    }
    throw error;
  }
}

/**
 * Test-only convenience for a public create fixture: it follows the same
 * durable review record -> trusted projection -> bundle shape required by the
 * production bundle-ID ingress, rather than preserving raw projection input.
 */
export function saveTrustedFixtureBundle(
  catalog: CompilerArtifactCatalog,
  fixture: Awaited<ReturnType<typeof compiledModuleHttpFixture>>,
  reviewerPrincipalId = "operator:fixture",
): BundleCatalogMetadata {
  const prepared = catalog.savePrepared(fixture.prepared.artifact);
  if (prepared.status !== "ok") throw new Error(prepared.message);
  const review = catalog.saveTrustedPresentationReview(
    prepared.value.id,
    fixture.prepared.artifact,
    fixture.resolved.artifact,
    reviewerPrincipalId,
    exactReviewBindings(fixture.resolved.artifact.payload as any),
  );
  if (review.status !== "ok") throw new Error(review.message);
  const persistedReview = catalog.loadTrustedPresentationReview(review.value.id);
  if (persistedReview.status !== "ok") throw new Error(persistedReview.message);
  const projection = projectTrustedResolvedCompilerArtifact(
    fixture.resolved.artifact.payload as any,
    persistedReview.value.review,
  );
  if (projection.status !== "projected") throw new Error(projection.message);
  const bundle = catalog.saveBundle(fixture.resolved.artifact, projection);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  return bundle.value;
}
