import type { CompanionConfig, CompanionSnapshot, WorldEntity } from "../types";

/** Stable identity for the portable, complete CompanionManager document. */
export const COMPANION_MANAGER_SNAPSHOT_KIND = "companion-manager" as const;
export const COMPANION_MANAGER_SNAPSHOT_VERSION = 1 as const;

export const COMPANION_MANAGER_SNAPSHOT_LIMITS = Object.freeze({
  maxCompanions: 4_096,
  maxInventoryItems: 4_096,
  maxSkills: 256,
  maxDepartures: 64,
  maxResolveTurns: 10_000,
  maxStringLength: 65_536,
  maxIdLength: 256,
});

type CompanionBehavior = "aggressive" | "defensive" | "support";
type CompanionControl = "auto" | `player:${string}`;
type CompanionResolveState = "normal" | "steadfast" | "afflicted" | "berserk";

export interface CompanionStateSnapshot {
  id: string;
  config: CompanionConfig;
  entityId: string;
  behavior: CompanionBehavior;
  active: boolean;
  inventory: string[];
  morale: number;
  invited: boolean;
  control: CompanionControl;
  resolveState: CompanionResolveState;
  resolveTurnsLeft: number;
}

/** JSON-safe full state, including inactive registrations and round bookkeeping. */
export interface CompanionManagerSnapshot {
  kind: typeof COMPANION_MANAGER_SNAPSHOT_KIND;
  schemaVersion: typeof COMPANION_MANAGER_SNAPSHOT_VERSION;
  companions: CompanionStateSnapshot[];
  actedThisRound: string[];
  lastRefusal: string;
}

/** The restorer needs only a read-only world lookup for active-entity checks. */
export interface CompanionSnapshotWorld {
  getEntity(entityId: string): WorldEntity | null;
}

const hasOwn = Object.prototype.hasOwnProperty;
const COMPANION_BEHAVIORS = new Set<CompanionBehavior>(["aggressive", "defensive", "support"]);
const COMPANION_TYPES = new Set<WorldEntity["type"]>(["pc", "npc", "monster", "item"]);
const RESOLVE_STATES = new Set<CompanionResolveState>(["normal", "steadfast", "afflicted", "berserk"]);
const DEPARTURE_TRIGGERS = new Set<NonNullable<CompanionConfig["departure"]>[number]["trigger"]>([
  "hp_zero", "morale_cower", "motivation_done",
]);

type UnknownRecord = Record<string, unknown>;

function fail(path: string, reason: string): never {
  throw new Error(`Invalid companion manager snapshot at ${path}: ${reason}`);
}

function isPlainRecord(input: unknown): input is UnknownRecord {
  return typeof input === "object"
    && input !== null
    && !Array.isArray(input)
    && Object.getPrototypeOf(input) === Object.prototype;
}

