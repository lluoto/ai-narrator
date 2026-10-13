import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { importPointsTo, scanImports } from "../diagnostics/source-scan";
import { BARN_OF_PREMIER } from "../module/barn-of-premier";
import { ModuleDataRuntimeLoader, type ModuleDataRuntimeHost } from "../module/module-data-runtime-loader";
import type { RuntimeModuleTome } from "../module/runtime-types";
import type { Clue, ModuleItem } from "../module/types";
import { getModule } from "../rules/custom-modules";

function makeHost() {
  const scenes: Array<{ id: string; name: string; description: string; exits: Array<{ target: string; desc: string }> }> = [];
  const runtimeNpcs: string[] = [];
  const narrativeNpcs: string[] = [];
  const richClues: Array<{ clue: Clue; sceneId: string; sanCost?: string }> = [];
  const richItems: ModuleItem[] = [];
  const itemPlacements: string[] = [];
  const spells: string[] = [];
  const tomes: string[] = [];
  const hooks: string[] = [];
  const rewards: string[] = [];
  const messages: string[] = [];
  const bgm: Record<string, string> = {};
  const aliases: Record<string, string[]> = {};
  const kpNotes: Record<string, string> = {};
  const initialEffects: unknown[] = [];
  const host: ModuleDataRuntimeHost = {
    registerScene: (scene) => scenes.push(scene),
    registerRuntimeNpc: (_npc, runtime) => runtimeNpcs.push(runtime.sourceId),
    registerNarrativeNpc: (npc) => narrativeNpcs.push(npc.id),
    registerRichClue: (sceneId, clue, sanCost) => richClues.push({ clue: structuredClone(clue), sceneId, sanCost }),
    registerTome: (tome) => tomes.push(tome.name),
    registerItemPlacement: (item) => itemPlacements.push(item.name),
    registerRichItem: (item) => richItems.push(structuredClone(item)),
    registerSpell: (spell) => spells.push(spell.name),
    registerHook: (hook) => hooks.push(hook.condition),
    registerRewards: (items) => rewards.push(...items.map((item) => item.id)),
    registerKpNotes: (items) => Object.assign(kpNotes, items),
    registerSceneBgm: (items) => Object.assign(bgm, items),
    registerSceneAliases: (items) => Object.assign(aliases, items),
    applyInitialEffects: (items) => initialEffects.push(...items),
    addIntroNarration: (text) => messages.push(text),
  };
  return { host, scenes, runtimeNpcs, narrativeNpcs, richClues, richItems, itemPlacements, spells, tomes, hooks, rewards, messages, bgm, aliases, kpNotes, initialEffects };
}

