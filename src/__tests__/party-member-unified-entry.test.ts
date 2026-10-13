// 建/删 PC 的单一入口。
//
// 背景：建一个 PC 有三条各不相同的路径（构造函数建 p1 / "创建角色"重建 p1 /
// "创建队友"建 p2+），八件事该做的没有一条路径全做齐：
//   1. sanityEngines.set   2. SAN 取角色 POW   3. world.registerPlayer
//   4. persistSanity       5. session.join/switchActive
//   6. characters.set      7. world.upsertEntity   8. careerStore 快照
// "创建角色"不建 SanityEngine——新角色沿用旧角色的 maxSAN（活 bug）；
// "创建队友"硬编码 SanityEngine(50)、不 upsertEntity——世界实体不存在，
// 构造函数自己的注释记过这个后果对 p2+ 一直活着。
//
// bun test src/__tests__/party-member-unified-entry.test.ts

import { afterAll, describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GameSession,
  parsePlayerCountRange,
  PARTY_HARD_LIMIT,
  runOrdinaryDurableActionTransaction,
} from "../api/game-session";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};

const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;
const careerRoot = mkdtempSync(join(tmpdir(), "party-member-durable-"));

afterAll(() => rmSync(careerRoot, { recursive: true, force: true }));

function newDurableSession(id: string, archetypeId?: string, characterName?: string): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    CFG,
    archetypeId,
    characterName,
    undefined,
    { careerRoot },
    undefined,
    "preferred",
    { careerEntryPersistence: "durable", ordinaryDurableHostCapability: durableCareerHostCapability },
  );
}

function durableAct(session: GameSession, input: string) {
  return runOrdinaryDurableActionTransaction(
    session,
    durableCareerHostCapability,
    async (act) => act(input),
  );
}

/** Portable snapshot evidence is the public observation of canonical PCs. */
function characterSnapshot(session: GameSession, pcId: string): any | undefined {
  return session.exportOrdinarySessionSnapshot().state.characters.find((entry) => entry.pcId === pcId)?.sheet;
}

/** 八项检查：对给定 session + pcId 断言全部成立，不齐就在这里红 */
function assertEightThings(session: any, pcId: string) {
  const sheet = characterSnapshot(session, pcId);
  expect(sheet).toBeDefined();

  // 1. canonical SAN is present in the persisted ordinary snapshot.
  const san = session.exportOrdinarySessionSnapshot().state.sanities.find((entry: { pcId: string }) => entry.pcId === pcId)?.state;
  expect(san).toBeDefined();

  // 2. SAN 取角色 POW（不是硬编码 50，也不是沿用了别的角色的）
  expect(san?.maxSAN).toBe(sheet.attributes.power);

  // 3. world.registerPlayer
  expect(session.world.getPlayerIds()).toContain(pcId);

  // 4. persistSanity（落库，不只是进程内缓存）
  const persisted = session.world.getPlayerSanity(pcId);
  expect(persisted).not.toBeNull();
  expect(persisted.maxSAN).toBe(sheet.attributes.power);

  // 5. session.join（PlayerSession 槽位存在，messageHistory 有归属）
  expect(session.session.get(pcId)).toBeDefined();

  // 6. characters.set（已经在函数开头取过，这里确认非 undefined）
  expect(session.exportOrdinarySessionSnapshot().state.characters.filter((entry: { pcId: string }) => entry.pcId === pcId)).toHaveLength(1);

  // 7. world.upsertEntity（世界实体真的存在，不是"等某个流程顺手建"）
  const ent = session.world.getEntity(pcId);
  expect(ent).toBeDefined();
  expect(ent.hp).toBe(sheet.hp);
  expect(ent.maxHp).toBe(sheet.maxHp);
  expect(ent.type).toBe("pc");

  // 8. careerStore 快照
  expect(session.careerStore).not.toBeNull();
  const snap = session.careerStore.getSnapshot(sheet.name);
  expect(snap).not.toBeNull();
  expect(snap.maxSan).toBe(sheet.attributes.power);
}

