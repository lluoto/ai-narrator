import { describe, expect, test } from "bun:test";
import { PoliticoEconomyEngine } from "../economy/politic-economy-engine";
import { validatePoliticoEconomySnapshot } from "../economy/politico-economy-snapshot";

function withDeterministicEntropy<T>(run: () => T): T {
  const originalRandom = Math.random;
  const originalNow = Date.now;
  Math.random = () => 0.5;
  Date.now = () => 1_700_000_000_000;
  try {
    return run();
  } finally {
    Math.random = originalRandom;
    Date.now = originalNow;
  }
}

describe("PoliticoEconomyEngine portable snapshots", () => {
  test("restores every mutable subsystem state and preserves deterministic follow-up behavior", () => {
    const source = new PoliticoEconomyEngine();

    withDeterministicEntropy(() => {
      source.factions.proposeTreaty("arcane_council", "merchant_guild", "trade", "snapshot treaty", 12);
      const route = source.trades.getMarket("fortress_market")!.tradeRoutes[0];
      source.trades.removeTradeRoute(route.id);
      source.finances.issueLoan("central_bank", "merchant_guild", 20, "gold_coin", 5, 2, "collateral");
      source.finances.triggerCrisis({
        type: "inflation",
        severity: 2,
        name: "snapshot crisis",
        description: "state must survive restart",
        affectedFactionIds: ["merchant_guild"],
      });
      source.advanceRound("snapshot-round-1");
      source.advanceRound("snapshot-round-2");
    });

    const snapshot = source.exportSnapshot();
    const restored = new PoliticoEconomyEngine();
    restored.restoreSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(restored.exportSnapshot()).toEqual(snapshot);
    expect(restored.advanceRound("snapshot-round-2")).toEqual([]);

    withDeterministicEntropy(() => {
      expect(restored.advanceRound("snapshot-round-3"))
        .toEqual(source.advanceRound("snapshot-round-3"));

      const policyConfig = {
        name: "restored policy",
        description: "checks the policy event ID sequence",
        factionId: "arcane_council",
        category: "economic" as const,
        effects: [],
      };
      expect(restored.policies.definePolicy(policyConfig).id)
        .toBe(source.policies.definePolicy(policyConfig).id);

      const crisisConfig = {
        type: "market_crash" as const,
        severity: 1,
        name: "next crisis",
        description: "checks the crisis ID sequence",
        affectedFactionIds: ["merchant_guild"],
      };
      expect(restored.finances.triggerCrisis(crisisConfig).id)
        .toBe(source.finances.triggerCrisis(crisisConfig).id);
    });

    expect(restored.exportSnapshot()).toEqual(source.exportSnapshot());
  });

  test("rejects tampering, unknown keys, duplicates, and broken references atomically", () => {
    const source = new PoliticoEconomyEngine();
    const snapshot = source.exportSnapshot();
    const duplicateFaction = JSON.parse(JSON.stringify(snapshot));
    duplicateFaction.factions.push(duplicateFaction.factions[0]);
    const brokenMarketReference = JSON.parse(JSON.stringify(snapshot));
    brokenMarketReference.trades.markets[0].controlledBy = "missing_faction";

    const invalidSnapshots: unknown[] = [
      { ...snapshot, unexpected: true },
      duplicateFaction,
      brokenMarketReference,
      { ...snapshot, round: Number.NaN },
    ];

    for (const invalidSnapshot of invalidSnapshots) {
      const target = new PoliticoEconomyEngine();
      const before = target.exportSnapshot();

      expect(() => target.restoreSnapshot(invalidSnapshot)).toThrow();
      expect(target.exportSnapshot()).toEqual(before);
    }
  });

  test("exports a deep JSON-safe copy", () => {
    const engine = new PoliticoEconomyEngine();
    engine.factions.addFaction({ id: "optional-fields", name: "optional fields", type: "guild" });
    const snapshot = engine.exportSnapshot();
    snapshot.factions[0].treasury = 0;
    snapshot.trades.markets[0].entries.food.supply = 0;

    expect(engine.factions.getAllFactions()[0].treasury).not.toBe(0);
    expect(engine.trades.getAllMarkets()[0].entries.food.supply).not.toBe(0);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  test("rejects non-JSON own properties without evaluating accessors", () => {
    const snapshot = new PoliticoEconomyEngine().exportSnapshot();
    Object.defineProperty(snapshot, "hidden", { value: true, enumerable: false });
    expect(() => validatePoliticoEconomySnapshot(snapshot)).toThrow(/non-enumerable property hidden/);

    const accessorSnapshot = new PoliticoEconomyEngine().exportSnapshot();
    Object.defineProperty(accessorSnapshot.factions[0], "name", {
      enumerable: true,
      get: () => { throw new Error("accessor was evaluated"); },
    });
    expect(() => validatePoliticoEconomySnapshot(accessorSnapshot)).toThrow(/accessor property/);

    const sparseSnapshot = new PoliticoEconomyEngine().exportSnapshot();
    sparseSnapshot.events = new Array(1);
    expect(() => validatePoliticoEconomySnapshot(sparseSnapshot)).toThrow(/sparse array/);

    const prototypeSnapshot = new PoliticoEconomyEngine().exportSnapshot();
    prototypeSnapshot.factions[0].resources = JSON.parse('{"__proto__":1}');
    expect(() => validatePoliticoEconomySnapshot(prototypeSnapshot)).toThrow(/reserved key __proto__/);
  });

  test("rejects persisted counters that would reuse policy, trade, or crisis identities", () => {
    const policySnapshot = new PoliticoEconomyEngine().exportSnapshot();
    policySnapshot.policies.eventCounter = 0;
    expect(() => validatePoliticoEconomySnapshot(policySnapshot)).toThrow(/policies\.eventCounter/);

    const tradeEngine = new PoliticoEconomyEngine();
    tradeEngine.trades.removeTradeRoute(tradeEngine.trades.getMarket("fortress_market")!.tradeRoutes[0].id);
    const tradeSnapshot = tradeEngine.exportSnapshot();
    tradeSnapshot.trades.eventCounter = 0;
    expect(() => validatePoliticoEconomySnapshot(tradeSnapshot)).toThrow(/trades\.eventCounter/);

    const financeEngine = new PoliticoEconomyEngine();
    financeEngine.finances.triggerCrisis({
      type: "inflation",
      severity: 1,
      name: "counter test",
      description: "counter must survive a restore",
      affectedFactionIds: ["merchant_guild"],
    });
    const financeSnapshot = financeEngine.exportSnapshot();
    financeSnapshot.finances.crisisCounter = 0;
    expect(() => validatePoliticoEconomySnapshot(financeSnapshot)).toThrow(/finances\.crisisCounter/);
    financeSnapshot.finances.crisisCounter = 1;
    financeSnapshot.finances.eventCounter = 0;
    expect(() => validatePoliticoEconomySnapshot(financeSnapshot)).toThrow(/finances\.eventCounter/);
  });

  test("rejects duplicate market route links", () => {
    const snapshot = new PoliticoEconomyEngine().exportSnapshot();
    const routeIds = snapshot.trades.markets[0].tradeRouteIds;
    routeIds.push(routeIds[0]);

    expect(() => validatePoliticoEconomySnapshot(snapshot)).toThrow(/contains duplicate members/);
  });

  test("keeps seeded trade routes persistable when time and entropy collide", () => {
    withDeterministicEntropy(() => {
      const engine = new PoliticoEconomyEngine();
      const snapshot = engine.exportSnapshot();

      expect(new Set(snapshot.trades.tradeRoutes.map((route) => route.id)).size)
        .toBe(snapshot.trades.tradeRoutes.length);
      for (const market of snapshot.trades.markets) {
        expect(new Set(market.tradeRouteIds).size).toBe(market.tradeRouteIds.length);
      }
      expect(() => validatePoliticoEconomySnapshot(snapshot)).not.toThrow();
    });
  });

  test("does not create a self-route that cannot be represented once per market", () => {
    const engine = new PoliticoEconomyEngine();

    expect(engine.trades.establishTradeRoute("capital_market", "capital_market", "food", 1, 5)).toBeNull();
  });

  test("rejects unpersistable causation IDs before mutating the round", () => {
    const engine = new PoliticoEconomyEngine();
    const before = engine.exportSnapshot();

    expect(() => engine.advanceRound("x".repeat(161))).toThrow(/causationId/);
    expect(engine.exportSnapshot()).toEqual(before);

    const atCapacity = new PoliticoEconomyEngine();
    const capacitySnapshot = atCapacity.exportSnapshot();
    capacitySnapshot.consumedCausationIds = Array.from({ length: 10_000 }, (_, index) => `causation-${index}`);
    atCapacity.restoreSnapshot(capacitySnapshot);
    const capacityBefore = atCapacity.exportSnapshot();
    expect(() => atCapacity.advanceRound("next-causation")).toThrow(/causationId capacity/);
    expect(atCapacity.exportSnapshot()).toEqual(capacityBefore);
  });
});
