import { afterEach, expect, test } from "bun:test";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash, type OrdinarySnapshotJson } from "../api/ordinary-game-session-snapshot";
import { newStatus } from "../rules/status-effects";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const realRandom = Math.random;
const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;

afterEach(() => { Math.random = realRandom; });

const FIXTURE_HOSTILES = [
  "canonical-dodge-enemy", "dodge-growth-enemy", "attacker-miss-enemy",
  "failed-dodge-enemy", "critical-defense-enemy", "dodge-penalty-enemy",
];

function blank(id: string): GameSession {
  return new GameSession(
    id, "cosmic-horror", undefined, undefined, undefined,
    undefined, undefined, undefined, "development_fallback",
  );
}

function durableBlank(id: string): GameSession {
  const session = new GameSession(
    id, "cosmic-horror", undefined, undefined, undefined,
    undefined, undefined, undefined, "development_fallback",
    { ordinaryDurableHostCapability: durableCareerHostCapability },
  );
  Object.defineProperty(session, "act", {
    configurable: true,
    value: (input: string, pcId?: string) => runOrdinaryDurableActionTransaction(
      session,
      durableCareerHostCapability,
      async (act) => act(input, pcId),
    ),
  });
  return session;
}

function fresh(
  id: string,
  withCharacter = true,
  playerStatus: string[] = [],
  withFixtureHostiles = true,
): GameSession {
  const source = new GameSession(
    id, "cosmic-horror", undefined,
    withCharacter ? "investigator" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined, undefined, undefined, "development_fallback",
  );
  const target = blank(id);
  try {
    restoreSignedOrdinaryWorld(target, {
      apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 64, temperature: 0,
    }, (world) => {
      const scene = world.getCurrentState().scene;
      for (const hostileId of withFixtureHostiles ? FIXTURE_HOSTILES : []) {
        world.upsertEntity({
          id: hostileId, name: hostileId, type: "monster", hp: 20, maxHp: 20, ac: 0,
          status: [], position: scene, scene_id: scene,
        });
      }
      const player = world.getEntity("p1");
      if (player && playerStatus.length) world.upsertEntity({ ...player, status: [...playerStatus] });
    }, source);
  } finally {
    source.close();
  }
  return target;
}

function addHostile(session: GameSession, id: string): void {
  expect(session.world.getEntity(id)).toMatchObject({ id, type: "monster" });
}

function dodge(session: GameSession, value: number): void {
  expect(session.updateCharacter(session.activePlayerId, { skillValues: { dodge: value } }))
    .toMatchObject({ status: "updated" });
}

/** Snapshot and settlement fixtures need the persisted characters/party/active aliases. */
function freshWithP1Skills(id: string, skills: Record<string, number>, withFixtureHostiles = true): GameSession {
  const source = fresh(id, true, [], withFixtureHostiles);
  const snapshot = source.exportOrdinarySessionSnapshot();
  const entry = snapshot.state.characters.find((candidate) => candidate.pcId === "p1");
  if (!entry || entry.sheet === null || Array.isArray(entry.sheet) || typeof entry.sheet !== "object") throw new Error("fixture requires p1 sheet");
  const sheet = entry.sheet as Record<string, OrdinarySnapshotJson>;
  if (sheet.skillValues === null || Array.isArray(sheet.skillValues) || typeof sheet.skillValues !== "object") throw new Error("fixture requires p1 skills");
  Object.assign(sheet.skillValues as Record<string, OrdinarySnapshotJson>, skills);
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const restored = blank(id);
  restored.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
  source.close();
  return restored;
}

function freshWithP2Skills(id: string, skills: Record<string, number>) {
  const source = fresh(id);
  const added = source.addPartyMember("Bea", "investigator");
  if ("rejected" in added) throw new Error(added.rejected);
  const snapshot = source.exportOrdinarySessionSnapshot();
  const entry = snapshot.state.characters.find((candidate) => candidate.pcId === added.member.pcId);
  if (!entry || entry.sheet === null || Array.isArray(entry.sheet) || typeof entry.sheet !== "object") throw new Error("fixture requires p2 sheet");
  const sheet = entry.sheet as Record<string, OrdinarySnapshotJson>;
  if (sheet.skillValues === null || Array.isArray(sheet.skillValues) || typeof sheet.skillValues !== "object") throw new Error("fixture requires p2 skills");
  Object.assign(sheet.skillValues as Record<string, OrdinarySnapshotJson>, skills);
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const restored = blank(id);
  restored.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
  source.close();
  return { session: restored, added };
}

