import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeSync } from "fs";
import { basename, join, resolve } from "path";
import { COC_ATTRIBUTES, SKILL_NAME_MAP } from "../character/coc-character";
import { COC_BUILD_RANGE } from "../rules/coc-engine";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import {
  createMechanicsStateBudget,
  executeMechanicsAction,
  mechanicsStateHash,
  normalizeMechanicsState,
  settleAutomaticMechanics,
  settleInitialMechanics,
  type MechanicsCombatOutcome,
  type MechanicsReachabilityEdge,
  type MechanicsState,
  type SelectedActorEffect,
} from "../compiler/mechanics-execution";
import { COMPILER_ARTIFACT_CATALOG_ID_PATTERN } from "../compiler/compiler-artifact-catalog";
import { MECHANICS_IR_SCHEMA_VERSION, type CombatDamageSpec, type SanityCheckSettlement, type TerminalRewardSettlement } from "../compiler/mechanics-ir";
import { sha256 } from "../ingest/document-ir";
import {
  COMPILED_SESSION_SNAPSHOT_COORDINATOR_SCHEMA_VERSION,
  CompiledSessionSnapshotCoordinator,
  SnapshotCoordinatorFailure,
  type SnapshotCoordinatorPolicy,
  type CompiledSessionSnapshotCoordinatorLike,
} from "./compiled-session-snapshot-coordinator";
import {
  consumeSessionNamespacePublication,
  type SessionNamespacePublicationGate,
  type SessionNamespaceStorePublication,
} from "./session-namespace-publication";

export const COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION = "3.4.0";
/** Stable namespace fingerprint format, independent from body schema revisions. */
export const COMPILED_SESSION_NAMESPACE_IDENTITY_FORMAT = "compiled-session-snapshot-v1";
export const COMPILED_SESSION_COMPONENT_VERSIONS = Object.freeze({ snapshot: "3.4.0", mechanics: MECHANICS_IR_SCHEMA_VERSION, gameSession: "3.4.0" });
/** 3.3 snapshots remain byte-for-byte legacy values: do not rehash or relabel them. */
const PREVIOUS_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION = "3.3.0";
const PREVIOUS_COMPILED_SESSION_COMPONENT_VERSIONS = Object.freeze({ snapshot: "3.3.0", mechanics: MECHANICS_IR_SCHEMA_VERSION, gameSession: "3.3.0" });
const LEGACY_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION = "3.2.0";
const LEGACY_COMPILED_SESSION_COMPONENT_VERSIONS = Object.freeze({ snapshot: "3.2.0", mechanics: MECHANICS_IR_SCHEMA_VERSION, gameSession: "3.2.0" });
const OLDEST_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION = "3.1.0";
const OLDEST_COMPILED_SESSION_COMPONENT_VERSIONS = Object.freeze({ snapshot: "3.1.0", mechanics: MECHANICS_IR_SCHEMA_VERSION, gameSession: "3.1.0" });
const ANCIENT_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION = "2.9.0";
const ANCIENT_COMPILED_SESSION_COMPONENT_VERSIONS = Object.freeze({ snapshot: "2.9.0", mechanics: MECHANICS_IR_SCHEMA_VERSION, gameSession: "2.9.0" });
export const COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION = "1.5.0";
const PREVIOUS_COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION = "1.4.0";
const LEGACY_COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION = "1.3.0";
export const COMPILED_SESSION_ACCESS_BINDING_SCHEMA_VERSION = "3.0.0";
const LEGACY_COMPILED_SESSION_ACCESS_BINDING_SCHEMA_VERSION = "2.0.0";
export const COMPILED_SESSION_HEADER_MAX_BYTES = 4096;
export const COMPILED_SESSION_BODY_MAX_BYTES = 1024 * 1024;
export const COMPILED_SESSION_JSON_MAX_DEPTH = 64;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export interface CompiledSessionBundleRef {
  id: string;
  moduleId: string;
  artifactHash: string;
  mechanicsHash: string;
  bundleHash: string;
}

/**
 * Durable authorization metadata for an HTTP-created compiled session.
 *
 * The value deliberately carries no credential or raw host identity. The
 * server compares the host-authenticated principal's derived fingerprint
 * before serving an HTTP runtime route. `null` is permitted for direct
 * in-process fixtures, but is never an authorized HTTP session state.
 */
export interface CompiledSessionPlayerGrant {
  pcId: "p1";
  role: "player";
  /** Derived from a host identity at creation; never a raw subject or credential. */
  principalFingerprint: string;
}

/**
 * Server-issued browser delivery binding for the one compiled p1 façade.
 * It contains only an irreversible invite verifier and expiry; claim state is
 * held in a separate digest-only store so an invitation claim cannot mutate a
 * gameplay snapshot generation.
 */
export interface CompiledSessionPlayerDeliveryGrant {
  pcId: "p1";
  inviteDigest: string;
  expiresAt: number;
}

export interface CompiledSessionAccessBinding {
  schemaVersion: typeof COMPILED_SESSION_ACCESS_BINDING_SCHEMA_VERSION | typeof LEGACY_COMPILED_SESSION_ACCESS_BINDING_SCHEMA_VERSION;
  ownerRole: "operator" | "keeper";
  ownerPrincipalFingerprint: string;
  /** Optional means that direct/internal and resolver-less sessions remain owner-only. */
  playerGrant?: CompiledSessionPlayerGrant;
  /** Optional means browser invitation delivery is unavailable and remains owner-only. */
  playerDelivery?: CompiledSessionPlayerDeliveryGrant;
  /** A random server-side secret used only to mint generation-bound opaque choices. */
  choiceHmacKey: string;
}

export interface PersistedCompiledActionResponse {
  schemaVersion: typeof COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION | typeof PREVIOUS_COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION | typeof LEGACY_COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION;
  action: JsonRecord;
  summary: JsonRecord;
  generation: number;
}

export interface CompiledSkillGrowthSettlement {
  skill: string; storageKey: string; display: string; currentSkill: number; roll: number;
  increased: boolean; increase: number; newValue: number;
}

/** Complete 1.4 growth frame; pending marks are reconstructed by folding receipts. */
export interface CompiledSkillGrowthReceipt {
  schemaVersion: "1.0.0";
  generation: number; mechanismId: string; beforeStateHash: string; afterStateHash: string;
  sourceInterpretationIds: string[]; successfulSkills: string[]; pendingBefore: string[];
  pendingAfter: string[]; terminalEndingId: string | null; settlements: CompiledSkillGrowthSettlement[];
}


/**
 * The durable, JSON-safe receipt for exactly one compiled attack.  Mechanics
 * owns enemy HP and the character snapshot owns actor HP; this receipt binds
 * the two authorities without creating a third mutable combat state.
 */
export interface CompiledCombatSettlement {
  schemaVersion: "1.0.0";
  generation: number;
  mechanismId: string;
  encounterId: string;
  sourceInterpretationIds: string[];
  beforeStateHash: string;
  afterStateHash: string;
  actorHpBefore: number;
  actorHpAfter: number;
  /** Exact unit draws consumed by the two RulesEngine adjudications, in order. */
  randomUnits: number[];
  player: {
    fighting: number;
    targetDodge: number;
    roll: number;
    defenseRoll: number | null;
    hit: boolean;
    damage: number;
  };
  enemy: {
    fight: number;
    targetDodge: number;
    damage: CombatDamageSpec;
    roll: number;
    defenseRoll: number | null;
    hit: boolean;
    damageDealt: number;
  } | null;
  outcome: MechanicsCombatOutcome;
}

export interface CompiledSessionCharacterState {
  pcId: "p1";
  sheet: JsonRecord;
  sanity: JsonRecord;
}

export interface CompiledSessionIdempotencyRecord {
  actionId: string;
  input: string;
  requestHash: string;
  expectedGeneration: number;
  generation: number;
  /** Exact p1 frame used to derive this action's check target. */
  characterBefore: CompiledSessionCharacterState;
  response: PersistedCompiledActionResponse;
  /**
   * 3.4-only integrity anchor for an opaque v2 narration topic. It carries
   * no raw prose or secret: a later receipt compares its private candidate
   * against this trusted live snapshot record.
   */
  narrationTopic?: CompiledSessionNarrationTopicAnchor;
}

export interface CompiledSessionNarrationTopicAnchor {
  schemaVersion: "1.0.0";
  predecessorSnapshotHash: string;
  topicTokenHash: string;
  topicBindingHash: string;
  playerRequestHash: string;
}

export interface CompiledSessionSnapshot {
  schemaVersion: typeof COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION | typeof PREVIOUS_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION | typeof LEGACY_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION | typeof OLDEST_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION | typeof ANCIENT_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION;
  components: typeof COMPILED_SESSION_COMPONENT_VERSIONS | typeof PREVIOUS_COMPILED_SESSION_COMPONENT_VERSIONS | typeof LEGACY_COMPILED_SESSION_COMPONENT_VERSIONS | typeof OLDEST_COMPILED_SESSION_COMPONENT_VERSIONS | typeof ANCIENT_COMPILED_SESSION_COMPONENT_VERSIONS;
  sessionId: string;
  access: CompiledSessionAccessBinding | null;
  bundle: CompiledSessionBundleRef;
  previousSnapshotHash: string | null;
  generation: number;
  timestamps: { createdAt: number; lastActiveAt: number };
  round: number;
  /** Generation-zero p1 state, immutable anchor for the reward settlement chain. */
  initialCharacter: CompiledSessionCharacterState;
  character: CompiledSessionCharacterState;
  history: JsonValue[];
  state: MechanicsState;
  stateHash: string;
  trace: MechanicsReachabilityEdge[];
  terminal: { id: string; name: string; narration: string } | null;
  idempotency: CompiledSessionIdempotencyRecord[];
  snapshotHash: string;
}

export interface CompiledSessionSnapshotHeader {
  fileName: string;
  sessionId: string;
  bundleId: string;
  snapshotHash: string;
  generation: number;
  bodyBytes: number;
}

export type CompiledSessionSnapshotRefusalCode = "SNAPSHOT_NOT_FOUND" | "SNAPSHOT_CORRUPT" | "SNAPSHOT_INCOMPATIBLE" | "SNAPSHOT_STORAGE_FAILED" | "SNAPSHOT_CONFLICT" | "SNAPSHOT_BUSY" | "SNAPSHOT_POLICY_MISMATCH" | "SNAPSHOT_QUOTA_EXCEEDED" | "SNAPSHOT_NAMESPACE_FENCED";
export type CompiledSessionSnapshotResult<T> =
  | { status: "ok"; value: T }
  | { status: "refused"; code: CompiledSessionSnapshotRefusalCode; message: string; sessionId?: string };
