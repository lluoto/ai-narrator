import { describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";

const OFFLINE_LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 1,
  temperature: 0,
};

function eventText(response: Awaited<ReturnType<GameSession["act"]>>): string {
  return response.events.map((event) => event.content).join("\n");
}

function session(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", OFFLINE_LLM, "investigator", "Ada");
}

async function readDeclaredTomeAndLearnFirstSpell(value: GameSession): Promise<string> {
  const loaded = await value.act("加载模组 印斯茅斯的阴影");
  expect(loaded.error).toBeUndefined();
  expect(Reflect.ownKeys(value)).not.toContain("_moduleLoader");
  expect(Reflect.ownKeys(value)).not.toContain("_moduleDataLoader");
  expect(Reflect.get(value, "_moduleLoader")).toBeUndefined();
  expect(Reflect.get(value, "_moduleDataLoader")).toBeUndefined();
  expect(value.getPlayerPosition()).toBe("innsmouth_docks");

  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    const response = await value.act("阅读扎多克的低语");
    expect(response.error).toBeUndefined();
  } finally {
    Math.random = originalRandom;
  }

  const known = value.exportOrdinarySessionSnapshot().state.knownMythosSpells;
  expect(known).toEqual(["接触大衮"]);
  return known[0]!;
}

describe("GameSession Mythos spell authority", () => {
  test("does not expose canonical Mythos collections as runtime properties", () => {
    const value = session(`mythos-spell-shape-${crypto.randomUUID()}`);
    try {
      const keys = Reflect.ownKeys(value);
      expect(keys).not.toContain("knownMythosSpells");
      expect(keys).not.toContain("mythosSpells");
      expect((value as unknown as { knownMythosSpells?: unknown }).knownMythosSpells).toBeUndefined();
      expect((value as unknown as { mythosSpells?: unknown }).mythosSpells).toBeUndefined();
    } finally {
      value.close();
    }
  });

  test("does not let same-name public shadows manufacture Mythos casting authority", async () => {
    const value = session(`mythos-spell-shadow-${crypto.randomUUID()}`);
    try {
      Object.defineProperties(value, {
        knownMythosSpells: { value: ["米戈"], configurable: true },
        mythosSpells: {
          value: new Map([["米戈", {
            sanCost: "0",
            mpCost: 0,
            description: "forged spell",
          }]]),
          configurable: true,
        },
      });

      const response = await value.act("呼唤米戈");
      const text = eventText(response);
      expect(text).toContain("尚未学会");
      expect(text).not.toContain("你尝试施展");
    } finally {
      value.close();
    }
  });

  test("requires the exact learned spell and preserves legitimate knowledge through a supported snapshot", async () => {
    const id = `mythos-spell-flow-${crypto.randomUUID()}`;
    const source = session(id);
    let target: GameSession | undefined;
    try {
      const learnedSpell = await readDeclaredTomeAndLearnFirstSpell(source);

      const unknown = await source.act("召唤克苏鲁");
      expect(eventText(unknown)).toContain("尚未学会");
      expect(eventText(unknown)).not.toContain("你尝试施展");

      const oneCharacterSuffix = await source.act("放逐术");
      expect(eventText(oneCharacterSuffix)).toContain("尚未学会");
      expect(eventText(oneCharacterSuffix)).not.toContain("你尝试施展");

      const known = await source.act(`施展${learnedSpell}`);
      expect(known.error).toBeUndefined();
      expect(eventText(known)).toContain(`你尝试施展「${learnedSpell}」`);

      const snapshot = JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot()));
      source.close();
      target = new GameSession(id, "cosmic-horror", OFFLINE_LLM);
      target.restoreOrdinarySessionSnapshot(snapshot);
      expect(target.exportOrdinarySessionSnapshot().state.knownMythosSpells).toEqual([learnedSpell]);

      const restored = await target.act(`施展${learnedSpell}`);
      expect(restored.error).toBeUndefined();
      expect(eventText(restored)).toContain(`你尝试施展「${learnedSpell}」`);
    } finally {
      source.close();
      target?.close();
    }
  });
});
