import { createHash } from "node:crypto";
import { NPC_MOODS, type MemoryEntry, type NPCMood, type NPCPersonality } from "../agent/types";

/** Portable, versioned representation of every NPCStore persistence table. */
export const NPC_STORE_SNAPSHOT_VERSION = 1 as const;
const NPC_STORE_SNAPSHOT_HASH_DOMAIN = "aitrpg:npc-store-snapshot:v1\0";

export const NPC_STORE_SNAPSHOT_LIMITS = Object.freeze({
  maxRowsPerTable: 100_000,
  maxStringLength: 1_000_000,
  maxJsonDepth: 40,
  maxJsonMembers: 10_000,
});

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

type NPCSnapshotRuleset = "" | NonNullable<NPCPersonality["ruleset"]>;

export interface NPCPersonalitySnapshotRow {
  id: string;
  name: string;
  role: string;
  personality: string;
  background: string;
  speech_style: string;
  goals: string[];
  knowledge: string[];
  secrets: string[];
  attitudes: Record<string, string>;
  ruleset: NPCSnapshotRuleset;
  traits: JsonObject;
  factions: JsonValue[];
  initial_mood: NPCMood;
  created_at: number;
  updated_at: number;
}

export interface NPCMemorySnapshotRow {
  id: number;
  npc_id: string;
  type: MemoryEntry["type"];
  content: string;
  importance: number;
  timestamp: number;
  scene_id: string;
  related_entities: string[];
  is_summary: 0 | 1;
}

export interface NPCRelationshipSnapshotRow {
  npc_id: string;
  target_name: string;
  relationship: number;
  interaction_count: number;
  last_interaction: number;
}

export interface NPCStateSnapshotRow {
  npc_id: string;
  mood: NPCMood;
  relationship: number;
  player_interaction_count: number;
  last_active: number;
}

export interface NPCStoreSnapshotTables {
  npc_personalities: NPCPersonalitySnapshotRow[];
  npc_memories: NPCMemorySnapshotRow[];
  npc_relationships: NPCRelationshipSnapshotRow[];
  npc_states: NPCStateSnapshotRow[];
}

export interface NPCStoreSnapshotSequences {
  npc_memories: number;
}

export interface NPCStoreSnapshot {
  version: typeof NPC_STORE_SNAPSHOT_VERSION;
  hash: string;
  sequences: NPCStoreSnapshotSequences;
  tables: NPCStoreSnapshotTables;
}

export type UnsignedNPCStoreSnapshot = Omit<NPCStoreSnapshot, "hash">;

type UnknownRecord = Record<string, unknown>;

const RULESETS = new Set<NPCSnapshotRuleset>(["", "cosmic-horror", "dnd5e", "grail"]);
const MEMORY_TYPES = new Set<MemoryEntry["type"]>(["observation", "dialogue", "event", "decision"]);
const MOODS = new Set<NPCMood>(NPC_MOODS);

/** Hash JSON canonically: sorted object keys and original array order. */
export function npcStoreSnapshotHash(value: unknown): string {
  const json = normalizeJson(value, "hash input", 0, NPC_STORE_SNAPSHOT_LIMITS.maxRowsPerTable);
  return `sha256:${createHash("sha256")
    .update(NPC_STORE_SNAPSHOT_HASH_DOMAIN)
    .update(canonicalJson(json))
    .digest("hex")}`;
}

/** Validate an unsigned portable payload and attach its canonical integrity hash. */
export function createNPCStoreSnapshot(payload: UnsignedNPCStoreSnapshot): NPCStoreSnapshot {
  const checked = validateUnsignedSnapshot(payload);
  return structuredClone({ ...checked, hash: npcStoreSnapshotHash(checked) });
}

/** Validate exact shape, semantic constraints, and canonical integrity hash. */
export function validateNPCStoreSnapshot(input: unknown): NPCStoreSnapshot {
  const object = exactObject(input, ["version", "hash", "sequences", "tables"], "snapshot");
  const hash = stringValue(object.hash, "snapshot.hash");
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) fail("snapshot.hash must be a sha256 digest");

  const payload = validateUnsignedSnapshot({
    version: object.version as typeof NPC_STORE_SNAPSHOT_VERSION,
    sequences: object.sequences as NPCStoreSnapshotSequences,
    tables: object.tables as NPCStoreSnapshotTables,
  });
  if (hash !== npcStoreSnapshotHash(payload)) fail("snapshot hash does not match its canonical payload");
  return structuredClone({ ...payload, hash });
}

