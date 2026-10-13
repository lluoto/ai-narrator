import { createHash } from "node:crypto";

/** Versioned, portable representation of the complete WorldStateManager database. */
export const WORLD_STATE_SNAPSHOT_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface EntitySnapshotRow {
  rowid: number;
  id: string;
  name: string;
  type: "pc" | "npc" | "monster" | "item";
  hp: number;
  max_hp: number;
  ac: number;
  status: string[];
  position: string;
  faction: string | null;
  attributes: JsonObject;
  scene_id: string | null;
  alive: 0 | 1;
  created_at: number;
  updated_at: number;
}

export interface EffectSnapshotRow {
  rowid: number;
  id: string;
  source: string;
  target: string;
  type: "advantage" | "disadvantage" | "condition" | "buff" | "debuff";
  description: string;
  duration: number;
  round_applied: number;
  data: JsonObject;
}

export interface InventorySnapshotRow {
  rowid: number;
  id: number;
  entity_id: string;
  item_name: string;
  quantity: number;
  description: string | null;
  properties: JsonObject;
}

export interface PlayerStateSnapshotRow {
  rowid: number;
  entity_id: string;
  sanity: JsonObject | null;
  inventory: string[];
  weapons: string[];
  armor: string[];
  updated_at: number;
}

export interface RelationshipSnapshotRow {
  rowid: number;
  id: number;
  entity_a: string;
  entity_b: string;
  relation: string;
  attitude: number;
  note: string | null;
  updated_at: number;
}

export interface ClueDiscoverySnapshotRow {
  rowid: number;
  player_id: string;
  clue_id: string;
  discovered_at: number;
}

export interface SceneVisitSnapshotRow {
  rowid: number;
  player_id: string;
  scene_id: string;
  first_visited_at: number;
}

export interface ClueFailCountSnapshotRow {
  rowid: number;
  clue_id: string;
  fail_count: number;
  updated_at: number;
}

export interface SceneSnapshotRow {
  rowid: number;
  id: string;
  name: string;
  description: string;
  lighting: string | null;
  dangers: string[];
  exits: JsonValue[];
  is_active: 0 | 1;
}

export interface HistoricalSnapshotRow {
  rowid: number;
  id: number;
  round: number;
  timestamp: number;
  state_json: JsonValue;
  context_text: string;
  event_count: number;
}

export interface EventLogSnapshotRow {
  rowid: number;
  id: number;
  round: number;
  timestamp: number;
  event_type: "combat" | "move" | "dialogue" | "discovery" | "item_use" | "scene_change" | "system";
  actor: string | null;
  target: string | null;
  description: string;
  result_json: JsonValue | null;
  causation_id: string | null;
}

export interface WorldStateSnapshotTables {
  entities: EntitySnapshotRow[];
  effects: EffectSnapshotRow[];
  inventory: InventorySnapshotRow[];
  player_state: PlayerStateSnapshotRow[];
  relationships: RelationshipSnapshotRow[];
  clue_discoveries: ClueDiscoverySnapshotRow[];
  scene_visits: SceneVisitSnapshotRow[];
  clue_fail_counts: ClueFailCountSnapshotRow[];
  scenes: SceneSnapshotRow[];
  snapshots: HistoricalSnapshotRow[];
  event_log: EventLogSnapshotRow[];
}

export interface WorldStateSnapshotSequences {
  inventory: number;
  relationships: number;
  snapshots: number;
  event_log: number;
}

export interface WorldStateSnapshot {
  version: typeof WORLD_STATE_SNAPSHOT_VERSION;
  hash: string;
  currentRound: number;
  sequences: WorldStateSnapshotSequences;
  tables: WorldStateSnapshotTables;
}

type UnsignedWorldStateSnapshot = Omit<WorldStateSnapshot, "hash">;
type UnknownRecord = Record<string, unknown>;

const MAX_ROWS_PER_TABLE = 100_000;
const MAX_JSON_DEPTH = 40;
const MAX_JSON_MEMBERS = 10_000;
const MAX_STRING_LENGTH = 1_000_000;
const WORLD_STATE_SNAPSHOT_HASH_DOMAIN = "aitrpg.world-state-snapshot.v1\u0000";
const ENTITY_TYPES = new Set<EntitySnapshotRow["type"]>(["pc", "npc", "monster", "item"]);
const EFFECT_TYPES = new Set<EffectSnapshotRow["type"]>(["advantage", "disadvantage", "condition", "buff", "debuff"]);
const EVENT_TYPES = new Set<EventLogSnapshotRow["event_type"]>([
  "combat", "move", "dialogue", "discovery", "item_use", "scene_change", "system",
]);

