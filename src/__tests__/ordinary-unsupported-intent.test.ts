import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CareerFileStore } from "../character/career-file";
import type { NormalSessionIntentClient } from "../llm/intent";

const CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://ordinary-unsupported.invalid/v1",
  model: "ordinary-unsupported-test",
  maxTokens: 32,
  temperature: 0,
};

type UnsupportedIntentCase = {
  input: string;
  reply: object;
  truth?: string;
  inventory?: readonly string[];
};

const UNSUPPORTED_INTENTS: readonly UnsupportedIntentCase[] = [
  { input: "equip knife", reply: { action: "equip", target: "knife" } },
  { input: "unequip knife", reply: { action: "unequip", target: "knife" } },
  { input: "use medical kit", reply: { action: "use_item", item: "medical kit" } },
  { input: "allocate my skills", reply: { action: "allocate_skills" } },
  { input: "reload", reply: { action: "reload" } },
  { input: "open shop", reply: { action: "shop" } },
  { input: "buy", reply: { action: "buy" }, truth: "你想买什么？请指定物品名称" },
  { input: "buy lantern", reply: { action: "buy", item: "lantern" }, truth: "这里没有可以交易的地方。（商店尚未实现）" },
  { input: "sell", reply: { action: "sell" }, truth: "你想卖什么？请指定物品名称" },
  { input: "sell lantern", reply: { action: "sell", item: "lantern" }, truth: "你的背包中没有「lantern」。当前背包：空" },
  { input: "sell lantern", reply: { action: "sell", item: "lantern" }, inventory: ["lantern"], truth: "你有「lantern」，但这里没有人收货。" },
  { input: "\u8bfb\u6863 Ada", reply: { action: "legacy" } },
];

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

