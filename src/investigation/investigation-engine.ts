// 调查系统运行时 — 多技能路径评估引擎
// 从 investigation_system.yaml 加载线索定义，执行多路径检定
//
// 核心设计：
//   Primary 检定 → 核心线索（成功）/ 受限信息（失败）
//   Secondary 检定 → 补充信息 + Primary 加成
//   Combined Threshold → 3 技能覆盖 → 不投骰自动完整揭示
//   Fallback → 全部失败 → 触发预设"新线索浮现"，不靠 LLM 编造

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { CoCEngine, type CoCSuccessLevel } from "../rules/coc-engine";
import type { RuleEngine } from "../engine/rule-engine";

import type { DifficultyProfile } from "../rules/module-difficulty";
import type { WorldStateManager } from "../state/world-state-manager";
import { log } from "../log";

// ============================================================
// YAML 类型
// ============================================================

interface ClueCheckDef {
  skill: string;
  success?: string;
  critical?: string;
  fail?: string;
  effect?: string;          // 辅助检定的效果描述
}

interface CoCClueCheckDef {
  skill: string;            // CoC 标准技能名（如 occult, spot_hidden, library_use）
  regular?: string;         // 常规成功
  hard?: string;            // 困难成功
  extreme?: string;         // 极限成功
  critical?: string;        // 大成功
  fail?: string;            // 失败
  effect?: string;
}

interface ClueDef {
  description: string;       // 线索外观描述
  primary: ClueCheckDef;
  secondary: ClueCheckDef[];
  /** CoC 专属检定（覆盖 primary/secondary 的 D&D 设定） */
  coc_primary?: CoCClueCheckDef;
  coc_secondary?: CoCClueCheckDef[];
  combined_threshold?: {
    three_skills?: string;
    [key: string]: string | undefined;
  };
  /** 如果调查该线索会触发 SAN 损失，格式 "0/1d6" */
  san_cost?: string;
  /** 该线索关联的场景（进入场景时自动提示可调查） */
  scene?: string;
  /**
   * 供玩家输入匹配用的候选文本（线索名 + 各条 findMethods 的位置/动作描述，
   * 如"侦查卫生间/仔细检查洗漱用具"）。桥接层（bridgeBarnOfPremierClues）
   * 从原始模组数据里取，同场景多条未发现线索时用它区分玩家具体想找哪个——
   * 见 game-session.ts 的 resolveSceneClueMatch()。不设置时（YAML 里手写的
   * 线索、registerSceneClue 合成的旧线索）该线索不参与按文本匹配，回落到
   * 旧行为（同场景只有它一条候选时直接给出，多条候选时排在最后）。
   */
  matchTexts?: string[];
  /** 线索的展示名（如"毒品"），供消歧提示"你是指 A 还是 B"里给出人话名字 */
  displayName?: string;
  /**
   * 线索优先级（core=主线必得/bonus=加分/color=氛围向）。当前只存起来，
   * 未消费——留给后续"新手辅助"功能用（如提示玩家优先查 core 线索）。
   */
  importance?: "core" | "bonus" | "color";
  /**
   * 发现本线索后解锁的线索 id（模组数据自带的前置关系，如
   * clue_bedroom_diary.unlocks = ["clue_bedroom_old_doc"]）。
   *
   * 开发·卧室线索修复 任务①：这份数据此前只喂给 world/state.ts 的剧本杀
   * 路径（discoverClue() 用它做"一级自动连锁"——发现 A 自动带发现 B），
   * GameSession/InvestigationEngine 这条自由跑团路径从未读过它，桥接层
   * （bridgeBarnOfPremierClues）此前直接把这个字段丢在地上。
   *
   * 这里只复用"谁依赖谁"这份关系数据本身，不复用 state.ts 的自动连锁
   * 行为——见 isLockedByUndiscoveredPrerequisite() 的说明：只用来算
   * "前置未发现时不进候选集"，不会在玩家找到 A 时顺手把 B 也标记发现。
   * 自动连锁会让任何摸到日记的人自动读懂米-戈联络术，抹平 Good/True End
   * 的分界，还白拿一次该扣 SAN 的法术。
   */
  unlocks?: string[];
}

interface ClueTypesYAML {
  investigation_system: {
    clue_types: Record<string, ClueDef>;
  };
}

