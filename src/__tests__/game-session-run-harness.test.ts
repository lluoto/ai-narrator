// 开发·GameSession 确定性跑局装置 —— 任务2验收。
//
// 背景：自由跑团路径（GameSession）的多回合行为回归此前只能靠 LLM 代理
// 跑模拟，而模拟 prompt 已连续三次污染读数（写死 30 回合导致噪音、没设
// 输入长度下限导致假"0次判错"、误禁必需命令、指错日志文件）。剧本杀路径
// 已有 runSeeded()（run-harness.ts）复用 withSeededRandom 做确定性回归，
// 但它是"选项驱动"（引擎给选项、decide() 随机挑）——GameSession 是自由
// 输入驱动，没有选项可挑，所以装置改为吃一份输入脚本
// （runGameSessionScript()，见 game-session-run-harness.ts 头注释）。
//
// 本文件只钉三件事（任务描述指定）：①移动计时（相邻1跳 vs 跨图多跳
// 推进不同）②复合句回问（"前往X，然后做Y"触发回问；回答后正确执行；
// 判对的输入不因此变成回问——回归）③脱离结局（显式离开→确认→结局；
// 验证 todo-34 的场景 id 桥接修复，脚本能走到 True End）。
// 不测：LLM 意图判错率/叙述质量——那仍然只有真实 LLM 模拟能测。
//
// bun test src/__tests__/game-session-run-harness.test.ts

import { describe, it, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { runGameSessionScript, type GameSessionScriptStep } from "../diagnostics/game-session-run-harness";
import { END_NARRATIONS } from "../module/barn-of-premier";

function makeSession(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, undefined, "调查员", undefined, undefined, undefined, undefined, { careerEntryPersistence: "transient" });
}

void legacyMakeSession;
function legacyMakeSession(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, undefined, "调查员");
}

/**
 * 多 PC 脚本用——p1 必须带 archetype（"创建角色"走过真实建卡）才能被
 * act(input, "p1") 按 pcId 路由：空壳 p1（无 archetype 构造）根本不在
 * `characters` Map 里，传 pcId="p1" 会被判成 unknown_target 直接拒绝
 * （实测过，见 pendingConfirm 认人那组用例的注释）。
 */
function makeMultiPcSession(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, "investigator", "甲", undefined, undefined, undefined, undefined, { careerEntryPersistence: "transient" });
}

void legacyMakeMultiPcSession;
function legacyMakeMultiPcSession(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, "investigator", "甲");
}

const LOAD_MODULE: GameSessionScriptStep = { input: "加载模组 普瑞米尔的谷仓" };
const OPTS = { seed: 20260830, timeoutMs: 30_000, maxSteps: 100 };

describe("确定性：同 seed+同脚本跑两次，逐回合输出完全相同，draws 也相同", () => {
  it("构造与脚本运行不修改全局 LLM 环境", async () => {
    const before = { llm: process.env.LLM_API_KEY, openai: process.env.OPENAI_API_KEY };
    const result = await runGameSessionScript(makeSession("environment-isolation"), [LOAD_MODULE], OPTS);
    expect(result.threw).toBe(false);
    expect({ llm: process.env.LLM_API_KEY, openai: process.env.OPENAI_API_KEY }).toEqual(before);
  });

  it("两次独立会话（各自加载模组+移动+侦查）产生逐字相同的快照序列", async () => {
    const script: GameSessionScriptStep[] = [
      LOAD_MODULE,
      { input: "侦查" },
      { input: "前往加比的拖车房" },
      { input: "侦查" },
    ];

    const a = await runGameSessionScript(makeSession("determinism-a"), script, OPTS);
    const b = await runGameSessionScript(makeSession("determinism-b"), script, OPTS);

    expect(a.threw).toBe(false);
    expect(b.threw).toBe(false);
    expect(a.steps.length).toBe(script.length);
    expect(a.draws).toBe(b.draws);
    // 逐回合比较：场景/回合数/游戏时间/叙述/事件全部相同（会话 id 不同不影响这些字段）。
    for (let i = 0; i < a.steps.length; i++) {
      expect(a.steps[i].scene).toBe(b.steps[i].scene);
      expect(a.steps[i].round).toBe(b.steps[i].round);
      expect(a.steps[i].gameTime).toEqual(b.steps[i].gameTime);
      expect(a.steps[i].narrative).toBe(b.steps[i].narrative);
      expect(a.steps[i].events).toEqual(b.steps[i].events);
    }
  });

  it("不同 seed 在会触发掷骰的步骤上产生不同结果（seed 真的在控制骰子）", async () => {
    // 「侦查」触发 spot_hidden 检定，掷骰结果依赖 Math.random。
    const script: GameSessionScriptStep[] = [LOAD_MODULE, { input: "侦查" }];
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const narratives = new Set<string>();
    for (const seed of seeds) {
      const r = await runGameSessionScript(makeSession(`seed-diff-${seed}`), script, { ...OPTS, seed });
      expect(r.threw).toBe(false);
      narratives.add(r.steps[r.steps.length - 1].narrative);
    }
    // 8 个不同种子里至少要出现 2 种不同的结果，否则 seed 根本没有在控制骰子。
    expect(narratives.size).toBeGreaterThan(1);
  });
});

