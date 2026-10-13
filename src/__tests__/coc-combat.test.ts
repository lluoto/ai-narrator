// CoC 7e 瞄准 + 贯穿 + 命中部位 测试
import { describe, it, expect } from "bun:test";
import { CoCEngine, rollHitLocation, getCalledShotPenalty, getHitLocationEffect } from "../rules/coc-engine";
import type { HitLocation } from "../rules/coc-engine";

describe("CoC 瞄准 + 贯穿 + 命中部位", () => {

  // ============================================================
  // 命中部位
  // ============================================================
  describe("rollHitLocation", () => {
    const VALID_LOCATIONS: HitLocation[] = ["右腿", "左腿", "腹部", "胸部", "右臂", "左臂", "头部"];

    it("随机部位总是返回合法值", () => {
      for (let i = 0; i < 200; i++) {
        const loc = rollHitLocation();
        expect(VALID_LOCATIONS).toContain(loc);
      }
    });

    it("不同部位的概率分布合理（头部约 5%）", () => {
      let headCount = 0;
      const N = 10000;
      for (let i = 0; i < N; i++) {
        if (rollHitLocation() === "头部") headCount++;
      }
      // 头部概率 5%（1/20），允许 ±2%
      const ratio = headCount / N;
      expect(ratio).toBeGreaterThan(0.03);
      expect(ratio).toBeLessThan(0.08);
    });

    it("瞄准头部时总是返回头部", () => {
      for (let i = 0; i < 50; i++) {
        expect(rollHitLocation("头部")).toBe("头部");
      }
    });

    it("模糊匹配：颈部→头部", () => {
      expect(rollHitLocation("颈部")).toBe("头部");
      expect(rollHitLocation("武器")).toBe("右臂");
      expect(rollHitLocation("手")).toBe("右臂");
      expect(rollHitLocation("眼睛")).toBe("头部");
    });
  });

  // ============================================================
  // 瞄准副手骰
  // ============================================================
  describe("getCalledShotPenalty", () => {
    it("眼睛 3 penalty die", () => {
      expect(getCalledShotPenalty("眼睛")).toBe(3);
      expect(getCalledShotPenalty("瞄准眼睛")).toBe(3);
    });

    it("头部/手 2 penalty die", () => {
      expect(getCalledShotPenalty("头部")).toBe(2);
      expect(getCalledShotPenalty("手")).toBe(2);
    });

    it("手臂/腿/武器 1 penalty die", () => {
      expect(getCalledShotPenalty("手臂")).toBe(1);
      expect(getCalledShotPenalty("左腿")).toBe(1);
      expect(getCalledShotPenalty("武器")).toBe(1);
    });

    it("腹部 0 penalty die", () => {
      expect(getCalledShotPenalty("腹部")).toBe(0);
      expect(getCalledShotPenalty("腰部")).toBe(0);
    });
  });

  // ============================================================
  // 命中部位效果
  // ============================================================
  describe("getHitLocationEffect", () => {
    it("普通命中头部（伤害≥5）有副效果", () => {
      const eff = getHitLocationEffect("头部", 5, false, false);
      expect(eff.secondaryEffect).toBe("下轮-20%");
      expect(eff.description).toContain("头部");
    });

    it("普通命中头部（伤害小）无副效果", () => {
      const eff = getHitLocationEffect("头部", 2, false, false);
      expect(eff.secondaryEffect).toBeUndefined();
    });

    it("贯穿头部有致盲效果", () => {
      const eff = getHitLocationEffect("头部", 8, true, false);
      expect(eff.secondaryEffect).toBe("致盲一轮");
      expect(eff.description).toContain("贯穿头部");
    });

    it("暴击头部有即死检定", () => {
      const eff = getHitLocationEffect("头部", 12, true, true);
      expect(eff.secondaryEffect).toBe("即死检定");
      expect(eff.description).toContain("昏迷");
    });

    it("贯穿腹部有全行动减益", () => {
      const eff = getHitLocationEffect("腹部", 6, true, false);
      expect(eff.secondaryEffect).toBe("全行动-20%");
    });

    it("贯穿腿部有倒地效果", () => {
      const eff = getHitLocationEffect("右腿", 5, true, false);
      expect(eff.secondaryEffect).toBe("倒地");
    });

    it("贯穿手臂有缴械效果", () => {
      const eff = getHitLocationEffect("右臂", 4, true, false);
      expect(eff.secondaryEffect).toBe("缴械");
    });

    it("暴击胸部有持续失血", () => {
      const eff = getHitLocationEffect("胸部", 10, true, true);
      expect(eff.secondaryEffect).toBe("持续失血");
    });

    it("只把已有精确执行语义的腹部失能/贯穿、头部昏迷与胸部大出血投影为状态", () => {
      const incapacitating = getHitLocationEffect("腹部", 6, true, true);
      expect(incapacitating.secondaryEffect).toBe("眩晕一轮");
      expect(incapacitating.statusEffect).toBe("incapacitated");

      const unconscious = getHitLocationEffect("头部", 12, true, true);
      expect(unconscious.secondaryEffect).toBe("即死检定");
      expect(unconscious.statusEffect).toBe("stunned");
      expect(unconscious.followUp).toEqual({ kind: "head-critical-con-death" });

      const chestImpale = getHitLocationEffect("胸部", 6, true, false);
      expect(chestImpale.followUp).toEqual({ kind: "chest-impale-con-incapacitation" });

      const chestCritical = getHitLocationEffect("胸部", 12, true, true);
      expect(chestCritical.statusEffect).toBe("hemorrhaging");

      const abdominalImpale = getHitLocationEffect("腹部", 6, true, false);
      expect(abdominalImpale.statusEffect).toBe("abdominal_impaled");
      expect(abdominalImpale.statusEffectDurationDice).toBe("1d3");
      expect(chestCritical.followUp).toBeUndefined();
    });
  });

  // ============================================================
  // CombatCheck 贯穿伤害
  // ============================================================
  describe("combatCheck 贯穿伤害", () => {
    // 固定骰值：1 = critical
    it("暴击时伤害为最大值", () => {
      // skill 99 确保投1是暴击
      for (let i = 0; i < 30; i++) {
        const result = CoCEngine.combatCheck(99, null, "2d6+4", 0, 0, false, undefined);
        // 投1时暴击，2d6+4 = 12+4 = 16
        if (result.successLevel === "critical" || result.successLevel === "extreme") {
          expect(result.damage).toBe(16);
          expect(result.isImpale).toBe(true);
        }
      }
    });

    it("瞄准模式下极限成功=暴击（damage 最大）", () => {
      // 原先包在 `if (successLevel === extreme || critical)` 里 —— 掷不出就一条都不验。
      // 钉住掷骰：d100 = 1 必定大成功。
      const real = Math.random;
      try {
        Math.random = () => 0;
        const result = CoCEngine.combatCheck(99, null, "1d8", 1, 0, true, "头部");
        expect(result.successLevel).toBe("critical");
        expect(result.damage).toBe(8);
        expect(result.isCritical).toBe(true);
        expect(result.hitLocation).toBe("头部");
      } finally { Math.random = real; }
    });

    it("普通成功走随机伤害", () => {
      let hasRegular = false;
      for (let i = 0; i < 50; i++) {
        const result = CoCEngine.combatCheck(50, null, "1d6", 0, 0, false, undefined);
        if (result.successLevel === "regular") {
          hasRegular = true;
          // 普通成功：1d6 在 1-6 之间随机
          expect(result.damage).toBeGreaterThanOrEqual(1);
          expect(result.damage).toBeLessThanOrEqual(6);
          expect(result.isImpale).toBe(false);
        }
      }
      expect(hasRegular).toBe(true);
    });

    it("瞄准头部时 hitLocation 为头部", () => {
      let hitCount = 0;
      for (let i = 0; i < 100; i++) {
        const result = CoCEngine.combatCheck(90, null, "1d6", 0, 1, true, "头部");
        if (result.hit) {
          hitCount++;
          expect(result.hitLocation).toBe("头部");
        }
      }
      expect(hitCount).toBeGreaterThan(0);
    });

    it("大失败时 isImpale=false", () => {
      // 原先包在 `if (!result.hit)` 里 —— 技能 10 也有一成命中，那一成里什么都不验。
      // 钉住掷骰：d100 = 100，必定大失败。
      const real = Math.random;
      try {
        Math.random = () => 0.999;
        const result = CoCEngine.combatCheck(10, null, "1d6", 0, 0, false, undefined);
        expect(result.hit).toBe(false);
        expect(result.isImpale).toBe(false);
        expect(result.isCritical).toBe(false);
      } finally { Math.random = real; }
    });

    it("闪避成功且非暴击时 isImpale=false", () => {
      for (let i = 0; i < 100; i++) {
        const result = CoCEngine.combatCheck(30, 90, "1d6", 0, 0, false, undefined);
        if (!result.hit && result.result === "对方闪避成功") {
          expect(result.isImpale).toBe(false);
          expect(result.isCritical).toBe(false);
        }
      }
    });
  });

  // ============================================================
  // 数据完整性
  // ============================================================
  describe("数据完整性", () => {
    it("所有命中部位都有对应的部位效果描述", () => {
      const locs: HitLocation[] = ["右腿", "左腿", "腹部", "胸部", "右臂", "左臂", "头部"];
      for (const loc of locs) {
        const eff = getHitLocationEffect(loc, 5, false, false);
        // 描述必须包含部位的关键字（有些描述使用"腿部"/"手臂"代替"右腿"/"左臂"）
        // 原先写成 `const _broadMatch = 三元表达式(每支都是 expect)`，
        // 变量没人读。改成 if/else —— 断言不该藏在三元里，
        // 那样既看不清哪一支跑了，也容易在重构时被整条求值掉。
        if (["右腿", "左腿"].includes(loc)) expect(eff.description).toMatch(/腿/);
        else if (["右臂", "左臂"].includes(loc)) expect(eff.description).toMatch(/臂/);
        else expect(eff.description).toContain(loc);
        const impaleEff = getHitLocationEffect(loc, 8, true, false);
        expect(impaleEff.description).toContain("贯穿");
        const critEff = getHitLocationEffect(loc, 12, true, true);
        expect(critEff.description).toContain("贯穿");
      }
    });

    it("called shot 瞄准各部位 penalty 均有定义", () => {
      const targets = ["眼睛", "头部", "手", "武器", "手臂", "左腿", "胸部", "腹部"];
      for (const t of targets) {
        const p = getCalledShotPenalty(t);
        expect(typeof p).toBe("number");
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(3);
      }
    });
  });
});
