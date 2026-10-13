import { closeSync, constants as fsConstants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { join, resolve } from "path";
import type { CompiledSessionPlayerDeliveryGrant } from "./compiled-session-snapshot";
import {
  CompiledPlayerDeliveryClaimCoordinator,
  type CompiledPlayerDeliveryClaimCoordinatorLike,
} from "./player-delivery-claim-coordinator";

const INVITE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const COOKIE_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DELIVERY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,}$/;
const DEFAULT_INVITE_TTL_SECONDS = 15 * 60;
const DEFAULT_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;
const CLAIM_STORE_SCHEMA_VERSION_V1 = "1.0.0";
const CLAIM_STORE_SCHEMA_VERSION = "2.0.0";
const CLAIM_STORE_MAX_BYTES = 4 * 1024;
const FOLLOWUP_TOKEN_PATTERN = /^contact_[A-Za-z0-9_-]{43}$/;
const FOLLOWUP_ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface CompilerPlayerDeliveryEnvironment {
  COMPILER_PLAYER_DELIVERY_HMAC_SECRET?: string;
  COMPILER_PLAYER_DELIVERY_INVITE_TTL_SECONDS?: string;
  COMPILER_PLAYER_DELIVERY_COOKIE_TTL_SECONDS?: string;
  COMPILER_PLAYER_DELIVERY_ROOT?: string;
  COMPILER_PUBLIC_ORIGIN?: string;
}

interface StoredPlayerClaimV1 {
  schemaVersion: typeof CLAIM_STORE_SCHEMA_VERSION_V1;
  sessionId: string;
  inviteDigest: string;
  claimIdDigest: string;
  cookieExpiresAt: number;
}

interface StoredPlayerClaimV2 {
  schemaVersion: typeof CLAIM_STORE_SCHEMA_VERSION;
  sessionId: string;
  inviteDigest: string;
  claimIdDigest: string;
  cookieExpiresAt: number;
  /** Exact immutable-grant expiry; v1 intentionally has no reclaim bound. */
  inviteExpiresAt: number;
}

type StoredPlayerClaim = StoredPlayerClaimV1 | StoredPlayerClaimV2;

