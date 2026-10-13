// 开发·复合意图回问 —— 任务1验收。
//
// 背景：analysis/sim/2026-08-30-barn-a-retest.md 与 2026-08-28-barn-a-
// acceptance.md 两份实跑都暴露了同一个设计缺口：引擎是"一句话=一个意图"
// 的模型，玩家自然会说的复合句（"陆川带大家前往农场外围，沿着...寻找
// 可疑足迹"）里，LLM 只能二选一，通常执行后半段（搜索/对话）、丢掉前
// 半段（移动），scene 不变。已裁决走 B 方案（明确回问）：intent.action
// 命中白名单（talk/skill_check/unknown）时，对原始输入跑 resolveSceneTarget
// 找到一个有把握、且不是当前场景的地点，就先问一句"要不要先去那儿"。
//
// ⚠ 本仓测试跑在 regex 兜底路径（无 LLM key），实跑报告里的分类结果来自
// **真实 LLM**，两者对同一句话的判定不总是一致——例如报告里 R13
// （"陆川带大家前往农场外围……"）被 LLM 误判成搜索，但 regex 兜底对
// 同一句话恰好直接判成了 move（"前往...寻找"命中了 move 的组合模式）。
// 下面的用例先用 `bun -e` 实测过 parseIntent() 在 regex 路径下的真实分类，
// 只用**确实会在 regex 路径下命中白名单**的句子验证触发逻辑，不假装
// 报告里的每一句在这个环境下都复现同一个 bug。
//
// bun test src/__tests__/compound-move-reask.test.ts

import { describe, it, expect, beforeEach } from "bun:test";
import { GameSession } from "../api/game-session";

function makeSession(): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession("compound-move-test", "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, undefined, "调查员");
}

let session: GameSession;

beforeEach(async () => {
  session = makeSession();
  await session.act("加载模组 普瑞米尔的谷仓"); // 默认落在「特里坎家」
});

// 找回问文案那一条系统消息（不是玩家自己回显的那一条——玩家回显的
// action 消息里同样会含有原句提到的地名，不能靠"包含地名"来断言）。
function systemReplies(res: Awaited<ReturnType<GameSession["act"]>>): string {
  return res.events.filter((e) => e.speaker === "系统").map((e) => e.content).join("\n");
}

describe("实跑原文触发回问，且回问文案里出现真实候选", () => {
  it("R7：「陆川带队返回特里坎家……」（regex 兜底下判成 unknown）在维森酒吧触发回问", async () => {
    (session as any).movePlayerToScene("维森酒吧");
    const res = await session.act("陆川带队返回特里坎家，把拖车房里发现的情况告诉菲碧。");
    expect(session.getDisplayedScene()).toBe("维森酒吧"); // 还没真的移动，先问
    const sys = systemReplies(res);
    expect(sys).toContain("特里坎家");
    expect(sys).toContain("你是要先去");
    // 风险1：句子里"拖车房"只是话题（"加比的拖车房"的后三个字，不是完整
    // 子串），不该被列为候选——回问文案（系统消息）不该出现"拖车房"。
    expect(sys).not.toContain("拖车房");
  });

  it("state=特里坎家 时提到别的场景名的调查句触发回问（问题清单第3条，regex 下判成 skill_check）", async () => {
    // 默认就在特里坎家，直接送一句提到「加比的拖车房」的调查句。
    const res = await session.act("检查加比的拖车房里的床底和柜子，看有没有藏东西。");
    expect(session.getDisplayedScene()).toBe("特里坎家");
    const sys = systemReplies(res);
    expect(sys).toContain("加比的拖车房");
    expect(sys).toContain("你是要先去");
  });
});

describe("确认门往返：回答目的地→移动并执行后半段；回答别的→原地执行原意图", () => {
  it("回复目的地名字：移动过去，且原意图（对话）在新场景继续执行", async () => {
    (session as any).movePlayerToScene("维森酒吧");
    await session.act("陆川带队返回特里坎家，把拖车房里发现的情况告诉菲碧。");
    const res = await session.act("特里坎家");
    expect(session.getDisplayedScene()).toBe("特里坎家"); // 真的移动了
    // 原意图（unknown，找菲碧的话没有被结构化处理器接住）在新场景继续
    // 执行——至少不应该卡住、不产生响应。
    expect(res.events.length).toBeGreaterThan(0);
  });

  it("回复别的话（不是地点）：原地按原意图执行，不卡住", async () => {
    const res1 = await session.act("检查加比的拖车房里的床底和柜子，看有没有藏东西。");
    expect(systemReplies(res1)).toContain("你是要先去");
    const res = await session.act("算了，就在这儿先看看");
    expect(session.getDisplayedScene()).toBe("特里坎家"); // 没有移动
    expect(session.dead).toBe(false);
    // 原意图（skill_check）在原地执行——不管成功失败，必须真的执行了，
    // 不是卡住/空响应。
    expect(res.events.length).toBeGreaterThan(0);
  });
});

