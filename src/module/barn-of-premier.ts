// ============================================================
// 普瑞米尔的谷仓 ver1.03 — 模组结构化数据
// 提取自: 普瑞米尔的谷仓 ver1.03 (MikuFan) 原始 PDF 文本
// 提取原则：只保留来自原始模块的数据，不添加衍生/游戏引擎专用字段
// 比对基线: 此文件为"纯提取版"，与之前含跑团信息的版本进行精度比对
//
// 提取源数据（去重后的唯一一份，见 docs/index-world-model.md）：
//   ../MikuFan-普瑞米尔的谷仓/普瑞米尔的谷仓 ver1.03.pdf  — 真正的源头
//   tools/modules/raw/                                    — 原文按章节拆分
//   tools/modules/structured/                             — 从本文件反向拆出的字段（是派生物，不是来源）
//   tools/*.mjs                                           — 拆分/校正/校验脚本
//
// 注意方向：structured/ 是从这份 .ts 拆出来的，不是它的来源。
// 从 PDF 到本文件这一步没有程序做过——现有内容是人/LLM 手写的。
// ============================================================

import { type RuntimeModuleData, type ModuleSupport, type Scene, type ModuleNPC, type ModuleItem, type Clue, type EpilogueEntry, type PartySetup, type EndNarration, type EncounterNarration } from "./types";
import type { ModuleRuntimeConfig } from "./runtime-types";
import { applyAllLlmExpanded } from "../llm/generate-llm-expanded";
import { attachRuntimeNpcs } from "./runtime-npc-attachment";

// 原先这里有个 `RAW = "【原文】"` 标记常量，没有任何引用 —— 想标注哪些内容来自原文，
// 得真的用上它才算数。

// ─── 工具：原文引用的场景描述 ─────────────────────────────
const S = {
  TRICAM_HOUSE: `这是一栋很普通的美式小别墅，相比周围的建筑可以看出稍微有翻新的感觉，在别墅外有一个小的篮球场与几个太阳伞和躺椅，一旁还放着一些烧烤架，看起来这家人很会享受生活。在一旁可以看到一个拖车车房（可搭载拖车移动的房屋，在美国还算常见），通过窗子可以看到也有在使用的痕迹。`,
  GABI_TRAILER: `这间拖车房里面都是一些青年的物品。可以找到一些时下比较流行的音乐碟，还有一些乐队的海报，在餐厅区域有不少空的啤酒罐与披萨盒，在休息的区域则可以看到床上的被褥都没有好好叠好，床上还放着类似于乞丐裤之类的青年服饰。在拖车内部还有一个小的卫生间，有淋浴设备与一些洗漱用具。`,
  CARD: `还在犹豫的男男女女们！还在犹豫什么时候出手享受世界吗！**月**日晚8:00在维森酒吧，享受狂欢！足量酒水免费供应。还有更多你喜欢的东西！享受生活，就是现在！`,
  TOWN: `普瑞米尔是一个比较落后，名不见经传的小镇，本地主要以农产品为收入来源，畜牧场地与一些农场遍布小镇周围，虽然是个比较落后的小镇，警局、医院、旅店、贫民窟、酒吧还是一应俱全，当然，枪械店铺也能在某个阴暗的角落被看到。街上的行人虽然没有对外来人显示出明显的敌意，不过最好不要认为有多友善。`,
  WEISEN_BAR: `维森酒吧是在这个小镇唯二的酒吧，属于平民阶级与混混常来的场所，虽然禁酒令的施行在这种乡下地区确实不怎么到位，但是这么明目张胆的还是少数。这个酒吧拥有自己的保安，可以在一些角落看到他们的身影，在这里闹事绝对不是一个明智的选择。`,
  NEWSSTAND: `报亭`,
  KIDNAPPER_REPORT: `昨日，在***农场国道***附近，警方逮捕了一名绑架犯，他当时正尝试击晕一位当地居民，在被发现时与警方发生了交火，不幸的是那位居民死于流弹，两名警员负伤，一名警员当场死亡。这名犯人也被警方制服，但是因为弹片击中脑壳，现在处于意识不清的状态，于霍姆斯医院接受治疗。根据警方透露，这名危险的绑架犯名为艾德里安·埃斯特鲁姆，曾服役于美国陆军，并且也是一位生物学教授，至于为什么要参与这种绑架活动，目前无法判定，还需要进一步的跟踪报道。在报道的下面贴有当时警方的照片，两名死者异常凄惨，而附近似乎还有一台报废车辆。`,
  HOSPITAL: `这是一间看上去有些年头的建筑，墙面有些油漆脱落了，还有一块新一块旧的类似于补丁的墙面漆。医院附近人不多，进入大厅就可以看到一位分诊员正在柜台前面昏昏欲睡，整间医院的照明有些次，整体稍微有些昏暗。医院有3层，一层大多数一些医生诊室与药房急诊等，二层与三层则是住院层。`,
  POLICE_STATION: `普瑞米尔警局算是镇子里维护的比较不错的建筑，外面的墙壁可以看出是新刷过的油漆，星条旗在一旁的旗杆上飘扬，这也是这个小镇唯一一面美国国旗。警局内没有什么人，附近也和其他的地方不一样，脏乱、流浪汉的棚窝，一个都没有。甚至让人有些不适应感。`,
  EVIDENCE_ROOM: `进入证物室是非常难的事情，即使是这种偏僻的警察局也有严格的管理。`,
  HOTEL: `一个双层建筑，在小镇里算是有些注重外观的建筑了，一块不大的招牌摆在外面，整体看上去很整洁。进门就可以看到前台，在进门时可以听到一些风铃声，令人心情不由得会变好一些。在前台上除了一些账簿和椅子以外，还有一个小银铃，应该是用来呼唤后台的工作人员的。旅店提供基本的住宿，在一层有一个小餐厅，看上去可以提供一些普通的熟食品。

沿着木质楼梯往上可以来到二层，这边左右加起来有6间房间。大小一致。在尽头还有一个洗手间。每间卧室都有两张床与一个书桌，还有对应的2个床头柜。透过窗子可以看到街上形形色色的人们。`,
  SHOOTOUT: `这里已经是一片狼藉，鲜血泼洒了一地，而且还有一些粉笔印来诉说这里曾经发生过的事情。取证似乎已经完成，这里没有警员驻守，只有废弃的白色小车作为这里的地标。萧瑟的秋风让你们感觉有些身体发凉。`,
  ADRIAN_TOWN_HOUSE: `这是一栋独门独户的小别墅，是一个双层建筑，靠着贫民窟有些近，而且似乎已经荒废了有一段时间了，门前的草坪已经很久没有修整过，仔细看一侧的玻璃窗似乎也有被打破的痕迹。`,
  FARM: `这间农场周围围着很简单的木质栅栏，上面的油漆都已经被雨水腐蚀掉了。在入口处似乎还有一块本应存在的牌匾，现在也只能看到孤零零的架子，而上面的牌匾早就不知道飞到哪里去了。在入口处稍微观察四周，这是这附近唯一的农场，有着一些田地，但是完全没有打理的样子，几个大棚也急需修缮。除了主要入口的道路，外野草丛生，甚至无法看清脚下。再稍微往里有两个比较显眼的建筑。一间刷着红油漆的类似谷仓的建筑，和一个农场主别墅。`,
  FARM_VILLA: `从远处观察别墅，这个房子似乎被整体刷过白色油漆。但是也应该有段时间了。窗子上封了一些木板，这里看上去不像是在被使用的样子。`,
  BARN: `这栋谷仓形建筑整体为金属结构，大门牢牢关着，只能从内部打开，侧面有一个看上去非常先进的防盗门。在一旁还有一些杂物堆，看上去可以上到屋顶。`,
  BARN_INTERIOR: `这里虽然外表是一处谷仓，不过内部似乎已经被简单改造过了，很显眼的就是放置在周围的床铺，床铺上还躺着人，他们的上半身被奇怪的仪器罩着，还有很明显没有整理过的奇怪线路，这些线路朝着内部拐过去。这里的氛围只能让人感觉到不寒而栗..而在门口还有一具尸体，眼睛活睁地盯着大门。`,
  CONTROL_ROOM: `跟随着灯光转过拐角，这间房间的门是打开着的，这间房间虽然不小，但是一台看上去非常高科技的大家伙还是占据了整间房间非常大的区域。这个机器有着3个显示器，看上去都是电视机改造拼接上去的，现在上面有一些红色警报。在这些显示器下面有一个看上去像是控制台的装置，上面有许多按钮，不过都没有标注，还有几个类似于收音机调频的旋钮，但是完全没头绪是用来做什么的。一些线路比较随意的落在了外面，机器持续发出不小的风扇轰鸣声，甚至可以感觉到有些热气从机器下方吹出。除了这台吸引视线的怪物以外，这里似乎还有一台冰箱与一个中型储藏柜，上面挂着锁，不过并没有锁住，看起来主人出门的时候没有好好收拾好。除了这些以外，可以注意到这间房间被打扫的非常干净，和凌乱的电子线路形成鲜明的对比。`,
  ADRIAN_BEDROOM: `这是一间很简洁的卧室，一张单人床，一个床头柜，一个枪柜，仅此而已，衣服整洁的叠在床上，这里应该是他休息的地方。`,
  SEWER: `这似乎是一处废弃的下水道，应该是强行挖通过来的。这段下水道已经干涸了，周围的墙壁上长着青苔，充斥着腐烂与陈朽的味道，几乎没有光线透进来。`,
  MAINTENANCE_ROOM: `走入这间房间。在门的背面可以看到歪歪扭扭有些生锈的铁牌，上面写着维修室。进入房间后，这里非常昏暗，无法看清整体的样貌，不过空气中弥漫着一些说不上来的味道，似乎是机油与医用酒精之类的东西揉捏在一起，这个房间有2个支撑梁，在右手边似乎有一张桌子的样子。在桌子一旁，有一个类似于展柜的金属架。`,
  BIG_PIPE: `往里走，这里似乎曾经是堆放着维修建材的地方。但是已经被清空，一个很大的管道从天花板通了下来，这应该不是这里原本就有的东西。在管道之前还有一些..红色的痕迹，旁边的墙上还有一个青色按钮。`,
  COFFIN: `一副散发着阴冷气息的..长方形物体。有些像是电冰箱的样子，外边布置着线缆，连接着一个发电机，在角落似乎还裹着一些冰蓝颜色的物体。封边上也似乎有些黏液。`,
} as const;

