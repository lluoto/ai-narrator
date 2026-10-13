import {
  Faction, Treaty, Stance, TreatyType,
  DiplomaticOffer, EconomyEvent, FactionType
} from "./types";
import type { FactionSystemSnapshot } from "./politico-economy-snapshot";

// ── 内部扩展：带ID和条约期限的外交提议 ──
interface TrackedOffer extends DiplomaticOffer {
  id: string;
  treatyDuration?: number;
}

// ── 工具 ──

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function stanceFromScore(score: number): Stance {
  if (score >= 60) return "ally";
  if (score >= 30) return "trade_pact";
  if (score >= -10) return "neutral";
  if (score >= -40) return "unfriendly";
  if (score >= -70) return "hostile";
  return "war";
}

const MAX_EVENTS = 100;
const RECENT_EVENTS = 20;

export class FactionSystem {
  factions: Map<string, Faction>;
  diplomaticOffers: TrackedOffer[];
  events: EconomyEvent[];
  round: number;

  constructor() {
    this.factions = new Map();
    this.diplomaticOffers = [];
    this.events = [];
    this.round = 0;
  }

  // ═══════════════════════════════════════
  //  势力管理
  // ═══════════════════════════════════════

  addFaction(config: {
    id: string; name: string; type: FactionType;
    leaderName?: string; capitalName?: string;
    territory?: string[]; resources?: Record<string, number>;
    treasury?: number; stability?: number;
    militaryPower?: number; economicPower?: number;
  }): Faction {
    const faction: Faction = {
      id: config.id,
      name: config.name,
      type: config.type,
      leaderName: config.leaderName,
      capitalName: config.capitalName,
      territory: config.territory ?? [],
      resources: config.resources ?? {},
      treasury: config.treasury ?? 100,
      stability: config.stability ?? 50,
      militaryPower: config.militaryPower ?? 10,
      economicPower: config.economicPower ?? 10,
      relations: {},
      activePolicies: [],
      createdAtRound: this.round,
    };
    this.factions.set(config.id, faction);
    return faction;
  }

  getFaction(id: string): Faction | undefined {
    return this.factions.get(id);
  }

  getAllFactions(): Faction[] {
    return Array.from(this.factions.values());
  }

  /** Internal persistence primitive. Untrusted snapshots are validated by the engine. */
  exportForSnapshot(): { factions: Faction[]; state: FactionSystemSnapshot } {
    return {
      factions: Array.from(this.factions.values()),
      state: {
        diplomaticOffers: this.diplomaticOffers,
        events: this.events,
        round: this.round,
      },
    };
  }

  /** Internal persistence primitive. Call only with validatePoliticoEconomySnapshot output. */
  replaceFromSnapshot(factions: Faction[], state: FactionSystemSnapshot): void {
    this.factions = new Map(factions.map(faction => [faction.id, faction]));
    this.diplomaticOffers = state.diplomaticOffers;
    this.events = state.events;
    this.round = state.round;
  }

  // ═══════════════════════════════════════
  //  关系管理
  // ═══════════════════════════════════════

  setRelation(fromId: string, toId: string, score: number): void {
    const from = this.factions.get(fromId);
    const to = this.factions.get(toId);
    if (!from || !to) return;

    score = clamp(score, -100, 100);
    const st = stanceFromScore(score);

    const upsertRel = (src: Faction, targetId: string): void => {
      if (src.relations[targetId]) {
        src.relations[targetId].stance = st;
        src.relations[targetId].score = score;
        src.relations[targetId].lastInteractionRound = this.round;
      } else {
        src.relations[targetId] = {
          targetId,
          stance: st,
          score,
          treaties: [],
          tradeVolume: 0,
          lastInteractionRound: this.round,
        };
      }
    };

    upsertRel(from, toId);
    upsertRel(to, fromId);
  }

  getRelation(fromId: string, toId: string): { stance: Stance; score: number } | null {
    const from = this.factions.get(fromId);
    if (!from) return null;
    const rel = from.relations[toId];
    return rel ? { stance: rel.stance, score: rel.score } : null;
  }

  // ═══════════════════════════════════════
  //  条约与外交提议
  // ═══════════════════════════════════════

