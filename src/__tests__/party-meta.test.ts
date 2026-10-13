// 玩家扮演元数据（personality/backstory/currentGoal）落到 PartyMember.meta 的
// 三种入口：构造函数 p1、addPartyMember（web POST /party 共用）、文本命令「创建队友」。
//
// meta 只落值不消费（本轮给后续 PlayerAgent 接进来时读）。链由
// resolvePlayerMetaSync 解析：HTTP（优先）→ backgroundProfile 推导。
// 断言走到 createPartyMember（八件事一次做齐）—— 别让加 meta 把建卡流程带偏。

import { describe, test, expect } from "bun:test";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};

const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;

function durableSession(
  id: string,
  archetypeId?: string,
  characterName?: string,
  persona?: ConstructorParameters<typeof GameSession>[5],
): any {
  const session = new GameSession(
    id,
    "cosmic-horror",
    CFG,
    archetypeId,
    characterName,
    persona,
    undefined,
    undefined,
    "preferred",
    { ordinaryDurableHostCapability: durableCareerHostCapability },
  );
  return new Proxy(session, {
    get(target, property) {
      if (property === "act") {
        return (input: string, pcId?: string) => runOrdinaryDurableActionTransaction(
          target,
          durableCareerHostCapability,
          async (act) => act(input, pcId),
        );
      }
      if (property === "addPartyMember") {
        return (name: string, occupation: string, meta?: unknown) => runOrdinaryDurableActionTransaction(
          target,
          durableCareerHostCapability,
          async () => target.addPartyMember(name, occupation, meta as any),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function characterSnapshot(session: GameSession, pcId: string): any | undefined {
  return session.exportOrdinarySessionSnapshot().state.characters.find((entry) => entry.pcId === pcId)?.sheet;
}

function assertEightThings(session: any, pcId: string) {
  const sheet = characterSnapshot(session, pcId);
  expect(sheet).toBeDefined();
  const sanity = session.exportOrdinarySessionSnapshot().state.sanities.find((entry: { pcId: string }) => entry.pcId === pcId)?.state;
  expect(sanity).toBeDefined();
  expect(sanity?.maxSAN).toBe(sheet.attributes.power);
  expect(session.world.getPlayerIds()).toContain(pcId);
  expect(session.world.getPlayerSanity(pcId)).not.toBeNull();
  expect(session.session.get(pcId)).toBeDefined();
  expect(session.world.getEntity(pcId)).toBeDefined();
  const snap = session.careerStore.getSnapshot(sheet.name);
  expect(snap).not.toBeNull();
  expect(snap.maxSan).toBe(sheet.attributes.power);
}

describe("addPartyMember —— meta 落值 + 八件事", () => {
  test("**正确**：HTTP 字段最优先，maxSan 与 meta 一起就位；仍是完整八件事", async () => {
    const s: any = durableSession(`pm1-${Math.random()}`);
    await s.act("创建角色 investigator 甲");
    const r = await s.addPartyMember("乙", "investigator", {
      personality: "手填性格",
      backstory: "手填背景",
      currentGoal: "手填目标",
    });
    expect("rejected" in r).toBe(false);
    const m = (r as any).member;
    expect(m.pcId).toBe("p2");
    expect(m.meta).toEqual({ personality: "手填性格", backstory: "手填背景", currentGoal: "手填目标" });
    assertEightThings(s, "p2");
  });

  test("**错误行为红线**：不给 HTTP 字段时，meta 从 backgroundProfile 推导，currentGoal 缺席（不塞假数据）", async () => {
    const s: any = durableSession(`pm2-${Math.random()}`);
    await s.act("创建角色 investigator 甲");
    const r = await s.addPartyMember("乙", "investigator");
    expect("rejected" in r).toBe(false);
    const meta = (r as any).member.meta;
    // 车卡一定有 traits/significantPeople 等，推导层能填 personality 与 backstory
    expect(meta.personality).toBeTruthy();
    expect(meta.backstory).toBeTruthy();
    // 但没有推导来源的 currentGoal 必须缺席，而不是被塞一句假的
    expect(meta.currentGoal).toBeUndefined();
    expect(characterSnapshot(s, "p2")).toBeDefined();
  });

  test("**文本相似但不同**：只给 personality，其余字段仍走推导，不被 HTTP 的空值污染", async () => {
    const s: any = durableSession(`pm3-${Math.random()}`);
    await s.act("创建角色 investigator 甲");
    const r = await s.addPartyMember("乙", "investigator", { personality: "性格" } as any);
    const meta = (r as any).member.meta;
    expect(meta.personality).toBe("性格");
    expect(meta.backstory).toBeTruthy(); // 其余字段落推导
  });
});

describe("构造函数 p1 的 meta", () => {
  test("**正确**：构造时传 persona，p1 的 meta 反映 HTTP 字段（personality/backstory/currentGoal）", () => {
    const s: any = durableSession(`pm4-${Math.random()}`, "investigator", "甲", {
      personality: "p1性格",
      backstory: "p1背景",
      currentGoal: "p1目标",
    });
    const p1 = s.exportOrdinarySessionSnapshot().state.party.find((entry: { pcId: string }) => entry.pcId === "p1");
    expect(p1.meta).toEqual({ personality: "p1性格", backstory: "p1背景", currentGoal: "p1目标" });
  });

  test("**错误行为红线**：构造不传 persona 时，p1 的 meta 从背景推导，不写死假 currentGoal", () => {
    const s: any = durableSession(`pm5-${Math.random()}`, "investigator", "甲");
    const p1 = s.exportOrdinarySessionSnapshot().state.party.find((entry: { pcId: string }) => entry.pcId === "p1");
    expect(p1.meta.personality).toBeTruthy();
    expect(p1.meta.currentGoal).toBeUndefined();
  });
});

describe("「创建角色」重建 p1（session 起手无 archetype 时的真实建卡路径）", () => {
  test("**错误行为红线**：构造时给了 persona 但没传 archetype（p1 先是空壳），随后走\"创建角色\"命令建卡——HTTP persona 不能被静默丢掉", async () => {
    const s: any = durableSession(`pm8-${Math.random()}`, undefined, undefined, {
      personality: "构造时给的性格",
      backstory: "构造时给的背景",
      currentGoal: "构造时给的目标",
    });
    expect(characterSnapshot(s, "p1")).toBeUndefined(); // 空壳，还没有真角色卡
    await s.act("创建角色 investigator 甲"); // 真正建卡的地方
    const p1 = s.exportOrdinarySessionSnapshot().state.party.find((entry: { pcId: string }) => entry.pcId === "p1");
    expect(p1.meta).toEqual({
      personality: "构造时给的性格",
      backstory: "构造时给的背景",
      currentGoal: "构造时给的目标",
    });
  });

  test("**正确**：没给 persona 时，\"创建角色\"建的 p1 仍能从 backgroundProfile 推导出 personality/backstory", async () => {
    const s: any = durableSession(`pm9-${Math.random()}`);
    await s.act("创建角色 investigator 甲");
    const p1 = s.exportOrdinarySessionSnapshot().state.party.find((entry: { pcId: string }) => entry.pcId === "p1");
    expect(p1.meta.personality).toBeTruthy();
    expect(p1.meta.backstory).toBeTruthy();
    expect(p1.meta.currentGoal).toBeUndefined();
  });

  test("**目标行为错误对照**：p1 的 persona 不会窜到后续用\"创建角色\"重建的 p2 头上", async () => {
    const s: any = durableSession(`pmA-${Math.random()}`, undefined, undefined, {
      personality: "只属于p1的性格",
    });
    await s.act("创建角色 investigator 甲"); // p1
    await s.act("创建队友 乙 investigator"); // p2
    await s.act("p2的动作", "p2"); // 切到 p2
    await s.act("创建角色 investigator 乙二号"); // 重建当前活跃（p2）
    const p2 = s.exportOrdinarySessionSnapshot().state.party.find((entry: { pcId: string }) => entry.pcId === "p2");
    expect(p2.meta.personality).not.toBe("只属于p1的性格");
  });
});

describe("文本命令「创建队友」", () => {
  test("**正确**：文本命令走 addPartyMember，新成员带推导 meta，且是完整八件事", async () => {
    const s: any = durableSession(`pm6-${Math.random()}`);
    await s.act("创建角色 investigator 甲");
    const res = await s.act("创建队友 乙 investigator");
    expect(res.error).toBeUndefined();
    const p2 = s.exportOrdinarySessionSnapshot().state.party.find((entry: { pcId: string }) => entry.pcId === "p2");
    expect(p2).toBeDefined();
    expect(p2.meta.personality).toBeTruthy();
    expect(p2.meta.currentGoal).toBeUndefined();
    assertEightThings(s, "p2");
  });

  test("**目标行为错误对照**：文本命令没有 HTTP 字段的入口，meta 重心在推导；\"创建队友\"仍只建新 PC 不破坏 p1", async () => {
    const s: any = durableSession(`pm7-${Math.random()}`);
    await s.act("创建角色 investigator 甲");
    await s.act("创建队友 乙 investigator");
    expect(s.getState().party).toHaveLength(2);
    expect(characterSnapshot(s, "p1")).toBeDefined();
    expect(s.activePlayerId).toBe("p1"); // 建队友不切换身份
  });
});
