// 统一模组类型的运行时字段（步骤 5A）。
//
// 本文件是 module/types.ts（叙事结构）与 rules/mythos-module.ts（加载器）
// 之间的中立数据类型层。它不得 import 任何一侧，避免 ModuleData 反向
// import MythosModule 形成循环依赖。

import type { NPCMood } from "../agent/types";

export type RuntimeDifficulty = "easy" | "medium" | "hard" | "nightmare";

export interface RuntimeActivation {
  type: "manual" | "location_enter" | "item_found" | "read_tome" | "san_threshold";
  condition: string;
}

// Runtime identity remains explicit because the direct loader needs stable
// module metadata without reinterpreting narrative fields.
export interface RuntimeModuleIdentity {
  id: string;
  name: string;
  version: string;
  description: string;
}

export interface RuntimeModuleSpell {
  name: string;
  sanCost: string;
  mpCost: number;
  description: string;
  effectType?: string;
}

export interface RuntimeModuleTome {
  name: string;
  sceneId: string;
  sanCost: string;
  tomeRating: number;
  spells: string[];
  openDescription: string;
}

/**
 * A tome declaration becomes executable after a module is installed.  Keep
 * its limits alongside the shared declaration validator so loaders cannot
 * admit values that SanityEngine will reject only after changing session
 * state.  The dice-count and loss limits align with the existing CoC engine's
 * 4,096 roll-array limit and 1,000,000 SAN-loss guard.
 */
export const RUNTIME_TOME_MAX_RATING = 99;
export const RUNTIME_TOME_MAX_SAN_DICE_COUNT = 4_096;
export const RUNTIME_TOME_MAX_SAN_DIE_SIDES = 1_000_000;
export const RUNTIME_TOME_MAX_SAN_LOSS = 1_000_000;

function runtimeTomeText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function runtimeTomeBoundedInteger(text: string, maximum: number): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

/** Validate one exact executable SAN-cost component before SanityEngine sees it. */
function assertRuntimeTomeSanCostComponent(component: string): void {
  const fixed = runtimeTomeBoundedInteger(component, RUNTIME_TOME_MAX_SAN_LOSS);
  if (fixed !== null) return;

  const dice = /^([1-9]\d*)d([1-9]\d*)(?:\+((?:0|[1-9]\d*)))?$/.exec(component);
  if (!dice) throw new Error("runtime tome SAN cost component is invalid");
  const count = runtimeTomeBoundedInteger(dice[1]!, RUNTIME_TOME_MAX_SAN_DICE_COUNT);
  const sides = runtimeTomeBoundedInteger(dice[2]!, RUNTIME_TOME_MAX_SAN_DIE_SIDES);
  const modifier = dice[3] === undefined ? 0 : runtimeTomeBoundedInteger(dice[3], RUNTIME_TOME_MAX_SAN_LOSS);
  if (count === null || count === 0 || sides === null || sides === 0
    || modifier === null || count * sides + modifier > RUNTIME_TOME_MAX_SAN_LOSS) {
    throw new Error("runtime tome SAN dice are outside executable bounds");
  }
}

/**
 * Produce an independent, executable tome declaration.  Every install path
 * and the session's narrow registration callback use this one contract.
 */
export function normalizeRuntimeModuleTome(value: unknown): RuntimeModuleTome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime tome declaration is invalid");
  }
  const tome = value as Record<string, unknown>;
  if (!runtimeTomeText(tome.name) || !runtimeTomeText(tome.sceneId)
    || !runtimeTomeText(tome.sanCost) || !runtimeTomeText(tome.openDescription)
    || typeof tome.tomeRating !== "number" || !Number.isSafeInteger(tome.tomeRating) || tome.tomeRating < 1
    || tome.tomeRating > RUNTIME_TOME_MAX_RATING || !Array.isArray(tome.spells)
    || tome.spells.some((spell) => !runtimeTomeText(spell))) {
    throw new Error("runtime tome declaration is invalid");
  }

  const components = tome.sanCost.split("/");
  if (components.length !== 2 || components.some((component) => component.length === 0)) {
    throw new Error("runtime tome SAN cost must have exactly two components");
  }
  components.forEach(assertRuntimeTomeSanCostComponent);

  const spells = [...tome.spells];
  if (new Set(spells).size !== spells.length) {
    throw new Error("runtime tome spells contain duplicate names");
  }
  return {
    name: tome.name,
    sceneId: tome.sceneId,
    sanCost: tome.sanCost,
    tomeRating: tome.tomeRating,
    spells,
    openDescription: tome.openDescription,
  };
}

