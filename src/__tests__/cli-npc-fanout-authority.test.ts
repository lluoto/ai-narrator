import { describe, expect, it } from "bun:test";
import { AgentRegistry, fanoutAgentRegistryMessageForHost } from "../agent/agent-registry";
import {
  NPCAgent,
  discardPreparedNPCAgentMemoryAppendForHost,
  getPreparedNPCAgentMemoryAppendDetails,
  prepareNPCAgentMemoryAppendForHost,
  publishPreparedNPCAgentMemoryAppendForHost,
  sealPreparedNPCAgentMemoryAppendForHost,
} from "../agent/npc-agent";
import type { AgentMessage, MemoryEntry, NPCPersonality } from "../agent/types";
import { NPCStore } from "../db";
import {
  PlayerSession,
  commitPreparedPlayerSessionPushForHost,
  discardPreparedPlayerSessionPushForHost,
  preparePlayerSessionPushForHost,
  sealPreparedPlayerSessionPushForHost,
} from "../session/player-session";

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

function createFixture() {
  const store = new NPCStore(":memory:");
  const registry = new AgentRegistry({ chat: async () => "unused" }, store);
  const alpha = registry.register(personality("alpha"));
  const bravo = registry.register(personality("bravo"));
  const session = new PlayerSession(() => "arrival");
  session.join("p1", "Ada", "player");
  return { store, registry, alpha, bravo, session };
}

const memory = (content: string): MemoryEntry => ({
  timestamp: 1_700_000_000_000,
  type: "observation",
  content,
  importance: 5,
});

function createDirectAgent(name: string, hostToken: object): NPCAgent {
  return new NPCAgent(personality(name), { chat: async () => "unused" }, undefined, undefined, hostToken);
}

function restoreOwnProperty(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(object, key, descriptor);
  else delete (object as Record<PropertyKey, unknown>)[key];
}

