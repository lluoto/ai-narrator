// CoC 神话法术集成测试 — 离线模式（MockLLM）
// bun test src/__tests__/coc-spells.test.ts

import { describe, it, expect, beforeEach } from "bun:test";
import { GameSession } from "../api/game-session";


let session: GameSession;

beforeEach(() => {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  session = new GameSession("spell-test", "cosmic-horror", {
    apiKey: "sk-placeholder",
    baseUrl: "http://localhost:9999",
    model: "mock",
    maxTokens: 1024,
    temperature: 0.7,
  }, "investigator", "调查员");
});

// ============================================================
// 神话典籍阅读
// ============================================================

describe("神话典籍阅读", () => {
  it("未安装的旧目录名字不能产生 SAN 或 CM 副作用", async () => {
    const before = session.exportOrdinarySessionSnapshot().state.sanities.find((entry) => entry.pcId === "p1")!.state;
    const res = await session.act("阅读死灵之书");
    const after = session.exportOrdinarySessionSnapshot().state.sanities.find((entry) => entry.pcId === "p1")!.state;
    expect(after).toEqual(before);
    expect(res.events.map(e => e.content).join("\n")).toContain("没有已安装模组声明");
  });

  it("阿卡姆典籍仅在其真实保险库位置触发声明的 SAN/CM 结算", async () => {
    await session.act("加载模组 阿卡姆档案检查");
    const remote = await session.act("阅读塞拉伊诺断章");
    expect(remote.events.map(e => e.content).join("\n")).toContain("不在你当前场景或背包中");

    const moved = await session.act("前往 arkham_library_vault");
    expect(moved.error).toBeUndefined();
    expect(session.getPlayerPosition()).toBe("arkham_library_vault");
    const res = await session.act("阅读塞拉伊诺断章");
    expect(res.events.map(e => e.content).join("\n")).toMatch(/SAN|克苏鲁神话技能提升/);
  });

  it("印斯茅斯的真实典籍使用模块声明的法术，而不是自由创建法术", async () => {
    await session.act("加载模组 印斯茅斯的阴影");
    expect(session.getPlayerPosition()).toBe("innsmouth_docks");
    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      const res = await session.act("阅读扎多克的低语");
      expect(res.events.map(e => e.content).join("\n")).toContain("克苏鲁神话技能提升+1%");
    } finally {
      Math.random = originalRandom;
    }
    expect(session.exportOrdinarySessionSnapshot().state.knownMythosSpells).toContain("接触大衮");
    const cast = await session.act("施展接触大衮");
    expect(cast.events.map(e => e.content).join("\n")).toContain("你尝试施展「接触大衮」");
  });

  it("阅读不在模组声明中的普通物品只给出拒绝，不猜测典籍定义", async () => {
    const res = await session.act("阅读铁制钥匙");
    const content = res.events.map(e => e.content).join("\n");
    expect(content).toContain("没有已安装模组声明");
    expect(content).not.toMatch(/SAN|克苏鲁神话技能提升/);
  });
});

// ============================================================
// 剧本杀模组导入
// ============================================================

