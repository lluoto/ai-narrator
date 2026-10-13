// CoC 故事/场景生成器
// 基于模板的随机生成，不依赖 LLM
// 输出格式与 GameSession.seedCoCWorld() 兼容
// ============================================================

// ============================================================
// 类型定义
// ============================================================

export type HorrorSubgenre = "lovecraft" | "slasher" | "ghost" | "cult" | "body_horror" | "cosmic";

type StoryLength = "short" | "medium" | "long";

type SceneTheme =
  | "abandoned_house" | "farm" | "forest" | "asylum" | "church"
  | "laboratory" | "library" | "museum" | "warehouse" | "harbor"
  | "mansion" | "cave" | "swamp" | "underground" | "village";

interface StoryConfig {
  /** 故事主题/hook */
  theme?: string;
  /** 恐怖子类型 */
  subgenre: HorrorSubgenre;
  /** 长度 */
  length: StoryLength;
  /** 难度 1-5 */
  difficulty: number;
  /** 是否包含神话生物 */
  includeMythos?: boolean;
  /** 强制包含的元素 */
  requiredElements?: string[];
}

interface SceneOutput {
  id: string;
  name: string;
  description: string;
  lighting: string;
  dangers: string[];
  exits: Array<{ target: string; desc: string; locked: boolean }>;
  isActive: boolean;
  /** 此场景中的物品 */
  items: string[];
  /** 此场景关联的线索 */
  clues: string[];
}

interface EntityOutput {
  id: string;
  name: string;
  type: "npc" | "monster";
  hp: number;
  maxHp: number;
  ac: number;
  status: string[];
  position: string;
  scene_id: string;
  faction: string;
}

export interface GeneratedStory {
  title: string;
  hook: string;
  scenes: SceneOutput[];
  entities: EntityOutput[];
  displayNames: Record<string, string>;
  aliases: Record<string, string>;
  items: Record<string, string[]>;  // sceneId → item names
  /** 线索文本（investigation.yaml 兼容） */
  clueTexts: Array<{
    id: string; type: string; category: string;
    description: string; scene: string;
    coc_primary: string; coc_secondary: string;
    san_cost: string;
  }>;
}

// ============================================================
// 标题生成
// ============================================================

const TITLE_TEMPLATES: Record<HorrorSubgenre, string[]> = {
  lovecraft: [
    "{name}的阴影", "{name}的低语", "{name}之山",
    "星之{name}", "无名之{name}", "黑暗中的{name}",
  ],
  slasher: [
    "{name}之夜", "{name}的屠戮", "血染{name}",
    "{name}的尖叫", "致命{name}",
  ],
  ghost: [
    "{name}的亡灵", "{name}鬼影", "{name}惨案",
    "{name}回响", "诅咒之{name}",
  ],
  cult: [
    "{name}的祭坛", "{name}信徒", "异教{name}",
    "{name}的仪式", "邪神之{name}",
  ],
  body_horror: [
    "{name}的畸变", "血肉{name}", "{name}异变",
    "{name}的侵蚀",
  ],
  cosmic: [
    "深空之{name}", "{name}的维度", "异界{name}",
    "虚空{name}", "不可名状之{name}",
  ],
};

const TITLE_NAMES = [
  "阿卡姆", "印斯茅斯", "敦威治", "金斯波特", "普罗维登斯",
  "塞勒姆", "迷雾湖", "黑水镇", "静默谷", "乌鸦岭",
  "影溪镇", "铁杉谷", "枯木镇", "冷港",
];

function generateTitle(subgenre: HorrorSubgenre): string {
  const templates = TITLE_TEMPLATES[subgenre];
  const tmpl = templates[Math.floor(Math.random() * templates.length)];
  const name = TITLE_NAMES[Math.floor(Math.random() * TITLE_NAMES.length)];
  return tmpl.replace(/\{name\}/g, name);
}

// ============================================================
// 场景生成 — 按主题的环境模板
// ============================================================

export interface SceneTemplate {
  id: string;
  name: string;
  descriptions: string[];
  lighting: string;
  dangers: string[];
  items: string[];
  entities: Array<{
    name: string; type: "npc" | "monster";
    hpMin: number; hpMax: number; ac: number;
    faction: string; status?: string[];
  }>;
  clues: string[];
  exits: string[];  // 可能连接到的场景 ID 模式
  lockedExitChance: number;
}

/**
 * 每个主题对应的场景清单。
 *
 * 15 个 SceneTheme 只有 6 个写了模板，所以类型是 Partial —— 原先标成完整 Record
 * 并不成立，缺的 9 个在类型上被当作存在，生成时取到的却是 undefined。
 * 下面取模板处一直写着 `?? SCENE_TEMPLATES.abandoned_house` 兜底，说明这个缺口
 * 本来就是已知的，只是类型没说实话，那句兜底在类型上反而像是多余的。
 * abandoned_house 单独标成必有，因为它就是那个兜底，编译期即可确保它在。
 */
