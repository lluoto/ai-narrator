// todo-24：PlayerSlot.currentScene 永不更新。
//
// 背景：唯一能更新它的 setPlayerScene（player-session.ts）全仓零调用方，
// 从 join() 那一刻起就再没变过——scene_restricted 可见性判定与
// getPlayersInScene() 因此永远读到入场时的旧场景。真正会随移动更新的
// 场景数据早就存在（WorldEntity.position，GameSession.movePlayerToScene
// 等每次移动都会 world.upsertEntity 写回），本轮删掉 PlayerSlot.currentScene
// 这份必然漂移的拷贝，两个读取点（push() 的 scene_restricted 分支、
// getPlayersInScene()）改成按 characterId 问权威来源（PlayerSession 构造
// 函数新增的 sceneOf 注入）。
//
// bun test src/__tests__/player-scene-authority.test.ts

import { describe, it, expect } from "bun:test";
import { GameSession } from "../api/game-session";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

async function twoPcArena() {
  const session: any = new GameSession(`scene-auth-${Math.random()}`, "cosmic-horror", CFG, undefined, "调查员", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  await session.act("创建角色 investigator 甲"); // p1
  await session.act("创建队友 乙 investigator"); // p2
  await session.act("加载模组 普瑞米尔的谷仓");
  return session as GameSession & Record<string, any>;
}

describe("todo-24：getPlayersInScene 按权威来源（WorldEntity.position）取场景，不再读一份不会更新的拷贝", () => {
  it("**正确**：p1 移动后，getPlayersInScene(p1 的新场景) 能找到 p1，找不到还没动的 p2", async () => {
    const s = await twoPcArena();
    const res = await s.act("去加比的拖车房", "p1");
    expect(res.error).toBeUndefined();
    const sceneId = s.getState().scene; // 移动后真正落到的场景 id（不猜具体拼写）

    const here = s.session.getPlayersInScene(sceneId);
    const names = here.map((p: any) => p.name);
    expect(names).toContain("p1");
    expect(names).not.toContain("p2"); // p2 还在初始场景，没跟着挪
  });

  it("**目标行为错误的对照**：p2 也移动到同一场景后，getPlayersInScene 应该同时包含两人——不是只认第一个动过的玩家", async () => {
    const s = await twoPcArena();
    await s.act("去加比的拖车房", "p1");
    const sceneId = s.getState().scene;
    const res2 = await s.act("去加比的拖车房", "p2");
    expect(res2.error).toBeUndefined();

    const here = s.session.getPlayersInScene(sceneId);
    const names = here.map((p: any) => p.name).sort();
    expect(names).toEqual(["p1", "p2"]);
  });

  it("**错误行为红线**：p1 再移动到别的场景后，旧场景的 getPlayersInScene 不应该继续把 p1 算进去——场景数据必须跟着最新一次移动变，不是钉死在第一次移动的位置", async () => {
    const s = await twoPcArena();
    await s.act("去加比的拖车房", "p1");
    const firstSceneId = s.getState().scene;
    await s.act("去特里坎家", "p1");
    const secondSceneId = s.getState().scene;
    expect(secondSceneId).not.toBe(firstSceneId);

    const stillInFirst = s.session.getPlayersInScene(firstSceneId).map((p: any) => p.name);
    expect(stillInFirst).not.toContain("p1");
    const inSecond = s.session.getPlayersInScene(secondSceneId).map((p: any) => p.name);
    expect(inSecond).toContain("p1");
  });

  it("**文本相似但合法**：getPlayerScene(name) 直接查询也反映最新移动，不是入场时的初始值", async () => {
    const s = await twoPcArena();
    const before = s.session.getPlayerScene("p1");
    await s.act("去加比的拖车房", "p1");
    const after = s.session.getPlayerScene("p1");
    expect(after).not.toBe(before);
    expect(after).toBe(s.getState().scene);
  });
});
