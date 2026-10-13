import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";

// Importing db/index captures NPC_DB_PATH. Point the pre-fix server default at
// a disposable file so this regression test proves the old shared-store bug
// without ever touching a user's data/npc.db.
const root = mkdtempSync(join(tmpdir(), "server-npc-store-isolation-"));
const previousNpcDbPath = process.env.NPC_DB_PATH;
const previousLlmDisabled = process.env.LLM_DISABLED;
const previousFetch = globalThis.fetch;
process.env.NPC_DB_PATH = join(root, "legacy-shared-npc.db");
process.env.LLM_DISABLED = "1";
globalThis.fetch = (async () => new Response(JSON.stringify({
  choices: [{ message: { content: "offline fixture narration" } }],
}), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
const { cleanupExpiredSessions, handleRequest } = await import("../api/server");

afterAll(() => {
  if (previousNpcDbPath === undefined) delete process.env.NPC_DB_PATH;
  else process.env.NPC_DB_PATH = previousNpcDbPath;
  if (previousLlmDisabled === undefined) delete process.env.LLM_DISABLED;
  else process.env.LLM_DISABLED = previousLlmDisabled;
  globalThis.fetch = previousFetch;
  rmSync(root, { recursive: true, force: true });
});

const SESSION_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const LOAD_BARN = "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3";
const PHOEBE = "\u83f2\u78a7\u00b7\u7279\u91cc\u574e";

describe("server-owned NPC stores", () => {
  it("keeps real module NPC persistence out of another ordinary session", async () => {
    const registry = new Map<string, GameSession>();
    const created: GameSession[] = [];
    let idIndex = 0;
    const runtimeDependencies = {
      registry,
      generateSessionId: () => SESSION_IDS[idIndex++]!,
      ordinaryIntentPolicy: "development_fallback" as const,
    };
    const createOrdinarySession = async (): Promise<GameSession> => {
      const response = await handleRequest(
        new Request("http://test/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archetype: "detective", characterName: "Ada" }),
        }),
        undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {},
        undefined, undefined, undefined, undefined,
        { mode: "development_anonymous", environment: { NODE_ENV: "test" } },
        runtimeDependencies,
      );
      expect(response.status).toBe(201);
      const session = registry.get(SESSION_IDS[idIndex - 1]!);
      if (!session) throw new Error("ordinary session was not registered");
      created.push(session);
      return session;
    };
    const loadBarnThroughDurableAction = async (sessionId: string, actionId: string): Promise<GameSession> => {
      const response = await handleRequest(
        new Request(`http://test/api/sessions/${sessionId}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: LOAD_BARN, actionId, expectedGeneration: 0 }),
        }),
        undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {},
        undefined, undefined, undefined, undefined,
        { mode: "development_anonymous", environment: { NODE_ENV: "test" } },
        runtimeDependencies,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ordinaryGeneration: 1 });
      const installed = registry.get(sessionId);
      if (!installed) throw new Error("ordinary durable action did not install the live session");
      if (!created.includes(installed)) created.push(installed);
      return installed;
    };

    try {
      const first = await loadBarnThroughDurableAction((await createOrdinarySession()).id, "npc-store-isolation-first-0001");
      expect(first.registry.has(PHOEBE)).toBe(true);
      expect(first.npcStore.getAllPersonalities().length).toBeGreaterThan(0);

      const secondBeforeLoad = await createOrdinarySession();
      expect(secondBeforeLoad.registry.has(PHOEBE)).toBe(false);
      expect(secondBeforeLoad.npcStore.getAllPersonalities()).toEqual([]);
      const second = await loadBarnThroughDurableAction(secondBeforeLoad.id, "npc-store-isolation-second-0001");
      expect(second.registry.has(PHOEBE)).toBe(true);

      const cleanupNow = Math.max(...created.map((session) => session.lastActiveAt)) + 1;
      expect(cleanupExpiredSessions(registry, {
        now: cleanupNow,
        timeoutMs: 0,
        deleteMetadata: () => undefined,
      })).toEqual(SESSION_IDS);
      expect(() => first.npcStore.getAllPersonalities()).toThrow();
    } finally {
      for (const session of created) session.close();
    }
  });
});
