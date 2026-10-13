import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { isolatedProviderSeamIt } from "./helpers/provider-seam-child";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { WorldModelLoader } from "../world/world-model-loader";

const CAPTURE_CONFIG = {
  apiKey: "test-world-model-facade",
  baseUrl: "http://local.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};
const BARN_COMMAND = "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3";

const sessions: GameSession[] = [];
const LOADER_READ_KEYS = [
  "getAll", "getBehaviors", "getByNovel", "getByNovelAndType", "getByType",
  "getDndMappings", "getDndRules", "getFactionRelations", "getMechanics",
  "getNovelNames", "getNovelStats", "getStats", "getTypeNames", "isLoaded",
  "queryBehavior", "queryCausal", "randomCausal", "search",
].sort();

function own(session: GameSession): GameSession {
  sessions.push(session);
  return session;
}

afterEach(() => {
  const closing = sessions.splice(0);
  let failure: unknown;
  for (const session of closing) {
    try { session.close(); } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
});

function fixtureLoaders(root: string): { world: WorldModelLoader; cthulhu: WorldModelLoader } {
  const worldPath = join(root, "world.jsonl");
  const cthulhuPath = join(root, "cthulhu.jsonl");
  writeFileSync(worldPath, [
    {
      type: "faction_relation",
      chapter: "1",
      novel: "facade-work",
      name: "canonical relation",
      description: "\u7279\u91cc\u574e\u5bb6",
      properties: { nested: "immutable" },
    },
    {
      type: "causal",
      chapter: "1",
      novel: "facade-work",
      name: "canonical event",
      description: "\u7279\u91cc\u574e\u5bb6",
      cause: "canonical cause",
      effect: "canonical effect",
      mechanism: "canonical mechanism",
    },
  ].map((row) => JSON.stringify(row)).join("\n"), "utf8");
  writeFileSync(cthulhuPath, JSON.stringify({
    type: "deity",
    chapter: "1",
    novel: "facade-work",
    name: "canonical deity",
    mechanic: "canonical-mechanic",
  }), "utf8");
  const world = new WorldModelLoader();
  const cthulhu = new WorldModelLoader();
  world.load(worldPath);
  cthulhu.load(cthulhuPath);
  return { world, cthulhu };
}

/** Two entirely local works let a recovery target prove it selected neither source nor fallback scope. */
function scopedFixtureLoaders(root: string, prefix: string): { world: WorldModelLoader; cthulhu: WorldModelLoader } {
  const worldPath = join(root, `${prefix}-world.jsonl`);
  const cthulhuPath = join(root, `${prefix}-cthulhu.jsonl`);
  writeFileSync(worldPath, [
    {
      type: "faction_relation", chapter: "1", novel: "work-a",
      name: "scope-a relation", description: "scope-a description",
      properties: { source: "work-a" },
    },
    {
      type: "causal", chapter: "1", novel: "work-a",
      name: "scope-a event", description: "scope-a description",
      cause: "scope-a cause", effect: "scope-a effect", mechanism: "scope-a mechanism",
    },
    {
      type: "faction_relation", chapter: "1", novel: "work-b",
      name: "scope-b relation", description: "scope-b description",
      properties: { source: "work-b" },
    },
    {
      type: "causal", chapter: "1", novel: "work-b",
      name: "scope-b event", description: "scope-b description",
      cause: "scope-b cause", effect: "scope-b effect", mechanism: "scope-b mechanism",
    },
  ].map((row) => JSON.stringify(row)).join("\n"), "utf8");
  writeFileSync(cthulhuPath, [
    { type: "deity", chapter: "1", novel: "work-a", name: "scope-a deity", mechanic: "scope-a mechanic" },
    { type: "deity", chapter: "1", novel: "work-b", name: "scope-b deity", mechanic: "scope-b mechanic" },
  ].map((row) => JSON.stringify(row)).join("\n"), "utf8");
  const world = new WorldModelLoader();
  const cthulhu = new WorldModelLoader();
  world.load(worldPath);
  cthulhu.load(cthulhuPath);
  return { world, cthulhu };
}

async function captureKpSystemText<T>(run: () => Promise<T>): Promise<{ value: T; systemText: string }> {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ messages?: Array<{ role?: unknown; content?: unknown }> }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("KP request body was not text");
    requests.push(JSON.parse(init.body) as { messages?: Array<{ role?: unknown; content?: unknown }> });
    return new Response(JSON.stringify({ choices: [{ message: { content: "local capture" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const value = await run();
    expect(requests).toHaveLength(1);
    const systemText = (requests[0]?.messages ?? [])
      .filter((message) => message.role === "system" && typeof message.content === "string")
      .map((message) => message.content as string)
      .join("\n");
    return { value, systemText };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function observeLoaderReads(loader: WorldModelLoader, label: string, reads: string[]): void {
  const isLoaded = loader.isLoaded.bind(loader);
  const getByNovel = loader.getByNovel.bind(loader);
  const getAll = loader.getAll.bind(loader);
  loader.isLoaded = () => { reads.push(`${label}.isLoaded`); return isLoaded(); };
  loader.getByNovel = (novel) => { reads.push(`${label}.getByNovel:${novel}`); return getByNovel(novel); };
  loader.getAll = () => { reads.push(`${label}.getAll`); return getAll(); };
}

const ordinaryHttpAuthenticator: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { role: "keeper", id: "ordinary-world-model-owner" },
});

async function ordinaryHttpRequest(
  root: string,
  dependencies: SessionRuntimeDependencies,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return handleRequest(new Request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), undefined, undefined, {
    careerRoot: join(root, "careers"),
    sessionRoot: join(root, "sessions"),
  }, {}, {}, ordinaryHttpAuthenticator, undefined, undefined, undefined, { mode: "required" }, dependencies);
}

async function captureOpeningContext(open: () => Promise<unknown>): Promise<string> {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ messages?: Array<{ role?: unknown; content?: unknown }> }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("KP request body was not text");
    requests.push(JSON.parse(init.body) as { messages?: Array<{ role?: unknown; content?: unknown }> });
    return new Response(JSON.stringify({ choices: [{ message: { content: "local capture" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await open();
  } finally {
    globalThis.fetch = previousFetch;
  }
  expect(requests).toHaveLength(1);
  const merged = (requests[0]?.messages ?? [])
    .filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => message.content as string)
    .join("\n");
  const directive = merged.lastIndexOf("\n叙事风格: standard");
  if (directive < 0) throw new Error("capture omitted KP directive boundary");
  const end = merged.indexOf("\n", directive + 1);
  return merged.slice(end < 0 ? merged.length : end + 1).trim();
}

const providerSeamIt = isolatedProviderSeamIt("src/__tests__/game-session-world-model-read-facade.test.ts");

describe("GameSession world-model read facades", () => {
  it("publishes only stable frozen prototype observation facades", () => {
    const session = own(new GameSession("world-facade-shape", "cosmic-horror", CAPTURE_CONFIG));
    for (const key of ["worldModel", "wmIntegrator", "cthulhuLoader"] as const) {
      expect(Object.hasOwn(session, key)).toBe(false);
      const descriptor = Object.getOwnPropertyDescriptor(GameSession.prototype, key);
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.set).toBeUndefined();
      const facade = session[key] as any;
      expect(facade).toBe(session[key]);
      expect(Object.isFrozen(facade)).toBe(true);
      if (key === "wmIntegrator") {
        expect(Object.keys(facade).sort()).toEqual(["buildInjection", "buildKPContext", "getNPCGuidance", "getRuleHints"]);
      } else {
        expect(Object.keys(facade).sort()).toEqual(LOADER_READ_KEYS);
      }
    }
  });

  it("does not publish raw loader mutation, rebinding, or writable result aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "game-session-world-facade-"));
    try {
      const { world, cthulhu } = fixtureLoaders(root);
      const session = own(new GameSession(
        "world-facade-reads", "cosmic-horror", CAPTURE_CONFIG,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { worldModelNovel: "facade-work", worldModelLoader: world, cthulhuWorldModelLoader: cthulhu } as any,
      ));
      const model = session.worldModel as any;
      const cthulhuModel = session.cthulhuLoader as any;
      expect(Object.keys(model).sort()).toEqual(LOADER_READ_KEYS);
      expect(Object.keys(cthulhuModel).sort()).toEqual(LOADER_READ_KEYS);
      for (const forbidden of ["load", "consumeCausal", "clear", "entries", "byNovel", "raw"]) {
        expect(model[forbidden]).toBeUndefined();
        expect(cthulhuModel[forbidden]).toBeUndefined();
      }
      const entries = model.getByNovel("facade-work");
      expect(Object.isFrozen(entries)).toBe(true);
      expect(Object.isFrozen(entries[0])).toBe(true);
      expect(Object.isFrozen(entries[0].properties)).toBe(true);
      expect(() => { (entries as any).push("mutation"); }).toThrow();
      expect(() => { (entries[0].properties as any).nested = "mutation"; }).toThrow();
      const stats = model.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(Object.isFrozen(stats.byNovel)).toBe(true);
      expect(() => { (stats.byNovel as any).facadeWork = 99; }).toThrow();
      const cthulhuEntries = cthulhuModel.getByNovel("facade-work");
      expect(Object.isFrozen(cthulhuEntries)).toBe(true);
      expect(Object.isFrozen(cthulhuEntries[0])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detaches and freezes pure integrator output", () => {
    const root = mkdtempSync(join(tmpdir(), "game-session-integrator-facade-"));
    try {
      const { world, cthulhu } = fixtureLoaders(root);
      const session = own(new GameSession(
        "world-facade-integrator", "cosmic-horror", CAPTURE_CONFIG,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { worldModelNovel: "facade-work", worldModelLoader: world, cthulhuWorldModelLoader: cthulhu } as any,
      ));
      const ctx = { sceneId: "scene", sceneName: "scene", keywords: ["facade-keyword"], presentNPCs: [], discoveredClues: [], round: 0, activeNovel: "facade-work" };
      const output = (session.wmIntegrator as any).buildInjection(ctx);
      expect(Object.isFrozen(output)).toBe(true);
      expect(Object.isFrozen(output.npcBehaviorHints)).toBe(true);
      expect(Object.isFrozen(output.availableEvents)).toBe(true);
      expect(Object.isFrozen(output.availableEvents[0])).toBe(true);
      expect(Object.isFrozen(output.dndRuleHints)).toBe(true);
      expect(() => { output.availableEvents.push({}); }).toThrow();
      expect(() => { output.availableEvents[0].cause = "mutation"; }).toThrow();
      expect((session.wmIntegrator as any).buildInjection(ctx)).not.toBe(output);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  providerSeamIt("uses constructor-injected canonical loaders even if public getters are reflectively masked", async () => {
    const root = mkdtempSync(join(tmpdir(), "game-session-world-canonical-"));
    try {
      const { world, cthulhu } = fixtureLoaders(root);
      const session = own(new GameSession(
        "world-facade-canonical", "cosmic-horror", CAPTURE_CONFIG,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { worldModelNovel: "facade-work", worldModelLoader: world, cthulhuWorldModelLoader: cthulhu } as any,
      ));
      expect((await session.act(BARN_COMMAND)).error).toBeUndefined();
      expect(session.getDisplayedScene()).toBe("\u7279\u91cc\u574e\u5bb6");
      for (const key of ["worldModel", "wmIntegrator", "cthulhuLoader"]) {
        Object.defineProperty(session, key, {
          configurable: true,
          value: { isLoaded: () => { throw new Error(`${key} mask was observed`); } },
        });
      }
      const context = await captureOpeningContext(() => session.getOpeningScene());
      expect(context).toContain("canonical relation");
      expect(context).toContain("canonical deity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  providerSeamIt("does not let a same-name runtime shadow enable or switch the host-selected legacy novel scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "game-session-world-scope-shadow-"));
    try {
      const { world, cthulhu } = fixtureLoaders(root);
      const disabled = own(new GameSession(
        "world-scope-shadow-disabled", "cosmic-horror", CAPTURE_CONFIG,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { worldModelLoader: world, cthulhuWorldModelLoader: cthulhu } as any,
      ));
      const enabled = own(new GameSession(
        "world-scope-shadow-enabled", "cosmic-horror", CAPTURE_CONFIG,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { worldModelNovel: "facade-work", worldModelLoader: world, cthulhuWorldModelLoader: cthulhu } as any,
      ));
      for (const session of [disabled, enabled]) {
        expect((await session.act(BARN_COMMAND)).error).toBeUndefined();
        expect(session.getDisplayedScene()).toBe("\u7279\u91cc\u574e\u5bb6");
      }
      Object.defineProperty(disabled, "worldModelNovel", {
        configurable: true,
        value: "facade-work",
      });
      Object.defineProperty(enabled, "worldModelNovel", {
        configurable: true,
        value: "forged-work",
      });

      const disabledContext = await captureOpeningContext(() => disabled.getOpeningScene());
      const enabledContext = await captureOpeningContext(() => enabled.getOpeningScene());
      expect(disabledContext).not.toContain("canonical relation");
      expect(enabledContext).toContain("canonical relation");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  providerSeamIt("drops a trusted ordinary work scope at durable HTTP recovery instead of reading source or fallback loaders", async () => {
    const root = mkdtempSync(join(tmpdir(), "ordinary-world-model-recovery-"));
    const sourceLoaders = scopedFixtureLoaders(root, "source");
    const recoveryLoaders = scopedFixtureLoaders(root, "recovery");
    const recoveryReads: string[] = [];
    observeLoaderReads(recoveryLoaders.world, "v18", recoveryReads);
    observeLoaderReads(recoveryLoaders.cthulhu, "cthulhu", recoveryReads);
    const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "sessions", "ordinary-snapshots") });
    const intentClient = { chat: async () => JSON.stringify({ action: "unknown" }) };
    const firstRegistry = new Map<string, GameSession>();
    const first: SessionRuntimeDependencies = {
      registry: firstRegistry,
      ordinarySnapshots: snapshots,
      ordinaryIntentPolicy: "required",
      ordinarySessionIntentClient: intentClient,
      // This is the only trusted source selection in the test. It is host
      // wiring, not a request field, and its scope is intentionally absent
      // from the restart factory below.
      createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, sessionIntentClient, runtimeDependencies }) => new GameSession(
        id, ruleset, CAPTURE_CONFIG, archetypeId, characterName, persona, storage, access, intentPolicy,
        {
          ...runtimeDependencies,
          ...(sessionIntentClient ? { sessionIntentClient } : {}),
          worldModelNovel: "work-a",
          worldModelLoader: sourceLoaders.world,
          cthulhuWorldModelLoader: sourceLoaders.cthulhu,
        },
      ),
    };
    const restartedRegistry = new Map<string, GameSession>();
    const restarted: SessionRuntimeDependencies = {
      registry: restartedRegistry,
      ordinarySnapshots: snapshots,
      ordinaryIntentPolicy: "required",
      ordinarySessionIntentClient: intentClient,
      // Production recovery gets a fresh constructor. Deliberately give it
      // both fixture works only as references: without an explicit trusted
      // scope it must not even observe either loader.
      createOrdinaryRecoverySession: ({ id, access, storage, intentPolicy, sessionIntentClient, runtimeDependencies }) => new GameSession(
        id, "cosmic-horror", CAPTURE_CONFIG, undefined, undefined, undefined, storage, access, intentPolicy,
        {
          ...runtimeDependencies,
          ...(sessionIntentClient ? { sessionIntentClient } : {}),
          worldModelLoader: recoveryLoaders.world,
          cthulhuWorldModelLoader: recoveryLoaders.cthulhu,
        },
      ),
    };
    try {
      const created = await captureKpSystemText(() => ordinaryHttpRequest(root, first, "/api/sessions", {
        archetype: "detective", characterName: "Ada",
      }));
      expect(created.value.status).toBe(201);
      expect(created.systemText).toContain("当前世界观: work-a");
      expect(created.systemText).toContain("scope-a deity");
      expect(created.systemText).not.toContain("scope-b relation");
      const id = (await created.value.json() as { sessionId: string }).sessionId;
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 0 } });
      const persisted = snapshots.read(id);
      if (persisted.status !== "ok") throw new Error("ordinary source envelope was not persisted");
      expect(JSON.stringify(persisted.value.snapshot)).not.toContain("work-a");
      expect(JSON.stringify(persisted.value.snapshot)).not.toContain("scope-a relation");

      // Simulate the old host process exiting. The next HTTP request must
      // hydrate only from the persisted envelope and the new host factory.
      for (const session of firstRegistry.values()) session.close();
      firstRegistry.clear();

      const continued = await captureKpSystemText(() => ordinaryHttpRequest(root, restarted, `/api/sessions/${id}/action`, {
        input: "凝视未被证实的远方回声",
        actionId: "ordinary-world-model-recovery-0001",
        expectedGeneration: 0,
      }));
      expect(continued.value.status).toBe(200);
      // KPAgent emits the legacy model text only when it is nonempty. This
      // prompt therefore proves the recovered context was empty rather than
      // merely containing an empty/unknown bucket projection.
      expect(continued.systemText).not.toContain("scope-a relation");
      expect(continued.systemText).not.toContain("scope-a deity");
      expect(continued.systemText).not.toContain("scope-b relation");
      expect(continued.systemText).not.toContain("scope-b deity");
      expect(recoveryReads).toEqual([]);
      expect(snapshots.read(id)).toMatchObject({ status: "ok", value: { generation: 1 } });
      expect(restartedRegistry.get(id)?.getOrdinaryDurableIdentity()).toMatchObject({ generation: 1 });
    } finally {
      for (const session of firstRegistry.values()) session.close();
      for (const session of restartedRegistry.values()) session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