// ============================================================
// 结果类型
// ============================================================

interface CheckResult {
  skill: string;
  skillName: string;         // 中文技能名
  roll: number;               // 骰子结果
  dc: number;                 // 目标 DC
  success: boolean;
  critical: boolean;          // 自然 20 / 大成功
  result_text: string;        // 结果描述文本
  bonus_effect?: string;      // 此检定给 Primary 的加成
  bonus_type?: "advantage" | "dc_reduction" | "skill_bonus";
  bonus_value?: number;
}

interface InvestigationResult {
  clue_id: string;
  clue_description: string;
  primary_result: CheckResult | null;
  secondary_results: CheckResult[];
  combined_triggered: boolean;
  final_revelation: string;  // 最终给玩家的文本
  is_critical: boolean;      // 是否获得完整揭示
  fallback_triggered: boolean;
}

// ============================================================
// 技能名映射（中文 → 标准化）
// ============================================================

const SKILL_MAP: Record<string, { en: string; zh: string }> = {
  history:       { en: "history", zh: "历史" },
  art:           { en: "art", zh: "艺术" },
  appraise:      { en: "appraise", zh: "估价" },
  occult:        { en: "occult", zh: "神秘学" },
  chemistry:     { en: "chemistry", zh: "化学" },
  medicine:      { en: "medicine", zh: "医学" },
  spot_hidden:   { en: "spot_hidden", zh: "侦查" },
  psychology:    { en: "psychology", zh: "心理学" },
  science_chemistry: { en: "science_chemistry", zh: "化学(科学)" },
  library_use:   { en: "library_use", zh: "图书馆利用" },
  education:     { en: "education", zh: "教育" },
  persuade:      { en: "persuade", zh: "说服" },
  stealth:       { en: "stealth", zh: "潜行" },
  perception:    { en: "perception", zh: "察觉" },
  investigation: { en: "investigation", zh: "调查" },
};

// ============================================================
// 引擎
// ============================================================

export class InvestigationEngine {
  private clueTypes: Map<string, ClueDef> = new Map();
  /**
   * 已被发现的线索的**进程内后备存储**（clue_id → Set<player_name>）。
   *
   * 只在没有挂 `world` 时使用——独立测试/CLI 场景下这个引擎自成一体，
   * 没有另一份真相源可言，谈不上"两处各写一份"。一旦挂了 `world`
   * （见 constructor 的第二个参数），这份 Map 整个不再被读写，
   * 发现记录**只**落 `WorldStateManager` 的 `clue_discoveries` 表——
   * 真相只在库里一处，不接受"真相源做投影、这里仍是真相"。
   */
  private discovered: Map<string, Set<string>> = new Map();
  /** 玩家已尝试过的技能（clue_id_skill → tried） */
  private attemptedSkills: Set<string> = new Set();
  /** 场景 → 线索列表（场景关联线索） */
  private sceneClues: Map<string, string[]> = new Map();
  /** 当前模组难度画像（影响 DC 和失败产出） */
  private difficultyProfile: DifficultyProfile | null = null;
  /**
   * 挂了就是真相源；不挂就用上面的进程内 Map。
   * `GameSession`/CLI（`src/index.ts`）传自己的 `world`；单测多数不传，
   * 测的是这个引擎自身的多技能路径/YAML 解析逻辑，与真相源迁移无关。
   */
  private readonly world: WorldStateManager | null;

  constructor(yamlPath: string = "./src/rules/investigation.yaml", world?: WorldStateManager) {
    this.world = world ?? null;
    this.load(yamlPath);
  }

  /** 设置当前难度画像（模组加载时调用） */
  setDifficultyProfile(profile: DifficultyProfile | null): void {
    this.difficultyProfile = profile;
  }

  /** 获取当前难度画像（若无则返回默认 medium 参数） */
  private get effectiveProfile() {
    return this.difficultyProfile ?? {
      label: "medium" as const,
      penaltyDice: 0,
      clueOnFail: "minimal" as const,
      pushCostMultiplier: 1.5,
      pushAllowed: true,
      sanMultiplier: 1,
      failureGuidance: "你仔细搜索了每个角落，但一无所获。",
      description: "标准难度",
    };
  }

