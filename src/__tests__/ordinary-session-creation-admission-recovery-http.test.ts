import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { OrdinarySessionCreationAdmissionCoordinator } from "../api/ordinary-session-creation-admission";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ordinary-creation-recovery-http-"));
  roots.add(value);
  return value;
}

function auth(role: "operator" | "keeper" | "player"): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role, id: `${role}:creation-recovery` } });
}

function coordinator(rootPath: string, now: () => number): OrdinarySessionCreationAdmissionCoordinator {
  return new OrdinarySessionCreationAdmissionCoordinator({
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
  });
}

async function recover(
  workspace: string,
  authenticator: CompilerRequestAuthenticator,
  runtime: SessionRuntimeDependencies,
  request = new Request("http://test/api/sessions/creation-admission/recover", { method: "POST" }),
): Promise<Response> {
  return handleRequest(
    request,
    undefined,
    undefined,
    { careerRoot: join(workspace, "careers"), sessionRoot: join(workspace, "sessions") },
    {},
    {},
    authenticator,
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    runtime,
  );
}

describe("ordinary session creation admission recovery HTTP control plane", () => {
  test("authenticates operator authority before coordinator domain, database, or request body observation", async () => {
    const workspace = root();
    const sessionRoot = join(workspace, "sessions");
    mkdirSync(sessionRoot);
    const admission = coordinator(sessionRoot, () => 1_000);
    const runtime = {
      sessionNamespace: new SessionNamespaceCoordinator(sessionRoot),
      ordinarySessionCreationAdmission: admission,
    } satisfies SessionRuntimeDependencies;
    let bodyReads = 0;
    const request = new Proxy(new Request("http://test/api/sessions/creation-admission/recover", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fence: "caller-controlled" }),
    }), {
      get(target, property) {
        if (property === "body") bodyReads++;
        return Reflect.get(target, property, target);
      },
    });

    const keeper = await recover(workspace, auth("keeper"), runtime, request);
    expect(keeper.status).toBe(403);
    expect(bodyReads).toBe(0);
    expect(existsSync(admission.file)).toBe(false);

    const operatorBody = await recover(workspace, auth("operator"), runtime,
      new Request("http://test/api/sessions/creation-admission/recover", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principal: "caller-controlled" }),
      }));
    expect(operatorBody.status).toBe(400);
    expect(existsSync(admission.file)).toBe(false);
  });

  test("requires the injected exact creation-admission domain and exposes only stable recovery outcomes", async () => {
    const workspace = root();
    const sessionRoot = join(workspace, "sessions");
    mkdirSync(sessionRoot);
    let now = 1_000;
    const admission = coordinator(sessionRoot, () => now);
    const runtime = {
      sessionNamespace: new SessionNamespaceCoordinator(sessionRoot),
      ordinarySessionCreationAdmission: admission,
    } satisfies SessionRuntimeDependencies;
    const first = admission.acquire({ principalFingerprint: "a".repeat(64) });
    if (first.status !== "acquired") throw new Error("expected initial creation lease");
    now += 11;
    expect(admission.acquire({ principalFingerprint: "b".repeat(64) })).toMatchObject({
      status: "refused", code: "ORDINARY_CREATION_ADMISSION_UNHEALTHY",
    });

    const recovered = await recover(workspace, auth("operator"), runtime);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({
      status: "recovered",
      code: "ordinary_session_creation_admission_recovered",
      providerOutcome: "unknown",
    });

    const absent = await recover(workspace, auth("operator"), runtime);
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({
      status: "absent",
      code: "ordinary_session_creation_admission_absent",
    });

    const wrong = new OrdinarySessionCreationAdmissionCoordinator({
      root: sessionRoot,
      globalConcurrent: 2,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 4,
      windowMs: 60_000,
      maxTrackedPrincipals: 1_024,
      leaseTtlMs: 60_000,
      wholeJobDeadlineMs: 300_000,
      busyTimeoutMs: 25,
    }, { fileName: ".wrong-creation-admission.sqlite" });
    const mismatch = await recover(workspace, auth("operator"), {
      sessionNamespace: new SessionNamespaceCoordinator(sessionRoot), ordinarySessionCreationAdmission: wrong,
    });
    expect(mismatch.status).toBe(503);
    expect(await mismatch.json()).toEqual({ code: "ordinary_session_creation_admission_recovery_unavailable" });
    expect(existsSync(wrong.file)).toBe(false);

    // This operator control plane must never materialize the direct-handler
    // fallback coordinator: recovery operates only on main's injected owner.
    const uninjected = await recover(workspace, auth("operator"), {
      sessionNamespace: new SessionNamespaceCoordinator(sessionRoot),
    });
    expect(uninjected.status).toBe(503);
    expect(await uninjected.json()).toEqual({ code: "ordinary_session_creation_admission_recovery_unavailable" });
  });
});
