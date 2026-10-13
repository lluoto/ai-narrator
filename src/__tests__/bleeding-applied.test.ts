// 流血是**怎么挂上去的** —— 之前只验过挂上之后每轮扣血（bleeding-runtime），
// 没验过「什么情况下才挂」。而那正是按 CoC 口径改动的地方。
//
// ⚠ 这个文件第一版四条全绿，但全是空的：我写了 `if (hasMajor) expect(...)`，
//   而实跑打印显示重伤**根本没触发**，status 一直是空数组 ——
//   条件保护把「这条路走不到」盖住了。查下去才发现真正的病：
//   `handleAttack` 抢在带 `checkMajorWound` 的那段代码前面 return，
//   重伤/流血/昏迷在真实对局里一次都没生效过。
//   所以这里的断言都是**无条件**的。

import { describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";
import type { WorldEntity } from "../types";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};

type Ent = WorldEntity;

/**
 * 钉住随机序列走完一次攻击。
 * 消耗顺序：命中骰 → 伤害骰 → checkMajorWound 的 [部位, 骨折, 昏迷]。
 */
async function attack(seq: number[], hp: number, extra?: Ent[], input = "攻击 怪物") {
  const s = new GameSession(
    `bl-${Math.random()}`,
    "cosmic-horror",
    CFG,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "preferred",
    { careerEntryPersistence: "transient" },
  );
  restoreSignedOrdinaryWorld(s, CFG, (world) => {
    world.upsertEntity({ id: "mon1", name: "怪物", type: "monster", hp, maxHp: hp, ac: 10, status: [], position: "tavern" });
    for (const entity of extra ?? []) world.upsertEntity(entity);
  });
  const real = Math.random;
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)]!;
  try {
    await s.act(input);
    return s.world.getCurrentState().entities;
  } finally {
    Math.random = real;
    s.close();
  }
}

const CRIT_MAJOR = [0, 0, 0.5, 0.9]; // 暴击 6 点伤害 + 部位躯干 + 不骨折

describe("重伤结算要真的发生在玩家走的那条路上", () => {
  test("**错误行为的红线**：打出重伤就必须挂上重伤状态", async () => {
    // 改之前这里是空数组 —— `handleAttack` 先 return，带 checkMajorWound 的
    // 那段代码永远到不了。重伤/流血/昏迷一次都没生效过。
    const e = (await attack([...CRIT_MAJOR, 0.9], 10))["mon1"]!;
    expect(e.hp).toBe(4);
    expect(e.status.some((x) => x.startsWith("重伤:"))).toBe(true);
  });

  test("**正确**：重伤但没打昏 → 不流血", async () => {
    // 昏迷判定是 `Math.random() < 0.4`，给 0.9 → 不昏迷。
    // 改之前必然流血（`const bleeding = true`），这是 CoC 口径那一修。
    const st = (await attack([...CRIT_MAJOR, 0.9], 10))["mon1"]!.status;
    expect(st.some((x) => x.startsWith("重伤:"))).toBe(true);
    expect(st.some((x) => x.startsWith("流血"))).toBe(false);
    expect(st.some((x) => x.startsWith("昏迷"))).toBe(false);
  });

  test("**正确**：重伤且打昏 → 流血和昏迷都挂上，且都带时限", async () => {
    const st = (await attack([...CRIT_MAJOR, 0.1], 10))["mon1"]!.status;
    expect(st.some((x) => x.startsWith("重伤:"))).toBe(true);
    // 裸标签「流血」是改之前的形态：既不生效也不消失。必须带回合数。
    expect(st.find((x) => x.startsWith("流血"))).toMatch(/\d+\s*回合/);
    expect(st.find((x) => x.startsWith("昏迷"))).toMatch(/\d+\s*回合/);
  });

  test("**干扰输入**：够不上重伤阈值时，一个状态都不挂", async () => {
    // 同样 6 点伤害，但最大 HP 40 → 阈值 20，差得远。
    const e = (await attack([...CRIT_MAJOR, 0.1], 40))["mon1"]!;
    expect(e.hp).toBe(34);
    expect(e.status).toEqual([]);
  });
});

describe("攻击要打指定的目标", () => {
  const other: Ent = {
    id: "mon2", name: "野狗", type: "monster",
    hp: 40, maxHp: 40, ac: 10, status: [], position: "tavern",
  };

  test("**错误行为的红线**：场上两个敌人时，不能随机砍一个", async () => {
    // 原先是 `enemies[Math.floor(Math.random() * enemies.length)]` —— 无视
    // intent.target。「攻击野狗」有一半概率砍在怪物身上，播报还写着野狗。
    const ents = await attack([...CRIT_MAJOR, 0.9], 10, [other], "攻击 野狗");
    expect(ents["mon2"]!.hp).toBe(34);
    expect(ents["mon1"]!.hp).toBe(10); // 没被误伤
  });

  test("**干扰输入**：目标名认不出来时，不能崩，也不能谁都不打", async () => {
    const ents = await attack([...CRIT_MAJOR, 0.9], 10, [other], "攻击 查无此敌");
    const total = ents["mon1"]!.hp + ents["mon2"]!.hp;
    expect(total).toBeLessThan(50); // 打中了某一个
  });
});
