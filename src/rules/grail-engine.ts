// 圣杯系统 — 位阶压制引擎
// 五段位阶体系：青铜 → 黑铁 → 白银 → 黄金 → 传奇
// 核心机制：高位阶对低位阶的数值压制 + 士气连锁

import type { WorldEntity } from "../types";

// 原先 import 了 yaml 的 parse —— 构造函数的 ranks 全是硬编码的，从没解析过任何 yaml。

// ============================================================
// 位阶定义
// ============================================================

export type GrailRank = "bronze" | "iron" | "silver" | "gold" | "legendary";

/**
 * 位阶推断所需的最小信息。
 *
 * 写成独立接口而不是 WorldEntity，是因为攻击方未必是世界实体 —— 规则路由器
 * 传过来的可能是玩家属性表。这里只声明 inferRank 真正读的三个字段，
 * WorldEntity 天然满足它。
 */
export interface RankSource {
  name: string;
  status?: string[];
  attributes?: Record<string, unknown>;
}

function isGrailRank(rank: unknown): rank is GrailRank {
  return rank === "bronze" || rank === "iron" || rank === "silver" || rank === "gold" || rank === "legendary";
}

/**
 * 从实体名 / status / attributes.rank 推断位阶。
 *
 * 独立成函数而不是只留类方法：npc-combat 也要推断位阶，此前它自己抄了一份，
 * 用 `(entity as any).attributes` 取值且写成 `if (attrs?.rank) return attrs.rank`
 * —— 没有类型判断，attributes 里放一个数值 rank 就会被原样返回，而调用方拿它
 * 去索引位阶配置表。WorldEntity.attributes 声明的正是 Record<string, number>，
 * 所以那条路可达。这里的 isGrailRank 闭合判断是唯一正确的写法，不该有第二份。
 *
 * 入参只写它真正读的三个字段，不写 WorldEntity：圣杯规则下攻击方从规则路由器
 * 传进来的是玩家属性表（name/id/proficiency/abilities），根本没有 status，
 * 按 WorldEntity 声明再 as any 硬转，展开 status 时会抛
 * "Spread syntax requires ...iterable"，每次攻击都崩。
 */
export function inferGrailRank(entity: RankSource): GrailRank {
  const rank = entity.attributes?.rank;
  if (isGrailRank(rank)) return rank;

  const text = [entity.name, ...(entity.status ?? [])].join(" ");
  if (/传奇/.test(text)) return "legendary";
  if (/黄金/.test(text)) return "gold";
  if (/白银/.test(text)) return "silver";
  if (/黑铁/.test(text)) return "iron";
  return "bronze";
}

interface RankConfig {
  label: string;
  tier: number;
  base_attack: number;
  base_defense: number;
  hp_multiplier: number;
  abilities: string[];
  morale: string;
  aura?: string;
  damage_reduction?: number;
  legendary_actions?: number;
}

// ============================================================
// 位阶压制结果
// ============================================================

interface TierSuppressionResult {
  applicable: boolean;
  attackerRank: GrailRank;
  defenderRank: GrailRank;
  tierDifference: number;
  attackBonus: number;
  damageBonus: number;
  defenderMoralePenalty: number;
  autoHit: boolean;
  moraleBreak: boolean;
  fearCheck: boolean;
  description: string;
}

// ============================================================
// 圣杯战斗引擎
// ============================================================

export class GrailEngine {
  private ranks: Map<GrailRank, RankConfig> = new Map();
  // 原先这里有个 `moraleBonus: number = 0` —— 从头到尾没被读也没被写过。
  // 士气在 RankConfig 里是 `morale: "low" | …` 的等级，不是数值加成，
  // 这个字段大概是早期设想的残留。

  // ⚠ `yamlPath` 收了但没用：下面的 ranks 全是构造函数里硬编码的。
  //   参数留着会让调用方以为传个 yaml 就能换规则表 —— 传了也没用。
  //   改名 `_yamlPath` 记着这件事，但不删签名：删了是破坏性改动，
  //   而「能不能从 yaml 读」是另一个决定。
  constructor(_yamlPath?: string) {
    this.ranks.set("bronze", {
      label: "青铜", tier: 1, base_attack: 2, base_defense: 10,
      hp_multiplier: 1, abilities: ["基础攻击"], morale: "low",
    });
    this.ranks.set("iron", {
      label: "黑铁", tier: 2, base_attack: 4, base_defense: 12,
      hp_multiplier: 1.5, abilities: ["战技(1)", "格挡"], morale: "medium",
    });
    this.ranks.set("silver", {
      label: "白银", tier: 3, base_attack: 7, base_defense: 15,
      hp_multiplier: 3, abilities: ["战技(2)", "圣光斩", "神圣护盾"], morale: "high",
      aura: "白银光环—半径10尺友方AC+1",
    });
    this.ranks.set("gold", {
      label: "黄金", tier: 4, base_attack: 12, base_defense: 18,
      hp_multiplier: 6, abilities: ["战技(3)", "圣光审判", "群体祝福", "神圣领域"],
      morale: "very_high", aura: "黄金光环—半径20尺友方AC+2,ATK+2", damage_reduction: 3,
    });
    this.ranks.set("legendary", {
      label: "传奇", tier: 5, base_attack: 20, base_defense: 22,
      hp_multiplier: 12, abilities: ["战技(全部)", "圣光化身", "奇迹", "领域展开"],
      morale: "unbreakable", aura: "传奇光环—半径30尺友方AC+3,ATK+3,HP+1/轮",
      damage_reduction: 8, legendary_actions: 3,
    });
  }

