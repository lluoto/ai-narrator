/**
 * 世界模型约束系统 — 统一约束引擎
 * =====================================
 *
 * 职责：将"规则/状态/常识"对 LLM 输出和初始状态的约束统一为一个优先级系统。
 *
 * 优先级规则（DESIGN-LOG.md §1）：
 *   模组特殊规则 > 当前场景已确认事实 > CoC通用规则 > LLM的一般常识
 *
 * 用法：
 *   // 创建引擎并加载默认约束
 *   const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
 *
 *   // 模组可声明 override
 *   engine.applyModuleOverrides(module.constraintOverrides ?? []);
 *
 *   // 检查物品
 *   const result = engine.checkItem("移动电话(早期)", 1921);
 *   if (result?.type === "replace") use replacement;
 *
 *   // 检查对话文本
 *   const hit = engine.checkDialogue("这个线索很重要");
 *   if (hit) fallback to safe text;
 *
 * 设计原则（源自综述）：
 * - 确定性执行，不经过 LLM 解释
 * - 优先级排序确保模组特殊规则不会被通用规则覆盖
 * - 行动分类支持 block/replace/allow_with_cost/redirect 四种处置
 */

// ============================================================
// 优先级
// ============================================================

export enum ConstraintPriority {
  /** 模组特殊规则 — 最高优先级，override 一切 */
  MODULE_SPECIAL = 4,
  /** 当前场景已确认世界事实 */
  SCENE_FACT = 3,
  /** CoC 通用规则（如时代限制、NPC 不应说 meta 词汇） */
  COC_GENERAL = 2,
  /** LLM 的一般常识/叙事偏好 — 最低优先级 */
  LLM_JUDGMENT = 1,
}

// ============================================================
// 行动类型
// ============================================================

/**
 * 约束被触发时的处置方式。
 *
 * 替代 binary block/pass，提供四个分类（DESIGN-LOG.md §3）：
 * - block: 直接拒绝，附带世界内解释
 * - replace: 替换为时代/场景合适的内容
 * - allow_with_cost: 允许但有代价（消耗资源/触发新事件）
 * - redirect: 引导回正轨，不是硬拒绝
 */
type ConstraintAction =
  | { type: "block"; blockMessage?: string }
  | { type: "replace"; replacement: string }
  | { type: "allow_with_cost"; costDescription: string }
  | { type: "redirect"; redirectMessage: string };

// ============================================================
// 约束定义
// ============================================================

/**
 * 约束适用的检查点。
 *
 * 开发·意图与约束补漏 任务3：约束系统原本只有一个检查入口
 * （checkDialogueText，服务 NPC 对话），KP 自由叙事（narrateOutcome，
 * game-session.ts 里的 GameSession 私有 canonical KP narration path（`#kpRaw.narrateOutcome(...)`）完全没接进来——
 * "冰箱里面空荡荡的，只有几层隔板和后壁"就是从这条路出来的，连检查都
 * 没经过。但不能直接把 KP 叙事也接到 checkDialogueText：那五条默认约束
 * 全是照着"NPC 对话"的语境写的，`dialogue_meta_location` 拦的是"NPC
 * 报菜单一样说场景名"，而"旅店"这类词在 KP 叙事里是**合法的**（模组
 * 场景本来就叫这个名字，`premiers_barn.ts:239`），照搬会把所有提到真实
 * 场景名的叙事都拦下来。
 *
 * 用一个显式的 scope 标记做分流，而不是新写一套平行的约束表——
 * 省下"两份约束以后各自为政、迟早走岔"的代价。缺省
 * （不写 scope）= `["dialogue"]`，历史遗留的五条默认约束不用逐条改，
 * 行为不变；只有明确要给叙事用的约束才需要加 `"narration"`。
 */
type ConstraintScope = "dialogue" | "narration";

interface WorldConstraint {
  /** 唯一 ID，用于模组 override 定位 */
  id: string;
  priority: ConstraintPriority;
  /** 来源说明（调试/日志用） */
  source: string;

  /**
   * 这条约束适用于哪些检查点。缺省 `["dialogue"]`——历史遗留的默认
   * 约束都是照着 NPC 对话写的，不写这个字段行为不变。
   */
  scope?: ConstraintScope[];

