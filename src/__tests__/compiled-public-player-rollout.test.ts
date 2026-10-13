import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CompiledPlayerDelivery } from "../api/player-delivery";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { GameSession } from "../api/game-session";
import { prepareCompiler, resolveCompiler } from "../compiler/compiler-api";
import { buildTrustedPresentationSelectionSlotPage, buildTrustedPresentationSelectionCandidatePage, rehydrateTrustedPresentationSelections,
  trustedPresentationMachineDecisionIdentity, trustedPresentationMachineCoverageIdentity, projectTrustedResolvedCompilerArtifact,
  type TrustedPresentationMachinePublication } from "../compiler/compiler-module-data-projection";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import type { LLMLike, Message } from "../llm/client";
import { createNpcContactSessionFixture, npcContactHints, npcContactMachinePublisher, NPC_CONTACT_MULTI_DIALOGUES, NPC_CONTACT_MULTI_PAGES } from "./helpers/compiled-npc-contact-fixture";
import { projectCompiledPublicPlayerObservation, runCompiledPublicPlayerRollout, type PublicPlayerPersona, type PublicPlayerRoute } from "../../scripts/diag/compiled-public-player-rollout";

const owner: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "keeper:public-player" } });
const player: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "player", id: "player:facade-p1" } });
const createFixture = createNpcContactSessionFixture(owner);
const reporter: PublicPlayerPersona = { name: "Ada", occupation: "记者", personality: "谨慎好奇", backstory: "只依据公开证据采访。", currentGoal: "先向在场的人询问信息。" };
const explorer: PublicPlayerPersona = { ...reporter, name: "Bo", occupation: "探险家", personality: "主动探索", currentGoal: "离开当前地方看看附近区域。" };
const PRIVATE = "UNKNOWN_PRIVATE_SENTINEL_791";
type Body = Record<string, any>;

/** Real source/queue/machine-review fixture with both exit ambiguity and a
 * legal Search/Talk; no forged IR or session state is installed. */
async function branchFixture(root: string, entryAtArchive = false) {
  const prepared = await prepareCompiler({ kind: "synthetic_pages", moduleId: "public-branch", sourceDescriptor: "public-branch", pages: [
    "Dock:\nCaptain Mira waits beside the launch and says the archive lies east and the exit lies west.\nArchive:\n\u25B6Dream Stone: The dream stone opens the exit.\nExit:",
  ] });
  if (prepared.status === "refused") throw new Error(prepared.message);
  const hints = npcContactHints(prepared, [{ mechanismId: "ask_mira_about_east", relationshipQuote: "the archive lies east" }]);
  const scene = (name: string) => prepared.artifact.payload.draft.sceneCandidates.find((candidate) => candidate.displayName.startsWith(name))!;
  const dock = scene("Dock"), archive = scene("Archive"), exit = scene("Exit");
  const withBranches = { ...hints, resolutions: hints.resolutions.map((resolution) => {
    const question = prepared.artifact.payload.preparedQueue.questions.find((candidate) => candidate.id === resolution.questionId)!;
    if (entryAtArchive && question.kind === "entry_scene") return { ...resolution, value: { sceneCandidateId: archive.id } };
    if (question.kind !== "connection_topology") return resolution;
    if (question.subjectCandidateId === dock.id) return { ...resolution, value: { connections: [{ toSceneCandidateId: archive.id, connectionId: "dock_archive" }, { toSceneCandidateId: exit.id, connectionId: "dock_exit" }] } };
    if (question.subjectCandidateId === archive.id) return { ...resolution, value: { connections: [{ toSceneCandidateId: exit.id, connectionId: "archive_exit" }, { toSceneCandidateId: dock.id, connectionId: "archive_dock" }] } };
    return resolution;
  }) };
  const resolved = resolveCompiler(prepared.artifact, prepared.identity.preparedQueueHash, withBranches);
  if (resolved.status === "refused") throw new Error(resolved.message);
  const payload = resolved.artifact.payload as ResolvedCompilerArtifactPayload;
  const publisher = npcContactMachinePublisher();
  const selected = await publisher.select({ identity: resolved.identity, signal: new AbortController().signal,
    readSlotPage: (offset) => buildTrustedPresentationSelectionSlotPage(payload, offset),
    readCandidatePage: (fieldPath, offset) => buildTrustedPresentationSelectionCandidatePage(payload, fieldPath, offset) });
  const rehydrated = rehydrateTrustedPresentationSelections(payload, selected.selections);
  if (rehydrated.status !== "rehydrated") throw new Error(rehydrated.message);
  const scopes = selected.scopes as TrustedPresentationMachinePublication["scopes"];
  const machinePublication = { servicePrincipalId: publisher.servicePrincipalId, policyId: publisher.policyId, requestHash: selected.requestHash,
    responseHash: selected.responseHash, scopes, decisionHash: trustedPresentationMachineDecisionIdentity(rehydrated.bindings, scopes), coverageHash: trustedPresentationMachineCoverageIdentity(scopes) };
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const saved = catalog.savePrepared(prepared.artifact); if (saved.status !== "ok") throw new Error(saved.message);
  const review = catalog.saveTrustedPresentationReview(saved.value.id, prepared.artifact, resolved.artifact, publisher.servicePrincipalId, rehydrated.bindings, { machinePublication });
  if (review.status !== "ok") throw new Error(review.message);
  const loaded = catalog.loadTrustedPresentationReview(review.value.id); if (loaded.status !== "ok") throw new Error(loaded.message);
  const projection = projectTrustedResolvedCompilerArtifact(payload, loaded.value.review); if (projection.status === "refused") throw new Error(projection.message);
  const bundle = catalog.saveBundle(resolved.artifact, projection); if (bundle.status !== "ok") throw new Error(bundle.message);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const registry = new Map<string, GameSession>(); const compiledDurableHostCapability = Object.freeze(Object.create(null)) as object;
  const created = await handleRequest(new Request("http://test/api/sessions/compiled", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundleId: bundle.value.id, archetype: "investigator", characterName: "Ada" }) }), catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, owner, undefined,
  () => ({ status: "assigned", principal: { role: "player", id: "player:facade-p1" } }), undefined, undefined, { registry, compiledDurableHostCapability });
  expect(created.status).toBe(201);
  const body = await created.json() as { sessionId: string };
  return { root, catalog, snapshots, registry, compiledDurableHostCapability, sessionId: body.sessionId };
}