/** Same-name declarations are only idempotent when every executable field agrees. */
export function sameRuntimeModuleTome(left: RuntimeModuleTome, right: RuntimeModuleTome): boolean {
  return left.name === right.name && left.sceneId === right.sceneId && left.sanCost === right.sanCost
    && left.tomeRating === right.tomeRating && left.openDescription === right.openDescription
    && left.spells.length === right.spells.length && left.spells.every((spell, index) => spell === right.spells[index]);
}

/** Validate a complete declaration list before the host receives its first write. */
export function normalizeRuntimeModuleTomes(value: unknown): RuntimeModuleTome[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("runtime tome declarations must be an array");
  const tomes = value.map(normalizeRuntimeModuleTome);
  const byName = new Map<string, RuntimeModuleTome>();
  for (const tome of tomes) {
    const prior = byName.get(tome.name);
    if (prior && !sameRuntimeModuleTome(prior, tome)) {
      throw new Error(`runtime tome declaration conflicts for ${tome.name}`);
    }
    byName.set(tome.name, tome);
  }
  return tomes;
}

// Kept separate from ModuleData.ModuleItem: this is a placement record,
// not a rich interactable item with an id, type, revelation, or trap rules.
export interface RuntimeItemPlacement {
  name: string;
  sceneId: string;
  description?: string;
}

/**
 * Package-declared physical item identity, narrowed to the only facts an
 * ordinary GameSession pickup needs.  A declaration's source shape remains in
 * its loader; this normalized view prevents the session from inferring an
 * item, a scene, or pickup permission from player input.
 */
export interface RuntimePickupOrigin {
  name: string;
  sceneId: string;
}

type RuntimePickupDeclarationKind = "legacy" | "tome" | "key" | "document" | "weapon" | "loot" | "trap";

interface RuntimePickupDeclaration extends RuntimePickupOrigin {
  kind: RuntimePickupDeclarationKind;
}

function runtimePickupRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function runtimePickupText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function runtimePickupLegacyDeclarations(value: unknown): RuntimePickupDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("runtime item placements must be an array");
  return value.map((item) => {
    if (!runtimePickupRecord(item) || !runtimePickupText(item.name) || !runtimePickupText(item.sceneId)
      || (item.description !== undefined && !runtimePickupText(item.description))) {
      throw new Error("runtime item placement is invalid");
    }
    return { name: item.name, sceneId: item.sceneId, kind: "legacy" };
  });
}

function runtimePickupRichDeclarations(value: unknown): RuntimePickupDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("runtime rich items must be an array");
  return value.map((item) => {
    if (!runtimePickupRecord(item) || !runtimePickupText(item.name) || !runtimePickupText(item.sceneId)
      || !runtimePickupText(item.id) || !runtimePickupText(item.description)
      || !["key", "document", "weapon", "loot", "trap"].includes(item.type as string)) {
      throw new Error("runtime rich item is invalid");
    }
    return { name: item.name, sceneId: item.sceneId, kind: item.type as RuntimePickupDeclarationKind };
  });
}

/**
 * Validate the cross-representation item namespace before any loader host
 * callback.  `legacy` declarations intentionally have no pickup semantics;
 * they can be the historical duplicate of a richer document or tome.  A
 * tome's compatible rich representation is a document.  All other competing
 * semantics, a trap/pickup collision, or a same name at different locations
 * makes physical identity ambiguous and fails closed.
 */
export function normalizeRuntimeModulePickupOrigins(input: {
  tomes?: unknown;
  itemPlacements?: unknown;
  richItems?: unknown;
}): RuntimePickupOrigin[] {
  const tomes = normalizeRuntimeModuleTomes(input.tomes).map((tome) => ({
    name: tome.name,
    sceneId: tome.sceneId,
    kind: "tome" as const,
  }));
  const declarations = [
    ...tomes,
    ...runtimePickupLegacyDeclarations(input.itemPlacements),
    ...runtimePickupRichDeclarations(input.richItems),
  ];
  const byName = new Map<string, RuntimePickupDeclaration[]>();
  for (const declaration of declarations) {
    const existing = byName.get(declaration.name) ?? [];
    if (existing.some((prior) => prior.sceneId !== declaration.sceneId)) {
      throw new Error(`runtime pickup item location conflicts for ${declaration.name}`);
    }
    existing.push(declaration);
    byName.set(declaration.name, existing);
  }

  const origins: RuntimePickupOrigin[] = [];
  for (const [name, declarationsForName] of byName) {
    const kinds = new Set(declarationsForName.map((declaration) => declaration.kind));
    const hasTrap = kinds.has("trap");
    const pickupKinds = [...kinds].filter((kind) => kind !== "trap" && kind !== "legacy");
    // The older placement list did not encode an item type, so an existing
    // trap may legitimately be mirrored there as `legacy`.  A typed trap wins
    // over that untyped historical placement; only a second *pickable*
    // semantic makes the declaration contradictory.
    if (hasTrap && pickupKinds.length > 0) {
      throw new Error(`runtime pickup item semantics conflict for ${name}`);
    }
    if (hasTrap) continue;

    const richKinds = pickupKinds.filter((kind) => kind !== "tome");
    if (richKinds.length > 1 || (kinds.has("tome") && richKinds.some((kind) => kind !== "document"))) {
      throw new Error(`runtime pickup item semantics conflict for ${name}`);
    }
    origins.push({ name, sceneId: declarationsForName[0]!.sceneId });
  }
  return origins;
}

