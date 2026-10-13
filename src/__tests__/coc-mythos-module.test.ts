// 神话模组系统单元测试
// bun test src/__tests__/coc-mythos-module.test.ts

import { describe, it, expect } from "bun:test";
import {
  MythosModuleLoader,
  createMythosEntity,
  MYTHOS_CREATURE_MAP,
  MYTHOS_CREATURE_BY_ID,
  ARKHAM_LIBRARY_MODULE,
  type MythosModule,
  type MythosModuleHost,
} from "../rules/mythos-module";
import { MYTHOS_CREATURES, MYTHOS_TOMES, MYTHOS_SPELLS } from "../rules/mythos-expansion";
import type { MessageType } from "../agent/types";

// ============================================================
// MYTHOS_CREATURE_MAP — 生物名索引
// ============================================================

describe("MYTHOS_CREATURE_MAP", () => {
  // ⚠ 这条原先叫「所有 8 个生物均可通过中文名查到」，遍历的是测试里手写的 8 个名字。
  //   而 `MYTHOS_CREATURES` 现在有 **40 个** —— 数据从 8 涨到 40，标题里的「所有」
  //   早就不成立了，测试实际只覆盖两成。新加的生物漏建名字索引，这条一声不吭。
  //
  //   改成遍历真实数据。数量也一并钉住：表膨胀或缩水都该有人知道，
  //   而不是等某天索引漏了才在运行时查不到。
  it("每个生物都能通过中文名查到", () => {
    expect(MYTHOS_CREATURES.length).toBe(40);
    expect(MYTHOS_CREATURE_MAP.size).toBe(MYTHOS_CREATURES.length);
    for (const c of MYTHOS_CREATURES) {
      expect(MYTHOS_CREATURE_MAP.get(c.name)).toBeDefined();
    }
  });

  it("每个生物都能通过 id 查到", () => {
    const expectedIds = ["deep_one", "shoggoth", "nightgaunt", "hound_of_tindalos", "byakhee", "dimensional_shambler", "star_vampire", "mi_go"];
    for (const id of expectedIds) {
      expect(MYTHOS_CREATURE_BY_ID.get(id)).toBeDefined();
    }
  });

  it("MYTHOS_CREATURES 数据完整性 — 每只生物都有必填字段", () => {
    for (const c of MYTHOS_CREATURES) {
      expect(c.hp).toBeGreaterThan(0);
      expect(c.maxHp).toBeGreaterThan(0);
      expect(c.ac).toBeGreaterThan(0);
      expect(c.str).toBeGreaterThan(0);
      expect(c.damage).toBeTruthy();
      expect(c.sanLoss).toMatch(/\d+d\d+/);
      expect(c.description.length).toBeGreaterThan(10);
    }
  });

  it("不存在的生物名查询返回 undefined", () => {
    expect(MYTHOS_CREATURE_MAP.get("不存在")).toBeUndefined();
    expect(MYTHOS_CREATURE_BY_ID.get("nope")).toBeUndefined();
  });
});

// ============================================================
// createMythosEntity — 生物→世界实体转换
// ============================================================

describe("createMythosEntity", () => {
  it("通过生物 id 深潜者创建实体应有正确 HP/AC/名字", () => {
    const entity = createMythosEntity("deep_one", "innsmouth_docks");
    expect(entity.name).toBe("深潜者");
    expect(entity.type).toBe("monster");
    expect(entity.hp).toBe(15);
    expect(entity.maxHp).toBe(15);
    expect(entity.ac).toBe(13);
    expect(entity.position).toBe("innsmouth_docks");
    expect(entity.faction).toBe("神话生物");
  });

  it("通过中文名创建修格斯实体", () => {
    const entity = createMythosEntity("修格斯", "basement", "远古者造物");
    expect(entity.name).toBe("修格斯");
    expect(entity.hp).toBe(70);
    expect(entity.maxHp).toBe(70);
    expect(entity.ac).toBe(8);
    expect(entity.faction).toBe("远古者造物");
  });

  it("创建的实体 id 应为唯一（时间戳后缀）", () => {
    const e1 = createMythosEntity("byakhee", "sky");
    const e2 = createMythosEntity("byakhee", "sky");
    expect(e1.id).not.toBe(e2.id);
  });

  it("不存在的生物 id 应抛异常", () => {
    expect(() => createMythosEntity("不存在", "scene")).toThrow();
  });

  it("实体包含完整 stats 备份供战斗使用", () => {
    const entity = createMythosEntity("star_vampire", "temple");
    expect(entity.stats.str).toBe(14);
    expect(entity.stats.damage).toBe("1d6");
    expect(entity.stats.abilities.length).toBeGreaterThan(0);
  });
});

