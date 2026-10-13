// ============================================================
// 贸易系统 - 市场价格、供需与贸易路线管理
// Trade System — market pricing, supply/demand, trade routes
// ============================================================

import {
  ResourceDef, ResourceCategory, Market, MarketEntry, TradeRoute,
  EconomyEvent, EconomyEventType
} from "./types";
import type { TradeSystemSnapshot } from "./politico-economy-snapshot";

export class TradeSystem {
  resources: Map<string, ResourceDef> = new Map();
  markets: Map<string, Market> = new Map();
  tradeRoutes: Map<string, TradeRoute> = new Map();
  events: EconomyEvent[] = [];
  round: number = 0;

  private routeMarketMap: Map<string, { fromMarketId: string; toMarketId: string }> = new Map();
  private eventCounter: number = 0;

  constructor() {
    this.registerDefaultResources();
  }

  // 注册资源类型 / Register a new resource definition
  registerResource(config: {
    id: string;
    name: string;
    category: ResourceCategory;
    basePrice: number;
    description: string;
    isFinite?: boolean;
  }): ResourceDef {
    const def: ResourceDef = {
      id: config.id,
      name: config.name,
      category: config.category,
      basePrice: config.basePrice,
      description: config.description,
      isFinite: config.isFinite ?? false,
    };
    this.resources.set(config.id, def);
    return def;
  }

  // 注册默认资源 / Seed common resource definitions
  registerDefaultResources(): void {
    this.registerResource({ id: "food", name: "粮食", category: "food", basePrice: 5, description: "基本生存物资" });
    this.registerResource({ id: "wood", name: "木材", category: "raw_material", basePrice: 3, description: "建筑材料" });
    this.registerResource({ id: "stone", name: "石料", category: "raw_material", basePrice: 4, description: "建筑材料" });
    this.registerResource({ id: "iron", name: "铁矿", category: "raw_material", basePrice: 8, description: "金属原料" });
    this.registerResource({ id: "spirit_stone", name: "灵石", category: "magical", basePrice: 50, description: "修炼与魔法能源" });
    this.registerResource({ id: "herbs", name: "药草", category: "luxury", basePrice: 12, description: "炼金与医疗材料" });
    this.registerResource({ id: "silk", name: "丝绸", category: "luxury", basePrice: 20, description: "高档织物" });
    this.registerResource({ id: "weapons", name: "兵器", category: "military", basePrice: 15, description: "军事装备" });
    this.registerResource({ id: "mana_crystal", name: "魔力结晶", category: "magical", basePrice: 80, description: "高纯度魔法能源" });
    this.registerResource({ id: "artifact", name: "古物", category: "strategic", basePrice: 200, description: "远古遗物" });
  }

  // 创建市场 / Create a new market
  createMarket(config: {
    id: string;
    name: string;
    location: string;
    controlledBy: string;
    taxRate?: number;
  }): Market {
    const market: Market = {
      id: config.id,
      name: config.name,
      location: config.location,
      controlledBy: config.controlledBy,
      entries: {},
      tradeRoutes: [],
      taxRate: config.taxRate ?? 0.05,
      lastUpdateRound: this.round,
    };
    this.markets.set(config.id, market);
    return market;
  }

  // 获取市场 / Get a market by ID
  getMarket(id: string): Market | undefined {
    return this.markets.get(id);
  }

  // 获取所有市场 / Get all registered markets
  getAllMarkets(): Market[] {
    return Array.from(this.markets.values());
  }

  /** Internal persistence primitive. Untrusted snapshots are validated by the engine. */
  exportForSnapshot(): TradeSystemSnapshot {
    return {
      resources: Array.from(this.resources.values()),
      markets: Array.from(this.markets.values()).map(market => ({
        id: market.id,
        name: market.name,
        location: market.location,
        controlledBy: market.controlledBy,
        entries: market.entries,
        tradeRouteIds: market.tradeRoutes.map(route => route.id),
        taxRate: market.taxRate,
        lastUpdateRound: market.lastUpdateRound,
      })),
      tradeRoutes: Array.from(this.tradeRoutes.values()),
      routeMarketMap: Array.from(this.routeMarketMap, ([routeId, markets]) => ({ routeId, ...markets })),
      events: this.events,
      round: this.round,
      eventCounter: this.eventCounter,
    };
  }

