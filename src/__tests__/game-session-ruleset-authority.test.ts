import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";

const CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function dndSession(id: string): GameSession {
  return new GameSession(id, "dnd5e", CONFIG, "fighter", "Ada");
}

describe("GameSession ruleset authority", () => {
  it("does not let a public ruleset assignment change the canonical summary or DnD state projection", () => {
    const session = dndSession("ruleset-authority-assignment");
    try {
      const before = session.getState().player.ac;
      expect(session.getSummary().ruleset).toBe("dnd5e");
      expect(before).toBeGreaterThan(0);

      // The compatibility property may become read-only.  Either way, an
      // untrusted write must not select a different runtime ruleset.
      let assignmentStatus: "accepted" | "rejected";
      try {
        (session as { activeRuleset: string }).activeRuleset = "cosmic-horror";
        assignmentStatus = "accepted";
      } catch (error) {
        assignmentStatus = "rejected";
        expect(error).toBeInstanceOf(TypeError);
      }

      // Whether strict mode rejected the write or a compatibility host accepts
      // it, the authoritative selector and its rule-facing projection stay put.
      expect({
        assignmentStatus,
        ruleset: session.getSummary().ruleset,
        playerAc: session.getState().player.ac,
      }).toMatchObject({ ruleset: "dnd5e", playerAc: before });
    } finally {
      session.close();
    }
  });

  it("keeps internal ruleset semantics canonical when an own property shadows the public observation", () => {
    const session = dndSession("ruleset-authority-own-shadow");
    try {
      const before = session.getState().player.ac;
      Object.defineProperty(session, "activeRuleset", {
        configurable: true,
        value: "cosmic-horror",
      });

      // An own property can still mask a prototype getter to its direct
      // reader; it must never become the rules authority used by the session.
      expect(session.activeRuleset).toBe("cosmic-horror");
      expect(session.getSummary().ruleset).toBe("dnd5e");
      expect(session.getState().player.ac).toBe(before);
      // This is a real ruleset gate, not another presentation read.  The
      // DnD session must refuse a CoC-only luck mutation despite the shadow.
      expect(session.spendCharacterLuck("p1", 1)).toEqual({
        status: "refused",
        code: "luck_ruleset_unsupported",
      });
    } finally {
      session.close();
    }
  });
});
