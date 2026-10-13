// 急救必须消费实体唯一的 status[]，并把治疗后的 HP 同步回角色卡和世界。
// 这里故意让角色卡 HP 与世界实体 HP 不同：若把旧角色卡当作本回合流血结算的
// 真相源，测试会掩盖“tick 已作用于世界、急救却只改缓存”的实际断点。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { resolveFirstAidSkillSource } from "../api/first-aid-skill-source";
import {
  ordinaryGameSessionSnapshotHash,
  validateOrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";
import { newStatus, parseStatus } from "../rules/status-effects";
import { patchGameSessionWorldMethod } from "./helpers/game-session-world-fault";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

type Entity = {
  id: string;
  name: string;
  type: string;
  hp: number;
  maxHp: number;
  ac: number;
  status: string[];
  position: string;
  scene_id?: string;
};

type SessionInternals = GameSession;

const realRandom = Math.random;
afterEach(() => { Math.random = realRandom; });

function statusIds(entity: Entity): string[] {
  return entity.status.flatMap((raw) => {
    const status = parseStatus(raw);
    return status ? [status.id] : [];
  });
}

/** Seed status-bearing CoC cases through the ordinary signed restore contract. */
function sessionWithWounds(input: {
  label: string;
  hp?: number;
  maxHp?: number;
  status?: string[];
  update?: Parameters<GameSession["updateActiveCharacter"]>[0];
}): SessionInternals {
  const { label, hp = 12, maxHp = 12, status = [], update = {} } = input;
  const id = `first-aid-truth-${label}-${Math.random()}`;
  const source = new GameSession(id, "cosmic-horror", CFG, "investigator", "Ada", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  const target = new GameSession(id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  expect(source.updateActiveCharacter({ hp, maxHp, ...update })).toMatchObject({ status: "updated" });
  restoreSignedOrdinaryWorld(target, CFG, (world) => {
    const player = world.getCurrentState().entities.p1!;
    world.upsertEntity({ ...player, status });
  }, source);
  source.close();
  return target;
}

function setPlayerHp(session: SessionInternals, pcId: string, hp: number, maxHp = 12): void {
  expect(session.updateCharacter(pcId, { hp, maxHp })).toMatchObject({ status: "updated" });
}

function patchActiveCharacter(session: SessionInternals, update: Parameters<GameSession["updateCharacter"]>[1]): void {
  expect(session.updateCharacter(session.activePlayerId, update)).toMatchObject({ status: "updated" });
}

function resignSnapshot(snapshot: any): any {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function asScalarTreatmentSnapshot(snapshot: any, version: "1.2.0" | "1.1.0" | "1.0.0", woundsTreated: boolean): any {
  const value = structuredClone(snapshot);
  value.schemaVersion = version;
  value.components.snapshot = version;
  // These wire versions predate the v1.4 terminal-reason field.  Remove it
  // when deriving an authenticated historical payload from a current export.
  delete value.state.terminal;
  value.state.woundsTreated = woundsTreated;
  delete value.state.woundsTreatedByPC;
  if (version !== "1.2.0") {
    delete value.components.career;
    delete value.career;
  }
  if (version === "1.0.0") {
    value.state.skillGrowthMarks = [];
    delete value.state.skillGrowthMarksByPC;
  }
  return resignSnapshot(value);
}

describe("GameSession 急救的流血真相源闭环", () => {
  test("错误行为红线：first_aid 优先于 medicine；本回合先流血，再同步治疗并止血", async () => {
    const session = sessionWithWounds({
      label: "success", hp: 10, maxHp: 12,
      status: ["流血 (3回合)", "流血 (7回合) x2", newStatus("blinded", 4), "重伤:胸部"],
      update: { skillValues: { first_aid: 90, medicine: 1 } },
    });
    // 本回合状态 tick 的输入来自持久的实体状态；从 10 经两条流血状态掉到 7。

    // d100=50：first_aid=90 成功、medicine=1 会失败；随后 1d3=2。
    const values = [0.49, 0.99];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0;
    const response = await session.act("急救伤口", session.activePlayerId);
    const entity = session.world.getEntity(session.activePlayerId)!;

    expect(response.events.some((event) => event.content.includes("急救=90%") && event.content.includes("成功"))).toBe(true);
    expect(rolls).toBe(1);
    expect(entity.hp).toBe(8); // world: 10 - (1 + 2) + First Aid 1
    expect(session.activeCharacter!.hp).toBe(8);
    expect(response.state.player.hp).toBe(8);
    expect(statusIds(entity)).not.toContain("bleeding");
    expect(statusIds(entity)).toContain("blinded");
    expect(entity.status).toContain("重伤:胸部");

    const next = await session.act("观察", session.activePlayerId);
    expect(session.world.getEntity(session.activePlayerId)!.hp).toBe(8);
    expect(next.state.player.hp).toBe(8);
  }, 20_000);

  test("失败时 first_aid 不被较高 medicine 覆盖，既不治疗也不止血", async () => {
    const session = sessionWithWounds({
      label: "failure", hp: 10, maxHp: 12,
      status: ["流血 (3回合)", "流血 (7回合) x2", newStatus("blinded", 4), "重伤:胸部"],
      update: { skillValues: { first_aid: 10, medicine: 99 } },
    });

    const values = [0.49, 0.99];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0; // d100=50：first_aid=10 失败，medicine=99 若抢占会错误成功。
    const response = await session.act("急救伤口", session.activePlayerId);
    const entity = session.world.getEntity(session.activePlayerId)!;

    expect(response.events.some((event) => event.content.includes("急救=10%") && event.content.includes("失败"))).toBe(true);
    // 失败不是治疗，但本回合流血已由实体结算；角色卡必须同步这个既有损失。
    expect(session.activeCharacter!.hp).toBe(7);
    expect(entity.hp).toBe(7); // 仅本回合既有流血 tick
    expect(response.state.player.hp).toBe(7);
    expect(statusIds(entity)).toContain("bleeding");
    expect(statusIds(entity)).toContain("blinded");
    expect(entity.status).toContain("重伤:胸部");
    expect(session.skillGrowthMarks).toEqual([]);
    expect(rolls).toBe(1);

    const next = await session.act("观察", session.activePlayerId);
    expect(session.world.getEntity(session.activePlayerId)!.hp).toBe(4);
    expect(session.activeCharacter!.hp).toBe(4);
    expect(next.state.player.hp).toBe(4);
    expect(statusIds(session.world.getEntity(session.activePlayerId)!)).toContain("bleeding");
  }, 20_000);

  test("大失败即使技能为 100 也不得治疗或止血", async () => {
    const session = sessionWithWounds({
      label: "fumble", hp: 10, maxHp: 12,
      status: [newStatus("bleeding"), newStatus("blinded", 4), "重伤:胸部"],
      update: { skillValues: { first_aid: 100, medicine: 100 } },
    });

    const values = [0.99, 0];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0; // d100=100：无论技能值都应是急救大失败。
    const response = await session.act("急救伤口", session.activePlayerId);
    const entity = session.world.getEntity(session.activePlayerId)!;

    expect(response.events.some((event) => event.content.includes("大失败"))).toBe(true);
    // 大失败同样不治疗，但不能撤销本回合已在实体上结算的流血同步。
    expect(session.activeCharacter!.hp).toBe(9);
    expect(entity.hp).toBe(9); // 只有本回合既有流血 tick
    expect(response.state.player.hp).toBe(9);
    expect(statusIds(entity)).toContain("bleeding");
    expect(statusIds(entity)).toContain("blinded");
    expect(entity.status).toContain("重伤:胸部");
    expect(session.skillGrowthMarks).toEqual([]);
    expect(rolls).toBe(1);
  }, 20_000);

  test("兼容旧卡：first_aid 缺失时才回退 medicine", async () => {
    expect(resolveFirstAidSkillSource({ skillValues: { medicine: 60 } })).toEqual({
      baseScore: 60, canonicalSkill: "medicine", healing: "medicine_d3",
    });
  }, 20_000);

  test("中文或默认急救 fallback 仍是固定 First Aid +1，且不臆造 canonical 成长键", async () => {
    expect(resolveFirstAidSkillSource({ skillValues: {} })).toEqual({
      baseScore: 30, canonicalSkill: null, healing: "first_aid_one",
    });
    expect(resolveFirstAidSkillSource({ skillValues: { first_aid: 0, medicine: 90 } })).toEqual({
      baseScore: 0, canonicalSkill: "first_aid", healing: "first_aid_one",
    });
  }, 20_000);

  test("满血仅止血的 First Aid 不掷治疗 d3，仍保留实际治疗资格", async () => {
    const session = sessionWithWounds({
      label: "first-aid-full-hp-stop-bleed", hp: 12, maxHp: 12,
      status: [newStatus("bleeding")], update: { skillValues: { first_aid: 100 } },
    });
    try {
      const values = [0, 0.99];
      let rolls = 0;
      Math.random = () => values[rolls++] ?? 0;

      await session.act("急救伤口", session.activePlayerId);

      const entity = session.world.getEntity(session.activePlayerId)!;
      expect(rolls).toBe(1);
      expect(entity.hp).toBe(12);
      expect(statusIds(entity)).not.toContain("bleeding");
      expect(session.skillGrowthMarks).toEqual(["first_aid"]);
      expect((session.exportOrdinarySessionSnapshot() as any).state.woundsTreatedByPC).toEqual([session.activePlayerId]);
    } finally {
      (session as unknown as GameSession).close();
    }
  }, 20_000);

  test("成功且实际治疗时按实际检定的 CoC 键记录 owner 成长，并能随快照恢复", async () => {
    const session = sessionWithWounds({
      label: "growth-first-aid", hp: 10, maxHp: 12,
      update: { skillValues: { first_aid: 90, medicine: 1 } },
    });

    // d100=50 以 first_aid=90 成功，随后 1d3=1；medicine=1 若被误用会失败。
    const values = [0.49, 0];
    let rolls = 0;
    Math.random = () => values[rolls++] ?? 0;
    await session.act("急救伤口", session.activePlayerId);

    expect(session.skillGrowthMarks).toEqual(["first_aid"]);
    const snapshot = session.exportOrdinarySessionSnapshot() as any;
    expect(snapshot.state.skillGrowthMarksByPC).toEqual([
      { pcId: session.activePlayerId, skills: ["first_aid"] },
    ]);

    const restored = new GameSession((session as unknown as GameSession).id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME) as unknown as SessionInternals;
    try {
      restored.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
      expect(restored.skillGrowthMarks).toEqual(["first_aid"]);
    } finally {
      (restored as unknown as GameSession).close();
    }
    (session as unknown as GameSession).close();
  }, 20_000);

  test("兼容 medicine 回退成功时标记 medicine，不会凭急救文案错标 first_aid", async () => {
    expect(resolveFirstAidSkillSource({ skillValues: { medicine: 90 } })).toEqual({
      baseScore: 90, canonicalSkill: "medicine", healing: "medicine_d3",
    });
  }, 20_000);

  test("急救未实际治疗时不获得成长标记", async () => {
    const session = sessionWithWounds({ label: "growth-no-effect", hp: 12, maxHp: 12 });
    try {
      patchActiveCharacter(session, { skillValues: { first_aid: 100 } });
      Math.random = () => 0; // 成功，但满血且没有可移除流血。

      await session.act("急救伤口", session.activePlayerId);

      expect(session.skillGrowthMarks).toEqual([]);
    } finally {
      (session as unknown as GameSession).close();
    }
  }, 20_000);

  test("满血且无可止血状态的成功急救不能为之后受伤的休息开恢复资格", async () => {
    const session = sessionWithWounds({ label: "rest-no-effect", hp: 12, maxHp: 12 });
    try {
      patchActiveCharacter(session, { maxHp: 12, skillValues: { first_aid: 100 } });
      Math.random = () => 0;

      await session.act("急救伤口", session.activePlayerId);
      setPlayerHp(session, session.activePlayerId, 6);
      await session.act("休息", session.activePlayerId);

      expect(session.world.getEntity(session.activePlayerId)?.hp).toBe(6);
    } finally {
      (session as unknown as GameSession).close();
    }
  }, 20_000);

  test("p1 的实际急救资格只能让 p1 休息恢复，p2 既不能借用也不能消费它", async () => {
    const session = sessionWithWounds({ label: "rest-owner", hp: 10, maxHp: 12 });
    try {
      patchActiveCharacter(session, { maxHp: 12, skillValues: { first_aid: 100 } });
      const added = (session as unknown as GameSession).addPartyMember("Bea", "investigator");
      if ("rejected" in added) throw new Error(added.rejected);
      expect(session.updateCharacter("p2", { maxHp: 12 })).toMatchObject({ status: "updated" });
      Math.random = () => 0;

      await session.act("急救伤口", "p1");
      setPlayerHp(session, "p2", 6);
      await session.act("休息", "p2");
      expect(session.world.getEntity("p2")?.hp).toBe(6);

      setPlayerHp(session, "p1", 6);
      await session.act("休息", "p1");
      expect(session.world.getEntity("p1")?.hp).toBeGreaterThan(6);
    } finally {
      (session as unknown as GameSession).close();
    }
  }, 20_000);

  test("实际急救资格以 owner 列表进入快照、恢复后仍只允许原 owner 消费", async () => {
    const source = sessionWithWounds({
      label: "rest-snapshot", hp: 10, maxHp: 12,
      update: { skillValues: { first_aid: 100 } },
    });
    const target = new GameSession((source as unknown as GameSession).id, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME) as unknown as SessionInternals;
    try {
      Math.random = () => 0;
      await source.act("急救伤口", source.activePlayerId);
      const snapshot = source.exportOrdinarySessionSnapshot() as any;
      expect(snapshot.state.woundsTreatedByPC).toEqual([source.activePlayerId]);
      expect(snapshot.state.woundsTreated).toBeUndefined();

      target.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
      setPlayerHp(target, target.activePlayerId, 6);
      await target.act("休息", target.activePlayerId);
      expect(target.world.getEntity(target.activePlayerId)?.hp).toBeGreaterThan(6);
    } finally {
      (source as unknown as GameSession).close();
      (target as unknown as GameSession).close();
    }
  }, 20_000);

  test("快照拒绝未知或重复治疗资格 owner，并只在单角色旧 scalar=true 时迁移", async () => {
    const root = mkdtempSync(join(tmpdir(), "first-aid-scalar-career-"));
    const capability = Object.freeze(Object.create(null)) as object;
    const source = new GameSession(
      `first-aid-scalar-migration-${Math.random()}`,
      "cosmic-horror",
      CFG,
      undefined,
      undefined,
      undefined,
      { careerRoot: root },
      undefined,
      "preferred",
      { ordinaryDurableHostCapability: capability },
    );
    try {
      expect((await runOrdinaryDurableActionTransaction(source, capability, async (act) => act("创建角色 investigator Ada"))).error).toBeUndefined();
      const current = source.exportOrdinarySessionSnapshot() as any;
      const unknown = structuredClone(current);
      unknown.state.woundsTreatedByPC = ["missing"];
      expect(() => validateOrdinaryGameSessionSnapshot(resignSnapshot(unknown))).toThrow("treatment recovery owner");

      const duplicate = structuredClone(current);
      duplicate.state.woundsTreatedByPC = ["p1", "p1"];
      expect(() => validateOrdinaryGameSessionSnapshot(resignSnapshot(duplicate))).toThrow("duplicates");

      expect(validateOrdinaryGameSessionSnapshot(asScalarTreatmentSnapshot(current, "1.2.0", false)).state.woundsTreatedByPC).toEqual([]);
      expect(validateOrdinaryGameSessionSnapshot(asScalarTreatmentSnapshot(current, "1.2.0", true)).state.woundsTreatedByPC).toEqual(["p1"]);
      expect(validateOrdinaryGameSessionSnapshot(asScalarTreatmentSnapshot(current, "1.1.0", true)).state.woundsTreatedByPC).toEqual(["p1"]);
      expect(validateOrdinaryGameSessionSnapshot(asScalarTreatmentSnapshot(current, "1.0.0", true)).state.woundsTreatedByPC).toEqual(["p1"]);

      expect((await runOrdinaryDurableActionTransaction(source, capability, async (act) => act("创建队友 Bea investigator"))).error).toBeUndefined();
      const multi = source.exportOrdinarySessionSnapshot() as any;
      expect(() => validateOrdinaryGameSessionSnapshot(asScalarTreatmentSnapshot(multi, "1.2.0", true))).toThrow("ambiguous ownership");
      expect(() => validateOrdinaryGameSessionSnapshot(asScalarTreatmentSnapshot(multi, "1.1.0", true))).toThrow("ambiguous ownership");
      expect(() => validateOrdinaryGameSessionSnapshot(asScalarTreatmentSnapshot(multi, "1.0.0", true))).toThrow("ambiguous ownership");
    } finally {
      (source as unknown as GameSession).close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("替换同一 pcId 的角色会清除旧角色遗留的急救休息资格", async () => {
    const session = sessionWithWounds({ label: "rest-replacement", hp: 10, maxHp: 12 });
    try {
      patchActiveCharacter(session, { maxHp: 12, skillValues: { first_aid: 100 } });
      Math.random = () => 0;
      await session.act("急救伤口", session.activePlayerId);
      expect((await session.act("创建角色 investigator Replaced", "p1")).error).toBeUndefined();
      setPlayerHp(session, "p1", 6);
      await session.act("休息", "p1");
      expect(session.world.getEntity("p1")?.hp).toBe(6);
    } finally {
      (session as unknown as GameSession).close();
    }
  }, 20_000);

  test("急救仍采用行动前状态的百分比惩罚，失败时不标记成长", async () => {
    const session = sessionWithWounds({
      label: "growth-penalty", hp: 10, maxHp: 12, status: [newStatus("head_dazed", 2)],
    });
    try {
      patchActiveCharacter(session, { maxHp: 12, skillValues: { first_aid: 90 } });
      Math.random = () => 0.7; // d100=71: 90 - 20 的状态惩罚下必须失败。

      const response = await session.act("急救伤口", session.activePlayerId);

      expect(response.events.some((event) => event.content.includes("急救=70%") && event.content.includes("失败"))).toBe(true);
      expect(session.skillGrowthMarks).toEqual([]);
    } finally {
      (session as unknown as GameSession).close();
    }
  }, 20_000);

  test("重复成功去重且成长标记由实际施救者拥有", async () => {
    const session = sessionWithWounds({ label: "growth-owner-and-dedupe", hp: 10, maxHp: 12 });
    try {
      patchActiveCharacter(session, { maxHp: 12, skillValues: { first_aid: 90 } });
      const added = (session as unknown as GameSession).addPartyMember("Bea", "investigator");
      if ("rejected" in added) throw new Error(added.rejected);
      expect(session.updateCharacter("p2", { maxHp: 12, skillValues: { first_aid: 90 } })).toMatchObject({ status: "updated" });

      const rolls = [0.49, 0, 0.49, 0, 0.49, 0];
      let index = 0;
      Math.random = () => rolls[index++] ?? 0;
      await session.act("急救伤口", "p1");
      await session.act("急救伤口", "p1");
      expect(session.skillGrowthMarks).toEqual(["first_aid"]);

      expect(session.setPlayerHp("p2", 10)).toMatchObject({ ok: true });
      await session.act("急救伤口", "p2");
      expect(session.skillGrowthMarks).toEqual(["first_aid"]);

      await session.act("状态", "p1");
      expect(session.skillGrowthMarks).toEqual(["first_aid"]);
    } finally {
      (session as unknown as GameSession).close();
    }
  }, 20_000);

  test("无角色、非 CoC 与 compiled 防线均不让成功急救写入普通成长", async () => {
    const noCharacter = new GameSession(`first-aid-growth-none-${Math.random()}`, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    const dnd = new GameSession(`first-aid-growth-dnd-${Math.random()}`, "dnd5e", CFG, "fighter", "Ada", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    const compiled = new GameSession(`first-aid-growth-compiled-${Math.random()}`, "cosmic-horror", CFG, "investigator", "Ada", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
    try {
      Math.random = () => 0;
      expect((noCharacter as any).handleFirstAid(() => {})).toBe(true);
      expect(noCharacter.skillGrowthMarks).toEqual([]);

      expect(dnd.setPlayerHp(dnd.activePlayerId, Math.max(0, dnd.activeCharacter!.maxHp - 2))).toMatchObject({ ok: true });
      expect((dnd as any).handleFirstAid(() => {})).toBe(true);
      expect(dnd.skillGrowthMarks).toEqual([]);

      const fixture = await compiledModuleHttpFixture("first-aid-growth-compiled");
      expect(compiled.loadCompiledModule(fixture.resolved.artifact.payload as any, fixture.projection).status).toBe("loaded");
      expect(compiled.setPlayerHp(compiled.activePlayerId, Math.max(0, compiled.activeCharacter!.maxHp - 2))).toMatchObject({ ok: true });
      expect((compiled as any).handleFirstAid(() => {})).toBe(true);
      expect(compiled.skillGrowthMarks).toEqual([]);
    } finally {
      noCharacter.close();
      dnd.close();
      compiled.close();
    }
  }, 20_000);

  test("实体缺失时明确拒绝，不凭空创建实体也不治疗角色卡", async () => {
    const session = sessionWithWounds({ label: "missing-entity" });
    const playerId = session.activePlayerId;
    patchActiveCharacter(session, { hp: 6, skillValues: { first_aid: 100 } });
    const restoreMissingPlayer = patchGameSessionWorldMethod(session as unknown as GameSession, "getEntity", (original, receiver, args) => {
      if (args[0] === playerId) return null;
      return original.apply(receiver, args);
    });
    try {
      expect(session.world.getEntity(playerId)).toBeNull();
      Math.random = () => 0;

      const response = await session.act("急救伤口");

      expect(response.events.some((event) => event.content.includes("无法找到") && event.content.includes("世界实体"))).toBe(true);
      expect(session.activeCharacter!.hp).toBe(6);
      expect(session.world.getEntity(playerId)).toBeNull();
      expect(session.skillGrowthMarks).toEqual([]);
    } finally {
      restoreMissingPlayer();
    }
  }, 20_000);
});
