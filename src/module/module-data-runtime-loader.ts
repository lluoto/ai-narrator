// Direct ModuleData runtime loader (step 5C).
//
// This intentionally does not import deriveMythosModule or MythosModuleLoader.
// It reads ModuleData's narrative structure plus its runtime group directly.

import { assertRuntimeModuleData, type Clue, type ModuleItem, type ModuleNPC, type RuntimeModuleData, type SceneConnection } from "./types";
import {
  normalizeRuntimeModulePickupOrigins,
  normalizeRuntimeModuleTomes,
  type ModuleRuntimeConfig,
  type RuntimeItemPlacement,
  type RuntimeModuleHook,
  type RuntimeModuleReward,
  type RuntimeModuleSpell,
  type RuntimeModuleTome,
  type RuntimeNpcSnapshot,
} from "./runtime-types";

export interface RuntimeSceneExit {
  target: string;
  desc: string;
}

export interface ModuleDataRuntimeHost {
  registerScene(scene: { id: string; name: string; description: string; lighting?: string; dangers?: string[]; exits: RuntimeSceneExit[] }): void;
  registerRuntimeNpc(npc: ModuleNPC, runtime: RuntimeNpcSnapshot): void;
  registerNarrativeNpc(npc: ModuleNPC): void;
  registerRichClue(sceneId: string, clue: Clue, sanCost?: string): void;
  registerTome(tome: RuntimeModuleTome): void;
  registerItemPlacement(item: RuntimeItemPlacement): void;
  registerRichItem(item: ModuleItem): void;
  registerSpell(spell: RuntimeModuleSpell): void;
  registerHook(hook: RuntimeModuleHook): void;
  registerRewards(rewards: RuntimeModuleReward[]): void;
  registerKpNotes(notes: Record<string, string>): void;
  registerSceneBgm(bgm: Record<string, string>): void;
  registerSceneAliases(aliases: Record<string, string[]>): void;
  applyInitialEffects(effects: NonNullable<ModuleRuntimeConfig["initialEffects"]>): void;
  addIntroNarration(text: string): void;
}

export interface ModuleDataLoadResult {
  id: string;
  name: string;
  entryScene: string | null;
  lines: string[];
  narrative: Pick<RuntimeModuleData, "endings" | "epilogues" | "prologue" | "partySetup" | "narrative">;
}

