// 开发·摄取管线校准 阶段4验收——接回断掉的 e2e 通路。
//
// 背景：60c7ed4（清理死导出）删掉了 assemble-module.ts 的 neutralSupport()
// （29 行）——判据当时说它"全仓无 import"，是真的：唯一调用方
// `tools/_e2e-ingested-module.ts` 躺在 .gitignore 外，编译器看不见那条
// 依赖，"判据说死、编译器说活"两边打架，删代码的人没有任何信号能发现
// 这个断裂。docs/notes/ingest.md:965 也一直没跟着改，文档漂了。
//
// 与 8ca53fa 修的"摄取入口躺在 tools/ 外"是同一类问题：脚本已经搬进
// scripts/ingest/e2e-run.ts（tsconfig.json 的 include 覆盖 scripts/**/*.ts，
// 编译器现在真的看得见这条依赖）。这份文件是那条通路的判据本体——
// 不依赖 tools/ 下任何派生产物，纯用一个内存里的最小 ModuleData 固件，
// 默认 bun test 就能跑，不需要先跑一遍摄取管线。
//
// bun test src/__tests__/ingest-e2e-module.test.ts

import { describe, it, expect } from "bun:test";
import { neutralSupport } from "../ingest/assemble-module";
import { runModule } from "../play-module";
import type { ModuleData } from "../module/types";
import type { PlayerDecision } from "../agent/player-agent";
import { MODULE_ENDING_SUPPORT } from "../play/module-departure";
import {
  classifyE2ERun,
  selectE2ESupport,
} from "../../scripts/ingest/e2e-result";

describe("neutralSupport：形状与「不编」承诺（回归 60c7ed4 误删这条判据本该拦住的问题）", () => {
  it("返回一份完整的 ModuleSupport，字段类型都对得上", () => {
    const support = neutralSupport();
    expect(support.traumaticClues).toEqual({});
    expect(support.endLabels).toEqual({});
    expect(support.encounters).toEqual([]);
    expect(typeof support.hubSceneId).toBe("string");
    expect(typeof support.finaleSceneId).toBe("string");
    expect(typeof support.finaleClueId).toBe("string");
    expect(support.bossNpcIdPattern).toBeInstanceOf(RegExp);
  });

  it("**关键承诺**：evaluateEnding 永远返回 null——不猜、不编一个结局出来", () => {
    const support = neutralSupport();
    expect(support.evaluateEnding(() => true, () => true)).toBeNull();
    expect(support.evaluateEnding(() => false, () => false)).toBeNull();
  });

  it("finaleSceneId 留空——不编一个终局场景 id 出来，那会让跑到某个场景时莫名其妙触发终局", () => {
    expect(neutralSupport().finaleSceneId).toBe("");
  });

  it("bossNpcIdPattern 匹配不到任何东西——摄取没有做 BOSS 识别，不该假装识别过", () => {
    const pattern = neutralSupport().bossNpcIdPattern;
    for (const name of ["mi_go", "boss", "艾德里安", ""]) {
      expect(pattern.test(name)).toBe(false);
    }
  });
});

// 最小固件：两个互通场景，不依赖 tools/ 下任何摄取产物，默认就能跑。
// 判据只有两条，跟 scripts/ingest/e2e-run.ts 对真实摄取产物做的判断一样：
//   1. 引擎不崩，能开始
//   2. 调查员真的从一个场景走到了另一个场景（不是选项列表里提了个名字）
const TWO_SCENE_MODULE: ModuleData = {
  id: "e2e-fixture",
  title: "e2e 判据用最小模组",
  version: "0.0.0-test",
  ruleset: "cosmic-horror",
  era: "",
  summary: "",
  scenes: [
    {
      id: "scene_a", name: "起点房间",
      description: "这是起点房间，墙壁空空荡荡，只有一扇门通向别处。",
      clues: [], npcIds: [],
      connections: [{ targetSceneId: "scene_b", condition: "走向终点房间" }],
    },
    {
      id: "scene_b", name: "终点房间",
      description: "这是终点房间，比起点房间更小，只放着一张旧桌子。",
      clues: [], npcIds: [],
      connections: [{ targetSceneId: "scene_a", condition: "返回起点房间" }],
    },
  ],
  npcs: [],
  meta: { playerCount: "", expectedDuration: "", triggerWarnings: [] },
  endings: [],
  items: [],
  provenance: [],
};

