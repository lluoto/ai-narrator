// ============================================================
// 政治经济引擎 - 主编排器
// Politico-Economic Engine — orchestrates faction, trade,
// policy, and finance subsystems into a unified game module.
// ============================================================

import { FactionSystem } from "./faction-system";
import { TradeSystem } from "./trade-system";
import { PolicySystem } from "./policy-system";
import { FinanceSystem } from "./finance-system";
import {
  PoliticoEconomyState,
  FactionType,
  Policy,
  EconomyEvent,
  } from "./types";
import {
  POLITICO_ECONOMY_SNAPSHOT_MAX_CAUSATION_IDS,
  POLITICO_ECONOMY_SNAPSHOT_MAX_ID_LENGTH,
  POLITICO_ECONOMY_SNAPSHOT_VERSION,
  validatePoliticoEconomySnapshot,
} from "./politico-economy-snapshot";
import type { PoliticoEconomySnapshot } from "./politico-economy-snapshot";

export class PoliticoEconomyEngine {
  readonly factions: FactionSystem;
  readonly trades: TradeSystem;
  readonly policies: PolicySystem;
  readonly finances: FinanceSystem;

  events: EconomyEvent[];
  round: number;

  /**
   * 已经结算过的 causationId 集合，供 `advanceRound()` 做幂等检查。
   * 见 economy/types.ts 里 `EconomyEvent.causationId` 的传播规则注释。
   */
  private consumedCausationIds = new Set<string>();

  constructor() {
    this.factions = new FactionSystem();
    this.trades = new TradeSystem();
    this.policies = new PolicySystem();
    this.finances = new FinanceSystem();
    this.events = [];
    this.round = 0;

    this.seedInitialState();
  }

  // ── 初始世界状态 ──

