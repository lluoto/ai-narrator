import { describe, expect, it } from "bun:test";
import {
  ARKHAM_LIBRARY_MODULE,
  INNSMOUTH_MODULE,
  MythosModuleLoader,
  type MythosModule,
  type MythosModuleHost,
} from "../rules/mythos-module";
import type { MessageType } from "../agent/types";

function expectedWhitelist(module: MythosModule): Set<string> {
  const scenes = new Set<string>();
  if (module.sceneDescriptions) for (const id of Object.keys(module.sceneDescriptions)) scenes.add(id);
  if (module.npcs) for (const npc of module.npcs) if (npc.sceneId && npc.sceneId !== "unknown") scenes.add(npc.sceneId);
  if (module.items) for (const item of module.items) if (item.sceneId && item.sceneId !== "unknown") scenes.add(item.sceneId);
  if (module.tomes) for (const tome of module.tomes) if (tome.sceneId && tome.sceneId !== "unknown") scenes.add(tome.sceneId);
  if (module.clues) for (const clue of module.clues) if (clue.scene && clue.scene !== "unknown") scenes.add(clue.scene);
  if (module.exits) for (const [id, exits] of Object.entries(module.exits)) {
    scenes.add(id);
    for (const exit of exits) scenes.add(exit.target);
  }
  return scenes;
}

function createMockHost(): MythosModuleHost & { registeredScenes: string[]; registeredHooks: number } {
  const registeredScenes: string[] = [];
  let registeredHooks = 0;
  const sceneItems = new Map<string, string[]>();
  return {
    registerSpell() { return true; },
    registerTome(tome) {
      const items = sceneItems.get(tome.sceneId) ?? [];
      if (!items.includes(tome.name)) items.push(tome.name);
      sceneItems.set(tome.sceneId, items);
    },
    sceneItems, itemDescriptions: new Map(),
    world: { upsertEntity() {}, logEvent() {} },
    registerScene(sceneId: string) { registeredScenes.push(sceneId); },
    registerHook() { registeredHooks++; },
    addMessage(_speaker: string, _content: string, _type: MessageType) {},
    activeRuleset: "cosmic-horror", currentRound: 1, registeredScenes,
    get registeredHooks() { return registeredHooks; },
  };
}

describe("MythosModuleLoader scene whitelist remains for Arkham/InnsMouth", () => {
  it("each legacy module registers exactly its independently derived whitelist", () => {
    for (const module of [INNSMOUTH_MODULE, ARKHAM_LIBRARY_MODULE]) {
      const host = createMockHost();
      new MythosModuleLoader(host).import(module);
      expect(new Set(host.registeredScenes)).toEqual(expectedWhitelist(module));
    }
  });

  it("on_read_tome hook conditions are not mistaken for scenes, while hooks still register", () => {
    for (const module of [INNSMOUTH_MODULE, ARKHAM_LIBRARY_MODULE]) {
      const host = createMockHost();
      new MythosModuleLoader(host).import(module);
      const scenes = new Set(host.registeredScenes);
      expect(scenes.has("扎多克的低语")).toBe(false);
      expect(scenes.has("塞拉伊诺断章")).toBe(false);
      expect(host.registeredHooks).toBe(module.hooks?.length ?? 0);
    }
  });
});
