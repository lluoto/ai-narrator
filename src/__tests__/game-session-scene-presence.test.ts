// 场景状态 — getState() 暴露给前端/API 的场景与在场名单。
//
// 回归背景 1（在场过滤）：模组加载后所有 NPC 都被写入世界状态，getState() 未按场景过滤，
// 导致「前往警察局」时返回的 npcs 里同时含有菲碧、加比、酒吧保镖等根本不在场的角色。
// 这会让前端在场名单与 KP 叙事（injectWorldModelForScene 已按场景过滤）相互矛盾。
//
// 回归背景 2（KP 切换场景无效）：setScene() 曾写 `world.getCurrentState().scene = id`，
// 而 getCurrentState() 每次都新建并返回一个对象，赋值落在临时对象上、随即被丢弃，
// 数据库中的 scenes.is_active 从未变更。KP 面板点「切换」后端照样返回 success:true，
// 前端场景纹丝不动，且没有任何报错。正确写法是 world.setActiveScene()。
//
// 在场判定的真相源是**界面显示的场景**，不是玩家实体的 position。KP 切场景只改前者、
// 不动后者（既定设计，见 scene-bgm.test.ts），而玩家一旦移动过，移动流程会留下一个
// "player" 实体把 position 钉在原地。若在场名单读 position，KP 切场景后就再也带不动它，
// 正是上面回归背景 1 要防的「名单与 KP 叙事矛盾」——injectWorldModelForScene 读的是
// 显示的场景。两边必须同源。

import { describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const LLM = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};

async function barnSession(id: string): Promise<GameSession> {
  const session = new GameSession(id, "cosmic-horror", LLM, "investigator", "Scene Tester");
  expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
  return session;
}

describe("场景在场过滤", () => {
  test("getState().npcs 只包含当前场景的 NPC", async () => {
    const session = await barnSession("t_presence_npc");
    try {
      expect(activateRegisteredGameSessionSceneForTest(session, "特里坎家")).toBe(true);
      const names = session.getState().npcs.map((npc) => npc.name);

      expect(names).toContain("菲碧·特里坎");
      expect(names).not.toContain("酒吧保镖");
    } finally { session.close(); }
  });

  test("getState().monsters 只包含当前场景的怪物", async () => {
    const session = await barnSession("t_presence_monster");
    try {
      expect(activateRegisteredGameSessionSceneForTest(session, "下水道")).toBe(true);
      const names = session.getState().monsters.map((monster) => monster.name);

      expect(names).toContain("食尸鬼");
      expect(names).not.toContain("Mi-Go");
    } finally { session.close(); }
  });

  test("场景切换后在场名单随之切换", async () => {
    const session = await barnSession("t_presence_move");
    try {
      expect(activateRegisteredGameSessionSceneForTest(session, "特里坎家")).toBe(true);
      expect(session.getState().npcs.map((npc) => npc.name)).toContain("菲碧·特里坎");
      expect(session.getState().npcs.map((npc) => npc.name)).not.toContain("酒吧保镖");

      expect(activateRegisteredGameSessionSceneForTest(session, "维森酒吧")).toBe(true);
      expect(session.getState().npcs.map((npc) => npc.name)).toContain("酒吧保镖");
      expect(session.getState().npcs.map((npc) => npc.name)).not.toContain("菲碧·特里坎");
    } finally { session.close(); }
  });
});

describe("KP 切换场景", () => {
  test("切换到已注册场景后 getState().scene 随之变更", async () => {
    const session = await barnSession("t_kp_scene_ok");
    try {
      expect(activateRegisteredGameSessionSceneForTest(session, "建筑内")).toBe(true);
      expect(session.getState().scene).toBe("建筑内");
    } finally { session.close(); }
  });

  test("切换到未注册场景应报告失败，而不是静默成功", async () => {
    const session = await barnSession("t_kp_scene_missing");
    try {
      expect(activateRegisteredGameSessionSceneForTest(session, "建筑内")).toBe(true);
      expect(activateRegisteredGameSessionSceneForTest(session, "never_registered")).toBe(false);
      // 失败不得污染当前场景
      expect(session.getState().scene).toBe("建筑内");
    } finally { session.close(); }
  });

  test("连续切换以最后一次为准，不残留先前场景的在场名单", async () => {
    const session = await barnSession("t_kp_scene_switch");
    try {
      expect(activateRegisteredGameSessionSceneForTest(session, "特里坎家")).toBe(true);
      expect(activateRegisteredGameSessionSceneForTest(session, "维森酒吧")).toBe(true);

      expect(session.getState().scene).toBe("维森酒吧");
      expect(session.getState().npcs.map((npc) => npc.name)).toContain("酒吧保镖");
      expect(session.getState().npcs.map((npc) => npc.name)).not.toContain("菲碧·特里坎");
    } finally { session.close(); }
  });
});
