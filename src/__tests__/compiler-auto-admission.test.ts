import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  CompilerAutoAdmissionController,
  type CompilerAutoAdmissionConfig,
} from "../api/compiler-auto-admission";

const roots = new Set<string>();
const children = new Set<Child>();

afterEach(async () => {
  await Promise.all([...children].map((child) => child.dispose()));
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "compiler-auto-admission-"));
  roots.add(value);
  return value;
}

function controller(overrides: Partial<CompilerAutoAdmissionConfig> = {}) {
  let now = 1_000;
  const admission = new CompilerAutoAdmissionController({
    root: root(),
    globalConcurrent: 2,
    perPrincipalConcurrent: 1,
    startsPerPrincipal: 4,
    windowMs: 60_000,
    maxTrackedPrincipals: 3,
    leaseTtlMs: 30_000,
    wholeJobDeadlineMs: 120_000,
    now: () => now,
    ...overrides,
  });
  return { admission, advance: (milliseconds: number) => { now += milliseconds; } };
}

function databaseConnection(
  file: string,
  flags: number,
  hooks: { throwAfterCommit?: () => boolean; throwAfterClose?: () => boolean; onClose?: () => void } = {},
) {
  const database = new Database(file, flags);
  return {
    run(sql: string, bindings: readonly (string | number)[] = []) {
      if (bindings.length) database.run(sql, [...bindings]); else database.run(sql);
      if (sql === "COMMIT" && hooks.throwAfterCommit?.()) throw new Error("injected commit acknowledgement failure");
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
    close(throwOnError: true) {
      database.close(throwOnError);
      hooks.onClose?.();
      if (hooks.throwAfterClose?.()) throw new Error("injected post-commit close failure");
    },
  };
}

function fingerprint(label: "a" | "b" | "c" | "d"): string {
  return label.repeat(64);
}

function acquire(admission: CompilerAutoAdmissionController, principal = "a", preparedArtifactId = "artifact-a") {
  return admission.acquire({ principalFingerprint: fingerprint(principal as "a" | "b" | "c" | "d"), preparedArtifactId });
}

const child = join(import.meta.dir, "compiler-auto-admission-child.ts");

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000); });
  return Promise.race([promise, expiry]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
}

interface ChildEvent { event: "acquired" | "result"; result: { status: string; code?: string; released?: boolean }; }
interface Child { next(): Promise<ChildEvent>; release(): void; finish(): Promise<ChildEvent>; dispose(): Promise<void>; }

function spawnChild(rootPath: string, principal: string, artifact: string, options: { hold?: boolean; globalConcurrent?: number } = {}): Child {
  const processHandle = Bun.spawn([process.execPath, child], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      COMPILER_AUTO_ADMISSION_PROCESS_ROOT: rootPath,
      COMPILER_AUTO_ADMISSION_PROCESS_PRINCIPAL: principal,
      COMPILER_AUTO_ADMISSION_PROCESS_ARTIFACT: artifact,
      COMPILER_AUTO_ADMISSION_PROCESS_HOLD: options.hold ? "1" : "",
      COMPILER_AUTO_ADMISSION_PROCESS_GLOBAL: String(options.globalConcurrent ?? 2),
    },
  });
  const events: ChildEvent[] = [];
  let wake: (() => void) | undefined;
  let stdout = "", stderr = "", line = "";
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of processHandle.stdout) {
      const text = decoder.decode(chunk, { stream: true }); stdout += text; line += text;
      for (;;) {
        const end = line.indexOf("\n");
        if (end < 0) break;
        const value = line.slice(0, end); line = line.slice(end + 1);
        try { events.push(JSON.parse(value) as ChildEvent); wake?.(); wake = undefined; } catch { /* finish includes raw child output */ }
      }
    }
  })();
  const stderrDrain = (async () => { stderr = await new Response(processHandle.stderr).text(); })();
  let released = false;
  let disposed = false;
  const handle: Child = {
    async next() {
      while (!events.length) await new Promise<void>((resolve) => { wake = resolve; });
      return events.shift()!;
    },
    release() {
      if (released) return;
      released = true;
      const stdin = processHandle.stdin;
      if (!stdin || typeof stdin === "number") throw new Error("admission child stdin is unavailable");
      stdin.write("x"); stdin.end();
    },
    async finish() {
      const code = await within(processHandle.exited, "admission child exit");
      await within(Promise.all([stdoutDrain, stderrDrain]), "admission child output drain");
      const result = events.find((event) => event.event === "result");
      if (!result) throw new Error(`admission child omitted result (exit ${code}): ${stdout} ${stderr}`);
      children.delete(handle);
      return result;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { handle.release(); } catch { /* child may already have exited */ }
      try {
        await within(processHandle.exited, "admission child cleanup exit");
      } catch {
        try { processHandle.kill(); } catch { /* process may have raced to exit */ }
        try { await within(processHandle.exited, "admission child forced cleanup exit"); } catch { /* Bun reaps shortly after kill */ }
      }
      try { await within(Promise.all([stdoutDrain, stderrDrain]), "admission child cleanup output drain"); } catch { /* cleanup must not hide the test failure */ }
      children.delete(handle);
    },
  };
  children.add(handle);
  return handle;
}

