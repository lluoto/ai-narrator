import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OrdinarySessionCreationAdmissionCoordinator,
  type OrdinarySessionCreationAdmissionConfig,
} from "../api/ordinary-session-creation-admission";

const roots = new Set<string>();
const children = new Set<ChildProcess>();
const childFile = join(import.meta.dir, "ordinary-session-creation-admission-child.ts");
const CHILD_FIRST_LINE_TIMEOUT_MS = 10_000;
const PROCESS_LEASE_TTL_MS = 5_000;

interface ChildFirstLine {
  event: string;
  status: string;
  code?: string;
  expiresAt?: number;
  deadlineAt?: number;
}

interface ChildProcess {
  process: Bun.Subprocess;
  stdout: Promise<string>;
  stderr: Promise<string>;
}

afterEach(async () => {
  for (const child of children) {
    try { child.process.kill(); } catch { /* already exited */ }
    await child.process.exited;
    await Promise.all([child.stdout, child.stderr]);
  }
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ordinary-creation-admission-"));
  roots.add(value);
  return value;
}

function fingerprint(label: string): string {
  return label.repeat(64).slice(0, 64);
}

function coordinator(overrides: Partial<OrdinarySessionCreationAdmissionConfig> = {}) {
  let now = 1_000;
  const admission = new OrdinarySessionCreationAdmissionCoordinator({
    root: root(),
    globalConcurrent: 2,
    perPrincipalConcurrent: 1,
    startsPerPrincipal: 3,
    windowMs: 60_000,
    maxTrackedPrincipals: 2,
    leaseTtlMs: 30_000,
    wholeJobDeadlineMs: 120_000,
    busyTimeoutMs: 25,
    now: () => now,
    ...overrides,
  });
  return { admission, advance: (milliseconds: number) => { now += milliseconds; } };
}

function acquire(admission: OrdinarySessionCreationAdmissionCoordinator, principal = "a") {
  return admission.acquire({ principalFingerprint: fingerprint(principal) });
}

function connection(file: string, flags: number, afterCommit?: () => boolean) {
  const database = new Database(file, flags);
  return {
    run(sql: string, bindings: readonly (string | number)[] = []) {
      if (bindings.length) database.run(sql, [...bindings]); else database.run(sql);
      if (sql === "COMMIT" && afterCommit?.()) throw new Error("injected acknowledgement failure");
    },
    get<T>(sql: string, bindings: readonly (string | number)[] = []): T | undefined {
      return bindings.length ? database.query(sql).get(...bindings) as T | undefined : database.query(sql).get() as T | undefined;
    },
    all<T>(sql: string, bindings: readonly (string | number)[] = []): T[] {
      return bindings.length ? database.query(sql).all(...bindings) as T[] : database.query(sql).all() as T[];
    },
    pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") {
      const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
      return row ? Object.values(row)[0] : undefined;
    },
    close(throwOnError: true) { database.close(throwOnError); },
  };
}

function firstLineFromChild(stdout: ReadableStream<Uint8Array>): { first: Promise<ChildFirstLine>; drained: Promise<string> } {
  let resolveFirst!: (value: ChildFirstLine) => void;
  let rejectFirst!: (reason: unknown) => void;
  const first = new Promise<ChildFirstLine>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  const drained = (async () => {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let firstSettled = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
        const newline = output.indexOf("\n");
        if (!firstSettled && newline >= 0) {
          firstSettled = true;
          try { resolveFirst(JSON.parse(output.slice(0, newline)) as ChildFirstLine); }
          catch (error) { rejectFirst(error); }
        }
      }
      output += decoder.decode();
      if (!firstSettled) rejectFirst(new Error("ordinary creation admission child exited without a JSON line"));
      return output;
    } catch (error) {
      if (!firstSettled) rejectFirst(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  return { first, drained };
}

function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function child(rootPath: string, principal: string, hold = false, leaseTtlMs = 30_000): Promise<{ process: Bun.Subprocess; first: ChildFirstLine }> {
  const childProcess = Bun.spawn([process.execPath, childFile], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      ORDINARY_CREATION_ADMISSION_ROOT: rootPath,
      ORDINARY_CREATION_ADMISSION_PRINCIPAL: fingerprint(principal),
      ORDINARY_CREATION_ADMISSION_HOLD: hold ? "1" : "",
      ORDINARY_CREATION_ADMISSION_LEASE_TTL_MS: String(leaseTtlMs),
    },
  });
  const observed = firstLineFromChild(childProcess.stdout);
  const tracked = { process: childProcess, stdout: observed.drained, stderr: new Response(childProcess.stderr).text() };
  children.add(tracked);
  return { process: childProcess, first: await within(observed.first, CHILD_FIRST_LINE_TIMEOUT_MS, "ordinary creation admission child first line") };
}

