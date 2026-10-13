import { describe, expect, it } from "bun:test";
import type { LLMLike, Message } from "../llm/client";
import { AgentRegistry } from "../agent/agent-registry";
import { NPCAgent } from "../agent/npc-agent";
import type { MemoryEntry, NPCPersonality } from "../agent/types";
import { NPCStore } from "../db/index";

class RecordingLLM implements LLMLike {
  readonly calls: Message[][] = [];

  async chat(messages: Message[]): Promise<string> {
    this.calls.push(messages.map((message) => ({ ...message })));
    return "我记得这些事。";
  }
}

function personality(name: string): NPCPersonality {
  return {
    name,
    role: "调查员的老友",
    personality: "谨慎而热心",
    background: "在港口经营旧书店。",
    goals: ["保护朋友", "找回失书"],
    speech_style: "简洁、带些书卷气",
    knowledge: ["港口传闻", "旧书目录"],
    secrets: ["知道地下室入口"],
    attitudes: { 玩家: "愿意协助" },
    ruleset: "cosmic-horror",
    traits: {
      courage: 7,
      friendliness: 8,
      suspicion: 4,
      curiosity: 9,
      stability: 6,
    },
    factions: [{ name: "港口书商", loyalty: 8 }],
    initialMood: "calm",
  };
}

function memory(index: number): MemoryEntry {
  return {
    timestamp: 1_700_000_000_000 + index,
    type: index % 2 === 0 ? "observation" : "event",
    content: `memory-${index}`,
    importance: (index % 10) + 1,
    scene_id: `scene-${index % 3}`,
    related_entities: ["玩家", `entity-${index}`],
    is_summary: index % 2 === 0,
  };
}

