import { expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import {
  ordinaryGameSessionSnapshotHash,
  validateOrdinaryGameSessionSnapshot,
  type OrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";
import { worldStateSnapshotHash } from "../state/world-state-snapshot";
import { normalizeRuntimeModulePickupOrigins } from "../module/runtime-types";
import { llmParseIntent, type NormalSessionIntentClient } from "../llm/intent";
import { patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";

const OFFLINE_LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 1,
  temperature: 0,
};

function session(id: string, sessionIntentClient?: NormalSessionIntentClient): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    OFFLINE_LLM,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "preferred",
    sessionIntentClient ? { sessionIntentClient } : {},
  );
}

function restoreTarget(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", OFFLINE_LLM);
}

function preCharacterSession(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", OFFLINE_LLM);
}

function eventText(response: Awaited<ReturnType<GameSession["act"]>>): string {
  return response.events.map((event) => event.content).join("\n");
}

function currentSceneItems(value: GameSession): string[] {
  return (value.getKPState() as { sceneItems: string[] }).sceneItems;
}

function sceneItemsInSnapshot(snapshot: OrdinaryGameSessionSnapshot, sceneId: string): string[] {
  return snapshot.state.sceneItems.find((entry) => entry.sceneId === sceneId)?.items ?? [];
}