  private load(path: string) {
    try {
      const raw = readFileSync(path, "utf-8");
      const data = parseYaml(raw) as ClueTypesYAML;
      if (data?.investigation_system?.clue_types) {
        for (const [key, clue] of Object.entries(data.investigation_system.clue_types)) {
          this.clueTypes.set(key, clue);
          // 填充场景关联
          if (clue.scene) {
            const list = this.sceneClues.get(clue.scene) ?? [];
            list.push(key);
            this.sceneClues.set(clue.scene, list);
          }
        }
      }
    } catch (err) {
      log.warn("investigation", `调查系统 YAML 加载失败: ${(err as Error).message}`);
    }
  }

  /** 列出已加载的线索类型 */
  listClueTypes(): string[] {
    return [...this.clueTypes.keys()];
  }

  /** 动态注册一个线索类型（用于故事生成器/模组） */
  addClueType(id: string, def: Partial<ClueDef> & { description: string }): void {
    this.clueTypes.set(id, {
      description: def.description,
      primary: def.primary ?? { skill: "侦查", success: "你发现了线索。" },
      secondary: def.secondary ?? [],
      coc_primary: def.coc_primary ?? {
        skill: "spot_hidden", regular: "你发现了线索。", hard: "你发现了关键细节。",
        extreme: "你发现了隐蔽的信息。", critical: "你掌握了一切信息。",
      },
      coc_secondary: def.coc_secondary ?? [],
      san_cost: def.san_cost,
      scene: def.scene,
      matchTexts: def.matchTexts,
      displayName: def.displayName,
      importance: def.importance,
      unlocks: def.unlocks,
    });
    if (def.scene) {
      const list = this.sceneClues.get(def.scene) ?? [];
      if (!list.includes(id)) {
        list.push(id);
        this.sceneClues.set(def.scene, list);
      }
    }
  }

  /** 是否有匹配的线索类型 */
  hasClueType(type: string): boolean {
    return this.clueTypes.has(type);
  }

  /**
   * 取线索的匹配信息（供玩家输入按文本匹配用，见 clue-match.ts）。
   * 没有 matchTexts 的线索（YAML 手写/registerSceneClue 合成）返回 null——
   * 调用方据此知道这条线索不参与按文本匹配，不是"匹配失败"。
   */
  getClueMatchInfo(id: string): { matchTexts: string[]; displayName: string } | null {
    const clue = this.clueTypes.get(id);
    if (!clue || !clue.matchTexts || clue.matchTexts.length === 0) return null;
    return { matchTexts: clue.matchTexts, displayName: clue.displayName ?? id };
  }

  /**
   * 这条线索是不是 core（主线必得）——failback 阶梯（开发·线索闸门
   * 任务4）只对 core 线索生效，与剧本杀路径 clue-check.ts 的
   * `clue.importance === "core"` 同一判据。不存在的线索一律 false。
   */
  isCoreClue(id: string): boolean {
    return this.clueTypes.get(id)?.importance === "core";
  }

  /**
   * 这条线索是否被某条【尚未被该玩家发现】的线索通过 unlocks 声明为前置
   * 依赖（开发·卧室线索修复 任务①）。
   *
   * 背景：clue_bedroom_diary.unlocks 里有 clue_bedroom_old_doc，且
   * old_doc 的展示名/findMethods 文本（"老旧文件（米-戈联络术）"/"从日记本
   * 中取出老旧文件"）与 diary 的文本（"日记本与老旧文件"）高度重叠——
   * uniqueAbbrevs 找不出"日记""文件"这类短唯一片段，逼出"日记本与"这种
   * 没人会说的碎片，自然句因此被 clue-match.ts 判 deny。old_doc 在叙事上
   * 本就该在 diary 之后才拿到（模组原文写的是"从日记本中取出老旧文件"），
   * 让它提前跟 diary 一起抢候选位置本身就不对。
   *
   * 只做前置门（候选集过滤），不做自动连锁（state.ts:discoverClue 那种
   * "发现 A 自动发现 B"）——这两件事分开是有意的，见 ClueDef.unlocks 的
   * 说明：clue_bedroom_old_doc 是 Good End / True End 的分界线
   * （BARN_OF_PREMIER 的 END_NARRATIONS 用 excludeClues 排除它），自动连锁
   * 会让任何摸到日记的人自动读懂米-戈联络术，把两个结局的区别抹平，还会
   * 白送一次该扣 SAN 的法术。
   *
   * 全表扫描（clueTypes 目前 30+ 条，遍历一次的开销可以忽略）：找出所有
   * unlocks 里含 id 的线索，只要其中任意一条对 playerName 还没发现，
   * 就判定为"被锁住"。没有任何线索把它列为 unlocks 时，天然不锁。
   */
  isLockedByUndiscoveredPrerequisite(id: string, playerName: string): boolean {
    for (const [otherId, def] of this.clueTypes) {
      if (otherId === id) continue;
      if (!def.unlocks?.includes(id)) continue;
      if (!this.isDiscoveredBy(otherId, playerName)) return true;
    }
    return false;
  }

