import { expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { ordinaryGameSessionModuleHash, ordinaryGameSessionSnapshotHash } from "../api/ordinary-game-session-snapshot";
import { generatedStoryToRuntimeModuleData } from "../module/generated-story-runtime-module";
import { StoryGenerator, type GeneratedStory } from "../rules/story-generator";
import { WorldStateManager } from "../state/world-state-manager";
import { worldStateSnapshotHash } from "../state/world-state-snapshot";

function createSession(
  id: string,
  withCharacter: boolean,
  storyGenerator?: Pick<StoryGenerator, "generate">,
): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    undefined,
    withCharacter ? "detective" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined,
    undefined,
    undefined,
    "development_fallback",
    storyGenerator ? { storyGenerator } : {},
  );
}

function sourceScenes(session: GameSession) {
  return session.world.listScenes().map((scene) => ({
    id: scene.id,
    name: scene.name,
    description: scene.description,
    lighting: scene.lighting,
    dangers: scene.dangers,
    exits: scene.exits,
  }));
}

function generatedStoryWithExit(): GeneratedStory {
  const story = new StoryGenerator().generate({ subgenre: "lovecraft", length: "short", theme: "abandoned_house" });
  if (!story.scenes.some((scene) => scene.exits.length > 0)) throw new Error("test story must have an exit");
  return story;
}

function generatedStoryWithEntryMiGo(): GeneratedStory {
  return {
    title: "固定入口的米戈",
    hook: "一只米戈正在入口处等待调查员。",
    scenes: [
      {
        id: "entry",
        name: "入口",
        description: "潮湿的石阶通向一扇半开的门。",
        lighting: "dim",
        dangers: [],
        exits: [{ target: "vault", desc: "前往地窖", locked: false }],
        isActive: true,
        items: [],
        clues: [],
      },
      {
        id: "vault",
        name: "地窖",
        description: "地窖深处传来低沉的嗡鸣。",
        lighting: "dark",
        dangers: [],
        exits: [{ target: "entry", desc: "返回入口", locked: false }],
        isActive: false,
        items: [],
        clues: [],
      },
    ],
    entities: [{
      id: "entry_mi_go",
      name: "米戈",
      type: "monster",
      hp: 12,
      maxHp: 12,
      ac: 12,
      status: [],
      position: "entry",
      scene_id: "entry",
      faction: "mythos",
    }],
    displayNames: { entry: "入口", vault: "地窖" },
    aliases: { 入口: "entry", 地窖: "vault" },
    items: { entry: [], vault: [] },
    clueTexts: [],
  };
}

function sourceEntities(session: GameSession) {
  return session.world.exportSnapshot().tables.entities
    .filter((entity) => entity.type !== "pc")
    .map(({ id, name, type, hp, max_hp, ac, status, position, faction, attributes, scene_id }) => ({
      id,
      name,
      type,
      hp,
      max_hp,
      ac,
      status,
      position,
      faction,
      attributes,
      scene_id,
    }));
}

it("publicly generates a portable local-rule runtime module and restores it into a fresh ordinary session", async () => {
  const id = `generated-story-runtime-${crypto.randomUUID()}`;
  const source = createSession(id, true);
  const restored = createSession(id, false);
  try {
    const generated = await source.act("生成故事");
    expect(generated.error).toBeUndefined();

    const snapshot = JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot()));
    expect(snapshot.module.package).not.toBeNull();
    expect(snapshot.module.package.kind).toBe("runtime_module_data_legacy");
    expect(snapshot.module.package.module.runtime.sourceIdentity.description).toContain("local rule");
    expect(snapshot.module.package.module.runtime.entrySceneId).toBe(source.getState().scene);
    expect(snapshot.module.package.module.summary).toContain(snapshot.module.package.module.prologue.lines[0]);

    const beforeScenes = sourceScenes(source);
    const beforeEntities = sourceEntities(source);
    const beforeClues = snapshot.module.package.module.scenes.map((scene: { id: string; clues: unknown[] }) => ({
      id: scene.id,
      clues: scene.clues,
    }));
    const beforeItems = snapshot.state.sceneItems;
    restored.restoreOrdinarySessionSnapshot(snapshot);

    expect(sourceScenes(restored)).toEqual(beforeScenes);
    expect(sourceEntities(restored)).toEqual(beforeEntities);
    const restoredSnapshot = restored.exportOrdinarySessionSnapshot();
    expect(restoredSnapshot.module).toEqual(snapshot.module);
    expect(restoredSnapshot.state.sceneItems).toEqual(beforeItems);
    expect((restoredSnapshot.module.package as { kind: string; module: { scenes: Array<{ id: string; clues: unknown[] }> } }).module.scenes
      .map((scene) => ({ id: scene.id, clues: scene.clues }))).toEqual(beforeClues);

    const current = restored.getState().scene;
    const destination = beforeScenes.find((scene) => scene.id === current)?.exits[0]?.target;
    if (!destination) throw new Error("generated story must expose a traversable current-scene connection");
    const targetName = beforeScenes.find((scene) => scene.id === destination)?.name;
    if (!targetName) throw new Error("generated story connection target must have a display name");
    const continued = await restored.act(`前往 ${targetName}`);
    expect(continued.error).toBeUndefined();
    expect(restored.getState().scene).toBe(destination);
  } finally {
    source.close();
    restored.close();
  }
});