  // ── 匹配条件（三选一） ──

  /** 物品匹配：物品名精确匹配或前缀匹配 */
  matchItem?: string | ((item: string) => boolean);
  /** 对话文本匹配：子串或正则 */
  matchText?: string | RegExp | ((text: string) => boolean);
  /** 通用谓词匹配（用于无法用前两种表达的复杂条件） */
  matchPredicate?: (context: ConstraintContext) => boolean;

  /** 年代范围 [start, end] 闭区间；省略一端表示无界 */
  yearRange?: [number | undefined, number | undefined];
  /** 仅在指定场景中生效 */
  sceneId?: string;

  /** 触发时的处置 */
  action: ConstraintAction;
}

/** 检查时传入的上下文 */
interface ConstraintContext {
  year?: number;
  /**
   * Legacy callers without an era remain conservative: year-ranged rules
   * still apply.  A caller with a source-reviewed but non-year era may opt
   * into skipping only rules that actually carry a year range.
   */
  skipYearRangeWhenUnknown?: boolean;
  sceneId?: string;
  /** 匹配文本（DialogueCheck 时传入） */
  text?: string;
  /** 匹配物品名（ItemCheck 时传入） */
  itemName?: string;
  /**
   * 当前规则集——先把它传下去，是分流的前置条件（PLAN.md:868-887：
   * 同一个检索/约束层在 CoC 侧要收紧、在 D&D 侧要放开，调用方必须先
   * 知道当前规则集才谈得上分流）。
   *
   * ⚠ 本轮只做到"传下去"，不做"按它分流"——`ConstraintEngine` 的匹配
   * 逻辑（`matchesYear`/`matchesScene`）目前不读这个字段，
   * `DEFAULT_CONSTRAINTS` 里也没有任何一条按规则集区分行为。
   * 真要分流，得先决定哪些约束该按规则集拆，这是内容决策，不是这次
   * 接线的范围——这次只保证调用方想读的时候，这个字段已经在场景里。
   */
  ruleset?: import("../rules/rules-engine").RulesetId;
  /**
   * 当前场景（当前 PC 视角）尚未发现的线索的名字/唯一简称——checkNarration
   * 专用，`narrative_denies_undiscovered_clue` 靠它判断叙事有没有指名
   * 否认一个具体对象。缺省 `[]`，表示调用方没算这份数据（比如战斗叙事，
   * 不涉及场景线索）。计算方式见 game-session.ts 的
   * currentUndiscoveredClueKeys()，复用 clue-match.ts 的 splitKeys——
   * 与匹配器判定"这是场景里的一个对象"用的同一套认定，不另起一套。
   */
  undiscoveredClueKeys?: string[];
  /**
   * Exact technology terms from source-reviewed, currently player-visible
   * module text.  This is intentionally a narrow exception to the one
   * generic technology rule; it is never a general narration allow-list.
   */
  sourceReviewedTechnologyTerms?: readonly string[];
  /**
   * 开发·约束层补角色实体域 N9（todo-56）：登记表
   * （`scene-npc-noun-registry.ts` 的 `CHARACTER_NOUN_REGISTRY`）里
   * 「这个场景没有对应 NPC」的那些角色名词——`dialogue_fabricated_
   * character` 靠它判断 NPC 说话有没有把这类不存在的角色当成场景
   * 成分说出来（真实案例：酒吧保镖说"老板锁进抽屉了"，weisen_bar 没有
   * "老板"这个角色）。缺省 `[]`，调用方没算这份数据时这条约束天然不
   * 命中，与 `undiscoveredClueKeys` 同一个"不传就不生效"的兼容策略。
   *
   * 计算方式见 `unrepresentedCharacterNouns()`
   * （scene-npc-noun-registry.ts）：登记表里没有被"当前场景实际在场
   * 实体"代表的那些词，只认登记过的词，不做分词/不自动扩词——能力
   * 边界与登记表本身一致。
   */
  sceneFabricableCharacterNouns?: string[];
}

// ============================================================
// 模组 override
// ============================================================

