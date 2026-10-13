// 看见神话生物要掉 SAN。
//
// 起因：`NPCCombatEngine.getSanCost()` **零调用方**。`coc-npc.yaml` 给每种生物
// 都写了 san_cost（修格斯 1d6/1d20、深潜者 0/1d6、米戈 0/1d6…），
// 一条都没生效过 —— 遭遇修格斯和遭遇一条野狗，对理智的影响完全一样。
//
// 接线定的两件事，都按 CoC 7e：
//   · 目击即掷，不必等到战斗（挂在攻击流程上就太晚了）
//   · 同一种生物只在首次目击时掷，重复遭遇不再扣

import { afterEach, describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

type S = { sanity: { state: { currentSAN: number } } };

const sessions: GameSession[] = [];
afterEach(() => {
  while (sessions.length) sessions.pop()!.close();
});

async function sessionWith(names: string[], opts: { hp?: number; elsewhere?: boolean } = {}) {
  const source = new GameSession(
    `sg-${Math.random()}`,
    "cosmic-horror",
    CFG,
    "investigator",
    "甲",
    undefined,
    undefined,
    undefined,
    "preferred",
    TRANSIENT_RUNTIME,
  );
  const s = new GameSession(
    source.id,
    "cosmic-horror",
    CFG,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "preferred",
    TRANSIENT_RUNTIME,
  );
  try {
    restoreSignedOrdinaryWorld(s, CFG, (world) => {
      const scene = world.getCurrentState().scene;
      names.forEach((name, index) => world.upsertEntity({
        id: `m${index}`, name, type: "monster",
        hp: opts.hp ?? 30, maxHp: 30, ac: 0, status: [],
        position: opts.elsewhere ? "某个别的地方" : scene,
      }));
    });
  } finally {
    source.close();
  }
  sessions.push(s);
  const a = s as unknown as S;
  return { s, a };
}

const textOf = (r: { events: { content: unknown }[] }) =>
  r.events.map((e) => String(e.content)).join("\n");

describe("神话生物目击", () => {
  test("**错误行为的红线**：看见修格斯必须掷 SAN", async () => {
    // 接之前这条必红：getSanCost 没有任何调用方。
    const { s, a } = await sessionWith(["修格斯"]);
    const before = a.sanity.state.currentSAN;
    const out = textOf(await s.act("看看四周"));
    expect(out).toContain("目击");
    expect(out).toContain("修格斯");
    expect(a.sanity.state.currentSAN).toBeLessThanOrEqual(before);
  });

  test("**干扰输入**：野狗不是神话生物，不掉 SAN", async () => {
    // 只测「见了怪就掉 SAN」是不够的：一个见谁都掉的实现也能过上面那条。
    const { s, a } = await sessionWith(["野狗"]);
    const before = a.sanity.state.currentSAN;
    const out = textOf(await s.act("看看四周"));
    expect(out).not.toContain("目击");
    expect(a.sanity.state.currentSAN).toBe(before);
  });

  test("**正确**：同一种生物只掷一次，重复遭遇不再扣", async () => {
    const { s, a } = await sessionWith(["修格斯"]);
    await s.act("看看四周");
    const afterFirst = a.sanity.state.currentSAN;
    const out2 = textOf(await s.act("看看四周"));
    expect(out2).not.toContain("目击");
    expect(a.sanity.state.currentSAN).toBe(afterFirst);
  });

  test("**干扰输入**：不在同一场景的生物不算目击", async () => {
    const { s, a } = await sessionWith(["修格斯"], { elsewhere: true });
    const before = a.sanity.state.currentSAN;
    const out = textOf(await s.act("看看四周"));
    expect(out).not.toContain("目击");
    expect(a.sanity.state.currentSAN).toBe(before);
  });

  test("**干扰输入**：已经死掉的生物不算目击", async () => {
    const { s, a } = await sessionWith(["修格斯"], { hp: 0 });
    const before = a.sanity.state.currentSAN;
    const out = textOf(await s.act("看看四周"));
    expect(out).not.toContain("目击");
    expect(a.sanity.state.currentSAN).toBe(before);
  });

  test("**正确**：两种不同的神话生物各掷各的", async () => {
    const { s } = await sessionWith(["修格斯", "深潜者"]);
    const out = textOf(await s.act("看看四周"));
    expect(out).toContain("修格斯");
    expect(out).toContain("深潜者");
  });
});
