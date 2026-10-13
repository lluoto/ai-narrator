import { describe, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";

const OFFLINE_LLM = {
  apiKey: "sk-placeholder",
  baseUrl: "http://localhost:9999",
  model: "mock",
  maxTokens: 1,
  temperature: 0,
};

describe("GameSession mythos tome reading", () => {
  test("reading a declared Arkham tome at its real location applies the SanityEngine mythos transition", async () => {
    const session = new GameSession(
      "game-session-mythos-reading",
      "cosmic-horror",
      OFFLINE_LLM,
      "investigator",
      "Ada",
    );
    const sanity = new Proxy({} as typeof session.sanity.state, {
      get: (_target, property) => session.sanity.state[property as keyof typeof session.sanity.state],
    });
    // The public SAN surface is read-only.  A freshly-built investigator
    // starts with no Mythos, and the supported absolute SAN API supplies the
    // full-current starting point this transition needs.
    const initialMaxSAN = session.sanity.state.maxSAN;
    expect(session.setPlayerSan("p1", initialMaxSAN).ok).toBe(true);
    const loaded = await session.act("加载模组 阿卡姆档案检查");
    expect(loaded.error).toBeUndefined();
    const moved = await session.act("前往 arkham_library_vault");
    expect(moved.error).toBeUndefined();
    expect(session.getPlayerPosition()).toBe("arkham_library_vault");

    const originalRandom = Math.random;
    const draws = [
      0, 0, 0, // SAN loss dice and a passing SAN check
      0.9, 0.8, // CM +8 and max SAN -4 from the declared tome transition
    ];
    let response;
    try {
      Math.random = () => draws.shift() ?? 0.99;
      response = await session.act("阅读塞拉伊诺断章");

      expect(sanity.cthulhuMythos).toBe(8);
      expect(sanity.cthulhuMythos).toBeLessThanOrEqual(99);
      expect(sanity.maxSAN).toBe(initialMaxSAN - 4);
      expect(sanity.currentSAN).toBe(initialMaxSAN - 4);
      expect(sanity.mythosLog).toEqual([
        { source: "塞拉伊诺断章", gain: 8, maxSanLoss: 4 },
      ]);
      expect(response!.events.map((event) => event.content).join("\n"))
        .toContain("克苏鲁神话技能提升+8%");

      const persisted = session.world.getPlayerSanity("p1");
      expect(persisted).not.toBeNull();
      expect(persisted!.cthulhuMythos).toBe(sanity.cthulhuMythos);
      expect(persisted!.maxSAN).toBe(sanity.maxSAN);
      expect(persisted!.currentSAN).toBe(sanity.currentSAN);
      expect(persisted!.mythosLog).toEqual(sanity.mythosLog);

      const snapshotSanity = session.exportOrdinarySessionSnapshot().state.sanities
        .find((entry) => entry.pcId === "p1")?.state;
      if (snapshotSanity === null || typeof snapshotSanity !== "object" || Array.isArray(snapshotSanity)) {
        throw new Error("ordinary snapshot lacks a p1 SAN record");
      }
      expect(snapshotSanity["cthulhuMythos"]).toBe(sanity.cthulhuMythos);
      expect(snapshotSanity["maxSAN"]).toBe(sanity.maxSAN);
      expect(snapshotSanity["currentSAN"]).toBe(sanity.currentSAN);
      expect(JSON.stringify(snapshotSanity["mythosLog"])).toBe(JSON.stringify(sanity.mythosLog));
    } finally {
      Math.random = originalRandom;
      session.close();
    }
  });
});
