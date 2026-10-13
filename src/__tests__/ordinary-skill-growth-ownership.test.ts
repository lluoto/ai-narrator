import { expect, it } from "bun:test";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import {
  ordinaryGameSessionSnapshotHash,
  validateOrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";
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

function fresh(id: string, withCharacter = true): GameSession {
  return durableFixtureSession(new GameSession(
    id,
    "cosmic-horror",
    undefined,
    withCharacter ? "investigator" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: durableCareerHostCapability },
  ));
}

function fixedRandom(values: number[]): () => void {
  const original = Math.random;
  let index = 0;
  Math.random = () => values[index++] ?? 0;
  return () => { Math.random = original; };
}

function setSpotHidden(session: GameSession, pcId: string, value: number): { skillValues: Record<string, number> } {
  const result = session.updateCharacter(pcId, { skillValues: { spot_hidden: value } });
  expect(result).toMatchObject({ status: "updated" });
  if (result.status !== "updated") throw new Error(result.code);
  return result.character as { skillValues: Record<string, number> };
}

/** Seed the persistent p1 sheet before module settlement needs map/raw aliasing. */
function freshWithP1SpotHidden(id: string, value: number): GameSession {
  const source = fresh(id);
  const snapshot = source.exportOrdinarySessionSnapshot();
  const p1 = snapshot.state.characters.find((entry) => entry.pcId === "p1");
  if (!p1 || !p1.sheet || Array.isArray(p1.sheet) || typeof p1.sheet !== "object") throw new Error("fixture requires p1 sheet");
  const sheet = p1.sheet as { skillValues?: Record<string, unknown> };
  if (!sheet.skillValues) throw new Error("fixture requires p1 skillValues");
  sheet.skillValues.spot_hidden = value;
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const target = fresh(id, false);
  target.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
  source.close();
  return target;
}