  private seedInitialState(): void {
    // 创建默认势力
    this.factions.addFaction({
      id: "arcane_council", name: "奥法议会", type: "government",
      leaderName: "大议长", capitalName: "王都",
      treasury: 500, stability: 60, militaryPower: 40, economicPower: 60,
    });
    this.factions.addFaction({
      id: "merchant_guild", name: "商会联盟", type: "corporation",
      leaderName: "商会长", capitalName: "港口城",
      treasury: 800, stability: 70, militaryPower: 20, economicPower: 80,
    });
    this.factions.addFaction({
      id: "hidden_cult", name: "暗影教团", type: "cult",
      leaderName: "大祭司", capitalName: "地下神殿",
      treasury: 300, stability: 40, militaryPower: 30, economicPower: 40,
    });
    this.factions.addFaction({
      id: "northern_barons", name: "北境领主联盟", type: "noble_house",
      leaderName: "大公爵", capitalName: "北境要塞",
      treasury: 400, stability: 55, militaryPower: 60, economicPower: 35,
    });
    this.factions.addFaction({
      id: "spirit_monastery", name: "灵石寺", type: "school",
      leaderName: "方丈", capitalName: "灵山",
      treasury: 600, stability: 75, militaryPower: 35, economicPower: 55,
    });

    // 初始关系
    this.factions.setRelation("arcane_council", "merchant_guild", 40);
    this.factions.setRelation("arcane_council", "hidden_cult", -30);
    this.factions.setRelation("arcane_council", "northern_barons", 10);
    this.factions.setRelation("arcane_council", "spirit_monastery", 50);
    this.factions.setRelation("merchant_guild", "hidden_cult", -10);
    this.factions.setRelation("merchant_guild", "northern_barons", 20);
    this.factions.setRelation("merchant_guild", "spirit_monastery", 30);
    this.factions.setRelation("hidden_cult", "northern_barons", -40);
    this.factions.setRelation("hidden_cult", "spirit_monastery", -50);
    this.factions.setRelation("northern_barons", "spirit_monastery", 10);

    // 市场
    this.trades.createMarket({ id: "capital_market", name: "王都市场", location: "capital", controlledBy: "arcane_council" });
    this.trades.createMarket({ id: "port_market", name: "港口集市", location: "port", controlledBy: "merchant_guild" });
    this.trades.createMarket({ id: "black_market", name: "暗市", location: "slums", controlledBy: "hidden_cult", taxRate: 0.15 });
    this.trades.createMarket({ id: "fortress_market", name: "堡垒交易所", location: "fortress", controlledBy: "northern_barons", taxRate: 0.08 });
    this.trades.createMarket({ id: "monastery_market", name: "灵山坊市", location: "mountain", controlledBy: "spirit_monastery", taxRate: 0.03 });

    // 商品定价
    this.trades.setPrice("capital_market", "food", 5);
    this.trades.setPrice("capital_market", "iron", 8);
    this.trades.setPrice("capital_market", "spirit_stone", 55);
    this.trades.setPrice("port_market", "silk", 22);
    this.trades.setPrice("port_market", "herbs", 14);
    this.trades.setPrice("port_market", "spirit_stone", 50);
    this.trades.setPrice("black_market", "weapons", 20);
    this.trades.setPrice("black_market", "artifact", 250);
    this.trades.setPrice("fortress_market", "iron", 6);
    this.trades.setPrice("fortress_market", "weapons", 12);
    this.trades.setPrice("monastery_market", "spirit_stone", 45);
    this.trades.setPrice("monastery_market", "herbs", 10);
    this.trades.setPrice("monastery_market", "mana_crystal", 75);

    // 供给/需求
    this.trades.adjustSupply("capital_market", "food", 100);
    this.trades.adjustSupply("capital_market", "iron", 50);
    this.trades.adjustSupply("port_market", "silk", 30);
    this.trades.adjustSupply("port_market", "spirit_stone", 20);
    this.trades.adjustSupply("black_market", "weapons", 15);
    this.trades.adjustSupply("fortress_market", "iron", 80);
    this.trades.adjustSupply("fortress_market", "weapons", 40);
    this.trades.adjustSupply("monastery_market", "spirit_stone", 40);
    this.trades.adjustSupply("monastery_market", "mana_crystal", 15);

    this.trades.adjustDemand("capital_market", "food", 80);
    this.trades.adjustDemand("capital_market", "spirit_stone", 25);
    this.trades.adjustDemand("capital_market", "iron", 40);
    this.trades.adjustDemand("port_market", "silk", 15);
    this.trades.adjustDemand("port_market", "herbs", 20);
    this.trades.adjustDemand("black_market", "weapons", 20);
    this.trades.adjustDemand("fortress_market", "iron", 60);
    this.trades.adjustDemand("fortress_market", "weapons", 30);
    this.trades.adjustDemand("monastery_market", "spirit_stone", 35);

    // 贸易路线
    this.trades.establishTradeRoute("capital_market", "port_market", "food", 20, 6);
    this.trades.establishTradeRoute("port_market", "capital_market", "silk", 10, 24);
    this.trades.establishTradeRoute("fortress_market", "capital_market", "iron", 30, 7);
    this.trades.establishTradeRoute("monastery_market", "capital_market", "spirit_stone", 10, 48);

    // 默认政策
    const lowTax = this.policies.definePolicy({
      name: "低税率", description: "降低税率以刺激经济", factionId: "arcane_council",
      category: "tax", cost: 0,
      effects: [{ target: "treasury", operation: "multiply", value: 20, description: "收入+20%" }, { target: "stability", operation: "add", value: 5, description: "稳定度+5" }],
    });
    this.policies.enactPolicy(lowTax.id);
    this.factions.getFaction("arcane_council")?.activePolicies.push(lowTax.id);

    const openTrade = this.policies.definePolicy({
      name: "贸易开放", description: "开放边境促进贸易", factionId: "merchant_guild",
      category: "trade", cost: 10,
      effects: [{ target: "trade_income", operation: "multiply", value: 30, description: "贸易收入+30%" }, { target: "stability", operation: "add", value: 3, description: "稳定度+3" }],
    });
    this.policies.enactPolicy(openTrade.id);
    this.factions.getFaction("merchant_guild")?.activePolicies.push(openTrade.id);

    const spControl = this.policies.definePolicy({
      name: "灵石管制", description: "严格控制灵石流通", factionId: "spirit_monastery",
      category: "economic", cost: 15,
      effects: [{ target: "spirit_stone_price", operation: "multiply", value: 30, description: "灵石价格+30%" }, { target: "treasury", operation: "multiply", value: 10, description: "国库+10%" }, { target: "stability", operation: "add", value: -3, description: "稳定度-3" }],
    });
    this.policies.enactPolicy(spControl.id);
    this.factions.getFaction("spirit_monastery")?.activePolicies.push(spControl.id);

    // 银行
    this.finances.createBank({ id: "central_bank", name: "灵石储备银行", location: "capital", factionId: "arcane_council" });
    this.finances.deposit("central_bank", "gold_coin", 500);
    this.finances.deposit("central_bank", "spirit_stone", 100);

    this.finances.createBank({ id: "merchant_bank", name: "商会钱庄", location: "port", factionId: "merchant_guild" });
    this.finances.deposit("merchant_bank", "gold_coin", 800);
    this.finances.deposit("merchant_bank", "spirit_voucher", 2000);

    this.finances.createBank({ id: "monastery_vault", name: "灵山金库", location: "mountain", factionId: "spirit_monastery" });
    this.finances.deposit("monastery_vault", "spirit_stone", 200);
    this.finances.deposit("monastery_vault", "gold_coin", 300);
  }

