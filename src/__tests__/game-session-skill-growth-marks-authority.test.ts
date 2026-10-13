import { expect, it } from "bun:test";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash } from "../api/ordinary-game-session-snapshot";
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

function sessionWithLowSpotHidden(id: string): GameSession {
  const source = fresh(id);
  const snapshot = source.exportOrdinarySessionSnapshot();
  const p1 = snapshot.state.characters.find((entry) => entry.pcId === "p1");
  if (!p1 || !p1.sheet || Array.isArray(p1.sheet) || typeof p1.sheet !== "object") {
    throw new Error("fixture requires a p1 sheet");
  }
  const sheet = p1.sheet as { skillValues?: Record<string, number> };
  if (!sheet.skillValues) throw new Error("fixture requires CoC skill values");
  sheet.skillValues.spot_hidden = 1;
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  const target = fresh(id, false);
  target.restoreOrdinarySessionSnapshot({ ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) });
  source.close();
  return target;
}

function fixedRandom(values: number[]): () => void {
  const original = Math.random;
  let index = 0;
  Math.random = () => values[index++] ?? 0;
  return () => { Math.random = original; };
}

it("keeps real successful growth marks observable but unable to forge snapshot ownership or settlement", async () => {
  const id = `skill-growth-marks-authority-${crypto.randomUUID()}`;
  const session = sessionWithLowSpotHidden(id);
  const restored = fresh(id, false);
  let restoreRandom: (() => void) | undefined;
  try {
    const added = session.addPartyMember("p2", "investigator");
    if ("rejected" in added) throw new Error(added.rejected);
    expect((await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3", "p1")).error).toBeUndefined();

    restoreRandom = fixedRandom([0]);
    expect((await session.act("\u8c03\u67e5", "p1")).error).toBeUndefined();
    restoreRandom();
    restoreRandom = undefined;

    const p1Marks = session.skillGrowthMarks;
    expect(p1Marks).toEqual(["spot_hidden"]);
    expect(Object.isFrozen(p1Marks)).toBe(true);
    const beforeForgery = session.exportOrdinarySessionSnapshot();

    expect(() => { (p1Marks as string[]).push("fighting"); }).toThrow(TypeError);
    expect(() => { (p1Marks as string[]).splice(0, 1); }).toThrow(TypeError);
    expect(() => { delete (p1Marks as string[])[0]; }).toThrow(TypeError);
    expect(Reflect.set(p1Marks, 0, "fighting")).toBe(false);
    expect(Reflect.defineProperty(p1Marks, "0", { value: "fighting" })).toBe(false);
    expect(() => { (session as unknown as { skillGrowthMarks: string[] }).skillGrowthMarks = ["fighting"]; }).toThrow(TypeError);
    expect(Reflect.set(session, "skillGrowthMarks", ["fighting"])).toBe(false);
    expect(Reflect.defineProperty(session, "skillGrowthMarks", { value: ["fighting"] })).toBe(false);
    expect(session.exportOrdinarySessionSnapshot()).toEqual(beforeForgery);

    expect((await session.act("/roll 1d6", "p2")).error).toBeUndefined();
    const p2Marks = session.skillGrowthMarks;
    expect(p2Marks).toEqual([]);
    expect(Object.isFrozen(p2Marks)).toBe(true);
    expect(() => { (p2Marks as string[]).push("fighting"); }).toThrow(TypeError);
    expect((session.exportOrdinarySessionSnapshot() as any).state.skillGrowthMarksByPC)
      .toEqual([{ pcId: "p1", skills: ["spot_hidden"] }]);

    expect((await session.act("/roll 1d6", "p1")).error).toBeUndefined();
    const snapshot = structuredClone(session.exportOrdinarySessionSnapshot());
    restored.restoreOrdinarySessionSnapshot(snapshot);
    expect(restored.skillGrowthMarks).toEqual(["spot_hidden"]);
    expect(Object.isFrozen(restored.skillGrowthMarks)).toBe(true);

    const fightingBefore = session.activeCharacter?.skillValues?.fighting;
    restoreRandom = fixedRandom([0.5, 0]);
    expect((await session.act("\u6a21\u7ec4\u7ed3\u7b97", "p1")).error).toBeUndefined();
    expect((await session.act("\u786e\u5b9a", "p1")).error).toBeUndefined();
    expect(session.activeCharacter?.skillValues?.spot_hidden).toBe(2);
    expect(session.activeCharacter?.skillValues?.fighting).toBe(fightingBefore);
    expect(session.skillGrowthMarks).toEqual([]);
  } finally {
    restoreRandom?.();
    session.close();
    restored.close();
  }
});