describe("ordinary unsupported intent refusal", () => {
  test("required model intents refuse before round, game time, history, or state changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-unsupported-direct-"));
    const session = new GameSession(
      "ordinary-unsupported-direct",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      { careerRoot: join(root, "careers") },
      undefined,
      "required",
      { sessionIntentClient: queuedIntentClient(UNSUPPORTED_INTENTS.map(({ reply }) => reply)) },
    );
    try {
      for (const { input, truth, inventory } of UNSUPPORTED_INTENTS) {
        if (inventory) expect(session.setPlayerInventory(session.activePlayerId, [...inventory])).toBe(true);
        const before = snapshotDigest(session);
        const result = await session.act(input);

        expect(result.error).toEqual({ code: "ordinary_action_unsupported" });
        expect(result.narrative).toBe("");
        expect(result.events).toEqual(truth ? [{ speaker: "系统", content: truth, type: "system" }] : []);
        expect(snapshotDigest(session)).toBe(before);
      }
    } finally {
      session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy list and help remain executable while save needs a durable transaction and real load is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-legacy-nonload-"));
    const session = new GameSession(
      "ordinary-legacy-nonload",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      { careerRoot: join(root, "careers") },
      undefined,
      "required",
      { sessionIntentClient: queuedIntentClient([{ action: "legacy" }, { action: "legacy" }, { action: "legacy" }]) },
    );
    try {
      const beforeSave = snapshotDigest(session);
      const saved = await session.act("\u4fdd\u5b58\u89d2\u8272");
      expect(saved.error).toEqual({ code: "ordinary_durable_transaction_required" });
      expect(saved.events).toEqual([]);
      expect(snapshotDigest(session)).toBe(beforeSave);

      const listed = await session.act("\u4f20\u627f\u5217\u8868");
      expect(listed.error).toBeUndefined();
      expect(JSON.stringify(listed.events)).toContain("Ada");

      const help = await session.act("\u4f20\u627f\u5e2e\u52a9");
      expect(help.error).toBeUndefined();
      expect(JSON.stringify(help.events)).toContain("\u8bfb\u6863");
    } finally {
      session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("required module and spell-list intents read their installed truth sources", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-query-truth-"));
    const session = new GameSession(
      "ordinary-query-truth",
      "cosmic-horror",
      CONFIG,
      "investigator",
      "Ada",
      undefined,
      { careerRoot: join(root, "careers") },
      undefined,
      "required",
      { sessionIntentClient: queuedIntentClient([
        { action: "view_module" },
        { action: "view_module" },
        { action: "spell_list" },
        { action: "read" },
        { action: "spell_list" },
      ]) },
    );
    const originalRandom = Math.random;
    let restored: GameSession | undefined;
    try {
      const emptyView = await session.act("view module");
      expect(emptyView.events.map((event) => event.content).join("\n")).toContain("没有已安装的模组");
      await session.act("加载模块 印斯茅斯的阴影");
      const view = await session.act("view module");
      const viewText = view.events.filter((event) => event.type === "system").at(-1)?.content ?? "";
      expect(viewText).toContain("印斯茅斯");
      expect(viewText).toMatch(/^已安装模组：.+（版本 .+）$/);
      expect(viewText).not.toContain("innsmouth_shadow");
      expect(viewText).not.toContain("马萨诸塞");

      const emptySpellList = await session.act("show spells");
      expect(emptySpellList.events.map((event) => event.content).join("\n")).toContain("暂无已知法术");
      Math.random = () => 0;
      await session.act("阅读扎多克的低语");
      const knownSpell = session.exportOrdinarySessionSnapshot().state.knownMythosSpells[0];
      expect(knownSpell).toBeDefined();
      const spellList = await session.act("show spells");
      const spellListText = spellList.events.filter((event) => event.type === "system").at(-1)?.content ?? "";
      expect(spellListText).toContain(knownSpell!);
      expect(spellListText).not.toContain("尝试与深潜者");
      const snapshot = JSON.parse(JSON.stringify(session.exportOrdinarySessionSnapshot()));
      restored = new GameSession(
        "ordinary-query-truth", "cosmic-horror", CONFIG,
        undefined, undefined, undefined, { careerRoot: join(root, "restored-careers") }, undefined, "required",
        { sessionIntentClient: queuedIntentClient([{ action: "spell_list" }, { action: "view_module" }]) },
      );
      restored.restoreOrdinarySessionSnapshot(snapshot);
      const restoredSpellList = await restored.act("show spells");
      expect(restoredSpellList.events.map((event) => event.content).join("\n")).toContain(knownSpell!);
      const restoredView = await restored.act("view module");
      const restoredViewText = restoredView.events.filter((event) => event.type === "system").at(-1)?.content ?? "";
      expect(restoredViewText).toContain("印斯茅斯");
      expect(restoredViewText).not.toContain("innsmouth_shadow");
      expect(restoredViewText).not.toContain("马萨诸塞");
    } finally {
      Math.random = originalRandom;
      session.close();
      restored?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("durable HTTP refuses without publishing a generation or action receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-unsupported-http-"));
    const registry = new Map<string, GameSession>();
    const intentClient = queuedIntentClient(UNSUPPORTED_INTENTS.map(({ reply }) => reply));
    const dependencies: SessionRuntimeDependencies = {
      registry,
      ordinaryIntentPolicy: "required",
      ordinarySessionIntentClient: intentClient,
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, sessionIntentClient, runtimeDependencies }) => {
        const session = new GameSession(
          id,
          ruleset,
          CONFIG,
          archetypeId,
          characterName,
          persona,
          storage,
          access,
          intentPolicy,
          { ...runtimeDependencies, ...(sessionIntentClient ? { sessionIntentClient } : {}) },
        );
        session.getOpeningScene = async () => "offline opening";
        return session;
      },
    };
    const auth: CompilerRequestAuthenticator = () => ({
      status: "authenticated",
      principal: { role: "keeper", id: "ordinary-unsupported-owner" },
    });
    const request = (path: string, body?: unknown): Promise<Response> => handleRequest(
      new Request(`http://test${path}`, body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      dependencies,
    );

    try {
      const created = await request("/api/sessions", {
        ruleset: "cosmic-horror",
        archetype: "investigator",
        characterName: "Ada",
      });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      const source = registry.get(id);
      expect(source).toBeDefined();
      const before = snapshotDigest(source!);
      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });

      for (const [index, { input }] of UNSUPPORTED_INTENTS.entries()) {
        const actionId = `ordinary-unsupported-${String(index + 1).padStart(4, "0")}`;
        const response = await request(`/api/sessions/${id}/action`, {
          input,
          actionId,
          expectedGeneration: 0,
        });

        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ code: "ordinary_action_unsupported" });
        expect(registry.get(id)).toBe(source);
        expect(registry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 0 });
        expect(snapshotDigest(registry.get(id)!)).toBe(before);
        expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
        expect(snapshots.findActionReceipt(id, actionId)).toEqual({ status: "ok", value: null });
      }
    } finally {
      for (const session of registry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("durable HTTP refuses a legacy character load without inventing a g2 receipt or load result", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-legacy-load-http-"));
    const registry = new Map<string, GameSession>();
    const restartedRegistry = new Map<string, GameSession>();
    const intentClient = queuedIntentClient([{ action: "legacy" }]);
    const createSession: NonNullable<SessionRuntimeDependencies["createOrdinarySession"]> = (
      { id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, sessionIntentClient, runtimeDependencies },
    ) => {
      const session = new GameSession(
        id,
        ruleset,
        CONFIG,
        archetypeId,
        characterName,
        persona,
        storage,
        access,
        intentPolicy,
        { ...runtimeDependencies, ...(sessionIntentClient ? { sessionIntentClient } : {}) },
      );
      session.getOpeningScene = async () => "offline opening";
      return session;
    };
    const dependencies: SessionRuntimeDependencies = {
      registry,
      ordinaryIntentPolicy: "required",
      ordinarySessionIntentClient: intentClient,
      createOrdinarySession: createSession,
    };
    const restartedDependencies: SessionRuntimeDependencies = {
      registry: restartedRegistry,
      ordinaryIntentPolicy: "required",
      ordinarySessionIntentClient: intentClient,
      createOrdinarySession: createSession,
    };
    const auth: CompilerRequestAuthenticator = () => ({
      status: "authenticated",
      principal: { role: "keeper", id: "ordinary-legacy-load-owner" },
    });
    const request = (runtime: SessionRuntimeDependencies, path: string, body?: unknown): Promise<Response> => handleRequest(
      new Request(`http://test${path}`, body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      const created = await request(dependencies, "/api/sessions", {
        ruleset: "cosmic-horror",
        archetype: "investigator",
        characterName: "Ada",
      });
      expect(created.status).toBe(201);
      const id = (await created.json() as { sessionId: string }).sessionId;
      const g0 = registry.get(id);
      if (!g0) throw new Error("creation must install an ordinary g0 session");
      const originalHp = g0.getCharacterSummary().hp;
      if (!Number.isSafeInteger(originalHp)) throw new Error("fixture requires an integer g0 HP");
      const careerStore = new CareerFileStore(join(root, "careers", id));
      const careerBaseline = careerStore.getSnapshot("Ada");
      expect(careerBaseline).toMatchObject({ characterName: "Ada", hp: originalHp });

      const currentHp = originalHp === 0 ? 1 : originalHp - 1;
      const patched = await request(dependencies, `/api/sessions/${id}/character`, {
        actionId: "ordinary-legacy-load-patch-0001",
        expectedGeneration: 0,
        hp: currentHp,
      });
      expect(patched.status).toBe(200);
      const g1 = registry.get(id);
      if (!g1) throw new Error("character patch must install g1");
      expect(g1.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
      expect(g1.getCharacterSummary().hp).toBe(currentHp);

      const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
      const beforeSnapshot = snapshotDigest(g1);
      const beforeState = g1.getState();
      const beforeRound = g1.round;
      const beforeTime = g1.getState().gameTime;
      const beforeHistory = g1.getHistory().total;
      const beforeLastActiveAt = g1.lastActiveAt;
      const loadActionId = "ordinary-legacy-load-action-0001";
      const loaded = await request(dependencies, `/api/sessions/${id}/action`, {
        input: "\u8bfb\u6863 Ada",
        actionId: loadActionId,
        expectedGeneration: 1,
      });

      expect(loaded.status).toBe(422);
      const refusal = await loaded.json();
      expect(refusal).toEqual({ code: "ordinary_action_unsupported" });
      expect(JSON.stringify(refusal)).not.toContain("\u5df2\u52a0\u8f7d");
      expect(registry.get(id)).toBe(g1);
      expect(g1.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
      expect(g1.getCharacterSummary().hp).toBe(currentHp);
      expect(g1.getState()).toEqual(beforeState);
      expect(g1.round).toBe(beforeRound);
      expect(g1.getState().gameTime).toEqual(beforeTime);
      expect(g1.getHistory().total).toBe(beforeHistory);
      expect(g1.lastActiveAt).toBe(beforeLastActiveAt);
      expect(snapshotDigest(g1)).toBe(beforeSnapshot);
      expect(careerStore.getSnapshot("Ada")).toEqual(careerBaseline);
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(snapshots.findActionReceipt(id, loadActionId)).toEqual({ status: "ok", value: null });

      const resumed = await request(restartedDependencies, `/api/sessions/${id}`);
      expect(resumed.status).toBe(200);
      const afterRestart = restartedRegistry.get(id);
      if (!afterRestart) throw new Error("GET must rehydrate the current ordinary session");
      expect(afterRestart.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
      expect(afterRestart.getCharacterSummary().hp).toBe(currentHp);
      const restoredSnapshot = afterRestart.exportOrdinarySessionSnapshot();
      expect(restoredSnapshot.state.characters.find((entry) => entry.pcId === "p1")?.sheet).toMatchObject({ hp: currentHp });
      expect(restoredSnapshot.world.tables.entities.find((entry) => entry.id === "p1")).toMatchObject({ hp: currentHp });
    } finally {
      for (const session of registry.values()) session.close();
      for (const session of restartedRegistry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
