// 从 play-module.ts 抽出来的一段（脚本搬运，见 tools/_extract-block.ts）。
//
// 抽出来的理由是可寻址性：原先 runModuleInner 一个函数 2615 行、占全文件 74%，
// 里面按注释能切出近 30 个块，但没有一个是能整段读进来的单元 ——
// 每次改动只能靠行号开窗口猜，窄了缺上下文、宽了浪费。
//
// ⚠ 纯搬运，不改行为。判据是全量测试与主循环脚手架全绿。

import type { ModuleData, Scene } from "../module/types";
import type { WorldState } from "../world/state";
import { resolveCheckValue } from "../character/coc-character";
import { isDowned } from "./run-state";
import type { Cast, Cursor } from "./run-state";
import { say, sayMech, emit } from "./narration";
import { check, applyDamage, healWound, MAX_PENALTY_DICE } from "./checks";
import { rollDice, trapsInScene, attributeValue } from "./trap-util";
import { needsMajorWoundCheck, type WoundSeverity } from "../combat/wound-effects";
import { activeHooks } from "./ruleset";
import { isNightPeriod } from "../rules/game-time";

/**
 * 一次进场的陷阱结算。
 *
 * 与 npc-dialogue 不同，这一段是**真耦合**运行状态的：要两名调查员、world、
 * 当前场景，还有「哪些陷阱响过」与「这次轮到谁踩」。
 *
 * 参数按概念分组（`cast` / `cursor`）而不是平铺 —— 平铺过一版是 11 个散参数，
 * 每个都要读一遍才知道这函数碰什么。现在拿到 `cast` 就知道它动角色，
 * 拿到 `cursor` 就知道它参与循环推进。
 *
 * 内部仍用解构把名字还原成原闭包里的那些，于是循环体一个字都没改 ——
 * 搬运的正确性只取决于「参数是不是同一批东西」。
 */
