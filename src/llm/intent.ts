// 意图解析器 — LLM 驱动 + 硬编码 fallback
// LLM 可用时：自然语言 → 结构化 ActionIntent
// LLM 不可用时：退化为 regex 模式匹配

import type { ActionIntent } from "../types";
import { LLMClientError, type LLMClient } from "./client";
import { log } from "../log";
import { llmEnabled } from "./enabled";
import { extractJson } from "./json";
import { parseOrdinaryLocalCommand } from "./ordinary-local-command";

// ============================================================
// 硬编码 fallback（regex 模式匹配）
// ============================================================

// 常见生物/怪物名（用于目标提取）
const TARGET_PATTERNS = ["狼", "野狼", "哥布林", "地精", "熊", "蛇", "蜘蛛", "骷髅", "僵尸", "怪物", "敌人", "守卫", "法师", "骑士", "盗贼"];

// 攻击动词检测
// ⚠ 这里原先含「潜行」。潜行**不是**攻击动词 —— 裸的「潜行」因此被判成攻击，
//   玩家想溜过去，系统让他动手。**做相反的事比不做事伤害大得多。**
//   「潜行攻击」由上面 `(?:偷袭|潜行).*(?:攻击|砍|劈)` 那条单独接住并带 method=stealth，
//   所以摘掉它不会影响潜行攻击。
//   「偷袭」留着 —— 偷袭本身就是一次攻击。
const ATTACK_VERBS = /(?:攻击|砍|刺|射|劈|斩|偷袭|暗杀|狙击)/;

/** 从输入中提取瞄准部位 */
function extractCalledShot(input: string): string | undefined {
  const parts = input.match(/瞄准\s*(头部|头|左腿|右腿|腿部|左臂|右臂|手臂|腹部|胸部|胸口|眼睛|武器|手|脚|脖子|颈部)/);
  if (!parts) return undefined;
  const raw = parts[1];
  const map: Record<string, string> = {
    "头": "头部", "头部": "头部", "胸口": "胸部", "胸部": "胸部", "腹部": "腹部", "腰部": "腹部",
    "左腿": "左腿", "右腿": "右腿", "腿部": "左腿",
    "左臂": "左臂", "右臂": "右臂", "手臂": "右臂",
    "眼睛": "眼睛", "手": "手", "脚": "脚",
    "脖子": "头部", "颈部": "头部", "武器": "武器",
  };
  return map[raw] || raw;
}