describe("ordinary durable session creation admission", () => {
  test("enforces global and per-principal capacity, while release preserves starts", () => {
    const { admission } = coordinator({ maxTrackedPrincipals: 3 });
    const first = acquire(admission, "a");
    if (first.status !== "acquired") throw new Error("expected first lease");
    const durable = new Database(admission.file);
    try {
      const row = durable.query<{ principal_fingerprint: string }, []>("SELECT principal_fingerprint FROM ordinary_session_creation_admission_leases").get();
      expect(row?.principal_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(row?.principal_fingerprint).not.toBe(fingerprint("a"));
    } finally {
      durable.close();
    }
    expect(acquire(admission, "a")).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_BUSY" });
    const second = acquire(admission, "b");
    expect(second.status).toBe("acquired");
    expect(acquire(admission, "c")).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_BUSY" });
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    if (second.status === "acquired") expect(second.release()).toBe(true);
    const retry = acquire(admission, "a");
    expect(retry.status).toBe("acquired");
    if (retry.status === "acquired") expect(retry.release()).toBe(true);
    const third = acquire(admission, "a");
    expect(third.status).toBe("acquired");
    if (third.status === "acquired") expect(third.release()).toBe(true);
    expect(acquire(admission, "a")).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_RATE_LIMITED" });
  });

  test("persists principal-window capacity and an exact policy identity", () => {
    const sharedRoot = root(); let now = 1_000;
    const config = {
      root: sharedRoot, globalConcurrent: 2, perPrincipalConcurrent: 1, startsPerPrincipal: 3,
      windowMs: 60_000, maxTrackedPrincipals: 2, leaseTtlMs: 30_000, wholeJobDeadlineMs: 120_000,
      busyTimeoutMs: 25, now: () => now,
    } satisfies OrdinarySessionCreationAdmissionConfig;
    const first = new OrdinarySessionCreationAdmissionCoordinator(config);
    const second = new OrdinarySessionCreationAdmissionCoordinator(config);
    for (const principal of ["a", "b"]) {
      const lease = acquire(first, principal);
      expect(lease.status).toBe("acquired");
      if (lease.status === "acquired") expect(lease.release()).toBe(true);
    }
    expect(acquire(second, "c")).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_CAPACITY_EXHAUSTED" });
    const mismatch = new OrdinarySessionCreationAdmissionCoordinator({ ...config, globalConcurrent: 3 });
    expect(acquire(mismatch, "d")).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_POLICY_MISMATCH" });
    now += 60_000;
    expect(acquire(second, "c").status).toBe("acquired");
  });

  test("initializes durable storage and policy without creating a lease or start", () => {
    const sharedRoot = root();
    const config = {
      root: sharedRoot, globalConcurrent: 2, perPrincipalConcurrent: 1, startsPerPrincipal: 3,
      windowMs: 60_000, maxTrackedPrincipals: 3, leaseTtlMs: 30_000, wholeJobDeadlineMs: 120_000, busyTimeoutMs: 25,
    } satisfies OrdinarySessionCreationAdmissionConfig;
    const admission = new OrdinarySessionCreationAdmissionCoordinator(config);
    admission.initialize();
    const durable = new Database(admission.file);
    try {
      expect(durable.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM ordinary_session_creation_admission_leases").get()?.count).toBe(0);
      expect(durable.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM ordinary_session_creation_admission_starts").get()?.count).toBe(0);
    } finally {
      durable.close();
    }
    expect(() => new OrdinarySessionCreationAdmissionCoordinator({ ...config, globalConcurrent: 1 }).initialize()).toThrow("policy differs");
    expect(() => new OrdinarySessionCreationAdmissionCoordinator(config, { schemaVersion: "1.0.1" }).initialize()).toThrow("policy differs");
    expect(() => new OrdinarySessionCreationAdmissionCoordinator(config, {
      pathOps: { kind: (path) => path === sharedRoot ? "directory" : "unsafe" },
    }).initialize()).toThrow("SQLite file or sidecar");
  });

  test("fails closed when rate-limit window arithmetic overflows", () => {
    const { admission } = coordinator({ startsPerPrincipal: 1, windowMs: Number.MAX_SAFE_INTEGER });
    const first = acquire(admission);
    if (first.status !== "acquired") throw new Error("expected first lease");
    expect(first.release()).toBe(true);
    expect(acquire(admission)).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE" });
  });

  test("fails closed for unsafe paths, pragma failure, and post-COMMIT uncertainty", () => {
    const sharedRoot = root();
    const config = { root: sharedRoot, globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 2, windowMs: 60_000, maxTrackedPrincipals: 2, leaseTtlMs: 30_000, wholeJobDeadlineMs: 120_000, busyTimeoutMs: 25 } satisfies OrdinarySessionCreationAdmissionConfig;
    const unsafe = new OrdinarySessionCreationAdmissionCoordinator(config, { pathOps: { kind: (path) => path === sharedRoot ? "directory" : "unsafe" } });
    expect(acquire(unsafe)).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE" });
    const unsafeSidecar = new OrdinarySessionCreationAdmissionCoordinator(config, {
      pathOps: { kind: (path) => path === sharedRoot ? "directory" : path.endsWith("-wal") ? "unsafe" : "missing" },
    });
    expect(acquire(unsafeSidecar)).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE" });
    const badPragma = new OrdinarySessionCreationAdmissionCoordinator(config, {
      connectionFactory: (file, flags) => {
        const current = connection(file, flags);
        return { ...current, pragma: (name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") => name === "journal_mode" ? "wal" : current.pragma(name) };
      },
    });
    expect(acquire(badPragma)).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_STORAGE_UNAVAILABLE" });
    let inject = true;
    const faulty = new OrdinarySessionCreationAdmissionCoordinator(config, { connectionFactory: (file, flags) => connection(file, flags, () => { if (!inject) return false; inject = false; return true; }) });
    expect(acquire(faulty)).toMatchObject({ status: "indeterminate", code: "ORDINARY_CREATION_ADMISSION_INDETERMINATE" });
    expect(acquire(new OrdinarySessionCreationAdmissionCoordinator(config), "b")).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_BUSY" });
  });

  test("never renews past its absolute deadline and quarantines an expired physical lease", () => {
    const sharedRoot = root(); let now = 1_000;
    const config = { root: sharedRoot, globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 3, windowMs: 60_000, maxTrackedPrincipals: 3, leaseTtlMs: 10, wholeJobDeadlineMs: 25, busyTimeoutMs: 25, now: () => now } satisfies OrdinarySessionCreationAdmissionConfig;
    const owner = new OrdinarySessionCreationAdmissionCoordinator(config);
    const replacement = new OrdinarySessionCreationAdmissionCoordinator(config);
    const lease = acquire(owner);
    if (lease.status !== "acquired") throw new Error("expected lease");
    now = 1_009;
    expect(lease.renew()).toMatchObject({ status: "active", deadlineAt: 1_025, expiresAt: 1_019 });
    now = 1_018;
    expect(lease.renew()).toMatchObject({ status: "active", deadlineAt: 1_025, expiresAt: 1_028 });
    now = 1_025;
    expect(lease.checkActive()).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED" });
    now = 1_026;
    expect(lease.renew()).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_LEASE_EXPIRED" });
    expect(acquire(replacement, "b")).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_BUSY" });
    now = 1_030;
    expect(acquire(replacement, "b")).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_UNHEALTHY" });
    expect(replacement.recoverExpiredForOperator()).toMatchObject({ status: "recovered", providerOutcome: "unknown" });
    expect(acquire(replacement, "b").status).toBe("acquired");
  });

  test("does not orphan a second lease when a first quarantine already owns health recovery", () => {
    const sharedRoot = root();
    const config = { root: sharedRoot, globalConcurrent: 2, perPrincipalConcurrent: 1, startsPerPrincipal: 4, windowMs: 60_000, maxTrackedPrincipals: 4, leaseTtlMs: 60_000, wholeJobDeadlineMs: 120_000, busyTimeoutMs: 25 } satisfies OrdinarySessionCreationAdmissionConfig;
    const owner = new OrdinarySessionCreationAdmissionCoordinator(config);
    const operator = new OrdinarySessionCreationAdmissionCoordinator(config);
    const first = acquire(owner, "a"); const second = acquire(owner, "b");
    if (first.status !== "acquired" || second.status !== "acquired") throw new Error("expected both leases");
    expect(first.quarantine()).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_UNHEALTHY" });
    expect(second.quarantine()).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_UNHEALTHY" });
    expect(operator.recoverExpiredForOperator()).toMatchObject({ status: "recovered", providerOutcome: "unknown" });
    expect(second.checkActive()).toMatchObject({ status: "active", fence: second.fence });
    expect(second.release()).toBe(true);
    expect(acquire(operator, "c").status).toBe("acquired");
  });

  test("coordinates real processes and kills do not reopen an expired holder slot", async () => {
    const sharedRoot = root();
    const holder = await child(sharedRoot, "a", true, PROCESS_LEASE_TTL_MS);
    expect(holder.first).toMatchObject({ event: "acquired", status: "acquired" });
    if (typeof holder.first.expiresAt !== "number" || typeof holder.first.deadlineAt !== "number") throw new Error("expected holder expiry and deadline from durable admission");
    expect(holder.first.deadlineAt).toBeGreaterThan(holder.first.expiresAt);
    const contender = await child(sharedRoot, "b", false, PROCESS_LEASE_TTL_MS);
    expect(contender.first).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_BUSY" });
    await contender.process.exited;
    holder.process.kill();
    await holder.process.exited;
    await Bun.sleep(Math.max(0, holder.first.expiresAt - Date.now()));
    const afterKill = await child(sharedRoot, "b", false, PROCESS_LEASE_TTL_MS);
    expect(afterKill.first).toMatchObject({ status: "refused", code: "ORDINARY_CREATION_ADMISSION_UNHEALTHY" });
    await afterKill.process.exited;
  }, 15_000);

  test("rejects malformed or widening configuration before it can open durable state", () => {
    const sharedRoot = root();
    expect(() => new OrdinarySessionCreationAdmissionCoordinator({ root: sharedRoot, globalConcurrent: 0, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1 })).toThrow();
    expect(() => new OrdinarySessionCreationAdmissionCoordinator({ root: sharedRoot, globalConcurrent: 1, perPrincipalConcurrent: 2, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1 })).toThrow();
    expect(() => new OrdinarySessionCreationAdmissionCoordinator({ root: sharedRoot, globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1, busyTimeoutMs: 0 })).toThrow();
  });

  test("uses a durable five-minute whole-job deadline by default", () => {
    const admission = new OrdinarySessionCreationAdmissionCoordinator({
      root: root(), globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1,
    });
    expect(admission.wholeJobDeadlineMs).toBe(300_000);
  });
});
