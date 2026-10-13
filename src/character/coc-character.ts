// CoC 7e 调查员角色创建系统
// 属性生成 / 职业约束 / 技能分配 / 衍生数据
// ============================================================

import { calcDamageBonus, CoCEngine, type CoCCheckResult } from "../rules/coc-engine";
import type { CharacterArchetype } from "./character-factory";
import { ALL_ARCHETYPES } from "./character-factory";
import { buildBaseBackgroundProfile } from "./background-profile";
import { drawRandomUnit, type RandomUnit } from "./random-unit";

// ============================================================
// 类型定义
// ============================================================

/** CoC 7e 核心属性名 */
type CoCAttribute =
  | "strength" | "constitution" | "size" | "dexterity"
  | "appearance" | "intelligence" | "power" | "education";

/** 8 项核心属性。幸运不在其中——它是独立字段，见 CoCGeneratedCharacter.luck。 */
export const COC_ATTRIBUTES: CoCAttribute[] = [
  "strength", "constitution", "size", "dexterity",
  "appearance", "intelligence", "power", "education",
];

/** 完整 CoC 7e 技能表（中文名，用于角色卡显示/分配） */
export const COC_SKILLS: string[] = [
  "会计", "人类学", "估价", "考古学", "炮术", "艺术与手艺",
  "魅惑", "化学", "计算机使用", "信用评级", "克苏鲁神话",
  "乔装", "闪避", "驾驶", "电气维修", "电子学",
  "话术", "格斗(肉搏)", "格斗(剑)", "法庭学",
  "射击(步枪/霰弹枪)", "射击(冲锋枪)", "射击(手枪)", "射击(机关枪)",
  "急救", "历史", "恐吓", "跳跃", "语言(其他)", "法律",
  "图书馆使用", "聆听", "锁匠", "机械维修", "医学",
  "自然学", "导航", "神秘学", "操作重型机械",
  "说服", "精神分析", "心理学", "骑术",
  "科学(化学)", "科学(生物学)", "科学(物理学)", "科学(天文学)", "科学(地质学)",
  "妙手", "侦查", "潜行", "生存", "游泳",   "投掷",
  "追踪",
  "攀爬",
];

/** 中文技能名 → 英文内部 key 映射（用于技能检定系统） */
export const SKILL_NAME_MAP: Record<string, string> = {
  "会计": "accounting",
  "人类学": "anthropology",
  "估价": "appraise",
  "考古学": "archaeology",
  "炮术": "artillery",
  "艺术与手艺": "art",
  "魅惑": "charm",
  "取悦": "charm",
  "化学": "chemistry",
  "计算机使用": "computer_use",
  "信用评级": "credit_rating",
  "信誉": "credit_rating",
  "克苏鲁神话": "cthulhu_mythos",
  "乔装": "disguise",
  "闪避": "dodge",
  "驾驶": "drive",
  "电气维修": "electrical_repair",
  "电子学": "electronics",
  "话术": "fast_talk",
  "社交": "fast_talk",
  "格斗(肉搏)": "fighting",
  "格斗(剑)": "fighting",
  "法庭学": "forensic",
  "射击(步枪/霰弹枪)": "firearms_rifle",
  "射击(冲锋枪)": "firearms_smg",
  "射击(手枪)": "firearms_pistol",
  "射击(机关枪)": "firearms_mg",
  "急救": "first_aid",
  "历史": "history",
  "恐吓": "intimidate",
  "跳跃": "jump",
  "语言(其他)": "language_other",
  "母语": "language_own",
  "法律": "law",
  "图书馆使用": "library_use",
  "图书馆": "library_use",
  "聆听": "listen",
  "锁匠": "lockpick",
  "机械维修": "mechanical_repair",
  "医学": "medicine",
  "自然学": "natural_history",
  "导航": "navigate",
  "神秘学": "occult",
  "操作重型机械": "operate_heavy_machinery",
  "说服": "persuade",
  "精神分析": "psychoanalysis",
  "心理学": "psychology",
  "骑术": "ride",
  "科学(化学)": "science_chemistry",
  "科学(生物学)": "science_biology",
  "科学(物理学)": "science_physics",
  "科学(天文学)": "science_astronomy",
  "科学(地质学)": "science_geology",
  "妙手": "sleight_of_hand",
  "侦查": "spot_hidden",
  "潜行": "stealth",
  "生存": "survival",
  "游泳": "swim",
  "投掷": "throw",
  "追踪": "track",
  "攀爬": "climb",
};

