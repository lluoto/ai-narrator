// 开发·对象名通向线索 任务2验收——歧义回问不再剧透。
//
// 背景：resolveSceneClueMatch 命中多条候选时，回问原文直接列出候选的
// 展示名——"你想找什么？这里可能有：「冰箱与储物柜」、「中控台拉杆」——
// 说清楚一点。"实跑真的打出过这句。行动锚点那轮专门定过"中"粒度（告诉
// 玩家有东西、不说是什么），并有剧透红线判据（scene-suggestions.test.ts）
// ——同一份信息（未发现线索名字），两条路却是两套标准：锚点守住了，
// 这条没守。本轮用同一条标准统一。
//
// bun test src/__tests__/clue-ask-no-spoiler.test.ts

import { describe, it, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { BARN_OF_PREMIER } from "../module/barn-of-premier";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 128, temperature: 0,
};

function makeSession(id: string): GameSession & Record<string, any> {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession(id, "cosmic-horror", CFG, "investigator", "甲") as any;
}

const controlRoom = BARN_OF_PREMIER.scenes.find((s) => s.id === "中控室")!;
const maintenanceRoom = BARN_OF_PREMIER.scenes.find((s) => s.id === "维修间")!;

describe("歧义回问不含任何未发现线索的名字", () => {
  it("端到端：真实的中控室歧义（陆川去翻中控室的储物柜）触发回问，回问文本不含任何候选的 id/展示名", async () => {
    const session = makeSession(`ask-no-spoiler-${Math.random()}`);
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("中控室");

    const res = await session.act("陆川去翻中控室的储物柜", "p1");
    const text = res.events.map((e) => e.content).join("\n");

    // 与 scene-suggestions.test.ts 剧透判据同一条标准：对场景里每条
    // 未发现线索，id 与 displayName 都不能出现在玩家能看到的文本里。
    for (const clue of controlRoom.clues) {
      expect(text).not.toContain(clue.id);
      expect(text).not.toContain(clue.name);
    }
    // 揭示文本本身也不能提前泄露（措辞层面的双重保险）
    expect(text).not.toContain("氧气罐");
    expect(text).not.toContain("拉下开关");
    // 但确实告诉了玩家"不止一样东西，说清楚点"——不是什么都不说
    expect(text).toContain("不止一样东西");
  });

  it("端到端：真实维修间的歧义同样不泄露展示名", async () => {
    const session = makeSession(`ask-no-spoiler-maintenance-${Math.random()}`);
    await session.act("加载模组 普瑞米尔的谷仓");
    expect(activateRegisteredGameSessionSceneForTest(session, "维修间")).toBe(true);

    const res = await session.act("打开那口像冰箱一样的棺材", "p1");
    const text = res.events.map((e) => e.content).join("\n");
    for (const clue of maintenanceRoom.clues) {
      expect(text).not.toContain(clue.id);
      expect(text).not.toContain(clue.name);
    }
    expect(text).toContain("不止一样东西");
  });
});

describe("玩家仍能据此说得更具体并成功", () => {
  it("端到端：收到回问后，用更具体的对象名再说一次，能精确命中并真正发现线索", async () => {
    const session = makeSession(`ask-then-specific-${Math.random()}`);
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("中控室");

    const real = Math.random;
    Math.random = () => 0;
    try {
      const askRes = await session.act("陆川去翻中控室的储物柜", "p1");
      expect(askRes.narrative).toBe("需要说清楚具体想搜哪里/什么");
      expect(session.investigation.isDiscoveredBy("clue_control_supplies", "p1")).toBe(false);

      // 玩家凭场景本身已知的物件名（不是靠回问文案透的）说得更具体。
      const followUp = await session.act("冰箱", "p1");
      expect(followUp.narrative).not.toBe("需要说清楚具体想搜哪里/什么");
      expect(session.investigation.isDiscoveredBy("clue_control_supplies", "p1")).toBe(true);
    } finally { Math.random = real; }
  });
});

describe("与行动锚点用同一条剧透标准——两处不再各自为政", () => {
  it("中控室的行动锚点建议本身也不含线索名字（既有判据，交叉验证标准一致）", async () => {
    const session = makeSession(`ask-vs-anchor-${Math.random()}`);
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("中控室");
    const suggestions: string[] = session.getSuggestions("p1");
    const text = suggestions.join("\n");
    for (const clue of controlRoom.clues) {
      expect(text).not.toContain(clue.id);
      expect(text).not.toContain(clue.name);
    }
  });
});