async function host(options: { multi?: boolean; branch?: "dock" | "archive"; decorate?: (body: Body, route: string) => Body; fail?: (route: string) => boolean; loseAfter?: PublicPlayerRoute; classifier?: LLMLike } = {}) {
  const root = mkdtempSync(join(tmpdir(), "compiled-public-rollout-"));
  const built = options.branch ? await branchFixture(root, options.branch === "archive") : await createFixture(root, "machine", options.multi ? { pages: NPC_CONTACT_MULTI_PAGES, dialogues: NPC_CONTACT_MULTI_DIALOGUES } : {});
  const posts: Array<{ route: string; body: Body }> = [];
  const followupPrompts: Body[] = [];
  const classifier: LLMLike = options.classifier ?? { async chat(messages) {
    const frame = JSON.parse(messages.at(-1)!.content) as { playerInput: string; availableActions: Array<{ label: string; mechanismId: string }> };
    const matches = frame.availableActions.filter((action) => /ask|问|询|交谈/i.test(frame.playerInput)
      ? action.label.startsWith("Talk to ") : /search|搜索|翻找/i.test(frame.playerInput) ? /Search|搜索|^Take /.test(action.label)
        : /Archive/i.test(frame.playerInput) ? action.label.includes("Go to Archive")
          : /Dock/i.test(frame.playerInput) ? action.label.includes("Go to Dock")
          : /go|去|离开|附近/i.test(frame.playerInput) ? action.label.startsWith("Go to ") : false);
    return JSON.stringify(matches.length === 1 ? { kind: "selected", mechanismId: matches[0]!.mechanismId }
      : matches.length > 1 ? { kind: "ambiguous", mechanismIds: matches.map((action) => action.mechanismId) } : { kind: "no_match" });
  } };
  const followup: LLMLike = { async chat(messages) {
    const frame = JSON.parse(messages.at(-1)!.content) as Body;
    followupPrompts.push(frame);
    return JSON.stringify({ text: followupPrompts.length === 1
      ? JSON.stringify(frame.releasedFacts).includes("archive lies east") ? "The archive lies east." : "The stone can take you outside."
      : "I only know what I just said about that." });
  } };
  const runtime: SessionRuntimeDependencies = {
    registry: built.registry, compiledDurableHostCapability: built.compiledDurableHostCapability,
    compiledNarrationOptions: { llm: { chat: async () => JSON.stringify({ text: "You continue your investigation." }) }, isLlmEnabled: () => true },
    compiledFollowupOptions: { llm: followup, isLlmEnabled: () => true },
  };
  const delivery = new CompiledPlayerDelivery({ secret: "public_rollout_secret_0123456789abcdefghijk", publicOrigin: "https://test" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const route = new URL(request.url).pathname.split("/").at(-1)!;
    if (request.method === "POST") posts.push({ route, body: await request.clone().json() as Body });
    if (options.fail?.(route)) return Response.json({ error: { code: "PRIVATE_ERROR", detail: PRIVATE }, state: PRIVATE }, { status: 503 });
    const response = await handleRequest(request, built.catalog, built.snapshots, { careerRoot: join(root, "careers") }, { llm: classifier, isLlmEnabled: () => true }, {}, player, undefined, undefined, delivery, undefined, runtime);
    if (options.loseAfter === route && response.status === 200) return Response.json({ error: { detail: PRIVATE } }, { status: 503 });
    if (!options.decorate || response.status !== 200 || route === "player-intents") return response;
    return Response.json(options.decorate(await response.json() as Body, route), { status: response.status });
  } });
  return {
    posts, followupPrompts,
    request: (route: PublicPlayerRoute, body?: object) => fetch(new URL(`/api/sessions/${built.sessionId}/${route}`, server.url), body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    async close() { await server.stop(true); for (const session of built.registry.values()) session.close(); built.registry.clear(); rmSync(root, { recursive: true, force: true }); },
  };
}