// 步骤 5B：运行字段唯一维护于此。custom-modules/premiers_barn.ts
// 只从 BARN_OF_PREMIER.runtime 确定性派生，不再保存第二份谷仓事实。
const BARN_RUNTIME: ModuleRuntimeConfig = {
  "sourceIdentity": {
    "id": "premiers_barn",
    "name": "普瑞米尔的谷仓",
    "version": "ver1.03",
    "description": "模组为线性半 City 类模组。长度中短，比较适合新人 PL 适应 COC 的环境，且难度不高。 因为事件已经完成，调查员可以说类似于去收尾的警察一般。即使调查员失败，也不会失去"
  },
  "activation": {
    "type": "manual",
    "condition": "premiers_barn"
  },
  "difficulty": "easy",
  "source": "MikuFan",
  "introNarration": "在 1921 年某日。你们坐在自己的家中，享用着咖啡查看着报纸，一则寻人委托吸引了你 们的注意力，一位名为菲碧·特里坎的女性发布的公告。和普通的寻人启事不一样，这是一 份委托，这位女士的 17 岁儿子已经失踪了半个月，现在举重金请人追寻她儿子的下落，在 委托的下方有一串固话号码和一行联系地址.... -- 1 of 18 --",
  "spells": [
    {
      "name": "僵尸创造术",
      "sanCost": "1d3/1d6",
      "mpCost": 8,
      "description": "消耗 8 MP，施法用时不定。复生尸体自动攻击有“生”概念的目标，不听从召唤者指令，1 小时后再次化为尸体。Mi-Go 版消耗 6 MP 理智不计，施法用时 2 轮。",
      "effectType": "other"
    },
    {
      "name": "纳克-提特障壁创建术",
      "sanCost": "1d3/1d6",
      "mpCost": 8,
      "description": "消耗 8 MP。创造一道物理魔法双重防御屏障。Mi-Go 版消耗不计理智不计，施法用时 1 轮，投掷 2d10×5 决定屏障 STR，进出需力量对抗，投射物需伤害 > 屏障 STR 1/5 方可穿透，穿透后屏障自动解除。Mi-Go 可自由允许物品/人穿过。",
      "effectType": "other"
    },
    {
      "name": "帕祖祖之息",
      "sanCost": "1d3/1d6",
      "mpCost": 8,
      "description": "消耗 8 MP。施法者吐出有毒蒸汽，影响至多 30 码外一名目标。令人窒息的毒气使目标咳呛，目盲且无法说话，持续约 1 分钟（3 回合）。Mi-Go 版消耗 3 MP 理智不计，施法即时。",
      "effectType": "other"
    },
    {
      "name": "Mi-Go \t修改版",
      "sanCost": "不计",
      "mpCost": 6,
      "description": "Mi-Go 对本模组法术的专用调整版：僵尸创造术 6 MP / 2 轮 / 理智不计；纳克-提特障壁创建术 不计 MP / 1 轮 / 理智不计；帕祖祖之息 3 MP / 即时 / 理智不计。Mi-Go 可自由控制屏障的通行权限。",
      "effectType": "other"
    }
  ],
  "tomes": [
    {
      "name": "老旧文件",
      "sceneId": "艾德里安的卧室",
      "sanCost": "1/1d3+1",
      "tomeRating": 3,
      "spells": [
        "米-戈联络术"
      ],
      "openDescription": "这份文件是艾德里安偶然在一战遗迹中发现的前线疯子的笔记，通篇为法语所写。上面记载着一些被生化战逼疯了的疯子的痴语——但是这些疯子好死不死的因为幻境写下了 Mi-Go 的联络术，才导致这次悲剧的发生。原文为法语，如果有法国人或法语点数超过 50，可以直接观看本文。阅读这段文字会导致 SAN 1/1d3+1。仔细研究 2 周，可以学会“米-戈联络术”并且 CM+3。"
    }
  ],
  "rewards": [
    {
      "id": "kill_victims",
      "description": "杀死所有受害者",
      "conditionText": "调查员拉下拉杆杀死所有受害者",
      "sanChange": "-d6"
    },
    {
      "id": "rescue_victims",
      "description": "解救受害者",
      "conditionText": "调查员成功解救被绑架的受害者",
      "sanChange": "rescued*d3"
    },
    {
      "id": "discover_truth",
      "description": "发现缸中脑与事件真相",
      "conditionText": "调查员发现下水道中的缸中脑并理解事件真相",
      "sanChange": "+d6",
      "cmChange": 3
    },
    {
      "id": "commission_done",
      "description": "委托达成",
      "conditionText": "调查员完成了菲碧的寻人委托",
      "reputationChange": 10
    },
    {
      "id": "town_thanks",
      "description": "小镇的感谢",
      "conditionText": "调查员成功解救受害者获得小镇居民感谢",
      "reputationChange": 5
    },
    {
      "id": "killed_migo",
      "description": "击杀了 Mi-Go",
      "conditionText": "调查员在下水道中击杀了 Mi-Go",
      "sanChange": "+d6",
      "cmChange": 3
    },
    {
      "id": "migo_took_emily",
      "description": "Mi-Go 带走了艾米丽",
      "conditionText": "Mi-Go 在战斗中带走了艾米丽的大脑",
      "sanChange": "-d6",
      "cmChange": 3
    },
    {
      "id": "no_firearm",
      "description": "没有使用火器完成模组",
      "conditionText": "调查员在整个模组中没有使用任何火器",
      "skillGrowth": {
        "斗殴": "d10"
      }
    },
    {
      "id": "no_trap",
      "description": "在陷阱区没有触发任何陷阱",
      "conditionText": "调查员在农场外围的陷阱区域没有触发任何陷阱",
      "skillGrowth": {
        "侦查": "d10"
      }
    }
  ],
  "kpNotes": {
    "加比的拖车房": "KP 可以酌情考虑变更物品的存放位置，避免卡关。",
    "驾驶证": "KP 可以酌情去掉此选项（若调查员已知农场地址或已在交火现场发现）。",
    "农场外围:音响陷阱": "KP 仍然可以以巨大响声为由对所有调查员造成 sc0/1d3 的惩罚，且下个侦查骰有额外惩罚骰。",
    "建筑内": "KP 可以让调查员第一个找到因体质不支已死的受害者，发现气管切开迹象，促使调查员停止“救助”行为。",
    "艾德里安的卧室": "KP 可以在武器列表选择武器放在此处作为调查员可用资源。",
    "下水道": "KP 可根据调查员的情况选择性放置食尸鬼（此处非常适合食尸鬼环境）。",
    "__global__:preparation": "KP 可选择在开团前准备冥河图片、20世纪美国街景等视觉辅助素材，以增强氛围。",
    "__global__:difficulty": "模组中可能包含稍微过激的场景与令人胃痛的设定，KP 可酌情降低难度或减少出现。"
  },
  "hooks": [
    {
      "type": "on_enter_scene",
      "condition": "特里坎家",
      "narration": "这是一栋很普通的美式小别墅，相比周围的建筑可以看出稍微有翻新的感觉，在别墅外有一个小的篮球场与几个太阳伞和躺椅，一旁还放着一些烧烤架，看起来这家人很会享受生活。在一旁可以看到一个拖车车房，通过窗子可以看到也有在使用的痕迹。",
      "effect": "进入特里坎家"
    },
    {
      "type": "on_enter_scene",
      "condition": "加比的拖车房",
      "narration": "这间拖车房里面都是一些青年的物品。可以找到一些时下比较流行的音乐碟，还有一些乐队的海报，在餐厅区域有不少空的啤酒罐与披萨盒，在休息的区域则可以看到床上的被褥都没有好好叠好，床上还放着类似于乞丐裤之类的青年服饰。",
      "effect": "进入加比的拖车房"
    },
    {
      "type": "on_enter_scene",
      "condition": "普瑞米尔",
      "narration": "普瑞米尔是一个比较落后的小镇，本地主要以农产品为收入来源。警局、医院、旅店、酒吧一应俱全。街上的行人虽然没有对外来人显示出明显的敌意，不过最好不要认为有多友善。",
      "effect": "进入普瑞米尔镇"
    },
    {
      "type": "on_enter_scene",
      "condition": "在小镇内询问路人",
      "narration": "如果拿着加比的照片四处询问，可能不会有任何结果。如果调查员运气够好碰到好心的路人，或许会告知调查员可以去看看最近的报纸。",
      "effect": "触发路人线索"
    },
    {
      "type": "on_enter_scene",
      "condition": "维森酒吧",
      "narration": "维森酒吧是在这个小镇唯二的酒吧，属于平民阶级与混混常来的场所。虽然禁酒令的施行在这种乡下地区确实不怎么到位，但是这么明目张胆的还是少数。这个酒吧拥有自己的保安，在这里闹事绝对不是一个明智的选择。",
      "effect": "进入维森酒吧"
    },
    {
      "type": "on_enter_scene",
      "condition": "报亭",
      "narration": "如果调查员没有在酒吧获得关于艾德里安的情报的话，聪明的调查员或许会想到看看报纸来获得情报。可以让调查员在报亭购买的报纸上看到几则最近刊登的人口失踪的报道。",
      "effect": "触发报亭线索"
    },
    {
      "type": "on_enter_scene",
      "condition": "绑架犯的报道",
      "narration": "昨日，在***农场国道***附近，警方逮捕了一名绑架犯，他当时正尝试击晕一位当地居民，在被发现时与警方发生了交火，不幸的是那位居民死于流弹，两名警员负伤，一名警员当场死亡。",
      "effect": "获取绑架犯报道"
    },
    {
      "type": "on_enter_scene",
      "condition": "霍姆斯医院",
      "narration": "这是一间看上去有些年头的建筑，墙面有些油漆脱落了，还有一块新一块旧的补丁。医院附近人不多，整间医院的照明有些次，整体稍微有些昏暗。医院有3层，一层是诊室与药房急诊等，二层与三层则是住院层。",
      "effect": "进入霍姆斯医院"
    },
    {
      "type": "on_enter_scene",
      "condition": "与艾德里安的会面",
      "narration": "艾德里安现在的随身物品已经都被收走，身上只有一套病号服。他半躺在床上，完全没有任何意识，调查员无论如何与他沟通，他都只能喃喃出自己妻子与女儿的名字，偶尔还会说出一些带有保护意味的词汇。",
      "effect": "与艾德里安会面"
    },
    {
      "type": "on_enter_scene",
      "condition": "关于艾米丽难产的事件",
      "narration": "如果问起其他医护人员关于艾德里安的情况，可以允许他们进行幸运判定，成功的话会遇到一位知道这件事的医护人员。",
      "effect": "触发艾米丽难产线索"
    },
    {
      "type": "on_enter_scene",
      "condition": "警察局",
      "narration": "普瑞米尔警局算是镇子里维护的比较不错的建筑，外面的墙壁可以看出是新刷过的油漆，星条旗在一旁的旗杆上飘扬。警局内没有什么人，附近也看不到脏乱和流浪汉的棚窝。",
      "effect": "进入警察局"
    },
    {
      "type": "on_enter_scene",
      "condition": "证物室",
      "narration": "进入证物室是非常难的事情，即使是这种偏僻的警察局也有严格的管理。如果调查员可以来到这里，则可以获得当时艾德里安身上的物品。",
      "effect": "进入证物室"
    },
    {
      "type": "on_enter_scene",
      "condition": "旅店",
      "narration": "一个双层建筑，一块不大的招牌摆在外面，整体看上去很整洁。进门就可以听到一些风铃声，令人心情不由得会变好一些。旅店提供基本的住宿，在一层有一个小餐厅。",
      "effect": "进入旅店"
    },
    {
      "type": "on_enter_scene",
      "condition": "交火现场",
      "narration": "这里已经是一片狼藉，鲜血泼洒了一地，还有一些粉笔印来诉说这里曾经发生过的事情。取证似乎已经完成，这里没有警员驻守，只有废弃的白色小车作为这里的地标。",
      "effect": "进入交火现场"
    },
    {
      "type": "on_enter_scene",
      "condition": "艾德里安在镇子内的住宅",
      "narration": "这是一栋独门独户的小别墅，是一个双层建筑，靠着贫民窟有些近，而且似乎已经荒废了有一段时间了，门前的草坪已经很久没有修整过。",
      "effect": "进入艾德里安在镇子内的住宅"
    },
    {
      "type": "on_enter_scene",
      "condition": "抽屉里的关于_号农场的转购协议",
      "narration": "这是一份有些年份的文书，上面记录了一项购买，购买者是艾德里安，似乎是想要用这里作为度假与养老的去处。详细查看可以知道，这份协议是非法的，属于私下购买，没有在有关部门登记。",
      "effect": "发现农场转购协议"
    },
    {
      "type": "on_enter_scene",
      "condition": "与背景",
      "narration": "作为一个20世纪的美国小镇，自然不会少了黑帮。调查员或许会与黑帮产生交互，不过黑帮并非此次事件的参与者，这些背景资料仅供参考。",
      "effect": "触发背景信息"
    },
    {
      "type": "on_enter_scene",
      "condition": "可选",
      "narration": "在城镇中的可选事件：作为一个20世纪的美国小镇，自然不会少了黑帮。调查员或许会与黑帮产生交互，但这些并非此次事件的参与者。",
      "effect": "触发可选事件"
    },
    {
      "type": "on_enter_scene",
      "condition": "艾德里安的农场",
      "narration": "这间农场周围围着很简单的木质栅栏，上面的油漆都已经被雨水腐蚀掉了。这是这附近唯一的农场，有着一些田地但完全没有打理的样子。除了主要入口的道路，外野草丛生。稍往里有两个比较显眼的建筑：一间红漆谷仓和一个农场主别墅。",
      "effect": "进入艾德里安的农场"
    },
    {
      "type": "on_enter_scene",
      "condition": "农场外围",
      "narration": "这里是非常危险的一个场景。艾德里安在外围布置了三种陷阱：捕兽夹、锯短霰弹枪拌锁陷阱、音响陷阱。请调查员务必小心。",
      "effect": "进入农场外围"
    },
    {
      "type": "on_enter_scene",
      "condition": "艾德里安会在外围布置_3_种陷阱",
      "narration": "艾德里安会在外围布置3种陷阱：捕兽夹（体形小于35可免疫，造成1D4+1伤害）、锯短霰弹枪拌锁陷阱（困难敏捷可躲避，造成1d6伤害）、音响陷阱（警报用途，现因艾德里安被捕而失效但仍可造成sc0/1d3）。",
      "effect": "触发陷阱说明"
    },
    {
      "type": "on_enter_scene",
      "condition": "农场主别墅",
      "narration": "从远处观察别墅，这个房子似乎被整体刷过白色油漆，但是也应该有段时间了。窗子上封了一些木板，这里看上去不像是在被使用的样子。",
      "effect": "进入农场主别墅"
    },
    {
      "type": "on_enter_scene",
      "condition": "谷仓形建筑",
      "narration": "这栋谷仓形建筑整体为金属结构，大门牢牢关着，只能从内部打开，侧面有一个看上去非常先进的防盗门。在一旁还有一些杂物堆，看上去可以上到屋顶。",
      "effect": "进入谷仓形建筑"
    },
    {
      "type": "on_enter_scene",
      "condition": "建筑内",
      "narration": "这里虽然外表是一处谷仓，不过内部似乎已经被简单改造过了。很显眼的就是放置在周围的床铺，床铺上还躺着人，他们的上半身被奇怪的仪器罩着，还有明显没有整理过的奇怪线路。在门口还有一具尸体，眼睛活睁地盯着大门。",
      "effect": "进入谷仓内部"
    },
    {
      "type": "on_enter_scene",
      "condition": "中控室",
      "narration": "跟随着灯光转过拐角，这间房间的门是打开着的。一台看上去非常高科技的大家伙占据了整间房间非常大的区域，有着3个显示器上面有一些红色警报。下面有控制台，许多按钮都没有标注。机器持续发出不小的风扇轰鸣声。这里还有一台冰箱与一个中型储藏柜。",
      "effect": "进入中控室"
    },
    {
      "type": "on_enter_scene",
      "condition": "艾德里安的卧室",
      "narration": "这是一间很简洁的卧室，一张单人床，一个床头柜，一个枪柜，仅此而已。衣服整洁地叠在床上，这里应该是他休息的地方。",
      "effect": "进入艾德里安的卧室"
    },
    {
      "type": "on_enter_scene",
      "condition": "下水道",
      "narration": "这似乎是一处废弃的下水道，应该是强行挖通过来的。这段下水道已经干涸了，周围的墙壁上长着青苔，充斥着腐烂与陈朽的味道，几乎没有光线透进来。",
      "effect": "进入下水道"
    },
    {
      "type": "on_enter_scene",
      "condition": "维修间",
      "narration": "这就是下水道的尽头了。这里被改造过，墙边安装着一些看上去像是医疗仪器的设备，还有一些生理盐水瓶和营养液。角落里放着一副散发着阴冷气息的长方形物体，有些像是电冰箱的样子，外边布置着线缆，连接着一个发电机；封边上似乎有些黏液。",
      "effect": "进入维修间"
    },
    {
      "type": "on_enter_scene",
      "condition": "与米戈的战斗",
      "narration": "Mi-Go 可能会出现在下水道维修处。它会使用修改版法术：僵尸创造术（6MP，2轮，复生尸体攻击生者）、纳克-提特障壁创建术、帕祖祖之息。请调查员做好准备。",
      "effect": "触发与Mi-Go的战斗"
    },
    {
      "type": "on_enter_scene",
      "condition": "关于缸中脑最后的去向",
      "narration": "如果调查员发现了缸中脑的真相，可以选择报警、告知医院或保守秘密。不同的选择将导向不同的结局。",
      "effect": "触发缸中脑处置"
    },
    {
      "type": "on_enter_scene",
      "condition": "结局",
      "narration": "根据调查员在模组中的行动，结算对应结局与奖励。共有4种结局：Normal End、Good End、Bad End、True End。",
      "effect": "触发结局结算"
    },
    {
      "type": "on_enter_scene",
      "condition": "主要_npc",
      "narration": "主要NPC：艾德里安（生物学教授，被米戈欺骗）、艾米丽（电子学教授，缸中脑）、爱莉（婴儿，缸中脑）。详见NPC数据。",
      "effect": "触发主要NPC说明"
    },
    {
      "type": "on_enter_scene",
      "condition": "可能的敌人类",
      "narration": "可能的敌对NPC：流浪汉（HP12，斗殴45）、警员（HP12，斗殴40，手枪55）、酒吧保镖（HP14，斗殴65，霰弹40）。详见NPC数据。",
      "effect": "触发敌对NPC说明"
    },
    {
      "type": "on_enter_scene",
      "condition": "以下的法术则视情况让_mi_go_使用",
      "narration": "Mi-Go 可根据战况使用修改版法术：僵尸创造术（6MP，2轮，理智不计）、纳克-提特障壁创建术（不计MP，1轮）、帕祖祖之息（3MP，即时）。Mi-Go 版法术消耗更低，理智不计。",
      "effect": "触发Mi-Go法术说明"
    }
  ],
  "sceneBgm": {
    "普瑞米尔": "town",
    "旅店": "town",
    "特里坎家": "domestic",
    "加比的拖车房": "domestic",
    "维森酒吧": "tavern",
    "霍姆斯医院": "institutional",
    "与艾德里安的会面": "institutional",
    "警察局": "institutional",
    "证物室": "institutional",
    "交火现场": "derelict",
    "艾德里安在镇子内的住宅": "derelict",
    "艾德里安的农场": "derelict",
    "农场主别墅": "derelict",
    "艾德里安的卧室": "derelict",
    "谷仓形建筑": "dread",
    "建筑内": "dread",
    "中控室": "dread",
    "下水道": "underground",
    "维修间": "dread"
  },
  "sceneAliases": {
    "维修间": [
      "维修室"
    ]
  },
  "runtimeNpcOrder": [
    "艾德里安·埃斯特鲁姆",
    "艾米丽·埃斯特鲁姆",
    "爱莉·埃斯特鲁姆",
    "菲碧·特里坎",
    "加比·特里坎",
    "米尔·特里坎",
    "流浪汉",
    "警员",
    "酒吧保镖",
    "食尸鬼",
    "mi-go"
  ],
  "runtimeNpcs": [
    {
      "sourceId": "艾德里安·埃斯特鲁姆",
      "sourceName": "艾德里安·埃斯特鲁姆",
      "sceneId": "与艾德里安的会面",
      "type": "npc",
      "hp": 14,
      "maxHp": 14,
      "ac": 10,
      "faction": "人类",
      "attributes": {
        "strength": 50,
        "dexterity": 65,
        "power": 80,
        "constitution": 70,
        "appearance": 55,
        "education": 75,
        "size": 70,
        "intelligence": 80
      },
      "skills": {
        "斗殴": 65,
        "手枪": 60,
        "步枪/霰弹枪": 60,
        "闪避": 60,
        "生物学": 75,
        "神秘学": 50,
        "克苏鲁": 20,
        "侦查": 50,
        "聆听": 50,
        "图书馆": 80,
        "法语": 40
      },
      "gender": "male",
      "dialogHints": [
        "言谈间带着教授的书卷气，但语气透露出绝望",
        "提到妻子时会变得情绪激动",
        "对自己的行动有扭曲的正义感——认为是在拯救家人",
        "谈及米戈时既有敬畏又有被背叛的愤怒"
      ],
      "personality": {
        "role": "生物学教授",
        "traits": {
          "courage": 7,
          "friendliness": 6,
          "suspicion": 6,
          "curiosity": 6,
          "stability": 6
        },
        "background": "生物学教授，曾参军，在学术界颇有威名。妻子艾米丽难产濒死时，他从一战遗迹的疯子笔记中发现了米戈联络术，病急乱投医把妻女从医院抢出带到农场，召唤米戈求助。被米戈欺骗，将妻女变成缸中脑，并开始绑架他人为米戈提供大脑。已绑架10人，在第11次行动时被警方发现交火，弹片击中头部瘫痪。",
        "goals": [
          "寻找合适的身体来安装妻女的大脑",
          "为米戈提供大脑以换取妻女存活"
        ],
        "secrets": [
          "米戈欺骗了他，其实米戈只是对人类知识好奇，并不打算真正救治他的妻女"
        ]
      }
    },
    {
      "sourceId": "艾米丽·埃斯特鲁姆",
      "sourceName": "艾米丽·埃斯特鲁姆",
      "sceneId": "维修间",
      "type": "npc",
      "hp": 4,
      "maxHp": 4,
      "ac": 10,
      "faction": "人类",
      "attributes": {
        "power": 60,
        "constitution": 15,
        "education": 82,
        "size": 5,
        "intelligence": 92
      },
      "skills": {
        "聆听": 70,
        "电子学": 92,
        "神秘学": 30,
        "克苏鲁": 20,
        "图书馆": 80,
        "博物学": 80
      },
      "gender": "female",
      "dialogHints": [
        "声音轻柔，意识清醒但身体无法动弹",
        "对丈夫既感激又怨恨的复杂情感",
        "谈及女儿爱莉时充满母爱与悲伤",
        "可以用电子的方式感知周围环境"
      ],
      "personality": {
        "role": "电子学教授/缸中脑",
        "traits": {
          "courage": 7,
          "friendliness": 6,
          "suspicion": 6,
          "curiosity": 6,
          "stability": 6
        },
        "background": "艾德里安的妻子，优秀的电子学专家。因难产濒死，被丈夫用米戈联络术变成了缸中脑，存放在下水道维修处的棺材中。"
      }
    },
    {
      "sourceId": "爱莉·埃斯特鲁姆",
      "sourceName": "爱莉·埃斯特鲁姆",
      "sceneId": "维修间",
      "type": "npc",
      "hp": 4,
      "maxHp": 4,
      "ac": 10,
      "faction": "人类",
      "attributes": {},
      "age": 0,
      "gender": "female",
      "dialogHints": [
        "仅能发出婴儿般无意识的哭声",
        "大脑被浸泡在营养液中进行非自然发育",
        "无法进行有意识的对话"
      ],
      "personality": {
        "role": "婴儿/缸中脑",
        "traits": {
          "courage": 7,
          "friendliness": 6,
          "suspicion": 6,
          "curiosity": 6,
          "stability": 6
        },
        "background": "艾德里安与艾米丽的女儿，因难产濒死后被父亲用米戈联络术变成缸中脑，与母亲一起存放在下水道维修处的棺材中。"
      }
    },
    {
      "sourceId": "菲碧·特里坎",
      "sourceName": "菲碧·特里坎",
      "sceneId": "特里坎家",
      "type": "npc",
      "hp": 8,
      "maxHp": 8,
      "ac": 10,
      "faction": "人类",
      "attributes": {
        "size": 50,
        "appearance": 55
      },
      "gender": "female",
      "dialogHints": [
        "语气焦急，作为母亲担心儿子的安危",
        "对警察的不信任感明显",
        "说话直接了当，事业女性的作风",
        "愿意支付高额报酬但希望尽快有结果"
      ],
      "personality": {
        "role": "银行职员",
        "traits": {
          "courage": 7,
          "friendliness": 6,
          "suspicion": 6,
          "curiosity": 6,
          "stability": 6
        },
        "background": "标准美国太太，丈夫因癌症去世但留下大量遗产。本人是银行工作人员，事业型女性。儿子加比失踪半个月后刊登寻人委托，不相信当地警察所以雇佣调查员。还有一个5岁的小女儿米尔。",
        "goals": [
          "找回儿子加比"
        ],
        "secrets": [
          "平时忙于工作，对孩子关心不够"
        ]
      }
    },
    {
      "sourceId": "加比·特里坎",
      "sourceName": "加比·特里坎",
      "sceneId": "建筑内",
      "type": "npc",
      "hp": 8,
      "maxHp": 8,
      "ac": 10,
      "faction": "人类",
      "attributes": {
        "size": 65,
        "appearance": 50
      },
      "age": 17,
      "gender": "male",
      "dialogHints": [
        "年轻气盛的说话方式",
        "在受害者状态下表现出恐惧和无助",
        "平时嚣张跋扈，但被绑架后精神接近崩溃"
      ],
      "personality": {
        "role": "无业游民",
        "traits": {
          "courage": 7,
          "friendliness": 6,
          "suspicion": 6,
          "curiosity": 6,
          "stability": 6
        },
        "background": "菲碧的儿子，17岁。典型的放肆子弟，父亲留下大量遗产让他挥霍无度。被艾德里安钓走并绑架，成为受害者之一。"
      }
    },
    {
      "sourceId": "米尔·特里坎",
      "sourceName": "米尔·特里坎",
      "sceneId": "特里坎家",
      "type": "npc",
      "hp": 8,
      "maxHp": 8,
      "ac": 10,
      "faction": "人类",
      "attributes": {
        "size": 24,
        "appearance": 60
      },
      "age": 5,
      "gender": "female",
      "dialogHints": [
        "天真幼稚的儿童语气",
        "对哥哥的失踪似懂非懂",
        "容易被引导但也会说出模糊的关键信息"
      ],
      "personality": {
        "role": "儿童",
        "traits": {
          "courage": 7,
          "friendliness": 6,
          "suspicion": 6,
          "curiosity": 6,
          "stability": 6
        },
        "background": "特里坎家的小女儿，年仅5岁。最后一次见到加比是在半个月前的晚上，看到哥哥穿得比平时严实，提着黑袋子急匆匆从车房出来顺着路走了。",
        "secrets": [
          "目睹了加比离开的细节，可以提供关键线索"
        ]
      }
    },
    {
      "sourceId": "流浪汉",
      "sourceName": "流浪汉",
      "sceneId": "艾德里安在镇子内的住宅",
      "type": "npc",
      "hp": 12,
      "maxHp": 12,
      "ac": 10,
      "faction": "人类",
      "attributes": {
        "dexterity": 50
      },
      "skills": {
        "斗殴": 45,
        "闪避": 55
      },
      "gender": "male",
      "dialogHints": [
        "说话含糊不清，偶尔打嗝",
        "对陌生人充满戒心",
        "提起酒就会变得兴奋",
        "言语粗俗，用词简单"
      ],
      "personality": {
        "role": "流浪汉",
        "traits": {
          "courage": 6,
          "friendliness": 4,
          "suspicion": 8,
          "curiosity": 5,
          "stability": 3
        },
        "background": "在农场外围一带徘徊的流浪汉，常年酗酒，精神不太正常。见到陌生人会警惕地打量，但如果给酒或钱就会变得相对配合。知道农场周围有一些奇怪的声音和动静，但不爱管闲事。",
        "goals": [
          "找下一顿酒钱",
          "找个暖和的地方过夜"
        ],
        "secrets": [
          "曾在深夜看到艾德里安往谷仓方向搬运大件物品"
        ]
      }
    },
    {
      "sourceId": "警员",
      "sourceName": "警员",
      "sceneId": "警察局",
      "type": "npc",
      "hp": 12,
      "maxHp": 12,
      "ac": 10,
      "faction": "人类",
      "attributes": {
        "dexterity": 60
      },
      "skills": {
        "斗殴": 40,
        "手枪": 55,
        "闪避": 50
      },
      "dialogHints": [
        "说话带着公事公办的口吻",
        "对交火事件心有余悸",
        "提到艾德里安时会压低声音",
        "用词正式但不算专业"
      ],
      "personality": {
        "role": "警员",
        "traits": {
          "courage": 7,
          "friendliness": 6,
          "suspicion": 7,
          "curiosity": 6,
          "stability": 7
        },
        "background": "小镇警局的普通警员，见过一些世面但不多。参与了艾德里安的交火事件，知道那是个危险人物。对调查员比较配合，但公事公办的态度。",
        "goals": [
          "维持小镇治安",
          "完成分内工作"
        ]
      }
    },
    {
      "sourceId": "酒吧保镖",
      "sourceName": "酒吧保镖",
      "sceneId": "维森酒吧",
      "type": "npc",
      "hp": 14,
      "maxHp": 14,
      "ac": 10,
      "faction": "人类",
      "attributes": {
        "dexterity": 55
      },
      "skills": {
        "斗殴": 65,
        "霰弹": 40,
        "闪避": 50
      },
      "dialogHints": [
        "话不多，简洁有力",
        "语气带着不耐烦",
        "对酒客态度粗鲁但有一定分寸",
        "提到加比时表示那小子不是好东西"
      ],
      "personality": {
        "role": "酒吧保镖",
        "traits": {
          "courage": 8,
          "friendliness": 4,
          "suspicion": 8,
          "curiosity": 4,
          "stability": 7
        },
        "background": "维森酒吧的保镖，身强力壮，见惯了小镇的各类人物。对酒客之间的纠纷习以为常，态度强硬但不主动挑事。如果有人捣乱会毫不犹豫地动手。",
        "goals": [
          "维持酒吧秩序",
          "避免麻烦"
        ]
      }
    },
    {
      "sourceId": "食尸鬼",
      "sourceName": "食尸鬼",
      "sceneId": "下水道",
      "type": "monster",
      "hp": 13,
      "maxHp": 13,
      "ac": 10,
      "faction": "敌对神话生物",
      "mythosCreatureId": "ghoul",
      "attributes": {
        "strength": 60,
        "constitution": 65,
        "size": 65,
        "dexterity": 90,
        "intelligence": 55,
        "power": 65
      },
      "skills": {
        "格斗": 40,
        "咬住": 40,
        "闪避": 40,
        "攀爬": 80,
        "跳跃": 70,
        "聆听": 70,
        "潜行": 70,
        "侦查": 50
      },
      "dialogHints": [
        "无法进行人类语言对话",
        "发出低沉的嘶吼和咕噜声",
        "行动时有骨骼摩擦的咔咔声"
      ],
      "personality": {
        "role": "食尸鬼",
        "background": "可选怪物。下水道中有艾德里安丢弃的大量尸体，非常适合食尸鬼生存。KP可以根据调查员的情况选择性放置。"
      }
    },
    {
      "sourceId": "mi-go",
      "sourceName": "Mi-Go",
      "sceneId": "维修间",
      "type": "monster",
      "hp": 11,
      "maxHp": 11,
      "ac": 10,
      "faction": "敌对神话生物",
      "mythosCreatureId": "mi_go",
      "attributes": {
        "strength": 40,
        "constitution": 40,
        "size": 70,
        "dexterity": 90,
        "intelligence": 65,
        "power": 85
      },
      "skills": {
        "潜行": 60,
        "飞行": 75,
        "科学(外星)": 80,
        "医学(外星)": 70
      },
      "dialogHints": [
        "不使用人类语言，通过心灵感应传递概念",
        "语气冰冷、不带情感，完全理性",
        "对人类感到好奇但不屑",
        "提及艾德里安时带有玩弄猎物的轻蔑"
      ],
      "personality": {
        "role": "Mi-Go",
        "background": "被艾德里安用古代联络术召唤而来的米戈。它对人类知识好奇，欺骗艾德里安说妻女只能变成缸中脑才能存活，要求艾德里安寻找合适的身体作为酬劳。实际上它只是利用艾德里安获取人类大脑。出现在下水道维修处。",
        "goals": [
          "收集人类大脑",
          "研究人类知识"
        ],
        "secrets": [
          "它欺骗了艾德里安，并不打算真正救治他的妻女"
        ]
      }
    }
  ],
  "legacyEndings": [
    {
      "id": "normal",
      "name": "Normal End",
      "description": "调查员没有知道事情的真相，简单的调查后放弃。",
      "conditionText": "调查员未了解真相就放弃案件。因艾德里安已逮捕不会再有人失踪，但米戈威胁仍在。"
    },
    {
      "id": "good",
      "name": "Good End",
      "description": "调查员报警解救受害者，加比被救下，但艾德里安动机仍是谜。",
      "conditionText": "调查员在发现受害者时直接报警，找到了失踪者并救下加比。艾德里安为何这么做仍是个谜，艾米丽或许会一辈子在下水道照顾爱莉。"
    },
    {
      "id": "bad",
      "name": "Bad End",
      "description": "调查员误拉拉杆杀死所有受害者。",
      "conditionText": "调查员在中控室拉下拉杆，害死了所有受害者。即使法律不制裁，内心也难以原谅自己的草率行动。"
    },
    {
      "id": "true",
      "name": "True End",
      "description": "调查员找到事件真相，报警解救受害者，获小镇感谢与委托金。",
      "conditionText": "调查员发现了下水道缸中脑与事件真相，报警解救受害者。下水道的秘密永久埋藏。"
    },
    {
      "id": "near_truth",
      "name": "Near-Truth End",
      "description": "调查员到达终局场景，见到了缸中脑，却没能读懂日记里的老旧文件，不知道自己目睹的是什么。",
      "conditionText": "调查员到过维修间并发现缸中脑，但未能解读老旧文件揭示的真相。"
    }
  ],
  "itemPlacements": [
    {
      "name": "防盗门的钥匙",
      "sceneId": "证物室",
      "description": "用来打开艾德里安农场谷仓的门。在这个小镇里，这种先进防盗门可不多见。"
    },
    {
      "name": "农场的照片",
      "sceneId": "证物室",
      "description": "可以对照着在小镇周围找到一致的农场，是艾德里安藏匿的农场。本地调查员也可以通过灵感知道小镇附近有类似的建筑，而后通过一个成功的导航找到农场。导航失败可寻求本地 NPC 的帮助。（高级警员身份开局不给予此照片，改为身份证地址。）"
    },
    {
      "name": "钱包",
      "sceneId": "证物室",
      "description": "艾德里安的钱包，在交火现场路边的垃圾堆旁发现。内含其驾驶证与住宅钥匙等个人物品。"
    },
    {
      "name": "驾驶证",
      "sceneId": "证物室",
      "description": "可以知道艾德里安在小镇内住址。（若已知农场地址则此线索无额外价值。若在交火现场已发现则此条目去除。）"
    },
    {
      "name": "住宅钥匙",
      "sceneId": "交火现场",
      "description": "打开镇子中住宅的门。"
    },
    {
      "name": "捕兽夹",
      "sceneId": "农场外围",
      "description": "体形小于 35 的角色会免疫这种陷阱。踩中时陷阱咬住腿部造成 1D4+1 伤害。挣脱需困难成功力量，大失败或乱动造成额外 1d3 伤害。伤害超耐久半值有截肢风险。"
    },
    {
      "name": "锯短霰弹枪拌锁陷阱",
      "sceneId": "农场外围",
      "description": "踩到陷阱的调查员有困难敏捷机会躲避。霰弹枪朝拌锁位置开火造成 1d6 伤害。无备弹且枪管被锯断，无法作为调查员武器再利用。"
    },
    {
      "name": "音响陷阱",
      "sceneId": "农场外围",
      "description": "原本为警报陷阱，现艾德里安已被捕而失效。但 KP 仍可以巨大响声为由对所有调查员造成 sc0/1d3 惩罚，且下个侦查骰有惩罚骰。一字队伍前进只需团队幸运/侦查判定。"
    },
    {
      "name": "硫酸陷阱",
      "sceneId": "农场主别墅",
      "description": "从门上倒下一瓶硫酸，按可选部位规则命中。造成 1D4+1 初始伤害，未摆脱则持续 1D3/回合直至昏迷（不造成重伤）。可用闪避躲避。需清水急救，清洗后无论急救成败均停止伤害。根据命中部位酌情减少 App 或 CON。"
    },
    {
      "name": "老旧文件",
      "sceneId": "艾德里安的卧室",
      "description": "这份文件是艾德里安偶然在一战遗迹中发现的前线疯子的笔记，上面记载着这些疯子所认为的米戈联络术。这些疯子相信米戈能帮助他们脱离肉体的桎梏，不再接受任何肉体的磨难。艾德里安原本对此没有研究兴趣，但在妻子难产濒死的打击下病急乱投医。"
    }
  ],
};