/** 英文内部 key → 中文技能名（反向映射，多个中文→同英文时保留第一个） */
export const REVERSE_SKILL_MAP: Record<string, string> = {};
for (const [cn, en] of Object.entries(SKILL_NAME_MAP)) {
  if (!(en in REVERSE_SKILL_MAP)) {
    REVERSE_SKILL_MAP[en] = cn;
  }
}

/**
 * 属性名映射：中文/缩写属性名 → 角色 attributes/luck 字段 key
 * CoC 7e 属性（STR/CON/SIZ/DEX/APP/INT/POW/EDU/LUCK）不是技能，
 * 检定需从 attributes 或 luck 字段取值，而不是 skillValues。
 */
const ATTRIBUTE_NAME_MAP: Record<string, string> = {
  "力量": "strength", "STR": "strength", "strength": "strength",
  "体质": "constitution", "CON": "constitution", "constitution": "constitution",
  "体型": "size", "SIZ": "size", "size": "size",
  "敏捷": "dexterity", "DEX": "dexterity", "dexterity": "dexterity",
  "外貌": "appearance", "APP": "appearance", "appearance": "appearance",
  "智力": "intelligence", "INT": "intelligence", "intelligence": "intelligence",
  // 灵感（Idea roll）在 CoC 7e 里就是智力值本身（智力已经是 3d6×5 生成的
  // 百分比，不需要再乘 5）——开发·线索闸门 任务4 补的别名，顺带修好一个
  // 已存在的死分支：src/play/traps.ts:78 的 alternativeSkill:"灵感" 此前
  // 一直把 resolveCheckValue(pc,"灵感") 解析成 0（既不在这份表也不在
  // SKILL_NAME_MAP 里，落进 skillValues["灵感"] 这个从不存在的键），
  // 陷阱预警的"军事背景走灵感"这条替代路径实际从未生效过。
  "灵感": "intelligence",
  "意志": "power", "POW": "power", "power": "power",
  "教育": "education", "EDU": "education", "education": "education",
  "幸运": "luck", "LUCK": "luck", "luck": "luck",
};

/**
 * 解析检定目标值：属性（幸运/力量等）从 attributes/luck 取，技能从 skillValues 取。
 * 支持中文名、英文 key 与属性缩写，未知名称返回 0。
 */
export function resolveCheckValue(
  pc: Pick<CoCGeneratedCharacter, "attributes" | "luck" | "skillValues">,
  name: string,
): number {
  const attrKey = ATTRIBUTE_NAME_MAP[name];
  if (attrKey) {
    return attrKey === "luck" ? (pc.luck ?? 0) : (pc.attributes[attrKey] ?? 0);
  }
  const engKey = SKILL_NAME_MAP[name] ?? name;
  return (pc.skillValues as Record<string, number>)[engKey] ?? 0;
}

/**
 * 判断角色技能列表中是否包含指定英文 key 对应的技能
 * （同时检查中文名和英文名，兼容过渡期）
 */
export function hasSkillByKey(charSkills: string[], englishKey: string): boolean {
  if (charSkills.includes(englishKey)) return true;
  const cnName = REVERSE_SKILL_MAP[englishKey];
  if (cnName && charSkills.includes(cnName)) return true;
  return false;
}

/** 创建选项 */
interface CoCCharacterConfig {
  /** 角色名 */
  name: string;
  /** 职业模板 ID */
  archetypeId: string;
  /** 属性生成方式 */
  method: "dice" | "point_buy";
  /** 点购总额（method=point_buy 时使用） */
  pointBudget?: number;
  /** 手动指定属性值（跳过生成） */
  attributes?: Partial<Record<CoCAttribute | "luck", number>>;
  /** 年龄（影响衍生数据） */
  age?: number;
  /** 是否包含运气属性 */
  includeLuck?: boolean;
}

/**
 * CoC 7e 车卡"背景故事"八项元素
 * （调查员手册标准背景部分：个人描述/思想与信念/重要之人/意义非凡之地/
 *   宝贵之物/特质/伤口与疤痕/恐惧症与躁狂症）
 * 车卡流程要求先填齐八项，再据此撰写背景故事
 */
