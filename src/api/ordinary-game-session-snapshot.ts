import { createHash } from "node:crypto";
import {
  AGENT_REGISTRY_SNAPSHOT_VERSION,
  validateAgentRegistrySnapshot,
  type AgentRegistrySnapshot,
} from "../agent/agent-registry-snapshot";
import {
  COMPANION_MANAGER_SNAPSHOT_VERSION,
  validateCompanionManagerSnapshot,
  validateCompanionSnapshotWorld,
  type CompanionManagerSnapshot,
} from "../combat/companion-manager-snapshot";
import { type WorldEntity } from "../types";
import { validateNormalSessionActionIntent } from "../llm/intent";
import { COC_ATTRIBUTES, SKILL_NAME_MAP } from "../character/coc-character";
import { COC_BUILD_RANGE, validateSanityState } from "../rules/coc-engine";
import { PLAYER_META_KEYS, type PlayerMeta } from "../character/player-metadata";
import {
  NPC_STORE_SNAPSHOT_VERSION,
  validateNPCStoreSnapshot,
  type NPCStoreSnapshot,
} from "../db/npc-store-snapshot";
import {
  POLITICO_ECONOMY_SNAPSHOT_VERSION,
  validatePoliticoEconomySnapshot,
  type PoliticoEconomySnapshot,
} from "../economy/politico-economy-snapshot";
import {
  assertRuntimeModulePackage,
  type RuntimeModulePackage,
} from "./runtime-module-package";
import { isOrdinarySessionAccessBinding, type OrdinarySessionAccessBinding } from "./session-access";
import {
  PLAYER_SESSION_SNAPSHOT_VERSION,
  validatePlayerSessionSnapshot,
  type PlayerSessionSnapshot,
} from "../session/player-session-snapshot";
import {
  WORLD_STATE_SNAPSHOT_VERSION,
  validateWorldStateSnapshot,
  type WorldStateSnapshot,
} from "../state/world-state-snapshot";
import {
  validateCareerPortableProjection,
  type CareerPortableProjection,
} from "../character/career-file";

/** The portable envelope for a non-compiled GameSession. */
export const ORDINARY_GAME_SESSION_SNAPSHOT_KIND = "ordinary-game-session" as const;
export const ORDINARY_GAME_SESSION_SNAPSHOT_VERSION = "1.4.0" as const;
/** v1.3 did not distinguish death from an ordinary module departure. */
const PREVIOUS_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION = "1.3.0" as const;
/** v1.2 used one ambiguous session-wide treatment-recovery boolean. */
const SCALAR_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION = "1.2.0" as const;
const HISTORICAL_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION = "1.1.0" as const;
const LEGACY_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION = "1.0.0" as const;

export const ORDINARY_GAME_SESSION_COMPONENT_VERSIONS = Object.freeze({
  snapshot: ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
  world: WORLD_STATE_SNAPSHOT_VERSION,
  playerSession: PLAYER_SESSION_SNAPSHOT_VERSION,
  politicoEconomy: POLITICO_ECONOMY_SNAPSHOT_VERSION,
  companionManager: COMPANION_MANAGER_SNAPSHOT_VERSION,
  npcStore: NPC_STORE_SNAPSHOT_VERSION,
  agentRegistry: AGENT_REGISTRY_SNAPSHOT_VERSION,
  career: "1.0.0",
});

const PREVIOUS_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS = Object.freeze({
  ...ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
  snapshot: PREVIOUS_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
});

const SCALAR_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS = Object.freeze({
  ...PREVIOUS_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
  snapshot: SCALAR_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
});

const HISTORICAL_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS = Object.freeze({
  snapshot: HISTORICAL_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
  world: WORLD_STATE_SNAPSHOT_VERSION,
  playerSession: PLAYER_SESSION_SNAPSHOT_VERSION,
  politicoEconomy: POLITICO_ECONOMY_SNAPSHOT_VERSION,
  companionManager: COMPANION_MANAGER_SNAPSHOT_VERSION,
  npcStore: NPC_STORE_SNAPSHOT_VERSION,
  agentRegistry: AGENT_REGISTRY_SNAPSHOT_VERSION,
});

const LEGACY_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS = Object.freeze({
  ...HISTORICAL_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
  snapshot: LEGACY_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
});

export type OrdinarySnapshotJson = null | boolean | number | string
  | OrdinarySnapshotJson[] | { [key: string]: OrdinarySnapshotJson };

export interface OrdinaryGameSessionSnapshotCharacter {
  pcId: string;
  sheet: OrdinarySnapshotJson;
}

export interface OrdinaryGameSessionSnapshotSanity {
  pcId: string;
  state: OrdinarySnapshotJson;
}

export interface OrdinaryGameSessionSnapshotPartyMember {
  pcId: string;
  control: "auto" | `player:${string}`;
  meta: PlayerMeta | null;
}

export interface OrdinaryGameSessionSnapshotState {
  activePlayerId: string;
  activeCharacterId: string | null;
  round: number;
  dead: boolean;
  terminal: OrdinarySessionTerminal;
  combatActive: boolean;
  pendingCompoundMoves: Array<{ pcId: string; originalInput: string; originalIntent: import("../types").ActionIntent }>;
  pendingLeaveConfirm: boolean;
  characters: OrdinaryGameSessionSnapshotCharacter[];
  sanities: OrdinaryGameSessionSnapshotSanity[];
  party: OrdinaryGameSessionSnapshotPartyMember[];
  sceneItems: Array<{ sceneId: string; items: string[] }>;
  sceneDisplayNames: Record<string, string>;
  sceneAliases: Record<string, string[]>;
  sceneBgm: Record<string, string>;
  lastNarrative: string;
  lastDiceRoll: { expr: string; total: number; detail?: string; bonus?: number } | null;
  lastRolls: Array<{ skill: string; roll: number; target: number; success: boolean }>;
  gameTime: { day: number; period: string; ticks: number };
  activeDifficulty: "easy" | "medium" | "hard" | "nightmare" | null;
  skillGrowthMarksByPC: Array<{ pcId: string; skills: string[] }>;
  skillMarks: Record<string, number>;
  woundsTreatedByPC: string[];
  moduleStartByPC: Array<{ pcId: string; san: number; cm: number }>;
  growthChangesByPC: Array<{ pcId: string; changes: string[] }>;
  mythosSpells: Array<{ name: string; sanCost: string; mpCost: number; description: string; effect?: string }>;
  moduleItemDescriptions: Array<{ id: string; description: string }>;
  moduleKpNotes: Array<{ id: string; note: string }>;
  moduleRewards: Array<{ id: string; reward: OrdinarySnapshotJson }>;
  knownMythosSpells: string[];
  lastPushedRoll: { skill: string; roll: number; target: number } | null;
  p1Persona: PlayerMeta | null;
  sightedMythos: string[];
}

/** The ordinary-session terminal truth, independent from the public death flag. */
export type OrdinarySessionTerminal =
  | { readonly kind: "death" }
  | { readonly kind: "module_departure"; readonly endingId: string; readonly endingName: string }
  /** A verified pre-v1.4 wire said only `dead: true`; its cause is unknowable. */
  | { readonly kind: "legacy_unknown" }
  | null;

export type OrdinaryCareerProjection =
  | { mode: "complete"; projection: CareerPortableProjection }
  /** A signed runtime-only snapshot whose character state has no Career authority. */
  | { mode: "transient" }
  /** Only verified 1.0/1.1 payload migration can construct this in-memory state. */
  | { mode: "legacy-bases-only" };

export interface OrdinaryGameSessionSnapshot {
  kind: typeof ORDINARY_GAME_SESSION_SNAPSHOT_KIND;
  schemaVersion: typeof ORDINARY_GAME_SESSION_SNAPSHOT_VERSION;
  components: typeof ORDINARY_GAME_SESSION_COMPONENT_VERSIONS;
  session: {
    id: string;
    createdAt: number;
    lastActiveAt: number;
    ruleset: "cosmic-horror" | "dnd5e" | "grail";
    access: OrdinarySessionAccessBinding | null;
  };
  /** A complete, independently installable legacy package, never merely an ID. */
  module: {
    package: RuntimeModulePackage | null;
    contentHash: string | null;
  };
  world: WorldStateSnapshot;
  playerSession: PlayerSessionSnapshot;
  politicoEconomy: PoliticoEconomySnapshot;
  companionManager: CompanionManagerSnapshot;
  npcStore: NPCStoreSnapshot;
  agentRegistry: AgentRegistrySnapshot;
  state: OrdinaryGameSessionSnapshotState;
  career: OrdinaryCareerProjection;
  snapshotHash: string;
}

/**
 * Verified historical wire remains addressable inside a v1.4 ordinary
 * envelope until its next normal successor is published.  It is deliberately
 * distinct from the restored current view so the outer immutable hash and its
 * archive receipts retain their original identity.
 */
/** Pre-v1.4 state did not carry a terminal reason. */
type LegacyTerminalOrdinaryGameSessionSnapshotState = Omit<OrdinaryGameSessionSnapshotState, "terminal">;

/** Pre-v1.3 state stored a treatment recovery bit without an owner. */
type ScalarWoundsOrdinaryGameSessionSnapshotState = Omit<LegacyTerminalOrdinaryGameSessionSnapshotState, "woundsTreatedByPC"> & {
  woundsTreated: boolean;
};

/** The immediately preceding complete v1.3 wire lacks a terminal reason. */
export type PreviousOrdinaryGameSessionSnapshot = Omit<OrdinaryGameSessionSnapshot, "schemaVersion" | "components" | "state"> & {
  schemaVersion: typeof PREVIOUS_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION;
  components: typeof PREVIOUS_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS;
  state: LegacyTerminalOrdinaryGameSessionSnapshotState;
};

