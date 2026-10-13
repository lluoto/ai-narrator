// 场景激活必须只有一条写入路径，且不得静默无效
//
// 取证：game-session.ts 有三处绕过 setScene() 直接调 world.setActiveScene()：
//   L1250 movePlayerToScene()      —— 不检查场景是否已注册
//   L1275 handleMove 的场景映射分支 —— 用 (this.world as any).getDatabase() 裸写 SQL 建场景
//   L1683 加载生成故事后激活首个场景 —— 场景已注册，属形式上的绕过
//
// 两类风险：
//   1. setActiveScene() 是 `UPDATE scenes SET is_active=1 WHERE id=?`，
//      场景未注册时匹配不到行 → 整条切换静默失效，与 §八 记录的两次事故同类。
//   2. `as any` 取 getDatabase() 是宿主契约外的隐式依赖。§八 明确记过一次：
//      MythosModuleLoader 就是这么依赖 getDatabase()，宿主换成窄适配器后
//      运行时变 undefined，被 catch 降级成一行警告，模组场景出口整段失效。
//
// bun test src/__tests__/scene-write-path.test.ts

import { describe, it, expect, beforeEach } from "bun:test";
import { GameSession } from "../api/game-session";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 1024,
  temperature: 0.7,
};

let session: GameSession;

beforeEach(() => {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  session = new GameSession("scene-path", "cosmic-horror", LLM, "investigator", "调查员");
});

describe("场景切换的写入路径", () => {
  it("走别名映射前往场景后，该场景确实被激活", async () => {
    await session.act("前往 酒馆");
    expect(session.world.getCurrentState().scene).toBe("tavern");
  });

  it("经移动创建的场景是正经注册过的，可被 getScene 读到且带展示名", async () => {
    await session.act("前往 酒馆");
    const scene = session.world.getScene("tavern");
    expect(scene).not.toBeNull();
    expect(scene!.name.length).toBeGreaterThan(0);
  });

  it("前往一个此前完全没注册过的场景，切换不得静默失效", async () => {
    await session.act("前往 废弃灯塔");
    const active = session.world.getCurrentState().scene;
    expect(active).not.toBe("unknown");
    expect(session.world.getScene(active)).not.toBeNull();
  });

  it("连续移动后活动场景是最后一个目标，不残留在中间场景", async () => {
    await session.act("前往 酒馆");
    await session.act("前往 废弃灯塔");
    const active = session.world.getCurrentState().scene;
    expect(active).not.toBe("tavern");
    expect(session.world.getScene(active)).not.toBeNull();
  });

  it("KP 面板切到未注册场景仍然被拒绝（既有契约不变）", () => {
    expect(activateRegisteredGameSessionSceneForTest(session, "never_registered_at_all")).toBe(false);
  });

  it("KP 面板切到已注册场景成功且真的生效", async () => {
    expect((await session.act("前往 酒馆")).error).toBeUndefined();
    expect(activateRegisteredGameSessionSceneForTest(session, "tavern")).toBe(true);
    expect(session.world.getCurrentState().scene).toBe("tavern");
  });
});

// StoryGenerator 已经把场景连通关系整套算好了：SceneTemplate.exits 声明哪些场景
// 相连，生成时展开成 {target, desc, locked}，末尾还有兜底保证每个场景至少一个出口。
// 但 handleGenerateStory() 调的是 registerScene(id, name, description)——没有 exits
// 参数，于是这份数据在落库那一刻被整体丢弃，scenes.exits 停在 schema 默认的 '[]'。
describe("生成故事的场景连通关系", () => {
  it("生成后场景出口被持久化，而不是停在空数组", async () => {
    await session.act("生成故事");

    const scenes = session.world.listScenes();
    expect(scenes.length).toBeGreaterThan(1);
    expect(scenes.some((s) => s.exits.length > 0)).toBe(true);
  });

  it("出口指向的目标都是真实存在的场景，不是悬空 id", async () => {
    await session.act("生成故事");

    const scenes = session.world.listScenes();
    const ids = new Set(scenes.map((s) => s.id));
    const targets = scenes.flatMap((s) => s.exits.map((e) => e.target));

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(ids.has(target)).toBe(true);
    }
  });

  it("出口带有可读的通行描述", async () => {
    await session.act("生成故事");

    const exits = session.world.listScenes().flatMap((s) => s.exits);
    expect(exits.length).toBeGreaterThan(0);
    for (const exit of exits) {
      expect(exit.desc.length).toBeGreaterThan(0);
    }
  });

  // 生成器第 6 步自称「场景间连通性修复：确保没有孤立的场景」，但它只在
  // 出口为空的场景上补出边，从不补回边。于是那个场景走得出去、却没人走得进来：
  // 实测有一局 attic -> kitchen 单向，从起始的 entrance 出发永远到不了阁楼。
  // 出度 ≥ 1 不等于不孤立，可达性才是。
  //
  // 模板选取带随机性，所以这里跑多局验证这条性质对所有选法都成立。
  it("每个生成的场景都能从起始场景走到", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const fresh = new GameSession(`reach-${attempt}`, "cosmic-horror", LLM, "investigator", "调查员");
      await fresh.act("生成故事");

      const scenes = fresh.world.listScenes();
      const byId = new Map(scenes.map((s) => [s.id, s]));
      const start = fresh.world.getCurrentState().scene;

      const seen = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) break;
        for (const exit of byId.get(current)?.exits ?? []) {
          if (!seen.has(exit.target)) {
            seen.add(exit.target);
            queue.push(exit.target);
          }
        }
      }

      const unreachable = scenes.filter((s) => !seen.has(s.id)).map((s) => s.id);
      expect(unreachable).toEqual([]);
    }
  });
});
