import { describe, expect, it } from "bun:test";
import { NPCAgent } from "../agent/npc-agent";
import { NPCStore } from "../db";
import type { LLMLike } from "../llm/client";

function createPersistentNPC(name = "wrapper NPC", llm: LLMLike = null as any) {
  const personality = {
    name,
    role: "test witness",
    personality: "careful",
    background: "test fixture",
    goals: [],
    speech_style: "brief",
    knowledge: [],
    secrets: [],
  };
  const store = new NPCStore(":memory:");
  store.savePersonality(personality);
  return { store, npc: new NPCAgent(personality, llm, store) };
}

describe("NPCAgent legacy memory wrappers", () => {
  it("continues to append dialogue and event memories through the private core", () => {
    const { store, npc } = createPersistentNPC();

    try {
      npc.rememberDialogue("investigator", "What did you see?", 4);
      npc.rememberEvent("The door opened.", 8);

      expect(npc.getRecentMemories(2)).toEqual([
        expect.objectContaining({ type: "dialogue", importance: 4 }),
        expect.objectContaining({ type: "event", importance: 8 }),
      ]);
      expect(store.countMemories(npc.name)).toBe(2);
    } finally {
      store.close();
    }
  });

  it("keeps mood event and state persistence off public wrapper dispatch", () => {
    const { store, npc } = createPersistentNPC("mood wrapper NPC");
    const prototype = NPCAgent.prototype;
    const rememberEventDescriptor = Object.getOwnPropertyDescriptor(prototype, "rememberEvent");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    expect(rememberEventDescriptor).toBeDefined();
    expect(randomDescriptor).toBeDefined();

    try {
      Object.defineProperty(prototype, "rememberEvent", {
        ...rememberEventDescriptor,
        value: () => {},
      });
      Object.defineProperty(Math, "random", {
        ...randomDescriptor,
        value: () => 0,
      });

      npc.triggerMood("helped");

      expect(npc.getMood()).toBe("friendly");
      expect(npc.getRecentMemories(1)[0]).toEqual(expect.objectContaining({ type: "event" }));
      expect(store.countMemories(npc.name)).toBe(1);
      expect(store.getState(npc.name)?.mood).toBe("friendly");
    } finally {
      try {
        Object.defineProperty(Math, "random", randomDescriptor!);
      } finally {
        Object.defineProperty(prototype, "rememberEvent", rememberEventDescriptor!);
      }
      store.close();
    }
  });

  it("keeps recordInteraction state, mood, and persistence off public wrapper dispatch", () => {
    const { store, npc } = createPersistentNPC("interaction wrapper NPC");
    const prototype = NPCAgent.prototype;
    const adjustRelationshipDescriptor = Object.getOwnPropertyDescriptor(prototype, "adjustRelationship");
    const triggerMoodDescriptor = Object.getOwnPropertyDescriptor(prototype, "triggerMood");
    const rememberEventDescriptor = Object.getOwnPropertyDescriptor(prototype, "rememberEvent");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");

    try {
      expect(adjustRelationshipDescriptor).toBeDefined();
      expect(triggerMoodDescriptor).toBeDefined();
      expect(rememberEventDescriptor).toBeDefined();
      expect(randomDescriptor).toBeDefined();
      const legacyDispatch = () => { throw new Error("legacy public state wrapper must not be dispatched internally"); };
      Object.defineProperty(prototype, "adjustRelationship", { ...adjustRelationshipDescriptor, value: legacyDispatch });
      Object.defineProperty(prototype, "triggerMood", { ...triggerMoodDescriptor, value: legacyDispatch });
      Object.defineProperty(prototype, "rememberEvent", { ...rememberEventDescriptor, value: legacyDispatch });
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });

      npc.recordInteraction(true);
      npc.recordInteraction(true);
      npc.recordInteraction(true);

      expect(npc.exportRuntimeState()).toEqual(expect.objectContaining({
        mood: "friendly",
        relationship: 1.5,
        playerInteractionCount: 3,
        memories: [expect.objectContaining({ type: "event" })],
      }));
      expect(store.getRelationship(npc.name, "player")).toBe(1.5);
      expect(store.getState(npc.name)).toEqual(expect.objectContaining({
        mood: "friendly",
        relationship: 1.5,
        interactionCount: 3,
      }));
      expect(store.getRecentMemories(npc.name, 1)[0]).toEqual(expect.objectContaining({
        type: "event",
        content: expect.stringContaining("repeated_kindness"),
      }));
    } finally {
      try {
        Object.defineProperty(Math, "random", randomDescriptor!);
      } finally {
        try {
          Object.defineProperty(prototype, "rememberEvent", rememberEventDescriptor!);
        } finally {
          try {
            Object.defineProperty(prototype, "triggerMood", triggerMoodDescriptor!);
          } finally {
            Object.defineProperty(prototype, "adjustRelationship", adjustRelationshipDescriptor!);
          }
        }
      }
      store.close();
    }
  });

  it("keeps combat and horror mood transitions off public triggerMood dispatch", () => {
    const combat = createPersistentNPC("combat wrapper NPC");
    const horror = createPersistentNPC("horror wrapper NPC");
    const prototype = NPCAgent.prototype;
    const triggerMoodDescriptor = Object.getOwnPropertyDescriptor(prototype, "triggerMood");
    const rememberEventDescriptor = Object.getOwnPropertyDescriptor(prototype, "rememberEvent");
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");

    try {
      expect(triggerMoodDescriptor).toBeDefined();
      expect(rememberEventDescriptor).toBeDefined();
      expect(randomDescriptor).toBeDefined();
      const legacyDispatch = () => { throw new Error("legacy public mood wrapper must not be dispatched internally"); };
      Object.defineProperty(prototype, "triggerMood", { ...triggerMoodDescriptor, value: legacyDispatch });
      Object.defineProperty(prototype, "rememberEvent", { ...rememberEventDescriptor, value: legacyDispatch });
      Object.defineProperty(Math, "random", { ...randomDescriptor, value: () => 0 });

      combat.npc.handleCombatOutcome(true);
      horror.npc.handleWitnessHorror();

      expect(combat.npc.exportRuntimeState()).toEqual(expect.objectContaining({
        mood: "excited",
        memories: [expect.objectContaining({ type: "event", content: expect.stringContaining("combat_win") })],
      }));
      expect(combat.store.getState(combat.npc.name)?.mood).toBe("excited");
      expect(combat.store.getRecentMemories(combat.npc.name, 1)[0]).toEqual(expect.objectContaining({ type: "event" }));
      expect(horror.npc.exportRuntimeState()).toEqual(expect.objectContaining({
        mood: "fearful",
        memories: [expect.objectContaining({ type: "event", content: expect.stringContaining("witnessed_horror") })],
      }));
      expect(horror.store.getState(horror.npc.name)?.mood).toBe("fearful");
      expect(horror.store.getRecentMemories(horror.npc.name, 1)[0]).toEqual(expect.objectContaining({ type: "event" }));
    } finally {
      try {
        Object.defineProperty(Math, "random", randomDescriptor!);
      } finally {
        try {
          Object.defineProperty(prototype, "rememberEvent", rememberEventDescriptor!);
        } finally {
          Object.defineProperty(prototype, "triggerMood", triggerMoodDescriptor!);
        }
      }
      combat.store.close();
      horror.store.close();
    }
  });

  it("persists a speakUp dialogue when legacy public memory wrappers are patched", async () => {
    const { store, npc } = createPersistentNPC("speak-up wrapper NPC", {
      chat: async () => "The barn is quiet.",
    });
    const before = store.countMemories(npc.name);
    const prototype = NPCAgent.prototype;
    const rememberDescriptor = Object.getOwnPropertyDescriptor(prototype, "remember");
    const rememberDialogueDescriptor = Object.getOwnPropertyDescriptor(prototype, "rememberDialogue");
    expect(rememberDescriptor).toBeDefined();
    expect(rememberDialogueDescriptor).toBeDefined();

    try {
      Object.defineProperty(prototype, "remember", {
        ...rememberDescriptor,
        value: () => {},
      });
      Object.defineProperty(prototype, "rememberDialogue", {
        ...rememberDialogueDescriptor,
        value: () => {},
      });

      const reply = await npc.speakUp("A distant sound interrupts the conversation.");

      expect(reply.length).toBeGreaterThan(0);
      expect(store.countMemories(npc.name)).toBe(before + 1);
      expect(npc.getRecentMemories(1)[0]).toEqual(expect.objectContaining({ type: "dialogue", importance: 6 }));
    } finally {
      try {
        Object.defineProperty(prototype, "rememberDialogue", rememberDialogueDescriptor!);
      } finally {
        Object.defineProperty(prototype, "remember", rememberDescriptor!);
      }
      store.close();
    }
  });
});