describe("ModuleDataRuntimeLoader：直接读取统一 ModuleData", () => {
  it("custom module registry 的谷仓条目返回 ModuleData，不再返回 MythosModule 适配结果", () => {
    const entry = getModule("premiers_barn");
    expect(entry).toBeDefined();
    expect(entry?.module).toHaveProperty("scenes");
    expect(entry?.module).toHaveProperty("runtime");
    expect(entry?.module).not.toHaveProperty("sceneDescriptions");
    expect(entry?.module).toBe(BARN_OF_PREMIER);
  });

  it("不经 Mythos 适配，注册场景/ModuleData 连接/丰富线索/运行配置", () => {
    const capture = makeHost();
    const result = new ModuleDataRuntimeLoader(capture.host).import(BARN_OF_PREMIER);
    expect(result.entryScene).toBe("特里坎家");
    expect(capture.scenes).toHaveLength(21);
    expect(capture.scenes.flatMap((scene) => scene.exits)).toHaveLength(46);
    expect(capture.scenes.find((scene) => scene.id === "报亭")?.exits).toContainEqual({ target: "霍姆斯医院", desc: "根据报道前往霍姆斯医院" });
    expect(capture.scenes.find((scene) => scene.id === "与艾德里安的会面")?.description).toContain("喃喃出自己妻子与女儿的名字");
    expect(capture.scenes.find((scene) => scene.id === "证物室")?.description).toContain("防盗门钥匙、农场照片、钱包、驾照、手枪与电棒");
    expect(capture.scenes.find((scene) => scene.id === "旅店")?.description).not.toContain('。"\n\n"');
    expect(capture.scenes.find((scene) => scene.id === "维修间")?.description).toContain("青色按钮");
    expect(capture.runtimeNpcs).toHaveLength(11);
    expect(capture.narrativeNpcs.sort()).toEqual(["bar_receptionist", "hospital_staff", "newsstand_owner"]);
    expect(capture.richClues).toHaveLength(32);
    expect(BARN_OF_PREMIER.runtime).not.toHaveProperty("clueBindings");
    const brainJars = capture.richClues.find((entry) => entry.clue.id === "clue_final_brain_jars");
    expect(brainJars?.sceneId).toBe("维修间");
    expect(brainJars?.sanCost).toBe("1/1d6");
    const massBooking = capture.richClues.find((entry) => entry.clue.id === "clue_bar_mass_booking")?.clue;
    expect(massBooking?.matchTexts).toEqual(["包场", "登记", "免费饮品", "小费"]);
    expect(massBooking?.findMethods[0]?.difficulty).toBe("regular");
    expect(massBooking?.unlocks).toEqual(["clue_bar_guest_identity"]);
    expect(massBooking?.revelation).toContain("贵客包下了酒吧");
    expect(capture.richItems).toHaveLength(10);
    expect(capture.richItems.filter((item) => item.type === "trap")).toHaveLength(4);
    expect(capture.richItems.filter((item) => item.trap)).toHaveLength(3);
    expect(capture.richItems.find((item) => item.id === "trap_bear")?.trap?.damage).toBe("1D4+1");
    expect(capture.itemPlacements).toHaveLength(10);
    expect(capture.spells).toHaveLength(4);
    expect(capture.hooks).toHaveLength(34);
    expect(capture.rewards).toHaveLength(9);
    expect(capture.messages).toHaveLength(1);
    expect(Object.keys(capture.bgm)).toHaveLength(19);
    expect(capture.aliases["维修间"]).toEqual(["维修室"]);
    expect(Object.keys(capture.kpNotes)).toHaveLength(8);
    expect(result.narrative.endings).toHaveLength(5);
    expect(result.narrative.epilogues).toHaveLength(4);
    expect(result.narrative.prologue?.lines.length).toBeGreaterThan(0);
    expect(result.narrative.partySetup?.hooks).toHaveLength(2);
  });

  it("重复导入不重复注册或污染 host", () => {
    const capture = makeHost();
    const loader = new ModuleDataRuntimeLoader(capture.host);
    loader.import(BARN_OF_PREMIER);
    const again = loader.import(BARN_OF_PREMIER);
    expect(again.lines).toEqual(["模组「普瑞米尔的谷仓」已导入。"]);
    expect(capture.scenes).toHaveLength(21);
    expect(capture.richClues).toHaveLength(32);
    expect(capture.runtimeNpcs).toHaveLength(11);
  });

  it("host 中途失败不会标记 imported；第二次真正重试且不重复 hooks/messages/items", () => {
    const capture = makeHost();
    const registerHook = capture.host.registerHook;
    let failOnce = true;
    capture.host.registerHook = (hook) => {
      if (failOnce && hook.condition === "证物室") {
        failOnce = false;
        throw new Error("intentional mid-load failure");
      }
      registerHook(hook);
    };
    const loader = new ModuleDataRuntimeLoader(capture.host);
    expect(() => loader.import(BARN_OF_PREMIER)).toThrow("intentional mid-load failure");
    const retried = loader.import(BARN_OF_PREMIER);
    expect(retried.lines[0]).toBe("【统一模组：普瑞米尔的谷仓】");
    expect(capture.hooks).toHaveLength(34);
    expect(capture.messages).toHaveLength(1);
    expect(capture.itemPlacements).toHaveLength(10);
    expect(capture.richItems).toHaveLength(10);
    expect(capture.scenes).toHaveLength(21);
    expect(capture.richClues).toHaveLength(32);
  });

  it("结构预验证失败发生在任何 host 写入之前", () => {
    const capture = makeHost();
    const broken = structuredClone(BARN_OF_PREMIER);
    const firstScene = broken.scenes[0];
    if (!firstScene) throw new Error("fixture lacks first scene");
    firstScene.connections.push({ targetSceneId: "不存在场景", condition: "错误边" });
    expect(() => new ModuleDataRuntimeLoader(capture.host).import(broken)).toThrow("Scene.connection 悬空");
    expect(capture.scenes).toEqual([]);
    expect(capture.runtimeNpcs).toEqual([]);
    expect(capture.richClues).toEqual([]);
    expect(capture.hooks).toEqual([]);
    expect(capture.messages).toEqual([]);
  });

  it("拒绝嵌套 runtime NPC 指向另一叙事 NPC，且在任何 host 写入之前失败", () => {
    const capture = makeHost();
    const broken = structuredClone(BARN_OF_PREMIER);
    const phoebe = broken.npcs.find((npc) => npc.id === "phoebe_tricam");
    if (!phoebe?.runtime) throw new Error("fixture lacks Phoebe runtime NPC");
    // `sourceId` 是世界实体身份，不能等同 ModuleNPC.id；这里故意破坏的是
    // 叙事 counterpart 必须共享的名字/场景绑定。
    phoebe.runtime.sourceName = "加比·特里坎";
    phoebe.runtime.sceneId = "建筑内";

    expect(() => new ModuleDataRuntimeLoader(capture.host).import(broken)).toThrow("runtime NPC source binding conflicts");
    expect(capture.scenes).toEqual([]);
    expect(capture.runtimeNpcs).toEqual([]);
    expect(capture.narrativeNpcs).toEqual([]);
    expect(capture.richClues).toEqual([]);
    expect(capture.hooks).toEqual([]);
    expect(capture.messages).toEqual([]);
  });

  it("分别拒绝 runtime NPC 的姓名、场景和冒牌括号后缀绑定，且不写入 host", () => {
    const corruptions: Array<[string, (runtime: NonNullable<(typeof BARN_OF_PREMIER.npcs)[number]["runtime"]>) => void]> = [
      ["name-only", (runtime) => { runtime.sourceName = "加比·特里坎"; }],
      ["scene-only", (runtime) => { runtime.sceneId = "建筑内"; }],
      ["impostor parenthetical name", (runtime) => { runtime.sourceName = "菲碧·特里坎（冒牌者）"; }],
      ["Phoebe cannot borrow the Mi-Go display suffix", (runtime) => { runtime.sourceName = "菲碧·特里坎（来自尤格斯的真菌）"; }],
    ];
    for (const [label, corrupt] of corruptions) {
      const capture = makeHost();
      const broken = structuredClone(BARN_OF_PREMIER);
      const phoebe = broken.npcs.find((npc) => npc.id === "phoebe_tricam");
      if (!phoebe?.runtime) throw new Error("fixture lacks Phoebe runtime NPC");
      corrupt(phoebe.runtime);

      expect(() => new ModuleDataRuntimeLoader(capture.host).import(broken), label).toThrow("runtime NPC source binding conflicts");
      expect(capture.scenes, label).toEqual([]);
      expect(capture.runtimeNpcs, label).toEqual([]);
      expect(capture.narrativeNpcs, label).toEqual([]);
      expect(capture.richClues, label).toEqual([]);
      expect(capture.hooks, label).toEqual([]);
      expect(capture.messages, label).toEqual([]);
    }
  });

  it("accepts the verified Barn Mi-Go display counterpart without creating a general parenthetical alias", () => {
    const miGo = BARN_OF_PREMIER.npcs.find((npc) => npc.id === "mi_go");
    expect(miGo?.name).toBe("Mi-Go（来自尤格斯的真菌）");
    expect(miGo?.runtime?.sourceName).toBe("Mi-Go");

    const capture = makeHost();
    new ModuleDataRuntimeLoader(capture.host).import(BARN_OF_PREMIER);
    expect(capture.runtimeNpcs).toContain("mi-go");
  });

  it("拒绝缺失或畸形的 ModuleNPC knowledge，且在任何 host 写入之前失败", () => {
    const corruptions: Array<[string, (npc: { knowledge?: unknown }) => void]> = [
      ["missing", (npc) => { Reflect.deleteProperty(npc, "knowledge"); }],
      ["string", (npc) => { npc.knowledge = "不是数组"; }],
      ["null", (npc) => { npc.knowledge = null; }],
      ["object entry", (npc) => { npc.knowledge = ["有效事实", { fabricated: true }]; }],
    ];
    for (const [label, corrupt] of corruptions) {
      const capture = makeHost();
      const broken = structuredClone(BARN_OF_PREMIER);
      const phoebe = broken.npcs.find((npc) => npc.id === "phoebe_tricam");
      if (!phoebe) throw new Error("fixture lacks Phoebe narrative NPC");
      corrupt(phoebe as unknown as { knowledge?: unknown });

      expect(() => new ModuleDataRuntimeLoader(capture.host).import(broken), label).toThrow("ModuleNPC.knowledge must be an array of strings");
      expect(capture.scenes, label).toEqual([]);
      expect(capture.runtimeNpcs, label).toEqual([]);
      expect(capture.narrativeNpcs, label).toEqual([]);
      expect(capture.richClues, label).toEqual([]);
      expect(capture.hooks, label).toEqual([]);
      expect(capture.messages, label).toEqual([]);
    }
  });

  it("ambiguous pickup names are refused before the first host write", () => {
    const locationConflict = structuredClone(BARN_OF_PREMIER);
    const oldDocument = locationConflict.items.find((item) => item.name === "老旧文件");
    if (!oldDocument) throw new Error("fixture lacks old document");
    locationConflict.items.push({ ...oldDocument, id: "old_document_elsewhere", sceneId: "农场外围" });
    const refusedLocation = makeHost();
    expect(() => new ModuleDataRuntimeLoader(refusedLocation.host).import(locationConflict)).toThrow("location conflicts");
    expect(refusedLocation.scenes).toEqual([]);
    expect(refusedLocation.itemPlacements).toEqual([]);
    expect(refusedLocation.richItems).toEqual([]);

    const semanticConflict = structuredClone(BARN_OF_PREMIER);
    const source = semanticConflict.items.find((item) => item.name === "老旧文件");
    if (!source) throw new Error("fixture lacks old document");
    semanticConflict.items.push({ ...source, id: "old_document_trap", type: "trap" });
    const refusedSemantic = makeHost();
    expect(() => new ModuleDataRuntimeLoader(refusedSemantic.host).import(semanticConflict)).toThrow("semantics conflict");
    expect(refusedSemantic.scenes).toEqual([]);
    expect(refusedSemantic.itemPlacements).toEqual([]);
    expect(refusedSemantic.richItems).toEqual([]);

    const orphanedOrigin = structuredClone(BARN_OF_PREMIER);
    orphanedOrigin.items.push({
      id: "orphaned_pickup",
      name: "孤立钥匙",
      sceneId: "不存在的场景",
      description: "没有真实场景的物品不能成为可拾取来源。",
      type: "key",
    });
    const refusedOrphan = makeHost();
    expect(() => new ModuleDataRuntimeLoader(refusedOrphan.host).import(orphanedOrigin)).toThrow("does not name a declared scene");
    expect(refusedOrphan.scenes).toEqual([]);
    expect(refusedOrphan.itemPlacements).toEqual([]);
    expect(refusedOrphan.richItems).toEqual([]);
  });

  it("direct loader registers a verified tome declaration and rejects conflicting names before host writes", () => {
    const valid = structuredClone(BARN_OF_PREMIER);
    valid.runtime!.tomes = [{
      name: "验证典籍",
      sceneId: valid.scenes[0]!.id,
      sanCost: "1/1d4",
      tomeRating: 4,
      spells: [],
      openDescription: "由统一运行模组声明的验证典籍。",
    }];
    const accepted = makeHost();
    new ModuleDataRuntimeLoader(accepted.host).import(valid);
    expect(accepted.tomes).toEqual(["验证典籍"]);

    const conflicting = structuredClone(valid);
    conflicting.runtime!.tomes!.push({ ...conflicting.runtime!.tomes![0]!, sceneId: valid.scenes[1]!.id });
    const refused = makeHost();
    expect(() => new ModuleDataRuntimeLoader(refused.host).import(conflicting)).toThrow("tome declaration conflicts");
    expect(refused.scenes).toEqual([]);
    expect(refused.tomes).toEqual([]);
  });

  it("direct loader rejects unsafe tome execution fields before every host write", () => {
    const invalidations: Array<[string, (tome: RuntimeModuleTome) => void]> = [
      ["zero rating", (tome) => { tome.tomeRating = 0; }],
      ["fractional rating", (tome) => { tome.tomeRating = 1.5; }],
      ["over-max rating", (tome) => { tome.tomeRating = 100; }],
      ["malformed SAN cost", (tome) => { tome.sanCost = "abc"; }],
      ["unbounded SAN dice", (tome) => { tome.sanCost = "1d1000001/0"; }],
      ["duplicate spell names", (tome) => { tome.spells = ["测试法术", "测试法术"]; }],
    ];

    for (const [label, invalidate] of invalidations) {
      const module = structuredClone(BARN_OF_PREMIER);
      module.runtime!.tomes = [{
        name: "验证典籍",
        sceneId: module.scenes[0]!.id,
        sanCost: "1/1d4",
        tomeRating: 4,
        spells: ["测试法术"],
        openDescription: "由统一运行模组声明的验证典籍。",
      }];
      invalidate(module.runtime!.tomes![0]!);
      const capture = makeHost();

      expect(() => new ModuleDataRuntimeLoader(capture.host).import(module), label).toThrow();
      expect(capture.scenes, label).toEqual([]);
      expect(capture.tomes, label).toEqual([]);
      expect(capture.spells, label).toEqual([]);
      expect(capture.richClues, label).toEqual([]);
    }
  });

  it("覆盖可选 initialEffects 字段，不因真实谷仓当前为空而形成盲点", () => {
    const capture = makeHost();
    const module = structuredClone(BARN_OF_PREMIER);
    module.runtime!.initialEffects = [{ target: "test", field: "flag", value: { nested: true } }];
    new ModuleDataRuntimeLoader(capture.host).import(module);
    expect(capture.initialEffects).toEqual([{ target: "test", field: "flag", value: { nested: true } }]);
  });

  it("结构判据：direct loader 不 import MythosModule，不能偷偷走旧路径", () => {
    const imports = scanImports(readFileSync("src/module/module-data-runtime-loader.ts", "utf8"));
    expect(imports.some((entry) => importPointsTo(entry.path, "mythos-module"))).toBe(false);
  });
});
