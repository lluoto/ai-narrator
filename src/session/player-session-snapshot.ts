import {
  AGENT_MESSAGE_TYPES,
  NPC_MOODS,
  VISIBILITY_RULES,
  type AgentMessage,
} from "../agent/types";

/** A nested component document; a future outer session envelope owns integrity. */
export const PLAYER_SESSION_SNAPSHOT_KIND = "player-session" as const;
export const PLAYER_SESSION_SNAPSHOT_VERSION = 1 as const;

/** Persisted input limits. They prevent an imported session becoming unbounded. */
export const PLAYER_SESSION_SNAPSHOT_LIMITS = Object.freeze({
  maxPlayers: 64,
  maxMessagesPerPlayer: 10_000,
  maxGlobalMessages: 50_000,
  maxKnownSecretsPerPlayer: 4_096,
  maxVisibleTo: 64,
  maxStringLength: 65_536,
});

export interface PlayerSessionSnapshotPlayer {
  name: string;
  characterName: string;
  characterId: string;
  joinedAt: number;
  messageHistory: AgentMessage[];
  knownSecrets: string[];
}

/** JSON-safe, versioned representation of PlayerSession state. */
export interface PlayerSessionSnapshot {
  kind: typeof PLAYER_SESSION_SNAPSHOT_KIND;
  schemaVersion: typeof PLAYER_SESSION_SNAPSHOT_VERSION;
  players: PlayerSessionSnapshotPlayer[];
  activePlayerName: string | null;
  globalMessages: AgentMessage[];
}

const hasOwn = Object.prototype.hasOwnProperty;
const MESSAGE_REQUIRED_KEYS = ["speaker", "content", "type"] as const;
const MESSAGE_OPTIONAL_KEYS = ["verbatim", "mood", "visible_to", "timestamp", "visibility", "discoverer"] as const;

