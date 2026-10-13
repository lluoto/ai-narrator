// LLM 意图解析准确率 —— 活体探针，不是 bun test 判据。
//
// 背景：analysis/sim/2026-08-31-barn-good-end.md —— 22 回合拿到 Good End，
// 但「陈岳打开冰箱与储物柜，逐一清点里面的氧气罐、药品和袋装流食」被判成
// inventory（背包查询），回复「你的背包是空的」。`[intent] 回落 = 0`，
// 这句话是**真的走了 LLM**，regex 路径对同一句给的是 unknown（会被
// `act()` 的对象名闸门接住）——只有 LLM 判错了。
//
// probe-llm.ts 量「LLM 通不通」，从没量过「LLM 判得准不准」——
// intent-coverage.test.ts 只盖 regex 路径（parseIntent 在没有 setIntentLLM
// 时直接走 regex 兜底）。这个盲区正是 probe-llm.ts 文件头写的那句话：
// 「五个跑局诊断脚本全都 LLM_DISABLED=true，从没量过 LLM 路径」——
// 这份探针补的就是这个洞，但补的是「LLM 意图解析」这一段，不是全部行为。
//
// ⚠ 开发·闸门放宽到 look 任务2：五条容器用例原来判的是
// "intent.action !== inventory"——上一轮提示词修好之后，两条从
// inventory 挪到了 look（不是挪到 unknown），照样够不着线索解析
// （act() 的对象名闸门当时只认 unknown）。**判据看着在检查，量的却不是
// 要的那件事**：真正要的是"这句话最终能不能拿到线索"，不是"action 的
// 名字不是 inventory"——`intent.action` 只是过程量，不是结果。改成
// 结果导向：这五条不再断言 parseIntent() 的返回值，而是**真的走一遍
// GameSession.act()**，检查目标线索有没有被发现。action 仍然记在报告
// 里当辅助信息（认错清单看得出"到底判成了什么"），但通过与否只看结果。
//
// 没有为此在生产代码里开后门——GameSession.investigation.isDiscoveredBy()
// 与 act() 都是既有的公开/半公开接口（测试文件同样用 `as any` 碰
// movePlayerToScene 这个私有方法，这里跟测试用同一手法，不是新开的洞）。
// 掷骰用真随机会让"路由对了但骰子没过"和"根本没走到线索解析"混在一起
// 判不清，所以在探针里也和测试一样锁 Math.random=()=>0，只隔离"路由对
// 不对"这一件事——骰子运气不是这份探针要量的东西。
//
// ⚠ 这是本仓第一个必须联网才能跑的判据：
//   · 结果不可复现（模型有随机性、换版本会变）——报告里记模型名/日期/样本数，
//     不当常量用。
//   · 不进 bun test（离线跑不了），放 scripts/diag/，和其它探针同侧。
//   · 无 key / LLM_DISABLED 时明确报「没跑」，不生成一个 0 或假绿——
//     probe-llm.ts 头部批评过的「拿测试输出当证据」不能在这里重演。
//   · 跑不止一次——单次结果不足以判断，尤其结果导向判据引入了"骰子已经
//     锁定但 LLM 分类仍有随机性"这类新变量，见 analysis/diag/ 下的多次
//     报告与提交信息里记录的多轮数据。
//
// 用法：bun scripts/diag/probe-llm-intent.ts

import { loadConfig, type LLMConfig } from "../../src/config";
import { LLMClient } from "../../src/llm/client";
import { isUsableLlmApiKey, llmDisabledByOverride } from "../../src/llm/enabled";
import { resolveNormalSessionIntent } from "../../src/llm/intent";
import { writeReport } from "../../src/diagnostics/report";
import { GameSession } from "../../src/api/game-session";

interface ActionCase {
  readonly kind: "action";
  readonly input: string;
  readonly wantAction: string;
  readonly note?: string;
}

export interface ResultCase {
  readonly kind: "result";
  readonly input: string;
  /** 结果导向：这句话最终必须让这条线索被发现——不问中途 action 判成了什么。 */
  readonly wantClueId: string;
  readonly note?: string;
}

type Case = ActionCase | ResultCase;