export interface BackgroundProfile {
  /** 形象描述（外貌/穿着/气质） */
  appearance: string;
  /** 思想与信念 */
  beliefs: string;
  /** 重要之人 */
  significantPeople: string;
  /** 意义非凡之地 */
  meaningfulPlace: string;
  /** 宝贵之物 */
  treasuredPossession: string;
  /** 特质（性格特点） */
  traits: string;
  /** 伤口和疤痕（肉体与心灵创伤） */
  woundsAndScars: string;
  /** 恐惧症和躁狂症 */
  phobiasAndManias: string;
}

/** CoC 7e 角色创建结果 */
export interface CoCGeneratedCharacter {
  name: string;
  archetypeId: string;
  attributes: Record<string, number>;
  luck: number;
  hp: number;
  maxHp: number;
  ac: number;
  damageBonus: string;
  build: number;
  move: number;
  creditRating: number;
  startingItems: string[];
  /** 职业技能点数 */
  occupationSkillPoints: number;
  /** 个人兴趣技能点数 */
  interestSkillPoints: number;
  /** 职业技能列表（中文名，用于显示） */
  occupationSkills: string[];
  /** 职业技能列表（英文 ID，用于系统计算） */
  occupationSkillKeys?: string[];
  /** 可选其他技能（个人兴趣用） */
  availableSkills: string[];
  /** 年龄 */
  age: number;
  /** 是否有效（满足所有职业约束） */
  valid: boolean;
  warnings: string[];
  /** 克苏鲁神话技能值（0-99），初始为 0 */
  cthulhuMythos: number;
  /**
   * 所有技能的最终值（英文 key → 百分比）
   * 由分配器自动生成，包含基础值 + 职业技能点 + 兴趣技能点
   */
  skillValues: Record<string, number>;
  /** 背景故事八项元素（车卡必填项，由模板池生成，可被 LLM 增强） */
  backgroundProfile?: BackgroundProfile;
  /** 背景故事全文（由八项内容撰写，可被 LLM 增强） */
  backstory?: string;
}

// ============================================================
// CoC 7e 属性生成
// ============================================================

/** 生成 3d6×5 结果 */
function roll3d6x5(randomUnit: RandomUnit = Math.random): number {
  const d6 = () => Math.floor(drawRandomUnit(randomUnit) * 6) + 1;
  return (d6() + d6() + d6()) * 5;
}

/** 生成 2d6+6×5 结果 */
function roll2d6p6x5(randomUnit: RandomUnit = Math.random): number {
  const d6 = () => Math.floor(drawRandomUnit(randomUnit) * 6) + 1;
  return (d6() + d6() + 6) * 5;
}

/** 随机投骰生成 8 项核心属性 */
function rollAttributes(randomUnit: RandomUnit = Math.random): Record<CoCAttribute, number> {
  return {
    strength: roll3d6x5(randomUnit),
    constitution: roll3d6x5(randomUnit),
    size: roll2d6p6x5(randomUnit),
    dexterity: roll3d6x5(randomUnit),
    appearance: roll3d6x5(randomUnit),
    intelligence: roll2d6p6x5(randomUnit),
    power: roll3d6x5(randomUnit),
    education: roll2d6p6x5(randomUnit),
  };
}

/** 点购系统：460 点分配到 8 项属性，每项 40-90 */
function pointBuyAttributes(
  budget: number = 460,
  minValue: number = 40,
  maxValue: number = 90,
  priorityAttrs?: string[], // archetype-recommended priority attributes
  minAttrs?: Record<string, number>, // archetype-required minimum attributes
  randomUnit: RandomUnit = Math.random,
): Record<CoCAttribute, number> {
  const attrs: Record<CoCAttribute, number> = {
    strength: minValue, constitution: minValue, size: minValue,
    dexterity: minValue, appearance: minValue, intelligence: minValue,
    power: minValue, education: minValue,
  };
  let remaining = budget - minValue * 8;

  // Enforce archetype minimums BEFORE random distribution
  if (minAttrs) {
    for (const [attr, minVal] of Object.entries(minAttrs)) {
      const key = attr as CoCAttribute;
      if (key in attrs) {
        const deficit = minVal - attrs[key];
        if (deficit > 0) {
          attrs[key] = minVal;
          remaining -= deficit;
        }
      }
    }
  }

  // Weighted random distribution: priority attributes get 2× weight
  const order: CoCAttribute[] = [...COC_ATTRIBUTES].sort(() => drawRandomUnit(randomUnit) - 0.5);
  while (remaining > 0) {
    for (const attr of order) {
      if (remaining <= 0) break;
      const space = maxValue - attrs[attr];
      if (space <= 0) continue;
      // Priority attributes get larger allocation chunks
      const maxChunk = priorityAttrs?.includes(attr) ? 15 : 10;
      const add = Math.min(
        Math.floor(drawRandomUnit(randomUnit) * Math.min(space, maxChunk)) + 1,
        space,
        remaining
      );
      attrs[attr] += add;
      remaining -= add;
    }
  }
  return attrs;
}

