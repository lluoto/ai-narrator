import { describe, expect, it } from "bun:test";
import { BARN_OF_PREMIER } from "../module/barn-of-premier";
import { ModuleDataRuntimeLoader, type ModuleDataRuntimeHost } from "../module/module-data-runtime-loader";
import {
  assertRuntimeModuleData,
  isRuntimeModuleData,
  type ModuleData,
} from "../module/types";
import {
  assertRuntimeModulePackage,
  compiledBundlePackage,
  mythosLegacyPackage,
  runtimeModuleDataLegacyPackage,
} from "../api/runtime-module-package";
import { GameSession } from "../api/game-session";
import { ARKHAM_LIBRARY_MODULE } from "../rules/mythos-module";
import { patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";

function hostWithWriteCounter() {
  let writes = 0;
  const count = () => { writes++; };
  const host: ModuleDataRuntimeHost = {
    registerScene: count,
    registerRuntimeNpc: count,
    registerNarrativeNpc: count,
    registerRichClue: count,
    registerTome: count,
    registerItemPlacement: count,
    registerRichItem: count,
    registerSpell: count,
    registerHook: count,
    registerRewards: count,
    registerKpNotes: count,
    registerSceneBgm: count,
    registerSceneAliases: count,
    applyInitialEffects: count,
    addIntroNarration: count,
  };
  return { host, writes: () => writes };
}

describe("RuntimeModulePackage pre-write boundary", () => {
  it("keeps pure package rejection and second-module conflict retryable because neither reaches a host write", async () => {
    const session = new GameSession(`runtime-package-preflight-${crypto.randomUUID()}`, "cosmic-horror", undefined, undefined, undefined, undefined, undefined, undefined, "development_fallback");
    try {
      expect(() => assertRuntimeModulePackage({
        kind: "runtime_module_data_legacy", identity: { moduleId: "forged" }, module: {},
      })).toThrow();
      expect(() => session.exportOrdinarySessionSnapshot()).not.toThrow();

      expect(() => (session as any).handleLoadModule("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3", () => {})).not.toThrow();
      const worldBeforeSecondModule = session.world.exportSnapshot();
      expect(() => (session as any).handleLoadModule("\u52a0\u8f7d\u6a21\u7ec4 \u963f\u5361\u59c6\u6863\u6848\u9986", () => {})).not.toThrow();
      expect(session.world.exportSnapshot()).toEqual(worldBeforeSecondModule);
      expect((await session.act("/help")).error).toBeUndefined();
    } finally { session.close(); }
  });

  it("fail-stops an interactive Barn install when its first legacy host write throws", async () => {
    const session = new GameSession(`runtime-package-first-write-${crypto.randomUUID()}`, "cosmic-horror", undefined, undefined, undefined, undefined, undefined, undefined, "development_fallback");
    let writes = 0;
    const restoreRegisterScene = patchGameSessionWorldMethod(session, "registerScene", () => {
      writes++;
      if (writes === 1) throw new Error("intentional first module host write failure");
    });
    try {
      expect(() => (session as any).handleLoadModule("加载模组 普瑞米尔的谷仓", () => {})).toThrow("failed closed");
      expect(writes).toBe(1);
      // A fail-stopped session deliberately exposes no session cohort: its
      // observable contract is a closed read boundary, no snapshot, and no
      // subsequent action admission.
      expect(() => session.getOrdinaryTerminal()).toThrow("closed GameSession cannot read session state");
      expect(() => session.exportOrdinarySessionSnapshot()).toThrow("closed GameSession");
      await expect(session.act("/help")).rejects.toThrow(
        "GameSession is unavailable after a prior action failure",
      );
    } finally { restoreRegisterScene(); session.close(); }
  });

  it("fail-stops an interactive Barn install after a mid-plan host write", async () => {
    const session = new GameSession(`runtime-package-mid-write-${crypto.randomUUID()}`, "cosmic-horror", undefined, undefined, undefined, undefined, undefined, undefined, "development_fallback");
    let writes = 0;
    const restoreRegisterScene = patchGameSessionWorldMethod(session, "registerScene", (original, receiver, args) => {
      writes++;
      const result = original.apply(receiver, args);
      if (writes === 2) throw new Error("intentional mid-plan module host write failure");
      return result;
    });
    try {
      expect(() => (session as any).handleLoadModule("加载模组 普瑞米尔的谷仓", () => {})).toThrow("failed closed");
      expect(writes).toBe(2);
      expect(() => session.getOrdinaryTerminal()).toThrow("closed GameSession cannot read session state");
      expect(() => session.exportOrdinarySessionSnapshot()).toThrow("closed GameSession");
      await expect(session.act("/help")).rejects.toThrow(
        "GameSession is unavailable after a prior action failure",
      );
    } finally { restoreRegisterScene(); session.close(); }
  });

  it("fail-stops an interactive Barn install when entry activation fails after all host writes", async () => {
    const session = new GameSession(`runtime-package-entry-${crypto.randomUUID()}`, "cosmic-horror", undefined, undefined, undefined, undefined, undefined, undefined, "development_fallback");
    let attempts = 0;
    (session as any).movePlayerToScene = () => { attempts++; return false; };
    try {
      expect(() => (session as any).handleLoadModule("加载模组 普瑞米尔的谷仓", () => {})).toThrow("failed closed");
      expect(attempts).toBe(1);
      expect(() => session.getOrdinaryTerminal()).toThrow("closed GameSession cannot read session state");
      expect(() => session.exportOrdinarySessionSnapshot()).toThrow("closed GameSession");
      await expect(session.act("/help")).rejects.toThrow(
        "GameSession is unavailable after a prior action failure",
      );
    } finally { session.close(); }
  });

  it("fail-stops an interactive Mythos install when post-write scene metadata reads fail", async () => {
    const session = new GameSession(`runtime-package-mythos-metadata-${crypto.randomUUID()}`, "cosmic-horror", undefined, undefined, undefined, undefined, undefined, undefined, "development_fallback");
    const restoreListScenes = patchGameSessionWorldMethod(session, "listScenes", () => { throw new Error("intentional post-write scene metadata failure"); });
    try {
      expect(() => (session as any).handleLoadModule("加载模组 阿卡姆档案检查", () => {})).toThrow("failed closed");
      expect(() => session.getOrdinaryTerminal()).toThrow("closed GameSession cannot read session state");
      expect(() => session.exportOrdinarySessionSnapshot()).toThrow("closed GameSession");
      await expect(session.act("/help")).rejects.toThrow(
        "GameSession is unavailable after a prior action failure",
      );
    } finally { restoreListScenes(); session.close(); }
  });

  it("accepts Barn RuntimeModuleData and rejects ingest drafts and compiler projections", () => {
    expect(isRuntimeModuleData(BARN_OF_PREMIER)).toBe(true);
    expect(() => assertRuntimeModuleData(BARN_OF_PREMIER)).not.toThrow();

    const ingestDraft: ModuleData = structuredClone(BARN_OF_PREMIER);
    delete ingestDraft.runtime;
    expect(isRuntimeModuleData(ingestDraft)).toBe(false);
    expect(() => assertRuntimeModuleData(ingestDraft)).toThrow("runtime");

    const compilerProjection = { status: "projected", module: ingestDraft };
    expect(isRuntimeModuleData(compilerProjection)).toBe(false);
    expect(() => assertRuntimeModuleData(compilerProjection)).toThrow("RuntimeModuleData");
  });

  it("uses all three internal package discriminators", () => {
    const direct = runtimeModuleDataLegacyPackage(BARN_OF_PREMIER);
    const mythos = mythosLegacyPackage(ARKHAM_LIBRARY_MODULE);
    const compiled = compiledBundlePackage(
      { identity: { moduleId: "compiled", mechanicsHash: "mechanics" } } as never,
      {
        status: "projected",
        artifact: { identity: { moduleId: "compiled", mechanicsHash: "mechanics" } },
        mechanics: { moduleId: "compiled", mechanicsHash: "mechanics" },
      } as never,
    );

    expect(direct.kind).toBe("runtime_module_data_legacy");
    expect(mythos.kind).toBe("mythos_legacy");
    expect(compiled.kind).toBe("compiled_bundle");
  });

  it("rejects missing runtime configuration before the direct loader writes its host", () => {
    const capture = hostWithWriteCounter();
    const ingestDraft: ModuleData = structuredClone(BARN_OF_PREMIER);
    delete ingestDraft.runtime;

    expect(() => new ModuleDataRuntimeLoader(capture.host).import(ingestDraft as never)).toThrow("runtime");
    expect(capture.writes()).toBe(0);
  });

  it("does not let a compiler projection masquerade as a legacy direct package", () => {
    const projection = { status: "projected", module: structuredClone(BARN_OF_PREMIER) };
    expect(() => runtimeModuleDataLegacyPackage(projection as never)).toThrow("RuntimeModuleData");
  });

  it("fails closed when a package kind or identity is forged", () => {
    expect(() => assertRuntimeModulePackage({
      kind: "runtime_module_data_legacy",
      identity: { moduleId: "forged" },
      module: BARN_OF_PREMIER,
    })).toThrow("identity");
    expect(() => assertRuntimeModulePackage({
      kind: "not-a-package",
      identity: { moduleId: BARN_OF_PREMIER.id },
      module: BARN_OF_PREMIER,
    })).toThrow("kind");
  });

  it("keeps Barn and both Mythos legacy paths, but rejects a second module before any world write", () => {
    const session = new GameSession(`runtime-package-${crypto.randomUUID()}`, "cosmic-horror");
    const messages: string[] = [];
    const load = (input: string) => (session as any).handleLoadModule(input, (message: string) => messages.push(message));

    load("加载模组 普瑞米尔的谷仓");
    expect(messages.at(-1)).not.toContain("加载失败");

    const worldBeforeSecondModule = session.world.exportSnapshot();
    load("加载模组 阿卡姆档案检查");
    expect(session.world.exportSnapshot()).toEqual(worldBeforeSecondModule);
    expect(messages.at(-1)).toContain("只能安装一个模组");

    for (const [label, input] of [["Arkham", "加载模组 阿卡姆档案检查"], ["InnsMouth", "加载模组 印斯茅斯的阴影"]] as const) {
      const legacy = new GameSession(`runtime-package-${label}-${crypto.randomUUID()}`, "cosmic-horror");
      const legacyMessages: string[] = [];
      (legacy as any).handleLoadModule(input, (message: string) => legacyMessages.push(message));
      expect(legacyMessages.at(-1)).not.toContain("加载失败");
    }
  });

  it("uses the same exact module-command parser for production act and the private intent handler", async () => {
    const offline = {
      apiKey: "sk-placeholder",
      baseUrl: "http://offline.invalid",
      model: "offline",
      maxTokens: 1,
      temperature: 0,
    };
    const production = new GameSession(`runtime-package-production-${crypto.randomUUID()}`, "cosmic-horror", offline, undefined, undefined, undefined, undefined, undefined, "required");
    const refused = await production.act("使用模块化武器攻击");
    expect(refused.error?.code).toBe("intent_model_unavailable");
    expect(production.round).toBe(0);

    const internal = new GameSession(`runtime-package-internal-${crypto.randomUUID()}`, "cosmic-horror", offline);
    const messages: any[] = [];
    const invalid = await (internal as any).handleIntent({ action: "load_module" }, "使用模块化武器攻击", messages);
    expect(invalid).toBe(false);
    expect(messages).toHaveLength(0);

    const valid = await (internal as any).handleIntent({ action: "load_module" }, "加载模组 阿卡姆档案检查", messages);
    expect(valid).toBe(true);
    expect(messages.map((message) => message.content).join("\n")).not.toContain("未找到模组「加载模组");
  });
});
