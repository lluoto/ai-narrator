// POC 核心类型定义

import type { SanityState } from "./rules/coc-engine";

export interface ActionIntent {
  action: string;         // "attack" | "move" | "cast" | "skill_check" | "san_check" | "saving_throw" | "flee" | "unknown"
  target?: string;        // 目标实体 ID
  weapon?: string;        // 武器名
  method?: string;        // "stealth" | "flank" | "charge" | "ranged" | "melee"
  skill?: string;         // 技能名（非战斗行动）
  ability?: string;       // 豁免属性名
  dc?: number;            // 目标 DC
  sanCost?: string;       // CoC SAN 损失格式 "1/1d6"
  reason?: string;        // SAN 检定原因 / 豁免原因
  spell?: string;         // D&D 法术名
  /** CoC: 燃运点数（减少 d100 投骰） */
  luckSpend?: number;
  /** CoC: 当前使用的武器名（用于弹药消耗） */
  weaponName?: string;
  /** CoC: 瞄准攻击的目标部位（如 "头部"、"腿部"、"武器"） */
  calledShot?: string;
  /** 装备/卸下目标物品名 */
  item?: string;
  /** CoC: 格挡/反击标志 */
  fightBack?: boolean;
  /** 模组完成结算：结局 ID */
  endingId?: string;
  /** 模组完成结算：结局显示名 */
  endingName?: string;
  /** 模组完成结算：结局描述 */
  endingDescription?: string;
  /** 模组完成结算：额外 SAN 损失 */
  extraSan?: number;
  /** 模组完成结算：额外 CM 增长 */
  extraCm?: number;
  /** 模组完成结算：额外信誉变化 */
  extraCr?: number;
  /** 模组完成结算：获得的奖励规则 ID 列表 */
  rewardIds?: string[];
}

/** CoC 武器定义 */
export interface CoCWeaponDef {
  ammoType: string | null;
  capacity: number | null;
  baseSkill: number;
}

export interface CombatResult {
  hit: boolean;
  crit: boolean;
  roll: number;
  bonuses: BonusEntry[];
  total: number;
  damage: number;
  damage_type: string;
  result: 'kill' | 'wound' | 'miss';
  intensity: number;       // 0.0-1.0 → 动画演出强度
  camera_hint: string;
  sfx_hint: string;
}

export interface BonusEntry {
  source: string;          // "熟练+2" | "敏捷+3" | "优势取高" | "惩罚骰"
  value: number | string;
}

export interface WorldEntity {
  id: string;
  name: string;
  type: 'pc' | 'npc' | 'monster' | 'item';
  hp: number;
  maxHp: number;
  ac: number;
  status: string[];        // ["sneaking", "poisoned", "concentrating"]
  /**
   * 注意：这个字段承载了两种语义，尚未统一。
   * 模组导入与故事生成器往里写场景 ID（mythos-module 的 `position: sceneId`），
   * 而同伴系统往里写战斗距离（companion-manager 的 `position: "melee_range"`，
   * companion-agent 也按 "ranged" / "far" 读它）。因此它既不能当场景归属的
   * 唯一依据，也不能当纯粹的距离。判断场景归属请用 scene_id。
   */
  position: string;
  faction?: string;        // "野兽", "怪物", "友善" 等——仅 npc/monster
  /**
   * 实体所属场景。getEntitiesInScene() 按它过滤。
   *
   * entities 表一直有这一列，mythos-module 的宿主契约也早就声明了它，
   * 只是 WorldEntity 没声明，于是存储层只能 `(entity as any).scene_id` 去摸，
   * rowToEntity 也不回读——结果任何一次更新都把它抹成 NULL。
   */
  scene_id?: string;
  /** 数值属性（力量/意志等）。模组 NPC 会带，rowToEntity 需回读，否则更新即丢。 */
  attributes?: Record<string, number>;
}

/**
 * 真相源中持久化的玩家运行时状态。
 *
 * SanityState 用 `import type` 引入，编译期即被擦除，不构成运行时循环依赖
 * （coc-engine 反向引用本文件的 WorldEntity 也是同样的形式）。
 * 这里直接复用 SanityState 而不另立一份窄快照，是为了让会话重新读取时
 * 能完整还原 SAN 引擎，而不是丢掉 mythosLog / therapyProgress 这类字段。
 */
export interface PlayerRuntimeState {
  sanity: SanityState | null;
  inventory: string[];
  weapons: string[];
  armor: string[];
}

export interface WorldState {
  entities: Record<string, WorldEntity>;
  active_effects: Effect[];
  scene: string;
  time: string;            // "combat_round_3" | "exploration" | "social"
  /** 各玩家的 SAN / 背包 / 武器 / 护甲。缺了它，快照就只是部分快照。 */
  players: Record<string, PlayerRuntimeState>;
}