// ─── 导出数据 ──────────────────────────────────────────────
const moduleData: RuntimeModuleData = {
  id: "premiers_barn",
  title: "普瑞米尔的谷仓",
  version: "ver1.03",
  ruleset: "cosmic-horror",
  era: "1921",
  summary: `模组为线性半 City 类模组。长度中短，比较适合新人 PL 适应 COC 的环境，且难度不高。因为事件已经完成，调查员可以说类似于去收尾的警察一般。即使调查员失败，也不会失去更多的东西了。`,

  scenes: buildScenes(),
  npcs: buildNpcs(),
  items: buildItems(),

  meta: {
    author: "MikuFan",
    playerCount: "2~3",
    expectedDuration: "中短",
    triggerWarnings: [
      "可能包含稍微过激的场景",
      "一些比较令人胃痛的设定",
    ],
  },

  endings: buildEndings(),
  partySetup: {
    context: [
      "1921年，范·特里坎镇。",
      "菲碧·特里坎的儿子加比已经失踪半个月了。两名调查员接下了这个案子。",
      "他们从委托人住宅——特里坎家——开始，逐户走访、循迹追查少年失踪的真相。",
    ],
    // ⚠ 这两条返工过。原文是：
    //   "{name}的办公桌上摊着一封委托信。作为{occupation}，他见过太多案子——但这个失踪案，他总觉得不太对劲。"
    //   "{name}被老搭档叫上的时候没多问——{occupation}，他知道对方不会无缘无故找他。"
    // 两个毛病：
    //   1. 写死「他」。车卡是随机的，名字池里一半是女名 ——
    //      于是「玛丽·布朗……作为飞行员，**他**见过太多案子」。
    //      根因是 `randomCoCName` 当时不返回性别，模板作者除了写死没有别的选择。
    //   2. 「见过太多案子」把**侦探的履历**安给了所有职业。
    //      调查员是随机职业：护士、飞行员、艺术家、消防员……
    //      他们不「见过太多案子」，这个失踪案对他们恰恰是头一遭。
    //      职业换得越多，这句越假。
    // 现在：代词走 {pronoun}，句子只说**这个职业真的会有的处境**，
    // 不替角色编履历。
    hooks: [
      "一封委托信摊在{name}的桌上。信纸边角被反复摩挲得起了毛——写信的人显然犹豫了很久。{pronoun}是{occupation}，这类事本不该找上{pronoun}。",
      "老搭档找到{name}的时候，只说了句「有件事得请你搭把手」。{pronoun}做{occupation}这些年，知道对方不会无缘无故开口。",
    ],
    closing: [
      "他们的调查，从这所小镇的普通工人家庭开始……",
    ],
  },
  prologue: {
    lines: [
      "1921年，范·特里坎镇。",
      "",
      "一封拜托的信递到了{pl1_name}的办公室里。",
      "{pl1_name}看完信内容，久久没有放下——但这个失踪案，他总觉得不太对劲。",
      "他叫上了老搭档{pl2_name}，两人合作过不止一次。",
      "",
      "发信人是菲碧·特里坎，她的儿子加比已经失踪半个月了。",
      "{pl1_motive}。{pl2_motive}。",
      "",
      "他们的调查，从这所小镇的普通工人家庭开始……",
    ],
  },
  epilogues: buildEpilogues(),
  narrative: {
    entities: [
      {
        id: "ent_gabi_trailer",
        name: "院子一旁的拖车房",
        // 菲碧的 knowledge 原文是"加比比较叛逆，喜欢出去玩，十五岁就搬到外面拖车住了"，
        // LLM 复述时用词会变，所以按词根匹配而不是整句。
        mentionKeywords: ["拖车"],
        sceneId: "加比的拖车房",
        // 会下意识把话里的东西和眼前景物对上的职业。留空则人人都会注意到，
        // 那样这段就不再是"某个人的习惯"，而是引擎在提示玩家。
        noticedBy: ["侦探", "警", "探员", "记者", "猎人", "摄影"],
        // 踩模组原文那句"在一旁可以看到一个拖车车房……通过窗子可以看到也有在使用的痕迹"。
        // 不写第三人称代词：调查员是随机生成的，性别不定，
        // 写死"他"会撞上女性调查员（实跑里已经撞过一次：玛格丽特·哈里斯）。
        recognition:
            "{name}没有接话，视线越过菲碧的肩膀，落在院子一旁那座拖车房上——" +
            "进门时就瞥见过它，只当是搁杂物的地方，窗玻璃后面隐约有生活过的痕迹。" +
            "此刻那点痕迹忽然有了归属：那不是杂物间，那是那个失踪男孩住的地方。",
      },
    ],
  },
  runtime: BARN_RUNTIME,
};

// 自动为所有带 knowledge[] 的 NPC 生成 llmExpanded（已有手动编写的不会被覆盖）
// 步骤 5B：把迁移用 runtimeNpcs 列表一次性嵌入对应叙事 NPC；嵌入后删除
// 过渡列表，避免同一 snapshot 在 runtime 与 ModuleNPC.runtime 双处维护。
// 匹配异常会在模块初始化时失败，不允许静默覆盖或丢弃。
const runtimeNpcSnapshots = BARN_RUNTIME.runtimeNpcs ?? [];
moduleData.npcs = attachRuntimeNpcs(moduleData.npcs, runtimeNpcSnapshots);
delete BARN_RUNTIME.runtimeNpcs;
applyAllLlmExpanded(moduleData.npcs);

export default moduleData;
export const BARN_OF_PREMIER = moduleData;