  // ── 回合推进 ──

  /**
   * 推进一个经济回合。**必须传 causationId**——这不是可选的审计字段，
   * 是幂等保护本身依赖的键。
   *
   * 同一个 causationId 重复传入：直接返回 `[]`，不推进 `round`、不调用任何
   * 子系统的 `advanceRound()`、不产生新事件。这是"防重复触发"要求的字面
   * 实现——重复投递必须是纯粹的空操作，而不是"产生了但去重掉了"（那样
   * round 已经推进、子系统状态已经变了，只是不告诉调用方而已，一样是
   * 重复结算）。
   *
   * 谁负责生成 causationId、多久调一次：见 `api/game-session.ts` 的
   * `tickEconomy()`——那里是唯一的生产调用方，设计理由写在那边。
   */
  advanceRound(causationId: string): EconomyEvent[] {
    if (typeof causationId !== "string" || causationId.length === 0 || causationId.length > POLITICO_ECONOMY_SNAPSHOT_MAX_ID_LENGTH) {
      throw new Error("causationId must be a non-empty bounded string");
    }
    if (this.consumedCausationIds.has(causationId)) {
      return [];
    }
    if (this.consumedCausationIds.size >= POLITICO_ECONOMY_SNAPSHOT_MAX_CAUSATION_IDS) {
      throw new Error("causationId capacity has been reached");
    }
    this.consumedCausationIds.add(causationId);

    this.round++;
    const rawEvents: EconomyEvent[] = [
      ...this.factions.advanceRound(),
      ...this.trades.advanceRound(),
      ...this.policies.advanceRound(),
      ...this.finances.advanceRound(),
    ];
    // 离开引擎边界前统一盖章——子系统产出时不知道 causationId，
    // 见 EconomyEvent.causationId 的传播规则注释。
    const newEvents: EconomyEvent[] = rawEvents.map((e) => ({ ...e, causationId }));
    for (const e of newEvents) {
      this.events.push(e);
      if (this.events.length > 200) this.events.shift();
    }
    return newEvents;
  }

  /**
   * Export every mutable field as a validated, JSON-safe deep copy. The
   * snapshot deliberately contains no live Maps, Sets, or shared references.
   */
  exportSnapshot(): PoliticoEconomySnapshot {
    const factionSnapshot = this.factions.exportForSnapshot();
    const snapshot = {
      version: POLITICO_ECONOMY_SNAPSHOT_VERSION,
      round: this.round,
      events: this.events,
      consumedCausationIds: Array.from(this.consumedCausationIds),
      factions: factionSnapshot.factions,
      factionSystem: factionSnapshot.state,
      trades: this.trades.exportForSnapshot(),
      policies: this.policies.exportForSnapshot(),
      finances: this.finances.exportForSnapshot(),
    };
    // The round-trip omits absent optional fields exactly as transport JSON
    // does, before the validator creates the typed deep copy returned here.
    return validatePoliticoEconomySnapshot(JSON.parse(JSON.stringify(snapshot)) as unknown);
  }

  /**
   * Restore a portable snapshot. Validation creates a complete replacement
   * graph before this method mutates any engine or subsystem field.
   */
  restoreSnapshot(snapshot: unknown): void {
    const restored = validatePoliticoEconomySnapshot(snapshot);
    this.factions.replaceFromSnapshot(restored.factions, restored.factionSystem);
    this.trades.replaceFromSnapshot(restored.trades);
    this.policies.replaceFromSnapshot(restored.policies);
    this.finances.replaceFromSnapshot(restored.finances);
    this.events = restored.events;
    this.round = restored.round;
    this.consumedCausationIds = new Set(restored.consumedCausationIds);
  }

