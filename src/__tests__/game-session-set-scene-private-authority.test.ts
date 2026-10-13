import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const LOAD_BARN = "加载模组 普瑞米尔的谷仓";
const BARN_ENTRY = "特里坎家";
const BARN_BAR = "维森酒吧";
const FREE_SCENE = "自由港";

type SceneShadow = (sceneId: string) => boolean;

function fresh(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Scene Authority Tester");
}

async function barnSession(id: string): Promise<GameSession> {
  const session = fresh(id);
  const response = await session.act(LOAD_BARN);
  expect(response.error).toBeUndefined();
  expect(session.getState().scene).toBe(BARN_ENTRY);
  return session;
}

function expectSceneFacts(session: GameSession, sceneId: string): void {
  expect(session.getState().scene).toBe(sceneId);
  expect(session.world.getCurrentState().scene).toBe(sceneId);
  expect(session.world.getEntity("p1")?.position).toBe(sceneId);
  expect(session.world.isSceneVisitedBy("p1", sceneId)).toBe(true);
}

function installOwnSetSceneShadow(session: GameSession, shadow: SceneShadow): void {
  Object.defineProperty(session, "setScene", { configurable: true, value: shadow });
}

function callSetSceneDecoy(session: GameSession, sceneId: string): boolean {
  const decoy = Reflect.get(session, "setScene");
  if (typeof decoy !== "function") throw new Error("setScene decoy was not installed");
  return decoy.call(session, sceneId) as boolean;
}

async function withPrototypeSetSceneShadow<T>(shadow: SceneShadow, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(GameSession.prototype, "setScene");
  expect(original).toBeUndefined();
  Object.defineProperty(GameSession.prototype, "setScene", { configurable: true, writable: true, value: shadow });
  try {
    return await run();
  } finally {
    delete (GameSession.prototype as unknown as Record<string, unknown>).setScene;
  }
}

it("publishes no setScene writer and keeps an own fake-true decoy out of a real Barn act move", async () => {
  const session = await barnSession(`set-scene-own-true-${crypto.randomUUID()}`);
  try {
    expect(Object.getOwnPropertyDescriptor(GameSession.prototype, "setScene")).toBeUndefined();
    expect(Reflect.get(session, "setScene")).toBeUndefined();
    installOwnSetSceneShadow(session, () => true);

    // A consumer can manufacture a same-name property, but it is not a writer.
    expect(callSetSceneDecoy(session, BARN_BAR)).toBe(true);
    expect(session.world.getCurrentState().scene).toBe(BARN_ENTRY);

    const response = await session.act(`前往${BARN_BAR}`);
    expect(response.error).toBeUndefined();
    expect(response.state.scene).toBe(BARN_BAR);
    expectSceneFacts(session, BARN_BAR);
  } finally {
    session.close();
  }
});

it("keeps an own fake-false setScene decoy out of ordinary free movement", async () => {
  const session = fresh(`set-scene-own-false-${crypto.randomUUID()}`);
  try {
    installOwnSetSceneShadow(session, () => false);

    const response = await session.act(`去${FREE_SCENE}`);
    expect(response.error).toBeUndefined();
    expect(response.events.some((event) => event.content.includes(`你移动到了场景: ${FREE_SCENE}`))).toBe(true);
    expect(response.state.scene).toBe(FREE_SCENE);
    expectSceneFacts(session, FREE_SCENE);

    expect(callSetSceneDecoy(session, FREE_SCENE)).toBe(false);
  } finally {
    session.close();
  }
});

it("keeps an own throwing setScene decoy out of compiled load synchronization", async () => {
  const fixture = await compiledModuleHttpFixture(`set-scene-own-throw-${crypto.randomUUID()}`);
  const session = fresh(`set-scene-own-throw-${crypto.randomUUID()}`);
  try {
    installOwnSetSceneShadow(session, () => { throw new Error("forged own setScene"); });
    expect(() => callSetSceneDecoy(session, "forged")).toThrow("forged own setScene");

    const loaded = session.loadCompiledModule(fixture.resolved.artifact.payload as ResolvedCompilerArtifactPayload, fixture.projection);
    expect(loaded.status).toBe("loaded");
    const currentSceneId = session.getCompiledMechanicsState()?.state.currentSceneId;
    expect(currentSceneId).toBeDefined();
    expectSceneFacts(session, currentSceneId!);
  } finally {
    session.close();
  }
});

it("keeps a prototype fake-true setScene decoy out of a real Barn act move", async () => {
  await withPrototypeSetSceneShadow(() => true, async () => {
    const session = await barnSession(`set-scene-prototype-true-${crypto.randomUUID()}`);
    try {
      expect(callSetSceneDecoy(session, BARN_BAR)).toBe(true);
      expect(session.world.getCurrentState().scene).toBe(BARN_ENTRY);

      const response = await session.act(`前往${BARN_BAR}`);
      expect(response.error).toBeUndefined();
      expect(response.state.scene).toBe(BARN_BAR);
      expectSceneFacts(session, BARN_BAR);
    } finally {
      session.close();
    }
  });
});

it("keeps a prototype fake-false setScene decoy out of ordinary free movement", async () => {
  await withPrototypeSetSceneShadow(() => false, async () => {
    const session = fresh(`set-scene-prototype-false-${crypto.randomUUID()}`);
    try {
      const response = await session.act(`去${FREE_SCENE}`);
      expect(response.error).toBeUndefined();
      expect(response.events.some((event) => event.content.includes(`你移动到了场景: ${FREE_SCENE}`))).toBe(true);
      expect(response.state.scene).toBe(FREE_SCENE);
      expectSceneFacts(session, FREE_SCENE);
      expect(callSetSceneDecoy(session, FREE_SCENE)).toBe(false);
    } finally {
      session.close();
    }
  });
});

it("keeps a prototype throwing setScene decoy out of compiled restore synchronization", async () => {
  const root = mkdtempSync(join(tmpdir(), "set-scene-private-authority-"));
  let source: GameSession | undefined;
  let target: GameSession | undefined;
  try {
    const host = createCompiledDurableTestHost();
    const fixture = await compiledModuleHttpFixture(`set-scene-prototype-throw-${crypto.randomUUID()}`);
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
    if (saved.status !== "ok") throw new Error(saved.message);
    const bundle = catalog.loadBundle(saved.value.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);

    source = new GameSession(`set-scene-prototype-restore-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Scene Authority Tester", undefined, undefined, undefined, undefined, host.runtimeDependencies);
    expect(source.loadDurableCompiledModule(bundle.value).status).toBe("loaded");
    const snapshot = host.snapshot(source);
    target = new GameSession(source.id, "cosmic-horror", CONFIG, undefined, undefined, undefined, undefined, undefined, undefined, host.runtimeDependencies);

    await withPrototypeSetSceneShadow(() => { throw new Error("forged prototype setScene"); }, async () => {
      expect(() => callSetSceneDecoy(target!, "forged")).toThrow("forged prototype setScene");
      const restored = target!.restoreCompiledSession(snapshot, bundle.value);
      expect(restored.status).toBe("loaded");
      const currentSceneId = target!.getCompiledMechanicsState()?.state.currentSceneId;
      expect(currentSceneId).toBeDefined();
      expectSceneFacts(target!, currentSceneId!);
    });
  } finally {
    target?.close();
    source?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
