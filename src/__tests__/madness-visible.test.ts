// 疯了之后玩家要看得见。
//
// 上一轮把疯狂判定接通了（调查掉 SAN 能触发临时/不定疯狂）。
// 接通之后实测了一遍「疯了会怎样」，发现后果一样是断的：
//
//   · **角色卡上完全看不到**：SAN 从 50 掉到 26（48%，已是中度不定疯狂），
//     角色卡还是只印一行 `SAN: 26/50`，临时疯狂、不定疯狂等级、
//     恐惧症、狂躁症一个都不显示。玩家不知道自己跨过了那条线，也就不知道该怎么演。
//     而 `SanityEngine.getSummary()` 拼的正是这些 —— **只有测试在调**。
//
//   · **「疯狂指引」返回一句写死的套话**：「当SAN大幅下降时，角色可能出现
//     各种精神障碍…」——结尾那个省略号说明它本来就是占位。
//     问这句话的人想知道的是**自己现在什么样**。
//     CLI 一直调 `getFullGuidance()`（index.ts:1136），这条路停在占位上。

import { describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

const textOf = (r: { events: { content: unknown }[] }) =>
  r.events.map((e) => String(e.content)).join("\n");

/** Build a character and drive four actual public SAN checks to insanity. */
async function drivenMad() {
  const s = new GameSession(`mv-${Math.random()}`, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  await s.act("创建角色 investigator 甲");
  const real = Math.random;
  Math.random = () => 0.999; // 检定必失败 + 1d6 必掷 6
  try {
    // This is the public Session command path: no public engine reference or
    // synthetic clue registration is needed to test visible insanity state.
    for (let i = 0; i < 4; i++) await s.act("理智检定");
  } finally { Math.random = real; }
  return { s };
}

describe("疯狂要在角色卡上看得见", () => {
  test("**前置**：这套流程确实把人逼疯了", async () => {
    // 先确认前置条件成立 —— 否则下面几条测的是「没疯的人不显示疯狂」，等于没测。
    const { s } = await drivenMad();
    expect(s.sanity.state.temporaryInsanity).toBe(true);
    expect(s.sanity.state.indefiniteInsanity).toBe(true);
  }, 20_000);

  test("**错误行为的红线**：角色卡必须显示疯狂状态", async () => {
    const { s } = await drivenMad();
    const card = textOf(await s.act("角色卡"));
    expect(card).toContain("精神:");
    expect(card).toContain("疯狂");
  }, 20_000);

  test("**正确**：没疯的人角色卡上不该有精神那一行", async () => {
    // 只测「疯了要显示」是不够的：一个无条件印一行的实现也能过。
    const s = new GameSession(`mv-${Math.random()}`, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    await s.act("创建角色 investigator 甲");
    const card = textOf(await s.act("角色卡"));
    expect(card).not.toContain("精神:");
  }, 20_000);
});

describe("疯狂指引要说本人的情况", () => {
  test("**错误行为的红线**：不能再返回那句写死的套话", async () => {
    const { s } = await drivenMad();
    const g = textOf(await s.act("疯狂指引"));
    expect(g).not.toContain("当SAN大幅下降时");
    expect(g).toContain("临时疯狂");
    expect(g).toContain("累计损失"); // 带上本人的实际数字
  }, 20_000);

  test("**正确**：精神正常的人问指引，要照实说清醒", async () => {
    // 措辞由引擎的 `getFullGuidance()` 决定（清醒这一支它自己就有），
    // 所以这里断言的是引擎的原话「清醒」。
    // 我第一版写的是「正常」—— 断言写的是我以为的措辞，不是实际的。
    const s = new GameSession(`mv-${Math.random()}`, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    await s.act("创建角色 investigator 甲");
    const g = textOf(await s.act("疯狂指引"));
    expect(g).toContain("清醒");
    expect(g).not.toContain("当SAN大幅下降时");
  }, 20_000);
});
