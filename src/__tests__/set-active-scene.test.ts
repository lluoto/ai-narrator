// 切换活动场景失败时，不许静默，更不许把世界弄成「没有活动场景」。
//
// 起因：扫「返回成功与否却被丢掉返回值」的调用点（`tools/_probe-dropped-returns.ts`），
// `setScene` 在 `game-session.ts` 两处被当语句调用，返回值直接扔掉。
// 顺着看下去，源头比调用点更糟 ——
//
//     setActiveScene(sceneId) {
//       db.run("UPDATE scenes SET is_active = 0");                    // 先清掉全部
//       db.run("UPDATE scenes SET is_active = 1 WHERE id = ?", [id]);  // 再打开目标
//     }
//
// 目标不存在时第二句匹配不到行，**世界里一个活动场景都不剩** ——
// 比「什么都没做」更糟，而且没有返回值，调用方拿不到任何信号。
//
// docs/kp-tool-surface-assessment.md §八 记过两次同类事故，原话：
// 「类型检查与 710 个测试全绿，只有真实跑团暴露了它」。

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GameSession } from "../api/game-session";
import { WorldStateManager } from "../state/world-state-manager";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const LLM = { apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7 };

let session: GameSession;
let world: WorldStateManager;
beforeEach(() => {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  session = new GameSession(`scene-activate-${Math.random()}`, "cosmic-horror", LLM, undefined, "调查员");
  // Scene registration and atomic activation are WorldStateManager contracts.
  // GameSession intentionally publishes only a read observation of its world.
  world = new WorldStateManager(":memory:");
  world.registerScene("room_a", "A 房间", "第一间");
  world.registerScene("room_b", "B 房间", "第二间");
});

afterEach(() => {
  session.close();
  world.close();
});

const activeScene = () => world.getCurrentState().scene;
const activeSceneCount = () => (
  world
    .exportSnapshot()
    .tables.scenes
    .filter((scene) => scene.is_active === 1)
    .length
);

describe("setActiveScene — 成功路径", () => {
  test("**正确输入**：切到已注册的场景 → 返回 true 且真的切了", () => {
    expect(world.setActiveScene("room_a")).toBe(true);
    expect(activeScene()).toBe("room_a");
  });

  test("连续切换以最后一次为准", () => {
    world.setActiveScene("room_a");
    expect(world.setActiveScene("room_b")).toBe(true);
    expect(activeScene()).toBe("room_b");
    expect(activeSceneCount()).toBe(1);
  });
});

describe("setActiveScene — 失败路径", () => {
  test("**错误输入**：切到没注册的场景 → 返回 false", () => {
    expect(world.setActiveScene("nowhere")).toBe(false);
  });

  test("**错误行为的红线**：失败**不得**把原来的活动场景清掉", () => {
    // 这是原实现最要命的地方：先无条件 `UPDATE scenes SET is_active = 0`，
    // 目标不存在时第二句匹配不到行 —— 世界里一个活动场景都不剩。
    // 变异检验：把存在性校验去掉，这条立刻红。
    world.setActiveScene("room_a");
    expect(activeScene()).toBe("room_a");

    expect(world.setActiveScene("nowhere")).toBe(false);
    expect(activeScene()).toBe("room_a"); // 原样保留，不是 undefined
    expect(activeSceneCount()).toBe(1);
  });

  test("目标存在但激活阶段被 SQLite 拒绝时，回滚到原活动场景并继续抛出错误", () => {
    // SQLite trigger injection belongs to a standalone manager fixture. The
    // GameSession facade deliberately does not expose a raw connection.
    const world = new WorldStateManager(":memory:");
    try {
      world.registerScene("room_a", "A 房间");
      world.registerScene("room_b", "B 房间");
      expect(world.setActiveScene("room_a")).toBe(true);
      world.getDatabase().exec(`
        CREATE TRIGGER reject_target_activation
        BEFORE UPDATE OF is_active ON scenes
        WHEN NEW.id = 'room_b' AND NEW.is_active = 1
        BEGIN
          SELECT RAISE(ABORT, 'target activation denied');
        END;
      `);

      // The activation failure is an operational error, not a false "not found"
      // result. The manager transaction must retain the prior active scene.
      expect(() => world.setActiveScene("room_b")).toThrow("target activation denied");
      expect(world.getCurrentState().scene).toBe("room_a");
      expect(world.exportSnapshot().tables.scenes.filter((scene) => scene.is_active === 1)).toHaveLength(1);
    } finally {
      world.close();
    }
  });

  test("**干扰输入**：空串 / 不存在的 id 都不该动现状", () => {
    world.setActiveScene("room_b");
    for (const bad of ["", "   ", "room_c", "ROOM_A"]) {
      world.setActiveScene(bad);
      expect(activeScene()).toBe("room_b");
    }
  });
});

describe("GameSession.setScene — 转发的是回读结果，不是「我调用过了」", () => {
  async function installBarn(): Promise<void> {
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
  }

  test("**正确输入**：已注册 → true", async () => {
    await installBarn();
    expect(activateRegisteredGameSessionSceneForTest(session, "加比的拖车房")).toBe(true);
    expect(session.world.getCurrentState().scene).toBe("加比的拖车房");
  });

  test("**错误输入**：未注册 → false，且现状不变", async () => {
    await installBarn();
    activateRegisteredGameSessionSceneForTest(session, "加比的拖车房");
    expect(activateRegisteredGameSessionSceneForTest(session, "nowhere")).toBe(false);
    expect(session.world.getCurrentState().scene).toBe("加比的拖车房");
  });

  test("**干扰输入**：另一已安装场景也该成功，别把守卫做成一律拒绝", async () => {
    await installBarn();
    expect(activateRegisteredGameSessionSceneForTest(session, "维修间")).toBe(true);
    expect(session.world.getCurrentState().scene).toBe("维修间");
  });
});
