import { describe, expect, it } from "bun:test";
import { constants } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  COMPILED_PLAYER_DELIVERY_CLAIM_COORDINATOR_SCHEMA_VERSION,
  COMPILED_PLAYER_DELIVERY_CLAIM_SQLITE_OPEN_FLAGS,
  CompiledPlayerDeliveryClaimCoordinator,
} from "../api/player-delivery-claim-coordinator";
import {
  CompiledPlayerDelivery,
  CompiledPlayerDeliveryClaimStore,
  compiledPlayerDeliveryClaimStoreNodeFileOps,
  type CompiledPlayerDeliveryClaimStoreStat,
} from "../api/player-delivery";

const DELIVERY_SECRET = "delivery_hmac_secret_".padEnd(48, "d");

function changedInode(stat: CompiledPlayerDeliveryClaimStoreStat): CompiledPlayerDeliveryClaimStoreStat {
  return {
    size: stat.size,
    dev: stat.dev,
    // NTFS inode values can exceed Number's exact range, so `+ 1` may not
    // mutate the representable value. Choose the opposite stable sentinel.
    ino: typeof stat.ino === "bigint" ? (stat.ino === 0n ? 1n : 0n) : (stat.ino === 0 ? 1 : 0),
    isFile: stat.isFile.bind(stat),
    isDirectory: stat.isDirectory.bind(stat),
    isSymbolicLink: stat.isSymbolicLink.bind(stat),
  };
}