describe("剧本杀模组导入", () => {
  it("加载模组命令不崩溃", async () => {
    const res = await session.act("加载模组");
    expect(res).toBeDefined();
    const content = res.events.map(e => e.content).join("\n");
    // 应有可用模组列表或提示
    expect(content).toMatch(/模组|已加载/);
  });

  it("从自定义模组库加载模组后应注册法术并放置物品", async () => {
    const verifier = new GameSession("spell-module-snapshot", "cosmic-horror", {
      apiKey: "sk-placeholder",
      baseUrl: "http://localhost:9999",
      model: "mock",
      maxTokens: 1024,
      temperature: 0.7,
    }, "investigator", "Ada");
    try {
      const res = await verifier.act("加载模组 普瑞米尔的谷仓");
      expect(res).toBeDefined();
      const content = res.events.map(e => e.content).join("\n");
      expect(content).toMatch(/注册|放置|生成|已加载/);

      // The session owns its runtime map; its supported snapshot confirms the
      // module registered the canonical definition without exposing the map.
      expect(verifier.exportOrdinarySessionSnapshot().state.mythosSpells
        .some((spell) => spell.name === "僵尸创造术")).toBe(true);
    } finally {
      verifier.close();
    }
  });

  it("同一个模组不应重复加载", async () => {
    await session.act("加载模组 普瑞米尔的谷仓");
    const res2 = await session.act("加载模组 普瑞米尔的谷仓");
    const content = res2.events.map(e => e.content).join("\n");
    expect(content).toMatch(/已导入/);
  });

  it("加载模组后应真的建成场景出口，而不是降级成一行警告", async () => {
    // 出口连接靠宿主提供数据库能力。宿主适配器少给这个能力时，
    // 加载器会把异常吞成 "⚠️ 场景出口连接失败"，模组场景之间从此走不通，
    // 而类型检查和其余用例都照样通过——所以这里必须直接盯住结果。
    const res = await session.act("加载模组 普瑞米尔的谷仓");
    const content = res.events.map(e => e.content).join("\n");
    expect(content).not.toMatch(/场景出口连接失败/);
    expect(content).toContain("构建 46 条统一场景出口");
  });
});

// ============================================================
// 神话法术施放
// ============================================================

describe("神话法术施放", () => {
  it("未学会法术时施放给出提示", async () => {
    const res = await session.act("吟唱克苏鲁的咒语");
    expect(res).toBeDefined();
    expect(res.events.length).toBeGreaterThan(0);
    // 应有某种提示：未学会 / 未创建角色 / 不知
    const hasMessage = res.events.some(e =>
      e.content.includes("未学会") || e.content.includes("尚未") ||
      e.content.includes("不知") || e.content.includes("角色") ||
      e.content.includes("法术")
    );
    expect(hasMessage).toBe(true);
  });

  it("阅读后施放神话法术不崩溃", async () => {
    // 多次阅读死灵之书学会多个法术
    for (let i = 0; i < 5; i++) {
      await session.act("阅读死灵之书");
    }

    // 尝试各种法术调用，不应崩溃
    const casts = ["吟唱呼唤米戈的咒语", "吟唱放逐术的咒语", "吟唱克苏鲁之眼"];
    for (const castInput of casts) {
      const res = await session.act(castInput);
      expect(res).toBeDefined();
    }
  });

  it("非 CoC 模式下神话法术无法施放", async () => {
    const dndSession = new GameSession("dnd-spell-test", "dnd5e", {
      apiKey: "sk-placeholder",
      baseUrl: "http://localhost:9999",
      model: "mock",
      maxTokens: 1024,
      temperature: 0.7,
    }, "fighter", "战士甲");

    const res = await dndSession.act("吟唱米戈的咒语");
    const errEvent = res.events.find(e =>
      e.content.includes("仅支持") || e.content.includes("不支持")
    );
    expect(errEvent).toBeDefined();
  });
});

// ============================================================
// 放逐术效果
// ============================================================

describe("放逐术", () => {
  it("放逐术不崩溃", async () => {
    // 多次阅读直到学会法术
    for (let i = 0; i < 10; i++) {
      await session.act("阅读死灵之书");
    }

    // 驱逐咒语不崩溃
    const res = await session.act("驱逐米戈");
    expect(res).toBeDefined();
  });
});

// ============================================================
// D&D 法术不受影响
// ============================================================

describe("D&D 法术不受神话法术影响", () => {
  it("D&D 模式下施法仍正常运作", async () => {
    const dndSession = new GameSession("dnd-cast-test", "dnd5e", {
      apiKey: "sk-placeholder",
      baseUrl: "http://localhost:9999",
      model: "mock",
      maxTokens: 1024,
      temperature: 0.7,
    }, "wizard", "法师甲");

    // 原先只断言 res 存在。实跑：叙述是「你回忆了一下已知的法术」——
    // 「仍正常运作」是可判的，不必只验没崩。
    const res = await dndSession.act("法术列表");
    expect(res.narrative).toContain("法术");
  });
});
