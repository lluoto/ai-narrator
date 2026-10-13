// Phase 3.1: first real applyAction wiring.
// Difficulty is the smallest closed enum-shaped session state:
// easy | medium | hard | nightmare. Numeric HP/SAN deliberately remain out of
// scope until the numeric-domain design is decided.

import { beforeEach, describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";

const LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 1024,
  temperature: 0.7,
};

let session: GameSession;

function activePlayer() {
  const player = session.world.getEntity(session.activePlayerId);
  if (!player) throw new Error("test fixture must create an active player entity");
  return player;
}

beforeEach(() => {
  session = new GameSession("difficulty-gate", "cosmic-horror", LLM, "investigator", "调查员");
  const playerId = session.activePlayerId;
  // HP 必须取自角色卡：闸门读的是角色卡（setPlayerHp 走 characters.get），而断言读的是
  // 世界实体。这里写死常量的话，CoC 建卡按 (CON+SIZ)/10 逐局给出不同 HP，两边就会分叉，
  // 表现为「改动列表为空」——闸门认为你设的值就是当前值。
  session.setPlayerHp(playerId, session.activeCharacter.hp);
  /*
    id: playerId,
    name: "调查员",
    type: "pc",
    hp: session.activeCharacter.hp,
    maxHp: session.activeCharacter.maxHp,
    ac: 10,
    status: [],
    position: "tavern",
  */
});

describe("setDifficulty through applyAction", () => {
  it("accepts a legal enum transition and exposes its delta", () => {
    const result = session.setDifficulty("easy");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a legal difficulty transition");
    expect(result.value.changes).toEqual([{ variable: "difficulty", from: "medium", to: "easy" }]);
    expect(session.getGateState().variables.difficulty).toBe("easy");
  });

  it("rejects an out-of-domain value with the gate's structured reason", () => {
    const result = session.setDifficulty("impossible");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected difficulty rejection");
    expect(result.error.code).toBe("value_out_of_domain");
    expect(session.getGateState().variables.difficulty).toBe("medium");
  });

  it("treats setting the existing difficulty as an idempotent no-op", () => {
    const result = session.setDifficulty("medium");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected idempotent acceptance");
    expect(result.value.changes).toEqual([]);
  });
});

describe("setPlayerHp through applyAction", () => {
  it("accepts a bounded integer and synchronizes the player entity", () => {
    const playerId = session.activePlayerId;
    const before = activePlayer();
    const result = session.setPlayerHp(playerId, before.maxHp - 1);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected legal HP transition");
    expect(result.value.changes).toEqual([{ variable: `hp:${playerId}`, from: before.hp, to: before.maxHp - 1 }]);
    expect(activePlayer().hp).toBe(before.maxHp - 1);
  });

  it("updates the public session state for the active player", () => {
    const playerId = session.activePlayerId;
    const before = activePlayer();

    const result = session.setPlayerHp(playerId, before.hp - 1);

    expect(result.ok).toBe(true);
    expect(session.getState().player.hp).toBe(before.hp - 1);
  });

  it("rejects HP above the character maximum without changing the entity", () => {
    const playerId = session.activePlayerId;
    const before = activePlayer();
    const result = session.setPlayerHp(playerId, before.maxHp + 1);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected HP rejection");
    expect(result.error.code).toBe("value_out_of_domain");
    expect(activePlayer().hp).toBe(before.hp);
  });

  it("rejects fractional HP without changing the entity", () => {
    const playerId = session.activePlayerId;
    const before = activePlayer();
    const result = session.setPlayerHp(playerId, 1.5);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fractional HP rejection");
    expect(result.error.code).toBe("value_out_of_domain");
    expect(activePlayer().hp).toBe(before.hp);
  });
});