function fail(path: string, reason: string): never {
  throw new Error(`invalid player-session snapshot at ${path}: ${reason}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function recordWithKeys(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(path, "must be a plain JSON object");
  const allowed = new Set([...required, ...optional]);
  const ownKeys = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(path, "must not contain symbol keys");
  for (const key of ownKeys) {
    if (!allowed.has(key)) fail(path, `contains unknown key ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}.${key}`, "must be an enumerable JSON data property");
    }
  }
  for (const key of required) {
    if (!hasOwn.call(value, key)) fail(path, `missing ${key}`);
  }
  return value;
}

function jsonArray(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(path, "must be a JSON array");
  if (value.length > maximum) fail(path, `must contain at most ${maximum} entries`);
  for (let index = 0; index < value.length; index++) {
    if (!hasOwn.call(value, index)) fail(`${path}[${index}]`, "must not be sparse");
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) fail(`${path}[${index}]`, "must be a JSON data property");
  }
  if (Object.getOwnPropertySymbols(value).length > 0
    || Object.getOwnPropertyNames(value).some((key) => key !== "length"
      && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
    fail(path, "must not contain non-index properties");
  }
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > PLAYER_SESSION_SNAPSHOT_LIMITS.maxStringLength) {
    fail(path, `must be at most ${PLAYER_SESSION_SNAPSHOT_LIMITS.maxStringLength} characters`);
  }
  return value;
}

function safeNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "must be a non-negative safe integer");
  }
  return value;
}

function includes<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function validateMessage(input: unknown, path: string): AgentMessage {
  const message = recordWithKeys(input, path, MESSAGE_REQUIRED_KEYS, MESSAGE_OPTIONAL_KEYS);
  const type = stringAt(message.type, `${path}.type`);
  if (!includes(AGENT_MESSAGE_TYPES, type)) fail(`${path}.type`, "is not an AgentMessage type");
  const result: AgentMessage = {
    speaker: stringAt(message.speaker, `${path}.speaker`),
    content: stringAt(message.content, `${path}.content`),
    type,
  };
  if (hasOwn.call(message, "verbatim")) {
    if (typeof message.verbatim !== "boolean") fail(`${path}.verbatim`, "must be boolean");
    result.verbatim = message.verbatim;
  }
  if (hasOwn.call(message, "mood")) {
    const mood = stringAt(message.mood, `${path}.mood`);
    if (!includes(NPC_MOODS, mood)) fail(`${path}.mood`, "is not an NPC mood");
    result.mood = mood;
  }
  if (hasOwn.call(message, "visible_to")) {
    const visibleTo = jsonArray(message.visible_to, `${path}.visible_to`, PLAYER_SESSION_SNAPSHOT_LIMITS.maxVisibleTo)
      .map((entry, index) => stringAt(entry, `${path}.visible_to[${index}]`));
    if (new Set(visibleTo).size !== visibleTo.length) fail(`${path}.visible_to`, "must not contain duplicates");
    result.visible_to = visibleTo;
  }
  if (hasOwn.call(message, "timestamp")) result.timestamp = safeNonNegativeInteger(message.timestamp, `${path}.timestamp`);
  if (hasOwn.call(message, "visibility")) {
    const visibility = stringAt(message.visibility, `${path}.visibility`);
    if (!includes(VISIBILITY_RULES, visibility)) fail(`${path}.visibility`, "is not a visibility rule");
    result.visibility = visibility;
  }
  if (hasOwn.call(message, "discoverer")) result.discoverer = stringAt(message.discoverer, `${path}.discoverer`);
  return result;
}

function validatePlayer(input: unknown, path: string): PlayerSessionSnapshotPlayer {
  const player = recordWithKeys(input, path, ["name", "characterName", "characterId", "joinedAt", "messageHistory", "knownSecrets"]);
  const messageHistory = jsonArray(player.messageHistory, `${path}.messageHistory`, PLAYER_SESSION_SNAPSHOT_LIMITS.maxMessagesPerPlayer)
    .map((message, index) => validateMessage(message, `${path}.messageHistory[${index}]`));
  const knownSecrets = jsonArray(player.knownSecrets, `${path}.knownSecrets`, PLAYER_SESSION_SNAPSHOT_LIMITS.maxKnownSecretsPerPlayer)
    .map((secret, index) => stringAt(secret, `${path}.knownSecrets[${index}]`));
  if (new Set(knownSecrets).size !== knownSecrets.length) fail(`${path}.knownSecrets`, "must not contain duplicates");
  return {
    name: stringAt(player.name, `${path}.name`),
    characterName: stringAt(player.characterName, `${path}.characterName`),
    characterId: stringAt(player.characterId, `${path}.characterId`),
    joinedAt: safeNonNegativeInteger(player.joinedAt, `${path}.joinedAt`),
    messageHistory,
    knownSecrets,
  };
}

function sameMessage(left: AgentMessage, right: AgentMessage): boolean {
  const visibleToEqual = left.visible_to === undefined && right.visible_to === undefined
    || left.visible_to !== undefined
      && right.visible_to !== undefined
      && left.visible_to.length === right.visible_to.length
      && left.visible_to.every((name, index) => name === right.visible_to![index]);
  return left.speaker === right.speaker
    && left.content === right.content
    && left.type === right.type
    && left.verbatim === right.verbatim
    && left.mood === right.mood
    && visibleToEqual
    && left.timestamp === right.timestamp
    && left.visibility === right.visibility
    && left.discoverer === right.discoverer;
}

function validateHistoryAuditTrail(players: readonly PlayerSessionSnapshotPlayer[], globalMessages: readonly AgentMessage[]): void {
  for (const player of players) {
    let globalIndex = 0;
    for (const [historyIndex, message] of player.messageHistory.entries()) {
      while (globalIndex < globalMessages.length && !sameMessage(message, globalMessages[globalIndex]!)) {
        globalIndex++;
      }
      if (globalIndex === globalMessages.length) {
        fail(`$.players[${player.name}].messageHistory[${historyIndex}]`, "is not an ordered member of globalMessages");
      }
      globalIndex++;
    }
  }
}

/**
 * Validate and reconstruct a detached component snapshot. Rebuilding every
 * value prevents exported or restored arrays from sharing PlayerSession state.
 */
export function validatePlayerSessionSnapshot(input: unknown): PlayerSessionSnapshot {
  const snapshot = recordWithKeys(input, "$", ["kind", "schemaVersion", "players", "activePlayerName", "globalMessages"]);
  if (snapshot.kind !== PLAYER_SESSION_SNAPSHOT_KIND) fail("$.kind", "is not player-session");
  if (snapshot.schemaVersion !== PLAYER_SESSION_SNAPSHOT_VERSION) fail("$.schemaVersion", "is unsupported");

  const players = jsonArray(snapshot.players, "$.players", PLAYER_SESSION_SNAPSHOT_LIMITS.maxPlayers)
    .map((player, index) => validatePlayer(player, `$.players[${index}]`));
  const names = players.map((player) => player.name);
  if (new Set(names).size !== names.length) fail("$.players", "must not contain duplicate player names");

  const activePlayerName = snapshot.activePlayerName === null
    ? null
    : stringAt(snapshot.activePlayerName, "$.activePlayerName");
  if ((players.length === 0) !== (activePlayerName === null)) {
    fail("$.activePlayerName", "must be null exactly when there are no players");
  }
  if (activePlayerName !== null && !names.includes(activePlayerName)) {
    fail("$.activePlayerName", "does not name a player in this snapshot");
  }

  const globalMessages = jsonArray(snapshot.globalMessages, "$.globalMessages", PLAYER_SESSION_SNAPSHOT_LIMITS.maxGlobalMessages)
    .map((message, index) => validateMessage(message, `$.globalMessages[${index}]`));
  // A receiver may legitimately omit any global message, but it cannot carry a
  // message absent from the complete audit log or reorder that log locally.
  validateHistoryAuditTrail(players, globalMessages);
  return {
    kind: PLAYER_SESSION_SNAPSHOT_KIND,
    schemaVersion: PLAYER_SESSION_SNAPSHOT_VERSION,
    players,
    activePlayerName,
    globalMessages,
  };
}
