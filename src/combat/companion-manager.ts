// CompanionManager — AI 队友管理器
// 职责：招募/自主行动/离队
//
// 设计原则：
// - 队友以 WorldEntity（faction="player_ally"）存在于世界里
// - 每个角色入队一次（叙事事件），不再有「召唤」「解散」
// - 与普通 NPC 共用 combat 管线，但战斗决策由 CompanionAgent 驱动
// - 玩家可随时接管控制（热插拔），无指令时 AI 自主行动
// - 离队是叙事事件：战死、士气崩溃、动机完成，不手动解散

import type { WorldEntity, WorldState, ActionIntent, CompanionConfig, CompanionState, CompanionSnapshot, ResolveResult } from "../types";
import type { WorldStateManager } from "../state/world-state-manager";
import type { AgentMessage } from "../agent/types";
import { CompanionAgent } from "../agent/companion-agent";
import {
  validateCompanionManagerSnapshot,
  validateCompanionSnapshotWorld,
  validateLegacyCompanionSnapshots,
  type CompanionManagerSnapshot,
  type CompanionSnapshotWorld,
} from "./companion-manager-snapshot";

// ============================================================
// 常量
// ============================================================

const ENTITY_ID_PREFIX = "companion_";

type LegacySnapshotWorld = CompanionSnapshotWorld & Pick<WorldStateManager, "killEntity" | "upsertEntity">;

function canRestoreLegacySnapshot(world: CompanionSnapshotWorld): world is LegacySnapshotWorld {
  const candidate = world as Partial<LegacySnapshotWorld>;
  return typeof candidate.killEntity === "function" && typeof candidate.upsertEntity === "function";
}

// ============================================================
// 队友管理器
// ============================================================

export class CompanionManager {
  /** 已注册的队友配置 */
  private companions: Map<string, CompanionState> = new Map();
  /** 每个队友的 AI agent */
  private agents: Map<string, CompanionAgent> = new Map();
  /** 本轮已行动的队友（防玩家命令 + AI 自主双重行动） */
  private actedThisRound: Set<string> = new Set();

  // ==========================================================
  // 生命周期
  // ==========================================================

  /**
   * 招募入队（叙事事件，幂等）
   * 已入队则返回现有 state，不走第二遍叙事
   */
  recruit(config: CompanionConfig, world: WorldStateManager, _sceneId?: string): { state: CompanionState; firstTime: boolean } {
    // 幂等：已注册 && active 则跳过
    const existing = this.companions.get(config.id);
    if (existing && existing.active) {
      return { state: existing, firstTime: false };
    }

    const entityId = `${ENTITY_ID_PREFIX}${config.id}`;

    // 1. 创建世界实体
    const entity: Partial<WorldEntity> & { id: string; name: string; type: WorldEntity["type"] } = {
      id: entityId,
      name: config.name,
      type: config.type,
      hp: config.hp,
      maxHp: config.maxHp,
      ac: config.ac,
      status: [],
      position: "melee_range",
      faction: config.faction ?? "player_ally",
    };
    world.upsertEntity(entity);

    // 2. 注册状态
    const state: CompanionState = {
      config,
      entityId,
      behavior: config.behavior,
      active: true,
      inventory: [...(config.inventory ?? [])],
      morale: 10,
      invited: false,
      control: "auto",
      resolveState: "normal",
      resolveTurnsLeft: 0,
    };
    this.companions.set(config.id, state);

    // 3. 创建 AI agent
    const agent = new CompanionAgent(config, entityId,);
    this.agents.set(config.id, agent);

    return { state, firstTime: true };
  }

  /**
   * 标记已邀请（防止重复播招商文本）
   */
  markInvited(id: string): boolean {
    const state = this.companions.get(id);
    if (!state || !state.active || state.invited) return false;
    state.invited = true;
    return true;
  }

