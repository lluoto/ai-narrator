import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "../agent/agent-registry";
import { GameSession } from "../api/game-session";
import { isolatedProviderSeamIt } from "./helpers/provider-seam-child";
import { NPCStore } from "../db";

const LLM = {
  apiKey: "sk-registry-reference-test",
  baseUrl: "http://registry-reference.invalid/v1",
  model: "registry-reference-test",
  maxTokens: 32,
  temperature: 0,
};

const REGISTRY_LLM = { chat: async () => "" };

const providerSeamIt = isolatedProviderSeamIt("src/__tests__/game-session-registry-reference.test.ts");

describe("GameSession registry reference authority", () => {
  it("exposes a frozen data-only registry reader, never live agents or registry authority", () => {
    const value = new GameSession(`registry-read-facade-${crypto.randomUUID()}`, "cosmic-horror", LLM);
    try {
      const facade = value.registry as unknown as Record<string | symbol, unknown>;
      expect(Object.isFrozen(facade)).toBe(true);
      expect(Reflect.ownKeys(facade).sort()).toEqual(["count", "getAllNames", "has"]);
      for (const forbidden of [
        "register", "registerQuick", "unregister", "unregisterWhere", "setDB", "onEvent",
        "restoreSnapshot", "exportSnapshot", "get", "findAgentByName", "getAll",
        "semanticRevision", "stateReplacementRevision", "db",
      ]) expect(forbidden in facade).toBe(false);

      const names = value.registry.getAllNames();
      expect(Object.isFrozen(names)).toBe(true);
      expect(() => (names as string[]).push("forged NPC")).toThrow(TypeError);
      expect(value.registry.getAllNames()).toEqual([]);
    } finally {
      value.close();
    }
  });

  it("returns fresh frozen name data from the current private registry across real module load and restore", async () => {
    const source = new GameSession(`registry-names-source-${crypto.randomUUID()}`, "cosmic-horror", LLM, "investigator", "Ada");
    const restored = new GameSession(source.id, "cosmic-horror", LLM);
    try {
      const before = source.registry.getAllNames();
      expect(before).toEqual([]);
      expect(Object.isFrozen(before)).toBe(true);

      expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
      const after = source.registry.getAllNames();
      expect(after).not.toBe(before);
      expect(Object.isFrozen(after)).toBe(true);
      expect(after.length).toBeGreaterThan(0);
      expect(() => (after as string[]).pop()).toThrow(TypeError);
      expect(before).toEqual([]);
      expect(source.registry.getAllNames()).not.toBe(after);

      restored.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot())));
      expect(restored.registry.getAllNames()).toEqual(after);
    } finally {
      source.close();
      restored.close();
    }
  });

  it("never publishes NPCAgent lookup or live-agent enumeration even after real module registration", async () => {
    const value = new GameSession(`registry-live-agent-escape-${crypto.randomUUID()}`, "cosmic-horror", LLM);
    try {
      expect((await value.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
      const facade = value.registry as unknown as Record<string, unknown>;
      for (const forbidden of ["get", "findAgentByName", "getAll"]) {
        expect(forbidden in facade).toBe(false);
      }
      expect(value.registry.getAllNames().every((name) => typeof name === "string")).toBe(true);
    } finally {
      value.close();
    }
  });

  it("never publishes registry persistence, restore, hook, or revision authority", () => {
    const value = new GameSession(`registry-persistence-escape-${crypto.randomUUID()}`, "cosmic-horror", LLM);
    try {
      const facade = value.registry as unknown as Record<string, unknown>;
      for (const forbidden of [
        "db", "setDB", "onEvent", "exportSnapshot", "restoreSnapshot",
        "semanticRevision", "stateReplacementRevision",
      ]) expect(forbidden in facade).toBe(false);
      expect(Object.getOwnPropertyDescriptors(facade).count?.set).toBeUndefined();
    } finally {
      value.close();
    }
  });

  it("rejects public whole-registry replacement instead of exposing a writable own authority", () => {
    const value = new GameSession(`registry-reference-shape-${crypto.randomUUID()}`, "cosmic-horror", LLM);
    const replacement = new AgentRegistry(REGISTRY_LLM);
    try {
      const original = value.registry;
      expect(Object.getOwnPropertyDescriptor(value, "registry")).toBeUndefined();
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), "registry");
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.set).toBeUndefined();
      expect(Reflect.set(value as object, "registry", replacement)).toBe(false);
      expect(() => Object.assign(value as object, { registry: replacement })).toThrow(TypeError);
      expect(value.registry).toBe(original);
    } finally {
      value.close();
    }
  });

  it("binds NPCStore at construction only and cannot be rebound into a mixed-store cohort", () => {
    const first = new NPCStore(":memory:");
    const second = new NPCStore(":memory:");
    const registry = new AgentRegistry(REGISTRY_LLM, first);
    try {
      expect(Object.getOwnPropertyDescriptor(AgentRegistry.prototype, "setDB")).toBeUndefined();
      expect("setDB" in registry).toBe(false);

      const firstAgent = registry.register({
        name: "constructor-bound first NPC",
        role: "witness",
        personality: "careful",
        background: "fixture",
        goals: [],
        speech_style: "brief",
        knowledge: [],
        secrets: [],
      });

      // A caller can shadow ordinary public names, but that shadow must not
      // acquire authority over the constructor-bound private dependency after
      // an early agent has already captured it.
      Object.defineProperty(registry, "setDB", {
        configurable: true,
        value: (store: NPCStore) => store,
      });
      const attemptedRebind = (registry as unknown as { setDB(store: NPCStore): NPCStore }).setDB(second);
      expect(attemptedRebind).toBe(second);

      const laterAgent = registry.register({
        name: "constructor-bound later NPC",
        role: "witness",
        personality: "careful",
        background: "fixture",
        goals: [],
        speech_style: "brief",
        knowledge: [],
        secrets: [],
      });
      firstAgent.remember({ timestamp: 1, type: "event", content: "first", importance: 5 });
      laterAgent.remember({ timestamp: 2, type: "event", content: "later", importance: 5 });

      expect(first.getPersonality(firstAgent.name)).not.toBeNull();
      expect(first.getPersonality(laterAgent.name)).not.toBeNull();
      expect(first.countMemories(firstAgent.name)).toBe(1);
      expect(first.countMemories(laterAgent.name)).toBe(1);
      expect(second.getPersonality(firstAgent.name)).toBeNull();
      expect(second.getPersonality(laterAgent.name)).toBeNull();
      expect(second.countMemories(firstAgent.name)).toBe(0);
      expect(second.countMemories(laterAgent.name)).toBe(0);
    } finally {
      first.close();
      second.close();
    }
  });

  providerSeamIt("keeps module NPC registration, snapshots, and dialogue on private authority after a same-name throwing shadow", async () => {
    const value = new GameSession(`registry-reference-shadow-${crypto.randomUUID()}`, "cosmic-horror", LLM, "investigator", "Ada");
    const restored = new GameSession(value.id, "cosmic-horror", LLM);
    const facade = value.registry;
    const observer = Object.freeze({
      get count(): never { throw new Error("public registry shadow must not be consulted internally"); },
      has(): never { throw new Error("public registry shadow must not be consulted internally"); },
      getAllNames(): never { throw new Error("public registry shadow must not be consulted internally"); },
    });
    const originalFetch = globalThis.fetch;
    let npcRequests = 0;
    try {
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: unknown }> };
        const intentRequest = body.messages?.some((message) =>
          typeof message.content === "string" && message.content.includes("意图解析器"),
        ) ?? false;
        if (intentRequest) {
          return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ action: "talk", target: "菲碧·特里坎" }) } }],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        npcRequests++;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "菲碧谨慎地回答：我只会告诉你我亲眼见过的事。" } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch;

      // This can shadow an inherited getter for observation.  It must not
      // become a second authority for GameSession's module, snapshot, or NPC
      // execution paths.
      Object.defineProperty(value, "registry", { value: observer, configurable: true });
      await value.act("加载模组 普瑞米尔的谷仓");

      expect(value.registry).toBe(observer);
      expect(facade.has("菲碧·特里坎")).toBe(true);
      expect(facade.count).toBeGreaterThan(0);
      const snapshot = value.exportOrdinarySessionSnapshot();
      expect(snapshot.agentRegistry.agents).toHaveLength(facade.count);

      const dialogue = await value.act("与菲碧·特里坎交谈");
      expect(dialogue.events.some((event) => event.speaker === "菲碧·特里坎")).toBe(true);
      expect(dialogue.events.some((event) => event.content.includes("亲眼见过"))).toBe(true);
      expect(npcRequests).toBe(1);

      restored.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
      expect(restored.registry.has("菲碧·特里坎")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      value.close();
      restored.close();
    }
  });
});
