import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GameSession } from "../api/game-session";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { CompilerAutoAdmissionController } from "../api/compiler-auto-admission";
import { createOrdinaryGameSessionSnapshot } from "../api/ordinary-game-session-snapshot";
import {
  ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
  ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT,
  OrdinarySessionSnapshotStore,
  createOrdinarySessionEnvelope,
} from "../api/ordinary-session-snapshot-store";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { SessionNamespaceCoordinator, type DurableSessionIdentity } from "../api/session-namespace-coordinator";
import type { SessionNamespacePublicationGate } from "../api/session-namespace-publication";
import { compiledModuleHttpFixture, hints } from "./helpers/compiled-module-http-fixture";
import { exactReviewBindings } from "./helpers/trusted-presentation-review";

const serverEntry = resolve(import.meta.dir, "..", "api", "server.ts");
const invalidPortPreload = resolve(import.meta.dir, "fixtures", "server-runtime-config-serve-marker-preload.ts");
const cleanupPreload = resolve(import.meta.dir, "fixtures", "server-runtime-config-cleanup-preload.ts");
const creationProviderPreload = resolve(import.meta.dir, "fixtures", "server-runtime-config-creation-provider-marker-preload.ts");
const roots = new Set<string>();
const CONFIG = { apiKey: "sk-runtime-config-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const CTHULHU_DATASET_ROOT = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";

afterEach(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function runtimeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "server-runtime-config-main-"));
  // Hydration uses these normal immutable repository assets relative to the
  // child CWD. The server entrypoint itself remains the real production main.
  mkdirSync(join(root, "src", "rules"), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "..", "rules", "dnd5e.yaml"), join(root, "src", "rules", "dnd5e.yaml"));
  mkdirSync(join(root, "src", "combat"), { recursive: true });
  for (const file of ["dnd-npc.yaml", "coc-npc.yaml", "grail-npc.yaml"]) {
    copyFileSync(resolve(import.meta.dir, "..", "combat", file), join(root, "src", "combat", file));
  }
  roots.add(root);
  return root;
}

function identity(envelope: { envelopeHash: string; generation: number }): DurableSessionIdentity {
  return { hash: envelope.envelopeHash, generation: envelope.generation, format: ORDINARY_SESSION_NAMESPACE_IDENTITY_FORMAT };
}

/** Seeds a valid production ordinary snapshot that has already been idle for two minutes. */
function seedTwoMinuteIdleOrdinary(root: string, id: string): void {
  const namespace = new SessionNamespaceCoordinator(join(root, "data", "runtime-session-namespace"));
  const snapshots = new OrdinarySessionSnapshotStore({ root: join(root, "data", "ordinary-sessions") });
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "runtime-config-cleanup-owner" });
  const source = new GameSession(id, "cosmic-horror", CONFIG, "detective", "Ada", undefined,
    { careerRoot: join(root, "seed-careers") }, access, "development_fallback");
  try {
    const exported = source.exportOrdinarySessionSnapshot();
    const { snapshotHash: _snapshotHash, ...unsigned } = exported;
    const createdAt = Date.now() - 3 * 60_000;
    const snapshot = createOrdinaryGameSessionSnapshot({
      ...unsigned,
      session: { ...unsigned.session, createdAt, lastActiveAt: createdAt + 60_000 },
    });
    const envelope = createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION,
      sessionId: id, generation: 0, previousEnvelopeHash: null, access, snapshot, idempotency: [],
    });
    const gate: SessionNamespacePublicationGate = { required: true, consume: namespace.consumePublicationPermit.bind(namespace) };
    const prepared = namespace.prepare({ reservation: namespace.reserve({ sessionId: id, kind: "ordinary" }), expectedIdentity: identity(envelope) });
    const published = namespace.publishPrepared({
      reservation: prepared,
      publish: (permit) => {
        const saved = snapshots.save(envelope, { permit }, gate);
        if (saved.status !== "ok") return { status: "not-published" as const, failureCode: saved.code };
        const read = snapshots.read(id);
        return read.status === "ok" && read.value.envelopeHash === envelope.envelopeHash
          ? { status: "published" as const, observedIdentity: identity(envelope) }
          : { status: "indeterminate" as const };
      },
    });
    if (published.status !== "committed") throw new Error(`failed to seed ordinary cleanup fixture: ${published.status}`);
  } finally {
    source.close();
  }
}

