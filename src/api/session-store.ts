// ============================================================
// Session 持久化存储
// ============================================================

import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { isOrdinarySessionAccessBinding, type OrdinarySessionAccessBinding } from "./session-access";

const BASE_DIR = join(process.cwd(), "data", "sessions");
const SESSION_METADATA_MAX_BYTES = 1024 * 1024;
const SESSION_METADATA_MAX_ROOT_ENTRIES = 4096;

class SessionMetadataContentError extends Error {}
class SessionMetadataIdentityError extends Error {}
type MetadataFileIdentity = Pick<Stats, "dev" | "ino" | "size">;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function sameFileIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRealMetadataDirectory(directory: string): Stats {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SessionMetadataIdentityError("session metadata root must be a real directory");
  }
  return stat;
}

function ensureDir(directory = BASE_DIR) {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  assertRealMetadataDirectory(directory);
}

function assertRegularMetadataFile(stat: Stats, path: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SessionMetadataIdentityError(`session metadata ${path} must be a regular non-link file`);
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new SessionMetadataIdentityError(`session metadata ${path} has an invalid file size`);
  }
}

function assertPinnedMetadataFile(stat: Stats, expected: MetadataFileIdentity, path: string): void {
  assertRegularMetadataFile(stat, path);
  if (!sameFileIdentity(stat, expected)) {
    throw new SessionMetadataIdentityError(`session metadata ${path} changed while it was being read`);
  }
}

function assertStableMetadataFile(stat: Stats, expected: MetadataFileIdentity, path: string): void {
  assertPinnedMetadataFile(stat, expected, path);
  if (stat.size !== expected.size) {
    throw new SessionMetadataIdentityError(`session metadata ${path} changed while it was being read`);
  }
}

/** Read a leaf through a pinned descriptor; malformed UTF-8 is content-invalid, never replacement-decoded. */
function readBoundedStrictUtf8RegularFile(path: string, expected?: MetadataFileIdentity): string {
  const before = lstatSync(path);
  assertRegularMetadataFile(before, path);
  if (expected && (!sameFileIdentity(before, expected) || before.size !== expected.size)) {
    throw new SessionMetadataIdentityError(`session metadata ${path} changed before it could be opened safely`);
  }
  if (before.size > SESSION_METADATA_MAX_BYTES) {
    throw new SessionMetadataContentError(`session metadata ${path} exceeds the ${SESSION_METADATA_MAX_BYTES}-byte resource limit`);
  }

  let fd: number | undefined;
  try {
    // Windows has no equivalent no-follow open exposed by Node/Bun; the
    // descriptor and pathname identity checks remain the fallback boundary.
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    const afterOpen = lstatSync(path);
    assertStableMetadataFile(opened, before, path);
    assertStableMetadataFile(afterOpen, before, path);

    // The additional byte detects growth without allocating from an
    // attacker-controlled size. The pre-open size is already capped.
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }

    const afterRead = fstatSync(fd);
    const afterPathRead = lstatSync(path);
    assertStableMetadataFile(afterRead, before, path);
    assertStableMetadataFile(afterPathRead, before, path);
    if (offset !== before.size || offset > SESSION_METADATA_MAX_BYTES) {
      throw new SessionMetadataIdentityError(`session metadata ${path} changed while it was being read`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset));
    } catch (error) {
      throw new SessionMetadataContentError(`session metadata ${path} is not valid UTF-8`, { cause: error });
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Stream the root and enforce the cap before any filename filtering. */
function listSessionRootEntries(directory: string, createIfMissing: boolean): string[] {
  if (createIfMissing) ensureDir(directory);
  const before = assertRealMetadataDirectory(directory);
  const handle = opendirSync(directory);
  const names: string[] = [];
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (names.length >= SESSION_METADATA_MAX_ROOT_ENTRIES) {
        throw new Error(`session metadata root exceeds the ${SESSION_METADATA_MAX_ROOT_ENTRIES}-entry resource limit`);
      }
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  const after = assertRealMetadataDirectory(directory);
  if (!sameFileIdentity(after, before)) {
    throw new SessionMetadataIdentityError("session metadata root changed while it was being enumerated");
  }
  return names;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("session metadata write made no progress");
    offset += written;
  }
}