  /**
   * 当前模组范围内的线索 id（开发·线索闸门 任务3）——供"这个模组算不算
   * 前期"这类需要知道线索总量的上层判定使用，不暴露 ClueDef 内部结构。
   *
   * ⚠ 不能直接列 `clueTypes` 全表：那张表是**全局**的，混着
   * `investigation.yaml` 自带的几条通用/演示线索（scene 是"地下室"/
   * "书房"/"客厅"，不属于任何已加载模组），把它们算进分母会让比例
   * 完全失真——实测：ARKHAM 只有 3 条线索，混进演示线索后分母变成 8，
   * 发现 1 条只是 1/8 而不是 1/3，"前期"永远判不完。
   *
   * 改按"关联到世界里已注册场景"的线索取并集——挂了 `world` 时，遍历
   * 它注册过的全部场景、把每个场景下的线索 id 合起来，天然只包含当前
   * 加载的这个模组的线索（演示线索关联的场景压根不在这个模组的场景表
   * 里，不会被并进来）。没挂 `world`（独立引擎/单测，见 constructor 的
   * 第二个参数）时退回旧行为：列 `clueTypes` 全表——这种用法本来就是在
   * 测引擎自身，不涉及"当前模组"这个概念。
   *
   * `onlyWithMatchTexts` 时进一步只留能参与文本匹配的那批（谷仓桥接过的
   * 32 条）；YAML 手写线索与 registerSceneClue 合成的旧线索（如
   * premiers_barn.ts 自带的 clue_0..9）没有 matchTexts，本来就只能靠
   * fallback 拿到，不该被算进"总量"——调用方决定分母用哪一批。
   */
  listModuleClueIds(opts: { onlyWithMatchTexts?: boolean } = {}): string[] {
    const ids = this.world
      ? [...new Set(this.world.listScenes().flatMap((s) => this.getSceneClues(s.id)))]
      : [...this.clueTypes.keys()];
    if (!opts.onlyWithMatchTexts) return ids;
    return ids.filter((id) => (this.clueTypes.get(id)?.matchTexts?.length ?? 0) > 0);
  }