  /** Internal persistence primitive. Call only with validatePoliticoEconomySnapshot output. */
  replaceFromSnapshot(snapshot: TradeSystemSnapshot): void {
    const routes = new Map(snapshot.tradeRoutes.map(route => [route.id, route]));
    this.resources = new Map(snapshot.resources.map(resource => [resource.id, resource]));
    this.tradeRoutes = routes;
    this.markets = new Map(snapshot.markets.map(market => [market.id, {
      id: market.id,
      name: market.name,
      location: market.location,
      controlledBy: market.controlledBy,
      entries: market.entries,
      tradeRoutes: market.tradeRouteIds.map(routeId => routes.get(routeId)!),
      taxRate: market.taxRate,
      lastUpdateRound: market.lastUpdateRound,
    }]));
    this.routeMarketMap = new Map(snapshot.routeMarketMap.map(link => [link.routeId, {
      fromMarketId: link.fromMarketId,
      toMarketId: link.toMarketId,
    }]));
    this.events = snapshot.events;
    this.round = snapshot.round;
    this.eventCounter = snapshot.eventCounter;
  }

  // 设置价格 / Set or update a resource price in a market
  setPrice(marketId: string, resourceId: string, price: number): void {
    const market = this.markets.get(marketId);
    if (!market) return;

    const existing = market.entries[resourceId];
    if (existing) {
      existing.trend = price > existing.price ? "rising" : price < existing.price ? "falling" : "stable";
      existing.price = price;
      existing.lastUpdatedRound = this.round;
    } else {
      market.entries[resourceId] = {
        resourceId,
        price,
        supply: 0,
        demand: 0,
        trend: "stable",
        lastUpdatedRound: this.round,
      };
    }
    market.lastUpdateRound = this.round;
  }

  // 调整供给 / Adjust supply level and auto-correct price
  adjustSupply(marketId: string, resourceId: string, delta: number): void {
    const market = this.markets.get(marketId);
    if (!market) return;

    let entry = this.ensureEntry(market, resourceId);
    const oldSupply = entry.supply;
    entry.supply = Math.max(0, entry.supply + delta);

    if (oldSupply > 0) {
      const ratio = (entry.supply - oldSupply) / oldSupply;
      if (ratio >= 0.2) {
        entry.price = Math.round(entry.price * 0.9);
      } else if (ratio <= -0.2) {
        entry.price = Math.round(entry.price * 1.15);
      }
    }
    entry.lastUpdatedRound = this.round;
    market.lastUpdateRound = this.round;
  }

  // 调整需求 / Adjust demand level and auto-correct price
  adjustDemand(marketId: string, resourceId: string, delta: number): void {
    const market = this.markets.get(marketId);
    if (!market) return;

    let entry = this.ensureEntry(market, resourceId);
    const oldDemand = entry.demand;
    entry.demand = Math.max(0, entry.demand + delta);

    if (oldDemand > 0) {
      const ratio = (entry.demand - oldDemand) / oldDemand;
      if (ratio >= 0.2) {
        entry.price = Math.round(entry.price * 1.1);
      } else if (ratio <= -0.2) {
        entry.price = Math.round(entry.price * 0.9);
      }
    }
    entry.lastUpdatedRound = this.round;
    market.lastUpdateRound = this.round;
  }

  // 建立贸易路线 / Establish a trade route between two markets
  establishTradeRoute(
    fromMarketId: string,
    toMarketId: string,
    resourceId: string,
    volume: number,
    price: number
  ): TradeRoute | null {
    const fromMarket = this.markets.get(fromMarketId);
    const toMarket = this.markets.get(toMarketId);
    if (!fromMarket || !toMarket || fromMarketId === toMarketId) return null;
    if (!fromMarket.entries[resourceId] || !toMarket.entries[resourceId]) return null;

    const routeId = this.nextTradeRouteId();
    const route: TradeRoute = {
      id: routeId,
      fromFactionId: fromMarket.controlledBy,
      toFactionId: toMarket.controlledBy,
      resourceId,
      volume,
      price,
      active: true,
      establishedRound: this.round,
    };

    this.tradeRoutes.set(routeId, route);
    this.routeMarketMap.set(routeId, { fromMarketId, toMarketId });
    fromMarket.tradeRoutes.push(route);
    toMarket.tradeRoutes.push(route);

    return route;
  }

