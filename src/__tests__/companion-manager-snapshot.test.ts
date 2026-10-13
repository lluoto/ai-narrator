import { describe, expect, test } from "bun:test";
import { CompanionManager } from "../combat/companion-manager";
import { WorldStateManager } from "../state/world-state-manager";
import type { CompanionConfig } from "../types";

const HILDA: CompanionConfig = {
  id: "hilda",
  name: "Hilda",
  type: "npc",
  hp: 14,
  maxHp: 14,
  ac: 14,
  skills: { fight: 60, dodge: 40 },
  damageDice: "1d6+1d4",
  weapon: "shortsword",
  behavior: "aggressive",
  faction: "player_ally",
  traits: { courage: 8, aggression: 9, caution: 3, loyalty: 5, cruelty: 7 },
  inventory: ["torch"],
  recruit: { greeting: "Join us.", skill: "persuade", dc: 50, failGreeting: "No." },
  departure: [{ trigger: "hp_zero", description: "Fallen", farewell: "Farewell", canRejoin: false }],
  motivation: "Find the truth",
};

const MARIS: CompanionConfig = {
  ...HILDA,
  id: "maris",
  name: "Maris",
  behavior: "support",
  inventory: ["notebook"],
};

function worldWithActiveHilda(): WorldStateManager {
  const world = new WorldStateManager();
  world.seedEntities([
    { id: "player", name: "Player", type: "pc", hp: 12, maxHp: 12, ac: 10, status: [], position: "melee_range" },
    { id: "enemy", name: "Enemy", type: "monster", hp: 12, maxHp: 12, ac: 10, status: [], position: "melee_range", faction: "monster" },
    { id: "companion_hilda", name: "Hilda", type: "npc", hp: 8, maxHp: 14, ac: 14, status: [], position: "melee_range", faction: "player_ally" },
  ]);
  return world;
}

describe("CompanionManager portable full snapshot", () => {
  test("round-trips registered active and inactive state without advancing or mutating world", async () => {
    const sourceWorld = worldWithActiveHilda();
    const source = new CompanionManager();
    source.recruit(HILDA, sourceWorld);
    source.markInvited("hilda");
    source.setBehavior("hilda", "defensive");
    source.setControl("hilda", "player:alice");
    source.giveItem("hilda", "rope");
    source.adjustMorale("hilda", -4);

    const hilda = source.getAllStates().get("hilda")!;
    hilda.resolveState = "berserk";
    hilda.resolveTurnsLeft = 2;
    await source.command("hilda", { action: "attack" }, sourceWorld, async () => {});
    hilda.resolveState = "steadfast";
    hilda.resolveTurnsLeft = 2;

    source.recruit(MARIS, sourceWorld);
    source.markInvited("maris");
    source.giveItem("maris", "letter");
    source.adjustMorale("maris", -3);
    source.handleDeparture("maris", sourceWorld, "player-farewell");

    const detached = source.exportSnapshot();
    detached.companions[0].config.name = "changed outside";
    expect(source.getAllStates().get("hilda")!.config.name).toBe("Hilda");
    const portable = JSON.parse(JSON.stringify(source.exportSnapshot()));

    const restoredWorld = worldWithActiveHilda();
    const worldBefore = restoredWorld.exportSnapshot();
    const restored = new CompanionManager();
    restored.restoreSnapshot(portable, restoredWorld);

    expect(restoredWorld.exportSnapshot()).toEqual(worldBefore);
    expect(restored.getAllStates().size).toBe(2);
    const restoredHilda = restored.getAllStates().get("hilda")!;
    expect(restoredHilda).toMatchObject({
      entityId: "companion_hilda",
      active: true,
      invited: true,
      inventory: ["torch", "rope"],
      morale: 6,
      behavior: "defensive",
      control: "player:alice",
      resolveState: "steadfast",
      resolveTurnsLeft: 2,
    });
    expect(restored.hasActed("hilda")).toBe(true);
    expect(restored.takeLastRefusal()).not.toBe("");

    const restoredMaris = restored.getAllStates().get("maris")!;
    expect(restoredMaris).toMatchObject({
      active: false,
      invited: true,
      inventory: ["notebook", "letter"],
      morale: 7,
      behavior: "support",
    });
    expect(restoredWorld.getEntity("companion_maris")).toBeNull();

    const hildaEntity = restoredWorld.getEntity("companion_hilda")!;
    expect(restored.selectTarget(hildaEntity, restoredWorld.getCurrentState(), "defensive")?.id).toBe("enemy");
    let commandRan = false;
    expect(await restored.command("hilda", { action: "attack" }, restoredWorld, async () => {
      commandRan = true;
    })).toBe(true);
    expect(commandRan).toBe(true);
  });

  test("rejects malformed state before replacing any manager state", () => {
    const world = worldWithActiveHilda();
    const manager = new CompanionManager();
    manager.recruit(HILDA, world);
    const before = manager.exportSnapshot();

    const malformed = JSON.parse(JSON.stringify(before)) as {
      companions: Array<{ config: Record<string, unknown> }>;
      actedThisRound: string[];
    };
    malformed.companions[0].config.unexpected = true;
    expect(() => manager.restoreSnapshot(malformed, world)).toThrow(/Invalid companion manager snapshot/);
    expect(manager.exportSnapshot()).toEqual(before);

    const duplicateEntity = JSON.parse(JSON.stringify(before)) as {
      companions: Array<{ id: string; config: { id: string }; entityId: string }>;
    };
    duplicateEntity.companions.push({
      ...duplicateEntity.companions[0],
      id: "another",
      config: { ...duplicateEntity.companions[0].config, id: "another" },
    });
    expect(() => manager.restoreSnapshot(duplicateEntity, world)).toThrow(/duplicate entityId/);

    const inactiveActed = JSON.parse(JSON.stringify(before)) as {
      companions: Array<{ id: string; active: boolean }>;
      actedThisRound: string[];
    };
    inactiveActed.companions[0].active = false;
    inactiveActed.actedThisRound = [inactiveActed.companions[0].id];
    expect(() => manager.restoreSnapshot(inactiveActed, world)).toThrow(/actedThisRound.*active/);
  });

  test("rejects explicit undefined optional values as non-JSON data", () => {
    const world = worldWithActiveHilda();
    const manager = new CompanionManager();
    manager.recruit(HILDA, world);
    const malformed = manager.exportSnapshot() as unknown as {
      companions: Array<{ config: { weapon?: string | undefined } }>;
    };
    malformed.companions[0].config.weapon = undefined;

    expect(() => manager.restoreSnapshot(malformed, world)).toThrow(/Invalid companion manager snapshot/);
  });

  test("rejects malformed legacy arrays before changing manager or world state", () => {
    const world = worldWithActiveHilda();
    const manager = new CompanionManager();
    manager.recruit(HILDA, world);
    const before = manager.exportSnapshot();
    const worldBefore = world.exportSnapshot();

    expect(() => manager.restoreSnapshot([null], world)).toThrow(/Invalid companion manager snapshot/);
    expect(manager.exportSnapshot()).toEqual(before);
    expect(world.exportSnapshot()).toEqual(worldBefore);
  });
});
