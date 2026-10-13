import { createHash } from "crypto";
import { basename, join, resolve } from "path";
import {
  CompiledSessionSnapshotCoordinator,
  SnapshotCoordinatorFailure,
  type CompiledSessionSnapshotCoordinatorLike,
  type SnapshotCoordinatorPolicy,
} from "./compiled-session-snapshot-coordinator";
import {
  compiledSessionSnapshotNodeFileOps,
  canonicalJson,
  type CompiledSessionSnapshotFileOps,
} from "./compiled-session-snapshot";
import {
  validateOrdinaryGameSessionSnapshotWire,
  validateOrdinarySessionTerminal,
  ORDINARY_GAME_SESSION_SNAPSHOT_VERSION,
  type OrdinaryGameSessionSnapshotWire,
  type OrdinarySessionTerminal,
  type OrdinarySnapshotJson,
} from "./ordinary-game-session-snapshot";
import {
  isOrdinarySessionAccessBinding,
  sameOrdinarySessionAccessBinding,
  type OrdinarySessionAccessBinding,
} from "./session-access";
import {
  consumeSessionNamespacePublication,
  type SessionNamespacePublicationGate,
  type SessionNamespaceStorePublication,
} from "./session-namespace-publication";
import { COC_ATTRIBUTES, SKILL_NAME_MAP } from "../character/coc-character";

const ORDINARY_CHARACTER_SKILL_KEYS = new Set(Object.values(SKILL_NAME_MAP));
const ORDINARY_CHARACTER_ATTRIBUTE_KEYS = new Set(COC_ATTRIBUTES);
const ORDINARY_RESERVED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** An intentionally separate on-disk protocol from compiled-session snapshots. */
/**
 * 1.4.0 replaces the bounded in-envelope complete ledger with a bounded hot
 * window, receipt archive, and pointer-bound authenticated replay directory.
 * Earlier bodies are intentionally refused: treating their truncated shape as an archive would
 * make an old retry eligible for re-execution.
 */
/**
 * 1.5.0 authenticates a discriminated durable-operation receipt.  In
 * particular a structured party creation cannot be confused with text input
 * merely because both use an actionId idempotency key.
 */
export const ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION = "1.5.0";
/** 1.4.0 receipts were text-action-only and remain read/replay compatible. */
export const LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION = "1.4.0";
/**
 * The coordinator names the SQLite CAS/quota policy and its file layout, not
 * the authenticated envelope wire.  Existing 1.4 roots already persist this
 * value; keep it stable until that policy/database format itself changes.
 */
export const ORDINARY_SESSION_COORDINATOR_POLICY_SCHEMA_VERSION = "1.4.0";
type OrdinaryEnvelopeSchemaVersion = typeof ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION
  | typeof LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION;
export const ORDINARY_SESSION_ENVELOPE_DOMAIN = "ordinary-session-envelope-v1";
/** Stable namespace fingerprint format, independent from envelope schema revisions. */
export const ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT = ORDINARY_SESSION_ENVELOPE_DOMAIN;
export const ORDINARY_SESSION_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const ORDINARY_SESSION_IDEMPOTENCY_LIMIT = 128;

export interface OrdinarySessionArchiveState {
  count: number;
  headHash: string | null;
  /** The predecessor named by `headHash`, duplicated in the committed pointer. */
  previousHeadHash: string | null;
}

/** Authenticated lookup directory: unlike an on-disk locator hint, this root
 * is part of the envelope hash and can distinguish an absent key from a
 * committed cold key without scanning the append log. */
export interface OrdinarySessionReplayDirectoryState {
  count: number;
  rootHash: string | null;
}

export interface OrdinaryActionSnapshotProjection {
  snapshotHash: string;
  round: number;
  dead: boolean;
  narrative: string;
  scene: string;
  player: { name: string; hp: number; maxHp: number; ac: number };
  gameTime: { day: number; period: string };
  sanity: {
    currentSAN: number; maxSAN: number; temporaryInsanity: boolean; indefiniteInsanity: boolean;
    phobias: string[]; manias: string[];
  };
  summary: { id: string; round: number; ruleset: string; scene: string; playerName: string; archetype: string; messageCount: number; npcCount: number; createdAt: number };
}

/** 1.5 adds snapshot-bound active-subject and party facts for structured operation receipts. */
export interface OrdinaryOperationSnapshotProjection extends OrdinaryActionSnapshotProjection {
  activePlayerId: string;
  party: Array<{ pcId: string; name: string; archetype: string; meta: { personality?: string; backstory?: string; currentGoal?: string }; luck: number | null }>;
  /** Present only for character_patch receipts. It is deliberately an archive
   * projection extension, so existing 1.5 party/luck receipt hashes remain
   * readable unchanged. */
  characterPatch?: {
    pcId: string;
    character: OrdinarySnapshotJson;
    inventory: string[];
    weapons: string[];
  };
  /** Present only for kp_message. This is a delivery audit, not a caller
   * selected recipient: it must be the exact final public global message and
   * the final history item of every current player. */
  kpMessage?: { speaker: string; content: string; type: "system" | "narration"; timestamp: number };
}
type OrdinaryReceiptSnapshotProjection = OrdinaryActionSnapshotProjection | OrdinaryOperationSnapshotProjection;

interface OrdinaryPersistedOperationRecordBase {
  actionId: string;
  requestHash: string;
  input: string;
  pcId: string | null;
  expectedGeneration: number;
  generation: number;
  response: OrdinarySnapshotJson;
}

/** Original 1.4 text receipt, retained verbatim for archive/hash replay. */
export interface OrdinaryLegacyTextActionRecord extends OrdinaryPersistedOperationRecordBase {
  status: 200;
  operation?: never;
}

/** Current explicit text operation receipt. */
export interface OrdinaryTextActionRecord extends OrdinaryPersistedOperationRecordBase {
  status: 200;
  operation: OrdinaryTextActionOperation;
}

/** Backward-compatible public alias for existing text receipt consumers. */
export type OrdinaryPersistedActionRecord = OrdinaryLegacyTextActionRecord | OrdinaryTextActionRecord;

export interface OrdinaryTextActionOperation {
  kind: "text_action";
  input: string;
  pcId: string | null;
}

export interface OrdinaryPartyMemberCreateOperation {
  kind: "party_member_create";
  name: string;
  archetype: string;
  meta: { personality?: string; backstory?: string; currentGoal?: string };
}

export interface OrdinaryLuckSpendOperation {
  kind: "luck_spend";
  amount: number;
}

/** A closed, detached character-card patch. The active PC is selected only from
 * the durable predecessor snapshot; request data never carries a PC selector. */
export interface OrdinaryCharacterPatchOperation {
  kind: "character_patch";
  patch: {
    hp?: number;
    maxHp?: number;
    skills?: Record<string, number>;
    inventory?: string[];
    weapons?: string[];
    luck?: number;
    creditRating?: number;
    attributes?: Record<string, number>;
  };
}

/** A host-only public announcement; it carries no source, target, or player selector. */
export interface OrdinaryKpMessageOperation {
  kind: "kp_message";
  speaker: string;
  content: string;
  type: "system" | "narration";
}

/** The canonical request payload that the durable receipt and hash name. */
export type OrdinaryDurableOperation = OrdinaryTextActionOperation | OrdinaryPartyMemberCreateOperation | OrdinaryLuckSpendOperation | OrdinaryCharacterPatchOperation | OrdinaryKpMessageOperation;

/** A structured party receipt is an HTTP 201, including on exact replay. */
export interface OrdinaryPersistedPartyMemberCreateRecord extends OrdinaryPersistedOperationRecordBase {
  status: 201;
  operation: OrdinaryPartyMemberCreateOperation;
  /**
   * A fixed empty legacy slot prevents structural operation JSON from being
   * smuggled through text input while keeping old generic receipt readers
   * source-compatible.
   */
  input: "";
  pcId: null;
}

/** A Luck spend is a current structured receipt but retains HTTP 200 semantics. */
export interface OrdinaryPersistedLuckSpendRecord extends OrdinaryPersistedOperationRecordBase {
  status: 200;
  operation: OrdinaryLuckSpendOperation;
  input: "";
  pcId: null;
}

/** Character-card mutation receipts retain normal 200 replay semantics. */
export interface OrdinaryPersistedCharacterPatchRecord extends OrdinaryPersistedOperationRecordBase {
  status: 200;
  operation: OrdinaryCharacterPatchOperation;
  input: "";
  pcId: null;
}

/** Host announcements retain normal 200 replay semantics. */
export interface OrdinaryPersistedKpMessageRecord extends OrdinaryPersistedOperationRecordBase {
  status: 200;
  operation: OrdinaryKpMessageOperation;
  input: "";
  pcId: null;
}

export type OrdinaryPersistedOperationRecord = OrdinaryPersistedActionRecord | OrdinaryPersistedPartyMemberCreateRecord | OrdinaryPersistedLuckSpendRecord | OrdinaryPersistedCharacterPatchRecord | OrdinaryPersistedKpMessageRecord;

/** Immutable archive node.  Its hash is named by the envelope's archive head. */
export interface OrdinaryArchivedActionReceipt {
  kind: "ordinary-action-receipt";
  schemaVersion: OrdinaryEnvelopeSchemaVersion;
  sessionId: string;
  previousArchiveHash: string | null;
  record: OrdinaryPersistedOperationRecord;
  projection: OrdinaryReceiptSnapshotProjection;
  archiveHash: string;
}

export interface OrdinarySessionEnvelope {
  kind: "ordinary-session-envelope";
  schemaVersion: OrdinaryEnvelopeSchemaVersion;
  sessionId: string;
  generation: number;
  previousEnvelopeHash: string | null;
  access: OrdinarySessionAccessBinding;
  /**
   * A current snapshot or an authenticated 1.1/1.0 wire predecessor. Legacy
   * wire is retained verbatim until the next normal successor upgrades it.
   */
  snapshot: OrdinaryGameSessionSnapshotWire;
  /** Bounded hot replay window; older IDs resolve through `archive`. */
  idempotency: OrdinaryPersistedOperationRecord[];
  archive: OrdinarySessionArchiveState;
  replayDirectory: OrdinarySessionReplayDirectoryState;
  envelopeHash: string;
}

export interface OrdinarySessionEnvelopeHeader {
  fileName: string;
  sessionId: string;
  envelopeHash: string;
  generation: number;
  bodyBytes: number;
}

export type OrdinarySessionSnapshotRefusalCode =
  | "ORDINARY_SNAPSHOT_NOT_FOUND" | "ORDINARY_SNAPSHOT_CORRUPT" | "ORDINARY_SNAPSHOT_INCOMPATIBLE"
  | "ORDINARY_SNAPSHOT_STORAGE_FAILED" | "ORDINARY_SNAPSHOT_CONFLICT" | "ORDINARY_SNAPSHOT_BUSY"
  | "ORDINARY_SNAPSHOT_POLICY_MISMATCH" | "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED"
  | "ORDINARY_SNAPSHOT_NAMESPACE_FENCED";
export type OrdinarySessionSnapshotResult<T> =
  | { status: "ok"; value: T }
  | { status: "refused"; code: OrdinarySessionSnapshotRefusalCode; message: string; sessionId?: string };
export type OrdinarySessionSnapshotWriteResult<T> = OrdinarySessionSnapshotResult<T>
  | { status: "indeterminate"; code: "ORDINARY_SNAPSHOT_INDETERMINATE"; message: string; sessionId: string };

interface HeaderFile {
  schemaVersion: OrdinaryEnvelopeSchemaVersion;
  sessionId: string;
  envelopeHash: string;
  generation: number;
  bodyBytes: number;
}

const ORDINARY_USAGE_MANIFEST_FILE = ".ordinary-session-envelope-usage.json";
// Only manifests written by the all-publications dirty-before-artifact
// protocol are safe to trust without a directory rebuild.  Keeping this
// separate from the envelope schema lets an upgraded writer distrust clean
// counters that an older implementation could have left stale after a crash.
const ORDINARY_USAGE_MANIFEST_BARRIER = "dirty-before-artifact-v1";
interface OrdinaryUsageManifest {
  kind: "ordinary-session-envelope-usage";
  schemaVersion: typeof ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION;
  barrier: typeof ORDINARY_USAGE_MANIFEST_BARRIER;
  clean: boolean;
  entries: number;
  bytes: number;
}
interface OrdinaryUsage { entries: number; bytes: number; }

export interface OrdinarySessionSnapshotStoreOptions {
  root?: string;
  maxEntries?: number;
  maxBytes?: number;
  /** Per-store hard LRU bound for complete replay-tree audit checkpoints. Zero disables the cache. */
  maxAuditedReplaySets?: number;
  fileOps?: CompiledSessionSnapshotFileOps;
  coordinatorFactory?: (root: string, policy: SnapshotCoordinatorPolicy) => CompiledSessionSnapshotCoordinatorLike;
  /** Server-owned synchronous namespace verifier for a namespace-required root. */
  namespacePublicationGate?: SessionNamespacePublicationGate;
  /**
   * Test-only standalone-store seam. Production roots must publish through a
   * coordinator permit; this may not be enabled by an HTTP request.
   */
  allowUncoordinatedTestWrites?: boolean;
  /** Test-only in-process publication seam; no server request can configure it. */
  testHooks?: OrdinarySessionSnapshotStoreTestHooks;
}

export interface OrdinarySessionSnapshotStoreTestHooks {
  onPublicationStage?(stage: "dirty-persisted" | "first-artifact-persisted" | "pointer-durable-before-clean"): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Inspect only envelope/receipt records without traversing the inner snapshot contract. */
function outerDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) throw new Error(`${label} contains an accessor`);
  const result: Record<string, unknown> = {};
  // Assignment would invoke Object.prototype.__proto__ and silently make a
  // closed-record key disappear. Preserve it as own data so the schema that
  // owns this record can explicitly reject it.
  for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(result, key, {
    value: (descriptor as PropertyDescriptor & { value: unknown }).value,
    enumerable: true, configurable: true, writable: true,
  });
  return result;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function validHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validGeneration(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validActionId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,191}$/.test(value); }
function strictJson(value: unknown, budget = { nodes: 0 }, depth = 0): OrdinarySnapshotJson {
  if (++budget.nodes > 20_000 || depth > 48) throw new Error("ordinary persisted response exceeds JSON complexity limits");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { if (value.length > 50_000) throw new Error("ordinary persisted response string is too long"); return value; }
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("ordinary persisted response has a non-finite number"); return value; }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length || value.length > 4096) throw new Error("ordinary persisted response array is invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
    const ownNames = Object.getOwnPropertyNames(value);
    const lengthDescriptor = descriptors["length"];
    // JSON arrays have exactly contiguous enumerable data indexes and their
    // one non-enumerable length property. Named/hidden/accessor side channels
    // must not disappear merely because strictJson iterates numeric indexes.
    if (ownNames.length !== value.length + 1 || !lengthDescriptor
      || lengthDescriptor.enumerable || !("value" in lengthDescriptor)) {
      throw new Error("ordinary persisted response array has named or invalid properties");
    }
    const result: OrdinarySnapshotJson[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("ordinary persisted response array has an accessor or hole");
      result.push(strictJson(descriptor.value, budget, depth + 1));
    }
    return result;
  }
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) throw new Error("ordinary persisted response object is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 4096 || keys.some((key) => !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) throw new Error("ordinary persisted response object has an accessor");
  const result: { [key: string]: OrdinarySnapshotJson } = {};
  // Do not use bracket assignment here: strictJson is the shared hostile
  // response materializer and must never erase an enumerable __proto__ key.
  for (const key of keys) Object.defineProperty(result, key, {
    value: strictJson((descriptors[key]! as PropertyDescriptor & { value: unknown }).value, budget, depth + 1),
    enumerable: true, configurable: true, writable: true,
  });
  return result;
}

function boundedText(value: unknown, label: string, max = 50_000): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}
function boundedInteger(value: unknown, label: string, min = -1_000_000, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`);
  return value;
}
function boundedStringArray(value: unknown, label: string, maxItems = 256, maxText = 512): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} is invalid`);
  return value.map((entry, index) => boundedText(entry, `${label}[${index}]`, maxText));
}
function exactOptionalKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** The ordinary response is persisted indefinitely, so its optional display
 * fields need a real bounded schema rather than a generic JSON escape hatch. */