/** A published header whose final directory sync or durable reload failed must be recovered, never treated as a refusal. */
export type CompiledSessionSnapshotWriteResult<T> = CompiledSessionSnapshotResult<T>
  | { status: "indeterminate"; code: "SNAPSHOT_INDETERMINATE"; message: string; sessionId: string };

/** Carries the persistence outcome through GameSession without exposing any hash at the HTTP boundary. */
export class CompiledSessionSnapshotPersistenceError extends Error {
  constructor(readonly code: CompiledSessionSnapshotRefusalCode | "SNAPSHOT_INDETERMINATE", message: string) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactOrOptionalKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("snapshot JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("snapshot JSON contains a non-plain value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.values(value).every(isJsonValue);
}

function validSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isCompiledSessionAccessBinding(value: unknown): value is CompiledSessionAccessBinding {
  return isRecord(value)
    && exactOrOptionalKeys(value, ["schemaVersion", "ownerRole", "ownerPrincipalFingerprint", "choiceHmacKey"], ["playerGrant", "playerDelivery"])
    && (value.schemaVersion === COMPILED_SESSION_ACCESS_BINDING_SCHEMA_VERSION
      || (value.schemaVersion === LEGACY_COMPILED_SESSION_ACCESS_BINDING_SCHEMA_VERSION && value.playerDelivery === undefined))
    && (value.ownerRole === "operator" || value.ownerRole === "keeper")
    && validHash(value.ownerPrincipalFingerprint)
    && validHash(value.choiceHmacKey)
    && (value.playerGrant === undefined || (isRecord(value.playerGrant)
      && exactKeys(value.playerGrant, ["pcId", "role", "principalFingerprint"])
      && value.playerGrant.pcId === "p1"
      && value.playerGrant.role === "player"
      && validHash(value.playerGrant.principalFingerprint)))
    && (value.playerDelivery === undefined || (isRecord(value.playerDelivery)
      && exactKeys(value.playerDelivery, ["pcId", "inviteDigest", "expiresAt"])
      && value.playerDelivery.pcId === "p1"
      && validHash(value.playerDelivery.inviteDigest)
      && typeof value.playerDelivery.expiresAt === "number"
      && Number.isSafeInteger(value.playerDelivery.expiresAt) && value.playerDelivery.expiresAt > 0));
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validFiniteInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validStringArray(value: unknown, max = 2048): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 4096);
}

function validState(value: unknown): value is MechanicsState {
  const required = ["currentSceneId", "foundClueIds", "visitedSceneIds", "ownedItemIds", "stateValues", "npcStates", "unlockedConnectionIds", "failureCounts", "encounters", "startedEncounterIds", "rewardIds"];
  const terminalKeys = value && isRecord(value) ? [
    ...(value.terminalEndingId === undefined ? [] : ["terminalEndingId"]),
    ...(value.terminalLoss === undefined ? [] : ["terminalLoss"]),
  ] : [];
  if (!isRecord(value) || !exactKeys(value, [...required, ...terminalKeys]) || value.terminalEndingId !== undefined && value.terminalLoss !== undefined) return false;
  const encounters = value.encounters;
  const encounterIds = isRecord(encounters) ? Object.keys(encounters).sort() : [];
  const activeEncounterIds = isRecord(encounters) ? Object.entries(encounters).filter(([, encounter]) => isRecord(encounter) && encounter.status === "active").map(([id]) => id) : [];
  const terminalLossEncounter = isRecord(value.terminalLoss) && typeof value.terminalLoss.encounterId === "string" && isRecord(encounters)
    ? encounters[value.terminalLoss.encounterId]
    : undefined;
  return typeof value.currentSceneId === "string"
    && validStringArray(value.foundClueIds) && validStringArray(value.visitedSceneIds) && validStringArray(value.ownedItemIds)
    && isRecord(value.stateValues) && Object.values(value.stateValues).every((entry) => entry === null || typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)))
    && isRecord(value.npcStates) && Object.values(value.npcStates).every((entry) => typeof entry === "string" && entry.length > 0)
    && validStringArray(value.unlockedConnectionIds) && isRecord(value.failureCounts) && Object.values(value.failureCounts).every(validNonNegativeInteger)
    && isRecord(encounters) && Object.values(encounters).every((encounter) => isRecord(encounter) && exactKeys(encounter, ["status", "currentHp"])
      && (encounter.status === "active" || encounter.status === "defeated") && validFiniteInteger(encounter.currentHp, 0, 20)
      && (encounter.status !== "active" || encounter.currentHp >= 1)
      && (encounter.status !== "defeated" || encounter.currentHp === 0))
    && activeEncounterIds.length <= 1
    && validStringArray(value.startedEncounterIds) && JSON.stringify([...value.startedEncounterIds].sort()) === JSON.stringify(encounterIds) && validStringArray(value.rewardIds)
    && (value.terminalEndingId === undefined || typeof value.terminalEndingId === "string" && value.terminalEndingId.length > 0)
    && (value.terminalLoss === undefined || isRecord(value.terminalLoss) && exactKeys(value.terminalLoss, ["kind", "encounterId", "combatantId"])
      && value.terminalLoss.kind === "encounter_defeat" && typeof value.terminalLoss.encounterId === "string" && value.terminalLoss.encounterId.length > 0 && typeof value.terminalLoss.combatantId === "string" && value.terminalLoss.combatantId.length > 0
      && isRecord(terminalLossEncounter) && terminalLossEncounter.status === "active");
}

/** Strict reusable validator for the canonical mechanics-state portion of a durable snapshot. */
export function validateCompiledMechanicsSnapshotState(value: unknown): value is MechanicsState {
  return validState(value) && canonicalJson(normalizeMechanicsState(value)) === canonicalJson(value);
}

function validCombatTracePayload(value: unknown): value is MechanicsCombatOutcome {
  return isRecord(value) && ((exactKeys(value, ["kind", "encounterId", "targetId", "hit", "damage", "enemyHit", "actorDamage", "actorDefeated"])
    && value.kind === "attack" && typeof value.encounterId === "string" && value.encounterId.length > 0 && typeof value.targetId === "string" && value.targetId.length > 0
    && typeof value.hit === "boolean" && typeof value.enemyHit === "boolean" && typeof value.actorDefeated === "boolean" && validFiniteInteger(value.damage, 0, 20) && validFiniteInteger(value.actorDamage, 0, 20)
    && (!value.hit ? value.damage === 0 : value.damage >= 1)
    && (value.enemyHit || value.actorDamage === 0 && value.actorDefeated === false)));
}

function validCombatDamage(value: unknown): value is CombatDamageSpec {
  return isRecord(value) && ((exactKeys(value, ["kind", "amount"]) && value.kind === "fixed" && validFiniteInteger(value.amount, 1, 20))
    || (exactKeys(value, ["kind", "count", "sides"]) && value.kind === "dice" && validFiniteInteger(value.count, 1, 3) && validFiniteInteger(value.sides, 2, 20) && value.count * value.sides <= 20));
}

/** Structural admission only. Artifact-bound outcome arithmetic is rechecked during restore. */
function validCombatSettlement(value: unknown): value is CompiledCombatSettlement {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "generation", "mechanismId", "encounterId", "sourceInterpretationIds", "beforeStateHash", "afterStateHash", "actorHpBefore", "actorHpAfter", "randomUnits", "player", "enemy", "outcome"])
    || value.schemaVersion !== "1.0.0" || !validNonNegativeInteger(value.generation) || typeof value.mechanismId !== "string" || !value.mechanismId
    || typeof value.encounterId !== "string" || !value.encounterId || !validStringArray(value.sourceInterpretationIds, 128)
    || typeof value.beforeStateHash !== "string" || !value.beforeStateHash || typeof value.afterStateHash !== "string" || !value.afterStateHash || !validFiniteInteger(value.actorHpBefore, 0, 1000000) || !validFiniteInteger(value.actorHpAfter, 0, value.actorHpBefore)
    || !Array.isArray(value.randomUnits) || value.randomUnits.length < 1 || value.randomUnits.length > 32 || !value.randomUnits.every((unit) => typeof unit === "number" && Number.isFinite(unit) && unit >= 0 && unit < 1)
    || !isRecord(value.player) || !exactKeys(value.player, ["fighting", "targetDodge", "roll", "defenseRoll", "hit", "damage"])
    || !validFiniteInteger(value.player.fighting, 0, 100) || !validFiniteInteger(value.player.targetDodge, 0, 100) || !validFiniteInteger(value.player.roll, 1, 100)
    || !(value.player.defenseRoll === null || validFiniteInteger(value.player.defenseRoll, 1, 100)) || typeof value.player.hit !== "boolean" || !validFiniteInteger(value.player.damage, 0, 20)
    || !validCombatTracePayload(value.outcome)) return false;
  if (!value.player.hit && value.player.damage !== 0) return false;
  if (value.enemy === null) return value.outcome.enemyHit === false && value.outcome.actorDamage === 0 && value.outcome.actorDefeated === false;
  const enemy = value.enemy;
  return isRecord(enemy) && exactKeys(enemy, ["fight", "targetDodge", "damage", "roll", "defenseRoll", "hit", "damageDealt"])
    && validFiniteInteger(enemy.fight, 0, 100) && validFiniteInteger(enemy.targetDodge, 0, 100) && validCombatDamage(enemy.damage)
    && validFiniteInteger(enemy.roll, 1, 100) && (enemy.defenseRoll === null || validFiniteInteger(enemy.defenseRoll, 1, 100))
    && typeof enemy.hit === "boolean" && validFiniteInteger(enemy.damageDealt, 0, 20)
    && (enemy.hit || enemy.damageDealt === 0);
}

function validTrace(value: unknown): value is MechanicsReachabilityEdge[] {
  return Array.isArray(value) && value.length <= 10000 && value.every((edge) => isRecord(edge)
    && exactKeys(edge, edge.outcome === "attack" ? ["mechanismId", "mechanismIds", "outcome", "combat", "beforeStateHash", "afterStateHash", "sourceInterpretationIds", "summary"] : ["mechanismId", "mechanismIds", "outcome", "beforeStateHash", "afterStateHash", "sourceInterpretationIds", "summary"])
    && typeof edge.mechanismId === "string" && edge.mechanismId.length > 0
    && validStringArray(edge.mechanismIds) && ["success", "failure", "failback", "traverse", "transition", "ending", "attack"].includes(edge.outcome as string)
    && (edge.outcome !== "attack" || validCombatTracePayload(edge.combat))
    && typeof edge.beforeStateHash === "string" && typeof edge.afterStateHash === "string"
    && validStringArray(edge.sourceInterpretationIds) && typeof edge.summary === "string");
}

