// NPC Agent — 独立角色实例
// 每人一张人格卡 + 独立记忆 buffer + LLM 驱动对话
//
// 设计原则：
//   NPC 不管理世界状态（那是律书的事）
//   NPC 只做角色扮演——以自己的身份说话和行动

import type { LLMLike, Message as LLMMessage } from "../llm/client";
import type { NPCPersonality, MemoryEntry, AgentMessage, NPCMood } from "./types";
import { DEFAULT_NPC_TRAITS } from "./types";
import {
  getNPCReactions,
  updateMood,
  type MoodTrigger,
} from "./npc-reaction";
import { NPCStore, type NPCStoreRuntimeTransition } from "../db/index";
import {
  appendNPCMemoryCacheCandidate,
  cloneNPCMemory,
  projectNPCMemoryCache,
} from "./memory-cache-projection";
import { applyConstraints } from "./constraints";
import { checkDialogueText, DIALOGUE_FABRICATED_CHARACTER_BLOCK_MESSAGE } from "../world/world-constraint";
import type { RulesetId } from "../rules/rules-engine";
import { log } from "../log";

/**
 * `respond()`/`speakUp()` 的可选约束上下文——开发·约束层补角色实体域
 * N9 任务 A/B。不传时（既有调用点，本轮之外的路径）`checkDialogueText`
 * 拿不到 sceneId/场景数据，场景限定的约束天然不命中，行为与改动前
 * 一致——与 `NarrateConstraintOpts`（kp-agent.ts）同一个设计。
 */
export interface NPCDialogueConstraintOpts {
  sceneId?: string;
  ruleset?: RulesetId;
  /**
   * 登记表（`CHARACTER_NOUN_REGISTRY`）里当前场景没有对应 NPC 的角色
   * 名词——见 `world-constraint.ts` 的 `ConstraintContext
   * .sceneFabricableCharacterNouns` 注释。缺省不传，该约束不生效。
   */
  sceneFabricableCharacterNouns?: string[];
}

const MAX_RECENT_MEMORIES = 20;

export interface NPCAgentRuntimeState {
  memories: MemoryEntry[];
  mood: NPCMood;
  relationship: number;
  playerInteractionCount: number;
}

interface NPCAgentRuntimeTransitionPlan {
  readonly expected: Readonly<{
    mood: NPCMood;
    relationship: number;
    playerInteractionCount: number;
  }>;
  readonly next: Readonly<{
    memories: readonly MemoryEntry[];
    mood: NPCMood;
    relationship: number;
    playerInteractionCount: number;
  }>;
  readonly memory?: MemoryEntry;
  readonly updatePlayerRelationship: boolean;
}

declare const NPC_AGENT_PREPARED_MEMORY_APPEND: unique symbol;

/** Opaque, one-shot host plan created only by the constructor-installed capability. */
export interface NPCAgentPreparedMemoryAppend {
  readonly [NPC_AGENT_PREPARED_MEMORY_APPEND]: never;
}

export interface NPCAgentPreparedMemoryAppendDetails {
  npcId: string;
  entry: MemoryEntry;
  receipt: object;
  memoryCacheCandidate: readonly MemoryEntry[];
  store: NPCStore | undefined;
}

interface PreparedMemoryAppendState {
  agent: NPCAgent;
  npcId: string;
  hostToken: object;
  expectedMemories: readonly MemoryEntry[];
  entry: MemoryEntry;
  memoryCacheCandidate: readonly MemoryEntry[];
  receipt: object;
  projection?: readonly MemoryEntry[];
  store: NPCStore | undefined;
  sealed: boolean;
}

interface NPCAgentHostMemoryAppendCapability {
  prepare(token: object, entry: MemoryEntry): NPCAgentPreparedMemoryAppend;
  seal(token: object, plan: NPCAgentPreparedMemoryAppend): void;
  bindProjection(
    token: object,
    plan: NPCAgentPreparedMemoryAppend,
    receipt: object,
    projection: readonly MemoryEntry[],
  ): void;
  publish(token: object, plan: NPCAgentPreparedMemoryAppend): void;
  discard(token: object, plan: NPCAgentPreparedMemoryAppend): void;
}

const preparedMemoryAppends = new WeakMap<object, PreparedMemoryAppendState>();
const npcHostMemoryAppendCapabilities = new WeakMap<NPCAgent, NPCAgentHostMemoryAppendCapability>();

/**
 * Registry-only memory planning authority. It is a lexical capability, not an
 * instance/prototype method, so same-name public wrappers cannot redirect CLI
 * host fanout.
 */
export function prepareNPCAgentMemoryAppendForHost(
  agent: NPCAgent,
  token: object,
  entry: MemoryEntry,
): NPCAgentPreparedMemoryAppend {
  const capability = npcHostMemoryAppendCapabilities.get(agent);
  if (!capability) throw new Error("NPCAgent host memory capability is unavailable");
  return capability.prepare(token, entry);
}