// 宽松模式：先检测动词，再扫目标
const INTENT_PATTERNS: Array<{ verb: RegExp; intent: Partial<ActionIntent>; requiresTarget?: boolean }> = [
  { verb: /(?:偷袭|潜行).*(?:攻击|砍|刺)/, intent: { action: "attack", method: "stealth" } },
  // CoC 瞄准/专注射击
  { verb: /(?:瞄准|狙击|专心|专注).*(?:射击|攻击|射)/, intent: { action: "attack", method: "aimed" } },
  // CoC 瞄准部位（叫射：瞄准头部/腿部/HAND等）
  { verb: /瞄准\s*(头部|头|左腿|右腿|腿部|左臂|右臂|手臂|腹部|胸部|胸口|眼睛|武器|手|脚|脖子|颈部)/, intent: { action: "attack", method: "aimed" } },
  // CoC 点射/三发
  { verb: /(?:点射|三发|burst)/, intent: { action: "attack", method: "burst" } },
  // CoC 压制/扫射/掩护射击
  { verb: /(?:压制|扫射|掩护)/, intent: { action: "attack", method: "suppress" } },
  { verb: ATTACK_VERBS, intent: { action: "attack", method: "melee" }, requiresTarget: false },
  // 移动+动作组合：优先解析为 move（"前往艾德里安的住宅调查" → 移动而非仅检定）
  // 注意：目标列表不含"休息"——"前往旅店休息" 语义上是休息（过夜/恢复），应落入下方 rest 意图
  { verb: /(?:前往|走到|进入|来到|抵达|走向|去往).*(?:调查|检查|查看|了解|探查|寻找|搜索|探索|见|打听|询问)/, intent: { action: "move" } },
  { verb: /(?:移动|走|跑|前进|前往).*(?:到|向|往|去)/, intent: { action: "move" } },
  // 独立移动动词 + 目标名（"前往加比的拖车房"→move；需在"前往…调查"组合之后，避免与 skill_check 冲突）
  { verb: /^(?:前往|走到|走进|进入|来到|抵达|走向|去往|跑去|前往到)\s*\S+/, intent: { action: "move" } },
  { verb: /^去\s*\S+/, intent: { action: "move" } }, // "去谷仓" 等简短指令
  { verb: /(?:使用|释放|施放|施展).*(?:法术|魔法|咒语)/, intent: { action: "cast" } },
  { verb: /(?:使用|用|装备).*(?:道具|物品|药水|绷带|急救包|武器)/, intent: { action: "use_item" } },
  // Pickup mutates package-owned physical placement.  The offline parser may
  // supply an item only for this complete command form; GameSession never
  // falls back to `target` or scans arbitrary prose for a loot name.
  { verb: /^(?:捡起|捡|拾取|拿起|拿走)\s*(\S(?:.*\S)?)\s*$/, intent: { action: "pickup" } },
  // 施法动词 + 具名法术。必须夹在这两条之间，位置是被两侧同时约束死的：
  //   - 要排在下方 first_aid / rest 之前，否则「施放治疗术」被 rest 的「治疗」
  //     拦成休息、「施展治疗伤势」被 first_aid 拦成急救——玩家想施法，游戏让他休息；
  //   - 又必须排在上方 use_item 之后，否则「使用治疗药水」会被这里的
  //     「使用 + 治疗」吃掉，喝药变成施法。
  { verb: /(?:施放|施展|释放|使用|吟唱|念咒|施法).*(?:魔法飞弹|燃烧之手|霜冻射线|火球术|闪电束|灼热射线|魔法弹)/, intent: { action: "cast" } },
  { verb: /(?:施放|施展|释放|使用|吟唱|念咒|施法).*(?:治疗伤势|治愈|治疗|魔法飞弹|火球术)/, intent: { action: "cast" } },
  // A named ritual need not be in the static D&D spell vocabulary. The ruleset
  // authority validates the exact name before any cosmic-horror cast succeeds.
  { verb: /(?:施放|施展|释放|施法)\s*[^\s]{2,12}$/, intent: { action: "cast" } },
  // ⚠ 「急救」后面原先**必须**跟 伤口|伤势|出血|伤，裸词落到 unknown ——
  //   而 `handleFirstAid` 就在派发表里，打「急救」够不着它。改成后缀可选。
  { verb: /(?:急救|包扎|止血)|(?:医疗|治疗).*(?:伤口|伤势|出血|伤)/, intent: { action: "first_aid" } },
  // 「追问」单独列出：字面像追逐（含"追"字），语义却是对话——
  // 见下方 chase 那条注释，这是同一次真实事故修复的另一半。
  { verb: /(?:和|跟|与|对).*(?:说话|交谈|对话|聊聊|询问|问)|追问/, intent: { action: "talk" } },
  { verb: /(?:休息|休息一下|休整|休养|睡觉|睡眠|治疗|包扎)/, intent: { action: "rest" } },

  // ⚠ 这一段的顺序是有意的，别按字母或手感重排。
  //   这张表是**先匹配先赢**，宽模式压在窄模式前面就会把它吃掉：
  //   look 里的 `查看` 原先排在 inventory 前面，于是「查看背包」看不到背包。
  //   所以背包、以及带具体技能名的检定，都要排在 look 之前。
  //
  //   这条已经是窄的——要求出现「背包」「物品栏」「道具」这几个字面词，
  //   或「我的/有什么…东西」，不会被「冰箱」「储物柜」这类场景容器词带偏
  //   （LLM 提示词那份 INTENT_SYSTEM_PROMPT 里对应描述曾经没说清"仅限玩家
  //   自己的背包"，被模型判宽了，见 analysis/sim/2026-08-31-barn-good-end.md；
  //   这条 regex 本身没有那个问题，别去改它）。
  { verb: /(?:背包|物品栏|道具|查看.*物品|查看.*背包|我的.*东西|有什么.*东西)/, intent: { action: "inventory" } },

  // CoC 技能。这些词原先一个都没有 —— 打「恐吓」「取悦」「聆听」全落 unknown，
  // 而「恐吓」正是模组给贫民窟流浪汉编的唯一非暴力机制路径
  //（barn-of-premier：「只认钱不接受除恐吓外的社交技能」）。
  { verb: /(?:聆听|倾听|听一听|听听|侧耳)/, intent: { action: "skill_check", skill: "listen" } },
  { verb: /(?:恐吓|威吓|吓唬|震慑)/, intent: { action: "skill_check", skill: "intimidate" } },
  // ⚠ 不要往这里加「魅惑」。它在 CoC 里是技能名（=取悦），在 D&D 里是法术效果，
  //   两套规则集撞词：加进来会截胡「魅力豁免对抗魅惑」，
  //   而那条已有测试钉着（标题里就写明了这个关键字容易被截）。
  { verb: /(?:取悦|讨好|奉承)/, intent: { action: "skill_check", skill: "charm" } },
  { verb: /(?:话术|忽悠|唬弄|快speech)/, intent: { action: "skill_check", skill: "fast_talk" } },
  { verb: /(?:图书馆|查资料|查阅|翻查资料|找资料)/, intent: { action: "skill_check", skill: "library_use" } },
  { verb: /(?:精神分析|心理分析)/, intent: { action: "skill_check", skill: "psychoanalysis" } },

  { verb: /(?:潜行|躲藏|隐蔽|隐匿)/, intent: { action: "skill_check", skill: "stealth" } },
  // `环顾` 不在这里 —— 它归下面的 look。随便看一眼在 CoC 里是免费的，
  // 掷侦查的是「翻找/搜查」这类花时间的动作。
  // （原表里 `环顾` 两条都写了，靠 look 排在前面才没出事；
  //   我把 look 移到后面时它就掉进了这条 —— 顺序一改就暴露的重复。）
  { verb: /(?:侦查|观察|搜索|寻找|搜查)/, intent: { action: "skill_check", skill: "perception" } },
  { verb: /(?:说服|交涉|谈判|劝说|聊天|对话)/, intent: { action: "skill_check", skill: "persuasion" } },
  { verb: /(?:调查|检查|研究)/, intent: { action: "skill_check", skill: "investigation" } },

  // look 放在上面这些之后：它是「什么都没说清时」的兜底观察。
  // `搜查` 已移到 perception —— 在 CoC 里翻箱倒柜要掷侦查，不是免费看一眼。
  { verb: /(?:环顾|环视|环顾四周|看看四周|周围|看.*环境|看.*场景|扫视|扫了一眼|查看|探索)/, intent: { action: "look" } },
  // 传承系统（先于 read/状态等模式，避免"读档"被"读"拦截）
  { verb: /(?:传承|继承角色|保存角色|读档|存档|save|load|传承增益)/i, intent: { action: "legacy" } },
  // CoC 创建角色（先于含"角色"的状态模式匹配）
  { verb: /(?:创建角色|车卡|我要当|创建调查员|新角色)/, intent: { action: "create_character" } },
  // CoC 职业列表
  { verb: /(?:职业列表|有哪些职业|可选职业|职业.*有)/, intent: { action: "list_occupations" } },
  // CoC 技能分配
  { verb: /(?:分配技能|调整技能|技能分配|分配.*技能点|手动.*技能)/, intent: { action: "allocate_skills" } },
  { verb: /^阅读\s*\S+|读\s*\S+|翻阅\s*\S+/, intent: { action: "read" } },
  { verb: /(?:状态|属性|角色|角色卡|人物卡|人物信息|我的信息|我是谁)/, intent: { action: "status" } },
  // CoC 商店 — 先于 inventory/物品 模式（避免"物品"拦截"购买 X"）
  { verb: /(?:购买|买|购置|采购)\s*(.*)/, intent: { action: "buy" } },
  { verb: /(?:出售|卖|卖掉|卖出)\s*(.*)/, intent: { action: "sell" } },
  { verb: /(?:商店|购物|shop|buy|买)/, intent: { action: "shop" } },
  { verb: /(?:背包|物品|物品栏|道具|查看.*物品|我的.*东西|有什么.*东西)/, intent: { action: "inventory" } },
  // ⚠ 收紧过（修A·任务2）：原来还认裸「撤」「逃」，跟 chase 那条一样贪——
  // 「逃避」（谈话里的比喻）之类会被误伤。regex 是兜底路径，方向应该是
  // 宁可漏判回 unknown（回落叙事），不可误判成动作（真的会改状态）。
  // 没有任何测试要求裸「撤」「逃」单独触发 flee，收紧不影响既有行为。
  { verb: /(?:逃跑|逃走|逃离|撤退)/, intent: { action: "flee" } },
  // 故事生成
  { verb: /(?:生成故事|生成场景|生成剧本|生成模组|故事生成|随机生成|生成世界|生成.*冒险|generate.*story|new.*story)/, intent: { action: "generate_story" } },
  // 帮助
  { verb: /(?:帮助|指南|操作|指令|命令|help|该做|做什么|可.*做|能干|可以.*什么)/, intent: { action: "help" } },
  { verb: /(?:剧本杀|加载模组|导入模组|载入模组|load.*module|模块)/, intent: { action: "load_module" } },
  { verb: /(?:查看模组|模组详情|模组预览|模组内容|模组大纲|module.*info|module.*detail)/, intent: { action: "view_module" } },
  { verb: /(?:疯狂指引|疯狂状态|疯狂描述|我的疯狂|疯癫|怎样演|怎么演|角色扮演指引)/, intent: { action: "insanity_guidance" } },
  { verb: /(?:理智|san|SAN|疯狂|恐惧|恐怖|害怕|惊吓)/, intent: { action: "san_check", sanCost: "1/1d6", reason: "恐惧侵袭" } },
  { verb: /(?:目睹|看见|见到).*(?:恐怖|恐怖景象|可怕|怪物|尸体)/, intent: { action: "san_check", sanCost: "1/1d6", reason: "目睹恐怖景象" } },
  // D&D 施法（具名法术的两条已上移到 first_aid 之前，原因见那里）
  { verb: /(?:法术|魔法|咒语).*(?:攻击|打|杀|对付)/, intent: { action: "cast" } },
  { verb: /(?:法术|魔法).*(?:列表|展示|查看|有什么|有哪些|会用|可用)/, intent: { action: "spell_list" } },
  // D&D 豁免
  { verb: /(?:豁免|抵抗|对抗|硬抗|扛).*(?:毒素|毒|毒药|中毒)/, intent: { action: "saving_throw", ability: "constitution", reason: "对抗毒素" } },
  { verb: /(?:豁免|抵抗|对抗).*(?:法术|魔法|咒语|法系)/, intent: { action: "saving_throw", reason: "抵抗法术" } },
  { verb: /(?:躲|闪避|闪).*(?:陷阱|机关|滚石|箭雨|落石)/, intent: { action: "saving_throw", ability: "dexterity", reason: "躲避机关" } },
  { verb: /(?:豁免|抵抗|对抗).*(?:恐惧|威吓|惊吓|魅惑|魅惑)/, intent: { action: "saving_throw", ability: "wisdom", reason: "抵抗精神效果" } },
  { verb: /(?:体质豁免|CON豁免|con豁免)/i, intent: { action: "saving_throw", ability: "constitution" } },
  { verb: /(?:力量豁免|STR豁免|str豁免)/i, intent: { action: "saving_throw", ability: "strength" } },
  { verb: /(?:敏捷豁免|DEX豁免|dex豁免)/i, intent: { action: "saving_throw", ability: "dexterity" } },
  { verb: /(?:智力豁免|INT豁免|int豁免)/i, intent: { action: "saving_throw", ability: "intelligence" } },
  { verb: /(?:感知豁免|WIS豁免|wis豁免)/i, intent: { action: "saving_throw", ability: "wisdom" } },
  { verb: /(?:魅力豁免|CHA豁免|cha豁免)/i, intent: { action: "saving_throw", ability: "charisma" } },
  { verb: /(?:豁免).*(?:火焰|冰霜|闪电|雷电|酸性|光耀|暗蚀|雷鸣|寒冷)/, intent: { action: "saving_throw", reason: "抵抗元素伤害" } },
  // CoC 装填/上弹
  { verb: /(?:装填|上弹|装弹|重新.*装弹|换.*弹匣|装.*子弹)/, intent: { action: "reload" } },
  // CoC 推动检定
  { verb: /(?:推动|push|再试一次|再来|重试|重新.*投|重新.*检定)/, intent: { action: "push" } },
  // CoC 神话法术。召唤/呼唤/驱逐/放逐可属于法术 canonical 名称本身；
  // 念咒/吟唱则是外层命令前缀，目标提取时可以去掉。
  { verb: /(?:念咒|吟唱)\s*\S{1,12}$|(?:召唤|呼唤|驱逐|放逐)\S{1,12}$/, intent: { action: "occult_cast" } },
  // CoC 追逐
  //
  // ⚠ 收紧过（修A·任务2）：原来是 /(?:追逐|逃跑|跑|追|逃)/，裸「追」「跑」
  // 「逃」贪到把"追问""追查""追踪""跑团""逃避"这些对话/调查/闲聊词全部
  // 命中成追逐——一次真实事故的根因（见 llm/json.ts 的注释）。
  //
  // 收紧方向：复合动词（真正明确表达追逐行为的说法）任意位置匹配；
  // 裸「追」「跑」只在**整句就是这一个字**（不带其它内容）时才算——
  // game-session.test.ts 有测试直接送裸"追"/"跑"当作战斗中的快捷指令，
  // 不能连这个都收掉，但"追问菲碧……"这种长句不该被一个字拖进追逐。
  // 「逃」不再单独出现在这里：flee 那条已经处理"逃跑/逃走/逃离/撤退"，
  // 没有测试要求裸"逃"单独触发 chase（会被 flee 那条排在前面接住，
  // 但既然 flee 也已收紧掉裸"逃"，chase 这里更不该凭空补上）。
  { verb: /(?:追逐|追赶|追捕|追击|猛追|狂追|追上去|追过去|拔腿追|拼命追|^追[!！。]*$|^跑[!！。]*$)/, intent: { action: "chase" } },
  // CoC 模组结算/技能成长
  { verb: /(?:模组结算|冒险结束|场景结算|结算技能|技能成长|成长骰)/, intent: { action: "skill_advancement" } },
  // 装备
  { verb: /(?:装备|穿戴|穿上|佩戴|携带)\s*(.+)/, intent: { action: "equip" } },
  // 卸下装备
  { verb: /(?:脱下|卸下|解除|拆下)\s*(.+)/, intent: { action: "unequip" } },
  // 模组加载
  { verb: /(?:加载|装载|载入|启用|使用)\s*(?:模组|剧本|模块)/, intent: { action: "load_module" } },
];

