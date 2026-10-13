/**
 * CareerFileStore keeps one v1 JSON career file per character.
 *
 * This store serializes writes to one logical character across processes and
 * provides an atomic, durable replace for that file. It deliberately does not
 * transact across character files.
 */

import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  computeCurrentState,
  type CharacterSnapshot,
  type CareerEntry,
  type CharacterCareer,
} from "./career";
import {
  inspectCareerRootLockOwner,
  tryAcquireCareerRootFence,
  type CareerRootFenceAttempt,
  type CareerRootLockOwner,
} from "./win32-career-root-fence";

const DEFAULT_CAREER_DIR =
  process.env.__CAREER_DIR ?? path.join(import.meta.dir, "../../data/careers");

interface CareerFile {
  version: 1;
  base: CharacterSnapshot | null;
  entries: CareerEntry[];
  updatedAt: string;
}

/** Stable, storage-metadata-free Career data carried by an ordinary snapshot. */
export const CAREER_PORTABLE_PROJECTION_VERSION = 1 as const;

/**
 * A managed session root may retain its historical direct Career leaves until
 * the first complete projection publication.  Once this pointer exists, every
 * conforming CareerFileStore resolves only the named immutable version
 * directory; it never falls back to those old direct leaves.
 */
const CAREER_PROJECTION_POINTER_VERSION = 1 as const;
const CAREER_PROJECTION_POINTER_FILE = ".career-active.json";
const CAREER_PROJECTION_COMPLETION_FILE = ".career-complete.json";
const CAREER_PROJECTION_VERSIONS_DIRECTORY = ".career-projections";
const CAREER_ROOT_WRITE_LOCK_FILE = ".career-root.lock";
const CAREER_ROOT_LOCK_RECORD_VERSION = 1 as const;
/** Durable recovery evidence for one ordinary envelope/Career publication. */
const CAREER_ORDINARY_PROJECTION_COMMIT_FILE = ".ordinary-career-projection-commit.json";
const CAREER_PROJECTION_STAGE_PREFIX = "projection-";
const CAREER_PROJECTION_STAGE_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CAREER_PROJECTION_STAGE_ID = new RegExp(`^projection-${CAREER_PROJECTION_STAGE_UUID}$`, "i");
/** Unpublished construction is intentionally outside the projection-* authority namespace. */
const CAREER_PROJECTION_BUILDING_STAGE_PREFIX = "building-";
const CAREER_PROJECTION_BUILDING_STAGE_ID = new RegExp(`^building-${CAREER_PROJECTION_STAGE_UUID}$`, "i");
/** A retired name retains the source version so protection checks remain exact after rename. */
const CAREER_PROJECTION_RETIRED_STAGE_PREFIX = "retired-";
const CAREER_PROJECTION_RETIRED_STAGE_ID = new RegExp(`^retired-(projection-${CAREER_PROJECTION_STAGE_UUID})$`, "i");
/** Module-private capability: callers cannot opt out of managed publication. */
const CAREER_INTERNAL_STAGE_TOKEN = Symbol("CareerFileStore internal stage");

export interface CareerPortableRecord {
  characterName: string;
  base: CharacterSnapshot | null;
  entries: CareerEntry[];
}

export interface CareerPortableProjection {
  version: typeof CAREER_PORTABLE_PROJECTION_VERSION;
  records: CareerPortableRecord[];
}

interface CareerProjectionPointer {
  version: typeof CAREER_PROJECTION_POINTER_VERSION;
  active: string;
  projectionHash: string;
}

interface CareerProjectionCompletion {
  version: typeof CAREER_PROJECTION_POINTER_VERSION;
  projectionHash: string;
}

/**
 * The active immutable stage is the Career-side CAS version.  The content
 * hash proves portable domain truth; `version` closes a content ABA interval
 * such as A -> B -> A because every managed publication receives a fresh
 * stage name.
 */
export interface CareerPortableProjectionIdentity {
  version: string;
  projectionHash: string;
}

/**
 * Host-only prepare token for one ordinary/Career publication.  It binds the
 * envelope tuple to both exact Career stage identities, so a syntactically
 * valid on-disk journal cannot be substituted between prepare and resolve.
 */
export interface CareerOrdinaryProjectionCommit {
  version: 1;
  sessionId: string;
  predecessorGeneration: number;
  predecessorEnvelopeHash: string;
  generation: number;
  envelopeHash: string;
  predecessor: CareerPortableProjectionIdentity;
  successor: CareerPortableProjectionIdentity;
}

type CareerOrdinaryProjectionCommitRecord = CareerOrdinaryProjectionCommit;

/** A third Career authority won a cross-store predecessor race. */
export class CareerProjectionPredecessorConflict extends Error {
  constructor(message = "Career projection predecessor no longer matches") {
    super(message);
    this.name = "CareerProjectionPredecessorConflict";
  }
}

/**
 * A process can be terminated while it owns the file-backed root fence.  On
 * a supported local Windows volume a recorded PID+creation FILETIME is
 * checked beneath a named mutex; all other locks remain fail-closed because
 * their former owner cannot be established without guessing.
 */
export class CareerRootLockRecoveryRequired extends Error {
  readonly code = "CAREER_ROOT_LOCK_RECOVERY_REQUIRED";

  constructor(cause?: unknown) {
    super(
      "Career root write lock requires verified recovery; its owner is live, malformed, unverifiable, or outside the supported local Windows recovery fence",
      cause === undefined ? undefined : { cause },
    );
    this.name = "CareerRootLockRecoveryRequired";
  }
}

interface HeldCareerWriteLock {
  path: string;
  token: string;
  device: number;
  inode: number;
}

/** Durable owner audit for a root or character fence on supported local Windows volumes. */
interface CareerRootLockRecord {
  version: typeof CAREER_ROOT_LOCK_RECORD_VERSION;
  token: string;
  pid: number;
  creationFiletime: string;
}

type HeldCareerRootFence = Extract<CareerRootFenceAttempt, { kind: "held" }>;

interface ObservedCareerRootLock {
  readonly raw: string;
  readonly device: number;
  readonly inode: number;
}

interface ObservedCareerWriteLock {
  readonly raw: string;
  readonly device: number;
  readonly inode: number;
}

interface CareerRootInventory {
  characters: string[];
  rootEntryCount: number;
  physicalLeafByCharacter: Map<string, string>;
}

const SNAPSHOT_REQUIRED_KEYS = [
  "characterName", "occupation", "attributes", "skills", "san", "maxSan",
  "cthulhuMythos", "hp", "maxHp", "creditRating", "createdAt",
] as const;
const SNAPSHOT_OPTIONAL_STRING_KEYS = [
  "playerName", "notes", "damageBonus", "gender", "height", "weight",
  "description", "backstory",
] as const;
const SNAPSHOT_OPTIONAL_NUMBER_KEYS = [
  "build", "move", "luck", "ac", "cash", "age", "occupationSkillPoints",
  "interestSkillPoints",
] as const;
const SNAPSHOT_OPTIONAL_STRING_ARRAY_KEYS = [
  "weapons", "armor", "inventory", "phobias", "manias", "injuries",
  "occupationSkills",
] as const;
const ENTRY_REQUIRED_KEYS = [
  "id", "characterName", "moduleId", "moduleName", "completedAt", "endingId",
  "endingName", "sanChange", "cmChange", "reputationChange", "skillChanges",
  "rewardIds", "narrative",
] as const;
const ENTRY_OPTIONAL_STRING_KEYS = [
  "moduleDifficulty", "endingDescription", "rewardSnapshot",
] as const;
/*
 * Resource contract for one durable character file and one portable Career
 * projection. These are parser/storage safety limits, not a disk quota for
 * the containing directory. Ordinary durable snapshot bodies already use a
 * 2 MiB bound, so independent Career files and direct imports use the same
 * byte ceiling rather than bypassing it.
 */
const MAX_CAREER_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CAREER_PORTABLE_RECORDS = 4096;
const MAX_CAREER_ENTRIES = 4096;
const MAX_CAREER_COLLECTION_MEMBERS = 4096;
const MAX_CAREER_ROOT_ENTRIES = 4096;
/** At most one authority plus a small, fail-closed cleanup backlog. */
const MAX_CAREER_PROJECTION_VERSIONS = 8;
/** Independent, bounded recovery budgets for unpublished/retired namespaces. */
const MAX_CAREER_PROJECTION_BUILDING_STAGES = 8;
const MAX_CAREER_PROJECTION_RETIRED_STAGES = 8;
const MAX_CAREER_PROJECTION_RECOVERY_LEAVES = MAX_CAREER_ROOT_ENTRIES + 1;
const MAX_CAREER_PROJECTION_RECOVERY_BYTES = MAX_CAREER_ROOT_ENTRIES * MAX_CAREER_JSON_BYTES;
const MAX_CAREER_LOCK_BYTES = 128;
const MAX_CAREER_CONTROL_BYTES = 512;
const MAX_CAREER_ORDINARY_COMMIT_BYTES = 1024;
const MAX_CAREER_IDENTITY_BYTES = 256;
const MAX_CAREER_FIELD_BYTES = 4096;
const MAX_CAREER_LONG_TEXT_BYTES = 64 * 1024;
const MAX_CAREER_TIMESTAMP_BYTES = 128;

function legacyFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, "_");
}

function careerFileName(name: string): string {
  // Preserve UTF-16 code units (including lone surrogates) in the hash input.
  // The lower-case digest is safe on case-insensitive filesystems; a digest
  // collision is rejected by the content-identity check instead of selecting
  // or replacing either file.
  const digest = createHash("sha256").update(Buffer.from(name, "utf16le")).digest("hex");
  return `career-v1-${digest}.career.json`;
}

function isLegacyFileNameRepresentable(name: string): boolean {
  // The old mapping did not remove control characters. Such a name could never
  // have formed a valid Windows filename, so do not let an invalid legacy path
  // block the safe v1 mapping.
  return !/[\u0000-\u001f]/.test(legacyFileName(name));
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function failStorage(detail: string): never {
  throw new Error(`Unsafe career storage path: ${detail}`);
}

function isReparsePoint(stat: fs.Stats): boolean {
  // Node/Bun expose Windows junctions and symbolic links as symbolic links
  // through lstat. Any such component is rejected rather than resolved.
  return stat.isSymbolicLink();
}

function assertDirectoryNotReparse(directory: string, context: string): fs.Stats {
  const stat = fs.lstatSync(directory);
  if (isReparsePoint(stat)) failStorage(`${context} is a symlink or reparse point`);
  if (!stat.isDirectory()) failStorage(`${context} is not a directory`);
  return stat;
}

function createSafeDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  assertDirectoryNotReparse(current, "career root volume");

  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      assertDirectoryNotReparse(current, `career root component "${current}"`);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      try {
        fs.mkdirSync(current);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      assertDirectoryNotReparse(current, `career root component "${current}"`);
    }
  }
}

function realPath(directory: string): string {
  return fs.realpathSync.native(directory);
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function invalid(context: string, detail: string): never {
  throw new Error(`Invalid ${context}: ${detail}`);
}

/**
 * Counts compact JSON units while normalizing an already-materialized value.
 * We intentionally account as we traverse, rather than JSON.stringify-ing a
 * hostile portable projection after accepting all of its nested values.
 */
type CareerResourceBudget = (bytes: number) => void;

function createCareerResourceBudget(maximum: number, context: string): CareerResourceBudget {
  let used = 0;
  return (bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum - used) {
      invalid(context, `exceeds the ${maximum}-byte resource limit`);
    }
    used += bytes;
  };
}

type ResourceBudgets = readonly CareerResourceBudget[];

function charge(budgets: ResourceBudgets, bytes: number): void {
  for (const budget of budgets) budget(bytes);
}

function jsonScalarBytes(value: string | number | null): number {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("Could not serialize a bounded Career value");
  return Buffer.byteLength(serialized, "utf8");
}

function chargeObject(value: Record<string, unknown>, budgets: ResourceBudgets): void {
  charge(budgets, 2); // `{}`
  for (const key of Object.keys(value)) {
    charge(budgets, jsonScalarBytes(key) + 2); // key, colon, and a possible comma
  }
}

function chargeArray(length: number, budgets: ResourceBudgets): void {
  charge(budgets, length + 2); // `[]` plus a possible comma per member
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseCareerRootLockRecord(raw: string): CareerRootLockRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const keys = Object.keys(parsed).sort();
  const expected = ["creationFiletime", "pid", "token", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined;
  if (
    parsed.version !== CAREER_ROOT_LOCK_RECORD_VERSION
    || typeof parsed.token !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.token)
    || typeof parsed.pid !== "number"
    || !Number.isSafeInteger(parsed.pid)
    || parsed.pid <= 0
    || parsed.pid > 0xffff_ffff
    || typeof parsed.creationFiletime !== "string"
    || !/^[1-9][0-9]{0,19}$/.test(parsed.creationFiletime)
  ) return undefined;
  try {
    const creation = BigInt(parsed.creationFiletime);
    if (creation > 0xffff_ffff_ffff_ffffn) return undefined;
  } catch {
    return undefined;
  }
  return {
    version: CAREER_ROOT_LOCK_RECORD_VERSION,
    token: parsed.token,
    pid: parsed.pid,
    creationFiletime: parsed.creationFiletime,
  };
}

