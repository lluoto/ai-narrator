import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  COMPILED_SESSION_CREATION_ADMISSION_DOMAIN,
  COMPILED_SESSION_CREATION_ADMISSION_FILE_NAME,
  COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY,
  CompiledSessionCreationAdmissionCoordinator,
  type CompiledSessionCreationAdmissionConfig,
} from "../api/compiled-session-creation-admission";

const roots = new Set<string>();
const children = new Set<Bun.Subprocess>();
const childFile = join(import.meta.dir, "compiled-session-creation-admission-child.ts");

afterEach(async () => {
  for (const child of children) {
    try { child.kill(); } catch { /* already exited */ }
    await child.exited;
  }
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "compiled-creation-admission-"));
  roots.add(value);
  return value;
}

function principal(label: string): string {
  return label.repeat(64).slice(0, 64);
}

function config(rootPath: string, now: () => number): CompiledSessionCreationAdmissionConfig {
  return {
    root: rootPath,
    globalConcurrent: 2,
    perPrincipalConcurrent: 1,
    startsPerPrincipal: 3,
    windowMs: 60_000,
    maxTrackedPrincipals: 3,
    leaseTtlMs: 10,
    wholeJobDeadlineMs: 25,
    busyTimeoutMs: 25,
    now,
  };
}

function firstChildLine(stream: ReadableStream<Uint8Array>): Promise<{ status: string; code?: string }> {
  return new Promise(async (resolve, reject) => {
    const reader = stream.getReader(); const decoder = new TextDecoder(); let text = "";
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) throw new Error("compiled creation admission child ended before acquisition");
        text += decoder.decode(part.value, { stream: true });
        const newline = text.indexOf("\n");
        if (newline < 0) continue;
        resolve(JSON.parse(text.slice(0, newline)) as { status: string; code?: string });
        return;
      }
    } catch (error) { reject(error); }
    finally { reader.releaseLock(); }
  });
}