const WEAPON_PATTERNS: Array<{ pattern: RegExp; weapon: string }> = [
  { pattern: /短剑/, weapon: "shortsword" },
  { pattern: /长剑/, weapon: "longsword" },
  { pattern: /匕首/, weapon: "dagger" },
  { pattern: /长弓|弓/, weapon: "longbow" },
  { pattern: /剑/, weapon: "longsword" },
  { pattern: /法杖|杖/, weapon: "quarterstaff" },
  // CoC 武器
  { pattern: /左轮|\.38|手枪/, weapon: ".38左轮" },
  { pattern: /霰弹|霰弹枪|12号/, weapon: "12号霰弹枪" },
  { pattern: /拳头|徒手|肉搏/, weapon: "格斗(肉搏)" },
];

/** 从输入中提取目标名（返回匹配的第一个目标词） */
function extractTarget(input: string, action: string): string | undefined {
  for (const t of TARGET_PATTERNS) {
    if (input.includes(t)) return t;
  }
  // 攻击类：取动词后的文本做模糊目标
  if (action === "attack") {
    const match = input.match(/(?:攻击|砍|刺|射|劈|斩)\s*(.{1,6})$/);
    if (match && match[1].length >= 1) return match[1];
  }
  // 移动类：取"到/向/往/去"后面的内容
  if (action === "move") {
    const match = input.match(/(?:到|向|往|去)\s*(.{2,10})$/);
    if (match && match[1].length >= 1) return match[1].trim();
    // "去谷仓" → "谷仓"
    const match2 = input.match(/^去\s*(.{2,10})$/);
    if (match2 && match2[1].length >= 1) return match2[1].trim();
  }
  // 对话类：取"和/跟/与/对"和"说/问"之间的内容
  if (action === "talk") {
    const match = input.match(/(?:和|跟|与|对)\s*(.{2,6})\s*(?:说话|交谈|对话|聊聊|询问|问)/);
    if (match && match[1].length >= 1) return match[1].trim();
  }
  // 施法类：取法术名（动词后的内容）
  if (action === "cast") {
    const match = input.match(/(?:施放|施展|释放|使用|吟唱|念咒|施法)\s*(.{2,12})$/);
    if (match && match[1].length >= 1) return match[1].trim();
  }
  // 神话法术类：念咒/吟唱是命令前缀；其余动词可以是 canonical 名称的一部分。
  if (action === "occult_cast") {
    const incantation = input.match(/(?:念咒|吟唱)\s*(.{1,12})$/);
    if (incantation && incantation[1].length >= 1) return incantation[1].trim();
    const canonical = input.match(/(?:召唤|呼唤|驱逐|放逐)\s*(.{1,12})$/);
    if (canonical && canonical[0].length >= 1) return canonical[0].trim();
  }
  return undefined;
}