// 数据源 1：intent-coverage.test.ts 里已标注的 24 条常见 CoC 动作输入
// （量过一次 regex 路径：认对 10、认错 3、不认识 11——这里复用同一批输入，
// 换一条判据去量 LLM 路径认不认得同一批话）。这批仍按 action 判定——
// 它们本来就是在测"分类对不对"，不涉及后续要不要走到线索解析。
const COVERAGE_CASES: ActionCase[] = [
  { kind: "action", input: "潜行", wantAction: "skill_check" },
  { kind: "action", input: "潜行攻击 怪物", wantAction: "attack" },
  { kind: "action", input: "偷袭 怪物", wantAction: "attack" },
  { kind: "action", input: "查看背包", wantAction: "inventory" },
  { kind: "action", input: "背包", wantAction: "inventory" },
  { kind: "action", input: "聆听", wantAction: "skill_check" },
  { kind: "action", input: "恐吓 流浪汉", wantAction: "skill_check" },
  { kind: "action", input: "取悦 前台", wantAction: "skill_check" },
  { kind: "action", input: "话术", wantAction: "skill_check" },
  { kind: "action", input: "图书馆使用", wantAction: "skill_check" },
  { kind: "action", input: "查资料", wantAction: "skill_check" },
  { kind: "action", input: "侦查", wantAction: "skill_check" },
  { kind: "action", input: "恐吓他们", wantAction: "skill_check" },
  { kind: "action", input: "急救", wantAction: "first_aid" },
  { kind: "action", input: "给甲急救", wantAction: "first_aid" },
  { kind: "action", input: "包扎伤口", wantAction: "first_aid" },
  { kind: "action", input: "攻击 怪物", wantAction: "attack" },
  { kind: "action", input: "逃跑", wantAction: "flee" },
  { kind: "action", input: "休息", wantAction: "rest" },
  { kind: "action", input: "装填", wantAction: "reload" },
  { kind: "action", input: "san检定", wantAction: "san_check" },
  { kind: "action", input: "理智检定", wantAction: "san_check" },
  { kind: "action", input: "环顾四周", wantAction: "look" },
  { kind: "action", input: "说服 保镖", wantAction: "skill_check" },
  { kind: "action", input: "调查 谷仓", wantAction: "skill_check" },
  { kind: "action", input: "创建角色 investigator 甲", wantAction: "create_character" },
  { kind: "action", input: "加载模组 谷仓", wantAction: "load_module" },
  { kind: "action", input: "状态", wantAction: "status" },
];

// 数据源 2：本轮要修的真实实跑句子——冰箱/储物柜/拉杆这类场景容器操作。
// 结果导向：不再问"action 是不是 inventory"，问"这句话最终能不能在
// 中控室拿到 clue_control_supplies / clue_control_lever"——这才是玩家
// 真正在意的事，action 判成 unknown 还是 look 都只是过程。
// wantClueId 取自 decideClueMatch() 对这几句话的真实判定（clue-match.ts
// 是纯函数，不受 LLM 随机性影响，用它定"这句话本该对应哪条线索"）。
const OBJECT_CASES: ResultCase[] = [
  {
    kind: "result",
    input: "陈岳打开冰箱与储物柜，逐一清点里面的氧气罐、药品和袋装流食。",
    wantClueId: "clue_control_supplies",
    note: "analysis/sim/2026-08-31-barn-good-end.md 问题清单 1——本轮要修的真实误判",
  },
  { kind: "result", input: "打开冰箱", wantClueId: "clue_control_supplies", note: "场景容器，非玩家背包" },
  { kind: "result", input: "看看储物柜", wantClueId: "clue_control_supplies", note: "场景容器，非玩家背包" },
  { kind: "result", input: "拉一下拉杆", wantClueId: "clue_control_lever", note: "场景机关，非玩家背包" },
  { kind: "result", input: "清点冰箱里的东西", wantClueId: "clue_control_supplies", note: "「清点」+ 场景容器" },
];

// 数据源 3：对照组——玩家自己的背包依然必须判成 inventory，
// 不能因为改了措辞就连这条也改坏了。这条仍按 action 判定：背包查询
// 本来就不该走到线索解析，"结果导向"在这里没有意义。
const CONTROL_CASES: ActionCase[] = [
  { kind: "action", input: "查看背包", wantAction: "inventory", note: "对照组：玩家自己的背包" },
  { kind: "action", input: "清点背包", wantAction: "inventory", note: "对照组：玩家自己的背包" },
];

const ALL_CASES: Case[] = [...COVERAGE_CASES, ...OBJECT_CASES, ...CONTROL_CASES];

/**
 * Result-oriented simulated play must use the same configured server-side
 * model endpoint as the diagnostic. Natural language is required to resolve
 * through that client; a model failure is evidence of an unavailable probe,
 * never permission to substitute the regex parser.
 */
export function createRequiredProbeSession(id: string, config: LLMConfig): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    config,
    "investigator",
    "甲",
    undefined,
    undefined,
    undefined,
    "required",
  );
}

/** The action-only rows are diagnostic evidence too, so they must not silently become regex guesses. */
async function resolveRequiredDiagnosticAction(input: string, client: LLMClient): Promise<string> {
  const resolution = await resolveNormalSessionIntent(input, client, "required");
  if (resolution.status === "resolved") return resolution.intent.action;
  return `<${resolution.status}: ${resolution.errorCode}>`;
}

/**
 * 结果导向用例的判定：真的走一遍 GameSession.act()，看目标线索有没有
 * 被发现。每条用例用一个全新的会话（互不污染已发现状态），锁定骰子只
 * 隔离"路由对不对"，不隔离"LLM 分类准不准"。
 */
