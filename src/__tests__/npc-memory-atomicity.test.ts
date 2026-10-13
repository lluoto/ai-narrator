import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "../agent/agent-registry";
import { NPCAgent } from "../agent/npc-agent";
import type { MemoryEntry, NPCPersonality } from "../agent/types";
import { GameSession } from "../api/game-session";
import { NPCStore } from "../db";
import type { LLMLike } from "../llm/client";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const personality = (name: string): NPCPersonality => ({
  name,
  role: "witness",
  personality: "careful",
  background: "test fixture",
  goals: [],
  speech_style: "brief",
  knowledge: [],
  secrets: [],
});

const memory = (index: number, importance: number): MemoryEntry => ({
  timestamp: 1_700_000_000_000 + index,
  type: "observation",
  content: `memory-${index}`,
  importance,
});

const replyingLLM: LLMLike = { chat: async () => "The barn is quiet." };
const sessionConfig = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 128,
  temperature: 0,
};

function registeredPersistentAgent(name: string) {
  const store = new NPCStore(":memory:");
  const card = personality(name);
  store.savePersonality(card);
  const registry = new AgentRegistry(replyingLLM, store);
  return { store, registry, npc: registry.register(card) };
}

function rejectMemoryInserts(store: NPCStore): void {
  store.raw.run(`
    CREATE TRIGGER reject_npc_memory_insert
    BEFORE INSERT ON npc_memories
    BEGIN
      SELECT RAISE(ABORT, 'test memory insert failure');
    END
  `);
}

