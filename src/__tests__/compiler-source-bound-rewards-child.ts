import { join } from "path";
import { GameSession } from "../api/game-session";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

export interface SourceBoundRewardRestartRequest {
  root: string;
  sessionId: string;
  bundleId: string;
  input: string;
  actionId: string;
}

export function restoreSourceBoundRewardInFreshProcess(request: SourceBoundRewardRestartRequest): {
  sanity: number;
  maxSan: number;
  cthulhuMythos: number;
  creditRating: number;
  duplicate: unknown;
} {
  const config = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
  const catalog = new CompilerArtifactCatalog({ root: join(request.root, "catalog") });
  const snapshots = new CompiledSessionSnapshotStore({ root: join(request.root, "snapshots") });
  const bundle = catalog.loadBundle(request.bundleId);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  const snapshot = snapshots.read(request.sessionId);
  if (snapshot.status !== "ok") throw new Error(snapshot.message);
  const host = createCompiledDurableTestHost();
  const session = new GameSession(request.sessionId, "cosmic-horror", config, undefined, undefined, undefined, { careerRoot: join(request.root, "worker-careers") }, undefined, "preferred", host.runtimeDependencies);
  const restored = session.restoreCompiledSession(snapshot.value, bundle.value);
  if (restored.status === "refused") throw new Error(restored.message);
  const duplicate = host.commit(session, request.input, request.actionId, 0, () => {});
  if (duplicate.status !== "duplicate") throw new Error(`fresh reward retry failed: ${duplicate.status}`);
  const character = (session as any).activeCharacter;
  return {
    sanity: session.getSanity().currentSAN,
    maxSan: session.getSanity().maxSAN,
    cthulhuMythos: character.cthulhuMythos,
    creditRating: character.creditRating,
    duplicate: duplicate.response.action,
  };
}

type WorkerScope = {
  postMessage(message: { status: "ok"; proof: ReturnType<typeof restoreSourceBoundRewardInFreshProcess> } | { status: "error"; message: string }): void;
  addEventListener(type: "message", listener: (event: { data: SourceBoundRewardRestartRequest }) => void): void;
};

const workerScope = globalThis as typeof globalThis & Partial<WorkerScope>;
const isRewardRestartWorker = !import.meta.main && typeof workerScope.postMessage === "function" && typeof workerScope.addEventListener === "function";
if (isRewardRestartWorker) {
  const scope = workerScope as typeof globalThis & WorkerScope;
  scope.addEventListener("message", async (event) => {
    try {
      scope.postMessage({ status: "ok", proof: restoreSourceBoundRewardInFreshProcess(event.data) });
    } catch (error) {
      scope.postMessage({ status: "error", message: error instanceof Error ? error.message : "source-bound reward worker failed" });
    }
  });
}
