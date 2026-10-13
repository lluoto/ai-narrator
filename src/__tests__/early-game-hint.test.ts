// 开发·线索闸门 任务3验收——前期检定失败给指向性降级信息。
//
// 背景：除了连续大失败以外，尽量不在前期阻止调查。检定失败时给指向性
// 明确的降级信息引导再查（"卫生间那边似乎还有东西"），不是直接给线索
// 内容。与行动锚点分工：锚点不点位置（免费的），失败一次才给方向
// （试出来的）。
//
// "前期"判定两条路：有 ModuleSupport 且声明 earlyGameEndSceneId 的模组
// （谷仓用 adrian_farm）按场景访问判；没有的模组按已发现/可文本匹配线索
// 总数 < 1/3 判。
//
// bun test src/__tests__/early-game-hint.test.ts

import { describe, it, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { extractLocationHint } from "../investigation/clue-match";
import { BARN_SUPPORT } from "../module/barn-of-premier";
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

describe("extractLocationHint：从 findMethods 描述抽干净的位置名词", () => {
  it("真实数据：clue_drugs/clue_card/clue_pistol 各自的方向", () => {
    expect(extractLocationHint(["侦查卫生间/仔细检查洗漱用具"])).toBe("卫生间");
    expect(extractLocationHint(["侦查餐厅/宣言仔细检查餐桌：可以发现在披萨盒下面有一张小卡片"])).toBe("餐厅");
    expect(extractLocationHint(["侦查休息区/仔细检查床底"])).toBe("床底");
  });

  it("抽不出干净候选（全是长句或纯动词）时返回 null，不硬凑", () => {
    expect(extractLocationHint(["可以发现在披萨盒下面有一张小卡片"])).toBeNull(); // 无分隔符的长句
    expect(extractLocationHint(["侦查"])).toBeNull(); // 纯动词，剥完什么都不剩
  });
});

describe("谷仓：earlyGameEndSceneId=adrian_farm，到农场之前算前期", () => {
  it("BARN_SUPPORT 声明了这个字段", () => {
    expect(BARN_SUPPORT.earlyGameEndSceneId).toBe("艾德里安的农场");
  });

  it("开局在特里坎家：isEarlyGame() 为 true", async () => {
    const s = makeSession(`early-fresh-${Math.random()}`);
    await s.act("加载模组 普瑞米尔的谷仓");
    expect(s.isEarlyGame()).toBe(true);
  });

  it("到过「艾德里安的农场」（adrian_farm 的运行时名）之后：isEarlyGame() 为 false", async () => {
    const s = makeSession(`early-farm-${Math.random()}`);
    await s.act("加载模组 普瑞米尔的谷仓");
    (s as any).movePlayerToScene("艾德里安的农场");
    expect(s.isEarlyGame()).toBe(false);
  });

  it("端到端：前期在拖车房检定失败，revelation 含方向、不含线索内容/名字", async () => {
    const s = makeSession(`early-e2e-fail-${Math.random()}`);
    await s.act("加载模组 普瑞米尔的谷仓");
    (s as any).movePlayerToScene("加比的拖车房");
    expect(s.isEarlyGame()).toBe(true);

    const real = Math.random;
    Math.random = () => 0.99; // 逼检定失败
    try {
      const res = await s.act("检查卫生间", "p1");
      expect(res.narrative).toContain("卫生间那边似乎还有些什么");
      // 不泄露线索本身的名字/内容（"毒品"是 clue_drugs 的展示名）
      expect(res.narrative).not.toContain("毒品");
    } finally { Math.random = real; }
  });

  it("回归：过农场之后（非前期），检定失败恢复成原本的通用失败文案", async () => {
    const s = makeSession(`early-nonearly-${Math.random()}`);
    await s.act("加载模组 普瑞米尔的谷仓");
    (s as any).movePlayerToScene("艾德里安的农场");
    (s as any).movePlayerToScene("加比的拖车房"); // 再回拖车房触发同一条线索的检定
    expect(s.isEarlyGame()).toBe(false);

    const real = Math.random;
    Math.random = () => 0.99;
    try {
      const res = await s.act("检查卫生间", "p1");
      expect(res.narrative).not.toContain("那边似乎还有些什么");
      expect(res.narrative).toContain("你仔细搜查了一番，但这次没能看出什么名堂。");
    } finally { Math.random = real; }
  });

  it("回归：成功路径完全不受影响", async () => {
    const s = makeSession(`early-success-${Math.random()}`);
    await s.act("加载模组 普瑞米尔的谷仓");
    (s as any).movePlayerToScene("加比的拖车房");
    expect(s.isEarlyGame()).toBe(true);

    const real = Math.random;
    Math.random = () => 0; // 逼检定成功
    try {
      const res = await s.act("检查卫生间", "p1");
      expect(res.narrative).not.toContain("那边似乎还有些什么");
      expect(res.narrative).toContain("毒品"); // 成功时正常揭示内容
    } finally { Math.random = real; }
  });
});

describe("没有 ModuleSupport 的模组：已发现/可匹配线索总数 < 1/3", () => {
  it("阿卡姆档案检查（3 条线索，全无 matchTexts，退回数全部）：新开局是前期，发现 1 条后不再是", async () => {
    const s = makeSession(`arkham-early-${Math.random()}`);
    await s.act("加载模组 阿卡姆档案检查");
    expect(s.isEarlyGame()).toBe(true);
    expect(activateRegisteredGameSessionSceneForTest(s, "arkham_miskatonic")).toBe(true);
    const real = Math.random;
    Math.random = () => 0;
    try {
      expect((await s.act("调查", "p1")).error).toBeUndefined();
    } finally { Math.random = real; }
    expect(s.isEarlyGame()).toBe(false);
  });
});

const EARLY_HINT = "卫生间那边似乎还有些什么";
const GENERIC_FAILURE = "你仔细搜查了一番，但这次没能看出什么名堂。";

type EarlyGameShadow = {
  label: string;
  value: () => boolean | undefined;
};

const EARLY_GAME_SHADOWS: readonly EarlyGameShadow[] = [
  { label: "fake-true", value: () => true },
  { label: "fake-false", value: () => false },
  { label: "no-op", value: () => undefined },
  { label: "throwing", value: () => { throw new Error("forged early-game predicate"); } },
];

async function preparedEarlyHintSession(kind: "early" | "non-early", id: string): Promise<GameSession> {
  const session = makeSession(id);
  await session.act("加载模组 普瑞米尔的谷仓");
  if (kind === "non-early") (session as any).movePlayerToScene("艾德里安的农场");
  (session as any).movePlayerToScene("加比的拖车房");
  expect(session.isEarlyGame()).toBe(kind === "early");
  return session;
}

async function expectCanonicalFailedHint(
  session: GameSession,
  kind: "early" | "non-early",
): Promise<void> {
  const beforeRound = session.round;
  const beforeFailures = session.world.getClueFailCount("clue_drugs");
  const realRandom = Math.random;
  Math.random = () => 0.99;
  try {
    const response = await session.act("检查卫生间", "p1");
    expect(response.error).toBeUndefined();
    expect(response.state.round).toBe(beforeRound + 1);
    // clue_drugs is not a core clue in this published module; failed probing
    // deliberately leaves its failback counter unchanged.  Keep that existing
    // rule visible while proving the hint branch cannot change it.
    expect(session.world.getClueFailCount("clue_drugs")).toBe(beforeFailures);
    expect(session.exportOrdinarySessionSnapshot().world.tables.clue_discoveries
      .some((entry) => entry.clue_id === "clue_drugs")).toBe(false);
    if (kind === "early") {
      expect(response.narrative).toContain(EARLY_HINT);
      expect(response.narrative).not.toContain("毒品");
    } else {
      expect(response.narrative).toContain(GENERIC_FAILURE);
      expect(response.narrative).not.toContain(EARLY_HINT);
    }
    // A throwing decoy used to escape resolveSceneClue(), fail-stop the outer
    // action, and retire the session. The canonical hint projection is only
    // availability/presentation authority, so the next ordinary turn remains
    // available after every shadow attempt.
    expect((await session.act("/help", "p1")).error).toBeUndefined();
  } finally {
    Math.random = realRandom;
  }
}

for (const scope of ["own", "prototype"] as const) {
  for (const kind of ["early", "non-early"] as const) {
    for (const shadow of EARLY_GAME_SHADOWS) {
      it(`does not let a ${scope} ${shadow.label} isEarlyGame shadow alter or DoS ${kind} failed-clue hints`, async () => {
        const session = await preparedEarlyHintSession(kind, `early-hint-${scope}-${shadow.label}-${kind}-${crypto.randomUUID()}`);
        const descriptor = scope === "prototype" ? Object.getOwnPropertyDescriptor(GameSession.prototype, "isEarlyGame") : undefined;
        if (scope === "prototype" && !descriptor) throw new Error("fixture requires the public isEarlyGame wrapper");
        try {
          if (scope === "own") {
            Object.defineProperty(session, "isEarlyGame", { configurable: true, value: shadow.value });
            // Public observation stays ordinary JavaScript; only internal
            // hint selection is sealed to the canonical world projection.
            if (shadow.label === "fake-false") expect((session as any).isEarlyGame()).toBe(false);
          } else {
            Object.defineProperty(GameSession.prototype, "isEarlyGame", {
              configurable: true,
              writable: true,
              value: shadow.value,
            });
          }
          await expectCanonicalFailedHint(session, kind);
        } finally {
          if (scope === "prototype") Object.defineProperty(GameSession.prototype, "isEarlyGame", descriptor!);
          session.close();
        }
      });
    }
  }
}