const SCENE_TEMPLATES: Partial<Record<SceneTheme, SceneTemplate[]>>
  & { abandoned_house: SceneTemplate[] } = {
  abandoned_house: [
    {
      id: "entrance", name: "破败门厅",
      descriptions: [
        "前门虚掩着，门轴发出刺耳的金属声。门厅布满灰尘，墙纸剥落，空气中有一股霉味。",
        "腐朽的门廊通向一间昏暗的大厅。地板吱呀作响，头顶的吊灯摇摇欲坠。",
        "破碎的玻璃门后是一个荒废已久的门厅。墙上的画像已经被岁月侵蚀得面目全非。",
      ],
      lighting: "dim", dangers: ["地板陷阱"],
      items: ["旧钥匙", "手电筒", "半截蜡烛"],
      entities: [],
      clues: ["strange_symbol"],
      exits: ["living_room", "kitchen", "stairs"],
      lockedExitChance: 0,
    },
    {
      id: "living_room", name: "客厅",
      descriptions: [
        "客厅里散落着翻倒的家具。壁炉里有余烬的痕迹。书架上空荡荡的，只有一本日记。",
        "宽敞的客厅被木板封住了窗户。一张大沙发上覆盖着白布，像一排鬼魂。",
        "客厅的地板上有一大片深色污渍。墙上的挂钟已经停了，指针指向 3:33。",
      ],
      lighting: "dark", dangers: [],
      items: ["日记本", "旧照片", "银制烛台"],
      entities: [],
      clues: ["diary_entry", "photo_hint"],
      exits: ["entrance", "dining_room"],
      lockedExitChance: 0,
    },
    {
      id: "kitchen", name: "厨房",
      descriptions: [
        "厨房里有一股腐臭味。水槽里堆满了发霉的餐具。橱柜门敞开着，里面空无一物。",
        "灶台上有一口黑锅，里面的东西已经干了。刀架上的刀具少了几把。",
        "厨房的后门通向外面，但被木板钉死了。墙角有一个通往地窖的活板门。",
      ],
      lighting: "dim", dangers: ["腐烂气味"],
      items: ["罐头食品", "火柴", "厨刀"],
      entities: [],
      clues: [],
      exits: ["entrance", "cellar"],
      lockedExitChance: 0.3,
    },
    {
      id: "stairs", name: "楼梯间",
      descriptions: [
        "木质楼梯向上延伸，消失在黑暗中。每一步都发出令人不安的吱呀声。",
        "楼梯扶手上覆盖着厚厚的蜘蛛网。墙上有一幅褪色的全家福。",
        "楼梯平台处的窗户被打破了，冷风呼啸着灌进来。",
      ],
      lighting: "dark", dangers: ["不稳定的楼梯"],
      items: [],
      entities: [],
      clues: ["family_portrait"],
      exits: ["entrance", "bedroom", "attic"],
      lockedExitChance: 0,
    },
    {
      id: "bedroom", name: "卧室",
      descriptions: [
        "卧室里有一张四柱床，床单凌乱，仿佛有人刚刚离开。梳妆台上有一把发刷。",
        "这个房间明显是孩子的卧室。玩具散落一地，墙角堆着画作。",
        "主卧室的衣柜门敞开着，里面空无一物。地板上有一道拖拽的血痕。",
      ],
      lighting: "dim", dangers: [],
      items: ["发刷", "儿童画作", "旧怀表"],
      entities: [],
      clues: ["child_drawing"],
      exits: ["stairs"],
      lockedExitChance: 0,
    },
    {
      id: "attic", name: "阁楼",
      descriptions: [
        "阁楼里堆满了旧箱子和家具。灰尘厚得让人窒息。角落里有什么东西在移动——可能是老鼠。",
        "低矮的阁楼只能弯腰前行。一扇小窗户透进微弱的光线，照亮了地板上的神秘符号。",
        "阁楼横梁上挂着干枯的草药捆。一只乌鸦的尸体躺在地板上。",
      ],
      lighting: "dark", dangers: ["坍塌风险"],
      items: ["旧箱子", "神秘符号图纸", "草药"],
      entities: [{ name: "巨型乌鸦", type: "monster", hpMin: 8, hpMax: 12, ac: 12, faction: "野兽", status: [] }],
      clues: ["ritual_diagram"],
      exits: ["stairs"],
      lockedExitChance: 0,
    },
    {
      id: "cellar", name: "地窖",
      descriptions: [
        "潮湿的地窖里堆满了木桶和工具。墙壁上渗出水珠。黑暗中传来滴水声。",
        "地窖的泥土地面上有明显的脚印——不止一个人的。角落里有一扇紧锁的铁门。",
        "地窖里弥漫着浓重的血腥味。墙上的符号在黑暗中发出微弱的磷光。",
      ],
      lighting: "dark", dangers: ["Mi-Go"],
      items: ["铁锹", "密封罐", "古老钥匙"],
      entities: [{ name: "米戈", type: "monster", hpMin: 30, hpMax: 45, ac: 16, faction: "犹格斯访客" }],
      clues: ["hidden_tunnel"],
      exits: ["kitchen"],
      lockedExitChance: 0,
    },
    {
      id: "dining_room", name: "餐厅",
      descriptions: [
        "长餐桌上摆放着完整的餐具，仿佛在等待一场永远不会开始的晚宴。",
        "餐厅的吊灯上悬挂着某种干枯的植物。墙上有爪痕。",
      ],
      lighting: "warm_light", dangers: [],
      items: ["银餐具", "红酒"],
      entities: [],
      clues: [],
      exits: ["living_room"],
      lockedExitChance: 0,
    },
  ],

  forest: [
    {
      id: "forest_edge", name: "森林边缘",
      descriptions: [
        "幽暗的森林边缘，古木参天。一条蜿蜒的小径消失在密林深处。",
        "林间空地，月光透过树冠洒下斑驳的光影。远处传来猫头鹰的叫声。",
        "森林入口处有一块残破的路牌，上面的字迹已经模糊不清。",
      ],
      lighting: "moonlight", dangers: ["捕兽夹×2"],
      items: ["路牌碎片", "指南针"],
      entities: [],
      clues: [],
      exits: ["deep_forest", "abandoned_hut"],
      lockedExitChance: 0,
    },
    {
      id: "deep_forest", name: "森林深处",
      descriptions: [
        "密林深处，光线几乎无法穿透树冠。地面上覆盖着厚厚的落叶和苔藓。",
        "古木参天，藤蔓缠绕。空气中弥漫着腐殖质的气味和某种说不清的甜腻香气。",
        "林中有一片被烧焦的空地，草木尽毁。地面刻着奇异的符号。",
      ],
      lighting: "dark", dangers: ["野狼×2"],
      items: ["焦黑的骨头", "神秘护身符"],
      entities: [
        { name: "野狼", type: "monster", hpMin: 8, hpMax: 12, ac: 13, faction: "野兽" },
      ],
      clues: ["burnt_symbols"],
      exits: ["forest_edge", "cave_entrance"],
      lockedExitChance: 0.2,
    },
    {
      id: "abandoned_hut", name: "林中猎屋",
      descriptions: [
        "一间废弃的猎人小屋，屋顶已经塌陷了一半。屋内有一张木床和一座熄灭的火炉。",
        "破败的木屋里堆满了空罐头瓶和酒瓶。墙上挂着一把生锈的猎枪。",
        "猎屋的门虚掩着，屋内有被人翻动过的痕迹。地板上有血迹。",
      ],
      lighting: "dim", dangers: [],
      items: ["猎枪弹药", "猎人日记", "地图碎片"],
      entities: [{ name: "流浪汉", type: "npc", hpMin: 10, hpMax: 14, ac: 10, faction: "中立", status: ["惊恐"] }],
      clues: ["hunter_journal"],
      exits: ["forest_edge"],
      lockedExitChance: 0,
    },
    {
      id: "cave_entrance", name: "洞穴入口",
      descriptions: [
        "一个隐蔽的洞穴入口被藤蔓掩盖。洞穴深处传来滴水声和低沉的嗡鸣。",
        "岩石裂隙通向地下，入口狭窄只容一人通过。岩壁上有人工凿刻的痕迹。",
        "洞穴入口处散落着动物的骨头。一阵冷风从洞内吹出，带着金属味。",
      ],
      lighting: "dark", dangers: [],
      items: ["荧光石", "古老钱币"],
      entities: [],
      clues: ["strange_carving"],
      exits: ["deep_forest", "underground_cavern"],
      lockedExitChance: 0.5,
    },
    {
      id: "underground_cavern", name: "地下洞穴",
      descriptions: [
        "巨大的地下洞穴，钟乳石从顶部垂下。中央有一个地下湖，水面泛着磷光。",
        "洞穴的四壁上布满了发光的苔藓。地面上有巨大的爬行痕迹。",
        "地下溶洞深处，石笋林立。空气中有一股刺鼻的硫磺味。",
      ],
      lighting: "dark", dangers: ["深水"],
      items: ["发光矿石", "古代祭器"],
      entities: [
        { name: "食尸鬼", type: "monster", hpMin: 18, hpMax: 25, ac: 14, faction: "怪物" },
      ],
      clues: ["altar_inscription"],
      exits: ["cave_entrance"],
      lockedExitChance: 0,
    },
  ],

  asylum: [
    {
      id: "main_gate", name: "大门",
      descriptions: [
        "锈蚀的铁门上方写着「圣玛丽精神病院」。铁链和挂锁将大门紧锁。",
        "废弃的精神病院大门敞开着，门卫室里空无一人，窗户破碎。",
        "铁门上的尖刺已经扭曲变形。院内杂草丛生，一条碎石路通向主楼。",
      ],
      lighting: "moonlight", dangers: [],
      items: ["铁丝", "断线钳"],
      entities: [],
      clues: [],
      exits: ["reception", "garden"],
      lockedExitChance: 0.3,
    },
    {
      id: "reception", name: "接待大厅",
      descriptions: [
        "空旷的接待大厅，前台积满灰尘。墙上的时钟停在 4 点整。地面上散落着病历。",
        "大厅里有一股消毒水和霉味混合的气味。地板上有着不明来源的暗色污渍。",
        "接待区的长椅被翻倒。墙上有一幅巨大的壁画，画中人物表情扭曲。",
      ],
      lighting: "dim", dangers: [],
      items: ["病历夹", "院长办公室钥匙", "镇静剂"],
      entities: [],
      clues: ["patient_record"],
      exits: ["main_gate", "ward", "office"],
      lockedExitChance: 0,
    },
    {
      id: "ward", name: "病房区",
      descriptions: [
        "长长的走廊两侧排列着紧闭的铁门。每隔几米就有一盏闪烁的日光灯。",
        "病房区的墙壁上有大量的抓痕和涂鸦。空气中回荡着若有若无的低语声。",
        "一间病房的门虚掩着，里面的床上留下了一圈束缚带。",
      ],
      lighting: "dim", dangers: [],
      items: ["束缚带", "空药瓶", "涂鸦笔记"],
      entities: [
        { name: "疯狂病人", type: "npc", hpMin: 10, hpMax: 14, ac: 10, faction: "敌对", status: ["疯狂"] },
      ],
      clues: ["wall_graffiti"],
      exits: ["reception", "treatment"],
      lockedExitChance: 0.2,
    },
    {
      id: "treatment", name: "治疗室",
      descriptions: [
        "治疗室中央有一张陈旧的电力治疗椅。各种恐怖的器械排列在墙上。",
        "手术台上残留着干涸的血迹。柜子里排列着各种药物瓶和手术器械。",
        "治疗室的墙角堆满了人体骨骼模型——它们似乎不是教学用具。",
      ],
      lighting: "bright", dangers: [],
      items: ["电击器", "手术刀", "实验记录"],
      entities: [],
      clues: ["experiment_log"],
      exits: ["ward"],
      lockedExitChance: 0,
    },
    {
      id: "office", name: "院长办公室",
      descriptions: [
        "院长办公室相对整洁。书架上排列着医学典籍和个人日记。办公桌上有一台打字机。",
        "厚重的窗帘将光线完全遮挡。办公桌上摆着一家人的照片——但所有人的脸都被划掉了。",
        "办公室的保险柜敞开着，里面空无一物——或者说，里面的东西已经被转移了。",
      ],
      lighting: "warm_light", dangers: [],
      items: ["院长日记", "保险柜文件", "钥匙串"],
      entities: [],
      clues: ["director_note"],
      exits: ["reception"],
      lockedExitChance: 0,
    },
    {
      id: "garden", name: "后院花园",
      descriptions: [
        "荒废的花园里长满了杂草和荆棘。中央有一个枯萎的喷泉。",
        "花园角落里有一片新翻过的泥土——像是最近才被挖掘过。",
        "废弃的温室里玻璃破碎，植物已经变异般疯长。",
      ],
      lighting: "moonlight", dangers: [],
      items: ["铲子", "骸骨碎片"],
      entities: [],
      clues: ["fresh_grave"],
      exits: ["main_gate"],
      lockedExitChance: 0,
    },
  ],

  // 基础场景集合
  library: [
    {
      id: "reading_hall", name: "阅览大厅",
      descriptions: [
        "巨大的阅览厅，书架从地板延伸到天花板。一张长桌上有盏绿灯罩台灯。",
        "图书馆里寂静无声，只有翻书页的沙沙声——但你明明是一个人来的。",
        "阅览大厅的穹顶上绘有星空图案。古老的书架上积满了灰尘。",
      ],
      lighting: "warm_light", dangers: [],
      items: ["古籍", "放大镜", "藏书票"],
      entities: [{ name: "图书管理员", type: "npc", hpMin: 10, hpMax: 12, ac: 10, faction: "友善" }],
      clues: ["rare_book"],
      exits: ["restricted_section", "basement_archive"],
      lockedExitChance: 0.3,
    },
    {
      id: "restricted_section", name: "禁书区",
      descriptions: [
        "上锁的铁栅栏后是禁书区。书架上的书籍封面用皮革装订，标题用未知文字书写。",
        "禁书区弥漫着陈旧纸张和神秘香料的气味。一盏孤灯照亮了书桌。",
        "铁链将几本最古老的典籍锁在书架上。空气中似乎有低语声。",
      ],
      lighting: "dim", dangers: [],
      items: ["封印典籍", "书签", "神秘符号拓片"],
      entities: [],
      clues: ["forbidden_knowledge"],
      exits: ["reading_hall"],
      lockedExitChance: 0.5,
    },
    {
      id: "basement_archive", name: "地下档案室",
      descriptions: [
        "地下室的铁质书架已经锈蚀。装在酸蚀纸箱中的旧档案散发着刺鼻的气味。",
        "档案室深处，一扇虚掩的铁门后另有空间。地面上有近期拖拽的痕迹。",
        "昏暗的地下档案室里，老旧的暖气管发出咝咝声。",
      ],
      lighting: "dark", dangers: ["毒气泄漏"],
      items: ["旧报纸剪报", "警方档案"],
      entities: [
        { name: "隐形猎手", type: "monster", hpMin: 20, hpMax: 30, ac: 15, faction: "怪物" },
      ],
      clues: ["archive_secret"],
      exits: ["reading_hall"],
      lockedExitChance: 0.3,
    },
  ],

  // 通用场景（任意主题可用）
  harbor: [
    {
      id: "dock", name: "码头",
      descriptions: [
        "废弃的码头，木板已经腐烂。几艘旧船系在栈桥边，在水中轻轻摇晃。",
        "码头边的仓库大门敞开。水面上漂浮着一层油污。",
        "海风中夹杂着鱼腥味和某种说不清的腐烂气息。远处有雾笛在鸣响。",
      ],
      lighting: "moonlight", dangers: ["腐烂木板"],
      items: ["绳索", "渔灯", "防水袋"],
      entities: [{ name: "老渔夫", type: "npc", hpMin: 10, hpMax: 12, ac: 10, faction: "友善", status: ["可疑"] }],
      clues: [],
      exits: ["warehouse", "fishing_boat"],
      lockedExitChance: 0,
    },
    {
      id: "warehouse", name: "仓库",
      descriptions: [
        "巨大的仓库里堆满了木箱和货柜。一盏吊灯在头顶晃动，投下摇曳的影子。",
        "仓库的门被撬开。地面上有拖拽货物的痕迹和一滩暗色的液体。",
        "堆满货物的仓库，角落里有一个被帆布盖住的巨大物体。",
      ],
      lighting: "dim", dangers: [],
      items: ["撬棍", "货物清单", "手电"],
      entities: [
        { name: "看门人", type: "npc", hpMin: 12, hpMax: 16, ac: 11, faction: "中立" },
      ],
      clues: ["cargo_manifest"],
      exits: ["dock"],
      lockedExitChance: 0.3,
    },
    {
      id: "fishing_boat", name: "渔船",
      descriptions: [
        "一艘破旧的渔船上堆满了渔网和捕蟹笼。船舱里有一张床和一台收音机。",
        "渔船的甲板上有一道长长的划痕，像是某种利爪留下的。",
      ],
      lighting: "moonlight", dangers: [],
      items: ["渔网", "海图"],
      entities: [],
      clues: ["nautical_chart"],
      exits: ["dock"],
      lockedExitChance: 0,
    },
  ],

  // 默认/回退场景
  village: [
    {
      id: "town_square", name: "小镇广场",
      descriptions: [
        "宁静的小镇广场，中央有一座战争纪念碑。周围的店铺大多已经关门。",
        "广场上的路灯有些已经坏了。长椅上坐着一个沉默的人影。",
        "广场的石板地面上有神秘的符号——看起来像是最近才画上去的。",
      ],
      lighting: "moonlight", dangers: [],
      items: ["传单", "硬币"],
      entities: [{ name: "陌生人", type: "npc", hpMin: 10, hpMax: 12, ac: 10, faction: "中立" }],
      clues: [],
      exits: ["general_store", "church", "residential"],
      lockedExitChance: 0,
    },
    {
      id: "general_store", name: "杂货店",
      descriptions: [
        "老式杂货店里堆满了各种日用商品。柜台后的老人用警惕的眼神打量着你。",
        "杂货店的橱窗玻璃破碎了，但店主似乎并不在乎。货架上空空如也。",
      ],
      lighting: "warm_light", dangers: [],
      items: ["应急食品", "电池", "地图", "绷带"],
      entities: [{ name: "店主", type: "npc", hpMin: 10, hpMax: 12, ac: 10, faction: "友善" }],
      clues: ["shopkeep_rumor"],
      exits: ["town_square"],
      lockedExitChance: 0,
    },
    {
      id: "church", name: "教堂",
      descriptions: [
        "古老的石头教堂，彩色玻璃窗在月光下映出诡异的图案。门虚掩着。",
        "教堂内部空无一人，长椅上落满灰尘。祭坛上有一本翻开的圣经。",
        "教堂的地下室入口被一个沉重的铁盖子封住，但锁已经被人撬开了。",
      ],
      lighting: "dim", dangers: [],
      items: ["圣经", "圣水", "银十字架"],
      entities: [],
      clues: ["altar_secret"],
      exits: ["town_square", "church_cellar"],
      lockedExitChance: 0.3,
    },
    {
      id: "church_cellar", name: "教堂地下室",
      descriptions: [
        "阴暗潮湿的地下室，墙上有古老的壁画。地面上刻着一个复杂的法阵。",
        "地下室里堆满了骸骨——它们被整齐地排列在墙边。",
      ],
      lighting: "dark", dangers: ["邪教徒"],
      items: ["仪式匕首", "古老卷轴"],
      entities: [
        { name: "邪教徒", type: "npc", hpMin: 12, hpMax: 16, ac: 12, faction: "敌对" },
      ],
      clues: ["ritual_circle"],
      exits: ["church"],
      lockedExitChance: 0,
    },
    {
      id: "residential", name: "居民区",
      descriptions: [
        "安静的居民区，大多数房屋都黑着灯。只有一栋房子亮着微弱的灯光。",
        "街道上散落着被撕碎的报纸。一辆汽车被烧毁在路边。",
      ],
      lighting: "moonlight", dangers: [],
      items: [],
      entities: [{ name: "惊慌的居民", type: "npc", hpMin: 8, hpMax: 10, ac: 10, faction: "友善", status: ["惊恐"] }],
      clues: [],
      exits: ["town_square"],
      lockedExitChance: 0,
    },
  ],
};

