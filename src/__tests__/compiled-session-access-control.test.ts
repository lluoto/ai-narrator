import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CompiledSessionSnapshotStore,
  compiledSessionSnapshotHash,
  validateCompiledSessionSnapshot,
  type CompiledSessionSnapshot,
} from "../api/compiled-session-snapshot";
import { GameSession } from "../api/game-session";
import {
  compiledSessionWebSocketRefusal,
  cleanupExpiredSessions,
  createEnvironmentCompilerAuthenticator,
  handleRequest,
  hydrateCompiledSessions,
} from "../api/server";
import type { CompilerPrincipalRole, CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const ownerId = "keeper:compiled-session-access-owner";
const foreignOwnerId = "keeper:compiled-session-access-foreign";
const owner = authenticated("keeper", ownerId);
const foreign = authenticated("keeper", foreignOwnerId);
// These bounded catalog/snapshot transactions can exceed Bun's 5 s default
// under Windows full-suite file-system load (the route coverage took 10.87 s).
const durableAccessTestTimeoutMs = 15_000;

function authenticated(role: CompilerPrincipalRole, id: string): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role, id } });
}

async function createRealCompiledSession(
  root: string,
  authenticator: CompilerRequestAuthenticator = owner,
  requestHeaders: Record<string, string> = {},
) {
  const registry = new Map<string, GameSession>();
  const fixture = await compiledModuleHttpFixture();
  const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
  const saved = saveTrustedFixtureBundle(catalog, fixture);
  const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots") });
  const response = await handleRequest(new Request("http://test/api/sessions/compiled", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...requestHeaders },
    body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
  }), catalog, snapshots, { careerRoot: join(root, "careers") }, {}, {}, authenticator, undefined, undefined, undefined, undefined, { registry });
  expect(response.status).toBe(201);
  const created = await response.json() as { sessionId: string };
  expect(registry.has(created.sessionId)).toBe(true);
  return { catalog, snapshots, sessionId: created.sessionId, created, root, registry };
}