  /**
   * 离队处理（叙事事件）
   * trigger: "hp_zero" | "morale_cower" | "motivation_done"
   * 从世界移除实体，但保留状态记录以便后续重新邀请
   */
  handleDeparture(id: string, world: WorldStateManager, trigger: string): string | null {
    const state = this.companions.get(id);
    if (!state || !state.active) return null;

    // 找匹配的离队条件
    const departureDef = state.config.departure?.find(d => d.trigger === trigger);
    const farewell = departureDef?.farewell ?? `${state.config.name} 离开了队伍。`;

    // 从世界移除
    world.killEntity(state.entityId);

    state.active = false;
    this.agents.delete(id);

    return farewell;
  }

  /**
   * 士气变更（0-10，归零触发 morale_cower 离队）
   * 返回 changed = true 表示有变化
   */
  adjustMorale(id: string, delta: number): { morale: number; triggered: boolean; resolve?: ResolveResult } {
    const state = this.companions.get(id);
    if (!state || !state.active) return { morale: 0, triggered: false };

    const before = state.morale;
    state.morale = Math.max(0, Math.min(10, state.morale + delta));

    // ⚠ `checkResolve()` 的文档注释写着触发条件是「大伤害、低士气阈值、队友阵亡」，
    //   但**没有任何地方触发它** —— 整套决心系统写完就没接上。
    //   士气掉进阈值是三条里唯一在这个方法管得到的，接在这里。
    //   掉得越狠难度越高：这也是 `difficulty` 参数第一次真的被用上。
    let resolve: ResolveResult | undefined;
    const RESOLVE_THRESHOLD = 4;
    if (delta < 0 && before > RESOLVE_THRESHOLD && state.morale <= RESOLVE_THRESHOLD) {
      resolve = this.checkResolve(state.config.id, 50 + Math.abs(delta) * 5);
    }
    return { morale: state.morale, triggered: state.morale <= 0, resolve };
  }

  /**
   * 通过实体 ID 调整士气
   */
  adjustMoraleByEntity(entityId: string, delta: number): { morale: number; triggered: boolean } {
    const state = this.findByEntityId(entityId);
    if (!state) return { morale: 0, triggered: false };
    return this.adjustMorale(state.config.id, delta);
  }

  /** 读取士气值 */
  getMorale(id: string): number {
    return this.companions.get(id)?.morale ?? 0;
  }

  /**
   * 检查主动离队触发
   * 遍历所有 companion，检查 departure 条件是否满足
   * 返回离队消息列表
   */
  checkDepartureTriggers(world: WorldStateManager): string[] {
    const messages: string[] = [];
    for (const [id, state] of this.companions) {
      if (!state.active) continue;

      for (const dep of state.config.departure ?? []) {
        let doLeave = false;

        switch (dep.trigger) {
          case "hp_zero": {
            const ent = world.getEntity(state.entityId);
            if (ent && ent.hp !== undefined && ent.hp <= 0) {
              doLeave = true;
            }
            break;
          }
          case "morale_cower": {
            if (state.morale <= 0) {
              doLeave = true;
            }
            break;
          }
          case "motivation_done": {
            // 动机完成由外部逻辑设置，暂不自动判定
            break;
          }
        }

        if (doLeave) {
          const msg = this.handleDeparture(id, world, dep.trigger);
          if (msg) messages.push(msg);
          break; // 一次只触发一个离队
        }
      }
    }
    return messages;
  }

  /**
   * 检查队友是否在场景中
   */
  isActive(id: string): boolean {
    return this.companions.get(id)?.active ?? false;
  }

  /**
   * 获取所有活跃队友
   */
  getActiveCompanions(): CompanionState[] {
    return Array.from(this.companions.values()).filter((s) => s.active);
  }

  /**
   * 通过实体 ID 查找队友
   */
  findByEntityId(entityId: string): CompanionState | undefined {
    return Array.from(this.companions.values()).find(
      (s) => s.active && s.entityId === entityId
    );
  }

  /**
   * 设置队友行为模式
   */
  setBehavior(id: string, behavior: CompanionConfig["behavior"]): boolean {
    const state = this.companions.get(id);
    if (!state || !state.active) return false;
    state.behavior = behavior;
    return true;
  }

  /**
   * 切换控制模式
   * auto=AI 自主行动，"player:userId"=指定玩家手操
   */
  setControl(id: string, control: "auto" | `player:${string}`): boolean {
    const state = this.companions.get(id);
    if (!state || !state.active) return false;
    state.control = control;
    return true;
  }