// ============================================================
// 常量消息定义（集中管理中文输出，便于统一修改）
// ============================================================

const WARN_MSG = {
  belowMinAttr: (label: string, current: number, min: number) =>
    `${label} ${current} < 职业下限 ${min}`,
  aboveMaxAttr: (label: string, current: number, max: number) =>
    `${label} ${current} > 上限 ${max}`,
  creditOutOfRange: (cr: number, min: number, max: number) =>
    `信用评级 ${cr} 超出职业范围 [${min}, ${max}]`,
  totalOverBudget: (total: number, budget: number) =>
    `属性总值 ${total} 超过标准预算 ${budget}`,
  ageOutOfRange: (age: number) =>
    `年龄 ${age} 不在标准范围 15-150 内，不调整`,
  ageModApplied: (label: string, delta: number, cur: number, newVal: number) =>
    `年龄调整: ${label} ${delta >= 0 ? "+" : ""}${delta} (${cur} → ${newVal})`,
  itemsLoadFailed: "初始物品加载失败",
};

// ============================================================
// 职业约束校验
// ============================================================

/** 属性名 → 中文名映射 */
const COC_ATTR_LABELS: Record<string, string> = {
  strength: "力量(STR)", constitution: "体质(CON)", size: "体型(SIZ)",
  dexterity: "敏捷(DEX)", appearance: "外貌(APP)", intelligence: "智力(INT)",
  power: "意志(POW)", education: "教育(EDU)", luck: "幸运(LUCK)",
};

/** 校验属性是否满足职业约束，返回警告列表 */
export function validateOccupationConstraints(
  attrs: Record<string, number>,
  archetype: CharacterArchetype,
  pointBudget?: number,
): string[] {
  const warnings: string[] = [];

  // 1. 检查最低属性要求
  for (const [attr, minVal] of Object.entries(archetype.minAttributes ?? {})) {
    const current = attrs[attr] ?? 0;
    if (current < minVal) {
      warnings.push(WARN_MSG.belowMinAttr(COC_ATTR_LABELS[attr] ?? attr, current, minVal));
    }
  }

  // 2. 检查最高属性上限
  // EDU 硬上限 99（90 是创建期点购软上限——年龄调整可合法超过，见 CoC 7e 规则）
  const globalMax: Record<string, number> = {
    strength: 90, constitution: 90, size: 90, dexterity: 90,
    appearance: 90, intelligence: 90, power: 90, education: 99,
    luck: 99,
  };
  // 这里原本还并入 archetype.attributeMaxConstraints，但该字段在整个仓库里
  // 只出现于这一处读取：没有任何职业数据提供它，CharacterArchetype 也没有声明它，
  // 取值恒为 undefined，`?? {}` 后对上限没有任何影响。按职业定制上限属于未接线的功能。
  for (const [attr, maxVal] of Object.entries(globalMax)) {
    const current = attrs[attr];
    if (current !== undefined && current > maxVal) {
      warnings.push(WARN_MSG.aboveMaxAttr(COC_ATTR_LABELS[attr] ?? attr, current, maxVal));
    }
  }

  // 3. 检查信用评级（仅在属性中明确指定时校验）
  if ("credit_rating" in attrs) {
    const cr = attrs["credit_rating"] ?? 0;
    const crRange = archetype.creditRatingRange;
    if (crRange) {
      const [crMin, crMax] = crRange;
      if (cr < crMin || cr > crMax) {
        warnings.push(WARN_MSG.creditOutOfRange(cr, crMin, crMax));
      }
    }
  }

  // 4. 检查总点购预算——仅用于手动/骰点属性（点购已在生成时校验过）
  // 点购后可能因年龄调整导致属性值超过预算，这是正常规则行为（年龄调整是独立修正）
  if (pointBudget !== undefined) {
    const totalPoints = COC_ATTRIBUTES.reduce((sum, a) => sum + (attrs[a] ?? 0), 0);
    const ageAdjustedBudget = pointBudget + 10; // 允许年龄调整带来的小幅上浮
    if (totalPoints > ageAdjustedBudget) {
      warnings.push(WARN_MSG.totalOverBudget(totalPoints, pointBudget));
    }
  }

  return warnings;
}