export interface CompiledPlayerDeliveryClaimStoreStat {
  size: number;
  dev: number | bigint;
  ino: number | bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface CompiledPlayerDeliveryClaimStoreFileOps {
  lstat(path: string): CompiledPlayerDeliveryClaimStoreStat;
  fstat(fd: number): CompiledPlayerDeliveryClaimStoreStat;
  openReadNoFollow(path: string): number;
  readDescriptor(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  mkdir(path: string): void;
  openExclusive(path: string): number;
  write(fd: number, bytes: Uint8Array, offset: number, length: number): number;
  fsync(fd: number): void;
  close(fd: number): void;
  link(existingPath: string, finalPath: string): void;
  syncDirectory(path: string): void;
  unlink(path: string): void;
}

function syncClaimDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    // Windows does not support directory fsync; accepting only these platform
    // errors preserves the atomic link contract without hiding disk failures.
    if (!["EINVAL", "EPERM"].includes((error as { code?: string }).code ?? "")) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const compiledPlayerDeliveryClaimStoreNodeFileOps: CompiledPlayerDeliveryClaimStoreFileOps = {
  lstat: (path) => lstatSync(path),
  fstat: (fd) => fstatSync(fd),
  // O_NOFOLLOW makes the descriptor itself the authority; path re-checks
  // below fence replacement between lstat and the descriptor read.
  openReadNoFollow: (path) => openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
  readDescriptor: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  openExclusive: (path) => openSync(path, "wx", 0o600),
  write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  link: (existingPath, finalPath) => linkSync(existingPath, finalPath),
  syncDirectory: (path) => syncClaimDirectory(path),
  unlink: (path) => unlinkSync(path),
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validStoredClaim(value: unknown): value is StoredPlayerClaim {
  if (!isRecord(value)) return false;
  const validIdentity = typeof value.sessionId === "string" && SESSION_ID_PATTERN.test(value.sessionId)
    && typeof value.inviteDigest === "string" && DIGEST_PATTERN.test(value.inviteDigest)
    && typeof value.claimIdDigest === "string" && DIGEST_PATTERN.test(value.claimIdDigest);
  const validExpiry = (expiry: unknown): expiry is number => typeof expiry === "number" && Number.isSafeInteger(expiry) && expiry > 0;
  if (value.schemaVersion === CLAIM_STORE_SCHEMA_VERSION_V1) {
    return exactKeys(value, ["schemaVersion", "sessionId", "inviteDigest", "claimIdDigest", "cookieExpiresAt"])
      && validIdentity
      && validExpiry(value.cookieExpiresAt);
  }
  return value.schemaVersion === CLAIM_STORE_SCHEMA_VERSION
    && exactKeys(value, ["schemaVersion", "sessionId", "inviteDigest", "claimIdDigest", "cookieExpiresAt", "inviteExpiresAt"])
    && validIdentity
    && validExpiry(value.cookieExpiresAt)
    && validExpiry(value.inviteExpiresAt);
}

/**
 * The mutable delivery acknowledgement is intentionally outside the immutable
 * compiled snapshot chain: claiming an invitation must not impersonate a game
 * action or advance its generation. Every value here is either a public
 * locator or a one-way digest; raw invite, claim ID, and cookie never persist.
 */
export class CompiledPlayerDeliveryClaimStore {
  readonly root: string;
  private readonly ops: CompiledPlayerDeliveryClaimStoreFileOps;
  private readonly coordinator: CompiledPlayerDeliveryClaimCoordinatorLike;
  private initialized = false;

  constructor(
    root = process.env.COMPILER_PLAYER_DELIVERY_ROOT ?? join("data", "compiled-player-delivery"),
    options: {
      ops?: CompiledPlayerDeliveryClaimStoreFileOps;
      coordinatorFactory?: (root: string) => CompiledPlayerDeliveryClaimCoordinatorLike;
    } = {},
  ) {
    this.root = resolve(root);
    this.ops = options.ops ?? compiledPlayerDeliveryClaimStoreNodeFileOps;
    this.coordinator = (options.coordinatorFactory ?? ((coordinatorRoot) => new CompiledPlayerDeliveryClaimCoordinator(coordinatorRoot)))(this.root);
  }

  /** Operator startup owns root creation. Reads never create a missing root. */
  initialize(): void {
    this.ops.mkdir(this.root);
    this.withRootDescriptorFence(() => this.coordinator.initialize());
    this.initialized = true;
  }

  private path(sessionId: string): string {
    return join(this.root, `${sessionId}.claim.json`);
  }

  private temporaryPath(sessionId: string): string {
    return join(this.root, `.${sessionId}.${randomBytes(16).toString("hex")}.claim.tmp`);
  }

  read(sessionId: string): StoredPlayerClaim | null | undefined {
    if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
    const root = this.rootState();
    // An absent delivery root is an ordinary no-claim state. In particular,
    // authentication probes must not create it while delivery is disabled.
    if (root === "missing") return null;
    if (root !== "ready") return undefined;
    try {
      return this.coordinator.withExclusive(() => {
        return this.withRootDescriptorFence(() => this.readLocked(sessionId));
      });
    } catch {
      return undefined;
    }
  }

  /** Atomically bind exactly the first claim ID; equal replays are idempotent. */
  claim(value: StoredPlayerClaimV2): "claimed" | "replayed" | "refused" {
    // New publications must carry both expiry facts. v1 remains read-only
    // compatibility data and must never be emitted as a fresh claim.
    if (!validStoredClaim(value) || value.schemaVersion !== CLAIM_STORE_SCHEMA_VERSION) return "refused";
    try {
      if (!this.initialized) this.initialize();
      return this.coordinator.withExclusive(() => this.withRootDescriptorFence(() => this.claimLocked(value)));
    } catch {
      return "refused";
    }
  }

  private claimLocked(value: StoredPlayerClaimV2): "claimed" | "replayed" | "refused" {
    // Re-read only after taking the cross-process lock. The full publish,
    // replay repair, and raced-link recovery remain within this section.
    const current = this.readLocked(value.sessionId);
    if (current) return this.sameClaim(current, value) && this.repairDirectorySync() ? "replayed" : "refused";
    if (current === undefined) return "refused";
    let temporary: string | null = null;
    let temporaryFd: number | undefined;
    try {
      // The final path is never opened for write. A complete fsync'ed temp is
      // hard-linked into place, so a crash cannot strand a partial final claim
      // and a competing first writer cannot be overwritten by rename.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = this.temporaryPath(value.sessionId);
        try {
          const fd = this.ops.openExclusive(candidate);
          temporary = candidate;
          temporaryFd = fd;
          const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
          let offset = 0;
          while (offset < bytes.byteLength) {
            const written = this.ops.write(fd, bytes, offset, bytes.byteLength - offset);
            if (written <= 0) throw new Error("claim write made no progress");
            offset += written;
          }
          this.ops.fsync(fd);
          this.assertSafeTempDescriptor(candidate, fd);
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== "EEXIST" || attempt === 2) throw error;
        }
      }
      if (!temporary) return "refused";
      try {
        this.ops.link(temporary, this.path(value.sessionId));
        this.assertPublishedTempIdentity(temporary, this.path(value.sessionId), temporaryFd);
        this.ops.syncDirectory(this.root);
      } finally {
        // Keep the fsync'ed descriptor open through link and final-path
        // identity verification. A close failure still fails the claim.
        if (temporaryFd !== undefined) {
          const fd = temporaryFd;
          temporaryFd = undefined;
          this.ops.close(fd);
        }
        // A linked temp remains an extra hard link, so clean only this
        // operation's own name best effort; this is not scanning or GC.
        try { this.ops.unlink(temporary); } catch { /* ignored */ }
      }
      return "claimed";
    } catch (error) {
      if (temporaryFd !== undefined) {
        try { this.ops.close(temporaryFd); } catch { /* refuse after a close failure */ }
        temporaryFd = undefined;
      }
      if (temporary) {
        try { this.ops.unlink(temporary); } catch { /* ignored */ }
      }
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") return "refused";
      const raced = this.readLocked(value.sessionId);
      if (!raced || !this.sameClaim(raced, value)) return "refused";
      // The winner's directory sync may have failed or not yet reached stable
      // storage. An equal loser may recover it, but must make that recovery
      // durable before acknowledging the claim.
      return this.repairDirectorySync() ? "replayed" : "refused";
    }
  }

  private repairDirectorySync(): boolean {
    try {
      // JS lacks dirfd-relative link/fsync APIs. The surrounding root fence
      // detects replacement, but cannot make these final path operations
      // dirfd-relative; do not add deletion/GC semantics here.
      this.ops.syncDirectory(this.root);
      return true;
    } catch {
      return false;
    }
  }

  private sameClaim(current: StoredPlayerClaim, value: StoredPlayerClaimV2): boolean {
    return sameValue(current.inviteDigest, value.inviteDigest)
      && sameValue(current.claimIdDigest, value.claimIdDigest)
      && (current.schemaVersion !== CLAIM_STORE_SCHEMA_VERSION || current.inviteExpiresAt === value.inviteExpiresAt);
  }

  private rootState(): "missing" | "ready" | "unsafe" {
    try {
      return this.isSafeDirectory(this.ops.lstat(this.root)) ? "ready" : "unsafe";
    } catch (error) {
      return (error as { code?: string }).code === "ENOENT" ? "missing" : "unsafe";
    }
  }

  private withRootDescriptorFence<T>(callback: () => T): T {
    let fd: number | undefined;
    try {
      const before = this.ops.lstat(this.root);
      if (!this.isSafeDirectory(before)) throw new Error("compiled player delivery claim root is not a real non-link directory");
      fd = this.ops.openReadNoFollow(this.root);
      const opened = this.ops.fstat(fd);
      const afterOpen = this.ops.lstat(this.root);
      if (!this.isSafeDirectory(opened) || !this.isSafeDirectory(afterOpen)
        || !this.isSameNode(before, opened) || !this.isSameNode(before, afterOpen)) {
        throw new Error("compiled player delivery claim root lost descriptor identity");
      }
      const value = callback();
      const afterCallback = this.ops.lstat(this.root);
      if (!this.isSafeDirectory(afterCallback) || !this.isSameNode(before, afterCallback)) {
        throw new Error("compiled player delivery claim root changed during an authorized operation");
      }
      return value;
    } finally {
      // A failed descriptor close must invalidate the result: callers either
      // fail closed or surface the startup failure; it can never mint a cookie.
      if (fd !== undefined) this.ops.close(fd);
    }
  }

  private readLocked(sessionId: string): StoredPlayerClaim | null | undefined {
    const path = this.path(sessionId);
    let fd: number | undefined;
    try {
      const before = this.ops.lstat(path);
      if (!this.isSafeRegular(before)) return undefined;
      fd = this.ops.openReadNoFollow(path);
      const opened = this.ops.fstat(fd);
      const afterOpen = this.ops.lstat(path);
      if (!this.isSameNode(before, opened) || !this.isSameNode(before, afterOpen)
        || !this.isSafeRegular(opened) || !this.isSafeRegular(afterOpen)) return undefined;
      // Never path-read claim contents. A MAX+1 descriptor read detects a
      // size race even if the pre-open metadata was short enough.
      const bytes = new Uint8Array(CLAIM_STORE_MAX_BYTES + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = this.ops.readDescriptor(fd, bytes, offset, bytes.byteLength - offset, offset);
        if (!Number.isSafeInteger(count) || count < 0) return undefined;
        if (count === 0) break;
        offset += count;
      }
      const afterRead = this.ops.fstat(fd);
      const afterReadPath = this.ops.lstat(path);
      if (offset <= 0 || offset > CLAIM_STORE_MAX_BYTES
        || !this.isSameNode(before, afterRead) || !this.isSameNode(before, afterReadPath)
        || !this.isSafeRegular(afterRead) || !this.isSafeRegular(afterReadPath)
        || afterRead.size !== offset) return undefined;
      const raw = new TextDecoder().decode(bytes.subarray(0, offset));
      const parsed = JSON.parse(raw) as unknown;
      return validStoredClaim(parsed) && parsed.sessionId === sessionId ? parsed : undefined;
    } catch (error) {
      return (error as { code?: string }).code === "ENOENT" ? null : undefined;
    } finally {
      // Do not swallow a close failure after parsing trusted bytes. Throwing
      // makes the enclosing exclusive read fail closed instead of admitting a
      // cookie from a descriptor whose lifecycle could not be completed.
      if (fd !== undefined) this.ops.close(fd);
    }
  }

  private assertSafeTempDescriptor(path: string, fd: number): void {
    const descriptor = this.ops.fstat(fd);
    const afterFsync = this.ops.lstat(path);
    if (!this.isSafeRegular(descriptor) || !this.isSafeRegular(afterFsync) || !this.isSameNode(descriptor, afterFsync)) {
      throw new Error("compiled player delivery temporary claim lost descriptor identity");
    }
  }

  private assertPublishedTempIdentity(temporary: string, final: string, fd: number | undefined): void {
    if (fd === undefined) throw new Error("compiled player delivery temporary claim descriptor was closed before publication");
    const descriptor = this.ops.fstat(fd);
    const temporaryPath = this.ops.lstat(temporary);
    const finalPath = this.ops.lstat(final);
    if (!this.isSafeRegular(descriptor)
      || !this.isSafeRegular(temporaryPath)
      || !this.isSafeRegular(finalPath)
      || !this.isSameNode(descriptor, temporaryPath)
      || !this.isSameNode(descriptor, finalPath)) {
      throw new Error("compiled player delivery published claim lost temporary descriptor identity");
    }
  }

  private isSafeDirectory(stat: CompiledPlayerDeliveryClaimStoreStat): boolean {
    return stat.isDirectory() && !stat.isSymbolicLink() && this.hasIdentity(stat);
  }

  private isSafeRegular(stat: CompiledPlayerDeliveryClaimStoreStat): boolean {
    return stat.isFile()
      && !stat.isSymbolicLink()
      && Number.isSafeInteger(stat.size)
      && stat.size > 0
      && stat.size <= CLAIM_STORE_MAX_BYTES
      && this.hasIdentity(stat);
  }

  private hasIdentity(stat: CompiledPlayerDeliveryClaimStoreStat): boolean {
    return (typeof stat.dev === "number" || typeof stat.dev === "bigint")
      && (typeof stat.ino === "number" || typeof stat.ino === "bigint");
  }

  private isSameNode(left: CompiledPlayerDeliveryClaimStoreStat, right: CompiledPlayerDeliveryClaimStoreStat): boolean {
    return this.hasIdentity(left) && this.hasIdentity(right) && left.dev === right.dev && left.ino === right.ino;
  }
}

function configuredPositiveSeconds(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 31_536_000 ? seconds : null;
}

function validTtlSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 60 && value <= 31_536_000;
}