  proposeTreaty(
    fromId: string, toId: string,
    type: TreatyType, terms: string,
    duration?: number
  ): DiplomaticOffer | null {
    const from = this.factions.get(fromId);
    const to = this.factions.get(toId);
    if (!from || !to) return null;

    // 结盟与交战互斥。
    //
    // 原来是拿 ["war"] 去匹配 treaties 里的 t.type —— 但 war 是关系立场（Stance），
    // 不是条约类型（TreatyType），任何条约的 type 都不可能等于它，这条检查从来没
    // 拦下过任何东西。同理 `type === "war"` 那个分支：type 是 TreatyType，永远不等于
    // "war"，整个分支不可达。改成查立场，规则才真正成立。
    if (type === "alliance") {
      const atWar = from.relations[toId]?.stance === "war"
        || to.relations[fromId]?.stance === "war";
      if (atWar) return null;
    }

    const offer: TrackedOffer = {
      id: `offer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action: "propose_treaty",
      fromFactionId: fromId,
      toFactionId: toId,
      treatyType: type,
      terms,
      treatyDuration: duration,
      expiresAtRound: this.round + 10,
    };
    this.diplomaticOffers.push(offer);
    return offer;
  }

  acceptOffer(offerId: string): boolean {
    const idx = this.diplomaticOffers.findIndex(o => o.id === offerId);
    if (idx === -1) return false;
    const [offer] = this.diplomaticOffers.splice(idx, 1);

    const from = this.factions.get(offer.fromFactionId);
    const to = this.factions.get(offer.toFactionId);
    if (!from || !to || !offer.treatyType) return false;

    const treaty: Treaty = {
      id: `faction_treaty_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: offer.treatyType,
      parties: [offer.fromFactionId, offer.toFactionId],
      terms: offer.terms ?? "",
      signedAtRound: this.round,
      duration: offer.treatyDuration,
      active: true,
    };

    const addTreaty = (src: Faction, targetId: string): void => {
      if (!src.relations[targetId]) {
        src.relations[targetId] = {
          targetId,
          stance: "neutral",
          score: 0,
          treaties: [],
          tradeVolume: 0,
          lastInteractionRound: this.round,
        };
      }
      src.relations[targetId].treaties.push(treaty);
    };

    addTreaty(from, offer.toFactionId);
    addTreaty(to, offer.fromFactionId);

    const evt: EconomyEvent = {
      id: `evt_faction_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "faction_stance_change",
      round: this.round,
      description: `${from.name} 接受了 ${to.name} 的${offer.terms ?? "条约"}提议`,
      affectedFactions: [offer.fromFactionId, offer.toFactionId],
      data: { treatyType: offer.treatyType, treatyId: treaty.id },
    };
    this.pushEvent(evt);

    return true;
  }

  rejectOffer(offerId: string): boolean {
    const idx = this.diplomaticOffers.findIndex(o => o.id === offerId);
    if (idx === -1) return false;
    const [offer] = this.diplomaticOffers.splice(idx, 1);

    const from = this.factions.get(offer.fromFactionId);
    const to = this.factions.get(offer.toFactionId);
    if (!from || !to) return false;

    const evt: EconomyEvent = {
      id: `evt_faction_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "faction_stance_change",
      round: this.round,
      description: `${to.name} 拒绝了 ${from.name} 的提议`,
      affectedFactions: [offer.fromFactionId, offer.toFactionId],
    };
    this.pushEvent(evt);

    return true;
  }