function validSanity(value: unknown): value is JsonRecord {
  if (!isRecord(value) || !isJsonValue(value)) return false;
  const keys = ["currentSAN", "maxSAN", "temporaryInsanity", "indefiniteInsanity", "indefiniteLevel", "phobias", "manias", "sanLostThisRound", "nightmareStreak", "irreversibleChanges", "therapyProgress", "daysInstitutionalized", "cthulhuMythos", "mythosLog"];
  if (!exactKeys(value, keys) || !validFiniteInteger(value.maxSAN, 0, 100) || !validFiniteInteger(value.currentSAN, 0, value.maxSAN)
    || typeof value.temporaryInsanity !== "boolean" || typeof value.indefiniteInsanity !== "boolean"
    || !(value.indefiniteLevel === null || ["mild", "moderate", "severe"].includes(value.indefiniteLevel as string))
    || !validStringArray(value.phobias, 1024) || !validStringArray(value.manias, 1024) || !validStringArray(value.irreversibleChanges, 1024)
    || !["sanLostThisRound", "nightmareStreak", "therapyProgress", "daysInstitutionalized", "cthulhuMythos"].every((key) => validFiniteInteger(value[key], 0, key === "cthulhuMythos" ? 99 : 1000000))
    || !Array.isArray(value.mythosLog) || value.mythosLog.length > 1024) return false;
  return value.mythosLog.every((entry) => isRecord(entry) && exactKeys(entry, ["source", "gain", "maxSanLoss"])
    && typeof entry.source === "string" && entry.source.length > 0 && entry.source.length <= 4096
    && validFiniteInteger(entry.gain, 1, 99) && validFiniteInteger(entry.maxSanLoss, 1, 99));
}

const PERSISTED_CHARACTER_KEYS = ["name", "archetypeId", "attributes", "luck", "hp", "maxHp", "ac", "damageBonus", "build", "move", "creditRating", "startingItems", "occupationSkillPoints", "interestSkillPoints", "occupationSkills", "availableSkills", "age", "valid", "warnings", "cthulhuMythos", "skillValues"] as const;
const COC_SKILL_KEYS = [...new Set(Object.values(SKILL_NAME_MAP))].sort();

function validCharacterSheet(value: unknown): value is JsonRecord {
  if (!isRecord(value) || !isJsonValue(value) || !exactKeys(value, PERSISTED_CHARACTER_KEYS)) return false;
  const attributes = value.attributes as Record<string, unknown>;
  const skillValues = value.skillValues as Record<string, unknown>;
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 256 || typeof value.archetypeId !== "string" || value.archetypeId.length < 1 || value.archetypeId.length > 128
    || !isRecord(attributes) || !exactKeys(attributes, COC_ATTRIBUTES) || !COC_ATTRIBUTES.every((attribute) => validFiniteInteger(attributes[attribute], 1, 100))
    || !isRecord(skillValues) || !exactKeys(skillValues, COC_SKILL_KEYS) || !COC_SKILL_KEYS.every((skill) => validFiniteInteger(skillValues[skill], 0, 100))
    || !["luck", "hp", "maxHp", "ac", "move", "creditRating", "occupationSkillPoints", "interestSkillPoints", "age", "cthulhuMythos"].every((key) => validFiniteInteger(value[key], 0, 1000000))
    || !validFiniteInteger(value.build, COC_BUILD_RANGE.min, COC_BUILD_RANGE.max)
    || !validStringArray(value.startingItems, 128) || !validStringArray(value.occupationSkills, 128) || !validStringArray(value.availableSkills, 128) || !validStringArray(value.warnings, 128)
    || typeof value.damageBonus !== "string" || typeof value.valid !== "boolean") return false;
  return (value.hp as number) <= (value.maxHp as number) && (value.cthulhuMythos as number) <= 99;
}

function validCompiledCharacterState(value: unknown): value is CompiledSessionCharacterState {
  return isRecord(value) && exactKeys(value, ["pcId", "sheet", "sanity"])
    && value.pcId === "p1" && validCharacterSheet(value.sheet) && validSanity(value.sanity);
}

function validHistory(value: unknown): value is JsonValue[] {
  const messageKeys = ["speaker", "content", "type", "verbatim", "mood", "visible_to", "timestamp", "visibility", "discoverer"];
  return Array.isArray(value) && value.length <= 100000 && value.every((message) => isRecord(message)
    && Object.keys(message).every((key) => messageKeys.includes(key))
    && typeof message.speaker === "string" && typeof message.content === "string"
    && ["dialogue", "narration", "system", "action"].includes(message.type as string)
    && (message.verbatim === undefined || typeof message.verbatim === "boolean")
    && (message.mood === undefined || ["neutral", "friendly", "angry", "fearful", "suspicious", "excited", "sad", "calm"].includes(message.mood as string))
    && (message.visible_to === undefined || validStringArray(message.visible_to, 64))
    && (message.timestamp === undefined || validNonNegativeInteger(message.timestamp))
    && (message.visibility === undefined || ["public", "scene_restricted", "discoverer_only", "targeted", "private"].includes(message.visibility as string))
    && (message.discoverer === undefined || typeof message.discoverer === "string"));
}

function validActionState(value: unknown): value is JsonRecord {
  if (!isRecord(value) || !exactOrOptionalKeys(value, ["scene", "round", "player", "npcs", "monsters", "companions", "party", "gameTime"], ["bgm", "inventory", "sceneItems"])) return false;
  const player = value.player;
  const gameTime = value.gameTime;
  const actor = (entry: unknown): boolean => isRecord(entry) && exactKeys(entry, ["name", "hp", "maxHp", "status"])
    && typeof entry.name === "string" && validFiniteInteger(entry.hp, 0, 1000000) && validFiniteInteger(entry.maxHp, 0, 1000000) && entry.hp <= entry.maxHp && validStringArray(entry.status, 256);
  if (typeof value.scene !== "string" || !validNonNegativeInteger(value.round) || (value.bgm !== undefined && typeof value.bgm !== "string")
    || !isRecord(player) || !exactKeys(player, ["name", "hp", "maxHp", "ac", "status"]) || typeof player.name !== "string" || !validFiniteInteger(player.hp, 0, 1000000) || !validFiniteInteger(player.maxHp, 0, 1000000) || player.hp > player.maxHp || !validFiniteInteger(player.ac, 0, 1000000) || !validStringArray(player.status, 256)
    || !Array.isArray(value.npcs) || !value.npcs.every(actor) || !Array.isArray(value.monsters) || !value.monsters.every(actor)
    || !Array.isArray(value.companions) || value.companions.length !== 0 || !Array.isArray(value.party) || value.party.length !== 1
    || !isRecord(gameTime) || !exactKeys(gameTime, ["day", "period", "label"]) || !validNonNegativeInteger((gameTime as Record<string, unknown>).day) || typeof gameTime.period !== "string" || typeof gameTime.label !== "string"
    || (value.inventory !== undefined && !validStringArray(value.inventory, 1024)) || (value.sceneItems !== undefined && !validStringArray(value.sceneItems, 1024))) return false;
  const party = value.party[0];
  return isRecord(party) && exactKeys(party, ["pcId", "name", "control", "hp", "maxHp", "status", "san", "maxSan"])
    && party.pcId === "p1" && typeof party.name === "string" && party.control === "auto" && validFiniteInteger(party.hp, 0, 1000000) && validFiniteInteger(party.maxHp, 0, 1000000) && party.hp <= party.maxHp && validStringArray(party.status, 256) && validFiniteInteger(party.san, 0, 100) && validFiniteInteger(party.maxSan, 0, 100) && party.san <= party.maxSan;
}

function validRewardSettlements(value: unknown): value is TerminalRewardSettlement[] {
  return Array.isArray(value) && value.length <= 256 && value.every((settlement) => {
    if (!isRecord(settlement) || !exactOrOptionalKeys(settlement, ["rewardId", "sourceInterpretationIds"], ["san", "cthulhuMythos", "reputation"])
      || typeof settlement.rewardId !== "string" || !settlement.rewardId || !validStringArray(settlement.sourceInterpretationIds, 128)
      || new Set(settlement.sourceInterpretationIds).size !== settlement.sourceInterpretationIds.length) return false;
    const san = settlement.san;
    if (san !== undefined) {
      if (!isRecord(san) || !exactOrOptionalKeys(san, ["kind", "total", "before", "after"], ["count", "sides", "rolls"])
        || (san.kind !== "fixed" && san.kind !== "dice") || !validFiniteInteger(san.total, 1, 10000)
        || !validFiniteInteger(san.before, 0, 100) || !validFiniteInteger(san.after, san.before, 100)) return false;
      if (san.kind === "fixed") {
        if (san.count !== undefined || san.sides !== undefined || san.rolls !== undefined) return false;
      } else {
        const count = san.count;
        const sides = san.sides;
        if (!validFiniteInteger(count, 1, 100) || !validFiniteInteger(sides, 2, 100)
        || !Array.isArray(san.rolls) || san.rolls.length !== count || !san.rolls.every((roll) => validFiniteInteger(roll, 1, sides))
        || san.total !== san.rolls.reduce((sum, roll) => sum + roll, 0)) return false;
      }
    }
    const cthulhuMythos = settlement.cthulhuMythos;
    if (cthulhuMythos !== undefined) {
      if (!isRecord(cthulhuMythos) || !exactKeys(cthulhuMythos, ["delta", "before", "after", "maxSanBefore", "maxSanAfter", "currentSanBefore", "currentSanAfter"])
        || !validFiniteInteger(cthulhuMythos.delta, 1, 99) || !validFiniteInteger(cthulhuMythos.before, 0, 99)
        || !validFiniteInteger(cthulhuMythos.after, cthulhuMythos.before, 99) || cthulhuMythos.after !== cthulhuMythos.before + cthulhuMythos.delta
        || !validFiniteInteger(cthulhuMythos.maxSanBefore, 0, 100) || !validFiniteInteger(cthulhuMythos.maxSanAfter, 0, cthulhuMythos.maxSanBefore)
        || cthulhuMythos.maxSanAfter > 99 - cthulhuMythos.after
        || !validFiniteInteger(cthulhuMythos.currentSanBefore, 0, cthulhuMythos.maxSanBefore)
        || !validFiniteInteger(cthulhuMythos.currentSanAfter, 0, cthulhuMythos.maxSanAfter)
        || cthulhuMythos.currentSanAfter !== Math.min(cthulhuMythos.currentSanBefore, cthulhuMythos.maxSanAfter)) return false;
    }
    const reputation = settlement.reputation;
    if (reputation !== undefined) {
      const delta = reputation;
      if (!isRecord(delta) || !exactKeys(delta, ["delta", "before", "after"])
        || !validFiniteInteger(delta.delta, 1, 100) || !validFiniteInteger(delta.before, 0, 99) || !validFiniteInteger(delta.after, delta.before, 99)
        || delta.after !== Math.min(99, delta.before + delta.delta)) return false;
    }
    return san !== undefined || settlement.cthulhuMythos !== undefined || settlement.reputation !== undefined;
  }) && new Set((value as TerminalRewardSettlement[]).map((entry) => entry.rewardId)).size === value.length;
}

