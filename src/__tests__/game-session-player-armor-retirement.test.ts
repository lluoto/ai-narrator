import { afterEach, describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { WorldStateManager } from "../state/world-state-manager";

const OFFLINE_CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

const sessions: GameSession[] = [];
const worlds: WorldStateManager[] = [];

afterEach(() => {
  while (sessions.length > 0) sessions.pop()!.close();
  while (worlds.length > 0) worlds.pop()!.close();
});

describe("GameSession armor writer retirement", () => {
  it("does not expose setPlayerArmor through its public prototype or instances", () => {
    const session = new GameSession(`armor-writer-retirement-${crypto.randomUUID()}`, "cosmic-horror", OFFLINE_CONFIG);
    sessions.push(session);
    const publicSession = session as unknown as Record<string, unknown>;

    expect(Object.hasOwn(GameSession.prototype, "setPlayerArmor")).toBe(false);
    expect("setPlayerArmor" in session).toBe(false);
    expect(publicSession.setPlayerArmor).toBeUndefined();
  });

  it("keeps WorldStateManager armor reads and writes available as a component API", () => {
    const world = new WorldStateManager();
    worlds.push(world);

    world.setPlayerArmor("investigator", ["kevlar vest"]);

    expect(world.getPlayerArmor("investigator")).toEqual(["kevlar vest"]);
    expect(world.getPlayerState("investigator")).toMatchObject({ armor: ["kevlar vest"] });
  });
});
