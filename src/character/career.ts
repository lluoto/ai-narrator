/**
 * 角色卡传承模型与纯计算
 * ===============================
 *
 * 追踪调查员角色跨越多个神话模组的成长轨迹，支持：
 *
 * 1. **历程记录 (A)** — 每次模组完成时记录结局/奖励/变化
 * 2. **跨模组继承 (B)** — 从历程累算出角色的当前状态，带入下一模组
 * 3. **历程回溯** — 查询角色在任意时间点的状态
 *
 * 数据模型：
 *   CharacterSnapshot（角色创建时基线）
 *       ↓ 每次模组完成追加一条
 *   CareerEntry × N（模组完成记录）
 *       ↓ 累加
 *   CharacterCareer（计算出的当前状态）
 *
 * 该模块只定义共享模型并计算状态。持久化由 CareerFileStore 负责；它在
 * GameSession 的明确组合根中构造，而不是在模型层保留第二个存储权威。
 */

// ============================================================
// 类型定义
// ============================================================

/** 角色初始快照 — 创建角色时记录的基线数据 */
export interface CharacterSnapshot {
  /** 角色名 */
  characterName: string;
  /** 玩家名（可选） */
  playerName?: string;
  /** 职业 */
  occupation: string;
  /** CoC 7e 核心属性（strength/constitution/size/dexterity/appearance/intelligence/power/education） */
  attributes: Record<string, number>;
  /** 技能值（中文技能名 → 百分比） */
  skills: Record<string, number>;
  /** 当前 SAN */
  san: number;
  /** 最大 SAN（99 - 克苏鲁神话） */
  maxSan: number;
  /** 克苏鲁神话技能值 */
  cthulhuMythos: number;
  /** HP */
  hp: number;
  /** 最大 HP */
  maxHp: number;
  /** 信誉值 */
  creditRating: number;
  /** 创建时间 */
  createdAt: string;
  /** 备注（自由文本） */
  notes?: string;

  // ── 完整角色卡扩展字段 ──
  /** 伤害加值（如 "+1d4"） */
  damageBonus?: string;
  /** 体格/体型 */
  build?: number;
  /** 移动力 */
  move?: number;
  /** 幸运值 */
  luck?: number;
  /** 护甲等级 */
  ac?: number;
  /** 现金 */
  cash?: number;
  /** 装备的武器列表 */
  weapons?: string[];
  /** 装备的护甲列表 */
  armor?: string[];
  /** 背包物品列表 */
  inventory?: string[];
  /** 年龄 */
  age?: number;
  /** 性别 */
  gender?: string;
  /** 身高 */
  height?: string;
  /** 体重 */
  weight?: string;
  /** 外貌描述 */
  description?: string;
  /** 背景故事 */
  backstory?: string;
  /** 恐惧症列表 */
  phobias?: string[];
  /** 躁狂症列表 */
  manias?: string[];
  /** 伤病史 */
  injuries?: string[];
  /** 职业技能点 */
  occupationSkillPoints?: number;
  /** 兴趣技能点 */
  interestSkillPoints?: number;
  /** 职业技能列表 */
  occupationSkills?: string[];
}

/** 单次模组完成记录 */
export interface CareerEntry {
  /** 唯一标识（自动生成） */
  id: string;
  /** 角色名（与 snapshot.characterName 关联） */
  characterName: string;
  /** 模组 ID */
  moduleId: string;
  /** 模组名称 */
  moduleName: string;
  /** 模组难度 */
  moduleDifficulty?: string;
  /** 完成时间 */
  completedAt: string;
  /** 达成的结局 ID */
  endingId: string;
  /** 结局显示名 */
  endingName: string;
  /** 结局描述 */
  endingDescription?: string;
  /** SAN 变化（负值为损失） */
  sanChange: number;
  /** CM 变化（正值为增长） */
  cmChange: number;
  /** 信誉变化 */
  reputationChange: number;
  /** 技能成长列表（如 ["侦查+d10→87", "潜行+d6→45"]） */
  skillChanges: string[];
  /** 生效的奖励规则 ID 列表 */
  rewardIds: string[];
  /** 自动生成的一句话叙事摘要 */
  narrative: string;
  /** 原始奖励数据快照（JSON，供 debug/溯源） */
  rewardSnapshot?: string;
}