  /**
   * 执行一次调查检定
   * @param clueType 线索类型（匹配 YAML key）
   * @param playerSkills 当前玩家的技能值 Map（skill_name → 0-100）
   * @param availableAllies 在场的 NPC 名列表（用于组合阈值判断）
   * @param playerName 当前玩家名（用于可见性追踪）
   * @param ruleEngine 律书引擎
   */
  investigate(
    clueType: string,
    playerSkills: Record<string, number>,
    _availableAllies: string[],
    playerName: string,
    ruleEngine: RuleEngine
  ): InvestigationResult {
    const clue = this.clueTypes.get(clueType);
    if (!clue) {
      return {
        clue_id: clueType,
        clue_description: "你试图调查，但不清楚该看什么。",
        primary_result: null,
        secondary_results: [],
        combined_triggered: false,
        final_revelation: "你没有找到有用的线索。",
        is_critical: false,
        fallback_triggered: false,
      };
    }

    const primarySkill = clue.primary.skill;
    const playerSkillValue = playerSkills[primarySkill] ?? 20; // 默认 20%
    const secondaryResults: CheckResult[] = [];
    const secondarySkills: string[] = [];

    // ── Phase 1: 辅助检定（secondary skills）──
    // 玩家不一定需要投所有辅助——只投有技能值的
    let primaryBonus = 0;
    let hasAdvantage = false;
    let dcReduction = 0;

    for (const sec of clue.secondary) {
      const secValue = playerSkills[sec.skill] ?? 0;
      if (secValue > 0) {
        secondarySkills.push(sec.skill);
        const dc = this.skillDC(secValue, "secondary");
        const roll = ruleEngine.roll("1d20");
        const success = roll + Math.floor((secValue - 10) / 2) >= dc;

        const check: CheckResult = {
          skill: sec.skill,
          skillName: SKILL_MAP[sec.skill]?.zh ?? sec.skill,
          roll,
          dc,
          success,
          critical: roll === 20,
          result_text: success
            ? `你运用${SKILL_MAP[sec.skill]?.zh ?? sec.skill}知识发现了额外信息`
            : `你的${SKILL_MAP[sec.skill]?.zh ?? sec.skill}知识不足以帮上忙`,
        };

        if (success) {
          // 解析 effect 中的加成
          const effect = sec.effect ?? "";
          if (effect.includes("+10%") || effect.includes("10%")) {
            primaryBonus += 10;
            check.bonus_type = "skill_bonus";
            check.bonus_value = 10;
          }
          if (effect.includes("奖励骰")) {
            hasAdvantage = true;
            check.bonus_type = "advantage";
          }
          if (effect.includes("-10%") || effect.includes("-15%")) {
            const reduction = effect.includes("-15%") ? 15 : 10;
            dcReduction += reduction;
            check.bonus_type = "dc_reduction";
            check.bonus_value = reduction;
          }
        }

        secondaryResults.push(check);
        this.attemptedSkills.add(`${clueType}_${sec.skill}`);
      }
    }

    // ── Phase 2: 组合阈值检查 ──
    const totalSkillsCovered = secondarySkills.length + (playerSkillValue > 0 ? 1 : 0);
    let combinedTriggered = false;

    if (clue.combined_threshold?.three_skills && totalSkillsCovered >= 3) {
      combinedTriggered = true;
      this.markDiscovered(clueType, playerName);
      return {
        clue_id: clueType,
        clue_description: clue.description,
        primary_result: null,
        secondary_results: secondaryResults,
        combined_triggered: true,
        final_revelation: clue.combined_threshold.three_skills!,
        is_critical: true,
        fallback_triggered: false,
      };
    }

    // ── Phase 3: Primary 检定 ──
    const effectiveSkill = Math.min(100, playerSkillValue + primaryBonus);
    const baseDC = this.skillDC(effectiveSkill, "primary");
    const finalDC = Math.max(5, baseDC - dcReduction);

    const primaryRoll = hasAdvantage ? ruleEngine.rollWithAdvantage().result : ruleEngine.roll("1d20");
    const abilityMod = Math.floor((effectiveSkill - 10) / 2);
    const total = primaryRoll + abilityMod;
    const primarySuccess = total >= finalDC;
    const primaryCritical = primaryRoll === 20;

    const primaryCheck: CheckResult = {
      skill: primarySkill,
      skillName: SKILL_MAP[primarySkill]?.zh ?? primarySkill,
      roll: primaryRoll,
      dc: finalDC,
      success: primarySuccess,
      critical: primaryCritical,
      result_text: "",
    };

    // ── Phase 4: 结果文本 ──
    let finalRevelation: string;
    let isCritical = false;

    if (primaryCritical && clue.primary.critical) {
      finalRevelation = clue.primary.critical;
      isCritical = true;
    } else if (primarySuccess && clue.primary.success) {
      finalRevelation = clue.primary.success!;
      isCritical = false;
    } else if (clue.primary.fail) {
      finalRevelation = clue.primary.fail;
    } else {
      finalRevelation = "你没有找到有用的信息。";
    }

    // ── Phase 5: 全部失败 → 触发 fallback ──
    let fallbackTriggered = false;
    if (!primarySuccess && secondaryResults.every((r) => !r.success) && !combinedTriggered) {
      fallbackTriggered = true;
      finalRevelation += "\n\n（系统：你感觉这里还有更多线索——或许需要从不同的角度重新审视。）";
    }

    primaryCheck.result_text = finalRevelation;
    this.attemptedSkills.add(`${clueType}_${primarySkill}`);

    if (isCritical || primarySuccess) {
      this.markDiscovered(clueType, playerName);
    }

    return {
      clue_id: clueType,
      clue_description: clue.description,
      primary_result: primaryCheck,
      secondary_results: secondaryResults,
      combined_triggered: combinedTriggered,
      final_revelation: finalRevelation,
      is_critical: isCritical,
      fallback_triggered: fallbackTriggered,
    };
  }

