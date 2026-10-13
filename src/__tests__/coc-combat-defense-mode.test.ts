import { expect, test } from "bun:test";
import { CoCEngine, cocCombatRollHits } from "../rules/coc-engine";
import { RulesEngine } from "../rules/rules-engine";
import { GameSession } from "../api/game-session";
import type { WorldEntity } from "../types";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const OFFLINE_CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function sequence(units: number[]): () => number {
  let index = 0;
  return () => units[index++] ?? 0;
}

const defender: WorldEntity = {
  id: "defender", name: "Defender", type: "monster", hp: 20, maxHp: 20,
  ac: 0, status: [], position: "arena", scene_id: "arena",
};

test("CoC close-combat resolution compares success levels under the declared defense mode", () => {
  const cases = [
    { name: "attack failure never hits", attackRoll: 51, attackSkill: 50, defenseRoll: null, defenseSkill: 50, mode: "none", hit: false },
    { name: "attack fumble never hits", attackRoll: 100, attackSkill: 90, defenseRoll: null, defenseSkill: 90, mode: "none", hit: false },
    { name: "unopposed successful attack hits", attackRoll: 30, attackSkill: 50, defenseRoll: null, defenseSkill: 50, mode: "none", hit: true },
    { name: "dodge tie belongs to defender", attackRoll: 30, attackSkill: 50, defenseRoll: 30, defenseSkill: 50, mode: "dodge", hit: false },
    { name: "dodge attack higher success level hits", attackRoll: 20, attackSkill: 50, defenseRoll: 30, defenseSkill: 50, mode: "dodge", hit: true },
    { name: "dodge defense higher success level avoids", attackRoll: 30, attackSkill: 50, defenseRoll: 20, defenseSkill: 50, mode: "dodge", hit: false },
    { name: "dodge defense critical avoids", attackRoll: 20, attackSkill: 50, defenseRoll: 1, defenseSkill: 90, mode: "dodge", hit: false },
    { name: "dodge defense failure permits hit", attackRoll: 30, attackSkill: 50, defenseRoll: 51, defenseSkill: 50, mode: "dodge", hit: true },
    { name: "dodge defense fumble permits hit", attackRoll: 30, attackSkill: 50, defenseRoll: 100, defenseSkill: 50, mode: "dodge", hit: true },
    { name: "dodge critical tie belongs to defender", attackRoll: 1, attackSkill: 90, defenseRoll: 1, defenseSkill: 90, mode: "dodge", hit: false },
    { name: "fight-back tie belongs to attacker", attackRoll: 30, attackSkill: 50, defenseRoll: 30, defenseSkill: 50, mode: "fight_back", hit: true },
    { name: "fight-back attacker higher success level hits", attackRoll: 20, attackSkill: 50, defenseRoll: 30, defenseSkill: 50, mode: "fight_back", hit: true },
    { name: "fight-back defender higher success level wins", attackRoll: 30, attackSkill: 50, defenseRoll: 20, defenseSkill: 50, mode: "fight_back", hit: false },
    { name: "fight-back defense critical wins over a noncritical attack", attackRoll: 20, attackSkill: 50, defenseRoll: 1, defenseSkill: 90, mode: "fight_back", hit: false },
    { name: "fight-back critical tie belongs to attacker", attackRoll: 1, attackSkill: 90, defenseRoll: 1, defenseSkill: 90, mode: "fight_back", hit: true },
  ] as const;

  for (const entry of cases) {
    expect(
      cocCombatRollHits(entry.attackRoll, entry.attackSkill, entry.defenseSkill, entry.defenseRoll, entry.mode),
      entry.name,
    ).toBe(entry.hit);
  }
  expect(() => cocCombatRollHits(30, 50, 50, 30, "invalid" as any)).toThrow("defense mode");
});

test("counter damage is emitted only when a fight-back defender actually wins", () => {
  const winsFightBack = CoCEngine.combatCheck(
    50, 50, "1d1", 0, 0, false, undefined, "fight_back", "1d1", undefined,
    { random: sequence([0.29, 0.19, 0]) },
  );
  expect(winsFightBack.hit).toBe(false);
  expect(winsFightBack.counterHit).toBe(true);
  expect(winsFightBack.counterDamage).toBe(1);

  const tieFightBack = CoCEngine.combatCheck(
    50, 50, "1d1", 0, 0, false, undefined, "fight_back", "1d1", undefined,
    { random: sequence([0.29, 0.29, 0]) },
  );
  expect(tieFightBack.hit).toBe(true);
  expect(tieFightBack.counterHit).toBe(false);
  expect(tieFightBack.counterDamage).toBeUndefined();

  const winningDodge = CoCEngine.combatCheck(
    50, 50, "1d1", 0, 0, false, undefined, "dodge", "1d1", undefined,
    { random: sequence([0.29, 0.19, 0]) },
  );
  expect(winningDodge.hit).toBe(false);
  expect(winningDodge.counterHit).toBe(false);
  expect(winningDodge.counterDamage).toBeUndefined();
});

