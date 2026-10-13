import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { BARN_SUPPORT, END_NARRATIONS } from "../module/barn-of-premier";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const OFFLINE_LLM = {
  apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0,
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
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
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

type Fixture = Readonly<{ session: GameSession; dispose: () => void }>;

async function restoredBarnFixture(
  label: string,
  facts: Readonly<{ clues?: readonly string[]; scenes?: readonly string[] }> = {},
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `departure-predicate-${label}-`));
  const id = `departure-predicate-${label}-${crypto.randomUUID()}`;
  const source = createSession(id, join(root, "source"));
  const target = createSession(id, join(root, "target"), false);
  try {
    expect((await source.act("加载模组 普瑞米尔的谷仓")).error).toBeUndefined();
    restoreSignedOrdinaryWorld(target, OFFLINE_LLM, (world) => {
      for (const clueId of facts.clues ?? []) world.recordClueDiscovery("p1", clueId);
      for (const sceneId of facts.scenes ?? []) world.recordSceneVisit("p1", sceneId);
    }, source);
    source.close();
    return Object.freeze({
      session: target,
      dispose: () => {
        target.close();
        rmSync(root, { recursive: true, force: true });
      },
    });
  } catch (error) {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function restorePrototypeMethod(name: "isClueFound" | "isSceneVisited", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(GameSession.prototype, name, descriptor);
  else Reflect.deleteProperty(GameSession.prototype, name);
}

async function withPrototypePredicatePoison<T>(
  poison: Readonly<Partial<Record<"isClueFound" | "isSceneVisited", (id: string) => boolean>>>,
  action: () => Promise<T>,
): Promise<T> {
  const clueDescriptor = Object.getOwnPropertyDescriptor(GameSession.prototype, "isClueFound");
  const sceneDescriptor = Object.getOwnPropertyDescriptor(GameSession.prototype, "isSceneVisited");
  try {
    if (poison.isClueFound) {
      Object.defineProperty(GameSession.prototype, "isClueFound", {
        configurable: true, writable: true, value: poison.isClueFound,
      });
    }
    if (poison.isSceneVisited) {
      Object.defineProperty(GameSession.prototype, "isSceneVisited", {
        configurable: true, writable: true, value: poison.isSceneVisited,
      });
    }
    return await action();
  } finally {
    restorePrototypeMethod("isClueFound", clueDescriptor);
    restorePrototypeMethod("isSceneVisited", sceneDescriptor);
  }
}

async function departAndAssertCanonicalEnding(session: GameSession, endingId: string): Promise<void> {
  const ending = END_NARRATIONS.find((candidate) => candidate.id === endingId);
  if (!ending) throw new Error(`missing Barn ending fixture: ${endingId}`);
  const endingName = BARN_SUPPORT.endLabels[endingId] ?? endingId;

  expect((await session.act("我们决定离开这里，结束这次调查", "p1")).error).toBeUndefined();
  const departure = await session.act("确定", "p1");
  const terminal = { kind: "module_departure" as const, endingId, endingName };
  expect(departure.error).toBeUndefined();
  expect(departure).toMatchObject({ dead: false, terminal });
  expect(session.getOrdinaryTerminal()).toEqual(terminal);
  expect(session.exportOrdinarySessionSnapshot().state.terminal).toEqual(terminal);
  expect(session.getHistory().messages.some((message) => message.content === ending.lines[0])).toBe(true);
  const entries = session.careerStore?.getEntries("Ada") ?? [];
  expect(entries.at(-1)).toMatchObject({ endingId, endingName, narrative: ending.lines[0] });
}

test("prototype predicates cannot forge good ending from an empty ordinary world", async () => {
  const fixture = await restoredBarnFixture("empty-forged-good");
  try {
    await withPrototypePredicatePoison({
      isClueFound: (id) => id === "clue_control_supplies",
      isSceneVisited: () => false,
    }, async () => {
      // The public observation is deliberately still a normal JS wrapper.
      expect(fixture.session.isClueFound("clue_control_supplies")).toBe(true);
      await departAndAssertCanonicalEnding(fixture.session, "normal");
    });
  } finally {
    fixture.dispose();
  }
});

test("prototype clue false cannot downgrade real supplies from good ending", async () => {
  const fixture = await restoredBarnFixture("real-good", { clues: ["clue_control_supplies"] });
  try {
    await withPrototypePredicatePoison({ isClueFound: () => false }, async () => {
      expect(fixture.session.isClueFound("clue_control_supplies")).toBe(false);
      await departAndAssertCanonicalEnding(fixture.session, "good");
    });
  } finally {
    fixture.dispose();
  }
});

test("prototype scene visit cannot forge near-truth without a real maintenance visit", async () => {
  const fixture = await restoredBarnFixture("final-without-maintenance", { clues: ["clue_final_brain_jars"] });
  try {
    await withPrototypePredicatePoison({ isSceneVisited: () => true }, async () => {
      expect(fixture.session.isSceneVisited("维修间")).toBe(true);
      await departAndAssertCanonicalEnding(fixture.session, "normal");
    });
  } finally {
    fixture.dispose();
  }
});

test("prototype clue false cannot downgrade real final-scene state from near-truth", async () => {
  const fixture = await restoredBarnFixture("real-near-truth", {
    clues: ["clue_final_brain_jars"], scenes: ["维修间"],
  });
  try {
    await withPrototypePredicatePoison({ isClueFound: () => false, isSceneVisited: () => false }, async () => {
      expect(fixture.session.isClueFound("clue_final_brain_jars")).toBe(false);
      expect(fixture.session.isSceneVisited("维修间")).toBe(false);
      await departAndAssertCanonicalEnding(fixture.session, "near_truth");
    });
  } finally {
    fixture.dispose();
  }
});

test("throwing public departure predicates cannot fail-stop a canonical ordinary departure", async () => {
  const clueFixture = await restoredBarnFixture("throwing-clue");
  const sceneFixture = await restoredBarnFixture("throwing-scene", { clues: ["clue_final_brain_jars"] });
  try {
    await withPrototypePredicatePoison({
      isClueFound: () => { throw new Error("forged clue observation"); },
    }, async () => {
      await departAndAssertCanonicalEnding(clueFixture.session, "normal");
    });
    await withPrototypePredicatePoison({
      isSceneVisited: () => { throw new Error("forged scene observation"); },
    }, async () => {
      await departAndAssertCanonicalEnding(sceneFixture.session, "normal");
    });
  } finally {
    clueFixture.dispose();
    sceneFixture.dispose();
  }
});