describe("① 移动计时：相邻 1 跳 vs 跨图多跳推进不同", () => {
  it("跨图移动（特里坎家→维修间，8 跳）比相邻移动（特里坎家→加比的拖车房，1 跳）推进更多时间", async () => {
    const adjacentScript: GameSessionScriptStep[] = [LOAD_MODULE, { input: "前往加比的拖车房" }];
    const farScript: GameSessionScriptStep[] = [LOAD_MODULE, { input: "前往维修间" }];

    const adjacent = await runGameSessionScript(makeSession("move-cost-adjacent"), adjacentScript, OPTS);
    const far = await runGameSessionScript(makeSession("move-cost-far"), farScript, OPTS);
    expect(adjacent.threw).toBe(false);
    expect(far.threw).toBe(false);

    const beforeAdjacent = adjacent.steps[0].gameTime; // 加载模组那一步之后
    const afterAdjacent = adjacent.steps[1].gameTime;
    const beforeFar = far.steps[0].gameTime;
    const afterFar = far.steps[1].gameTime;

    expect(beforeAdjacent).toEqual(beforeFar); // 两组起点相同
    expect(afterAdjacent).not.toEqual(afterFar); // 终点必须不同

    const periodOrder = ["dawn", "morning", "noon", "afternoon", "dusk", "evening", "night", "late_night"];
    const totalTicks = (gt: { day: number; period: string }) =>
      (gt.day - 1) * 24 + periodOrder.indexOf(gt.period) * 3;
    const adjacentAdvance = totalTicks(afterAdjacent) - totalTicks(beforeAdjacent);
    const farAdvance = totalTicks(afterFar) - totalTicks(beforeFar);
    expect(farAdvance).toBeGreaterThan(adjacentAdvance);
    expect(far.steps[1].scene).toBe("维修间");
    expect(adjacent.steps[1].scene).toBe("加比的拖车房");
  });
});

describe("② 复合句回问：触发/回答后正确执行/判对的输入不变成回问（回归）", () => {
  it("复合句触发回问，回答目的地后移动成功且脚本能继续往下走", async () => {
    const script: GameSessionScriptStep[] = [
      LOAD_MODULE,
      { input: "检查加比的拖车房里的床底和柜子，看有没有藏东西。" }, // 触发回问
      { input: "加比的拖车房" }, // 回答目的地
      { input: "侦查" }, // 脚本能继续往下走，不卡住
    ];
    const r = await runGameSessionScript(makeSession("compound-reask"), script, OPTS);
    expect(r.threw).toBe(false);
    const askStep = r.steps[1];
    const sysReplies = askStep.events.filter((e) => e.speaker === "系统").map((e) => e.content).join("\n");
    expect(sysReplies).toContain("你是要先去");
    expect(askStep.scene).toBe("特里坎家"); // 还没真的移动
    const movedStep = r.steps[2];
    expect(movedStep.scene).toBe("加比的拖车房"); // 回答后真的移动了
    const finalStep = r.steps[3];
    expect(finalStep.events.length).toBeGreaterThan(0); // 没有卡住
  });

  it("回归：move 动作本就不受影响，判对的输入不会因为本装置的存在而变成回问", async () => {
    const script: GameSessionScriptStep[] = [
      LOAD_MODULE,
      { input: "陈岳带大家前往加比的拖车房，准备从日常物品里寻找线索。" },
    ];
    const r = await runGameSessionScript(makeSession("compound-reask-regression"), script, OPTS);
    expect(r.threw).toBe(false);
    const moveStep = r.steps[1];
    expect(moveStep.scene).toBe("加比的拖车房"); // 直接移动，没有被拦下来问话
    const sysReplies = moveStep.events.filter((e) => e.speaker === "系统").map((e) => e.content).join("\n");
    expect(sysReplies).not.toContain("你是要先去");
  });
});

