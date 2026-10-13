import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { BARN_OF_PREMIER } from "../module/barn-of-premier";

const config = { apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 512, temperature: 0.7 };

async function loadedSession(label: string): Promise<GameSession> {
  const session = new GameSession(`module-data-npc-${label}`, "cosmic-horror", config, undefined, "调查员");
  await session.act("创建角色 investigator 甲");
  await session.act("加载模组 普瑞米尔的谷仓");
  return session;
}

describe("步骤 5C：ModuleData 叙事 NPC 进入自由跑团", () => {
  const cases = [
    { scene: "维森酒吧", npc: "前台", utterance: "和前台交谈" },
    { scene: "报亭", npc: "报亭老板", utterance: "跟报亭老板聊聊" },
    { scene: "霍姆斯医院", npc: "医护人员", utterance: "问问医护人员" },
  ];

  for (const entry of cases) {
    it(`${entry.npc} 在 ${entry.scene} 作为非战斗叙事 NPC 真实进入行动锚点并接受自然语言对话`, async () => {
      const session = await loadedSession(entry.npc);
      await session.act(`前往${entry.scene}`);
      expect(session.getSuggestions("p1")).toContain(`与 ${entry.npc} 交谈`);
      const sourceNpc = BARN_OF_PREMIER.npcs.find((npc) => npc.name === entry.npc);
      if (!sourceNpc) throw new Error(`source NPC missing: ${entry.npc}`);
      expect(sourceNpc?.runtime).toBeUndefined();
      const entity = session.world.getEntity(sourceNpc.id);
      expect(entity?.status).toContain("narrative_noncombat");
      expect(entity?.hp).toBe(0); // storage placeholder, not an authored combat stat
      expect(session.getState().npcs.map((npc) => npc.name)).toContain(entry.npc);
      const aliveEnemies: unknown = Reflect.apply(Reflect.get(session, "aliveEnemies"), session, []);
      if (!Array.isArray(aliveEnemies)) throw new Error("aliveEnemies did not return an array");
      expect(aliveEnemies.some((enemy) => typeof enemy === "object" && enemy !== null && Reflect.get(enemy, "name") === entry.npc)).toBe(false);
      const response = await session.act(entry.utterance);
      expect(response.events.some((event) => event.speaker === entry.npc || event.speaker === "系统")).toBe(true);
    });
  }

  it("谷仓加载结果来自 direct ModuleData loader，而非旧 Mythos loader 标题", async () => {
    const session = new GameSession("module-data-npc-direct-marker", "cosmic-horror", config, undefined, "调查员");
    await session.act("创建角色 investigator 甲");
    const loaded = await session.act("加载模组 普瑞米尔的谷仓");
    const output = [loaded.narrative, ...loaded.events.map((event) => event.content)].join("\n");
    expect(output).toContain("【统一模组：普瑞米尔的谷仓】");
    expect(output).not.toContain("【剧本杀模组：普瑞米尔的谷仓】");
    expect(Reflect.ownKeys(session)).not.toContain("_moduleLoader");
    expect(Reflect.ownKeys(session)).not.toContain("_moduleDataLoader");
  });

  for (const [request, title] of [["阿卡姆档案检查", "密斯卡托尼克之秘"], ["印斯茅斯的阴影", "印斯茅斯的阴霾"]] as const) {
    it(`${request} 继续走按需创建的 legacy MythosModuleLoader 分支`, async () => {
      const session = new GameSession(`module-data-npc-legacy-${request}`, "cosmic-horror", config, undefined, "调查员");
      expect(Reflect.ownKeys(session)).not.toContain("_moduleLoader");
      const loaded = await session.act(`加载模组 ${request}`);
      expect(Reflect.ownKeys(session)).not.toContain("_moduleLoader");
      expect(loaded.events.map((event) => event.content).join("\n")).toContain(`【剧本杀模组：${title}】`);
    });
  }

  it("14 个统一叙事 NPC 全部进入世界；其中 11 个用 runtime identity，3 个走非战斗路径", async () => {
    const session = await loadedSession("all-14");
    const ids = BARN_OF_PREMIER.npcs.map((npc) => npc.runtime?.sourceId ?? npc.id);
    expect(ids).toHaveLength(14);
    for (const id of ids) expect(session.world.getEntity(id)).not.toBeNull();
    expect(BARN_OF_PREMIER.npcs.filter((npc) => npc.runtime)).toHaveLength(11);
    expect(BARN_OF_PREMIER.npcs.filter((npc) => !npc.runtime).map((npc) => npc.name).sort()).toEqual(
      ["前台", "医护人员", "报亭老板"].sort(),
    );
  });
});