function validateOrdinaryResponseDisplaySchema(root: Record<string, unknown>): void {
  const state = outerDataRecord(root.state, "ordinary persisted action state");
  if (!exactOptionalKeys(state, ["scene", "round", "player", "npcs", "monsters", "companions", "party", "gameTime"], ["bgm", "inventory", "sceneItems"])
    || !validGeneration(state.round)) throw new Error("ordinary persisted action state schema is invalid");
  boundedText(state.scene, "ordinary persisted action scene", 512);
  if (state.bgm !== undefined) boundedText(state.bgm, "ordinary persisted action BGM", 512);
  const validateCombatant = (raw: unknown, label: string, player = false) => {
    const entity = outerDataRecord(raw, label);
    if (!(player
      ? exactOptionalKeys(entity, ["name", "hp", "maxHp", "ac", "status"], ["luck"])
      : exactKeys(entity, ["name", "hp", "maxHp", "status"]))) throw new Error(`${label} schema is invalid`);
    boundedText(entity.name, `${label} name`, 512); boundedInteger(entity.hp, `${label} HP`); boundedInteger(entity.maxHp, `${label} max HP`, 0);
    if (player) boundedInteger(entity.ac, `${label} AC`, -100, 1_000);
    if (player && entity.luck !== undefined) boundedInteger(entity.luck, `${label} Luck`, 0, 99);
    boundedStringArray(entity.status, `${label} status`, 128, 512);
  };
  validateCombatant(state.player, "ordinary persisted action player", true);
  const validateList = (value: unknown, label: string, fn: (entry: unknown, itemLabel: string) => void) => {
    if (!Array.isArray(value) || value.length > 128) throw new Error(`${label} is invalid`);
    value.forEach((entry, index) => fn(entry, `${label}[${index}]`));
  };
  validateList(state.npcs, "ordinary persisted action NPCs", validateCombatant);
  validateList(state.monsters, "ordinary persisted action monsters", validateCombatant);
  validateList(state.party, "ordinary persisted action party", (raw, label) => {
    const member = outerDataRecord(raw, label);
    if (!exactKeys(member, ["pcId", "name", "control", "hp", "maxHp", "status", "san", "maxSan"])
      || !validId(member.pcId) || typeof member.control !== "string") throw new Error(`${label} schema is invalid`);
    boundedText(member.name, `${label} name`, 512); boundedText(member.control, `${label} control`, 256);
    boundedInteger(member.hp, `${label} HP`); boundedInteger(member.maxHp, `${label} max HP`, 0); boundedStringArray(member.status, `${label} status`, 128, 512);
    const maxSan = boundedInteger(member.maxSan, `${label} max SAN`, 0, 100); boundedInteger(member.san, `${label} SAN`, 0, maxSan);
  });
  validateList(state.companions, "ordinary persisted action companions", (raw, label) => {
    const companion = outerDataRecord(raw, label);
    if (!exactOptionalKeys(companion, ["id", "name", "hp", "maxHp", "ac", "morale", "behavior", "control", "position", "inventory", "traits", "skills", "resolveState"], ["motivation"])
      || !validId(companion.id)) throw new Error(`${label} schema is invalid`);
    boundedText(companion.name, `${label} name`, 512); boundedInteger(companion.hp, `${label} HP`); boundedInteger(companion.maxHp, `${label} max HP`, 0); boundedInteger(companion.ac, `${label} AC`, -100, 1_000);
    boundedInteger(companion.morale, `${label} morale`, -1_000, 1_000); boundedText(companion.behavior, `${label} behavior`, 256); boundedText(companion.control, `${label} control`, 256); boundedText(companion.position, `${label} position`, 512);
    boundedStringArray(companion.inventory, `${label} inventory`, 256, 512); boundedText(companion.resolveState, `${label} resolve state`, 256);
    if (!(companion.traits === null || (typeof companion.traits === "object" && !Array.isArray(companion.traits)))) throw new Error(`${label} traits are invalid`);
    if (!(companion.skills === null || (typeof companion.skills === "object" && !Array.isArray(companion.skills)))) throw new Error(`${label} skills are invalid`);
    if (companion.motivation !== undefined) boundedText(companion.motivation, `${label} motivation`, 2_000);
  });
  const gameTime = outerDataRecord(state.gameTime, "ordinary persisted action game time");
  if (!exactKeys(gameTime, ["day", "period", "label"])) throw new Error("ordinary persisted action game time schema is invalid");
  boundedInteger(gameTime.day, "ordinary persisted action game day", 1); boundedText(gameTime.period, "ordinary persisted action game period", 32); boundedText(gameTime.label, "ordinary persisted action game time label", 512);
  if (state.inventory !== undefined) boundedStringArray(state.inventory, "ordinary persisted action inventory", 4096, 512);
  if (state.sceneItems !== undefined) boundedStringArray(state.sceneItems, "ordinary persisted action scene items", 4096, 512);
  const events = root.events;
  if (!Array.isArray(events) || events.length > 2048) throw new Error("ordinary persisted action events are invalid");
  for (const [index, raw] of events.entries()) {
    const event = outerDataRecord(raw, `ordinary persisted action event ${index}`);
    if (!exactOptionalKeys(event, ["speaker", "content", "type"], ["verbatim", "voiceKey"])
      || typeof event.verbatim !== "undefined" && typeof event.verbatim !== "boolean") throw new Error("ordinary persisted action event schema is invalid");
    boundedText(event.speaker, "ordinary persisted action event speaker", 512);
    boundedText(event.content, "ordinary persisted action event content", 50_000);
    boundedText(event.type, "ordinary persisted action event type", 64);
    if (event.voiceKey !== undefined) boundedText(event.voiceKey, "ordinary persisted action event voice key", 256);
  }
  if (root.dead !== undefined && typeof root.dead !== "boolean") throw new Error("ordinary persisted action dead state is invalid");
  if (root.sanity !== undefined) {
    const sanity = outerDataRecord(root.sanity, "ordinary persisted action sanity");
    if (!exactOptionalKeys(sanity, ["currentSAN", "maxSAN", "temporaryInsanity", "indefiniteInsanity", "phobias"], ["indefiniteLevel", "manias"])
      || typeof sanity.temporaryInsanity !== "boolean" || typeof sanity.indefiniteInsanity !== "boolean"
      || !(sanity.indefiniteLevel === undefined || sanity.indefiniteLevel === null || ["mild", "moderate", "severe"].includes(sanity.indefiniteLevel as string))) {
      throw new Error("ordinary persisted action sanity schema is invalid");
    }
    const maxSan = boundedInteger(sanity.maxSAN, "ordinary persisted action max SAN", 0, 100);
    boundedInteger(sanity.currentSAN, "ordinary persisted action current SAN", 0, maxSan);
    boundedStringArray(sanity.phobias, "ordinary persisted action phobias", 256, 512);
    if (sanity.manias !== undefined) boundedStringArray(sanity.manias, "ordinary persisted action manias", 256, 512);
  }
  if (root.rolls !== undefined) {
    if (!Array.isArray(root.rolls) || root.rolls.length > 1024) throw new Error("ordinary persisted action rolls are invalid");
    for (const [index, raw] of root.rolls.entries()) {
      const roll = outerDataRecord(raw, `ordinary persisted action roll ${index}`);
      if (!exactKeys(roll, ["skill", "roll", "target", "success"]) || typeof roll.success !== "boolean") throw new Error("ordinary persisted action roll schema is invalid");
      boundedText(roll.skill, "ordinary persisted action roll skill", 512);
      boundedInteger(roll.roll, "ordinary persisted action roll value", 1, 100);
      boundedInteger(roll.target, "ordinary persisted action roll target", 0, 100);
    }
  }
  if (root.dice !== undefined) {
    if (!Array.isArray(root.dice) || root.dice.length > 1024) throw new Error("ordinary persisted action dice are invalid");
    for (const [index, raw] of root.dice.entries()) {
      const die = outerDataRecord(raw, `ordinary persisted action die ${index}`);
      if (!exactOptionalKeys(die, ["expr", "total"], ["detail", "bonus"])) throw new Error("ordinary persisted action die schema is invalid");
      boundedText(die.expr, "ordinary persisted action dice expression", 256);
      boundedInteger(die.total, "ordinary persisted action dice total");
      if (die.detail !== undefined) boundedText(die.detail, "ordinary persisted action dice detail", 2_000);
      if (die.bonus !== undefined) boundedInteger(die.bonus, "ordinary persisted action dice bonus", -100, 100);
    }
  }
}

/** Keep only the public state needed to authenticate an archived HTTP receipt.
 * In particular this never copies module/world tables into every action. */
export function ordinaryActionSnapshotProjection(snapshot: OrdinaryGameSessionSnapshotWire): OrdinaryActionSnapshotProjection {
  const activeScene = snapshot.world.tables.scenes.find((scene) => scene.is_active === 1)?.id ?? "unknown";
  const activeEntity = snapshot.world.tables.entities.find((entity) => entity.id === snapshot.state.activePlayerId);
  const character = snapshot.state.characters.find((entry) => entry.pcId === snapshot.state.activePlayerId);
  const sheet = character ? outerDataRecord(character.sheet, "ordinary action projection character") : undefined;
  const activeHistory = snapshot.playerSession.players.find((entry) => entry.name === snapshot.state.activePlayerId);
  const sanityEntry = snapshot.state.sanities.find((entry) => entry.pcId === snapshot.state.activePlayerId);
  const sanity = sanityEntry ? outerDataRecord(sanityEntry.state, "ordinary action projection sanity") : undefined;
  if (!activeEntity || !sheet || !activeHistory || !sanity
    || typeof sheet.name !== "string" || typeof sheet.archetypeId !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(snapshot.snapshotHash) || !validGeneration(snapshot.state.round)
    || typeof snapshot.state.dead !== "boolean" || typeof snapshot.state.lastNarrative !== "string"
    || !validGeneration(snapshot.state.gameTime.day) || typeof snapshot.state.gameTime.period !== "string"
    || typeof sanity.currentSAN !== "number" || typeof sanity.maxSAN !== "number"
    || typeof sanity.temporaryInsanity !== "boolean" || typeof sanity.indefiniteInsanity !== "boolean") {
    throw new Error("ordinary action snapshot cannot form a receipt projection");
  }
  const phobias = boundedStringArray(sanity.phobias, "ordinary action projection phobias", 256, 512);
  const manias = boundedStringArray(sanity.manias, "ordinary action projection manias", 256, 512);
  return {
    snapshotHash: snapshot.snapshotHash,
    round: snapshot.state.round,
    dead: snapshot.state.dead,
    narrative: snapshot.state.lastNarrative,
    scene: activeScene,
    player: { name: activeEntity.name, hp: activeEntity.hp, maxHp: activeEntity.max_hp, ac: 0 },
    gameTime: { day: snapshot.state.gameTime.day, period: snapshot.state.gameTime.period },
    sanity: {
      currentSAN: boundedInteger(sanity.currentSAN, "ordinary action projection current SAN", 0, 100),
      maxSAN: boundedInteger(sanity.maxSAN, "ordinary action projection max SAN", 0, 100),
      temporaryInsanity: sanity.temporaryInsanity,
      indefiniteInsanity: sanity.indefiniteInsanity,
      phobias,
      manias,
    },
    summary: {
      id: snapshot.session.id,
      round: snapshot.state.round,
      ruleset: snapshot.session.ruleset,
      scene: snapshot.state.sceneDisplayNames[activeScene] ?? activeScene,
      playerName: sheet.name,
      archetype: sheet.archetypeId,
      messageCount: activeHistory.messageHistory.length,
      npcCount: snapshot.world.tables.entities.filter((entity) => entity.type === "npc" && entity.alive === 1).length,
      createdAt: snapshot.session.createdAt,
    },
  };
}

export function ordinaryOperationSnapshotProjection(
  snapshot: OrdinaryGameSessionSnapshotWire,
  schemaVersion: OrdinaryEnvelopeSchemaVersion,
  operation?: OrdinaryDurableOperation,
): OrdinaryReceiptSnapshotProjection {
  const base = ordinaryActionSnapshotProjection(snapshot);
  if (schemaVersion === LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION) return base;
  const activePlayerId = snapshot.state.activePlayerId;
  if (!validId(activePlayerId)) throw new Error("ordinary operation snapshot has an invalid active player");
  const party = snapshot.state.party.map((member) => {
    const character = snapshot.state.characters.find((entry) => entry.pcId === member.pcId);
    const sheet = character ? outerDataRecord(character.sheet, "ordinary operation projection party character") : undefined;
    if (!sheet || typeof sheet.name !== "string" || typeof sheet.archetypeId !== "string") {
      throw new Error("ordinary operation snapshot has an invalid party member");
    }
    const luck = snapshot.session.ruleset === "cosmic-horror"
      ? boundedInteger(sheet.luck, "ordinary operation projection party luck", 0, 99)
      : null;
    return {
      pcId: member.pcId,
      name: boundedText(sheet.name, "ordinary operation projection party name", 128),
      archetype: boundedText(sheet.archetypeId, "ordinary operation projection party archetype", 128),
      meta: structuredClone(member.meta ?? {}),
      luck,
    };
  });
  const projection: OrdinaryOperationSnapshotProjection = { ...base, activePlayerId, party };
  if (operation?.kind === "character_patch") {
    const character = snapshot.state.characters.find((entry) => entry.pcId === activePlayerId);
    const playerState = snapshot.world.tables.player_state.find((entry) => entry.entity_id === activePlayerId);
    if (!character) throw new Error("ordinary character patch projection lacks its active character");
    projection.characterPatch = {
      pcId: activePlayerId,
      character: strictJson(character.sheet),
      inventory: playerState ? boundedStringArray(playerState.inventory, "ordinary character patch projection inventory", 4096, 512) : [],
      weapons: playerState ? boundedStringArray(playerState.weapons, "ordinary character patch projection weapons", 4096, 512) : [],
    };
  }
  if (operation?.kind === "kp_message") {
    const global = snapshot.playerSession.globalMessages.at(-1);
    if (!global || !exactKeys(global as unknown as Record<string, unknown>, ["speaker", "content", "type", "timestamp"])
      || (global.type !== "system" && global.type !== "narration")) {
      throw new Error("ordinary KP message projection lacks a canonical final global message");
    }
    const kpMessage = {
      speaker: boundedText(global.speaker, "ordinary KP message projection speaker", 128),
      content: boundedText(global.content, "ordinary KP message projection content", 8_000),
      type: global.type,
      timestamp: boundedInteger(global.timestamp, "ordinary KP message projection timestamp", 0, Number.MAX_SAFE_INTEGER),
    } as const;
    for (const player of snapshot.playerSession.players) {
      const finalHistoryMessage = player.messageHistory.at(-1);
      if (!finalHistoryMessage || canonicalJson(finalHistoryMessage) !== canonicalJson(kpMessage)) {
        throw new Error("ordinary KP message projection is not delivered to every current player");
      }
    }
    projection.kpMessage = kpMessage;
  }
  return projection;
}

/** Historical hot receipts are validated against their immutable archive
 * projection during store audit. A later operation naturally changes the
 * current snapshot's final message, so envelope-only validation uses this
 * closed response copy only until that archive binding is checked. */
function kpMessageProjectionFromResponse(value: unknown, label: string): NonNullable<OrdinaryOperationSnapshotProjection["kpMessage"]> {
  const root = outerDataRecord(value, label);
  const message = outerDataRecord(root.message, `${label}.message`);
  if (!exactKeys(message, ["speaker", "content", "type", "timestamp"])
    || (message.type !== "system" && message.type !== "narration")) {
    throw new Error(`${label} is invalid`);
  }
  return {
    speaker: boundedText(message.speaker, `${label}.message.speaker`, 128),
    content: boundedText(message.content, `${label}.message.content`, 8_000),
    type: message.type,
    timestamp: boundedInteger(message.timestamp, `${label}.message.timestamp`, 0, Number.MAX_SAFE_INTEGER),
  };
}

/**
 * A 1.4 text receipt has no party projection, so its archived form cannot
 * carry a new authority field without changing the historical hash.  The
 * latest hot receipt is different: its enclosing envelope co-signs the
 * complete snapshot.  Use that canonical snapshot only while validating the
 * current hot record.  `undefined` deliberately means that no co-signed
 * snapshot authority is available (for an immutable historical archive);
 * `null` means the ruleset has no public Luck projection at all.
 */
function ordinaryLegacyHotReceiptLuckAuthority(
  snapshot: OrdinaryGameSessionSnapshotWire,
): number | null {
  if (snapshot.session.ruleset !== "cosmic-horror") return null;
  const character = snapshot.state.characters.find((entry) => entry.pcId === snapshot.state.activePlayerId);
  const sheet = character ? outerDataRecord(character.sheet, "ordinary legacy action Luck authority") : undefined;
  if (!sheet) throw new Error("ordinary legacy action Luck authority is unavailable");
  return boundedInteger(sheet.luck, "ordinary legacy action Luck authority", 0, 99);
}