function validateUnsignedSnapshot(input: unknown): UnsignedNPCStoreSnapshot {
  const object = exactObject(input, ["version", "sequences", "tables"], "snapshot payload");
  if (object.version !== NPC_STORE_SNAPSHOT_VERSION) {
    fail(`unsupported NPC store snapshot version: ${String(object.version)}`);
  }
  const sequences = validateSequences(object.sequences);
  const tables = validateTables(object.tables);
  validateCrossTableConstraints(tables, sequences);
  return { version: NPC_STORE_SNAPSHOT_VERSION, sequences, tables };
}

function validateSequences(input: unknown): NPCStoreSnapshotSequences {
  const object = exactObject(input, ["npc_memories"], "snapshot.sequences");
  return { npc_memories: integer(object.npc_memories, "snapshot.sequences.npc_memories", 0) };
}

function validateTables(input: unknown): NPCStoreSnapshotTables {
  const object = exactObject(input, [
    "npc_personalities", "npc_memories", "npc_relationships", "npc_states",
  ], "snapshot.tables");
  return {
    npc_personalities: rows(object.npc_personalities, "npc_personalities", validatePersonality),
    npc_memories: rows(object.npc_memories, "npc_memories", validateMemory),
    npc_relationships: rows(object.npc_relationships, "npc_relationships", validateRelationship),
    npc_states: rows(object.npc_states, "npc_states", validateState),
  };
}

function validatePersonality(input: unknown, path: string): NPCPersonalitySnapshotRow {
  const value = exactObject(input, [
    "id", "name", "role", "personality", "background", "speech_style", "goals", "knowledge", "secrets",
    "attitudes", "ruleset", "traits", "factions", "initial_mood", "created_at", "updated_at",
  ], path);
  return {
    id: stringValue(value.id, `${path}.id`),
    name: stringValue(value.name, `${path}.name`),
    role: stringValue(value.role, `${path}.role`),
    personality: stringValue(value.personality, `${path}.personality`),
    background: stringValue(value.background, `${path}.background`),
    speech_style: stringValue(value.speech_style, `${path}.speech_style`),
    goals: stringArray(value.goals, `${path}.goals`),
    knowledge: stringArray(value.knowledge, `${path}.knowledge`),
    secrets: stringArray(value.secrets, `${path}.secrets`),
    attitudes: stringRecord(value.attitudes, `${path}.attitudes`),
    ruleset: enumValue(value.ruleset, RULESETS, `${path}.ruleset`),
    traits: jsonObject(value.traits, `${path}.traits`),
    factions: jsonArray(value.factions, `${path}.factions`),
    initial_mood: enumValue(value.initial_mood, MOODS, `${path}.initial_mood`),
    created_at: integer(value.created_at, `${path}.created_at`, 0),
    updated_at: integer(value.updated_at, `${path}.updated_at`, 0),
  };
}

function validateMemory(input: unknown, path: string): NPCMemorySnapshotRow {
  const value = exactObject(input, [
    "id", "npc_id", "type", "content", "importance", "timestamp", "scene_id", "related_entities", "is_summary",
  ], path);
  return {
    id: integer(value.id, `${path}.id`, 1),
    npc_id: stringValue(value.npc_id, `${path}.npc_id`),
    type: enumValue(value.type, MEMORY_TYPES, `${path}.type`),
    content: stringValue(value.content, `${path}.content`),
    importance: integer(value.importance, `${path}.importance`, 1, 10),
    timestamp: integer(value.timestamp, `${path}.timestamp`, 0),
    scene_id: stringValue(value.scene_id, `${path}.scene_id`),
    related_entities: stringArray(value.related_entities, `${path}.related_entities`),
    is_summary: bit(value.is_summary, `${path}.is_summary`),
  };
}