function recordWithKeys(
  input: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  if (!isPlainRecord(input)) fail(path, "must be a plain JSON object");
  const allowed = new Set([...required, ...optional]);
  if (Object.getOwnPropertySymbols(input).length > 0) fail(path, "must not contain symbol keys");
  for (const key of Object.getOwnPropertyNames(input)) {
    if (!allowed.has(key)) fail(path, `contains unexpected key ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) fail(`${path}.${key}`, "must be a JSON data property");
  }
  for (const key of required) {
    if (!hasOwn.call(input, key)) fail(path, `is missing required key ${key}`);
  }
  return input;
}

function plainDataRecord(input: unknown, path: string): UnknownRecord {
  if (!isPlainRecord(input)) fail(path, "must be a plain JSON object");
  if (Object.getOwnPropertySymbols(input).length > 0) fail(path, "must not contain symbol keys");
  for (const key of Object.getOwnPropertyNames(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) fail(`${path}.${key}`, "must be a JSON data property");
  }
  return input;
}

function jsonArray(input: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    fail(path, "must be a JSON array");
  }
  if (input.length > maximum) fail(path, `must contain at most ${maximum} entries`);
  if (Object.getOwnPropertySymbols(input).length > 0) fail(path, "must not contain symbol keys");
  for (const key of Object.getOwnPropertyNames(input)) {
    if (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)) fail(path, "must not contain non-index properties");
  }
  for (let index = 0; index < input.length; index++) {
    if (!hasOwn.call(input, index)) fail(`${path}[${index}]`, "must not be sparse");
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor)) fail(`${path}[${index}]`, "must be a JSON data property");
  }
  return input;
}

function stringValue(input: unknown, path: string, maximum: number = COMPANION_MANAGER_SNAPSHOT_LIMITS.maxStringLength): string {
  if (typeof input !== "string" || input.length > maximum) {
    fail(path, `must be a string with at most ${maximum} characters`);
  }
  return input;
}

function identifier(input: unknown, path: string): string {
  const value = stringValue(input, path, COMPANION_MANAGER_SNAPSHOT_LIMITS.maxIdLength);
  if (value.length === 0) fail(path, "must not be empty");
  return value;
}

function boundedInteger(input: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(input) || typeof input !== "number" || input < minimum || input > maximum) {
    fail(path, `must be a safe integer from ${minimum} to ${maximum}`);
  }
  return input;
}

function enumValue<T extends string>(input: unknown, path: string, values: ReadonlySet<T>): T {
  if (typeof input !== "string" || !values.has(input as T)) fail(path, "has an illegal enum value");
  return input as T;
}

function stringArray(input: unknown, path: string, maximum: number): string[] {
  return jsonArray(input, path, maximum).map((value, index) => stringValue(value, `${path}[${index}]`));
}

function validateSkills(input: unknown, path: string): Record<string, number> {
  const record = plainDataRecord(input, path);
  const keys = Object.getOwnPropertyNames(record);
  if (keys.length > COMPANION_MANAGER_SNAPSHOT_LIMITS.maxSkills) {
    fail(path, `must contain at most ${COMPANION_MANAGER_SNAPSHOT_LIMITS.maxSkills} skills`);
  }
  const skills: Record<string, number> = {};
  for (const key of keys) {
    const skill = identifier(key, `${path} key`);
    if (skill === "__proto__" || skill === "prototype" || skill === "constructor") {
      fail(`${path} key`, "must not be a prototype-sensitive name");
    }
    skills[skill] = boundedInteger(record[key], `${path}.${skill}`, 0, 100);
  }
  return skills;
}

function validateTraits(input: unknown, path: string): NonNullable<CompanionConfig["traits"]> {
  const record = recordWithKeys(input, path, ["courage", "aggression", "caution", "loyalty", "cruelty"]);
  return {
    courage: boundedInteger(record.courage, `${path}.courage`, 1, 10),
    aggression: boundedInteger(record.aggression, `${path}.aggression`, 1, 10),
    caution: boundedInteger(record.caution, `${path}.caution`, 1, 10),
    loyalty: boundedInteger(record.loyalty, `${path}.loyalty`, 1, 10),
    cruelty: boundedInteger(record.cruelty, `${path}.cruelty`, 1, 10),
  };
}

function validateRecruit(input: unknown, path: string): NonNullable<CompanionConfig["recruit"]> {
  const record = recordWithKeys(input, path, ["greeting"], ["skill", "dc", "failGreeting"]);
  const result: NonNullable<CompanionConfig["recruit"]> = {
    greeting: stringValue(record.greeting, `${path}.greeting`),
  };
  if (hasOwn.call(record, "skill")) result.skill = identifier(record.skill, `${path}.skill`);
  if (hasOwn.call(record, "dc")) result.dc = boundedInteger(record.dc, `${path}.dc`, 0, 99);
  if (hasOwn.call(record, "failGreeting")) result.failGreeting = stringValue(record.failGreeting, `${path}.failGreeting`);
  return result;
}

function validateDeparture(input: unknown, path: string): NonNullable<CompanionConfig["departure"]>[number] {
  const record = recordWithKeys(input, path, ["trigger", "description", "farewell"], ["canRejoin"]);
  const trigger = enumValue(record.trigger, `${path}.trigger`, DEPARTURE_TRIGGERS);
  const result: NonNullable<CompanionConfig["departure"]>[number] = {
    trigger,
    description: stringValue(record.description, `${path}.description`),
    farewell: stringValue(record.farewell, `${path}.farewell`),
  };
  if (hasOwn.call(record, "canRejoin")) {
    if (typeof record.canRejoin !== "boolean") fail(`${path}.canRejoin`, "must be boolean");
    result.canRejoin = record.canRejoin;
  }
  return result;
}

function validateConfig(input: unknown, path: string): CompanionConfig {
  const record = recordWithKeys(
    input,
    path,
    ["id", "name", "type", "hp", "maxHp", "ac", "skills", "damageDice", "behavior"],
    ["weapon", "faction", "traits", "inventory", "recruit", "departure", "motivation"],
  );
  const maxHp = boundedInteger(record.maxHp, `${path}.maxHp`, 0, 1_000_000);
  const hp = boundedInteger(record.hp, `${path}.hp`, 0, maxHp);
  const result: CompanionConfig = {
    id: identifier(record.id, `${path}.id`),
    name: stringValue(record.name, `${path}.name`),
    type: enumValue(record.type, `${path}.type`, COMPANION_TYPES),
    hp,
    maxHp,
    ac: boundedInteger(record.ac, `${path}.ac`, 0, 1_000),
    skills: validateSkills(record.skills, `${path}.skills`),
    damageDice: stringValue(record.damageDice, `${path}.damageDice`),
    behavior: enumValue(record.behavior, `${path}.behavior`, COMPANION_BEHAVIORS),
  };
  if (hasOwn.call(record, "weapon")) result.weapon = stringValue(record.weapon, `${path}.weapon`);
  if (hasOwn.call(record, "faction")) result.faction = stringValue(record.faction, `${path}.faction`);
  if (hasOwn.call(record, "traits")) result.traits = validateTraits(record.traits, `${path}.traits`);
  if (hasOwn.call(record, "inventory")) {
    result.inventory = stringArray(record.inventory, `${path}.inventory`, COMPANION_MANAGER_SNAPSHOT_LIMITS.maxInventoryItems);
  }
  if (hasOwn.call(record, "recruit")) result.recruit = validateRecruit(record.recruit, `${path}.recruit`);
  if (hasOwn.call(record, "departure")) {
    result.departure = jsonArray(record.departure, `${path}.departure`, COMPANION_MANAGER_SNAPSHOT_LIMITS.maxDepartures)
      .map((entry, index) => validateDeparture(entry, `${path}.departure[${index}]`));
  }
  if (hasOwn.call(record, "motivation")) result.motivation = stringValue(record.motivation, `${path}.motivation`);
  return result;
}

function validateControl(input: unknown, path: string): CompanionControl {
  if (input === "auto") return input;
  const value = stringValue(input, path, COMPANION_MANAGER_SNAPSHOT_LIMITS.maxIdLength);
  if (!/^player:.+$/u.test(value)) fail(path, "must be auto or player:<userId>");
  return value as CompanionControl;
}

function validateCompanion(input: unknown, path: string): CompanionStateSnapshot {
  const record = recordWithKeys(input, path, [
    "id", "config", "entityId", "behavior", "active", "inventory", "morale", "invited", "control", "resolveState", "resolveTurnsLeft",
  ]);
  const config = validateConfig(record.config, `${path}.config`);
  const id = identifier(record.id, `${path}.id`);
  if (id !== config.id) fail(path, "id must equal config.id");
  if (typeof record.active !== "boolean") fail(`${path}.active`, "must be boolean");
  if (typeof record.invited !== "boolean") fail(`${path}.invited`, "must be boolean");
  const resolveState = enumValue(record.resolveState, `${path}.resolveState`, RESOLVE_STATES);
  const resolveTurnsLeft = boundedInteger(
    record.resolveTurnsLeft,
    `${path}.resolveTurnsLeft`,
    0,
    COMPANION_MANAGER_SNAPSHOT_LIMITS.maxResolveTurns,
  );
  if ((resolveState === "normal") !== (resolveTurnsLeft === 0)) {
    fail(path, "normal resolveState must have zero turns and non-normal state must have positive turns");
  }
  return {
    id,
    config,
    entityId: identifier(record.entityId, `${path}.entityId`),
    behavior: enumValue(record.behavior, `${path}.behavior`, COMPANION_BEHAVIORS),
    active: record.active,
    inventory: stringArray(record.inventory, `${path}.inventory`, COMPANION_MANAGER_SNAPSHOT_LIMITS.maxInventoryItems),
    morale: boundedInteger(record.morale, `${path}.morale`, 0, 10),
    invited: record.invited,
    control: validateControl(record.control, `${path}.control`),
    resolveState,
    resolveTurnsLeft,
  };
}

/**
 * Strictly validates and rebuilds every field, so callers never retain input
 * aliases and an imported document cannot contain non-JSON values.
 */
export function validateCompanionManagerSnapshot(input: unknown): CompanionManagerSnapshot {
  const record = recordWithKeys(input, "$", ["kind", "schemaVersion", "companions", "actedThisRound", "lastRefusal"]);
  if (record.kind !== COMPANION_MANAGER_SNAPSHOT_KIND) fail("$.kind", "is not companion-manager");
  if (record.schemaVersion !== COMPANION_MANAGER_SNAPSHOT_VERSION) fail("$.schemaVersion", "is unsupported");

  const companions = jsonArray(record.companions, "$.companions", COMPANION_MANAGER_SNAPSHOT_LIMITS.maxCompanions)
    .map((entry, index) => validateCompanion(entry, `$.companions[${index}]`));
  const ids = new Set<string>();
  const entityIds = new Set<string>();
  for (const companion of companions) {
    if (ids.has(companion.id)) fail("$.companions", `contains duplicate id ${companion.id}`);
    if (entityIds.has(companion.entityId)) fail("$.companions", `contains duplicate entityId ${companion.entityId}`);
    ids.add(companion.id);
    entityIds.add(companion.entityId);
  }

  const actedThisRound = stringArray(record.actedThisRound, "$.actedThisRound", COMPANION_MANAGER_SNAPSHOT_LIMITS.maxCompanions)
    .map((id, index) => identifier(id, `$.actedThisRound[${index}]`));
  const actedIds = new Set<string>();
  for (const id of actedThisRound) {
    if (actedIds.has(id)) fail("$.actedThisRound", `contains duplicate id ${id}`);
    actedIds.add(id);
    const companion = companions.find((entry) => entry.id === id);
    if (!companion) fail("$.actedThisRound", `contains unknown companion id ${id}`);
    if (!companion.active) fail("$.actedThisRound", `must contain only active companions (found ${id})`);
  }

  return {
    kind: COMPANION_MANAGER_SNAPSHOT_KIND,
    schemaVersion: COMPANION_MANAGER_SNAPSHOT_VERSION,
    companions,
    actedThisRound,
    lastRefusal: stringValue(record.lastRefusal, "$.lastRefusal"),
  };
}

/**
 * Validate the pre-versioned active-only array form before its compatibility
 * restore path mutates the world. Missing resolve fields are normalized for
 * snapshots created before resolve state became persistent.
 */
export function validateLegacyCompanionSnapshots(input: unknown): CompanionSnapshot[] {
  const snapshots = jsonArray(input, "$", COMPANION_MANAGER_SNAPSHOT_LIMITS.maxCompanions);
  const configIds = new Set<string>();
  const entityIds = new Set<string>();
  return snapshots.map((entry, index) => {
    const path = `$[${index}]`;
    const record = recordWithKeys(
      entry,
      path,
      ["configId", "hp", "maxHp", "inventory", "morale", "behavior", "control", "entityId"],
      ["resolveState", "resolveTurnsLeft"],
    );
    const configId = identifier(record.configId, `${path}.configId`);
    const entityId = identifier(record.entityId, `${path}.entityId`);
    if (configIds.has(configId)) fail("$", `contains duplicate legacy configId ${configId}`);
    if (entityIds.has(entityId)) fail("$", `contains duplicate legacy entityId ${entityId}`);
    configIds.add(configId);
    entityIds.add(entityId);

    const maxHp = boundedInteger(record.maxHp, `${path}.maxHp`, 0, 1_000_000);
    const hp = boundedInteger(record.hp, `${path}.hp`, 0, maxHp);
    const resolveState = hasOwn.call(record, "resolveState")
      ? enumValue(record.resolveState, `${path}.resolveState`, RESOLVE_STATES)
      : "normal";
    const resolveTurnsLeft = hasOwn.call(record, "resolveTurnsLeft")
      ? boundedInteger(record.resolveTurnsLeft, `${path}.resolveTurnsLeft`, 0, COMPANION_MANAGER_SNAPSHOT_LIMITS.maxResolveTurns)
      : 0;
    if ((resolveState === "normal") !== (resolveTurnsLeft === 0)) {
      fail(path, "normal resolveState must have zero turns and non-normal state must have positive turns");
    }
    return {
      configId,
      hp,
      maxHp,
      inventory: stringArray(record.inventory, `${path}.inventory`, COMPANION_MANAGER_SNAPSHOT_LIMITS.maxInventoryItems),
      morale: boundedInteger(record.morale, `${path}.morale`, 0, 10),
      behavior: enumValue(record.behavior, `${path}.behavior`, COMPANION_BEHAVIORS),
      control: validateControl(record.control, `${path}.control`),
      entityId,
      resolveState,
      resolveTurnsLeft,
    };
  });
}

/** Validate active references against an already-restored world without mutating it. */
export function validateCompanionSnapshotWorld(
  snapshot: CompanionManagerSnapshot,
  world: CompanionSnapshotWorld,
): void {
  for (const companion of snapshot.companions) {
    if (!companion.active) continue;
    const entity = world.getEntity(companion.entityId);
    if (!entity) fail(`$.companions[${companion.id}]`, "active companion entity does not exist in world");
    if (entity.id !== companion.entityId) fail(`$.companions[${companion.id}]`, "world entity id disagrees with companion entityId");
    if (entity.name !== companion.config.name || entity.type !== companion.config.type) {
      fail(`$.companions[${companion.id}]`, "world entity identity disagrees with companion config");
    }
    if (!Number.isSafeInteger(entity.hp) || entity.hp < 0 || entity.hp > companion.config.maxHp) {
      fail(`$.companions[${companion.id}]`, "world entity hp is out of the configured range");
    }
    if (entity.maxHp !== companion.config.maxHp || entity.ac !== companion.config.ac) {
      fail(`$.companions[${companion.id}]`, "world entity combat values disagree with companion config");
    }
    if (entity.faction !== (companion.config.faction ?? "player_ally")) {
      fail(`$.companions[${companion.id}]`, "world entity faction disagrees with companion config");
    }
  }
}
