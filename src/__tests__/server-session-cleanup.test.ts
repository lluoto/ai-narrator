import { describe, expect, it } from "bun:test";
import { cleanupExpiredSessions } from "../api/server";
import { GameSession } from "../api/game-session";
import { mergeSessionMetadata } from "../api/session-store";

describe("server session cleanup", () => {
  it("removes durable metadata and memory through one last-active policy", () => {
    const sessions = new Map<string, { lastActiveAt: number }>([["old", { lastActiveAt: 1 }], ["active", { lastActiveAt: 95 }]]);
    const deleted: string[] = [];
    expect(cleanupExpiredSessions(sessions, { now: 101, timeoutMs: 10, deleteMetadata: (id) => deleted.push(id) })).toEqual(["old"]);
    expect(deleted).toEqual(["old"]);
    expect([...sessions.keys()]).toEqual(["active"]);
  });

  it("keeps a session registered when metadata deletion fails", () => {
    const sessions = new Map<string, { lastActiveAt: number }>([["old", { lastActiveAt: 1 }]]);
    const errors: unknown[] = [];
    expect(cleanupExpiredSessions(sessions, { now: 101, timeoutMs: 10, deleteMetadata: () => { throw new Error("locked"); }, logError: (error) => errors.push(error) })).toEqual([]);
    expect([...sessions.keys()]).toEqual(["old"]);
    expect(errors).toHaveLength(1);
  });

  it("does not let an own lifecycle-observation shadow evict a real active transaction", async () => {
    const id = `cleanup-active-transaction-${crypto.randomUUID()}`;
    const session = new GameSession(id, "cosmic-horror", undefined, undefined, undefined, undefined, undefined, undefined, "development_fallback");
    const sessions = new Map<string, GameSession>([[id, session]]);
    let enterTransaction!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>((resolve) => { enterTransaction = resolve; });
    const gate = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const transaction = session.runExclusiveActionTransaction(async () => {
      enterTransaction();
      await gate;
    });
    let shadowInstalled = false;
    let completed = false;
    const options = {
      now: session.lastActiveAt + 11,
      timeoutMs: 10,
      deleteMetadata: () => undefined,
    };
    try {
      await entered;
      expect(session.hasActiveActionTransactions).toBe(true);
      shadowInstalled = Reflect.defineProperty(session, "hasActiveActionTransactions", { value: false, configurable: true });

      expect(cleanupExpiredSessions(sessions, options)).toEqual([]);
      expect(sessions.has(id)).toBe(true);
      expect(shadowInstalled).toBe(false);
      const descriptor = Object.getOwnPropertyDescriptor(session, "hasActiveActionTransactions");
      expect(descriptor?.enumerable).toBe(false);
      expect(descriptor?.configurable).toBe(false);
      expect(descriptor?.set).toBeUndefined();
      expect(() => { (session as unknown as { hasActiveActionTransactions: boolean }).hasActiveActionTransactions = false; }).toThrow(TypeError);
      expect(Reflect.set(session, "hasActiveActionTransactions", false)).toBe(false);
      expect(Reflect.set(session, "hasActiveActionTransactions", true)).toBe(false);
      expect(Reflect.defineProperty(session, "hasActiveActionTransactions", { value: false })).toBe(false);
      completed = true;
    } finally {
      if (shadowInstalled) Reflect.deleteProperty(session, "hasActiveActionTransactions");
      releaseTransaction();
      await transaction;
      if (!completed && sessions.has(id)) session.close();
    }

    expect(session.hasActiveActionTransactions).toBe(false);
    expect(cleanupExpiredSessions(sessions, options)).toEqual([id]);
    expect(sessions.has(id)).toBe(false);
  });

  it("preserves session creation and compiled identity when action metadata is patched", () => {
    expect(mergeSessionMetadata(
      { createdAt: 1, ruleset: "cosmic-horror", playerName: "Ada", bundleId: "bundle", compiledArtifactHash: "artifact" },
      { lastActiveAt: 2, round: 3, scene: "archive" },
    )).toEqual({ createdAt: 1, ruleset: "cosmic-horror", playerName: "Ada", bundleId: "bundle", compiledArtifactHash: "artifact", lastActiveAt: 2, round: 3, scene: "archive" });
  });
});