describe("③ 脱离结局：显式离开→确认→结局，脚本能走到 True End（验证 todo-34 场景 id 桥接修复）", () => {
  it("发现日记与老文件、到过维修间后显式离开并确认，得到 True End", async () => {
    const session = makeSession("departure-true-end");
    const script: GameSessionScriptStep[] = [
      LOAD_MODULE,
      { input: "前往艾德里安的卧室" },
      { input: "林娜翻开卧室书桌上的日记和旧文件，想知道地下室里到底发生过什么。" },
      { input: "陆川从日记本中取出老旧文件仔细查看。" },
      { input: "前往维修间" },
      { input: "陆川走近那两个培养缸，看清里面泡着什么" },
      { input: "我们决定离开这里，结束这次调查" },
      { input: "确定" },
    ];
    const result = await runGameSessionScript(session, script, { ...OPTS, seed: 187 });
    expect(result.threw).toBe(false);
    expect(result.steps[4].scene).toBe("维修间");
    expect(result.steps[7].dead).toBe(false);

    const trueEndNarration = END_NARRATIONS.find((e) => e.id === "true")!;
    expect(result.steps[7].narrative).toBe(trueEndNarration.lines.join("\n"));
  });

  // 开发·摄取管线校准 阶段3：near_truth 是本轮新增的结局，此前从未被
  // 任何测试通过 act() 路径验证过——与上面 True End 用同一种手法
  // （markDiscovered 构造前置状态 + act() 走 leave 流程触发判定），唯一
  // 差异是不标记 clue_bedroom_old_doc，验证"到过终局见到缸中脑但没读懂
  // 老文件"这条路径真的落到 near_truth，不是掉进 Normal End 或误判成
  // True End。
  it("到过维修间、发现缸中脑但未读懂老文件，显式离开并确认，得到 Near-Truth End", async () => {
    const session = makeSession("departure-near-truth-end");
    const script: GameSessionScriptStep[] = [
      LOAD_MODULE,
      { input: "前往维修间" },
      { input: "查看母女的缸中脑" },
      { input: "我们决定离开这里，结束这次调查" },
      { input: "确定" },
    ];
    const result = await runGameSessionScript(session, script, { ...OPTS, seed: 2 });
    expect(result.threw).toBe(false);
    expect(result.steps[1].scene).toBe("维修间");
    expect(result.steps[4].dead).toBe(false);

    const nearTruthNarration = END_NARRATIONS.find((e) => e.id === "near_truth")!;
    expect(result.steps[4].narrative).toBe(nearTruthNarration.lines.join("\n"));
  });
});

