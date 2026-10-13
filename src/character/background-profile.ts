// CoC 7e 车卡背景故事生成
// 1. 随机人名（1920s 美国风格，模组时代/地域适用）
// 2. 八项背景元素模板池（形象描述/思想与信念/重要之人/意义非凡之地/宝贵之物/特质/伤口疤痕/恐惧症躁狂症）
// 3. 由八项合成基础背景故事（纯模板，无 LLM——供 play-module LLM 增强前兜底）
// ============================================================

import type { CharacterArchetype } from "./character-factory";
import type { BackgroundProfile } from "./coc-character";
import { drawRandomUnit, type RandomUnit } from "./random-unit";

// ============================================================
// 随机人名池（1920s 美式音译名 + 姓氏）
// ============================================================

/**
 * 名字池**按性别分开**。
 *
 * 原先是一个混排数组（前 24 个男名、后 16 个女名），而 `randomCoCName`
 * 只返回 `{ full, short }` —— **引擎无从知道这个角色是男是女**。
 * 后果直接落在开场叙述上：`barn-of-premier` 的两条 hook 都写死「他」，
 * 于是「玛丽·布朗……作为飞行员，**他**见过太多案子」。
 * 那不是模板写得糙，是**数据里根本没有可依据的东西**，
 * 模板作者除了写死没有别的选择。
 *
 * 分开之后代词有据可依，模板才谈得上写对。
 */
export const MALE_FIRST_NAMES = [
  "亨利", "约翰", "威廉", "詹姆斯", "查尔斯", "乔治", "托马斯", "罗伯特",
  "爱德华", "亚瑟", "弗雷德", "沃尔特", "哈罗德", "雷蒙德", "欧内斯特", "塞缪尔",
  "霍华德", "克拉伦斯", "艾伯特", "路易斯", "埃德温", "伦纳德", "维克托", "斯坦利",
];

export const FEMALE_FIRST_NAMES = [
  "玛丽", "玛格丽特", "伊丽莎白", "海伦", "艾丽丝", "露丝", "克拉拉", "弗洛伦斯",
  "埃塞尔", "莉莲", "格蕾丝", "艾达", "贝西", "多萝西", "米尔德丽德", "艾格尼丝",
];

const FIRST_NAMES = [...MALE_FIRST_NAMES, ...FEMALE_FIRST_NAMES];

const LAST_NAMES = [
  "摩根", "卡特", "史密斯", "约翰逊", "威廉姆斯", "布朗", "琼斯", "米勒",
  "戴维斯", "威尔逊", "泰勒", "安德森", "托马斯", "杰克逊", "怀特", "哈里斯",
  "马丁", "汤普森", "加西亚", "罗宾逊", "克拉克", "罗德里格斯", "刘易斯", "李",
  "沃克", "霍尔", "艾伦", "杨", "金", "赖特", "斯科特", "格林",
  "贝克", "亚当斯", "纳尔逊", "希尔", "拉米雷斯", "坎贝尔", "米切尔", "罗伯茨",
];

const OCCUPATION_FIRST_NAMES: Record<string, string[]> = {
  doctor_medicine: ["亨利", "约翰", "威廉", "塞缪尔", "艾伯特", "海伦", "玛格丽特"],
  detective: ["亨利", "约翰", "沃尔特", "雷蒙德", "霍华德", "格蕾丝", "艾丽丝"],
  soldier: ["威廉", "詹姆斯", "乔治", "斯坦利", "维克托", "露丝", "贝西"],
  professor: ["艾伯特", "塞缪尔", "爱德华", "亚瑟", "克拉拉", "多萝西"],
  journalist_coc: ["弗雷德", "雷蒙德", "路易斯", "埃德温", "艾丽丝", "格蕾丝"],
  driver: ["伦纳德", "维克托", "斯坦利", "埃德温", "米尔德丽德"],
};

function pick<T>(arr: T[], randomUnit: RandomUnit = Math.random): T {
  return arr[Math.floor(drawRandomUnit(randomUnit) * arr.length)];
}