function planner(decide: (prompt: string, index: number) => string, prompts: string[] = []): LLMLike {
  return { async chat(messages: Message[]) { const prompt = messages[1]!.content; prompts.push(prompt); return JSON.stringify({ action: decide(prompt, prompts.length - 1) }); } };
}

test("public projection is deep-whitelisted, order invariant, and retains equal-label choices as multiplicity", () => {
  const view = {
    generation: 7, terminal: false, private: PRIVATE,
    actions: [{ choiceId: "opaqueB", label: "Go to another area", mechanismId: PRIVATE }, { choiceId: "opaqueC", label: "Talk", hidden: PRIVATE }, { choiceId: "opaqueA", label: "Go to another area" }],
    presentation: { scene: { name: "Crossroads", description: "A person is here; exits have no signs.", secret: PRIVATE }, clues: [{ name: "Known fact", revelation: "There are no signs.", private: PRIVATE }], contacts: [], catalog: PRIVATE },
  };
  const projected = projectCompiledPublicPlayerObservation(view);
  expect(projected).not.toBeNull();
  expect(JSON.stringify(projected)).not.toContain(PRIVATE);
  expect(JSON.stringify(projected)).not.toContain("opaque");
  expect(projected!.actions.filter((action) => action.label === "Go to another area")).toHaveLength(2);
  expect(projected!.knownClues).toEqual([{ name: "Known fact", revelation: "There are no signs." }]);
  expect(projected).not.toHaveProperty("availableClues");
  expect(projectCompiledPublicPlayerObservation({ ...view, actions: [...view.actions].reverse() })).toEqual(projected);
});

test("callers cannot widen the six-action/two-question caps to cause any dispatch", async () => {
  let requests = 0, calls = 0;
  const request = async () => { requests++; throw new Error("unexpected transport"); };
  const llm: LLMLike = { async chat() { calls++; return '{"action":"我问路。"}'; } };
  for (const limits of [{ maxActions: 7 }, { maxFollowups: 3 }, { maxActions: -1 }, { maxFollowups: 0.5 }]) {
    expect((await runCompiledPublicPlayerRollout({ request, llm, persona: reporter, isLlmEnabled: () => true, ...limits })).reason).toBe("contract_invalid");
  }
  expect(requests).toBe(0); expect(calls).toBe(0);
});