// SAN 与 HP 的差别在于它有 SanityEngine 这层进程内缓存，成功路径必须让
// 缓存与真相源同时前进；失败路径两边都不能动。
//
// 这里同时锁住一个行为变更：原实现是 Math.max(0, Math.min(value, maxSAN))，
// KP 设 999 会被静默钳成 50 并返回成功。闸门要求越界必须是结构化拒绝，
// 而不是「看起来成功了、值却不是你设的那个」。
describe("setPlayerSan through applyAction", () => {
  function persistedSan(): number | undefined {
    return session.world.getPlayerSanity(session.activePlayerId)?.currentSAN;
  }

  it("accepts an in-range value and advances both the cache and the truth source", () => {
    const playerId = session.activePlayerId;
    // 起始 SAN 等于角色卡的 POW，逐局不同，不能写死
    const startSan = session.sanity.state.currentSAN;
    const result = session.setPlayerSan(playerId, 37);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected legal SAN transition");
    expect(result.value.changes).toEqual([{ variable: `san:${playerId}`, from: startSan, to: 37 }]);
    expect(session.sanity.state.currentSAN).toBe(37);
    expect(persistedSan()).toBe(37);
  });

  it("rejects a value above maxSAN instead of silently clamping it", () => {
    const before = persistedSan();
    const startSan = session.sanity.state.currentSAN;
    const result = session.setPlayerSan(session.activePlayerId, 999);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected out-of-range SAN rejection");
    expect(result.error.code).toBe("value_out_of_domain");
    expect(session.sanity.state.currentSAN).toBe(startSan);
    expect(persistedSan()).toBe(before);
  });

  it("rejects a negative value instead of silently flooring it to zero", () => {
    const startSan = session.sanity.state.currentSAN;
    const result = session.setPlayerSan(session.activePlayerId, -5);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected negative SAN rejection");
    expect(result.error.code).toBe("value_out_of_domain");
    expect(session.sanity.state.currentSAN).toBe(startSan);
  });

  it("rejects an unknown player rather than fabricating a sanity engine", () => {
    const result = session.setPlayerSan("nobody", 20);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unknown player rejection");
    expect(result.error.code).toBe("unknown_target");
  });
});

// applyDamage 是算术增量而不是绝对赋值：先把「当前 HP 减去伤害」投影成
// 目标 HP，再交给同一个有界整数闸门。过量伤害落到 0 是正确的战斗语义，
// 与「负伤害被静默改成 0」不同——后者是把非法输入伪装成成功。
describe("applyDamage through applyAction", () => {
  it("accepts integer damage and reports the resulting HP as a delta", () => {
    const playerId = session.activePlayerId;
    const before = activePlayer();
    const result = session.applyDamage(playerId, 3);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected legal damage application");
    expect(result.value.changes).toEqual([
      { variable: `hp:${playerId}`, from: before.hp, to: before.hp - 3 },
    ]);
    expect(activePlayer().hp).toBe(before.hp - 3);
  });

  it("floors overkill damage at zero instead of going negative", () => {
    const playerId = session.activePlayerId;
    // 闸门读的是角色卡的 HP，而 CoC 建卡按 (CON+SIZ)/10 逐局给出不同值
    const before = session.activeCharacter.hp;
    const result = session.applyDamage(playerId, 999);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected overkill to be legal");
    expect(result.value.changes).toEqual([{ variable: `hp:${playerId}`, from: before, to: 0 }]);
    expect(activePlayer().hp).toBe(0);
  });

  it("rejects negative damage instead of silently treating it as zero", () => {
    const before = activePlayer();
    const result = session.applyDamage(session.activePlayerId, -5);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected negative damage rejection");
    expect(result.error.code).toBe("invalid_amount");
    expect(activePlayer().hp).toBe(before.hp);
  });

  it("rejects fractional damage instead of writing fractional HP", () => {
    const before = activePlayer();
    const result = session.applyDamage(session.activePlayerId, 2.5);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fractional damage rejection");
    expect(result.error.code).toBe("invalid_amount");
    expect(activePlayer().hp).toBe(before.hp);
  });

  it("rejects an unknown target instead of throwing", () => {
    const result = session.applyDamage("no_such_entity", 1);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unknown target rejection");
    expect(result.error.code).toBe("unknown_target");
  });

  // getCurrentState() 走的是 getAllAliveEntities()，玩家一死就从 entities 里消失，
  // getState() 于是落到硬编码兜底 { hp: 12, maxHp: 12 }——KP 把 PC 打死，
  // 面板反而显示满血。玩家自身的状态必须始终可读，与存活与否无关。
  it("still reports the player after a lethal hit instead of falling back to full HP", () => {
    const playerId = session.activePlayerId;
    const result = session.applyDamage(playerId, 999);

    expect(result.ok).toBe(true);
    expect(session.getState().player.hp).toBe(0);
  });

  // 上面的用例都靠 beforeEach 手动 upsert 了世界实体。真实的新会话没有这一步：
  // 构造函数只建角色卡，实体要等 setPlayerHp 或移动流程才懒建，于是 KP 在
  // 开局对 PC 施加伤害会被判成 unknown_target（改造前是抛异常兜成 500）。
  // /state 里那个硬编码 12/12 兜底一直掩盖着这个空洞。
  it("can damage the player character of a freshly created session", () => {
    const fresh = new GameSession("fresh-damage", "cosmic-horror", LLM, "investigator", "调查员");
    const before = fresh.getState().player.hp;

    const result = fresh.applyDamage(fresh.activePlayerId, 2);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`fresh session damage rejected: ${result.error.code}`);
    expect(fresh.getState().player.hp).toBe(before - 2);
  });
});