export type Gender = "male" | "female";

/** 这个名字是男名还是女名。认不出时返回 undefined —— 不猜 */
export function genderOfFirstName(first: string): Gender | undefined {
  if (MALE_FIRST_NAMES.includes(first)) return "male";
  if (FEMALE_FIRST_NAMES.includes(first)) return "female";
  return undefined;
}

/** 第三人称代词。认不出性别时用「他」的中性写法，别瞎猜 */
export function pronounOf(gender: Gender | undefined): string {
  return gender === "female" ? "她" : "他";
}

/**
 * 随机人名：`{ full: "亨利·摩根", short: "亨利", gender: "male" }`
 *
 * `gender` 是这次补上的。原先只返回名字，叙述模板想写对代词也无从写起，
 * 只能一律「他」——「玛丽·布朗……**他**见过太多案子」就是这么来的。
 */
export function randomCoCName(archetypeId?: string): { full: string; short: string; gender: Gender | undefined } {
  const pool = archetypeId && OCCUPATION_FIRST_NAMES[archetypeId]
    ? OCCUPATION_FIRST_NAMES[archetypeId]
    : FIRST_NAMES;
  const first = pick(pool);
  const last = pick(LAST_NAMES);
  return { full: `${first}·${last}`, short: first, gender: genderOfFirstName(first) };
}

// ============================================================
// 八项背景元素模板池（按职业类别分组）
// ============================================================

interface OccupationProfileTemplates {
  /** 形象描述 */
  appearance: string[];
  /** 思想与信念 */
  beliefs: string[];
  /** 重要之人 */
  significantPeople: string[];
  /** 意义非凡之地 */
  meaningfulPlace: string[];
  /** 宝贵之物 */
  treasuredPossession: string[];
  /** 特质 */
  traits: string[];
  /** 伤口和疤痕 */
  woundsAndScars: string[];
  /** 恐惧症和躁狂症 */
  phobiasAndManias: string[];
}