/**
 * Hash JSON canonically: object keys are sorted recursively and array order is
 * retained. The function intentionally accepts only JSON-safe input.
 */
export function worldStateSnapshotHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(WORLD_STATE_SNAPSHOT_HASH_DOMAIN)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

/** Validate an unsigned payload and add its canonical hash. */
export function createWorldStateSnapshot(payload: UnsignedWorldStateSnapshot): WorldStateSnapshot {
  const checked = validateUnsignedSnapshot(payload);
  return { ...checked, hash: worldStateSnapshotHash(checked) };
}

/** Validate schema, semantic constraints, and the canonical integrity hash. */
export function validateWorldStateSnapshot(input: unknown): WorldStateSnapshot {
  const object = exactObject(input, ["version", "hash", "currentRound", "sequences", "tables"], "snapshot");
  const hash = stringValue(object.hash, "snapshot.hash");
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) fail("snapshot.hash must be a sha256 digest");

  const payload = validateUnsignedSnapshot({
    version: object.version as typeof WORLD_STATE_SNAPSHOT_VERSION,
    currentRound: object.currentRound as number,
    sequences: object.sequences as WorldStateSnapshotSequences,
    tables: object.tables as WorldStateSnapshotTables,
  });
  const expected = worldStateSnapshotHash(payload);
  if (hash !== expected) fail("snapshot hash does not match its canonical payload");
  return { ...payload, hash };
}

function validateUnsignedSnapshot(input: unknown): UnsignedWorldStateSnapshot {
  const object = exactObject(input, ["version", "currentRound", "sequences", "tables"], "snapshot payload");
  if (object.version !== WORLD_STATE_SNAPSHOT_VERSION) {
    fail(`unsupported world snapshot version: ${String(object.version)}`);
  }
  const currentRound = integer(object.currentRound, "snapshot.currentRound", 0);
  const sequences = validateSequences(object.sequences);
  const tables = validateTables(object.tables);
  validateCrossTableConstraints(tables, sequences);
  return { version: WORLD_STATE_SNAPSHOT_VERSION, currentRound, sequences, tables };
}

function validateSequences(input: unknown): WorldStateSnapshotSequences {
  const object = exactObject(input, ["inventory", "relationships", "snapshots", "event_log"], "snapshot.sequences");
  return {
    inventory: integer(object.inventory, "snapshot.sequences.inventory", 0),
    relationships: integer(object.relationships, "snapshot.sequences.relationships", 0),
    snapshots: integer(object.snapshots, "snapshot.sequences.snapshots", 0),
    event_log: integer(object.event_log, "snapshot.sequences.event_log", 0),
  };
}

function validateTables(input: unknown): WorldStateSnapshotTables {
  const object = exactObject(input, [
    "entities", "effects", "inventory", "player_state", "relationships", "clue_discoveries",
    "scene_visits", "clue_fail_counts", "scenes", "snapshots", "event_log",
  ], "snapshot.tables");
  return {
    entities: rows(object.entities, "entities", validateEntity),
    effects: rows(object.effects, "effects", validateEffect),
    inventory: rows(object.inventory, "inventory", validateInventory),
    player_state: rows(object.player_state, "player_state", validatePlayerState),
    relationships: rows(object.relationships, "relationships", validateRelationship),
    clue_discoveries: rows(object.clue_discoveries, "clue_discoveries", validateClueDiscovery),
    scene_visits: rows(object.scene_visits, "scene_visits", validateSceneVisit),
    clue_fail_counts: rows(object.clue_fail_counts, "clue_fail_counts", validateClueFailCount),
    scenes: rows(object.scenes, "scenes", validateScene),
    snapshots: rows(object.snapshots, "snapshots", validateHistoricalSnapshot),
    event_log: rows(object.event_log, "event_log", validateEventLog),
  };
}

