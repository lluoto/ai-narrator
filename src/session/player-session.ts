// 多玩家会话管理器 — per-receiver 架构
// 同一世界状态，不同玩家看到不同的旁白/线索/NPC对话
//
// 设计原则：
//   律书是共享的（战斗结果所有人可见）
//   叙事是分发的（KP 为每个玩家生成不同的旁白）
//   秘密是隔离的（发现线索的玩家 ≠ 知道线索的所有玩家）

import type { AgentMessage, VisibilityRule } from "../agent/types";
import {
  PLAYER_SESSION_SNAPSHOT_KIND,
  PLAYER_SESSION_SNAPSHOT_VERSION,
  validatePlayerSessionSnapshot,
  type PlayerSessionSnapshot,
} from "./player-session-snapshot";
// 重新导出：VisibilityRule 的真身现在挂在 agent/types.ts（AgentMessage 需要
// 它，反过来在这里定义会成环），但既有 import 点（index.ts、game-session.ts）
// 都写的是 `from "../session/player-session"`，保持这条路可用，不强改调用方。
export type { VisibilityRule };

// ============================================================
// 玩家槽位
// ============================================================

interface PlayerSlot {
  name: string;           // 玩家名（用于 CLI 切换）
  characterName: string;   // 角色名（用于叙事中的称呼）
  characterId: string;     // 对应 WorldStateManager 中的 entity_id
  joinedAt: number;        // 加入时间
  /** 此玩家的消息历史——只包含他可见的消息 */
  messageHistory: AgentMessage[];
  /** 此玩家当前已知的线索/秘密 */
  knownSecrets: Set<string>;
}

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return structuredClone([...messages]);
}

interface PreparedPlayerSessionState {
  snapshot: PlayerSessionSnapshot;
  players: Map<string, PlayerSlot>;
  activePlayerName: string | null;
  globalMessages: AgentMessage[];
}

declare const PLAYER_SESSION_PREPARED_PUSH: unique symbol;

/** Opaque, one-shot push plan made by PlayerSession's lexical host capability. */
export interface PreparedPlayerSessionPush {
  readonly [PLAYER_SESSION_PREPARED_PUSH]: never;
}

interface PreparedPlayerSessionPushState {
  session: PlayerSession;
  semanticRevision: bigint;
  stamped: AgentMessage;
  recipients: PlayerSlot[];
  sealed: boolean;
}

interface PlayerSessionHostPushCapability {
  prepare(
    message: AgentMessage,
    visibility: VisibilityRule,
    discoverer: string | undefined,
    targets: string[] | undefined,
  ): PreparedPlayerSessionPush;
  seal(plan: PreparedPlayerSessionPush): void;
  commit(plan: PreparedPlayerSessionPush): void;
  discard(plan: PreparedPlayerSessionPush): void;
}

const preparedPlayerSessionPushes = new WeakMap<object, PreparedPlayerSessionPushState>();
const playerSessionHostPushCapabilities = new WeakMap<PlayerSession, PlayerSessionHostPushCapability>();

/**
 * Host composition uses this lexical capability instead of a replaceable
 * session method. Planning completes all validation and foreign scene lookups
 * before a durable NPC fanout can start.
 */
export function preparePlayerSessionPushForHost(
  session: PlayerSession,
  message: AgentMessage,
  visibility: VisibilityRule = "public",
  discoverer?: string,
  targets?: string[],
): PreparedPlayerSessionPush {
  const capability = playerSessionHostPushCapabilities.get(session);
  if (!capability) throw new Error("PlayerSession host push capability is unavailable");
  return capability.prepare(message, visibility, discoverer, targets);
}

export function commitPreparedPlayerSessionPushForHost(
  session: PlayerSession,
  plan: PreparedPlayerSessionPush,
): void {
  const capability = playerSessionHostPushCapabilities.get(session);
  if (!capability) throw new Error("PlayerSession host push capability is unavailable");
  capability.commit(plan);
}

