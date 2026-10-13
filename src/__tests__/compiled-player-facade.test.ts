import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import {
  buildTrustedPresentationReviewCandidatePage,
  buildTrustedPresentationSelectionCandidatePage,
  projectTrustedResolvedCompilerArtifact,
  TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE,
  trustedPresentationMachineCoverageIdentity,
  trustedPresentationMachineDecisionIdentity,
  type TrustedPresentationMachinePublication,
} from "../compiler/compiler-module-data-projection";
import { createResolvedCompilerArtifact } from "../compiler/compiler-artifact";
import { GameSession, resolveCompiledDurablePlayerFollowupContacts } from "../api/game-session";
import { CompiledSessionSnapshotStore, compiledSessionSnapshotHash, validateCompiledSessionSnapshot, type CompiledSessionSnapshot } from "../api/compiled-session-snapshot";
import { CompiledNarrationAdmissionCoordinator, CompiledPlayerFollowupAdmissionCoordinator } from "../api/compiled-narration-admission";
import { CompiledNarrationLedger, CompiledPlayerFollowupLedger } from "../api/compiled-narration-ledger";
import { CompiledPlayerDelivery } from "../api/player-delivery";
import { handleRequest } from "../api/server";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import type { LLMLike } from "../llm/client";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import {
  createNpcContactSessionFixture,
  NPC_CONTACT_MULTI_DIALOGUES,
  NPC_CONTACT_MULTI_PAGES,
  NPC_CONTACT_TERMINAL_DIALOGUES,
  NPC_CONTACT_TERMINAL_PAGES,
} from "./helpers/compiled-npc-contact-fixture";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";

const owner: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "keeper:facade-owner" } });
const createNpcContactSession = createNpcContactSessionFixture(owner);
const player: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "player", id: "player:facade-p1" } });
const wrongPlayer: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "player", id: "player:facade-other" } });
const wrongRole: CompilerRequestAuthenticator = () => ({ status: "authenticated", principal: { role: "keeper", id: "player:facade-p1" } });
const PLAYER_FACADE_FORBIDDEN = ["library_use", "skill", "attribute", "archetype", "investigator", "mechanismId", "@compiled", "find_parent", "pcId"];

async function withMockedRandom<T>(random: () => number, callback: () => T | Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = random;
  try {
    return await callback();
  } finally {
    Math.random = original;
  }
}

async function expectOpaqueFacadeFailure(response: Response) {
  const text = await response.text();
  for (const forbidden of PLAYER_FACADE_FORBIDDEN) expect(text).not.toContain(forbidden);
}

function checkedSnapshot(value: unknown): CompiledSessionSnapshot {
  const checked = validateCompiledSessionSnapshot(value);
  if (checked.status !== "ok") throw new Error(checked.message);
  return checked.value;
}

async function createPlayerAssignedSession(root: string, resolver: unknown = () => ({ status: "assigned" as const, principal: { role: "player" as const, id: "player:facade-p1" } })) {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const saved = saveTrustedFixtureBundle(catalog, fixture);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const response = await (handleRequest as any)(
    new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }),
    catalog,
    snapshots,
    { careerRoot: join(root, "careers") },
    {},
    {},
    owner,
    undefined,
    resolver,
  );
  expect(response.status).toBe(201);
  const created = await response.json() as { sessionId: string };
  return { catalog, snapshots, sessionId: created.sessionId, root };
}

/** Builds the catalog-backed source-exact projection used by the staged-player regression. */
async function createTrustedPlayerAssignedSession(root: string) {
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const prepared = catalog.savePrepared(fixture.prepared.artifact);
  if (prepared.status !== "ok") throw new Error(prepared.message);
  const review = catalog.saveTrustedPresentationReview(
    prepared.value.id,
    fixture.prepared.artifact,
    fixture.resolved.artifact,
    "operator:facade-presentation",
    exactReviewBindings(fixture.resolved.artifact.payload as any),
  );
  if (review.status !== "ok") throw new Error(review.message);
  const loadedReview = catalog.loadTrustedPresentationReview(review.value.id);
  if (loadedReview.status !== "ok") throw new Error(loadedReview.message);
  const projection = projectTrustedResolvedCompilerArtifact(fixture.resolved.artifact.payload as any, loadedReview.value.review);
  if (projection.status === "refused") throw new Error(projection.message);
  const saved = catalog.saveBundle(fixture.resolved.artifact, projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const response = await (handleRequest as any)(
    new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.value.id, archetype: "investigator", characterName: "Ada" }),
    }),
    catalog,
    snapshots,
    { careerRoot: join(root, "careers") },
    {},
    {},
    owner,
    undefined,
    () => ({ status: "assigned" as const, principal: { role: "player" as const, id: "player:facade-p1" } }),
  );
  expect(response.status).toBe(201);
  const created = await response.json() as { sessionId: string };
  return { catalog, snapshots, sessionId: created.sessionId, root, projection };
}

function sourceExactBinding(payload: any, fieldPath: string, exactText: string) {
  for (let offset = 0; ; offset += TRUSTED_PRESENTATION_WORKBENCH_CANDIDATE_PAGE_SIZE) {
    const page = buildTrustedPresentationReviewCandidatePage(payload, fieldPath, offset);
    if (page.status === "refused") throw new Error(page.message);
    const candidate = page.page.candidates.find((value) => value.exactText === exactText);
    if (candidate) return candidate.binding;
    if (!page.page.hasMore) break;
  }
  throw new Error(`source fixture did not expose exact review text for ${fieldPath}`);
}

/** A real reviewed source shape for the narration guard: the computer is a
 * current public scene fact, while the explicitly empty refrigerator remains
 * a separate, undiscovered clue until its own action settles. */
async function createSourceBoundNarrationSession(root: string, computerScope: "entry" | "archive" = "entry") {
  const computerDescription = "这间屋里有一台电脑，屏幕发出冷光。";
  const sourceDescription = computerScope === "entry" ? computerDescription : "尘埃在昏暗的入口缓缓落下。";
  const archiveDescription = computerScope === "archive" ? computerDescription : "档案室的柜门虚掩着。";
  const emptyRefrigeratorRevelation = "冰箱空荡荡，只剩几层隔板。";
  const page = [
    "入口：",
    sourceDescription,
    "▶父线索：一把档案室钥匙。",
    `▶冰箱：${emptyRefrigeratorRevelation}`,
    "档案室：",
    archiveDescription,
    "▶子线索：一份必须读懂的档案。",
    "出口：",
    "▶出口说明：离开这里的旧车票。",
    "1893",
  ].join("\n");
  const fixture = await compiledModuleHttpFixture("compiled-narration-source-guard", [page]);
  const payload: any = fixture.resolved.artifact.payload;
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const prepared = catalog.savePrepared(fixture.prepared.artifact);
  if (prepared.status !== "ok") throw new Error(prepared.message);
  const entrySceneId = payload.analysisInput.entrySceneId;
  const archiveSceneId = payload.analysisInput.connections.find((connection: any) => connection.id === "entry_archive")?.toSceneId;
  if (typeof archiveSceneId !== "string") throw new Error("source fixture requires archive scene");
  const bindings = exactReviewBindings(payload).map((binding: any) => {
    if (binding.fieldPath === `scenes.${entrySceneId}.description`) {
      return sourceExactBinding(payload, binding.fieldPath, sourceDescription);
    }
    if (binding.fieldPath === `scenes.${archiveSceneId}.description`) {
      return sourceExactBinding(payload, binding.fieldPath, archiveDescription);
    }
    if (binding.fieldPath === "module.era") return sourceExactBinding(payload, binding.fieldPath, "1893");
    return binding;
  });
  const review = catalog.saveTrustedPresentationReview(
    prepared.value.id,
    fixture.prepared.artifact,
    fixture.resolved.artifact,
    "operator:source-bound-narration",
    bindings,
  );
  if (review.status !== "ok") throw new Error(review.message);
  const loadedReview = catalog.loadTrustedPresentationReview(review.value.id);
  if (loadedReview.status !== "ok") throw new Error(loadedReview.message);
  const projection = projectTrustedResolvedCompilerArtifact(payload, loadedReview.value.review);
  if (projection.status === "refused") throw new Error(projection.message);
  const saved = catalog.saveBundle(fixture.resolved.artifact, projection);
  if (saved.status !== "ok") throw new Error(saved.message);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const response = await (handleRequest as any)(
    new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.value.id, archetype: "investigator", characterName: "Ada" }),
    }),
    catalog,
    snapshots,
    { careerRoot: join(root, "careers") },
    {},
    {},
    owner,
    undefined,
    () => ({ status: "assigned" as const, principal: { role: "player" as const, id: "player:facade-p1" } }),
  );
  expect(response.status).toBe(201);
  const created = await response.json() as { sessionId: string };
  const refrigerator = projection.module.scenes
    .flatMap((scene) => scene.clues)
    .find((clue) => clue.name === "冰箱");
  if (!refrigerator || refrigerator.revelation !== emptyRefrigeratorRevelation) {
    throw new Error("source fixture must retain the exact empty refrigerator revelation");
  }
  return {
    catalog,
    snapshots,
    sessionId: created.sessionId,
    root,
    sourceDescription,
    computerDescription,
    emptyRefrigeratorRevelation,
  };
}

