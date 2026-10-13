import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { CompanionManager } from "../combat/companion-manager";
import { restoreSignedOrdinaryCompanion } from "./helpers/ordinary-companion-fixture";
import type { CompanionConfig } from "../types";

const LLM = {
  apiKey: "sk-companion-read-facade-test",
  baseUrl: "http://companion-read-facade.invalid/v1",
  model: "companion-read-facade-test",
  maxTokens: 32,
  temperature: 0,
};

const COMPANION: CompanionConfig = {
  id: "read-facade-ally",
  name: "老李",
  type: "npc",
  behavior: "support",
  hp: 8,
  maxHp: 8,
  ac: 10,
  skills: { fight: 55 },
  damageDice: "1d3",
  inventory: ["flashlight"],
  traits: { courage: 5, aggression: 2, caution: 6, loyalty: 7, cruelty: 1 },
};

function installSignedCompanion(target: GameSession): void {
  restoreSignedOrdinaryCompanion(target, LLM, COMPANION);
}

function freshTarget(id = `companion-read-facade-${crypto.randomUUID()}`): GameSession {
  return new GameSession(id, "cosmic-horror", LLM);
}

describe("GameSession companion-manager reference authority", () => {
  it("exposes a frozen data-only reader rather than CompanionManager write authority", () => {
    const session = freshTarget();
    try {
      const facade = session.companionManager as unknown as Record<string | symbol, unknown>;
      expect(Object.isFrozen(facade)).toBe(true);
      expect(Reflect.ownKeys(facade).sort()).toEqual([
        "findByEntityId", "getActiveCompanions", "getCommandObeyState", "getControl",
        "getMorale", "getPlayerControlled", "hasActed", "hasItem", "isActive",
        "listItems", "resolveWeapon",
      ]);
      for (const forbidden of [
        "recruit", "markInvited", "handleDeparture", "adjustMorale", "adjustMoraleByEntity",
        "setBehavior", "setControl", "transferControl", "markActed", "newRound",
        "exportSnapshot", "restoreSnapshot", "getAllStates", "command", "takeLastRefusal",
        "checkResolve", "tickResolve", "giveItem", "takeItem", "processTurn", "clearAll",
        "agents", "world", "companions",
      ]) expect(forbidden in facade).toBe(false);
    } finally {
      session.close();
    }
  });

  it("returns fresh recursively frozen companion observations after a real signed restore", () => {
    const session = freshTarget();
    try {
      const facade = session.companionManager;
      installSignedCompanion(session);
      expect(session.companionManager).toBe(facade);
      expect(facade.getMorale(COMPANION.id)).toBe(10);
      expect(facade.isActive(COMPANION.id)).toBe(true);

      const first = facade.getActiveCompanions();
      const second = facade.getActiveCompanions();
      const state = first[0]!;
      expect(first).not.toBe(second);
      expect(state).not.toBe(second[0]);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.config)).toBe(true);
      expect(Object.isFrozen(state.config.skills!)).toBe(true);
      expect(Object.isFrozen(state.inventory)).toBe(true);
      expect(() => (state.inventory as string[]).push("forged-item")).toThrow(TypeError);
      expect(() => ((state.config.skills as Record<string, number>).fight = -999)).toThrow(TypeError);

      const found = facade.findByEntityId(state.entityId)!;
      expect(found).not.toBe(state);
      expect(Object.isFrozen(found.config)).toBe(true);
      expect(facade.listItems(COMPANION.id)).toEqual(["flashlight"]);
      const items = facade.listItems(COMPANION.id);
      expect(items).not.toBe(facade.listItems(COMPANION.id));
      expect(Object.isFrozen(items)).toBe(true);
      expect(() => (items as string[]).pop()).toThrow(TypeError);
      expect(facade.listItems(COMPANION.id)).toEqual(["flashlight"]);
      const obey = facade.getCommandObeyState(COMPANION.id);
      expect(Object.isFrozen(obey)).toBe(true);
      expect(() => ((obey as { obey: boolean }).obey = false)).toThrow(TypeError);
    } finally {
      session.close();
    }
  });

  it("observes current private companion state but rejects public whole-manager replacement", async () => {
    const session = freshTarget();
    try {
      const original = session.companionManager;
      installSignedCompanion(session);
      expect(Object.getOwnPropertyDescriptor(session, "companionManager")).toBeUndefined();
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), "companionManager");
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.set).toBeUndefined();
      expect(Reflect.set(session as object, "companionManager", new CompanionManager())).toBe(false);
      expect(() => Object.assign(session as object, { companionManager: new CompanionManager() })).toThrow(TypeError);
      expect(session.companionManager).toBe(original);

      expect((await session.act("接管 老李")).error).toBeUndefined();
      expect(original.getControl(COMPANION.id)).toBe("player:p1");
      const controlled = original.getPlayerControlled("p1");
      expect(controlled).toHaveLength(1);
      expect(Object.isFrozen(controlled)).toBe(true);
      expect(Object.isFrozen(controlled[0]!.config)).toBe(true);
    } finally {
      session.close();
    }
  });

  it("keeps snapshot, player view, and local control actions on private authority after a throwing public shadow", async () => {
    const session = freshTarget();
    const restored = freshTarget(session.id);
    const facade = session.companionManager;
    const shadow = Object.freeze({
      getMorale(): never { throw new Error("public companion shadow must not be consulted internally"); },
      isActive(): never { throw new Error("public companion shadow must not be consulted internally"); },
      getActiveCompanions(): never { throw new Error("public companion shadow must not be consulted internally"); },
      findByEntityId(): never { throw new Error("public companion shadow must not be consulted internally"); },
      getControl(): never { throw new Error("public companion shadow must not be consulted internally"); },
      getPlayerControlled(): never { throw new Error("public companion shadow must not be consulted internally"); },
      hasActed(): never { throw new Error("public companion shadow must not be consulted internally"); },
      listItems(): never { throw new Error("public companion shadow must not be consulted internally"); },
      hasItem(): never { throw new Error("public companion shadow must not be consulted internally"); },
      resolveWeapon(): never { throw new Error("public companion shadow must not be consulted internally"); },
      getCommandObeyState(): never { throw new Error("public companion shadow must not be consulted internally"); },
    });
    try {
      installSignedCompanion(session);
      Object.defineProperty(session, "companionManager", { value: shadow, configurable: true });
      expect(session.companionManager).toBe(shadow);
      expect(session.getState().companions).toHaveLength(1);
      expect((await session.act("接管 老李")).error).toBeUndefined();
      expect(facade.getControl(COMPANION.id)).toBe("player:p1");

      const snapshot = session.exportOrdinarySessionSnapshot();
      expect(snapshot.companionManager.companions).toHaveLength(1);
      restored.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
      expect(restored.companionManager.getControl(COMPANION.id)).toBe("player:p1");
    } finally {
      session.close();
      restored.close();
    }
  });
});
