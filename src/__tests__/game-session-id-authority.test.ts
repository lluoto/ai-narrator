import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession } from "../api/game-session";

const CANONICAL_ID = "session-id-authority-canonical";
const FORGED_ID = "session-id-authority-forged";

function createSession(root: string): GameSession {
  return new GameSession(CANONICAL_ID, "cosmic-horror", undefined, undefined, undefined, undefined, {
    careerRoot: root,
  });
}

function assertCanonicalIdentity(session: GameSession, root: string): void {
  const snapshot = session.exportOrdinarySessionSnapshot();
  expect(snapshot.session.id).toBe(CANONICAL_ID);
  expect(session.getSummary().id).toBe(CANONICAL_ID);
  // Snapshot export initializes the lazy career store. A plain forged ID must
  // never select its filesystem namespace.
  expect(existsSync(join(root, CANONICAL_ID))).toBe(true);
  expect(existsSync(join(root, FORGED_ID))).toBe(false);
}

function withSession(operation: (session: GameSession, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "game-session-id-authority-"));
  const session = createSession(root);
  try {
    operation(session, root);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("GameSession session-id authority", () => {
  it("publishes an enumerable non-configurable own ID accessor", () => {
    withSession((session) => {
      const descriptor = Object.getOwnPropertyDescriptor(session, "id");
      expect(descriptor).toMatchObject({ enumerable: true, configurable: false });
      expect(descriptor?.get).toBeInstanceOf(Function);
      expect(descriptor?.set).toBeUndefined();
      expect(Object.keys(session)).toContain("id");
      expect(session.id).toBe(CANONICAL_ID);
    });
  });

  it("keeps ordinary snapshot, summary, and lazy career identity canonical after strict assignment", () => {
    withSession((session, root) => {
      let error: unknown;
      try {
        (session as unknown as { id: string }).id = FORGED_ID;
      } catch (caught) {
        error = caught;
      }
      assertCanonicalIdentity(session, root);
      expect(error).toBeInstanceOf(TypeError);
    });
  });

  it("keeps ordinary snapshot, summary, and lazy career identity canonical after Reflect.set", () => {
    withSession((session, root) => {
      const changed = Reflect.set(session, "id", FORGED_ID);
      assertCanonicalIdentity(session, root);
      expect(changed).toBe(false);
    });
  });

  it("keeps ordinary snapshot, summary, and lazy career identity canonical after Reflect.defineProperty", () => {
    withSession((session, root) => {
      const changed = Reflect.defineProperty(session, "id", { value: FORGED_ID });
      assertCanonicalIdentity(session, root);
      expect(changed).toBe(false);
    });
  });

  it("rejects Object.defineProperty same-name shadows without changing canonical identity", () => {
    withSession((session, root) => {
      let error: unknown;
      try {
        Object.defineProperty(session, "id", { value: FORGED_ID });
      } catch (caught) {
        error = caught;
      }
      assertCanonicalIdentity(session, root);
      expect(error).toBeInstanceOf(TypeError);
    });
  });
});
