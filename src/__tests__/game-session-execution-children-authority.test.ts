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

type HostileSession = Record<string, unknown>;

function sessionWithMythosSighting(id: string): GameSession {
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
  restoreSignedOrdinaryWorld(session, OFFLINE_CONFIG, (world) => {
    const scene = world.getCurrentState().scene ?? "tavern";
    world.upsertEntity({
      id: "execution-child-shoggoth",
      name: "修格斯",
      type: "monster",
      hp: 30,
      maxHp: 30,
      ac: 0,
      status: [],
      position: scene,
      scene_id: scene,
    });
  });
  return session;
}

describe("GameSession execution-only child authority", () => {
  it("does not publish the unused RuleEngine execution capability", () => {
    const session = new GameSession("execution-child-rule-engine", "cosmic-horror", OFFLINE_CONFIG);
    try {
      expect(Reflect.ownKeys(session)).not.toContain("ruleEngine");
      expect((session as unknown as HostileSession).ruleEngine).toBeUndefined();
    } finally {
      session.close();
    }
  });

  it("does not publish the unused SpellEngine execution capability", () => {
    const session = new GameSession("execution-child-spell-engine", "cosmic-horror", OFFLINE_CONFIG);
    try {
      expect(Reflect.ownKeys(session)).not.toContain("spellEngine");
      expect((session as unknown as HostileSession).spellEngine).toBeUndefined();
    } finally {
      session.close();
    }
  });

  it("keeps an ordinary CoC mythos sighting on the private NPC combat authority despite same-name shadows", async () => {
    const session = sessionWithMythosSighting("execution-child-npc-combat");
    const hostile = session as unknown as HostileSession;
    try {
      const canonicalOwnKeys = Reflect.ownKeys(session);
      const canonicalPublicValue = hostile.npcCombat;
      Object.defineProperties(hostile, {
        ruleEngine: {
          configurable: true,
          value: { execute: () => { throw new Error("public RuleEngine shadow was used"); } },
        },
        spellEngine: {
          configurable: true,
          value: { cast: () => { throw new Error("public SpellEngine shadow was used"); } },
        },
        npcCombat: {
          configurable: true,
          value: { getSanCost: () => { throw new Error("public NPCCombat shadow was used"); } },
        },
      });

      const beforeSan = session.sanity.state.currentSAN;
      const response = await session.act("看看四周");
      const text = response.events.map((event) => event.content).join("\n");

      expect(canonicalOwnKeys).not.toContain("npcCombat");
      expect(canonicalPublicValue).toBeUndefined();
      expect(hostile.npcCombat).toBeDefined();
      expect(response.error).toBeUndefined();
      expect(text).toContain("目击");
      expect(text).toContain("修格斯");
      expect(session.sanity.state.currentSAN).toBeLessThanOrEqual(beforeSan);
    } finally {
      session.close();
    }
  });
});
