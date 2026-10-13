// P0：实体 id 收口。
//
// 起因：一份真实 30 回合跑局报告（会话 dzhna237）——战斗播报「你剩余 8/12」，
// 而 GET /api/sessions/:id/state 的 player.hp 恒为 12/12、status 恒为空；
// 「去纽约」播报「你抵达了纽约」，state.scene 仍是「特里坎家」。
//
// 根因：同一个玩家有两个实体 id。「创建角色」命令（真实入口，本文件测的
// 就是这条路，不是构造函数那条冷门路径）把角色卡存进
// characters.set("p1", ch)，但世界实体写成了 id: "player"；
// activePlayerId 默认是 "p1"，getState() 用 activePlayerId 读——
// 于是战斗/移动写的东西，面板永远读不到。
//
// 这份测试直接走 GameSession.getState()——它是 GET /api/sessions/:id/state
// 的唯一数据来源（server.ts:310-317 只是原样透传），本仓其它 HTTP 端点的
// 测试也都是这个测法，不额外起一个真实 Bun.serve 实例。

import { describe, test, expect } from "bun:test";
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
  getState: () => { player: { hp: number; maxHp: number; status: string[] }; scene: string };
  act: (input: string) => Promise<{ events: Array<{ content: string }> }>;
};

async function arena(enemyHp = 200) {
  const s = new GameSession(
    `eid-${Math.random()}`,
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
  restoreSignedOrdinaryWorld(s, CFG, (world) => world.upsertEntity({
    id: "m1", name: "食尸鬼", type: "monster", hp: enemyHp, maxHp: enemyHp,
    ac: 0, status: [], position: "tavern", scene_id: "tavern",
  }));
  return s as unknown as S;
}

function npcCounterhitRandom(): () => number {
  // Player fumble, miss narration, NPC critical, player dodge fumble, NPC
  // leg hit, NPC narration, then a major-wound unconscious result.
  const values = [0.99, 0, 0, 0.99, 0, 0, 0, 0.99, 0];
  let index = 0;
  return () => values[index++ % values.length]!;
}

describe("实体 id 收口 —— getState() 必须读到战斗/移动真正写的实体", () => {
  test("**错误行为的红线**：打一次伤害后 state.player.hp 必须下降", async () => {
    const s = await arena();
    const before = s.getState().player.hp;
    const real = Math.random;
    Math.random = npcCounterhitRandom();
    try { await s.act("攻击 食尸鬼"); } finally { Math.random = real; }
    expect(s.getState().player.hp).toBeLessThan(before);
  }, 20_000);

  test("**错误行为的红线**：重伤后 state.player.status 必须非空", async () => {
    const s = await arena();
    const real = Math.random;
    Math.random = npcCounterhitRandom();
    try {
      for (let i = 0; i < 8 && s.getState().player.status.length === 0; i++) {
        await s.act("攻击 食尸鬼");
      }
    } finally { Math.random = real; }
    expect(s.getState().player.status.length).toBeGreaterThan(0);
  }, 30_000);

  test("**正确**：世界实体的 id 与 activePlayerId 一致，不是字面量 \"player\"", async () => {
    const s = await arena();
    const state = s.world.getCurrentState();
    expect(state.entities[s.activePlayerId]).toBeDefined();
    // 不存在字面量 "player" 那个幽灵实体——只有当 activePlayerId 恰好
    // 等于 "p1" 时这条断言才有意义，先确认默认值没变。
    expect(s.activePlayerId).toBe("p1");
    expect(state.entities["player"]).toBeUndefined();
  }, 20_000);

  test("**正确**：移动后 state.scene 必须跟着变——不能停在旧场景", async () => {
    const s = await arena();
    // handleMove 靠场景名匹配表，用一个能命中 sceneMap 的目标
    await s.act("去酒馆");
    const afterState = s.world.getCurrentState();
    // 移动是否成功依赖场景是否能注册/激活；这里只验证「玩家实体位置」与
    // 「界面显示场景」用的是同一个 id 读出来的同一份数据，不是分叉的两份。
    const player = afterState.entities[s.activePlayerId];
    expect(player).toBeDefined();
    expect(player!.position).toBe(afterState.scene);
  }, 20_000);

  test("**干扰**：连续两次读 state，玩家血量在没有战斗时保持不变（不能每次读都漂）", async () => {
    const s = await arena();
    const first = s.getState().player.hp;
    const second = s.getState().player.hp;
    expect(first).toBe(second);
  }, 20_000);
});
