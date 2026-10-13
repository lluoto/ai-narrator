/**
 * 剧本杀式神话模组导入系统 — MythosModuleLoader
 * ============================================================
 *
 * 功能：将克苏鲁神话扩展数据打包为"剧本杀"模组，一键导入到游戏会话中。
 *
 * 使用方式：
 *   const loader = new MythosModuleLoader(session);
 *   loader.import(INSMOUTH_MODULE);
 *
 * 模组可以包含：
 *   - 法术注册（供典籍研读/施法）
 *   - 典籍放置（场景物品，可读可学）
 *   - 起始物品（场景物品）
 *   - NPC/生物（世界状态实体）
 *   - 激活条件（何时自动导入）
 *   - 触发叙事（导入时的KP旁白）
 *
 * 设计原则：
 *   - 惰性注册：法术只在模组导入时注册到 mythosSpells，不预加载
 *   - 确定查表：所有内容走数据表，不依赖LLM
 *   - 可叠放：多个模组可叠加导入，互不冲突
 */

import type { Database } from "bun:sqlite";
import type { MessageType, NPCMood } from "../agent/types";
import type { MythosCreature } from "./mythos-expansion";
import { MYTHOS_CREATURES } from "./mythos-expansion";
// 与 WorldStateManager 读 exits 用的是**同一份**解析（见该文件顶部说明）
import { parseExits, mergeExits } from "../state/scene-exits";
import {
  normalizeRuntimeModulePickupOrigins,
  normalizeRuntimeModuleTomes,
  type RuntimeClueBinding,
  type RuntimeInitialEffect,
  type RuntimeItemPlacement,
  type RuntimeModuleEnding,
  type RuntimeModuleHook,
  type RuntimeModuleReward,
  type RuntimeModuleSpell,
  type RuntimeModuleTome,
  type RuntimeNpcConfig,
} from "../module/runtime-types";

// ============================================================
// 模组类型定义
// ============================================================

// Shared runtime data types live in module/runtime-types.ts so ModuleData can
// reference them without importing this loader module. Re-export the historical Mythos
// names to avoid breaking external type consumers while keeping their semantics explicit.
export type ModuleSpell = RuntimeModuleSpell;
export type ModuleTome = RuntimeModuleTome;
export type ModuleEnding = RuntimeModuleEnding;
export type ModuleReward = RuntimeModuleReward;
export type ModuleItem = RuntimeItemPlacement;
export type ModuleNPC = RuntimeNpcConfig & {
  id: string;
  name: string;
  sceneId: string;
  age?: number;
};

/** 剧本杀模组 */
export interface MythosModule {
  /** 模组唯一标识 */
  id: string;
  /** 模组名 */
  name: string;
  /** 版本 */
  version: string;
  /** 简介 */
  description: string;
  /** 难度 */
  difficulty: "easy" | "medium" | "hard" | "nightmare";
  /** 原著出处 */
  source?: string;
  /** 模组激活方式 */
  activation: {
    type: "manual" | "location_enter" | "item_found" | "read_tome" | "san_threshold";
    /** 激活条件（如 location_enter 时为场景ID，item_found 时为物品名） */
    condition: string;
  };
  /** 场景出口映射（场景ID → 可到达的场景列表），覆盖全连接默认逻辑 */
  exits?: Record<string, Array<{ target: string; desc?: string }>>;
  /** 场景描述映射（场景ID → 描述文本），在 registerScene 时传入 */
  sceneDescriptions?: Record<string, string>;
  /**
   * 场景配乐映射（场景ID → 音轨标识）。
   *
   * 只存标识不存路径：路径拼装是前端的事，模组不该关心资源目录结构。
   * 缺省或找不到对应音频时前端静默不放，不影响任何叙事流程。
   */
  sceneBgm?: Record<string, string>;
  /**
   * 场景别名映射（场景 id → 玩家可能用来指代它的别的说法）。
   *
   * 背景：`registerScene(sid, sid, ...)` 只登记场景自己的展示名一个
   * 别名（见 game-session.ts `sceneAliases[r.id] = [r.name]`），但模组
   * 自己的叙事文本有时会用另一个词称呼同一个场景（比如"下水道维修室"
   * 与场景正式名"维修间"），玩家读完叙事之后自然会用叙事教的那个词，
   * 而不是场景表里的正式名——这是"引擎教了玩家一个自己不认识的词"
   * 这个模式（`docs/notes/engine.md`）在场景解析这一侧的入口。
   *
   * 与 `sceneBgm` 同一种形状（场景 id 为键），加载时按同一种方式合并
   * 进运行时状态（`Object.assign`），不新造一套接线方式。
   */
  sceneAliases?: Record<string, string[]>;
  /** 模组激活时的KP旁白 */
  introNarration?: string;
  /** 注册到 mythosSpells 的法术 */
  spells?: ModuleSpell[];
  /** 放置在场景中的典籍 */
  tomes?: ModuleTome[];
  /** 放置在场景中的物品 */
  items?: ModuleItem[];
  /** 在世界中生成的NPC/生物 */
  npcs?: ModuleNPC[];
  /** 模组激活时的一些特殊状态变更 */
  initialEffects?: RuntimeInitialEffect[];

  // ── 调查线索 ──
  /** 注册到 investigation engine 的线索 */
  clues?: RuntimeClueBinding[];