// ─── 场景构建 ──────────────────────────────────────────────
function buildScenes(): Scene[] {
  const scenes: Scene[] = [];

  // 0. 特里坎家 (Tricam House)
  scenes.push({
    id: "特里坎家",
    name: "特里坎家",
    description: S.TRICAM_HOUSE,
    clues: [],
    npcIds: ["phoebe_tricam", "mir_tricam"],
    // 场景描述原文就写了"在一旁可以看到一个拖车车房"——视线是原作给的，不是这里新编的
    visibleEntities: ["ent_gabi_trailer"],
    // ⚠ 原文写的是「只见**米尔·特里坎**正抱着篮球站在院里」——
    // 调查员这时刚走到门口，还没见过任何人，**不可能知道这孩子叫什么**。
    // 叙述用了角色自己拿不到的信息，读起来像旁白替他们作弊。
    // 名字要等 NPC 自报或菲碧介绍之后才能出现在正文里。
    openingAtmosphere: `还没走到门口，你们便听见院里传来一下一下拍打皮球的声音，节奏很慢，像是有人在随意消磨时间。循声望去，一个小女孩正抱着篮球站在院里，一下一下地拍着。她察觉到你们走近，抬起头怯生生地望了一眼，随即丢下球，转身跑回屋内，门在身后轻轻带上。院落重新安静下来，只有风吹过太阳伞的轻响——接下来，该由你们叩响那扇门了。`,
    isHome: true,
    connections: [
      { targetSceneId: "加比的拖车房", condition: "前往加比的拖车房" },
      { targetSceneId: "普瑞米尔", condition: "返回镇上" },
    ],
    atmosphere: "因为考虑到终局的那一幕，这里可以稍微多的展示一下米尔对菲碧的依赖与菲碧对于孩子失踪的不安、焦虑。这些信息在终局会对调查员留下非常巨大的落差。",
  });

  // 1. 加比的拖车房 (Gabi's Trailer)
  const gabiClues: Clue[] = [
    {
      id: "clue_pistol_in_bag",
      name: "黑袋子中的手枪",
      description: "一个黑袋子，里面是一把手枪与数只弹匣。手枪上的铭文已经被磨平，而且还似乎有些上锈，应该是什么人用的二手货，而且绝对非法。1911手枪：因为磨损故障值为90，伤害为d10+2，具有贯穿属性。",
      findMethods: [
        { type: "skill", skillName: "侦查", difficulty: "regular", description: "侦查休息区/仔细检查床底" },
      ],
      revelation: "找到一把非法1911手枪，故障值90，伤害d10+2，贯穿属性。",
      unlocks: [],
      found: false,
      importance: "color",
    },
    {
      id: "clue_drugs",
      name: "毒品",
      description: "一些毒品。○粉、海○因，之类的东西，数量不多，但是足够定罪了。",
      findMethods: [
        { type: "skill", skillName: "侦查", difficulty: "regular", description: "侦查卫生间/仔细检查洗漱用具" },
      ],
      revelation: "找到一些毒品，数量不多但足够定罪。",
      unlocks: [],
      found: false,
      importance: "color",
    },
    {
      id: "clue_card",
      name: "奇怪的卡片",
      description: "一张小卡片，上面似乎是小广告。卡片上的日期大约是2个月前。内容：还在犹豫的男男女女们！还在犹豫什么时候出手享受世界吗！**月**日晚8:00在维森酒吧，享受狂欢！足量酒水免费供应。还有更多你喜欢的东西！享受生活，就是现在！",
      findMethods: [
        { type: "observation", description: "侦查餐厅/宣言仔细检查餐桌：可以发现在披萨盒下面有一张小卡片" },
      ],
      revelation: "一张2个月前的维森酒吧狂欢派对小卡片，免费酒水供应。",
      unlocks: ["clue_bar_mass_booking"],
      found: false,
      importance: "core",
    },
  ];

  scenes.push({
    id: "加比的拖车房",
    name: "加比的拖车房",
    description: S.GABI_TRAILER,
    clues: gabiClues,
    npcIds: [],
    connections: [
      { targetSceneId: "特里坎家", condition: "返回特里坎家" },
    ],
    atmosphere: "这里有加比生活过的痕迹，细细搜查应该能找到什么。",
  });

  // 2. 普瑞米尔 — 枢纽（包含镇内所有子场景）
  scenes.push({
    id: "普瑞米尔",
    name: "普瑞米尔",
    description: S.TOWN,
    clues: [],
    npcIds: [],
    connections: [
      { targetSceneId: "特里坎家", condition: "前往特里坎家" },
      { targetSceneId: "维森酒吧", condition: "前往维森酒吧" },
      { targetSceneId: "警察局", condition: "前往警察局" },
      { targetSceneId: "霍姆斯医院", condition: "前往霍姆斯医院" },
      { targetSceneId: "报亭", condition: "前往报亭" },
      { targetSceneId: "旅店", condition: "前往旅店" },
      { targetSceneId: "交火现场", condition: "前往城外交火现场" },
      { targetSceneId: "艾德里安在镇子内的住宅", condition: "前往艾德里安在镇子内的住宅" },
      { targetSceneId: "艾德里安的农场", condition: "前往郊外的艾德里安农场" },
    ],
  });

  // 3. 维森酒吧
  const barClues: Clue[] = [
    {
      id: "clue_bar_mass_booking",
      name: "酒吧包场情报",
      description: "使用卡片询问免费饮品的事情：大多数的保安、客人都会选择不回答或者不知道。询问前台则需要给予足够的小费（10$或以上）/成功的取悦才可以得知，之前是一位贵客包下了酒吧，在那天请当地的很多男男女女来到这里狂欢，并且他付了那一夜的所有钱，只是来的人都需要稍微做登记这一点有些奇怪以外，酒吧没有任何理由拒绝这样的行为。",
      findMethods: [
        { type: "skill", skillName: "取悦", difficulty: "regular", description: "给予足够的小费（10$或以上）/成功的取悦前台" },
      ],
      revelation: "一位贵客包下了酒吧，举办狂欢派对，但来的人需要做登记。",
      unlocks: ["clue_bar_guest_identity"],
      found: false,
      importance: "core",
      // 开发·在场实体与线索路径 N7（todo-41）：这条线索的唯一获取路径
      // 是"前台"，原文写的是「询问前台则需要给予足够的小费/成功的取悦
      // 才可以得知」——玩家实跑试过「用卡片」「问名单」「问包场者」
      // 「问马克/旧仓库」四种自然问法，全部因为场景里没有一个叫"前台"
      // 的实体、这条线索也没有 matchTexts 而全部落空，最后编出「老板
      // 锁进抽屉」这类模组里不存在的东西。这里补的词只取原文/revelation
      // 里出现过的、玩家实测真的会用来指代这件事的说法——"包场"/"登记"
      // 是原文动作本身，"免费饮品"是玩家实跑第一句真实用过的措辞，
      // "小费"对应原文给出的具体代价。
      //
      // 开发·把已有判据补齐到手写侧 N8：不收"前台"——它是两条线索共同
      // 要问的对象，不是任何一条专属的称呼，同一份克制见 7d9e6f1 排除
      // "设备"/"容器"的理由（learn-gate 条件 c 的同一条道理，这里手写
      // 也要守）。scene-matchtext-collision.ts 的判据核实过：现在
      // "前台" 完全不出现在本场景任何线索的 matchTexts 里，靠场景内
      // 唯一命中的具体词（包场/登记/免费饮品/小费）区分。
      matchTexts: ["包场", "登记", "免费饮品", "小费"],
    },
    {
      id: "clue_bar_guest_identity",
      name: "贵客身份",
      description: "进一步的套话很难办到。如果想要询问这位贵客的身份，不仅需要付出大量的现金，还要通过一个至少困难成功的社交类技能。如果成功从前台嘴中套出话，前台会告诉是艾德里安·埃斯特鲁姆先生。本地调查员可以通过一个成功的灵感得知艾德里安似乎是一个星期前被逮捕的绑架犯，似乎在报纸上看过这么一条信息，但是具体的倒是记不清了。",
      // 开发·把已有判据补齐到手写侧 N8 任务③核实：`skillName` 不是空的——
      // 原文写的是「社交类技能」这个族（说服/话术/魅惑/恐吓等 CoC 技能
      // 都能算），这里落地成具体的「社交」一项，经 `SKILL_NAME_MAP`
      // （`character/coc-character.ts:63`）译成 CoC 键 `fast_talk`，
      // `fast_talk` 在 `GameSession.INVESTIGATIVE_SKILLS` 名单里，检定
      // 路径正常触发——`barn-of-premier-clue-bridge.test.ts:76-77` 已经
      // 测过这条映射，实跑核对过 `investigation.clueTypes.get(
      // "clue_bar_guest_identity").coc_primary.skill === "fast_talk"`。
      // 选"社交"而不是族里其它成员是既有决定，不是本轮改的；保留现状，
      // 不强行把"族"拆成更精确的单项——那样反而是编造原文没给的细节。
      findMethods: [
        { type: "skill", skillName: "社交", difficulty: "hard", description: "付出大量现金+至少困难成功的社交类技能" },
      ],
      revelation: "包下酒吧的贵客是艾德里安·埃斯特鲁姆——本地调查员可通过灵感得知他是一个星期前被逮捕的绑架犯。",
      unlocks: [],
      found: false,
      importance: "core",
      // 与上一条同一批补充：unlocks 保证这条只在 clue_bar_mass_booking
      // 已发现后才成为候选。不收"艾德里安"——那是 revelation 才会揭示
      // 的名字，发现前玩家不会知道要问这个词，收进 matchTexts 没有
      // 意义，还会在真实对话里提前泄露。
      //
      // 开发·把已有判据补齐到手写侧 N8：不收"前台"，理由同上一条——
      // 两条线索共同要问的对象，不是任何一条专属的称呼，登记表是
      // "贵客"/"身份"/"套话"/"现金"这类只属于套身份这件事本身的词。
      matchTexts: ["贵客", "身份", "套话", "现金"],
    },
    {
      id: "clue_bar_ask_around",
      name: "向其他人打听艾德里安",
      description: "如果向其他人打听艾德里安则判断幸运来看看这些人有没有喜欢八卦的，但是请记住，没有免费的情报，如果对方知道你有求于人，必定会要求相应的代价。",
      findMethods: [
        { type: "skill", skillName: "幸运", difficulty: "regular", description: "向其他人打听艾德里安，需判断幸运" },
      ],
      revelation: "需要付出代价才能获得情报。",
      unlocks: [],
      found: false,
      importance: "bonus",
      // "打听"单独一个词太短，玩家真说"打听"两个字时（没有别的内容）
      // decideClueMatch 本身就会判成没有信号（fallback），不算这条
      // 别名"命中别的线索"，但一样过不了 learn-gate 条件 b（不是
      // resolve），登记它没有意义，删掉；"向其他人打听艾德里安"这类
      // 真实语句本来就靠"其他人"命中，不依赖"打听"这个词单独出场。
      matchTexts: ["其他人", "八卦", "客人"],
    },
  ];
  scenes.push({
    id: "维森酒吧",
    name: "维森酒吧",
    description: S.WEISEN_BAR,
    clues: barClues,
    // 原文四类人里，只有「保安」（不回答）与「前台」（真正的情报源）
    // 是有具体行为描述、值得建成 NPC 的对象——「客人」「其他人」是
    // 泛指的路人群体，不是单一可对话对象，与 police/tramp 那种"用一个
    // 实体代表一整类角色"的既有先例不同（那些角色本身就是同质的战斗
    // 单位/背景群像），这里的"客人"没有共同行为可供一个实体承担，
    // 不硬造。
    npcIds: ["bar_bouncer", "bar_receptionist"],
    connections: [
      { targetSceneId: "普瑞米尔", condition: "返回镇上" },
    ],
    atmosphere: "维森酒吧鱼龙混杂，小费文化在这里尤其盛行。",
  });

  // 4. 报亭
  const newsstandClues: Clue[] = [
    {
      id: "clue_newspaper_missing",
      name: "人口失踪报道",
      description: "调查员可以在报亭购买的报纸上看到几则最近刊登的人口失踪的报道。",
      findMethods: [{ type: "observation", description: "购买报纸阅读" }],
      revelation: "看到几则最近刊登的人口失踪报道。",
      unlocks: ["clue_newspaper_kidnapper"],
      found: false,
      importance: "core",
      // 开发·把已有判据补齐到手写侧 N8："报纸""报道"会撞上
      // clue_newspaper_kidnapper 自己的名字（"绑架犯的报道"）与
      // findMethods 描述（"…找到关于艾德里安的报道"）、以及它的
      // matchTexts 里的"旧报纸"/"废报纸"（都以"报纸"为子串）——
      // scene-matchtext-collision.ts 的判据能确定性抓出这两个词，改用
      // 只属于这条线索自己的说法："买报纸"/"人口失踪"两个词场景内唯一。
      matchTexts: ["买报纸", "人口失踪"],
    },
    {
      id: "clue_newspaper_kidnapper",
      name: "绑架犯的报道",
      description: "调查员在废报纸中花些时间翻阅，成功的图书馆技能会让他们找到关于艾德里安·埃斯特鲁姆的报道。" + S.KIDNAPPER_REPORT,
      findMethods: [
        { type: "skill", skillName: "图书馆", difficulty: "regular", description: "在废报纸中翻阅，成功的图书馆技能找到关于艾德里安的报道" },
      ],
      revelation: S.KIDNAPPER_REPORT,
      unlocks: [],
      found: false,
      importance: "core",
      // 原文（模组 PDF 报亭一节）：问老板要旧报纸，老板嫌翻找麻烦拒绝，
      // 但提出购买的话会以市场价 3 倍出售——这条交易规则已经写在下面
      // atmosphere 里。
      //
      // 开发·把已有判据补齐到手写侧 N8："旧报纸"/"废报纸"都以"报纸"为
      // 子串，会撞上 clue_newspaper_missing 的"买报纸"——改成"老板"/
      // "绑架犯"两个词，都只在这条线索里出现，场景内唯一；"问老板要
      // 旧报纸"这类自然说法本来就含"老板"，不依赖"旧报纸"这个词本身。
      matchTexts: ["老板", "绑架犯"],
    },
  ];
  scenes.push({
    id: "报亭",
    name: "报亭",
    description: "调查员可以通过报亭购买报纸获取信息。",
    clues: newsstandClues,
    npcIds: ["newsstand_owner"],
    connections: [
      { targetSceneId: "普瑞米尔", condition: "返回镇上" },
      { targetSceneId: "霍姆斯医院", condition: "根据报道前往霍姆斯医院" },
    ],
    atmosphere: "报亭老板认为翻找旧报纸太麻烦，不如直接交给废纸场处理。如果调查员提出购买这批废报纸，老板会以市场价3倍的价格出售。",
  });

  // 5. 霍姆斯医院
  const hospitalClues: Clue[] = [
    {
      id: "clue_emily_birth",
      name: "关于艾米丽难产的事件",
      description: "如果问起其他医护人员关于艾德里安的情况，可以允许他们进行幸运判定，成功的话会遇到一位知道这件事的医护人员。但这件事对于医院来说属于污名，他不会愿意轻易透露。成功的信誉或成功的社交技能可以让医护人员相信眼前的人，会在安静的地方说出真相：艾德里安的妻子艾米丽在一年前生育时因为当时的实习护士的疏忽，使用了应修缮的推床导致床铺失控且艾米丽流产、大出血，面临生命危险，当时艾德里安先生做出了过激行为，拿着枪冲进抢救室，把他的妻子抱走了。院方考虑到这件事本是自己的责任，同时艾德里安也没有做出伤害到医院利益的行为，选择了沉默。但是根据医护人员的想法，艾米丽不可能再活下来。而婴儿也很难说。（这其实是真相，对外宣称只是艾米丽难产。）",
      findMethods: [
        { type: "skill", skillName: "幸运", difficulty: "regular", description: "幸运判定成功则遇到知道此事的医护人员" },
        { type: "skill", skillName: "信誉", difficulty: "regular", description: "成功的信誉或成功的社交技能让医护人员说出真相" },
      ],
      revelation: "艾米丽一年前因医院疏忽导致流产大出血，艾德里安持枪将妻女抢出医院。医院因自身责任选择沉默。",
      unlocks: [],
      found: false,
      importance: "core",
      // 开发·约束层补角色实体域 N9 任务 D（todo-57）：这条线索的唯一
      // 获取路径是"问起其他医护人员"（原文：问起其他医护人员关于
      // 艾德里安的情况，先幸运判定遇到愿意开口的那位，再信誉或社交
      // 检定让对方说出真相）——与维森酒吧/报亭同一形状的缺口，
      // scene-npc-noun-registry.ts 扫出来的。"医护人员"是要问的对象，
      // "信誉"对应原文给出的第二道检定方式；不收"护士"——原文提到的
      // "实习护士"是一年前出事故的那个人，是历史背景，不是现在能找
      // 去问话的在场角色，登记这个词会制造假阳性。
      matchTexts: ["医护人员", "信誉"],
    },
  ];
  scenes.push({
    id: "霍姆斯医院",
    name: "霍姆斯医院",
    description: S.HOSPITAL,
    clues: hospitalClues,
    npcIds: ["hospital_staff"],
    connections: [
      { targetSceneId: "普瑞米尔", condition: "返回镇上" },
      { targetSceneId: "与艾德里安的会面", condition: "前往艾德里安的病房（需通过门口警员的检查）" },
    ],
    atmosphere: "艾德里安现在处于被严格监控的状态，病房门口有两名警员值守，没有合适的身份与理由无法进入。",
  });

  // 5b. 与艾德里安的会面（医院病房子场景）
  const adrianMeetingClues: Clue[] = [
    {
      id: "clue_adrian_mumbling",
      name: "艾德里安的喃喃自语",
      description: "艾德里安半躺在床上，完全没有任何意识，只能喃喃出自己妻子与女儿的名字，偶尔还会说出一些带有保护意味的词汇。",
      findMethods: [{ type: "observation", description: "观察艾德里安的状态" }],
      revelation: "艾德里安意识不清，只能喃喃妻子和女儿的名字。",
      unlocks: ["clue_adrian_psychoanalysis"],
      found: false,
      importance: "core",
    },
    {
      id: "clue_adrian_psychoanalysis",
      name: "精神分析后的供词",
      description: "如果调查员投掷了成功的精神分析，可以让他短暂的恢复神智。恢复神智的他极具攻击性，他的思想还停留在那一夜，会尝试压制住眼前的调查员。成功的社交类技能才可以让他冷静下来。如果他冷静了下来，会认罪，并宣言那些失踪案件都是自己所做，但是要求调查员帮助他的妻女，并且他会告知藏匿的农庄。",
      findMethods: [
        { type: "skill", skillName: "精神分析", difficulty: "regular", description: "成功的精神分析让他短暂恢复神智" },
        { type: "skill", skillName: "社交", difficulty: "regular", description: "成功社交类技能让他冷静下来" },
      ],
      revelation: "艾德里安认罪，承认所有失踪案为自己所做，要求调查员帮助他的妻女，并告知藏匿的农场位置。",
      unlocks: ["clue_adrian_farm_location"],
      found: false,
      importance: "core",
    },
    {
      id: "clue_adrian_farm_location",
      name: "艾德里安藏匿的农场",
      description: "艾德里安告知调查员他藏匿妻女的农庄位置（即艾德里安的农场）。",
      findMethods: [{ type: "npc_dialogue", description: "艾德里安冷静后主动告知" }],
      revelation: "得知艾德里安藏匿的农场位置。",
      unlocks: [],
      found: false,
      importance: "core",
    },
    {
      id: "clue_adrian_wallet",
      name: "艾德里安的随身物品线索",
      description: "如果调查员从证物室获得或从交火现场找到艾德里安的东西（驾驶证、住宅钥匙、农场照片等），可得知他镇内的住址和农场位置。",
      findMethods: [
        { type: "item", description: "从证物室/交火现场获取艾德里安的物品" },
      ],
      revelation: "通过艾德里安的物品获知镇内住址和农场位置。",
      unlocks: [],
      found: false,
      importance: "core",
    },
  ];
  scenes.push({
    id: "与艾德里安的会面",
    name: "与艾德里安的会面",
    description: "艾德里安现在的随身物品已经都被收走，身上只有一套病号服，可以看到病房的窗子都被临时加固了铁栏杆。他半躺在床上，完全没有任何意识，调查员无论如何与他沟通，他都只能喃喃出自己妻子与女儿的名字，偶尔还会说出一些带有保护意味的词汇。",
    clues: adrianMeetingClues,
    npcIds: ["adrian_estrum"],
    connections: [
      { targetSceneId: "霍姆斯医院", condition: "返回医院大厅" },
      { targetSceneId: "艾德里安的农场", condition: "前往艾德里安的农场" },
    ],
    atmosphere: "警员会限制与艾德里安的接触时间，一旦注意到异常会强行将调查员赶出。",
  });

  // 6. 警察局
  const policeClues: Clue[] = [
    {
      id: "clue_police_missing_cases",
      name: "失踪案信息",
      description: "在警局可以根据调查员已知的线索给出下一条信息。如果调查员只知道加比失踪，可以知道这里最近还有很多的失踪案。如果已知有很多失踪案，可以知道有绑架犯被捕的消息。如果调查员有警方相关的角色，也可以通过社交技能获取相关信息基本与报纸上报道的无二。",
      findMethods: [{ type: "npc_dialogue", description: "在警局询问警察" }],
      revelation: "得知近期有多起失踪案，以及绑架犯被捕的消息。",
      unlocks: ["clue_police_evidence_room"],
      found: false,
      importance: "core",
    },
    {
      id: "clue_police_evidence_room",
      name: "证物室",
      description: "进入证物室是非常难的事情，即使是这种偏僻的警察局也有严格的管理。如果调查员可以来到这个地方，则可以获得当时艾德里安身上的物品。包括一把防盗门的钥匙，一张农场的照片，他本人的钱包与驾照。当然，还有他所使用的手枪与电棒。",
      findMethods: [
        { type: "skill", skillName: "话术", difficulty: "hard", description: "需要有合适的身份或通过社交技能才能进入证物室" },
      ],
      revelation: "获得艾德里安的物品：防盗门钥匙、农场照片、钱包、驾照、手枪、电棒。",
      unlocks: [],
      found: false,
      importance: "core",
    },
  ];
  scenes.push({
    id: "警察局",
    name: "警察局",
    description: S.POLICE_STATION,
    clues: policeClues,
    npcIds: ["police"],
    connections: [
      { targetSceneId: "普瑞米尔", condition: "返回镇上" },
      { targetSceneId: "证物室", condition: "尝试进入证物室" },
      { targetSceneId: "艾德里安在镇子内的住宅", condition: "前往镇内住宅" },
    ],
  });

  // 6b. 证物室
  scenes.push({
    id: "证物室",
    name: "证物室",
    description: S.EVIDENCE_ROOM + "如果调查员可以来到这里，则可以获得当时艾德里安身上的物品：防盗门钥匙、农场照片、钱包、驾照、手枪与电棒。",
    clues: [],
    npcIds: [],
    connections: [
      { targetSceneId: "警察局", condition: "返回警察局" },
    ],
  });

  // 7. 旅店（步骤 2b 补接：ModuleData 侧漏建，S.HOTEL 常量已有完整描述）
  scenes.push({
    id: "旅店",
    name: "旅店",
    description: S.HOTEL,
    clues: [],   // 原文明确「没有什么特别之处」，无定义线索——是数据忠实而非遗漏。
                 // 原文提到「可以从服务生或老板嘴里套出一些当地情况」，
                 // 但没有给出具体信息、检定要求或 NPC 名称，属于叙事氛围描写，
                 // 不是可实现的线索机制。MythosModule 侧同样是空场景（0 clue/npc/item）。
    npcIds: [],
    connections: [
      { targetSceneId: "普瑞米尔", condition: "返回镇上" },
    ],
    atmosphere: "这里仅仅是一个给予调查员落脚地点的旅店。没有什么特别之处，不过调查员依然可以在这里从服务生或者老板嘴里套出一些当地的情况。",
  });

  // 8. 交火现场
  const shootoutClues: Clue[] = [
    {
      id: "clue_shootout_wallet",
      name: "黑色钱包",
      description: "在路边的垃圾堆旁发现一个黑色钱包，正是艾德里安的东西。翻看钱包可以获取：驾驶证（可以知道艾德里安在小镇内住址）、住宅钥匙（打开镇子中住宅的门）。",
      findMethods: [
        { type: "observation", description: "声明仔细检查路周围物品或者一个成功的侦查" },
        { type: "skill", skillName: "侦查", difficulty: "regular", description: "成功的侦查在路边垃圾堆旁发现" },
      ],
      revelation: "发现艾德里安的钱包，内含驾驶证和住宅钥匙。",
      unlocks: [],
      found: false,
      importance: "core",
    },
  ];
  scenes.push({
    id: "交火现场",
    name: "交火现场",
    description: S.SHOOTOUT + "\n\n这里的取证工作似乎已经完成，路边堆着一些遗弃的杂物。",
    clues: shootoutClues,
    npcIds: [],
    connections: [
      { targetSceneId: "普瑞米尔", condition: "返回镇上" },
      { targetSceneId: "艾德里安在镇子内的住宅", condition: "前往镇内住宅" },
    ],
  });

  // 9. 艾德里安在镇子内的住宅
  const townHouseClues: Clue[] = [
    {
      id: "clue_townhouse_photo",
      name: "艾米丽的照片",
      description: "在二层杂物室书桌上可以看到一幅照片，上面是一个女人坐在楼下的沙发上，正在抚摸已经涨大的腹部，似乎是一位孕妇。从相框拿出照片翻到后面可以看到「艾米丽·埃斯特鲁姆 1920」的字样。",
      findMethods: [
        { type: "observation", description: "搜查二层杂物室" },
      ],
      revelation: "发现艾米丽·埃斯特鲁姆1920年的孕妇照。",
      unlocks: [],
      found: false,
      importance: "core",
    },
    {
      id: "clue_townhouse_gold",
      name: "金锭挂饰",
      description: "在婴儿车中可以找到一块小金锭，做成了挂饰的样子，上面刻着「爱莉·埃斯特鲁姆 1921」的字样。金锭是20g纯金。",
      findMethods: [
        { type: "observation", description: "检查杂物室中的婴儿车" },
      ],
      revelation: '发现刻有「爱莉·埃斯特鲁姆 1921」的20g纯金锭挂饰。',
      unlocks: [],
      found: false,
      importance: "bonus",
    },
    {
      id: "clue_townhouse_transfer",
      name: "农场转购协议",
      description: "一份有些年份的文书，上面记录了一项购买，购买者是艾德里安，似乎是想要用这里作为度假与养老的去处，而且收购时价格很便宜。详细查看可以知道，这份协议是非法的，属于私下购买，没有在有关部门登记。（这也是为什么警察没有搜查农场的原因。）",
      findMethods: [
        { type: "observation", description: "搜查二层杂物室抽屉" },
      ],
      revelation: "发现艾德里安非法购买农场的转购协议（因此警察未搜查农场）。",
      unlocks: [],
      found: false,
      importance: "core",
    },
  ];
  scenes.push({
    id: "艾德里安在镇子内的住宅",
    name: "艾德里安在镇子内的住宅",
    // "至少3名（保证数量大于调查员）"是布场指示，不是玩家进门看得见的东西 —— 挪进 atmosphere
    description: S.ADRIAN_TOWN_HOUSE + "\n\n房子里本来的物品已经被流浪汉糟蹋了。",
    clues: townHouseClues,
    npcIds: ["tramp"],
    connections: [
      { targetSceneId: "交火现场", condition: "前往交火现场" },
      { targetSceneId: "普瑞米尔", condition: "返回镇上" },
      { targetSceneId: "艾德里安的农场", condition: "前往艾德里安的农场" },
    ],
    atmosphere: "进入时会被至少3名流浪汉发现（保证数量大于调查员）。流浪汉会驱赶调查员，只认钱不接受除恐吓外的社交技能。击晕/击杀一名后其余会一哄而散。使用枪械击杀流浪汉会被警察责问。",
  });

  // 10. 艾德里安的农场（入口）
  scenes.push({
    id: "艾德里安的农场",
    name: "艾德里安的农场",
    description: S.FARM,
    clues: [],
    npcIds: [],
    connections: [
      { targetSceneId: "农场外围", condition: "进入农场外围（陷阱区）" },
    ],
    atmosphere: "这栋别墅似乎已经很久没人打理了。",
  });

  // 11. 农场外围（陷阱区）
  scenes.push({
    id: "农场外围",
    name: "农场外围（陷阱区）",
    description: `农场外围布满了各种陷阱，艾德里安显然不想让任何人轻易靠近。夜色中更是不易分辨脚下。这片区域需要多加小心才能安全通过。`,
    // 陷阱没有独立的线索 ID，但引擎需要检测陷阱区域是否已被"处理"
    // 使用 clue_trap_detected 作为标记
    clues: [{ id: "clue_trap_detected", name: "陷阱区已通过", description: "调查员通过了农场外围的陷阱区。", findMethods: [{ type: "observation", description: "小心前进并成功避开陷阱" }], revelation: "成功通过陷阱区。", unlocks: [], found: false, importance: "core" }],
    npcIds: [],
    connections: [
      { targetSceneId: "艾德里安的农场", condition: "返回农场入口" },
      { targetSceneId: "农场主别墅", condition: "前往农场主别墅" },
      { targetSceneId: "谷仓形建筑", condition: "前往谷仓形建筑" },
    ],
    atmosphere: "夜晚则为惩罚骰。如果调查员中有军人或者有服役经历，可以进行灵感让他们觉得这里很危险。",
  });

  // 12. 农场主别墅
  scenes.push({
    id: "农场主别墅",
    name: "农场主别墅",
    // description 是念给玩家听的，atmosphere 才是给 KP 的。
    // 这里原先把"他在门口放置了一个致命的硫酸陷阱"拼进了 description，
    // 玩家一进场就被告知门口有致命陷阱 —— 陷阱当场作废。
    // 该信息 atmosphere 里本来就完整写着（含伤害与急救方式），删掉即可，不丢任何东西。
    description: S.FARM_VILLA,
    clues: [],
    npcIds: [],
    connections: [
      { targetSceneId: "农场外围", condition: "返回农场外围" },
    ],
    atmosphere: "门是锁着的。暴力踢门会触发硫酸陷阱（从门上倒下一瓶硫酸，1D4+1初始伤害，未摆脱则1D3/回合持续）。使用锁匠慢慢推门则硫酸瓶只会掉在地上。可用清水急救。",
  });

  // 13. 谷仓形建筑
  scenes.push({
    id: "谷仓形建筑",
    name: "谷仓形建筑",
    // 玩家看得见的是门和杂物堆本身；开锁难度、门的耐久属于 KP 侧，挪进 atmosphere。
    description: S.BARN + "\n\n侧面有一扇防盗门，锁着。门旁堆着一摞杂物，顺着大概能够到屋顶，顶上有扇玻璃窗。",
    clues: [],
    npcIds: [],
    connections: [
      { targetSceneId: "农场外围", condition: "返回农场外围" },
      { targetSceneId: "建筑内", condition: "进入谷仓内部" },
    ],
    atmosphere: "侧面防盗门：用找到的钥匙打开，或困难成功锁匠／极难成功力量／对门造成25点伤害。一旁的杂物堆：通过成功攀爬或协力举高可上屋顶，从顶部玻璃窗进入。",
  });

  // 14. 建筑内（谷仓内部）
  const interiorClues: Clue[] = [
    {
      id: "clue_barn_body",
      name: "门口的受害者尸体",
      description: "一名自己在尝试自救的受害者，肌肉比较发达。面朝下爬行到门口，地上拖着长长的血迹。气管被锐器切开了。通过成功的医学可以判断受害者是因为血液进入气管窒息而死。Sc0/1d3",
      findMethods: [
        { type: "observation", description: "观察门口的尸体" },
        { type: "skill", skillName: "医学", difficulty: "regular", description: "成功的医学判断死因" },
      ],
      revelation: "受害者因气管被切开，血液进入气管窒息而死。Sc0/1d3",
      unlocks: [],
      found: false,
      importance: "core",
    },
    {
      id: "clue_barn_victims",
      name: "其他受害者床位",
      description: '左右各有4张比较大的床铺，其中6张床铺上躺着受害者。这些受害者大多数都已经昏迷，触碰也没有反应。通过成功的医学可判断他们还活着。一个成功的力量可以掰开仪器【救出】受害者，但在打开的瞬间可以看到受害者的气管被切开了，需要紧急医疗设备——需要一个极难的急救才可以救下。',
      findMethods: [
        { type: "observation", description: "检查周围的床铺" },
        { type: "skill", skillName: "力量", difficulty: "regular", description: "成功的力量掰开仪器" },
        { type: "skill", skillName: "急救", difficulty: "extreme", description: "极难的急救才能救下受害者" },
      ],
      revelation: "发现受害者还活着但气管被切开，需要极难的急救才能救下。",
      unlocks: [],
      found: false,
      importance: "core",
    },
  ];
  scenes.push({
    id: "建筑内",
    name: "建筑内（谷仓大厅）",
    description: S.BARN_INTERIOR + "\n\n前往通道可以看到通向两个房间，其中一间的门打开着有一些亮光照出来。左侧关着门的为艾德里安的卧室，右侧有亮光的为中控室。",
    clues: interiorClues,
    npcIds: ["gabi_tricam"],
    connections: [
      { targetSceneId: "谷仓形建筑", condition: "返回谷仓入口" },
      { targetSceneId: "中控室", condition: "前往中控室（右侧有亮光）" },
      { targetSceneId: "艾德里安的卧室", condition: "前往艾德里安的卧室（左侧关着门）" },
    ],
  });

  // 15. 中控室
  const controlClues: Clue[] = [
    {
      id: "clue_control_supplies",
      name: "冰箱与储物柜",
      description: "储物柜没有上锁，里面有十几瓶备用的氧气罐。冰箱里则是一些袋装流食，都是备用品，没有任何商标与注明，看起来都是非法生产品。",
      findMethods: [{ type: "observation", description: "检查冰箱与储物柜" }],
      revelation: "找到备用氧气罐和袋装流食。",
      unlocks: [],
      found: false,
      importance: "core",
    },
    {
      id: "clue_control_lever",
      name: "中控台拉杆",
      description: "在中控台上有一个非常显眼的拉杆，现在是打开的状态，上面可以简单地看到ON/OFF。如果关闭拉杆，所有的受害者都会被解放，不需要力量也能救出他们。但是如果拉下开关，所有受害者都会因为气管被割开，短时间内全部窒息死亡。SC1d3+1/1d6+1",
      findMethods: [{ type: "observation", description: "观察中控台的拉杆" }],
      revelation: "拉杆ON/OFF控制所有受害者的生命维持系统。拉下即杀死所有人（SC1d3+1/1d6+1）。",
      unlocks: [],
      found: false,
      importance: "core",
    },
  ];
  scenes.push({
    id: "中控室",
    name: "中控室",
    description: S.CONTROL_ROOM,
    clues: controlClues,
    npcIds: [],
    connections: [
      { targetSceneId: "建筑内", condition: "返回谷仓大厅" },
    ],
    atmosphere: "这里都是艾米丽作为电子学教授所创新的设备，主要功能为检测受害者状态、定时分配氧气与流食、检查受害者身体素质。调查员不可能会使用这种电子设备。",
    // 剧情状态变量（DESIGN-LOG §2 示范）：中控台拉杆处于 ON —— 受害者靠生命维持系统存活。
    // 引擎维护的硬事实，LLM 旁白只读取：知道受害者活着，不得编造"已死亡/已解放"。
    stateVars: { lifeSupport: "ON" },
  });

  // 16. 艾德里安的卧室
  const bedroomClues: Clue[] = [
    {
      id: "clue_bedroom_gun",
      name: "枪械柜",
      description: "三只手枪，一只冲锋枪一只步枪与一杆霰弹枪，枪械非常整洁的摆放着，子弹也放在柜子稍微高些的台子上。枪械的枪身铭文都已经被抹除，但是可以看到这些武器最近才维护过。",
      findMethods: [{ type: "observation", description: "检查枪械柜" }],
      revelation: "发现大量武器（手枪、冲锋枪、步枪、霰弹枪）及弹药。",
      unlocks: [],
      found: false,
      importance: "bonus",
    },
    {
      id: "clue_bedroom_diary",
      name: "日记本与老旧文件",
      description: "在床头柜的日记本中夹杂着一份老旧的文件与一把上锈的钥匙。钥匙可以用来打开下水道中的维修间门。日记本中都是一些对文件的翻译，似乎是一些音译。需要过一个困难的母语，才可以对照日记本观看文件。",
      findMethods: [
        { type: "observation", description: "侦查或挪开床头柜" },
        { type: "skill", skillName: "母语", difficulty: "hard", description: "困难的母语来对照日记本观看文件" },
      ],
      // 开发·卧室线索修复 任务②c：这句原文是"打开下水道维修室门"——与场景
      // 表里的正式场景名"维修间"不一致（那个词本身是引擎自己教出去的，见
      // resolveSceneTarget 新增的别名分支）。统一成"维修间"，别名"维修室"
      // 仍然保留在场景解析里当兜底，两边都认。不改 MAINTENANCE_ROOM 那段
      // 房间描述本身（那是原文叙述房间里挂着的生锈铁牌写着"维修室"，是
      // 场景细节，不是场景名，本阶段不动 PDF 内容判断）。
      revelation: "发现日记本、老旧文件（与Mi-Go联络术相关）、生锈钥匙（打开下水道维修间门）。",
      unlocks: ["clue_bedroom_old_doc"],
      found: false,
      importance: "core",
      // 剧情状态联动（DESIGN-LOG §2 示范）：找到生锈钥匙 → 卧室剧情状态写入"钥匙已到手"。
      // 下游旁白可据此承接（下水道维修间门可开），不会误写"钥匙已丢失/尚未找到"。
      setStateVar: { key: "sewerKeyFound", value: true },
    },
    {
      id: "clue_bedroom_old_doc",
      name: "老旧文件（米-戈联络术）",
      description: `这份文件是艾德里安偶然在一战残骸中获得的。通篇为法语所写，上面记载了一些被生化战逼疯了的疯子所写的痴语。但是这些疯子因为幻境写下了Mi-Go的联络术，才导致这次悲剧的发生。
原文为法语，如果有法国人/法语点数超过50，可以直接观看本文。
"那些该死的德国人已经再也不能伤害我们了！我们已经有了那些伟大■■的保护..."
阅读这段文字会导致sc1/1d3+1。通过这些文案仔细研究2周，可以学会"米-戈联络术"并且CM+3。`,
      findMethods: [{ type: "observation", description: "从日记本中取出老旧文件" }],
      revelation: "发现Mi-Go联络术（sc1/1d3+1，研究2周可学会，CM+3）。",
      unlocks: [],
      found: false,
      importance: "core",
    },
  ];
  scenes.push({
    id: "艾德里安的卧室",
    name: "艾德里安的卧室",
    // "通往下一个场景"是写给 KP 的话，"场景"这个词玩家不该听见
    description: S.ADRIAN_BEDROOM + "\n\n床头柜压着一扇拉门，挪开后拉开它，下面是一道向下的绳梯。",
    clues: bedroomClues,
    npcIds: [],
    connections: [
      { targetSceneId: "建筑内", condition: "返回谷仓大厅" },
      { targetSceneId: "下水道", condition: "前往下水道" },
    ],
  });

  // 17. 下水道
  const sewerClues: Clue[] = [
    {
      id: "clue_sewer_bodies",
      name: "下水道尸体",
      description: "下水道拐角后面丢放着那3位遇害的被害者的尸体。观察尸体的话，除了气管的伤口，在大脑上还有一段环切，这些环切做的非常干净，连头骨都被一分为二，尸体的大脑都消失不见了。即使不会医学的人也能明白，这是现在人类做不到的事情。Sc1/1d3",
      findMethods: [{ type: "observation", description: "观察下水道拐角后的尸体" }],
      revelation: "发现尸体大脑被精密环切取走——非人类所能做到。Sc1/1d3",
      unlocks: [],
      found: false,
      importance: "core",
    },
  ];
  scenes.push({
    id: "下水道",
    name: "下水道",
    description: S.SEWER + "\n\n在转过拐角约5-6分钟后，可以隐约听到婴儿的啼哭声和一个甜美的哄婴儿声音。",
    clues: sewerClues,
    npcIds: ["ghoul"],
    connections: [
      { targetSceneId: "艾德里安的卧室", condition: "从绳梯向上返回卧室" },
      { targetSceneId: "维修间", condition: "使用生锈钥匙打开下水道深处的维修间门" },
    ],
    atmosphere: "下水道中弥漫着腐烂与死亡的气息。",
  });

  // 18. 维修间（终局场景）
  const maintenanceClues: Clue[] = [
    {
      id: "clue_final_workbench",
      name: "手工桌",
      description: "上面放着一些制作缸中脑设备的材料。艾德里安在这里制作缸中脑的罐子，这样的制作已经进行了3次。",
      findMethods: [{ type: "observation", description: "观察房间内" }],
      revelation: "艾德里安在这里制作了缸中脑容器。",
      unlocks: [],
      found: false,
      importance: "bonus",
    },
    {
      id: "clue_final_brain_jars",
      name: "母女的缸中脑",
      description: "那婴儿与那位女性正是一大一小两个缸中脑，正静静地漂浮在缸中。Sc1/1d6。艾米丽被艾德里安欺骗了，她以为自己仅仅是失去了视觉与触觉，通过流食活着的状态。她接受了自己的命运，毕竟至少自己还能听到孩子的声音。",
      findMethods: [{ type: "observation", description: "打开光源观察房间" }],
      revelation: "发现艾米丽和爱莉的缸中脑（Sc1/1d6）。艾米丽以为自己只是失去了视觉触觉。",
      unlocks: [],
      found: false,
      importance: "core",
      // 开发·真相链路 任务①（迁移自 game-session.ts 曾经的
      // BARN_CLUE_MATCH_ALIASES，本轮改为数据层，不再是引擎侧的硬编码
      // 特例表）：True End 第3行、near_truth 第1行、ENCOUNTER_NARRATIONS
      // 三处反复用「培养缸」/「一大一小」称呼这两个缸中脑，「营养液」在
      // True End/这条线索自己的 description/mythos-module.ts 艾米丽
      // secrets 里都用来描述生存介质。只登记这几个已核实在叙事里真的
      // 出现过的词，不做成通用机制批量扩别名——同一份克制。「设备」/
      // 「容器」这类过泛的词不收：它们不是这两个缸中脑专属的称呼，收进来
      // 会在场景内其它线索（clue_final_workbench/pipe/coffin）身上制造
      // 新的歧义，不是修复。
      matchTexts: ["培养缸", "玻璃缸", "一大一小", "营养液"],
    },
    {
      id: "clue_final_pipe",
      name: "奇怪管道与青色按钮",
      description: "一个很大的管道从天花板通了下来。在管道之前有一些红色的痕迹（干涸的人类鲜血），旁边的墙上还有一个青色按钮。按下的话米戈会现身。",
      findMethods: [{ type: "observation", description: "探索维修间深处" }],
      revelation: "发现米戈出现的管道和呼叫按钮。",
      unlocks: [],
      found: false,
      importance: "core",
    },
    {
      id: "clue_final_coffin",
      name: "艾米丽与爱莉的棺材",
      description: "一副散发着阴冷气息的长方形物体，像电冰箱的样子，外边布置着线缆，连接着一个发电机，封边上有些黏液。是进行完环切手术后的艾米丽与爱莉的身体，棺材采用防水与隔温的特殊材料与米戈的略微改进。发电机已经没有燃料了，冰块开始融化。Mi-Go如果使用僵尸制造术，艾米丽被选为目标的话会耗费1轮从棺材中起身。婴儿永远不会被选为目标。",
      findMethods: [{ type: "observation", description: "探索维修间角落" }],
      revelation: "发现艾米丽与爱莉被保存的遗体（环切手术后）。发电机已无燃料。",
      unlocks: [],
      found: false,
      importance: "core",
    },
  ];
  scenes.push({
    id: "维修间",
    name: "维修间（终局场景）",
    // 原先混进了两样玩家不该听到的东西："这里是一处比较大的场景"（"场景"是游戏术语），
    // 以及"艾米丽会以为艾德里安回来了"——那是她的心理活动，要由她开口时自己泄露。
    description: S.MAINTENANCE_ROOM + "\n\n这地方相当大，一开始很暗。等光照进去，才看清那婴儿与那位女性其实是一大一小两个缸中脑。往里走，原本堆放维修建材的地方已被清空，一根粗大的管道从天花板垂下；管道前有干涸的红色痕迹，墙上还有一个青色按钮。",
    clues: maintenanceClues,
    npcIds: ["emily_estrum", "ailey_estrum", "mi_go"],
    connections: [
      { targetSceneId: "下水道", condition: "返回下水道" },
      { targetSceneId: "下水道", condition: "通过奇怪管道（下水道深处）" },
    ],
    atmosphere: `艾米丽的缸中脑就安置在这里。她的意识仍然清醒，只是身体早已不在了。`,
  });

  return scenes;
}

