import { join } from "path";
import { GameSession } from "../api/game-session";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

export interface SourceBoundSanityRestartRequest { root: string; sessionId: string; bundleId: string; input: string; actionId: string; }

export function restoreSourceBoundSanityInFreshProcess(request: SourceBoundSanityRestartRequest): { sanity: unknown; duplicate: unknown } {
  const config = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
  const bundle = new CompilerArtifactCatalog({ root: join(request.root, "catalog") }).loadBundle(request.bundleId);
  const snapshot = new CompiledSessionSnapshotStore({ root: join(request.root, "snapshots") }).read(request.sessionId);
  if (bundle.status !== "ok") throw new Error(bundle.message);
  if (snapshot.status !== "ok") throw new Error(snapshot.message);
  const host = createCompiledDurableTestHost();
  const session = new GameSession(request.sessionId, "cosmic-horror", config, undefined, undefined, undefined, { careerRoot: join(request.root, "sanity-worker-careers") }, undefined, "preferred", host.runtimeDependencies);
  const restored = session.restoreCompiledSession(snapshot.value, bundle.value);
  if (restored.status === "refused") throw new Error(restored.message);
  const duplicate = host.commit(session, request.input, request.actionId, 0, () => {});
  if (duplicate.status !== "duplicate") throw new Error(`fresh SAN retry failed: ${duplicate.status}`);
  const sanity = (session as any).sanity.state;
  return { sanity: { currentSAN: sanity.currentSAN, maxSAN: sanity.maxSAN, temporaryInsanity: sanity.temporaryInsanity, indefiniteInsanity: sanity.indefiniteInsanity, indefiniteLevel: sanity.indefiniteLevel, phobias: sanity.phobias, manias: sanity.manias }, duplicate: duplicate.response.action };
}

type WorkerScope = { postMessage(message: { status: "ok"; proof: ReturnType<typeof restoreSourceBoundSanityInFreshProcess> } | { status: "error"; message: string }): void; addEventListener(type: "message", listener: (event: { data: SourceBoundSanityRestartRequest }) => void): void; };
const workerScope = globalThis as typeof globalThis & Partial<WorkerScope>;
if (!import.meta.main && typeof workerScope.postMessage === "function" && typeof workerScope.addEventListener === "function") {
  const scope = workerScope as typeof globalThis & WorkerScope;
  scope.addEventListener("message", (event) => {
    try { scope.postMessage({ status: "ok", proof: restoreSourceBoundSanityInFreshProcess(event.data) }); }
    catch (error) { scope.postMessage({ status: "error", message: error instanceof Error ? error.message : "source-bound SAN worker failed" }); }
  });
}
