import {
  NPC_MEMORY_TYPES,
  NPC_MOODS,
  NPC_RULESETS,
  type MemoryEntry,
  type NPCMood,
  type NPCPersonality,
} from "./types";

/** Stable identity for the portable AgentRegistry runtime document. */
export const AGENT_REGISTRY_SNAPSHOT_KIND = "agent-registry" as const;
export const AGENT_REGISTRY_SNAPSHOT_VERSION = 1 as const;

export const AGENT_REGISTRY_SNAPSHOT_LIMITS = Object.freeze({
  maxAgents: 4_096,
  maxMemoriesPerAgent: 10_000,
  maxArrayMembers: 4_096,
  maxObjectMembers: 4_096,
  maxStringLength: 65_536,
  maxNameLength: 256,
});

export interface AgentRegistrySnapshotAgent {
  personality: NPCPersonality;
  memories: MemoryEntry[];
  mood: NPCMood;
  relationship: number;
  playerInteractionCount: number;
}

/** Complete, data-only runtime state in Map insertion order. */
export interface AgentRegistrySnapshot {
  kind: typeof AGENT_REGISTRY_SNAPSHOT_KIND;
  schemaVersion: typeof AGENT_REGISTRY_SNAPSHOT_VERSION;
  agents: AgentRegistrySnapshotAgent[];
}

type UnknownRecord = Record<string, unknown>;

const hasOwn = Object.prototype.hasOwnProperty;
const moods = new Set<NPCMood>(NPC_MOODS);
const rulesets = new Set<NonNullable<NPCPersonality["ruleset"]>>(NPC_RULESETS);
const memoryTypes = new Set<MemoryEntry["type"]>(NPC_MEMORY_TYPES);
const MAX_SAFE_ABSOLUTE_NUMBER = Number.MAX_SAFE_INTEGER;

/** Validate and JSON-clone a newly exported snapshot. */
export function createAgentRegistrySnapshot(input: AgentRegistrySnapshot): AgentRegistrySnapshot {
  return validateAgentRegistrySnapshot(input);
}

/**
 * Strictly validate a portable snapshot and return a detached JSON-safe copy.
 * This is the single validation boundary for AgentRegistry restores.
 */
export function validateAgentRegistrySnapshot(input: unknown): AgentRegistrySnapshot {
  const root = recordWithKeys(input, "snapshot", ["kind", "schemaVersion", "agents"]);
  if (root.kind !== AGENT_REGISTRY_SNAPSHOT_KIND) {
    fail("snapshot.kind", `must be ${AGENT_REGISTRY_SNAPSHOT_KIND}`);
  }
  if (root.schemaVersion !== AGENT_REGISTRY_SNAPSHOT_VERSION) {
    fail("snapshot.schemaVersion", `must be ${AGENT_REGISTRY_SNAPSHOT_VERSION}`);
  }

  const agents = arrayValue(root.agents, "snapshot.agents", AGENT_REGISTRY_SNAPSHOT_LIMITS.maxAgents)
    .map((agent, index) => validateAgent(agent, `snapshot.agents[${index}]`));
  const names = new Set<string>();
  for (const agent of agents) {
    if (names.has(agent.personality.name)) fail("snapshot.agents", `duplicate agent name ${agent.personality.name}`);
    names.add(agent.personality.name);
  }

  return { kind: AGENT_REGISTRY_SNAPSHOT_KIND, schemaVersion: AGENT_REGISTRY_SNAPSHOT_VERSION, agents };
}

function validateAgent(input: unknown, path: string): AgentRegistrySnapshotAgent {
  const record = recordWithKeys(input, path, ["personality", "memories", "mood", "relationship", "playerInteractionCount"]);
  return {
    personality: validatePersonality(record.personality, `${path}.personality`),
    memories: arrayValue(record.memories, `${path}.memories`, AGENT_REGISTRY_SNAPSHOT_LIMITS.maxMemoriesPerAgent)
      .map((memory, index) => validateMemory(memory, `${path}.memories[${index}]`)),
    mood: enumValue(record.mood, moods, `${path}.mood`),
    relationship: finiteNumber(record.relationship, `${path}.relationship`, -5, 5),
    playerInteractionCount: safeInteger(record.playerInteractionCount, `${path}.playerInteractionCount`, 0),
  };
}

