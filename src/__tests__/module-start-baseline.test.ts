import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash, type OrdinaryGameSessionSnapshot } from "../api/ordinary-game-session-snapshot";
import type { GeneratedStory } from "../rules/story-generator";
import { worldStateSnapshotHash } from "../state/world-state-snapshot";

const OFFLINE_LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};
const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;

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

function createSession(id: string, careerRoot: string, withCharacter = true): GameSession {
  return durableFixtureSession(new GameSession(
    id,
    "cosmic-horror",
    OFFLINE_LLM,
    withCharacter ? "investigator" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined,
    { careerRoot },
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: durableCareerHostCapability },
  ));
}

function resign(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

test("interactive ordinary module settlement records SAN relative to the published module start", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-start-baseline-"));
  const session = createSession(`module-start-baseline-${crypto.randomUUID()}`, root);
  const originalRandom = Math.random;
  try {
    const maxSAN = session.getSanity().maxSAN;
    expect(session.setPlayerSan("p1", maxSAN - 10).ok).toBe(true);
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();

    const moduleStartSAN = session.getSanity().currentSAN;
    expect(session.setPlayerSan("p1", moduleStartSAN - 3).ok).toBe(true);
    Math.random = () => 0;
    expect((await session.act("\u8c03\u67e5")).error).toBeUndefined();

    expect((await session.act("模组结算")).error).toBeUndefined();
    expect((await session.act("确定")).error).toBeUndefined();
    const entries = session.careerStore?.getEntries("Ada") ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sanChange).toBe(-3);
  } finally {
    Math.random = originalRandom;
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary snapshot restore retains the original module start instead of recapturing current SAN", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-start-snapshot-"));
  const id = `module-start-snapshot-${crypto.randomUUID()}`;
  const source = createSession(id, join(root, "source"));
  const restored = createSession(id, join(root, "restored"), false);
  const originalRandom = Math.random;
  try {
    const maxSAN = source.getSanity().maxSAN;
    expect(source.setPlayerSan("p1", maxSAN - 10).ok).toBe(true);
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const moduleStartSAN = source.getSanity().currentSAN;
    expect(source.setPlayerSan("p1", moduleStartSAN - 2).ok).toBe(true);

    restored.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(source.exportOrdinarySessionSnapshot())));
    expect(restored.setPlayerSan("p1", moduleStartSAN - 5).ok).toBe(true);
    Math.random = () => 0;
    expect((await restored.act("\u8c03\u67e5")).error).toBeUndefined();

    expect((await restored.act("模组结算")).error).toBeUndefined();
    expect((await restored.act("确定")).error).toBeUndefined();
    const entries = restored.careerStore?.getEntries("Ada") ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sanChange).toBe(-5);
  } finally {
    Math.random = originalRandom;
    source.close();
    restored.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("confirmed ordinary departure records SAN relative to the module start", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-start-departure-"));
  const session = createSession(`module-start-departure-${crypto.randomUUID()}`, root);
  try {
    const maxSAN = session.getSanity().maxSAN;
    expect(session.setPlayerSan("p1", maxSAN - 10).ok).toBe(true);
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const moduleStartSAN = session.getSanity().currentSAN;
    expect(session.setPlayerSan("p1", moduleStartSAN - 4).ok).toBe(true);

    expect((await session.act("我们决定离开这里，结束这次调查")).error).toBeUndefined();
    expect((await session.act("确定")).error).toBeUndefined();
    const entries = session.careerStore?.getEntries("Ada") ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sanChange).toBe(-4);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary module baseline includes pre-existing Mythos and records only post-load CM", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-start-cm-"));
  const id = `module-start-cm-${crypto.randomUUID()}`;
  const source = createSession(id, join(root, "source"));
  const session = createSession(id, join(root, "restored"), false);
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    // Restore an already-established, signed ordinary history before a module
    // exists.  The SAN/maxSAN/CM/log tuple matches SanityEngine's learned
    // state shape instead of relying on an uninstalled tome.
    const prior = structuredClone(source.exportOrdinarySessionSnapshot());
    const p1 = prior.state.sanities.find((entry) => entry.pcId === "p1");
    if (!p1 || typeof p1.state !== "object" || p1.state === null || Array.isArray(p1.state)) {
      throw new Error("fixture lacks p1 SAN state");
    }
    const sanity = p1.state as Record<string, unknown>;
    if (typeof sanity.currentSAN !== "number" || typeof sanity.maxSAN !== "number") {
      throw new Error("fixture SAN state is malformed");
    }
    const inheritedMaxSanLoss = 2;
    const inheritedMaxSan = Math.max(10, sanity.maxSAN - inheritedMaxSanLoss);
    sanity.maxSAN = inheritedMaxSan;
    sanity.currentSAN = Math.min(sanity.currentSAN, inheritedMaxSan);
    sanity.cthulhuMythos = 3;
    sanity.mythosLog = [{ source: "pre-existing ordinary history", gain: 3, maxSanLoss: inheritedMaxSanLoss }];
    const worldP1 = prior.world.tables.player_state.find((entry) => entry.entity_id === "p1");
    if (!worldP1) throw new Error("fixture lacks p1 world SAN state");
    // The ordinary snapshot's world mirror is independently validated against
    // state.sanities, so restore the same complete SAN object into both truth
    // locations before resigning.
    worldP1.sanity = JSON.parse(JSON.stringify(sanity));
    const { hash: _worldHash, ...unsignedWorld } = prior.world;
    prior.world = { ...unsignedWorld, hash: worldStateSnapshotHash(unsignedWorld) };
    session.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(resign(prior))));

    const beforeLoadCM = session.sanity.state.cthulhuMythos;
    expect(beforeLoadCM).toBe(3);

    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const start = session.exportOrdinarySessionSnapshot().state.moduleStartByPC.find((entry) => entry.pcId === "p1");
    expect(start).toEqual({ pcId: "p1", san: session.sanity.state.currentSAN, cm: beforeLoadCM });

    expect((await session.act("前往 艾德里安的卧室")).error).toBeUndefined();
    expect((await session.act("阅读老旧文件")).error).toBeUndefined();
    const expectedCMChange = session.sanity.state.cthulhuMythos - beforeLoadCM;
    expect((await session.act("\u8c03\u67e5")).error).toBeUndefined();
    expect((await session.act("模组结算")).error).toBeUndefined();
    expect((await session.act("确定")).error).toBeUndefined();

    const entries = session.careerStore?.getEntries("Ada") ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.cmChange).toBe(expectedCMChange);
  } finally {
    Math.random = originalRandom;
    source.close();
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("late join and replacement character creation receive an ordinary module baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-start-party-"));
  const session = createSession(`module-start-party-${crypto.randomUUID()}`, root);
  try {
    expect(session.setPlayerSan("p1", 1).ok).toBe(true);
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    let snapshot = session.exportOrdinarySessionSnapshot();
    expect(snapshot.state.moduleStartByPC.find((entry) => entry.pcId === "p1")?.san).toBe(1);

    const added = session.addPartyMember("Bea", "investigator");
    if ("rejected" in added) throw new Error(added.rejected);

    snapshot = session.exportOrdinarySessionSnapshot();
    expect(snapshot.state.moduleStartByPC.map((entry) => entry.pcId).sort()).toEqual(["p1", "p2"]);
    const p2Sanity = snapshot.state.sanities.find((entry) => entry.pcId === "p2")?.state;
    const p2Start = snapshot.state.moduleStartByPC.find((entry) => entry.pcId === "p2");
    expect(p2Start?.san).toBe((p2Sanity as { currentSAN: number }).currentSAN);

    expect((await session.act("创建角色 detective Replaced")).error).toBeUndefined();
    snapshot = session.exportOrdinarySessionSnapshot();
    const p1Sanity = snapshot.state.sanities.find((entry) => entry.pcId === "p1")?.state;
    const p1Start = snapshot.state.moduleStartByPC.find((entry) => entry.pcId === "p1");
    expect(p1Start?.san).toBe((p1Sanity as { currentSAN: number }).currentSAN);
    expect(p1Start?.san).not.toBe(1);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successfully generated ordinary story publishes a baseline for its existing PC", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-start-generated-"));
  const session = createSession(`module-start-generated-${crypto.randomUUID()}`, root);
  try {
    expect((await session.act("生成故事")).error).toBeUndefined();
    const snapshot = session.exportOrdinarySessionSnapshot();
    expect(snapshot.module.package).not.toBeNull();
    expect(snapshot.state.moduleStartByPC).toEqual([
      { pcId: "p1", san: session.sanity.state.currentSAN, cm: session.sanity.state.cthulhuMythos },
    ]);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected generated story does not publish a module baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-start-generated-reject-"));
  const session = new GameSession(
    `module-start-generated-reject-${crypto.randomUUID()}`,
    "cosmic-horror",
    OFFLINE_LLM,
    "investigator",
    "Ada",
    undefined,
    { careerRoot: root },
    undefined,
    "development_fallback",
    { storyGenerator: { generate: () => ({}) as GeneratedStory } },
  );
  try {
    expect((await session.act("生成故事")).error).toBeUndefined();
    const snapshot = session.exportOrdinarySessionSnapshot();
    expect(snapshot.module.package).toBeNull();
    expect(snapshot.state.moduleStartByPC).toEqual([]);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an installed ordinary snapshot with an empty legacy baseline ends only after confirmation while preserving growth", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-start-empty-"));
  const id = `module-start-empty-${crypto.randomUUID()}`;
  const source = createSession(id, join(root, "source"));
  const restored = createSession(id, join(root, "restored"), false);
  const originalRandom = Math.random;
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const legacySnapshot = structuredClone(source.exportOrdinarySessionSnapshot());
    legacySnapshot.state.moduleStartByPC = [];
    legacySnapshot.state.skillGrowthMarksByPC = [{ pcId: "p1", skills: ["spot_hidden"] }];
    legacySnapshot.state.growthChangesByPC = [{ pcId: "p1", changes: ["legacy pending growth"] }];
    restored.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(resign(legacySnapshot))));
    Math.random = () => 0;

    const requested = await restored.act("模组结算");
    expect(requested.error).toBeUndefined();
    expect(requested.narrative).toContain("确认离开");
    expect(restored.dead).toBe(false);
    expect(restored.skillGrowthMarks).toEqual(["spot_hidden"]);
    expect(restored.exportOrdinarySessionSnapshot().state.growthChangesByPC).toEqual([
      { pcId: "p1", changes: ["legacy pending growth"] },
    ]);
    expect(restored.careerStore?.getEntries("Ada") ?? []).toHaveLength(0);

    const result = await restored.act("确定");
    expect(result.error).toBeUndefined();
    expect(restored.dead).toBe(false);
    expect(restored.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(result.events.map((event) => event.content).join("\n")).toContain("起点缺失");
    expect(restored.skillGrowthMarks).toEqual(["spot_hidden"]);
    expect(restored.exportOrdinarySessionSnapshot().state.growthChangesByPC).toEqual([
      { pcId: "p1", changes: ["legacy pending growth"] },
    ]);
    expect(restored.careerStore?.getEntries("Ada") ?? []).toHaveLength(0);
  } finally {
    Math.random = originalRandom;
    source.close();
    restored.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an installed ordinary snapshot with an empty legacy baseline still ends but writes no departure entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-start-empty-departure-"));
  const id = `module-start-empty-departure-${crypto.randomUUID()}`;
  const source = createSession(id, join(root, "source"));
  const restored = createSession(id, join(root, "restored"), false);
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const legacySnapshot = structuredClone(source.exportOrdinarySessionSnapshot());
    legacySnapshot.state.moduleStartByPC = [];
    restored.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(resign(legacySnapshot))));

    expect((await restored.act("模组结算")).error).toBeUndefined();
    const result = await restored.act("确定");
    expect(result.error).toBeUndefined();
    expect(restored.dead).toBe(false);
    expect(restored.getOrdinaryTerminal()).toMatchObject({ kind: "module_departure" });
    expect(result.events.map((event) => event.content).join("\n")).toContain("起点缺失");
    expect(restored.careerStore?.getEntries("Ada") ?? []).toHaveLength(0);
  } finally {
    source.close();
    restored.close();
    rmSync(root, { recursive: true, force: true });
  }
});