/** The v1.2 wire has a scalar treatment bit and no terminal reason. */
export type ScalarOrdinaryGameSessionSnapshot = Omit<OrdinaryGameSessionSnapshot, "schemaVersion" | "components" | "state"> & {
  schemaVersion: typeof SCALAR_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION;
  components: typeof SCALAR_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS;
  state: ScalarWoundsOrdinaryGameSessionSnapshotState;
};

export type HistoricalOrdinaryGameSessionSnapshot = Omit<OrdinaryGameSessionSnapshot, "schemaVersion" | "components" | "career" | "state"> & {
  schemaVersion: typeof HISTORICAL_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION;
  components: typeof HISTORICAL_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS;
  state: ScalarWoundsOrdinaryGameSessionSnapshotState;
};

export type LegacyOrdinaryGameSessionSnapshot = Omit<HistoricalOrdinaryGameSessionSnapshot, "schemaVersion" | "components" | "state"> & {
  schemaVersion: typeof LEGACY_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION;
  components: typeof LEGACY_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS;
  state: Omit<ScalarWoundsOrdinaryGameSessionSnapshotState, "skillGrowthMarksByPC"> & { skillGrowthMarks: string[] };
};

export type OrdinaryGameSessionSnapshotWire = OrdinaryGameSessionSnapshot
  | PreviousOrdinaryGameSessionSnapshot
  | ScalarOrdinaryGameSessionSnapshot
  | HistoricalOrdinaryGameSessionSnapshot
  | LegacyOrdinaryGameSessionSnapshot;

type UnknownRecord = Record<string, unknown>;