  /**
   * 查询控制模式
   */
  getControl(id: string): "auto" | `player:${string}` | null {
    return this.companions.get(id)?.control ?? null;
  }

  /**
   * 转移控制权（玩家 A → 玩家 B）
   */
  transferControl(id: string, newUserId: string): boolean {
    const state = this.companions.get(id);
    if (!state || !state.active) return false;
    state.control = `player:${newUserId}`;
    return true;
  }

  /**
   * 查询当前由某玩家手操的所有队友
   */
  getPlayerControlled(userId: string): CompanionState[] {
    const tag = `player:${userId}`;
    return Array.from(this.companions.values()).filter(
      (s) => s.active && s.control === tag
    );
  }

  // ==========================================================
  // 轮次操作跟踪
  // ==========================================================

  /**
   * 标记某队友已在本轮行动（防双重行动）
   */
  markActed(id: string): void {
    const state = this.companions.get(id);
    if (state?.active) this.actedThisRound.add(id);
  }

  /**
   * 查询本轮是否已行动
   */
  hasActed(id: string): boolean {
    return this.actedThisRound.has(id);
  }

  /**
   * 新回合重置操作状态
   */
  newRound(): void {
    this.actedThisRound.clear();
    // ⚠ `tickResolve()` 原先**从没有被调用过** —— 恐慌/疯狂一旦进去就永远出不来。
    //   不过这不影响什么，因为写入这些状态的 `checkResolve()` 同样没人调用，
    //   整套决心系统在依赖图上是死的（三个方法各自只出现一次，都是自己的定义）。
    //   现在把递减接到回合边界上。
    this.tickResolve();
  }

  // ==========================================================
  // 快照（副本记录 / 断线重连）
  // ==========================================================

  /**
   * Export every registered CompanionState as a detached versioned JSON
   * document. World-owned entity data remains in WorldStateSnapshot.
   */
  exportSnapshot(): CompanionManagerSnapshot {
    return validateCompanionManagerSnapshot({
      kind: "companion-manager",
      schemaVersion: 1,
      companions: Array.from(this.companions.entries()).map(([id, state]) => ({
        id,
        config: state.config,
        entityId: state.entityId,
        behavior: state.behavior,
        active: state.active,
        inventory: state.inventory,
        morale: state.morale,
        invited: state.invited,
        control: state.control,
        resolveState: state.resolveState,
        resolveTurnsLeft: state.resolveTurnsLeft,
      })),
      actedThisRound: Array.from(this.actedThisRound),
      lastRefusal: this.lastRefusal,
    });
  }

  /** 对指定队友生成旧版活跃队友快照（需外部提供 HP）。 */
  private snapshotOne(configId: string, hp: number, maxHp: number): CompanionSnapshot | null {
    const state = this.companions.get(configId);
    if (!state || !state.active) return null;
    return {
      configId,
      hp, maxHp,
      inventory: [...state.inventory],
      morale: state.morale,
      behavior: state.behavior,
      control: state.control,
      entityId: state.entityId,
      resolveState: state.resolveState,
      resolveTurnsLeft: state.resolveTurnsLeft,
    };
  }

  /**
   * 对整个队伍生成快照
   */
  saveSnapshot(world: WorldStateManager): CompanionSnapshot[] {
    const snapshots: CompanionSnapshot[] = [];
    for (const [id, state] of this.companions) {
      if (!state.active) continue;
      const entity = world.getEntity(state.entityId);
      if (!entity) continue;
      const s = this.snapshotOne(id, entity.hp, entity.maxHp);
      if (s) snapshots.push(s);
    }
    return snapshots;
  }

