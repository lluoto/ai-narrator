import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const LLM = {
  apiKey: "sk-world-reference-test",
  baseUrl: "http://world-reference.invalid/v1",
  model: "world-reference-test",
  maxTokens: 32,
  temperature: 0,
};

function session(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", LLM, "investigator", "World Reference Tester");
}

describe("GameSession world facade authority", () => {
  it("publishes world through a non-shadowable own observation accessor", () => {
    const value = session(`world-reference-shape-${crypto.randomUUID()}`);
    try {
      const original = value.world;
      const descriptor = Object.getOwnPropertyDescriptor(value, "world");
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.set).toBeUndefined();
      expect(descriptor?.enumerable).toBe(false);
      expect(descriptor?.configurable).toBe(false);
      expect(Reflect.set(value as object, "world", null)).toBe(false);
      expect(() => Object.assign(value as object, { world: null })).toThrow(TypeError);
      expect(Reflect.defineProperty(value, "world", { value: null })).toBe(false);
      expect(value.world).toBe(original);
    } finally {
      value.close();
    }
  });

  it("keeps real discovery, ordinary snapshots, and actions on the canonical raw world", async () => {
    const source = session(`world-reference-discovery-${crypto.randomUUID()}`);
    const target = new GameSession(source.id, "cosmic-horror", LLM);
    const originalRandom = Math.random;
    try {
      expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
      const facade = source.world;
      expect(activateRegisteredGameSessionSceneForTest(source, "\u52a0\u6bd4\u7684\u62d6\u8f66\u623f")).toBe(true);
      Math.random = () => 0;
      expect((await source.act("\u68c0\u67e5\u9910\u5385")).error).toBeUndefined();
      Math.random = originalRandom;
      const clues = facade.getCluesDiscoveredBy(source.activePlayerId);
      expect(clues.length).toBeGreaterThan(0);

      expect(() => Object.assign(source as object, { world: null })).toThrow(TypeError);
      expect(Reflect.defineProperty(source, "world", { value: null })).toBe(false);
      expect(source.world).toBe(facade);
      expect(Object.isFrozen(facade)).toBe(true);

      const ordinarySnapshot = JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot()));
      expect(ordinarySnapshot.world.tables.clue_discoveries.some((row: { player_id: string }) => row.player_id === source.activePlayerId)).toBe(true);
      target.restoreOrdinarySessionSnapshot(ordinarySnapshot);
      expect(target.world.getCluesDiscoveredBy(target.activePlayerId)).toEqual(clues);

      const acted = await source.act("/status");
      expect(acted.error).toBeUndefined();
      expect(acted.state.round).toBeGreaterThan(1);
    } finally {
      Math.random = originalRandom;
      target.close();
      source.close();
    }
  });
});