function serializeCareerRootLockRecord(token: string, owner: CareerRootLockOwner): string {
  return JSON.stringify({
    version: CAREER_ROOT_LOCK_RECORD_VERSION,
    token,
    pid: owner.pid,
    creationFiletime: owner.creationFiletime,
  });
}

function expectExactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(context, "has missing or unsupported fields");
  }
}

function expectAllowedKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalid(context, "has unsupported fields");
  }
}

function expectBoundedString(
  value: unknown,
  context: string,
  maximumBytes: number,
  budgets: ResourceBudgets,
): string {
  if (typeof value !== "string") invalid(context, "must be a string");
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > maximumBytes) invalid(context, `must not exceed ${maximumBytes} UTF-8 bytes`);
  charge(budgets, jsonScalarBytes(value));
  return value;
}

function expectNonEmptyBoundedString(
  value: unknown,
  context: string,
  maximumBytes: number,
  budgets: ResourceBudgets,
): string {
  const text = expectBoundedString(value, context, maximumBytes, budgets);
  if (text.trim().length === 0) invalid(context, "must not be empty");
  return text;
}

function expectIdentityString(value: unknown, context: string, budgets: ResourceBudgets): string {
  return expectNonEmptyBoundedString(value, context, MAX_CAREER_IDENTITY_BYTES, budgets);
}

function expectFieldString(value: unknown, context: string, budgets: ResourceBudgets): string {
  return expectBoundedString(value, context, MAX_CAREER_FIELD_BYTES, budgets);
}

function expectLongText(value: unknown, context: string, budgets: ResourceBudgets): string {
  return expectBoundedString(value, context, MAX_CAREER_LONG_TEXT_BYTES, budgets);
}

function expectTimestamp(value: unknown, context: string, budgets: ResourceBudgets): string {
  const text = expectNonEmptyBoundedString(value, context, MAX_CAREER_TIMESTAMP_BYTES, budgets);
  if (!Number.isFinite(Date.parse(text))) invalid(context, "must be a parseable timestamp");
  return text;
}

function expectFiniteNumber(value: unknown, context: string, budgets: ResourceBudgets): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(context, "must be a finite number");
  }
  charge(budgets, jsonScalarBytes(value));
  return value;
}

function normalizeNumberRecord(value: unknown, context: string, budgets: ResourceBudgets): Record<string, number> {
  if (!isRecord(value)) invalid(context, "must be a record of finite numbers");
  // Projection identity survives ordinary-envelope canonical JSON and a
  // filesystem round trip. Dynamic stat/skill maps therefore need one stable
  // order at the Career normalization boundary; preserving caller insertion
  // order made otherwise equivalent projections hash differently.
  const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (keys.length > MAX_CAREER_COLLECTION_MEMBERS) {
    invalid(context, `must not contain more than ${MAX_CAREER_COLLECTION_MEMBERS} members`);
  }
  chargeObject(value, budgets);
  // Portable ordinary snapshots accept JSON data objects, not null-prototype
  // implementation records. The strict parser still validates every key and
  // value before returning this conventional JSON-shaped record.
  const result: Record<string, number> = {};
  for (const key of keys) {
    if (Buffer.byteLength(key, "utf8") > MAX_CAREER_IDENTITY_BYTES) {
      invalid(`${context}.${key}`, `must not exceed ${MAX_CAREER_IDENTITY_BYTES} UTF-8 bytes`);
    }
    result[key] = expectFiniteNumber(value[key], `${context}.${key}`, budgets);
  }
  return result;
}

function normalizeStringArray(
  value: unknown,
  context: string,
  maximumItemBytes: number,
  budgets: ResourceBudgets,
): string[] {
  if (!Array.isArray(value)) invalid(context, "must be an array of strings");
  if (value.length > MAX_CAREER_COLLECTION_MEMBERS) {
    invalid(context, `must not contain more than ${MAX_CAREER_COLLECTION_MEMBERS} members`);
  }
  chargeArray(value.length, budgets);
  return value.map((item, index) => expectBoundedString(item, `${context}[${index}]`, maximumItemBytes, budgets));
}

function normalizeSnapshot(
  value: unknown,
  context: string,
  budgets: ResourceBudgets = [createCareerResourceBudget(MAX_CAREER_JSON_BYTES, context)],
): CharacterSnapshot {
  if (!isRecord(value)) invalid(context, "must be an object");
  expectAllowedKeys(value, [
    ...SNAPSHOT_REQUIRED_KEYS,
    ...SNAPSHOT_OPTIONAL_STRING_KEYS,
    ...SNAPSHOT_OPTIONAL_NUMBER_KEYS,
    ...SNAPSHOT_OPTIONAL_STRING_ARRAY_KEYS,
  ], context);
  chargeObject(value, budgets);

  const snapshot: CharacterSnapshot = {
    characterName: expectIdentityString(value.characterName, `${context}.characterName`, budgets),
    occupation: expectNonEmptyBoundedString(value.occupation, `${context}.occupation`, MAX_CAREER_FIELD_BYTES, budgets),
    attributes: normalizeNumberRecord(value.attributes, `${context}.attributes`, budgets),
    skills: normalizeNumberRecord(value.skills, `${context}.skills`, budgets),
    san: expectFiniteNumber(value.san, `${context}.san`, budgets),
    maxSan: expectFiniteNumber(value.maxSan, `${context}.maxSan`, budgets),
    cthulhuMythos: expectFiniteNumber(value.cthulhuMythos, `${context}.cthulhuMythos`, budgets),
    hp: expectFiniteNumber(value.hp, `${context}.hp`, budgets),
    maxHp: expectFiniteNumber(value.maxHp, `${context}.maxHp`, budgets),
    creditRating: expectFiniteNumber(value.creditRating, `${context}.creditRating`, budgets),
    createdAt: expectTimestamp(value.createdAt, `${context}.createdAt`, budgets),
  };

  for (const key of SNAPSHOT_OPTIONAL_STRING_KEYS) {
    if (!own(value, key)) continue;
    snapshot[key] = key === "playerName"
      ? expectIdentityString(value[key], `${context}.${key}`, budgets)
      : ["notes", "description", "backstory"].includes(key)
        ? expectLongText(value[key], `${context}.${key}`, budgets)
        : expectFieldString(value[key], `${context}.${key}`, budgets);
  }
  for (const key of SNAPSHOT_OPTIONAL_NUMBER_KEYS) {
    if (own(value, key)) snapshot[key] = expectFiniteNumber(value[key], `${context}.${key}`, budgets);
  }
  for (const key of SNAPSHOT_OPTIONAL_STRING_ARRAY_KEYS) {
    if (own(value, key)) snapshot[key] = normalizeStringArray(value[key], `${context}.${key}`, MAX_CAREER_FIELD_BYTES, budgets);
  }
  return snapshot;
}

function normalizeEntry(
  value: unknown,
  context: string,
  budgets: ResourceBudgets = [createCareerResourceBudget(MAX_CAREER_JSON_BYTES, context)],
): CareerEntry {
  if (!isRecord(value)) invalid(context, "must be an object");
  expectAllowedKeys(value, [...ENTRY_REQUIRED_KEYS, ...ENTRY_OPTIONAL_STRING_KEYS], context);
  chargeObject(value, budgets);

  const entry: CareerEntry = {
    id: expectIdentityString(value.id, `${context}.id`, budgets),
    characterName: expectIdentityString(value.characterName, `${context}.characterName`, budgets),
    moduleId: expectIdentityString(value.moduleId, `${context}.moduleId`, budgets),
    moduleName: expectNonEmptyBoundedString(value.moduleName, `${context}.moduleName`, MAX_CAREER_FIELD_BYTES, budgets),
    completedAt: expectTimestamp(value.completedAt, `${context}.completedAt`, budgets),
    endingId: expectIdentityString(value.endingId, `${context}.endingId`, budgets),
    endingName: expectNonEmptyBoundedString(value.endingName, `${context}.endingName`, MAX_CAREER_FIELD_BYTES, budgets),
    sanChange: expectFiniteNumber(value.sanChange, `${context}.sanChange`, budgets),
    cmChange: expectFiniteNumber(value.cmChange, `${context}.cmChange`, budgets),
    reputationChange: expectFiniteNumber(value.reputationChange, `${context}.reputationChange`, budgets),
    skillChanges: normalizeStringArray(value.skillChanges, `${context}.skillChanges`, MAX_CAREER_FIELD_BYTES, budgets),
    rewardIds: normalizeStringArray(value.rewardIds, `${context}.rewardIds`, MAX_CAREER_IDENTITY_BYTES, budgets),
    narrative: expectNonEmptyBoundedString(value.narrative, `${context}.narrative`, MAX_CAREER_LONG_TEXT_BYTES, budgets),
  };
  for (const key of ENTRY_OPTIONAL_STRING_KEYS) {
    if (!own(value, key)) continue;
    entry[key] = key === "moduleDifficulty"
      ? expectFieldString(value[key], `${context}.${key}`, budgets)
      : expectLongText(value[key], `${context}.${key}`, budgets);
  }
  return entry;
}

/**
 * Normalize the domain-bearing portion shared by on-disk CareerFile v1 and
 * portable projections. Storage `updatedAt` deliberately stays outside this
 * contract: it is write metadata, not portable career truth.
 */
function normalizeCareerRecord(
  value: { base: unknown; entries: unknown },
  characterName: string,
  context: string,
  projectionBudget?: CareerResourceBudget,
): Pick<CareerFile, "base" | "entries"> {
  if (!Array.isArray(value.entries)) invalid(context, "entries must be an array");
  if (value.entries.length > MAX_CAREER_ENTRIES) {
    invalid(context, `entries must not contain more than ${MAX_CAREER_ENTRIES} members`);
  }
  const recordBudget = createCareerResourceBudget(MAX_CAREER_JSON_BYTES, context);
  const budgets: ResourceBudgets = projectionBudget ? [recordBudget, projectionBudget] : [recordBudget];
  chargeArray(value.entries.length, budgets);
  const base = value.base === null
    ? (charge(budgets, jsonScalarBytes(null)), null)
    : normalizeSnapshot(value.base, `${context}.base`, budgets);
  if (base && base.characterName !== characterName) {
    invalid(context, "base.characterName does not match the requested character");
  }

  const entryIds = new Set<string>();
  const entries = value.entries.map((candidate, index) => {
    const entry = normalizeEntry(candidate, `${context}.entries[${index}]`, budgets);
    if (entry.characterName !== characterName) {
      invalid(context, `entries[${index}].characterName does not match the requested character`);
    }
    if (entryIds.has(entry.id)) invalid(context, `entries contains duplicate id "${entry.id}"`);
    entryIds.add(entry.id);
    return entry;
  });
  return { base, entries };
}

/**
 * Parse the one portable Career contract. Callers cannot smuggle file names,
 * storage timestamps, duplicate identities, or a record without a durable
 * character binding through this boundary.
 */
export function validateCareerPortableProjection(input: unknown): CareerPortableProjection {
  if (!isRecord(input)) invalid("portable career projection", "root must be an object");
  expectExactKeys(input, ["version", "records"], "portable career projection");
  const projectionBudget = createCareerResourceBudget(MAX_CAREER_JSON_BYTES, "portable career projection");
  chargeObject(input, [projectionBudget]);
  if (input.version !== CAREER_PORTABLE_PROJECTION_VERSION) invalid("portable career projection", "version must be 1");
  charge([projectionBudget], jsonScalarBytes(CAREER_PORTABLE_PROJECTION_VERSION));
  if (!Array.isArray(input.records) || input.records.length > MAX_CAREER_PORTABLE_RECORDS) {
    invalid("portable career projection", "records must be a bounded array");
  }
  chargeArray(input.records.length, [projectionBudget]);
  const names = new Set<string>();
  const records = input.records.map((candidate, index) => {
    const context = `portable career projection.records[${index}]`;
    if (!isRecord(candidate)) invalid(context, "must be an object");
    expectExactKeys(candidate, ["characterName", "base", "entries"], context);
    chargeObject(candidate, [projectionBudget]);
    const characterName = expectIdentityString(candidate.characterName, `${context}.characterName`, [projectionBudget]);
    if (names.has(characterName)) invalid(context, `duplicates characterName "${characterName}"`);
    names.add(characterName);
    const record = normalizeCareerRecord({ base: candidate.base, entries: candidate.entries }, characterName, context, projectionBudget);
    if (record.base === null && record.entries.length === 0) {
      invalid(context, "cannot represent an empty record without a character binding");
    }
    return { characterName, base: record.base, entries: record.entries };
  });
  records.sort((left, right) => left.characterName < right.characterName ? -1 : left.characterName > right.characterName ? 1 : 0);
  return { version: CAREER_PORTABLE_PROJECTION_VERSION, records };
}

/** Parse and normalize the only on-disk schema this store accepts: CareerFile v1. */
function normalizeCareerFile(value: unknown, characterName: string): CareerFile {
  const name = expectIdentityString(characterName, "character name", []);
  const context = `career file for "${name}"`;
  if (!isRecord(value)) invalid(context, "root must be an object");
  expectExactKeys(value, ["version", "base", "entries", "updatedAt"], context);
  if (value.version !== 1) invalid(context, "version must be 1");
  const updatedAt = expectTimestamp(value.updatedAt, `${context}.updatedAt`, []);
  const record = normalizeCareerRecord({ base: value.base, entries: value.entries }, name, context);
  return { version: 1, ...record, updatedAt };
}