export interface Effect {
  id: string;
  source: string;
  target: string;
  type: 'advantage' | 'disadvantage' | 'condition' | 'buff' | 'debuff';
  description: string;
  duration: number;        // 剩余回合
}

export interface SaveResult {
  ability: string;           // "strength" | "dexterity" | "constitution" | "intelligence" | "wisdom" | "charisma"
  abilityLabel: string;      // 中文名
  roll: number;
  mod: number;               // 属性调整值
  proficient: boolean;
  proficiencyBonus: number;
  total: number;             // roll + mod + (prof ? profBonus : 0)
  dc: number;
  success: boolean;
  critical: boolean;         // 自然 20
  fumble: boolean;           // 自然 1
}

/** 战斗导向的性格特质（1-10，5=普通人基准） */
export interface CombatPersonalityTraits {
  /** 勇气（高=悍不畏死，低=怯懦爱逃） */
  courage: number;
  /** 攻击性（高=优先攻击，低=被动防御） */
  aggression: number;
  /** 谨慎（高=考虑自保/闪避，低=莽撞冲锋） */
  caution: number;
  /** 忠诚（高=舍身保护队友，低=优先自保） */
  loyalty: number;
  /** 残忍（高=倾向全力攻击/追击，低=适可而止） */
  cruelty: number;
}

/** 邀请入队条件（CoC 叙事友好） */
interface CompanionRecruit {
  /** 招募剧情文本（在成功时展示） */
  greeting: string;
  /** 招募所需技能，如 "persuade" / "credit_rating" */
  skill?: string;
  /** 技能 DC（0-99），默认 50 */
  dc?: number;
  /** 检定失败时的替代文本 */
  failGreeting?: string;
}

/** 离队触发条件 */
interface CompanionDeparture {
  /** 触发条件类型 */
  trigger: "hp_zero" | "morale_cower" | "motivation_done";
  /** 条件描述（叙事用途） */
  description: string;
  /** 离队台词 */
  farewell: string;
  /** 是否可重新邀请（默认 true） */
  canRejoin?: boolean;
}

/** AI 队友配置 */
export interface CompanionConfig {
  /** 唯一标识（用于命令） */
  id: string;
  /** 显示名 */
  name: string;
  type: WorldEntity["type"];  // 通常是 "npc"
  hp: number;
  maxHp: number;
  ac: number;
  /** 技能值，如 { fight: 60, dodge: 40, heal: 50 } */
  skills: Record<string, number>;
  /** 伤害骰，如 "1d6+1d4" */
  damageDice: string;
  /** 武器名（用于 combat 引擎） */
  weapon?: string;
  /** 战斗行为模式 */
  behavior: "aggressive" | "defensive" | "support";
  /** 阵营标记（如 "player_ally"） */
  faction?: string;
  /** 性格特质（影响战斗决策推导） */
  traits?: CombatPersonalityTraits;
  /** 初始物品（武器名/道具名，与 COC_WEAPONS_FULL 或道具表匹配） */
  inventory?: string[];
  /** 招募条件（叙事文本 + 可选检定） */
  recruit?: CompanionRecruit;
  /** 离队条件 */
  departure?: CompanionDeparture[];
  /** 入队动机（叙事用途） */
  motivation?: string;
}

/** 队友运行状态 */
export interface CompanionState {
  config: CompanionConfig;
  entityId: string;         // WorldEntity id
  /** 当前行为模式 */
  behavior: CompanionConfig["behavior"];
  /** 是否在场景中 */
  active: boolean;
  /** 运行时背包（初始来自 config.inventory，可通过交互增减） */
  inventory: string[];
  /** 士气（0-10，起始 10，受创/恐惧会下降，归零触发离队） */
  morale: number;
  /** 是否已被邀请过（防止重复招募文本） */
  invited: boolean;
  /** 控制权：auto=AI自主，"player:userId"=指定玩家手操 */
  control: "auto" | `player:${string}`;
  /** 决心状态（暗黑地牢式 resolve check 结果） */
  resolveState: "normal" | "steadfast" | "afflicted" | "berserk";
  /** 当前 resolve 状态剩余回合数，0 表示 normal */
  resolveTurnsLeft: number;
}

/** 决心检定结果 */
export interface ResolveResult {
  state: "steadfast" | "normal" | "afflicted" | "berserk";
  turnsLeft: number;
  description: string;  // 简短描述，非硬编码对话
}

/** 队友快照（用于副本记录/断线重连） */
export interface CompanionSnapshot {
  configId: string;
  hp: number;
  maxHp: number;
  inventory: string[];
  morale: number;
  behavior: "aggressive" | "defensive" | "support";
  control: "auto" | `player:${string}`;
  entityId: string;
  resolveState: "normal" | "steadfast" | "afflicted" | "berserk";
  resolveTurnsLeft: number;
}