function inviteDigest(invite: string): string {
  return sha256(`compiled-player-invite-v1|${invite}`);
}

function claimIdDigest(claimId: string): string {
  return sha256(`compiled-player-claim-v1|${claimId}`);
}

function cookieName(sessionId: string): string {
  return `__Host-aitrpg-p1-${sha256(`compiled-player-cookie-name-v1|${sessionId}`).slice(0, 32)}`;
}

export interface PlayerDeliveryInvitation {
  binding: CompiledSessionPlayerDeliveryGrant;
  invite: string;
}

export interface PlayerDeliveryClaimResult {
  cookieName: string;
  cookieValue: string;
  maxAgeSeconds: number;
}

/** Fixed, host-only follow-up tuple. It is deliberately not a general MAC API. */
export interface CompiledPlayerFollowupBinding {
  sessionId: string;
  bundleId: string;
  expectedGeneration: number;
  sceneId: string;
  npcId: string;
  /** Host-canonical sorted dialogue clue IDs; never returned to the player. */
  clueIds: readonly string[];
  factsHash: string;
  contactToken: string;
  actionId: string;
  playerRequestHash: string;
  frameHash: string;
}

function validFollowupBase(value: {
  sessionId: unknown; bundleId: unknown; expectedGeneration: unknown; sceneId: unknown;
  npcId: unknown; clueIds: unknown; factsHash: unknown;
}): boolean {
  return typeof value.sessionId === "string" && SESSION_ID_PATTERN.test(value.sessionId)
    && typeof value.bundleId === "string" && value.bundleId.length > 0 && value.bundleId.length <= 160
    && Number.isSafeInteger(value.expectedGeneration) && (value.expectedGeneration as number) >= 0
    && typeof value.sceneId === "string" && value.sceneId.length > 0 && value.sceneId.length <= 160
    && typeof value.npcId === "string" && value.npcId.length > 0 && value.npcId.length <= 160
    && Array.isArray(value.clueIds) && value.clueIds.length > 0 && value.clueIds.length <= 64
    && value.clueIds.every((clueId) => typeof clueId === "string" && clueId.length > 0 && clueId.length <= 160)
    && value.clueIds.every((clueId, index, values) => index === 0 || values[index - 1]!.localeCompare(clueId) < 0)
    && typeof value.factsHash === "string" && DIGEST_PATTERN.test(value.factsHash);
}