function syncSessionMetadataDirectory(directory: string): void {
  const before = assertRealMetadataDirectory(directory);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY | noFollow);
  } catch (error) {
    // Windows commonly rejects opening a directory for fsync. Only its known
    // directory-sync errors are exempt; root inspection failures are outside
    // this catch and remain fail-closed.
    if (process.platform === "win32" && ["EINVAL", "EPERM", "EISDIR"].includes(errorCode(error) ?? "")) return;
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    const after = assertRealMetadataDirectory(directory);
    if (!opened.isDirectory() || !sameFileIdentity(opened, before) || !sameFileIdentity(after, before)) {
      throw new SessionMetadataIdentityError("session metadata root changed before it could be synced safely");
    }
    try {
      fsyncSync(fd);
    } catch (error) {
      if (process.platform === "win32" && ["EINVAL", "EPERM", "EISDIR"].includes(errorCode(error) ?? "")) return;
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

function removeOwnedTemporaryFile(path: string, expected: MetadataFileIdentity | undefined): void {
  if (!expected) return;
  try {
    const leftover = lstatSync(path);
    assertPinnedMetadataFile(leftover, expected, path);
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export function mergeSessionMetadata(existing: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {}), ...patch };
}

/** 写回磁盘：game-session的路由/元数据快照足以在重启时重建摘要 */
export function saveSessionMeta(id: string, meta: Record<string, unknown>, directory = BASE_DIR): void {
  ensureDir(directory);
  const file = join(directory, `${id}.json`);
  const merged = mergeSessionMetadata(loadSessionMeta(id, directory), meta);
  let serialized: string;
  try {
    serialized = JSON.stringify(merged, null, 2);
  } catch (error) {
    throw new Error(`could not serialize session metadata ${id}`, { cause: error });
  }
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > SESSION_METADATA_MAX_BYTES) {
    throw new SessionMetadataContentError(`session metadata ${id} exceeds the ${SESSION_METADATA_MAX_BYTES}-byte resource limit`);
  }

  const temp = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let temporaryIdentity: Stats | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    temporaryIdentity = fstatSync(fd);
    assertRegularMetadataFile(temporaryIdentity, temp);
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const beforePublish = lstatSync(temp);
    assertPinnedMetadataFile(beforePublish, temporaryIdentity, temp);
    renameSync(temp, file);
    syncSessionMetadataDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeOwnedTemporaryFile(temp, temporaryIdentity);
  }
}

/** Durable-ID collision check used before constructors that may create session files. */
export function sessionMetaExists(id: string, directory = BASE_DIR): boolean {
  return existsSync(join(directory, `${id}.json`));
}

/** 读取已持久化的 session 列表 */
function loadSessionIds(directory = BASE_DIR): string[] {
  return listSessionRootEntries(directory, true)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(/\.json$/, ""));
}