test("different public personas choose different reasonable actions through actual intent and opaque commit HTTP", async () => {
  const prompts: string[] = [];
  const llm = planner((prompt) => prompt.includes(explorer.currentGoal) ? "我离开当前地方，去附近的另一个区域看看。" : "我向在场的人询问信息。", prompts);
  const one = await host(); const two = await host({ multi: true });
  try {
    const a = await runCompiledPublicPlayerRollout({ request: one.request, llm, isLlmEnabled: () => true, persona: reporter, maxActions: 1, maxFollowups: 0 });
    const b = await runCompiledPublicPlayerRollout({ request: two.request, llm, isLlmEnabled: () => true, persona: explorer, maxActions: 1, maxFollowups: 0 });
    expect(a.confirmed).toHaveLength(1); expect(b.confirmed).toHaveLength(1);
    expect(a.confirmed[0]!.result).toContain("stone");
    expect(a.confirmed[0]!.result).toContain("You continue your investigation.");
    expect(b.confirmed[0]!.result).toContain("Archive");
    expect(a.confirmed[0]!.action).not.toBe(b.confirmed[0]!.action);
    expect(one.posts.map((post) => post.route)).toEqual(["player-intents", "player-actions"]);
    expect(two.posts.map((post) => post.route)).toEqual(["player-intents", "player-actions"]);
    for (const instance of [one, two]) expect(Object.keys(instance.posts[1]!.body).sort()).toEqual(["actionId", "choiceId", "expectedGeneration", "playerInput", "topicBound"]);
    expect(prompts[1]).not.toContain(a.confirmed[0]!.action);
    expect(prompts[1]).toContain('【已确认的最近行动及实际公开结果】\n[]');
    expect(a.counters).toMatchObject({ decisions: 1, intents: 1, actions: 1, followups: 0 });
  } finally { await one.close(); await two.close(); }
}, 30_000);

test("multiple generic exits do not block a real Search and newly published facts change the next observation", async () => {
  const instance = await host({ branch: "archive" }); const prompts: string[] = [];
  try {
    const initial = await (await instance.request("player-view")).json() as Body;
    expect(initial.actions.filter((action: Body) => action.label === "Go to another area")).toHaveLength(2);
    expect(initial.actions.some((action: Body) => action.label === "Search here")).toBeTrue();
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: explorer, isLlmEnabled: () => true,
      llm: planner((_prompt, index) => index === 0 ? "我搜索当前区域。" : "我停下。", prompts), maxActions: 2, maxFollowups: 0 });
    expect(result.confirmed).toHaveLength(1);
    expect(instance.posts.filter((post) => post.route === "player-actions")).toHaveLength(1);
    expect(result.confirmed[0]!.result).toContain("newKnownClues");
    expect(prompts[1]).toContain("dream stone");
  } finally { await instance.close(); }
}, 30_000);

test("cancellation after a real selected intent still cannot submit a mechanical action", async () => {
  const instance = await host(); const controller = new AbortController();
  try {
    const result = await runCompiledPublicPlayerRollout({ request: async (route, body) => {
      const response = await instance.request(route, body);
      if (route === "player-intents") controller.abort();
      return response;
    }, persona: reporter, isLlmEnabled: () => true, signal: controller.signal,
    llm: planner(() => "我向在场的人询问信息。"), maxActions: 1, maxFollowups: 0 });
    expect(result.reason).toBe("aborted"); expect(result.confirmed).toEqual([]);
    expect(instance.posts.map((post) => post.route)).toEqual(["player-intents"]);
    expect((await (await instance.request("player-view")).json() as Body).generation).toBe(0);
  } finally { await instance.close(); }
}, 30_000);

test("unmarked generic exits are not guessed: a public Talk releases a destination before the next natural movement", async () => {
  const instance = await host({ branch: "dock" }); const prompts: string[] = [];
  const actions = ["我去附近另一个区域。", "我向在场的人询问去路。", "我去刚才公开提到的 Archive。"];
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: reporter, isLlmEnabled: () => true,
      llm: planner((prompt, index) => {
        if (index === 1) expect(prompt).toContain("ambiguous");
        if (index === 2) expect(prompt).toContain("the archive lies east");
        return actions[index]!;
      }, prompts), maxActions: 3, maxFollowups: 0 });
    expect(result.failures).toEqual([{ action: actions[0], code: "ambiguous" }]);
    expect(result.confirmed.map((turn) => turn.action)).toEqual(actions.slice(1));
    expect(instance.posts.map((post) => post.route)).toEqual(["player-intents", "player-intents", "player-actions", "player-intents", "player-actions"]);
    expect(result.confirmed[1]!.result).toContain("Archive");
  } finally { await instance.close(); }
}, 30_000);

