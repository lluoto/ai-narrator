// ============================================================
// 结构化状态/疾病系统
// ============================================================

type StatusCategory =
  | "physical"   // 物理：中毒、流血
  | "mental"     // 精神：恐惧、魅惑
  | "combat"     // 战斗：潜行、专注
  | "condition"  // 疾病/诅咒
  | "buff"       // 增益
  | "debuff";    // 减益

/**
 * 由状态定义本身声明的、对行动入口的确定性限制。
 *
 * 这里刻意不是按 `name`/`desc` 猜关键词：状态 id 与它的规则语义都只在
 * STATUS_LIB 维护一次，GameSession 只消费这个查询结果。
 */
type StatusActionRestriction = "cannot_act";

interface StatusEffect {
  id: string;
  name: string;
  desc: string;
  category: StatusCategory;
  /** 持续回合数，-1 = 永续 */
  duration: number;
  /** 叠层数 */
  stacks: number;
  /** 来源（施法者/物品名） */
  source?: string;
  /** 每回合效果描述 */
  tickDesc?: string;
}

export function createStatus(id: string, name: string, desc: string, category: StatusCategory, duration: number): StatusEffect {
  return { id, name, desc, category, duration, stacks: 1 };
}

export function statusTick(s: StatusEffect): StatusEffect {
  if (s.duration === -1) return s;
  return { ...s, duration: Math.max(0, s.duration - 1) };
}

export function isStatusExpired(s: StatusEffect): boolean {
  return s.duration !== -1 && s.duration <= 0;
}

export function formatStatus(s: StatusEffect): string {
  const d = s.duration === -1 ? "" : ` (${s.duration}回合)`;
  const st = s.stacks > 1 ? ` x${s.stacks}` : "";
  return `${s.name}${d}${st}`;
}

/**
 * `formatStatus` 的逆运算。
 *
 * 为什么要有：实体身上存的是 `status: string[]`（`wound-effects`、
 * `story-generator`、`game-session` 全都这么存）。要让状态**走时限**，
 * 就得能从字符串读回回合数。
 *
 * 关键是**不另开一套存储**：不给实体加第二个 `statusEffects: StatusEffect[]`
 * 字段。一份数据两套解析是这个仓库反复在修的病，状态不能重蹈覆辙。
 * 所以格式化与解析都放在这里，一个文件里成对出现，round-trip 有测试钉着。
 *
 * 认不出来的字符串（`"重伤:左臂"`、`"疯狂"` 这类既有标签）返回 null ——
 * 它们是没有时限的裸标签，照原样留着，不参与 tick。
 */
export function parseStatus(text: string): StatusEffect | null {
  const m = text.match(/^(.+?)(?:\s*\((-?\d+)回合\))?(?:\s*x(\d+))?$/);
  if (!m) return null;
  const name = m[1]!.trim();
  const entry = Object.entries(STATUS_LIB).find(([, d]) => d.name === name);
  if (!entry) return null;
  const [id, def] = entry;
  return {
    id, name: def.name, desc: def.desc, category: def.category,
    duration: m[2] !== undefined ? Number(m[2]) : def.defaultDuration,
    stacks: m[3] !== undefined ? Number(m[3]) : 1,
  };
}

/**
 * 返回当前仍应阻断角色行动的状态；`status: string[]` 仍是唯一存储。
 *
 * 调用方应在推进回合前读取它：一回合的昏迷会在该回合结束时到期，但不能
 * 因为先 tick 再派发意图而从未约束过任何一次行动。
 */
export function getActionBlockingStatus(statuses: readonly string[]): StatusEffect | null {
  for (const raw of statuses) {
    const status = parseStatus(raw);
    if (!status || status.duration === 0) continue;
    if (STATUS_LIB[status.id]?.actionRestriction === "cannot_act") return status;
  }
  return null;
}

/**
 * 把一组状态字符串推进一回合。
 *
 * 返回三样：推进后的字符串、这一回合到期掉的、以及仍在生效的结构化状态
 * （调用方要靠它决定扣多少血 —— 扣血是**游戏层**的事，规则层不碰实体）。
 *
 * 认不出来的标签原样保留：它们是既有的无时限标签（重伤部位、疯狂……），
 * 不能因为这里看不懂就把人家清掉。
 */
export function tickStatuses(statuses: readonly string[]): {
  next: string[];
  expired: StatusEffect[];
  active: StatusEffect[];
} {
  const next: string[] = [];
  const expired: StatusEffect[] = [];
  const active: StatusEffect[] = [];
  for (const raw of statuses) {
    const s = parseStatus(raw);
    if (!s) { next.push(raw); continue; }   // 裸标签，不归这里管
    active.push(s);
    const t = statusTick(s);
    if (isStatusExpired(t)) expired.push(t);
    else next.push(formatStatus(t));
  }
  return { next, expired, active };
}

// ── 预设状态库 ──────────────────────────────────────