  // ── 状态输出 ──

  getState(): PoliticoEconomyState {
    return {
      factions: this.factions.getAllFactions(),
      markets: this.trades.getAllMarkets(),
      activePolicies: this.policies.getAllPolicies().filter(p => p.active),
      activeCrises: this.finances.getActiveCrises(),
      currencies: Array.from(this.finances["currencies"].values()),
      recentEvents: this.events.slice(-20),
      round: this.round,
    };
  }

  // ── 简略版状态（用于 getState() 嵌入） ──

  getBriefState(): {
    factions: { id: string; name: string; type: FactionType; stability: number; treasury: number }[];
    markets: { id: string; name: string; location: string; controller: string }[];
    crisisCount: number;
  } {
    return {
      factions: this.factions.getAllFactions().map(f => ({
        id: f.id, name: f.name, type: f.type,
        stability: f.stability, treasury: f.treasury,
      })),
      markets: this.trades.getAllMarkets().map(m => ({
        id: m.id, name: m.name, location: m.location,
        controller: m.controlledBy,
      })),
      crisisCount: this.finances.getActiveCrises().filter(c => !c.resolved).length,
    };
  }

  // ── 用户交互 Handler ──

  handleAction(
    action: string,
    params: { target?: string; from?: string; amount?: number; item?: string; skill?: string; dc?: number },
  ): { narrative: string; systemMsg?: string } {
    // `item` 也在 params 类型里，但四个 case（factions / faction_status /
    // market / diplomacy）没有一个用得上它 —— 不解构它。
    const { target, from, amount } = params;

    switch (action) {
      // 查看势力列表
      case "factions": {
        const list = this.factions.getAllFactions().map(f =>
          `${f.name}[${f.id}] 稳定:${f.stability} 国库:${f.treasury}G 军力:${f.militaryPower} 经济:${f.economicPower}`
        ).join("\n");
        return { narrative: `【世界势力一览】\n${list}` };
      }

      // 查看势力详情
      case "faction_status": {
        const fid = target ?? "arcane_council";
        const f = this.factions.getFaction(fid);
        if (!f) return { narrative: `未找到势力「${fid}」。` };
        const rels = Object.values(f.relations).map(r => {
          const t = this.factions.getFaction(r.targetId);
          return `  ${t?.name ?? r.targetId}: ${r.stance} (${r.score})`;
        }).join("\n");
        const pols = f.activePolicies.map(pid => this.policies.getPolicy(pid)?.name ?? pid).join(", ") || "无";
        return {
          narrative: [
            `【${f.name}】`,
            `  类型: ${f.type} | 领袖: ${f.leaderName ?? "未知"}`,
            `  国库: ${f.treasury}G | 稳定度: ${f.stability}/100`,
            `  军力: ${f.militaryPower} | 经济力: ${f.economicPower}`,
            `  领地: ${f.territory.join(", ") || "无"}`,
            `  政策: ${pols}`,
            ``,
            `【外交关系】`,
            rels || "  (无已知关系)",
          ].join("\n"),
        };
      }

      // 市场列表
      case "market": {
        const mid = target;
        if (!mid) {
          const list = this.trades.getAllMarkets().map(m =>
            `${m.name}[${m.id}] 税率:${(m.taxRate * 100).toFixed(0)}%`
          ).join("\n");
          return { narrative: `【市场列表】\n${list}\n使用 "查看市场 <市场名>" 查看详情。` };
        }
        const m = this.trades.getMarket(mid);
        if (!m) return { narrative: `未找到市场「${mid}」。` };
        const controller = this.factions.getFaction(m.controlledBy);
        const rows = Object.values(m.entries).map(e => {
          const def = this.trades.getResourceDef(e.resourceId);
          return `  ${(def?.name ?? e.resourceId).padEnd(8)} ${String(e.price).padStart(4)}G  供给:${String(e.supply).padStart(4)} 需求:${String(e.demand).padStart(4)}  [${e.trend}]`;
        }).join("\n");
        return {
          narrative: [
            `【${m.name}】`,
            `  位置: ${m.location} | 控制: ${controller?.name ?? m.controlledBy}`,
            `  税率: ${(m.taxRate * 100).toFixed(0)}%`,
            ``,
            `  商品       价格   供给   需求  趋势`,
            `  ${"-".repeat(38)}`,
            rows || "  (暂无上架商品)",
          ].join("\n"),
        };
      }

      // 外交行动
      case "diplomacy": {
        // 格式: 外交 <行动> <目标势力> [参数...]
        // 行动: status/gift/war/treaty
        const subAction = params.skill ?? "status";
        const fromId = from ?? "arcane_council";
        const toId = target;

        if (subAction === "status" && toId) {
          const rel = this.factions.getRelation(fromId, toId);
          const f = this.factions.getFaction(fromId);
          const t = this.factions.getFaction(toId);
          if (!f || !t) return { narrative: "势力不存在。" };
          return {
            narrative: [
              `【${f.name} ⟷ ${t.name}】`,
              `  关系状态: ${rel?.stance ?? "无"} (关系值: ${rel?.score ?? 0})`,
              `  贸易额: ${f.relations[toId]?.tradeVolume ?? 0}G`,
              `  条约: ${(f.relations[toId]?.treaties ?? []).filter(tr => tr.active).map(tr => tr.type).join(", ") || "无"}`,
            ].join("\n"),
          };
        }

        if (subAction === "gift" && toId && amount && amount > 0) {
          const success = this.factions.sendGift(fromId, toId, amount);
          if (!success) return { narrative: "赠送失败。国库不足或势力不存在。" };
          const t = this.factions.getFaction(toId);
          return { narrative: `✅ ${fromId} 向 ${t?.name ?? toId} 赠送了 ${amount}G，关系改善。` };
        }

        if (subAction === "war" && toId) {
          const success = this.factions.declareWar(fromId, toId);
          if (!success) return { narrative: "宣战失败。" };
          const t = this.factions.getFaction(toId);
          return { narrative: `⚔️ ${fromId} 对 ${t?.name ?? toId} 宣战！` };
        }

        return { narrative: "外交用法: 外交 status/gift/war <目标势力> [金额]" };
      }

      // 金融信息
      case "finance": {
        const currencies = Array.from(this.finances["currencies"].values());
        const crises = this.finances.getActiveCrises().filter(c => !c.resolved);
        const banks = this.finances.getAllBanks();

        const curInfo = currencies.map(c =>
          `  ${c.name}[${c.id}] | 类型:${c.type} | 发行:${c.issuer} | 流通量:${c.supply} | 稳定度:${c.stability}`
        ).join("\n");

        const crisisInfo = crises.length === 0
          ? "  (无活跃金融危机)"
          : crises.map(c => `  ⚠️ ${c.name} (${c.type}) 严重度:${c.severity}/10 — ${c.description}`).join("\n");

        const bankInfo = banks.map(b => {
          const f = this.factions.getFaction(b.factionId);
          return `  ${b.name}[${b.id}] (${f?.name ?? b.factionId}) 稳定度:${b.stability}`;
        }).join("\n");

        return {
          narrative: [
            `【金融概况】`,
            ``,
            `货币体系:`,
            curInfo,
            ``,
            `金融机构:`,
            bankInfo || "  (无)",
            ``,
            `金融危机:`,
            crisisInfo,
          ].join("\n"),
        };
      }

      // 政策管理
      case "policy": {
        const fid = target ?? "arcane_council";
        const f = this.factions.getFaction(fid);
        if (!f) return { narrative: `势力不存在: ${fid}` };
        const categorized = this.policies.getFactionPolicies(fid);
        const fmt = (list: Policy[]) => list.map(p => `  ${p.name}[${p.id}] (${p.category}) ${p.active ? "✅" : ""}`).join("\n");
        return {
          narrative: [
            `【${f.name} 政策】`,
            ``,
            `已生效:`,
            fmt(categorized.active) || "  (无)",
            ``,
            `可实施:`,
            fmt(categorized.available) || "  (无)",
            ``,
            `冷却中:`,
            fmt(categorized.onCooldown) || "  (无)",
          ].join("\n"),
        };
      }

      default:
        return { narrative: `未知政治经济指令: ${action}` };
    }
  }

