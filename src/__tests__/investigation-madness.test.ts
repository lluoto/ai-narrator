// 调查线索掉的 SAN 要能让人发疯。
//
// 起因：`InvestigationEngine.investigateCoC()` 自己掷线索的 SAN 损失，
// 把 `sanLost` 返回给调用方；两个前端拿到之后都是**直接赋值** `currentSAN`：
//   · api/game-session.ts 走 setPlayerSan（那是 KP 管理操作，不跑疯狂判定）
//   · index.ts:684 直接 `sanity.state.currentSAN = ...`
// 而临时疯狂（单次 ≥5）、不定疯狂（累计 20%）、疯狂表、恐惧症/狂躁症
// 全都写在 `sanityCheck()` 里 —— 绕过它就等于**掉了 SAN 但永远不疯**。
//
// 不是边缘情况：`investigation.yaml` 的 `1/1d6` 失败时有 1/3 概率掷出 5 或 6。
// 疯狂是 CoC 最标志性的机制。

import { describe, test, expect } from "bun:test";
import { SanityEngine } from "../rules/coc-engine";
import { InvestigationEngine } from "../investigation/investigation-engine";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

describe("线索的 SAN 骰子要真的掷", () => {
  // ⚠ 原实现是：
  //     const num = parseInt(costStr);
  //     let baseLost = isNaN(num) ? CoCEngine.rollDice(costStr) : num;
  //   而 **`parseInt("1d6") === 1`**（取前导数字，不是 NaN），
  //   于是 rollDice 那一支永远到不了，所有线索的 SAN 损失恒等于首位数字。
  //   连带后果：临时疯狂阈值是单次 ≥5，调查永远掉 1 点 ——
  //   **这条路上的疯狂在数学上不可能发生**。
  function lossOf(sanCost: string, randomValue: number): number {
    const eng = new InvestigationEngine();
    eng.registerSceneClue("s", "c", "d", sanCost);
    const real = Math.random;
    Math.random = () => randomValue;
    try {
      // 技能给 0 保证检定失败 → 取斜杠右侧
      return eng.investigateCoC("c", {}, "p1").sanLost;
    } finally { Math.random = real; }
  }

  test("**错误行为的红线**：1d6 掷到上限要给 6，不能恒为 1", () => {
    expect(lossOf("1/1d6", 0.999)).toBe(6);
  });

  test("**正确**：同一个 1d6 掷到下限给 1", () => {
    expect(lossOf("1/1d6", 0)).toBe(1);
  });

  test("**干扰输入**：纯数字仍按数字算", () => {
    expect(lossOf("1/4", 0.999)).toBe(4);
  });

  test("**干扰输入**：2d6 的首位数字是 2，掷出来必须大于 2", () => {
    // 这条专门咬 parseInt：坏实现会返回 2。
    expect(lossOf("1/2d6", 0.999)).toBe(12);
  });
});

const eng = (pow = 60) => new SanityEngine(pow);

