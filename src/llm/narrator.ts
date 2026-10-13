// 叙事生成器 — 克苏鲁风格战斗叙事
// LLM 驱动（有 API Key） + 模板 fallback（无 API Key）
// 根据伤害/总HP比例决定伤势描述等级
//
// 文案池在同目录 narrator-pools.ts（纯数据，内容开发只改那个文件）。
//
// 严重度分级 —— 与 combat/wound-effects.ts 的 calcSeverity **实测对齐**
// （之前这里写的阈值和真实代码整体错开一档，已订正）：
//   scratch  ≤25%   擦伤（无惩罚骰）
//   flesh    25~49% 轻伤
//   deep     ≥50%   CoC 重伤（Major Wound）
//   grievous ≥75%   致残级重伤
//   lethal   ——     HP 归零，不是比例算出来的（calcSeverity 从不返回
//                    "lethal"），由调用方传入 outcome.result === "kill" 决定。

import type { LLMClient } from "./client";
import { llmEnabled } from "./enabled";
import { calcSeverity } from "../combat/wound-effects";
import { checkDialogueText } from "../world/world-constraint";
import {
  SCRATCH_TEMPLATES, FLESH_TEMPLATES, DEEP_TEMPLATES, GRIEVOUS_TEMPLATES,
  LETHAL_TEMPLATES, MISS_TEMPLATES, FUMBLE_TEMPLATES, CRIT_PREFIX,
} from "./narrator-pools";

/**
 * 战斗一击的结果 —— 只取叙事需要的字段，不绑定某一套规则引擎的
 * `CombatResult` 类型。D&D 侧的 `CombatResult`（types.ts）结构上超集这个
 * 接口，原调用点不用改；CoC 侧（play/combat.ts、GameSession）不必先拼出
 * 一个完整的 D&D 战斗结果对象才能叫这个函数。
 */