describe("CLI NPC message fanout authority", () => {
  it("does not dispatch CLI dialogue or narration through replaceable NPCAgent memory wrappers", () => {
    const { store, registry, alpha, bravo, session } = createFixture();
    const prototype = NPCAgent.prototype;
    const dialogue = Object.getOwnPropertyDescriptor(prototype, "rememberDialogue");
    const event = Object.getOwnPropertyDescriptor(prototype, "rememberEvent");
    const registryPrototype = Object.getOwnPropertyDescriptor(AgentRegistry.prototype, "fanoutMessage");
    const playerSessionPrototype = Object.getOwnPropertyDescriptor(PlayerSession.prototype, "push");
    expect(dialogue).toBeDefined();
    expect(event).toBeDefined();
    expect(registryPrototype).toBeUndefined();
    expect(Object.hasOwn(registry, "fanoutMessage")).toBe(false);
    expect(playerSessionPrototype).toBeDefined();

    try {
      const blocked = () => { throw new Error("CLI must not dispatch public NPC memory wrappers"); };
      Object.defineProperty(prototype, "rememberDialogue", { ...dialogue, value: blocked });
      Object.defineProperty(prototype, "rememberEvent", { ...event, value: blocked });
      Object.defineProperty(alpha, "rememberDialogue", {
        value: blocked,
        configurable: true,
      });
      Object.defineProperty(AgentRegistry.prototype, "fanoutMessage", {
        value: blocked,
        configurable: true,
      });
      Object.defineProperty(registry, "fanoutMessage", {
        value: blocked,
        configurable: true,
      });
      Object.defineProperty(PlayerSession.prototype, "push", {
        ...playerSessionPrototype,
        value: blocked,
      });
      Object.defineProperty(session, "push", {
        value: blocked,
        configurable: true,
      });

      fanoutAgentRegistryMessageForHost(
        registry,
        session,
        { speaker: "investigator", content: "What did you see?", type: "dialogue" },
      );
      fanoutAgentRegistryMessageForHost(
        registry,
        session,
        { speaker: "KP", content: "A door opens.", type: "narration" },
      );

      for (const npc of [alpha, bravo]) {
        expect(npc.getRecentMemories(2)).toEqual([
          expect.objectContaining({ type: "dialogue", content: 'investigator说: "What did you see?"', importance: 5 }),
          expect.objectContaining({ type: "event", content: "A door opens.", importance: 7 }),
        ]);
        expect(store.countMemories(npc.name)).toBe(2);
      }
      expect(session.getRecentGlobal(2)).toHaveLength(2);
    } finally {
      try {
        Object.defineProperty(prototype, "rememberDialogue", dialogue!);
      } finally {
        Object.defineProperty(prototype, "rememberEvent", event!);
        delete (alpha as any).rememberDialogue;
        delete (registry as any).fanoutMessage;
        delete (session as any).push;
        Object.defineProperty(PlayerSession.prototype, "push", playerSessionPrototype!);
        if (registryPrototype) Object.defineProperty(AgentRegistry.prototype, "fanoutMessage", registryPrototype);
        else delete (AgentRegistry.prototype as any).fanoutMessage;
      }
      store.close();
    }
  });

  it("leaves all live and durable recipients plus PlayerSession untouched when the second fanout insert fails", () => {
    const { store, registry, alpha, bravo, session } = createFixture();
    const beforeStore = store.exportSnapshot();
    const beforeRegistry = registry.semanticRevision;
    const beforeHistory = session.getRecentGlobal(20);
    const beforeSession = session.semanticRevision;
    const beforeAlpha = alpha.exportRuntimeState();
    const beforeBravo = bravo.exportRuntimeState();
    store.raw.run(`
      CREATE TRIGGER reject_bravo_cli_fanout_memory
      BEFORE INSERT ON npc_memories
      WHEN NEW.npc_id = 'bravo'
      BEGIN
        SELECT RAISE(ABORT, 'second CLI recipient rejected');
      END
    `);

    try {
      expect(() => fanoutAgentRegistryMessageForHost(
        registry,
        session,
        { speaker: "KP", content: "The floor groans.", type: "narration" },
      )).toThrow("second CLI recipient rejected");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(alpha.exportRuntimeState()).toEqual(beforeAlpha);
      expect(bravo.exportRuntimeState()).toEqual(beforeBravo);
      expect(registry.semanticRevision).toBe(beforeRegistry);
      expect(session.getRecentGlobal(20)).toEqual(beforeHistory);
      expect(session.semanticRevision).toBe(beforeSession);
    } finally {
      store.close();
    }
  });

  it("keeps durable, live, registry, and session fanout coherent despite readonly legacy own-property decoys", () => {
    const { store, registry, alpha, bravo, session } = createFixture();
    const priorMemories = Object.getOwnPropertyDescriptor(alpha, "memories")!;
    const priorGlobalMessages = Object.getOwnPropertyDescriptor(session, "globalMessages")!;
    const priorSessionRevision = Object.getOwnPropertyDescriptor(session, "semanticMutationRevision")!;
    const beforeRegistry = registry.semanticRevision;
    const beforeSession = session.semanticRevision;

    try {
      Object.defineProperty(alpha, "memories", {
        value: Object.freeze([]), writable: false, configurable: true,
      });
      Object.defineProperty(session, "globalMessages", {
        value: Object.freeze([]), writable: false, configurable: true,
      });
      Object.defineProperty(session, "semanticMutationRevision", {
        value: 0n, writable: false, configurable: true,
      });

      expect(() => fanoutAgentRegistryMessageForHost(
        registry,
        session,
        { speaker: "KP", content: "The floor groans.", type: "narration" },
      )).not.toThrow();

      expect(store.countMemories("alpha")).toBe(1);
      expect(store.countMemories("bravo")).toBe(1);
      expect(alpha.getRecentMemories(1)[0]).toEqual(expect.objectContaining({ content: "The floor groans." }));
      expect(bravo.getRecentMemories(1)[0]).toEqual(expect.objectContaining({ content: "The floor groans." }));
      expect(registry.semanticRevision).toBe(beforeRegistry + 2n);
      expect(session.getRecentGlobal(1)[0]).toEqual(expect.objectContaining({ content: "The floor groans." }));
      expect(session.semanticRevision).toBe(beforeSession + 1n);
    } finally {
      restoreOwnProperty(alpha, "memories", priorMemories);
      restoreOwnProperty(session, "globalMessages", priorGlobalMessages);
      restoreOwnProperty(session, "semanticMutationRevision", priorSessionRevision);
      store.close();
    }
  });

  it("rolls back every recipient and sqlite sequence when later recipient retention pruning rejects", () => {
    const { store, registry, alpha, bravo, session } = createFixture();
    const retained = (npcId: string) => Array.from({ length: 200 }, (_, index) => ({
      ...memory(`${npcId} retained ${index}`),
      timestamp: 1_700_000_000_000 + index,
      importance: index < 100 ? 9 : 1,
    }));
    store.addMemories("alpha", retained("alpha"));
    store.addMemories("bravo", retained("bravo"));
    const beforeStore = store.exportSnapshot();
    const beforeAlpha = alpha.exportRuntimeState();
    const beforeBravo = bravo.exportRuntimeState();
    const beforeRegistry = registry.semanticRevision;
    const beforeHistory = session.getRecentGlobal();
    const beforeSession = session.semanticRevision;
    store.raw.run(`
      CREATE TRIGGER reject_bravo_cli_fanout_prune
      BEFORE DELETE ON npc_memories
      WHEN OLD.npc_id = 'bravo'
      BEGIN
        SELECT RAISE(ABORT, 'later CLI retention prune rejected');
      END
    `);

    try {
      expect(() => fanoutAgentRegistryMessageForHost(
        registry,
        session,
        { speaker: "KP", content: "The walls tremble.", type: "narration" },
      )).toThrow("later CLI retention prune rejected");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(alpha.exportRuntimeState()).toEqual(beforeAlpha);
      expect(bravo.exportRuntimeState()).toEqual(beforeBravo);
      expect(registry.semanticRevision).toBe(beforeRegistry);
      expect(session.getRecentGlobal()).toEqual(beforeHistory);
      expect(session.semanticRevision).toBe(beforeSession);
    } finally {
      store.close();
    }
  });

  it("uses registry map keys and internal store identity despite public agent name and db decoys", () => {
    const { store, registry, alpha, bravo, session } = createFixture();
    const priorName = Object.getOwnPropertyDescriptor(alpha, "name")!;
    const priorDB = Object.getOwnPropertyDescriptor(alpha, "db")!;
    const priorBravoName = Object.getOwnPropertyDescriptor(bravo, "name")!;
    const priorBravoDB = Object.getOwnPropertyDescriptor(bravo, "db")!;

    try {
      Object.defineProperty(alpha, "name", { value: "spoof", writable: false, configurable: true });
      Object.defineProperty(alpha, "db", { value: undefined, writable: false, configurable: true });
      Object.defineProperty(bravo, "name", { value: "also-spoof", writable: false, configurable: true });
      Object.defineProperty(bravo, "db", { value: undefined, writable: false, configurable: true });

      expect(() => fanoutAgentRegistryMessageForHost(
        registry,
        session,
        { speaker: "alpha", content: "Keep this private.", type: "dialogue" },
      )).not.toThrow();

      expect(store.countMemories("alpha")).toBe(0);
      expect(store.countMemories("bravo")).toBe(1);
      expect(bravo.getRecentMemories(1)[0]).toEqual(expect.objectContaining({
        content: 'alpha说: "Keep this private."',
      }));
    } finally {
      restoreOwnProperty(alpha, "name", priorName);
      restoreOwnProperty(alpha, "db", priorDB);
      restoreOwnProperty(bravo, "name", priorBravoName);
      restoreOwnProperty(bravo, "db", priorBravoDB);
      store.close();
    }
  });

  it("plans explicit shared recipient timestamps and preserves speaker exclusion without a durable store", () => {
    const registry = new AgentRegistry({ chat: async () => "unused" });
    const alpha = registry.register(personality("alpha"));
    const bravo = registry.register(personality("bravo"));
    const session = new PlayerSession(() => "arrival");
    session.join("p1", "Ada", "player");
    const beforeRevision = registry.semanticRevision;
    const now = Object.getOwnPropertyDescriptor(Date, "now");
    expect(now).toBeDefined();
    let tick = 1_700_000_000_000;

    try {
      Object.defineProperty(Date, "now", { ...now, value: () => tick++ });
      fanoutAgentRegistryMessageForHost(
        registry,
        session,
        { speaker: "alpha", content: "Keep this between us.", type: "dialogue" },
      );

      expect(alpha.getRecentMemories()).toEqual([]);
      expect(bravo.getRecentMemories()).toEqual([
        expect.objectContaining({
          type: "dialogue",
          content: 'alpha说: "Keep this between us."',
          importance: 5,
          timestamp: 1_700_000_000_001,
        }),
      ]);
      expect(session.getRecentGlobal(1)[0]).toEqual(expect.objectContaining({
        speaker: "alpha",
        timestamp: 1_700_000_000_000,
      }));
      expect(registry.semanticRevision).toBe(beforeRevision + 1n);
    } finally {
      Object.defineProperty(Date, "now", now!);
    }
  });

  it("does not lend a registry-owned agent's private durable host plan or store to an external caller", () => {
    const { store, registry, alpha, bravo, session } = createFixture();
    const beforeStore = store.exportSnapshot();
    const beforeAlpha = alpha.exportRuntimeState();
    const beforeBravo = bravo.exportRuntimeState();
    const beforeRegistry = registry.semanticRevision;
    const beforeSession = session.semanticRevision;
    const attackerToken = Object.freeze({});

    try {
      expect(() => prepareNPCAgentMemoryAppendForHost(alpha, attackerToken, memory("untrusted plan")))
        .toThrow("NPCAgent host memory capability is unavailable");
      expect(() => getPreparedNPCAgentMemoryAppendDetails(attackerToken, Object.freeze({}) as any))
        .toThrow("NPCAgent host memory plan is unavailable");

      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(alpha.exportRuntimeState()).toEqual(beforeAlpha);
      expect(bravo.exportRuntimeState()).toEqual(beforeBravo);
      expect(registry.semanticRevision).toBe(beforeRegistry);
      expect(session.semanticRevision).toBe(beforeSession);
    } finally {
      store.close();
    }
  });

  it("fails closed for wrong, unsealed, and double NPC prepared-plan consumes", () => {
    const hostToken = Object.freeze({});
    const alpha = createDirectAgent("alpha", hostToken);
    const bravo = createDirectAgent("bravo", hostToken);
    const initialAlpha = alpha.exportRuntimeState();
    const initialBravo = bravo.exportRuntimeState();

    const wrongPlan = prepareNPCAgentMemoryAppendForHost(alpha, hostToken, memory("wrong target"));
    expect(() => getPreparedNPCAgentMemoryAppendDetails(Object.freeze({}), wrongPlan))
      .toThrow("NPCAgent host memory plan is unavailable");
    sealPreparedNPCAgentMemoryAppendForHost(alpha, hostToken, wrongPlan);
    expect(() => publishPreparedNPCAgentMemoryAppendForHost(bravo, hostToken, wrongPlan))
      .toThrow("NPCAgent host memory plan is unavailable");
    expect(alpha.exportRuntimeState()).toEqual(initialAlpha);
    expect(bravo.exportRuntimeState()).toEqual(initialBravo);
    discardPreparedNPCAgentMemoryAppendForHost(alpha, hostToken, wrongPlan);

    const unsealedPlan = prepareNPCAgentMemoryAppendForHost(alpha, hostToken, memory("unsealed"));
    expect(() => publishPreparedNPCAgentMemoryAppendForHost(alpha, hostToken, unsealedPlan))
      .toThrow("NPCAgent host memory plan is unavailable");
    expect(alpha.exportRuntimeState()).toEqual(initialAlpha);
    discardPreparedNPCAgentMemoryAppendForHost(alpha, hostToken, unsealedPlan);

    const oneShotPlan = prepareNPCAgentMemoryAppendForHost(alpha, hostToken, memory("one shot"));
    sealPreparedNPCAgentMemoryAppendForHost(alpha, hostToken, oneShotPlan);
    publishPreparedNPCAgentMemoryAppendForHost(alpha, hostToken, oneShotPlan);
    const afterFirstConsume = alpha.exportRuntimeState();
    expect(() => publishPreparedNPCAgentMemoryAppendForHost(alpha, hostToken, oneShotPlan))
      .toThrow("NPCAgent host memory plan is unavailable");
    expect(alpha.exportRuntimeState()).toEqual(afterFirstConsume);
    expect(bravo.exportRuntimeState()).toEqual(initialBravo);
  });

  it("fails closed for wrong, unsealed, and double PlayerSession prepared-plan commits", () => {
    const left = new PlayerSession(() => "arrival");
    const right = new PlayerSession(() => "arrival");
    left.join("left", "Ada", "left");
    right.join("right", "Bea", "right");
    const message: AgentMessage = { speaker: "KP", content: "Careful.", type: "narration" };
    const initialLeftHistory = left.getRecentGlobal();
    const initialRightHistory = right.getRecentGlobal();
    const initialLeftRevision = left.semanticRevision;
    const initialRightRevision = right.semanticRevision;

    const wrongPlan = preparePlayerSessionPushForHost(left, message);
    sealPreparedPlayerSessionPushForHost(left, wrongPlan);
    expect(() => commitPreparedPlayerSessionPushForHost(right, wrongPlan))
      .toThrow("PlayerSession host push plan is unavailable");
    expect(left.getRecentGlobal()).toEqual(initialLeftHistory);
    expect(right.getRecentGlobal()).toEqual(initialRightHistory);
    expect(left.semanticRevision).toBe(initialLeftRevision);
    expect(right.semanticRevision).toBe(initialRightRevision);
    discardPreparedPlayerSessionPushForHost(left, wrongPlan);

    const unsealedPlan = preparePlayerSessionPushForHost(left, message);
    expect(() => commitPreparedPlayerSessionPushForHost(left, unsealedPlan))
      .toThrow("PlayerSession host push plan is unavailable");
    expect(left.getRecentGlobal()).toEqual(initialLeftHistory);
    expect(left.semanticRevision).toBe(initialLeftRevision);
    discardPreparedPlayerSessionPushForHost(left, unsealedPlan);

    const oneShotPlan = preparePlayerSessionPushForHost(left, message);
    sealPreparedPlayerSessionPushForHost(left, oneShotPlan);
    commitPreparedPlayerSessionPushForHost(left, oneShotPlan);
    const afterFirstHistory = left.getRecentGlobal();
    const afterFirstRevision = left.semanticRevision;
    expect(() => commitPreparedPlayerSessionPushForHost(left, oneShotPlan))
      .toThrow("PlayerSession host push plan is unavailable");
    expect(left.getRecentGlobal()).toEqual(afterFirstHistory);
    expect(left.semanticRevision).toBe(afterFirstRevision);
  });

  it("canonicalizes an accessor message once before planning both session and NPC memory", () => {
    const { store, registry, alpha, bravo, session } = createFixture();
    const reads = { speaker: 0, content: 0, type: 0 };
    const statefulMessage = Object.defineProperties({}, {
      speaker: { enumerable: true, get: () => (++reads.speaker === 1 ? "Ada" : "spoof") },
      content: { enumerable: true, get: () => (++reads.content === 1 ? "The bell rings" : "mismatch") },
      type: { enumerable: true, get: () => (++reads.type === 1 ? "dialogue" : "narration") },
    }) as AgentMessage;

    try {
      fanoutAgentRegistryMessageForHost(registry, session, statefulMessage);

      expect(reads).toEqual({ speaker: 1, content: 1, type: 1 });
      expect(session.getRecentGlobal(1)[0]).toEqual(expect.objectContaining({
        speaker: "Ada", content: "The bell rings", type: "dialogue",
      }));
      for (const npc of [alpha, bravo]) {
        expect(npc.getRecentMemories(1)[0]).toEqual(expect.objectContaining({
          type: "dialogue", content: 'Ada说: "The bell rings"', importance: 5,
        }));
      }
    } finally {
      store.close();
    }
  });
});
