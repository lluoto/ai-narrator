// 胸部暴击的“大出血”必须从 CoC 命中部位规则经实体唯一 status[] 进入真实回合结算。
// 不从 secondaryEffect/description 反查中文；这里通过 GameSession.act() 固定攻击与 d3 骰序。

import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import { newStatus, parseStatus } from "../rules/status-effects";
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

function statusIds(entity: Entity): string[] {
  return entity.status.flatMap((raw) => {
    const status = parseStatus(raw);
    return status ? [status.id] : [];
  });
}

async function chestSession(
  label: string,
  hp = 50,
  playerFixture?: { hp: number; maxHp: number; status: string[]; skillValues?: Record<string, number> },
  target?: { id: string; name: string },
): Promise<SessionInternals> {
  const id = `chest-hemorrhage-${label}-${Math.random()}`;
  const initialHp = playerFixture?.hp ?? hp;
  const initialMaxHp = playerFixture?.maxHp ?? hp;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Fixture Ada");
  expect(source.updateActiveCharacter({
    hp: initialHp,
    maxHp: initialMaxHp,
    ...(playerFixture?.skillValues ? { skillValues: playerFixture.skillValues } : {}),
  })).toMatchObject({ status: "updated" });
  const session = new GameSession(id, "cosmic-horror", CFG);
  restoreSignedOrdinaryWorld(session, CFG, (world) => {
    const state = world.getCurrentState();
    if (playerFixture) {
      const player = state.entities.p1!;
      world.upsertEntity({ ...player, status: playerFixture.status });
    }
    const scene = state.scene;
    if (target) {
      // Preserve the legacy parser's ordinary hostile ordering while making
      // the named target the only living opponent.
      world.upsertEntity({
        id: "胸部暴击者", name: "胸部暴击者", type: "monster", hp: 0, maxHp: 200,
        ac: 0, status: [], position: scene, scene_id: scene,
      });
    }
    const hostile = target ?? { id: "胸部暴击者", name: "胸部暴击者" };
    world.upsertEntity({
      id: hostile.id, name: hostile.name, type: "monster", hp: target ? 50 : 200, maxHp: target ? 50 : 200,
      ac: 0, status: [], position: scene, scene_id: scene,
    });
  }, source);
  source.close();
  return session;
}

async function triggerNpcChestCritical(session: SessionInternals) {
  // 玩家先大失败；NPC d100=1 为暴击，玩家闪避失败，d20=13 命中胸部。
  // 暴击伤害为固定最大 6；此处尚未 tick 新状态，故没有 d3。
  const values = [0.99, 0.5, 0, 0.99, 0.6];
  let rolls = 0;
  Math.random = () => values[rolls++] ?? 0.99;
  const response = await session.act("攻击 胸部暴击者", session.activePlayerId);
  return { response, rolls };
}