describe("回归：两份实跑报告里判对的输入，判定结果逐条不变", () => {
  it("R2：纯对话（不提及任何场景名）不触发回问，即使 action 在白名单里", async () => {
    const res = await session.act("林娜向菲碧说明我们会认真调查，并询问加比最后提到的朋友和地点。");
    expect(systemReplies(res)).not.toContain("你是要先去");
  });

  it("R4/R5/R6：纯调查句（不提及任何场景名）不触发回问", async () => {
    const sentences = [
      "陆川仔细检查床底下有没有藏东西，并查看衣物口袋是否留有纸条或地址。",
      "林娜仔细检查卫生间的洗漱用品和排水口，寻找异常药物或匆忙丢弃的东西。",
      "陈岳仔细翻查餐桌下面和披萨盒的夹层，看有没有夹着纸条或地址。",
    ];
    for (const s of sentences) {
      const res = await session.act(s);
      expect(systemReplies(res)).not.toContain("你是要先去");
    }
  });

  it("R3/R8：move 动作本就不受影响（intent.action=move 不在白名单里）", async () => {
    const res = await session.act("陈岳带大家前往加比的拖车房，准备从日常物品里寻找线索。");
    expect(session.getDisplayedScene()).toBe("加比的拖车房");
    expect(systemReplies(res)).not.toContain("你是要先去");
  });

  it("R13 原文在 regex 路径下已经正确判成 move，不受白名单影响", async () => {
    (session as any).movePlayerToScene("维森酒吧");
    const res = await session.act("陆川带大家前往农场外围，沿着通往深处的道路寻找可疑足迹和废弃物。");
    expect(session.getDisplayedScene()).toBe("农场外围"); // 直接移动，没有被拦下来问话
    expect(systemReplies(res)).not.toContain("你是要先去");
  });

  it("已经在目标场景时提到该场景名的追问不触发回问（sceneId === 当前场景）", async () => {
    (session as any).movePlayerToScene("维森酒吧");
    const res = await session.act("林娜追问菲碧，加比是否提过维森酒吧或者一场免费酒水的聚会。");
    expect(systemReplies(res)).not.toContain("你是要先去");
  });

  it("**关键回归**：加载模组这类管理动作不因为名字撞到场景名而被打断", async () => {
    // 「普瑞米尔」既是模组名的一部分，也是真实场景（镇子枢纽）——
    // intent.action=load_module 不在白名单里，必须正常执行，不能被问住。
    // （这条是修这个任务时真实撞到的回归：coc-spells.test.ts 的
    // 「同一个模组不应重复加载」一度因为第一版检测过宽而变红。）
    const res = await session.act("加载模组 普瑞米尔的谷仓");
    const content = res.events.map((e) => e.content).join("\n");
    expect(content).toMatch(/已导入/);
    expect(content).not.toContain("你是要先去");
  });
});

describe("两道确认门（compound-move 认人 Map / leave 单 boolean）不会互相打架", () => {
  it("复合回问 pending 期间的回复只会被当成回问的答复，不会被误判成离开确认", async () => {
    const prompted = await session.act("检查加比的拖车房里的床底和柜子，看有没有藏东西。");
    expect(systemReplies(prompted)).toContain("你是要先去");
    // 回复一句"确定"——act() 顶部先检查 myPendingMove（当前 PC 自己的
    // compound-move），命中就直接消费掉，不会走到下面的 leave 分支
    // （isConfirmReply("确定") 本来也为 true，如果两道门顺序反了就会被
    // 误判成"确认离开"）。
    await session.act("确定");
    expect(session.dead).toBe(false); // 没有被误判成"确认离开"从而结束会话
  });

  it("离开确认 pending 期间不会触发复合回问检测", async () => {
    const requested = await session.act("我们决定放弃调查，收工回家。");
    expect(systemReplies(requested)).toContain("确定要离开");
    // 这一步即使回复内容里提到别的场景名，也应该只走确认/取消分支，
    // 不会被复合回问检测拦截（pendingLeaveConfirm 为真时 act() 顶部就
    // 短路返回，压根不会跑到复合句检测那一段代码）。
    const res = await session.act("再等等，我们去农场外围看看");
    expect(res.events.some((e) => e.content.includes("先留下"))).toBe(true);
  });
});
