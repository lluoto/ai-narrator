import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession } from "../api/game-session";
import { SanityEngine } from "../rules/coc-engine";

const CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

type RestorePatch = { installed: boolean; restore: () => void };

function replaceWithDefineProperty(target: object, key: string, value: unknown): RestorePatch {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  if (!previous) throw new Error(`missing ${key} descriptor`);
  const installed = Reflect.defineProperty(target, key, { ...previous, value });
  return {
    installed,
    restore: () => {
      if (installed) expect(Reflect.defineProperty(target, key, previous)).toBe(true);
    },
  };
}

function replaceWithAssignment(target: object, key: string, value: unknown): RestorePatch {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  if (!previous) throw new Error(`missing ${key} descriptor`);
  let installed = false;
  try {
    (target as Record<string, unknown>)[key] = value;
    installed = Object.getOwnPropertyDescriptor(target, key)?.value === value;
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
  }
  return {
    installed,
    restore: () => {
      if (installed) expect(Reflect.defineProperty(target, key, previous)).toBe(true);
    },
  };
}

function snapshotSanity(session: GameSession) {
  const state = session.exportOrdinarySessionSnapshot().state.sanities.find((entry) => entry.pcId === "p1")?.state;
  if (!state) throw new Error("ordinary fixture requires p1 SAN snapshot state");
  return state;
}

function expectCanonicalSanityObservation(session: GameSession, expectedFacade: GameSession["sanity"]): void {
  expect(session.sanity).toBe(expectedFacade);
  expect(session.sanity.state).toMatchObject(session.getSanity());
  expect(session.world.getPlayerSanity("p1")).toEqual(session.sanity.state);
  expect(JSON.stringify(snapshotSanity(session))).toBe(JSON.stringify(session.sanity.state));
}

test("prototype and static SAN replacement attempts cannot alter canonical results", () => {
  const forgedCheck = () => ({
    sanLoss: 313,
    temporaryInsanityTriggered: false,
    indefiniteInsanityTriggered: false,
    indefiniteLevel: null,
    boutOfMadness: null,
    roll: 1,
    passed: false,
  });

  const sanityCheckPatch = replaceWithDefineProperty(SanityEngine.prototype, "sanityCheck", forgedCheck);
  try {
    const engine = new SanityEngine(50);
    const result = engine.sanityCheck("4/4", () => 0.99);
    if (sanityCheckPatch.installed) {
      expect(result.sanLoss).toBe(313);
      expect(engine.state.currentSAN).toBe(50);
    } else {
      expect(result.sanLoss).toBe(4);
      expect(engine.state.currentSAN).toBe(46);
    }
  } finally {
    sanityCheckPatch.restore();
  }

  const forgedApplyLoss = () => ({
    sanLoss: 0,
    temporaryInsanityTriggered: false,
    indefiniteInsanityTriggered: false,
    indefiniteLevel: null,
    boutOfMadness: null,
  });
  const applyLossPatch = replaceWithAssignment(SanityEngine.prototype, "applyLoss", forgedApplyLoss);
  try {
    const engine = new SanityEngine(50);
    const result = engine.sanityCheck("4/4", () => 0.99);
    if (applyLossPatch.installed) {
      expect(result.sanLoss).toBe(0);
      expect(engine.state.currentSAN).toBe(50);
    } else {
      expect(result.sanLoss).toBe(4);
      expect(engine.state.currentSAN).toBe(46);
    }
  } finally {
    applyLossPatch.restore();
  }

  const forgedGuidance = () => "FORGED SAN GUIDANCE";
  const guidancePatch = replaceWithDefineProperty(SanityEngine.prototype, "getFullGuidance", forgedGuidance);
  try {
    const guidance = new SanityEngine(50).getFullGuidance();
    if (guidancePatch.installed) {
      expect(guidance).toBe("FORGED SAN GUIDANCE");
    } else {
      expect(guidance).toContain("清醒");
    }
  } finally {
    guidancePatch.restore();
  }

  const parsePatch = replaceWithDefineProperty(SanityEngine, "parseSanCost", () => 0);
  try {
    const parsed = SanityEngine.parseSanCost("1d6", () => 0.99);
    if (parsePatch.installed) {
      expect(parsed).toBe(0);
    } else {
      expect(parsed).toBe(6);
    }
  } finally {
    parsePatch.restore();
  }

  expect(sanityCheckPatch.installed).toBe(false);
  expect(applyLossPatch.installed).toBe(false);
  expect(guidancePatch.installed).toBe(false);
  expect(parsePatch.installed).toBe(false);
});

test("GameSession SAN checks retain canonical state and settlement when a prototype fake is attempted", async () => {
  const root = mkdtempSync(join(tmpdir(), "sanity-engine-class-authority-"));
  const session = new GameSession(
    `sanity-class-authority-${crypto.randomUUID()}`,
    "cosmic-horror",
    CONFIG,
    "investigator",
    "Ada",
    undefined,
    { careerRoot: root },
  );
  const originalRandom = Math.random;
  const originalFacade = session.sanity;
  const patch = replaceWithDefineProperty(SanityEngine.prototype, "sanityCheck", () => ({
    sanLoss: 313,
    temporaryInsanityTriggered: false,
    indefiniteInsanityTriggered: false,
    indefiniteLevel: null,
    boutOfMadness: null,
    roll: 1,
    passed: false,
  }));
  try {
    Math.random = () => 0.99;
    const result = await session.act("理智检定");
    const eventText = result.events.map((event) => event.content).join("\n");
    if (patch.installed) {
      expect(eventText).toContain("SAN -313");
    } else {
      expect(eventText).not.toContain("SAN -313");
    }
    expectCanonicalSanityObservation(session, originalFacade);
    expect(patch.installed).toBe(false);
  } finally {
    patch.restore();
    Math.random = originalRandom;
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unmodified SAN entry points keep their canonical standalone results", () => {
  expect(SanityEngine.parseSanCost("1d6", () => 0.99)).toBe(6);

  const engine = new SanityEngine(50);
  const result = engine.applyLoss(5, () => 0.99);
  expect(result.sanLoss).toBe(5);
  expect(result.temporaryInsanityTriggered).toBe(true);
  expect(engine.state.currentSAN).toBe(45);
  expect(engine.getFullGuidance()).toContain("临时疯狂");
});
