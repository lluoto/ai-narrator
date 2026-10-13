// P2 — 谷仓模组线索可达性桥接
// 背景见 game-session.ts 的 bridgeBarnOfPremierClues() 注释：
// premiers_barn.ts 自带的 10 条线索里 clue_0/clue_1/clue_8/clue_9 的 scene
// 字段填的是 NPC 名/事件名，不是玩家能走到的场景，而且合成的 ClueDef 没有
// 技能/难度梯度。BARN_OF_PREMIER（32 条，带 findMethods/revelation）挂在真实
// 场景下，桥接进 InvestigationEngine 后应与原有 10 条并存、都可查到。
//
// bun test src/__tests__/barn-of-premier-clue-bridge.test.ts

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { GameSession } from "../api/game-session";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

let session: GameSession;
let priorLlmApiKey: string | undefined;
let priorOpenAiApiKey: string | undefined;

async function restoredBarnBridgeProbe(id: string, prerequisites: readonly string[] = []): Promise<GameSession> {
  const config = {
    apiKey: "sk-placeholder",
    baseUrl: "http://localhost:9999",
    model: "mock",
    maxTokens: 1024,
    temperature: 0.7,
  };
  const source = new GameSession(id, "cosmic-horror", config, "investigator", "调查员");
  await source.act("加载模组 普瑞米尔的谷仓");
  const probe = new GameSession(id, "cosmic-horror", config);
  restoreSignedOrdinaryWorld(probe, config, (world) => {
    for (const prerequisite of prerequisites) {
      world.recordClueDiscovery("p1", prerequisite);
    }
  }, source);
  source.close();
  return probe;
}

/**
 * Keep the bridge test on the public session path: the module registers its
 * clues, a real character supplies exactly one viable skill, and the normal
 * action resolver must discover the requested clue.  Reading coc_primary
 * directly would couple this test to the intentionally hidden engine owner.
 */
async function discoverWithOnlySkill(input: {
  sceneId: string;
  clueId: string;
  action: string;
  skill: string;
  prerequisites?: string[];
}): Promise<boolean> {
  const id = `barn-bridge-skill-${input.clueId}`;
  const probe = await restoredBarnBridgeProbe(id, input.prerequisites);
  try {
    expect(activateRegisteredGameSessionSceneForTest(probe, input.sceneId)).toBe(true);
    const character = probe.activeCharacter;
    if (!character?.skillValues) throw new Error("fixture requires an active character skill sheet");
    const skills = Object.fromEntries(Object.keys(character.skillValues).map((skill) => [skill, 0]));
    const attributePatch = input.skill === "luck"
      ? { luck: 90 }
      : input.skill === "strength"
        ? { attributes: { strength: 90 } }
        : { skillValues: { ...skills, [input.skill]: 90 } };
    expect(probe.updateActiveCharacter({ skillValues: skills, ...attributePatch })).toMatchObject({ status: "updated" });
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      await probe.act(input.action);
    } finally {
      Math.random = originalRandom;
    }
    const discovered = probe.investigation.isDiscoveredBy(input.clueId, "p1");
    if (input.skill === "luck" || input.skill === "strength") {
      expect(probe.activeCharacter?.skillValues).not.toHaveProperty(input.skill);
    }
    return discovered;
  } finally {
    probe.close();
  }
}

beforeEach(() => {
  priorLlmApiKey = process.env.LLM_API_KEY;
  priorOpenAiApiKey = process.env.OPENAI_API_KEY;
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  session = new GameSession("barn-bridge-test", "cosmic-horror", {
    apiKey: "sk-placeholder",
    baseUrl: "http://localhost:9999",
    model: "mock",
    maxTokens: 1024,
    temperature: 0.7,
  }, undefined, "调查员");
});

