import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { CompiledSessionCreationAdmissionCoordinator, COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY } from "../api/compiled-session-creation-admission";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";

function coldRuntime(root: string, storageFault: boolean): {
  storage: { careerRoot: string; sessionRoot: string };
  compiled: CompiledSessionSnapshotStore;
  runtime: SessionRuntimeDependencies;
  inventoryCalls(): number;
} {
  const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
  const compiled = new CompiledSessionSnapshotStore({ root: join(root, "compiled") });
  const ordinary = new OrdinarySessionSnapshotStore({ root: join(root, "ordinary") });
  const namespaceRoot = join(root, "namespace");
  mkdirSync(namespaceRoot, { recursive: true });
  const namespace = new SessionNamespaceCoordinator(namespaceRoot);
  const compiledSessionCreationAdmission = new CompiledSessionCreationAdmissionCoordinator({
    root: namespace.root,
    ...COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
  });
  let inventoryCalls = 0;
  const originalInitialize = namespace.initialize.bind(namespace);
  const originalReconcile = namespace.reconcile.bind(namespace);
  (namespace as unknown as { initialize(): void }).initialize = () => {
    inventoryCalls++;
    if (storageFault) throw new Error("test-only namespace storage fault");
    originalInitialize();
  };
  (namespace as unknown as { reconcile(): void }).reconcile = () => {
    inventoryCalls++;
    originalReconcile();
  };
  return {
    storage,
    compiled,
    runtime: {
      registry: new Map(),
      ordinarySnapshots: ordinary,
      sessionNamespace: namespace,
      compiledSessionCreationAdmission,
      ordinaryIntentPolicy: "development_fallback",
    },
    inventoryCalls: () => inventoryCalls,
  };
}

function compiledCreateRequest(): Request {
  return new Request("http://test/api/sessions/compiled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

function compilerRouteRequest(pathname: string, method: "GET" | "POST"): Request {
  return new Request(`http://test${pathname}`, method === "GET" ? {} : {
    method,
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

function authenticator(result: unknown): CompilerRequestAuthenticator {
  return () => result as ReturnType<CompilerRequestAuthenticator>;
}

describe("compiled session cold-path authentication", () => {
  it("authenticates every compiler policy family before any durable inventory, including a storage fault", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-cold-auth-"));
    try {
      const routes = [
        ["artifact", "/api/compiler/artifacts/aaaaaaaaaaaaaaaaaaaaaaaa", "GET"],
        ["bundle", "/api/compiler/bundles/aaaaaaaaaaaaaaaaaaaaaaaa", "GET"],
        ["prepare", "/api/compiler/prepare?moduleId=cold-auth", "POST"],
        ["resolve", "/api/compiler/resolve", "POST"],
        ["auto-resolve", "/api/compiler/auto-resolve", "POST"],
        ["presentation-workbench", "/api/compiler/presentation-workbench", "POST"],
        ["presentation-reviews", "/api/compiler/presentation-reviews", "POST"],
        ["auto-admission-recover", "/api/compiler/auto-admission/recover", "POST"],
        ["compiled-create", "/api/sessions/compiled", "POST"],
      ] as const;
      for (const [authName, auth, status] of [
        ["unauthenticated", authenticator({ status: "unauthenticated" }), 401],
        ["malformed", authenticator({ status: "authenticated" }), 503],
        ["wrong-role", authenticator({ status: "authenticated", principal: { id: "player:wrong", role: "player" } }), 403],
      ] as const) {
        for (const [routeName, pathname, method] of routes) {
          const cold = coldRuntime(join(root, `${authName}-${routeName}`), true);
          const response = await handleRequest(compilerRouteRequest(pathname, method), undefined, cold.compiled, cold.storage, {}, {}, auth, undefined, undefined, undefined, undefined, cold.runtime);
          expect(response.status).toBe(status);
          expect(cold.inventoryCalls()).toBe(0);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still initializes the durable inventory for an authenticated compiled creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-cold-auth-"));
    try {
      const cold = coldRuntime(root, false);
      const response = await handleRequest(
        compiledCreateRequest(),
        undefined,
        cold.compiled,
        cold.storage,
        {},
        {},
        authenticator({ status: "authenticated", principal: { id: "operator:trusted", role: "operator" } }),
        undefined,
        undefined,
        undefined,
        undefined,
        cold.runtime,
      );
      expect(response.status).toBe(400);
      expect(cold.inventoryCalls()).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries one cold-path authorization into compiled creation without authenticating twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-cold-auth-"));
    try {
      const cold = coldRuntime(root, false);
      let authenticationCalls = 0;
      const singleUseAuthenticator: CompilerRequestAuthenticator = () => {
        authenticationCalls++;
        return authenticationCalls === 1
          ? { status: "authenticated", principal: { id: "operator:single-use", role: "operator" } }
          : { status: "unauthenticated" };
      };
      const response = await handleRequest(
        compiledCreateRequest(),
        undefined,
        cold.compiled,
        cold.storage,
        {},
        {},
        singleUseAuthenticator,
        undefined,
        undefined,
        undefined,
        undefined,
        cold.runtime,
      );
      expect(authenticationCalls).toBe(1);
      expect(cold.inventoryCalls()).toBeGreaterThan(0);
      expect(response.status).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