function validateEntity(input: unknown, path: string): EntitySnapshotRow {
  const value = exactObject(input, [
    "rowid", "id", "name", "type", "hp", "max_hp", "ac", "status", "position", "faction",
    "attributes", "scene_id", "alive", "created_at", "updated_at",
  ], path);
  const type = enumValue(value.type, ENTITY_TYPES, `${path}.type`);
  const alive = bit(value.alive, `${path}.alive`);
  return {
    rowid: integer(value.rowid, `${path}.rowid`, 1), id: stringValue(value.id, `${path}.id`),
    name: stringValue(value.name, `${path}.name`), type,
    hp: integer(value.hp, `${path}.hp`), max_hp: integer(value.max_hp, `${path}.max_hp`, 0),
    ac: integer(value.ac, `${path}.ac`, 0), status: stringArray(value.status, `${path}.status`),
    position: stringValue(value.position, `${path}.position`),
    faction: nullableString(value.faction, `${path}.faction`), attributes: numericJsonObject(value.attributes, `${path}.attributes`),
    scene_id: nullableString(value.scene_id, `${path}.scene_id`), alive,
    created_at: integer(value.created_at, `${path}.created_at`, 0),
    updated_at: integer(value.updated_at, `${path}.updated_at`, 0),
  };
}

function validateEffect(input: unknown, path: string): EffectSnapshotRow {
  const value = exactObject(input, ["rowid", "id", "source", "target", "type", "description", "duration", "round_applied", "data"], path);
  return {
    rowid: integer(value.rowid, `${path}.rowid`, 1), id: stringValue(value.id, `${path}.id`),
    source: stringValue(value.source, `${path}.source`), target: stringValue(value.target, `${path}.target`),
    type: enumValue(value.type, EFFECT_TYPES, `${path}.type`), description: stringValue(value.description, `${path}.description`),
    duration: integer(value.duration, `${path}.duration`, 0), round_applied: integer(value.round_applied, `${path}.round_applied`, 0),
    data: jsonObject(value.data, `${path}.data`),
  };
}

function validateInventory(input: unknown, path: string): InventorySnapshotRow {
  const value = exactObject(input, ["rowid", "id", "entity_id", "item_name", "quantity", "description", "properties"], path);
  const id = integer(value.id, `${path}.id`, 1);
  const rowid = integer(value.rowid, `${path}.rowid`, 1);
  if (rowid !== id) fail(`${path}.rowid must equal the inventory id`);
  return {
    rowid, id, entity_id: stringValue(value.entity_id, `${path}.entity_id`),
    item_name: stringValue(value.item_name, `${path}.item_name`), quantity: integer(value.quantity, `${path}.quantity`, 0),
    description: nullableString(value.description, `${path}.description`), properties: jsonObject(value.properties, `${path}.properties`),
  };
}

function validatePlayerState(input: unknown, path: string): PlayerStateSnapshotRow {
  const value = exactObject(input, ["rowid", "entity_id", "sanity", "inventory", "weapons", "armor", "updated_at"], path);
  return {
    rowid: integer(value.rowid, `${path}.rowid`, 1), entity_id: stringValue(value.entity_id, `${path}.entity_id`),
    sanity: value.sanity === null ? null : jsonObject(value.sanity, `${path}.sanity`),
    inventory: stringArray(value.inventory, `${path}.inventory`), weapons: stringArray(value.weapons, `${path}.weapons`),
    armor: stringArray(value.armor, `${path}.armor`), updated_at: integer(value.updated_at, `${path}.updated_at`, 0),
  };
}

function validateRelationship(input: unknown, path: string): RelationshipSnapshotRow {
  const value = exactObject(input, ["rowid", "id", "entity_a", "entity_b", "relation", "attitude", "note", "updated_at"], path);
  const id = integer(value.id, `${path}.id`, 1);
  const rowid = integer(value.rowid, `${path}.rowid`, 1);
  if (rowid !== id) fail(`${path}.rowid must equal the relationship id`);
  return {
    rowid, id, entity_a: stringValue(value.entity_a, `${path}.entity_a`), entity_b: stringValue(value.entity_b, `${path}.entity_b`),
    relation: stringValue(value.relation, `${path}.relation`), attitude: numberValue(value.attitude, `${path}.attitude`),
    note: nullableString(value.note, `${path}.note`), updated_at: integer(value.updated_at, `${path}.updated_at`, 0),
  };
}