describe("CompiledPlayerDeliveryClaimCoordinator", () => {
  it("uses its own durable SQLite lock identity and synchronous exclusive section", () => {
    const calls: string[] = [];
    let closed = 0;
    let stored = false;
    const coordinator = new CompiledPlayerDeliveryClaimCoordinator("C:/delivery-root", undefined, {
      pathOps: { kind: () => "missing" },
      connectionFactory(_file, flags) {
        expect(flags).toBe(COMPILED_PLAYER_DELIVERY_CLAIM_SQLITE_OPEN_FLAGS);
        return {
          run(sql: string) { calls.push(sql); },
          policy: () => stored ? {
            schema_version: COMPILED_PLAYER_DELIVERY_CLAIM_COORDINATOR_SCHEMA_VERSION,
            coordinator_domain: "compiled-player-delivery-claim-publication",
            writer_protocol: "link-fsync-first-winner-v1",
          } : undefined,
          pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") {
            return ({ journal_mode: "delete", synchronous: 2, locking_mode: "normal", busy_timeout: 0 } as const)[name];
          },
          close() { closed += 1; },
        };
      },
    });

    coordinator.initialize();
    stored = true;
    expect(coordinator.withExclusive(() => "inside")).toBe("inside");
    expect(calls).toEqual(expect.arrayContaining([
      "PRAGMA journal_mode = DELETE",
      "PRAGMA synchronous = FULL",
      "PRAGMA locking_mode = NORMAL",
      "PRAGMA busy_timeout = 0",
      "BEGIN IMMEDIATE",
    ]));
    expect(calls.some((call) => call.includes("compiled_player_delivery_claim_coordinator_policy"))).toBe(true);
    expect(COMPILED_PLAYER_DELIVERY_CLAIM_COORDINATOR_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(COMPILED_PLAYER_DELIVERY_CLAIM_SQLITE_OPEN_FLAGS & constants.SQLITE_OPEN_NOFOLLOW).toBe(constants.SQLITE_OPEN_NOFOLLOW);
    expect(COMPILED_PLAYER_DELIVERY_CLAIM_SQLITE_OPEN_FLAGS & constants.SQLITE_OPEN_FULLMUTEX).toBe(constants.SQLITE_OPEN_FULLMUTEX);
    expect(COMPILED_PLAYER_DELIVERY_CLAIM_SQLITE_OPEN_FLAGS & constants.SQLITE_OPEN_EXRESCODE).toBe(constants.SQLITE_OPEN_EXRESCODE);
    expect(closed).toBe(2);
  });

  it("fails closed when the root identity fence or a final leaf descriptor close changes", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-player-delivery-descriptor-fence-"));
    const claimRoot = join(root, "delivery");
    try {
      // Initialize the real policy once. A later descriptor mismatch must be
      // a read failure, never an invitation for a read path to recreate state.
      new CompiledPlayerDeliveryClaimStore(claimRoot).initialize();
      const wrongRootIdentity = new CompiledPlayerDeliveryClaimStore(claimRoot, {
        ops: {
          ...compiledPlayerDeliveryClaimStoreNodeFileOps,
          fstat: (fd) => changedInode(compiledPlayerDeliveryClaimStoreNodeFileOps.fstat(fd)),
        },
      });
      expect(wrongRootIdentity.read("descriptor-fence-session")).toBeUndefined();

      const authoritative = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        publicOrigin: "https://example.test",
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot),
      });
      const invitation = authoritative.issue("descriptor-close-session");
      if (!invitation) throw new Error("expected invitation");
      const issued = authoritative.claim("descriptor-close-session", invitation.binding, invitation.invite, "c".repeat(43));
      if (!issued) throw new Error("expected claim");
      const cookie = `${issued.cookieName}=${issued.cookieValue}`;

      let leafIdentityFd: number | undefined;
      const wrongLeafIdentity = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        publicOrigin: "https://example.test",
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot, {
          ops: {
            ...compiledPlayerDeliveryClaimStoreNodeFileOps,
            openReadNoFollow(path) {
              const fd = compiledPlayerDeliveryClaimStoreNodeFileOps.openReadNoFollow(path);
              if (path.endsWith("descriptor-close-session.claim.json")) leafIdentityFd = fd;
              return fd;
            },
            fstat(fd) {
              const stat = compiledPlayerDeliveryClaimStoreNodeFileOps.fstat(fd);
              return fd === leafIdentityFd ? changedInode(stat) : stat;
            },
          },
        }),
      });
      expect(wrongLeafIdentity.authenticate("descriptor-close-session", invitation.binding, cookie)).toBe(false);

      let leafFd: number | undefined;
      let leafCloseAttempted = false;
      const closeFailure = new CompiledPlayerDelivery({
        secret: DELIVERY_SECRET,
        publicOrigin: "https://example.test",
        claims: new CompiledPlayerDeliveryClaimStore(claimRoot, {
          ops: {
            ...compiledPlayerDeliveryClaimStoreNodeFileOps,
            openReadNoFollow(path) {
              const fd = compiledPlayerDeliveryClaimStoreNodeFileOps.openReadNoFollow(path);
              if (path.endsWith("descriptor-close-session.claim.json")) leafFd = fd;
              return fd;
            },
            close(fd) {
              compiledPlayerDeliveryClaimStoreNodeFileOps.close(fd);
              if (fd === leafFd) {
                leafCloseAttempted = true;
                throw new Error("simulated final descriptor close failure");
              }
            },
          },
        }),
      });
      expect(closeFailure.authenticate("descriptor-close-session", invitation.binding, cookie)).toBe(false);
      expect(leafCloseAttempted).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not hide rollback or close failures behind an exclusive callback failure", () => {
    const coordinator = new CompiledPlayerDeliveryClaimCoordinator("C:/delivery-root", undefined, {
      pathOps: { kind: () => "missing" },
      connectionFactory: () => ({
        run(sql: string) {
          if (sql === "ROLLBACK") throw new Error("rollback failure");
        },
        policy: () => ({
          schema_version: COMPILED_PLAYER_DELIVERY_CLAIM_COORDINATOR_SCHEMA_VERSION,
          coordinator_domain: "compiled-player-delivery-claim-publication",
          writer_protocol: "link-fsync-first-winner-v1",
        }),
        pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") {
          return ({ journal_mode: "delete", synchronous: 2, locking_mode: "normal", busy_timeout: 0 } as const)[name];
        },
        close() { throw new Error("close failure"); },
      }),
    });
    let failure: unknown;
    try {
      coordinator.withExclusive(() => { throw new Error("callback failure"); });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: "callback failure" });
    expect((failure as { cleanupFailures?: unknown[] }).cleanupFailures).toHaveLength(2);
  });
});