interface ModuleConstraintOverride {
  /**
   * 替换默认约束：若设置，用本 constraint 替换同 id 的默认约束。
   * 若未设置或默认中无此 id，则新增。
   */
  replaceConstraintId?: string;
  constraint: WorldConstraint;
}

// ============================================================
// 约束引擎
// ============================================================

export class ConstraintEngine {
  private constraints: WorldConstraint[] = [];

  constructor(defaultConstraints: WorldConstraint[]) {
    this.constraints = [...defaultConstraints];
    this.sort();
  }

  /** 应用模组 override */
  applyModuleOverrides(overrides: ModuleConstraintOverride[]): void {
    for (const ov of overrides) {
      if (ov.replaceConstraintId) {
        const idx = this.constraints.findIndex(c => c.id === ov.replaceConstraintId);
        if (idx >= 0) {
          this.constraints[idx] = ov.constraint;
        } else {
          this.constraints.push(ov.constraint);
        }
      } else {
        this.constraints.push(ov.constraint);
      }
    }
    this.sort();
  }

  /** 按优先级降序排列 */
  private sort(): void {
    this.constraints.sort((a, b) => b.priority - a.priority);
  }

  /** 获取当前所有约束（只读快照，用于调试/日志） */
  getConstraints(): readonly WorldConstraint[] {
    return this.constraints;
  }

  // ── 检查方法 ──

  /**
   * 检查物品名是否命中任何约束。
   * 返回最高优先级命中的 action，或 null（无命中）。
   */
  checkItem(
    itemName: string, year?: number, sceneId?: string,
    ruleset?: import("../rules/rules-engine").RulesetId,
  ): ConstraintAction | null {
    const ctx: ConstraintContext = { year, sceneId, itemName, ruleset };
    for (const c of this.constraints) {
      if (!this.matchesYear(c, ctx)) continue;
      if (!this.matchesScene(c, ctx)) continue;
      if (c.matchItem) {
        const match = typeof c.matchItem === "function"
          ? c.matchItem(itemName)
          : itemName === c.matchItem || itemName.startsWith(c.matchItem + "(") || itemName.startsWith(c.matchItem + "×");
        if (match) return c.action;
      }
    }
    return null;
  }

  /**
   * 检查对话文本是否命中任何约束。
   * 返回最高优先级命中的 action，或 null（无命中）。
   *
   * 只看 scope 含 "dialogue" 的约束（缺省 scope = ["dialogue"]，历史
   * 遗留的五条默认约束因此行为不变）——KP 叙事有自己的 checkNarration，
   * 不共用这份表，见 ConstraintScope 的说明。
   */
  checkDialogue(
    text: string, sceneId?: string,
    ruleset?: import("../rules/rules-engine").RulesetId,
    sceneFabricableCharacterNouns?: string[],
  ): ConstraintAction | null {
    const ctx: ConstraintContext = { text, sceneId, ruleset, sceneFabricableCharacterNouns };
    for (const c of this.constraints) {
      if (!this.hasScope(c, "dialogue")) continue;
      if (!this.matchesScene(c, ctx)) continue;
      if (c.matchText) {
        const match = typeof c.matchText === "function"
          ? c.matchText(text)
          : typeof c.matchText === "string"
            ? text.includes(c.matchText)
            : c.matchText.test(text);
        if (match) return c.action;
      }
      if (c.matchPredicate && c.matchPredicate(ctx)) return c.action;
    }
    return null;
  }

