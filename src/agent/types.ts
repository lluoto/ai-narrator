// Agent 类型定义 — NPC Agent / KP Agent

import type { WorldState } from "../types";

// ============================================================
// NPC 结构化性格特质（影响战斗/社交/事件反应）
// ============================================================

/**
 * ⚠ 下面五个字段标注的 1-10 是**软约定，不强制**——类型是裸 `number`，
 * 没有类似 `world-property.ts` 的 `StateDomain` 那种校验。
 * `src/rules/mythos-module.ts:1059` 就写了 `courage: 15, suspicion: 12,
 * stability: 18`，越界越了不少（那条注释是故意的：`friendliness: 1` 与
 * `stability: 18` 一起用来表达角色的「非人感」）。
 *
 * 这不只是文档口径不一致——它有真实的下游后果：`npc-agent.ts:46-50`
 * 把这些值直接拼进给 LLM 看的提示词，写的是 `"勇气: ${courage}/10"`。
 * `courage: 15` 拼出来就是「勇气: 15/10」——一个自己都说不通的分数，
 * 这跟"表达非人感"的本意是反的：LLM 读到的不是"超出常人的勇气"，
 * 是一个格式错误的数字。
 *
 * 没有直接改数据或改提示词格式——两种改法都是行为变更，需要先决定
 * 「越界该不该允许／越界了要不要在展示时钳位／要不要换一种不隐含
 * 满分的展示格式」，这是设计决策，不是本轮文档订正的范围。
 */
export interface NPCTraits {
  /** 勇气 1-10（低=怯懦爱逃，高=悍不畏死） */
  courage: number;
  /** 友善 1-10（低=冷漠敌对，高=热情助人） */
  friendliness: number;
  /** 怀疑 1-10（低=轻信，高=多疑，影响说服难度） */
  suspicion: number;
  /** 好奇心 1-10（低=墨守成规，高=主动探索） */
  curiosity: number;
  /** 情绪稳定性 1-10（低=易恐慌/暴怒，高=处变不惊） */
  stability: number;
}

/** 默认 NPC 特质（普通路人） */
export const DEFAULT_NPC_TRAITS: NPCTraits = {
  courage: 5,
  friendliness: 5,
  suspicion: 5,
  curiosity: 5,
  stability: 5,
};

// ============================================================
// NPC 阵营/势力
// ============================================================

interface NPCFaction {
  /** 阵营名 */
  name: string;
  /** 对该阵营的忠诚度 1-10（决定背叛/出卖的阈值） */
  loyalty: number;
}

/** NPC 情绪状态 */
export type NPCMood = "neutral" | "friendly" | "angry" | "fearful" | "suspicious" | "excited" | "sad" | "calm";

/** 运行时可枚举的同一份取值。与上面的联合类型手工同步——加取值时两处一起改。 */
export const NPC_MOODS = [
  "neutral", "friendly", "angry", "fearful", "suspicious", "excited", "sad", "calm",
] as const satisfies readonly NPCMood[];

export const NPC_RULESETS = ["cosmic-horror", "dnd5e", "grail"] as const;
export type NPCRuleset = typeof NPC_RULESETS[number];

export const NPC_MEMORY_TYPES = ["observation", "dialogue", "event", "decision"] as const;
export type NPCMemoryType = typeof NPC_MEMORY_TYPES[number];

/**
 * 把来路不明的值收成 NPCMood，不合法就返回 undefined。
 *
 * 情绪有三个不经编译器的入口：npcs.yaml（运行时 parse，any）、编辑器存的模组
 * JSON（边界解析器有意透传创作字段）、以及历史数据库里的旧值。
 * 而下游是按这八个取值分派的 —— 越界值不会报错，只会让每个分支都落空：
 * 语音层选不到音色，情绪相关的判断静默失效。实测曾从 /history 里拿到过
 * "paranoid"，模组数据里一共躺着六个这样的值。
 */
export function asNPCMood(value: unknown): NPCMood | undefined {
  return typeof value === "string" && NPC_MOODS.includes(value as NPCMood)
    ? (value as NPCMood)
    : undefined;
}

// ============================================================
// NPC 人格卡
// ============================================================

export interface NPCPersonality {
  name: string;
  role: string; // "半精灵游荡者" | "酒馆老板" | "邪教徒"
  personality: string; // 性格描述
  background: string; // 背景故事
  goals: string[]; // 当前目标
  speech_style: string; // 说话风格
  knowledge: string[]; // 角色知道的信息
  secrets: string[]; // 秘密（不主动透露）
  /** 对其他角色的态度 */
  attitudes?: Record<string, string>; // character_name → attitude_description
  /** 适用的规则集（留空表示适用于所有规则集） */
  ruleset?: NPCRuleset;
  /** 结构化性格特质（缺省时使用 DEFAULT_NPC_TRAITS） */
  traits?: NPCTraits;
  /** 所属阵营 */
  factions?: NPCFaction[];
  /** 初始情绪 */
  initialMood?: NPCMood;
}

