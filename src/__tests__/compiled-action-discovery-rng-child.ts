import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { handleRequest } from "../api/server";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const RNG_ISOLATION_RESULT = "@@compiled-action-discovery-rng@@";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "compiled-action-discovery-rng-"));
  const originalRandom = Math.random;
  const ownedSessions = new Set<GameSession>();
  const registry = new Map<string, GameSession>();
  const cleanupFailures = new Set<unknown>();
  let primaryFailure: unknown;
  let failed = false;
  try {
    const fixture = await compiledModuleHttpFixture();
    const catalog = new CompilerArtifactCatalog({ root: join(dir, "catalog") });
    const saved = saveTrustedFixtureBundle(catalog, fixture, "keeper:rng-isolation");
    const bundle = catalog.loadBundle(saved.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);

    Math.random = () => 100_000;
    const host = createCompiledDurableTestHost();
    const session = new GameSession(
      "compiled-deterministic-character", "cosmic-horror", CONFIG, "investigator", "Ada", undefined,
      { careerRoot: join(dir, "careers") }, undefined, "preferred", host.runtimeDependencies,
    );
    ownedSessions.add(session);
    if (session.loadDurableCompiledModule(bundle.value).status === "refused") throw new Error("durable compiled module refused");
    host.snapshot(session);
    const snapshots = new CompiledSessionSnapshotStore({ root: join(dir, "snapshots") });
    const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
    }), catalog, snapshots, { careerRoot: join(dir, "http-careers") }, {}, {}, () => ({ status: "authenticated" as const, principal: { id: "keeper:rng-isolation", role: "keeper" as const } }), undefined, undefined, undefined, undefined, { registry });
    if (response.status !== 201) throw new Error(`compiled HTTP create failed: ${response.status} ${await response.text()}`);
    const created = await response.json() as { sessionId?: unknown };
    if (typeof created.sessionId !== "string" || snapshots.read(created.sessionId).status !== "ok") {
      throw new Error("compiled HTTP create did not persist a valid snapshot");
    }
    console.log(`${RNG_ISOLATION_RESULT}${JSON.stringify({ snapshot: "ok", httpSnapshot: "ok", restoredContamination: Math.random() === 100_000 })}`);
  } catch (error) {
    failed = true;
    primaryFailure = error;
  } finally {
    try {
      for (const session of new Set([...ownedSessions, ...registry.values()])) {
        try {
          session.close();
        } catch (error) {
          cleanupFailures.add(error);
        }
      }
    } finally {
      registry.clear();
    }
    try {
      Math.random = originalRandom;
    } catch (error) {
      cleanupFailures.add(error);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.add(error);
    }
  }
  if (failed) {
    if (cleanupFailures.size > 0) throw new AggregateError([primaryFailure, ...cleanupFailures], "RNG child fixture and cleanup failed");
    throw primaryFailure;
  }
  if (cleanupFailures.size === 1) throw cleanupFailures.values().next().value;
  if (cleanupFailures.size > 1) throw new AggregateError(cleanupFailures, "RNG child fixture cleanup failed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