  /**
   * 检查 KP 自由叙事文本是否命中任何约束。
   *
   * 只看 scope 含 "narration" 的约束——不含 dialogue_meta_location 这类
   * 照着 NPC 对话写的约束（"旅店"在叙事里是合法场景名，不该被拦，见
   * ConstraintScope 的说明）。同时看 matchText 与 matchPredicate 两种
   * 匹配方式：`narrative_denies_undiscovered_clue` 用 matchPredicate
   * （需要 ctx.undiscoveredClueKeys），`anachronistic_tech` 用 matchText，
   * 两者都可能命中叙事场景。
   */
  checkNarration(
    text: string,
    opts: {
      year?: number;
      /** Opt-in only; ordinary callers preserve legacy conservative handling. */
      skipYearRangeWhenUnknown?: boolean;
      sceneId?: string;
      ruleset?: import("../rules/rules-engine").RulesetId;
      undiscoveredClueKeys?: string[];
      sourceReviewedTechnologyTerms?: readonly string[];
    } = {},
  ): ConstraintAction | null {
    const ctx: ConstraintContext = {
      text,
      year: typeof opts.year === "number" && Number.isFinite(opts.year) ? opts.year : undefined,
      skipYearRangeWhenUnknown: opts.skipYearRangeWhenUnknown === true,
      sceneId: opts.sceneId,
      ruleset: opts.ruleset,
      undiscoveredClueKeys: opts.undiscoveredClueKeys,
      sourceReviewedTechnologyTerms: opts.sourceReviewedTechnologyTerms,
    };
    for (const c of this.constraints) {
      if (!this.hasScope(c, "narration")) continue;
      if (!this.matchesScene(c, ctx)) continue;
      if (!this.matchesYear(c, ctx)) continue;
      if (c.matchText) {
        const match = typeof c.matchText === "function"
          ? c.matchText(text)
          : typeof c.matchText === "string"
            ? text.includes(c.matchText)
            : c.matchText.test(text);
        if (match) return c.action;
      }
      if (c.matchPredicate && c.matchPredicate(ctx)) return c.action;
    }
    return null;
  }

  /**
   * 通用检查 — 使用 matchPredicate。
   */
  checkPredicate(ctx: ConstraintContext): ConstraintAction | null {
    for (const c of this.constraints) {
      if (!this.matchesYear(c, ctx)) continue;
      if (!this.matchesScene(c, ctx)) continue;
      if (c.matchPredicate && c.matchPredicate(ctx)) return c.action;
    }
    return null;
  }

  private hasScope(c: WorldConstraint, scope: ConstraintScope): boolean {
    return (c.scope ?? ["dialogue"]).includes(scope);
  }

  private matchesYear(c: WorldConstraint, ctx: ConstraintContext): boolean {
    if (!c.yearRange) return true;
    // Historical callers intentionally remain conservative when their era is
    // missing.  Only the compiled, source-reviewed path opts in to skipping a
    // year-range rule for an unknown/descriptive era; no-year privacy guards
    // still run normally.
    if (ctx.year === undefined) return !ctx.skipYearRangeWhenUnknown;
    const [start, end] = c.yearRange;
    if (start !== undefined && ctx.year < start) return false;
    if (end !== undefined && ctx.year > end) return false;
    return true;
  }

  private matchesScene(c: WorldConstraint, ctx: ConstraintContext): boolean {
    if (!c.sceneId) return true;
    return c.sceneId === ctx.sceneId;
  }
}

// ============================================================
// 默认约束集
// ============================================================

/**
 * CoC 7e 1920s 默认约束。
 * 这些是通用规则，模组可通过 applyModuleOverrides 替换。
 */
/**
 * `dialogue_fabricated_character` 命中时的 blockMessage——单独导出成
 * 常量，供 npc-agent.ts 区分"是不是这一条约束命中"（这条约束值得
 * 重生成一次给 LLM 一个纠正的机会，其它 scope=dialogue 的约束——
 * 时代错置/meta 词汇——沿用既有的"直接换安全话术"处理，两种处置
 * 不是同一回事，不能靠 ConstraintAction 本身的 type 区分，因为都是
 * "block"）。
 */
export const DIALOGUE_FABRICATED_CHARACTER_BLOCK_MESSAGE =
  "NPC 对话把不存在的角色当成场景成分说了出来，与模组事实矛盾";

/**
 * One policy-owned token vocabulary backs both the generic 1920s guard and
 * the compiled host's source-exact exception.  Keep longer compounds first:
 * a reviewed `电脑` must not silently authorize `笔记本电脑`.
 */
const ANACHRONISTIC_TECHNOLOGY_TERMS = [
  "笔记本电脑", "平板电脑", "移动电话", "智能手机", "无线网络", "卫星导航",
  "数码相机", "电子支付", "智能设备", "放下听筒", "接起电话", "挂断电话",
  "他打来电话", "她打来电话", "给他打电话", "给她打电话", "打他电话", "打她电话",
  "互联网", "wifi", "wi-fi", "蓝牙", "扫码", "二维码", "微信", "短信",
  "短视频", "无人机", "手机", "电脑", "上网", "gps",
] as const;