function resign(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function resignWorld(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { hash: _discarded, ...unsigned } = snapshot.world;
  snapshot.world = { ...unsigned, hash: worldStateSnapshotHash(unsigned) };
  return resign(snapshot);
}

async function loadBarnAndEnterBedroom(value: GameSession): Promise<void> {
  expect((await value.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
  expect((await value.act("前往 艾德里安的卧室")).error).toBeUndefined();
  expect(value.getPlayerPosition()).toBe("艾德里安的卧室");
  expect(currentSceneItems(value)).toContain("老旧文件");
}

test("a real pickup transfers only the current package-declared item into canonical inventory", async () => {
  const value = session(`ordinary-pickup-red-${crypto.randomUUID()}`);
  try {
    await loadBarnAndEnterBedroom(value);

    const response = await value.act("捡起 老旧文件");

    expect(eventText(response)).toContain("老旧文件");
    expect(value.world.getPlayerInventory("p1")).toContain("老旧文件");
    expect(currentSceneItems(value)).not.toContain("老旧文件");
  } finally {
    value.close();
  }
});

test("model pickup uses only its exact item field and never treats target or arbitrary prose as an item source", async () => {
  let injectedReply: Record<string, unknown> | undefined;
  const value = session(`ordinary-pickup-model-item-${crypto.randomUUID()}`, {
    chat: async (messages) => {
      const input = messages.at(-1)?.content ?? "";
      return JSON.stringify(injectedReply ?? llmParseIntent(input));
    },
  });
  try {
    await loadBarnAndEnterBedroom(value);
    injectedReply = { action: "pickup", target: "老旧文件" };
    const targetOnly = await value.act("请处理那个目标");
    expect(eventText(targetOnly)).toContain("明确指定");
    expect(value.world.getPlayerInventory("p1")).not.toContain("老旧文件");
    expect(currentSceneItems(value)).toContain("老旧文件");

    injectedReply = { action: "pickup", item: "老旧文件", target: "伪造目标" };
    const exactItem = await value.act("模型已经识别了拾取动作");
    expect(eventText(exactItem)).toContain("老旧文件");
    expect(value.world.getPlayerInventory("p1")).toContain("老旧文件");
    expect(currentSceneItems(value)).not.toContain("老旧文件");
  } finally {
    value.close();
  }
});

test("pickup rejects remote, duplicate, unknown, other-package, and trap names without changing physical state", async () => {
  const value = session(`ordinary-pickup-reject-${crypto.randomUUID()}`);
  try {
    expect((await value.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const entryItems = [...currentSceneItems(value)];
    const entryInventory = value.world.getPlayerInventory("p1");

    const remote = await value.act("捡起 老旧文件");
    expect(eventText(remote)).toContain("老旧文件");
    expect(value.world.getPlayerInventory("p1")).toEqual(entryInventory);
    expect(currentSceneItems(value)).toEqual(entryItems);

    const otherPackage = await value.act("捡起 大衮教团徽章");
    expect(eventText(otherPackage)).toContain("大衮教团徽章");
    expect(value.world.getPlayerInventory("p1")).toEqual(entryInventory);
    expect(currentSceneItems(value)).toEqual(entryItems);

    const unknown = await value.act("捡起 不存在的物品");
    expect(eventText(unknown)).toContain("不存在的物品");
    expect(value.world.getPlayerInventory("p1")).toEqual(entryInventory);
    expect(currentSceneItems(value)).toEqual(entryItems);

    await loadBarnAndEnterBedroom(value);
    expect((await value.act("捡起 老旧文件")).error).toBeUndefined();
    const afterPickup = {
      inventory: value.world.getPlayerInventory("p1"),
      sceneItems: currentSceneItems(value),
    };
    const duplicate = await value.act("捡起 老旧文件");
    expect(eventText(duplicate)).toContain("老旧文件");
    expect({ inventory: value.world.getPlayerInventory("p1"), sceneItems: currentSceneItems(value) }).toEqual(afterPickup);

    expect((await value.act("前往 农场外围")).error).toBeUndefined();
    expect(value.getPlayerPosition()).toBe("农场外围");
    expect(currentSceneItems(value)).toContain("捕兽夹");
    const beforeTrap = {
      inventory: value.world.getPlayerInventory("p1"),
      sceneItems: currentSceneItems(value),
    };
    const trap = await value.act("捡起 捕兽夹");
    expect(eventText(trap)).toContain("捕兽夹");
    expect({ inventory: value.world.getPlayerInventory("p1"), sceneItems: currentSceneItems(value) }).toEqual(beforeTrap);
  } finally {
    value.close();
  }
});

test("legacy placements and rich key/document/weapon/loot declarations share one package origin contract", () => {
  const origins = normalizeRuntimeModulePickupOrigins({
    itemPlacements: [
      { name: "旧钥匙", sceneId: "门厅" },
      { name: "档案", sceneId: "书房" },
    ],
    richItems: [
      { id: "key", name: "旧钥匙", sceneId: "门厅", description: "钥匙", type: "key" },
      { id: "document", name: "档案", sceneId: "书房", description: "档案", type: "document" },
      { id: "weapon", name: "猎枪", sceneId: "武器柜", description: "猎枪", type: "weapon" },
      { id: "loot", name: "硬币", sceneId: "保险箱", description: "硬币", type: "loot" },
      { id: "trap", name: "捕兽夹", sceneId: "走廊", description: "陷阱", type: "trap" },
    ],
  });
  expect(origins).toEqual([
    { name: "旧钥匙", sceneId: "门厅" },
    { name: "档案", sceneId: "书房" },
    { name: "猎枪", sceneId: "武器柜" },
    { name: "硬币", sceneId: "保险箱" },
  ]);

  expect(() => normalizeRuntimeModulePickupOrigins({
    richItems: [
      { id: "one", name: "重名", sceneId: "甲", description: "x", type: "key" },
      { id: "two", name: "重名", sceneId: "乙", description: "x", type: "key" },
    ],
  })).toThrow("location conflicts");
  expect(() => normalizeRuntimeModulePickupOrigins({
    richItems: [
      { id: "one", name: "冲突", sceneId: "甲", description: "x", type: "key" },
      { id: "two", name: "冲突", sceneId: "甲", description: "x", type: "trap" },
    ],
  })).toThrow("semantics conflict");
});

test("an existing player item with a package origin name rejects installation before any host scene write", async () => {
  const value = session(`ordinary-pickup-origin-collision-${crypto.randomUUID()}`);
  try {
    expect(value.setPlayerInventory("p1", ["老旧文件"])).toBe(true);
    const response = await value.act("加载模组 普瑞米尔的谷仓");
    expect(eventText(response)).toContain("runtime pickup origin already exists");
    expect(value.world.getScene("艾德里安的卧室")).toBeNull();
    expect((value.getKPState() as { module: unknown }).module).toBeNull();
    expect(value.world.getPlayerInventory("p1")).toEqual(["老旧文件"]);
  } finally {
    value.close();
  }
});

test("a pre-character ordinary session restores an installed real pickup package before any pickup occurs", async () => {
  const id = `ordinary-pickup-pre-character-${crypto.randomUUID()}`;
  const source = preCharacterSession(id);
  const packageSource = session(id);
  const restored = restoreTarget(id);
  const foreignStateTarget = restoreTarget(id);
  try {
    // Public loading necessarily moves a character to the package entry. Build
    // the valid pre-character portable fixture from two public snapshots: an
    // empty placeholder supplies player/career state and a real loaded session
    // supplies the package-owned static projection.
    expect((await packageSource.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const rawSnapshot = structuredClone(source.exportOrdinarySessionSnapshot());
    const installed = packageSource.exportOrdinarySessionSnapshot();
    rawSnapshot.module = structuredClone(installed.module);
    rawSnapshot.world = structuredClone(installed.world);
    rawSnapshot.world.tables.entities = rawSnapshot.world.tables.entities.filter((entity) => entity.type !== "pc");
    rawSnapshot.world.tables.player_state = structuredClone(source.exportOrdinarySessionSnapshot().world.tables.player_state);
    rawSnapshot.npcStore = structuredClone(installed.npcStore);
    rawSnapshot.agentRegistry = structuredClone(installed.agentRegistry);
    Object.assign(rawSnapshot.state, {
      sceneItems: structuredClone(installed.state.sceneItems),
      sceneDisplayNames: structuredClone(installed.state.sceneDisplayNames),
      sceneAliases: structuredClone(installed.state.sceneAliases),
      sceneBgm: structuredClone(installed.state.sceneBgm),
      mythosSpells: structuredClone(installed.state.mythosSpells),
      moduleItemDescriptions: structuredClone(installed.state.moduleItemDescriptions),
      moduleKpNotes: structuredClone(installed.state.moduleKpNotes),
      moduleRewards: structuredClone(installed.state.moduleRewards),
      knownMythosSpells: structuredClone(installed.state.knownMythosSpells),
    });
    const snapshot = resignWorld(rawSnapshot);
    expect(snapshot.module.package).not.toBeNull();
    expect(snapshot.state.characters).toEqual([]);
    expect(snapshot.world.tables.player_state.map((state) => state.entity_id)).toEqual(["p1"]);
    expect(snapshot.playerSession.players.map((player) => ({ name: player.name, characterId: player.characterId })))
      .toEqual([{ name: "p1", characterId: "p1" }]);

    expect(validateOrdinaryGameSessionSnapshot(snapshot)).toEqual(snapshot);
    expect(() => restored.restoreOrdinarySessionSnapshot(snapshot)).not.toThrow();
    const afterRestore = restored.exportOrdinarySessionSnapshot();
    expect(afterRestore.state.characters).toEqual([]);
    expect(afterRestore.world.tables.player_state.map((state) => state.entity_id)).toEqual(["p1"]);
    expect(afterRestore.state.sceneItems).toEqual(snapshot.state.sceneItems);

    const foreignState = structuredClone(snapshot);
    const p1State = foreignState.world.tables.player_state.find((state) => state.entity_id === "p1");
    if (!p1State) throw new Error("fixture lacks p1 player state");
    foreignState.world.tables.player_state.push({
      ...p1State,
      rowid: Math.max(...foreignState.world.tables.player_state.map((state) => state.rowid)) + 1,
      entity_id: "foreign-player",
    });
    const signedForeignState = resignWorld(foreignState);
    const beforeRejectedRestore = foreignStateTarget.exportOrdinarySessionSnapshot();
    expect(() => validateOrdinaryGameSessionSnapshot(signedForeignState))
      .toThrow("world player-state identities disagree with PlayerSession");
    expect(() => foreignStateTarget.restoreOrdinarySessionSnapshot(signedForeignState))
      .toThrow("world player-state identities disagree with PlayerSession");
    expect(foreignStateTarget.exportOrdinarySessionSnapshot()).toEqual(beforeRejectedRestore);
  } finally {
    source.close();
    packageSource.close();
    restored.close();
    foreignStateTarget.close();
  }
});

test("a real legacy-module item can be picked up only from its installed scene", async () => {
  const value = session(`ordinary-pickup-legacy-${crypto.randomUUID()}`);
  try {
    expect((await value.act("加载模组 印斯茅斯的阴影")).error).toBeUndefined();
    expect((await value.act("前往 innsmouth_church")).error).toBeUndefined();
    expect(value.getPlayerPosition()).toBe("innsmouth_church");
    expect(currentSceneItems(value)).toContain("大衮教团徽章");
    const response = await value.act("捡起 大衮教团徽章");
    expect(eventText(response)).toContain("大衮教团徽章");
    expect(value.world.getPlayerInventory("p1")).toContain("大衮教团徽章");
    expect(currentSceneItems(value)).not.toContain("大衮教团徽章");
  } finally {
    value.close();
  }
});

test("a real pickup authorizes out-of-scene tome reading and survives ordinary snapshot restore", async () => {
  const id = `ordinary-pickup-snapshot-${crypto.randomUUID()}`;
  const source = session(id);
  let restored: GameSession | undefined;
  try {
    await loadBarnAndEnterBedroom(source);
    expect((await source.act("捡起 老旧文件")).error).toBeUndefined();
    expect(source.world.getPlayerInventory("p1")).toEqual(["老旧文件"]);
    expect(currentSceneItems(source)).not.toContain("老旧文件");

    expect((await source.act("前往 特里坎家")).error).toBeUndefined();
    expect(source.getPlayerPosition()).toBe("特里坎家");
    const carriedRead = await source.act("阅读 老旧文件");
    expect(eventText(carriedRead)).toContain("SAN 检查");

    const snapshot = structuredClone(source.exportOrdinarySessionSnapshot());
    expect(snapshot.world.tables.player_state.find((state) => state.entity_id === "p1")?.inventory)
      .toEqual(["老旧文件"]);
    expect(sceneItemsInSnapshot(snapshot, "艾德里安的卧室")).not.toContain("老旧文件");

    restored = restoreTarget(id);
    restored.restoreOrdinarySessionSnapshot(snapshot);
    expect(restored.getPlayerPosition()).toBe("特里坎家");
    expect(restored.world.getPlayerInventory("p1")).toEqual(["老旧文件"]);
    const restoredRead = await restored.act("阅读 老旧文件");
    expect(eventText(restoredRead)).toContain("SAN 检查");
    expect((await restored.act("前往 艾德里安的卧室")).error).toBeUndefined();
    expect(currentSceneItems(restored)).not.toContain("老旧文件");
  } finally {
    source.close();
    restored?.close();
  }
});

test("ordinary restore treats package item placement as conserved dynamic state, not immutable scene statics", async () => {
  const id = `ordinary-pickup-conservation-${crypto.randomUUID()}`;
  const source = session(id);
  const missingTarget = restoreTarget(id);
  const copiedTarget = restoreTarget(id);
  const movedTarget = restoreTarget(id);
  try {
    await loadBarnAndEnterBedroom(source);
    await source.act("捡起 老旧文件");
    const snapshot = structuredClone(source.exportOrdinarySessionSnapshot());

    const missing = structuredClone(snapshot);
    const p1 = missing.world.tables.player_state.find((state) => state.entity_id === "p1");
    if (!p1) throw new Error("fixture lacks p1 player state");
    p1.inventory = [];
    expect(() => missingTarget.restoreOrdinarySessionSnapshot(resignWorld(missing))).toThrow("not conserved");

    const copied = structuredClone(snapshot);
    const bedroom = copied.state.sceneItems.find((entry) => entry.sceneId === "艾德里安的卧室");
    if (!bedroom) throw new Error("fixture lacks bedroom placements");
    bedroom.items.push("老旧文件");
    expect(() => copiedTarget.restoreOrdinarySessionSnapshot(resign(copied))).toThrow("not conserved");

    const moved = structuredClone(snapshot);
    const movedP1 = moved.world.tables.player_state.find((state) => state.entity_id === "p1");
    const otherScene = moved.state.sceneItems.find((entry) => entry.sceneId === "农场外围");
    if (!movedP1 || !otherScene) throw new Error("fixture lacks movable package placement state");
    movedP1.inventory = [];
    otherScene.items.push("老旧文件");
    expect(() => movedTarget.restoreOrdinarySessionSnapshot(resignWorld(moved))).toThrow("moved to an undeclared scene");
  } finally {
    source.close();
    missingTarget.close();
    copiedTarget.close();
    movedTarget.close();
  }
});

test("a failed world inventory write leaves the private source placement untouched", async () => {
  const value = session(`ordinary-pickup-write-failure-${crypto.randomUUID()}`);
  try {
    await loadBarnAndEnterBedroom(value);
    const restoreInventoryFailure = patchGameSessionWorldMethod(value, "setPlayerInventory", () => {
      throw new Error("injected pickup inventory failure");
    });
    try {
      const response = await value.act("捡起 老旧文件");
      expect(eventText(response)).toContain("背包写入失败");
      expect(value.world.getPlayerInventory("p1")).not.toContain("老旧文件");
      expect(currentSceneItems(value)).toContain("老旧文件");
    } finally {
      restoreInventoryFailure();
    }
  } finally {
    value.close();
  }
});

test("pickup fails closed when the active player has no entity or no usable position", async () => {
  const value = session(`ordinary-pickup-missing-player-${crypto.randomUUID()}`);
  try {
    await loadBarnAndEnterBedroom(value);
    const before = {
      inventory: value.world.getPlayerInventory("p1"),
      sceneItems: currentSceneItems(value),
    };

    const restoreMissingEntity = patchGameSessionWorldMethod(value, "getEntity", (original, receiver, args) => {
      if (args[0] === "p1") return null;
      return original.apply(receiver, args);
    });
    try {
      const missing = await value.act("捡起 老旧文件");
      expect(eventText(missing)).toContain("可验证的位置");
      expect({ inventory: value.world.getPlayerInventory("p1"), sceneItems: currentSceneItems(value) }).toEqual(before);
    } finally {
      restoreMissingEntity();
    }

    const restoreMissingPosition = patchGameSessionWorldMethod(value, "getEntity", (original, receiver, args) => {
      const entity = original.apply(receiver, args) as { position?: unknown } | null;
      return args[0] === "p1" && entity ? { ...entity, position: "" } : entity;
    });
    try {
      const missingPosition = await value.act("捡起 老旧文件");
      expect(eventText(missingPosition)).toContain("可验证的位置");
      expect({ inventory: value.world.getPlayerInventory("p1"), sceneItems: currentSceneItems(value) }).toEqual(before);
    } finally {
      restoreMissingPosition();
    }
  } finally {
    value.close();
  }
});
