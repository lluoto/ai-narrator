import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { handleCompiledModuleHttpRequest, type CompiledModuleHttpDependencies } from "../api/compiled-module-http";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { createEnvironmentCompilerAuthenticator, handleRequest } from "../api/server";
import { CompiledSessionCreationAdmissionCoordinator, COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY } from "../api/compiled-session-creation-admission";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";
import { compiledModuleHttpFixture, saveTrustedFixtureBundle } from "./helpers/compiled-module-http-fixture";
import { isolatedNativeFetchIt } from "./helpers/isolated-native-fetch";

const nativeFetchIt = isolatedNativeFetchIt(
  "src/__tests__/compiled-module-http-access-control.test.ts",
  "compiled module HTTP access control",
);

function dependencies(root: string): CompiledModuleHttpDependencies {
  const host = createCompiledDurableTestHost();
  return {
    // Each HTTP fixture owns its opaque server capability. It is never derived
    // from request input, but lets authorization tests reach their intended
    // keeper/object-form boundary instead of failing deployment configuration.
    compiledDurableHostCapability: host.capability,
    compiledSessionCreationAdmission: new CompiledSessionCreationAdmissionCoordinator({
      root,
      ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
    }),
    generateId: () => "compiled1",
    hasSession: () => false,
    createSession: () => { throw new Error("must not create a session"); },
    registerSession: () => { throw new Error("must not register a session"); },
    persistSession: () => { throw new Error("must not persist a session"); },
    catalog: new CompilerArtifactCatalog({ root }),
  };
}

function principal(role: "operator" | "keeper" | "player", id = `${role}:test`) {
  return () => ({ status: "authenticated" as const, principal: { id, role } });
}

function bodyTrackingRequest(request: Request): { request: Request; bodyReads(): number } {
  let reads = 0;
  return {
    request: new Proxy(request, {
      get(target, property) {
        if (property === "body") {
          reads++;
          return null;
        }
        return Reflect.get(target, property, target);
      },
    }),
    bodyReads: () => reads,
  };
}