/**
 * This deployment capability is deliberately unrelated to compiler Bearer
 * authentication. It issues a server-created p1 grant, and verifies a cookie
 * only for that session's narrow player fa莽ade.
 */
export class CompiledPlayerDelivery {
  readonly available: boolean;
  /** Optional browser-visible origin for a TLS-terminating trusted proxy. */
  readonly publicOrigin: string | null;
  private readonly secret: string | null;
  private readonly inviteTtlMs: number;
  private readonly cookieTtlMs: number;
  private readonly claims: CompiledPlayerDeliveryClaimStore;
  private readonly now: () => number;

  constructor(options: {
    secret?: string;
    inviteTtlSeconds?: number;
    cookieTtlSeconds?: number;
    publicOrigin?: string | null;
    claims?: CompiledPlayerDeliveryClaimStore;
    now?: () => number;
  } = {}) {
    this.secret = options.secret && DELIVERY_SECRET_PATTERN.test(options.secret) ? options.secret : null;
    this.publicOrigin = normalizePublicOrigin(options.publicOrigin);
    this.available = !!this.secret
      && validTtlSeconds(options.inviteTtlSeconds ?? DEFAULT_INVITE_TTL_SECONDS)
      && validTtlSeconds(options.cookieTtlSeconds ?? DEFAULT_COOKIE_TTL_SECONDS)
      && typeof this.publicOrigin === "string";
    this.inviteTtlMs = (options.inviteTtlSeconds ?? DEFAULT_INVITE_TTL_SECONDS) * 1000;
    this.cookieTtlMs = (options.cookieTtlSeconds ?? DEFAULT_COOKIE_TTL_SECONDS) * 1000;
    this.claims = options.claims ?? new CompiledPlayerDeliveryClaimStore();
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Startup validates the mutable acknowledgement domain before listening.
   * Disabled/misconfigured delivery deliberately remains owner-only and does
   * not materialize a root merely because the HTTP process has started.
   */
  initialize(): void {
    if (!this.available) return;
    this.claims.initialize();
  }

  issue(sessionId: string): PlayerDeliveryInvitation | null {
    if (!this.available || !SESSION_ID_PATTERN.test(sessionId)) return null;
    const invite = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.inviteTtlMs;
    if (!Number.isSafeInteger(expiresAt)) return null;
    return { binding: { pcId: "p1", inviteDigest: inviteDigest(invite), expiresAt }, invite };
  }

  private cookieSignature(sessionId: string, grant: CompiledSessionPlayerDeliveryGrant, claimId: string): string | null {
    if (!this.secret || !SESSION_ID_PATTERN.test(sessionId)) return null;
    return createHmac("sha256", this.secret)
      .update(JSON.stringify({ domain: "compiled-player-cookie-v1", sessionId, inviteDigest: grant.inviteDigest, claimId }))
      .digest("base64url");
  }

  /**
   * Mint only the opaque browser handle for a currently host-resolved contact.
   * This fixed tuple is not a generic signer and never releases its IDs.
   */
  issueCompiledPlayerFollowupContact(input: Omit<CompiledPlayerFollowupBinding, "contactToken" | "actionId" | "playerRequestHash" | "frameHash">): string | null {
    if (!this.secret || !validFollowupBase(input)) return null;
    return `contact_${this.followupMac("contact", input)}`;
  }

  validatesCompiledPlayerFollowupContact(
    input: Omit<CompiledPlayerFollowupBinding, "actionId" | "playerRequestHash" | "frameHash">,
  ): boolean {
    if (!this.secret || !validFollowupBase(input) || !FOLLOWUP_TOKEN_PATTERN.test(input.contactToken)) return false;
    const expected = this.issueCompiledPlayerFollowupContact({
      sessionId: input.sessionId, bundleId: input.bundleId, expectedGeneration: input.expectedGeneration,
      sceneId: input.sceneId, npcId: input.npcId, clueIds: input.clueIds, factsHash: input.factsHash,
    });
    return !!expected && sameValue(expected, input.contactToken);
  }

  /** MAC the complete pre-dispatch authority tuple, including raw-input hash. */
  signCompiledPlayerFollowupPrepared(input: CompiledPlayerFollowupBinding): string | null {
    return this.validFollowupBinding(input) ? this.followupMac("prepared", input) : null;
  }

  verifyCompiledPlayerFollowupPrepared(input: CompiledPlayerFollowupBinding, mac: string): boolean {
    return this.validFollowupBinding(input) && /^[A-Za-z0-9_-]{43}$/.test(mac)
      && sameValue(this.followupMac("prepared", input), mac);
  }

  /** Durable external-dispatch fence, bound to the prepared authority. */
  signCompiledPlayerFollowupDispatch(input: CompiledPlayerFollowupBinding, preparedMac: string): string | null {
    return this.validFollowupBinding(input) && /^[A-Za-z0-9_-]{43}$/.test(preparedMac)
      ? this.followupMac("dispatch", { ...input, preparedMac }) : null;
  }

  verifyCompiledPlayerFollowupDispatch(input: CompiledPlayerFollowupBinding, preparedMac: string, dispatchMac: string): boolean {
    return this.validFollowupBinding(input) && /^[A-Za-z0-9_-]{43}$/.test(preparedMac) && /^[A-Za-z0-9_-]{43}$/.test(dispatchMac)
      && sameValue(this.followupMac("dispatch", { ...input, preparedMac }), dispatchMac);
  }

  /** Receipt commitment binds the accepted output text hash to that fence. */
  signCompiledPlayerFollowupReceipt(input: CompiledPlayerFollowupBinding, dispatchMac: string, textHash: string): string | null {
    return this.validFollowupBinding(input) && /^[A-Za-z0-9_-]{43}$/.test(dispatchMac) && DIGEST_PATTERN.test(textHash)
      ? this.followupMac("receipt", { ...input, dispatchMac, textHash }) : null;
  }

  verifyCompiledPlayerFollowupReceipt(input: CompiledPlayerFollowupBinding, dispatchMac: string, textHash: string, receiptMac: string): boolean {
    return this.validFollowupBinding(input) && /^[A-Za-z0-9_-]{43}$/.test(dispatchMac) && DIGEST_PATTERN.test(textHash)
      && /^[A-Za-z0-9_-]{43}$/.test(receiptMac)
      && sameValue(this.followupMac("receipt", { ...input, dispatchMac, textHash }), receiptMac);
  }

  private validFollowupBinding(input: CompiledPlayerFollowupBinding): boolean {
    return !!this.secret && validFollowupBase(input)
      && FOLLOWUP_TOKEN_PATTERN.test(input.contactToken)
      && FOLLOWUP_ACTION_ID_PATTERN.test(input.actionId)
      && DIGEST_PATTERN.test(input.playerRequestHash)
      && DIGEST_PATTERN.test(input.frameHash);
  }

  private followupMac(stage: "contact" | "prepared" | "dispatch" | "receipt", value: object): string {
    // Each caller supplies one of the exact typed records above. No arbitrary
    // message/domain reaches this helper or crosses the class boundary.
    return createHmac("sha256", this.secret!)
      .update(JSON.stringify({ domain: "compiled-player-followup-v1", stage, value }))
      .digest("base64url");
  }

  /**
   * Pure invitation/grant validation for the HTTP admission gate. It must not
   * inspect or mutate the claim store: a bad public invite may be rejected
   * before a durable session is hydrated from its locator.
   */
  validatesClaim(sessionId: string, grant: CompiledSessionPlayerDeliveryGrant, invite: unknown, claimId: unknown): boolean {
    return this.available
      && SESSION_ID_PATTERN.test(sessionId)
      && INVITE_PATTERN.test(invite as string)
      && CLAIM_ID_PATTERN.test(claimId as string)
      && grant.pcId === "p1"
      && DIGEST_PATTERN.test(grant.inviteDigest)
      && Number.isSafeInteger(grant.expiresAt)
      && grant.expiresAt > this.now()
      && sameValue(inviteDigest(invite as string), grant.inviteDigest);
  }

  claim(sessionId: string, grant: CompiledSessionPlayerDeliveryGrant, invite: unknown, claimId: unknown): PlayerDeliveryClaimResult | null {
    if (!this.validatesClaim(sessionId, grant, invite, claimId)) return null;
    const cookieExpiresAt = this.now() + this.cookieTtlMs;
    if (!Number.isSafeInteger(cookieExpiresAt)) return null;
    const stored: StoredPlayerClaimV2 = {
      schemaVersion: CLAIM_STORE_SCHEMA_VERSION,
      sessionId,
      inviteDigest: grant.inviteDigest,
      claimIdDigest: claimIdDigest(claimId as string),
      cookieExpiresAt,
      inviteExpiresAt: grant.expiresAt,
    };
    const claimed = this.claims.claim(stored);
    if (claimed === "refused") return null;
    const authoritative = this.claims.read(sessionId);
    if (!authoritative || authoritative.cookieExpiresAt <= this.now()) return null;
    const signature = this.cookieSignature(sessionId, grant, claimId as string);
    if (!signature) return null;
    return {
      cookieName: cookieName(sessionId),
      cookieValue: `${claimId}.${signature}`,
      maxAgeSeconds: Math.max(1, Math.floor((authoritative.cookieExpiresAt - this.now()) / 1000)),
    };
  }

  authenticate(sessionId: string, grant: CompiledSessionPlayerDeliveryGrant, rawCookie: string | null): boolean {
    if (!this.available || !SESSION_ID_PATTERN.test(sessionId) || !rawCookie || grant.pcId !== "p1" || !DIGEST_PATTERN.test(grant.inviteDigest)) return false;
    const needle = `${cookieName(sessionId)}=`;
    const matches = rawCookie.split(";").map((entry) => entry.trim()).filter((entry) => entry.startsWith(needle));
    if (matches.length !== 1) return false;
    const encoded = matches[0]!.slice(needle.length);
    const [claimId, signature, extra] = encoded.split(".");
    if (extra !== undefined || !CLAIM_ID_PATTERN.test(claimId ?? "") || !COOKIE_SIGNATURE_PATTERN.test(signature ?? "")) return false;
    const expected = this.cookieSignature(sessionId, grant, claimId!);
    if (!expected || !sameValue(signature!, expected)) return false;
    const stored = this.claims.read(sessionId);
    return !!stored
      && stored.cookieExpiresAt > this.now()
      && sameValue(stored.inviteDigest, grant.inviteDigest)
      && sameValue(stored.claimIdDigest, claimIdDigest(claimId!))
      // v1 predates the immutable grant expiry fact. It remains compatible,
      // but only v2 can bind a persisted claim to that exact grant.
      && (stored.schemaVersion === CLAIM_STORE_SCHEMA_VERSION_V1 || stored.inviteExpiresAt === grant.expiresAt);
  }

  setCookie(result: PlayerDeliveryClaimResult): string {
    return `${result.cookieName}=${result.cookieValue}; Path=/; Max-Age=${result.maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
  }
}

function normalizePublicOrigin(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function createEnvironmentPlayerDelivery(
  env: CompilerPlayerDeliveryEnvironment = process.env as CompilerPlayerDeliveryEnvironment,
  options: { now?: () => number; claims?: CompiledPlayerDeliveryClaimStore } = {},
): CompiledPlayerDelivery {
  const inviteTtlSeconds = configuredPositiveSeconds(env.COMPILER_PLAYER_DELIVERY_INVITE_TTL_SECONDS, DEFAULT_INVITE_TTL_SECONDS);
  const cookieTtlSeconds = configuredPositiveSeconds(env.COMPILER_PLAYER_DELIVERY_COOKIE_TTL_SECONDS, DEFAULT_COOKIE_TTL_SECONDS);
  return new CompiledPlayerDelivery({
    ...(inviteTtlSeconds !== null ? { inviteTtlSeconds } : { inviteTtlSeconds: 0 }),
    ...(cookieTtlSeconds !== null ? { cookieTtlSeconds } : { cookieTtlSeconds: 0 }),
    secret: env.COMPILER_PLAYER_DELIVERY_HMAC_SECRET,
    claims: options.claims ?? new CompiledPlayerDeliveryClaimStore(env.COMPILER_PLAYER_DELIVERY_ROOT),
    now: options.now,
    publicOrigin: env.COMPILER_PUBLIC_ORIGIN,
  });
}
