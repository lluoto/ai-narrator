import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { runSuggestions } from "../api/server";

const FORGED_PC = "forged-player-session-slot";

function fakeReadFacade(): GameSession["session"] {
  return Object.freeze(Object.assign(Object.create(null), {
    get: (pcId: string) => pcId === FORGED_PC ? { id: FORGED_PC, name: "Forged" } : undefined,
  })) as GameSession["session"];
}

function assertRealSuggestionsGate(session: GameSession): void {
  expect(runSuggestions(session, FORGED_PC).status).toBe(404);
  expect(runSuggestions(session, "p1").status).toBe(200);
}

function withSession(operation: (session: GameSession) => void): void {
  const session = new GameSession("player-session-authority", "cosmic-horror");
  try {
    operation(session);
  } finally {
    session.close();
  }
}

describe("GameSession PlayerSession facade authority", () => {
  it("publishes one stable frozen facade through an enumerable non-configurable own getter", () => {
    withSession((session) => {
      const first = session.session;
      const descriptor = Object.getOwnPropertyDescriptor(session, "session");
      expect(first).toBe(session.session);
      expect(Object.isFrozen(first)).toBe(true);
      expect(descriptor).toMatchObject({ enumerable: true, configurable: false });
      expect(descriptor?.get).toBeInstanceOf(Function);
      expect(descriptor?.set).toBeUndefined();
      expect(Object.keys(session)).toContain("session");
      assertRealSuggestionsGate(session);
    });
  });

  it("rejects strict session facade replacement without changing the real suggestions gate", () => {
    withSession((session) => {
      const original = session.session;
      let error: unknown;
      try {
        (session as unknown as { session: GameSession["session"] }).session = fakeReadFacade();
      } catch (caught) {
        error = caught;
      }
      assertRealSuggestionsGate(session);
      expect(session.session).toBe(original);
      expect(error).toBeInstanceOf(TypeError);
    });
  });

  it("rejects Reflect.set session facade replacement without changing the real suggestions gate", () => {
    withSession((session) => {
      const original = session.session;
      const changed = Reflect.set(session, "session", fakeReadFacade());
      assertRealSuggestionsGate(session);
      expect(session.session).toBe(original);
      expect(changed).toBe(false);
    });
  });

  it("rejects Reflect.defineProperty session facade replacement without changing the real suggestions gate", () => {
    withSession((session) => {
      const original = session.session;
      const changed = Reflect.defineProperty(session, "session", { value: fakeReadFacade() });
      assertRealSuggestionsGate(session);
      expect(session.session).toBe(original);
      expect(changed).toBe(false);
    });
  });

  it("rejects Object.defineProperty session facade replacement without changing the real suggestions gate", () => {
    withSession((session) => {
      const original = session.session;
      let error: unknown;
      try {
        Object.defineProperty(session, "session", { value: fakeReadFacade() });
      } catch (caught) {
        error = caught;
      }
      assertRealSuggestionsGate(session);
      expect(session.session).toBe(original);
      expect(error).toBeInstanceOf(TypeError);
    });
  });
});