  // ── 场景事件钩子 ──
  /**
   * 场景事件钩子 — 玩家触发特定条件时自动执行
   * type: 触发类型
   *   on_enter_scene: 进入场景时触发
   *   on_combat_start: 战斗开始时触发
   *   on_read_tome: 阅读特定典籍时触发
   *   on_investigate: 调查特定线索时触发
   * condition: 触发条件（场景名/典籍名/线索ID）
   * narration: KP 旁白文本
   * effect: 额外效果描述（非功能性，仅用于提示）
   */
  hooks?: RuntimeModuleHook[];

  // ── 结局与奖励 ──
  /** 模组结局列表 */
  endings?: ModuleEnding[];
  /** 奖励规则列表（根据调查员行为触发的 SAN/CM/信誉/技能变化） */
  rewards?: ModuleReward[];

  // ── KP 灵活干涉指引（LLM KP 运行时查阅） ──
  /**
   * KP 灵活干涉指引：标记模块中哪些地方 KP（特别是 LLM KP）可以灵活调整。
   *
   * key 约定:
   *   "sceneName"         → 进入该场景时可用的指引
   *   "sceneName:detail"  → 场景内特定元素（NPC/物品/陷阱）的指引
   *   "__global__"        → 模块全局指引（开团准备、难度调整等）
   *   "__ending:type"     → 特定结局的条件/奖励说明
   *   "__npc:npcId"       → 针对特定 NPC 的扮演指引
   *
   * value: 自由文本，LLM 直接读取作为 KP 裁量依据。
   */
  kpNotes?: Record<string, string>;
}

function isMythosModuleRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMythosModuleText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function mythosModuleEntries(module: Record<string, unknown>, key: string): unknown[] {
  const value = module[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Pure preflight shared by the session package boundary and this legacy
 * representation. It deliberately validates only loader-consumed structure;
 * it does not change MythosModuleLoader's historical write atomicity.
 */
export function assertMythosModuleForInstall(value: unknown): asserts value is MythosModule {
  if (!isMythosModuleRecord(value)) throw new Error("MythosModule must be an object");
  for (const key of ["id", "name", "version"]) {
    if (!isMythosModuleText(value[key])) throw new Error(`MythosModule ${key} must be non-blank text`);
  }
  if (typeof value.description !== "string") throw new Error("MythosModule description must be text");
  if (!(["easy", "medium", "hard", "nightmare"] as string[]).includes(value.difficulty as string)) throw new Error("MythosModule difficulty is invalid");
  if (!isMythosModuleRecord(value.activation)
    || !(["manual", "location_enter", "item_found", "read_tome", "san_threshold"] as string[]).includes(value.activation.type as string)
    || typeof value.activation.condition !== "string") throw new Error("MythosModule activation is invalid");
  for (const key of ["spells", "tomes", "items", "npcs", "clues", "hooks", "endings", "rewards", "initialEffects"]) {
    if (value[key] !== undefined && !Array.isArray(value[key])) throw new Error(`MythosModule ${key} must be an array`);
  }
  for (const key of ["sceneDescriptions", "sceneBgm", "sceneAliases", "kpNotes", "exits"]) {
    if (value[key] !== undefined && !isMythosModuleRecord(value[key])) throw new Error(`MythosModule ${key} must be an object`);
  }
  for (const [sceneId, exits] of Object.entries(value.exits ?? {})) {
    if (!isMythosModuleText(sceneId) || !Array.isArray(exits) || exits.some((exit) => !isMythosModuleRecord(exit) || !isMythosModuleText(exit.target))) {
      throw new Error("MythosModule exits contain an invalid entry");
    }
  }
  for (const [mapName, map] of [["sceneDescriptions", value.sceneDescriptions], ["sceneBgm", value.sceneBgm], ["kpNotes", value.kpNotes]] as const) {
    if (map !== undefined && (!isMythosModuleRecord(map) || Object.values(map).some((entry) => !isMythosModuleText(entry)))) throw new Error(`MythosModule ${mapName} contains an invalid entry`);
  }
  if (value.sceneAliases !== undefined && (!isMythosModuleRecord(value.sceneAliases) || Object.values(value.sceneAliases).some((aliases) => !Array.isArray(aliases) || aliases.some((alias) => !isMythosModuleText(alias))))) {
    throw new Error("MythosModule sceneAliases contains an invalid entry");
  }
  for (const spell of mythosModuleEntries(value, "spells")) {
    if (!isMythosModuleRecord(spell) || !isMythosModuleText(spell.name) || !isMythosModuleText(spell.sanCost) || typeof spell.mpCost !== "number" || !isMythosModuleText(spell.description)) {
      throw new Error("MythosModule spells contain an invalid entry");
    }
  }
  normalizeRuntimeModuleTomes(value.tomes);
  normalizeRuntimeModulePickupOrigins({ tomes: value.tomes, itemPlacements: value.items });
  for (const item of mythosModuleEntries(value, "items")) {
    if (!isMythosModuleRecord(item) || !isMythosModuleText(item.name) || !isMythosModuleText(item.sceneId)) throw new Error("MythosModule items contain an invalid entry");
  }
  for (const npc of mythosModuleEntries(value, "npcs")) {
    if (!isMythosModuleRecord(npc) || !isMythosModuleText(npc.id) || !isMythosModuleText(npc.name)
      || !["npc", "monster"].includes(npc.type as string) || typeof npc.hp !== "number" || typeof npc.maxHp !== "number"
      || typeof npc.ac !== "number" || !isMythosModuleText(npc.faction) || !isMythosModuleText(npc.sceneId)) {
      throw new Error("MythosModule npcs contain an invalid entry");
    }
  }
  for (const clue of mythosModuleEntries(value, "clues")) {
    if (!isMythosModuleRecord(clue) || !isMythosModuleText(clue.scene) || !isMythosModuleText(clue.clueType)) throw new Error("MythosModule clues contain an invalid entry");
  }
  for (const hook of mythosModuleEntries(value, "hooks")) {
    if (!isMythosModuleRecord(hook) || !["on_enter_scene", "on_combat_start", "on_read_tome", "on_investigate"].includes(hook.type as string) || !isMythosModuleText(hook.condition)) {
      throw new Error("MythosModule hooks contain an invalid entry");
    }
  }
  for (const ending of mythosModuleEntries(value, "endings")) {
    if (!isMythosModuleRecord(ending) || !isMythosModuleText(ending.id) || !isMythosModuleText(ending.name) || !isMythosModuleText(ending.description) || !isMythosModuleText(ending.conditionText)) {
      throw new Error("MythosModule endings contain an invalid entry");
    }
  }
  for (const reward of mythosModuleEntries(value, "rewards")) {
    if (!isMythosModuleRecord(reward) || !isMythosModuleText(reward.id) || !isMythosModuleText(reward.description) || !isMythosModuleText(reward.conditionText)) {
      throw new Error("MythosModule rewards contain an invalid entry");
    }
  }
}

// ============================================================
// 加载器
// ============================================================

/** 模组加载器需要的外部接口 — 最小依赖集合 */
export interface MythosModuleHost {
  /** Registers one canonical spell definition. Returns false when it already exists. */
  registerSpell(spell: ModuleSpell): boolean;
  /** Registers one source-declared tome through session-owned provenance authority. */
  registerTome(tome: ModuleTome): void;
  sceneItems: Map<string, string[]>;
  /** 物品描述映射（物品名 → 描述文本），与 sceneItems 共用物品名索引 */
  itemDescriptions: Map<string, string>;
  /** KP 灵活干涉指引（场景ID/特殊key → 指引文本），供 LLM KP 运行时读取 */
  kpNotes?: Map<string, string>;
  /** 模块奖励规则（奖励ID → ModuleReward），LLM KP 在游戏结束时结算 */
  moduleRewards?: Map<string, ModuleReward>;
  world: {
    upsertEntity(entity: {
      id: string;
      name: string;
      type: "npc" | "monster";
      hp: number;
      maxHp: number;
      ac: number;
      status: string[];
      position: string;
      faction: string;
      scene_id?: string;
      attributes?: Record<string, number>;
      skills?: Record<string, number>;
    }): void;
    logEvent?(params: { round: number; timestamp: number; event_type: string; actor: string; description: string }): void;
    /**
     * 构建模组场景出口时要直接读写 scenes 表。
     * 这个依赖以前只靠 (host.world as any).getDatabase() 存在，契约里查不到，
     * 宿主换成窄适配器就会在运行时变成 undefined。这里明确声明出来。
     * 纯内存宿主（如测试 mock）可以不提供，加载器会跳过出口连接。
     */
    getDatabase?(): Database;
  };
  /**
   * 宿主只需要 verbatim 与 mood 这两项；可见性是会话概念，模组不关心，
   * 由宿主适配器补默认值。
   */
  addMessage(
    speaker: string,
    content: string,
    type: MessageType,
    opts?: { verbatim?: boolean; mood?: NPCMood }
  ): void;
  activeRuleset?: string;
  currentRound?: number;

  // ── NPC 人格注册 ──
  /**
   * 注册 NPC 人格到 NPC Agent 系统
   * @param npcName NPC 在游戏世界中的实体名（与 upsertEntity 的 name 一致）
   * @param personality 内联人格定义
   * @param npcPersonalityId 可选，引用 npcs.yaml 中的人格
   */
  registerNPCPersonality?(npcName: string, personality: ModuleNPC["personality"], npcPersonalityId?: string): void;

  // ── 调查系统 ──
  /** 注册调查线索到指定场景 */
  registerSceneClue?(sceneName: string, clueType: string, description?: string, sanCost?: string): void;

  // ── 场景事件钩子 ──
  /**
   * 注册模组事件钩子
   * 当玩家触发特定条件时，系统自动执行钩子动作
   */
  registerHook?(hook: {
    type: "on_enter_scene" | "on_combat_start" | "on_read_tome" | "on_investigate";
    condition: string;
    narration?: string;
    effect?: string;
  }): void;

  // ── 场景注册 ──
  /**
   * 向世界注册一个场景
   * 模组中可以定义模组专属场景，通过此方法暴露给世界系统
   */
  registerScene?(sceneId: string, displayName: string, description?: string): void;
}

// ============================================================
// 神话生物 stat 集成 — 供 combat 读取
// ============================================================

/** 所有神话生物按名字索引的 stat 映射（name → MythosCreature） */
export const MYTHOS_CREATURE_MAP: Map<string, MythosCreature> = new Map(
  MYTHOS_CREATURES.map(c => [c.name, c])
);

/** 按 tacticsKey / yaml id 索引的映射 */
export const MYTHOS_CREATURE_BY_ID: Map<string, MythosCreature> = new Map(
  MYTHOS_CREATURES.map(c => [c.id, c])
);

/**
 * 从 MYTHOS_CREATURES 创建标准 WorldEntity 数据
 * @param creatureIdOrName 生物 id（如 "deep_one"）或中文名（如 "深潜者"）
 * @param sceneId 放置场景
 * @param customFaction 可选阵营，默认自动推断
 */
export function createMythosEntity(
  creatureIdOrName: string,
  sceneId: string,
  customFaction?: string
): {
  id: string;
  name: string;
  type: "monster";
  hp: number;
  maxHp: number;
  ac: number;
  status: string[];
  position: string;
  faction: string;
  scene_id: string;
  stats: MythosCreature;
} {
  const creature =
    MYTHOS_CREATURE_BY_ID.get(creatureIdOrName) ??
    MYTHOS_CREATURE_MAP.get(creatureIdOrName);

  if (!creature) {
    throw new Error(`神话生物 "${creatureIdOrName}" 未找到。可用: ${Array.from(MYTHOS_CREATURE_BY_ID.keys()).join(", ")}`);
  }

  const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return {
    id: `${creature.id}_${ts}`,
    name: creature.name,
    type: "monster",
    hp: creature.hp,
    maxHp: creature.maxHp,
    ac: creature.ac,
    status: [],
    position: sceneId,
    faction: customFaction ?? "神话生物",
    scene_id: sceneId,
    stats: creature,
  };
}

export class MythosModuleLoader {
  private host: MythosModuleHost;
  /** 已导入的模组ID集合（防止重复导入） */
  private imported: Set<string> = new Set();

  constructor(host: MythosModuleHost) {
    this.host = host;
  }

  /** 已导入的模组ID列表 */
  get importedModules(): string[] {
    return Array.from(this.imported);
  }

  /** 是否已导入某模组 */
  isImported(moduleId: string): boolean {
    return this.imported.has(moduleId);
  }

  /**
   * 导入一个模组
   * @returns 导入结果描述
   */
  import(module: MythosModule): string[] {
    // Keep direct legacy use behind the same pure preflight as GameSession's
    // RuntimeModulePackage dispatcher. This does not make later host writes
    // atomic; it only rejects malformed input before imported.add()/host I/O.
    assertMythosModuleForInstall(module);
    const lines: string[] = [];
    const tomes = normalizeRuntimeModuleTomes(module.tomes);

    if (this.imported.has(module.id)) {
      lines.push(`模组「${module.name}」已导入，跳过。`);
      return lines;
    }

    lines.push(`【剧本杀模组：${module.name}】`);
    lines.push(`难度：${module.difficulty} | ${module.description}`);

    // 0. 注册模组场景 —— 白名单按"来源"判定，不是按字符串长得像不像地点：
    //    地点是被声明（sceneDescriptions）/被引用（NPC、物品、典籍、线索的
    //    sceneId）/被出口连接（module.exits 的 key 与 target）的东西。
    //
    //    ⚠ 曾经这里还加了一条 `if (h.condition) referencedScenes.add(h.condition)`
    //    —— hook 的 condition 是"触发条件"，从来就不是地点，但被无条件当场景
    //    注册了。谷仓模组实测：22 个真场景硬是被灌成了 39 个，混进去的 17 条
    //    里有「主要_npc」「结局」「可选」这种一眼是从文档小标题抽取管线里
    //    漏进来的东西。移动候选池（game-session.ts 的模糊场景匹配）取的是
    //    全量已注册场景，于是「查看餐桌、披萨盒」能被判定送到「可能的敌人类」。
    //    hook 的 narration 仍然有用（是 lore，下面第 6 步单独注册），只是不该
    //    让它顺带造出一个可移动到的地点。
    const referencedScenes = new Set<string>();
    if (module.npcs) for (const n of module.npcs) if (n.sceneId && n.sceneId !== "unknown") referencedScenes.add(n.sceneId);
    if (module.items) for (const it of module.items) if (it.sceneId && it.sceneId !== "unknown") referencedScenes.add(it.sceneId);
    if (module.tomes) for (const t of module.tomes) if (t.sceneId && t.sceneId !== "unknown") referencedScenes.add(t.sceneId);
    if (module.clues) for (const c of module.clues) if (c.scene && c.scene !== "unknown") referencedScenes.add(c.scene);
    if (module.sceneDescriptions) for (const sid of Object.keys(module.sceneDescriptions)) referencedScenes.add(sid);
    if (module.exits) for (const [sid, list] of Object.entries(module.exits)) {
      referencedScenes.add(sid);
      for (const e of list) referencedScenes.add(e.target);
    }
    let sceneCount = 0;
    // 场景注册到 DB — 无描述，handleMovement 会自动根据 NPC 位置生成"在场的还有"
    if (this.host.registerScene) {
      for (const sid of referencedScenes) {
        const desc = module.sceneDescriptions?.[sid];
        this.host.registerScene(sid, sid, desc);
        sceneCount++;
      }
    }
    if (sceneCount > 0) lines.push(`注册 ${sceneCount} 个模组场景`);

    // ── 构建模组场景出口连接 ──
    try {
      const getDb = this.host.world.getDatabase;
      if (!getDb) throw new Error("宿主未提供数据库能力，无法连接场景出口");
      const db = getDb.call(this.host.world);
      if (module.exits) {
        // 使用模组定义的显式出口
        let exitCount = 0;
        for (const [sceneId, exitList] of Object.entries(module.exits)) {
          const currentRow: any = db.query("SELECT exits FROM scenes WHERE id = ?").get(sceneId);
          // ⚠ 原写法是 `try { existing.push(...JSON.parse(row.exits ?? "[]")) } catch {}`，
          // 解析失败时 `existing` 保持空、**接着照样把 merged 写回去** ——
          // 这个场景原有的出口就被静默抹掉了，catch 里一个字都没有。
          // §八 记的正是这类：「模组场景出口整段失效」而测试全绿。
          // 现在读不出来就**放弃覆盖**，保住原数据，并把这件事说出来。
          const parsed = parseExits(currentRow?.exits);
          if (!parsed.ok) {
            lines.push(`⚠️ 场景「${sceneId}」原有出口读不出来（${parsed.reason}），已跳过合并以免覆盖`);
            continue;
          }
          const deduped = mergeExits(
            parsed.exits,
            exitList.map(e => ({ target: e.target, desc: e.desc ?? e.target })),
          );
          db.run("UPDATE scenes SET exits = ? WHERE id = ?", [JSON.stringify(deduped), sceneId]);
          exitCount += exitList.length;
        }
        lines.push(`构建 ${exitCount} 条模组场景显式出口`);
      } else {
        // 默认：物理场景全连接（向后兼容）
        const physicalScenes = new Set<string>();
        if (module.npcs) for (const n of module.npcs) if (n.sceneId && n.sceneId !== "unknown") physicalScenes.add(n.sceneId);
        if (module.items) for (const it of module.items) if (it.sceneId && it.sceneId !== "unknown") physicalScenes.add(it.sceneId);
        if (module.tomes) for (const t of module.tomes) if (t.sceneId && t.sceneId !== "unknown") physicalScenes.add(t.sceneId);
        const sceneArr = [...physicalScenes];
        if (sceneArr.length > 1) {
          const exitObjs = sceneArr.map(sid => ({ target: sid, desc: sid }));
          for (const sid of sceneArr) {
            const others = exitObjs.filter(o => o.target !== sid);
            db.run("UPDATE scenes SET exits = ? WHERE id = ?", [JSON.stringify(others), sid]);
          }
          // 入口场景加上模组场景出口
          const activeRow: any = db.query("SELECT id FROM scenes WHERE is_active = 1 LIMIT 1").get();
          const entryScene: string | undefined = activeRow?.id;
          if (entryScene && entryScene !== "unknown" && !sceneArr.includes(entryScene)) {
            const existingRow: any = db.query("SELECT exits FROM scenes WHERE id = ?").get(entryScene);
            // 与上面同一个道理：读不干净就别覆盖。入口场景的出口被抹掉，
            // 后果是开局那一步无路可走，而没有任何一处会报错。
            const parsed = parseExits(existingRow?.exits);
            if (!parsed.ok) {
              lines.push(`⚠️ 入口场景「${entryScene}」原有出口读不出来（${parsed.reason}），已跳过合并以免覆盖`);
            } else {
              const deduped = mergeExits(parsed.exits, exitObjs);
              db.run("UPDATE scenes SET exits = ? WHERE id = ?", [JSON.stringify(deduped), entryScene]);
            }
          }
          lines.push(`构建 ${sceneArr.length} 个模组场景出口`);
        }
      }
    } catch (e: any) {
      // A scene-exit database failure follows earlier legacy writes. It must
      // reach the session boundary so that the candidate is fail-stopped.
      if (this.host.world.getDatabase) throw e;
      lines.push(`⚠️ 场景出口连接失败: ${e.message}`);
    }

    // 1. 注册法术
    let spellCount = 0;
    if (module.spells) {
      for (const s of module.spells) {
        if (this.host.registerSpell(s)) spellCount++;
      }
    }
    if (spellCount > 0) lines.push(`注册 ${spellCount} 个神话法术`);

    // 2. 放置典籍
    let tomeCount = 0;
    if (tomes.length > 0) {
      for (const t of tomes) {
        this.host.registerTome(t);
        tomeCount++;
      }
    }
    if (tomeCount > 0) lines.push(`放置 ${tomeCount} 本典籍`);

    // 3. 放置物品
    let itemCount = 0;
    if (module.items) {
      for (const it of module.items) {
        const items = this.host.sceneItems.get(it.sceneId) ?? [];
        if (!items.includes(it.name)) {
          items.push(it.name);
          this.host.sceneItems.set(it.sceneId, items);
          // 物品描述
          if (it.description) {
            this.host.itemDescriptions.set(it.name, it.description);
          }
          itemCount++;
        }
      }
    }
    if (itemCount > 0) lines.push(`放置 ${itemCount} 件物品`);

    // 4. 生成 NPC/生物。ModuleNPC 的数值字段是模组明确的遭遇事实；
    //    `mythosCreatureId` 只是关联通用目录的身份，不能反过来覆盖模组 HP/AC。
    let npcCount = 0;
    if (module.npcs) {
      for (const n of module.npcs) {
        this.host.world.upsertEntity({
          id: n.id,
          name: n.name,
          type: n.type,
          hp: n.hp,
          maxHp: n.maxHp,
          ac: n.ac,
          status: [],
          position: n.sceneId,
          faction: n.faction,
          scene_id: n.sceneId,
          attributes: n.attributes ?? {},
          skills: n.skills ?? {},
        });

        // NPC 人格注册（内联 personality 或 npcPersonalityId 引用）
        if (this.host.registerNPCPersonality && (n.personality || n.npcPersonalityId)) {
          // 合并 root-level 的 background/goals/secrets 到 personality，兼容两种写法
          const p = n.personality ?? {} as NonNullable<ModuleNPC["personality"]>;
          const enrichedPersonality = {
            ...p,
            background: p.background || (n as any).background || "",
            goals: p.goals || (n as any).goals || [],
            secrets: p.secrets || (n as any).secrets || [],
          };
          this.host.registerNPCPersonality(n.name, enrichedPersonality, n.npcPersonalityId);
        }

        npcCount++;
      }
    }
    if (npcCount > 0) lines.push(`生成 ${npcCount} 个 NPC/生物`);

    // 5. 场景调查线索注册
    let clueCount = 0;
    if (module.clues && this.host.registerSceneClue) {
      for (const c of module.clues) {
        // sanCost 必须一起传：模组每条线索都写了它，而调查判定要靠它决定
        // 发现这条线索损失多少理智。此前签名里没有这个参数，值在边界被丢弃。
        this.host.registerSceneClue(c.scene, c.clueType, c.description, c.sanCost);
        clueCount++;
      }
    }
    if (clueCount > 0) lines.push(`注册 ${clueCount} 条调查线索`);

    // 6. 场景事件钩子
    let hookCount = 0;
    if (module.hooks && this.host.registerHook) {
      for (const h of module.hooks) {
        this.host.registerHook(h);
        hookCount++;
      }
    }
    if (hookCount > 0) lines.push(`注册 ${hookCount} 个场景事件钩子`);

    // 7. 模组叙事
    if (module.introNarration) {
      // 模组开场白按跑团惯例逐字朗读，不经 LLM 改写 —— 标记出来，
      // 使前端与后续语音路由能区分「照读原文」与「KP 即兴叙述」。
      this.host.addMessage("KP", module.introNarration, "narration", { verbatim: true });
    }

    // 8. 初始状态变更
    if (module.initialEffects) {
      // 预留：未来支持对世界状态的特殊修改
      lines.push(`应用 ${module.initialEffects.length} 项初始状态变更`);
    }

    // 9. KP 灵活干涉指引（供 LLM KP 运行时查阅）
    if (module.kpNotes) {
      if (!this.host.kpNotes) this.host.kpNotes = new Map();
      for (const [key, note] of Object.entries(module.kpNotes)) {
        this.host.kpNotes.set(key, note);
      }
      lines.push(`加载 ${Object.keys(module.kpNotes).length} 条 KP 灵活干涉指引`);
    }

    // ⚠ 这里曾经有一段"结局注册"：把 module.endings 逐条写进
    // this.host.moduleEndings（一个 Map）。删掉的原因是那个 Map 从建出来
    // 那天起就没有任何读者——GameSession 这条自由跑团路径压根没有"判定
    // 结局"这回事（那是另一轮的范围），"写但没人读"的注册表正是本仓
    // 反复吃过亏的"认出来了，没地方放"。module.endings 本身没有被删——
    // 它仍然是 MythosModule 数据的一部分（conditionText 是给人/LLM 读的
    // 展示文本，见 ModuleEnding 类型定义），只是本轮不再把它复制进一个
    // 谁都不查的 Map。真要用它时，先接上读者，再决定要不要重新登记。

    // 11. 奖励规则注册
    if (module.rewards) {
      if (!this.host.moduleRewards) this.host.moduleRewards = new Map();
      for (const r of module.rewards) {
        this.host.moduleRewards.set(r.id, r);
      }
      lines.push(`注册 ${module.rewards.length} 条奖励规则`);
    }

    this.host.addMessage("系统", `剧本杀模组「${module.name}」已加载`, "system");

    // This is the commit point: no retry may observe an imported module until
    // every legacy-host write and narration has completed successfully.
    this.imported.add(module.id);
    return lines;
  }

  /**
   * 检查激活条件并自动导入匹配的模组
   * @param modules 候选模组列表
   * @param eventType 当前事件类型
   * @param eventValue 当前事件值（如进入的场景ID、发现的物品名等）
   */
  autoActivate(
    modules: MythosModule[],
    eventType: string,
    eventValue: string
  ): string[] {
    const results: string[] = [];
    for (const mod of modules) {
      if (this.imported.has(mod.id)) continue;
      if (mod.activation.type === eventType && mod.activation.condition === eventValue) {
        const lines = this.import(mod);
        results.push(...lines);
      }
    }
    return results;
  }
}

// ============================================================
// 预打包模组
// ============================================================

/**
 * 印斯茅斯模组 — 基于《印斯茅斯的阴霾》
 * 玩家进入印斯茅斯码头区域时自动激活
 */
export const INNSMOUTH_MODULE: MythosModule = {
  id: "innsmouth_shadow",
  name: "印斯茅斯的阴霾",
  version: "1.0",
  description: "马萨诸塞州海岸线上被诅咒的渔港，居民与深海邪神达成了血腥交易。",
  difficulty: "hard",
  source: "《印斯茅斯的阴霾》(The Shadow Over Innsmouth, H.P. Lovecraft, 1936)",
  activation: {
    type: "location_enter",
    condition: "innsmouth_docks",
  },
  sceneBgm: {
    innsmouth_docks: "coast",
    innsmouth_reef: "coast",
    innsmouth_church: "sacred",
  },
  introNarration:
    "铅灰色的海面在冬日低垂的云层下无尽延伸。腐烂的木质栈桥伸向海中，" +
    "空气中弥漫着鱼腥和腐败盐渍的刺鼻气味。远处的礁石上，有什么东西在潮湿的雾中发出反光。" +
    "你注意到镇上的人们有着不寻常的面容——过于凸出的眼睛、过于扁平的鼻子、粗糙发灰的皮肤。" +
    "当你走过时，他们的目光追随你，但他们不笑，也不说话。欢迎来到印斯茅斯。",
  spells: [
    {
      name: "接触大衮",
      sanCost: "1d4/1d8",
      mpCost: 6,
      description: "在海岸边吟诵古老的大衮祷文，尝试与深潜者的父神建立精神联系。",
      effectType: "other",
    },
  ],
  tomes: [
    {
      name: "扎多克的低语",
      sceneId: "innsmouth_docks",
      sanCost: "1/1d4",
      tomeRating: 4,
      spells: ["接触大衮"],
      openDescription:
        "老酒鬼扎多克·艾伦颤抖着塞给你几张皱巴巴的纸片，上面是他用颤抖的手写下的证词——" +
        "关于1846年的「海军条约」、关于大衮教团的真相、关于魔鬼礁下的城市伊哈斯莱……",
    },
  ],
  items: [
    { name: "大衮教团徽章", sceneId: "innsmouth_church", description: "一枚刻有扭曲鱼形图案的铜质徽章" },
    { name: "旧日印戒", sceneId: "innsmouth_reef", description: "一枚在礁石间发现的古老戒指，戒面上刻有无法辨认的铭文" },
  ],
  clues: [
    { scene: "innsmouth_docks",  clueType: "strange_fish_market", description: "码头鱼市场的渔获中有带着鳞片的人类肢体",              sanCost: "0/1" },
    { scene: "innsmouth_church", clueType: "dagon_shrine",        description: "教堂暗格中发现大衮神龛和血迹斑斑的祭坛",             sanCost: "1/1d3" },
    { scene: "innsmouth_reef",   clueType: "submerged_ruins",     description: "退潮时礁石间浮现出海底城市的轮廓——伊哈斯莱",        sanCost: "1/1d4" },
  ],
  hooks: [
    { type: "on_enter_scene", condition: "innsmouth_docks",  narration: "你注意到码头上晾晒的渔网中夹杂着奇怪的海藻——它们呈现出血红色，微微摆动仿佛有生命。",       effect: "获得线索：血色海藻" },
    { type: "on_enter_scene", condition: "innsmouth_church", narration: "教堂深处传来低沉的吟唱声，不像人类语言——那是大衮教团的晚祷。你感到一阵无法抑制的恐惧。",      effect: "SAN -0/1" },
    { type: "on_read_tome",   condition: "扎多克的低语",     narration: "当你读到「伊哈斯莱」这个名字时，脑海深处响起一声低语……不是你记忆中的语言，但你理解了它的含义：深潜者的城市。", effect: "获得线索：伊哈斯莱" },
  ],
  npcs: [
    {
      id: "zadok_allen",
      name: "扎多克·艾伦",
      type: "npc",
      hp: 8,
      maxHp: 8,
      ac: 10,
      faction: "恐惧的知情者",
      sceneId: "innsmouth_docks",
      personality: {
        role: "恐惧的知情者",
        personality: "满脑子恐惧的醉酒老水手",
        background: "年轻时曾是远洋船员，见证了1846年海军条约的真相。多年来靠酒精压抑记忆。",
        goals: ["向愿意倾听的人说出真相"],
        speech_style: "醉酒颤抖、语无伦次、急切地想告诉你些什么",
        knowledge: ["印斯茅斯历史", "大衮教团", "1846年条约"],
        secrets: ["他自己也流淌着深潜者的血脉——他的曾祖母不是人类"],
        traits: { courage: 3, friendliness: 6, suspicion: 7, curiosity: 5, stability: 2 },
        // 原写 "paranoid"：他的核心是恐惧而非怀疑，role 就叫「恐惧的知情者」。
        // 多疑那一面由 suspicion: 7 承载，不需要再挤进情绪字段。
        initialMood: "fearful",
      },
    },
    {
      id: "deep_one_scout",
      name: "潜伏的生物",
      type: "monster",
      hp: 15,
      maxHp: 15,
      ac: 13,
      faction: "深潜者",
      sceneId: "innsmouth_reef",
    },
    {
      id: "high_priest",
      name: "教团大祭司",
      type: "npc",
      hp: 14,
      maxHp: 14,
      ac: 12,
      faction: "大衮教团",
      sceneId: "innsmouth_church",
      personality: {
        role: "大衮教团领袖",
        personality: "狂热的深海崇拜者，外表与常人无异但内心已完全非人",
        background: "代代相传的教团领袖家族，面容已经开始显现深潜者的特征。",
        goals: ["保护教团秘密", "完成深潜者的血祭仪式", "转化更多的镇民"],
        speech_style: "庄严而阴森，夹杂着旧约式的预言腔调",
        knowledge: ["大衮仪式", "深潜者历史", "伊哈斯莱"],
        secrets: ["教团正在准备一场大规模的血祭以迎接大衮的降临"],
        attitudes: { "外来者": "敌意", "扎多克·艾伦": "叛徒必须被清除" },
        traits: { courage: 8, friendliness: 2, suspicion: 9, curiosity: 4, stability: 7 },
        // 原写 "hostile"：人格描述明说「常年警惕但不主动攻击」，
        // 敌意是立场不是情绪，用 suspicious 才对得上「警惕」；
        // angry 会让他一上场就像已经动了手。
        initialMood: "suspicious",
      },
    },
  ],
};

/**
 * 阿卡姆模组 — 基于密斯卡托尼克大学设定
 * 玩家进入大学图书馆时自动激活
 */
export const ARKHAM_LIBRARY_MODULE: MythosModule = {
  id: "arkham_miskatonic",
  name: "密斯卡托尼克之秘",
  version: "1.0",
  description: "阿卡姆的密斯卡托尼克大学图书馆收藏着禁忌的知识——但知识有代价。",
  difficulty: "easy",
  source: "多篇洛夫克拉夫特作品中的阿卡姆设定",
  activation: {
    type: "location_enter",
    condition: "arkham_miskatonic",
  },
  sceneBgm: {
    arkham_miskatonic: "library",
    arkham_library_vault: "library",
    arkham_library_basement: "underground",
  },
  introNarration:
    "密斯卡托尼克大学图书馆的大厅弥漫着旧书和皮革的混合气味。" +
    "高大的拱形窗户让午后的阳光在飘浮的灰尘中形成一道道可见的光柱。" +
    "前台一位戴着半月形眼镜的老年馆员抬起头，透过镜片打量着你。" +
    "「需要帮助吗，年轻人？」他的声音像旧书页一样干燥。",
  spells: [
    {
      name: "阿卡姆档案检索",
      sanCost: "0/1d2",
      mpCost: 1,
      description: "利用密斯卡托尼克大学的档案系统，找到一份关于超自然事件的记录。",
      effectType: "perception",
    },
  ],
  tomes: [
    {
      name: "塞拉伊诺断章",
      sceneId: "arkham_library_vault",
      sanCost: "1d3/1d8",
      tomeRating: 8,
      spells: ["接触远古者", "克苏鲁之拳", "绿色腐败", "放逐术"],
      openDescription:
        "金属薄片上刻有发光的楔形文字，触碰时皮肤有轻微的电击感。文字在你眼前扭动，重组为可读的图景……",
    },
  ],
  items: [
    { name: "特别书库借阅证", sceneId: "arkham_miskatonic", description: "一张泛黄的借阅证，带有阿米蒂奇馆长的签名" },
    { name: "沃德家族档案", sceneId: "arkham_library_basement", description: "关于查尔斯·德克斯特·沃德案件的密封档案" },
  ],
  clues: [
    { scene: "arkham_miskatonic",     clueType: "restricted_section", description: "特别书库暗格里藏着一本用人类皮肤装订的日记",          sanCost: "1/1d3" },
    { scene: "arkham_library_vault",  clueType: "elder_sign_tablet",  description: "保险库深处发现一块刻有旧印的石板，语言不属于任何已知文明", sanCost: "0/1d2" },
    { scene: "arkham_library_basement", clueType: "ward_papers",      description: "沃德档案中记载了一次失败的死者复活仪式",             sanCost: "1/1d4" },
  ],
  hooks: [
    { type: "on_enter_scene", condition: "arkham_library_vault",    narration: "保险库的铁门在身后自动关闭——不是锁住，而是一种沉重的、令人窒息的隔绝。灯光闪烁了一下，然后恢复了正常。", effect: "触发恐惧检定" },
    { type: "on_read_tome",   condition: "塞拉伊诺断章",            narration: "金属薄片开始发热，你手心的皮肤传来灼烧般的刺痛。古老的文字在你脑海中排列成一种超越人类语言的结构——你理解了，但你不属于这种理解。", effect: "克苏鲁神话 +2%" },
  ],
  npcs: [
    {
      id: "librarian_armitage",
      name: "阿米蒂奇馆长",
      type: "npc",
      hp: 10,
      maxHp: 10,
      ac: 10,
      faction: "学者",
      sceneId: "arkham_miskatonic",
      personality: {
        role: "密斯卡托尼克大学图书馆馆长",
        personality: "年迈但思维敏锐的学者，守护着图书馆的超自然藏书",
        background: "曾在密大学习人类学，1920年代的一次埃及考古发掘后开始接触超自然文献。",
        goals: ["保护学生免受禁忌知识伤害", "确保特别书库的安全"],
        speech_style: "礼貌而含蓄，用词考究，经常停顿以选择合适的词汇",
        knowledge: ["密斯卡托尼克大学历史", "特别书库分类系统", "基本的旧印知识"],
        secrets: ["他自己也读过塞拉伊诺断章——虽然只看了三行"],
        attitudes: { "超自然研究者": "谨慎的帮助", "外来者": "职业性的礼貌" },
        traits: { courage: 6, friendliness: 7, suspicion: 8, curiosity: 9, stability: 5 },
        initialMood: "calm",
      },
    },
  ],
};