// ============================================================
// 衍生数据计算
// ============================================================

/** 计算 CoC 7e HP = (CON + SIZ) / 10（向下取整，至少 1） */
export function calcCoCHP(constitution: number, size: number): number {
  return Math.max(1, Math.floor((constitution + size) / 10));
}

/** 计算 AC（基于 DEX）：10 + floor(DEX / 20) */
export function calcCoCAC(dexterity: number): number {
  return 10 + Math.floor(dexterity / 20);
}

/** 计算移动力（CoC 7e 标准规则：STR 和 DEX 均 < SIZ → 7，均 > SIZ → 9，否则 8） */
export function calcCoCMove(strength: number, dexterity: number, size: number, age: number = 30): number {
  let move = 8;
  if (strength < size && dexterity < size) move = 7;
  else if (strength > size && dexterity > size) move = 9;
  // 年龄调整（逐级递减）
  if (age >= 40) move -= 1;
  if (age >= 50) move -= 1;
  if (age >= 60) move -= 1;
  if (age >= 70) move -= 1;
  if (age >= 80) move -= 1;
  return Math.max(1, move);
}

/** 投骰 3d6×5 生成幸运 */
export function rollLuck(randomUnit: RandomUnit = Math.random): number {
  return roll3d6x5(randomUnit);
}

/** 在职业范围内生成信用评级 */
export function rollCreditRating(range?: [number, number], randomUnit: RandomUnit = Math.random): number {
  const [min, max] = range ?? [20, 50];
  return min + Math.floor(drawRandomUnit(randomUnit) * (max - min + 1));
}

// ============================================================
// 技能点分配
// ============================================================

/** 计算职业技能点（支持双来源，如 EDU×4 或 EDU×2+DEX×2） */
export function calcOccupationSkillPoints(
  archetype: CharacterArchetype,
  attrs: Record<string, number>,
): number {
  const primaryAttr = archetype.skillSourceAttribute ?? "education";
  const primaryMult = archetype.skillPointMultiplier ?? 4;
  let total = (attrs[primaryAttr] ?? 50) * primaryMult;

  // 第二来源（如 DEX×2）
  const secondAttr = archetype.skillSecondSource;
  const secondMult = archetype.skillSecondMultiplier ?? 0;
  if (secondAttr && secondMult > 0) {
    total += (attrs[secondAttr] ?? 50) * secondMult;
  }

  return total;
}

/** 计算个人兴趣技能点 = INT × 2 */
export function calcInterestSkillPoints(intelligence: number): number {
  return intelligence * 2;
}

// ============================================================
// 年龄调整
// ============================================================

interface AgeMod {
  minAge: number;
  maxAge: number;
  mods: Partial<Record<CoCAttribute, number>>;
}

const AGE_MODS: AgeMod[] = [
  { minAge: 15, maxAge: 19, mods: { strength: -5, size: -5, education: -5, appearance: 5, dexterity: 5 } },
  { minAge: 20, maxAge: 29, mods: {} },
  { minAge: 30, maxAge: 39, mods: { strength: -5, constitution: -5, appearance: -5, education: 5, intelligence: 5 } },
  { minAge: 40, maxAge: 49, mods: { strength: -10, constitution: -10, dexterity: -5, appearance: -10, education: 10, intelligence: 5 } },
  { minAge: 50, maxAge: 59, mods: { strength: -15, constitution: -15, dexterity: -10, appearance: -15, education: 15, intelligence: 10 } },
  { minAge: 60, maxAge: 69, mods: { strength: -20, constitution: -20, dexterity: -15, appearance: -20, education: 20, intelligence: 15 } },
  { minAge: 70, maxAge: 79, mods: { strength: -25, constitution: -25, dexterity: -20, appearance: -25, education: 25, intelligence: 20 } },
  { minAge: 80, maxAge: 150, mods: { strength: -30, constitution: -30, dexterity: -25, appearance: -30, education: 30, intelligence: 25 } },
];