// ─── NPC 构建 ──────────────────────────────────────────────
function buildNpcs(): ModuleNPC[] {
  return [
    // ========== 主要NPC（原始模块提供完整数据） ==========
    {
      id: "adrian_estrum",
      name: "艾德里安·埃斯特鲁姆",
      role: "生物学教授",
      age: 34,
      sceneId: "与艾德里安的会面",
      description: `34岁。生物学教授，曾经参过军，拥有一定的军事素养并且在生物学学术圈颇有威名。
在一战时的古老遗迹中发现了疯子笔记中记载的Mi-Go联络术。在妻子难产濒死的打击下病急乱投医，持枪将妻女从医院抢出带到农场，召唤了Mi-Go。
被Mi-Go欺骗将妻女变成缸中脑，并开始绑架他人为Mi-Go提供大脑。已绑架/诱拐10名受害人，在第11次行动时被警方发现交火，弹片击中头部瘫痪。
目前于霍姆斯医院接受治疗，处于意识不清状态。`,
      personality: {
        traits: ["绝望的丈夫", "曾经有原则的学者", "病急乱投医"],
        speech: "喃喃出自己妻子与女儿的名字，偶尔还会说出一些带有保护意味的词汇。恢复神智后极具攻击性，冷静后会认罪并请求帮助他的妻女。",
        attitude: "（正常状态）无意识喃喃 |（恢复神智后）攻击性→冷静认罪→恳求帮助",
      },
      knowledge: [
        "失踪案件都是自己所做",
        "妻女在农场的藏匿点",
        "Mi-Go联络术的召唤方法",
      ],
      secrets: [
        "被Mi-Go欺骗了——Mi-Go并不打算真正救治他的妻女，只是利用他获取人类大脑",
        "已经绑架/诱拐了10人，其中3人已遇害",
      ],
    },
    {
      id: "emily_estrum",
      name: "艾米丽·埃斯特鲁姆",
      role: "电子学教授/缸中脑",
      age: 32,
      sceneId: "维修间",
      description: `32岁。有着优异的电子学造诣。在一年前生育时因实习护士的疏忽导致推床失控、流产大出血，面临生命危险。
被丈夫用Mi-Go联络术变成了缸中脑，存放在下水道维修处的营养缸中。被艾德里安欺骗，以为自己仅仅是失去了视觉与触觉，通过流食活着的状态。
心地善良且聪慧，接受了自己的命运，毕竟至少还能听到孩子的声音。`,
      personality: {
        traits: ["聪慧", "善良", "母亲"],
        speech: "声音甜美，温柔地哄着婴儿。意识清醒但无法动弹，会以为调查员是艾德里安回来了。",
        attitude: "以为艾德里安回来了→要求调查员去照看孩子→（得知真相后）拒绝承认→可能陷入疯狂",
      },
      knowledge: [
        "自己失去了视觉与触觉，只能听到声音",
        "自己的孩子（爱莉）也在旁边",
        "帮助艾德里安设计了受害者监测设备",
      ],
      secrets: [
        "她的真实状态是缸中脑——大脑被浸泡在营养液中",
        "艾德里安欺骗了她关于真实情况",
      ],
    },
    {
      id: "ailey_estrum",
      name: "爱莉·埃斯特鲁姆",
      role: "婴儿/缸中脑",
      age: 1,
      sceneId: "维修间",
      description: `1岁。艾德里安与艾米丽的女儿。因难产濒死后被父亲用Mi-Go联络术变成了缸中脑，
与母亲一起存放在下水道维修处的营养缸中。时常发出婴儿的啼哭声。`,
      personality: {
        traits: ["婴儿心智"],
        speech: "脑波传出婴儿的啼哭声，无法言语交流。",
        attitude: "无意识的婴儿行为",
      },
      knowledge: [],
      secrets: [],
    },
    {
      id: "phoebe_tricam",
      name: "菲碧·特里坎",
      role: "银行职员",
      age: 42,
      sceneId: "特里坎家",
      description: `开门的是一位四十岁上下的女性，穿着得体的职业套装，头发一丝不苟地拢在脑后。她的眼眶微红，指间夹着一支燃到一半的香烟——显然已经焦虑了很长时间。`,
      personality: {
        traits: ["事业型", "母亲", "焦虑"],
        speech: "对儿子的失踪焦虑不安，表达对警察的不信任感。说话直接了当，有事业女性的作风。",
        attitude: "焦虑但克制→急切寻求帮助→愿意支付高额委托金",
      },
      knowledge: [
        "加比比较叛逆，喜欢出去玩，十五岁就搬到外面拖车住了",
        "我已经半个多月没有他的消息了……",
        "镇上警察？他们不会管的。",
        "我这里有加比最近的照片——他染了头发，穿着打扮和镇上其他孩子不太一样",
      ],
      secrets: [
        "平时没有看报纸的习惯，一直在等待警方电话，不知道关于绑架犯的线索",
      ],
    },
    {
      id: "gabi_tricam",
      name: "加比·特里坎",
      role: "无业游民",
      age: 17,
      sceneId: "建筑内",
      description: `17岁。典型的放肆子弟，父亲留下大量遗产让他成为了一名挥霍无度且没有智慧的人。
被艾德里安钓走并绑架，成为受害者之一，在谷仓的受害者中。`,
      personality: {
        traits: ["叛逆", "挥霍无度"],
        speech: "（作为受害者已昏迷，无法对话）",
        attitude: "昏迷中",
      },
      knowledge: [],
      secrets: [],
    },
    {
      id: "mir_tricam",
      name: "米尔·特里坎",
      role: "儿童（5岁）",
      age: 5,
      sceneId: "特里坎家",
      description: `5岁。特里坎家的小女儿。在调查员来的时候会在房屋外的篮球场玩球，
看到调查员时会跑回屋内寻找母亲。`,
      entrance: `米尔·特里坎从屋里探出半个身子，睁大眼睛怯生生地望着你们。`,
      personality: {
        traits: ["天真", "幼小"],
        speech: "儿童语气，话比较天真。",
        attitude: "玩耍→见到生人跑回屋内",
      },
      knowledge: [
        "我最后一次见到加比，是在半个月前的晚上",
        "我看到哥哥那天晚上穿得比平时严实得多，还提着一个黑袋子，很急匆匆地从车房里出来，顺着路走了",
      ],
      secrets: [],
    },

    // ========== 敌对NPC（原始模块提供统计资料） ==========
    {
      id: "tramp",
      name: "流浪汉",
      role: "流浪汉",
      sceneId: "艾德里安在镇子内的住宅",
      description: `HP12 Dex50 斗殴45 闪避55 武器：小型棍棒 1d6+DB
在艾德里安镇子内的住宅中占据，至少有3名（数量大于调查员）。
如果调查员进入会被流浪汉发现，会尝试赶走调查员。只认得钱，不接受除恐吓外的社交技能。
击晕/击杀一名后其余一哄而散。使用枪械击杀会被警察责问。`,
      personality: {
        traits: ["暴力倾向", "贪财"],
        speech: "粗鲁，只认钱。",
        attitude: "驱赶→（给钱）放行→（战斗）攻击→（同伴被击倒）逃散",
      },
      knowledge: [
        "这房子是那个被抓的教授名下的，已经空了很久",
        "屋里有些值钱的东西——孕妇照片、纯金挂饰",
        "艾德里安在城外偷偷买下了一处农场",
      ],
      secrets: [],
    },
    {
      id: "police",
      name: "警员",
      role: "警员",
      sceneId: "警察局",
      description: `HP12 Dex60 斗殴40 手枪55 闪避50
武器：.38左轮手枪1d10/警棍1d6+DB
小镇警局的普通警员。参与了艾德里安的交火事件。
在调查员无警方相关角色时爱答不理。如果有警方角色的调查员可通过社交技能获取信息。`,
      personality: {
        traits: ["公事公办"],
        speech: "官方，公事公办的口吻。",
        attitude: "（无警方角色）爱答不理→（有警方角色）配合但有限",
      },
      knowledge: [
        "镇上最近有多起失踪案",
        "绑架犯艾德里安·埃斯特鲁姆被捕，在医院接受治疗",
        "证物室锁着艾德里安的随身物品",
      ],
      secrets: [
        "警力都被调去处理疯子教授的案子，失踪案没人手查",
      ],
    },
    {
      id: "bar_bouncer",
      name: "酒吧保镖",
      role: "酒吧保镖",
      sceneId: "维森酒吧",
      description: `HP14 Dex55 DB+1d4 斗殴65 霰弹40 闪避50
武器：指虎1d4+db / 12号霰弹枪4d6/1d6
维森酒吧的保安。`,
      personality: {
        traits: ["强硬"],
        speech: "话不多，态度强硬粗鲁。",
        attitude: "维持秩序→（有人闹事）动手",
      },
      // 开发·在场实体与线索路径 N7（todo-41）：原文明说「大多数的保安、
      // 客人都会选择不回答或者不知道」——真正知道包场情报的是前台，
      // 不是保安。这条 knowledge 此前直接写着包场的事实内容，与原文说
      // 「保安不回答/不知道」自相矛盾，也正是实跑里保镖编出「老板锁进
      // 抽屉」这类回答的诱因之一（模板/LLM 手上没有一句"我不知道"能用，
      // 只能自己现编）。改成如实反映"不知道/不回答"这件事本身，并把
      // 玩家导向真正的信息源。
      knowledge: [
        "不清楚客人的事，问了也白问——有事去问前台。",
      ],
      secrets: [],
    },
    {
      id: "bar_receptionist",
      name: "前台",
      role: "前台",
      sceneId: "维森酒吧",
      // 事实层（原文有）：前台是真正的情报源；知道①一位贵客包场办
      // 狂欢派对、来的人都要登记，②包场的贵客是艾德里安·埃斯特鲁姆；
      // 两条各自的代价是小费10$以上/成功的取悦，以及大量现金+至少
      // 困难成功的社交类技能。外貌/性格/说话方式原文没写，是叙事层，
      // 允许创作但不冒充"原文如此"。
      description: "维森酒吧的前台，负责登记与收银。",
      personality: {
        traits: ["圆滑", "认钱办事"],
        speech: "话说得滴水不漏，不见好处不肯多说。",
        attitude: "普通问题打太极→（给足小费/成功取悦）松口透露包场情报→（追问身份，需大量现金+社交检定）才说出对方名字",
      },
      // knowledge 只放"这里有事可打听、要给好处"这层暗示，不直接写出
      // 包场/身份的具体内容——那两件事原文明确要求代价（小费/取悦，或
      // 现金+困难社交）才能得知，真正的揭示走 clue 的 findMethods/
      // investigateCoC 技能检定（matchTexts 见 barClues 定义），不是
      // 靠随口聊天套出来；这里若直接写出内容，等于绕开了原文设定的门槛。
      knowledge: [
        "有些事情不是白问的——想打听清楚，得先意思意思，或者哄得我开心。",
      ],
      // secrets：LLM 不会主动说出口的内容，checkSecretLeak 兜底——
      // 即便自由聊天时被诱导，约束层也会拦。真正的"揭示"仍然只走线索
      // 检定这条路，secrets 只是防止闲聊路上被套话套漏。
      secrets: [
        "一位贵客包下了酒吧办狂欢派对，来的人都要登记",
        "包场的贵客是艾德里安·埃斯特鲁姆",
      ],
    },
    {
      id: "newsstand_owner",
      name: "报亭老板",
      role: "报亭老板",
      sceneId: "报亭",
      // 事实层（原文有，模组 PDF 报亭一节）：老板会主动提起最近抓了个
      // 绑架犯（问起人口失踪报道时）；旧报纸嫌麻烦拒绝翻找，但调查员
      // 提出购买的话会以市场价 3 倍价格出售——这条交易规则同时也写在
      // newsstand 场景的 atmosphere 字段里，两处数字要保持一致，不要
      // 各写一份。外貌/性格是叙事层，原文没写。
      description: "报亭老板，守着一堆报纸和旧报纸过日子。",
      personality: {
        traits: ["精明", "怕麻烦"],
        speech: "说话带着生意人的算计，懒得费事的地方绝不多花力气。",
        attitude: "闲聊报道→（问起旧报纸）嫌麻烦拒绝翻找→（提出购买）以市场价 3 倍出售",
      },
      knowledge: [
        "最近镇上又抓了个绑架犯，报纸上登过，具体细节没细看",
        "旧报纸都堆着等废纸场来收，谁要翻旧报道嫌麻烦，不如买去自己找",
      ],
      secrets: [],
    },
    {
      id: "hospital_staff",
      name: "医护人员",
      role: "医护人员",
      sceneId: "霍姆斯医院",
      // 事实层（原文有，模组 PDF 医院一节）：多数医护人员会回避这个
      // 话题（原文"这件事对于医院来说属于污名，不会愿意轻易透露"）；
      // 真正知情的那位需要先幸运判定才能遇到，再用信誉或社交检定让
      // 对方开口——两道检定都落在 clue_emily_birth 的 findMethods 里，
      // 这里只放"这事不好说"的暗示，真正的内容（艾米丽难产事故的真相）
      // 走线索检定这条路，不靠闲聊套出来，同 weisen_bar 前台的处理
      // 方式。外貌/性格是叙事层，原文没写。
      description: "霍姆斯医院的医护人员，行色匆匆。",
      personality: {
        traits: ["谨慎", "守口如瓶"],
        speech: "对陌生人的问询很警惕，除非确认对方值得信任才肯松口。",
        attitude: "多数情况选择回避→（幸运判定成功）遇到愿意开口的那位→（信誉或社交检定成功）在安静地方说出真相",
      },
      knowledge: [
        "有些事情属于医院的污名，不该随便跟外人说。",
      ],
      // secrets：真相内容（艾米丽难产事故）不直接写进 knowledge——
      // 原文明确要求两道检定才能得知，写进 knowledge 会绕开检定门槛，
      // checkSecretLeak 兜底防止闲聊时被套出来。
      secrets: [
        "艾德里安的妻子艾米丽一年前因难产事故大出血，是实习护士的疏忽用了没有修缮的推床，艾德里安持枪冲进抢救室把妻子抢走了，院方选择了沉默",
      ],
    },

    // ========== 神话生物（原始模块提供完整数据） ==========
    {
      id: "ghoul",
      name: "食尸鬼（可选）",
      role: "食尸鬼",
      sceneId: "下水道",
      description: `HP13 MP13 DB+1d4 体格+1
Str60 Con65 Siz65 Dex90 Int55 Pow65
每回合攻击3次。格斗40%（1d6+1d4，命中判幸运，失败破伤风）咬住40%（1d4，需力量挣脱）
闪避40% 攀爬80% 跳跃70% 聆听70% 潜行70% 侦查50%
护甲：枪械与抛射武器伤害减半（向下取整）
理智损失：0/1d6`,
      personality: {
        traits: ["食尸鬼"],
        speech: "无",
        attitude: "进食中→发现调查员后攻击",
      },
      knowledge: [],
      secrets: [],
    },
    {
      id: "mi_go",
      name: "Mi-Go（来自尤格斯的真菌）",
      role: "Mi-Go",
      sceneId: "维修间",
      description: `HP11 MP15 DB无 体格0
Str40 Con40 Siz70 Dex90 Int65 Pow85
每回合攻击2次。格斗45%（1d6伤害）闪避35%
护甲：无，但贯穿武器均造成最小伤害
理智损失：0/1d6
法术：僵尸创造术（Mi-Go修改版，6MP，2轮，理智不计）、纳克-提特障壁创建术（消耗不计，1轮）、帕祖祖之息（3MP，即时）
特殊能力：催眠术（40英尺范围内POW对抗否则失去行动能力）、传心术（每5回合1MP）
因为它与艾德里安的交易已经有3次，不会持有武器与装甲现身。
它会想要直接夺走艾米丽的缸中脑并且离开。不会与调查员死斗，HP低时会欺骗调查员。`,
      personality: {
        traits: ["高等外星生物", "理性", "欺骗性"],
        speech: "通过心灵感应传递概念，语气冰冷不带情感。对人类感到好奇但不屑。",
        attitude: "被发现→尝试夺走缸中脑→（HP低时）欺骗调查员→（得手后）离开",
      },
      knowledge: [
        "与艾德里安进行了交易",
        "人类大脑是它的目标",
      ],
      secrets: [
        "它欺骗了艾德里安，并不打算救治他的妻女",
        "它只是利用艾德里安获取人类大脑",
      ],
    },
  ];
}