function validateClueDiscovery(input: unknown, path: string): ClueDiscoverySnapshotRow {
  const value = exactObject(input, ["rowid", "player_id", "clue_id", "discovered_at"], path);
  return {
    rowid: integer(value.rowid, `${path}.rowid`, 1), player_id: stringValue(value.player_id, `${path}.player_id`),
    clue_id: stringValue(value.clue_id, `${path}.clue_id`), discovered_at: integer(value.discovered_at, `${path}.discovered_at`, 0),
  };
}

function validateSceneVisit(input: unknown, path: string): SceneVisitSnapshotRow {
  const value = exactObject(input, ["rowid", "player_id", "scene_id", "first_visited_at"], path);
  return {
    rowid: integer(value.rowid, `${path}.rowid`, 1), player_id: stringValue(value.player_id, `${path}.player_id`),
    scene_id: stringValue(value.scene_id, `${path}.scene_id`), first_visited_at: integer(value.first_visited_at, `${path}.first_visited_at`, 0),
  };
}

function validateClueFailCount(input: unknown, path: string): ClueFailCountSnapshotRow {
  const value = exactObject(input, ["rowid", "clue_id", "fail_count", "updated_at"], path);
  return {
    rowid: integer(value.rowid, `${path}.rowid`, 1), clue_id: stringValue(value.clue_id, `${path}.clue_id`),
    fail_count: integer(value.fail_count, `${path}.fail_count`, 0), updated_at: integer(value.updated_at, `${path}.updated_at`, 0),
  };
}

function validateScene(input: unknown, path: string): SceneSnapshotRow {
  const value = exactObject(input, ["rowid", "id", "name", "description", "lighting", "dangers", "exits", "is_active"], path);
  return {
    rowid: integer(value.rowid, `${path}.rowid`, 1), id: stringValue(value.id, `${path}.id`),
    name: stringValue(value.name, `${path}.name`), description: stringValue(value.description, `${path}.description`),
    lighting: nullableString(value.lighting, `${path}.lighting`), dangers: stringArray(value.dangers, `${path}.dangers`),
    exits: jsonArray(value.exits, `${path}.exits`), is_active: bit(value.is_active, `${path}.is_active`),
  };
}

function validateHistoricalSnapshot(input: unknown, path: string): HistoricalSnapshotRow {
  const value = exactObject(input, ["rowid", "id", "round", "timestamp", "state_json", "context_text", "event_count"], path);
  const id = integer(value.id, `${path}.id`, 1);
  const rowid = integer(value.rowid, `${path}.rowid`, 1);
  if (rowid !== id) fail(`${path}.rowid must equal the historical snapshot id`);
  return {
    rowid, id, round: integer(value.round, `${path}.round`, 0), timestamp: integer(value.timestamp, `${path}.timestamp`, 0),
    state_json: jsonValue(value.state_json, `${path}.state_json`), context_text: stringValue(value.context_text, `${path}.context_text`),
    event_count: integer(value.event_count, `${path}.event_count`, 0),
  };
}

function validateEventLog(input: unknown, path: string): EventLogSnapshotRow {
  const value = exactObject(input, [
    "rowid", "id", "round", "timestamp", "event_type", "actor", "target", "description", "result_json", "causation_id",
  ], path);
  const id = integer(value.id, `${path}.id`, 1);
  const rowid = integer(value.rowid, `${path}.rowid`, 1);
  if (rowid !== id) fail(`${path}.rowid must equal the event id`);
  return {
    rowid, id, round: integer(value.round, `${path}.round`, 0), timestamp: integer(value.timestamp, `${path}.timestamp`, 0),
    event_type: enumValue(value.event_type, EVENT_TYPES, `${path}.event_type`), actor: nullableString(value.actor, `${path}.actor`),
    target: nullableString(value.target, `${path}.target`), description: stringValue(value.description, `${path}.description`),
    result_json: value.result_json === null ? null : jsonValue(value.result_json, `${path}.result_json`),
    causation_id: nullableString(value.causation_id, `${path}.causation_id`),
  };
}