/**
 * Counterattack tests need the private combat gate without consuming the
 * caller-controlled combat RNG.  Re-sign a genuine ordinary snapshot and
 * restore it into a pristine same-ID session rather than retaining a public
 * combat-state test mutator.
 */
function restoreCombatActiveSnapshot(source: GameSession): GameSession {
  const snapshot = source.exportOrdinarySessionSnapshot();
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const activated = {
    ...unsigned,
    state: { ...unsigned.state, combatActive: true },
  };
  const target = blank(source.id);
  try {
    target.restoreOrdinarySessionSnapshot({ ...activated, snapshotHash: ordinaryGameSessionSnapshotHash(activated) });
    return target;
  } catch (error) {
    target.close();
    throw error;
  } finally {
    source.close();
  }
}

async function npcCounterAttack(session: GameSession, target: string): Promise<void> {
  await (session as any).npcCounterAttack({ action: "attack", target }, () => 0);
}

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

test("ordinary NPC counters use the canonical effective dodge skill rather than DEX/2", async () => {
  let session = fresh("ordinary-npc-counter-canonical-dodge");
  try {
    expect(session.updateActiveCharacter({ attributes: { dexterity: 90 }, skillValues: { dodge: 1 } }))
      .toMatchObject({ status: "updated" });
    addHostile(session, "canonical-dodge-enemy");
    const hpBefore = session.activeCharacter!.hp;
    session = restoreCombatActiveSnapshot(session);
    Math.random = sequence([0.01, 0.1, 0]);

    await npcCounterAttack(session, "canonical-dodge-enemy");

    // The NPC rolls 2 (a non-critical hit); the player rolls 11. DEX/2=45
    // would evade incorrectly, while the canonical dodge=1 must fail.
    expect(session.activeCharacter!.hp).toBeLessThan(hpBefore);
    expect(session.skillGrowthMarks).toEqual([]);
  } finally {
    session.close();
  }
});

test("ordinary NPC counters mark only a resolved successful dodge, once and for its owner", async () => {
  const setup = freshWithP2Skills("ordinary-npc-counter-dodge-growth", { dodge: 90 });
  let session = setup.session;
  const { added } = setup;
  try {
    expect(session.session.get(added.member.pcId)).toBeDefined();
    expect((await session.act("状态", added.member.pcId)).error).toBeUndefined();
    addHostile(session, "dodge-growth-enemy");
    session = restoreCombatActiveSnapshot(session);
    Math.random = sequence([0.01, 0.1, 0.01, 0.1]); // attack=2, dodge=11 twice.

    await npcCounterAttack(session, "dodge-growth-enemy");
    await npcCounterAttack(session, "dodge-growth-enemy");

    expect(session.skillGrowthMarks).toEqual(["dodge"]);
    const snapshot: any = session.exportOrdinarySessionSnapshot();
    expect(snapshot.state.skillGrowthMarksByPC).toEqual([{ pcId: added.member.pcId, skills: ["dodge"] }]);

    expect((await session.act("状态", "p1")).error).toBeUndefined();
    expect(session.skillGrowthMarks).toEqual([]);
  } finally {
    session.close();
  }
});