describe("八项对任意 PC 都成立——参数化覆盖三个入口", () => {
  it("p1（构造函数路径：new GameSession(..., archetypeId, name)）", () => {
    const s: any = newDurableSession(`u1-${Math.random()}`, "investigator", "甲");
    assertEightThings(s, "p1");
  });

  it("p1（\"创建角色\"路径：先无 archetype 构造，再建号）", async () => {
    const s: any = newDurableSession(`u2-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    assertEightThings(s, "p1");
  });

  it("p2（\"创建队友\"路径）", async () => {
    const s: any = newDurableSession(`u3-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    await durableAct(s, "创建队友 乙 investigator");
    assertEightThings(s, "p2");
  });

  it("p3（第二次\"创建队友\"，pcId 不撞车）", async () => {
    const s: any = newDurableSession(`u4-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    await durableAct(s, "创建队友 乙 investigator");
    await durableAct(s, "创建队友 丙 investigator");
    assertEightThings(s, "p2");
    assertEightThings(s, "p3");
  });
});

describe("活 bug 回归：\"创建角色\"后 SAN 上限必须取新角色的 POW", () => {
  it("**错误行为的红线**：即使占位 SAN 已被正式入口改变，新建角色后也必须换掉", async () => {
    const s: any = newDurableSession(`r1-${Math.random()}`); // 无 archetype，构造走 SAN(50) 空壳分支
    expect(s.setPlayerSan("p1", 1).ok).toBe(true);
    await durableAct(s, "创建角色 investigator 甲");
    expect(s.sanity.state.currentSAN).not.toBe(1);
    expect(s.sanity.state.maxSAN).toBe(s.activeCharacter.attributes.power);
    expect(s.sanity.state.currentSAN).toBe(s.activeCharacter.attributes.power);
  });

  it("**目标行为错误的对照**：重建后的公开 SAN 与持久化快照必须来自新角色，而不是只换了活动视图", async () => {
    const s: any = newDurableSession(`r2-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    expect(s.setPlayerSan("p1", 1)).toMatchObject({ ok: true });
    const first = s.exportOrdinarySessionSnapshot().state.sanities.find((entry: { pcId: string }) => entry.pcId === "p1")?.state;
    expect(first).toMatchObject({ currentSAN: 1 });
    await durableAct(s, "创建角色 investigator 乙"); // 重建同一个 pcId
    const second = s.exportOrdinarySessionSnapshot().state.sanities.find((entry: { pcId: string }) => entry.pcId === "p1")?.state;
    const replacementPow = s.activeCharacter.attributes.power;
    expect(second).toMatchObject({ currentSAN: replacementPow, maxSAN: replacementPow });
    expect(second?.currentSAN).not.toBe(1);
    expect(s.sanity.state).toEqual(second);
    expect(s.world.getPlayerSanity("p1")).toEqual(second);
    expect(first).toMatchObject({ currentSAN: 1 });
    expect(first?.currentSAN).not.toBe(second?.currentSAN);
  });

  it("**文本相似但合法**：重建时新角色 POW 恰好等于旧值也不算错——断言的是\"取自新角色\"不是\"数值必须变\"", async () => {
    const s: any = newDurableSession(`r3-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    // 直接把角色卡的 POW 手动改成与当前 SAN 相同的值，模拟"碰巧没变"
    expect(s.updateActiveCharacter({ attributes: { power: s.sanity.state.maxSAN } })).toMatchObject({ status: "updated" });
    await durableAct(s, "创建角色 investigator 甲"); // 用同名同职业重建，POW 由 buildCharacterForRuleset 重新随机
    // 不断言具体数值（会被重新随机），只断言"取自这次新建的角色"这一件事仍然成立
    expect(s.sanity.state.maxSAN).toBe(s.activeCharacter.attributes.power);
  });
});

describe("活 bug 回归：\"创建队友\"后世界实体必须真的存在", () => {
  it("**错误行为的红线**：GET 状态时不落到字面兜底 {name:\"调查员\", hp:12}", async () => {
    const s: any = newDurableSession(`w1-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    await durableAct(s, "创建队友 乙 investigator");
    await s.act("状态", "p2");
    const state = s.getState();
    const p2Sheet = characterSnapshot(s, "p2");
    expect(state.player.name).toBe(p2Sheet.name);
    expect(state.player.hp).toBe(p2Sheet.hp);
    expect(state.player.maxHp).toBe(p2Sheet.maxHp);
    // 排除"碰巧撞上兜底值"的可能——兜底是 name:"调查员"/hp:12/maxHp:12
    const isFallback = state.player.name === "调查员" && state.player.hp === 12 && state.player.maxHp === 12;
    expect(isFallback).toBe(false);
  });

  it("**目标行为错误的对照**：world.getEntity(pid) 本身就该有这一行，不只是 getState() 拼出来的", async () => {
    const s: any = newDurableSession(`w2-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    await durableAct(s, "创建队友 乙 investigator");
    const ent = s.world.getEntity("p2");
    expect(ent).toBeDefined();
    expect(ent.type).toBe("pc");
  });
});

describe("活 bug 回归：无 archetype 建会话后直接\"创建队友\"，不能顶掉玩家自己的 p1 槽位", () => {
  // 缺陷机制：不带 archetype 构造会走空壳分支，往 sanityEngines/world/session
  // 注册 "p1" 却**不填** #party。原本 pid 用 `#party.size + 1` 计算，
  // party.size 为 0 → pid = "p1"，队友的卡直接覆盖掉空壳的 SAN 引擎/
  // characters/世界实体，播报却说"加入了队伍"。根因是 pid 分配依赖了一个
  // 已知会短暂失同步的计数（party 不是唯一持有 pcId 的地方）。

  it("**错误行为的红线**：直接\"创建队友\"拿到的 pcId 不是 p1，p1 空壳槽位仍在，乙八项齐全", async () => {
    const s: any = newDurableSession(`o1-${Math.random()}`); // 无 archetype → 走空壳分支
    // 空壳分支确实建了 p1 的槽位（sanityEngines/world/session），但没填 party
    expect(s.getState().party.some((member: { pcId: string }) => member.pcId === "p1")).toBe(false); // 空壳不是正式成员——这本身就是缺陷的背景
    await durableAct(s, "创建队友 乙 investigator");
    // 乙的 pcId 不能复用 p1（哪怕 party.size 此刻是 0）
    expect(characterSnapshot(s, "p1")).toBeUndefined(); // 队友的卡没有顶进 p1
    const p2sheet = characterSnapshot(s, "p2");
    expect(p2sheet?.name).toBe("乙");
    // p1 空壳槽位仍然存在：三个持有者都在
    expect(s.session.get("p1")).toBeDefined();
    expect(s.exportOrdinarySessionSnapshot().state.sanities.some((entry: { pcId: string }) => entry.pcId === "p1")).toBe(true);
    expect(s.world.getPlayerIds()).toContain("p1");
    // 乙作为正式成员八项齐全
    assertEightThings(s, "p2");
    expect(s.getState().party.some((member: { pcId: string }) => member.pcId === "p2")).toBe(true);
  });

  it("**目标行为错误的对照**：创建队友之后再来\"创建角色 甲\"，甲落在 p1，乙不被覆盖", async () => {
    const s: any = newDurableSession(`o2-${Math.random()}`); // 无 archetype → 走空壳分支
    await durableAct(s, "创建队友 乙 investigator"); // 乙拿 p2（不能顶 p1）
    expect(characterSnapshot(s, "p2")?.name).toBe("乙");
    await durableAct(s, "创建角色 investigator 甲"); // 重建当前活跃 PC = p1
    expect(characterSnapshot(s, "p1")?.name).toBe("甲"); // 甲落在 p1，空壳被正式角色卡填充
    expect(characterSnapshot(s, "p2")?.name).toBe("乙"); // 乙没被覆盖
    assertEightThings(s, "p1");
    assertEightThings(s, "p2");
  });
});

describe("人数：硬上限 10 拒绝，模组推荐人数超出后警告但放行", () => {
  async function buildParty(n: number, session: any) {
    for (let i = 2; i <= n; i++) await durableAct(session, `创建队友 队友${i} investigator`);
  }

  it("**错误行为的红线**：第 11 个 PC 必须被拒绝，人数不增长", async () => {
    const s: any = newDurableSession(`n1-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲"); // p1，1 人
    await buildParty(PARTY_HARD_LIMIT, s); // 补到 10 人
    expect(s.getState().party).toHaveLength(PARTY_HARD_LIMIT);
    const res = await durableAct(s, "创建队友 队友11 investigator");
    expect(s.getState().party).toHaveLength(PARTY_HARD_LIMIT); // 没有增长
    const text = res.events.map((e: any) => e.content).join("\n");
    expect(text).toMatch(/上限|已满/);
  });

  it("**目标行为错误的对照**：第 10 个（边界值本身）必须放行，不能提前一步就拒绝", async () => {
    const s: any = newDurableSession(`n2-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    await buildParty(PARTY_HARD_LIMIT, s);
    expect(s.getState().party).toHaveLength(PARTY_HARD_LIMIT); // 10 人成功建成，没有在第 10 个就被拒
  });

  it("**文本相似但合法**：重建已存在的 pcId（\"创建角色\"）不受人数上限影响，即使队伍已满", async () => {
    const s: any = newDurableSession(`n3-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    await buildParty(PARTY_HARD_LIMIT, s);
    expect(s.getState().party).toHaveLength(PARTY_HARD_LIMIT);
    const res = await durableAct(s, "创建角色 investigator 甲改名"); // 重建 p1，不是新增
    expect(s.getState().party).toHaveLength(PARTY_HARD_LIMIT); // 人数不变，但重建本身要成功
    const text = res.events.map((e: any) => e.content).join("\n");
    expect(text).not.toMatch(/上限|已满/);
    expect(s.activeCharacter.name).toBe("甲改名");
  });

  it("**正确行为**：模组推荐 2~3 人的谷仓，第 4 人加入要有警告，且仍然加入成功", async () => {
    const s: any = newDurableSession(`n4-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    await s.act("加载模组 普瑞米尔的谷仓");
    const r2 = await durableAct(s, "创建队友 乙 investigator");
    const r3 = await durableAct(s, "创建队友 丙 investigator");
    const r4 = await durableAct(s, "创建队友 丁 investigator");
    const t2 = r2.events.map((e: any) => e.content).join("\n");
    const t3 = r3.events.map((e: any) => e.content).join("\n");
    const t4 = r4.events.map((e: any) => e.content).join("\n");
    expect(t2).not.toMatch(/模组推荐/); // 第 2 人在 2~3 范围内，不警告
    expect(t3).not.toMatch(/模组推荐/); // 第 3 人正好是上界，不警告
    expect(t4).toMatch(/模组推荐 2~3 人，当前 4 人/); // 第 4 人超出上界，警告
    expect(s.getState().party).toHaveLength(4); // 放行，不是拒绝
  });

  it("**目标行为错误的对照**：没加载任何模组时不该凭空警告（没有推荐人数就不该警告）", async () => {
    const s: any = newDurableSession(`n5-${Math.random()}`);
    await durableAct(s, "创建角色 investigator 甲");
    const r2 = await durableAct(s, "创建队友 乙 investigator");
    const r3 = await durableAct(s, "创建队友 丙 investigator");
    const r4 = await durableAct(s, "创建队友 丁 investigator");
    for (const r of [r2, r3, r4]) {
      const t = r.events.map((e: any) => e.content).join("\n");
      expect(t).not.toMatch(/模组推荐/);
    }
  });
});

describe("parsePlayerCountRange — 解析模组推荐人数字符串", () => {
  it("**正确**：\"2~3\" 这类波浪号格式", () => {
    expect(parsePlayerCountRange("2~3")).toEqual({ min: 2, max: 3 });
  });

  it("**目标行为错误的对照**：单个数字要解析成 min===max，不是 null", () => {
    expect(parsePlayerCountRange("4")).toEqual({ min: 4, max: 4 });
  });

  it("**文本相似但合法**：全角波浪号、连字符、中文\"至/到\"都要认得出，不只认半角 ~", () => {
    expect(parsePlayerCountRange("2～3")).toEqual({ min: 2, max: 3 });
    expect(parsePlayerCountRange("2-3")).toEqual({ min: 2, max: 3 });
    expect(parsePlayerCountRange("2至3")).toEqual({ min: 2, max: 3 });
  });

  it("**干扰**：解析不出来就是 null，不强行猜一个范围出来", () => {
    expect(parsePlayerCountRange("若干")).toBeNull();
    expect(parsePlayerCountRange("")).toBeNull();
    expect(parsePlayerCountRange(undefined)).toBeNull();
    expect(parsePlayerCountRange(null)).toBeNull();
  });

  it("**干扰**：min 写反了（\"3~2\"）也要归正，不该原样把大的当 min", () => {
    expect(parsePlayerCountRange("3~2")).toEqual({ min: 2, max: 3 });
  });
});