// 职业 → 模板组。匹配 archetype.id；未命中用通用组。
const PROFILE_POOLS: Record<string, OccupationProfileTemplates> = {
  // ── 执法/调查类 ──
  detective: {
    appearance: [
      "瘦高的身形裹在灰呢大衣里，帽子压得很低，手上常年有烟渍。",
      "中等身材，目光锐利而疲惫，嘴角一道旧疤让人看起来比实际年龄更老。",
      "衣着整洁但旧，大衣袖口磨得发亮，走路时习惯贴着墙根。",
    ],
    beliefs: ["只信证据，不信巧合。每桩案子背后都有人，只是还没找到。", "世界是按规矩运转的——规矩被打破的地方，就是该去的地方。", "人都会说谎，证据不会。这是从警局学到的最重要一课。"],
    significantPeople: ["当年的搭档，离开警局时还替人扛过一次处分。", "常光顾的当铺老板，消息灵通，从不问多余的问题。", "妹妹——她已经三年没回信了，但一直留着她的信。"],
    meaningfulPlace: ["警局的审讯室，光线刺眼，曾在那里听过无数种谎言。", "码头区一家快打烊的咖啡馆，习惯在那里复盘卷宗。", "老家那座废弃的火车站，少年时代常去那里发呆。"],
    treasuredPossession: ["父亲留下的怀表，指针早已停摆。", "一本贴满剪报的笔记本，记着经手过的每桩案子。", "一枚旧警徽，离职时没有上交。"],
    traits: ["沉默寡言，观察入微，惯独自行动。", "戒心重，但认定的人会毫无保留。", "耐心极好，能盯一个目标一整天。"],
    woundsAndScars: ["左肩的旧枪伤，阴雨天就隐隐作痛。", "右手两根手指曾被门夹断过，接回后有些不听使唤。", "一道从左眉延伸到颧骨的疤痕，是某次追捕时留下的。"],
    phobiasAndManias: ["恐高，但从不承认。", "对被人跟踪有近乎偏执的警觉——总会反复确认身后没人。", "一旦开始调查某个细节，就停不下来，直到挖出真相。"],
  },
  doctor_medicine: {
    appearance: [
      "白大褂洗得发白，听诊器常年挂在脖子上，眼神温和却透着专业。",
      "身形微胖，面容和善，但看人的时候像在诊断。",
      "头发梳得一丝不苟，袖口永远挽到小臂，指尖有消毒水的气味。"],
    beliefs: ["救人是本分，不是功劳。每一具尸体都在说话。", "人体是最诚实的——它不会编造病症。", "只要还有一口气，就还没到放弃的时候。"],
    significantPeople: ["战地医院的老师，教会了'先处理最致命的伤'。", "护士长，在最难熬的战争年代一直站在身边。", "一位没能救回来的病人——至今仍记得那张脸。"],
    meaningfulPlace: ["战地医院的手术台，血迹和呻吟声至今历历在目。", "镇上诊所的候诊室，在这里见过半座小镇的人生。", "医学院的解剖教室，信仰在那里建立。"],
    treasuredPossession: ["一套从不离身的旧手术器械，是老师留下的。", "泛黄的笔记本，密密麻麻记着每个病例。", "一枚军医的臂章，褪了色但洗得干干净净。"],
    traits: ["理性沉稳，学术派，紧张时反而更冷静。", "对病痛有近乎病态的责任感。", "说话直接，不擅长安慰人，但从不敷衍。"],
    woundsAndScars: ["左手腕一道深深的手术疤痕，是自己缝的。", "战争时期弹片留下的旧伤，走路微跛。", "指节上有常年握手术钳磨出的茧。"],
    phobiasAndManias: ["害怕看到血，却每天都要面对血——从不提起。", "对消毒水的气味有强迫性的依赖。", "无法接受'无能为力'，会把每个失败病例反复复盘到深夜。"],
  },
  soldier: {
    appearance: [
      "身板笔直，肩膀宽阔，站姿永远是标准军姿，皮肤晒得黝黑。",
      "壮实的身躯上叠着旧军装，走路带着战场上的警觉。",
      "短发，目光坚定，双手粗粝，指节上有老茧。"],
    beliefs: ["命令就是命令，但良心的事，自己担着。", "战场上活下来的人欠死去的战友一条命。", "秩序与纪律——没有它们，人比野兽还糟。"],
    significantPeople: ["排长，替他们挡了那颗炮弹。", "同乡的战友，两个人都活着回来了，却都不愿再提那场仗。", "家里的老母亲，写信时总说'一切都好'。"],
    meaningfulPlace: ["战壕里最深处的那段掩体，曾在那里失去了最好的朋友。", "入伍前的农场，麦田尽头是母亲的炊烟。", "退伍后常去的酒馆角落，能看见门口进出的人。"],
    treasuredPossession: ["战友的军牌，一直贴身带着。", "一把擦得锃亮的老式刺刀，是排长的遗物。", "褪色的全家福，被血渍染过一角。"],
    traits: ["纪律严明，行动果断，不轻易流露情绪。", "护短，对认定的队友掏心掏肺。", "警觉性极高，睡觉时都留着一只耳朵。"],
    woundsAndScars: ["左肋的弹片伤，至今还有碎片取不出来。", "后背一道长长的刀疤，是拼刺刀时留下的。", "右耳听力受损，战场上被炮震的。"],
    phobiasAndManias: ["怕密闭空间——战壕的记忆会突然涌上来。", "对突然的巨响反应过度，会本能地找掩体。", "强迫性地检查门窗是否锁好，每晚三次。"],
  },
  professor: {
    appearance: [
      "花白头发，金丝眼镜，三件套西装总带着粉笔灰。",
      "清瘦，驼背，衣领永远翻不齐，但眼神明亮。",
      "头发梳得讲究，手里常夹着一支没点着的烟斗。"],
    beliefs: ["知识是唯一的救赎。未知之物只是尚未被命名的已知。", "每个谜团都有答案，只要找对研究方法。", "启蒙与理性——这是人类对抗黑暗的武器。"],
    significantPeople: ["导师，教会了'怀疑一切'，包括自己的结论。", "图书馆管理员，保留了许多绝版手稿。", "早逝的同事，两人曾计划合著一本书，终究没能完成。"],
    meaningfulPlace: ["大学图书馆的善本室，霉味和羊皮纸的气息让人安心。", "书房的窗边，那里放着所有未完成的论文。", "年轻时游学的希腊遗迹，曾在那里第一次触摸到古物。"],
    treasuredPossession: ["一本签名版的《死者之书》——当然，只是译本。", "祖传的放大镜，镜框包浆温润。", "一叠手稿，是毕生研究的全部心血。"],
    traits: ["博学而固执，学术上的争论寸步不让。", "好奇心旺盛，为了一个答案可以翻遍整座图书馆。", "不善社交，但讲到专业话题会滔滔不绝。"],
    woundsAndScars: ["右手腕的旧伤，年轻时翻古物被砸伤，写字久了会抖。", "胃病——常年伏案、三餐不定。", "左眼视力受损，读古籍熬坏了。"],
    phobiasAndManias: ["怕火——童年家里失过火。", "对'未知'有偏执的求知欲，越禁忌越想弄明白。", "强迫性地整理书架，顺序乱了会坐立不安。"],
  },
  journalist_coc: {
    appearance: [
      "风衣口袋里塞满笔记本和铅笔，领带永远歪着，眼神像猎犬。",
      "瘦削，动作快，说话也快，随身带着一台老式相机。",
      "不修边幅，帽檐下的眼睛却从不放过任何细节。"],
    beliefs: ["真相值得付出代价——哪怕别人不想让它被看见。", "每个人都有自己的故事，问题是怎么挖出来。", "铅字的力量，比枪弹更持久。"],
    significantPeople: ["主编，虽然总骂人，但从不砍稿。", "线人，那个总在深夜来电的神秘声音。", "被报道改变命运的小人物——欠他们一个公正。"],
    meaningfulPlace: ["报社的排字车间，油墨味就是青春。", "街角那家二十四小时咖啡店，曾在那里赶过无数个截稿日。", "第一次发头版的那个报摊，还记得买了一份藏起来。"],
    treasuredPossession: ["一台老式打字机，按键被磨得发亮。", "剪报本，贴着所有自己署名的文章。", "一个采访本，扉页写着'还债用'。"],
    traits: ["嗅觉敏锐，敢闯敢问，为了新闻可以不眠不休。", "嘴皮子利索，但笔下的真相从不含糊。", "怀疑一切，包括自己亲眼所见。"],
    woundsAndScars: ["采访暴动时被砸伤的后脑，留了一条疤。", "右手腕腱鞘炎，打字多了就疼。", "被威胁过，对方留下的一刀划在手臂上。"],
    phobiasAndManias: ["怕被'挖出'自己的往事——每个人都有不想见光的东西。", "对未接电话有焦虑，总觉得错过重大新闻。", "看到可疑线索就忍不住要追，哪怕已经凌晨三点。"],
  },
  // ── 通用兜底 ──
  generic: {
    appearance: [
      "衣着得体而平凡，丢进人群里也不会引起注意。",
      "身形匀称，举止克制，带着职业习惯的利落。",
      "面容沉静，眼神却总在观察四周。"],
    beliefs: ["世界比表面更复杂，也更有条理。", "谨慎不是懦弱，是活着的前提。", "该做的事，总要有人做。"],
    significantPeople: ["一位过世的亲人，留下的遗物还在身边。", "多年的老友，彼此从不问对方的过去。", "一位恩人，在最低谷时伸过手。"],
    meaningfulPlace: ["老家的旧宅，拆了一半，记忆还完整。", "年轻时待过的城市一角，那里有最好的回忆。", "一间安静的街角书店，常在那里想事情。"],
    treasuredPossession: ["一枚旧硬币，据说能带来好运。", "一封写了没寄出的信。", "一把多功能小刀，用顺手了二十年。"],
    traits: ["冷静克制，观察力强，不轻易表态。", "关键时刻靠得住，平时不显山露水。", "有自己的原则，碰到底线寸步不让。"],
    woundsAndScars: ["右手背一道旧疤，来历从不提起。", "一条腿受过伤，阴雨天会隐隐作痛。", "肩胛上一块烧伤的痕迹，被衣物盖着。"],
    phobiasAndManias: ["怕黑——不是怕黑暗本身，是怕黑暗里的东西。", "对被人从背后接近有本能警觉。", "习惯性地把随身物品清点三遍。"],
  },
};