// ============================================================
// MythosModuleLoader — 模组导入逻辑
// ============================================================

/** 测试用 mock host */
function createMockHost(): MythosModuleHost & {
  registeredSpells: Map<string, { sanCost: string; mpCost: number; description: string; effect?: string }>;
} {
  const spellMap = new Map<string, { sanCost: string; mpCost: number; description: string; effect?: string }>();
  const sceneItems = new Map<string, string[]>();
  const itemDescriptions = new Map<string, string>();
  const messages: Array<{ s: string; c: string; t: string }> = [];

  return {
    registeredSpells: spellMap,
    registerSpell(spell) {
      if (spellMap.has(spell.name)) return false;
      spellMap.set(spell.name, {
        sanCost: spell.sanCost,
        mpCost: spell.mpCost,
        description: spell.description,
        effect: spell.effectType,
      });
      return true;
    },
    registerTome(tome) {
      const items = sceneItems.get(tome.sceneId) ?? [];
      if (!items.includes(tome.name)) items.push(tome.name);
      sceneItems.set(tome.sceneId, items);
    },
    sceneItems,
    itemDescriptions,
    world: {
      upsertEntity(_e: any) { /* mock */ },
      logEvent(_p: any) { /* mock */ },
    },
    addMessage(speaker: string, content: string, type: MessageType) {
      messages.push({ s: speaker, c: content, t: type });
    },
    activeRuleset: "cosmic-horror",
    currentRound: 1,
  };
}

