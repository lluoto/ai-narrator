// CoC 玩家攻击必须和 NPC 反击一样，通过 RulesEngine 取得命中部位的结构化结果。
// 这不是只测 CoCEngine：用 GameSession.act() 走意图解析、目标选择、伤害写回和反击。
import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { parseStatus } from "../rules/status-effects";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" as const };

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
  activeCharacter?: { luck?: number } | null;
  updateCharacter: GameSession["updateCharacter"];
  world: {
    getCurrentState(): { scene: string; entities: Record<string, Entity> };
  };
};

const realRandom = Math.random;
const sessions: GameSession[] = [];
afterEach(() => {
  Math.random = realRandom;
  while (sessions.length) sessions.pop()!.close();
});

function sessionWithTarget(
  id: string,
  target: { id: string; name: string; hp: number; maxHp: number },
  withCharacter = true,
): SessionInternals {
  const source = new GameSession(id, "cosmic-horror", CFG,
    withCharacter ? "investigator" : undefined,
    withCharacter ? "玩家" : undefined,
    undefined,
    undefined,
    undefined,
    "preferred",
    TRANSIENT_RUNTIME,
  );
  const session = new GameSession(source.id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  try {
    restoreSignedOrdinaryWorld(session, CFG, (world) => {
      const scene = world.getCurrentState().scene;
      world.upsertEntity({
        ...target, type: "monster", ac: 0, status: [], position: scene, scene_id: scene,
      });
    }, source);
  } finally {
    source.close();
  }
  sessions.push(session);
  return session as unknown as SessionInternals;
}

function statusIds(entity: Entity): string[] {
  return entity.status.flatMap((raw) => {
    const status = parseStatus(raw);
    return status ? [status.id] : [];
  });
}

describe("CoC 玩家攻击的律书命中部位通路", () => {
  test("错误行为红线：玩家指定腹部的真实暴击必须将结构化失能写回目标，而非只扣 HP", async () => {
    const session = sessionWithTarget(`player-rules-${Math.random()}`, {
      id: "abdomen-target", name: "腹部目标", hp: 50, maxHp: 50,
    });

    // d100=1 是现有玩家攻击的暴击；随后仍按既有 1d12+6 取伤害。
    // “瞄准腹部”提供了确定部位，故不需要另加随机部位骰来伪造测试结果。
    Math.random = () => 0;
    const response = await session.act("瞄准腹部攻击 腹部目标", session.activePlayerId);

    const target = session.world.getCurrentState().entities["abdomen-target"]!;
    expect(target.hp).toBe(44); // 保持原有暴击伤害口径，且远离 50 HP 的重伤阈值
    expect(statusIds(target)).toContain("incapacitated");
    expect(response.events.some((event) => event.content.includes("你的攻击令 腹部目标 进入失能"))).toBe(true);
  }, 20_000);

  test("错误行为红线：没有活跃角色时，燃运文本不能凭空降低玩家攻击骰", async () => {
    const session = sessionWithTarget(`player-rules-no-character-${Math.random()}`, {
      id: "no-character-target", name: "无角色目标", hp: 50, maxHp: 50,
    }, false);
    // 先让会话完成正常初始化，再模拟角色表在攻击前不可用；这确保仍走真实
    // act() → parseIntent() → handleAttack() 路径，而不是被未初始化会话短路。
    // The supported p1 placeholder has no canonical character sheet. Keep
    // this real direct-action path in that state rather than using a removed
    // public setter to fabricate one.
    expect(session.activeCharacter).toBeNull();

    // 旧路径只在 activeCharacter.luck 存在且已实际扣款时才减骰：51 必须未命中，
    // 不能因输入里的“燃运5”错误变成 46 命中。
    Math.random = () => 0.5;
    const response = await session.act("燃运5 攻击 无角色目标", session.activePlayerId);

    const target = session.world.getCurrentState().entities["no-character-target"]!;
    expect(target.hp).toBe(50);
    // The canonical no-character path fails before a combat die exists; it
    // still must not manufacture a hit from the luck text.
    expect(response.dice).toBeUndefined();
  }, 20_000);

  test("兼容边界：未指定部位的旧玩家暴击保持只扣 HP，不凭空写身体状态", async () => {
    const session = sessionWithTarget(`player-rules-plain-${Math.random()}`, {
      id: "plain-target", name: "普通目标", hp: 50, maxHp: 50,
    });

    Math.random = () => 0;
    await session.act("攻击 普通目标", session.activePlayerId);

    const target = session.world.getCurrentState().entities["plain-target"]!;
    expect(target.hp).toBe(44);
    expect(statusIds(target)).toEqual([]);
  }, 20_000);

  test("兼容边界：指定部位击杀后不向已死亡目标附加一回合状态", async () => {
    const session = sessionWithTarget(`player-rules-dead-${Math.random()}`, {
      id: "dead-target", name: "濒死腹部目标", hp: 6, maxHp: 6,
    });

    Math.random = () => 0;
    await session.act("瞄准腹部攻击 濒死腹部目标", session.activePlayerId);

    const target = session.world.getCurrentState().entities["dead-target"]!;
    expect(target.hp).toBe(0);
    expect(statusIds(target)).toEqual([]);
  }, 20_000);

  test("兼容边界：燃运不足仍先消费旧路径的那枚 d100，再确定性早退", async () => {
    const session = new GameSession(`player-rules-luck-${Math.random()}`, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME) as unknown as SessionInternals;
    await session.act("创建角色 investigator 玩家");
    expect(session.updateCharacter(session.activePlayerId, { luck: 0 })).toMatchObject({ status: "updated" });
    let rolls = 0;
    Math.random = () => { rolls++; return 0.5; };

    const response = await session.act("燃运5 攻击敌人", session.activePlayerId);

    expect(response.events.some((event) => event.content.includes("幸运不足"))).toBe(true);
    expect(rolls).toBe(1);
  }, 20_000);
});