export function sealPreparedPlayerSessionPushForHost(
  session: PlayerSession,
  plan: PreparedPlayerSessionPush,
): void {
  const capability = playerSessionHostPushCapabilities.get(session);
  if (!capability) throw new Error("PlayerSession host push capability is unavailable");
  capability.seal(plan);
}

export function discardPreparedPlayerSessionPushForHost(
  session: PlayerSession,
  plan: PreparedPlayerSessionPush,
): void {
  playerSessionHostPushCapabilities.get(session)?.discard(plan);
}

function preparePlayerSessionState(snapshot: PlayerSessionSnapshot): PreparedPlayerSessionState {
  return {
    snapshot,
    players: new Map(snapshot.players.map((player) => [player.name, {
      name: player.name,
      characterName: player.characterName,
      characterId: player.characterId,
      joinedAt: player.joinedAt,
      messageHistory: player.messageHistory,
      knownSecrets: new Set(player.knownSecrets),
    }])),
    activePlayerName: snapshot.activePlayerName,
    globalMessages: snapshot.globalMessages,
  };
}

function samePlayerSessionSnapshot(left: PlayerSessionSnapshot, right: PlayerSessionSnapshot): boolean {
  // Both operands came from the exact validator, which canonicalizes every
  // object key and admits only bounded JSON values. Array order is semantic.
  return JSON.stringify(left) === JSON.stringify(right);
}

export type { PlayerSessionSnapshot } from "./player-session-snapshot";

// ============================================================
// 玩家会话管理器
// ============================================================

export class PlayerSession {
  #players: Map<string, PlayerSlot> = new Map();
  #activePlayerName: string | null = null;
  /** 全局消息日志（所有消息，未过滤） */
  #globalMessages: AgentMessage[] = [];
  #replacementRevision = 0n;
  #semanticMutationRevision = 0n;

  /**
   * 权威场景来源——按 `characterId`（对应 WorldStateManager 的 entity id）
   * 查"这个人现在在哪"。
   *
   * 开发·多人可见性 N6，todo-24：此前这里自己存一份 `PlayerSlot.currentScene`，
   * 只在 `join()` 时写一次，之后唯一能更新它的 `setPlayerScene` 全仓零调用方——
   * 玩家实际移动后这份拷贝再也不会跟着变，`scene_restricted` 可见性判定与
   * `getPlayersInScene()` 因此永远读到入场时的旧场景。真正权威、且真的会
   * 随移动更新的场景数据本来就存在（`WorldEntity.position`，GameSession.
   * movePlayerToScene() 等每次玩家移动都会 `world.upsertEntity` 写回这里），
   * 与其在 PlayerSession 里再存一份必然漂移的拷贝，不如直接问权威来源——
   * 两个构造方（GameSession/index.ts）在创建 PlayerSession 时都已经有自己
   * 的 WorldStateManager，能把查询闭包过来。
   */
  readonly #sceneOf: (characterId: string) => string | undefined;

  constructor(sceneOf: (characterId: string) => string | undefined) {
    this.#sceneOf = sceneOf;
    playerSessionHostPushCapabilities.set(this, {
      prepare: (message, visibility, discoverer, targets) => this.#prepareHostPush(message, visibility, discoverer, targets),
      seal: (plan) => this.#sealHostPush(plan),
      commit: (plan) => this.#commitHostPush(plan),
      discard: (plan) => this.#discardHostPush(plan),
    });
  }