function poolFor(archetypeId: string): OccupationProfileTemplates {
  return PROFILE_POOLS[archetypeId] ?? PROFILE_POOLS.generic;
}

/** 生成八项背景元素（模板池随机，同步无副作用） */
export function buildBaseBackgroundProfile(archetype: CharacterArchetype, randomUnit: RandomUnit = Math.random): BackgroundProfile {
  const pool = poolFor(archetype.id);
  return {
    appearance: pick(pool.appearance, randomUnit),
    beliefs: pick(pool.beliefs, randomUnit),
    significantPeople: pick(pool.significantPeople, randomUnit),
    meaningfulPlace: pick(pool.meaningfulPlace, randomUnit),
    treasuredPossession: pick(pool.treasuredPossession, randomUnit),
    traits: pick(pool.traits, randomUnit),
    woundsAndScars: pick(pool.woundsAndScars, randomUnit),
    phobiasAndManias: pick(pool.phobiasAndManias, randomUnit),
  };
}

// ============================================================
// 人设锚点（供 LLM 增强时把八项立成一个具体的人）
// ============================================================

export interface PersonAnchors {
  /** 年龄 */
  age: number;
  /** 家庭状况 */
  household: string;
  /** 出身来历 */
  provenance: string;
}

const HOUSEHOLD_POOL = [
  "未婚，独居于镇上租来的公寓",
  "已婚，妻子在镇上邮局工作，两人没有孩子",
  "丧偶，独自拉扯一个十几岁的女儿",
  "鳏居多年，与年迈的母亲同住",
  "已婚多年，儿女都已成年搬去城里",
  "未婚，与弟弟合住，弟弟在铁路上做工",
];

