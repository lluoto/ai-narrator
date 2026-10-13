import { expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { activateRegisteredGameSessionSceneForTest } from "./helpers/game-session-world-fault";

const CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 512,
  temperature: 0,
};

const LOAD_BARN = "加载模组 普瑞米尔的谷仓";
const BAR = "维森酒吧";
const TRAILER = "加比的拖车房";
const HOUSE = "特里坎家";
const CARD = "clue_card";
const PHOEBE = "菲碧·特里坎";

function fresh(id: string): GameSession {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Scene Authority Tester");
}

async function barnAtBar(id: string): Promise<GameSession> {
  const session = fresh(id);
  expect((await session.act(LOAD_BARN)).error).toBeUndefined();
  expect(activateRegisteredGameSessionSceneForTest(session, BAR)).toBe(true);
  return session;
}

function activeScene(session: GameSession): string | undefined {
  return session.exportOrdinarySessionSnapshot().world.tables.scenes
    .find((scene) => scene.is_active === 1)?.id;
}

function physicalPosition(session: GameSession): string | undefined {
  return session.exportOrdinarySessionSnapshot().world.tables.entities
    .find((entity) => entity.id === "p1")?.position;
}

function discoveredClues(session: GameSession): string[] {
  return session.world.getCluesDiscoveredBy("p1");
}

it("does not let own displayed-scene shadows discover remote clues or talk to remote NPCs", async () => {
  const session = await barnAtBar(`scene-projection-own-${crypto.randomUUID()}`);
  const random = Math.random;
  try {
    expect(activeScene(session)).toBe(BAR);
    expect(discoveredClues(session)).not.toContain(CARD);

    Object.defineProperty(session, "getDisplayedScene", {
      configurable: true,
      value: () => TRAILER,
    });
    expect(session.getSuggestions("p1")).toContain("与 酒吧保镖 交谈");
    expect(session.getSuggestions("p1")).not.toContain(`与 ${PHOEBE} 交谈`);

    Math.random = () => 0;
    const clue = await session.act("侦查餐厅");
    expect(clue.narrative).not.toMatch(/卡片|派对/);
    expect(discoveredClues(session)).not.toContain(CARD);
    expect(clue.state.scene).toBe(BAR);
    expect(activeScene(session)).toBe(BAR);

    Object.defineProperty(session, "getDisplayedScene", {
      configurable: true,
      value: () => HOUSE,
    });
    const talk = await session.act("跟菲碧说话");
    expect(talk.events.some((event) => event.speaker === PHOEBE && event.type === "dialogue")).toBe(false);
    expect(talk.events.map((event) => event.content).join("\n")).toContain("这里没有");
    expect(talk.state.scene).toBe(BAR);
    expect(activeScene(session)).toBe(BAR);
  } finally {
    Math.random = random;
    session.close();
  }
});

it("does not let throwing or empty displayed-scene shadows DoS or empty the real scene", async () => {
  const empty = await barnAtBar(`scene-projection-empty-${crypto.randomUUID()}`);
  const throwing = await barnAtBar(`scene-projection-throw-${crypto.randomUUID()}`);
  try {
    Object.defineProperty(empty, "getDisplayedScene", { configurable: true, value: () => "" });
    expect(empty.getSuggestions("p1")).toContain("与 酒吧保镖 交谈");
    const emptyResponse = await empty.act("观察");
    expect(emptyResponse.state.scene).toBe(BAR);
    expect(activeScene(empty)).toBe(BAR);

    Object.defineProperty(throwing, "getDisplayedScene", {
      configurable: true,
      get: () => { throw new Error("forged displayed-scene getter"); },
    });
    expect(() => throwing.getSuggestions("p1")).not.toThrow();
    const response = await throwing.act("观察");
    expect(response.state.scene).toBe(BAR);
    expect(activeScene(throwing)).toBe(BAR);
    expect(throwing.exportOrdinarySessionSnapshot().world.tables.scenes.some((scene) => scene.id === BAR && scene.is_active === 1)).toBe(true);
  } finally {
    empty.close();
    throwing.close();
  }
});

it("keeps module entry activation on canonical player position while leaving the public wrapper shadowable", async () => {
  for (const [label, shadow] of [
    ["fake", () => TRAILER],
    ["empty", () => undefined],
    ["throwing", () => { throw new Error("forged player-position getter"); }],
  ] as const) {
    const session = fresh(`scene-projection-entry-${label}-${crypto.randomUUID()}`);
    try {
      Object.defineProperty(session, "getPlayerPosition", { configurable: true, value: shadow });
      const response = await session.act(LOAD_BARN);

      expect(response.events.map((event) => event.content).join("\n")).not.toContain("模组加载失败");
      expect(physicalPosition(session)).toBe(HOUSE);
      expect(session.getState().scene).toBe(HOUSE);
      expect(activeScene(session)).toBe(HOUSE);

      // The public wrapper remains an ordinary JavaScript method. These assertions
      // deliberately observe canonical state through the signed portable snapshot.
      if (label === "throwing") expect(() => session.getPlayerPosition()).toThrow("forged player-position getter");
      else expect((session as unknown as { getPlayerPosition(): unknown }).getPlayerPosition()).toBe(shadow());
      expect(physicalPosition(session)).toBe(HOUSE);
    } finally {
      session.close();
    }
  }
});

it("does not let a temporary displayed-scene prototype shadow leak across ordinary sessions", async () => {
  const original = Object.getOwnPropertyDescriptor(GameSession.prototype, "getDisplayedScene");
  if (!original) throw new Error("fixture requires the public displayed-scene wrapper");
  let left: GameSession | undefined;
  let right: GameSession | undefined;
  const random = Math.random;
  try {
    Object.defineProperty(GameSession.prototype, "getDisplayedScene", {
      configurable: true,
      writable: true,
      value: () => TRAILER,
    });
    left = await barnAtBar(`scene-projection-prototype-left-${crypto.randomUUID()}`);
    right = await barnAtBar(`scene-projection-prototype-right-${crypto.randomUUID()}`);
    Math.random = () => 0;

    const [leftResponse, rightResponse] = await Promise.all([
      left.act("侦查餐厅"),
      right.act("侦查餐厅"),
    ]);
    for (const [session, response] of [[left, leftResponse], [right, rightResponse]] as const) {
      expect(response.narrative).not.toMatch(/卡片|派对/);
      expect(discoveredClues(session)).not.toContain(CARD);
      expect(response.state.scene).toBe(BAR);
      expect(activeScene(session)).toBe(BAR);
    }
  } finally {
    Math.random = random;
    Object.defineProperty(GameSession.prototype, "getDisplayedScene", original);
    left?.close();
    right?.close();
  }
});