const HASH_DOMAIN = "aitrpg.ordinary-game-session-snapshot.v1\u0000";
const MODULE_HASH_DOMAIN = "aitrpg.ordinary-game-session-module.v1\u0000";
const MAX_DEPTH = 64;
const MAX_NODES = 2_000_000;
const MAX_STRING = 1_000_000;
const MAX_ENTRIES = 100_000;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RULESETS = new Set(["cosmic-horror", "dnd5e", "grail"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard", "nightmare"]);
const PERIODS = new Set(["dawn", "morning", "noon", "afternoon", "dusk", "evening", "night", "late_night"]);
const hasOwn = Object.prototype.hasOwnProperty;
const COC_SKILL_KEYS = [...new Set(Object.values(SKILL_NAME_MAP))].sort();
const COC_SHEET_REQUIRED_KEYS = [
  "name", "archetypeId", "attributes", "luck", "hp", "maxHp", "ac", "damageBonus", "build", "move", "creditRating",
  "startingItems", "occupationSkillPoints", "interestSkillPoints", "occupationSkills", "availableSkills", "age", "valid",
  "warnings", "cthulhuMythos", "skillValues",
] as const;
const COC_SHEET_OPTIONAL_KEYS = ["occupationSkillKeys", "backgroundProfile", "backstory"] as const;
const BACKGROUND_PROFILE_KEYS = ["appearance", "beliefs", "significantPeople", "meaningfulPlace", "treasuredPossession", "traits", "woundsAndScars", "phobiasAndManias"] as const;

/** Canonical, domain-separated content identity for an ordinary legacy package. */
export function ordinaryGameSessionModuleHash(value: unknown): string {
  const prepared = normalizeJson(value, "$module", { nodes: 0 });
  return hash(MODULE_HASH_DOMAIN, prepared);
}

/**
 * RuntimeModuleData predates JSON persistence and may contain declared
 * optional properties with value `undefined` (notably an omitted epilogue
 * title).  Omission is its JSON representation.  We remove only own,
 * enumerable, data-property `undefined` object members; undefined array slots,
 * getters, symbols, non-plain prototypes, and every other non-JSON value still
 * fail closed.  The resulting value is re-checked by the existing installer
 * package validator before it is allowed into a snapshot.
 */
export function normalizeOrdinaryRuntimeModulePackage(input: unknown): RuntimeModulePackage {
  const normalized = normalizeJson(dropOptionalUndefined(input, "$module", { nodes: 0 }), "$module", { nodes: 0 });
  try {
    assertRuntimeModulePackage(normalized);
  } catch (error) {
    fail(`$module is not an installable RuntimeModulePackage after JSON normalization: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ((normalized as { kind?: unknown }).kind === "compiled_bundle") fail("$module compiled bundles are not ordinary-session snapshots");
  return structuredClone(normalized) as RuntimeModulePackage;
}

/** Canonical, domain-separated integrity identity for the complete envelope. */
export function ordinaryGameSessionSnapshotHash(value: unknown): string {
  const prepared = normalizeJson(value, "$snapshot", { nodes: 0 });
  return hash(HASH_DOMAIN, prepared);
}

/**
 * Content identity for deciding whether a live durable source still has the
 * same business state as its staging baseline. `lastActiveAt` is an
 * operational idle-cleanup timestamp, not a business write: retaining it here
 * would make TTL observation look like a concurrent game-state mutation.
 */
export function ordinaryGameSessionBusinessStateHash(snapshot: OrdinaryGameSessionSnapshot): string {
  const { snapshotHash: _snapshotHash, session, ...rest } = snapshot;
  const { lastActiveAt: _lastActiveAt, ...businessSession } = session;
  return ordinaryGameSessionSnapshotHash({ ...rest, session: businessSession });
}

/**
 * Validate an immutable wire snapshot in its original schema.  Envelope
 * readers use this form so an authenticated 1.1/1.0 nested payload keeps the
 * outer body, receipt, and replay-node identities it was committed with.
 */
export function validateOrdinaryGameSessionSnapshotWire(input: unknown): OrdinaryGameSessionSnapshotWire {
  const normalized = normalizeJson(input, "$", { nodes: 0 });
  const root = dataRecord(normalized, "$");
  if (root.kind !== ORDINARY_GAME_SESSION_SNAPSHOT_KIND) fail("$.kind must be ordinary-game-session");
  if (root.schemaVersion === ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) {
    return validateCurrentOrdinaryGameSessionSnapshot(root);
  }
  if (root.schemaVersion === PREVIOUS_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) {
    return validatePreviousOrdinaryGameSessionSnapshot(root);
  }
  if (root.schemaVersion === SCALAR_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) {
    return validateScalarOrdinaryGameSessionSnapshot(root);
  }
  if (root.schemaVersion === HISTORICAL_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) {
    return validateHistoricalOrdinaryGameSessionSnapshot(root);
  }
  if (root.schemaVersion === LEGACY_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) {
    return validateLegacyOrdinaryGameSessionSnapshot(root);
  }
  fail("$.schemaVersion is unsupported");
}

/** Validate, deep-clone, and migrate an accepted wire snapshot for restoration. */
export function validateOrdinaryGameSessionSnapshot(input: unknown): OrdinaryGameSessionSnapshot {
  const wire = validateOrdinaryGameSessionSnapshotWire(input);
  if (wire.schemaVersion === ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) return wire;
  if (wire.schemaVersion === PREVIOUS_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) {
    return migrateVerifiedPreviousSnapshot(wire);
  }
  if (wire.schemaVersion === SCALAR_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) {
    return migrateVerifiedScalarSnapshot(wire);
  }
  return wire.schemaVersion === HISTORICAL_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION
    ? migrateVerifiedHistoricalSnapshot(wire)
    : migrateVerifiedLegacySnapshot(wire);
}

/**
 * A live session restored from an immutable historical envelope exports the
 * current 1.4 shape (including the target's newly complete Career truth), so
 * its snapshot hash cannot equal the predecessor's historical wire hash.
 * Compare every pre-action game component after the verified legacy migration
 * while deliberately excluding only schema/component declarations, integrity
 * signatures, and the Career mode/projection that legacy never carried.
 */
export function ordinarySnapshotWireMatchesCurrentState(
  wire: OrdinaryGameSessionSnapshotWire,
  current: OrdinaryGameSessionSnapshot,
): boolean {
  if (wire.schemaVersion === ORDINARY_GAME_SESSION_SNAPSHOT_VERSION) {
    return wire.snapshotHash === current.snapshotHash;
  }
  const migrated = wire.schemaVersion === PREVIOUS_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION
    ? migrateVerifiedPreviousSnapshot(wire)
    : wire.schemaVersion === SCALAR_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION
      ? migrateVerifiedScalarSnapshot(wire)
      : wire.schemaVersion === HISTORICAL_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION
        ? migrateVerifiedHistoricalSnapshot(wire)
        : migrateVerifiedLegacySnapshot(wire);
  const semantic = (snapshot: OrdinaryGameSessionSnapshot) => {
    const { schemaVersion: _schemaVersion, components: _components, career: _career, snapshotHash: _snapshotHash, ...rest } = snapshot;
    return rest;
  };
  try {
    return ordinaryGameSessionSnapshotHash(semantic(migrated)) === ordinaryGameSessionSnapshotHash(semantic(current));
  } catch {
    return false;
  }
}

function validateCurrentOrdinaryGameSessionSnapshot(root: UnknownRecord): OrdinaryGameSessionSnapshot {
  exactRecord(root, "$", [
    "kind", "schemaVersion", "components", "session", "module", "world", "playerSession", "politicoEconomy",
    "companionManager", "npcStore", "agentRegistry", "state", "career", "snapshotHash",
  ]);
  validateComponentVersions(root.components);
  const session = validateSession(root.session);
  const module = validateModule(root.module);
  const world = validateWorldStateSnapshot(root.world);
  const playerSession = validatePlayerSessionSnapshot(root.playerSession);
  const politicoEconomy = validatePoliticoEconomySnapshot(root.politicoEconomy);
  const companionManager = validateCompanionManagerSnapshot(root.companionManager);
  const npcStore = validateNPCStoreSnapshot(root.npcStore);
  const agentRegistry = validateAgentRegistrySnapshot(root.agentRegistry);
  const state = validateState(root.state, "current");
  const career = validateCurrentCareerProjection(root.career);
  const snapshotHash = text(root.snapshotHash, "$.snapshotHash", 72);
  if (!HASH_PATTERN.test(snapshotHash)) fail("$.snapshotHash must be a sha256 digest");

  const unsigned = {
    kind: ORDINARY_GAME_SESSION_SNAPSHOT_KIND,
    schemaVersion: ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
    components: ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
    session,
    module,
    world,
    playerSession,
    politicoEconomy,
    companionManager,
    npcStore,
    agentRegistry,
    state,
    career,
  } satisfies Omit<OrdinaryGameSessionSnapshot, "snapshotHash">;
  if (ordinaryGameSessionSnapshotHash(unsigned) !== snapshotHash) fail("$.snapshotHash does not match canonical payload");

  validateCrossComponentInvariants(unsigned);
  if (career.mode === "complete") validateCompleteCareerProjectionInvariants(career.projection, state);
  return { ...unsigned, snapshotHash };
}

/** v1.3 carried a complete Career projection but no terminal reason. */
function validatePreviousOrdinaryGameSessionSnapshot(root: UnknownRecord): PreviousOrdinaryGameSessionSnapshot {
  exactRecord(root, "$", [
    "kind", "schemaVersion", "components", "session", "module", "world", "playerSession", "politicoEconomy",
    "companionManager", "npcStore", "agentRegistry", "state", "career", "snapshotHash",
  ]);
  validatePreviousComponentVersions(root.components);
  const session = validateSession(root.session);
  const module = validateModule(root.module);
  const world = validateWorldStateSnapshot(root.world);
  const playerSession = validatePlayerSessionSnapshot(root.playerSession);
  const politicoEconomy = validatePoliticoEconomySnapshot(root.politicoEconomy);
  const companionManager = validateCompanionManagerSnapshot(root.companionManager);
  const npcStore = validateNPCStoreSnapshot(root.npcStore);
  const agentRegistry = validateAgentRegistrySnapshot(root.agentRegistry);
  const state = validateState(root.state, "previous");
  const career = validateCompleteCareerProjection(root.career);
  const snapshotHash = text(root.snapshotHash, "$.snapshotHash", 72);
  if (!HASH_PATTERN.test(snapshotHash)) fail("$.snapshotHash must be a sha256 digest");
  const unsigned = {
    kind: ORDINARY_GAME_SESSION_SNAPSHOT_KIND,
    schemaVersion: PREVIOUS_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
    components: PREVIOUS_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
    session, module, world, playerSession, politicoEconomy, companionManager, npcStore, agentRegistry, state, career,
  } satisfies Omit<PreviousOrdinaryGameSessionSnapshot, "snapshotHash">;
  if (ordinaryGameSessionSnapshotHash(unsigned) !== snapshotHash) fail("$.snapshotHash does not match canonical v1.3 payload");
  validateCrossComponentInvariants(unsigned);
  validateCompleteCareerProjectionInvariants(career.projection, state);
  return { ...unsigned, snapshotHash };
}

/** v1.2 carried a complete Career projection but one ownerless treatment bit. */
function validateScalarOrdinaryGameSessionSnapshot(root: UnknownRecord): ScalarOrdinaryGameSessionSnapshot {
  exactRecord(root, "$", [
    "kind", "schemaVersion", "components", "session", "module", "world", "playerSession", "politicoEconomy",
    "companionManager", "npcStore", "agentRegistry", "state", "career", "snapshotHash",
  ]);
  validateScalarComponentVersions(root.components);
  const session = validateSession(root.session);
  const module = validateModule(root.module);
  const world = validateWorldStateSnapshot(root.world);
  const playerSession = validatePlayerSessionSnapshot(root.playerSession);
  const politicoEconomy = validatePoliticoEconomySnapshot(root.politicoEconomy);
  const companionManager = validateCompanionManagerSnapshot(root.companionManager);
  const npcStore = validateNPCStoreSnapshot(root.npcStore);
  const agentRegistry = validateAgentRegistrySnapshot(root.agentRegistry);
  const state = validateState(root.state, "scalar");
  const career = validateCompleteCareerProjection(root.career);
  const snapshotHash = text(root.snapshotHash, "$.snapshotHash", 72);
  if (!HASH_PATTERN.test(snapshotHash)) fail("$.snapshotHash must be a sha256 digest");
  const unsigned = {
    kind: ORDINARY_GAME_SESSION_SNAPSHOT_KIND,
    schemaVersion: SCALAR_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
    components: SCALAR_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
    session, module, world, playerSession, politicoEconomy, companionManager, npcStore, agentRegistry, state, career,
  } satisfies Omit<ScalarOrdinaryGameSessionSnapshot, "snapshotHash">;
  if (ordinaryGameSessionSnapshotHash(unsigned) !== snapshotHash) fail("$.snapshotHash does not match canonical v1.2 payload");
  validateCrossComponentInvariants(unsigned);
  validateCompleteCareerProjectionInvariants(career.projection, state);
  return { ...unsigned, snapshotHash };
}

/** v1.1 is accepted only after its original component contract and hash are proven. */
function validateHistoricalOrdinaryGameSessionSnapshot(root: UnknownRecord): HistoricalOrdinaryGameSessionSnapshot {
  exactRecord(root, "$", [
    "kind", "schemaVersion", "components", "session", "module", "world", "playerSession", "politicoEconomy",
    "companionManager", "npcStore", "agentRegistry", "state", "snapshotHash",
  ]);
  validateHistoricalComponentVersions(root.components);
  const session = validateSession(root.session);
  const module = validateModule(root.module);
  const world = validateWorldStateSnapshot(root.world);
  const playerSession = validatePlayerSessionSnapshot(root.playerSession);
  const politicoEconomy = validatePoliticoEconomySnapshot(root.politicoEconomy);
  const companionManager = validateCompanionManagerSnapshot(root.companionManager);
  const npcStore = validateNPCStoreSnapshot(root.npcStore);
  const agentRegistry = validateAgentRegistrySnapshot(root.agentRegistry);
  const state = validateState(root.state, "scalar");
  const snapshotHash = text(root.snapshotHash, "$.snapshotHash", 72);
  if (!HASH_PATTERN.test(snapshotHash)) fail("$.snapshotHash must be a sha256 digest");
  const unsigned = {
    kind: ORDINARY_GAME_SESSION_SNAPSHOT_KIND,
    schemaVersion: HISTORICAL_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
    components: HISTORICAL_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
    session, module, world, playerSession, politicoEconomy, companionManager, npcStore, agentRegistry, state,
  } satisfies Omit<HistoricalOrdinaryGameSessionSnapshot, "snapshotHash">;
  if (ordinaryGameSessionSnapshotHash(unsigned) !== snapshotHash) fail("$.snapshotHash does not match canonical historical v1.1 payload");
  validateCrossComponentInvariants(unsigned);
  return { ...unsigned, snapshotHash };
}

/** v1 is an accepted wire format only after its original canonical hash is proven. */
function validateLegacyOrdinaryGameSessionSnapshot(root: UnknownRecord): LegacyOrdinaryGameSessionSnapshot {
  exactRecord(root, "$", [
    "kind", "schemaVersion", "components", "session", "module", "world", "playerSession", "politicoEconomy",
    "companionManager", "npcStore", "agentRegistry", "state", "snapshotHash",
  ]);
  validateLegacyComponentVersions(root.components);
  const session = validateSession(root.session);
  const module = validateModule(root.module);
  const world = validateWorldStateSnapshot(root.world);
  const playerSession = validatePlayerSessionSnapshot(root.playerSession);
  const politicoEconomy = validatePoliticoEconomySnapshot(root.politicoEconomy);
  const companionManager = validateCompanionManagerSnapshot(root.companionManager);
  const npcStore = validateNPCStoreSnapshot(root.npcStore);
  const agentRegistry = validateAgentRegistrySnapshot(root.agentRegistry);
  const state = validateState(root.state, "legacy");
  const snapshotHash = text(root.snapshotHash, "$.snapshotHash", 72);
  if (!HASH_PATTERN.test(snapshotHash)) fail("$.snapshotHash must be a sha256 digest");

  const unsigned = {
    kind: ORDINARY_GAME_SESSION_SNAPSHOT_KIND,
    schemaVersion: LEGACY_ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
    components: LEGACY_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
    session,
    module,
    world,
    playerSession,
    politicoEconomy,
    companionManager,
    npcStore,
    agentRegistry,
    state,
  } satisfies Omit<LegacyOrdinaryGameSessionSnapshot, "snapshotHash">;
  if (ordinaryGameSessionSnapshotHash(unsigned) !== snapshotHash) fail("$.snapshotHash does not match canonical legacy v1 payload");
  validateCrossComponentInvariants(unsigned);
  return { ...unsigned, snapshotHash };
}

function migratedLegacySnapshot(input: Omit<OrdinaryGameSessionSnapshot, "snapshotHash" | "career">): OrdinaryGameSessionSnapshot {
  const unsigned = { ...input, career: { mode: "legacy-bases-only" as const } } satisfies Omit<OrdinaryGameSessionSnapshot, "snapshotHash">;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function migrateLegacyTerminal(state: LegacyTerminalOrdinaryGameSessionSnapshotState): OrdinaryGameSessionSnapshotState {
  const { dead, ...rest } = state;
  // `dead: true` was reused for both death and departure. Preserve its only
  // reliable fact (the session cannot continue) without claiming either cause.
  return { ...rest, dead: false, terminal: dead ? { kind: "legacy_unknown" } : null };
}

function migrateScalarWoundTreatmentOwners(
  state: ScalarWoundsOrdinaryGameSessionSnapshotState,
): LegacyTerminalOrdinaryGameSessionSnapshotState {
  const { woundsTreated, ...withoutScalarWounds } = state;
  if (!woundsTreated) return { ...withoutScalarWounds, woundsTreatedByPC: [] };
  if (state.characters.length !== 1) {
    fail("legacy treatment recovery has ambiguous ownership: a true scalar requires exactly one character");
  }
  return { ...withoutScalarWounds, woundsTreatedByPC: [state.characters[0]!.pcId] };
}

function migrateVerifiedPreviousSnapshot(previous: PreviousOrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = previous;
  const state = migrateLegacyTerminal(unsigned.state);
  const current = {
    ...unsigned,
    schemaVersion: ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
    components: ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
    state,
  } satisfies Omit<OrdinaryGameSessionSnapshot, "snapshotHash">;
  return { ...current, snapshotHash: ordinaryGameSessionSnapshotHash(current) };
}

function migrateVerifiedScalarSnapshot(previous: ScalarOrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = previous;
  const state = migrateLegacyTerminal(migrateScalarWoundTreatmentOwners(unsigned.state));
  const current = {
    ...unsigned,
    schemaVersion: ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
    components: ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
    state,
  } satisfies Omit<OrdinaryGameSessionSnapshot, "snapshotHash">;
  return { ...current, snapshotHash: ordinaryGameSessionSnapshotHash(current) };
}

function migrateVerifiedHistoricalSnapshot(historical: HistoricalOrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = historical;
  return migratedLegacySnapshot({
    ...unsigned,
    schemaVersion: ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
    components: ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
    state: migrateLegacyTerminal(migrateScalarWoundTreatmentOwners(unsigned.state)),
  });
}

function migrateVerifiedLegacySnapshot(legacy: LegacyOrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const legacyMarks = [...new Set(legacy.state.skillGrowthMarks)];
  const characters = legacy.state.characters;
  let skillGrowthMarksByPC: OrdinaryGameSessionSnapshotState["skillGrowthMarksByPC"] = [];
  if (legacyMarks.length > 0) {
    if (characters.length !== 1) {
      fail("legacy skill growth marks have ambiguous ownership: a non-empty v1 mark list requires exactly one character");
    }
    skillGrowthMarksByPC = [{ pcId: characters[0]!.pcId, skills: legacyMarks }];
  }
  const { skillGrowthMarks: _legacyMarks, ...stateWithoutLegacyMarks } = legacy.state;
  return migratedLegacySnapshot({
    kind: ORDINARY_GAME_SESSION_SNAPSHOT_KIND,
    schemaVersion: ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
    components: ORDINARY_GAME_SESSION_COMPONENT_VERSIONS,
    session: legacy.session,
    module: legacy.module,
    world: legacy.world,
    playerSession: legacy.playerSession,
    politicoEconomy: legacy.politicoEconomy,
    companionManager: legacy.companionManager,
    npcStore: legacy.npcStore,
    agentRegistry: legacy.agentRegistry,
    state: migrateLegacyTerminal(migrateScalarWoundTreatmentOwners({ ...stateWithoutLegacyMarks, skillGrowthMarksByPC })),
  });
}

/** Exporters call the same hostile-input validator used by restorers. */
export function createOrdinaryGameSessionSnapshot(
  value: Omit<OrdinaryGameSessionSnapshot, "snapshotHash">,
): OrdinaryGameSessionSnapshot {
  const snapshotHash = ordinaryGameSessionSnapshotHash(value);
  return validateOrdinaryGameSessionSnapshot({ ...value, snapshotHash });
}

/**
 * Current ordinary portability deliberately supports the JSON-safe CoC sheet
 * produced by buildCoCCharacter.  The source object historically contains an
 * own `occupationSkillKeys: undefined`; that one declared optional field is
 * represented by absence in JSON.  Any other undefined/non-data/unknown field
 * is rejected rather than silently stripped.
 */
export function normalizeOrdinaryCoCCharacterSheet(input: unknown): OrdinarySnapshotJson {
  const record = dataRecord(input, "character sheet");
  const candidate: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "occupationSkillKeys" && record[key] === undefined) continue;
    // Preserve every caller-owned data key through the closed-sheet validator.
    // Bracket assignment would silently consume __proto__ before exact schema
    // validation had an opportunity to reject it.
    Object.defineProperty(candidate, key, { value: record[key], enumerable: true, configurable: true, writable: true });
  }
  return validateOrdinaryCoCCharacterSheet(candidate, "character sheet");
}

function validateComponentVersions(input: unknown): void {
  const record = exactRecord(input, "$.components", ["snapshot", "world", "playerSession", "politicoEconomy", "companionManager", "npcStore", "agentRegistry", "career"]);
  for (const [key, expected] of Object.entries(ORDINARY_GAME_SESSION_COMPONENT_VERSIONS)) {
    if (record[key] !== expected) fail(`$.components.${key} is unsupported`);
  }
}

function validatePreviousComponentVersions(input: unknown): void {
  const record = exactRecord(input, "$.components", ["snapshot", "world", "playerSession", "politicoEconomy", "companionManager", "npcStore", "agentRegistry", "career"]);
  for (const [key, expected] of Object.entries(PREVIOUS_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS)) {
    if (record[key] !== expected) fail(`$.components.${key} is unsupported for v1.3`);
  }
}

function validateScalarComponentVersions(input: unknown): void {
  const record = exactRecord(input, "$.components", ["snapshot", "world", "playerSession", "politicoEconomy", "companionManager", "npcStore", "agentRegistry", "career"]);
  for (const [key, expected] of Object.entries(SCALAR_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS)) {
    if (record[key] !== expected) fail(`$.components.${key} is unsupported for v1.2`);
  }
}

function validateHistoricalComponentVersions(input: unknown): void {
  const record = exactRecord(input, "$.components", ["snapshot", "world", "playerSession", "politicoEconomy", "companionManager", "npcStore", "agentRegistry"]);
  for (const [key, expected] of Object.entries(HISTORICAL_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS)) {
    if (record[key] !== expected) fail(`$.components.${key} is unsupported for historical v1.1`);
  }
}

function validateLegacyComponentVersions(input: unknown): void {
  const record = exactRecord(input, "$.components", ["snapshot", "world", "playerSession", "politicoEconomy", "companionManager", "npcStore", "agentRegistry"]);
  for (const [key, expected] of Object.entries(LEGACY_ORDINARY_GAME_SESSION_COMPONENT_VERSIONS)) {
    if (record[key] !== expected) fail(`$.components.${key} is unsupported for legacy v1`);
  }
}

function validateCompleteCareerProjection(input: unknown): Extract<OrdinaryCareerProjection, { mode: "complete" }> {
  const record = exactRecord(input, "$.career", ["mode", "projection"]);
  if (record.mode !== "complete") fail("$.career.mode must be complete for snapshot v1.2");
  try {
    return { mode: "complete", projection: validateCareerPortableProjection(record.projection) };
  } catch (error) {
    fail(`$.career.projection is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateCurrentCareerProjection(input: unknown): Extract<OrdinaryCareerProjection, { mode: "complete" | "transient" }> {
  const record = dataRecord(input, "$.career");
  if (record.mode === "transient") {
    exactRecord(record, "$.career", ["mode"]);
    return { mode: "transient" };
  }
  return validateCompleteCareerProjection(record);
}

function validateCompleteCareerProjectionInvariants(
  projection: CareerPortableProjection,
  state: Pick<OrdinaryGameSessionSnapshotState, "characters">,
): void {
  const records = new Map(projection.records.map((record) => [record.characterName, record]));
  const activeNames = new Set<string>();
  for (const character of state.characters) {
    if (!isRecord(character.sheet) || typeof character.sheet.name !== "string") {
      fail(`career-bound character ${character.pcId} lacks a validated sheet name`);
    }
    const name = character.sheet.name;
    if (activeNames.has(name)) fail(`career-bound character identity "${name}" is duplicated by the active party`);
    activeNames.add(name);
    const record = records.get(name);
    if (!record || record.base === null) fail(`active character ${character.pcId} lacks a bound complete career base`);
  }
}

function validateSession(input: unknown): OrdinaryGameSessionSnapshot["session"] {
  const record = exactRecord(input, "$.session", ["id", "createdAt", "lastActiveAt", "ruleset", "access"]);
  const id = identifier(record.id, "$.session.id");
  const createdAt = integer(record.createdAt, "$.session.createdAt", 0);
  const lastActiveAt = integer(record.lastActiveAt, "$.session.lastActiveAt", createdAt);
  if (typeof record.ruleset !== "string" || !RULESETS.has(record.ruleset)) fail("$.session.ruleset is invalid");
  if (record.ruleset !== "cosmic-horror") fail("$.session.ruleset is currently unsupported for portable ordinary snapshots");
  if (record.access !== null && !isOrdinarySessionAccessBinding(record.access)) fail("$.session.access is invalid");
  return {
    id,
    createdAt,
    lastActiveAt,
    ruleset: record.ruleset as OrdinaryGameSessionSnapshot["session"]["ruleset"],
    access: record.access === null ? null : structuredClone(record.access),
  };
}

function validateModule(input: unknown): OrdinaryGameSessionSnapshot["module"] {
  const record = exactRecord(input, "$.module", ["package", "contentHash"]);
  if (record.package === null) {
    if (record.contentHash !== null) fail("$.module.contentHash must be null without a package");
    return { package: null, contentHash: null };
  }
  if (record.contentHash === null || typeof record.contentHash !== "string" || !HASH_PATTERN.test(record.contentHash)) {
    fail("$.module.contentHash must be a sha256 digest");
  }
  try {
    assertRuntimeModulePackage(record.package);
  } catch (error) {
    fail(`$.module.package is not an installable RuntimeModulePackage: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (record.package.kind === "compiled_bundle") fail("$.module.package compiled bundles are not ordinary-session snapshots");
  const packageValue = structuredClone(record.package);
  if (ordinaryGameSessionModuleHash(packageValue) !== record.contentHash) fail("$.module.contentHash does not match package");
  return { package: packageValue, contentHash: record.contentHash };
}

function validateState(input: unknown, version: "current"): OrdinaryGameSessionSnapshotState;
function validateState(input: unknown, version: "previous"): LegacyTerminalOrdinaryGameSessionSnapshotState;
function validateState(input: unknown, version: "scalar"): ScalarWoundsOrdinaryGameSessionSnapshotState;
function validateState(input: unknown, version: "legacy"): LegacyOrdinaryGameSessionSnapshot["state"];
function validateState(input: unknown, version: "current" | "previous" | "scalar" | "legacy"): OrdinaryGameSessionSnapshotState | LegacyTerminalOrdinaryGameSessionSnapshotState | ScalarWoundsOrdinaryGameSessionSnapshotState | LegacyOrdinaryGameSessionSnapshot["state"] {
  const growthMarksKey = version === "legacy" ? "skillGrowthMarks" : "skillGrowthMarksByPC";
  const woundsTreatedKey = version === "current" || version === "previous" ? "woundsTreatedByPC" : "woundsTreated";
  const record = exactRecord(input, "$.state", [
    "activePlayerId", "activeCharacterId", "round", "dead", "combatActive", "pendingCompoundMoves", "pendingLeaveConfirm",
    "characters", "sanities", "party", "sceneItems", "sceneDisplayNames", "sceneAliases", "sceneBgm", "lastNarrative",
    "lastDiceRoll", "lastRolls", "gameTime", "activeDifficulty", growthMarksKey, "skillMarks", woundsTreatedKey,
    "moduleStartByPC", "growthChangesByPC", "mythosSpells", "moduleItemDescriptions", "moduleKpNotes", "moduleRewards",
    "knownMythosSpells", "lastPushedRoll", "p1Persona", "sightedMythos",
    ...(version === "current" ? ["terminal"] : []),
  ]);
  const characters = array(record.characters, "$.state.characters", 16).map((entry, index) => {
    const item = exactRecord(entry, `$.state.characters[${index}]`, ["pcId", "sheet"]);
    return { pcId: identifier(item.pcId, `$.state.characters[${index}].pcId`), sheet: validateOrdinaryCoCCharacterSheet(item.sheet, `$.state.characters[${index}].sheet`) };
  });
  unique(characters, (entry) => entry.pcId, "$.state.characters");
  const sanities = array(record.sanities, "$.state.sanities", 16).map((entry, index) => {
    const item = exactRecord(entry, `$.state.sanities[${index}]`, ["pcId", "state"]);
    return { pcId: identifier(item.pcId, `$.state.sanities[${index}].pcId`), state: validateSanity(item.state, `$.state.sanities[${index}].state`) };
  });
  unique(sanities, (entry) => entry.pcId, "$.state.sanities");
  const party = array(record.party, "$.state.party", 16).map((entry, index) => {
    const item = exactRecord(entry, `$.state.party[${index}]`, ["pcId", "control", "meta"]);
    const control = controlValue(item.control, `$.state.party[${index}].control`);
    return { pcId: identifier(item.pcId, `$.state.party[${index}].pcId`), control, meta: item.meta === null ? null : validatePlayerMeta(item.meta, `$.state.party[${index}].meta`) };
  });
  unique(party, (entry) => entry.pcId, "$.state.party");

  const sceneItems = array(record.sceneItems, "$.state.sceneItems", MAX_ENTRIES).map((entry, index) => {
    const item = exactRecord(entry, `$.state.sceneItems[${index}]`, ["sceneId", "items"]);
    return { sceneId: identifier(item.sceneId, `$.state.sceneItems[${index}].sceneId`), items: stringArray(item.items, `$.state.sceneItems[${index}].items`, 4096, true) };
  });
  unique(sceneItems, (entry) => entry.sceneId, "$.state.sceneItems");
  const pendingCompoundMoves = array(record.pendingCompoundMoves, "$.state.pendingCompoundMoves", 16).map((entry, index) => {
    const item = exactRecord(entry, `$.state.pendingCompoundMoves[${index}]`, ["pcId", "originalInput", "originalIntent"]);
    return {
      pcId: identifier(item.pcId, `$.state.pendingCompoundMoves[${index}].pcId`),
      originalInput: text(item.originalInput, `$.state.pendingCompoundMoves[${index}].originalInput`),
      originalIntent: validateActionIntent(item.originalIntent, `$.state.pendingCompoundMoves[${index}].originalIntent`),
    };
  });
  unique(pendingCompoundMoves, (entry) => entry.pcId, "$.state.pendingCompoundMoves");

  const lastDiceRoll = record.lastDiceRoll === null ? null : validateLastDiceRoll(record.lastDiceRoll);
  const lastRolls = array(record.lastRolls, "$.state.lastRolls", 100_000).map((entry, index) => validateRoll(entry, `$.state.lastRolls[${index}]`));
  const gameTime = validateGameTime(record.gameTime);
  const activeDifficulty = record.activeDifficulty === null ? null : difficulty(record.activeDifficulty, "$.state.activeDifficulty");
  const skillGrowthMarksByPC = version !== "legacy"
    ? array(record.skillGrowthMarksByPC, "$.state.skillGrowthMarksByPC", 16).map((entry, index) => {
      const item = exactRecord(entry, `$.state.skillGrowthMarksByPC[${index}]`, ["pcId", "skills"]);
      return {
        pcId: identifier(item.pcId, `$.state.skillGrowthMarksByPC[${index}].pcId`),
        skills: stringArray(item.skills, `$.state.skillGrowthMarksByPC[${index}].skills`, 4096, true),
      };
    })
    : undefined;
  if (skillGrowthMarksByPC) unique(skillGrowthMarksByPC, (entry) => entry.pcId, "$.state.skillGrowthMarksByPC");
  if (skillGrowthMarksByPC?.some((entry) => entry.skills.length === 0)) fail("$.state.skillGrowthMarksByPC owners must not have empty skills");
  const legacySkillGrowthMarks = version === "legacy"
    ? stringArray(record.skillGrowthMarks, "$.state.skillGrowthMarks", 4096)
    : undefined;
  const moduleStartByPC = array(record.moduleStartByPC, "$.state.moduleStartByPC", 16).map((entry, index) => {
    const item = exactRecord(entry, `$.state.moduleStartByPC[${index}]`, ["pcId", "san", "cm"]);
    return { pcId: identifier(item.pcId, `$.state.moduleStartByPC[${index}].pcId`), san: integer(item.san, `$.state.moduleStartByPC[${index}].san`, 0, 100), cm: integer(item.cm, `$.state.moduleStartByPC[${index}].cm`, 0, 99) };
  });
  unique(moduleStartByPC, (entry) => entry.pcId, "$.state.moduleStartByPC");
  const growthChangesByPC = array(record.growthChangesByPC, "$.state.growthChangesByPC", 16).map((entry, index) => {
    const item = exactRecord(entry, `$.state.growthChangesByPC[${index}]`, ["pcId", "changes"]);
    return { pcId: identifier(item.pcId, `$.state.growthChangesByPC[${index}].pcId`), changes: stringArray(item.changes, `$.state.growthChangesByPC[${index}].changes`, 4096) };
  });
  unique(growthChangesByPC, (entry) => entry.pcId, "$.state.growthChangesByPC");
  const mythosSpells = array(record.mythosSpells, "$.state.mythosSpells", 4096).map((entry, index) => {
    const item = exactOptionalRecord(entry, `$.state.mythosSpells[${index}]`, ["name", "sanCost", "mpCost", "description"], ["effect"]);
    const result: { name: string; sanCost: string; mpCost: number; description: string; effect?: string } = {
      name: identifier(item.name, `$.state.mythosSpells[${index}].name`), sanCost: text(item.sanCost, `$.state.mythosSpells[${index}].sanCost`),
      mpCost: integer(item.mpCost, `$.state.mythosSpells[${index}].mpCost`, 0, 1_000_000), description: text(item.description, `$.state.mythosSpells[${index}].description`),
    };
    if (hasOwn.call(item, "effect")) result.effect = text(item.effect, `$.state.mythosSpells[${index}].effect`);
    return result;
  });
  unique(mythosSpells, (entry) => entry.name, "$.state.mythosSpells");

  const moduleItemDescriptions = descriptionEntries(record.moduleItemDescriptions, "$.state.moduleItemDescriptions");
  const moduleKpNotes = noteEntries(record.moduleKpNotes, "$.state.moduleKpNotes");
  const moduleRewards = array(record.moduleRewards, "$.state.moduleRewards", 4096).map((entry, index) => {
    const item = exactRecord(entry, `$.state.moduleRewards[${index}]`, ["id", "reward"]);
    return { id: identifier(item.id, `$.state.moduleRewards[${index}].id`), reward: json(item.reward, `$.state.moduleRewards[${index}].reward`) };
  });
  unique(moduleRewards, (entry) => entry.id, "$.state.moduleRewards");
  const lastPushedRoll = record.lastPushedRoll === null ? null : validatePushedRoll(record.lastPushedRoll);

  if (typeof record.dead !== "boolean" || typeof record.combatActive !== "boolean" || typeof record.pendingLeaveConfirm !== "boolean") {
    fail("$.state boolean field is invalid");
  }
  const woundsTreatedByPC = version === "current" || version === "previous"
    ? stringArray(record.woundsTreatedByPC, "$.state.woundsTreatedByPC", 16, true)
    : undefined;
  if (version !== "current" && version !== "previous" && typeof record.woundsTreated !== "boolean") fail("$.state.woundsTreated must be boolean");
  const activeCharacterId = record.activeCharacterId === null ? null : identifier(record.activeCharacterId, "$.state.activeCharacterId");
  const state = {
    activePlayerId: identifier(record.activePlayerId, "$.state.activePlayerId"), activeCharacterId,
    round: integer(record.round, "$.state.round", 0), dead: record.dead, combatActive: record.combatActive,
    pendingCompoundMoves, pendingLeaveConfirm: record.pendingLeaveConfirm, characters, sanities, party, sceneItems,
    sceneDisplayNames: stringRecord(record.sceneDisplayNames, "$.state.sceneDisplayNames"),
    sceneAliases: stringArrayRecord(record.sceneAliases, "$.state.sceneAliases"),
    sceneBgm: stringRecord(record.sceneBgm, "$.state.sceneBgm"), lastNarrative: text(record.lastNarrative, "$.state.lastNarrative"),
    lastDiceRoll, lastRolls, gameTime, activeDifficulty,
    skillMarks: finiteNumberRecord(record.skillMarks, "$.state.skillMarks"),
    moduleStartByPC, growthChangesByPC, mythosSpells, moduleItemDescriptions, moduleKpNotes, moduleRewards,
    knownMythosSpells: stringArray(record.knownMythosSpells, "$.state.knownMythosSpells", 4096, true),
    lastPushedRoll, p1Persona: record.p1Persona === null ? null : validatePlayerMeta(record.p1Persona, "$.state.p1Persona"),
    sightedMythos: stringArray(record.sightedMythos, "$.state.sightedMythos", 4096, true),
  };
  if (version === "legacy") return { ...state, woundsTreated: record.woundsTreated as boolean, skillGrowthMarks: legacySkillGrowthMarks! };
  if (version === "scalar") return { ...state, woundsTreated: record.woundsTreated as boolean, skillGrowthMarksByPC: skillGrowthMarksByPC! };
  if (version === "previous") return { ...state, woundsTreatedByPC: woundsTreatedByPC!, skillGrowthMarksByPC: skillGrowthMarksByPC! };
  return { ...state, terminal: validateOrdinarySessionTerminal(record.terminal, "$.state.terminal"), woundsTreatedByPC: woundsTreatedByPC!, skillGrowthMarksByPC: skillGrowthMarksByPC! };
}

export function validateOrdinarySessionTerminal(input: unknown, path = "terminal"): OrdinarySessionTerminal {
  if (input === null) return null;
  const record = dataRecord(input, path);
  if (record.kind === "death") {
    exactRecord(record, path, ["kind"]);
    return { kind: "death" };
  }
  if (record.kind === "legacy_unknown") {
    exactRecord(record, path, ["kind"]);
    return { kind: "legacy_unknown" };
  }
  if (record.kind === "module_departure") {
    exactRecord(record, path, ["kind", "endingId", "endingName"]);
    return {
      kind: "module_departure",
      endingId: identifier(record.endingId, `${path}.endingId`),
      endingName: text(record.endingName, `${path}.endingName`, 256),
    };
  }
  fail(`${path}.kind is invalid`);
}

function validateCrossComponentInvariants(
  snapshot: Omit<OrdinaryGameSessionSnapshot, "snapshotHash">
    | Omit<PreviousOrdinaryGameSessionSnapshot, "snapshotHash">
    | Omit<ScalarOrdinaryGameSessionSnapshot, "snapshotHash">
    | Omit<HistoricalOrdinaryGameSessionSnapshot, "snapshotHash">
    | Omit<LegacyOrdinaryGameSessionSnapshot, "snapshotHash">,
): void {
  const { state, world, playerSession, companionManager, npcStore, agentRegistry } = snapshot;
  if ("terminal" in state) {
    if (state.terminal?.kind === "death" && !state.dead) fail("death terminal must set dead");
    if (state.terminal !== null && state.terminal.kind !== "death" && state.dead) fail("non-death terminal must not set dead");
    if (state.terminal === null && state.dead) fail("dead ordinary snapshot requires a death terminal");
  }
  if (snapshot.module.package === null) {
    if (state.sceneItems.length !== 0 || Object.keys(state.sceneDisplayNames).length !== 0 || Object.keys(state.sceneAliases).length !== 0
      || Object.keys(state.sceneBgm).length !== 0 || state.moduleItemDescriptions.length !== 0 || state.moduleKpNotes.length !== 0
      || state.moduleRewards.length !== 0 || state.moduleStartByPC.length !== 0 || state.growthChangesByPC.length !== 0
      || state.mythosSpells.length !== 0 || state.knownMythosSpells.length !== 0
      || world.tables.clue_discoveries.length !== 0 || world.tables.clue_fail_counts.length !== 0
      || world.tables.scene_visits.length !== 0) {
      fail("module-derived state is present without an installed ordinary module package");
    }
  }
  const playerIds = new Set(playerSession.players.map((player) => player.name));
  if (playerIds.size !== playerSession.players.length || playerIds.size === 0) fail("player-session player identities are invalid");
  if (!playerIds.has(state.activePlayerId) || playerSession.activePlayerName !== state.activePlayerId) fail("active player disagrees with PlayerSession");
  for (const player of playerSession.players) if (player.characterId !== player.name) fail(`player ${player.name} characterId is not its pcId`);

  const characterIds = new Set(state.characters.map((entry) => entry.pcId));
  const sanityById = new Map(state.sanities.map((entry) => [entry.pcId, entry.state]));
  const partyById = new Map(state.party.map((entry) => [entry.pcId, entry]));
  if (!sameSet(new Set(state.sanities.map((entry) => entry.pcId)), playerIds)) fail("sanity identities disagree with PlayerSession");
  if (!sameSet(characterIds, new Set(partyById.keys()))) fail("characters and party identities disagree");
  for (const id of characterIds) if (!playerIds.has(id) || !sanityById.has(id)) fail(`character ${id} lacks PlayerSession or sanity state`);
  if ((state.activeCharacterId === null) !== !characterIds.has(state.activePlayerId)) fail("activeCharacterId disagrees with active character membership");
  if (state.activeCharacterId !== null && state.activeCharacterId !== state.activePlayerId) fail("activeCharacterId is not the active player");
  for (const pending of state.pendingCompoundMoves) if (!characterIds.has(pending.pcId)) fail(`pending compound move references unknown character ${pending.pcId}`);
  for (const baseline of state.moduleStartByPC) if (!characterIds.has(baseline.pcId)) fail(`module baseline references unknown character ${baseline.pcId}`);
  for (const growth of state.growthChangesByPC) if (!characterIds.has(growth.pcId)) fail(`growth changes reference unknown character ${growth.pcId}`);
  if ("skillGrowthMarksByPC" in state) {
    for (const marks of state.skillGrowthMarksByPC) {
      if (!characterIds.has(marks.pcId)) fail(`growth mark owner references unknown character ${marks.pcId}`);
    }
  }
  if ("woundsTreatedByPC" in state) {
    for (const pcId of state.woundsTreatedByPC) {
      if (!characterIds.has(pcId)) fail(`treatment recovery owner references unknown character ${pcId}`);
    }
  }
  const spellNames = new Set(state.mythosSpells.map((spell) => spell.name));
  for (const knownSpell of state.knownMythosSpells) if (!spellNames.has(knownSpell)) fail(`known spell ${knownSpell} lacks a runtime spell definition`);

  const worldPcs = new Map(world.tables.entities.filter((entity) => entity.type === "pc").map((entity) => [entity.id, entity]));
  // A public ordinary session is born with a p1 PlayerSession slot and a
  // player_state row before character creation.  It intentionally has no
  // WorldEntity/party/character-sheet yet.  Once a character exists, however,
  // its world PC entity is mandatory.  Comparing entities to PlayerSession
  // directly therefore made valid server-created pre-character sessions
  // impossible to checkpoint.
  if (!sameSet(new Set(worldPcs.keys()), characterIds)) fail("world pc entities disagree with character state");
  for (const discovery of world.tables.clue_discoveries) {
    if (!playerIds.has(discovery.player_id)) fail(`clue discovery references unknown player ${discovery.player_id}`);
  }
  for (const visit of world.tables.scene_visits) {
    if (!playerIds.has(visit.player_id)) fail(`scene visit references unknown player ${visit.player_id}`);
  }
  const worldSanity = new Map(world.tables.player_state.map((entry) => [entry.entity_id, entry.sanity]));
  // `player_state` is the durable mutable authority for every PlayerSession
  // slot, including the pre-character p1 placeholder.  It must be the exact
  // same cohort, not merely a superset: registerPlayer deliberately uses
  // INSERT OR IGNORE, so an unreferenced row for a future pcId would otherwise
  // survive until a later party creation inherited its inventory/SAN/equipment.
  if (!sameSet(new Set(worldSanity.keys()), playerIds)) {
    fail("world player-state identities disagree with PlayerSession");
  }
  for (const id of playerIds) {
    const entity = worldPcs.get(id);
    const sanity = sanityById.get(id);
    if (!sanity || !worldSanity.has(id) || canonicalJson(worldSanity.get(id)) !== canonicalJson(sanity)) fail(`world sanity disagrees for ${id}`);
    const character = state.characters.find((entry) => entry.pcId === id);
    if (character) {
      if (!entity) fail(`character ${id} lacks its world pc entity`);
      validateCharacterWorldProjection(character.sheet, entity, id);
    }
  }

  validateCompanionSnapshotWorld(companionManager, {
    getEntity(entityId: string): WorldEntity | null {
      const entity = world.tables.entities.find((candidate) => candidate.id === entityId);
      if (!entity) return null;
      return {
        id: entity.id, name: entity.name, type: entity.type, hp: entity.hp, maxHp: entity.max_hp, ac: entity.ac,
        status: [...entity.status], position: entity.position, faction: entity.faction ?? undefined,
        attributes: structuredClone(entity.attributes), scene_id: entity.scene_id ?? undefined,
      } as WorldEntity;
    },
  });

  const personalitiesByName = new Map<string, typeof npcStore.tables.npc_personalities>();
  for (const personality of npcStore.tables.npc_personalities) {
    const existing = personalitiesByName.get(personality.name) ?? [];
    existing.push(personality);
    personalitiesByName.set(personality.name, existing);
  }
  for (const agent of agentRegistry.agents) {
    const persistent = personalitiesByName.get(agent.personality.name);
    if (!persistent || persistent.length !== 1) fail(`active registry NPC ${agent.personality.name} lacks one persistent personality`);
    validateAgentPersonalityMatchesStore(agent.personality, persistent[0]!);
    validateAgentRuntimeCohortMatchesStore(agent, persistent[0]!, npcStore);
  }
}

function validateCharacterWorldProjection(sheet: OrdinarySnapshotJson, entity: WorldStateSnapshot["tables"]["entities"][number], pcId: string): void {
  if (!isRecord(sheet)) fail(`character ${pcId} sheet must be an object`);
  if (typeof sheet.name !== "string" || sheet.name !== entity.name) fail(`world pc ${pcId} name disagrees with character`);
  for (const [sheetKey, worldValue] of [["hp", entity.hp], ["maxHp", entity.max_hp]] as const) {
    if (typeof sheet[sheetKey] !== "number" || sheet[sheetKey] !== worldValue) fail(`world pc ${pcId} ${sheetKey} disagrees with character`);
  }
}

function validateOrdinaryCoCCharacterSheet(input: unknown, path: string): OrdinarySnapshotJson {
  const record = exactOptionalRecord(normalizeJson(input, path, { nodes: 0 }), path, COC_SHEET_REQUIRED_KEYS, COC_SHEET_OPTIONAL_KEYS);
  const attributes = exactRecord(record.attributes, `${path}.attributes`, COC_ATTRIBUTES);
  const skillValues = exactRecord(record.skillValues, `${path}.skillValues`, COC_SKILL_KEYS);
  for (const attribute of COC_ATTRIBUTES) integer(attributes[attribute], `${path}.attributes.${attribute}`, 1, 100);
  for (const skill of COC_SKILL_KEYS) integer(skillValues[skill], `${path}.skillValues.${skill}`, 0, 100);
  if (typeof record.valid !== "boolean") fail(`${path}.valid must be boolean`);
  const result: Record<string, OrdinarySnapshotJson> = {
    name: identifier(record.name, `${path}.name`),
    archetypeId: identifier(record.archetypeId, `${path}.archetypeId`),
    attributes: attributes as Record<string, OrdinarySnapshotJson>,
    luck: integer(record.luck, `${path}.luck`, 0, 1_000_000),
    hp: integer(record.hp, `${path}.hp`, 0, 1_000_000),
    maxHp: integer(record.maxHp, `${path}.maxHp`, 0, 1_000_000),
    ac: integer(record.ac, `${path}.ac`, 0, 1_000_000),
    damageBonus: text(record.damageBonus, `${path}.damageBonus`, 128),
    build: integer(record.build, `${path}.build`, COC_BUILD_RANGE.min, COC_BUILD_RANGE.max),
    move: integer(record.move, `${path}.move`, 0, 1_000_000),
    creditRating: integer(record.creditRating, `${path}.creditRating`, 0, 1_000_000),
    startingItems: stringArray(record.startingItems, `${path}.startingItems`, 128),
    occupationSkillPoints: integer(record.occupationSkillPoints, `${path}.occupationSkillPoints`, 0, 1_000_000),
    interestSkillPoints: integer(record.interestSkillPoints, `${path}.interestSkillPoints`, 0, 1_000_000),
    occupationSkills: stringArray(record.occupationSkills, `${path}.occupationSkills`, 128),
    availableSkills: stringArray(record.availableSkills, `${path}.availableSkills`, 256),
    age: integer(record.age, `${path}.age`, 0, 1_000_000),
    valid: record.valid,
    warnings: stringArray(record.warnings, `${path}.warnings`, 128),
    cthulhuMythos: integer(record.cthulhuMythos, `${path}.cthulhuMythos`, 0, 99),
    skillValues: skillValues as Record<string, OrdinarySnapshotJson>,
  };
  if ((result.hp as number) > (result.maxHp as number)) fail(`${path}.hp exceeds maxHp`);
  if (hasOwn.call(record, "occupationSkillKeys")) result.occupationSkillKeys = stringArray(record.occupationSkillKeys, `${path}.occupationSkillKeys`, 128);
  if (hasOwn.call(record, "backgroundProfile")) {
    const profile = exactRecord(record.backgroundProfile, `${path}.backgroundProfile`, BACKGROUND_PROFILE_KEYS);
    const safeProfile: Record<string, OrdinarySnapshotJson> = {};
    for (const key of BACKGROUND_PROFILE_KEYS) safeProfile[key] = text(profile[key], `${path}.backgroundProfile.${key}`);
    result.backgroundProfile = safeProfile;
  }
  if (hasOwn.call(record, "backstory")) result.backstory = text(record.backstory, `${path}.backstory`);
  return result;
}

function validatePlayerMeta(input: unknown, path: string): PlayerMeta {
  const record = exactOptionalRecord(normalizeJson(input, path, { nodes: 0 }), path, [], PLAYER_META_KEYS);
  const result: PlayerMeta = {};
  for (const key of PLAYER_META_KEYS) if (hasOwn.call(record, key)) result[key] = text(record[key], `${path}.${key}`);
  return result;
}

function validateActionIntent(input: unknown, path: string): import("../types").ActionIntent {
  try {
    return validateNormalSessionActionIntent(normalizeJson(input, path, { nodes: 0 }));
  } catch (error) {
    fail(`${path} is not an executable normal-session ActionIntent: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateAgentPersonalityMatchesStore(agent: AgentRegistrySnapshot["agents"][number]["personality"], row: NPCStoreSnapshot["tables"]["npc_personalities"][number]): void {
  const fields = ["name", "role", "personality", "background", "speech_style", "goals", "knowledge", "secrets"] as const;
  for (const field of fields) if (canonicalJson(agent[field]) !== canonicalJson(row[field])) fail(`registry personality ${agent.name} disagrees with NPCStore ${String(field)}`);
  if (canonicalJson(agent.attitudes ?? {}) !== canonicalJson(row.attitudes)
    || (agent.ruleset ?? "") !== row.ruleset
    || canonicalJson(agent.traits ?? {}) !== canonicalJson(row.traits)
    || canonicalJson(agent.factions ?? []) !== canonicalJson(row.factions)
    || (agent.initialMood ?? "neutral") !== row.initial_mood) {
    fail(`registry personality ${agent.name} disagrees with NPCStore optional fields`);
  }
}

/**
 * An ordinary-session envelope carries both the live AgentRegistry projection
 * and its NPCStore source. The two representations intentionally have
 * different retention and hydration shapes: an active cache can hold only a
 * bounded subset of durable memory rows, and absent state rows mean the
 * personality's initial mood with zero relationship/counter. Validate that
 * projection here, after each component's own parser has established its
 * exact wire shape and identity. Portable AgentRegistry snapshots remain
 * independently restorable and therefore do not use this cohort-only check.
 */
function validateAgentRuntimeCohortMatchesStore(
  agent: AgentRegistrySnapshot["agents"][number],
  personality: NPCStoreSnapshot["tables"]["npc_personalities"][number],
  store: NPCStoreSnapshot,
): void {
  // Production AgentRegistry and NPCStore both use the personality name as
  // the durable NPC identity. Keep this at the ordinary-envelope cohort
  // boundary: standalone NPCStore snapshots remain parseable for their own
  // broader transport use, but restoring one under an active registry must
  // never create an agent whose later writes target a missing durable row.
  if (personality.id !== agent.personality.name) {
    fail(`registry durable identity for ${agent.personality.name} disagrees with NPCStore`);
  }

  // Memory cache order cannot be compared to SQLite order: hydration reads
  // recent rows descending by timestamp while live retention may trim by
  // importance. Every exact live entry must instead consume one same-NPC
  // durable row, which prevents both forged entries and duplicate overuse.
  const durableMemoryCounts = new Map<string, number>();
  for (const memory of store.tables.npc_memories) {
    if (memory.npc_id !== personality.id) continue;
    const key = canonicalJson({
      timestamp: memory.timestamp,
      type: memory.type,
      content: memory.content,
      importance: memory.importance,
      scene_id: memory.scene_id,
      related_entities: memory.related_entities,
      is_summary: memory.is_summary === 1,
    });
    durableMemoryCounts.set(key, (durableMemoryCounts.get(key) ?? 0) + 1);
  }
  for (const memory of agent.memories) {
    const key = canonicalJson({
      timestamp: memory.timestamp,
      type: memory.type,
      content: memory.content,
      importance: memory.importance,
      // Agent MemoryEntry uses optional JSON fields; NPCStore writes their
      // canonical row defaults (empty string/array/false) explicitly.
      scene_id: memory.scene_id ?? "",
      related_entities: memory.related_entities ?? [],
      is_summary: memory.is_summary ?? false,
    });
    const remaining = durableMemoryCounts.get(key) ?? 0;
    if (remaining === 0) {
      fail(`registry runtime memories for ${agent.personality.name} are not backed by NPCStore`);
    }
    durableMemoryCounts.set(key, remaining - 1);
  }

  const persistentState = store.tables.npc_states.find((state) => state.npc_id === personality.id);
  const expectedMood = persistentState?.mood ?? personality.initial_mood;
  const expectedRelationship = persistentState?.relationship ?? 0;
  const expectedInteractionCount = persistentState?.player_interaction_count ?? 0;
  if (agent.mood !== expectedMood
    || agent.relationship !== expectedRelationship
    || agent.playerInteractionCount !== expectedInteractionCount) {
    fail(`registry runtime state for ${agent.personality.name} disagrees with NPCStore`);
  }

  // Player relationship history is optional only for a zero relationship
  // (for example a mood-only state transition writes no relationship row).
  // When present it is a second durable projection of agent/state relation
  // and must agree; this matches NPCStore's transition pre-state guard.
  const playerRelationship = store.tables.npc_relationships.find(
    (relationship) => relationship.npc_id === personality.id && relationship.target_name === "player",
  );
  if (!playerRelationship && expectedRelationship !== 0) {
    fail(`registry runtime state for ${agent.personality.name} requires an NPCStore player relationship`);
  }
  if (playerRelationship && playerRelationship.relationship !== expectedRelationship) {
    fail(`registry runtime state for ${agent.personality.name} disagrees with NPCStore player relationship`);
  }
}

function validateSanity(input: unknown, path: string): OrdinarySnapshotJson {
  return validateSanityState(input, path) as unknown as OrdinarySnapshotJson;
}

function validateLastDiceRoll(input: unknown): { expr: string; total: number; detail?: string; bonus?: number } {
  const record = exactOptionalRecord(input, "$.state.lastDiceRoll", ["expr", "total"], ["detail", "bonus"]);
  const result: { expr: string; total: number; detail?: string; bonus?: number } = { expr: text(record.expr, "$.state.lastDiceRoll.expr"), total: integer(record.total, "$.state.lastDiceRoll.total", -1_000_000, 1_000_000) };
  if (hasOwn.call(record, "detail")) result.detail = text(record.detail, "$.state.lastDiceRoll.detail");
  if (hasOwn.call(record, "bonus")) result.bonus = integer(record.bonus, "$.state.lastDiceRoll.bonus", -100, 100);
  return result;
}

function validateRoll(input: unknown, path: string): { skill: string; roll: number; target: number; success: boolean } {
  const record = exactRecord(input, path, ["skill", "roll", "target", "success"]);
  if (typeof record.success !== "boolean") fail(`${path}.success must be boolean`);
  return { skill: identifier(record.skill, `${path}.skill`), roll: integer(record.roll, `${path}.roll`, 1, 100), target: integer(record.target, `${path}.target`, 0, 100), success: record.success };
}

function validatePushedRoll(input: unknown): { skill: string; roll: number; target: number } {
  const record = exactRecord(input, "$.state.lastPushedRoll", ["skill", "roll", "target"]);
  return { skill: identifier(record.skill, "$.state.lastPushedRoll.skill"), roll: integer(record.roll, "$.state.lastPushedRoll.roll", 1, 100), target: integer(record.target, "$.state.lastPushedRoll.target", 0, 100) };
}

function validateGameTime(input: unknown): { day: number; period: string; ticks: number } {
  const record = exactRecord(input, "$.state.gameTime", ["day", "period", "ticks"]);
  const period = text(record.period, "$.state.gameTime.period", 32);
  if (!PERIODS.has(period)) fail("$.state.gameTime.period is invalid");
  return { day: integer(record.day, "$.state.gameTime.day", 1, 1_000_000), period, ticks: integer(record.ticks, "$.state.gameTime.ticks", 0, 2) };
}

function descriptionEntries(input: unknown, path: string): Array<{ id: string; description: string }> {
  const entries = array(input, path, 4096).map((entry, index) => {
    const item = exactRecord(entry, `${path}[${index}]`, ["id", "description"]);
    return { id: identifier(item.id, `${path}[${index}].id`), description: text(item.description, `${path}[${index}].description`) };
  });
  unique(entries, (entry) => entry.id, path);
  return entries;
}

function noteEntries(input: unknown, path: string): Array<{ id: string; note: string }> {
  const entries = array(input, path, 4096).map((entry, index) => {
    const item = exactRecord(entry, `${path}[${index}]`, ["id", "note"]);
    return { id: identifier(item.id, `${path}[${index}].id`), note: text(item.note, `${path}[${index}].note`) };
  });
  unique(entries, (entry) => entry.id, path);
  return entries;
}

function stringRecord(input: unknown, path: string): Record<string, string> {
  const record = dataRecord(input, path);
  const result: Record<string, string> = {};
  for (const key of Object.keys(record)) Object.defineProperty(result, identifier(key, `${path} key`), { value: text(record[key], `${path}.${key}`), enumerable: true, configurable: true, writable: true });
  return result;
}

function stringArrayRecord(input: unknown, path: string): Record<string, string[]> {
  const record = dataRecord(input, path);
  const result: Record<string, string[]> = {};
  for (const key of Object.keys(record)) Object.defineProperty(result, identifier(key, `${path} key`), { value: stringArray(record[key], `${path}.${key}`, 4096, true), enumerable: true, configurable: true, writable: true });
  return result;
}

function finiteNumberRecord(input: unknown, path: string): Record<string, number> {
  const record = dataRecord(input, path);
  const result: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path}.${key} must be a finite number`);
    Object.defineProperty(result, identifier(key, `${path} key`), { value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function controlValue(input: unknown, path: string): "auto" | `player:${string}` {
  const value = identifier(input, path);
  if (value === "auto") return value;
  if (!/^player:.+$/u.test(value)) fail(`${path} must be auto or player:<userId>`);
  return value as `player:${string}`;
}

function difficulty(input: unknown, path: string): "easy" | "medium" | "hard" | "nightmare" {
  if (typeof input !== "string" || !DIFFICULTIES.has(input)) fail(`${path} is invalid`);
  return input as "easy" | "medium" | "hard" | "nightmare";
}

function normalizeJson(input: unknown, path: string, budget: { nodes: number }, depth = 0): OrdinarySnapshotJson {
  if (++budget.nodes > MAX_NODES) fail(`${path} exceeds node bound`);
  if (depth > MAX_DEPTH) fail(`${path} exceeds nesting bound`);
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") return text(input, path);
  if (typeof input === "number") {
    if (!Number.isFinite(input)) fail(`${path} contains a non-finite number`);
    return input;
  }
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length) fail(`${path} must be a plain array without symbols`);
    if (input.length > MAX_ENTRIES) fail(`${path} exceeds array bound`);
    for (const key of Object.getOwnPropertyNames(input)) {
      if (key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length || !descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${path} must be a dense enumerable data array`);
    }
    const result: OrdinarySnapshotJson[] = [];
    for (let index = 0; index < input.length; index++) {
      if (!hasOwn.call(input, index)) fail(`${path}[${index}] must not be sparse`);
      result.push(normalizeJson(input[index], `${path}[${index}]`, budget, depth + 1));
    }
    return result;
  }
  if (!isRecord(input) || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) fail(`${path} must be a plain object without symbols`);
  const names = Object.getOwnPropertyNames(input);
  if (names.length > MAX_ENTRIES) fail(`${path} exceeds object member bound`);
  const result: { [key: string]: OrdinarySnapshotJson } = {};
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${path}.${key} must be an enumerable data property`);
    Object.defineProperty(result, key, { value: normalizeJson(descriptor.value, `${path}.${key}`, budget, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function dropOptionalUndefined(input: unknown, path: string, budget: { nodes: number }, depth = 0): unknown {
  if (++budget.nodes > MAX_NODES) fail(`${path} exceeds node bound`);
  if (depth > MAX_DEPTH) fail(`${path} exceeds nesting bound`);
  if (input === null || typeof input === "boolean" || typeof input === "string" || typeof input === "number") return input;
  if (input === undefined) fail(`${path} must not be undefined`);
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length || input.length > MAX_ENTRIES) fail(`${path} must be a bounded plain array without symbols`);
    const result: unknown[] = [];
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.value === undefined) fail(`${path}[${index}] must be defined enumerable data`);
      result.push(dropOptionalUndefined(descriptor.value, `${path}[${index}]`, budget, depth + 1));
    }
    if (Object.getOwnPropertyNames(input).some((key) => key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length))) fail(`${path} must be dense`);
    return result;
  }
  if (!isRecord(input) || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) fail(`${path} must be a plain object without symbols`);
  const result: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${path}.${key} must be an enumerable data property`);
    if (descriptor.value !== undefined) result[key] = dropOptionalUndefined(descriptor.value, `${path}.${key}`, budget, depth + 1);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("non-plain JSON object");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function hash(domain: string, value: OrdinarySnapshotJson): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalJson(value)).digest("hex")}`;
}

function exactRecord(input: unknown, path: string, keys: readonly string[]): UnknownRecord {
  const record = dataRecord(input, path);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${path} has unexpected or missing keys`);
  return record;
}