  /**
   * Wall-clock time and ambient entropy are only a convenient route-id prefix,
   * not a uniqueness authority. Tests, replay tools, and hosts may freeze either
   * source, so reserve a deterministic suffix whenever that prefix is occupied.
   */
  private nextTradeRouteId(): string {
    const prefix = `route_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let candidate = prefix;
    let collision = 0;
    while (this.tradeRoutes.has(candidate)) {
      collision++;
      candidate = `${prefix}_${collision}`;
    }
    return candidate;
  }

  // 移除贸易路线 / Remove and deactivate a trade route
  removeTradeRoute(routeId: string): boolean {
    const route = this.tradeRoutes.get(routeId);
    if (!route) return false;

    route.active = false;

    for (const market of this.markets.values()) {
      market.tradeRoutes = market.tradeRoutes.filter(r => r.id !== routeId);
    }

    this.routeMarketMap.delete(routeId);

    this.addEvent({
      type: "trade_disruption",
      description: `贸易路线 ${routeId} 已关闭`,
      affectedFactions: [route.fromFactionId, route.toFactionId],
      data: { routeId, resourceId: route.resourceId },
    });

    return true;
  }

  // 计算价格（含税）/ Calculate final price with tax
  calculatePrice(
    marketId: string,
    resourceId: string,
    buyerFactionId?: string,
    sellerFactionId?: string
  ): number {
    const market = this.markets.get(marketId);
    if (!market) return 0;

    const entry = market.entries[resourceId];
    if (!entry) {
      const def = this.resources.get(resourceId);
      return def ? def.basePrice : 0;
    }

    let finalPrice = entry.price;

    if (buyerFactionId && sellerFactionId && buyerFactionId !== sellerFactionId) {
      finalPrice = Math.round(finalPrice * (1 + market.taxRate));
    }

    return finalPrice;
  }

  // 推进回合 / Advance one economic round
  advanceRound(): EconomyEvent[] {
    this.round++;
    const newEvents: EconomyEvent[] = [];

    for (const market of this.markets.values()) {
      for (const entry of Object.values(market.entries)) {
        const consumed = Math.round(entry.supply * 0.1);
        entry.supply = Math.max(0, entry.supply - consumed);

        const def = this.resources.get(entry.resourceId);
        if (def) {
          const diff = def.basePrice - entry.price;
          entry.price = Math.round(entry.price + diff * 0.05);
        }

        entry.price = Math.round(entry.price * (0.95 + Math.random() * 0.1));
        entry.lastUpdatedRound = this.round;
      }
      market.lastUpdateRound = this.round;
    }

    for (const [routeId, route] of this.tradeRoutes) {
      if (!route.active) continue;

      const rm = this.routeMarketMap.get(routeId);
      if (!rm) continue;

      const fromMarket = this.markets.get(rm.fromMarketId);
      const toMarket = this.markets.get(rm.toMarketId);
      if (!fromMarket || !toMarket) continue;

      const fromEntry = fromMarket.entries[route.resourceId];
      const toEntry = toMarket.entries[route.resourceId];
      if (!fromEntry || !toEntry) continue;

      const transferAmount = Math.min(route.volume, fromEntry.supply);
      if (transferAmount > 0) {
        fromEntry.supply -= transferAmount;
        toEntry.supply += transferAmount;

        newEvents.push({
          id: `evt_${this.round}_${++this.eventCounter}`,
          type: "market_shift" as EconomyEventType,
          round: this.round,
          description: `贸易 ${fromMarket.name} → ${toMarket.name}: ${transferAmount} ${route.resourceId}`,
          affectedFactions: [route.fromFactionId, route.toFactionId],
          data: { routeId, resourceId: route.resourceId, volume: transferAmount },
        });
      }
    }

    for (const event of newEvents) {
      this.addEvent(event);
    }

    return newEvents;
  }

  // 获取资源定义 / Get resource definition by ID
  getResourceDef(id: string): ResourceDef | undefined {
    return this.resources.get(id);
  }

  // 获取系统状态 / Get current system state snapshot
  getState(): { markets: Market[]; recentEvents: EconomyEvent[]; round: number } {
    return {
      markets: Array.from(this.markets.values()),
      recentEvents: [...this.events],
      round: this.round,
    };
  }

  // ── 内部方法 ──

  private ensureEntry(market: Market, resourceId: string): MarketEntry {
    let entry = market.entries[resourceId];
    if (!entry) {
      entry = {
        resourceId,
        price: this.resources.get(resourceId)?.basePrice ?? 0,
        supply: 0,
        demand: 0,
        trend: "stable",
        lastUpdatedRound: this.round,
      };
      market.entries[resourceId] = entry;
    }
    return entry;
  }

  private addEvent(data: {
    type: EconomyEventType;
    description: string;
    affectedFactions: string[];
    data?: Record<string, unknown>;
  }): void {
    const event: EconomyEvent = {
      id: `evt_${++this.eventCounter}`,
      type: data.type,
      round: this.round,
      description: data.description,
      affectedFactions: data.affectedFactions,
      data: data.data,
    };
    this.events.push(event);
    if (this.events.length > 100) {
      this.events.shift();
    }
  }
}
