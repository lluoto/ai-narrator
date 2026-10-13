import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import {
  COMPILED_INTENT_ADMISSION_DOMAIN,
  CompiledIntentAdmissionCoordinator,
} from "../api/compiled-intent-admission";
import { OrdinaryActionAdmissionCoordinator } from "../api/ordinary-action-admission";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import { handleRequest } from "../api/server";

const child = join(import.meta.dir, "compiled-intent-admission-child.ts");
const MARKER = "@@compiled-intent-admission@@";

type ChildEvent = Record<string, unknown> & { event: string };

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 15_000);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function spawnRace(root: string, label: string) {
  const processHandle = Bun.spawn([process.execPath, child, root, label], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const events: ChildEvent[] = [];
  let wake: (() => void) | undefined;
  let stdout = ""; let stderr = ""; let pending = ""; let closed = false;
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of processHandle.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      stdout += text; pending += text;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line.startsWith(MARKER)) continue;
        events.push(JSON.parse(line.slice(MARKER.length)) as ChildEvent);
        wake?.(); wake = undefined;
      }
    }
  })();
  const stderrDrain = (async () => { stderr = await new Response(processHandle.stderr).text(); })();
  const next = async (): Promise<ChildEvent> => {
    while (!events.length) {
      const state = await Promise.race([
        new Promise<"event">((resolve) => { wake = () => resolve("event"); }),
        processHandle.exited.then(() => "exit" as const),
      ]);
      if (state === "exit" && !events.length) {
        await Promise.all([stdoutDrain, stderrDrain]);
        throw new Error(`compiled intent admission child exited before an event: ${stdout}\n${stderr}`);
      }
    }
    return events.shift()!;
  };
  const signal = async (value: "go" | "release", end = false) => {
    if (closed) return;
    const stdin = processHandle.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("compiled intent admission child stdin is unavailable");
    stdin.write(`${value}\n`);
    await stdin.flush();
    if (end) { closed = true; stdin.end(); }
  };
  return {
    next: () => within(next(), `compiled intent admission ${label} event`),
    start: () => signal("go"),
    release: () => signal("release", true),
    async finish() {
      const code = await within(processHandle.exited, `compiled intent admission ${label} exit`);
      await within(Promise.all([stdoutDrain, stderrDrain]), `compiled intent admission ${label} drain`);
      if (code !== 0) throw new Error(`compiled intent admission child failed (${code}): ${stdout}\n${stderr}`);
    },
    async dispose() {
      try { await signal("release", true); } catch { /* child may already be gone */ }
      try { await within(processHandle.exited, `compiled intent admission ${label} cleanup`); }
      catch { try { processHandle.kill(); } catch { /* already stopped */ } }
      try { await Promise.all([stdoutDrain, stderrDrain]); } catch { /* primary failure is authoritative */ }
    },
  };
}

function binding(input = "never persist raw player text") {
  return { sessionId: "compiled-intent-test-session", expectedGeneration: 4, input };
}

function legacyInputDerivedRequestHash(input: string): string {
  const hash = createHash("sha256");
  for (const part of ["compiled-intent-request-summary-v1", input]) {
    hash.update(String(part.length)); hash.update(":"); hash.update(part); hash.update("|");
  }
  return hash.digest("hex");
}

function extendedBootstrapContentionConnectionFactory(code: string, runs?: string[]) {
  return (file: string, flags: number) => {
    const database = new Database(file, flags);
    return {
      run(sql: string, bindings: readonly (string | number)[] = []) {
        runs?.push(sql);
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS ordinary_action_admission_policy")) {
          throw Object.assign(new Error("SQLite bootstrap failed"), { code });
        }
        if (bindings.length) database.run(sql, [...bindings]); else database.run(sql);
      },
      get<T>(sql: string, bindings: readonly (string | number)[] = []): T | undefined {
        return bindings.length ? database.query(sql).get(...bindings) as T | undefined : database.query(sql).get() as T | undefined;
      },
      pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") {
        const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
        return row ? Object.values(row)[0] : undefined;
      },
      close(throwOnError: true) { database.close(throwOnError); },
    };
  };
}