function validateCrossTableConstraints(tables: WorldStateSnapshotTables, sequences: WorldStateSnapshotSequences): void {
  unique(tables.entities, (row) => row.id, "entities.id");
  unique(tables.effects, (row) => row.id, "effects.id");
  unique(tables.inventory, (row) => row.id, "inventory.id");
  unique(tables.player_state, (row) => row.entity_id, "player_state.entity_id");
  unique(tables.relationships, (row) => row.id, "relationships.id");
  unique(tables.relationships, (row) => unorderedCompositeKey(row.entity_a, row.entity_b), "relationships.entity_a/entity_b");
  unique(tables.clue_discoveries, (row) => compositeKey(row.player_id, row.clue_id), "clue_discoveries.player_id/clue_id");
  unique(tables.scene_visits, (row) => compositeKey(row.player_id, row.scene_id), "scene_visits.player_id/scene_id");
  unique(tables.clue_fail_counts, (row) => row.clue_id, "clue_fail_counts.clue_id");
  unique(tables.scenes, (row) => row.id, "scenes.id");
  atMostOne(tables.scenes, (row) => row.is_active === 1, "active scenes");
  unique(tables.snapshots, (row) => row.id, "snapshots.id");
  unique(tables.event_log, (row) => row.id, "event_log.id");

  const rowidTables: Array<[string, Array<{ rowid: number }>]> = [
    ["entities", tables.entities], ["effects", tables.effects], ["inventory", tables.inventory],
    ["player_state", tables.player_state], ["relationships", tables.relationships],
    ["clue_discoveries", tables.clue_discoveries], ["scene_visits", tables.scene_visits],
    ["clue_fail_counts", tables.clue_fail_counts], ["scenes", tables.scenes],
    ["snapshots", tables.snapshots], ["event_log", tables.event_log],
  ];
  for (const [name, table] of rowidTables) unique(table, (row) => row.rowid, `${name}.rowid`);

  const entityIds = new Set(tables.entities.map((row) => row.id));
  for (const row of tables.effects) {
    if (!entityIds.has(row.target)) fail(`effects target does not exist: ${row.target}`);
  }
  for (const row of tables.inventory) {
    if (!entityIds.has(row.entity_id)) fail(`inventory entity does not exist: ${row.entity_id}`);
  }
  ensureSequence(sequences.inventory, tables.inventory, "inventory");
  ensureSequence(sequences.relationships, tables.relationships, "relationships");
  ensureSequence(sequences.snapshots, tables.snapshots, "snapshots");
  ensureSequence(sequences.event_log, tables.event_log, "event_log");
}

function ensureSequence(sequence: number, rows: Array<{ id: number }>, name: string): void {
  const largestId = rows.reduce((largest, row) => Math.max(largest, row.id), 0);
  if (sequence < largestId) fail(`snapshot.sequences.${name} is below its largest id`);
}

function rows<T>(input: unknown, name: string, validate: (row: unknown, path: string) => T): T[] {
  return arrayValues(input, `snapshot.tables.${name}`, MAX_ROWS_PER_TABLE)
    .map((row, index) => validate(row, `snapshot.tables.${name}[${index}]`));
}

function unique<T>(rows: readonly T[], key: (row: T) => string | number, name: string): void {
  const seen = new Set<string | number>();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) fail(`duplicate ${name}: ${String(value)}`);
    seen.add(value);
  }
}

function atMostOne<T>(rows: readonly T[], matches: (row: T) => boolean, name: string): void {
  let count = 0;
  for (const row of rows) {
    if (!matches(row)) continue;
    count += 1;
    if (count > 1) fail(`multiple ${name}`);
  }
}

/** JSON array encoding is injective for a tuple of strings, unlike a separator. */
function compositeKey(...values: string[]): string {
  return JSON.stringify(values);
}

function unorderedCompositeKey(first: string, second: string): string {
  return first <= second ? compositeKey(first, second) : compositeKey(second, first);
}

function exactObject(input: unknown, keys: readonly string[], path: string): UnknownRecord {
  if (!isPlainObject(input)) fail(`${path} must be a plain object`);
  const object = input as UnknownRecord;
  const actual = ownEnumerableDataPropertyNames(object, path);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail(`${path} has unexpected or missing keys`);
  }
  return object;
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length > MAX_STRING_LENGTH) {
    fail(`${path} must be a string within bounds`);
  }
  return input;
}

