import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { GameSession } from "../api/game-session";
import { createEnvironmentCompilerAuthenticator, createEnvironmentPlayerDelivery, handleRequest, hydrateCompiledSessions } from "../api/server";
import { join } from "path";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const [root, sessionId, rawCookie] = process.argv.slice(2);
if (!root || !sessionId || !rawCookie) throw new Error("expected root, session ID, and player cookie");

const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
const delivery = createEnvironmentPlayerDelivery({
  COMPILER_PLAYER_DELIVERY_HMAC_SECRET: "delivery_hmac_secret_".padEnd(48, "d"),
  COMPILER_PLAYER_DELIVERY_ROOT: join(root, "delivery"),
  COMPILER_PUBLIC_ORIGIN: "https://example.test",
});
const authenticator = createEnvironmentCompilerAuthenticator({
  COMPILER_OPERATOR_BEARER_TOKEN: "o".repeat(48),
  COMPILER_KEEPER_BEARER_TOKEN: "k".repeat(48),
});
const host = createCompiledDurableTestHost();
const hydration = hydrateCompiledSessions({
  catalog,
  snapshots,
  compiledDurableHostCapability: host.capability,
  createSession: (id, runtimeDependencies) => new GameSession(id, "cosmic-horror", undefined, undefined, undefined, undefined, { careerRoot: join(root, "child-careers") }, undefined, "preferred", runtimeDependencies),
});
if (!hydration.hydrated.includes(sessionId) || hydration.unavailable.length !== 0) throw new Error(`restart hydration failed: ${JSON.stringify(hydration)}`);

async function playerRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return handleRequest(
    new Request(`https://example.test${path}`, init),
    catalog,
    snapshots,
    { careerRoot: join(root, "child-careers") },
    {},
    {},
    authenticator,
    undefined,
    undefined,
    delivery,
    undefined,
    { compiledDurableHostCapability: host.capability },
  );
}

const base = `/api/sessions/${sessionId}`;
const view = await playerRequest(`${base}/player-view`, { headers: { Cookie: rawCookie } });
if (view.status !== 200) throw new Error(`restart player view failed: ${view.status}`);
const payload = await view.json() as { generation: number; actions: Array<{ choiceId: string }> };
const choice = payload.actions[0];
if (!choice) throw new Error("restart player view had no action");
const action = await playerRequest(`${base}/player-actions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://example.test", Cookie: rawCookie },
  body: JSON.stringify({ choiceId: choice.choiceId, actionId: "018f14a2-c2be-7b73-b291-6e64eaf78692", expectedGeneration: payload.generation }),
});
if (action.status !== 200) throw new Error(`restart player action failed: ${action.status} ${await action.text()}`);
console.log(JSON.stringify({ hydration, generation: (await action.json() as { view: { generation: number } }).view.generation }));