function validSanityLoss(value: unknown): boolean {
  return isRecord(value) && ((exactKeys(value, ["kind", "amount"]) && value.kind === "fixed" && validFiniteInteger(value.amount, 0, 100))
    || (exactKeys(value, ["kind", "count", "sides"]) && value.kind === "dice" && validFiniteInteger(value.count, 1, 10) && validFiniteInteger(value.sides, 2, 100) && (value.count as number) * (value.sides as number) <= 100));
}

function validActorEffectProvenance(value: unknown, outcome: unknown, effectIndex: unknown, effectPath: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["effectPath", "eventSlot", "source"]) || value.effectPath !== effectPath || !isRecord(value.source)
    || !exactKeys(value.source, ["statementId", "quote"]) || typeof value.source.statementId !== "string" || !value.source.statementId
    || typeof value.source.quote !== "string" || !value.source.quote || value.source.quote !== value.source.quote.trim() || value.source.quote.length > 8192
    || !isRecord(value.eventSlot) || value.eventSlot.outcome !== outcome || value.eventSlot.effectIndex !== effectIndex) return false;
  if (value.eventSlot.kind === "connection") {
    return exactKeys(value.eventSlot, ["kind", "connectionId", "outcome", "effectIndex"])
      && outcome === "traverse" && effectPath === `onTraverse[${effectIndex}]`
      && typeof value.eventSlot.connectionId === "string" && !!value.eventSlot.connectionId;
  }
  if (value.eventSlot.kind === "discovery") {
    const expectedPath = outcome === "success" ? `onSuccess[${effectIndex}]` : outcome === "failure" ? `onFailure[${effectIndex}]` : outcome === "failback" ? `failback.effects[${effectIndex}]` : undefined;
    return exactKeys(value.eventSlot, ["kind", "mechanismId", "outcome", "effectIndex"])
      && expectedPath === effectPath && typeof value.eventSlot.mechanismId === "string" && !!value.eventSlot.mechanismId;
  }
  return false;
}

/** Exact bounded validator for the actor-SAN durable ledger. */
function validSanityCheckSettlements(value: unknown): value is SanityCheckSettlement[] {
  return Array.isArray(value) && value.length <= 100 && value.every((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, ["actorId", "mechanismId", "outcome", "effectIndex", "effectPath", "provenance", "sourceInterpretationIds", "declared", "check", "madness", "beforeSanityHash", "afterSanityHash"])
      || entry.actorId !== "p1" || typeof entry.mechanismId !== "string" || !entry.mechanismId || !["success", "failure", "failback", "traverse"].includes(entry.outcome as string)
      || !validNonNegativeInteger(entry.effectIndex) || !validActorEffectProvenance(entry.provenance, entry.outcome, entry.effectIndex, entry.effectPath) || !validStringArray(entry.sourceInterpretationIds, 128) || new Set(entry.sourceInterpretationIds).size !== entry.sourceInterpretationIds.length
      || !validHash(entry.beforeSanityHash) || !validHash(entry.afterSanityHash) || !isRecord(entry.declared) || !exactKeys(entry.declared, ["passLoss", "failLoss"]) || !validSanityLoss(entry.declared.passLoss) || !validSanityLoss(entry.declared.failLoss)
      || !isRecord(entry.check) || !exactKeys(entry.check, ["roll", "passed", "selectedLoss", "rolls", "total", "appliedLoss"]) || !validFiniteInteger(entry.check.roll, 1, 100) || typeof entry.check.passed !== "boolean" || !validSanityLoss(entry.check.selectedLoss) || !Array.isArray(entry.check.rolls) || !validFiniteInteger(entry.check.total, 0, 100) || !validFiniteInteger(entry.check.appliedLoss, 0, entry.check.total)
      || !isRecord(entry.madness) || !exactKeys(entry.madness, ["temporaryInsanityTriggered", "indefiniteInsanityTriggered", "indefiniteLevel", "boutDetail", "newPhobias", "newManias"])
      || typeof entry.madness.temporaryInsanityTriggered !== "boolean" || typeof entry.madness.indefiniteInsanityTriggered !== "boolean" || !(entry.madness.indefiniteLevel === null || ["mild", "moderate", "severe"].includes(entry.madness.indefiniteLevel as string)) || !validStringArray(entry.madness.newPhobias, 1024) || !validStringArray(entry.madness.newManias, 1024)
      || !(entry.madness.boutDetail === null || isRecord(entry.madness.boutDetail) && exactKeys(entry.madness.boutDetail, ["type", "symptom", "guidance", "residual", "outcome"]) && typeof entry.madness.boutDetail.type === "string" && entry.madness.boutDetail.type.length > 0 && entry.madness.boutDetail.type.length <= 4096 && typeof entry.madness.boutDetail.symptom === "string" && entry.madness.boutDetail.symptom.length > 0 && entry.madness.boutDetail.symptom.length <= 4096 && typeof entry.madness.boutDetail.guidance === "string" && entry.madness.boutDetail.guidance.length > 0 && entry.madness.boutDetail.guidance.length <= 8192 && (entry.madness.boutDetail.residual === null || typeof entry.madness.boutDetail.residual === "string" && entry.madness.boutDetail.residual.length <= 4096) && typeof entry.madness.boutDetail.outcome === "string" && entry.madness.boutDetail.outcome.length > 0 && entry.madness.boutDetail.outcome.length <= 4096)) return false;
    const selected = entry.check.selectedLoss as Record<string, unknown>;
    const expected = entry.check.passed ? entry.declared.passLoss : entry.declared.failLoss;
    if (canonicalJson(selected) !== canonicalJson(expected)) return false;
    if (selected.kind === "fixed") return entry.check.rolls.length === 0 && entry.check.total === selected.amount;
    return entry.check.rolls.length === selected.count && entry.check.rolls.every((roll) => validFiniteInteger(roll, 1, selected.sides as number)) && entry.check.total === entry.check.rolls.reduce((sum, roll) => sum + roll, 0);
  }) && new Set((value as SanityCheckSettlement[]).map((entry) => `${entry.mechanismId}|${entry.outcome}|${entry.effectIndex}`)).size === value.length;
}

function validSkillGrowthReceipt(value: unknown): value is CompiledSkillGrowthReceipt {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "generation", "mechanismId", "beforeStateHash", "afterStateHash", "sourceInterpretationIds", "successfulSkills", "pendingBefore", "pendingAfter", "terminalEndingId", "settlements"])
    || value.schemaVersion !== "1.0.0" || !validNonNegativeInteger(value.generation) || typeof value.mechanismId !== "string" || !value.mechanismId
    || typeof value.beforeStateHash !== "string" || !value.beforeStateHash || typeof value.afterStateHash !== "string" || !value.afterStateHash || !validStringArray(value.sourceInterpretationIds, 128)
    || !validStringArray(value.successfulSkills, 64) || !validStringArray(value.pendingBefore, 128) || !validStringArray(value.pendingAfter, 128)
    || !(value.terminalEndingId === null || typeof value.terminalEndingId === "string" && value.terminalEndingId.length > 0)
    || !Array.isArray(value.settlements) || value.settlements.length > 128) return false;
  const sortedUnique = (items: string[]) => new Set(items).size === items.length && canonicalJson(items) === canonicalJson([...items].sort());
  if (!sortedUnique(value.sourceInterpretationIds) || !sortedUnique(value.successfulSkills) || !sortedUnique(value.pendingBefore) || !sortedUnique(value.pendingAfter)) return false;
  const settlements = value.settlements as unknown[];
  if (!settlements.every((entry) => isRecord(entry) && exactKeys(entry, ["skill", "storageKey", "display", "currentSkill", "roll", "increased", "increase", "newValue"])
    && typeof entry.skill === "string" && entry.skill.length > 0 && typeof entry.storageKey === "string" && entry.storageKey.length > 0 && typeof entry.display === "string" && entry.display.length > 0
    && validFiniteInteger(entry.currentSkill, 0, 100) && validFiniteInteger(entry.roll, 1, 100) && typeof entry.increased === "boolean"
    && validFiniteInteger(entry.increase, 0, 10) && validFiniteInteger(entry.newValue, 0, 100)
    && (entry.increased ? (entry.currentSkill as number) < 100 && (entry.increase as number) >= 1 && entry.newValue === Math.min(99, (entry.currentSkill as number) + (entry.increase as number)) : entry.increase === 0 && entry.newValue === entry.currentSkill))) return false;
  return sortedUnique(settlements.map((entry) => (entry as Record<string, unknown>).storageKey as string))
    && (value.terminalEndingId === null ? settlements.length === 0 : canonicalJson(value.pendingAfter) === canonicalJson([]));
}

function validPlayerNarration(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["schemaVersion", "text"])
    && value.schemaVersion === "1.0.0" && typeof value.text === "string"
    && !!value.text && value.text.trim() === value.text && Array.from(value.text).length <= 2_000;
}

function validPersistedCompiledAction(value: unknown, responseSchema: string): value is JsonRecord {
  const requiresGrowthReceipt = responseSchema !== LEGACY_COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION;
  const permitsPlayerNarration = responseSchema === COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION;
  const required = ["narrative", "events", "state", "dead", "sanity", "compiled", "sanityCheckSettlements", ...(requiresGrowthReceipt ? ["skillGrowthReceipt"] : [])];
  if (!isRecord(value) || !exactOrOptionalKeys(value, required, ["dice", "rewardSettlements", "combatSettlement", ...(permitsPlayerNarration ? ["playerNarration"] : [])])) return false;
  if (typeof value.narrative !== "string" || !Array.isArray(value.events) || !value.events.every((event) => isRecord(event) && exactKeys(event, ["speaker", "content", "type"])
    && typeof event.speaker === "string" && typeof event.content === "string" && ["dialogue", "narration", "system", "action"].includes(event.type as string))
    || !validActionState(value.state) || typeof value.dead !== "boolean" || !isRecord(value.sanity) || !exactKeys(value.sanity, ["currentSAN", "maxSAN", "temporaryInsanity", "indefiniteInsanity", "indefiniteLevel", "phobias", "manias"])
    || !validFiniteInteger(value.sanity.currentSAN, 0, 100) || !validFiniteInteger(value.sanity.maxSAN, 0, 100) || value.sanity.currentSAN > value.sanity.maxSAN || typeof value.sanity.temporaryInsanity !== "boolean" || typeof value.sanity.indefiniteInsanity !== "boolean" || !(value.sanity.indefiniteLevel === null || ["mild", "moderate", "severe"].includes(value.sanity.indefiniteLevel as string)) || !validStringArray(value.sanity.phobias, 1024) || !validStringArray(value.sanity.manias, 1024)
    || !isRecord(value.compiled) || !exactOrOptionalKeys(value.compiled, ["moduleId", "artifactHash", "mechanicsHash", "state", "stateHash", "trace", "generation"], ["terminalEnding"])
    || typeof value.compiled.moduleId !== "string" || !validHash(value.compiled.artifactHash) || !validHash(value.compiled.mechanicsHash) || !validState(value.compiled.state) || typeof value.compiled.stateHash !== "string" || !validTrace(value.compiled.trace) || !validNonNegativeInteger(value.compiled.generation)) return false;
  return (value.compiled.terminalEnding === undefined || isRecord(value.compiled.terminalEnding) && exactKeys(value.compiled.terminalEnding, ["id", "name", "narration"]) && Object.values(value.compiled.terminalEnding).every((entry) => typeof entry === "string"))
    && (value.dice === undefined || Array.isArray(value.dice) && value.dice.length === 1 && value.dice.every((dice) => isRecord(dice) && exactKeys(dice, ["expr", "total", "detail"]) && dice.expr === "d100" && validFiniteInteger(dice.total, 1, 100) && typeof dice.detail === "string" && dice.detail.length > 0 && dice.detail.length <= 128))
    && validSanityCheckSettlements(value.sanityCheckSettlements)
    && (value.rewardSettlements === undefined || validRewardSettlements(value.rewardSettlements))
    && (value.combatSettlement === undefined || validCombatSettlement(value.combatSettlement))
    && (value.playerNarration === undefined || permitsPlayerNarration && validPlayerNarration(value.playerNarration))
    && (!requiresGrowthReceipt || validSkillGrowthReceipt(value.skillGrowthReceipt));
}