afterEach(() => {
  session.close();
  if (priorLlmApiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = priorLlmApiKey;
  if (priorOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = priorOpenAiApiKey;
});

describe("BARN_OF_PREMIER rich Clue 直接加载 — 注册", () => {
  it("加载模组后，BARN_OF_PREMIER 的专属线索 id 应被注册进 InvestigationEngine", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    const investigation = session.investigation;
    // clue_pistol_in_bag 只存在于 BARN_OF_PREMIER，不在 premiers_barn.ts 的 10 条老线索里
    expect(investigation.hasClueType("clue_pistol_in_bag")).toBe(true);
    expect(investigation.hasClueType("clue_drugs")).toBe(true);
    expect(investigation.hasClueType("clue_bar_guest_identity")).toBe(true);
  });

  it("只注册 32 条 rich Clue；clue_0..9 已退出生产", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    const investigation = session.investigation;
    expect(investigation.hasClueType("clue_2")).toBe(false);
    expect(investigation.hasClueType("clue_3")).toBe(false);
    const gabiClues = investigation.getSceneClues("加比的拖车房");
    expect(gabiClues).toContain("clue_pistol_in_bag");
    expect(gabiClues).toContain("clue_drugs");
    expect(gabiClues).toContain("clue_card");
  });

  it("场景名括号后缀会被归一化，桥接后的线索挂在不带括号的场景 id 下", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    const investigation = session.investigation;
    // BARN_OF_PREMIER 里这个场景叫"农场外围（陷阱区）"，但运行时 state.scene
    // 用的是不带括号的"农场外围"（mythos-module.ts registerScene 用短名）。
    const trapped = investigation.getSceneClues("农场外围");
    expect(trapped.length).toBeGreaterThan(0);
    // 带括号的原名不应该单独占一个桥
    const withBracket = investigation.getSceneClues("农场外围（陷阱区）");
    expect(withBracket.length).toBe(0);
  });

  it("菲碧旧 clue_0/clue_1 不再伪装成可搜查线索；内容由已激活的菲碧 NPC 承载", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    const investigation = session.investigation;
    expect(investigation.getSceneClues("特里坎家")).not.toContain("clue_0");
    expect(investigation.getSceneClues("特里坎家")).not.toContain("clue_1");
    expect(investigation.getSceneClues("菲碧_特里坎")).toHaveLength(0);
    expect(session.world.getEntity("菲碧·特里坎")).not.toBeNull();
  });
});

describe("BARN_OF_PREMIER 线索桥接 — 技能映射", () => {
  it("findMethods 里的中文技能名应正确翻译成 CoC 英文技能 key", async () => {
    // clue_bar_guest_identity 的 findMethod 技能是"社交" → fast_talk。
    // 若桥接退回 spot_hidden 或任何别的 key，50% 骰在全为 0 的角色上会失败。
    expect(await discoverWithOnlySkill({
      sceneId: "维森酒吧", clueId: "clue_bar_guest_identity", action: "询问贵客身份", skill: "fast_talk",
      prerequisites: ["clue_bar_mass_booking"],
    })).toBe(true);
  });

  it("图书馆技能线索应映射到 library_use", async () => {
    expect(await discoverWithOnlySkill({
      sceneId: "报亭", clueId: "clue_newspaper_kidnapper", action: "调查绑架犯", skill: "library_use",
      prerequisites: ["clue_newspaper_missing"],
    })).toBe(true);
  });

  it("唯一属性型 findMethod（幸运）时退回属性代理 key，不是乱猜的技能名", async () => {
    expect(await discoverWithOnlySkill({
      sceneId: "维森酒吧", clueId: "clue_bar_ask_around", action: "向其他人打听", skill: "luck",
    })).toBe(true);
  });

  it("多个 findMethod 里同时有真技能与属性时，优先选真技能而非属性", async () => {
    // clue_barn_victims 有 力量(属性) 和 急救(first_aid) 两条 skill findMethod，
    // 即使力量经 canonical attributes 设为 90，也应该选 first_aid 而不是 strength。
    expect(await discoverWithOnlySkill({
      sceneId: "建筑内", clueId: "clue_barn_victims", action: "检查周围的床铺", skill: "strength",
    })).toBe(false);
    expect(await discoverWithOnlySkill({
      sceneId: "建筑内", clueId: "clue_barn_victims", action: "检查周围的床铺", skill: "first_aid",
    })).toBe(true);
  });

  it("INVESTIGATIVE_SKILLS 已扩容，覆盖 32 条线索用到的技能，否则玩家用对应技能也触发不了场景线索解析", () => {
    const skills: Set<string> = (GameSession as any).INVESTIGATIVE_SKILLS;
    for (const s of ["spot_hidden", "charm", "fast_talk", "library_use", "credit_rating", "psychoanalysis", "medicine", "first_aid", "language_own", "luck", "strength"]) {
      expect(skills.has(s)).toBe(true);
    }
  });
});