describe("MythosModuleLoader", () => {
  it("does not swallow a real scene-exit database write failure into a fake imported success", () => {
    const host = createMockHost();
    const module = structuredClone(ARKHAM_LIBRARY_MODULE);
    module.exits = { arkham_miskatonic: [{ target: "arkham_library_vault" }] };
    (host.world as any).getDatabase = () => ({
      query: () => ({ get: () => ({ exits: "[]" }) }),
      run: () => { throw new Error("intentional Mythos exit database failure"); },
    });
    const loader = new MythosModuleLoader(host);

    expect(() => loader.import(module)).toThrow("intentional Mythos exit database failure");
    expect(loader.isImported(module.id)).toBe(false);
  });

  it("does not pre-mark a Mythos package imported when registerScene throws midway, so retry is real", () => {
    const host = createMockHost();
    const registered: string[] = [];
    let failOnce = true;
    host.registerScene = (sceneId) => {
      registered.push(sceneId);
      if (failOnce && registered.length === 2) {
        failOnce = false;
        throw new Error("intentional Mythos registerScene failure");
      }
    };
    const loader = new MythosModuleLoader(host);

    expect(() => loader.import(ARKHAM_LIBRARY_MODULE)).toThrow("intentional Mythos registerScene failure");
    expect(loader.isImported(ARKHAM_LIBRARY_MODULE.id)).toBe(false);
    const retried = loader.import(ARKHAM_LIBRARY_MODULE);
    expect(retried[0]).not.toContain("\u5df2\u5bfc\u5165");
    expect(loader.isImported(ARKHAM_LIBRARY_MODULE.id)).toBe(true);
    expect(registered.length).toBeGreaterThan(2);
  });

  it("rejects malformed legacy input before imported state or host writes", () => {
    const host = createMockHost();
    let writes = 0;
    host.world.upsertEntity = () => { writes++; };
    host.addMessage = () => { writes++; };
    const malformed = structuredClone(ARKHAM_LIBRARY_MODULE) as MythosModule;
    malformed.spells = [{} as NonNullable<MythosModule["spells"]>[number]];
    const loader = new MythosModuleLoader(host);

    expect(() => loader.import(malformed)).toThrow("spells");
    expect(loader.isImported(malformed.id)).toBe(false);
    expect(writes).toBe(0);
  });

  it("rejects conflicting same-name tome declarations before any host placement", () => {
    const host = createMockHost();
    let writes = 0;
    host.registerSpell = () => { writes++; return true; };
    host.registerTome = () => { writes++; };
    host.world.upsertEntity = () => { writes++; };
    host.addMessage = () => { writes++; };
    const conflicting = structuredClone(ARKHAM_LIBRARY_MODULE);
    conflicting.tomes = [
      ...conflicting.tomes!,
      { ...conflicting.tomes![0]!, sceneId: "arkham_miskatonic" },
    ];

    const loader = new MythosModuleLoader(host);
    expect(() => loader.import(conflicting)).toThrow("tome declaration conflicts");
    expect(loader.isImported(conflicting.id)).toBe(false);
    expect(writes).toBe(0);
    expect(host.sceneItems.size).toBe(0);
  });

  it("rejects non-executable tome fields before every legacy host write", () => {
    const invalidations: Array<[string, (tome: NonNullable<MythosModule["tomes"]>[number]) => void]> = [
      ["zero rating", (tome) => { tome.tomeRating = 0; }],
      ["fractional rating", (tome) => { tome.tomeRating = 1.5; }],
      ["over-max rating", (tome) => { tome.tomeRating = 100; }],
      ["malformed SAN cost", (tome) => { tome.sanCost = "abc"; }],
      ["unbounded SAN dice", (tome) => { tome.sanCost = "1d1000001/0"; }],
      ["duplicate spell names", (tome) => { tome.spells = ["接触远古者", "接触远古者"]; }],
    ];

    for (const [label, invalidate] of invalidations) {
      const host = createMockHost();
      let writes = 0;
      host.registerSpell = () => { writes++; return true; };
      host.registerTome = () => { writes++; };
      host.world.upsertEntity = () => { writes++; };
      host.addMessage = () => { writes++; };
      host.registerScene = () => { writes++; };
      const module = structuredClone(ARKHAM_LIBRARY_MODULE);
      invalidate(module.tomes![0]!);

      expect(() => new MythosModuleLoader(host).import(module), label).toThrow();
      expect(writes, label).toBe(0);
      expect(host.sceneItems.size, label).toBe(0);
    }
  });

  it("accepts exact duplicate tome declarations without duplicate physical placement", () => {
    const host = createMockHost();
    const duplicate = structuredClone(ARKHAM_LIBRARY_MODULE);
    duplicate.tomes = [...duplicate.tomes!, structuredClone(duplicate.tomes![0]!)];
    let calls = 0;
    const register = host.registerTome;
    host.registerTome = (tome) => { calls++; register(tome); };

    new MythosModuleLoader(host).import(duplicate);
    expect(calls).toBe(2);
    expect(host.sceneItems.get("arkham_library_vault")).toEqual(["塞拉伊诺断章"]);
  });

  it("导入模组后 importedModules 包含该模组 id", () => {
    const host = createMockHost();
    const loader = new MythosModuleLoader(host);

    loader.import(ARKHAM_LIBRARY_MODULE);
    expect(loader.importedModules).toContain("arkham_miskatonic");
  });

  it("重复导入同一模组应跳过", () => {
    const host = createMockHost();
    const loader = new MythosModuleLoader(host);

    loader.import(ARKHAM_LIBRARY_MODULE);
    const r2 = loader.import(ARKHAM_LIBRARY_MODULE);

    // 第二次导入后 importedModules 应只有 1 个
    expect(loader.importedModules.length).toBe(1);
    expect(r2.some(l => l.includes("已导入"))).toBe(true);
  });

  it("导入模组后经受限注册契约写入法术定义", () => {
    const host = createMockHost();
    const loader = new MythosModuleLoader(host);

    loader.import(ARKHAM_LIBRARY_MODULE);

    expect(host.registeredSpells.has("阿卡姆档案检索")).toBe(true);
    const spell = host.registeredSpells.get("阿卡姆档案检索")!;
    expect(spell.mpCost).toBe(1);
    expect(spell.sanCost).toBe("0/1d2");
  });

  it("导入模组后典籍放置到场景物品", () => {
    const host = createMockHost();
    const loader = new MythosModuleLoader(host);

    loader.import(ARKHAM_LIBRARY_MODULE);

    const vaultItems = host.sceneItems.get("arkham_library_vault");
    expect(vaultItems).toBeDefined();
    expect(vaultItems!.includes("塞拉伊诺断章")).toBe(true);
  });

  it("导入模组后物品放置到指定场景", () => {
    const host = createMockHost();
    const loader = new MythosModuleLoader(host);

    loader.import(ARKHAM_LIBRARY_MODULE);

    const libItems = host.sceneItems.get("arkham_miskatonic");
    expect(libItems).toBeDefined();
    expect(libItems!.includes("特别书库借阅证")).toBe(true);
  });

  it("autoActivate 在匹配类型+条件时自动导入模组", () => {
    const host = createMockHost();
    const loader = new MythosModuleLoader(host);

    const modules = [ARKHAM_LIBRARY_MODULE];
    const results = loader.autoActivate(modules, "location_enter", "arkham_miskatonic");

    expect(loader.isImported("arkham_miskatonic")).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("autoActivate 不匹配时不导入", () => {
    const host = createMockHost();
    const loader = new MythosModuleLoader(host);

    const modules = [ARKHAM_LIBRARY_MODULE];
    loader.autoActivate(modules, "location_enter", "somewhere_else");

    expect(loader.isImported("arkham_miskatonic")).toBe(false);
  });

  it("isImported 返回正确状态", () => {
    const host = createMockHost();
    const loader = new MythosModuleLoader(host);

    expect(loader.isImported("arkham_miskatonic")).toBe(false);
    loader.import(ARKHAM_LIBRARY_MODULE);
    expect(loader.isImported("arkham_miskatonic")).toBe(true);
  });
});

// ============================================================
// 模组 NPC 生成 — mythosCreatureId 集成
// ============================================================

describe("MythosModuleLoader NPC 生成", () => {
  it("NPC 指定 mythosCreatureId 时仍以模组明确属性为准", () => {
    const host = createMockHost();
    const upserted: any[] = [];
    host.world.upsertEntity = (e: any) => { upserted.push(e); };
    const loader = new MythosModuleLoader(host);

    const module: MythosModule = {
      id: "test_npc",
      name: "测试NPC",
      version: "1",
      description: "",
      difficulty: "easy",
      activation: { type: "manual", condition: "" },
      npcs: [{
        id: "test_deep_one",
        name: "深潜者斥候",
        type: "monster",
        hp: 11,
        maxHp: 11,
        ac: 10,
        faction: "神话生物",
        sceneId: "dock",
        mythosCreatureId: "deep_one",
      }],
    };

    loader.import(module);

    expect(upserted.length).toBe(1);
    const entity = upserted[0];
    expect(entity.hp).toBe(11);       // 模组显式遭遇值高于通用生物目录
    expect(entity.maxHp).toBe(11);
    expect(entity.ac).toBe(10);
    expect(entity.name).toBe("深潜者斥候"); // name 保持模组自定义
  });

  it("NPC 不指定 mythosCreatureId 时使用模组原始属性", () => {
    const host = createMockHost();
    const upserted: any[] = [];
    host.world.upsertEntity = (e: any) => { upserted.push(e); };
    const loader = new MythosModuleLoader(host);

    const module: MythosModule = {
      id: "test_npc2",
      name: "测试普通NPC",
      version: "1",
      description: "",
      difficulty: "easy",
      activation: { type: "manual", condition: "" },
      npcs: [{
        id: "test_human",
        name: "普通村民",
        type: "npc",
        hp: 8,
        maxHp: 8,
        ac: 10,
        faction: "友善",
        sceneId: "village",
      }],
    };

    loader.import(module);

    expect(upserted[0].hp).toBe(8);
    expect(upserted[0].ac).toBe(10);
    expect(upserted[0].faction).toBe("友善");
  });

  it("NPC 属性与技能应被转发到 upsertEntity 有效载荷", () => {
    const host = createMockHost();
    const upserted: Parameters<MythosModuleHost["world"]["upsertEntity"]>[0][] = [];
    host.world.upsertEntity = (entity) => upserted.push(entity);
    const loader = new MythosModuleLoader(host);

    const module: MythosModule = {
      id: "test_npc_attrs",
      name: "属性技能测试",
      version: "1",
      description: "",
      difficulty: "easy",
      activation: { type: "manual", condition: "" },
      npcs: [{
        id: "scholar",
        name: "学者",
        type: "npc",
        hp: 6,
        maxHp: 6,
        ac: 10,
        faction: "学者",
        sceneId: "library",
        attributes: { str: 8 },
        skills: { "侦查": 60 },
      }],
    };

    loader.import(module);

    expect(upserted[0]?.attributes).toEqual({ str: 8 });
    expect(upserted[0]?.skills).toEqual({ "侦查": 60 });
  });
});

// ============================================================
// 预打包模组数据完整性
// ============================================================

describe("预打包模组数据完整性", () => {
  it("ARKHAM_LIBRARY_MODULE 包含必填字段", () => {
    expect(ARKHAM_LIBRARY_MODULE.id).toBeTruthy();
    expect(ARKHAM_LIBRARY_MODULE.name).toBeTruthy();
    expect(ARKHAM_LIBRARY_MODULE.activation.type).toBe("location_enter");
    expect(ARKHAM_LIBRARY_MODULE.introNarration).toBeTruthy();
    expect(ARKHAM_LIBRARY_MODULE.tomes!.length).toBeGreaterThan(0);
    expect(ARKHAM_LIBRARY_MODULE.spells!.length).toBeGreaterThan(0);
    expect(ARKHAM_LIBRARY_MODULE.npcs!.length).toBeGreaterThan(0);
  });
});

// ============================================================
// MYTHOS_TOMES 数据完整性
// ============================================================

describe("MYTHOS_TOMES 数据完整性", () => {
  it("全部 5 本典籍都有必填字段", () => {
    for (const t of MYTHOS_TOMES) {
      expect(t.name).toBeTruthy();
      expect(t.sanCost).toMatch(/\d/);
      expect(t.studyTime).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it("死灵之书应有 7 个可教授法术", () => {
    const necro = MYTHOS_TOMES.find(t => t.id === "necronomicon");
    expect(necro).toBeDefined();
    expect(necro!.spellsTaught.length).toBe(7);
  });
});

// ============================================================
// MYTHOS_SPELLS 数据完整性
// ============================================================

describe("MYTHOS_SPELLS 数据完整性", () => {
  it("全部法术都有必填字段", () => {
    for (const s of MYTHOS_SPELLS) {
      expect(s.name).toBeTruthy();
      expect(s.mpCost).toBeGreaterThan(0);
      expect(s.sanCost).toMatch(/\d/);
      expect(s.description.length).toBeGreaterThan(10);
    }
  });
});