  /**
   * Process-local identity for semantic whole-state replacements only.
   *
   * This deliberately does not claim to cover join/leave/switch/push/discover
   * ordinary mutators.
   * Portable snapshots and hashes must never include it.
   */
  get stateReplacementRevision(): bigint { return this.#replacementRevision; }

  /**
   * Process-local identity for every successful semantic PlayerSession change.
   * It must never appear in portable snapshots, hashes, or schemas.
   */
  get semanticRevision(): bigint { return this.#semanticMutationRevision; }

  // ==========================================================
  // 玩家管理
  // ==========================================================

  /** 加入游戏 */
  join(name: string, characterName: string, characterId: string): PlayerSlot {
    if (this.#players.has(name)) {
      throw new Error(`玩家 "${name}" 已存在`);
    }
    const slot: PlayerSlot = {
      name,
      characterName,
      characterId,
      joinedAt: Date.now(),
      messageHistory: [],
      knownSecrets: new Set(),
    };
    this.#players.set(name, slot);
    if (!this.#activePlayerName) this.#activePlayerName = name;
    this.#semanticMutationRevision++;
    return this.#detachedSlot(slot);
  }

  /** 离开游戏 */
  leave(name: string): boolean {
    if (!this.#players.delete(name)) return false;
    if (this.#activePlayerName === name) {
      this.#activePlayerName = this.#players.keys().next().value ?? null;
    }
    this.#semanticMutationRevision++;
    return true;
  }

  /** 切换当前活动的玩家（谁在 CLI 中输入） */
  switchActive(name: string): boolean {
    if (!this.#players.has(name)) return false;
    if (this.#activePlayerName === name) return true;
    this.#activePlayerName = name;
    this.#semanticMutationRevision++;
    return true;
  }

  /** 获取当前活动玩家 */
  getActive(): PlayerSlot | null {
    const active = this.#activeSlot();
    return active ? this.#detachedSlot(active) : null;
  }

  /** 获取指定玩家 */
  get(name: string): PlayerSlot | undefined {
    const player = this.#players.get(name);
    return player ? this.#detachedSlot(player) : undefined;
  }

  /** 获取所有玩家 */
  getAll(): PlayerSlot[] {
    return [...this.#players.values()].map((player) => this.#detachedSlot(player));
  }

  /** 获取所有玩家名 */
  getAllNames(): string[] {
    return [...this.#players.keys()];
  }

  /** Internal restore primitive for the single-PC compiled snapshot boundary. */
  restoreSinglePlayer(name: string, characterName: string, history: AgentMessage[]): void {
    const existing = this.#players.size === 1 ? this.#players.get(name) : undefined;
    // Repeating an otherwise exact restore must not become a replacement only
    // because observing Date.now() produced a new operational timestamp.
    const joinedAt = existing?.characterName === characterName && existing.characterId === name
      ? existing.joinedAt
      : Date.now();
    this.restoreSnapshot({
      kind: PLAYER_SESSION_SNAPSHOT_KIND,
      schemaVersion: PLAYER_SESSION_SNAPSHOT_VERSION,
      players: [{
        name,
        characterName,
        characterId: name,
        joinedAt,
        messageHistory: history,
        knownSecrets: [],
      }],
      activePlayerName: name,
      globalMessages: history,
    });
  }

  /** Exact, portable checkpoint for a failed compiled-session restoration. */
  snapshot(): PlayerSessionSnapshot {
    return this.exportSnapshot();
  }

  /** Versioned JSON-safe document for a future outer session envelope. */
  exportSnapshot(): PlayerSessionSnapshot {
    // Export runs through the same validator used by restore, which both checks
    // the live invariant and reconstructs all nested arrays and messages.
    return validatePlayerSessionSnapshot({
      kind: PLAYER_SESSION_SNAPSHOT_KIND,
      schemaVersion: PLAYER_SESSION_SNAPSHOT_VERSION,
      players: [...this.#players.values()].map((player) => ({
        name: player.name,
        characterName: player.characterName,
        characterId: player.characterId,
        joinedAt: player.joinedAt,
        messageHistory: player.messageHistory,
        knownSecrets: [...player.knownSecrets],
      })),
      activePlayerName: this.#activePlayerName,
      globalMessages: this.#globalMessages,
    });
  }

  restoreSnapshot(snapshot: unknown): void {
    // Validation reconstructs foreign data before this method changes any live
    // field, so a failure cannot partially replace histories, secrets, or active.
    const prepared = preparePlayerSessionState(validatePlayerSessionSnapshot(snapshot));
    let current: PlayerSessionSnapshot | null = null;
    try {
      current = this.exportSnapshot();
    } catch {
      // A valid replacement is also the repair boundary for live state that a
      // prior defect or test-only private corruption made non-exportable.
      // Input validation and preparation happened outside this catch, so an
      // invalid replacement can never be mistaken for repairable current-state drift.
    }
    if (current && samePlayerSessionSnapshot(current, prepared.snapshot)) return;
    this.#players = prepared.players;
    this.#activePlayerName = prepared.activePlayerName;
    this.#globalMessages = prepared.globalMessages;
    this.#replacementRevision++;
    this.#semanticMutationRevision++;
  }

  /** 玩家数量 */
  get count(): number { return this.#players.size; }

  // ==========================================================
  // 消息分发（per-receiver 核心）
  // ==========================================================

  /**
   * 推送一条消息，根据可见性规则分发到不同玩家的历史
   * @param message 消息
   * @param visibility 可见性规则
   * @param discoverer 如果是 discoverer_only，指定发现者
   * @param targets 如果是 targeted，指定目标玩家名列表
   */
  push(
    message: AgentMessage,
    visibility: VisibilityRule = "public",
    discoverer?: string,
    targets?: string[]
  ) {
    const plan = this.#prepareHostPush(message, visibility, discoverer, targets);
    this.#sealHostPush(plan);
    this.#commitHostPush(plan);
  }

  #prepareHostPush(
    message: AgentMessage,
    visibility: VisibilityRule,
    discoverer: string | undefined,
    targets: string[] | undefined,
  ): PreparedPlayerSessionPush {
    // 入会话即打时间戳：Markdown 导出依赖它显示时间，此前该字段从未被写入，
    // 导出的时间列因此一直是空的。已有 timestamp 的消息（回放/存档）保持原值。
    // Take a deep copy before storing so either timestamp path has no input
    // alias into the global log or per-player histories.
    // `visible_to` was a second, per-receiver routing model that push() never
    // consumed. Reject even an explicitly undefined own field before cloning,
    // timestamping, routing, logging, or revision changes so it cannot imply
    // privacy that the actual visibility arguments do not provide.
    if (Object.prototype.hasOwnProperty.call(message, "visible_to")) {
      throw new Error("PlayerSession.push does not accept message.visible_to; use visibility, discoverer, and targets");
    }
    const stamped = cloneMessages([message])[0]!;
    if (stamped.timestamp === undefined) stamped.timestamp = Date.now();
    const recipients: PlayerSlot[] = [];
    // sceneOf is a foreign callback. Complete planning before any authority
    // write so an exception cannot leave a partial global/history mutation.

    // 全局日志记录完整消息

    // 根据可见性规则分发
    switch (visibility) {
      case "public":
        for (const player of this.#players.values()) {
          recipients.push(player);
        }
        break;

      case "scene_restricted": {
        // 简化：所有同场景的玩家可见——场景本身按 characterId 问权威来源
        // （this.sceneOf），不再读一份自己存的、不会跟着移动更新的拷贝。
        const active = this.#activeSlot();
        const activeScene = (active && this.#sceneOf(active.characterId)) ?? "";
        for (const player of this.#players.values()) {
          if (this.#sceneOf(player.characterId) === activeScene) {
            recipients.push(player);
          }
        }
        break;
      }

      case "discoverer_only":
        if (discoverer) {
          const player = this.#players.get(discoverer);
          if (player) {
            recipients.push(player);
            // KP 也记录（DM 总是知道一切）
          }
        }
        break;

      case "targeted":
        if (targets) {
          for (const t of targets) {
            const player = this.#players.get(t);
            if (player) recipients.push(player);
          }
        }
        break;

      case "private": {
        const active = this.#activeSlot();
        if (active) {
          recipients.push(active);
          // KP 在全局日志中可见此消息
        }
        break;
      }
    }
    const plan = Object.freeze({}) as PreparedPlayerSessionPush;
    preparedPlayerSessionPushes.set(plan, {
      session: this,
      semanticRevision: this.#semanticMutationRevision,
      stamped,
      recipients,
      sealed: false,
    });
    return plan;
  }

  #sealHostPush(plan: PreparedPlayerSessionPush): void {
    const state = preparedPlayerSessionPushes.get(plan);
    if (!state || state.session !== this || state.sealed || state.semanticRevision !== this.#semanticMutationRevision) {
      throw new Error("PlayerSession host push plan is unavailable");
    }
    state.sealed = true;
  }

  #commitHostPush(plan: PreparedPlayerSessionPush): void {
    // Host composition seals the revision before durable work begins. With no
    // await or SQLite-to-JS callback, the only guard here is the opaque plan
    // identity/seal check; the remaining mutation is owned arrays.
    const state = preparedPlayerSessionPushes.get(plan);
    if (!state || state.session !== this || !state.sealed) {
      throw new Error("PlayerSession host push plan is unavailable");
    }
    // Planning has already cloned/timestamped the message and evaluated every
    // scene callback. The remainder is owned array mutation only and cannot
    // invoke user code after the durable NPC group has committed.
    preparedPlayerSessionPushes.delete(plan);
    this.#globalMessages.push(state.stamped);
    for (const player of state.recipients) player.messageHistory.push(state.stamped);
    this.#semanticMutationRevision++;
  }

  #discardHostPush(plan: PreparedPlayerSessionPush): void {
    const state = preparedPlayerSessionPushes.get(plan);
    if (state?.session === this) preparedPlayerSessionPushes.delete(plan);
  }

  /** 获取指定玩家的消息历史 */
  getPlayerHistory(playerName: string): AgentMessage[] {
    const history = this.#players.get(playerName)?.messageHistory;
    return history ? cloneMessages(history) : [];
  }

  /** 获取当前活动玩家的消息历史（用于 CLI 输出） */
  getActiveHistory(): AgentMessage[] {
    const history = this.#activeSlot()?.messageHistory;
    return history ? cloneMessages(history) : [];
  }

  /** 获取最近 N 条全局消息 */
  getRecentGlobal(n: number = 10): AgentMessage[] {
    return cloneMessages(this.#globalMessages.slice(-n));
  }

  // ==========================================================
  // 秘密/线索管理
  // ==========================================================

  /** 玩家发现了一个秘密/线索 */
  discover(playerName: string, secretId: string) {
    const player = this.#players.get(playerName);
    if (!player || player.knownSecrets.has(secretId)) return;
    player.knownSecrets.add(secretId);
    this.#semanticMutationRevision++;
  }

  /** 玩家是否知道某秘密 */
  knowsSecret(playerName: string, secretId: string): boolean {
    return this.#players.get(playerName)?.knownSecrets.has(secretId) ?? false;
  }

  // ==========================================================
  // 场景同步
  // ==========================================================

  /** 玩家当前所在场景——问权威来源（this.sceneOf），不存自己的拷贝。 */
  getPlayerScene(playerName: string): string | undefined {
    const player = this.#players.get(playerName);
    return player ? this.#sceneOf(player.characterId) : undefined;
  }

  /** 获取同场景的其他玩家 */
  getPlayersInScene(sceneId: string): PlayerSlot[] {
    return [...this.#players.values()]
      .filter((player) => this.#sceneOf(player.characterId) === sceneId)
      .map((player) => this.#detachedSlot(player));
  }

  /** Internal live lookup. Public getters must never expose this object. */
  #activeSlot(): PlayerSlot | null {
    if (!this.#activePlayerName) return null;
    return this.#players.get(this.#activePlayerName) ?? null;
  }

  /**
   * Preserve the historical mutable PlayerSlot shape while isolating it from
   * authority. Capture every nested value at return time so a retained view
   * remains a coherent snapshot even when the source changes before its first
   * nested read.
   */
  #detachedSlot(slot: PlayerSlot): PlayerSlot {
    let messageHistory = cloneMessages(slot.messageHistory);
    let knownSecrets = new Set(slot.knownSecrets);
    return {
      name: slot.name,
      characterName: slot.characterName,
      characterId: slot.characterId,
      joinedAt: slot.joinedAt,
      get messageHistory() {
        return messageHistory;
      },
      set messageHistory(value: AgentMessage[]) {
        messageHistory = cloneMessages(value);
      },
      get knownSecrets() {
        return knownSecrets;
      },
      set knownSecrets(value: Set<string>) {
        knownSecrets = new Set(value);
      },
    };
  }
}
