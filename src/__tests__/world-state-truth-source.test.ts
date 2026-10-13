// 阶段 1 验收 — 所有玩家状态写入都必须到达真相源（WorldStateManager）
//
// 背景：docs/kp-tool-surface-assessment.md §五.1 记录了真相源「已声明但不被强制」：
// SAN 停在 sanityEngines、物品停在 inventoryMap、武器停在 equippedWeaponsMap、
// 护甲停在 equippedArmorMap，全是 GameSession 的进程内 Map。
// 只要它们不落到 WorldStateManager，getCurrentState() 就是部分快照，
// 阶段 2 的 applyAction 闸门也就没有可校验的对象。
//
// bun test src/__tests__/world-state-truth-source.test.ts

import { describe, it, expect, beforeEach } from "bun:test";
import { GameSession } from "../api/game-session";

const LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 1024,
  temperature: 0.7,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

function makeSession(archetypeId?: string, characterRandomUnit?: () => number): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession("truth-source-session", "cosmic-horror", LLM, archetypeId, "调查员", undefined, undefined, undefined, "preferred", {
    ...TRANSIENT_RUNTIME,
    ...(characterRandomUnit ? { characterRandomUnit } : {}),
  });
}

let session: GameSession;

beforeEach(() => {
  session = makeSession();
});

describe("阶段1 · 状态写入到达真相源", () => {
  it("背包写入可从真相源读回", () => {
    session.setPlayerInventory("p1", ["煤油灯", "左轮手枪"]);
    expect(session.world.getPlayerInventory("p1")).toEqual(["煤油灯", "左轮手枪"]);
  });

  it("已装备武器写入可从真相源读回", () => {
    session.setPlayerWeapons("p1", ["左轮手枪"]);
    expect(session.world.getPlayerWeapons("p1")).toEqual(["左轮手枪"]);
  });

  it("SAN 写入可从真相源读回", () => {
    session.setPlayerSan("p1", 33);
    expect(session.world.getPlayerSanity("p1")?.currentSAN).toBe(33);
  });

  it("SAN 上限不被当前值压低，且上限一并落到真相源", () => {
    session.setPlayerSan("p1", 30);
    const san = session.world.getPlayerSanity("p1");
    expect(san?.currentSAN).toBe(30);
    expect(san?.maxSAN).toBeGreaterThanOrEqual(50);
  });

  it("护甲槽即使为空也在真相源中有记录", () => {
    expect(session.world.getPlayerArmor("p1")).toEqual([]);
  });
});

describe("阶段1 · getCurrentState() 是完整快照", () => {
  it("快照包含每个玩家的 SAN / 背包 / 武器 / 护甲", () => {
    session.setPlayerInventory("p1", ["笔记本"]);
    session.setPlayerWeapons("p1", ["猎枪"]);
    session.setPlayerSan("p1", 41);

    const snap = session.world.getCurrentState();
    const p1 = snap.players["p1"];
    expect(p1).toBeDefined();
    expect(p1!.inventory).toEqual(["笔记本"]);
    expect(p1!.weapons).toEqual(["猎枪"]);
    expect(p1!.armor).toEqual([]);
    expect(p1!.sanity?.currentSAN).toBe(41);
  });

  it("快照每次重新读取，不返回可写穿的缓存对象", () => {
    session.setPlayerInventory("p1", ["绳索"]);
    const first = session.world.getCurrentState();
    first.players["p1"]!.inventory.push("不该被持久化的东西");

    const second = session.world.getCurrentState();
    expect(second.players["p1"]!.inventory).toEqual(["绳索"]);
  });
});

// KP 面板与队友招募都要求 characters 里确有角色，因此这一组必须带 archetype 建会话：
// 不带 archetype 时 characters 为空，KP 面板没有角色行，
// 且队友 id 由 `p${characters.size + 1}` 推出，会退化成与既有玩家同号的 "p1"。
describe("阶段1 · 读取面与真相源一致", () => {
  let s: GameSession;

  beforeEach(() => {
    // This is a successful-write fixture, not a random SAN-domain test.
    s = makeSession("investigator", () => 0.25);
  });

  it("KP 面板读到的背包/武器/SAN 来自真相源", () => {
    expect(s.activeCharacter.attributes.power).toBe(61);
    expect(s.world.getPlayerSanity("p1")?.maxSAN).toBe(61);
    s.setPlayerInventory("p1", ["撬棍"]);
    s.setPlayerWeapons("p1", ["猎刀"]);
    expect(s.setPlayerSan("p1", 44).ok).toBe(true);
    expect(s.sanity.state.currentSAN).toBe(44);
    expect(s.world.getPlayerSanity("p1")?.currentSAN).toBe(44);

    const kp = s.getKPState();
    const p1 = kp.characters.find((c: { playerId: string }) => c.playerId === "p1");
    expect(p1).toBeDefined();
    expect(p1.inventory).toEqual(["撬棍"]);
    expect(p1.weapons).toEqual(["猎刀"]);
    expect(p1.san).toBe(44);
  });

  it("低 POW 的 SAN 越界写入被拒绝，所有读取面与真相源保持不变", () => {
    let entropyState = 722;
    const low = makeSession("investigator", () => {
      entropyState = (Math.imul(entropyState, 1664525) + 1013904223) >>> 0;
      return entropyState / 0x1_0000_0000;
    });
    try {
      expect(low.activeCharacter.attributes.power).toBe(43);
      const priorSanity = structuredClone(low.sanity.state);
      const priorWorld = low.world.getCurrentState();
      expect(priorSanity.currentSAN).toBe(43);
      expect(priorSanity.maxSAN).toBe(43);
      expect(low.setPlayerSan("p1", 44)).toEqual({
        ok: false,
        error: {
          code: "value_out_of_domain", variable: "san:p1", to: 44,
          domain: { kind: "integer", min: 0, max: 43 },
        },
      });
      expect(low.sanity.state).toEqual(priorSanity);
      expect(low.world.getCurrentState()).toEqual(priorWorld);
      const p1 = low.getKPState().characters.find((c: { playerId: string }) => c.playerId === "p1");
      expect(p1.san).toBe(43);
      expect(p1.maxSan).toBe(43);
    } finally {
      low.close();
    }
  });

  it("新加入的队友状态同样落到真相源", async () => {
    await s.act("创建队友 阿尔伯特 investigator");

    const ids = s.world.getPlayerIds();
    expect(ids).toContain("p1");
    expect(ids.length).toBeGreaterThan(1);

    const newId = ids.find((id) => id !== "p1")!;
    expect(s.world.getPlayerInventory(newId)).toEqual([]);
    expect(s.world.getPlayerWeapons(newId)).toEqual([]);
    expect(s.world.getPlayerSanity(newId)?.maxSAN).toBeGreaterThan(0);
  });
});