describe("BARN_OF_PREMIER 线索桥接 — clue_final_brain_jars 的叙事用词别名（开发·真相链路 任务①）", () => {
  const realRandom = Math.random;
  afterEach(() => {
    Math.random = realRandom;
  });

  it("matchTexts 应包含引擎自己叙事里用过的称呼，不只是 clue.name/findMethods 原文", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    const clue = session.investigation.getClueMatchInfo("clue_final_brain_jars");
    expect(clue).toBeDefined();
    for (const alias of ["培养缸", "玻璃缸", "一大一小", "营养液"]) {
      expect(clue?.matchTexts).toContain(alias);
    }
  });

  it("**错误行为红线**：玩家用引擎自己教的「培养缸」/「一大一小」/「营养液」称呼，此前会被 deny，现在应能命中并成功", async () => {
    Math.random = () => 0; // 逼检定必成功，只验证匹配本身
    for (const sentence of [
      "陆川走近那两个培养缸，看清里面泡着什么",
      "陆川打量那一大一小两个玻璃缸",
      "陆川检查那些泡着营养液的容器",
    ]) {
      const sess = new GameSession(`brain-jars-alias-${Math.random()}`, "cosmic-horror", {
        apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
      }, undefined, "调查员");
      try {
        await sess.act("加载模组 普瑞米尔的谷仓");
        await sess.act("前往维修间");
        await sess.act(sentence);
        expect(sess.investigation.isDiscoveredBy("clue_final_brain_jars", "p1")).toBe(true);
      } finally {
        sess.close();
      }
    }
  });

  it("回归：过泛的词（设备/容器）不被收进别名，不该匹配的场景不会被误伤", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    const clue = session.investigation.getClueMatchInfo("clue_final_brain_jars");
    expect(clue?.matchTexts).not.toContain("设备");
    expect(clue?.matchTexts).not.toContain("容器");
  });

  it("不误伤 clue_final_coffin 的歧义回问——两条线索都可能命中的句子仍然 ask，不会被这次改动强行导向 brain_jars", async () => {
    Math.random = () => 0;
    const sess = new GameSession(`coffin-ambiguity-${Math.random()}`, "cosmic-horror", {
      apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
    }, undefined, "调查员");
    try {
      await sess.act("加载模组 普瑞米尔的谷仓");
      await sess.act("前往维修间");
      const r = await sess.act("打开那口像冰箱一样的棺材");
      expect(sess.investigation.isDiscoveredBy("clue_final_brain_jars", "p1")).toBe(false);
      expect(sess.investigation.isDiscoveredBy("clue_final_coffin", "p1")).toBe(false);
      const sysReplies = r.events.filter((e) => e.speaker === "系统").map((e) => e.content).join("\n");
      expect(sysReplies).toContain("想找什么");
    } finally {
      sess.close();
    }
  });
});

describe("BARN_OF_PREMIER 线索桥接 — 端到端可达性", () => {
  const realRandom = Math.random;
  afterEach(() => {
    Math.random = realRandom;
  });

  it("站在加比的拖车房，真实调查动作应该能查到 BARN_OF_PREMIER 桥接进来的线索文本", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    (session as any).movePlayerToScene("加比的拖车房");

    // 逼骰子恒定成功（roll=1），排除随机性，只验证可达性这一件事。
    Math.random = () => 0;

    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await session.act("侦查");
      seen.push(...res.events.map((e) => e.content));
    }
    const all = seen.join("\n");
    // BARN_OF_PREMIER 独有措辞（不带"为"字，且不含○粉/海○因原始描述），
    // 老 clue_2/clue_3 的合成文本不会产生这句。
    expect(all).toMatch(/故障值90，伤害d10\+2，贯穿属性/);
    expect(all).toMatch(/找到一些毒品，数量不多但足够定罪/);
  });
});
