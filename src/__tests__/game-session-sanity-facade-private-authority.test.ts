import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession } from "../api/game-session";

const CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function snapshotSanity(session: GameSession) {
  const state = session.exportOrdinarySessionSnapshot().state.sanities.find((entry) => entry.pcId === "p1")?.state;
  if (!state) throw new Error("ordinary fixture requires p1 SAN snapshot state");
  return state;
}

function expectCanonicalSanityObservation(session: GameSession, expectedFacade: GameSession["sanity"]): void {
  const current = session.getSanity();
  expect(session.sanity).toBe(expectedFacade);
  expect(session.sanity.state).toMatchObject(current);
  expect(session.world.getPlayerSanity("p1")).toEqual(session.sanity.state);
  expect(JSON.stringify(snapshotSanity(session))).toBe(JSON.stringify(session.sanity.state));
  expect(session.getState().party.find((member) => member.pcId === "p1")?.san).toBe(current.currentSAN);
}

test("a same-name sanityFacade shadow cannot forge SAN observation or replace its stable identity", () => {
  const root = mkdtempSync(join(tmpdir(), "sanity-facade-private-authority-"));
  const session = new GameSession(
    `sanity-facade-shadow-${crypto.randomUUID()}`,
    "cosmic-horror",
    CONFIG,
    "investigator",
    "Ada",
    undefined,
    { careerRoot: root },
  );
  try {
    const initialFacade = session.sanity;
    const canonical = session.getSanity();
    const fakeFacade = Object.freeze({
      state: Object.freeze({ currentSAN: canonical.currentSAN + 37, maxSAN: 999, phobias: ["forged"] }),
    });
    expect(Reflect.set(session, "sanityFacade", fakeFacade)).toBe(true);

    expectCanonicalSanityObservation(session, initialFacade);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("own sanity property definition or assignment cannot forge the canonical SAN observer", () => {
  const root = mkdtempSync(join(tmpdir(), "sanity-facade-private-authority-"));
  const session = new GameSession(
    `sanity-own-shadow-${crypto.randomUUID()}`,
    "cosmic-horror",
    CONFIG,
    "investigator",
    "Ada",
    undefined,
    { careerRoot: root },
  );
  try {
    const initialFacade = session.sanity;
    const before = snapshotSanity(session);
    const observedBefore = session.getSanity();
    const fakeFacade = Object.freeze({
      state: Object.freeze({ currentSAN: observedBefore.currentSAN + 37, maxSAN: 999, phobias: ["forged"] }),
    });

    expect(() => Object.defineProperty(session, "sanity", { value: fakeFacade })).toThrow(TypeError);
    expect(Reflect.set(session, "sanity", fakeFacade)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(session, "sanity")).toMatchObject({ configurable: false, get: expect.any(Function) });
    expectCanonicalSanityObservation(session, initialFacade);
    expect(snapshotSanity(session)).toEqual(before);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a throwing sanityFacade accessor cannot deny SAN, state, or post-setPlayerSan observation", () => {
  const root = mkdtempSync(join(tmpdir(), "sanity-facade-private-authority-"));
  const session = new GameSession(
    `sanity-facade-throwing-${crypto.randomUUID()}`,
    "cosmic-horror",
    CONFIG,
    "investigator",
    "Ada",
    undefined,
    { careerRoot: root },
  );
  try {
    const initialFacade = session.sanity;
    Object.defineProperty(session, "sanityFacade", {
      configurable: true,
      get: () => { throw new Error("forged sanity facade accessor"); },
    });

    expect(() => session.sanity).not.toThrow();
    expect(() => session.getState()).not.toThrow();
    const next = session.getSanity().currentSAN > 0 ? session.getSanity().currentSAN - 1 : 1;
    expect(session.setPlayerSan("p1", next).ok).toBe(true);
    expect(session.sanity.state.currentSAN).toBe(next);
    expectCanonicalSanityObservation(session, initialFacade);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