function validPersistedResponse(value: unknown): value is PersistedCompiledActionResponse {
  const responseSchema = isRecord(value) && typeof value.schemaVersion === "string" ? value.schemaVersion : undefined;
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "action", "summary", "generation"])
    || ![COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION, PREVIOUS_COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION, LEGACY_COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION].includes(responseSchema as string)
    || !validNonNegativeInteger(value.generation) || !validPersistedCompiledAction(value.action, responseSchema!) || !isRecord(value.summary)) return false;
  const summary = value.summary;
  return exactKeys(summary, ["id", "round", "ruleset", "scene", "playerName", "archetype", "messageCount", "npcCount", "createdAt", "generation"])
    && typeof summary.id === "string" && validNonNegativeInteger(summary.round) && typeof summary.ruleset === "string" && typeof summary.scene === "string" && typeof summary.playerName === "string" && (summary.archetype === null || typeof summary.archetype === "string") && validNonNegativeInteger(summary.messageCount) && validNonNegativeInteger(summary.npcCount) && validNonNegativeInteger(summary.createdAt) && validNonNegativeInteger(summary.generation);
}

function validNarrationTopicAnchor(value: unknown): value is CompiledSessionNarrationTopicAnchor {
  return isRecord(value)
    && exactKeys(value, ["schemaVersion", "predecessorSnapshotHash", "topicTokenHash", "topicBindingHash", "playerRequestHash"])
    && value.schemaVersion === "1.0.0"
    && validHash(value.predecessorSnapshotHash)
    && validHash(value.topicTokenHash)
    && validHash(value.topicBindingHash)
    && validHash(value.playerRequestHash);
}

function validIdempotency(
  value: unknown,
  expectedResponseSchema: string,
  permitsNarrationTopicAnchor: boolean,
): value is CompiledSessionIdempotencyRecord[] {
  const actionIds = new Set<string>();
  return Array.isArray(value) && value.length <= 100000 && value.every((record) => isRecord(record)
    && exactOrOptionalKeys(record, ["actionId", "input", "requestHash", "expectedGeneration", "generation", "characterBefore", "response"], permitsNarrationTopicAnchor ? ["narrationTopic"] : [])
    && typeof record.actionId === "string" && record.actionId.length > 0 && record.actionId.length <= 256 && record.actionId.trim() === record.actionId
    && typeof record.input === "string" && record.input.length > 0 && record.input.length <= 16384 && record.input.trim() === record.input
    && validHash(record.requestHash) && validNonNegativeInteger(record.expectedGeneration) && validNonNegativeInteger(record.generation)
    && validCompiledCharacterState(record.characterBefore) && validPersistedResponse(record.response)
    && record.response.schemaVersion === expectedResponseSchema
    && (record.narrationTopic === undefined || permitsNarrationTopicAnchor && validNarrationTopicAnchor(record.narrationTopic))
    && !actionIds.has(record.actionId) && (actionIds.add(record.actionId), true));
}

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > COMPILED_SESSION_JSON_MAX_DEPTH) return depth;
  if (Array.isArray(value)) return value.reduce((max, child) => Math.max(max, jsonDepth(child, depth + 1)), depth);
  if (isRecord(value)) return (Object.values(value) as unknown[]).reduce<number>((max, child) => Math.max(max, jsonDepth(child, depth + 1)), depth);
  return depth;
}

function unsignedSnapshot(snapshot: CompiledSessionSnapshot | Record<string, unknown>): Record<string, unknown> {
  const { snapshotHash: _snapshotHash, ...unsigned } = snapshot as CompiledSessionSnapshot;
  return unsigned;
}

export function compiledSessionSnapshotHash(snapshot: CompiledSessionSnapshot | Record<string, unknown>): string {
  return sha256(canonicalJson(unsignedSnapshot(snapshot)));
}

/** Validates the persisted JSON schema before any artifact, world, or session writes. */
export function validateCompiledSessionSnapshot(value: unknown): CompiledSessionSnapshotResult<CompiledSessionSnapshot> {
  try {
    if (jsonDepth(value) > COMPILED_SESSION_JSON_MAX_DEPTH) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot JSON nesting exceeds the storage limit" };
    if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "components", "sessionId", "access", "bundle", "previousSnapshotHash", "generation", "timestamps", "round", "initialCharacter", "character", "history", "state", "stateHash", "trace", "terminal", "idempotency", "snapshotHash"])) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot has unknown, missing, or incompatible fields" };
    const currentSchema = value.schemaVersion === COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
      && isRecord(value.components)
      && canonicalJson(value.components) === canonicalJson(COMPILED_SESSION_COMPONENT_VERSIONS);
    const previousSchema = value.schemaVersion === PREVIOUS_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
      && isRecord(value.components) && canonicalJson(value.components) === canonicalJson(PREVIOUS_COMPILED_SESSION_COMPONENT_VERSIONS);
    const legacySchema = value.schemaVersion === LEGACY_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
      && isRecord(value.components)
      && canonicalJson(value.components) === canonicalJson(LEGACY_COMPILED_SESSION_COMPONENT_VERSIONS);
    const oldestSchema = value.schemaVersion === OLDEST_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
      && isRecord(value.components)
      && canonicalJson(value.components) === canonicalJson(OLDEST_COMPILED_SESSION_COMPONENT_VERSIONS);
    const ancientSchema = value.schemaVersion === ANCIENT_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION
      && isRecord(value.components)
      && canonicalJson(value.components) === canonicalJson(ANCIENT_COMPILED_SESSION_COMPONENT_VERSIONS);
    if (!currentSchema && !previousSchema && !legacySchema && !oldestSchema && !ancientSchema) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot schema or component version is unsupported" };
    if (!validSessionId(value.sessionId) || !(value.access === null || isCompiledSessionAccessBinding(value.access)) || !isRecord(value.bundle) || !exactKeys(value.bundle, ["id", "moduleId", "artifactHash", "mechanicsHash", "bundleHash"])
      || typeof value.bundle.id !== "string" || !COMPILER_ARTIFACT_CATALOG_ID_PATTERN.test(value.bundle.id) || typeof value.bundle.moduleId !== "string" || !validHash(value.bundle.artifactHash) || !validHash(value.bundle.mechanicsHash) || !validHash(value.bundle.bundleHash)) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot bundle identity is invalid" };
    if (!(value.previousSnapshotHash === null || validHash(value.previousSnapshotHash)) || !validNonNegativeInteger(value.generation) || (value.generation === 0) !== (value.previousSnapshotHash === null)
      || !isRecord(value.timestamps) || !exactKeys(value.timestamps, ["createdAt", "lastActiveAt"]) || !validNonNegativeInteger(value.timestamps.createdAt) || !validNonNegativeInteger(value.timestamps.lastActiveAt) || !validNonNegativeInteger(value.round)) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot generation, predecessor, timestamps, or round is invalid" };
    if (!validCompiledCharacterState(value.initialCharacter) || !validCompiledCharacterState(value.character)) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot requires complete initial and final p1 character/SAN state" };
    const responseSchema = (currentSchema || previousSchema) ? COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION
      : legacySchema ? PREVIOUS_COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION
        : LEGACY_COMPILED_SESSION_PERSISTED_RESPONSE_SCHEMA_VERSION;
    if (!validHistory(value.history) || !validState(value.state) || typeof value.stateHash !== "string" || !validTrace(value.trace)
      || !validIdempotency(value.idempotency, responseSchema, currentSchema)) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot history, state, trace, or idempotency records are invalid" };
    if (value.terminal !== null && (!isRecord(value.terminal) || !exactKeys(value.terminal, ["id", "name", "narration"]) || [value.terminal.id, value.terminal.name, value.terminal.narration].some((entry) => typeof entry !== "string"))) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot terminal identity is invalid" };
    if (!validHash(value.snapshotHash) || value.snapshotHash !== compiledSessionSnapshotHash(value) || value.stateHash !== mechanicsStateHash(value.state)) return { status: "refused", code: "SNAPSHOT_CORRUPT", message: "snapshot hash or mechanics state hash does not match" };
    if (canonicalJson(normalizeMechanicsState(value.state)) !== canonicalJson(value.state)) return { status: "refused", code: "SNAPSHOT_CORRUPT", message: "snapshot mechanics state is not normalized" };
    return { status: "ok", value: cloneJson(value as unknown as CompiledSessionSnapshot) };
  } catch (error) {
    return { status: "refused", code: "SNAPSHOT_CORRUPT", message: error instanceof Error ? error.message : "snapshot could not be decoded" };
  }
}

export function validatePersistedCompiledActionResponse(value: unknown): value is PersistedCompiledActionResponse {
  return validPersistedResponse(value);
}

function sameEdge(actual: MechanicsReachabilityEdge, expected: MechanicsReachabilityEdge): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