function validateOrdinaryActionSnapshotProjection(
  value: unknown,
  sessionId: string,
  schemaVersion: OrdinaryEnvelopeSchemaVersion,
): OrdinaryReceiptSnapshotProjection {
  const projection = outerDataRecord(value, "ordinary action receipt projection");
  const expected = schemaVersion === LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION
    ? ["snapshotHash", "round", "dead", "narrative", "scene", "player", "gameTime", "sanity", "summary"]
    : ["snapshotHash", "round", "dead", "narrative", "scene", "player", "gameTime", "sanity", "summary", "activePlayerId", "party"];
  const hasCharacterPatch = Object.hasOwn(projection, "characterPatch");
  const hasKpMessage = Object.hasOwn(projection, "kpMessage");
  if (!exactKeys(projection, [...expected, ...(hasCharacterPatch ? ["characterPatch"] : []), ...(hasKpMessage ? ["kpMessage"] : [])])
    || typeof projection.snapshotHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(projection.snapshotHash)
    || !validGeneration(projection.round) || typeof projection.dead !== "boolean") throw new Error("ordinary action receipt projection is invalid");
  boundedText(projection.narrative, "ordinary action receipt projection narrative");
  boundedText(projection.scene, "ordinary action receipt projection scene", 512);
  const player = outerDataRecord(projection.player, "ordinary action receipt projection player");
  const gameTime = outerDataRecord(projection.gameTime, "ordinary action receipt projection game time");
  const sanity = outerDataRecord(projection.sanity, "ordinary action receipt projection sanity");
  const summary = outerDataRecord(projection.summary, "ordinary action receipt projection summary");
  if (!exactKeys(player, ["name", "hp", "maxHp", "ac"]) || !exactKeys(gameTime, ["day", "period"])
    || !exactKeys(sanity, ["currentSAN", "maxSAN", "temporaryInsanity", "indefiniteInsanity", "phobias", "manias"])
    || !exactKeys(summary, ["id", "round", "ruleset", "scene", "playerName", "archetype", "messageCount", "npcCount", "createdAt"])
    || summary.id !== sessionId || summary.round !== projection.round
    || typeof sanity.temporaryInsanity !== "boolean" || typeof sanity.indefiniteInsanity !== "boolean") throw new Error("ordinary action receipt projection shape is invalid");
  const base: OrdinaryActionSnapshotProjection = {
    snapshotHash: projection.snapshotHash,
    round: projection.round,
    dead: projection.dead,
    narrative: projection.narrative as string,
    scene: projection.scene as string,
    player: { name: boundedText(player.name, "ordinary action receipt projection player name", 512), hp: boundedInteger(player.hp, "ordinary action receipt projection player HP"), maxHp: boundedInteger(player.maxHp, "ordinary action receipt projection player max HP"), ac: boundedInteger(player.ac, "ordinary action receipt projection player AC") },
    gameTime: { day: boundedInteger(gameTime.day, "ordinary action receipt projection game day", 1), period: boundedText(gameTime.period, "ordinary action receipt projection game period", 32) },
    sanity: {
      currentSAN: boundedInteger(sanity.currentSAN, "ordinary action receipt projection current SAN", 0, 100),
      maxSAN: boundedInteger(sanity.maxSAN, "ordinary action receipt projection max SAN", 0, 100),
      temporaryInsanity: sanity.temporaryInsanity as boolean, indefiniteInsanity: sanity.indefiniteInsanity as boolean,
      phobias: boundedStringArray(sanity.phobias, "ordinary action receipt projection phobias", 256, 512),
      manias: boundedStringArray(sanity.manias, "ordinary action receipt projection manias", 256, 512),
    },
    summary: {
      id: sessionId, round: projection.round, ruleset: boundedText(summary.ruleset, "ordinary action receipt projection ruleset", 128), scene: boundedText(summary.scene, "ordinary action receipt projection summary scene", 512),
      playerName: boundedText(summary.playerName, "ordinary action receipt projection player name", 512), archetype: boundedText(summary.archetype, "ordinary action receipt projection archetype", 512),
      messageCount: boundedInteger(summary.messageCount, "ordinary action receipt projection message count", 0), npcCount: boundedInteger(summary.npcCount, "ordinary action receipt projection NPC count", 0), createdAt: boundedInteger(summary.createdAt, "ordinary action receipt projection creation time", 0, Number.MAX_SAFE_INTEGER),
    },
  };
  if (schemaVersion === LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION) return base;
  if (!validId(projection.activePlayerId) || !Array.isArray(projection.party) || projection.party.length > 32) throw new Error("ordinary operation receipt party projection is invalid");
  const party = projection.party.map((raw, index) => {
    const member = outerDataRecord(raw, `ordinary operation receipt party projection ${index}`);
    if (!exactKeys(member, ["pcId", "name", "archetype", "meta", "luck"]) || !validId(member.pcId)) throw new Error("ordinary operation receipt party projection is invalid");
    const meta = outerDataRecord(member.meta, "ordinary operation receipt party projection meta");
    if (!exactOptionalKeys(meta, [], ["personality", "backstory", "currentGoal"])) throw new Error("ordinary operation receipt party projection meta is invalid");
    const normalizedMeta: OrdinaryPartyMemberCreateOperation["meta"] = {};
    for (const key of ["personality", "backstory", "currentGoal"] as const) {
      if (meta[key] !== undefined) normalizedMeta[key] = boundedText(meta[key], `ordinary operation receipt party projection meta ${key}`, 4_000);
    }
    const luck = member.luck === null ? null : boundedInteger(member.luck, "ordinary operation receipt party projection luck", 0, 99);
    return { pcId: member.pcId, name: boundedText(member.name, "ordinary operation receipt party projection name", 128), archetype: boundedText(member.archetype, "ordinary operation receipt party projection archetype", 128), meta: normalizedMeta, luck };
  });
  if (new Set(party.map((member) => member.pcId)).size !== party.length || !party.some((member) => member.pcId === projection.activePlayerId)) throw new Error("ordinary operation receipt party projection has invalid active player");
  const normalized: OrdinaryOperationSnapshotProjection = { ...base, activePlayerId: projection.activePlayerId, party };
  if (hasCharacterPatch) {
    const characterPatch = outerDataRecord(projection.characterPatch, "ordinary character patch receipt projection");
    if (!exactKeys(characterPatch, ["pcId", "character", "inventory", "weapons"])
      || !validId(characterPatch.pcId) || characterPatch.pcId !== projection.activePlayerId) {
      throw new Error("ordinary character patch receipt projection is invalid");
    }
    const projectedCharacter = strictJson(characterPatch.character);
    const inventory = boundedStringArray(characterPatch.inventory, "ordinary character patch receipt projection inventory", 4096, 512);
    const weapons = boundedStringArray(characterPatch.weapons, "ordinary character patch receipt projection weapons", 4096, 512);
    normalized.characterPatch = { pcId: characterPatch.pcId, character: projectedCharacter, inventory, weapons };
  }
  if (hasKpMessage) {
    const message = outerDataRecord(projection.kpMessage, "ordinary KP message receipt projection");
    if (!exactKeys(message, ["speaker", "content", "type", "timestamp"])
      || (message.type !== "system" && message.type !== "narration")) {
      throw new Error("ordinary KP message receipt projection is invalid");
    }
    normalized.kpMessage = {
      speaker: boundedText(message.speaker, "ordinary KP message receipt projection speaker", 128),
      content: boundedText(message.content, "ordinary KP message receipt projection content", 8_000),
      type: message.type,
      timestamp: boundedInteger(message.timestamp, "ordinary KP message receipt projection timestamp", 0, Number.MAX_SAFE_INTEGER),
    };
  }
  return normalized;
}