test("the same prose is allowed after a real public scene change, rather than stopped solely for repetition", async () => {
  const instance = await host();
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: explorer, isLlmEnabled: () => true,
      llm: planner(() => "我去附近另一个区域看看。"), maxActions: 2, maxFollowups: 0 });
    expect(result.reason).toBe("terminal");
    expect(result.confirmed).toHaveLength(2);
    expect(result.confirmed[0]!.action).toBe(result.confirmed[1]!.action);
    expect(result.confirmed[0]!.result).toContain("Archive"); expect(result.confirmed[1]!.result).toContain("Exit");
    expect(instance.posts.filter((post) => post.route === "player-actions")).toHaveLength(2);
  } finally { await instance.close(); }
}, 30_000);

test("lost committed action responses stop uncertain without inventing failure history or resubmitting", async () => {
  const instance = await host({ loseAfter: "player-actions" }); const prompts: string[] = [];
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: reporter, isLlmEnabled: () => true,
      llm: planner(() => "我向在场的人询问信息。", prompts), maxActions: 6, maxFollowups: 2 });
    const actual = await (await instance.request("player-view")).json() as Body;
    expect(actual.generation).toBe(1);
    expect(result.reason).toBe("unavailable"); expect(result.confirmed).toEqual([]); expect(result.failures).toEqual([]);
    expect(prompts).toHaveLength(1); expect(instance.posts.filter((post) => post.route === "player-actions")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  } finally { await instance.close(); }
}, 30_000);

test("lost followup replies stop uncertain and do not create a chain head or a second question", async () => {
  const instance = await host({ loseAfter: "player-followups" }); const prompts: string[] = [];
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: reporter, isLlmEnabled: () => true,
      llm: planner((_prompt, index) => index === 0 ? "我向在场的人询问信息。" : "你刚才说的石头能做什么？", prompts), maxActions: 1, maxFollowups: 2 });
    expect(result.reason).toBe("unavailable"); expect(result.confirmed).toHaveLength(1); expect(result.failures).toEqual([]);
    expect(prompts).toHaveLength(2); expect(instance.followupPrompts).toHaveLength(1);
    expect(instance.posts.filter((post) => post.route === "player-followups")).toHaveLength(1);
  } finally { await instance.close(); }
}, 30_000);

test("the bounded audit retains all six committed actions and two delivered questions, while prompts keep only recent confirmed turns", async () => {
  const instance = await host({ branch: "dock" }); const prompts: string[] = [];
  const actions = ["我向在场的人询问去路。", "我去刚才公开提到的 Archive。", "我搜索当前区域。", "我返回 Dock。", "我再去 Archive。", "我再次返回 Dock。", "Mira，你刚才提到的地方在哪个方向？", "你刚才说的是哪边？"];
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: reporter, isLlmEnabled: () => true,
      llm: planner((_prompt, index) => actions[index]!, prompts), maxActions: 6, maxFollowups: 2 });
    expect(result.confirmed.map((turn) => turn.action)).toEqual(actions);
    expect(result.counters).toEqual({ decisions: 8, intents: 6, actions: 6, followups: 2 });
    const sixthHistory = prompts[6]!.split("【已确认的最近行动及实际公开结果】\n")[1]!.split("\n")[0]!;
    expect(JSON.parse(sixthHistory).map((turn: Body) => turn.action)).toEqual(actions.slice(3, 6));
  } finally { await instance.close(); }
}, 30_000);

test("no_match is a failed observation, not history; the next plan changes and records the actual new public result", async () => {
  const instance = await host(); const prompts: string[] = [];
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: reporter, isLlmEnabled: () => true,
      llm: planner((_prompt, index) => index === 0 ? "我打开一台并不存在的打印机。" : "我向在场的人询问信息。", prompts), maxActions: 2, maxFollowups: 0 });
    expect(instance.posts.map((post) => post.route)).toEqual(["player-intents", "player-intents", "player-actions"]);
    expect(prompts[1]).toContain("no_match"); expect(prompts[1]).toContain("打印机");
    expect(prompts[1]).toContain('【已确认的最近行动及实际公开结果】\n[]');
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]!.result).toContain("stone");
    expect(result.failures).toEqual([{ action: "我打开一台并不存在的打印机。", code: "no_match" }]);
  } finally { await instance.close(); }
}, 30_000);

test("ambiguous alternatives never commit the first choice and repeated same plan stops without guessing", async () => {
  const instance = await host({ multi: true }); const prompts: string[] = [];
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: reporter, isLlmEnabled: () => true,
      llm: planner(() => "我向在场的人询问情况。", prompts), maxActions: 6, maxFollowups: 0 });
    expect(result.reason).toBe("no_progress");
    expect(result.confirmed).toEqual([]);
    expect(result.failures[0]!.code).toBe("ambiguous");
    expect(instance.posts.map((post) => post.route)).toEqual(["player-intents"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("ambiguous");
    expect(result.counters).toMatchObject({ decisions: 2, intents: 1, actions: 0 });
  } finally { await instance.close(); }
}, 30_000);