function startMain(root: string, environment: Record<string, string>, preload?: string): ReturnType<typeof Bun.spawn> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ![
      "PORT",
      "SESSION_TIMEOUT_MINUTES",
      "NODE_ENV",
      "ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS",
      "ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_SESSION",
      "ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS_PER_PRINCIPAL",
      "ORDINARY_SESSION_CREATE_MAX_CONCURRENT",
      "ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL",
      "ORDINARY_SESSION_CREATE_STARTS_PER_PRINCIPAL",
      "ORDINARY_SESSION_CREATE_WINDOW_SECONDS",
      "COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH",
      "CTHULHU_DATASET_PATH",
      "COMPILER_AUTO_ADMISSION_ROOT",
      "COMPILER_CATALOG_ROOT",
    ].includes(key)),
  );
  const command = preload === undefined
    ? [process.execPath, serverEntry]
    : [process.execPath, "--preload", preload, serverEntry];
  return Bun.spawn(command, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, LLM_DISABLED: "1", ...environment },
  });
}

async function stop(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  try { child.kill(); } catch { /* child may already have exited */ }
  await child.exited;
}

async function readChild(child: ReturnType<typeof Bun.spawn>): Promise<{ code: number; stdout: string; stderr: string }> {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout && typeof child.stdout !== "number" ? new Response(child.stdout).text() : Promise.resolve(""),
    child.stderr && typeof child.stderr !== "number" ? new Response(child.stderr).text() : Promise.resolve(""),
  ]);
  return { code, stdout, stderr };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function reservePort(): Promise<number> {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  try {
    if (listener.port === undefined) throw new Error("ephemeral test listener did not report a port");
    return listener.port;
  } finally { await listener.stop(true); }
}