  // ── 可视化数据接口 ──

  /** 返回结构化 JSON，供前端或 HTML 渲染引擎使用 */
  getEconomyVizData(): {
    factions: Array<{
      id: string; name: string; type: string;
      treasury: number; stability: number;
      militaryPower: number; economicPower: number;
    }>;
    relations: Array<{
      source: string; target: string;
      stance: string; score: number;
    }>;
    markets: Array<{
      id: string; name: string; controller: string;
      entries: Array<{
        resourceId: string; price: number;
        supply: number; demand: number; trend: string;
      }>;
    }>;
    tradeRoutes: Array<{
      from: string; to: string;
      resourceId: string; volume: number;
    }>;
    crises: Array<{
      name: string; type: string;
      severity: number; description: string;
    }>;
    round: number;
  } {
    const factions = this.factions.getAllFactions();
    const relations: Array<{ source: string; target: string; stance: string; score: number }> = [];
    for (const f of factions) {
      for (const [targetId, rel] of Object.entries(f.relations)) {
        relations.push({ source: f.id, target: targetId, stance: rel.stance, score: rel.score });
      }
    }
    return {
      factions: factions.map(f => ({
        id: f.id, name: f.name, type: f.type,
        treasury: f.treasury, stability: f.stability,
        militaryPower: f.militaryPower, economicPower: f.economicPower,
      })),
      relations,
      markets: this.trades.getAllMarkets().map(m => ({
        id: m.id, name: m.name, controller: m.controlledBy,
        entries: Object.values(m.entries).map(e => ({
          resourceId: e.resourceId, price: e.price,
          supply: e.supply, demand: e.demand, trend: e.trend,
        })),
      })),
      tradeRoutes: this.trades.getAllMarkets().flatMap(m =>
        m.tradeRoutes.map(r => ({
          from: r.fromFactionId, to: r.toFactionId,
          resourceId: r.resourceId, volume: r.volume,
        }))
      ),
      crises: this.finances.getActiveCrises().filter(c => !c.resolved).map(c => ({
        name: c.name, type: c.type, severity: c.severity, description: c.description,
      })),
      round: this.round,
    };
  }