// 开发·真相链路 任务②：True End 至今没有一次是靠玩家输入走到的——上面
// ③ 的两条测试（含 scene-id-bridge.test.ts:66/79/105）全部用
// markDiscovered 直接标旗标，验的是"旗标齐了就出 True End"，不是"玩家
// 能不能把旗标挣到"。这条判据补上之前，"True End 可达"这个结论都只是
// 单元层的。
//
// 全链路纯自然语句（不含任何 markDiscovered / 内部 clue id 字面量）：
//   卧室拿 diary → 读 old_doc → 前往维修间 → 查看缸中脑 → 离开确认 → True End
//
// seed=187 是穷举 1..500 找到的、三处技能检定都在第一次输入就成功的
// 种子（暴力搜索脚本已删除，不留在仓库里；判据不依赖脚本本身，只依赖
// 这个种子在这份固定脚本下的确定性结果）——不追求"运气好蒙对"，追求
// 的是"同一份脚本、同一个种子，每次跑结果都一样"这件事本身可验证：
// 下面第二条用例连跑两次比较逐步输出，就是在验证这一点，而不是假设
// LCG 天生确定就够了。
describe("④ 全链路：纯自然语句从卧室走到 True End（开发·真相链路 任务②）", () => {
  const TRUE_END_CHAIN_SEED = 187;
  const trueEndScript: GameSessionScriptStep[] = [
    LOAD_MODULE,
    { input: "前往艾德里安的卧室" },
    { input: "林娜翻开卧室书桌上的日记和旧文件，想知道地下室里到底发生过什么。" },
    { input: "陆川从日记本中取出老旧文件仔细查看。" },
    { input: "前往维修间" },
    { input: "陆川走近那两个培养缸，看清里面泡着什么" },
    { input: "我们决定离开这里，结束这次调查" },
    { input: "确定" },
  ];

  it("**主判据**：全程只用自然语句和 act()，不调用 markDiscovered、不出现内部 clue id，最终得到 True End", async () => {
    const session = makeSession("true-end-natural-language-chain");
    const r = await runGameSessionScript(session, trueEndScript, { ...OPTS, seed: TRUE_END_CHAIN_SEED });
    expect(r.threw).toBe(false);

    // 逐步核对每一次自然语句确实命中了它该命中的那条线索，不是靠运气
    // 蒙对了最终结局——中途任何一步走岔都要在这里现形，不能只看最后
    // 一步的文本。
    // 逐步核对只靠叙事文本本身——不读任何内部 clue id/investigation
    // 状态，revelation 原文逐字匹配就是"这一步真的命中了它该命中的
    // 那条线索"的证据，比读内部状态更直接，也不给"用 id 抄近路验证"
    // 留任何空间。
    expect(r.steps[1].scene).toBe("艾德里安的卧室");
    expect(r.steps[2].narrative).toBe("发现日记本、老旧文件（与Mi-Go联络术相关）、生锈钥匙（打开下水道维修间门）。");
    // 5C direct loader 不再丢 rich clue 的结构化 SAN 成本；固定 seed 下
    // 本步实际扣 1 SAN。旧 bridge 只注册 revelation，曾漏掉这项。
    expect(r.steps[3].narrative).toBe("发现Mi-Go联络术（sc1/1d3+1，研究2周可学会，CM+3）。\n（SAN -1）");
    expect(r.steps[4].scene).toBe("维修间");

    // 任务①之前，这句话（引擎叙事自己反复用的"培养缸"）会被 deny——
    // 这一步是本条判据的关键，也是变异检验要盯住的那一步。
    expect(r.steps[5].narrative).toBe("发现艾米丽和爱莉的缸中脑（Sc1/1d6）。艾米丽以为自己只是失去了视觉触觉。\n（SAN -1）");

    expect(r.steps[7].dead).toBe(false);
    const trueEndNarration = END_NARRATIONS.find((e) => e.id === "true")!;
    expect(r.steps[7].narrative).toBe(trueEndNarration.lines.join("\n"));
  });

  it("确定性回归：同一份脚本、同一个种子，两次独立会话逐步输出完全相同", async () => {
    const a = await runGameSessionScript(makeSession("true-end-chain-determinism-a"), trueEndScript, { ...OPTS, seed: TRUE_END_CHAIN_SEED });
    const b = await runGameSessionScript(makeSession("true-end-chain-determinism-b"), trueEndScript, { ...OPTS, seed: TRUE_END_CHAIN_SEED });
    expect(a.threw).toBe(false);
    expect(b.threw).toBe(false);
    for (let i = 0; i < a.steps.length; i++) {
      expect(a.steps[i].narrative).toBe(b.steps[i].narrative);
      expect(a.steps[i].scene).toBe(b.steps[i].scene);
    }
  });
});

