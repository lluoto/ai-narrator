import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { CompiledSessionCreationAdmissionCoordinator } from "../api/compiled-session-creation-admission";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "compiled-creation-recovery-http-"));
  roots.add(value);
  return value;
}

function auth(role: "operator" | "keeper"): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role, id: `${role}:compiled-creation-recovery` } });
}

function admission(rootPath: string, now: () => number, fileName?: string): CompiledSessionCreationAdmissionCoordinator {
  return new CompiledSessionCreationAdmissionCoordinator({
    root: rootPath,
    globalConcurrent: 2,
    perPrincipalConcurrent: 1,
    startsPerPrincipal: 4,
    windowMs: 60_000,
    maxTrackedPrincipals: 1_024,
    leaseTtlMs: 10,
    wholeJobDeadlineMs: 300_000,
    busyTimeoutMs: 25,
    now,
  }, fileName ? { fileName } : undefined);
}

function runtime(rootPath: string, coordinator: CompiledSessionCreationAdmissionCoordinator): SessionRuntimeDependencies {
  return {
    sessionNamespace: new SessionNamespaceCoordinator(rootPath),
    compiledSessionCreationAdmission: coordinator,
  };
}

async function recover(
  rootPath: string,
  authenticator: CompilerRequestAuthenticator,
  sessionRuntime: SessionRuntimeDependencies,
  request = new Request("http://test/api/sessions/compiled-creation-admission/recover", { method: "POST" }),
): Promise<Response> {
  return handleRequest(
    request,
    undefined,
    undefined,
    { sessionRoot: rootPath },
    {}, {}, authenticator, undefined, undefined, undefined, undefined, sessionRuntime,
  );
}

describe("compiled session creation admission recovery HTTP control plane", () => {
  test("authenticates before body or durable admission observation and rejects all caller-selected input", async () => {
    const workspace = root(); let now = 1_000;
    const coordinator = admission(workspace, () => now);
    let bodyReads = 0;
    const body = new Proxy(new Request("http://test/api/sessions/compiled-creation-admission/recover", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fence: "attacker" }),
    }), {
      get(target, property) {
        if (property === "body") bodyReads++;
        return Reflect.get(target, property, target);
      },
    }) as Request;
    const denied = await recover(workspace, auth("keeper"), runtime(workspace, coordinator), body);
    expect(denied.status).toBe(403);
    expect(bodyReads).toBe(0);
    expect(existsSync(coordinator.file)).toBe(false);

    const operatorBody = await recover(workspace, auth("operator"), runtime(workspace, coordinator),
      new Request("http://test/api/sessions/compiled-creation-admission/recover", { method: "POST", body: "{}" }));
    expect(operatorBody.status).toBe(400);
    expect(existsSync(coordinator.file)).toBe(false);

    const operatorQuery = await recover(workspace, auth("operator"), runtime(workspace, coordinator),
      new Request("http://test/api/sessions/compiled-creation-admission/recover?principal=attacker", { method: "POST" }));
    expect(operatorQuery.status).toBe(400);
    expect(existsSync(coordinator.file)).toBe(false);
  });

  test("calls a stateful authenticator exactly once per recovery request and leaves unauthenticated bodies and coordinators untouched", async () => {
    const workspace = root(); let now = 1_000;
    const coordinator = admission(workspace, () => now);
    const calls = new WeakMap<Request, number>();
    const authenticator: CompilerRequestAuthenticator = (req) => {
      const count = (calls.get(req) ?? 0) + 1;
      calls.set(req, count);
      if (count !== 1) throw new Error("recovery must not invoke a stateful authenticator twice");
      return req.headers.get("Authorization") === "Bearer operator"
        ? { status: "authenticated", principal: { id: "operator:stateful", role: "operator" } }
        : { status: "unauthenticated" };
    };
    let bodyReads = 0;
    const denied = new Proxy(new Request("http://test/api/sessions/compiled-creation-admission/recover", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), {
      get(target, property) {
        if (property === "body") bodyReads++;
        return Reflect.get(target, property, target);
      },
    }) as Request;
    const unauthenticated = await recover(workspace, authenticator, runtime(workspace, coordinator), denied);
    expect(unauthenticated.status).toBe(401);
    expect(calls.get(denied)).toBe(1);
    expect(bodyReads).toBe(0);
    expect(existsSync(coordinator.file)).toBe(false);

    const operator = new Request("http://test/api/sessions/compiled-creation-admission/recover", {
      method: "POST", headers: { Authorization: "Bearer operator" },
    });
    const recovered = await recover(workspace, authenticator, runtime(workspace, coordinator), operator);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ status: "absent", code: "compiled_session_creation_admission_absent" });
    expect(calls.get(operator)).toBe(1);
  });

  test("recovers only the injected exact domain and reports unknown provider outcome", async () => {
    const workspace = root(); let now = 1_000;
    const coordinator = admission(workspace, () => now);
    const first = coordinator.acquire({ principalFingerprint: "a".repeat(64) });
    if (first.status !== "acquired") throw new Error("expected first durable lease");
    now += 11;
    expect(coordinator.acquire({ principalFingerprint: "b".repeat(64) })).toMatchObject({
      status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_UNHEALTHY",
    });
    const recovered = await recover(workspace, auth("operator"), runtime(workspace, coordinator));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({
      status: "recovered",
      code: "compiled_session_creation_admission_recovered",
      providerOutcome: "unknown",
    });
    const absent = await recover(workspace, auth("operator"), runtime(workspace, coordinator));
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({ status: "absent", code: "compiled_session_creation_admission_absent" });

    const wrong = admission(workspace, () => now, ".wrong-compiled-creation-admission.sqlite");
    const mismatch = await recover(workspace, auth("operator"), runtime(workspace, wrong));
    expect(mismatch.status).toBe(503);
    expect(await mismatch.json()).toEqual({ code: "compiled_session_creation_admission_recovery_unavailable" });
    expect(existsSync(wrong.file)).toBe(false);

    const uninjected = await recover(workspace, auth("operator"), { sessionNamespace: new SessionNamespaceCoordinator(workspace) });
    expect(uninjected.status).toBe(503);
    expect(await uninjected.json()).toEqual({ code: "compiled_session_creation_admission_recovery_unavailable" });
  });
});
