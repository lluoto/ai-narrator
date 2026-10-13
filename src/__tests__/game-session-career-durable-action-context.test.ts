import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession, type ActionResponse } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CareerFileStore } from "../character/career-file";
import type { NormalSessionIntentClient } from "../llm/intent";

const CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://career-durable-action-context.invalid/v1",
  model: "career-durable-action-context",
  maxTokens: 32,
  temperature: 0,
};

const auth: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "keeper", id: "career-durable-action-context-owner" },
});

function queuedIntentClient(replies: ReadonlyArray<object>): NormalSessionIntentClient {
  let index = 0;
  return {
    async chat() {
      const reply = replies[index++];
      if (!reply) throw new Error("unexpected intent request");
      return JSON.stringify(reply);
    },
  };
}

function snapshotDigest(session: GameSession): string {
  return JSON.stringify(session.exportOrdinarySessionSnapshot());
}

function careerDigest(session: GameSession): string {
  return JSON.stringify(session.careerStore?.exportPortableProjection() ?? null);
}

async function expectDirectCareerWriteRefused(session: GameSession, input: string): Promise<void> {
  const beforeSnapshot = snapshotDigest(session);
  const beforeState = session.getState();
  const beforeRound = session.round;
  const beforeHistory = session.getHistory();
  const beforeLastActiveAt = session.lastActiveAt;
  const beforeCareer = careerDigest(session);

  const response = await session.act(input);

  expect(response.error).toEqual({ code: "ordinary_durable_transaction_required" });
  expect(response.events).toEqual([]);
  expect(session.getState()).toEqual(beforeState);
  expect(session.round).toBe(beforeRound);
  expect(session.getHistory()).toEqual(beforeHistory);
  expect(session.lastActiveAt).toBe(beforeLastActiveAt);
  expect(snapshotDigest(session)).toBe(beforeSnapshot);
  expect(careerDigest(session)).toBe(beforeCareer);
}