async function runtime(
  built: Awaited<ReturnType<typeof createPlayerAssignedSession>>,
  path: string,
  auth: CompilerRequestAuthenticator,
  init: RequestInit = {},
  intentOptions: { llm?: LLMLike; isLlmEnabled?: () => boolean } = {},
  sessionRuntime: Record<string, unknown> = {},
  playerDelivery?: CompiledPlayerDelivery,
) {
  return handleRequest(
    new Request(`${playerDelivery?.publicOrigin ?? "http://test"}${path}`, init),
    built.catalog,
    built.snapshots,
    { careerRoot: join(built.root, "careers") },
    intentOptions,
    {},
    auth,
    undefined,
    undefined,
    playerDelivery,
    undefined,
    {
      ...((built as typeof built & { registry?: Map<string, GameSession>; compiledDurableHostCapability?: object }).registry
        ? {
            registry: (built as typeof built & { registry: Map<string, GameSession> }).registry,
            compiledDurableHostCapability: (built as typeof built & { compiledDurableHostCapability: object }).compiledDurableHostCapability,
          }
        : {}),
      ...sessionRuntime,
    },
  );
}

describe("compiled p1 player façade", () => {
  it("persists exact provider narration through the real opaque player-action route", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-red-"));
    try {
      const built = await createTrustedPlayerAssignedSession(root);
      const base = `/api/sessions/${built.sessionId}`;
      const view = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      let calls = 0;
      const narrator: LLMLike = {
        async chat() {
          calls += 1;
          return '{"text":"Ada studies the reviewed entrance."}';
        },
      };
      const action = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: view.actions[0].choiceId, actionId: "player-narration-route-0001", expectedGeneration: 0 }),
      }, {}, {
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
      });
      expect(action.status).toBe(200);
      expect((await action.json() as any).view.turn).toEqual({ generation: 1, text: "Ada studies the reviewed entrance." });
      const substitutedChoice = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: `choice_${"A".repeat(43)}`, actionId: "player-narration-route-0001", expectedGeneration: 0 }),
      }, {}, { compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true } });
      expect(substitutedChoice.status).toBe(409);
      expect(calls).toBe(1);
      const retry = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: view.actions[0].choiceId, actionId: "player-narration-route-0001", expectedGeneration: 0 }),
      }, {}, {
        // A committed receipt remains exact even if the current configuration
        // no longer permits a new provider call.
        compiledNarrationOptions: { isLlmEnabled: () => false },
      });
      expect(retry.status).toBe(200);
      expect((await retry.json() as any).view.turn).toEqual({ generation: 1, text: "Ada studies the reviewed entrance." });
      expect(calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects only a current-scene, found prose dialogue contact from a machine-published review", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-npc-contact-"));
    try {
      const built = await createNpcContactSession(root);
      const base = `/api/sessions/${built.sessionId}`;
      const machinePublication = built.machinePublication;
      if (!machinePublication) throw new Error("contact fixture requires a machine publication receipt");
      const npcNamePath = `npcs.${built.proseClue.npcId}.name`;
      expect(machinePublication.scopes).toContainEqual({ fieldPath: npcNamePath, audience: "public_on_entry" });
      expect(machinePublication.scopes).toContainEqual({ fieldPath: `npcs.${built.proseClue.npcId}.description`, audience: "private_context" });

      // The canonical machine selector may release the exact source-bound
      // NPC identity, but it must not offer the private paragraph as a
      // current-scene description. The same paragraph remains an ordinary
      // manual-review candidate, proving this is a machine clearance filter
      // rather than a forged or unavailable source.
      const npc = built.payload.proseNpcBindings.find((candidate) => candidate.npcId === built.proseClue.npcId);
      if (!npc) throw new Error("contact fixture lacks the NPC binding");
      const paragraph = built.payload.graph.statements.find((statement) => statement.id === npc.paragraphStatementId);
      if (!paragraph) throw new Error("contact fixture lacks the NPC paragraph");
      const sceneDescriptionPath = `scenes.${built.proseClue.sceneCandidateId}.description`;
      const manualSceneCandidates = buildTrustedPresentationReviewCandidatePage(built.payload, sceneDescriptionPath, 0);
      const machineSceneCandidates = buildTrustedPresentationSelectionCandidatePage(built.payload, sceneDescriptionPath, 0);
      const machineNameCandidates = buildTrustedPresentationSelectionCandidatePage(built.payload, npcNamePath, 0);
      if (manualSceneCandidates.status === "refused" || machineSceneCandidates.status === "refused" || machineNameCandidates.status === "refused") {
        throw new Error("contact fixture candidate page was refused");
      }
      expect(manualSceneCandidates.page.candidates.some((candidate) => candidate.exactText === paragraph.text)).toBe(true);
      expect(machineSceneCandidates.page.candidates.some((candidate) => candidate.exactText === paragraph.text)).toBe(false);
      // `npcs.*.name` accepts only its exact name quote by the canonical
      // plan; a nonempty machine page is therefore the narrow name exception,
      // not authority to release the paragraph above.
      expect(machineNameCandidates.page.candidates.length).toBeGreaterThan(0);

      const initial = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      expect(initial.presentation.contacts).toBeUndefined();
      const talk = initial.actions.find((action: any) => action.label === "Talk");
      expect(talk).toBeDefined();
      const talked = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: talk.choiceId, actionId: "npc-contact-talk-0001", expectedGeneration: initial.generation }),
      });
      expect(talked.status).toBe(200);
      const afterTalk = await talked.json() as any;
      expect(afterTalk.view.presentation.contacts).toEqual([{ name: "Mira" }]);
      const afterText = JSON.stringify(afterTalk.view);
      for (const forbidden of [built.proseClue.npcId, built.proseClue.mechanismId, "knowledge", "secrets"]) {
        expect(afterText).not.toContain(forbidden);
      }

      const move = afterTalk.view.actions.find((action: any) => action.label === "Go to another area");
      expect(move).toBeDefined();
      const moved = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: move.choiceId, actionId: "npc-contact-move-0001", expectedGeneration: afterTalk.view.generation }),
      });
      expect(moved.status).toBe(200);
      expect((await moved.json() as any).view.presentation.contacts).toBeUndefined();

      // A reviewed human presentation remains valid for existing scene/clue
      // output, but it is not evidence of the machine scope required here.
      const manual = await createNpcContactSession(join(root, "manual"), "manual");
      const manualView = await (await runtime(manual, `/api/sessions/${manual.sessionId}/player-view`, player)).json() as any;
      expect(manualView.presentation.contacts).toBeUndefined();
      const manualTalk = manualView.actions.find((action: any) => action.label === "Talk");
      expect(manualTalk).toBeDefined();
      const manuallyTalked = await runtime(manual, `/api/sessions/${manual.sessionId}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: manualTalk.choiceId, actionId: "npc-contact-manual-talk-0001", expectedGeneration: manualView.generation }),
      });
      expect(manuallyTalked.status).toBe(200);
      const afterManualTalk = await manuallyTalked.json() as any;
      expect(afterManualTalk.view.presentation.scene).toEqual(manualView.presentation.scene);
      expect(afterManualTalk.view.presentation.clues).toHaveLength(1);
      expect(afterManualTalk.view.presentation.contacts).toBeUndefined();

      // Scope coverage is checked at the durable review boundary. Removing
      // the NPC name scope cannot yield a valid bundle that reaches a player.
      const withoutNameScope = machinePublication.scopes.filter((scope) => scope.fieldPath !== npcNamePath);
      const malformedPublication: TrustedPresentationMachinePublication = {
        ...machinePublication,
        scopes: withoutNameScope,
        coverageHash: trustedPresentationMachineCoverageIdentity(withoutNameScope),
        decisionHash: trustedPresentationMachineDecisionIdentity(built.bindings, withoutNameScope),
      };
      const scopeCatalog = new CompilerArtifactCatalog({ root: join(root, "missing-scope-catalog") });
      const scopePrepared = scopeCatalog.savePrepared(built.preparedArtifact);
      if (scopePrepared.status !== "ok") throw new Error(scopePrepared.message);
      const rejectedScope = scopeCatalog.saveTrustedPresentationReview(
        scopePrepared.value.id,
        built.preparedArtifact,
        built.resolvedArtifact,
        machinePublication.servicePrincipalId,
        built.bindings,
        { machinePublication: malformedPublication },
      );
      expect(rejectedScope.status).toBe("refused");

      const wrongIdentity = structuredClone(built.payload);
      wrongIdentity.proseDialogueClues[0]!.npcId = "npc_unbound_contact";
      expect(() => createResolvedCompilerArtifact(wrongIdentity)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("serves a source-scoped NPC followup through the player facade without advancing mechanics", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-npc-followup-red-"));
    try {
      const built = await createNpcContactSession(root);
      const delivery = new CompiledPlayerDelivery({
        secret: "followup_delivery_secret_0123456789abcdefghijk",
        publicOrigin: "https://test",
      });
      const base = `/api/sessions/${built.sessionId}`;
      const initial = await (await runtime(built, `${base}/player-view`, player, {}, {}, {}, delivery)).json() as any;
      const talk = initial.actions.find((action: any) => action.label === "Talk");
      expect(talk).toBeDefined();
      const talked = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: talk.choiceId, actionId: "npc-followup-talk-0001", expectedGeneration: initial.generation }),
      }, {}, {}, delivery);
      expect(talked.status).toBe(200);
      const afterTalk = await talked.json() as any;
      const contact = afterTalk.view.presentation.contacts?.[0] as { name?: unknown; contactToken?: unknown } | undefined;
      const releasedClue = afterTalk.view.presentation.clues?.[0] as { name?: unknown; revelation?: unknown } | undefined;
      expect(releasedClue).toEqual({ name: expect.any(String), revelation: expect.any(String) });
      const snapshotBeforeFollowup = built.snapshots.read(built.sessionId);
      if (snapshotBeforeFollowup.status !== "ok") throw new Error(snapshotBeforeFollowup.message);
      const canonicalSnapshotBeforeFollowup = checkedSnapshot(snapshotBeforeFollowup.value);
      let narratorCalls = 0;
      let capturedPrompt = "";
      const followupRuntime = {
        compiledFollowupOptions: {
          llm: {
            async chat(input: unknown) {
              narratorCalls += 1;
              capturedPrompt = JSON.stringify(input);
              return '{"text":"Mira says she only knows what the recovered clue establishes."}';
            },
          } satisfies LLMLike,
          isLlmEnabled: () => true,
        },
      };

      // The initial red is deliberately an actual facade request rather than
      // a unit-level contact assertion: the absent route currently returns
      // 404 before any model can be reached.
      const followup = await runtime(built, `${base}/player-followups`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactToken: contact?.contactToken,
          actionId: "npc-followup-request-0001",
          expectedGeneration: afterTalk.view.generation,
          playerInput: "What do you remember about the lantern?",
        }),
      }, {}, followupRuntime, delivery);
      expect(followup.status).toBe(200);
      expect(contact).toEqual({ name: "Mira", contactToken: expect.stringMatching(/^contact_[A-Za-z0-9_-]{43}$/) });
      const delivered = await followup.json() as any;
      expect(delivered.view).toEqual(afterTalk.view);
      const snapshotAfterFollowup = built.snapshots.read(built.sessionId);
      if (snapshotAfterFollowup.status !== "ok") throw new Error(snapshotAfterFollowup.message);
      const canonicalSnapshotAfterFollowup = checkedSnapshot(snapshotAfterFollowup.value);
      expect(canonicalSnapshotAfterFollowup.snapshotHash).toBe(canonicalSnapshotBeforeFollowup.snapshotHash);
      expect(canonicalSnapshotAfterFollowup.generation).toBe(afterTalk.view.generation);
      expect(delivered.followup.text).toContain("Mira");
      expect(narratorCalls).toBe(1);
      // The source relationship quote authenticates mechanics, but the
      // follow-up may use only the canonical presentation actually released
      // for this found clue.
      expect(capturedPrompt).toContain(releasedClue!.name as string);
      expect(capturedPrompt).toContain(releasedClue!.revelation as string);
      // These are other source statements from the same compiled module,
      // not this contact's released relationship fact.  Generic safety
      // wording may use ordinary words such as "knowledge" or "secrets",
      // so assert against canonical source content instead of prompt prose.
      expect(capturedPrompt).not.toContain("Dream Stone");
      expect(capturedPrompt).not.toContain("opens the exit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("binds one contact to every sorted, already released clue for that NPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-npc-followup-aggregate-"));
    try {
      const built = await createNpcContactSession(root, "machine", {
        pages: NPC_CONTACT_MULTI_PAGES,
        dialogues: NPC_CONTACT_MULTI_DIALOGUES,
      });
      expect(built.proseClues).toHaveLength(2);
      const delivery = new CompiledPlayerDelivery({
        secret: "followup_delivery_secret_0123456789abcdefghijk",
        publicOrigin: "https://test",
      });
      const base = `/api/sessions/${built.sessionId}`;
      let view = await (await runtime(built, `${base}/player-view`, player, {}, {}, {}, delivery)).json() as any;
      let firstContactToken: string | undefined;
      for (let index = 0; index < 2; index += 1) {
        const talk = view.actions.find((action: any) => action.label === "Talk");
        expect(talk).toBeDefined();
        const action = await runtime(built, `${base}/player-actions`, player, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ choiceId: talk.choiceId, actionId: `npc-followup-aggregate-talk-000${index}`, expectedGeneration: view.generation }),
        }, {}, {}, delivery);
        expect(action.status).toBe(200);
        view = (await action.json() as any).view;
        if (index === 0) firstContactToken = view.presentation.contacts?.[0]?.contactToken;
      }
      expect(view.presentation.contacts).toHaveLength(1);
      expect(view.presentation.clues).toHaveLength(2);
      const contact = view.presentation.contacts[0] as { name: string; contactToken: string };
      expect(firstContactToken).toEqual(expect.stringMatching(/^contact_[A-Za-z0-9_-]{43}$/));
      // The second same-NPC clue changes the canonical token scope even if
      // the player-facing clue labels happen to overlap.
      expect(contact.contactToken).not.toBe(firstContactToken);
      const canonicalContacts = resolveCompiledDurablePlayerFollowupContacts(
        built.registry.get(built.sessionId)!,
        built.compiledDurableHostCapability,
      );
      expect(canonicalContacts).toHaveLength(1);
      expect(canonicalContacts[0]!.clueIds).toEqual([...built.proseClues].map((clue) => clue.clueId).sort());
      const releasedFacts = view.presentation.clues.flatMap((clue: { name: string; revelation: string }) => [clue.name, clue.revelation]);
      let calls = 0;
      let prompt = "";
      const followed = await runtime(built, `${base}/player-followups`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactToken: contact.contactToken, actionId: "npc-followup-aggregate-request-0001", expectedGeneration: view.generation, playerInput: "What can we use now?" }),
      }, {}, {
        compiledFollowupOptions: {
          llm: { async chat(input: unknown) { calls += 1; prompt = JSON.stringify(input); return '{"text":"Mira repeats only the released findings."}'; } } satisfies LLMLike,
          isLlmEnabled: () => true,
        },
      }, delivery);
      expect(followed.status).toBe(200);
      expect(calls).toBe(1);
      for (const fact of releasedFacts) expect(prompt).toContain(fact);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses altered raw input, contact tokens, and a newly aggregated fact scope without another followup call", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-npc-followup-binding-mismatch-"));
    try {
      const built = await createNpcContactSession(root, "machine", {
        pages: NPC_CONTACT_MULTI_PAGES,
        dialogues: NPC_CONTACT_MULTI_DIALOGUES,
      });
      const delivery = new CompiledPlayerDelivery({
        secret: "followup_delivery_secret_0123456789abcdefghijk",
        publicOrigin: "https://test",
      });
      const base = `/api/sessions/${built.sessionId}`;
      let view = await (await runtime(built, `${base}/player-view`, player, {}, {}, {}, delivery)).json() as any;
      const talkOnce = async (actionId: string) => {
        const talk = view.actions.find((action: any) => action.label === "Talk");
        expect(talk).toBeDefined();
        const response = await runtime(built, `${base}/player-actions`, player, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ choiceId: talk.choiceId, actionId, expectedGeneration: view.generation }),
        }, {}, {}, delivery);
        expect(response.status).toBe(200);
        view = (await response.json() as any).view;
      };
      await talkOnce("npc-followup-mismatch-talk-0001");
      const firstContact = view.presentation.contacts?.[0] as { contactToken?: string } | undefined;
      expect(firstContact?.contactToken).toEqual(expect.stringMatching(/^contact_[A-Za-z0-9_-]{43}$/));
      let calls = 0;
      const followupRuntime = {
        compiledFollowupOptions: {
          llm: { async chat() { calls += 1; return '{"text":"Mira stays within the released facts."}'; } } satisfies LLMLike,
          isLlmEnabled: () => true,
        },
      };
      const actionId = "npc-followup-mismatch-request-0001";
      const raw = "What can you confirm from the released clue?";
      const accepted = await runtime(built, `${base}/player-followups`, player, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactToken: firstContact!.contactToken, actionId, expectedGeneration: view.generation, playerInput: raw }),
      }, {}, followupRuntime, delivery);
      expect(accepted.status).toBe(200);
      expect(calls).toBe(1);

      const alteredRaw = await runtime(built, `${base}/player-followups`, player, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactToken: firstContact!.contactToken, actionId, expectedGeneration: view.generation, playerInput: `${raw} Please invent more.` }),
      }, {}, followupRuntime, delivery);
      expect(alteredRaw.status).toBe(409);
      expect(calls).toBe(1);

      await talkOnce("npc-followup-mismatch-talk-0002");
      const aggregateContact = view.presentation.contacts?.[0] as { contactToken?: string } | undefined;
      expect(aggregateContact?.contactToken).toEqual(expect.stringMatching(/^contact_[A-Za-z0-9_-]{43}$/));
      expect(aggregateContact?.contactToken).not.toBe(firstContact?.contactToken);
      const changedFacts = await runtime(built, `${base}/player-followups`, player, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactToken: aggregateContact!.contactToken, actionId, expectedGeneration: view.generation, playerInput: raw }),
      }, {}, followupRuntime, delivery);
      expect(changedFacts.status).toBe(409);
      const alteredToken = `${aggregateContact!.contactToken!.slice(0, -1)}${aggregateContact!.contactToken!.endsWith("A") ? "B" : "A"}`;
      const invalidToken = await runtime(built, `${base}/player-followups`, player, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactToken: alteredToken, actionId: "npc-followup-mismatch-token-0001", expectedGeneration: view.generation, playerInput: raw }),
      }, {}, followupRuntime, delivery);
      expect(invalidToken.status).toBe(409);
      expect(calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("replays a settled source-scoped followup after a fresh host restart without another narration call", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-npc-followup-restart-"));
    try {
      const built = await createNpcContactSession(root);
      const delivery = new CompiledPlayerDelivery({
        secret: "followup_delivery_secret_0123456789abcdefghijk",
        publicOrigin: "https://test",
      });
      const ledger = new CompiledPlayerFollowupLedger(built.snapshots.root);
      const admission = new CompiledPlayerFollowupAdmissionCoordinator(built.snapshots.root);
      const base = `/api/sessions/${built.sessionId}`;
      const initial = await (await runtime(built, `${base}/player-view`, player, {}, {}, {}, delivery)).json() as any;
      const talk = initial.actions.find((action: any) => action.label === "Talk");
      expect(talk).toBeDefined();
      const talked = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: talk.choiceId, actionId: "npc-followup-restart-talk-0001", expectedGeneration: initial.generation }),
      }, {}, {}, delivery);
      expect(talked.status).toBe(200);
      const view = (await talked.json() as any).view;
      const contact = view.presentation.contacts?.[0] as { contactToken?: unknown } | undefined;
      expect(contact?.contactToken).toEqual(expect.stringMatching(/^contact_[A-Za-z0-9_-]{43}$/));
      let calls = 0;
      const request = {
        contactToken: contact!.contactToken,
        actionId: "npc-followup-restart-request-0001",
        expectedGeneration: view.generation,
        playerInput: "What did the released clue establish?",
      };
      const first = await runtime(built, `${base}/player-followups`, player, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      }, {}, {
        compiledFollowupLedger: ledger,
        compiledFollowupAdmission: admission,
        compiledFollowupOptions: {
          llm: { async chat() { calls += 1; return '{"text":"Mira repeats the released clue."}'; } } satisfies LLMLike,
          isLlmEnabled: () => true,
        },
      }, delivery);
      expect(first.status).toBe(200);
      expect(calls).toBe(1);

      // Fresh coordinator objects model a host restart. The exact durable
      // receipt is sufficient; no disabled or newly configured provider may
      // be consulted for this same action identity.
      const replayed = await runtime(built, `${base}/player-followups`, player, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      }, {}, {
        compiledFollowupLedger: new CompiledPlayerFollowupLedger(built.snapshots.root),
        compiledFollowupAdmission: new CompiledPlayerFollowupAdmissionCoordinator(built.snapshots.root),
        compiledFollowupOptions: { isLlmEnabled: () => false },
      }, delivery);
      expect(replayed.status).toBe(200);
      expect((await replayed.json() as any).status).toBe("replayed");
      expect(calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fences a receipt-ledger rollback behind the independent followup admission tombstone", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-npc-followup-ledger-rollback-"));
    try {
      const built = await createNpcContactSession(root);
      const delivery = new CompiledPlayerDelivery({
        secret: "followup_delivery_secret_0123456789abcdefghijk",
        publicOrigin: "https://test",
      });
      const ledger = new CompiledPlayerFollowupLedger(built.snapshots.root);
      const admission = new CompiledPlayerFollowupAdmissionCoordinator(built.snapshots.root);
      const base = `/api/sessions/${built.sessionId}`;
      const initial = await (await runtime(built, `${base}/player-view`, player, {}, {}, {}, delivery)).json() as any;
      const talk = initial.actions.find((action: any) => action.label === "Talk");
      expect(talk).toBeDefined();
      const talked = await runtime(built, `${base}/player-actions`, player, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: talk.choiceId, actionId: "npc-followup-rollback-talk-0001", expectedGeneration: initial.generation }),
      }, {}, {}, delivery);
      expect(talked.status).toBe(200);
      const view = (await talked.json() as any).view;
      const contact = view.presentation.contacts?.[0] as { contactToken?: string } | undefined;
      expect(contact?.contactToken).toEqual(expect.stringMatching(/^contact_[A-Za-z0-9_-]{43}$/));
      let calls = 0;
      const run = (actionId: string, input: string) => runtime(built, `${base}/player-followups`, player, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactToken: contact!.contactToken, actionId, expectedGeneration: view.generation, playerInput: input }),
      }, {}, {
        compiledFollowupLedger: ledger,
        compiledFollowupAdmission: admission,
        compiledFollowupOptions: {
          llm: { async chat() { calls += 1; return '{"text":"Mira answers only from the released clue."}'; } } satisfies LLMLike,
          isLlmEnabled: () => true,
        },
      }, delivery);
      const rollbackLedger = (actionId: string, rawInput: string) => {
        const db = new Database(ledger.file);
        try {
          const row = db.query("SELECT record_json FROM compiled_player_followup_records WHERE session_id = ? AND action_id = ?")
            .get(built.sessionId, actionId) as { record_json?: string } | null;
          if (!row?.record_json) throw new Error("followup fixture lacks a stored receipt");
          const oldRecord = JSON.parse(row.record_json) as Record<string, unknown>;
          expect(oldRecord.schemaVersion).toBe("2.0.0");
          expect(oldRecord.playerInput).toBe(rawInput);
          delete oldRecord.dispatchMac;
          db.run("UPDATE compiled_player_followup_records SET record_json = ?, state = 'prepared', receipt_json = NULL, receipt_mac = NULL WHERE session_id = ? AND action_id = ?", [JSON.stringify(oldRecord), built.sessionId, actionId]);
        } finally {
          db.close(true);
        }
      };

      const settledAction = "npc-followup-rollback-settled-0001";
      const settledInput = "What did you actually release?";
      expect((await run(settledAction, settledInput)).status).toBe(200);
      expect(calls).toBe(1);
      rollbackLedger(settledAction, settledInput);
      const fencedSettled = await run(settledAction, settledInput);
      expect(fencedSettled.status).toBe(503);
      expect(calls).toBe(1);
      expect(admission.read(built.sessionId, settledAction)).toMatchObject({ status: "ok", value: { state: "settled" } });

      const dispatchingAction = "npc-followup-rollback-dispatching-0001";
      const dispatchingInput = "Can you repeat the public finding?";
      expect((await run(dispatchingAction, dispatchingInput)).status).toBe(200);
      expect(calls).toBe(2);
      rollbackLedger(dispatchingAction, dispatchingInput);
      const admissionDb = new Database(admission.file);
      try {
        admissionDb.run("UPDATE compiled_player_followup_admission_records SET state = 'dispatching', receipt_hash = NULL, receipt_mac = NULL WHERE session_id = ? AND action_id = ?", [built.sessionId, dispatchingAction]);
      } finally {
        admissionDb.close(true);
      }
      const fencedDispatching = await run(dispatchingAction, dispatchingInput);
      expect(fencedDispatching.status).toBe(503);
      expect(calls).toBe(2);
      expect(admission.read(built.sessionId, dispatchingAction)).toMatchObject({ status: "ok", value: { state: "quarantined" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rolls back and closes followup stores after a real in-transaction write failure", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-followup-transaction-"));
    try {
      const ledger = new CompiledPlayerFollowupLedger(root);
      const admission = new CompiledPlayerFollowupAdmissionCoordinator(root);
      const record = {
        schemaVersion: "1.0.0" as const,
        sessionId: "followup-transaction-session",
        bundleId: "followup-transaction-bundle",
        actionId: "followup-transaction-action",
        expectedGeneration: 0,
        sceneId: "scene_dock",
        npcId: "npc_mira",
        clueIds: ["clue_launch"],
        contactTokenHash: "a".repeat(64),
        factsHash: "b".repeat(64),
        playerRequestHash: "c".repeat(64),
        frameHash: "d".repeat(64),
        preparedMac: "p".repeat(43),
      };
      // Initialize both schemas before installing a source-local trigger that
      // fails inside BEGIN IMMEDIATE rather than at constructor validation.
      expect(ledger.read(record.sessionId, record.actionId)).toEqual({ status: "absent" });
      expect(admission.read(record.sessionId, record.actionId)).toEqual({ status: "absent" });
      const ledgerDb = new Database(ledger.file);
      ledgerDb.run("CREATE TRIGGER reject_followup_ledger_insert BEFORE INSERT ON compiled_player_followup_records BEGIN SELECT RAISE(ABORT, 'forced ledger write failure'); END");
      ledgerDb.close(true);
      expect(ledger.savePrepared(record)).toMatchObject({ status: "refused", code: "unavailable" });
      const ledgerRepair = new Database(ledger.file);
      ledgerRepair.run("DROP TRIGGER reject_followup_ledger_insert");
      ledgerRepair.close(true);
      expect(ledger.savePrepared(record)).toMatchObject({ status: "ok", value: { state: "prepared" } });

      const admissionInput = {
        sessionId: record.sessionId,
        actionId: record.actionId,
        expectedGeneration: record.expectedGeneration,
        requestHash: record.playerRequestHash,
        dispatchMac: "q".repeat(43),
      };
      const admissionDb = new Database(admission.file);
      admissionDb.run("CREATE TRIGGER reject_followup_admission_insert BEFORE INSERT ON compiled_player_followup_admission_records BEGIN SELECT RAISE(ABORT, 'forced admission write failure'); END");
      admissionDb.close(true);
      expect(admission.begin(admissionInput)).toBe("refused");
      const admissionRepair = new Database(admission.file);
      admissionRepair.run("DROP TRIGGER reject_followup_admission_insert");
      admissionRepair.close(true);
      expect(admission.begin(admissionInput)).toBe("acquired");
    } finally {
      // The Windows removal itself proves all failed and repaired transaction
      // handles were closed before this test leaves its private root.
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines an in-flight followup when a real player action advances the durable generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-npc-followup-generation-race-"));
    try {
      const built = await createNpcContactSession(root);
      const delivery = new CompiledPlayerDelivery({
        secret: "followup_delivery_secret_0123456789abcdefghijk",
        publicOrigin: "https://test",
      });
      const ledger = new CompiledPlayerFollowupLedger(built.snapshots.root);
      const admission = new CompiledPlayerFollowupAdmissionCoordinator(built.snapshots.root);
      const base = `/api/sessions/${built.sessionId}`;
      const initial = await (await runtime(built, `${base}/player-view`, player, {}, {}, {}, delivery)).json() as any;
      const talk = initial.actions.find((action: any) => action.label === "Talk");
      expect(talk).toBeDefined();
      const talked = await runtime(built, `${base}/player-actions`, player, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: talk.choiceId, actionId: "npc-followup-race-talk-0001", expectedGeneration: initial.generation }),
      }, {}, {}, delivery);
      expect(talked.status).toBe(200);
      const view = (await talked.json() as any).view;
      const contact = view.presentation.contacts?.[0] as { contactToken?: string } | undefined;
      const move = view.actions.find((action: any) => action.label === "Go to another area");
      expect(contact?.contactToken).toEqual(expect.stringMatching(/^contact_[A-Za-z0-9_-]{43}$/));
      expect(move).toBeDefined();

      let narratorCalls = 0;
      let releaseNarration: (() => void) | undefined;
      let enteredNarration!: () => void;
      const narrationEntered = new Promise<void>((resolve) => { enteredNarration = resolve; });
      const actionId = "npc-followup-race-request-0001";
      const followup = runtime(built, `${base}/player-followups`, player, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactToken: contact!.contactToken, actionId, expectedGeneration: view.generation, playerInput: "What can you confirm?" }),
      }, {}, {
        compiledFollowupLedger: ledger,
        compiledFollowupAdmission: admission,
        compiledFollowupOptions: {
          llm: {
            async chat() {
              narratorCalls += 1;
              enteredNarration();
              return new Promise<string>((resolve) => { releaseNarration = () => resolve('{"text":"Mira answers too late."}'); });
            },
          } satisfies LLMLike,
          isLlmEnabled: () => true,
        },
      }, delivery);
      await narrationEntered;
      const moved = await runtime(built, `${base}/player-actions`, player, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: move.choiceId, actionId: "npc-followup-race-move-0001", expectedGeneration: view.generation }),
      }, {}, {}, delivery);
      expect(moved.status).toBe(200);
      releaseNarration?.();
      const stale = await followup;
      expect(stale.status).toBe(409);
      expect(narratorCalls).toBe(1);
      const stored = ledger.read(built.sessionId, actionId);
      expect(stored).toMatchObject({ status: "ok", value: { state: "quarantined" } });
      if (stored.status !== "ok") throw new Error("followup fixture lost its quarantined receipt record");
      expect(stored.value.narration).toBeUndefined();
      expect(admission.read(built.sessionId, actionId)).toMatchObject({ status: "ok", value: { state: "quarantined" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not dispatch a new followup after a real terminal action", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-npc-followup-terminal-"));
    try {
      const built = await createNpcContactSession(root, "machine", {
        pages: NPC_CONTACT_TERMINAL_PAGES,
        dialogues: NPC_CONTACT_TERMINAL_DIALOGUES,
        terminalAfterDialogueIndex: 1,
      });
      const delivery = new CompiledPlayerDelivery({
        secret: "followup_delivery_secret_0123456789abcdefghijk",
        publicOrigin: "https://test",
      });
      const base = `/api/sessions/${built.sessionId}`;
      let view = await (await runtime(built, `${base}/player-view`, player, {}, {}, {}, delivery)).json() as any;
      for (let index = 0; index < 2; index += 1) {
        const talk = view.actions.find((action: any) => action.label === "Talk");
        expect(talk).toBeDefined();
        const action = await runtime(built, `${base}/player-actions`, player, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ choiceId: talk.choiceId, actionId: `npc-followup-terminal-talk-000${index}`, expectedGeneration: view.generation }),
        }, {}, {}, delivery);
        expect(action.status).toBe(200);
        view = (await action.json() as any).view;
      }
      expect(view.presentation.ending).toBeDefined();
      const contact = view.presentation.contacts?.[0] as { contactToken?: unknown } | undefined;
      expect(contact?.contactToken).toEqual(expect.stringMatching(/^contact_[A-Za-z0-9_-]{43}$/));
      let calls = 0;
      const followup = await runtime(built, `${base}/player-followups`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactToken: contact?.contactToken, actionId: "npc-followup-terminal-request-0001", expectedGeneration: view.generation, playerInput: "Can we continue?" }),
      }, {}, {
        compiledFollowupOptions: {
          llm: { async chat() { calls += 1; return '{"text":"Mira should not speak after the terminal ending."}'; } } satisfies LLMLike,
          isLlmEnabled: () => true,
        },
      }, delivery);
      expect(followup.status).toBe(409);
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("binds a v2 player topic replay to the selected compiled choice", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-topic-choice-"));
    try {
      const built = await createSourceBoundNarrationSession(root);
      const base = `/api/sessions/${built.sessionId}`;
      const view = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      const search = view.actions.find((action: any) => action.label === "Search here");
      const observe = view.actions.find((action: any) => action.label === "Observe here");
      expect(search).toBeDefined();
      expect(observe).toBeDefined();
      expect(observe.choiceId).not.toBe(search.choiceId);

      let classifierCalls = 0;
      let narratorCalls = 0;
      const classified = await runtime(built, `${base}/player-intents`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "I search the entrance for the archive key.", expectedGeneration: view.generation }),
      }, {
        llm: {
          async chat() {
            classifierCalls += 1;
            return '{"kind":"selected","mechanismId":"find_parent"}';
          },
        },
        isLlmEnabled: () => true,
      });
      expect(classified.status).toBe(200);
      const selection = await classified.json() as { action: { choiceId: string }; topicBound: string; generation: number };
      expect(selection.action.choiceId).toBe(search.choiceId);
      expect(selection.topicBound).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
      expect(classifierCalls).toBe(1);

      const before = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      const rejected = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          choiceId: observe.choiceId,
          actionId: "topic-bound-wrong-choice-0001",
          expectedGeneration: selection.generation,
          topicBound: selection.topicBound,
          playerInput: "I search the entrance for the archive key.",
        }),
      }, {}, {
        compiledNarrationOptions: {
          llm: {
            async chat() {
              narratorCalls += 1;
              return '{"text":"must not narrate the unrelated observation"}';
            },
          },
          isLlmEnabled: () => true,
        },
      });
      expect(rejected.status).toBe(409);
      expect(narratorCalls).toBe(0);
      expect(await (await runtime(built, `${base}/player-view`, player)).json()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("admits only canonical source-visible compiled narration before a durable receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-source-guard-"));
    try {
      const built = await createSourceBoundNarrationSession(root);
      const base = `/api/sessions/${built.sessionId}`;
      const initial = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      expect(initial.presentation.scene.description).toBe(built.sourceDescription);
      const ledger = new CompiledNarrationLedger(join(root, "narration-ledger"));
      const admission = new CompiledNarrationAdmissionCoordinator(ledger.root);
      const sourceText = `电脑屏幕发出冷光。${built.emptyRefrigeratorRevelation}`;
      let calls = 0;
      const narrator: LLMLike = {
        async chat() {
          calls += 1;
          return JSON.stringify({ text: sourceText });
        },
      };
      const runtimeOptions = {
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
        compiledNarrationLedger: ledger,
        compiledNarrationAdmission: admission,
      };
      const parentChoice = initial.actions.find((action: any) => action.label === "Search here");
      expect(parentChoice).toBeDefined();

      // The source-exact computer term is allowed for 1893, but the exact
      // empty-refrigerator revelation remains private until this clue is found.
      const hidden = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: parentChoice.choiceId, actionId: "source-guard-hidden-fridge", expectedGeneration: 0 }),
      }, {}, runtimeOptions);
      expect(hidden.status).toBe(422);
      expect(calls).toBe(1);
      expect(ledger.read(built.sessionId, "source-guard-hidden-fridge")).toMatchObject({ status: "ok", value: { state: "quarantined" } });
      const uncommitted = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      expect(uncommitted).toMatchObject({ generation: 0 });
      expect(uncommitted.turn).toBeUndefined();

      // The quarantined action can never re-send a provider request.
      const retry = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: parentChoice.choiceId, actionId: "source-guard-hidden-fridge", expectedGeneration: 0 }),
      }, {}, runtimeOptions);
      expect(retry.status).toBe(503);
      expect(calls).toBe(1);

      // An exact term in another (unvisited) source scene is not a license for
      // this candidate. Only its canonical before/after current scene may
      // supply the narrowly scoped technology exception.
      const otherSceneBuilt = await createSourceBoundNarrationSession(join(root, "other-scene"), "archive");
      const otherSceneBase = `/api/sessions/${otherSceneBuilt.sessionId}`;
      const otherSceneView = await (await runtime(otherSceneBuilt, `${otherSceneBase}/player-view`, player)).json() as any;
      expect(otherSceneView.presentation.scene.description).toBe(otherSceneBuilt.sourceDescription);
      expect(otherSceneView.presentation.scene.description).not.toContain(otherSceneBuilt.computerDescription);
      const otherSceneLedger = new CompiledNarrationLedger(join(root, "other-scene-ledger"));
      const otherSceneChoice = otherSceneView.actions.find((action: any) => action.label === "Search here");
      expect(otherSceneChoice).toBeDefined();
      let otherSceneCalls = 0;
      const otherSceneNarrator: LLMLike = {
        async chat() {
          otherSceneCalls += 1;
          return JSON.stringify({ text: "电脑屏幕发出冷光。" });
        },
      };
      const otherScene = await runtime(otherSceneBuilt, `${otherSceneBase}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: otherSceneChoice.choiceId, actionId: "source-guard-other-scene", expectedGeneration: 0 }),
      }, {}, {
        compiledNarrationOptions: { llm: otherSceneNarrator, isLlmEnabled: () => true },
        compiledNarrationLedger: otherSceneLedger,
        compiledNarrationAdmission: new CompiledNarrationAdmissionCoordinator(otherSceneLedger.root),
      });
      expect(otherScene.status).toBe(422);
      expect(otherSceneCalls).toBe(1);
      expect(calls).toBe(1);
      expect(otherSceneLedger.read(otherSceneBuilt.sessionId, "source-guard-other-scene")).toMatchObject({
        status: "ok",
        value: { state: "quarantined" },
      });

      // The prior unknown dispatch keeps its generation lease quarantined.
      // A clean session proves the positive case without weakening that fence:
      // this action's canonical after-state really discovers the clue whose
      // source revelation says the refrigerator is empty.
      const revealedBuilt = await createSourceBoundNarrationSession(join(root, "revealed"));
      const revealedBase = `/api/sessions/${revealedBuilt.sessionId}`;
      const revealedView = await (await runtime(revealedBuilt, `${revealedBase}/player-view`, player)).json() as any;
      const revealedChoice = revealedView.actions.find((action: any) => action.label === "Observe here");
      expect(revealedChoice).toBeDefined();
      const revealedLedger = new CompiledNarrationLedger(join(root, "revealed-ledger"));
      const revealed = await runtime(revealedBuilt, `${revealedBase}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: revealedChoice.choiceId, actionId: "source-guard-revealed-fridge", expectedGeneration: 0 }),
      }, {}, {
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
        compiledNarrationLedger: revealedLedger,
        compiledNarrationAdmission: new CompiledNarrationAdmissionCoordinator(revealedLedger.root),
      });
      expect(revealed.status).toBe(200);
      expect(calls).toBe(2);
      expect((await revealed.json() as any).view.turn).toEqual({ generation: 1, text: sourceText });
      expect(revealedLedger.read(revealedBuilt.sessionId, "source-guard-revealed-fridge")).toMatchObject({
        status: "ok",
        value: { state: "committed", narration: { schemaVersion: "1.0.0", text: sourceText } },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not let a move narration deny an undiscovered clue left in the prior scene", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-prior-scene-guard-"));
    try {
      const built = await createSourceBoundNarrationSession(root);
      const base = `/api/sessions/${built.sessionId}`;
      const initial = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      const findParent = initial.actions.find((action: any) => action.label === "Search here");
      expect(findParent).toBeDefined();
      const ledger = new CompiledNarrationLedger(join(root, "narration-ledger"));
      let calls = 0;
      const narrator: LLMLike = {
        async chat() {
          calls += 1;
          return JSON.stringify({ text: calls === 1 ? "你在入口找到一把钥匙。" : "离开前，冰箱空荡荡。" });
        },
      };

      const found = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: findParent.choiceId, actionId: "source-guard-prior-scene-parent", expectedGeneration: 0 }),
      }, {}, {
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
        compiledNarrationLedger: ledger,
        compiledNarrationAdmission: new CompiledNarrationAdmissionCoordinator(ledger.root),
      });
      expect(found.status).toBe(200);
      const foundView = await found.json() as any;
      const move = foundView.view.actions.find((action: any) => action.label === "Go to another area");
      expect(move).toBeDefined();

      // The model sees the bounded before/after move frame. It must not turn
      // the prior room's still-undiscovered refrigerator into a fact merely
      // because the successor scene has different undiscovered clue keys.
      const moved = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: move.choiceId, actionId: "source-guard-prior-scene-fridge", expectedGeneration: 1 }),
      }, {}, {
        compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true },
        compiledNarrationLedger: ledger,
        compiledNarrationAdmission: new CompiledNarrationAdmissionCoordinator(ledger.root),
      });
      expect(moved.status).toBe(422);
      expect(calls).toBe(2);
      expect(ledger.read(built.sessionId, "source-guard-prior-scene-fridge")).toMatchObject({
        status: "ok",
        value: { state: "quarantined" },
      });
      const after = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      expect(after).toMatchObject({ generation: 1, turn: { text: "你在入口找到一把钥匙。" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps private candidate identifiers out of the provider frame and rejects invalid text without a mechanics commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-boundary-"));
    try {
      const built = await createTrustedPlayerAssignedSession(root);
      const base = `/api/sessions/${built.sessionId}`;
      const before = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      let captured = "";
      let calls = 0;
      const invalidNarrator: LLMLike = {
        async chat(messages) {
          calls += 1;
          captured = JSON.stringify(messages);
          return '{"text":"snapshot"}';
        },
      };
      const rejected = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: before.actions[0].choiceId, actionId: "player-narration-invalid-0001", expectedGeneration: 0 }),
      }, {}, { compiledNarrationOptions: { llm: invalidNarrator, isLlmEnabled: () => true } });
      expect(rejected.status).toBe(422);
      expect(calls).toBe(1);
      expect(captured).toContain("natural Chinese");
      expect(captured).toContain("reviewed era only");
      expect(captured).not.toContain("1920s");
      expect(captured).not.toContain("mechanismId");
      expect(captured).not.toContain("@compiled");
      expect(captured).not.toContain("player-narration-invalid-0001");
      expect(captured).not.toContain("artifactHash");
      expect(captured).not.toContain("currentSceneId");
      const after = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      expect(after.generation).toBe(before.generation);
      expect(after.turn).toBeUndefined();
      const retry = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: before.actions[0].choiceId, actionId: "player-narration-invalid-0001", expectedGeneration: 0 }),
      }, {}, { compiledNarrationOptions: { llm: invalidNarrator, isLlmEnabled: () => true } });
      expect(retry.status).toBe(503);
      expect(calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines an aborted provider turn without publishing its candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-narration-abort-"));
    try {
      const built = await createTrustedPlayerAssignedSession(root);
      const base = `/api/sessions/${built.sessionId}`;
      const before = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      const controller = new AbortController();
      let entered!: () => void;
      let release!: () => void;
      const enteredProvider = new Promise<void>((resolve) => { entered = resolve; });
      const releaseProvider = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      const narrator: LLMLike = {
        async chat() {
          calls += 1;
          entered();
          await releaseProvider;
          return '{"text":"Ada waits at the reviewed threshold."}';
        },
      };
      const pending = runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: before.actions[0].choiceId, actionId: "player-narration-abort-0001", expectedGeneration: 0 }),
      }, {}, { compiledNarrationOptions: { llm: narrator, isLlmEnabled: () => true } });
      await enteredProvider;
      controller.abort();
      release();
      const aborted = await pending;
      expect(aborted.status).toBe(503);
      expect(calls).toBe(1);
      const after = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      expect(after.generation).toBe(0);
      expect(after.turn).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses only a trusted creation resolver, then serves an opaque player view and retry-safe action", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-facade-"));
    try {
      const built = await createPlayerAssignedSession(root);
      const base = `/api/sessions/${built.sessionId}`;

      const ownerView = await runtime(built, `${base}/player-view`, owner);
      expect(ownerView.status).toBe(200);
      const view = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      expect(view).toMatchObject({ schemaVersion: "1.1.0", generation: 0, round: 0, ruleset: "cosmic-horror", terminal: false });
      // Correct the old no-presentation premise: a public compiled session now
      // requires a trusted review, so its player view must expose only this
      // source-exact, review-approved opening presentation.
      expect(view.presentation).toEqual({
        scene: { name: "入口：", description: "入口：" },
        clues: [],
      });
      const viewText = JSON.stringify(view);
      for (const forbidden of ["caller supplied", "presentationReview", "reviewHash", "sourceMap", "fieldPath", "statement", "evidence", "mechanismId", "pcId"]) {
        expect(viewText).not.toContain(forbidden);
      }
      expect(view.character).toEqual(expect.objectContaining({ name: "Ada", hp: expect.any(Number), maxHp: expect.any(Number) }));
      expect(view.sanity).toEqual(expect.objectContaining({ currentSAN: expect.any(Number), maxSAN: expect.any(Number) }));
      expect(view.actions.length).toBeGreaterThan(0);
      expect(viewText).not.toContain("find_parent");
      expect(viewText).not.toContain("@compiled");
      const playerIntentWithoutModel = await runtime(built, `${base}/player-intents`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "search here", expectedGeneration: view.generation }),
      }, { isLlmEnabled: () => false });
      expect(playerIntentWithoutModel.status).toBe(503);
      expect(playerIntentWithoutModel.headers.get("cache-control")).toBe("no-store");
      await expectOpaqueFacadeFailure(playerIntentWithoutModel);
      const legacyState = await runtime(built, `${base}/state`, player);
      expect(legacyState.status).toBe(404);
      await expectOpaqueFacadeFailure(legacyState);
      const legacyCompiledActions = await runtime(built, `${base}/compiled/actions?pcId=p1`, player);
      expect(legacyCompiledActions.status).toBe(404);
      await expectOpaqueFacadeFailure(legacyCompiledActions);
      const foreignPlayerView = await runtime(built, `${base}/player-view`, wrongPlayer);
      expect(foreignPlayerView.status).toBe(403);
      await expectOpaqueFacadeFailure(foreignPlayerView);
      const wrongRoleView = await runtime(built, `${base}/player-view`, wrongRole);
      expect(wrongRoleView.status).toBe(403);
      await expectOpaqueFacadeFailure(wrongRoleView);

      let unauthorizedPulls = 0;
      const unreadUnauthorized = new ReadableStream<Uint8Array>({
        pull(controller) {
          unauthorizedPulls++;
          controller.enqueue(new TextEncoder().encode('{"choiceId":"not-read","actionId":"not-read","expectedGeneration":0}'));
          controller.close();
        },
      }, { highWaterMark: 0 });
      const unauthorized = await runtime(built, `${base}/player-actions`, wrongPlayer, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: unreadUnauthorized,
      });
      expect(unauthorized.status).toBe(403);
      expect(unauthorizedPulls).toBe(0);
      await expectOpaqueFacadeFailure(unauthorized);

      const request = { choiceId: view.actions[0].choiceId, actionId: "p1-facade-retry", expectedGeneration: 0 };
      const action = await runtime(built, `${base}/player-actions`, player, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      });
      expect(action.status).toBe(200);
      const acted = await action.json() as any;
      expect(acted).toMatchObject({ result: { status: "committed" }, view: { generation: 1, round: 1 } });
      const actionText = JSON.stringify(acted);
      for (const forbidden of ["compiled", "trace", "stateHash", "history", "events", "narrative", "receipt", "mechanismId", "@compiled", "find_parent", "pcId"]) {
        expect(actionText).not.toContain(forbidden);
      }

      const retried = await runtime(built, `${base}/player-actions`, player, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      });
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ result: { status: "duplicate" }, view: { generation: 1 } });

      const stale = await runtime(built, `${base}/player-actions`, player, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...request, actionId: "p1-facade-stale" }),
      });
      expect(stale.status).toBe(409);
      const unknown = await runtime(built, `${base}/player-actions`, player, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceId: "choice_not_a_real_hmac", actionId: "p1-facade-unknown", expectedGeneration: 1 }),
      });
      expect(unknown.status).toBe(409);
      const extra = await runtime(built, `${base}/player-actions`, player, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceId: view.actions[0].choiceId, actionId: "p1-facade-extra", expectedGeneration: 0, mechanismId: "find_parent" }),
      });
      expect(extra.status).toBe(400);
      for (const failure of [stale, unknown, extra]) await expectOpaqueFacadeFailure(failure);

      const travelChoice = acted.view.actions.find((candidate: any) => candidate.label === "Go to another area");
      expect(travelChoice).toBeDefined();
      const travel = await runtime(built, `${base}/player-actions`, player, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: travelChoice.choiceId, actionId: "p1-facade-to-checked-action", expectedGeneration: 1 }),
      });
      expect(travel.status).toBe(200);
      const checked = await travel.json() as any;
      expect(checked).toMatchObject({ result: { status: "committed" }, view: { generation: 2, round: 2 } });
      const checkedAction = checked.view.actions.find((candidate: any) => candidate.check !== undefined);
      expect(checkedAction).toMatchObject({ label: "Read here", check: { kind: "check", difficulty: "hard" } });
      expect(checked.view.character).not.toHaveProperty("archetype");
      expect(checked.view.presentation).toEqual({
        scene: { name: "档案室：", description: "档案室：" },
        clues: [{ name: "父线索", revelation: "一把档案室钥匙。" }],
      });
      // `scene` is public only inside the reviewed presentation above; retain
      // the older assertion that none of the private response fields reveal
      // runtime scene/mechanics vocabulary.
      const { presentation: _presentation, ...uncheckedView } = checked.view;
      const checkedText = JSON.stringify({ ...checked, view: uncheckedView });
      for (const forbidden of ["library_use", "skill", "attribute", "archetype", "archetypeId", "investigator", "find_child", "scene", "mechanismId", "@compiled", "pcId"]) {
        expect(checkedText).not.toContain(forbidden);
      }

      const stored = built.snapshots.read(built.sessionId);
      if (stored.status !== "ok") throw new Error(stored.message);
      const snapshot = checkedSnapshot(stored.value);

      const replacement = new GameSession(built.sessionId, "cosmic-horror", undefined, undefined, undefined, undefined, { careerRoot: join(root, "careers") });
      const bundle = built.catalog.loadBundle(snapshot.bundle.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const restoreCheck = GameSession.validateCompiledSessionRestore(snapshot, bundle.value, built.sessionId);
      if (restoreCheck.status === "refused") throw new Error(`validation: ${restoreCheck.message}`);
      const restored = replacement.restoreCompiledSession(snapshot, bundle.value);
      if (restored.status === "refused") throw new Error(restored.message);
      expect(restored.status).toBe("loaded");
      expect((replacement as any).getCompiledPlayerFacadeView().generation).toBe(2);
      expect(snapshot.access).toMatchObject({
        ownerRole: "keeper",
        playerGrant: { pcId: "p1", role: "player", principalFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
        choiceHmacKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  // This reviewed-presentation chain performs multiple durable fsync/HTTP rounds; 15s is a test scheduler budget, not a production latency SLO.
  it("stages only reviewed current-scene, discovered-clue, and terminal-ending text through real player HTTP routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-presentation-"));
    try {
      const built = await createTrustedPlayerAssignedSession(root);
      const base = `/api/sessions/${built.sessionId}`;
      const payload: any = (await compiledModuleHttpFixture()).resolved.artifact.payload;
      const entryId = payload.analysisInput.entrySceneId;
      const archiveId = payload.analysisInput.connections.find((connection: any) => connection.id === "entry_archive")!.toSceneId;
      const exitId = payload.analysisInput.connections.find((connection: any) => connection.id === "archive_exit")!.toSceneId;
      const parentId = payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_parent")!.clueId;
      const childId = payload.mechanicsIR.discoveryMethods.find((method: any) => method.id === "find_child")!.clueId;
      const projectionScenes = new Map(built.projection.module.scenes.map((scene) => [scene.id, scene]));
      const clues = new Map(built.projection.module.scenes.flatMap((scene) => scene.clues).map((clue) => [clue.id, clue]));
      const endings = new Map(built.projection.module.endings.map((ending) => [ending.id, ending]));
      const entry = projectionScenes.get(entryId)!;
      const archive = projectionScenes.get(archiveId)!;
      const exit = projectionScenes.get(exitId)!;
      const parent = clues.get(parentId)!;
      const child = clues.get(childId)!;
      const unrevealed = [...clues.entries()].find(([id]) => id !== parentId && id !== childId)?.[1];
      if (!unrevealed) throw new Error("trusted fixture needs an undiscovered clue");
      const clean = endings.get("clean")!;
      const hasty = endings.get("hasty")!;
      const action = async (view: any, label: string, actionId: string) => {
        const choice = view.actions.find((candidate: any) => candidate.label === label);
        expect(choice).toBeDefined();
        const response = await runtime(built, `${base}/player-actions`, player, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ choiceId: choice.choiceId, actionId, expectedGeneration: view.generation }),
        });
        expect(response.status).toBe(200);
        return await response.json() as any;
      };

      const initial = await (await runtime(built, `${base}/player-view`, player)).json() as any;
      expect(initial).toMatchObject({ schemaVersion: "1.1.0", generation: 0, terminal: false });
      expect(initial.presentation).toEqual({
        scene: { name: entry.name, description: entry.description },
        clues: [],
      });
      for (const hidden of [archive.description, exit.description, parent.name, parent.revelation, child.name, child.revelation, unrevealed.name, unrevealed.revelation, clean.name, clean.description, hasty.name, hasty.description]
        .filter((text) => text !== entry.name && text !== entry.description)) {
        expect(JSON.stringify(initial)).not.toContain(hidden);
      }

      const discoveredParent = await action(initial, "Search here", "presentation-parent");
      expect(discoveredParent.view.presentation).toEqual({
        scene: { name: entry.name, description: entry.description },
        clues: [{ name: parent.name, revelation: parent.revelation }],
      });
      expect(JSON.stringify(discoveredParent.view)).not.toContain(child.revelation);

      const moved = await action(discoveredParent.view, "Go to another area", "presentation-archive");
      expect(moved.view.presentation).toEqual({
        scene: { name: archive.name, description: archive.description },
        clues: [{ name: parent.name, revelation: parent.revelation }],
      });

      const discoveredChild = await withMockedRandom(() => 0, () => action(moved.view, "Read here", "presentation-child"));
      expect(discoveredChild.view.presentation).toEqual({
        scene: { name: archive.name, description: archive.description },
        clues: [
          { name: parent.name, revelation: parent.revelation },
          { name: child.name, revelation: child.revelation },
        ],
      });

      const ended = await action(discoveredChild.view, "Go to another area", "presentation-exit");
      expect(ended.view).toMatchObject({ terminal: true });
      expect(ended.view.presentation).toEqual({
        scene: { name: exit.name, description: exit.description },
        clues: [
          { name: parent.name, revelation: parent.revelation },
          { name: child.name, revelation: child.revelation },
        ],
        ending: { name: clean.name, description: clean.description },
      });
      expect(ended.view.presentation).not.toHaveProperty("endings");
      for (const forbidden of [entryId, archiveId, exitId, parentId, childId, "sourceMap", "fieldPath", "statements", "evidence", "mechanismId", "npcIds"]) {
        expect(JSON.stringify(ended.view.presentation)).not.toContain(forbidden);
      }

      const stored = built.snapshots.read(built.sessionId);
      if (stored.status !== "ok") throw new Error(stored.message);
      const snapshot = checkedSnapshot(stored.value);
      const bundle = built.catalog.loadBundle(snapshot.bundle.id);
      if (bundle.status !== "ok") throw new Error(bundle.message);
      const restarted = new GameSession(built.sessionId, "cosmic-horror", undefined, undefined, undefined, undefined, { careerRoot: join(root, "careers") });
      expect(restarted.restoreCompiledSession(snapshot, bundle.value)).toMatchObject({ status: "loaded" });
      expect(restarted.getCompiledPlayerFacadeView().presentation).toEqual(ended.view.presentation);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("fails closed before reading creation data when the host assignment resolver is unavailable or malformed", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-facade-resolver-"));
    try {
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
      for (const resolver of [() => ({ status: "unavailable" as const }), () => ({ status: "assigned", principal: { role: "keeper", id: "forged" } } as any)]) {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          },
        }, { highWaterMark: 0 });
        const response = await (handleRequest as any)(
          new Request("http://test/api/sessions/compiled", { method: "POST", headers: { "Content-Type": "application/json" }, body }),
          catalog,
          snapshots,
          { careerRoot: join(root, "careers") },
          {},
          {},
          owner,
          undefined,
          resolver,
        );
        expect(response.status).toBe(503);
        expect(pulls).toBe(0);
        await expectOpaqueFacadeFailure(response);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps resolver-less compiled sessions owner-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-facade-owner-only-"));
    try {
      const built = await createPlayerAssignedSession(root, null);
      const base = `/api/sessions/${built.sessionId}`;
      expect((await runtime(built, `${base}/player-view`, owner)).status).toBe(200);
      const playerView = await runtime(built, `${base}/player-view`, player);
      expect(playerView.status).toBe(403);
      await expectOpaqueFacadeFailure(playerView);
      const stored = built.snapshots.read(built.sessionId);
      if (stored.status !== "ok") throw new Error(stored.message);
      expect(checkedSnapshot(stored.value).access?.playerGrant).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects mutations that drop or forge the durable player grant and choice key", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-facade-snapshot-"));
    try {
      const built = await createPlayerAssignedSession(root);
      const raw = built.snapshots.read(built.sessionId);
      if (raw.status !== "ok") throw new Error(raw.message);
      const rawSnapshot = checkedSnapshot(raw.value);
      for (const mutate of [
        (snapshot: any) => { snapshot.access.playerGrant = null; },
        (snapshot: any) => { snapshot.access.choiceHmacKey = "x".repeat(64); },
        (snapshot: any) => { snapshot.access.playerGrant.role = "keeper"; },
      ]) {
        const mutated = structuredClone(rawSnapshot) as any;
        mutate(mutated);
        mutated.snapshotHash = compiledSessionSnapshotHash(mutated);
        expect(validateCompiledSessionSnapshot(mutated)).toMatchObject({ status: "refused" });
      }

      const validButChanged = structuredClone(rawSnapshot) as any;
      validButChanged.access.choiceHmacKey = "a".repeat(64);
      validButChanged.generation = 1;
      validButChanged.previousSnapshotHash = rawSnapshot.snapshotHash;
      validButChanged.snapshotHash = compiledSessionSnapshotHash(validButChanged);
      expect(validateCompiledSessionSnapshot(validButChanged)).toMatchObject({ status: "ok" });
      // This is an adversarial low-level snapshot mutation, not a host
      // publication path.  Keep the HTTP-created store namespace-required;
      // a dedicated explicit standalone reader models an on-disk attacker
      // attempting the otherwise-valid, conflicting generation.
      const directMutationStore = new CompiledSessionSnapshotStore({
        root: join(root, "snapshots"),
        allowUncoordinatedTestWrites: true,
      });
      expect(directMutationStore.save(validButChanged)).toMatchObject({ status: "refused", code: "SNAPSHOT_CONFLICT" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