  /** 从实体名/status 推断位阶。实现见模块级的 inferGrailRank。 */
  inferRank(entity: RankSource): GrailRank {
    return inferGrailRank(entity);
  }

  /** 获取位阶配置 */
  getRank(rank: GrailRank): RankConfig | undefined {
    return this.ranks.get(rank);
  }

  /**
   * 计算位阶压制效果
   * @returns 压制结果，null 表示同阶无压制
   */
  calcSuppression(attacker: GrailRank, defender: GrailRank): TierSuppressionResult | null {
    const atkRank = this.ranks.get(attacker);
    const defRank = this.ranks.get(defender);
    if (!atkRank || !defRank) return null;

    const diff = atkRank.tier - defRank.tier;
    if (diff <= 0) return null; // 同阶或低阶无压制

    const result: TierSuppressionResult = {
      applicable: true,
      attackerRank: attacker,
      defenderRank: defender,
      tierDifference: diff,
      attackBonus: 0,
      damageBonus: 0,
      defenderMoralePenalty: 0,
      autoHit: false,
      moraleBreak: false,
      fearCheck: false,
      description: "",
    };

    if (diff >= 1) {
      result.attackBonus = diff === 1 ? 2 : diff === 2 ? 5 : 99;
      result.damageBonus = diff === 1 ? 2 : diff === 2 ? 5 : 99;
      result.defenderMoralePenalty = diff * 2;
    }

    if (diff >= 2) {
      result.fearCheck = true; // 低阶方需过士气检定
    }

    if (diff >= 3) {
      result.autoHit = true;
      result.moraleBreak = true; // 低阶方直接溃散
      result.description = `${atkRank.label}阶对${defRank.label}阶形成碾压——自动命中，低阶方溃散`;
    } else if (diff === 2) {
      result.description = `${atkRank.label}阶压制${defRank.label}阶——ATK+5/DMG+5，低阶方需过恐惧检定`;
    } else {
      result.description = `${atkRank.label}阶压制${defRank.label}阶——ATK+2/DMG+2`;
    }

    return result;
  }

  /**
   * 位阶压制的攻击检定
   * @returns { hit: boolean, damage: number, suppression: result }
   */
  adjudicateAttack(
    attackerEntity: RankSource,
    defenderEntity: WorldEntity,
    weaponDamage: string = "1d8"
  ): { hit: boolean; damage: number; suppression: TierSuppressionResult | null; critical: boolean } {
    const atkRank = this.inferRank(attackerEntity);
    const defRank = this.inferRank(defenderEntity);
    const suppression = this.calcSuppression(atkRank, defRank);

    const atkCfg = this.ranks.get(atkRank)!;
    const defCfg = this.ranks.get(defRank)!;

    let attackRoll = Math.floor(Math.random() * 20) + 1;
    const isCritical = attackRoll === 20;

    if (suppression?.autoHit) {
      attackRoll = 20; // 自动命中 → 等效于爆击
    }

    const totalAttack = attackRoll + atkCfg.base_attack + (suppression?.attackBonus ?? 0);
    const defense = defCfg.base_defense;
    const hit = totalAttack >= defense || attackRoll === 20;

    // 伤害计算
    const diceMatch = weaponDamage.match(/(\d+)d(\d+)/);
    let damage = 0;
    if (diceMatch) {
      const [, count, sides] = diceMatch;
      for (let i = 0; i < parseInt(count); i++) {
        damage += Math.floor(Math.random() * parseInt(sides)) + 1;
      }
    }

    damage += (suppression?.damageBonus ?? 0);
    if (isCritical) damage *= 2;

    // 伤害减免
    if (defCfg.damage_reduction) {
      damage = Math.max(1, damage - defCfg.damage_reduction);
    }

    return { hit, damage, suppression, critical: isCritical };
  }

  /** 士气检定：d20 + modifier ≥ DC */
  moraleCheck(rank: GrailRank, dc: number, leaderPresent: boolean = false): { passed: boolean; result: string } {
    const cfg = this.ranks.get(rank);
    if (!cfg) return { passed: false, result: "未知位阶" };

    const moraleMap: Record<string, number> = {
      low: -2, medium: 0, high: 2, very_high: 4, unbreakable: 99, mindless: 99,
    };

    if (moraleMap[cfg.morale] === 99) {
      return { passed: true, result: "不溃——不受士气影响" };
    }

    const bonus = moraleMap[cfg.morale] + (leaderPresent ? 3 : 0);
    const roll = Math.floor(Math.random() * 20) + 1;
    const total = roll + bonus;
    const passed = total >= dc;

    let result: string;
    if (passed) {
      result = "坚守阵地";
    } else if (total >= dc - 5) {
      result = "动摇——攻击-2，可能撤退";
    } else if (total >= dc - 10) {
      result = "溃散——逃跑，借机攻击正常";
    } else {
      result = "崩溃——无法行动";
    }

    return { passed, result };
  }
}
