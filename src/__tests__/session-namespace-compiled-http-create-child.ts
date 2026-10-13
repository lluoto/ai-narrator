import { mkdirSync, readSync } from "fs";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CompiledSessionCreationAdmissionCoordinator, COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY } from "../api/compiled-session-creation-admission";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";

const root = process.env.SESSION_NAMESPACE_HTTP_ROOT;
const id = process.env.SESSION_NAMESPACE_HTTP_ID;
const bundleId = process.env.SESSION_NAMESPACE_HTTP_BUNDLE_ID;
const holdLoad = process.env.SESSION_NAMESPACE_HTTP_HOLD_FACTORY === "1";
const owner = process.env.SESSION_NAMESPACE_HTTP_OWNER;
if (!root || !id || !bundleId || !owner) throw new Error("compiled namespace HTTP child requires root, id, bundle id, and owner");

const namespaceRoot = join(root, "careers", ".runtime-session-namespace");
mkdirSync(namespaceRoot, { recursive: true });
const sessionNamespace = new SessionNamespaceCoordinator(namespaceRoot);
const compiledSessionCreationAdmission = new CompiledSessionCreationAdmissionCoordinator({
  root: sessionNamespace.root,
  ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
});

const registry = new Map<string, GameSession>();
let loadCalls = 0;
const originalLoad = GameSession.prototype.loadDurableCompiledModule;
GameSession.prototype.loadDurableCompiledModule = function (...args: Parameters<GameSession["loadDurableCompiledModule"]>) {
  loadCalls++;
  if (holdLoad) {
    process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);
    readSync(0, new Uint8Array(1), 0, 1, null);
  }
  return originalLoad.apply(this, args);
};

try {
  const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundleId, archetype: "investigator", characterName: "Ada" }),
  }), new CompilerArtifactCatalog({ root: join(root, "catalog") }), new CompiledSessionSnapshotStore({ root: join(root, "snapshots") }),
  { careerRoot: join(root, "careers") }, {}, {},
  () => ({ status: "authenticated", principal: { role: "operator", id: owner } }),
  undefined, undefined, undefined, undefined, {
    registry,
    generateCompiledSessionId: () => id,
    sessionNamespace,
    compiledSessionCreationAdmission,
  } satisfies SessionRuntimeDependencies);
  const body = await response.json() as { error?: { code?: string } };
  process.stdout.write(`${JSON.stringify({ event: "result", result: { status: response.status, code: body.error?.code, loadCalls } })}\n`);
} finally {
  GameSession.prototype.loadDurableCompiledModule = originalLoad;
  for (const session of registry.values()) session.close();
}