describe("compiled module HTTP access control", () => {
  it("rejects unauthenticated catalog requests before catalog lookup or body decoding", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-auth-"));
    try {
      let lookedUp = 0;
      const deps = dependencies(root);
      const catalog = deps.catalog!;
      const loadBundle = catalog.loadBundle.bind(catalog);
      (catalog as unknown as { loadBundle(id: string): unknown }).loadBundle = (id) => { lookedUp++; return loadBundle(id); };
      deps.authenticateCompilerRequest = () => ({ status: "unauthenticated" });

      const response = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa", { headers: { "X-Compiler-Role": "operator" } }),
        deps,
      );

      expect(response?.status).toBe(401);
      expect(lookedUp).toBe(0);

      const unreadBody = bodyTrackingRequest(new Request("http://test/api/compiler/prepare?moduleId=private", { method: "POST", headers: { "Content-Type": "application/pdf" } }));
      const prepare = await handleCompiledModuleHttpRequest(
        unreadBody.request,
        deps,
      );
      expect(prepare?.status).toBe(401);
      expect(unreadBody.bodyReads()).toBe(0);

      const loadPrepared = catalog.loadPrepared.bind(catalog);
      (catalog as unknown as { loadPrepared(id: string): unknown }).loadPrepared = (id) => { lookedUp++; return loadPrepared(id); };
      const unreadAutoBody = bodyTrackingRequest(new Request("http://test/api/compiler/auto-resolve", { method: "POST", headers: { "Content-Type": "application/json" } }));
      const automatic = await handleCompiledModuleHttpRequest(unreadAutoBody.request, deps);
      expect(automatic?.status).toBe(401);
      expect(unreadAutoBody.bodyReads()).toBe(0);
      const unreadWorkbenchBody = bodyTrackingRequest(new Request("http://test/api/compiler/presentation-workbench", { method: "POST", headers: { "Content-Type": "application/json" } }));
      const workbench = await handleCompiledModuleHttpRequest(unreadWorkbenchBody.request, deps);
      expect(workbench?.status).toBe(401);
      expect(unreadWorkbenchBody.bodyReads()).toBe(0);
      expect(lookedUp).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed without a host authenticator and ignores caller-declared roles", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-auth-"));
    try {
      const request = new Request("http://test/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa", { headers: { "X-Compiler-Role": "operator" } });
      const unavailable = await handleCompiledModuleHttpRequest(request, dependencies(root));
      expect(unavailable?.status).toBe(503);
      expect(await unavailable?.json()).toMatchObject({ error: { code: "AUTH_CAPABILITY_UNAVAILABLE" } });

      const forged = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa", { headers: { "X-Compiler-Role": "operator", "Authorization": "Bearer not-a-host-token" } }),
        { ...dependencies(root), authenticateCompilerRequest: () => ({ status: "unauthenticated" }) },
      );
      expect(forged?.status).toBe(401);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed host authentication results before compiler side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-auth-"));
    try {
      const deps = dependencies(root);
      const catalog = deps.catalog!;
      let writes = 0;
      const savePrepared = catalog.savePrepared.bind(catalog);
      (catalog as unknown as { savePrepared(value: unknown): unknown }).savePrepared = (value) => { writes++; return savePrepared(value); };
      for (const malformed of [null, {}, { status: "authenticated" }, { status: "unexpected" }]) {
        const tracked = bodyTrackingRequest(new Request("http://test/api/compiler/prepare?moduleId=private", { method: "POST", headers: { "Content-Type": "application/pdf" } }));
        const response = await handleCompiledModuleHttpRequest(tracked.request, {
          ...deps,
          authenticateCompilerRequest: () => malformed as any,
        });
        expect(response?.status).toBe(503);
        expect(await response?.json()).toMatchObject({ error: { code: "AUTH_CAPABILITY_UNAVAILABLE" } });
        expect(tracked.bodyReads()).toBe(0);
      }
      expect(writes).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces operator, keeper, and player capability boundaries before side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-auth-"));
    try {
      let factories = 0;
      const deps = dependencies(root);
      deps.createSession = () => { factories++; throw new Error("must not create a session"); };
      const catalog = deps.catalog!;
      let preparedLookups = 0;
      const loadPrepared = catalog.loadPrepared.bind(catalog);
      (catalog as unknown as { loadPrepared(id: string): unknown }).loadPrepared = (id) => { preparedLookups++; return loadPrepared(id); };

      const player = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa"),
        { ...deps, authenticateCompilerRequest: principal("player") },
      );
      expect(player?.status).toBe(403);

      const playerReview = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/presentation-reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
        { ...deps, authenticateCompilerRequest: principal("player") },
      );
      expect(playerReview?.status).toBe(403);

      const playerWorkbenchRequest = bodyTrackingRequest(new Request("http://test/api/compiler/presentation-workbench", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
      const playerWorkbench = await handleCompiledModuleHttpRequest(
        playerWorkbenchRequest.request,
        { ...deps, authenticateCompilerRequest: principal("player") },
      );
      expect(playerWorkbench?.status).toBe(403);
      expect(playerWorkbenchRequest.bodyReads()).toBe(0);

      const keeperWorkbenchRequest = bodyTrackingRequest(new Request("http://test/api/compiler/presentation-workbench", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
      const keeperWorkbench = await handleCompiledModuleHttpRequest(
        keeperWorkbenchRequest.request,
        { ...deps, authenticateCompilerRequest: principal("keeper") },
      );
      expect(keeperWorkbench?.status).toBe(403);
      expect(keeperWorkbenchRequest.bodyReads()).toBe(0);
      expect(preparedLookups).toBe(0);

      const keeperPrepared = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/artifacts/aaaaaaaaaaaaaaaaaaaaaaaa"),
        { ...deps, authenticateCompilerRequest: principal("keeper") },
      );
      expect(keeperPrepared?.status).toBe(403);

      const keeperBundle = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa"),
        { ...deps, authenticateCompilerRequest: principal("keeper") },
      );
      expect(keeperBundle?.status).toBe(404);

      const keeperObjectSession = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/sessions/compiled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolvedArtifact: {}, projection: {}, archetype: "investigator", characterName: "Ada" }),
        }),
        { ...deps, authenticateCompilerRequest: principal("keeper") },
      );
      expect(keeperObjectSession?.status).toBe(400);
      expect(factories).toBe(0);

      const operator = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa"),
        { ...deps, authenticateCompilerRequest: principal("operator") },
      );
      expect(operator?.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a factory session whose installed durable authority differs from the server capability before loading", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-http-host-authority-"));
    try {
      const fixture = await compiledModuleHttpFixture();
      const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
      const saved = saveTrustedFixtureBundle(catalog, fixture);
      const serverHost = createCompiledDurableTestHost();
      const mismatchedFactoryHost = createCompiledDurableTestHost();
      let loads = 0;
      let persists = 0;
      const response = await handleCompiledModuleHttpRequest(
        new Request("http://test/api/sessions/compiled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundleId: saved.id, archetype: "investigator", characterName: "Ada" }),
        }),
        {
          compiledDurableHostCapability: serverHost.capability,
          compiledSessionCreationAdmission: new CompiledSessionCreationAdmissionCoordinator({
            root: catalog.root,
            ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
          }),
          generateId: () => "compiled-host-mismatch",
          hasSession: () => false,
          createSession: (id, archetype, characterName, persona) => {
            const session = new GameSession(
              id,
              "cosmic-horror",
              undefined,
              archetype,
              characterName,
              persona,
              { careerRoot: join(root, "careers") },
              undefined,
              "preferred",
              mismatchedFactoryHost.runtimeDependencies,
            );
            Object.defineProperty(session, "loadDurableCompiledModule", {
              value: () => {
                loads++;
                return { status: "refused", code: "COMPILED_SESSION_CONFLICT", message: "authority mismatch must reject before module load" };
              },
            });
            return session;
          },
          registerSession: () => { throw new Error("mismatched session must not register"); },
          unregisterSession: (_id, session) => (session as GameSession).close(),
          persistSession: () => {
            persists++;
            throw new Error("mismatched session must not persist");
          },
          catalog,
          authenticateCompilerRequest: principal("keeper"),
        },
      );
      expect(response?.status).toBe(500);
      expect(await response?.json()).toMatchObject({ error: { code: "SESSION_INTERNAL" } });
      expect(loads).toBe(0);
      expect(persists).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  nativeFetchIt("uses only explicit high-entropy bearer configuration and exposes Authorization in CORS", async () => {
    const operatorToken = "operator-token-".padEnd(40, "o");
    const keeperToken = "keeper-token-".padEnd(40, "k");
    const configured = createEnvironmentCompilerAuthenticator({ COMPILER_OPERATOR_BEARER_TOKEN: operatorToken, COMPILER_KEEPER_BEARER_TOKEN: keeperToken });
    expect(configured(new Request("http://test", { headers: { Authorization: "Bearer wrong", "X-Compiler-Role": "operator" } }))).toMatchObject({ status: "unauthenticated" });
    expect(configured(new Request("http://test", { headers: { Authorization: `Bearer ${operatorToken}` } }))).toMatchObject({ status: "authenticated", principal: { id: "operator:environment", role: "operator" } });
    expect(configured(new Request("http://test", { headers: { Authorization: `bEaReR ${operatorToken}` } }))).toMatchObject({ status: "authenticated", principal: { id: "operator:environment", role: "operator" } });
    expect(configured(new Request("http://test", { headers: { Authorization: `Bearer ${keeperToken}` } }))).toMatchObject({ status: "authenticated", principal: { id: "keeper:environment", role: "keeper" } });
    expect(configured(new Request("http://test", { headers: { Authorization: `Bearer ${operatorToken}, Bearer ${keeperToken}` } }))).toMatchObject({ status: "unauthenticated" });
    expect(createEnvironmentCompilerAuthenticator({})(new Request("http://test"))).toMatchObject({ status: "unavailable" });
    expect(createEnvironmentCompilerAuthenticator({ COMPILER_OPERATOR_BEARER_TOKEN: operatorToken })(new Request("http://test"))).toMatchObject({ status: "unavailable" });
    expect(createEnvironmentCompilerAuthenticator({ COMPILER_KEEPER_BEARER_TOKEN: keeperToken })(new Request("http://test"))).toMatchObject({ status: "unavailable" });
    expect(createEnvironmentCompilerAuthenticator({ COMPILER_OPERATOR_BEARER_TOKEN: "short" })(new Request("http://test"))).toMatchObject({ status: "unavailable" });
    expect(createEnvironmentCompilerAuthenticator({ COMPILER_OPERATOR_BEARER_TOKEN: operatorToken, COMPILER_KEEPER_BEARER_TOKEN: operatorToken })(new Request("http://test"))).toMatchObject({ status: "unavailable" });

    const root = mkdtempSync(join(tmpdir(), "compiled-http-auth-server-"));
    const catalog = new CompilerArtifactCatalog({ root });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleRequest(request, catalog, undefined, {}, {}, {}, configured) });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const anonymous = await fetch(`${base}/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa`);
      expect(anonymous.status).toBe(401);
      const operator = await fetch(`${base}/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa`, { headers: { Authorization: `Bearer ${operatorToken}` } });
      expect(operator.status).toBe(404);
      const preflight = await fetch(`${base}/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa`, { method: "OPTIONS", headers: { "Access-Control-Request-Headers": "authorization" } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    } finally {
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
    // This covers a real listener start plus three loopback HTTP round trips.
    // Under the full parallel suite, scheduler delay is not a request deadline.
  }, 15_000);
});
