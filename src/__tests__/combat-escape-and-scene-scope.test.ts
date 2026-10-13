// 实跑证据（会话 bhklwkwu，34 回合）暴露的三个耦合问题：
//
// 1. handleIntent 的 case "move"/"look" 在模块模式下不管
//    tryResolveModuleScene() 返回什么，一律 `return false`——移动**成功**了
//    也被报成"没处理"，继续往下走到战斗检测。回合 29「去特里坎家」因此打
//    中了艾德里安。
// 2. act() 里 `this.combatActive || 攻击词` 只要还在打，任何没被
//    handleIntent 接住的输入（移动失败、纯叙述、聊天）都被判成攻击。
//    「我点燃酒吧，夺走所有登记簿，宣布整个小镇现在归我统治」这类纯叙述
//    因此打中了酒吧保镖。
// 3. 敌人列表（原 :1244）不按场景过滤、目标选取（原 :1247）随机挑——玩家
//    换了场景，旧场景的敌人还会继续应战/被误伤。人已经在「加比的拖车房」，
//    仍连续播报「酒吧保镖 向你扑来」。
//
// 三条症状对应三条测试，见 game-session.ts 的 aliveEnemies() / pickTarget() /
// handleIntent 的 case "move"/"look" 注释。
//
// bun test src/__tests__/combat-escape-and-scene-scope.test.ts

import { describe, it, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};

/** Use ordinary module occupants, never a facade mutation, to establish a
 * combat round.  酒吧保镖 is in 维森酒吧; 菲碧·特里坎 is in 特里坎家. */
async function arena() {
  const session = new GameSession(`combat-escape-${Math.random()}`, "cosmic-horror", CFG, undefined, "调查员");
  await session.act("创建角色 investigator 甲");
  await session.act("加载模组 普瑞米尔的谷仓");
  expect(activateRegisteredGameSessionSceneForTest(session, "维森酒吧")).toBe(true);

  // Establish the combat flag through an actual missed attack, preserving the
  // fixtures' enemy HP assertions without retaining a public test mutator.
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  try {
    expect((await session.act("攻击 酒吧保镖")).error).toBeUndefined();
  } finally {
    Math.random = originalRandom;
  }
  return session;
}

function hpOf(session: GameSession, id: string): number {
  return session.world.getEntity(id)!.hp;
}

describe("症状 1 — 战斗中移动不该产生伤害（handleIntent 如实转发 tryResolveModuleScene 的返回值）", () => {
  it("正确行为：战斗中输入「去加比的拖车房」应该移动，不是攻击", async () => {
    const session = await arena();
    const localBefore = hpOf(session, "酒吧保镖");
    const remoteBefore = hpOf(session, "菲碧·特里坎");

    const res = await session.act("去加比的拖车房");

    expect(hpOf(session, "酒吧保镖")).toBe(localBefore);
    expect(hpOf(session, "菲碧·特里坎")).toBe(remoteBefore);
    // 真的移动成功了，不是掉进了叙事/战斗兜底
    expect(session.getState().scene).toBe("加比的拖车房");
    expect(res.narrative).not.toMatch(/检查d100|造成 \d+ 点伤害/);
    // ⚠ 光看"没掉血"不够精确：即使 handleIntent 仍然错误地把移动成功
    // 报成"没处理"，只要 combatActive 不再单独触发攻击（症状 2 的修复），
    // 也不会掉血——但那是从两个洞里漏出来又刚好互相抵消，不是真的接住了。
    // 移动真被 handleIntent 接住时，函数会在 case "move" 直接 return，
    // 不会再往下走到 LLM 叙事分支，这一路上不会有"守秘人"的旁白消息；
    // 一旦 case "move" 又开始无视返回值，这一步就会重新掉进叙事兜底，
    // 从这条断言上先变红。
    expect(res.events.some((e) => e.speaker === "守秘人")).toBe(false);
  });

  it("目标行为错误的对照：如果移动没接住，`攻击 食尸鬼` 这类明确攻击指令必须仍然造成伤害", async () => {
    // 防止「为了不误伤而把攻击也一起挡住」这种矫枉过正——明确的攻击指令
    // 必须继续正常工作。
    const session = await arena();
    const before = hpOf(session, "酒吧保镖");
    const real = Math.random;
    Math.random = () => 0; // 必中
    try {
      await session.act("攻击 酒吧保镖");
    } finally { Math.random = real; }
    expect(hpOf(session, "酒吧保镖")).toBeLessThan(before);
  });

  it("文本相似但合法：含「向」字的移动短语不该被误判成攻击", async () => {
    const session = await arena();
    const localBefore = hpOf(session, "酒吧保镖");
    const remoteBefore = hpOf(session, "菲碧·特里坎");
    await session.act("向加比的拖车房走去");
    expect(hpOf(session, "酒吧保镖")).toBe(localBefore);
    expect(hpOf(session, "菲碧·特里坎")).toBe(remoteBefore);
  });
});

