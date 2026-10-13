/**
 * 世界模型约束系统回归测试
 * ===========================
 *
 * 范围：
 * - ConstraintEngine 优先级/匹配/动作类型
 * - worldModelItemFilter 集成
 * - worldPenetrationCheck 四种处置路径
 * - mentionReactions 触发匹配
 * - revealConditions 线索门控
 *
 * 运行：bun test src/__tests__/world-constraint.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  ConstraintEngine,
  ConstraintPriority,
  DEFAULT_CONSTRAINTS,
  checkNarrationText,
} from "../world/world-constraint";
import {
  worldModelItemFilter,
  getStartingItems,
  setConstraintEngine,
  getConstraintEngine,
} from "../rules/coc-cr";

// ============================================================
// ConstraintEngine 单元测试
// ============================================================

describe("ConstraintEngine", () => {
  it("默认约束应包含物品年代约束和对话 meta 约束", () => {
    const ids = DEFAULT_CONSTRAINTS.map(c => c.id);
    expect(ids).toContain("anachronistic_mobile_phone");
    expect(ids).toContain("dialogue_meta_location");
    expect(ids).toContain("dialogue_meta_mechanic");
    expect(ids).toContain("dialogue_meta_player");
    expect(ids).toContain("dialogue_meta_character");
  });

  it("默认约束的优先级应为 COC_GENERAL 或 SCENE_FACT", () => {
    // 空表会让下面的循环一条断言都不跑 —— 先钉住它非空
    expect(DEFAULT_CONSTRAINTS.length).toBeGreaterThan(0);
    // 开发·意图与约束补漏 任务3：新增的 narrative_denies_undiscovered_clue
    // 是"当前场景已确认事实"这一档（ConstraintPriority.SCENE_FACT，比
    // COC_GENERAL 更高），不是通用规则——它本来就该比"NPC 不该说场景名"
    // 这类通用措辞约束优先，所以这条断言从"全是 COC_GENERAL"放宽成
    // "COC_GENERAL 或 SCENE_FACT"，不是削弱判据，是判据原先没预料到会有
    // 第二个优先级档位。
    for (const c of DEFAULT_CONSTRAINTS) {
      expect([ConstraintPriority.COC_GENERAL, ConstraintPriority.SCENE_FACT]).toContain(c.priority);
    }
  });

  it("checkItem: 移动电话在 1921 年应被替换", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    const result = engine.checkItem("移动电话(早期)", 1921);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("replace");
    expect((result as { type: "replace"; replacement: string }).replacement).toBe("黄铜望远镜");
  });

  it("checkItem: 移动电话在 2020 年不应被拦截", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    const result = engine.checkItem("移动电话(早期)", 2020);
    expect(result).toBeNull();
  });

  it("checkItem: 不相关物品应返回 null", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    expect(engine.checkItem("左轮手枪", 1921)).toBeNull();
    expect(engine.checkItem("手电筒", 1921)).toBeNull();
    expect(engine.checkItem("硬面包", 1921)).toBeNull();
  });

  it("checkDialogue: 含有 meta 词汇的文本应被拦截", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    expect(engine.checkDialogue("这个线索很重要")).not.toBeNull();
    expect(engine.checkDialogue("前方有个旅店")).not.toBeNull();
    expect(engine.checkDialogue("你是一个NPC")).not.toBeNull();
    expect(engine.checkDialogue("我想存档")).not.toBeNull();
    // 纯自然对话不应被拦截
    expect(engine.checkDialogue("那天下着雨，我亲眼看见他进了巷子。")).toBeNull();
    expect(engine.checkDialogue("她后来再也没有回来过。")).toBeNull();
  });

  it("checkDialogue: 存档/读档 拦截（大小写不敏感）", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    expect(engine.checkDialogue("我想存档一下")).not.toBeNull();
    expect(engine.checkDialogue("快速读档")).not.toBeNull();
  });

  it("默认约束应包含时代科技黑名单", () => {
    const ids = DEFAULT_CONSTRAINTS.map(c => c.id);
    expect(ids).toContain("anachronistic_tech");
  });

  it("checkDialogue: 1920s 场景中出现个人移动通讯设备应被拦截", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    expect(engine.checkDialogue("他掏出了手机")).not.toBeNull();
    expect(engine.checkDialogue("我用手机打了个电话")).not.toBeNull();
    expect(engine.checkDialogue("我给他发了条短信")).not.toBeNull();
    expect(engine.checkDialogue("电脑上的数据")).not.toBeNull();
    expect(engine.checkDialogue("上网查一下")).not.toBeNull();
  });

  it("checkDialogue: 模组内合理的跨时代科技（电视）应放行", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    // 艾米丽（电子学教授）+ 米戈跨时代科技：谷仓监控屏用电视机改造（模组原文场景），允许存在
    expect(engine.checkDialogue("电视里正在播放新闻")).toBeNull();
  });

  it("checkDialogue: 时代科技黑名单 2020s 场景应放行（yearRange 之外）", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    // checkDialogue 不传年份 → 默认当作可能违反（保守）
    expect(engine.checkDialogue("他掏出了手机")).not.toBeNull();
  });

  it("checkDialogue: 1920s 合法的时代词汇不应被拦截", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    // 机构电话 1920s 合理存在（警察局/银行/医院）：等待警方电话、给警局打电话
    expect(engine.checkDialogue("我一直在家等警方电话")).toBeNull();
    expect(engine.checkDialogue("给警察局打了个电话报案")).toBeNull();
    // 个人之间靠信件/托人带话/当面联系——这是模组"联系失效"设定的基础
    expect(engine.checkDialogue("报纸上登了寻人启事")).toBeNull();
    expect(engine.checkDialogue("电报局发来一封电报")).toBeNull();
    expect(engine.checkDialogue("收音机里播着爵士乐")).toBeNull();
  });

  it("checkDialogue: 个人端到端电话联系（'打他电话'式）应被拦截——1920s 落后小镇无个人家庭电话线路", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    // 拖车房少年绝无电话线路：菲碧"打他电话打不通"这句台词本身跨时代
    expect(engine.checkDialogue("我打他电话，第一天没人接")).not.toBeNull();
    expect(engine.checkDialogue("他打来电话说今晚不回来了")).not.toBeNull();
    expect(engine.checkDialogue("我给她打电话没人接")).not.toBeNull();
  });

  it("checkDialogueText: 共享校验函数拦截现代科技词", () => {
    const { checkDialogueText } = require("../world/world-constraint");
    expect(checkDialogueText("他用手机联系了接头人")).not.toBeNull();
    expect(checkDialogueText("马车停在酒馆门口，车夫点了一袋烟。")).toBeNull();
  });
});

// ============================================================
// checkNarration — KP 叙事专用检查（开发·意图与约束补漏 任务3）
// ============================================================

describe("ConstraintEngine.checkNarration", () => {
  it("旅店等真实场景名不该被拦——dialogue_meta_location 是 NPC 对话专用约束，不在 narration scope 里", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    // 对照：同一句话在 checkDialogue 侧确实会被拦（上面已有用例验证过），
    // 这里验证 checkNarration 不会重蹈覆辙。
    expect(engine.checkDialogue("前方有个旅店")).not.toBeNull();
    expect(engine.checkNarration("前方有个旅店")).toBeNull();
    expect(engine.checkNarration("你来到了「旅店」。")).toBeNull();
  });

  it("其余四条 NPC-only meta 约束同样不该拦叙事", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    expect(engine.checkNarration("这个线索很重要")).toBeNull();
    expect(engine.checkNarration("你是一个NPC")).toBeNull();
    expect(engine.checkNarration("我想存档")).toBeNull();
  });

  it("时代科技黑名单同样拦叙事（scope 含 narration）", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    expect(engine.checkNarration("他掏出了手机")).not.toBeNull();
    expect(engine.checkNarration("电视里正在播放新闻")).toBeNull(); // 模组内合理例外，同 checkDialogue
  });

  it("narrative_denies_undiscovered_clue：指名否认场景里一条未发现线索的对象要被拦", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    const hit = engine.checkNarration(
      "陈岳打开了冰箱与储物柜，冰箱里面空荡荡的，只有几层隔板和后壁。",
      { undiscoveredClueKeys: ["冰箱与储物柜", "冰箱", "储物柜"] },
    );
    expect(hit).not.toBeNull();
    expect(hit!.type).toBe("block");
  });

  it("同一句话没有 undiscoveredClueKeys（没算/场景没有未发现线索）时不拦——没有可比对的对象名就没有信号", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    expect(engine.checkNarration("冰箱里面空荡荡的，只有几层隔板和后壁。")).toBeNull();
    expect(engine.checkNarration("冰箱里面空荡荡的，只有几层隔板和后壁。", { undiscoveredClueKeys: [] })).toBeNull();
  });

  it("否认措辞在，但没提到任何未发现线索的名字——不拦（泛指的否认放行）", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    // 引擎自己的通用失败播报的形状：不点名任何具体对象。
    const hit = engine.checkNarration(
      "你仔细找了找，这里没什么特别的。",
      { undiscoveredClueKeys: ["冰箱与储物柜", "冰箱", "储物柜"] },
    );
    expect(hit).toBeNull();
  });

  it("提到了线索名字，但不是否认语气——不拦", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    const hit = engine.checkNarration(
      "你打开了冰箱与储物柜的柜门，里面似乎还有些东西。",
      { undiscoveredClueKeys: ["冰箱与储物柜", "冰箱", "储物柜"] },
    );
    expect(hit).toBeNull();
  });

  it("否认与对象名分别出现在无关的两句话里——不按整段拼接判断，不拦", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    const hit = engine.checkNarration(
      "远处的天空空荡荡的，没有一丝云彩。你注意到墙角有一个储物柜，柜门虚掩着。",
      { undiscoveredClueKeys: ["储物柜"] },
    );
    expect(hit).toBeNull();
  });

  it("checkNarrationText：共享校验函数行为与 engine.checkNarration 一致", () => {
    const { checkNarrationText } = require("../world/world-constraint");
    expect(checkNarrationText("前方有个旅店")).toBeNull();
    expect(checkNarrationText("他掏出了手机")).not.toBeNull();
    expect(
      checkNarrationText("冰箱里面空荡荡的，只有几层隔板和后壁。", { undiscoveredClueKeys: ["冰箱"] }),
    ).not.toBeNull();
  });

  it("compiled narration may use a reviewed exact technology term without weakening other narration guards", () => {
    // The normal, legacy caller remains conservative when it does not know a
    // year.  Only the compiled host opts into skipping year-ranged rules for
    // an unknown reviewed era.
    expect(checkNarrationText("电脑亮着冷光。")).not.toBeNull();
    expect(checkNarrationText("电脑亮着冷光。", { year: 1980 } as any)).toBeNull();
    expect(checkNarrationText("电脑亮着冷光。", { skipYearRangeWhenUnknown: true } as any)).toBeNull();

    // A source-reviewed current fact may support precisely the reviewed term,
    // not a suffix/compound containing it and not another modern device.
    const reviewedComputer = { year: 1893, sourceReviewedTechnologyTerms: ["电脑"] };
    expect(checkNarrationText("电脑亮着冷光。", reviewedComputer as any)).toBeNull();
    expect(checkNarrationText("笔记本电脑亮着冷光。", reviewedComputer as any)).not.toBeNull();
    expect(checkNarrationText("电脑旁放着一部手机。", reviewedComputer as any)).not.toBeNull();

    // This is an exact source-reviewed empty-refrigerator revelation, but a
    // technology allowance must never bypass the independent hidden-clue
    // guard while the refrigerator remains undiscovered.
    expect(checkNarrationText("冰箱空荡荡，只剩几层隔板。", {
      ...reviewedComputer,
      undiscoveredClueKeys: ["冰箱"],
    } as any)).not.toBeNull();
    expect(checkNarrationText("冰箱空无一物。", {
      ...reviewedComputer,
      undiscoveredClueKeys: ["冰箱"],
    } as any)).not.toBeNull();
  });
});

// ============================================================
// 优先级排序
// ============================================================

describe("ConstraintEngine — 优先级排序", () => {
  it("高优先级约束优先于低优先级", () => {
    const engine = new ConstraintEngine([
      {
        id: "low_priority",
        priority: ConstraintPriority.LLM_JUDGMENT,
        source: "test",
        matchItem: "test_item",
        action: { type: "block", blockMessage: "low" },
      },
      {
        id: "high_priority",
        priority: ConstraintPriority.MODULE_SPECIAL,
        source: "test",
        matchItem: "test_item",
        action: { type: "replace", replacement: "high_wins" },
      },
    ]);
    const result = engine.checkItem("test_item", 1921);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("replace");
    expect((result as { type: "replace"; replacement: string }).replacement).toBe("high_wins");
  });

  it("模组 override 可替换默认约束", () => {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    engine.applyModuleOverrides([
      {
        replaceConstraintId: "anachronistic_mobile_phone",
        constraint: {
          id: "anachronistic_mobile_phone",
          priority: ConstraintPriority.MODULE_SPECIAL,
          source: "module override test",
          matchItem: (s: string) => s.includes("移动电话"),
          yearRange: [undefined, 1973] as [number | undefined, number | undefined],
          action: { type: "replace", replacement: "镀金单筒望远镜" },
        },
      },
    ]);
    const result = engine.checkItem("移动电话(早期)", 1921);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("replace");
    expect((result as { type: "replace"; replacement: string }).replacement).toBe("镀金单筒望远镜");
  });
});

// ============================================================
// 动作类型
// ============================================================

describe("ConstraintEngine — 动作类型", () => {
  it("block 动作返回 { type: 'block' }", () => {
    const engine = new ConstraintEngine([
      { id: "b1", priority: ConstraintPriority.COC_GENERAL, source: "test", matchText: "bad", action: { type: "block" } },
    ]);
    const r = engine.checkDialogue("this is bad");
    expect(r).not.toBeNull();
    expect(r!.type).toBe("block");
  });

  it("replace 动作返回 { type: 'replace', replacement }", () => {
    const engine = new ConstraintEngine([
      { id: "r1", priority: ConstraintPriority.COC_GENERAL, source: "test", matchItem: "old", action: { type: "replace", replacement: "new" } },
    ]);
    const r = engine.checkItem("old", 1920);
    expect(r).not.toBeNull();
    expect(r!.type).toBe("replace");
    expect((r as { type: "replace"; replacement: string }).replacement).toBe("new");
  });

  it("redirect 动作返回 { type: 'redirect', redirectMessage }", () => {
    const engine = new ConstraintEngine([
      { id: "rd1", priority: ConstraintPriority.COC_GENERAL, source: "test", matchText: "secret", action: { type: "redirect", redirectMessage: "change subject" } },
    ]);
    const r = engine.checkDialogue("that's a secret");
    expect(r).not.toBeNull();
    expect(r!.type).toBe("redirect");
    expect((r as { type: "redirect"; redirectMessage: string }).redirectMessage).toBe("change subject");
  });

  it("allow_with_cost 动作返回 { type: 'allow_with_cost', costDescription }", () => {
    const engine = new ConstraintEngine([
      { id: "c1", priority: ConstraintPriority.COC_GENERAL, source: "test", matchText: "risky", action: { type: "allow_with_cost", costDescription: "costs 1 SAN" } },
    ]);
    const r = engine.checkDialogue("this is risky");
    expect(r).not.toBeNull();
    expect(r!.type).toBe("allow_with_cost");
    expect((r as { type: "allow_with_cost"; costDescription: string }).costDescription).toBe("costs 1 SAN");
  });
});

// ============================================================
// 年代 / 场景作用域
// ============================================================

describe("ConstraintEngine — 年代范围", () => {
  const engine = new ConstraintEngine([
    {
      id: "era_test",
      priority: ConstraintPriority.COC_GENERAL,
      source: "test",
      matchItem: "蒸汽机",
      yearRange: [1750, 1900] as [number, number],
      action: { type: "block" },
    },
  ]);

  it("在年代范围内应命中", () => {
    expect(engine.checkItem("蒸汽机", 1800)).not.toBeNull();
    expect(engine.checkItem("蒸汽机", 1750)).not.toBeNull();
    expect(engine.checkItem("蒸汽机", 1900)).not.toBeNull();
  });

  it("超出年代范围应放过", () => {
    expect(engine.checkItem("蒸汽机", 1700)).toBeNull();
    expect(engine.checkItem("蒸汽机", 1950)).toBeNull();
  });

  it("不提供年份时应命中（保守：不知道时代就假设需要约束）", () => {
    expect(engine.checkItem("蒸汽机")).not.toBeNull();
  });
});

describe("ConstraintEngine — 场景作用域", () => {
  const engine = new ConstraintEngine([
    {
      id: "scene_specific",
      priority: ConstraintPriority.SCENE_FACT,
      source: "test",
      matchText: "密道",
      sceneId: "basement",
      action: { type: "block" },
    },
  ]);

  it("在同一场景中应命中", () => {
    expect(engine.checkDialogue("密道在这里", "basement")).not.toBeNull();
  });

  it("在不同场景中应放过", () => {
    expect(engine.checkDialogue("密道在这里", "garden")).toBeNull();
  });

  it("不提供场景时，scene-scoped 约束应放过", () => {
    expect(engine.checkDialogue("密道在这里")).toBeNull();
  });
});

// ============================================================
// worldModelItemFilter 集成
// ============================================================

describe("worldModelItemFilter", () => {
  beforeEach(() => {
    setConstraintEngine(new ConstraintEngine(DEFAULT_CONSTRAINTS));
  });

  it("1921 年移动电话应被替换为黄铜望远镜", () => {
    const result = worldModelItemFilter(["移动电话(早期)", "手电筒", "$50现金"], 1921);
    expect(result).toContain("黄铜望远镜");
    expect(result).not.toContain("移动电话(早期)");
    expect(result).toContain("手电筒");
    expect(result).toContain("$50现金");
  });

  it("2020 年移动电话应通过", () => {
    const result = worldModelItemFilter(["移动电话(早期)"], 2020);
    expect(result).toContain("移动电话(早期)");
  });

  it("普通物品应全部通过过滤", () => {
    const result = worldModelItemFilter(["硬面包", "小刀", "手电筒", "$20现金"], 1921);
    expect(result).toEqual(["硬面包", "小刀", "手电筒", "$20现金"]);
  });

  it("模组 override 后应使用新替换", () => {
    const engine = getConstraintEngine();
    engine.applyModuleOverrides([
      {
        replaceConstraintId: "anachronistic_mobile_phone",
        constraint: {
          id: "anachronistic_mobile_phone",
          priority: ConstraintPriority.MODULE_SPECIAL,
          source: "test override",
          matchItem: (s: string) => s.includes("移动电话"),
          yearRange: [undefined, 1973] as [number | undefined, number | undefined],
          action: { type: "replace", replacement: "镀金单筒望远镜" },
        },
      },
    ]);
    const result = worldModelItemFilter(["移动电话(早期)"], 1921);
    expect(result).toContain("镀金单筒望远镜");
    expect(result).not.toContain("黄铜望远镜");
  });
});

// ============================================================
// getStartingItems 集成
// ============================================================

describe("getStartingItems — 世界模型过滤", () => {
  beforeEach(() => {
    setConstraintEngine(new ConstraintEngine(DEFAULT_CONSTRAINTS));
  });

  it("rich 档次应包含黄铜望远镜（移动电话被替换）", () => {
    const items = getStartingItems(75);
    expect(items).toContain("黄铜望远镜");
    expect(items).not.toContain("移动电话(早期)");
  });

  it("super_rich 档次不应受影响（没有移动电话）", () => {
    const items = getStartingItems(95);
    expect(items).toContain("豪华轿车+司机");
    expect(items).not.toContain("黄铜望远镜");
  });

  it("赤贫档次不应受影响", () => {
    const items = getStartingItems(2);
    expect(items).toEqual(["破旧衣物", "硬面包", "空的酒瓶"]);
  });
});

// ============================================================
// 对话穿透过滤（通过 ConstraintEngine 测试）
// ============================================================

describe("worldPenetrationCheck (对话约束)", () => {
  function check(text: string, sceneId?: string) {
    const engine = new ConstraintEngine(DEFAULT_CONSTRAINTS);
    return engine.checkDialogue(text, sceneId);
  }

  it("含有 '线索' 的文本应被标记为 block", () => {
    const r = check("这个线索指向了地下室");
    expect(r).not.toBeNull();
    expect(r!.type).toBe("block");
  });

  it("含有 'NPC' 的文本应被拦截", () => {
    expect(check("那个NPC看起来很可疑")!.type).toBe("block");
  });

  it("含有 '旅店' 的文本应被拦截", () => {
    expect(check("前面有个旅店")!.type).toBe("block");
  });

  it("自然对话文本应通过", () => {
    expect(check("那天下着大雨，我亲眼看见他往巷子深处走了。")).toBeNull();
    expect(check("她走的时候什么也没说，只留下了一封信。")).toBeNull();
    expect(check("我已经三个月没见到我儿子了。")).toBeNull();
  });
});

// ============================================================
// mentionReactions 触发匹配（纯逻辑，不依赖模块）
// ============================================================

describe("mentionReactions — 职业关键词匹配", () => {
  const reactions = [
    { trigger: "侦探", reaction: "您以前是警察？" },
    { trigger: "警探", reaction: "您以前是警察？" },
    { trigger: "医生", reaction: "您是大夫？太好了！" },
  ];

  function match(occupation: string): string | null {
    for (const pl of [{ name: "亨利", occupation }]) {
      const matched = reactions.find(r =>
        pl.occupation.toLowerCase().includes(r.trigger.toLowerCase())
      );
      if (matched) return matched.reaction.replace(/\{name\}/g, pl.name);
    }
    return null;
  }

  it("侦探职业应匹配 '侦探' 触发器", () => {
    expect(match("私家侦探")).toBe("您以前是警察？");
    expect(match("前警探")).toBe("您以前是警察？");
  });

  it("无关职业应返回 null", () => {
    expect(match("教授")).toBeNull();
    expect(match("记者")).toBeNull();
    expect(match("古董商")).toBeNull();
  });

  it("大小写不敏感（中文触发词不区分大小写）", () => {
    expect(match("私家侦探")).toBe("您以前是警察？");
    expect(match("前警探")).toBe("您以前是警察？");
    expect(match("内科医生")).toBe("您是大夫？太好了！");
  });

  it("多个 PL 时第一个匹配者触发", () => {
    const pls = [
      { name: "詹姆斯", occupation: "医生" },
      { name: "亨利", occupation: "侦探" },
    ];
    let found: string | null = null;
    for (const pl of pls) {
      const matched = reactions.find(r =>
        pl.occupation.toLowerCase().includes(r.trigger.toLowerCase())
      );
      if (matched) { found = matched.reaction.replace(/\{name\}/g, pl.name); break; }
    }
    expect(found).toBe("您是大夫？太好了！");
  });

  it("{name} 占位符替换", () => {
    const pl = { name: "亨利·摩根", occupation: "侦探" };
    const matched = reactions.find(r =>
      pl.occupation.toLowerCase().includes(r.trigger.toLowerCase())
    );
    expect(matched).not.toBeUndefined();
    expect(matched!.reaction.replace(/\{name\}/g, pl.name)).toBe("您以前是警察？");
  });
});

// ============================================================
// revealConditions 线索门控
// ============================================================

describe("revealConditions — 可见条件", () => {
  function makeWorld(foundClues: Set<string>) {
    return { isClueFound: (id: string) => foundClues.has(id) };
  }

  const reveals = [
    "我听到地下室有声音……",
    "那天晚上我看到管家进了书房。",
    "老爷的书房里有一幅画不对劲。",
  ];

  // 来自 types.ts: revealConditions 用 index 定位
  const conditions = [
    { index: 0, requiresClue: ["clue_basement_key"] },
    { index: 1, blocksClue: ["clue_butler_innocent"] },
    { index: 2, requiresClue: ["clue_study_access", "clue_night_watch"], blocksClue: ["clue_painting_moved"] },
  ];

  function getVisible(world: { isClueFound: (id: string) => boolean }): string[] {
    return reveals.filter((_, ki) => {
      const cond = conditions.find(c => c.index === ki);
      if (!cond) return true;
      if (cond.requiresClue?.some(cid => !world.isClueFound(cid))) return false;
      if (cond.blocksClue?.some(cid => world.isClueFound(cid))) return false;
      return true;
    });
  }

  it("无条件（index 不在 conditions 中）时总是可见", () => {
    const world = makeWorld(new Set());
    // index 0 有 requires 未满足，index 1 无 block 但这里 index 1 有 blocksClue
    // index 2 有组合条件
    // 所以只有没有 conditions 之外的 reveal — 但这里所有都有 conditions
    // 加一条无条件 reveal
    const extendedReveals = [...reveals, "额外信息"];
    const visible = extendedReveals.filter((_text, ki) => {
      if (ki === 3) return true; // 无条件
      const cond = conditions.find(c => c.index === ki);
      if (!cond) return true;
      if (cond.requiresClue?.some(cid => !world.isClueFound(cid))) return false;
      if (cond.blocksClue?.some(cid => world.isClueFound(cid))) return false;
      return true;
    });
    expect(visible).toEqual(["那天晚上我看到管家进了书房。", "额外信息"]);
  });

  it("requiresClue 未满足时不可见", () => {
    const world = makeWorld(new Set());
    const visible = getVisible(world);
    expect(visible).not.toContain("我听到地下室有声音……");
  });

  it("requiresClue 满足后可见", () => {
    const world = makeWorld(new Set(["clue_basement_key"]));
    const visible = getVisible(world);
    expect(visible).toContain("我听到地下室有声音……");
  });

  it("blocksClue 触发后不可见", () => {
    const world = makeWorld(new Set(["clue_butler_innocent"]));
    const visible = getVisible(world);
    expect(visible).not.toContain("那天晚上我看到管家进了书房。");
  });

  it("组合条件：全部 requires 满足且无 blocks 时才可见", () => {
    const world = makeWorld(new Set(["clue_study_access", "clue_night_watch"]));
    const visible = getVisible(world);
    expect(visible).toContain("老爷的书房里有一幅画不对劲。");
  });

  it("组合条件：blocksClue 触发时不可见", () => {
    const world = makeWorld(new Set(["clue_study_access", "clue_night_watch", "clue_painting_moved"]));
    const visible = getVisible(world);
    expect(visible).not.toContain("老爷的书房里有一幅画不对劲。");
  });
});