const ANACHRONISTIC_TECHNOLOGY_PATTERN = new RegExp(
  ANACHRONISTIC_TECHNOLOGY_TERMS
    .slice()
    .sort((left, right) => right.length - left.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "gi",
);

function technologyTermsIn(text: string): string[] {
  return [...text.matchAll(ANACHRONISTIC_TECHNOLOGY_PATTERN)]
    .map((match) => match[0]!.toLocaleLowerCase("en-US"));
}

/**
 * Extract only the shared policy's exact lexical terms from already-trusted
 * text.  This function does not establish trust itself; the compiled host is
 * responsible for supplying source-reviewed, player-visible fields only.
 */
export function sourceReviewedNarrationTechnologyTerms(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => typeof text === "string" ? technologyTermsIn(text) : []))]
    .sort((left, right) => left.localeCompare(right));
}

function mentionsUnreviewedAnachronisticTechnology(ctx: ConstraintContext): boolean {
  if (!ctx.text) return false;
  const reviewed = new Set(
    (ctx.sourceReviewedTechnologyTerms ?? [])
      .filter((term): term is string => typeof term === "string")
      .map((term) => term.toLocaleLowerCase("en-US")),
  );
  return technologyTermsIn(ctx.text).some((term) => !reviewed.has(term));
}

