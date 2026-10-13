import { join } from "path";
import { GameSession } from "../api/game-session";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";

type Request = { root: string; sessionId: string; bundleId: string };
type Scope = {
  postMessage(value: { status: "ok"; names: string[]; npcCount: number } | { status: "error"; message: string }): void;
  addEventListener(type: "message", listener: (event: { data: Request }) => void | Promise<void>): void;
};

const scope = globalThis as typeof globalThis & Partial<Scope>;
function restore(request: Request): { names: string[]; npcCount: number } {
  const catalog = new CompilerArtifactCatalog({ root: join(request.root, "catalog") });
  const bundle = catalog.loadBundle(request.bundleId);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(request.root, "snapshots") });
  const snapshot = snapshots.read(request.sessionId);
  if (snapshot.status !== "ok") throw new Error(snapshot.message);
  const session = new GameSession(request.sessionId, "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 });
  const restored = session.restoreCompiledSession(snapshot.value, bundle.value);
  if (restored.status === "refused") throw new Error(restored.message);
  return { names: session.getState().npcs.map((npc) => npc.name), npcCount: session.getSummary().npcCount };
}

if (!import.meta.main && typeof scope.postMessage === "function" && typeof scope.addEventListener === "function") {
  scope.addEventListener("message", async (event) => {
    try {
      scope.postMessage({ status: "ok", ...restore(event.data) });
    } catch (error) {
      scope.postMessage({ status: "error", message: error instanceof Error ? error.message : "fresh prose NPC restart failed" });
    }
  });
} else if (import.meta.main) {
  const [root, sessionId, bundleId] = process.argv.slice(2);
  try {
    console.log(JSON.stringify(restore({ root: root ?? "", sessionId: sessionId ?? "", bundleId: bundleId ?? "" })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "fresh prose NPC restart failed");
    process.exitCode = 1;
  }
}