test("ordinary NPC counters do not mistake an attacker miss, failed dodge, or ignored critical defense for successful dodge growth", async () => {
  let attackerMiss = fresh("ordinary-npc-counter-attacker-miss");
  let failedDodge = fresh("ordinary-npc-counter-failed-dodge");
  let critical = fresh("ordinary-npc-counter-critical-defense");
  try {
    dodge(attackerMiss, 90);
    addHostile(attackerMiss, "attacker-miss-enemy");
    attackerMiss = restoreCombatActiveSnapshot(attackerMiss);
    Math.random = () => 0.5; // NPC d100=51 misses; the engine emits no defense roll.
    await npcCounterAttack(attackerMiss, "attacker-miss-enemy");
    expect(attackerMiss.skillGrowthMarks).toEqual([]);

    dodge(failedDodge, 1);
    addHostile(failedDodge, "failed-dodge-enemy");
    failedDodge = restoreCombatActiveSnapshot(failedDodge);
    Math.random = sequence([0.01, 0.1, 0]); // hit 2; dodge 11 fails.
    await npcCounterAttack(failedDodge, "failed-dodge-enemy");
    expect(failedDodge.skillGrowthMarks).toEqual([]);

    dodge(critical, 90);
    addHostile(critical, "critical-defense-enemy");
    critical = restoreCombatActiveSnapshot(critical);
    Math.random = sequence([0, 0.1, 0]); // attack critical=1; defense=11 is ignored by the combat result.
    await npcCounterAttack(critical, "critical-defense-enemy");
    // A raw defense d100 exists here, but `result.hit` remains true: the
    // player did not complete a successful dodge resolution and cannot grow it.
    expect(critical.skillGrowthMarks).toEqual([]);
  } finally {
    attackerMiss.close();
    failedDodge.close();
    critical.close();
  }
});

test("ordinary NPC counter dodges apply the active percentage penalty", async () => {
  let session = fresh("ordinary-npc-counter-dodge-penalty", true, [newStatus("head_dazed", 2)]);
  try {
    expect(session.updateActiveCharacter({ attributes: { dexterity: 100 }, skillValues: { dodge: 90 } }))
      .toMatchObject({ status: "updated" });
    addHostile(session, "dodge-penalty-enemy");
    const hpBefore = session.activeCharacter!.hp;
    session = restoreCombatActiveSnapshot(session);
    Math.random = sequence([0.01, 0.7, 0]);

    await npcCounterAttack(session, "dodge-penalty-enemy");

    // dodge=90 is reduced to 70, so defense d100=71 fails.
    expect(session.activeCharacter!.hp).toBeLessThan(hpBefore);
    expect(session.skillGrowthMarks).toEqual([]);
  } finally {
    session.close();
  }
});

test("dodge marks survive ordinary snapshot restore and rest, then settle through module advancement", async () => {
  const realRandom = Math.random;
  let source = freshWithP1Skills("ordinary-npc-counter-dodge-snapshot", { dodge: 90 }, false);
  const restored = durableBlank("ordinary-npc-counter-dodge-snapshot");
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    expect((await source.act("前往维修间")).error).toBeUndefined();
    source = restoreCombatActiveSnapshot(source);
    Math.random = sequence([0.01, 0.1]);
    await npcCounterAttack(source, "mi-go");
    expect(source.skillGrowthMarks).toEqual(["dodge"]);

    restored.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot())));
    expect(restored.skillGrowthMarks).toEqual(["dodge"]);
    let restRolls = 0;
    Math.random = () => {
      restRolls += 1;
      throw new Error("rest must not settle restored dodge marks");
    };
    expect((await restored.act("休息")).error).toBeUndefined();
    expect(restRolls).toBe(0);
    expect(restored.activeCharacter?.skillValues.dodge).toBe(90);
    expect(restored.skillGrowthMarks).toEqual(["dodge"]);

    let settlementRandomCalls = 0;
    const settlementRandom = sequence([0.9, 0]); // improvement d100=91 > 90, then +1.
    Math.random = () => {
      settlementRandomCalls += 1;
      return settlementRandom();
    };
    const requested = await restored.act("模组结算");
    expect(requested.error).toBeUndefined();
    expect(requested.narrative).toContain("确认离开");
    expect(settlementRandomCalls).toBe(0);
    expect(restored.dead).toBe(false);
    expect(restored.activeCharacter?.skillValues.dodge).toBe(90);
    expect(restored.skillGrowthMarks).toEqual(["dodge"]);

    expect((await restored.act("确定")).error).toBeUndefined();
    expect(restored.activeCharacter?.skillValues.dodge).toBe(91);
    expect(restored.skillGrowthMarks).toEqual([]);
    expect(restored.dead).toBe(false);
    expect(restored.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(settlementRandomCalls).toBe(2);

  } finally {
    Math.random = realRandom;
    source.close();
    restored.close();
  }
});