/** 从输入中提取燃运点数，返回 { luckSpend, remainingInput } */
function extractLuckSpend(input: string): { luckSpend: number; remaining: string } {
  // 模式: "燃运N" / "用N点幸运" / "消耗N幸运" / "luck N"
  const m = input.match(/(?:燃运|消耗幸运|用幸运)\s*(\d+)(?:点)?/);
  if (m) {
    const pts = parseInt(m[1]);
    const remaining = input.replace(m[0], "").trim();
    return { luckSpend: pts, remaining };
  }
  const m2 = input.match(/luck\s+(\d+)/i);
  if (m2) {
    const pts = parseInt(m2[1]);
    const remaining = input.replace(m2[0], "").trim();
    return { luckSpend: pts, remaining };
  }
  return { luckSpend: 0, remaining: input };
}

function parseIntentRegex(input: string): ActionIntent {
  // 先提取燃运，再用剩余文本匹配意图
  const luckExtract = extractLuckSpend(input);
  const effectiveInput = luckExtract.remaining || input;
  const luckSpend = luckExtract.luckSpend;
  for (const { verb, intent, requiresTarget } of INTENT_PATTERNS) {
    const verbMatch = effectiveInput.match(verb);
    if (!verbMatch) continue;
    // console.log(`  [parseIntentRegex] match: ${effectiveInput} → action=${intent.action}`);

    // 如果需要特定目标词但找不到，跳过这个模式（继续尝试下一个）
    if (requiresTarget && !TARGET_PATTERNS.some(t => effectiveInput.includes(t))) continue;

    const target = extractTarget(effectiveInput, intent.action || "");
    let weapon: string | undefined;
    for (const { pattern: wp, weapon: w } of WEAPON_PATTERNS) {
      if (wp.test(effectiveInput)) { weapon = w; break; }
    }

    // 对 cast / occult_cast 动作提取法术名（target 字段存法术名，同时设 spell 字段）
    let spell = (intent.action === "cast" || intent.action === "occult_cast") ? target : undefined;

    // 瞄准部位提取
    const calledShot = extractCalledShot(effectiveInput);

    return {
      action: intent.action || "unknown",
      target,
      spell,
      weapon,  // 仅在输入显式指定时设置；默认由战斗处理器根据角色职业决定
      method: intent.method,
      skill: intent.skill,
      ability: intent.ability,
      dc: intent.dc,
      reason: intent.reason,
      luckSpend: luckSpend || undefined,
      calledShot,
      item: verbMatch[1] || intent.item,
    };
  }
  return { action: "unknown", luckSpend: luckSpend || undefined };
}

