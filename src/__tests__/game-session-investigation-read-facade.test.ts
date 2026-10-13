import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 256,
  temperature: 0,
};

function session(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", LLM, "investigator", "Facade Tester");
}

async function loaded(id: string): Promise<GameSession> {
  const value = session(id);
  const result = await value.act("加载模组 普瑞米尔的谷仓");
  expect(result.error).toBeUndefined();
  return value;
}

describe("GameSession investigation read facade", () => {
  it("has a stable frozen prototype getter and exposes no engine authority", async () => {
    const value = session(`investigation-facade-shape-${crypto.randomUUID()}`);
    try {
      const before = value.investigation;
      expect(Object.isFrozen(before)).toBe(true);
      expect(Reflect.ownKeys(before)).toEqual([
        "listClueTypes",
        "hasClueType",
        "getClueMatchInfo",
        "isCoreClue",
        "isLockedByUndiscoveredPrerequisite",
        "listModuleClueIds",
        "isDiscoveredBy",
        "getDiscoveredBy",
        "getSceneClues",
        "getUndiscoveredSceneClues",
      ]);
      expect(Object.getOwnPropertyDescriptor(value, "investigation")).toBeUndefined();
      expect(Object.getOwnPropertyNames(value)).not.toContain("investigationFacade");
      expect(Object.getOwnPropertyNames(value)).not.toContain("investigationRaw");
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), "investigation");
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.set).toBeUndefined();
      expect(Reflect.set(value as object, "investigation", new Map())).toBe(false);
      expect(() => Object.assign(value as object, { investigation: new Map() })).toThrow(TypeError);
      expect(value.investigation).toBe(before);

      for (const key of [
        "setDifficultyProfile",
        "addClueType",
        "registerSceneClue",
        "markDiscovered",
        "resetAttempts",
        "investigate",
        "investigateCoC",
        "clueDescriptions",
        "clueTypes",
      ]) {
        expect((before as Record<string, unknown>)[key]).toBeUndefined();
      }

      expect(before.hasClueType("clue_pistol_in_bag")).toBe(false);
      const load = await value.act("加载模组 普瑞米尔的谷仓");
      expect(load.error).toBeUndefined();
      expect(value.investigation).toBe(before);
      expect(before.hasClueType("clue_pistol_in_bag")).toBe(true);
      const extractedSceneClues = before.getSceneClues;
      expect(extractedSceneClues("加比的拖车房")).toContain("clue_pistol_in_bag");
    } finally {
      value.close();
    }
  });

  it("returns detached frozen scene and clue-match observations", async () => {
    const value = await loaded(`investigation-facade-alias-${crypto.randomUUID()}`);
    try {
      const view = value.investigation;
      const scene = "加比的拖车房";
      const clues = view.getSceneClues(scene);
      const sameSceneClues = view.getSceneClues(scene);
      expect(clues.length).toBeGreaterThan(0);
      expect(Object.isFrozen(clues)).toBe(true);
      expect(sameSceneClues).not.toBe(clues);
      expect(() => (clues as unknown as string[]).push("injected-clue")).toThrow();
      expect(view.getSceneClues(scene)).not.toContain("injected-clue");

      const matched = clues
        .map((id) => ({ id, info: view.getClueMatchInfo(id) }))
        .find((candidate) => candidate.info !== null);
      expect(matched).toBeDefined();
      const info = matched!.info!;
      const sameInfo = view.getClueMatchInfo(matched!.id)!;
      expect(Object.isFrozen(info)).toBe(true);
      expect(Object.isFrozen(info.matchTexts)).toBe(true);
      expect(sameInfo).not.toBe(info);
      expect(sameInfo.matchTexts).not.toBe(info.matchTexts);
      expect(() => (info.matchTexts as unknown as string[]).push("injected-match")).toThrow();
      expect(view.getClueMatchInfo(matched!.id)?.matchTexts).not.toContain("injected-match");
    } finally {
      value.close();
    }
  });

  it("keeps real module clue observations coherent through ordinary snapshot restore", async () => {
    const id = `investigation-facade-ordinary-${crypto.randomUUID()}`;
    const source = await loaded(id);
    const target = new GameSession(id, "cosmic-horror", LLM);
    const clueId = "clue_pistol_in_bag";
    try {
      expect(activateRegisteredGameSessionSceneForTest(source, "加比的拖车房")).toBe(true);
      const random = Math.random;
      Math.random = () => 0;
      try {
        expect((await source.act("检查床底")).error).toBeUndefined();
      } finally { Math.random = random; }
      expect(source.investigation.isDiscoveredBy(clueId, source.activePlayerId)).toBe(true);
      const snapshot = JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot()));
      target.restoreOrdinarySessionSnapshot(snapshot);

      expect(target.investigation.hasClueType(clueId)).toBe(true);
      expect(target.investigation.isDiscoveredBy(clueId, target.activePlayerId)).toBe(true);
      expect(target.investigation.getSceneClues("加比的拖车房")).toContain(clueId);
    } finally {
      source.close();
      target.close();
    }
  });
});