  /**
   * 还原快照（重置全部活跃队友的状态）
   * 用于副本加载 / 重连恢复
   */
  restoreSnapshot(input: unknown, world: CompanionSnapshotWorld): void {
    if (Array.isArray(input)) {
      if (!canRestoreLegacySnapshot(world)) {
        throw new Error("Legacy companion snapshots require a mutable WorldStateManager");
      }
      this.restoreLegacySnapshot(validateLegacyCompanionSnapshots(input), world);
      return;
    }

    const snapshot = validateCompanionManagerSnapshot(input);
    validateCompanionSnapshotWorld(snapshot, world);

    const companions = new Map<string, CompanionState>();
    const agents = new Map<string, CompanionAgent>();
    for (const entry of snapshot.companions) {
      const state: CompanionState = {
        config: entry.config,
        entityId: entry.entityId,
        behavior: entry.behavior,
        active: entry.active,
        inventory: entry.inventory,
        morale: entry.morale,
        invited: entry.invited,
        control: entry.control,
        resolveState: entry.resolveState,
        resolveTurnsLeft: entry.resolveTurnsLeft,
      };
      companions.set(entry.id, state);
      if (state.active) agents.set(entry.id, new CompanionAgent(state.config, state.entityId));
    }

    // All validation and construction happened above: replace memory in one step.
    this.companions = companions;
    this.agents = agents;
    this.actedThisRound = new Set(snapshot.actedThisRound);
    this.lastRefusal = snapshot.lastRefusal;
  }

  /** Legacy active-only restore; its historical world-mutating behavior is retained for compatibility. */
  private restoreLegacySnapshot(snapshots: CompanionSnapshot[], world: LegacySnapshotWorld): void {
    // 清空现有活跃状态（保留配置注册）
    for (const [_id, state] of this.companions) {
      if (state.active) {
        world.killEntity(state.entityId);
        state.active = false;
      }
    }
    this.agents.clear();

    // 按快照重建
    for (const snap of snapshots) {
      const existing = this.companions.get(snap.configId);
      if (!existing) continue;

      // 恢复实体
      const entity: Partial<WorldEntity> & { id: string; name: string; type: WorldEntity["type"] } = {
        id: snap.entityId,
        name: existing.config.name,
        type: existing.config.type,
        hp: snap.hp,
        maxHp: snap.maxHp,
        ac: existing.config.ac,
        status: [],
        position: "melee_range",
        faction: existing.config.faction ?? "player_ally",
      };
      world.upsertEntity(entity);

      // 恢复状态
      existing.active = true;
      existing.inventory = [...snap.inventory];
      existing.morale = snap.morale;
      existing.behavior = snap.behavior;
      existing.control = snap.control;
      existing.entityId = snap.entityId;
      existing.resolveState = snap.resolveState ?? "normal";
      existing.resolveTurnsLeft = snap.resolveTurnsLeft ?? 0;

      // 重建 agent
      const agent = new CompanionAgent(existing.config, snap.entityId);
      this.agents.set(snap.configId, agent);
    }

    this.newRound();
  }

  /**
   * 获取队友的 WorldEntity
   */
  getEntity(id: string, world: WorldStateManager): WorldEntity | null {
    const state = this.companions.get(id);
    if (!state || !state.active) return null;
    return world.getEntity(state.entityId);
  }

  /**
   * 获取队友的全部状态
   */
  getAllStates(): Map<string, CompanionState> {
    return this.companions;
  }

  // ==========================================================
  // 战斗行动
  // ==========================================================

  /**
   * 执行玩家对队友的直接命令
   * @returns 是否成功执行
   */
  async command(
    id: string,
    intent: ActionIntent,
    world: WorldStateManager,
    executeAction: (entity: WorldEntity, intent: ActionIntent) => Promise<void>,
  ): Promise<boolean> {
    const state = this.companions.get(id);
    if (!state || !state.active) return false;

    const entity = world.getEntity(state.entityId);
    if (!entity || entity.hp <= 0) return false;

    // ⚠ `getCommandObeyState()` 原先也从没被调用过：恐慌的队友照样乖乖听令，
    //   「陷入疯狂，完全失控！」那句话谁也读不到。命令执行前先问一句。
    const obey = this.getCommandObeyState(id);
    if (!obey.obey) {
      this.lastRefusal = obey.reason;
      // 拒绝也算行动过 —— 否则同一轮里可以反复下令直到它答应
      this.markActed(id);
      return false;
    }
    this.lastRefusal = "";

    // 标记本轮已行动，防止后续 processTurn 重复行动
    this.markActed(id);

    await executeAction(entity, intent);
    return true;
  }

