// 脱离模组范围：确认门文案判据 + 已知模组的结局求值支持登记表。
//
// 背景（开发 A · 任务 4/5）：目标不在模组场景表内时，不能直接判"脱离"——
// 意图误判率约 20%（todo-29），第一次实跑就把一句纯调查的话
// （"陈岳查看餐桌、披萨盒和啤酒罐，找可能的留言或地址。"）判成过移动。
// 必须分两件事：
//   看不懂你要去哪（空目标/乱码/误判）→ 反问或叙事兜底，绝不结束
//   你明确要离开（显式离开意图 + 确认）→ 走结局
// 判据只认"输入本身有没有明确表达离开/结束调查"，不看移动解析成不成功。

import { BARN_SUPPORT } from "../module/barn-of-premier";
import type { ModuleSupport } from "../module/types";

/**
 * 判定一句话是不是在明确表达"离开这里/结束调查"。
 *
 * 故意收得比通用移动正则更窄：宁可漏判（玩家得再说一遍"我们要走了"），
 * 不可误判（把一句翻东西的话变成终结整场跑团）。只认清楚写出"离开/结束/
 * 放弃/回家/收工"这类词的输入，不靠"移动目标解析失败"反推。
 */
const EXPLICIT_LEAVE_RE =
  /(离开(?:这里|此地|这座?小镇|这个地方|镇子|城镇)|结束(?:这次)?调查|不再调查|放弃调查|返回家乡|任务结束|调查到此为止|收工回家|打道回府|离开.{0,6}(?:范围|地图))/;

export function isExplicitLeaveIntent(rawInput: string): boolean {
  return EXPLICIT_LEAVE_RE.test(rawInput ?? "");
}

/**
 * 确认门的确认回复判据——只认清楚的肯定，其它任何话（含否定、沉默、
 * 之外的新行动）一律按"取消"处理，留在原地、不消耗结局。
 * 代价对称：确认或取消都花掉这一回合（act() 本来就会推进的那 1 tick），
 * 但只有确认才会真正进入结局判定。
 */
const CONFIRM_RE = /^(是|对|确定|确认|没错|走吧|走|离开吧|嗯|好的?|yes|y)[!！。.,，]*$/i;

export function isConfirmReply(rawInput: string): boolean {
  return CONFIRM_RE.test((rawInput ?? "").trim());
}

/**
 * 已知模组 id → 结局求值支持（ModuleSupport）。
 *
 * 三个可加载模组里目前只有「普瑞米尔的谷仓」（premiers_barn）有
 * END_NARRATIONS。阿卡姆档案检查 / 印斯茅斯的阴影**结局数据为空**——
 * 这是"待补"，不是"按设计没有结局"（仓库里没有任何证据支持后者，
 * 见 docs/todo.json）。没登记在这张表里的模组一律走通用收场。
 *
 * 用登记表而不是硬编码 if(mod.id==="premiers_barn")，是为了让"给某个
 * 模组补上结局数据"这件事只需要加一行登记，不用改分支逻辑——也让
 * 变异检验有处下手：往这张表里插一条假登记，就能验证"有登记就走结局
 * 分支"这条路径本身是通的，不用真的给阿卡姆写一份 END_NARRATIONS。
 */
export const MODULE_ENDING_SUPPORT: Record<string, ModuleSupport> = {
  premiers_barn: BARN_SUPPORT,
};

/** 没有结局数据的模组，早退时的通用收场文案。 */
export const GENERIC_DEPARTURE_LINES: readonly string[] = [
  "你们收拾好东西，离开了这里。",
  "日子照常流转，这次的调查到此告一段落。",
];
