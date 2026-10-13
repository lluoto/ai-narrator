// A CoC impale to the abdomen states a concrete effect: all actions suffer
// a -20 percentile target penalty for 1d3 rounds.  This suite deliberately
// enters through GameSession.act rather than testing a parser in isolation.
import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { newStatus, parseStatus } from "../rules/status-effects";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

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
const sessions: GameSession[] = [];
afterEach(() => {
  Math.random = realRandom;
  for (const session of sessions.splice(0)) session.close();
});

/** Fixture setup uses the same validated patch boundary as production callers. */
function patchCharacter(session: SessionInternals, pcId: string, update: Parameters<GameSession["updateCharacter"]>[1]): void {
  expect(session.updateCharacter(pcId, update)).toMatchObject({ status: "updated" });
}

function abdominalImpaleStatus(entity: Entity) {
  return entity.status
    .map(parseStatus)
    .find((status) => status?.id === "abdominal_impaled");
}

async function sessionWithNpcAbdominalImpale(playerHp = 50): Promise<SessionInternals> {
  const id = `abdomen-impale-${Math.random()}`;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Fixture Ada", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  expect(source.updateActiveCharacter({ hp: playerHp, maxHp: 50 })).toMatchObject({ status: "updated" });
  const session = new GameSession(id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  restoreSignedOrdinaryWorld(session, CFG, (world) => {
    const scene = world.getCurrentState().scene;
    world.upsertEntity({
      id: "abdomen-impale-attacker", name: "腹部贯穿者", type: "monster", hp: 200, maxHp: 200,
      ac: 0, status: [], position: scene, scene_id: scene,
    });
  }, source);
  source.close();
  sessions.push(session);

  // Player misses.  The NPC then gets an extreme (not critical) success,
  // the player fails to dodge, and d20=7 selects the abdomen.  The attack
  // itself is the only source allowed to create the wound state.
  // The final 0 is the structured duration die: 1d3=1. It must be consumed
  // by RulesEngine after the non-lethal abdomen hit, not by GameSession later.
  const values = [0.99, 0.5, 0.05, 0.99, 0.3, 0];
  let i = 0;
  Math.random = () => values[i++] ?? 0.99;
  await session.act("攻击 腹部贯穿者", session.activePlayerId);
  return session;
}

function newSession(input: {
  label: string;
  hp?: number;
  maxHp?: number;
  status?: string[];
  hostile?: { id: string; name: string };
}): SessionInternals {
  const id = `abdomen-impale-fixture-${input.label}-${Math.random()}`;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Fixture Ada", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  expect(source.updateActiveCharacter({
    hp: input.hp ?? 50,
    maxHp: input.maxHp ?? 50,
  })).toMatchObject({ status: "updated" });
  const session = new GameSession(id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  restoreSignedOrdinaryWorld(session, CFG, (world) => {
    const state = world.getCurrentState();
    if (input.status) world.upsertEntity({ ...state.entities.p1!, status: input.status });
    if (input.hostile) world.upsertEntity({
      id: input.hostile.id, name: input.hostile.name, type: "monster", hp: 50, maxHp: 50,
      ac: 0, status: [], position: state.scene, scene_id: state.scene,
    });
  }, source);
  source.close();
  sessions.push(session);
  return session;
}

