// ============================================================
// 政策系统 - PolicySystem
// 管理政策、法令及其对势力的影响
// ============================================================

import {
  Policy, PolicyCategory, PolicyEffect, Faction,
  EconomyEvent, EconomyEventType
} from "./types";
import type { PolicySystemSnapshot } from "./politico-economy-snapshot";

export class PolicySystem {
  policies: Map<string, Policy> = new Map();
  events: EconomyEvent[] = [];
  round: number = 0;
  private eventCounter: number = 0;

  constructor() {}

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${++this.eventCounter}`;
  }

  private logEvent(
    type: EconomyEventType,
    description: string,
    affectedFactions: string[],
    data?: Record<string, unknown>
  ): void {
    const event: EconomyEvent = {
      id: this.generateId("event"),
      type,
      round: this.round,
      description,
      affectedFactions,
      data,
    };
    this.events.push(event);
    if (this.events.length > 100) {
      this.events.shift();
    }
  }

  definePolicy(config: {
    name: string;
    description: string;
    factionId: string;
    category: PolicyCategory;
    effects: { target: string; operation: "add" | "multiply" | "set"; value: number; description: string }[];
    cost?: number;
    cooldown?: number;
  }): Policy {
    const policy: Policy = {
      id: this.generateId("policy"),
      name: config.name,
      description: config.description,
      factionId: config.factionId,
      category: config.category,
      effects: config.effects.map(e => ({
        target: e.target,
        operation: e.operation,
        value: e.value,
        description: e.description,
      })),
      active: false,
      enactedAtRound: 0,
      cost: config.cost ?? 0,
      cooldown: config.cooldown ?? 5,
    };
    this.policies.set(policy.id, policy);
    return policy;
  }

  enactPolicy(policyId: string): { success: boolean; reason?: string } {
    const policy = this.policies.get(policyId);
    if (!policy) {
      return { success: false, reason: "政策不存在" };
    }
    if (policy.active) {
      return { success: false, reason: "政策已实施" };
    }

    policy.active = true;
    policy.enactedAtRound = this.round;

    this.logEvent("policy_enacted", `实施了政策「${policy.name}」`, [policy.factionId], {
      policyId: policy.id,
      category: policy.category,
    });

    return { success: true };
  }

  revokePolicy(policyId: string): boolean {
    const policy = this.policies.get(policyId);
    if (!policy || !policy.active) {
      return false;
    }

    policy.active = false;

    this.logEvent("policy_enacted", `撤销了政策「${policy.name}」`, [policy.factionId], {
      policyId: policy.id,
      category: policy.category,
    });

    return true;
  }

  getFactionPolicies(factionId: string): { active: Policy[]; available: Policy[]; onCooldown: Policy[] } {
    const active: Policy[] = [];
    const available: Policy[] = [];
    const onCooldown: Policy[] = [];

    for (const policy of Array.from(this.policies.values())) {
      if (policy.factionId !== factionId) continue;

      if (policy.active) {
        active.push(policy);
      } else if (
        policy.enactedAtRound > 0 &&
        this.round - policy.enactedAtRound <= policy.cooldown
      ) {
        onCooldown.push(policy);
      } else {
        available.push(policy);
      }
    }

    return { active, available, onCooldown };
  }

  getPolicy(id: string): Policy | undefined {
    return this.policies.get(id);
  }

  getAllPolicies(): Policy[] {
    return Array.from(this.policies.values());
  }

  /** Internal persistence primitive. Untrusted snapshots are validated by the engine. */
  exportForSnapshot(): PolicySystemSnapshot {
    return {
      policies: Array.from(this.policies.values()),
      events: this.events,
      round: this.round,
      eventCounter: this.eventCounter,
    };
  }

  /** Internal persistence primitive. Call only with validatePoliticoEconomySnapshot output. */
  replaceFromSnapshot(snapshot: PolicySystemSnapshot): void {
    this.policies = new Map(snapshot.policies.map(policy => [policy.id, policy]));
    this.events = snapshot.events;
    this.round = snapshot.round;
    this.eventCounter = snapshot.eventCounter;
  }

  getDefaultPolicies(): Policy[] {
    const defaultPolicies: Policy[] = [
      {
        id: "default_low_tax",
        name: "低税率",
        description: "减轻民间税负，鼓励生产，国库收入略有增长",
        factionId: "",
        category: "tax" as PolicyCategory,
        effects: [
          { target: "treasury", operation: "multiply", value: 20, description: "收入 +20%" },
          { target: "stability", operation: "add", value: 5, description: "稳定度 +5" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 0,
        cooldown: 5,
      },
      {
        id: "default_high_tax",
        name: "高税率",
        description: "加重税赋充盈国库，但民怨沸腾",
        factionId: "",
        category: "tax" as PolicyCategory,
        effects: [
          { target: "treasury", operation: "multiply", value: 50, description: "收入 +50%" },
          { target: "stability", operation: "add", value: -10, description: "稳定度 -10" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 0,
        cooldown: 5,
      },
      {
        id: "default_trade_open",
        name: "贸易开放",
        description: "开放边境通商，繁荣市场",
        factionId: "",
        category: "trade" as PolicyCategory,
        effects: [
          { target: "trade_income", operation: "multiply", value: 30, description: "贸易收入 +30%" },
          { target: "stability", operation: "add", value: 3, description: "稳定度 +3" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 10,
        cooldown: 5,
      },
      {
        id: "default_trade_blockade",
        name: "贸易封锁",
        description: "切断对外商路，打击敌对势力经济",
        factionId: "",
        category: "trade" as PolicyCategory,
        effects: [
          { target: "trade_income", operation: "multiply", value: -50, description: "贸易收入 -50%" },
          { target: "rival_influence", operation: "multiply", value: -20, description: "敌对影响力 -20%" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 20,
        cooldown: 5,
      },
      {
        id: "default_military_expansion",
        name: "军事扩张",
        description: "大规模扩军，增强军事实力",
        factionId: "",
        category: "military" as PolicyCategory,
        effects: [
          { target: "militaryPower", operation: "multiply", value: 25, description: "军事实力 +25%" },
          { target: "stability", operation: "add", value: -5, description: "稳定度 -5" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 30,
        cooldown: 5,
      },
      {
        id: "default_diplomatic_rapprochement",
        name: "外交修好",
        description: "积极展开外交活动，改善对外关系",
        factionId: "",
        category: "diplomatic" as PolicyCategory,
        effects: [
          { target: "relation_improvement_rate", operation: "multiply", value: 20, description: "关系改善速率 +20%" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 15,
        cooldown: 5,
      },
      {
        id: "default_spirit_stone_control",
        name: "灵石管制",
        description: "对灵石实行专营管制，增加财政收入",
        factionId: "",
        category: "economic" as PolicyCategory,
        effects: [
          { target: "spirit_stone_price", operation: "multiply", value: 30, description: "灵石价格 +30%" },
          { target: "treasury", operation: "multiply", value: 10, description: "国库收入 +10%" },
          { target: "stability", operation: "add", value: -3, description: "稳定度 -3" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 15,
        cooldown: 5,
      },
      {
        id: "default_land_reform",
        name: "土地改革",
        description: "重新分配土地，稳定民心但耗费巨资",
        factionId: "",
        category: "domestic" as PolicyCategory,
        effects: [
          { target: "stability", operation: "add", value: 15, description: "稳定度 +15" },
          { target: "treasury", operation: "add", value: -30, description: "国库 -30" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 25,
        cooldown: 5,
      },
      {
        id: "default_market_regulation",
        name: "市场调控",
        description: "政府干预市场，平抑物价",
        factionId: "",
        category: "economic" as PolicyCategory,
        effects: [
          { target: "price_stability", operation: "multiply", value: 20, description: "价格稳定度 +20%" },
          { target: "treasury", operation: "multiply", value: -10, description: "国库 -10%" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 10,
        cooldown: 5,
      },
      {
        id: "default_conscription",
        name: "强制征兵",
        description: "强制征召壮丁，短时间大幅提升兵力",
        factionId: "",
        category: "military" as PolicyCategory,
        effects: [
          { target: "militaryPower", operation: "multiply", value: 40, description: "军事实力 +40%" },
          { target: "stability", operation: "add", value: -15, description: "稳定度 -15" },
        ],
        active: false,
        enactedAtRound: 0,
        cost: 5,
        cooldown: 5,
      },
    ];

    return defaultPolicies;
  }

  applyPolicyEffects(faction: Faction, policyIds: string[]): Record<string, number> {
    const result: Record<string, number> = {
      treasury: faction.treasury,
      stability: faction.stability,
      militaryPower: faction.militaryPower,
      economicPower: faction.economicPower,
    };

    const effects: PolicyEffect[] = [];
    for (const pid of policyIds) {
      const policy = this.policies.get(pid);
      if (policy?.active) {
        effects.push(...policy.effects);
      }
    }

    for (const effect of effects) {
      const current = result[effect.target] ?? 0;
      switch (effect.operation) {
        case "add":
          result[effect.target] = current + effect.value;
          break;
        case "multiply":
          result[effect.target] = current * (1 + effect.value / 100);
          break;
        case "set":
          result[effect.target] = effect.value;
          break;
      }
    }

    return result;
  }

  advanceRound(): EconomyEvent[] {
    this.round++;
    const newEvents: EconomyEvent[] = [];

    return newEvents;
  }

  getState(): { activePolicies: Policy[]; recentEvents: EconomyEvent[]; round: number } {
    const activePolicies: Policy[] = [];
    for (const policy of Array.from(this.policies.values())) {
      if (policy.active) {
        activePolicies.push(policy);
      }
    }

    const recentEvents = this.events.slice(-20);

    return {
      activePolicies,
      recentEvents,
      round: this.round,
    };
  }
}