/** 应用年龄调整 */
export function applyAgeMods(
  attrs: Record<string, number>,
  age: number,
): { attrs: Record<string, number>; warnings: string[] } {
  const warnings: string[] = [];
  const mod = AGE_MODS.find(m => age >= m.minAge && age <= m.maxAge);
  if (!mod) {
    warnings.push(WARN_MSG.ageOutOfRange(age));
    return { attrs: { ...attrs }, warnings };
  }

  // 幸运不参与年龄调整：它不是 8 项核心属性之一，由 createCoCCharacter 单独生成。
  // AGE_MODS 里原本写了 luck 增减，但这里一直 continue 跳过——是从未生效的死数据，已删除。
  // 现在 mods 的类型 Partial<Record<CoCAttribute, number>> 本身就排除了 luck，无需再运行时判断。
  const result: Record<string, number> = { ...attrs };
  for (const [attr, delta] of Object.entries(mod.mods)) {
    const cur = result[attr] ?? 50;
    const newVal = Math.max(15, Math.min(99, cur + delta));
    result[attr] = newVal;
    if (delta !== 0) {
      warnings.push(WARN_MSG.ageModApplied(COC_ATTR_LABELS[attr] ?? attr, delta, cur, newVal));
    }
  }
  return { attrs: result, warnings };
}

// ============================================================
// 完整角色创建
// ============================================================

/**
 * 创建 CoC 7e 调查员角色（同步核心）
 *
 * 除初始物品外的全部建卡逻辑。独立成同步函数是因为 GameSession 的构造函数是同步的，
 * 而它此前只能退而使用通用的 CharacterFactory.generate()——那条路径给 CoC 角色写的是
 * D&D 六属性固定 10，且从不分配技能点。
 *
 * 需要初始物品请用 createCoCCharacter()。
 *
 * @param config 创建配置
 * @param archetype 职业模板
 * @returns 完整角色（startingItems 为空）
 */
export function buildCoCCharacter(
  config: CoCCharacterConfig,
  archetype: CharacterArchetype,
  randomUnit: RandomUnit = Math.random,
): CoCGeneratedCharacter {
  const warnings: string[] = [];
  const age = config.age ?? 30;

  // 1. 生成或使用手动指定属性
  let rawAttrs: Record<string, number>;
  if (config.attributes) {
    rawAttrs = {
      strength: config.attributes.strength ?? 50,
      constitution: config.attributes.constitution ?? 50,
      size: config.attributes.size ?? 50,
      dexterity: config.attributes.dexterity ?? 50,
      appearance: config.attributes.appearance ?? 50,
      intelligence: config.attributes.intelligence ?? 50,
      power: config.attributes.power ?? 50,
      education: config.attributes.education ?? 50,
    };
  } else if (config.method === "point_buy") {
    rawAttrs = pointBuyAttributes(config.pointBudget ?? 460, 40, 90, archetype.priorityAttributes, archetype.minAttributes, randomUnit);
  } else {
    rawAttrs = rollAttributes(randomUnit);
  }

  // 2. 应用年龄调整
  const ageResult = applyAgeMods(rawAttrs, age);
  const attrs = ageResult.attrs;
  warnings.push(...ageResult.warnings);

  // 3. 校验职业约束
  const constraintWarnings = validateOccupationConstraints(attrs, archetype, config.pointBudget);
  warnings.push(...constraintWarnings);

  // 4. 生成信用评级
  const creditRating = attrs["credit_rating"] ?? rollCreditRating(archetype.creditRatingRange, randomUnit);

  // 5. 派生数据
  const luck = config.includeLuck !== false
    ? rollLuck(randomUnit)
    : 0;
  const hp = calcCoCHP(attrs.constitution, attrs.size);
  const ac = calcCoCAC(attrs.dexterity);
  const { db: damageBonus, build } = calcDamageBonus(attrs.strength, attrs.size);
  const move = calcCoCMove(attrs.strength, attrs.dexterity, attrs.size, age);

  // 6. 技能点
  const occupationSkillPoints = calcOccupationSkillPoints(archetype, attrs);
  const interestSkillPoints = calcInterestSkillPoints(attrs.intelligence);

  // 6.5 自动分配技能点
  const skillValues = autoAllocateSkills(archetype, attrs, occupationSkillPoints, interestSkillPoints);

  // 7. 初始物品由 createCoCCharacter() 在异步层补齐（coc-cr 是动态导入）
  const startingItems: string[] = [];

  const occupationSkills = archetype.occupationSkills ?? archetype.skills ?? [];

  // 7.5 背景故事八项（车卡必填项——先生成八项，背景故事由 play-module 层 LLM 撰写）
  const backgroundProfile = buildBaseBackgroundProfile(archetype, randomUnit);

  return {
    name: config.name,
    archetypeId: archetype.id,
    attributes: attrs,
    luck,
    hp,
    maxHp: hp,
    ac,
    damageBonus,
    build,
    move,
    creditRating,
    startingItems,
    occupationSkillPoints,
    interestSkillPoints,
    occupationSkills,
    occupationSkillKeys: archetype.occupationSkills ?? undefined,
    availableSkills: COC_SKILLS,
    age,
    valid: constraintWarnings.length === 0,
    warnings,
    cthulhuMythos: 0,
    skillValues,
    backgroundProfile,
    backstory: "",
  };
}