export const DEFAULT_CONSTRAINTS: WorldConstraint[] = [
  // ── 物品年代约束 ──
  {
    id: "anachronistic_mobile_phone",
    priority: ConstraintPriority.COC_GENERAL,
    source: "CoC 1920s 时代设定：移动电话 1973 年才诞生",
    matchItem: (s) => s.includes("移动电话"),
    yearRange: [undefined, 1973],
    action: { type: "replace", replacement: "黄铜望远镜" },
  },

  // ── 时代科技黑名单（LLM 易幻觉出现的现代科技，1921 年个人社会绝不可能存在）──
  // 注意：
  // - 移动电话/手机/短信等个人移动通讯设备绝不存在：个人对个人的联系依赖信件/当面/托人带话，
  //   一旦出现手机，"联系失效"的戏剧核心即崩塌 → 必须约束
  // - 个人端到端电话联系（"打他电话"）同样受限：1920s 电话是端到端物理线路，普瑞米尔是落后
  //   小镇，个人家庭电话罕见，拖车房少年绝无电话线路 → 约束"打某人电话"式个人联系表述
  // - 机构电话（警察局/银行/医院）合理，不禁"电话"名词本身
  // - "电视"不在黑名单：模组内艾米丽（电子学教授）+ 米戈跨时代科技，谷仓监控屏用电视机
  //   改造（原文场景 L36），属于模组内合理的例外科技 → 允许存在
  {
    id: "anachronistic_tech",
    priority: ConstraintPriority.COC_GENERAL,
    source: "CoC 1920s 时代设定：个人移动通讯（手机/短信）与个人端到端电话联系不存在；互联网/电脑等现代科技不应出现在 1920s",
    // 这份黑名单是字面词表，KP 自由叙事同样不该说"扫码""wifi"这些词，
    // 误伤风险和 NPC 对话一样低——两个 scope 都给。
    scope: ["dialogue", "narration"],
    // The predicate sees the full narration context, so the compiled durable
    // host may permit only a source-reviewed exact token.  A single reviewed
    // token never opens another token or a longer compound containing it.
    matchPredicate: mentionsUnreviewedAnachronisticTechnology,
    yearRange: [undefined, 1940],
    action: { type: "block", blockMessage: "现代个人通讯/科技词汇不应出现在 1920s 场景中" },
  },

  // ── NPC 对话不应出现场景/位置 meta 词汇 ──
  {
    id: "dialogue_meta_location",
    priority: ConstraintPriority.COC_GENERAL,
    source: "NPC 对话不应像报菜单一样说出场景名",
    matchText: /旅店|旅馆|客栈|场景|关卡|地图/,
    action: { type: "block", blockMessage: "NPC不会像报菜单一样说出场景名" },
  },

  // ── NPC 对话不应出现游戏机制术语 ──
  {
    id: "dialogue_meta_mechanic",
    priority: ConstraintPriority.COC_GENERAL,
    source: "NPC 对话不应出现游戏机制术语",
    matchText: /线索|任务|道具|物品|装备|调查进度|剧情/,
    action: { type: "block", blockMessage: "NPC不会说出游戏机制术语" },
  },

  // ── NPC 对话不应出现玩家 meta 术语 ──
  {
    id: "dialogue_meta_player",
    priority: ConstraintPriority.COC_GENERAL,
    source: "NPC 不应意识到自己是游戏角色",
    matchText: /调查员|PL|KP|跑团|游戏|模组|剧本|存档|读档|save|load/i,
    action: { type: "block", blockMessage: "NPC不应出现玩家meta词汇" },
  },

  // ── NPC 对话不应出现角色 meta 术语 ──
  {
    id: "dialogue_meta_character",
    priority: ConstraintPriority.COC_GENERAL,
    source: "NPC 不应称呼自己或玩家为NPC/PC",
    matchText: /NPC|PC|玩家角色|非玩家角色/i,
    action: { type: "block", blockMessage: "NPC不应出现角色meta词汇" },
  },

  // ── NPC 对话不得把不存在的角色当成场景成分说出来 ──
  // 开发·约束层补角色实体域 N9（todo-56）：todo-43 记过的"凭空发明的
  // 名词"那一半——真实案例：酒吧保镖说"名单什么的早让老板锁进抽屉了"，
  // weisen_bar 没有"老板"这个 NPC，applyConstraints/旧的
  // checkDialogueText 都放行。
  //
  // 范围刻意收窄：只管【角色名词】，不是"对话里所有名词都必须存在"——
  // 那会拦掉一切（任何场景描述都可能提一堆没建过 NPC 的东西）。复用
  // `scene-npc-noun-registry.ts` 的登记表（`CHARACTER_NOUN_REGISTRY`），
  // 不新建一份角色名词表——同一份词表已经在 N7 用来扫"线索要求的角色，
  // 场景是否真的有"，这里问的是反过来的问题（"NPC 说的角色，场景是否
  // 真的有"），但认定"这是个角色名词"这件事必须与那份判据一致，不能
  // 出现"扫描判据认为场景该有这个角色，运行时约束却不认识这个词"这种
  // 自相矛盾。
  //
  // 判定靠 `ctx.sceneFabricableCharacterNouns`（调用方用
  // `unrepresentedCharacterNouns()` 算好、传进来的"登记表里这个场景
  // 没有对应 NPC 的词"），不在这里重新判定一次"这个场景有没有这个
  // NPC"——两处判定迟早会漂，这次只应该有一处。
  {
    id: "dialogue_fabricated_character",
    priority: ConstraintPriority.SCENE_FACT,
    source: "NPC 对话不得把不存在的角色当成场景成分说出来（todo-56）",
    scope: ["dialogue"],
    matchPredicate: (ctx) => {
      if (!ctx.text || !ctx.sceneFabricableCharacterNouns?.length) return false;
      return ctx.sceneFabricableCharacterNouns.some((noun) => ctx.text!.includes(noun));
    },
    action: {
      type: "block",
      blockMessage: DIALOGUE_FABRICATED_CHARACTER_BLOCK_MESSAGE,
    },
  },

  // ── KP 叙事不得指名否认场景里一条尚未发现的线索 ──
  // 开发·意图与约束补漏 任务3，缺口 B：约束层原本只有"时代错置"与"对话
  // meta 词汇"两个域，没有"不得与模组事实矛盾"这个域——
  // "冰箱里面空荡荡的，只有几层隔板和后壁"就是这个洞暴露出来的具体案例
  // （2026-08-31-barn-completion-attempt.md，todo-43）。
  //
  // "凭空发明的名词"（酒吧的"老板""抽屉"）那一半白名单抓不到，本轮不做
  // （见 todo-43 记录）；这里做的是反向的那一半——叙事不得对**一个具体
  // 命名的、场景里确实存在但尚未发现的线索对象**下"空/没有/已经搜过"这
  // 类断言。信号很明确：
  //   · 未发现线索的名字/唯一简称——matchSceneClues 已经会算
  //     （splitKeys），不必另起一套判定"这是场景里的对象"。
  //   · 否认措辞是有限的一小组（空荡荡/空空如也/什么都没有/一无所获/
  //     已经搜过/已经查过）。
  //
  // ⚠ 必须与引擎自己的通用失败播报区分开——"你仔细找了找，这里没什么
  // 特别的"是合法的，"冰箱里面空荡荡的"不是。区分不是靠短语表本身
  // （"没什么"和"空荡荡"字面上都是否认），是靠**这条约束只在叙事文本
  // 同一句里同时出现"否认措辞"与"具体线索名/简称"时才命中**——引擎的
  // 通用失败文案压根不提任何具体对象名，天然不会撞上。分句而不是整段
  // 判断：避免一段长叙事里"否认"和"线索名"分别出现在不相关的两句话，
  // 被错误拼到一起判成命中。
  {
    id: "narrative_denies_undiscovered_clue",
    priority: ConstraintPriority.SCENE_FACT,
    source: "KP 叙事不得对场景里一条未发现的具体线索对象下空/没有类断言",
    scope: ["narration"],
    matchPredicate: (ctx) => {
      if (!ctx.text || !ctx.undiscoveredClueKeys?.length) return false;
      return deniesNamedUndiscoveredClue(ctx.text, ctx.undiscoveredClueKeys);
    },
    action: {
      type: "block",
      blockMessage: "叙事对场景里一条尚未发现的具体线索对象下了空/没有类断言，与模组事实矛盾",
    },
  },
];

