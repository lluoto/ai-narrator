import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { ordinaryGameSessionSnapshotHash, type OrdinaryGameSessionSnapshot } from "../api/ordinary-game-session-snapshot";

const OFFLINE_LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

const durableCareerHostCapability = Object.freeze(Object.create(null)) as object;

function createSession(id: string, careerRoot: string, withCharacter = true, persona?: {
  personality?: string;
  backstory?: string;
  currentGoal?: string;
}): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    OFFLINE_LLM,
    withCharacter ? "investigator" : undefined,
    withCharacter ? "Ada" : undefined,
    persona,
    { careerRoot },
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: durableCareerHostCapability },
  );
}

async function durableAct(session: GameSession, input: string) {
  return runOrdinaryDurableActionTransaction(
    session,
    durableCareerHostCapability,
    async (act) => act(input),
  );
}

function resign(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function p1Meta(session: GameSession): unknown {
  return session.exportOrdinarySessionSnapshot().state.party.find((member) => member.pcId === "p1")?.meta;
}

async function loadPublishedBarn(session: GameSession): Promise<void> {
  expect((await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3")).error).toBeUndefined();
}

test("a careerRoot shadow cannot reroute lazy character persistence away from the constructor root", async () => {
  const root = mkdtempSync(join(tmpdir(), "career-root-private-authority-"));
  const trustedRoot = join(root, "trusted");
  const attackerRoot = join(root, "attacker");
  const id = `career-root-private-${crypto.randomUUID()}`;
  const session = createSession(id, trustedRoot, false);
  try {
    expect(session.careerStore).toBeNull();
    expect(Reflect.set(session, "careerRoot", attackerRoot)).toBe(true);

    expect((await durableAct(session, "\u521b\u5efa\u89d2\u8272 investigator Ada")).error).toBeUndefined();

    expect(existsSync(join(trustedRoot, id))).toBe(true);
    expect(existsSync(join(attackerRoot, id))).toBe(false);
    expect(session.careerStore?.getSnapshot("Ada")).toMatchObject({ characterName: "Ada" });
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a p1Persona shadow cannot forge the meta installed by later character creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "persona-shadow-private-authority-"));
  const session = createSession(`persona-shadow-private-${crypto.randomUUID()}`, root, false, {
    personality: "trusted personality",
    backstory: "trusted backstory",
    currentGoal: "trusted goal",
  });
  try {
    Object.defineProperty(session, "p1Persona", {
      configurable: true,
      value: { personality: "forged personality", backstory: "forged backstory", currentGoal: "forged goal" },
    });

    expect((await durableAct(session, "\u521b\u5efa\u89d2\u8272 investigator Ada")).error).toBeUndefined();
    expect(p1Meta(session)).toEqual({
      personality: "trusted personality",
      backstory: "trusted backstory",
      currentGoal: "trusted goal",
    });
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retained constructor persona alias cannot change the meta installed by later character creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "persona-alias-private-authority-"));
  const persona = {
    personality: "trusted personality",
    backstory: "trusted backstory",
    currentGoal: "trusted goal",
  };
  const session = createSession(`persona-alias-private-${crypto.randomUUID()}`, root, false, persona);
  try {
    persona.personality = "mutated personality";
    persona.backstory = "mutated backstory";
    persona.currentGoal = "mutated goal";

    expect((await durableAct(session, "\u521b\u5efa\u89d2\u8272 investigator Ada")).error).toBeUndefined();
    expect(p1Meta(session)).toEqual({
      personality: "trusted personality",
      backstory: "trusted backstory",
      currentGoal: "trusted goal",
    });
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forged first-aid eligibility set cannot make an untreated wound recover on rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "wounds-forged-private-authority-"));
  const session = createSession(`wounds-forged-private-${crypto.randomUUID()}`, root);
  try {
    expect(session.setPlayerHp("p1", 1).ok).toBe(true);
    expect(Reflect.set(session, "_woundsTreatedByPC", new Set(["p1"]))).toBe(true);

    const rest = await session.act("\u4f11\u606f");
    expect(rest.error).toBeUndefined();
    expect(rest.state.player.hp).toBe(1);
    expect(session.getState().player.hp).toBe(1);
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty wounds shadow cannot revoke a real first-aid recovery eligibility", async () => {
  const root = mkdtempSync(join(tmpdir(), "wounds-real-private-authority-"));
  const session = createSession(`wounds-real-private-${crypto.randomUUID()}`, root);
  const originalRandom = Math.random;
  try {
    expect(session.setPlayerHp("p1", 1).ok).toBe(true);
    Math.random = () => 0;
    expect((await session.act("\u6025\u6551\u4f24\u53e3")).error).toBeUndefined();
    const afterFirstAid = session.getState().player.hp;
    expect(afterFirstAid).toBeGreaterThan(1);
    expect(Reflect.set(session, "_woundsTreatedByPC", new Set())).toBe(true);

    const rest = await session.act("\u4f11\u606f");
    expect(rest.error).toBeUndefined();
    expect(rest.state.player.hp).toBeGreaterThan(afterFirstAid);
  } finally {
    Math.random = originalRandom;
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("module settlement keeps the actual published SAN and CM baseline despite same-name shadows", async () => {
  const root = mkdtempSync(join(tmpdir(), "module-baseline-private-authority-"));
  const originalRandom = Math.random;
  const sessions: GameSession[] = [];
  try {
    for (const [label, replaceBaseline] of [
      ["cleared", new Map<string, { san: number; cm: number }>()],
      ["forged", new Map([["p1", { san: 900, cm: 900 }]])],
    ] as const) {
      const session = createSession(`module-baseline-private-${label}-${crypto.randomUUID()}`, join(root, label));
      sessions.push(session);
      expect(session.setPlayerSan("p1", session.getSanity().maxSAN - 10).ok).toBe(true);
      await loadPublishedBarn(session);
      const start = session.exportOrdinarySessionSnapshot().state.moduleStartByPC.find((entry) => entry.pcId === "p1");
      if (!start) throw new Error("published module fixture requires p1 baseline");
      expect(session.setPlayerSan("p1", start.san - 3).ok).toBe(true);
      Math.random = () => 0;
      expect((await session.act("\u524d\u5f80 \u827e\u5fb7\u91cc\u5b89\u7684\u5367\u5ba4")).error).toBeUndefined();
      expect((await session.act("\u9605\u8bfb\u8001\u65e7\u6587\u4ef6")).error).toBeUndefined();
      const expectedSanChange = session.sanity.state.currentSAN - start.san;
      const expectedCmChange = session.sanity.state.cthulhuMythos - start.cm;
      expect(expectedCmChange).toBeGreaterThan(0);

      Object.defineProperty(session, "_moduleStartByPC", { configurable: true, value: replaceBaseline });
      expect((await session.act("\u6a21\u7ec4\u7ed3\u7b97")).error).toBeUndefined();
      expect((await durableAct(session, "\u786e\u5b9a")).error).toBeUndefined();
      const [entry] = session.careerStore?.getEntries("Ada") ?? [];
      expect(entry).toMatchObject({ sanChange: expectedSanChange, cmChange: expectedCmChange });
    }
  } finally {
    Math.random = originalRandom;
    for (const session of sessions) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legal module snapshots keep legacy growth canonical through same-name shadows and settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "growth-private-authority-"));
  const originalRandom = Math.random;
  const sessions: GameSession[] = [];
  try {
    for (const [label, shadow] of [
      ["cleared", new Map<string, string[]>()],
      ["forged", new Map([["p1", ["forged growth"]]])],
    ] as const) {
      const id = `growth-private-${label}-${crypto.randomUUID()}`;
      const source = createSession(id, join(root, `${label}-source`));
      const restored = createSession(id, join(root, `${label}-restored`), false);
      sessions.push(source, restored);
      await loadPublishedBarn(source);
      const legacySnapshot = structuredClone(source.exportOrdinarySessionSnapshot());
      legacySnapshot.state.growthChangesByPC = [{ pcId: "p1", changes: ["legacy module growth"] }];
      restored.restoreOrdinarySessionSnapshot(resign(legacySnapshot));

      expect(restored.exportOrdinarySessionSnapshot().state.growthChangesByPC).toEqual([
        { pcId: "p1", changes: ["legacy module growth"] },
      ]);
      expect(Reflect.set(restored, "_growthChangesByPC", shadow)).toBe(true);
      expect(restored.exportOrdinarySessionSnapshot().state.growthChangesByPC).toEqual([
        { pcId: "p1", changes: ["legacy module growth"] },
      ]);

      Math.random = () => 0;
      expect((await restored.act("\u6a21\u7ec4\u7ed3\u7b97")).error).toBeUndefined();
      expect((await durableAct(restored, "\u786e\u5b9a")).error).toBeUndefined();
      const [entry] = restored.careerStore?.getEntries("Ada") ?? [];
      expect(entry?.skillChanges).toContain("legacy module growth");
      expect(entry?.skillChanges).not.toContain("forged growth");
      expect(restored.exportOrdinarySessionSnapshot().state.growthChangesByPC).toEqual([]);
    }
  } finally {
    Math.random = originalRandom;
    for (const session of sessions) session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