/**
 * 创建 CoC 7e 调查员角色（含按信用评级发放的初始物品）
 * @param config 创建配置
 * @param archetype 职业模板
 * @returns 完整角色
 */
export async function createCoCCharacter(
  config: CoCCharacterConfig,
  archetype: CharacterArchetype,
  randomUnit: RandomUnit = Math.random,
): Promise<CoCGeneratedCharacter> {
  const character = buildCoCCharacter(config, archetype, randomUnit);
  try {
    const { getStartingItems } = await import("../rules/coc-cr");
    character.startingItems = getStartingItems(character.creditRating);
  } catch {
    character.warnings.push(WARN_MSG.itemsLoadFailed);
  }
  return character;
}

/**
 * 获取克苏鲁神话技能信息
 * 角色创建时默认为 0，需通过学习/遭遇事件增长
 */
export function getCthulhuMythosInfo(char: CoCGeneratedCharacter): {
  value: number;
  maxSanReduction: number;
  hasMythos: boolean;
} {
  const value = char.cthulhuMythos;
  return {
    value,
    maxSanReduction: value, // CM 值即 maxSAN 扣除值
    hasMythos: value > 0,
  };
}

/**
 * 通过技能英文 key 对角色进行技能检定
 * 自动解析角色技能列表中的中文/英文名，获取技能值后调用 CoCEngine.skillCheck
 *
 * @param char 角色
 * @param skillKey 技能英文 key（如 "cthulhu_mythos", "spot_hidden"）
 * @param skillValues 角色各技能当前值（百分比）
 * @param difficulty 检定难度
 * @param bonusDice 奖励骰数
 * @param penaltyDice 惩罚骰数
 * @param luckSpend 燃运点数
 * @returns 检定结果
 */
export function skillCheckByKey(
  char: CoCGeneratedCharacter,
  skillKey: string,
  skillValues: Record<string, number>,
  difficulty: "regular" | "hard" | "extreme" = "regular",
  bonusDice: number = 0,
  penaltyDice: number = 0,
  luckSpend: number = 0,
): CoCCheckResult {
  // 特殊处理克苏鲁神话
  if (skillKey === "cthulhu_mythos") {
    return CoCEngine.skillCheck(char.cthulhuMythos, difficulty, bonusDice, penaltyDice, luckSpend);
  }
  // 从角色技能值表中获取
  const value = skillValues[skillKey] ?? 0;
  return CoCEngine.skillCheck(value, difficulty, bonusDice, penaltyDice, luckSpend);
}

/**
 * 从角色技能列表中获取指定技能的值（百分比）
 * 兼容中文名和英文 key
 */
export function getSkillValue(
  charSkills: string[],
  allSkillValues: Record<string, number>,
  englishKey: string,
): number {
  if (englishKey === "cthulhu_mythos") {
    return 0; // CM 不存储在技能值表中，由 SanityEngine 维护
  }
  // 直接查找英文 key
  if (englishKey in allSkillValues) return allSkillValues[englishKey];
  // 通过中文名反向查找
  const cnName = REVERSE_SKILL_MAP[englishKey];
  if (cnName && charSkills.includes(cnName)) {
    return allSkillValues[cnName] ?? 0;
  }
  return 0;
}

/** 列出所有合法的 CoC 7e 职业 */
export function getCoCArchetypes(): CharacterArchetype[] {
  return ALL_ARCHETYPES.filter(a => a.rulesets.includes("cosmic-horror"));
}

// ============================================================
// CoC 7e 技能基础值（技能点分配的起点）
// ============================================================

/**
 * CoC 7e 技能基础值表（百分比），0 表示无基础值
 * 引用 CoC 7e 规则书技能列表
 */