test("direct Career-writing actions fail closed before state, time, history, or Career changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "career-durable-direct-refusal-"));
  const sessions: GameSession[] = [];
  try {
    const legacy = new GameSession(
      "career-durable-direct-legacy",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      { careerRoot: join(root, "legacy") },
      undefined,
      "required",
      { sessionIntentClient: queuedIntentClient([{ action: "legacy" }]) },
    );
    sessions.push(legacy);
    await expectDirectCareerWriteRefused(legacy, "\u4fdd\u5b58\u89d2\u8272");

    const creation = new GameSession(
      "career-durable-direct-create",
      "cosmic-horror",
      CONFIG,
      undefined,
      undefined,
      undefined,
      { careerRoot: join(root, "creation") },
      undefined,
      "required",
      { sessionIntentClient: queuedIntentClient([{ action: "create_character" }]) },
    );
    sessions.push(creation);
    await expectDirectCareerWriteRefused(creation, "\u521b\u5efa\u89d2\u8272 investigator Ada");

    const recruit = new GameSession(
      "career-durable-direct-recruit",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      { careerRoot: join(root, "recruit") },
      undefined,
      "development_fallback",
    );
    sessions.push(recruit);
    await expectDirectCareerWriteRefused(recruit, "\u521b\u5efa\u961f\u53cb Bea investigator");

    const departure = new GameSession(
      "career-durable-direct-departure",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      { careerRoot: join(root, "departure") },
      undefined,
      "development_fallback",
    );
    sessions.push(departure);
    expect((await departure.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3")).error).toBeUndefined();
    expect((await departure.act("\u6a21\u7ec4\u7ed3\u7b97")).error).toBeUndefined();
    await expectDirectCareerWriteRefused(departure, "\u786e\u5b9a");
  } finally {
    for (const session of sessions) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("nonwriting legacy/create dispatches and nonlegacy save mentions are not overblocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "career-durable-nonwriting-"));
  const sessions: GameSession[] = [];
  try {
    const noCharacter = new GameSession(
      "career-durable-no-character-save",
      "cosmic-horror",
      CONFIG,
      undefined,
      undefined,
      undefined,
      { careerRoot: join(root, "no-character") },
      undefined,
      "required",
      { sessionIntentClient: queuedIntentClient([{ action: "legacy" }]) },
    );
    sessions.push(noCharacter);
    const noCharacterSave = await noCharacter.act("\u4fdd\u5b58\u89d2\u8272");
    expect(noCharacterSave.error).toBeUndefined();
    expect(JSON.stringify(noCharacterSave.events)).toContain("\u6ca1\u6709\u6d3b\u8dc3\u89d2\u8272");
    expect(noCharacter.careerStore).toBeNull();

    const invalidCreation = new GameSession(
      "career-durable-invalid-creation",
      "cosmic-horror",
      CONFIG,
      undefined,
      undefined,
      undefined,
      { careerRoot: join(root, "invalid-creation") },
      undefined,
      "required",
      { sessionIntentClient: queuedIntentClient([{ action: "create_character" }]) },
    );
    sessions.push(invalidCreation);
    const invalidResult = await invalidCreation.act("\u521b\u5efa\u89d2\u8272 unknown Ada");
    expect(invalidResult.error).toBeUndefined();
    expect(JSON.stringify(invalidResult.events)).toContain("\u521b\u5efa\u5931\u8d25");
    expect(invalidCreation.careerStore).toBeNull();

    const saveMention = new GameSession(
      "career-durable-save-mention",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      { careerRoot: join(root, "save-mention") },
      undefined,
      "required",
      { sessionIntentClient: queuedIntentClient([{ action: "talk" }]) },
    );
    sessions.push(saveMention);
    expect((await saveMention.act("\u8bf7\u89e3\u91ca\u5982\u4f55\u4fdd\u5b58\u89d2\u8272")).error).toBeUndefined();
  } finally {
    for (const session of sessions) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("transient hosts keep direct creation and recruit in memory without a Career write", async () => {
  const root = mkdtempSync(join(tmpdir(), "career-durable-transient-create-"));
  const sessions: GameSession[] = [];
  try {
    const creation = new GameSession(
      "career-durable-transient-create",
      "cosmic-horror",
      CONFIG,
      undefined,
      undefined,
      undefined,
      { careerRoot: join(root, "creation") },
      undefined,
      "development_fallback",
      { careerEntryPersistence: "transient" },
    );
    sessions.push(creation);
    expect((await creation.act("\u521b\u5efa\u89d2\u8272 investigator Ada")).error).toBeUndefined();
    expect(creation.getCharacterSummary()).toMatchObject({ name: "Ada" });
    expect(creation.careerStore).toBeNull();

    const recruit = new GameSession(
      "career-durable-transient-recruit",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      { careerRoot: join(root, "recruit") },
      undefined,
      "development_fallback",
      { careerEntryPersistence: "transient" },
    );
    sessions.push(recruit);
    expect((await recruit.act("\u521b\u5efa\u961f\u53cb Bea investigator")).error).toBeUndefined();
    expect(recruit.world.getCurrentState().entities.p2).toMatchObject({ name: "Bea", type: "pc" });
    expect(recruit.careerStore).toBeNull();
  } finally {
    for (const session of sessions) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("signed transient snapshots retain runtime characters without claiming or manufacturing Career authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "career-durable-transient-snapshot-"));
  const id = "career-durable-transient-snapshot";
  const sourceCareerRoot = join(root, "source-careers");
  const targetCareerRoot = join(root, "target-careers");
  const durableCareerRoot = join(root, "durable-careers");
  const transientRuntime = { careerEntryPersistence: "transient" } as const;
  const source = new GameSession(
    id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
    { careerRoot: sourceCareerRoot }, undefined, "development_fallback", transientRuntime,
  );
  const target = new GameSession(
    id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
    { careerRoot: targetCareerRoot }, undefined, "development_fallback", transientRuntime,
  );
  const durableTarget = new GameSession(
    id, "cosmic-horror", CONFIG, undefined, undefined, undefined,
    { careerRoot: durableCareerRoot }, undefined, "development_fallback",
  );
  try {
    expect((await source.act("创建角色 investigator Ada")).error).toBeUndefined();
    expect(source.careerStore).toBeNull();

    const snapshot = source.exportOrdinarySessionSnapshot();
    expect(snapshot.career.mode).toBe("transient");
    expect(source.careerStore).toBeNull();
    expect(existsSync(join(sourceCareerRoot, id))).toBe(false);

    target.restoreOrdinarySessionSnapshot(snapshot);
    expect(target.getCharacterSummary()).toMatchObject({ name: "Ada" });
    expect(target.exportOrdinarySessionSnapshot().state.characters).toEqual(snapshot.state.characters);
    expect(target.careerStore).toBeNull();
    expect(existsSync(join(targetCareerRoot, id))).toBe(false);

    expect(() => durableTarget.restoreOrdinarySessionSnapshot(snapshot)).toThrow("transient Career snapshot");
    expect(durableTarget.careerStore).toBeNull();
    expect(existsSync(join(durableCareerRoot, id))).toBe(false);
  } finally {
    source.close();
    target.close();
    durableTarget.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a public transaction wrapper or same-name shadow cannot establish the durable Career context", async () => {
  const root = mkdtempSync(join(tmpdir(), "career-durable-public-wrapper-"));
  const makeSession = (id: string) => new GameSession(
    id,
    "cosmic-horror",
    CONFIG,
    "investigator",
    "Ada",
    undefined,
    { careerRoot: root },
    undefined,
    "required",
    { sessionIntentClient: queuedIntentClient([{ action: "legacy" }]) },
  );
  const directWrapper = makeSession("career-durable-public-wrapper");
  const shadowedWrapper = makeSession("career-durable-shadowed-wrapper");
  try {
    const beforeDirect = snapshotDigest(directWrapper);
    const wrapperResponse = await directWrapper.runExclusiveActionTransaction(async (act) => act("\u4fdd\u5b58\u89d2\u8272"));
    expect(wrapperResponse.error).toEqual({ code: "ordinary_durable_transaction_required" });
    expect(snapshotDigest(directWrapper)).toBe(beforeDirect);

    Object.defineProperty(shadowedWrapper, "runExclusiveActionTransaction", {
      configurable: true,
      value: async (operation: (act: (input: string) => Promise<ActionResponse>) => Promise<ActionResponse>) =>
        operation((input) => shadowedWrapper.act(input)),
    });
    const beforeShadow = snapshotDigest(shadowedWrapper);
    const shadowResponse = await (shadowedWrapper as unknown as {
      runExclusiveActionTransaction: (operation: (act: (input: string) => Promise<ActionResponse>) => Promise<ActionResponse>) => Promise<ActionResponse>;
    }).runExclusiveActionTransaction(async (act) => act("\u4fdd\u5b58\u89d2\u8272"));
    expect(shadowResponse.error).toEqual({ code: "ordinary_durable_transaction_required" });
    expect(snapshotDigest(shadowedWrapper)).toBe(beforeShadow);
  } finally {
    directWrapper.close();
    shadowedWrapper.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted durable HTTP staging commits Career save, creation, and departure receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "career-durable-http-context-"));
  const registry = new Map<string, GameSession>();
  const dependencies: SessionRuntimeDependencies = {
    registry,
    ordinaryIntentPolicy: "development_fallback",
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
      const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
      session.getOpeningScene = async () => "opening";
      return session;
    },
  };
  const request = (path: string, body?: unknown, runtime: SessionRuntimeDependencies = dependencies): Promise<Response> => handleRequest(
    new Request(`http://test${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    undefined,
    undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {},
    {},
    auth,
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    runtime,
  );
  const create = async (body: Record<string, unknown>): Promise<string> => {
    const response = await request("/api/sessions", body);
    expect(response.status).toBe(201);
    return (await response.json() as { sessionId: string }).sessionId;
  };
  const action = async (id: string, input: string, actionId: string, expectedGeneration: number): Promise<void> => {
    const response = await request(`/api/sessions/${id}/action`, { input, actionId, expectedGeneration });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Ordinary-Action-Disposition")).toBe("committed");
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: expectedGeneration + 1 } });
    expect(snapshots.findActionReceipt(id, actionId)).toMatchObject({ status: "ok", value: { generation: expectedGeneration + 1 } });
  };
  try {
    const savedId = await create({ archetype: "investigator", characterName: "Ada" });
    await action(savedId, "\u4fdd\u5b58\u89d2\u8272", "career-durable-save-0001", 0);
    expect(new CareerFileStore(join(root, "careers", savedId)).getSnapshot("Ada")).toMatchObject({ characterName: "Ada" });

    const creationId = await create({});
    await action(creationId, "\u521b\u5efa\u89d2\u8272 investigator Bea", "career-durable-create-0001", 0);
    expect(new CareerFileStore(join(root, "careers", creationId)).getSnapshot("Bea")).toMatchObject({ characterName: "Bea" });

    const departureId = await create({ archetype: "investigator", characterName: "Cia" });
    await action(departureId, "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3", "career-durable-load-0001", 0);
    await action(departureId, "\u6a21\u7ec4\u7ed3\u7b97", "career-durable-leave-0002", 1);
    await action(departureId, "\u786e\u5b9a", "career-durable-confirm-0003", 2);
    expect(new CareerFileStore(join(root, "careers", departureId)).getEntries("Cia")).toHaveLength(1);
  } finally {
    for (const session of registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("durable legacy save keeps SAN, Career base, disk, and rehydration CM in lockstep", async () => {
  const root = mkdtempSync(join(tmpdir(), "career-durable-save-mythos-"));
  const registry = new Map<string, GameSession>();
  const restartedRegistry = new Map<string, GameSession>();
  const dependencies: SessionRuntimeDependencies = {
    registry,
    ordinaryIntentPolicy: "development_fallback",
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
      const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
      session.getOpeningScene = async () => "opening";
      return session;
    },
  };
  const request = (path: string, body?: unknown, runtime: SessionRuntimeDependencies = dependencies): Promise<Response> => handleRequest(
    new Request(`http://test${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    undefined,
    undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {},
    {},
    auth,
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    runtime,
  );
  const action = async (id: string, input: string, actionId: string, expectedGeneration: number): Promise<void> => {
    const response = await request(`/api/sessions/${id}/action`, { input, actionId, expectedGeneration });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Ordinary-Action-Disposition")).toBe("committed");
  };
  const originalRandom = Math.random;
  try {
    const created = await request("/api/sessions", { archetype: "investigator", characterName: "Ada" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { sessionId: string }).sessionId;
    await action(id, "加载模组 阿卡姆档案检查", "career-mythos-load-0001", 0);
    await action(id, "前往 arkham_library_vault", "career-mythos-vault-0002", 1);
    const draws = [0, 0, 0, 0.9, 0.8];
    Math.random = () => draws.shift() ?? 0.99;
    await action(id, "阅读塞拉伊诺断章", "career-mythos-read-0003", 2);
    Math.random = originalRandom;
    const liveSanity = registry.get(id)?.exportOrdinarySessionSnapshot().state.sanities
      .find((entry) => entry.pcId === "p1")?.state as { cthulhuMythos?: unknown } | undefined;
    expect(liveSanity?.cthulhuMythos).toBe(8);
    await action(id, "保存角色", "career-mythos-save-0004", 3);

    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const persisted = snapshots.read(id);
    if (persisted.status !== "ok") throw new Error("durable save must publish an ordinary envelope");
    expect(persisted.value.generation).toBe(4);
    const snapshotSanity = persisted.value.snapshot.state.sanities.find((entry) => entry.pcId === "p1")?.state as { cthulhuMythos?: unknown } | undefined;
    expect(snapshotSanity?.cthulhuMythos).toBe(8);
    if (!("career" in persisted.value.snapshot) || persisted.value.snapshot.career.mode !== "complete") {
      throw new Error("durable save must retain a complete Career projection");
    }
    expect(persisted.value.snapshot.career.projection.records.find((record) => record.characterName === "Ada")?.base?.cthulhuMythos).toBe(8);
    expect(new CareerFileStore(join(root, "careers", id)).getSnapshot("Ada")?.cthulhuMythos).toBe(8);

    const restartedDependencies: SessionRuntimeDependencies = { ...dependencies, registry: restartedRegistry };
    const resumed = await request(`/api/sessions/${id}`, undefined, restartedDependencies);
    expect(resumed.status).toBe(200);
    const rehydrated = restartedRegistry.get(id);
    const rehydratedSanity = rehydrated?.exportOrdinarySessionSnapshot().state.sanities
      .find((entry) => entry.pcId === "p1")?.state as { cthulhuMythos?: unknown } | undefined;
    expect(rehydratedSanity?.cthulhuMythos).toBe(8);
    const rehydratedCareer = rehydrated?.exportOrdinarySessionSnapshot().career;
    expect(rehydratedCareer?.mode === "complete"
      ? rehydratedCareer.projection.records.find((record) => record.characterName === "Ada")?.base?.cthulhuMythos
      : undefined).toBe(8);
  } finally {
    Math.random = originalRandom;
    for (const session of registry.values()) session.close();
    for (const session of restartedRegistry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("durable legacy save refuses an entry-bearing Career without a generation, receipt, or rebase", async () => {
  const root = mkdtempSync(join(tmpdir(), "career-durable-save-rebase-"));
  const registry = new Map<string, GameSession>();
  const restartedRegistry = new Map<string, GameSession>();
  const dependencies: SessionRuntimeDependencies = {
    registry,
    ordinaryIntentPolicy: "development_fallback",
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
      const session = new GameSession(id, ruleset, CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
      if (characterName === "Ada") {
        if (!storage.careerRoot) throw new Error("durable Career test requires a career root");
        new CareerFileStore(join(storage.careerRoot, id)).addEntry({
          id: "seeded-career-entry",
          characterName: "Ada",
          moduleId: "seeded-module",
          moduleName: "Seeded module",
          completedAt: "2026-01-01T00:00:00.000Z",
          endingId: "seeded-ending",
          endingName: "Seeded ending",
          sanChange: 0,
          cmChange: 0,
          reputationChange: 0,
          skillChanges: [],
          rewardIds: [],
          narrative: "A pre-existing durable career entry.",
        });
      }
      session.getOpeningScene = async () => "opening";
      return session;
    },
  };
  const request = (path: string, body?: unknown, runtime: SessionRuntimeDependencies = dependencies): Promise<Response> => handleRequest(
    new Request(`http://test${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    undefined,
    undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {},
    {},
    auth,
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    runtime,
  );
  try {
    const created = await request("/api/sessions", { archetype: "investigator", characterName: "Ada" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { sessionId: string }).sessionId;

    const source = registry.get(id);
    if (!source) throw new Error("session creation must leave a durable source session");
    const beforeSnapshot = snapshotDigest(source);
    const career = new CareerFileStore(join(root, "careers", id));
    const beforeCareer = JSON.stringify(career.exportPortableProjection());
    expect(career.getEntries("Ada")).toHaveLength(1);
    const sourceCareer = source.exportOrdinarySessionSnapshot().career;
    expect(sourceCareer.mode === "complete"
      ? sourceCareer.projection.records.find((record) => record.characterName === "Ada")?.entries
      : []).toHaveLength(1);
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });

    const saveActionId = "career-rebase-save-0001";
    const rejected = await request(`/api/sessions/${id}/action`, {
      input: "保存角色", actionId: saveActionId, expectedGeneration: 0,
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({ code: "ordinary_career_rebase_unsupported" });
    expect(registry.get(id)).toBe(source);
    expect(snapshotDigest(registry.get(id)!)).toBe(beforeSnapshot);
    expect(JSON.stringify(career.exportPortableProjection())).toBe(beforeCareer);
    expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
    expect(snapshots.findActionReceipt(id, saveActionId)).toEqual({ status: "ok", value: null });

    const restartedDependencies: SessionRuntimeDependencies = { ...dependencies, registry: restartedRegistry };
    const resumed = await request(`/api/sessions/${id}`, undefined, restartedDependencies);
    expect(resumed.status).toBe(200);
    expect(restartedRegistry.get(id)!.exportOrdinarySessionSnapshot()).toEqual(source.exportOrdinarySessionSnapshot());
    expect(JSON.stringify(new CareerFileStore(join(root, "careers", id)).exportPortableProjection())).toBe(beforeCareer);
  } finally {
    for (const session of registry.values()) session.close();
    for (const session of restartedRegistry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