// ============================================================
// NPC 记忆条目
// ============================================================

export interface MemoryEntry {
  timestamp: number;
  type: NPCMemoryType;
  content: string;
  importance: number; // 1-10, 越大越重要

  // 以下三项 npc_memories 表都有对应列，写入与回读的代码也都在，
  // 只是此前没有声明在类型上 —— 写入端靠 as any 去读，读回端靠
  // `as MemoryEntry & any` 混出来。目前没有调用方填过它们，
  // 于是 getSceneMemories 永远查不到东西、pruneMemories 的"保留摘要"
  // 也从未生效。声明出来是为了让这个缺口可见且可填，不改变现有行为。

  /** 记忆发生的场景 ID；getSceneMemories 按它筛选 */
  scene_id?: string;
  /** 与这条记忆相关的实体名 */
  related_entities?: string[];
  /** 是否为压缩摘要；pruneMemories 不删摘要条目 */
  is_summary?: boolean;
}

// ============================================================
// Agent 消息
// ============================================================

export interface AgentMessage {
  speaker: string; // NPC 名字 或 "KP" 或 "玩家"
  content: string;
  type: AgentMessageType;
  /**
   * 内容是否为模组原文逐字输出（而非 LLM 生成）。
   *
   * 用可选标记而不是新增 type 分支：`type === "narration"` 已有 4 处消费者
   * （NPC 记忆、旁白前缀、导出标签、前端叙事筛选），新增联合分支会让模组原文
   * 静默掉出这些路径。标记是纯增量的，老消费者行为不变。
   */
  verbatim?: boolean;
  /**
   * 说这句话时 NPC 的情绪。
   *
   * 必须在生成时刻捕获：mood 是状态机（8 种触发驱动转移），播放或回放时
   * 回查 `NPCAgent.getMood()` 拿到的是当时的情绪而非说这句话时的情绪。
   * 取值与主流情感 TTS 的 style 参数基本对应，是未来语音层的音色输入。
   */
  mood?: NPCMood;
  /**
   * 历史持久化 snapshot 的兼容字段，不是 live 路由策略。新的
   * PlayerSession.push 对任何自有该字段 fail-closed；路由只看
   * visibility/discoverer/targets。
   */
  visible_to?: string[];
  /**
   * 入会话时间（epoch ms），由 PlayerSession.push 统一打上。
   * 可选：早先存档里的历史消息没有这个字段。
   */
  timestamp?: number;
  /**
   * 可见性规则，配合 discoverer 使用——message 自带路由信息，
   * PlayerSession.push 据此分发到不同玩家的 messageHistory。缺省视为
   * "public"（push() 的默认参数）。
   *
   * ⚠ 这不是 visible_to：后者只为 legacy snapshot parser/restore/export
   * 兼容保留；新的 PlayerSession.push 会拒绝任何自有名单字段。
   * 这里复用的是 PlayerSession.push(message, visibility, discoverer, targets)
   * 已有的、GameSession.addMessage 已经在用的 vocabulary——不新开第三套。
   */
  visibility?: VisibilityRule;
  /** visibility 为 "discoverer_only" 时，谁是发现者（pcId）。 */
  discoverer?: string;
}

/**
 * 消息可见性规则。原定义在 session/player-session.ts，搬到这里是因为
 * AgentMessage（上面）需要它，而 player-session.ts 反过来 import
 * AgentMessage——放回 session 层会成环。
 */
export const VISIBILITY_RULES = [
  "public", "scene_restricted", "discoverer_only", "targeted", "private",
] as const;

export type VisibilityRule = typeof VISIBILITY_RULES[number];

/** Runtime source of truth for AgentMessage.type consumers and validators. */
export const AGENT_MESSAGE_TYPES = ["dialogue", "narration", "system", "action"] as const;
export type AgentMessageType = typeof AGENT_MESSAGE_TYPES[number];

/**
 * 消息类型 — API 响应、CLI、模组宿主接口共用同一套取值。
 * 单独导出，避免各层各自写 `string` 而丢失联合类型约束。
 */
export type MessageType = AgentMessage["type"];

// ============================================================
// 游戏轮次记录
// ============================================================

export interface TurnRecord {
  round: number;
  timestamp: number;
  player_input: string;
  messages: AgentMessage[];
  world_snapshot: WorldState | null;
}

// ============================================================
// KP 指令
// ============================================================

export interface KPDirective {
  /** 当前场景描述 */
  scene_description: string;
  /** 场景中的关键元素（NPC、物品、线索等） */
  scene_elements: string[];
  /** 剧情节点列表 */
  plot_nodes: { id: string; description: string; trigger: string; done: boolean }[];
  /** 当前剧情阶段 */
  current_phase: string;
  /** KP 风格 */
  style: "standard" | "lovecraft" | "heroic" | "mystery";
}