function validatePersonality(input: unknown, path: string): NPCPersonality {
  const record = recordWithKeys(
    input,
    path,
    ["name", "role", "personality", "background", "goals", "speech_style", "knowledge", "secrets"],
    ["attitudes", "ruleset", "traits", "factions", "initialMood"],
  );
  const personality: NPCPersonality = {
    name: stringValue(record.name, `${path}.name`, 1, AGENT_REGISTRY_SNAPSHOT_LIMITS.maxNameLength),
    role: stringValue(record.role, `${path}.role`),
    personality: stringValue(record.personality, `${path}.personality`),
    background: stringValue(record.background, `${path}.background`),
    goals: stringArray(record.goals, `${path}.goals`),
    speech_style: stringValue(record.speech_style, `${path}.speech_style`),
    knowledge: stringArray(record.knowledge, `${path}.knowledge`),
    secrets: stringArray(record.secrets, `${path}.secrets`),
  };
  if (hasOwn.call(record, "attitudes")) personality.attitudes = validateAttitudes(record.attitudes, `${path}.attitudes`);
  if (hasOwn.call(record, "ruleset")) personality.ruleset = enumValue(record.ruleset, rulesets, `${path}.ruleset`);
  if (hasOwn.call(record, "traits")) personality.traits = validateTraits(record.traits, `${path}.traits`);
  if (hasOwn.call(record, "factions")) personality.factions = validateFactions(record.factions, `${path}.factions`);
  if (hasOwn.call(record, "initialMood")) personality.initialMood = enumValue(record.initialMood, moods, `${path}.initialMood`);
  return personality;
}

function validateTraits(input: unknown, path: string): NonNullable<NPCPersonality["traits"]> {
  const record = recordWithKeys(input, path, ["courage", "friendliness", "suspicion", "curiosity", "stability"]);
  return {
    courage: finiteNumber(record.courage, `${path}.courage`),
    friendliness: finiteNumber(record.friendliness, `${path}.friendliness`),
    suspicion: finiteNumber(record.suspicion, `${path}.suspicion`),
    curiosity: finiteNumber(record.curiosity, `${path}.curiosity`),
    stability: finiteNumber(record.stability, `${path}.stability`),
  };
}

function validateFactions(input: unknown, path: string): NonNullable<NPCPersonality["factions"]> {
  return arrayValue(input, path, AGENT_REGISTRY_SNAPSHOT_LIMITS.maxArrayMembers).map((faction, index) => {
    const factionPath = `${path}[${index}]`;
    const record = recordWithKeys(faction, factionPath, ["name", "loyalty"]);
    return {
      name: stringValue(record.name, `${factionPath}.name`, 1, AGENT_REGISTRY_SNAPSHOT_LIMITS.maxNameLength),
      loyalty: finiteNumber(record.loyalty, `${factionPath}.loyalty`),
    };
  });
}

