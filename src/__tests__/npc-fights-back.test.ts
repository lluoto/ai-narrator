// 敌人要还手。
//
// 起因：实测在这条路上打十回合，**玩家 9/9 一滴血没掉**，怪物只挨打。
// 也就是说这一轮修好的重伤判定、流血、致残描写，全都只对怪物生效 ——
// 玩家永远不会受伤，战斗没有风险。
//
// CLI 一直有 `resolveNPCAction()`（index.ts:750），走共用的律书
// `rules.adjudicateAttack`。这里调同一个入口，不另写一份判定。
//
// 连带修了一面旗：`combatActive = true` 原先只写在 `act()` 里那段被意图派发
// 遮死的代码中，于是它在真实路径上**永远是 false**，
// `getSuggestions()` 打起来了还在提示「调查四周 / 与 NPC 交流」。

import { afterEach, describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};

type Ent = { id: string; name: string; type: string; hp: number; maxHp: number; ac: number; status: string[]; position: string; scene_id?: string };
type S = {
  world: { getCurrentState: () => { scene: string; entities: Record<string, Ent> } };
  activeCharacter: { hp: number; maxHp: number };
  activePlayerId: string;
  combatActive: boolean;
};

const sessions: GameSession[] = [];
afterEach(() => {
  while (sessions.length) sessions.pop()!.close();
});

async function arena(enemyHp = 200) {
  const source = new GameSession(`fb-${Math.random()}`, "cosmic-horror", CFG, "investigator", "甲");
  const s = new GameSession(source.id, "cosmic-horror", CFG);
  try {
    restoreSignedOrdinaryWorld(s, CFG, (world) => {
      const scene = world.getCurrentState().scene;
      world.upsertEntity({
        id: "m1", name: "食尸鬼", type: "monster", hp: enemyHp, maxHp: enemyHp,
        ac: 0, status: [], position: scene, scene_id: scene,
      });
    }, source);
  } finally {
    source.close();
  }
  sessions.push(s);
  return { s, a: s as unknown as S };
}

function npcCounterhitRandom(): () => number {
  // Encounter SAN check/loss, player fumble and miss narration, NPC critical,
  // player dodge fumble, NPC leg hit, NPC narration, then a non-lethal major
  // wound. This remains deterministic under dodge-tie semantics.
  const values = [0, 0, 0.99, 0, 0, 0.99, 0, 0, 0, 0.99, 0.99];
  let index = 0;
  // After one verified hit, let all subsequent rounds miss. This leaves the
  // player alive for the world-entity synchronization assertion.
  return () => values[index++] ?? 0.99;
}

describe("战斗要有来有回", () => {
  test("**错误行为的红线**：打十回合，玩家不能一滴血都不掉", async () => {
    // ⚠ 第一版没钉随机数，全量里红过一次。算了一下：NPC 命中率约三成，
    //   十回合全部落空约 2.8% —— 三十几次跑就会红一次。
    //   偶发红的测试会训练人把红当噪声，所以钉死骰子。
    const { s, a } = await arena();
    const before = a.activeCharacter.hp;
    const real = Math.random;
    Math.random = npcCounterhitRandom();
    try {
      for (let i = 0; i < 10; i++) await s.act("攻击 食尸鬼");
    } finally { Math.random = real; }
    expect(a.activeCharacter.hp).toBeLessThan(before);
  }, 30_000);

  test("**正确**：玩家的血量和世界实体保持一致", async () => {
    // 两处各存一份血量，不同步的话角色卡和世界会各说各话。
    const { s, a } = await arena();
    const real = Math.random;
    Math.random = npcCounterhitRandom();
    try {
      for (let i = 0; i < 5; i++) await s.act("攻击 食尸鬼");
    } finally { Math.random = real; }
    // 世界实体的真实 id 是 activePlayerId（单人局默认 "p1"），不是
    // "player"——那是本轮修的 bug，读写不一致时这条断言曾经悄悄测的是
    // 一个空对象。
    const playerEnt = a.world.getCurrentState().entities[a.activePlayerId];
    expect(playerEnt).toBeDefined();
    // 先确认「确实挨过打」—— 否则两边都是满血，这条断言在
    // 「根本没人还手」的实现下也成立，等于没测。（变异检验就是这么发现的。）
    expect(playerEnt!.hp).toBeLessThan(playerEnt!.maxHp);
    expect(a.activeCharacter.hp).toBe(playerEnt!.hp);
  }, 30_000);

  test("**错误行为的红线**：战斗中 combatActive 要立起来", async () => {
    // 原先这面旗只在被遮死的代码里置真，真实路径上永远 false。
    const { s, a } = await arena();
    expect(a.combatActive).toBe(false);
    await s.act("攻击 食尸鬼");
    expect(a.combatActive).toBe(true);
  }, 20_000);

  test("**正确**：敌人全倒下就退出战斗", async () => {
    // 旗立起来就要放得下，否则打完了界面还停在战斗态。
    // ⚠ 攻击是 50% 命中，不钉住随机数这条会偶发红 —— 第一版就是这么红的：
    //   敌人只有 1 HP，但那一击没打中，于是战斗没结束。
    //   随机量上的断言要么钉住，要么别测。
    const { s, a } = await arena(1);
    const real = Math.random;
    Math.random = () => 0; // 掷 1 → 暴击必中
    try { await s.act("攻击 食尸鬼"); } finally { Math.random = real; }
    expect(a.combatActive).toBe(false);
  }, 20_000);

  test("**干扰输入**：场上没有敌人时不该有人还手", async () => {
    const s = new GameSession(
      `fb-${Math.random()}`,
      "cosmic-horror",
      CFG,
      "investigator",
      "甲",
      undefined,
      undefined,
      undefined,
      "preferred",
      { careerEntryPersistence: "transient" },
    );
    const a = s as unknown as S;
    const before = a.activeCharacter.hp;
    await s.act("攻击 怪物");
    expect(a.activeCharacter.hp).toBe(before);
    expect(a.combatActive).toBe(false);
  }, 20_000);

  test("**正确**：玩家倒下后不再继续挨打", async () => {
    const { s, a } = await arena();
    for (let i = 0; i < 40; i++) await s.act("攻击 食尸鬼");
    expect(a.activeCharacter.hp).toBeGreaterThanOrEqual(0); // 不会掉成负数
  }, 60_000);
});
