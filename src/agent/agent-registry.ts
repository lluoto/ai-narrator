// Agent 注册中心 — 多 Agent 热插拔容器
//
// 设计:
//   NPC 可以动态加入/离开游戏，无需重启主循环。
//   - 进入新场景 → 按需注册场景中的 NPC
//   - 实体死亡 → 自动注销对应 Agent
//   - 玩家或 KP 触发 → 即时创建新 NPC 并注册

import type { LLMLike } from "../llm/client";
import type { AgentMessage, NPCPersonality, VisibilityRule } from "./types";
import {
  NPCAgent,
  bindPreparedNPCAgentMemoryAppendProjectionForHost,
  discardPreparedNPCAgentMemoryAppendForHost,
  getPreparedNPCAgentMemoryAppendDetails,
  prepareNPCAgentMemoryAppendForHost,
  publishPreparedNPCAgentMemoryAppendForHost,
  sealPreparedNPCAgentMemoryAppendForHost,
  type NPCAgentPreparedMemoryAppendDetails,
  type NPCAgentPreparedMemoryAppend,
  type NPCAgentRuntimeState,
} from "./npc-agent";
import { NPCStore, appendNPCStoreMemoryBatchForHost } from "../db/index";
import {
  PlayerSession,
  commitPreparedPlayerSessionPushForHost,
  discardPreparedPlayerSessionPushForHost,
  preparePlayerSessionPushForHost,
  sealPreparedPlayerSessionPushForHost,
} from "../session/player-session";
import {
  AGENT_REGISTRY_SNAPSHOT_KIND,
  AGENT_REGISTRY_SNAPSHOT_VERSION,
  createAgentRegistrySnapshot,
  validateAgentRegistrySnapshot,
  type AgentRegistrySnapshot,
} from "./agent-registry-snapshot";

type RegistryEvent = "register" | "unregister";
type RegistryHook = (name: string, event: RegistryEvent) => void;