export interface NarrativeOutcome {
  hit: boolean;
  crit?: boolean;
  damage: number;
  result: "kill" | "wound" | "miss";
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fillTemplate(t: string, attacker: string, defender: string, weapon: string): string {
  return t
    .replace(/\{attacker\}/g, attacker)
    .replace(/\{defender\}/g, defender)
    .replace(/\{weapon\}/g, weapon);
}

// ============================================================
// 模板叙事
// ============================================================

function templateNarrative(
  attackerName: string,
  defenderName: string,
  weaponName: string,
  outcome: NarrativeOutcome,
  maxHp: number,
  fumble: boolean,
): string {
  const weapon =
    weaponName === "shortsword" ? "短刀"
    : weaponName === "longsword" ? "长刀"
    : weaponName === "dagger" ? "匕首"
    : weaponName === "longbow" ? "长弓"
    : weaponName === "spear" ? "长矛"
    : weaponName === "fist" ? "拳头"
    : weaponName;

  let template: string;
  if (!outcome.hit) {
    template = pick(fumble ? FUMBLE_TEMPLATES : MISS_TEMPLATES);
  } else if (outcome.result === "kill") {
    template = pick(LETHAL_TEMPLATES);
  } else {
    const severity = calcSeverity(outcome.damage, maxHp);
    switch (severity) {
      case "scratch":  template = pick(SCRATCH_TEMPLATES); break;
      case "flesh":    template = pick(FLESH_TEMPLATES); break;
      case "deep":     template = pick(DEEP_TEMPLATES); break;
      case "grievous": template = pick(GRIEVOUS_TEMPLATES); break;
      default:         template = pick(FLESH_TEMPLATES); break;
    }
  }

  let narrative = fillTemplate(template, attackerName, defenderName, weapon);

  if (outcome.crit && outcome.hit) {
    narrative = pick(CRIT_PREFIX) + narrative;
  }

  return narrative;
}

// ============================================================
// LLM 驱动叙事生成
// ============================================================

const NARRATIVE_SYSTEM_PROMPT = `你是洛夫克拉夫特风格的 TRPG 战斗叙事生成器。生成一段简洁、阴郁、写实的战斗描述。

要求：
- 1-3 句话，不超过 100 字
- 语调冷静、细节化，像调查员的观察笔记
- 命中时具体描写：武器造成的伤口形态、出血量、有无骨/脏器暴露
- 暴击时描写瞬间的冲击与目标的生理反应
- 未命中时描写子弹/武器掠过空气的声音
- 击杀时描写死亡的过程——从受伤到失去生命体征
- 不要使用"剑光闪过"、"暴喝一声"等武侠/奇幻表达
- 不要写"掷出了XX点"、"命中/未命中判定"等元信息
- 注意伤害严重度（擦伤/轻伤/重伤/致命/斩杀），伤势越重描写越详细
- 伤害占总血量比例决定伤势轻重，据此调整描述的惨烈程度`;

async function generateNarrativeLLM(
  attackerName: string,
  defenderName: string,
  weaponName: string,
  outcome: NarrativeOutcome,
  maxHp: number,
  llm: LLMClient
): Promise<string> {
  const weapon =
    weaponName === "shortsword" ? "短刀"
    : weaponName === "longsword" ? "长刀"
    : weaponName === "dagger" ? "匕首"
    : weaponName === "longbow" ? "长弓"
    : weaponName;

  const severity = outcome.hit ? calcSeverity(outcome.damage, maxHp) : null;

  const userPrompt = [
    `攻击者: ${attackerName}`,
    `目标: ${defenderName}`,
    `武器: ${weapon}`,
    `命中: ${outcome.hit ? "是" : "否"}`,
    `暴击: ${outcome.crit ? "是" : "否"}`,
    `伤害: ${outcome.damage} 点`,
    `目标最大HP: ${maxHp}`,
    `伤势严重度: ${severity ?? "无"}`,
    `结果: ${outcome.result === "kill" ? "击杀" : outcome.result === "wound" ? "受伤" : "未命中"}`,
  ].join("\n");

  const raw = await llm.chat(
    [
      { role: "system", content: NARRATIVE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { temperature: 0.8, maxTokens: 200, timeout: 120000, maxAttempts: 1, workload: "narration" }
  );

  // 世界模型约束：时代科技黑名单 / meta 词汇。命中则重生成一次（新上下文），再命中则交回降级路径
  let text = raw.trim();
  if (checkDialogueText(text)) {
    text = (await llm.chat(
      [
        { role: "system", content: NARRATIVE_SYSTEM_PROMPT + "\n禁止使用任何 1920 年代不存在的现代科技词汇（手机、电视、电脑、互联网等）。" },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.6, maxTokens: 200, timeout: 120000, maxAttempts: 1, workload: "narration" }
    )).trim();
  }
  if (checkDialogueText(text)) {
    throw new Error("LLM 叙事违反世界模型约束，降级模板");
  }

  return text;
}

// ============================================================
// 统一入口
// ============================================================

let _narratorLLM: LLMClient | null = null;

export function setNarratorLLM(client: LLMClient | null) {
  _narratorLLM = client;
}

/** 供调用方判断「要不要设」，避免多个会话互相顶掉彼此设的客户端（同 intent.ts 的做法）。 */
export function narratorLLMConfigured(): boolean {
  return _narratorLLM !== null;
}

/**
 * 生成战斗叙事文本。
 *
 * @param maxHp 目标最大生命值（用于计算伤势严重度）—— **必传**。
 *   原先这里有默认值 10，而唯一接了这个函数的调用点（CLI）没传，
 *   于是分档基数永远是 10：打 30 HP 的怪物造成 6 点伤害会被算成
 *   deep（重伤），实际只是 flesh（皮肉伤）。改成必传，让编译器堵住这条路。
 * @param opts.fumble CoC 规则下「大失败」比普通落空更狼狈（攻击者自己
 *   出丑），走单独的文案池。不传則按普通落空处理。
 */
export async function generateNarrative(
  attackerName: string,
  defenderName: string,
  weaponName: string,
  outcome: NarrativeOutcome,
  maxHp: number,
  opts?: { fumble?: boolean },
): Promise<string> {
  return generateNarrativeWithLLM(
    _narratorLLM,
    attackerName, defenderName, weaponName, outcome, maxHp, opts,
  );
}

/**
 * Generate one combat narration with the client that owns the current runtime.
 *
 * `null` is an explicit offline choice: it must not fall back to the CLI's
 * legacy module-global narrator.  GameSession and play-module use this entry
 * point so concurrent sessions cannot borrow each other's configuration.
 */
export async function generateNarrativeWithLLM(
  llm: LLMClient | null,
  attackerName: string,
  defenderName: string,
  weaponName: string,
  outcome: NarrativeOutcome,
  maxHp: number,
  opts?: { fumble?: boolean },
): Promise<string> {
  if (llm && llmEnabled()) {
    try {
      return await generateNarrativeLLM(
        attackerName, defenderName, weaponName, outcome, maxHp, llm
      );
    } catch (err) {
      // console.warn(`  ⚠ LLM 叙事失败，退化到模板: ${(err as Error).message.slice(0, 80)}`);
    }
  }
  return templateNarrative(
    attackerName, defenderName, weaponName, outcome, maxHp, opts?.fumble ?? false,
  );
}