function runtimeOf(module: RuntimeModuleData): ModuleRuntimeConfig {
  const runtime = module.runtime;
  if (!runtime?.activation || !runtime.difficulty || !runtime.sourceIdentity) {
    throw new Error("ModuleData 缺少步骤 5B 迁入的运行配置");
  }
  return runtime;
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} 重复：${value}`);
    seen.add(value);
  }
}

// These are the two verified narrative-display/runtime-entity pairs in the
// current Barn source.  They are deliberately complete pairs, not a general
// parenthetical alias: “菲碧·特里坎（冒牌者）” must never bind 菲碧's runtime.
function hasVerifiedRuntimeNpcCounterpart(npc: ModuleNPC, snapshot: RuntimeNpcSnapshot): boolean {
  if (npc.name === snapshot.sourceName) return true;
  return (npc.name === "食尸鬼（可选）" && snapshot.sourceName === "食尸鬼")
    || (npc.name === "Mi-Go（来自尤格斯的真菌）" && snapshot.sourceName === "Mi-Go");
}

function assertModuleNpcKnowledge(npc: ModuleNPC): void {
  // `assertRuntimeModuleData` establishes the broad package shape, but this
  // field becomes an LLM factual source below.  Do not permit a malformed
  // value to be spread into characters or fall back to a different profile.
  const knowledge: unknown = (npc as unknown as { knowledge?: unknown }).knowledge;
  if (!Array.isArray(knowledge) || knowledge.some((fact) => typeof fact !== "string")) {
    throw new Error(`ModuleNPC.knowledge must be an array of strings: ${npc.id}`);
  }
}

/**
 * Direct-loader validation is deliberately exported for the session package
 * dispatcher. It imports no compiler types, keeping ModuleData independent.
 */
export function validateRuntimeModuleDataForInstall(input: unknown): RuntimeModuleData {
  assertRuntimeModuleData(input);
  const module = input;
  const runtime = runtimeOf(module);
  normalizeRuntimeModuleTomes((runtime as unknown as Record<string, unknown>).tomes);
  const pickupOrigins = normalizeRuntimeModulePickupOrigins({
    tomes: (runtime as unknown as Record<string, unknown>).tomes,
    itemPlacements: (runtime as unknown as Record<string, unknown>).itemPlacements,
    richItems: module.items,
  });
  assertUnique(module.scenes.map((scene) => scene.id), "Scene.id");
  const sceneIds = new Set(module.scenes.map((scene) => scene.id));
  for (const origin of pickupOrigins) {
    if (!sceneIds.has(origin.sceneId)) {
      throw new Error(`runtime pickup origin does not name a declared scene: ${origin.name}`);
    }
  }
  if (runtime.entrySceneId !== undefined && !sceneIds.has(runtime.entrySceneId)) {
    throw new Error(`runtime entrySceneId does not name a declared scene: ${runtime.entrySceneId}`);
  }
  for (const scene of module.scenes) {
    if (scene.lighting !== undefined && (typeof scene.lighting !== "string" || scene.lighting.trim().length === 0)) {
      throw new Error(`Scene.lighting is invalid for ${scene.id}`);
    }
    if (scene.dangers !== undefined && (!Array.isArray(scene.dangers) || scene.dangers.some((danger) => typeof danger !== "string" || danger.trim().length === 0))) {
      throw new Error(`Scene.dangers is invalid for ${scene.id}`);
    }
    for (const connection of scene.connections) {
      if (!sceneIds.has(connection.targetSceneId)) {
        throw new Error(`Scene.connection 悬空：${scene.id} -> ${connection.targetSceneId}`);
      }
    }
  }
  assertUnique(module.npcs.map((npc) => npc.id), "ModuleNPC.id");
  assertUnique(module.items.map((item) => item.id), "ModuleItem.id");
  assertUnique(module.scenes.flatMap((scene) => scene.clues.map((clue) => clue.id)), "Clue.id");
  for (const npc of module.npcs) assertModuleNpcKnowledge(npc);

  // A nested runtime snapshot supplies world/combat identity, while its
  // enclosing ModuleNPC owns the narrative facts.  `sourceId` deliberately
  // lives in the world-entity domain and need not equal ModuleNPC.id; name
  // and scene are the shared counterpart binding.  Refuse a mismatch before
  // the first host write rather than letting one NPC inherit another's facts.
  for (const npc of module.npcs) {
    const snapshot = npc.runtime;
    if (snapshot && (!hasVerifiedRuntimeNpcCounterpart(npc, snapshot) || snapshot.sceneId !== npc.sceneId)) {
      throw new Error(`runtime NPC source binding conflicts: ${npc.id}`);
    }
  }

  const runtimeSnapshots = module.npcs.flatMap((npc) => npc.runtime ? [npc.runtime] : []);
  const sourceIds = runtimeSnapshots.map((snapshot) => snapshot.sourceId);
  assertUnique(sourceIds, "runtime NPC sourceId");
  for (const snapshot of runtimeSnapshots) {
    if (snapshot.status !== undefined && (!Array.isArray(snapshot.status)
      || snapshot.status.some((status) => typeof status !== "string" || status.trim().length === 0))) {
      throw new Error(`runtime NPC status is invalid for ${snapshot.sourceId}`);
    }
  }
  const order = runtime.runtimeNpcOrder ?? [];
  assertUnique(order, "runtimeNpcOrder");
  const snapshotIds = new Set(sourceIds);
  for (const sourceId of order) {
    if (!snapshotIds.has(sourceId)) throw new Error(`runtimeNpcOrder 引用不存在 snapshot：${sourceId}`);
  }
  const orderIds = new Set(order);
  const unconsumed = sourceIds.filter((sourceId) => !orderIds.has(sourceId));
  if (unconsumed.length > 0) throw new Error(`runtime snapshot 未被 order 消费：${unconsumed.join(", ")}`);
  return module;
}

function toRuntimeExit(connection: SceneConnection): RuntimeSceneExit {
  // C2 policy: ModuleData.condition is source-backed, player-actionable text;
  // the legacy desc map is frozen only for regression and retirement planning.
  return { target: connection.targetSceneId, desc: connection.condition };
}

export class ModuleDataRuntimeLoader {
  private imported = new Set<string>();
  /** 成功返回的 host 操作；失败重试时跳过，避免重复追加副作用。 */
  private completedOperations = new Map<string, Set<string>>();

  constructor(private readonly host: ModuleDataRuntimeHost) {}

  private runOperation(moduleId: string, key: string, operation: () => void): void {
    const completed = this.completedOperations.get(moduleId) ?? new Set<string>();
    this.completedOperations.set(moduleId, completed);
    if (completed.has(key)) return;
    // Host callbacks must be atomic or idempotent: throwing means the operation
    // did not commit. GameSession callbacks satisfy this contract.
    operation();
    completed.add(key);
  }

  import(module: RuntimeModuleData): ModuleDataLoadResult {
    if (this.imported.has(module.id)) {
      return {
        id: module.id,
        name: module.title,
        entryScene: module.runtime.entrySceneId ?? module.scenes[0]?.id ?? null,
        lines: [`模组「${module.title}」已导入。`],
        narrative: pickNarrative(module),
      };
    }
    // All structural checks happen before the first host write.
    const validated = validateRuntimeModuleDataForInstall(module);
    const runtime = validated.runtime;
    const tomes = normalizeRuntimeModuleTomes((runtime as unknown as Record<string, unknown>).tomes);
    const lines = [`【统一模组：${module.title}】`, `难度：${runtime.difficulty} | ${module.summary}`];

    module.scenes.forEach((scene, index) => {
      this.runOperation(module.id, `scene:${index}:${scene.id}`, () => this.host.registerScene({
        id: scene.id,
        name: scene.name,
        description: scene.description,
        ...(scene.lighting !== undefined ? { lighting: scene.lighting } : {}),
        ...(scene.dangers !== undefined ? { dangers: [...scene.dangers] } : {}),
        exits: scene.connections.map(toRuntimeExit),
      }));
    });
    lines.push(`注册 ${module.scenes.length} 个模组场景`);
    lines.push(`构建 ${module.scenes.flatMap((scene) => scene.connections).length} 条统一场景出口`);

    module.npcs.forEach((npc, index) => this.runOperation(module.id, `npc:${index}:${npc.id}`, () => {
      if (npc.runtime) this.host.registerRuntimeNpc(npc, npc.runtime);
      else this.host.registerNarrativeNpc(npc);
    }));
    lines.push(`注册 ${module.npcs.length} 个叙事 NPC，其中 ${module.npcs.filter((npc) => npc.runtime).length} 个带运行配置`);

    module.scenes.forEach((scene) => scene.clues.forEach((clue, index) => {
      this.runOperation(module.id, `clue:${scene.id}:${index}:${clue.id}`, () =>
        this.host.registerRichClue(scene.id, clue, runtime.richClueSanCosts?.[clue.id]));
    }));
    lines.push(`注册 ${module.scenes.flatMap((scene) => scene.clues).length} 条丰富线索`);

    tomes.forEach((tome, index) => this.runOperation(module.id, `tome:${index}:${tome.name}`, () => this.host.registerTome(tome)));
    (runtime.itemPlacements ?? []).forEach((item, index) => this.runOperation(module.id, `placement:${index}:${item.name}`, () => this.host.registerItemPlacement(item)));
    module.items.forEach((item, index) => this.runOperation(module.id, `item:${index}:${item.id}`, () => this.host.registerRichItem(item)));
    (runtime.spells ?? []).forEach((spell, index) => this.runOperation(module.id, `spell:${index}:${spell.name}`, () => this.host.registerSpell(spell)));
    (runtime.hooks ?? []).forEach((hook, index) => this.runOperation(module.id, `hook:${index}:${hook.type}:${hook.condition}`, () => this.host.registerHook(hook)));
    const rewards = runtime.rewards;
    if (rewards) this.runOperation(module.id, "rewards", () => this.host.registerRewards(rewards));
    const kpNotes = runtime.kpNotes;
    if (kpNotes) this.runOperation(module.id, "kpNotes", () => this.host.registerKpNotes(kpNotes));
    const sceneBgm = runtime.sceneBgm;
    if (sceneBgm) this.runOperation(module.id, "sceneBgm", () => this.host.registerSceneBgm(sceneBgm));
    const sceneAliases = runtime.sceneAliases;
    if (sceneAliases) this.runOperation(module.id, "sceneAliases", () => this.host.registerSceneAliases(sceneAliases));
    const initialEffects = runtime.initialEffects;
    if (initialEffects) this.runOperation(module.id, "initialEffects", () => this.host.applyInitialEffects(initialEffects));
    const introNarration = runtime.introNarration;
    if (introNarration) this.runOperation(module.id, "introNarration", () => this.host.addIntroNarration(introNarration));

    // Only a completely successful plan becomes imported. A thrown host
    // operation leaves the operation ledger available for a real retry.
    this.imported.add(module.id);
    this.completedOperations.delete(module.id);

    return {
      id: module.id,
      name: module.title,
      entryScene: module.runtime.entrySceneId ?? module.scenes[0]?.id ?? null,
      lines,
      narrative: pickNarrative(module),
    };
  }
}

function pickNarrative(module: RuntimeModuleData): ModuleDataLoadResult["narrative"] {
  return {
    endings: module.endings,
    epilogues: module.epilogues,
    prologue: module.prologue,
    partySetup: module.partySetup,
    narrative: module.narrative,
  };
}
