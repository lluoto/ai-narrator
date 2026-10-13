import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";

const OFFLINE_CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function ordinarySession(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", OFFLINE_CONFIG, "investigator", "Ada");
}

describe("GameSession round authority", () => {
  it("does not let a public round assignment replace the canonical summary or ordinary snapshot counter", () => {
    const session = ordinarySession("round-authority-assignment");
    try {
      let assignmentStatus: "accepted" | "rejected";
      try {
        (session as { round: number }).round = 9;
        assignmentStatus = "accepted";
      } catch (error) {
        assignmentStatus = "rejected";
        expect(error).toBeInstanceOf(TypeError);
      }

      // A legacy reader may become getter-only, but no external assignment
      // can alter the session's action/snapshot authority.
      expect(assignmentStatus).toMatch(/accepted|rejected/);
      expect(session.getSummary().round).toBe(0);
      expect(session.getState().round).toBe(0);
      expect(session.exportOrdinarySessionSnapshot().state.round).toBe(0);
    } finally {
      session.close();
    }
  });

  it("keeps a real ordinary action, summary, state, and snapshot on the private counter despite an own round shadow", async () => {
    const session = ordinarySession("round-authority-own-shadow");
    try {
      Object.defineProperty(session, "round", {
        configurable: true,
        writable: true,
        value: 9,
      });

      // Direct compatibility reads may see an own-property mask. Every
      // runtime decision below must instead use the canonical counter.
      expect(session.round).toBe(9);
      const action = await session.act("/roll 1d6");
      expect(action.error).toBeUndefined();
      expect(action.state.round).toBe(1);
      expect(session.getSummary().round).toBe(1);
      expect(session.getState().round).toBe(1);
      expect(session.exportOrdinarySessionSnapshot().state.round).toBe(1);
      expect(session.round).toBe(9);
    } finally {
      session.close();
    }
  });
});
