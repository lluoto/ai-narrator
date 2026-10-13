// 头部暴击的 CON 检定必须从规则文本的结构化 follow-up 走到真实会话结算。
//
// 这里不直接调 CoCEngine：玩家攻击和 NPC 反击各走 GameSession.act()，覆盖骰序、
// 世界实体属性、伤害写回及死亡/状态消费。没有 CON 不能凭默认值掷骰或杀死目标。

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

async function playerSession(
  label: string,
  target?: { id: string; constitution?: number; hp?: number },
  playerCon?: number,
): Promise<SessionInternals> {
  const id = `head-con-${label}-${Math.random()}`;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Fixture Ada");
  if (playerCon !== undefined) {
    expect(source.updateActiveCharacter({
      hp: 50,
      maxHp: 50,
      attributes: { constitution: playerCon },
    })).toMatchObject({ status: "updated" });
  }
  const session = new GameSession(id, "cosmic-horror", CFG);
  restoreSignedOrdinaryWorld(session, CFG, (world) => {
    const state = world.getCurrentState();
    const scene = state.scene;
    if (target) {
      world.upsertEntity({
        id: target.id, name: target.id, type: "monster", hp: target.hp ?? 50, maxHp: target.hp ?? 50, ac: 0, status: [],
        position: scene, scene_id: scene,
        ...(target.constitution === undefined ? {} : { attributes: { constitution: target.constitution } }),
      });
    }
  }, source);
  source.close();
  return session;
}

describe("CoC 头部暴击的 CON 致死后续检定", () => {
  test("错误行为红线：玩家头部暴击后，目标 CON 失败必须在同一真实攻击路径死亡", async () => {
    const session = await playerSession("player-fail", { id: "低体质目标", constitution: 20 });

    // 玩家 d100=1（旧玩家兼容暴击）、伤害为 6、随后 CON d100=100 失败。
    // 规则引擎在生成叙事前结算后续判定：攻击 d100=1、伤害=6、CON d100=100。
    const values = [0, 0, 0.99];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0.99;
    const response = await session.act("瞄准头部攻击 低体质目标", session.activePlayerId);

    const target = session.world.getEntity("低体质目标")!;
    expect(target.hp).toBe(0);
    expect(rolls).toBe(5); // CON 后仍保留既有短叙事的两枚随机数
    expect(statusIds(target)).not.toContain("stunned");
    expect(response.events.some((event) => event.content.includes("CON检定失败") && event.content.includes("死亡"))).toBe(true);
  }, 20_000);

  test("成功的 CON 检定只保留已有的昏迷约束，不把存活者杀死", async () => {
    const session = await playerSession("player-success", { id: "高体质目标", constitution: 20 });

    const values = [0, 0, 0, 0, 0];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0.99;
    const response = await session.act("瞄准头部攻击 高体质目标", session.activePlayerId);

    const target = session.world.getCurrentState().entities["高体质目标"]!;
    expect(target.hp).toBe(44);
    // 成功后敌人仍存活，会照旧还手；新增的第 5 枚是 CON，合计比旧路径多一枚。
    expect(rolls).toBe(7);
    expect(statusIds(target)).toContain("stunned");
    expect(response.events.some((event) => event.content.includes("CON检定通过") && event.content.includes("昏迷"))).toBe(true);
  }, 20_000);

  test("缺少 CON 时显式 unresolved：不伪造检定、不致死，仍只应用明确的昏迷", async () => {
    const session = await playerSession("missing-con", { id: "未知体质目标" });

    // The NPC counterattacks with a critical while the player fumbles their
    // dodge. These are the eleven known non-CON draws; missing CON must not
    // consume a twelfth draw.
    const values = [0, 0, 0, 0, 0, 0.99, 0, 0, 0, 0.99, 0.99];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0.99;
    const response = await session.act("瞄准头部攻击 未知体质目标", session.activePlayerId);

    const target = session.world.getCurrentState().entities["未知体质目标"]!;
    expect(target.hp).toBe(44);
    // 既有攻击/短叙事/反击共消费 11 枚；缺失 CON 不得在其上再加一枚。
    expect(rolls).toBe(11);
    expect(statusIds(target)).toContain("stunned");
    expect(response.events.some((event) => event.content.includes("CON属性未知") && event.content.includes("无法结算"))).toBe(true);
  }, 20_000);

  test("伤害已经将头部目标降为 0 时不再额外消耗 CON 检定骰", async () => {
    const session = await playerSession("already-zero", { id: "已致零目标", constitution: 20, hp: 6 });

    let rolls = 0;
    Math.random = () => { rolls++; return 0; };
    await session.act("瞄准头部攻击 已致零目标", session.activePlayerId);

    const target = session.world.getCurrentState().entities["已致零目标"]!;
    expect(target.hp).toBe(0);
    // 攻击、伤害及既有短叙事共四枚；HP 已归零则不再加 CON 骰。
    expect(rolls).toBe(4);
    expect(statusIds(target)).not.toContain("stunned");
  }, 20_000);

  test("NPC 反击也消费同一 follow-up：玩家的角色卡 CON 已投影后，失败会死亡", async () => {
    const session = await playerSession("npc-fail", { id: "头部反击者" });
    const player = session.world.getCurrentState().entities[session.activePlayerId]!;
    // 角色卡是玩家 CON 的来源；世界实体是 RulesEngine 的战斗输入投影。
    expect(player.attributes?.constitution).toBe(session.activeCharacter?.attributes?.constitution);

    // 玩家先大失败；NPC 再掷 1 暴击，玩家闪避 100，d20=20 命中头部，CON=100 失败。
    const values = [0.99, 0.5, 0, 0.99, 0.99, 0.99];
    let i = 0;
    Math.random = () => values[i++] ?? 0.99;
    const response = await session.act("攻击 头部反击者", session.activePlayerId);

    const after = session.world.getEntity(session.activePlayerId)!;
    expect(after.hp).toBe(0);
    expect(statusIds(after)).not.toContain("stunned");
    expect(session.dead).toBe(true);
    expect(response.events.some((event) => event.content.includes("CON检定失败") && event.content.includes("死亡"))).toBe(true);
  }, 20_000);
});
