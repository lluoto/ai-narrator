// 身体状态必须在真实玩家行动入口成为确定性门禁。
//
// `resolveHit()` 已经会在 CoC 重伤昏迷时写入 `newStatus("stunned")`，而
// `act()` 会在意图派发前推进状态。这个文件守住的不是 status parser 本身，
// 而是那条从受伤写入、持久读取到实际行动被阻断的生产通路。

import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { newStatus, parseStatus } from "../rules/status-effects";
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

type SessionInternals = GameSession;

const realRandom = Math.random;
afterEach(() => { Math.random = realRandom; });

function statusIds(entity: Entity): string[] {
  return entity.status.flatMap((raw) => {
    const parsed = parseStatus(raw);
    return parsed ? [parsed.id] : [];
  });
}

async function npcCounterSession(input: {
  label: string;
  playerHp: number;
  hostileId: string;
  hostileName: string;
  rolls: number[];
}): Promise<SessionInternals> {
  const id = `body-status-${input.label}-${Math.random()}`;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Fixture Ada", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  expect(source.updateActiveCharacter({ hp: input.playerHp, maxHp: input.playerHp })).toMatchObject({ status: "updated" });
  const session = new GameSession(id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  restoreSignedOrdinaryWorld(session, CFG, (world) => {
    const scene = world.getCurrentState().scene;
    world.upsertEntity({
      id: input.hostileId, name: input.hostileName, type: "monster", hp: 200, maxHp: 200,
      ac: 0, status: [], position: scene, scene_id: scene,
    });
  }, source);
  source.close();
  let rollIndex = 0;
  Math.random = () => input.rolls[rollIndex++] ?? 0.99;
  await session.act(`攻击 ${input.hostileName}`, session.activePlayerId);
  return session;
}

async function woundedSession(): Promise<SessionInternals> {
  // 把生命值压到能被一次 NPC 暴击打成 CoC 重伤、但仍保持清醒判定的最小边界。
  // 伤害仍由 `npcCounterAttack -> resolveHit` 生产路径产生，不能手工塞 "昏迷" 字符串。

  // 玩家命中、NPC 命中、部位/骨折/昏迷判定都取最小骰，确保真实反击路径稳定产出 stunned。
  // A defender's critical dodge now wins an equal-level contest. Keep both
  // attacks critical, but make the player's dodge fumble. The remaining
  // values select a non-head NPC hit and an unconscious major wound.
  return npcCounterSession({
    label: "wounded", playerHp: 10, hostileId: "attacker", hostileName: "袭击者",
    rolls: [0, 0, 0, 0, 0, 0.99, 0, 0, 0, 0.99, 0],
  });
}

async function incapacitatedByCriticalAbdomenSession(): Promise<SessionInternals> {
  // 保持在重伤阈值之上：这里要证明的是 CoC combatCheck() 已经给出的
  // “腹部暴击 → 无法行动一轮”，不能让 resolveHit() 的随机重伤昏迷替它通过。
  // 玩家攻击失手；NPC 随后掷 1 造成暴击，玩家闪避掷 100，部位 d20 掷到腹部。
  // 暴击伤害取最大值 6，仍不足 50 HP 的重伤阈值，因此唯一可阻断行动的来源
  // 必须是 combatCheck 的“无法行动一轮”效果。
  // 玩家失手后的本地叙事会先消耗一次随机表；随后才是 NPC 的攻击、闪避和部位骰。
  return npcCounterSession({
    label: "critical", playerHp: 50, hostileId: "critical-attacker", hostileName: "腹击者",
    rolls: [0.99, 0.5, 0, 0.99, 0.3],
  });
}

async function stunnedByCriticalHeadSession(): Promise<SessionInternals> {
  // 伤害不足以触发 `resolveHit()` 的重伤检定。这样此处出现的昏迷只能来自
  // `getHitLocationEffect()` 对“头部暴击：立即昏迷”的结构化结果，而不是既有的
  // 重伤随机昏迷分支。
  // 玩家先大失败；NPC 接 1 造成暴击；玩家闪避掷 100；部位 d20 掷 20 命中头部；
  // 最后一枚 CON=1 通过，故本例隔离既有的“立即昏迷”状态而非死亡分支。
  // 中间的 .5 是玩家大失败后的本地叙事消耗。暴击伤害至多 6，远低于 50 HP 重伤阈值。
  return npcCounterSession({
    label: "head", playerHp: 50, hostileId: "head-critical-attacker", hostileName: "头部暴击者",
    rolls: [0.99, 0.5, 0, 0.99, 0.99, 0],
  });
}

describe("CoC 昏迷状态的玩家行动门禁", () => {
  test("错误行为红线：真实反击造成的昏迷必须阻断下一次玩家行动；到期后才重新允许", async () => {
    const session = await woundedSession();
    const playerBefore = session.world.getCurrentState().entities[session.activePlayerId]!;
    expect(statusIds(playerBefore)).toContain("stunned"); // 受伤来源真实写入并可从世界状态读回

    const blocked = await session.act("观察", session.activePlayerId);
    expect(blocked.events.some((event) => event.content.includes("昏迷") && event.content.includes("无法行动"))).toBe(true);
    expect(blocked.events.some((event) => event.type === "narration")).toBe(false);
    expect(statusIds(session.world.getCurrentState().entities[session.activePlayerId]!)).not.toContain("stunned");

    const recovered = await session.act("观察", session.activePlayerId);
    expect(recovered.events.some((event) => event.type === "action" && event.content === "观察")).toBe(true);
    expect(recovered.events.some((event) => event.content.includes("无法行动"))).toBe(false);
  }, 20_000);

  test("错误行为红线：真实腹部暴击的明确失能必须阻断一回合，不能只留在 combat result 文案中", async () => {
    const session = await incapacitatedByCriticalAbdomenSession();
    const playerBefore = session.world.getCurrentState().entities[session.activePlayerId]!;
    expect(statusIds(playerBefore)).toContain("incapacitated");
    expect(statusIds(playerBefore)).not.toContain("stunned");

    const blocked = await session.act("观察", session.activePlayerId);
    expect(blocked.events.some((event) => event.content.includes("失能") && event.content.includes("无法行动"))).toBe(true);
    expect(blocked.events.some((event) => event.type === "narration")).toBe(false);
    expect(statusIds(session.world.getCurrentState().entities[session.activePlayerId]!)).not.toContain("incapacitated");

    const recovered = await session.act("观察", session.activePlayerId);
    expect(recovered.events.some((event) => event.type === "action" && event.content === "观察")).toBe(true);
  }, 20_000);

  test("错误行为红线：真实头部暴击的明确立即昏迷必须阻断下一次行动，且不依赖随机重伤昏迷", async () => {
    const session = await stunnedByCriticalHeadSession();
    const playerBefore = session.world.getCurrentState().entities[session.activePlayerId]!;
    expect(playerBefore.hp).toBeGreaterThan(0);
    expect(statusIds(playerBefore)).toContain("stunned");
    expect(statusIds(playerBefore)).not.toContain("incapacitated");

    const blocked = await session.act("观察", session.activePlayerId);
    expect(blocked.events.some((event) => event.content.includes("昏迷") && event.content.includes("无法行动"))).toBe(true);
    expect(blocked.events.some((event) => event.type === "narration")).toBe(false);
    expect(statusIds(session.world.getCurrentState().entities[session.activePlayerId]!)).not.toContain("stunned");

    const recovered = await session.act("观察", session.activePlayerId);
    expect(recovered.events.some((event) => event.type === "action" && event.content === "观察")).toBe(true);
  }, 20_000);

  test("作用对象隔离：p1 的昏迷不能阻断健康 p2；p1 自己仍会被阻断", async () => {
    const id = `body-status-party-${Math.random()}`;
    const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Fixture Ada", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    await source.act("创建队友 乙 investigator");
    const session = new GameSession(id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    restoreSignedOrdinaryWorld(session, CFG, (world) => {
      const p1 = world.getCurrentState().entities.p1!;
      world.upsertEntity({ ...p1, status: [newStatus("stunned", 2)] });
    }, source);
    source.close();

    const p2Action = await session.act("观察", "p2");
    expect(p2Action.events.some((event) => event.type === "action" && event.content === "观察")).toBe(true);
    expect(p2Action.events.some((event) => event.content.includes("无法行动"))).toBe(false);

    const p1Action = await session.act("观察", "p1");
    expect(p1Action.events.some((event) => event.content.includes("昏迷") && event.content.includes("无法行动"))).toBe(true);
  }, 20_000);
});
