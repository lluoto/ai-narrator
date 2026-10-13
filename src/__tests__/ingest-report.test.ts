// 摄取管线 · 实跑报告组装（开发·无基准模式 任务①）
//
// 两种模式各自要验：有基准时报告文本形状要和抽出之前（run.ts 原样内联）
// 一致（回归红线，见 scripts/ingest/run.ts 的调用点）；无基准时每一处
// 依赖基准的小节都要能读到明确的"无基准，跳过"，不是静默消失。

import { describe, test, expect } from "bun:test";
import { buildIngestReport, type IngestReportContext } from "../ingest/ingest-report";
import { computeBaselineComparison, type BaselineData } from "../ingest/baseline-comparison";
import type { ModuleData, Scene } from "../module/types";
import { buildScenes } from "../ingest/build-scenes";
import type { Section, SectionItem } from "../ingest/sectionize";

const scene = (id: string, name: string): Scene => ({
  id, name, description: "", clues: [], npcIds: [], connections: [],
});

const baselineModule: ModuleData = {
  id: "m", title: "t", version: "1.0", ruleset: "cosmic-horror", era: "1921", summary: "",
  scenes: [scene("bedroom", "卧室")],
  npcs: [],
  meta: { playerCount: "", expectedDuration: "", triggerWarnings: [] },
  endings: [],
  items: [],
};

const baseline: BaselineData = { module: baselineModule, scoringKey: { "p1:L1": [{ kind: "clue", id: "c1" }] } };

function baseCtx(): Omit<IngestReportContext, "comparison"> {
  return {
    pageCount: 3,
    sectionCount: 5,
    classifyInputCount: 5,
    kindsSize: 5,
    dist: new Map([["scene", 1]]),
    unanswered: [],
    scenes: [scene("scene_01", "卧室")],
    sceneWarnings: [],
    itemInputCount: 0,
    itemKindsSize: 0,
    itemIdsSize: 0,
    itemDist: new Map(),
    itemUnanswered: [],
    items: [],
    provenanceCount: 0,
    itemWarnings: [],
    clueCount: 0,
    clueProvenanceCount: 0,
    clueWarnings: [],
    npcCount: 2,
    danglingRefs: [],
    narrative: {
      accepted: false,
      openingAtmosphereCount: 0,
      prologueLineCount: 0,
      hasPartySetup: false,
      provenanceCount: 0,
      registryMatches: true,
      warnings: [],
    },
    corpus: { ok: false, reason: "测试环境不提供语料" },
  };
}

describe("有基准模式：小节都产出真实数字，不是「无基准」占位", () => {
  const comparison = computeBaselineComparison(baseline, {
    rawScenes: [scene("scene_01", "卧室")],
    rawItems: [],
    extractedKeys: ["p1:L1"],
    clueProvenance: [],
    clueCount: 0,
    itemInputs: [],
    itemKinds: new Map(),
  });
  const report = buildIngestReport({ ...baseCtx(), comparison });

  test("不含任何「无基准」占位行", () => {
    expect(report.includes("无基准，跳过")).toBe(false);
  });

  test("评分键左手边真实产出「完全一致」", () => {
    expect(report).toContain("评分键左手边: 抽出条目 1 / 键 1 —— **完全一致**");
  });

  test("场景 id 继承真实产出「N/M 继承成功」而不是占位", () => {
    expect(report).toMatch(/场景 id 继承基准：\d+\/\d+ 继承成功/);
  });

  test("calibrate diff 真实产出（无差异时是「✓ 无差异」）", () => {
    expect(report).toContain("✓ 无差异");
  });
});

describe("无基准模式：每一处依赖基准的小节都能被判据读出「无基准，跳过」", () => {
  const report = buildIngestReport(baseCtx());

  test("不会抛错——最小假模组走无基准路径能跑完并产出报告", () => {
    expect(typeof report).toBe("string");
    expect(report.length).toBeGreaterThan(0);
  });

  // 一一枚举每个依赖基准的小节，逐条断言——不是"报告里有个无基准就算过"，
  // 是"这几处具体位置都被替换成了明确的跳过"，防止某一节漏改回退成静默省略。
  const gatedSections = [
    "评分键左手边",
    "场景覆盖率",
    "场景 id 继承",
    "条目分类准确率",
    "物品覆盖率",
    "物品 id 继承",
    "线索覆盖率/精确率",
    "线索 id 继承",
    "校准 diff",
  ];
  for (const section of gatedSections) {
    test(`「${section}」小节明确报"无基准，跳过"`, () => {
      const idx = report.indexOf(section);
      expect(idx, `报告里找不到"${section}"这一行`).toBeGreaterThanOrEqual(0);
      expect(report.slice(idx, idx + 200)).toContain("无基准，跳过");
    });
  }

  test("结构性统计小节存在且给出真实数字（场景/物品/线索/NPC 计数不依赖基准）", () => {
    expect(report).toContain("── 结构性统计（不依赖基准，两种模式都算）──");
    expect(report).toContain("场景 1 个 / 物品 0 个 / 线索 0 条 / NPC 2 个");
  });

  test("悬空引用检查不受「无基准」影响——内部一致性两种模式都跑", () => {
    expect(report).toContain("悬空引用（item.sceneId 在生成的 scenes 里找不到）0 个: 无");
  });
});

describe("结构化条目报告措辞", () => {
  test("发现列表生成的条目不被报告或 warning 误称为 ▶ 条目", () => {
    // 这些条目来自受上下文约束的发现列表，原文行本身没有 ▶ 标记。
    const discoveryItems: SectionItem[] = [
      { name: "样本甲", text: "倒在床边。", source: { page: 1, line: 3 } },
      { name: "样本乙", text: "嵌在墙上。", source: { page: 1, line: 4 } },
      { name: "样本丙", text: "有奇怪的痕迹。", source: { page: 1, line: 5 } },
    ];
    const section: Section = {
      title: "调查地点",
      body: "搜索房间后可以发现以下物品。",
      items: discoveryItems,
      source: { page: 1, line: 1 },
    };
    const sceneWarnings = buildScenes([section], new Map([["调查地点", "scene"]]), ["scene_01"]).warnings;
    const report = buildIngestReport({
      ...baseCtx(),
      itemInputCount: discoveryItems.length,
      itemKindsSize: discoveryItems.length,
      itemIdsSize: discoveryItems.length,
      sceneWarnings,
    });

    expect(report).toContain("全文共 3 个结构化条目");
    expect(report).not.toContain("全文共 3 个 ▶");
    expect(report).not.toContain("3 个 ▶ 条目");
  });
});

describe("**变异检验**：无基准时若有一处判断被删掉、直接访问 comparison 字段，必须崩", () => {
  test("对照：ctx.comparison 为 undefined 时，函数本身不访问其字段——不抛错", () => {
    // 已实际做过变异检验，不是空口描述：把「评分键左手边」那一节的
    // `if (ctx.comparison)` 临时改成 `if (true)` + `ctx.comparison!`，
    // 重跑这个文件——这条测试立刻从绿变红：
    //   TypeError: Cannot destructure property 'keyLhs' from null or
    //   undefined value at buildIngestReport (ingest-report.ts:78:24)
    // 验证完已经改回来，现在的 diff 里看不到这处改动——变异检验本身
    // 不留在代码里，留的是这条能在"改坏了"时变红的判据。
    expect(() => buildIngestReport(baseCtx())).not.toThrow();
  });
});