/** Replays the complete trace and records the settled state/trace prefix for every executable player edge. */
export function replayCompiledSessionTrace(
  payload: ResolvedCompilerArtifactPayload,
  trace: readonly MechanicsReachabilityEdge[],
): CompiledSessionSnapshotResult<{ state: MechanicsState; budget: ReturnType<typeof createMechanicsStateBudget>; playerActions: Array<{ edge: MechanicsReachabilityEdge; beforeState: MechanicsState; state: MechanicsState; traceLength: number; actorEffects: SelectedActorEffect[] }> }> {
  try {
    const budget = createMechanicsStateBudget(payload.analysisInput.maxStates);
    let offset = 0;
    let settled = settleInitialMechanics(payload.mechanicsIR, payload.analysisInput, budget);
    for (const edge of settled.steps) {
      if (!sameEdge(trace[offset]!, edge)) return { status: "refused", code: "SNAPSHOT_CORRUPT", message: `trace automatic edge ${offset} does not replay` };
      offset++;
    }
    let state = settled.state;
    const playerActions: Array<{ edge: MechanicsReachabilityEdge; beforeState: MechanicsState; state: MechanicsState; traceLength: number; actorEffects: SelectedActorEffect[] }> = [];
    while (offset < trace.length) {
      const expected = trace[offset]!;
      if (!expected || !["success", "failure", "failback", "traverse", "attack"].includes(expected.outcome)) return { status: "refused", code: "SNAPSHOT_CORRUPT", message: `trace edge ${offset} is not an executable player action` };
      const beforeState = structuredClone(state);
      let executed;
      if (expected.outcome === "attack") {
        if (!expected.combat) return { status: "refused", code: "SNAPSHOT_CORRUPT", message: `trace attack edge ${offset} has no combat payload` };
        executed = executeMechanicsAction(payload.mechanicsIR, payload.analysisInput, state, { mechanismId: expected.mechanismId, outcome: "attack", combat: expected.combat });
      } else if (expected.outcome === "success" || expected.outcome === "failure" || expected.outcome === "failback" || expected.outcome === "traverse") {
        executed = executeMechanicsAction(payload.mechanicsIR, payload.analysisInput, state, { mechanismId: expected.mechanismId, outcome: expected.outcome });
      } else {
        return { status: "refused", code: "SNAPSHOT_CORRUPT", message: `trace edge ${offset} is not an executable player action` };
      }
      if (!sameEdge(expected, executed.edge)) return { status: "refused", code: "SNAPSHOT_CORRUPT", message: `trace action edge ${offset} does not replay` };
      offset++;
      budget.observe(executed.state);
      settled = settleAutomaticMechanics(payload.mechanicsIR, executed.state, budget);
      for (const edge of settled.steps) {
        if (!sameEdge(trace[offset]!, edge)) return { status: "refused", code: "SNAPSHOT_CORRUPT", message: `trace automatic edge ${offset} does not replay` };
        offset++;
      }
      state = settled.state;
      playerActions.push({ edge: executed.edge, beforeState, state: structuredClone(state), traceLength: offset, actorEffects: structuredClone(executed.actorEffects) });
    }
    return { status: "ok", value: { state, budget, playerActions } };
  } catch (error) {
    return { status: "refused", code: "SNAPSHOT_CORRUPT", message: error instanceof Error ? error.message : "trace replay failed" };
  }
}

interface SnapshotHeaderFile {
  schemaVersion: typeof COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION | typeof PREVIOUS_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION | typeof LEGACY_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION | typeof OLDEST_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION | typeof ANCIENT_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION;
  sessionId: string;
  bundleId: string;
  snapshotHash: string;
  generation: number;
  bodyBytes: number;
}

export interface CompiledSessionSnapshotFileOps {
  mkdir(path: string): void;
  exists(path: string): boolean;
  list(path: string): string[];
  /** lstat-based classification; no critical store operation may follow a link. */
  kind(path: string): "missing" | "directory" | "regular" | "unsafe";
  /** Logical bytes from a regular, non-link lstat entry. */
  size(path: string): number;
  read(path: string, maxBytes: number): string;
  writeNew(path: string, value: string): void;
  writeReplace(path: string, value: string): void;
  remove(path: string): void;
  /** Optional platform hook for durable directory-entry publication; Windows commonly returns EINVAL for directory fsync. */
  syncDirectory?(path: string): void;
}

function writeAll(fd: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("snapshot write made no progress");
    offset += written;
  }
}