/** 读取某个 session 的持久化数据 */
function loadSessionMeta(id: string, directory = BASE_DIR, expected?: MetadataFileIdentity): unknown | null {
  const fp = join(directory, `${id}.json`);
  let text: string;
  try {
    text = readBoundedStrictUtf8RegularFile(fp, expected);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(text);
}

/** 删除某个 session */
export function deleteSessionFile(id: string, directory = BASE_DIR): void {
  const fp = join(directory, `${id}.json`);
  if (existsSync(fp)) unlinkSync(fp);
}

/**
 * Runtime authorization reads the durable binding on every ordinary-session
 * request. Missing, malformed, or tampered metadata is deliberately one
 * fail-closed state; callers must not treat it as an anonymous legacy row.
 */
export function readOrdinarySessionAccessBinding(
  id: string,
  directory = BASE_DIR,
): { status: "ok"; value: OrdinarySessionAccessBinding } | { status: "unavailable" } {
  try {
    const meta = loadSessionMeta(id, directory);
    if (!isRecord(meta) || !isOrdinarySessionAccessBinding(meta.ordinarySessionAccess)) return { status: "unavailable" };
    return { status: "ok", value: structuredClone(meta.ordinarySessionAccess) };
  } catch {
    return { status: "unavailable" };
  }
}

export type StoredSessionListing = {
  id: string;
  createdAt: number;
  ruleset: string;
  playerName: string;
  scene: string;
  bundleId?: string;
  /** Internal-only listing evidence; partitionSessionListings never returns it. */
  ordinarySessionAccess?: unknown;
};

export interface SessionListingFileOps {
  lstat(path: string): { isFile(): boolean; isSymbolicLink(): boolean; dev?: number; ino?: number; size?: number };
}

const sessionListingNodeFileOps: SessionListingFileOps = {
  lstat: (path) => lstatSync(path),
};

function metadataIdentityFromListingStat(stat: ReturnType<SessionListingFileOps["lstat"]>): MetadataFileIdentity | undefined {
  const { dev, ino, size } = stat;
  if (typeof dev !== "number" || typeof ino !== "number" || typeof size !== "number" || !Number.isFinite(dev) || !Number.isFinite(ino) || !Number.isSafeInteger(size) || size < 0) {
    return undefined;
  }
  return { dev, ino, size };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalListingString(meta: Record<string, unknown>, key: "ruleset" | "playerName" | "scene", fallback: string): string {
  const value = meta[key];
  if (value === undefined) return fallback; // old action-only metadata deliberately has no list fields
  if (typeof value !== "string") throw new Error(`metadata field ${key} must be a string`);
  return value;
}

function optionalCreatedAt(meta: Record<string, unknown>): number {
  const value = meta.createdAt;
  if (value === undefined) return 0; // old action-only metadata sorts after timestamped sessions
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("metadata field createdAt must be a non-negative finite number");
  }
  return value;
}

function sessionListing(id: string, meta: unknown): StoredSessionListing {
  if (!isRecord(meta)) throw new Error("session metadata must be a JSON object");
  const bundleId = meta.bundleId;
  if (bundleId !== undefined && typeof bundleId !== "string") {
    throw new Error("metadata field bundleId must be a string");
  }
  return {
    id,
    createdAt: optionalCreatedAt(meta),
    ruleset: optionalListingString(meta, "ruleset", "unknown"),
    playerName: optionalListingString(meta, "playerName", "unknown"),
    scene: optionalListingString(meta, "scene", "unknown"),
    ...(bundleId === undefined ? {} : { bundleId }),
    ...(meta.ordinarySessionAccess === undefined ? {} : { ordinarySessionAccess: structuredClone(meta.ordinarySessionAccess) }),
  };
}

/**
 * Inventory is deliberately stricter than the human-facing session listing.
 * The latter may skip a broken legacy record so one bad old row does not make
 * the UI unusable.  Namespace bootstrap cannot do that: a UUID-named locator
 * is durable collision evidence even when its JSON cannot be decoded.
 */
export type SessionMetadataLocator = {
  id: string;
  kind: "regular" | "unsafe";
  metadata: "valid" | "invalid";
};

export function listSessionMetadataLocators(directory = BASE_DIR): SessionMetadataLocator[] {
  if (!existsSync(directory)) return [];
  return listSessionRootEntries(directory, false)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name): SessionMetadataLocator => {
      const id = name.slice(0, -".json".length);
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        return { id, kind: "unsafe", metadata: "invalid" };
      }
      let text: string;
      try {
        text = readBoundedStrictUtf8RegularFile(path, entry);
      } catch (error) {
        // Content that cannot be decoded within the resource boundary remains
        // collision evidence. I/O and identity uncertainty must halt
        // namespace bootstrap rather than turn a public ID into a hole.
        if (error instanceof SessionMetadataContentError) {
          return { id, kind: "regular", metadata: "invalid" };
        }
        throw error;
      }
      try {
        // Parse and validate the same minimum listing shape used by the
        // legacy UI.  Syntax/shape failures are collision evidence, not an
        // invitation for a fresh allocator to reuse this public ID.  I/O is
        // intentionally above this catch: an unreadable regular locator is a
        // bootstrap failure, never a silently weakened quarantine.
        sessionListing(id, JSON.parse(text));
        return { id, kind: "regular", metadata: "valid" };
      } catch {
        return { id, kind: "regular", metadata: "invalid" };
      }
    });
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 列出所有持久化 session 的基本信息（不含完整状态）。目录枚举故障仍由调用方处理；
 * 单个文件的 I/O、JSON 或元数据形状错误只跳过那一项，以免服务启动和健康会话被拖垮。
 */
export function listStoredSessions(
  directory = BASE_DIR,
  fileOps: SessionListingFileOps = sessionListingNodeFileOps,
): StoredSessionListing[] {
  const listings: StoredSessionListing[] = [];
  for (const id of loadSessionIds(directory)) {
    const fileName = `${id}.json`;
    try {
      const stat = fileOps.lstat(join(directory, fileName));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("session metadata must be a regular non-link file");
      }
      const meta = loadSessionMeta(id, directory, metadataIdentityFromListingStat(stat));
      if (meta === null) throw new Error("session metadata disappeared while listing");
      listings.push(sessionListing(id, meta));
    } catch (error) {
      console.warn(`[session-store] Skipping invalid session metadata ${fileName}: ${failureMessage(error)}`);
    }
  }
  return listings.sort((a, b) => b.createdAt - a.createdAt);
}