it("refuses a generated locked exit before any runtime host write", async () => {
  const story = generatedStoryWithExit();
  const origin = story.scenes.find((scene) => scene.exits.length > 0);
  if (!origin) throw new Error("test story must have an exit origin");
  origin.exits[0]!.locked = true;
  expect(() => generatedStoryToRuntimeModuleData(story)).toThrow("no executable gate semantics");

  const session = createSession(`generated-story-locked-${crypto.randomUUID()}`, true, { generate: () => story });
  try {
    const result = await session.act("生成故事");
    expect(result.error).toBeUndefined();
    expect(session.world.listScenes()).toEqual([]);
    expect(session.exportOrdinarySessionSnapshot().module.package).toBeNull();
  } finally {
    session.close();
  }
});

it("does not replace an already installed generated runtime module", async () => {
  // Pin the post-install world to an entry-scene Mi-Go. The second act() runs
  // its ordinary first-sighting SAN check before the generated-story conflict
  // handler, proving that dynamic turn state may change while the installed
  // package and its static host projection stay fixed.
  const story = generatedStoryWithEntryMiGo();
  let generateCalls = 0;
  const session = createSession(`generated-story-conflict-${crypto.randomUUID()}`, true, {
    generate: () => {
      generateCalls++;
      return story;
    },
  });
  try {
    await session.act("生成故事");
    const first = session.exportOrdinarySessionSnapshot();
    const firstPackage = first.module.package;
    const firstContentHash = first.module.contentHash;
    const firstStaticScenes = sourceScenes(session);
    const firstStaticEntities = sourceEntities(session);
    const firstSAN = session.getSanity().currentSAN;
    const secondResult = await session.act("生成故事");
    const second = session.exportOrdinarySessionSnapshot();
    expect(secondResult.error).toBeUndefined();
    expect(generateCalls).toBe(1);
    const refusal = secondResult.events.map((event) => event.content).join("\n");
    expect(refusal).toContain("已有已安装模组");
    expect(refusal).toContain("不能用生成故事替换");
    expect(second.module).toEqual(first.module);
    expect(second.module.package).toEqual(firstPackage);
    expect(second.module.contentHash).toBe(firstContentHash);
    expect(sourceScenes(session)).toEqual(firstStaticScenes);
    expect(sourceEntities(session)).toEqual(firstStaticEntities);
    expect(session.getSanity().currentSAN).toBeLessThan(firstSAN);
  } finally {
    session.close();
  }
});

it("rejects a rehashed generated package or static world that no longer matches its installed source", async () => {
  const id = `generated-story-tamper-${crypto.randomUUID()}`;
  const source = createSession(id, true);
  const packageTarget = createSession(id, false);
  const worldTarget = createSession(id, false);
  try {
    await source.act("生成故事");
    const snapshot = JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot()));

    const packageTamper = JSON.parse(JSON.stringify(snapshot));
    packageTamper.module.package.module.scenes[0].description = "forged generated story source";
    packageTamper.module.contentHash = ordinaryGameSessionModuleHash(packageTamper.module.package);
    const { snapshotHash: _packageSnapshotHash, ...unsignedPackageTamper } = packageTamper;
    packageTamper.snapshotHash = ordinaryGameSessionSnapshotHash(unsignedPackageTamper);
    expect(() => packageTarget.restoreOrdinarySessionSnapshot(packageTamper)).toThrow("ordinary snapshot restore failed closed");

    const worldTamper = JSON.parse(JSON.stringify(snapshot));
    worldTamper.world.tables.scenes[0].description = "forged static world";
    const { hash: _worldHash, ...unsignedWorld } = worldTamper.world;
    worldTamper.world.hash = worldStateSnapshotHash(unsignedWorld);
    const { snapshotHash: _worldSnapshotHash, ...unsignedWorldTamper } = worldTamper;
    worldTamper.snapshotHash = ordinaryGameSessionSnapshotHash(unsignedWorldTamper);
    expect(() => worldTarget.restoreOrdinarySessionSnapshot(worldTamper)).toThrow("ordinary snapshot restore failed closed");
  } finally {
    source.close();
    packageTarget.close();
    worldTarget.close();
  }
});