const CLUE_DENIAL_PHRASE = /空荡荡|空空如也|空无一物|一无所获|什么都没有|没有(?:任何|发现)|已经(?:搜|查|检查)过了?/;

/**
 * 叙事文本里是否有哪一句同时命中"否认措辞"和"场景里一个未发现线索的
 * 名字/简称"。按句切分（。！？\n），不整段判断——见上面约束定义处的
 * 注释，避免"否认"和"对象名"分别出现在无关的两句话里被错误拼到一起。
 */
function deniesNamedUndiscoveredClue(text: string, keys: readonly string[]): boolean {
  const sentences = text.split(/(?<=[。！？\n])/);
  for (const s of sentences) {
    if (!CLUE_DENIAL_PHRASE.test(s)) continue;
    if (keys.some((k) => k.length >= 2 && s.includes(k))) return true;
  }
  return false;
}

/**
 * 共享对话安全校验 — 供各 NPC 对话文本输出点统一使用。
 * 命中任一 scope 含 "dialogue" 的约束（meta 词汇 / 时代科技黑名单）时
 * 返回处置结果，未命中返回 null。KP 自由叙事走 checkNarrationText，
 * 不是这个函数——两者检查的约束子集不同，见 ConstraintScope 的说明。
 */
export function checkDialogueText(
  text: string, sceneId?: string,
  ruleset?: import("../rules/rules-engine").RulesetId,
  sceneFabricableCharacterNouns?: string[],
): ConstraintAction | null {
  const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
  return engine.checkDialogue(text, sceneId, ruleset, sceneFabricableCharacterNouns);
}

/**
 * 共享叙事安全校验 — 供 KP 自由叙事（narrateOutcome 等）统一使用。
 * 只检查 scope 含 "narration" 的约束（时代科技黑名单 + 线索矛盾），
 * 不含 dialogue_meta_location 等只该拦 NPC 对话的约束——"旅店"这类
 * 真实场景名在叙事里是合法的。
 */
export function checkNarrationText(
  text: string,
  opts: {
    year?: number;
    /** Compiled host only: unknown reviewed era skips year-ranged rules. */
    skipYearRangeWhenUnknown?: boolean;
    sceneId?: string;
    ruleset?: import("../rules/rules-engine").RulesetId;
    undiscoveredClueKeys?: string[];
    /** Exact terms derived from trusted, currently player-visible source text. */
    sourceReviewedTechnologyTerms?: readonly string[];
  } = {},
): ConstraintAction | null {
  const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
  return engine.checkNarration(text, opts);
}
