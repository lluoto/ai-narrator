// 从 play-module.ts 抽出来的一段（脚本搬运，见 tools/_extract-block.ts）。
//
// 抽出来的理由是可寻址性：原先 runModuleInner 一个函数 2615 行、占全文件 74%，
// 里面按注释能切出近 30 个块，但没有一个是能整段读进来的单元 ——
// 每次改动只能靠行号开窗口猜，窄了缺上下文、宽了浪费。
//
// ⚠ 纯搬运，不改行为。判据是全量测试与主循环脚手架全绿。

import type { ModuleData, Scene, ModuleSupport } from "../module/types";
import type { WorldState } from "../world/state";
import { CoCEngine, SUCCESS_LEVEL_LABELS, rollHitLocation } from "../rules/coc-engine";
import { runCtx, say, sayMech, emit } from "./narration";
import { sanCheck, check, applyDamage, woundPenaltyOf } from "./checks";
import { needsMajorWoundCheck, getDisability } from "../combat/wound-effects";
import { activeHooks } from "./ruleset";
import { runChase, environmentFromScene } from "./chase";
import { rollDice } from "./trap-util";
import { isDowned } from "./run-state";
import type { Cast } from "./run-state";
import { generateNarrativeWithLLM } from "../llm/narrator";

/**
 * Boss 遭遇战（本模组是 Mi-Go）。条件不满足就直接返回，不产生任何播报。
 *
 * ⚠ 过期注释更正：这里原先写着「玩家这边没有受伤路径，`applyDamage`
 * 调用点全在陷阱段」——那是敌人还手功能接线**之前**的状态。现在
 * `enemyAttack()`（本文件下方）真的会调 `applyDamage` 打玩家，伤势/惩罚骰
 * 那套机制在战斗里也生效了。旧注释留到现在没人更新，本身就是本仓库
 * 反复在修的那类病：写了后续修复，却没回头改前面说「没做」的话。
 */
/**
 * 从 NPC 描述里读战斗数值。模组 mi_go 那行原文：
 * 「每回合攻击2次。格斗45%（1d6伤害）闪避35%」
 *
 * ⚠ 只在含「每回合攻击」的那一行上匹配，不要全描述搜 ——
 * 同一段里还有「闪避35%」和「理智损失：0/1d6」，
 * 全局贪心匹配会把闪避读成格斗值（实测踩过，读出 35 而不是 45）。
 *
 * 兜底值与模组保持一致：读不到时行为不应该悄悄变强或变弱。
 */
export function parseEnemyStats(desc: string): { skill: number; damage: string; times: number } {
  const line = desc.split("\n").find(l => l.includes("每回合攻击")) ?? "";
  const atk = line.match(/格斗\s*(\d+)\s*%/);
  const dmg = line.match(/[（(]\s*(\d*[dD]\d+(?:\s*[+-]\s*\d+)?)\s*伤害\s*[）)]/);
  const times = line.match(/每回合攻击\s*(\d+)\s*次/);
  return {
    skill: atk ? parseInt(atk[1]!, 10) : 45,
    damage: (dmg?.[1] ?? "1d6").replace(/\s/g, ""),
    times: times ? parseInt(times[1]!, 10) : 2,
  };
}