function resign(snapshot: any): any {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function asLegacyV1(snapshot: any, marks: string[]): any {
  const legacy = structuredClone(snapshot);
  legacy.schemaVersion = "1.0.0";
  legacy.components.snapshot = "1.0.0";
  legacy.state.woundsTreated = false;
  delete legacy.state.woundsTreatedByPC;
  delete legacy.state.terminal;
  delete legacy.components.career;
  delete legacy.career;
  delete legacy.state.skillGrowthMarksByPC;
  legacy.state.skillGrowthMarks = marks;
  return resign(legacy);
}

it("short rests preserve successful owner-scoped marks without dice or career changes; module settlement consumes them", async () => {
  const realRandom = Math.random;
  const session = freshWithP1SpotHidden(`growth-owner-rest-${crypto.randomUUID()}`, 1);
  const added = session.addPartyMember("Bea", "investigator");
  if ("rejected" in added) throw new Error(added.rejected);
  let restoreRandom: (() => void) | undefined;
  try {
    expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    const p2AtSetup = setSpotHidden(session, added.member.pcId, 1);

    restoreRandom = fixedRandom([0]);
    expect((await session.act("调查", "p1")).error).toBeUndefined();
    restoreRandom();
    restoreRandom = undefined;
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    const careerBefore = session.careerStore?.getEntries("Ada") ?? [];

    let restRolls = 0;
    Math.random = () => {
      restRolls += 1;
      throw new Error("short rest must not roll pending skill growth");
    };

    expect((await session.act("休息", "p2")).error).toBeUndefined();
    expect(p2AtSetup.skillValues.spot_hidden).toBe(1);
    expect((session.exportOrdinarySessionSnapshot() as any).state.skillGrowthMarksByPC)
      .toEqual([{ pcId: "p1", skills: ["spot_hidden"] }]);

    expect((await session.act("休息", "p1")).error).toBeUndefined();
    expect(restRolls).toBe(0);
    expect(session.activeCharacter.skillValues.spot_hidden).toBe(1);
    expect(session.skillGrowthMarks).toEqual(["spot_hidden"]);
    expect(session.careerStore?.getEntries("Ada") ?? []).toEqual(careerBefore);

    restoreRandom = fixedRandom([0.5, 0]); // d100=51 > 1, then d10=1.
    expect((await session.act("模组结算", "p1")).error).toBeUndefined();
    expect((await session.act("确定", "p1")).error).toBeUndefined();
    expect(session.activeCharacter.skillValues.spot_hidden).toBe(2);
    expect(session.skillGrowthMarks).toEqual([]);
    expect(p2AtSetup.skillValues.spot_hidden).toBe(1);
  } finally {
    restoreRandom?.();
    Math.random = realRandom;
    session.close();
  }
});

it("module advancement applies a successful p1 mark to p1 only", async () => {
  const session = freshWithP1SpotHidden(`growth-owner-module-${crypto.randomUUID()}`, 1);
  const added = session.addPartyMember("Bea", "investigator");
  if ("rejected" in added) throw new Error(added.rejected);
  expect((await session.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
  const restoreRandom = fixedRandom([0, 0.5, 0, 0.5, 0]);
  try {
    const p2AtSetup = setSpotHidden(session, added.member.pcId, 1);

    expect((await session.act("调查", "p1")).error).toBeUndefined();
    expect((await session.act("模组结算", "p1")).error).toBeUndefined();
    expect((await session.act("确定", "p1")).error).toBeUndefined();

    expect(session.activeCharacter?.skillValues.spot_hidden).toBe(2);
    expect(p2AtSetup.skillValues.spot_hidden).toBe(1);
  } finally {
    restoreRandom();
    session.close();
  }
});

it("round-trips pending growth marks with their PC owner", () => {
  const id = `growth-owner-roundtrip-${crypto.randomUUID()}`;
  const source = fresh(id);
  const target = fresh(id, false);
  try {
    const added = source.addPartyMember("Bea", "investigator");
    if ("rejected" in added) throw new Error(added.rejected);
    const snapshot: any = structuredClone(source.exportOrdinarySessionSnapshot());
    snapshot.state.skillGrowthMarksByPC = [{ pcId: "p1", skills: ["spot_hidden"] }];
    expect(snapshot.state.skillGrowthMarksByPC).toEqual([{ pcId: "p1", skills: ["spot_hidden"] }]);
    target.restoreOrdinarySessionSnapshot(JSON.parse(JSON.stringify(resign(snapshot))));
    expect((target.exportOrdinarySessionSnapshot() as any).state.skillGrowthMarksByPC)
      .toEqual([{ pcId: "p1", skills: ["spot_hidden"] }]);
  } finally {
    source.close();
    target.close();
  }
});

  it("keeps an empty active-PC observation out of the snapshot", () => {
  const source = fresh(`growth-owner-empty-view-${crypto.randomUUID()}`);
  try {
    const before = source.exportOrdinarySessionSnapshot();
    expect(source.skillGrowthMarks).toEqual([]);
    expect(source.exportOrdinarySessionSnapshot()).toEqual(before);
  } finally {
    source.close();
  }
});

it("migrates a verified v1 single-PC mark into the current owner-aware snapshot", () => {
  const id = `growth-owner-v1-single-${crypto.randomUUID()}`;
  const source = fresh(id);
  const target = fresh(id, false);
  try {
    const legacy = asLegacyV1(source.exportOrdinarySessionSnapshot(), ["spot_hidden"]);
    const migrated: any = validateOrdinaryGameSessionSnapshot(legacy);
    expect(migrated.schemaVersion).toBe("1.4.0");
    expect(migrated.career).toEqual({ mode: "legacy-bases-only" });
    expect(migrated.state.skillGrowthMarksByPC).toEqual([{ pcId: "p1", skills: ["spot_hidden"] }]);
    target.restoreOrdinarySessionSnapshot(legacy);
    expect((target.exportOrdinarySessionSnapshot() as any).state.skillGrowthMarksByPC)
      .toEqual([{ pcId: "p1", skills: ["spot_hidden"] }]);
  } finally {
    source.close();
    target.close();
  }
});

it("migrates verified empty v1 marks for a multi-PC session but refuses ambiguous non-empty marks", () => {
  const source = fresh(`growth-owner-v1-multi-${crypto.randomUUID()}`);
  try {
    const added = source.addPartyMember("Bea", "investigator");
    if ("rejected" in added) throw new Error(added.rejected);
    const snapshot = source.exportOrdinarySessionSnapshot();

    expect((validateOrdinaryGameSessionSnapshot(asLegacyV1(snapshot, [])) as any).state.skillGrowthMarksByPC).toEqual([]);
    expect(() => validateOrdinaryGameSessionSnapshot(asLegacyV1(snapshot, ["spot_hidden"]))).toThrow("ambiguous ownership");
  } finally {
    source.close();
  }
});

it("rejects a tampered v1 legacy hash before migration", () => {
  const source = fresh(`growth-owner-v1-tampered-${crypto.randomUUID()}`);
  try {
    const legacy = asLegacyV1(source.exportOrdinarySessionSnapshot(), ["spot_hidden"]);
    legacy.state.round = 7;
    expect(() => validateOrdinaryGameSessionSnapshot(legacy)).toThrow("snapshotHash");
  } finally {
    source.close();
  }
});

it("clears pending marks when the same pcId receives a replacement character", async () => {
  const session = fresh(`growth-owner-replacement-${crypto.randomUUID()}`);
  try {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      expect((await session.act("\u8c03\u67e5", "p1")).error).toBeUndefined();
    } finally {
      Math.random = originalRandom;
    }
    expect((await session.act("创建角色 investigator Replaced", "p1")).error).toBeUndefined();
    expect(session.skillGrowthMarks).toEqual([]);
  } finally {
    session.close();
  }
});

it("rejects current snapshots with unknown, duplicate, or duplicate-skill growth owners", () => {
  const source = fresh(`growth-owner-current-forgery-${crypto.randomUUID()}`);
  try {
    const snapshot: any = source.exportOrdinarySessionSnapshot();
    const unknownOwner = structuredClone(snapshot);
    unknownOwner.state.skillGrowthMarksByPC = [{ pcId: "missing", skills: ["spot_hidden"] }];
    expect(() => validateOrdinaryGameSessionSnapshot(resign(unknownOwner))).toThrow("growth mark owner");

    const duplicateOwner = structuredClone(snapshot);
    duplicateOwner.state.skillGrowthMarksByPC = [
      { pcId: "p1", skills: ["spot_hidden"] },
      { pcId: "p1", skills: ["library_use"] },
    ];
    expect(() => validateOrdinaryGameSessionSnapshot(resign(duplicateOwner))).toThrow("duplicate");

    const duplicateSkill = structuredClone(snapshot);
    duplicateSkill.state.skillGrowthMarksByPC = [{ pcId: "p1", skills: ["spot_hidden", "spot_hidden"] }];
    expect(() => validateOrdinaryGameSessionSnapshot(resign(duplicateSkill))).toThrow("duplicates");
  } finally {
    source.close();
  }
});
