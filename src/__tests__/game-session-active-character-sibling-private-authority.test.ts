import { expect, test } from "bun:test";
import { GameSession } from "../api/game-session";

const CONFIG = {
  apiKey: "sk-active-character-sibling-authority",
  baseUrl: "http://active-character-sibling.invalid/v1",
  model: "active-character-sibling",
  maxTokens: 32,
  temperature: 0,
};

type Sibling = "updateCharacter" | "spendCharacterLuck";
type ShadowMode = "own" | "prototype";

function fresh(label: string): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession(`active-character-sibling-${label}-${crypto.randomUUID()}`, "cosmic-horror", CONFIG, "investigator", "Ada");
}

function installSiblingShadow(
  session: GameSession,
  sibling: Sibling,
  mode: ShadowMode,
  value: (...args: any[]) => unknown,
): () => void {
  const target = mode === "own" ? session : GameSession.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(target, sibling);
  Object.defineProperty(target, sibling, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(target, sibling, descriptor);
    else Reflect.deleteProperty(target, sibling);
  };
}

async function expectCanonicalActiveUpdate(session: GameSession): Promise<void> {
  const before = session.activeCharacter;
  const nextHp = before.hp - 1;
  let result: ReturnType<GameSession["updateActiveCharacter"]> | undefined;
  await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction, _lifecycle, sourceState) => {
    snapshotBeforeAction();
    result = session.updateActiveCharacter({ hp: nextHp, maxHp: before.maxHp });
    expect(sourceState.isPreActionSnapshotCurrent()).toBe(false);
  });
  expect(result).toMatchObject({ status: "updated", character: { hp: nextHp, maxHp: before.maxHp } });
  expect(session.activeCharacter).toMatchObject({ hp: nextHp, maxHp: before.maxHp });
  expect(session.world.getEntity("p1")).toMatchObject({ hp: nextHp, maxHp: before.maxHp });
  const snapshot = session.exportOrdinarySessionSnapshot();
  expect(snapshot.state.characters.find((entry) => entry.pcId === "p1")?.sheet).toMatchObject({ hp: nextHp, maxHp: before.maxHp });
}

async function expectCanonicalActiveLuckSpend(session: GameSession): Promise<void> {
  const beforeLuck = session.activeCharacter.luck;
  let result: ReturnType<GameSession["spendActiveCharacterLuck"]> | undefined;
  await session.runExclusiveActionTransaction(async (_act, snapshotBeforeAction, _lifecycle, sourceState) => {
    snapshotBeforeAction();
    result = session.spendActiveCharacterLuck(1);
    expect(sourceState.isPreActionSnapshotCurrent()).toBe(false);
  });
  expect(result).toMatchObject({ status: "updated", character: { luck: beforeLuck - 1 } });
  expect(session.activeCharacter.luck).toBe(beforeLuck - 1);
  const snapshot = session.exportOrdinarySessionSnapshot();
  expect(snapshot.state.characters.find((entry) => entry.pcId === "p1")?.sheet).toMatchObject({ luck: beforeLuck - 1 });
}

for (const mode of ["own", "prototype"] as const) {
  test(`${mode} fake updateCharacter cannot replace an active character mutation`, async () => {
    const session = fresh(`${mode}-update-fake`);
    const before = session.activeCharacter;
    const forged = { status: "updated" as const, character: { ...before, hp: 1, name: "forged" } };
    const restore = installSiblingShadow(session, "updateCharacter", mode, () => forged);
    try {
      // Public siblings remain ordinary JS observation/mutation entry points;
      // only the active wrapper must not trust this dispatch.
      expect(session.updateCharacter("p1", { hp: before.hp - 1 })).toBe(forged);
      await expectCanonicalActiveUpdate(session);
    } finally {
      restore();
      session.close();
    }
  });

  test(`${mode} throwing updateCharacter cannot DoS an active character mutation`, async () => {
    const session = fresh(`${mode}-update-throw`);
    const restore = installSiblingShadow(session, "updateCharacter", mode, () => {
      throw new Error("forged update sibling");
    });
    try {
      expect(() => session.updateCharacter("p1", { hp: 1 })).toThrow("forged update sibling");
      await expectCanonicalActiveUpdate(session);
    } finally {
      restore();
      session.close();
    }
  });

  test(`${mode} fake spendCharacterLuck cannot replace an active luck spend`, async () => {
    const session = fresh(`${mode}-luck-fake`);
    const before = session.activeCharacter;
    const forged = { status: "updated" as const, character: { ...before, luck: 99, name: "forged" } };
    const restore = installSiblingShadow(session, "spendCharacterLuck", mode, () => forged);
    try {
      expect(session.spendCharacterLuck("p1", 1)).toBe(forged);
      await expectCanonicalActiveLuckSpend(session);
    } finally {
      restore();
      session.close();
    }
  });

  test(`${mode} throwing spendCharacterLuck cannot DoS an active luck spend`, async () => {
    const session = fresh(`${mode}-luck-throw`);
    const restore = installSiblingShadow(session, "spendCharacterLuck", mode, () => {
      throw new Error("forged luck sibling");
    });
    try {
      expect(() => session.spendCharacterLuck("p1", 1)).toThrow("forged luck sibling");
      await expectCanonicalActiveLuckSpend(session);
    } finally {
      restore();
      session.close();
    }
  });
}