describe("compiler automatic-resolution durable admission", () => {
  it("initializes an exact durable policy without consuming a start or lease", () => {
    const sharedRoot = root();
    const config = {
      root: sharedRoot,
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 1,
      windowMs: 60_000,
      maxTrackedPrincipals: 1,
      leaseTtlMs: 30_000,
      wholeJobDeadlineMs: 120_000,
    } satisfies CompilerAutoAdmissionConfig;
    const admission = new CompilerAutoAdmissionController(config);

    admission.initialize();
    let database = new Database(admission.file);
    try {
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM compiler_auto_admission_leases").get()).toEqual({ count: 0 });
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM compiler_auto_admission_starts").get()).toEqual({ count: 0 });
      database.run("INSERT INTO compiler_auto_admission_health (singleton, drain_fence, owner_instance, heartbeat_expires_at, quarantined_at, recovery_required) VALUES (1, ?, ?, ?, ?, 1)", ["f".repeat(64), "o".repeat(64), 99_999, 1_000]);
    } finally {
      database.close();
    }
    admission.initialize();
    database = new Database(admission.file);
    try {
      expect(database.query<{ drain_fence: string; recovery_required: number }, []>("SELECT drain_fence, recovery_required FROM compiler_auto_admission_health WHERE singleton = 1").get()).toEqual({ drain_fence: "f".repeat(64), recovery_required: 1 });
      database.run("DELETE FROM compiler_auto_admission_health WHERE singleton = 1");
    } finally {
      database.close();
    }
    const first = acquire(admission);
    expect(first.status).toBe("acquired");
    if (first.status === "acquired") expect(first.release()).toBe(true);

    const mismatch = new CompilerAutoAdmissionController({ ...config, globalConcurrent: 2, perPrincipalConcurrent: 1 });
    expect(() => mismatch.initialize()).toThrow("automatic compiler admission policy differs from this process configuration");
  });

  it("fails closed during initialize when an auxiliary durable table is incompatible", () => {
    const sharedRoot = root();
    const config = {
      root: sharedRoot,
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 1,
      windowMs: 60_000,
      maxTrackedPrincipals: 1,
    } satisfies CompilerAutoAdmissionConfig;
    const first = new CompilerAutoAdmissionController(config);
    first.initialize();
    const database = new Database(first.file);
    try {
      database.run("DROP TABLE compiler_auto_admission_health");
      database.run("CREATE TABLE compiler_auto_admission_health (singleton INTEGER PRIMARY KEY)");
    } finally {
      database.close();
    }

    const restarted = new CompilerAutoAdmissionController(config);
    let failure: unknown;
    try {
      restarted.initialize();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "AUTO_ADMISSION_POLICY_MISMATCH" });
  });

  it("uses only exact nonblank root configuration values and preserves explicit precedence", () => {
    const previousAutoRoot = process.env.COMPILER_AUTO_ADMISSION_ROOT;
    const previousCatalogRoot = process.env.COMPILER_CATALOG_ROOT;
    const configuredRoot = root();
    const autoRoot = root();
    const catalogRoot = root();
    try {
      process.env.COMPILER_AUTO_ADMISSION_ROOT = autoRoot;
      process.env.COMPILER_CATALOG_ROOT = catalogRoot;
      expect(new CompilerAutoAdmissionController({ globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1 }).root).toBe(resolve(autoRoot));
      expect(new CompilerAutoAdmissionController({ root: configuredRoot, globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1 }).root).toBe(resolve(configuredRoot));

      delete process.env.COMPILER_AUTO_ADMISSION_ROOT;
      expect(new CompilerAutoAdmissionController({ globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1 }).root).toBe(resolve(catalogRoot));

      for (const [variable, value] of [
        ["COMPILER_AUTO_ADMISSION_ROOT", ""],
        ["COMPILER_AUTO_ADMISSION_ROOT", "  "],
        ["COMPILER_AUTO_ADMISSION_ROOT", ` ${autoRoot} `],
        ["COMPILER_CATALOG_ROOT", ""],
        ["COMPILER_CATALOG_ROOT", "  "],
        ["COMPILER_CATALOG_ROOT", ` ${catalogRoot} `],
      ] as const) {
        delete process.env.COMPILER_AUTO_ADMISSION_ROOT;
        delete process.env.COMPILER_CATALOG_ROOT;
        process.env[variable] = value;
        expect(() => new CompilerAutoAdmissionController({ globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1 })).toThrow("invalid compiler automatic admission root");
      }
      expect(() => new CompilerAutoAdmissionController({ root: " configured-root ", globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1 })).toThrow("invalid compiler automatic admission configuration");
    } finally {
      if (previousAutoRoot === undefined) delete process.env.COMPILER_AUTO_ADMISSION_ROOT;
      else process.env.COMPILER_AUTO_ADMISSION_ROOT = previousAutoRoot;
      if (previousCatalogRoot === undefined) delete process.env.COMPILER_CATALOG_ROOT;
      else process.env.COMPILER_CATALOG_ROOT = previousCatalogRoot;
    }
  });

  it("enforces principal and prepared-artifact leases, exposes a fence, releases idempotently, and then admits again", () => {
    const { admission } = controller();
    const first = acquire(admission);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") throw new Error("expected first admission");

    expect(first.fence).toMatch(/^[a-f0-9]{64}$/);
    expect(first.deadlineAt).toBe(121_000);
    expect(first.checkActive()).toMatchObject({ status: "active", fence: first.fence, deadlineAt: 121_000 });
    expect(acquire(admission, "a", "artifact-b")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY", retryAfterSeconds: 1 });
    expect(acquire(admission, "b", "artifact-a")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY", retryAfterSeconds: 1 });

    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    const retry = acquire(admission, "a", "artifact-b");
    expect(retry.status).toBe("acquired");
  });

  it("does not turn an acknowledged durable commit into an unavailable refusal when close throws", () => {
    const sharedRoot = root();
    const config = {
      root: sharedRoot,
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 4,
      windowMs: 60_000,
      maxTrackedPrincipals: 3,
      leaseTtlMs: 30_000,
      wholeJobDeadlineMs: 120_000,
    } satisfies CompilerAutoAdmissionConfig;
    const faulty = new CompilerAutoAdmissionController(config, {
      connectionFactory: (file, flags) => databaseConnection(file, flags, { throwAfterClose: () => true }),
    });
    const committed = acquire(faulty, "a", "close-failure-artifact");
    expect(committed.status).toBe("acquired");
    const observer = new CompilerAutoAdmissionController(config);
    expect(acquire(observer, "b", "close-failure-other")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY" });
    if (committed.status === "acquired") expect(committed.release()).toBe(true);
  });

  it("reports a post-COMMIT acknowledgement failure as indeterminate while preserving the durable lease", () => {
    const sharedRoot = root();
    const config = {
      root: sharedRoot,
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 4,
      windowMs: 60_000,
      maxTrackedPrincipals: 3,
      leaseTtlMs: 30_000,
      wholeJobDeadlineMs: 120_000,
    } satisfies CompilerAutoAdmissionConfig;
    let inject = true;
    const faulty = new CompilerAutoAdmissionController(config, {
      connectionFactory: (file, flags) => databaseConnection(file, flags, { throwAfterCommit: () => {
        if (!inject) return false;
        inject = false;
        return true;
      } }),
    });
    expect(acquire(faulty, "a", "indeterminate-artifact")).toMatchObject({ status: "indeterminate", code: "AUTO_ADMISSION_INDETERMINATE", retryAfterSeconds: 60 });
    const observer = new CompilerAutoAdmissionController(config);
    expect(acquire(observer, "b", "indeterminate-other")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY" });
  });

  it("closes a newly opened database handle if post-open path verification rejects it", () => {
    const sharedRoot = root();
    let opened = false;
    let closed = false;
    const admission = new CompilerAutoAdmissionController({
      root: sharedRoot,
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 1,
      windowMs: 1,
      maxTrackedPrincipals: 1,
    }, {
      pathOps: {
        kind(path) {
          if (path === sharedRoot) return "directory";
          return opened && path.endsWith(".compiler-auto-admission.sqlite") ? "unsafe" : "missing";
        },
      },
      connectionFactory: (file, flags) => {
        opened = true;
        return databaseConnection(file, flags, { onClose: () => { closed = true; } });
      },
    });
    expect(acquire(admission)).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_STORAGE_UNAVAILABLE" });
    expect(closed).toBe(true);
  });

  it("persists only the already-fingerprinted principal and a derived resource hash", () => {
    const sharedRoot = root();
    const { admission } = controller({ root: sharedRoot });
    const preparedArtifactId = "prepared-artifact-not-for-durable-storage";
    const acquired = acquire(admission, "a", preparedArtifactId);
    if (acquired.status !== "acquired") throw new Error("expected admission");
    const database = new Database(join(sharedRoot, ".compiler-auto-admission.sqlite"));
    try {
      const row = database.query<{ principal_fingerprint: string; resource_hash: string }, []>("SELECT principal_fingerprint, resource_hash FROM compiler_auto_admission_leases").get();
      expect(row).toEqual({
        principal_fingerprint: fingerprint("a"),
        resource_hash: createHash("sha256").update(`compiler-auto-resource-v1|${preparedArtifactId}`).digest("hex"),
      });
      expect(JSON.stringify(row)).not.toContain(preparedArtifactId);
    } finally {
      database.close();
    }
  });

  it("persists global, principal, window, capacity, and policy decisions for a shared root", () => {
    const sharedRoot = root();
    let now = 1_000;
    const config = {
      root: sharedRoot,
      globalConcurrent: 2,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 3,
      windowMs: 60_000,
      maxTrackedPrincipals: 2,
      leaseTtlMs: 30_000,
      wholeJobDeadlineMs: 120_000,
      now: () => now,
    } satisfies CompilerAutoAdmissionConfig;
    const firstProcess = new CompilerAutoAdmissionController(config);
    const secondProcess = new CompilerAutoAdmissionController(config);
    const first = acquire(firstProcess, "a", "artifact-a");
    expect(first.status).toBe("acquired");
    expect(acquire(secondProcess, "a", "artifact-b")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY" });
    expect(acquire(secondProcess, "b", "artifact-a")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY" });
    if (first.status !== "acquired") throw new Error("expected first admission");
    expect(first.release()).toBe(true);

    for (const artifact of ["artifact-b", "artifact-c"]) {
      const acquired = acquire(secondProcess, "a", artifact);
      expect(acquired.status).toBe("acquired");
      if (acquired.status === "acquired") expect(acquired.release()).toBe(true);
    }
    expect(acquire(firstProcess, "a", "artifact-d")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_RATE_LIMITED", retryAfterSeconds: 60 });
    const principalB = acquire(firstProcess, "b", "artifact-b");
    expect(principalB.status).toBe("acquired");
    if (principalB.status === "acquired") expect(principalB.release()).toBe(true);
    expect(acquire(firstProcess, "c", "artifact-c")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_CAPACITY_EXHAUSTED", retryAfterSeconds: 60 });

    const mismatched = new CompilerAutoAdmissionController({ ...config, globalConcurrent: 3 });
    expect(acquire(mismatched, "d", "artifact-d")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_POLICY_MISMATCH", retryAfterSeconds: 60 });

    now += 60_000;
    expect(acquire(firstProcess, "c", "artifact-c").status).toBe("acquired");
  });

  it("turns an expired lease into fail-closed reclaim quarantine until its owner settles or an operator recovers it", () => {
    const sharedRoot = root();
    let now = 1_000;
    const config = {
      root: sharedRoot,
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 3,
      windowMs: 60_000,
      maxTrackedPrincipals: 3,
      leaseTtlMs: 10,
      wholeJobDeadlineMs: 100,
      now: () => now,
    } satisfies CompilerAutoAdmissionConfig;
    const oldProcess = new CompilerAutoAdmissionController(config);
    const replacementProcess = new CompilerAutoAdmissionController(config);
    const oldLease = acquire(oldProcess, "a", "artifact-a");
    if (oldLease.status !== "acquired") throw new Error("expected old lease");

    now += 11;
    const replacement = acquire(replacementProcess, "a", "artifact-a");
    expect(replacement).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_UNHEALTHY", retryAfterSeconds: 60 });
    expect(oldLease.checkActive()).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_LEASE_EXPIRED" });
    // Wall time never clears this quarantine: only the exact old owner can
    // acknowledge its settled provider work, or a trusted operator can.
    now += 10_000;
    expect(acquire(replacementProcess, "b", "artifact-b")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_UNHEALTHY" });
    expect(replacementProcess.recoverReclaimQuarantineForOperator()).toBe(true);
    const recovered = acquire(replacementProcess, "a", "artifact-a");
    expect(recovered.status).toBe("acquired");
    if (recovered.status === "acquired") recovered.release();
  });

  it("keeps physical occupancy through TTL renewal while the whole-job deadline still fences publication", () => {
    const sharedRoot = root();
    let now = 1_000;
    const admission = new CompilerAutoAdmissionController({
      root: sharedRoot,
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 3,
      windowMs: 60_000,
      maxTrackedPrincipals: 3,
      leaseTtlMs: 10,
      wholeJobDeadlineMs: 25,
      now: () => now,
    });
    const lease = acquire(admission);
    if (lease.status !== "acquired") throw new Error("expected lease");
    expect({ expiresAt: lease.expiresAt, deadlineAt: lease.deadlineAt }).toEqual({ expiresAt: 1_010, deadlineAt: 1_025 });
    now = 1_009;
    expect(lease.renew()).toMatchObject({ status: "active", expiresAt: 1_019, deadlineAt: 1_025 });
    now = 1_018;
    expect(lease.renew()).toMatchObject({ status: "active", expiresAt: 1_028, deadlineAt: 1_025 });
    now = 1_025;
    expect(lease.checkActive()).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_LEASE_EXPIRED" });
    expect(acquire(admission, "b", "artifact-b")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY" });
    now = 1_028;
    expect(acquire(admission, "b", "artifact-b")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_UNHEALTHY" });
    expect(admission.recoverReclaimQuarantineForOperator()).toBe(true);
    expect(acquire(admission, "b", "artifact-b").status).toBe("acquired");
  });

  it("keeps a live hard-drain quarantine through restart attempts, then recovers only after its owner heartbeat expires", () => {
    const sharedRoot = root();
    let now = 1_000;
    const config = {
      root: sharedRoot,
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 4,
      windowMs: 60_000,
      maxTrackedPrincipals: 3,
      leaseTtlMs: 10,
      wholeJobDeadlineMs: 20,
      hardDrainMs: 30,
      now: () => now,
    } satisfies CompilerAutoAdmissionConfig;
    const stuckOwner = new CompilerAutoAdmissionController(config);
    const held = acquire(stuckOwner, "a", "stuck-artifact");
    if (held.status !== "acquired") throw new Error("expected held admission");
    expect(held.quarantine()).toMatchObject({ status: "quarantined", fence: held.fence });

    const restartedWhileLive = new CompilerAutoAdmissionController(config);
    expect(acquire(restartedWhileLive, "b", "restart-while-live")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_UNHEALTHY", retryAfterSeconds: 1 });
    now += 25;
    expect(held.renewQuarantine()).toMatchObject({ status: "quarantined", fence: held.fence });
    expect(acquire(restartedWhileLive, "b", "restart-after-heartbeat")).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_UNHEALTHY" });

    // No more guardian renewal models a process death. Only then may a fresh
    // instance delete the expired health record and admit new model work.
    now += 31;
    const recovered = acquire(new CompilerAutoAdmissionController(config), "b", "restart-after-death");
    expect(recovered.status).toBe("acquired");
    if (recovered.status === "acquired") recovered.release();
  });

  it("enforces a persisted policy and single-flight lease across real Bun processes", async () => {
    const sharedRoot = root();
    const principal = fingerprint("a");
    const holder = spawnChild(sharedRoot, principal, "shared-artifact", { hold: true });
    expect(await within(holder.next(), "holder admission")).toMatchObject({ event: "acquired", result: { status: "acquired" } });

    const contender = spawnChild(sharedRoot, fingerprint("b"), "shared-artifact");
    expect((await contender.finish()).result).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_BUSY", retryAfterSeconds: 1 });
    const mismatch = spawnChild(sharedRoot, fingerprint("c"), "other-artifact", { globalConcurrent: 3 });
    expect((await mismatch.finish()).result).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_POLICY_MISMATCH", retryAfterSeconds: 60 });

    holder.release();
    expect((await holder.finish()).result).toMatchObject({ status: "released", released: true });
    const replacement = spawnChild(sharedRoot, fingerprint("b"), "shared-artifact");
    expect(await within(replacement.next(), "replacement admission")).toMatchObject({ event: "acquired", result: { status: "acquired" } });
    expect((await replacement.finish()).result).toMatchObject({ status: "released", released: true });
  }, 20_000);

  it("rejects invalid configuration immediately and turns an unavailable root into a typed fail-closed refusal", () => {
    expect(() => new CompilerAutoAdmissionController({ root: root(), globalConcurrent: 0, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1 })).toThrow();
    expect(() => new CompilerAutoAdmissionController({ root: root(), globalConcurrent: 1, perPrincipalConcurrent: 2, startsPerPrincipal: 1, windowMs: 1, maxTrackedPrincipals: 1 })).toThrow();
    expect(() => new CompilerAutoAdmissionController({ root: root(), globalConcurrent: 1, perPrincipalConcurrent: 1, startsPerPrincipal: 1, windowMs: 0, maxTrackedPrincipals: 1 })).toThrow();
    const unavailable = new CompilerAutoAdmissionController({
      root: join(root(), "missing", "coordinator-root"),
      globalConcurrent: 1,
      perPrincipalConcurrent: 1,
      startsPerPrincipal: 1,
      windowMs: 1,
      maxTrackedPrincipals: 1,
    });
    expect(acquire(unavailable)).toMatchObject({ status: "refused", code: "AUTO_ADMISSION_STORAGE_UNAVAILABLE", retryAfterSeconds: 60 });
  });
});