  /**
   * 上一次命令被拒的原因；没有被拒时是空串。
   *
   * `command()` 返回 boolean，说不出「为什么不行」。而恐慌与疯狂的区别
   * 恰恰全在那句话里 —— 不给出去，玩家只会看到命令莫名其妙没生效。
   */
  private lastRefusal = "";
  takeLastRefusal(): string {
    const r = this.lastRefusal;
    this.lastRefusal = "";
    return r;
  }

  /**
   * 决心检定 — 暗黑地牢式 resolve check
   * 触发条件：大伤害、低士气阈值、队友阵亡
   * 结果：坚定 / 正常 / 恐慌 / 疯狂
   */
  checkResolve(id: string, difficulty: number = 50): ResolveResult {
    const state = this.companions.get(id);
    if (!state || !state.active) {
      return { state: "normal", turnsLeft: 0, description: "" };
    }

    const traits = state.config.traits;
    const morale = state.morale;

    // 检定值：勇气 > 忠诚 > 当前士气
    const courageScore = traits?.courage ?? 5;
    const loyaltyScore = traits?.loyalty ?? 5;
    // ⚠ `difficulty` 原先**收了完全没用** —— 下面的判定全是写死的阈值，
    //   于是「队友阵亡」和「擦破点皮」掷的是同一个难度。
    //   参数存在却不起作用，比没有这个参数更坏：调用方以为自己调得动。
    //   以 50 为基准，难度每高 10 点扣 5 点决心值。
    const resolvePower = courageScore * 8 + loyaltyScore * 4 + morale * 5;

    // ⚠ 我第一版把 difficulty 写成 `resolvePower - (difficulty-50)*0.5`，
    //   **那是无效的**：判定阈值是 `resolvePower >= 60 / < 45 / < 30`，
    //   而普通队友的 resolvePower 在 120～150，离阈值远得很 ——
    //   难度调 90 点也翻不过任何一条线，结果完全由 roll 决定。
    //   参数「接上了」但依然不起作用，比不接更坏：看着像修好了。
    //   （是自己写的统计判据在变异检验里闪，才把这件事逼出来的。）
    //
    //   改成让**差额平移阈值**：决心值高于难度越多，崩溃线越靠后。
    //   夹在 ±20 是为了两头都留活口 —— 再稳的人也可能失手，再糟的人也可能挺住。
    const shift = Math.max(-20, Math.min(20, (resolvePower - difficulty) / 4));
    const steadfastAt = 15 + shift;
    const afflictedAt = 65 + shift;
    const berserkAt = 85 + shift;

    const roll = Math.random() * 100;

    if (roll <= steadfastAt) {
      // 坚定
      state.resolveState = "steadfast";
      state.resolveTurnsLeft = 3;
      return {
        state: "steadfast", turnsLeft: 3,
        description: `${state.config.name} 眼神坚定，毫无惧色！`,
      };
    } else if (roll >= berserkAt) {
      // 疯狂（小概率彻底失控）
      state.resolveState = "berserk";
      state.resolveTurnsLeft = 2;
      return {
        state: "berserk", turnsLeft: 2,
        description: `${state.config.name} 陷入疯狂，失去控制！`,
      };
    } else if (roll >= afflictedAt) {
      // 恐慌
      state.resolveState = "afflicted";
      state.resolveTurnsLeft = 3;
      return {
        state: "afflicted", turnsLeft: 3,
        description: `${state.config.name} 陷入恐慌，举止失常。`,
      };
    }

    // 正常
    state.resolveState = "normal";
    state.resolveTurnsLeft = 0;
    return {
      state: "normal", turnsLeft: 0,
      description: `${state.config.name} 保持了镇定。`,
    };
  }

  /**
   * 获取 resolve 状态对命令服从的影响
   * steadfast  → 必定服从
   * normal     → 服从
   * afflicted  → 40% 概率拒绝（非硬编码）
   * berserk    → 必定拒绝，不可控
   */
  getCommandObeyState(id: string): { obey: boolean; reason: string } {
    const state = this.companions.get(id);
    if (!state || !state.active) return { obey: false, reason: "" };

    switch (state.resolveState) {
      case "steadfast":
        return { obey: true, reason: "" };
      case "berserk":
        return { obey: false, reason: `${state.config.name} 已陷入疯狂，完全失控！` };
      case "afflicted":
        if (Math.random() < 0.4) {
          return { obey: false, reason: `${state.config.name} 陷入恐慌，无法执行命令。` };
        }
        return { obey: true, reason: "" };
      default:
        return { obey: true, reason: "" };
    }
  }