// ─── 道具构建 ──────────────────────────────────────────────
// 数据源: src/module/structured/items.txt
function buildItems(): ModuleItem[] {
  return [
    {
      id: "key_anti_theft",
      name: "防盗门的钥匙",
      sceneId: "证物室",
      description: "用来打开艾德里安农场谷仓的门。在这个小镇里，这种先进防盗门可不多见。",
      type: "key",
    },
    {
      id: "photo_farm",
      name: "农场的照片",
      sceneId: "证物室",
      description: "可以对照着在小镇周围找到艾德里安的农场位置。",
      type: "document",
      // 开发·三方审计补语义 任务①：原文（section_06.txt:2-9）写的是一段
      // 调查活动——"可以对照着在小镇周围找到一致的农场……本地调查员也
      // 可以通过灵感知道小镇附近有类似的建筑。而后通过一个成功的导航
      // 找到农场。导航失败的情况，调查员可以寻求本地 NPC 的帮助"，没有
      // 任何地方写"照片背面"或"坐标"——旧版 revelation 不只是措辞
      // 对不上，是把"拿着照片比对、本地人灵感识别/外地人导航检定失败
      // 可求助 NPC"这一整条调查活动压缩成一句"直接给坐标"，删掉了原文
      // 明确写出的检定环节。安全性核对过：photo_farm 是 ModuleItem，不
      // 解锁任何 clue（ModuleItem 类型本身没有 unlocks 字段），农场位置
      // 另有 clue_adrian_psychoanalysis → clue_adrian_farm_location 这条
      // 路径可达，改这里不影响任何结局可达性——原文本来就写了两条通往
      // 农场的路，这里只是把被压掉的那条按原文恢复回来。
      revelation: "细看照片背景，能与小镇周围的地貌比对——本地调查员或许凭灵感就认出了相似地点，其他人需要通过一次成功的导航才能找到农场；导航失败时可以寻求本地 NPC 的帮助。",
    },
    {
      id: "wallet_adrian",
      name: "黑色钱包",
      sceneId: "证物室",
      description: "艾德里安的钱包，证物室物品。",
      type: "loot",
    },
    {
      id: "drivers_license",
      name: "驾驶证",
      sceneId: "证物室",
      description: "可以知道艾德里安在小镇内的住宅地址。",
      type: "document",
    },
    {
      id: "key_house",
      name: "住宅钥匙",
      sceneId: "交火现场",
      description: "在交火现场附近的垃圾堆发现的钥匙，可打开艾德里安在镇子内的住宅门。",
      type: "key",
    },
    {
      id: "old_document",
      name: "老旧文件",
      sceneId: "艾德里安的卧室",
      description: "这份文件是艾德里安偶然在一战遗迹中发现的前线疯子的笔记，上面记载着这些疯子所认为的米戈联络术。这些疯子相信米戈能帮助他们脱离肉体的桎梏，不再接受任何肉体的磨难。",
      type: "document",
      revelation: "通篇为法语所写。阅读导致 sc1/1d3+1，研究2周可学会「米-戈联络术」且 CM+3。",
    },
    {
      id: "trap_bear",
      name: "捕兽夹",
      sceneId: "农场外围",
      description: "体形小于35的角色会免疫。踩中时造成1D4+1伤害，挣脱需困难成功力量。大失败或乱动造成额外1d3伤害。伤害大于耐久半值有截肢风险。",
      type: "trap",
      trap: {
        damage: "1D4+1",
        // 事先发现：侦查检定，夜晚惩罚骰；有军事背景可用灵感
        detect: {
          skill: "侦查",
          difficulty: "regular",
          nightPenaltyDice: 1,
          alternativeSkill: "灵感",
          alternativeBackground: "军事",
        },
        escape: { skill: "力量", difficulty: "hard", fumbleDamage: "1d3" },
        sizImmunityBelow: 35,
        maimAtHpRatio: 0.5,
        detectedByClue: "clue_trap_detected",
        // 模组只说"体形小于35免疫"，没给理由。踏板式捕兽夹靠体重压到底才击发，
        // 所以按"分量不够压不动弹簧"写——这是推断，不是原文，故记入 inferred。
        immuneNarration: "脚下咔的一声轻响，随即没了动静——分量不够，弹簧没被压到底。",
        inferred: ["immuneNarration"],
      },
    },
    {
      id: "trap_shotgun",
      name: "锯短霰弹枪拌锁陷阱",
      sceneId: "农场外围",
      description: "踩到的调查员有困难敏捷机会躲避，造成1d6伤害。无备弹且枪管被锯断，无法作为调查员武器再利用。",
      type: "trap",
      trap: {
        damage: "1d6",
        detect: {
          skill: "侦查",
          difficulty: "regular",
          nightPenaltyDice: 1,
          alternativeSkill: "灵感",
          alternativeBackground: "军事",
        },
        avoid: { skill: "敏捷", difficulty: "hard" },
        detectedByClue: "clue_trap_detected",
      },
    },
    {
      id: "trap_sound",
      name: "音响陷阱",
      sceneId: "农场外围",
      description: "一个音响陷阱，原本为警报用途，现因无人维护已经失效。",
      type: "trap",
      // 无 trap 字段是刻意的，不是漏填：模组写明它已经失效。
      // 留着条目是因为它仍然看得见——调查员会发现一个坏掉的警报器，那本身是线索。
    },
    {
      id: "trap_sulfuric_acid",
      name: "硫酸陷阱",
      sceneId: "农场主别墅",
      description: "从门上倒下一瓶硫酸，1D4+1初始伤害，未摆脱则1D3/回合持续。使用清水可急救。",
      type: "trap",
      trap: {
        damage: "1D4+1",
        ongoing: { damage: "1D3", until: "冲洗掉残留的酸液" },
        firstAid: "清水冲洗",
      },
    },
  ];
}

