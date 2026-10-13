// 状态 tick 把行动者降至 0 HP 后，必须在任何意图/SAN/经济副作用之前拒绝该回合。
// 这里固定走 GameSession.act()，不用纯函数或描述文本猜测状态。

import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { newStatus } from "../rules/status-effects";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

type Entity = {
  id: string;
  name: string;
  type: string;
  hp: number;
  maxHp: number;
  ac: number;
  status: string[];
  position: string;
  scene_id?: string;
};

type SessionInternals = {
  act: GameSession["act"];
  activePlayerId: string;
  activeCharacter: { hp: number; maxHp: number } | null;
  updateCharacter: GameSession["updateCharacter"];
  exportOrdinarySessionSnapshot: GameSession["exportOrdinarySessionSnapshot"];
  dead: boolean;
  round: number;
  getHistory(): { messages: Array<{ content: string; type: string }> };
  world: {
    getEntity(id: string): Entity | null;
    getCurrentState(): { scene: string; entities: Record<string, Entity> };
    getRecentEvents(limit?: number): Array<{ description: string }>;
  };
};

const realRandom = Math.random;
const sessions: GameSession[] = [];
afterEach(() => {
  Math.random = realRandom;
  while (sessions.length) sessions.pop()!.close();
});

async function sessionWithActor(label: string): Promise<SessionInternals> {
  const session = new GameSession(`status-tick-zero-${label}-${Math.random()}`, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME) as unknown as SessionInternals;
  await session.act("创建角色 investigator 甲");
  sessions.push(session as unknown as GameSession);
  return session;
}

