import { describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { PoliticoEconomyEngine } from "../economy/politic-economy-engine";

const CONFIG = {
  apiKey: "sk-politico-economy-facade-test",
  baseUrl: "http://politico-economy-facade.invalid/v1",
  model: "politico-economy-facade-test",
  maxTokens: 32,
  temperature: 0,
};

type PublicEconomy = Record<PropertyKey, unknown>;

function session(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", CONFIG);
}

function readMethod<T>(value: PublicEconomy, name: string): (...args: never[]) => T {
  const method = value[name];
  if (typeof method !== "function") throw new Error(`public economy facade lacks ${name}`);
  return (...args: never[]) => Reflect.apply(method, value, args) as T;
}

describe("GameSession politico-economy public observation facade", () => {
  test("uses a getter-only prototype reference instead of a replaceable own engine", () => {
    const source = session(`politico-economy-shape-${Math.random()}`);
    try {
      const observed = source.politicoEconomy;
      const own = Object.getOwnPropertyDescriptor(source, "politicoEconomy");
      const proto = Object.getOwnPropertyDescriptor(GameSession.prototype, "politicoEconomy");

      expect(own).toBeUndefined();
      expect(proto?.get).toBeInstanceOf(Function);
      expect(proto?.set).toBeUndefined();
      expect(() => Object.assign(source, { politicoEconomy: new PoliticoEconomyEngine() })).toThrow(TypeError);
      expect(source.politicoEconomy).toBe(observed);
    } finally {
      source.close();
    }
  });

  test("exposes exactly the detached read surface and never child systems or mutators", () => {
    const source = session(`politico-economy-surface-${Math.random()}`);
    try {
      const facade = source.politicoEconomy as unknown as PublicEconomy;
      expect(Object.isFrozen(facade)).toBe(true);
      expect(Reflect.ownKeys(facade).map(String).sort()).toEqual([
        "getBriefState",
        "getDiplomaticContext",
        "getEconomyVizData",
        "getState",
        "renderEconomyHtml",
        "round",
      ]);
      expect(Object.getOwnPropertyDescriptor(facade, "round")).toMatchObject({
        enumerable: true,
        get: expect.any(Function),
        set: undefined,
      });

      for (const forbidden of [
        "factions", "trades", "policies", "finances", "events",
        "advanceRound", "exportSnapshot", "restoreSnapshot", "handleAction",
      ]) {
        expect(facade[forbidden]).toBeUndefined();
      }

      expect(typeof readMethod<string>(facade, "getDiplomaticContext")()).toBe("string");
      expect(typeof readMethod<string>(facade, "renderEconomyHtml")()).toBe("string");
      expect((facade.round as number)).toBe(0);
    } finally {
      source.close();
    }
  });

  test("detaches and recursively freezes nested faction relations and market entries", () => {
    const source = session(`politico-economy-detached-${Math.random()}`);
    try {
      const facade = source.politicoEconomy as unknown as PublicEconomy;
      const state = readMethod<{
        factions: Array<{ treasury: number; relations: Record<string, { score: number }> }>;
        markets: Array<{ entries: Record<string, { price: number }> }>;
      }>(facade, "getState")();
      const faction = state.factions.find((entry) => Object.keys(entry.relations).length > 0);
      const relation = faction && Object.values(faction.relations)[0];
      const market = state.markets.find((entry) => entry.entries.food !== undefined);
      if (!faction || !relation || !market) throw new Error("fixture requires seeded faction relations and a food market entry");

      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(faction)).toBe(true);
      expect(Object.isFrozen(faction.relations)).toBe(true);
      expect(Object.isFrozen(relation)).toBe(true);
      expect(Object.isFrozen(market.entries)).toBe(true);
      expect(Object.isFrozen(market.entries.food)).toBe(true);
      expect(() => { faction.treasury++; }).toThrow(TypeError);
      expect(() => { relation.score++; }).toThrow(TypeError);
      expect(() => { market.entries.food.price++; }).toThrow(TypeError);

      const fresh = readMethod<typeof state>(facade, "getState")();
      expect(fresh.factions.find((entry) => Object.keys(entry.relations).length > 0)?.treasury).toBe(faction.treasury);
      expect(fresh.markets.find((entry) => entry.entries.food !== undefined)?.entries.food.price).toBe(market.entries.food.price);
    } finally {
      source.close();
    }
  });

  test("reflection masking cannot redirect ordinary snapshot restore or the tenth economy tick", async () => {
    const id = `politico-economy-reflection-${Math.random()}`;
    const source = session(id);
    const target = session(id);
    try {
      const snapshot = source.exportOrdinarySessionSnapshot();
      const decoy = {
        get round(): number { throw new Error("public economy round was used"); },
        exportSnapshot(): never { throw new Error("public economy export was used"); },
        restoreSnapshot(): never { throw new Error("public economy restore was used"); },
        advanceRound(): never { throw new Error("public economy tick was used"); },
        getBriefState(): never { throw new Error("public economy brief state was used"); },
      };
      Object.defineProperty(target, "politicoEconomy", { value: decoy, configurable: true });
      expect(target.politicoEconomy).toBe(decoy as unknown as typeof target.politicoEconomy);

      expect(() => target.restoreOrdinarySessionSnapshot(snapshot)).not.toThrow();
      // `round` is a session-owned counter, not a test setup mutator. Reach
      // the real tenth turn through the same ordinary action path that owns
      // the economy clock.
      for (let turn = 0; turn < 10; turn++) {
        expect((await target.act("/roll 1d6")).error).toBeUndefined();
      }
      expect(target.getSummary().round).toBe(10);
      expect(target.exportOrdinarySessionSnapshot().politicoEconomy.round).toBe(1);
    } finally {
      source.close();
      target.close();
    }
  });
});
