// 开发 A · 任务 2 验收 —— isClueFound / isSceneVisited 两个队伍视图谓词。
//
// 语义：队伍里**任一人**发现过 / 到过就算。这两个谓词从任务 1 迁进真相源
// 的按玩家记录（clue_discoveries / scene_visits）聚合导出，聚合方向不可
// 反过来——按玩家的记录才是权威。
//
// bun test src/__tests__/party-view-predicates.test.ts

import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import { GameSession } from "../api/game-session";

const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

function makeSession(): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession("party-view-test", "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, "investigator", "调查员", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
}

let session: GameSession;

beforeEach(() => {
  session = makeSession();
});

afterEach(() => session.close());

describe("isClueFound —— 队伍里任一人发现过就算", () => {
  it("没人发现过时为 false", () => {
    expect(session.isClueFound("clue_shared")).toBe(false);
  });

  it("即使是别的玩家（不是 activePlayerId）发现的，也算队伍发现了", async () => {
    const added = session.addPartyMember("Bea", "investigator");
    if ("rejected" in added) throw new Error(added.rejected);
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect((await session.act("前往 加比的拖车房", added.member.pcId)).error).toBeUndefined();
    const realRandom = Math.random;
    Math.random = () => 0;
    try {
      expect((await session.act("检查餐厅", added.member.pcId)).error).toBeUndefined();
    } finally {
      Math.random = realRandom;
    }
    expect(session.isClueFound("clue_card")).toBe(true);
    // p2 未必是当前 activePlayerId（默认 p1），验证的正是"任一人"这个语义
    expect((await session.act("状态", "p1")).error).toBeUndefined();
    expect(session.activePlayerId).not.toBe(added.member.pcId);
  });
});

describe("isSceneVisited —— 队伍里任一人到过就算", () => {
  it("没人去过时为 false", async () => {
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect(session.isSceneVisited("加比的拖车房")).toBe(false);
  });

  it("移动过去之后为 true", async () => {
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect((await session.act("前往 加比的拖车房")).error).toBeUndefined();
    expect(session.isSceneVisited("加比的拖车房")).toBe(true);
  });
});