// ============================================================
// LLM 驱动解析
// ============================================================

const INTENT_SYSTEM_PROMPT = `你是一个 TRPG 意图解析器。分析玩家的中文输入，提取为结构化 JSON。

支持的动作类型 (action):
- "attack" — 攻击、砍、刺、射、施法攻击
- "move" — 移动、走、跑、前往
- "cast" — 施法、使用法术/魔法
- "skill_check" — 技能检定（侦查、潜行、说服、调查等）
- "san_check" — SAN 检定/理智检定（目睹恐怖、疯狂、恐惧）
- "saving_throw" — D&D 豁免检定（抵抗毒素/法术/陷阱/恐惧等）
- "talk" — 对话、交谈、询问 NPC
- "use_item" — 使用物品、道具、绷带、急救包
- "rest" — 休息、休整、治疗、睡觉（恢复 HP/SAN）
- "look" — 观察、环顾四周、查看环境
- "flee" — 逃跑、逃走、脱离战斗（CoC 模式触发追逐）
- "chase" — 追逐行动、跑、追（在追逐中继续逃跑或追击）
- "status" — 角色状态、属性、角色卡
- "inventory" — 仅限玩家自己的背包/物品栏；场景里的容器（冰箱、储物柜、
  抽屉等）不算，即使用了"清点""查看"这类相似措辞
- "pickup" — 捡起、拾取物品
- "help" — 帮助、操作指南
- "reload" — 装填弹药、换弹匣
- "first_aid" — 急救、包扎伤口
- "push" — 推动检定（失败后重试）
- "occult_cast" — 克苏鲁神话咒文、吟唱召唤/驱逐咒语
- "spell_list" — 查看已知法术/咒文列表
- "generate_story" — 生成新故事/场景/模组
- "create_character" — 创建角色、车卡、我要当调查员
- "list_occupations" — 职业列表、有哪些职业
- "allocate_skills" — 分配技能、调整技能点、手动分配技能
- "buy" — 购买物品（CoC 商店购买道具/装备）
- "sell" — 出售物品、卖东西
- "skill_advancement" — 模组结算、技能成长（在模组结束时投成长骰）
- "legacy" — 传承系统、继承角色、保存角色、读档、存档
- "load_module" — 加载/导入模组、剧本杀
- "view_module" — 查看模组详情、模组预览、模组内容
- "unknown" — 无法识别

方法 (method, 可选):
- "melee" — 近战
- "ranged" — 远程
- "stealth" — 偷袭/潜行
- "aimed" — 瞄准/专注（增加暴击率，配合 calledShot 指定部位）

技能 (skill, 可选, 仅 skill_check 时填写):
stealth, perception, investigation, persuasion, medicine, history, occult, library_use

saving_throw 时额外字段:
- ability: 属性名 "strength" | "dexterity" | "constitution" | "intelligence" | "wisdom" | "charisma"
- dc: 目标 DC（数字，可选）
- reason: 豁免原因（如"对抗毒素""抵抗法术"）

目标名 (target) 提取原文字符串。
武器名 (weapon) 提取为英文: shortsword, longsword, dagger, longbow, fist。

san_check 时额外字段:
- sanCost: SAN 损失格式 "1/1d6"（成功/失败）
- reason: 检定原因的中文字符串

cast 时额外字段:
- spell: 法术名（中文，如"魔法飞弹""燃烧之手""治疗伤势"）

CoC 额外字段:
- luckSpend: 燃运点数（数字，玩家说"燃运5"时设为5）
- weaponName: CoC 武器名（中文，如".38左轮""12号霰弹枪""格斗(肉搏)"）
- calledShot: 瞄准部位（字符串，如"头部""腿部""腹部""胸部""右臂""左腿""武器""眼睛"）

物品动作额外字段:
- item: 购买、出售、使用、拾取、装备或卸下的物品名

只输出 JSON，不要任何额外文字。格式:
{"action":"attack","target":"哥布林","weapon":"shortsword","method":"melee"}`;