function validateRelationship(input: unknown, path: string): NPCRelationshipSnapshotRow {
  const value = exactObject(input, [
    "npc_id", "target_name", "relationship", "interaction_count", "last_interaction",
  ], path);
  return {
    npc_id: stringValue(value.npc_id, `${path}.npc_id`),
    target_name: stringValue(value.target_name, `${path}.target_name`),
    relationship: numberValue(value.relationship, `${path}.relationship`, -5, 5),
    interaction_count: integer(value.interaction_count, `${path}.interaction_count`, 0),
    last_interaction: integer(value.last_interaction, `${path}.last_interaction`, 0),
  };
}

function validateState(input: unknown, path: string): NPCStateSnapshotRow {
  const value = exactObject(input, [
    "npc_id", "mood", "relationship", "player_interaction_count", "last_active",
  ], path);
  return {
    npc_id: stringValue(value.npc_id, `${path}.npc_id`),
    mood: enumValue(value.mood, MOODS, `${path}.mood`),
    relationship: numberValue(value.relationship, `${path}.relationship`, -5, 5),
    player_interaction_count: integer(value.player_interaction_count, `${path}.player_interaction_count`, 0),
    last_active: integer(value.last_active, `${path}.last_active`, 0),
  };
}

function validateCrossTableConstraints(tables: NPCStoreSnapshotTables, sequences: NPCStoreSnapshotSequences): void {
  unique(tables.npc_personalities, (row) => row.id, "npc_personalities.id");
  unique(tables.npc_memories, (row) => row.id, "npc_memories.id");
  unique(tables.npc_relationships, (row) => compositeKey(row.npc_id, row.target_name), "npc_relationships.npc_id/target_name");
  unique(tables.npc_states, (row) => row.npc_id, "npc_states.npc_id");

  const personalityIds = new Set(tables.npc_personalities.map((row) => row.id));
  for (const row of tables.npc_memories) {
    if (!personalityIds.has(row.npc_id)) fail(`npc_memories npc_id does not exist: ${row.npc_id}`);
  }
  for (const row of tables.npc_relationships) {
    if (!personalityIds.has(row.npc_id)) fail(`npc_relationships npc_id does not exist: ${row.npc_id}`);
  }
  for (const row of tables.npc_states) {
    if (!personalityIds.has(row.npc_id)) fail(`npc_states npc_id does not exist: ${row.npc_id}`);
  }

  const largestMemoryId = tables.npc_memories.reduce((largest, row) => Math.max(largest, row.id), 0);
  if (sequences.npc_memories < largestMemoryId) {
    fail("snapshot.sequences.npc_memories is below its largest memory id");
  }
}

function rows<T>(input: unknown, name: string, validate: (row: unknown, path: string) => T): T[] {
  return arrayValue(input, `snapshot.tables.${name}`, NPC_STORE_SNAPSHOT_LIMITS.maxRowsPerTable)
    .map((row, index) => validate(row, `snapshot.tables.${name}[${index}]`));
}

function unique<T>(values: readonly T[], key: (row: T) => string | number, name: string): void {
  const seen = new Set<string | number>();
  for (const row of values) {
    const value = key(row);
    if (seen.has(value)) fail(`duplicate ${name}: ${String(value)}`);
    seen.add(value);
  }
}

/** JSON array encoding is injective for a tuple of strings, unlike delimiters. */
function compositeKey(...values: string[]): string {
  return JSON.stringify(values);
}

function exactObject(input: unknown, keys: readonly string[], path: string): UnknownRecord {
  const object = dataObject(input, path);
  const actual = Object.getOwnPropertyNames(object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail(`${path} has unexpected or missing keys`);
  }
  return object;
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype;
}