async function barnSession(label: string, duration: number, clueFailures = 0): Promise<SessionInternals> {
  const id = `abdomen-impale-barn-${label}-${Math.random()}`;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Fixture Ada", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  await source.act("加载模组 普瑞米尔的谷仓");
  expect(activateRegisteredGameSessionSceneForTest(source, "加比的拖车房")).toBe(true);
  expect(source.updateActiveCharacter({ hp: 50, maxHp: 50 })).toMatchObject({ status: "updated" });
  const session = new GameSession(id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  restoreSignedOrdinaryWorld(session, CFG, (world) => {
    const p1 = world.getCurrentState().entities.p1!;
    world.upsertEntity({ ...p1, status: [newStatus("abdominal_impaled", duration)] });
    for (let i = 0; i < clueFailures; i++) world.incrementClueFail("clue_card");
  }, source);
  source.close();
  sessions.push(session);
  return session;
}

function setSpotHidden(session: SessionInternals, value = 50, pcId = session.activePlayerId): void {
  patchCharacter(session, pcId, { skillValues: { spot_hidden: value } });
}

function setFighting(session: SessionInternals, value = 50): void {
  patchCharacter(session, session.activePlayerId, { skillValues: { fighting: value } });
}

function hasRoll(response: Awaited<ReturnType<GameSession["act"]>>, target: number, outcome: string): boolean {
  return response.events.some((event) => event.content.includes(`目标=${target}%`) && event.content.includes(outcome));
}

describe("CoC abdominal impale percentile penalty", () => {
  test("red line: a real NPC abdomen impale persists its rolled action penalty before the next player check", async () => {
    const session = await sessionWithNpcAbdominalImpale();
    const player = session.world.getCurrentState().entities[session.activePlayerId]!;

    const wound = abdominalImpaleStatus(player);
    expect(wound).toEqual(expect.objectContaining({ id: "abdominal_impaled", duration: 1 }));

    setSpotHidden(session, 50);
    Math.random = () => 0.4; // d100=41: base 50 succeeds; penalized 30 must fail.
    const checked = await session.act("侦查", session.activePlayerId);

    expect(hasRoll(checked, 30, "失败")).toBe(true);
    expect(abdominalImpaleStatus(session.world.getCurrentState().entities[session.activePlayerId]!)).toBeUndefined();

    // The duration=1 status was consumed by the previous action's snapshot;
    // the next action returns to its base target instead of staying at -20.
    Math.random = () => 0.4;
    const recovered = await session.act("侦查", session.activePlayerId);
    expect(hasRoll(recovered, 50, "成功")).toBe(true);
  }, 20_000);

  test("a lethal abdomen impale neither writes a status nor consumes its declared duration die", async () => {
    const session = await sessionWithNpcAbdominalImpale(1);
    const player = session.world.getCurrentState().entities[session.activePlayerId]!;

    expect(player.hp).toBe(0);
    expect(abdominalImpaleStatus(player)).toBeUndefined();
  }, 20_000);

  test("scene clue checks use the same effective target for ordinary and idea-override rolls, while force-success stays no-roll", async () => {
    const session = await barnSession("clue", 3);
    patchCharacter(session, session.activePlayerId, { skillValues: { spot_hidden: 50 }, attributes: { intelligence: 50 } });

    Math.random = () => 0.4;
    const ordinary = await session.act("检查餐厅", session.activePlayerId);
    expect(hasRoll(ordinary, 30, "失败")).toBe(true);
    const second = await session.act("检查餐厅", session.activePlayerId);
    expect(hasRoll(second, 30, "失败")).toBe(true);

    // On failCount=2, GameSession substitutes the idea target. It is still an
    // active check, so its base 50 is reduced to 30 on the status's final turn.
    const idea = await session.act("检查餐厅", session.activePlayerId);
    expect(hasRoll(idea, 30, "失败")).toBe(true);

    // The fourth failure reaches count=4. It has already expired, so it
    // remains an ordinary unmodified check.
    Math.random = () => 0.99;
    const fourthFailure = await session.act("检查餐厅", session.activePlayerId);
    expect(hasRoll(fourthFailure, 50, "失败")).toBe(true);
    session.close();

    // Reapply a one-turn wound before the deterministic grant: it must not
    // create a d100 check or be converted into a target=30 failure.
    Math.random = realRandom;
    const grantSession = await barnSession("clue-grant", 1, 4);
    patchCharacter(grantSession, grantSession.activePlayerId, { skillValues: { spot_hidden: 50 }, attributes: { intelligence: 50 } });
    const granted = await grantSession.act("检查餐厅", grantSession.activePlayerId);
    expect(granted.events.some((event) => event.content.includes("🎲"))).toBe(false);
    expect(granted.events.some((event) => event.content.includes("目标=30%"))).toBe(false);
    expect(grantSession.investigation.isDiscoveredBy("clue_card", grantSession.activePlayerId)).toBe(true);
  }, 20_000);

  test("legacy player attack and first aid consume the same abdomen target modifier", async () => {
    const attackSession = newSession({ label: "legacy-attack", status: [newStatus("abdominal_impaled", 1)], hostile: { id: "legacy-target", name: "旧攻击靶" } });
    setSpotHidden(attackSession);
    // Explicit unarmed attacks use the sheet's fighting skill. Pin it to 50
    // so the impale penalty has the observable target of 30.
    setFighting(attackSession, 50);
    Math.random = () => 0.4; // d100=41: old target 50 would hit, effective 30 misses.
    const attacked = await attackSession.act("攻击 旧攻击靶", attackSession.activePlayerId);
    expect(hasRoll(attacked, 30, "未命")).toBe(true);
    expect(attackSession.world.getCurrentState().entities["legacy-target"]!.hp).toBe(50);
    attackSession.close();

    Math.random = realRandom;
    const aidSession = newSession({ label: "first-aid", hp: 5, maxHp: 50, status: [newStatus("abdominal_impaled", 1)] });
    patchCharacter(aidSession, aidSession.activePlayerId, { skillValues: { first_aid: 50 } });
    Math.random = () => 0.4;
    const aided = await aidSession.act("急救伤口", aidSession.activePlayerId);
    expect(aided.events.some((event) => event.content.includes("急救=30%") && event.content.includes("失败"))).toBe(true);
    expect(aidSession.world.getCurrentState().entities[aidSession.activePlayerId]!.hp).toBe(5);
    expect(aidSession.activeCharacter!.hp).toBe(5);
  }, 20_000);

  test("chase and the reachable regex attack fallback use the active actor only", async () => {
    const chaseSession = newSession({ label: "chase", status: [newStatus("abdominal_impaled", 1)] });
    patchCharacter(chaseSession, chaseSession.activePlayerId, { attributes: { dexterity: 50 } });
    Math.random = () => 0.4;
    const chased = await chaseSession.act("跑", chaseSession.activePlayerId);
    expect(chased.events.some((event) => event.content.includes("DEX=30") && event.content.includes("追逐仍在继续"))).toBe(true);
    chaseSession.close();

    Math.random = realRandom;
    const fallbackSession = newSession({ label: "regex-fallback", status: [newStatus("abdominal_impaled", 1)], hostile: { id: "fallback-target", name: "旁路靶" } });
    setSpotHidden(fallbackSession);
    Math.random = () => 0.4;
    // “挥砍” is not handled by the normal intent attack case and reaches the
    // real regex fallback that still rolls a player d100.
    const fallback = await fallbackSession.act("挥砍 旁路靶", fallbackSession.activePlayerId);
    expect(hasRoll(fallback, 30, "未命")).toBe(true);
    expect(fallbackSession.world.getCurrentState().entities["fallback-target"]!.hp).toBe(50);
  }, 20_000);

  test("multiple entries do not stack, bad labels do nothing, and another actor is isolated", async () => {
    const session = newSession({ label: "isolation", status: [newStatus("abdominal_impaled", 2), newStatus("abdominal_impaled", 2), "腹部贯穿??"] });
    setSpotHidden(session);
    Math.random = () => 0.4;
    const strongestOnly = await session.act("侦查", session.activePlayerId);
    expect(hasRoll(strongestOnly, 30, "失败")).toBe(true);
    expect(strongestOnly.events.some((event) => event.content.includes("目标=10%"))).toBe(false);
    session.close();

    Math.random = realRandom;
    const clean = newSession({ label: "unknown-label", status: ["腹部贯穿??"] });
    setSpotHidden(clean);
    Math.random = () => 0.4;
    const ignored = await clean.act("侦查", clean.activePlayerId);
    expect(hasRoll(ignored, 50, "成功")).toBe(true);
    clean.close();

    Math.random = realRandom;
    const partyId = `abdomen-penalty-other-actor-${Math.random()}`;
    const partySource = new GameSession(partyId, "cosmic-horror", CFG, "investigator", "Fixture Ada", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    await partySource.act("创建队友 乙 investigator");
    const party = new GameSession(partyId, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    restoreSignedOrdinaryWorld(party, CFG, (world) => {
      const p1 = world.getCurrentState().entities.p1!;
      world.upsertEntity({ ...p1, status: [newStatus("abdominal_impaled", 2)] });
    }, partySource);
    partySource.close();
    sessions.push(party);
    setSpotHidden(party, 50, "p2");
    Math.random = () => 0.4;
    const p2Action = await party.act("侦查", "p2");
    expect(hasRoll(p2Action, 50, "成功")).toBe(true);
  }, 20_000);
});