// ============================================================
// 线索模板
// ============================================================

interface ClueTemplate {
  id: string;
  type: string;
  category: string;
  description: string;
  coc_primary: string;
  coc_secondary: string;
  san_cost: string;
}

const CLUE_TEMPLATES: Record<string, ClueTemplate> = {
  strange_symbol: {
    id: "strange_symbol", type: "physical", category: "coc_occult",
    description: "墙上刻着一个奇怪的符号，散发微弱的磷光", coc_primary: "克苏鲁神话",
    coc_secondary: "侦查", san_cost: "0/1",
  },
  diary_entry: {
    id: "diary_entry", type: "document", category: "coc_research",
    description: "日记中记载了屋主逐渐疯狂的过程", coc_primary: "图书馆使用",
    coc_secondary: "心理学", san_cost: "1/1d3",
  },
  photo_hint: {
    id: "photo_hint", type: "document", category: "coc_research",
    description: "一张旧照片背面写着神秘的日期和坐标", coc_primary: "侦查",
    coc_secondary: "历史", san_cost: "0/1",
  },
  child_drawing: {
    id: "child_drawing", type: "physical", category: "coc_occult",
    description: "儿童的画作上画着奇怪的生物和符号", coc_primary: "心理学",
    coc_secondary: "克苏鲁神话", san_cost: "0/1d2",
  },
  ritual_diagram: {
    id: "ritual_diagram", type: "physical", category: "coc_occult",
    description: "一张复杂的仪式图解，看起来不属于任何已知语言", coc_primary: "克苏鲁神话",
    coc_secondary: "神秘学", san_cost: "1/1d4",
  },
  burnt_symbols: {
    id: "burnt_symbols", type: "physical", category: "coc_occult",
    description: "地面上烧焦的符号呈放射状排列", coc_primary: "侦查",
    coc_secondary: "神秘学", san_cost: "0/1",
  },
  hunter_journal: {
    id: "hunter_journal", type: "document", category: "coc_research",
    description: "猎人的日记记录了森林中发生的怪事", coc_primary: "追踪",
    coc_secondary: "自然", san_cost: "1/1d3",
  },
  forgotten_tomb: {
    id: "forgotten_tomb", type: "physical", category: "coc_occult",
    description: "一座被遗忘的古墓，墓门上的封印已经被破坏", coc_primary: "考古学",
    coc_secondary: "历史", san_cost: "1/1d4",
  },
  hidden_tunnel: {
    id: "hidden_tunnel", type: "physical", category: "coc_investigation",
    description: "地窖墙壁上有一扇伪装的门，通向一条秘密隧道", coc_primary: "侦查",
    coc_secondary: "机械维修", san_cost: "0/0",
  },
  family_portrait: {
    id: "family_portrait", type: "physical", category: "coc_research",
    description: "全家福照片中所有人的面部都被某种尖锐物划掉了", coc_primary: "心理学",
    coc_secondary: "侦查", san_cost: "0/1",
  },
  patient_record: {
    id: "patient_record", type: "document", category: "coc_research",
    description: "一份精神病人的病历，记录了不可思议的治疗方法", coc_primary: "医学",
    coc_secondary: "心理学", san_cost: "1/1d4",
  },
  wall_graffiti: {
    id: "wall_graffiti", type: "physical", category: "coc_investigation",
    description: "病房墙上有大量用血写成的文字和符号", coc_primary: "克苏鲁神话",
    coc_secondary: "神秘学", san_cost: "1/1d3",
  },
  experiment_log: {
    id: "experiment_log", type: "document", category: "coc_research",
    description: "一份实验记录描述了非人道的活体实验", coc_primary: "医学",
    coc_secondary: "科学", san_cost: "1/1d6",
  },
  director_note: {
    id: "director_note", type: "document", category: "coc_investigation",
    description: "院长的私人笔记中提到了一个秘密的研究项目", coc_primary: "侦查",
    coc_secondary: "图书馆使用", san_cost: "0/1d2",
  },
  fresh_grave: {
    id: "fresh_grave", type: "physical", category: "coc_investigation",
    description: "花园里有一处新翻的泥土——看起来像一座没有标记的坟墓", coc_primary: "侦查",
    coc_secondary: "敏捷", san_cost: "0/1",
  },
  rare_book: {
    id: "rare_book", type: "document", category: "coc_research",
    description: "一本罕见的古籍，书页边缘有手写的批注", coc_primary: "图书馆使用",
    coc_secondary: "克苏鲁神话", san_cost: "0/1d3",
  },
  forbidden_knowledge: {
    id: "forbidden_knowledge", type: "document", category: "coc_occult",
    description: "禁书区的一本书中记载了召唤异界存在的方法", coc_primary: "克苏鲁神话",
    coc_secondary: "神秘学", san_cost: "1d2/1d6",
  },
  archive_secret: {
    id: "archive_secret", type: "document", category: "coc_investigation",
    description: "档案中隐藏着一份关于小镇秘密历史的报告", coc_primary: "图书馆使用",
    coc_secondary: "历史", san_cost: "0/1d2",
  },
  cargo_manifest: {
    id: "cargo_manifest", type: "document", category: "coc_investigation",
    description: "货物清单上列出了不寻常的进口物品", coc_primary: "会计",
    coc_secondary: "侦查", san_cost: "0/1",
  },
  nautical_chart: {
    id: "nautical_chart", type: "physical", category: "coc_research",
    description: "海图上标记着一个不存在的岛屿位置", coc_primary: "导航",
    coc_secondary: "地理", san_cost: "0/1d2",
  },
  shopkeep_rumor: {
    id: "shopkeep_rumor", type: "witness", category: "coc_investigation",
    description: "店主低声告诉你最近镇上的怪事", coc_primary: "说服",
    coc_secondary: "心理学", san_cost: "0/0",
  },
  altar_secret: {
    id: "altar_secret", type: "physical", category: "coc_occult",
    description: "教堂祭坛下有一个隐蔽的暗格", coc_primary: "侦查",
    coc_secondary: "神秘学", san_cost: "0/1d2",
  },
  ritual_circle: {
    id: "ritual_circle", type: "physical", category: "coc_occult",
    description: "地下室地面上刻着一个复杂的召唤法阵", coc_primary: "克苏鲁神话",
    coc_secondary: "神秘学", san_cost: "1d2/1d6",
  },
  strange_carving: {
    id: "strange_carving", type: "physical", category: "coc_occult",
    description: "洞穴岩壁上刻着奇异的符号，不像是人类所为", coc_primary: "考古学",
    coc_secondary: "克苏鲁神话", san_cost: "1/1d4",
  },
  altar_inscription: {
    id: "altar_inscription", type: "physical", category: "coc_occult",
    description: "地下洞穴中的祭坛上刻满了无法解读的文字", coc_primary: "克苏鲁神话",
    coc_secondary: "神秘学", san_cost: "1d2/1d6",
  },
};