test("unknown private fields and stale narration cannot enter player prompts or confirmed results", async () => {
  const instance = await host({ decorate(body, route) {
    const view = route === "player-actions" ? body.view : body;
    view.private = PRIVATE; view.presentation.scene.secret = PRIVATE;
    view.presentation.clues = view.presentation.clues.map((clue: Body) => ({ ...clue, private: PRIVATE }));
    view.actions = view.actions.map((action: Body) => ({ ...action, mechanismId: PRIVATE }));
    if (route === "player-actions") view.turn = { generation: 0, text: "STALE_OLD_TURN_NOT_THIS_ACTION" };
    return body;
  } });
  const prompts: string[] = [];
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: explorer, isLlmEnabled: () => true,
      llm: planner((_prompt, index) => index === 0 ? "我去附近另一个区域看看。" : "我停下，不提出行动。", prompts), maxActions: 2, maxFollowups: 0 });
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]!.result).toContain("Archive");
    expect(JSON.stringify({ prompts, result })).not.toContain(PRIVATE);
    expect(JSON.stringify({ prompts, result })).not.toContain("STALE_OLD_TURN_NOT_THIS_ACTION");
    expect(prompts[1]).toContain(result.confirmed[0]!.result.replaceAll('"', '\\"'));
  } finally { await instance.close(); }
}, 30_000);

test("two bounded natural followups use confirmed public replies and the trusted previous action pointer", async () => {
  const instance = await host(); const prompts: string[] = [];
  const questions = ["我向在场的人询问信息。", "Mira，你刚才说的石头能做什么？", "你刚才说的那个能带我去哪里？"];
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: reporter, isLlmEnabled: () => true,
      llm: planner((_prompt, index) => questions[index]!, prompts), maxActions: 1, maxFollowups: 2 });
    expect(result.confirmed).toHaveLength(3);
    expect(result.counters).toMatchObject({ decisions: 3, intents: 1, actions: 1, followups: 2 });
    const followups = instance.posts.filter((post) => post.route === "player-followups");
    expect(followups).toHaveLength(2);
    expect(followups[0]!.body).not.toHaveProperty("previousActionId");
    expect(followups[1]!.body.previousActionId).toBe(followups[0]!.body.actionId);
    expect(followups[1]!.body.playerInput).toBe(questions[2]);
    expect(followups[1]!.body.playerInput).not.toContain("The stone can take you outside.");
    expect(instance.followupPrompts[1]!.previousTurn).toEqual({ playerQuestion: questions[1], contactReply: "The stone can take you outside." });
    expect(prompts[2]).toContain("The stone can take you outside.");
  } finally { await instance.close(); }
}, 30_000);

test("abort after a late model proposal cannot reach either mutation or classification HTTP", async () => {
  const instance = await host(); const signal = new AbortController();
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: reporter, isLlmEnabled: () => true, signal: signal.signal,
      llm: { async chat() { signal.abort(); return '{"action":"我问 Mira 情况。"}'; } }, maxActions: 1, maxFollowups: 0 });
    expect(result.reason).toBe("aborted"); expect(result.confirmed).toEqual([]); expect(instance.posts).toEqual([]);
  } finally { await instance.close(); }
}, 30_000);

test("HTTP provider errors are safe failed observations, never full error bodies or successful history", async () => {
  const instance = await host({ fail: (route) => route === "player-intents" }); const prompts: string[] = [];
  try {
    const result = await runCompiledPublicPlayerRollout({ request: instance.request, persona: reporter, isLlmEnabled: () => true,
      llm: planner((_prompt, index) => index === 0 ? "我问 Mira 情况。" : "我去附近的另一个区域。", prompts), maxActions: 2, maxFollowups: 0 });
    expect(result.confirmed).toEqual([]); expect(result.failures.map((failure) => failure.code)).toEqual(["unavailable", "unavailable"]);
    expect(prompts[1]).toContain("unavailable"); expect(JSON.stringify({ prompts, result })).not.toContain(PRIVATE);
    expect(instance.posts.every((post) => post.route === "player-intents")).toBeTrue();
  } finally { await instance.close(); }
}, 30_000);