function writeFileAtomically(path: string, value: string, replace: boolean): void {
  const temp = `${path}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  let tempDevice: number | undefined;
  let tempInode: number | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("snapshot temporary file is not regular");
    tempDevice = opened.dev;
    tempInode = opened.ino;
    writeAll(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const beforePublish = lstatSync(temp);
    if (beforePublish.isSymbolicLink() || !beforePublish.isFile() || beforePublish.dev !== tempDevice || beforePublish.ino !== tempInode) {
      throw new Error("snapshot temporary file changed or became linked before publication");
    }
    if (replace) renameSync(temp, path);
    else {
      // Hard-link publication is no-clobber on every supported local filesystem.
      linkSync(temp, path);
      unlinkSync(temp);
    }
    // Windows does not support fsync on directory handles. The renamed file was fsynced;
    // callers can inject a stronger directory durability operation on platforms that expose one.
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      const leftover = lstatSync(temp);
      if (leftover.isSymbolicLink() || !leftover.isFile()) throw new Error("snapshot temporary cleanup target is not a regular non-link file");
      unlinkSync(temp);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
}

export const compiledSessionSnapshotNodeFileOps: CompiledSessionSnapshotFileOps = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  exists: (path) => existsSync(path),
  list: (path) => readdirSync(path),
  kind: (path) => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return "unsafe";
      if (stat.isDirectory()) return "directory";
      return stat.isFile() ? "regular" : "unsafe";
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return "missing";
      throw error;
    }
  },
  size: (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("snapshot path is not a regular non-link file");
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("snapshot file size is invalid");
    return stat.size;
  },
  read: (path, maxBytes) => {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("snapshot path is not a regular non-link file");
    const size = before.size;
    if (size > maxBytes) throw new Error(`snapshot file exceeds ${maxBytes} byte limit`);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const fd = openSync(path, constants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(fd);
      const after = lstatSync(path);
      if (!opened.isFile() || after.isSymbolicLink() || !after.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || after.dev !== before.dev || after.ino !== before.ino) {
        throw new Error("snapshot path changed or became linked while opening");
      }
      const bytes = Buffer.alloc(size + 1);
      const count = readSync(fd, bytes, 0, size + 1, 0);
      if (count > maxBytes) throw new Error(`snapshot file exceeds ${maxBytes} byte limit`);
      return bytes.subarray(0, count).toString("utf8");
    } finally { closeSync(fd); }
  },
  writeNew: (path, value) => {
    if (compiledSessionSnapshotNodeFileOps.kind(path) !== "missing") throw new Error("snapshot immutable publication target already exists or is unsafe");
    writeFileAtomically(path, value, false);
  },
  writeReplace: (path, value) => {
    const kind = compiledSessionSnapshotNodeFileOps.kind(path);
    if (kind !== "missing" && kind !== "regular") throw new Error("snapshot header publication target is unsafe");
    writeFileAtomically(path, value, true);
  },
  remove: (path) => {
    const kind = compiledSessionSnapshotNodeFileOps.kind(path);
    if (kind === "missing") return;
    if (kind !== "regular") throw new Error("snapshot deletion target is not a regular non-link file");
    unlinkSync(path);
  },
  syncDirectory: (path) => {
    let fd: number | undefined;
    try {
      const before = lstatSync(path);
      if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("snapshot directory is not a real non-link directory");
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      fd = openSync(path, constants.O_RDONLY | noFollow);
      const opened = fstatSync(fd);
      const after = lstatSync(path);
      if (!opened.isDirectory() || after.isSymbolicLink() || !after.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || after.dev !== before.dev || after.ino !== before.ino) {
        throw new Error("snapshot directory changed or became linked while opening");
      }
      fsyncSync(fd);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EINVAL" && code !== "EPERM") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

export interface CompiledSessionSnapshotStoreOptions {
  root?: string;
  /**
   * Snapshot-publication admission cap. Zero forbids every snapshot body/header
   * publication; the coordinator's SQLite bootstrap is a prerequisite control-
   * plane cost and is accounted by each later root scan, not a claim that the
   * whole physical root can remain at zero bytes.
   */
  maxEntries?: number;
  /** See maxEntries: this caps snapshot admission, after coordinator bootstrap. */
  maxBytes?: number;
  fileOps?: CompiledSessionSnapshotFileOps;
  /** Injectable only for coordinator lifecycle and fault-classification tests. */
  coordinatorFactory?: (root: string, policy: SnapshotCoordinatorPolicy) => CompiledSessionSnapshotCoordinatorLike;
  /** Server-owned synchronous namespace verifier for a namespace-required root. */
  namespacePublicationGate?: SessionNamespacePublicationGate;
  /** Test-only standalone-store seam; production publication requires a namespace permit. */
  allowUncoordinatedTestWrites?: boolean;
}

export const COMPILED_SESSION_SNAPSHOT_DEFAULT_MAX_ENTRIES = 4096;
export const COMPILED_SESSION_SNAPSHOT_DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

function configuredQuota(value: number | undefined, environment: string | undefined, fallback: number): number | undefined {
  const candidate: unknown = value === undefined ? environment === undefined ? fallback : environment : value;
  if (typeof candidate === "number") return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    const parsed = Number(candidate);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

interface SnapshotRootUsage { entries: number; bytes: number; names: string[]; }

/** Immutable snapshot bodies plus a bounded, atomically replaced current-header pointer. */
export class CompiledSessionSnapshotStore {
  readonly root: string;
  private readonly ops: CompiledSessionSnapshotFileOps;
  private readonly coordinatorFactory: (root: string, policy: SnapshotCoordinatorPolicy) => CompiledSessionSnapshotCoordinatorLike;
  private readonly coordinatorPolicy: SnapshotCoordinatorPolicy | undefined;
  private readonly namespacePublicationGate: SessionNamespacePublicationGate | undefined;
  private readonly allowUncoordinatedTestWrites: boolean;

  constructor(options: CompiledSessionSnapshotStoreOptions = {}) {
    this.root = resolve(options.root ?? process.env.COMPILED_SESSION_ROOT ?? join("data", "compiled-sessions"));
    this.ops = options.fileOps ?? compiledSessionSnapshotNodeFileOps;
    this.coordinatorFactory = options.coordinatorFactory ?? ((root) => new CompiledSessionSnapshotCoordinator(root));
    const maxEntries = configuredQuota(options.maxEntries, process.env.COMPILED_SESSION_SNAPSHOT_MAX_ENTRIES, COMPILED_SESSION_SNAPSHOT_DEFAULT_MAX_ENTRIES);
    const maxBytes = configuredQuota(options.maxBytes, process.env.COMPILED_SESSION_SNAPSHOT_MAX_BYTES, COMPILED_SESSION_SNAPSHOT_DEFAULT_MAX_BYTES);
    this.coordinatorPolicy = maxEntries === undefined || maxBytes === undefined
      ? undefined
      : { schemaVersion: COMPILED_SESSION_SNAPSHOT_COORDINATOR_SCHEMA_VERSION, maxEntries, maxBytes };
    this.namespacePublicationGate = options.namespacePublicationGate;
    this.allowUncoordinatedTestWrites = options.allowUncoordinatedTestWrites === true;
  }

  save(
    snapshot: unknown,
    publication?: SessionNamespaceStorePublication,
    gate: SessionNamespacePublicationGate | undefined = this.namespacePublicationGate,
  ): CompiledSessionSnapshotWriteResult<CompiledSessionSnapshotHeader> {
    const validated = validateCompiledSessionSnapshot(snapshot);
    if (validated.status === "refused") return validated;
    const value = validated.value;
    if (!this.coordinatorPolicy) return { status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: "snapshot quota configuration is invalid", sessionId: value.sessionId };
    try {
      consumeSessionNamespacePublication(gate, publication, {
        kind: "compiled", sessionId: value.sessionId, hash: value.snapshotHash,
        generation: value.generation, format: COMPILED_SESSION_NAMESPACE_IDENTITY_FORMAT,
      }, this.allowUncoordinatedTestWrites);
    } catch (error) {
      return { status: "refused", code: "SNAPSHOT_NAMESPACE_FENCED", message: error instanceof Error ? error.message : "compiled namespace publication permit is invalid", sessionId: value.sessionId };
    }
    const body = `${canonicalJson(value)}\n`;
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    if (bodyBytes > COMPILED_SESSION_BODY_MAX_BYTES) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot body exceeds the storage limit", sessionId: value.sessionId };
    const header: SnapshotHeaderFile = { schemaVersion: value.schemaVersion, sessionId: value.sessionId, bundleId: value.bundle.id, snapshotHash: value.snapshotHash, generation: value.generation, bodyBytes };
    const headerText = `${canonicalJson(header)}\n`;
    let coordinator: CompiledSessionSnapshotCoordinatorLike | undefined;
    let publicationBegun = false;
    let headerPublicationAttempted = false;
    let headerDirectorySynced = false;
    let durableSuccessorReloaded = false;
    let result: CompiledSessionSnapshotWriteResult<CompiledSessionSnapshotHeader> = { status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: "snapshot storage failed", sessionId: value.sessionId };
    try {
      this.ops.mkdir(this.root);
      this.assertSafeRoot();
      // This transaction deliberately spans every observation and publication
      // which establishes the CAS edge. Narrower locking around rename would
      // still permit two processes to validate the same predecessor.
      coordinator = this.coordinatorFactory(this.root, this.coordinatorPolicy);
      coordinator.initializePolicy(this.coordinatorPolicy);
      coordinator.beginPublication();
      publicationBegun = true;
      // Before observing a predecessor or admitting new bytes, reconcile only
      // bodies whose names and full immutable contents prove they are stale or
      // headerless orphans. Unknown entries remain in place and count below.
      this.reconcileGarbageLocked();
      const usage = this.scanSafeRoot();
      const current = this.readHeader(value.sessionId);
      if (current.status === "ok") {
        if (current.value.snapshotHash === value.snapshotHash && current.value.generation === value.generation) result = current;
        else if (value.generation !== current.value.generation + 1 || value.previousSnapshotHash !== current.value.snapshotHash) result = { status: "refused", code: "SNAPSHOT_CONFLICT", message: "snapshot predecessor is not the current durable generation", sessionId: value.sessionId };
        // A successor may advance mechanics, never silently replace the
        // creator binding, p1 grant, or opaque-choice secret. The predecessor
        // is immutable, so compare the fully schema-validated access object
        // before publishing the new header.
        else {
          result = { status: "ok", value: this.headerFromFile(this.headerFileName(value.sessionId), header) };
          const predecessor = this.read(value.sessionId);
          if (predecessor.status === "refused") result = { status: "refused", code: "SNAPSHOT_CONFLICT", message: "snapshot predecessor could not be read", sessionId: value.sessionId };
          else {
            const checkedPredecessor = validateCompiledSessionSnapshot(predecessor.value);
            if (checkedPredecessor.status === "refused" || canonicalJson(checkedPredecessor.value.access) !== canonicalJson(value.access)) {
              result = { status: "refused", code: "SNAPSHOT_CONFLICT", message: "snapshot successor changes durable access binding", sessionId: value.sessionId };
            }
          }
        }
      } else if (current.code !== "SNAPSHOT_NOT_FOUND") {
        result = { status: "refused", code: "SNAPSHOT_CONFLICT", message: `session ID is occupied by an unavailable snapshot: ${current.message}`, sessionId: value.sessionId };
      } else if (this.isOccupied(value.sessionId)) {
        result = { status: "refused", code: "SNAPSHOT_CONFLICT", message: "session ID is occupied by an incomplete or unavailable snapshot", sessionId: value.sessionId };
      } else if (value.generation !== 0 || value.previousSnapshotHash !== null) {
        result = { status: "refused", code: "SNAPSHOT_CONFLICT", message: "new durable sessions must start at generation zero", sessionId: value.sessionId };
      } else {
        result = { status: "ok", value: this.headerFromFile(this.headerFileName(value.sessionId), header) };
      }

      // Exact replays never write a second header, but still reload the
      // immutable body before they can be acknowledged. Other values publish.
      const sameDurableSnapshot = current.status === "ok" && current.value.snapshotHash === value.snapshotHash && current.value.generation === value.generation;
      if (result.status === "ok" && sameDurableSnapshot) {
        // A matching pointer is not sufficient for idempotency: it must still
        // resolve to the exact validated immutable body before this call may
        // acknowledge the replay. Never recreate a missing body here.
        result = this.durableReload(value, header, body);
      } else if (result.status === "ok") {
        const bodyPath = this.bodyPath(value.sessionId, value.snapshotHash);
        const bodyKind = this.ops.kind(bodyPath);
        if (bodyKind === "unsafe" || bodyKind === "directory") throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot immutable body path is unsafe");
        const bodyExists = bodyKind === "regular";
        this.assertQuotaAdmission(usage, bodyBytes, new TextEncoder().encode(headerText).byteLength, bodyExists, value.sessionId);
        if (bodyExists) {
          if (this.ops.read(bodyPath, COMPILED_SESSION_BODY_MAX_BYTES) !== body) result = { status: "refused", code: "SNAPSHOT_CONFLICT", message: "immutable snapshot body hash collides with different content", sessionId: value.sessionId };
        } else {
          this.ops.writeNew(bodyPath, body);
          this.ops.syncDirectory?.(this.root);
        }
        if (result.status === "ok") {
          // Set this before writeReplace: a throwing filesystem primitive may
          // have published the replacement before it reports its failure.
          headerPublicationAttempted = true;
          this.ops.writeReplace(this.headerPath(value.sessionId), headerText);
          this.ops.syncDirectory?.(this.root);
          headerDirectorySynced = true;
          const durable = this.durableReload(value, header, body);
          if (durable.status === "refused") {
            result = { status: "indeterminate", code: "SNAPSHOT_INDETERMINATE", message: "snapshot header was published but durable reload could not confirm it", sessionId: value.sessionId };
          } else {
            result = durable;
            durableSuccessorReloaded = true;
            // The successor is now authoritative. Only now may a prior
            // generation be removed; failure here is post-commit ambiguity.
            this.reconcileGarbageLocked();
          }
        }
      }
    } catch (error) {
      if (error instanceof SnapshotCoordinatorFailure) {
        result = { status: "refused", code: error.code, message: error.message, sessionId: value.sessionId };
        if (durableSuccessorReloaded) result = { status: "indeterminate", code: "SNAPSHOT_INDETERMINATE", message: error.message, sessionId: value.sessionId };
      } else if (durableSuccessorReloaded) {
        result = { status: "indeterminate", code: "SNAPSHOT_INDETERMINATE", message: error instanceof Error ? error.message : "snapshot successor cleanup may be incomplete", sessionId: value.sessionId };
      } else if (headerPublicationAttempted && !headerDirectorySynced) {
        // A visible header after a failed replace/sync is a possible commit.
        // Do not return a normal refusal and invite the caller to overwrite or
        // re-execute; recovery must reload the authoritative header instead.
        result = { status: "indeterminate", code: "SNAPSHOT_INDETERMINATE", message: error instanceof Error ? error.message : "snapshot publication may have completed", sessionId: value.sessionId };
      } else if (headerPublicationAttempted) {
        result = { status: "indeterminate", code: "SNAPSHOT_INDETERMINATE", message: error instanceof Error ? error.message : "snapshot durable reload failed", sessionId: value.sessionId };
      } else {
        result = { status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: error instanceof Error ? error.message : "snapshot storage failed", sessionId: value.sessionId };
      }
    } finally {
      if (coordinator) {
        const finish = coordinator.finishPublication();
        if ((finish.rollbackFailure || finish.closeFailure) && result.status === "ok") {
          // A successful reload proves the header/body value, but a failed
          // coordinator close cannot prove that future writers may proceed.
          // Let the action boundary reload and retry rather than advertising a
          // normally settled response while lock lifecycle is uncertain.
          result = { status: "indeterminate", code: "SNAPSHOT_INDETERMINATE", message: (finish.closeFailure ?? finish.rollbackFailure)!.message, sessionId: value.sessionId };
        } else if ((finish.rollbackFailure || finish.closeFailure) && result.status === "refused" && !publicationBegun) {
          result = { status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: (finish.closeFailure ?? finish.rollbackFailure)!.message, sessionId: value.sessionId };
        }
      }
    }
    return result;
  }

  /** Every destructive scan starts with an lstat-only root check. */
  private assertSafeRoot(): void {
    if (this.ops.kind(this.root) !== "directory") throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot root is not a real non-link directory");
  }

  /** Count actual regular directory entries, including unknown files and SQLite sidecars. */
  private scanSafeRoot(): SnapshotRootUsage {
    this.assertSafeRoot();
    const names = this.ops.list(this.root).sort();
    let bytes = 0;
    for (const name of names) {
      if (!name || name !== basename(name) || name === "." || name === "..") throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot root returned an unsafe entry name");
      const path = join(this.root, name);
      if (this.ops.kind(path) !== "regular") throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot root contains a non-regular or linked entry");
      const size = this.ops.size(path);
      if (!Number.isSafeInteger(size) || size < 0 || bytes > Number.MAX_SAFE_INTEGER - size) throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot root usage is not safely measurable");
      bytes += size;
    }
    return { entries: names.length, bytes, names };
  }

  private assertQuotaAdmission(usage: SnapshotRootUsage, bodyBytes: number, headerBytes: number, bodyAlreadyExists: boolean, sessionId: string): void {
    const policy = this.coordinatorPolicy;
    if (!policy) throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot quota configuration is invalid");
    // writeNew creates a private temp and hard-links it into its final name,
    // so a new immutable body briefly consumes two bodies. Header replacement
    // has its own temp beside the current header. Reserve the larger peak.
    const extraEntries = bodyAlreadyExists ? 1 : 2;
    const extraBytes = bodyAlreadyExists ? headerBytes : Math.max(bodyBytes * 2, bodyBytes + headerBytes);
    const entries = usage.entries + extraEntries;
    const bytes = usage.bytes + extraBytes;
    if (!Number.isSafeInteger(entries) || !Number.isSafeInteger(bytes) || entries > policy.maxEntries || bytes > policy.maxBytes) {
      throw new SnapshotCoordinatorFailure("SNAPSHOT_QUOTA_EXCEEDED", `snapshot quota prevents publishing ${sessionId}`);
    }
  }

  private strictBodyName(name: string): { sessionId: string; snapshotHash: string } | undefined {
    const match = /^([A-Za-z0-9_-]{1,128})\.([a-f0-9]{64})\.json$/.exec(name);
    return match ? { sessionId: match[1]!, snapshotHash: match[2]! } : undefined;
  }

  private verifyImmutableBody(path: string, sessionId: string, snapshotHash: string): CompiledSessionSnapshot {
    if (this.ops.kind(path) !== "regular") throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot immutable body is not a regular non-link file");
    let raw: string;
    try { raw = this.ops.read(path, COMPILED_SESSION_BODY_MAX_BYTES); }
    catch { throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot immutable body could not be safely read"); }
    let decoded: unknown;
    try { decoded = JSON.parse(raw) as unknown; }
    catch { throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot immutable body is not valid JSON"); }
    const checked = validateCompiledSessionSnapshot(decoded);
    if (checked.status === "refused" || checked.value.sessionId !== sessionId || checked.value.snapshotHash !== snapshotHash) {
      throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot immutable body does not prove its strict file name");
    }
    return checked.value;
  }

  /**
   * Delete only after every header and candidate body has been fully checked.
   * This makes a malformed header, missing current body, or unsafe entry a
   * zero-delete failure rather than a guess about ownership.
   */
  private reconcileGarbageLocked(): number {
    const scan = this.scanSafeRoot();
    const names = new Set(scan.names);
    const headers = new Map<string, CompiledSessionSnapshotHeader>();
    for (const name of scan.names.filter((entry) => entry.endsWith(".header.json"))) {
      const header = this.readHeaderFile(name);
      if (header.status === "refused") throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot header cannot be verified for garbage collection");
      const bodyName = `${header.value.sessionId}.${header.value.snapshotHash}.json`;
      if (!names.has(bodyName)) throw new SnapshotCoordinatorFailure("SNAPSHOT_CORRUPT", "snapshot header references a missing immutable body");
      const current = this.verifyImmutableBody(join(this.root, bodyName), header.value.sessionId, header.value.snapshotHash);
      if (current.bundle.id !== header.value.bundleId || current.generation !== header.value.generation || this.ops.size(join(this.root, bodyName)) !== header.value.bodyBytes) {
        throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot header and immutable body cannot be verified together");
      }
      headers.set(header.value.sessionId, header.value);
    }

    const removals: string[] = [];
    for (const name of scan.names) {
      const body = this.strictBodyName(name);
      if (!body) continue; // Unknown entries count above but are never GC targets.
      this.verifyImmutableBody(join(this.root, name), body.sessionId, body.snapshotHash);
      const header = headers.get(body.sessionId);
      if (!header || header.snapshotHash !== body.snapshotHash) removals.push(join(this.root, name));
    }
    for (const path of removals) {
      if (this.ops.kind(path) !== "regular") throw new SnapshotCoordinatorFailure("SNAPSHOT_STORAGE_FAILED", "snapshot garbage target changed before deletion");
    }
    for (const path of removals) this.ops.remove(path);
    if (removals.length) this.ops.syncDirectory?.(this.root);
    return removals.length;
  }

  /** Reopens the authoritative header/body through normal bounded readers before save() may report success. */
  private durableReload(value: CompiledSessionSnapshot, expected: SnapshotHeaderFile, body: string): CompiledSessionSnapshotResult<CompiledSessionSnapshotHeader> {
    const header = this.readHeader(value.sessionId);
    if (header.status === "refused") return header;
    if (header.value.sessionId !== expected.sessionId || header.value.bundleId !== expected.bundleId || header.value.snapshotHash !== expected.snapshotHash
      || header.value.generation !== expected.generation || header.value.bodyBytes !== expected.bodyBytes) {
      return { status: "refused", code: "SNAPSHOT_CORRUPT", message: "durable snapshot header does not match the published successor", sessionId: value.sessionId };
    }
    const persisted = this.read(value.sessionId);
    if (persisted.status === "refused") return persisted;
    const checked = validateCompiledSessionSnapshot(persisted.value);
    if (checked.status === "refused" || `${canonicalJson(checked.value)}\n` !== body) {
      return { status: "refused", code: "SNAPSHOT_CORRUPT", message: "durable snapshot body does not match the published successor", sessionId: value.sessionId };
    }
    return { status: "ok", value: header.value };
  }

  /** Reads only bounded header sidecars. Callers load catalog bundles before body decoding. */
  listHeaders(): Array<CompiledSessionSnapshotResult<CompiledSessionSnapshotHeader>> {
    const rootKind = this.ops.kind(this.root);
    if (rootKind === "missing") return [];
    if (rootKind !== "directory") return [{ status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: "snapshot root is not a real non-link directory" }];
    try {
      return this.ops.list(this.root).filter((name) => name.endsWith(".header.json")).sort().map((name) => this.readHeaderFile(name));
    } catch (error) {
      return [{ status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: error instanceof Error ? error.message : "snapshot directory could not be enumerated" }];
    }
  }

  /** Startup-only inventory of headers plus body-only partial publications. */
  listOccupiedSessionIds(): string[] {
    const rootKind = this.ops.kind(this.root);
    if (rootKind === "missing") return [];
    if (rootKind !== "directory") throw new Error("compiled snapshot root is not a real non-link directory");
    try {
      const ids = new Set<string>();
      for (const name of this.ops.list(this.root)) {
        const header = /^([A-Za-z0-9_-]{1,128})\.header\.json$/.exec(name);
        const body = /^([A-Za-z0-9_-]{1,128})\.[a-f0-9]{64}\.json$/.exec(name);
        if (header) ids.add(header[1]!);
        if (body) ids.add(body[1]!);
      }
      return [...ids].sort();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "compiled snapshot root is unreadable");
    }
  }

  read(sessionId: string): CompiledSessionSnapshotResult<unknown> {
    const header = this.readHeader(sessionId);
    if (header.status === "refused") return header;
    try {
      const bodyPath = this.bodyPath(sessionId, header.value.snapshotHash);
      if (this.ops.kind(bodyPath) !== "regular") return { status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: "snapshot body is not a regular non-link file", sessionId };
      const raw = this.ops.read(bodyPath, COMPILED_SESSION_BODY_MAX_BYTES);
      if (new TextEncoder().encode(raw).byteLength !== header.value.bodyBytes) return { status: "refused", code: "SNAPSHOT_CORRUPT", message: "snapshot body length does not match its header", sessionId };
      const value = JSON.parse(raw) as unknown;
      if (jsonDepth(value) > COMPILED_SESSION_JSON_MAX_DEPTH) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: "snapshot JSON nesting exceeds the storage limit", sessionId };
      return { status: "ok", value };
    } catch (error) {
      return { status: "refused", code: "SNAPSHOT_CORRUPT", message: error instanceof Error ? error.message : "snapshot body could not be decoded", sessionId };
    }
  }

  /** Existing headers, immutable bodies, and malformed header entries all reserve their session IDs. */
  isOccupied(sessionId: string): boolean {
    if (!validSessionId(sessionId)) return false;
    const rootKind = this.ops.kind(this.root);
    if (rootKind === "missing") return false;
    if (rootKind !== "directory") return true;
    try {
      return this.ops.list(this.root).some((name) => name === this.headerFileName(sessionId) || name.startsWith(`${sessionId}.`) && name.endsWith(".json"));
    } catch { return true; }
  }

  readHeader(sessionId: string): CompiledSessionSnapshotResult<CompiledSessionSnapshotHeader> {
    if (!validSessionId(sessionId)) return { status: "refused", code: "SNAPSHOT_NOT_FOUND", message: "snapshot session ID is invalid", sessionId };
    return this.readHeaderFile(this.headerFileName(sessionId));
  }

  private readHeaderFile(fileName: string): CompiledSessionSnapshotResult<CompiledSessionSnapshotHeader> {
    const sessionId = fileName.replace(/\.header\.json$/, "");
    const path = join(this.root, fileName);
    try {
      if (fileName !== basename(fileName) || !validSessionId(sessionId)) return { status: "refused", code: "SNAPSHOT_NOT_FOUND", message: "snapshot header is invalid", sessionId };
      const kind = this.ops.kind(path);
      if (kind === "missing") return { status: "refused", code: "SNAPSHOT_NOT_FOUND", message: "snapshot header was not found", sessionId };
      if (kind !== "regular") return { status: "refused", code: "SNAPSHOT_STORAGE_FAILED", message: "snapshot header is not a regular non-link file", sessionId };
      const value = JSON.parse(this.ops.read(path, COMPILED_SESSION_HEADER_MAX_BYTES)) as unknown;
      if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "sessionId", "bundleId", "snapshotHash", "generation", "bodyBytes"])
    || ![COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION, PREVIOUS_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION, LEGACY_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION, OLDEST_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION, ANCIENT_COMPILED_SESSION_SNAPSHOT_SCHEMA_VERSION].includes(value.schemaVersion as string) || !validSessionId(value.sessionId) || value.sessionId !== sessionId || !COMPILER_ARTIFACT_CATALOG_ID_PATTERN.test(value.bundleId as string) || !validHash(value.snapshotHash) || !validNonNegativeInteger(value.generation) || !validNonNegativeInteger(value.bodyBytes) || value.bodyBytes > COMPILED_SESSION_BODY_MAX_BYTES) return { status: "refused", code: "SNAPSHOT_INCOMPATIBLE", message: `snapshot header is invalid for ${fileName}`, sessionId };
      return { status: "ok", value: this.headerFromFile(fileName, value as unknown as SnapshotHeaderFile) };
    } catch (error) {
      return { status: "refused", code: "SNAPSHOT_CORRUPT", message: `${fileName}: ${error instanceof Error ? error.message : "snapshot header could not be decoded"}`, sessionId };
    }
  }

  private headerFromFile(fileName: string, value: SnapshotHeaderFile): CompiledSessionSnapshotHeader {
    return { fileName, sessionId: value.sessionId, bundleId: value.bundleId, snapshotHash: value.snapshotHash, generation: value.generation, bodyBytes: value.bodyBytes };
  }

  private headerFileName(sessionId: string): string { return `${sessionId}.header.json`; }
  private headerPath(sessionId: string): string { return join(this.root, this.headerFileName(sessionId)); }
  private bodyPath(sessionId: string, snapshotHash: string): string { return join(this.root, `${sessionId}.${snapshotHash}.json`); }
}