  /** 标记玩家已发现某个线索 */
  markDiscovered(clueType: string, playerName: string) {
    if (this.world) {
      this.world.recordClueDiscovery(playerName, clueType);
      return;
    }
    if (!this.discovered.has(clueType)) {
      this.discovered.set(clueType, new Set());
    }
    this.discovered.get(clueType)!.add(playerName);
  }

  /** 玩家是否已发现某个线索 */
  isDiscoveredBy(clueType: string, playerName: string): boolean {
    if (this.world) return this.world.isClueDiscoveredBy(playerName, clueType);
    return this.discovered.get(clueType)?.has(playerName) ?? false;
  }

  /** 获取所有已发现线索 */
  getDiscoveredBy(playerName: string): string[] {
    if (this.world) return this.world.getCluesDiscoveredBy(playerName);
    const result: string[] = [];
    for (const [clue, players] of this.discovered) {
      if (players.has(playerName)) result.push(clue);
    }
    return result;
  }

  /** 重置某线索的尝试记录（用于回滚/重试）。挂了 world 时目前不支持撤销发现记录——调用方只在测试里用过，真相源没有"撤销一次发现"的写入方法。 */
  resetAttempts(clueType: string) {
    for (const key of this.attemptedSkills) {
      if (key.startsWith(`${clueType}_`)) this.attemptedSkills.delete(key);
    }
    if (!this.world) this.discovered.delete(clueType);
  }

  // ==========================================================
  // 场景关联线索
  // ==========================================================

  /** 获取某场景下所有可用的线索 ID */
  getSceneClues(sceneName: string): string[] {
    return this.sceneClues.get(sceneName) ?? [];
  }

  /** 获取某场景下尚未被发现的线索 ID */
  getUndiscoveredSceneClues(sceneName: string, playerName: string): string[] {
    const all = this.getSceneClues(sceneName);
    return all.filter((id) => !this.isDiscoveredBy(id, playerName));
  }

  /** 线索描述映射（clueType → 描述文本） */
  clueDescriptions: Map<string, string> = new Map();

  /**
   * 注册场景线索（供 MythosModule 使用）。
   *
   * 带上描述时会顺便合成一份最小 ClueDef，否则这条线索对 investigateCoC 不可解析
   * ——它只认 clueTypes 里的定义，查不到就返回兜底失败「你没有找到有用的线索」。
   * 模组每条线索本来就写了 description 和 sanCost，缺的只是把它们变成定义这一步。
   *
   * 合成版只有一条 spot_hidden 路径、各成功层级共用模组给的那句描述——模组没有
   * 分层文本可用。因此已有同名定义时不覆盖：yaml 版带多技能路径与分层文本，
   * 换成一句话是数据丢失。
   */
  registerSceneClue(sceneName: string, clueType: string, description?: string, sanCost?: string) {
    const list = this.sceneClues.get(sceneName) ?? [];
    if (!list.includes(clueType)) {
      list.push(clueType);
      this.sceneClues.set(sceneName, list);
    }
    if (description) {
      this.clueDescriptions.set(clueType, description);
      if (!this.clueTypes.has(clueType)) {
        this.addClueType(clueType, {
          description,
          san_cost: sanCost,
          scene: sceneName,
          coc_primary: {
            skill: "spot_hidden",
            regular: description,
            hard: description,
            extreme: description,
            critical: description,
            // 只改措辞，不改判定：这是"检定失败"（找对了地方，骰子没过），要和
            // "匹配不上"（game-session.ts 的「这里没什么特别的」——玩家说的
            // 提示压根对不上场景里任何一条线索）分开，别让两种不同的"没找到"
            // 读起来一模一样。
            fail: "你仔细搜查了一番，但这次没能看出什么名堂。",
          },
        });
      }
    }
  }

  // ==========================================================
  // CoC 7e 调查检定
  // ==========================================================