test("the legacy damage-critical flag does not bypass success-level dodge resolution", () => {
  const unopposed = CoCEngine.combatCheck(
    50, null, "1d1", 0, 0, false, undefined, "dodge", undefined, undefined,
    { profile: "game-session-legacy", random: sequence([0.01, 0]) },
  );
  const result = CoCEngine.combatCheck(
    50, 90, "1d1", 0, 0, false, undefined, "dodge", undefined, undefined,
    { profile: "game-session-legacy", random: sequence([0.01, 0]) },
  );
  // Legacy GameSession treats roll 2 at skill 50 as critical damage, but its
  // true CoC level is only extreme. A defense critical must still dodge it.
  expect(unopposed.isCritical).toBe(true);
  expect(unopposed.successLevel).toBe("extreme");
  expect(result.successLevel).toBe("extreme");
  expect(result.defenseSuccessLevel).toBe("critical");
  expect(result.hit).toBe(false);
});

test("RulesEngine forwards an explicit fight-back mode instead of treating it as dodge", () => {
  const result = new RulesEngine().adjudicateAttack(
    { action: "attack", target: defender.id, fightBack: true },
    { id: "attacker", name: "Attacker", proficiency: 2, abilities: {}, hasSneakAttack: false },
    defender,
    "cosmic-horror",
    false, false, undefined,
    50, 50, "1d1", undefined, "fight_back", "1d1", undefined,
    { random: sequence([0.29, 0.29, 0]) },
  );
  expect(result.hit).toBe(true);
  expect(result.counterHit).toBe(false);
  expect(result.counterDamage).toBeUndefined();
});

test("RulesEngine maps an explicitly declared ActionIntent fightBack to the fight-back mode", () => {
  const result = new RulesEngine().adjudicateAttack(
    { action: "attack", target: defender.id, fightBack: true },
    { id: "attacker", name: "Attacker", proficiency: 2, abilities: {}, hasSneakAttack: false },
    defender,
    "cosmic-horror",
    false, false, undefined,
    50, 50, "1d1", undefined, undefined, "1d1", undefined,
    { random: sequence([0.29, 0.29, 0]) },
  );
  expect(result.hit).toBe(true);
  expect(result.counterHit).toBe(false);
});

test("RulesEngine rejects a mode that conflicts with an explicitly declared fight-back intent", () => {
  expect(() => new RulesEngine().adjudicateAttack(
    { action: "attack", target: defender.id, fightBack: true },
    { id: "attacker", name: "Attacker", proficiency: 2, abilities: {}, hasSneakAttack: false },
    defender,
    "cosmic-horror",
    false, false, undefined,
    50, 50, "1d1", undefined, "dodge", undefined, undefined,
    { random: sequence([0.29, 0.29, 0]) },
  )).toThrow("conflicts");
});

test("ordinary NPC counterattack records a player dodge when defense critical exceeds the attack", async () => {
  const originalRandom = Math.random;
  const id = "ordinary-defense-critical";
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
  try {
    restoreSignedOrdinaryWorld(session, OFFLINE_CONFIG, (world) => world.upsertEntity({
      id: "critical-dodge-npc", name: "Critical Dodge NPC", type: "monster", hp: 20, maxHp: 20,
      ac: 0, status: [], position: "tavern", scene_id: "tavern",
    }));
    expect(session.updateActiveCharacter({ skillValues: { dodge: 90 } })).toMatchObject({ status: "updated" });
    const beforeHp = session.activeCharacter?.hp;
    // The public attack opens ordinary combat. The player misses; the NPC's
    // hard success is then beaten by the player's critical dodge.
    Math.random = sequence([0.99, 0.5, 0.01, 0]);
    expect((await session.act("攻击 Critical Dodge NPC")).error).toBeUndefined();
    expect(session.activeCharacter?.hp).toBe(beforeHp);
    expect(session.skillGrowthMarks).toEqual(["dodge"]);
  } finally {
    Math.random = originalRandom;
    session.close();
  }
});
