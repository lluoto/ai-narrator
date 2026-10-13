// A normal CoC head hit for 5+ damage explicitly says the target's next
// action suffers -20%. This suite proves that the rule source reaches the
// player's persisted status and the next real percentile check.
import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { CoCEngine, getHitLocationEffect } from "../rules/coc-engine";
import { parseStatus } from "../rules/status-effects";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};

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

function patchActiveCharacter(session: SessionInternals, update: Parameters<GameSession["updateCharacter"]>[1]): void {
  expect(session.updateCharacter(session.activePlayerId, update)).toMatchObject({ status: "updated" });
}

function headDazed(entity: Entity) {
  return entity.status
    .map(parseStatus)
    .find((status) => status?.id === "head_dazed");
}

async function sessionWithNormalNpcHeadHit(playerHp = 50): Promise<SessionInternals> {
  const session = new GameSession(
    `normal-head-hit-${Math.random()}`,
    "cosmic-horror",
    CFG,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "preferred",
    { careerEntryPersistence: "transient" },
  );
  restoreSignedOrdinaryWorld(session, CFG, (world) => {
    const scene = world.getCurrentState().scene;
    world.upsertEntity({
      id: "normal-head-attacker", name: "普通命中者", type: "monster", hp: 200, maxHp: 200,
      ac: 0, status: [], position: scene, scene_id: scene,
    });
  });
  patchActiveCharacter(session, { hp: playerHp, maxHp: 50 });

  // Preserve the existing GameSession RNG contract: the player misses, its
  // miss narration consumes one value, then NPC d100=20 succeeds normally and
  // the player's d100=100 fails to dodge. d20=20 selects the head and d6=5
  // stays below the major-wound threshold. No critical or impale can explain
  // the result.
  const values = [0.99, 0.5, 0.19, 0.99, 0.99, 0.8];
  let index = 0;
  Math.random = () => {
    const value = values[index++] ?? 0.99;
    return value;
  };
  await session.act("攻击 普通命中者", session.activePlayerId);
  return session;
}

function hasRoll(response: Awaited<ReturnType<GameSession["act"]>>, target: number, outcome: string): boolean {
  return response.events.some((event) => event.content.includes(`目标=${target}%`) && event.content.includes(outcome));
}

describe("CoC normal head-hit percentile penalty", () => {
  test("rule source declares only the ordinary 5+ head-hit daze", () => {
    const threshold = getHitLocationEffect("头部", 5, false, false);
    expect(threshold.statusEffect).toBe("head_dazed");
    expect(threshold.statusEffectDurationDice).toBeUndefined();

    const belowThreshold = getHitLocationEffect("头部", 4, false, false);
    const nonHead = getHitLocationEffect("胸部", 5, false, false);
    const impaleHead = getHitLocationEffect("头部", 5, true, false);
    expect(belowThreshold.statusEffect).toBeUndefined();
    expect(nonHead.statusEffect).toBeUndefined();
    // The existing impale narration is not an executable blindness/INT rule.
    expect(impaleHead.statusEffect).toBeUndefined();
    expect(impaleHead.followUp).toBeUndefined();

    const criticalHead = getHitLocationEffect("头部", 5, true, true);
    expect(criticalHead.statusEffect).toBe("stunned");
    expect(criticalHead.statusEffect).not.toBe("head_dazed");
    expect(criticalHead.followUp).toEqual({ kind: "head-critical-con-death" });

    Math.random = () => 0.99;
    const miss = CoCEngine.combatCheck(50, null, "1d6");
    expect(miss.hit).toBe(false);
    expect(miss.statusEffect).toBeUndefined();
  });

  test("red line: a real normal NPC head hit for five damage persists -20 through the next player skill check", async () => {
    const session = await sessionWithNormalNpcHeadHit();
    const player = session.world.getCurrentState().entities[session.activePlayerId]!;

    expect(player.hp).toBe(45);
    expect(headDazed(player)).toEqual(expect.objectContaining({ id: "head_dazed", duration: 1 }));

    patchActiveCharacter(session, { skillValues: { spot_hidden: 50 } });
    Math.random = () => 0.4; // d100=41: base 50 succeeds, effective 30 fails.
    const penalized = await session.act("侦查", session.activePlayerId);
    expect(hasRoll(penalized, 30, "失败")).toBe(true);
    expect(headDazed(session.world.getCurrentState().entities[session.activePlayerId]!)).toBeUndefined();

    Math.random = () => 0.4;
    const recovered = await session.act("侦查", session.activePlayerId);
    expect(hasRoll(recovered, 50, "成功")).toBe(true);
  }, 20_000);

  test("a lethal ordinary head hit does not write head_dazed", async () => {
    const session = await sessionWithNormalNpcHeadHit(5);
    const player = session.world.getCurrentState().entities[session.activePlayerId]!;

    expect(player.hp).toBe(0);
    expect(headDazed(player)).toBeUndefined();
  }, 20_000);
});