function exactOptionalRecord(input: unknown, path: string, required: readonly string[], optional: readonly string[]): UnknownRecord {
  const record = dataRecord(input, path);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || required.some((key) => !hasOwn.call(record, key))) fail(`${path} has unexpected or missing keys`);
  return record;
}

function dataRecord(input: unknown, path: string): UnknownRecord {
  if (!isRecord(input) || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) fail(`${path} must be a plain object without symbols`);
  for (const key of Object.getOwnPropertyNames(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${path}.${key} must be an enumerable data property`);
  }
  return input;
}

function array(input: unknown, path: string, maximum: number): OrdinarySnapshotJson[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length || input.length > maximum) fail(`${path} must be a bounded plain array`);
  for (const key of Object.getOwnPropertyNames(input)) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length || !descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${path} must be a dense enumerable data array`);
  }
  for (let index = 0; index < input.length; index++) if (!hasOwn.call(input, index)) fail(`${path}[${index}] must not be sparse`);
  return input;
}

function json(input: unknown, path: string): OrdinarySnapshotJson {
  return normalizeJson(input, path, { nodes: 0 });
}

function text(input: unknown, path: string, maximum = MAX_STRING): string {
  if (typeof input !== "string" || input.length > maximum) fail(`${path} must be a bounded string`);
  return input;
}

function identifier(input: unknown, path: string): string {
  const value = text(input, path, 256);
  if (!value) fail(`${path} must not be empty`);
  return value;
}

function integer(input: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > maximum) fail(`${path} must be a safe integer in bounds`);
  return input;
}

function stringArray(input: unknown, path: string, maximum: number, uniqueValues = false): string[] {
  const result = array(input, path, maximum).map((value, index) => text(value, `${path}[${index}]`));
  if (uniqueValues && new Set(result).size !== result.length) fail(`${path} must not contain duplicates`);
  return result;
}

function unique<T>(values: readonly T[], key: (value: T) => string, path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) fail(`${path} contains a duplicate ${id}`);
    seen.add(id);
  }
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid ordinary game-session snapshot: ${message}`);
}