function canonicalEntry(entry: CareerEntry): string {
  return JSON.stringify(normalizeEntry(entry, "career entry"));
}

/** The pointer commits exactly this normalized, metadata-free projection. */
export function careerPortableProjectionHash(projection: CareerPortableProjection): string {
  const normalized = validateCareerPortableProjection(projection);
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

const portableProjectionHash = careerPortableProjectionHash;

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("Career file write made no progress");
    offset += written;
  }
}

function syncCareerDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows filesystems commonly reject fsync on a directory handle. Only
    // those exact platform errors are tolerated; all other durability errors
    // fail closed after the already-atomic rename.
    if (process.platform !== "win32" || !["EINVAL", "EPERM", "EISDIR"].includes(errorCode(error) ?? "")) {
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class CareerFileStore {
  private readonly baseDir: string;
  private readonly rootDevice: number;
  private readonly rootInode: number;
  /** Internal stage stores write direct leaves and can never publish a pointer. */
  private readonly managedProjectionLayout: boolean;
  /** Set once beneath the root fence so one operation cannot cross a swap. */
  private pinnedActiveDirectory: string | undefined;

  constructor(dir?: string, internalStageToken?: typeof CAREER_INTERNAL_STAGE_TOKEN) {
    const requested = path.resolve(dir ?? DEFAULT_CAREER_DIR);
    createSafeDirectory(requested);
    assertDirectoryNotReparse(requested, "career root");
    this.baseDir = realPath(requested);
    const root = assertDirectoryNotReparse(this.baseDir, "career root");
    this.rootDevice = root.dev;
    this.rootInode = root.ino;
    this.managedProjectionLayout = internalStageToken !== CAREER_INTERNAL_STAGE_TOKEN;
  }

  private assertSafeRoot(): void {
    const root = assertDirectoryNotReparse(this.baseDir, "career root");
    if (root.dev !== this.rootDevice || root.ino !== this.rootInode) {
      failStorage("career root filesystem identity changed");
    }
    if (!sameFilesystemPath(realPath(this.baseDir), this.baseDir)) {
      failStorage("career root no longer resolves to its original filesystem location");
    }
  }

  /** A root-control leaf never follows the active projection directory. */
  private rootChildPath(name: string): string {
    const candidate = path.join(this.baseDir, name);
    if (path.dirname(candidate) !== this.baseDir) failStorage("career root control leaf is not a direct child of the pinned root");
    return candidate;
  }

  private inspectRootFile(filePath: string): fs.Stats | null {
    this.assertSafeRoot();
    if (path.dirname(filePath) !== this.baseDir) {
      failStorage("career root control file is not a direct child of the pinned root");
    }
    try {
      const stat = fs.lstatSync(filePath);
      if (isReparsePoint(stat)) failStorage(`career root control file "${filePath}" is a symlink or reparse point`);
      if (!stat.isFile()) failStorage(`career root control file "${filePath}" is not a regular file`);
      return stat;
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  private projectionContainerPath(): string {
    return this.rootChildPath(CAREER_PROJECTION_VERSIONS_DIRECTORY);
  }

  private assertProjectionContainer(): string {
    const directory = this.projectionContainerPath();
    this.assertSafeRoot();
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      if (isEnoent(error)) throw error;
      throw error;
    }
    if (isReparsePoint(stat) || !stat.isDirectory()) {
      failStorage("career projection version root is not a real directory");
    }
    if (!sameFilesystemPath(realPath(directory), directory)) {
      failStorage("career projection version root no longer resolves to its original filesystem location");
    }
    return directory;
  }

  private ensureProjectionContainer(): string {
    const directory = this.projectionContainerPath();
    try {
      return this.assertProjectionContainer();
    } catch (error) {
      if (!isEnoent(error)) throw error;
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      const resolved = this.assertProjectionContainer();
      syncCareerDirectory(this.baseDir);
      return resolved;
    }
  }

  private projectionChildDirectory(
    name: string,
    kind: "authoritative" | "building" | "retired",
  ): string {
    const valid = kind === "authoritative"
      ? CAREER_PROJECTION_STAGE_ID.test(name)
      : kind === "building"
        ? CAREER_PROJECTION_BUILDING_STAGE_ID.test(name)
        : CAREER_PROJECTION_RETIRED_STAGE_ID.test(name);
    if (!valid) failStorage(`career projection ${kind} directory has an invalid name`);
    const container = this.assertProjectionContainer();
    const directory = path.join(container, name);
    if (path.dirname(directory) !== container) failStorage(`career projection ${kind} directory is not a direct child of its pinned container`);
    const stat = fs.lstatSync(directory);
    if (isReparsePoint(stat) || !stat.isDirectory()) {
      failStorage(`career projection ${kind} directory is not a real directory`);
    }
    if (!sameFilesystemPath(realPath(directory), directory)) {
      failStorage(`career projection ${kind} directory no longer resolves to its original filesystem location`);
    }
    return directory;
  }

  private projectionVersionDirectory(name: string): string {
    return this.projectionChildDirectory(name, "authoritative");
  }

  private projectionBuildingDirectory(name: string): string {
    return this.projectionChildDirectory(name, "building");
  }

  private projectionRetiredDirectory(name: string): string {
    return this.projectionChildDirectory(name, "retired");
  }

  /** Read one small, root-local control document without following reparses. */
  private readRootControlJson(name: string, context: string, maximumBytes = MAX_CAREER_CONTROL_BYTES): unknown | null {
    const controlPath = this.rootChildPath(name);
    const inspected = this.inspectRootFile(controlPath);
    if (!inspected) return null;
    let fd: number | undefined;
    let raw: string;
    try {
      const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
      fd = fs.openSync(controlPath, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd);
      if (isReparsePoint(opened) || !opened.isFile() || opened.dev !== inspected.dev || opened.ino !== inspected.ino) {
        failStorage(`${context} changed before it could be opened safely`);
      }
      raw = this.readBoundedUtf8(fd, maximumBytes, context);
      const after = this.inspectRootFile(controlPath);
      if (!after || after.dev !== opened.dev || after.ino !== opened.ino) {
        failStorage(`${context} changed while it was being read`);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`${context} contains invalid JSON`, { cause: error });
    }
    return parsed;
  }

  /** Verify a complete stage directory before it enters or leaves authority. */
  private assertCompletedProjectionDirectory(directory: string, expectedHash: string): string {
    const stageStore = new CareerFileStore(directory, CAREER_INTERNAL_STAGE_TOKEN);
    const completion = stageStore.readRootControlJson(
      CAREER_PROJECTION_COMPLETION_FILE,
      "career projection completion manifest",
    );
    if (!isRecord(completion)) invalid("career projection completion manifest", "must be an object");
    expectExactKeys(completion, ["version", "projectionHash"], "career projection completion manifest");
    if (
      completion.version !== CAREER_PROJECTION_POINTER_VERSION
      || typeof completion.projectionHash !== "string"
      || !/^[a-f0-9]{64}$/.test(completion.projectionHash)
      || completion.projectionHash !== expectedHash
    ) {
      invalid("career projection completion manifest", "does not match the active pointer");
    }

    const projection = stageStore.exportPortableProjectionUnlocked();
    if (portableProjectionHash(projection) !== expectedHash) {
      invalid("career projection completion manifest", "does not match its projection leaves");
    }

    const expectedLeaves = new Set(projection.records.map((record) => careerFileName(record.characterName)));
    const observedLeaves = new Set<string>();
    let handle: Pick<fs.Dir, "readSync" | "closeSync"> | undefined;
    try {
      handle = fs.opendirSync(directory);
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (entry.name === CAREER_PROJECTION_COMPLETION_FILE) {
          const completionPath = path.join(directory, entry.name);
          const stat = fs.lstatSync(completionPath);
          if (isReparsePoint(stat) || !stat.isFile()) failStorage("career projection completion manifest is not a regular file");
          continue;
        }
        if (!expectedLeaves.has(entry.name) || observedLeaves.has(entry.name)) {
          failStorage("career projection version contains an unexpected or duplicate leaf");
        }
        const leafPath = path.join(directory, entry.name);
        const stat = fs.lstatSync(leafPath);
        if (isReparsePoint(stat) || !stat.isFile()) failStorage("career projection version contains a non-regular leaf");
        observedLeaves.add(entry.name);
      }
    } finally {
      if (handle !== undefined) handle.closeSync();
    }
    if (observedLeaves.size !== expectedLeaves.size || [...expectedLeaves].some((leaf) => !observedLeaves.has(leaf))) {
      failStorage("career projection version does not contain the exact completed leaf set");
    }
    return directory;
  }

  /** A pointer is authoritative only after its completed version verifies. */
  private assertCompletedProjectionVersion(name: string, expectedHash: string): string {
    return this.assertCompletedProjectionDirectory(this.projectionVersionDirectory(name), expectedHash);
  }

  /** Bounded, identity-pinned read and validation of the active-version pointer. */
  private readActiveProjectionPointer(): CareerProjectionPointer | null {
    if (!this.managedProjectionLayout) return null;
    const parsed = this.readRootControlJson(CAREER_PROJECTION_POINTER_FILE, "career projection pointer");
    if (parsed === null) return null;
    if (!isRecord(parsed)) invalid("career projection pointer", "must be an object");
    expectExactKeys(parsed, ["version", "active", "projectionHash"], "career projection pointer");
    if (
      parsed.version !== CAREER_PROJECTION_POINTER_VERSION
      || typeof parsed.active !== "string"
      || !CAREER_PROJECTION_STAGE_ID.test(parsed.active)
      || typeof parsed.projectionHash !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.projectionHash)
    ) {
      invalid("career projection pointer", "has an unsupported version or active directory");
    }
    this.assertCompletedProjectionVersion(parsed.active, parsed.projectionHash);
    return { version: CAREER_PROJECTION_POINTER_VERSION, active: parsed.active, projectionHash: parsed.projectionHash };
  }

  private readActiveProjectionName(): string | null {
    return this.readActiveProjectionPointer()?.active ?? null;
  }

  /** Resolve either the legacy direct root or the one active managed version. */
  private activeCareerDirectory(): string {
    if (this.pinnedActiveDirectory !== undefined) return this.pinnedActiveDirectory;
    const active = this.readActiveProjectionName();
    if (active === null) {
      this.assertSafeRoot();
      return this.baseDir;
    }
    return this.projectionVersionDirectory(active);
  }

  /** Verify a direct child of the physical root without following reparses. */
  private inspectFile(filePath: string): fs.Stats | null {
    const directory = this.activeCareerDirectory();
    if (path.dirname(filePath) !== directory) {
      failStorage("career file is not a direct child of the active pinned root");
    }
    try {
      const stat = fs.lstatSync(filePath);
      if (isReparsePoint(stat)) failStorage(`career file "${filePath}" is a symlink or reparse point`);
      if (!stat.isFile()) failStorage(`career file "${filePath}" is not a regular file`);
      return stat;
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  private legacyPath(characterName: string): string | undefined {
    if (!isLegacyFileNameRepresentable(characterName)) return undefined;
    return path.join(this.activeCareerDirectory(), legacyFileName(characterName) + ".career.json");
  }

  /** Resolve only an unambiguous v1 or validated legacy location. */
  private filePath(characterName: string): string {
    const name = expectIdentityString(characterName, "character name", []);
    const current = path.join(this.activeCareerDirectory(), careerFileName(name));
    const legacy = this.legacyPath(name);
    const currentStat = this.inspectFile(current);
    const legacyStat = legacy && legacy !== current ? this.inspectFile(legacy) : currentStat;
    if (currentStat && legacyStat && legacy !== current) {
      failStorage(`both v1 and legacy files exist for "${name}"`);
    }
    return currentStat ? current : legacyStat && legacy ? legacy : current;
  }

  /** Locks are keyed by the v1 logical-identity mapping, never by legacy names. */
  private lockPath(characterName: string): string {
    const name = expectIdentityString(characterName, "character name", []);
    return path.join(this.activeCareerDirectory(), `${careerFileName(name)}.lock`);
  }

  private assertHeldLockIdentity(lock: HeldCareerWriteLock): fs.Stats {
    const leaf = this.inspectFile(lock.path);
    if (!leaf) failStorage(`held career write lock "${lock.path}" disappeared`);
    if (leaf.dev !== lock.device || leaf.ino !== lock.inode) {
      failStorage(`career write lock "${lock.path}" was replaced by a different filesystem object`);
    }
    return leaf;
  }

  private readLockToken(lock: HeldCareerWriteLock): string {
    this.assertHeldLockIdentity(lock);
    let fd: number | undefined;
    try {
      const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
      fd = fs.openSync(lock.path, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd);
      if (isReparsePoint(opened) || !opened.isFile() || opened.dev !== lock.device || opened.ino !== lock.inode) {
        failStorage(`career write lock "${lock.path}" changed before it could be opened safely`);
      }
      return this.readBoundedUtf8(fd, MAX_CAREER_LOCK_BYTES, `career write lock "${lock.path}"`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private writeLockRecoveryRequired(characterName: string, cause?: unknown): Error {
    return new Error(
      `Career write lock for "${characterName}" is already held or stale; explicit recovery is required`,
      cause === undefined ? undefined : { cause },
    );
  }

  /** Read one character lock through a pinned descriptor and retain its exact bytes. */
  private observeWriteLock(lockPath: string): ObservedCareerWriteLock | null {
    const inspected = this.inspectFile(lockPath);
    if (!inspected) return null;
    let fd: number | undefined;
    try {
      const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
      fd = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd);
      if (
        isReparsePoint(opened)
        || !opened.isFile()
        || opened.dev !== inspected.dev
        || opened.ino !== inspected.ino
      ) {
        failStorage(`career write lock "${lockPath}" changed before it could be opened safely`);
      }
      const raw = this.readBoundedUtf8(fd, MAX_CAREER_LOCK_BYTES, `career write lock "${lockPath}"`, true);
      const after = this.inspectFile(lockPath);
      if (!after || after.dev !== inspected.dev || after.ino !== inspected.ino) {
        failStorage(`career write lock "${lockPath}" changed while it was being observed`);
      }
      return { raw, device: inspected.dev, inode: inspected.ino };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private writeLockStillMatches(lockPath: string, observed: ObservedCareerWriteLock): boolean {
    const current = this.inspectFile(lockPath);
    if (!current || current.dev !== observed.device || current.ino !== observed.inode) return false;
    let reread: ObservedCareerWriteLock | null;
    try {
      reread = this.observeWriteLock(lockPath);
    } catch {
      // A concurrent replacement is not storage authority for recovery. Keep
      // the newcomer and surface the ordinary fail-closed lock diagnostic.
      return false;
    }
    return reread !== null
      && reread.device === observed.device
      && reread.inode === observed.inode
      && reread.raw === observed.raw;
  }

  /** Final raw+dev+ino fence at the unlink boundary; never delete a newcomer. */
  private unlinkExactObservedWriteLock(
    characterName: string,
    lockPath: string,
    observed: ObservedCareerWriteLock,
  ): void {
    if (!this.writeLockStillMatches(lockPath, observed)) {
      throw this.writeLockRecoveryRequired(characterName);
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (isEnoent(error)) throw this.writeLockRecoveryRequired(characterName, error);
      throw error;
    }
  }

  /**
   * Reclaim only a character record whose former PID+creation identity is
   * proven gone or reused. The caller already holds the managed root's exact
   * Windows-local fence; all legacy, malformed, remote, and unknown records
   * remain fail-closed.
   */
  private recoverExactDeadWriteLock(
    characterName: string,
    lockPath: string,
    fence: HeldCareerRootFence,
  ): void {
    // The type only permits this capability after withRootWriteLock acquired
    // the managed local mutex; keep a runtime guard at the destructive edge.
    if (fence.kind !== "held") throw this.writeLockRecoveryRequired(characterName);
    const observed = this.observeWriteLock(lockPath);
    if (!observed) throw this.writeLockRecoveryRequired(characterName);
    const record = parseCareerRootLockRecord(observed.raw);
    if (!record || inspectCareerRootLockOwner(record) !== "exited-or-reused") {
      throw this.writeLockRecoveryRequired(characterName);
    }
    // Recheck both filesystem identity and process identity just before unlink
    // to close PID-reuse and competing-O_EXCL intervals without a lease.
    if (!this.writeLockStillMatches(lockPath, observed)) {
      throw this.writeLockRecoveryRequired(characterName);
    }
    if (inspectCareerRootLockOwner(record) !== "exited-or-reused") {
      throw this.writeLockRecoveryRequired(characterName);
    }
    this.unlinkExactObservedWriteLock(characterName, lockPath, observed);
  }

  private acquireWriteLock(characterName: string, rootFence?: HeldCareerRootFence): HeldCareerWriteLock {
    const name = expectIdentityString(characterName, "character name", []);
    const lockPath = this.lockPath(name);
    const token = randomUUID();
    let lock: HeldCareerWriteLock | undefined;
    if (this.inspectFile(lockPath)) {
      if (rootFence) this.recoverExactDeadWriteLock(name, lockPath, rootFence);
      else throw this.writeLockRecoveryRequired(name);
    }

    const lockText = rootFence
      ? serializeCareerRootLockRecord(token, rootFence.currentOwner)
      : token;

    let fd: number | undefined;
    let creationError: unknown;
    try {
      try {
        fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          // Re-inspect the competing leaf so an attacker-controlled reparse is
          // rejected rather than reported as an ordinary busy lock.
          this.inspectFile(lockPath);
          throw this.writeLockRecoveryRequired(name, error);
        }
        throw error;
      }
      this.inspectFile(lockPath);
      writeAll(fd, lockText);
      fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd);
      if (isReparsePoint(opened) || !opened.isFile()) {
        failStorage(`career write lock "${lockPath}" changed before it could be pinned safely`);
      }
      const leaf = this.inspectFile(lockPath);
      if (!leaf || leaf.dev !== opened.dev || leaf.ino !== opened.ino) {
        failStorage(`career write lock "${lockPath}" changed before it could be pinned safely`);
      }
      lock = { path: lockPath, token, device: opened.dev, inode: opened.ino };
    } catch (error) {
      creationError = error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (creationError !== undefined) {
      // A complete owner record can be removed safely. A partial or replaced
      // record stays fail-closed rather than deleting another writer's evidence.
      if (lock) {
        try { this.releaseWriteLock(lock); } catch { /* Preserve creation failure. */ }
      }
      throw creationError;
    }
    if (!lock) throw new Error(`Career write lock for "${name}" could not be pinned`);
    return lock;
  }

  private releaseWriteLock(lock: HeldCareerWriteLock): void {
    const raw = this.readLockToken(lock);
    const record = parseCareerRootLockRecord(raw);
    if ((record ? record.token : raw) !== lock.token) {
      failStorage(`career write lock "${lock.path}" owner token does not match`);
    }
    this.assertHeldLockIdentity(lock);
    try {
      fs.unlinkSync(lock.path);
    } catch (error) {
      if (isEnoent(error)) failStorage(`held career write lock "${lock.path}" disappeared before release`);
      throw error;
    }
  }

  private withWriteLock<T>(characterName: string, operation: () => T, rootFence?: HeldCareerRootFence): T {
    const lock = this.acquireWriteLock(characterName, rootFence);
    let operationError: unknown;
    try {
      return operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        this.releaseWriteLock(lock);
      } catch (releaseError) {
        if (operationError !== undefined) {
          throw new Error("Career write failed and its lock could not be released", {
            cause: new AggregateError([operationError, releaseError]),
          });
        }
        throw releaseError;
      }
    }
  }

  /** Read one root lock through a pinned descriptor and retain its exact bytes. */
  private observeRootWriteLock(lockPath: string): ObservedCareerRootLock | null {
    const inspected = this.inspectRootFile(lockPath);
    if (!inspected) return null;
    let fd: number | undefined;
    try {
      const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
      fd = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd);
      if (
        isReparsePoint(opened)
        || !opened.isFile()
        || opened.dev !== inspected.dev
        || opened.ino !== inspected.ino
      ) {
        failStorage("career root write lock changed before it could be opened safely");
      }
      const raw = this.readBoundedUtf8(fd, MAX_CAREER_LOCK_BYTES, "career root write lock", true);
      const after = this.inspectRootFile(lockPath);
      if (!after || after.dev !== inspected.dev || after.ino !== inspected.ino) {
        failStorage("career root write lock changed while it was being observed");
      }
      return { raw, device: inspected.dev, inode: inspected.ino };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private rootWriteLockStillMatches(lockPath: string, observed: ObservedCareerRootLock): boolean {
    const current = this.inspectRootFile(lockPath);
    if (!current || current.dev !== observed.device || current.ino !== observed.inode) return false;
    let reread: ObservedCareerRootLock | null;
    try {
      reread = this.observeRootWriteLock(lockPath);
    } catch {
      // A concurrent replacement is not a storage authority for us to
      // delete. Preserve it and return the recovery diagnostic instead.
      return false;
    }
    return reread !== null
      && reread.device === observed.device
      && reread.inode === observed.inode
      && reread.raw === observed.raw;
  }

  /** Final raw+dev+ino fence at the unlink boundary; never delete a newcomer. */
  private unlinkExactObservedRootWriteLock(lockPath: string, observed: ObservedCareerRootLock): void {
    if (!this.rootWriteLockStillMatches(lockPath, observed)) {
      throw new CareerRootLockRecoveryRequired();
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (isEnoent(error)) throw new CareerRootLockRecoveryRequired(error);
      throw error;
    }
  }

  /**
   * Reclaim only a record whose former PID+creation identity is proven gone
   * (or has been reused), while holding the same named mutex that all normal
   * root operations hold. Every failure leaves the leaf in place.
   */
  private recoverExactDeadRootWriteLock(lockPath: string, fence: CareerRootFenceAttempt): void {
    if (fence.kind !== "held") throw new CareerRootLockRecoveryRequired();
    const observed = this.observeRootWriteLock(lockPath);
    if (!observed) throw new CareerRootLockRecoveryRequired();
    const record = parseCareerRootLockRecord(observed.raw);
    if (!record || inspectCareerRootLockOwner(record) !== "exited-or-reused") {
      throw new CareerRootLockRecoveryRequired();
    }
    // Process state and leaf identity are both rechecked immediately before
    // unlink. This rejects PID races and any competing O_EXCL creator rather
    // than treating the mutex as permission to delete arbitrary evidence.
    if (!this.rootWriteLockStillMatches(lockPath, observed)) {
      throw new CareerRootLockRecoveryRequired();
    }
    if (inspectCareerRootLockOwner(record) !== "exited-or-reused") {
      throw new CareerRootLockRecoveryRequired();
    }
    this.unlinkExactObservedRootWriteLock(lockPath, observed);
  }

  /**
   * One root fence serializes active-pointer publication with every conforming
   * reader and writer.  Character locks still protect legacy/direct leaves;
   * this fence prevents a writer from completing against a version that is
   * being retired underneath it.
   */
  private acquireRootWriteLock(fence: CareerRootFenceAttempt): HeldCareerWriteLock {
    const lockPath = this.rootChildPath(CAREER_ROOT_WRITE_LOCK_FILE);
    const token = randomUUID();
    if (this.inspectRootFile(lockPath)) {
      this.recoverExactDeadRootWriteLock(lockPath, fence);
    }
    const lockText = fence.kind === "held"
      ? serializeCareerRootLockRecord(token, fence.currentOwner)
      : token;
    let fd: number | undefined;
    let lock: HeldCareerWriteLock | undefined;
    let creationError: unknown;
    try {
      try {
        fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          this.inspectRootFile(lockPath);
          throw new CareerRootLockRecoveryRequired(error);
        }
        throw error;
      }
      this.inspectRootFile(lockPath);
      writeAll(fd, lockText);
      fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd);
      if (isReparsePoint(opened) || !opened.isFile()) {
        failStorage("career root write lock changed before it could be pinned safely");
      }
      const leaf = this.inspectRootFile(lockPath);
      if (!leaf || leaf.dev !== opened.dev || leaf.ino !== opened.ino) {
        failStorage("career root write lock changed before it could be pinned safely");
      }
      lock = { path: lockPath, token, device: opened.dev, inode: opened.ino };
    } catch (error) {
      creationError = error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (creationError !== undefined) {
      if (lock) {
        try { this.releaseRootWriteLock(lock); } catch { /* Preserve creation failure. */ }
      }
      throw creationError;
    }
    if (!lock) throw new Error("Career root write lock could not be pinned");
    return lock;
  }

  private releaseRootWriteLock(lock: HeldCareerWriteLock): void {
    const observed = this.observeRootWriteLock(lock.path);
    if (!observed || observed.device !== lock.device || observed.inode !== lock.inode) {
      failStorage("career root write lock was replaced or disappeared before release");
    }
    const record = parseCareerRootLockRecord(observed.raw);
    // Unsupported environments retain their opaque token, but a supported
    // Windows fixed-volume root releases the exact auditable record it made.
    if ((record ? record.token : observed.raw) !== lock.token) {
      failStorage("career root write lock owner token does not match");
    }
    if (!this.rootWriteLockStillMatches(lock.path, observed)) {
      failStorage("career root write lock was replaced before release");
    }
    try {
      fs.unlinkSync(lock.path);
    } catch (error) {
      if (isEnoent(error)) failStorage("career root write lock disappeared before release");
      throw error;
    }
  }

  /** Release the kernel fence after the raw root lock cleanup has been tried. */
  private releaseRootFence(fence: CareerRootFenceAttempt): void {
    if (fence.kind === "held") fence.mutex.release();
  }

  private withRootWriteLock<T>(operation: (rootFence: HeldCareerRootFence | undefined) => T): T {
    if (!this.managedProjectionLayout) return operation(undefined);
    const fence = tryAcquireCareerRootFence(this.baseDir);
    if (fence.kind === "busy" || fence.kind === "unavailable") {
      throw new CareerRootLockRecoveryRequired();
    }
    let lock: HeldCareerWriteLock;
    try {
      lock = this.acquireRootWriteLock(fence);
    } catch (acquisitionError) {
      try {
        this.releaseRootFence(fence);
      } catch (mutexReleaseError) {
        throw new Error("Career root lock acquisition failed and its mutex could not be released", {
          cause: new AggregateError([acquisitionError, mutexReleaseError]),
        });
      }
      throw acquisitionError;
    }

    let result: T | undefined;
    let hasOperationError = false;
    let operationError: unknown;
    try {
      // Resolve once while all conforming readers/writers are fenced.  Every
      // nested file operation uses this directory rather than re-reading a
      // pointer that may be replaced after this operation returns.
      this.pinnedActiveDirectory = this.activeCareerDirectory();
      result = operation(fence.kind === "held" ? fence : undefined);
    } catch (error) {
      hasOperationError = true;
      operationError = error;
    } finally {
      this.pinnedActiveDirectory = undefined;
    }

    let hasRootReleaseError = false;
    let rootReleaseError: unknown;
    try {
      this.releaseRootWriteLock(lock);
    } catch (error) {
      hasRootReleaseError = true;
      rootReleaseError = error;
    }

    let hasMutexReleaseError = false;
    let mutexReleaseError: unknown;
    try {
      this.releaseRootFence(fence);
    } catch (error) {
      // A mutex-release error is an indeterminate cleanup result. Do not let
      // it hide a preceding operation or raw-lock release error; surface all
      // causes so callers fail closed and operators retain the primary fault.
      hasMutexReleaseError = true;
      mutexReleaseError = error;
    }

    const errors: unknown[] = [];
    if (hasOperationError) errors.push(operationError);
    if (hasRootReleaseError) errors.push(rootReleaseError);
    if (hasMutexReleaseError) errors.push(mutexReleaseError);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new Error(
        hasOperationError
          ? "Career root operation failed and cleanup could not complete"
          : "Career root lock cleanup failed",
        { cause: new AggregateError(errors) },
      );
    }
    return result as T;
  }

  /**
   * Read no more than the requested byte bound from an already-open regular
   * file. The second fstat detects growth or truncation during the read; the
   * caller still pins pathname identity around the open/close boundary.
   */
  private readBoundedUtf8(fd: number, maximumBytes: number, context: string, zeroed = false): string {
    const before = fs.fstatSync(fd);
    if (isReparsePoint(before) || !before.isFile()) {
      failStorage(`${context} changed before its bounded read`);
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximumBytes) {
      failStorage(`${context} exceeds the ${maximumBytes}-byte resource limit`);
    }

    // One byte beyond the size observed by fstat is enough to distinguish an
    // append from the pinned file. The post-read fstat still rejects growth
    // that races after that extra byte, without allocating 2 MiB per tiny
    // lock or Career file during enumeration.
    const bytes = zeroed
      ? Buffer.alloc(Math.min(maximumBytes + 1, before.size + 1))
      : Buffer.allocUnsafe(Math.min(maximumBytes + 1, before.size + 1));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (read === 0) break;
      offset += read;
    }

    const after = fs.fstatSync(fd);
    if (
      isReparsePoint(after)
      || !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || !Number.isSafeInteger(after.size)
      || after.size < 0
      || after.size > maximumBytes
      || after.size !== offset
      || offset > maximumBytes
    ) {
      failStorage(`${context} changed or exceeded its ${maximumBytes}-byte resource limit while reading`);
    }
    // Buffer#toString replaces malformed sequences with U+FFFD, which could
    // turn hostile bytes into a different valid JSON document. Preserve the
    // legacy BOM behavior while making every malformed UTF-8 sequence fatal.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset));
  }

  /** ENOENT is the sole absence case. Parse, schema, and read failures surface. */
  private readParsedFile(filePath: string): unknown | null {
    const inspected = this.inspectFile(filePath);
    if (!inspected) return null;
    let fd: number | undefined;
    let raw: string;
    try {
      // O_NOFOLLOW closes the lstat/open race on platforms that implement it.
      // Windows exposes no equivalent no-follow open through Node/Bun, so the
      // pre-open lstat remains a best-effort boundary there.
      const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd);
      if (
        isReparsePoint(opened)
        || !opened.isFile()
        || opened.dev !== inspected.dev
        || opened.ino !== inspected.ino
      ) {
        failStorage(`career file "${filePath}" changed before it could be opened safely`);
      }
      raw = this.readBoundedUtf8(fd, MAX_CAREER_JSON_BYTES, `career file "${filePath}"`);
      const after = this.inspectFile(filePath);
      if (!after || after.dev !== opened.dev || after.ino !== opened.ino) {
        failStorage(`career file "${filePath}" changed while it was being read`);
      }
    } catch (error) {
      if (isEnoent(error)) return null;
      throw new Error(`Could not read career file "${filePath}"`, { cause: error });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Career file "${filePath}" contains invalid JSON`, { cause: error });
    }
  }

  private readFile(characterName: string): CareerFile | null {
    const filePath = this.filePath(characterName);
    const parsed = this.readParsedFile(filePath);
    return parsed === null ? null : normalizeCareerFile(parsed, characterName);
  }

  /**
   * Prepare an exact successor before entering the leaf write primitive. The
   * caller already holds the root and character fences, so the timestamp can
   * serve as part of the successor identity without racing another conforming
   * writer. Never reuse the predecessor timestamp: an error before rename
   * must not be mistaken for a published identical record.
   */
  private prepareAtomicWrite(characterName: string, data: CareerFile): CareerFile {
    const observed = this.readFile(characterName);
    const occupied = new Set<string>();
    if (typeof data.updatedAt === "string") occupied.add(data.updatedAt);
    if (observed) occupied.add(observed.updatedAt);
    let updatedAt = new Date().toISOString();
    while (occupied.has(updatedAt)) updatedAt = new Date(Date.parse(updatedAt) + 1).toISOString();
    return normalizeCareerFile({ ...data, updatedAt }, characterName);
  }

  /** `updatedAt` and every normalized record field bind a retry to this exact leaf successor. */
  private sameCareerFile(left: CareerFile, right: CareerFile): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /**
   * Reconcile only a possible post-publication error while the caller still
   * owns the Career root/leaf fences. A missing or different leaf preserves
   * the original failure; no cleanup, retry, or rollback can touch a possible
   * third-party successor.
   */
  private writeAtomicWithReadback(characterName: string, data: CareerFile): void {
    const prepared = this.prepareAtomicWrite(characterName, data);
    try {
      this.atomicWrite(characterName, prepared);
    } catch (error) {
      try {
        const observed = this.readFile(characterName);
        if (observed !== null && this.sameCareerFile(observed, prepared)) return;
      } catch {
        // The storage failure remains authoritative when readback cannot bind
        // the target safely or classify its exact successor identity.
      }
      throw error;
    }
  }

  /**
   * Replace one leaf through a private flushed temp file. The caller holds the
   * root fence (and normally the character fence); multi-leaf restore uses a
   * staged projection plus the root-local pointer, not this primitive alone.
   * `data` is already the exact prepared successor so error readback can
   * compare all persisted fields, including `updatedAt`.
   */
  private atomicWrite(characterName: string, data: CareerFile): void {
    const target = this.filePath(characterName);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const prepared = normalizeCareerFile(data, characterName);
    let text: string;
    try {
      text = JSON.stringify(prepared, null, 2);
    } catch (error) {
      throw new Error(`Could not serialize career file for "${characterName}"`, { cause: error });
    }
    if (Buffer.byteLength(text, "utf8") > MAX_CAREER_JSON_BYTES) {
      invalid(`career file for "${characterName}"`, `exceeds the ${MAX_CAREER_JSON_BYTES}-byte resource limit`);
    }

    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      this.inspectFile(temp);
      writeAll(fd, text);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (this.filePath(characterName) !== target) {
        failStorage(`career file selection changed while writing "${characterName}"`);
      }
      this.inspectFile(target);
      this.assertSafeRoot();
      fs.renameSync(temp, target);
      this.assertSafeRoot();
      syncCareerDirectory(path.dirname(target));
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* Preserve the storage failure. */ }
      }
      // This temp name was generated for this write and opened exclusively; do
      // not touch the target (or another writer's temp) while recovering.
      try { fs.unlinkSync(temp); } catch (cleanupError) {
        if (!isEnoent(cleanupError)) { /* Preserve the original storage failure. */ }
      }
      throw error;
    }
  }

  /** Atomically replace one small root-control file; callers hold the root fence. */
  private atomicWriteRootControlFile(name: string, text: string, maximumBytes = MAX_CAREER_CONTROL_BYTES): void {
    const target = this.rootChildPath(name);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      invalid("career root control file", `exceeds the ${maximumBytes}-byte resource limit`);
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      this.inspectRootFile(temp);
      writeAll(fd, text);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      this.inspectRootFile(target);
      this.assertSafeRoot();
      fs.renameSync(temp, target);
      this.assertSafeRoot();
      syncCareerDirectory(this.baseDir);
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* Preserve the control-file failure. */ }
      }
      try { fs.unlinkSync(temp); } catch (cleanupError) {
        if (!isEnoent(cleanupError)) { /* The unpublished temp is never authority. */ }
      }
      throw error;
    }
  }

  /** Remove only the pinned root-local control leaf while holding the root fence. */
  private deleteRootControlFile(name: string): void {
    const target = this.rootChildPath(name);
    const inspected = this.inspectRootFile(target);
    if (!inspected) return;
    this.assertSafeRoot();
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (isEnoent(error)) failStorage(`career root control file "${name}" disappeared before removal`);
      throw error;
    }
    this.assertSafeRoot();
    syncCareerDirectory(this.baseDir);
  }

  /** Parse and verify a completed direct-child stage before it is eligible for reclamation. */
  private completedProjectionStageIdentity(name: string): CareerPortableProjectionIdentity {
    return { version: name, projectionHash: this.completedProjectionDirectoryHash(this.projectionVersionDirectory(name)) };
  }

  /** The retired name retains the exact former authority version for fencing. */
  private retiredProjectionSourceVersion(name: string): string {
    const source = /^retired-(projection-.+)$/i.exec(name)?.[1];
    if (!source || !CAREER_PROJECTION_STAGE_ID.test(source)) {
      failStorage("career projection retired directory does not retain an exact source version");
    }
    return source;
  }

  private completedProjectionDirectoryHash(directory: string): string {
    const stageStore = new CareerFileStore(directory, CAREER_INTERNAL_STAGE_TOKEN);
    const completion = stageStore.readRootControlJson(
      CAREER_PROJECTION_COMPLETION_FILE,
      "career projection completion manifest",
    );
    if (!isRecord(completion)) invalid("career projection completion manifest", "must be an object");
    expectExactKeys(completion, ["version", "projectionHash"], "career projection completion manifest");
    if (
      completion.version !== CAREER_PROJECTION_POINTER_VERSION
      || typeof completion.projectionHash !== "string"
      || !/^[a-f0-9]{64}$/.test(completion.projectionHash)
    ) {
      invalid("career projection completion manifest", "has an unsupported version or projection hash");
    }
    this.assertCompletedProjectionDirectory(directory, completion.projectionHash);
    return completion.projectionHash;
  }

  private projectionProtection(): { stages: Map<string, string>; fingerprint: string } {
    const stages = new Map<string, string>();
    const protect = (identity: CareerPortableProjectionIdentity, context: string): void => {
      const existing = stages.get(identity.version);
      if (existing !== undefined && existing !== identity.projectionHash) {
        failStorage(`${context} conflicts with another protected career projection stage`);
      }
      // A pending journal never authorizes cleanup by name alone: both of
      // its identities must still resolve to their exact completed stages.
      this.assertCompletedProjectionVersion(identity.version, identity.projectionHash);
      stages.set(identity.version, identity.projectionHash);
    };
    const active = this.readActiveProjectionPointer();
    if (active !== null) protect({ version: active.active, projectionHash: active.projectionHash }, "career projection pointer");
    const journal = this.readOrdinaryProjectionCommitRecord();
    if (journal !== null) {
      protect(journal.predecessor, "ordinary Career projection commit predecessor");
      protect(journal.successor, "ordinary Career projection commit successor");
    }
    return { stages, fingerprint: JSON.stringify({ active, journal }) };
  }

  /** Inspect only direct regular leaves before recovering an inert namespace. */
  private recoverableProjectionDirectoryBytes(
    name: string,
    kind: "building" | "retired",
  ): number {
    const directory = kind === "building"
      ? this.projectionBuildingDirectory(name)
      : this.projectionRetiredDirectory(name);
    const original = fs.lstatSync(directory);
    if (isReparsePoint(original) || !original.isDirectory()) {
      failStorage(`career projection ${kind} recovery target is not a real directory`);
    }
    let leaves = 0;
    let bytes = 0;
    let handle: Pick<fs.Dir, "readSync" | "closeSync"> | undefined;
    try {
      handle = fs.opendirSync(directory);
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (++leaves > MAX_CAREER_PROJECTION_RECOVERY_LEAVES) {
          failStorage(`career projection ${kind} recovery target exceeds its leaf limit`);
        }
        const leaf = path.join(directory, entry.name);
        if (path.dirname(leaf) !== directory) failStorage(`career projection ${kind} recovery leaf is not a direct child`);
        const stat = fs.lstatSync(leaf);
        if (isReparsePoint(stat) || !stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
          failStorage(`career projection ${kind} recovery refuses a non-regular or invalid-size leaf`);
        }
        bytes += stat.size;
        if (!Number.isSafeInteger(bytes) || bytes > MAX_CAREER_PROJECTION_RECOVERY_BYTES) {
          failStorage(`career projection ${kind} recovery target exceeds its byte limit`);
        }
      }
    } finally {
      if (handle !== undefined) handle.closeSync();
    }
    const after = fs.lstatSync(directory);
    if (isReparsePoint(after) || !after.isDirectory() || after.dev !== original.dev || after.ino !== original.ino) {
      failStorage(`career projection ${kind} recovery target changed while it was inspected`);
    }
    return bytes;
  }

  /** Testable tiny seam; a process kill here leaves only a retired namespace. */
  private unlinkRetiredProjectionLeaf(leaf: string): void {
    fs.unlinkSync(leaf);
  }

  private removeRecoverableProjectionDirectory(name: string, kind: "building" | "retired"): void {
    const directory = kind === "building"
      ? this.projectionBuildingDirectory(name)
      : this.projectionRetiredDirectory(name);
    // Reinspect immediately before unlink: recovery never traverses an
    // unbounded, replaced, or reparse-bearing tree.
    this.recoverableProjectionDirectoryBytes(name, kind);
    const original = fs.lstatSync(directory);
    let handle: Pick<fs.Dir, "readSync" | "closeSync"> | undefined;
    try {
      handle = fs.opendirSync(directory);
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        const leaf = path.join(directory, entry.name);
        if (path.dirname(leaf) !== directory) failStorage(`career projection ${kind} cleanup leaf is not a direct child`);
        const stat = fs.lstatSync(leaf);
        if (isReparsePoint(stat) || !stat.isFile()) {
          failStorage(`career projection ${kind} cleanup refuses a non-regular leaf`);
        }
        if (kind === "retired") this.unlinkRetiredProjectionLeaf(leaf);
        else fs.unlinkSync(leaf);
      }
    } finally {
      if (handle !== undefined) handle.closeSync();
    }
    const beforeRmdir = fs.lstatSync(directory);
    if (
      isReparsePoint(beforeRmdir)
      || !beforeRmdir.isDirectory()
      || beforeRmdir.dev !== original.dev
      || beforeRmdir.ino !== original.ino
    ) {
      failStorage(`career projection ${kind} cleanup target changed before removal`);
    }
    fs.rmdirSync(directory);
    syncCareerDirectory(this.projectionContainerPath());
  }

  /**
   * Reclaim only complete, unreferenced stage directories while the caller
   * already owns the root fence. Root locks themselves are never recovered:
   * this code is unreachable until an operator has independently established
   * that a previous lock owner exited and removed that exact lock.
   */
  private reclaimUnreferencedProjectionStages(): string {
    const container = this.ensureProjectionContainer();
    const before = this.projectionProtection();
    const removable: CareerPortableProjectionIdentity[] = [];
    const buildings: string[] = [];
    const retired: string[] = [];
    let buildingBytes = 0;
    let retiredBytes = 0;
    let handle: Pick<fs.Dir, "readSync" | "closeSync"> | undefined;
    try {
      handle = fs.opendirSync(container);
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (CAREER_PROJECTION_BUILDING_STAGE_ID.test(entry.name)) {
          if (buildings.length >= MAX_CAREER_PROJECTION_BUILDING_STAGES) {
            failStorage(`career projection building namespace retains ${MAX_CAREER_PROJECTION_BUILDING_STAGES} stages; explicit cleanup is required`);
          }
          buildingBytes += this.recoverableProjectionDirectoryBytes(entry.name, "building");
          if (!Number.isSafeInteger(buildingBytes) || buildingBytes > MAX_CAREER_PROJECTION_RECOVERY_BYTES) {
            failStorage("career projection building namespace exceeds its recovery byte limit");
          }
          buildings.push(entry.name);
          continue;
        }
        if (CAREER_PROJECTION_RETIRED_STAGE_ID.test(entry.name)) {
          if (retired.length >= MAX_CAREER_PROJECTION_RETIRED_STAGES) {
            failStorage(`career projection retired namespace retains ${MAX_CAREER_PROJECTION_RETIRED_STAGES} stages; explicit cleanup is required`);
          }
          const source = this.retiredProjectionSourceVersion(entry.name);
          if (before.stages.has(source)) {
            failStorage("protected career projection stage was found in the retired namespace");
          }
          retiredBytes += this.recoverableProjectionDirectoryBytes(entry.name, "retired");
          if (!Number.isSafeInteger(retiredBytes) || retiredBytes > MAX_CAREER_PROJECTION_RECOVERY_BYTES) {
            failStorage("career projection retired namespace exceeds its recovery byte limit");
          }
          retired.push(entry.name);
          continue;
        }
        if (!CAREER_PROJECTION_STAGE_ID.test(entry.name)) {
          failStorage("career projection version root contains an unknown entry");
        }
        const candidate = path.join(container, entry.name);
        if (path.dirname(candidate) !== container) failStorage("career projection cleanup candidate is not a direct child");
        const stat = fs.lstatSync(candidate);
        if (isReparsePoint(stat) || !stat.isDirectory()) {
          failStorage("career projection version root contains a non-directory or reparse entry");
        }
        const identity = this.completedProjectionStageIdentity(entry.name);
        const protectedHash = before.stages.get(identity.version);
        if (protectedHash !== undefined) {
          if (protectedHash !== identity.projectionHash) {
            failStorage("protected career projection stage changed during cleanup");
          }
          continue;
        }
        removable.push(identity);
      }
    } finally {
      if (handle !== undefined) handle.closeSync();
    }
    for (const name of buildings) {
      const current = this.projectionProtection();
      if (current.fingerprint !== before.fingerprint) {
        failStorage("career projection protection changed before building recovery");
      }
      this.removeRecoverableProjectionDirectory(name, "building");
    }
    for (const retiredName of retired) {
      const current = this.projectionProtection();
      if (current.fingerprint !== before.fingerprint || current.stages.has(this.retiredProjectionSourceVersion(retiredName))) {
        failStorage("career projection protection changed before retired recovery");
      }
      this.removeRecoverableProjectionDirectory(retiredName, "retired");
    }
    for (const orphan of removable) {
      const current = this.projectionProtection();
      if (current.fingerprint !== before.fingerprint || current.stages.get(orphan.version) !== undefined) {
        failStorage("career projection protection changed before orphan cleanup");
      }
      this.removeProjectionStage(orphan.version);
    }
    return this.assertProjectionContainer();
  }

  private createProjectionStage(): { name: string; directory: string } {
    // This runs only from managed writers beneath withRootWriteLock. Any
    // cleanup refusal happens before a new stage, pointer, or journal exists.
    const container = this.reclaimUnreferencedProjectionStages();
    let count = 0;
    let handle: Pick<fs.Dir, "readSync" | "closeSync"> | undefined;
    try {
      handle = fs.opendirSync(container);
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (CAREER_PROJECTION_STAGE_ID.test(entry.name) && ++count >= MAX_CAREER_PROJECTION_VERSIONS) {
          failStorage(`career projection version root retains ${MAX_CAREER_PROJECTION_VERSIONS} versions; explicit cleanup is required`);
        }
      }
    } finally {
      if (handle !== undefined) handle.closeSync();
    }
    const name = `${CAREER_PROJECTION_BUILDING_STAGE_PREFIX}${randomUUID()}`;
    const directory = path.join(container, name);
    if (path.dirname(directory) !== container) failStorage("career projection stage is not a direct child of its pinned container");
    fs.mkdirSync(directory, { mode: 0o700 });
    this.projectionBuildingDirectory(name);
    syncCareerDirectory(container);
    return { name, directory };
  }

  /** Atomically hide an unreferenced completed version before unlinking leaves. */
  private removeProjectionStage(name: string): void {
    const protection = this.projectionProtection();
    if (protection.stages.has(name)) failStorage("refusing to retire an active or journal-protected career projection version");
    this.completedProjectionStageIdentity(name);
    const directory = this.projectionVersionDirectory(name);
    const container = this.projectionContainerPath();
    const retiredName = `${CAREER_PROJECTION_RETIRED_STAGE_PREFIX}${name}`;
    const retired = path.join(container, retiredName);
    if (path.dirname(retired) !== container) failStorage("career projection retired target is not a direct child");
    try {
      fs.lstatSync(retired);
      failStorage("career projection retired target already exists; explicit recovery is required");
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    this.assertSafeRoot();
    fs.renameSync(directory, retired);
    this.assertSafeRoot();
    syncCareerDirectory(container);
    this.removeRecoverableProjectionDirectory(retiredName, "retired");
  }

  /**
   * Build and verify every leaf away from the visible layout. The returned
   * immutable stage can be named durably before a second store commits, so a
   * crash never needs to infer a successor identity from content alone.
   */
  private stagePortableProjection(projection: CareerPortableProjection): CareerPortableProjectionIdentity {
    const stage = this.createProjectionStage();
    let published = false;
    try {
      const stageStore = new CareerFileStore(stage.directory, CAREER_INTERNAL_STAGE_TOKEN);
      stageStore.replacePortableProjection(projection);
      const installed = stageStore.exportPortableProjectionUnlocked();
      if (JSON.stringify(installed) !== JSON.stringify(projection)) {
        throw new Error("Career portable projection staging verification failed");
      }
      const projectionHash = portableProjectionHash(installed);
      const completion: CareerProjectionCompletion = {
        version: CAREER_PROJECTION_POINTER_VERSION,
        projectionHash,
      };
      stageStore.atomicWriteRootControlFile(CAREER_PROJECTION_COMPLETION_FILE, JSON.stringify(completion));
      // Verify the completion document and exact leaf set before it can be
      // named by an ordinary prepared record or a visible pointer.
      this.assertCompletedProjectionDirectory(this.projectionBuildingDirectory(stage.name), projectionHash);
      const name = `${CAREER_PROJECTION_STAGE_PREFIX}${stage.name.slice(CAREER_PROJECTION_BUILDING_STAGE_PREFIX.length)}`;
      const target = path.join(this.projectionContainerPath(), name);
      if (path.dirname(target) !== this.projectionContainerPath()) failStorage("career projection publication target is not a direct child");
      try {
        fs.lstatSync(target);
        failStorage("career projection publication target already exists");
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      this.assertSafeRoot();
      fs.renameSync(stage.directory, target);
      this.assertSafeRoot();
      // This is a same-filesystem directory rename. syncCareerDirectory is a
      // best-effort directory durability fence on Windows, whose APIs cannot
      // promise POSIX-style power-loss persistence for directory metadata.
      syncCareerDirectory(this.projectionContainerPath());
      this.assertCompletedProjectionVersion(name, projectionHash);
      published = true;
      return { version: name, projectionHash };
    } catch (error) {
      if (!published) {
        try { this.removeRecoverableProjectionDirectory(stage.name, "building"); } catch { /* A crash-visible building residual is recoverable later. */ }
      }
      throw error;
    }
  }

  /** Caller holds the root fence and has already compared its predecessor. */
  private activateStagedProjection(successor: CareerPortableProjectionIdentity): void {
    const previous = this.readActiveProjectionName();
    this.validatePortableProjectionIdentity(successor, "Career projection successor");
    this.assertCompletedProjectionVersion(successor.version, successor.projectionHash);
    const pointer: CareerProjectionPointer = {
      version: CAREER_PROJECTION_POINTER_VERSION,
      active: successor.version,
      projectionHash: successor.projectionHash,
    };
    try {
      this.atomicWriteRootControlFile(CAREER_PROJECTION_POINTER_FILE, JSON.stringify(pointer));
    } catch (error) {
      // The pointer write can report after persistence. Preserve the staged
      // version if it might now be authority; callers re-read on recovery.
      try {
        if (this.readActiveProjectionName() !== successor.version) throw error;
      } catch { throw error; }
    }
    if (previous !== null) {
      try { this.removeProjectionStage(previous); } catch { /* Retention cleanup never changes the active pointer. */ }
    }
  }

  /** Build then atomically publish one ordinary non-transactional successor. */
  private publishPortableProjection(projection: CareerPortableProjection): void {
    const successor = this.stagePortableProjection(projection);
    this.activateStagedProjection(successor);
  }

  /** Delete one validated file while holding its per-character write lock. */
  private deleteFile(characterName: string): void {
    const target = this.filePath(characterName);
    if (!this.inspectFile(target)) return;
    try {
      this.assertSafeRoot();
      fs.unlinkSync(target);
      this.assertSafeRoot();
      syncCareerDirectory(path.dirname(target));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  /** Keep directory enumeration streaming while retaining at most the root cap. */
  private openCareerDirectory(): Pick<fs.Dir, "readSync" | "closeSync"> {
    return fs.opendirSync(this.activeCareerDirectory());
  }

  private readOrCreate(characterName: string): CareerFile {
    return this.readFile(characterName) ?? {
      version: 1,
      base: null,
      entries: [],
      updatedAt: "",
    };
  }

  /** The root fence is held by callers; active generations are immutable. */
  private mutatePublishedProjection(mutate: (records: CareerPortableRecord[]) => boolean): void {
    const projection = this.exportPortableProjectionUnlocked();
    if (!mutate(projection.records)) return;
    this.publishPortableProjection(validateCareerPortableProjection(projection));
  }

  saveSnapshot(snapshot: CharacterSnapshot): void {
    const normalizedSnapshot = normalizeSnapshot(snapshot, "CharacterSnapshot input");
    this.withRootWriteLock((rootFence) => {
      this.assertNoPendingOrdinaryProjectionCommitUnlocked();
      if (this.readActiveProjectionName() !== null) {
        this.mutatePublishedProjection((records) => {
          const existing = records.find((record) => record.characterName === normalizedSnapshot.characterName);
          if (existing) existing.base = structuredClone(normalizedSnapshot);
          else records.push({ characterName: normalizedSnapshot.characterName, base: structuredClone(normalizedSnapshot), entries: [] });
          return true;
        });
        return;
      }
      this.withWriteLock(normalizedSnapshot.characterName, () => {
        const file = this.readOrCreate(normalizedSnapshot.characterName);
        file.base = normalizedSnapshot;
        this.writeAtomicWithReadback(normalizedSnapshot.characterName, file);
      }, rootFence);
    });
  }

  getSnapshot(characterName: string): CharacterSnapshot | null {
    return this.withRootWriteLock(() => this.readFile(characterName)?.base ?? null);
  }

  deleteSnapshot(characterName: string): void {
    this.withRootWriteLock((rootFence) => {
      this.assertNoPendingOrdinaryProjectionCommitUnlocked();
      if (this.readActiveProjectionName() !== null) {
        this.mutatePublishedProjection((records) => {
          const index = records.findIndex((record) => record.characterName === characterName);
          if (index < 0) return false;
          records.splice(index, 1);
          return true;
        });
        return;
      }
      this.withWriteLock(characterName, () => this.deleteFile(characterName), rootFence);
    });
  }

  /** Stream, validate, and bind every Career leaf while retaining root capacity evidence. */
  private inspectRootInventory(): CareerRootInventory {
    const activeDirectory = this.activeCareerDirectory();
    const characters: string[] = [];
    const physicalLeafByCharacter = new Map<string, string>();
    const files: string[] = [];
    let directory: Pick<fs.Dir, "readSync" | "closeSync"> | undefined;
    let rootEntryCount = 0;
    try {
      directory = this.openCareerDirectory();
      for (let file = directory.readSync(); file !== null; file = directory.readSync()) {
        // Root-fence and publication metadata are not Career leaves. They are
        // excluded from the logical root budget, while arbitrary debris still
        // consumes it and therefore fails closed.
        const rootControl = activeDirectory === this.baseDir && [
          CAREER_ROOT_WRITE_LOCK_FILE,
          CAREER_PROJECTION_POINTER_FILE,
          CAREER_PROJECTION_VERSIONS_DIRECTORY,
          CAREER_ORDINARY_PROJECTION_COMMIT_FILE,
        ].includes(file.name);
        if (rootControl || file.name === CAREER_PROJECTION_COMPLETION_FILE) continue;
        rootEntryCount += 1;
        if (rootEntryCount > MAX_CAREER_ROOT_ENTRIES) {
          failStorage(`career root exceeds the ${MAX_CAREER_ROOT_ENTRIES}-entry resource limit`);
        }
        if (!file.name.endsWith(".career.json")) continue;
        files.push(file.name);
      }
    } finally {
      if (directory !== undefined) directory.closeSync();
    }
    for (const file of files) {
      const filePath = path.join(activeDirectory, file);
      const parsed = this.readParsedFile(filePath);
      if (parsed === null) continue; // A concurrent deletion is an absent file.
      if (!isRecord(parsed)) invalid(`career file "${filePath}"`, "root must be an object");
      const base = parsed.base;
      const entries = parsed.entries;
      const identityCandidate = isRecord(base) && typeof base.characterName === "string"
        ? base.characterName
        : Array.isArray(entries) && isRecord(entries[0]) && typeof entries[0].characterName === "string"
          ? entries[0].characterName
          : undefined;
      if (identityCandidate === undefined) {
        invalid(`career file "${filePath}"`, "cannot derive a character identity from an empty file");
      }
      const identity = expectIdentityString(identityCandidate, `career file "${filePath}" identity`, []);
      if (this.filePath(identity) !== filePath) {
        invalid(`career file "${filePath}"`, "content identity does not match its file name");
      }
      const normalized = normalizeCareerFile(parsed, identity);
      if (physicalLeafByCharacter.has(identity)) {
        invalid(`career file "${filePath}"`, `duplicates character identity "${identity}"`);
      }
      physicalLeafByCharacter.set(identity, filePath);
      if (normalized.base) characters.push(normalized.base.characterName);
      else if (normalized.entries[0]) characters.push(normalized.entries[0].characterName);
      else characters.push(identity);
    }
    return { characters, rootEntryCount, physicalLeafByCharacter };
  }

  listCharacters(): string[] {
    return this.withRootWriteLock(() => this.inspectRootInventory().characters);
  }

  /** Caller holds the root fence when the managed layout is active. */
  private exportPortableProjectionUnlocked(): CareerPortableProjection {
    const records = this.inspectRootInventory().characters
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((characterName) => {
        const file = this.readFile(characterName);
        if (!file) throw new Error(`Career record for "${characterName}" disappeared during portable export`);
        return {
          characterName,
          base: file.base === null ? null : structuredClone(file.base),
          entries: structuredClone(file.entries),
        };
      });
    return validateCareerPortableProjection({ version: CAREER_PORTABLE_PROJECTION_VERSION, records });
  }

  /** Export every session-root Career file as canonical portable domain data. */
  exportPortableProjection(): CareerPortableProjection {
    return this.withRootWriteLock(() => this.exportPortableProjectionUnlocked());
  }

  /** The caller holds the root fence; direct roots are promoted before CAS. */
  private currentPortableProjectionIdentityUnlocked(): CareerPortableProjectionIdentity {
    let pointer = this.readActiveProjectionPointer();
    if (pointer === null) {
      // A content hash alone cannot distinguish A -> B -> A. Promote the
      // legacy direct layout before handing out an ordinary transaction
      // predecessor so every future write has a fresh immutable stage ID.
      this.publishPortableProjection(this.exportPortableProjectionUnlocked());
      pointer = this.readActiveProjectionPointer();
    }
    if (pointer === null) throw new Error("Career projection identity could not be established");
    return { version: pointer.active, projectionHash: pointer.projectionHash };
  }

  private samePortableProjectionIdentity(
    left: CareerPortableProjectionIdentity,
    right: CareerPortableProjectionIdentity,
  ): boolean {
    return left.version === right.version && left.projectionHash === right.projectionHash;
  }

  private validatePortableProjectionIdentity(
    value: unknown,
    context: string,
  ): CareerPortableProjectionIdentity {
    if (!isRecord(value)) invalid(context, "must be an object");
    expectExactKeys(value, ["version", "projectionHash"], context);
    if (typeof value.version !== "string" || !CAREER_PROJECTION_STAGE_ID.test(value.version)
      || typeof value.projectionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.projectionHash)) {
      invalid(context, "is not a managed Career projection identity");
    }
    return { version: value.version, projectionHash: value.projectionHash };
  }

  private validateOrdinaryProjectionCommitRecord(value: unknown): CareerOrdinaryProjectionCommitRecord {
    if (!isRecord(value)) invalid("ordinary Career projection commit", "must be an object");
    expectExactKeys(value, ["version", "sessionId", "predecessorGeneration", "predecessorEnvelopeHash", "generation", "envelopeHash", "predecessor", "successor"], "ordinary Career projection commit");
    if (value.version !== 1 || typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)
      || typeof value.predecessorGeneration !== "number" || !Number.isSafeInteger(value.predecessorGeneration) || value.predecessorGeneration < 0
      || typeof value.predecessorEnvelopeHash !== "string" || !/^[a-f0-9]{64}$/.test(value.predecessorEnvelopeHash)
      || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1
      || value.generation !== value.predecessorGeneration + 1
      || typeof value.envelopeHash !== "string" || !/^[a-f0-9]{64}$/.test(value.envelopeHash)) {
      invalid("ordinary Career projection commit", "has an invalid authority binding");
    }
    return {
      version: 1,
      sessionId: value.sessionId,
      predecessorGeneration: value.predecessorGeneration,
      predecessorEnvelopeHash: value.predecessorEnvelopeHash,
      generation: value.generation,
      envelopeHash: value.envelopeHash,
      predecessor: this.validatePortableProjectionIdentity(value.predecessor, "ordinary Career projection commit predecessor"),
      successor: this.validatePortableProjectionIdentity(value.successor, "ordinary Career projection commit successor"),
    };
  }

  private writeOrdinaryProjectionCommitRecord(value: CareerOrdinaryProjectionCommitRecord): void {
    const normalized = this.validateOrdinaryProjectionCommitRecord(value);
    this.atomicWriteRootControlFile(CAREER_ORDINARY_PROJECTION_COMMIT_FILE, JSON.stringify(normalized), MAX_CAREER_ORDINARY_COMMIT_BYTES);
  }

  private readOrdinaryProjectionCommitRecord(): CareerOrdinaryProjectionCommitRecord | null {
    const value = this.readRootControlJson(CAREER_ORDINARY_PROJECTION_COMMIT_FILE, "ordinary Career projection commit", MAX_CAREER_ORDINARY_COMMIT_BYTES);
    return value === null ? null : this.validateOrdinaryProjectionCommitRecord(value);
  }

  private sameOrdinaryProjectionCommit(
    record: CareerOrdinaryProjectionCommitRecord,
    input: Pick<CareerOrdinaryProjectionCommitRecord, "sessionId" | "predecessorGeneration" | "predecessorEnvelopeHash" | "generation" | "envelopeHash">,
  ): boolean {
    return record.sessionId === input.sessionId
      && record.predecessorGeneration === input.predecessorGeneration
      && record.predecessorEnvelopeHash === input.predecessorEnvelopeHash
      && record.generation === input.generation
      && record.envelopeHash === input.envelopeHash;
  }

  private samePreparedOrdinaryProjectionCommit(
    record: CareerOrdinaryProjectionCommitRecord,
    input: CareerOrdinaryProjectionCommit,
  ): boolean {
    return this.sameOrdinaryProjectionCommit(record, input)
      && this.samePortableProjectionIdentity(record.predecessor, input.predecessor)
      && this.samePortableProjectionIdentity(record.successor, input.successor);
  }

  /** A prepared record fences all conforming writers until ordinary authority resolves. */
  private assertNoPendingOrdinaryProjectionCommitUnlocked(): void {
    const record = this.readOrdinaryProjectionCommitRecord();
    if (record === null) return;
    const current = this.currentPortableProjectionIdentityUnlocked();
    if (this.samePortableProjectionIdentity(current, record.successor)) {
      throw new CareerProjectionPredecessorConflict("Career projection ordinary commit finalization is pending");
    }
    if (this.samePortableProjectionIdentity(current, record.predecessor)) {
      throw new CareerProjectionPredecessorConflict("Career projection has an unresolved ordinary commit intent");
    }
    throw new CareerProjectionPredecessorConflict("Career projection does not match its ordinary commit intent");
  }

  /**
   * Capture a managed, ABA-resistant predecessor for one ordinary envelope.
   * This is host-only storage coordination; the public read facade does not
   * expose it to game/module code.
   */
  capturePortableProjectionIdentity(): CareerPortableProjectionIdentity {
    return this.withRootWriteLock(() => {
      this.assertNoPendingOrdinaryProjectionCommitUnlocked();
      return this.currentPortableProjectionIdentityUnlocked();
    });
  }

  /**
   * Under a short root fence, compare the managed predecessor and pre-stage
   * the exact immutable successor before writing a durable ordinary intent.
   * The root lock is released before ordinary/namespace CAS; every conforming
   * Career writer sees this record and fails closed until `resolve` decides
   * whether the authenticated envelope advanced or remained its predecessor.
   */
  prepareOrdinaryProjectionCommit(
    input: {
      sessionId: string;
      predecessorGeneration: number;
      predecessorEnvelopeHash: string;
      generation: number;
      envelopeHash: string;
      predecessor: CareerPortableProjectionIdentity;
    },
    successorInput: unknown,
  ): CareerOrdinaryProjectionCommit {
    const successor = validateCareerPortableProjection(successorInput);
    return this.withRootWriteLock(() => {
      this.assertNoPendingOrdinaryProjectionCommitUnlocked();
      const current = this.currentPortableProjectionIdentityUnlocked();
      if (!this.samePortableProjectionIdentity(current, input.predecessor)) {
        throw new CareerProjectionPredecessorConflict();
      }
      const successorIdentity = this.stagePortableProjection(successor);
      const record = this.validateOrdinaryProjectionCommitRecord({
          version: 1,
          ...input,
          predecessor: input.predecessor,
          successor: successorIdentity,
      });
      try {
        this.writeOrdinaryProjectionCommitRecord(record);
      } catch (error) {
        // An atomic control replace can report after persistence. Retain the
        // stage only if a strict readback proves this exact intent; otherwise
        // it is an unreferenced orphan eligible for best-effort cleanup.
        let exactPersistedIntent = false;
        try {
          const persisted = this.readOrdinaryProjectionCommitRecord();
          // A successful readback is not proof that the control replace was
          // durably synced.  In particular, a late fsync/dir-sync failure
          // must not let the ordinary pointer advance on the assumption that
          // the intent will survive a power loss.  Keep the exact staged
          // evidence for predecessor-side recovery, but make this attempt
          // fail before it can publish an envelope.
          exactPersistedIntent = persisted !== null && JSON.stringify(persisted) === JSON.stringify(record);
        } catch { /* Preserve the original ambiguous control-write failure. */ }
        if (!exactPersistedIntent) {
          try { this.removeProjectionStage(successorIdentity.version); } catch { /* an unreferenced stage is non-authoritative */ }
        }
        throw error;
      }
      return record;
    });
  }

  /**
   * Resolve a prepared intent only after the ordinary owner has read the
   * authoritative envelope/namespace identity. A rejected CAS removes its
   * orphan stage only when that exact predecessor remains authoritative;
   * ambiguity stays fenced instead of guessing.
   */
  resolveOrdinaryProjectionCommit(
    input: CareerOrdinaryProjectionCommit,
    authority: "successor" | "predecessor",
  ): void {
    this.withRootWriteLock(() => {
      const record = this.readOrdinaryProjectionCommitRecord();
      if (record === null || !this.samePreparedOrdinaryProjectionCommit(record, input)) {
        throw new CareerProjectionPredecessorConflict("Career ordinary commit intent is unavailable or mismatched");
      }
      const current = this.currentPortableProjectionIdentityUnlocked();
      if (authority === "successor") {
        if (this.samePortableProjectionIdentity(current, record.successor)) {
          this.deleteRootControlFile(CAREER_ORDINARY_PROJECTION_COMMIT_FILE);
          return;
        }
        if (!this.samePortableProjectionIdentity(current, record.predecessor)) {
          throw new CareerProjectionPredecessorConflict("Career projection changed while ordinary commit intent was pending");
        }
        this.activateStagedProjection(record.successor);
        this.deleteRootControlFile(CAREER_ORDINARY_PROJECTION_COMMIT_FILE);
        return;
      }
      if (!this.samePortableProjectionIdentity(current, record.predecessor)) {
        throw new CareerProjectionPredecessorConflict("Career projection changed before ordinary commit intent could be abandoned");
      }
      this.deleteRootControlFile(CAREER_ORDINARY_PROJECTION_COMMIT_FILE);
      try { this.removeProjectionStage(record.successor.version); } catch { /* orphan stage is non-authoritative after intent deletion */ }
    });
  }

  /** Recover a validated current ordinary envelope, never a caller-supplied locator. */
  reconcileOrdinaryProjection(
    input: Pick<CareerOrdinaryProjectionCommitRecord, "sessionId" | "generation" | "envelopeHash">
      & Partial<Pick<CareerOrdinaryProjectionCommitRecord, "predecessorGeneration" | "predecessorEnvelopeHash">>,
    successorInput: unknown,
  ): void {
    const successor = validateCareerPortableProjection(successorInput);
    const successorHash = portableProjectionHash(successor);
    this.withRootWriteLock(() => {
      const record = this.readOrdinaryProjectionCommitRecord();
      // Historical envelopes predate the intent protocol. They can only
      // hydrate when the physical projection already has their exact content.
      // Generation zero is the one initialization exception: its target may
      // populate a physically empty, uninitialized Career root, but never
      // replace a nonempty third projection.
      if (record === null) {
        const current = this.currentPortableProjectionIdentityUnlocked();
        if (current.projectionHash === successorHash) return;
        if (input.generation === 0 && this.exportPortableProjectionUnlocked().records.length === 0) {
          this.publishPortableProjection(successor);
          return;
        }
        throw new CareerProjectionPredecessorConflict("Career projection cannot be reconciled to this ordinary envelope");
      }
      const current = this.currentPortableProjectionIdentityUnlocked();
      // A process can die after prepare releases the root lock but before the
      // ordinary pointer advances. The authenticated current predecessor is
      // then the only authority allowed to retire this orphan intent/stage.
      if (record.sessionId === input.sessionId
        && record.predecessorGeneration === input.generation
        && record.predecessorEnvelopeHash === input.envelopeHash) {
        // The caller's envelope itself is part of the predecessor authority.
        // Tuple equality alone would let a forged/misrouted envelope retire
        // this intent while its Career projection described different state.
        if (successorHash !== record.predecessor.projectionHash
          || !this.samePortableProjectionIdentity(current, record.predecessor)) {
          throw new CareerProjectionPredecessorConflict("Career projection changed before an orphan ordinary intent could be abandoned");
        }
        this.deleteRootControlFile(CAREER_ORDINARY_PROJECTION_COMMIT_FILE);
        try { this.removeProjectionStage(record.successor.version); } catch { /* detached orphan stage is non-authoritative */ }
        return;
      }
      if (input.predecessorGeneration === undefined || input.predecessorEnvelopeHash === undefined) {
        throw new CareerProjectionPredecessorConflict("Career ordinary commit intent requires this envelope predecessor identity");
      }
      if (!this.sameOrdinaryProjectionCommit(record, input as Pick<CareerOrdinaryProjectionCommitRecord, "sessionId" | "predecessorGeneration" | "predecessorEnvelopeHash" | "generation" | "envelopeHash">)) {
        throw new CareerProjectionPredecessorConflict("Career ordinary commit intent authority tuple does not match this envelope");
      }
      if (record.successor.projectionHash !== successorHash) {
        throw new CareerProjectionPredecessorConflict("Career ordinary commit intent successor projection does not match this envelope");
      }
      if (this.samePortableProjectionIdentity(current, record.successor)) {
        this.deleteRootControlFile(CAREER_ORDINARY_PROJECTION_COMMIT_FILE);
        return;
      }
      if (!this.samePortableProjectionIdentity(current, record.predecessor)) {
        throw new CareerProjectionPredecessorConflict("Career projection cannot be reconciled to this ordinary envelope");
      }
      this.activateStagedProjection(record.successor);
      this.deleteRootControlFile(CAREER_ORDINARY_PROJECTION_COMMIT_FILE);
    });
  }

  /**
   * Internal staging-only replacement. Its individual leaf writes are never
   * visible to a managed reader; publication happens later through the
   * completed-version pointer.
   */
  private replacePortableProjectionInPlace(projection: CareerPortableProjection): void {
    const inventory = this.inspectRootInventory();
    const existingNames = inventory.characters;
    const desiredNames = new Set(projection.records.map((record) => record.characterName));
    const newPhysicalLeaves = projection.records.filter(
      (record) => !inventory.physicalLeafByCharacter.has(record.characterName),
    ).length;
    if (inventory.rootEntryCount + newPhysicalLeaves > MAX_CAREER_ROOT_ENTRIES) {
      throw new Error(
        `Career portable replacement would exceed the ${MAX_CAREER_ROOT_ENTRIES}-entry root resource limit before mutation`,
      );
    }

    for (const record of projection.records) {
      this.withWriteLock(record.characterName, () => this.writeAtomicWithReadback(record.characterName, {
        version: 1,
        base: structuredClone(record.base),
        entries: structuredClone(record.entries),
        updatedAt: "",
      }));
    }
    for (const characterName of existingNames.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
      if (!desiredNames.has(characterName)) this.withWriteLock(characterName, () => this.deleteFile(characterName));
    }

    const installed = this.exportPortableProjectionUnlocked();
    if (JSON.stringify(installed) !== JSON.stringify(projection)) {
      throw new Error("Career portable projection changed while it was being installed");
    }
  }

  replacePortableProjection(input: unknown): void {
    const projection = validateCareerPortableProjection(input);
    this.withRootWriteLock(() => {
      this.assertNoPendingOrdinaryProjectionCommitUnlocked();
      if (!this.managedProjectionLayout) {
        this.replacePortableProjectionInPlace(projection);
        return;
      }
      // Preserve the direct-root resource contract before creating any staged
      // content. Once a pointer exists the active version itself is bounded.
      if (this.readActiveProjectionName() === null) {
        const legacyInventory = this.inspectRootInventory();
        if (legacyInventory.rootEntryCount >= MAX_CAREER_ROOT_ENTRIES) {
          throw new Error(
            `Career portable replacement would exceed the ${MAX_CAREER_ROOT_ENTRIES}-entry root resource limit before mutation`,
          );
        }
      }
      this.publishPortableProjection(projection);
    });
  }

  addEntry(entry: CareerEntry): void {
    const normalizedEntry = normalizeEntry(entry, "CareerEntry input");
    this.withRootWriteLock((rootFence) => {
      this.assertNoPendingOrdinaryProjectionCommitUnlocked();
      if (this.readActiveProjectionName() !== null) {
        this.mutatePublishedProjection((records) => {
          const existingRecord = records.find((record) => record.characterName === normalizedEntry.characterName);
          if (!existingRecord) {
            records.push({ characterName: normalizedEntry.characterName, base: null, entries: [structuredClone(normalizedEntry)] });
            return true;
          }
          const existing = existingRecord.entries.find((candidate) => candidate.id === normalizedEntry.id);
          if (existing) {
            if (canonicalEntry(existing) === canonicalEntry(normalizedEntry)) return false;
            throw new Error(`Career entry id "${normalizedEntry.id}" already exists with different content`);
          }
          existingRecord.entries.push(structuredClone(normalizedEntry));
          return true;
        });
        return;
      }
      this.withWriteLock(normalizedEntry.characterName, () => {
        const file = this.readOrCreate(normalizedEntry.characterName);
        const existing = file.entries.find((candidate) => candidate.id === normalizedEntry.id);
        if (existing) {
          if (canonicalEntry(existing) === canonicalEntry(normalizedEntry)) return;
          throw new Error(`Career entry id "${normalizedEntry.id}" already exists with different content`);
        }
        file.entries.push(normalizedEntry);
        this.writeAtomicWithReadback(normalizedEntry.characterName, file);
      }, rootFence);
    });
  }

  getEntries(characterName: string): CareerEntry[] {
    return this.withRootWriteLock(() => this.readFile(characterName)?.entries ?? []);
  }

  deleteEntry(entryId: string): void {
    this.withRootWriteLock((rootFence) => {
      this.assertNoPendingOrdinaryProjectionCommitUnlocked();
      if (this.readActiveProjectionName() !== null) {
        this.mutatePublishedProjection((records) => {
          const recordIndex = records.findIndex((record) => record.entries.some((entry) => entry.id === entryId));
          if (recordIndex < 0) return false;
          const record = records[recordIndex]!;
          record.entries = record.entries.filter((entry) => entry.id !== entryId);
          if (record.base === null && record.entries.length === 0) records.splice(recordIndex, 1);
          return true;
        });
        return;
      }
      for (const name of this.inspectRootInventory().characters) {
        const deleted = this.withWriteLock(name, () => {
          const file = this.readFile(name);
          if (!file) return false;
          const before = file.entries.length;
          file.entries = file.entries.filter((entry) => entry.id !== entryId);
          if (file.entries.length === before) return false;
          this.writeAtomicWithReadback(name, file);
          return true;
        }, rootFence);
        if (deleted) return;
      }
    });
  }

  private loadCareerUnlocked(characterName: string): CharacterCareer | null {
    const file = this.readFile(characterName);
    if (!file?.base) return null;
    const state = computeCurrentState(file.base, file.entries);
    return {
      characterName,
      base: file.base,
      entries: file.entries,
      totalModules: file.entries.length,
      currentSan: state.san,
      currentMaxSan: state.maxSan,
      currentCthulhuMythos: state.cthulhuMythos,
      currentHp: state.hp,
      currentMaxHp: state.maxHp,
      currentSkills: state.skills,
      currentCreditRating: state.creditRating,
    };
  }

  loadCareer(characterName: string): CharacterCareer | null {
    return this.withRootWriteLock(() => this.loadCareerUnlocked(characterName));
  }

  listCareers(): Array<{
    characterName: string;
    totalModules: number;
    currentSan: number;
    currentCm: number;
  }> {
    return this.withRootWriteLock(() => this.inspectRootInventory().characters.map((name) => {
      const career = this.loadCareerUnlocked(name);
      if (!career) return { characterName: name, totalModules: 0, currentSan: 0, currentCm: 0 };
      return {
        characterName: name,
        totalModules: career.totalModules,
        currentSan: career.currentSan,
        currentCm: career.currentCthulhuMythos,
      };
    }));
  }

  exportToJson(characterName: string): string | null {
    return this.withRootWriteLock(() => {
      const file = this.readFile(characterName);
      return file ? JSON.stringify(file, null, 2) : null;
    });
  }

  importFromJson(json: string): boolean {
    try {
      if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_CAREER_JSON_BYTES) return false;
      const candidate = JSON.parse(json) as unknown;
      if (!isRecord(candidate) || candidate.base === null) return false;
      const base = normalizeSnapshot(candidate.base, "imported career base");
      const file = normalizeCareerFile(candidate, base.characterName);
      this.withRootWriteLock((rootFence) => {
        this.assertNoPendingOrdinaryProjectionCommitUnlocked();
        if (this.readActiveProjectionName() !== null) {
          this.mutatePublishedProjection((records) => {
            const replacement: CareerPortableRecord = {
              characterName: base.characterName,
              base: structuredClone(file.base),
              entries: structuredClone(file.entries),
            };
            const index = records.findIndex((record) => record.characterName === base.characterName);
            if (index < 0) records.push(replacement);
            else records[index] = replacement;
            return true;
          });
          return;
        }
        this.withWriteLock(base.characterName, () => this.writeAtomicWithReadback(base.characterName, file), rootFence);
      });
      return true;
    } catch {
      return false;
    }
  }
}
