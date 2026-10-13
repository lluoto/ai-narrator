import { readSync } from "fs";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";

const root = process.env.SESSION_NAMESPACE_HTTP_ROOT;
const id = process.env.SESSION_NAMESPACE_HTTP_ID;
const owner = process.env.SESSION_NAMESPACE_HTTP_OWNER;
const holdFactory = process.env.SESSION_NAMESPACE_HTTP_HOLD_FACTORY === "1";

if (!root || !id || !owner) throw new Error("session namespace HTTP child requires root, id, and owner");

const registry = new Map<string, GameSession>();
let factoryCalls = 0;
let openingCalls = 0;
const dependencies: SessionRuntimeDependencies = {
  registry,
  generateSessionId: () => id,
  ordinaryIntentPolicy: "development_fallback",
  createOrdinarySession: ({ id: sessionId, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
    factoryCalls++;
    if (holdFactory) {
      process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);
      readSync(0, new Uint8Array(1), 0, 1, null);
    }
  const session = new GameSession(sessionId, ruleset, { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
    session.getOpeningScene = async () => { openingCalls++; return "opening"; };
    return session;
  },
};

try {
  const response = await handleRequest(new Request("http://test/api/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archetype: "detective", characterName: "Ada" }),
  }), undefined, undefined, { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {},
  () => ({ status: "authenticated", principal: { role: "keeper", id: owner } }),
  undefined, undefined, undefined, { mode: "required" }, dependencies);
  const body = await response.json() as { error?: { code?: string } };
  process.stdout.write(`${JSON.stringify({ event: "result", result: { status: response.status, code: body.error?.code, factoryCalls, openingCalls } })}\n`);
} finally {
  for (const session of registry.values()) session.close();
}