  /**
   * CoC 7e 风格调查 — 使用 CoCEngine.skillCheck + 成功层级。
   *
   * `overrideSkill`（开发·线索闸门 任务4）：failback 阶梯的"灵感检定"/
   * "无副作用重试"两档要检的技能值不是这条线索自己声明的 coc_primary
   * 技能——前者是智力（灵感），后者是同一个技能但不走"孤注一掷"那套逻辑。
   * 传了就整体替换 skillName/skillValue，其余（revelation 按成功层级选、
   * SAN 处理、markDiscovered）照旧复用同一份逻辑，不重复实现一遍。
   * `pushed` 原样转发给 `CoCEngine.skillCheck`（默认 false，与不传时的
   * 既有行为一致）——调用方靠这个字段拿到的 `CoCCheckResult.pushed`
   * 机器验证"这次重试没有被算成孤注一掷"。`forceSuccess` 是阶梯最后一档
   * ("直接给")：完全不掷骰（`roll` 恒为 0，可与真实投骰 1-100 区分），
   * 直接按 regular 成功层级给揭示文本，SAN 仍按 regular 那一侧计——"直接
   * 给"给的是"终于找到了"，不是"侥幸大成功"，不该按更重的失败档扣 SAN。
   * @returns 带有 CoC 层级信息的结果
   */
  investigateCoC(
    clueType: string,
    playerSkills: Record<string, number>,
    playerName: string,
    overrideSkill?: { id: string; value: number; pushed?: boolean; forceSuccess?: boolean },
    percentileTargetModifier?: (baseTarget: number) => number,
  ): {
    success: boolean;
    // 这里原本写的是 string。值本来就来自 CoCEngine 的成功层级，放宽成 string
    // 只是让调用方拿它去索引 Record<CoCSuccessLevel, string> 时失去检查。
    successLevel: CoCSuccessLevel;
    revelation: string;
    sanLost: number;
    sanCost: string;
    clue: ClueDef | null;
    roll: number;
    skillValue: number;
    /**
     * 这次检定用的技能 id（如 "spot_hidden"）。调用方（resolveSceneClue）
     * 失败时要播一条"🎲 xx检定 d100=61 (目标=25%) → 失败"——线索路此前
     * 四个分支全部提前 return，够不到通用检定路的那句骰子播报，玩家看不出
     * "这次没找到"是掷骰子输了还是这里压根没东西。播报要报"哪个技能"，
     * 单靠 roll/skillValue 报不出来，加这个字段。
     */
    skillId: string;
    /** 是否为推动检定（transmitted from CoCEngine.skillCheck）——failback 阶梯的"无副作用重试"靠它验证自己没有被算成孤注一掷。 */
    pushed: boolean;
    /** 燃运消耗的点数——同上，验证"无副作用"没有偷偷烧运气。不传 luckSpend 参数，这里恒为 0。 */
    luckSpent: number;
  } {
    const clue = this.clueTypes.get(clueType);
    if (!clue) {
      return { success: false, successLevel: "fail", revelation: "你没有找到有用的线索。", sanLost: 0, sanCost: "", clue: null, roll: 0, skillValue: 0, skillId: "", pushed: false, luckSpent: 0 };
    }

    // 如果已发现，返回重看但不重复 SAN
    const alreadyDiscovered = this.isDiscoveredBy(clueType, playerName);

    // 选择 CoC 优先的检定定义
    const primary = clue.coc_primary ?? {
      skill: clue.primary.skill,
      regular: clue.primary.success,
      hard: clue.primary.success,
      extreme: clue.primary.critical,
      critical: clue.primary.critical,
      fail: clue.primary.fail,
    };

    const skillName = overrideSkill?.id ?? primary.skill;
    const baseSkillValue = overrideSkill?.value ?? (playerSkills[skillName] ?? 20);
    // A deterministic grant remains a no-roll grant. Idea and ordinary clue
    // checks remain active percentile checks and use the caller's modifier.
    const skillValue = overrideSkill?.forceSuccess
      ? baseSkillValue
      : (percentileTargetModifier ? percentileTargetModifier(baseSkillValue) : baseSkillValue);
    const profile = this.effectiveProfile;

    // CoC skillCheck —— 加入难度导致的惩罚骰。不传 luckSpend（第 5 参，
    // 恒为 0）——investigateCoC 从不烧运气，那是 handleAttack 战斗路的
    // 机制。pushed 原样转发 overrideSkill?.pushed（不传时 CoCEngine 自己
    // 默认 false），失败阶梯的"无副作用重试"靠这个字段回传 false 证明
    // 自己没有被算成孤注一掷。forceSuccess 时完全不掷骰——`roll` 恒为 0，
    // 与真实投骰（1-100）在结果里就能区分开，不用另开一个字段。
    const check = overrideSkill?.forceSuccess
      ? { roll: 0, successLevel: "regular" as CoCSuccessLevel, pushed: false, luckSpent: 0 }
      : CoCEngine.skillCheck(skillValue, "regular", 0, profile.penaltyDice, 0, overrideSkill?.pushed);
    const sl = check.successLevel;

    // 根据成功层级选择文本
    let revelation: string;
    if (sl === "critical" && primary.critical) revelation = primary.critical;
    else if (sl === "extreme" && primary.extreme) revelation = primary.extreme;
    else if (sl === "hard" && primary.hard) revelation = primary.hard;
    else if (sl === "regular" && primary.regular) revelation = primary.regular;
    else if (sl === "regular" || sl === "hard" || sl === "extreme" || sl === "critical") revelation = primary.regular || clue.primary.success || "你发现了一些线索。";
    // 同上：这是真掷过骰子且没过（"检定失败"），与游戏会话层「这里没什么特别
    // 的」（玩家的措辞对不上任何一条未发现线索——压根没进检定）是两种不同的
    // "没找到"，措辞要能分辨，判定逻辑不变。
    else revelation = primary.fail || clue.primary.fail || "你仔细搜查了一番，但这次没能看出什么名堂。";

    // SAN 处理 —— 应用难度倍率
    let sanLost = 0;
    if (clue.san_cost && !alreadyDiscovered) {
      const parts = clue.san_cost.split("/");
      if (parts.length === 2) {
        const costStr = (parts[(sl === "fail" || sl === "fumble") ? 1 : 0] ?? "0").trim();
        // ⚠ 原先是 `const num = parseInt(costStr); isNaN(num) ? rollDice(costStr) : num`。
        //   **`parseInt("1d6") === 1`** —— 取前导数字，不是 NaN。
        //   于是 `rollDice` 那一支永远到不了，所有线索的 SAN 损失恒等于骰子
        //   表达式的首位数字：`1d6`→1、`1d3`→1、`2d6`→2。**骰子从来没掷过。**
        //
        //   后果不只是数值偏小：临时疯狂的阈值是单次损失 ≥5，而这样一来
        //   调查永远掉 1 点，**这条路上的疯狂在数学上就不可能发生**。
        //
        //   判断顺序反过来：先认骰子表达式，认不出才当纯数字。
        const baseLost = /\d*d\d+/i.test(costStr)
          ? CoCEngine.rollDice(costStr)
          : (Number.parseInt(costStr, 10) || 0);
        sanLost = Math.round(baseLost * profile.sanMultiplier);
      }
    }

    const success = sl !== "fail" && sl !== "fumble";
    if (success) this.markDiscovered(clueType, playerName);

    return {
      success,
      successLevel: sl,
      revelation: `${revelation}${sanLost > 0 ? `\n（SAN -${sanLost}）` : ""}`,
      sanLost,
      sanCost: clue.san_cost ?? "",
      clue,
      roll: check.roll,
      skillValue,
      skillId: skillName,
      pushed: check.pushed,
      luckSpent: check.luckSpent,
    };
  }

  // ==========================================================
  // 辅助
  // ==========================================================

  private skillDC(skillValue: number, type: "primary" | "secondary"): number {
    // CoC-style: 常规成功需要 d100 ≤ skill
    // 映射到 d20: DC = 20 - floor(skill / 5)
    // 50% skill → DC 10, 80% skill → DC 4, 20% skill → DC 16
    if (type === "secondary") {
      return Math.max(8, Math.min(18, 20 - Math.floor(skillValue / 5)));
    }
    return Math.max(5, Math.min(20, 20 - Math.floor(skillValue / 5)));
  }

  /** 复制原始 YAML 到引擎的 rules 目录 */
  static initDefaultRules() {
      // 留给用户手动复制
  }
}