it("rejects malformed generated entity type and scene bindings at the conversion boundary", () => {
  const story = generatedStoryWithExit();
  const entity = story.entities[0];
  if (!entity) throw new Error("test story must include an entity");

  const invalidType: unknown = {
    ...story,
    entities: [{ ...entity, type: "beast" }, ...story.entities.slice(1)],
  };
  expect(() => generatedStoryToRuntimeModuleData(invalidType)).toThrow("type must be npc or monster");

  const invalidSceneBinding: unknown = {
    ...story,
    entities: [{ ...entity, position: "missing_scene", scene_id: "missing_scene" }, ...story.entities.slice(1)],
  };
  expect(() => generatedStoryToRuntimeModuleData(invalidSceneBinding)).toThrow("does not have one declared scene binding");
});

it("public generation namespaces hostile source IDs before they can overwrite p1 or a built-in clue", async () => {
  const story = generatedStoryWithExit();
  const entity = story.entities[0];
  const clue = story.clueTexts[0];
  if (!entity || !clue) throw new Error("test story must include an entity and clue");
  const originalClueId = clue.id;
  entity.id = "p1";
  clue.id = "spot_hidden";
  for (const scene of story.scenes) {
    scene.clues = scene.clues.map((id) => id === originalClueId ? "spot_hidden" : id);
  }

  const session = createSession(`generated-story-source-namespace-${crypto.randomUUID()}`, true, { generate: () => story });
  const investigation = (session as unknown as { investigation: { getClueMatchInfo(id: string): unknown } }).investigation;
  try {
    const beforeBuiltInClue = investigation.getClueMatchInfo("spot_hidden");
    const result = await session.act("生成故事");
    expect(result.error).toBeUndefined();
    expect(session.world.getEntity("p1")?.type).toBe("pc");
    expect(investigation.getClueMatchInfo("spot_hidden")).toEqual(beforeBuiltInClue);

    const snapshot = session.exportOrdinarySessionSnapshot();
    const module = snapshot.module.package;
    if (!module || module.kind !== "runtime_module_data_legacy") throw new Error("generated package is missing");
    expect(module.module.npcs.some((npc) => npc.runtime?.sourceId === "p1")).toBe(false);
    expect(module.module.scenes.flatMap((scene) => scene.clues).some((entry) => entry.id === "spot_hidden")).toBe(false);
  } finally {
    session.close();
  }
});

it("rejects accessor and sparse generated values before the public act path writes a host", async () => {
  const accessorStory = generatedStoryWithExit();
  Object.defineProperty(accessorStory, "title", {
    get: () => "accessor title",
    enumerable: true,
    configurable: true,
  });
  expect(() => generatedStoryToRuntimeModuleData(accessorStory)).toThrow("data property");

  const session = createSession(`generated-story-accessor-${crypto.randomUUID()}`, true, { generate: () => accessorStory });
  try {
    const result = await session.act("生成故事");
    expect(result.error).toBeUndefined();
    expect(session.world.listScenes()).toEqual([]);
    expect(session.world.getEntity("p1")?.type).toBe("pc");
  } finally {
    session.close();
  }

  const sparseStory = generatedStoryWithExit();
  delete sparseStory.scenes[0];
  expect(() => generatedStoryToRuntimeModuleData(sparseStory)).toThrow("sparse");
});

it("fails stopped rather than publishing a partial story when an existing runtime host write fails", async () => {
  const session = createSession(`generated-story-host-failure-${crypto.randomUUID()}`, true);
  const original = WorldStateManager.prototype.setSceneEnvironment;
  WorldStateManager.prototype.setSceneEnvironment = function failGeneratedStoryInstall() {
    throw new Error("simulated scene environment write failure");
  };
  try {
    await expect(session.act("生成故事")).rejects.toThrow("generated story installation failed closed");
    expect(() => session.exportOrdinarySessionSnapshot()).toThrow("closed GameSession cannot be exported");
    await expect(session.act("查看状态")).rejects.toThrow("GameSession is unavailable after a prior action failure");
  } finally {
    WorldStateManager.prototype.setSceneEnvironment = original;
    session.close();
  }
});

it("uses the constructor-selected story generator after a same-name runtime shadow", async () => {
  const canonical = generatedStoryWithExit();
  canonical.title = "canonical generated story";
  const forged = generatedStoryWithExit();
  forged.title = "forged generated story";
  const session = createSession(
    `generated-story-runtime-authority-${crypto.randomUUID()}`,
    true,
    { generate: () => canonical },
  );
  try {
    expect(Reflect.set(session as unknown as Record<string, unknown>, "storyGenerator", {
      generate: () => forged,
    })).toBe(true);

    const result = await session.act("\u751f\u6210\u6545\u4e8b");
    expect(result.error).toBeUndefined();
    const packageValue = session.exportOrdinarySessionSnapshot().module.package;
    if (!packageValue || packageValue.kind !== "runtime_module_data_legacy") {
      throw new Error("generated story runtime package is missing");
    }
    expect(packageValue.module.title).toBe(canonical.title);
    expect(packageValue.module.title).not.toBe(forged.title);
  } finally {
    session.close();
  }
});