export async function runSceneTraps(
  cast: Cast,
  world: WorldState,
  cursor: Cursor,
  module: ModuleData,
  scene: Scene,
): Promise<void> {
  // 原先还解构了 san1 / san2，而本文件**没有任何一处碰 SAN** ——
  // 陷阱不掷理智检定。战斗那边是掷的（combat.ts 的 sanCheck），
  // 陷阱致残要不要也掷是**设计决定**，不在这里顺手替它做，先把死绑定去掉。
  const { p0, p1, c1, c2 } = cast;
  const { triggeredTraps, stepCounter } = cursor;

for (const trapItem of trapsInScene(module.items, scene.id)) {
  if (triggeredTraps.has(trapItem.id) || stepCounter <= 0) continue;

  const mech = trapItem.trap!;
  // 事先发现就绕开了 —— 这是原先 support.trapClueId 的语义，现在按陷阱各自声明
  if (mech.detectedByClue && world.isClueFound(mech.detectedByClue)) continue;
  // 昏迷的人不会自己走进陷阱 —— 同伴多半是拖着他走的
  const walkers = [
    { pc: c1, name: p0.shortName },
    { pc: c2, name: p1.shortName },
  ].filter(x => !isDowned(x.pc));
  if (walkers.length === 0) continue; // 都倒下了，没人踩得中

  triggeredTraps.add(trapItem.id);
  const picked = walkers[stepCounter % walkers.length]!;
  const vName = picked.name;
  const pc = picked.pc;

  // 体型免疫：模组给结论不给理由，理由写在数据的 immuneNarration 里并记入 inferred
  if (mech.sizImmunityBelow !== undefined && (pc.attributes.size ?? 50) < mech.sizImmunityBelow) {
    say(`\n${vName}${mech.immuneNarration ?? `踩上了${trapItem.name}，却什么也没发生。`}`);
    continue;
  }

  // 事先发现检定：侦查/灵感检定，成功则发现陷阱并绕开
  if (mech.detect) {
    // 检查是否有特定背景可以用替代技能（如军事背景用灵感）
    const bgKeywords = ["军", "soldier", "military", "veteran", "army", "navy", "marine"];
    const hasMilitaryBg = bgKeywords.some(kw =>
      (pc.archetypeId?.toLowerCase() ?? "").includes(kw)
    );
    const useAlt = hasMilitaryBg && mech.detect.alternativeSkill;
    const skillName = useAlt ? mech.detect.alternativeSkill! : mech.detect.skill;
    const skillVal = resolveCheckValue(pc, skillName);

    if (skillVal > 0) {
      // `penaltyDice` 始终生效；`nightPenaltyDice` 只在共享游戏时钟的夜间额外生效。
      // 两者合并后复用 check()/CoC 的既有两枚上限，不在这里另造一套掷骰规则。
      // 惩罚骰不写进 label —— check() 自己会标，写这儿会打印两遍
      const penalty = Math.min(MAX_PENALTY_DICE,
        (mech.detect.penaltyDice ?? 0)
          + (isNightPeriod(cursor.gameTime.period) ? (mech.detect.nightPenaltyDice ?? 0) : 0));
      const label = `${skillName}（发现${trapItem.name}）`;
      const r = check(skillVal, vName, label, mech.detect.difficulty, penalty);
      if (r.isSuccess) {
        say(`\n${vName}${useAlt ? "凭着直觉感到危险" : "仔细观察后"}发现了前方的陷阱，小心绕开了。`);
        if (mech.detectedByClue) {
          world.discoverClue(mech.detectedByClue);
        }
        continue;
      }
    }
  }

  // 躲避：来得及闪开就完全无事，与"已经中招后挣脱"是两回事
  if (mech.avoid) {
    const label = `${mech.avoid.skill}（躲避${trapItem.name}）`;
    const a = check(attributeValue(pc.attributes, mech.avoid.skill), vName, label, mech.avoid.difficulty);
    if (a.isSuccess) {
      say(`\n${vName}察觉到不对，堪堪闪开了。`);
      continue;
    }
  }

  say(`\n${vName}${mech.triggerNarration ?? `触发了${trapItem.name}！`}`);

  let total = 0;
  let severity: WoundSeverity = "scratch";
  if (mech.damage) {
    total = rollDice(mech.damage);
    severity = applyDamage(pc, vName, total);
  }

  // ── 重伤体质检定（CoC 7e Major Wound）──
  // 判据统一走 needsMajorWoundCheck：够重 **且** 人还有意识。
  // 这里原先不看 HP，于是被打到 0 之后还会补掷一次，而下面挣脱与持续伤害
  // 那两处是看的 —— 同一条规则三种写法。
      if (needsMajorWoundCheck(severity, pc.hp, activeHooks(module))) {
    // ignoreWound：这一掷结算的就是这处伤，不能被它自己罚
    const conCheck = check(pc.attributes.constitution, vName, "体质（重伤）", "regular", 0, true);
    if (!conCheck.isSuccess) {
      say(`${vName}因伤势过重昏迷过去！`);
      // ⚠ 这条路径**没有 HP → 0 的播报**（HP 还有剩，人先倒了）。
      // 只认 `HP n → 0` 的判据在这里必然漏报。
      if (pc.hp > 0) emit({ type: "downed", who: vName, cause: "major-wound-con" });
      pc.hp = 0; // 昏迷状态
    }
  }

  // ── 挣脱检定（捕兽夹等）──
  //
  // ⚠ 昏迷的人不挣扎 —— CoC 7e：HP 归零即失去意识。
  // 这一条原先没有，于是「重伤体质检定失败 → 昏迷」之后紧接着就是
  // 「➜ 欧内斯特 【力量（挣脱捕兽夹）】」：躺着的人在用力掰铁齿。
  // 是 `scripts/diag/diag-downed.ts` 改用结构化事件之后报出来的（12 局 2 次），
  // 旧判据只认 `HP n → 0` 那一行，而这条路径**根本没有那一行**，所以看不见。
  let escaped = false;
  if (mech.escape && !isDowned(pc)) {
    const label = `${mech.escape.skill}（挣脱${trapItem.name}）`;
    const r = check(attributeValue(pc.attributes, mech.escape.skill), vName, label, mech.escape.difficulty);
    if (r.isSuccess) {
      say(`${vName}挣脱了出来。`);
      escaped = true;
    } else if (r.successLevel === "fumble" && mech.escape.fumbleDamage) {
      const extra = rollDice(mech.escape.fumbleDamage);
      say(`${vName}越挣扎，情况越糟。`);
      const extraSev = applyDamage(pc, vName, extra);
      total += extra;
      // 额外伤害也可能触发重伤
      if (needsMajorWoundCheck(extraSev, pc.hp, activeHooks(module))) {
        const conCheck2 = check(pc.attributes.constitution, vName, "体质（重伤）", "regular", 0, true);
        if (!conCheck2.isSuccess) {
          say(`${vName}因伤势过重昏迷过去！`);
          if (pc.hp > 0) emit({ type: "downed", who: vName, cause: "major-wound-con" });
          pc.hp = 0;
        }
      }
    } else {
      say(`${vName}一时挣不开，只能等同伴过来搭手。`);
    }
  }

  // ── 持续伤害（硫酸等）──
  // 没有 escape 或者 escape 失败都会触发 ongoing
  if (mech.ongoing && !escaped && pc.hp > 0) {
    const tick = rollDice(mech.ongoing.damage);
    const tickSev = applyDamage(pc, vName, tick);
    total += tick;
    sayMech(`${trapItem.name}持续造成伤害，直到${mech.ongoing.until}。`);

    // 急救知识检定：化学/医学/科学才知道怎么救
    // 不是每个人都知道硫酸要用水冲
    //
    // ⚠ 施救的是**同伴**，同伴自己躺着就没人能救 —— 与 `tryReviveDowned`
    // 里那条 `if (isDowned(mate)) continue` 是同一条规则，这里原先漏了。
    // `scripts/diag/diag-downed.ts` 报出来的另外 2 次违规就是它：
    // 「➜ 亨利 【化学（判断急救方式）】」「➜ 亨利 【急救】」，而亨利此刻 HP 为 0。
    const partner = pc === c1 ? c2 : c1;
    if (mech.firstAid && !isDowned(partner)) {
      const partnerName = pc === c1 ? p1.shortName : p0.shortName;
      // 优先检定化学，其次医学
      const chemVal = resolveCheckValue(partner, "化学");
      const medVal = resolveCheckValue(partner, "医学");
      const useSkill = chemVal >= medVal ? "化学" : "医学";
      const useVal = Math.max(chemVal, medVal);
      if (useVal > 0) {
        const knowCheck = check(useVal, partnerName, `${useSkill}（判断急救方式）`, "regular");
        if (knowCheck.isSuccess) {
          sayMech(`${partnerName}知道应该${mech.firstAid}！`);
          // 急救检定
          const faVal = resolveCheckValue(partner, "急救");
          if (faVal > 0) {
            const faCheck = check(faVal, partnerName, "急救", "regular");
            if (faCheck.isSuccess) {
              say(`${partnerName}迅速${mech.firstAid}，阻止了持续伤害。`);
              // 伤口处理掉了 → 撤掉伤势惩罚骰
              healWound(vName);
              sayMech(`${vName} 伤势得到处理，惩罚骰解除。`);
            } else {
              say(`${partnerName}尝试急救但没能完全控制住情况。`);
              // 失败也扣一次持续伤害
              if (pc.hp > 0) {
                const tick2 = rollDice(mech.ongoing.damage);
                applyDamage(pc, vName, tick2);
                total += tick2;
              }
            }
          }
        } else {
          say(`${partnerName}不知道该怎么处理这种伤势……`);
        }
      }
    }

    // 持续伤害也可能触发重伤
      if (needsMajorWoundCheck(tickSev, pc.hp, activeHooks(module))) {
      const conCheck3 = check(pc.attributes.constitution, vName, "体质（重伤）", "regular", 0, true);
      if (!conCheck3.isSuccess) {
        say(`${vName}因伤势过重昏迷过去！`);
        if (pc.hp > 0) emit({ type: "downed", who: vName, cause: "major-wound-con" });
        pc.hp = 0;
      }
    }
  }

  if (total > 0 && mech.maimAtHpRatio !== undefined && total > Math.floor(pc.maxHp * mech.maimAtHpRatio)) {
    const ratioLabel = mech.maimAtHpRatio === 0.5 ? "半值" : `${mech.maimAtHpRatio} 倍`;
    sayMech(`${vName} 单次伤害 ${total} 点，超过耐久${ratioLabel} —— 有截肢风险。`);
  }

  // 一次进场最多真正踩中一个陷阱。
  //
  // 常理约束：铁齿咬住小腿之后，人不会在同一瞬间又走进下一根拌锁绳——
  // 会停下、会喊人、会开始一寸寸看脚下。放开这条，实跑里出现过
  // 「HP 10 → 6 → 0」两个陷阱连响把调查员直接打昏的序列。
  // 没踩中的陷阱不记入 triggeredTraps，下次再进这个场景仍然在等着。
  break;
}
}