describe("端到端：摄取出来的模组（用最小固件代表）能用 neutralSupport 真的跑起来", () => {
  it("引擎不崩，且调查员真的从一个场景走到了另一个场景——按描述认，不是按选项里提了个名字", async () => {
    const sceneNames = new Set(TWO_SCENE_MODULE.scenes.map((s) => s.name));
    const visited = new Set<string>();
    const descKey = (d: string) => d.replace(/\s+/g, "").slice(0, 12);
    const sceneByDesc = new Map(TWO_SCENE_MODULE.scenes.map((s) => [descKey(s.description), s.name]));

    let decisions = 0;
    const MAX = 8;
    let failure = "";
    try {
      await runModule(TWO_SCENE_MODULE, neutralSupport(), {
        onLine: (line: string) => {
          const flat = line.replace(/\s+/g, "");
          for (const [k, name] of sceneByDesc) if (k.length > 6 && flat.includes(k)) visited.add(name);
        },
        decide: (_context: string, options: string[]): Promise<PlayerDecision> => {
          decisions++;
          if (decisions > MAX) throw new Error("__STOP__");
          const move = options.find((o) => {
            for (const n of sceneNames) if (o.includes(n) && !visited.has(n)) return true;
            return false;
          });
          const pick = move ?? options[0] ?? "观察四周";
          return Promise.resolve({ action: pick, intent: move ? "move" : "observe" });
        },
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m !== "__STOP__") failure = m;
    }

    expect(failure).toBe(""); // 引擎没崩
    expect(visited.size).toBeGreaterThan(1); // 真的走动了，不是停在开场那一个场景
  });
});

describe("ingested e2e support and outcome truthfulness", () => {
  it("an arbitrary unregistered ingested id cannot inherit the barn ending support", () => {
    const selected = selectE2ESupport("any-ingested-module-with-scene-ids");

    expect(MODULE_ENDING_SUPPORT["barn-of-premier-ingested"]).toBeUndefined();
    expect(selected.source).toBe("neutral");
    expect(selected.support).not.toBe(MODULE_ENDING_SUPPORT.premiers_barn);
    expect(selected.support.evaluateEnding(() => false, () => false)).toBeNull();
  });

  it("uses a registered support only for its exact module id", () => {
    const selected = selectE2ESupport("premiers_barn");
    expect(selected.source).toBe("registered");
    expect(selected.support).toBe(MODULE_ENDING_SUPPORT.premiers_barn);
  });

  it("does not call the action limit a completed playthrough", () => {
    const result = classifyE2ERun({ stop: "action-limit", moved: true, terminalEnding: null });
    expect(result.kind).toBe("action-limit");
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("does not call a timeout a completed playthrough", () => {
    const result = classifyE2ERun({ stop: "timeout", moved: true, terminalEnding: null });
    expect(result.kind).toBe("timeout");
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("reports movement without an ending as smoke evidence, not completion", () => {
    const result = classifyE2ERun({ stop: "returned", moved: true, terminalEnding: null });
    expect(result.kind).toBe("movement-smoke");
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("calls a run completed only when it returned with a terminal ending event", () => {
    const result = classifyE2ERun({
      stop: "returned",
      moved: true,
      terminalEnding: { id: "verified-ending", label: "Verified ending" },
    });
    expect(result.kind).toBe("terminal-completion");
    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("keeps an engine crash distinct from both smoke and completion", () => {
    const result = classifyE2ERun({ stop: "engine-crash", moved: true, terminalEnding: null });
    expect(result.kind).toBe("engine-crash");
    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