describe("CoC 胸部暴击的大出血状态闭环", () => {
  test("错误行为红线：真实 NPC 胸部暴击写入大出血；下一回合逐次掷 1d3 并同步角色卡", async () => {
    const session = await chestSession("npc");
    const { response } = await triggerNpcChestCritical(session);
    const player = session.world.getEntity(session.activePlayerId)!;

    expect(player.hp).toBe(44);
    expect(statusIds(player)).toContain("hemorrhaging");
    expect(response.events.some((event) => event.content.includes("大出血"))).toBe(true);

    // d3=3；本回合状态 tick 发生在“观察”意图派发之前。
    Math.random = () => 0.99;
    const next = await session.act("观察", session.activePlayerId);
    const ticked = session.world.getEntity(session.activePlayerId)!;
    expect(ticked.hp).toBe(41);
    expect(session.activeCharacter!.hp).toBe(41);
    expect(next.state.player.hp).toBe(41);
    expect(statusIds(ticked)).toContain("hemorrhaging");

    // 规则文本没有三回合到期；再跨过普通 bleeding 会结束的第三个 tick，
    // 大出血仍须保留并继续结算。
    for (const expectedHp of [38, 35, 32]) {
      await session.act("观察", session.activePlayerId);
      const later = session.world.getEntity(session.activePlayerId)!;
      expect(later.hp).toBe(expectedHp);
      expect(statusIds(later)).toContain("hemorrhaging");
    }
  }, 20_000);

  test("同一实体的多个大出血实例和 stack 各自掷 d3，不按普通流血或单骰乘层数结算", async () => {
    const session = await chestSession("stacks", 50, { hp: 10, maxHp: 12, status: ["大出血", "大出血 x2"] });

    // 一个独立实例 d3=1，x2 的两层依次 d3=2、3：10 - 6 = 4。
    const values = [0, 0.49, 0.99];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0.99;
    await session.act("观察", session.activePlayerId);
    const player = session.world.getEntity(session.activePlayerId)!;

    expect(player.hp).toBe(4);
    expect(session.activeCharacter!.hp).toBe(4);
    expect(rolls).toBeGreaterThanOrEqual(3);
    expect(statusIds(player)).toEqual(["hemorrhaging", "hemorrhaging"]);
  }, 20_000);

  test("急救成功先承受大出血 tick，再治疗并同时清除普通流血与大出血；下一回合不再掉血", async () => {
    const session = await chestSession("aid-success", 50, {
      hp: 10, maxHp: 12, skillValues: { first_aid: 90 },
      status: [newStatus("bleeding"), "大出血", newStatus("blinded", 4), "重伤:胸部"],
    });

    // 大出血 d3=2，普通流血=1，急救 d100=50 成功，治疗 d3=3：10 - 3 + 3 = 10。
    // First Aid restores its fixed 1 HP; only Medicine uses 1d3 healing.
    const values = [0.66, 0.49];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0;
    const aided = await session.act("急救伤口", session.activePlayerId);
    const player = session.world.getEntity(session.activePlayerId)!;

    expect(player.hp).toBe(8);
    expect(session.activeCharacter!.hp).toBe(8);
    expect(aided.state.player.hp).toBe(8);
    expect(aided.events.some((event) => event.content.includes("恢复了 1 点 HP"))).toBe(true);
    expect(statusIds(player)).not.toContain("bleeding");
    expect(statusIds(player)).not.toContain("hemorrhaging");
    expect(statusIds(player)).toContain("blinded");
    expect(player.status).toContain("重伤:胸部");

    await session.act("观察", session.activePlayerId);
    expect(player.hp).toBe(8);
    expect(session.activeCharacter!.hp).toBe(8);
  }, 20_000);

  test("急救失败不止血：大出血仍在下回合继续按 d3 伤害并同步角色卡", async () => {
    const session = await chestSession("aid-failure", 50, {
      hp: 10, maxHp: 12, skillValues: { first_aid: 10, medicine: 99 }, status: ["大出血"],
    });

    // tick d3=2，随后 d100=50 在 first_aid=10 下失败（不得用 medicine=99）。
    const values = [0.66, 0.49];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0.99;
    await session.act("急救伤口", session.activePlayerId);
    const player = session.world.getEntity(session.activePlayerId)!;
    expect(player.hp).toBe(8);
    expect(session.activeCharacter!.hp).toBe(8);
    expect(statusIds(player)).toContain("hemorrhaging");

    Math.random = () => 0.99; // d3=3
    await session.act("观察", session.activePlayerId);
    const ticked = session.world.getEntity(session.activePlayerId)!;
    expect(ticked.hp).toBe(5);
    expect(session.activeCharacter!.hp).toBe(5);
    expect(statusIds(ticked)).toContain("hemorrhaging");
  }, 20_000);

  test("普通 bleeding 仍是固定每回合 1 HP，不被大出血规则改变", async () => {
    const session = await chestSession("ordinary-bleeding", 50, { hp: 10, maxHp: 12, status: [newStatus("bleeding")] });

    Math.random = () => 0.99;
    await session.act("观察", session.activePlayerId);
    const player = session.world.getEntity(session.activePlayerId)!;
    expect(player.hp).toBe(9);
    expect(session.activeCharacter!.hp).toBe(9);
    expect(statusIds(player)).toContain("bleeding");
  }, 20_000);

  test("伤害已致 0 时不附加大出血状态", async () => {
    const session = await chestSession("lethal", 6);
    await triggerNpcChestCritical(session);
    const player = session.world.getEntity(session.activePlayerId)!;

    expect(player.hp).toBe(0);
    expect(session.dead).toBe(true);
    expect(statusIds(player)).not.toContain("hemorrhaging");
  }, 20_000);

  test("玩家 legacy 明确瞄准胸部的暴击也沿同一 statusEffect 消费路径写入大出血", async () => {
    const session = await chestSession("player", 50, undefined, { id: "玩家胸部目标", name: "玩家胸部目标" });
    const target = session.world.getEntity("玩家胸部目标")!;

    // 玩家旧兼容档 d100=1 是暴击，随后伤害=6；NPC 的反击也不会致死玩家。
    Math.random = () => 0;
    await session.act("瞄准胸部攻击 玩家胸部目标", session.activePlayerId);
    const wounded = session.world.getEntity(target.id)!;
    expect(wounded.hp).toBe(44);
    expect(statusIds(wounded)).toContain("hemorrhaging");

    Math.random = () => 0; // NPC 大出血 d3=1
    await session.act("观察", session.activePlayerId);
    const ticked = session.world.getEntity(target.id)!;
    expect(ticked.hp).toBe(43);
    expect(statusIds(ticked)).toContain("hemorrhaging");
  }, 20_000);
});