const PROVENANCE_POOL = [
  "本地人，在这座小镇土生土长",
  "战后从欧洲回来，在镇上安顿下来没几年",
  "三年前从大城市搬来，图乡下的清静",
  "祖辈就住在这片土地上，家里有几亩薄田",
  "年轻时去城里闯荡过，几年前又回了镇子",
];

/** 随机生成人设锚点（同步无副作用） */
export function randomPersonAnchors(): PersonAnchors {
  return {
    age: 24 + Math.floor(Math.random() * 29), // 24-52
    household: pick(HOUSEHOLD_POOL),
    provenance: pick(PROVENANCE_POOL),
  };
}

/** 八项 → 基础背景故事（模板拼接，LLM 不可用时的兜底） */
export function composeBackstory(
  profile: BackgroundProfile,
  ctx: { name: string; occupation: string; era: string },
): string {
  const clause = (value: string | undefined): string => value
    ?.trim()
    .replace(/[。！？!?…]+$/u, "")
    .trim() ?? "";
  const sentence = (value: string): string => {
    const content = clause(value);
    return content ? `${content}。` : "";
  };
  const name = clause(ctx.name);
  const occupation = clause(ctx.occupation);
  const era = clause(ctx.era);
  const identity = [
    name,
    era && occupation ? `${era.endsWith("年") ? era : `${era}年`}的${occupation}` : era || occupation,
  ].filter(Boolean).join("，");

  const beliefs = clause(profile.beliefs);

  return [
    sentence(identity),
    sentence(profile.appearance),
    beliefs && sentence(`相信${beliefs}`),
    sentence(profile.significantPeople),
    sentence(profile.meaningfulPlace),
    sentence(profile.treasuredPossession),
    sentence(profile.traits),
    sentence(profile.woundsAndScars),
    sentence(profile.phobiasAndManias),
  ].filter(Boolean).join("");
}