// ============================================================
// 主线钩子模板
// ============================================================

const PLOT_HOOKS: Array<{ name: string; description: string; subgenres: HorrorSubgenre[] }> = [
  { name: "失踪案", description: "镇上最近有多人失踪，最后有人看到他们前往了某个地点。", subgenres: ["lovecraft", "slasher", "cult"] },
  { name: "奇怪的声音", description: "夜晚从某个方向传来奇怪的声音——像是吟唱，又像是哀嚎。", subgenres: ["lovecraft", "ghost", "cult"] },
  { name: "神秘包裹", description: "你收到了一封匿名信和一个小包裹，里面装着一把旧钥匙和一张纸条。", subgenres: ["lovecraft", "cosmic"] },
  { name: "本地传说", description: "酒馆里的老人讲述了一个关于本地怪物的传说，与最近发生的怪事吻合。", subgenres: ["lovecraft", "slasher", "ghost", "body_horror"] },
  { name: "家族秘密", description: "一封来自远方亲戚的信，邀请你前往老宅处理遗产——但事情远没那么简单。", subgenres: ["lovecraft", "ghost", "cult"] },
  { name: "科学实验", description: "附近的实验室/研究所最近发生了事故，当局封锁了消息。", subgenres: ["body_horror", "cosmic"] },
  { name: "朝圣者", description: "一群神秘的外地人最近来到镇上，他们在某处建立了据点。", subgenres: ["cult", "cosmic"] },
  { name: "扭曲的生态", description: "当地的动植物开始出现异常——变异的体型、异常的行为。", subgenres: ["body_horror", "cosmic"] },
  { name: "古老的诅咒", description: "一个古老的诅咒似乎再次降临到这个地方。", subgenres: ["ghost", "cult", "cosmic"] },
];