describe("AgentRegistry runtime snapshots", () => {
  it("round-trips complete portable agent state in insertion order without serializing dependencies", async () => {
    const sourceLLM = new RecordingLLM();
    const source = new AgentRegistry(sourceLLM);
    const beta = source.register(personality("贝塔"));
    const alpha = source.register(personality("阿尔法"));
    for (let index = 0; index < 22; index++) beta.remember(memory(index));
    beta.adjustRelationship(2.5);
    beta.recordInteraction(false);
    beta.recordInteraction(false);
    alpha.remember({
      timestamp: 1_700_000_100_000,
      type: "decision",
      content: "保存可选字段缺席的记忆",
      importance: 10,
    });

    const snapshot = source.exportSnapshot();
    expect(snapshot).toMatchObject({ kind: "agent-registry", schemaVersion: 1 });
    expect(snapshot.agents.map((entry) => entry.personality.name)).toEqual(["贝塔", "阿尔法"]);
    expect(snapshot.agents[0]!.memories).toEqual(beta.getRecentMemories(100));
    expect(snapshot.agents[0]!.mood).toBe("calm");
    expect(snapshot.agents[0]!.relationship).toBe(2.5);
    expect(snapshot.agents[0]!.playerInteractionCount).toBe(2);

    snapshot.agents[0]!.personality.goals[0] = "篡改导出副本";
    snapshot.agents[0]!.memories[0]!.content = "篡改导出副本";
    expect(beta.personality.goals[0]).toBe("保护朋友");
    expect(beta.getRecentMemories(100)[0]!.content).toBe("memory-0");

    const portable = JSON.parse(JSON.stringify(source.exportSnapshot()));
    const targetLLM = new RecordingLLM();
    const targetDB = new NPCStore(":memory:");
    const dbBoundRestored = new AgentRegistry(targetLLM, targetDB);
    dbBoundRestored.restoreSnapshot(portable);
    expect(targetDB.raw.query("SELECT COUNT(*) AS count FROM npc_personalities").get()).toEqual({ count: 0 });
    expect(targetDB.raw.query("SELECT COUNT(*) AS count FROM npc_memories").get()).toEqual({ count: 0 });

    const restored = new AgentRegistry(targetLLM);
    let restoredHooks = 0;
    restored.onEvent(() => { restoredHooks++; });
    restored.restoreSnapshot(portable);

    expect(restoredHooks).toBe(0);
    expect(restored.getAllNames()).toEqual(["贝塔", "阿尔法"]);
    const restoredBeta = restored.get("贝塔")!;
    expect(restoredBeta).not.toBe(beta);
    expect(restoredBeta.personality).toEqual(beta.personality);
    expect(restoredBeta.getRecentMemories(100)).toEqual(beta.getRecentMemories(100));
    expect(restoredBeta.getMood()).toBe(beta.getMood());
    expect(restoredBeta.getRelationship()).toBe(beta.getRelationship());
    expect(restoredBeta.exportRuntimeState().playerInteractionCount).toBe(2);

    await restoredBeta.respond("请回忆港口的事。");
    expect(sourceLLM.calls).toHaveLength(0);
    expect(targetLLM.calls).toHaveLength(1);
    const memoryWindow = targetLLM.calls[0]![1]!.content;
    expect(memoryWindow).toContain("memory-2");
    expect(memoryWindow).toContain("memory-21");
    expect(memoryWindow).not.toContain("[event] memory-1\n");
    restoredBeta.recordInteraction(true);
    expect(restoredBeta.getRelationship()).toBe(3);
    expect(restoredBeta.exportRuntimeState().playerInteractionCount).toBe(3);
    targetDB.close();
  });

  it("validates the entire snapshot before atomically replacing registry state or emitting hooks", () => {
    const llm = new RecordingLLM();
    const source = new AgentRegistry(llm);
    source.register(personality("源一"));
    source.register(personality("源二"));
    const malformed = JSON.parse(JSON.stringify(source.exportSnapshot())) as {
      agents: Array<{ personality: { name: string } }>;
    };
    malformed.agents[1]!.personality.name = "源一";

    const target = new AgentRegistry(llm);
    target.register(personality("保留的 NPC"));
    let hooks = 0;
    target.onEvent(() => { hooks++; });

    expect(() => target.restoreSnapshot(malformed)).toThrow(/duplicate agent name/);
    expect(target.getAllNames()).toEqual(["保留的 NPC"]);
    expect(hooks).toBe(0);

    const extraKey = JSON.parse(JSON.stringify(source.exportSnapshot())) as Record<string, unknown>;
    extraKey.unexpected = true;
    expect(() => target.restoreSnapshot(extraKey)).toThrow(/unexpected key/);
    expect(target.getAllNames()).toEqual(["保留的 NPC"]);
  });

  it("increments a process-local replacement revision for every successful exact restore, never for invalid input", () => {
    const llm = new RecordingLLM();
    const source = new AgentRegistry(llm);
    source.register(personality("revision-source"));
    const exact = source.exportSnapshot();
    const target = new AgentRegistry(llm);

    expect(target.stateReplacementRevision).toBe(0n);
    expect(target.semanticRevision).toBe(0n);
    target.restoreSnapshot(exact);
    const firstInstalled = target.get("revision-source");
    expect(firstInstalled).toBeDefined();
    expect(target.stateReplacementRevision).toBe(1n);
    expect(target.semanticRevision).toBe(1n);

    target.restoreSnapshot(exact);
    expect(target.stateReplacementRevision).toBe(2n);
    expect(target.semanticRevision).toBe(2n);
    expect(target.get("revision-source")).not.toBe(firstInstalled);

    const invalid = structuredClone(exact) as unknown as Record<string, unknown>;
    invalid.unexpected = true;
    expect(() => target.restoreSnapshot(invalid)).toThrow(/unexpected key/);
    expect(target.stateReplacementRevision).toBe(2n);
    expect(target.semanticRevision).toBe(2n);
    expect(target.getAllNames()).toEqual(["revision-source"]);
  });

  it("tracks only real active registry mutations and never exposes live personality or memory aliases", () => {
    const sourcePersonality = personality("ownership NPC");
    const registry = new AgentRegistry(new RecordingLLM());
    const agent = registry.register(sourcePersonality);
    expect(registry.semanticRevision).toBe(1n);

    sourcePersonality.goals[0] = "mutated caller goal";
    sourcePersonality.traits!.courage = 1;
    expect(agent.personality.goals[0]).toBe("保护朋友");
    expect(agent.personality.traits!.courage).toBe(7);

    const personalityView = agent.personality;
    expect(personalityView).not.toBe(agent.personality);
    expect(Object.isFrozen(personalityView)).toBe(true);
    expect(Object.isFrozen(personalityView.goals)).toBe(true);
    expect(Object.isFrozen(personalityView.traits!)).toBe(true);
    expect(Object.isFrozen(personalityView.attitudes!)).toBe(true);
    expect(Object.isFrozen(personalityView.factions!)).toBe(true);
    expect(Object.isFrozen(personalityView.factions![0]!)).toBe(true);
    expect(() => { personalityView.goals[0] = "forbidden"; }).toThrow(TypeError);
    expect(() => { personalityView.traits!.courage = 1; }).toThrow(TypeError);
    expect(() => { personalityView.attitudes!["玩家"] = "forbidden"; }).toThrow(TypeError);
    expect(() => { personalityView.factions![0]!.loyalty = 0; }).toThrow(TypeError);
    expect(agent.personality.goals[0]).toBe("保护朋友");

    const callerMemory = memory(41);
    agent.remember(callerMemory);
    const afterRemember = registry.semanticRevision;
    callerMemory.related_entities![0] = "caller mutation";
    expect(agent.getRecentMemories(1)[0]!.related_entities![0]).toBe("玩家");

    const memoryView = agent.getRecentMemories(1);
    memoryView[0]!.related_entities![0] = "view mutation";
    expect(agent.getRecentMemories(1)[0]!.related_entities![0]).toBe("玩家");

    agent.restoreRuntimeState(agent.exportRuntimeState());
    agent.adjustRelationship(0);
    expect(registry.semanticRevision).toBe(afterRemember);

    agent.restoreRuntimeState({ ...agent.exportRuntimeState(), mood: "suspicious" });
    expect(registry.semanticRevision).toBe(afterRemember + 1n);

    expect(registry.unregister(agent.name)).toBe(true);
    const afterRemoval = registry.semanticRevision;
    agent.remember(memory(42));
    expect(registry.semanticRevision).toBe(afterRemoval);
  });

  it("counts each completed unregisterWhere deletion even when a later predicate throws", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    registry.register(personality("first NPC"));
    registry.register(personality("second NPC"));
    const before = registry.semanticRevision;

    expect(() => registry.unregisterWhere((agent) => {
      if (agent.name === "first NPC") return true;
      throw new Error("predicate failure");
    })).toThrow("predicate failure");

    expect(registry.has("first NPC")).toBe(false);
    expect(registry.has("second NPC")).toBe(true);
    expect(registry.semanticRevision).toBe(before + 1n);
  });

  it("counts unregister then same-card registration as two live identity transitions", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    const card = personality("replacement NPC");
    const first = registry.register(card);
    const before = registry.semanticRevision;

    expect(registry.unregister(card.name)).toBe(true);
    const replacement = registry.register(card);

    expect(replacement).not.toBe(first);
    expect(registry.semanticRevision).toBe(before + 2n);
    expect(registry.get(card.name)).toBe(replacement);
  });

  it("counts unregisterWhere then same-card registration as two live identity transitions", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    const card = personality("predicate replacement NPC");
    const first = registry.register(card);
    const before = registry.semanticRevision;

    expect(registry.unregisterWhere((agent) => agent.name === card.name)).toEqual([card.name]);
    const replacement = registry.register(card);

    expect(replacement).not.toBe(first);
    expect(registry.semanticRevision).toBe(before + 2n);
    expect(registry.get(card.name)).toBe(replacement);
  });

  it("applies existing validated DB runtime state during registration through the same restore primitive", () => {
    const db = new NPCStore(":memory:");
    const card = personality("持久化 NPC");
    db.savePersonality(card);
    db.addMemory(card.name, memory(7));
    db.updateState(card.name, "suspicious", -3.5, 4);

    const registry = new AgentRegistry(new RecordingLLM(), db);
    const agent = registry.register(card);

    expect(agent.getRecentMemories(10)).toEqual([memory(7)]);
    expect(agent.getMood()).toBe("suspicious");
    expect(agent.getRelationship()).toBe(-3.5);
    expect(agent.exportRuntimeState().playerInteractionCount).toBe(4);
    db.close();
  });

  it("rejects invalid persisted runtime state without registering or emitting hooks", () => {
    const db = new NPCStore(":memory:");
    const card = personality("损坏状态 NPC");
    db.savePersonality(card);
    db.raw.run(
      "INSERT INTO npc_states (npc_id, mood, relationship, player_interaction_count, last_active) VALUES (?, ?, ?, ?, ?)",
      [card.name, "neutral", 6, 2, 0],
    );

    const registry = new AgentRegistry(new RecordingLLM(), db);
    let hooks = 0;
    registry.onEvent(() => { hooks++; });

    expect(() => registry.register(card)).toThrow(/snapshot\.agents\[0\]\.relationship/);
    expect(registry.getAllNames()).toEqual([]);
    expect(hooks).toBe(0);
    expect(db.raw.query("SELECT relationship FROM npc_states WHERE npc_id = ?").get(card.name)).toEqual({ relationship: 6 });
    db.close();
  });

  it("omits undefined optional personality fields while retaining a JSON-safe export", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    registry.registerQuick("快速 NPC", "路人", "友好");

    const exported = registry.exportSnapshot();
    expect(Object.hasOwn(exported.agents[0]!.personality, "attitudes")).toBe(false);
    expect(() => JSON.stringify(exported)).not.toThrow();
  });

  it("preserves own attitude keys that shadow Object.prototype", () => {
    const source = new AgentRegistry(new RecordingLLM());
    source.register(personality("特殊键 NPC"));
    const snapshot = source.exportSnapshot();
    Object.defineProperty(snapshot.agents[0]!.personality.attitudes!, "__proto__", {
      value: "始终保持警惕",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const restored = new AgentRegistry(new RecordingLLM());
    restored.restoreSnapshot(snapshot);
    const attitudes = restored.get("特殊键 NPC")!.personality.attitudes!;

    expect(Object.hasOwn(attitudes, "__proto__")).toBe(true);
    expect(restored.get("特殊键 NPC")!.getAttitude("__proto__")).toBe("始终保持警惕");
    expect(restored.get("特殊键 NPC")!.getAttitude("toString")).toBe("中立");
    const portableAgain = JSON.parse(JSON.stringify(restored.exportSnapshot())) as {
      agents: Array<{ personality: { attitudes: Record<string, string> } }>;
    };
    expect(portableAgain.agents[0]!.personality.attitudes["__proto__"]).toBe("始终保持警惕");
  });

  it("does not let reflected registry state aliases bypass duplicate-registration lifecycle checks", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    const card = personality("canonical registry NPC");
    const original = registry.register(card);
    const before = registry.semanticRevision;
    const reflected = Reflect.get(registry as object, "agents") as Map<string, unknown> | undefined;

    reflected?.clear();
    Reflect.set(registry as object, "agents", new Map());

    expect(() => registry.register(card)).toThrow(/已注册/);
    expect(registry.get(card.name)).toBe(original);
    expect(registry.semanticRevision).toBe(before);
  });

  it("keeps canonical revisions despite reflected own-property replacement", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    registry.register(personality("revision authority NPC"));
    const before = registry.semanticRevision;

    Object.defineProperty(registry, "liveSemanticRevision", {
      value: 99n,
      configurable: true,
      writable: true,
    });

    expect(registry.semanticRevision).toBe(before);
    expect(registry.unregister("revision authority NPC")).toBe(true);
    expect(registry.semanticRevision).toBe(before + 1n);
  });

  it("keeps the configured LLM and persistence dependencies despite reflected replacement", async () => {
    const configuredLLM = new RecordingLLM();
    const redirectedLLM = new RecordingLLM();
    const configuredDB = new NPCStore(":memory:");
    const redirectedDB = new NPCStore(":memory:");
    const registry = new AgentRegistry(configuredLLM, configuredDB);
    try {
      Reflect.set(registry as object, "llm", redirectedLLM);
      Object.defineProperty(registry, "db", {
        value: redirectedDB,
        configurable: true,
        writable: true,
      });

      const agent = registry.register(personality("dependency authority NPC"));
      expect(configuredDB.getPersonality(agent.name)).not.toBeNull();
      expect(redirectedDB.getPersonality(agent.name)).toBeNull();

      await agent.respond("请只使用创建 registry 时配置的模型。");
      expect(configuredLLM.calls).toHaveLength(1);
      expect(redirectedLLM.calls).toHaveLength(0);
    } finally {
      configuredDB.close();
      redirectedDB.close();
    }
  });

  it("keeps source-fence revisions canonical through membership, active-agent, restore, and unregister mutations despite a no-op bump shadow", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    const card = personality("revision helper no-op NPC");
    Object.defineProperty(registry, "bumpSemanticRevision", { configurable: true, value: () => {} });

    const registered = registry.register(card);
    expect(registry.semanticRevision).toBe(1n);
    registered.remember(memory(61));
    expect(registry.semanticRevision).toBe(2n);
    const snapshot = registry.exportSnapshot();
    registry.restoreSnapshot(snapshot);
    expect(registry.semanticRevision).toBe(3n);
    expect(registry.stateReplacementRevision).toBe(1n);
    expect(registry.unregister(card.name)).toBe(true);
    expect(registry.semanticRevision).toBe(4n);
  });

  it("does not let a throwing bump shadow DoS a retained active agent or hide its source-fence revision", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    const agent = registry.register(personality("revision helper throwing NPC"));
    const before = registry.semanticRevision;
    Object.defineProperty(registry, "bumpSemanticRevision", {
      configurable: true,
      value: () => { throw new Error("forged revision helper"); },
    });

    expect(() => agent.remember(memory(62))).not.toThrow();
    expect(registry.semanticRevision).toBe(before + 1n);
    expect(() => registry.unregister(agent.name)).not.toThrow();
    expect(registry.semanticRevision).toBe(before + 2n);
  });

  it("does not let a fake observed-agent factory replace real registration, DB, hook, or runtime authority", () => {
    const db = new NPCStore(":memory:");
    const registry = new AgentRegistry(new RecordingLLM(), db);
    const events: Array<[string, string]> = [];
    try {
      registry.onEvent((name, event) => events.push([name, event]));
      Object.defineProperty(registry, "createObservedAgent", {
        configurable: true,
        value: () => ({ name: "forged agent" }),
      });

      const agent = registry.register(personality("observed factory registration NPC"));
      expect(agent).toBeInstanceOf(NPCAgent);
      expect(registry.get(agent.name)).toBe(agent);
      expect(agent.personality.name).toBe(agent.name);
      expect(db.getPersonality(agent.name)).not.toBeNull();
      expect(events).toEqual([[agent.name, "register"]]);
      const before = registry.semanticRevision;
      agent.remember(memory(63));
      expect(registry.semanticRevision).toBe(before + 1n);
    } finally {
      db.close();
    }
  });

  it("does not let a throwing observed-agent factory DoS a real snapshot restore", () => {
    const source = new AgentRegistry(new RecordingLLM());
    const sourceAgent = source.register(personality("observed factory restore NPC"));
    sourceAgent.remember(memory(64));
    sourceAgent.adjustRelationship(2);
    const snapshot = source.exportSnapshot();
    const db = new NPCStore(":memory:");
    const target = new AgentRegistry(new RecordingLLM(), db);
    let hooks = 0;
    try {
      target.onEvent(() => { hooks++; });
      Object.defineProperty(target, "createObservedAgent", {
        configurable: true,
        value: () => { throw new Error("forged observed-agent factory"); },
      });

      expect(() => target.restoreSnapshot(snapshot)).not.toThrow();
      const restored = target.get(sourceAgent.name);
      expect(restored).toBeInstanceOf(NPCAgent);
      expect(restored?.personality).toEqual(sourceAgent.personality);
      expect(restored?.exportRuntimeState()).toEqual(sourceAgent.exportRuntimeState());
      expect(target.semanticRevision).toBe(1n);
      expect(target.stateReplacementRevision).toBe(1n);
      expect(hooks).toBe(0);
      expect(db.raw.query("SELECT COUNT(*) AS count FROM npc_personalities").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("does not let a no-op emit shadow swallow registered hooks, including a non-blocking throwing hook", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    const seen: Array<[string, string]> = [];
    registry.onEvent((name, event) => seen.push([name, event]));
    registry.onEvent(() => { throw new Error("hook failure remains non-blocking"); });
    Object.defineProperty(registry, "emit", { configurable: true, value: () => {} });

    const agent = registry.register(personality("emit helper no-op NPC"));
    expect(registry.unregister(agent.name)).toBe(true);
    expect(seen).toEqual([[agent.name, "register"], [agent.name, "unregister"]]);
    expect(registry.semanticRevision).toBe(2n);
  });

  it("does not let a throwing emit shadow DoS registration or hook delivery", () => {
    const registry = new AgentRegistry(new RecordingLLM());
    const seen: Array<[string, string]> = [];
    registry.onEvent((name, event) => seen.push([name, event]));
    Object.defineProperty(registry, "emit", {
      configurable: true,
      value: () => { throw new Error("forged emit helper"); },
    });

    expect(() => registry.register(personality("emit helper throwing NPC"))).not.toThrow();
    const agent = registry.get("emit helper throwing NPC")!;
    expect(seen).toEqual([[agent.name, "register"]]);
    expect(() => registry.unregister(agent.name)).not.toThrow();
    expect(seen).toEqual([[agent.name, "register"], [agent.name, "unregister"]]);
  });
});