// The model only classifies a normal-session ActionIntent.  It never receives
// a compiled catalog, an action command, or an execution capability.  Keep the
// accepted action labels in sync with the ordinary regex parser rather than
// accepting arbitrary strings which can reach GameSession.handleIntent().
const NORMAL_INTENT_ACTIONS = new Set([
  "allocate_skills", "attack", "buy", "cast", "chase", "create_character",
  "equip", "first_aid", "flee", "generate_story", "help", "insanity_guidance",
  "inventory", "legacy", "list_occupations", "load_module", "look", "move",
  "occult_cast", "pickup", "push", "read", "reload", "rest", "san_check",
  "saving_throw", "sell", "shop", "skill_advancement", "skill_check", "spell_list",
  "status", "talk", "unequip", "unknown", "use_item", "view_module",
] as const);

const NORMAL_INTENT_REPLY_KEYS: ReadonlySet<string> = new Set([
  "action", "target", "weapon", "method", "skill", "ability", "dc", "sanCost",
  "reason", "spell", "luckSpend", "weaponName", "calledShot", "item",
] as const);

const NORMAL_INTENT_METHODS = new Set([
  "melee", "ranged", "stealth", "aimed", "burst", "suppress",
] as const);

const NORMAL_INTENT_SKILLS = new Set([
  "stealth", "perception", "investigation", "persuasion", "medicine", "history", "occult",
  "library_use", "listen", "intimidate", "charm", "fast_talk", "psychoanalysis",
] as const);

const NORMAL_INTENT_ABILITIES = new Set([
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
] as const);

// These are the values already emitted by WEAPON_PATTERNS.  weaponName remains
// a bounded display string because CoC weapon names are module/game data, not a
// second executable action vocabulary.
const NORMAL_INTENT_WEAPONS = new Set([
  "shortsword", "longsword", "dagger", "longbow", "quarterstaff", ".38左轮", "12号霰弹枪", "格斗(肉搏)",
] as const);

const NORMAL_INTENT_CALLED_SHOTS = new Set([
  "头部", "胸部", "腹部", "左腿", "右腿", "左臂", "右臂", "武器", "眼睛",
] as const);

const MAX_NORMAL_INTENT_TEXT_CHARS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedIntentText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_NORMAL_INTENT_TEXT_CHARS;
}

function isKnownString(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === "string" && allowed.has(value);
}

function isSafeIntentInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isSafeSanCost(value: unknown): value is string {
  if (!isBoundedIntentText(value)) return false;
  const costs = value.split("/");
  if (costs.length !== 2) return false;
  return costs.every((cost) => {
    const match = /^(\d+)(?:d(\d+))?$/.exec(cost);
    if (!match) return false;
    const count = Number(match[1]);
    const sides = match[2] === undefined ? undefined : Number(match[2]);
    return Number.isSafeInteger(count) && count >= 0 && count <= 100
      && (sides === undefined || Number.isSafeInteger(sides) && sides >= 1 && sides <= 100);
  });
}

/**
 * Project one untrusted model object into the normal ActionIntent contract.
 *
 * This intentionally does not reuse compiled-action-intent's parser: compiled
 * replies select an allowlisted mechanism and fail closed, while ordinary
 * sessions retain their established regex degradation behavior.  Both paths
 * nevertheless reject unknown keys and values before anything reaches a
 * handler.
 */