// ─── 结局 ──────────────────────────────────────────────────
//
// ⚠ 仓库里同时存在三套结局表示，容易被误当成同一件事的三份拷贝——它们
// 不是，分工不同：
//
//   1. END_NARRATIONS（下方，EndNarration[]）—— **判定真相**。唯一声明式、
//      能被机器求值的一份（condition.requiredClues/excludeClues/
//      requiredScenes），evaluateEndNarration() 据它决定"这一局该给哪个
//      结局"，是 BARN_SUPPORT.evaluateEnding 实际调用的那份。
//   2. Ending[]（这个函数 buildEndings() 产出，挂在 ModuleData.endings
//      上）—— **展示/派生文本**，自由文本 conditions 只能给人读，不能被
//      引擎求值。当前没有渲染它的调用方（判定已经交给 END_NARRATIONS），
//      保留是因为 ModuleData.endings 是必填字段（摄取管线也要用），删掉
//      整个字段会牵连另一条不在本轮范围的流水线。id 集合必须与
//      END_NARRATIONS 一致——见 module-endings-consistency.test.ts，
//      那条判据就是防止这两份未来悄悄长出矛盾（比如判定端加了新结局，
//      这份忘了同步）的唯一保险。
//   3. MythosModule.endings（ModuleEnding[]，conditionText 自由文本，
//      定义见 src/rules/mythos-module.ts，实际数据在
//      src/rules/custom-modules/premiers_barn.ts）—— GameSession 自由跑团
//      路径（MythosModuleLoader）用的是这套**遗留**模组格式，同样只有
//      展示文本，不可求值。原先会被复制进 host.moduleEndings 这个 Map，
//      但那个 Map 从建出来就没有任何读者——GameSession 这条路径目前压根
//      没有"判定结局"这回事（属于另一轮的范围）。已经删掉那次复制，
//      不留一个谁都不读的注册表；conditionText 这份数据本身还在，真要用
//      时先接读者再决定要不要重新登记。
function buildEndings() {
  return [
    {
      id: "normal",
      name: "Normal End",
      description: "调查员没有知道事情的真相，简单的调查，简单地放弃，不会有任何惩罚，就当旅游了一圈吧。因为艾德里安已经被抓了，也不会有更多人失踪了。但是米戈的威胁仍在，吃到这次甜头的它，下次会选择什么更好的【伎俩】呢...",
      conditions: ["调查员没有查清真相就放弃了案件"],
    },
    {
      id: "good",
      name: "Good End",
      description: "调查员在发现了受害者们的时候就直接选择了报警，他们找到了失踪者，加比也被救下，只是艾德里安为什么这么做仍是个谜，艾米丽或许会一辈子在下水道照顾爱莉吧...",
      conditions: ["调查员发现受害者后直接报警", "加比被救下", "未发现下水道的缸中脑真相"],
    },
    {
      id: "bad",
      name: "Bad End",
      description: "调查员误拉拉杆杀死所有受害者。",
      conditions: ["调查员在中控室误拉拉杆导致所有受害者死亡"],
    },
    {
      id: "true",
      name: "True End",
      description: "调查员找到了事件的真相，报警解救了被害者，受到了小镇的感谢与委托金的报酬，虽然下水道的事情没有告诉其他人，不过，这个事情最好还是永远烂在自己的脑海中吧...",
      conditions: ["调查员发现下水道缸中脑与事件真相", "报警解救受害者", "保守下水道的秘密"],
      sanReward: "+d6（发现缸中脑与事件真相）+ 解救者数量*d3（解救受害者）",
      cmReward: 3,
    },
    // 开发·摄取管线校准 阶段3：与 END_NARRATIONS 新增的 near_truth 条目
    // 配套——id 集合必须与 END_NARRATIONS 一致，见
    // module-endings-consistency.test.ts。
    {
      id: "near_truth",
      name: "Near-Truth End",
      description: "调查员到达了终局场景，亲眼见到了漂浮在缸中的母女，却没能读懂床头柜里那份需要精通母语才能看懂的老旧文件——真相就在眼前，却没能拼出全貌。",
      conditions: ["调查员到过维修间并发现缸中脑", "未能解读日记本中的老旧文件"],
    },
  ];
}

// ─── 结局叙事数据（来源于原始模块，替代 play-module.ts 中的硬编码） ──
// 每条叙事包含条件判断和文本段，play-module.ts 读取此数据进行数据驱动结尾
// ─── 遭遇战叙事数据（替代 play-module.ts 中的硬编码战斗描述） ──
// 每条遭遇战数据包含触发条件和不同结果的叙事文本
// EndNarration / EncounterNarration 类型定义见 src/module/types.ts

export const END_NARRATIONS: EndNarration[] = [
  // ── True End: 识破整条骗局链，找到真相，救了受害者 ──
  //
  // 开发·摄取管线校准 阶段3：改前的文案把艾米丽写成了知情者（"但她知道，
  // 米—戈欺骗了他们所有人"），且用了两句方括号里的臆造台词——三方审计
  // （three-way-audit.ts）确认原文（section_12:12-18, :61-71）明确写着
  // 相反的事实：艾米丽被艾德里安骗了，以为自己只是失去了视觉与触觉，
  // 根本不知道自己是缸中脑；告诉她真相要至少 2 名调查员、要过 San 检定，
  // 且有很高风险让她陷入偏执/歇斯底里——她不是一个可以在结局里突然
  // "开口感谢"的知情者。
  //
  // 原文真正的结构是三重欺骗（section_01:15-18、section_12:12-18、
  // section_13:11-17）：
  //   米-戈骗了艾德里安 —— 谎称把妻女做成缸中脑才能续命，还要他找"合适的
  //     身体"、把取出的大脑当酬劳交给它，艾德里安至死不知自己被利用。
  //   艾德里安骗了艾米丽 —— 她以为自己只是失去了视觉与触觉，靠流食活着，
  //     心甘情愿接受"命运"，因为至少还能听见孩子的声音。
  //   米-戈还想骗调查员 —— 打斗落于下风时会许诺"帮忙医治"艾米丽母女，
  //     换取交出缸中脑，得手就跑，"正如它一开始对艾德里安做的一样"
  //     （section_13:11-17 原文原话）。
  // "识破整条骗局链"指的是看穿这三层，不是靠艾米丽开口告解。
  //
  // 条件：old_doc（读懂联络术的真面目——机制层面的真相）+
  // final_brain_jars（亲眼见到缸中脑、且其揭示文本已忠于原文写明"艾米丽
  // 以为自己只是失去视觉触觉"——处境层面的真相）。diary 不必再列——
  // 阶段1 的前置门已经保证 old_doc 不可能脱离 diary 被发现，写着是冗余。
  {
    id: "true",
    priority: 1,
    condition: {
      requiredClues: ["clue_bedroom_old_doc", "clue_final_brain_jars"],
      requiredScenes: ["维修间"],
    },
    sourceRef: "section_01:15-18; section_12:12-18,61-71; section_13:11-17",
    lines: [
      "真相已经明了——而且是一整条骗局链，一环套着一环。",
      "米—戈骗了艾德里安：它说唯一能救下妻女的办法，就是把她们的大脑做成缸中脑；还要他去找「合适的身体」，好把大脑重新装回去。而那些从受害者身上取出的大脑，其实是它索要的酬劳。艾德里安直到瘫痪在病床上，都没有意识到自己不过是被利用的工具。",
      "艾德里安又骗了艾米丽。她以为自己只是在那场事故里失去了视觉与触觉，靠着营养液活着——她不知道自己早已只剩一颗漂浮在缸中的大脑，更不知道女儿爱莉也是。她心甘情愿地接受了这个「命运」，因为至少，她还能听见孩子的声音。",
      "如果米—戈察觉自己就要空手而归，它多半还会试一次同样的说辞——只要交出艾米丽的缸中脑，它就「帮忙医治」她们母女。这与它当初骗艾德里安的话术如出一辙。",
      "要不要把真相告诉艾米丽，是留给你们自己的问题——那意味着让一位母亲亲手拆穿自己安身立命的谎言，没人知道那算不算真正的仁慈。",
    ],
  },
  // ── Good End: 救了受害者但未发现真相 ──
  //
  // ⚠ 这条的 priority（3）故意大于 Bad End 的 priority（2），而数组书写
  // 顺序上 Good End 却排在 Bad End 前面——留着这个"数组顺序与 priority
  // 不一致"的样子是故意的，用来证明求值器真的按 priority 排序求值，
  // 不是偷懒继续依赖数组位置（那正是这次要修的坑本身：以前数组顺序
  // 悄悄兼职当过优先级用）。拉下拉杆杀光所有受害者比拿到补给更有决定性，
  // 两个条件同时成立时 bad 该赢——旧 if 链本来就是这个判断顺序
  // （true→bad→good→normal）。32 态穷举抓出来的 10 个差异里，4 个就是
  // 这条顺序矛盾（如果当年求值器真按数组顺序求值，会在这些状态下误判
  // 成 Good End）。
  {
    id: "good",
    priority: 3,
    condition: {
      requiredClues: ["clue_control_supplies"],
      excludeClues: ["clue_bedroom_old_doc"],
    },
    lines: [
      "在那个地下室里，两个培养缸中的大脑仍在缓慢地浮动。她们是谁？为什么会在这里？这些问题可能永远没有答案了。",
    ],
  },
  // ── Bad End: 拉拉杆杀了所有人 ──
  //
  // ⚠ 已知：这个结局当前不可达。条件用的 bad_lever_pulled 全仓只在本文件
  // 内部出现三处（这里、下面的 excludeClues、旧 if 链留下的历史注释），
  // 没有任何代码路径会产生它——所有 world.discoverClue(...) 调用点都不传
  // 它，src/play/ 下也没有"拉杆"/"拉下拉杆"这个动作的实现。
  //
  // 不要改成指向 clue_control_lever："观察中控台的拉杆"（findMethods 是
  // observation）与"拉下拉杆"是两件事，改过去会变成看一眼拉杆就团灭全员，
  // 语义完全错了。实现拉杆动作不在这一轮的范围内。
  //
  // 这里选择的是"让不可达成为显式事实"：end-narration-clue-reachability
  // .test.ts 的判据会把 bad_lever_pulled 识别为"引用了但没有生产者"，
  // 并要求它出现在测试里显式声明的 KNOWN_UNREACHABLE 名单中——名单之外
  // 冒出的任何新的不可达 clue id 都会让那条判据变红。真给拉杆动作接上
  // 生产者的那天，这条注释、KNOWN_UNREACHABLE 名单要一起摘掉。
  {
    id: "bad",
    priority: 2,
    condition: {
      requiredClues: ["bad_lever_pulled"],
    },
    lines: [
      "一切都结束了。拉杆被拉下的那一刻，所有受害者的生命同时消逝。",
      "即使法律没有制裁你，你自己也不会轻易原谅草率行动的自己的吧……",
    ],
  },
  // ── Near-Truth End: 到过终局、见到了缸中脑，但没读懂日记里的老文件 ──
  //
  // 开发·摄取管线校准 阶段3：BARN_SUPPORT.endLabels 里早就登记了
  // near_truth 这个标签（"Near-Truth End"），但 END_NARRATIONS 里一直没有
  // 对应条目——这类玩家（走到了终局场景、亲眼见到了缸中脑，只是没能
  // 破解日记本里那份需要"困难的母语"才能看懂的文件）此前只会落到 Normal
  // End，被念一句"简单的调查之后，就这么放弃了"——这句话配不上一个做对
  // 了几乎所有事、只差最后一步的人。
  //
  // priority 排在 Good End（3）与 Normal End（原 4，本轮改到 5）之间：
  // 见到缸中脑但读不懂文件，比"报警但根本没走到终局"（Good End）更接近
  // 真相，但比"识破整条骗局链"（True End）差一步。excludeClues 里的
  // old_doc 单列出来不是必需的（priority 更高的 True End 会先赢），
  // 是为了让这条自己也读得出"这是给谁的"，跟 Good End 自己的 excludeClues
  // 是同一个写法理由。
  {
    id: "near_truth",
    priority: 4,
    condition: {
      requiredClues: ["clue_final_brain_jars"],
      requiredScenes: ["维修间"],
      excludeClues: ["clue_bedroom_old_doc"],
    },
    sourceRef: "section_11:14-18; section_12:19-21,39-57",
    lines: [
      "两个培养缸静静地漂浮在维修间里——一大一小，是艾米丽和爱莉。",
      "床头柜里那份老旧的文件仍然是一团谜。上面写满了某种听不懂的音译，需要精通母语的人才能读懂它到底记着什么。你们知道自己看到了什么，却说不出这一切究竟是怎么发生的。",
      "真相就在眼前，你们却与它擦肩而过。",
    ],
  },
  // ── Normal End: 兜底 ──
  //
  // ⚠ 这里曾经是 `excludeClues: [clue_control_supplies, clue_bedroom_old_doc,
  // bad_lever_pulled]`——字面意思是"三条线索一条都没找到才算 Normal
  // End"，但旧 if 链把它当**无条件兜底**（前三个分支都不中就落到这里，
  // 不再检查任何条件）。两套不同的理论：玩家找到了 clue_bedroom_old_doc
  // 但凑不齐 True End 的另外两个条件时，旧的 excludeClues 会让 Normal
  // End 也不匹配——32 态穷举里这类"哪个结局都对不上"的状态有 6 个，全部
  // 可达。游戏必须总能给出结局，这是功能要求，不是"数据恰好这样写"可以
  // 商量的——所以按 if 链的行为收敛：改数据，把 excludeClues 去掉，让
  // Normal End 成为真正的兜底（priority 最低，前面都不中才轮到它，属于
  // 它的语义就是"没有更具体的结局匹配时给这个"，不需要自己的排除条件）。
  //
  // priority 从 4 改成 5：开发·摄取管线校准 阶段3 插入了 near_truth
  // （priority 4），Normal End 仍然要保持"前面都不中才轮到它"的兜底
  // 位置，往后挪一位。
  {
    id: "normal",
    priority: 5,
    condition: {
      requiredClues: [],
    },
    lines: [
      "调查员未能查明真相——简单的调查之后，就这么放弃了。",
      "因为艾德里安已经被抓了，也不会有更多人失踪了。但是米戈的威胁仍在，吃到这次甜头的它，下次会选择什么更好的【伎俩】呢...",
    ],
  },
];