/** Validate the stable HTTP action receipt surface, not merely JSON syntax. */
function validateOrdinaryActionResponse(
  value: unknown,
  sessionId: string,
  generation: number,
  projection: OrdinaryActionSnapshotProjection,
  terminal: boolean,
  expectedTerminal?: OrdinarySessionTerminal,
  legacyHotReceiptLuckAuthority?: number | null,
): OrdinarySnapshotJson {
  const response = strictJson(value);
  const root = outerDataRecord(response, "ordinary persisted action response");
  const responseKeys = Object.keys(root);
  const allowedResponseKeys = new Set([
    "narrative", "events", "state", "dead", "terminal", "sanity", "rolls", "dice",
    "summary", "sessionKind", "ordinaryGeneration",
  ]);
  if (!responseKeys.every((key) => allowedResponseKeys.has(key))
    || typeof root.narrative !== "string" || !Array.isArray(root.events)
    || !Object.prototype.hasOwnProperty.call(root, "state")
    || !Object.prototype.hasOwnProperty.call(root, "summary")) {
    throw new Error("ordinary persisted action response schema is invalid");
  }
  if (root.sessionKind !== "ordinary" || root.ordinaryGeneration !== generation) {
    throw new Error("ordinary persisted action response generation binding is invalid");
  }
  const summary = outerDataRecord(root.summary, "ordinary persisted action response summary");
  if (summary.id !== sessionId) throw new Error("ordinary persisted action response summary identity is invalid");
  const state = outerDataRecord(root.state, "ordinary persisted action response state");
  validateOrdinaryResponseDisplaySchema(root);
  const player = outerDataRecord(state.player, "ordinary persisted action response player");
  const hasPlayerLuck = Object.prototype.hasOwnProperty.call(player, "luck");
  // The current envelope snapshot co-signs only its terminal receipt. Older
  // bounded text receipts are exact-bound to their immutable archive records
  // by the replay audit, and may legitimately name a previously active PC.
  if (terminal && "party" in projection) {
    const operationProjection = projection as OrdinaryOperationSnapshotProjection;
    const active = operationProjection.party.find((member) => member.pcId === operationProjection.activePlayerId);
    if (!active || (active.luck === null ? hasPlayerLuck : !hasPlayerLuck || player.luck !== active.luck)) {
      throw new Error("ordinary persisted action Luck does not match its snapshot");
    }
  } else if (legacyHotReceiptLuckAuthority !== undefined && hasPlayerLuck
    && player.luck !== legacyHotReceiptLuckAuthority) {
    // Historical archives have no room for a party authority and must retain
    // their original response bytes.  A hot 1.4 receipt is instead checked
    // against the snapshot co-signed by its envelope before it becomes such
    // an archive, so a re-hashed envelope cannot invent a different Luck.
    throw new Error("ordinary persisted legacy action Luck does not match its snapshot");
  }
  let responseTerminal: OrdinarySessionTerminal | undefined;
  if (Object.prototype.hasOwnProperty.call(root, "terminal")) {
    try { responseTerminal = validateOrdinarySessionTerminal(root.terminal, "ordinary persisted action terminal"); }
    catch (error) { throw new Error(`ordinary persisted action terminal is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (expectedTerminal !== undefined) {
    if (responseTerminal === undefined || canonicalJson(responseTerminal) !== canonicalJson(expectedTerminal)) {
      throw new Error("ordinary persisted action terminal does not match its snapshot");
    }
  }
  // Gameplay rounds and durable generations are independent counters (some
  // valid actions can advance one without the other). Only the ledger's final
  // receipt is a projection of the envelope snapshot.
  if (!validGeneration(state.round) || (terminal && state.round !== projection.round)) {
    throw new Error("ordinary persisted action response state does not match its snapshot");
  }
  if (terminal) {
    // The terminal receipt is not merely syntactically JSON: it is a
    // checkable projection of the exact snapshot committed beside it. This
    // rejects a re-hashed envelope that forges the user-visible HP, scene,
    // narration, or summary while preserving a valid inner snapshot.
    if (root.narrative !== projection.narrative) {
      throw new Error("ordinary persisted action response narrative does not match its snapshot");
    }
    if (root.dead !== projection.dead) throw new Error("ordinary persisted action death state does not match its snapshot");
    const responseSanity = outerDataRecord(root.sanity, "ordinary persisted action terminal sanity");
    if (responseSanity.currentSAN !== projection.sanity.currentSAN || responseSanity.maxSAN !== projection.sanity.maxSAN
      || responseSanity.temporaryInsanity !== projection.sanity.temporaryInsanity || responseSanity.indefiniteInsanity !== projection.sanity.indefiniteInsanity
      || canonicalJson(responseSanity.phobias) !== canonicalJson(projection.sanity.phobias)
      || (responseSanity.manias !== undefined && canonicalJson(responseSanity.manias) !== canonicalJson(projection.sanity.manias))) {
      throw new Error("ordinary persisted action sanity does not match its snapshot");
    }
    if (state.scene !== projection.scene) throw new Error("ordinary persisted action response scene does not match its snapshot");
    const player = outerDataRecord(state.player, "ordinary persisted action response player");
    if (player.name !== projection.player.name || player.hp !== projection.player.hp || player.maxHp !== projection.player.maxHp || player.ac !== projection.player.ac) {
      throw new Error("ordinary persisted action response player does not match its snapshot");
    }
    const gameTime = outerDataRecord(state.gameTime, "ordinary persisted action response game time");
    if (gameTime.day !== projection.gameTime.day || gameTime.period !== projection.gameTime.period) {
      throw new Error("ordinary persisted action response game time does not match its snapshot");
    }
    if (!exactKeys(summary, ["id", "round", "ruleset", "scene", "playerName", "archetype", "messageCount", "npcCount", "createdAt"])
      || canonicalJson(summary) !== canonicalJson(projection.summary)) {
      throw new Error("ordinary persisted action response summary does not match its snapshot");
    }
  }
  return response;
}

/** The structured-operation receipt has its own closed wire schema. */
function validateOrdinaryPartyMemberCreateResponse(
  value: unknown,
  sessionId: string,
  generation: number,
  projection: OrdinaryReceiptSnapshotProjection,
  operation: OrdinaryPartyMemberCreateOperation,
  current: boolean,
): OrdinarySnapshotJson {
  const response = strictJson(value);
  const root = outerDataRecord(response, "ordinary persisted party response");
  if (!exactOptionalKeys(root, ["pcId", "name", "archetype", "meta", "summary", "sessionKind", "ordinaryGeneration"], ["warning"])
    || !validId(root.pcId) || root.name !== operation.name || root.archetype !== operation.archetype
    || root.sessionKind !== "ordinary" || root.ordinaryGeneration !== generation) {
    throw new Error("ordinary persisted party response schema is invalid");
  }
  boundedText(root.name, "ordinary persisted party member name", 128);
  boundedText(root.archetype, "ordinary persisted party member archetype", 128);
  if (root.warning !== undefined) boundedText(root.warning, "ordinary persisted party warning", 2_000);
  const meta = outerDataRecord(root.meta, "ordinary persisted party meta");
  if (!exactOptionalKeys(meta, [], ["personality", "backstory", "currentGoal"])) throw new Error("ordinary persisted party meta schema is invalid");
  for (const [key, item] of Object.entries(meta)) boundedText(item, `ordinary persisted party meta ${key}`, 4_000);
  if (!("party" in projection)) throw new Error("ordinary persisted party response lacks a 1.5 snapshot projection");
  const projectedMember = projection.party.find((member) => member.pcId === root.pcId);
  // Historical hot receipts remain closed and operation-bound, then are
  // exact-bound to their immutable archive record by the replay audit. They
  // are not projections of this later successor snapshot; only the latest
  // receipt is co-signed by it.
  if (current && (!projectedMember || projectedMember.name !== root.name || projectedMember.archetype !== root.archetype
    || canonicalJson(projectedMember.meta) !== canonicalJson(meta))) {
    throw new Error("ordinary persisted party response member does not match its snapshot");
  }
  for (const key of ["personality", "backstory", "currentGoal"] as const) {
    if (operation.meta[key] !== undefined && meta[key] !== operation.meta[key]) {
      throw new Error("ordinary persisted party response supplied meta does not match operation");
    }
  }
  const summary = outerDataRecord(root.summary, "ordinary persisted party response summary");
  if (!exactKeys(summary, ["id", "round", "ruleset", "scene", "playerName", "archetype", "messageCount", "npcCount", "createdAt"])
    || summary.id !== sessionId
    || current && canonicalJson(summary) !== canonicalJson(projection.summary)) {
    throw new Error("ordinary persisted party response summary does not match its snapshot");
  }
  return response;
}

/** Luck receipts bind the active authority and the before/after arithmetic to the committed snapshot. */
function validateOrdinaryLuckSpendResponse(
  value: unknown,
  sessionId: string,
  generation: number,
  projection: OrdinaryReceiptSnapshotProjection,
  operation: OrdinaryLuckSpendOperation,
  current: boolean,
): OrdinarySnapshotJson {
  const response = strictJson(value);
  const root = outerDataRecord(response, "ordinary persisted luck response");
  if (!exactKeys(root, ["pcId", "amount", "previousLuck", "luck", "summary", "sessionKind", "ordinaryGeneration"])
    || !validId(root.pcId) || root.sessionKind !== "ordinary" || root.ordinaryGeneration !== generation) {
    throw new Error("ordinary persisted luck response schema is invalid");
  }
  const amount = boundedInteger(root.amount, "ordinary persisted luck amount", 1, 99);
  const previousLuck = boundedInteger(root.previousLuck, "ordinary persisted previous luck", 0, 99);
  const luck = boundedInteger(root.luck, "ordinary persisted luck", 0, 99);
  if (amount !== operation.amount || previousLuck - amount !== luck) {
    throw new Error("ordinary persisted luck response arithmetic is invalid");
  }
  if (current) {
    if (!("party" in projection) || root.pcId !== projection.activePlayerId) {
      throw new Error("ordinary persisted luck response active authority is invalid");
    }
    const active = projection.party.find((member) => member.pcId === root.pcId);
    if (!active || active.luck === null || active.luck !== luck) {
      throw new Error("ordinary persisted luck response does not match its snapshot");
    }
  }
  const summary = outerDataRecord(root.summary, "ordinary persisted luck response summary");
  if (!exactKeys(summary, ["id", "round", "ruleset", "scene", "playerName", "archetype", "messageCount", "npcCount", "createdAt"])
    || summary.id !== sessionId || current && canonicalJson(summary) !== canonicalJson(projection.summary)) {
    throw new Error("ordinary persisted luck response summary does not match its snapshot");
  }
  return response;
}

/** Character receipts name only the active snapshot subject and are verified
 * against the signed successor's complete character/world projection. */
function validateOrdinaryCharacterPatchResponse(
  value: unknown,
  sessionId: string,
  generation: number,
  projection: OrdinaryReceiptSnapshotProjection,
  operation: OrdinaryCharacterPatchOperation,
  current: boolean,
): OrdinarySnapshotJson {
  const response = strictJson(value);
  const root = outerDataRecord(response, "ordinary persisted character response");
  if (!exactKeys(root, ["pcId", "character", "inventory", "weapons", "summary", "sessionKind", "ordinaryGeneration"])
    || !validId(root.pcId) || root.sessionKind !== "ordinary" || root.ordinaryGeneration !== generation
    || !("characterPatch" in projection)) {
    throw new Error("ordinary persisted character response schema is invalid");
  }
  const expected = projection.characterPatch;
  if (current && (!expected || root.pcId !== projection.activePlayerId || root.pcId !== expected.pcId
    || canonicalJson(root.character) !== canonicalJson(expected.character)
    || canonicalJson(root.inventory) !== canonicalJson(expected.inventory)
    || canonicalJson(root.weapons) !== canonicalJson(expected.weapons))) {
    throw new Error("ordinary persisted character response does not match its snapshot");
  }
  const summary = outerDataRecord(root.summary, "ordinary persisted character response summary");
  if (!exactKeys(summary, ["id", "round", "ruleset", "scene", "playerName", "archetype", "messageCount", "npcCount", "createdAt"])
    || summary.id !== sessionId || current && canonicalJson(summary) !== canonicalJson(projection.summary)) {
    throw new Error("ordinary persisted character response summary does not match its snapshot");
  }
  // `operation` is intentionally consumed by this validator to keep a single
  // discriminated receipt contract even for an empty/no-op patch.
  if (Object.keys(operation.patch).length === 0) throw new Error("ordinary persisted character operation is empty");
  return response;
}

/** A host announcement response is co-signed by the exact public delivery
 * written into the successor snapshot, including its canonical timestamp. */
function validateOrdinaryKpMessageResponse(
  value: unknown,
  sessionId: string,
  generation: number,
  projection: OrdinaryReceiptSnapshotProjection,
  operation: OrdinaryKpMessageOperation,
  current: boolean,
): OrdinarySnapshotJson {
  const response = strictJson(value);
  const root = outerDataRecord(response, "ordinary persisted KP message response");
  if (!exactKeys(root, ["message", "summary", "sessionKind", "ordinaryGeneration"])
    || root.sessionKind !== "ordinary" || root.ordinaryGeneration !== generation || !("kpMessage" in projection)) {
    throw new Error("ordinary persisted KP message response schema is invalid");
  }
  const message = outerDataRecord(root.message, "ordinary persisted KP message response message");
  if (!exactKeys(message, ["speaker", "content", "type", "timestamp"])
    || message.speaker !== operation.speaker || message.content !== operation.content || message.type !== operation.type
    || current && canonicalJson(message) !== canonicalJson(projection.kpMessage)) {
    throw new Error("ordinary persisted KP message response does not match its snapshot");
  }
  const summary = outerDataRecord(root.summary, "ordinary persisted KP message response summary");
  if (!exactKeys(summary, ["id", "round", "ruleset", "scene", "playerName", "archetype", "messageCount", "npcCount", "createdAt"])
    || summary.id !== sessionId || current && canonicalJson(summary) !== canonicalJson(projection.summary)) {
    throw new Error("ordinary persisted KP message response summary does not match its snapshot");
  }
  return response;
}

function normalizeOrdinaryOperation(value: unknown, label: string): OrdinaryDurableOperation {
  const operation = outerDataRecord(value, label);
  if (operation.kind === "text_action") {
    if (!exactKeys(operation, ["kind", "input", "pcId"]) || typeof operation.input !== "string"
      || !operation.input.trim() || Array.from(operation.input).length > 1000
      || !(operation.pcId === null || validId(operation.pcId))) throw new Error(`${label} is invalid`);
    return { kind: "text_action", input: operation.input, pcId: operation.pcId };
  }
  if (operation.kind === "party_member_create") {
    if (!exactKeys(operation, ["kind", "name", "archetype", "meta"])
      || typeof operation.name !== "string" || operation.name.trim() !== operation.name || !operation.name || Array.from(operation.name).length > 128
      || typeof operation.archetype !== "string" || operation.archetype.trim() !== operation.archetype || !operation.archetype || Array.from(operation.archetype).length > 128) {
      throw new Error(`${label} is invalid`);
    }
    const meta = outerDataRecord(operation.meta, `${label}.meta`);
    if (!exactOptionalKeys(meta, [], ["personality", "backstory", "currentGoal"])) throw new Error(`${label}.meta is invalid`);
    const normalizedMeta: OrdinaryPartyMemberCreateOperation["meta"] = {};
    for (const key of ["personality", "backstory", "currentGoal"] as const) {
      const item = meta[key];
      if (item !== undefined) {
        if (typeof item !== "string" || item.trim() !== item || !item || Array.from(item).length > 4_000) throw new Error(`${label}.meta is invalid`);
        normalizedMeta[key] = item;
      }
    }
    return { kind: "party_member_create", name: operation.name, archetype: operation.archetype, meta: normalizedMeta };
  }
  if (operation.kind === "luck_spend") {
    if (!exactKeys(operation, ["kind", "amount"]) || typeof operation.amount !== "number" || !Number.isSafeInteger(operation.amount) || operation.amount <= 0) {
      throw new Error(`${label} is invalid`);
    }
    return { kind: "luck_spend", amount: operation.amount };
  }
  if (operation.kind === "character_patch") {
    if (!exactKeys(operation, ["kind", "patch"])) throw new Error(`${label} is invalid`);
    const patch = outerDataRecord(operation.patch, `${label}.patch`);
    const allowed = ["hp", "maxHp", "skills", "inventory", "weapons", "luck", "creditRating", "attributes"];
    if (Object.keys(patch).length === 0 || !Object.keys(patch).every((key) => allowed.includes(key))) throw new Error(`${label}.patch is invalid`);
    const result: OrdinaryCharacterPatchOperation["patch"] = {};
    for (const key of ["hp", "maxHp", "luck", "creditRating"] as const) {
      if (Object.hasOwn(patch, key)) {
        const [minimum, maximum] = key === "hp" ? [0, 999]
          : key === "maxHp" ? [1, 999]
          : [0, 99];
        if (typeof patch[key] !== "number" || !Number.isSafeInteger(patch[key])
          || patch[key]! < minimum || patch[key]! > maximum) throw new Error(`${label}.patch is invalid`);
        result[key] = patch[key] as number;
      }
    }
    if (result.hp !== undefined && result.maxHp !== undefined && result.hp > result.maxHp) throw new Error(`${label}.patch is invalid`);
    for (const key of ["skills", "attributes"] as const) {
      if (Object.hasOwn(patch, key)) {
        const values = outerDataRecord(patch[key], `${label}.patch.${key}`);
        if (Object.keys(values).length > 256) throw new Error(`${label}.patch.${key} is invalid`);
        const normalized: Record<string, number> = {};
        for (const [name, score] of Object.entries(values)) {
          const allowedNames = key === "skills" ? ORDINARY_CHARACTER_SKILL_KEYS : ORDINARY_CHARACTER_ATTRIBUTE_KEYS;
          const minimum = key === "skills" ? 0 : 1;
          if (!name || ORDINARY_RESERVED_RECORD_KEYS.has(name) || Array.from(name).length > 128
            || !allowedNames.has(name) || typeof score !== "number" || !Number.isSafeInteger(score)
            || score < minimum || score > 100) throw new Error(`${label}.patch.${key} is invalid`);
          Object.defineProperty(normalized, name, { value: score, enumerable: true, configurable: true, writable: true });
        }
        result[key] = normalized;
      }
    }
    for (const key of ["inventory", "weapons"] as const) {
      if (Object.hasOwn(patch, key)) result[key] = boundedStringArray(strictJson(patch[key]), `${label}.patch.${key}`, 4096, 512);
    }
    if (Object.keys(result).length === 0) throw new Error(`${label}.patch is invalid`);
    return { kind: "character_patch", patch: result };
  }
  if (operation.kind === "kp_message") {
    if (!exactKeys(operation, ["kind", "speaker", "content", "type"])
      || typeof operation.speaker !== "string" || operation.speaker.trim() !== operation.speaker || !operation.speaker || Array.from(operation.speaker).length > 128
      || typeof operation.content !== "string" || operation.content.trim() !== operation.content || !operation.content || Array.from(operation.content).length > 8_000
      || (operation.type !== "system" && operation.type !== "narration")) {
      throw new Error(`${label} is invalid`);
    }
    return { kind: "kp_message", speaker: operation.speaker, content: operation.content, type: operation.type };
  }
  throw new Error(`${label} is invalid`);
}

function normalizeOrdinaryActionRecord(
  rawEntry: unknown,
  sessionId: string,
  projection: OrdinaryReceiptSnapshotProjection,
  terminal: boolean,
  label: string,
  expectedTerminal?: OrdinarySessionTerminal,
  schemaVersion: OrdinaryEnvelopeSchemaVersion = ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  legacyHotReceiptLuckAuthority?: number | null,
): OrdinaryPersistedOperationRecord {
  const entry = outerDataRecord(rawEntry, label);
  const hasOperation = Object.hasOwn(entry, "operation");
  const expectedKeys = hasOperation
    ? ["actionId", "requestHash", "input", "pcId", "operation", "expectedGeneration", "generation", "status", "response"]
    : ["actionId", "requestHash", "input", "pcId", "expectedGeneration", "generation", "status", "response"];
  if (!exactKeys(entry, expectedKeys)
    || (schemaVersion === LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION && hasOperation)
    || (schemaVersion === ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION && !hasOperation)
    || !validActionId(entry.actionId) || !validHash(entry.requestHash) || typeof entry.input !== "string" || Array.from(entry.input).length > 1000
    || !(entry.pcId === null || validId(entry.pcId)) || !validGeneration(entry.expectedGeneration) || !validGeneration(entry.generation)
    || !(entry.status === 200 || entry.status === 201)
    || entry.generation !== entry.expectedGeneration + 1) {
    throw new Error(`${label} is invalid`);
  }
  const operation = hasOperation ? normalizeOrdinaryOperation(entry.operation, `${label}.operation`) : undefined;
  if ((operation?.kind === "character_patch") !== ("characterPatch" in projection)
    || (operation?.kind === "kp_message") !== ("kpMessage" in projection)) {
    throw new Error(`${label} projection does not match its operation`);
  }
  const requestHash = operation && operation.kind !== "text_action"
    ? ordinaryOperationRequestHash(sessionId, entry.actionId, operation, entry.expectedGeneration)
    : ordinaryActionRequestHash(sessionId, entry.actionId, entry.input, entry.pcId, entry.expectedGeneration);
  if (requestHash !== entry.requestHash
    || (operation?.kind === "text_action" && (operation.input !== entry.input || operation.pcId !== entry.pcId))
    || (operation?.kind === "party_member_create" && (entry.input !== "" || entry.pcId !== null || entry.status !== 201))
    || (operation?.kind === "luck_spend" && (entry.input !== "" || entry.pcId !== null || entry.status !== 200))
    || (operation?.kind === "character_patch" && (entry.input !== "" || entry.pcId !== null || entry.status !== 200))
    || (operation?.kind === "kp_message" && (entry.input !== "" || entry.pcId !== null || entry.status !== 200))
    || (operation?.kind !== "party_member_create" && operation?.kind !== "luck_spend" && operation?.kind !== "character_patch" && operation?.kind !== "kp_message" && entry.status !== 200)) {
    throw new Error(`${label} is invalid`);
  }
  return {
    ...structuredClone(entry),
    ...(operation ? { operation } : {}),
    response: operation?.kind === "party_member_create"
      ? validateOrdinaryPartyMemberCreateResponse(entry.response, sessionId, entry.generation, projection, operation, terminal)
      : operation?.kind === "luck_spend"
      ? validateOrdinaryLuckSpendResponse(entry.response, sessionId, entry.generation, projection, operation, terminal)
    : operation?.kind === "character_patch"
      ? validateOrdinaryCharacterPatchResponse(entry.response, sessionId, entry.generation, projection, operation, terminal)
    : operation?.kind === "kp_message"
      ? validateOrdinaryKpMessageResponse(entry.response, sessionId, entry.generation, projection, operation, terminal)
        : validateOrdinaryActionResponse(entry.response, sessionId, entry.generation, projection, terminal, expectedTerminal, legacyHotReceiptLuckAuthority),
  } as unknown as OrdinaryPersistedOperationRecord;
}

function archiveUnsigned(value: Omit<OrdinaryArchivedActionReceipt, "archiveHash">): Omit<OrdinaryArchivedActionReceipt, "archiveHash"> {
  return {
    kind: "ordinary-action-receipt",
    schemaVersion: value.schemaVersion,
    sessionId: value.sessionId,
    previousArchiveHash: value.previousArchiveHash,
    record: structuredClone(value.record),
    projection: structuredClone(value.projection),
  };
}

export function ordinaryActionArchiveHash(value: Omit<OrdinaryArchivedActionReceipt, "archiveHash">): string {
  return hash("ordinary-action-receipt-v1", archiveUnsigned(value));
}

export function createOrdinaryArchivedActionReceipt(value: Omit<OrdinaryArchivedActionReceipt, "archiveHash">): OrdinaryArchivedActionReceipt {
  const unsigned = archiveUnsigned(value);
  return validateOrdinaryArchivedActionReceipt({ ...unsigned, archiveHash: ordinaryActionArchiveHash(unsigned) });
}

export function validateOrdinaryArchivedActionReceipt(value: unknown): OrdinaryArchivedActionReceipt {
  const raw = outerDataRecord(value, "ordinary action archive receipt");
  if (!exactKeys(raw, ["kind", "schemaVersion", "sessionId", "previousArchiveHash", "record", "projection", "archiveHash"])
    || raw.kind !== "ordinary-action-receipt" || ![ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION].includes(raw.schemaVersion as string)
    || !validId(raw.sessionId) || !(raw.previousArchiveHash === null || validHash(raw.previousArchiveHash)) || !validHash(raw.archiveHash)) {
    throw new Error("ordinary action archive receipt shape is invalid");
  }
  const schemaVersion = raw.schemaVersion as OrdinaryEnvelopeSchemaVersion;
  const projection = validateOrdinaryActionSnapshotProjection(raw.projection, raw.sessionId, schemaVersion);
  const record = normalizeOrdinaryActionRecord(raw.record, raw.sessionId, projection, true, "ordinary action archive receipt record", undefined, schemaVersion);
  const unsigned = archiveUnsigned({
    kind: "ordinary-action-receipt",
    schemaVersion: raw.schemaVersion as OrdinaryEnvelopeSchemaVersion,
    sessionId: raw.sessionId,
    previousArchiveHash: raw.previousArchiveHash,
    record,
    projection,
  });
  if (ordinaryActionArchiveHash(unsigned) !== raw.archiveHash) throw new Error("ordinary action archive receipt hash is invalid");
  return { ...unsigned, archiveHash: raw.archiveHash };
}

/** Derive the next immutable archive head before the enclosing pointer is published. */
export function nextOrdinarySessionArchive(
    sessionId: string,
    previous: OrdinarySessionArchiveState,
    record: OrdinaryPersistedOperationRecord,
    snapshot: OrdinaryGameSessionSnapshotWire,
    schemaVersion: OrdinaryEnvelopeSchemaVersion = ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  ): OrdinarySessionArchiveState {
  if (!validId(sessionId) || !validGeneration(previous.count) || !(previous.headHash === null || validHash(previous.headHash))
    || !(previous.previousHeadHash === null || validHash(previous.previousHeadHash))
    || record.expectedGeneration !== previous.count || record.generation !== previous.count + 1) {
    throw new Error("ordinary action archive predecessor is invalid");
  }
    // An existing 1.4 chain must remain reproducible byte-for-byte while it
    // is being read or repaired. New normal successors omit this parameter
    // and therefore publish the 1.5 discriminated receipt shape.
    const canonicalRecord = schemaVersion === LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION
      ? record
      : canonicalCurrentRecord(record);
    const receipt = createOrdinaryArchivedActionReceipt({
      kind: "ordinary-action-receipt",
      schemaVersion,
      sessionId,
      previousArchiveHash: previous.headHash,
      record: canonicalRecord,
      projection: ordinaryOperationSnapshotProjection(snapshot, schemaVersion, canonicalRecord.operation),
  });
  return { count: previous.count + 1, headHash: receipt.archiveHash, previousHeadHash: previous.headHash };
}

interface OrdinaryReplayDirectoryNode {
  kind: "ordinary-action-replay-directory-node";
  schemaVersion: OrdinaryEnvelopeSchemaVersion;
  sessionId: string;
  actionId: string;
  index: number;
  archiveHash: string;
  height: number;
  leftHash: string | null;
  rightHash: string | null;
  nodeHash: string;
}
function replayDirectoryUnsigned(value: Omit<OrdinaryReplayDirectoryNode, "nodeHash">): Omit<OrdinaryReplayDirectoryNode, "nodeHash"> {
  return { kind: "ordinary-action-replay-directory-node", schemaVersion: value.schemaVersion, sessionId: value.sessionId, actionId: value.actionId, index: value.index, archiveHash: value.archiveHash, height: value.height, leftHash: value.leftHash, rightHash: value.rightHash };
}
function replayDirectoryNodeHash(value: Omit<OrdinaryReplayDirectoryNode, "nodeHash">): string { return hash("ordinary-action-replay-directory-node-v1", replayDirectoryUnsigned(value)); }
function createReplayDirectoryNode(sessionId: string, actionId: string, index: number, archiveHash: string, height: number, leftHash: string | null, rightHash: string | null): OrdinaryReplayDirectoryNode {
  const unsigned = replayDirectoryUnsigned({ kind: "ordinary-action-replay-directory-node", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId, actionId, index, archiveHash, height, leftHash, rightHash });
  return { ...unsigned, nodeHash: replayDirectoryNodeHash(unsigned) };
}
function deriveReplayDirectoryAppend(
  sessionId: string,
  previous: OrdinarySessionReplayDirectoryState,
  actionId: string,
  index: number,
  archiveHash: string,
  readNode: (hash: string) => OrdinaryReplayDirectoryNode,
): { state: OrdinarySessionReplayDirectoryState; nodes: OrdinaryReplayDirectoryNode[]; superseded: string[] } {
  if (!validId(sessionId) || !validGeneration(previous.count) || previous.count !== index || !(previous.rootHash === null || validHash(previous.rootHash)) || !validActionId(actionId) || !validHash(archiveHash)) {
    throw new Error("ordinary replay directory predecessor is invalid");
  }
  const nodes: OrdinaryReplayDirectoryNode[] = []; const superseded = new Set<string>(); const created = new Map<string, OrdinaryReplayDirectoryNode>();
  const load = (nodeHash: string): OrdinaryReplayDirectoryNode => created.get(nodeHash) ?? readNode(nodeHash);
  const nodeHeight = (nodeHash: string | null): number => nodeHash === null ? 0 : load(nodeHash).height;
  const make = (entry: Pick<OrdinaryReplayDirectoryNode, "actionId" | "index" | "archiveHash">, leftHash: string | null, rightHash: string | null) => {
    const height = Math.max(nodeHeight(leftHash), nodeHeight(rightHash)) + 1;
    if (height > 64) throw new Error("ordinary replay directory height exceeds its bound");
    const node = createReplayDirectoryNode(sessionId, entry.actionId, entry.index, entry.archiveHash, height, leftHash, rightHash); nodes.push(node); created.set(node.nodeHash, node); return node;
  };
  const balance = (root: OrdinaryReplayDirectoryNode): OrdinaryReplayDirectoryNode => {
    const leftHeight = nodeHeight(root.leftHash); const rightHeight = nodeHeight(root.rightHash);
    if (leftHeight - rightHeight > 1) {
      if (root.leftHash === null) throw new Error("ordinary replay directory left balance is invalid");
      let left = load(root.leftHash);
      if (nodeHeight(left.leftHash) < nodeHeight(left.rightHash)) {
        if (left.rightHash === null) throw new Error("ordinary replay directory left rotation is invalid");
        const pivot = load(left.rightHash);
        const rotatedLeft = make(left, left.leftHash, pivot.leftHash);
        left = make(pivot, rotatedLeft.nodeHash, pivot.rightHash);
      }
      const rebuiltRight = make(root, left.rightHash, root.rightHash);
      return make(left, left.leftHash, rebuiltRight.nodeHash);
    }
    if (rightHeight - leftHeight > 1) {
      if (root.rightHash === null) throw new Error("ordinary replay directory right balance is invalid");
      let right = load(root.rightHash);
      if (nodeHeight(right.rightHash) < nodeHeight(right.leftHash)) {
        if (right.leftHash === null) throw new Error("ordinary replay directory right rotation is invalid");
        const pivot = load(right.leftHash);
        const rotatedRight = make(right, pivot.rightHash, right.rightHash);
        right = make(pivot, pivot.leftHash, rotatedRight.nodeHash);
      }
      const rebuiltLeft = make(root, root.leftHash, right.leftHash);
      return make(right, rebuiltLeft.nodeHash, right.rightHash);
    }
    return root;
  };
  const insert = (rootHash: string | null, depth = 0): string => {
    if (depth > 64) throw new Error("ordinary replay directory depth exceeds its bound");
    if (rootHash === null) return make({ actionId, index, archiveHash }, null, null).nodeHash;
    const root = load(rootHash);
    if (root.actionId === actionId) throw new Error("ordinary replay directory action ID already exists");
    superseded.add(rootHash);
    if (actionId < root.actionId) {
      const left = insert(root.leftHash, depth + 1);
      return balance(make(root, left, root.rightHash)).nodeHash;
    }
    const right = insert(root.rightHash, depth + 1);
    return balance(make(root, root.leftHash, right)).nodeHash;
  };
  const rootHash = insert(previous.rootHash);
  // Rotations can create transient candidates which are never named by the
  // final root. Do not materialize them: only final-root-reachable immutable
  // nodes are publication artifacts.
  const reachable = new Set<string>();
  const visitCreated = (nodeHash: string | null): void => {
    if (nodeHash === null || reachable.has(nodeHash)) return;
    const node = created.get(nodeHash); if (!node) return;
    reachable.add(nodeHash); visitCreated(node.leftHash); visitCreated(node.rightHash);
  };
  visitCreated(rootHash);
  // A double rotation may reconstruct a leaf byte-for-byte: its hash can be
  // both on the predecessor search path and reachable from the successor
  // root. It is reusable authority, not a retirement candidate.
  return {
    state: { count: previous.count + 1, rootHash },
    nodes: nodes.filter((node) => reachable.has(node.nodeHash)),
    superseded: [...superseded].filter((nodeHash) => !reachable.has(nodeHash)),
  };
}
function hash(domain: string, value: unknown): string { return createHash("sha256").update(`${domain}|${canonicalJson(value)}`).digest("hex"); }

/** The request digest names its domain so it cannot be interchanged with a snapshot or owner hash. */
export function ordinaryActionRequestHash(sessionId: string, actionId: string, input: string, pcId: string | null, expectedGeneration: number): string {
  return hash("ordinary-action-request-v1", { sessionId, actionId, input, pcId, expectedGeneration });
}

/**
 * A typed structured operation has a separate request-hash domain from
 * historical text action records.  `kind` is inside the authenticated value,
 * so an actionId can never be replayed across operation classes.
 */
export function ordinaryOperationRequestHash(
  sessionId: string,
  actionId: string,
  operation: OrdinaryDurableOperation,
  expectedGeneration: number,
): string {
  return hash("ordinary-durable-operation-request-v1", { sessionId, actionId, operation, expectedGeneration });
}

/**
 * Programmatic fixture/build callers historically supplied a flat text
 * receipt to `nextOrdinarySessionArchive`/`createOrdinarySessionEnvelope`.
 * The public reader remains strict (a raw 1.5 flat receipt is refused), while
 * these trusted builders canonicalize that input before hashing it as 1.5.
 */
function canonicalCurrentRecord(record: OrdinaryPersistedOperationRecord): OrdinaryPersistedOperationRecord {
  if ("operation" in record && record.operation) return structuredClone(record);
  return {
    ...structuredClone(record),
    operation: { kind: "text_action", input: record.input, pcId: record.pcId },
  } as OrdinaryTextActionRecord;
}

export function ordinarySessionEnvelopeHash(value: Omit<OrdinarySessionEnvelope, "envelopeHash">): string {
  return hash(ORDINARY_SESSION_ENVELOPE_DOMAIN, value);
}

export function createOrdinarySessionEnvelope(value: Omit<OrdinarySessionEnvelope, "envelopeHash" | "archive" | "replayDirectory"> & { archive?: OrdinarySessionArchiveState; replayDirectory?: OrdinarySessionReplayDirectoryState }): OrdinarySessionEnvelope {
  // The existing ordinary snapshot validator owns its large module/state
  // budget. Only outer receipts get the smaller hostile-response budget.
  const normalized = outerDataRecord(value, "ordinary session envelope");
  if (Array.isArray(normalized.idempotency)) normalized.idempotency = normalized.idempotency.map((entry) => {
    const receipt = outerDataRecord(entry, "ordinary idempotency receipt");
    const withResponse = { ...receipt, response: strictJson(receipt.response) } as unknown as OrdinaryPersistedOperationRecord;
    return normalized.schemaVersion === ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION
      ? canonicalCurrentRecord(withResponse)
      : withResponse;
  });
  const withArchive = {
    ...normalized,
    archive: normalized.archive ?? { count: 0, headHash: null, previousHeadHash: null },
    replayDirectory: normalized.replayDirectory ?? { count: 0, rootHash: null },
  };
  return validateOrdinarySessionEnvelope({ ...withArchive, envelopeHash: hash(ORDINARY_SESSION_ENVELOPE_DOMAIN, withArchive) });
}

/** Hostile-input validation shared by storage reads and every publish attempt. */
export function validateOrdinarySessionEnvelope(value: unknown): OrdinarySessionEnvelope {
  const safeValue = outerDataRecord(value, "ordinary session envelope");
  if (!exactKeys(safeValue, ["kind", "schemaVersion", "sessionId", "generation", "previousEnvelopeHash", "access", "snapshot", "idempotency", "archive", "replayDirectory", "envelopeHash"])) {
    throw new Error("ordinary session envelope shape is invalid");
  }
  const envelope = safeValue;
  const rawLedger = envelope.idempotency;
  if (envelope.kind !== "ordinary-session-envelope" || ![ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION].includes(envelope.schemaVersion as string)
    || !validId(envelope.sessionId) || !validGeneration(envelope.generation)
    || !(envelope.previousEnvelopeHash === null || validHash(envelope.previousEnvelopeHash))
    || !isOrdinarySessionAccessBinding(envelope.access) || !validHash(envelope.envelopeHash)
    || !Array.isArray(rawLedger) || rawLedger.length > ORDINARY_SESSION_IDEMPOTENCY_LIMIT) {
    throw new Error("ordinary session envelope fields are invalid");
  }
  const archive = outerDataRecord(envelope.archive, "ordinary session archive state");
  if (!exactKeys(archive, ["count", "headHash", "previousHeadHash"]) || !validGeneration(archive.count)
    || !(archive.headHash === null || validHash(archive.headHash))
    || !(archive.previousHeadHash === null || validHash(archive.previousHeadHash))) {
    throw new Error("ordinary session archive state is invalid");
  }
  const replayDirectory = outerDataRecord(envelope.replayDirectory, "ordinary session replay directory state");
  if (!exactKeys(replayDirectory, ["count", "rootHash"]) || !validGeneration(replayDirectory.count)
    || !(replayDirectory.rootHash === null || validHash(replayDirectory.rootHash))) throw new Error("ordinary session replay directory state is invalid");
  // Keep the normalized original wire in this envelope. Calling the public
  // restore validator here would migrate/re-sign a nested legacy snapshot and
  // silently invalidate the immutable outer body that authenticated it.
  const snapshot = validateOrdinaryGameSessionSnapshotWire(envelope.snapshot);
  if (snapshot.session.id !== envelope.sessionId || !snapshot.session.access || !sameOrdinarySessionAccessBinding(snapshot.session.access, envelope.access)) {
    throw new Error("ordinary session envelope snapshot identity or owner binding is invalid");
  }
  const actionIds = new Set<string>();
  const hotStart = Math.max(0, (envelope.generation as number) - ORDINARY_SESSION_IDEMPOTENCY_LIMIT);
  const ledger: OrdinaryPersistedOperationRecord[] = rawLedger.map((rawEntry, index) => {
    // Keep the independently versioned 1.4 envelope/projection wire stable.
    // Its authenticated current hot receipt is instead cross-checked against
    // the co-signed current snapshot terminal; archived receipts retain their
    // existing hash-chain contract and original projection shape.
    const rawRecord = outerDataRecord(rawEntry, `ordinary idempotency record ${index}`);
    const operationForProjection = Object.hasOwn(rawRecord, "operation")
      ? normalizeOrdinaryOperation(rawRecord.operation, `ordinary idempotency record ${index}.operation`)
      : undefined;
    const isCurrentRecord = index === rawLedger.length - 1;
    // A previous KP announcement's authoritative delivery is in its immutable
    // archive receipt. The latest snapshot can legitimately have a different
    // final message, so do not counterfeit a current binding for it here.
    const projection = !isCurrentRecord && operationForProjection?.kind === "kp_message"
      ? {
        ...ordinaryOperationSnapshotProjection(snapshot, envelope.schemaVersion as OrdinaryEnvelopeSchemaVersion),
        kpMessage: kpMessageProjectionFromResponse(rawRecord.response, `ordinary idempotency record ${index}.response`),
      }
      : ordinaryOperationSnapshotProjection(snapshot, envelope.schemaVersion as OrdinaryEnvelopeSchemaVersion, operationForProjection);
    const entry = normalizeOrdinaryActionRecord(
      rawEntry,
      envelope.sessionId as string,
      projection,
      isCurrentRecord,
      `ordinary idempotency record ${index}`,
      isCurrentRecord && snapshot.schemaVersion === ORDINARY_GAME_SESSION_SNAPSHOT_VERSION
        ? snapshot.state.terminal
        : undefined,
      envelope.schemaVersion as OrdinaryEnvelopeSchemaVersion,
      envelope.schemaVersion === LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION && isCurrentRecord
        ? ordinaryLegacyHotReceiptLuckAuthority(snapshot)
        : undefined,
    );
    if (actionIds.has(entry.actionId)) throw new Error(`ordinary session idempotency record ${index} is invalid`);
    actionIds.add(entry.actionId);
    return entry;
  });
  if (ledger.length !== Math.min(envelope.generation as number, ORDINARY_SESSION_IDEMPOTENCY_LIMIT)
    || ledger.some((entry, index) => entry.expectedGeneration !== hotStart + index || entry.generation !== hotStart + index + 1)) {
    throw new Error("ordinary envelope ledger is not a bounded generation receipt window");
  }
  if (envelope.generation === 0 && (envelope.previousEnvelopeHash !== null || ledger.length !== 0 || archive.count !== 0 || archive.headHash !== null || archive.previousHeadHash !== null || replayDirectory.count !== 0 || replayDirectory.rootHash !== null)) throw new Error("ordinary generation zero envelope is invalid");
  if (envelope.generation > 0 && (envelope.previousEnvelopeHash === null || ledger.length === 0 || ledger.at(-1)!.generation !== envelope.generation
    || archive.count !== envelope.generation || archive.headHash === null
    || (envelope.generation === 1 ? archive.previousHeadHash !== null : archive.previousHeadHash === null)
    || replayDirectory.count !== envelope.generation || replayDirectory.rootHash === null)) {
    throw new Error("ordinary envelope successor does not contain its committed receipt");
  }
  const unsigned = {
    kind: "ordinary-session-envelope" as const,
    schemaVersion: envelope.schemaVersion as OrdinaryEnvelopeSchemaVersion,
    sessionId: envelope.sessionId,
    generation: envelope.generation,
    previousEnvelopeHash: envelope.previousEnvelopeHash,
    access: structuredClone(envelope.access),
    snapshot,
    idempotency: ledger,
    archive: {
      count: archive.count as number,
      headHash: archive.headHash as string | null,
      previousHeadHash: archive.previousHeadHash as string | null,
    },
    replayDirectory: { count: replayDirectory.count as number, rootHash: replayDirectory.rootHash as string | null },
  };
  // This comparison intentionally uses the original-schema nested wire. A
  // valid v1.4 envelope with a historical inner snapshot remains self-valid
  // through restart/replay; the subsequent action exports 1.2 complete Career
  // data and publishes a normal successor under the old predecessor hash.
  if (ordinarySessionEnvelopeHash(unsigned) !== envelope.envelopeHash) throw new Error("ordinary session envelope hash is invalid");
  return { ...unsigned, envelopeHash: envelope.envelopeHash };
}

function policyValue(value: number | undefined, env: string | undefined, fallback: number): number | undefined {
  const raw: unknown = value ?? env ?? fallback;
  const parsed = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function coordinatorCode(error: unknown): OrdinarySessionSnapshotRefusalCode {
  if (error instanceof SnapshotCoordinatorFailure) {
    if (error.code === "SNAPSHOT_BUSY") return "ORDINARY_SNAPSHOT_BUSY";
    if (error.code === "SNAPSHOT_QUOTA_EXCEEDED") return "ORDINARY_SNAPSHOT_QUOTA_EXCEEDED";
    if (error.code === "SNAPSHOT_POLICY_MISMATCH") return "ORDINARY_SNAPSHOT_POLICY_MISMATCH";
  }
  return "ORDINARY_SNAPSHOT_STORAGE_FAILED";
}

interface AuditedOrdinaryReplaySet {
  envelope: OrdinarySessionEnvelope;
  nodes: Map<string, OrdinaryReplayDirectoryNode>;
}

/** Immutable envelope bodies plus a CAS-protected current pointer. */
export class OrdinarySessionSnapshotStore {
  readonly root: string;
  private readonly ops: CompiledSessionSnapshotFileOps;
  private readonly policy: SnapshotCoordinatorPolicy | undefined;
  private readonly coordinatorFactory: (root: string, policy: SnapshotCoordinatorPolicy) => CompiledSessionSnapshotCoordinatorLike;
  private readonly maxAuditedReplaySets: number;
  private readonly testHooks: OrdinarySessionSnapshotStoreTestHooks | undefined;
  private readonly namespacePublicationGate: SessionNamespacePublicationGate | undefined;
  private readonly allowUncoordinatedTestWrites: boolean;
  /** A per-process audit checkpoint. It is never authority across a changed
   * pointer: unknown/jumped identities receive a complete audit, while an
   * exact successor is proven from its cached immutable predecessor path.
   * It holds one node per live replay entry; the same root policy bounds that
   * cardinality (default maxEntries is 4096, and each node is quota-counted). */
  private readonly auditedReplaySets = new Map<string, AuditedOrdinaryReplaySet>();

  constructor(options: OrdinarySessionSnapshotStoreOptions = {}) {
    this.root = resolve(options.root ?? process.env.ORDINARY_SESSION_ROOT ?? join("data", "ordinary-sessions"));
    this.ops = options.fileOps ?? compiledSessionSnapshotNodeFileOps;
    const maxEntries = policyValue(options.maxEntries, process.env.ORDINARY_SESSION_SNAPSHOT_MAX_ENTRIES, 4096);
    const maxBytes = policyValue(options.maxBytes, process.env.ORDINARY_SESSION_SNAPSHOT_MAX_BYTES, 512 * 1024 * 1024);
    this.policy = maxEntries === undefined || maxBytes === undefined ? undefined : { schemaVersion: ORDINARY_SESSION_COORDINATOR_POLICY_SCHEMA_VERSION, maxEntries, maxBytes };
    this.maxAuditedReplaySets = options.maxAuditedReplaySets === undefined ? 16
      : Number.isSafeInteger(options.maxAuditedReplaySets) && options.maxAuditedReplaySets >= 0 ? options.maxAuditedReplaySets : 0;
    this.testHooks = options.testHooks;
    this.namespacePublicationGate = options.namespacePublicationGate;
    this.allowUncoordinatedTestWrites = options.allowUncoordinatedTestWrites === true;
    this.coordinatorFactory = options.coordinatorFactory ?? ((root) => new CompiledSessionSnapshotCoordinator(root, ORDINARY_SESSION_COORDINATOR_POLICY_SCHEMA_VERSION, {
      domain: "ordinary-session-envelope-cas", fileName: ".ordinary-session-envelope-write.sqlite",
    }));
  }

  save(
    raw: unknown,
    publication?: SessionNamespaceStorePublication,
    gate: SessionNamespacePublicationGate | undefined = this.namespacePublicationGate,
  ): OrdinarySessionSnapshotWriteResult<OrdinarySessionEnvelopeHeader> {
    let value: OrdinarySessionEnvelope;
    try { value = validateOrdinarySessionEnvelope(raw); }
    catch (error) { return { status: "refused", code: "ORDINARY_SNAPSHOT_INCOMPATIBLE", message: error instanceof Error ? error.message : "ordinary envelope is invalid" }; }
    if (!this.policy) return this.refusal("ORDINARY_SNAPSHOT_STORAGE_FAILED", "ordinary snapshot quota configuration is invalid", value.sessionId);
    // This check deliberately precedes mkdir/open/write so a direct caller
    // cannot leave an unowned body, header, or control database behind.
    try {
      consumeSessionNamespacePublication(gate, publication, {
        kind: "ordinary", sessionId: value.sessionId, hash: value.envelopeHash,
        generation: value.generation, format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
      }, this.allowUncoordinatedTestWrites);
    } catch (error) {
      return this.refusal("ORDINARY_SNAPSHOT_NAMESPACE_FENCED", error instanceof Error ? error.message : "ordinary namespace publication permit is invalid", value.sessionId);
    }
    const body = `${canonicalJson(value)}\n`;
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    if (bodyBytes > ORDINARY_SESSION_SNAPSHOT_MAX_BYTES) return this.refusal("ORDINARY_SNAPSHOT_INCOMPATIBLE", "ordinary envelope body exceeds the storage limit", value.sessionId);
    const header: HeaderFile = { schemaVersion: value.schemaVersion, sessionId: value.sessionId, envelopeHash: value.envelopeHash, generation: value.generation, bodyBytes };
    const headerText = `${canonicalJson(header)}\n`;
    let coordinator: CompiledSessionSnapshotCoordinatorLike | undefined;
    let began = false;
    let pointerAttempted = false;
    let pointerSynced = false;
    let result: OrdinarySessionSnapshotWriteResult<OrdinarySessionEnvelopeHeader> = this.refusal("ORDINARY_SNAPSHOT_STORAGE_FAILED", "ordinary snapshot storage failed", value.sessionId);
    try {
      this.ops.mkdir(this.root); this.assertSafeRoot();
      coordinator = this.coordinatorFactory(this.root, this.policy);
      coordinator.initializePolicy(this.policy); coordinator.beginPublication(); began = true;
      // Full archive reconciliation deliberately runs only under this same
      // cross-process publication lock, and only under admission pressure.
      // Walking every historic receipt on every ordinary turn would turn a
      // long-running session into O(actions²) I/O; immediate predecessor-body
      // cleanup below and quota-triggered locked GC retain crash safety.
      const usage = this.loadUsageLocked();
      const current = this.readHeader(value.sessionId);
      if (current.status === "ok") {
        if (current.value.envelopeHash === value.envelopeHash && current.value.generation === value.generation) {
          result = this.durableReload(value, header, body);
        } else if (value.generation !== current.value.generation + 1 || value.previousEnvelopeHash !== current.value.envelopeHash) {
          result = this.refusal("ORDINARY_SNAPSHOT_CONFLICT", "ordinary envelope predecessor is not current", value.sessionId);
        } else {
          const predecessor = this.read(value.sessionId);
          if (predecessor.status !== "ok" || !sameOrdinarySessionAccessBinding(predecessor.value.access, value.access)
            || !this.isArchiveSuccessor(predecessor.value, value)) {
            result = this.refusal("ORDINARY_SNAPSHOT_CONFLICT", "ordinary envelope predecessor is unavailable or changes owner binding", value.sessionId);
          } else {
            result = this.publish(value, header, body, headerText, usage, predecessor.value);
          }
        }
      } else if (current.code === "ORDINARY_SNAPSHOT_NOT_FOUND") {
        if (this.isOccupied(value.sessionId)) result = this.refusal("ORDINARY_SNAPSHOT_CONFLICT", "ordinary session ID is occupied", value.sessionId);
        else if (value.generation !== 0 || value.previousEnvelopeHash !== null) result = this.refusal("ORDINARY_SNAPSHOT_CONFLICT", "ordinary sessions must begin at generation zero", value.sessionId);
        else result = this.publish(value, header, body, headerText, usage);
      } else result = this.refusal("ORDINARY_SNAPSHOT_CONFLICT", "ordinary session pointer is unavailable", value.sessionId);
      // publish marks a pointer write only after this point; it returns an indeterminate result for a post-write fault.
      pointerAttempted = result.status === "indeterminate";
      pointerSynced = result.status === "ok";
    } catch (error) {
      const message = error instanceof Error ? error.message : "ordinary snapshot storage failed";
      result = pointerAttempted || (began && pointerSynced === false && this.headerMayExist(value.sessionId))
        ? { status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE", message, sessionId: value.sessionId }
        : this.refusal(coordinatorCode(error), message, value.sessionId);
    } finally {
      if (coordinator) {
        const finish = coordinator.finishPublication();
        if ((finish.closeFailure || finish.rollbackFailure) && result.status === "ok") {
          result = { status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE", message: (finish.closeFailure ?? finish.rollbackFailure)!.message, sessionId: value.sessionId };
        }
      }
    }
    return result;
  }

  read(sessionId: string): OrdinarySessionSnapshotResult<OrdinarySessionEnvelope> {
    return this.readEnvelope(sessionId, "normal");
  }

  /** Startup/repair seam: always walks the complete archive and AVL tree. */
  audit(sessionId: string): OrdinarySessionSnapshotResult<OrdinarySessionEnvelope> {
    return this.readEnvelope(sessionId, "full");
  }

  /**
   * A fresh or discontinuous pointer receives a complete audit once. An
   * exact cached pointer is hash-checked at its body/root/head; a direct
   * successor is proven from the cached immutable predecessor using only its
   * replaced AVL path plus the terminal archive receipt. Replay lookup uses
   * the narrower mode and never returns an in-envelope receipt.
   */
  private readEnvelope(sessionId: string, mode: "normal" | "full" | "lookup"): OrdinarySessionSnapshotResult<OrdinarySessionEnvelope> {
    try {
      const rootKind = this.ops.kind(this.root);
      if (rootKind === "missing") return this.refusal("ORDINARY_SNAPSHOT_NOT_FOUND", "ordinary snapshot root has no session", sessionId);
      if (rootKind !== "directory") return this.refusal("ORDINARY_SNAPSHOT_STORAGE_FAILED", "ordinary snapshot root is not a real non-link directory", sessionId);
    } catch (error) { return this.refusal("ORDINARY_SNAPSHOT_STORAGE_FAILED", error instanceof Error ? error.message : "ordinary snapshot root is unavailable", sessionId); }
    for (let attempt = 0; attempt < 2; attempt++) {
      const header = this.readHeader(sessionId);
      if (header.status !== "ok") return header;
      const value = this.readForHeader(sessionId, header.value, mode);
      if (value.status === "ok") return value;
      // Publication deletes only predecessor artifacts after its successor
      // pointer is durable. A lock-free reader of that predecessor may race
      // the cleanup, but it must never report false corruption: retry exactly
      // once against the new identity. An unchanged pointer remains corrupt.
      const current = this.readHeader(sessionId);
      if (attempt === 0 && current.status === "ok" && (current.value.envelopeHash !== header.value.envelopeHash || current.value.generation !== header.value.generation)) continue;
      return value;
    }
    return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary envelope changed repeatedly while reading", sessionId);
  }

  private readForHeader(sessionId: string, header: OrdinarySessionEnvelopeHeader, mode: "normal" | "full" | "lookup"): OrdinarySessionSnapshotResult<OrdinarySessionEnvelope> {
    try {
      const path = this.bodyPath(sessionId, header.envelopeHash);
      if (this.ops.kind(path) !== "regular") return this.refusal("ORDINARY_SNAPSHOT_STORAGE_FAILED", "ordinary immutable envelope body is not a regular non-link file", sessionId);
      const raw = this.ops.read(path, ORDINARY_SESSION_SNAPSHOT_MAX_BYTES);
      if (new TextEncoder().encode(raw).byteLength !== header.bodyBytes) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary envelope body length does not match its pointer", sessionId);
      const value = validateOrdinarySessionEnvelope(JSON.parse(raw));
      if (value.sessionId !== sessionId || value.envelopeHash !== header.envelopeHash || value.generation !== header.generation) {
        return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary envelope body does not match its pointer", sessionId);
      }
      if (!this.verifyArchiveHead(value)) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary action archive head is unavailable or invalid", sessionId);
      if (!this.verifyReplayDirectoryRoot(value)) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary action replay directory is unavailable or invalid", sessionId);
      if (mode !== "lookup") {
        const cached = this.auditedReplaySets.get(sessionId);
        let nextAudit: AuditedOrdinaryReplaySet | undefined;
        if (mode === "normal" && cached?.envelope.envelopeHash === value.envelopeHash && cached.envelope.generation === value.generation) {
          // The envelope/body hash, terminal archive and directory root were
          // checked above. Full membership was proven at this same identity.
          nextAudit = cached;
        } else if (mode === "normal" && cached && this.isCachedReplaySuccessor(cached, value)) {
          nextAudit = this.extendCachedReplaySet(cached, value);
        } else nextAudit = this.auditReplaySet(value);
        if (!nextAudit) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary action replay set is unavailable or invalid", sessionId);
        this.cacheAuditedReplaySet(sessionId, nextAudit);
      }
      return { status: "ok", value };
    } catch (error) { return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", error instanceof Error ? error.message : "ordinary envelope body is unreadable", sessionId); }
  }

  private cacheAuditedReplaySet(sessionId: string, replaySet: AuditedOrdinaryReplaySet): void {
    if (this.maxAuditedReplaySets === 0) return;
    // Delete-before-set makes Map iteration order an LRU order even when an
    // existing session advances through a direct cached successor.
    this.auditedReplaySets.delete(sessionId);
    this.auditedReplaySets.set(sessionId, replaySet);
    while (this.auditedReplaySets.size > this.maxAuditedReplaySets) {
      const leastRecent = this.auditedReplaySets.keys().next().value as string | undefined;
      if (leastRecent === undefined) break;
      this.auditedReplaySets.delete(leastRecent);
    }
  }

  readHeader(sessionId: string): OrdinarySessionSnapshotResult<OrdinarySessionEnvelopeHeader> {
    if (!validId(sessionId)) return this.refusal("ORDINARY_SNAPSHOT_NOT_FOUND", "ordinary session ID is invalid", sessionId);
    const fileName = this.headerFileName(sessionId); const path = join(this.root, fileName);
    try {
      this.assertSafeRoot();
      if (this.ops.kind(path) === "missing") return this.refusal("ORDINARY_SNAPSHOT_NOT_FOUND", "ordinary envelope pointer was not found", sessionId);
      if (this.ops.kind(path) !== "regular") return this.refusal("ORDINARY_SNAPSHOT_STORAGE_FAILED", "ordinary envelope pointer is not a regular non-link file", sessionId);
      const value = JSON.parse(this.ops.read(path, 4096)) as unknown;
      if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "sessionId", "envelopeHash", "generation", "bodyBytes"])
        || ![ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION].includes(value.schemaVersion as string) || value.sessionId !== sessionId || !validHash(value.envelopeHash)
        || !validGeneration(value.generation) || !validGeneration(value.bodyBytes) || value.bodyBytes > ORDINARY_SESSION_SNAPSHOT_MAX_BYTES) {
        return this.refusal("ORDINARY_SNAPSHOT_INCOMPATIBLE", "ordinary envelope pointer is invalid", sessionId);
      }
      return { status: "ok", value: { fileName, ...value as unknown as HeaderFile } };
    } catch (error) { return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", error instanceof Error ? error.message : "ordinary envelope pointer is unreadable", sessionId); }
  }

  listHeaders(): Array<OrdinarySessionSnapshotResult<OrdinarySessionEnvelopeHeader>> {
    const kind = this.ops.kind(this.root);
    if (kind === "missing") return [];
    if (kind !== "directory") return [this.refusal("ORDINARY_SNAPSHOT_STORAGE_FAILED", "ordinary snapshot root is not a real non-link directory")];
    try { return this.ops.list(this.root).filter((name) => name.endsWith(".ordinary-current.json")).sort().map((name) => this.readHeader(name.slice(0, -".ordinary-current.json".length))); }
    catch (error) { return [this.refusal("ORDINARY_SNAPSHOT_STORAGE_FAILED", error instanceof Error ? error.message : "ordinary snapshot root is unreadable")]; }
  }

  /**
   * Startup-only locator inventory.  This intentionally includes orphaned
   * immutable envelope/archive/replay artifacts that have no current header;
   * they are durable collision evidence and must be quarantined by the shared
   * namespace rather than silently becoming allocatable IDs.
   */
  listOccupiedSessionIds(): string[] {
    const kind = this.ops.kind(this.root);
    if (kind === "missing") return [];
    if (kind !== "directory") throw new Error("ordinary snapshot root is not a real non-link directory");
    try {
      const ids = new Set<string>();
      for (const name of this.ops.list(this.root)) {
        const match = /^([A-Za-z0-9_-]{1,128})\.(?:ordinary-current\.json|[a-f0-9]{64}\.ordinary-(?:envelope|action-receipt|action-replay-directory-node)\.json)$/.exec(name);
        if (match) ids.add(match[1]!);
      }
      return [...ids].sort();
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "ordinary snapshot root is unreadable");
    }
  }

  isOccupied(sessionId: string): boolean {
    if (!validId(sessionId)) return false;
    const root = this.ops.kind(this.root); if (root === "missing") return false; if (root !== "directory") return true;
    try {
      return this.ops.list(this.root).some((name) => name === this.headerFileName(sessionId)
        || name.startsWith(`${sessionId}.`) && (name.endsWith(".ordinary-envelope.json") || name.endsWith(".ordinary-action-receipt.json") || name.endsWith(".ordinary-action-replay-directory-node.json")));
    }
    catch { return true; }
  }

  /** Build the authenticated directory root from immutable predecessor nodes.
   * Callers still have to pass the resulting root through `save()` CAS. */
  prepareOrdinaryReplayDirectory(
    sessionId: string,
    previous: OrdinarySessionReplayDirectoryState,
    record: OrdinaryPersistedOperationRecord,
    archiveHash: string,
  ): OrdinarySessionReplayDirectoryState {
    const derived = deriveReplayDirectoryAppend(sessionId, previous, record.actionId, previous.count, archiveHash, (nodeHash) => {
      const node = this.readReplayDirectoryNode(sessionId, nodeHash);
      if (node.status !== "ok") throw new Error(node.message);
      return node.value;
    });
    return derived.state;
  }

  /** Resolve a durable replay record through the pointer-bound directory.
   * There is deliberately no archive-chain fallback: a hostile unknown ID
   * must stay logarithmic, and all directory artifacts are durable before the
   * pointer that names their root. */
  findActionReceipt(sessionId: string, actionId: string): OrdinarySessionSnapshotResult<OrdinaryPersistedOperationRecord | null> {
    if (!validActionId(actionId)) return this.refusal("ORDINARY_SNAPSHOT_NOT_FOUND", "ordinary action ID is invalid", sessionId);
    for (let attempt = 0; attempt < 2; attempt++) {
      // Do not call the full authoritative read here. Its complete archive
      // audit is intentionally O(committed actions); this lookup reads only
      // the authenticated AVL search path. It also never trusts `hot`.
      const envelope = this.readEnvelope(sessionId, "lookup");
      if (envelope.status !== "ok") return envelope;
      const resolved = this.lookupReplayReceipt(envelope.value, actionId);
      if (resolved.status !== "refused" || attempt === 1) return resolved;
      const current = this.readHeader(sessionId);
      if (current.status !== "ok" || (current.value.envelopeHash === envelope.value.envelopeHash && current.value.generation === envelope.value.generation)) return resolved;
    }
    return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary replay pointer changed repeatedly while reading", sessionId);
  }

  private publish(value: OrdinarySessionEnvelope, header: HeaderFile, body: string, headerText: string, priorUsage: OrdinaryUsage, predecessor?: OrdinarySessionEnvelope): OrdinarySessionSnapshotWriteResult<OrdinarySessionEnvelopeHeader> {
    const bodyPath = this.bodyPath(value.sessionId, value.envelopeHash);
    const bodyKind = this.ops.kind(bodyPath);
    if (bodyKind !== "missing" && bodyKind !== "regular") throw new Error("ordinary immutable envelope path is unsafe");
    const archive = this.archiveReceiptForEnvelope(value);
    const archivePath = archive ? this.archivePath(value.sessionId, archive.archiveHash) : undefined;
    const archiveText = archive ? `${canonicalJson(archive)}\n` : undefined;
    const archiveKind = archivePath ? this.ops.kind(archivePath) : "regular";
    if (archiveKind !== "missing" && archiveKind !== "regular") throw new Error("ordinary action archive path is unsafe");
    const directory = predecessor && archive ? deriveReplayDirectoryAppend(
      value.sessionId,
      predecessor.replayDirectory,
      value.idempotency.at(-1)!.actionId,
      predecessor.replayDirectory.count,
      archive.archiveHash,
      (nodeHash) => {
        const node = this.readReplayDirectoryNode(value.sessionId, nodeHash);
        if (node.status !== "ok") throw new Error(node.message);
        return node.value;
      },
    ) : undefined;
    if (directory && canonicalJson(directory.state) !== canonicalJson(value.replayDirectory)) throw new Error("ordinary replay directory does not match terminal receipt");
    const replayArtifacts = directory ? [...new Map(directory.nodes.map((entry) => [this.replayDirectoryNodePath(value.sessionId, entry.nodeHash), {
      path: this.replayDirectoryNodePath(value.sessionId, entry.nodeHash), text: `${canonicalJson(entry)}\n`,
    }])).values()] : [];
    const replayKinds = replayArtifacts.map((artifact) => this.ops.kind(artifact.path));
    if (replayKinds.some((kind) => kind !== "missing" && kind !== "regular")) throw new Error("ordinary replay directory path is unsafe");
    const headerBytes = new TextEncoder().encode(headerText).byteLength;
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    const archiveBytes = archiveText ? new TextEncoder().encode(archiveText).byteLength : 0;
    const newReplayBytes = replayArtifacts.reduce((total, artifact, index) => total + (replayKinds[index] === "missing" ? new TextEncoder().encode(artifact.text).byteLength : 0), 0);
    const newReplayEntries = replayKinds.filter((kind) => kind === "missing").length;
    const oldHeaderKind = this.ops.kind(this.headerPath(value.sessionId));
    if (oldHeaderKind !== "missing" && oldHeaderKind !== "regular") throw new Error("ordinary envelope pointer path is unsafe");
    const oldHeaderBytes = oldHeaderKind === "regular" ? this.ops.size(this.headerPath(value.sessionId)) : 0;
    const additions: OrdinaryUsage = {
      entries: (bodyKind === "missing" ? 1 : 0) + (archiveKind === "missing" ? 1 : 0) + newReplayEntries + (oldHeaderKind === "missing" ? 1 : 0),
      bytes: (bodyKind === "missing" ? bodyBytes : 0) + (archiveKind === "missing" ? archiveBytes : 0) + newReplayBytes + headerBytes - oldHeaderBytes,
    };
    const atomicArtifactWrites: OrdinaryUsage[] = [
      ...(archiveKind === "missing" ? [{ entries: 1, bytes: archiveBytes }] : []),
      ...replayArtifacts.flatMap((artifact, index) => replayKinds[index] === "missing" ? [{ entries: 1, bytes: new TextEncoder().encode(artifact.text).byteLength }] : []),
      ...(bodyKind === "missing" ? [{ entries: 1, bytes: bodyBytes }] : []),
    ];
    const anticipatedRetirements = this.anticipatedRetirementUsage(value.sessionId, predecessor, directory?.superseded ?? []);
    let usage = priorUsage;
    if (this.exceedsQuota(usage, additions) || this.exceedsPublicationPeak(usage, additions, headerBytes, oldHeaderKind, oldHeaderBytes, atomicArtifactWrites, anticipatedRetirements)) {
      // A projected admission failure is a recovery boundary: collect only
      // proven orphans while holding this publication lock, then retry the
      // exact delta once before refusing capacity.
      usage = this.reconcileGarbageLocked();
    }
    if (this.exceedsQuota(usage, additions) || this.exceedsPublicationPeak(usage, additions, headerBytes, oldHeaderKind, oldHeaderBytes, atomicArtifactWrites, anticipatedRetirements)) {
      return this.refusal("ORDINARY_SNAPSHOT_QUOTA_EXCEEDED", "ordinary snapshot quota prevents publication", value.sessionId);
    }
    const projectedUsage = { entries: usage.entries + additions.entries, bytes: usage.bytes + additions.bytes };
    // This write is the publication barrier for *every* locator, including a
    // generation-zero session.  An immutable body can survive a failed write
    // even when no pointer exists, so leaving a prior clean manifest in place
    // would let a later writer undercount that orphan and bypass admission.
    // Do not catch this: a failed barrier must prevent every artifact write.
    this.writeUsageManifest(projectedUsage, false);
    this.testHooks?.onPublicationStage?.("dirty-persisted");
    let firstArtifactPersisted = false;
    const noteArtifactPersisted = () => {
      if (!firstArtifactPersisted) { firstArtifactPersisted = true; this.testHooks?.onPublicationStage?.("first-artifact-persisted"); }
    };
    if (archivePath && archiveText) {
      if (archiveKind === "regular") {
        if (this.ops.read(archivePath, ORDINARY_SESSION_SNAPSHOT_MAX_BYTES * 2) !== archiveText) return this.refusal("ORDINARY_SNAPSHOT_CONFLICT", "ordinary action archive hash collides with different content", value.sessionId);
      } else { this.ops.writeNew(archivePath, archiveText); this.ops.syncDirectory?.(this.root); noteArtifactPersisted(); }
    }
    for (let index = 0; index < replayArtifacts.length; index++) {
      const artifact = replayArtifacts[index]!;
      if (replayKinds[index] === "regular") {
        if (this.ops.read(artifact.path, 64 * 1024) !== artifact.text) return this.refusal("ORDINARY_SNAPSHOT_CONFLICT", "ordinary replay index node collides with different content", value.sessionId);
      } else { this.ops.writeNew(artifact.path, artifact.text); this.ops.syncDirectory?.(this.root); noteArtifactPersisted(); }
    }
    if (bodyKind === "regular") {
      if (this.ops.read(bodyPath, ORDINARY_SESSION_SNAPSHOT_MAX_BYTES) !== body) return this.refusal("ORDINARY_SNAPSHOT_CONFLICT", "ordinary immutable envelope hash collides with different content", value.sessionId);
    } else { this.ops.writeNew(bodyPath, body); this.ops.syncDirectory?.(this.root); noteArtifactPersisted(); }
    try {
      this.ops.writeReplace(this.headerPath(value.sessionId), headerText); this.ops.syncDirectory?.(this.root);
    } catch (error) {
      try { this.writeUsageManifest(projectedUsage, false); } catch { /* a later locked writer must rebuild */ }
      return { status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE", message: error instanceof Error ? error.message : "ordinary envelope pointer publication may have completed", sessionId: value.sessionId };
    }
    // A pointer is authoritative only when its named receipt is available.
    // Pre-writing the receipt handles ordinary crashes; this second, exact
    // repair covers a fault-injection/filesystem anomaly after the pointer
    // reached disk and before the archive directory entry became durable.
    if (archive && archivePath && archiveText) {
      try { this.ensureArchiveReceipt(archive, archivePath, archiveText); }
      catch { return { status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE", message: "ordinary envelope pointer published but action archive repair failed", sessionId: value.sessionId }; }
    }
    const reloaded = this.durableReload(value, header, body);
    if (reloaded.status !== "ok") return { status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE", message: "ordinary envelope pointer published but durable reload failed", sessionId: value.sessionId };
    this.testHooks?.onPublicationStage?.("pointer-durable-before-clean");
    let removals: OrdinaryUsage = { entries: 0, bytes: 0 };
    if (predecessor) {
      const oldPath = this.bodyPath(value.sessionId, predecessor.envelopeHash);
      if (this.ops.kind(oldPath) !== "regular") return { status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE", message: "ordinary predecessor cleanup could not be verified", sessionId: value.sessionId };
      removals = { entries: 1, bytes: this.ops.size(oldPath) };
      this.ops.remove(oldPath); this.ops.syncDirectory?.(this.root);
      // A persistent AVL insertion replaces only its search path. After the
      // new pointer has reloaded, those old immutable nodes cannot be reached
      // from the authoritative root; deleting them keeps live directory space
      // O(actions), while a crash merely leaves quota-accounted GC candidates.
      for (const nodeHash of directory?.superseded ?? []) {
        const path = this.replayDirectoryNodePath(value.sessionId, nodeHash);
        if (this.ops.kind(path) === "regular") { removals.entries++; removals.bytes += this.ops.size(path); this.ops.remove(path); }
      }
      this.ops.syncDirectory?.(this.root);
    }
    const committedUsage = { entries: projectedUsage.entries - removals.entries, bytes: projectedUsage.bytes - removals.bytes };
    try {
      this.writeUsageManifest(committedUsage, true);
    } catch (error) {
      // The pre-publication marker is already dirty. If a failing replace did
      // not preserve it, make one best-effort repair before reporting an
      // indeterminate published pointer. If repair also fails, the only other
      // possible on-disk clean text is this exact committedUsage, never the
      // old pre-publication counters.
      try { this.writeUsageManifest(committedUsage, false); } catch { /* next locked writer can still validate/rebuild */ }
      return { status: "indeterminate", code: "ORDINARY_SNAPSHOT_INDETERMINATE", message: error instanceof Error ? error.message : "ordinary usage manifest finalization failed", sessionId: value.sessionId };
    }
    return reloaded;
  }

  private durableReload(value: OrdinarySessionEnvelope, header: HeaderFile, body: string): OrdinarySessionSnapshotResult<OrdinarySessionEnvelopeHeader> {
    const current = this.readHeader(value.sessionId);
    if (current.status !== "ok" || current.value.envelopeHash !== header.envelopeHash || current.value.generation !== header.generation || current.value.bodyBytes !== header.bodyBytes) {
      return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary durable pointer does not match publication", value.sessionId);
    }
    const persisted = this.read(value.sessionId);
    if (persisted.status !== "ok" || `${canonicalJson(persisted.value)}\n` !== body) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary durable envelope does not match publication", value.sessionId);
    return { status: "ok", value: current.value };
  }

  private usageManifestPath(): string { return join(this.root, ORDINARY_USAGE_MANIFEST_FILE); }
  private isControlFile(name: string): boolean {
    return name === ORDINARY_USAGE_MANIFEST_FILE || [".ordinary-session-envelope-write.sqlite", ".ordinary-session-envelope-write.sqlite-journal", ".ordinary-session-envelope-write.sqlite-wal", ".ordinary-session-envelope-write.sqlite-shm"].includes(name);
  }
  private usageManifestText(usage: OrdinaryUsage, clean: boolean): string {
    return `${canonicalJson({ kind: "ordinary-session-envelope-usage", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, barrier: ORDINARY_USAGE_MANIFEST_BARRIER, clean, entries: usage.entries, bytes: usage.bytes } satisfies OrdinaryUsageManifest)}\n`;
  }
  private parseUsageManifest(raw: unknown): OrdinaryUsageManifest | undefined {
    if (!isRecord(raw) || !exactKeys(raw, ["kind", "schemaVersion", "barrier", "clean", "entries", "bytes"])
      || raw.kind !== "ordinary-session-envelope-usage" || raw.schemaVersion !== ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION || typeof raw.clean !== "boolean"
      || raw.barrier !== ORDINARY_USAGE_MANIFEST_BARRIER
      || !validGeneration(raw.entries) || !validGeneration(raw.bytes)) return undefined;
    return raw as unknown as OrdinaryUsageManifest;
  }
  private controlUsage(manifestBytes?: number): OrdinaryUsage {
    let entries = 0; let bytes = 0;
    for (const name of [".ordinary-session-envelope-write.sqlite", ".ordinary-session-envelope-write.sqlite-journal", ".ordinary-session-envelope-write.sqlite-wal", ".ordinary-session-envelope-write.sqlite-shm"]) {
      const path = join(this.root, name); const kind = this.ops.kind(path);
      if (kind === "unsafe" || kind === "directory") throw new Error("ordinary snapshot control leaf is unsafe");
      if (kind === "regular") { entries++; bytes += this.ops.size(path); }
    }
    const kind = this.ops.kind(this.usageManifestPath());
    if (kind === "unsafe" || kind === "directory") throw new Error("ordinary usage manifest leaf is unsafe");
    if (manifestBytes !== undefined) return { entries: entries + 1, bytes: bytes + manifestBytes };
    return kind === "regular" ? { entries: entries + 1, bytes: bytes + this.ops.size(this.usageManifestPath()) } : { entries, bytes };
  }
  private exceedsQuota(usage: OrdinaryUsage, additions: OrdinaryUsage): boolean {
    const projected = { entries: usage.entries + additions.entries, bytes: usage.bytes + additions.bytes };
    const manifestBytes = Math.max(new TextEncoder().encode(this.usageManifestText(projected, false)).byteLength, new TextEncoder().encode(this.usageManifestText(projected, true)).byteLength);
    const control = this.controlUsage(manifestBytes);
    return projected.entries + control.entries > this.policy!.maxEntries || projected.bytes + control.bytes > this.policy!.maxBytes;
  }
  /**
   * Reserve the actual peak of each atomic root write, not merely its final
   * directory footprint. `writeNew` holds a temp and its final hard link at
   * once; `writeReplace` holds the previous final plus its new temp. This is
   * evaluated before the first business artifact is attempted.
   */
  private exceedsPublicationPeak(
    usage: OrdinaryUsage,
    additions: OrdinaryUsage,
    headerBytes: number,
    oldHeaderKind: "missing" | "regular",
    oldHeaderBytes: number,
    atomicArtifactWrites: OrdinaryUsage[],
    retirements: OrdinaryUsage,
  ): boolean {
    const policy = this.policy!;
    const control = this.controlUsage();
    let entries = usage.entries + control.entries;
    let bytes = usage.bytes + control.bytes;
    const over = (extraEntries: number, extraBytes: number): boolean => {
      const peakEntries = entries + extraEntries; const peakBytes = bytes + extraBytes;
      return !Number.isSafeInteger(peakEntries) || !Number.isSafeInteger(peakBytes)
        || peakEntries > policy.maxEntries || peakBytes > policy.maxBytes;
    };
    const manifestPath = this.usageManifestPath(); const manifestKind = this.ops.kind(manifestPath);
    if (manifestKind !== "missing" && manifestKind !== "regular") throw new Error("ordinary usage manifest leaf is unsafe");
    const projected = { entries: usage.entries + additions.entries, bytes: usage.bytes + additions.bytes };
    const dirtyBytes = new TextEncoder().encode(this.usageManifestText(projected, false)).byteLength;
    if (manifestKind === "missing") {
      if (over(2, dirtyBytes * 2)) return true;
      entries += 1; bytes += dirtyBytes;
    } else {
      const oldManifestBytes = this.ops.size(manifestPath);
      if (over(1, dirtyBytes)) return true;
      bytes += dirtyBytes - oldManifestBytes;
    }
    for (const artifact of atomicArtifactWrites) {
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || over(2, artifact.bytes * 2)) return true;
      entries += 1; bytes += artifact.bytes;
    }
    if (over(1, headerBytes)) return true;
    entries += oldHeaderKind === "missing" ? 1 : 0; bytes += headerBytes - oldHeaderBytes;
    if (!Number.isSafeInteger(entries) || !Number.isSafeInteger(bytes) || entries < retirements.entries || bytes < retirements.bytes) return true;
    entries -= retirements.entries; bytes -= retirements.bytes;
    const committed = { entries: projected.entries - retirements.entries, bytes: projected.bytes - retirements.bytes };
    const cleanBytes = new TextEncoder().encode(this.usageManifestText(committed, true)).byteLength;
    return over(1, cleanBytes);
  }
  private anticipatedRetirementUsage(sessionId: string, predecessor: OrdinarySessionEnvelope | undefined, superseded: string[]): OrdinaryUsage {
    if (!predecessor) return { entries: 0, bytes: 0 };
    const paths = [this.bodyPath(sessionId, predecessor.envelopeHash), ...superseded.map((nodeHash) => this.replayDirectoryNodePath(sessionId, nodeHash))];
    let entries = 0; let bytes = 0;
    for (const path of paths) {
      if (this.ops.kind(path) === "regular") { entries++; bytes += this.ops.size(path); }
    }
    return { entries, bytes };
  }
  /** Measure a dirty/missing manifest without writing a control artifact before admission. */
  private rebuildUsageLocked(): OrdinaryUsage {
    this.assertSafeRoot(); let entries = 0; let bytes = 0;
    for (const name of this.ops.list(this.root)) {
      if (name !== basename(name)) throw new Error("ordinary snapshot root contains unsafe entry name");
      const path = join(this.root, name); const kind = this.ops.kind(path);
      if (kind === "unsafe" || kind === "directory") throw new Error("ordinary snapshot root contains an unsafe leaf");
      if (kind === "regular" && !this.isControlFile(name)) { entries++; bytes += this.ops.size(path); }
    }
    return { entries, bytes };
  }
  private loadUsageLocked(): OrdinaryUsage {
    const path = this.usageManifestPath(); const kind = this.ops.kind(path);
    if (kind === "missing") return this.rebuildUsageLocked();
    if (kind !== "regular") throw new Error("ordinary usage manifest leaf is unsafe");
    const manifest = this.parseUsageManifest(JSON.parse(this.ops.read(path, 16 * 1024)));
    return manifest?.clean ? { entries: manifest.entries, bytes: manifest.bytes } : this.rebuildUsageLocked();
  }
  private writeUsageManifest(usage: OrdinaryUsage, clean: boolean): void {
    if (!validGeneration(usage.entries) || !validGeneration(usage.bytes)) throw new Error("ordinary usage manifest counters are invalid");
    const path = this.usageManifestPath(); const kind = this.ops.kind(path);
    if (kind !== "missing" && kind !== "regular") throw new Error("ordinary usage manifest leaf is unsafe");
    const text = this.usageManifestText(usage, clean);
    if (kind === "missing") this.ops.writeNew(path, text); else this.ops.writeReplace(path, text);
    this.ops.syncDirectory?.(this.root);
  }

  private isArchiveSuccessor(previous: OrdinarySessionEnvelope, next: OrdinarySessionEnvelope): boolean {
    if (next.generation !== previous.generation + 1 || next.archive.count !== next.generation
      || next.idempotency.length === 0) return false;
    try {
      const terminal = next.idempotency.at(-1)!;
      // Admission must bind the entire bounded hot window before the pointer
      // write. A syntactically valid older receipt is never allowed to drift
      // away from the already audited predecessor/archive.
      if (canonicalJson(next.idempotency) !== canonicalJson([...previous.idempotency, terminal].slice(-ORDINARY_SESSION_IDEMPOTENCY_LIMIT))) return false;
        const expected = nextOrdinarySessionArchive(next.sessionId, previous.archive, next.idempotency.at(-1)!, next.snapshot, next.schemaVersion);
      const expectedDirectory = deriveReplayDirectoryAppend(
        next.sessionId,
        previous.replayDirectory,
        next.idempotency.at(-1)!.actionId,
        previous.replayDirectory.count,
        expected.headHash!,
        (nodeHash) => {
          const node = this.readReplayDirectoryNode(next.sessionId, nodeHash);
          if (node.status !== "ok") throw new Error(node.message);
          return node.value;
        },
      );
      return canonicalJson(expected) === canonicalJson(next.archive) && canonicalJson(expectedDirectory.state) === canonicalJson(next.replayDirectory);
    } catch { return false; }
  }
  private archiveReceiptForEnvelope(value: OrdinarySessionEnvelope): OrdinaryArchivedActionReceipt | undefined {
    if (value.generation === 0) return undefined;
    const record = value.idempotency.at(-1);
    if (!record) throw new Error("ordinary successor has no terminal receipt");
      const receipt = createOrdinaryArchivedActionReceipt({
        kind: "ordinary-action-receipt",
        schemaVersion: value.schemaVersion,
      sessionId: value.sessionId,
      previousArchiveHash: value.archive.previousHeadHash,
      record,
      projection: ordinaryOperationSnapshotProjection(value.snapshot, value.schemaVersion, record.operation),
    });
    if (receipt.archiveHash !== value.archive.headHash) throw new Error("ordinary archive head does not name terminal receipt");
    return receipt;
  }
  private ensureArchiveReceipt(_receipt: OrdinaryArchivedActionReceipt, path: string, text: string): void {
    const kind = this.ops.kind(path);
    if (kind === "regular") {
      if (this.ops.read(path, ORDINARY_SESSION_SNAPSHOT_MAX_BYTES * 2) !== text) throw new Error("ordinary action archive hash collides with different content");
      return;
    }
    if (kind !== "missing") throw new Error("ordinary action archive path is unsafe");
    this.ops.writeNew(path, text); this.ops.syncDirectory?.(this.root);
  }
  private readArchiveReceipt(sessionId: string, archiveHash: string): OrdinarySessionSnapshotResult<OrdinaryArchivedActionReceipt> {
    if (!validId(sessionId) || !validHash(archiveHash)) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary action archive locator is invalid", sessionId);
    try {
      this.assertSafeRoot();
      const path = this.archivePath(sessionId, archiveHash);
      if (this.ops.kind(path) !== "regular") return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary action archive receipt is unavailable", sessionId);
      const receipt = validateOrdinaryArchivedActionReceipt(JSON.parse(this.ops.read(path, ORDINARY_SESSION_SNAPSHOT_MAX_BYTES * 2)));
      if (receipt.sessionId !== sessionId || receipt.archiveHash !== archiveHash) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary action archive receipt does not match its locator", sessionId);
      return { status: "ok", value: receipt };
    } catch (error) { return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", error instanceof Error ? error.message : "ordinary action archive receipt is unreadable", sessionId); }
  }
  private readReplayDirectoryNode(sessionId: string, nodeHash: string): OrdinarySessionSnapshotResult<OrdinaryReplayDirectoryNode> {
    if (!validId(sessionId) || !validHash(nodeHash)) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary replay directory locator is invalid", sessionId);
    try {
      const path = this.replayDirectoryNodePath(sessionId, nodeHash);
      if (this.ops.kind(path) !== "regular") return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary replay directory node is unavailable", sessionId);
      const raw = outerDataRecord(JSON.parse(this.ops.read(path, 64 * 1024)), "ordinary replay directory node");
      if (!exactKeys(raw, ["kind", "schemaVersion", "sessionId", "actionId", "index", "archiveHash", "height", "leftHash", "rightHash", "nodeHash"])
        || raw.kind !== "ordinary-action-replay-directory-node" || ![ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, LEGACY_ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION].includes(raw.schemaVersion as string)
        || raw.sessionId !== sessionId || !validActionId(raw.actionId) || !validGeneration(raw.index) || !validHash(raw.archiveHash)
        || !validGeneration(raw.height) || raw.height < 1 || raw.height > 64
        || !(raw.leftHash === null || validHash(raw.leftHash)) || !(raw.rightHash === null || validHash(raw.rightHash)) || raw.nodeHash !== nodeHash) {
        return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary replay directory node is invalid", sessionId);
      }
      const unsigned = replayDirectoryUnsigned({ kind: "ordinary-action-replay-directory-node", schemaVersion: raw.schemaVersion as OrdinaryEnvelopeSchemaVersion, sessionId, actionId: raw.actionId, index: raw.index, archiveHash: raw.archiveHash, height: raw.height, leftHash: raw.leftHash, rightHash: raw.rightHash });
      if (replayDirectoryNodeHash(unsigned) !== nodeHash) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary replay directory node hash is invalid", sessionId);
      return { status: "ok", value: { ...unsigned, nodeHash } };
    } catch (error) { return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", error instanceof Error ? error.message : "ordinary replay directory node is unreadable", sessionId); }
  }
  private verifyReplayDirectoryRoot(value: OrdinarySessionEnvelope): boolean {
    if (value.generation === 0) return value.replayDirectory.count === 0 && value.replayDirectory.rootHash === null;
    if (value.replayDirectory.count !== value.generation || value.replayDirectory.rootHash === null) return false;
    const root = this.readReplayDirectoryNode(value.sessionId, value.replayDirectory.rootHash);
    return root.status === "ok" && root.value.height <= 64;
  }

  /**
   * The root hash alone authenticates a search path, but is insufficient for
   * a durable authority read: an omitted non-root node would otherwise leave
   * an already committed action permanently unreplayable.  Audit the whole
   * immutable set here (not on arbitrary-ID lookup): archive lineage and the
   * directory must be a one-to-one, balanced BST over exactly generations
   * 1..N.  This also binds every bounded hot receipt to its archived record.
   */
  private auditReplaySet(value: OrdinarySessionEnvelope): AuditedOrdinaryReplaySet | undefined {
    try {
      if (this.policy && value.generation > this.policy.maxEntries) return undefined;
      if (value.generation === 0) return value.idempotency.length === 0 ? { envelope: value, nodes: new Map() } : undefined;
      const receipts = new Map<number, { hash: string; record: OrdinaryPersistedOperationRecord }>();
      let archiveHash = value.archive.headHash;
      for (let generation = value.generation; generation >= 1; generation--) {
        if (archiveHash === null || receipts.size >= value.generation) return undefined;
        const receipt = this.readArchiveReceipt(value.sessionId, archiveHash);
        if (receipt.status !== "ok" || receipt.value.record.generation !== generation || receipts.has(generation)) return undefined;
        receipts.set(generation, { hash: archiveHash, record: receipt.value.record });
        archiveHash = receipt.value.previousArchiveHash;
      }
      if (archiveHash !== null || receipts.size !== value.generation) return undefined;

      const seenNodes = new Set<string>();
      const seenIndexes = new Set<number>();
      const nodes = new Map<string, OrdinaryReplayDirectoryNode>();
      const visit = (nodeHash: string | null, lower: string | null, upper: string | null, depth: number): number | null => {
        if (nodeHash === null) return 0;
        if (depth >= 64 || seenNodes.has(nodeHash)) return null;
        seenNodes.add(nodeHash);
        const node = this.readReplayDirectoryNode(value.sessionId, nodeHash);
        if (node.status !== "ok" || (lower !== null && node.value.actionId <= lower) || (upper !== null && node.value.actionId >= upper)
          || node.value.index >= value.generation || seenIndexes.has(node.value.index)) return null;
        nodes.set(nodeHash, node.value);
        const archived = receipts.get(node.value.index + 1);
        if (!archived || archived.hash !== node.value.archiveHash || archived.record.actionId !== node.value.actionId) return null;
        seenIndexes.add(node.value.index);
        const left = visit(node.value.leftHash, lower, node.value.actionId, depth + 1);
        if (left === null) return null;
        const right = visit(node.value.rightHash, node.value.actionId, upper, depth + 1);
        if (right === null || Math.abs(left - right) > 1 || node.value.height !== Math.max(left, right) + 1) return null;
        return node.value.height;
      };
      const height = visit(value.replayDirectory.rootHash, null, null, 0);
      if (height === null || seenNodes.size !== value.generation || seenIndexes.size !== value.generation) return undefined;
      if (!value.idempotency.every((entry) => {
        const archived = receipts.get(entry.generation);
        return archived !== undefined && canonicalJson(archived.record) === canonicalJson(entry);
      })) return undefined;
      return { envelope: value, nodes };
    } catch { return undefined; }
  }

  /** Constant-window receipt inheritance plus an O(log n) persistent AVL
   * append. `cached.nodes` is a prior full audit checkpoint, so this remains
   * valid after the successor has retired predecessor files on disk. */
  private isCachedReplaySuccessor(cached: AuditedOrdinaryReplaySet, next: OrdinarySessionEnvelope): boolean {
    const previous = cached.envelope;
    if (next.generation !== previous.generation + 1 || next.previousEnvelopeHash !== previous.envelopeHash
      || !sameOrdinarySessionAccessBinding(previous.access, next.access)
      || next.archive.previousHeadHash !== previous.archive.headHash) return false;
    const terminal = next.idempotency.at(-1);
    if (!terminal || canonicalJson(next.idempotency) !== canonicalJson([...previous.idempotency, terminal].slice(-ORDINARY_SESSION_IDEMPOTENCY_LIMIT))) return false;
    try {
      const expected = deriveReplayDirectoryAppend(next.sessionId, previous.replayDirectory, terminal.actionId, previous.replayDirectory.count, next.archive.headHash!, (hash) => {
        const node = cached.nodes.get(hash);
        if (!node) throw new Error("ordinary cached replay predecessor is incomplete");
        return node;
      });
      return canonicalJson(expected.state) === canonicalJson(next.replayDirectory);
    } catch { return false; }
  }

  private extendCachedReplaySet(cached: AuditedOrdinaryReplaySet, next: OrdinarySessionEnvelope): AuditedOrdinaryReplaySet | undefined {
    if (!this.isCachedReplaySuccessor(cached, next)) return undefined;
    const terminal = next.idempotency.at(-1)!;
    try {
      const derived = deriveReplayDirectoryAppend(next.sessionId, cached.envelope.replayDirectory, terminal.actionId, cached.envelope.replayDirectory.count, next.archive.headHash!, (hash) => {
        const node = cached.nodes.get(hash);
        if (!node) throw new Error("ordinary cached replay predecessor is incomplete");
        return node;
      });
      // This Map is an in-process checkpoint, not immutable authority. The
      // derivation has already read and authenticated the O(log n) replaced
      // path, so update that checkpoint in place. Cloning every live node here
      // would turn an otherwise logarithmic normal action into O(n).
      const retired = new Set(derived.superseded);
      const additions = new Map<string, OrdinaryReplayDirectoryNode>();
      let resultingSize = cached.nodes.size;
      for (const hash of retired) {
        if (!cached.nodes.has(hash)) return undefined;
        resultingSize--;
      }
      for (const node of derived.nodes) {
        const earlier = additions.get(node.nodeHash);
        if (earlier && canonicalJson(earlier) !== canonicalJson(node)) return undefined;
        if (earlier) continue;
        if (retired.has(node.nodeHash)) return undefined;
        const existing = cached.nodes.get(node.nodeHash);
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(node)) return undefined;
        } else resultingSize++;
        additions.set(node.nodeHash, node);
      }
      if (resultingSize !== next.generation) return undefined;
      for (const hash of retired) cached.nodes.delete(hash);
      for (const node of derived.nodes) cached.nodes.set(node.nodeHash, node);
      return { envelope: next, nodes: cached.nodes };
    } catch { return undefined; }
  }

  private lookupReplayReceipt(value: OrdinarySessionEnvelope, actionId: string): OrdinarySessionSnapshotResult<OrdinaryPersistedOperationRecord | null> {
    try {
      let nodeHash = value.replayDirectory.rootHash;
      const seen = new Set<string>();
      for (let depth = 0; nodeHash !== null; depth++) {
        if (depth >= 64 || seen.has(nodeHash)) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary replay directory depth is invalid", value.sessionId);
        seen.add(nodeHash);
        const node = this.readReplayDirectoryNode(value.sessionId, nodeHash);
        if (node.status !== "ok") return node;
        if (node.value.index >= value.replayDirectory.count) return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary replay directory index is invalid", value.sessionId);
        if (node.value.actionId === actionId) {
          const receipt = this.readArchiveReceipt(value.sessionId, node.value.archiveHash);
          if (receipt.status !== "ok" || receipt.value.record.actionId !== actionId || receipt.value.record.generation !== node.value.index + 1) {
            return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", "ordinary replay receipt is invalid", value.sessionId);
          }
          return { status: "ok", value: structuredClone(receipt.value.record) };
        }
        nodeHash = actionId < node.value.actionId ? node.value.leftHash : node.value.rightHash;
      }
      return { status: "ok", value: null };
    } catch (error) { return this.refusal("ORDINARY_SNAPSHOT_CORRUPT", error instanceof Error ? error.message : "ordinary replay directory is unreadable", value.sessionId); }
  }
  private verifyArchiveHead(value: OrdinarySessionEnvelope): boolean {
    if (value.generation === 0) return value.archive.count === 0 && value.archive.headHash === null && value.archive.previousHeadHash === null;
    if (value.archive.count !== value.generation || value.archive.headHash === null) return false;
    const receipt = this.readArchiveReceipt(value.sessionId, value.archive.headHash);
    if (receipt.status !== "ok" || receipt.value.previousArchiveHash !== value.archive.previousHeadHash
      || receipt.value.record.generation !== value.generation
      || canonicalJson(receipt.value.record) !== canonicalJson(value.idempotency.at(-1))
      || canonicalJson(receipt.value.projection) !== canonicalJson(ordinaryOperationSnapshotProjection(value.snapshot, value.schemaVersion, value.idempotency.at(-1)?.operation))) return false;
    return true;
  }
  private collectArchiveFileNames(value: OrdinarySessionEnvelope): Set<string> {
    const result = new Set<string>();
    let archiveHash = value.archive.headHash;
    let generation = value.generation;
    for (let index = 0; index < value.archive.count; index++) {
      if (archiveHash === null) throw new Error("ordinary action archive chain ended early");
      const receipt = this.readArchiveReceipt(value.sessionId, archiveHash);
      if (receipt.status !== "ok" || receipt.value.record.generation !== generation) throw new Error("ordinary action archive chain is invalid");
      result.add(`${value.sessionId}.${archiveHash}.ordinary-action-receipt.json`);
      archiveHash = receipt.value.previousArchiveHash;
      generation--;
    }
    if (archiveHash !== null || generation !== 0) throw new Error("ordinary action archive chain count is invalid");
    return result;
  }
  private collectReplayFileNames(value: OrdinarySessionEnvelope): Set<string> {
    const result = new Set<string>();
    const visit = (nodeHash: string | null, depth: number): void => {
      if (nodeHash === null) return;
      if (depth >= 64 || result.has(basename(this.replayDirectoryNodePath(value.sessionId, nodeHash)))) throw new Error("ordinary replay directory is cyclic or too deep");
      const node = this.readReplayDirectoryNode(value.sessionId, nodeHash);
      if (node.status !== "ok") throw new Error(node.message);
      result.add(basename(this.replayDirectoryNodePath(value.sessionId, nodeHash)));
      visit(node.value.leftHash, depth + 1); visit(node.value.rightHash, depth + 1);
    };
    visit(value.replayDirectory.rootHash, 0);
    return result;
  }
  private assertSafeRoot(): void { if (this.ops.kind(this.root) !== "directory") throw new Error("ordinary snapshot root is not a real non-link directory"); }
  /** Only proven non-current ordinary immutable bodies are eligible; unknown files remain quota-accounted. */
  private reconcileGarbageLocked(): OrdinaryUsage {
    this.assertSafeRoot();
    const names = this.ops.list(this.root);
    const currentHashes = new Set<string>();
    const currentArchiveHashes = new Set<string>();
    const currentReplayFiles = new Set<string>();
    for (const name of names.filter((entry) => entry.endsWith(".ordinary-current.json"))) {
      const header = this.readHeader(name.slice(0, -".ordinary-current.json".length));
      if (header.status !== "ok") throw new Error("ordinary pointer cannot be verified for garbage collection");
      const body = this.read(header.value.sessionId);
      if (body.status !== "ok") throw new Error("ordinary current envelope cannot be verified for garbage collection");
      currentHashes.add(`${body.value.sessionId}.${body.value.envelopeHash}.ordinary-envelope.json`);
      for (const archiveName of this.collectArchiveFileNames(body.value)) currentArchiveHashes.add(archiveName);
      for (const replayName of this.collectReplayFileNames(body.value)) currentReplayFiles.add(replayName);
    }
    const removals: string[] = [];
    for (const name of names) {
      const match = /^([A-Za-z0-9_-]{1,128})\.([a-f0-9]{64})\.ordinary-envelope\.json$/.exec(name);
      if (!match || currentHashes.has(name)) continue;
      const path = join(this.root, name);
      if (this.ops.kind(path) !== "regular") throw new Error("ordinary garbage leaf became unsafe");
      const parsed = JSON.parse(this.ops.read(path, ORDINARY_SESSION_SNAPSHOT_MAX_BYTES));
      const envelope = validateOrdinarySessionEnvelope(parsed);
      if (envelope.sessionId !== match[1] || envelope.envelopeHash !== match[2]) throw new Error("ordinary garbage leaf does not prove its name");
      removals.push(path);
    }
    for (const name of names) {
      const match = /^([A-Za-z0-9_-]{1,128})\.([a-f0-9]{64})\.ordinary-action-receipt\.json$/.exec(name);
      if (!match || currentArchiveHashes.has(name)) continue;
      const path = join(this.root, name);
      // An unparseable orphan is deliberately retained and quota-accounted;
      // only a receipt that proves both its content and its name can be GC'd.
      if (this.ops.kind(path) !== "regular") throw new Error("ordinary archive garbage leaf became unsafe");
      try {
        const receipt = validateOrdinaryArchivedActionReceipt(JSON.parse(this.ops.read(path, ORDINARY_SESSION_SNAPSHOT_MAX_BYTES * 2)));
        if (receipt.sessionId === match[1] && receipt.archiveHash === match[2]) removals.push(path);
      } catch { /* Unknown archive material is not ours to delete. */ }
    }
    for (const name of names) {
      const node = /^([A-Za-z0-9_-]{1,128})\.([a-f0-9]{64})\.ordinary-action-replay-directory-node\.json$/.exec(name);
      if (!node || currentReplayFiles.has(name)) continue;
      const checked = this.readReplayDirectoryNode(node[1]!, node[2]!);
      if (checked.status === "ok") removals.push(this.replayDirectoryNodePath(node[1]!, node[2]!));
    }
    for (const path of removals) this.ops.remove(path);
    if (removals.length) this.ops.syncDirectory?.(this.root);
    return this.rebuildUsageLocked();
  }
  private headerMayExist(sessionId: string): boolean { try { return this.ops.kind(this.headerPath(sessionId)) === "regular"; } catch { return true; } }
  private refusal(code: OrdinarySessionSnapshotRefusalCode, message: string, sessionId?: string): Extract<OrdinarySessionSnapshotResult<never>, { status: "refused" }> { return { status: "refused", code, message, ...(sessionId === undefined ? {} : { sessionId }) }; }
  private headerFileName(sessionId: string): string { return `${sessionId}.ordinary-current.json`; }
  private headerPath(sessionId: string): string { return join(this.root, this.headerFileName(sessionId)); }
  private bodyPath(sessionId: string, hash: string): string { return join(this.root, `${sessionId}.${hash}.ordinary-envelope.json`); }
  private archivePath(sessionId: string, hash: string): string { return join(this.root, `${sessionId}.${hash}.ordinary-action-receipt.json`); }
  private replayDirectoryNodePath(sessionId: string, nodeHash: string): string { return join(this.root, `${sessionId}.${nodeHash}.ordinary-action-replay-directory-node.json`); }
}