const STATUS_LIB: Record<string, {
  name: string;
  desc: string;
  category: StatusCategory;
  defaultDuration: number;
  actionRestriction?: StatusActionRestriction;
  /** A direct adjustment to an actor's percentile target, never a text-derived guess. */
  percentileTargetModifier?: number;
}> = {
  poisoned:      { name: "中毒",   desc: "每回合受到毒属性伤害", category: "physical", defaultDuration: 4 },
  bleeding:      { name: "流血",   desc: "持续损失体力",        category: "physical", defaultDuration: 3 },
  // 胸部暴击规则只写“每轮额外失去 1d3 HP”，没有自然到期条件；沿既有急救
  // 的止血语义保持到成功处理伤口，不能擅自伪造普通流血的三回合时限。
  hemorrhaging:  { name: "大出血", desc: "每回合额外失去 1d3 HP，直到止血", category: "physical", defaultDuration: -1 },
  // The duration is rolled by CoC combat when this status is written; this
  // definition owns only its persistent, deterministic action-check meaning.
  abdominal_impaled: { name: "腹部贯穿", desc: "主动百分检定目标 -20%", category: "physical", defaultDuration: 1, percentileTargetModifier: -20 },
  // A normal 5+ damage head hit explicitly penalizes only the next action;
  // no die is declared by that rule, so this fixed one-turn duration is final.
  head_dazed: { name: "头晕目眩", desc: "下一次主动百分检定目标 -20%", category: "physical", defaultDuration: 1, percentileTargetModifier: -20 },
  burning:       { name: "燃烧",   desc: "被火焰吞噬",          category: "physical", defaultDuration: 2 },
  stunned:       { name: "昏迷",   desc: "无法行动",            category: "combat",   defaultDuration: 1, actionRestriction: "cannot_act" },
  incapacitated: { name: "失能",   desc: "无法行动",            category: "combat",   defaultDuration: 1, actionRestriction: "cannot_act" },
  blinded:       { name: "致盲",   desc: "视线受阻",            category: "debuff",   defaultDuration: 2 },
  frightened:    { name: "恐惧",   desc: "意志检定劣势",        category: "mental",   defaultDuration: 3 },
  charmed:       { name: "魅惑",   desc: "受控于施法者",        category: "mental",   defaultDuration: 3 },
  prone:         { name: "倒地",   desc: "近战攻击优势，远程劣势", category: "combat", defaultDuration: -1 },
  sneaking:      { name: "潜行",   desc: "不易被察觉",          category: "combat",   defaultDuration: -1 },
  concentrating: { name: "专注",   desc: "维持法术",            category: "combat",   defaultDuration: -1 },
  inspiration:   { name: "鼓舞",   desc: "下次检定优势",        category: "buff",     defaultDuration: 2 },
  exhausted:     { name: "疲惫",   desc: "所有检定劣势",        category: "debuff",   defaultDuration: 5 },
  diseased:      { name: "染病",   desc: "持续虚弱",            category: "condition", defaultDuration: 7 },
  cursed:        { name: "诅咒",   desc: "神秘力量影响",        category: "condition", defaultDuration: -1 },
  confused:      { name: "困惑",   desc: "行动随机",            category: "mental",   defaultDuration: 2 },
  grappled:      { name: "擒抱",   desc: "失去闪避能力",       category: "combat",   defaultDuration: -1 },
  hasted:        { name: "加速",   desc: "额外行动机会",        category: "buff",     defaultDuration: 3 },
  slowed:        { name: "迟缓",   desc: "移动速度减半",        category: "debuff",   defaultDuration: 2 },
};

export function getStatusDef(id: string): { name: string; desc: string; category: StatusCategory; defaultDuration: number } | undefined {
  return STATUS_LIB[id];
}

/**
 * The one query for status-driven percentile targets. A status string remains
 * the sole persisted state; malformed labels and expired entries have no rule
 * effect. The abdomen rule does not say multiple wounds stack, so concurrent
 * instances use the strongest single penalty rather than inventing -20 per
 * stack or per duplicate entry.
 */
export function getPercentileTargetModifier(statuses: readonly string[]): number {
  let strongestPenalty = 0;
  for (const raw of statuses) {
    const status = parseStatus(raw);
    if (!status || status.duration === 0) continue;
    const modifier = STATUS_LIB[status.id]?.percentileTargetModifier;
    if (typeof modifier === "number" && Number.isFinite(modifier)) {
      strongestPenalty = Math.min(strongestPenalty, modifier);
    }
  }
  return strongestPenalty;
}

/**
 * 按库里的 id 造一条**可存进 `status: string[]` 的**状态串，带默认时限。
 *
 * 调用方写 `newStatus("bleeding")` 而不是字面量 `"流血"`：
 * 名字和默认时限都只在定义库里写一遍。
 * 库里没有这个 id 就抛 —— 静默返回 id 本身会让拼错的状态变成一个
 * 永远 tick 不到的裸标签，正是本次要修掉的那种毛病。
 */
export function newStatus(id: string, duration?: number): string {
  const def = STATUS_LIB[id];
  if (!def) throw new Error(`未知状态 id: ${id}（见 src/rules/status-effects.ts 的 STATUS_LIB）`);
  return formatStatus({
    id, name: def.name, desc: def.desc, category: def.category,
    duration: duration ?? def.defaultDuration, stacks: 1,
  });
}

export function listStatusDefs(): { id: string; name: string; desc: string; category: string }[] {
  return Object.entries(STATUS_LIB).map(([id, def]) => ({
    id, name: def.name, desc: def.desc, category: def.category,
  }));
}