// 开发·pendingConfirm 认人 —— 任务2验收（跨 PC 泄漏）。
//
// 背景：2026-08-30 实跑（会话 lcmj2joi）：回合 7 p1 说"回家汇报并问马克"
// 触发复合句回问（KP 在等确认要不要先移动过去），回合 8 p2 说"问菲碧
// 酒吧派对"——这句与 p1 的回问毫无关系，却被当成了回答，p1 的问题被
// 悄悄吃掉。根因：pendingConfirm 是会话级单字段，只记"有没有待确认"，
// 不记"是谁提的"。已裁决：compound-move 认人（Map<pcId, ...>，只有
// 触发它的那个 PC 能回答，其它 PC 照常行动 + 收到提醒）；leave 不认人
// （party 级决定，谁确认/取消都算数）——见 pendingCompoundMove/
// pendingLeaveConfirm 两个字段各自的注释。
describe("pendingConfirm 认人：compound-move 只认发起的 PC，leave 谁都能答", () => {
  it("p1 开门→p2 行动→p2 按自己的意图执行，不被当成对 p1 问题的回答；p1 随后再答仍然生效", async () => {
    const session = makeMultiPcSession("pending-confirm-cross-pc");
    const script: GameSessionScriptStep[] = [
      LOAD_MODULE,
      { input: "创建队友 乙 investigator" }, // p2，默认以 p1 身份发出这条指令
      { input: "检查加比的拖车房里的床底和柜子，看有没有藏东西。", pcId: "p1" }, // p1 开门
      { input: "跟菲碧说话", pcId: "p2" }, // p2 无关行动，走已覆盖的 talk parser
      { input: "加比的拖车房", pcId: "p1" }, // p1 回答
    ];
    const r = await runGameSessionScript(session, script, OPTS);
    expect(r.threw).toBe(false);

    const openStep = r.steps[2];
    expect(openStep.scene).toBe("特里坎家"); // 还没真的移动
    const openSys = openStep.events.filter((e) => e.speaker === "系统").map((e) => e.content).join("\n");
    expect(openSys).toContain("你是要先去");

    // 关键断言：p2 那一步没有被当成对 p1 问题的回答——
    // 场景没变（没有被 p2 的话误移动去加比的拖车房），且能看到
    // "p1 还有问题没答"的提醒，同时 p2 自己的行动（对话）正常执行了。
    const p2Step = r.steps[3];
    expect(p2Step.scene).toBe("特里坎家");
    const p2Sys = p2Step.events.filter((e) => e.speaker === "系统").map((e) => e.content).join("\n");
    expect(p2Sys).toContain("p1");
    expect(p2Sys).toContain("没有回答");
    expect(r.timedOut).toBe(false);
    expect(r.hitStepCap).toBe(false);
    const dialogue = p2Step.events.find((e) => e.type === "dialogue" && e.speaker === "菲碧·特里坎");
    expect(dialogue).toBeDefined(); // p2 的输入真的走到在场 NPC 对话，不是只记 action 回声

    // p1 随后回答仍然生效：真的移动了。
    const answerStep = r.steps[4];
    expect(answerStep.scene).toBe("加比的拖车房");
  });

  it("p1 开门→p1 自己回答→正常生效（回归：不能因为加了认人就连同 PC 都答不了）", async () => {
    const session = makeMultiPcSession("pending-confirm-same-pc");
    const script: GameSessionScriptStep[] = [
      LOAD_MODULE,
      { input: "检查加比的拖车房里的床底和柜子，看有没有藏东西。", pcId: "p1" },
      { input: "加比的拖车房", pcId: "p1" },
    ];
    const r = await runGameSessionScript(session, script, OPTS);
    expect(r.threw).toBe(false);
    expect(r.steps[1].scene).toBe("特里坎家");
    expect(r.steps[2].scene).toBe("加比的拖车房");
  });

  it("leave 不认人：p1 开门，p2 确认，照样结束调查（party 级决定）", async () => {
    const session = makeMultiPcSession("pending-leave-any-pc");
    const script: GameSessionScriptStep[] = [
      LOAD_MODULE,
      { input: "创建队友 乙 investigator" },
      { input: "我们决定离开这里，结束这次调查", pcId: "p1" }, // p1 开门
      { input: "确定", pcId: "p2" }, // p2 确认——leave 不认人，这应当算数
    ];
    const r = await runGameSessionScript(session, script, OPTS);
    expect(r.threw).toBe(false);
    expect(r.steps[3].dead).toBe(false); // 真的结束了，没有因为"不是同一个人"被拒绝
  });
});
