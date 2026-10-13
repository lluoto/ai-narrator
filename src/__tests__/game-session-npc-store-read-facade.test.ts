import { describe, expect, it } from "bun:test";
import { NPCStore } from "../db";
import { GameSession } from "../api/game-session";

const LLM = {
  apiKey: "sk-npc-store-facade-test",
  baseUrl: "http://npc-store-facade.invalid/v1",
  model: "npc-store-facade-test",
  maxTokens: 32,
  temperature: 0,
};

const LOAD_BARN = "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3";

function closeQuietly(store: NPCStore): void {
  try { store.close(); } catch { /* test cleanup only */ }
}

describe("GameSession NPCStore public authority", () => {
  it("rejects whole-store replacement while real module registration and snapshots stay canonical", async () => {
    const session = new GameSession(`npc-store-reference-${crypto.randomUUID()}`, "cosmic-horror", LLM, "investigator", "Ada");
    const facade = session.npcStore;
    const replacement = new NPCStore(":memory:");
    try {
      expect(Object.getOwnPropertyDescriptor(session, "npcStore")).toBeUndefined();
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), "npcStore");
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.set).toBeUndefined();

      expect(Reflect.set(session as object, "npcStore", replacement)).toBe(false);
      expect((await session.act(LOAD_BARN)).error).toBeUndefined();
      expect(facade.getAllPersonalities().length).toBeGreaterThan(0);
      expect(session.exportOrdinarySessionSnapshot().npcStore.tables.npc_personalities.length).toBeGreaterThan(0);

      session.close();
      expect(() => facade.getAllPersonalities()).toThrow();
      expect(replacement.getAllPersonalities()).toEqual([]);
    } finally {
      session.close();
      closeQuietly(replacement);
    }
  });

  it("exposes only stable frozen detached read methods, never raw storage or write/close authority", async () => {
    const session = new GameSession(`npc-store-read-facade-${crypto.randomUUID()}`, "cosmic-horror", LLM, "investigator", "Ada");
    try {
      expect((await session.act(LOAD_BARN)).error).toBeUndefined();
      const facade = session.npcStore;
      const publicSurface = facade as unknown as Record<string, unknown>;

      expect(session.npcStore).toBe(facade);
      expect(Object.isFrozen(facade)).toBe(true);
      expect(Reflect.ownKeys(facade).sort()).toEqual([
        "countMemories",
        "exportSnapshot",
        "getAllPersonalities",
        "getAllRelationships",
        "getImportantMemories",
        "getPersonality",
        "getRecentMemories",
        "getRelationship",
        "getSceneMemories",
        "getState",
        "searchMemories",
      ]);
      for (const forbidden of [
        "raw", "close", "restoreSnapshot", "savePersonality", "deletePersonality",
        "addMemory", "addMemories", "appendMemoryWithRetention", "commitRuntimeTransition", "pruneMemories", "updateRelationship", "updateState",
      ]) expect(forbidden in publicSurface).toBe(false);

      const personality = facade.getAllPersonalities()[0];
      expect(personality).toBeDefined();
      expect(Object.isFrozen(personality)).toBe(true);
      expect(Object.isFrozen(personality?.goals)).toBe(true);
      expect(() => (personality?.goals as string[]).push("mutate")).toThrow(TypeError);
      expect(facade.getAllPersonalities()[0]?.goals).not.toContain("mutate");

      const snapshot = facade.exportSnapshot();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.tables.npc_personalities)).toBe(true);
    } finally {
      session.close();
    }
  });

  it("keeps module registration, snapshots, and owned close on raw authority after reflection masks the public reader", async () => {
    const previousDisabled = process.env.LLM_DISABLED;
    process.env.LLM_DISABLED = "1";
    const session = new GameSession(`npc-store-reflection-${crypto.randomUUID()}`, "cosmic-horror", LLM, "investigator", "Ada");
    const canonicalReader = session.npcStore;
    const observer = new NPCStore(":memory:");
    try {
      Object.defineProperty(session, "npcStore", { value: observer, configurable: true });
      expect((await session.act(LOAD_BARN)).error).toBeUndefined();

      expect(session.npcStore).toBe(observer);
      expect(canonicalReader.getAllPersonalities().length).toBeGreaterThan(0);
      expect(session.exportOrdinarySessionSnapshot().npcStore.tables.npc_personalities.length).toBeGreaterThan(0);

      session.close();
      expect(() => canonicalReader.getAllPersonalities()).toThrow();
      expect(observer.getAllPersonalities()).toEqual([]);
    } finally {
      session.close();
      closeQuietly(observer);
      if (previousDisabled === undefined) delete process.env.LLM_DISABLED;
      else process.env.LLM_DISABLED = previousDisabled;
    }
  });

  it("never closes a caller-owned injected store", () => {
    const callerOwned = new NPCStore(":memory:");
    const session = new GameSession(`npc-store-caller-owned-${crypto.randomUUID()}`, "cosmic-horror", LLM,
      undefined, undefined, undefined, undefined, undefined, undefined, { npcStore: callerOwned });
    const sessionReader = session.npcStore;
    try {
      session.close();
      expect(callerOwned.getAllPersonalities()).toEqual([]);
      expect(() => sessionReader.getAllPersonalities()).toThrow("closed GameSession cannot read NPCStore");
    } finally {
      session.close();
      callerOwned.close();
    }
  });
});
