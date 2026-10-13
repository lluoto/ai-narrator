import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleCompiledModuleHttpRequest, type CompiledModuleHttpDependencies, type CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { CompilerAutoAdmissionController, type CompilerAutoAdmissionConfig } from "../api/compiler-auto-admission";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { handleRequest } from "../api/server";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "compiler-auto-admission-recovery-http-"));
  roots.add(value);
  return value;
}

function principal(role: "operator" | "keeper" | "player"): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { id: `${role}:recovery-test`, role } });
}

function recoveryDependencies(rootPath: string, recover: () => boolean): CompiledModuleHttpDependencies {
  return {
    generateId: () => "unused",
    hasSession: () => false,
    createSession: () => { throw new Error("recovery route must not create a session"); },
    registerSession: () => { throw new Error("recovery route must not register a session"); },
    persistSession: () => { throw new Error("recovery route must not persist a session"); },
    catalog: new CompilerArtifactCatalog({ root: rootPath }),
    recoverAutoAdmissionReclaimQuarantine: recover,
  };
}

function trackedBodyRequest(): { request: Request; bodyReads: () => number } {
  let reads = 0;
  const request = new Request("http://test/api/compiler/auto-admission/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "operator", recovery: "please" }),
  });
  return {
    request: new Proxy(request, {
      get(target, property) {
        if (property === "body") reads++;
        return Reflect.get(target, property, target);
      },
    }),
    bodyReads: () => reads,
  };
}

function config(rootPath: string, now: () => number): CompilerAutoAdmissionConfig {
  return {
    root: rootPath,
    globalConcurrent: 2,
    perPrincipalConcurrent: 2,
    startsPerPrincipal: 4,
    windowMs: 60_000,
    maxTrackedPrincipals: 8,
    leaseTtlMs: 10,
    wholeJobDeadlineMs: 120,
    now,
  };
}

function acquire(controller: CompilerAutoAdmissionController, principalFingerprint: string, preparedArtifactId: string) {
  return controller.acquire({ principalFingerprint, preparedArtifactId });
}

describe("compiler auto-admission reclaim recovery control plane", () => {
  it("requires host-authenticated operator authority before the recovery callback or request body", async () => {
    const rootPath = root();
    let recoveries = 0;
    const deps = recoveryDependencies(rootPath, () => { recoveries++; return true; });
    const tracked = trackedBodyRequest();

    const keeper = await handleCompiledModuleHttpRequest(tracked.request, {
      ...deps,
      authenticateCompilerRequest: principal("keeper"),
    });
    expect(keeper?.status).toBe(403);
    expect(recoveries).toBe(0);
    expect(tracked.bodyReads()).toBe(0);

    const player = await handleCompiledModuleHttpRequest(
      new Request("http://test/api/compiler/auto-admission/recover", { method: "POST" }),
      { ...deps, authenticateCompilerRequest: principal("player") },
    );
    expect(player?.status).toBe(403);
    expect(recoveries).toBe(0);

    const operatorBody = await handleCompiledModuleHttpRequest(
      new Request("http://test/api/compiler/auto-admission/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fence: "caller-must-not-select" }),
      }),
      { ...deps, authenticateCompilerRequest: principal("operator") },
    );
    expect(operatorBody?.status).toBe(400);
    expect(recoveries).toBe(0);

    const operator = await handleCompiledModuleHttpRequest(
      new Request("http://test/api/compiler/auto-admission/recover", { method: "POST" }),
      { ...deps, authenticateCompilerRequest: principal("operator") },
    );
    expect(operator?.status).toBe(200);
    expect(await operator?.json()).toMatchObject({ status: "ok", recovered: true });
    expect(recoveries).toBe(1);

    // Recovery is an explicit control-plane route, never a hidden field of
    // normal auto-resolve input.
    const ordinaryAutoResolve = await handleCompiledModuleHttpRequest(
      new Request("http://test/api/compiler/auto-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preparedArtifactId: "prepared", preparedQueueHash: "queue", recover: true }),
      }),
      { ...deps, authenticateCompilerRequest: principal("operator") },
    );
    expect(ordinaryAutoResolve?.status).toBe(400);
    expect(recoveries).toBe(1);
  });

  it("recovers only the persisted reclaim fence, preserves a live peer lease, and admits after a crashed owner", async () => {
    const rootPath = root();
    let now = 1_000;
    const shared = config(rootPath, () => now);
    const crashedOwner = new CompilerAutoAdmissionController(shared);
    const liveOwner = new CompilerAutoAdmissionController(shared);
    const restarted = new CompilerAutoAdmissionController(shared);
    const old = acquire(crashedOwner, "a".repeat(64), "crashed-artifact");
    const live = acquire(liveOwner, "b".repeat(64), "still-live-artifact");
    if (old.status !== "acquired" || live.status !== "acquired") throw new Error("expected two initial leases");

    now += 9;
    expect(live.renew()).toMatchObject({ status: "active", expiresAt: 1_019 });
    now += 2;
    // Models a worker crash: no old-owner callback runs. A fresh process sees
    // the old physical slot and writes a durable reclaim quarantine.
    expect(acquire(restarted, "c".repeat(64), "blocked-until-operator-recovery")).toMatchObject({
      status: "refused",
      code: "AUTO_ADMISSION_UNHEALTHY",
    });

    const catalog = new CompilerArtifactCatalog({ root: rootPath });
    const rejectedByKeeper = await handleRequest(
      new Request("http://test/api/compiler/auto-admission/recover", { method: "POST" }),
      catalog,
      undefined,
      {},
      {},
      { isLlmEnabled: () => false, admission: restarted },
      principal("keeper"),
    );
    expect(rejectedByKeeper.status).toBe(403);
    expect(acquire(restarted, "d".repeat(64), "still-quarantined-after-keeper")).toMatchObject({
      status: "refused",
      code: "AUTO_ADMISSION_UNHEALTHY",
    });

    const recovered = await handleRequest(
      new Request("http://test/api/compiler/auto-admission/recover", { method: "POST" }),
      catalog,
      undefined,
      {},
      {},
      { isLlmEnabled: () => false, admission: restarted },
      principal("operator"),
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: "ok", recovered: true });

    // The operator operation may remove only the health row's exact stale
    // fence. A different still-live fence remains an active physical slot.
    expect(live.checkActive()).toMatchObject({ status: "active", fence: live.fence });
    const admittedAfterRecovery = acquire(new CompilerAutoAdmissionController(shared), "c".repeat(64), "replacement-after-crash");
    expect(admittedAfterRecovery.status).toBe("acquired");
    if (admittedAfterRecovery.status === "acquired") admittedAfterRecovery.release();

    const idempotent = await handleRequest(
      new Request("http://test/api/compiler/auto-admission/recover", { method: "POST" }),
      catalog,
      undefined,
      {},
      {},
      { isLlmEnabled: () => false, admission: restarted },
      principal("operator"),
    );
    expect(idempotent.status).toBe(200);
    expect(await idempotent.json()).toMatchObject({ status: "ok", recovered: false });
    expect(live.checkActive()).toMatchObject({ status: "active", fence: live.fence });
    live.release();
    // Each assertion phase opens and fully synchronizes a separate SQLite
    // coordinator connection; the timeout is for the whole durable lifecycle.
  }, 15_000);
});