/** Reject accessors, hidden fields, symbols, and nonstandard prototypes before reading a value. */
function dataObject(input: unknown, path: string): UnknownRecord {
  if (!isPlainObject(input)) fail(`${path} must be a plain JSON object`);
  if (Object.getOwnPropertySymbols(input).length > 0) fail(`${path} must not contain symbol keys`);
  for (const key of Object.getOwnPropertyNames(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}.${key} must be an enumerable JSON data property`);
    }
  }
  return input;
}

function arrayValue(input: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    fail(`${path} must be a JSON array`);
  }
  if (input.length > maximum) fail(`${path} must be an array within bounds`);
  if (Object.getOwnPropertySymbols(input).length > 0) fail(`${path} must not contain symbol keys`);
  for (const key of Object.getOwnPropertyNames(input)) {
    if (key === "length") continue;
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length) {
      fail(`${path} must not contain non-index properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}[${key}] must be an enumerable JSON data property`);
    }
  }
  for (let index = 0; index < input.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) fail(`${path}[${index}] must not be sparse`);
  }
  return input;
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length > NPC_STORE_SNAPSHOT_LIMITS.maxStringLength) {
    fail(`${path} must be a string within bounds`);
  }
  return input;
}

function integer(input: unknown, path: string, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > maximum) {
    fail(`${path} must be a safe integer in ${minimum}..${maximum}`);
  }
  return input;
}

function numberValue(input: unknown, path: string, minimum = -Number.MAX_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < minimum || input > maximum) {
    fail(`${path} must be a finite JSON number in ${minimum}..${maximum}`);
  }
  return input;
}

function bit(input: unknown, path: string): 0 | 1 {
  if (input !== 0 && input !== 1) fail(`${path} must be 0 or 1`);
  return input;
}

function enumValue<T extends string>(input: unknown, allowed: Set<T>, path: string): T {
  if (typeof input !== "string" || !allowed.has(input as T)) fail(`${path} has an illegal enum value`);
  return input as T;
}

function stringArray(input: unknown, path: string): string[] {
  return arrayValue(input, path, NPC_STORE_SNAPSHOT_LIMITS.maxJsonMembers)
    .map((value, index) => stringValue(value, `${path}[${index}]`));
}

function stringRecord(input: unknown, path: string): Record<string, string> {
  const object = dataObject(input, path);
  const keys = Object.getOwnPropertyNames(object);
  if (keys.length > NPC_STORE_SNAPSHOT_LIMITS.maxJsonMembers) fail(`${path} exceeds JSON object bounds`);
  const result: Record<string, string> = {};
  for (const key of keys) {
    stringValue(key, `${path} key`);
    const value = stringValue(object[key], `${path}.${key}`);
    Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function jsonObject(input: unknown, path: string): JsonObject {
  if (!isPlainObject(input)) fail(`${path} must be a JSON object`);
  return jsonValue(input, path) as JsonObject;
}

function jsonArray(input: unknown, path: string): JsonValue[] {
  if (!Array.isArray(input)) fail(`${path} must be a JSON array`);
  return jsonValue(input, path) as JsonValue[];
}

function jsonValue(input: unknown, path: string): JsonValue {
  return normalizeJson(input, path, 0, NPC_STORE_SNAPSHOT_LIMITS.maxJsonMembers);
}

function normalizeJson(input: unknown, path: string, depth: number, arrayMaximum: number): JsonValue {
  if (depth > NPC_STORE_SNAPSHOT_LIMITS.maxJsonDepth) fail(`${path} exceeds JSON nesting bounds`);
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    stringValue(input, path);
    return input;
  }
  if (typeof input === "number") {
    numberValue(input, path);
    return input;
  }
  if (Array.isArray(input)) {
    return arrayValue(input, path, arrayMaximum)
      .map((value, index) => normalizeJson(value, `${path}[${index}]`, depth + 1, arrayMaximum));
  }
  if (isPlainObject(input)) {
    const object = dataObject(input, path);
    const keys = Object.getOwnPropertyNames(object);
    if (keys.length > NPC_STORE_SNAPSHOT_LIMITS.maxJsonMembers) fail(`${path} exceeds JSON object bounds`);
    const result: JsonObject = {};
    for (const key of keys) {
      stringValue(key, `${path} key`);
      Object.defineProperty(result, key, {
        value: normalizeJson(object[key], `${path}.${key}`, depth + 1, arrayMaximum),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  fail(`${path} is not JSON-safe`);
}

function canonicalJson(input: JsonValue): string {
  if (input === null || typeof input === "boolean" || typeof input === "number" || typeof input === "string") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  const object = input as UnknownRecord;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`).join(",")}}`;
}

function fail(message: string): never {
  throw new Error(`Invalid NPC store snapshot: ${message}`);
}
