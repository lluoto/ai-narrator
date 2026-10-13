import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { activateRegisteredGameSessionSceneForTest, patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";

const OFFLINE_CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

type RuntimeRecord = Record<string, unknown>;

const REMOVED_WORLD_WRITERS = [
  "upsertEntity", "applyDamage", "killEntity", "seedEntities", "registerPlayer",
  "setPlayerSanity", "setPlayerInventory", "setPlayerWeapons", "setPlayerArmor",
  "recordClueDiscovery", "incrementClueFail", "resetClueFails", "recordSceneVisit",
  "addEffect", "tickEffects", "createSnapshot", "logEvent", "logCombatEvent",
  "setActiveScene", "setSceneExits", "registerScene", "setSceneEnvironment",
  "setRelation", "modifyAttitude",
] as const;

describe("GameSession world capability facade", () => {
  it("publishes a stable frozen observation facade, not world mutation authority", () => {
    const session = new GameSession(`world-facade-shape-${crypto.randomUUID()}`, "cosmic-horror", OFFLINE_CONFIG);
    try {
      const world = session.world;
      const hostile = world as unknown as RuntimeRecord;

      expect(session.world).toBe(world);
      expect(session.world.getEntity).toBe(world.getEntity);
      expect(Object.isFrozen(world)).toBe(true);
      expect(Object.getPrototypeOf(world)).toBeNull();
      const descriptor = Object.getOwnPropertyDescriptor(session, "world");
      expect(descriptor?.enumerable).toBe(false);
      expect(descriptor?.configurable).toBe(false);
      expect(descriptor?.set).toBeUndefined();
      for (const key of ["getDatabase", "restoreSnapshot", "close", "db", "currentRound", "unknown"] as const) {
        expect(hostile[key]).toBeUndefined();
        expect(key in hostile).toBe(false);
        expect(Reflect.ownKeys(hostile)).not.toContain(key);
      }
      // A regression that restores the old allowlist creates a real canonical
      // discovery write here; shape-only checks would not catch that leak.
      const attemptedForge = hostile.recordClueDiscovery;
      if (typeof attemptedForge === "function") {
        attemptedForge("p1", "forged-through-public-world");
      }
      expect(world.isClueDiscoveredBy("p1", "forged-through-public-world")).toBe(false);
      for (const key of REMOVED_WORLD_WRITERS) {
        expect(hostile[key]).toBeUndefined();
        expect(key in hostile).toBe(false);
        expect(Reflect.ownKeys(hostile)).not.toContain(key);
      }
      expect(hostile.constructor).toBeUndefined();
      expect(hostile.prototype).toBeUndefined();

      expect(session.setPlayerInventory("p1", ["verified-host-write"])).toBe(true);
      expect(world.getPlayerInventory("p1")).toEqual(["verified-host-write"]);
      expect(world.getPlayerState("p1")).not.toBeNull();

      expect(Reflect.set(world as object, "getEntity", () => null)).toBe(false);
      expect(() => Object.assign(world as object, { arbitrary: "shadow" })).toThrow(TypeError);
      expect(() => { (session as unknown as { world: unknown }).world = null; }).toThrow(TypeError);
      expect(Reflect.set(session, "world", null)).toBe(false);
      expect(Reflect.defineProperty(session, "world", { value: null })).toBe(false);
      expect(world.getEntity).not.toBeUndefined();
    } finally {
      session.close();
    }
  });

  it("lets a real action discover a clue and preserves it in the canonical ordinary snapshot", async () => {
    const source = new GameSession(`world-facade-discovery-${crypto.randomUUID()}`, "cosmic-horror", OFFLINE_CONFIG, "investigator", "Ada");
    const target = new GameSession(source.id, "cosmic-horror", OFFLINE_CONFIG);
    const originalRandom = Math.random;
    try {
      expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
      expect(activateRegisteredGameSessionSceneForTest(source, "\u52a0\u6bd4\u7684\u62d6\u8f66\u623f")).toBe(true);
      Math.random = () => 0;
      expect((await source.act("\u68c0\u67e5\u9910\u5385")).error).toBeUndefined();
      Math.random = originalRandom;

      const snapshot = source.exportOrdinarySessionSnapshot();
      const discovered = source.world.getCluesDiscoveredBy(source.activePlayerId);
      expect(discovered.length).toBeGreaterThan(0);
      expect(snapshot.world.tables.clue_discoveries.some((row) => row.player_id === source.activePlayerId)).toBe(true);
      target.restoreOrdinarySessionSnapshot(structuredClone(snapshot));
      expect(target.world.getCluesDiscoveredBy(target.activePlayerId)).toEqual(discovered);
    } finally {
      Math.random = originalRandom;
      target.close();
      source.close();
    }
  });

  it("fails closed for retained world readers after the session closes", () => {
    const session = new GameSession(`world-facade-close-${crypto.randomUUID()}`, "cosmic-horror", OFFLINE_CONFIG);
    const world = session.world;
    let restoreCachedReader: (() => void) | null = null;
    try {
      // Capture a real canonical value before close. getPlayerState is
      // SQLite-backed, while the patched formatter below is cache-only.
      const state = world.getCurrentState();
      expect(state.players.p1).toBeDefined();
      expect(world.buildContextPrompt(state, [])).toContain("世界状态");
      expect(world.getPlayerState("p1")).not.toBeNull();

      restoreCachedReader = patchGameSessionWorldMethod(session, "buildContextPrompt", () => "[cached world context]");
      expect(world.buildContextPrompt(state, [])).toBe("[cached world context]");

      session.close();
      session.close();

      const readers: Array<() => unknown> = [
        () => world.buildContextPrompt(state, []),
        () => world.getPlayerState("p1"),
      ];
      const errorsByReader = readers.map((read) => {
        const errors: string[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            read();
            throw new Error("closed GameSession world reader unexpectedly succeeded");
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        return errors;
      });
      expect(errorsByReader).toEqual([
        ["closed GameSession cannot read world", "closed GameSession cannot read world"],
        ["closed GameSession cannot read world", "closed GameSession cannot read world"],
      ]);
    } finally {
      restoreCachedReader?.();
      session.close();
    }
  });
});