function parseNormalIntentReply(value: unknown): ActionIntent | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (!keys.includes("action") || !keys.every((key) => NORMAL_INTENT_REPLY_KEYS.has(key))) return null;
  if (!isKnownString(value.action, NORMAL_INTENT_ACTIONS)) return null;
  if ("target" in value && !isBoundedIntentText(value.target)) return null;
  if ("weapon" in value && !isKnownString(value.weapon, NORMAL_INTENT_WEAPONS)) return null;
  if ("method" in value && !isKnownString(value.method, NORMAL_INTENT_METHODS)) return null;
  if ("skill" in value && !isKnownString(value.skill, NORMAL_INTENT_SKILLS)) return null;
  if ("ability" in value && !isKnownString(value.ability, NORMAL_INTENT_ABILITIES)) return null;
  if ("dc" in value && !isSafeIntentInteger(value.dc, 0, 100)) return null;
  if ("sanCost" in value && !isSafeSanCost(value.sanCost)) return null;
  if ("reason" in value && !isBoundedIntentText(value.reason)) return null;
  if ("spell" in value && !isBoundedIntentText(value.spell)) return null;
  if ("luckSpend" in value && !isSafeIntentInteger(value.luckSpend, 0, 100)) return null;
  if ("weaponName" in value && !isBoundedIntentText(value.weaponName)) return null;
  if ("calledShot" in value && !isKnownString(value.calledShot, NORMAL_INTENT_CALLED_SHOTS)) return null;
  if ("item" in value && !isBoundedIntentText(value.item)) return null;

  return {
    action: value.action,
    ...("target" in value ? { target: value.target as string } : {}),
    ...("weapon" in value ? { weapon: value.weapon as string } : {}),
    ...("method" in value ? { method: value.method as string } : {}),
    ...("skill" in value ? { skill: value.skill as string } : {}),
    ...("ability" in value ? { ability: value.ability as string } : {}),
    ...("dc" in value ? { dc: value.dc as number } : {}),
    ...("sanCost" in value ? { sanCost: value.sanCost as string } : {}),
    ...("reason" in value ? { reason: value.reason as string } : {}),
    ...("spell" in value ? { spell: value.spell as string } : {}),
    ...("luckSpend" in value ? { luckSpend: value.luckSpend as number } : {}),
    ...("weaponName" in value ? { weaponName: value.weaponName as string } : {}),
    ...("calledShot" in value ? { calledShot: value.calledShot as string } : {}),
    ...("item" in value ? { item: value.item as string } : {}),
  };
}

/**
 * Shared strict projection for persisted ordinary-session intents.  Snapshot
 * restore must use the same executable vocabulary as model replies, not accept
 * ActionIntent's intentionally broad TypeScript shape as an untrusted record.
 */
export function validateNormalSessionActionIntent(value: unknown): ActionIntent {
  const intent = parseNormalIntentReply(value);
  if (!intent) throw new Error("invalid normal-session ActionIntent");
  return structuredClone(intent);
}

export const NORMAL_SESSION_INTENT_TIMEOUT_MS = 15_000;
export const NORMAL_SESSION_INTENT_MAX_TOKENS = 128;

export type NormalSessionIntentPolicy = "preferred" | "required" | "development_fallback";
/** The narrow capability GameSession needs from its host-selected intent client. */
export type NormalSessionIntentClient = Pick<LLMClient, "chat">;
export type IntentProvenance = "model" | "regex_offline" | "regex_invalid" | "regex_error";

export type NormalIntentResolution =
  | { status: "resolved"; intent: ActionIntent; provenance: IntentProvenance; latencyMs: number }
  | { status: "unavailable"; errorCode: string; latencyMs: number }
  | { status: "invalid"; errorCode: "intent_reply_invalid"; latencyMs: number };

class IntentReplyInvalidError extends Error {
  constructor() {
    super("LLM returned an invalid intent reply");
    this.name = "IntentReplyInvalidError";
  }
}

async function parseIntentLLM(
  input: string,
  llm: NormalSessionIntentClient
): Promise<ActionIntent> {
  const raw = await llm.chat(
    [
      { role: "system", content: INTENT_SYSTEM_PROMPT },
      { role: "user", content: input },
    ],
    {
      temperature: 0.1,
      maxTokens: NORMAL_SESSION_INTENT_MAX_TOKENS,
      timeout: NORMAL_SESSION_INTENT_TIMEOUT_MS,
      maxAttempts: 1,
      jsonMode: true,
      workload: "intent",
    }
  );

  // ⚠ 曾经这里是裸 `JSON.parse(raw.trim())`：LLM 把合法 JSON 裹进 ```json
  // 围栏（哪怕已经传了 jsonMode: true，实测仍会发生）就直接抛异常，
  // 静默退化到下面的 regex 兜底——而 regex 里贪婪的 /追/ 会把"追问 NPC"
  // 误判成"chase"（追逐），一次对话请求变成一次追逐判定，是本仓一次
  // 真实事故的直接根因。改用 extractJson：能剥围栏、也兼容不裹围栏的
  // 裸 JSON，两种形态都不必再退化到 regex。
  const parsed = extractJson(raw);
  const intent = parseNormalIntentReply(parsed);
  if (intent) return intent;
  throw new IntentReplyInvalidError();
}

// ============================================================
// 统一入口
// ============================================================

let _llmClient: LLMClient | null = null;

export function setIntentLLM(client: LLMClient | null) {
  _llmClient = client;
}

/**
 * Whether the CLI/legacy global parseIntent() client has been configured.
 * GameSession never reads or writes this singleton: its client is session-bound.
 */
export function intentLLMConfigured(): boolean {
  return _llmClient !== null;
}