function replaceWorld(
  source: SessionInternals,
  configure: (world: import("../state/world-state-manager").WorldStateManager) => void,
): SessionInternals {
  const rawSource = source as unknown as GameSession;
  const target = new GameSession(rawSource.id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  try {
    restoreSignedOrdinaryWorld(target, CFG, configure, rawSource);
  } catch (error) {
    target.close();
    throw error;
  }
  rawSource.close();
  sessions.push(target);
  return target as unknown as SessionInternals;
}

function putEnemy(session: SessionInternals, id: string, name: string): SessionInternals {
  return replaceWorld(session, (world) => {
    const scene = world.getCurrentState().scene;
    world.upsertEntity({
      id, name, type: "monster", hp: 50, maxHp: 50, ac: 0, status: [], position: scene, scene_id: scene,
    });
  });
}

function setWound(session: SessionInternals, pcId: string, hp: number, status: string[]): SessionInternals {
  expect(session.updateCharacter(pcId, { hp, maxHp: 12 })).toMatchObject({ status: "updated" });
  return replaceWorld(session, (world) => {
    const entity = world.getEntity(pcId);
    if (!entity) throw new Error(`fixture requires ${pcId} world entity`);
    world.upsertEntity({ ...entity, status: [...status] });
  });
}

function economyEvents(session: SessionInternals): string[] {
  return session.world.getRecentEvents(200)
    .map((event) => event.description)
    .filter((description) => description.startsWith("[经济]"));
}

describe("状态 tick 归零后的行动门禁", () => {
  test("错误行为红线：行动者在第十回合流血归零后仍结算 tick，但不攻击、不推进经济；以后也拒绝", async () => {
    let session = await sessionWithActor("fatal");
    // 用九次正常行动进入经济 tick 边界；第十次才让真实 status tick 归零。
    for (let i = 0; i < 8; i++) await session.act("观察", session.activePlayerId);
    expect(session.round).toBe(9);
    expect(economyEvents(session)).toEqual([]);

    session = setWound(session, "p1", 1, [newStatus("bleeding")]);
    session = putEnemy(session, "tick-target", "滴血靶");
    Object.defineProperty(session as unknown as GameSession, "zeroHpActionBlockMessage", {
      configurable: true,
      value: () => undefined,
    });
    Math.random = () => 0; // 若错误派发攻击，legacy 暴击会把目标 50 打到 44。
    const fatalTurn = await session.act("攻击 滴血靶", "p1");

    const actor = session.world.getEntity("p1")!;
    expect(session.round).toBe(10); // tick 所在回合仍已发生
    expect(actor.hp).toBe(0);
    expect(session.activeCharacter?.hp).toBe(0);
    expect(fatalTurn.state.player.hp).toBe(0);
    expect(session.getHistory().messages.some((m) => m.content.includes("[流血]") && m.content.includes("0/12"))).toBe(true);
    expect(session.world.getEntity("tick-target")!.hp).toBe(50); // 归零后不得继续派发攻击
    expect(fatalTurn.events.some((event) => event.type === "action" && event.content === "攻击 滴血靶")).toBe(false);
    expect(fatalTurn.events.some((event) => event.content.includes("HP归零") && event.content.includes("无法行动"))).toBe(true);
    expect(economyEvents(session)).toEqual([]); // 归零门禁必须早于本回合经济事件
    expect(session.dead).toBe(false); // dead 是会话终态，不能把单个 PC 的 tick 归零扩大为团灭

    // 已倒下者的重试必须在任何全局副作用前拒绝；给非行动怪物挂流血，
    // 若错误再进 tick，它会从 50 掉到 49 并消耗另一回合。
    session = replaceWorld(session, (world) => {
      const target = world.getEntity("tick-target");
      if (!target) throw new Error("fixture requires tick target");
      world.upsertEntity({ ...target, status: [newStatus("bleeding")] });
    });
    const roundBeforeRetry = session.round;
    const retry = await session.act("攻击 滴血靶", "p1");
    expect(session.round).toBe(roundBeforeRetry);
    expect(retry.events.some((event) => event.content.includes("HP归零") && event.content.includes("无法行动"))).toBe(true);
    expect(retry.events.some((event) => event.type === "action" && event.content === "攻击 滴血靶")).toBe(false);
    const untouchedTarget = session.world.getEntity("tick-target")!;
    expect(untouchedTarget.hp).toBe(50);
    expect(untouchedTarget.status).toEqual([newStatus("bleeding")]);
  }, 20_000);

  test("非行动 PC 的流血 tick 归零不会阻断健康 p2 的真实攻击", async () => {
    let session = await sessionWithActor("other-pc");
    await session.act("创建队友 乙 investigator");
    session = setWound(session, "p1", 1, [newStatus("bleeding")]);
    session = putEnemy(session, "healthy-target", "健康靶");

    Math.random = () => 0;
    const p2Turn = await session.act("攻击 健康靶", "p2");
    const p1 = session.world.getEntity("p1")!;
    const p2 = session.world.getEntity("p2")!;
    const target = session.world.getEntity("healthy-target")!;

    expect(p1.hp).toBe(0);
    const p1Snapshot = session.exportOrdinarySessionSnapshot().state.characters
      .find((entry) => entry.pcId === "p1");
    expect(p1Snapshot).toBeDefined();
    expect((p1Snapshot!.sheet as { hp: number }).hp).toBe(0);
    expect(p2.hp).toBeGreaterThan(0);
    expect(target.hp).toBe(44);
    expect(p2Turn.events.some((event) => event.type === "action" && event.content === "攻击 健康靶")).toBe(true);
    expect(p2Turn.events.some((event) => event.content.includes("HP归零") && event.content.includes("无法行动"))).toBe(false);
    expect(session.dead).toBe(false);
  }, 20_000);

  test("tick 后仍有 HP 的行动者照常派发动作，且角色卡仍从实体同步", async () => {
    let session = await sessionWithActor("survives");
    session = setWound(session, "p1", 2, [newStatus("bleeding")]);

    Math.random = () => 0;
    const response = await session.act("观察", "p1");
    expect(session.world.getEntity("p1")!.hp).toBe(1);
    expect(session.activeCharacter?.hp).toBe(1);
    expect(response.events.some((event) => event.type === "action" && event.content === "观察")).toBe(true);
  }, 20_000);

  test("既有 cannot_act 一回合状态仍在 tick 前读取并阻断健康行动者", async () => {
    let session = await sessionWithActor("cannot-act");
    session = setWound(session, "p1", 12, [newStatus("stunned")]);
    session = putEnemy(session, "stun-target", "昏迷靶");

    Math.random = () => 0;
    const blocked = await session.act("攻击 昏迷靶", "p1");
    expect(session.world.getEntity("p1")!.hp).toBe(12);
    expect(session.world.getEntity("stun-target")!.hp).toBe(50);
    expect(blocked.events.some((event) => event.content.includes("昏迷") && event.content.includes("无法行动"))).toBe(true);
    expect(blocked.events.some((event) => event.type === "action" && event.content === "攻击 昏迷靶")).toBe(false);
  }, 20_000);

  test("同名 zero-HP gate no-op shadow 不能让已归零的 p1 派发真实攻击或副作用", async () => {
    let session = await sessionWithActor("zero-before-noop-shadow");
    session = setWound(session, "p1", 0, []);
    session = putEnemy(session, "zero-before-target", "归零靶");
    Object.defineProperty(session as unknown as GameSession, "zeroHpActionBlockMessage", {
      configurable: true,
      value: () => undefined,
    });
    const before = {
      round: session.round,
      targetHp: session.world.getEntity("zero-before-target")!.hp,
      history: structuredClone(session.getHistory()),
      economy: economyEvents(session),
      sanity: (session as unknown as GameSession).getSanity(),
      snapshot: session.exportOrdinarySessionSnapshot(),
    };

    Math.random = () => 0;
    const blocked = await session.act("攻击 归零靶", "p1");

    expect(session.round).toBe(before.round);
    expect(session.world.getEntity("zero-before-target")!.hp).toBe(before.targetHp);
    const afterHistory = session.getHistory();
    expect(afterHistory.messages).toHaveLength(before.history.messages.length + 1);
    expect(afterHistory.messages.slice(before.history.messages.length)).toEqual([
      expect.objectContaining({ type: "system", content: expect.stringContaining("HP归零") }),
    ]);
    expect(economyEvents(session)).toEqual(before.economy);
    expect((session as unknown as GameSession).getSanity()).toEqual(before.sanity);
    const afterSnapshot = session.exportOrdinarySessionSnapshot();
    expect(afterSnapshot.state.round).toBe(before.snapshot.state.round);
    expect(afterSnapshot.state.gameTime).toEqual(before.snapshot.state.gameTime);
    expect(afterSnapshot.state.characters.find((entry) => entry.pcId === "p1")?.sheet).toMatchObject({ hp: 0 });
    expect(blocked.events.some((event) => event.type === "action" && event.content === "攻击 归零靶")).toBe(false);
    expect(blocked.events.some((event) => event.content.includes("HP归零") && event.content.includes("无法行动"))).toBe(true);
  }, 20_000);

  test("throwing zero-HP gate shadow 不能 DoS 或 fail-stop 已归零行动者", async () => {
    let session = await sessionWithActor("zero-before-throw-shadow");
    session = setWound(session, "p1", 0, []);
    session = putEnemy(session, "zero-throw-target", "抛错靶");
    Object.defineProperty(session as unknown as GameSession, "zeroHpActionBlockMessage", {
      configurable: true,
      value: () => { throw new Error("forged zero-HP gate"); },
    });
    const beforeRound = session.round;
    const beforeHistory = structuredClone(session.getHistory());

    const first = await session.act("攻击 抛错靶", "p1");
    const second = await session.act("攻击 抛错靶", "p1");

    expect(session.round).toBe(beforeRound);
    expect(session.world.getEntity("zero-throw-target")!.hp).toBe(50);
    const afterHistory = session.getHistory();
    expect(afterHistory.messages).toHaveLength(beforeHistory.messages.length + 2);
    expect(afterHistory.messages.slice(beforeHistory.messages.length)).toEqual([
      expect.objectContaining({ type: "system", content: expect.stringContaining("HP归零") }),
      expect.objectContaining({ type: "system", content: expect.stringContaining("HP归零") }),
    ]);
    for (const response of [first, second]) {
      expect(response.error).toBeUndefined();
      expect(response.events.some((event) => event.type === "action" && event.content === "攻击 抛错靶")).toBe(false);
      expect(response.events.some((event) => event.content.includes("HP归零") && event.content.includes("无法行动"))).toBe(true);
    }
  }, 20_000);
});