export async function runResultCase(
  c: ResultCase,
  config: LLMConfig,
  classifier: LLMClient,
): Promise<{ got: string; ok: boolean }> {
  const session = createRequiredProbeSession(`probe-${Math.random()}`, config) as any;
  await session.act("加载模组 普瑞米尔的谷仓");
  session.movePlayerToScene("中控室");

  let action: string;
  try {
    action = await resolveRequiredDiagnosticAction(c.input, classifier);
  } catch (error) {
    action = `<exception: ${error instanceof Error ? error.message.slice(0, 60) : String(error).slice(0, 60)}>`;
  }

  const real = Math.random;
  Math.random = () => 0; // 只锁骰子，不锁 LLM 分类——见文件头注释
  try {
    const response = await session.act(c.input, "p1");
    if (response.error) {
      return { got: `action=${action}, execution=${response.error.code}, discovered=false`, ok: false };
    }
  } finally { Math.random = real; }

  const discovered: boolean = session.investigation.isDiscoveredBy(c.wantClueId, "p1");
  return { got: `action=${action}, discovered=${discovered}`, ok: discovered };
}

async function main() {
  const cfg = loadConfig();
  const hasKey = isUsableLlmApiKey(cfg.apiKey);
  const disabled = llmDisabledByOverride();

  const out: string[] = ["# LLM 意图解析准确率探针", ""];
  out.push(`- 时间：${new Date().toISOString().slice(0, 19).replace("T", " ")}`);
  out.push(`- model：\`${cfg.model}\``);
  out.push(`- baseUrl：\`${cfg.baseUrl}\``);
  out.push(`- 样本数：${ALL_CASES.length}（覆盖 ${COVERAGE_CASES.length} + 对象名（结果导向）${OBJECT_CASES.length} + 对照 ${CONTROL_CASES.length}）`);
  out.push("");
  out.push("⚠ 结果不可复现——模型有随机性、会换版本，别把这次的数当成常量。");
  out.push("每次跑都应该重新记录时间/模型名，不能拿旧报告里的数字当依据。");
  out.push("单次结果不足以判断，尤其对象名这五条——建议连跑几次看是否稳定。");
  out.push("");

  if (!hasKey || disabled) {
    const reason = !hasKey ? "没有 key" : "LLM_DISABLED=true";
    out.push(`## 未运行`);
    out.push("");
    out.push(`${reason}，本探针需要真实调用 LLM，跳过。不产生任何准确率数字——`);
    out.push("没跑就是没跑，不能用「没跑」推出「0%」或「100%」这类误导性结论。");
    const path = await writeReport("probe-llm-intent.md", out.join("\n"));
    console.log(`✗ 未运行（${reason}）  -> ${path}`);
    process.exit(1);
  }

  // 熔断是进程级静态变量，探针里先复位，免得被同进程里的历史失败带偏。
  LLMClient.resetDefeat();
  const classifier = new LLMClient(cfg);

  type Row = { input: string; want: string; got: string; ok: boolean; note?: string; kind: Case["kind"] };
  const rows: Row[] = [];
  for (const c of ALL_CASES) {
    if (c.kind === "action") {
      let got = "<异常>";
      try {
        got = await resolveRequiredDiagnosticAction(c.input, classifier);
      } catch (e) {
        got = `<异常: ${e instanceof Error ? e.message.slice(0, 60) : String(e).slice(0, 60)}>`;
      }
      rows.push({ input: c.input, want: c.wantAction, got, ok: got === c.wantAction, note: c.note, kind: "action" });
    } else {
      try {
        const { got, ok } = await runResultCase(c, cfg, classifier);
        rows.push({ input: c.input, want: `发现 ${c.wantClueId}`, got, ok, note: c.note, kind: "result" });
      } catch (e) {
        rows.push({
          input: c.input, want: `发现 ${c.wantClueId}`,
          got: `<异常: ${e instanceof Error ? e.message.slice(0, 60) : String(e).slice(0, 60)}>`,
          ok: false, note: c.note, kind: "result",
        });
      }
    }
  }

  const okCount = rows.filter((r) => r.ok).length;
  const pct = ((okCount / rows.length) * 100).toFixed(1);

  out.push(`## 准确率：${okCount}/${rows.length} = ${pct}%`);
  out.push("");
  out.push("| 输入 | 判据类型 | 期望 | 实际 | 结果 | 备注 |");
  out.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    out.push(`| ${r.input} | ${r.kind === "action" ? "分类" : "结果"} | ${r.want} | ${r.got} | ${r.ok ? "✓" : "✗ 认错"} | ${r.note ?? ""} |`);
  }

  const wrong = rows.filter((r) => !r.ok);
  out.push("");
  out.push(`## 认错清单（${wrong.length} 条）`);
  out.push("");
  if (wrong.length === 0) {
    out.push("（无）");
  } else {
    for (const r of wrong) {
      out.push(`- \`${r.input}\`（${r.kind === "action" ? "分类" : "结果"}）期望 ${r.want}，实际 ${r.got}${r.note ? `（${r.note}）` : ""}`);
    }
  }

  const path = await writeReport("probe-llm-intent.md", out.join("\n"));
  console.log(`${okCount}/${rows.length} = ${pct}%（认错 ${wrong.length} 条）  -> ${path}`);
  process.exit(0);
}

if (import.meta.main) void main();
