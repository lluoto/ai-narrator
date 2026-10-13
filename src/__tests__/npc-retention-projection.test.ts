import { describe, expect, it } from "bun:test";
import { AgentRegistry, fanoutAgentRegistryMessageForHost } from "../agent/agent-registry";
import type { MemoryEntry, NPCPersonality } from "../agent/types";
import { GameSession } from "../api/game-session";
import {
  ordinaryGameSessionSnapshotHash,
  validateOrdinaryGameSessionSnapshot,
  type OrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";
import { NPCStore, appendNPCStoreMemoryBatchForHost } from "../db";
import { npcStoreSnapshotHash } from "../db/npc-store-snapshot";
import { PlayerSession } from "../session/player-session";

const llm = { chat: async () => "unused" };

function personality(name: string): NPCPersonality {
  return {
    name,
    role: "witness",
    personality: "careful",
    background: "retention projection fixture",
    goals: [],
    speech_style: "brief",
    knowledge: [],
    secrets: [],
  };
}

function memory(content: string, index: number, importance: number): MemoryEntry {
  return {
    timestamp: 1_730_000_000_000 + index,
    type: "event",
    content,
    importance,
  };
}

function resign(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function resignNPCStore(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { hash: _discarded, ...unsigned } = snapshot.npcStore;
  snapshot.npcStore = { ...unsigned, hash: npcStoreSnapshotHash(unsigned) };
  return resign(snapshot);
}

function freshOrdinarySession(id: string): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "development_fallback",
  );
}

function ordinaryEnvelopeFromCohort(
  registry: AgentRegistry,
  store: NPCStore,
  id: string,
): OrdinaryGameSessionSnapshot {
  const source = freshOrdinarySession(id);
  try {
    const envelope = structuredClone(source.exportOrdinarySessionSnapshot());
    envelope.npcStore = store.exportSnapshot();
    envelope.agentRegistry = registry.exportSnapshot();
    return resignNPCStore(envelope);
  } finally {
    source.close();
  }
}

function expectOrdinaryCohortRestores(
  registry: AgentRegistry,
  store: NPCStore,
  id: string,
): void {
  const envelope = ordinaryEnvelopeFromCohort(registry, store, id);
  const target = freshOrdinarySession(id);
  try {
    expect(validateOrdinaryGameSessionSnapshot(envelope).agentRegistry)
      .toEqual(envelope.agentRegistry);
    target.restoreOrdinarySessionSnapshot(envelope);
    expect(target.exportOrdinarySessionSnapshot().agentRegistry)
      .toEqual(envelope.agentRegistry);
  } finally {
    target.close();
  }
}

function rememberRetainedHighHistory(
  registry: AgentRegistry,
  name: string,
): void {
  const agent = registry.get(name);
  if (!agent) throw new Error("retention fixture agent is missing");
  for (let index = 0; index < 200; index++) {
    agent.remember(memory(`${name}-high-${index}`, index, 10));
  }
}

function expectNoLiveOnlyTail(
  store: NPCStore,
  registry: AgentRegistry,
  name: string,
  tail: string,
): void {
  const agent = registry.get(name);
  if (!agent) throw new Error("retention fixture agent is missing");
  expect(store.countMemories(name)).toBe(200);
  expect(store.getRecentMemories(name, 500).some((entry) => entry.content === tail)).toBe(false);
  const live = agent.getRecentMemories(100);
  expect(live).toHaveLength(46);
  expect(live.some((entry) => entry.content === tail)).toBe(false);
}