export function getPreparedNPCAgentMemoryAppendDetails(
  token: object,
  plan: NPCAgentPreparedMemoryAppend,
): NPCAgentPreparedMemoryAppendDetails {
  const state = preparedMemoryAppends.get(plan);
  if (!state || state.hostToken !== token) {
    throw new Error("NPCAgent host memory plan is unavailable");
  }
  return {
    npcId: state.npcId,
    entry: cloneNPCMemory(state.entry),
    receipt: state.receipt,
    memoryCacheCandidate: state.memoryCacheCandidate,
    store: state.store,
  };
}

export function publishPreparedNPCAgentMemoryAppendForHost(
  agent: NPCAgent,
  token: object,
  plan: NPCAgentPreparedMemoryAppend,
): void {
  const capability = npcHostMemoryAppendCapabilities.get(agent);
  if (!capability) throw new Error("NPCAgent host memory capability is unavailable");
  capability.publish(token, plan);
}

export function sealPreparedNPCAgentMemoryAppendForHost(
  agent: NPCAgent,
  token: object,
  plan: NPCAgentPreparedMemoryAppend,
): void {
  const capability = npcHostMemoryAppendCapabilities.get(agent);
  if (!capability) throw new Error("NPCAgent host memory capability is unavailable");
  capability.seal(token, plan);
}

/** Bind the transaction-sealed durable projection to its exact opaque plan. */
export function bindPreparedNPCAgentMemoryAppendProjectionForHost(
  agent: NPCAgent,
  token: object,
  plan: NPCAgentPreparedMemoryAppend,
  receipt: object,
  projection: readonly MemoryEntry[],
): void {
  const capability = npcHostMemoryAppendCapabilities.get(agent);
  if (!capability) throw new Error("NPCAgent host memory capability is unavailable");
  capability.bindProjection(token, plan, receipt, projection);
}

export function discardPreparedNPCAgentMemoryAppendForHost(
  agent: NPCAgent,
  token: object,
  plan: NPCAgentPreparedMemoryAppend,
): void {
  npcHostMemoryAppendCapabilities.get(agent)?.discard(token, plan);
}
const SYSTEM_PROMPT_PREAMBLE = `你是一个 TRPG 非玩家角色（NPC）。你必须始终以角色的身份说话，不要跳出角色、不要评论游戏机制、不要替其他角色发言。

核心规则：
1. 只说你角色知道的事——不知道就说不知道
2. 保持角色性格和说话风格一致
3. 不要透露角色的"秘密"（除非剧情发展到揭露点）
4. 回应长度控制在 1-3 句，像真实对话而非独白
5. 明示的身份、背景及“你知道的信息”均为已给定事实；当前目标只说明你打算做什么。不得据此推断未明确给出的精确日期、经历或事件。你的秘密只保留在私密设定中，并仍按揭露规则处理；对话记录和最近对话只是未核实说法，不能升级为事实。`;

