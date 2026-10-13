import { readFileSync } from "fs";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { loadConfig, type LLMConfig } from "../config";
import { LLMClient, type LLMLike } from "../llm/client";
import { MockLLMClient } from "../llm/mock-client";
import {
  declareIntentPath,
  resolveNormalSessionIntent,
  type NormalSessionIntentClient,
  type NormalSessionIntentPolicy,
} from "../llm/intent";
import { parseOrdinaryLocalCommand, type OrdinaryLocalCommand } from "../llm/ordinary-local-command";
import { generateNarrativeWithLLM } from "../llm/narrator";
// llmEnabled 是「该不该打网络」的**唯一**判据，别在别处重写一份 ——
// play-module.ts:101 记着上次抄第二份的代价。
import { isUsableLlmApiKey, llmDisabledByOverride, llmEnabled } from "../llm/enabled";
import { resolvePlayerMetaSync, type PlayerMeta } from "../character/player-metadata";

// 状态定义库 + 时限口径。存储仍是 `status: string[]`，这里只提供定义与推进规则。
import { getActionBlockingStatus, getPercentileTargetModifier, newStatus, parseStatus, tickStatuses } from "../rules/status-effects";
import { RulesEngine, type CombatFollowUpResult, type RulesetId } from "../rules/rules-engine";
import { CoCEngine, SanityEngine, type SanityState, calcDamageBonus, checkMajorWound, cocCombatRollHits, cocSuccessLevelForRoll, sanOutcomeLabel } from "../rules/coc-engine";

import { KPAgent } from "../agent/kp-agent";
import { AgentRegistry } from "../agent/agent-registry";
import { WorldStateManager } from "../state/world-state-manager";
import { NPCCombatEngine, NPC_UNARMED_SKILL } from "../combat/npc-combat";
import { CompanionManager } from "../combat/companion-manager";
import { PlayerSession, type VisibilityRule } from "../session/player-session";
import { InvestigationEngine } from "../investigation/investigation-engine";
import { decideClueMatch, extractLocationHint, splitKeys } from "../investigation/clue-match";
import { unrepresentedCharacterNouns } from "../investigation/scene-npc-noun-registry";
import { WorldModelLoader, sharedWorldModel, DEFAULT_CTHULHU_PATH, type V18Entry } from "../world/world-model-loader";
import { WorldModelIntegrator, type SceneContext, type NPCPresentProfile } from "../world/world-model-integrator";
import { checkNarrationText, sourceReviewedNarrationTechnologyTerms } from "../world/world-constraint";
import {
  assertCompiledCthulhuWorldModelBindingArtifactIdentity,
  buildCompiledCthulhuWorldModelContext,
  validateCompiledCthulhuWorldModelBinding,
  type CompiledCthulhuWorldModelBinding,
  type CompiledWorldModelPromptContext,
} from "../world/compiled-world-model-scope";
import { NPCStore } from "../db/index";
import { getDifficultyProfile } from "../rules/module-difficulty";
import type { DifficultyProfile } from "../rules/module-difficulty";
import { applyAction, type GateState, type RejectReason, type Result, type StateDelta } from "../rules/apply-action";
import { boundedIntegerGateState, boundedIntegerScenario, buildDifficultyGateState, COC_SESSION_SCENARIO, isDifficultyLabel } from "../rules/coc-session-scenario";
import { CharacterFactory, getArchetype, type LegendaryAction } from "../character/character-factory";
import { buildCoCCharacter, COC_ATTRIBUTES, COC_SKILL_BASES, SKILL_NAME_MAP, getCoCArchetypes, resolveCheckValue } from "../character/coc-character";
import { drawRandomUnit, RandomUnitError, type RandomUnit } from "../character/random-unit";
import { StoryGenerator } from "../rules/story-generator";
import { generatedStoryToRuntimeModuleData } from "../module/generated-story-runtime-module";
import { CareerFileStore, type CareerPortableProjection } from "../character/career-file";
import { createGameTime, advanceTime, formatGameTime, periodAtmosphere, isNightPeriod, type GameTime } from "../rules/game-time";
import { listTables, rollTable } from "../rules/random-tables";

import { MythosModuleLoader, type MythosModule, type MythosModuleHost } from "../rules/mythos-module";
import { PoliticoEconomyEngine } from "../economy/politic-economy-engine";
import { ARKHAM_LIBRARY_MODULE, INNSMOUTH_MODULE } from "../rules/mythos-module";
import { getModule as getCustomModule } from "../rules/custom-modules/index";
import { ModuleDataRuntimeLoader, validateRuntimeModuleDataForInstall, type ModuleDataRuntimeHost } from "../module/module-data-runtime-loader";
import { isRuntimeModuleData, type Clue, type RuntimeModuleData } from "../module/types";
import {
  normalizeRuntimeModulePickupOrigins,
  normalizeRuntimeModuleTome,
  sameRuntimeModuleTome,
  type RuntimePickupOrigin,
  type RuntimeModuleReward,
  type RuntimeModuleTome,
  type RuntimeNpcPersonality,
} from "../module/runtime-types";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { compiledBundleCatalogHash, type LoadedBundleCatalogEntry } from "../compiler/compiler-artifact-catalog";
import type { CompilerModuleDataProjection, ProjectionFieldOrigin } from "../compiler/compiler-module-data-projection";
import { validateCompiledModuleBundle } from "./compiled-module-bundle";
import {
  assertRuntimeModulePackage,
  mythosLegacyPackage,
  runtimeModuleDataLegacyPackage,
  type RuntimeModulePackage,
} from "./runtime-module-package";
import {
  availableMechanicsPlayerActions,
  createMechanicsStateBudget,
  executeMechanicsAction,
  mechanicsStateHash,
  nextAutomaticMechanicsStep,
  settleAutomaticMechanics,
  settleInitialMechanics,
  type MechanicsAnalysisInput,
  type MechanicsCombatOutcome,
  type MechanicsReachabilityEdge,
  type MechanicsState,
  type MechanicsStateBudget,
  type SelectedActorEffect,
} from "../compiler/mechanics-execution";
import type { CheckSpec, CombatDamageSpec, DiscoveryAction, MechanicsIR, SanityCheckSettlement, SanityLossSpec, TerminalRewardSettlement } from "../compiler/mechanics-ir";
import {
  canonicalJson,
  cloneJson,
  COMPILED_SESSION_COMPONENT_VERSIONS,
  COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION,
  COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION,
  CompiledSessionSnapshotPersistenceError,
  compiledSessionSnapshotHash,
  replayCompiledSessionTrace,
  validateCompiledSessionSnapshot,
  validatePersistedCompiledActionResponse,
  type CompiledSessionIdempotencyRecord,
  type CompiledSessionAccessBinding,
  type CompiledSessionSnapshot,
  type CompiledCombatSettlement,
  type CompiledSkillGrowthReceipt,
  type CompiledSkillGrowthSettlement,
  type JsonRecord,
  type JsonValue,
  type PersistedCompiledActionResponse,
} from "./compiled-session-snapshot";
import { isOrdinarySessionAccessBinding, sameOrdinarySessionAccessBinding, type OrdinarySessionAccessBinding } from "./session-access";
import { resolveFirstAidSkillSource } from "./first-aid-skill-source";
import {
  createOrdinaryGameSessionSnapshot,
  normalizeOrdinaryCoCCharacterSheet,
  normalizeOrdinaryRuntimeModulePackage,
  ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
  ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
  ordinaryGameSessionBusinessStateHash,
  ordinaryGameSessionModuleHash,
  validateOrdinaryGameSessionSnapshot,
  type OrdinaryGameSessionSnapshot,
  type OrdinarySessionTerminal,
  type OrdinarySnapshotJson,
} from "./ordinary-game-session-snapshot";
import { captureSanityCohort, isSanityCohortCurrent } from "./sanity-cohort-fence";
import { sha256 } from "../ingest/document-ir";
import { resolveSceneTarget, mentionedSceneNames, hasMovementSignalNearMention, type SceneRow } from "../play/scene-resolve";
import { buildSceneGraph, shortestHops } from "../play/move-graph";
import { isExplicitLeaveIntent, isConfirmReply, MODULE_ENDING_SUPPORT, GENERIC_DEPARTURE_LINES } from "../play/module-departure";

import type { WorldEntity, ActionIntent, CombatPersonalityTraits } from "../types";
import type { NPCPersonality, AgentMessage, MessageType, NPCMood } from "../agent/types";
import { asNPCMood } from "../agent/types";
import { voiceKeyFor } from "../voice/speech-plan";
import { log } from "../log";

type LoadedModule = MythosModule | RuntimeModuleData;

/** The public GameSession view deliberately excludes every PlayerSession mutator. */
type PlayerSessionReadFacade = Readonly<Pick<PlayerSession,
  | "count"
  | "semanticRevision"
  | "stateReplacementRevision"
  | "get"
  | "getActive"
  | "getAll"
  | "getAllNames"
  | "snapshot"
  | "exportSnapshot"
  | "getPlayerHistory"
  | "getActiveHistory"
  | "getRecentGlobal"
  | "knowsSecret"
  | "getPlayerScene"
  | "getPlayersInScene"
>>;

/**
 * Explicit GameSession world capability surface.  This is intentionally not
 * `Pick<WorldStateManager, keyof WorldStateManager>`: new manager members
 * must be reviewed before a GameSession consumer can acquire them.
 *
 * The facade retains today's high-level world operations for compatibility.
 * It deliberately excludes SQLite ownership, snapshot replacement, and
 * lifecycle authority (`getDatabase`, `restoreSnapshot`, and `close`).
 */
export type GameSessionWorldReadFacade = Readonly<Pick<WorldStateManager,
  | "getEntity"
  | "getEntityByName"
  | "getEntitiesInScene"
  | "getAllAliveEntities"
  | "getPlayerIds"
  | "getPlayerState"
  | "getPlayerSanity"
  | "getPlayerInventory"
  | "getPlayerWeapons"
  | "getPlayerArmor"
  | "isClueDiscoveredBy"
  | "getCluesDiscoveredBy"
  | "isClueDiscoveredByAnyone"
  | "getClueFailCount"
  | "isSceneVisitedBy"
  | "getScenesVisitedBy"
  | "isSceneVisitedByAnyone"
  | "getActiveEffects"
  | "exportSnapshot"
  | "getLatestContext"
  | "getCurrentState"
  | "buildContextPrompt"
  | "getRecentEvents"
  | "getScene"
  | "listScenes"
  | "getAttitude"
>>;

const GAME_SESSION_WORLD_READ_METHODS = [
  "getEntity", "getEntityByName", "getEntitiesInScene", "getAllAliveEntities",
  "getPlayerIds", "getPlayerState", "getPlayerSanity", "getPlayerInventory",
  "getPlayerWeapons", "getPlayerArmor", "isClueDiscoveredBy", "getCluesDiscoveredBy",
  "isClueDiscoveredByAnyone", "getClueFailCount", "isSceneVisitedBy", "getScenesVisitedBy",
  "isSceneVisitedByAnyone", "getActiveEffects", "exportSnapshot", "getLatestContext",
  "getCurrentState", "buildContextPrompt", "getRecentEvents", "getScene", "listScenes",
  "getAttitude",
] as const satisfies readonly (keyof GameSessionWorldReadFacade)[];

/** Bind only detached, observation-only world reads to this session's raw authority. */
function createGameSessionWorldReadFacade(resolveWorld: () => WorldStateManager): GameSessionWorldReadFacade {
  type MutableFacade = { -readonly [K in keyof GameSessionWorldReadFacade]: GameSessionWorldReadFacade[K] };
  const facade = Object.create(null) as MutableFacade;
  const bindings = facade as unknown as Record<string, unknown>;
  for (const key of GAME_SESSION_WORLD_READ_METHODS) {
    // Keep the public wrapper identity stable while resolving the canonical
    // raw method at call time. The shared resolver is also the lifecycle
    // boundary: a retained facade must fail closed before a pure/cached
    // reader or SQLite-backed reader can reach the hidden manager.
    bindings[key] = (...args: unknown[]) => {
      const world = resolveWorld();
      return (world[key] as unknown as (...values: unknown[]) => unknown).apply(world, args);
    };
  }
  return Object.freeze(facade);
}

/**
 * Public observation of the registered NPC names only.  `AgentRegistry`
 * owns live NPCAgents, persistence binding, hooks, and snapshot replacement;
 * those are session authority, not a caller capability.
 */
type AgentRegistryReadFacade = Readonly<{
  readonly count: number;
  has: (name: string) => boolean;
  getAllNames: () => readonly string[];
}>;

function isModuleData(module: LoadedModule): module is RuntimeModuleData {
  return isRuntimeModuleData(module);
}

function sameNullableOrdinaryAccessBinding(
  left: OrdinarySessionAccessBinding | null,
  right: OrdinarySessionAccessBinding | null,
): boolean {
  return left === null || right === null ? left === right : sameOrdinarySessionAccessBinding(left, right);
}

/**
 * Small, non-snapshot identity acknowledged only after an ordinary envelope
 * has become authoritative.  Request-time routing compares this constant-size
 * value to the store header/body rather than attempting a forbidden (and
 * expensive) snapshot export while another FIFO action is running.
 */
export interface OrdinarySessionDurableIdentity {
  generation: number;
  envelopeHash: string;
  snapshotHash: string;
}

/** The current committed compiled pointer, readable only through the same
 * constructor-installed durable host capability that owns its snapshot chain. */
export interface CompiledSessionDurableIdentity {
  sessionId: string;
  bundleId: string;
  generation: number;
  snapshotHash: string;
}

/** Canonical equality for runtime values that are structurally portable JSON. */
function samePortableJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
  } catch {
    return false;
  }
}

type RuntimeModulePackageInstall =
  | { kind: "compiled_bundle"; result: CompiledModuleLoadResult }
  | { kind: "runtime_module_data_legacy"; module: RuntimeModuleData; lines: string[]; entryScene?: string }
  | { kind: "mythos_legacy"; module: MythosModule; lines: string[] };

/** The only compiled action syntax accepted by GameSession: `@compiled <exact mechanism ID>`. */
export function compiledMechanicsAction(mechanismId: string): string {
  if (!mechanismId || mechanismId.trim() !== mechanismId || /[\r\n]/.test(mechanismId)) {
    throw new Error("compiled mechanism ID must be non-empty, trimmed, and single-line");
  }
  return `@compiled ${mechanismId}`;
}

/** Opaque, generation-bound façade token; mechanism IDs never cross this boundary. */
function compiledPlayerChoiceId(choiceHmacKey: string, generation: number, mechanismId: string): string {
  if (!/^[a-f0-9]{64}$/.test(choiceHmacKey) || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("compiled player choice binding is invalid");
  }
  return `choice_${createHmac("sha256", Buffer.from(choiceHmacKey, "hex"))
    .update(canonicalJson({ domain: "compiled-player-choice-v1", generation, mechanismId }))
    .digest("base64url")}`;
}

function parseCompiledMechanicsAction(input: string): string | null {
  const prefix = "@compiled ";
  if (!input.startsWith(prefix)) return null;
  const mechanismId = input.slice(prefix.length);
  return mechanismId && mechanismId.trim() === mechanismId && !/[\r\n]/.test(mechanismId) ? mechanismId : null;
}

/** Discovery labels deliberately use only declared action vocabulary, never clue metadata. */
function compiledDiscoveryLabel(action: DiscoveryAction): string {
  switch (action) {
    case "observe": return "Observe here";
    case "search": return "Search here";
    case "talk": return "Talk here";
    case "read": return "Read here";
    case "use_item": return "Use an item";
    case "move": return "Proceed";
    case "custom": return "Take action";
  }
}

/**
 * Rule keys (skills and attributes) are part of the sealed compiled model.
 * Keep this closed so a future check variant cannot become externally visible
 * merely because it has a familiar difficulty field.
 */
function compiledPlayerFacadeCheck(check: CompiledAvailableActionCheck): CompiledPlayerFacadeCheck {
  if (check.kind !== "skill" && check.kind !== "attribute") {
    throw new Error("compiled player façade check is unsupported");
  }
  switch (check.difficulty) {
    case "regular":
    case "hard":
    case "extreme":
      return { kind: "check", difficulty: check.difficulty };
    default:
      throw new Error("compiled player façade check difficulty is unsupported");
  }
}

function compiledEncounterDefinitionForNpc(ir: MechanicsIR, npcId: string) {
  return ir.encounterDefinitions.find((definition) => definition.combatantId === npcId);
}

/** Noncombat NPC presence is read from the sealed projection, never legacy state. */
function compiledProjectionNpcView(projection: CompilerModuleDataProjection, ir: MechanicsIR, sceneId: string): ActionResponse["state"]["npcs"] {
  const scene = projection.module.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw new Error(`compiled NPC projection lacks mechanics scene: ${sceneId}`);
  const npcs = new Map(projection.module.npcs.map((npc) => [npc.id, npc]));
  const ids = new Set<string>();
  return scene.npcIds.map((id) => {
    if (ids.has(id)) throw new Error(`compiled NPC projection duplicates scene NPC: ${id}`);
    ids.add(id);
    const npc = npcs.get(id);
    if (!npc || npc.sceneId !== sceneId) throw new Error(`compiled NPC projection has an invalid scene binding: ${id}`);
    if (compiledEncounterDefinitionForNpc(ir, id)) return null;
    return { name: npc.name, hp: 1, maxHp: 1, status: ["narrative_noncombat"] };
  }).filter((npc): npc is { name: string; hp: number; maxHp: number; status: string[] } => npc !== null);
}

/** Encounter HP lives only in MechanicsState; this is a read-only hostile mirror. */
function compiledProjectionMonsterView(
  projection: CompilerModuleDataProjection,
  ir: MechanicsIR,
  state: MechanicsState,
  sceneId: string,
): ActionResponse["state"]["monsters"] {
  const npcs = new Map(projection.module.npcs.map((npc) => [npc.id, npc]));
  return ir.encounterDefinitions
    .filter((definition) => definition.sceneId === sceneId)
    .flatMap((definition) => {
      const encounter = state.encounters[definition.encounterId];
      const npc = npcs.get(definition.combatantId);
      if (!encounter) return [];
      if (!npc || npc.sceneId !== definition.sceneId) throw new Error(`compiled encounter lacks its trusted projected NPC: ${definition.encounterId}`);
      return [{ name: npc.name, hp: encounter.currentHp, maxHp: definition.maxHp, status: encounter.status === "active" ? ["hostile"] : ["defeated"] }];
      });
}

function compiledCombatDamageDice(damage: CombatDamageSpec): string {
  return damage.kind === "fixed" ? (damage.amount === 1 ? "1d1" : `1d1+${damage.amount - 1}`) : `${damage.count}d${damage.sides}`;
}

function compiledCombatSkill(sheet: unknown, key: "fighting" | "dodge"): number {
  const value = (sheet as { skillValues?: Record<string, unknown> } | undefined)?.skillValues?.[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error(`compiled combat requires an exact ${key} skill value`);
  }
  return value;
}

function compiledCombatActor(sheet: { name?: unknown; hp?: unknown; maxHp?: unknown; attributes?: unknown }): { name: string; hp: number; maxHp: number; attributes?: Record<string, number> } {
  if (typeof sheet.name !== "string" || !sheet.name || typeof sheet.hp !== "number" || !Number.isSafeInteger(sheet.hp) || sheet.hp < 1
    || typeof sheet.maxHp !== "number" || !Number.isSafeInteger(sheet.maxHp) || sheet.maxHp < sheet.hp) {
    throw new Error("compiled combat requires a living, bounded player character");
  }
  const attributes = sheet.attributes;
  if (attributes !== undefined && (!attributes || typeof attributes !== "object" || Array.isArray(attributes)
    || !Object.values(attributes as Record<string, unknown>).every((entry) => typeof entry === "number" && Number.isFinite(entry)))) {
    throw new Error("compiled combat character attributes are invalid");
  }
  return { name: sheet.name, hp: sheet.hp, maxHp: sheet.maxHp, ...(attributes === undefined ? {} : { attributes: structuredClone(attributes as Record<string, number>) }) };
}

function createCompiledCombatEntropy(randomUnit?: () => number): { units: number[]; random: () => number } {
  const units: number[] = [];
  return {
    units,
    random: () => {
      let unit: number;
      if (randomUnit) {
        unit = randomUnit();
      } else {
        if (!globalThis.crypto?.getRandomValues) throw new Error("compiled combat requires a cryptographic entropy source");
        const word = new Uint32Array(1);
        globalThis.crypto.getRandomValues(word);
        unit = word[0]! / 0x1_0000_0000;
      }
      if (!Number.isFinite(unit) || unit < 0 || unit >= 1) throw new Error("compiled combat entropy unit is invalid");
      units.push(unit);
      return unit;
    },
  };
}

class CharacterEntropyError extends Error {}

/**
 * Character construction never consumes process-global Math.random from a
 * GameSession. A host may supply a per-session deterministic seam, but each
 * draw remains a strict unit interval so malformed entropy cannot create a
 * partially invalid character sheet.
 */
function createCharacterEntropy(randomUnit?: RandomUnit): RandomUnit {
  return () => {
    const source: RandomUnit = randomUnit ?? (() => {
      if (!globalThis.crypto?.getRandomValues) throw new CharacterEntropyError("character construction requires a cryptographic entropy source");
      const word = new Uint32Array(1);
      globalThis.crypto.getRandomValues(word);
      return word[0]! / 0x1_0000_0000;
    });
    try {
      return drawRandomUnit(source);
    } catch (error) {
      if (error instanceof CharacterEntropyError) throw error;
      if (error instanceof RandomUnitError) throw new CharacterEntropyError("character construction entropy unit is invalid");
      throw new CharacterEntropyError("character construction entropy source failed");
    }
  };
}

export interface GameSessionRuntimeDependencies {
  /**
   * Trusted host-only session-bound intent capability. It is deliberately
   * absent from request, module, and snapshot contracts; omit it to construct
   * the production client from this session's LLMConfig.
   */
  sessionIntentClient?: NormalSessionIntentClient;
  /** Test/runtime seam scoped to one session; production defaults to crypto.getRandomValues. */
  compiledCombatRandom?: () => number;
  /**
   * Trusted per-session character-construction entropy seam. Request and
   * module data cannot select it; every draw is validated as [0, 1).
   */
  characterRandomUnit?: RandomUnit;
  /**
   * Trusted host-selected legacy reference scope. It is runtime-only, is not
   * an artifact binding, and request/module data must never select it.
   */
  worldModelNovel?: string;
  /**
   * Trusted host-selected legacy v18 reference loader. It remains an alias
   * retained by the injector, so request and module data must never select or
   * mutate it. Omit it to use the process-shared immutable reference model.
   */
  worldModelLoader?: WorldModelLoader;
  /**
   * Trusted host-selected aggregate Cthulhu reference loader. It is paired
   * with `worldModelLoader` only by the host; the session constructs its own
   * integrator from the selected v18 raw loader and never accepts one here.
   */
  cthulhuWorldModelLoader?: WorldModelLoader;
  /**
   * Explicit NPC persistence authority. Omit it for a private in-memory store.
   * Every injected store remains caller-owned, so it may safely be shared by
   * multiple GameSessions.
   */
  npcStore?: NPCStore;
  /** Local story source for this session; production uses StoryGenerator. */
  storyGenerator?: Pick<StoryGenerator, "generate">;
  /**
   * Trusted host-only policy for ordinary module-departure career entries.
   * It is intentionally absent from request, module, and snapshot inputs.
   */
  careerEntryPersistence?: "durable" | "transient";
  /**
   * Opaque, host-owned capability for durable ordinary session work. It is
   * neither serialized nor exposed by GameSession. A server factory installs
   * it once; a caller that only holds a session cannot recover it.
   */
  ordinaryDurableHostCapability?: object;
  /**
   * Opaque, host-owned capability for durable compiled session work.  The
   * compiled access binding contains a choice HMAC key and may contain an
   * invitation verifier, so it must never cross a GameSession public method.
   */
  compiledDurableHostCapability?: object;
}

function validHexHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sameHexHash(left: string, right: string): boolean {
  return validHexHash(left) && validHexHash(right)
    && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/** The established v1 opaque player-request binding remains byte-for-byte
 * stable for legacy three-field action retries. */
export function compiledPlayerNarrationPublicRequestHash(choiceId: string, actionId: string, expectedGeneration: number): string {
  return createHash("sha256").update(JSON.stringify({
    domain: "compiled-player-narration-public-request-v1",
    choiceId,
    actionId,
    expectedGeneration,
  }), "utf8").digest("hex");
}

export function compiledPlayerNarrationTopicTokenHash(topicBound: string): string {
  return createHash("sha256").update(canonicalJson({
    domain: "compiled-player-narration-topic-token-v2",
    topicBound,
  })).digest("hex");
}

export function compiledPlayerNarrationV2RequestHash(
  basePublicRequestHash: string,
  topicTokenHash: string,
  topicBindingHash: string,
): string {
  if (![basePublicRequestHash, topicTokenHash, topicBindingHash].every(validHexHash)) {
    throw new Error("compiled player narration v2 request binding is invalid");
  }
  return createHash("sha256").update(canonicalJson({
    domain: "compiled-player-narration-public-request-v2",
    basePublicRequestHash,
    topicTokenHash,
    topicBindingHash,
  })).digest("hex");
}

/** MechanicsState owns item IDs; these are read-only source-exact presentation views. */
function compiledProjectionItemView(
  projection: CompilerModuleDataProjection,
  state: MechanicsState,
  sceneId: string,
): { inventory: string[]; sceneItems: string[] } {
  const itemsById = new Map(projection.module.items.map((item) => [item.id, item]));
  if (itemsById.size !== projection.module.items.length) throw new Error("compiled item projection duplicates item ID");
  for (const itemId of state.ownedItemIds) if (!itemsById.has(itemId)) throw new Error(`compiled mechanics owns an item absent from projection: ${itemId}`);
  const owned = new Set(state.ownedItemIds);
  return {
    inventory: state.ownedItemIds.map((itemId) => itemsById.get(itemId)!.name),
    sceneItems: projection.module.items
      .filter((item) => item.sceneId === sceneId && !owned.has(item.id))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => item.name),
  };
}

function clonedSanity(source: SanityEngine, fallbackPower: number): SanityEngine {
  const next = new SanityEngine(fallbackPower);
  next.restoreState(source.state);
  return next;
}

/** A stable action-bound dice stream prevents persistence retries from re-rolling. */
function terminalRewardDice(mechanicsHash: string, beforeStateHash: string, rewardId: string, count: number, sides: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const word = sha256(`${mechanicsHash}|${beforeStateHash}|${rewardId}|${index}`).slice(0, 8);
    return Number.parseInt(word, 16) % sides + 1;
  });
}

function compiledSanityView(sanity: SanityEngine): NonNullable<ActionResponse["sanity"]> {
  return {
    currentSAN: sanity.state.currentSAN,
    maxSAN: sanity.state.maxSAN,
    temporaryInsanity: sanity.state.temporaryInsanity,
    indefiniteInsanity: sanity.state.indefiniteInsanity,
    indefiniteLevel: sanity.state.indefiniteLevel,
    phobias: [...sanity.state.phobias],
    manias: [...sanity.state.manias],
  };
}

function sanityStateHash(sanity: JsonRecord): string { return sha256(canonicalJson(sanity)); }

/** Stable, action-bound stream: retries/restarts reproduce every SAN draw exactly. */
function compiledSanityRandom(sessionId: string, mechanicsHash: string, beforeStateHash: string, generation: number, mechanismId: string, outcome: string, effectIndex: number): () => number {
  let drawIndex = 0;
  return () => {
    const word = sha256(`compiled-sanity-v1|${sessionId}|${mechanicsHash}|${beforeStateHash}|${generation}|${mechanismId}|${outcome}|${effectIndex}|${drawIndex++}`).slice(0, 8);
    return Number.parseInt(word, 16) / 0x1_0000_0000;
  };
}

function rollSanityLoss(loss: SanityLossSpec, random: () => number): { rolls: number[]; total: number } {
  if (loss.kind === "fixed") return { rolls: [], total: loss.amount };
  const rolls = Array.from({ length: loss.count }, () => Math.floor(random() * loss.sides) + 1);
  return { rolls, total: rolls.reduce((total, roll) => total + roll, 0) };
}

function finiteRewardNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid compiled reward ${field}`);
  return value;
}

function compiledDamagePermits(damage: CombatDamageSpec, value: number): boolean {
  if (!Number.isSafeInteger(value)) return false;
  return damage.kind === "fixed" ? value === damage.amount : value >= damage.count && value <= damage.count * damage.sides;
}

function compiledMaximumDamage(damage: CombatDamageSpec): number {
  return damage.kind === "fixed" ? damage.amount : damage.count * damage.sides;
}

function compiledDefenseRollPresenceIsValid(attackRoll: number, attackerSkill: number, defenseRoll: number | null): boolean {
  const level = cocSuccessLevelForRoll(attackRoll, attackerSkill);
  return (level === "fumble" || level === "fail") ? defenseRoll === null : defenseRoll !== null;
}

function replayCompiledCombatReceipt(
  settlement: CompiledCombatSettlement,
  definition: MechanicsIR["encounterDefinitions"][number],
  beforeState: MechanicsState,
  beforeSheet: JsonRecord,
  npcName: string,
): { player: ReturnType<RulesEngine["adjudicateAttack"]>; enemy?: ReturnType<RulesEngine["adjudicateAttack"]>; unitsConsumed: number } {
  const beforeEncounter = beforeState.encounters[definition.encounterId];
  if (!beforeEncounter || beforeEncounter.status !== "active") throw new Error("combat receipt has no active pre-action encounter");
  const actor = compiledCombatActor(beforeSheet);
  const fighting = compiledCombatSkill(beforeSheet, "fighting");
  const dodge = compiledCombatSkill(beforeSheet, "dodge");
  let index = 0;
  const random = () => {
    const unit = settlement.randomUnits[index++];
    if (typeof unit !== "number" || !Number.isFinite(unit) || unit < 0 || unit >= 1) throw new Error("combat receipt entropy is incomplete or invalid");
    return unit;
  };
  const rules = new RulesEngine();
  const enemy: WorldEntity = { id: definition.combatantId, name: npcName, type: "monster", hp: beforeEncounter.currentHp, maxHp: definition.maxHp, ac: 0, status: ["hostile"], position: beforeState.currentSceneId, scene_id: beforeState.currentSceneId };
  const player = rules.adjudicateAttack(
    { action: "attack", target: enemy.id },
    { name: actor.name, id: "p1", proficiency: 2, abilities: {}, hasSneakAttack: false },
    enemy,
    "cosmic-horror",
    undefined, undefined, undefined,
    fighting, definition.dodge, "1d1", undefined, "dodge", undefined, "0", { profile: "compiled-core", random },
  );
  if (player.hit && player.damage !== 1) throw new Error("replayed player attack escapes the compiled unarmed policy");
  if (player.hit && player.damage >= beforeEncounter.currentHp) {
    if (index !== settlement.randomUnits.length) throw new Error("combat receipt has unconsumed entropy after a killing attack");
    return { player, unitsConsumed: index };
  }
  const playerEntity: WorldEntity = { id: "p1", name: actor.name, type: "pc", hp: actor.hp, maxHp: actor.maxHp, ac: 0, status: [], position: beforeState.currentSceneId, scene_id: beforeState.currentSceneId, ...(actor.attributes ? { attributes: actor.attributes } : {}) };
  const counter = rules.adjudicateAttack(
    { action: "attack", target: playerEntity.id },
    { name: npcName, id: definition.combatantId, proficiency: 2, abilities: {}, hasSneakAttack: false },
    playerEntity,
    "cosmic-horror",
    undefined, undefined, undefined,
    definition.fight, dodge, compiledCombatDamageDice(definition.npcDamage), undefined, "dodge", undefined, "0", { profile: "compiled-core", random },
  );
  if (index !== settlement.randomUnits.length) throw new Error("combat receipt entropy is not consumed exactly once");
  return { player, enemy: counter, unitsConsumed: index };
}

/** Replay-side verifier for the persisted RulesEngine receipt; it never rolls. */
function validateCompiledCombatSettlement(
  value: unknown,
  action: { edge: MechanicsReachabilityEdge; state: MechanicsState; beforeState: MechanicsState },
  ir: MechanicsIR,
  projection: CompilerModuleDataProjection,
  beforeSheet: JsonRecord,
  generation: number,
): { sheet: JsonRecord } {
  const settlement = value as CompiledCombatSettlement;
  if (!settlement || typeof settlement !== "object" || action.edge.outcome !== "attack" || !action.edge.combat) throw new Error("combat settlement and attack edge must occur together");
  const definition = ir.encounterDefinitions.find((candidate) => candidate.encounterId === action.edge.combat!.encounterId);
  if (!definition || settlement.schemaVersion !== "1.0.0" || settlement.generation !== generation || settlement.mechanismId !== action.edge.mechanismId
    || settlement.encounterId !== definition.encounterId || canonicalJson(settlement.sourceInterpretationIds) !== canonicalJson([...definition.sourceInterpretationIds].sort())
    || settlement.beforeStateHash !== action.edge.beforeStateHash || settlement.afterStateHash !== action.edge.afterStateHash || canonicalJson(settlement.outcome) !== canonicalJson(action.edge.combat)) {
    throw new Error("combat settlement does not bind the source encounter or mechanics edge");
  }
  const fighting = compiledCombatSkill(beforeSheet, "fighting");
  const dodge = compiledCombatSkill(beforeSheet, "dodge");
  const npc = definition && projection.module.npcs.find((candidate) => candidate.id === definition.combatantId);
  if (!npc || npc.sceneId !== definition.sceneId) throw new Error("combat settlement lacks its trusted projection NPC");
  const replayed = replayCompiledCombatReceipt(settlement, definition, action.beforeState, beforeSheet, npc.name);
  const beforeHp = beforeSheet.hp;
  if (typeof beforeHp !== "number" || !Number.isSafeInteger(beforeHp) || beforeHp < 1 || settlement.actorHpBefore !== beforeHp
    || settlement.player.fighting !== fighting || settlement.player.targetDodge !== definition.dodge
    || settlement.player.roll !== replayed.player.cocRoll || settlement.player.defenseRoll !== (replayed.player.cocDefenseRoll ?? null)
    || settlement.player.hit !== action.edge.combat.hit || settlement.player.hit !== replayed.player.hit || settlement.player.damage !== action.edge.combat.damage || settlement.player.damage !== (replayed.player.hit ? replayed.player.damage : 0)
    || !compiledDefenseRollPresenceIsValid(settlement.player.roll, fighting, settlement.player.defenseRoll)
    || cocCombatRollHits(settlement.player.roll, fighting, definition.dodge, settlement.player.defenseRoll, "dodge") !== action.edge.combat.hit
    || (action.edge.combat.hit ? action.edge.combat.damage !== 1 : action.edge.combat.damage !== 0)) {
    throw new Error("combat settlement player result is not reproducible from its trusted inputs");
  }
  const playerKillsEnemy = action.state.encounters[definition.encounterId]?.status === "defeated";
  const expectedAfterHp = Math.max(0, beforeHp - action.edge.combat.actorDamage);
  if (settlement.actorHpAfter !== expectedAfterHp || action.edge.combat.actorDefeated !== (expectedAfterHp === 0)) throw new Error("combat settlement actor HP arithmetic is invalid");
  if (settlement.enemy === null) {
    if (!playerKillsEnemy || action.edge.combat.enemyHit || action.edge.combat.actorDamage !== 0 || action.edge.combat.actorDefeated) throw new Error("combat settlement omitted a required enemy response");
  } else {
    const enemy = settlement.enemy;
    if (playerKillsEnemy || enemy.fight !== definition.fight || enemy.targetDodge !== dodge || canonicalJson(enemy.damage) !== canonicalJson(definition.npcDamage)
      || !replayed.enemy || enemy.roll !== replayed.enemy.cocRoll || enemy.defenseRoll !== (replayed.enemy.cocDefenseRoll ?? null)
      || enemy.hit !== action.edge.combat.enemyHit || enemy.hit !== replayed.enemy.hit || enemy.damageDealt !== action.edge.combat.actorDamage || enemy.damageDealt !== (replayed.enemy.hit ? replayed.enemy.damage : 0)
      || !compiledDefenseRollPresenceIsValid(enemy.roll, definition.fight, enemy.defenseRoll)
      || cocCombatRollHits(enemy.roll, definition.fight, dodge, enemy.defenseRoll, "dodge") !== enemy.hit
      || (enemy.hit
        ? (cocSuccessLevelForRoll(enemy.roll, definition.fight) === "critical" || cocSuccessLevelForRoll(enemy.roll, definition.fight) === "extreme")
          ? enemy.damageDealt !== compiledMaximumDamage(definition.npcDamage)
          : !compiledDamagePermits(definition.npcDamage, enemy.damageDealt)
        : enemy.damageDealt !== 0)) {
      throw new Error("combat settlement enemy result is not reproducible from its trusted inputs");
    }
  }
  return { sheet: { ...cloneJson(beforeSheet), hp: expectedAfterHp } };
}

/** Recomputes the only accepted terminal-settlement chain from catalog + trace state. */
function replayTerminalRewardSettlements(
  ir: MechanicsIR,
  actionBeforeStateHash: string,
  previousRewardIds: readonly string[],
  nextRewardIds: readonly string[],
  priorSheet: JsonRecord,
  priorSanity: JsonRecord,
): { sheet: JsonRecord; sanity: JsonRecord; settlements: TerminalRewardSettlement[] } {
  const sheet = cloneJson(priorSheet);
  const sanity = cloneJson(priorSanity);
  const definitions = new Map(ir.rewards.map((reward) => [reward.id, reward]));
  if (definitions.size !== ir.rewards.length || nextRewardIds.some((id) => !definitions.has(id))) throw new Error("compiled reward state references a missing catalog definition");
  const initialMythos = finiteRewardNumber(sanity.cthulhuMythos, "Cthulhu Mythos", 0, 99);
  if (finiteRewardNumber(sheet.cthulhuMythos, "character Cthulhu Mythos", 0, 99) !== initialMythos) {
    throw new Error("compiled reward settlement found divergent initial Cthulhu Mythos state");
  }
  const initialMaxSan = finiteRewardNumber(sanity.maxSAN, "max SAN", 0, 100);
  if (initialMaxSan > 99 - initialMythos || finiteRewardNumber(sanity.currentSAN, "SAN", 0, initialMaxSan) > 99 - initialMythos) {
    throw new Error("compiled reward settlement found a SAN state above its Cthulhu Mythos cap");
  }
  const awardedRewardIds = nextRewardIds.filter((id) => !previousRewardIds.includes(id)).sort();
  const settlementsByRewardId = new Map<string, TerminalRewardSettlement>(awardedRewardIds.map((rewardId) => {
    const definition = definitions.get(rewardId)!;
    return [rewardId, { rewardId, sourceInterpretationIds: [...definition.sourceInterpretationIds].sort() }];
  }));
  // Settlement order is semantic, not evidence-ID order: all CM changes first
  // establish the terminal SAN cap, then all SAN recoveries use that cap.
  for (const rewardId of awardedRewardIds) {
    const definition = definitions.get(rewardId)!;
    const settlement = settlementsByRewardId.get(rewardId)!;
    if (definition.settlement.cthulhuMythos !== undefined) {
      const before = finiteRewardNumber(sanity.cthulhuMythos, "Cthulhu Mythos", 0, 99);
      const sheetBefore = finiteRewardNumber(sheet.cthulhuMythos, "character Cthulhu Mythos", 0, 99);
      if (sheetBefore !== before) throw new Error("compiled reward settlement found divergent Cthulhu Mythos state");
      // CoC CM is an equal maximum-SAN reduction.  The zero-SAN terminal case
      // is valid; a value beyond 99 is not.
      const after = before + definition.settlement.cthulhuMythos;
      if (after > 99) throw new Error("compiled reward Cthulhu Mythos exceeds the CoC maximum");
      const maxSanBefore = finiteRewardNumber(sanity.maxSAN, "max SAN", 0, 100);
      const currentSanBefore = finiteRewardNumber(sanity.currentSAN, "SAN", 0, maxSanBefore);
      const maxSanAfter = Math.min(maxSanBefore, 99 - after);
      const currentSanAfter = Math.min(currentSanBefore, maxSanAfter);
      sanity.cthulhuMythos = after;
      sheet.cthulhuMythos = after;
      sanity.maxSAN = maxSanAfter;
      sanity.currentSAN = currentSanAfter;
      settlement.cthulhuMythos = {
        delta: definition.settlement.cthulhuMythos,
        before,
        after,
        maxSanBefore,
        maxSanAfter,
        currentSanBefore,
        currentSanAfter,
      };
    }
  }
  for (const rewardId of awardedRewardIds) {
    const definition = definitions.get(rewardId)!;
    const settlement = settlementsByRewardId.get(rewardId)!;
    if (definition.settlement.san) {
      const san = definition.settlement.san;
      const rolls = san.kind === "dice" ? terminalRewardDice(ir.mechanicsHash, actionBeforeStateHash, rewardId, san.count, san.sides) : undefined;
      const total = san.kind === "fixed" ? san.amount : rolls!.reduce((sum, roll) => sum + roll, 0);
      const before = finiteRewardNumber(sanity.currentSAN, "SAN", 0, 100);
      const maxSAN = finiteRewardNumber(sanity.maxSAN, "max SAN", 0, 100);
      const after = Math.min(maxSAN, before + total);
      sanity.currentSAN = after;
      settlement.san = san.kind === "fixed"
        ? { kind: "fixed", total, before, after }
        : { kind: "dice", count: san.count, sides: san.sides, rolls, total, before, after };
    }
  }
  for (const rewardId of awardedRewardIds) {
    const definition = definitions.get(rewardId)!;
    const settlement = settlementsByRewardId.get(rewardId)!;
    if (definition.settlement.reputation !== undefined) {
      const before = finiteRewardNumber(sheet.creditRating, "credit rating", 0, 99);
      const after = Math.min(99, before + definition.settlement.reputation);
      sheet.creditRating = after;
      settlement.reputation = { delta: definition.settlement.reputation, before, after };
    }
  }
  const settlements = awardedRewardIds.map((rewardId) => settlementsByRewardId.get(rewardId)!);
  // Every generation keeps the two CM mirrors aligned, even if this action has no CM delta.
  if (finiteRewardNumber(sheet.cthulhuMythos, "character Cthulhu Mythos", 0, 99) !== finiteRewardNumber(sanity.cthulhuMythos, "Cthulhu Mythos", 0, 99)) {
    throw new Error("compiled reward settlement left divergent Cthulhu Mythos state");
  }
  if (finiteRewardNumber(sanity.maxSAN, "max SAN", 0, 100) > 99 - finiteRewardNumber(sanity.cthulhuMythos, "Cthulhu Mythos", 0, 99)
    || finiteRewardNumber(sanity.currentSAN, "SAN", 0, finiteRewardNumber(sanity.maxSAN, "max SAN", 0, 100)) > 99 - finiteRewardNumber(sanity.cthulhuMythos, "Cthulhu Mythos", 0, 99)) {
    throw new Error("compiled reward settlement left a SAN state above its Cthulhu Mythos cap");
  }
  return { sheet, sanity, settlements };
}

/** Replays actor effects selected by the shared executor; it never scans IR branches. */
function replaySanityCheckSettlements(
  sessionId: string,
  ir: MechanicsIR,
  beforeStateHash: string,
  generation: number,
  mechanismId: string,
  actorEffects: readonly SelectedActorEffect[],
  priorSanity: JsonRecord,
): { sanity: JsonRecord; settlements: SanityCheckSettlement[] } {
  const engine = new SanityEngine(50);
  engine.restoreState(cloneJson(priorSanity));
  const settlements: SanityCheckSettlement[] = [];
  for (const actorEffect of actorEffects) {
    if (actorEffect.effect.kind !== "sanity_check" || !["success", "failure", "failback", "traverse"].includes(actorEffect.outcome)) throw new Error("invalid selected actor SAN effect");
    if (actorEffect.sourceInterpretationIds.length === 0) throw new Error("actor SAN effect lacks source interpretation provenance");
    const connectionNode = actorEffect.provenance.eventSlot.kind === "connection"
      ? ir.connections.find((candidate) => candidate.id === mechanismId)
        : undefined;
    const discoveryNode = actorEffect.provenance.eventSlot.kind === "discovery"
      ? ir.discoveryMethods.find((candidate) => candidate.id === mechanismId)
      : undefined;
    const actorNode = connectionNode ?? discoveryNode;
    if (actorEffect.provenance.effectPath !== actorEffect.effectPath
      || actorEffect.provenance.eventSlot.outcome !== actorEffect.outcome
      || actorEffect.provenance.eventSlot.effectIndex !== actorEffect.effectIndex
      || !actorNode
      || (actorEffect.provenance.eventSlot.kind === "connection" && (actorEffect.outcome !== "traverse" || !connectionNode || connectionNode.connectionId !== actorEffect.provenance.eventSlot.connectionId))
      || (actorEffect.provenance.eventSlot.kind === "discovery" && (actorEffect.provenance.eventSlot.mechanismId !== mechanismId || actorEffect.outcome === "traverse"))
      || !actorNode.actorEffectProvenance?.some((candidate) => canonicalJson(candidate) === canonicalJson(actorEffect.provenance))) {
      throw new Error("actor SAN effect provenance does not match its selected event slot");
    }
    const random = compiledSanityRandom(sessionId, ir.mechanicsHash, beforeStateHash, generation, mechanismId, actorEffect.outcome, actorEffect.effectIndex);
    const before = sanityStateHash(engine.state as unknown as JsonRecord);
    const roll = Math.floor(random() * 100) + 1;
    const passed = roll <= engine.state.currentSAN;
    const selectedLoss = structuredClone(passed ? actorEffect.effect.passLoss : actorEffect.effect.failLoss);
    const rolledLoss = rollSanityLoss(selectedLoss, random);
    const beforeSAN = engine.state.currentSAN;
    const result = engine.applyLoss(rolledLoss.total, random);
    const after = sanityStateHash(engine.state as unknown as JsonRecord);
    settlements.push({
      actorId: "p1",
      mechanismId,
      outcome: actorEffect.outcome,
      effectIndex: actorEffect.effectIndex,
      effectPath: actorEffect.effectPath,
      provenance: structuredClone(actorEffect.provenance),
      sourceInterpretationIds: [...actorEffect.sourceInterpretationIds].sort(),
      declared: { passLoss: structuredClone(actorEffect.effect.passLoss), failLoss: structuredClone(actorEffect.effect.failLoss) },
      check: { roll, passed, selectedLoss, rolls: rolledLoss.rolls, total: rolledLoss.total, appliedLoss: beforeSAN - engine.state.currentSAN },
      madness: {
        temporaryInsanityTriggered: result.temporaryInsanityTriggered,
        indefiniteInsanityTriggered: result.indefiniteInsanityTriggered,
        indefiniteLevel: result.indefiniteLevel,
        boutDetail: result.boutDetail ? structuredClone(result.boutDetail) : null,
        newPhobias: [...(result.newPhobias ?? [])],
        newManias: [...(result.newManias ?? [])],
      },
      beforeSanityHash: before,
      afterSanityHash: after,
    });
  }
  return { sanity: cloneJson(engine.state as unknown as JsonRecord), settlements };
}

interface LoadedCompiledModule {
  payload: ResolvedCompilerArtifactPayload;
  projection: CompilerModuleDataProjection;
  state: MechanicsState;
  trace: MechanicsReachabilityEdge[];
  budget: MechanicsStateBudget;
  durableBundle?: Pick<LoadedBundleCatalogEntry, "id" | "bundleHash">;
  /** Retained only inside the durable host closure so prepared narration
   * candidates can reuse the canonical restore/replay validator before CAS. */
  catalogBundle?: LoadedBundleCatalogEntry;
  /** Catalog-hash-bound reference authorization; absent means no model injection. */
  worldModelBinding?: CompiledCthulhuWorldModelBinding;
  /** Host-derived owner binding; never contains the host credential or raw principal ID. */
  access: CompiledSessionAccessBinding | null;
  snapshotHash?: string;
  /** Immutable pre-reward baseline used to verify every durable settlement chain. */
  initialCharacter?: { pcId: "p1"; sheet: JsonRecord; sanity: JsonRecord };
  /** Durable receipts are the only persisted provenance; this is their folded runtime projection. */
  pendingSkillGrowth: string[];
}

export interface CompiledMechanicsSessionState {
  moduleId: string;
  artifactHash: string;
  mechanicsHash: string;
  state: MechanicsState;
  stateHash: string;
  trace: MechanicsReachabilityEdge[];
  terminalEnding?: { id: string; name: string; narration: string };
  generation: number;
}

export type CompiledAvailableActionCheck =
  | { kind: "skill"; skill: string; difficulty: "regular" | "hard" | "extreme" }
  | { kind: "attribute"; attribute: "str" | "dex" | "pow" | "con" | "app" | "edu" | "int" | "siz"; difficulty: "regular" | "hard" | "extreme" };

/** Player-safe, executable projection of one currently available compiled mechanism. */
export interface CompiledAvailableAction {
  mechanismId: string;
  kind: "discovery" | "traversal" | "combat";
  command: string;
  label: string;
  check?: CompiledAvailableActionCheck;
}

/**
 * Opaque correlation material for the durable compiled-intent replay ledger.
 * `requestKey` is the limited public `topicBound` token; the remaining scope,
 * catalog, integrity, and mechanism values stay host-only.
 */
export interface CompiledIntentReplayIdentity {
  sessionKey: string;
  expectedGeneration: number;
  scopeKey: string;
  requestKey: string;
  catalogKey: string;
  /** Host-only request-bound key used to MAC the durable result; never stored. */
  integrityKey: string;
  mechanismKeys: ReadonlyArray<Readonly<{ mechanismId: string; key: string }>>;
}

export const COMPILED_PLAYER_FACADE_SCHEMA_VERSION = "1.1.0";

/** The façade acknowledges that a roll is required without revealing its rule key. */
export interface CompiledPlayerFacadeCheck {
  kind: "check";
  difficulty: "regular" | "hard" | "extreme";
}

export interface CompiledPlayerFacadeAction {
  choiceId: string;
  label: string;
  check?: CompiledPlayerFacadeCheck;
}

/** Source-reviewed text staged from the current sealed mechanics state only. */
export interface CompiledPlayerFacadePresentation {
  scene: { name: string; description: string };
  clues: Array<{ name: string; revelation: string }>;
  /**
   * Current-scene contact labels released by the machine publication receipt.
   * These are presentation-only; they do not authorize an action or identify
   * an NPC to the browser.
   */
  contacts?: Array<{ name: string }>;
  /** Present only after this mechanics state selects a terminal ending. */
  ending?: { name: string; description: string };
}

/**
 * Host-only follow-up authority.  The public façade intentionally exposes
 * neither these identifiers nor the released source facts: the HTTP host
 * turns this exact tuple into a delivery-secret contact token.
 */
export interface CompiledPlayerFollowupContact {
  sessionId: string;
  bundleId: string;
  generation: number;
  sceneId: string;
  npcId: string;
  /** Sorted, host-only identity of every released dialogue clue for this NPC. */
  clueIds: readonly string[];
  name: string;
  /** Only this NPC's already-found, source-bound dialogue clue. */
  facts: readonly string[];
}

/** Deliberately narrow view for the assigned p1 player façade. */
export interface CompiledPlayerFacadeView {
  schemaVersion: typeof COMPILED_PLAYER_FACADE_SCHEMA_VERSION;
  generation: number;
  round: number;
  ruleset: "cosmic-horror";
  terminal: boolean;
  character: { name: string; hp: number; maxHp: number };
  sanity: { currentSAN: number; maxSAN: number; temporaryInsanity: boolean; indefiniteInsanity: boolean };
  actions: CompiledPlayerFacadeAction[];
  /** Omitted unless the catalog-validated bundle contains a trusted presentation review. */
  presentation?: CompiledPlayerFacadePresentation;
  /** Exact accepted provider prose for the latest narrated compiled turn. */
  turn?: { generation: number; text: string };
}

export type CompiledModuleLoadResult =
  | { status: "loaded"; compiled: CompiledMechanicsSessionState }
  | { status: "refused"; code: "COMPILED_ARTIFACT_INVALID" | "COMPILED_PROJECTION_INVALID" | "COMPILED_SESSION_CONFLICT"; message: string };

export interface ActionResponse {
  narrative: string;
  events: {
    speaker: string;
    content: string;
    type: MessageType;
    verbatim?: boolean;
    /**
     * 预制音频的文件名（不含扩展名）。只有可离线预合成的消息才有 ——
     * 前端凭它取 /voice/{voiceKey}.wav，取不到就静默跳过。
     */
    voiceKey?: string;
  }[];
  state: {
    scene: string;
    /** 当前场景的配乐标识（模组静态数据）。无映射时缺省，前端静默不放。 */
    bgm?: string;
    round: number;
    player: {
      name: string; hp: number; maxHp: number; ac: number; status: string[];
      /** Present only for a verifiable ordinary cosmic-horror active character. */
      luck?: number;
    };
    npcs: { name: string; hp: number; maxHp: number; status: string[]; attitude?: string }[];
    monsters: { name: string; hp: number; maxHp: number; status: string[] }[];
    companions: {
      id: string; name: string; hp: number; maxHp: number; ac: number;
      morale: number; behavior: string; control: string; position: string;
      inventory: string[]; motivation?: string;
      traits: CombatPersonalityTraits | null; skills: Record<string, number> | null;
      resolveState: string;
    }[];
    /**
     * 队伍列表（能在 POST /action 用 pcId 指定"以谁身份行动"的候选）。
     * 让"谁能行动"对客户端可见——此前 getState 只暴露 companions（NPC 队友），
     * 玩家自己（party 成员）无从得知有哪些 pcId 可选，路由能力拿到也用不上。
     * control 只读不写：本轮不加设置入口（那是 L4 接管/交还的事）。
     *
     * hp/maxHp/status/san/maxSan：实跑三个 PC 轮流行动 30 回合，party 里
     * 始终看不到任何人的状态——state.player 只反映当前 active PC，「谁受伤
     * 了」在多 PC 局里无从判断。hp/maxHp/status 取 world.getEntity(pcId)（与
     * `player` 单数字段同一份数据源，不另建一条真相）；san/maxSan 取
     * PartyMember.san（与 sanityEngines 同一引用）。
     */
    party: {
      pcId: string; name: string; control: "auto" | `player:${string}`;
      hp: number; maxHp: number; status: string[]; san: number; maxSan: number;
    }[];
    /**
     * 游戏内时间——与 getKPState():1257 同一口径（{day, period, label}），
     * 不新造一种表示。此前移动计时（弱版邻接+按跳数付时间）功能做了、
     * LLM 提示词里有、KP 视图里有，唯独玩家侧（这里）没有——而"移动要付
     * 时间"的全部意义就是玩家能感知到代价，见 docs/todo.json。
     */
    gameTime: { day: number; period: string; label: string };
    /** Compiled sessions expose source-exact item names derived from next MechanicsState. */
    inventory?: string[];
    sceneItems?: string[];
  };
  dead?: boolean;
  /** Ordinary sessions expose their terminal truth separately from death. */
  readonly terminal?: OrdinarySessionTerminal;
  sanity?: { currentSAN: number; maxSAN: number; temporaryInsanity: boolean; indefiniteInsanity: boolean; indefiniteLevel?: "mild" | "moderate" | "severe" | null; phobias: string[]; manias?: string[] };
  rolls?: { skill: string; roll: number; target: number; success: boolean }[];
  readonly dice?: ReadonlyArray<Readonly<{ expr: string; total: number; detail?: string; bonus?: number }>>;
  /** Source-bound terminal outcomes, persisted with the compiled action. */
  rewardSettlements?: TerminalRewardSettlement[];
  /** Required for every persisted compiled action; empty when no actor SAN check ran. */
  sanityCheckSettlements?: SanityCheckSettlement[];
  /** Required in persisted compiled response schema 1.4; omitted by ordinary actions. */
  skillGrowthReceipt?: CompiledSkillGrowthReceipt;
  /** Non-authoritative player prose, persisted separately from mechanics evidence. */
  playerNarration?: { schemaVersion: "1.0.0"; text: string };
  /** Present only for a compiled attack; binds RulesEngine rolls to the core edge. */
  combatSettlement?: CompiledCombatSettlement;
  /**
   * 结构化拒绝信号（本轮为「未知 pcId」的 action 路由加入）。取不到目标时
   * 置位，客户端/传输层据此返回结构化错误（参照 setPlayerSan 的
   * `{ code: "unknown_target", targetId }` 形状），**不**把它折成一条
   * 可读系统消息塞进 events 了事——那是「报告了一件没发生的事」。正常路径
   * 该字段恒 undefined，既有调用方无需感知。
   */
  error?: { code: string; targetId?: string; intentErrorCode?: string };
  /** Present only on the explicit compiled-module path. */
  compiled?: CompiledMechanicsSessionState;
}

/** Private canonical terminal state; public observations use OrdinarySessionTerminal. */
type OrdinarySessionTerminalState =
  | { kind: "death" }
  | { kind: "module_departure"; endingId: string; endingName: string }
  | { kind: "legacy_unknown" }
  | null;

export interface SessionSummary {
  id: string; round: number; ruleset: string; scene: string; playerName: string;
  archetype: string | null; messageCount: number; npcCount: number; createdAt: number;
  generation?: number;
}

interface PreparedCompiledAction {
  state: MechanicsState;
  trace: MechanicsReachabilityEdge[];
  budget: MechanicsStateBudget;
  round: number;
  lastActiveAt: number;
  messages: AgentMessage[];
  narrative: string;
  dice?: { expr: string; total: number; detail?: string; bonus?: number };
  roll?: { skill: string; roll: number; target: number; success: boolean };
  character: any;
  sanity: SanityEngine;
  rewardSettlements: TerminalRewardSettlement[];
  sanityCheckSettlements: SanityCheckSettlement[];
  combatSettlement?: CompiledCombatSettlement;
  skillGrowthReceipt: CompiledSkillGrowthReceipt;
}

/** Action-bound CoC growth entropy: a retry/restart cannot obtain a second roll. */
function compiledSkillGrowthRandom(sessionId: string, mechanicsHash: string, beforeStateHash: string, generation: number, mechanismId: string, skill: string): () => number {
  let draw = 0;
  return () => Number.parseInt(sha256(`compiled-skill-growth-v1|${sessionId}|${mechanicsHash}|${beforeStateHash}|${generation}|${mechanismId}|${skill}|${draw++}`).slice(0, 8), 16) / 0x1_0000_0000;
}

type CompiledActionSelection =
  | {
    mechanismId: string;
    outcome: "success" | "failure" | "failback" | "traverse";
    checkLine?: string;
    dice?: { expr: string; total: number; detail?: string };
    roll?: { skill: string; roll: number; target: number; success: boolean };
  }
  | {
    mechanismId: string;
    outcome: "attack";
    combat: MechanicsCombatOutcome;
    characterAfter: any;
    combatLedger: Omit<CompiledCombatSettlement, "generation" | "beforeStateHash" | "afterStateHash" | "outcome">;
  };

export type CompiledActionCommitResult =
  | { status: "committed" | "duplicate"; response: PersistedCompiledActionResponse; generation: number; snapshot?: CompiledSessionSnapshot }
  | { status: "refused"; code: string; generation: number };

/** The only two persisted compiled action semantics. A provider turn never
 * becomes a mechanics-only retry merely because host configuration changes. */
export type CompiledActionNarrationMode = "mechanics" | "provider";

/** Narrow, source-reviewed prose frame. It intentionally has no mechanics IDs,
 * dice, trace, raw command, hidden clue, or NPC-secret field. */
export interface CompiledNarrationPlayerFrame {
  presentation?: CompiledPlayerFacadePresentation;
  /** Source-reviewed four-digit module era, when the trusted projection has one. */
  era?: string;
  character: { name: string; hp: number; maxHp: number };
  sanity: { currentSAN: number; maxSAN: number };
}

/** Request-scoped only: this shape must never enter a frame, candidate,
 * snapshot, receipt, intent replay row, or browser retry record. */
export interface CompiledPlayerNarrationTopicRequest {
  choiceId: string;
  topicBound: string;
  playerInput: string;
}

export interface CompiledPlayerNarrationTopicBinding {
  topicTokenHash: string;
  topicBindingHash: string;
  playerRequestHash: string;
}

interface CompiledNarrationCandidateBase {
  sessionId: string;
  bundleId: string;
  actionId: string;
  expectedGeneration: number;
  nextGeneration: number;
  predecessorSnapshotHash: string;
  requestHash: string;
  /** Hash of the opaque public player request, never exposed to the model. */
  playerRequestHash: string;
  candidateHash: string;
  frame: {
    before: CompiledNarrationPlayerFrame;
    after: CompiledNarrationPlayerFrame;
    actionLabel: string;
    /** Scoped reference may shape prose only; it is never module fact evidence. */
    worldModel?: CompiledWorldModelPromptContext;
  };
  frameHash: string;
  /** Private canonical successor without provider prose. Never player-facing. */
  snapshot: CompiledSessionSnapshot;
}

/** Host-only exact candidate. Its snapshot retains the full mechanically
 * prepared successor so a crash never has to re-run random/time-bearing work. */
export type CompiledNarrationCandidate = (CompiledNarrationCandidateBase & {
  /** Legacy provider candidate; it has no player prose/topic authority. */
  schemaVersion: "1.0.0";
}) | (CompiledNarrationCandidateBase & {
  /** v2 stores only one-way hashes; original player prose is request-scoped. */
  schemaVersion: "2.0.0";
  topicTokenHash: string;
  topicBindingHash: string;
});

export type CompiledNarrationPreparation =
  | { status: "prepared"; candidate: CompiledNarrationCandidate }
  | { status: "duplicate"; response: PersistedCompiledActionResponse; generation: number }
  | { status: "refused"; code: string; generation: number };

function compiledActionRequestHash(
  input: string,
  actionId: string,
  expectedGeneration: number,
  narrationMode: CompiledActionNarrationMode,
): string {
  // A mechanical action's receipt contract predates narrated delivery and is
  // intentionally unchanged. Only the new provider path needs a distinct
  // mode-bound hash, so older mechanically valid durable chains remain
  // restore-compatible.
  if (narrationMode === "mechanics") return legacyCompiledActionRequestHash(input, actionId, expectedGeneration);
  return sha256(canonicalJson({
    domain: "compiled-action-v2",
    input,
    pcId: "p1",
    actionId,
    expectedGeneration,
    narrationMode,
  }));
}

function legacyCompiledActionRequestHash(input: string, actionId: string, expectedGeneration: number): string {
  return sha256(canonicalJson({ domain: "compiled-action-v1", input, pcId: "p1", actionId, expectedGeneration }));
}

function compiledNarrationCandidateHash(candidate: CompiledNarrationCandidate): string {
  const base = {
    sessionId: candidate.sessionId,
    bundleId: candidate.bundleId,
    actionId: candidate.actionId,
    expectedGeneration: candidate.expectedGeneration,
    nextGeneration: candidate.nextGeneration,
    predecessorSnapshotHash: candidate.predecessorSnapshotHash,
    requestHash: candidate.requestHash,
    playerRequestHash: candidate.playerRequestHash,
    frameHash: candidate.frameHash,
    snapshotHash: candidate.snapshot.snapshotHash,
  };
  return candidate.schemaVersion === "1.0.0"
    ? sha256(canonicalJson({ domain: "compiled-narration-candidate-v1", ...base }))
    : sha256(canonicalJson({
      domain: "compiled-narration-candidate-v2",
      ...base,
      topicTokenHash: candidate.topicTokenHash,
      topicBindingHash: candidate.topicBindingHash,
    }));
}

function validCompiledPlayerNarration(value: unknown): value is { schemaVersion: "1.0.0"; text: string } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2 && Object.hasOwn(value, "schemaVersion") && Object.hasOwn(value, "text")
    && (value as { schemaVersion?: unknown }).schemaVersion === "1.0.0"
    && typeof (value as { text?: unknown }).text === "string"
    && !!(value as { text: string }).text && (value as { text: string }).text.trim() === (value as { text: string }).text
    && Array.from((value as { text: string }).text).length <= 2_000;
}

/**
 * 复合句回问的待确认状态。触发回问时的原始输入与解析出的意图——回答的
 * 不是地点时，照它在原地执行，不卡住（见 resolveCompoundMoveReply）。
 */
interface PendingCompoundMove {
  originalInput: string;
  originalIntent: ActionIntent;
}

/**
 * 建一个 PC 需要同时诞生的八件事的登记项，供 #createPartyMember() 统一填。
 *
 * ⚠ 不是要取代 `characters`/`sanityEngines` 两张 Map——`sheet`/`san` 与那两张
 * Map 里存的是**同一个对象引用**，不是拷贝。`party` 是额外的第三张索引，
 * 补上前两张不管的东西（`control`），不是重新造一份角色状态的真相源。
 * 单一入口保证的是"建号时这八件事一次做齐"，不是"数据只能有一处"。
 */
/** Internal party index entry; its SAN engine remains session authority. */
interface PartyMember {
  pcId: string;
  /** 与 characters.get(pcId) 同一个对象引用 */
  sheet: any;
  /** 与 sanityEngines.get(pcId) 同一个对象引用 */
  san: SanityEngine;
  /** "auto" = AI 自主行动，"player:userId" = 指定玩家手操。字段原样搬自 CompanionState（types.ts:229）。 */
  control: "auto" | `player:${string}`;
  /**
   * PlayerAgent 的扮演字段（personality/backstory/currentGoal），经 resolvePlayerMeta
   * 的兜底链（HTTP→模组→backgroundProfile 推导→LLM）解析后落在这里。
   * 本轮只落值不消费——GameSession 尚未创建 PlayerAgent，是给 L2b 后续把
   * PlayerAgent 接进 web 会话时读的。
   */
  meta?: PlayerMeta;
  /**
   * 保留字段，本轮**不消费**——没有任何代码读它。按人数缩放难度是另一整轮
   * 的活（本轮明确排除），这里先把字段占位占出来，免得以后又是"字段在、
   * 没人接"的老毛病一次性发作。真要用时先写清楚谁读、怎么用再填值。
   */
  difficulty?: DifficultyProfile | null;
}

/**
 * Typed public projection returned by addPartyMember().  Its SAN field is an
 * observation-only facade rather than the party index's raw engine.  Slice C
 * makes the SAN map authority runtime-private as well.  `sheet` deliberately
 * is a detached recursively frozen snapshot.  Character authority remains
 * entirely behind GameSession's private canonical map.
 */
export type PartyMemberView = Readonly<{
  readonly pcId: string;
  /** Detached recursively frozen character-sheet observation. */
  readonly sheet: DeepReadonly<any>;
  readonly san: SanityReadFacade;
  readonly control: "auto" | `player:${string}`;
  readonly meta?: Readonly<PlayerMeta>;
}>;

/** A business refusal from the shared character-creation entry point. */
export type PartyMemberCreationRejection = {
  rejected: string;
  reason?: "duplicate_character_name";
};

/**
 * Narrow input accepted by the character-card mutation boundary. HP/maxHp are
 * valid for ordinary rulesets; skillValues/luck/creditRating/attributes are
 * CoC-only and rejected by non-cosmic-horror sessions.
 */
export type ActiveCharacterUpdate = Readonly<{
  hp?: number;
  maxHp?: number;
  skillValues?: Readonly<Record<string, number>>;
  luck?: number;
  creditRating?: number;
  attributes?: Readonly<Record<string, number>>;
}>;

/** No raw character object crosses the successful or refused mutation result. */
export type ActiveCharacterMutationResult =
  | Readonly<{ status: "updated"; character: DeepReadonly<any> }>
  | Readonly<{ status: "refused"; code: string }>;

const COC_EDITABLE_CHARACTER_ATTRIBUTES: ReadonlySet<string> = new Set(COC_ATTRIBUTES);
const COC_EDITABLE_CHARACTER_SKILLS = new Set(Object.values(SKILL_NAME_MAP));
const CHARACTER_UPDATE_KEYS = new Set([
  "hp", "maxHp", "skillValues", "luck", "creditRating", "attributes",
]);

function isOrdinaryDataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Materialize JSON-style patch records without invoking caller-owned getters.
 * The write boundary accepts only ordinary Object.prototype records with own,
 * enumerable string data descriptors. Null-prototype records and richer JS
 * objects are intentionally outside this HTTP-shaped contract.
 */
function materializeCharacterPatchRecord(
  value: unknown,
  allowedKeys?: ReadonlySet<string>,
): Record<string, unknown> | null {
  try {
    if (!isOrdinaryDataRecord(value)) return null;
    const materialized: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor"
        || (allowedKeys !== undefined && !allowedKeys.has(key))) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      Object.defineProperty(materialized, key, { value: descriptor.value, enumerable: true });
    }
    return materialized;
  } catch {
    // A Proxy may throw while reflecting descriptors. It is not a valid patch.
    return null;
  }
}

/** 队伍硬上限：超过直接拒绝，不放行。 */
export const PARTY_HARD_LIMIT = 10;

/**
 * 解析模组 meta.playerCount（"2~3"/"2-3"/"3" 这类字符串）成 {min,max}。
 * 解析不出来就返回 null——不强行猜一个范围出来，没有推荐人数就不警告，
 * 不是"猜错了也要给条警告"。
 */
export function parsePlayerCountRange(s: string | null | undefined): { min: number; max: number } | null {
  if (!s) return null;
  const range = s.match(/(\d+)\s*[~～\-至到]\s*(\d+)/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    return min <= max ? { min, max } : { min: max, max: min };
  }
  const single = s.match(/^\s*(\d+)\s*$/);
  if (single) {
    const n = Number(single[1]);
    return { min: n, max: n };
  }
  return null;
}

// ============================================================
// 辅助函数
// ============================================================

// 原先这里有个 `generateId()`（`sess_` + 时间戳 + 随机后缀），没有任何调用方 ——
// 会话 id 是构造时由外部传进来的。留着会让人以为 id 是这里生成的。

/** 技能英文键 → 中文显示名（成长消息、传承记录共用） */
const SKILL_DISPLAY_NAMES: Record<string, string> = {
  stealth: "潜行", perception: "侦查", investigation: "调查", persuasion: "说服",
  medicine: "医学", history: "历史", occult: "神秘", library_use: "图书馆使用",
  listen: "聆听", psychology: "心理学", library: "图书馆", fight: "格斗",
  // "idea" 不是 CoC 技能键，是 failback 阶梯（开发·线索闸门 任务4）里
  // 灵感检定用的合成 skillId——见 resolveSceneClue 的阶梯分支。
  idea: "灵感",
};

/**
 * intent 词汇 → CoC 技能键，仅用于中文显示名翻不过去的几个。
 *
 * 多数技能能靠"中文显示名"这座桥转换（SKILL_DISPLAY_NAMES 给中文，SKILL_NAME_MAP
 * 把中文翻成 CoC 键），下面两个不行：
 * - investigation：CoC 没有"调查"这个技能，搜索现场按规则书就是侦查。它还是
 *   handleSkillCheck 的默认技能，不映射的话最常走的那条路照旧落兜底值。
 * - fight：显示名"格斗"在 SKILL_NAME_MAP 里只有带武器类别的形式（"格斗(肉搏)"）。
 */
const COC_SKILL_ALIASES: Record<string, string> = {
  investigation: "spot_hidden",
  fight: "fighting",
};

const COMPILED_ATTRIBUTE_NAMES: Record<Extract<CheckSpec, { kind: "attribute" }> ["attribute"], string> = {
  str: "力量", dex: "敏捷", pow: "意志", con: "体质", app: "外貌", edu: "教育", int: "智力", siz: "体型",
};

/** Pure companion to evaluateCompiledCheck: restoration derives a target but never rolls. */
function compiledCheckDescriptor(check: Exclude<CheckSpec, { kind: "none" }>, character: any): { label: string; target: number } {
  const label = check.kind === "skill" ? check.skill : COMPILED_ATTRIBUTE_NAMES[check.attribute];
  if (check.kind !== "skill") return { label, target: resolveCheckValue(character ?? { attributes: {}, luck: 0, skillValues: {} }, label) };
  const values = character?.skillValues as Record<string, unknown> | undefined;
  const cocKey = COC_SKILL_ALIASES[check.skill] ?? SKILL_NAME_MAP[SKILL_DISPLAY_NAMES[check.skill] ?? check.skill];
  const value = values?.[check.skill] ?? (cocKey ? values?.[cocKey] : undefined);
  return { label, target: typeof value === "number" ? value : character?.skills?.[check.skill] ?? 50 };
}

interface SkillGrowthOutcome {
  skill: string;
  storageKey: string;
  display: string;
  roll: number;
  currentSkill: number;
  increased: boolean;
  increase: number;
  newValue: number;
}

function compiledCheckSucceeded(roll: number, target: number, difficulty: "regular" | "hard" | "extreme"): boolean {
  if (roll === 1) return true;
  if (roll === 100 || target < 50 && roll >= 96) return false;
  const rank = roll <= Math.floor(target / 5) ? 3 : roll <= Math.floor(target / 2) ? 2 : roll <= target ? 1 : 0;
  return rank >= (difficulty === "extreme" ? 3 : difficulty === "hard" ? 2 : 1);
}

/** 克苏鲁神话世界模型路径。共享 loader 按路径分桶，因此这里必须是同一个常量。 */
const CTHULHU_MODEL_PATH = DEFAULT_CTHULHU_PATH;

/**
 * Legacy model rows without a source novel are indexed under the loader's
 * synthetic "未知" bucket. That bucket is not an authorized work scope.
 */
function isExactLegacyWorldModelNovel(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && value !== "未知";
}

function hasExactLegacyWorldModelNovelBucket(
  loader: Pick<WorldModelLoader, "getByNovel">,
  novel: string,
): boolean {
  const entries = loader.getByNovel(novel);
  return entries.length > 0 && entries.every((entry) => entry.novel === novel);
}

/**
 * 剥掉字符串首尾的中英文标点（不动中间）。
 *
 * 自然语言输入抽 target 时经常带着标点尾巴——「附近店铺，」「维森酒吧。」——
 * `.trim()` 只管空白，标点会原样进 key，回显因此打出「这里没有「附近店铺，」」
 * 这种一眼看出是解析层没收干净的输出。
 */
const EDGE_PUNCTUATION = /^[，。！？；：、,.!?;:"'“”‘’()（）《》「」【】\s]+|[，。！？；：、,.!?;:"'“”‘’()（）《》「」【】\s]+$/g;
function stripEdgePunctuation(s: string): string {
  return s.replace(EDGE_PUNCTUATION, "");
}

/**
 * 按规则集建卡。
 *
 * cosmic-horror 走 CoC 7e 建卡器，其余仍走通用工厂。此前所有规则集都走通用工厂，
 * 而它只会写 D&D 六属性固定 10（缺 size/power/appearance/education）、按 D&D 公式
 * 算 HP、且从不填 skillValues——于是每个调查员都一模一样，职业和技能分配对判定
 * 毫无影响，技能检定只能落到各调用点自己的兜底常量。
 *
 * 点数与 play-module 的建卡保持一致（point_buy 480），避免两条路径给出不同强度的角色。
 */
function buildCharacterForRuleset(name: string, archetypeId: string, ruleset: string, randomUnit: RandomUnit): any {
  if (ruleset === "cosmic-horror") {
    const archetype = getArchetype(archetypeId);
    // 找不到职业时回落通用工厂，让原有的"未知职业"报错路径保持不变
    if (archetype) {
      return buildCoCCharacter(
        { name, archetypeId, method: "point_buy", pointBudget: 480 },
        archetype,
        randomUnit,
      );
    }
  }
  return CharacterFactory.generate(name, archetypeId, ruleset);
}

function readonlyActiveCharacterMutation(): never {
  throw new TypeError("activeCharacter is a read-only detached view");
}

/**
 * `Object.freeze` alone does not make Map/Set mutators throw. Character sheets
 * are portable data, but freeze their reachable object graph defensively so a
 * public view cannot leak a writable nested reference through an array, map,
 * set, or an own data descriptor.
 */
function freezeActiveCharacterPublicView<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);

  if (value instanceof Map) {
    for (const [key, entry] of value) {
      freezeActiveCharacterPublicView(key, seen);
      freezeActiveCharacterPublicView(entry, seen);
    }
    for (const method of ["set", "delete", "clear"] as const) {
      Object.defineProperty(value, method, { value: readonlyActiveCharacterMutation });
    }
  } else if (value instanceof Set) {
    for (const entry of value) freezeActiveCharacterPublicView(entry, seen);
    for (const method of ["add", "delete", "clear"] as const) {
      Object.defineProperty(value, method, { value: readonlyActiveCharacterMutation });
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) freezeActiveCharacterPublicView(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

/**
 * Narrow public observation surface; the mutable engine never crosses this
 * typed API boundary.  This Slice B type closure is not a claim that runtime
 * JavaScript `any` reflection has private-field semantics.
 */
export type SanityReadFacade = Readonly<{ readonly state: SanityState }>;

/**
 * Public investigation observation only.  The engine also owns package-local
 * definitions and executes discovery checks, so returning it would let a
 * caller mutate the same authority ordinary/compiled snapshots rely on.
 */
type InvestigationReadFacade = Readonly<{
  listClueTypes: () => readonly string[];
  hasClueType: (type: string) => boolean;
  getClueMatchInfo: (id: string) => Readonly<{ readonly matchTexts: readonly string[]; readonly displayName: string }> | null;
  isCoreClue: (id: string) => boolean;
  isLockedByUndiscoveredPrerequisite: (id: string, playerName: string) => boolean;
  listModuleClueIds: (opts?: { onlyWithMatchTexts?: boolean }) => readonly string[];
  isDiscoveredBy: (clueType: string, playerName: string) => boolean;
  getDiscoveredBy: (playerName: string) => readonly string[];
  getSceneClues: (sceneName: string) => readonly string[];
  getUndiscoveredSceneClues: (sceneName: string, playerName: string) => readonly string[];
}>;

type DeepReadonly<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/** Detach JSON-compatible public data before recursively freezing its graph. */
function detachedFrozenProjection<T>(value: T): DeepReadonly<T> {
  return freezeActiveCharacterPublicView(structuredClone(value)) as DeepReadonly<T>;
}

/**
 * Public observation of session-owned companions.  The concrete manager owns
 * lifecycle, commands, snapshots, and live CompanionState references; none of
 * those write capabilities may cross the GameSession boundary.
 */
type CompanionManagerReadFacade = Readonly<{
  getMorale: (id: string) => number;
  isActive: (id: string) => boolean;
  getActiveCompanions: () => DeepReadonly<ReturnType<CompanionManager["getActiveCompanions"]>>;
  findByEntityId: (entityId: string) => DeepReadonly<ReturnType<CompanionManager["findByEntityId"]>>;
  getControl: (id: string) => ReturnType<CompanionManager["getControl"]>;
  getPlayerControlled: (userId: string) => DeepReadonly<ReturnType<CompanionManager["getPlayerControlled"]>>;
  hasActed: (id: string) => boolean;
  listItems: (id: string) => readonly string[];
  hasItem: (id: string, itemName: string) => boolean;
  resolveWeapon: (id: string) => string | undefined;
  getCommandObeyState: (id: string) => DeepReadonly<ReturnType<CompanionManager["getCommandObeyState"]>>;
}>;

function detachedFrozenCompanionRead<T>(value: T): DeepReadonly<T> {
  return freezeActiveCharacterPublicView(structuredClone(value)) as DeepReadonly<T>;
}

/** One rule core for ordinary and compiled CoC improvement checks. */
function resolveCoCSkillGrowthStorageKey(skill: string, character: any): string {
  const hasStoredKey = (key: string): boolean => Object.hasOwn(character?.skillValues ?? {}, key) || Object.hasOwn(character?.skills ?? {}, key);
  if (hasStoredKey(skill)) return skill;
  const skillDisplay = SKILL_DISPLAY_NAMES[skill] ?? skill;
  const cocKey = COC_SKILL_ALIASES[skill] ?? SKILL_NAME_MAP[skillDisplay] ?? SKILL_NAME_MAP[skill];
  return cocKey && hasStoredKey(cocKey) ? cocKey : skill;
}

function isGrowableCoCSkill(character: any, storageKey: string): boolean {
  return Object.hasOwn(COC_SKILL_BASES, storageKey) && storageKey !== "credit_rating" && storageKey !== "cthulhu_mythos"
    && Object.hasOwn(character?.skillValues ?? {}, storageKey) && typeof character.skillValues[storageKey] === "number" && Number.isFinite(character.skillValues[storageKey]);
}

function applyCoCSkillGrowth(character: any, skill: string, random: () => number): SkillGrowthOutcome {
  const storageKey = resolveCoCSkillGrowthStorageKey(skill, character);
  const currentSkill = character?.skillValues?.[storageKey] ?? character?.skills?.[storageKey] ?? 50;
  const display = SKILL_DISPLAY_NAMES[skill] ?? skill;
  if (!isGrowableCoCSkill(character, storageKey)) return { skill, storageKey, display, roll: 0, currentSkill, increased: false, increase: 0, newValue: currentSkill };
  const roll = Math.floor(random() * 100) + 1;
  if (roll > currentSkill) {
    const increase = Math.floor(random() * 10) + 1;
    const newValue = Math.min(99, currentSkill + increase);
    character.skillValues[storageKey] = newValue;
    return { skill, storageKey, display, roll, currentSkill, increased: true, increase, newValue };
  }
  return { skill, storageKey, display, roll, currentSkill, increased: false, increase: 0, newValue: currentSkill };
}

/**
 * Read-only observation surface for the session-owned NPC persistence store.
 * The concrete store also owns SQLite handles and mutation/restore methods;
 * those must stay behind GameSession's canonical authority.
 */
type NPCStoreReadFacade = Readonly<{
  exportSnapshot: () => DeepReadonly<ReturnType<NPCStore["exportSnapshot"]>>;
  getAllPersonalities: () => DeepReadonly<ReturnType<NPCStore["getAllPersonalities"]>>;
  getPersonality: (id: string) => DeepReadonly<ReturnType<NPCStore["getPersonality"]>>;
  getRecentMemories: (npcId: string, limit?: number) => DeepReadonly<ReturnType<NPCStore["getRecentMemories"]>>;
  getImportantMemories: (npcId: string, minImportance?: number, limit?: number) => DeepReadonly<ReturnType<NPCStore["getImportantMemories"]>>;
  getSceneMemories: (npcId: string, sceneId: string, limit?: number) => DeepReadonly<ReturnType<NPCStore["getSceneMemories"]>>;
  searchMemories: (npcId: string, keyword: string, limit?: number) => DeepReadonly<ReturnType<NPCStore["searchMemories"]>>;
  countMemories: (npcId: string) => number;
  getRelationship: (npcId: string, targetName: string) => number;
  getAllRelationships: (npcId: string) => DeepReadonly<ReturnType<NPCStore["getAllRelationships"]>>;
  getState: (npcId: string) => DeepReadonly<ReturnType<NPCStore["getState"]>>;
}>;

function detachedFrozenNPCStoreRead<T>(value: T): DeepReadonly<T> {
  return freezeActiveCharacterPublicView(structuredClone(value)) as DeepReadonly<T>;
}

/**
 * Public career observation deliberately excludes every persistence mutator.
 * Its records are detached because the raw store owns durable career truth.
 */
export type CareerStoreReadFacade = Readonly<{
  getSnapshot: (characterName: string) => DeepReadonly<ReturnType<CareerFileStore["getSnapshot"]>>;
  listCharacters: () => DeepReadonly<ReturnType<CareerFileStore["listCharacters"]>>;
  exportPortableProjection: () => DeepReadonly<ReturnType<CareerFileStore["exportPortableProjection"]>>;
  getEntries: (characterName: string) => DeepReadonly<ReturnType<CareerFileStore["getEntries"]>>;
  loadCareer: (characterName: string) => DeepReadonly<ReturnType<CareerFileStore["loadCareer"]>>;
  listCareers: () => DeepReadonly<ReturnType<CareerFileStore["listCareers"]>>;
  exportToJson: (characterName: string) => ReturnType<CareerFileStore["exportToJson"]>;
}>;

function detachedFrozenCareerRead<T>(value: T): DeepReadonly<T> {
  return freezeActiveCharacterPublicView(structuredClone(value)) as DeepReadonly<T>;
}

/** A frozen outer result may share the loader's already deeply frozen entries. */
function frozenWorldModelEntries(entries: readonly V18Entry[]): readonly DeepReadonly<V18Entry>[] {
  return Object.freeze([...entries]) as readonly DeepReadonly<V18Entry>[];
}

function detachedFrozenWorldModelRead<T>(value: T): DeepReadonly<T> {
  return freezeActiveCharacterPublicView(structuredClone(value)) as DeepReadonly<T>;
}

/**
 * Public observation of a reference loader. Loading, causal consumption, and
 * implementation fields are authority, not session-facing read operations.
 */
type WorldModelLoaderReadFacade = Readonly<{
  isLoaded: () => boolean;
  getAll: () => readonly DeepReadonly<V18Entry>[];
  getByNovel: (novel: string) => readonly DeepReadonly<V18Entry>[];
  getByType: (type: string) => readonly DeepReadonly<V18Entry>[];
  getByNovelAndType: (novel: string, type: string) => readonly DeepReadonly<V18Entry>[];
  getNovelNames: () => readonly string[];
  getTypeNames: () => readonly string[];
  getDndRules: (novel?: string) => readonly DeepReadonly<V18Entry>[];
  getDndMappings: (novel?: string) => readonly DeepReadonly<V18Entry>[];
  getMechanics: (novel?: string) => readonly DeepReadonly<V18Entry>[];
  search: (...args: Parameters<WorldModelLoader["search"]>) => DeepReadonly<ReturnType<WorldModelLoader["search"]>>;
  getFactionRelations: () => readonly DeepReadonly<V18Entry>[];
  getBehaviors: () => readonly DeepReadonly<V18Entry>[];
  queryCausal: (contextKeywords: string[], maxResults?: number) => readonly DeepReadonly<V18Entry>[];
  queryBehavior: (contextKeywords: string[], maxResults?: number) => readonly DeepReadonly<V18Entry>[];
  randomCausal: (n?: number) => readonly DeepReadonly<V18Entry>[];
  getStats: () => DeepReadonly<ReturnType<WorldModelLoader["getStats"]>>;
  getNovelStats: (novel: string) => DeepReadonly<ReturnType<WorldModelLoader["getNovelStats"]>>;
}>;

/** The integrator is pure, but its compound results still need detached reads. */
type WorldModelIntegratorReadFacade = Readonly<{
  buildInjection: (ctx: SceneContext) => DeepReadonly<ReturnType<WorldModelIntegrator["buildInjection"]>>;
  buildKPContext: (ctx: SceneContext) => string;
  getNPCGuidance: (npcName: string, ctx: SceneContext) => string;
  getRuleHints: (ruleset: string, ctx: SceneContext) => readonly string[];
}>;

/**
 * Narrow public KP observation only.  KPAgent also owns narrative execution,
 * world-context injection, and directive/turn mutation, so the live agent
 * must remain behind GameSession's canonical authority.
 */
type KPReadFacade = Readonly<{
  getDirective: () => DeepReadonly<ReturnType<KPAgent["getDirective"]>>;
  getTurns: () => DeepReadonly<ReturnType<KPAgent["getTurns"]>>;
}>;

/**
 * Public observation of the session-owned politico-economic engine. Its
 * subsystem graph and advance/restore/action operations are authoritative
 * session writes, not a caller capability.
 */
type PoliticoEconomyReadFacade = Readonly<{
  readonly round: number;
  getState: () => DeepReadonly<ReturnType<PoliticoEconomyEngine["getState"]>>;
  getBriefState: () => DeepReadonly<ReturnType<PoliticoEconomyEngine["getBriefState"]>>;
  getEconomyVizData: () => DeepReadonly<ReturnType<PoliticoEconomyEngine["getEconomyVizData"]>>;
  getDiplomaticContext: () => string;
  renderEconomyHtml: () => string;
}>;

function detachedFrozenPoliticoEconomyRead<T>(value: T): DeepReadonly<T> {
  return freezeActiveCharacterPublicView(structuredClone(value)) as DeepReadonly<T>;
}

function detachedFrozenKPRead<T>(value: T): DeepReadonly<T> {
  return freezeActiveCharacterPublicView(structuredClone(value)) as DeepReadonly<T>;
}

/**
 * Legacy ordinary-session skill marks remain portable state, but callers must
 * not receive the mutable record that snapshot export and restore trust.
 */
function frozenSkillMarksRead(marks: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const view = Object.create(null) as Record<string, number>;
  for (const [skill, mark] of Object.entries(marks)) view[skill] = mark;
  return Object.freeze(view);
}

/**
 * The durable host must not dispatch a mutation through a public GameSession
 * method: compatibility methods can deliberately be shadowed by an instance
 * or its prototype.  This module-private capability is installed by the
 * constructor and has no public-property lookup in its write path.
 */
type OrdinaryHostAnnouncement = Readonly<{
  speaker: string;
  content: string;
  type: "system" | "narration";
  timestamp: number;
}>;
export type OrdinaryActionTransactionOperation<T> = (
  act: (input: string, actingPcId?: string, lifecycleRevision?: number) => Promise<ActionResponse>,
  /** Capability, not a public export API: valid only before this callback runs an action. */
  snapshotBeforeAction: () => OrdinaryGameSessionSnapshot,
  /** Opaque lease for the lifecycle captured at this FIFO boundary. */
  lifecycle: { isCurrent: () => boolean },
  /** Read-only content-identity guard for the captured source snapshot. */
  sourceState: { isPreActionSnapshotCurrent: () => boolean },
) => Promise<T>;

type OrdinaryDurableHostAuthority = Readonly<{
  capability: object;
  append: (speaker: string, content: string, type: "system" | "narration") => OrdinaryHostAnnouncement | null;
  acknowledge: (identity: OrdinarySessionDurableIdentity) => void;
  runExclusiveActionTransaction: <T>(operation: OrdinaryActionTransactionOperation<T>) => Promise<T>;
}>;
const ordinaryDurableHostAuthority = new WeakMap<GameSession, OrdinaryDurableHostAuthority>();

/**
 * Trusted durable work may derive a candidate from a source, so a call chain
 * can legitimately hold transactions for more than one GameSession. Each
 * token becomes inactive with its callback: detached descendants inherit the
 * old store but must not mistake a completed ancestor for active reentry.
 */
type OrdinaryDurableTransactionToken = { active: boolean };
const ordinaryDurableTransactionSessions = new AsyncLocalStorage<ReadonlyMap<GameSession, OrdinaryDurableTransactionToken>>();

/**
 * Compiled durability has the same ownership boundary as ordinary durability:
 * a session object is only an observation/execution surface.  Its durable
 * access material and publish transition are module-private closures selected
 * by the constructor-installed host capability, never a public instance slot.
 */
type CompiledDurableHostAuthority = Readonly<{
  capability: object;
  access: () => CompiledSessionAccessBinding | null;
  identity: () => CompiledSessionDurableIdentity | null;
  createSnapshot: () => CompiledSessionSnapshot;
  acknowledge: (snapshot: CompiledSessionSnapshot) => void;
  resolvePlayerChoice: (choiceId: string, expectedGeneration: number) => string | null;
  resolvePlayerFollowupContacts: () => readonly CompiledPlayerFollowupContact[];
  deriveIntentReplayIdentity: (
    input: string,
    expectedGeneration: number,
    catalog: readonly CompiledAvailableAction[],
  ) => CompiledIntentReplayIdentity;
  commit: (
    input: string,
    actionId: string,
    expectedGeneration: number,
    persist: (snapshot: CompiledSessionSnapshot) => void,
  ) => CompiledActionCommitResult;
  prepareNarration: (
    input: string,
    actionId: string,
    expectedGeneration: number,
    playerRequestHash?: string,
    playerTopic?: CompiledPlayerNarrationTopicRequest,
  ) => CompiledNarrationPreparation;
  /** Validate a fresh current-generation topic after intent replay selected the
   * exact mechanism. The HMAC key stays inside this authority. */
  bindNarrationTopic: (
    input: string,
    actionId: string,
    expectedGeneration: number,
    playerTopic: CompiledPlayerNarrationTopicRequest,
  ) => CompiledPlayerNarrationTopicBinding | null;
  /** Recheck supplied raw prose against a persisted v2 candidate scope without
   * reading an old catalog or exposing the stable HMAC key. */
  matchNarrationTopic: (
    candidate: CompiledNarrationCandidate,
    playerTopic: CompiledPlayerNarrationTopicRequest,
  ) => CompiledPlayerNarrationTopicBinding | null;
  /** Verify a persisted pre-dispatch candidate before any model prompt. */
  validateNarrationCandidate: (candidate: CompiledNarrationCandidate) => boolean;
  /** Validate model prose against the canonical candidate's private safety context. */
  validateNarrationText: (
    candidate: CompiledNarrationCandidate,
    narration: { schemaVersion: "1.0.0"; text: string },
  ) => boolean;
  /** Verify that an old v2 ledger receipt is anchored by the current snapshot
   * before the HTTP route may use it for token or raw-prose retry. */
  validateCommittedNarrationReceipt: (
    candidate: CompiledNarrationCandidate,
    narration: { schemaVersion: "1.0.0"; text: string },
  ) => boolean;
  commitNarration: (
    candidate: CompiledNarrationCandidate,
    narration: { schemaVersion: "1.0.0"; text: string },
    persist: (snapshot: CompiledSessionSnapshot) => void,
  ) => CompiledActionCommitResult;
}>;
const compiledDurableHostAuthority = new WeakMap<GameSession, CompiledDurableHostAuthority>();

/**
 * Stable policy failure for an ordinary object which already represents a
 * durable envelope. Such an object is observation-only until the durable host
 * derives, commits, and installs a replacement candidate.
 */
export class OrdinaryDurableMutationError extends Error {
  readonly code = "ordinary_durable_transaction_required";

  constructor() {
    super("ordinary_durable_transaction_required");
    this.name = "OrdinaryDurableMutationError";
  }
}

/** Stable failure for a trusted transaction trying to await its own FIFO. */
export class OrdinaryDurableTransactionReentryError extends Error {
  readonly code = "ordinary_durable_transaction_reentry";

  constructor() {
    super("ordinary_durable_transaction_reentry");
    this.name = "OrdinaryDurableTransactionReentryError";
  }
}

function normalizeOrdinaryHostAnnouncement(
  speaker: unknown,
  content: unknown,
  type: unknown,
): { speaker: string; content: string; type: "system" | "narration" } | null {
  if (typeof speaker !== "string" || speaker.trim() !== speaker || !speaker || Array.from(speaker).length > 128
    || typeof content !== "string" || content.trim() !== content || !content || Array.from(content).length > 8_000
    || (type !== "system" && type !== "narration")) return null;
  return { speaker, content, type };
}

type LegacyLoadCommand = Readonly<{ characterName: string | null }>;

/** Parse only the real legacy load command; its empty form remains handler-help. */
function parseLegacyLoad(input: string): LegacyLoadCommand | null {
  const command = "\u8bfb\u6863";
  const trimmed = input.trim();
  if (!trimmed.startsWith(command)) return null;
  const remainder = trimmed.slice(command.length);
  if (remainder !== "" && !/^\s/.test(remainder)) return null;
  const characterName = remainder.trim();
  return { characterName: characterName === "" ? null : characterName };
}

/** A named legacy load claims a state transition that ordinary sessions cannot perform. */
function isLegacyLoad(input: string): boolean {
  const command = parseLegacyLoad(input);
  return command !== null && command.characterName !== null;
}

/** `handleLegacy` persists exactly this legacy command form. */
function isLegacySaveCommand(input: string): boolean {
  return input.includes("\u4fdd\u5b58\u89d2\u8272");
}

type CharacterCreationCommand = Readonly<{ archetypeId: string; characterName: string }>;

/** Match the exact tokenization used by `handleCreateCharacter`. */
function parseCharacterCreation(input: string): CharacterCreationCommand | null {
  const command = "\u521b\u5efa\u89d2\u8272";
  const parts = input.replace(new RegExp(`^${command}\\s*`), "").trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return null;
  return { archetypeId: parts[0], characterName: parts.slice(1).join(" ") || "\u8c03\u67e5\u5458" };
}

/** A creation handler reaches `#createPartyMember` only for a known ruleset archetype. */
function isCareerWritingCharacterCreation(input: string, ruleset: string): boolean {
  const command = parseCharacterCreation(input);
  return command !== null && CharacterFactory.listArchetypes(ruleset).some((archetype) => archetype.id === command.archetypeId);
}

/** Public-safe ordinary opening text; never append provider diagnostics to it. */
export const ORDINARY_OPENING_FALLBACK = "夜幕降临，故事由此开始…";

/** HTTP observes this from the canonical string call; it never re-invokes opening generation. */
type OrdinaryOpeningSceneResult = Readonly<
  | { status: "ready"; opening: string }
  | { status: "fallback"; opening: string }
>;
type OrdinaryOpeningSceneObserver = (result: OrdinaryOpeningSceneResult) => void;

export class GameSession {
  /** Canonical session identity; public ID is an observation, never authority. */
  readonly #idRaw: string;
  get id(): string {
    return this.#idRaw;
  }

  /**
   * Keep the enumerable own-field shape used by session registries while
   * preventing same-name replacement from selecting a different namespace.
   */
  #installIdReadAccessor(): void {
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: false,
      get: () => this.#idRaw,
    });
  }

  /** Keep the server's durable-session observation from becoming an own-property authority. */
  #installDurableCompiledSessionReadAccessor(): void {
    Object.defineProperty(this, "isDurableCompiledSession", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: () => this.#isDurableCompiledSession(),
    });
  }
  /** Canonical session lifetime timestamps; public accessors are observations only. */
  #createdAtRaw = 0;
  #lastActiveAtRaw = 0;
  get createdAt(): number {
    return this.#createdAtRaw;
  }
  get lastActiveAt(): number {
    return this.#lastActiveAtRaw;
  }

  /**
   * Preserve enumerable own-field compatibility for server/session consumers,
   * while making the observed values non-configurable and non-writable.
   */
  #installTimestampReadAccessors(): void {
    Object.defineProperties(this, {
      createdAt: {
        enumerable: true,
        configurable: false,
        get: () => this.#createdAtRaw,
      },
      lastActiveAt: {
        enumerable: true,
        configurable: false,
        get: () => this.#lastActiveAtRaw,
      },
    });
  }

  /** Canonical session config is copied before any LLM client retains it. */
  readonly #configRaw: Readonly<LLMConfig>;
  // 无可用 API key 时装配 MockLLMClient，两者调用面一致但没有共同基类，
  // 因此字段类型必须是联合，而不是只写 LLMClient。
  /** Intent parsing is session-bound; CLI's global parser must not leak here. */
  readonly #intentLLM: NormalSessionIntentClient | null;
  /** HTTP factories inject required/development policy; direct callers retain compatibility. */
  readonly #intentPolicy: NormalSessionIntentPolicy;
  /** Per-session FIFO for direct actions and the server's full action transaction. */
  #actionTransactionTail: Promise<void> = Promise.resolve();
  /** Snapshot export is forbidden while an action callback can observe/mutate state. */
  #activeActionTransactions = 0;
  /** Read-only lifecycle signal for in-process eviction; the count itself remains private. */
  get hasActiveActionTransactions(): boolean {
    return this.#activeActionTransactions > 0;
  }
  /** Keep the server's lifecycle observation from becoming a shadowable authority. */
  #installActiveActionTransactionsReadAccessor(): void {
    Object.defineProperty(this, "hasActiveActionTransactions", {
      enumerable: false,
      configurable: false,
      get: () => this.#activeActionTransactions > 0,
    });
  }
  /** Narrow server-only escape hatch used to capture a predecessor inside its FIFO. */
  #ordinaryCommitSnapshotExport = false;
  /**
   * In-process only identity for successful semantic writes through the
   * supported synchronous GameSession facade.  It intentionally is neither
   * portable state nor a lifecycle generation: the source-state guard uses it
   * to see a facade ABA interval whose portable content was restored exactly.
   */
  #facadeMutationRevision = 0n;

  /**
   * Process-local identity for internal SAN-engine installs. The source-state
   * guard compares the current private raw reference and this revision for
   * internal replacement-and-restore ABA. Neither is portable state or part
   * of the persisted snapshot schema.
   */
  #sanityAssignmentRevision = 0n;

  #bumpFacadeMutationRevision(): void {
    this.#facadeMutationRevision++;
  }

  /**
   * Process-local write stamp for the public WorldStateManager child.
   * `total_changes()` belongs to this exact SQLite connection, is monotonic
   * across committed ABA writes, and is unaffected by the read itself. It is
   * deliberately not portable state or part of the persisted snapshot schema.
   */
  #worldSqliteMutationStamp(): string {
    const row = this.#worldRaw.getDatabase()
      .query("SELECT CAST(total_changes() AS TEXT) AS revision")
      .get() as { revision?: unknown } | null;
    if (typeof row?.revision !== "string" || !/^\d+$/.test(row.revision)) {
      throw new Error("world SQLite mutation stamp is unavailable");
    }
    return row.revision;
  }

  /** Same-connection NPC SQLite write stamp for ordinary source fencing. */
  #npcStoreSqliteMutationStamp(): string {
    const row = this.#npcStoreRaw.raw
      .query("SELECT CAST(total_changes() AS TEXT) AS revision")
      .get() as { revision?: unknown } | null;
    if (typeof row?.revision !== "string" || !/^\d+$/.test(row.revision)) {
      throw new Error("NPCStore SQLite mutation stamp is unavailable");
    }
    return row.revision;
  }
  /** Combat narration is bound to this session, never the CLI global narrator. */
  readonly #narrativeLLM: LLMClient | null;
  /** Session-private unified combat authority; no public RulesEngine capability is published. */
  readonly #rulesRaw: RulesEngine;
  /** Runtime-private canonical WorldStateManager authority. */
  readonly #worldRaw: WorldStateManager;
  /**
   * Stable, frozen compatibility surface over the live world authority.
   * It binds reviewed high-level methods but never exposes raw SQLite,
   * snapshot replacement, or lifecycle authority.
   */
  readonly #worldFacade: GameSessionWorldReadFacade;
  get world(): GameSessionWorldReadFacade {
    return this.#worldFacade;
  }
  /** A public observer must not replace or mask the session's world reads. */
  #installWorldReadAccessor(): void {
    Object.defineProperty(this, "world", {
      enumerable: false,
      configurable: false,
      get: () => this.#worldFacade,
    });
  }
  /** Execution-only creature metadata authority. It must not be replaceable by a session consumer. */
  readonly #npcCombatRaw: NPCCombatEngine;
  /** Stable frozen PlayerSession observation; no caller may replace the server's membership view. */
  readonly #sessionFacade: PlayerSessionReadFacade;
  get session(): PlayerSessionReadFacade {
    return this.#sessionFacade;
  }
  /** Preserve enumerable own-field compatibility without publishing a replaceable capability. */
  #installSessionReadAccessor(): void {
    Object.defineProperty(this, "session", {
      enumerable: true,
      configurable: false,
      get: () => this.#sessionFacade,
    });
  }
  /** Runtime-private authority; never expose PlayerSession's mutator surface. */
  readonly #playerSession: PlayerSession;
  /** Runtime-private investigation authority. Public callers only receive its read facade. */
  readonly #investigationRaw: InvestigationEngine;
  readonly #investigationFacade: InvestigationReadFacade = GameSession.investigationReadFacade(() => {
    this.#assertSessionReadable();
    return this.#investigationRaw;
  });
  /** Stable, frozen observation facade; it cannot install clues or execute checks. */
  get investigation(): InvestigationReadFacade {
    return this.#investigationFacade;
  }
  /** Runtime-private SAN authority; maps/party retain this same engine. */
  #sanityRaw: SanityEngine = new SanityEngine(50);
  readonly #sanityFacade: SanityReadFacade = GameSession.sanityReadFacade(() => {
    this.#assertSessionReadable();
    return this.#sanityRaw;
  });
  /** Public state-only observation facade with stable identity across actor switches. */
  get sanity(): SanityReadFacade {
    return this.#sanityFacade;
  }
  /** A public observer must not replace or mask the session's canonical SAN reads. */
  #installSanityReadAccessor(): void {
    Object.defineProperty(this, "sanity", {
      enumerable: false,
      configurable: false,
      get: () => this.#sanityFacade,
    });
  }
  #installSanityEngine(next: SanityEngine): void {
    if (next === this.#sanityRaw) return;
    this.#sanityRaw = next;
    this.#sanityAssignmentRevision++;
  }
  /** Runtime-private canonical NPC registry authority. */
  readonly #registryRaw: AgentRegistry;
  /** Stable frozen observation facade; it never exposes live NPCAgents or registry mutation. */
  readonly #registryFacade: AgentRegistryReadFacade = GameSession.registryReadFacade(() => {
    this.#assertSessionReadable();
    return this.#registryRaw;
  });
  get registry(): AgentRegistryReadFacade {
    return this.#registryFacade;
  }
  /** Runtime-private canonical NPC persistence authority. */
  readonly #npcStoreRaw: NPCStore;
  readonly #npcStoreFacade: NPCStoreReadFacade = GameSession.npcStoreReadFacade(() => {
    if (this.#npcStoreClosed) throw new Error("closed GameSession cannot read NPCStore");
    return this.#npcStoreRaw;
  });
  /** Stable frozen reader; it has no raw SQLite, close, restore, or write authority. */
  get npcStore(): NPCStoreReadFacade {
    return this.#npcStoreFacade;
  }
  /** Runtime-private canonical career persistence authority. It stays lazy for compatibility. */
  #careerStoreRaw: CareerFileStore | null = null;
  /** Created with the raw store and retained as a stable read-only observer. */
  #careerStoreFacade: CareerStoreReadFacade | null = null;
  /** Compatibility observation: a pre-character session still reports no career store. */
  get careerStore(): CareerStoreReadFacade | null {
    return this.#careerStoreFacade;
  }
  /** Runtime-private canonical KP authority. */
  readonly #kpRaw: KPAgent;
  /** Stable, frozen observation facade; it cannot narrate, inject context, or mutate KP state. */
  readonly #kpFacade: KPReadFacade = GameSession.kpReadFacade(() => {
    this.#assertSessionReadable();
    return this.#kpRaw;
  });
  get kp(): KPReadFacade {
    return this.#kpFacade;
  }
  /** Runtime-private v18 reference authority; loaders are shared immutable data by default. */
  readonly #worldModelRaw: WorldModelLoader;
  readonly #worldModelFacade: WorldModelLoaderReadFacade = GameSession.worldModelReadFacade(() => this.#worldModelRaw);
  /** Stable observation facade; it has no load, consumption, or loader-rebinding authority. */
  get worldModel(): WorldModelLoaderReadFacade {
    return this.#worldModelFacade;
  }
  /** Runtime-private integrator always paired with #worldModelRaw. */
  readonly #wmIntegratorRaw: WorldModelIntegrator;
  readonly #wmIntegratorFacade: WorldModelIntegratorReadFacade = GameSession.worldModelIntegratorReadFacade(() => this.#wmIntegratorRaw);
  /** Stable pure-output observation facade; it cannot rebind the loader. */
  get wmIntegrator(): WorldModelIntegratorReadFacade {
    return this.#wmIntegratorFacade;
  }
  /** Runtime-private aggregate Cthulhu reference authority. */
  readonly #cthulhuLoaderRaw: WorldModelLoader;
  readonly #cthulhuLoaderFacade: WorldModelLoaderReadFacade = GameSession.worldModelReadFacade(() => this.#cthulhuLoaderRaw);
  /** Stable observation facade for the separate aggregate model. */
  get cthulhuLoader(): WorldModelLoaderReadFacade {
    return this.#cthulhuLoaderFacade;
  }
  /** Runtime-private canonical companion authority. */
  readonly #companionManagerRaw: CompanionManager;
  /** Stable frozen observation facade; it cannot recruit, restore, command, or mutate companions. */
  readonly #companionManagerFacade: CompanionManagerReadFacade = GameSession.companionManagerReadFacade(() => {
    this.#assertSessionReadable();
    return this.#companionManagerRaw;
  });
  get companionManager(): CompanionManagerReadFacade {
    return this.#companionManagerFacade;
  }
  /** Runtime-private canonical politico-economic authority. */
  readonly #politicoEconomyRaw: PoliticoEconomyEngine;
  readonly #politicoEconomyFacade: PoliticoEconomyReadFacade = GameSession.politicoEconomyReadFacade(() => {
    this.#assertSessionReadable();
    return this.#politicoEconomyRaw;
  });
  /** Stable frozen reader; it exposes neither subsystem state nor write operations. */
  get politicoEconomy(): PoliticoEconomyReadFacade {
    return this.#politicoEconomyFacade;
  }

  /**
   * Session-private canonical ruleset selector. A public same-name own
   * property can shadow the compatibility getter, but it cannot choose rules
   * for summary, snapshots, character construction, or execution.
   */
  #activeRulesetRaw: RulesetId = "cosmic-horror";
  /** Backward-compatible observation only; there is deliberately no setter. */
  get activeRuleset(): RulesetId {
    return this.#activeRulesetRaw;
  }
  /**
   * Session-private canonical turn counter. A public same-name own property
   * can shadow the compatibility getter, but cannot select action, snapshot,
   * event, or module-host time.
   */
  #roundRaw = 0;
  /** Backward-compatible observation only; there is deliberately no setter. */
  get round(): number {
    this.#assertSessionReadable();
    return this.#roundRaw;
  }
  /** Runtime-private actor selector; public callers receive a read-only view. */
  #activePlayerId: string = "p1";
  get activePlayerId(): string {
    this.#assertSessionReadable();
    return this.#activePlayerId;
  }

  /**
   * Keep the legacy selector observable without allowing a same-name own
   * property to redirect snapshots, actor routing, or server defaults.
   */
  #installActivePlayerIdReadAccessor(): void {
    Object.defineProperty(this, "activePlayerId", {
      enumerable: false,
      configurable: false,
      get: () => {
        this.#assertSessionReadable();
        return this.#activePlayerId;
      },
    });
  }
  /**
   * The owner character editor has one sealed read projection.  Its body is
   * assembled from private canonical state below; sealing the instance slot
   * prevents a same-name compatibility property from redirecting an HTTP
   * authority read to caller supplied data.
   */
  #installOrdinaryCharacterEditorReadAccessor(): void {
    Object.defineProperty(this, "getOrdinaryCharacterEditorProjection", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: this.getOrdinaryCharacterEditorProjection.bind(this),
    });
  }
  /** Runtime-private character authority. Public reads are detached frozen views. */
  #activeCharacterRaw: any = null;

  /**
   * Public compatibility view only. Every read is a portable detached clone,
   * recursively frozen so no nested object, array, or descriptor path can
   * mutate the runtime character authority.
   */
  get activeCharacter(): any {
    this.#assertSessionReadable();
    return freezeActiveCharacterPublicView(structuredClone(this.#activeCharacterRaw));
  }

  /** Produce a detached public character observation without exposing a raw alias. */
  private characterPublicView(raw: any): DeepReadonly<any> {
    return freezeActiveCharacterPublicView(structuredClone(raw)) as DeepReadonly<any>;
  }

  /** Callers must supply the canonical characters-map/party sheet authority. */
  #installActiveCharacter(raw: any): void {
    this.#activeCharacterRaw = raw;
  }
  /**
   * Backward-compatible read-only death view.  Ordinary terminality belongs
   * exclusively to `ordinaryTerminal`; compiled loss belongs to its sealed
   * mechanics state and is mirrored here only for the legacy public view.
   *
   * Deliberately no setter: callers used to be able to fabricate a death (or
   * clear one) by assigning this public compatibility field.
   */
  get dead(): boolean {
    this.#assertSessionReadable();
    return this.#compiledModule
      ? !!this.#compiledModule.state.terminalLoss
      : this.#ordinaryTerminal?.kind === "death";
  }
  /** Non-compiled terminal truth. `dead` is a derived public compatibility view. */
  #ordinaryTerminal: OrdinarySessionTerminalState = null;
  /**
   * Session-private combat truth. A public same-name own property can shadow
   * the compatibility getter, but cannot choose combat suggestions, snapshot
   * state, counterattacks, or restore eligibility.
   */
  #combatActiveRaw = false;
  /** Backward-compatible observation only; there is deliberately no setter. */
  get combatActive(): boolean {
    this.#assertSessionReadable();
    return this.#combatActiveRaw;
  }
  /**
   * 两种"待确认"门，改回两个独立字段——不再是上一轮统一进的单个
   * `pendingConfirm` 联合类型。原因（跨 PC 泄漏，2026-08-30 实测
   * lcmj2joi）：单字段只记"有没有待确认"，不记"是谁提的"，导致 p1
   * 的复合句回问被 p2 完全无关的一句话答掉。上一轮把两种 pending 统一
   * 成一个字段是为了让"两个 pending 同时开互相打架"在结构上不可能——
   * 这个理由只在单 PC 模型下成立；多 PC 场景下，`compound-move` 与
   * `leave` 本来就是两种不同范围的决定（见各自字段的注释），会同时
   * 存在是正常状态，不是要避免的"打架"。
   */
  /**
   * 复合句回问——**认人**：只有触发它的那个 PC 的下一次输入才算回答。
   * key 是 pcId，值是触发时的原始输入与意图（回答不是地点时用来在
   * 原地执行，见 resolveCompoundMoveReply）。
   *
   * 用 Map 而不是单个 `{pcId, ...}` 字段：不同 PC 各自可能有一个尚未
   * 回答的回问——p1 问完还没答，p2 自己又触发一次，两者互不干扰、
   * 各自等自己的人回答，不会互相覆盖。
   *
   * ⚠ 已知且接受的缺口：如果触发回问的那个 PC 后续再也不行动了
   * （或者被移出队伍——本轮无删除入口，见 todo.json 建号相关记录），
   * 这条 Map 里的项会一直留着、系统消息会一直提醒"XX 还有问题没答"。
   * 没有做自动过期/超时清理——那是需要先决定"多久算过期"的另一个设计
   * 决定，本轮不做，如实记录风险而不是假装它不存在。
   */
  #pendingCompoundMove: Map<string, PendingCompoundMove> = new Map();
  /**
   * 离开确认——**不认人**，party 级的决定：谁确认/取消都算数。
   * 用一个 boolean 就够，因为语义上不需要记"是谁提的"——"要不要结束
   * 这次调查"影响的是整个队伍，不是某个 PC 自己的行动，任何一个 PC
   * 出面确认或取消都是队伍做出的决定，不存在"只有提问的那个人能回答"
   * 这回事（对照 compound-move：那是某个 PC 自己的动作要不要先移动，
   * 天然只该问那个 PC）。
   */
  #pendingLeaveConfirm = false;

  /** Runtime-private canonical player-character authority. */
  #characters: Map<string, any> = new Map();
  /**
   * SAN 引擎是带行为的对象（检定、疯狂判定），这里只作进程内缓存；
   * 其 state 的真相源是 WorldStateManager，落库点见 persistSanity()。
   * 背包 / 武器 / 护甲没有进程内副本，一律直读直写真相源。
   */
  #sanityEngines: Map<string, SanityEngine> = new Map();
  /**
   * 第三张索引，补 `characters`/`sanityEngines` 都不管的东西（`control`）。
   * 键与那两张 Map 共用 pcId；`sheet`/`san` 字段与它们里的对象是同一份引用。
   * 见 PartyMember 接口注释与 #createPartyMember()。
   */
  #party: Map<string, PartyMember> = new Map();
  /** Runtime-private physical placement authority; public observation is snapshot-only. */
  #sceneItems: Map<string, string[]> = new Map();
  #sceneDisplayNames: Record<string, string> = {};
  #sceneAliases: Record<string, string[]> = {};
  /**
   * 场景 → 配乐标识。模组静态数据，与显示名/别名同层，**不属于世界状态**，
   * 因此留在进程内而不进真相源：它不会被玩法改变，重载模组即可重建。
   */
  #sceneBgm: Record<string, string> = {};
  #registeredModules: LoadedModule[] = [];
  #lastNarrative: string = "";
  #lastDiceRoll: { expr: string; total: number; detail?: string; bonus?: number } | null = null;
  #lastRolls: Array<{skill: string; roll: number; target: number; success: boolean}> = [];
  #gameTime: GameTime = createGameTime();
#activeDifficulty: DifficultyProfile | null = null;
  // 原先有个 `monstersSeen: Set<string>`：从没被读也没被写。
  // CoC 里它该用来做「首次目击才掉 SAN」的去重，但这条路径上
  // **根本没有对怪物的 SAN 检定**（唯一的 sanityCheck 是玩家显式命令触发的），
  // 所以它是一个没建成的功能留下的空字段，不是漏接的去重表。
  readonly #storyGenerator: Pick<StoryGenerator, "generate">;
  /** Pending successful CoC skill marks, owned by the PC that made the check. */
  #skillGrowthMarksByPC: Map<string, string[]> = new Map();

  /** Read-only legacy active-PC observation; writes stay on the private owner map. */
  public get skillGrowthMarks(): readonly string[] {
    this.#assertSessionReadable();
    return Object.freeze([...(this.#skillGrowthMarksByPC.get(this.#activePlayerId) ?? [])]);
  }

  /** Prevent same-name own shadows from redirecting compatibility observations. */
  #installSkillGrowthMarksReadAccessor(): void {
    Object.defineProperty(this, "skillGrowthMarks", {
      enumerable: false,
      configurable: false,
      get: () => {
        this.#assertSessionReadable();
        return Object.freeze([...(this.#skillGrowthMarksByPC.get(this.#activePlayerId) ?? [])]);
      },
    });
  }

  private pendingSkillGrowthMarks(pcId: string): readonly string[] {
    return this.#skillGrowthMarksByPC.get(pcId) ?? [];
  }

  private markSkillGrowth(pcId: string, skill: string): void {
    const marks = this.#skillGrowthMarksByPC.get(pcId);
    if (marks) {
      if (!marks.includes(skill)) marks.push(skill);
      return;
    }
    this.#skillGrowthMarksByPC.set(pcId, [skill]);
  }

  private clearSkillGrowthMarks(pcId: string): void {
    this.#skillGrowthMarksByPC.delete(pcId);
  }

  private clearWoundTreatmentEligibility(pcId: string): void {
    this.#woundsTreatedByPC.delete(pcId);
  }

  /** Canonical legacy ordinary-session marks; never hand its mutable record to callers. */
  #skillMarksRaw: Record<string, number> = {};
  /** Rebuilt only when the canonical portable value is replaced. */
  #skillMarksView: Readonly<Record<string, number>> = frozenSkillMarksRead(this.#skillMarksRaw);
  get skillMarks(): Readonly<Record<string, number>> {
    this.#assertSessionReadable();
    return this.#skillMarksView;
  }

  private replaceSkillMarks(marks: Readonly<Record<string, number>>): void {
    this.#skillMarksRaw = structuredClone(marks);
    this.#skillMarksView = frozenSkillMarksRead(this.#skillMarksRaw);
  }

  /** Successful, effective first aid grants one rest recovery to its owning PC only. */
  #woundsTreatedByPC: Set<string> = new Set();
  #moduleStartByPC: Map<string, { san: number; cm: number }> = new Map();
  /** Legacy snapshot compatibility: historically settled growth awaiting career persistence; new rests never write it, while module settlement still consumes preserved legacy values. */
  #growthChangesByPC: Map<string, string[]> = new Map();
  #mythosSpells: Map<string, { sanCost: string; mpCost: number; description: string; effect?: string }> = new Map();
  /**
   * Session-private, package-derived tome authority.  sceneItems only says a
   * name is physically placed; it cannot define a tome or authorize its
   * effects without this copied source declaration.
   */
  #moduleTomes: Map<string, Readonly<RuntimeModuleTome>> = new Map();
  /** Package-declared pickup provenance; sceneItems alone never grants ownership. */
  #modulePickupOrigins: Map<string, Readonly<RuntimePickupOrigin>> = new Map();
  #moduleItemDescriptions: Map<string, string> = new Map();
  #moduleKpNotes: Map<string, string> = new Map();
  #moduleRewards: Map<string, RuntimeModuleReward> = new Map();
  #knownMythosSpells: string[] = [];
  #lastPushedRoll: { skill: string; roll: number; target: number } | null = null;
  /**
   * Ephemeral snapshot, not a second status store: act() ticks status[] before
   * dispatch, while a duration=1 action penalty must still affect its final
   * eligible action. It is replaced at the start of every player action.
   */
  #actingStatusesBeforeTick: readonly string[] | undefined;
  #moduleLoader?: MythosModuleLoader;
  #moduleDataLoader?: ModuleDataRuntimeLoader;
  #loadedModules: Map<string, boolean> = new Map();
  /** One per session; MechanicsState is authoritative and WorldStateManager is its mirror. */
  #compiledModule?: LoadedCompiledModule;
  /** Ephemeral operator-facing provenance for the latest compiled model prompt. */
  #compiledWorldModelPromptReceipt: Omit<CompiledWorldModelPromptContext, "text"> | null = null;
  #compiledGeneration: number | null = null;
  #compiledIdempotency = new Map<string, CompiledSessionIdempotencyRecord>();
  /** A persisted durable generation must never be served from the old in-memory object. */
  #compiledFailStopped = false;
  #installingCompiledState = false;
  /**
   * 建会话时 HTTP 传的 p1 扮演字段（personality/backstory/currentGoal）。
   *
   * 没传 archetypeId 时 p1 建的是空壳槽位，真正的角色卡要等"创建角色"命令
   * 才诞生（见该命令处理函数）——这份字段那时候才用得上，所以先存住，不能
   * 在构造函数里因为走了空壳分支就把它默默丢掉（HTTP 给的值消失且没有任何
   * 报错，调用方毫无察觉）。
   */
  #p1Persona?: PlayerMeta;
  readonly #careerRoot?: string;
  /** Ordinary HTTP sessions retain the same durable owner binding in memory. */
  #ordinarySessionAccess: OrdinarySessionAccessBinding | null = null;
  /** Set by the HTTP persistence boundary after publish or durable restore. */
  #ordinaryDurableIdentity: OrdinarySessionDurableIdentity | null = null;
  /** Only the WeakMap host transaction may enter a Career-writing action scope. */
  #ordinaryDurableActionDepth = 0;
  readonly #compiledCombatRandom?: () => number;
  readonly #characterRandomUnit: RandomUnit;
  /** Trusted runtime-only ordinary-session scope; absent deliberately disables legacy model injection. */
  readonly #worldModelNovel?: string;
  /** Only the trusted host may choose whether verified departure entries are durable. */
  readonly #careerEntryPersistence: "durable" | "transient";
  /** Only the private NPC store created by this GameSession can be snapshotted or closed here. */
  #hasSessionOwnedNpcStore: boolean;
  #npcStoreClosed = false;
  /**
   * Every first close invalidates actions already waiting on an async provider.
   * The direct-action FIFO serializes actions, but it intentionally does not
   * make close wait for an arbitrary model request: closing must release this
   * session's authorities immediately.  A direct action captures this epoch at
   * its FIFO boundary and verifies it again before acknowledging success.
   */
  #lifecycleRevision = 0;
  /**
   * Direct/CLI actions do not have the HTTP candidate-and-CAS commit boundary.
   * Once such an action throws, partial in-memory effects cannot safely be
   * rolled back across arbitrary awaited integrations. Crash-stop this object
   * instead of letting the caller keep using a half-applied session.
   */
  #directActionFailStopped = false;

  constructor(
    id: string,
    ruleset: RulesetId = "cosmic-horror",
    llmConfig?: LLMConfig,
    archetypeId?: string,
    characterName?: string,
    persona?: PlayerMeta,
    storage?: { careerRoot?: string },
    ordinarySessionAccess?: OrdinarySessionAccessBinding,
    intentPolicy: NormalSessionIntentPolicy = "preferred",
    runtimeDependencies: GameSessionRuntimeDependencies = {},
  ) {
    this.#idRaw = id;
    this.#installIdReadAccessor();
    this.#createdAtRaw = Date.now();
    this.#lastActiveAtRaw = Date.now();
    this.#installTimestampReadAccessors();
    this.#installActivePlayerIdReadAccessor();
    this.#installOrdinaryCharacterEditorReadAccessor();
    this.#installSkillGrowthMarksReadAccessor();
    this.#installActiveActionTransactionsReadAccessor();
    this.#installDurableCompiledSessionReadAccessor();
    this.#installSanityReadAccessor();
    this.#activeRulesetRaw = ruleset;
    this.#p1Persona = persona ? structuredClone(persona) : undefined;
    this.#careerRoot = storage?.careerRoot;
    this.#intentPolicy = intentPolicy;
    this.#compiledCombatRandom = runtimeDependencies.compiledCombatRandom;
    const ordinaryDurableHostCapability = runtimeDependencies.ordinaryDurableHostCapability;
    const compiledDurableHostCapability = runtimeDependencies.compiledDurableHostCapability;
    if (ordinaryDurableHostCapability !== undefined
      && (ordinaryDurableHostCapability === null || typeof ordinaryDurableHostCapability !== "object")) {
      throw new Error("ordinary durable host capability is invalid");
    }
    if (compiledDurableHostCapability !== undefined
      && (compiledDurableHostCapability === null || typeof compiledDurableHostCapability !== "object")) {
      throw new Error("compiled durable host capability is invalid");
    }
    this.#characterRandomUnit = createCharacterEntropy(runtimeDependencies.characterRandomUnit);
    this.#worldModelNovel = isExactLegacyWorldModelNovel(runtimeDependencies.worldModelNovel)
      ? runtimeDependencies.worldModelNovel
      : undefined;
    if (runtimeDependencies.careerEntryPersistence !== undefined
      && runtimeDependencies.careerEntryPersistence !== "durable"
      && runtimeDependencies.careerEntryPersistence !== "transient") {
      throw new Error("careerEntryPersistence must be durable or transient");
    }
    this.#careerEntryPersistence = runtimeDependencies.careerEntryPersistence ?? "durable";
    // An omitted store is deliberately per-session rather than the historic
    // process-wide `data/npc.db`. Any injection remains caller-owned: sharing
    // must not silently transfer its lifetime to the first session that closes.
    this.#hasSessionOwnedNpcStore = runtimeDependencies.npcStore === undefined;
    this.#storyGenerator = runtimeDependencies.storyGenerator ?? new StoryGenerator();
    this.#ordinarySessionAccess = isOrdinarySessionAccessBinding(ordinarySessionAccess)
      ? structuredClone(ordinarySessionAccess)
      : null;

    const inputConfig = llmConfig ?? loadConfig();
    const config: LLMConfig = {
      apiKey: inputConfig.apiKey,
      baseUrl: inputConfig.baseUrl,
      model: inputConfig.model,
      maxTokens: inputConfig.maxTokens,
      temperature: inputConfig.temperature,
    };
    Object.freeze(config);
    this.#configRaw = config;

    const apiKey = this.#configRaw.apiKey;
    // This session-level client is shared by KP and registered NPC agents.
    // An explicit offline override must therefore choose Mock here, before
    // either agent receives a provider-capable client.
    const runtimeLlmDisabled = llmDisabledByOverride();
    const llm: LLMLike = isUsableLlmApiKey(apiKey) && !runtimeLlmDisabled
      ? new LLMClient(this.#configRaw)
      : new MockLLMClient();

    // Intent parsing belongs to the session: neither another GameSession nor
    // the CLI's module singleton may select this request's API key or endpoint.
    // A supplied valid config is sufficient; only an explicit offline override
    // may disable it. Environment key presence is not a second credential gate.
    this.#intentLLM = runtimeDependencies.sessionIntentClient
      ?? (llm instanceof LLMClient && !runtimeLlmDisabled ? llm : null);
    this.#narrativeLLM = llm instanceof LLMClient && llmEnabled() ? llm : null;
    declareIntentPath(this.#intentLLM);
    // 战斗叙述同理：`llm/narrator.ts` 的 `_narratorLLM` 也是模块级单例，
    // 原先只有 CLI 会设（`index.ts:55`），网页端战斗只印
    // 「造成 N 点伤害」，没有画面。守卫逻辑与上面 intent 那份一致。
    // 玩家 Agent 的决策 LLM 同理（decideViaLLM）：原先直接在 player-agent 里裸
    // fetch、绕开 llmEnabled()。走 LLMClient 后这里只在还没设过时设一次。

    this.#rulesRaw = new RulesEngine();
    this.#worldRaw = new WorldStateManager(`:memory:`);
    this.#worldFacade = createGameSessionWorldReadFacade(() => this.#resolveWorldReadFacade());
    this.#installWorldReadAccessor();
    // 权威场景来源闭包过 #worldRaw——PlayerSession 自己不再存一份会
    // 漂移的场景拷贝（开发·多人可见性 N6，todo-24），见该类构造函数注释。
    const playerSession = new PlayerSession((characterId) => this.#worldRaw.getCurrentState().entities[characterId]?.position);
    this.#playerSession = playerSession;
    if (ordinaryDurableHostCapability !== undefined) {
      ordinaryDurableHostAuthority.set(this, {
        capability: ordinaryDurableHostCapability,
        append: (speaker, content, type) => {
          this.#assertOrdinaryDurableMutationAllowed();
          if (this.#compiledMutationBlocked()) return null;
          this.#addMessageCanonical(speaker, content, type);
          const message = this.#playerSession.getRecentGlobal(1)[0];
          const timestamp = message?.timestamp;
          if (!message || message.speaker !== speaker || message.content !== content || message.type !== type
            || typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) {
            throw new Error("canonical ordinary host announcement was not installed");
          }
          return Object.freeze({ speaker: message.speaker, content: message.content, type, timestamp });
        },
        acknowledge: (identity) => this.#acknowledgeOrdinaryDurableIdentityCanonical(identity),
        runExclusiveActionTransaction: <T>(operation: OrdinaryActionTransactionOperation<T>) =>
          this.#runOrdinaryDurableActionTransactionCanonical(operation),
      });
    }
    if (compiledDurableHostCapability !== undefined) {
      compiledDurableHostAuthority.set(this, {
        capability: compiledDurableHostCapability,
        access: () => this.#compiledSessionAccessBindingCanonical(),
        identity: () => {
          const compiled = this.#compiledModule;
          if (!compiled?.durableBundle || this.#compiledGeneration === null || !compiled.snapshotHash) return null;
          return Object.freeze({
            sessionId: this.#idRaw,
            bundleId: compiled.durableBundle.id,
            generation: this.#compiledGeneration,
            snapshotHash: compiled.snapshotHash,
          });
        },
        createSnapshot: () => this.#createCompiledSessionSnapshotCanonical(),
        acknowledge: (snapshot) => this.#acknowledgeCompiledSnapshotCanonical(snapshot),
        resolvePlayerChoice: (choiceId, expectedGeneration) =>
          this.#resolveCompiledPlayerFacadeActionInputCanonical(choiceId, expectedGeneration),
        resolvePlayerFollowupContacts: () => this.#compiledPlayerFollowupContactsCanonical(),
        deriveIntentReplayIdentity: (input, expectedGeneration, catalog) =>
          this.#deriveCompiledIntentReplayIdentityCanonical(input, expectedGeneration, catalog),
        commit: (input, actionId, expectedGeneration, persist) =>
          this.#commitCompiledActionCanonical(input, actionId, expectedGeneration, persist),
        prepareNarration: (input, actionId, expectedGeneration, playerRequestHash, playerTopic) =>
          this.#prepareCompiledNarrationCanonical(input, actionId, expectedGeneration, playerRequestHash, playerTopic),
        bindNarrationTopic: (input, actionId, expectedGeneration, playerTopic) =>
          this.#bindCompiledNarrationTopicCanonical(input, actionId, expectedGeneration, playerTopic),
        matchNarrationTopic: (candidate, playerTopic) => this.#matchCompiledNarrationTopicCanonical(candidate, playerTopic),
        validateNarrationCandidate: (candidate) => this.#validateCompiledNarrationCandidateCanonical(candidate),
        validateNarrationText: (candidate, narration) => this.#validateCompiledNarrationTextCanonical(candidate, narration),
        validateCommittedNarrationReceipt: (candidate, narration) => {
          const prior = this.#compiledIdempotency.get(candidate.actionId);
          return !!prior && this.#matchesCommittedNarrationReceiptCanonical(candidate, narration, prior);
        },
        commitNarration: (candidate, narration, persist) =>
          this.#commitCompiledNarrationCanonical(candidate, narration, persist),
      });
    }
    this.#sessionFacade = GameSession.playerSessionReadFacade(() => {
      this.#assertSessionReadable();
      return playerSession;
    });
    this.#installSessionReadAccessor();
    this.#npcCombatRaw = new NPCCombatEngine();
    this.#companionManagerRaw = new CompanionManager();
    this.#politicoEconomyRaw = new PoliticoEconomyEngine();
    // 挂 #worldRaw：线索发现从此写真相源，不是引擎自己的进程内 Map——
    // 见 InvestigationEngine 构造函数与 markDiscovered 的注释。
    this.#investigationRaw = new InvestigationEngine(undefined, this.#worldRaw);
    this.#npcStoreRaw = runtimeDependencies.npcStore ?? new NPCStore(":memory:");
    this.#registryRaw = new AgentRegistry(llm, this.#npcStoreRaw);
    this.#kpRaw = new KPAgent({ scene_description: "", scene_elements: [], current_phase: "exploration", style: "standard", plot_nodes: [] }, llm);
    // 进程内共享：这两份是只读参考数据，不是会话状态。每会话各建一个会让
    // 383688 条的 v18 主库按会话数重复加载与驻留（实测 3 会话 = 3 次加载 / 1938MB）。
    this.#worldModelRaw = runtimeDependencies.worldModelLoader ?? sharedWorldModel();
    this.#wmIntegratorRaw = new WorldModelIntegrator(this.#worldModelRaw);
    this.#cthulhuLoaderRaw = runtimeDependencies.cthulhuWorldModelLoader ?? sharedWorldModel(CTHULHU_MODEL_PATH);
    // 世界模型懒加载：不在此处 load()（v18_all_master.jsonl ~240MB，会拖慢所有 GameSession 实例化，
    // 测试与无模型场景均受影响）。首次需要注入时才在 injectWorldModelForScene() 里加载。

    // CoC 7e 的初始 SAN 等于 POW。SanityEngine 的构造参数本来就叫 pow，会话却一直
    // 传死值 50——接上 CoC 建卡后角色卡上终于有了真的 POW，理智值却仍与它无关。
    // 建卡得排在建 SAN 之前，所以先建出来，下面的初始化块直接用这一份。
    let initialCharacter: any = null;
    if (archetypeId) {
      try {
        initialCharacter = buildCharacterForRuleset(
          characterName ?? "调查员",
          archetypeId,
          ruleset,
          this.#characterRandomUnit,
        );
      } catch (e) {
        this.#cleanupFailedConstruction();
        throw e;
      }
    }

    if (initialCharacter) {
      // 有初始角色：走统一入口，八件事一次做齐（见 #createPartyMember 注释）。
      try {
        const result = this.#createPartyMember("p1", initialCharacter);
        if ("rejected" in result) {
          // 理论上不会发生：party 从空 Map 开始，人数检查不可能在这里触发。
          log.warn("session", `建号被拒绝（不该发生，party 应为空）：${result.rejected}`);
          this.#installSanityEngine(new SanityEngine(initialCharacter?.attributes?.power ?? 50));
          this.#sanityEngines.set("p1", this.#sanityRaw);
        } else {
          this.#installActiveCharacter(result.member.sheet);
          this.#installSanityEngine(result.member.san);
          // p1 的扮演元数据：HTTP 给的字段（优先）→ backgroundProfile 推导。
          // 见 resolveMeta 方法注释——三处建卡入口（这里/addPartyMember/
          // "创建角色"命令）共用它，不各自内联一份 resolvePlayerMetaSync 调用。
          result.member.meta = this.resolveMeta(persona, result.member.sheet);
        }
      } catch (e) {
        log.warn("session", "角色创建失败", e);
        this.#cleanupFailedConstruction();
        throw e;
      }
    } else {
      // 没有初始角色（没传 archetypeId）：先建一个空壳槽位——SAN(50 兜底)/
      // registerPlayer/persistSanity/session 槽位都要有，历史消息记录依赖
      // 活动玩家的 messageHistory，缺失会导致 getHistory 恒空。真正的角色卡
      // /世界实体/careerStore 留到"创建角色"命令时再补（#createPartyMember
      // 里"已存在则整体重建"那条语义正是为了接这里）。
      this.#installSanityEngine(new SanityEngine(50));
      this.#sanityEngines.set("p1", this.#sanityRaw);
      this.#worldRaw.registerPlayer("p1");
      this.#persistSanity("p1");
      if (!this.#playerSession.getActive()) {
        try {
          this.#playerSession.join("p1", characterName ?? "调查员", "p1");
        } catch { /* 已存在则忽略 */ }
      } else {
        this.#playerSession.switchActive("p1");
      }
    }
  }

  /** Build the frozen state-only SAN facade without exposing its raw engine. */
  private static sanityReadFacade(current: () => SanityEngine): SanityReadFacade {
    const facade: Record<string, unknown> = {};
    Object.defineProperty(facade, "state", {
      enumerable: true,
      get: () => current().state,
    });
    return Object.freeze(facade) as SanityReadFacade;
  }

  /**
   * Return a detached public member record.  The party map retains the raw
   * engine for internal restore/action paths; callers only get a stable,
   * dynamically backed state facade for this pcId.
   */
  private partyMemberView(member: PartyMember): PartyMemberView {
    const san = GameSession.sanityReadFacade(() => {
      this.#assertSessionReadable();
      return this.#sanityEngines.get(member.pcId) ?? member.san;
    });
    const meta = member.meta ? Object.freeze({ ...member.meta }) : undefined;
    return Object.freeze({
      pcId: member.pcId,
      sheet: freezeActiveCharacterPublicView(structuredClone(member.sheet)) as DeepReadonly<any>,
      san,
      control: member.control,
      ...(meta ? { meta } : {}),
    });
  }

  /**
   * Bind every observation to the private authority and copy all containers.
   * The facade is stable for a session while its getters/methods always read
   * the current engine, so module installation and snapshot restoration do
   * not leave callers holding a stale registry view.
   */
  private static investigationReadFacade(current: () => InvestigationEngine): InvestigationReadFacade {
    const readonlyStrings = (values: string[]): readonly string[] => Object.freeze([...values]);
    const facade: InvestigationReadFacade = {
      listClueTypes: () => readonlyStrings(current().listClueTypes()),
      hasClueType: (type) => current().hasClueType(type),
      getClueMatchInfo: (id) => {
        const info = current().getClueMatchInfo(id);
        return info === null
          ? null
          : Object.freeze({ displayName: info.displayName, matchTexts: readonlyStrings(info.matchTexts) });
      },
      isCoreClue: (id) => current().isCoreClue(id),
      isLockedByUndiscoveredPrerequisite: (id, playerName) => current().isLockedByUndiscoveredPrerequisite(id, playerName),
      listModuleClueIds: (opts) => readonlyStrings(current().listModuleClueIds(opts)),
      isDiscoveredBy: (clueType, playerName) => current().isDiscoveredBy(clueType, playerName),
      getDiscoveredBy: (playerName) => readonlyStrings(current().getDiscoveredBy(playerName)),
      getSceneClues: (sceneName) => readonlyStrings(current().getSceneClues(sceneName)),
      getUndiscoveredSceneClues: (sceneName, playerName) => readonlyStrings(current().getUndiscoveredSceneClues(sceneName, playerName)),
    };
    return Object.freeze(facade);
  }

  /** Bind registry observations to the private canonical authority and detach names. */
  private static registryReadFacade(current: () => AgentRegistry): AgentRegistryReadFacade {
    const facade: AgentRegistryReadFacade = {
      get count() { return current().count; },
      has: (name) => current().has(name),
      getAllNames: () => Object.freeze([...current().getAllNames()]),
    };
    return Object.freeze(facade);
  }

  /** Bind detached companion observations to the private canonical manager. */
  private static companionManagerReadFacade(current: () => CompanionManager): CompanionManagerReadFacade {
    const facade: CompanionManagerReadFacade = {
      getMorale: (id) => current().getMorale(id),
      isActive: (id) => current().isActive(id),
      getActiveCompanions: () => detachedFrozenCompanionRead(current().getActiveCompanions()),
      findByEntityId: (entityId) => detachedFrozenCompanionRead(current().findByEntityId(entityId)),
      getControl: (id) => current().getControl(id),
      getPlayerControlled: (userId) => detachedFrozenCompanionRead(current().getPlayerControlled(userId)),
      hasActed: (id) => current().hasActed(id),
      listItems: (id) => detachedFrozenCompanionRead(current().listItems(id)),
      hasItem: (id, itemName) => current().hasItem(id, itemName),
      resolveWeapon: (id) => current().resolveWeapon(id),
      getCommandObeyState: (id) => detachedFrozenCompanionRead(current().getCommandObeyState(id)),
    };
    return Object.freeze(facade);
  }

  /** Bind detached persistence reads to the private canonical store. */
  private static npcStoreReadFacade(current: () => NPCStore): NPCStoreReadFacade {
    const facade: NPCStoreReadFacade = {
      exportSnapshot: () => detachedFrozenNPCStoreRead(current().exportSnapshot()),
      getAllPersonalities: () => detachedFrozenNPCStoreRead(current().getAllPersonalities()),
      getPersonality: (id) => detachedFrozenNPCStoreRead(current().getPersonality(id)),
      getRecentMemories: (npcId, limit) => detachedFrozenNPCStoreRead(current().getRecentMemories(npcId, limit)),
      getImportantMemories: (npcId, minImportance, limit) => detachedFrozenNPCStoreRead(current().getImportantMemories(npcId, minImportance, limit)),
      getSceneMemories: (npcId, sceneId, limit) => detachedFrozenNPCStoreRead(current().getSceneMemories(npcId, sceneId, limit)),
      searchMemories: (npcId, keyword, limit) => detachedFrozenNPCStoreRead(current().searchMemories(npcId, keyword, limit)),
      countMemories: (npcId) => current().countMemories(npcId),
      getRelationship: (npcId, targetName) => current().getRelationship(npcId, targetName),
      getAllRelationships: (npcId) => detachedFrozenNPCStoreRead(current().getAllRelationships(npcId)),
      getState: (npcId) => detachedFrozenNPCStoreRead(current().getState(npcId)),
    };
    return Object.freeze(facade);
  }

  /** Bind every supported career read to the private store and detach its records. */
  private static careerStoreReadFacade(current: () => CareerFileStore): CareerStoreReadFacade {
    const facade = Object.assign(Object.create(null), {
      getSnapshot: (characterName: string) => detachedFrozenCareerRead(current().getSnapshot(characterName)),
      listCharacters: () => detachedFrozenCareerRead(current().listCharacters()),
      exportPortableProjection: () => detachedFrozenCareerRead(current().exportPortableProjection()),
      getEntries: (characterName: string) => detachedFrozenCareerRead(current().getEntries(characterName)),
      loadCareer: (characterName: string) => detachedFrozenCareerRead(current().loadCareer(characterName)),
      listCareers: () => detachedFrozenCareerRead(current().listCareers()),
      exportToJson: (characterName: string) => current().exportToJson(characterName),
    }) as CareerStoreReadFacade;
    return Object.freeze(facade);
  }

  /** Bind immutable reference-data queries to the private canonical loader. */
  private static worldModelReadFacade(current: () => WorldModelLoader): WorldModelLoaderReadFacade {
    const frozenStrings = (values: readonly string[]): readonly string[] => Object.freeze([...values]);
    const frozenSearch = (values: ReturnType<WorldModelLoader["search"]>): DeepReadonly<ReturnType<WorldModelLoader["search"]>> => {
      // Entries are deeply frozen once at loader admission. Only score wrappers
      // and their result container are fresh per query, avoiding a 383k-entry
      // structured clone while preserving a no-writable-alias observation.
      return Object.freeze(values.map(({ entry, score }) => Object.freeze({ entry, score }))) as DeepReadonly<ReturnType<WorldModelLoader["search"]>>;
    };
    const facade: WorldModelLoaderReadFacade = {
      isLoaded: () => current().isLoaded(),
      getAll: () => frozenWorldModelEntries(current().getAll()),
      getByNovel: (novel) => frozenWorldModelEntries(current().getByNovel(novel)),
      getByType: (type) => frozenWorldModelEntries(current().getByType(type)),
      getByNovelAndType: (novel, type) => frozenWorldModelEntries(current().getByNovelAndType(novel, type)),
      getNovelNames: () => frozenStrings(current().getNovelNames()),
      getTypeNames: () => frozenStrings(current().getTypeNames()),
      getDndRules: (novel) => frozenWorldModelEntries(current().getDndRules(novel)),
      getDndMappings: (novel) => frozenWorldModelEntries(current().getDndMappings(novel)),
      getMechanics: (novel) => frozenWorldModelEntries(current().getMechanics(novel)),
      search: (keywords, novel, type, maxResults) => frozenSearch(current().search(keywords, novel, type, maxResults)),
      getFactionRelations: () => frozenWorldModelEntries(current().getFactionRelations()),
      getBehaviors: () => frozenWorldModelEntries(current().getBehaviors()),
      queryCausal: (contextKeywords, maxResults) => frozenWorldModelEntries(current().queryCausal(contextKeywords, maxResults)),
      queryBehavior: (contextKeywords, maxResults) => frozenWorldModelEntries(current().queryBehavior(contextKeywords, maxResults)),
      randomCausal: (n) => frozenWorldModelEntries(current().randomCausal(n)),
      getStats: () => detachedFrozenWorldModelRead(current().getStats()),
      getNovelStats: (novel) => detachedFrozenWorldModelRead(current().getNovelStats(novel)),
    };
    return Object.freeze(facade);
  }

  /** Bind pure integrator reads to the raw integrator and detach every compound result. */
  private static worldModelIntegratorReadFacade(current: () => WorldModelIntegrator): WorldModelIntegratorReadFacade {
    const facade: WorldModelIntegratorReadFacade = {
      buildInjection: (ctx) => detachedFrozenWorldModelRead(current().buildInjection(ctx)),
      buildKPContext: (ctx) => current().buildKPContext(ctx),
      getNPCGuidance: (npcName, ctx) => current().getNPCGuidance(npcName, ctx),
      getRuleHints: (ruleset, ctx) => Object.freeze([...current().getRuleHints(ruleset, ctx)]),
    };
    return Object.freeze(facade);
  }

  /** Bind detached KP observations to the private canonical agent. */
  private static kpReadFacade(current: () => KPAgent): KPReadFacade {
    const facade: KPReadFacade = {
      getDirective: () => detachedFrozenKPRead(current().getDirective()),
      getTurns: () => detachedFrozenKPRead(current().getTurns()),
    };
    return Object.freeze(facade);
  }

  /** Bind detached politico-economic observations to the private engine. */
  private static politicoEconomyReadFacade(current: () => PoliticoEconomyEngine): PoliticoEconomyReadFacade {
    const facade: PoliticoEconomyReadFacade = {
      get round() { return current().round; },
      getState: () => detachedFrozenPoliticoEconomyRead(current().getState()),
      getBriefState: () => detachedFrozenPoliticoEconomyRead(current().getBriefState()),
      getEconomyVizData: () => detachedFrozenPoliticoEconomyRead(current().getEconomyVizData()),
      getDiplomaticContext: () => current().getDiplomaticContext(),
      renderEconomyHtml: () => current().renderEconomyHtml(),
    };
    return Object.freeze(facade);
  }

  /**
   * Bind each read operation to the private authority rather than the facade,
   * so extracting a public method cannot recover a mutable receiver.
   */
  private static playerSessionReadFacade(current: () => PlayerSession): PlayerSessionReadFacade {
    const facade: PlayerSessionReadFacade = {
      get count() { return current().count; },
      get semanticRevision() { return current().semanticRevision; },
      get stateReplacementRevision() { return current().stateReplacementRevision; },
      get: (name) => current().get(name),
      getActive: () => current().getActive(),
      getAll: () => current().getAll(),
      getAllNames: () => current().getAllNames(),
      snapshot: () => current().snapshot(),
      exportSnapshot: () => current().exportSnapshot(),
      getPlayerHistory: (name) => current().getPlayerHistory(name),
      getActiveHistory: () => current().getActiveHistory(),
      getRecentGlobal: (count) => current().getRecentGlobal(count),
      knowsSecret: (name, secretId) => current().knowsSecret(name, secretId),
      getPlayerScene: (name) => current().getPlayerScene(name),
      getPlayersInScene: (sceneId) => current().getPlayersInScene(sceneId),
    };
    return Object.freeze(facade);
  }

  /**
   * Release session-owned SQLite authorities while closing this session.
   * Afterwards only identity/reference diagnostics remain observable; any
   * retired value is not evidence that this session is usable or authoritative.
   */
  close(): void {
    this.#closeCanonical();
  }

  #closeCanonical(): void {
    if (this.#npcStoreClosed) return;
    this.#lifecycleRevision++;
    this.#npcStoreClosed = true;
    try {
      if (this.#hasSessionOwnedNpcStore) this.#npcStoreRaw.close();
    } finally {
      this.#worldRaw.close();
    }
  }

  /** Session-bound runtime projections must not disclose stale or partial cohorts after close. */
  #assertSessionReadable(): void {
    if (this.#npcStoreClosed) throw new Error("closed GameSession cannot read session state");
  }

  /** Resolve retained world reads through the session lifecycle boundary. */
  #resolveWorldReadFacade(): WorldStateManager {
    if (this.#npcStoreClosed) throw new Error("closed GameSession cannot read world");
    return this.#worldRaw;
  }

  #failStopDirectAction(): void {
    if (this.#directActionFailStopped) return;
    this.#directActionFailStopped = true;
    // `close()` releases session-owned authorities and the world even when the
    // first close throws; caller-owned store lifetime remains external. A close
    // error cannot make this session usable again.
    try { this.#closeCanonical(); } catch { /* fail-stop is authoritative */ }
  }

  /** A throwing constructor has no public object to close, so release its own stores here. */
  #cleanupFailedConstruction(): void {
    // Keep the original construction failure observable even if resource
    // disposal itself faults. #closeCanonical always attempts WorldState
    // cleanup after the session-owned NPC store.
    try { this.#closeCanonical(); } catch { /* original construction failure is authoritative */ }
  }

  #directActionLifecycleIsCurrent(revision: number): boolean {
    return !this.#npcStoreClosed && this.#lifecycleRevision === revision;
  }

  #closedDirectActionError(): Error {
    return new Error("closed GameSession cannot accept actions");
  }

  /**
   * Explicit dynamic compiler injection. It accepts no static module registry key
   * and deliberately does not use ModuleDataRuntimeLoader.
   *
   * Validation, initial MechanicsState creation, and automatic settlement finish
   * before the first WorldStateManager write. Thereafter MechanicsState is the
   * mechanics authority: this method mirrors scene/visit/clue facts into the
   * world store, and InvestigationEngine reads those world-backed clue facts
   * without receiving a separate compiled interpreter or mutable copy.
   */
  loadCompiledModule(
    payload: ResolvedCompilerArtifactPayload,
    projection: CompilerModuleDataProjection,
  ): CompiledModuleLoadResult {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#playerSession.count > 1 || this.#party.size > 1) {
      return { status: "refused", code: "COMPILED_SESSION_CONFLICT", message: "compiled modules require exactly one p1 player" };
    }
    try {
      return this.#loadCompiledModuleInternal(payload, projection);
    } catch (error) {
      return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Durable creation accepts one catalog-validated immutable bundle, never loose payload/projection values. */
  loadDurableCompiledModule(
    bundle: LoadedBundleCatalogEntry,
    access: CompiledSessionAccessBinding | null = null,
  ): CompiledModuleLoadResult {
    this.#assertOrdinaryDurableMutationAllowed();
    if (!this.#isPristineDurableCompiledSession()) {
      return { status: "refused", code: "COMPILED_SESSION_CONFLICT", message: "durable compiled modules require a pristine single-p1 session" };
    }
    const validated = validateCompiledModuleBundle(bundle.artifact, bundle.projection);
    if (validated.status === "refused") return validated;
    let catalogHashMatches = false;
    try { catalogHashMatches = bundle.bundleHash === compiledBundleCatalogHash(bundle); }
    catch { return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "durable compiled sessions require an attestable catalog bundle identity" }; }
    let worldModelBinding: CompiledCthulhuWorldModelBinding | undefined;
    if (bundle.worldModelBinding !== undefined) {
      try {
        assertCompiledCthulhuWorldModelBindingArtifactIdentity(bundle.worldModelBinding, {
          moduleId: validated.payload.identity.moduleId,
          artifactHash: validated.artifactHash,
        });
        worldModelBinding = validateCompiledCthulhuWorldModelBinding(bundle.worldModelBinding);
      } catch (error) {
        return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: error instanceof Error ? error.message : "compiled world-model binding is invalid" };
      }
    }
    if (!/^[a-z2-7]{24}$/.test(bundle.id) || !/^[a-f0-9]{64}$/.test(bundle.bundleHash) || !catalogHashMatches
      || bundle.artifactHash !== validated.artifactHash || bundle.mechanicsHash !== validated.payload.identity.mechanicsHash
      || bundle.identity.moduleId !== validated.payload.identity.moduleId) {
      return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "durable compiled sessions require a catalog-validated bundle identity" };
    }
    try {
      const installed = this.#loadCompiledModuleInternal(
        bundle.artifact.payload as ResolvedCompilerArtifactPayload,
        bundle.projection,
        { id: bundle.id, bundleHash: bundle.bundleHash },
      );
      if (installed.status === "loaded" && this.#compiledModule) {
        this.#compiledModule.access = structuredClone(access);
        this.#compiledModule.worldModelBinding = worldModelBinding;
        this.#compiledModule.catalogBundle = structuredClone(bundle);
      }
      return installed;
    } catch (error) {
      return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: error instanceof Error ? error.message : String(error) };
    }
  }

  #loadCompiledModuleInternal(
    payload: ResolvedCompilerArtifactPayload,
    projection: CompilerModuleDataProjection,
    durableBundle?: Pick<LoadedBundleCatalogEntry, "id" | "bundleHash">,
  ): CompiledModuleLoadResult {
    if (this.#compiledModule || this.#registeredModules.length > 0 || this.#loadedModules.size > 0) {
      return { status: "refused", code: "COMPILED_SESSION_CONFLICT", message: "compiled modules require a session without another loaded module" };
    }

    const bundle = validateCompiledModuleBundle(payload, projection);
    if (bundle.status === "refused") return bundle;
    let compiled: LoadedCompiledModule;
    try {
      const budget = createMechanicsStateBudget(bundle.payload.analysisInput.maxStates);
      const settled = settleInitialMechanics(bundle.payload.mechanicsIR, bundle.payload.analysisInput, budget);
      if (settled.state.rewardIds.length) throw new Error("initial automatic source-bound rewards require a player-action terminal settlement");
      compiled = {
        payload: bundle.payload,
        projection: bundle.projection,
        state: settled.state,
        trace: [...settled.steps],
        budget,
        durableBundle,
        access: null,
        pendingSkillGrowth: [],
      initialCharacter: this.#compiledSnapshotCharacter(this.#characters.get("p1"), this.#sanityEngines.get("p1") ?? this.#sanityRaw),
      };
    } catch (error) {
      return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: error instanceof Error ? error.message : String(error) };
    }

    try {
      this.#installCompiledProjectionAtomically(compiled.projection, compiled.payload.mechanicsIR, compiled.state);
      this.#compiledModule = compiled;
      this.#compiledGeneration = 0;
      this.#compiledIdempotency.clear();
      this.#compiledFailStopped = false;
      return { status: "loaded", compiled: this.#compiledMechanicsStateProjection()! };
    } catch (error) {
      return { status: "refused", code: "COMPILED_SESSION_CONFLICT", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The only RuntimeModulePackage dispatcher. Every branch validates its
   * discriminator, identity, slot conflict, and required structure before the
   * first legacy-loader or WorldStateManager write. It intentionally delegates
   * to the existing three executors instead of merging their semantics.
   */
  #pickupOriginsForLegacyModule(module: LoadedModule): RuntimePickupOrigin[] {
    if (isModuleData(module)) {
      const runtime = module.runtime as unknown as Record<string, unknown>;
      return normalizeRuntimeModulePickupOrigins({
        tomes: runtime.tomes,
        itemPlacements: runtime.itemPlacements,
        richItems: module.items,
      });
    }
    return normalizeRuntimeModulePickupOrigins({ tomes: module.tomes, itemPlacements: module.items });
  }

  /**
   * A package name is an item identity, not a free-form display label.  Do
   * this before a legacy host is allowed to mutate so a pre-existing player
   * inventory cannot silently claim a newly-installed package origin.
   */
  #assertPickupOriginsAreUnclaimed(origins: readonly RuntimePickupOrigin[]): void {
    const names = new Set(origins.map((origin) => origin.name));
    for (const player of this.#playerSession.getAll()) {
      const collision = this.#worldRaw.getPlayerInventory(player.characterId)
        .find((item) => names.has(item));
      if (collision !== undefined) {
        throw new Error(`runtime pickup origin already exists in player inventory: ${collision}`);
      }
    }
  }

  /** Install normalized origin declarations only after the corresponding loader succeeds. */
  #registerPickupOrigins(origins: readonly RuntimePickupOrigin[]): void {
    if (this.#modulePickupOrigins.size !== 0) throw new Error("runtime pickup origins already exist");
    for (const origin of origins) {
      this.#modulePickupOrigins.set(origin.name, Object.freeze({ ...origin }));
    }
  }

  #installRuntimeModulePackage(input: unknown, beforeLegacyHostWrite?: () => void): RuntimeModulePackageInstall {
    assertRuntimeModulePackage(input);
    const packageValue: RuntimeModulePackage = input;
    if (this.#compiledModule || this.#registeredModules.length > 0 || this.#loadedModules.size > 0) {
      if (packageValue.kind === "compiled_bundle") {
        return { kind: "compiled_bundle", result: { status: "refused", code: "COMPILED_SESSION_CONFLICT", message: "compiled modules require a session without another loaded module" } };
      }
      throw new Error("当前会话只能安装一个模组");
    }
    switch (packageValue.kind) {
      case "compiled_bundle":
        return {
          kind: "compiled_bundle",
          result: this.#loadCompiledModuleInternal(packageValue.payload, packageValue.projection, packageValue.durableBundle),
        };
      case "runtime_module_data_legacy": {
        // Repeat the direct-loader's pure preflight here so the package boundary
        // itself is complete before creating or entering the loader.
        const module = validateRuntimeModuleDataForInstall(packageValue.module);
        const pickupOrigins = this.#pickupOriginsForLegacyModule(module);
        this.#assertPickupOriginsAreUnclaimed(pickupOrigins);
        if (!this.#moduleDataLoader) this.#moduleDataLoader = new ModuleDataRuntimeLoader(this.#moduleDataRuntimeHost());
        beforeLegacyHostWrite?.();
        const result = this.#moduleDataLoader.import(module);
        this.#registerPickupOrigins(pickupOrigins);
        return { kind: "runtime_module_data_legacy", module, lines: result.lines, entryScene: result.entryScene ?? undefined };
      }
      case "mythos_legacy": {
        const pickupOrigins = this.#pickupOriginsForLegacyModule(packageValue.module);
        this.#assertPickupOriginsAreUnclaimed(pickupOrigins);
        beforeLegacyHostWrite?.();
        const lines = this.#legacyModuleLoader().import(packageValue.module);
        this.#registerPickupOrigins(pickupOrigins);
        return { kind: "mythos_legacy", module: packageValue.module, lines };
      }
    }
  }

  getCompiledMechanicsState(): CompiledMechanicsSessionState | null {
    this.#assertSessionReadable();
    return this.#compiledMechanicsStateProjection();
  }

  #compiledMechanicsStateProjection(): CompiledMechanicsSessionState | null {
    const compiled = this.#compiledModule;
    if (!compiled) return null;
    return this.#compiledState(compiled.payload, compiled.projection, compiled.state, compiled.trace, this.#compiledGeneration ?? 0);
  }

  getCompiledGeneration(): number | null {
    this.#assertSessionReadable();
    return this.#compiledModule ? this.#compiledGeneration ?? 0 : null;
  }

  /**
   * Returns only mechanisms the shared execution core can execute from the
   * already-settled state. Listing never settles or observes the live budget.
   */
  getCompiledAvailableActions(): CompiledAvailableAction[] {
    this.#assertSessionReadable();
    return this.#compiledAvailableActionsProjection();
  }

  #compiledAvailableActionsProjection(): CompiledAvailableAction[] {
    const compiled = this.#compiledModule;
    if (!compiled) return [];
    const state = structuredClone(compiled.state);
    if (nextAutomaticMechanicsStep(compiled.payload.mechanicsIR, state)) {
      throw new Error("compiled mechanics state is not settled before action discovery");
    }
    const actionByMechanism = new Map<string, CompiledAvailableAction>();
    for (const available of availableMechanicsPlayerActions(compiled.payload.mechanicsIR, compiled.payload.analysisInput, state)) {
      if (actionByMechanism.has(available.mechanismId)) continue;
      if (available.outcome === "attack") {
        const definition = compiled.payload.mechanicsIR.encounterDefinitions.find((candidate) => candidate.encounterId === available.combat.encounterId);
        const npc = definition && compiled.projection.module.npcs.find((candidate) => candidate.id === definition.combatantId);
        const encounter = definition && state.encounters[definition.encounterId];
        if (!definition || !npc || npc.sceneId !== state.currentSceneId || definition.sceneId !== state.currentSceneId || encounter?.status !== "active") {
          throw new Error(`compiled attack lacks an active trusted encounter projection: ${available.mechanismId}`);
        }
        actionByMechanism.set(available.mechanismId, {
          mechanismId: available.mechanismId,
          kind: "combat",
          command: compiledMechanicsAction(available.mechanismId),
          label: `Attack ${npc.name}`,
        });
        continue;
      }
      const discovery = compiled.payload.mechanicsIR.discoveryMethods.find((candidate) => candidate.id === available.mechanismId);
      if (discovery) {
        const targetItem = discovery.target === "item" ? compiled.projection.module.items.find((item) => item.id === discovery.targetId) : undefined;
        const targetNpc = discovery.target === "npc" ? compiled.projection.module.npcs.find((npc) => npc.id === discovery.targetId) : undefined;
        if (discovery.target === "item" && !targetItem) throw new Error(`compiled item discovery lacks projected item: ${discovery.id}`);
        if (discovery.target === "npc") {
          const scene = compiled.projection.module.scenes.find((candidate) => candidate.id === state.currentSceneId);
          if (!targetNpc || !scene || targetNpc.sceneId !== state.currentSceneId || !scene.npcIds.includes(targetNpc.id)) {
            throw new Error(`compiled NPC discovery lacks a projected NPC in its mechanics scene: ${discovery.id}`);
          }
        }
        actionByMechanism.set(discovery.id, {
          mechanismId: discovery.id,
          kind: "discovery",
          command: compiledMechanicsAction(discovery.id),
          label: targetItem ? `Take ${targetItem.name}` : targetNpc ? `Talk to ${targetNpc.name}` : compiledDiscoveryLabel(discovery.action),
          ...(discovery.check && discovery.check.kind !== "none" ? { check: structuredClone(discovery.check) } : {}),
        });
        continue;
      }
      const gate = compiled.payload.mechanicsIR.connections.find((candidate) => candidate.id === available.mechanismId);
      const connection = gate && compiled.payload.analysisInput.connections.find((candidate) => candidate.id === gate.connectionId);
      const destination = connection && compiled.projection.module.scenes.find((scene) => scene.id === connection.toSceneId)?.name;
      actionByMechanism.set(available.mechanismId, {
        mechanismId: available.mechanismId,
        kind: "traversal",
        command: compiledMechanicsAction(available.mechanismId),
        label: destination ? `Go to ${destination}` : "Go to another area",
      });
    }
    return structuredClone([...actionByMechanism.values()].sort((left, right) => left.mechanismId.localeCompare(right.mechanismId)));
  }

  /** Generic wording only: source scene, NPC, item, and mechanism names stay server-side. */
  private compiledPlayerActionLabel(action: CompiledAvailableAction): string {
    if (action.kind === "combat") return "Attack";
    if (action.kind === "traversal") return "Go to another area";
    const discovery = this.#compiledModule?.payload.mechanicsIR.discoveryMethods.find((candidate) => candidate.id === action.mechanismId);
    switch (discovery?.action) {
      case "observe": return "Observe here";
      case "search": return "Search here";
      case "talk": return "Talk";
      case "read": return "Read here";
      case "use_item": return "Use an item";
      case "move": return "Go to another area";
      case "custom": return "Take action";
      default: return "Take action";
    }
  }

  /**
   * A durable player fa莽ade may stage source text only from the canonical
   * trusted-review projection already accepted at the bundle boundary.  Plain
   * projections can contain caller metadata, so their prose never crosses the
   * player boundary at all.
   */
  private compiledPlayerPresentationFor(state: MechanicsState): CompiledPlayerFacadePresentation | undefined {
    const compiled = this.#compiledModule;
    if (!compiled?.durableBundle || !compiled.projection.presentationReview) return undefined;
    const scene = compiled.projection.module.scenes.find((candidate) => candidate.id === state.currentSceneId);
    if (!scene) throw new Error("trusted compiled presentation lacks the current scene");
    const clues = new Map(compiled.projection.module.scenes.flatMap((candidate) => candidate.clues).map((clue) => [clue.id, clue]));
    const discovered = state.foundClueIds.map((clueId) => {
      const clue = clues.get(clueId);
      if (!clue) throw new Error("trusted compiled presentation lacks a discovered clue");
      return { name: clue.name, revelation: clue.revelation };
    });
    const endingId = state.terminalEndingId;
    const ending = endingId === undefined ? undefined : compiled.projection.module.endings.find((candidate) => candidate.id === endingId);
    if (endingId !== undefined && !ending) throw new Error("trusted compiled presentation lacks the terminal ending");
    const contacts = this.#compiledPlayerContactsFor(state);
    return {
      scene: { name: scene.name, description: scene.description },
      clues: discovered,
      ...(contacts.length ? { contacts } : {}),
      ...(ending ? { ending: { name: ending.name, description: ending.description } } : {}),
    };
  }

  /**
   * A contact is a narrow intersection, not a broad discovered-clue or NPC
   * projection.  It is current-scene only, requires this exact prose-dialogue
   * clue to be found, and requires the durable machine receipt to have
   * released that canonical NPC name.  IDs and every other NPC field remain
   * host-only.
   */
  #compiledPlayerFollowupContactsFor(state: MechanicsState): CompiledPlayerFollowupContact[] {
    const compiled = this.#compiledModule;
    const machinePublication = compiled?.projection.presentationReview?.machinePublication;
    if (!compiled?.durableBundle || !machinePublication) return [];
    const bundleId = compiled.durableBundle.id;
    const scene = compiled.projection.module.scenes.find((candidate) => candidate.id === state.currentSceneId);
    if (!scene) throw new Error("trusted compiled presentation lacks the current scene");
    const foundClueIds = new Set(state.foundClueIds);
    const sceneNpcIds = new Set(scene.npcIds);
    const npcById = new Map(compiled.projection.module.npcs.map((npc) => [npc.id, npc]));
    const publicNameNpcIds = new Set(machinePublication.scopes
      .filter((scope) => scope.audience === "public_on_entry")
      .map((scope) => /^npcs\.([^.]+)\.name$/.exec(scope.fieldPath)?.[1])
      .filter((npcId): npcId is string => npcId !== undefined));
    const projectionClues = new Map(compiled.projection.module.scenes.flatMap((candidate) =>
      candidate.clues.map((clue) => [`${candidate.id}\u0000${clue.id}`, clue] as const)));
    const released = new Map<string, Array<{ clueId: string; facts: readonly string[] }>>();
    for (const clue of [...compiled.payload.proseDialogueClues].sort((left, right) => left.npcId.localeCompare(right.npcId))) {
      if (clue.sceneCandidateId !== state.currentSceneId || !foundClueIds.has(clue.clueId)
        || !sceneNpcIds.has(clue.npcId) || !publicNameNpcIds.has(clue.npcId)) continue;
      const npc = npcById.get(clue.npcId);
      if (!npc || npc.sceneId !== state.currentSceneId) continue;
      const clueScope = (field: "name" | "revelation") => machinePublication.scopes.some((scope) =>
        scope.fieldPath === `clues.${clue.clueId}.${field}` && scope.audience === "found_clue");
      if (!clueScope("name") || !clueScope("revelation")) continue;
      const published = projectionClues.get(`${state.currentSceneId}\u0000${clue.clueId}`);
      if (!published || !published.name || !published.revelation) continue;
      const facts = Object.freeze([...new Set([published.name, published.revelation])]);
      const current = released.get(npc.id) ?? [];
      current.push({ clueId: clue.clueId, facts });
      released.set(npc.id, current);
    }
    return [...released.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([npcId, entries]) => {
      const npc = npcById.get(npcId);
      if (!npc) throw new Error("trusted compiled presentation lacks a released NPC");
      const sorted = [...entries].sort((left, right) => left.clueId.localeCompare(right.clueId));
      return Object.freeze({
          sessionId: this.#idRaw,
          bundleId,
          generation: this.#compiledGeneration ?? -1,
          sceneId: state.currentSceneId,
          npcId,
          clueIds: Object.freeze(sorted.map((entry) => entry.clueId)),
          name: npc.name,
          facts: Object.freeze([...new Set(sorted.flatMap((entry) => entry.facts))]),
        });
    });
  }

  #compiledPlayerContactsFor(state: MechanicsState): Array<{ name: string }> {
    return this.#compiledPlayerFollowupContactsFor(state).map(({ name }) => ({ name }));
  }

  #compiledPlayerFollowupContactsCanonical(): readonly CompiledPlayerFollowupContact[] {
    this.#assertSessionReadable();
    const compiled = this.#compiledModule;
    if (!compiled?.durableBundle || this.#compiledGeneration === null) return [];
    return this.#compiledPlayerFollowupContactsFor(compiled.state);
  }

  private compiledPlayerPresentation(): CompiledPlayerFacadePresentation | undefined {
    const compiled = this.#compiledModule;
    return compiled ? this.compiledPlayerPresentationFor(compiled.state) : undefined;
  }

  /**
   * Minimal p1 projection for the separate player façade. It intentionally
   * never reuses the broad summary/state/history/KP projections. Its only
   * source text is the independent, trusted-review-bound staged projection.
   */
  getCompiledPlayerFacadeView(): CompiledPlayerFacadeView {
    this.#assertSessionReadable();
    const compiled = this.#compiledModule;
    const generation = this.#compiledGeneration;
    const access = compiled?.access;
    const character = this.#characters.get("p1");
    const sanity = this.#sanityEngines.get("p1") ?? this.#sanityRaw;
    if (!compiled?.durableBundle || generation === null || !access || !character) {
      throw new Error("compiled player façade is unavailable");
    }
    const actions = this.#compiledAvailableActionsProjection().map((action) => this.compiledPlayerFacadeAction(action, generation, access.choiceHmacKey));
    const presentation = this.compiledPlayerPresentation();
    const narrated = [...this.#compiledIdempotency.values()].reverse().find((record) => {
      const value = record.response.action.playerNarration;
      return !!value && typeof value === "object" && !Array.isArray(value)
        && (value as { schemaVersion?: unknown }).schemaVersion === "1.0.0"
        && typeof (value as { text?: unknown }).text === "string";
    });
    const narration = narrated?.response.action.playerNarration as { schemaVersion: "1.0.0"; text: string } | undefined;
    return {
      schemaVersion: COMPILED_PLAYER_FACADE_SCHEMA_VERSION,
      generation,
      round: this.#roundRaw,
      ruleset: "cosmic-horror",
      terminal: !!compiled.state.terminalEndingId || !!compiled.state.terminalLoss,
      character: {
        name: typeof character.name === "string" ? character.name : "调查员",
        hp: typeof character.hp === "number" ? character.hp : 0,
        maxHp: typeof character.maxHp === "number" ? character.maxHp : 0,
      },
      sanity: {
        currentSAN: sanity.state.currentSAN,
        maxSAN: sanity.state.maxSAN,
        temporaryInsanity: sanity.state.temporaryInsanity,
        indefiniteInsanity: sanity.state.indefiniteInsanity,
      },
      actions,
      ...(presentation ? { presentation } : {}),
      ...(narrated && narration ? { turn: { generation: narrated.generation, text: narration.text } } : {}),
    };
  }

  /**
   * Maps a model-selected internal mechanism back into the *current* opaque
   * player façade.  Callers never receive the mechanism ID or its command.
   */
  getCurrentCompiledPlayerFacadeActionForMechanism(mechanismId: string, expectedGeneration: number): CompiledPlayerFacadeAction | null {
    this.#assertSessionReadable();
    const compiled = this.#compiledModule;
    const generation = this.#compiledGeneration;
    const access = compiled?.access;
    if (!compiled?.durableBundle || !access || generation === null || generation !== expectedGeneration
      || typeof mechanismId !== "string" || !mechanismId || mechanismId.trim() !== mechanismId) return null;
    const action = this.#compiledAvailableActionsProjection().find((candidate) => candidate.mechanismId === mechanismId);
    return action ? this.compiledPlayerFacadeAction(action, generation, access.choiceHmacKey) : null;
  }

  private compiledPlayerFacadeAction(action: CompiledAvailableAction, generation: number, choiceHmacKey: string): CompiledPlayerFacadeAction {
    return {
      choiceId: compiledPlayerChoiceId(choiceHmacKey, generation, action.mechanismId),
      label: this.compiledPlayerActionLabel(action),
      ...(action.check ? { check: compiledPlayerFacadeCheck(action.check) } : {}),
    };
  }

  /**
   * Resolve an opaque choice without ever accepting a caller-supplied
   * mechanism ID. All catalog IDs are considered only to support an exact
   * idempotent retry from a prior generation; execution still checks current
   * reachability in the shared durable transaction.
   */
  #resolveCompiledPlayerFacadeActionInputCanonical(choiceId: string, expectedGeneration: number): string | null {
    const compiled = this.#compiledModule;
    const access = compiled?.access;
    if (!compiled?.durableBundle || !access || !/^choice_[A-Za-z0-9_-]{43}$/.test(choiceId)
      || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) return null;
    const candidateIds = new Set<string>([
      ...compiled.payload.mechanicsIR.discoveryMethods.map((entry) => entry.id),
      ...compiled.payload.mechanicsIR.connections.map((entry) => entry.id),
      ...compiled.payload.mechanicsIR.encounterDefinitions.map((entry) => `attack:${entry.encounterId}`),
    ]);
    for (const mechanismId of candidateIds) {
      if (compiledPlayerChoiceId(access.choiceHmacKey, expectedGeneration, mechanismId) === choiceId) {
        return compiledMechanicsAction(mechanismId);
      }
    }
    return null;
  }

  /**
   * Derive replay keys inside the compiled durable-host closure.  The durable
   * access binding's choice HMAC key must never be returned to the HTTP
   * layer: this one-way, domain-separated result is all its SQLite ledger
   * needs.  In particular, input prose and catalog labels only ever occur in
   * the HMAC message and are never usable as a persisted dictionary digest.
   */
  #deriveCompiledIntentReplayIdentityCanonical(
    input: string,
    expectedGeneration: number,
    catalog: readonly CompiledAvailableAction[],
  ): CompiledIntentReplayIdentity {
    const compiled = this.#compiledModule;
    const access = compiled?.access;
    const generation = this.#compiledGeneration;
    if (!compiled?.durableBundle || !access || generation === null || generation !== expectedGeneration
      || typeof input !== "string" || !input || input.trim() !== input
      || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      throw new Error("compiled intent replay binding is unavailable");
    }
    const currentCatalog = this.#compiledAvailableActionsProjection();
    if (!samePortableJson(currentCatalog, catalog)) {
      throw new Error("compiled intent replay catalog is not the current authoritative catalog");
    }
    const canonicalCatalog = currentCatalog.map((action) => ({
      mechanismId: action.mechanismId,
      kind: action.kind,
      command: action.command,
      label: action.label,
      check: action.check ?? null,
    }));
    const key = Buffer.from(access.choiceHmacKey, "hex");
    const derive = (domain: string, value: unknown): string => createHmac("sha256", key)
      .update(canonicalJson({ domain, value }))
      .digest("hex");
    const bundle = { id: compiled.durableBundle.id, bundleHash: compiled.durableBundle.bundleHash };
    const scope = { sessionId: this.#idRaw, expectedGeneration, bundle };
    return Object.freeze({
      sessionKey: derive("compiled-intent-replay-session-v1", { sessionId: this.#idRaw }),
      expectedGeneration,
      scopeKey: derive("compiled-intent-replay-scope-v1", scope),
      requestKey: derive("compiled-intent-replay-request-v1", { ...scope, input }),
      catalogKey: derive("compiled-intent-replay-catalog-v1", { ...scope, catalog: canonicalCatalog }),
      integrityKey: derive("compiled-intent-replay-integrity-v1", { ...scope, input }),
      mechanismKeys: Object.freeze(currentCatalog.map((action) => Object.freeze({
        mechanismId: action.mechanismId,
        key: derive("compiled-intent-replay-mechanism-v1", { ...scope, mechanismId: action.mechanismId }),
      }))),
    });
  }

  #isDurableCompiledSession(): boolean {
    return !!this.#compiledModule?.durableBundle;
  }

  isDurableCompiledSession(): boolean {
    return this.#isDurableCompiledSession();
  }

  /** The full binding stays in the module-private durable-host closure. */
  #compiledSessionAccessBindingCanonical(): CompiledSessionAccessBinding | null {
    const access = this.#compiledModule?.access;
    return access ? structuredClone(access) : null;
  }

  /** Exact source receipt for the latest compiled-only model prompt; never player input or executable state. */
  getCompiledWorldModelPromptReceipt(): Omit<CompiledWorldModelPromptContext, "text"> | null {
    this.#assertSessionReadable();
    return this.#compiledWorldModelPromptReceipt ? structuredClone(this.#compiledWorldModelPromptReceipt) : null;
  }

  /** Runtime authorization compares this to the independently re-read metadata binding. */
  getOrdinarySessionAccessBinding(): OrdinarySessionAccessBinding | null {
    this.#assertSessionReadable();
    return this.#ordinarySessionAccess ? structuredClone(this.#ordinarySessionAccess) : null;
  }

  #assertOrdinaryDurableMutationAllowed(): void {
    if (this.#npcStoreClosed) throw this.#closedDirectActionError();
    if (this.#ordinaryDurableIdentity !== null) throw new OrdinaryDurableMutationError();
  }

  /** The host-only acknowledgement write path; it is reached only via the WeakMap authority below. */
  #acknowledgeOrdinaryDurableIdentityCanonical(identity: OrdinarySessionDurableIdentity): void {
    if (!Number.isSafeInteger(identity.generation) || identity.generation < 0
      || !/^[a-f0-9]{64}$/.test(identity.envelopeHash)
      || !/^sha256:[a-f0-9]{64}$/.test(identity.snapshotHash)) {
      throw new Error("invalid ordinary durable identity");
    }
    if (this.#ordinaryDurableIdentity !== null) {
      const current = this.#ordinaryDurableIdentity;
      if (current.generation === identity.generation
        && current.envelopeHash === identity.envelopeHash
        && current.snapshotHash === identity.snapshotHash) {
        return;
      }
      throw new Error("ordinary durable identity is already installed");
    }
    this.#ordinaryDurableIdentity = { ...identity };
  }

  getOrdinaryDurableIdentity(): OrdinarySessionDurableIdentity | null {
    // A retired identity is diagnostic/fencing metadata only; it never proves
    // that this process-local object is live or may execute an action.
    return this.#ordinaryDurableIdentity ? { ...this.#ordinaryDurableIdentity } : null;
  }

  /**
   * Produce a portable snapshot for an ordinary (non-compiled) session.
   * This deliberately refuses caller-injected NPC stores: making an external
   * authority portable could leak or overwrite state outside this session.
   */
  exportOrdinarySessionSnapshot(): OrdinaryGameSessionSnapshot {
    return this.#exportOrdinarySessionSnapshotCanonical();
  }

  #exportOrdinarySessionSnapshotCanonical(): OrdinaryGameSessionSnapshot {
    if (this.#compiledModule) throw new Error("compiled GameSession cannot be exported as an ordinary-session snapshot");
    if (this.#activeRulesetRaw !== "cosmic-horror") throw new Error("ordinary portable snapshots currently support only cosmic-horror character sheets");
    if (!this.#hasSessionOwnedNpcStore) throw new Error("ordinary portable snapshots require a private session-owned NPCStore");
    if (this.#npcStoreClosed) throw new Error("closed GameSession cannot be exported");
    if ((this.#activeActionTransactions !== 0 && !this.#ordinaryCommitSnapshotExport) || this.#actingStatusesBeforeTick !== undefined || this.#turnMessages !== null) {
      throw new Error("ordinary portable snapshot export is forbidden while an action is in flight");
    }

    const module = this.ordinarySnapshotModule();
    return createOrdinaryGameSessionSnapshot({
      kind: "ordinary-game-session",
        schemaVersion: ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
      components: ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
      session: {
        id: this.#idRaw,
        createdAt: this.#createdAtRaw,
        lastActiveAt: this.#lastActiveAtRaw,
        ruleset: this.#activeRulesetRaw,
        access: this.#ordinarySessionAccess ? structuredClone(this.#ordinarySessionAccess) : null,
      },
      module,
      world: this.#worldRaw.exportSnapshot(),
      playerSession: this.#playerSession.exportSnapshot(),
      politicoEconomy: this.#politicoEconomyRaw.exportSnapshot(),
      companionManager: this.#companionManagerRaw.exportSnapshot(),
      npcStore: this.#npcStoreRaw.exportSnapshot(),
      agentRegistry: this.#registryRaw.exportSnapshot(),
      career: this.#careerEntryPersistence === "transient"
        ? { mode: "transient" }
        : {
          mode: "complete",
          projection: this.#ensureCareerStore().exportPortableProjection(),
        },
      state: {
        activePlayerId: this.#activePlayerId,
        activeCharacterId: this.#activeCharacterRaw === null ? null : this.#activePlayerId,
        round: this.#roundRaw,
        dead: this.#ordinaryTerminal?.kind === "death",
        terminal: this.#ordinaryTerminalState(),
        combatActive: this.#combatActiveRaw,
        pendingCompoundMoves: [...this.#pendingCompoundMove.entries()].map(([pcId, value]) => ({
          pcId,
          originalInput: value.originalInput,
          originalIntent: structuredClone(value.originalIntent),
        })),
        pendingLeaveConfirm: this.#pendingLeaveConfirm,
        characters: [...this.#characters.entries()].map(([pcId, sheet]) => ({ pcId, sheet: normalizeOrdinaryCoCCharacterSheet(sheet) })),
        sanities: [...this.#sanityEngines.entries()].map(([pcId, san]) => ({ pcId, state: structuredClone(san.state) as unknown as OrdinarySnapshotJson })),
        party: [...this.#party.values()].map((member) => ({
          pcId: member.pcId,
          control: member.control,
          meta: member.meta ? structuredClone(member.meta) : null,
        })),
        sceneItems: [...this.#sceneItems.entries()].map(([sceneId, items]) => ({ sceneId, items: [...items] })),
        sceneDisplayNames: structuredClone(this.#sceneDisplayNames),
        sceneAliases: structuredClone(this.#sceneAliases),
        sceneBgm: structuredClone(this.#sceneBgm),
        lastNarrative: this.#lastNarrative,
        lastDiceRoll: this.#lastDiceRoll ? structuredClone(this.#lastDiceRoll) : null,
        lastRolls: structuredClone(this.#lastRolls),
        gameTime: { ...this.#gameTime },
activeDifficulty: this.#activeDifficulty?.label ?? null,
      skillGrowthMarksByPC: [...this.#skillGrowthMarksByPC.entries()]
          .filter(([, skills]) => skills.length > 0)
          .map(([pcId, skills]) => ({ pcId, skills: [...skills] })),
        skillMarks: structuredClone(this.#skillMarksRaw),
        woundsTreatedByPC: [...this.#woundsTreatedByPC],
        moduleStartByPC: [...this.#moduleStartByPC.entries()].map(([pcId, value]) => ({ pcId, ...value })),
        growthChangesByPC: [...this.#growthChangesByPC.entries()].map(([pcId, changes]) => ({ pcId, changes: [...changes] })),
        mythosSpells: [...this.#mythosSpells.entries()].map(([name, spell]) => ({ name, ...structuredClone(spell) })),
        moduleItemDescriptions: [...this.#moduleItemDescriptions.entries()].map(([id, description]) => ({ id, description })),
        moduleKpNotes: [...this.#moduleKpNotes.entries()].map(([id, note]) => ({ id, note })),
        moduleRewards: [...this.#moduleRewards.entries()].map(([id, reward]) => ({ id, reward: structuredClone(reward) as unknown as OrdinarySnapshotJson })),
        knownMythosSpells: [...this.#knownMythosSpells],
        lastPushedRoll: this.#lastPushedRoll ? structuredClone(this.#lastPushedRoll) : null,
        p1Persona: this.#p1Persona ? structuredClone(this.#p1Persona) : null,
        sightedMythos: [...this.#sightedMythos],
      },
    });
  }

  /**
   * Restore only into a newly-created, private-store target. Validation runs
   * to completion before any component is applied.  A later legacy installer
   * failure closes this replacement object, so callers must never publish it.
   */
  restoreOrdinarySessionSnapshot(
    input: unknown,
    /**
     * Trusted durable-host seam. Ordinary envelope recovery supplies a
     * predecessor-aware installer here; direct portable restore retains the
     * historic exact-replacement behavior below.
    */
    installCareerProjection?: (projection: CareerPortableProjection) => void,
  ): void {
    // An acknowledged ordinary object is the immutable durable envelope's
    // live representative.  Even an otherwise empty target must not be
    // repopulated through this public restore seam: that would retain the old
    // envelope identity while replacing the in-memory state beneath it.
    // Preserve this established restore-specific lifecycle diagnostic; every
    // other direct durable mutator shares the general closed-session guard.
    if (this.#npcStoreClosed) throw new Error("closed GameSession cannot restore an ordinary-session snapshot");
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledModule) throw new Error("compiled GameSession cannot restore an ordinary-session snapshot");
    if (!this.#hasSessionOwnedNpcStore) throw new Error("ordinary snapshot restore requires a private session-owned NPCStore");
    if (this.#activeActionTransactions !== 0 || this.#actingStatusesBeforeTick !== undefined || this.#turnMessages !== null) {
      throw new Error("ordinary snapshot restore is forbidden while an action is in flight");
    }
    if (!this.#isPristineOrdinaryRestoreTarget()) throw new Error("ordinary snapshot restore requires a pristine GameSession target");

    const snapshot = validateOrdinaryGameSessionSnapshot(input);
    if (snapshot.session.id !== this.#idRaw || snapshot.session.ruleset !== this.#activeRulesetRaw
      || !sameNullableOrdinaryAccessBinding(snapshot.session.access, this.#ordinarySessionAccess)) {
      throw new Error("ordinary snapshot identity, ruleset, or owner binding does not match its target");
    }

    try {
      if (snapshot.career.mode === "transient" && this.#careerEntryPersistence !== "transient") {
        throw new Error("transient Career snapshot cannot restore into a durable GameSession");
      }
      if (snapshot.module.package) {
        this.#installOrdinarySnapshotModule(snapshot.module.package);
        // Capture the package-installed truth before the snapshot's dynamic
        // WorldState replacement is allowed to touch this target.
        this.#assertInstalledOrdinaryModuleStatics(snapshot, this.#worldRaw.exportSnapshot());
      }

      // The installer builds immutable module indexes first.  The validated
      // component snapshots then replace its initial dynamic truth.
      this.#worldRaw.restoreSnapshot(snapshot.world);
      this.#playerSession.restoreSnapshot(snapshot.playerSession);
      this.#npcStoreRaw.restoreSnapshot(snapshot.npcStore);
      this.#registryRaw.restoreSnapshot(snapshot.agentRegistry);
      this.#companionManagerRaw.restoreSnapshot(snapshot.companionManager, this.#worldRaw);
      this.#politicoEconomyRaw.restoreSnapshot(snapshot.politicoEconomy);
      this.applyOrdinarySnapshotState(snapshot);
      this.restoreOrdinaryCareerProjection(snapshot, installCareerProjection);
      this.#createdAtRaw = snapshot.session.createdAt;
      this.#lastActiveAtRaw = snapshot.session.lastActiveAt;
    } catch (error) {
      // This target was contractually pristine/replacement-only.  Closing it is
      // fail-stopped and prevents a partially-applied store being published.
      this.#closeCanonical();
      // Preserve typed storage/recovery evidence for the trusted host that
      // owns this replacement target. The public session remains fail-stopped;
      // callers still must not inspect or publish this partially restored
      // object.
      throw new Error(
        `ordinary snapshot restore failed closed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private ordinarySnapshotModule(): OrdinaryGameSessionSnapshot["module"] {
    if (this.#registeredModules.length === 0 && this.#loadedModules.size === 0) return { package: null, contentHash: null };
    if (this.#registeredModules.length !== 1 || this.#loadedModules.size !== 1) {
      throw new Error("ordinary snapshot cannot represent multiple or inconsistent loaded modules");
    }
    const module = this.#registeredModules[0]!;
    if (!this.#loadedModules.get(module.id)) throw new Error("ordinary snapshot loadedModules/registeredModules disagree");
    const packageValue = normalizeOrdinaryRuntimeModulePackage(
      isModuleData(module) ? runtimeModuleDataLegacyPackage(module) : mythosLegacyPackage(module),
    );
    return { package: packageValue, contentHash: ordinaryGameSessionModuleHash(packageValue) };
  }

  #isPristineOrdinaryRestoreTarget(): boolean {
    const store = this.#npcStoreRaw.exportSnapshot();
    return this.#ordinaryDurableIdentity === null && !this.#compiledModule && this.#registeredModules.length === 0 && this.#loadedModules.size === 0
      && this.#roundRaw === 0 && this.#ordinaryTerminal?.kind !== "death" && this.#ordinaryTerminal === null && !this.#combatActiveRaw && this.#activePlayerId === "p1" && this.#activeCharacterRaw === null
      && this.#pendingCompoundMove.size === 0 && !this.#pendingLeaveConfirm && this.#characters.size === 0 && this.#party.size === 0
      && this.#sanityEngines.size === 1 && this.#sanityEngines.has("p1") && this.#playerSession.count === 1
      && this.#playerSession.getAllNames().length === 1 && this.#playerSession.get("p1") !== undefined
      && this.#playerSession.getPlayerHistory("p1").length === 0 && this.#lastNarrative === "" && this.#lastDiceRoll === null
      && this.#lastRolls.length === 0 && this.#sceneItems.size === 0 && Object.keys(this.#sceneDisplayNames).length === 0
      && Object.keys(this.#sceneAliases).length === 0 && Object.keys(this.#sceneBgm).length === 0
      && ![...this.#skillGrowthMarksByPC.values()].some((skills) => skills.length > 0)
      && Object.keys(this.#skillMarksRaw).length === 0 && this.#woundsTreatedByPC.size === 0 && this.#moduleStartByPC.size === 0
      && this.#growthChangesByPC.size === 0 && this.#mythosSpells.size === 0 && this.#moduleTomes.size === 0 && this.#modulePickupOrigins.size === 0 && this.#moduleItemDescriptions.size === 0
      && this.#moduleKpNotes.size === 0 && this.#moduleRewards.size === 0 && this.#knownMythosSpells.length === 0
      && this.#lastPushedRoll === null && this.#sightedMythos.size === 0 && this.#registryRaw.count === 0
      && store.sequences.npc_memories === 0 && store.tables.npc_personalities.length === 0 && store.tables.npc_memories.length === 0
      && store.tables.npc_relationships.length === 0 && store.tables.npc_states.length === 0;
  }

  #installOrdinarySnapshotModule(packageValue: RuntimeModulePackage): void {
    const installed = this.#installRuntimeModulePackage(packageValue);
    if (installed.kind === "compiled_bundle") throw new Error("compiled package cannot be restored into ordinary GameSession");
    const module = installed.module;
    if (installed.kind === "mythos_legacy") {
      const mythosModule = installed.module;
      if (mythosModule.sceneBgm) Object.assign(this.#sceneBgm, mythosModule.sceneBgm);
      for (const scene of this.#worldRaw.listScenes()) {
        if (!scene.name || scene.name === "unknown") continue;
        this.#sceneDisplayNames[scene.id] = scene.name;
        if (scene.description.length > 0) this.#sceneAliases[scene.id] = [scene.name];
      }
      if (mythosModule.sceneAliases) {
        for (const [sceneId, aliases] of Object.entries(mythosModule.sceneAliases)) {
          const current = this.#sceneAliases[sceneId] ?? [];
          for (const alias of aliases) if (!current.includes(alias)) current.push(alias);
          this.#sceneAliases[sceneId] = current;
        }
      }
    }
    this.#loadedModules.set(module.id, true);
    this.#registeredModules.push(module);
  }

  #assertInstalledOrdinaryModuleStatics(
    snapshot: OrdinaryGameSessionSnapshot,
    installedWorld: ReturnType<WorldStateManager["exportSnapshot"]>,
  ): void {
    const state = snapshot.state;
    const expectedSpells = new Map(this.#mythosSpells);
    const expectedDescriptions = [...this.#moduleItemDescriptions.entries()].map(([id, description]) => ({ id, description }));
    const expectedNotes = [...this.#moduleKpNotes.entries()].map(([id, note]) => ({ id, note }));
    const expectedRewards = [...this.#moduleRewards.entries()].map(([id, reward]) => ({ id, reward }));
    const snapshotSpells = new Map(state.mythosSpells.map(({ name, ...spell }) => [name, spell]));
    for (const [name, spell] of expectedSpells) {
      if (!snapshotSpells.has(name) || !samePortableJson(snapshotSpells.get(name), spell)) {
        throw new Error(`ordinary snapshot spell ${name} disagrees with its installable package`);
      }
    }
    if (!samePortableJson(state.moduleItemDescriptions, expectedDescriptions)
      || !samePortableJson(state.moduleKpNotes, expectedNotes) || !samePortableJson(state.moduleRewards, expectedRewards)
      || !samePortableJson(state.sceneDisplayNames, this.#sceneDisplayNames) || !samePortableJson(state.sceneAliases, this.#sceneAliases)
      || !samePortableJson(state.sceneBgm, this.#sceneBgm)) {
      throw new Error("ordinary snapshot module static state disagrees with its installable package");
    }
    this.#assertInstalledOrdinaryPickupState(snapshot);

    // Scene source content is package-owned.  Only active-scene selection and
    // visit records are dynamic; accepting a re-hashed altered description,
    // exit graph, or new scene would create a second module truth after the
    // installer has already proved the package identity.
    const installedScenes = new Map(installedWorld.tables.scenes.map((scene) => [scene.id, scene]));
    const snapshotScenes = new Map(snapshot.world.tables.scenes.map((scene) => [scene.id, scene]));
    if (installedScenes.size !== snapshotScenes.size) {
      throw new Error("ordinary snapshot source scene set disagrees with its installable package");
    }
    for (const [id, installed] of installedScenes) {
      const restored = snapshotScenes.get(id);
      if (!restored || !samePortableJson(
        {
          id: installed.id,
          name: installed.name,
          description: installed.description,
          lighting: installed.lighting,
          dangers: installed.dangers,
          exits: installed.exits,
        },
        {
          id: restored.id,
          name: restored.name,
          description: restored.description,
          lighting: restored.lighting,
          dangers: restored.dangers,
          exits: restored.exits,
        },
      )) {
        throw new Error(`ordinary snapshot source scene ${id} disagrees with its installable package`);
      }
    }

    // NPC/monster/item rows created by the package likewise keep their source
    // identity and capabilities.  Current HP, status, position, liveness, and
    // timestamps are play-state; name/type/max HP/AC/faction/attributes and
    // declared scene binding are package truth.  Player characters are
    // deliberately excluded because they are reconstructed from the portable
    // character sheet above rather than from a module.
    const installedEntities = new Map(installedWorld.tables.entities
      .filter((entity) => entity.type !== "pc")
      .map((entity) => [entity.id, entity]));
    const snapshotEntities = new Map(snapshot.world.tables.entities
      .filter((entity) => entity.type !== "pc")
      .map((entity) => [entity.id, entity]));
    if (installedEntities.size !== snapshotEntities.size) {
      throw new Error("ordinary snapshot source entity set disagrees with its installable package");
    }
    for (const [id, installed] of installedEntities) {
      const restored = snapshotEntities.get(id);
      if (!restored || !samePortableJson(
        {
          id: installed.id,
          name: installed.name,
          type: installed.type,
          max_hp: installed.max_hp,
          ac: installed.ac,
          faction: installed.faction,
          attributes: installed.attributes,
          scene_id: installed.scene_id,
        },
        {
          id: restored.id,
          name: restored.name,
          type: restored.type,
          max_hp: restored.max_hp,
          ac: restored.ac,
          faction: restored.faction,
          attributes: restored.attributes,
          scene_id: restored.scene_id,
        },
      )) {
        throw new Error(`ordinary snapshot source entity ${id} disagrees with its installable package`);
      }
    }

    // Discovery IDs and their bounded-failure counters are runtime facts, but
    // their *names* must be declared by the freshly installed package.  The
    // WorldState schema intentionally stays document-agnostic, so this binding
    // belongs at the package/session boundary rather than its generic table
    // validator.
    const packageClueIds = new Set(this.#investigationRaw.listModuleClueIds());
    const packageSceneIds = new Set(installedScenes.keys());
    for (const discovery of snapshot.world.tables.clue_discoveries) {
      if (!packageClueIds.has(discovery.clue_id)) {
        throw new Error(`ordinary snapshot discovery ${discovery.clue_id} has no installable package source`);
      }
    }
    for (const failure of snapshot.world.tables.clue_fail_counts) {
      if (!packageClueIds.has(failure.clue_id)) {
        throw new Error(`ordinary snapshot clue failure ${failure.clue_id} has no installable package source`);
      }
    }
    for (const visit of snapshot.world.tables.scene_visits) {
      if (!packageSceneIds.has(visit.scene_id)) {
        throw new Error(`ordinary snapshot scene visit ${visit.scene_id} has no installable package source`);
      }
    }
  }

  /**
   * Package placements are static only until a player actually acquires them.
   * A portable snapshot therefore proves a conservation rule per declared
   * origin: it appears once in its declared scene, or once in one real player
   * inventory—never both, nowhere else, and never nowhere.  Non-pickup scene
   * entries remain exact package statics.
   */
  #assertInstalledOrdinaryPickupState(snapshot: OrdinaryGameSessionSnapshot): void {
    const installed = new Map(this.#sceneItems.entries());
    const restored = new Map<string, string[]>();
    for (const entry of snapshot.state.sceneItems) {
      if (restored.has(entry.sceneId)) throw new Error(`ordinary snapshot repeats scene items for ${entry.sceneId}`);
      restored.set(entry.sceneId, entry.items);
    }
    if (installed.size !== restored.size || [...installed.keys()].some((sceneId) => !restored.has(sceneId))) {
      throw new Error("ordinary snapshot scene item set disagrees with its installable package");
    }

    const mutableNames = new Set(this.#modulePickupOrigins.keys());
    for (const [sceneId, installedItems] of installed) {
      const restoredItems = restored.get(sceneId)!;
      const installedStatic = installedItems.filter((name) => !mutableNames.has(name));
      const restoredStatic = restoredItems.filter((name) => !mutableNames.has(name));
      if (!samePortableJson(installedStatic, restoredStatic)) {
        throw new Error(`ordinary snapshot static state disagrees: scene items for ${sceneId}`);
      }
    }

    // A PlayerSession slot and its canonical world player_state exist before
    // character creation.  The snapshot validator has already established
    // `name === characterId` for these entries, so this remains the canonical
    // identity boundary while allowing a valid pre-character session.
    const realPlayers = new Set(snapshot.playerSession.players.map((entry) => entry.characterId));
    const sourcePlayerState = snapshot.world.tables.player_state
      .filter((state) => realPlayers.has(state.entity_id));
    if (sourcePlayerState.length !== snapshot.world.tables.player_state.length) {
      throw new Error("ordinary snapshot pickup inventory belongs to a non-player");
    }
    for (const origin of this.#modulePickupOrigins.values()) {
      let sceneCount = 0;
      for (const [sceneId, items] of restored) {
        const count = items.filter((item) => item === origin.name).length;
        if (count > 0 && sceneId !== origin.sceneId) {
          throw new Error(`ordinary snapshot pickup ${origin.name} moved to an undeclared scene`);
        }
        sceneCount += count;
      }
      const inventoryCount = sourcePlayerState.reduce(
        (count, state) => count + state.inventory.filter((item) => item === origin.name).length,
        0,
      );
      if (sceneCount + inventoryCount !== 1) {
        throw new Error(`ordinary snapshot pickup ${origin.name} is not conserved between source scene and player inventory`);
      }
    }
  }

  private applyOrdinarySnapshotState(snapshot: OrdinaryGameSessionSnapshot): void {
    const state = snapshot.state;
    const restoredCharacters = new Map(state.characters.map((entry) => [entry.pcId, structuredClone(entry.sheet)]));
    const restoredSanities = new Map<string, SanityEngine>();
    for (const entry of state.sanities) {
      const sheet = restoredCharacters.get(entry.pcId) as { attributes?: { power?: number } } | undefined;
      const sanity = new SanityEngine(sheet?.attributes?.power ?? 50);
      sanity.restoreState(entry.state);
      restoredSanities.set(entry.pcId, sanity);
    }
    this.#characters = restoredCharacters;
    this.#sanityEngines = restoredSanities;
    this.#party = new Map(state.party.map((entry) => {
      const sheet = restoredCharacters.get(entry.pcId);
      const san = restoredSanities.get(entry.pcId);
      if (!sheet || !san) throw new Error(`restored party ${entry.pcId} lost its shared references`);
      return [entry.pcId, { pcId: entry.pcId, sheet, san, control: entry.control, ...(entry.meta ? { meta: structuredClone(entry.meta) as PlayerMeta } : {}) }];
    }));
    this.#activePlayerId = state.activePlayerId;
    this.#installActiveCharacter(state.activeCharacterId === null ? null : restoredCharacters.get(state.activeCharacterId) ?? null);
    this.#installSanityEngine(restoredSanities.get(state.activePlayerId)!);
    this.#roundRaw = state.round;
    // The hostile snapshot validator already proved the public compatibility
    // death view agrees with this discriminant. Do not restore a second
    // mutable boolean authority.
    this.#setOrdinaryTerminal(state.terminal);
    this.#combatActiveRaw = state.combatActive;
    this.#pendingCompoundMove = new Map(state.pendingCompoundMoves.map((entry) => [entry.pcId, {
      originalInput: entry.originalInput,
      originalIntent: structuredClone(entry.originalIntent) as unknown as ActionIntent,
    }]));
    this.#pendingLeaveConfirm = state.pendingLeaveConfirm;
    // Package-owned declarations were reinstalled and then conservatively
    // compared before this method runs. Their physical placement is dynamic:
    // an accepted pickup has moved the sole copy into a real player inventory.
    // Rehydrate that verified placement instead of leaving the install-time
    // static map beside the restored inventory as a second copy.
    this.#sceneItems = new Map(state.sceneItems.map((entry) => [entry.sceneId, [...entry.items]]));
    if (!snapshot.module.package) {
      this.#sceneDisplayNames = structuredClone(state.sceneDisplayNames);
      this.#sceneAliases = structuredClone(state.sceneAliases);
      this.#sceneBgm = structuredClone(state.sceneBgm);
      this.#moduleItemDescriptions = new Map(state.moduleItemDescriptions.map((entry) => [entry.id, entry.description]));
      this.#moduleKpNotes = new Map(state.moduleKpNotes.map((entry) => [entry.id, entry.note]));
      this.#moduleRewards = new Map(state.moduleRewards.map((entry) => [entry.id, structuredClone(entry.reward) as unknown as RuntimeModuleReward]));
    }
    // Tome learning can add a spell not present in the module package.  Preserve
    // that strictly-validated dynamic superset while keeping legacy-loader map
    // references alive.
    this.#mythosSpells.clear();
    for (const entry of state.mythosSpells) {
      const { name, ...spell } = entry;
      this.#mythosSpells.set(name, spell);
    }
    this.#lastNarrative = state.lastNarrative;
    this.#lastDiceRoll = state.lastDiceRoll ? structuredClone(state.lastDiceRoll) : null;
    this.#lastRolls = structuredClone(state.lastRolls);
    this.#gameTime = { ...state.gameTime } as GameTime;
this.#activeDifficulty = state.activeDifficulty ? getDifficultyProfile(state.activeDifficulty) : null;
this.#investigationRaw.setDifficultyProfile(this.#activeDifficulty);
    this.#skillGrowthMarksByPC = new Map(state.skillGrowthMarksByPC.map((entry) => [entry.pcId, [...entry.skills]]));
    this.replaceSkillMarks(state.skillMarks);
    this.#woundsTreatedByPC = new Set(state.woundsTreatedByPC);
    this.#moduleStartByPC = new Map(state.moduleStartByPC.map((entry) => [entry.pcId, { san: entry.san, cm: entry.cm }]));
    this.#growthChangesByPC = new Map(state.growthChangesByPC.map((entry) => [entry.pcId, [...entry.changes]]));
    this.#knownMythosSpells.splice(0, this.#knownMythosSpells.length, ...state.knownMythosSpells);
    this.#lastPushedRoll = state.lastPushedRoll ? structuredClone(state.lastPushedRoll) : null;
    this.#p1Persona = state.p1Persona === null ? undefined : structuredClone(state.p1Persona) as PlayerMeta;
    this.#sightedMythos.clear();
    for (const sighting of state.sightedMythos) this.#sightedMythos.add(sighting);
  }

  /**
   * Current snapshots replace all session-local career data exactly.  Verified
   * 1.0/1.1 migrations intentionally carry only bases, so they refresh those
   * bases without discarding target-local history they never represented.
   */
  private restoreOrdinaryCareerProjection(
    snapshot: OrdinaryGameSessionSnapshot,
    installCareerProjection?: (projection: CareerPortableProjection) => void,
  ): void {
    if (snapshot.career.mode === "complete") {
      if (installCareerProjection) installCareerProjection(snapshot.career.projection);
      else this.#ensureCareerStore().replacePortableProjection(snapshot.career.projection);
      return;
    }
    if (snapshot.career.mode === "transient") {
      if (this.#careerEntryPersistence !== "transient") {
        throw new Error("transient Career snapshot cannot restore into a durable GameSession");
      }
      return;
    }
    for (const [pcId, sheet] of this.#characters) {
      const sanity = this.#sanityEngines.get(pcId);
      if (!sanity) throw new Error(`restored character ${pcId} lacks sanity for its career projection`);
      this.#persistCareerSnapshot(sheet, sanity);
    }
  }

  #compiledMutationBlocked(): boolean {
    return this.#isDurableCompiledSession() && !this.#installingCompiledState;
  }

  #isPristineDurableCompiledSession(): boolean {
    return !this.#compiledModule && this.#registeredModules.length === 0 && this.#roundRaw === 0 && this.#ordinaryTerminal?.kind !== "death" && !this.#combatActiveRaw
      && this.#playerSession.count === 1 && this.#playerSession.getAllNames().length === 1 && this.#playerSession.get("p1") !== undefined
      && this.#party.size === 1 && this.#party.has("p1") && this.#characters.size === 1 && this.#characters.has("p1")
      && this.#sanityEngines.size === 1 && this.#sanityEngines.has("p1") && this.#playerSession.getPlayerHistory("p1").length === 0
      && this.#lastNarrative === "" && this.#lastDiceRoll === null && this.#lastRolls.length === 0;
  }

  #isPristineCompiledRestoreTarget(): boolean {
    return !this.#compiledModule && this.#registeredModules.length === 0 && this.#roundRaw === 0 && this.#ordinaryTerminal?.kind !== "death" && !this.#combatActiveRaw
      && this.#playerSession.count === 1 && this.#playerSession.get("p1") !== undefined && this.#playerSession.getPlayerHistory("p1").length === 0
      && this.#lastNarrative === "" && this.#lastDiceRoll === null && this.#lastRolls.length === 0;
  }

  #persistedCompiledCharacterSheet(sheet: any): JsonRecord {
    if (!sheet) throw new Error("durable compiled sessions require p1 character data");
    const keys = ["name", "archetypeId", "attributes", "luck", "hp", "maxHp", "ac", "damageBonus", "build", "move", "creditRating", "startingItems", "occupationSkillPoints", "interestSkillPoints", "occupationSkills", "availableSkills", "age", "valid", "warnings", "cthulhuMythos", "skillValues"] as const;
    return cloneJson(Object.fromEntries(keys.map((key) => [key, sheet[key]])) as JsonRecord);
  }

  #compiledSnapshotCharacter(sheet: any, sanity: SanityEngine): { pcId: "p1"; sheet: JsonRecord; sanity: JsonRecord } {
    return {
      pcId: "p1",
      sheet: this.#persistedCompiledCharacterSheet(sheet),
      sanity: cloneJson(JSON.parse(JSON.stringify(sanity.state)) as JsonRecord),
    };
  }

  #compiledState(
    payload: ResolvedCompilerArtifactPayload,
    projection: CompilerModuleDataProjection,
    state: MechanicsState,
    trace: MechanicsReachabilityEdge[],
    generation: number,
  ): CompiledMechanicsSessionState {
    const endingId = state.terminalEndingId;
    const ending = endingId ? projection.module.endings.find((candidate) => candidate.id === endingId) : undefined;
    return {
      moduleId: payload.identity.moduleId,
      artifactHash: projection.artifact.artifactHash,
      mechanicsHash: payload.mechanicsIR.mechanicsHash,
      state: structuredClone(state),
      stateHash: mechanicsStateHash(state),
      trace: structuredClone(trace),
      ...(ending ? { terminalEnding: { id: ending.id, name: ending.name, narration: ending.description } } : {}),
      generation,
    };
  }

  /** Builds the complete durable form; only the host authority can call this. */
  #createCompiledSessionSnapshotCanonical(): CompiledSessionSnapshot {
    const compiled = this.#compiledModule;
    if (!compiled?.durableBundle || this.#compiledGeneration === null) throw new Error("compiled session has no durable catalog bundle identity");
    return this.#makeCompiledSnapshot({
      state: compiled.state,
      trace: compiled.trace,
      round: this.#roundRaw,
      lastActiveAt: this.#lastActiveAtRaw,
      history: this.#playerSession.getPlayerHistory("p1"),
      generation: this.#compiledGeneration,
      idempotency: [...this.#compiledIdempotency.values()],
      character: this.#compiledSnapshotCharacter(this.#characters.get("p1"), this.#sanityEngines.get("p1") ?? this.#sanityRaw),
    });
  }

  /** Records the current durable pointer only after the snapshot store atomically publishes its header. */
  #acknowledgeCompiledSnapshotCanonical(snapshot: CompiledSessionSnapshot): void {
    const compiled = this.#compiledModule;
    if (!compiled?.durableBundle || this.#compiledGeneration === null || snapshot.sessionId !== this.#idRaw || snapshot.generation !== this.#compiledGeneration || snapshot.bundle.id !== compiled.durableBundle.id) {
      throw new Error("published snapshot does not match the live durable session");
    }
    const canonical = this.#createCompiledSessionSnapshotCanonical();
    if (canonicalJson(snapshot) !== canonicalJson(canonical)) {
      throw new Error("published snapshot is not the live durable session snapshot");
    }
    compiled.snapshotHash = canonical.snapshotHash;
  }


  #makeCompiledSnapshot(input: {
    state: MechanicsState;
    trace: MechanicsReachabilityEdge[];
    round: number;
    lastActiveAt: number;
    history: AgentMessage[];
    generation: number;
    idempotency: CompiledSessionIdempotencyRecord[];
    character: { pcId: "p1"; sheet: JsonRecord; sanity: JsonRecord };
  }): CompiledSessionSnapshot {
    const compiled = this.#compiledModule;
    if (!compiled?.durableBundle) throw new Error("compiled snapshot requires a catalog bundle ID");
    if (!compiled.initialCharacter) throw new Error("compiled snapshot requires an immutable initial character");
    const previousSnapshotHash: string | null = input.generation === 0 ? null : compiled.snapshotHash ?? null;
    if (input.generation > 0 && !previousSnapshotHash) throw new Error("compiled snapshot is missing its durable predecessor");
    const terminal = this.#compiledState(compiled.payload, compiled.projection, input.state, input.trace, input.generation).terminalEnding ?? null;
    const snapshot = {
      schemaVersion: COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION,
      components: COMPILED_SESSION_COMPONENT_VERSIONS,
      sessionId: this.#idRaw,
      access: compiled.access ? structuredClone(compiled.access) : null,
      bundle: {
        id: compiled.durableBundle.id,
        moduleId: compiled.payload.identity.moduleId,
        artifactHash: compiled.projection.artifact.artifactHash,
        mechanicsHash: compiled.payload.mechanicsIR.mechanicsHash,
        bundleHash: compiled.durableBundle.bundleHash,
      },
      previousSnapshotHash,
      generation: input.generation,
      timestamps: { createdAt: this.#createdAtRaw, lastActiveAt: input.lastActiveAt },
      round: input.round,
      initialCharacter: cloneJson(compiled.initialCharacter),
      character: {
        pcId: input.character.pcId,
        sheet: cloneJson(input.character.sheet),
        sanity: cloneJson(input.character.sanity),
      },
      history: cloneJson(JSON.parse(JSON.stringify(input.history)) as JsonValue[]),
      state: structuredClone(input.state),
      stateHash: mechanicsStateHash(input.state),
      trace: structuredClone(input.trace),
      terminal,
      idempotency: cloneJson(JSON.parse(JSON.stringify(input.idempotency)) as JsonValue[]) as unknown as CompiledSessionIdempotencyRecord[],
      snapshotHash: "",
    } satisfies Omit<CompiledSessionSnapshot, "snapshotHash"> & { snapshotHash: string };
    snapshot.snapshotHash = compiledSessionSnapshotHash(snapshot);
    const validated = validateCompiledSessionSnapshot(snapshot);
    if (validated.status === "refused") throw new Error(validated.message);
    return validated.value;
  }

  /** Validation-only boundary used by startup before a GameSession is constructed or any world is touched. */
  static validateCompiledSessionRestore(
    snapshotValue: unknown,
    catalogBundle: LoadedBundleCatalogEntry,
    expectedSessionId?: string,
  ): { status: "validated"; snapshot: CompiledSessionSnapshot; state: MechanicsState; budget: MechanicsStateBudget }
    | { status: "refused"; code: "COMPILED_ARTIFACT_INVALID" | "COMPILED_PROJECTION_INVALID"; message: string } {
    let catalogHashMatches = false;
    try { catalogHashMatches = catalogBundle.bundleHash === compiledBundleCatalogHash(catalogBundle); }
    catch { return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "snapshot catalog bundle cannot be attested" }; }
    if (!catalogHashMatches) return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "snapshot catalog bundle hash does not match its contents" };
    const bundle = validateCompiledModuleBundle(catalogBundle.artifact, catalogBundle.projection);
    if (bundle.status === "refused") return bundle;
    if (catalogBundle.worldModelBinding !== undefined) {
      try {
        assertCompiledCthulhuWorldModelBindingArtifactIdentity(catalogBundle.worldModelBinding, {
          moduleId: bundle.payload.identity.moduleId,
          artifactHash: bundle.artifactHash,
        });
        validateCompiledCthulhuWorldModelBinding(catalogBundle.worldModelBinding);
      } catch (error) {
        return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: error instanceof Error ? error.message : "snapshot world-model binding is invalid" };
      }
    }
    const snapshot = validateCompiledSessionSnapshot(snapshotValue);
    if (snapshot.status === "refused") return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: snapshot.message };
    const value = snapshot.value;
    if ((expectedSessionId !== undefined && value.sessionId !== expectedSessionId)
      || value.bundle.id !== catalogBundle.id || value.bundle.bundleHash !== catalogBundle.bundleHash
      || value.bundle.moduleId !== bundle.payload.identity.moduleId
      || value.bundle.artifactHash !== bundle.artifactHash
      || value.bundle.mechanicsHash !== bundle.payload.identity.mechanicsHash) {
      return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "snapshot bundle identity does not match the revalidated catalog bundle" };
    }
    const replay = replayCompiledSessionTrace(bundle.payload, value.trace);
    if (replay.status === "refused" || mechanicsStateHash(replay.value.state) !== value.stateHash || canonicalJson(replay.value.state) !== canonicalJson(value.state)) {
      return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: replay.status === "refused" ? replay.message : "snapshot final mechanics state does not match its replay" };
    }
    const endingId = replay.value.state.terminalEndingId;
    const ending = endingId ? bundle.projection.module.endings.find((candidate) => candidate.id === endingId) : undefined;
    if ((endingId && (!ending || canonicalJson(value.terminal) !== canonicalJson({ id: ending.id, name: ending.name, narration: ending.description })))
      || (!endingId && value.terminal !== null)) {
      return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "snapshot terminal narration identity does not match the catalog projection" };
    }
    if (value.generation !== replay.value.playerActions.length || value.round !== value.generation || value.idempotency.length !== value.generation) {
      return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "snapshot generation, round, or idempotency ledger does not match replayed player actions" };
    }
    let historyOffset = 0;
    let temporalSheet = cloneJson(value.initialCharacter.sheet);
    let temporalSanity = cloneJson(value.initialCharacter.sanity);
    let pendingSkillGrowth: string[] = [];
    // 3.3 retained the 1.5 response contract exactly.  Its persisted bytes
    // stay legacy when read, but its growth/narration semantics are not
    // downgraded merely because 3.4 added the idempotency topic anchor.
    const hasGrowthReceipts = value.schemaVersion === COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
      || value.schemaVersion === "3.3.0" || value.schemaVersion === "3.2.0";
    const supportsProviderNarration = value.schemaVersion === COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
      || value.schemaVersion === "3.3.0";
    let previousRewardIds = settleInitialMechanics(bundle.payload.mechanicsIR, bundle.payload.analysisInput).state.rewardIds;
    for (const [index, record] of value.idempotency.entries()) {
      const action = replay.value.playerActions[index]!;
      const generation = index + 1;
      const narrationMode: CompiledActionNarrationMode = supportsProviderNarration
        && (record.response.action as Record<string, unknown>).playerNarration !== undefined
        ? "provider"
        : "mechanics";
      const expectedHash = supportsProviderNarration
        ? compiledActionRequestHash(record.input, record.actionId, record.expectedGeneration, narrationMode)
        : legacyCompiledActionRequestHash(record.input, record.actionId, record.expectedGeneration);
      if (record.generation !== generation || record.expectedGeneration !== generation - 1 || record.requestHash !== expectedHash || !validatePersistedCompiledActionResponse(record.response)
        || parseCompiledMechanicsAction(record.input) !== action.edge.mechanismId) {
        return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "snapshot idempotency ledger is incomplete or does not bind its player-action edge" };
      }
      if (canonicalJson(record.characterBefore.sanity) !== canonicalJson(temporalSanity)
        || canonicalJson(record.characterBefore.sheet) !== canonicalJson(temporalSheet)) {
        return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "persisted action character frame breaks the temporal reward chain" };
      }
      temporalSheet = cloneJson(record.characterBefore.sheet);
      const responseAction = record.response.action as Record<string, unknown>;
      const responseCompiled = responseAction.compiled as Record<string, unknown>;
      const responseState = responseAction.state as Record<string, unknown>;
      const responseSummary = record.response.summary;
      const responsePlayer = responseState.player as Record<string, unknown>;
      const responseSanity = responseAction.sanity as Record<string, unknown>;
      const responseParty = responseState.party as Array<Record<string, unknown>>;
      let expectedSanitySettlement: { sanity: JsonRecord; settlements: SanityCheckSettlement[] };
      let expectedRewardSettlement: { sheet: JsonRecord; sanity: JsonRecord; settlements: TerminalRewardSettlement[] };
      let expectedGrowth: { character: JsonRecord; receipt: CompiledSkillGrowthReceipt; lines: string[] } | undefined;
      let checkedCharacter: JsonRecord;
      try {
        const persistedCombatSettlement = responseAction.combatSettlement;
        if (action.edge.outcome === "attack") {
          temporalSheet = validateCompiledCombatSettlement(persistedCombatSettlement, action, bundle.payload.mechanicsIR, bundle.projection, temporalSheet, generation).sheet;
        } else if (persistedCombatSettlement !== undefined) {
          throw new Error("non-combat action carries a combat settlement");
        }
        if (action.actorEffects.some((effect) => effect.outcome !== action.edge.outcome)) throw new Error("replayed actor SAN effect branch does not match its action edge");
        expectedSanitySettlement = replaySanityCheckSettlements(value.sessionId, bundle.payload.mechanicsIR, action.edge.beforeStateHash, generation, action.edge.mechanismId, action.actorEffects, temporalSanity);
        // The checked roll was resolved before this generation's terminal growth settlement.
        checkedCharacter = cloneJson(temporalSheet);
        if (hasGrowthReceipts) {
          const successful = new Set<string>();
          const growthDiscovery = bundle.payload.mechanicsIR.discoveryMethods.find((candidate) => candidate.id === action.edge.mechanismId);
          if (action.edge.outcome === "success" && growthDiscovery?.check?.kind === "skill") {
            const storageKey = resolveCoCSkillGrowthStorageKey(growthDiscovery.check.skill, temporalSheet);
            if (isGrowableCoCSkill(temporalSheet, storageKey)) successful.add(storageKey);
          }
          if (action.edge.outcome === "attack") {
            const combat = persistedCombatSettlement as CompiledCombatSettlement;
            if (combat.player.hit && isGrowableCoCSkill(temporalSheet, "fighting")) successful.add("fighting");
            if (combat.enemy && !combat.enemy.hit && combat.enemy.defenseRoll !== null
              && !["fail", "fumble"].includes(cocSuccessLevelForRoll(combat.enemy.defenseRoll, combat.enemy.targetDodge))
              && isGrowableCoCSkill(temporalSheet, "dodge")) successful.add("dodge");
          }
          const successfulSkills = [...successful].sort();
          const pendingBefore = [...pendingSkillGrowth].sort();
          const merged = [...new Set([...pendingBefore, ...successfulSkills])].sort();
          const character = cloneJson(temporalSheet);
          const terminalEndingId = action.state.terminalEndingId ?? null;
          const settlements: CompiledSkillGrowthSettlement[] = [];
          const lines: string[] = [];
          if (terminalEndingId !== null) for (const skill of merged) {
            const outcome = applyCoCSkillGrowth(character, skill, compiledSkillGrowthRandom(value.sessionId, bundle.payload.identity.mechanicsHash, action.edge.beforeStateHash, generation, action.edge.mechanismId, skill));
            settlements.push({ ...outcome });
            lines.push(outcome.increased
              ? `${character.name} ${outcome.display}: d100=${outcome.roll} > ${outcome.currentSkill}% => growth +${outcome.increase}%`
              : `${character.name} ${outcome.display}: d100=${outcome.roll} <= ${outcome.currentSkill}% => no growth`);
          }
          expectedGrowth = { character, lines, receipt: {
            schemaVersion: "1.0.0", generation, mechanismId: action.edge.mechanismId,
            beforeStateHash: action.edge.beforeStateHash, afterStateHash: action.edge.afterStateHash,
            sourceInterpretationIds: [...action.edge.sourceInterpretationIds].sort(), successfulSkills,
            pendingBefore, pendingAfter: terminalEndingId === null ? merged : [], terminalEndingId, settlements,
          } };
          if (canonicalJson(responseAction.skillGrowthReceipt) !== canonicalJson(expectedGrowth.receipt)) throw new Error("compiled skill-growth receipt is not reproducible");
          pendingSkillGrowth = [...expectedGrowth.receipt.pendingAfter];
          temporalSheet = expectedGrowth.character;
        }
        expectedRewardSettlement = replayTerminalRewardSettlements(
          bundle.payload.mechanicsIR,
          action.edge.beforeStateHash,
          previousRewardIds,
          action.state.rewardIds,
          temporalSheet,
          expectedSanitySettlement.sanity,
        );
      } catch (error) {
        return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: error instanceof Error ? error.message : "reward settlement cannot be replayed" };
      }
      const persistedRewardSettlements = responseAction.rewardSettlements;
      const persistedSanitySettlements = responseAction.sanityCheckSettlements;
      const expectedTerminal = action.state.terminalEndingId ? bundle.projection.module.endings.find((candidate) => candidate.id === action.state.terminalEndingId) : undefined;
      const expectedLoss = action.state.terminalLoss ? bundle.projection.module.npcs.find((candidate) => candidate.id === action.state.terminalLoss!.combatantId) : undefined;
      if (action.state.terminalLoss && !expectedLoss) return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "terminal combat loss lacks its trusted NPC identity" };
      const discovery = bundle.payload.mechanicsIR.discoveryMethods.find((candidate) => candidate.id === action.edge.mechanismId);
      const checkedAction = discovery?.check && discovery.check.kind !== "none" && (action.edge.outcome === "success" || action.edge.outcome === "failure")
        ? discovery.check as Exclude<CheckSpec, { kind: "none" }>
        : undefined;
      const responseDice = responseAction.dice as Array<Record<string, unknown>> | undefined;
      const diceTotal = responseDice?.[0]?.total;
      const checkDescriptor = checkedAction ? compiledCheckDescriptor(checkedAction, checkedCharacter) : undefined;
      const checkSucceeded = checkedAction && typeof diceTotal === "number"
        ? compiledCheckSucceeded(diceTotal, checkDescriptor!.target, checkedAction.difficulty)
        : undefined;
      const checkBindingValid = checkedAction
        ? responseDice?.length === 1 && responseDice[0]?.expr === "d100" && responseDice[0]?.total === diceTotal && responseDice[0]?.detail === `${checkDescriptor!.label}/${checkedAction.difficulty}`
          && (checkSucceeded ? action.edge.outcome === "success" : action.edge.outcome === "failure")
        : responseDice === undefined;
      const expectedEvents = [
        { speaker: temporalSheet.name, content: record.input, type: "action" },
        ...(checkedAction && typeof diceTotal === "number" ? [{ speaker: "系统", content: `🎲 ${checkDescriptor!.label} ${checkedAction.difficulty} 检定 d100=${diceTotal} (目标=${checkDescriptor!.target}%) → ${checkSucceeded ? "成功" : "失败"}`, type: "system" }] : []),
        { speaker: "系统", content: `编译机制 ${action.edge.mechanismId}:${action.edge.outcome}`, type: "system" },
        ...(expectedGrowth?.lines.map((content) => ({ speaker: "系统", content, type: "system" })) ?? []),
        ...(expectedTerminal ? [{ speaker: "系统", content: `编译结局 ${expectedTerminal.id}: ${expectedTerminal.name}`, type: "system" }] : []),
        ...(expectedLoss ? [{ speaker: "系统", content: `编译战斗败北: ${expectedLoss.name}`, type: "system" }] : []),
      ];
      const persistedEvents = responseAction.events as Array<Record<string, unknown>>;
      const historyEvents = value.history.slice(historyOffset, historyOffset + expectedEvents.length).map((message) => {
        const entry = message as Record<string, unknown>;
        return { speaker: entry.speaker, content: entry.content, type: entry.type };
      });
      const expectedScene = bundle.projection.module.scenes.find((scene) => scene.id === action.state.currentSceneId)?.name ?? action.state.currentSceneId;
      const expectedItems = compiledProjectionItemView(bundle.projection, action.state, action.state.currentSceneId);
      const initialGameTime = createGameTime();
      const responseGameTime = responseState.gameTime as Record<string, unknown>;
      if (record.response.generation !== generation || responseCompiled.generation !== generation || responseCompiled.moduleId !== bundle.payload.identity.moduleId
        || responseCompiled.artifactHash !== bundle.artifactHash || responseCompiled.mechanicsHash !== bundle.payload.identity.mechanicsHash
        || responseCompiled.stateHash !== mechanicsStateHash(action.state) || canonicalJson(responseCompiled.state) !== canonicalJson(action.state)
        || canonicalJson(responseCompiled.trace) !== canonicalJson(value.trace.slice(0, action.traceLength))
        || canonicalJson(responseCompiled.terminalEnding ?? null) !== canonicalJson(expectedTerminal ? { id: expectedTerminal.id, name: expectedTerminal.name, narration: expectedTerminal.description } : null)
        || responseState.scene !== action.state.currentSceneId || responseState.round !== generation
        || responseSummary.id !== value.sessionId || responseSummary.ruleset !== "cosmic-horror" || responseSummary.scene !== expectedScene || responseSummary.playerName !== expectedRewardSettlement.sheet.name || responseSummary.archetype !== expectedRewardSettlement.sheet.archetypeId || responseSummary.createdAt !== value.timestamps.createdAt || responseSummary.generation !== generation || responseSummary.round !== generation || responseSummary.messageCount !== historyOffset + expectedEvents.length || responseSummary.npcCount !== bundle.projection.module.npcs.length
        || responsePlayer.name !== expectedRewardSettlement.sheet.name || responsePlayer.hp !== expectedRewardSettlement.sheet.hp || responsePlayer.maxHp !== expectedRewardSettlement.sheet.maxHp || responsePlayer.ac !== 0 || canonicalJson(responsePlayer.status) !== canonicalJson([])
        || responseSanity.currentSAN !== expectedRewardSettlement.sanity.currentSAN || responseSanity.maxSAN !== expectedRewardSettlement.sanity.maxSAN || responseSanity.temporaryInsanity !== expectedRewardSettlement.sanity.temporaryInsanity || responseSanity.indefiniteInsanity !== expectedRewardSettlement.sanity.indefiniteInsanity || responseSanity.indefiniteLevel !== expectedRewardSettlement.sanity.indefiniteLevel || canonicalJson(responseSanity.phobias) !== canonicalJson(expectedRewardSettlement.sanity.phobias) || canonicalJson(responseSanity.manias) !== canonicalJson(expectedRewardSettlement.sanity.manias)
        || responseAction.dead !== !!expectedLoss || responseState.bgm !== undefined || canonicalJson(responseState.npcs) !== canonicalJson(compiledProjectionNpcView(bundle.projection, bundle.payload.mechanicsIR, action.state.currentSceneId)) || canonicalJson(responseState.monsters) !== canonicalJson(compiledProjectionMonsterView(bundle.projection, bundle.payload.mechanicsIR, action.state, action.state.currentSceneId)) || canonicalJson(responseState.companions) !== canonicalJson([])
        || canonicalJson(responseState.inventory) !== canonicalJson(expectedItems.inventory) || canonicalJson(responseState.sceneItems) !== canonicalJson(expectedItems.sceneItems)
        || responseGameTime.day !== initialGameTime.day || responseGameTime.period !== initialGameTime.period || responseGameTime.label !== formatGameTime(initialGameTime)
        || responseParty.length !== 1 || responseParty[0]?.pcId !== "p1" || responseParty[0]?.name !== expectedRewardSettlement.sheet.name || responseParty[0]?.hp !== expectedRewardSettlement.sheet.hp || responseParty[0]?.maxHp !== expectedRewardSettlement.sheet.maxHp || responseParty[0]?.san !== expectedRewardSettlement.sanity.currentSAN || responseParty[0]?.maxSan !== expectedRewardSettlement.sanity.maxSAN || canonicalJson(responseParty[0]?.status) !== canonicalJson([])
        || canonicalJson(persistedSanitySettlements) !== canonicalJson(expectedSanitySettlement.settlements)
        || canonicalJson(persistedRewardSettlements ?? null) !== canonicalJson(expectedRewardSettlement.settlements.length ? expectedRewardSettlement.settlements : null)
        || responseAction.narrative !== (expectedTerminal ? expectedTerminal.description : expectedLoss ? `You are defeated by ${expectedLoss.name}.` : `已执行编译机制 ${action.edge.mechanismId}。`)
        || !checkBindingValid || canonicalJson(persistedEvents) !== canonicalJson(expectedEvents) || canonicalJson(historyEvents) !== canonicalJson(expectedEvents)) {
        return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "persisted action response does not match its replayed generation" };
      }
      temporalSheet = expectedRewardSettlement.sheet;
      temporalSanity = expectedRewardSettlement.sanity;
      previousRewardIds = action.state.rewardIds;
      historyOffset += expectedEvents.length;
    }
    if (historyOffset !== value.history.length) return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "snapshot history is not the exact concatenation of persisted action responses" };
    if (canonicalJson(temporalSheet) !== canonicalJson(value.character.sheet) || canonicalJson(temporalSanity) !== canonicalJson(value.character.sanity)) {
      return { status: "refused", code: "COMPILED_PROJECTION_INVALID", message: "snapshot final character/SAN does not match durable reward settlement chain" };
    }
    return { status: "validated", snapshot: value, state: replay.value.state, budget: replay.value.budget };
  }

  /** Installs a fully replay-validated compiled snapshot; invalid inputs make no session or world writes. */
  restoreCompiledSession(
    snapshotValue: unknown,
    catalogBundle: LoadedBundleCatalogEntry,
  ): CompiledModuleLoadResult {
    this.#assertOrdinaryDurableMutationAllowed();
    if (!this.#isPristineCompiledRestoreTarget() || this.#idRaw !== (snapshotValue as { sessionId?: unknown })?.sessionId) {
      return { status: "refused", code: "COMPILED_SESSION_CONFLICT", message: "compiled modules require a session without another loaded module" };
    }
    const checked = GameSession.validateCompiledSessionRestore(snapshotValue, catalogBundle, this.#idRaw);
    if (checked.status === "refused") return checked;
    const bundle = validateCompiledModuleBundle(catalogBundle.artifact, catalogBundle.projection);
    if (bundle.status === "refused") return bundle;
    let preparedRestore: {
      sheet: any;
      sanity: SanityEngine;
      characters: Map<string, any>;
      sanityEngines: Map<string, SanityEngine>;
      party: Map<string, PartyMember>;
      compiled: LoadedCompiledModule;
      restoredState: CompiledMechanicsSessionState;
      idempotency: Map<string, CompiledSessionIdempotencyRecord>;
    };
    try {
      const sheet = cloneJson(checked.snapshot.character.sheet) as any;
      const sanity = new SanityEngine(sheet?.attributes?.power ?? 50);
      sanity.restoreState(cloneJson(checked.snapshot.character.sanity));
      const compiled: LoadedCompiledModule = {
        payload: structuredClone(bundle.payload),
        projection: structuredClone(catalogBundle.projection),
        state: checked.state,
        trace: structuredClone(checked.snapshot.trace),
        budget: checked.budget,
        durableBundle: { id: catalogBundle.id, bundleHash: catalogBundle.bundleHash },
        catalogBundle: structuredClone(catalogBundle),
        ...(catalogBundle.worldModelBinding ? { worldModelBinding: structuredClone(catalogBundle.worldModelBinding) } : {}),
        access: checked.snapshot.access ? structuredClone(checked.snapshot.access) : null,
        snapshotHash: checked.snapshot.snapshotHash,
        initialCharacter: cloneJson(checked.snapshot.initialCharacter),
        pendingSkillGrowth: (checked.snapshot.idempotency.at(-1)?.response.action as { skillGrowthReceipt?: { pendingAfter?: string[] } } | undefined)?.skillGrowthReceipt?.pendingAfter ?? [],
      };
      preparedRestore = {
        sheet,
        sanity,
        characters: new Map([["p1", sheet]]),
        sanityEngines: new Map([["p1", sanity]]),
        party: new Map([["p1", { pcId: "p1", sheet, san: sanity, control: "auto" }]]),
        compiled,
        restoredState: this.#compiledState(compiled.payload, compiled.projection, compiled.state, compiled.trace, checked.snapshot.generation),
        idempotency: new Map(checked.snapshot.idempotency.map((record) => [record.actionId, structuredClone(record)])),
      };
    } catch (error) {
      return { status: "refused", code: "COMPILED_SESSION_CONFLICT", message: error instanceof Error ? error.message : "compiled snapshot could not be prepared" };
    }
    const sessionBeforeRestore = this.#playerSession.snapshot();
    this.#installingCompiledState = true;
    try {
      this.#playerSession.restoreSinglePlayer("p1", preparedRestore.sheet?.name ?? "调查员", checked.snapshot.history as unknown as AgentMessage[]);
      this.#installCompiledProjectionAtomically(catalogBundle.projection, bundle.payload.mechanicsIR, checked.state, { character: preparedRestore.sheet, sanity: preparedRestore.sanity });
      this.#createdAtRaw = checked.snapshot.timestamps.createdAt;
      this.#lastActiveAtRaw = checked.snapshot.timestamps.lastActiveAt;
      this.#roundRaw = checked.snapshot.round;
      this.#activeRulesetRaw = "cosmic-horror";
      this.#activePlayerId = "p1";
      this.#installActiveCharacter(preparedRestore.sheet);
      this.#installSanityEngine(preparedRestore.sanity);
      this.#characters = preparedRestore.characters;
      this.#sanityEngines = preparedRestore.sanityEngines;
      this.#party = preparedRestore.party;
      this.#compiledModule = preparedRestore.compiled;
      this.#compiledGeneration = checked.snapshot.generation;
      this.#compiledIdempotency = preparedRestore.idempotency;
      this.#compiledFailStopped = false;
    this.#lastNarrative = checked.snapshot.terminal?.narration ?? "";
      return { status: "loaded", compiled: preparedRestore.restoredState };
    } catch (error) {
      this.#playerSession.restoreSnapshot(sessionBeforeRestore);
      return { status: "refused", code: "COMPILED_SESSION_CONFLICT", message: error instanceof Error ? error.message : "compiled snapshot could not be installed" };
    } finally {
      this.#installingCompiledState = false;
    }
  }

  #installCompiledProjection(projection: CompilerModuleDataProjection, ir: MechanicsIR, state: MechanicsState): void {
    for (const scene of projection.module.scenes) {
      this.#worldRaw.registerScene(scene.id, scene.name, scene.description);
      this.#worldRaw.setSceneExits(scene.id, scene.connections.map((connection) => ({ target: connection.targetSceneId, desc: connection.condition })));
      this.#sceneDisplayNames[scene.id] = scene.name;
      this.#sceneAliases[scene.id] = [scene.name];
    }
    for (const npc of projection.module.npcs) {
      const definition = compiledEncounterDefinitionForNpc(ir, npc.id);
      const encounter = definition && state.encounters[definition.encounterId];
      // Encounter definitions are declarations, not live combatants.  The
      // shared mechanics state creates the encounter only after its scene's
      // automatic start settles; until then the world mirror must not invent
      // an attackable hostile (or an HP value) for a remote scene.
      if (definition && !encounter) continue;
      this.#worldRaw.upsertEntity({
        id: npc.id,
        name: npc.name,
        type: definition ? "monster" : "npc",
        hp: definition ? encounter!.currentHp : 1,
        maxHp: definition?.maxHp ?? 1,
        ac: 0,
        status: definition ? [encounter!.status === "defeated" ? "defeated" : "hostile"] : ["narrative_noncombat"],
        position: npc.sceneId,
        scene_id: npc.sceneId,
      });
    }
    for (const scene of projection.module.scenes) {
      this.#sceneItems.set(scene.id, projection.module.items
        .filter((item) => item.sceneId === scene.id)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((item) => item.name));
    }
  }

  /**
   * Projection installation is one transaction across the world mirror and all
   * session-owned projection maps.  A failed install must leave the caller's
   * session eligible for a retry with the same validated bundle or snapshot.
   */
  #installCompiledProjectionAtomically(
    projection: CompilerModuleDataProjection,
    ir: MechanicsIR,
    state: MechanicsState,
    options: { character?: any; sanity?: SanityEngine } = {},
  ): void {
    const sceneItemsBefore = this.#sceneItems;
    const sceneDisplayNamesBefore = this.#sceneDisplayNames;
    const sceneAliasesBefore = this.#sceneAliases;
    this.#sceneItems = new Map([...sceneItemsBefore].map(([sceneId, items]) => [sceneId, [...items]]));
    this.#sceneDisplayNames = { ...sceneDisplayNamesBefore };
    this.#sceneAliases = Object.fromEntries(Object.entries(sceneAliasesBefore).map(([sceneId, aliases]) => [sceneId, [...aliases]]));
    try {
      this.#worldRaw.getDatabase().transaction(() => {
        if (options.sanity) {
          this.#worldRaw.registerPlayer("p1");
          this.#worldRaw.setPlayerSanity("p1", options.sanity.state);
        }
        this.#installCompiledProjection(projection, ir, state);
        this.#synchronizeCompiledMechanicsState(state, projection, ir, options.character);
      })();
    } catch (error) {
      this.#sceneItems = sceneItemsBefore;
      this.#sceneDisplayNames = sceneDisplayNamesBefore;
      this.#sceneAliases = sceneAliasesBefore;
      throw error;
    }
  }

  /** Mirrors only compiler-owned facts after a settled shared-core boundary. */
  #synchronizeCompiledMechanicsState(
    state: MechanicsState,
    projection = this.#compiledModule?.projection,
    ir = this.#compiledModule?.payload.mechanicsIR,
    character = this.#activeCharacterRaw,
  ): void {
    if (!projection || !ir) throw new Error("compiled projection and MechanicsIR are required for mechanics synchronization");
    if (!this.#setSceneCanonical(state.currentSceneId)) throw new Error(`compiled scene could not be activated: ${state.currentSceneId}`);
    const playerId = "p1";
    const current = this.#worldRaw.getEntity(playerId);
    this.#worldRaw.upsertEntity(current
      ? { ...current, name: character?.name ?? current.name, hp: character?.hp ?? current.hp, maxHp: character?.maxHp ?? current.maxHp, attributes: character?.attributes ? { ...character.attributes } : current.attributes, position: state.currentSceneId, scene_id: state.currentSceneId }
      : {
        id: playerId,
        name: character?.name ?? "调查员",
        type: "pc",
        hp: character?.hp ?? 12,
        maxHp: character?.maxHp ?? 12,
        ac: character?.ac ?? 10,
        status: [],
        position: state.currentSceneId,
        scene_id: state.currentSceneId,
      });
    const views = compiledProjectionItemView(projection, state, state.currentSceneId);
    this.#worldRaw.setPlayerInventory(playerId, views.inventory);
    const owned = new Set(state.ownedItemIds);
    for (const scene of projection.module.scenes) {
      this.#sceneItems.set(scene.id, projection.module.items
        .filter((item) => item.sceneId === scene.id && !owned.has(item.id))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((item) => item.name));
    }
    for (const sceneId of state.visitedSceneIds) this.#worldRaw.recordSceneVisit(playerId, sceneId);
    for (const clueId of state.foundClueIds) this.#worldRaw.recordClueDiscovery(playerId, clueId);
    const npcs = new Map(projection.module.npcs.map((npc) => [npc.id, npc]));
    for (const definition of ir.encounterDefinitions) {
      const npc = npcs.get(definition.combatantId);
      const encounter = state.encounters[definition.encounterId];
      if (!npc || !encounter) continue;
      this.#worldRaw.upsertEntity({
        id: npc.id,
        name: npc.name,
        type: "monster",
        hp: encounter.currentHp,
        maxHp: definition.maxHp,
        ac: 0,
        status: [encounter.status === "active" ? "hostile" : "defeated"],
        position: definition.sceneId,
        scene_id: definition.sceneId,
      });
    }
  }

  #compiledFailure(code: string): ActionResponse {
    return {
      narrative: "",
      events: [],
      state: this.#stateProjection(),
      error: { code },
      compiled: this.#compiledMechanicsStateProjection() ?? undefined,
    };
  }

  #evaluateCompiledCheck(check: Exclude<CheckSpec, { kind: "none" }>): { success: boolean; line: string; dice: { expr: string; total: number; detail?: string }; roll: { skill: string; roll: number; target: number; success: boolean } } {
    // Durable compiled sessions are deliberately single-p1: never let a stale
    // active-character pointer select another PC's check values.
    const { label, target } = compiledCheckDescriptor(check, this.#characters.get("p1"));
    const result = CoCEngine.skillCheck(target, check.difficulty);
    const dice = { expr: "d100", total: result.roll, detail: `${label}/${check.difficulty}` };
    const roll = { skill: label, roll: result.roll, target, success: result.isSuccess };
    return {
      success: result.isSuccess,
      line: `🎲 ${label} ${check.difficulty} 检定 d100=${result.roll} (目标=${target}%) → ${result.isSuccess ? "成功" : "失败"}`,
      dice,
      roll,
    };
  }

  #selectCompiledAction(
    ir: MechanicsIR,
    input: MechanicsAnalysisInput,
    state: MechanicsState,
    mechanismId: string,
  ): CompiledActionSelection | null {
    const available = availableMechanicsPlayerActions(ir, input, state).filter((action) => action.mechanismId === mechanismId);
    if (available.length === 0) return null;
    const attack = available.find((action) => action.outcome === "attack");
    if (attack?.outcome === "attack") return this.#selectCompiledCombatAction(ir, state, mechanismId);
    const discovery = ir.discoveryMethods.find((candidate) => candidate.id === mechanismId);
    if (!discovery) {
      return available.some((action) => action.outcome === "traverse") ? { mechanismId, outcome: "traverse" } : null;
    }
    if (!discovery.check || discovery.check.kind === "none") return available.some((action) => action.outcome === "success") ? { mechanismId, outcome: "success" } : null;
    if (available.some((action) => action.outcome === "failback")) return { mechanismId, outcome: "failback" };
    const check = this.#evaluateCompiledCheck(discovery.check);
    return { mechanismId, outcome: check.success ? "success" : "failure", checkLine: check.line, dice: check.dice, roll: check.roll };
  }

  /**
   * GameSession is the sole random producer for compiled combat.  The core
   * receives only the exact typed result and remains deterministic/replayable.
   */
  #selectCompiledCombatAction(ir: MechanicsIR, state: MechanicsState, mechanismId: string): CompiledActionSelection | null {
    const encounterId = mechanismId.startsWith("attack:") ? mechanismId.slice("attack:".length) : "";
    const definition = ir.encounterDefinitions.find((candidate) => candidate.encounterId === encounterId);
    const encounter = definition && state.encounters[definition.encounterId];
    const compiled = this.#compiledModule;
    const npc = definition && compiled?.projection.module.npcs.find((candidate) => candidate.id === definition.combatantId);
    const sourceCharacter = this.#characters.get("p1");
    if (!definition || !encounter || encounter.status !== "active" || !npc || !sourceCharacter || definition.sceneId !== state.currentSceneId || npc.sceneId !== state.currentSceneId) return null;
    try {
      const actor = compiledCombatActor(sourceCharacter);
      const fighting = compiledCombatSkill(sourceCharacter, "fighting");
      const dodge = compiledCombatSkill(sourceCharacter, "dodge");
      const entropy = createCompiledCombatEntropy(this.#compiledCombatRandom);
      const enemy: WorldEntity = {
        id: definition.combatantId,
        name: npc.name,
        type: "monster",
        hp: encounter.currentHp,
        maxHp: definition.maxHp,
        ac: 0,
        status: ["hostile"],
        position: state.currentSceneId,
        scene_id: state.currentSceneId,
      };
      const playerResult = this.#rulesRaw.adjudicateAttack(
        { action: "attack", target: enemy.id },
        { name: actor.name, id: "p1", proficiency: 2, abilities: {}, hasSneakAttack: false },
        enemy,
        "cosmic-horror",
        undefined, undefined, undefined,
        fighting, definition.dodge, "1d1", undefined, "dodge", undefined, "0", { profile: "compiled-core", random: entropy.random },
      );
      const playerDamage = playerResult.hit ? playerResult.damage : 0;
      if (playerDamage !== 0 && playerDamage !== 1) throw new Error("RulesEngine produced an attack outside the compiled unarmed policy");
      const playerKillsEnemy = playerResult.hit && playerDamage >= encounter.currentHp;
      let enemyResult: ReturnType<RulesEngine["adjudicateAttack"]> | undefined;
      if (!playerKillsEnemy) {
        const player: WorldEntity = {
          id: "p1", name: actor.name, type: "pc", hp: actor.hp, maxHp: actor.maxHp, ac: 0, status: [], position: state.currentSceneId,
          scene_id: state.currentSceneId, ...(actor.attributes ? { attributes: actor.attributes } : {}),
        };
        enemyResult = this.#rulesRaw.adjudicateAttack(
          { action: "attack", target: player.id },
          { name: npc.name, id: definition.combatantId, proficiency: 2, abilities: {}, hasSneakAttack: false },
          player,
          "cosmic-horror",
          undefined, undefined, undefined,
          definition.fight, dodge, compiledCombatDamageDice(definition.npcDamage), undefined, "dodge", undefined, "0", { profile: "compiled-core", random: entropy.random },
        );
      }
      const actorDamage = enemyResult?.hit ? enemyResult.damage : 0;
      const actorHpAfter = Math.max(0, actor.hp - actorDamage);
      const combat: MechanicsCombatOutcome = playerResult.hit
        ? {
          kind: "attack", encounterId: definition.encounterId, targetId: definition.combatantId,
          hit: true, damage: playerDamage, enemyHit: enemyResult?.hit ?? false, actorDamage, actorDefeated: actorHpAfter === 0,
        }
        : {
          kind: "attack", encounterId: definition.encounterId, targetId: definition.combatantId,
          hit: false, damage: 0, enemyHit: enemyResult?.hit ?? false, actorDamage, actorDefeated: actorHpAfter === 0,
        };
      const characterAfter = structuredClone(sourceCharacter);
      characterAfter.hp = actorHpAfter;
      return {
        mechanismId,
        outcome: "attack",
        combat,
        characterAfter,
        combatLedger: {
          schemaVersion: "1.0.0",
          mechanismId,
          encounterId: definition.encounterId,
          sourceInterpretationIds: [...definition.sourceInterpretationIds].sort(),
          actorHpBefore: actor.hp,
          actorHpAfter,
          randomUnits: [...entropy.units],
          player: {
            fighting,
            targetDodge: definition.dodge,
            roll: playerResult.cocRoll ?? 0,
            defenseRoll: playerResult.cocDefenseRoll ?? null,
            hit: playerResult.hit,
            damage: playerDamage,
          },
          enemy: enemyResult ? {
            fight: definition.fight,
            targetDodge: dodge,
            damage: structuredClone(definition.npcDamage),
            roll: enemyResult.cocRoll ?? 0,
            defenseRoll: enemyResult.cocDefenseRoll ?? null,
            hit: enemyResult.hit,
            damageDealt: actorDamage,
          } : null,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Pure reward settlement for a prepared action.  It clones every mutable
   * character/SAN value, so the durable path can persist the prepared result
   * before a live world or character write is permitted.
   */
  #prepareTerminalRewardSettlement(before: MechanicsState, after: MechanicsState, sourceCharacter = this.#characters.get("p1"), sourceSanity = this.#sanityEngines.get("p1") ?? this.#sanityRaw): { character: any; sanity: SanityEngine; rewardSettlements: TerminalRewardSettlement[] } {
    if (!sourceCharacter) throw new Error("compiled reward settlement requires p1 character");
    const initial = this.#compiledSnapshotCharacter(sourceCharacter, sourceSanity);
    const replayed = replayTerminalRewardSettlements(
      this.#compiledModule!.payload.mechanicsIR,
      mechanicsStateHash(before),
      before.rewardIds,
      after.rewardIds,
      initial.sheet,
      initial.sanity,
    );
    const sanity = new SanityEngine((replayed.sheet.attributes as Record<string, number> | undefined)?.power ?? 50);
    sanity.restoreState(replayed.sanity);
    return { character: replayed.sheet, sanity, rewardSettlements: replayed.settlements };
  }

  #prepareCompiledAction(input: string): { status: "prepared"; value: PreparedCompiledAction } | { status: "refused"; code: string } {
    const compiled = this.#compiledModule!;
    const replay = replayCompiledSessionTrace(compiled.payload, compiled.trace);
    if (replay.status === "refused" || mechanicsStateHash(replay.value.state) !== mechanicsStateHash(compiled.state)) return { status: "refused", code: "compiled_execution_failed" };
    if (replay.value.state.terminalEndingId || replay.value.state.terminalLoss) return { status: "refused", code: "compiled_terminal" };

    const mechanismId = parseCompiledMechanicsAction(input);
    if (!mechanismId) return { status: "refused", code: "compiled_action_required" };
    const selected = this.#selectCompiledAction(compiled.payload.mechanicsIR, compiled.payload.analysisInput, replay.value.state, mechanismId);
    if (!selected) return { status: "refused", code: "compiled_action_unavailable" };
    try {
      const executed = executeMechanicsAction(
        compiled.payload.mechanicsIR,
        compiled.payload.analysisInput,
        replay.value.state,
        selected.outcome === "attack"
          ? { mechanismId: selected.mechanismId, outcome: "attack", combat: selected.combat }
          : { mechanismId: selected.mechanismId, outcome: selected.outcome },
      );
      replay.value.budget.observe(executed.state);
      const after = settleAutomaticMechanics(compiled.payload.mechanicsIR, executed.state, replay.value.budget);
      const sourceCharacter = selected.outcome === "attack" ? selected.characterAfter : this.#characters.get("p1");
      const sourceSanity = this.#sanityEngines.get("p1") ?? this.#sanityRaw;
      if (!sourceCharacter) return { status: "refused", code: "compiled_execution_failed" };
      const actorSanity = replaySanityCheckSettlements(this.#idRaw, compiled.payload.mechanicsIR, executed.edge.beforeStateHash, (this.#compiledGeneration ?? 0) + 1, executed.edge.mechanismId, executed.actorEffects, this.#compiledSnapshotCharacter(sourceCharacter, sourceSanity).sanity);
      const preparedSanity = new SanityEngine(sourceCharacter.attributes?.power ?? 50);
      preparedSanity.restoreState(actorSanity.sanity);
      const trace = [...compiled.trace, executed.edge, ...after.steps];
      const nextGeneration = (this.#compiledGeneration ?? 0) + 1;
      const growth = this.#prepareCompiledSkillGrowth(selected, executed.edge, after.state, sourceCharacter, nextGeneration);
      const reward = this.#prepareTerminalRewardSettlement(replay.value.state, after.state, growth.character, preparedSanity);
      const ending = this.#compiledState(compiled.payload, compiled.projection, after.state, trace, nextGeneration).terminalEnding;
      const combatSettlement = selected.outcome === "attack" ? {
        ...selected.combatLedger,
        generation: nextGeneration,
        beforeStateHash: executed.edge.beforeStateHash,
        afterStateHash: executed.edge.afterStateHash,
        outcome: structuredClone(selected.combat),
      } satisfies CompiledCombatSettlement : undefined;
      const now = Date.now();
      const messages: AgentMessage[] = [{ speaker: this.#characters.get("p1")?.name ?? "调查员", content: input, type: "action", timestamp: now }];
      if (selected.outcome !== "attack" && selected.checkLine) messages.push({ speaker: "系统", content: selected.checkLine, type: "system", timestamp: now });
      messages.push({ speaker: "系统", content: `编译机制 ${executed.edge.mechanismId}:${executed.edge.outcome}`, type: "system", timestamp: now });
      for (const line of growth.lines) messages.push({ speaker: "系统", content: line, type: "system", timestamp: now });
      let narrative: string;
      if (ending) {
        narrative = ending.narration;
        messages.push({ speaker: "系统", content: `编译结局 ${ending.id}: ${ending.name}`, type: "system", timestamp: now });
      } else if (after.state.terminalLoss) {
        const lossNpc = compiled.projection.module.npcs.find((candidate) => candidate.id === after.state.terminalLoss!.combatantId);
        if (!lossNpc) return { status: "refused", code: "compiled_execution_failed" };
        narrative = `You are defeated by ${lossNpc.name}.`;
        messages.push({ speaker: "系统", content: `编译战斗败北: ${lossNpc.name}`, type: "system", timestamp: now });
      } else {
        narrative = `已执行编译机制 ${executed.edge.mechanismId}。`;
      }
      return { status: "prepared", value: { state: after.state, trace, budget: replay.value.budget, round: this.#roundRaw + 1, lastActiveAt: now, messages, narrative, dice: selected.outcome === "attack" ? undefined : selected.dice, roll: selected.outcome === "attack" ? undefined : selected.roll, ...reward, sanityCheckSettlements: actorSanity.settlements, skillGrowthReceipt: growth.receipt, ...(combatSettlement ? { combatSettlement } : {}) } };
    } catch {
      return { status: "refused", code: "compiled_execution_failed" };
    }
  }

  #preparedCompiledActionResponse(prepared: PreparedCompiledAction, generation: number): ActionResponse {
    // A durable compiled action is always p1-owned.  The request boundary
    // rejects other PCs, but a stale live pointer must not make the persisted
    // response disagree with the p1-only snapshot that will be rehydrated.
    const p1View = (() => {
      const activePlayerId = this.#activePlayerId;
      const activeCharacter = this.#activeCharacterRaw;
      const sanity = this.#sanityRaw;
      try {
        this.#activePlayerId = "p1";
        this.#installActiveCharacter(this.#characters.get("p1") ?? activeCharacter);
        this.#installSanityEngine(this.#sanityEngines.get("p1") ?? sanity);
        return { state: structuredClone(this.#stateProjection()) };
      } finally {
        this.#activePlayerId = activePlayerId;
        this.#installActiveCharacter(activeCharacter);
        this.#installSanityEngine(sanity);
      }
    })();
    const state = p1View.state;
    state.scene = prepared.state.currentSceneId;
    state.bgm = this.#sceneBgm[prepared.state.currentSceneId];
    state.round = prepared.round;
    const compiled = this.#compiledModule!;
    // This response is assembled before the next mechanics scene is mirrored
    // into the world. Its NPCs therefore must come from prepared state, not
    // from the old world scene.
    state.npcs = compiledProjectionNpcView(compiled.projection, compiled.payload.mechanicsIR, prepared.state.currentSceneId);
    state.monsters = compiledProjectionMonsterView(compiled.projection, compiled.payload.mechanicsIR, prepared.state, prepared.state.currentSceneId);
    const itemView = compiledProjectionItemView(compiled.projection, prepared.state, prepared.state.currentSceneId);
    state.inventory = itemView.inventory;
    state.sceneItems = itemView.sceneItems;
    state.player = { ...state.player, name: prepared.character.name, hp: prepared.character.hp, maxHp: prepared.character.maxHp, ac: 0, status: [] };
    if (state.party[0]) {
      state.party[0] = { ...state.party[0], name: prepared.character.name, hp: prepared.character.hp, maxHp: prepared.character.maxHp, status: [], san: prepared.sanity.state.currentSAN, maxSan: prepared.sanity.state.maxSAN };
    }
    return {
      narrative: prepared.narrative,
      events: prepared.messages.map((message) => ({ speaker: message.speaker, content: message.content, type: message.type, ...(message.verbatim ? { verbatim: true as const } : {}) })),
      state,
      dead: !!prepared.state.terminalLoss,
      sanity: compiledSanityView(prepared.sanity),
      ...(prepared.dice ? { dice: detachedFrozenProjection([prepared.dice]) } : {}),
      sanityCheckSettlements: structuredClone(prepared.sanityCheckSettlements),
      skillGrowthReceipt: structuredClone(prepared.skillGrowthReceipt),
      ...(prepared.combatSettlement ? { combatSettlement: structuredClone(prepared.combatSettlement) } : {}),
      ...(prepared.rewardSettlements.length ? { rewardSettlements: structuredClone(prepared.rewardSettlements) } : {}),
      compiled: this.#compiledState(compiled.payload, compiled.projection, prepared.state, prepared.trace, generation),
    };
  }

  #preparedCompiledSummary(prepared: PreparedCompiledAction): SessionSummary {
    const summary = this.#summaryProjection();
    return {
      ...summary,
      round: prepared.round,
      scene: this.#sceneDisplayNames[prepared.state.currentSceneId] ?? prepared.state.currentSceneId,
      messageCount: this.#playerSession.getPlayerHistory("p1").length + prepared.messages.length,
      npcCount: this.#compiledModule!.projection.module.npcs.length,
      generation: (this.#compiledGeneration ?? 0) + 1,
    };
  }

  #applyPreparedCompiledAction(prepared: PreparedCompiledAction): void {
    const compiled = this.#compiledModule!;
    compiled.state = prepared.state;
    compiled.trace = prepared.trace;
    compiled.budget = prepared.budget;
    compiled.pendingSkillGrowth = [...prepared.skillGrowthReceipt.pendingAfter];
    this.#roundRaw = prepared.round;
    this.#lastActiveAtRaw = prepared.lastActiveAt;
    this.#lastNarrative = prepared.narrative;
    this.#lastDiceRoll = prepared.dice ?? null;
    if (prepared.roll) this.#lastRolls.push(prepared.roll);
    this.#activePlayerId = "p1";
    this.#installActiveCharacter(structuredClone(prepared.character));
    this.#installSanityEngine(clonedSanity(prepared.sanity, this.#activeCharacterRaw?.attributes?.power ?? 50));
    this.#characters.set("p1", this.#activeCharacterRaw);
    this.#sanityEngines.set("p1", this.#sanityRaw);
    const party = this.#party.get("p1");
    if (party) this.#party.set("p1", { ...party, sheet: this.#activeCharacterRaw, san: this.#sanityRaw });
    this.#synchronizeCompiledMechanicsState(prepared.state);
    this.#persistSanity("p1");
    for (const message of prepared.messages) this.#playerSession.push(message, message.visibility ?? "public", message.discoverer);
  }

  /** Durable action boundary: derive -> persist -> fail-stop the stale object for server-side rehydration. */
  #commitCompiledActionCanonical(
    input: string,
    actionId: string,
    expectedGeneration: number,
    persist: (snapshot: CompiledSessionSnapshot) => void,
  ): CompiledActionCommitResult {
    const compiled = this.#compiledModule;
    const generation = this.#compiledGeneration;
    if (!compiled || generation === null) return { status: "refused", code: "compiled_not_loaded", generation: 0 };
    if (!compiled.durableBundle) return { status: "refused", code: "compiled_action_contract_required", generation };
    if (this.#compiledFailStopped) return { status: "refused", code: "compiled_unavailable", generation };
    const normalizedInput = input.trim();
    if (!normalizedInput || normalizedInput !== input) return { status: "refused", code: "compiled_action_contract_required", generation };
    const prior = this.#compiledIdempotency.get(actionId);
    if (prior) {
      if (prior.input !== normalizedInput || prior.expectedGeneration !== expectedGeneration) return { status: "refused", code: "compiled_idempotency_conflict", generation };
      return { status: "duplicate", response: cloneJson(prior.response), generation };
    }
    if (expectedGeneration !== generation) return { status: "refused", code: "compiled_generation_conflict", generation };
    const requestHash = compiledActionRequestHash(normalizedInput, actionId, expectedGeneration, "mechanics");
    const prepared = this.#prepareCompiledAction(normalizedInput);
    if (prepared.status === "refused") return { status: "refused", code: prepared.code, generation };
    const nextGeneration = generation + 1;
    const action = this.#preparedCompiledActionResponse(prepared.value, nextGeneration);
    const response: PersistedCompiledActionResponse = {
      schemaVersion: COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION,
      action: cloneJson(JSON.parse(JSON.stringify(action)) as JsonRecord),
      summary: cloneJson(JSON.parse(JSON.stringify(this.#preparedCompiledSummary(prepared.value))) as JsonRecord),
      generation: nextGeneration,
    };
    const record: CompiledSessionIdempotencyRecord = {
      actionId,
      input: normalizedInput,
      requestHash,
      expectedGeneration,
      generation: nextGeneration,
      characterBefore: this.#compiledSnapshotCharacter(this.#characters.get("p1"), this.#sanityEngines.get("p1") ?? this.#sanityRaw),
      response,
    };
    const history = [...this.#playerSession.getPlayerHistory("p1"), ...prepared.value.messages];
    let snapshot: CompiledSessionSnapshot;
    try {
      snapshot = this.#makeCompiledSnapshot({
        state: prepared.value.state,
        trace: prepared.value.trace,
        round: prepared.value.round,
        lastActiveAt: prepared.value.lastActiveAt,
        history,
        generation: nextGeneration,
        idempotency: [...this.#compiledIdempotency.values(), record],
        character: this.#compiledSnapshotCharacter(prepared.value.character, prepared.value.sanity),
      });
      persist(snapshot);
    } catch (error) {
      if (error instanceof CompiledSessionSnapshotPersistenceError) {
        const code = error.code === "SNAPSHOT_CONFLICT" ? "compiled_generation_conflict"
          : error.code === "SNAPSHOT_BUSY" ? "compiled_persistence_busy"
            : error.code === "SNAPSHOT_QUOTA_EXCEEDED" ? "compiled_persistence_quota"
            : error.code === "SNAPSHOT_INDETERMINATE" ? "compiled_persistence_indeterminate"
              : "compiled_persistence_failed";
        return { status: "refused", code, generation };
      }
      return { status: "refused", code: "compiled_persistence_failed", generation };
    }
    this.#compiledFailStopped = true;
    return { status: "committed", response, generation: nextGeneration, snapshot };
  }

  /** Build the only model-visible frame from the reviewed presentation and
   * player-safe character deltas. This is deliberately separate from the
   * mechanically complete candidate snapshot retained by the durable host. */
  #compiledNarrationPlayerFrame(
    state: MechanicsState,
    character: { name?: unknown; hp?: unknown; maxHp?: unknown },
    sanity: SanityEngine,
  ): CompiledNarrationPlayerFrame {
    const presentation = this.compiledPlayerPresentationFor(state);
    const era = this.#compiledNarrationReviewedEra();
    return {
      ...(presentation ? { presentation } : {}),
      ...(era ? { era } : {}),
      character: {
        name: typeof character.name === "string" ? character.name : "调查员",
        hp: typeof character.hp === "number" ? character.hp : 0,
        maxHp: typeof character.maxHp === "number" ? character.maxHp : 0,
      },
      sanity: { currentSAN: sanity.state.currentSAN, maxSAN: sanity.state.maxSAN },
    };
  }

  /** A source-reviewed era is useful only when it is an established year. */
  #compiledNarrationReviewedEra(): string | undefined {
    const reviewedEra = this.#compiledModule?.durableBundle && this.#compiledModule.projection.presentationReview
      ? this.#compiledModule.projection.module.era.trim()
      : "";
    return /^[1-2]\d{3}$/.test(reviewedEra) ? reviewedEra : undefined;
  }

  /** Only direct source text or a verified trusted-review quote may establish
   * an exception to the generic technology rule.  Mechanically resolved
   * metadata, character fields, and scoped world-model reference text cannot.
   */
  #compiledNarrationHasSourceExactOrigin(origin: ProjectionFieldOrigin | undefined): boolean {
    return origin?.kind === "source_exact" || origin?.kind === "trusted_presentation_review";
  }

  /** Private before/after-scene clue names for the independent no-spoiler
   * narration rule. They never cross a player/model boundary. A clue revealed
   * by this exact successor remains allowed; every still-hidden clue in either
   * scene remains protected while the model narrates the transition. */
  #compiledNarrationUndiscoveredClueKeys(
    beforeState: MechanicsState,
    afterState: MechanicsState,
  ): string[] {
    const compiled = this.#compiledModule;
    if (!compiled?.durableBundle || !compiled.projection.presentationReview) return [];
    const sceneIds = new Set([beforeState.currentSceneId, afterState.currentSceneId]);
    const foundAfter = new Set(afterState.foundClueIds);
    return [...new Set(compiled.projection.module.scenes
      .filter((scene) => sceneIds.has(scene.id))
      .flatMap((scene) => scene.clues)
      .filter((clue) => !foundAfter.has(clue.id))
      .flatMap((clue) => splitKeys([clue.name])))]
      .sort((left, right) => left.localeCompare(right));
  }

  /**
   * Derive exact policy terms only from the same source-reviewed fields that
   * are actually staged in this candidate's before/after public frame.  The
   * projection's private IDs are used for provenance lookup and are never
   * passed to the model or player.
   */
  #compiledNarrationSourceReviewedTechnologyTerms(
    beforeState: MechanicsState,
    afterState: MechanicsState,
  ): string[] {
    const compiled = this.#compiledModule;
    if (!compiled?.durableBundle || !compiled.projection.presentationReview) return [];
    const texts: string[] = [];
    const add = (origin: ProjectionFieldOrigin | undefined, text: string | undefined) => {
      if (this.#compiledNarrationHasSourceExactOrigin(origin) && typeof text === "string" && text.trim()) texts.push(text);
    };
    const clues = new Map(compiled.projection.module.scenes.flatMap((scene) => scene.clues).map((clue) => [clue.id, clue]));
    const clueOrigins = new Map(compiled.projection.module.scenes.flatMap((scene) => Object.entries(compiled.projection.sourceMap.scenes[scene.id]?.clues ?? {})
      .map(([clueId, origin]) => [clueId, origin] as const)));
    const collect = (state: MechanicsState) => {
      const scene = compiled.projection.module.scenes.find((candidate) => candidate.id === state.currentSceneId);
      if (scene) add(compiled.projection.sourceMap.scenes[scene.id]?.fields.description, scene.description);
      for (const clueId of state.foundClueIds) {
        const clue = clues.get(clueId);
        const origin = clueOrigins.get(clueId);
        if (!clue || !origin) continue;
        add(origin.fields.name, clue.name);
        add(origin.fields.revelation, clue.revelation);
      }
      if (state.terminalEndingId !== undefined) {
        const ending = compiled.projection.module.endings.find((candidate) => candidate.id === state.terminalEndingId);
        const origin = compiled.projection.sourceMap.endings[state.terminalEndingId];
        if (ending && origin) {
          add(origin.fields.name, ending.name);
          add(origin.fields.description, ending.description);
        }
      }
    };
    collect(beforeState);
    collect(afterState);
    return sourceReviewedNarrationTechnologyTerms(texts);
  }

  #compiledNarrationWorldReference(frame: {
    before: CompiledNarrationPlayerFrame;
    after: CompiledNarrationPlayerFrame;
    actionLabel: string;
  }): CompiledWorldModelPromptContext | undefined {
    const binding = this.#compiledModule?.worldModelBinding;
    if (!binding) return undefined;
    const strings = [
      frame.actionLabel,
      frame.before.presentation?.scene.name,
      frame.before.presentation?.scene.description,
      ...((frame.before.presentation?.clues ?? []).flatMap((clue) => [clue.name, clue.revelation])),
      frame.after.presentation?.scene.name,
      frame.after.presentation?.scene.description,
      ...((frame.after.presentation?.clues ?? []).flatMap((clue) => [clue.name, clue.revelation])),
      frame.after.presentation?.ending?.name,
      frame.after.presentation?.ending?.description,
    ].filter((value): value is string => typeof value === "string" && !!value.trim());
    try {
      // The binding is already artifact-bound at durable module load. This call
      // receives only player-safe frame text and keeps references explicitly
      // non-authoritative in the downstream model prompt.
      return buildCompiledCthulhuWorldModelContext(binding, { keywords: strings });
    } catch {
      // A reference failure never widens to a global corpus or to module facts.
      return undefined;
    }
  }

  /** One-way v2 binding for a single player request. The choice HMAC key never
   * leaves the durable authority and raw prose never enters the returned value. */
  #compiledNarrationTopicBindingCanonical(input: {
    predecessorSnapshotHash: string;
    expectedGeneration: number;
    actionId: string;
    playerTopic: CompiledPlayerNarrationTopicRequest;
  }): CompiledPlayerNarrationTopicBinding | null {
    const compiled = this.#compiledModule;
    const access = compiled?.access;
    if (!compiled?.durableBundle || !access || !validHexHash(input.predecessorSnapshotHash)
      || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0
      || typeof input.actionId !== "string" || !input.actionId || input.actionId.trim() !== input.actionId) return null;
    const topic = input.playerTopic;
    if (!topic || typeof topic.choiceId !== "string" || !/^choice_[A-Za-z0-9_-]{43}$/.test(topic.choiceId)
      || !validHexHash(topic.topicBound) || typeof topic.playerInput !== "string"
      || !topic.playerInput || topic.playerInput.trim() !== topic.playerInput) return null;
    const basePublicRequestHash = compiledPlayerNarrationPublicRequestHash(topic.choiceId, input.actionId, input.expectedGeneration);
    const topicTokenHash = compiledPlayerNarrationTopicTokenHash(topic.topicBound);
    const topicBindingHash = createHmac("sha256", Buffer.from(access.choiceHmacKey, "hex"))
      .update(canonicalJson({
        domain: "compiled-player-narration-topic-binding-v2",
        sessionId: this.#idRaw,
        bundleHash: compiled.durableBundle.bundleHash,
        predecessorSnapshotHash: input.predecessorSnapshotHash,
        expectedGeneration: input.expectedGeneration,
        actionId: input.actionId,
        choiceId: topic.choiceId,
        topicBound: topic.topicBound,
        playerInput: topic.playerInput,
        basePublicRequestHash,
      }))
      .digest("hex");
    return Object.freeze({
      topicTokenHash,
      topicBindingHash,
      playerRequestHash: compiledPlayerNarrationV2RequestHash(basePublicRequestHash, topicTokenHash, topicBindingHash),
    });
  }

  #bindCompiledNarrationTopicCanonical(
    input: string,
    actionId: string,
    expectedGeneration: number,
    playerTopic: CompiledPlayerNarrationTopicRequest,
  ): CompiledPlayerNarrationTopicBinding | null {
    const compiled = this.#compiledModule;
    const generation = this.#compiledGeneration;
    if (!compiled?.durableBundle || !compiled.snapshotHash || generation === null || generation !== expectedGeneration
      || typeof input !== "string" || !input || input.trim() !== input) return null;
    // Topic evidence augments the opaque choice; it can never authorize a
    // mechanic by itself.
    if (this.#resolveCompiledPlayerFacadeActionInputCanonical(playerTopic.choiceId, expectedGeneration) !== input) return null;
    return this.#compiledNarrationTopicBindingCanonical({
      predecessorSnapshotHash: compiled.snapshotHash,
      expectedGeneration,
      actionId,
      playerTopic,
    });
  }

  #matchCompiledNarrationTopicCanonical(
    candidate: CompiledNarrationCandidate,
    playerTopic: CompiledPlayerNarrationTopicRequest,
  ): CompiledPlayerNarrationTopicBinding | null {
    const compiled = this.#compiledModule;
    const generation = this.#compiledGeneration;
    if (!compiled?.durableBundle || !compiled.snapshotHash || generation === null || candidate?.schemaVersion !== "2.0.0"
      || candidate.sessionId !== this.#idRaw || candidate.bundleId !== compiled.durableBundle.id) return null;
    // A receipt saved before its successor snapshot is committed has no live
    // idempotency anchor yet. It can only be resumed at its exact live scope
    // with raw prose, never by a candidate-local predecessor claim.
    if (generation === candidate.expectedGeneration) {
      if (!sameHexHash(candidate.predecessorSnapshotHash, compiled.snapshotHash)) return null;
    } else {
      const prior = this.#compiledIdempotency.get(candidate.actionId);
      if (!prior || !this.#matchesCommittedNarrationCandidateCanonical(candidate, prior)) return null;
    }
    const derived = this.#compiledNarrationTopicBindingCanonical({
      predecessorSnapshotHash: candidate.predecessorSnapshotHash,
      expectedGeneration: candidate.expectedGeneration,
      actionId: candidate.actionId,
      playerTopic,
    });
    if (!derived || !sameHexHash(candidate.topicTokenHash, derived.topicTokenHash)
      || !sameHexHash(candidate.topicBindingHash, derived.topicBindingHash)
      || !sameHexHash(candidate.playerRequestHash, derived.playerRequestHash)) return null;
    return derived;
  }

  /** Prepare the exact successor once, then expose it only through the private
   * durable authority. No world/character/session write occurs here. */
  #prepareCompiledNarrationCanonical(
    input: string,
    actionId: string,
    expectedGeneration: number,
    playerRequestHash?: string,
    playerTopic?: CompiledPlayerNarrationTopicRequest,
  ): CompiledNarrationPreparation {
    const compiled = this.#compiledModule;
    const generation = this.#compiledGeneration;
    if (!compiled || generation === null) return { status: "refused", code: "compiled_not_loaded", generation: 0 };
    if (!compiled.durableBundle || !compiled.catalogBundle || !compiled.snapshotHash) return { status: "refused", code: "compiled_action_contract_required", generation };
    if (this.#compiledFailStopped) return { status: "refused", code: "compiled_unavailable", generation };
    const normalizedInput = input.trim();
    if (!normalizedInput || normalizedInput !== input) return { status: "refused", code: "compiled_action_contract_required", generation };
    const prior = this.#compiledIdempotency.get(actionId);
    if (prior) {
      if (prior.input !== normalizedInput || prior.expectedGeneration !== expectedGeneration) return { status: "refused", code: "compiled_idempotency_conflict", generation };
      return { status: "duplicate", response: cloneJson(prior.response), generation };
    }
    if (expectedGeneration !== generation) return { status: "refused", code: "compiled_generation_conflict", generation };
    const selectedAction = this.#compiledAvailableActionsProjection().find((action) => action.command === normalizedInput);
    if (!selectedAction) return { status: "refused", code: "compiled_action_unavailable", generation };
    const prepared = this.#prepareCompiledAction(normalizedInput);
    if (prepared.status === "refused") return { status: "refused", code: prepared.code, generation };
    const nextGeneration = generation + 1;
    const requestHash = compiledActionRequestHash(normalizedInput, actionId, expectedGeneration, "provider");
    if (playerRequestHash !== undefined && !validHexHash(playerRequestHash)) {
      return { status: "refused", code: "compiled_action_contract_required", generation };
    }
    const topicBinding = playerTopic === undefined
      ? undefined
      : this.#bindCompiledNarrationTopicCanonical(normalizedInput, actionId, expectedGeneration, playerTopic);
    if (playerTopic !== undefined && !topicBinding) return { status: "refused", code: "compiled_action_contract_required", generation };
    if (topicBinding && playerRequestHash !== undefined && !sameHexHash(playerRequestHash, topicBinding.playerRequestHash)) {
      return { status: "refused", code: "compiled_action_contract_required", generation };
    }
    const response: PersistedCompiledActionResponse = {
      schemaVersion: COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION,
      action: cloneJson(JSON.parse(JSON.stringify(this.#preparedCompiledActionResponse(prepared.value, nextGeneration))) as JsonRecord),
      summary: cloneJson(JSON.parse(JSON.stringify(this.#preparedCompiledSummary(prepared.value))) as JsonRecord),
      generation: nextGeneration,
    };
    const record: CompiledSessionIdempotencyRecord = {
      actionId,
      input: normalizedInput,
      requestHash,
      expectedGeneration,
      generation: nextGeneration,
      characterBefore: this.#compiledSnapshotCharacter(this.#characters.get("p1"), this.#sanityEngines.get("p1") ?? this.#sanityRaw),
      response,
      ...(topicBinding ? {
        narrationTopic: {
          schemaVersion: "1.0.0" as const,
          predecessorSnapshotHash: compiled.snapshotHash,
          topicTokenHash: topicBinding.topicTokenHash,
          topicBindingHash: topicBinding.topicBindingHash,
          playerRequestHash: topicBinding.playerRequestHash,
        },
      } : {}),
    };
    try {
      const snapshot = this.#makeCompiledSnapshot({
        state: prepared.value.state,
        trace: prepared.value.trace,
        round: prepared.value.round,
        lastActiveAt: prepared.value.lastActiveAt,
        history: [...this.#playerSession.getPlayerHistory("p1"), ...prepared.value.messages],
        generation: nextGeneration,
        idempotency: [...this.#compiledIdempotency.values(), record],
        character: this.#compiledSnapshotCharacter(prepared.value.character, prepared.value.sanity),
      });
      const beforeCharacter = this.#characters.get("p1");
      const beforeSanity = this.#sanityEngines.get("p1") ?? this.#sanityRaw;
      if (!beforeCharacter) return { status: "refused", code: "compiled_execution_failed", generation };
      const baseFrame = {
        before: this.#compiledNarrationPlayerFrame(compiled.state, beforeCharacter, beforeSanity),
        after: this.#compiledNarrationPlayerFrame(prepared.value.state, prepared.value.character, prepared.value.sanity),
        actionLabel: this.compiledPlayerActionLabel(selectedAction),
      };
      const worldModel = this.#compiledNarrationWorldReference(baseFrame);
      const frame = { ...baseFrame, ...(worldModel ? { worldModel } : {}) };
      const frameHash = sha256(canonicalJson(frame));
      const candidate: CompiledNarrationCandidate = topicBinding ? {
        schemaVersion: "2.0.0",
        sessionId: this.#idRaw,
        bundleId: compiled.durableBundle.id,
        actionId,
        expectedGeneration,
        nextGeneration,
        predecessorSnapshotHash: compiled.snapshotHash,
        requestHash,
        playerRequestHash: topicBinding.playerRequestHash,
        candidateHash: "",
        frame,
        frameHash,
        snapshot,
        topicTokenHash: topicBinding.topicTokenHash,
        topicBindingHash: topicBinding.topicBindingHash,
      } : {
        schemaVersion: "1.0.0",
        sessionId: this.#idRaw,
        bundleId: compiled.durableBundle.id,
        actionId,
        expectedGeneration,
        nextGeneration,
        predecessorSnapshotHash: compiled.snapshotHash,
        requestHash,
        playerRequestHash: playerRequestHash ?? requestHash,
        candidateHash: "",
        frame,
        frameHash,
        snapshot,
      };
      candidate.candidateHash = compiledNarrationCandidateHash(candidate);
      return { status: "prepared", candidate: structuredClone(candidate) };
    } catch {
      return { status: "refused", code: "compiled_execution_failed", generation };
    }
  }

  /**
   * A ledger row is private persistence, not model-prompt authority. Rebuild
   * its only model-visible frame from the live reviewed projection and the
   * exact candidate successor before dispatch. This validates all mechanics
   * through the established restore/replay boundary without executing or
   * mutating the candidate.
   */
  #validateCompiledNarrationCandidateCanonical(candidate: CompiledNarrationCandidate): boolean {
    const compiled = this.#compiledModule;
    const generation = this.#compiledGeneration;
    try {
      if (!compiled?.durableBundle || !compiled.catalogBundle || !compiled.snapshotHash || !compiled.access || generation === null || this.#compiledFailStopped
        || !candidate || (candidate.schemaVersion !== "1.0.0" && candidate.schemaVersion !== "2.0.0") || candidate.sessionId !== this.#idRaw
        || candidate.bundleId !== compiled.durableBundle.id || candidate.expectedGeneration !== generation
        || candidate.nextGeneration !== generation + 1 || candidate.predecessorSnapshotHash !== compiled.snapshotHash
        || !validHexHash(candidate.playerRequestHash)
        || (candidate.schemaVersion === "2.0.0" && (!validHexHash(candidate.topicTokenHash) || !validHexHash(candidate.topicBindingHash)))
        || candidate.frameHash !== sha256(canonicalJson(candidate.frame))
        || candidate.candidateHash !== compiledNarrationCandidateHash(candidate)) return false;
      const checked = validateCompiledSessionSnapshot(candidate.snapshot);
      if (checked.status === "refused" || checked.value.schemaVersion !== COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
        || checked.value.generation !== candidate.nextGeneration || checked.value.previousSnapshotHash !== compiled.snapshotHash
        || checked.value.bundle.id !== compiled.durableBundle.id || checked.value.idempotency.length !== candidate.nextGeneration) return false;
      const record = checked.value.idempotency.at(-1);
      if (!record || record.actionId !== candidate.actionId || record.expectedGeneration !== generation
        || record.requestHash !== candidate.requestHash || record.requestHash !== compiledActionRequestHash(record.input, candidate.actionId, generation, "provider")
        || record.response.schemaVersion !== COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION
        || record.response.action.playerNarration !== undefined) return false;
      const selectedAction = this.#compiledAvailableActionsProjection().find((action) => action.command === record.input);
      const beforeCharacter = this.#characters.get("p1");
      const beforeSanity = this.#sanityEngines.get("p1") ?? this.#sanityRaw;
      if (!selectedAction || !beforeCharacter) return false;
      if (candidate.schemaVersion === "2.0.0") {
        const anchor = record.narrationTopic;
        if (!anchor || anchor.schemaVersion !== "1.0.0"
          || !sameHexHash(anchor.predecessorSnapshotHash, candidate.predecessorSnapshotHash)
          || !sameHexHash(anchor.topicTokenHash, candidate.topicTokenHash)
          || !sameHexHash(anchor.topicBindingHash, candidate.topicBindingHash)
          || !sameHexHash(anchor.playerRequestHash, candidate.playerRequestHash)) return false;
        const choiceId = compiledPlayerChoiceId(compiled.access.choiceHmacKey, candidate.expectedGeneration, selectedAction.mechanismId);
        const basePublicRequestHash = compiledPlayerNarrationPublicRequestHash(choiceId, candidate.actionId, candidate.expectedGeneration);
        if (!sameHexHash(candidate.playerRequestHash, compiledPlayerNarrationV2RequestHash(
          basePublicRequestHash,
          candidate.topicTokenHash,
          candidate.topicBindingHash,
        ))) return false;
      } else if (record.narrationTopic !== undefined) return false;
      const afterSheet = checked.value.character.sheet as { name?: unknown; hp?: unknown; maxHp?: unknown; attributes?: unknown };
      const afterSanity = new SanityEngine((afterSheet.attributes as Record<string, number> | undefined)?.power ?? 50);
      afterSanity.restoreState(cloneJson(checked.value.character.sanity));
      const baseFrame = {
        before: this.#compiledNarrationPlayerFrame(compiled.state, beforeCharacter, beforeSanity),
        after: this.#compiledNarrationPlayerFrame(checked.value.state, afterSheet, afterSanity),
        actionLabel: this.compiledPlayerActionLabel(selectedAction),
      };
      const worldModel = this.#compiledNarrationWorldReference(baseFrame);
      const trustedFrame = { ...baseFrame, ...(worldModel ? { worldModel } : {}) };
      if (canonicalJson(candidate.frame) !== canonicalJson(trustedFrame)) return false;
      // `playerNarration` changes only the provider-mode request binding. Use
      // a fixed syntactically valid receipt to reuse the full canonical
      // trace/settlement/character restore validator pre-dispatch.
      const publishable = structuredClone(checked.value);
      publishable.idempotency[publishable.idempotency.length - 1]!.response.action.playerNarration = {
        schemaVersion: "1.0.0",
        text: "Validated narration candidate.",
      };
      publishable.snapshotHash = compiledSessionSnapshotHash(publishable);
      return GameSession.validateCompiledSessionRestore(publishable, compiled.catalogBundle, this.#idRaw).status === "validated";
    } catch {
      return false;
    }
  }

  /** Receipt admission is a second, host-only boundary after model parsing.
   * It re-derives private current-scene visibility from the exact successor;
   * caller-provided frame/world-model/character text can never grant a fact. */
  #validateCompiledNarrationTextCanonical(
    candidate: CompiledNarrationCandidate,
    narration: { schemaVersion: "1.0.0"; text: string },
  ): boolean {
    try {
      if (!validCompiledPlayerNarration(narration) || !this.#validateCompiledNarrationCandidateCanonical(candidate)) return false;
      const checked = validateCompiledSessionSnapshot(candidate.snapshot);
      if (checked.status === "refused") return false;
      const era = this.#compiledNarrationReviewedEra();
      return checkNarrationText(narration.text, {
        ...(era ? { year: Number(era) } : {}),
        // Unknown compiled eras deliberately skip only year-ranged policy;
        // source visibility/privacy constraints remain active below.
        skipYearRangeWhenUnknown: true,
        undiscoveredClueKeys: this.#compiledNarrationUndiscoveredClueKeys(
          this.#compiledModule!.state,
          checked.value.state,
        ),
        sourceReviewedTechnologyTerms: this.#compiledNarrationSourceReviewedTechnologyTerms(
          this.#compiledModule!.state,
          checked.value.state,
        ),
      }) === null;
    } catch {
      return false;
    }
  }

  /** A v2 receipt may be consumed after its successor generation is live, so
   * it cannot use the current-generation candidate validator. Its mutable
   * ledger row must instead agree with the live idempotency anchor, which is
   * part of the trusted current snapshot. */
  #matchesCommittedNarrationCandidateCanonical(
    candidate: CompiledNarrationCandidate,
    prior: CompiledSessionIdempotencyRecord,
  ): boolean {
    try {
      const compiled = this.#compiledModule;
      if (!compiled?.durableBundle || candidate.schemaVersion !== "2.0.0"
        || candidate.sessionId !== this.#idRaw || candidate.bundleId !== compiled.durableBundle.id
        || !validHexHash(candidate.predecessorSnapshotHash) || !validHexHash(candidate.topicTokenHash)
        || !validHexHash(candidate.topicBindingHash) || !validHexHash(candidate.playerRequestHash)
        || candidate.candidateHash !== compiledNarrationCandidateHash(candidate)
        || candidate.nextGeneration !== candidate.expectedGeneration + 1
        || prior.actionId !== candidate.actionId || prior.expectedGeneration !== candidate.expectedGeneration
        || prior.generation !== candidate.nextGeneration) return false;
      const checked = validateCompiledSessionSnapshot(candidate.snapshot);
      if (checked.status === "refused" || checked.value.schemaVersion !== COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
        || checked.value.sessionId !== this.#idRaw || checked.value.bundle.id !== compiled.durableBundle.id
        || checked.value.bundle.bundleHash !== compiled.durableBundle.bundleHash
        || checked.value.generation !== candidate.nextGeneration
        || checked.value.previousSnapshotHash !== candidate.predecessorSnapshotHash
        || checked.value.idempotency.length !== candidate.nextGeneration) return false;
      const candidateRecord = checked.value.idempotency.at(-1);
      if (!candidateRecord || candidateRecord.actionId !== prior.actionId || candidateRecord.input !== prior.input
        || candidateRecord.requestHash !== prior.requestHash || candidateRecord.expectedGeneration !== prior.expectedGeneration
        || candidateRecord.generation !== prior.generation || candidateRecord.response.action.playerNarration !== undefined) return false;
      const anchor = prior.narrationTopic;
      const candidateAnchor = candidateRecord.narrationTopic;
      if (!anchor || !candidateAnchor || anchor.schemaVersion !== "1.0.0" || candidateAnchor.schemaVersion !== "1.0.0"
        || !sameHexHash(anchor.predecessorSnapshotHash, candidate.predecessorSnapshotHash)
        || !sameHexHash(anchor.topicTokenHash, candidate.topicTokenHash)
        || !sameHexHash(anchor.topicBindingHash, candidate.topicBindingHash)
        || !sameHexHash(anchor.playerRequestHash, candidate.playerRequestHash)
        || canonicalJson(anchor as unknown as JsonValue) !== canonicalJson(candidateAnchor as unknown as JsonValue)) return false;
      const current = [...this.#compiledIdempotency.values()];
      // A receipt from gN remains an exact duplicate at gN+2 and later. Its
      // candidate history must be a strict prefix of live history, not the
      // whole later history; the final candidate record is compared to the
      // live record for the same action below.
      if (current.length < candidate.snapshot.idempotency.length
        || current[candidate.expectedGeneration] !== prior) return false;
      for (let index = 0; index < candidate.snapshot.idempotency.length - 1; index += 1) {
        if (canonicalJson(current[index] as unknown as JsonValue) !== canonicalJson(candidate.snapshot.idempotency[index] as unknown as JsonValue)) return false;
      }
      const expectedRecord = cloneJson(prior);
      if (!expectedRecord.response.action.playerNarration) return false;
      delete expectedRecord.response.action.playerNarration;
      // The final candidate record must be the full private predecessor of
      // the live record, not merely an equal action response. This includes
      // character-before state and every future strictly-validated field.
      return canonicalJson(expectedRecord as unknown as JsonValue) === canonicalJson(candidateRecord as unknown as JsonValue);
    } catch {
      return false;
    }
  }

  #matchesCommittedNarrationReceiptCanonical(
    candidate: CompiledNarrationCandidate,
    narration: { schemaVersion: "1.0.0"; text: string },
    prior: CompiledSessionIdempotencyRecord,
  ): boolean {
    try {
      if (!this.#matchesCommittedNarrationCandidateCanonical(candidate, prior)) return false;
      const playerNarration = prior.response.action.playerNarration;
      return !!playerNarration
        && canonicalJson(playerNarration as unknown as JsonValue) === canonicalJson(narration as unknown as JsonValue);
    } catch {
      return false;
    }
  }

  /** Validate and publish one previously-durable exact candidate. It never
   * calls #prepareCompiledAction, so a restart cannot re-roll entropy or reset
   * the candidate timestamp. */
  #commitCompiledNarrationCanonical(
    candidate: CompiledNarrationCandidate,
    narration: { schemaVersion: "1.0.0"; text: string },
    persist: (snapshot: CompiledSessionSnapshot) => void,
  ): CompiledActionCommitResult {
    const compiled = this.#compiledModule;
    const generation = this.#compiledGeneration;
    if (!compiled || generation === null) return { status: "refused", code: "compiled_not_loaded", generation: 0 };
    if (!compiled.durableBundle || !compiled.catalogBundle || !compiled.snapshotHash) return { status: "refused", code: "compiled_action_contract_required", generation };
    if (this.#compiledFailStopped) return { status: "refused", code: "compiled_unavailable", generation };
    if (!validCompiledPlayerNarration(narration)) return { status: "refused", code: "compiled_narration_invalid", generation };
    const prior = typeof candidate?.actionId === "string" ? this.#compiledIdempotency.get(candidate.actionId) : undefined;
    if (prior) {
      if (candidate.schemaVersion === "2.0.0" && !this.#matchesCommittedNarrationReceiptCanonical(candidate, narration, prior)) {
        return { status: "refused", code: "compiled_narration_candidate_invalid", generation };
      }
      const request = candidate.snapshot?.idempotency?.find((record) => record.actionId === candidate.actionId);
      if (!request || request.input !== prior.input || request.expectedGeneration !== prior.expectedGeneration) return { status: "refused", code: "compiled_idempotency_conflict", generation };
      return { status: "duplicate", response: cloneJson(prior.response), generation };
    }
    if (!this.#validateCompiledNarrationTextCanonical(candidate, narration)) return { status: "refused", code: "compiled_narration_invalid", generation };
    try {
      if (!candidate || (candidate.schemaVersion !== "1.0.0" && candidate.schemaVersion !== "2.0.0") || candidate.sessionId !== this.#idRaw
        || candidate.bundleId !== compiled.durableBundle.id || candidate.expectedGeneration !== generation
        || candidate.nextGeneration !== generation + 1 || candidate.predecessorSnapshotHash !== compiled.snapshotHash
        || !validHexHash(candidate.playerRequestHash)
        || (candidate.schemaVersion === "2.0.0" && (!validHexHash(candidate.topicTokenHash) || !validHexHash(candidate.topicBindingHash)))
        || candidate.requestHash !== compiledActionRequestHash(candidate.snapshot.idempotency.at(-1)?.input ?? "", candidate.actionId, generation, "provider")
        || candidate.frameHash !== sha256(canonicalJson(candidate.frame))
        || candidate.candidateHash !== compiledNarrationCandidateHash(candidate)) {
        return { status: "refused", code: "compiled_narration_candidate_invalid", generation };
      }
      const checked = validateCompiledSessionSnapshot(candidate.snapshot);
      if (checked.status === "refused" || checked.value.schemaVersion !== COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
        || checked.value.generation !== candidate.nextGeneration || checked.value.previousSnapshotHash !== compiled.snapshotHash
        || checked.value.bundle.id !== compiled.durableBundle.id || checked.value.idempotency.length !== candidate.nextGeneration) {
        return { status: "refused", code: "compiled_narration_candidate_invalid", generation };
      }
      const record = checked.value.idempotency.at(-1);
      if (!record || record.actionId !== candidate.actionId || record.expectedGeneration !== generation
        || record.requestHash !== candidate.requestHash || record.response.schemaVersion !== COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION
        || record.response.action.playerNarration !== undefined) {
        return { status: "refused", code: "compiled_narration_candidate_invalid", generation };
      }
      if (candidate.schemaVersion === "2.0.0") {
        const anchor = record.narrationTopic;
        if (!anchor || anchor.schemaVersion !== "1.0.0"
          || !sameHexHash(anchor.predecessorSnapshotHash, candidate.predecessorSnapshotHash)
          || !sameHexHash(anchor.topicTokenHash, candidate.topicTokenHash)
          || !sameHexHash(anchor.topicBindingHash, candidate.topicBindingHash)
          || !sameHexHash(anchor.playerRequestHash, candidate.playerRequestHash)) {
          return { status: "refused", code: "compiled_narration_candidate_invalid", generation };
        }
      } else if (record.narrationTopic !== undefined) {
        return { status: "refused", code: "compiled_narration_candidate_invalid", generation };
      }
      const snapshot = structuredClone(checked.value);
      const finalRecord = snapshot.idempotency.at(-1)!;
      finalRecord.response.action.playerNarration = structuredClone(narration);
      snapshot.snapshotHash = compiledSessionSnapshotHash(snapshot);
      // A prepared candidate intentionally contains no model receipt yet.  It
      // therefore cannot pass the final request-hash validation until the
      // receipt has been bound to it.  Validate the exact publishable
      // successor here, rather than treating the private pre-fetch candidate
      // as a mechanics-only snapshot.
      const finalValidation = GameSession.validateCompiledSessionRestore(snapshot, compiled.catalogBundle, this.#idRaw);
      if (finalValidation.status === "refused") return { status: "refused", code: "compiled_narration_candidate_invalid", generation };
      persist(snapshot);
      this.#compiledFailStopped = true;
      return { status: "committed", response: cloneJson(finalRecord.response), generation: candidate.nextGeneration, snapshot };
    } catch (error) {
      if (error instanceof CompiledSessionSnapshotPersistenceError) {
        const code = error.code === "SNAPSHOT_CONFLICT" ? "compiled_generation_conflict"
          : error.code === "SNAPSHOT_BUSY" ? "compiled_persistence_busy"
            : error.code === "SNAPSHOT_QUOTA_EXCEEDED" ? "compiled_persistence_quota"
              : error.code === "SNAPSHOT_INDETERMINATE" ? "compiled_persistence_indeterminate"
                : "compiled_persistence_failed";
        return { status: "refused", code, generation };
      }
      return { status: "refused", code: "compiled_persistence_failed", generation };
    }
  }

  #actCompiled(input: string): ActionResponse {
    const prepared = this.#prepareCompiledAction(input);
    if (prepared.status === "refused") return this.#compiledFailure(prepared.code);
    this.#applyPreparedCompiledAction(prepared.value);
    this.#compiledGeneration = (this.#compiledGeneration ?? 0) + 1;
    return this.#preparedCompiledActionResponse(prepared.value, this.#compiledGeneration);
  }

  // ============================================================
  // PC 生命周期
  // ============================================================

  /**
   * 建一个 PC 的单一入口。
   *
   * ⚠ 之前有三条各不相同的路径（构造函数建 p1 / "创建角色" 重建 p1 /
   * "创建队友" 建 p2+），下面八件事没有一条路径全做齐：
   *   1. sanityEngines.set          2. SAN 取角色 POW（不是硬编码 50）
   *   3. world.registerPlayer       4. persistSanity
   *   5. session.join/switchActive  6. characters.set
   *   7. world.upsertEntity         8. careerStore 快照
   * "创建角色"不建 SanityEngine——新角色沿用旧角色的 maxSAN；"创建队友"
   * 硬编码 `new SanityEngine(50)`——不取角色真实 POW；"创建队友"不
   * upsertEntity——世界实体不存在，构造函数自己的注释写过这个后果："开局的
   * KP 伤害因为找不到实体而失败，getState() 的硬编码兜底又让面板照常显示
   * 12/12，两相抵消，谁都看不出来"。三条路径各缺各的，现在收成一条。
   *
   * @param pcId 目标 PC 的键。已存在则**整体重建**（新 SanityEngine 换掉
   *   旧的、新 sheet 换掉旧的）——不是合并更新。"创建角色"复用现有 pcId
   *   时用的就是这个语义：重建当前活跃 PC，不是"更新几个字段"。
   * @param sheet 角色卡（CoC/D&D 生成结果，不在这里挑类型）
   * @param opts.control 初始控制模式，默认 "auto"（同 CompanionState 的默认值，
   *   见 companion-manager.ts:74）——谁应该默认是 "player:xxx" 是消费方
   *   （L2/L3）的决定，这里不替它做主。
   * @returns 拒绝时给 `{ rejected }`（队伍已满，硬上限 10 人，见
   *   PARTY_HARD_LIMIT）；否则给 `{ member, warning? }`，`warning` 在人数
   *   超过模组推荐上限时给出，只播报不拦——"警告后放行，不拒绝"是本轮定的
   *   设计决策，且不实现任何按人数缩放的补偿（没有这类规则，硬造等于编）。
   */
  /**
   * 分配一个未被占用的 pcId（p1, p2, ...）。
   *
   * 根因修正：原本"创建队友"用 `this.#party.size + 1` 算 pid，但 `party`
   * 不是唯一持有 pcId 的地方——构造函数在**没有角色卡时**（没传 archetype）
   * 走空壳分支，往 `sanityEngines`/`world`/`session` 里注册了 "p1" 却**不**
   * 填 `party`。于是 `party.size` 为 0，`0 + 1 = p1`，队友的卡直接顶掉玩家
   * 自己的 p1 槽位（净效果：播报"加入了队伍"，实际是静默顶替）。
   *
   * 所以"占用"必须覆盖**所有**持有 pcId 的地方，取其并集——四个持有者任何
   * 一个短暂失同步都不该让分配复用到一个已占用的 id：
   *   · this.#party                （#createPartyMember 建的正式成员）
   *   · this.#sanityEngines       （空壳分支也建，见构造函数）
   *   · this.#playerSession      （PlayerSession 槽位，join/switchActive）
   *   · this.#worldRaw.getPlayerIds()（player_state 表，两条分支都 registerPlayer）
   * 用并集而不是只拿 `world.getPlayerIds()` 一份：虽然那是最完整的（空壳分支
   * 也调 registerPlayer），但这场 bug 的本质就是"各持有者会短暂失同步"——
   * 拿并集是与这个失败模式同构的防御（correct by construction），代价只是
   * 一次 O(成员数) 的扫表，这里成员数上限是 PARTY_HARD_LIMIT=10。
   *
   * 从 1 往上找第一个空位（不是"单调递增不复用"）：pcId 语义是"固定归属"，
   * 空壳槽位 p1、被重建的同 id PC 都不该被后建的人抢走。本轮没有删除入口，
   * PlayerSession.leave()（会销毁 messageHistory）不会被触发，所以"复用"
   * 不会真发生旧历史串到新 PC 上；即便将来加了删除，leave 时连 id 一起删，
   * 这里从 1 找空位仍然正确。
   */
  private nextFreePcId(): string {
    const used = new Set<string>();
    for (const id of this.#party.keys()) used.add(id);
    for (const id of this.#sanityEngines.keys()) used.add(id);
    for (const id of this.#playerSession.getAllNames()) used.add(id);
    for (const id of this.#worldRaw.getPlayerIds()) used.add(id);
    let n = 1;
    while (used.has(`p${n}`)) n++;
    return `p${n}`;
  }

  /**
   * 逐字段走兜底链（HTTP→模组→backgroundProfile 推导→LLM），结果落成一个
   * PlayerMeta。见 src/character/player-metadata.ts。
   *
   * web/session 这条路的客户端没接 ModulePlayerSetup（BARN_SUPPORT 无 players
   * 字段，恒空——见 module/types.ts:524 的注释），所以模组层在这条路上没有
   * 来源；真正有 ModulePlayerSetup 的是 play-module（剧本杀）那条路。LLM 步骤
   * 本路暂不注入生成器（真有 LLM 生成需求时由调用方提供），依赖 HTTP/推导层，
   * 故用同步版——三处建 PC 的地方（构造函数建 p1、addPartyMember、"创建角色"
   * 命令重建当前活跃 PC）都调这一个方法，不各自内联一份 resolvePlayerMetaSync。
   */
  private resolveMeta(http: PlayerMeta | undefined, sheet: any): PlayerMeta {
    return resolvePlayerMetaSync({
      http,
      profile: sheet?.backgroundProfile,
      module: undefined,
    });
  }

  /**
   * 把"职业"输入解析成 archetypeId —— 只在 cosmic-horror 规则集下生效。
   * `buildCharacterForRuleset` 只认英文 id（如 "journalist_coc"），中文
   * 显示名（"记者"）原样传进去会被判成未知职业——但"创建队友"这条文本命令
   * 只有中文语境，玩家没有理由知道内部 id。先按 id 精确匹配，查不到再按
   * `getCoCArchetypes()` 的 label 精确匹配；两者都查不到就原样返回，交给
   * 调用方的兜底判空处理。
   */
  private resolveOccupationId(input: string): string {
    if (this.#activeRulesetRaw !== "cosmic-horror") return input;
    if (getArchetype(input)) return input;
    const byLabel = getCoCArchetypes().find((a) => a.label === input);
    return byLabel ? byLabel.id : input;
  }

  /**
   * 为队伍新增一个 PC —— web 的 `POST /api/sessions/:id/party` 与文本命令
   * 「创建队友」共用（不掰成两套做法）。必须走到 #createPartyMember（单一入口，
   * 八件事一次做齐）；meta 经 resolveMeta 兜底链解析后挂到 PartyMember.meta，
   * 供后续把 PlayerAgent 接进 web 会话时读。
   *
   * ⚠ `buildCharacterForRuleset` 对未知职业会抛。原先这里没接，异常一路
   * 冒到 runAction 的外层 catch，变成裸 500——实跑「创建队友 记者 林娜」
   * （中文职业名不认）与「创建队友 林娜 记者」（参数顺序写反）两次都中。
   * 接住它，走 `{ rejected }` 这个已有形状（server.ts 已经把它翻成 400），
   * 消息里把正确用法与写反了怎么办都说清楚，不是只丢一句"未知职业: X"。
   */
  addPartyMember(
    name: string,
    archetypeId: string,
    meta?: PlayerMeta,
  ): { member: PartyMemberView; warning?: string } | PartyMemberCreationRejection {
    return this.#addPartyMemberCanonical(name, archetypeId, meta);
  }

  #addPartyMemberCanonical(
    name: string,
    archetypeId: string,
    meta?: PlayerMeta,
  ): { member: PartyMemberView; warning?: string } | PartyMemberCreationRejection {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return { rejected: "compiled_mutation_unsupported" };
    const resolvedArchetypeId = this.resolveOccupationId(archetypeId);
    let ch: any;
    try {
    ch = buildCharacterForRuleset(name, resolvedArchetypeId, this.#activeRulesetRaw, this.#characterRandomUnit);
    } catch (error) {
      if (error instanceof CharacterEntropyError) throw error;
      return {
        rejected: `未知职业「${archetypeId}」。用法：创建队友 <姓名> <职业>（先姓名后职业——`
          + `如果把这两个写反了就会看到这条报错）。用「职业列表」查看全部可用职业`
          + `（也可以直接用中文职业名，如"记者""侦探""医生"）。`,
      };
    }
    const pid = this.nextFreePcId();
    const result = this.#createPartyMember(pid, ch, { control: "auto" });
    if ("rejected" in result) return result;
    result.member.meta = this.resolveMeta(meta, result.member.sheet);
    this.#bumpFacadeMutationRevision();
    return { member: this.partyMemberView(result.member), ...(result.warning ? { warning: result.warning } : {}) };
  }

  /** Fold one compiled action into the receipt-backed pending CoC growth set. */
  #prepareCompiledSkillGrowth(
    selected: CompiledActionSelection,
    edge: MechanicsReachabilityEdge,
    after: MechanicsState,
    sourceCharacter: any,
    generation: number,
  ): { character: any; receipt: CompiledSkillGrowthReceipt; lines: string[] } {
    const compiled = this.#compiledModule!;
    const pendingBefore = [...compiled.pendingSkillGrowth].sort();
    const successful = new Set<string>();
    if (selected.outcome === "success") {
      const method = compiled.payload.mechanicsIR.discoveryMethods.find((candidate) => candidate.id === selected.mechanismId);
      if (method?.check?.kind === "skill") {
        const storageKey = resolveCoCSkillGrowthStorageKey(method.check.skill, sourceCharacter);
        if (isGrowableCoCSkill(sourceCharacter, storageKey)) successful.add(storageKey);
      }
    } else if (selected.outcome === "attack") {
      if (selected.combat.hit && isGrowableCoCSkill(sourceCharacter, "fighting")) successful.add("fighting");
      const counter = selected.combatLedger.enemy;
      if (counter && !counter.hit && counter.defenseRoll !== null
        && !["fail", "fumble"].includes(cocSuccessLevelForRoll(counter.defenseRoll, counter.targetDodge))
        && isGrowableCoCSkill(sourceCharacter, "dodge")) successful.add("dodge");
    }
    const successfulSkills = [...successful].sort();
    const pending = [...new Set([...pendingBefore, ...successfulSkills])].sort();
    const character = structuredClone(sourceCharacter);
    const settlements: CompiledSkillGrowthSettlement[] = [];
    const lines: string[] = [];
    const terminalEndingId = after.terminalEndingId ?? null;
    if (terminalEndingId !== null) {
      for (const skill of pending) {
        const outcome = applyCoCSkillGrowth(character, skill, compiledSkillGrowthRandom(this.#idRaw, compiled.payload.identity.mechanicsHash, edge.beforeStateHash, generation, edge.mechanismId, skill));
        settlements.push({ ...outcome });
        lines.push(outcome.increased
          ? `${character.name} ${outcome.display}: d100=${outcome.roll} > ${outcome.currentSkill}% => growth +${outcome.increase}%`
          : `${character.name} ${outcome.display}: d100=${outcome.roll} <= ${outcome.currentSkill}% => no growth`);
      }
    }
    const receipt: CompiledSkillGrowthReceipt = {
      schemaVersion: "1.0.0", generation, mechanismId: edge.mechanismId,
      beforeStateHash: edge.beforeStateHash, afterStateHash: edge.afterStateHash,
      sourceInterpretationIds: [...edge.sourceInterpretationIds].sort(), successfulSkills,
      pendingBefore, pendingAfter: terminalEndingId === null ? pending : [], terminalEndingId,
      settlements,
    };
    return { character, receipt, lines };
  }

  #createPartyMember(
    pcId: string,
    sheet: any,
    opts?: { control?: "auto" | `player:${string}` },
  ): { member: PartyMember; warning?: string } | PartyMemberCreationRejection {
    // Career records use the final character name as their identity, while
    // the runtime uses pcId. Two live pcIds with one name would overwrite one
    // Career leaf and produce a snapshot the validator rejects. Check before
    // any world/session/Career write; rebuilding this same pcId remains legal.
    const characterName = sheet?.name;
    if (typeof characterName === "string"
      && [...this.#characters.entries()].some(([existingPcId, existingSheet]) =>
        existingPcId !== pcId && existingSheet?.name === characterName)) {
      return {
        rejected: `Character name "${characterName}" is already bound to another PC`,
        reason: "duplicate_character_name",
      };
    }
    if (!this.#party.has(pcId) && this.#party.size >= PARTY_HARD_LIMIT) {
      return { rejected: `队伍已满（上限 ${PARTY_HARD_LIMIT} 人），无法再加入新角色。` };
    }

    // The WorldStateManager and PlayerSession are private to this GameSession,
    // so their versioned snapshots are exact component mementos for this
    // synchronous installation. Career files are deliberately not included.
    const worldBefore = this.#worldRaw.exportSnapshot();
    const sessionBefore = this.#playerSession.exportSnapshot();
    const mapEntry = <T>(map: Map<string, T>) => ({ present: map.has(pcId), value: map.get(pcId) });
    const skillGrowthMarksBefore = mapEntry(this.#skillGrowthMarksByPC);
    const sanityEngineBefore = mapEntry(this.#sanityEngines);
    const characterBefore = mapEntry(this.#characters);
    const partyBefore = mapEntry(this.#party);
    const moduleStartBefore = mapEntry(this.#moduleStartByPC);
    const woundsTreatedBefore = this.#woundsTreatedByPC.has(pcId);
    let careerPersistenceStarted = false;

    const restoreLocal = (): void => {
      const restoreMapEntry = <T>(map: Map<string, T>, entry: { present: boolean; value: T | undefined }) => {
        if (entry.present) map.set(pcId, entry.value!);
        else map.delete(pcId);
      };
      restoreMapEntry(this.#skillGrowthMarksByPC, skillGrowthMarksBefore);
      restoreMapEntry(this.#sanityEngines, sanityEngineBefore);
      restoreMapEntry(this.#characters, characterBefore);
      restoreMapEntry(this.#party, partyBefore);
      restoreMapEntry(this.#moduleStartByPC, moduleStartBefore);
      if (woundsTreatedBefore) this.#woundsTreatedByPC.add(pcId);
      else this.#woundsTreatedByPC.delete(pcId);
    };

    try {
      // A replacement is a new character behind the same controller identity;
      // successful-use marks from the retired sheet must never grow the replacement.
      // A late join has no entry too, without allocating an empty owner record.
      this.clearSkillGrowthMarks(pcId);
      this.clearWoundTreatmentEligibility(pcId);
      const san = new SanityEngine(sheet?.attributes?.power ?? 50);
      this.#sanityEngines.set(pcId, san);
      this.#characters.set(pcId, sheet);
      this.#worldRaw.registerPlayer(pcId);
      this.#persistSanity(pcId);

    // 注册/切换到会话槽位——已存在则只切换，不重复 join（PlayerSession.join
    // 撞见已存在的 key 会抛异常，join 的 key 是 pcId 不是角色名，两个角色
    // 重名不会撞这个异常，只有 pcId 撞了才会，而 pcId 在这个入口里由调用方
    // 保证唯一/或走"重建同一个 pcId"的路径，所以这里的 has 检查已经够）。
      if (!this.#playerSession.get(pcId)) {
        try {
          this.#playerSession.join(pcId, sheet?.name ?? "调查员", pcId);
        } catch { /* 理论上不会发生：上面刚判过不存在 */ }
      } else {
        this.#playerSession.switchActive(pcId);
      }

      // 角色卡与世界实体必须同时诞生，见方法头注释引用的构造函数原话。
      this.#worldRaw.upsertEntity({
        id: pcId,
        name: sheet?.name ?? "调查员",
        type: "pc",
        hp: sheet?.hp ?? 12,
        maxHp: sheet?.maxHp ?? 12,
        // CoC 规则下 getState() 本就把对外的 ac 覆盖成 0；D&D 侧按角色卡算。
        ac: this.#activeRulesetRaw === "cosmic-horror" ? 10 : CharacterFactory.computeAC(sheet),
        status: [],
        position: this.#worldRaw.getCurrentState().scene ?? "unknown",
        // 角色卡是玩家属性的来源；世界实体是战斗裁决的持久输入投影。复制已有
        // 值而非写默认 CON，确保 CON 缺失仍能由 RulesEngine 显式 unresolved。
        attributes: sheet?.attributes ? { ...sheet.attributes } : undefined,
      });

      // Transient hosts retain only the in-memory character installation. A
      // durable Career base is an external write and therefore belongs only
      // to durable hosts (or their trusted action transaction).
      if (this.#careerEntryPersistence !== "transient") {
        // Career persistence is an independent file boundary: after this starts,
        // a later failure must fail-stop rather than claim cross-file rollback.
        careerPersistenceStarted = true;
        this.#persistCareerSnapshot(sheet, san);
      }

      const member: PartyMember = { pcId, sheet, san, control: opts?.control ?? "auto" };
      this.#party.set(pcId, member);
      this.captureLateOrdinaryModuleStart(pcId);

      const rec = this.recommendedPartySize();
      const warning = rec && this.#party.size > rec.max
        ? `模组推荐 ${rec.min}~${rec.max} 人，当前 ${this.#party.size} 人。`
        : undefined;
      return { member, warning };
    } catch (error) {
      let compensationFailed = false;
      if (!careerPersistenceStarted) {
        try { this.#worldRaw.restoreSnapshot(worldBefore); } catch { compensationFailed = true; }
        try { this.#playerSession.restoreSnapshot(sessionBefore); } catch { compensationFailed = true; }
      }
      try { restoreLocal(); } catch { compensationFailed = true; }
      if (careerPersistenceStarted || compensationFailed) this.#failStopDirectAction();
      throw error;
    }
  }

  /** Every career entry point shares this runtime-private session-scoped storage root. */
  #careerSessionDirectory(): string {
    const root = this.#careerRoot ?? process.env.__CAREER_DIR ?? join("data", "careers");
    return join(root, this.#idRaw);
  }

  #ensureCareerStore(): CareerFileStore {
    if (this.#careerStoreRaw === null) {
      this.#careerStoreRaw = new CareerFileStore(this.#careerSessionDirectory());
      this.#careerStoreFacade = GameSession.careerStoreReadFacade(() => {
        if (this.#npcStoreClosed) throw new Error("closed GameSession cannot read CareerFileStore");
        return this.#careerStoreRaw!;
      });
    }
    return this.#careerStoreRaw;
  }

  /**
   * Career files are a target-local projection, not part of the portable
   * session envelope.  Recreating their base records from restored character
   * truth keeps later ending/advancement branches from silently losing their
   * durable output while deliberately retaining no source-machine history.
   */
  #persistCareerSnapshot(sheet: any, san: SanityEngine): void {
    this.#ensureCareerStore().saveSnapshot({
      characterName: sheet?.name ?? "调查员",
      occupation: getArchetype(sheet?.archetypeId ?? sheet?.archetype)?.label ?? sheet?.archetypeId ?? sheet?.archetype ?? "investigator",
      attributes: { ...(sheet?.attributes ?? {}) },
      skills: sheet?.skillValues ? { ...sheet.skillValues } : {},
      san: san.state.currentSAN,
      maxSan: san.state.maxSAN,
      cthulhuMythos: san.state.cthulhuMythos ?? 0,
      hp: sheet?.hp ?? 12,
      maxHp: sheet?.maxHp ?? 12,
      creditRating: sheet?.creditRating ?? 30,
      createdAt: new Date().toISOString(),
      });
  }

  /**
   * Return the one ordinary module that can authorise a player-facing
   * settlement.  The registry and loaded marker are separate legacy stores,
   * so their cardinality and identity must agree before either can stand in
   * for a published module.
   */
  private publishedOrdinaryModuleForSettlement(): LoadedModule | null {
    if (this.#compiledModule || this.#registeredModules.length !== 1 || this.#loadedModules.size !== 1) return null;
    const module = this.#registeredModules[0];
    return module && this.#loadedModules.get(module.id) === true ? module : null;
  }

  /** True only after one coherent ordinary module has been published for play. */
  private hasPublishedOrdinaryModule(): boolean {
    return this.publishedOrdinaryModuleForSettlement() !== null;
  }

  /** Record one PC's actual state when it joins an already published ordinary module. */
  private captureLateOrdinaryModuleStart(pcId: string): void {
    if (!this.hasPublishedOrdinaryModule()) return;
    const sanity = this.#sanityEngines.get(pcId);
    if (!sanity) {
      log.warn("career", `ordinary module start missing SAN engine for ${pcId}`);
      return;
    }
    this.#moduleStartByPC.set(pcId, {
      san: sanity.state.currentSAN,
      cm: sanity.state.cthulhuMythos ?? 0,
      });
  }

  /**
   * Commit starts only after an ordinary module and its entry scene have both
   * been published. Snapshot restoration deliberately does not call this:
   * the portable snapshot remains the authority for its historical start.
   */
  private capturePublishedOrdinaryModuleStarts(): void {
    if (!this.hasPublishedOrdinaryModule()) return;
    this.#moduleStartByPC.clear();
    for (const [pcId, character] of this.#characters) {
      if (!character) continue;
      this.captureLateOrdinaryModuleStart(pcId);
    }
  }

  /**
   * One source of truth for career deltas. A missing start is never guessed:
   * neither explicit settlement nor an ordinary departure may invent a
   * maxSAN/zero baseline and write a fabricated career record.
   */
  private moduleCareerDelta(
    pcId: string,
    sanity: SanityEngine | undefined,
  ): { sanChange: number; cmChange: number } | null {
    if (!sanity) return null;
    const baseline = this.#moduleStartByPC.get(pcId);
    if (!baseline) return null;
    return {
      sanChange: sanity.state.currentSAN - baseline.san,
      cmChange: (sanity.state.cthulhuMythos ?? 0) - baseline.cm,
    };
  }

  /**
   * 当前加载的模组推荐几个玩家，解析不出来给 null（不警告，不是"猜一个"）。
   *
   * 步骤 5C 后，谷仓 ModuleData 直接进入 registeredModules，因此可直接读
   * meta.playerCount；仍走 MythosModule 的其它模组没有该字段，返回 null。
   */
  private recommendedPartySize(): { min: number; max: number } | null {
    const module = this.#registeredModules.find((entry) => isModuleData(entry) && entry.id === "premiers_barn");
    if (module && isModuleData(module)) return parsePlayerCountRange(module.meta.playerCount);
    return null;
  }

  // ============================================================
  // 基础 getter
  // ============================================================

  getSummary(): SessionSummary {
    this.#assertSessionReadable();
    return this.#summaryProjection();
  }

  #summaryProjection(): SessionSummary {
    const state = this.#worldRaw.getCurrentState();
    const msgs = this.#playerSession.getActiveHistory();
    const npcCount = this.#compiledModule
      ? this.#compiledModule.projection.module.npcs.length
      : Object.values(state.entities).filter(e => e.type === "npc").length;
    const summaryCharacter = this.#compiledModule ? this.#characters.get("p1") : this.#activeCharacterRaw;
    return {
      id: this.#idRaw, round: this.#roundRaw, ruleset: this.#activeRulesetRaw,
      scene: this.#sceneDisplayNames[state.scene] ?? state.scene,
      playerName: summaryCharacter?.name ?? "调查员",
      // 两种角色形状的职业字段名不同：CoC 是 archetypeId，D&D 是 archetype（字符串 id）。
      // 原写法统一取 .id —— 对 undefined 和对字符串取 .id 都是 undefined，
      // 因此这个字段一直恒为 null。
      archetype: summaryCharacter?.archetypeId ?? summaryCharacter?.archetype ?? null,
      messageCount: msgs.length, npcCount, createdAt: this.#createdAtRaw,
      ...(this.#compiledModule ? { generation: this.#compiledGeneration ?? 0 } : {}),
    };
  }

  /** Public ordinary terminal truth for HTTP reconciliation and durable receipts. */
  getOrdinaryTerminal(): OrdinarySessionTerminal {
    this.#assertSessionReadable();
    return this.#compiledModule ? null : this.#ordinaryTerminalProjection();
  }

  /** Detached, immutable terminal value for public response and reconciliation surfaces. */
  #ordinaryTerminalProjection(): OrdinarySessionTerminal {
    return this.#ordinaryTerminal === null ? null : detachedFrozenProjection(this.#ordinaryTerminal);
  }

  #ordinaryTerminalState(): OrdinarySessionTerminal {
    return this.#ordinaryTerminal;
  }

  /**
   * The only ordinary terminal mutation point. `dead` is derived from this
   * value, so its terminal reason and public compatibility flag change as one
   * state transition rather than as independently writable fields.
   */
  #setOrdinaryTerminal(terminal: OrdinarySessionTerminal): void {
    if (terminal === null) {
      this.#ordinaryTerminal = null;
      return;
    }
    this.#ordinaryTerminal = terminal.kind === "module_departure"
      ? { kind: "module_departure", endingId: terminal.endingId, endingName: terminal.endingName }
      : { kind: terminal.kind };
  }

  #ordinarySessionIsTerminal(): boolean {
    return this.#ordinaryTerminalState() !== null;
  }

  #ordinaryTerminalActionMessage(): string {
    const terminal = this.#ordinaryTerminalState();
    if (terminal?.kind === "death") return "你已经死了。请重新开始。";
    if (terminal?.kind === "module_departure") return `本次调查已结束：${terminal.endingName}。请重新开始。`;
    return "本次会话已结束，原因来自旧版本记录，无法安全判定。请重新开始。";
  }

  /**
   * Luck has one active-character authority. Public projections may expose it
   * only when that authority proves the CoC 0..99 invariant; compiled and
   * unsupported rulesets deliberately omit it instead of manufacturing a UI
   * default.
   */
  #ordinaryLuckProjection(): number | undefined {
    if (this.#compiledModule || this.#activeRulesetRaw !== "cosmic-horror") return undefined;
    const luck = this.#activeCharacterRaw?.luck;
    return Number.isSafeInteger(luck) && luck >= 0 && luck <= 99 ? luck : undefined;
  }

  #stateProjection(): ActionResponse["state"] {
    const state = this.#worldRaw.getCurrentState();
    // KP setter 和角色卡以 activePlayerId（默认 p1）为主键写入；这里若固定
    // 读 "player"，会读到移动流程懒建的另一份实体，面板就永远显示旧 HP。
    //
    // 且不能只从 state.entities 取：getCurrentState() 走 getAllAliveEntities()，
    // 玩家 HP 归零后就从快照里消失，于是落到下面的兜底值，KP 把 PC 打死、
    // 面板反而显示满血 12/12。玩家自身的状态必须始终可读，与存活无关，
    // 所以死亡时回退到不过滤存活的 getEntity()。NPC / 怪物那边的存活过滤保持原样。
      const playerEnt = state.entities[this.#activePlayerId] ?? this.#worldRaw.getEntity(this.#activePlayerId);
    // 在场名单必须限定在玩家当前场景，与 injectWorldModelForScene() 的事实口径一致；
    // 否则前端会把模组里所有 NPC 都显示为「在场」，与 KP 叙事互相矛盾。
    // 位置同时写在 scene_id 与 position 两个字段（setPlayerHp 只写 position），故取并集。
    const pos = state.scene;
    const present = new Map<string, WorldEntity>();
    for (const e of this.#worldRaw.getEntitiesInScene(pos)) present.set(e.id, e);
    for (const e of Object.values(state.entities)) {
      if (e.position === pos) present.set(e.id, e);
    }
    const inScene = [...present.values()];
    const npcs = this.#compiledModule
      ? compiledProjectionNpcView(this.#compiledModule.projection, this.#compiledModule.payload.mechanicsIR, this.#compiledModule.state.currentSceneId)
      : inScene.filter(e => e.type === "npc" && (e.hp > 0 || e.status.includes("narrative_noncombat")));
    const monsters = this.#compiledModule
      ? compiledProjectionMonsterView(this.#compiledModule.projection, this.#compiledModule.payload.mechanicsIR, this.#compiledModule.state, this.#compiledModule.state.currentSceneId)
      : inScene.filter(e => e.type === "monster" && e.hp > 0);
    // 同伴的血量/位置在世界实体上，CompanionState 只持有 entityId。
    // 此前直接读 c.hp / c.position，两者都不存在，返回给前端的一直是 undefined。
    const comps = this.#companionManagerRaw.getActiveCompanions().map(c => {
      const ent = this.#worldRaw.getEntity(c.entityId);
      return {
        id: c.config.id, name: c.config.name, hp: ent?.hp ?? 0, maxHp: c.config.maxHp,
        ac: c.config.ac, morale: c.morale, behavior: c.behavior, control: c.control,
        position: ent?.position ?? "", inventory: [...c.inventory], motivation: c.config.motivation,
        traits: c.config.traits ? { ...c.config.traits } : null,
        skills: c.config.skills ? { ...c.config.skills } : null,
        resolveState: c.resolveState,
      };
    });
    const compiledItems = this.#compiledModule
      ? compiledProjectionItemView(this.#compiledModule.projection, this.#compiledModule.state, this.#compiledModule.state.currentSceneId)
      : undefined;
    const luck = this.#ordinaryLuckProjection();
    return {
      // 床只认同一行里发出去的 scene。读玩家 position 会在 KP 手动切场景时分叉
      // —— #setSceneCanonical() 只翻 is_active、不动玩家实体，界面显示教堂、耳朵里却还是
      // 码头的浪声。这里也不许回落到 position：显示的场景没有床时，正确答案是
      // 没有床（前端静默），拿别处的床顶上只是把同一个错误换个形式犯。
      scene: state.scene, bgm: this.#sceneBgm[state.scene], round: this.#roundRaw,
      player: playerEnt
        ? {
          name: playerEnt.name, hp: playerEnt.hp, maxHp: playerEnt.maxHp,
          ac: this.#activeRulesetRaw === "cosmic-horror" ? 0 : playerEnt.ac,
          status: playerEnt.status,
          ...(luck === undefined ? {} : { luck }),
        }
        : {
          name: "调查员", hp: 12, maxHp: 12, ac: 0, status: [],
          ...(luck === undefined ? {} : { luck }),
        },
      npcs: this.#compiledModule ? npcs : npcs.map(e => ({ name: e.name, hp: e.hp, maxHp: e.maxHp, status: e.status })),
      monsters: monsters.map(e => ({ name: e.name, hp: e.hp, maxHp: e.maxHp, status: e.status })),
      companions: comps,
      ...(compiledItems ? { inventory: compiledItems.inventory, sceneItems: compiledItems.sceneItems } : {}),
      party: [...this.#party.entries()].map(([pcId, m]) => {
        const ent = this.#worldRaw.getEntity(pcId);
        return {
          pcId,
          name: m.sheet?.name ?? "调查员",
          control: m.control,
          hp: ent?.hp ?? m.sheet?.hp ?? 12,
          maxHp: ent?.maxHp ?? m.sheet?.maxHp ?? 12,
          status: ent?.status ?? [],
          san: m.san.state.currentSAN,
          maxSan: m.san.state.maxSAN,
        };
      }),
      // 与 getKPState():1257 同一口径——不新造一种时间表示。
      gameTime: { day: this.#gameTime.day, period: this.#gameTime.period, label: formatGameTime(this.#gameTime) },
    };
  }

  /** Public observation wrapper; ordinary execution uses #stateProjection directly. */
  getState(): ActionResponse["state"] {
    this.#assertSessionReadable();
    return this.#stateProjection();
  }

  #sanityProjection() {
    return {
      currentSAN: this.#sanityRaw.state.currentSAN,
      maxSAN: this.#sanityRaw.state.maxSAN,
      temporaryInsanity: this.#sanityRaw.state.temporaryInsanity,
      indefiniteInsanity: this.#sanityRaw.state.indefiniteInsanity,
      phobias: [...this.#sanityRaw.state.phobias],
    };
  }

  /** Public observation wrapper; ordinary execution uses #sanityProjection directly. */
  getSanity() {
    this.#assertSessionReadable();
    return this.#sanityProjection();
  }

  getCharacterSummary(): any {
    this.#assertSessionReadable();
    if (!this.#activeCharacterRaw) return null;
    const c = this.#activeCharacterRaw;
    const luck = this.#ordinaryLuckProjection();
    return {
      name: c.name, archetype: c.archetype?.label ?? c.archetypeId ?? c.archetype,
      attributes: { ...c.attributes }, hp: c.hp, maxHp: c.maxHp,
      // computeAC 是 D&D 的 10+DEX修正；CoC 的 DEX 是百分制，套进去会得出 30 以上的
      // 荒唐护甲值。CoC 不用 AC，与 getState() 一样对外给 0。
      ac: this.#activeRulesetRaw === "cosmic-horror" ? 0 : CharacterFactory.computeAC(c),
      skills: { ...(c.skills ?? c.skillValues ?? {}) },
      totalLevel: c.totalLevel,
      ...(luck === undefined ? {} : { luck }),
    };
  }

  /**
   * Owner-only ordinary character-card read model.  This intentionally does
   * not compose the legacy public summary, active-character getter, or an
   * exported snapshot: all of those are compatibility observations that a
   * JavaScript caller can shadow.  The HTTP route consumes this sealed method
   * after its envelope/owner gate has selected an authoritative live session.
   */
  getOrdinaryCharacterEditorProjection(): {
    pcId: string;
    summary: SessionSummary;
    character: Record<string, OrdinarySnapshotJson>;
    inventory: string[];
    weapons: string[];
    sanity: ReturnType<GameSession["getSanity"]>;
  } {
    this.#assertSessionReadable();
    if (this.#compiledModule) throw new Error("compiled sessions have no ordinary character projection");
    const pcId = this.#activePlayerId;
    const character = this.#characters.get(pcId);
    const partyMember = this.#party.get(pcId);
    const activeSlot = this.#playerSession.getActive();
    const sanity = this.#sanityEngines.get(pcId);
    const entity = this.#worldRaw.getEntity(pcId);
    // The active cohort is an atomic runtime invariant. A read must refuse an
    // inconsistent cohort rather than silently falling back to p1 or mixing a
    // character from one PC with another PC's world inventory.
    if (!character
      || character !== this.#activeCharacterRaw
      || partyMember?.sheet !== character
      || activeSlot?.name !== pcId
      || activeSlot.characterId !== pcId
      || sanity !== this.#sanityRaw
      || !entity
      || entity.type !== "pc"
      || entity.hp !== character.hp
      || entity.maxHp !== character.maxHp) {
      throw new Error("ordinary active character projection is inconsistent");
    }

    const skills = this.#ordinaryCharacterEditorNumberRecord(character.skillValues ?? character.skills, "skills", 0, 100);
    const attributes = this.#ordinaryCharacterEditorNumberRecord(character.attributes, "attributes", 1, 100, COC_EDITABLE_CHARACTER_ATTRIBUTES);
    const hp = this.#ordinaryCharacterEditorInteger(character.hp, "hp", 0, 999);
    const maxHp = this.#ordinaryCharacterEditorInteger(character.maxHp, "maxHp", 1, 999);
    const luck = this.#ordinaryCharacterEditorInteger(character.luck, "luck", 0, 99);
    const creditRating = this.#ordinaryCharacterEditorInteger(character.creditRating, "creditRating", 0, 99);
    if (hp > maxHp || typeof character.name !== "string" || !character.name || Array.from(character.name).length > 256
      || typeof character.archetypeId !== "string" || !character.archetypeId || Array.from(character.archetypeId).length > 256) {
      throw new Error("ordinary active character projection is invalid");
    }
    const inventory = this.#ordinaryCharacterEditorStringList(this.#worldRaw.getPlayerInventory(pcId), "inventory");
    const weapons = this.#ordinaryCharacterEditorStringList(this.#worldRaw.getPlayerWeapons(pcId), "weapons");
    // This is the complete editable sheet, deliberately distinct from broad
    // internal character/career state. JSON round-tripping below removes
    // aliases and non-JSON prototypes before the owner client receives it.
    const projection = {
      pcId,
      summary: this.#summaryProjection(),
      character: {
        name: character.name,
        archetype: character.archetypeId,
        hp,
        maxHp,
        luck,
        creditRating,
        skills,
        attributes,
      },
      inventory,
      weapons,
      sanity: this.#sanityProjection(),
    };
    let wire: string;
    try { wire = JSON.stringify(projection); }
    catch { throw new Error("ordinary active character projection is not JSON-safe"); }
    // Owner reads are bounded just like owner writes. The ordinary character
    // request codec is 8 KiB; leave ample room for a complete generated sheet
    // while refusing an accidental unbounded world projection.
    if (new TextEncoder().encode(wire).byteLength > 64 * 1024) {
      throw new Error("ordinary active character projection exceeds its response budget");
    }
    return JSON.parse(wire) as {
      pcId: string;
      summary: SessionSummary;
      character: Record<string, OrdinarySnapshotJson>;
      inventory: string[];
      weapons: string[];
      sanity: ReturnType<GameSession["getSanity"]>;
    };
  }

  #ordinaryCharacterEditorStringList(value: unknown, field: "inventory" | "weapons"): string[] {
    if (!Array.isArray(value) || value.length > 4096
      || value.some((entry) => typeof entry !== "string" || Array.from(entry).length > 512)) {
      throw new Error(`ordinary active character ${field} is invalid`);
    }
    return [...value];
  }

  #ordinaryCharacterEditorInteger(value: unknown, field: string, minimum: number, maximum: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`ordinary active character ${field} is invalid`);
    }
    return value;
  }

  #ordinaryCharacterEditorNumberRecord(
    value: unknown,
    field: "skills" | "attributes",
    minimum: number,
    maximum: number,
    allowedKeys?: ReadonlySet<string>,
  ): Record<string, number> {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) {
      throw new Error(`ordinary active character ${field} is invalid`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(value);
    if (names.length > 256 || names.some((key) => !key || key === "__proto__" || key === "prototype" || key === "constructor" || Array.from(key).length > 128
      || allowedKeys !== undefined && !allowedKeys.has(key)
      || !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) {
      throw new Error(`ordinary active character ${field} is invalid`);
    }
    const output: Record<string, number> = {};
    for (const key of names) Object.defineProperty(output, key, {
      value: this.#ordinaryCharacterEditorInteger(descriptors[key]!.value, `${field}.${key}`, minimum, maximum),
      enumerable: true, configurable: true, writable: true,
    });
    return output;
  }

  getHistory(limit?: number) {
    this.#assertSessionReadable();
    return this.#historyProjection(limit);
  }

  /** Canonical active-player history for internal consumers such as NPC prompts. */
  #historyProjection(limit?: number) {
    const msgs = this.#playerSession.getActiveHistory();
    // 恢复会话时前端也要能放预制音频，所以历史这一路同样带上键。
    // 键是内容的纯函数，不进存档 —— 存了反而会在文案改动后指向旧音频。
    const slice = msgs.slice(-(limit ?? msgs.length)).map(m => {
      const key = voiceKeyFor(m);
      const snapshot = structuredClone(m);
      return key ? { ...snapshot, voiceKey: key } : snapshot;
    });
    return { messages: slice, total: msgs.length };
  }

  /**
   * 按 pcId 取历史——PlayerSession.getPlayerHistory(pcId) 早就有，但 HTTP
   * 只接得到 getActiveHistory()（恒返回当前活动玩家），外部永远看不到别的
   * PC 的历史。这是线索私密（discoverer_only）能被验证的前提：p1 掷出的
   * 线索只进 p1 的 messageHistory，不靠这个方法就没人能从 HTTP 侧确认。
   *
   * pcId 是否存在（join 过 PlayerSession）由调用方（server.ts）用
   * `session.get(pcId)` 先判——未知 pcId 要结构化 4xx，不能悄悄返回空数组，
   * 那和"这个人根本没有历史"从外部长得一模一样，是本仓反复吃亏的
   * "静默失效"。这里不做判断，只管取数据，判断权交给路由层（与
   * getKPState/setPlayerSan 等既有方法一样，校验发生在 API 边界）。
   */
  getPlayerHistory(pcId: string, limit?: number) {
    this.#assertSessionReadable();
    const msgs = this.#playerSession.getPlayerHistory(pcId);
    const slice = msgs.slice(-(limit ?? msgs.length)).map(m => {
      const key = voiceKeyFor(m);
      const snapshot = structuredClone(m);
      return key ? { ...snapshot, voiceKey: key } : snapshot;
    });
    return { messages: slice, total: msgs.length };
  }

  /**
   * 尾部可选项收成一个对象，而不是继续往后加位置参数。
   *
   * 之前是六个位置参数，写到 `addMessage(s, c, t, "public", undefined, true)`
   * 才能标一个 verbatim —— 中间那两个占位纯粹是为了够到最后一位。
   * 每加一种消息属性就再加一位，调用点会越来越难读，也越来越容易传错位置。
   */
  addMessage(
    speaker: string,
    content: string,
    type: MessageType = "dialogue",
    opts: {
      visibility?: VisibilityRule;
      discoverer?: string;
      /**
       * 内容为模组原文逐字输出（非 LLM 生成）时置 true。
       * 只在为真时写入字段，避免每条消息都带 `verbatim: false` 污染存档。
       */
      verbatim?: boolean;
      /**
       * 说这句话时的情绪，必须由调用方在生成时刻取。
       * mood 是状态机，事后回查 NPCAgent 拿到的是那时的情绪而非说这句话时的情绪，
       * 历史回放更是必然错位 —— 所以它只能随消息一起固定下来。
       */
      mood?: NPCMood;
    } = {}
  ) {
    this.#addMessageCanonical(speaker, content, type, opts);
  }

  #addMessageCanonical(
    speaker: string,
    content: string,
    type: MessageType = "dialogue",
    opts: {
      visibility?: VisibilityRule;
      discoverer?: string;
      verbatim?: boolean;
      mood?: NPCMood;
    } = {}
  ) {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return;
    this.#playerSession.push(
      {
        speaker,
        content,
        type,
        ...(opts.verbatim ? { verbatim: true } : {}),
        ...(opts.mood ? { mood: opts.mood } : {}),
      },
      opts.visibility ?? "public",
      opts.discoverer
    );
    this.#bumpFacadeMutationRevision();
  }

  /**
   * 回合出口。这里是两条互不相交的链路唯一交汇的地方，改动时请分别对待：
   *
   * - **消息链路**（verbatim 模组原文标记）：turnMessages → events，以及
   *   addMessage → PlayerSession.messageHistory → GET /history。
   *   注意模组开场白走的是后者：MythosModuleLoader 经 host.addMessage 直接入
   *   messageHistory，不进 turnMessages，因此它只出现在 /history 里，
   *   当回合的 events 中没有 verbatim 项——这是预期，不是丢标记。
   *   前端两条路径都读（action 读 ev.verbatim，恢复会话读 m.verbatim）。
   * - **状态链路**（真相源迁移阶段 1）：persistSanity() 把本回合内 SanityEngine
   *   就地改动的 state 落到 WorldStateManager。SAN/背包/武器/护甲的权威值在库里，
   *   不在进程内 Map。
   *
   * 两者不共享数据，只共享这一个调用点：消息不承载状态，状态不进消息体。
   */
  /**
   * 正在进行的回合的消息数组，act() 期间有值，回合出口清空。
   *
   * 模组宿主适配器需要它：加载器经 host.addMessage 产出的开场白与提示，
   * 原先直接写进会话历史，不进本回合的 turnMessages，于是 events 里没有它们——
   * 前端只渲染 events，玩家在实盘里根本看不到模组开场白，要等下次恢复会话
   * 读 /history 才出现。而开场白恰恰是加载那一刻最该被读到的一段。
   */
  #turnMessages: AgentMessage[] | null = null;

  #buildActionResponse(turnMessages: AgentMessage[]): ActionResponse {
    // 回合结束，宿主适配器不应再往这一轮投消息
    this.#turnMessages = null;
    // This is an in-flight action aid, not persistent status.  Leaving even
    // an empty array behind made a completed ordinary turn indistinguishable
    // from a mid-turn export and permanently blocked portable snapshots.
    this.#actingStatusesBeforeTick = undefined;
    // 回合出口统一落库：本回合内 SanityEngine 就地改动的 state 在此刻进入真相源。
    this.#persistSanity();

    // 回合消息入会话历史。act() 只把玩家行动、KP 叙述、系统提示攒在局部数组里，
    // 此前它们从不经过 session.push()，导致 GET /history 与 getSummary().messageCount
    // 在正常跑团后恒空——前端恢复会话拿到空日志，语音层也读不到要念的内容。
    //
    // 写在回合出口而不是每个 turnMessages.push() 处：出口是唯一汇合点，act() 的
    // 每条返回路径都经过它，逐点改 20 余处既冗余又易漏。代价是回合内顺序——
    // 经 addMessage() 直入历史的消息（模组开场白、流血提示）按各自写入时刻排，
    // 回合消息统一排在其后。彻底统一属于 docs/voice-readiness.md §六 第 2 步
    // 「addMessage 尾参收成 options 对象」那次重构的范围，不在此处提前做。
    //
    // 按每条消息自带的 visibility/discoverer 路由（见 AgentMessage 的字段
    // 注释与 resolveSceneClue 的用法），不再统一按 public 处理——线索揭示
    // 靠这一步才真正只进发现者的 messageHistory。没带这两个字段的消息
    // （绝大多数）走 push() 的默认参数，行为与改动前完全一致。
    for (const m of turnMessages) this.#playerSession.push(m, m.visibility ?? "public", m.discoverer);

    const state = this.#stateProjection();
    return {
      narrative: this.#lastNarrative,
      events: turnMessages.map(m => {
        const key = voiceKeyFor(m);
        return {
          speaker: m.speaker, content: m.content, type: m.type,
          ...(m.verbatim ? { verbatim: true as const } : {}),
          ...(key ? { voiceKey: key } : {}),
        };
      }),
      state,
      dead: this.#compiledModule ? !!this.#compiledModule.state.terminalLoss : this.#ordinaryTerminalState()?.kind === "death",
      terminal: this.#ordinaryTerminalProjection(),
      sanity: this.#sanityProjection(),
      dice: this.#lastDiceRoll
        ? detachedFrozenProjection([this.#lastDiceRoll])
        : undefined,
    };
  }

  getPlayerPosition(): string {
    this.#assertSessionReadable();
    return this.#playerPositionProjection();
  }

  #playerPositionProjection(): string {
    const state = this.#worldRaw.getCurrentState();
    return state.entities[this.#activePlayerId]?.position ?? state.scene ?? "tavern";
  }

  /**
   * 界面正在显示的场景 —— 「现在演到哪里」的真相源。
   *
   * 与 getPlayerPosition() 分工明确：KP 切场景只翻 scenes.is_active、不移动玩家实体，
   * 两者因此会分叉，这是既定设计（scene-bgm.test.ts 专门锁住了这一点）。
   *
   * 凡是回答「此刻这里有谁、有什么可查」的地方都必须跟显示的场景。此前它们读的是
   * 玩家位置，而玩家一旦移动过，移动流程就会留下一个 "player" 实体把位置钉在原地，
   * 从此 KP 切场景再也带不动它们——面板显示教堂，站在里面的却还是码头的 NPC，
   * 调查也仍在旧房间里找线索。
   */
  getDisplayedScene(): string {
    this.#assertSessionReadable();
    return this.#displayedSceneProjection();
  }

  #displayedSceneProjection(): string {
    return this.#worldRaw.getCurrentState().scene;
  }

  /**
   * Refresh the KP's ephemeral visible-scene directive from the currently
   * published ordinary RuntimeModuleData. This deliberately reads source
   * scene fields only: clues, KP notes, NPC knowledge, and recognition prose
   * are not player-visible scene facts.
   */
  #syncCurrentOrdinaryKPScene(mode: "opening" | "action"): void {
    const clear = () => this.#kpRaw.updateDirective({ scene_description: "", scene_elements: [] });
    if (this.#compiledModule
      || this.#registeredModules.length !== 1
      || this.#loadedModules.size !== 1) {
      clear();
      return;
    }

    const module = this.#registeredModules[0]!;
    if (!isModuleData(module) || !this.#loadedModules.get(module.id)) {
      clear();
      return;
    }

    const sceneId = this.#displayedSceneProjection();
    const sourceScene = module.scenes.find((scene) => scene.id === sceneId);
    const publishedScene = this.#worldRaw.getScene(sceneId);
    if (!sourceScene
      || !sourceScene.description.trim()
      || !publishedScene
      || publishedScene.description !== sourceScene.description) {
      clear();
      return;
    }

    const narrativeEntities = module.narrative?.entities ?? [];
    const visibleEntityNames = (sourceScene.visibleEntities ?? [])
      .map((id) => narrativeEntities.find((entity) => entity.id === id)?.name.trim())
      .filter((name): name is string => Boolean(name));
    const sceneElements = visibleEntityNames.map((name) => `可见实体：${name}`);
    if (mode === "opening" && sourceScene.openingAtmosphere?.trim()) {
      sceneElements.push(`本次开场氛围：${sourceScene.openingAtmosphere.trim()}`);
    }
    this.#kpRaw.updateDirective({
      scene_description: sourceScene.description.trim(),
      scene_elements: sceneElements,
    });
  }

  /**
   * 结局条件用的两个谓词——队伍里**任一人**发现过 / 到过。
   *
    * 命名空间已核对：步骤 5C 的 ModuleDataRuntimeLoader 直接用
    * `clue.id` 注册 BARN_OF_PREMIER 的丰富线索进 InvestigationEngine，
   * END_NARRATIONS 引用的正是同一份 `clue.id`，两边不会对不上——
   * 已用真实模组数据验过（ending-namespace-truth-source.test.ts）。
   * requiredScenes 那半边同理：开发·场景 id 收敛 N11 把
   * `BARN_OF_PREMIER.scenes[].id` 改成了运行时本来就在用的中文展示名，
   * 两边现在是同一套 id，不需要翻译（历史背景：todo-34 曾经的缺口与
   * 后续的翻译层，见 isSceneVisited() 的旧版本，已随场景 id 收敛删除）。
   */
  isClueFound(clueId: string): boolean {
    this.#assertSessionReadable();
    return this.#clueFoundPredicate(clueId);
  }

  #clueFoundPredicate(clueId: string): boolean {
    return this.#worldRaw.isClueDiscoveredByAnyone(clueId);
  }

  isSceneVisited(sceneId: string): boolean {
    this.#assertSessionReadable();
    return this.#sceneVisitedPredicate(sceneId);
  }

  #sceneVisitedPredicate(sceneId: string): boolean {
    return this.#worldRaw.isSceneVisitedByAnyone(sceneId);
  }

  /**
   * 现在算不算"前期"（开发·线索闸门 任务3）——除了连续大失败以外，
   * 尽量不在前期阻止调查；前期检定失败时 resolveSceneClue() 会给指向性
   * 降级信息而不是干巴巴的"没找到"，见该方法。
   *
   * 两条判法（已裁决）：
   *   有 ModuleSupport 且声明了 earlyGameEndSceneId → 到过那个场景之前
   *   算前期（谷仓用 adrian_farm，见 BARN_SUPPORT 的注释：到农场入口就
   *   能看见红漆谷仓，是叙事上"主线目标现出真身"的分界点，isSceneVisited
   *   已经处理了 ASCII/运行时场景 id 的桥接，这里直接传 ASCII id）。
   *
   *   没有 ModuleSupport（或没声明这个字段）→ 已发现线索 / 可文本匹配的
   *   线索总数 < 1/3。分母优先数有 matchTexts 的那批（YAML 手写/
   *   registerSceneClue 合成的线索没有 matchTexts，本来就只能靠
   *   fallback 拿到，进分母没有意义）；一条 matchTexts 都没有的模组
   *   （分母会是 0）就退回数全部已注册线索类型。
   *
   * ⚠ 如实记账：阿卡姆档案检查/印斯茅斯的阴霾都没有 ModuleSupport 登记，
   * 也都没有任何一条线索带 matchTexts（各自仅有的 3 条线索都是经
   * registerSceneClue 合成的），走的是"退回数全部"这一支——3 条线索，
   * 1/3 约等于 1 条，发现第一条就结束"前期"。这条分支目前没有有意义的
   * 适用对象，本条注释与 docs/todo.json 如实记录这个事实，不假装它在
   * 正常工作——根因是这两个模组内容本身极薄（连结局数据都没有，见
   * MODULE_ENDING_SUPPORT 的注释），是 todo-19 的下游，不在本轮修。
   */
  isEarlyGame(): boolean {
    this.#assertSessionReadable();
    return this.#earlyGameProjection();
  }

  #earlyGameProjection(): boolean {
    const modId: string | undefined = this.#registeredModules[0]?.id;
    const support = modId ? MODULE_ENDING_SUPPORT[modId] : undefined;
    if (support?.earlyGameEndSceneId) return !this.#worldRaw.isSceneVisitedByAnyone(support.earlyGameEndSceneId);

    const withMatchTexts = this.#investigationRaw.listModuleClueIds({ onlyWithMatchTexts: true });
    const denomIds = withMatchTexts.length > 0 ? withMatchTexts : this.#investigationRaw.listModuleClueIds();
    if (denomIds.length === 0) return false; // 没有任何线索可数，没有"前期"这个概念
    const discovered = denomIds.filter((id) => this.#worldRaw.isClueDiscoveredByAnyone(id)).length;
    return discovered / denomIds.length < 1 / 3;
  }

  /**
   * 为当前场景构建世界模型上下文并注入 KP（权威事实层）。
   * 世界模型未加载 / 加载失败时静默跳过，不影响叙事流程。
   */
  private injectWorldModelForScene() {
    try {
      // A compiled session is closed-world. It may receive only the catalog
      // bundle's verified, hash-bound reference scope; legacy global loaders
      // are never a fallback for a missing or invalid compiled binding.
      if (this.#compiledModule) {
        this.#compiledWorldModelPromptReceipt = null;
        const binding = this.#compiledModule.worldModelBinding;
        if (!binding) {
          this.#kpRaw.setWorldModelContext("");
          return;
        }
        const sceneId = this.#displayedSceneProjection();
        const scene = this.#worldRaw.getScene(sceneId);
        const entities = this.#worldRaw.getEntitiesInScene(sceneId);
        const context = buildCompiledCthulhuWorldModelContext(binding, {
          keywords: [
      this.#sceneDisplayNames[sceneId] ?? sceneId,
            sceneId,
            scene?.description ?? "",
            ...entities.map((entity) => entity.name),
          ],
        });
        this.#kpRaw.setWorldModelContext(context.text);
        const { text: _text, ...receipt } = context;
        this.#compiledWorldModelPromptReceipt = structuredClone(receipt);
        return;
      }
      // Legacy reference data has no durable artifact binding. Only a trusted
      // host runtime dependency may select one exact source novel; absent,
      // padded, synthetic, or unknown scopes fail closed before either shared
      // legacy loader is even observed.
      const worldModelNovel = this.#worldModelNovel;
      if (!worldModelNovel) {
        this.#compiledWorldModelPromptReceipt = null;
        this.#kpRaw.setWorldModelContext("");
        return;
      }
      // 懒加载：首次注入时才加载世界模型（~240MB / 1.5-2s）；失败静默降级，不影响叙事
      if (!this.#worldModelRaw.isLoaded()) {
        try {
          this.#worldModelRaw.load();
        } catch {
          this.#kpRaw.setWorldModelContext("");
          return;
        }
      }
      if (!this.#worldModelRaw.isLoaded() || !hasExactLegacyWorldModelNovelBucket(this.#worldModelRaw, worldModelNovel)) {
        this.#compiledWorldModelPromptReceipt = null;
        this.#kpRaw.setWorldModelContext("");
        return;
      }
      const pos = this.#displayedSceneProjection();
      const sceneName = this.#sceneDisplayNames[pos] ?? pos;
      // 读取模组原文场景描写（scenes 表 description，若已注册）
      const sceneInfo = this.#worldRaw.getScene(pos);
      // 读取当前场景在场实体：NPC/怪物 → presentNPCs；item → presentItems
      const presentEntities = this.#worldRaw.getEntitiesInScene(pos);
      const presentNPCs = presentEntities
        .filter((e) => e.type === "npc" || e.type === "monster")
        .map((e) => e.name);
      const presentItems = presentEntities
        .filter((e) => e.type === "item")
        .map((e) => e.name);
      // 组装在场 NPC 人设卡（权威元数据，防 LLM 臆造年龄/性别/状态）：
      // 从已加载模组的 npcs 定义 + hooks 初始状态匹配
      const npcProfiles = this.buildPresentNPCProfiles(presentNPCs);
      // 读取已发现线索（调查引擎）
      const discoveredClues = this.#investigationRaw.getSceneClues(sceneName);
      const ctx: SceneContext = {
        sceneId: pos,
        sceneName,
        sceneDescription: sceneInfo?.description ?? "",
        keywords: [sceneName, pos].filter(Boolean),
        presentNPCs,
        npcProfiles,
        discoveredClues,
        presentItems,
        round: this.#roundRaw,
        activeNovel: worldModelNovel,
        ruleset: this.#activeRulesetRaw,
    gameTime: formatGameTime(this.#gameTime),
    periodAtmosphere: periodAtmosphere(this.#gameTime.period),
      };
      let wmText = this.#wmIntegratorRaw.buildKPContext(ctx);
      // 克苏鲁神话上下文（独立 loader，独立懒加载；失败静默跳过，不影响叙事）
      const cthulhuText = this.buildCthulhuContext(worldModelNovel);
      if (cthulhuText) {
        wmText = wmText ? `${wmText}\n\n${cthulhuText}` : cthulhuText;
      }
      this.#kpRaw.setWorldModelContext(wmText);
    } catch {
      this.#compiledWorldModelPromptReceipt = null;
      this.#kpRaw.setWorldModelContext("");
    }
  }

  /**
   * 将模组 NPC 内联人格注册进 NPC Agent 系统，供会话内 `handleTalk` 调用。
   * 数据源：模组 npcs 数组的 personality（权威设定，优先）
   *        + npcs.yaml 通用人格（仅当模组指定 npcPersonalityId 引用时兜底）。
   * ModuleNPC.personality 字段是 ModuleNPC 风格（role/background/goals/secrets/traits...），
   * 需映射为 NPCPersonality 风格（含必填 speech_style/knowledge，缺失时给默认值）。
   */
  #registerModuleNPCPersonality(
    npcName: string,
    personality: RuntimeNpcPersonality | undefined,
    npcPersonalityId?: string,
    canonicalKnowledge?: readonly string[],
  ): void {
    if (!npcName) return;
    // 已注册则跳过（模组重复加载保护）
    if (this.#registryRaw.has(npcName)) return;
    // 内联人格为空且指定了 npcPersonalityId → 从 npcs.yaml 通用人格库兜底（按 id 或名称匹配）
    if (!personality && npcPersonalityId) {
      personality = this.#loadNPCPersonalityFromYaml(npcName, npcPersonalityId);
    }
    if (!personality) return;
    const p = personality;
    const card: NPCPersonality = {
      name: npcName,
      role: p.role ?? "NPC",
      personality: p.personality ?? p.role ?? "普通镇民",
      background: p.background ?? `${npcName}，${p.role ?? "普通镇民"}`,
      goals: Array.isArray(p.goals) ? p.goals : (p.goals ? [String(p.goals)] : ["生存", "完成自己的事"]),
      speech_style: p.speech_style ?? "以角色身份自然说话，符合身份与处境",
      // A direct RuntimeModuleData install supplies this argument from the
      // enclosing, validated ModuleNPC.  It wins even when it is explicitly
      // empty: mixing runtime/YAML knowledge into that fact domain would let
      // a differently sourced profile silently author new module facts.
      // Undefined is reserved for the legacy Mythos/YAML registration path.
      knowledge: canonicalKnowledge === undefined
        ? (Array.isArray(p.knowledge) ? p.knowledge : [])
        : [...canonicalKnowledge],
      secrets: Array.isArray(p.secrets) ? p.secrets : [],
      attitudes: p.attitudes,
      ruleset: this.#activeRulesetRaw as any,
      traits: p.traits,
      // 人格可能来自模组内联定义，也可能来自运行时解析的 npcs.yaml（any），
      // 后者完全不受编译器约束。这里是两条来路唯一的汇合点，越界值在此丢弃，
      // 不让它冒充成合法情绪流进消息与语音层。
      initialMood: asNPCMood(p.initialMood),
    };
    try {
      this.#registryRaw.register(card);
    } catch (e: any) {
      // 已注册或注册失败不阻塞模组加载
      log.warn("session", `NPC Agent 注册跳过: ${npcName} — ${e?.message ?? e}`);
    }
  }

  /** 懒加载 npcs.yaml 通用人格库，按 id 或名称匹配返回人格（找不到返回 undefined） */
  #loadNPCPersonalityFromYaml(npcName: string, npcPersonalityId: string): any | undefined {
    try {
      const raw = readFileSync(new URL("../agent/npcs.yaml", import.meta.url), "utf8");
      const data = parseYaml(raw) as any;
      const npcs = Array.isArray(data?.npcs) ? data.npcs : (data && typeof data === "object" ? Object.values(data) : []);
      for (const item of npcs) {
        const id = String(item?.id ?? item?.name ?? "");
        const name = String(item?.name ?? "");
        if (id === npcPersonalityId || name === npcPersonalityId || name === npcName) return item;
      }
    } catch (e: any) {
      log.warn("session", `npcs.yaml 加载失败: ${e?.message ?? e}`);
    }
    return undefined;
  }

  /**
   * 组装在场 NPC 人设卡（权威元数据，供 KP 上下文注入）。
   * 数据源：已加载模组的 npcs 定义（age/gender/personality/dialogHints）
   *        + 模组 hooks 中 on_enter_scene 的初始状态描写（currentState）。
   * currentState 匹配策略（NPC 专属场景，非普通场景描写）：
   *   hook.condition 归一化后包含 NPC 全名（"菲碧_特里坎" ↔ "菲碧·特里坎"），
   *   或包含 NPC 名字部分（"与艾德里安的会面" ↔ "艾德里安·埃斯特鲁姆"）。
   *   普通场景 hook（如 "特里坎家"）不含 NPC 名/名字部分，不会被误匹配。
   * 找不到权威定义时返回空数组 → buildKPContext 回退到纯名字列表。
   */
  private buildPresentNPCProfiles(presentNPCs: string[]): NPCPresentProfile[] {
    if (!presentNPCs || presentNPCs.length === 0) return [];
    const norm = this.normalizeNpcNameSeparators;
    const profiles: NPCPresentProfile[] = [];
    const currentStateFor = (name: string, hooks: Array<{ type: string; condition: string; narration?: string }>): string | undefined => {
      const keys = [name, String(name).split("·")[0] ?? ""]
        .map(norm)
        .filter((key) => key.length >= 2);
      const hook = hooks.find((candidate) => {
        if (candidate.type !== "on_enter_scene" || !candidate.condition) return false;
        const condition = norm(candidate.condition);
        return keys.some((key) => condition.includes(key) || key.includes(condition));
      });
      return hook?.narration?.split("。")[0]?.slice(0, 40);
    };
    for (const mod of this.#registeredModules) {
      if (isModuleData(mod)) {
        const hooks = mod.runtime?.hooks ?? [];
        for (const npc of mod.npcs) {
          const runtime = npc.runtime;
          const name = runtime?.sourceName ?? npc.name;
          if (!presentNPCs.includes(name)) continue;
          profiles.push({
            name,
            age: runtime?.age ?? npc.age,
            gender: runtime?.gender,
            role: runtime?.personality?.role ?? npc.role,
            currentState: currentStateFor(name, hooks),
            background: runtime?.personality?.background ?? npc.description,
            dialogHints: runtime?.dialogHints,
          });
        }
      } else {
        const hooks = mod.hooks ?? [];
        for (const npc of mod.npcs ?? []) {
          if (!presentNPCs.includes(npc.name)) continue;
          profiles.push({
            name: npc.name,
            age: npc.age,
            gender: npc.gender,
            role: npc.personality?.role,
            currentState: currentStateFor(npc.name, hooks),
            background: npc.personality?.background,
            dialogHints: npc.dialogHints,
          });
        }
      }
    }
    return profiles;
  }

  /**
   * 构建克苏鲁神话世界模型上下文（权威事实层追加段）。
   * 独立懒加载 cthulhu_world_model.jsonl（145 条 / 小文件，秒级）；
   * 加载失败 / 文件缺失时静默返回空串，不影响叙事流程。
   */
  private buildCthulhuContext(worldModelNovel: string): string {
    try {
      if (!isExactLegacyWorldModelNovel(worldModelNovel)) return "";
      if (!this.#cthulhuLoaderRaw.isLoaded()) {
        this.#cthulhuLoaderRaw.load(CTHULHU_MODEL_PATH);
      }
      if (!this.#cthulhuLoaderRaw.isLoaded()
        || !hasExactLegacyWorldModelNovelBucket(this.#cthulhuLoaderRaw, worldModelNovel)) return "";

      const lines: string[] = [];
      lines.push("[克苏鲁神话上下文]");

      const deities = this.#cthulhuLoaderRaw.getByNovelAndType(worldModelNovel, "deity");
      if (deities.length > 0) {
        lines.push("神话存在:");
        for (const d of deities.slice(0, 6)) {
          const name = d.name || "未知";
          const domains = (d as any).domains ? `(领域: ${(d as any).domains.join("、")})` : "";
          const mechanic = d.mechanic ? ` ${d.mechanic.slice(0, 80)}` : "";
          lines.push(`  - ${name}${domains}${mechanic}`);
        }
      }

      const mechanics = [
        ...this.#cthulhuLoaderRaw.getByNovelAndType(worldModelNovel, "power_system"),
        ...this.#cthulhuLoaderRaw.getByNovelAndType(worldModelNovel, "game_mechanic"),
        ...this.#cthulhuLoaderRaw.getByNovelAndType(worldModelNovel, "crafting"),
        ...this.#cthulhuLoaderRaw.getByNovelAndType(worldModelNovel, "cosmology"),
      ].slice(0, 8);
      if (mechanics.length > 0) {
        lines.push("神秘机制:");
        for (const m of mechanics) {
          const name = m.name || "未知";
          const mechanic = m.mechanic ? m.mechanic.slice(0, 90) : (m.description || "").slice(0, 90);
          lines.push(`  - ${name}: ${mechanic}`);
        }
      }

      const causals = this.#cthulhuLoaderRaw.getByNovelAndType(worldModelNovel, "causal").slice(0, 3);
      if (causals.length > 0) {
        lines.push("可推进的怪异事件方向:");
        for (const c of causals) {
          const name = c.name || "未知";
          const mechanic = c.mechanic ? c.mechanic.slice(0, 90) : "";
          lines.push(`  - ${name}: ${mechanic}`);
        }
      }

      return lines.length > 1 ? lines.join("\n") : "";
    } catch {
      return "";
    }
  }

  async #getOpeningSceneResult(signal?: AbortSignal): Promise<OrdinaryOpeningSceneResult> {
    this.#assertOrdinaryDurableMutationAllowed();
    const lifecycleRevision = this.#lifecycleRevision;
    try {
      this.#syncCurrentOrdinaryKPScene("opening");
      this.injectWorldModelForScene();
      const result = await this.#kpRaw.describeSceneResult(signal);
      // Match direct act(): an opening completed by a provider after this
      // instance retires cannot be acknowledged, observed, or persisted by a
      // caller as work of the closed session.
      if (!this.#directActionLifecycleIsCurrent(lifecycleRevision)) {
        throw this.#closedDirectActionError();
      }
      if (result.status === "fallback") {
        this.#lastNarrative = ORDINARY_OPENING_FALLBACK;
        return { status: "fallback", opening: ORDINARY_OPENING_FALLBACK };
      }
      this.#lastNarrative = result.description;
      return { status: "ready", opening: result.description };
    } catch (error) {
      // A provider failure after close must not be converted into a
      // publishable fallback. This also normalizes the deliberate post-await
      // lifecycle rejection above to the stable closed-session contract.
      if (!this.#directActionLifecycleIsCurrent(lifecycleRevision)) {
        throw this.#closedDirectActionError();
      }
      // Cancellation carries a lifecycle decision from the host. It must
      // reach HTTP creation rather than becoming a publishable fallback.
      if (signal?.aborted) throw error;
      return { status: "fallback", opening: ORDINARY_OPENING_FALLBACK };
    }
  }

  /**
   * Backward-compatible string API for CLI, trusted factories, and direct
   * callers. HTTP can observe the exact result of this one invocation without
   * bypassing a factory override or guessing from fallback prose.
   */
  async getOpeningScene(signal?: AbortSignal, observe?: OrdinaryOpeningSceneObserver): Promise<string> {
    const result = await this.#getOpeningSceneResult(signal);
    observe?.(result);
    return result.opening;
  }

  // ============================================================
  // KP 面板
  // ============================================================

  getKPState(): any {
    this.#assertSessionReadable();
    const worldState = this.#worldRaw.getCurrentState();
    const companions = this.#companionManagerRaw.getActiveCompanions();
    const curModule = this.#registeredModules[0] ?? null;
    const pos = this.#displayedSceneProjection();
    const sceneItems = this.#sceneItems.get(pos) ?? [];

    const characters: any[] = [];
    for (const [pid, ch] of this.#characters) {
    const sanEng = this.#sanityEngines.get(pid) ?? this.#sanityRaw;
      const inv = this.#worldRaw.getPlayerInventory(pid);
      const weps = this.#worldRaw.getPlayerWeapons(pid);
      const armors = this.#worldRaw.getPlayerArmor(pid);
      characters.push({
        playerId: pid, name: ch.name,
        archetype: ch.archetype?.label ?? ch.archetype?.id ?? "调查员",
        attributes: { ...ch.attributes }, hp: ch.hp, maxHp: ch.maxHp, ac: ch.ac ?? 0,
        san: sanEng.state.currentSAN, maxSan: sanEng.state.maxSAN,
        cthulhuMythos: sanEng.state.cthulhuMythos ?? 0,
        temporaryInsanity: sanEng.state.temporaryInsanity,
        indefiniteInsanity: sanEng.state.indefiniteInsanity,
        luck: ch.luck ?? 60, skills: { ...(ch.skillValues ?? {}) },
        inventory: inv, weapons: weps, armor: armors,
      });
    }

    return {
      sessionId: this.#idRaw, round: this.#roundRaw,
      ruleset: this.#activeRulesetRaw,
      scene: this.#sceneDisplayNames[pos] ?? pos,
      characters, combatActive: this.#combatActiveRaw,
      companions: companions.map(c => {
        const ent = this.#worldRaw.getEntity(c.entityId);
        return {
          id: c.config.id, name: c.config.name, hp: ent?.hp ?? 0, maxHp: c.config.maxHp,
          ac: c.config.ac, morale: c.morale, behavior: c.behavior,
          control: c.control, position: ent?.position ?? "", inventory: [...c.inventory],
          skills: { ...c.config.skills }, resolveState: c.resolveState,
        };
      }),
      npcs: Object.values(worldState.entities)
        .filter(e => (e.type === "npc" || e.type === "monster") && (e.hp > 0 || e.status.includes("narrative_noncombat")))
        .map(e => ({ name: e.name, type: e.type, hp: e.hp, maxHp: e.maxHp })),
sceneItems: [...sceneItems], difficulty: this.#activeDifficulty ? { ...this.#activeDifficulty } : undefined,
      module: curModule ? {
        id: curModule.id,
        name: isModuleData(curModule) ? curModule.title : curModule.name,
        difficulty: isModuleData(curModule) ? curModule.runtime?.difficulty : curModule.difficulty,
      } : null,
      gameTime: { day: this.#gameTime.day, period: this.#gameTime.period, label: formatGameTime(this.#gameTime) },
      politicoEconomy: this.#politicoEconomyRaw.getBriefState(),
    };
  }

  sendMessage(speaker: string, content: string, type: MessageType = "system"): boolean {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return false;
    this.#addMessageCanonical(speaker, content, type);
    return true;
  }
  /**
   * KP 设置指定玩家的当前 SAN。
   *
   * 不再懒建 SanityEngine：原写法用 `new SanityEngine(Math.max(value, 50))`
   * 给不存在的玩家现造一个引擎，上限由传入值自己推出来，于是任何值都合法——
   * 这个「域」是循环的，校验不了任何东西。引擎的存在性就是玩家的存在性
   * （构造函数建 p1，创建队友同时写 characters 与 sanityEngines），
   * 所以取不到引擎即为未知玩家。
   *
   * 也不再 `Math.max(0, Math.min(value, maxSAN))` 静默钳制：KP 设 999 会被
   * 悄悄改成 50 却返回成功，属于 §八 那类「看起来成功了、值却不是你设的那个」。
   * 越界现在是结构化拒绝，缓存与真相源都不动。
   */
  setPlayerSan(pid: string, value: number): Result<StateDelta, RejectReason> {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return { ok: false, error: { code: "unknown_action", actionId: "compiled_mutation_unsupported" } };
    const eng = this.#sanityEngines.get(pid);
    if (!eng) return { ok: false, error: { code: "unknown_target", targetId: pid } };

    const priorSanity = structuredClone(this.#worldRaw.getPlayerSanity(pid));
    const priorCurrentSan = eng.state.currentSAN;

    const variable = `san:${pid}`;
    const result = applyAction(
      boundedIntegerScenario(variable, eng.state.currentSAN, eng.state.maxSAN),
      boundedIntegerGateState(variable, eng.state.currentSAN),
      {
        kind: "freeform",
        actor: "kp",
        description: `set SAN for ${pid}`,
        effects: [{ variable, to: value }],
      },
    );
    if (!result.ok) return result;

    if (priorCurrentSan === value && samePortableJson(priorSanity, eng.state)) return result;
    eng.restoreState({ ...eng.state, currentSAN: value });
    if (pid === this.#activePlayerId) this.#installSanityEngine(eng);
    this.#persistSanity(pid);
    if (priorCurrentSan !== value || !samePortableJson(priorSanity, this.#worldRaw.getPlayerSanity(pid))) {
      this.#bumpFacadeMutationRevision();
    }
    return result;
  }
  setPlayerHp(pid: string, value: number): Result<StateDelta, RejectReason> {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return { ok: false, error: { code: "unknown_action", actionId: "compiled_mutation_unsupported" } };
    const ch = this.#characters.get(pid);
    if (!ch) return { ok: false, error: { code: "unknown_target", targetId: pid } };

    const priorCharacterHp = ch.hp;

    const maxHp = ch.maxHp ?? 99;
    const variable = `hp:${pid}`;
    const result = applyAction(
      boundedIntegerScenario(variable, ch.hp, maxHp),
      boundedIntegerGateState(variable, ch.hp),
      {
        kind: "freeform",
        actor: "kp",
        description: `set HP for ${pid}`,
        effects: [{ variable, to: value }],
      },
    );
    if (!result.ok) return result;

    // A supported facade write is a mutation only if one of its two truth
    // holders differs. In particular, do not upsert an already-synchronized
    // entity: SQLite advances `updated_at`, which is portable source state.
    const ent = this.#worldRaw.getEntity(pid);
    const priorEntityHp = ent?.hp;
    if (priorCharacterHp === value && priorEntityHp === value) return result;

    if (priorCharacterHp !== value) ch.hp = value;
    // 同步世界实体（若不存在则创建"
    if (!ent) {
      this.#worldRaw.upsertEntity({
        id: pid,
        name: ch.name ?? pid,
        type: "pc",
        hp: value,
        maxHp: ch.maxHp ?? 99,
        ac: ch.ac ?? 10,
        status: [],
        position: this.#worldRaw.getCurrentState().scene ?? "tavern",
      });
    } else if (priorEntityHp !== value) {
      this.#worldRaw.upsertEntity({ ...ent, hp: value });
    }
    this.#bumpFacadeMutationRevision();
    return result;
  }
  /** 覆盖指定玩家的背包内容（HTTP 角色卡编辑用）。 */
  /**
   * An explicit ordinary character-card patch boundary. Public character reads
   * are detached frozen snapshots, so callers present a patch for validation
   * here instead of mutating an observation. This method
   * owns the character/world HP projection and never exposes a raw sheet.
   */
  updateActiveCharacter(update: ActiveCharacterUpdate): ActiveCharacterMutationResult {
    return this.#updateCharacterCanonical(this.#activePlayerId, update);
  }

  /** Validated write for a known PC; server routes use the active-player wrapper. */
  updateCharacter(pcId: string, update: ActiveCharacterUpdate): ActiveCharacterMutationResult {
    return this.#updateCharacterCanonical(pcId, update);
  }

  #updateCharacterCanonical(pcId: string, update: ActiveCharacterUpdate): ActiveCharacterMutationResult {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return { status: "refused", code: "compiled_mutation_unsupported" };
    const character = this.#characters.get(pcId);
    if (!character || this.#party.get(pcId)?.sheet !== character) {
      return { status: "refused", code: "unknown_pc" };
    }
    if (pcId === this.#activePlayerId && character !== this.#activeCharacterRaw) {
      return { status: "refused", code: "active_character_inconsistent" };
    }
    const worldEntity = this.#worldRaw.getEntity(pcId);
    if (!worldEntity || worldEntity.type !== "pc") return { status: "refused", code: "active_character_world_missing" };

    const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
    const patch = materializeCharacterPatchRecord(update, CHARACTER_UPDATE_KEYS);
    if (!patch) return { status: "refused", code: "character_update_invalid" };
    const hasHp = Object.hasOwn(patch, "hp");
    const hasMaxHp = Object.hasOwn(patch, "maxHp");
    const hasSkills = Object.hasOwn(patch, "skillValues");
    const hasLuck = Object.hasOwn(patch, "luck");
    const hasCreditRating = Object.hasOwn(patch, "creditRating");
    const hasAttributes = Object.hasOwn(patch, "attributes");
    if (this.#activeRulesetRaw !== "cosmic-horror" && (hasSkills || hasLuck || hasCreditRating || hasAttributes)) {
      return { status: "refused", code: "character_ruleset_unsupported" };
    }
    const nextMaxHp = hasMaxHp ? patch.maxHp : character.maxHp;
    const nextHp = hasHp ? patch.hp : character.hp;
    if (!isIntegerIn(nextMaxHp, 1, 999) || !isIntegerIn(nextHp, 0, nextMaxHp)) {
      return { status: "refused", code: "character_hp_invalid" };
    }
    if (hasLuck && !isIntegerIn(patch.luck, 0, 99)) {
      return { status: "refused", code: "character_luck_invalid" };
    }
    if (hasCreditRating && !isIntegerIn(patch.creditRating, 0, 99)) {
      return { status: "refused", code: "character_credit_rating_invalid" };
    }

    let nextSkills: Record<string, number> | undefined;
    if (hasSkills) {
      if (!isOrdinaryDataRecord(character.skillValues)) return { status: "refused", code: "active_character_inconsistent" };
      const skillPatch = materializeCharacterPatchRecord(patch.skillValues);
      if (!skillPatch) return { status: "refused", code: "character_update_invalid" };
      if (Object.keys(skillPatch).length > 256 || Object.entries(skillPatch).some(([key, value]) => !key
        || Array.from(key).length > 128 || !COC_EDITABLE_CHARACTER_SKILLS.has(key) || !isIntegerIn(value, 0, 100))) {
        return { status: "refused", code: "character_skills_invalid" };
      }
      nextSkills = { ...character.skillValues, ...skillPatch } as Record<string, number>;
    }

    let nextAttributes: Record<string, number> | undefined;
    if (hasAttributes) {
      if (!isOrdinaryDataRecord(character.attributes)) return { status: "refused", code: "active_character_inconsistent" };
      const attributePatch = materializeCharacterPatchRecord(patch.attributes);
      if (!attributePatch) return { status: "refused", code: "character_update_invalid" };
      if (Object.entries(attributePatch).some(([key, value]) => !COC_EDITABLE_CHARACTER_ATTRIBUTES.has(key) || !isIntegerIn(value, 1, 100))) {
        return { status: "refused", code: "character_attributes_invalid" };
      }
      nextAttributes = { ...character.attributes, ...attributePatch } as Record<string, number>;
    }

    const hpChanged = character.hp !== nextHp || character.maxHp !== nextMaxHp
      || worldEntity.hp !== nextHp || worldEntity.maxHp !== nextMaxHp;
    const skillsChanged = nextSkills !== undefined && !samePortableJson(character.skillValues, nextSkills);
    const attributesChanged = nextAttributes !== undefined && !samePortableJson(character.attributes, nextAttributes);
    const luckChanged = hasLuck && character.luck !== patch.luck;
    const creditRatingChanged = hasCreditRating && character.creditRating !== patch.creditRating;
    if (!hpChanged && !skillsChanged && !attributesChanged && !luckChanged && !creditRatingChanged) {
      return { status: "updated", character: this.characterPublicView(character) };
    }

    // Complete validation before the only child-store write, so rejected
    // requests cannot leave a partial character/world state behind.
    if (hpChanged) this.#worldRaw.upsertEntity({ ...worldEntity, hp: nextHp, maxHp: nextMaxHp });
    character.hp = nextHp;
    character.maxHp = nextMaxHp;
    if (nextSkills !== undefined) character.skillValues = nextSkills;
    if (nextAttributes !== undefined) character.attributes = nextAttributes;
    if (hasLuck) character.luck = patch.luck;
    if (hasCreditRating) character.creditRating = patch.creditRating;
    this.#bumpFacadeMutationRevision();
    return { status: "updated", character: this.characterPublicView(character) };
  }

  /** Spend CoC luck only through canonical cosmic-horror session authority. */
  spendActiveCharacterLuck(amount: number): ActiveCharacterMutationResult {
    return this.#spendCharacterLuckCanonical(this.#activePlayerId, amount);
  }

  /** Controlled CoC-luck write for a known cosmic-horror PC. */
  spendCharacterLuck(pcId: string, amount: number): ActiveCharacterMutationResult {
    return this.#spendCharacterLuckCanonical(pcId, amount);
  }

  #spendCharacterLuckCanonical(pcId: string, amount: number): ActiveCharacterMutationResult {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return { status: "refused", code: "compiled_mutation_unsupported" };
    if (this.#activeRulesetRaw !== "cosmic-horror") return { status: "refused", code: "luck_ruleset_unsupported" };
    const character = this.#characters.get(pcId);
    if (!character || this.#party.get(pcId)?.sheet !== character) {
      return { status: "refused", code: "unknown_pc" };
    }
    if (pcId === this.#activePlayerId && character !== this.#activeCharacterRaw) {
      return { status: "refused", code: "active_character_inconsistent" };
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) return { status: "refused", code: "luck_amount_invalid" };
    if (!Number.isSafeInteger(character.luck) || character.luck < 0 || character.luck > 99 || amount > character.luck) {
      return { status: "refused", code: "luck_insufficient" };
    }
    character.luck -= amount;
    this.#bumpFacadeMutationRevision();
    return { status: "updated", character: this.characterPublicView(character) };
  }

  setPlayerInventory(pid: string, items: string[]): boolean {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return false;
    const prior = this.#worldRaw.getPlayerInventory(pid);
    this.#worldRaw.setPlayerInventory(pid, items);
    if (!samePortableJson(prior, this.#worldRaw.getPlayerInventory(pid))) this.#bumpFacadeMutationRevision();
    return true;
  }
  /** 覆盖指定玩家已装备的武器（HTTP 角色卡编辑用）。 */
  setPlayerWeapons(pid: string, weapons: string[]): boolean {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return false;
    const prior = this.#worldRaw.getPlayerWeapons(pid);
    this.#worldRaw.setPlayerWeapons(pid, weapons);
    if (!samePortableJson(prior, this.#worldRaw.getPlayerWeapons(pid))) this.#bumpFacadeMutationRevision();
    return true;
  }
  /**
   * 把 SAN 引擎的当前 state 写回真相源。
   *
   * SanityEngine 在自己的方法里就地改 state（全仓 40 处），逐点拦截既脆弱又易漏，
   * 因此统一在两类边界落库：显式 setter（setPlayerSan）与每回合出口
   * （buildActionResponse）。回合内的中间态不落库，回合结束时必定一致。
   */
  #persistSanity(pid?: string) {
    if (pid !== undefined) {
      const eng = this.#sanityEngines.get(pid);
      if (eng) this.#worldRaw.setPlayerSanity(pid, eng.state);
      return;
    }
    for (const [id, eng] of this.#sanityEngines) this.#worldRaw.setPlayerSanity(id, eng.state);
  }
  /**
   * 对任意实体（PC / NPC / 怪物）施加伤害。
   *
   * 伤害是算术增量，闸门校验的是绝对状态，所以这里先把「当前 HP 减伤害」
   * 投影成目标 HP 再送闸门（见 docs/kp-tool-numeric-domain-design.md）。
   *
   * 两处旧行为被换掉：
   * - `Math.max(0, damage)` 把负伤害静默变成 0 并返回成功。负伤害不是零伤害，
   *   是调用错了方法（治疗不该走这里），现在直接拒绝。小数伤害同理——
   *   它原本会把分数 HP 写进数据库。
   * - `world.applyDamage()` 对不存在的实体抛异常，被 server 的 catch 兜成 500。
   *   目标名打错属于输入错误，现在是结构化拒绝，由 HTTP 映射成 400。
   *
   * 过量伤害落到 0 保留原样：那是正确的战斗语义，不是把非法输入伪装成成功。
   */
  applyDamage(entityId: string, damage: number): Result<StateDelta, RejectReason> {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return { ok: false, error: { code: "unknown_action", actionId: "compiled_mutation_unsupported" } };
    const variable = `hp:${entityId}`;
    if (!Number.isInteger(damage) || damage < 0) {
      return { ok: false, error: { code: "invalid_amount", variable, amount: damage } };
    }

    const ent = this.#worldRaw.getEntity(entityId);
    if (!ent) return { ok: false, error: { code: "unknown_target", targetId: entityId } };
    const priorEntity = structuredClone(ent);
    const priorCharacterHp = this.#characters.get(entityId)?.hp;

    const result = applyAction(
      boundedIntegerScenario(variable, ent.hp, ent.maxHp),
      boundedIntegerGateState(variable, ent.hp),
      {
        kind: "freeform",
        actor: "kp",
        description: `apply ${damage} damage to ${entityId}`,
        effects: [{ variable, to: Math.max(0, ent.hp - damage) }],
      },
    );
    if (!result.ok) return result;

    const applied = this.#worldRaw.applyDamage(entityId, damage);
    const character = this.#characters.get(entityId);
    if (character) character.hp = applied.remainingHp;
    if (priorCharacterHp !== character?.hp
      || !samePortableJson(priorEntity, this.#worldRaw.getEntity(entityId))) {
      this.#bumpFacadeMutationRevision();
    }
    return result;
  }
  /**
   * KP 手动切换活动场景。
   *
   * 必须走 setActiveScene()：getCurrentState() 每次都新建并返回一个对象，
   * 对它的 .scene 赋值只会落在临时对象上，数据库里的 is_active 不会变。
   *
   * 场景必须已注册；未注册时返回 false 而不是顺手建一个垃圾场景，
   * 由调用方决定如何报错。
   */
  #setSceneCanonical(sceneId: string): boolean {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return false;
    if (!this.#worldRaw.getScene(sceneId)) return false;
    // 转发 setActiveScene 的**回读结果**，不是「我调用过了」。
    // 那两句 UPDATE 会先清空全部 is_active，目标不存在时world 里
    // 一个活动场景都不剩 —— 光靠「没抛异常」判断成功正是 §八 两次事故的形状。
    const priorScene = this.#worldRaw.getCurrentState().scene;
    const changed = this.#worldRaw.setActiveScene(sceneId);
    if (changed && priorScene !== sceneId) this.#bumpFacadeMutationRevision();
    return changed;
  }
  /** 当前会话映射到 applyAction 所需的只读状态快照。 */
  getGateState(): GateState {
    this.#assertSessionReadable();
    return this.#gateStateProjection();
  }

  #gateStateProjection(): GateState {
    return buildDifficultyGateState(this.#activeDifficulty?.label ?? "medium");
  }

  setDifficulty(diff: string): Result<StateDelta, RejectReason> {
    return this.#setDifficultyCanonical(diff);
  }

  #setDifficultyCanonical(diff: string): Result<StateDelta, RejectReason> {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#compiledMutationBlocked()) return { ok: false, error: { code: "unknown_action", actionId: "compiled_mutation_unsupported" } };
    const priorDifficulty = this.#activeDifficulty?.label;
    const result = applyAction(COC_SESSION_SCENARIO, this.#gateStateProjection(), {
      kind: "freeform",
      actor: "kp",
      description: `set difficulty to ${diff}`,
      effects: [{ variable: "difficulty", to: diff }],
    });
    if (!result.ok) return result;

    // 直接用 module-difficulty 的权威难度表。
    // 此前这里内联了一份退化副本：label 填的是中文显示名，而权威表里 label 是判别式
    // （getPushNarration 对它做 switch），clueOnFail 还用了 "generous"/"hidden" 这两个
    // 并不存在的取值，同时丢掉了 pushAllowed / pushCostMultiplier / failureGuidance。
    if (isDifficultyLabel(diff)) {
this.#activeDifficulty = getDifficultyProfile(diff);
      // ⚠ 这一句原先不存在：难度**设了但没人告诉调查引擎**。
      //   `InvestigationEngine.setDifficultyProfile()` 全仓零调用方，
      //   于是 `difficultyProfile` 恒为 null，`effectiveProfile` 一直回落到
      //   那份写死的 medium 画像。后果是 KP 把难度调成 nightmare 之后：
      //     · 惩罚骰仍然是 0（应该 +2）
      //     · 线索的 SAN 倍率仍然是 1（应该 2 倍）
      //   —— 难度按钮按下去，调查这一块**什么都没变**。
this.#investigationRaw.setDifficultyProfile(this.#activeDifficulty);
    }
if (priorDifficulty !== this.#activeDifficulty?.label) this.#bumpFacadeMutationRevision();
    return result;
  }

  /**
   * 每回合意图路径的本地复现轨迹（开发·每回合意图的可观测性）。
   *
   * scope 固定为 `intent-trace`，一局里同一回合的行都带 round/pc，便于：
   *
   *   rg '\[intent-trace\].*round=17' server-out.log
   *
   * ⚠ 必须是 debug，不是 info/warn：log.ts:11 已裁定 debug 是"本地复现用，
   * 默认不输出"，这一轮只加观察、玩家可见行为和默认日志行数都必须是零变更。
   * log.ts:38 的 sink 还决定了 debug/info 进 stdout（服务端是 server-out.log），
   * 而 LLM 回落 warn 进 stderr（server-err.log）——两份文件不能混看；过去有
   * 模拟 prompt 把这件事指错过，特此钉在产生轨迹的地方。
   *
   * 不记 narrative 正文（会淹没路径）；input 原文例外，它是复现的关键。
   */
  private traceIntent(message: string): void {
    log.debug("intent-trace", `round=${this.#roundRaw} pc=${this.#activePlayerId} ${message}`);
  }

  /** These protocols already have a unique local meaning and never ask a model. */
  private hasDeterministicIntentProtocol(
    input: string,
    actingPcId: string | undefined,
    localCommand: OrdinaryLocalCommand | null,
  ): boolean {
    const actorId = actingPcId ?? this.#activePlayerId;
    return localCommand !== null
      || this.#pendingLeaveConfirm
      || this.#pendingCompoundMove.has(actorId)
      || (this.#registeredModules.length > 0 && isExplicitLeaveIntent(input));
  }

  /** Exact ordinary-command names backed by the same module objects the loader installs. */
  private moduleCommandCatalog(): Array<{ displayName: string; names: string[]; module: LoadedModule }> {
    const catalog: Array<{ displayName: string; names: string[]; module: LoadedModule }> = [
      {
        displayName: "阿卡姆档案检查",
        names: ["阿卡姆档案检查", ARKHAM_LIBRARY_MODULE.name],
        module: ARKHAM_LIBRARY_MODULE,
      },
      {
        displayName: "印斯茅斯的阴影",
        names: ["印斯茅斯的阴影", INNSMOUTH_MODULE.name],
        module: INNSMOUTH_MODULE,
      },
    ];
    const custom = getCustomModule("premiers_barn");
    if (custom) {
      const canonicalName = isModuleData(custom.module) ? custom.module.title : custom.module.name;
      catalog.unshift({
        displayName: custom.name,
        names: [...new Set([custom.name, canonicalName])],
        module: custom.module,
      });
    }
    return catalog;
  }

  private moduleForLocalCommand(name: string): LoadedModule | null {
    return this.moduleCommandCatalog().find((entry) => entry.names.includes(name))?.module ?? null;
  }

  private findCompanionId(name: string): string | undefined {
    return [...this.#companionManagerRaw.getAllStates().entries()]
      .find(([id, companion]) => companion.active && (companion.config.name === name || id === name))?.[0];
  }

  /** A registered inactive companion may be named in an error, but never selected as an action target. */
  private hasRegisteredCompanion(name: string): boolean {
    return [...this.#companionManagerRaw.getAllStates().entries()]
      .some(([id, companion]) => companion.config.name === name || id === name);
  }

  /**
   * In API-required sessions, only a command whose target is already owned by
   * this session can bypass model classification. Direct/CLI callers retain
   * their historical preferred-parser behavior.
   */
  private resolveSessionOwnedLocalCommand(command: OrdinaryLocalCommand | null): OrdinaryLocalCommand | null {
    if (!command || this.#intentPolicy !== "required") return command;
    switch (command.kind) {
      case "slash":
        return command;
      case "load_module":
        return command.moduleName === undefined || this.moduleForLocalCommand(command.moduleName) ? command : null;
      case "recruit":
        // The parser's exact two-token grammar is the local contract here.
        // Occupation validation remains in the shared addPartyMember handler.
        return command;
      case "companion":
        // Keep known inactive companions on the deterministic command path so
        // the handler can report their actual state instead of model-falling
        // back.  `findCompanionId` still admits only active action targets.
        return this.hasRegisteredCompanion(command.name) ? command : null;
    }
  }

  #intentPolicyFailure(code: "intent_model_unavailable" | "intent_model_invalid", errorCode: string): ActionResponse {
    this.traceIntent(`route=intent status=refused errorCode=${errorCode}`);
    return {
      narrative: "",
      events: [],
      state: this.#stateProjection(),
      error: { code, intentErrorCode: errorCode },
    };
  }

  /** Refuse a would-be Career side effect before a turn can begin. */
  #ordinaryDurableCareerActionRequired(): ActionResponse {
    return {
      narrative: "",
      events: [],
      state: this.#stateProjection(),
      error: { code: "ordinary_durable_transaction_required" },
    };
  }

  /** A new base plus old deltas would replay growth twice; no checkpoint schema exists yet. */
  #ordinaryCareerRebaseUnsupported(): ActionResponse {
    return {
      narrative: "",
      events: [],
      state: this.#stateProjection(),
      error: { code: "ordinary_career_rebase_unsupported" },
    };
  }

  #legacySaveWouldRebaseCareer(): boolean {
    const characterName = this.#activeCharacterRaw?.name;
    return characterName !== undefined && this.#ensureCareerStore().getEntries(characterName).length > 0;
  }

  /**
   * These labels remain valid parser outputs for provider compatibility, but
   * ordinary sessions have no authoritative equipment slots, consumable
   * effects, ammunition state, skill-point allocation, or commerce protocol.
   * Refuse before a turn starts.
   */
  #unsupportedOrdinaryIntent(input: string, intent: ActionIntent, actorId: string): ActionResponse | undefined {
    if (intent.action === "legacy" && isLegacyLoad(input)) {
      return {
        narrative: "",
        events: [],
        state: this.#stateProjection(),
        error: { code: "ordinary_action_unsupported" },
      };
    }
    switch (intent.action) {
      case "equip":
      case "unequip":
      case "use_item":
      case "allocate_skills":
      case "reload":
      case "shop":
        return {
          narrative: "",
          events: [],
          state: this.#stateProjection(),
          error: { code: "ordinary_action_unsupported" },
        };
      case "buy":
      case "sell":
        return {
          narrative: "",
          events: [{
            speaker: "系统",
            content: intent.action === "buy"
              ? this.#buyUnavailableMessage(intent)
              : this.#sellUnavailableMessage(intent, actorId),
            type: "system",
          }],
          state: this.#stateProjection(),
          error: { code: "ordinary_action_unsupported" },
        };
      default:
        return undefined;
    }
  }

  // ============================================================
  // getSuggestions (行动提示)
  // ============================================================

  /**
   * NPC 名字/场景条件文本里"·"和"_"混用时的归一化比较键——同一个人（如
   * "菲碧·特里坎"）在模组数据里，NPC 实体名用"·"，但部分自定义模组
   * （premiers_barn.ts 的 nav 表）把 NPC 也塞进了场景导航图里当"目的地"，
   * 那份表里的 key 用的是"_"（"菲碧_特里坎"）。两处原本各写一份归一化，
   * 现在共用同一个，getSuggestions() 的 NPC-非地点 过滤（任务4）与
   * buildPresentNPCProfiles() 的 hook 匹配都靠它。
   */
  private normalizeNpcNameSeparators(s: string): string {
    return s.replace(/[·、_\- ]/g, "");
  }

  /**
   * 当前场景的行动锚点。
   *
   * ⚠ 这是给前端直接点的：App.vue 会把 suggestions 里的字符串**原样**送回
   * act()，所以不能返回「这里还有没查过的东西」这种不可执行的描述句；每条
   * 都必须是合法的自由文本动作。中粒度提示靠可点击动作本身表达：有本 PC
   * 尚未发现的场景线索时说「仔细搜查这里」，全部发现后降成「环顾四周」——
   * 这确实告诉玩家“还有没有”，但不说是什么（不泄露任何线索名称），正是
   * 本轮裁定的中粒度，不是意外剧透。
   *
   * pcId 缺省时取 activePlayerId，保持 GET /suggestions 既有客户端行为；
   * 调用方传 pcId 时只用于读取该 PC 的私密线索发现状态，不切换 active PC，
   * 避免 GET 请求触发 todo 里已记录的 activePlayerId 粘性问题。未知 pcId
   * 由 server.ts 在路由层翻成 404（同 GET /history?pcId= 的口径）。
   */
  getSuggestions(pcId: string = this.#activePlayerId): string[] {
    this.#assertSessionReadable();
    if (this.#compiledModule) return this.#compiledAvailableActionsProjection().map((action) => action.command);
    const following: string[] = [];
    if (this.#combatActiveRaw) {
      // 战斗分支是已修回归（npc-fights-back.test.ts）：逐字保持，不能把
      // 场景锚点混进来，否则打起来又会提示调查/聊天。
      following.push("⚔️ 攻击敌人", "🛡️ 防御", "💊 使用物品", "🏃 撤退");
    } else {
      const pos = this.#displayedSceneProjection();
      // 按 pcId 查，不按整个会话：发现者私密的线索状态不能透给另一个 PC。
      // 不展示 clue id/name，只用“还有可搜内容”改变动作措辞，避免剧透。
      const undiscovered = this.#investigationRaw.getUndiscoveredSceneClues(pos, pcId);
      following.push(undiscovered.length > 0 ? "仔细搜查这里" : "环顾四周");

      // 只给真实在场、活着的 NPC 生成可点击对话动作；不编“老板”“前台”
      // 之类模组文本提到但运行时不存在的对象，也不拿 monster 当可交谈 NPC。
      for (const npc of this.#worldRaw.getEntitiesInScene(pos).filter((e) => e.type === "npc")) {
        following.push(`与 ${npc.name} 交谈`);
      }

      // exits 是 SceneRecord 的权威连接数据。目标展示名可能与运行时 id 不同，
      // 统一经 sceneDisplayNames 显示；原样提交的“前往 <name>”仍由既有移动
      // 解析路径处理。没有场景/出口时安静地少给动作，不编造“其他场景”。
      //
      // 开发·对象名通向线索 任务4：premiers_barn.ts 那份自定义模组的 nav
      // 表把 NPC 也当"目的地"塞进了场景图（"特里坎家"的 exits 里有
      // "菲碧_特里坎"/"米尔_特里坎"，纯粹是给 on_enter_scene hook 一个
      // 可以挂描写的 condition key，不是真地点）——25 回合实跑打出过
      // "前往 菲碧_特里坎"，人不是地方，玩家点了也走不到哪去。
      // 判据：目标（原始 id 或翻译后的展示名，两个都试）经
      // normalizeNpcNameSeparators 归一化后，命中任意一个在场景图里出现过
      // 的 NPC 全名，就不生成"前往"建议——不能用"description 为空"当信号，
      // 农场外围/报亭这类真地点同样没写描述，会被误伤。NPC 名单来自
      // getAllAliveEntities()（不按当前场景过滤，因为特里坎家的 NPC
      // "目的地"通常还没被当成实体注册在当前场景里）。
      const scene = this.#worldRaw.getScene(pos);
      const npcNameKeys = new Set(
        this.#worldRaw.getAllAliveEntities()
          .filter((e) => e.type === "npc")
          .map((e) => this.normalizeNpcNameSeparators(e.name)),
      );
      for (const exit of scene?.exits ?? []) {
    const target = this.#sceneDisplayNames[exit.target] ?? exit.target;
        if (
          npcNameKeys.has(this.normalizeNpcNameSeparators(exit.target)) ||
          npcNameKeys.has(this.normalizeNpcNameSeparators(target))
        ) {
          continue;
        }
        following.push(`前往 ${target}`);
      }
    }
    const comps = this.#companionManagerRaw.getActiveCompanions();
    if (comps.length > 0) following.push(`👥 指挥同伴 (${comps.length}人)`);
    return following;
  }

  // ============================================================
  // act() — 主游戏循环
  // ============================================================

  /**
   * 让一个动作发生。`actingPcId` 指定「以哪个 PC 的身份行动」——按 **pcId**
   * 路由（不再按角色显示名）：同名 PC 各按自己的 pcId 正确落到自己头上，
   * 不会像旧的按名字 find 那样取到第一个。
   *
   * ⚠ 并发缺口：act() 无锁地改写 #roundRaw / 私有 actor selector /
 * this.#turnMessages。两个客户端同时 POST 不同 pcId 时，后写者仍会覆盖
   * 先写者的回合内选择；公开 activePlayerId 只是只读视图，二者状态还会互相踩。**本轮不做回合
   * 锁**（那是 L3 类回合调度的范围），刻意留白——别误以为这条路由做完就能
   * 多端并发了。
   */
  /** 只按实体 HP 的真相源阻断已经倒下的当前行动者；不借用会话级 dead。 */
  #zeroHpActionBlockMessage(actor: WorldEntity | null): string | undefined {
    return actor && actor.hp <= 0 ? `${actor.name}的 HP归零，无法行动。` : undefined;
  }

  /**
   * Applies only to a GameSession player's active percentile action checks.
   * NPC attack rolls and mandatory SAN/CON/growth checks do not call this
   * gate. A player's dodge against an NPC counterattack does: it is the same
   * active player's percentile check. Statuses stay persisted exclusively on
   * the actor's WorldEntity.
   */
  private effectiveActivePercentileTarget(baseTarget: number): number {
    if (this.#activeRulesetRaw !== "cosmic-horror") return baseTarget;
    const statuses = this.#actingStatusesBeforeTick
      ?? this.#worldRaw.getEntity(this.#activePlayerId)?.status
      ?? [];
    return Math.max(0, baseTarget + getPercentileTargetModifier(statuses));
  }

  /**
   * The ordinary session has no authoritative equipped-weapon-to-skill
   * relation.  A free-form inventory string or an intent's display weapon is
   * therefore not evidence that a character is using any firearms specialty.
   *
   * The one representation we can verify is an unarmed attack: an omitted
   * weapon (or the regex parser's explicit 格斗(肉搏)) is backed by the active
   * CoC sheet's canonical `fighting` field. An omitted weapon is not enough
   * for the legacy text fallback: it has no source-bound equipment relation.
   * It may use fighting only for an explicit unarmed statement or a bare
   * attack form bound to the parser's target; every other fallback keeps its
   * legacy d100 behavior but cannot earn a fighting growth mark.
   */
  private ordinaryCoCUnarmedFightingTarget(intent: Pick<ActionIntent, "weapon" | "target">, sourceInput?: string): number | null {
    if (this.#activeRulesetRaw !== "cosmic-horror" || this.#compiledModule) return null;
    const weapon = intent.weapon?.trim();
    if (weapon !== undefined && weapon !== "" && weapon !== "格斗(肉搏)") return null;
    const compactInput = sourceInput?.replace(/\s+/g, "") ?? "";
    const compactTarget = intent.target?.replace(/\s+/g, "") ?? "";
    const explicitUnarmed = /(?:徒手|拳头|肉搏|格斗|踢)/.test(compactInput);
    const bareAttack = compactInput === "攻击"
      || (compactTarget !== "" && [
        `攻击${compactTarget}`,
        `向${compactTarget}攻击`,
        `对${compactTarget}攻击`,
      ].includes(compactInput));
    if (weapon !== "格斗(肉搏)" && !explicitUnarmed && !bareAttack) return null;
    const fighting = this.#activeCharacterRaw?.skillValues?.fighting;
    return typeof fighting === "number" && Number.isFinite(fighting)
      ? this.effectiveActivePercentileTarget(fighting)
      : null;
  }

  async act(input: string, actingPcId?: string): Promise<ActionResponse> {
    // A fail-stop closes its session. Preserve that established diagnostic
    // only for this combined state; normal close and acknowledged live
    // durable-session precedence remain owned by the shared guard below.
    if (this.#directActionFailStopped && this.#npcStoreClosed) {
      throw new Error("GameSession is unavailable after a prior action failure");
    }
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#directActionFailStopped) {
      throw new Error("GameSession is unavailable after a prior action failure");
    }
    return this.#runExclusiveActionTransactionCanonical(async (act) => {
      // A caller may have queued while the predecessor was running. Check
      // again only after obtaining the FIFO boundary, otherwise its partial
      // failure could release the lock before this action sees fail-stop.
      if (this.#directActionFailStopped) {
        throw new Error("GameSession is unavailable after a prior action failure");
      }
      const lifecycleRevision = this.#lifecycleRevision;
      if (!this.#directActionLifecycleIsCurrent(lifecycleRevision)) {
        throw this.#closedDirectActionError();
      }
      try {
        const response = await act(input, actingPcId, lifecycleRevision);
        // A session may be closed while intent/narration awaits an injected or
        // remote provider. Its completed work can no longer be acknowledged as
        // this live instance's result, nor can a caller broadcast or persist it.
        if (!this.#directActionLifecycleIsCurrent(lifecycleRevision)) {
          throw this.#closedDirectActionError();
        }
        return response;
      } catch (error) {
        // Preserve the original causal error for this action's own fail-stop;
        // established callers and diagnostics rely on it. An external close is
        // instead normalized to the stable unavailable/closed contract.
        if (this.#directActionFailStopped) throw error;
        if (!this.#directActionLifecycleIsCurrent(lifecycleRevision)) {
          throw this.#closedDirectActionError();
        }
        // This is deliberately inside the FIFO operation: close and mark the
        // session before `runExclusiveActionTransaction` releases a queued
        // action, so no follower can run against partial state.
        this.#failStopDirectAction();
        throw error;
      }
    });
  }

  /**
   * Trusted server integration may cover history snapshots, execution,
   * persistence, and broadcast with the same FIFO used by direct act().
   * The callback receives the unlocked executor so it cannot re-enter itself.
   */
  async runExclusiveActionTransaction<T>(
    operation: OrdinaryActionTransactionOperation<T>,
  ): Promise<T> {
    this.#assertOrdinaryDurableMutationAllowed();
    return this.#runExclusiveActionTransactionCanonical(operation);
  }

  /** True only while the module-private ordinary host authority owns this action. */
  #hasOrdinaryDurableActionContext(): boolean {
    return this.#ordinaryDurableActionDepth > 0;
  }

  /**
   * The WeakMap authority is the only caller of this wrapper. Keep the scope
   * on a private field and balance it in finally so public wrappers and
   * same-name shadows cannot manufacture durable Career write permission.
   */
  async #runOrdinaryDurableActionTransactionCanonical<T>(
    operation: OrdinaryActionTransactionOperation<T>,
  ): Promise<T> {
    const ancestorSessions = ordinaryDurableTransactionSessions.getStore();
    if (ancestorSessions?.get(this)?.active) throw new OrdinaryDurableTransactionReentryError();
    const transactionSessions = new Map(ancestorSessions);
    const token: OrdinaryDurableTransactionToken = { active: true };
    transactionSessions.set(this, token);
    return this.#runExclusiveActionTransactionCanonical(async (act, snapshotBeforeAction, lifecycle, sourceState) => {
      return ordinaryDurableTransactionSessions.run(transactionSessions, async () => {
        this.#ordinaryDurableActionDepth++;
        try {
          return await operation(act, snapshotBeforeAction, lifecycle, sourceState);
        } finally {
          this.#ordinaryDurableActionDepth--;
          token.active = false;
        }
      });
    });
  }

  /** The durable-host-only transaction path bypasses the public live-write guard to snapshot a source. */
  async #runExclusiveActionTransactionCanonical<T>(
    operation: OrdinaryActionTransactionOperation<T>,
  ): Promise<T> {
    const previous = this.#actionTransactionTail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#actionTransactionTail = previous.then(() => current, () => current);
    await previous.catch(() => undefined);
    this.#activeActionTransactions++;
    try {
      const lifecycleRevision = this.#lifecycleRevision;
      const lifecycle = { isCurrent: () => this.#directActionLifecycleIsCurrent(lifecycleRevision) };
      let actStarted = false;
      let snapshotConsumed = false;
      let preActionSnapshotHash: string | undefined;
      let preActionBusinessStateHash: string | undefined;
      let preActionFacadeMutationRevision: bigint | undefined;
      let preActionWorldSqliteMutationStamp: string | undefined;
      let preActionNpcStoreSqliteMutationStamp: string | undefined;
      let preActionSanity: unknown;
      let preActionSanityAssignmentRevision: bigint | undefined;
      let preActionSanitySemanticRevision: bigint | undefined;
      let preActionSanityCohort: ReadonlyArray<{ pcId: string; raw: SanityEngine; semanticRevision: bigint }> | undefined;
      let preActionPlayerSessionSemanticRevision: bigint | undefined;
      let preActionPlayerSessionStateReplacementRevision: bigint | undefined;
      let preActionAgentRegistrySemanticRevision: bigint | undefined;
      let preActionAgentRegistryStateReplacementRevision: bigint | undefined;
      let preActionSanityCaptured = false;
      const snapshotBeforeAction = (): OrdinaryGameSessionSnapshot => {
        if (actStarted || snapshotConsumed || this.#activeActionTransactions !== 1 || this.#actingStatusesBeforeTick !== undefined || this.#turnMessages !== null) {
          throw new Error("ordinary pre-commit snapshot requires the exact exclusive action boundary");
        }
        snapshotConsumed = true;
        this.#ordinaryCommitSnapshotExport = true;
        try {
          const snapshot = this.#exportOrdinarySessionSnapshotCanonical();
          preActionSnapshotHash = snapshot.snapshotHash;
          preActionBusinessStateHash = ordinaryGameSessionBusinessStateHash(snapshot);
          preActionFacadeMutationRevision = this.#facadeMutationRevision;
          preActionWorldSqliteMutationStamp = this.#worldSqliteMutationStamp();
          preActionNpcStoreSqliteMutationStamp = this.#npcStoreSqliteMutationStamp();
          preActionSanity = this.#sanityRaw;
          preActionSanityAssignmentRevision = this.#sanityAssignmentRevision;
          preActionSanitySemanticRevision = this.#sanityRaw.semanticRevision;
          preActionSanityCohort = captureSanityCohort(this.#sanityEngines);
          preActionPlayerSessionSemanticRevision = this.#playerSession.semanticRevision;
          preActionPlayerSessionStateReplacementRevision = this.#playerSession.stateReplacementRevision;
          preActionAgentRegistrySemanticRevision = this.#registryRaw.semanticRevision;
          preActionAgentRegistryStateReplacementRevision = this.#registryRaw.stateReplacementRevision;
          preActionSanityCaptured = true;
          return snapshot;
        }
        finally { this.#ordinaryCommitSnapshotExport = false; }
      };
      const sourceState = {
        /**
         * The portable hashes catch net synchronous business drift at the
         * captured FIFO boundary. The facade revision catches an exact
         * restore ABA interval through GameSession's supported synchronous
         * mutation facade. Connection-local SQLite stamps cover raw world and
         * NPCStore child writes. The captured SAN cohort pins every pcId,
         * raw engine identity, and semantic revision, including inactive
         * party members whose portable state can return to the same hash.
         * The existing active-engine installation and semantic guards remain
         * the narrower active-routing contract without making process-local
         * counters portable.
         * PlayerSession's semantic revision covers every routine child
         * mutation interval without becoming portable. Its replacement
         * revision remains the narrower whole-state restore contract.
         * AgentRegistry's semantic revision covers live membership and
         * active-agent runtime ABA. Its narrower replacement revision still
         * records every successful whole-registry restore because that path
         * replaces all live NPCAgent identities.
         */
        isPreActionSnapshotCurrent: (): boolean => {
          if (preActionSnapshotHash === undefined || preActionBusinessStateHash === undefined || preActionFacadeMutationRevision === undefined
            || preActionSanityAssignmentRevision === undefined
            || preActionSanitySemanticRevision === undefined
            || preActionSanityCohort === undefined
            || preActionPlayerSessionSemanticRevision === undefined
            || preActionPlayerSessionStateReplacementRevision === undefined
            || preActionAgentRegistrySemanticRevision === undefined
            || preActionAgentRegistryStateReplacementRevision === undefined
            || preActionWorldSqliteMutationStamp === undefined || preActionNpcStoreSqliteMutationStamp === undefined
              || !preActionSanityCaptured || this.#activeActionTransactions !== 1
              || this.#actingStatusesBeforeTick !== undefined || this.#turnMessages !== null) return false;
          if (this.#facadeMutationRevision !== preActionFacadeMutationRevision) return false;
          if (this.#sanityAssignmentRevision !== preActionSanityAssignmentRevision) return false;
          if (this.#sanityRaw !== preActionSanity) return false;
          if (this.#sanityRaw.semanticRevision !== preActionSanitySemanticRevision) return false;
          if (!isSanityCohortCurrent(preActionSanityCohort, {
            sanityEngines: this.#sanityEngines,
            party: this.#party,
            activeSanity: this.#sanityRaw,
            activePlayerId: this.#activePlayerId,
          })) return false;
          if (this.#playerSession.semanticRevision !== preActionPlayerSessionSemanticRevision) return false;
          if (this.#playerSession.stateReplacementRevision !== preActionPlayerSessionStateReplacementRevision) return false;
          if (this.#registryRaw.semanticRevision !== preActionAgentRegistrySemanticRevision) return false;
          if (this.#registryRaw.stateReplacementRevision !== preActionAgentRegistryStateReplacementRevision) return false;
          this.#ordinaryCommitSnapshotExport = true;
          try {
            if (this.#worldSqliteMutationStamp() !== preActionWorldSqliteMutationStamp) return false;
            if (this.#npcStoreSqliteMutationStamp() !== preActionNpcStoreSqliteMutationStamp) return false;
            const current = this.#exportOrdinarySessionSnapshotCanonical();
            return current.snapshotHash === preActionSnapshotHash
              || ordinaryGameSessionBusinessStateHash(current) === preActionBusinessStateHash;
          }
          catch { return false; }
          finally { this.#ordinaryCommitSnapshotExport = false; }
        },
      };
      return await operation((input, pcId, lifecycleRevision) => {
        actStarted = true;
        return this.#actUnlocked(input, pcId, lifecycleRevision);
      }, snapshotBeforeAction, lifecycle, sourceState);
    } finally {
      this.#activeActionTransactions--;
      release!();
    }
  }

  /**
   * Ordinary direct actions couple the private active-player selector,
   * character authority, SAN engine, and PlayerSession active view. Their
   * public activePlayerId/activeCharacter views are read-only, and sanity is
   * a state-only read facade. The action boundary refuses inconsistent
   * supported routing rather than repairing it.
   */
  #activePlayerStateInconsistent(): ActionResponse {
    return {
      narrative: "",
      events: [],
      state: this.#stateProjection(),
      error: { code: "active_player_state_inconsistent" },
    };
  }

  /**
   * Pure direct-act routing validation: safe before a required intent await.
   * A supported ordinary actor switch below synchronizes activePlayerId,
   * activeCharacter, sanity, and the PlayerSession active view in one no-await
   * commit. The public selector, character, and SAN surfaces are read-only;
   * this gate rejects PlayerSession active-routing and private current-SAN
   * alias mismatches without attempting silent repair.
   */
  #validateOrdinaryDirectActor(actingPcId?: string): ActionResponse | undefined {
    const currentId = this.#activePlayerId;
    const activeSlot = this.#playerSession.getActive();
    const currentSanity = this.#sanityEngines.get(currentId);
    const currentCohortMatches = activeSlot?.name === currentId
      && activeSlot.characterId === currentId
      && currentSanity === this.#sanityRaw;
    if (!currentCohortMatches) return this.#activePlayerStateInconsistent();

    // Omitting an actor, or restating the current one, is a verified no-op.
    if (actingPcId === undefined || actingPcId === currentId) return undefined;

    const targetSanity = this.#sanityEngines.get(actingPcId);
    const targetSlot = this.#playerSession.get(actingPcId);
    if (!this.#characters.has(actingPcId)
      || !targetSanity
      || targetSlot?.name !== actingPcId
      || targetSlot.characterId !== actingPcId) return this.#activePlayerStateInconsistent();

    return undefined;
  }

  /** Revalidates after intent preparation, then performs the no-await actor switch. */
  #commitOrdinaryDirectActor(actingPcId?: string): ActionResponse | undefined {
    const validation = this.#validateOrdinaryDirectActor(actingPcId);
    if (validation) return validation;

    const currentId = this.#activePlayerId;
    if (actingPcId === undefined || actingPcId === currentId) return undefined;
    const targetSanity = this.#sanityEngines.get(actingPcId);
    if (!targetSanity || !this.#playerSession.switchActive(actingPcId)) return this.#activePlayerStateInconsistent();
    this.#activePlayerId = actingPcId;
    this.#installActiveCharacter(this.#characters.get(actingPcId));
    this.#installSanityEngine(targetSanity);
    return undefined;
  }

  async #actUnlocked(input: string, actingPcId?: string, lifecycleRevision?: number): Promise<ActionResponse> {
    this.#assertOrdinaryDurableMutationAllowed();
    if (this.#npcStoreClosed) throw new Error("closed GameSession cannot accept actions");
    // Durable compiled sessions have no in-memory execution path. Their action
    // transaction must persist and then replace this object through server rehydration.
    if (this.#isDurableCompiledSession()) return this.#compiledFailure(this.#compiledFailStopped ? "compiled_unavailable" : "compiled_action_contract_required");
    // A confirmed departure can settle growth and append a Career entry. Do
    // not clear its pending flag, advance its turn, or terminalize it unless
    // the private durable-host transaction owns this exact action.
    if (this.#careerEntryPersistence !== "transient"
      && this.#pendingLeaveConfirm
      && isConfirmReply(input)
      && !this.#hasOrdinaryDurableActionContext()) {
      return this.#ordinaryDurableCareerActionRequired();
    }
    // The ordinary terminal gate is deliberately before PC routing, intent
    // resolution, clocks, and every other action side effect. A departure is
    // terminal despite `dead === false`.
    if (!this.#compiledModule && this.#ordinarySessionIsTerminal()) {
      return this.#buildActionResponse([{ speaker: "系统", content: this.#ordinaryTerminalActionMessage(), type: "system" }]);
    }
    // 未知 pcId 必须在任何状态改动前拒绝——activePlayerId 绝不能"先切过去
    // 再发现切不了"。存活过一个真 bug：切换在改动之后才判，返回给前端的是
    // "已切换"的假象。这里不折成系统消息、不兜底回 p1（那正是本仓反复修的
    // "报告了一件没发生的事"），而是结构化置 error。
    if (actingPcId !== undefined && !this.#characters.has(actingPcId)) {
      return {
        narrative: "",
        events: [],
        state: this.#stateProjection(),
        error: { code: "unknown_target", targetId: actingPcId },
      };
    }
    // Compiled sessions accept only their explicit codec. This interception is
    // before legacy turn/tick/intent routing, so no hand-authored mechanic can
    // become a second authority for a compiler-owned session.
    if (this.#compiledModule) return this.#actCompiled(input);

    // This first phase is pure: a required intent provider can fail or await
    // without leaving a requested actor switch behind.
    const actorPreflight = this.#validateOrdinaryDirectActor(actingPcId);
    if (actorPreflight) return actorPreflight;

    // Required HTTP intent resolution is a prepare step. Do it before any
    // round, time, history, actor, world, or liveness mutation can occur.
    const localCommand = this.resolveSessionOwnedLocalCommand(parseOrdinaryLocalCommand(input));
    let preparedIntent: ActionIntent | undefined;
    if (!this.hasDeterministicIntentProtocol(input, actingPcId, localCommand)) {
      const resolution = await resolveNormalSessionIntent(input, this.#intentLLM, this.#intentPolicy);
      // The provider is intentionally outside the turn mutation region. If a
      // caller closed this session while it waited, stop before a late model
      // reply can begin a round against the retired instance. The final check
      // in act() covers every remaining return path.
      if (lifecycleRevision !== undefined && !this.#directActionLifecycleIsCurrent(lifecycleRevision)) {
        throw this.#closedDirectActionError();
      }
      if (resolution.status !== "resolved") {
        const publicCode = resolution.status === "invalid" ? "intent_model_invalid" : "intent_model_unavailable";
        this.traceIntent(`route=intent status=${resolution.status} latencyMs=${resolution.latencyMs} errorCode=${resolution.errorCode}`);
        return this.#intentPolicyFailure(publicCode, resolution.errorCode);
      }
      preparedIntent = resolution.intent;
      this.traceIntent(`route=intent provenance=${resolution.provenance} latencyMs=${resolution.latencyMs} action=${resolution.intent.action}`);
    }

    // A valid model label is not proof that this runtime can execute it. Keep
    // unsupported state-changing intents outside lastActiveAt, round/time,
    // status ticks, history, and every other turn-side mutation.
    if (preparedIntent) {
      const refusal = this.#unsupportedOrdinaryIntent(input, preparedIntent, actingPcId ?? this.#activePlayerId);
      if (refusal) return refusal;
    }

    // A saved base with retained growth entries would make the Career loader
    // fold those deltas twice. There is no checkpoint/cutoff schema yet, so
    // reject that write before the turn mutation region even for durable HTTP.
    if (preparedIntent?.action === "legacy" && isLegacySaveCommand(input) && this.#legacySaveWouldRebaseCareer()) {
      return this.#ordinaryCareerRebaseUnsupported();
    }

    // These handlers can write an independent Career root. Refuse before the
    // actor/time/round/history mutation region unless the WeakMap-only host
    // transaction installed the private durable-action context.
    if (!this.#hasOrdinaryDurableActionContext()
      && ((preparedIntent?.action === "legacy" && isLegacySaveCommand(input) && this.#activeCharacterRaw !== null)
        || (this.#careerEntryPersistence !== "transient" && localCommand?.kind === "recruit")
        || (this.#careerEntryPersistence !== "transient"
          && preparedIntent?.action === "create_character"
          && isCareerWritingCharacterCreation(input, this.#activeRulesetRaw)))) {
      return this.#ordinaryDurableCareerActionRequired();
    }

    // Public children may have changed while intent preparation awaited. Recheck
    // and commit the switch only after preparation succeeds, still before every
    // turn-side write.
    const actorCommit = this.#commitOrdinaryDirectActor(actingPcId);
    if (actorCommit) return actorCommit;
    this.#actingStatusesBeforeTick = undefined;
    this.#lastActiveAtRaw = Date.now();
    // Actor selection, including the same-actor no-op, completed in the
    // no-await post-prepare commit above.
    // 已经倒下的 PC 不能反复提交空行动来推进全局时钟或 tick 别人。这里在
    // 一切本回合副作用之前拒绝；首次由状态 tick 从 1 降为 0 的情形仍会走到
    // 后面的 post-tick 检查，保留那一次伤害与回合消耗。
    const actorBeforeTurn = this.#worldRaw.getEntity(this.#activePlayerId);
    this.#actingStatusesBeforeTick = actorBeforeTurn?.status ?? [];
    const zeroHpBeforeTurn = this.#zeroHpActionBlockMessage(actorBeforeTurn);
    if (zeroHpBeforeTurn) {
      this.#lastNarrative = zeroHpBeforeTurn;
      return this.#buildActionResponse([{ speaker: "系统", content: zeroHpBeforeTurn, type: "system" }]);
    }
    // 必须在回合推进前读一次：`stunned` 的默认时限是 1 回合；若只在
    // tick 之后查看，它会在意图派发前消失，永远约束不到真实玩家行动。
    // 状态仍只存于世界实体的 `status: string[]`，具体何者阻断行动则由
    // status-effects 的结构化定义判定，不能在此按描述文本猜测。
    const actingStatusBeforeTick = getActionBlockingStatus(
      this.#worldRaw.getEntity(actingPcId ?? this.#activePlayerId)?.status ?? [],
    );
    this.#roundRaw++;
    this.#gameTime = advanceTime(this.#gameTime);
    this.#companionManagerRaw.newRound();
    // 限时状态（流血/中毒/燃烧…）在这里推进一回合。
    // 这一句原先不存在 —— 状态被写上去之后再没人碰过它们。
    // tick 的 HP 真相源是世界实体，不是上一轮缓存。行动者若恰好被本回合
    // 的流血/大出血等状态降至 0，回合已经消耗、伤害也已经记录，但绝不能
    // 继续派发意图、SAN 目击或经济事件。普通会话终态由其判别值持有，`dead`
    // 只是死亡的派生兼容视图；这里不能把单个 PC 的状态伤害扩大成全队终局；
    // 只拒绝本次实际 actor，健康的其他 PC 仍可在其自己的回合行动。
    this.tickStatusEffects();
    const zeroHpAfterTick = this.#zeroHpActionBlockMessage(this.#worldRaw.getEntity(this.#activePlayerId));
    if (zeroHpAfterTick) {
      this.#lastNarrative = zeroHpAfterTick;
      return this.#buildActionResponse([{ speaker: "系统", content: zeroHpAfterTick, type: "system" }]);
    }
    // 神话生物首次目击的 SAN 检定。原先 `getSanCost()` 零调用方，
    // 于是遭遇修格斯和遭遇一条野狗对理智的影响完全一样。
    const sightingMsgs: string[] = [];
    this.checkMythosSighting((s) => sightingMsgs.push(s));
    const economyMsgs: string[] = [];
    this.tickEconomy((s) => economyMsgs.push(s));
    const turnMessages: AgentMessage[] = [];
    for (const s of sightingMsgs) turnMessages.push({ speaker: "系统", content: s, type: "system" });
    for (const s of economyMsgs) turnMessages.push({ speaker: "系统", content: s, type: "system" });
    // 供模组宿主适配器把加载期产生的消息投进本回合，见 _turnMessages 的说明
    this.#turnMessages = turnMessages;

    const activePlayer = this.#playerSession.getActive();
    const playerName = activePlayer?.characterName ?? "调查员";

    if (actingStatusBeforeTick) {
      const message = `${playerName}正处于${actingStatusBeforeTick.name}状态，无法行动。`;
      this.#lastNarrative = message;
      turnMessages.push({ speaker: "系统", content: message, type: "system" });
      return this.#buildActionResponse(turnMessages);
    }

    // 确认门 1/2：离开确认——party 级，不认人，谁的下一句都算数（见
    // pendingLeaveConfirm 字段注释）。代价对称——不管答的是什么，这一回合
    // 本来就会推进的那 1 tick（上面的 advanceTime）已经花掉了。
    if (this.#pendingLeaveConfirm) {
      this.#pendingLeaveConfirm = false;
      this.traceIntent(`route=confirmation type=leave replyLength=${Array.from(input).length} confirmed=${isConfirmReply(input)}`);
      turnMessages.push({ speaker: playerName, content: input, type: "action" });
      if (isConfirmReply(input)) {
        this.resolveModuleDeparture(turnMessages);
      } else {
        turnMessages.push({ speaker: "系统", content: "你们决定还是先留下，继续这次调查。", type: "system" });
      }
      return this.#buildActionResponse(turnMessages);
    }

    // 确认门 2/2：复合句回问——**认人**，只有触发它的那个 PC
    // （the active selector, already switched above by actingPcId）的下一句才算
    // 回答。这正是要修的跨 PC 泄漏：p1 的回问此前会被 p2 完全无关的一句
    // 话答掉（2026-08-30 实测会话 lcmj2joi，回合 7→8）。
    const myPendingMove = this.#pendingCompoundMove.get(this.#activePlayerId);
    if (myPendingMove) {
      this.#pendingCompoundMove.delete(this.#activePlayerId);
      this.traceIntent(`route=confirmation type=compound replyLength=${Array.from(input).length} originalAction=${myPendingMove.originalIntent.action}`);
      turnMessages.push({ speaker: playerName, content: input, type: "action" });
      await this.resolveCompoundMoveReply(myPendingMove, input, turnMessages);
      return this.#buildActionResponse(turnMessages);
    }
    // 别的 PC 还有没回答的回问：不拦截这个 PC 自己的行动（照常往下走，
    // 按它自己的意图执行），但提醒一句——"可能永远挂着"是已知且接受的
    // 风险（见 pendingCompoundMove 字段注释），不做成静默等待，让玩家
    // 至少知道还有一个问题没人接。
    if (this.#pendingCompoundMove.size > 0) {
      const openFor = [...this.#pendingCompoundMove.keys()].join("、");
      turnMessages.push({
        speaker: "系统",
        content: `（提醒：${openFor} 还有一个"要不要先移动"的问题没有回答。）`,
        type: "system",
      });
    }

    // 脱离模组请求：只认输入本身有没有明确表达"离开/结束调查"（见
    // isExplicitLeaveIntent 的注释），**不依赖意图解析把这句话分到哪个
    // action**——"结束这次调查"这类句子会被意图解析里"调查"关键词命中
    // 判成 skill_check，如果把这条检查挂在 case "move" 下面就永远碰不到。
    // 只在有模组注册时才有意义（"超出模组写明的位置"这个概念本身要有
    // 模组才成立），且只在这个 PC 自己没有待确认请求时才触发（上面已经
    // 处理过了；不检查别的 PC 是否有未答的 compound-move——两者范围不同，
    // 见 pendingCompoundMove/pendingLeaveConfirm 字段注释）。
    if (this.#registeredModules.length > 0 && isExplicitLeaveIntent(input)) {
      turnMessages.push({ speaker: playerName, content: input, type: "action" });
      this.#pendingLeaveConfirm = true;
      turnMessages.push({
        speaker: "系统",
        content: "你确定要离开这里吗？这会结束这次调查。（回复「确定」继续，其它任何话都视为取消）",
        type: "system",
      });
      this.#lastNarrative = "KP 在等你确认是否要离开这次调查。";
      return this.#buildActionResponse(turnMessages);
    }

    // 斜杠命令
    if (localCommand?.kind === "slash") {
      const handled = await this.handleSlashCommand(localCommand, turnMessages);
      if (handled) return this.#buildActionResponse(turnMessages);
    }

    // 队友命令
    //
    // ⚠ 此前这里自己拼了一份四步版本（characters.set / 硬编码
    // `new SanityEngine(50)` / registerPlayer / persistSanity），跟统一
    // 入口比缺四样：不取角色真实 POW、不 join 会话槽位（这个 PC 的
    // messageHistory 从此没有归属）、不 upsertEntity（世界实体不存在——
    // 构造函数注释记过这个后果的原话：「开局的 KP 伤害因为找不到实体而
    // 失败……两相抵消，谁都看不出来」，这个 bug 对 p2+ 一直活着）、不建
    // careerStore 快照。现在走统一入口。
    if (localCommand?.kind === "recruit") {
      const { name, archetypeId: cls } = localCommand;
      // 走 addPartyMember（与 web 的 POST /party 同一入口）：建卡 + 兜底链
    // 解析扮演元数据 + #createPartyMember 一次做齐八件事。
      // 文本命令没有 body，故 meta 不传 —— 走兜底链（模组/推导/LLM），
      // 与 web 端点能接收 HTTP 字段的能力不同（见 addPartyMember 注释）。
      const result = await this.#addPartyMemberCanonical(name, cls);
      if ("rejected" in result) {
        turnMessages.push({ speaker: "系统", content: result.rejected, type: "system" });
        return this.#buildActionResponse(turnMessages);
      }
      turnMessages.push({ speaker: "系统", content: `👤 ${name}(${cls}) 加入了队伍`, type: "system" });
      if (result.warning) turnMessages.push({ speaker: "系统", content: `⚠️ ${result.warning}`, type: "system" });
      return this.#buildActionResponse(turnMessages);
    }

    turnMessages.push({ speaker: playerName, content: input, type: "action" });

    // NPC/同伴指令检查
    const companionCommand = localCommand?.kind === "companion" ? localCommand : null;

    // ⚠ 这四条命令原先**全是门面**：只推一句话，一个都不碰 companionManager。
    //
    //   `自动/放手/AI X` 更彻底 —— 正则匹配出来了却连 if 都没有（`autoMatch`
    //   是 tsc 的 noUnusedLocals 报的），玩家能接管同伴却交不回去。
    //
    //   而控制系统本身是**完整实现且有测试**的：`setControl` / `getControl` /
    //   `transferControl` / `getPlayerControlled`，`companion-manager.ts:589`
    //   还在按 `control !== "auto"` 决定同伴这一轮自不自己动。
    //   实测这几个方法**只有测试在调用**，生产码一次都不碰 ——
    //   跟流血、跟追逐是同一个故事：实现了、测了、没接上。
    //
    //   找不到人时要说出来。原先「接管 张三」无论张三在不在队里都回同一句，
    //   打错名字与真的接管在播报上完全一样。
    // CompanionState 身上没有 id —— id 是 Map 的键，所以按 entries 找。
    /**
     * 找不到同伴时说清楚为什么。
     *
     * ⚠ 原先四条指令共用一句「队伍里没有「X」」，而这句话会和上一回合的播报
     *   **直接打架**：
     *
     *     > 创建队友 乙 investigator    👤 乙(investigator) 加入了队伍
     *     > 接管 乙                     队伍里没有「乙」。
     *
     *   因为这里有**两套并行的「队伍」**：
     *     · `创建队友` 加进 `this.characters` —— 那是第二个**玩家角色**
     *     · 邀请/告别/接管/自动 操作的是 `CompanionManager` —— NPC 同伴
     *   两者互不相通，而报错只说「没有」，不说是哪一种没有。
     *
     *   （另：`CompanionManager.recruit()` 生产代码里零调用方，
     *     实际对局中同伴名册**永远是空的**。这四条指令目前只可能走到这个分支。）
     */
    const notFoundLine = (name: string): string => {
      const inactiveCompanion = [...this.#companionManagerRaw.getAllStates().entries()].some(
        ([id, companion]) => !companion.active && (companion.config.name === name || id === name),
      );
      if (inactiveCompanion) {
        return `「${name}」当前不在队伍中，不能执行此同伴命令。`;
      }
      const isPc = [...this.#characters.values()].some(
        (c) => (c as { name?: string }).name === name,
      );
      return isPc
        ? `「${name}」是你的队友（玩家角色），不是可指挥的 NPC 同伴 —— 邀请/告别/接管 这几条只对 NPC 同伴有效。`
        : `队伍里没有「${name}」。`;
    };

    if (companionCommand?.operation === "invite") {
      const who = companionCommand.name;
      const c = this.findCompanionId(who);
      if (!c) {
        turnMessages.push({ speaker: "系统", content: notFoundLine(who), type: "system" });
      } else if (!this.#companionManagerRaw.markInvited(c)) {
        turnMessages.push({ speaker: "系统", content: `「${who}」已经收到过邀请，无需重复邀请。`, type: "system" });
      } else {
        turnMessages.push({ speaker: "系统", content: `你向 ${who} 发出了邀请`, type: "system" });
      }
      return this.#buildActionResponse(turnMessages);
    }
    if (companionCommand?.operation === "farewell") {
      const who = companionCommand.name;
      const c = this.findCompanionId(who);
      if (!c) {
        turnMessages.push({ speaker: "系统", content: notFoundLine(who), type: "system" });
      } else {
        const line = this.#companionManagerRaw.handleDeparture(c, this.#worldRaw, "player-farewell");
        turnMessages.push({
          speaker: "系统",
          content: line ?? `无法让「${who}」离队；状态未改变。`,
          type: "system",
        });
      }
      return this.#buildActionResponse(turnMessages);
    }
    if (companionCommand?.operation === "control") {
      const who = companionCommand.name;
      const c = this.findCompanionId(who);
      if (!c) {
        turnMessages.push({ speaker: "系统", content: notFoundLine(who), type: "system" });
      } else if (!this.#companionManagerRaw.setControl(c, `player:${this.#activePlayerId}`)) {
        turnMessages.push({ speaker: "系统", content: `无法接管「${who}」；控制权未改变。`, type: "system" });
      } else {
        turnMessages.push({ speaker: "系统", content: `你接管了 ${who} 的控制权`, type: "system" });
      }
      return this.#buildActionResponse(turnMessages);
    }
    if (companionCommand?.operation === "auto") {
      const who = companionCommand.name;
      const c = this.findCompanionId(who);
      if (!c) {
        turnMessages.push({ speaker: "系统", content: notFoundLine(who), type: "system" });
      } else if (!this.#companionManagerRaw.setControl(c, "auto")) {
        turnMessages.push({ speaker: "系统", content: `无法将「${who}」恢复为自主行动；控制权未改变。`, type: "system" });
      } else {
        turnMessages.push({ speaker: "系统", content: `${who} 恢复自主行动。`, type: "system" });
      }
      return this.#buildActionResponse(turnMessages);
    }

    // ── 意图派发（意图解析 → 结构化处理器）──
    const deferredIntent = preparedIntent
      ? null
      : await resolveNormalSessionIntent(input, this.#intentLLM, "preferred");
    const intent = preparedIntent
      ?? (deferredIntent?.status === "resolved" ? deferredIntent.intent : { action: "unknown" });
    this.traceIntent(`route=intent action=${intent.action} inputLength=${Array.from(input).length}`);

    // 复合句回问：先移动再做事（开发·复合意图回问，任务1）。
    //
    // 引擎是"一句话=一个意图"的模型。玩家自然会说复合句（"陆川带大家前往
    // 农场外围，沿着...寻找可疑足迹"），LLM 只能二选一，通常执行后半段、
    // 丢掉前半段的移动，scene 不变。这不纯是模型判错——引擎没有"先移动
    // 再做事"的表达方式，是设计缺口。已裁决走 B 方案（明确回问），不是
    // A（返回动作序列，那是独立一轮）：拿一个回合换掉一次静默误判，
    // 与离开确认门、线索歧义反问（resolveSceneClueMatch 的"你想找什么？"）
    // 是同一个模式。
    //
    // 检测：intent.action 命中下面这份**白名单**（不是"排除 move/look 之外
    // 全都算"）时，对原始输入跑 resolveSceneTarget 能找到一个**有把握**
    // （!forced）、且不是当前场景的地点——这多半是"提到了要去哪，但意图
    // 被判成了别的动作"。forced=true（没把握、猜的）故意不算：那种情况下
    // "到底提没提地名"本身就不确定，再叠一层回问只会让本来能通过 LLM
    // 判对的输入也开始被追问。
    //
    // ⚠ 白名单而不是"排除 move/look"：第一版就是这么写的，"加载模组
    // 普瑞米尔的谷仓"这句里"普瑞米尔"恰好也是一个真实场景名（镇子枢纽），
    // intent.action="load_module" 不是 move/look，于是被错误地问成
    // "你是要先去「普瑞米尔」吗？"——覆盖了本该正常执行的模组加载，
    // coc-spells.test.ts 的"同一个模组不应重复加载"当场变红。只在真实
    // 报告里出现过的、语义上"做一件与当前地点绑定的事"的动作里触发：
    // talk（对话，"陆川带队返回特里坎家，把拖车房里发现的情况告诉菲碧"
    // 就是这一类）、skill_check（调查/检定，"沿着通往深处的道路寻找可疑
    // 足迹"同类）、unknown（LLM 完全没判出动作，回落询问比回落 LLM 叙事
    // 更明确，且不存在"覆盖掉本该正常执行的动作"这个风险）。
    const COMPOUND_ELIGIBLE_ACTIONS = new Set(["talk", "skill_check", "unknown"]);
    if (
      this.#registeredModules.length > 0 &&
      COMPOUND_ELIGIBLE_ACTIONS.has(intent.action)
    ) {
      let rows: SceneRow[] = [];
      try { rows = this.#worldRaw.listScenes().map((r) => ({ id: r.id, name: r.name })); } catch { /* 忽略 DB 错误 */ }
      const hit = resolveSceneTarget({
        said: input,
        displayNames: this.#sceneDisplayNames,
        aliases: this.#sceneAliases,
        rows,
      });
      const currentScene = this.#displayedSceneProjection();
      // 风险2（误报，任务3）：地名只是"提到的内容"不该触发回问——
      // "寻找能够指向维森酒吧的卡片"里，维森酒吧是线索指向的地方，不是
      // 这句话要去的地方（实跑：被误问成"你是要先去「维森酒吧」吗？"）。
      // hit 本身只回答"这句话认得出哪个场景"，不回答"这是不是目的地"，
      // 后者要另外看地名旁边有没有移动信号——见 hasMovementSignalNearMention
      // 的完整说明（紧邻移动动词，或紧跟"里/内"这类方位后缀）。用
      // hit.sceneId 对应的展示名 + 全部别名逐个检查，命中任意一个出现处
      // 即算数，因为玩家可能用别名而不是全名提这个地方。
      const hitSceneNames = hit.sceneId
        ? [this.#sceneDisplayNames[hit.sceneId], ...(this.#sceneAliases[hit.sceneId] ?? [])].filter(
            (n): n is string => Boolean(n) && input.includes(n),
          )
        : [];
      const hasMovementSignal = hitSceneNames.some((name) => hasMovementSignalNearMention(input, name));
      if (hit.sceneId && !hit.forced && hit.sceneId !== currentScene && hasMovementSignal) {
        // 风险1（误报）：句子里可能提到不止一个地名（目的地 + 话题内容），
        // 回问要展示真实候选而不是替玩家静默选中 resolveSceneTarget 挑的
        // 那一个——mentionedSceneNames 只认完整子串，不做部分匹配。
        const candidates = mentionedSceneNames(input, rows);
        const shown = candidates.length > 0
          ? candidates
          : [this.#sceneDisplayNames[hit.sceneId] ?? hit.sceneId];
        turnMessages.push({ speaker: playerName, content: input, type: "action" });
        this.#pendingCompoundMove.set(this.#activePlayerId, { originalInput: input, originalIntent: intent });
        this.traceIntent(`route=compound-reask action=${intent.action} scene=${hit.sceneId}`);
        turnMessages.push({
          speaker: "系统",
          content: `你是要先去「${shown.join("」「")}」吗？（回复目的地名字继续，其它话按原意图在原地执行）`,
          type: "system",
        });
      this.#lastNarrative = "KP 在等你确认要不要先移动过去。";
        return this.#buildActionResponse(turnMessages);
      }
    }

    // 对象名通向线索（开发·对象名通向线索 任务1）：外层意图解析器认动词，
    // 认不出就整句判成 unknown——"打开冰箱""看看储物柜""拉一下拉杆"这类
    // 真实输入统统落进这一档，因为它们用的动词不在 intent.ts 自己的表里。
    // 继续扩那份表填不满（玩家会用的动词远比任何一份表能穷举的多，
    // 见 clue-match.ts 头部背景说明——中控室 clue_control_supplies 就是
    // 这样在实跑里被 deny 死、连累 Good End 不可达）。unknown 不能任由它
    // 落到下面的攻击检测/LLM 叙事：LLM 编出的叙述一旦否认模组事实（"里面
    // 空荡荡的"），玩家不会再开第二次，是不可逆的。
    //
    // 只在 intent.action === "unknown" 时触发——skill_check 已经在
    // handleIntent → handleSkillCheck 里走同一份 matchCurrentSceneClue，
    // 不需要在这里重复处理。fallback（没提到任何具体对象，去掉动词/
    // 指代词后不剩什么）必须原样放行，不能被这道门强行拉去解一条线索——
    // 那正是这句话会被判成 unknown 的原因，例如"陆川觉得很紧张"这类与
    // 场景对象无关的叙述，不该被误当成一次搜索。
    if (this.#registeredModules.length > 0 && intent.action === "unknown") {
      this.traceIntent("route=object-gate action=unknown allowDeny=true");
      if (this.applyObjectNameGate(input, turnMessages, playerName, { allowDeny: true })) {
        this.traceIntent("route=object-gate intercepted=true");
        return this.#buildActionResponse(turnMessages);
      }
      this.traceIntent("route=object-gate intercepted=false");
    }

    if (intent.action !== "unknown") {
      this.traceIntent(`route=handler name=${intent.action} start`);
      const handled = await this.handleIntent(intent, input, turnMessages, localCommand);
      this.traceIntent(`route=handler name=${intent.action} handled=${handled}`);
      if (handled) return this.#buildActionResponse(turnMessages);

      // 开发·闸门放宽到 look 任务1：提示词修好 inventory 之后，"看看储物柜"
      // "陈岳打开冰箱与储物柜，逐一清点…"这类容器输入在 LLM 意图解析下
      // 落到了 look（而不是 unknown），上面那道门够不着——handleIntent 的
      // case "look" 已经先试过 tryResolveModuleScene（"看看维森酒吧"这种
      // 真场景名在这一步就该赢，走到这里说明没赢），返回 false 才轮到这里。
      //
      // ⚠ 只放宽到 look，不放宽到 attack/move/inventory 等：那些动作有
      // 明确的自身语义，被线索匹配劫持的代价是"做了玩家没说的事"，比
      // "没做玩家想做的事"严重得多（本仓反复吃过这类亏）。look 语义上
      // 就是"我在看/找某个东西"，与搜索几乎重合，劫持风险最低。
      //
      // ⚠ 只在 resolve/ask 时拦截，deny 不算——"环顾四周"这类纯粹的
      // look（不针对任何具体对象）如果被扫进这道门，decideClueMatch 会
      // 因为凑够 2 字信号阈值而落到 deny（"你仔细找了找，这里没什么
      // 特别的"），把玩家没问过的东西"没有"报出去，比原来落到 LLM 叙事
      // 更糟。unknown 那道门放行 deny，是因为 unknown 本来就不知道玩家
      // 想干嘛，deny 好过 LLM 瞎编；look 不同——已经知道玩家在"看"，
      // 只有明确对上了场景对象（resolve/ask）才值得打断默认的
      // 场景描述/叙事，猜不中就不该抢答。
    if (this.#registeredModules.length > 0 && intent.action === "look") {
        this.traceIntent("route=object-gate action=look allowDeny=false");
        if (this.applyObjectNameGate(input, turnMessages, playerName, { allowDeny: false })) {
          this.traceIntent("route=object-gate intercepted=true");
          return this.#buildActionResponse(turnMessages);
        }
        this.traceIntent("route=object-gate intercepted=false");
      }
    }

    // 战斗检测：只有输入本身看起来像"攻击"才会走这条自动检定分支——
    // `combatActive` 单独为真不再是进这个分支的理由。
    //
    // ⚠ 此前是 `#combatActiveRaw || 攻击词`：只要还在打，随便说什么、
    //   移动去哪、想跟谁说话，只要没被上面的 handleIntent 接住，一律被判成
    //   打人。实跑抓到过两种触发方式：
    //   · 「去特里坎家」（移动，但 case "move" 在模块模式下无视
    //     tryResolveModuleScene() 的返回值、一律回 false，见 handleIntent
    //     的 case "move"/"look" 修复）落进这里，打中了艾德里安。
    //   · 「我点燃酒吧，夺走所有登记簿，宣布整个小镇现在归我统治」这类纯
    //     叙述、intent.action 解析不出来（"unknown"），combatActive 为真时
    //     照样被判成攻击酒吧保镖。
    //
    //   combatActive 本身不在这里被清掉——不是攻击判定不等于战斗结束，
    //   敌人仍在场上，下一回合玩家还能打；「说一句话就完全脱战」同样不对。
    //   落点仍是下面的 LLM 叙事分支，战斗状态原样保留，只是这一回合没有
    //   产生攻击判定。
    if (/^(攻击|射击|挥砍|向.+攻击|对.+使用)/.test(input)) {
      // 场景内、hp>0 的敌人——复用 aliveEnemies()，不再自己单开一份不按
      // 场景过滤的 filter（那是「人在拖车房，酒吧保镖还在扑过来」的根因：
      // 换了场景，旧场景里的敌人还留在这份名单里）。
      const enemies = this.aliveEnemies();
      if (enemies.length > 0) {
        this.#combatActiveRaw = true;
        // 打 intent.target 指定的目标，不再从全场景随机挑——随机挑会打中
        // 无关 NPC（实跑里出现过打「爱莉·埃斯特鲁姆」这种旁观者）。
        const target = this.pickTarget(intent, enemies)!;

        // 检定（简化版"
        const fighting = this.ordinaryCoCUnarmedFightingTarget(intent, input);
        const skill = fighting ?? this.effectiveActivePercentileTarget(50);
        const roll = Math.floor(Math.random() * 100) + 1;
        const success = roll <= skill;
        const isCrit = roll <= skill * 0.05;
        const isFumble = roll > 95;

        let dmg = 0;
        if (success) {
          dmg = isCrit ? Math.floor(Math.random() * 12) + 6 : Math.floor(Math.random() * 6) + 1;
          // 重伤/流血/昏迷的结算与 `handleAttack` 共用一份 —— 见 `resolveHit`。
          // 这两条路各写一份的时候，功能全的是这一条，可它跑不到。
          this.resolveHit(target, dmg, (s) => turnMessages.push({ speaker: "系统", content: s, type: "system" }));
          if (fighting !== null) this.markSuccessfulOrdinaryCoCSkill("fighting");
        }

        const hitMsg = isFumble ? "大失败！" : isCrit ? "暴击" : success ? "命中" : "未命";
        turnMessages.push({
          speaker: "系统",
          content: `🎲 检查d100=${roll} (目标=${skill}) ${hitMsg}${success ? `，对 ${target.name} 造成 ${dmg} 点伤害` : ""}`,
          type: "system",
        });
        turnMessages.push({
          speaker: "系统",
          content: `${target.name} 剩余 HP: ${target.hp}/${target.maxHp}`,
          type: "system",
        });

        // 同伴协作攻击
        const comps = this.#companionManagerRaw.getActiveCompanions();
        for (const c of comps) {
          // 同伴血量在世界实体上；此前读 c.hp 恒为 undefined，
          // 条件永远为假，同伴协助攻击从未真正发生过。
          const cEnt = this.#worldRaw.getEntity(c.entityId);
          if ((cEnt?.hp ?? 0) > 0 && c.behavior !== "defensive") {
            const cRoll = Math.floor(Math.random() * 100) + 1;
            const cSkill = c.config.skills?.fight ?? 30;
            if (cRoll <= cSkill && enemies.length > 0) {
              const remaining = this.aliveEnemies();
              if (remaining.length > 0) {
                const cTarget = remaining[Math.floor(Math.random() * remaining.length)];
                const cDmg = Math.floor(Math.random() * 4) + 1;
                cTarget.hp = Math.max(0, cTarget.hp - cDmg);
                this.#worldRaw.upsertEntity(cTarget);
                turnMessages.push({ speaker: "系统", content: `👤 ${c.config.name} 协助攻击 ${cTarget.name}，造成 ${cDmg} 点伤害`, type: "system" });
              }
            }
          }
        }

        // 检查战斗结"
        if (this.aliveEnemies().length === 0) {
          this.#combatActiveRaw = false;
          turnMessages.push({ speaker: "系统", content: "✋ 所有敌人已被击败，战斗结束", type: "system" });
        }

        return this.#buildActionResponse(turnMessages);
      }
    }

    // LLM 叙事（含传奇模板上下文注入 + 世界模型权威事实注入）
    this.traceIntent(`route=llm-narration action=${intent.action} reason=${intent.action === "unknown" ? "unknown-fell-through" : "handler-unhandled"}`);
    this.#syncCurrentOrdinaryKPScene("action");
    this.injectWorldModelForScene();
    const epicContext = this.buildEpicContext();
    try {
      // 将最近的 NPC 对话并入 recentMessages，让 KP 感知玩家与 NPC 的交流。
      // 只筛选 dialogue 类型（而非全部历史），避免被 KP 内部 slice(-8) 截断。
      const recentDialogues = this.#playerSession
        .getRecentGlobal(50)
        .filter((m) => m.type === "dialogue")
        .slice(-6);
      const narration = await this.#kpRaw.narrateOutcome(
        input,
        `玩家行动: ${input}${epicContext}`,
        [...recentDialogues, ...turnMessages],
        { sceneId: this.#displayedSceneProjection(), undiscoveredClueKeys: this.currentUndiscoveredClueKeys() }
      );
      this.#lastNarrative = narration;
      turnMessages.push({ speaker: "守秘人", content: narration, type: "narration" });
    } catch {
      this.#lastNarrative = `${playerName} 行动了：${input}`;
      turnMessages.push({ speaker: "守秘人", content: `${playerName} 行动了：${input}`, type: "narration" });
    }
    return this.#buildActionResponse(turnMessages);
  }

  // ============================================================
  // 斜杠命令
  // ============================================================

  private async handleSlashCommand(
    command: Extract<OrdinaryLocalCommand, { kind: "slash" }>,
    messages: AgentMessage[],
  ): Promise<boolean> {
    const cmd = command.command;
    const args = command.args;
    const msg = (s: string) => messages.push({ speaker: "系统", content: s, type: "system" });

    try {
      switch (cmd) {
        case "roll": case "r": {
          const expr = args.join("") || "1d100";
          const result = this.execDiceExpr(expr);
          msg(`🎲 ${expr} = ${result.total}${result.detail ? ` (${result.detail})` : ""}`);
          break;
        }
        case "time": {
          const tp = args[0]?.toLowerCase();
          if (tp && ["dawn","morning","noon","afternoon","dusk","evening","night","late_night"].includes(tp)) {
    this.#gameTime = { day: this.#gameTime.day, period: tp as any, ticks: 0 };
    msg(`⏰ 时间设为: ${formatGameTime(this.#gameTime)}`);
          } else {
    msg(`⏰ 当前: ${formatGameTime(this.#gameTime)}\n${periodAtmosphere(this.#gameTime.period)}`);
          }
          break;
        }
        case "diff": case "difficulty": {
          const d = args[0]?.toLowerCase();
          if (d && ["easy","medium","hard","nightmare"].includes(d)) {
            const result = this.#setDifficultyCanonical(d);
            if (!result.ok) msg(`难度设置被拒绝：${result.error.code}`);
            else if (result.value.changes.length === 0) msg(`难度已经是 ${d}`);
            else msg(`难度设为 ${d}`);
          }
          else msg("用法: /diff <easy|medium|hard|nightmare>");
          break;
        }
        case "table": case "t": {
          const tblName = args[0];
          const count = parseInt(args[1]) || 1;
          if (!tblName) {
            const tbls = listTables().map(t => `  ${t.name}`).join("\n");
            msg(`📖 可用随机表:\n${tbls}`);
          } else {
            try { msg(`🎲 ${tblName} (x${count}):\n  ${rollTable(tblName, count).join("\n  ")}`); }
            catch { msg("未找到该表"); }
          }
          break;
        }
        case "help": case "?": {
          msg("📋 命令: /roll, /time, /diff, /table, /ref, /status, /help");
          break;
        }
        default:
          return false;
      }
    } catch (err: any) {
      msg(`⚠️ 错误: ${err.message}`);
    }
    return true;
  }

  // ============================================================
  // 意图路由
  // ============================================================

  private async handleIntent(
    intent: ActionIntent,
    input: string,
    messages: AgentMessage[],
    localCommand?: OrdinaryLocalCommand | null,
  ): Promise<boolean> {
    const msg = (s: string) => messages.push({ speaker: "系统", content: s, type: "system" });
    switch (intent.action) {
      case "help": return this.handleHelp(msg);
      case "status": return this.handleStatus(messages);
      case "move":
        // 模块模式：先解析目标场景名（匹配模组已注册场景并更新玩家位置），
        // 解析不出来才回落 LLM 叙事。
        //
        // ⚠ 这里原先不管 tryResolveModuleScene() 的返回值，一律 `return false`
        //   ——那句 docstring 自己写着"返回值在两个调用点都被丢掉"，写是写了
        //   但两个调用点从没真的改过来。后果：移动**成功**了也被 handleIntent
        //   报成"没处理"，act() 里 `if (handled) return ...` 落空，继续往下
        //   走到战斗检测/LLM 叙事——combatActive 为真时，移动直接变成一次
        //   攻击判定（实跑：「去特里坎家」打中了艾德里安）。
    if (this.#registeredModules.length > 0) {
          return this.tryResolveModuleScene(intent.target ?? input, msg);
        }
        return this.handleMove(intent, msg);
      case "look":
        // 同上：只有解析失败（返回 false）才回落 LLM 叙事。
    if (this.#registeredModules.length > 0) {
          return this.tryResolveModuleScene(intent.target ?? input, msg);
        }
      msg("你环顾四周，观察着周围的环境…"); this.#lastNarrative = "你仔细观察了周围的环境"; return true;
      case "inventory": return this.handleInventory(msg);
      case "flee": return this.handleFlee(msg);
      case "rest": return this.handleRest(messages, msg);
      case "san_check": return this.handleSanCheck(intent, msg);
      case "skill_check": return this.handleSkillCheck(intent, input, msg);
      case "saving_throw": return this.handleSavingThrow(intent, msg);
      case "attack": return this.handleAttack(intent, msg, input);
      case "create_character": return this.handleCreateCharacter(input, msg);
      case "list_occupations": return this.handleListOccupations(msg);
      case "buy": return this.handleBuy(intent, msg);
      case "sell": return this.handleSell(intent, msg);
      case "legacy": return this.handleLegacy(input, msg);
      case "generate_story": return this.handleGenerateStory(msg);
      case "load_module": {
        const command = localCommand ?? this.resolveSessionOwnedLocalCommand(parseOrdinaryLocalCommand(input));
        return command?.kind === "load_module"
          ? this.handleLoadModule(command, msg)
          : false;
      }
      case "skill_advancement": return this.handleSkillAdvancement(messages, msg);
      case "cast": case "occult_cast": return this.handleCast(intent, msg);
      case "read": return this.handleRead(input, msg);
      case "first_aid": return this.handleFirstAid(msg);
      case "reload": return this.handleReload(intent, msg);
      case "push": return this.handlePush(msg);
      case "chase": return this.handleChase(msg);
      case "use_item": msg("你尝试使用物品。"); this.#lastNarrative = "你使用物品。"; return true;
      case "pickup": return this.handlePickup(intent, input, msg);
      case "talk": return this.handleTalk(intent, input, messages, msg);
      case "spell_list": return this.handleSpellList(msg);
      case "view_module": return this.handleViewModule(msg);
      // ⚠ 这里原先是一句写死的套话：「疯狂指引：当SAN大幅下降时，角色可能出现
      //   各种精神障碍…」——结尾那个省略号说明它本来就是个占位。
      //   问「疯狂指引」的人想知道的是**自己现在什么样**，不是疯狂这个概念。
      //   CLI 一直调 `sanity.getFullGuidance()`（index.ts:1136），
      //   把临时疯狂表现、不定疯狂等级与惩罚、恐惧症、狂躁症逐条拼出来。
      //   这条路却停在占位上 —— 又一处两个前端两套行为。
      //   不再加「空了就回落到一句话」的兜底 —— `getFullGuidance()` 自己
      //   已经处理了清醒这一支（`lines.length === 0` 时给「你的神智目前清醒。」），
      //   再包一层就是够不到的死代码。
      case "insanity_guidance": {
    msg(this.#sanityRaw.getFullGuidance());
      this.#lastNarrative = "疯狂指引";
        return true;
      }
      case "allocate_skills": msg("技能分配功能"); this.#lastNarrative = "技能分配"; return true;
      case "equip": case "unequip": msg(`执行${intent.action === "equip" ? "装备" : "卸下"}操作。`); this.#lastNarrative = `${intent.action === "equip" ? "装备" : "卸下"}完成。`; return true;
      // ── 政治经济 ──
      case "factions": case "faction_status": case "diplomacy":
      case "market": case "trade":
      case "policy":
      case "finance": case "sanction": case "embargo":
      case "economy_viz": case "viz":
        return this.handlePoliticoEconomy(intent, messages, msg);
      default: return false;
    }
  }

  // ============================================================
  // 意图处理"
  // ============================================================

  // ── 帮助 ──
  private handleViewModule(msg: (s: string) => number): boolean {
    const installed = this.#registeredModules.flatMap((module) => {
      if (this.#loadedModules.get(module.id) !== true) return [];
      const name = isModuleData(module) ? module.title : module.name;
      return name.trim().length > 0 && module.version.trim().length > 0
        ? [`${name}（版本 ${module.version}）`]
        : [];
    });
    const text = installed.length > 0
      ? `已安装模组：${installed.join("、")}`
      : "当前没有已安装的模组。";
    msg(text);
    this.#lastNarrative = text;
    return true;
  }

  private handleSpellList(msg: (s: string) => number): boolean {
    const known = [...new Set(this.#knownMythosSpells)]
      .filter((name) => this.#mythosSpells.has(name));
    const text = known.length > 0
      ? `当前可用法术：${known.join("、")}`
      : "当前可用法术：暂无已知法术。";
    msg(text);
    this.#lastNarrative = text;
    return true;
  }

  private handleHelp(msg: (s: string) => number): boolean {
    const helpText = [
      "【操作指南",
      "",
      "— 基础操作 —",
      "  观察/环顾四周 → 查看当前场景",
      "  移动到<地点> → 前往指定场景",
      "  状态/角色卡 → 查看角色属性",
      "  背包/物品栏 → 查看携带物品",
      "  帮助 → 显示操作指南",
      "",
      "— 战斗操作 —",
      "  攻击<目标> → 攻击指定敌人",
      "  逃跑 → 脱离战斗",
      "  装填<武器> → 补充弹药",
      "  燃运<N> 攻击<目标> → 消耗幸运值提升命中",
      "",
      "— 角色创建 —",
      "  创建角色 → 创建新调查员",
      "  创建角色 <职业> <姓名> → 指定职业创建",
      "  职业列表 → 查看可选职业",
      "",
      "─ 技能与检查",
      "  调查<目标>/侦查<区域> — 进行技能检查",
      "  SAN检查/理智检查 — 进行理智检查",
      "  豁免检查 — 进行豁免检查",
      "  推动 — 重试失败的检查",
      "",
      "─ 物品与商店",
      "  购买 <物品> — 购买物品",
      "  出售 <物品> — 出售物品",
      "",
      "─ 传承系统",
      "  传承 — 查看传承说明",
      "  保存角色 — 保存当前角色",
      "  传承列表 — 查看已保存角色",
      "  读档 <角色名> — 加载已保存角色",
      "",
      "─ 模组与故事",
      "  生成故事 — 随机生成冒险故事",
      "  加载模组 <模组名> — 加载剧本杀模组",
      "  模组结算 — 结算模组成长",
      "",
      "─ 其他",
      "  休息 — 休整恢复",
      "  急救/包扎 — 处理伤口",
      "  阅读<典籍> — 阅读神话典籍",
      "  施法<法术名> — 施展法术",
    ].join("\n");
      this.#lastNarrative = helpText;
    msg(helpText);
    return true;
  }

  // ── 状态显示 ──
  private handleStatus(messages: AgentMessage[]): boolean {
    if (!this.#activeCharacterRaw) {
      this.#lastNarrative = "你还没有创建角色。使用「创建角色<职业> <姓名>」来创建调查员";
      messages.push({ speaker: "系统", content: "尚未创建角色。使用「创建角色<职业> <姓名>」来创建调查员", type: "system" });
      return true;
    }
    const c = this.#activeCharacterRaw;
    const san = this.#sanityProjection();
    const lines: string[] = [];
    lines.push(`━━━ ${c.name} ━━━`);
    if (this.#activeRulesetRaw === "cosmic-horror") {
      const attrs = c.attributes ?? {};
      const str = attrs.strength ?? attrs.STR ?? 50;
      const con = attrs.constitution ?? attrs.CON ?? 50;
      const siz = attrs.size ?? attrs.SIZ ?? 50;
      const dex = attrs.dexterity ?? attrs.DEX ?? 50;
      const app = attrs.appearance ?? attrs.APP ?? 50;
      const edu = attrs.education ?? attrs.EDU ?? 50;
      const intel = attrs.intelligence ?? attrs.INT ?? 50;
      const pow = attrs.power ?? attrs.POW ?? 50;
      const luck = c.luck ?? 60;
      const mp = Math.floor(pow / 5);
      // ⚠ `calcDamageBonus` 返回的是 `{ db, build }` **对象**，原先直接插进
      //   下面的模板串，玩家看到的是 `DB:[object Object]`。
      //   而 build 又在这里按 STR+SIZ 手算了一遍 —— 同一件事两套算法，
      //   一套还是没人看的（对象那份自带 build）。用返回值里的。
      const { db, build } = calcDamageBonus(str, siz);
      const move = dex < siz && str < siz ? 7 : siz <= str && siz <= dex ? 9 : 8;
      lines.push(`职业: ${c.archetype?.label ?? c.archetype ?? "调查员"}`);
      lines.push(`HP: ${c.hp ?? 12}/${c.maxHp ?? 12}  SAN: ${san.currentSAN}/${san.maxSAN}`);
      lines.push(`STR:${str} CON:${con} SIZ:${siz} DEX:${dex} APP:${app}`);
      lines.push(`EDU:${edu} INT:${intel} POW:${pow} 幸运:${luck}`);
      lines.push(`DB:${db}  Build:${build}  Move:${move}  MP:${mp}`);
      lines.push(`CR:${c.creditRating ?? 30}  燃运:${luck}`);
      // ⚠ 疯狂状态原先**在角色卡上完全看不到**。实测：SAN 从 50 掉到 26
      //   （48%，已经是中度不定疯狂），角色卡还是只印一行 `SAN: 26/50` ——
      //   临时疯狂、不定疯狂等级、恐惧症、狂躁症一个都不显示。
      //   玩家不知道自己已经跨过那条线，也就不知道该怎么演。
      //
      //   `SanityEngine.getSummary()` 拼的正是这些，但它**只有测试在调**。
      //   两端都写好了，中间那根线没接 —— 又一处。
    const sanSummary = this.#sanityRaw.getSummary();
      // getSummary 开头就是 `SAN: x/y`，上面已经印过，这里只取后面的疯狂部分
      const madness = sanSummary.replace(/^SAN:\s*\d+\/\d+/, "").trim();
      if (madness) lines.push(`精神: ${madness}`);
      if (c.skills ?? c.skillValues) {
        const skills = c.skills ?? c.skillValues ?? {};
        const skillEntries = Object.entries(skills).slice(0, 10);
        if (skillEntries.length > 0) {
          lines.push("技能: " + skillEntries.map(([k, v]) => `${k}:${v}%`).join(", "));
        }
      }
    } else {
      const ac = CharacterFactory.computeAC(c);
      lines.push(`职业: ${c.archetype?.label ?? c.archetype ?? "冒险"}`);
      lines.push(`HP: ${c.hp ?? 12}/${c.maxHp ?? 12}  AC:${ac}  等级:${c.totalLevel ?? 1}`);
      if (c.attributes) {
        const attrs = c.attributes;
        lines.push(`力量:${attrs.strength ?? "?"} 敏捷:${attrs.dexterity ?? "?"} 体质:${attrs.constitution ?? "?"}`);
        lines.push(`智力:${attrs.intelligence ?? "?"} 感知:${attrs.wisdom ?? "?"} 魅力:${attrs.charisma ?? "?"}`);
      }
    }
    const statusText = lines.join("\n");
    this.#lastNarrative = statusText;
    messages.push({ speaker: "系统", content: statusText, type: "system" });
    return true;
  }

  // ── 移动 ──

  /**
   * 模块模式：将移动/查看目标解析为已注册的模组场景并更新玩家位置。
   * 匹配不到时不创建垃圾场景，返回 false（由调用方回落 LLM 叙事）。
   *
   * `msg` 用来在**没认准**时明说。原先没有这一路：认准了静默移动、
   * 没认准也静默移动，玩家一个字都看不到 ——「比菜单更糟」说的就是这个。
   */
  private tryResolveModuleScene(targetOrInput: string, msg?: (s: string) => void): boolean {
    // 解析逻辑抽到了 `play/scene-resolve.ts`。
    //
    // ⚠ 这条 docstring 曾经写着"返回值在两个调用点都被丢掉"——诊断是对的，
    //   但两个调用点（handleIntent 的 case "move"/"look"）当时没有真的改
    //   过来，一律 `return false`。诊断写了不代表修了：实跑因此出现过
    //   「移动成功了，却因为 combatActive 为真被顺手判成一次攻击」。
    //   两个调用点现在改成如实转发这个方法的返回值。
    let rows: SceneRow[] = [];
    try {
      rows = this.#worldRaw.listScenes().map((r) => ({ id: r.id, name: r.name }));
    } catch { /* 忽略 DB 错误 */ }

    const hit = resolveSceneTarget({
      said: targetOrInput ?? "",
      displayNames: this.#sceneDisplayNames,
      aliases: this.#sceneAliases,
      rows,
    });
    if (!hit.sceneId) return false;

    // 开发·卧室线索修复 任务②b：模糊匹配（alias-contains/contains/bigram）
    // 解析结果如果正好等于当前所在场景，本身就是可疑信号——
    // "前往下水道维修室"曾经只在"包含"这一档命中"下水道"（句子前半段，
    // 玩家当时就站在下水道），实际要去的"维修间"因为场景表里没有"维修室"
    // 这个写法，连候选都进不去，于是"前往"变成"原地不动"却仍然报成功。
    // 任务②a 已经用别名把"维修室"接进候选、且让别名匹配优先于同名场景的
    // 包含匹配，正常情况下这句话现在直接命中"维修间"，走不到这条分支——
    // 这里留着是防同类问题的通用兜底：exact 三档（display-name/alias/
    // row-exact）要求整句话字面就是场景名/别名/id，是玩家明确的陈述，
    // 不受这条限制；只有三档启发式匹配（把"顺带提到了自己所在地方"当成
    // "要去的地方"）会被拦下，当成未命中交回调用方（对象名门/LLM 叙事），
    // 而不是假装"移动"成功却其实原地没动。
    const fromSceneId = this.#displayedSceneProjection();
    const heuristicVia = hit.via === "alias-contains" || hit.via === "contains" || hit.via === "bigram";
    if (hit.sceneId === fromSceneId && heuristicVia) return false;

    // 弱版邻接 + 按跳数计时（开发 A · 任务 3）：目标在场景表内就能去，
    // 不要求与当前场景有出口直连，但按最短跳数付时间，不是瞬移。
    // 图上量不出到达方式（孤立场景/不连通）时拒绝移动并说明，不编代价。
    const graph = buildSceneGraph(this.#worldRaw.listScenes());
    const hops = shortestHops(graph, fromSceneId, hit.sceneId);
    if (hops === null) {
      const name = this.#sceneDisplayNames[hit.sceneId] ?? hit.sceneId;
      msg?.(`「${name}」目前没有已知路线可达，去不了。`);
      return true; // 已经明说了原因，不是"没处理"，别再落到 LLM 叙事兜底
    }

    const moved = this.movePlayerToScene(hit.sceneId);
    // 1 跳 = act() 每回合本来就会推进的那 1 tick；跳数更多才额外加时间，
    // 所以相邻移动（hops<=1）与改动前逐字一致。访问历史的记录在
    // movePlayerToScene() 内部（任务1已加），这里不用再记一次。
    if (moved && hops > 1) this.#gameTime = advanceTime(this.#gameTime, hops - 1);
    // 没认准就说出来。玩家有权知道「这一步是我选的，还是引擎猜的」——
    // 剧本杀那条路早有这句（「没听清要去哪……」），真人这条路一直没有。
    if (moved && hit.forced) {
      const name = this.#sceneDisplayNames[hit.sceneId] ?? hit.sceneId;
      msg?.(`（没太确定你要去哪，先按最接近的理解带你到了「${name}」。说个更完整的地名可以纠正。）`);
    }
    // 移动成功却不设 lastNarrative，响应就沿用上一轮内容 —— 实跑：输入
    // 「周明回特里坎家」，narrative 写的是特里坎家，但 state.scene 却仍是
    // 移动前的场景（这个方法早不早于 handleMove 那条"你移动到了场景:X"的
    // 老路径），下一回合还在提移动前场景里的 NPC。移动成功时如实设一句。
    if (moved) {
      const name = this.#sceneDisplayNames[hit.sceneId] ?? hit.sceneId;
    this.#lastNarrative = `你来到了「${name}」。`;
    }
    return moved;
  }

  /**
   * 将玩家移动到场景并设为活动场景（不创建垃圾场景）。
   *
   * 经 #setSceneCanonical() 而不是直接 setActiveScene()：后者是
   * `UPDATE scenes SET is_active=1 WHERE id=?`，场景未注册时匹配不到行，
   * 整条切换静默失效——与 §八 记录的两次事故同类。#setSceneCanonical() 会先校验注册。
   * 未注册时返回 false 并保持原场景，由调用方决定如何提示。
   */
  private movePlayerToScene(sceneId: string): boolean {
    if (!this.#setSceneCanonical(sceneId)) return false;
    const state = this.#worldRaw.getCurrentState();
    const player = state.entities[this.#activePlayerId];
    if (player) {
      player.position = sceneId;
      this.#worldRaw.upsertEntity(player);
    } else {
      this.#worldRaw.upsertEntity({ id: this.#activePlayerId, name: this.#activeCharacterRaw?.name ?? "调查员", type: "pc", hp: 12, maxHp: 12, ac: 10, status: [], position: sceneId });
    }
    // 玩家位置真的落到这个场景了——记一笔访问历史（真相源，按玩家累计，
    // 从不清空）。放在这一处而不是各调用方各记一次：这是"玩家位置改变"
    // 这件事唯一的落点，调用方多（tryResolveModuleScene / 模组入场等），
    // 分散记录容易漏，且 INSERT OR IGNORE 本就幂等，不怕这里多调一次。
    this.#worldRaw.recordSceneVisit(this.#activePlayerId, sceneId);
    return true;
  }

  private handleMove(intent: ActionIntent, msg: (s: string) => number): boolean {
    const target = intent.target ?? "";
    // ⚠ 空/空白目标一律拒绝，不注册、不谎报成功。
    //
    // 此前这道防线在自动注册**之后**：intent.target 为空字符串时，
    // sceneMap[""] ?? "" 仍是空串，`registerScene("", "", "的场景")`
    // 把空字符串注册成一个真场景，setScene("") 因此必然通过，最后打出
    // 「你移动到了场景: 」且 state.scene = ""（实跑抓到过，见
    // analysis/sim/2026-08-28-barn-long-input-abort.md）。防线必须移到
    // 自动注册之前，判据也不能只查 undefined——空字符串 trim 后同样要拦。
    if (target.trim().length === 0) {
      msg("你要去哪？没听清具体的地方。");
      return false; // 交回上层，走 LLM 叙事兜底，别谎报成功
    }
    // 场景名称解析映射
    const sceneMap: Record<string, string> = {
      "谷仓": "barn_interior", "谷仓内部": "barn_interior",
      "农场": "farm_exterior", "农场外围": "farm_exterior",
      "小屋": "cabin", "地下室": "basement",
      "酒馆": "tavern", "旅店": "tavern",
    };
    const sceneId = sceneMap[target] ?? target;
    // 玩家自由移动可以落到尚未注册的场景，这里按需注册后再经 #setSceneCanonical() 激活。
    //
    // 原写法是 `(#worldRaw as any).getDatabase()` 裸写 INSERT OR IGNORE。
    // 问题不在于取不到 db（getDatabase() 本就是 WorldStateManager 的公开方法），
    // 而在于那个 `as any` 把整条链的类型检查关掉了：列名拼错、少写一列、
    // is_active 默认值给错，全都要等运行时才发现——registerScene() 先删后插
    // 清空 exits 那个 bug 就是这么漏过去的。改走具名方法后表结构只有
    // world-state-manager 知道，这里写错会在编译期断掉。
    if (!this.#worldRaw.getScene(sceneId)) {
      this.#worldRaw.registerScene(sceneId, target, `${target}的场景`);
    }
    // ⚠ 这里原先经旧 public wrapper 激活场景，却把**返回值丢掉**，
    // 然后不管成没成都往下走，最后照样 `msg("你移动到了场景: X")` 并 `return true`。
    // 注册若因任何原因没生效，玩家会被告知「你移动到了 X」而实际没动，
    // 后端还回 success —— 与 §八 记的两次事故同一形状（「后端却仍返回 success: true」）。
    if (!this.#setSceneCanonical(sceneId)) {
      msg(`那地方现在去不了（场景「${target}」没能激活）。`);
      return false; // 交回上层，走 LLM 叙事兜底，别谎报成功
    }
    // 更新玩家位置
    const state = this.#worldRaw.getCurrentState();
    const player = state.entities[this.#activePlayerId];
    if (player) {
      player.position = sceneId;
      this.#worldRaw.upsertEntity(player);
    } else {
      this.#worldRaw.upsertEntity({ id: this.#activePlayerId, name: this.#activeCharacterRaw?.name ?? "调查员", type: "pc", hp: 12, maxHp: 12, ac: 10, status: [], position: sceneId });
    }
    this.#worldRaw.recordSceneVisit(this.#activePlayerId, sceneId);
    msg(`你移动到了场景: ${this.#sceneDisplayNames[sceneId] ?? sceneId}`);
    this.#lastNarrative = `你走向了${target}。`;
    return true;
  }

  /**
   * 复合句回问的答复处理（开发·复合意图回问，任务1）。
   *
   * 两条分支收敛成一段代码，不是两个 if：
   *   回答目的地名（"去农场外围"）→ tryResolveModuleScene 认得出来，
   *     移动过去（含既有的弱版邻接+按跳数计时），然后继续按原意图执行
   *     ——"先移动再做事"的"做事"那半句不该被回问吃掉。
   *   回答别的（"我们再等等"/一句新的话）→ tryResolveModuleScene 认不出
   *     任何场景，没有移动发生，直接按原意图在原地执行——不阻塞、不卡住。
   * 两条分支最终都会执行 originalIntent，区别只在于执行前有没有先移动，
   * 所以不需要分叉成两段几乎相同的代码。
   */
  private async resolveCompoundMoveReply(
    pending: PendingCompoundMove,
    input: string,
    turnMessages: AgentMessage[],
  ): Promise<void> {
    const msg = (s: string) => turnMessages.push({ speaker: "系统", content: s, type: "system" });
    // 移动成功、不可达的说明、认不出地点，三种情况 tryResolveModuleScene
    // 都已经处理并按需 msg() 了，这里显式弃用返回值——不管有没有移动，
    // 下面都要接着执行原意图，语义上是同一件事："先移动（如果能）再做事"。
    const moved = this.tryResolveModuleScene(input, msg);
    this.traceIntent(`route=compound-reply movementHandled=${moved} originalAction=${pending.originalIntent.action}`);
    const handled = await this.handleIntent(pending.originalIntent, pending.originalInput, turnMessages);
    this.traceIntent(`route=compound-reply handler=${pending.originalIntent.action} handled=${handled}`);
  }

  /**
   * 确认离开后：判定结局、播报、置终态（开发 A · 任务 5）。
   *
   * 普通模组离场使用独立终态判别值；`dead` 只保留为从该判别值派生的
   * 死亡兼容视图。结局记录复用
   * `careerStore.addEntry` 与 `endingId`/`endingName` 这两个既有字段
   * （原先只在 handleSkillAdvancement 里硬写 "completed"/"模组完成"，
   * 这里填的是 evaluateEnding 真正判出来的那一个）。
   *
   * 早退落到 Normal End 是自然结果，不是特判：END_NARRATIONS 里 Normal
   * 的 priority 最低、requiredClues 为空，任何状态下都会兜底命中——它的
   * 文案本来就是"未受干涉的结果"，不用另写。
   */
  private resolveModuleDeparture(turnMessages: AgentMessage[]): void {
    const msg = (s: string) => turnMessages.push({ speaker: "系统", content: s, type: "system" });
    const modId: string | undefined = this.#registeredModules[0]?.id;
    const support = modId ? MODULE_ENDING_SUPPORT[modId] : undefined;

    let lines: readonly string[];
    let endingId: string;
    let endingName: string;

    if (support) {
      const ending = support.evaluateEnding(
        (id) => this.#clueFoundPredicate(id),
        (id) => this.#sceneVisitedPredicate(id),
      );
      if (ending) {
        lines = ending.lines;
        endingId = ending.id;
        endingName = support.endLabels[ending.id] ?? ending.id;
      } else {
        // 理论上不会发生（Normal End 兜底一切非全员倒下的状态），
        // 真出现时也别空播——通用收场保底。
        lines = GENERIC_DEPARTURE_LINES;
        endingId = "left_early";
        endingName = "提前离开";
      }
    } else {
      // 该模组结局数据为空（阿卡姆/印斯茅斯目前如此）——不是"按设计没有
      // 结局"，是待补（见 docs/todo.json）。不报错、不空播，走通用收场。
      lines = GENERIC_DEPARTURE_LINES;
      endingId = "left_early";
      endingName = "提前离开";
    }

    for (const line of lines) msg(line);
    this.#lastNarrative = lines.join("\n");
    this.#setOrdinaryTerminal({ kind: "module_departure", endingId, endingName });

    // `registeredModules` is enough to narrate a departure, but it is not
    // enough to commit character state: it is a legacy facade separate from
    // `_loadedModules`.  A mismatch still ends the investigation, while all
    // owner-scoped settlement state remains intact for a verifiable recovery.
    const module = this.publishedOrdinaryModuleForSettlement();
    if (!module) {
      msg("⚠️ 模组身份不一致或起点缺失，离开已生效；未猜测履历差值，成长记录已保留。");
      return;
    }

    for (const { pid, char } of this.ordinarySettlementTargets()) {
      const delta = this.moduleCareerDelta(pid, this.#sanityEngines.get(pid));
      if (!delta) {
        // A missing start makes both the career delta and the associated
        // settlement unverifiable. Do not let terminal state force-consume
        // this PC's marks (or its legacy pending changes).
        msg(`⚠️ ${char.name} 的模组起点缺失；离开已生效，未写入伪造的履历结算，成长记录已保留。`);
        continue;
      }

      const growth = this.settlePendingSkillGrowth(pid, char);
      for (const line of growth.lines) msg(line);

      // Transient hosts still settle verified growth and clear marks, but do
      // not create a durable career entry. All other career projections stay
      // on their canonical persistence path.
      if (this.#careerEntryPersistence === "transient") continue;
      this.#ensureCareerStore().addEntry({
        id: `ce_${Date.now().toString(36)}_${pid}`,
        characterName: char.name,
        moduleId: module.id,
        moduleName: isModuleData(module) ? module.title : module.name,
        completedAt: new Date().toISOString(),
        endingId,
        endingName,
        sanChange: delta.sanChange,
        cmChange: delta.cmChange,
        reputationChange: 0,
        skillChanges: growth.skillChanges,
        rewardIds: [],
        narrative: lines[0] ?? "提前离开模组",
      });
    }
  }

  /** Characters eligible for ordinary departure settlement, keyed by owner rather than the active-PC facade. */
  private ordinarySettlementTargets(): Array<{ pid: string; char: any }> {
    const targets: Array<{ pid: string; char: any }> = [];
    for (const [pid, char] of this.#characters) if (char) targets.push({ pid, char });
    if (targets.length === 0 && this.#activeCharacterRaw) {
      targets.push({ pid: this.#activePlayerId, char: this.#activeCharacterRaw });
    }
    return targets;
  }

  /**
   * The one skill-growth settlement core. It is invoked only after a real,
   * verified ordinary-module departure has supplied a per-PC baseline.
   */
  private settlePendingSkillGrowth(
    pid: string,
    char: any,
  ): { skillChanges: string[]; lines: string[] } {
    const skillChanges = [...(this.#growthChangesByPC.get(pid) ?? [])];
    const lines: string[] = [];
    for (const skill of this.pendingSkillGrowthMarks(pid)) {
      const outcome = this.applySkillGrowth(char, skill);
      const { display, roll, currentSkill, increase } = outcome;
      if (outcome.increased) {
        lines.push(`${char.name}·${display}: d100=${roll} > ${currentSkill}% → 成长 +${increase}%`);
        skillChanges.push(`${display}→${outcome.newValue}`);
      } else {
        lines.push(`${char.name}·${display}: d100=${roll} <= ${currentSkill}% → 无成长`);
      }
    }
    this.clearSkillGrowthMarks(pid);
    this.#growthChangesByPC.delete(pid);
    return { skillChanges, lines };
  }

  // ── 背包 ──
  private handleInventory(msg: (s: string) => number): boolean {
    const inv = this.#worldRaw.getPlayerInventory(this.#activePlayerId);
    if (inv.length === 0) {
      msg("你的背包是空的");
      this.#lastNarrative = "你的背包里空空如也";
    } else {
      msg(`你的背包: ${inv.join(", ")}`);
      this.#lastNarrative = `你的背包里有: ${inv.join(", ")}。`;
    }
    return true;
  }

  // ── 逃跑 ──
  private handleFlee(msg: (s: string) => number): boolean {
    this.#combatActiveRaw = false;
    this.#lastNarrative = "你转身逃跑，迅速脱离了战斗";
    msg("你成功逃离了战斗！");
    return true;
  }

  // ── 休息 ──
  private handleRest(_messages: AgentMessage[], msg: (s: string) => number): boolean {
    // 获取角色 HP（优先从世界实体读取，回退到 activeCharacter）
    const state = this.#worldRaw.getCurrentState();
    const playerEnt = state.entities[this.#activePlayerId];
    let currentHp = playerEnt?.hp ?? this.#activeCharacterRaw?.hp ?? 12;
    let maxHp = playerEnt?.maxHp ?? this.#activeCharacterRaw?.maxHp ?? 12;

    if (!this.#activeCharacterRaw) {
    this.#lastNarrative = "你在篝火旁坐下，稍作休整…";
      msg("你在篝火旁坐下，稍作休整");
      return true;
    }
    const c = this.#activeCharacterRaw;

    // 过夜休息：若已入夜（黄昏后），休息推进到次日清晨
    if (isNightPeriod(this.#gameTime.period)) {
      this.#gameTime = { day: this.#gameTime.day + 1, period: "dawn", ticks: 0 };
      msg(`🌙 你在休息中度过一夜，时间来到 ${formatGameTime(this.#gameTime)}`);
    }

    if (currentHp >= maxHp) {
      this.#lastNarrative = "经过短暂休整，你的身体状况良好，精力充沛";
      msg("经过短暂休整，你的身体状况良好");
      return true;
    }

    if (this.#woundsTreatedByPC.has(this.#activePlayerId)) {
      const con = c.attributes?.constitution ?? c.attributes?.CON ?? 50;
      const recovery = Math.max(1, Math.floor(con / 10));
      const newHp = Math.min(maxHp, currentHp + recovery);
      c.hp = newHp;
      this.#woundsTreatedByPC.delete(this.#activePlayerId);
      // 同步世界实体和角色
      if (playerEnt) { playerEnt.hp = newHp; this.#worldRaw.upsertEntity(playerEnt); }
      this.#lastNarrative = `伤口在休养后逐渐愈合，恢复了 ${recovery} .?HP。`;
      msg(`💊 伤口愈合: HP +${recovery} (当前: ${newHp}/${maxHp})`);
    } else {
      this.#lastNarrative = "伤口没有得到专业处理，休养效果有限";
      msg("伤口没有得到专业处理，需要先接受急救");
    }
    return true;
  }

  // ── SAN 检查──
  private handleSanCheck(intent: ActionIntent, msg: (s: string) => number): boolean {
    const sanCost = intent.sanCost ?? "1/1d6";
    const reason = intent.reason ?? "未知恐惧";
    const result = this.#sanityRaw.sanityCheck(sanCost);
    const passed = result.passed;
    const loss = result.sanLoss;
    const roll = result.roll;
    msg(`🧠 SAN 检查(${reason}): d100=${roll} (目标=${this.#sanityRaw.state.currentSAN}) → ${sanOutcomeLabel(passed)}！SAN -${loss} (剩余: ${this.#sanityRaw.state.currentSAN})`);
    // 字段名是 temporaryInsanityTriggered；此前写成 temporaryInsanity，
    // 取值恒为 undefined，Web 路径的临时疯狂提示从未出现过。
    if (result.temporaryInsanityTriggered) {
      msg(`⚠️ 临时疯狂触发！${result.boutOfMadness ?? ""}`);
    }
    // 不定性疯狂原先**从不播报** —— 引擎算出来了、状态也置了，
    // 玩家却看不到自己已经跨过那条线。
    if (result.indefiniteInsanityTriggered) {
      msg(`⚠️ 不定性疯狂（${result.indefiniteLevel ?? ""}）——你已经不是进来时的那个人了。`);
    }
    this.#lastNarrative = `SAN 检定结果: ${sanOutcomeLabel(passed)}, SAN -${loss}`;
    return true;
  }

  // ── 技能检查──
  /**
   * 会去解析场景线索的技能。潜行、说服等不属于调查，不该触发线索判定。
   *
   * investigation/perception 是通用兜底；其余键是 BARN_OF_PREMIER 32 条线索
   * findMethods 里实际用到的技能（侦查/取悦/社交/图书馆/信誉/精神分析/医学/
    * 急救/母语，译名见 SKILL_NAME_MAP），加上 luck/strength 两个属性代理
    * （幸运/力量由 ModuleDataRuntimeLoader 注册时映射）。不在这个集合里的技能
   * 即使 ClueDef 已经注册好，也不会走到 investigateCoC，线索还是查不到。
   */
  private static readonly INVESTIGATIVE_SKILLS = new Set([
    "investigation", "perception",
    "spot_hidden", "charm", "fast_talk", "library_use", "credit_rating",
    "psychoanalysis", "medicine", "first_aid", "language_own",
    "luck", "strength",
  ]);

  /**
   * 取技能值。
   *
   * intent 用的是通用词汇（perception / investigation / persuasion），CoC 角色卡的键却是
   * CoC 技能名（spot_hidden / persuade）。两套词汇对不上时，即便角色卡上白纸黑字写着
   * spot_hidden: 75，查 perception 也是空，检定照旧落到兜底值——技能分配等于没有。
   */
  private resolveSkillValue(skill: string, skillDisplay: string): number {
    const values = this.#activeCharacterRaw?.skillValues;
    if (values) {
      const cocKey = COC_SKILL_ALIASES[skill] ?? SKILL_NAME_MAP[skillDisplay];
      const value = values[skill] ?? (cocKey ? values[cocKey] : undefined);
      if (typeof value === "number") return value;
    }
    // 角色卡上没有这项技能：未受训。CoC 的未受训基础值远低于 50，但这里是
    // 跨规则集的通用兜底，改动会波及 D&D 侧，留待技能表补全后再收。
    return this.#activeCharacterRaw?.skills?.[skill] ?? 50;
  }

  /**
   * Resolve the character-sheet field used to store a skill growth result.
   *
   * Intent vocabulary may use a generic key such as `investigation`, while a
   * CoC character sheet stores that score as `spot_hidden`. A sheet-local
   * direct key remains authoritative so custom and non-CoC skills keep their
   * existing storage behavior.
   */
  private static resolveSkillGrowthStorageKey(skill: string, character: any): string {
    return resolveCoCSkillGrowthStorageKey(skill, character);
  }

  /**
   * CoC 7e improvement checks apply only to ordinary, stored character-sheet
   * skills.  Attributes, luck, Credit Rating, and Cthulhu Mythos have their
   * own rules and must not become ordinary growth marks merely because a
   * generic intent happened to produce a percentile roll.
   */
  private static isOrdinaryGrowableCoCSkill(character: any, storageKey: string): boolean {
    return isGrowableCoCSkill(character, storageKey);
  }

  /** Record one successful, actually rolled ordinary CoC skill use for later advancement. */
  private markSuccessfulOrdinaryCoCSkill(skill: string): void {
    if (this.#activeRulesetRaw !== "cosmic-horror" || this.#compiledModule) return;
    const storageKey = GameSession.resolveSkillGrowthStorageKey(skill, this.#activeCharacterRaw);
    if (GameSession.isOrdinaryGrowableCoCSkill(this.#activeCharacterRaw, storageKey)) {
      this.markSkillGrowth(this.#activePlayerId, storageKey);
    }
  }

  /** One authoritative CoC improvement check used by rest and module settlement. */
  private applySkillGrowth(character: any, skill: string): SkillGrowthOutcome {
    return applyCoCSkillGrowth(character, skill, Math.random);
  }

  private handleSkillCheck(intent: ActionIntent, input: string, msg: (s: string) => number): boolean {
    const skill = intent.skill ?? "investigation";
    this.traceIntent(`handler=skill_check skill=${skill} investigative=${GameSession.INVESTIGATIVE_SKILLS.has(skill)}`);

    // 调查类检定优先交给 InvestigationEngine 解析场景线索。
    //
    // 此前这里只掷一个裸 d100 就结束：不看场景线索、不出揭示文本、不扣 SAN。
    // 模组导入时注册进去的线索因此永远不会被「调查」这个动作解析，
    // CoC 的核心循环（调查 → 线索 → 掉 SAN）实际不成立。
    // 规则本身早就写好并被 investigation-coc.test.ts 覆盖，缺的只是这一次调用。
    //
    // 场景没有未发现线索时回落到原来的裸检定，保持既有行为。
    if (GameSession.INVESTIGATIVE_SKILLS.has(skill)) {
      const match = this.matchCurrentSceneClue(input);
      if (match) {
        const { decision, candidates } = match;
        const clueId = decision.kind === "resolve" ? decision.clueId : null;
        this.traceIntent(`clue-decision source=skill_check kind=${decision.kind} clueId=${JSON.stringify(clueId)} candidates=${candidates.length}`);
        // fallback：显式技能检定已经明确表达了"要检定"这件事，没说清楚
        // 查什么就按老规矩取候选首条——这条与"对象名门"（act() 里处理
        // intent.action==="unknown" 的那支）对 fallback 的处理不同，两处
        // 各自决定，不能共用同一份收尾。
        if (decision.kind === "fallback") return this.resolveSceneClue(candidates[0]!, msg);
        return this.applyClueDecision(decision, msg);
      }
      this.traceIntent("clue-decision source=skill_check kind=no-candidates clueId=null candidates=0");
    }

    const skillDisplay = SKILL_DISPLAY_NAMES[skill] ?? skill;
    const baseSkillValue = this.resolveSkillValue(skill, skillDisplay);
    const skillValue = this.effectiveActivePercentileTarget(baseSkillValue);
    const roll = Math.floor(Math.random() * 100) + 1;
    const success = roll <= skillValue;
    const isCrit = roll <= skillValue * 0.05;
    const isFumble = roll > 95;
    const resultText = isFumble ? "大失败！" : isCrit ? "暴击成功" : success ? "成功" : "失败";

    // CoC 7e: a skill is marked after a successful use.  Settlement later
    // rolls d100 against the marked skill; only a roll above it improves it.
    this.#lastRolls.push({ skill, roll, target: skillValue, success });
    if (success) this.markSuccessfulOrdinaryCoCSkill(skill);
    this.#lastPushedRoll = success ? null : { skill, roll, target: skillValue };

    msg(`🎲 ${skillDisplay}检查 d100=${roll} (目标=${skillValue}%) → ${resultText}`);
    this.#lastNarrative = `${skillDisplay}检查 ${resultText}。`;
    return true;
  }

  /**
   * 场景内一句"侦查XX"该解析成哪条线索。
   *
   * ⚠ 此前场景里不管有几条未发现线索，一律给**第一条**——玩家的话从没被
   * 读取过，「侦查卫生间」拿到休息区的手枪，「侦查餐厅」拿到卫生间的毒品。
   * 不是偏移一位，是输入从未被读取。
   *
   * 三种结果对应三种处理，别替玩家决定该找哪个：
   *   命中唯一 → 解析那一条
   *   命中多条 → 问清楚，不猜
   *   一条不中 → 如实说"没什么特别的"（不能不看输入直接给下一条——
   *              那会报告一件玩家没做的事，比拒绝更糟）
   *   没给提示（去掉动词后不剩什么）→ 回落旧行为：唯一/首条候选直接给。
   *   这不是"匹配失败"，是玩家压根没说要找什么，跟"目标不存在"是两回事。
   *
   * 决策本身（入口短路 + matchSceneClues 派发）在 decideClueMatch()
   * （clue-match.ts）——纯函数，diag-clue-phrasing.ts 的判据用例共用同一份，
   * 不再各自维护一份短路正则。这里只做两件本方法独有的事：① 按 matchTexts
   * 是否存在筛出真正能参与匹配的候选（YAML 手写/旧版 registerSceneClue
   * 合成的线索没有这份数据）；② 把 ask 的候选 id 翻成显示名给玩家看。
   */
  private resolveSceneClueMatch(
    input: string,
    candidates: string[],
  ): { kind: "resolve"; clueId: string } | { kind: "ask"; options: string[] } | { kind: "deny" } | { kind: "fallback" } {
    // 只有带 matchTexts 的线索参与按文本匹配——YAML 手写线索/
    // registerSceneClue 合成的旧线索没有这份数据，不是"匹配失败"，是这条
    // 线索压根没参与匹配这件事。全场景候选都没有 matchTexts 时整体回落。
    const matchable = candidates
      .map((id) => ({ id, info: this.#investigationRaw.getClueMatchInfo(id) }))
      .filter((c): c is { id: string; info: { matchTexts: string[]; displayName: string } } => c.info !== null);
    if (matchable.length === 0) return { kind: "fallback" };

    const decision = decideClueMatch(input, matchable.map((c) => ({ id: c.id, texts: c.info.matchTexts })));
    if (decision.kind === "ask") {
      const options = decision.clueIds.map((id) => matchable.find((c) => c.id === id)!.info.displayName);
      return { kind: "ask", options };
    }
    return decision;
  }

  /**
   * 取当前场景 + 当前 PC 视角下"能参与文本匹配的未发现线索"，并派发决策
   * ——handleSkillCheck（显式技能检定）与对象名门（act() 里
   * intent.action==="unknown" 那支，开发·对象名通向线索 任务1）共用这一步
   * "取候选 + 问 decideClueMatch"，不各自维护一份。两个调用方对 fallback
   * （没提到任何具体对象）的处理不同，留在各自的调用点决定，这里不替
   * 它们做主。
   *
   * 返回 null：场景没有任何"能参与匹配"的未发现线索（全部已发现，或
   * 剩下的都是没有 matchTexts 的旧版线索）——调用方据此回落到各自的
   * 默认行为（前者走裸检定，后者原样放行到攻击检测/LLM 叙事）。
   */
  private matchCurrentSceneClue(
    input: string,
  ): { decision: ReturnType<GameSession["resolveSceneClueMatch"]>; candidates: string[] } | null {
    // 按场景 ID 查，不是显示名：线索是模组用 `scene: "premiers_barn"` 这样的
    // 场景 ID 注册进来的。（同文件另一处用 sceneDisplayNames[pos] 去查同一份
    // 数据，对模组场景恒查不到，见下方 getSceneClues 的调用点。）
    const pos = this.#displayedSceneProjection();
    // 只解析有完整定义的线索。模组通过 registerSceneClue 注册的线索只带一句
    // 描述，没有 ClueDef（技能、成功层级文本、san_cost 都没有），送进
    // investigateCoC 只会拿到「你没有找到有用的线索」这个兜底失败——
    // 比原来的裸检定更糟。这类线索继续走下面的通用检定。
    //
    // 开发·卧室线索修复 任务①：候选集还要排掉"被某条尚未发现的线索
    // unlocks 声明为前置"的那些——clue_bedroom_diary 与 clue_bedroom_old_doc
    // 名字高度重叠，old_doc 混进候选会把 diary 本该唯一的简称也搅浑，
    // 逼出没人会说的碎片，自然句被 clue-match.ts 判 deny。old_doc 本就该
    // 在 diary 之后才拿到（模组原文"从日记本中取出老旧文件"）。这里只是
    // 过滤候选，不是自动发现：diary 一旦真被发现，isLockedByUndiscoveredPrerequisite
    // 对 old_doc 就会转 false（前置已满足），old_doc 自然重新有资格参与
    // 匹配——玩家还是得自己再说一句话去找它，不会被顺手带出。
    const candidates = this.#investigationRaw
      .getUndiscoveredSceneClues(pos, this.#activePlayerId)
      .filter((c) => this.#investigationRaw.hasClueType(c))
      .filter((c) => !this.#investigationRaw.isLockedByUndiscoveredPrerequisite(c, this.#activePlayerId));
    if (candidates.length === 0) return null;
    return { decision: this.resolveSceneClueMatch(input, candidates), candidates };
  }

  /**
   * 对象名闸门的落地——把 matchCurrentSceneClue 的结果落成消息并返回
   * "有没有拦下这一回合"，供 unknown 与 look 两处调用方共用（开发·闸门
   * 放宽到 look 任务1）。两处唯一的差异是 `allowDeny`：
   *   unknown：`{allowDeny: true}`——本来就不知道玩家想干嘛，一个诚实的
   *            "没什么特别的"好过放行到 LLM 瞎编。
   *   look：   `{allowDeny: false}`——已经知道玩家在"看"，只有明确对上
   *            场景对象（resolve/ask）才值得打断默认的场景描述，猜不中
   *            （deny）就不该抢答，见调用点的注释（"环顾四周"那个例子）。
   */
  private applyObjectNameGate(
    input: string,
    turnMessages: AgentMessage[],
    playerName: string,
    opts: { allowDeny: boolean },
  ): boolean {
    const match = this.matchCurrentSceneClue(input);
    if (!match) {
      this.traceIntent("clue-decision source=object-gate kind=no-candidates clueId=null candidates=0 intercepted=false");
      return false;
    }
    const clueId = match.decision.kind === "resolve" ? match.decision.clueId : null;
    const intercepted = match.decision.kind !== "fallback" && !(match.decision.kind === "deny" && !opts.allowDeny);
    this.traceIntent(`clue-decision source=object-gate kind=${match.decision.kind} clueId=${JSON.stringify(clueId)} candidates=${match.candidates.length} intercepted=${intercepted}`);
    if (!intercepted || match.decision.kind === "fallback") return false;
    turnMessages.push({ speaker: playerName, content: input, type: "action" });
    const objMsg = (s: string) => turnMessages.push({ speaker: "系统", content: s, type: "system" });
    // applyClueDecision() 的返回值只在"要不要继续走别的分支"时有意义
    // （resolveSceneClue 那套里）；这里已经确定要 return true，用不上，
    // 显式弃用（同 resolveCompoundMoveReply 的 void tryResolveModuleScene
    // 那处先例），不留一个静默丢掉返回值的调用点。
    void this.applyClueDecision(match.decision, objMsg);
    return true;
  }

  /**
   * 当前场景（当前 PC 视角）尚未发现线索的名字/唯一简称——喂给 KP 叙事的
   * 约束检查（开发·意图与约束补漏 任务3，缺口 B：
   * `narrative_denies_undiscovered_clue`）。复用 clue-match.ts 的
   * splitKeys，与匹配器判定"这是场景里的一个对象"用同一套认定，不另起
   * 一套——两处标准一旦走岔，会出现"匹配器认得这是个对象，约束层却认
   * 不出来"这种自相矛盾的状态。
   *
   * 只取有 matchTexts 的线索（同 matchCurrentSceneClue 的过滤）：没有
   * matchTexts 的旧版线索本来就不参与文本匹配，也没有"名字"可供约束层
   * 比对。场景没有任何未发现线索，或全是这种旧版线索时返回空数组——
   * 约束的 matchPredicate 会因为 `undiscoveredClueKeys.length === 0`
   * 直接放行，不误伤。
   */
  private currentUndiscoveredClueKeys(): string[] {
    const pos = this.#displayedSceneProjection();
    const candidateIds = this.#investigationRaw
      .getUndiscoveredSceneClues(pos, this.#activePlayerId)
      .filter((c) => this.#investigationRaw.hasClueType(c));
    const keys: string[] = [];
    for (const id of candidateIds) {
      const info = this.#investigationRaw.getClueMatchInfo(id);
      if (!info) continue;
      keys.push(...splitKeys([info.displayName, ...info.matchTexts]));
    }
    return [...new Set(keys)];
  }

  /**
   * 把一个（非 fallback 的）ClueMatchDecision 落成消息——resolve/ask/deny
   * 三档的措辞与揭示逻辑，不管是从显式技能检定还是从对象名门走到这里都
   * 完全一致，两处不该各写一份。fallback 不在这里处理，见
   * matchCurrentSceneClue 的说明。
   *
   * 开发·对象名通向线索 任务2：ask 分支曾经直接列出候选的展示名
   * （"这里可能有：「冰箱与储物柜」、「中控台拉杆」"）——行动锚点那轮
   * 专门定过"中"粒度（告诉玩家有东西、不说是什么，见 getSuggestions()
   * 的注释与 scene-suggestions.test.ts 的剧透判据），这里是同一份信息
   * （未发现线索），却没守住同一条标准。改成只说"不止一样东西，说清楚
   * 点"，不带任何候选名字/id——`decision.options` 仍然保留在类型里
   * （resolveSceneClueMatch 仍然算给它，供其它诊断/未来用途读取候选
   * 是谁），只是不再把它渲染进玩家能看到的文案。玩家能不能借此把话说得
   * 更具体，靠的是场景本身的叙述（进场时已经描述过的物件），不依赖这句
   * 回问替他念一遍候选名单——任务1把"提到对象名不需要动词"这件事做好之
   * 后，玩家只要把看到的东西说出来就够了，不需要引擎主动剧透。
   */
  private applyClueDecision(
    decision: { kind: "resolve"; clueId: string } | { kind: "ask"; options: string[] } | { kind: "deny" },
    msg: (s: string) => number,
  ): boolean {
    if (decision.kind === "resolve") return this.resolveSceneClue(decision.clueId, msg);
    if (decision.kind === "ask") {
      msg("你想找什么？这里好像不止一样东西，说清楚一点你想查哪里/什么。");
      this.#lastNarrative = "需要说清楚具体想搜哪里/什么";
      return true;
    }
    // kind === "deny"：玩家给了具体提示，但对不上场景里任何一条未发现
    // 线索——如实说找不到，不能不看输入直接给下一条线索。那正是本仓
    // 反复修的一类病：报告了一件玩家没做的事，比拒绝更糟。
    msg("你仔细找了找，这里没什么特别的。");
      this.#lastNarrative = "这里没什么特别的";
    return true;
  }

  /**
   * 解析一条场景线索：掷检定、给出揭示文本、扣掉它要求的 SAN。
   *
   * 判定规则全在 InvestigationEngine 里（含"已发现则不重复扣 SAN"与成功后
   * markDiscovered），这里只负责把结果落到会话状态上。
   *
   * SAN 经 setPlayerSan 扣减，因此和 KP 手动改 SAN 走同一个 applyAction 闸门，
   * 也同样会落到真相源。目标值恒在 [0, 当前值] 内，落在闸门的整数域中，
   * 不存在被拒绝的取值。
   *
   * 线索揭示只对发现者可见（discoverer_only）——发现者=做出这次检定的
   * pcId，与 investigateCoC 自己的 markDiscovered/isDiscoveredBy 口径一致
     * （同一个 active selector）。不改 msg() 的调用方式（29 处调用方共用
   * 同一个签名，牵一发动全身，且已有直接调 resolveSceneClue 的测试按位置参数
   * 传 (clueType, msgFn)，改签名会破坏它们）：msg() 的返回值就是
   * messages.push(...) 的新长度，用它定位刚推入的那条消息，原地补上
 * visibility/discoverer——act() 期间 msg() 背后的数组与 this.#turnMessages
   * 是同一个引用（见该字段的说明），直接调用（测试里那样，不经过 act()）时
 * this.#turnMessages 为 null，补丁自然跳过，不影响任何既有测试。
   *
   * 【已修复，开发·多人可见性 N6，todo-25】此前这里只对**存储的历史**
   * （GET /history）生效——live 的 WS 广播（ws-handler.ts 的
   * broadcastToSession）不按玩家过滤，server.ts 把完整 narrative 广播给
   * 该 session 全部连接，线索私密只在"回看历史"这个维度成立，不是
   * "实时全程保密"。现在 server.ts 的 `broadcastActionResult` 按连接
   * 分别算该发什么，player 连接只发 `getPlayerHistory(pcId)` 这一回合
   * 新增的部分——复用这里同一份可见性判定（存储层过滤的结果），WS 这
   * 条路口径与 GET /history 一致了。见
   * ws-broadcast-per-player-visibility.test.ts。
   *
   * 检定失败时补一条骰子播报（🎲 …d100=…→失败），格式与通用检定路
   * （handleSkillCheck 的裸检定分支）一致——此前线索路 resolve/fallback/
   * ask/deny 四个分支全部提前 return，够不到通用路那句骰子播报，玩家看到
   * 的只有一句"没找到"，分不清是掷骰子输了还是这里压根没东西（实跑报告
   * 抄了两句不同措辞的失败文案，仍然判"不知道是场景无物还是检定失败"——
   * 单测断言"两个字符串不同"通过了，读者的疑问没通过，以读者为准）。
   * 骰子播报把"检定结果"这件事摆到明面上，不依赖玩家记住两句话哪句代表
   * 哪种含义。只在失败时加这一条——成功路径的输出一个字不变。
   *
   * 开发·线索闸门 任务3：前期（isEarlyGame()）检定失败时，把千篇一律的
   * "没能看出什么名堂"换成指向性降级信息（"XX 那边似乎还有东西"）——
   * 从这条线索自己的 findMethods 描述里抽位置名词（extractLocationHint），
   * 只给"往哪查"，不给"能查到什么"。抽不出干净的位置词（没有 matchTexts、
   * 或候选长度都不落在 2-6 字区间）时静默保留原始 revelation，不硬凑。
   * 非前期时这一段完全不执行，成功路径同样不受影响。
   *
   * 开发·线索闸门 任务4：failback 阶梯（N=2），只对 core 线索生效——与
   * 剧本杀路径 play/clue-check.ts 的同名机制对齐，此前自由跑团这条路
   * 完全没有（InvestigationEngine 只有 DifficultyProfile，是"两个运行时
   * 各持一半"的第三次，见 docs/todo.json todo-03）。失败计数进真相源
   * （WorldStateManager.incrementClueFail，见该方法注释），不在 GameSession
   * 再开一个内存 Map：
   *   failCount 0/1 → 正常检定（本方法原有的那条路，不变）
   *   failCount 2   → 灵感检定（智力）代替这条线索自己声明的技能
   *   failCount 3   → "无副作用重试"：技能与正常检定完全相同——
   *                   investigateCoC 本来就不烧运气、不传 pushed 时
   *                   CoCEngine 默认就是 false，机制上字面等同一次正常
   *                   检定，这里只是明确标注这次尝试的性质（叙述 + 断言
   *                   用），不是另开一套判定
   *   failCount >=4 → 直接给（overrideSkill.forceSuccess，见 investigateCoC
   *                   注释）：不再掷骰，roll 恒为 0
   * 时间照常推进——这四档全部走同一个 act() 回合，advanceTime 在 act()
   * 顶部统一处理，这里不做任何例外。
   */
  private resolveSceneClue(clueType: string, msg: (s: string) => number): boolean {
    const skills = this.activeInvestigationCheckValues();
    const isCore = this.#investigationRaw.isCoreClue(clueType);
    const failCount = isCore ? this.#worldRaw.getClueFailCount(clueType) : 0;

    let overrideSkill: { id: string; value: number; pushed?: boolean; forceSuccess?: boolean } | undefined;
    let ladderNote = "";
    if (isCore && failCount >= 4) {
      overrideSkill = { id: "grant", value: 0, forceSuccess: true };
      ladderNote = "（屡次尝试后，你们终于想通了关键——）\n";
    } else if (isCore && failCount === 3) {
      ladderNote = "（你们决定换个思路，再试一次——）\n";
    } else if (isCore && failCount === 2) {
    const ideaPc = this.#activeCharacterRaw ?? { attributes: {}, luck: 0, skillValues: {} };
      overrideSkill = { id: "idea", value: resolveCheckValue(ideaPc, "灵感") };
      ladderNote = "（反复搜寻无果，你们停下来仔细想了想——）\n";
    }

    const result = this.#investigationRaw.investigateCoC(
      clueType,
      skills,
      this.#activePlayerId,
      overrideSkill,
      (baseTarget) => this.effectiveActivePercentileTarget(baseTarget),
    );

    // A discovered clue proves a successful skill use only when the engine
    // actually rolled that stored CoC skill.  The failback ladder's roll=0
    // automatic grant and its idea/attribute step are deliberately excluded.
    if (result.success && result.roll > 0) this.markSuccessfulOrdinaryCoCSkill(result.skillId);

    let diceLine = "";
    let revelation = result.revelation;
    if (!result.success) {
      if (isCore) this.#worldRaw.incrementClueFail(clueType);
      const skillDisplay = SKILL_DISPLAY_NAMES[result.skillId] ?? result.skillId ?? "调查";
      diceLine = `🎲 ${skillDisplay}检定 d100=${result.roll} (目标=${result.skillValue}%) → 失败`;
      msg(diceLine);

      if (this.#earlyGameProjection()) {
        const info = this.#investigationRaw.getClueMatchInfo(clueType);
        const hint = info ? extractLocationHint(info.matchTexts.slice(1)) : null;
        if (hint) revelation = `你仔细搜查了一番，但这次没能看出什么名堂——不过${hint}那边似乎还有些什么，或许该再仔细找找。`;
      }
    } else if (isCore) {
      this.#worldRaw.resetClueFails(clueType);
    }
    revelation = ladderNote + revelation;
    const newLength = msg(revelation);
    const idx = newLength - 1;
    if (this.#turnMessages && this.#turnMessages[idx]) {
      this.#turnMessages[idx].visibility = "discoverer_only";
      this.#turnMessages[idx].discoverer = this.#activePlayerId;
    }
    // lastNarrative 是很多客户端唯一读的字段（不逐条看 events）——失败时把
    // 骰子播报也折进去，不能只靠 events 里的另一条消息才看得到"掷过骰子"。
    this.#lastNarrative = diceLine ? `${diceLine}\n${revelation}` : revelation;

    if (result.sanLost > 0) this.inflictSanLoss(result.sanLost, msg);
    return true;
  }

  /**
   * Build the transient check values consumed by the investigation engine.
   * Ordinary skills remain the stored skill sheet; the BARN bridge's declared
   * attribute proxies resolve from their canonical character-card fields.
   */
  private activeInvestigationCheckValues(): Record<string, number> {
    const character = this.#activeCharacterRaw;
    const skillValues = character?.skillValues ?? character?.skills ?? {};
    if (this.#activeRulesetRaw !== "cosmic-horror" || !character?.attributes || typeof character.attributes !== "object") return skillValues;

    return {
      ...skillValues,
      ...Object.fromEntries(Object.entries(GameSession.BARN_CLUE_ATTRIBUTE_SKILLS).map(([name, key]) => [
        key,
        resolveCheckValue(character, name),
      ])),
    };
  }

  /**
   * 处理"和 XX 说话/交谈"。
   *
   * ⚠ 此前这里是纯桩：不管玩家说什么、跟谁说，永远回一句
   *   「你试图与周围的人交流…」——`MythosModuleLoader` 早就把模组 NPC
   *   的内联人格通过 `registerNPCPersonality` 注册进了 NPC Agent 系统
 *   （`#registryRaw`，见 #registerModuleNPCPersonality 的注释），
   *   会话内对话必须直接消费这份私有注册表，不能通过公开读 facade 取得 Agent。
   *
   *   对话执行沿用同一私有路径：`#registryRaw.findAgentByName` →
   *   `npcAgent.respond` → 记一条 dialogue 消息，情绪在生成时刻固定。
   *
   *   找不到人时分清楚三种情况（参照 notFoundLine() 的分辨方式，不用万金油）：
   *   没指定对象 / 这里没这个人 / 这个人在场但没有可用人格数据。
   */
  /**
   * 泛指整个队伍的说法，不是 NPC 专名——"陈岳起身准备动身出发，但先等待
   * 同伴确认具体要前往的地点"这类句子里，"同伴"指的是其他 PC，用它去
   * NPC 名单里找必然找不到，报"这里没有「同伴」"是把泛指词当成了专名。
   */
  private static readonly GENERIC_PARTY_WORDS = new Set(["同伴", "队友", "大家", "伙伴", "他们", "众人"]);

  /**
   * 登记表（`CHARACTER_NOUN_REGISTRY`）里当前场景没有对应 NPC 的角色
   * 名词——开发·约束层补角色实体域 N9 任务 B。供 `handleTalk` 计算，
   * 按【实际在场的实体】算，不读模组静态数据
   * （那是 N7 扫描判据 `scene-npc-noun-registry.ts` 的事，这里要的是
   * 运行时真相——万一某个 NPC 死了/离场，运行时会如实反映）。
   */
  #sceneFabricableCharacterNouns(sceneId: string = this.#displayedSceneProjection()): string[] {
    const presentNames = this.#worldRaw
      .getEntitiesInScene(sceneId)
      .filter((e) => e.type === "npc" || e.type === "monster")
      .map((e) => ({ name: e.name }));
    return unrepresentedCharacterNouns(presentNames);
  }

  private async handleTalk(
    intent: ActionIntent,
    input: string,
    messages: AgentMessage[],
    msg: (s: string) => number,
  ): Promise<boolean> {
    const pos = this.#displayedSceneProjection();
    const presentNpcEntities = this.#worldRaw
      .getEntitiesInScene(pos)
      .filter((e) => e.type === "npc" || e.type === "monster");
    const presentNames = presentNpcEntities.map((e) => e.name);
    // .trim() 只剥空白，不剥标点——实跑「顺便问问附近店铺，有没有见过这人」
    // 一类输入，intent.target 抽出来的是「附近店铺，」，尾随的逗号原样进了
    // key，回显打出「这里没有「附近店铺，」」。剥掉首尾中英文标点，不动中间。
    const want = stripEdgePunctuation((intent.target ?? "").trim());

    if (!want) {
      msg(
        presentNames.length > 0
          ? `要跟谁说话？在场的有：${presentNames.join("、")}。`
          : "这里没有人可以交谈。",
      );
      this.#lastNarrative = "要跟谁说话？";
      return true;
    }

    // 「同伴/队友/大家/伙伴/他们/众人」是泛指，不是专名——不该走下面的
    // NPC 专名查找然后报"这里没有「同伴」"。队伍成员是已知的（this.#party），
    // 照上面空目标分支的思路给个符合处境的回应，不是专名查找失败。
    // ⚠ 只改这一类词的处理，不放宽下面 `.includes` 的模糊匹配——那条已经
    // 够松，再松会把"同伴"这类词也模糊配进某个真实 NPC 名里去。
    if (GameSession.GENERIC_PARTY_WORDS.has(want)) {
      const partyNames = [...this.#party.values()]
        .map((m) => m.sheet?.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0);
      msg(
        partyNames.length > 0
          ? `队伍里目前有：${partyNames.join("、")}。想问点什么，或者是想商量接下来怎么走？`
          : "现在只有你自己一个人，没有其他队友。",
      );
      this.#lastNarrative = "确认队伍情况";
      return true;
    }

    const target = presentNpcEntities.find((e) => e.name === want)
      ?? presentNpcEntities.find((e) => e.name.includes(want) || want.includes(e.name));

    if (!target) {
      msg(
        presentNames.length > 0
          ? `这里没有「${want}」。在场的有：${presentNames.join("、")}。`
          : `这里没有「${want}」，这里也没有别人。`,
      );
      this.#lastNarrative = `这里没有「${want}」`;
      return true;
    }

    const npcAgent = this.#registryRaw.findAgentByName(target.name);
    if (!npcAgent) {
      // NPC 在场、但没有注册人格（模组没写内联人格、也没能从 npcs.yaml 兜底）——
      // 明说缺的是什么，不要用一句放之四海而皆准的套话糊弄过去。
      msg(`${target.name}没有可用的人格数据，暂时无法对话。`);
      this.#lastNarrative = `${target.name}没有可用的人格数据`;
      return true;
    }

    try {
      const history = this.#historyProjection(10);
      const reply = await npcAgent.respond(input, history.messages, {
        sceneId: pos,
        ruleset: this.#activeRulesetRaw,
        sceneFabricableCharacterNouns: this.#sceneFabricableCharacterNouns(pos),
      });
      const mood = npcAgent.getMood();
      messages.push({
        speaker: target.name,
        content: reply,
        type: "dialogue",
        ...(mood ? { mood } : {}),
      });
      this.#lastNarrative = reply;
    } catch (e: any) {
      log.warn("session", `NPC 对话失败: ${target.name} — ${e?.message ?? e}`);
      msg(`${target.name}欲言又止，一时没能回应。`);
      this.#lastNarrative = `${target.name}没有回应`;
    }
    return true;
  }

  /** 已经为之掷过目击 SAN 的生物种类。CoC 7e：同一种生物只在首次目击时掷。 */
  readonly #sightedMythos = new Set<string>();

  /**
   * 神话生物首次目击 → SAN 检定。
   *
   * ⚠ `NPCCombatEngine.getSanCost()` 在此之前**零调用方**。
   *   `coc-npc.yaml` 给每种生物都写了 `san_cost`（修格斯 `1d6/1d20`、
   *   深潜者 `0/1d6`、米戈 `0/1d6`…），一条都没生效过 ——
   *   遭遇修格斯和遭遇一条野狗，对理智的影响完全一样。
   *
   *   接线要定两件事，都按 CoC 7e：
   *     · **在哪触发**：目击即掷，不必等到战斗。所以放在 `act()` 顶端
   *       扫当前场景，而不是挂在攻击流程上 —— 看见就已经晚了。
   *     · **重复遭遇扣不扣**：不扣。同一种生物只在首次目击时掷
   *       （`sightedMythos` 按种类记，不按个体 —— 一群食尸鬼只掷一次）。
   */
  private checkMythosSighting(msg: (s: string) => void): void {
    if (this.#activeRulesetRaw !== "cosmic-horror") return;
    const state = this.#worldRaw.getCurrentState();
    for (const ent of Object.values(state.entities)) {
      if (ent.type !== "monster" && ent.type !== "npc") continue;
      if ((ent.hp ?? 0) <= 0) continue;              // 尸体不掷目击
      if (ent.position && ent.position !== state.scene) continue; // 不在同一场景
    const cost = this.#npcCombatRaw.getSanCost(ent.name, this.#activeRulesetRaw);
      if (!cost) continue;                            // 不是神话生物
      if (this.#sightedMythos.has(cost + ":" + ent.name)) continue;
      this.#sightedMythos.add(cost + ":" + ent.name);
    const r = this.#sanityRaw.sanityCheck(cost);
      this.#persistSanity(this.#activePlayerId);
      msg(`🧠 目击【${ent.name}】：d100=${r.roll} → ${r.passed ? "通过" : "失败"}！SAN -${r.sanLoss}（剩余 ${this.#sanityRaw.state.currentSAN}）`);
      if (r.temporaryInsanityTriggered) msg(`⚠️ 临时疯狂触发！${r.boutOfMadness ?? ""}`);
      if (r.indefiniteInsanityTriggered) {
        msg(`⚠️ 不定性疯狂（${r.indefiniteLevel ?? ""}）——你已经不是进来时的那个人了。`);
      }
    }
  }

  /** 经济回合每 N 个玩家回合推进一次，太密会把纯对话/纯观察也变成经济事件洪流。 */
  private static readonly ECONOMY_TICK_INTERVAL = 10;

  /**
   * 政经引擎的时钟。`PoliticoEconomyEngine.advanceRound()` 本身早就是对的
   * 形状（四个子系统各自推进、汇总成 `EconomyEvent[]`），**缺的只是没人调它**
   * ——生产代码零调用方，世界装好了但不会自己往前走。
   *
   * ⚠ 时钟挂在哪、为什么：三个候选里选了「回合推进」，具体是这个类自己的
   *   `#roundRaw`（`act()` 顶部 `#roundRaw++`），不是 `world/state.ts` 那个
   *   同名不同物的 `WorldState.advanceRound()`（那个在 `play/scene-pipeline.ts`
   *   里，服务的是完全不同的一条入口——剧本杀，不是这个类所在的网页/API 路）。
   *
   *   - **选它的理由**：`#roundRaw` 已经在驱动其它周期性子系统
   *     （`tickStatusEffects()`、`companionManager.newRound()`、
   *     `advanceTime()`），确定性、每回合必然触发一次，不需要新造一个触发器；
   *     经济时钟接进同一个位置是复用既有模式，不是另开一条平行的路。
   *     驱动它的是 `act()` 的调度本身，不是 LLM——LLM 就算参与了意图解析，
   *     那一步在这之前已经跑完了。
   *   - **否掉「场景切换」**：太不规律。一场战斗、一串对话、一次纯调查
   *     可能整场都不换场景，经济会停摆；反过来场景来回跳又会短时间内
   *     连续触发。世界演化的节奏不该被玩家在场景图上走了几步决定。
   *   - **否掉「显式 KP 动作」**：需要人记得去点，大多数会话里根本不会有人
   *     触发，「会自己演化的世界」这句设计初衷就落空了——那是被动挂件，
   *     不是时钟。
   *
   *   节流到每 `ECONOMY_TICK_INTERVAL` 回合一次：势力/市场/政策这层模拟的
   *   时间尺度是天/周级别，每个玩家动作都推进会把没有剧情实质进展的纯
   *   对话/观察也算成经济时间，事件噪音与格局漂移速度都会不像话。
   */
  private tickEconomy(msg: (s: string) => void): void {
    if (this.#roundRaw % GameSession.ECONOMY_TICK_INTERVAL !== 0) return;

    // 经济回合号本身先过闸门——「派生事件必须经规则执行器结算」落在
    // "要不要推进这一次"这一层：单调递增的整数域，正常情况下闸门总会
    // 批准，但让经济时钟和 HP/SAN/难度用同一套结算纪律（同一个 applyAction
    // 入口、同一种 Result<StateDelta, RejectReason> 形状），而不是自己
    // 另开一条直写的口子——这正是 apply-action.ts 头注释说的「未过闸门的
    // 域比没有域更糟：它看起来在校验」反过来的那一半：**能过闸门的域，
    // 就不该绕过闸门直写**。
    const variable = "economy:round";
    const currentRound = this.#politicoEconomyRaw.round;
    const nextRound = currentRound + 1;
    const gateResult = applyAction(
      boundedIntegerScenario(variable, currentRound, Number.MAX_SAFE_INTEGER),
      boundedIntegerGateState(variable, currentRound),
      {
        kind: "freeform",
        actor: "system",
        description: "advance economy round",
        effects: [{ variable, to: nextRound }],
      },
    );
    if (!gateResult.ok) return; // 结构上不该发生（单调整数域），闸门说不行就不推进

    // causationId 绑定「这一次 GameSession 回合」，不是「这一次经济回合」——
    // 与 #roundRaw 一一对应，天然防止同一个玩家回合被重复推进两次经济时钟
    // （例如某处误把 tickEconomy 调用了两遍）：第二次传同一个 causationId，
    // `advanceRound()` 直接返回空数组，不产生第二批事件。
    const causationId = `eco:${this.#idRaw}:round:${this.#roundRaw}`;
    const events = this.#politicoEconomyRaw.advanceRound(causationId);

    // 只读已提交状态、只写具名方法——不碰 getCurrentState() 的返回值，
    // 那是新对象，赋值会静默丢弃（kp-tool-surface-assessment.md §八 记录过
    // 两次这类事故）。这里全程只调用 world.logEvent()，不做任何赋值。
    for (const e of events) {
      this.#worldRaw.logEvent({
        round: this.#roundRaw,
        timestamp: Date.now(),
        event_type: "system",
        description: `[经济] ${e.description}`,
        causationId: e.causationId,
      });
      msg(e.description);
    }
    // 叙述：只把已结算的事件原文报出来，不经过 LLM——这里没有生成、
    // 没有裁决，纯粹是把 EconomyEvent.description（子系统算好的确定性文本）
    // 转成一条系统消息。LLM 要参与只能是"把这些事件写得更好看"，不能是
    // "决定发生了什么"——本轮没有接那一层，就没有这个风险。
    if (events.length > 0) {
      msg(`🌍 世界继续运转（经济回合第 ${this.#politicoEconomyRaw.round} 轮）：${events.length} 件大事发生了。`);
    }
  }

  /**
   * 施加一次**剧情造成的** SAN 损失：扣血 + 疯狂判定 + 播报。
   *
   * ⚠ 原先这里走的是 `setPlayerSan(pid, current - sanLost)`。
   *   那是 KP 的管理操作 —— 设一个绝对值，**不跑疯狂判定**（合理：
   *   KP 在改数字，不是角色见了恐怖）。于是调查线索掉的 SAN
   *   永远不会让人发疯。
   *
   *   而临时疯狂（单次 ≥5）在这条路上是**够得着**的：
   *   `investigation.yaml` 的 `1/1d6` 失败时有 1/3 概率掷出 5 或 6。
   *   疯狂是 CoC 最标志性的机制，却从调查里一次都没触发过。
   *
   *   现在走 `applyLoss()`，和玩家主动 SAN 检定同一套判定。
   */
  private inflictSanLoss(amount: number, msg: (s: string) => number): void {
    const r = this.#sanityRaw.applyLoss(amount);
    this.#persistSanity(this.#activePlayerId);
    if (r.temporaryInsanityTriggered) {
      msg(`⚠️ 临时疯狂触发！${r.boutOfMadness ?? ""}`);
    }
    if (r.indefiniteInsanityTriggered) {
      msg(`⚠️ 不定性疯狂（${r.indefiniteLevel ?? ""}）——你已经不是进来时的那个人了。`);
    }
  }

  // ── 豁免检查──
  private handleSavingThrow(intent: ActionIntent, msg: (s: string) => number): boolean {
    const ability = intent.ability ?? "constitution";
    const dc = intent.dc ?? 12;
    const reason = intent.reason ?? "豁免检查";
    const abilityMod = this.#activeCharacterRaw?.attributes?.[ability] ? Math.floor(((this.#activeCharacterRaw!.attributes[ability] ?? 10) - 10) / 2) : 0;
    const roll = Math.floor(Math.random() * 20) + 1;
    const total = roll + abilityMod;
    const success = total >= dc;
    const abilityNames: Record<string, string> = { strength: "力量", dexterity: "敏捷", constitution: "体质", intelligence: "智力", wisdom: "感知", charisma: "魅力" };
    msg(`🎲 ${abilityNames[ability] ?? ability}豁免 (${reason}): d20=${roll}+${abilityMod}=${total} (DC=${dc}) → ${success ? "通过" : "失败"}`);
    this.#lastNarrative = `豁免检查 ${success ? "成功通过" : "失败"}。`;
    return true;
  }

  // ── 攻击 ──
  /**
   * 一次攻击命中之后的结算：扣血 → 重伤判定 → 挂状态 → 写回世界。
   *
   * ⚠ 抽出来是因为**本来有两份**，而功能全的那份跑不到。
   *
   *   `act()` 里有一段带 `checkMajorWound` 的战斗结算（重伤、部位、
   *   流血、昏迷都有），但意图派发在它**前面** —— `handleAttack` 一旦
   *   认出「攻击」就 `return true`，`act()` 直接返回，那一段永远到不了。
   *   而 `handleAttack` 自己只会扣血。
   *
   *   后果：**重伤/流血/昏迷在真实对局里一次都没生效过**。
   *   我上一轮按 CoC 口径修的流血条件（只在打昏时才流血），
   *   改的正是那段跑不到的代码 —— 等于没改。
   *
   *   这类「写了没接上」这轮已经是第三处了（前两处是致残描写、
   *   载具类型），所以这次不是把逻辑再抄一遍，而是**只留一份**。
   */
  private resolveHit(
    target: WorldEntity,
    dmg: number,
    msg: (s: string) => number,
  ): void {
    target.hp = Math.max(0, target.hp - dmg);
    const mw = checkMajorWound(dmg, target.maxHp ?? 10, target.hp);
    if (mw.isMajorWound) {
      target.status = target.status || [];
      target.status.push("重伤:" + mw.location);
      // 带时限的状态，由 `tickStatusEffects()` 每回合推进。
      // 跟着 `checkMajorWound` 走：CoC 7e 里重伤只掷 CON，
      // 持续掉血属于濒死，所以只在这一击把人打昏时才流血。
      if (mw.bleeding) target.status.push(newStatus("bleeding"));
      if (mw.unconscious) target.status.push(newStatus("stunned"));
      msg("💀 " + mw.description);
    }
    this.#worldRaw.upsertEntity(target);
  }

  /** 消费 RulesEngine 已裁决的 CoC 后续检定；两条攻击方向必须共用。 */
  private consumeCombatFollowUp(
    target: WorldEntity,
    followUp: CombatFollowUpResult | undefined,
    msg: (s: string) => number,
  ): void {
    if (!followUp) return;
    if (followUp.kind === "head-critical-con-death") {
      if (followUp.outcome === "failed") {
        target.hp = 0;
        target.status = ["dead"];
        this.#worldRaw.killEntity(target.id);
        msg(`💀 ${target.name} 的头部暴击 CON检定失败（d100=${followUp.roll} vs ${followUp.constitution}），死亡。`);
        return;
      }
      if (followUp.outcome === "passed") {
        msg(`⚠ ${target.name} 的头部暴击 CON检定通过（d100=${followUp.roll} vs ${followUp.constitution}），仍陷入昏迷。`);
        return;
      }
      msg(`⚠ ${target.name} 的头部暴击 CON属性未知，无法结算致死检定；仅应用已有昏迷状态。`);
      return;
    }

    if (followUp.outcome === "failed") {
      target.status = target.status ?? [];
      const status = newStatus("incapacitated");
      target.status.push(status);
      this.#worldRaw.upsertEntity(target);
      msg(`⚠ ${target.name} 的胸部贯穿 CON检定失败（d100=${followUp.roll} vs ${followUp.constitution}），进入${status}状态。`);
      return;
    }
    if (followUp.outcome === "passed") {
      msg(`⚠ ${target.name} 的胸部贯穿 CON检定通过（d100=${followUp.roll} vs ${followUp.constitution}），未失去行动。`);
      return;
    }
    msg(`⚠ ${target.name} 的胸部贯穿 CON属性未知，无法结算失能检定；不附加失能状态。`);
  }

  /**
   * 攻击要打**指定的**目标。
   *
   * ⚠ 原先这里是 `enemies[Math.floor(Math.random() * enemies.length)]` ——
   *   完全无视 `intent.target`。场上两个敌人时，「攻击哥布林」有一半概率
   *   砍在另一个身上，而播报还写着你打的是哥布林。
   */
  private pickTarget(intent: ActionIntent, enemies: WorldEntity[]): WorldEntity | undefined {
    if (enemies.length === 0) return undefined;
    const want = intent.target?.trim();
    if (want) {
      const hit = enemies.find((e) => e.id === want || e.name === want)
        ?? enemies.find((e) => e.name.includes(want) || want.includes(e.name));
      if (hit) return hit;
    }
    return enemies[0];
  }

  /**
   * 敌人还手。
   *
   * ⚠ 接这个之前，**这条路上的战斗是单向的**：实测打十回合，
   *   玩家 9/9 一滴血没掉，怪物只挨打。
   *   也就是说这一轮修好的重伤判定、流血、致残描写，**全都只对怪物生效** ——
   *   玩家永远不会受伤，战斗没有风险。
   *
   *   CLI 那边一直有 `resolveNPCAction()`（index.ts:750），走的是共用的
   *   律书 `rules.adjudicateAttack`。这里不另写一份判定，调同一个入口 ——
   *   这个仓库反复在修的病就是「两份实现各自漂移」。
   *
   *   技能推定沿用 CLI 的口径（有武器 40%、徒手 30%）。这两个数字原先
   *   只写在 index.ts 里，现在两处都要用，所以提成常量放在这里，
   *   并在 CLI 侧注明出处，免得哪天一边改了另一边不知道。
   */
  /**
   * 当前场景里还活着的敌人。战斗旗、还手、退出战斗、自由行动战斗判定
   * 四处共用一份判断。
   *
   * ⚠ 此前不按场景过滤，只看 hp>0——玩家换了场景，上一个场景的敌人还会
   *   继续应战/被选为攻击目标。实跑症状：人已经在「加比的拖车房」，还在
   *   连续播报「酒吧保镖 向你扑来」。
   *
   *   场景归属的权威字段是 `scene_id`（见 types.ts 对 WorldEntity.position
   *   的注释：position 语义不唯一，同伴系统会往里写战斗距离而不是场景），
   *   但历史数据和部分测试夹具的实体只设置了 `position`、没设置
   *   `scene_id`。`scene_id ?? position` 兜底，不让这批老数据整批从
   *   "当前敌人"里消失——两个字段在正常写入路径下取值一致
   *   （mythos-module.ts 的 NPC/生物放置两个字段一起写）。
   *
   *   `pos === "unknown"` 时不过滤：没加载模组、没显式切过场景的会话，
   *   `getDisplayedScene()` 恒为 "unknown"（`scenes` 表里没有 `is_active=1`
   *   的行），而大量既有测试夹具把敌人放在约定俗成的占位场景名（如
   *   "tavern"）却从没真的注册/激活那个场景——如果这里强制按场景比对，
   *   这批实体会在"场景系统压根没启动"的情况下被误判成"不在当前场景"，
   *   整批从敌人名单里消失。场景系统真正在用（模组加载、显式移动过）时，
   *   `pos` 不会是 "unknown"，过滤照常生效。
   */
  private aliveEnemies(): WorldEntity[] {
    const state = this.#worldRaw.getCurrentState();
    const pos = this.#displayedSceneProjection();
    return Object.values(state.entities).filter((e) => {
      if (!((e.type === "monster" || e.type === "npc") && (e.hp ?? 0) > 0)) return false;
      if (e.status.includes("narrative_noncombat")) return false;
      if (pos === "unknown") return true;
      return (e.scene_id ?? e.position) === pos;
    });
  }

  private async npcCounterAttack(intent: ActionIntent, msg: (s: string) => number): Promise<void> {
    if (!this.#combatActiveRaw) return;
    const state = this.#worldRaw.getCurrentState();
    const enemies = this.aliveEnemies();
    if (enemies.length === 0) return;
    const attacker = this.pickTarget(intent, enemies); // 谁被打就谁还手
    if (!attacker) return;

    const player = state.entities[this.#activePlayerId];
    if (!player || player.hp <= 0) return;            // 已经倒下的人不再挨打

    const baseDodge = this.#activeCharacterRaw?.skillValues?.dodge;
    const dodgeTarget = typeof baseDodge === "number" && Number.isFinite(baseDodge)
      ? this.effectiveActivePercentileTarget(baseDodge)
      : null;
    const result = this.#rulesRaw.adjudicateAttack(
      { action: "attack", target: player.id },
      {
        name: attacker.name, id: attacker.id, proficiency: 2,
        abilities: { strength: 14, dexterity: 12, constitution: 14, intelligence: 8, wisdom: 10, charisma: 6 },
        hasSneakAttack: false,
      },
      player,
      this.#activeRulesetRaw,
      false, false, undefined,
      NPC_UNARMED_SKILL,                               // 徒手 30%
      dodgeTarget,
      undefined, undefined, "dodge",
    );

    // `hit=false` is not enough: a failed NPC attack exits CoCEngine before
    // any defense die is rolled. A successful player dodge is the structured
    // combination below, never a conclusion drawn from prose. Critical
    // attacks can contain a raw defense roll but resolve as a hit, so they do
    // not count as a successful dodge use.
    const resolvedPlayerDodge = !result.hit
      && result.cocDefenseRoll !== undefined
      && result.cocDefenseSuccessLevel !== "fail"
      && result.cocDefenseSuccessLevel !== "fumble";
    if (resolvedPlayerDodge) this.markSuccessfulOrdinaryCoCSkill("dodge");

    // 武器写死"拳头"：下面这次 adjudicateAttack 传的是 NPC_UNARMED_SKILL，
    // 判定口径本身就是徒手，叙述不该暗示对方拿着武器。
    if (!result.hit) {
      const narrative = await generateNarrativeWithLLM(this.#narrativeLLM,
        attacker.name, "你", "拳头",
        { hit: false, damage: 0, result: "miss" },
        player.maxHp,
      );
      msg(resolvedPlayerDodge
        ? `${attacker.name} 向你扑来，被你躲开了。📖 ${narrative}`
        : `${attacker.name} 向你扑来，但扑了个空。📖 ${narrative}`);
      return;
    }
    // result 恒为 "wound"：CoC 里 HP 归零是昏迷/濒死，不是死亡（还能被急救
    // 拉回来），LETHAL 文案池写的是"倒下"场景，不该用在这里让玩家误以为角色死了。
    const narrative = await generateNarrativeWithLLM(this.#narrativeLLM,
      attacker.name, "你", "拳头",
      { hit: true, crit: false, damage: result.damage, result: "wound" },
      player.maxHp,
    );
    msg(`📖 ${narrative}`);
    this.resolveHit(player, result.damage, msg);       // 玩家也吃重伤/流血/致残
    this.consumeCombatFollowUp(player, result.followUp, msg);
    // CoC combatCheck 已把“腹部暴击 → 无法行动一轮”声明为结构化状态；
    // 在此消费同一结果并复用实体唯一的 status[]，不能从 details 文案猜效果。
    if (result.statusEffect && player.hp > 0) {
      player.status = player.status ?? [];
      const status = newStatus(result.statusEffect, result.statusDuration);
      player.status.push(status);
      this.#worldRaw.upsertEntity(player);
      msg(`⚠ ${attacker.name} 的攻击令你进入${status}状态。`);
    }
    if (this.#activeCharacterRaw) this.#activeCharacterRaw.hp = player.hp;
    msg(`${attacker.name} 击中了你，造成 ${result.damage} 点伤害（你剩余 ${player.hp}/${player.maxHp}）`);
    if (player.hp <= 0) {
      this.#setOrdinaryTerminal({ kind: "death" });
      msg("你倒下了。");
    }
  }

  private async handleAttack(intent: ActionIntent, msg: (s: string) => number, sourceInput?: string): Promise<boolean> {
    const fighting = this.ordinaryCoCUnarmedFightingTarget(intent, sourceInput);
    const skill = fighting ?? this.effectiveActivePercentileTarget(50);
    const enemies = this.aliveEnemies();
    const target = this.pickTarget(intent, enemies);
    const useCoCLegacyProfile = this.#activeRulesetRaw === "cosmic-horror" && !!target;
    let effectiveRoll: number;
    let luckSpendMsg = "";
    let luckSpend = 0;
    // Only a spend which was actually charged may affect the d100. The parsed
    // intent can carry luckSpend even before a character sheet exists.
    let appliedLuckSpend = 0;

    // 燃运处理
    if (intent.luckSpend !== undefined && intent.luckSpend > 0) {
      luckSpend = intent.luckSpend;
    if (this.#activeCharacterRaw && this.#activeCharacterRaw.luck !== undefined) {
      if (luckSpend > this.#activeCharacterRaw.luck) {
          // The legacy path rolled its d100 before rejecting an unaffordable
          // luck spend. Preserve that observable RNG sequence even though no
          // attack result will be committed.
          CoCEngine.skillCheck(skill);
        msg(`💫 幸运不足！当前幸运: ${this.#activeCharacterRaw.luck}，尝试消耗: ${luckSpend}`);
          return true;
        }
      this.#activeCharacterRaw.luck -= luckSpend;
        appliedLuckSpend = luckSpend;
        luckSpendMsg = ` (燃运${luckSpend})`;
      msg(`💫 消耗 ${luckSpend} 点幸运！当前: ${this.#activeCharacterRaw.luck}`);
      }
    }

    let success: boolean;
    let isCrit: boolean;
    let dmg: number;
    let statusEffect: ReturnType<RulesEngine["adjudicateAttack"]>["statusEffect"] = undefined;
    let statusDuration: ReturnType<RulesEngine["adjudicateAttack"]>["statusDuration"] = undefined;
    let followUp: ReturnType<RulesEngine["adjudicateAttack"]>["followUp"] = undefined;
    if (useCoCLegacyProfile) {
      const result = this.#rulesRaw.adjudicateAttack(
        intent,
      { name: this.#activeCharacterRaw?.name ?? "调查员", id: this.#activePlayerId, proficiency: 2, abilities: {}, hasSneakAttack: false },
        target!,
        "cosmic-horror",
        false,
        false,
        undefined,
        skill,
        null,
        "1d6",
        undefined,
        "dodge",
        undefined,
        undefined,
        { profile: "game-session-legacy", luckSpend: appliedLuckSpend },
      );
      effectiveRoll = result.cocRoll!;
      success = result.hit;
      isCrit = result.critical;
      dmg = result.damage;
      statusEffect = result.statusEffect;
      statusDuration = result.statusDuration;
      followUp = result.followUp;
    } else {
      effectiveRoll = Math.floor(Math.random() * 100) + 1;
      effectiveRoll = Math.max(1, effectiveRoll - appliedLuckSpend);
      success = effectiveRoll <= skill;
      isCrit = effectiveRoll <= skill * 0.05;
      dmg = success ? (isCrit ? Math.floor(Math.random() * 12) + 6 : Math.floor(Math.random() * 6) + 1) : 0;
    }
    if (success && useCoCLegacyProfile && fighting !== null) {
      this.markSuccessfulOrdinaryCoCSkill("fighting");
    }
    const isFumble = effectiveRoll > 95;
    const hitMsg = isFumble ? "大失败！" : isCrit ? "暴击" : success ? "命中" : "未命";

    msg(`⚔️ 攻击检查d100=${effectiveRoll} (目标=${skill}%)${luckSpendMsg} → ${hitMsg}${dmg > 0 ? `，造成 ${dmg} 点伤害` : ""}`);
    // 复用 aliveEnemies()（场景内、hp>0）而不是自己单开一份不按场景过滤的
    // filter——否则玩家在拖车房，"攻击"命令还能打中酒吧那边的保镖。
    if (target) {
      const weapon = intent.weapon || "拳头";
      if (dmg > 0) {
        const narrative = await generateNarrativeWithLLM(this.#narrativeLLM,
          "你", target.name, weapon,
          { hit: true, crit: isCrit, damage: dmg, result: target.hp - dmg <= 0 ? "kill" : "wound" },
          target.maxHp,
        );
        msg(`📖 ${narrative}`);
        this.resolveHit(target, dmg, msg);
        this.consumeCombatFollowUp(target, followUp, msg);
        if (statusEffect && target.hp > 0) {
          target.status = target.status ?? [];
          const status = newStatus(statusEffect, statusDuration);
          target.status.push(status);
          this.#worldRaw.upsertEntity(target);
          msg(`⚠ 你的攻击令 ${target.name} 进入${status}状态。`);
        }
        msg(`${target.name} 剩余 HP: ${target.hp}/${target.maxHp}`);
      } else {
        const narrative = await generateNarrativeWithLLM(this.#narrativeLLM,
          "你", target.name, weapon,
          { hit: false, damage: 0, result: "miss" },
          target.maxHp,
          { fumble: isFumble },
        );
        msg(`📖 ${narrative}`);
      }
    }
    // ⚠ `combatActive = true` 原先**只写在 `act()` 里那段被遮死的代码**（L1199），
    //   而意图派发抢在它前面 return —— 于是这面旗在真实路径上**永远是 false**。
    //   看得见的症状：`getSuggestions()` 打起来了还在提示「调查四周 / 与 NPC 交流」。
    this.#combatActiveRaw = this.aliveEnemies().length > 0;
    await this.npcCounterAttack(intent, msg);
    // 打完最后一个敌人就退出战斗，否则这面旗立起来就再也放不下
    if (this.aliveEnemies().length === 0) this.#combatActiveRaw = false;
    this.#lastDiceRoll = { expr: `d100${luckSpendMsg}`, total: effectiveRoll };
    this.#lastNarrative = `你向敌人发起了攻击！${hitMsg}`;
    return true;
  }

  // ── 创建角色 ──
  private handleCreateCharacter(input: string, msg: (s: string) => number): boolean {
    // 解析 "创建角色 [archetype] [name]"
    const command = parseCharacterCreation(input);
    if (command === null) {
      msg("请指定职业和姓名。用法：创建角色 <职业ID> <姓名>\n可用职业请查看「职业列表」");
      this.#lastNarrative = "请指定职业";
      return true;
    }
    const { archetypeId, characterName: charName } = command;
    try {
      const ch = buildCharacterForRuleset(charName, archetypeId, this.#activeRulesetRaw, this.#characterRandomUnit);
      // "创建角色"没有指定要建哪个 pcId——语义是"重建**当前活跃**的 PC"，
      // 不是"总是重建 p1"。activePlayerId 默认就是 "p1"，单人局行为不变；
      // 多人局里如果切换到了 p2 再执行这条命令，重建的是 p2，不会误伤 p1。
      // 走统一入口：八件事一次做齐，包含此前这里完全没做的
      // SanityEngine 重建——这正是本轮要修的活 bug（新角色沿用旧角色的
      // maxSAN，因为这里从没调用过 sanityEngines.set）。
      const result = this.#createPartyMember(this.#activePlayerId, ch);
      if ("rejected" in result) {
        // 只有硬上限（10 人）才会走到这里；"重建现有 pcId" 不受人数检查
        // 影响（#createPartyMember 内部对已存在的 pcId 直接放行），所以这
        // 分支理论上不会在"创建角色"命令上触发，防御性处理，不静默吞掉。
        msg(`创建失败：${result.rejected}`);
        this.#lastNarrative = "角色创建失败";
        return true;
      }
      this.#installActiveCharacter(result.member.sheet);
    this.#installSanityEngine(result.member.san);
      // 扮演元数据：只有 p1 可能带着建会话时的 HTTP persona（见 p1Persona
      // 字段注释）；其余 PC（多人局切到 p2 再"创建角色"重建）没有这层，
      // 直接落 backgroundProfile 推导。走同一个 resolveMeta，不因为这里是
      // 文本命令就另起一份内联调用（构造函数/addPartyMember 同理）。
      result.member.meta = this.resolveMeta(
        this.#activePlayerId === "p1" ? this.#p1Persona : undefined,
        result.member.sheet,
      );
      if (result.warning) msg(`⚠️ ${result.warning}`);
      msg(`角色创建完成！${charName}（${archetypeId}）已就绪。HP:${ch.hp}, SAN:${this.#sanityRaw.state.currentSAN}`);
      this.#lastNarrative = `角色创建完成: ${charName}。`;
    } catch (e) {
      if (e instanceof CharacterEntropyError) throw e;
      msg(`创建失败: ${(e as Error).message}。请检查职业名称是否正确。`);
      this.#lastNarrative = "角色创建失败";
    }
    return true;
  }

  // ── 职业列表 ──
  private handleListOccupations(msg: (s: string) => number): boolean {
    if (this.#activeRulesetRaw !== "cosmic-horror") {
      msg("当前不是宇宙恐怖模式");
      this.#lastNarrative = "当前不是宇宙恐怖模式";
      return true;
    }
    try {
      const archetypes = CharacterFactory.listArchetypes(this.#activeRulesetRaw);
      const occupations = archetypes.filter(a => !a.isPrestige).slice(0, 20);
      const lines = ["【调查员职业列表", ""];
      for (const a of occupations) {
        lines.push(`  ${a.id.padEnd(20)} — ${a.label ?? a.id}`);
      }
      const text = lines.join("\n");
      msg(text);
      this.#lastNarrative = text;
    } catch {
      msg("职业列表: 考古学家, 医生, 记者, 侦探, 教授, 士兵, 艺术家, 流浪者, 工程师, 律师, 警察, 牧师");
      this.#lastNarrative = "调查员职业: 考古学家, 医生, 记者, 侦探...";
    }
    return true;
  }

  // ── 购买 ──
  #buyUnavailableMessage(intent: ActionIntent): string {
    return intent.item?.trim()
      ? "这里没有可以交易的地方。（商店尚未实现）"
      : "你想买什么？请指定物品名称";
  }

  private handleBuy(intent: ActionIntent, msg: (s: string) => number): boolean {
    const text = this.#buyUnavailableMessage(intent);
    msg(text);
    this.#lastNarrative = text;
    return true;
  }

  // ── 出售 ──
  /**
   * ⚠ 原先这里**从不查背包**，一律回「你的背包中没有「X」」——
   *   哪怕你正拿着它。而 `world.getPlayerInventory()` 就在手边，
   *   `handleInventory` 用的就是它。
   *
   *   「没做商店」和「骗玩家说他没有这东西」是两回事：
   *   前者玩家能理解，后者会让他以为自己记错了、或者以为背包丢了东西。
   *   没有商店就直说没有商店。
   */
  #sellUnavailableMessage(intent: ActionIntent, actorId: string): string {
    const item = intent.item?.trim();
    if (!item) return "你想卖什么？请指定物品名称";
    const inv = this.#worldRaw.getPlayerInventory(actorId);
    const idx = inv.findIndex((i) => i === item || i.includes(item));
    if (idx < 0) return `你的背包中没有「${item}」。当前背包：${inv.length ? inv.join("、") : "空"}`;
    // 东西确实在背包里。这里**还没有商店**（没有商人、没有价格、没有钱袋），
    // 所以不能假装卖掉 —— 但也绝不能说「你没有」。
    return `你有「${inv[idx]}」，但这里没有人收货。`;
  }

  private handleSell(intent: ActionIntent, msg: (s: string) => number): boolean {
    const text = this.#sellUnavailableMessage(intent, this.#activePlayerId);
    msg(text);
    this.#lastNarrative = text;
    return true;
  }

  // ── 传承 ──
  private handleLegacy(input: string, msg: (s: string) => number): boolean {
    if (isLegacySaveCommand(input)) {
      if (!this.#activeCharacterRaw) {
        msg("没有活跃角色可保存");
        this.#lastNarrative = "没有活跃角色";
        return true;
      }
      const c = this.#activeCharacterRaw;
      this.#persistCareerSnapshot(c, this.#sanityRaw);
      msg(`角色「${c.name}」已保存。`);
      this.#lastNarrative = `角色「${c.name}」已保存。`;
      return true;
    }
    const legacyLoad = parseLegacyLoad(input);
    if (input.includes("传承列表") || legacyLoad !== null) {
      const careerStore = this.#ensureCareerStore();
      if (legacyLoad !== null) {
        const charName = legacyLoad.characterName;
        if (!charName) {
          msg("请指定要加载的角色名");
          this.#lastNarrative = "请指定角色名";
          return true;
        }
        const snap = careerStore.getSnapshot(charName);
        if (!snap) {
          msg(`未找到角色「${charName}」。`);
          this.#lastNarrative = `未找到角色「${charName}」。`;
          return true;
        }
        msg(`角色「${charName}」已加载。(HP:${snap.hp}, SAN:${snap.san})`);
        this.#lastNarrative = `角色「${charName}」已加载。`;
        return true;
      }
      const chars = careerStore.listCharacters();
      if (chars.length === 0) {
        msg("暂无已保存的角色");
        this.#lastNarrative = "暂无已保存的角色";
      } else {
        msg("已保存的角色: " + chars.join(", "));
        this.#lastNarrative = `已保存的角色: ${chars.join(", ")}。`;
      }
      return true;
    }
    // 默认传承说明
    const helpText = [
      "【传承系统",
      "跨模组角色成长追踪系统",
      "",
      "命令:",
      "  保存角色 — 保存当前角色快照",
      "  传承列表 — 查看已保存的角色",
      "  读档 <角色名> — 加载已保存的角色",
    ].join("\n");
    msg(helpText);
    this.#lastNarrative = helpText;
    return true;
  }

  // ── 生成故事 ──
  private handleGenerateStory(msg: (s: string) => number): boolean {
    return this.installGeneratedStory(msg);
  }

  /** Install one generated story through the same package dispatcher as every runtime ModuleData module. */
  private installGeneratedStory(msg: (s: string) => number): boolean {
    if (this.#compiledModule || this.#registeredModules.length > 0 || this.#loadedModules.size > 0) {
      msg("当前会话已有已安装模组，不能用生成故事替换或混合来源。");
      this.#lastNarrative = "生成故事被拒绝：会话已有已安装模组";
      return true;
    }

    let module: RuntimeModuleData;
    try {
      // The conversion reuses the existing runtime-module validator. No world,
      // registry, or host state is touched until this pure step succeeds.
      module = generatedStoryToRuntimeModuleData(this.#storyGenerator.generate());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      msg(`生成故事未安装：生成结果未通过运行包校验（${detail}）。`);
      this.#lastNarrative = "生成故事未安装：运行包校验失败";
      return true;
    }

    try {
      const installed = this.#installRuntimeModulePackage(runtimeModuleDataLegacyPackage(module));
      if (installed.kind !== "runtime_module_data_legacy") throw new Error("generated story dispatched a non-runtime package");
      if (!installed.entryScene || !this.movePlayerToScene(installed.entryScene)) {
        throw new Error(`generated story entry scene could not be activated: ${installed.entryScene ?? "<none>"}`);
      }
    this.#loadedModules.set(module.id, true);
    this.#registeredModules.push(module);
      this.capturePublishedOrdinaryModuleStarts();
      this.#lastNarrative = `新故事已生成并安装: ${module.title}`;
      const sceneNames = installed.module.scenes.map((scene) => scene.name);
      const sceneSummary = sceneNames.slice(0, 8).join("、")
        + (sceneNames.length > 8 ? ` 等 ${sceneNames.length} 个场景` : "");
      msg(`📖 新故事已生成: ${module.title}\n${module.summary}\n场景: ${sceneSummary}`);
      return true;
    } catch (error) {
      // The existing ModuleDataRuntimeLoader invokes host callbacks. It has no
      // transaction contract across world/NPC/registry stores, so a failure is
      // fail-stopped rather than exposed as a half-installed story.
      // This runs inside a public direct action. Mark the action path as
      // fail-stopped before releasing the stores so `act()` can preserve this
      // causal installation error instead of mistaking its own close for an
      // external lifecycle race.
      this.#failStopDirectAction();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`generated story installation failed closed: ${detail}`);
    }
  }

  // ── 加载模组 ──
  #registerRichModuleClue(sceneId: string, clue: Clue, sanCost?: string): void {
    const skillMethods = clue.findMethods.filter((method) => method.type === "skill" && method.skillName);
    const nonAttribute = skillMethods.find((method) => SKILL_NAME_MAP[method.skillName!]);
    const chosen = nonAttribute ?? skillMethods[0];
    const skillKey = chosen
      ? (SKILL_NAME_MAP[chosen.skillName!] ?? GameSession.BARN_CLUE_ATTRIBUTE_SKILLS[chosen.skillName!] ?? "spot_hidden")
      : "spot_hidden";
    this.#investigationRaw.addClueType(clue.id, {
      description: clue.description,
      scene: sceneId,
      matchTexts: [clue.name, ...clue.findMethods.map((method) => method.description), ...(clue.matchTexts ?? [])],
      displayName: clue.name,
      importance: clue.importance,
      unlocks: clue.unlocks,
      ...(sanCost ? { san_cost: sanCost } : {}),
      coc_primary: {
        skill: skillKey,
        regular: clue.revelation,
        hard: clue.revelation,
        extreme: clue.revelation,
        critical: clue.revelation,
        fail: "你仔细搜查了一番，但这次没能看出什么名堂。",
      },
    });
  }

  /** Narrow loader callback: only a validated declaration can place a readable tome. */
  #registerModuleTome(tome: RuntimeModuleTome): void {
    const declaration = normalizeRuntimeModuleTome(tome);
    // The array is copied before the top-level definition is sealed; it is
    // never exposed from the private registry, so the source module retains
    // no alias into session authority.
    const normalized: Readonly<RuntimeModuleTome> = Object.freeze({ ...declaration, spells: [...declaration.spells] });
    const previous = this.#moduleTomes.get(normalized.name);
    if (previous) {
      if (!sameRuntimeModuleTome(previous, normalized)) {
        throw new Error(`runtime tome declaration conflicts for ${normalized.name}`);
      }
      return;
    }
    const items = this.#sceneItems.get(normalized.sceneId) ?? [];
    if (!items.includes(normalized.name)) items.push(normalized.name);
    this.#sceneItems.set(normalized.sceneId, items);
    this.#moduleTomes.set(normalized.name, normalized);
  }

  #moduleDataRuntimeHost(): ModuleDataRuntimeHost {
    const addTurnMessage = (speaker: string, content: string, type: MessageType, verbatim = false) => {
    if (this.#turnMessages) {
      this.#turnMessages.push({ speaker, content, type, ...(verbatim ? { verbatim: true as const } : {}) });
      } else {
        this.#addMessageCanonical(speaker, content, type, { ...(verbatim ? { verbatim: true } : {}) });
      }
    };
    return {
      registerScene: (scene) => {
        this.#worldRaw.registerScene(scene.id, scene.name, scene.description);
        this.#worldRaw.setSceneEnvironment(scene.id, scene.lighting, scene.dangers);
        this.#worldRaw.setSceneExits(scene.id, scene.exits);
        this.#sceneDisplayNames[scene.id] = scene.name;
        this.#sceneAliases[scene.id] = [scene.name];
      },
      registerRuntimeNpc: (npc, runtime) => {
        // ModuleData runtime values are the explicit encounter contract. The
        // generic creature catalogue may inform other systems, but cannot
        // overwrite this module's HP, AC, name, faction, or attributes.
        // WorldEntity has no skills/abilities/tactics columns, so this loader
        // neither persists nor substitutes those fields from generic lore.
        this.#worldRaw.upsertEntity({
          id: runtime.sourceId,
          name: runtime.sourceName,
          type: runtime.type,
          hp: runtime.hp,
          maxHp: runtime.maxHp,
          ac: runtime.ac,
          status: runtime.status ? [...runtime.status] : [],
          position: runtime.sceneId,
          scene_id: runtime.sceneId,
          faction: runtime.faction,
          attributes: runtime.attributes ?? {},
        });
        // ModuleDataRuntimeLoader validates this nested runtime snapshot's
        // name/scene binding before any host callback.  The enclosing NPC is
        // therefore the only canonical factual source for this agent.  Pass
        // its array verbatim, including [], instead of merging runtime or
        // YAML profile knowledge; secrets remain on their existing private
        // personality channel and never enter `knowledge`.
        this.#registerModuleNPCPersonality(
          runtime.sourceName,
          runtime.personality,
          runtime.npcPersonalityId,
          npc.knowledge,
        );
      },
      registerNarrativeNpc: (npc) => {
        // No hp/ac/skills are supplied here. World storage has placeholders,
        // but the explicit status makes this a non-combat narrative entity.
        this.#worldRaw.upsertEntity({
          id: npc.id,
          name: npc.name,
          type: "npc",
          status: ["narrative_noncombat"],
          position: npc.sceneId,
          scene_id: npc.sceneId,
        });
        this.#registerModuleNPCPersonality(npc.name, {
          role: npc.role,
          personality: npc.personality.traits.join("、"),
          background: npc.description,
          knowledge: npc.knowledge,
          secrets: npc.secrets,
        });
      },
      registerRichClue: (sceneId, clue, sanCost) => this.#registerRichModuleClue(sceneId, clue, sanCost),
      registerTome: (tome) => this.#registerModuleTome(tome),
      registerItemPlacement: (item) => {
        const items = this.#sceneItems.get(item.sceneId) ?? [];
        if (!items.includes(item.name)) items.push(item.name);
        this.#sceneItems.set(item.sceneId, items);
        if (item.description) this.#moduleItemDescriptions.set(item.name, item.description);
      },
      registerRichItem: (item) => {
        const items = this.#sceneItems.get(item.sceneId) ?? [];
        if (!items.includes(item.name)) items.push(item.name);
        this.#sceneItems.set(item.sceneId, items);
        this.#moduleItemDescriptions.set(item.id, item.description);
      },
      registerSpell: (spell) => {
        if (!this.#mythosSpells.has(spell.name)) {
          this.#mythosSpells.set(spell.name, { sanCost: spell.sanCost, mpCost: spell.mpCost, description: spell.description, effect: spell.effectType });
        }
      },
      registerHook: () => {}, // hooks remain available through registeredModules for current runtime consumers.
      registerRewards: (rewards) => rewards.forEach((reward) => this.#moduleRewards.set(reward.id, reward)),
      // Snapshot envelopes canonicalize object keys. Sorting here gives the
      // ordered state projection the same identity for an interactive source
      // object and its canonical JSON re-installation.
      registerKpNotes: (notes) => Object.keys(notes).sort().forEach((key) => this.#moduleKpNotes.set(key, notes[key]!)),
      registerSceneBgm: (bgm) => Object.assign(this.#sceneBgm, bgm),
      registerSceneAliases: (aliases) => {
        for (const [sceneId, values] of Object.entries(aliases)) {
          const current = this.#sceneAliases[sceneId] ?? [];
          for (const alias of values) if (!current.includes(alias)) current.push(alias);
          this.#sceneAliases[sceneId] = current;
        }
      },
      applyInitialEffects: () => {}, // 当前谷仓为空；字段由 direct loader 显式读取，行为留给后续通用世界状态规则。
      addIntroNarration: (text) => addTurnMessage("KP", text, "narration", true),
    };
  }

  #legacyModuleLoader(): MythosModuleLoader {
    if (!this.#moduleLoader) {
      const worldAdapter: MythosModuleHost["world"] = {
        upsertEntity: (entity) => this.#worldRaw.upsertEntity(entity),
        // 模组要靠它连接场景出口；不转发的话出口构建会整段失败。
        getDatabase: () => this.#worldRaw.getDatabase(),
      };
      const host: MythosModuleHost = {
        registerSpell: (spell) => {
          if (this.#mythosSpells.has(spell.name)) return false;
          this.#mythosSpells.set(spell.name, {
            sanCost: spell.sanCost,
            mpCost: spell.mpCost,
            description: spell.description,
            effect: spell.effectType,
          });
          return true;
        },
        registerTome: (tome) => this.#registerModuleTome(tome),
        sceneItems: this.#sceneItems,
        itemDescriptions: new Map<string, string>(),
        world: worldAdapter,
        // 优先投进本回合：回合出口会统一把 turnMessages 写入历史，
        // 这里再直接写一次历史就会重复。不在回合内时（理论上不会发生）
        // 退回直接写历史，至少不丢消息。
        addMessage: (speaker, content, type, opts) => {
    const turn = this.#turnMessages;
          if (!turn) { this.#addMessageCanonical(speaker, content, type, opts); return; }
          turn.push({
            speaker, content, type,
            ...(opts?.verbatim ? { verbatim: true as const } : {}),
            ...(opts?.mood ? { mood: opts.mood } : {}),
          });
        },
        activeRuleset: this.#activeRulesetRaw,
        currentRound: this.#roundRaw,
        // 读取模块：将模组原文场景描写写入 scenes 表（保留原文，供 KP 上下文注入）
        registerScene: (sceneId: string, displayName: string, description?: string) => {
          this.#worldRaw.registerScene(sceneId, displayName, description);
        },
        // 读取模块：将模组线索注册进调查引擎（供场景线索注入）
      registerSceneClue: (sceneName: string, clueType: string, description?: string, sanCost?: string) => {
        this.#investigationRaw.registerSceneClue(sceneName, clueType, description, sanCost);
      },
        // 读取模块：将模组 NPC 内联人格注册进私有 NPC Agent 系统，供会话内对话调用。
        registerNPCPersonality: (npcName: string, personality: RuntimeNpcPersonality | undefined, npcPersonalityId?: string) => {
          this.#registerModuleNPCPersonality(npcName, personality, npcPersonalityId);
        },
      };
      this.#moduleLoader = new MythosModuleLoader(host);
    }

    if (!this.#moduleLoader) throw new Error("Module loader not initialized");
    return this.#moduleLoader;
  }

  /**
   * The production route passes the already-validated local command.  Keeping
   * the exact-string branch preserves legacy direct helper callers without
   * granting a second, prefix-based command grammar.
   */
  private handleLoadModule(
    command: Extract<OrdinaryLocalCommand, { kind: "load_module" }> | string,
    msg: (s: string) => number,
  ): boolean {
    const parsed = typeof command === "string" ? parseOrdinaryLocalCommand(command) : command;
    if (parsed?.kind !== "load_module") return false;
    const moduleName = parsed.moduleName ?? "";
    // 优先从自定义模组库查"
    let mod: LoadedModule | null = moduleName ? this.moduleForLocalCommand(moduleName) : null;
    if (moduleName) {
      const customMod = getCustomModule("premiers_barn");
      if (customMod && (customMod.name === moduleName || (isModuleData(customMod.module) ? customMod.module.title : customMod.module.name) === moduleName)) {
        mod = customMod.module;
      }
    }
    // 回退到内置模"
    if (!mod && moduleName) {
      const builtinModules: Record<string, MythosModule> = {
        "阿卡姆档案检查": ARKHAM_LIBRARY_MODULE,
        "印斯茅斯的阴影": INNSMOUTH_MODULE,
      };
      mod = builtinModules[moduleName];
    }
    // 列出所有可用模"
    const allModules: Record<string, LoadedModule | null> = {
        "普瑞米尔的谷仓": mod,
        "阿卡姆档案检查": ARKHAM_LIBRARY_MODULE,
        "印斯茅斯的阴影": INNSMOUTH_MODULE,
    };
    if (!mod && moduleName) {
      const available = Object.keys(allModules).join(", ");
      msg(`未找到模组「${moduleName}」。可用模组: ${available}`);
      this.#lastNarrative = `未找到模组「${moduleName}」。`;
      return true;
    }
    if (!mod) {
      const available = Object.keys(allModules).join(", ");
      msg(`可用模组: ${available}`);
      this.#lastNarrative = `可用模组: ${available}`;
      return true;
    }

    let legacyHostWriteAttempted = false;
    const reportModuleLoad = msg;
    msg = (text) => {
      // `#installRuntimeModulePackage` marks this only after every pure
      // package/slot check has passed and immediately before a legacy loader
      // can invoke its host. The legacy executors have no rollback API.
      if (legacyHostWriteAttempted && !this.#loadedModules.has(mod.id)) {
        // A legacy host has started mutating this direct action's runtime
        // before failing. This is an action fail-stop, not an external
        // lifecycle close: retain the causal installation error and make
        // later direct actions use the stable unavailable contract.
        this.#failStopDirectAction();
        throw new Error(`runtime module installation failed closed: ${text}`);
      }
      return reportModuleLoad(text);
    };
    try {
      const loaded = this.#loadedModules;
      if (loaded.has(mod.id)) {
        const title = isModuleData(mod) ? mod.title : mod.name;
        msg(`模组「${title}」已导入。`);
        this.#lastNarrative = `模组「${title}」已导入。`;
        return true;
      }
      const installed = this.#installRuntimeModulePackage(
        isModuleData(mod) ? runtimeModuleDataLegacyPackage(mod) : mythosLegacyPackage(mod),
        () => { legacyHostWriteAttempted = true; },
      );
      if (installed.kind === "compiled_bundle") throw new Error("interactive module command dispatched a compiled package");
      const lines = installed.lines;
      let entryScene = installed.kind === "runtime_module_data_legacy" ? installed.entryScene : undefined;
      if (installed.kind === "mythos_legacy") {
        const legacyModule = installed.module;
        if (legacyModule.sceneBgm) Object.assign(this.#sceneBgm, legacyModule.sceneBgm);
        for (const r of this.#worldRaw.listScenes()) {
          if (!r.name || r.name === "unknown") continue;
          this.#sceneDisplayNames[r.id] = r.name;
          if (r.description.length > 0) this.#sceneAliases[r.id] = [r.name];
        }
        if (legacyModule.sceneAliases) {
          for (const [sceneId, aliases] of Object.entries(legacyModule.sceneAliases)) {
            const current = this.#sceneAliases[sceneId] ?? [];
            for (const alias of aliases) if (!current.includes(alias)) current.push(alias);
            this.#sceneAliases[sceneId] = current;
          }
        }
        entryScene = legacyModule.sceneDescriptions
          ? Object.keys(legacyModule.sceneDescriptions).find((key) => key !== "unknown")
          : Object.keys(this.#sceneDisplayNames)[0];
      }
      const pos = this.#playerPositionProjection();
      if ((!pos || pos === "unknown" || pos === "tavern") && entryScene) {
        if (!this.movePlayerToScene(entryScene)) {
          throw new Error(`模组入口场景「${entryScene}」没能激活`);
        }
      }
      // Do not publish in-memory installation state until loader side effects
      // and the entry activation have both completed.
      loaded.set(installed.module.id, true);
      this.#registeredModules.push(installed.module);
      this.capturePublishedOrdinaryModuleStarts();
      const resultText = lines.join("\n");
      msg(resultText);
      this.#lastNarrative = `已加载模组: ${isModuleData(mod) ? mod.title : mod.name}`;
    } catch (e) {
      msg(`模组加载失败: ${(e as Error).message}`);
      this.#lastNarrative = `模组加载失败。`;
    }
    return true;
  }

  /**
   * BARN findMethod attribute labels map to InvestigationEngine proxy keys.
   * activeInvestigationCheckValues resolves them from canonical luck and
   * attributes for the transient check projection. Rich clues with an
   * ordinary skill still select that skill before this map is consulted.
   */
  private static readonly BARN_CLUE_ATTRIBUTE_SKILLS: Record<string, string> = {
    "幸运": "luck",
    "力量": "strength",
  };


  // ── 模组结算/技能成长 ──
  private handleSkillAdvancement(_messages: AgentMessage[], msg: (s: string) => number): boolean {
    const module = this.publishedOrdinaryModuleForSettlement();
    // This guard deliberately precedes the no-growth hint. A natural-language
    // settlement request without a real module must never look like a valid,
    // merely empty settlement, and it must leave all pending state untouched.
    if (!module) {
      const text = "模组结算已拒绝：没有可验证的已发布普通模组，成长记录已保留。";
      msg(text);
      this.#lastNarrative = text;
      return true;
    }

    // Natural-language "模组结算" / "技能成长" is never an independent
    // commit protocol. It means the party is asking to leave; only the next
    // explicit confirmation reaches resolveModuleDeparture and its shared
    // owner-scoped growth core.
    this.#pendingLeaveConfirm = true;
    const text = "模组结算需要先确认离开。你确定要离开这里吗？这会结束这次调查。（回复「确定」继续，其它任何话都视为取消）";
    msg(text);
    this.#lastNarrative = text;
    return true;
  }

  // ── 施法 ──
  private handleCast(intent: ActionIntent, msg: (s: string) => number): boolean {
    if (intent.action === "occult_cast" && this.#activeRulesetRaw !== "cosmic-horror") {
      msg("神话法术仅支持宇宙恐怖模式");
      this.#lastNarrative = "神话法术仅支持宇宙恐怖模式";
      return true;
    }
    if (!this.#activeCharacterRaw) {
      msg("你还没有创建角色");
      this.#lastNarrative = "你还没有创建角色";
      return true;
    }
    if (this.#activeRulesetRaw === "cosmic-horror") {
      const spellName = (intent.spell ?? intent.target ?? "").trim();
      const spell = this.#mythosSpells.get(spellName);
      if (!spellName || !this.#knownMythosSpells.includes(spellName) || !spell) {
        msg("你尚未学会该神话法术。阅读神话典籍可以领悟法术");
        this.#lastNarrative = "你尚未学会该神话法术";
        return true;
      }
      msg(`你尝试施展「${spellName}」……`);
      this.#lastNarrative = `你尝试施展「${spellName}」。`;
      return true;
    }
    // D&D cast
    const spellName = intent.spell ?? intent.target ?? "法术";
    msg(`你施展了${spellName}！」`);
    this.#lastNarrative = `你施展了${spellName}」。`;
    return true;
  }

  /**
   * Preserve the model's explicit `item` field.  Offline fallback receives no
   * permission to derive an item from arbitrary words: only a complete pickup
   * command with one of the parser-recognized prefixes supplies a name.
   */
  private pickupItemName(intent: ActionIntent, input: string): string | null {
    if (typeof intent.item === "string" && intent.item.trim().length > 0) return intent.item.trim();
    const matched = /^(?:捡起|捡|拾取|拿起|拿走)\s*(\S(?:.*\S)?)\s*$/.exec(input);
    return matched?.[1]?.trim() || null;
  }

  /**
   * Transfer one installed package item from the active scene to the active
   * player's WorldState inventory.  The world write is deliberately committed
   * before private placement removal: the two stores have no shared
   * transaction contract, so a thrown world write leaves the scene untouched
   * rather than reporting a fictional cross-store atomic transfer.
   */
  private handlePickup(intent: ActionIntent, input: string, msg: (s: string) => number): boolean {
    const name = this.pickupItemName(intent, input);
    if (!name) {
      msg("无法捡起物品：请明确指定已声明物品的完整名称。");
      return true;
    }
    const origin = this.#modulePickupOrigins.get(name);
    if (!origin) {
      msg(`无法捡起「${name}」：它不是当前已安装模组声明的可拾取物品。`);
      return true;
    }

    const player = this.#worldRaw.getEntity(this.#activePlayerId);
    const sceneId = typeof player?.position === "string" && player.position.trim().length > 0
      ? player.position
      : null;
    if (!sceneId) {
      msg(`无法捡起「${name}」：当前角色没有可验证的位置。`);
      return true;
    }
    if (sceneId !== origin.sceneId) {
      msg(`无法捡起「${name}」：它不在你当前场景。`);
      return true;
    }
    const placed = this.#sceneItems.get(sceneId) ?? [];
    if (!placed.includes(name)) {
      msg(`无法捡起「${name}」：该物品当前不在这个场景中。`);
      return true;
    }
    const inventory = this.#worldRaw.getPlayerInventory(this.#activePlayerId);
    if (inventory.includes(name)) {
      msg(`无法捡起「${name}」：它已经在你的背包中。`);
      return true;
    }

    try {
      this.#worldRaw.setPlayerInventory(this.#activePlayerId, [...inventory, name]);
    } catch (error) {
      msg(`无法捡起「${name}」：背包写入失败，物品仍留在原处。`);
      return true;
    }
    this.#sceneItems.set(sceneId, placed.filter((item) => item !== name));
    const text = `你捡起了「${name}」。`;
    msg(text);
    this.#lastNarrative = text;
    return true;
  }

  // ── 阅读典籍 ──
  private handleRead(input: string, msg: (s: string) => number): boolean {
    const tomeName = input.replace(/^(?:阅读|读|翻阅)\s*/, "").trim();
    const tome = this.#moduleTomes.get(tomeName);
    if (!tome) {
      const text = `无法阅读「${tomeName}」：没有已安装模组声明这本典籍。`;
      msg(text);
      this.#lastNarrative = text;
      return true;
    }

    // Player position and possession are runtime facts owned by WorldStateManager.
    // Do not infer either from a parsed target or the declaration's sceneId.
    const player = this.#worldRaw.getEntity(this.#activePlayerId);
    const playerScene = typeof player?.position === "string" && player.position.trim().length > 0
      ? player.position
      : null;
    const inInventory = this.#worldRaw.getPlayerInventory(this.#activePlayerId).includes(tome.name);
    const inCurrentScene = playerScene === tome.sceneId
      && (this.#sceneItems.get(playerScene) ?? []).includes(tome.name);
    if (!inInventory && !inCurrentScene) {
      const text = `无法阅读「${tome.name}」：它不在你当前场景或背包中。`;
      msg(text);
      this.#lastNarrative = text;
      return true;
    }

    msg(`📖 ${tome.openDescription}`);

    // SAN 检查
    const result = this.#sanityRaw.sanityCheck(tome.sanCost);
    const passed = result.passed;
    const sanLoss = result.sanLoss;
    const roll = result.roll;
    msg(`🧠 阅读${tomeName}」SAN 检查 d100=${roll} (目标=${this.#sanityRaw.state.currentSAN}) ${passed ? "通过" : "失败"}！SAN -${sanLoss} (剩余: ${this.#sanityRaw.state.currentSAN})`);

    // CM 成长由 SAN 引擎统一处理：封顶、maxSAN/currentSAN 与日志必须同一事务更新。
    const mythosResult = this.#sanityRaw.learnCthulhuMythos(tome.tomeRating, tome.name);
    msg(`📖 克苏鲁神话技能提升+${mythosResult.cmGain}%`);

    // 法术学习
    const learnedSpells: string[] = [];
    for (const spell of tome.spells) {
      // A tome only grants knowledge of a spell its installed module defines.
      // Never manufacture a castable definition from a tome name.
      if (!this.#mythosSpells.has(spell)) continue;
      const learnRoll = Math.floor(Math.random() * 100) + 1;
      const learnTarget = Math.min(99, this.#sanityRaw.state.cthulhuMythos ?? 10);
      if (learnRoll <= learnTarget && !this.#knownMythosSpells.includes(spell)) {
        this.#knownMythosSpells.push(spell);
        learnedSpells.push(spell);
      }
    }

    if (learnedSpells.length > 0) {
      msg(`🎉 你领悟了新法术: ${learnedSpells.join(", ")}`);
    } else if (tome.spells.some((spell) => this.#mythosSpells.has(spell))) {
      msg("你未能领悟任何法术，也许下次会有不同的领悟");
    }

    this.#lastNarrative = `你阅读了${tome.name}」，SAN -${sanLoss}，克苏鲁神话技能+${mythosResult.cmGain}%。`;
    return true;
  }

  // ── 急救 ──
  private handleFirstAid(msg: (s: string) => number): boolean {
    if (!this.#activeCharacterRaw) {
      msg("你还没有创建角色");
      this.#lastNarrative = "你还没有创建角色";
      return true;
    }
    const c = this.#activeCharacterRaw;
    // CoC 角色卡的标准键是 first_aid。medicine 是兼容旧卡时的回退，绝不能
    // 覆盖一张已经给出 first_aid 的卡；否则「急救」会暗中按医学值裁决。
    const firstAidSource = resolveFirstAidSkillSource(c);
    // Keep the mark key coupled to the score actually used above.  `medicine`
    // is a legacy-sheet fallback only when first_aid is absent; a Chinese
    // display fallback has no canonical CoC storage key and cannot grow.
    const usedCoCSkill = firstAidSource.canonicalSkill;
    const baseFirstAidSkill = firstAidSource.baseScore;
    const firstAidSkill = this.effectiveActivePercentileTarget(baseFirstAidSkill);
    // act() 已在派发前推进实体上的流血状态；治疗只能从同一实体接着结算，
    // 不能凭角色卡缓存造出或覆盖一份独立的 HP 真相源。
    const player = this.#worldRaw.getEntity(this.#activePlayerId);
    if (!player || !Number.isFinite(player.hp) || !Number.isFinite(player.maxHp) || player.maxHp < 0 || !Array.isArray(player.status)) {
      const text = "急救失败：无法找到可用的当前玩家世界实体，未执行治疗。";
      msg(text);
      this.#lastNarrative = text;
      return true;
    }
    // 同步本回合已在实体上结算的状态损失不是治疗：无论检定成败，角色卡都不能
    // 继续保留 tick 前的旧 HP。实体缺失时在上面提前返回，因而不会凭缓存造状态。
    c.hp = player.hp;
    const roll = Math.floor(Math.random() * 100) + 1;
    const isFumble = roll > 95;
    // 大失败优先于普通成功比较；不能因为数据里有 100% 技能就把 d100=100
    // 的明确大失败写成“成功处理伤口”。
    const success = !isFumble && roll <= firstAidSkill;
    const resultText = isFumble ? "大失败！伤势可能加重" : success ? "成功！伤口得到了处理" : "失败，急救未能止血";

    msg(`💊 急救检查d100=${roll} (急救=${firstAidSkill}%) → ${resultText}`);
    if (success) {
      // First Aid restores exactly one HP.  Only the legacy-card Medicine
      // fallback (which is selected solely when first_aid is absent) keeps
      // Medicine's 1D3 recovery.  Local sessions do not yet model the
      // verified time, injury-age, equipment, or supply predicates needed to
      // impose Medicine's other tabletop constraints, so this branch does not
      // pretend to enforce any of them.
      const healAmount = firstAidSource.healing === "medicine_d3"
        ? Math.floor(Math.random() * 3) + 1
        : 1;
      // player.hp 已包含本回合 tick 的流血损失。用实体 maxHp 封顶，随后把同一个
      // 结果同步回角色卡；不让缓存 HP 和 API/world state 再次分叉。
      const hpBeforeTreatment = player.hp;
      const healedHp = Math.min(player.maxHp, Math.max(0, hpBeforeTreatment + healAmount));
      player.hp = healedHp;
      c.hp = healedHp;
      // status[] 是唯一状态存储。只移除 parser 明确识别的两种可止血状态，
      // 保留其它结构化状态及不属于状态库的既有裸标签。
      const statusBeforeTreatment = player.status;
      player.status = statusBeforeTreatment.filter((raw) => {
        const status = parseStatus(raw);
        return status?.id !== "bleeding" && status?.id !== "hemorrhaging";
      });
      this.#worldRaw.upsertEntity(player);
      const providedActualTreatment = healedHp > hpBeforeTreatment
        || player.status.length < statusBeforeTreatment.length;
      if (providedActualTreatment) {
        this.#woundsTreatedByPC.add(this.#activePlayerId);
        if (usedCoCSkill !== null) this.markSuccessfulOrdinaryCoCSkill(usedCoCSkill);
      }
      msg(`恢复了 ${healAmount} 点 HP (当前: ${healedHp}/${player.maxHp})，流血已止住。`);
    }
    this.#lastNarrative = `急救结果: ${resultText}。`;
    return true;
  }

  // ── 装填 ──
  /**
   * ⚠ 原先这句是「弹药已补满」——**而这一侧根本没有弹药状态**。
   *
   *   弹药系统只存在于 CLI（`src/index.ts` 的 `cocAmmo`：开火递减、
   *   打空拦截、`/reload` 补满）。走服务器/网页的这条路一格弹药都不记，
   *   开枪不消耗、装填也无从补起。两个前端两套规则。
   *
   *   在把弹药搬过来之前，这里**不能报告一件没发生的事**：
   *   玩家会据此决定要不要省子弹，而那个数字是假的。
   */
  private handleReload(intent: ActionIntent, msg: (s: string) => number): boolean {
    const weaponName = intent.weapon ?? intent.target ?? "武器";
    msg(`你检查并重新装填了「${weaponName}」。（注：本模式暂不追踪弹药消耗）`);
    this.#lastNarrative = `你装填了${weaponName}。`;
    return true;
  }

  // ── 推动检查──
  private handlePush(msg: (s: string) => number): boolean {
    if (!this.#lastPushedRoll) {
      msg("没有待推动的检定。先进行一次技能检定，失败后再使用推动");
      this.#lastNarrative = "没有待推动的检定";
      return true;
    }
    // 原先还取了 `roll: prevRoll`（推动前那一掷）却没用上 —— 播报里只报新骰。
    // 「原本 73，推动后 41」比单报一个数字有信息量，但那是文案决定；
    // 先把死绑定去掉，别让它看着像忘了拼进去。
    const { skill, target } = this.#lastPushedRoll;
    const newRoll = Math.floor(Math.random() * 100) + 1;
    const success = newRoll <= target;
    const isFumble = newRoll > 95;
    const resultText = isFumble ? "大失败！后果严重" : success ? "推动成功" : "再次失败，情况恶";
    msg(`🔄 推动检查(${skill}): d100=${newRoll} (目标=${target}%) → ${resultText}`);
    if (success) this.markSuccessfulOrdinaryCoCSkill(skill);
    this.#lastPushedRoll = null;
    this.#lastNarrative = `推动检查 ${resultText}。`;
    return true;
  }

  // ── 追逐 ──
  private handleChase(msg: (s: string) => number): boolean {
    const roll = Math.floor(Math.random() * 100) + 1;
    const baseDex = this.#activeCharacterRaw?.attributes?.dexterity ?? this.#activeCharacterRaw?.attributes?.DEX ?? 50;
    const dex = this.effectiveActivePercentileTarget(baseDex);
    const success = roll <= dex;
    const resultText = success ? "你成功拉开了距离！" : "追逐仍在继续…";
    msg(`🏃 追逐检查d100=${roll} (DEX=${dex}) → ${resultText}`);
    this.#lastNarrative = `追逐: ${resultText}`;
    return true;
  }

  // ============================================================
  // 骰子引擎
  // ============================================================

  // ============================================================
  // 传奇模板辅助
  // ============================================================

  /** 构建 LLM 传奇上下文注入 */
  private buildEpicContext(): string {
    const template = this.#activeCharacterRaw?.legendaryTemplate;
    if (!template) return "";
    const ep = template.epicNarrative ?? "";
    const showTime = template.showTime;
    const st = showTime ? `\n表演时间「${showTime.name}」：${showTime.description}（持续${showTime.duration}）` : "";
    const actions = template.legendaryActions?.map((a: LegendaryAction) =>
      `【${a.name}】${a.description}（消耗 ${a.cost} 传奇点）`
    ).join("\n") ?? "";
    return `\n\n=== 传奇角色上下文 ===\n${ep}${st}\n${actions}\n当前角色已超越凡人极限。请以匹配的史诗级别描绘其行动与叙事。`;
  }

  private execDiceExpr(expr: string): { total: number; detail: string; bonus?: number } {
    let total = 0; const rolls: string[] = [];
    let remaining = expr.replace(/\s+/g, "");
    let bonus = 0;
    const bm = remaining.match(/^(.*?)([+-]\d+)?$/);
    if (bm) { remaining = bm[1] || remaining; bonus = parseInt(bm[2] || "0") || 0; }
    const re = /(\d+)?d(\d+)/gi; let m;
    while ((m = re.exec(remaining)) !== null) {
      const cnt = parseInt(m[1] || "1"), sides = parseInt(m[2]);
      for (let i = 0; i < cnt; i++) { const r = Math.floor(Math.random() * sides) + 1; total += r; rolls.push(String(r)); }
    }
    return { total: total + bonus, detail: rolls.join("+"), bonus: bonus || undefined };
  }

  // ── 政治经济 ──
  private handlePoliticoEconomy(
    intent: ActionIntent,
    messages: AgentMessage[],
    msg: (s: string) => number,
  ): boolean {
    if (intent.action === "economy_viz" || intent.action === "viz") {
      const html = this.#politicoEconomyRaw.renderEconomyHtml();
      // 把 HTML 存入 lastNarrative + 加个简短系统消息
      const summary = this.#politicoEconomyRaw.getBriefState();
      msg(`📊 经济仪表盘已生成 — ${summary.factions.length} 势力, ${summary.markets.length} 市场, ${summary.crisisCount} 危机`);
      this.#lastNarrative = `[经济仪表盘]\n${summary.factions.map(f => `${f.name}: 国库${f.treasury}G 稳定${f.stability}`).join("\n")}`;
      // HTML 通过 messages 传出，前端可拦截
      messages.push({ speaker: "系统", content: `__ECONOMY_HTML__${html}__END_HTML__`, type: "system" });
      return true;
    }
    const result = this.#politicoEconomyRaw.handleAction(intent.action, {
      target: intent.target,
      from: intent.target,
      amount: intent.dc ?? undefined,
      item: intent.item,
      skill: intent.skill,
    });
    msg(result.systemMsg ?? result.narrative);
    this.#lastNarrative = result.narrative;
    return true;
  }

  /**
   * 把所有实体身上的限时状态推进一回合。
   *
   * ⚠ 这个方法原名 `processBleeding`，**从来没有被调用过**（tsc 的
   *   noUnusedLocals 报出来的）。后果是：`checkMajorWound` 的描述写着
   *   「正在流血，每回合失去 1 HP 直到止血」，`act()` 里也确实往
   *   `status` 里推了「流血」—— 但那个标签**永远不掉血、也永远不消失**。
   *   一句纯装饰。
   *
   *   同时 `src/rules/status-effects.ts`（中毒/流血/燃烧…的定义库，带 duration）
   *   在依赖图上是死模块：唯一 import 它的地方五个符号一个没用。
   *   规则在、缺陷在，两者从没接上 —— 和追逐系统是同一个故事。
   *
   *   现在接上：状态定义与时限口径由 status-effects 说了算，
   *   这里只负责「扣血、播报、写回实体」这些游戏层的事。
   *
   * 存储形态**没有变**，还是 `status: string[]`。不给实体加第二个
   * 结构化字段 —— 一份数据两套解析是这个仓库反复在修的病。
   */
  private tickStatusEffects(): void {
    const state = this.#worldRaw.getCurrentState();
    for (const ent of Object.values(state.entities)) {
      const e = ent as { name: string; hp: number; maxHp?: number; status?: string[] };
      if (!Array.isArray(e.status) || e.status.length === 0) continue;
      if (e.hp <= 0) continue; // 人已经倒下，流血不再是这一轮要决定的事

      const { next, expired, active } = tickStatuses(e.status);

      // 每回合掉血的那几种。伤害口径放在这里而不是定义库里：
      // 定义库是**规则数据**，扣多少血要看实体的 maxHp，那是游戏层的信息。
      // ⚠ 原先按最大 HP 的百分比扣（流血 10%、中毒 5%、燃烧 15%），
      //   而 `checkMajorWound` 印给玩家的描述写的是
      //   **「正在流血，每回合失去 1 HP 直到止血」** —— 文案与实现对不上：
      //   20 点体力的人实际每轮掉 2，玩家照着那句话根本算不出自己的血。
      //
      //   CoC 7e 的濒死规则就是每轮 1 点，与那句文案一致。按文案改，
      //   而不是改文案 —— 一句已经印出去的规则说明比一个拍脑袋的百分比更该被当真。
      //   燃烧稍重一点（2 点），中毒与流血同为 1 点。
      const FIXED_PER_TURN_DAMAGE: Record<string, number> = {
        bleeding: 1,
        poisoned: 1,
        burning: 2,
      };
      for (const s of active) {
        let damage: number;
        if (s.id === "hemorrhaging") {
          // 胸部暴击明确规定每轮“1d3”，且每个独立状态/stack 都是一次伤口；
          // 不能把它接成普通流血的固定 1，也不能只掷一枚骰再乘层数。
          damage = 0;
          for (let stack = 0; stack < s.stacks; stack++) {
            damage += Math.floor(Math.random() * 3) + 1;
          }
        } else {
          const perTurn = FIXED_PER_TURN_DAMAGE[s.id];
          if (perTurn === undefined) continue;
          damage = perTurn * s.stacks;
        }
        e.hp = Math.max(0, e.hp - damage);
        this.#addMessageCanonical("系统", `[${s.name}] ${e.name} 失去 ${damage} HP (剩余 ${e.hp}/${e.maxHp})`, "system");
        if (e.hp <= 0) break;
      }
      // WorldEntity 是状态 tick 的 HP 真相源；将已结算的结果镜像到同一 PC 的
      // 持久角色卡。内部安装路径保持当前 raw view 与该 canonical sheet 同一
      // authority；NPC/怪物不在 characters 中，故不创建任何额外存储或实体。
      const character = this.#characters.get(ent.id);
      if (character) character.hp = e.hp;
      for (const s of expired) {
        this.#addMessageCanonical("系统", `[状态] ${e.name} 的「${s.name}」结束了。`, "system");
      }

      const before = e.status;
      if (next.length !== before.length || next.some((x: string, i: number) => x !== before[i]) || active.length > 0) {
        e.status = next;
        this.#worldRaw.upsertEntity(e as never);
      }
    }
  }
}

function compiledDurableAuthorityFor(
  session: GameSession,
  capability: unknown,
): CompiledDurableHostAuthority {
  const authority = compiledDurableHostAuthority.get(session);
  if (!authority || authority.capability !== capability) {
    throw new Error("compiled durable host capability is required");
  }
  return authority;
}

/** Verify a constructor installed the exact unobservable compiled host capability. */
export function assertCompiledDurableHostCapability(
  session: GameSession,
  capability: unknown,
): void {
  void compiledDurableAuthorityFor(session, capability);
}

/**
 * Read the complete compiled authorization binding only as the trusted host.
 * The returned durable snapshot data is deliberately never projected through
 * GameSession itself, because it includes the choice HMAC key and may include
 * an invitation verifier.
 */
export function readCompiledDurableSessionAccessBinding(
  session: GameSession,
  capability: unknown,
): CompiledSessionAccessBinding | null {
  return compiledDurableAuthorityFor(session, capability).access();
}

/** Read the already-acknowledged compiled pointer without rebuilding a
 * successor-shaped snapshot from mutable runtime state. */
export function readCompiledDurableSessionIdentity(
  session: GameSession,
  capability: unknown,
): CompiledSessionDurableIdentity | null {
  const identity = compiledDurableAuthorityFor(session, capability).identity();
  return identity ? { ...identity } : null;
}

/** Create the current complete durable snapshot only as the trusted host. */
export function createCompiledDurableSessionSnapshot(
  session: GameSession,
  capability: unknown,
): CompiledSessionSnapshot {
  return compiledDurableAuthorityFor(session, capability).createSnapshot();
}

/**
 * Acknowledge only the exact canonical snapshot made from this live session.
 * Matching a caller-supplied session/generation/bundle tuple is insufficient:
 * it would let a forged hash become a successor predecessor.
 */
export function acknowledgeCompiledDurableSessionSnapshot(
  session: GameSession,
  capability: unknown,
  snapshot: CompiledSessionSnapshot,
): void {
  compiledDurableAuthorityFor(session, capability).acknowledge(snapshot);
}

/** Resolve an opaque player choice only through the trusted durable host. */
export function resolveCompiledDurablePlayerChoice(
  session: GameSession,
  capability: unknown,
  choiceId: string,
  expectedGeneration: number,
): string | null {
  return compiledDurableAuthorityFor(session, capability).resolvePlayerChoice(choiceId, expectedGeneration);
}

/**
 * Re-resolve the exact current scene/NPC/found-clue intersection through the
 * constructor-installed durable authority.  Browser contact labels are never
 * sufficient to recover this tuple.
 */
export function resolveCompiledDurablePlayerFollowupContacts(
  session: GameSession,
  capability: unknown,
): readonly CompiledPlayerFollowupContact[] {
  return compiledDurableAuthorityFor(session, capability).resolvePlayerFollowupContacts();
}

/**
 * Derive one opaque, domain-separated intent replay identity as the trusted
 * compiled host.  The choice HMAC key stays inside GameSession's private
 * durable authority; callers receive only one-way values suitable for local
 * replay-ledger lookup and result binding.
 */
export function deriveCompiledIntentReplayIdentity(
  session: GameSession,
  capability: unknown,
  input: string,
  expectedGeneration: number,
  catalog: readonly CompiledAvailableAction[],
): CompiledIntentReplayIdentity {
  return compiledDurableAuthorityFor(session, capability)
    .deriveIntentReplayIdentity(input, expectedGeneration, catalog);
}

/**
 * The sole durable compiled action write path. The persistence callback stays
 * a host capability: a request caller cannot acquire this function's matching
 * opaque object or select a no-op callback through GameSession.
 */
export function commitCompiledDurableAction(
  session: GameSession,
  capability: unknown,
  input: string,
  actionId: string,
  expectedGeneration: number,
  persist: (snapshot: CompiledSessionSnapshot) => void,
): CompiledActionCommitResult {
  return compiledDurableAuthorityFor(session, capability).commit(input, actionId, expectedGeneration, persist);
}

/** Derive one exact, non-published compiled successor before narration provider
 * work. The returned value is usable only by a holder of the same host
 * capability and must be durably recorded before dispatch. */
export function prepareCompiledDurableNarration(
  session: GameSession,
  capability: unknown,
  input: string,
  actionId: string,
  expectedGeneration: number,
  playerRequestHash?: string,
  playerTopic?: CompiledPlayerNarrationTopicRequest,
): CompiledNarrationPreparation {
  return compiledDurableAuthorityFor(session, capability).prepareNarration(input, actionId, expectedGeneration, playerRequestHash, playerTopic);
}

/** Bind one current selected opaque choice to raw request-scoped player prose.
 * The returned values are one-way hashes suitable for private durable storage. */
export function bindCompiledDurableNarrationTopic(
  session: GameSession,
  capability: unknown,
  input: string,
  actionId: string,
  expectedGeneration: number,
  playerTopic: CompiledPlayerNarrationTopicRequest,
): CompiledPlayerNarrationTopicBinding | null {
  return compiledDurableAuthorityFor(session, capability)
    .bindNarrationTopic(input, actionId, expectedGeneration, playerTopic);
}

/** Recheck raw request-scoped prose against an existing v2 candidate without
 * using an old catalog or exposing the persisted stable choice HMAC key. */
export function matchCompiledDurableNarrationTopic(
  session: GameSession,
  capability: unknown,
  candidate: CompiledNarrationCandidate,
  playerTopic: CompiledPlayerNarrationTopicRequest,
): CompiledPlayerNarrationTopicBinding | null {
  return compiledDurableAuthorityFor(session, capability).matchNarrationTopic(candidate, playerTopic);
}

/** Host-only pre-dispatch validation for a candidate read from durable private
 * storage. It has no mutation or model capability. */
export function validateCompiledDurableNarrationCandidate(
  session: GameSession,
  capability: unknown,
  candidate: CompiledNarrationCandidate,
): boolean {
  return compiledDurableAuthorityFor(session, capability).validateNarrationCandidate(candidate);
}

/** Host-only receipt-admission check for parsed provider prose.  It has no
 * state write or model capability and derives all visibility from the
 * canonical candidate instead of the provider frame. */
export function validateCompiledDurableNarrationText(
  session: GameSession,
  capability: unknown,
  candidate: CompiledNarrationCandidate,
  narration: { schemaVersion: "1.0.0"; text: string },
): boolean {
  return compiledDurableAuthorityFor(session, capability).validateNarrationText(candidate, narration);
}

/** Verify a completed v2 receipt against the live idempotency anchor before
 * an HTTP retry reads candidate-local input or topic hashes. */
export function validateCompiledDurableNarrationReceipt(
  session: GameSession,
  capability: unknown,
  candidate: CompiledNarrationCandidate,
  narration: { schemaVersion: "1.0.0"; text: string },
): boolean {
  return compiledDurableAuthorityFor(session, capability)
    .validateCommittedNarrationReceipt(candidate, narration);
}

/** Publish one already-prepared compiled candidate with validated provider prose.
 * This does not execute mechanics or generate entropy; it only binds prose to
 * the candidate already persisted by the trusted host. */
export function commitCompiledDurableNarration(
  session: GameSession,
  capability: unknown,
  candidate: CompiledNarrationCandidate,
  narration: { schemaVersion: "1.0.0"; text: string },
  persist: (snapshot: CompiledSessionSnapshot) => void,
): CompiledActionCommitResult {
  return compiledDurableAuthorityFor(session, capability).commitNarration(candidate, narration, persist);
}

/**
 * Consume a server-minted capability for a durable ordinary identity. It is
 * not a GameSession method, so same-name own/prototype replacement cannot
 * select this write path. The capability is installed only by a server
 * constructor and is never observable through the session; importing this
 * function alone is useless.
 */
export function acknowledgeOrdinaryDurableIdentity(
  session: GameSession,
  capability: unknown,
  identity: OrdinarySessionDurableIdentity,
): void {
  const authority = ordinaryDurableHostAuthority.get(session);
  if (!authority || authority.capability !== capability) {
    throw new Error("ordinary durable identity requires the durable host capability");
  }
  authority.acknowledge(identity);
}

/**
 * Verify that a constructor installed the exact opaque host capability. This
 * is deliberately an observation-only check: it neither creates nor changes
 * a WeakMap authority entry, so a factory that dropped or substituted the
 * dependency cannot repair itself after construction.
 */
export function assertOrdinaryDurableHostCapability(
  session: GameSession,
  capability: unknown,
): void {
  const authority = ordinaryDurableHostAuthority.get(session);
  if (!authority || authority.capability !== capability) {
    throw new Error("ordinary durable host capability is not installed on this GameSession");
  }
}

/**
 * Durable hosts serialize an acknowledged source only to derive an isolated
 * candidate. The public transaction method remains unavailable to callers of
 * that live object, including its `act` closure.
 */
export function runOrdinaryDurableActionTransaction<T>(
  session: GameSession,
  capability: unknown,
  operation: OrdinaryActionTransactionOperation<T>,
): Promise<T> {
  const authority = ordinaryDurableHostAuthority.get(session);
  if (!authority || authority.capability !== capability) {
    throw new Error("ordinary durable transaction requires the durable host capability");
  }
  return authority.runExclusiveActionTransaction(operation);
}

/**
 * Consume a server-minted capability for a public KP announcement. It is not
 * a GameSession method, so an own/prototype replacement of `sendMessage` or
 * `addMessage` cannot redirect, suppress, or throw through this write path.
 */
export function appendOrdinaryHostAnnouncement(
  session: GameSession,
  capability: unknown,
  speaker: unknown,
  content: unknown,
  type: unknown,
): OrdinaryHostAnnouncement | null {
  const authority = ordinaryDurableHostAuthority.get(session);
  if (!authority || authority.capability !== capability) {
    throw new Error("ordinary host announcement requires the durable host capability");
  }
  const message = normalizeOrdinaryHostAnnouncement(speaker, content, type);
  if (!message) throw new Error("ordinary host announcement values are invalid");
  return authority.append(message.speaker, message.content, message.type);
}
