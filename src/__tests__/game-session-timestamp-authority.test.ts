import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import {
  ordinaryGameSessionSnapshotHash,
  type OrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";
import { cleanupExpiredSessions } from "../api/server";

function withFixedNow<T>(now: number, operation: () => T): T {
  const original = Date.now;
  Date.now = () => now;
  try {
    return operation();
  } finally {
    Date.now = original;
  }
}

function ordinarySession(id: string, now = 100): GameSession {
  return withFixedNow(now, () => new GameSession(id, "cosmic-horror"));
}

function resign(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

describe("GameSession timestamp authority", () => {
  it("publishes non-configurable own read accessors that cannot be reassigned or shadowed", () => {
    const session = ordinarySession("timestamp-authority-view");
    try {
      const before = session.exportOrdinarySessionSnapshot();
      for (const key of ["createdAt", "lastActiveAt"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(session, key);
        expect(descriptor).toMatchObject({ enumerable: true, configurable: false });
        expect(descriptor?.get).toBeInstanceOf(Function);
        expect(descriptor?.set).toBeUndefined();

        let assignmentError: unknown;
        try {
          (session as unknown as Record<typeof key, number>)[key] = 9_999;
        } catch (error) {
          assignmentError = error;
        }
        expect(assignmentError).toBeInstanceOf(TypeError);
        expect(Reflect.set(session, key, 8_888)).toBe(false);
        expect(Reflect.defineProperty(session, key, { value: 7_777 })).toBe(false);
        expect(() => Object.defineProperty(session, key, { value: 7_777 })).toThrow(TypeError);
      }

      expect(session.exportOrdinarySessionSnapshot().session).toEqual(before.session);
      expect(session.getSummary().createdAt).toBe(before.session.createdAt);

      // Server cleanup reads the same non-shadowable public observation.
      const sessions = new Map([[session.id, session]]);
      expect(cleanupExpiredSessions(sessions, {
        now: session.lastActiveAt + 1,
        timeoutMs: 1,
        deleteMetadata: () => undefined,
      })).toEqual([]);
      expect(cleanupExpiredSessions(sessions, {
        now: session.lastActiveAt + 2,
        timeoutMs: 1,
        deleteMetadata: () => undefined,
      })).toEqual([session.id]);
    } finally {
      session.close();
    }
  });

  it("restores signed ordinary timestamps canonically and only advances activity through a real action", async () => {
    const id = "timestamp-authority-restore";
    const source = ordinarySession(id);
    const target = ordinarySession(id, 1);
    try {
      const signed = structuredClone(source.exportOrdinarySessionSnapshot());
      signed.session.createdAt = 500;
      signed.session.lastActiveAt = 600;
      target.restoreOrdinarySessionSnapshot(resign(signed));

      expect(target.createdAt).toBe(500);
      expect(target.lastActiveAt).toBe(600);
      expect(target.exportOrdinarySessionSnapshot().session).toMatchObject({ createdAt: 500, lastActiveAt: 600 });
      expect(target.getSummary().createdAt).toBe(500);

      const action = await target.act("/roll 1d6");
      expect(action.error).toBeUndefined();
      expect(target.createdAt).toBe(500);
      expect(target.lastActiveAt).toBeGreaterThan(600);
    } finally {
      source.close();
      target.close();
    }
  });
});
