import { describe, expect, test } from "bun:test";
import { GameSession, type ActionResponse } from "../api/game-session";

const CFG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 64,
  temperature: 0,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

type SessionWithEconomyLog = {
  round: number;
  act: (input: string) => Promise<ActionResponse>;
  world: {
    getRecentEvents: (limit?: number) => Array<{ description: string; event_type: string }>;
  };
};

function economyDescriptions(session: SessionWithEconomyLog): string[] {
  const logPrefix = "[经济] ";
  return session.world
    .getRecentEvents(200)
    .filter((event) => event.description.startsWith(logPrefix))
    .map((event) => event.description.slice(logPrefix.length));
}

function systemContents(response: ActionResponse): string[] {
  return response.events
    .filter((event) => event.type === "system")
    .map((event) => event.content);
}

describe("经济事件的玩家可见叙事投影", () => {
  test("第十回合把同一批已记录经济事件逐条作为系统消息投影，非 tick 回合不重放旧事件", async () => {
    const session = new GameSession(`eco-narration-${Math.random()}`, "cosmic-horror", CFG, undefined, undefined, undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME) as unknown as SessionWithEconomyLog;
    await session.act("创建角色 investigator 经济见证者"); // round=1

    let preTickResponse: ActionResponse | undefined;
    for (let i = 0; i < 8; i++) preTickResponse = await session.act("观察"); // round=9

    expect(session.round).toBe(9);
    expect(economyDescriptions(session)).toEqual([]);
    expect(systemContents(preTickResponse!)).not.toContainEqual(expect.stringContaining("[经济]"));

    const tickResponse = await session.act("观察"); // round=10
    const settledDescriptions = economyDescriptions(session);
    expect(settledDescriptions.length).toBeGreaterThan(0);
    for (const description of settledDescriptions) {
      expect(systemContents(tickResponse)).toContain(description);
    }

    const afterTickResponse = await session.act("观察"); // round=11
    expect(economyDescriptions(session)).toEqual(settledDescriptions);
    for (const description of settledDescriptions) {
      expect(systemContents(afterTickResponse)).not.toContain(description);
    }
  }, 20_000);
});
