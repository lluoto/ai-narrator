// KP 切场景后，「此刻这里有谁、有什么可查」必须跟着界面显示的场景走。
//
// KP 切场景只翻 scenes.is_active，玩家实体的 position 原地不动——这是既定设计，
// scene-bgm.test.ts 里专门锁住了这一点。但在场 NPC 过滤与场景线索查找当时读的是
// 玩家位置，于是面板显示教堂、站在里面的却是码头的 NPC，调查也还在旧房间里找。
//
// 两个真相源都保留，各司其职：显示的场景回答「现在演到哪」，玩家实体位置留给
// 实体摆放。凡是回答「此刻这里有什么」的地方都跟前者。
//
// bun test src/__tests__/kp-scene-truth.test.ts

import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import { GameSession } from "../api/game-session";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 1024,
  temperature: 0.7,
};

let session: GameSession;

beforeEach(() => {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const source = new GameSession("kp-scene-truth", "cosmic-horror", LLM, "investigator", "调查员");
  session = new GameSession(source.id, "cosmic-horror", LLM);
  restoreSignedOrdinaryWorld(session, LLM, (world) => {
    world.registerScene("docks", "码头");
    world.registerScene("church", "教堂");
    world.registerScene("地下室", "地下室");
    world.upsertEntity({
      id: "priest", name: "神父", type: "npc",
      hp: 10, maxHp: 10, ac: 10, status: [], position: "church",
    });
    world.upsertEntity({
      id: "sailor", name: "水手", type: "npc",
      hp: 10, maxHp: 10, ac: 10, status: [], position: "docks",
    });
  }, source);
  source.close();
  activateRegisteredGameSessionSceneForTest(session, "docks");
  // 玩家先正常移动过一次：移动流程会留下一个 PC 实体钉住玩家位置
  // （movePlayerToScene 的写法，scene-bgm.test.ts 同样这么造）。
  // 分叉正是从这时起——在此之前 getPlayerPosition() 没有实体可读，
  // 会回落到显示的场景，看不出问题。
  //
  // ⚠ id 这里手写成 "player" 只是这条测试自己的道具，不代表真实实体
  // id——真实实体 id 是 activePlayerId（单人局默认 "p1"）。这份测试只
  // 断言"在场判定跟着 getDisplayedScene() 走"，不读这个实体的 id，
  // 写成什么字符串都不影响结论，但别被这个字面量误导成"player"是
  // 真实约定。
});

afterEach(() => session.close());

describe("KP 切场景后的在场判定", () => {
  it("新场景里的 NPC 出现在面板上", () => {
    activateRegisteredGameSessionSceneForTest(session, "church");

    expect(session.getState().npcs.map(n => n.name)).toContain("神父");
  });

  it("旧场景里的 NPC 不再出现在面板上", () => {
    activateRegisteredGameSessionSceneForTest(session, "church");

    expect(session.getState().npcs.map(n => n.name)).not.toContain("水手");
  });

  it("有声明来源的场景线索可以被调查到", async () => {
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect(activateRegisteredGameSessionSceneForTest(session, "加比的拖车房")).toBe(true);
    const real = Math.random;
    Math.random = () => 0;
    try {
      expect((await session.act("检查餐厅")).error).toBeUndefined();
    } finally {
      Math.random = real;
    }
    expect(session.world.getCluesDiscoveredBy(session.activePlayerId).length).toBeGreaterThan(0);
  });
});