/**
 * 起手声明：一次性说清楚这一局的意图解析走哪条路，不是每次调用都打。
 *
 * ⚠ 「零条 [intent] warn」曾经同时符合两种状态——LLM 接上了且全对，
 * 或者 LLM 根本没接、全程 regex——日志上完全一样。上一轮加的两处
 * warn（LLM 抛错/返回非法 JSON 时）解决的是"LLM 失败"的可观测性，
 * 但 `_llmClient` 为 null 时 `parseIntent()` 连 try 都不进，两处 warn
 * 都摸不到，"没接"本身反而是最沉默的那种状态。
 *
 * 同类前科：世界模型门禁不能断言 `loaded`，因为懒加载时 false 是正常态——
 * 「静默 = 健康」的假设在这仓库已经错过一次。这次同样不能靠"没打印"
 * 反推"一切正常"，得有一条明确的、能唯一反推走哪条路的声明。
 *
 * GameSession calls this once with its own client after selecting its local
 * route. Legacy callers may omit the argument to declare the CLI global route.
 */
export function declareIntentPath(client: NormalSessionIntentClient | null = _llmClient): void {
  if (client) {
    log.info("intent", "本局意图解析走 LLM（LLMClient 接缝已配置）");
    return;
  }
  // A null selected client has two distinct causes; the log must distinguish them:
  //   · llmEnabled() 为假——没 key，或被 LLM_DISABLED/LLM_MODE 显式关掉
  //   · llmEnabled() 为真但接缝仍未配置——本局候选的 client 不是
  //     LLMClient（MockLLMClient/占位 key）
  const reason = !llmEnabled()
    ? "llmEnabled() 为 false（无 key，或被 LLM_DISABLED/LLM_MODE 关掉）"
    : "LLMClient 接缝未配置（本局用的是 MockLLMClient/占位 key）";
  log.warn("intent", `本局意图解析全程走 regex，不会调用 LLM：${reason}`);
}

/**
 * 显式命令前缀 —— 意图由前缀唯一确定，不交给模型判断。
 *
 * 「加载模组 阿卡姆档案检查」曾被判成技能检定：模组名里的「检查」把模型带偏，
 * handleSkillCheck 抢先 return，该模组因此永远加载不了。前缀已经给出确定答案，
 * 再问一遍模型只会引入这类误判 —— 名字里含「攻击」「移动」的模组同样会中招。
 */
export function isExplicitLoadModuleIntent(input: string): boolean {
  return parseOrdinaryLocalCommand(input)?.kind === "load_module";
}

/**
 * Resolve a normal ActionIntent without executing it. Required callers receive
 * a typed refusal instead of silently changing interpretation to regex.
 */
export async function resolveNormalSessionIntent(
  input: string,
  client: NormalSessionIntentClient | null,
  policy: NormalSessionIntentPolicy,
): Promise<NormalIntentResolution> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  // API-required sessions can only bypass classification through the
  // GameSession-owned catalog validation performed before this resolver.
  // Legacy/preferred callers retain the historical explicit module command.
  if (policy !== "required" && isExplicitLoadModuleIntent(input)) {
    return { status: "resolved", intent: { action: "load_module" }, provenance: "regex_offline", latencyMs: elapsed() };
  }
  if (!client) {
    if (policy === "required") return { status: "unavailable", errorCode: "intent_client_unavailable", latencyMs: elapsed() };
    return { status: "resolved", intent: parseIntentRegex(input), provenance: "regex_offline", latencyMs: elapsed() };
  }
  try {
    return { status: "resolved", intent: await parseIntentLLM(input, client), provenance: "model", latencyMs: elapsed() };
  } catch (error) {
    if (error instanceof IntentReplyInvalidError) {
      if (policy === "required") return { status: "invalid", errorCode: "intent_reply_invalid", latencyMs: elapsed() };
      log.warn("intent", "LLM 意图 JSON 无效，退化到 regex [code=intent_reply_invalid]");
      return { status: "resolved", intent: parseIntentRegex(input), provenance: "regex_invalid", latencyMs: elapsed() };
    }
    if (error instanceof LLMClientError && error.code === "invalid_response") {
      if (policy === "required") return { status: "invalid", errorCode: "intent_reply_invalid", latencyMs: elapsed() };
      log.warn("intent", "LLM returned an empty or malformed completion; falling back to regex");
      return { status: "resolved", intent: parseIntentRegex(input), provenance: "regex_invalid", latencyMs: elapsed() };
    }
    const errorCode = error instanceof LLMClientError
      ? `intent_${error.code}`
      : "intent_request_failed";
    if (policy === "required") return { status: "unavailable", errorCode, latencyMs: elapsed() };
    log.warn("intent", `LLM intent request failed; falling back to regex [code=${errorCode}]`);
    return { status: "resolved", intent: parseIntentRegex(input), provenance: "regex_error", latencyMs: elapsed() };
  }
}

/**
 * Parse with an explicitly supplied client. GameSession uses this to keep a
 * session's request on that session's LLM configuration instead of the CLI
 * compatibility singleton below.
 */
export async function parseIntentWithLLM(input: string, client: NormalSessionIntentClient | null): Promise<ActionIntent> {
  const resolution = await resolveNormalSessionIntent(input, client, "preferred");
  return resolution.status === "resolved" ? resolution.intent : parseIntentRegex(input);
}

/** CLI and legacy callers keep their module-level configured client. */
export async function parseIntent(input: string): Promise<ActionIntent> {
  return parseIntentWithLLM(input, _llmClient);
}

// 保留旧接口兼容
export { parseIntentRegex as llmParseIntent };