describe("compiled durable session creation admission", () => {
  test("uses an isolated durable domain, fences capacity, and requires operator recovery after expiry", () => {
    const sharedRoot = root();
    let now = 1_000;
    const first = new CompiledSessionCreationAdmissionCoordinator(config(sharedRoot, () => now));
    const second = new CompiledSessionCreationAdmissionCoordinator(config(sharedRoot, () => now));

    expect(first.file).toBe(join(first.root, COMPILED_SESSION_CREATION_ADMISSION_FILE_NAME));
    expect(COMPILED_SESSION_CREATION_ADMISSION_DOMAIN).toBe("compiled-session-creation-admission");
    expect(COMPILED_SESSION_CREATION_ADMISSION_PRODUCTION_POLICY).toMatchObject({ globalConcurrent: 2, perPrincipalConcurrent: 1 });

    const held = first.acquire({ principalFingerprint: principal("a") });
    if (held.status !== "acquired") throw new Error("expected compiled creation lease");
    expect(second.acquire({ principalFingerprint: principal("a") })).toMatchObject({
      status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_BUSY",
    });
    const peer = second.acquire({ principalFingerprint: principal("b") });
    if (peer.status !== "acquired") throw new Error("expected peer compiled creation lease");
    expect(peer.release()).toBe(true);

    now = 1_010;
    expect(held.checkActive()).toMatchObject({ status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_LEASE_EXPIRED" });
    // A late owner finalizer cannot silently turn the persisted unknown
    // outcome into fresh capacity; recovery is operator-only.
    expect(held.release()).toBe(false);
    expect(second.acquire({ principalFingerprint: principal("c") })).toMatchObject({
      status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_UNHEALTHY",
    });
    expect(second.recoverExpiredForOperator()).toEqual({ status: "recovered", providerOutcome: "unknown" });
    expect(second.acquire({ principalFingerprint: principal("c") }).status).toBe("acquired");
  });

  test("caps renewals at the absolute deadline and durably quarantines deadline expiry before a late release", () => {
    const sharedRoot = root(); let now = 1_000;
    const first = new CompiledSessionCreationAdmissionCoordinator(config(sharedRoot, () => now));
    const peer = new CompiledSessionCreationAdmissionCoordinator(config(sharedRoot, () => now));
    const held = first.acquire({ principalFingerprint: principal("a") });
    if (held.status !== "acquired") throw new Error("expected compiled creation lease");
    expect(held).toMatchObject({ expiresAt: 1_010, deadlineAt: 1_025 });

    now = 1_008;
    expect(held.renew()).toEqual({ status: "active", fence: held.fence, expiresAt: 1_018, deadlineAt: 1_025 });
    now = 1_016;
    expect(held.renew()).toEqual({ status: "active", fence: held.fence, expiresAt: 1_025, deadlineAt: 1_025 });
    now = 1_025;
    expect(held.checkActive()).toMatchObject({
      status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_LEASE_EXPIRED",
    });
    // Deadline expiry is a persisted unknown-outcome boundary, so a late
    // exact-owner finalizer is both harmless and idempotent.
    expect(held.release()).toBe(false);
    expect(held.release()).toBe(false);
    expect(peer.acquire({ principalFingerprint: principal("b") })).toMatchObject({
      status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_UNHEALTHY",
    });
    expect(peer.recoverExpiredForOperator()).toEqual({ status: "recovered", providerOutcome: "unknown" });
  });

  test("keeps policy identity durable and fails closed on an incompatible coordinator", () => {
    const sharedRoot = root();
    const stable = config(sharedRoot, () => 1_000);
    new CompiledSessionCreationAdmissionCoordinator(stable).initialize();
    const mismatch = new CompiledSessionCreationAdmissionCoordinator({ ...stable, globalConcurrent: 3 });
    expect(mismatch.acquire({ principalFingerprint: principal("a") })).toMatchObject({
      status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_POLICY_MISMATCH",
    });
  });

  test("stores only salted principal evidence, preserves starts across restart, and fails closed for unsafe paths", () => {
    const sharedRoot = root(); let now = 1_000;
    const stable = config(sharedRoot, () => now);
    const first = new CompiledSessionCreationAdmissionCoordinator(stable);
    for (let index = 0; index < 3; index++) {
      const lease = first.acquire({ principalFingerprint: principal("a") });
      if (lease.status !== "acquired") throw new Error("expected durable start");
      expect(lease.release()).toBe(true);
    }
    const database = new Database(first.file);
    try {
      const stored = database.query<{ principal_fingerprint: string }, []>("SELECT principal_fingerprint FROM compiled_session_creation_admission_starts LIMIT 1").get();
      expect(stored?.principal_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(stored?.principal_fingerprint).not.toBe(principal("a"));
    } finally { database.close(); }
    const restarted = new CompiledSessionCreationAdmissionCoordinator(stable);
    expect(restarted.acquire({ principalFingerprint: principal("a") })).toMatchObject({
      status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_RATE_LIMITED",
    });
    now += 60_000;
    expect(restarted.acquire({ principalFingerprint: principal("a") }).status).toBe("acquired");
    const unsafe = new CompiledSessionCreationAdmissionCoordinator(stable, {
      pathOps: { kind: (path) => path === sharedRoot ? "directory" : "unsafe" },
    });
    expect(unsafe.acquire({ principalFingerprint: principal("b") })).toMatchObject({
      status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_STORAGE_UNAVAILABLE",
    });
  });

  test("enforces the global SQLite lease across a second Bun process", async () => {
    const sharedRoot = root();
    const child = Bun.spawn([process.execPath, childFile], {
      cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, COMPILED_CREATION_ADMISSION_ROOT: sharedRoot, COMPILED_CREATION_ADMISSION_PRINCIPAL: principal("a") },
    });
    children.add(child);
    if (typeof child.stdout === "number" || !child.stdin || typeof child.stdin === "number") throw new Error("child streams unavailable");
    await expect(firstChildLine(child.stdout)).resolves.toEqual({ status: "acquired" });
    const parent = new CompiledSessionCreationAdmissionCoordinator({
      root: sharedRoot, globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 4,
      windowMs: 60_000, maxTrackedPrincipals: 8, leaseTtlMs: 30_000, wholeJobDeadlineMs: 120_000, busyTimeoutMs: 25,
    });
    expect(parent.acquire({ principalFingerprint: principal("b") })).toMatchObject({
      status: "refused", code: "COMPILED_SESSION_CREATION_ADMISSION_BUSY",
    });
    child.stdin.write(new Uint8Array([1]));
    await expect(child.exited).resolves.toBe(0);
    const after = parent.acquire({ principalFingerprint: principal("b") });
    expect(after.status).toBe("acquired");
    if (after.status === "acquired") after.release();
  }, 15_000);

  test("serializes simultaneous first acquisition on a fresh SQLite domain without storage-unavailable fallout", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sharedRoot = root();
      const contenders = ["a", "b"].map((label) => {
        const child = Bun.spawn([process.execPath, childFile], {
          cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
          env: {
            ...process.env,
            COMPILED_CREATION_ADMISSION_ROOT: sharedRoot,
            COMPILED_CREATION_ADMISSION_PRINCIPAL: principal(label),
            COMPILED_CREATION_ADMISSION_WAIT_FOR_START: "1",
          },
        });
        children.add(child);
        if (typeof child.stdout === "number" || !child.stdin || typeof child.stdin === "number") throw new Error("child streams unavailable");
        return { child, first: firstChildLine(child.stdout) };
      });
      for (const { child } of contenders) {
        if (!child.stdin || typeof child.stdin === "number") throw new Error("child stdin unavailable");
        child.stdin.write(new Uint8Array([1]));
      }
      const outcomes = await Promise.all(contenders.map(({ first }) => first));
      expect(outcomes.filter((outcome) => outcome.status === "acquired")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "refused" && outcome.code === "COMPILED_SESSION_CREATION_ADMISSION_BUSY")).toHaveLength(1);
      for (let index = 0; index < contenders.length; index++) {
        if (outcomes[index]!.status !== "acquired") continue;
        const stdin = contenders[index]!.child.stdin;
        if (!stdin || typeof stdin === "number") throw new Error("child stdin unavailable");
        stdin.write(new Uint8Array([1]));
      }
      await Promise.all(contenders.map(({ child }) => child.exited));
    }
  }, 15_000);
});