describe("NPC memory append atomicity", () => {
  it("rejects respond and leaves durable/live/registry state untouched when SQLite rejects its memory", async () => {
    const { store, registry, npc } = registeredPersistentAgent("respond atomic NPC");
    try {
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      rejectMemoryInserts(store);

      await expect(npc.respond("What did you see?")).rejects.toThrow("test memory insert failure");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.exportSnapshot().agents[0]?.memories).toEqual(beforeRuntime.memories);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("rejects speakUp and leaves durable/live/registry state untouched when SQLite rejects its memory", async () => {
    const { store, registry, npc } = registeredPersistentAgent("speak atomic NPC");
    try {
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      rejectMemoryInserts(store);

      await expect(npc.speakUp("A distant sound interrupts the conversation.")).rejects.toThrow("test memory insert failure");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.exportSnapshot().agents[0]?.memories).toEqual(beforeRuntime.memories);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("makes a real GameSession talk publish only the existing no-response system text after durable memory failure", async () => {
    const store = new NPCStore(":memory:");
    const session = new GameSession(
      `talk-memory-atomic-${crypto.randomUUID()}`,
      "cosmic-horror",
      sessionConfig,
      "investigator",
      "Ada",
      undefined,
      undefined,
      undefined,
      "preferred",
      { npcStore: store },
    );
    const npcName = "\u83f2\u78a7\u00b7\u7279\u91cc\u574e";
    try {
      await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3");
      expect(activateRegisteredGameSessionSceneForTest(session, "\u7279\u91cc\u574e\u5bb6")).toBe(true);
      const beforeStore = store.exportSnapshot();
      rejectMemoryInserts(store);

      const result = await session.act("\u8ddf\u83f2\u78a7\u8bf4\u8bdd");

      expect(result.narrative).toContain("\u6ca1\u6709\u56de\u5e94");
      expect(result.narrative).not.toContain("The barn is quiet.");
      expect(result.events.some((event) => event.speaker === npcName && event.type === "dialogue")).toBe(false);
      expect(session.getHistory(20).messages.some((message) => message.speaker === npcName && message.type === "dialogue")).toBe(false);
      expect(store.exportSnapshot()).toEqual(beforeStore);
      session.close();
      expect(store.getPersonality(npcName)).not.toBeNull();
    } finally {
      session.close();
      store.close();
    }
  });

  it("keeps mood, memory, state, and revision unchanged when the mood event insert fails", () => {
    const { store, registry, npc } = registeredPersistentAgent("mood atomic NPC");
    try {
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      rejectMemoryInserts(store);
      const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
      expect(randomDescriptor).toBeDefined();
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      try {
        expect(() => npc.triggerMood("helped")).toThrow("test memory insert failure");
      } finally {
        Object.defineProperty(Math, "random", randomDescriptor!);
      }

      expect(npc.getMood()).toBe(beforeRuntime.mood);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(store.getState(npc.name)).toBeNull();
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("rolls back a mood event when SQLite rejects the first npc_states insert", () => {
    const { store, registry, npc } = registeredPersistentAgent("mood state-insert atomic NPC");
    try {
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      store.raw.run(`
        CREATE TRIGGER reject_npc_state_insert
        BEFORE INSERT ON npc_states
        BEGIN
          SELECT RAISE(ABORT, 'test npc state insert failure');
        END
      `);
      const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
      expect(randomDescriptor).toBeDefined();
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      try {
        expect(() => npc.triggerMood("helped")).toThrow("test npc state insert failure");
      } finally {
        Object.defineProperty(Math, "random", randomDescriptor!);
      }

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.exportSnapshot().agents[0]).toEqual(expect.objectContaining(beforeRuntime));
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("rolls back a mood event when SQLite rejects an existing npc_states update", () => {
    const { store, registry, npc } = registeredPersistentAgent("mood state-update atomic NPC");
    try {
      store.updateState(npc.name, "neutral", 0, 0);
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      store.raw.run(`
        CREATE TRIGGER reject_npc_state_update
        BEFORE UPDATE OF mood ON npc_states
        BEGIN
          SELECT RAISE(ABORT, 'test npc state update failure');
        END
      `);
      const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
      expect(randomDescriptor).toBeDefined();
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      try {
        expect(() => npc.triggerMood("helped")).toThrow("test npc state update failure");
      } finally {
        Object.defineProperty(Math, "random", randomDescriptor!);
      }

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.exportSnapshot().agents[0]).toEqual(expect.objectContaining(beforeRuntime));
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("rolls back retention rows and sequence when a later mood-state write rejects", () => {
    const { store, registry, npc } = registeredPersistentAgent("mood retention-state atomic NPC");
    try {
      for (let index = 0; index < 150; index++) store.addMemory(npc.name, memory(index, 9));
      for (let index = 150; index < 200; index++) store.addMemory(npc.name, memory(index, 1));
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      store.raw.run(`
        CREATE TRIGGER reject_npc_state_after_retention
        BEFORE INSERT ON npc_states
        BEGIN
          SELECT RAISE(ABORT, 'test npc state after retention failure');
        END
      `);
      const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
      expect(randomDescriptor).toBeDefined();
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      try {
        expect(() => npc.triggerMood("helped")).toThrow("test npc state after retention failure");
      } finally {
        Object.defineProperty(Math, "random", randomDescriptor!);
      }

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(store.exportSnapshot().sequences.npc_memories).toBe(beforeStore.sequences.npc_memories);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("commits a mood event and state before publishing one coherent live registry revision", () => {
    const { store, registry, npc } = registeredPersistentAgent("mood transition success NPC");
    try {
      const beforeRevision = registry.semanticRevision;
      const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
      expect(randomDescriptor).toBeDefined();
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      try {
        npc.triggerMood("helped");
      } finally {
        Object.defineProperty(Math, "random", randomDescriptor!);
      }

      const runtime = npc.exportRuntimeState();
      expect(runtime).toEqual(expect.objectContaining({
        mood: "friendly",
        memories: [expect.objectContaining({ type: "event", content: expect.stringContaining("helped") })],
      }));
      expect(store.getState(npc.name)).toEqual({ mood: "friendly", relationship: 0, interactionCount: 0 });
      expect(store.getRecentMemories(npc.name, 1)[0]).toEqual(expect.objectContaining(runtime.memories[0]!));
      expect(registry.exportSnapshot().agents[0]).toEqual(expect.objectContaining(runtime));
      expect(registry.semanticRevision).toBe(beforeRevision + 1n);
    } finally {
      store.close();
    }
  });

  it("publishes one in-memory mood transition revision when no durable store is configured", () => {
    const registry = new AgentRegistry(replyingLLM);
    const npc = registry.register(personality("memory-only mood transition NPC"));
    const beforeRevision = registry.semanticRevision;
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
    try {
      npc.triggerMood("helped");
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
    }

    expect(npc.exportRuntimeState()).toEqual(expect.objectContaining({
      mood: "friendly",
      memories: [expect.objectContaining({ type: "event", content: expect.stringContaining("helped") })],
    }));
    expect(registry.semanticRevision).toBe(beforeRevision + 1n);
  });

  it("does not create a missing personality or publish when the transaction fails its foreign key", () => {
    const store = new NPCStore(":memory:");
    let notifications = 0;
    const npc = new NPCAgent(personality("orphan mood transition NPC"), replyingLLM, store, () => { notifications++; });
    try {
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
      expect(randomDescriptor).toBeDefined();
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      try {
        expect(() => npc.triggerMood("helped")).toThrow(/FOREIGN KEY/i);
      } finally {
        Object.defineProperty(Math, "random", randomDescriptor!);
      }

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(notifications).toBe(0);
    } finally {
      store.close();
    }
  });

  it("uses private NPCStore transaction cores rather than legacy public append or state writers", () => {
    const { store, npc } = registeredPersistentAgent("mood private store cores NPC");
    try {
      const legacyWrapper = () => { throw new Error("legacy public NPCStore writer must not be dispatched"); };
      Object.defineProperties(store, {
        appendMemoryWithRetention: { value: legacyWrapper },
        updateRelationship: { value: legacyWrapper },
        updateState: { value: legacyWrapper },
      });
      const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
      expect(randomDescriptor).toBeDefined();
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      try {
        expect(() => npc.triggerMood("helped")).not.toThrow();
      } finally {
        Object.defineProperty(Math, "random", randomDescriptor!);
      }

      expect(npc.getMood()).toBe("friendly");
      expect(store.getState(npc.name)?.mood).toBe("friendly");
      expect(store.getRecentMemories(npc.name, 1)[0]).toEqual(expect.objectContaining({ type: "event" }));
    } finally {
      store.close();
    }
  });

  it("does not publish a first positive interaction when the player relationship INSERT rejects", () => {
    const { store, registry, npc } = registeredPersistentAgent("interaction relationship-insert atomic NPC");
    try {
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      store.raw.run(`
        CREATE TRIGGER reject_player_relationship_insert
        BEFORE INSERT ON npc_relationships
        BEGIN
          SELECT RAISE(ABORT, 'test player relationship insert failure');
        END
      `);

      expect(() => npc.recordInteraction(true)).toThrow("test player relationship insert failure");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("does not publish a negative interaction when the npc_states INSERT rejects", () => {
    const { store, registry, npc } = registeredPersistentAgent("interaction state-insert atomic NPC");
    try {
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      store.raw.run(`
        CREATE TRIGGER reject_interaction_state_insert
        BEFORE INSERT ON npc_states
        BEGIN
          SELECT RAISE(ABORT, 'test interaction state insert failure');
        END
      `);

      expect(() => npc.recordInteraction(false)).toThrow("test interaction state insert failure");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("rolls back the complete third positive interaction when its mood-event INSERT rejects", () => {
    const { store, registry, npc } = registeredPersistentAgent("third interaction memory atomic NPC");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    try {
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      npc.recordInteraction(true);
      npc.recordInteraction(true);
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      rejectMemoryInserts(store);

      expect(() => npc.recordInteraction(true)).toThrow("test memory insert failure");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
      store.close();
    }
  });

  it("rolls back relationship, retention, and state on the third positive interaction prune failure", () => {
    const { store, registry, npc } = registeredPersistentAgent("third interaction retention atomic NPC");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    try {
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      npc.recordInteraction(true);
      npc.recordInteraction(true);
      for (let index = 0; index < 150; index++) store.addMemory(npc.name, memory(index, 9));
      for (let index = 150; index < 200; index++) store.addMemory(npc.name, memory(index, 1));
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      store.raw.run(`
        CREATE TRIGGER reject_third_interaction_memory_prune
        BEFORE DELETE ON npc_memories
        BEGIN
          SELECT RAISE(ABORT, 'test third interaction memory prune failure');
        END
      `);

      expect(() => npc.recordInteraction(true)).toThrow("test third interaction memory prune failure");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(store.exportSnapshot().sequences.npc_memories).toBe(beforeStore.sequences.npc_memories);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
      store.close();
    }
  });

  it("rolls back relationship and mood memory when the third interaction's final state update rejects", () => {
    const { store, registry, npc } = registeredPersistentAgent("third interaction final-state atomic NPC");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    try {
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      npc.recordInteraction(true);
      npc.recordInteraction(true);
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      store.raw.run(`
        CREATE TRIGGER reject_friendly_interaction_state_update
        BEFORE UPDATE ON npc_states
        WHEN NEW.mood = 'friendly'
        BEGIN
          SELECT RAISE(ABORT, 'test third interaction final state failure');
        END
      `);

      expect(() => npc.recordInteraction(true)).toThrow("test third interaction final state failure");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
      store.close();
    }
  });

  it("commits each successful positive interaction once while preserving distinct durable counters", () => {
    const { store, registry, npc } = registeredPersistentAgent("interaction success atomic NPC");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    try {
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      let expectedRevision = registry.semanticRevision;
      for (let count = 1; count <= 3; count++) {
        npc.recordInteraction(true);
        expectedRevision++;
        expect(registry.semanticRevision).toBe(expectedRevision);
      }

      expect(npc.exportRuntimeState()).toEqual(expect.objectContaining({
        mood: "friendly",
        relationship: 1.5,
        playerInteractionCount: 3,
        memories: [expect.objectContaining({ type: "event", content: expect.stringContaining("repeated_kindness") })],
      }));
      expect(store.getState(npc.name)).toEqual({ mood: "friendly", relationship: 1.5, interactionCount: 3 });
      expect(store.getAllRelationships(npc.name)).toEqual([
        { targetName: "player", relationship: 1.5, interactionCount: 3 },
      ]);
      expect(store.getRecentMemories(npc.name, 1)[0]).toEqual(expect.objectContaining({
        type: "event",
        content: expect.stringContaining("repeated_kindness"),
      }));
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
      store.close();
    }
  });

  it("samples the third interaction mood transition exactly once before its durable commit", () => {
    const { store, npc } = registeredPersistentAgent("interaction one-random-sample NPC");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    let calls = 0;
    try {
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => { calls++; return 0; } });
      npc.recordInteraction(true);
      npc.recordInteraction(true);
      npc.recordInteraction(true);

      expect(calls).toBe(1);
      expect(store.getState(npc.name)).toEqual({ mood: "friendly", relationship: 1.5, interactionCount: 3 });
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
      store.close();
    }
  });

  it("publishes direct relationship adjustment once and rolls it back when the relationship write rejects", () => {
    const { store, registry, npc } = registeredPersistentAgent("direct relationship atomic NPC");
    try {
      const beforeSuccess = registry.semanticRevision;
      npc.adjustRelationship(0.5);
      expect(registry.semanticRevision).toBe(beforeSuccess + 1n);
      expect(npc.getRelationship()).toBe(0.5);

      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      store.raw.run(`
        CREATE TRIGGER reject_direct_relationship_update
        BEFORE UPDATE ON npc_relationships
        BEGIN
          SELECT RAISE(ABORT, 'test direct relationship update failure');
        END
      `);

      expect(() => npc.adjustRelationship(0.5)).toThrow("test direct relationship update failure");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("keeps the live projection quiet at the relationship cap while still recording the durable contact", () => {
    const { store, registry, npc } = registeredPersistentAgent("relationship cap durable contact NPC");
    try {
      npc.adjustRelationship(5);
      const beforeRevision = registry.semanticRevision;
      const beforeState = store.getState(npc.name);

      npc.adjustRelationship(0.5);

      expect(npc.exportRuntimeState()).toEqual(expect.objectContaining({ relationship: 5, playerInteractionCount: 0 }));
      expect(store.getState(npc.name)).toEqual(beforeState);
      expect(store.getAllRelationships(npc.name)).toEqual([
        { targetName: "player", relationship: 5, interactionCount: 2 },
      ]);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("accepts the empty/invalid initial_mood neutral compatibility exception before the first state row", () => {
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
    try {
      // This is a compatibility exception, not general bad-data acceptance:
      // existing readers map both empty and invalid initial moods to neutral.
      for (const initialMood of ["", "invalid"]) {
        const { store, npc } = registeredPersistentAgent(`initial mood compatibility ${initialMood || "empty"} NPC`);
        try {
          store.raw.run("UPDATE npc_personalities SET initial_mood = ? WHERE id = ?", [initialMood, npc.name]);

          expect(() => npc.triggerMood("helped")).not.toThrow();
          expect(store.getState(npc.name)).toEqual({ mood: "friendly", relationship: 0, interactionCount: 0 });
        } finally {
          store.close();
        }
      }
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
    }
  });

  it("rejects a durable state that disagrees with the live agent before any mood transition write", () => {
    const { store, registry, npc } = registeredPersistentAgent("state-agent drift atomic NPC");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    try {
      store.updateState(npc.name, "angry", 1, 2);
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });

      expect(() => npc.triggerMood("helped")).toThrow(/pre-state/i);

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
      store.close();
    }
  });

  it("rejects player relationship drift from the matching durable npc_state before any direct adjustment", () => {
    const { store, registry, npc } = registeredPersistentAgent("state-relationship drift atomic NPC");
    try {
      store.updateState(npc.name, "neutral", 2, 0);
      npc.restoreRuntimeState({ ...npc.exportRuntimeState(), relationship: 2 });
      store.updateRelationship(npc.name, "player", 1);
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;

      expect(() => npc.adjustRelationship(0.5)).toThrow(/pre-state/i);

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("rejects player relationship drift before a mood-only transition can write memory or state", () => {
    const { store, registry, npc } = registeredPersistentAgent("mood-only relationship drift atomic NPC");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    try {
      store.updateState(npc.name, "neutral", 2, 0);
      npc.restoreRuntimeState({ ...npc.exportRuntimeState(), relationship: 2 });
      store.updateRelationship(npc.name, "player", 1);
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });

      expect(() => npc.triggerMood("helped")).toThrow(/pre-state/i);

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
      store.close();
    }
  });

  it("publishes every no-DB positive or negative interaction exactly once", () => {
    let notifications = 0;
    const npc = new NPCAgent(personality("no-db interaction atomic NPC"), replyingLLM, undefined, () => { notifications++; });
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(randomDescriptor).toBeDefined();
    try {
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });
      npc.recordInteraction(true);
      expect(notifications).toBe(1);
      npc.recordInteraction(false);
      expect(notifications).toBe(2);
      npc.recordInteraction(true);
      expect(notifications).toBe(3);
      expect(npc.exportRuntimeState()).toEqual(expect.objectContaining({
        relationship: 1,
        playerInteractionCount: 3,
      }));
    } finally {
      Object.defineProperty(Math, "random", randomDescriptor!);
    }
  });

  it("rolls back the inserted row and sqlite sequence when retention pruning aborts", () => {
    const { store, registry, npc } = registeredPersistentAgent("prune atomic NPC");
    try {
      for (let index = 0; index < 150; index++) store.addMemory(npc.name, memory(index, 9));
      for (let index = 150; index < 200; index++) store.addMemory(npc.name, memory(index, 1));
      const beforeStore = store.exportSnapshot();
      const beforeRuntime = npc.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      store.raw.run(`
        CREATE TRIGGER reject_npc_memory_prune
        BEFORE DELETE ON npc_memories
        BEGIN
          SELECT RAISE(ABORT, 'test memory prune failure');
        END
      `);

      expect(() => npc.remember(memory(201, 10))).toThrow("test memory prune failure");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(store.exportSnapshot().sequences.npc_memories).toBe(beforeStore.sequences.npc_memories);
      expect(npc.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("keeps the successful durable-retention and in-memory 50-to-40 behavior", () => {
    const { store, npc } = registeredPersistentAgent("retention success NPC");
    try {
      for (let index = 0; index < 51; index++) npc.remember(memory(index, index === 0 ? 1 : 9));

      expect(npc.getRecentMemories(100)).toHaveLength(40);
      expect(npc.getRecentMemories(100).every((entry) => entry.importance === 9)).toBe(true);

      for (let index = 51; index < 151; index++) store.addMemory(npc.name, memory(index, 9));
      for (let index = 151; index < 200; index++) store.addMemory(npc.name, memory(index, 1));
      npc.remember(memory(200, 10));

      // The durable policy retains all entries tied at the top-100 threshold;
      // it is deliberately not a hard 100-row cap.
      expect(store.countMemories(npc.name)).toBe(151);
      expect(store.getRecentMemories(npc.name, 300).every((entry) => entry.importance >= 9)).toBe(true);
      expect(npc.getRecentMemories(100)).toHaveLength(41);
      expect(npc.getRecentMemories(100)[0]?.importance).toBe(9);
    } finally {
      store.close();
    }
  });

  it("still appends in memory when no durable store is configured", () => {
    const npc = new NPCAgent(personality("memory-only NPC"), replyingLLM);
    npc.remember(memory(1, 3));
    expect(npc.getRecentMemories()).toEqual([memory(1, 3)]);
  });

  it("keeps the existing speakUp LLM-failure template path memory-free", async () => {
    const npc = new NPCAgent(personality("failed speak-up NPC"), {
      chat: async () => { throw new Error("provider unavailable"); },
    });

    await expect(npc.speakUp("A sound in the dark.")).resolves.toEqual(expect.any(String));
    expect(npc.getRecentMemories()).toEqual([]);
  });

  it("uses private store cores instead of dispatching legacy public memory wrappers", () => {
    const { store, npc } = registeredPersistentAgent("private durable core NPC");
    try {
      for (let index = 0; index < 150; index++) store.addMemory(npc.name, memory(index, 9));
      for (let index = 150; index < 200; index++) store.addMemory(npc.name, memory(index, 1));
      const legacyWrapper = () => { throw new Error("legacy public store wrapper must not be dispatched"); };
      Object.defineProperties(store, {
        addMemory: { value: legacyWrapper },
        countMemories: { value: legacyWrapper },
        pruneMemories: { value: legacyWrapper },
      });

      expect(() => npc.remember(memory(201, 10))).not.toThrow();
      expect(store.raw.query("SELECT COUNT(*) AS count FROM npc_memories WHERE npc_id = ?").get(npc.name)).toEqual({ count: 151 });
    } finally {
      store.close();
    }
  });
});