/** 角色的完整历程（计算视图） */
export interface CharacterCareer {
  /** 角色名 */
  characterName: string;
  /** 基线快照 */
  base: CharacterSnapshot;
  /** 所有模组完成记录（按时间正序） */
  entries: CareerEntry[];
  /** 已完成的模组数量 */
  totalModules: number;
  // ── 计算字段 ──
  /** 当前 SAN */
  currentSan: number;
  /** 当前最大 SAN */
  currentMaxSan: number;
  /** 当前 CM */
  currentCthulhuMythos: number;
  /** 当前 HP */
  currentHp: number;
  /** 当前最大 HP */
  currentMaxHp: number;
  /** 当前技能值（基线技能 + 所有成长变更） */
  currentSkills: Record<string, number>;
  /** 当前信誉 */
  currentCreditRating: number;
}

// ============================================================
// 计算函数
// ============================================================

/**
 * 从基线快照 + 历程条目列表，计算角色的当前状态
 * （继承计算的核心逻辑）
 */
export function computeCurrentState(
  base: CharacterSnapshot,
  entries: CareerEntry[],
): {
  san: number;
  maxSan: number;
  cthulhuMythos: number;
  hp: number;
  maxHp: number;
  skills: Record<string, number>;
  creditRating: number;
} {
  let san = base.san;
  let maxSan = base.maxSan;
  let cm = base.cthulhuMythos;
  let hp = base.hp;
  let maxHp = base.maxHp;
  let cr = base.creditRating;
  const skills: Record<string, number> = { ...base.skills };

  for (const entry of entries) {
    san += entry.sanChange;
    cm += entry.cmChange;
    cr += entry.reputationChange;

    // 技能成长
    for (const change of entry.skillChanges) {
      // format: "技能名+骰子→最终值" or "技能名+dX" or "技能名→最终值"
      const parsed = parseSkillChange(change);
      if (parsed) {
        skills[parsed.name] = parsed.value;
      }
    }
  }

  // CoC 7e: 最大 SAN = 99 - CM（始终从 CM 计算，忽略 base.maxSan）
  maxSan = Math.max(0, 99 - cm);

  // 保证 SAN 不溢出边界
  san = Math.max(0, Math.min(san, maxSan));
  cm = Math.max(0, cm);
  maxHp = base.maxHp; // HP 上限通常不变（除非模组特别说明）
  hp = Math.min(hp, maxHp); // 实际 HP 由游戏内战斗/治疗决定，这里只是传递基线

  return { san, maxSan, cthulhuMythos: cm, hp, maxHp, skills, creditRating: cr };
}

/**
 * 解析技能变更字符串
 * 支持格式: "侦查+d10→87", "潜行→45"
 * 用 String.split 避免 regex 转义问题
 */
function parseSkillChange(change: string): { name: string; value: number } | null {
  // Split on → (U+2192)
  const parts = change.split("\u2192");
  if (parts.length !== 2) return null;
  const namePart = parts[0];
  const value = parseInt(parts[1], 10);
  if (isNaN(value)) return null;
  // Strip trailing dice notation: "+d10", "+1d10", "+1d6" etc.
  // Find the last '+' that precedes a digit-or-dice pattern
  const plusIdx = namePart.lastIndexOf("+");
  if (plusIdx >= 0) {
    const suffix = namePart.slice(plusIdx);
    // Check if suffix looks like dice notation: +[num]d[num]
    if (/^\+\d*d\d+$/.test(suffix)) {
      return { name: namePart.slice(0, plusIdx).trim(), value };
    }
  }
  // No dice notation — just skill name
  return { name: namePart.trim(), value };
}

/**
 * 自动生成完成记录的一句话叙事
 */
export function generateNarrative(
  moduleName: string,
  endingName: string,
  sanChange: number,
  cmChange: number,
  skillChanges: string[],
): string {
  const parts: string[] = [];
  parts.push(`完成模组「${moduleName}」`);

  if (endingName) {
    parts.push(`结局：${endingName}`);
  }
  if (sanChange !== 0) {
    parts.push(sanChange > 0 ? `SAN +${sanChange}` : `SAN ${sanChange}`);
  }
  if (cmChange > 0) {
    parts.push(`CM +${cmChange}`);
  }
  if (skillChanges.length > 0) {
    const skillNames = skillChanges.map(s => {
      const m = s.match(/^(.+?)\+/);
      return m ? m[1] : s;
    });
    parts.push(`技能成长：${skillNames.join("、")}`);
  }

  return parts.join("，") + "。";
}