  breakTreaty(factionId: string, treatyId: string): boolean {
    const faction = this.factions.get(factionId);
    if (!faction) return false;

    for (const [targetId, rel] of Object.entries(faction.relations)) {
      const tIdx = rel.treaties.findIndex(t => t.id === treatyId);
      if (tIdx === -1) continue;

      const treaty = rel.treaties[tIdx];
      treaty.active = false;

      const target = this.factions.get(targetId);
      if (target && target.relations[factionId]) {
        const otIdx = target.relations[factionId].treaties.findIndex(t => t.id === treatyId);
        if (otIdx !== -1) {
          target.relations[factionId].treaties[otIdx].active = false;
        }
      }

      rel.score = clamp(rel.score - 20, -100, 100);
      rel.stance = stanceFromScore(rel.score);

      if (target && target.relations[factionId]) {
        target.relations[factionId].score = rel.score;
        target.relations[factionId].stance = rel.stance;
      }

      const evt: EconomyEvent = {
        id: `evt_faction_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: "faction_stance_change",
        round: this.round,
        description: `${faction.name} 撕毁了与 ${target?.name ?? targetId} 的条约`,
        affectedFactions: [factionId, targetId],
        data: { treatyId, treatyType: treaty.type },
      };
      this.pushEvent(evt);

      return true;
    }

    return false;
  }

  declareWar(fromId: string, toId: string): boolean {
    const from = this.factions.get(fromId);
    const to = this.factions.get(toId);
    if (!from || !to) return false;

    this.setRelation(fromId, toId, -100);

    const cancelTypes: TreatyType[] = ["alliance", "trade", "non_aggression"];

    const cancelBetween = (a: Faction, b: Faction): void => {
      if (!a.relations[b.id]) return;
      for (const t of a.relations[b.id].treaties) {
        if (t.active && cancelTypes.includes(t.type)) {
          t.active = false;
        }
      }
    };

    cancelBetween(from, to);
    cancelBetween(to, from);

    const evt: EconomyEvent = {
      id: `evt_faction_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "faction_stance_change",
      round: this.round,
      description: `${from.name} 对 ${to.name} 宣战！`,
      affectedFactions: [fromId, toId],
      data: { action: "declare_war" },
    };
    this.pushEvent(evt);

    return true;
  }

  sendGift(fromId: string, toId: string, amount: number): boolean {
    const from = this.factions.get(fromId);
    const to = this.factions.get(toId);
    if (!from || !to) return false;
    if (from.treasury < amount) return false;

    from.treasury -= amount;
    to.treasury += amount;

    const bonus = clamp(Math.min(20, Math.floor(amount / 10)), 0, 20);

    if (!from.relations[toId]) {
      from.relations[toId] = {
        targetId: toId,
        stance: "neutral",
        score: 0,
        treaties: [],
        tradeVolume: 0,
        lastInteractionRound: this.round,
      };
    }
    from.relations[toId].score = clamp(from.relations[toId].score + bonus, -100, 100);
    from.relations[toId].stance = stanceFromScore(from.relations[toId].score);
    from.relations[toId].lastInteractionRound = this.round;

    if (!to.relations[fromId]) {
      to.relations[fromId] = {
        targetId: fromId,
        stance: "neutral",
        score: 0,
        treaties: [],
        tradeVolume: 0,
        lastInteractionRound: this.round,
      };
    }
    to.relations[fromId].score = from.relations[toId].score;
    to.relations[fromId].stance = from.relations[toId].stance;
    to.relations[fromId].lastInteractionRound = this.round;

    const evt: EconomyEvent = {
      id: `evt_faction_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "faction_stance_change",
      round: this.round,
      description: `${from.name} 向 ${to.name} 赠送了 ${amount} 单位财富`,
      affectedFactions: [fromId, toId],
      data: { giftAmount: amount },
    };
    this.pushEvent(evt);

    return true;
  }

  // ═══════════════════════════════════════
  //  回合推进
  // ═══════════════════════════════════════

  advanceRound(): EconomyEvent[] {
    this.round++;
    const newEvents: EconomyEvent[] = [];

    // 清理过期提议
    const expiredOffers: TrackedOffer[] = [];
    this.diplomaticOffers = this.diplomaticOffers.filter(o => {
      if (o.expiresAtRound <= this.round) {
        expiredOffers.push(o);
        return false;
      }
      return true;
    });

    for (const offer of expiredOffers) {
      const from = this.factions.get(offer.fromFactionId);
      const to = this.factions.get(offer.toFactionId);
      const evt: EconomyEvent = {
        id: `evt_faction_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: "faction_stance_change",
        round: this.round,
        description: `${from?.name ?? offer.fromFactionId} 向 ${to?.name ?? offer.toFactionId} 的提议已过期`,
        affectedFactions: [offer.fromFactionId, offer.toFactionId],
      };
      newEvents.push(evt);
    }

    // 清理过期条约
    for (const faction of this.factions.values()) {
      for (const rel of Object.values(faction.relations)) {
        for (const treaty of rel.treaties) {
          if (!treaty.active) continue;
          if (treaty.duration == null) continue;
          const expiresAt = treaty.signedAtRound + treaty.duration;
          if (expiresAt <= this.round) {
            treaty.active = false;

            const partner = this.factions.get(rel.targetId);
            if (partner && partner.relations[faction.id]) {
              const pt = partner.relations[faction.id].treaties.find(t => t.id === treaty.id);
              if (pt) pt.active = false;
            }

            const evt: EconomyEvent = {
              id: `evt_faction_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: "faction_stance_change",
              round: this.round,
              description: `${faction.name} 与 ${partner?.name ?? rel.targetId} 的 ${treaty.type} 条约已到期`,
              affectedFactions: [faction.id, rel.targetId],
              data: { treatyId: treaty.id, treatyType: treaty.type },
            };
            newEvents.push(evt);
          }
        }
      }
    }

    for (const evt of newEvents) {
      this.pushEvent(evt);
    }

    return newEvents;
  }

  // ═══════════════════════════════════════
  //  状态快照
  // ═══════════════════════════════════════

  getState(): { factions: Faction[]; recentEvents: EconomyEvent[]; round: number } {
    return {
      factions: Array.from(this.factions.values()),
      recentEvents: this.events.slice(-RECENT_EVENTS),
      round: this.round,
    };
  }

  // ── 内部 ──

  private pushEvent(evt: EconomyEvent): void {
    this.events.push(evt);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }
}