describe("server main runtime config wiring", () => {
  test("fails invalid PORT before inventory or Bun.serve", async () => {
    const root = runtimeRoot();
    const marker = join(root, "serve-called");
    const child = startMain(root, {
      PORT: "0junk",
      SESSION_TIMEOUT_MINUTES: "30",
      NODE_ENV: "production",
      COMPILER_AUTO_ADMISSION_ROOT: "",
      __SERVER_RUNTIME_CONFIG_SERVE_MARKER: marker,
    }, invalidPortPreload);
    const result = await readChild(child);
    expect(result.code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "data"))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).toContain("PORT must be a decimal integer from 1 through 65535");
  }, 15_000);

  test("fails invalid websocket admission limits before inventory or Bun.serve", async () => {
    const root = runtimeRoot();
    const marker = join(root, "serve-called");
    const child = startMain(root, {
      PORT: "3099",
      SESSION_TIMEOUT_MINUTES: "30",
      NODE_ENV: "production",
      ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS: "0junk",
      __SERVER_RUNTIME_CONFIG_SERVE_MARKER: marker,
    }, invalidPortPreload);
    const result = await readChild(child);
    expect(result.code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "data"))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Invalid ORDINARY_SESSION_WEBSOCKET_MAX_CONNECTIONS");
  }, 15_000);

  test("fails invalid creation-admission limits before inventory or Bun.serve", async () => {
    const root = runtimeRoot();
    const marker = join(root, "serve-called");
    const child = startMain(root, {
      PORT: "3099",
      SESSION_TIMEOUT_MINUTES: "30",
      NODE_ENV: "production",
      ORDINARY_SESSION_CREATE_MAX_CONCURRENT: "0junk",
      __SERVER_RUNTIME_CONFIG_SERVE_MARKER: marker,
    }, invalidPortPreload);
    const result = await readChild(child);
    expect(result.code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "data"))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Invalid ORDINARY_SESSION_CREATE_MAX_CONCURRENT");
  }, 15_000);

  test("fails an incompatible automatic-compiler admission policy before inventory or Bun.serve", async () => {
    const root = runtimeRoot();
    const admissionRoot = join(root, "data", "compiler-catalog");
    mkdirSync(admissionRoot, { recursive: true });
    const conflicting = new CompilerAutoAdmissionController({
      root: admissionRoot,
      globalConcurrent: 3,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 4,
      windowMs: 60_000,
      maxTrackedPrincipals: 1_024,
      leaseTtlMs: 60_000,
      wholeJobDeadlineMs: 120_000,
      hardDrainMs: 30_000,
    });
    const seeded = conflicting.acquire({ principalFingerprint: "a".repeat(64), preparedArtifactId: "incompatible-main-policy" });
    if (seeded.status !== "acquired") throw new Error("failed to seed incompatible automatic-admission policy");
    expect(seeded.release()).toBe(true);

    const marker = join(root, "serve-called");
    const child = startMain(root, {
      PORT: "3099",
      SESSION_TIMEOUT_MINUTES: "30",
      NODE_ENV: "production",
      __SERVER_RUNTIME_CONFIG_SERVE_MARKER: marker,
      __SERVER_RUNTIME_CONFIG_SERVE_THROW: "1",
    }, invalidPortPreload);
    const result = await readChild(child);
    expect(result.code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "data", "runtime-session-namespace"))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).toContain("automatic compiler admission policy differs from this process configuration");
  }, 15_000);

  test("fails a malformed automatic-compiler health schema before inventory or Bun.serve", async () => {
    const root = runtimeRoot();
    const admissionRoot = join(root, "data", "compiler-catalog");
    mkdirSync(admissionRoot, { recursive: true });
    const seeded = new CompilerAutoAdmissionController({
      root: admissionRoot,
      globalConcurrent: 2,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 4,
      windowMs: 60_000,
      maxTrackedPrincipals: 1_024,
      leaseTtlMs: 60_000,
      wholeJobDeadlineMs: 120_000,
      hardDrainMs: 30_000,
    });
    seeded.initialize();
    const database = new Database(seeded.file);
    try {
      database.run("DROP TABLE compiler_auto_admission_health");
      database.run("CREATE TABLE compiler_auto_admission_health (singleton INTEGER PRIMARY KEY)");
    } finally {
      database.close();
    }

    const marker = join(root, "serve-called");
    const child = startMain(root, {
      PORT: "3099",
      SESSION_TIMEOUT_MINUTES: "30",
      NODE_ENV: "production",
      __SERVER_RUNTIME_CONFIG_SERVE_MARKER: marker,
      __SERVER_RUNTIME_CONFIG_SERVE_THROW: "1",
    }, invalidPortPreload);
    const result = await readChild(child);
    expect(result.code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "data", "runtime-session-namespace"))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).toContain("automatic compiler admission policy schema is incompatible");
  }, 15_000);

  test("rejects an explicit empty automatic-admission root before inventory or Bun.serve", async () => {
    const root = runtimeRoot();
    const marker = join(root, "serve-called");
    const child = startMain(root, {
      PORT: "3099",
      SESSION_TIMEOUT_MINUTES: "30",
      NODE_ENV: "production",
      COMPILER_AUTO_ADMISSION_ROOT: "",
      __SERVER_RUNTIME_CONFIG_SERVE_MARKER: marker,
      __SERVER_RUNTIME_CONFIG_SERVE_THROW: "1",
    }, invalidPortPreload);
    const result = await readChild(child);
    expect(result.code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, ".compiler-auto-admission.sqlite"))).toBe(false);
    expect(existsSync(join(root, "data", "runtime-session-namespace"))).toBe(false);
    expect(`${result.stdout}\n${result.stderr}`).toContain("invalid compiler automatic admission root");
  }, 15_000);

  test("fails a half-configured or malformed world-model binding policy before inventory or Bun.serve", async () => {
    for (const [label, environment] of [
      ["half", { CTHULHU_DATASET_PATH: CTHULHU_DATASET_ROOT }],
      ["malformed", (() => {
        const path = join(runtimeRoot(), "world-model-policy.json");
        writeFileSync(path, "{ malformed policy", "utf8");
        return { COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: path, CTHULHU_DATASET_PATH: CTHULHU_DATASET_ROOT };
      })()],
    ] as const) {
      const root = label === "malformed"
        ? resolve((environment as { COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: string }).COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH, "..")
        : runtimeRoot();
      const marker = join(root, `serve-called-${label}`);
      const child = startMain(root, {
        PORT: "3099", SESSION_TIMEOUT_MINUTES: "30", NODE_ENV: "production",
        ...environment, __SERVER_RUNTIME_CONFIG_SERVE_MARKER: marker,
      }, invalidPortPreload);
      const result = await readChild(child);
      expect(result.code, label).not.toBe(0);
      expect(existsSync(marker), label).toBe(false);
      expect(existsSync(join(root, "data")), label).toBe(false);
    }
  }, 20_000);

  test("uses SESSION_TIMEOUT_MINUTES=1 for the real main cleanup timer and exposes that same runtime snapshot", async () => {
    const root = runtimeRoot();
    const marker = join(root, "cleanup-closed");
    const port = await reservePort();
    seedTwoMinuteIdleOrdinary(root, "12345678-1234-4123-8123-123456789abc");
    const operatorToken = "o".repeat(32);
    const child = startMain(root, {
      PORT: String(port),
      SESSION_TIMEOUT_MINUTES: "1",
      NODE_ENV: "production",
      COMPILER_OPERATOR_BEARER_TOKEN: operatorToken,
      COMPILER_KEEPER_BEARER_TOKEN: "k".repeat(32),
      __SERVER_RUNTIME_CONFIG_CLEANUP_MARKER: marker,
    }, cleanupPreload);
    try {
      await waitUntil(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
            headers: { Authorization: `Bearer ${operatorToken}` },
          });
          if (!response.ok) return false;
          const body = await response.json() as { server?: unknown };
          return JSON.stringify(body.server) === JSON.stringify({
            port,
            env: "production",
            sessionTimeoutMinutes: 1,
            ordinarySessionWebSocketAdmission: { global: 512, perSession: 4, perPrincipal: 32 },
            ordinarySessionCreationAdmission: { globalConcurrent: 2, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000 },
            compiledWorldModelBindingPolicy: { enabled: false, policyHash: null, bindingCount: 0, datasetId: null, datasetVersion: null },
          });
        } catch {
          return false;
        }
      }, "main config endpoint");
      await waitUntil(() => existsSync(marker), "main cleanup of the two-minute idle ordinary session");
      const afterCleanup = await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      expect(afterCleanup.status).toBe(200);
      expect(await afterCleanup.json()).toMatchObject({
        server: { port, env: "production", sessionTimeoutMinutes: 1 },
        sessionCount: 0,
      });
    } finally {
      await stop(child);
    }
  }, 20_000);

  test("injects the initialized main creation-admission coordinator into POST create", async () => {
    const root = runtimeRoot();
    const port = await reservePort();
    const namespaceRoot = join(root, "data", "runtime-session-namespace");
    mkdirSync(namespaceRoot, { recursive: true });
    const holder = new (await import("../api/ordinary-session-creation-admission")).OrdinarySessionCreationAdmissionCoordinator({
      root: namespaceRoot,
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 4,
      windowMs: 60_000,
      maxTrackedPrincipals: 1_024,
      leaseTtlMs: 60_000,
      wholeJobDeadlineMs: 300_000,
      busyTimeoutMs: 25,
    });
    holder.initialize();
    const held = holder.acquire({ principalFingerprint: "a".repeat(64) });
    if (held.status !== "acquired") throw new Error("expected pre-held main creation-admission lease");
    const operatorToken = "o".repeat(32);
    const keeperToken = "k".repeat(32);
    const providerMarker = join(root, "provider-called");
    const child = startMain(root, {
      PORT: String(port),
      SESSION_TIMEOUT_MINUTES: "30",
      NODE_ENV: "production",
      ORDINARY_SESSION_CREATE_MAX_CONCURRENT: "1",
      ORDINARY_SESSION_CREATE_MAX_CONCURRENT_PER_PRINCIPAL: "1",
      COMPILER_OPERATOR_BEARER_TOKEN: operatorToken,
      COMPILER_KEEPER_BEARER_TOKEN: keeperToken,
      LLM_DISABLED: "0",
      LLM_API_KEY: "test-provider-key",
      LLM_BASE_URL: "http://offline.invalid",
      LLM_MODEL: "offline",
      __SERVER_RUNTIME_CONFIG_CREATION_PROVIDER_MARKER: providerMarker,
    }, creationProviderPreload);
    try {
      await waitUntil(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Authorization: `Bearer ${operatorToken}` } });
          return response.status === 200;
        } catch { return false; }
      }, "main creation-admission listener");
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${keeperToken}` },
        body: JSON.stringify({ archetype: "detective", characterName: "blocked before provider" }),
      });
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: { code: "ORDINARY_SESSION_CREATION_LIMITED" } });
      expect(existsSync(providerMarker)).toBe(false);
    } finally {
      if (held.status === "acquired") held.release();
      await stop(child);
    }
  }, 20_000);

  test("loads the immutable startup policy into the real main resolver and publishes its bound loose-create catalog bundle", async () => {
    const root = runtimeRoot();
    const port = await reservePort();
    const fixture = await compiledModuleHttpFixture("main-world-model-policy");
    const policyPath = join(root, "compiled-world-model-policy.json");
    const moduleId = fixture.resolved.identity.moduleId;
    const artifactHash = fixture.resolved.artifact.artifactHash;
    writeFileSync(policyPath, JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "compiled_cthulhu_world_model_policy",
      bindings: [{
        moduleId, artifactHash, allowedWorkIds: ["the_call_of_cthulhu"],
        corpusScopeId: null, transferPolicy: "analogy_only",
      }],
    }), "utf8");
    const operatorToken = "o".repeat(32);
    const child = startMain(root, {
      PORT: String(port), SESSION_TIMEOUT_MINUTES: "30", NODE_ENV: "production",
      COMPILER_OPERATOR_BEARER_TOKEN: operatorToken,
      COMPILER_KEEPER_BEARER_TOKEN: "k".repeat(32),
      COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: policyPath,
      CTHULHU_DATASET_PATH: CTHULHU_DATASET_ROOT,
    });
    try {
      let configBody: Record<string, unknown> | undefined;
      let lastConfigStatus: number | undefined;
      let lastConfigBody: string | undefined;
      try {
        await waitUntil(async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Authorization: `Bearer ${operatorToken}` } });
            lastConfigStatus = response.status;
            if (!response.ok) lastConfigBody = await response.text();
            if (!response.ok) return false;
            configBody = await response.json() as Record<string, unknown>;
            return true;
          } catch { return false; }
        }, "main world-model policy listener");
      } catch (error) {
        const exited = await Promise.race([child.exited, Bun.sleep(25).then(() => undefined)]);
        if (exited !== undefined) {
          const result = await readChild(child);
          throw new Error(`main world-model policy child exited ${result.code}: ${result.stdout}\n${result.stderr}`, { cause: error });
        }
        throw new Error(`main world-model policy listener did not become ready (last HTTP status: ${lastConfigStatus ?? "unreachable"}, body: ${lastConfigBody ?? "none"})`, { cause: error });
      }
      expect(configBody).toMatchObject({
        server: { compiledWorldModelBindingPolicy: { enabled: true, bindingCount: 1, datasetId: "cthulhu-gutenberg-source-bound", datasetVersion: "1" } },
      });
      const publicConfig = JSON.stringify(configBody);
      expect(publicConfig).not.toContain(policyPath);
      expect(publicConfig).not.toContain(CTHULHU_DATASET_ROOT);
      expect(publicConfig).not.toContain(moduleId);
      expect(publicConfig).not.toContain("the_call_of_cthulhu");

      const catalog = new CompilerArtifactCatalog({ root: join(root, "data", "compiler-catalog") });
      const prepared = catalog.savePrepared(fixture.prepared.artifact);
      if (prepared.status !== "ok") throw new Error(prepared.message);
      const review = catalog.saveTrustedPresentationReview(
        prepared.value.id,
        fixture.prepared.artifact,
        fixture.resolved.artifact,
        "operator:runtime-config-main",
        exactReviewBindings(fixture.resolved.artifact.payload as any),
      );
      if (review.status !== "ok") throw new Error(review.message);
      const resolved = await fetch(`http://127.0.0.1:${port}/api/compiler/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${operatorToken}` },
        body: JSON.stringify({
          preparedArtifactId: prepared.value.id,
          preparedQueueHash: fixture.prepared.identity.preparedQueueHash,
          hints: hints(fixture.prepared),
          presentationReviewId: review.value.id,
        }),
      });
      expect(resolved.status).toBe(200);
      const resolvedBody = await resolved.json() as { bundleId: string };
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/compiled`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${operatorToken}` },
        body: JSON.stringify({ bundleId: resolvedBody.bundleId, archetype: "investigator", characterName: "Ada" }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { bundleId: string };
      expect(JSON.stringify(body)).not.toContain(policyPath);
      expect(JSON.stringify(body)).not.toContain(CTHULHU_DATASET_ROOT);
      expect(catalog.loadBundle(body.bundleId)).toMatchObject({
        status: "ok",
        value: { worldModelBinding: { moduleId, artifactHash, allowedWorkIds: ["the_call_of_cthulhu"] } },
      });
    } finally {
      await stop(child);
    }
  }, 30_000);
});