  /**
   * 每回合调用：处理 resolveTurnsLeft 递减，归零复位
   */
  tickResolve(): void {
    for (const state of this.companions.values()) {
      if (!state.active) continue;
      if (state.resolveState !== "normal" && state.resolveTurnsLeft > 0) {
        state.resolveTurnsLeft--;
        if (state.resolveTurnsLeft <= 0) {
          state.resolveState = "normal";
          state.resolveTurnsLeft = 0;
        }
      }
    }
  }

  // ==========================================================
  // 物品交互
  // ==========================================================

  /**
   * 给队友一个物品（放入背包）
   */
  giveItem(id: string, itemName: string): boolean {
    const state = this.companions.get(id);
    if (!state || !state.active) return false;
    if (!state.inventory.includes(itemName)) {
      state.inventory.push(itemName);
    }
    return true;
  }

  /**
   * 从队友背包拿走物品
   */
  takeItem(id: string, itemName: string): string | null {
    const state = this.companions.get(id);
    if (!state || !state.active) return null;
    const idx = state.inventory.indexOf(itemName);
    if (idx === -1) return null;
    state.inventory.splice(idx, 1);
    return itemName;
  }

  /**
   * 列出队友全部物品
   */
  listItems(id: string): string[] {
    const state = this.companions.get(id);
    return state?.inventory ?? [];
  }

  /**
   * 检查背包是否有某物品
   */
  hasItem(id: string, itemName: string): boolean {
    return this.listItems(id).includes(itemName);
  }

  /**
   * 从角色装备 + 背包中解析有效武器名（优先用背包中的武器）
   */
  resolveWeapon(id: string): string | undefined {
    const state = this.companions.get(id);
    if (!state || !state.active) return undefined;

    // 背包中优先级最高的武器
    const weaponPriority = ["猎枪", "霰弹枪", "步枪", "手枪", "消防斧", "猎刀", "短剑", "匕首", "长剑", "短剑", "木棍"];
    for (const w of weaponPriority) {
      if (state.inventory.some(i => i.includes(w) || w.includes(i))) return w;
    }
    return state.config.weapon;
  }

  /**
   * 战斗轮中所有队友自主行动
   * 按 behavior 模式决定目标与行动
   */
  async processTurn(
    world: WorldStateManager,
    ruleset: string,
    executeAction: (entity: WorldEntity, intent: ActionIntent) => Promise<void>,
    turnMessages: AgentMessage[],
  ): Promise<void> {
    const state = world.getCurrentState();
    const activeCompanions = this.getActiveCompanions();

    for (const companion of activeCompanions) {
      const entity = world.getEntity(companion.entityId);
      if (!entity || entity.hp <= 0 || entity.status.includes("dead")) continue;

      // 跳过由玩家手操的队友（control 以 "player:" 开头时仅响应玩家命令）
      if (companion.control !== "auto") continue;
      // 跳过本轮已行动的队友（防玩家命令 + AI 双重行动）
      if (this.hasActed(companion.config.id)) continue;

      // 检测是否有敌对实体在场景中
      const hasEnemies = Object.values(state.entities).some(
        (e) => e.hp > 0 && !e.status.includes("dead") && e.faction !== "player_ally" && e.id !== entity.id && e.id !== "player"
      );

      if (hasEnemies) {
        // 战斗决策
        const agent = this.agents.get(companion.config.id);
        if (!agent) continue;
        const intent = await agent.decide(entity, state, companion.behavior, ruleset, companion.inventory, companion.morale);
        if (!intent) continue;

        // ── 走位换距：直接更新位置，不走 combat 管线 ──
        if (intent.action === "move") {
          const oldPosition = positionLabel(entity.position ?? "melee_range");
          const newPosition = intent.target ?? (intent.method === "ranged" ? "ranged" : "melee_range");
          world.upsertEntity({
            id: companion.entityId,
            name: entity.name,
            type: entity.type,
            position: newPosition,
          });
          turnMessages.push({
            speaker: "系统",
            content: `🏃 ${companion.config.name} ${newPosition === "ranged" ? "向后拉开距离" : "向前压进"}（${oldPosition} → ${positionLabel(newPosition)}）。`,
            type: "system",
          });
          continue;
        }

        await executeAction(entity, intent);

        const targetName = intent.target
          ? world.getEntity(intent.target)?.name ?? intent.target
          : "未知";
        const pos = positionLabel(entity.position ?? "melee_range");
        turnMessages.push({
          speaker: "系统",
          content: `🤖 ${companion.config.name} [${pos}] 攻击 ${targetName}。`,
          type: "system",
        });

        // 战斗台词：判断是否击杀
        const targetEntity = intent.target ? world.getEntity(intent.target) : null;
        const isKill = targetEntity && (targetEntity.hp <= 0 || targetEntity.status.includes("dead"));
        const banter = agent.getCombatBanter(isKill ? "kill" : "attack");
        if (banter) {
          turnMessages.push({
            speaker: "系统",
            content: `🗣️ ${companion.config.name}：${banter}`,
            type: "system",
          });
        }
      }
    }
  }