describe("症状 2 — combatActive 不该单独构成攻击理由，非攻击意图要能从战斗里逃出去", () => {
  it("正确行为：纯叙述性暴走输入不产生伤害，战斗状态原样保留（不强制脱战）", async () => {
    const session = await arena();
    const localBefore = hpOf(session, "酒吧保镖");
    const remoteBefore = hpOf(session, "菲碧·特里坎");

    const res = await session.act("我点燃酒吧，夺走所有登记簿，宣布整个小镇现在归我统治");

    expect(hpOf(session, "酒吧保镖")).toBe(localBefore);
    expect(hpOf(session, "菲碧·特里坎")).toBe(remoteBefore);
    // ⚠ 只看这两个合成实体的血量不够精确："特里坎家"还住着模组自带的
    // 菲碧/米尔——如果 combatActive 又开始单独触发攻击判定，伤害完全可能
    // 落在 pickTarget 兜底选中的别的 NPC 身上，而不是我特意放来做断言的
    // 这两个实体，那样的话上面两条断言反而测不出问题。这里额外锁一条
    // "压根没有产生攻击判定"，不管打中的是谁。
    expect(res.events.some((e) => /检查d100|造成 \d+ 点伤害/.test(e.content))).toBe(false);
    // 战斗没有被这一句话强制结束——敌人还在，下一回合玩家应该还能打
    const beforeFollowup = hpOf(session, "酒吧保镖");
    const real = Math.random;
    Math.random = () => 0;
    try {
      await session.act("攻击 酒吧保镖");
    } finally {
      Math.random = real;
    }
    expect(hpOf(session, "酒吧保镖")).toBeLessThan(beforeFollowup);
  });

  it("目标行为错误的对照：明确的攻击指令在 combatActive 为真时必须仍然生效", async () => {
    const session = await arena();
    const before = hpOf(session, "酒吧保镖");
    const real = Math.random;
    Math.random = () => 0;
    try {
      await session.act("攻击 酒吧保镖");
    } finally { Math.random = real; }
    expect(hpOf(session, "酒吧保镖")).toBeLessThan(before);
  });

  it("文本相似但合法：含「对」字但不是攻击句式的输入不该误报成攻击", async () => {
    const session = await arena();
    const localBefore = hpOf(session, "酒吧保镖");
    const remoteBefore = hpOf(session, "菲碧·特里坎");
    const res = await session.act("我们对这里的情况感到疑惑");
    expect(hpOf(session, "酒吧保镖")).toBe(localBefore);
    expect(hpOf(session, "菲碧·特里坎")).toBe(remoteBefore);
    expect(res.events.some((e) => /检查d100|造成 \d+ 点伤害/.test(e.content))).toBe(false);
  });
});