// Kept separate from EndNarration/Ending: conditionText is LLM-facing prose,
// not the structured, machine-evaluable condition used by EndNarration.
export interface RuntimeModuleEnding {
  id: string;
  name: string;
  description: string;
  conditionText: string;
  narration?: string;
}

export interface RuntimeModuleReward {
  id: string;
  description: string;
  conditionText: string;
  sanChange?: string;
  cmChange?: number;
  reputationChange?: number;
  skillGrowth?: Record<string, string>;
}

// Kept separate from Clue: Mythos bindings only name an InvestigationEngine
// clue and optional copy/SAN cost; they do not express discovery mechanics.
export interface RuntimeClueBinding {
  scene: string;
  clueType: string;
  description?: string;
  sanCost?: string;
}

export interface RuntimeModuleHook {
  type: "on_enter_scene" | "on_combat_start" | "on_read_tome" | "on_investigate";
  condition: string;
  narration?: string;
  effect?: string;
}

export interface RuntimeInitialEffect {
  target: string;
  field: string;
  value: unknown;
}

export interface RuntimeNpcPersonality {
  role?: string;
  personality?: string;
  background?: string;
  goals?: string[];
  speech_style?: string;
  knowledge?: string[];
  secrets?: string[];
  attitudes?: Record<string, string>;
  traits?: {
    courage: number;
    friendliness: number;
    suspicion: number;
    curiosity: number;
    stability: number;
  };
  initialMood?: NPCMood;
  factions?: Array<{ name: string; loyalty: number }>;
}

// Explicit nested combat/loader configuration for a narrative ModuleNPC.
// id/name/sceneId remain on ModuleNPC itself; these fields are intentionally
// not mixed with narrative role/description/knowledge/secrets.
export interface RuntimeNpcConfig {
  type: "npc" | "monster";
  hp: number;
  maxHp: number;
  ac: number;
  faction: string;
  /** Initial source-declared conditions; the host must not silently reset them. */
  status?: string[];
  tacticsKey?: string;
  mythosCreatureId?: string;
  attributes?: Record<string, number>;
  skills?: Record<string, number>;
  age?: number;
  gender?: "male" | "female";
  dialogHints?: string[];
  npcPersonalityId?: string;
  personality?: RuntimeNpcPersonality;
}

// A runtime snapshot is what gets nested in a narrative ModuleNPC. Source
// identity stays explicit because the two active representations can differ.
export interface RuntimeNpcSnapshot extends RuntimeNpcConfig {
  sourceId: string;
  sourceName: string;
  sceneId: string;
}

// ModuleData.runtime is deliberately loader-shaped rather than ModuleSupport:
// it stores serializable configuration, while ModuleSupport remains reserved
// for module-specific executable hooks and constants.
export interface ModuleRuntimeConfig {
  sourceIdentity?: RuntimeModuleIdentity;
  activation?: RuntimeActivation;
  difficulty?: RuntimeDifficulty;
  /** Explicit module entry; omitted legacy modules retain first-scene entry semantics. */
  entrySceneId?: string;
  source?: string;
  introNarration?: string;
  spells?: RuntimeModuleSpell[];
  tomes?: RuntimeModuleTome[];
  rewards?: RuntimeModuleReward[];
  kpNotes?: Record<string, string>;
  initialEffects?: RuntimeInitialEffect[];
  hooks?: RuntimeModuleHook[];
  sceneBgm?: Record<string, string>;
  sceneAliases?: Record<string, string[]>;
  runtimeNpcOrder?: string[];
  runtimeNpcs?: RuntimeNpcSnapshot[];
  npcStats?: Record<string, Record<string, number | string>>;
  legacyEndings?: RuntimeModuleEnding[];
  itemPlacements?: RuntimeItemPlacement[];
  /** rich ModuleData clue id -> structured CoC SAN cost. */
  richClueSanCosts?: Record<string, string>;
}