export async function runCombatEncounter(
  cast: Cast,
  world: WorldState,
  module: ModuleData,
  scene: Scene,
  support: ModuleSupport,
): Promise<void> {
  const { p0, p1, c1, c2, san1, san2 } = cast;

// Mi-Go Combat Encounter — 多回合战斗系统
const migoEncounter = support.encounters.find(e =>
  e.sceneId === scene.id &&
  world.isClueFound(e.requiredClue) &&
  !world.isClueFound(e.excludedClue)
);
if (migoEncounter) {
  const enemyName = migoEncounter.enemyName ?? "敌人";
  const fmt = (t: string) => t.replaceAll("{enemy}", enemyName);
  say(`\n${"═".repeat(48)}`);
  say(`  ⚔ ${enemyName}战斗轮 ⚔`);
  say(`${"═".repeat(48)}`);
  emit({ type: "combat-start", enemy: enemyName });
  for (const line of migoEncounter.encounterLines) say(fmt(line), "verbatim");
  say("");

  // Read Mi-Go HP from module NPC data: "HP11 MP15 DB无" → 11
  const migoNpc = module.npcs.find(n => support.bossNpcIdPattern.test(n.id));
  const desc = migoNpc?.description ?? "";
  const hpMatch = desc.match(/\bHP\s*(\d+)/i);
  const migoMaxHp = hpMatch ? parseInt(hpMatch[1], 10) : 11;
  let migoHp = migoMaxHp;

  // 敌人的攻击也从模组描述里读，跟 HP 同一个路子 —— 别自己编数值。
  // 原文那一行：「每回合攻击2次。格斗45%（1d6伤害）闪避35%」
  //
  // 原先这一段完全没有：引擎读了 HP 却把攻击那句丢了，于是敌人从头到尾不还手，
  // 玩家在整场 Boss 战里掉不了一点血（`applyDamage` 的调用点全在陷阱段）。
  // 后果是伤势/惩罚骰那套机制在战斗中完全用不上。
  //
  const enemyStats = parseEnemyStats(desc);
  const pcCombatants = [
    { pc: c1, name: p0.shortName, fightingKey: "fighting", firearmsKey: "firearms_pistol" },
    { pc: c2, name: p1.shortName, fightingKey: "fighting", firearmsKey: "firearms_pistol" },
  ];

  // ── 战斗行动 & 伤害叙事 ──
  // 值是扁平的 string[]（每个键一组候选台词），此前误写成 string[][]，
  // 导致 pick() 的返回类型被推成 string[]，下游 fmt() 才会报参数类型不符。
  const actionVariants: Record<string, string[]> = {
    [`${p0.shortName}_格斗`]: [
      "抄起身边的家伙迎了上去！", "握紧拳头沉身逼近！", "抓起一张椅子猛砸过去！",
      "顺手抄起一根铁管挥去！", "低喝一声侧身冲上前！",
    ],
    [`${p0.shortName}_射击`]: [
      "拔出左轮手枪冷静瞄准！", "举枪对准{enemy}扣动扳机！", "侧身闪避的同时抬手就是一枪！",
      "双手握枪，目光如炬地瞄准！",
    ],
    [`${p1.shortName}_格斗`]: [
      "抓起一把手术刀冲向{enemy}！", "握紧拳头摆出军体拳架势！",
      "抡起一张折叠椅砸了过去！", "抄起金属器械猛掷过去！",
    ],
    [`${p1.shortName}_射击`]: [
      "掏出左轮手枪瞄准{enemy}！", "举枪冷静射击！",
      "双手握枪对准{enemy}的翼膜扣动扳机！",
    ],
  };
  // 战斗叙述原先在这里另有一套本地文案池（dmgFlavors/missTexts/
  // enemyAttackFlavors），按伤害**绝对值**分四档，与伤势系统按
  // **比例**分档（combat/wound-effects.ts 的 calcSeverity）口径不一致——
  // 同样 6 点伤害，打 12 HP 和打 20 HP 的目标文案相同，但机制上一个是
  // 重伤一个是皮肉伤。已整体移除，统一改走 `llm/narrator.ts`
  // （CLI 那边一直在用的同一套：五档比例分级 + LLM 生成 + 模板兜底）。
  const enemyWeapon = "钳肢"; // 本文件是 Mi-Go 专属遭遇战，武器名不从模组数据读
  function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

  // ── 疲劳系统 ──
  const FATIGUE_THRESHOLDS = [
    { min: 0, label: "", skillPenalty: 0, penaltyDice: 0 },
    { min: 2, label: "  ⚠ 手臂开始发酸，动作不如之前灵活了。", skillPenalty: 0, penaltyDice: 0 },
    { min: 3, label: "  ⚠ 呼吸变得急促，准头开始下降。", skillPenalty: 10, penaltyDice: 0 },
    { min: 4, label: "  ⚠ 汗水模糊了视线，持枪的手微微发抖。", skillPenalty: 0, penaltyDice: 1 },
    { min: 5, label: "  ⚠ 体力严重透支，肌肉不受控制地颤抖！", skillPenalty: 0, penaltyDice: 2 },
  ];
  const fatigue: Record<string, number> = { [p0.shortName]: 0, [p1.shortName]: 0 };

  // 单名调查员攻击一次
  async function pcAttack(combatant: typeof pcCombatants[0]): Promise<number> {
    const { name, pc, fightingKey, firearmsKey } = combatant;
    const fightVal = (pc.skillValues as Record<string, number>)[fightingKey] ?? 25;
    const gunVal = (pc.skillValues as Record<string, number>)[firearmsKey] ?? 20;
    const usingGun = gunVal > fightVal && Math.random() > 0.3;
    const skillLabel = usingGun ? "射击(手枪)" : "格斗(肉搏)";
    const actionKey = `${name}_${usingGun ? "射击" : "格斗"}`;
    const actionText = pick(actionVariants[actionKey] ?? [usingGun ? "开枪射击！" : "冲了上去！"]);

    // 疲劳修正
    fatigue[name] = (fatigue[name] ?? 0) + 1;
    const f = FATIGUE_THRESHOLDS.slice().reverse().find(t => fatigue[name] >= t.min)!;
    const effectiveSkill = Math.max(5, (usingGun ? gunVal : fightVal) - f.skillPenalty);

    say(`${name}${fmt(actionText)}`);

    // ── 伤势惩罚骰 ──
    //
    // 这条路径原先直接调 `CoCEngine.skillCheck`，**绕过 `checks.ts` 的 `check()`**，
    // 于是身上的伤势在战斗攻击上一点作用都没有 —— 而「让伤势/惩罚骰那套机制
    // 在战斗里跑起来」正是敌人还手那次改动的目的。缺口是
    // `scripts/diag/diag-wounds.ts` 把惩罚骰按来源分账之后露出来的：
    // 「真被伤势罚到的检定」始终远少于「记下的伤势」。
    //
    // 不直接改用 `check()`：那会丢掉疲劳那一段播报（`(-10疲劳)` / `[惩罚骰×N]`），
    // 而疲劳与伤势是两个独立来源，合并显示就再也分不开了。
    // 所以只把伤势那一份取过来，两者分别标注，上限仍是 CoC 7e 的 2 颗。
    const woundDice = woundPenaltyOf(name);
    const totalPenalty = Math.min(2, f.penaltyDice + woundDice);
    // ⚠ 这里原先写死 `"hard"`，**没有任何注释说明为什么**。
    //   CoC 7e 里普通近战/射击掷的是**常规**难度（对手闪避/反击另掷，
    //   构成对抗），hard 是留给特殊情况的。用 hard 等于把每个人的战斗技能砍半：
    //   25% 的调查员实际只有 12%，实跑两局、十几次攻击**一次都没打中**。
    //
    //   这与「重伤必定流血」是同一类偏差：把规则改严了，却没在任何地方写明
    //   这是有意的设定。改回常规难度；真要提高战斗难度，
    //   该调的是敌人属性或环境惩罚骰，而不是偷偷把玩家的技能对折。
    //
    //   顺带：播报此前只印技能原值，玩家看到「71% → d100=55 → 失败」
    //   按规则怎么算都该是成功 —— 数值播报的意义就是让人能自己验算，
    //   印一个算不出结果的数比不印更糟。非常规难度时把实际阈值一并印出来。
    const diff = "regular" as const;
    const r = CoCEngine.skillCheck(effectiveSkill, diff, 0, totalPenalty);
    const threshold = diff === "regular" ? effectiveSkill : Math.floor(effectiveSkill / 2);
    const penaltyNote = totalPenalty > 0
      ? ` [惩罚骰×${totalPenalty}${f.penaltyDice > 0 && woundDice > 0 ? "·疲劳+伤势" : woundDice > 0 ? "·伤势" : "·疲劳"}]`
      : "";
    // 常规难度时技能值本身就是阈值，不必多印一个数；难度真变了再标出来。
    const diffNote = diff === "regular" ? "" : ` 困难→${threshold}`;
    sayMech(`➜ ${name} 【${skillLabel}】 ${effectiveSkill}%${f.skillPenalty > 0 ? `(-${f.skillPenalty}疲劳)` : ""}${diffNote}${penaltyNote} → d100=${r.roll} → ${SUCCESS_LEVEL_LABELS[r.successLevel]}`);
    emit({
      type: "check", actor: name, actorKind: "pc", skill: skillLabel,
      skillValue: effectiveSkill, envPenalty: f.penaltyDice, woundPenalty: woundDice,
      totalPenalty, ignoreWound: false, woundAware: true,
      roll: r.roll, success: r.isSuccess, level: r.successLevel,
    });

    if (r.isSuccess) {
      // 伤害：格斗 1d6，射击 1d8 + 暴击加成
      const dieMax = usingGun ? 8 : 6;
      let dmg = 1 + Math.floor(Math.random() * dieMax);
      if (r.successLevel === "critical") dmg += dieMax;
      else if (r.successLevel === "extreme") dmg += Math.floor(dieMax / 2);
      const willKill = migoHp - dmg <= 0;
      const narrative = await generateNarrativeWithLLM(runCtx.getStore()?.llmClient ?? null,
        name, enemyName, usingGun ? "左轮手枪" : "拳头",
        { hit: true, crit: r.successLevel === "critical", damage: dmg, result: willKill ? "kill" : "wound" },
        migoMaxHp,
      );
      say(`  ${narrative}（${dmg}点伤害）`);
      emit({ type: "pc-attack", actor: name, skill: skillLabel, success: true, damage: dmg });
      return dmg;
    } else {
      const narrative = await generateNarrativeWithLLM(runCtx.getStore()?.llmClient ?? null,
        name, enemyName, usingGun ? "左轮手枪" : "拳头",
        { hit: false, damage: 0, result: "miss" },
        migoMaxHp,
        { fumble: r.successLevel === "fumble" },
      );
      say(`  ${narrative}`);
      emit({ type: "pc-attack", actor: name, skill: skillLabel, success: false, damage: 0 });
      return 0;
    }
  }

  /**
   * 敌人还手一次，打其中一名调查员。
   *
   * 按 CoC 的对抗掷法：攻方掷格斗，守方掷闪避，闪避成功即完全避开。
   * 数值全部来自模组描述（格斗 55% / 1d6 / 每回合 1 次），不是编的。
   *
   * 伤害走 `applyDamage` —— 这样伤势分级、重伤体质检定、惩罚骰
   * 那一整套才会在战斗里生效。原先这套只在陷阱段跑得到。
   */
  async function enemyAttack(target: typeof pcCombatants[0]): Promise<void> {
    const { name, pc } = target;
    if (pc.hp <= 0) return; // 已经倒下的不再挨打

    say(`\n${enemyName}扑向了${name}！`);
    // actorKind="enemy"：播报出来是「➜ 米戈 【格斗】」，与玩家的
    // 「➜ 李默 【格斗(肉搏)】」只差技能名。把攻击者身份写进事件，
    // 判据就不必再从技能名反推——敌人技能改叫「触手」也不会漏。
    const atk = check(enemyStats.skill, enemyName, "格斗", "regular", 0, false, "enemy");
    if (!atk.isSuccess) {
      say(`  ${name}堪堪避开了。`);
      emit({ type: "enemy-attack", enemy: enemyName, target: name, outcome: "miss", damage: 0 });
      return;
    }

    // 守方闪避：CoC 里闪避是对抗掷，成功就完全避开
    const dodgeVal = (pc.skillValues as Record<string, number>)["dodge"]
      ?? Math.floor((pc.attributes.dexterity ?? 50) / 2);
    const dodge = check(dodgeVal, name, "闪避", "regular");
    if (dodge.isSuccess && dodge.successLevel <= atk.successLevel) {
      say(`  ${name}向侧面一滚，避了开去。`);
      emit({ type: "enemy-attack", enemy: enemyName, target: name, outcome: "dodged", damage: 0 });
      return;
    }

    const dmg = rollDice(enemyStats.damage);
    emit({ type: "enemy-attack", enemy: enemyName, target: name, outcome: "hit", damage: dmg });
    const narrative = await generateNarrativeWithLLM(runCtx.getStore()?.llmClient ?? null,
      enemyName, name, enemyWeapon,
      { hit: true, crit: atk.successLevel === "critical", damage: dmg, result: "wound" },
      pc.maxHp,
    );
    say(`  ${narrative}`);
    const severity = applyDamage(pc, name, dmg);

    // ⚠ 致命伤（≥75% 最大 HP）的**致残描写一直没人播**。
    //   `getDisability()` 里那几句（「右臂遭受毁灭性打击……武器从无力手指中滑落」）
    //   写好了却从来没有调用方，玩家从项目开始到现在一次都没见过 ——
    //   致命伤与普通重伤在播报上长得一模一样，只有 HP 数字不同。
    //   命中部位就用 CoC 的命中部位表掷。
    if (severity === "grievous") {
      const loc = rollHitLocation();
      const dis = getDisability(loc, severity);
      if (dis) {
        say(`  ${name}的${dis.impairment}`, "verbatim");
        if (dis.disarmed) say(`  ${name}的武器脱手了。`);
        else if (dis.knockdown) say(`  ${name}倒了下去。`);
      }
    }

    // 重伤要掷体质，跟陷阱那边同一套规则 —— 现在是字面意义上的同一个判据。
    // 阈值与「开不开重伤系统」由模组声明的规则集说了算（Pulp 之类可以整个关掉）。
    if (needsMajorWoundCheck(severity, pc.hp, activeHooks(module))) {
      const con = check(pc.attributes.constitution, name, "体质（重伤）", "regular", 0, true);
      if (!con.isSuccess) {
        say(`${name}因伤势过重昏迷过去！`);
        if (pc.hp > 0) emit({ type: "downed", who: name, cause: "major-wound-con" });
        pc.hp = 0;
      }
    }
  }

  let round = 0;
  const MAX_ROUNDS = 4;
  let miGoFled = false;

  while (migoHp > 0 && round < MAX_ROUNDS && !miGoFled) {
    round++;
    emit({ type: "combat-round", enemy: enemyName, round });
    if (round > 1) say(`\n── 第 ${round} 回合 ──`);

    // 调查员攻击 —— 倒下的人不出手（CoC 7e：0 HP 即失去意识）
    for (const combatant of pcCombatants) {
      if (migoHp <= 0) break;
      if (isDowned(combatant.pc)) continue;
      migoHp -= await pcAttack(combatant);
    }
    if (migoHp <= 0) break;

    // 显示调查员疲劳状态（从第2回合起）
    if (round >= 2) {
      const shown = new Set<string>();
      for (const { name, pc } of pcCombatants) {
        if (isDowned(pc)) continue; // 倒着的人没有"喘不上气"这回事
        const f = FATIGUE_THRESHOLDS.slice().reverse().find(t => fatigue[name] >= t.min)!;
        if (f.label && !shown.has(f.label)) {
          shown.add(f.label);
          say(`  ${name}：${f.label.trim()}`);
        }
      }
    }

    // 敌人还手。
    //
    // 原先这里只有 SAN 检定，注释却写着「反击」—— 敌人从头到尾不造成 HP 伤害，
    // 玩家整场 Boss 战掉不了一点血。现在按模组描述真的打回来，
    // SAN 检定保留（看着它本身就折磨理智）。
    for (let i = 0; i < enemyStats.times; i++) {
      // 打谁：优先还站着的，都站着就随机 —— 不刻意集火倒下的人
      const standing = pcCombatants.filter(x => x.pc.hp > 0);
      if (standing.length === 0) break;
      await enemyAttack(pick(standing));
    }

    say("");
    sanCheck(p0.shortName, san1, "0/1d3");
    sanCheck(p1.shortName, san2, "0/1d3");

    // 两人都倒下 → 战斗结束，走失败结局
    if (pcCombatants.every(x => x.pc.hp <= 0)) {
      say(`\n两名调查员都失去了意识。`);
      break;
    }

    // 显示米戈状态
    const hpPct = migoHp / migoMaxHp;
    const statusText = hpPct > 0.6 ? "甲壳完好，行动自如" : hpPct > 0.3 ? "甲壳多处碎裂，动作开始迟缓" : "浑身伤痕累累，踉跄后退";
    say(`\n[${enemyName} HP: ${migoHp}/${migoMaxHp} — ${fmt(statusText)}]`);

    // 米戈受伤过半时尝试逃跑
    if (hpPct <= 0.6 && round >= 2) {
      const fleeChance = 0.3 + (1 - hpPct) * 0.5;
      if (Math.random() < fleeChance) {
        miGoFled = true;
        break;
      }
    }
  }

  // ── 结局判定 ──
  say("");
  emit({
    type: "combat-end", enemy: enemyName,
    result: migoHp <= 0 ? "defeated" : miGoFled && migoHp < migoMaxHp * 0.4 ? "fled" : "lost",
  });
  if (migoHp <= 0) {
    // 击败：Mi-Go 重伤逃走，没带走大脑
    if (migoEncounter.victoryClueId) world.discoverClue(migoEncounter.victoryClueId);
    for (const line of migoEncounter.victoryLines) say(line, "verbatim");
  } else if (miGoFled && migoHp < migoMaxHp * 0.4) {
    // 打跑但没杀死：Mi-Go 自己逃走，没来得及带走大脑
    if (migoEncounter.victoryClueId) world.discoverClue(migoEncounter.victoryClueId);
    if (migoEncounter.fledLines) {
      for (const line of migoEncounter.fledLines) say(line, "verbatim");
    } else {
      say("敌人发出一声不甘的嘶叫，撞破通风管道独自逃走了。", "verbatim");
    }
    // 这一支大脑已经夺回来了，追上与否不改变线索状态 —— 但结局文案不同，
    // 「按住了它」和「让它跑了」不该印成同一句。
    if (chaseAfterFlight()) {
      say("它没能跑远。你们把它按在了地上。", "verbatim");
    }
  } else {
    // 完全失败：Mi-Go 带着大脑逃走 —— 但可以追。追上了就把它带走的东西夺回来。
    for (const line of migoEncounter.defeatLines) say(line, "verbatim");
    if (miGoFled && chaseAfterFlight() && migoEncounter.victoryClueId) {
      world.discoverClue(migoEncounter.victoryClueId);
    }
  }
  say(`${"═".repeat(48)}`);

  /**
   * 敌人逃跑之后追不追得上。
   *
   * 之前这里只印一句「撞破通风管道独自逃走了」就结束 ——
   * 而仓库里躺着 731 行写好的 CoC 追逐规则，一次都没跑过。
   *
   * 只有还站着的调查员能追：躺下的人显然追不了，
   * 让他们参与会把「全员倒地」也算成一次有效追逐。
   */
  function chaseAfterFlight(): boolean {
    // 名字与角色卡必须成对取 —— 散着拿最容易出的错就是错位（见 Cast 的注释）。
    // pcCombatants 已经把这一对绑好了。
    const able = pcCombatants.filter((x) => x.pc.hp > 0);
    if (able.length === 0) return false;

    const outcome = runChase(
      able.map((x) => ({
        name: x.name,
        con: x.pc.attributes.constitution,
        dex: x.pc.attributes.dexterity,
      })),
      { name: enemyName, con: enemyStats.skill, dex: enemyStats.skill },
      environmentFromScene(scene.name, scene.description ?? ""),
    );
    say(outcome.caught
      ? `\n你们在它彻底消失之前把它逼停了。`
      : `\n它消失在视野里。追不上了。`);
    return outcome.caught;
  }
}
}