function persistentCommitBusyConnectionFactory(attempts: { count: number }) {
  return (file: string, flags: number) => {
    const database = new Database(file, flags);
    return {
      run(sql: string, bindings: readonly (string | number)[] = []) {
        if (sql === "COMMIT") {
          attempts.count++;
          throw Object.assign(new Error("SQLite commit contention"), { code: "SQLITE_BUSY_SNAPSHOT" });
        }
        if (bindings.length) database.run(sql, [...bindings]); else database.run(sql);
      },
      get<T>(sql: string, bindings: readonly (string | number)[] = []): T | undefined {
        return bindings.length ? database.query(sql).get(...bindings) as T | undefined : database.query(sql).get() as T | undefined;
      },
      pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") {
        const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get();
        return row ? Object.values(row)[0] : undefined;
      },
      close(throwOnError: true) { database.close(throwOnError); },
    };
  };
}

describe("compiled intent durable admission", () => {
  it("allows exactly one first-time provider seam across two fresh Bun processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-admission-process-"));
    const alpha = spawnRace(root, "alpha");
    const bravo = spawnRace(root, "bravo");
    try {
      expect((await alpha.next()).event).toBe("ready");
      expect((await bravo.next()).event).toBe("ready");
      await Promise.all([alpha.start(), bravo.start()]);
      const first = await Promise.race([alpha.next(), bravo.next()]);
      const second = await (first.label === "alpha" ? bravo.next() : alpha.next());
      const events = [first, second];
      expect(events.filter((event) => event.event === "provider-entered")).toHaveLength(1);
      expect(events.filter((event) => event.event === "result" && event.status === 429 && event.providerCalls === 0)).toHaveLength(1);
      const winner = events.find((event) => event.event === "provider-entered")!;
      await Promise.all([alpha.release(), bravo.release()]);
      const settled = await (winner.label === "alpha" ? alpha.next() : bravo.next());
      expect(settled).toMatchObject({ event: "result", status: 200, providerCalls: 1 });
      await Promise.all([alpha.finish(), bravo.finish()]);
    } finally {
      await Promise.all([alpha.dispose(), bravo.dispose()]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps extended SQLite bootstrap contention as fail-closed storage uncertainty", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-extended-contention-"));
    try {
      for (const code of ["SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED_SHAREDCACHE"]) {
        const runs: string[] = [];
        const coordinator = new CompiledIntentAdmissionCoordinator(root, {}, {
          connectionFactory: extendedBootstrapContentionConnectionFactory(code, runs),
        });
        expect(coordinator.acquire(binding(`input for ${code}`))).toMatchObject({
          status: "refused", code: "ORDINARY_ACTION_STORAGE_UNAVAILABLE",
        });
        expect(runs).toContain("PRAGMA busy_timeout = 1000");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps a persistently busy COMMIT fail-closed after the bounded shared retry", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-persistent-commit-busy-"));
    const attempts = { count: 0 };
    try {
      const coordinator = new CompiledIntentAdmissionCoordinator(root, {}, {
        connectionFactory: persistentCommitBusyConnectionFactory(attempts),
      });
      expect(coordinator.acquire(binding("compiled persistent commit busy"))).toMatchObject({
        status: "refused", code: "ORDINARY_ACTION_STORAGE_UNAVAILABLE",
      });
      expect(attempts.count).toBe(2);
      const afterRollback = new CompiledIntentAdmissionCoordinator(root).acquire(binding("compiled after persistent commit busy"));
      expect(afterRollback.status).toBe("acquired");
      if (afterRollback.status === "acquired") afterRollback.release();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("releases a settled classification, while a release exception leaves an auditable fail-closed lease", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-admission-release-"));
    try {
      const coordinator = new CompiledIntentAdmissionCoordinator(root);
      const first = coordinator.acquire(binding("safe summary only"));
      expect(first.status).toBe("acquired");
      if (first.status !== "acquired") throw new Error("expected admission");
      first.release();
      const retry = new CompiledIntentAdmissionCoordinator(root).acquire(binding("later safe summary"));
      expect(retry.status).toBe("acquired");
      if (retry.status === "acquired") retry.release();

      let failDelete = true;
      const failing = new CompiledIntentAdmissionCoordinator(root, {}, {
        connectionFactory(file, flags) {
          const database = new Database(file, flags);
          return {
            run(sql: string, values: readonly (string | number)[] = []) {
              if (failDelete && sql.startsWith("DELETE FROM ordinary_action_admission_leases")) throw new Error("injected release failure");
              if (values.length) database.run(sql, [...values]); else database.run(sql);
            },
            get<T>(sql: string, values: readonly (string | number)[] = []) { return values.length ? database.query(sql).get(...values) as T | undefined : database.query(sql).get() as T | undefined; },
            pragma(name: "journal_mode" | "synchronous" | "locking_mode" | "busy_timeout") { const row = database.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get(); return row ? Object.values(row)[0] : undefined; },
            close(throwOnError: true) { database.close(throwOnError); },
          };
        },
      });
      const uncertain = failing.acquire(binding("this raw input must not be stored"));
      expect(uncertain.status).toBe("acquired");
      if (uncertain.status !== "acquired") throw new Error("expected admission");
      uncertain.release();
      failDelete = false;
      expect(new CompiledIntentAdmissionCoordinator(root).acquire(binding("contender"))).toMatchObject({ status: "refused", code: "ORDINARY_ACTION_BUSY" });
      const auditDatabase = new Database(coordinator.file);
      const rows = auditDatabase.query<{ action_id: string; request_hash: string }, []>("SELECT action_id, request_hash FROM ordinary_action_admission_leases").all();
      auditDatabase.close();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain("this raw input must not be stored");
      expect(rows[0]!.action_id).toBe("compiled-intent-classification-v1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("persists a fresh random correlation nonce, never a low-entropy input-derived hash", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-admission-privacy-"));
    const input = "open door";
    const hashes: string[] = [];
    try {
      const coordinator = new CompiledIntentAdmissionCoordinator(root);
      const readHash = () => {
        const database = new Database(coordinator.file);
        const row = database.query<{ request_hash: string }, []>("SELECT request_hash FROM ordinary_action_admission_leases").get();
        database.close();
        if (!row) throw new Error("expected durable admission row");
        return row.request_hash;
      };
      const first = coordinator.acquire(binding(input));
      expect(first.status).toBe("acquired");
      if (first.status !== "acquired") throw new Error("expected admission");
      hashes.push(readHash()); first.release();
      const settledRetry = coordinator.acquire(binding(input));
      expect(settledRetry.status).toBe("acquired");
      if (settledRetry.status !== "acquired") throw new Error("expected admission");
      hashes.push(readHash()); settledRetry.release();
      const nextGeneration = coordinator.acquire({ ...binding(input), expectedGeneration: 5 });
      expect(nextGeneration.status).toBe("acquired");
      if (nextGeneration.status !== "acquired") throw new Error("expected admission");
      hashes.push(readHash()); nextGeneration.release();
      expect(hashes).toHaveLength(3);
      expect(new Set(hashes).size).toBe(3);
      expect(hashes).not.toContain(legacyInputDerivedRequestHash(input));
      expect(hashes.every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps random correlation values compatible with exact-owner release and quarantine", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-admission-owner-"));
    try {
      const coordinator = new CompiledIntentAdmissionCoordinator(root);
      const releasedOwner = coordinator.acquire(binding("open door"));
      expect(releasedOwner.status).toBe("acquired");
      if (releasedOwner.status !== "acquired") throw new Error("expected admission");
      releasedOwner.release();

      const currentOwner = coordinator.acquire(binding("open door"));
      expect(currentOwner.status).toBe("acquired");
      if (currentOwner.status !== "acquired") throw new Error("expected replacement admission");
      // The prior fence and its random request nonce cannot alter this owner.
      releasedOwner.quarantine();
      expect(coordinator.acquire(binding("open door"))).toMatchObject({ status: "refused", code: "ORDINARY_ACTION_BUSY" });

      currentOwner.quarantine();
      expect(coordinator.acquire(binding("open door"))).toMatchObject({ status: "refused", code: "ORDINARY_ACTION_QUARANTINED" });
      expect(coordinator.recoverQuarantinedForOperator({ sessionId: "compiled-intent-test-session", currentGeneration: 4 }))
        .toMatchObject({ status: "recovered" });
      const recovered = coordinator.acquire(binding("open door"));
      expect(recovered.status).toBe("acquired");
      if (recovered.status === "acquired") recovered.release();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed on an independent coordinator-domain policy mismatch", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-admission-policy-"));
    try {
      const compiled = new CompiledIntentAdmissionCoordinator(root);
      const acquired = compiled.acquire(binding());
      expect(acquired.status).toBe("acquired");
      if (acquired.status === "acquired") acquired.release();
      const ordinary = new OrdinaryActionAdmissionCoordinator(root, {}, { fileName: ".compiled-intent-admission.sqlite" });
      expect(ordinary.acquire({ sessionId: "a".repeat(64), expectedGeneration: 4, actionId: "ordinary-action", requestHash: "b".repeat(64) }))
        .toMatchObject({ status: "refused", code: "ORDINARY_ACTION_POLICY_MISMATCH" });
      expect(COMPILED_INTENT_ADMISSION_DOMAIN).not.toBe("ordinary-action-execution-admission");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("maps SQLite lock uncertainty to fail-closed admission unavailability, not a contender 429", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-admission-busy-"));
    try {
      const coordinator = new CompiledIntentAdmissionCoordinator(root, {}, {
        connectionFactory() {
          const error = Object.assign(new Error("SQLITE_BUSY injected"), { code: "SQLITE_BUSY" });
          throw error;
        },
      });
      expect(coordinator.acquire(binding())).toMatchObject({ status: "refused", code: "ORDINARY_ACTION_STORAGE_UNAVAILABLE", retryAfterSeconds: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not expose an injected admission domain mismatch from an unauthenticated unrelated route", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-admission-root-"));
    try {
      const response = await handleRequest(new Request("http://test/api/sessions"), undefined, undefined,
        { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") }, {}, {}, () => ({ status: "unauthenticated" as const }), undefined, undefined, undefined, undefined, {
          registry: new Map(),
          sessionNamespace: new SessionNamespaceCoordinator(join(root, "sessions")),
          compiledIntentAdmission: new CompiledIntentAdmissionCoordinator(join(root, "other-lock-domain")),
        });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { stage: "auth", code: "AUTHENTICATION_REQUIRED", message: "compiler authentication is required" } });
      expect(existsSync(join(root, "other-lock-domain", ".compiled-intent-admission.sqlite"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("authenticates host compiled intents and rejects their domain mismatch before namespace, store, or body work", async () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-intent-admission-early-auth-"));
    const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
    const makeObservedRuntime = (compiledIntentAdmission: CompiledIntentAdmissionCoordinator) => {
      const touches = { namespace: 0, locator: 0, ordinarySnapshot: 0, compiledSnapshot: 0 };
      const namespace = new SessionNamespaceCoordinator(storage.sessionRoot);
      const ordinarySnapshots = new OrdinarySessionSnapshotStore({ root: join(storage.sessionRoot, "ordinary-snapshots") });
      const compiledSnapshots = new CompiledSessionSnapshotStore({ root: join(storage.sessionRoot, "compiled-snapshots") });
      const observedNamespace = new Proxy(namespace, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            touches.namespace++;
            if (property === "read") touches.locator++;
            return Reflect.apply(value, target, args);
          };
        },
      }) as unknown as SessionNamespaceCoordinator;
      const observedOrdinarySnapshots = new Proxy(ordinarySnapshots, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => { touches.ordinarySnapshot++; return Reflect.apply(value, target, args); };
        },
      }) as unknown as OrdinarySessionSnapshotStore;
      const observedCompiledSnapshots = new Proxy(compiledSnapshots, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => { touches.compiledSnapshot++; return Reflect.apply(value, target, args); };
        },
      }) as unknown as CompiledSessionSnapshotStore;
      return {
        touches,
        compiledSnapshots: observedCompiledSnapshots,
        runtime: {
          registry: new Map(),
          sessionNamespace: observedNamespace,
          ordinarySnapshots: observedOrdinarySnapshots,
          ordinaryActionAdmission: undefined as OrdinaryActionAdmissionCoordinator | undefined,
          compiledIntentAdmission,
        },
      };
    };
    const unreadBody = () => {
      let pulls = 0;
      return {
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode('{"input":"never read","pcId":"p1","expectedGeneration":0}'));
            controller.close();
          },
        }, { highWaterMark: 0 }),
        pulls: () => pulls,
      };
    };
    const path = "http://test/api/sessions/018f14a2-c2be-7b73-b291-6e64eaf7869a/compiled/intents";
    try {
      const canonical = makeObservedRuntime(new CompiledIntentAdmissionCoordinator(storage.sessionRoot));
      const anonymousBody = unreadBody();
      const anonymous = await handleRequest(new Request(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: anonymousBody.body,
      }), undefined, canonical.compiledSnapshots, storage, {}, {}, () => ({ status: "unauthenticated" as const }), undefined, undefined, undefined, undefined, canonical.runtime);
      expect(anonymous.status).toBe(401);
      expect(anonymousBody.pulls()).toBe(0);
      expect(canonical.touches).toEqual({ namespace: 0, locator: 0, ordinarySnapshot: 0, compiledSnapshot: 0 });

      const mismatch = makeObservedRuntime(new CompiledIntentAdmissionCoordinator(join(root, "foreign-lock-domain")));
      const authenticatedBody = unreadBody();
      const response = await handleRequest(new Request(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: authenticatedBody.body,
      }), undefined, mismatch.compiledSnapshots, storage, {}, {}, () => ({
        status: "authenticated" as const,
        principal: { role: "keeper" as const, id: "keeper:compiled-intent-domain" },
      }), undefined, undefined, undefined, undefined, mismatch.runtime);
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(await response.json()).toEqual({
        error: {
          stage: "persistence",
          code: "COMPILED_INTENT_ADMISSION_ROOT_MISMATCH",
          message: "compiled intent admission is unavailable",
        },
      });
      expect(authenticatedBody.pulls()).toBe(0);
      expect(mismatch.touches).toEqual({ namespace: 0, locator: 0, ordinarySnapshot: 0, compiledSnapshot: 0 });

      // The specialized compiled host route deliberately ignores an ordinary
      // admission mismatch; its own coordinator is the relevant domain.
      const ordinaryOnlyMismatch = makeObservedRuntime(new CompiledIntentAdmissionCoordinator(storage.sessionRoot));
      ordinaryOnlyMismatch.runtime.ordinaryActionAdmission = new OrdinaryActionAdmissionCoordinator(join(root, "ordinary-foreign-lock-domain"));
      const independent = await handleRequest(new Request(path, { method: "POST" }), undefined, ordinaryOnlyMismatch.compiledSnapshots, storage, {}, {}, () => ({
        status: "authenticated" as const,
        principal: { role: "keeper" as const, id: "keeper:compiled-intent-domain" },
      }), undefined, undefined, undefined, undefined, ordinaryOnlyMismatch.runtime);
      expect(independent.status).toBe(404);
      expect(JSON.stringify(await independent.json())).not.toContain("ORDINARY_ACTION_ADMISSION_DOMAIN_MISMATCH");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