describe("NPC durable retention projection", () => {
  it("keeps the established bounded candidate semantics without a durable store", () => {
    const registry = new AgentRegistry(llm);
    const name = "memory-only-retention";
    const agent = registry.register(personality(name));
    const tail = "memory-only-low-tail";

    rememberRetainedHighHistory(registry, name);
    agent.remember(memory(tail, 201, 1));

    const live = agent.getRecentMemories(100);
    expect(live).toHaveLength(47);
    expect(live.some((entry) => entry.content === tail)).toBe(true);
  });

  it("projects public remember through the durable retained cohort before ordinary snapshot export", () => {
    const store = new NPCStore(":memory:");
    const registry = new AgentRegistry(llm, store);
    const name = "public-remember-retention";
    const agent = registry.register(personality(name));
    const tail = "public-remember-low-tail";
    try {
      rememberRetainedHighHistory(registry, name);
      agent.remember(memory(tail, 201, 1));

      expectNoLiveOnlyTail(store, registry, name, tail);
      expectOrdinaryCohortRestores(registry, store, "ordinary-retention-public-remember");
    } finally {
      store.close();
    }
  });

  it("rolls back insert, retention delete, live cache, and registry revision when durable projection validation fails", () => {
    const store = new NPCStore(":memory:");
    const registry = new AgentRegistry(llm, store);
    const name = "projection-validation-rollback";
    const agent = registry.register(personality(name));
    const tail = "projection-validation-low-tail";
    try {
      rememberRetainedHighHistory(registry, name);
      store.raw.run(
        "UPDATE npc_memories SET related_entities = 'not-json' WHERE npc_id = ? AND content = ?",
        [name, `${name}-high-0`],
      );
      const beforeRuntime = agent.exportRuntimeState();
      const beforeRevision = registry.semanticRevision;
      const beforeCount = store.countMemories(name);
      const beforeSequence = (store.raw.query(
        "SELECT seq FROM sqlite_sequence WHERE name = 'npc_memories'",
      ).get() as { seq: number } | null)?.seq ?? 0;

      expect(() => agent.remember(memory(tail, 201, 1)))
        .toThrow("NPC durable memory retention projection is invalid");

      expect(store.countMemories(name)).toBe(beforeCount);
      expect((store.raw.query(
        "SELECT seq FROM sqlite_sequence WHERE name = 'npc_memories'",
      ).get() as { seq: number } | null)?.seq ?? 0).toBe(beforeSequence);
      expect(store.raw.query(
        "SELECT COUNT(*) AS count FROM npc_memories WHERE npc_id = ? AND content = ?",
      ).get(name, tail)).toEqual({ count: 0 });
      expect(agent.exportRuntimeState()).toEqual(beforeRuntime);
      expect(registry.semanticRevision).toBe(beforeRevision);
    } finally {
      store.close();
    }
  });

  it("projects a memory-bearing runtime transition through the durable retained cohort", () => {
    const store = new NPCStore(":memory:");
    const registry = new AgentRegistry(llm, store);
    const name = "runtime-transition-retention";
    const agent = registry.register(personality(name));
    const before = Object.getOwnPropertyDescriptor(Math, "random");
    if (!before) throw new Error("Math.random descriptor is required");
    try {
      rememberRetainedHighHistory(registry, name);
      Object.defineProperty(Math, "random", { ...before, value: () => 0 });
      try {
        agent.triggerMood("helped");
      } finally {
        Object.defineProperty(Math, "random", before);
      }

      expectNoLiveOnlyTail(store, registry, name, "情绪变化: neutral → friendly（因为 helped）");
      expect(agent.getMood()).toBe("friendly");
      expectOrdinaryCohortRestores(registry, store, "ordinary-retention-runtime-transition");
    } finally {
      Object.defineProperty(Math, "random", before);
      store.close();
    }
  });

  it("projects every CLI batch recipient from its own durable retained cohort", () => {
    const store = new NPCStore(":memory:");
    const registry = new AgentRegistry(llm, store);
    const alpha = registry.register(personality("fanout-retention-alpha"));
    const bravo = registry.register(personality("fanout-retention-bravo"));
    const session = new PlayerSession(() => "arrival");
    session.join("p1", "Ada", "player");
    const tail = "fanout-low-tail";
    try {
      rememberRetainedHighHistory(registry, bravo.name);
      fanoutAgentRegistryMessageForHost(registry, session, {
        speaker: alpha.name,
        content: tail,
        type: "dialogue",
      });

      expectNoLiveOnlyTail(store, registry, bravo.name, `fanout-retention-alpha说: "${tail}"`);
      expect(store.countMemories(alpha.name)).toBe(0);
      expectOrdinaryCohortRestores(registry, store, "ordinary-retention-cli-fanout");
    } finally {
      store.close();
    }
  });

  it("rolls back a retained CLI batch when its projection consumer rejects before commit", () => {
    const store = new NPCStore(":memory:");
    const registry = new AgentRegistry(llm, store);
    const alpha = registry.register(personality("consumer-rollback-alpha"));
    const bravo = registry.register(personality("consumer-rollback-bravo"));
    const session = new PlayerSession(() => "arrival");
    session.join("p1", "Ada", "player");
    try {
      for (const name of [alpha.name, bravo.name]) {
        for (let index = 0; index < 200; index++) {
          store.addMemory(name, memory(`${name}-retained-${index}`, index, index < 100 ? 9 : 1));
        }
      }
      const beforeStore = store.exportSnapshot();
      const beforeAlpha = alpha.exportRuntimeState();
      const beforeBravo = bravo.exportRuntimeState();
      const beforeRegistry = registry.semanticRevision;
      const beforeSession = session.semanticRevision;
      const beforeHistory = session.getRecentGlobal();
      const alphaReceipt = Object.freeze({});
      const bravoReceipt = Object.freeze({});
      let consumed = 0;

      expect(() => appendNPCStoreMemoryBatchForHost(store, [
        {
          npcId: alpha.name,
          entry: memory("consumer-rollback-alpha-tail", 201, 1),
          receipt: alphaReceipt,
          memoryCacheCandidate: [],
        },
        {
          npcId: bravo.name,
          entry: memory("consumer-rollback-bravo-tail", 201, 1),
          receipt: bravoReceipt,
          memoryCacheCandidate: [],
        },
      ], {
        begin: () => {},
        consume: () => { consumed++; },
        complete: () => { throw new Error("CLI batch projection consumer rejected"); },
      })).toThrow("CLI batch projection consumer rejected");

      expect(consumed).toBe(2);
      expect(store.exportSnapshot()).toEqual(beforeStore);
      expect(alpha.exportRuntimeState()).toEqual(beforeAlpha);
      expect(bravo.exportRuntimeState()).toEqual(beforeBravo);
      expect(registry.semanticRevision).toBe(beforeRegistry);
      expect(session.semanticRevision).toBe(beforeSession);
      expect(session.getRecentGlobal()).toEqual(beforeHistory);
    } finally {
      store.close();
    }
  });
});