  /** 生成自包含 HTML 经济仪表盘 */
  renderEconomyHtml(): string {
    const d = this.getEconomyVizData();
    const { factions, relations, markets, tradeRoutes, crises } = d;

    // ── 势力关系图（D3 force-simulation 替代：纯 CSS 网格） ──
    const factionCards = factions.map(f => {
      const rels = relations.filter(r => r.source === f.id);
      const allies = rels.filter(r => r.stance === "ally" || r.stance === "trade_pact").length;
      const enemies = rels.filter(r => r.stance === "hostile" || r.stance === "war").length;
      const color = f.stability >= 70 ? "#4ade80" : f.stability >= 40 ? "#facc15" : "#f87171";
      return `
        <div class="fc" style="border-left:4px solid ${color}">
          <div class="fch">${f.name}</div>
          <div class="fct">${f.type} · 国库 ${f.treasury}G</div>
          <div class="fcb">
            <span>稳${f.stability}</span>
            <span>军${f.militaryPower}</span>
            <span>经${f.economicPower}</span>
          </div>
          <div class="fcr">友${allies} 敌${enemies}</div>
        </div>`;
    }).join("");

    // ── 市场表格 ──
    const marketTables = markets.map(m => {
      const rows = m.entries.map(e => {
        const trendIcon = e.trend === "rising" ? "↑" : e.trend === "falling" ? "↓" : "→";
        const trendCls = e.trend === "rising" ? "tr" : e.trend === "falling" ? "tf" : "ts";
        return `<tr>
          <td>${e.resourceId}</td>
          <td class="n">${e.price}G</td>
          <td class="n">${e.supply}</td>
          <td class="n">${e.demand}</td>
          <td class="${trendCls}">${trendIcon}</td>
        </tr>`;
      }).join("");
      return `<details open>
        <summary class="ms">${m.name} (${m.controller})</summary>
        <table><tr><th>商品</th><th>价格</th><th>供给</th><th>需求</th><th></th></tr>${rows}</table>
      </details>`;
    }).join("");

    // ── 贸易路线 ──
    const routeRows = tradeRoutes.map(r => {
      const from = factions.find(f => f.id === r.from)?.name ?? r.from;
      const to = factions.find(f => f.id === r.to)?.name ?? r.to;
      return `<tr><td>${from}</td><td class="a">→</td><td>${to}</td><td>${r.resourceId}</td><td class="n">${r.volume}/t</td></tr>`;
    }).join("");

    // ── 危机 ──
    const crisisBanner = crises.length > 0
      ? `<div class="crisis">⚠️ ${crises.map(c => `${c.name}（严重度 ${c.severity}）`).join(" · ")}</div>`
      : `<div class="ok">✅ 经济稳定</div>`;

    return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;max-width:1200px;margin:0 auto}
h1{font-size:24px;margin-bottom:4px;color:#f8fafc}
.sub{color:#94a3b8;font-size:14px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:24px}
.fc{background:#1e293b;border-radius:8px;padding:12px 14px}
.fch{font-weight:600;font-size:15px;color:#f1f5f9;margin-bottom:2px}
.fct{font-size:12px;color:#94a3b8;margin-bottom:6px}
.fcb{display:flex;gap:10px;font-size:13px;color:#cbd5e1;margin-bottom:4px}
.fcr{font-size:12px;color:#64748b}
.ms{font-size:15px;font-weight:600;color:#e2e8f0;cursor:pointer;padding:8px 0;border-bottom:1px solid #334155;margin-bottom:8px}
table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px}
th{text-align:left;padding:6px 8px;color:#94a3b8;border-bottom:1px solid #334155;font-weight:500}
td{padding:6px 8px;border-bottom:1px solid #1e293b}
.n{text-align:right;font-variant-numeric:tabular-nums}
.a{text-align:center;color:#64748b;padding:0 4px}
.tr{color:#4ade80;font-weight:600;text-align:center}
.tf{color:#f87171;font-weight:600;text-align:center}
.ts{color:#94a3b8;text-align:center}
.crisis{background:#7f1d1d;color:#fca5a5;padding:10px 16px;border-radius:8px;margin-bottom:20px;font-size:14px}
.ok{background:#14532d;color:#86efac;padding:10px 16px;border-radius:8px;margin-bottom:20px;font-size:14px}
.s2{display:grid;grid-template-columns:1fr 1fr;gap:24px}
@media(max-width:640px){.s2{grid-template-columns:1fr}}
details{margin-bottom:4px}
.routes{margin-top:16px}
.routes table{margin-top:8px}
</style>
</head><body>
<h1>🏛️ 政治经济仪表盘</h1>
<div class="sub">第 ${d.round} 回合 · ${factions.length} 势力 · ${markets.length} 市场 · ${tradeRoutes.length} 贸易路线</div>
${crisisBanner}
<div class="grid">${factionCards}</div>
<div class="s2">
  <div>
    <div class="ms">📊 市场行情</div>
    ${marketTables}
  </div>
  <div>
    <div class="ms">🔄 贸易路线 <span style="font-weight:400;font-size:13px;color:#94a3b8">(${tradeRoutes.length} 条)</span></div>
    ${tradeRoutes.length > 0 ? `<table class="routes"><tr><th>出发</th><th></th><th>到达</th><th>货物</th><th class="n">流量</th></tr>${routeRows}</table>` : '<div style="color:#64748b;font-size:14px">暂无活跃贸易路线</div>'}
  </div>
</div>
</body></html>`;
  }

  // ── 外交/贸易/金融交互（用于 LLM 驱动的自由叙事） ──

  getDiplomaticContext(): string {
    const factions = this.factions.getAllFactions();
    const lines: string[] = ["【政治经济局势】"];
    for (const f of factions) {
      const hostile = Object.values(f.relations).filter(r => r.stance === "hostile" || r.stance === "war");
      const allies = Object.values(f.relations).filter(r => r.stance === "ally" || r.stance === "trade_pact");
      const h = hostile.map(r => this.factions.getFaction(r.targetId)?.name ?? r.targetId).join(", ");
      const a = allies.map(r => this.factions.getFaction(r.targetId)?.name ?? r.targetId).join(", ");
      lines.push(`  ${f.name}: 国库${f.treasury}G 稳定${f.stability} 军力${f.militaryPower} 经济${f.economicPower}`);
      if (a) lines.push(`    盟友/贸易伙伴: ${a}`);
      if (h) lines.push(`    敌对: ${h}`);
    }
    const crises = this.finances.getActiveCrises().filter(c => !c.resolved);
    for (const c of crises) {
      lines.push(`  ⚠️ 金融危机: ${c.name} (${c.description})`);
    }
    return lines.join("\n");
  }
}