// ============================================================
// 主题映射：根据子类型和环境选择场景集合
// ============================================================

const THEME_BY_SUBGENRE: Record<HorrorSubgenre, SceneTheme[]> = {
  lovecraft: ["abandoned_house", "forest", "library", "harbor", "village"],
  slasher: ["abandoned_house", "forest", "asylum", "village"],
  ghost: ["abandoned_house", "mansion", "church", "village"],
  cult: ["church", "asylum", "library", "forest", "village"],
  body_horror: ["asylum", "laboratory", "underground", "abandoned_house"],
  cosmic: ["forest", "library", "harbor", "cave", "underground"],
};

// ============================================================
// 随机工具
// ============================================================

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================
// StoryGenerator
// ============================================================

export class StoryGenerator {
  /**
   * 生成一个完整的故事/场景
   */
  generate(config: Partial<StoryConfig> = {}): GeneratedStory {
    const validSubgenres: HorrorSubgenre[] = ["lovecraft", "slasher", "ghost", "cult", "body_horror", "cosmic"];
    const subgenre: HorrorSubgenre = validSubgenres.includes(config.subgenre as HorrorSubgenre)
      ? (config.subgenre as HorrorSubgenre)
      : pick(["lovecraft", "cult", "ghost"]);
    const validLengths: StoryLength[] = ["short", "medium", "long"];
    const length: StoryLength = validLengths.includes(config.length as StoryLength)
      ? (config.length as StoryLength)
      : "medium";
    const difficulty = clamp(config.difficulty ?? 2, 1, 5);
    const sceneCount = length === "short" ? 3 : length === "medium" ? 4 : 6;

    // 1. 选择主题
    const availableThemes = config.theme
      ? [config.theme as SceneTheme].filter(t => THEME_BY_SUBGENRE[subgenre]?.includes(t) ?? true)
      : THEME_BY_SUBGENRE[subgenre] ?? Object.keys(SCENE_TEMPLATES) as SceneTheme[];
    const theme = pick(availableThemes.length > 0 ? availableThemes : ["abandoned_house", "forest", "village"] as SceneTheme[]);

    // 2. 生成标题和钩子
    const title = generateTitle(subgenre);
    const hookPool = PLOT_HOOKS.filter(h => h.subgenres.includes(subgenre));
    const hook = pick(hookPool.length > 0 ? hookPool : PLOT_HOOKS);

    // 3. 获取该主题的场景模板
    const themeScenes = SCENE_TEMPLATES[theme] ?? SCENE_TEMPLATES.abandoned_house;
    let selectedTemplates = pickN(themeScenes, sceneCount);

    // 若模板不足 sceneCount，从其他主题补充
    if (selectedTemplates.length < sceneCount) {
      const extraSources = Object.values(SCENE_TEMPLATES).flat();
      const usedIds = new Set(selectedTemplates.map(t => t.id));
      const extras = extraSources.filter(t => !usedIds.has(t.id));
      const more = pickN(extras, sceneCount - selectedTemplates.length);
      selectedTemplates = [...selectedTemplates, ...more];
    }

    // 确保包含至少一个含有怪物的场景
    const hasMonster = selectedTemplates.some(t => t.entities.some(e => e.type === "monster"));
    if (!hasMonster && themeScenes.some(t => t.entities.some(e => e.type === "monster"))) {
      const monsterScene = themeScenes.find(t => t.entities.some(e => e.type === "monster"));
      if (monsterScene && !selectedTemplates.includes(monsterScene)) {
        selectedTemplates[selectedTemplates.length - 1] = monsterScene;
      }
    }

    // 4. 分配场景 ID 前缀
    const prefix = theme;

    // 5. 构建场景输出
    const scenes: SceneOutput[] = [];
    const entities: EntityOutput[] = [];
    const displayNames: Record<string, string> = {};
    const aliases: Record<string, string> = {};
    const itemsMap: Record<string, string[]> = {};
    const clueTexts: GeneratedStory["clueTexts"] = [];
    const usedClues = new Set<string>();

    let entityCounter = 0;

    for (const tmpl of selectedTemplates) {
      const sceneId = `${prefix}_${tmpl.id}`;
      const sceneName = tmpl.name;
      const description = pick(tmpl.descriptions);

      // 场景显示名和别名
      displayNames[sceneId] = sceneName;
      // 别名：名字本身 + 里
      aliases[sceneName] = sceneId;
      if (sceneName.endsWith("厅") || sceneName.endsWith("室")) {
        aliases[`${sceneName}里`] = sceneId;
      }

      // 入口场景激活
      const isActive = tmpl.id === selectedTemplates[0]?.id;
      const sceneDangers = [...tmpl.dangers];

      // 根据难度增加危险
      if (difficulty >= 4 && tmpl.entities.some(e => e.type === "monster")) {
        sceneDangers.push(`精英${tmpl.entities.find(e => e.type === "monster")?.name ?? "怪物"}`);
      }

      // 场景出口
      const exits: SceneOutput["exits"] = [];
      const connectedTargets = new Set<string>();
      for (const exitId of tmpl.exits) {
        // 检查出口是否在选中的模板中
        const targetTemplate = selectedTemplates.find(t => t.id === exitId);
        if (targetTemplate) {
          const targetSceneId = `${prefix}_${exitId}`;
          if (!connectedTargets.has(targetSceneId)) {
            connectedTargets.add(targetSceneId);
            exits.push({
              target: targetSceneId,
              desc: `前往${targetTemplate.name}`,
              // Generated locks have no gate executor. Do not emit an
              // unactionable lock and pretend it survived installation.
              locked: false,
            });
          }
        }
      }

      // 场景物品
      const itemCount = difficulty > 3 ? tmpl.items.length : Math.min(tmpl.items.length, 3);
      const sceneItems = pickN(tmpl.items, itemCount);
      itemsMap[sceneId] = sceneItems;

      // 场景线索
      const sceneClues: string[] = [];
      for (const clueId of tmpl.clues) {
        if (!usedClues.has(clueId)) {
          usedClues.add(clueId);
          sceneClues.push(clueId);
          const clueTmpl = CLUE_TEMPLATES[clueId];
          if (clueTmpl) {
            clueTexts.push({ ...clueTmpl, scene: sceneId });
          }
        }
      }

      scenes.push({
        id: sceneId,
        name: sceneName,
        description,
        lighting: tmpl.lighting,
        dangers: sceneDangers,
        exits,
        isActive,
        items: sceneItems,
        clues: sceneClues,
      });

      // 实体生成
      for (const ent of tmpl.entities) {
        entityCounter++;
        const hp = ent.hpMin + Math.floor(Math.random() * (ent.hpMax - ent.hpMin + 1));
        const entityId = `${ent.name}_${entityCounter}`;
        entities.push({
          id: entityId,
          name: ent.name,
          type: ent.type,
          hp,
          maxHp: hp,
          ac: ent.ac + Math.floor(difficulty / 2),
          status: [...(ent.status ?? [])],
          position: sceneId,
          scene_id: sceneId,
          faction: ent.faction,
        });
      }
    }

    // 6. 场景间连通性修复：确保每个场景都能从起始场景走到
    //
    // 原实现只在「出口为空」的场景上补一条出边，判据是出度而不是可达性，
    // 漏掉两类情况：
    //   - 补的边是单向的，那个场景走得出去却没人走得进来（实测 attic -> kitchen）；
    //   - 模板子图分裂成多个连通分量时，分量里每个场景出度都不为 0，
    //     判据根本不触发（实测 stairs <-> attic 自成一块，从起点永远走不到）。
    // 20 局采样里后者出现 2 次。判据换成从起始场景做 BFS，把没走到的场景
    // 双向接回已达集合，接完重算，直到全部可达。
    const connect = (from: SceneOutput, to: SceneOutput) => {
      if (from.exits.some((e) => e.target === to.id)) return;
      from.exits.push({ target: to.id, desc: `前往${to.name}`, locked: false });
    };
    const reachableFromStart = (): Set<string> => {
      const byId = new Map(scenes.map((s) => [s.id, s]));
      const seen = new Set<string>();
      const first = scenes[0];
      if (!first) return seen;
      seen.add(first.id);
      const queue: string[] = [first.id];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (cur === undefined) break;
        for (const e of byId.get(cur)?.exits ?? []) {
          if (!seen.has(e.target)) {
            seen.add(e.target);
            queue.push(e.target);
          }
        }
      }
      return seen;
    };
    let reached = reachableFromStart();
    for (const scene of scenes) {
      if (reached.has(scene.id)) continue;
      const anchor = scenes.find((s) => reached.has(s.id));
      if (!anchor) break;
      connect(scene, anchor);
      connect(anchor, scene);
      reached = reachableFromStart();
    }

    // 7. 构建完整故事
    return {
      title,
      hook: `${hook.name}：${hook.description}`,
      scenes,
      entities,
      displayNames,
      aliases,
      items: itemsMap,
      clueTexts,
    };
  }
}