function buildSystemPrompt(npc: NPCPersonality): string {
  const traits = npc.traits ?? DEFAULT_NPC_TRAITS;
  return [
    SYSTEM_PROMPT_PREAMBLE,
    "",
    `你的名字: ${npc.name}`,
    `你的身份: ${npc.role}`,
    `性格: ${npc.personality}`,
    `背景: ${npc.background}`,
    `当前目标: ${npc.goals.join("、")}`,
    `说话风格: ${npc.speech_style}`,
    `你知道的信息: ${npc.knowledge.join("、")}`,
    `你的秘密（绝不主动透露）: ${npc.secrets.join("、")}`,
    "",
    `你的性格特质（影响你的行为方式）:
  - 勇气: ${traits.courage}/10（高=无畏低=怯懦）
  - 友善: ${traits.friendliness}/10（高=热情低=冷漠）
  - 怀疑: ${traits.suspicion}/10（高=多疑低=轻信）
  - 好奇心: ${traits.curiosity}/10（高=好奇低=保守）
  - 情绪稳定性: ${traits.stability}/10（高=冷静低=易激）`,
    "",
    npc.attitudes
      ? "对其他人物的态度:\n" +
        Object.entries(npc.attitudes)
          .map(([name, att]) => `  - 对 ${name}: ${att}`)
          .join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatMemories(memories: readonly MemoryEntry[]): string {
  if (memories.length === 0) return "（这是故事的开端，你还没有任何记忆。）";

  const recent = memories.slice(-MAX_RECENT_MEMORIES);
  const dialogue = recent.filter((memory) => memory.type === "dialogue");
  const continuity = recent.filter((memory) => memory.type !== "dialogue");
  const lines = (entries: readonly MemoryEntry[]) => entries.map((memory) => `  - [${memory.type}] ${memory.content}`).join("\n");
  return [
    "记忆使用边界：明示的身份、背景及角色“你知道的信息”都是已给定事实；以下记录用于互动连续性，不能把其中的说法升级为新的世界事实。",
    dialogue.length > 0
      ? `对话记录（未核实说法，不可作为新的世界事实依据）:\n${lines(dialogue)}`
      : "",
    continuity.length > 0
      ? `经历记录（仅用于互动连续性；不能据此断定未给定的世界细节）:\n${lines(continuity)}`
      : "",
    "若精确日期、经历或事件并未明确给出，请自然地说不知道或记不清。",
  ].filter(Boolean).join("\n");
}

function formatRecentMessages(messages: readonly AgentMessage[], limit: number): string {
  const history = messages
    .slice(-limit)
    .map((message) => {
      if (message.type === "narration") return `[旁白] ${message.content}`;
      if (message.type === "system") return `[系统] ${message.content}`;
      return `[${message.speaker}] ${message.content}`;
    })
    .join("\n");
  return "最近对话记录（未核实说法，不能据此新增或确认未给定的世界事实）:\n" + history;
}

function cloneMemory(entry: MemoryEntry): MemoryEntry {
  return cloneNPCMemory(entry);
}

function equalMemory(left: MemoryEntry, right: MemoryEntry): boolean {
  if (left.timestamp !== right.timestamp || left.type !== right.type
    || left.content !== right.content || left.importance !== right.importance
    || left.scene_id !== right.scene_id || left.is_summary !== right.is_summary) return false;
  const leftEntities = left.related_entities;
  const rightEntities = right.related_entities;
  return leftEntities === rightEntities
    || (leftEntities !== undefined && rightEntities !== undefined
      && leftEntities.length === rightEntities.length
      && leftEntities.every((entity, index) => entity === rightEntities[index]));
}

function equalMemories(left: readonly MemoryEntry[], right: readonly MemoryEntry[]): boolean {
  return left.length === right.length && left.every((memory, index) => equalMemory(memory, right[index]!));
}

function appendedMemoryCache(memories: readonly MemoryEntry[], entry: MemoryEntry): MemoryEntry[] {
  return appendNPCMemoryCacheCandidate(memories, entry);
}

function clonePersonality(personality: NPCPersonality): NPCPersonality {
  const cloned: NPCPersonality = {
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
    cloned.attitudes = attitudes;
  }
  if (personality.ruleset !== undefined) cloned.ruleset = personality.ruleset;
  if (personality.traits !== undefined) cloned.traits = { ...personality.traits };
  if (personality.factions !== undefined) cloned.factions = personality.factions.map((faction) => ({ ...faction }));
  if (personality.initialMood !== undefined) cloned.initialMood = personality.initialMood;
  return cloned;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function detachedFrozenPersonality(personality: NPCPersonality): NPCPersonality {
  return deepFreeze(clonePersonality(personality));
}

function runtimeStateEquals(
  memories: readonly MemoryEntry[],
  mood: NPCMood,
  relationship: number,
  playerInteractionCount: number,
  candidate: Readonly<{
    memories: readonly MemoryEntry[];
    mood: NPCMood;
    relationship: number;
    playerInteractionCount: number;
  }>,
): boolean {
  return mood === candidate.mood
    && relationship === candidate.relationship
    && playerInteractionCount === candidate.playerInteractionCount
    && equalMemories(memories, candidate.memories);
}

export class NPCAgent {
  readonly #name: string;
  readonly #personality: NPCPersonality;
  readonly #llm: LLMLike;
  #memories: readonly MemoryEntry[] = Object.freeze([]);
  readonly #systemPrompt: string;
  readonly #db?: NPCStore;
  readonly #onRuntimeStateMutation?: () => void;
  /** Installed only by the owning AgentRegistry; never exposed through the agent. */
  readonly #hostMemoryAppendToken?: object;

  /** 当前情绪状态 */
  #mood: NPCMood;
  /** 玩家关系值（-5~+5） */
  #relationship: number = 0;
  /** 对玩家的态度记录 */
  #playerInteractionCount: number = 0;

  constructor(
    personality: NPCPersonality,
    llm: LLMLike,
    db?: NPCStore,
    onRuntimeStateMutation?: () => void,
    hostMemoryAppendToken?: object,
  ) {
    this.#personality = detachedFrozenPersonality(personality);
    this.#name = this.#personality.name;
    this.#llm = llm;
    this.#db = db;
    this.#onRuntimeStateMutation = onRuntimeStateMutation;
    this.#hostMemoryAppendToken = hostMemoryAppendToken;
    this.#systemPrompt = buildSystemPrompt(this.#personality);
    this.#mood = this.#personality.initialMood ?? "neutral";
    npcHostMemoryAppendCapabilities.set(this, {
      prepare: (token, entry) => this.#prepareHostMemoryAppend(token, entry),
      seal: (token, plan) => this.#sealHostMemoryAppend(token, plan),
      bindProjection: (token, plan, receipt, projection) =>
        this.#bindHostMemoryAppendProjection(token, plan, receipt, projection),
      publish: (token, plan) => this.#publishHostMemoryAppend(token, plan),
      discard: (token, plan) => this.#discardHostMemoryAppend(token, plan),
    });
  }

  /** A fresh, recursively frozen detached personality view; it is never the live authority. */
  get personality(): NPCPersonality {
    return detachedFrozenPersonality(this.#personality);
  }

  /** Public display identity; host authority never reads this accessor. */
  get name(): string { return this.#name; }

  #notifyRuntimeStateMutation(): void {
    this.#onRuntimeStateMutation?.();
  }

  /** 从数据库加载记忆（如果 db 可用） */
  loadMemoriesFromDB(limit = MAX_RECENT_MEMORIES): void {
    if (!this.#db) return;
    const durable = this.#db.getRecentMemories(this.#name, limit);
    const loaded = projectNPCMemoryCache(durable, durable);
    if (equalMemories(this.#memories, loaded)) return;
    this.#memories = loaded;
    this.#notifyRuntimeStateMutation();
  }

  /** Export data only; dependencies remain attached to this live agent. */
  exportRuntimeState(): NPCAgentRuntimeState {
    return {
      memories: this.#memories.map(cloneMemory),
      mood: this.#mood,
      relationship: this.#relationship,
      playerInteractionCount: this.#playerInteractionCount,
    };
  }

  /** Replace all runtime data without persistence side effects. */
  restoreRuntimeState(state: NPCAgentRuntimeState): void {
    const memories = projectNPCMemoryCache(state.memories, state.memories);
    if (runtimeStateEquals(this.#memories, this.#mood, this.#relationship, this.#playerInteractionCount, {
      ...state,
      memories,
    })) return;
    this.#memories = memories;
    this.#mood = state.mood;
    this.#relationship = state.relationship;
    this.#playerInteractionCount = state.playerInteractionCount;
    this.#notifyRuntimeStateMutation();
  }

  /** 获取当前情绪 */
  getMood(): NPCMood { return this.#mood; }

  /** 获取当前关系值 */
  getRelationship(): number { return this.#relationship; }

  /** 获取有效特质 */
  private get traits() {
    return this.#personality.traits ?? DEFAULT_NPC_TRAITS;
  }

  /**
   * 获取 NPC 在当前状态下的反应集
   */
  getReactions(powerBalance = 0, threatLevel = 5) {
    return getNPCReactions(this.traits, this.#mood, powerBalance, this.#relationship, threatLevel);
  }

  /** 触发情绪转变 */
  triggerMood(trigger: MoodTrigger) {
    this.#triggerMood(trigger);
  }

  #triggerMood(trigger: MoodTrigger): void {
    const old = this.#mood;
    const next = updateMood(old, trigger, this.traits);
    if (old !== next) {
      const event: MemoryEntry = {
        timestamp: Date.now(),
        type: "event",
        content: `情绪变化: ${old} → ${next}（因为 ${trigger}）`,
        importance: 5,
      };
      this.#commitRuntimeTransition(this.#planRuntimeTransition({ mood: next, memory: event }));
    }
  }

  /** 调整关系值（正=友善，负=敌对） */
  adjustRelationship(delta: number) {
    this.#adjustRelationship(delta);
  }

  #adjustRelationship(delta: number): void {
    const next = Math.max(-5, Math.min(5, this.#relationship + delta));
    // A contact at the cap still increments the relationship table's distinct
    // interaction_count, but leaves the live projection/revision unchanged.
    this.#commitRuntimeTransition(this.#planRuntimeTransition({
      relationship: next,
      updatePlayerRelationship: true,
    }));
  }

  /** 记录一次玩家互动 */
  recordInteraction(positive: boolean) {
    const interactionCount = this.#playerInteractionCount + 1;
    const relationship = positive
      ? Math.max(-5, Math.min(5, this.#relationship + 0.5))
      : this.#relationship;
    let mood = this.#mood;
    let memory: MemoryEntry | undefined;
    // Preserve the established threshold semantics: every positive contact
    // from the third onward samples exactly one repeated-kindness transition.
    if (positive && interactionCount >= 3) {
      const nextMood = updateMood(this.#mood, "repeated_kindness", this.traits);
      if (nextMood !== this.#mood) {
        mood = nextMood;
        memory = {
          timestamp: Date.now(),
          type: "event",
          content: `情绪变化: ${this.#mood} → ${nextMood}（因为 repeated_kindness）`,
          importance: 5,
        };
      }
    }
    this.#commitRuntimeTransition(this.#planRuntimeTransition({
      mood,
      relationship,
      playerInteractionCount: interactionCount,
      memory,
      updatePlayerRelationship: positive,
    }));
  }

  /** Derive immutable candidate data before any durable or live mutation. */
  #planRuntimeTransition(input: {
    mood?: NPCMood;
    relationship?: number;
    playerInteractionCount?: number;
    memory?: MemoryEntry;
    updatePlayerRelationship?: boolean;
  }): NPCAgentRuntimeTransitionPlan {
    const memory = input.memory === undefined ? undefined : cloneMemory(input.memory);
    const nextCandidate = memory === undefined
      ? this.#memories.map(cloneMemory)
      : appendedMemoryCache(this.#memories, memory);
    // The no-store path uses the same pure retained-cache projection with its
    // own candidate as backing. A SQLite-bound transition replaces this with
    // the transaction-produced durable-backed projection before publication.
    const nextMemories = projectNPCMemoryCache(nextCandidate, nextCandidate);
    const sealedMemory = memory === undefined
      ? undefined
      : projectNPCMemoryCache([memory], [memory])[0]!;
    const expected = Object.freeze({
      mood: this.#mood,
      relationship: this.#relationship,
      playerInteractionCount: this.#playerInteractionCount,
    });
    const next = Object.freeze({
      memories: nextMemories,
      mood: input.mood ?? this.#mood,
      relationship: input.relationship ?? this.#relationship,
      playerInteractionCount: input.playerInteractionCount ?? this.#playerInteractionCount,
    });
    return Object.freeze({
      expected,
      next,
      ...(sealedMemory === undefined ? {} : { memory: sealedMemory }),
      updatePlayerRelationship: input.updatePlayerRelationship ?? false,
    });
  }

  /** Commit SQLite first; only a successful durable transition can publish live state. */
  #commitRuntimeTransition(plan: NPCAgentRuntimeTransitionPlan): void {
    let memories = plan.next.memories;
    if (this.#db) {
      const durable: NPCStoreRuntimeTransition = {
        expected: {
          mood: plan.expected.mood,
          relationship: plan.expected.relationship,
          interactionCount: plan.expected.playerInteractionCount,
        },
        next: {
          mood: plan.next.mood,
          relationship: plan.next.relationship,
          interactionCount: plan.next.playerInteractionCount,
        },
        ...(plan.memory === undefined ? {} : {
          memory: plan.memory,
          memoryCacheCandidate: plan.next.memories,
        }),
        updatePlayerRelationship: plan.updatePlayerRelationship,
      };
      const durableProjection = this.#db.commitRuntimeTransition(this.#name, durable);
      if (durableProjection !== undefined) memories = durableProjection;
    }

    this.#publishRuntimeTransition(plan, memories);
  }

  /** Replace the live projection exactly once, after the durable transaction commits. */
  #publishRuntimeTransition(
    plan: NPCAgentRuntimeTransitionPlan,
    memories: readonly MemoryEntry[],
  ): void {
    const changed = !runtimeStateEquals(this.#memories, this.#mood, this.#relationship, this.#playerInteractionCount, {
      memories,
      mood: plan.next.mood,
      relationship: plan.next.relationship,
      playerInteractionCount: plan.next.playerInteractionCount,
    });
    this.#memories = memories;
    this.#mood = plan.next.mood;
    this.#relationship = plan.next.relationship;
    this.#playerInteractionCount = plan.next.playerInteractionCount;
    if (changed) this.#notifyRuntimeStateMutation();
  }

  /** 处理战斗结果对 NPC 的影响 */
  handleCombatOutcome(won: boolean) {
    this.#triggerMood(won ? "combat_win" : "combat_loss");
  }

  /** 处理目睹恐怖事件 */
  handleWitnessHorror() {
    this.#triggerMood("witnessed_horror");
  }

  /** 记录一条新记忆 */
  remember(entry: MemoryEntry) {
    this.#appendMemory(entry);
  }

  #appendMemory(entry: MemoryEntry): void {
    // Calculate a detached next cache before any durable write. A failed
    // transaction must leave the current cache and registry revision intact.
    const appended = cloneMemory(entry);
    const nextCandidate = appendedMemoryCache(this.#memories, appended);
    const candidate = projectNPCMemoryCache(nextCandidate, nextCandidate);
    let projection = candidate;

    if (this.#db) {
      projection = this.#db.appendMemoryWithRetention(this.#name, appended, candidate);
    }
    this.#memories = projection;
    this.#notifyRuntimeStateMutation();
  }

  #prepareHostMemoryAppend(token: object, entry: MemoryEntry): NPCAgentPreparedMemoryAppend {
    this.#assertHostMemoryAppendToken(token);
    const appended = cloneMemory(entry);
    const nextCandidate = appendedMemoryCache(this.#memories, appended);
    const memoryCacheCandidate = projectNPCMemoryCache(nextCandidate, nextCandidate);
    const plan = Object.freeze({}) as NPCAgentPreparedMemoryAppend;
    preparedMemoryAppends.set(plan, {
      agent: this,
      npcId: this.#name,
      hostToken: token,
      expectedMemories: this.#memories,
      entry: appended,
      memoryCacheCandidate,
      receipt: Object.freeze({}),
      ...(this.#db === undefined ? { projection: memoryCacheCandidate } : {}),
      store: this.#db,
      sealed: false,
    });
    return plan;
  }

  #sealHostMemoryAppend(token: object, plan: NPCAgentPreparedMemoryAppend): void {
    const state = preparedMemoryAppends.get(plan);
    if (!state || state.agent !== this || state.npcId !== this.#name || state.store !== this.#db
      || state.hostToken !== token || state.sealed
      || !equalMemories(this.#memories, state.expectedMemories)) {
      throw new Error("NPCAgent host memory plan is unavailable");
    }
    state.sealed = true;
  }

  #bindHostMemoryAppendProjection(
    token: object,
    plan: NPCAgentPreparedMemoryAppend,
    receipt: object,
    projection: readonly MemoryEntry[],
  ): void {
    const state = preparedMemoryAppends.get(plan);
    if (!state || state.agent !== this || state.hostToken !== token || !state.sealed
      || state.receipt !== receipt || state.projection !== undefined) {
      throw new Error("NPCAgent host memory plan is unavailable");
    }
    // The store created this detached/frozen data inside the committed batch
    // transaction. Publication below performs only this owned replacement.
    state.projection = projection;
  }

  #publishHostMemoryAppend(token: object, plan: NPCAgentPreparedMemoryAppend): void {
    // AgentRegistry sealed this exact opaque plan before SQLite began. Its
    // post-commit path verifies only the opaque plan's already-sealed identity
    // and then performs owned memory replacement: no wrapper lookup,
    // callback, clone, or persistence can create a new dynamic failure.
    const state = preparedMemoryAppends.get(plan);
    if (!state || state.agent !== this || state.hostToken !== token || !state.sealed
      || state.projection === undefined) {
      throw new Error("NPCAgent host memory plan is unavailable");
    }
    preparedMemoryAppends.delete(plan);
    // This is an owned-array replacement only: no callback, public wrapper,
    // cloning, or storage operation remains after the durable group commit.
    this.#memories = state.projection;
  }

  #discardHostMemoryAppend(token: object, plan: NPCAgentPreparedMemoryAppend): void {
    const state = preparedMemoryAppends.get(plan);
    if (state?.agent === this && state.hostToken === token) preparedMemoryAppends.delete(plan);
  }

  #assertHostMemoryAppendToken(token: object): void {
    if (this.#hostMemoryAppendToken !== token) {
      throw new Error("NPCAgent host memory capability is unavailable");
    }
  }

  /** 记录对话 */
  rememberDialogue(speaker: string, content: string, importance = 5) {
    this.#rememberDialogue(speaker, content, importance);
  }

  #rememberDialogue(speaker: string, content: string, importance = 5): void {
    this.#appendMemory({
      timestamp: Date.now(),
      type: "dialogue",
      content: `${speaker}说: "${content}"`,
      importance,
    });
  }

  /** 记录事件 */
  rememberEvent(description: string, importance = 7) {
    this.#rememberEvent(description, importance);
  }

  #rememberEvent(description: string, importance = 7): void {
    this.#appendMemory({
      timestamp: Date.now(),
      type: "event",
      content: description,
      importance,
    });
  }

  /**
   * 对当前情境做出回应
   * @param context 当前发生的对话/事件上下文
   * @param recentMessages 最近几轮的消息历史
   * @returns 角色的回应文本
   */
  async respond(
    context: string,
    recentMessages: AgentMessage[] = [],
    constraintOpts?: NPCDialogueConstraintOpts,
  ): Promise<string> {
    const messages: LLMMessage[] = [
      { role: "system", content: this.#systemPrompt },
      { role: "system", content: formatMemories(this.#memories) },
    ];

    // 注入最近的消息历史
    if (recentMessages.length > 0) {
      messages.push({
        role: "system",
        content: formatRecentMessages(recentMessages, 10),
      });
    }

    // 注入当前情绪和关系状态
    const moodLine = `当前心情: ${this.#mood}（玩家关系: ${this.#relationship}）`;
    messages.push({
      role: "user",
      content: `${moodLine}\n\n现在的情况: ${context}\n\n请以 ${this.#name} 的身份回应。`,
    });

    const callOnce = async (extra?: LLMMessage): Promise<string> => {
      const raw = await this.#llm.chat(extra ? [...messages, extra] : messages, {
        temperature: 0.8,
        maxTokens: 300,
        maxAttempts: 1,
      });
      return raw.trim();
    };

    let response: string;
    try {
      response = await callOnce();

      // 输出约束层 — 检查并改写
      const constraintResult = applyConstraints(response, this.#personality, this.#mood, this.#relationship);
      if (!constraintResult.passed) {
        log.warn("npc", `NPC ${this.name} 约束拦截: ${constraintResult.warnings.join("; ")}`);
        response = constraintResult.sanitized;
      }

      response = await this.applyDialogueSafetyConstraints(response, constraintOpts, callOnce, "对话");

    } catch (err: any) {
      log.warn("npc", `NPC ${this.name} 回应 LLM 失败: ${err.message.slice(0, 60)}`);
      // LLM 不可用时，用角色性格生成模板回应
      return this.templateReply(context);
    }
    // Storage failure is not an LLM failure: callers need the rejection so a
    // session cannot publish dialogue that was not durably remembered.
    this.#rememberDialogue(this.#name, response);
    return response;
  }

  /**
   * 时代/角色实体两道世界观约束的共用检查+处置——respond()/speakUp()
   * 各自构造 `callOnce` 闭包传进来，这里只管"检查、要不要重生成、
   * 重生成后还不干净就退回安全兜底"这一段逻辑，不重复写两份。
   *
   * 两类命中处置方式不同（都是 block，但不是同一回事）：
   *   - `dialogue_fabricated_character`（todo-56，N9 任务 B）：值得给
   *     LLM 一次纠正机会——带上具体的纠正指示重新生成一次，仍不干净
   *     才退回兜底文案。与 kp-agent.ts 的 narrateOutcome 同一处置
   *     （block + 重生成 + 兜底），保持两条"叙事类"约束路径口径一致。
   *   - 其它 scope=dialogue 约束（时代错置/meta 词汇）：维持这两条
   *     约束原有的行为——直接换安全话术，不重生成（这两类命中通常是
   *     整句话都跑题了，重生成不一定能对症，且这是已有行为，本轮任务
   *     A 明确"只接线不改判定"，不在这里扩大改动范围）。
   */
  private async applyDialogueSafetyConstraints(
    response: string,
    constraintOpts: NPCDialogueConstraintOpts | undefined,
    callOnce: (extra?: LLMMessage) => Promise<string>,
    logLabel: string,
  ): Promise<string> {
    let hit = checkDialogueText(
      response, constraintOpts?.sceneId, constraintOpts?.ruleset, constraintOpts?.sceneFabricableCharacterNouns,
    );
    if (hit?.type === "block" && hit.blockMessage === DIALOGUE_FABRICATED_CHARACTER_BLOCK_MESSAGE) {
      log.warn("npc", `NPC ${this.name} ${logLabel}角色实体约束拦截，重生成一次（提到了场景里不存在的角色）`);
      response = await callOnce({
        role: "system",
        content: "上一句回答提到了一个这个场景实际不存在的角色（比如「老板」「前台」这类称呼），这与场景事实矛盾——不要提及任何具体的人名/身份称呼，除非你确定这个人真的在场，把这部分内容换成不点名任何人的说法。",
      });
      hit = checkDialogueText(
        response, constraintOpts?.sceneId, constraintOpts?.ruleset, constraintOpts?.sceneFabricableCharacterNouns,
      );
      if (hit?.type === "block" && hit.blockMessage === DIALOGUE_FABRICATED_CHARACTER_BLOCK_MESSAGE) {
        log.warn("npc", `NPC ${this.name} ${logLabel}重生成后仍命中角色实体约束，退回安全兜底文案`);
        return this.fabricatedCharacterSafeReply();
      }
      return response;
    }
    if (hit) {
      log.warn("npc", `NPC ${this.name} ${logLabel}时代约束拦截（含现代科技词）`);
      return this.anachronismSafeReply();
    }
    return response;
  }

  /**
   * NPC 主动发言（不由玩家触发，由 KP 调度）
   * @param trigger 触发原因描述
   * @param recentMessages 最近消息历史
   */
  async speakUp(
    trigger: string,
    recentMessages: AgentMessage[] = [],
    constraintOpts?: NPCDialogueConstraintOpts,
  ): Promise<string> {
    const messages: LLMMessage[] = [
      { role: "system", content: this.#systemPrompt },
      { role: "system", content: formatMemories(this.#memories) },
      {
        role: "user",
        content: `触发事件: ${trigger}\n\n你注意到了一些事。请以 ${this.#name} 的身份主动发言（1-2句）。`,
      },
    ];

    if (recentMessages.length > 0) {
      messages.splice(2, 0, {
        role: "system",
        content: formatRecentMessages(recentMessages, 5),
      });
    }

    const callOnce = async (extra?: LLMMessage): Promise<string> => {
      const raw = await this.#llm.chat(extra ? [...messages, extra] : messages, {
        temperature: 0.9,
        maxTokens: 200,
      });
      return raw.trim();
    };

    let response: string;
    try {
      response = await callOnce();

      // 输出约束层
      const constraintResult = applyConstraints(response, this.#personality, this.#mood, this.#relationship);
      if (!constraintResult.passed) {
        log.warn("npc", `NPC ${this.name} 主动发言约束拦截: ${constraintResult.warnings.join("; ")}`);
        response = constraintResult.sanitized;
      }

      response = await this.applyDialogueSafetyConstraints(response, constraintOpts, callOnce, "主动发言");

    } catch (err: any) {
      log.warn("npc", `NPC ${this.name} 主动发言 LLM 失败: ${err.message.slice(0, 60)}`);
      // LLM 不可用时用模板
      return this.templateSpeakUp(trigger);
    }
    // Keep the durable append outside the generation/constraint fallback.
    this.#rememberDialogue(this.#name, response, 6);
    return response;
  }

  /** 获取角色最近记忆（供调试） */
  getRecentMemories(n = 5): MemoryEntry[] {
    return this.#memories.slice(-n).map(cloneMemory);
  }

  /** 获取角色态度（供世界模型使用） */
  getAttitude(targetName: string): string {
    const attitudes = this.#personality.attitudes;
    return attitudes && Object.prototype.hasOwnProperty.call(attitudes, targetName)
      ? attitudes[targetName]!
      : "中立";
  }

  /** 时代约束拦截时的安全话术 — 不含任何具体内容/现代科技词，保持角色感 */
  private anachronismSafeReply(): string {
    const replies = [
      `（${this.name}摇了摇头）"这事……我得再想想怎么说。"`,
      `"抱歉，我一时不知道该怎么跟你说。"`,
      `（${this.name}沉默了片刻）"有些事，我还理不清头绪。"`,
      `"唉……说来话长，改天再细说吧。"`,
      `"我一时也想不明白。"`,
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }

  /**
   * 角色实体约束拦截、重生成仍不干净时的安全话术——开发·约束层补角色
   * 实体域 N9（todo-56）。不点名任何具体的人，避免重蹈"编出一个不存在
   * 的角色"的覆辙；与 `anachronismSafeReply()` 分开一份而不是共用，
   * 是因为那份话术的措辞是"这事我说不清"，读起来像在回避一个**话题**，
   * 这里要回避的是"点名一个人"，措辞更贴近"我不方便说是谁"。
   */
  private fabricatedCharacterSafeReply(): string {
    const replies = [
      `"我现在不方便回答。"`,
      `"这个问题我答不上来。"`,
      `"我不想贸然回答。"`,
      `"请换个问法。"`,
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }

  /** LLM 不可用时的模板回应（仅用自身状态，不编造场景事实） */
  private templateReply(_context: string): string {
    const p = this.#personality;
    const combined = (p.personality + " " + p.speech_style).toLowerCase();

    // 情绪驱动
    if (this.#mood === "fearful") {
      const replies = [
        `"别逼我现在说。"`,
        `"我得先缓一缓。"`,
        `"我现在理不清。"`,
        `"请让我安静一会儿。"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }

    if (this.#mood === "angry") {
      const replies = [
        `"我现在不想谈。"`,
        `"别再逼问了。"`,
        `"到此为止。"`,
        `"我不想再说下去。"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }

    if (this.#mood === "friendly") {
      const replies = [
        `"谢谢你愿意听我说。"`,
        `"你慢慢问，我会尽量回答。"`,
        `"别着急，我们慢慢说。"`,
        `"我愿意配合。"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }

    // 特质+性格关键词驱动
    if (this.traits.courage <= 3 || combined.includes("紧张") || combined.includes("警惕") || combined.includes("恐惧")) {
      const replies = [
        `"我有点慌，先让我想想。"`,
        `"别催我，我得缓一缓。"`,
        `"我现在说不清。"`,
        `"我不想贸然开口。"`,
        `"我需要一点时间。"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }

    if (combined.includes("沉默") || combined.includes("寡言") || combined.includes("简洁")) {
      const replies = [
        `"……"`,
        `"我暂时不想说。"`,
        `"让我静一会儿。"`,
        `"我还在想。"`,
        `"……先等等。"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }

    if (this.traits.friendliness >= 7 || combined.includes("友好") || combined.includes("热情") || combined.includes("开朗")) {
      const replies = [
        `"你慢慢问，我会尽量回答。"`,
        `"别着急，我们慢慢说。"`,
        `"我愿意配合。"`,
        `"先把问题说具体些。"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }

    // 关系值影响
    if (this.#relationship <= -2) {
      return `"我现在不想和你谈。"`;
    }

    if (this.#relationship >= 3) {
      const replies = [
        `"你来了。有什么想问的？"`,
        `"又见面了，慢慢说。"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }

    // 默认
    const defaults = [
      `"你想问什么？"`,
      `"请把问题说具体些。"`,
      `"我听着。"`,
      `"我一时答不上来。"`,
      `"我不想贸然回答。"`,
    ];
    return defaults[Math.floor(Math.random() * defaults.length)];
  }

  /** LLM 不可用时主动发言模板（仅用自身状态，不编造场景事实） */
  private templateSpeakUp(_trigger: string): string {
    const p = this.#personality;
    const combined = (p.personality + " " + p.speech_style).toLowerCase();

    if (this.#mood === "fearful" || combined.includes("紧张") || combined.includes("恐惧")) {
      const replies = [
        `"我有点乱，先让我缓一缓。"`,
        `"我现在不想多说。"`,
        `"请先别催我。"`,
        `"我得静一会儿。"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }
    if (this.#mood === "angry") {
      const replies = [
        `"我现在不想多说。"`,
        `"别再追问了。"`,
        `"到此为止。"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }
    if (this.#mood === "friendly") {
      const replies = [
        `"我在这儿，有话可以慢慢说。"`,
        `"别着急，我听着。"`,
        `"你想说什么？"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }
    if (combined.includes("沉默") || combined.includes("寡言")) {
      const replies = [
        `"……"`,
        `"我暂时不想说。"`,
        `"先等等。"`,
      ];

      return replies[Math.floor(Math.random() * replies.length)];
    }
    if (this.traits.friendliness >= 7 || combined.includes("友好") || combined.includes("热情") || combined.includes("开朗")) {
      const replies = [
        `"我在听。"`,
        `"别着急，慢慢说。"`,
        `"你想说什么？"`,
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }
    const defaults = [
      `"我在听。"`,
      `"你想说什么？"`,
      `"先等等。"`,
    ];
    return defaults[Math.floor(Math.random() * defaults.length)];
  }
}
