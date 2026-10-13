// 开发 A · 任务 2 验收 —— isClueFound/isSceneVisited 与 END_NARRATIONS 的
// clue id 命名空间是否真的对得上。
//
// 背景：InvestigationEngine 的键历史上是 clueType（如 "corpse"），
// END_NARRATIONS 引用的是 BARN_OF_PREMIER 的 clue id（如
// "clue_bedroom_diary"）。bridgeBarnOfPremierClues()（game-session.ts:3251）
// 用 `clue.id` 原样注册，应该已经让两边对齐，但只是"应该"——这份测试
// 用真实模组数据实际验一遍，而不是靠读代码猜。
//
// bun test src/__tests__/ending-namespace-truth-source.test.ts

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { GameSession } from "../api/game-session";
import { BARN_SUPPORT, END_NARRATIONS } from "../module/barn-of-premier";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

let session: GameSession;
const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 1024, temperature: 0.7,
};
const KNOWN_UNREACHABLE = new Set(["bad_lever_pulled"]);

beforeEach(async () => {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  session = new GameSession("ending-namespace-test", "cosmic-horror", CFG, undefined, "调查员");
  await session.act("加载模组 普瑞米尔的谷仓");
});
afterEach(() => { session.close(); });

async function restoredWithFacts(
  label: string,
  clueIds: Iterable<string> = [],
  sceneIds: Iterable<string> = [],
): Promise<GameSession> {
  const id = `ending-namespace-${label}`;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Fixture Ada");
  expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
  const target = new GameSession(id, "cosmic-horror", CFG);
  restoreSignedOrdinaryWorld(target, CFG, (world) => {
    for (const clueId of clueIds) world.recordClueDiscovery("p1", clueId);
    for (const sceneId of sceneIds) world.recordSceneVisit("p1", sceneId);
  }, source);
  source.close();
  return target;
}

describe("命名空间一致性：END_NARRATIONS 的可生产引用逐项对齐；已知不可达明确隔离", () => {
  it("逐条核对可生产 requiredClues；bad_lever_pulled 保持明确不可达", async () => {
    const allRequiredClueIds = new Set<string>();
    for (const en of END_NARRATIONS) {
      for (const id of en.condition.requiredClues ?? []) allRequiredClueIds.add(id);
      for (const id of en.condition.excludeClues ?? []) allRequiredClueIds.add(id);
    }
    expect(allRequiredClueIds.size).toBeGreaterThan(0); // 判据本身要有东西可测

    expect(allRequiredClueIds.has("bad_lever_pulled")).toBe(true);
    const installableClueIds = [...allRequiredClueIds].filter((id) => !KNOWN_UNREACHABLE.has(id));
    const restored = await restoredWithFacts("all-installable", installableClueIds);
    try {
      for (const clueId of installableClueIds) {
        expect(restored.isClueFound(clueId)).toBe(true);
      }
      // end-narration-clue-reachability.test.ts fixes this exact clue as
      // unreachable: it has no module source, so it must never enter a legal
      // ordinary snapshot merely to make a namespace assertion pass.
      expect(session.isClueFound("bad_lever_pulled")).toBe(false);
      expect(restored.isClueFound("bad_lever_pulled")).toBe(false);
    } finally {
      restored.close();
    }
  });

  /**
   * 【开发·场景 id 收敛 N11，2026-09-04，随 (g) 步骤 1.1 更新】原来这条
   * 测试钉的是"requiredScenes 引用的 ASCII id 与运行时中文场景 id 不同，
   * 但经 barnSceneIdMap() 翻译后可查"——(g) 步骤 1.1 把
   * `BARN_OF_PREMIER.scenes[].id` 从 ASCII 改成了去括号的中文展示名
   * （运行时早就在用的那套），两套 id 现在是**同一个值**，不再需要翻译
   * 就能直接查到。这不是这条测试失败了要去将就，是场景 id 收敛这件事
   * 本身要它变成这样——`session.world.listScenes()` 现在应该能直接
   * 找到 requiredScenes 里的每一个 id，不用先经过 movePlayerToScene
   * 兜一圈再查 isSceneVisited。
   */
  it("requiredScenes 引用的场景 id 现在与运行时注册的场景 id 直接相等，且能作为合法访问事实恢复", async () => {
    const allRequiredSceneIds = new Set<string>();
    for (const en of END_NARRATIONS) {
      for (const id of en.condition.requiredScenes ?? []) allRequiredSceneIds.add(id);
    }
    expect(allRequiredSceneIds.size).toBeGreaterThan(0);

    const registeredIds = new Set(session.world.listScenes().map((s) => s.id));
    for (const sceneId of allRequiredSceneIds) expect(registeredIds.has(sceneId)).toBe(true);
    const restored = await restoredWithFacts("required-scenes", [], allRequiredSceneIds);
    try {
      for (const sceneId of allRequiredSceneIds) expect(restored.isSceneVisited(sceneId)).toBe(true);
    } finally { restored.close(); }
  });

  it(
    "**变异检验（真实数据，绕开上面那个已知缺口）**：用只依赖 requiredClues 的" +
      "Good End 验证 isClueFound 真的驱动了结局判定——标记它要求的线索前后，" +
      "evaluateEnding 的结果确实跟着变，不是摆设",
    async () => {
      const before = BARN_SUPPORT.evaluateEnding(
        (id) => session.isClueFound(id),
        (id) => session.isSceneVisited(id),
      );
      expect(before?.id).not.toBe("good"); // 什么都没发现，不可能是 Good End

      const restored = await restoredWithFacts("good", ["clue_control_supplies"]);

      try {
        const after = BARN_SUPPORT.evaluateEnding(
          (id) => restored.isClueFound(id),
          (id) => restored.isSceneVisited(id),
        );
        expect(after?.id).toBe("good");
      } finally { restored.close(); }
    },
  );
});