/**
 * "特里坎家"/"维森酒吧" 都是模组里真实住人的场景（菲碧·特里坎、米尔·特里坎、
 * 酒吧保镖……），泛指的"攻击"在场上有多个候选时会落到 `pickTarget` 的
 * `enemies[0]` 兜底，具体打中谁取决于对象遍历顺序——那是 `pickTarget` 自己
 * 的既有语义（找不到/没给名字就打第一个），不是本轮要测的东西。
 *
 * 场景隔离测试专门挑一个模组里没有安排任何 NPC 的场景（"加比的拖车房"，
 * 只有线索没有人）放本地敌人，确保"泛指攻击打中了谁"不会有歧义；异场景
 * 敌人改用不与任何模组 NPC 重名的名字，避免"报出确切名字"这条用例意外
 * 撞上同名的真实 NPC。
 */
async function sceneScopeArena() {
  const session = new GameSession(`scene-scope-${Math.random()}`, "cosmic-horror", CFG, undefined, "调查员");
  await session.act("创建角色 investigator 甲");
  await session.act("加载模组 普瑞米尔的谷仓");
  expect(activateRegisteredGameSessionSceneForTest(session, "特里坎家")).toBe(true);

  // As above, real action semantics own combat state; a miss keeps the
  // scene-scope fixture's initial enemy HP deterministic.
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  try {
    expect((await session.act("攻击 菲碧·特里坎")).error).toBeUndefined();
  } finally {
    Math.random = originalRandom;
  }
  return session;
}

describe("症状 3 — 敌人列表按场景过滤，目标选取尊重 intent.target，不跨场景残留", () => {
  it("正确行为：站在「加比的拖车房」，泛指的「攻击」只能打中同场景的本地怪物，异场景的看守者毫发无伤", async () => {
    const session = await sceneScopeArena();
    const remoteBefore = hpOf(session, "酒吧保镖");
    const localBefore = hpOf(session, "菲碧·特里坎");
    const real = Math.random;
    Math.random = () => 0; // 必中，排除随机性
    try {
      await session.act("攻击");
    } finally { Math.random = real; }
    // 异场景的敌人不该被影响——本地场景只有一个候选，没有歧义
    expect(hpOf(session, "酒吧保镖")).toBe(remoteBefore);
    expect(hpOf(session, "菲碧·特里坎")).toBeLessThan(localBefore);
  });

  it("目标行为错误的对照：换到「维森酒吧」、指名打「异地看守者」，伤害必须落在看守者身上而不是拖车房的本地怪物", async () => {
    const session = await sceneScopeArena();
    expect(activateRegisteredGameSessionSceneForTest(session, "维森酒吧")).toBe(true);
    const localBefore = hpOf(session, "菲碧·特里坎");
    const remoteBefore = hpOf(session, "酒吧保镖");
    const real = Math.random;
    Math.random = () => 0;
    try {
      await session.act("攻击 酒吧保镖");
    } finally { Math.random = real; }
    expect(hpOf(session, "菲碧·特里坎")).toBe(localBefore); // 特里坎家的 NPC 没被影响
    expect(hpOf(session, "酒吧保镖")).toBeLessThan(remoteBefore); // 看守者被打中
  });

  it("文本相似但合法：报出异场景敌人的确切名字也不能跨场景误伤——只会打中当前场景里实际存在的敌人", async () => {
    const session = await sceneScopeArena();
    // 站在"特里坎家"，却指名要打"酒吧保镖"（在维森酒吧，不在这里）
    const remoteBefore = hpOf(session, "酒吧保镖");
    const localBefore = hpOf(session, "菲碧·特里坎");
    const real = Math.random;
    Math.random = () => 0;
    try {
      await session.act("攻击 酒吧保镖");
    } finally { Math.random = real; }
    // 报的名字跨场景，看守者不该被打中
    expect(hpOf(session, "酒吧保镖")).toBe(remoteBefore);
    // pickTarget 名字对不上时回退到当前场景第一个敌人——落到本地怪物身上
    // （本地场景只有一个候选，不存在歧义），而不是干脆谁都不打
    expect(hpOf(session, "菲碧·特里坎")).toBeLessThan(localBefore);
  });
});
