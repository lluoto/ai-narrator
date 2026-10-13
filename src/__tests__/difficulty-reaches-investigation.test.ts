// 难度设了要真的传到调查引擎。
//
// 起因：`InvestigationEngine.setDifficultyProfile()` **全仓零调用方**，
// 于是 `difficultyProfile` 恒为 null，`effectiveProfile` 一直回落到写死的
// medium 画像。KP 把难度调成 nightmare 之后：
//   · 惩罚骰仍然是 0（应该 +2）
//   · 线索的 SAN 倍率仍然是 1（应该 2 倍）
// —— 难度按钮按下去，调查这一块**什么都没变**。
//
// GameSession 那边一直有 `activeDifficulty`（还过了 applyAction 闸门），
// 缺的只是「设完之后告诉调查引擎」这一句。

import { describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};

/** 钉住骰子，跑一条 1/1d6 的线索，返回实际扣掉的 SAN。 */
async function sanLossAt(diff: string | null): Promise<number> {
  const s = new GameSession(`d-${Math.random()}`, "cosmic-horror", CFG, "investigator", "甲");
  await s.act("加载模组 普瑞米尔的谷仓");
  expect(activateRegisteredGameSessionSceneForTest(s, "维修间")).toBe(true);
  if (diff) s.setDifficulty(diff);
  const before = s.sanity.state.currentSAN;
  const real = Math.random;
  Math.random = () => 0.999; // 检定失败 + 1d6 掷出 6
  try {
    expect((await s.act("查看母女的缸中脑")).error).toBeUndefined();
  } finally { Math.random = real; }
  return before - s.sanity.state.currentSAN;
}

describe("难度要传到调查引擎", () => {
  test("**正确**：默认（没设过难度）按 medium 算", async () => {
    expect(await sanLossAt(null)).toBe(6);
  });

  test("**错误行为的红线**：nightmare 的 SAN 倍率必须是 2 倍", async () => {
    // 接之前这条必红 —— 难度设了没人告诉调查引擎，恒按 medium 算 6 点。
    expect(await sanLossAt("nightmare")).toBe(12);
  });

  test("**正确**：四档倍率各不相同（0.5 / 1 / 1.5 / 2）", async () => {
    // 只测 nightmare 是不够的：一个「把所有难度都当 nightmare」的实现也能过。
    expect(await sanLossAt("easy")).toBe(3);
    expect(await sanLossAt("medium")).toBe(6);
    expect(await sanLossAt("hard")).toBe(9);
    expect(await sanLossAt("nightmare")).toBe(12);
  }, 20_000);

  test("**干扰输入**：不认识的难度名不该改变行为，也不该崩", async () => {
    const s = new GameSession(`d-${Math.random()}`, "cosmic-horror", CFG, "investigator", "甲");
    await s.act("加载模组 普瑞米尔的谷仓");
    expect(activateRegisteredGameSessionSceneForTest(s, "维修间")).toBe(true);
    expect(() => s.setDifficulty("超级困难")).not.toThrow();
    const before = s.sanity.state.currentSAN;
    const real = Math.random;
    Math.random = () => 0.999;
    try { expect((await s.act("查看母女的缸中脑")).error).toBeUndefined(); } finally { Math.random = real; }
    expect(before - s.sanity.state.currentSAN).toBe(6); // 仍按默认
  });
});