function snapshotPersonality(personality: NPCPersonality): NPCPersonality {
  const snapshot: NPCPersonality = {
    name: personality.name,
    role: personality.role,
    personality: personality.personality,
    background: personality.background,
    goals: [...personality.goals],
    speech_style: personality.speech_style,
    knowledge: [...personality.knowledge],
    secrets: [...personality.secrets],
  };
  if (personality.attitudes !== undefined) {
    const attitudes: Record<string, string> = {};
    for (const [name, attitude] of Object.entries(personality.attitudes)) {
      Object.defineProperty(attitudes, name, {
        value: attitude,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    snapshot.attitudes = attitudes;
  }
  if (personality.ruleset !== undefined) snapshot.ruleset = personality.ruleset;
  if (personality.traits !== undefined) snapshot.traits = { ...personality.traits };
  if (personality.factions !== undefined) snapshot.factions = personality.factions.map((faction) => ({ ...faction }));
  if (personality.initialMood !== undefined) snapshot.initialMood = personality.initialMood;
  return snapshot;
}

/** Apply the portable runtime contract to data read from persistence before it reaches an agent. */
function validateHydratedRuntimeState(
  personality: NPCPersonality,
  runtimeState: NPCAgentRuntimeState,
): NPCAgentRuntimeState {
  const entry = validateAgentRegistrySnapshot({
    kind: AGENT_REGISTRY_SNAPSHOT_KIND,
    schemaVersion: AGENT_REGISTRY_SNAPSHOT_VERSION,
    agents: [{ personality: snapshotPersonality(personality), ...runtimeState }],
  }).agents[0]!;
  return {
    memories: entry.memories,
    mood: entry.mood,
    relationship: entry.relationship,
    playerInteractionCount: entry.playerInteractionCount,
  };
}

interface AgentRegistryHostFanoutCapability {
  fanout(
    session: PlayerSession,
    message: AgentMessage,
    visibility: VisibilityRule,
    discoverer: string | undefined,
    targets: string[] | undefined,
  ): void;
}

const agentRegistryHostFanoutCapabilities = new WeakMap<AgentRegistry, AgentRegistryHostFanoutCapability>();

/**
 * Narrow lexical host authority for standalone CLI timeline fanout. The CLI
 * must not dispatch through a replaceable AgentRegistry instance method.
 */
export function fanoutAgentRegistryMessageForHost(
  registry: AgentRegistry,
  session: PlayerSession,
  message: AgentMessage,
  visibility: VisibilityRule = "public",
  discoverer?: string,
  targets?: string[],
): void {
  const capability = agentRegistryHostFanoutCapabilities.get(registry);
  if (!capability) throw new Error("AgentRegistry host fanout capability is unavailable");
  capability.fanout(session, message, visibility, discoverer, targets);
}

export class AgentRegistry {
  #agents: Map<string, NPCAgent> = new Map();
  /** Unobservable authority shared only with agents this registry constructs. */
  readonly #hostFanoutToken = Object.freeze({});
  /** Process-local live-structure/runtime epoch; deliberately not portable. */
  #liveSemanticRevision = 0n;
  /** Process-local whole-registry replacement epoch; deliberately not portable. */
  #replacementRevision = 0n;
  #llm: LLMLike;
  #hooks: RegistryHook[] = [];
  #db?: NPCStore;

  constructor(llm: LLMLike, db?: NPCStore) {
    this.#llm = llm;
    this.#db = db;
    agentRegistryHostFanoutCapabilities.set(this, {
      fanout: (session, message, visibility, discoverer, targets) =>
        this.#fanoutMessage(session, message, visibility, discoverer, targets),
    });
  }

  /** 注册 NPC Agent（从完整人格卡） */
  register(personality: NPCPersonality): NPCAgent {
    if (this.#agents.has(personality.name)) {
      throw new Error(`Agent "${personality.name}" 已注册。如需替换，请先 unregister。`);
    }
    const agent = this.#createObservedAgent(personality);
    // 如果数据库中有该 NPC 的记忆，加载
    if (this.#db) {
      const existing = this.#db.getPersonality(personality.name);
      if (existing) {
        agent.loadMemoriesFromDB();
        // 恢复状态
        const state = this.#db.getState(personality.name);
        const runtimeState = agent.exportRuntimeState();
        agent.restoreRuntimeState(validateHydratedRuntimeState(personality, {
          ...runtimeState,
          ...(state ? {
            mood: state.mood,
            relationship: state.relationship,
            playerInteractionCount: state.interactionCount,
          } : {}),
        }));
      } else {
        // 新 NPC，持久化人格卡
        this.#db.savePersonality(personality);
      }
    }
    this.#agents.set(personality.name, agent);
    this.#bumpSemanticRevision();
    this.#emit("register", personality.name);
    return agent;
  }

  /** 快速注册 NPC（从最小描述自动生成人格卡） */
  registerQuick(
    name: string,
    role: string,
    personality: string,
    opts: {
      background?: string;
      goals?: string[];
      speech?: string;
      knowledge?: string[];
      attitudes?: Record<string, string>;
    } = {}
  ): NPCAgent {
    const card: NPCPersonality = {
      name,
      role,
      personality,
      background: opts.background ?? `${name}，${role}`,
      goals: opts.goals ?? ["生存", "完成自己的事"],
      speech_style: opts.speech ?? `以${role}的身份说话，简洁自然`,
      knowledge: opts.knowledge ?? [],
      secrets: [],
      attitudes: opts.attitudes,
    };
    return this.register(card);
  }

  /** 注销 NPC Agent */
  unregister(name: string): boolean {
    const agent = this.#agents.get(name);
    if (!agent) return false;
    this.#agents.delete(name);
    this.#bumpSemanticRevision();
    this.#emit("unregister", name);
    return true;
  }

  /** 按名查找 */
  get(name: string): NPCAgent | undefined {
    return this.#agents.get(name);
  }

  /** 按名查找 Agent（server API 兼容别名，等价 get） */
  findAgentByName(name: string): NPCAgent | undefined {
    return this.#agents.get(name);
  }

  /** 是否存在 */
  has(name: string): boolean {
    return this.#agents.has(name);
  }

  /** 获取所有活跃 Agent */
  getAll(): NPCAgent[] {
    return [...this.#agents.values()];
  }

  /** 获取所有活跃 Agent 名 */
  getAllNames(): string[] {
    return [...this.#agents.keys()];
  }

  /** 数量 */
  get count(): number {
    return this.#agents.size;
  }

  /** Changes only when restoreSnapshot installs a fresh set of live NPCAgent identities. */
  get stateReplacementRevision(): bigint {
    return this.#replacementRevision;
  }

  /**
   * Changes for live registry membership and active registered-agent runtime
   * state writes. It is intentionally not part of portable snapshots.
   */
  get semanticRevision(): bigint {
    return this.#liveSemanticRevision;
  }

  /**
   * Host-only timeline fanout used by the standalone CLI.  This deliberately
   * keeps the message and NPC-memory writes together at one boundary.
   */
  #fanoutMessage(
    session: PlayerSession,
    message: AgentMessage,
    visibility: VisibilityRule = "public",
    discoverer?: string,
    targets?: string[],
  ): void {
    // Complete all caller-controlled validation and every next-state cache
    // before SQLite changes. The timestamp is sampled once and becomes an
    // explicit field on every planned recipient memory.
    // Clone before any planning so accessor-backed input cannot give the
    // PlayerSession and recipient memories different observations.
    const canonicalMessage: AgentMessage = structuredClone(message);
    const registryRevision = this.#liveSemanticRevision;
    const playerPush = preparePlayerSessionPushForHost(session, canonicalMessage, visibility, discoverer, targets);
    const planned: Array<{
      npcId: string;
      agent: NPCAgent;
      memory: NPCAgentPreparedMemoryAppend;
      details: NPCAgentPreparedMemoryAppendDetails;
    }> = [];
    const importance = canonicalMessage.type === "narration" ? 7 : 5;
    const timestamp = Date.now();
    try {
      for (const [npcId, agent] of this.#agents) {
        if (npcId === canonicalMessage.speaker) continue;
        const memory = prepareNPCAgentMemoryAppendForHost(agent, this.#hostFanoutToken, {
            timestamp,
            type: canonicalMessage.type === "narration" ? "event" : "dialogue",
            content: canonicalMessage.type === "narration"
              ? canonicalMessage.content
              : `${canonicalMessage.speaker}说: "${canonicalMessage.content}"`,
            importance,
          });
        planned.push({
          npcId,
          agent,
          memory,
          details: getPreparedNPCAgentMemoryAppendDetails(this.#hostFanoutToken, memory),
        });
      }

      const details = planned.map(({ details }) => details);
      const store = details[0]?.store;
      if (details.some((detail) => detail.store !== store)) {
        throw new Error("CLI NPC fanout requires every recipient to share one NPCStore");
      }
      if (this.#liveSemanticRevision !== registryRevision
        || planned.some(({ npcId, agent }) => this.#agents.get(npcId) !== agent)) {
        throw new Error("CLI NPC fanout registry changed while planning");
      }
      // Seal all expected live state and PlayerSession revision before SQL.
      // Bun's Database API exposes transactions but no JS SQL-function hook,
      // so this synchronous transaction cannot re-enter either aggregate.
      sealPreparedPlayerSessionPushForHost(session, playerPush);
      for (const { agent, memory } of planned) {
        sealPreparedNPCAgentMemoryAppendForHost(agent, this.#hostFanoutToken, memory);
      }
      if (store) {
        let plannedByReceipt: Map<object, (typeof planned)[number]> | undefined;
        appendNPCStoreMemoryBatchForHost(
          store,
          details.map(({ npcId, entry, receipt, memoryCacheCandidate }) => ({
            npcId,
            entry,
            receipt,
            memoryCacheCandidate,
          })),
          {
            // This consumer runs from NPCStore's db.transaction callback.
            // Build and validate the opaque plan association there before the
            // first write, rather than after the durable commit has returned.
            begin: () => {
              const next = new Map<object, (typeof planned)[number]>();
              for (const item of planned) {
                if (next.has(item.details.receipt)) {
                  throw new Error("CLI NPC fanout prepared memory receipts must be unique");
                }
                next.set(item.details.receipt, item);
              }
              if (next.size !== planned.length) {
                throw new Error("CLI NPC fanout prepared memory receipt set is incomplete");
              }
              plannedByReceipt = next;
            },
            consume: (projection) => {
              const receiptPlans = plannedByReceipt;
              const item = receiptPlans?.get(projection.receipt);
              if (!receiptPlans || !item) {
                throw new Error("CLI NPC fanout durable projection receipt is unavailable");
              }
              receiptPlans.delete(projection.receipt);
              bindPreparedNPCAgentMemoryAppendProjectionForHost(
                item.agent,
                this.#hostFanoutToken,
                item.memory,
                item.details.receipt,
                projection.memories,
              );
            },
            complete: () => {
              if (plannedByReceipt === undefined || plannedByReceipt.size !== 0) {
                throw new Error("CLI NPC fanout durable projection receipt set is incomplete");
              }
            },
          },
        );
      }
    } catch (error) {
      for (const { agent, memory } of planned) {
        discardPreparedNPCAgentMemoryAppendForHost(agent, this.#hostFanoutToken, memory);
      }
      discardPreparedPlayerSessionPushForHost(session, playerPush);
      throw error;
    }

    // Durable work is complete. Every remaining operation is a sealed,
    // owned-memory consume with no public dispatch, callback, clone, or SQL.
    for (const { agent, memory } of planned) {
      publishPreparedNPCAgentMemoryAppendForHost(agent, this.#hostFanoutToken, memory);
      this.#bumpSemanticRevision();
    }
    commitPreparedPlayerSessionPushForHost(session, playerPush);
  }

  /** Export data-only active-agent state in registration (Map insertion) order. */
  exportSnapshot(): AgentRegistrySnapshot {
    return createAgentRegistrySnapshot({
      kind: AGENT_REGISTRY_SNAPSHOT_KIND,
      schemaVersion: AGENT_REGISTRY_SNAPSHOT_VERSION,
      agents: [...this.#agents.values()].map((agent) => ({
        personality: snapshotPersonality(agent.personality),
        ...agent.exportRuntimeState(),
      })),
    });
  }

  /**
   * Atomically replace active agents from a validated portable snapshot.
   * It intentionally neither persists to NPCStore nor emits registration hooks.
   */
  restoreSnapshot(input: unknown): void {
    const snapshot = validateAgentRegistrySnapshot(input);
    const restored = new Map<string, NPCAgent>();
    for (const entry of snapshot.agents) {
      const agent = this.#createObservedAgent(entry.personality);
      agent.restoreRuntimeState({
        memories: entry.memories,
        mood: entry.mood,
        relationship: entry.relationship,
        playerInteractionCount: entry.playerInteractionCount,
      });
      restored.set(entry.personality.name, agent);
    }
    this.#agents = restored;
    this.#bumpSemanticRevision();
    this.#replacementRevision++;
  }

  /** 批量注册 */
  registerAll(personalities: NPCPersonality[]): NPCAgent[] {
    return personalities.map((p) => this.register(p));
  }

  /** 按条件注销（如：清除所有不在某场景中的 NPC） */
  unregisterWhere(predicate: (agent: NPCAgent) => boolean): string[] {
    const removed: string[] = [];
    for (const [name, agent] of this.#agents) {
      if (predicate(agent)) {
        this.#agents.delete(name);
        // Count each deletion before the next predicate invocation: a later
        // predicate throw must not hide a completed live mutation.
        this.#bumpSemanticRevision();
        removed.push(name);
        this.#emit("unregister", name);
      }
    }
    return removed;
  }

  /** 监听注册/注销事件 */
  onEvent(hook: RegistryHook) {
    this.#hooks.push(hook);
  }

  #createObservedAgent(personality: NPCPersonality): NPCAgent {
    const npcId = personality.name;
    let agent: NPCAgent | undefined;
    agent = new NPCAgent(personality, this.#llm, this.#db, () => {
      // A caller can retain a removed/replaced NPCAgent. Its later writes do
      // not mutate the active map authority and therefore do not advance this
      // registry's live semantic revision.
      if (agent !== undefined && this.#agents.get(npcId) === agent) {
        this.#bumpSemanticRevision();
      }
    }, this.#hostFanoutToken);
    return agent;
  }

  #bumpSemanticRevision(): void {
    this.#liveSemanticRevision++;
  }

  #emit(event: RegistryEvent, name: string) {
    for (const hook of this.#hooks) {
      try { hook(name, event); } catch { /* 不阻塞 */ }
    }
  }
}