function nullableString(input: unknown, path: string): string | null {
  return input === null ? null : stringValue(input, path);
}

function integer(input: unknown, path: string, minimum = Number.MIN_SAFE_INTEGER): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum) {
    fail(`${path} must be a safe integer >= ${minimum}`);
  }
  return input;
}

function numberValue(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || Math.abs(input) > Number.MAX_SAFE_INTEGER) {
    fail(`${path} must be a finite JSON number within bounds`);
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
  return arrayValues(input, path, MAX_JSON_MEMBERS)
    .map((value, index) => stringValue(value, `${path}[${index}]`));
}

function numericJsonObject(input: unknown, path: string): JsonObject {
  const object = jsonObject(input, path);
  for (const [key, value] of Object.entries(object)) {
    numberValue(value, `${path}.${key}`);
  }
  return object;
}

function jsonObject(input: unknown, path: string): JsonObject {
  if (!isPlainObject(input)) fail(`${path} must be a JSON object`);
  return jsonValue(input, path) as JsonObject;
}

function jsonArray(input: unknown, path: string): JsonValue[] {
  const values = arrayValues(input, path, MAX_JSON_MEMBERS);
  values.forEach((value, index) => assertJson(value, `${path}[${index}]`, 1));
  return values as JsonValue[];
}

function jsonValue(input: unknown, path: string): JsonValue {
  assertJson(input, path, 0);
  return input as JsonValue;
}

function assertJson(input: unknown, path: string, depth: number): void {
  if (depth > MAX_JSON_DEPTH) fail(`${path} exceeds JSON nesting bounds`);
  if (input === null || typeof input === "boolean") return;
  if (typeof input === "string") {
    stringValue(input, path);
    return;
  }
  if (typeof input === "number") {
    numberValue(input, path);
    return;
  }
  if (Array.isArray(input)) {
    const values = arrayValues(input, path, MAX_JSON_MEMBERS);
    values.forEach((value, index) => assertJson(value, `${path}[${index}]`, depth + 1));
    return;
  }
  if (isPlainObject(input)) {
    const keys = ownEnumerableDataPropertyNames(input, path);
    if (keys.length > MAX_JSON_MEMBERS) fail(`${path} exceeds JSON object bounds`);
    for (const key of keys) {
      stringValue(key, `${path} key`);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      assertJson(descriptor!.value, `${path}.${key}`, depth + 1);
    }
    return;
  }
  fail(`${path} is not JSON-safe`);
}

/**
 * JSON arrays cannot contain holes, accessors, symbols, custom properties, or
 * a custom prototype. Reading descriptor values avoids executing user getters
 * while validating an untrusted restore document.
 */
function arrayValues(input: unknown, path: string, maximumLength: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    fail(`${path} must be a plain array`);
  }
  if (input.length > maximumLength) fail(`${path} must be an array within bounds`);
  if (Object.getOwnPropertySymbols(input).length > 0) fail(`${path} must not contain symbol properties`);

  const names = Object.getOwnPropertyNames(input);
  if (names.length !== input.length + 1 || !names.includes("length")) {
    fail(`${path} must not contain sparse or extra properties`);
  }
  const length = Object.getOwnPropertyDescriptor(input, "length");
  if (!length || !("value" in length) || length.enumerable || length.value !== input.length) {
    fail(`${path} has an invalid length property`);
  }

  const values: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}[${index}] must be an own enumerable data property`);
    }
    values.push(descriptor.value);
  }
  return values;
}

/** Reject getters, hidden fields, and symbols before any property value is read. */
function ownEnumerableDataPropertyNames(object: object, path: string): string[] {
  if (Object.getOwnPropertySymbols(object).length > 0) fail(`${path} must not contain symbol properties`);
  const names = Object.getOwnPropertyNames(object);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}.${name} must be an own enumerable data property`);
    }
  }
  return names;
}

function canonicalJson(input: unknown): string {
  assertJson(input, "hash input", 0);
  if (input === null || typeof input === "boolean" || typeof input === "number" || typeof input === "string") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  const object = input as UnknownRecord;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function fail(message: string): never {
  throw new Error(`Invalid world state snapshot: ${message}`);
}
