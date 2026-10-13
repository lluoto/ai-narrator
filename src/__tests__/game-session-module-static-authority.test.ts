import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { BARN_OF_PREMIER } from "../module/barn-of-premier";

const BARN_COMMAND = "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3";
const ARKHAM_COMMAND = "\u52a0\u8f7d\u6a21\u7ec4 \u963f\u5361\u59c6\u6863\u6848\u9986";
const LEAVE_COMMAND = "\u6211\u4eec\u51b3\u5b9a\u79bb\u5f00\u8fd9\u91cc\uff0c\u7ed3\u675f\u8fd9\u6b21\u8c03\u67e5";
const CONFIRM_COMMAND = "\u786e\u5b9a";
const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;
const OFFLINE_CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function createCareerRoot(): string {
  return mkdtempSync(join(tmpdir(), "game-session-module-static-authority-"));
}

function cleanupFixture(careerRoot: string, ...sessions: GameSession[]): void {
  let closeError: unknown;
  for (const session of sessions) {
    try {
      session.close();
    } catch (error) {
      closeError ??= error;
    }
  }
  try {
    rmSync(careerRoot, { recursive: true, force: true });
  } finally {
    if (closeError !== undefined) throw closeError;
  }
}

function durableFixtureSession(session: GameSession): GameSession {
  return new Proxy(session, {
    get(target, property) {
      if (property === "act") {
        return (input: string, pcId?: string) => runOrdinaryDurableActionTransaction(
          target,
          durableCareerHostCapability,
          async (act) => act(input, pcId),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function fresh(id: string, careerRoot: string, withCharacter = false): GameSession {
  return durableFixtureSession(new GameSession(
    id,
    "cosmic-horror",
    OFFLINE_CONFIG,
    withCharacter ? "detective" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined,
    { careerRoot },
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: durableCareerHostCapability },
  ));
}

async function loadBarn(session: GameSession): Promise<void> {
  const result = await session.act(BARN_COMMAND);
  expect(result.error).toBeUndefined();
  expect(session.exportOrdinarySessionSnapshot().module.package).not.toBeNull();
}

function fakeStatics() {
  return {
    sceneDisplayNames: { forged_scene: "forged display" },
    sceneAliases: { forged_scene: ["forged alias"] },
    sceneBgm: { forged_scene: "forged-bgm" },
    registeredModules: [BARN_OF_PREMIER],
    moduleItemDescriptions: new Map([["forged-item", "forged description"]]),
    moduleKpNotes: new Map([["forged-note", "forged note"]]),
    moduleRewards: new Map([["forged-reward", { id: "forged-reward", description: "forged" }]]),
    _loadedModules: new Map([[BARN_OF_PREMIER.id, true]]),
  };
}

function definePublicShadows(session: GameSession, values = fakeStatics()): void {
  Object.defineProperties(session, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  }])));
}

test("public module identity shadows cannot fabricate an installed module, departure, or ordinary package", async () => {
  const careerRoot = createCareerRoot();
  const session = fresh(`module-static-fake-${crypto.randomUUID()}`, careerRoot);
  try {
    // Both assignment and a property descriptor are ordinary caller writes;
    // neither can create an install that the package boundary never performed.
    Reflect.set(session, "registeredModules", [BARN_OF_PREMIER]);
    Object.defineProperty(session, "_loadedModules", { configurable: true, writable: true, value: new Map([[BARN_OF_PREMIER.id, true]]) });

    expect(session.exportOrdinarySessionSnapshot().module).toEqual({ package: null, contentHash: null });
    const leave = await session.act(LEAVE_COMMAND);
    expect(leave.narrative).not.toContain("\u786e\u5b9a\u8981\u79bb\u5f00");
    expect(session.getOrdinaryTerminal()).toBeNull();
  } finally {
    cleanupFixture(careerRoot, session);
  }
});

test("public module identity shadows cannot disable a real departure or its settlement", async () => {
  const careerRoot = createCareerRoot();
  const session = fresh(`module-static-real-${crypto.randomUUID()}`, careerRoot, true);
  const originalRandom = Math.random;
  try {
    await loadBarn(session);
    Math.random = () => 0;
    expect((await session.act("\u8c03\u67e5")).error).toBeUndefined();
    expect(session.skillGrowthMarks.length).toBeGreaterThan(0);
    Math.random = () => 0.99;

    Object.defineProperty(session, "registeredModules", { configurable: true, writable: true, value: [] });
    Reflect.set(session, "_loadedModules", new Map());
    const leave = await session.act(LEAVE_COMMAND);
    expect(leave.events.some((event) => event.content.includes("\u786e\u5b9a\u8981\u79bb\u5f00"))).toBe(true);
    expect((await session.act(CONFIRM_COMMAND)).terminal).toMatchObject({ kind: "module_departure" });
    expect(session.careerStore?.getEntries("Ada")).toHaveLength(1);
  } finally {
    Math.random = originalRandom;
    cleanupFixture(careerRoot, session);
  }
});

test("public scene static shadows cannot reroute navigation, presentation, BGM, or the ordinary snapshot", async () => {
  const careerRoot = createCareerRoot();
  const session = fresh(`module-static-scene-${crypto.randomUUID()}`, careerRoot, true);
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("static-authority fixture must stay offline");
  }) as unknown as typeof fetch;
  try {
    await loadBarn(session);
    const before = session.exportOrdinarySessionSnapshot();
    const currentScene = session.getState().scene;
    const currentBgm = session.getState().bgm;
    const targetScene = Object.keys(before.state.sceneDisplayNames).find((id) => id !== currentScene);
    if (!targetScene) throw new Error("Barn fixture requires a second canonical scene");

    Object.defineProperties(session, {
      sceneDisplayNames: { configurable: true, writable: true, value: { [currentScene]: "forged current", [targetScene]: "forged target" } },
      sceneAliases: { configurable: true, writable: true, value: { [targetScene]: ["forged route"] } },
      sceneBgm: { configurable: true, writable: true, value: { [currentScene]: "forged-bgm" } },
    });
    await session.act("\u524d\u5f80 forged route");

    expect(session.getState().scene).toBe(currentScene);
    expect(session.getDisplayedScene()).toBe(before.state.sceneDisplayNames[currentScene] ?? currentScene);
    expect(session.getState().bgm).toBe(currentBgm);
    const after = session.exportOrdinarySessionSnapshot();
    expect(after.state.sceneDisplayNames).toEqual(before.state.sceneDisplayNames);
    expect(after.state.sceneAliases).toEqual(before.state.sceneAliases);
    expect(after.state.sceneBgm).toEqual(before.state.sceneBgm);
    expect(fetchCalls).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
    cleanupFixture(careerRoot, session);
  }
});