describe("applyLoss：扣血和疯狂判定必须是同一个动作", () => {
  test("**正确**：扣掉的就是给的数", () => {
    const e = eng(60);
    const before = e.state.currentSAN;
    const r = e.applyLoss(3);
    expect(r.sanLoss).toBe(3);
    expect(e.state.currentSAN).toBe(before - 3);
  });

  test("**错误行为的红线**：单次损失 ≥5 必须触发临时疯狂", () => {
    // 改之前调查这条路根本到不了这里 —— 它绕过引擎直接赋值。
    const e = eng(60);
    const r = e.applyLoss(5);
    expect(r.temporaryInsanityTriggered).toBe(true);
    expect(r.boutOfMadness).toBeTruthy();
    expect(e.state.temporaryInsanity).toBe(true);
  });

  test("**干扰输入**：4 点不触发 —— 阈值是 5 不是「掉了就疯」", () => {
    const e = eng(60);
    const r = e.applyLoss(4);
    expect(r.temporaryInsanityTriggered).toBe(false);
    expect(e.state.temporaryInsanity).toBe(false);
  });

  test("**正确**：累计到 20% 触发不定性疯狂并定级", () => {
    const e = eng(60); // maxSAN 60，20% = 12
    e.applyLoss(4);
    e.applyLoss(4);
    const r = e.applyLoss(4); // 累计 12
    expect(r.indefiniteInsanityTriggered).toBe(true);
    expect(r.indefiniteLevel).toBe("mild");
    expect(e.state.phobias.length).toBeGreaterThan(0); // 不定疯狂必得 1 恐惧症
  });

  test("**干扰输入**：SAN 不够扣时最多扣到 0，不会变负", () => {
    const e = eng(60);
    e.applyLoss(58);
    const r = e.applyLoss(99);
    expect(e.state.currentSAN).toBe(0);
    expect(r.sanLoss).toBe(2); // 只扣得动 2 点
  });

  test("**正确**：临时疯狂只触发一次，不会每次都重报", () => {
    const e = eng(60);
    expect(e.applyLoss(5).temporaryInsanityTriggered).toBe(true);
    expect(e.applyLoss(5).temporaryInsanityTriggered).toBe(false);
  });
});

// ⚠ 这一组是变异检验逼出来的：上面那些只测了引擎（applyLoss），
//   把 GameSession 里的 `temporaryInsanityTriggered` 强行改成 false
//   （即「疯了但不告诉玩家」），**全量 1889 条一条都没红**。
//   引擎算对了不等于玩家看得见。
describe("疯狂要播报给玩家，不能只在状态里", () => {
  test("**错误行为的红线**：调查触发临时疯狂时必须出现在输出里", async () => {
    const { GameSession } = await import("../api/game-session");
    const s = new GameSession(`md-${Math.random()}`, "cosmic-horror", {
      apiKey: "sk-x", baseUrl: "http://localhost:9999", model: "m", maxTokens: 64, temperature: 0,
    }, "investigator", "甲");
    expect((await s.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect(activateRegisteredGameSessionSceneForTest(s, "维修间")).toBe(true);

    const real = Math.random;
    Math.random = () => 0.999; // 检定失败 + 1d6 掷出 6 → 必触发
    let result: { events: Array<{ content: string }> } | undefined;
    try { result = await s.act("查看母女的缸中脑"); }
    finally { Math.random = real; }

    const text = result!.events.map((event) => event.content).join("\n");
    expect(s.sanity.state.temporaryInsanity).toBe(true); // 状态确实变了
    expect(text).toContain("临时疯狂");                      // 玩家也确实看见了
    expect(text.length).toBeGreaterThan("临时疯狂".length + 8); // 且带了疯狂表的内容
  });
});

describe("sanityCheck 仍然照旧", () => {
  test("**正确**：掷骰、通过与否、损失都还在（抽出 applyLoss 没改变它的契约）", () => {
    const e = eng(60);
    const r = e.sanityCheck("1/1d6");
    expect(r.roll).toBeGreaterThanOrEqual(1);
    expect(r.roll).toBeLessThanOrEqual(100);
    expect(typeof r.passed).toBe("boolean");
    expect(r.sanLoss).toBeGreaterThanOrEqual(1);
    expect(e.state.currentSAN).toBe(60 - r.sanLoss);
  });

  test("**正确**：通过时扣的是斜杠左边，失败时是右边", () => {
    // 用 "0/6"：通过扣 0，失败扣 6（且失败必然触发临时疯狂）
    const e = eng(100); // SAN 100 → d100 必然 ≤ 100 → 必过
    const r = e.sanityCheck("0/6");
    expect(r.passed).toBe(true);
    expect(r.sanLoss).toBe(0);

    const e2 = eng(1); // SAN 1 → 几乎必失败
    const r2 = e2.sanityCheck("0/6");
    if (!r2.passed) expect(r2.sanLoss).toBe(1); // 只剩 1 点，最多扣 1
  });
});
