import { expect, test } from "bun:test";
import { SanityEngine } from "../rules/coc-engine";

const LEGACY_HELPERS = [
  "recoverSan",
  "rollNightmare",
  "triggerIrreversibleChange",
  "getIndefiniteGuidance",
  "getPhobiaGuidance",
  "getManiaGuidance",
] as const;

function restoreSanity(engine: SanityEngine, patch: Partial<SanityEngine["state"]>): void {
  engine.restoreState({ ...engine.state, ...patch });
}

function installDecoys(target: object): () => void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const helper of LEGACY_HELPERS) {
    saved.set(helper, Object.getOwnPropertyDescriptor(target, helper));
    Object.defineProperty(target, helper, {
      configurable: true,
      value: () => { throw new Error(`legacy ${helper} decoy was dispatched`); },
    });
  }
  return () => {
    for (const helper of LEGACY_HELPERS) {
      const descriptor = saved.get(helper);
      if (descriptor) Object.defineProperty(target, helper, descriptor);
      else delete (target as Record<string, unknown>)[helper];
    }
  };
}

function expectCanonicalOuterPaths(engine: SanityEngine): void {
  restoreSanity(engine, { currentSAN: 30, indefiniteInsanity: true, indefiniteLevel: "moderate" });
  const therapy = engine.therapyCheck(1, 100);
  expect(therapy.success).toBe(true);
  expect(engine.state.currentSAN).toBe(30 + therapy.sanRecovered);

  restoreSanity(engine, { indefiniteInsanity: false, indefiniteLevel: null, nightmareStreak: 3 });
  expect(engine.handleLongRest().nightmare).toBe(false);
  expect(engine.state.nightmareStreak).toBe(0);

  const institutionalization = engine.institutionalize();
  expect(institutionalization).toContain("SAN归零入院");
  expect(engine.state.irreversibleChanges).toHaveLength(1);

  restoreSanity(engine, {
    indefiniteInsanity: true,
    indefiniteLevel: "moderate",
    phobias: ["黑暗恐惧症"],
    manias: ["纵火狂"],
  });
  const guidance = engine.getFullGuidance();
  expect(guidance).toContain("黑暗恐惧症");
  expect(guidance).toContain("纵火狂");
}

test("outer SAN paths ignore own legacy-helper decoys", () => {
  for (const helper of LEGACY_HELPERS) {
    expect(Object.getOwnPropertyDescriptor(SanityEngine.prototype, helper)).toBeUndefined();
  }

  const own = new SanityEngine(60);
  const restoreOwn = installDecoys(own);
  try {
    expectCanonicalOuterPaths(own);
  } finally {
    restoreOwn();
  }
});

test("SanityEngine prototype rejects legacy-helper decoys and outer paths remain canonical", () => {
  expect(Object.isExtensible(SanityEngine.prototype)).toBe(false);
  for (const helper of LEGACY_HELPERS) {
    expect(Reflect.defineProperty(SanityEngine.prototype, helper, {
      configurable: true,
      value: () => { throw new Error(`prototype decoy ${helper} ran`); },
    })).toBe(false);
  }
  expectCanonicalOuterPaths(new SanityEngine(60));
});