export const COC_SKILL_BASES: Record<string, number> = {
  accounting: 5, anthropology: 1, appraise: 5, archaeology: 1, artillery: 0,
  art: 5, charm: 15, chemistry: 1, climb: 20, computer_use: 5,
  credit_rating: 15, cthulhu_mythos: 0, disguise: 5, dodge: 0, // dodge = DEX/2 (动态计算)
  drive: 20, electrical_repair: 10, electronics: 1, fast_talk: 5,
  fighting: 25, first_aid: 30, history: 20, intimidate: 15, jump: 20,
  language_other: 1, law: 5, library_use: 20, listen: 20, lockpick: 1,
  mechanical_repair: 10, medicine: 1, natural_history: 10, navigate: 10,
  occult: 5, operate_heavy_machinery: 1, persuade: 10, psychoanalysis: 1,
  psychology: 5, ride: 5, science_astronomy: 1, science_biology: 1,
  science_chemistry: 1, science_geology: 1, science_physics: 1,
  sleight_of_hand: 10, spot_hidden: 25, stealth: 20, survival: 10,
  swim: 20, throw: 20, track: 10,
};

// ── 别名/多中文→同英文 补充 ──
COC_SKILL_BASES["firearms_rifle"] = 25;
COC_SKILL_BASES["firearms_smg"] = 15;
COC_SKILL_BASES["firearms_pistol"] = 20;
COC_SKILL_BASES["firearms_mg"] = 10;
COC_SKILL_BASES["forensic"] = 1;
COC_SKILL_BASES["language_own"] = 0; // = EDU (动态计算)

/**
 * 获取技能基础值（考虑动态计算的特殊技能）
 * @param skillKey 英文 key
 * @param dex DEX 属性值（计算 dodge 时需要）
 * @param edu EDU 属性值（计算母语时需要）
 */
export function getBaseSkillValue(skillKey: string, dex: number = 50, edu: number = 50): number {
  if (skillKey === "dodge") return Math.floor(dex / 2);
  if (skillKey === "language_own") return edu;
  return COC_SKILL_BASES[skillKey] ?? 0;
}

/**
 * 自动分配技能点（快速创建用）
 * 将职业技能点均分到职业技能，兴趣技能点均分到所有技能
 * @returns 英文 key → 百分比值 的映射
 */
export function autoAllocateSkills(
  archetype: CharacterArchetype,
  attrs: Record<string, number>,
  occPts: number,
  intPts: number,
): Record<string, number> {
  const edu = attrs.education ?? 50;
  const dex = attrs.dexterity ?? 50;

  // 1. 初始化所有已知技能为基础值
  const allEngKeys = [...new Set(Object.values(SKILL_NAME_MAP))];
  const values: Record<string, number> = {};
  for (const eng of allEngKeys) {
    values[eng] = getBaseSkillValue(eng, dex, edu);
  }

  const occEngKeys: string[] = archetype.occupationSkills ?? [];

  // 2. 分配职业技能点（均分到职业技能）
  if (occEngKeys.length > 0 && occPts > 0) {
    let remaining = occPts;
    // 第一轮：均分
    const perSkill = Math.floor(occPts / occEngKeys.length);
    for (const engKey of occEngKeys) {
      const current = values[engKey] ?? 0;
      const maxAdd = 99 - current;
      const add = Math.min(perSkill, maxAdd, remaining);
      if (add > 0) {
        values[engKey] = current + add;
        remaining -= add;
      }
    }
    // 第二轮：逐个分配余数
    for (const engKey of occEngKeys) {
      if (remaining <= 0) break;
      const current = values[engKey] ?? 0;
      const add = Math.min(remaining, 99 - current);
      if (add > 0) {
        values[engKey] = current + add;
        remaining -= add;
      }
    }
  }

  // 3. 分配兴趣技能点（优先补弱）
  if (intPts > 0) {
    let remaining = intPts;
    // 按当前值升序排序
    const sorted = allEngKeys
      .filter(k => k !== "cthulhu_mythos" && k !== "credit_rating")
      .sort((a, b) => (values[a] ?? 0) - (values[b] ?? 0));

    // 第一轮：每个技能加 5 点（或更少）
    for (const engKey of sorted) {
      if (remaining <= 0) break;
      const current = values[engKey] ?? 0;
      const add = Math.min(5, remaining, 99 - current);
      if (add > 0) {
        values[engKey] = current + add;
        remaining -= add;
      }
    }
    // 第二轮：逐个分配余数
    for (const engKey of sorted) {
      if (remaining <= 0) break;
      const current = values[engKey] ?? 0;
      const add = Math.min(remaining, 99 - current);
      if (add > 0) {
        values[engKey] = current + add;
        remaining -= add;
      }
    }
  }

  return values;
}