test("public item, KP-note, and reward shadows cannot forge package static authority", async () => {
  const id = `module-static-metadata-${crypto.randomUUID()}`;
  const careerRoot = createCareerRoot();
  const session = fresh(id, careerRoot, true);
  const restored = fresh(id, careerRoot);
  try {
    await loadBarn(session);
    const before = session.exportOrdinarySessionSnapshot();
    Object.defineProperties(session, {
      moduleItemDescriptions: { configurable: true, writable: true, value: new Map([["forged-item", "forged description"]]) },
      moduleKpNotes: { configurable: true, writable: true, value: new Map([["forged-note", "forged note"]]) },
      moduleRewards: { configurable: true, writable: true, value: new Map([["forged-reward", { id: "forged-reward", description: "forged" }]]) },
    });
    const after = session.exportOrdinarySessionSnapshot();
    expect(after.state.moduleItemDescriptions).toEqual(before.state.moduleItemDescriptions);
    expect(after.state.moduleKpNotes).toEqual(before.state.moduleKpNotes);
    expect(after.state.moduleRewards).toEqual(before.state.moduleRewards);
    expect(() => restored.restoreOrdinarySessionSnapshot(after)).not.toThrow();
  } finally {
    cleanupFixture(careerRoot, session, restored);
  }
});

test("same-name public shadows do not contaminate a pristine ordinary restore target", async () => {
  const id = `module-static-restore-${crypto.randomUUID()}`;
  const careerRoot = createCareerRoot();
  const source = fresh(id, careerRoot, true);
  const target = fresh(id, careerRoot);
  try {
    await loadBarn(source);
    const snapshot = source.exportOrdinarySessionSnapshot();
    definePublicShadows(target);
    expect(() => target.restoreOrdinarySessionSnapshot(snapshot)).not.toThrow();
    const restored = target.exportOrdinarySessionSnapshot();
    expect(restored.module).toEqual(snapshot.module);
    expect(restored.state.sceneDisplayNames).toEqual(snapshot.state.sceneDisplayNames);
    expect(restored.state.moduleRewards).toEqual(snapshot.state.moduleRewards);
  } finally {
    cleanupFixture(careerRoot, source, target);
  }
});

test("public loaded-module shadows cannot block a first install, while a real duplicate remains refused", async () => {
  const careerRoot = createCareerRoot();
  const session = fresh(`module-static-install-${crypto.randomUUID()}`, careerRoot, true);
  try {
    definePublicShadows(session);
    await loadBarn(session);
    const installed = session.exportOrdinarySessionSnapshot().module;
    expect(installed.package).not.toBeNull();
    expect(session.world.getScene("\u7ef4\u4fee\u95f4")).toBeDefined();

    const duplicate = await session.act(ARKHAM_COMMAND);
    expect(duplicate.error).toBeUndefined();
    expect(session.exportOrdinarySessionSnapshot().module).toEqual(installed);
  } finally {
    cleanupFixture(careerRoot, session);
  }
});