/**
 * 评估当前世界状态，返回匹配的结局叙事。
 *
 * 与 evaluateEpilogues() 同一套通用求值形状（都是 AND 语义的 requiredClues
 * /excludeClues/requiredScenes），差别只在于这里按 priority 排序后取
 * **第一条**命中的（结局互斥，只能有一个），evaluateEpilogues 收集**全部**
 * 命中的（后日谈可以叠加多条）。这里不再手写一遍 if 链——之前那份 if 链
 * 与 END_NARRATIONS[i].condition 各自表达了一套不同的判断，靠人工对齐
 * `return END_NARRATIONS[0]; // true` 这种下标注释维持一致，32 态穷举
 * 验出 10 态不一致（见 END_NARRATIONS 数据里 bad/normal 两条的注释）。
 */
function evaluateEndNarration(
  isClueFound: (id: string) => boolean,
  isSceneVisited: (id: string) => boolean,
): EndNarration | null {
  const sorted = [...END_NARRATIONS].sort((a, b) => a.priority - b.priority);
  for (const en of sorted) {
    const { requiredClues, excludeClues, requiredScenes } = en.condition;
    const hasReq = !requiredClues || requiredClues.length === 0 ||
      requiredClues.every(c => isClueFound(c));
    const hasExcl = !excludeClues || excludeClues.every(c => !isClueFound(c));
    const hasScenes = !requiredScenes || requiredScenes.length === 0 ||
      requiredScenes.every(s => isSceneVisited(s));
    if (hasReq && hasExcl && hasScenes) return en;
  }
  return null;
}

// ─── NPC 统计资料（来源于原始模块附录） ────────────────────
export const NPC_STATS: Record<string, Record<string, number | string>> = {
  adrian_estrum: {
    age: 34,
    hp: 14,
    str: 50, dex: 65, pow: 80, con: 70, app: 55, edu: 75, siz: 70, int: 80, san: 0,
    斗殴: 65, 手枪: 60, "步枪/霰弹枪": 60, 闪避: 60, 生物学: 75, 神秘学: 50, 克苏鲁: 20,
    侦查: 50, 聆听: 50, 图书馆: 80, 法语: 40,
  },
  emily_estrum: {
    age: 32,
    hp: 4, "brain_hp": 2,
    str: "?", dex: "?", pow: 60, con: 15, app: "?", edu: 82, siz: 5, int: 92, san: 60,
    聆听: 70, 电子学: 92, 神秘学: 30, 克苏鲁: 20, 图书馆: 80, 博物学: 80,
  },
  ailey_estrum: {
    age: 1,
    hp: 4, "brain_hp": 1,
  },
  phoebe_tricam: {
    age: 42, siz: 50, app: 55,
  },
  gabi_tricam: {
    age: 17, siz: 65, app: 50,
  },
  mir_tricam: {
    age: 5, siz: 24, app: 60,
  },
  tramp: {
    hp: 12, dex: 50, 斗殴: 45, 闪避: 55,
  },
  police: {
    hp: 12, dex: 60, 斗殴: 40, 手枪: 55, 闪避: 50,
  },
  bar_bouncer: {
    hp: 14, dex: 55, "db": "+1d4", 斗殴: 65, 霰弹: 40, 闪避: 50,
  },
  ghoul: {
    hp: 13, mp: 13, "db": "+1d4", 体格: 1,
    str: 60, con: 65, siz: 65, dex: 90, int: 55, pow: 65,
    格斗: 40, 咬住: 40, 闪避: 40, 攀爬: 80, 跳跃: 70, 聆听: 70, 潜行: 70, 侦查: 50,
  },
  mi_go: {
    hp: 11, mp: 15, "db": "无", 体格: 0,
    str: 40, con: 40, siz: 70, dex: 90, int: 65, pow: 85,
    格斗: 45, 闪避: 35,
  },
};

// NPC_STATS includes non-numeric special values (for example "?", "无", and
// "+1d4"). Keep that exact mixed table in the unified runtime source rather
// than coercing it into a combat-only numeric map.
BARN_RUNTIME.npcStats = NPC_STATS;

// ─── 遭遇战叙事数据 ────────────────────────────────────
// play-module.ts 读取此数据进行数据驱动战斗描述
const ENCOUNTER_NARRATIONS: EncounterNarration[] = [
  {
    sceneId: "维修间",
    requiredClue: "clue_bedroom_diary",
    excludedClue: "clue_migo_defeated",
    enemyName: "米-戈",
    encounterLines: [
      "管道深处传来低沉的嗡鸣，越来越近——",
      "突然，头顶的铁质通风口被猛地撞开！",
      "一只巨大的粉红色生物从天而降——五英尺高的节肢身体上，顶着一颗蟹状的头颅。膜翼展开时发出令人不安的震颤声。",
      "米-戈（Mi-Go）来带走艾米丽的缸中脑了。",
      "它发现了你们，发出一声刺耳的鸣叫——摆出了攻击姿态！",
    ],
    // 开发·摄取管线校准 阶段3：三处结局台词曾经都写着艾米丽"知情且心怀
    // 感谢"——【谢谢你们……它不会回来了。】/【照顾好爱莉……】。原文
    // （section_12:61-71、section_13:18-23）明确写着相反的事：她不知道
    // 自己是缸中脑，一旦意识到会"不可避免地陷入疯狂"，绝不是能在战斗
    // 结束后立刻开口感谢/交代遗言的知情者。改写只保留她能感知的部分——
    // 意识清醒、能感觉到周围的震动/搬动，但不给她任何暗示"她懂发生了
    // 什么"的台词。
    victoryLines: [
      "米-戈发出一声凄厉的尖叫，受伤严重。它惊恐地展开膜翼，撞破通风管道逃走了。",
      "粉红色的身影消失在管道深处，留下几滴荧光绿色的血液。",
      "艾米丽的意识传来一阵剧烈的波动，随后渐渐平息——她看不见，也听不清刚才发生了什么，只感觉到周围终于安静了下来。",
      "⚔ 战斗胜利 —— 米-戈被击退了！",
    ],
    defeatLines: [
      "米-戈发出一声刺耳的鸣叫——它强行抓起艾米丽的培养缸连接器，扯断了几根管道。",
      "营养液从破损处涌出，艾米丽的意识传来一阵痛苦的波动——剧烈的震动让她惊慌，却不知道自己正在被带走，也不知道要被带去哪里。",
      "在你们阻止它之前，它已经拖着缸中脑钻入了通风管道。",
      "粉红色的身影消失在黑暗中。",
      "⚔ 米-戈带着艾米丽的大脑逃走了……",
    ],
    victoryClueId: "clue_migo_defeated",
    fledLines: [
      "米-戈发出一声不甘的嘶叫——它放弃了艾米丽的培养缸，撞破通风管道独自逃走了。",
      "荧光绿的血液滴了一地，粉红色的身影消失在黑暗中。",
      "艾米丽的意识传来一阵剧烈的波动，随后渐渐平息——她看不见，也听不清刚才发生了什么，只感觉到周围终于安静了下来。",
    ],
  },
];

// ─── 尾声构建（数据驱动后日谈系统） ─────────────────────────
// 替代 flat EPILOGUE object，每个条目带条件，play-module.ts 循环评估
function buildEpilogues(): EpilogueEntry[] {
  return [
    {
      id: "migo_defeated",
      title: "米戈的下场",
      condition: { requiredClues: ["clue_migo_defeated"] },
      lines: [
        "米—戈被击退了。它伤痕累累地逃回了星空，短期内不会回来了。",
      ],
    },
    {
      id: "migo_escaped",
      title: "米戈的下场",
      condition: {
        requiredScenes: ["维修间"],
        excludeClues: ["clue_migo_defeated"],
      },
      lines: [
        "米—戈带走了艾米丽的培养缸——它们不会放弃这个珍贵的标本。谁也不知道艾米丽的意识会被带往何方。",
      ],
    },
    {
      id: "adrian_fate",
      title: "艾德里安的结局",
      condition: {
        requiredScenes: ["霍姆斯医院", "与艾德里安的会面"],
      },
      lines: [
        "而艾德里安——这个被自己的爱和绝望毁灭的男人——仍在医院的病床上。等待他的将是法庭，以及他自己的疑问：他到底做对了什么，又做错了什么？",
      ],
    },
    {
      id: "closing",
      title: undefined,
      condition: { requiredClues: [] },
      lines: [
        "夜色中，两人回到地面。",
      ],
    },
  ];
}

/** 渲染团队聚合 — 每个调查员的独立卷入方式 */
export function renderPartySetup(
  setup: PartySetup,
  members: Array<{ name: string; occupation: string }>,
): string[] {
  const out = [...setup.context];
  for (let i = 0; i < members.length && i < setup.hooks.length; i++) {
    out.push(setup.hooks[i].replace(/\{name\}/g, members[i].name).replace(/\{occupation\}/g, members[i].occupation));
  }
  if (setup.closing) out.push(...setup.closing);
  return out;
}

/** 渲染导入叙事 — 将 {pl1_name} 等插槽替换为实际角色数据 */
export function renderPrologue(
  prologue: { lines: string[] },
  pl1: { name: string; background: string; motive: string },
  pl2: { name: string; background: string; motive: string },
): string[] {
  const clean = (s: string) => s.replace(/[。！？\s]+$/, "");
  const bg1 = clean(pl1.background);
  const bg2 = clean(pl2.background);
  return prologue.lines.map(line =>
    line
      .replace(/\{pl1_name\}/g, pl1.name)
      .replace(/\{pl1_background\}/g, bg1 || "")
      .replace(/\{pl2_name\}/g, pl2.name)
      .replace(/\{pl2_background\}/g, bg2 || "")
      .replace(/\{pl1_motive\}/g, pl1.motive)
      .replace(/\{pl2_motive\}/g, pl2.motive)
  );
}

/**
 * 评估世界状态，返回匹配的后日谈条目列表。
 *
 * ⚠ requiredScenes 是 AND，不是 OR——EpilogueEntry.condition 的类型注释
 * （module/types.ts）写的是"必须访问过的场景 ID 列表（AND）"，这里原来
 * 实现成 `.some(...)`，字面意思和实现互相矛盾，且没有任何测试钉住过
 * 到底该是哪个。选 AND：① 就是"必须访问过"这四个字的字面意思；
 * ② requiredClues 已经是 AND，两个同名字段（都叫 requiredXxx，都描述
 * "必须满足的列表"）语义不一致，比"哪个更方便写数据"更值得优先对齐。
 *
 * 复查过现有数据在这次改动前后的匹配结果：全仓只有 3 处 requiredScenes
 * 给了非空数组，其中两处只有 1 个场景（AND/OR 对单元素数组无区别）；
 * 唯一的 2 元素数组是 adrian_fate 这条（["霍姆斯医院",
 * "与艾德里安的会面"]）——但"与艾德里安的会面"在场景图里
 * 只有一条连接指向它，且来源就是"霍姆斯医院"（:356 "前往艾德里安的病房"），
 * isSceneVisited() 查的是从不清空的累计历史（WorldState.sceneHistory），
 * 所以能到达"与艾德里安的会面"就必然已经访问过"霍姆斯医院"——AND 与
 * OR 在这条数据上给出完全相同的结果，跑前跑后无变化。
 */
export function evaluateEpilogues(
  entries: EpilogueEntry[],
  isClueFound: (id: string) => boolean,
  isSceneVisited: (id: string) => boolean,
): EpilogueEntry[] {
  return entries.filter(e => {
    const { requiredClues, excludeClues, requiredScenes } = e.condition;
    const hasReq = !requiredClues || requiredClues.length === 0 ||
      requiredClues.every(c => isClueFound(c));
    const hasExcl = !excludeClues || excludeClues.every(c => !isClueFound(c));
    const hasScenes = !requiredScenes || requiredScenes.length === 0 ||
      requiredScenes.every(s => isSceneVisited(s));
    return hasReq && hasExcl && hasScenes;
  });
}

// ─── 模组运行支持配置（引擎专属钩子/常量） ────────────────
// 供 play-module.ts 引擎通用化使用：引擎只读 ModuleData（数据）+ ModuleSupport（钩子），
// 不再直接依赖本模组专属常量/逻辑。类型见 src/module/types.ts。

/** 恐怖线索 → SAN 损失映射（键: 线索 ID, 值: CoC SAN 成本 "成功损失/失败损失"） */
const TRAUMATIC_CLUES: Record<string, string> = {
  "clue_barn_body": "0/1d3",
  "clue_barn_victims": "0/1d3",
  "clue_sewer_bodies": "1/1d3",
  "clue_final_brain_jars": "1/1d6",
  "clue_bedroom_old_doc": "1/1d3+1",
  "clue_control_lever": "1d3+1/1d6+1",
};

// 同一份 SAN 成本表同时服务 ModuleSupport 与 5C direct loader，不复制值。
BARN_RUNTIME.richClueSanCosts = TRAUMATIC_CLUES;

/** 结局显示标签（ending id → 标题） */
const END_LABELS: Record<string, string> = {
  true: "True End", near_truth: "Near-Truth End",
  good: "Good End", bad: "Bad End", normal: "Normal End",
};

/** 本模组运行支持配置 — 引擎通用运行所需全部模块专属钩子/常量 */
export const BARN_SUPPORT: ModuleSupport = {
  traumaticClues: TRAUMATIC_CLUES,
  evaluateEnding: evaluateEndNarration,
  endLabels: END_LABELS,
  encounters: ENCOUNTER_NARRATIONS,
  hubSceneId: "普瑞米尔",
  finaleSceneId: "维修间",
  finaleClueId: "clue_bedroom_diary",
  bossNpcIdPattern: /mi[_-]?go/i,
  // 到农场（艾德里安的农场）之前算"前期"——模组正文写着到农场入口就能
  // 看见那栋刷红漆的谷仓建筑（S.FARM 描述："再稍微往里有两个比较显眼的
  // 建筑。一间刷着红油漆的类似谷仓的建筑……"），这是叙事上"主线目标
  // 现出真身"的分界点；谷仓形建筑（谷仓本体）已经在终盘范围内，不能
  // 拿它当分界。
  earlyGameEndSceneId: "艾德里安的农场",
};
