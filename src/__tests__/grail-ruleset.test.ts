// 圣杯规则集的攻击裁决
// bun test src/__tests__/grail-ruleset.test.ts

import { describe, it, expect } from "bun:test";
import { RulesEngine } from "../rules/rules-engine";
import { GrailEngine, inferGrailRank } from "../rules/grail-engine";
import type { WorldEntity } from "../types";

/** index.ts getPlayerAttributes() 交给规则路由器的就是这个形状 —— 没有 status */
function playerSheet() {
  return {
    name: "调查员",
    id: "player",
    proficiency: 2,
    abilities: { strength: 50, dexterity: 50 },
    hasSneakAttack: false,
  };
}

function entity(over: Partial<WorldEntity> = {}): WorldEntity {
  return {
    id: "m1", name: "守卫", type: "monster",
    hp: 30, maxHp: 30, ac: 15, status: [], position: "here",
    ...over,
  };
}

describe("圣杯裁决 — 攻击方不是世界实体", () => {
  // 之前这里是 as any 硬转成 WorldEntity 的：inferRank 展开 attacker.status，
  // 而玩家属性表没有这个字段，于是抛 "Spread syntax requires ...iterable"。
  // 切到 /规则 grail 之后每一次攻击都会崩。
  it("玩家属性表作为攻击方不抛异常", () => {
    const engine = new RulesEngine();
    expect(() =>
      engine.adjudicateAttack({ action: "attack", target: "m1" }, playerSheet(), entity(), "grail")
    ).not.toThrow();
  });

  it("返回的是完整的圣杯裁决结果", () => {
    const engine = new RulesEngine();
    const r = engine.adjudicateAttack(
      { action: "attack", target: "m1" }, playerSheet(), entity(), "grail"
    );
    expect(r.ruleset).toBe("grail");
    expect(typeof r.hit).toBe("boolean");
    expect(typeof r.damage).toBe("number");
    expect(["kill", "wound", "miss"]).toContain(r.result);
  });

  it("无效字符串位阶在真实路由攻击中回落而不崩溃", () => {
    const engine = new RulesEngine();
    const attacker = { ...playerSheet(), name: "黄金调查员", attributes: { rank: "platinum" } };
    const r = engine.adjudicateAttack(
      { action: "attack", target: "m1" },
      attacker,
      entity(),
      "grail",
    );

    expect(r.ruleset).toBe("grail");
    expect(typeof r.hit).toBe("boolean");
    expect(["kill", "wound", "miss"]).toContain(r.result);
  });
});

describe("inferRank — 只依赖它真正读的字段", () => {
  it("没有 status 时按名字推断", () => {
    const g = new GrailEngine();
    expect(g.inferRank({ name: "传奇的骑士" })).toBe("legendary");
    expect(g.inferRank({ name: "黄金位阶守卫" })).toBe("gold");
    expect(g.inferRank({ name: "无名小卒" })).toBe("bronze");
  });

  it("status 里的位阶字样同样生效", () => {
    const g = new GrailEngine();
    expect(g.inferRank({ name: "守卫", status: ["白银"] })).toBe("silver");
  });

  it("attributes.rank 优先于名字", () => {
    const g = new GrailEngine();
    expect(g.inferRank({ name: "传奇的骑士", attributes: { rank: "iron" } })).toBe("iron");
  });

  it("世界实体本身也满足这个入参", () => {
    const g = new GrailEngine();
    expect(g.inferRank(entity({ name: "黑铁卫兵" }))).toBe("iron");
  });
});

// 位阶推断此前有两份实现：GrailEngine.inferRank，以及 npc-combat 私有的
// getGrailRank。后者用 `(entity as any).attributes` 取值，且写的是
// `if (attrs?.rank) return attrs.rank`——没有类型判断，attributes 里放一个
// 数值 rank 就会被原样返回，而调用方拿它去索引位阶配置表。
// WorldEntity.attributes 声明的恰恰是 Record<string, number>，所以这条路可达。
describe("inferGrailRank — 位阶推断的唯一实现", () => {
  it("字符串 rank 优先于名字", () => {
    expect(inferGrailRank({ name: "传奇的骑士", attributes: { rank: "iron" } })).toBe("iron");
  });

  it("只接受声明的五个字符串位阶", () => {
    const validRanks = ["bronze", "iron", "silver", "gold", "legendary"] as const;
    for (const rank of validRanks) {
      expect(inferGrailRank({ name: "无名小卒", attributes: { rank } })).toBe(rank);
    }
  });

  it("无效字符串 rank 回落到名字与 status 的既有优先级", () => {
    expect(inferGrailRank({ name: "黄金位阶守卫", attributes: { rank: "platinum" } })).toBe("gold");
    expect(inferGrailRank({ name: "守卫", status: ["白银"], attributes: { rank: "platinum" } })).toBe("silver");
  });

  it("没有合法位阶提示时，无效字符串 rank 回落到青铜", () => {
    expect(inferGrailRank({ name: "无名小卒", attributes: { rank: "platinum" } })).toBe("bronze");
  });

  it("数值 rank 不算位阶，回落到名字与 status", () => {
    expect(inferGrailRank({ name: "黄金位阶守卫", attributes: { rank: 3 } })).toBe("gold");
    expect(inferGrailRank({ name: "无名小卒", attributes: { rank: 3 } })).toBe("bronze");
  });

  it("与类方法给出同一答案", () => {
    const g = new GrailEngine();
    const cases = [
      { name: "传奇的骑士" },
      { name: "守卫", status: ["白银"] },
      { name: "无名小卒" },
    ];
    for (const c of cases) {
      expect(inferGrailRank(c)).toBe(g.inferRank(c));
    }
  });
});