function validateAttitudes(input: unknown, path: string): Record<string, string> {
  const record = dataRecord(input, path);
  const entries = Object.keys(record);
  if (entries.length > AGENT_REGISTRY_SNAPSHOT_LIMITS.maxObjectMembers) {
    fail(path, `must contain at most ${AGENT_REGISTRY_SNAPSHOT_LIMITS.maxObjectMembers} members`);
  }
  const attitudes: Record<string, string> = {};
  for (const name of entries) {
    const boundedName = stringValue(name, `${path} key`, 1, AGENT_REGISTRY_SNAPSHOT_LIMITS.maxNameLength);
    Object.defineProperty(attitudes, boundedName, {
      value: stringValue(record[name], `${path}.${name}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return attitudes;
}

function validateMemory(input: unknown, path: string): MemoryEntry {
  const record = recordWithKeys(
    input,
    path,
    ["timestamp", "type", "content", "importance"],
    ["scene_id", "related_entities", "is_summary"],
  );
  const memory: MemoryEntry = {
    timestamp: safeInteger(record.timestamp, `${path}.timestamp`, 0),
    type: enumValue(record.type, memoryTypes, `${path}.type`),
    content: stringValue(record.content, `${path}.content`),
    importance: safeInteger(record.importance, `${path}.importance`, 1, 10),
  };
  if (hasOwn.call(record, "scene_id")) memory.scene_id = stringValue(record.scene_id, `${path}.scene_id`);
  if (hasOwn.call(record, "related_entities")) memory.related_entities = stringArray(record.related_entities, `${path}.related_entities`);
  if (hasOwn.call(record, "is_summary")) memory.is_summary = booleanValue(record.is_summary, `${path}.is_summary`);
  return memory;
}

function recordWithKeys(
  input: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  const record = dataRecord(input, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.has(key)) fail(path, `contains unexpected key ${key}`);
  }
  for (const key of required) {
    if (!hasOwn.call(record, key)) fail(path, `is missing required key ${key}`);
  }
  return record;
}

function dataRecord(input: unknown, path: string): UnknownRecord {
  if (!isPlainRecord(input)) fail(path, "must be a plain JSON object");
  if (Object.getOwnPropertySymbols(input).length > 0) fail(path, "must not contain symbol keys");
  for (const key of Object.getOwnPropertyNames(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}.${key}`, "must be an enumerable JSON data property");
    }
  }
  return input;
}

function isPlainRecord(input: unknown): input is UnknownRecord {
  return typeof input === "object"
    && input !== null
    && !Array.isArray(input)
    && Object.getPrototypeOf(input) === Object.prototype;
}

function arrayValue(input: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail(path, "must be a JSON array");
  if (input.length > maximum) fail(path, `must contain at most ${maximum} entries`);
  if (Object.getOwnPropertySymbols(input).length > 0) fail(path, "must not contain symbol keys");
  for (const key of Object.getOwnPropertyNames(input)) {
    if (key === "length") continue;
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length) fail(path, "must not contain non-index properties");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) fail(`${path}[${key}]`, "must be a JSON data property");
  }
  for (let index = 0; index < input.length; index++) {
    if (!hasOwn.call(input, index)) fail(`${path}[${index}]`, "must not be sparse");
  }
  return input;
}

function stringArray(input: unknown, path: string): string[] {
  return arrayValue(input, path, AGENT_REGISTRY_SNAPSHOT_LIMITS.maxArrayMembers)
    .map((value, index) => stringValue(value, `${path}[${index}]`));
}

function stringValue(input: unknown, path: string, minimum: number = 0, maximum: number = AGENT_REGISTRY_SNAPSHOT_LIMITS.maxStringLength): string {
  if (typeof input !== "string" || input.length < minimum || input.length > maximum) {
    fail(path, `must be a string with length ${minimum}..${maximum}`);
  }
  return input;
}

function booleanValue(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") fail(path, "must be a boolean");
  return input;
}

function safeInteger(input: unknown, path: string, minimum: number, maximum: number = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > maximum) {
    fail(path, `must be a safe integer in ${minimum}..${maximum}`);
  }
  return input;
}

function finiteNumber(input: unknown, path: string, minimum: number = -MAX_SAFE_ABSOLUTE_NUMBER, maximum: number = MAX_SAFE_ABSOLUTE_NUMBER): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < minimum || input > maximum) {
    fail(path, `must be a finite number in ${minimum}..${maximum}`);
  }
  return input;
}

function enumValue<T extends string>(input: unknown, allowed: ReadonlySet<T>, path: string): T {
  if (typeof input !== "string" || !allowed.has(input as T)) fail(path, "has an illegal enum value");
  return input as T;
}

function fail(path: string, reason: string): never {
  throw new Error(`Invalid agent registry snapshot at ${path}: ${reason}`);
}
