// 胸部贯穿的 CON 检定必须从命中部位规则走到真实玩家行动门禁。
//
// GameSession 的玩家攻击兼容档保留旧骰制，不产生标准 CoC 的极限贯穿；因此这里
// 用真实 NPC 反击覆盖可达的标准 RulesEngine 路径，而非为测试改变旧玩家契约。

import { afterEach, describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
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
  attributes?: Record<string, number>;
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

async function chestSession(label: string, constitution: number | undefined, hp = 50): Promise<SessionInternals> {
  const id = `chest-con-${label}-${Math.random()}`;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Fixture Ada");
  expect(source.updateActiveCharacter({ hp, maxHp: hp })).toMatchObject({ status: "updated" });
  const session = new GameSession(id, "cosmic-horror", CFG);
  restoreSignedOrdinaryWorld(session, CFG, (world) => {
    const state = world.getCurrentState();
    const player = state.entities.p1!;
    const attributes = { ...player.attributes };
    if (constitution === undefined) delete attributes.constitution;
    else attributes.constitution = constitution;
    // RulesEngine reads the combat projection. The character sheet is left
    // intact so the unresolved case proves it is not used as a fallback.
    world.upsertEntity({ ...player, attributes });
    const scene = state.scene;
    world.upsertEntity({
      id: "胸部反击者", name: "胸部反击者", type: "monster", hp: 200, maxHp: 200,
      ac: 0, status: [], position: scene, scene_id: scene,
    });
  }, source);
  source.close();
  return session;
}

async function triggerChestImpale(session: SessionInternals, conRoll: number | undefined): Promise<{ response: Awaited<ReturnType<GameSession["act"]>>; rolls: number }> {
  // 玩家先大失败；NPC d100=5 为极限成功；玩家闪避=100；d20=13 命中胸部。
  // 最后一枚只在有可用 CON 且伤害后仍有 HP 时才是 CON 检定。
  const values = [0.99, 0.5, 0.04, 0.99, 0.6, ...(conRoll === undefined ? [] : [conRoll])];
  let rolls = 0;
  Math.random = () => values[rolls++] ?? 0.99;
  const response = await session.act("攻击 胸部反击者", session.activePlayerId);
  return { response, rolls };
}

describe("CoC 胸部贯穿的 CON 失能后续检定", () => {
  test("错误行为红线：真实 NPC 胸部贯穿的 CON 失败必须阻断下一次行动，到期后恢复", async () => {
    const session = await chestSession("fail", 20);
    const { response, rolls } = await triggerChestImpale(session, 0.99);
    const player = session.world.getCurrentState().entities[session.activePlayerId]!;

    expect(rolls).toBe(7);
    expect(player.hp).toBe(44);
    expect(statusIds(player)).toContain("incapacitated");
    expect(response.events.some((event) => event.content.includes("CON检定失败") && event.content.includes("失能"))).toBe(true);

    const blocked = await session.act("观察", session.activePlayerId);
    expect(blocked.events.some((event) => event.content.includes("失能") && event.content.includes("无法行动"))).toBe(true);
    expect(statusIds(session.world.getCurrentState().entities[session.activePlayerId]!)).not.toContain("incapacitated");

    const recovered = await session.act("观察", session.activePlayerId);
    expect(recovered.events.some((event) => event.type === "action" && event.content === "观察")).toBe(true);
    expect(recovered.events.some((event) => event.content.includes("无法行动"))).toBe(false);
  }, 20_000);

  test("CON 成功时胸部贯穿只保留伤害，不凭空附加一回合失能", async () => {
    const session = await chestSession("success", 20);
    const { response, rolls } = await triggerChestImpale(session, 0);
    const player = session.world.getCurrentState().entities[session.activePlayerId]!;

    expect(rolls).toBe(7);
    expect(player.hp).toBe(44);
    expect(statusIds(player)).not.toContain("incapacitated");
    expect(response.events.some((event) => event.content.includes("CON检定通过"))).toBe(true);
  }, 20_000);

  test("缺失 CON 是显式 unresolved：不多掷、不失能，也不偷用角色卡属性", async () => {
    const session = await chestSession("missing", undefined);
    const { response, rolls } = await triggerChestImpale(session, undefined);
    const player = session.world.getCurrentState().entities[session.activePlayerId]!;

    expect(rolls).toBe(6);
    expect(player.hp).toBe(44);
    expect(statusIds(player)).not.toContain("incapacitated");
    expect(response.events.some((event) => event.content.includes("CON属性未知") && event.content.includes("无法结算"))).toBe(true);
  }, 20_000);

  test("非法 CON 也是显式 unresolved：不把 0 当作可用检定值", async () => {
    const session = await chestSession("invalid", 0);
    const { response, rolls } = await triggerChestImpale(session, undefined);
    const player = session.world.getCurrentState().entities[session.activePlayerId]!;

    expect(rolls).toBe(6);
    expect(player.hp).toBe(44);
    expect(statusIds(player)).not.toContain("incapacitated");
    expect(response.events.some((event) => event.content.includes("CON属性未知") && event.content.includes("无法结算"))).toBe(true);
  }, 20_000);

  test("胸部贯穿伤害已致 0 时不再消耗 CON 骰或额外挂失能", async () => {
    const session = await chestSession("lethal", 20, 6);
    const { rolls } = await triggerChestImpale(session, undefined);
    const player = session.world.getEntity(session.activePlayerId)!;

    expect(rolls).toBe(6);
    expect(player.hp).toBe(0);
    expect(statusIds(player)).not.toContain("incapacitated");
    expect(session.dead).toBe(true);
  }, 20_000);
});
