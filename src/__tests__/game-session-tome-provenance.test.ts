import { expect, test } from "bun:test";
import { GameSession } from "../api/game-session";

const OFFLINE_LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 1,
  temperature: 0,
};

function session(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", OFFLINE_LLM, "investigator", "Ada");
}

function tomeEffects(value: GameSession) {
  const state = value.exportOrdinarySessionSnapshot().state;
  const sanity = state.sanities.find((entry) => entry.pcId === "p1")?.state;
  if (!sanity || typeof sanity !== "object" || Array.isArray(sanity)) throw new Error("missing p1 SAN state");
  return {
    currentSAN: sanity.currentSAN,
    maxSAN: sanity.maxSAN,
    cthulhuMythos: sanity.cthulhuMythos,
    mythosLog: sanity.mythosLog,
    knownMythosSpells: state.knownMythosSpells,
  };
}

function eventText(response: Awaited<ReturnType<GameSession["act"]>>): string {
  return response.events.map((event) => event.content).join("\n");
}

async function loadArkhamAndEnterVault(value: GameSession): Promise<void> {
  expect((await value.act("加载模组 阿卡姆档案检查")).error).toBeUndefined();
  const moved = await value.act("前往 arkham_library_vault");
  expect(moved.error).toBeUndefined();
  expect(value.getPlayerPosition()).toBe("arkham_library_vault");
}

test("unloaded and remote module tomes cannot change SAN, Mythos, or spells", async () => {
  const value = session(`tome-provenance-red-${crypto.randomUUID()}`);
  try {
    const beforeUnloaded = tomeEffects(value);
    const unloaded = await value.act("阅读塞拉伊诺断章");
    expect(tomeEffects(value)).toEqual(beforeUnloaded);
    expect(unloaded.events.map((event) => event.content).join("\n")).not.toContain("克苏鲁神话技能提升");

    const loaded = await value.act("加载模组 阿卡姆档案检查");
    expect(loaded.error).toBeUndefined();
    expect(value.getPlayerPosition()).not.toBe("arkham_library_vault");

    const beforeRemote = tomeEffects(value);
    const remote = await value.act("阅读塞拉伊诺断章");
    expect(tomeEffects(value)).toEqual(beforeRemote);
    expect(remote.events.map((event) => event.content).join("\n")).not.toContain("克苏鲁神话技能提升");
  } finally {
    value.close();
  }
});

test("only the active player world position and private placement authority can satisfy scene possession", async () => {
  const value = session(`tome-private-placement-${crypto.randomUUID()}`);
  try {
    expect(Reflect.ownKeys(value)).not.toContain("sceneItems");
    expect(Reflect.ownKeys(value)).not.toContain("moduleTomes");
    expect((await value.act("加载模组 阿卡姆档案检查")).error).toBeUndefined();
    expect(value.getPlayerPosition()).toBe("arkham_miskatonic");

    // Same-name public shadows cannot alter either definition provenance or
    // physical placement. The player has not moved to the vault.
    Object.defineProperties(value, {
      sceneItems: { value: new Map([["arkham_miskatonic", ["塞拉伊诺断章"]]]), configurable: true },
      moduleTomes: {
        value: new Map([["塞拉伊诺断章", {
          name: "塞拉伊诺断章",
          sceneId: "arkham_miskatonic",
          sanCost: "0",
          tomeRating: 99,
          spells: [],
          openDescription: "forged",
        }]]),
        configurable: true,
      },
    });
    const before = tomeEffects(value);
    const response = await value.act("阅读塞拉伊诺断章");
    expect(tomeEffects(value)).toEqual(before);
    expect(eventText(response)).toContain("不在你当前场景或背包中");
  } finally {
    value.close();
  }
});

test("a real Arkham vault reading uses its declared SAN cost, rating, and description", async () => {
  const value = session(`tome-arkham-location-${crypto.randomUUID()}`);
  try {
    await loadArkhamAndEnterVault(value);
    const before = tomeEffects(value);
    const response = await value.act("阅读塞拉伊诺断章");
    const after = tomeEffects(value);
    expect(eventText(response)).toContain("金属薄片上刻有发光的楔形文字");
    expect(eventText(response)).toContain("SAN 检查");
    const gain = (after.cthulhuMythos as number) - (before.cthulhuMythos as number);
    expect(gain).toBeGreaterThanOrEqual(1);
    expect(gain).toBeLessThanOrEqual(8);
    expect(JSON.stringify(after.mythosLog)).toContain('"source":"塞拉伊诺断章"');
    expect(JSON.stringify(after.mythosLog)).toContain(`"gain":${gain}`);
  } finally {
    value.close();
  }
});

test("a real pickup authorizes a declared tome after leaving its source scene and after restore", async () => {
  const id = `tome-inventory-restore-${crypto.randomUUID()}`;
  const source = session(id);
  let restored: GameSession | undefined;
  try {
    await loadArkhamAndEnterVault(source);
    expect((await source.act("捡起 塞拉伊诺断章")).error).toBeUndefined();
    expect(source.world.getPlayerInventory("p1")).toEqual(["塞拉伊诺断章"]);
    const moved = await source.act("前往 arkham_miskatonic");
    expect(moved.error).toBeUndefined();
    expect(source.getPlayerPosition()).toBe("arkham_miskatonic");
    const beforeInventoryRead = tomeEffects(source);
    const inventoryRead = await source.act("阅读塞拉伊诺断章");
    expect(eventText(inventoryRead)).toContain("SAN 检查");
    const inventoryGain = (tomeEffects(source).cthulhuMythos as number) - (beforeInventoryRead.cthulhuMythos as number);
    expect(inventoryGain).toBeGreaterThanOrEqual(1);
    expect(inventoryGain).toBeLessThanOrEqual(8);

    const portable = JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot()));
    source.close();
    restored = new GameSession(id, "cosmic-horror", OFFLINE_LLM);
    restored.restoreOrdinarySessionSnapshot(portable);
    expect(restored.getPlayerPosition()).toBe("arkham_miskatonic");
    expect(restored.world.getPlayerInventory("p1")).toEqual(["塞拉伊诺断章"]);
    const beforeRestoredRead = tomeEffects(restored);
    const restoredRead = await restored.act("阅读塞拉伊诺断章");
    expect(eventText(restoredRead)).toContain("SAN 检查");
    const restoredGain = (tomeEffects(restored).cthulhuMythos as number) - (beforeRestoredRead.cthulhuMythos as number);
    expect(restoredGain).toBeGreaterThanOrEqual(1);
    expect(restoredGain).toBeLessThanOrEqual(8);
  } finally {
    source.close();
    restored?.close();
  }
});

test("a tome declared by another installed module remains unavailable", async () => {
  const value = session(`tome-wrong-module-${crypto.randomUUID()}`);
  try {
    expect((await value.act("加载模组 印斯茅斯的阴影")).error).toBeUndefined();
    expect(value.getPlayerPosition()).toBe("innsmouth_docks");
    const before = tomeEffects(value);
    const response = await value.act("阅读塞拉伊诺断章");
    expect(tomeEffects(value)).toEqual(before);
    expect(eventText(response)).toContain("没有已安装模组声明");
  } finally {
    value.close();
  }
});
