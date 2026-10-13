import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const OFFLINE_CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

const COMBAT_SUGGESTION = "⚔️ 攻击敌人";

function sessionWithDurableEnemy(id: string): GameSession {
  const session = new GameSession(
    id,
    "cosmic-horror",
    OFFLINE_CONFIG,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "preferred",
    { careerEntryPersistence: "transient" },
  );
  restoreSignedOrdinaryWorld(session, OFFLINE_CONFIG, (world) => world.upsertEntity({
    id: "combat-authority-enemy",
    name: "Combat Authority Enemy",
    type: "monster",
    hp: 100,
    maxHp: 100,
    ac: 0,
    status: [],
    position: "tavern",
    scene_id: "tavern",
  }));
  return session;
}

function hasCombatSuggestion(session: GameSession): boolean {
  return session.getSuggestions("p1").includes(COMBAT_SUGGESTION);
}

describe("GameSession combat-active authority", () => {
  it("does not let assignment or a true own shadow fabricate inactive combat suggestions or snapshot state", () => {
    const assignment = sessionWithDurableEnemy("combat-authority-assignment");
    try {
      let assignmentStatus: "accepted" | "rejected";
      try {
        (assignment as { combatActive: boolean }).combatActive = true;
        assignmentStatus = "accepted";
      } catch (error) {
        assignmentStatus = "rejected";
        expect(error).toBeInstanceOf(TypeError);
      }
      expect(assignmentStatus).toMatch(/accepted|rejected/);
      expect(hasCombatSuggestion(assignment)).toBe(false);
      expect(assignment.getKPState().combatActive).toBe(false);
      expect(assignment.exportOrdinarySessionSnapshot().state.combatActive).toBe(false);
    } finally {
      assignment.close();
    }

    const shadowed = sessionWithDurableEnemy("combat-authority-true-shadow");
    try {
      Object.defineProperty(shadowed, "combatActive", {
        configurable: true,
        writable: true,
        value: true,
      });
      // Direct compatibility reads can see an own-property shadow; canonical
      // gameplay must remain inactive until a real attack begins combat.
      expect(shadowed.combatActive).toBe(true);
      expect(hasCombatSuggestion(shadowed)).toBe(false);
      expect(shadowed.getKPState().combatActive).toBe(false);
      expect(shadowed.exportOrdinarySessionSnapshot().state.combatActive).toBe(false);
    } finally {
      shadowed.close();
    }
  });

  it("keeps real combat active across a false own shadow for suggestions, snapshots, and the counterattack gate", async () => {
    const session = sessionWithDurableEnemy("combat-authority-false-shadow");
    const originalRandom = Math.random;
    try {
      // The monster survives this real ordinary action, which is the only
      // route used to establish canonical combat in this fixture.
      Math.random = () => 0.99;
      const opening = await session.act("攻击 Combat Authority Enemy");
      expect(opening.error).toBeUndefined();
      expect(session.getKPState().combatActive).toBe(true);

      Object.defineProperty(session, "combatActive", {
        configurable: true,
        writable: true,
        value: false,
      });
      expect(session.combatActive).toBe(false);
      expect(hasCombatSuggestion(session)).toBe(true);
      expect(session.getKPState().combatActive).toBe(true);
      expect(session.exportOrdinarySessionSnapshot().state.combatActive).toBe(true);

      // This invokes the existing combat gate over the same live world state;
      // a false public shadow must not suppress a valid enemy counteraction.
      const counterLines: string[] = [];
      await (session as unknown as {
        npcCounterAttack: (intent: { action: "attack"; target: string }, emit: (line: string) => number) => Promise<void>;
      }).npcCounterAttack(
        { action: "attack", target: "combat-authority-enemy" },
        (line) => counterLines.push(line),
      );
      expect(counterLines.length).toBeGreaterThan(0);
    } finally {
      Math.random = originalRandom;
      session.close();
    }
  });
});