async function runtime(
  built: Awaited<ReturnType<typeof createRealCompiledSession>>,
  path: string,
  auth: CompilerRequestAuthenticator,
  init: RequestInit = {},
  intentOptions: Record<string, unknown> = {},
  runtimeDiagnostics?: ReadonlyMap<string, { id: string; code: string; message: string }>,
) {
  return handleRequest(
    new Request(`http://test${path}`, init),
    built.catalog,
    built.snapshots,
    { careerRoot: join(built.root, "careers") },
    intentOptions,
    {},
    auth,
    runtimeDiagnostics,
    undefined,
    undefined,
    undefined,
    { registry: built.registry },
  );
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function refusalAuthenticator(status: "unauthenticated" | "unavailable"): CompilerRequestAuthenticator {
  return () => ({ status });
}

function checkedSnapshot(value: unknown): CompiledSessionSnapshot {
  const checked = validateCompiledSessionSnapshot(value);
  if (checked.status !== "ok") throw new Error(checked.message);
  return checked.value;
}

describe("creator-bound compiled-session runtime access", () => {
  it("rejects anonymous, unavailable, malformed, and foreign callers before compiled runtime work", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-session-access-"));
    try {
      const built = await createRealCompiledSession(root);
      const anonymous = await runtime(built, `/api/sessions/${built.sessionId}/state`, refusalAuthenticator("unauthenticated"));
      expect(anonymous.status).toBe(401);
      expect((await anonymous.json() as any).error.code).toBe("AUTHENTICATION_REQUIRED");
      expect((await runtime(built, `/api/sessions/${built.sessionId}/state`, refusalAuthenticator("unavailable"))).status).toBe(503);
      expect((await runtime(built, `/api/sessions/${built.sessionId}/state`, (() => ({ status: "authenticated", principal: { id: "", role: "keeper" } })) as unknown as CompilerRequestAuthenticator)).status).toBe(503);
      const wrongRole = await runtime(built, `/api/sessions/${built.sessionId}/state`, authenticated("operator", ownerId));
      const foreignUnknown = await runtime(built, "/api/sessions/compiled-session-access-unknown/state", foreign);
      expect(wrongRole.status).toBe(404);
      expect(foreignUnknown.status).toBe(404);
      expect((await runtime(built, `/api/sessions/${built.sessionId}/state`, authenticated("keeper", ` ${ownerId} `))).status).toBe(200);

      const before = built.snapshots.read(built.sessionId);
      if (before.status !== "ok") throw new Error(before.message);
      const forbidden = await runtime(built, `/api/sessions/${built.sessionId}/action?role=keeper&principal=${encodeURIComponent(ownerId)}`, foreign, jsonRequest("POST", {
        input: "@compiled find_parent", pcId: "p1", actionId: "foreign-action", expectedGeneration: 0,
        role: "keeper", principal: ownerId,
      }));
      expect(forbidden.status).toBe(404);
      expect(await forbidden.text()).toBe(await foreignUnknown.text());
      expect(built.snapshots.read(built.sessionId)).toEqual(before);

      // The guard executes before the generic JSON decoder can request the
      // stream. A zero high-water mark prevents the stream itself prefetching.
      let bodyPulls = 0;
      const unreadBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          bodyPulls++;
          controller.enqueue(new TextEncoder().encode('{"input":"search","pcId":"p1","expectedGeneration":0}'));
          controller.close();
        },
      }, { highWaterMark: 0 });
      const unread = await runtime(built, `/api/sessions/${built.sessionId}/compiled/intents`, foreign, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: unreadBody,
      });
      expect(unread.status).toBe(404);
      expect(bodyPulls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, durableAccessTestTimeoutMs);

  it("binds every compiled HTTP runtime route to its creator while preserving owner access and durable inheritance", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-session-access-routes-"));
    try {
      const built = await createRealCompiledSession(root);
      expect(built.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      const base = `/api/sessions/${built.sessionId}`;
      const reads = [
        "", "/history?pcId=p1", "/state", "/suggestions?pcId=p1", "/character", "/kp", "/export/json", "/compiled/actions?pcId=p1",
      ];
      for (const suffix of reads) expect((await runtime(built, `${base}${suffix}`, owner)).status).toBe(200);
      for (const suffix of reads) expect((await runtime(built, `${base}${suffix}`, foreign)).status).toBe(404);

      const model = { calls: 0, async chat() { this.calls++; throw new Error("the foreign caller must not invoke a model"); } };
      const protectedPosts: Array<[string, Record<string, unknown>]> = [
        ["/action", { input: "@compiled find_parent", pcId: "p1", actionId: "foreign-generic", expectedGeneration: 0 }],
        ["/kp/set-san", { playerId: "p1", value: 1 }],
        ["/character", { hp: 1 }],
        ["/compiled/actions", { mechanismId: "find_parent", pcId: "p1", actionId: "foreign-structured", expectedGeneration: 0 }],
        ["/compiled/intents", { input: "search", pcId: "p1", expectedGeneration: 0 }],
      ];
      const before = built.snapshots.read(built.sessionId);
      if (before.status !== "ok") throw new Error(before.message);
      for (const [suffix, body] of protectedPosts) {
        const result = await runtime(built, `${base}${suffix}`, foreign, jsonRequest("POST", body), { llm: model, isLlmEnabled: () => true });
        expect(result.status).toBe(404);
      }
      expect(model.calls).toBe(0);
      expect(built.snapshots.read(built.sessionId)).toEqual(before);

      // The owner reaches the existing action semantics; only authentication
      // changes. Generic and structured action paths both use the same
      // replacement/restore transaction.
      const actions = await runtime(built, `${base}/compiled/actions?pcId=p1`, owner);
      const first = (await actions.json() as any).actions.find((entry: any) => entry.mechanismId === "find_parent");
      expect(first).toBeTruthy();
      const generic = await runtime(built, `${base}/action`, owner, jsonRequest("POST", {
        input: first.command, pcId: "p1", actionId: "owner-generic", expectedGeneration: 0,
      }));
      expect(generic.status).toBe(200);
      const afterGeneric = await runtime(built, `${base}/compiled/actions?pcId=p1`, owner);
      const second = (await afterGeneric.json() as any).actions.find((entry: any) => entry.kind === "traversal");
      expect(second).toBeTruthy();
      const structured = await runtime(built, `${base}/compiled/actions`, owner, jsonRequest("POST", {
        mechanismId: second.mechanismId, pcId: "p1", actionId: "owner-structured", expectedGeneration: 1,
      }));
      expect(structured.status).toBe(200);
      // An owner reaches the KP route, which remains mechanically unsupported
      // for compiled sessions rather than being silently authorized to mutate.
      expect((await runtime(built, `${base}/kp/set-san`, owner, jsonRequest("POST", { playerId: "p1", value: 1 }))).status).toBe(409);

      const stored = built.snapshots.read(built.sessionId);
      if (stored.status !== "ok") throw new Error(stored.message);
      const durableSnapshot = checkedSnapshot(stored.value);
      expect(durableSnapshot.access).toMatchObject({ schemaVersion: "3.0.0", ownerRole: "keeper", choiceHmacKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(JSON.stringify(durableSnapshot)).not.toContain(ownerId);
      expect(JSON.stringify(built.created)).not.toContain(ownerId);

      const rehydrated = new Map<string, GameSession>();
      const host = createCompiledDurableTestHost();
      const hydration = hydrateCompiledSessions({
        sessions: rehydrated,
        catalog: built.catalog,
        snapshots: built.snapshots,
        compiledDurableHostCapability: host.capability,
        createSession: (id, runtimeDependencies) => new GameSession(id, "cosmic-horror", undefined, undefined, undefined, undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", runtimeDependencies),
      });
      expect(hydration).toEqual({ hydrated: [built.sessionId], unavailable: [] });
      const restored = rehydrated.get(built.sessionId);
      expect(restored ? host.access(restored) : undefined).toEqual(durableSnapshot.access);
      expect((await runtime(built, `${base}/state`, owner)).status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, durableAccessTestTimeoutMs);

  it("hides compiled session IDs from lists and rejects their legacy query-role WebSocket path", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-session-access-list-"));
    try {
      const built = await createRealCompiledSession(root);
      const listed = async (auth: CompilerRequestAuthenticator) => {
        const response = await runtime(built, "/api/sessions", auth);
        return {
          status: response.status,
          sessions: response.status === 200 ? (await response.json() as any).sessions.map((entry: any) => entry.id) : [],
        };
      };
      expect(await listed(refusalAuthenticator("unauthenticated"))).toEqual({ status: 401, sessions: [] });
      expect((await listed(foreign)).sessions).not.toContain(built.sessionId);
      expect((await listed(owner)).sessions).toContain(built.sessionId);

      const compiled = new Map([[built.sessionId, { getCompiledGeneration: () => 0 } as Pick<GameSession, "getCompiledGeneration">]]);
      expect(compiledSessionWebSocketRefusal(built.sessionId, compiled)?.status).toBe(403);
      const legacy = new Map([["legacy", { getCompiledGeneration: () => null } as Pick<GameSession, "getCompiledGeneration">]]);
      expect(compiledSessionWebSocketRefusal("legacy", legacy)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, durableAccessTestTimeoutMs);

  it("keeps the legacy WS upgrade closed after durable eviction, failed hydration, or an incomplete snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-session-access-ws-authority-"));
    try {
      const built = await createRealCompiledSession(root);
      const expired = new Map<string, Pick<GameSession, "lastActiveAt">>([[built.sessionId, { lastActiveAt: 0 }]]);
      expect(cleanupExpiredSessions(expired, {
        now: 10,
        timeoutMs: 1,
        deleteMetadata: () => undefined,
        isDurableCompiled: () => true,
      })).toEqual([built.sessionId]);
      expect(expired.has(built.sessionId)).toBe(false);
      expect(compiledSessionWebSocketRefusal(built.sessionId, new Map(), built.snapshots)).toMatchObject({ status: 403 });

      const diagnosticId = "22222222-2222-4222-8222-222222222222";
      const diagnostics = new Map([[diagnosticId, { id: diagnosticId, code: "SNAPSHOT_CORRUPT", message: "test-only hydration refusal" }]]);
      expect(compiledSessionWebSocketRefusal(diagnosticId, new Map(), built.snapshots, diagnostics)).toMatchObject({ status: 403 });
      const unknownId = "44444444-4444-4444-8444-444444444444";
      for (const auth of [refusalAuthenticator("unauthenticated"), foreign]) {
        const diagnosticResponse = await runtime(built, `/api/sessions/${diagnosticId}/state`, auth, {}, {}, diagnostics);
        const unknownResponse = await runtime(built, `/api/sessions/${unknownId}/state`, auth, {}, {}, diagnostics);
        expect(diagnosticResponse.status).toBe(unknownResponse.status);
        const diagnosticText = await diagnosticResponse.text();
        const unknownText = await unknownResponse.text();
        expect(diagnosticText).toBe(unknownText);
        expect(diagnosticText).not.toContain("SNAPSHOT_CORRUPT");
        expect(diagnosticText).not.toContain("test-only hydration refusal");
      }

      const incompleteId = "33333333-3333-4333-8333-333333333333";
      writeFileSync(join(root, "snapshots", `${incompleteId}.partial.json`), "not a snapshot");
      expect(built.snapshots.isOccupied(incompleteId)).toBe(true);
      expect(compiledSessionWebSocketRefusal(incompleteId, new Map(), built.snapshots)).toMatchObject({ status: 403 });

      expect(compiledSessionWebSocketRefusal("unknown", new Map(), built.snapshots)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates versioned access bindings as part of the durable snapshot hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-session-access-snapshot-"));
    try {
      const built = await createRealCompiledSession(root);
      const stored = built.snapshots.read(built.sessionId);
      if (stored.status !== "ok") throw new Error(stored.message);
      const invalid = structuredClone(stored.value) as any;
      invalid.access = { schemaVersion: "1.0.0", ownerRole: "player", ownerPrincipalFingerprint: "0".repeat(64) };
      invalid.snapshotHash = compiledSessionSnapshotHash(invalid);
      expect(validateCompiledSessionSnapshot(invalid)).toMatchObject({ status: "refused", code: "SNAPSHOT_INCOMPATIBLE" });
      const legacy = structuredClone(stored.value) as any;
      delete legacy.access;
      legacy.snapshotHash = compiledSessionSnapshotHash(legacy);
      expect(validateCompiledSessionSnapshot(legacy)).toMatchObject({ status: "refused", code: "SNAPSHOT_INCOMPATIBLE" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never stores or returns a raw host principal or bearer credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-session-access-secret-"));
    const operatorToken = "o".repeat(32);
    const keeperToken = "k".repeat(32);
    try {
      const environmentAuth = createEnvironmentCompilerAuthenticator({
        COMPILER_OPERATOR_BEARER_TOKEN: operatorToken,
        COMPILER_KEEPER_BEARER_TOKEN: keeperToken,
      });
      const built = await createRealCompiledSession(root, environmentAuth, { Authorization: `Bearer ${keeperToken}` });
      const snapshot = built.snapshots.read(built.sessionId);
      if (snapshot.status !== "ok") throw new Error(snapshot.message);
      const durableSnapshot = checkedSnapshot(snapshot.value);
      const responseText = JSON.stringify(built.created);
      const snapshotText = JSON.stringify(durableSnapshot);
      for (const forbidden of [keeperToken, operatorToken, "keeper:environment"]) {
        expect(responseText).not.toContain(forbidden);
        expect(snapshotText).not.toContain(forbidden);
      }
      expect(durableSnapshot.access).toMatchObject({ ownerRole: "keeper", ownerPrincipalFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, durableAccessTestTimeoutMs);
});
