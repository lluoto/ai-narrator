import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import {
  ordinaryGameSessionSnapshotHash,
  type OrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";

function ordinarySession(id: string): GameSession {
  return new GameSession(id, "cosmic-horror");
}

function resign(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

describe("GameSession skillMarks authority", () => {
  it("publishes skill marks only as a frozen detached read projection", () => {
    const session = ordinarySession("skill-marks-authority-view");
    try {
      const view = session.skillMarks;
      expect(Object.isFrozen(view)).toBe(true);
      expect(Object.getPrototypeOf(view)).toBeNull();

      let viewAssignmentError: unknown;
      try {
        (view as Record<string, number>).forged = 1;
      } catch (error) {
        viewAssignmentError = error;
      }
      expect(viewAssignmentError).toBeInstanceOf(TypeError);

      let assignmentError: unknown;
      try {
        (session as unknown as { skillMarks: Record<string, number> }).skillMarks = { forged: 1 };
      } catch (error) {
        assignmentError = error;
      }
      expect(assignmentError).toBeInstanceOf(TypeError);
      expect(Reflect.set(session, "skillMarks", { reflected: 2 })).toBe(false);
      expect(Reflect.set(view, "forged", 3)).toBe(false);
      expect(session.exportOrdinarySessionSnapshot().state.skillMarks).toEqual({});
    } finally {
      session.close();
    }
  });

  it("keeps internal snapshot and pristine restore truth private from a same-name shadow", () => {
    const id = "skill-marks-authority-shadow";
    const source = ordinarySession(id);
    const target = ordinarySession(id);
    try {
      Object.defineProperty(source, "skillMarks", {
        configurable: true,
        value: { forged: 99 },
      });
      expect(source.skillMarks).toEqual({ forged: 99 });
      expect(source.exportOrdinarySessionSnapshot().state.skillMarks).toEqual({});

      const signed = structuredClone(source.exportOrdinarySessionSnapshot());
      signed.state.skillMarks = { library_use: 3 };
      const restored = resign(signed);

      Object.defineProperty(target, "skillMarks", {
        configurable: true,
        value: { blocks_restore: 1 },
      });
      target.restoreOrdinarySessionSnapshot(restored);

      // The public own shadow remains an observer-only decoy.  The canonical
      // value came through the signed ordinary snapshot and is exported raw.
      expect(target.skillMarks).toEqual({ blocks_restore: 1 });
      expect(target.exportOrdinarySessionSnapshot().state.skillMarks).toEqual({ library_use: 3 });
    } finally {
      source.close();
      target.close();
    }
  });
});