  /**
   * 探索/感知阶段：非战斗时队友自主检定环境
   * 调用 detectCompanionCommandPrefix 后每 N 轮自动触发
   */
  async processExploration(
    world: WorldStateManager,
    turnMessages: AgentMessage[],
  ): Promise<void> {
    const state = world.getCurrentState();
    const activeCompanions = this.getActiveCompanions();

    for (const companion of activeCompanions) {
      const entity = world.getEntity(companion.entityId);
      if (!entity || entity.hp <= 0 || entity.status.includes("dead")) continue;

      const agent = this.agents.get(companion.config.id);
      if (!agent) continue;

      // 感知检定
      const perception = agent.perceive(entity, state, companion.behavior);
      if (!perception || perception.length === 0) continue;

      for (const p of perception) {
        turnMessages.push({
          speaker: "系统",
          content: `🔍 ${companion.config.name} 注意到：${p}`,
          type: "system",
        });
        const banter = agent.getExplorationBanter(p);
        if (banter) {
          turnMessages.push({
            speaker: "系统",
            content: `🗣️ ${companion.config.name}：${banter}`,
            type: "system",
          });
        }
      }
    }
  }

  /**
   * 选择队友的自主攻击目标（代理到 CompanionAgent 的基于性格推导）
   */
  selectTarget(
    entity: WorldEntity,
    state: WorldState,
    behavior: CompanionConfig["behavior"],
  ): WorldEntity | null {
    // 查找该实体对应的 agent
    for (const [id, agent] of this.agents) {
      const cs = this.companions.get(id);
      if (cs && cs.active && cs.entityId === entity.id) {
        return agent.selectTarget(entity, state, behavior, cs.inventory);
      }
    }
    // fallback: 没有注册 agent（测试用 stateless 调用）
    return null;
  }

  /**
   * 获取队友的战斗技能值
   */
  getCombatSkill(companion: CompanionState): number {
    return companion.config.skills.fight
      ?? companion.config.skills["格斗"]
      ?? companion.config.skills.combat
      ?? 40;
  }

  /**
   * 获取队友的伤害骰
   */
  getDamageDice(companion: CompanionState): string {
    return companion.config.damageDice || "1d6";
  }

  /**
   * 清理所有队友
   */
  clearAll(world: WorldStateManager): void {
    for (const [_id, state] of this.companions) {
      if (state.active) {
        world.killEntity(state.entityId);
      }
    }
    this.companions.clear();
    this.agents.clear();
  }
}

// ============================================================
// 位置中文标签
// ============================================================

function positionLabel(pos: string): string {
  const labels: Record<string, string> = {
    melee_range: "近战位",
    ranged: "远程位",
    far: "远处",
    hiding: "隐蔽处",
    cover: "掩体后",
  };
  return labels[pos] ?? pos;
}
